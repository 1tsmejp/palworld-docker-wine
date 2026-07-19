const fs = require('fs');
const path = require('path');
const { dockerctl } = require('./dockerctl');
const { readEnv, updateEnv } = require('./compose');
const { DATA_DIR } = require('./config');
const { getSecrets, setSecrets } = require('./secrets');
const { appendHistory, readHistory } = require('./config');

/** Record a mod change so the UI can show it as pending until the next restart. */
function logModChange(server, action, id, title, kind) {
  appendHistory('modchanges', { serverId: server.id, action, id: String(id), title: title || String(id), kind });
}

/** Mod changes made after the container's current start (i.e. not yet active). */
function pendingModChanges(server, containerStartedAt) {
  if (!containerStartedAt) return [];
  const started = new Date(containerStartedAt).getTime();
  return readHistory('modchanges', 100)
    .filter((e) => e.serverId === server.id && new Date(e.ts).getTime() > started)
    .reverse();
}

/**
 * Steam Workshop browsing (no API key needed) + mod install for Linux
 * Palworld servers.
 *
 * NOTE on capability (docs.palworldgame.com/settings-and-operation/mod):
 * Palworld's official server-side mod system (Info.json / PalModSettings.ini,
 * UE4SS / Lua / PalSchema mod types) is Windows-only. On the Linux docker
 * server, only pak-format mods work, side-loaded into
 *   /palworld/Pal/Content/Paks/~mods/
 * Installs therefore extract .pak files (plus .utoc/.ucas companions) there.
 */

const APPID = 1623730;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) palworld-manager';
const MODS_DIR = '/palworld/Pal/Content/Paks/~mods';
// Official mod system (Windows server builds, incl. Wine-hosted)
const OFFICIAL_MODS_DIR = '/palworld/Pal/Binaries/Win64/Mods';

/**
 * 'windows' (server runs the Windows build, e.g. under Wine): ALL mod types
 * work — UE4SS/PalSchema/Lua via the official Mods/Workshop system.
 * 'linux' (native Linux build): pak sideload only.
 */
function modPlatform(server) {
  return server.flavor === 'wine' || server.modPlatform === 'windows' ? 'windows' : 'linux';
}

/**
 * Keep the WORKSHOP_MODS env (comma-separated workshop IDs) in the compose
 * file in sync with installs/removals — the Wine image installs any missing
 * listed mods at boot, so the mod set is declarative and survives volume
 * resets (ripps818-style env-driven mod patching).
 */
function syncWorkshopModsEnv(server, id, add) {
  if (modPlatform(server) !== 'windows') return;
  try {
    const env = readEnv(server.composeFile, server.serviceName);
    const list = String(env.WORKSHOP_MODS || '').split(',').map((x) => x.trim()).filter(Boolean);
    const sid = String(id);
    if (add && !list.includes(sid)) list.push(sid);
    if (!add && list.includes(sid)) list.splice(list.indexOf(sid), 1);
    updateEnv(server.composeFile, server.serviceName, { WORKSHOP_MODS: list.length ? list.join(',') : null });
  } catch { /* best effort */ }
}

const SORTS = { trend: 'trend', mostrecent: 'mostrecent', lastupdated: 'lastupdated', subscribers: 'totaluniquesubscribers' };

// ---------------------------------------------------------------- browse
/**
 * Mod compatibility for LINUX dedicated servers:
 *  - 'pak'     — pak-format content, works on the Linux server (~mods sideload)
 *  - 'windows' — UE4SS / PalSchema / Lua / LogicMods types, Windows servers only
 *  - 'unknown' — no type tag; may or may not contain pak content (install verifies)
 */
function classifyCompat(tags, title = '') {
  const t = tags.join(' ').toLowerCase();
  const ti = title.toLowerCase();
  if (/ue4ss|palschema|lua|logicmod/.test(t) || /\(schema\)|\(ue4ss\)|palschema/.test(ti)) return 'windows';
  // 'Model Replacement' mods are pak-format content swaps
  if (/\bpaks?\b|model replacement/.test(t)) return 'pak';
  return 'unknown';
}

async function searchWorkshop({ q = '', sort = 'trend', page = 1, compat = 'all' }) {
  const url = new URL('https://steamcommunity.com/workshop/browse/');
  url.searchParams.set('appid', APPID);
  url.searchParams.set('browsesort', SORTS[sort] || 'trend');
  url.searchParams.set('section', 'readytouseitems');
  url.searchParams.set('actualsort', SORTS[sort] || 'trend');
  url.searchParams.set('p', String(page));
  if (q) url.searchParams.set('searchtext', q);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`workshop browse HTTP ${res.status}`);
  const html = await res.text();
  // Steam's markup uses hashed class names; the stable signal is the ordered
  // list of filedetails links. Metadata comes from the details API below.
  const ids = [];
  for (const m of html.matchAll(/sharedfiles\/filedetails\/\?id=(\d+)/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  let items = ids.length ? await getDetails(ids) : [];
  for (const it of items) it.compat = classifyCompat(it.tags, it.title);
  const counts = { pak: 0, windows: 0, unknown: 0 };
  for (const it of items) counts[it.compat]++;
  if (compat !== 'all') items = items.filter((it) => it.compat === compat);
  return { page: Number(page), sort, query: q, compat, counts, items };
}

async function getDetails(ids) {
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
  const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`details API HTTP ${res.status}`);
  const data = await res.json();
  const details = data.response?.publishedfiledetails || [];
  return details.filter((d) => d.result === 1).map((d) => ({
    id: d.publishedfileid,
    title: d.title,
    description: (d.description || '').slice(0, 600),
    preview: d.preview_url,
    fileSize: Number(d.file_size) || 0,
    timeUpdated: d.time_updated ? new Date(d.time_updated * 1000).toISOString() : null,
    subscriptions: d.subscriptions ?? d.lifetime_subscriptions ?? null,
    favorited: d.favorited ?? null,
    views: d.views ?? null,
    tags: (d.tags || []).map((t) => t.tag),
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${d.publishedfileid}`,
  }));
}

// ---------------------------------------------------------------- installed
function modsRegistryFile() { return path.join(DATA_DIR, 'installed-mods.json'); }
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(modsRegistryFile(), 'utf8')); } catch { return {}; }
}
function writeRegistry(reg) { fs.writeFileSync(modsRegistryFile(), JSON.stringify(reg, null, 2)); }

async function listInstalled(server) {
  const reg = readRegistry();
  let files = [];
  try {
    const out = await dockerctl.exec(server.containerName, ['sh', '-c', `find ${MODS_DIR} -type f 2>/dev/null | sort`]);
    files = out.trim() ? out.trim().split('\n') : [];
  } catch { /* dir absent */ }
  const byDir = {};
  for (const f of files) {
    const rel = f.replace(MODS_DIR + '/', '');
    const dir = rel.includes('/') ? rel.split('/')[0] : '(root)';
    (byDir[dir] ??= []).push(rel);
  }
  const result = Object.entries(byDir).map(([dir, fileList]) => ({
    dir, kind: 'pak',
    files: fileList,
    meta: reg[`${server.id}:${dir}`] || null,
  }));

  // Official mod system installs (Windows-build servers)
  if (modPlatform(server) === 'windows') {
    try {
      const out = await dockerctl.exec(server.containerName,
        ['sh', '-c', `ls -d ${OFFICIAL_MODS_DIR}/Workshop/*/ 2>/dev/null | xargs -rn1 basename`]);
      for (const dir of out.trim() ? out.trim().split('\n') : []) {
        result.push({
          dir, kind: 'official',
          files: ['(official mod system)'],
          meta: reg[`${server.id}:official:${dir}`] || null,
        });
      }
    } catch { /* dir absent */ }
  }
  return result;
}

// ---------------------------------------------------------------- steam auth
/**
 * Credentials come from the manager's secret store (Mods → Accounts UI),
 * falling back to STEAM_USERNAME/STEAM_PASSWORD in the compose env.
 */
function steamCreds(server) {
  const s = getSecrets(server.id);
  if (s.steamUsername && s.steamPassword) return { user: s.steamUsername, pass: s.steamPassword };
  // QR sign-in: no password stored; DepotDownloader reuses its cached auth
  // token via `-username <user> -remember-password`.
  if (s.steamUsername && s.steamTokenOnly) return { user: s.steamUsername, pass: null };
  const env = readEnv(server.composeFile, server.serviceName);
  if (env.STEAM_USERNAME && env.STEAM_PASSWORD) return { user: env.STEAM_USERNAME, pass: env.STEAM_PASSWORD };
  return null;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// DepotDownloader stores its auth tokens via .NET IsolatedStorage
// ($HOME/.local/share/IsolatedStorage/**/account.config) — wiped when the
// game container is recreated. Persist the whole tree under /palworld.
const ACCT_SAVE = '/palworld/.depotdownloader';
const restoreAcct = `mkdir -p "$HOME/.local/share" && if [ -d ${ACCT_SAVE}/IsolatedStorage ]; then rm -rf "$HOME/.local/share/IsolatedStorage" && cp -r ${ACCT_SAVE}/IsolatedStorage "$HOME/.local/share/"; fi; true`;
const persistAcct = `if [ -d "$HOME/.local/share/IsolatedStorage" ]; then mkdir -p ${ACCT_SAVE} && rm -rf ${ACCT_SAVE}/IsolatedStorage && cp -r "$HOME/.local/share/IsolatedStorage" ${ACCT_SAVE}/; fi; true`;

/**
 * Read the signed-in Steam account name from DepotDownloader's stored tokens.
 * account.config is DEFLATE-compressed protobuf (not JSON): decompress and
 * extract the account-name string (maps are keyed by it; the values are long
 * JWT refresh tokens, easily distinguished).
 */
async function readStoredSteamUsername(server) {
  try {
    const b64 = await dockerctl.exec(server.containerName,
      ['sh', '-c', `base64 $(find ${ACCT_SAVE}/IsolatedStorage "$HOME/.local/share/IsolatedStorage" -name account.config 2>/dev/null | head -1) 2>/dev/null`]);
    if (!b64.trim()) return null;
    const zlib = require('zlib');
    const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    let data = buf;
    for (const fn of [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync]) {
      try { data = fn(buf); break; } catch { /* try next */ }
    }
    const strings = String(data.toString('latin1')).match(/[\x20-\x7e]{3,}/g) || [];
    const candidates = strings.filter((s) =>
      /^[A-Za-z0-9_.-]{3,32}$/.test(s) &&      // steam login-name shape
      !/^ey[A-Za-z0-9_-]+$/.test(s) &&          // not a JWT fragment
      !/^\d+$/.test(s));                        // not a bare number
    return candidates[0] || null;
  } catch { /* absent */ }
  return null;
}

/**
 * Run DepotDownloader with credentials; guardCode (Steam Guard email/2FA code)
 * is piped to stdin for the interactive prompt. Returns combined output.
 */
async function runDepotDownloader(server, args, { user, pass, guardCode }, timeoutMs = 600000) {
  const c = server.containerName;
  const passArg = pass ? ` -password ${q(pass)}` : '';
  const cmd = `${restoreAcct}; DepotDownloader ${args} -username ${q(user)}${passArg} -remember-password 2>&1; rc=$?; ${persistAcct}; exit $rc`;
  const { code, stdout } = await dockerctl.execInput(c, ['sh', '-c', cmd], guardCode ? guardCode + '\n' : '\n', timeoutMs);
  return { code, output: stdout };
}

// ---------------------------------------------------------------- QR login
/**
 * "Sign in with the Steam app": DepotDownloader -qr prints a QR code that the
 * user scans with the Steam mobile app — no password ever entered here. The
 * session streams DepotDownloader's output, exposes the QR to the UI, and on
 * success stores the username with tokenOnly (auth token cached in the game
 * data volume for reuse).
 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const qrSessions = new Map(); // serverId -> session

function startQrLogin(server) {
  const old = qrSessions.get(server.id);
  if (old && old.child && old.status === 'waiting') { try { old.child.kill('SIGKILL'); } catch { /* gone */ } }

  const probeId = '3763387660';
  // -remember-password is what makes DepotDownloader store the refresh token
  // (in IsolatedStorage account.config, keyed by account name) — without it a
  // QR login authenticates but persists nothing.
  const cmd = `${restoreAcct}; DepotDownloader -app ${APPID} -pubfile ${probeId} -manifest-only -qr -remember-password -dir /tmp/pw-qr-login 2>&1; rc=$?; ${persistAcct}; rm -rf /tmp/pw-qr-login; exit $rc`;
  const child = spawn('docker', ['exec', '-i', server.containerName, 'sh', '-c', cmd]);
  const sess = {
    id: crypto.randomUUID(), serverId: server.id, status: 'starting',
    qr: null, output: '', username: null, error: null, child,
    startedAt: Date.now(),
  };
  qrSessions.set(server.id, sess);

  const timer = setTimeout(() => {
    if (sess.status === 'starting' || sess.status === 'waiting') {
      sess.status = 'expired';
      sess.error = 'QR code expired (no scan within 4 minutes). Start again.';
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }, 4 * 60 * 1000);

  child.stdout.on('data', (d) => {
    sess.output += d.toString();
    // QR block = consecutive lines made of block characters/whitespace
    const lines = sess.output.split('\n');
    const qrLines = [];
    for (const line of lines) {
      const t = line.replace(/\r/g, '');
      if (t.length > 15 && /^[\s█▄▀▌▐░▒▓]+$/.test(t)) qrLines.push(t);
      else if (qrLines.length > 5) break;
      else if (qrLines.length) qrLines.length = 0;
    }
    if (qrLines.length > 5 && !sess.qr) {
      sess.qr = qrLines.join('\n');
      sess.status = 'waiting';
    }
    const m = sess.output.match(/Logging '([^']+)' into Steam3/) || sess.output.match(/Logged in as '([^']+)'/);
    if (m) sess.username = m[1];
  });
  child.stderr.on('data', (d) => { sess.output += d.toString(); });

  child.on('close', async (code) => {
    clearTimeout(timer);
    if (sess.status === 'expired') return;
    if (code === 0 || /Done!/.test(sess.output)) {
      // Username fallback: read it from DepotDownloader's stored tokens
      if (!sess.username) sess.username = await readStoredSteamUsername(server);
      if (!sess.username) {
        sess.status = 'failed';
        sess.error = 'Signed in, but could not determine the Steam account name (no stored token found) — please try again.';
        return;
      }
      if (/not available from this account/i.test(sess.output)) {
        sess.status = 'failed';
        sess.error = `Signed in as ${sess.username}, but this account does not own Palworld — Workshop downloads require ownership.`;
      } else {
        setSecrets(server.id, { steamUsername: sess.username, steamPassword: null, steamTokenOnly: true, steamVerified: true });
        sess.status = 'success';
      }
    } else {
      sess.status = 'failed';
      sess.error = 'Sign-in did not complete: ' + sess.output.split('\n').filter(Boolean).slice(-2).join(' | ');
    }
  });
  child.on('error', (e) => { sess.status = 'failed'; sess.error = e.message; });

  return { id: sess.id };
}

function qrLoginStatus(server, sessionId) {
  const sess = qrSessions.get(server.id);
  if (!sess || sess.id !== sessionId) return { status: 'unknown' };
  return { status: sess.status, qr: sess.qr, username: sess.username, error: sess.error };
}

/** Verify a Steam login (and Palworld ownership) with a manifest-only probe. */
async function testSteamLogin(server, { username, password, guardCode }) {
  const probeId = '3763387660'; // any public workshop item; -manifest-only fetches metadata only
  let code, output;
  try {
    ({ code, output } = await runDepotDownloader(server,
      `-app ${APPID} -pubfile ${probeId} -manifest-only -dir /tmp/pw-login-test`,
      { user: username, pass: password, guardCode }, 180000));
  } catch (e) {
    if (/timed out/i.test(e.message)) {
      return { ok: false, reason: 'Timed out waiting for Steam. If a confirmation prompt appeared in your Steam mobile app, approve it and press Sign in again — or use the QR sign-in button instead.' };
    }
    throw e;
  }
  await dockerctl.exec(server.containerName, ['sh', '-c', 'rm -rf /tmp/pw-login-test']).catch(() => {});
  const out = output || '';
  if (/STEAM GUARD/i.test(out) && /is incorrect|invalid/i.test(out)) {
    return { ok: false, reason: 'Steam Guard code incorrect or expired — request a fresh code and try again.' };
  }
  if (/STEAM GUARD/i.test(out) && code !== 0 && !guardCode) {
    return { ok: false, needsGuardCode: true, reason: 'Steam Guard is asking for a code (check your email or mobile authenticator), enter it and save again.' };
  }
  if (/InvalidPassword|password.*incorrect/i.test(out)) return { ok: false, reason: 'Invalid username or password.' };
  if (/not available from this account/i.test(out)) return { ok: false, reason: 'Login worked, but this account does not own Palworld — Workshop downloads require ownership.' };
  if (code === 0 || /Done!/.test(out)) return { ok: true };
  return { ok: false, reason: 'Login failed: ' + out.split('\n').filter(Boolean).slice(-3).join(' | ') };
}

// ---------------------------------------------------------------- install
/** Install from Steam Workshop using DepotDownloader inside the game container. */
async function installFromWorkshop(server, publishedFileId) {
  if (!/^\d+$/.test(String(publishedFileId))) throw Object.assign(new Error('invalid workshop id'), { status: 400 });
  const creds = steamCreds(server);
  if (!creds) {
    throw Object.assign(new Error('No Steam account configured. Sign in under Mods → Accounts (the account must own Palworld) — Steam does not allow anonymous Workshop downloads. Alternatively download the mod manually and use the upload installer.'), { status: 400 });
  }
  const [detail] = await getDetails([String(publishedFileId)]).catch(() => [null]);
  const tmp = `/tmp/pw-mod-${publishedFileId}`;
  const c = server.containerName;
  await dockerctl.exec(c, ['sh', '-c', `rm -rf '${tmp}'`]);
  const { code, output } = await runDepotDownloader(server, `-app ${APPID} -pubfile ${publishedFileId} -dir '${tmp}'`, creds);
  if (code !== 0) {
    await dockerctl.exec(c, ['sh', '-c', `rm -rf '${tmp}'`]).catch(() => {});
    if (/Aborted|ThreadPool|password:/i.test(output || '')) {
      throw Object.assign(new Error('Steam sign-in token is missing or expired for this server — open Mods → Accounts and sign in again (QR is easiest), then retry the install.'), { status: 400 });
    }
    const tail = (output || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    const hint = /STEAM GUARD/i.test(output) ? ' Steam Guard triggered — re-verify the login under Mods → Accounts with a fresh code.' : '';
    throw Object.assign(new Error(`Workshop download failed: ${tail}.${hint}`), { status: 502 });
  }
  // Official-format Workshop mods carry an Info.json; on a Windows-build
  // server (incl. Wine) they install via the official Mods/Workshop system,
  // which handles UE4SS / PalSchema / Lua / LogicMods deployment itself.
  const infoOut = await dockerctl.exec(c, ['sh', '-c', `find '${tmp}' -maxdepth 4 -name Info.json | head -1`]);
  const infoJson = infoOut.trim();
  if (modPlatform(server) === 'windows' && infoJson) {
    const modRoot = infoJson.replace(/\/Info\.json$/, '');
    let packageName = null, dependencies = [];
    try {
      const info = JSON.parse(await dockerctl.exec(c, ['cat', infoJson]));
      packageName = info.PackageName || null;
      dependencies = Array.isArray(info.Dependencies) ? info.Dependencies : [];
    } catch { /* ignore */ }
    // Loader runtimes (UE4SS/PalSchema) are Workshop items themselves — on a
    // dedicated server they must be installed explicitly. Flag missing ones.
    const reg0 = readRegistry();
    const installedPkgs = new Set(Object.entries(reg0)
      .filter(([k]) => k.startsWith(`${server.id}:official:`))
      .map(([, v]) => v.packageName).filter(Boolean));
    const missingDependencies = dependencies.filter((dep) => !installedPkgs.has(dep));
    const destDir = `${OFFICIAL_MODS_DIR}/Workshop/${publishedFileId}`;
    await dockerctl.exec(c, ['sh', '-c', `rm -rf ${q(destDir)} && mkdir -p ${q(destDir)} && cp -r ${q(modRoot)}/. ${q(destDir)}/ && rm -rf '${tmp}'`]);
    const ini = `${OFFICIAL_MODS_DIR}/PalModSettings.ini`;
    await dockerctl.exec(c, ['sh', '-c', `
      touch ${q(ini)}
      grep -q "bGlobalEnableMod=" ${q(ini)} || echo "bGlobalEnableMod=True" >> ${q(ini)}
      ${packageName ? `grep -q "ActiveModList=${packageName}" ${q(ini)} || echo "ActiveModList=${packageName}" >> ${q(ini)}` : 'true'}`]);
    const reg = readRegistry();
    reg[`${server.id}:official:${publishedFileId}`] = {
      source: 'workshop', kind: 'official', id: String(publishedFileId), packageName,
      title: detail?.title || `Workshop item ${publishedFileId}`,
      url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${publishedFileId}`,
      installedAt: new Date().toISOString(),
    };
    writeRegistry(reg);
    syncWorkshopModsEnv(server, publishedFileId, true);
    logModChange(server, 'install', publishedFileId, detail && detail.title, 'official');
    return { installed: publishedFileId, kind: 'official', packageName, dependencies, missingDependencies, restartRequired: true };
  }

  const found = await dockerctl.exec(c, ['sh', '-c', `find '${tmp}' -type f \\( -name '*.pak' -o -name '*.utoc' -o -name '*.ucas' \\) 2>/dev/null`]);
  const pakFiles = found.trim() ? found.trim().split('\n') : [];
  if (!pakFiles.length) {
    await dockerctl.exec(c, ['sh', '-c', `rm -rf '${tmp}'`]);
    throw Object.assign(new Error(modPlatform(server) === 'windows'
      ? 'Download contains neither an official-format Info.json nor pak files — cannot install automatically.'
      : 'Download succeeded but contains no .pak files — this mod type (UE4SS/Lua/PalSchema) only works on Windows-build servers (e.g. the Wine instance) and cannot run on this native Linux server.'), { status: 400 });
  }
  const destDir = `${MODS_DIR}/${publishedFileId}`;
  await dockerctl.exec(c, ['sh', '-c', `mkdir -p '${destDir}' && find '${tmp}' -type f \\( -name '*.pak' -o -name '*.utoc' -o -name '*.ucas' \\) -exec mv {} '${destDir}/' \\; && rm -rf '${tmp}'`]);
  const reg = readRegistry();
  reg[`${server.id}:${publishedFileId}`] = {
    source: 'workshop', kind: 'pak', id: String(publishedFileId),
    title: detail?.title || `Workshop item ${publishedFileId}`,
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${publishedFileId}`,
    installedAt: new Date().toISOString(),
    files: pakFiles.map((f) => path.basename(f)),
  };
  writeRegistry(reg);
  syncWorkshopModsEnv(server, publishedFileId, true);
  logModChange(server, 'install', publishedFileId, detail && detail.title, 'pak');
  return { installed: publishedFileId, kind: 'pak', files: pakFiles.map((f) => path.basename(f)), restartRequired: true };
}

/** Install from an uploaded .pak (or companion) file. */
async function installFromUpload(server, filename, buffer, modName) {
  const safeName = path.basename(filename).replace(/[^\w.\- ]/g, '_');
  if (!/\.(pak|utoc|ucas)$/i.test(safeName)) {
    throw Object.assign(new Error('Only .pak, .utoc and .ucas files can be installed on a Linux server. Zip archives: extract locally and upload the pak files.'), { status: 400 });
  }
  const dir = (modName || safeName.replace(/\.(pak|utoc|ucas)$/i, '')).replace(/[^\w.\- ]/g, '_');
  const c = server.containerName;
  const destDir = `${MODS_DIR}/${dir}`;
  await dockerctl.exec(c, ['sh', '-c', `mkdir -p '${destDir}'`]);
  await dockerctl.execWriteFile(c, `${destDir}/${safeName}`, buffer);
  const reg = readRegistry();
  const key = `${server.id}:${dir}`;
  const entry = reg[key] || { source: 'upload', id: dir, title: dir, installedAt: new Date().toISOString(), files: [] };
  if (!entry.files.includes(safeName)) entry.files.push(safeName);
  reg[key] = entry;
  writeRegistry(reg);
  logModChange(server, 'install', dir, dir, 'upload');
  return { installed: dir, file: safeName, restartRequired: true };
}

async function removeMod(server, dir, kind = 'pak') {
  const safe = path.basename(dir);
  if (!safe || safe === '.' || safe === '..' || safe === '(root)') throw Object.assign(new Error('invalid mod dir'), { status: 400 });
  const reg = readRegistry();
  if (kind === 'official') {
    await dockerctl.exec(server.containerName, ['sh', '-c', `rm -rf ${q(`${OFFICIAL_MODS_DIR}/Workshop/${safe}`)}`]);
    const meta = reg[`${server.id}:official:${safe}`];
    if (meta && meta.packageName) {
      await dockerctl.exec(server.containerName,
        ['sh', '-c', `sed -i "/^ActiveModList=${meta.packageName}$/d" ${q(`${OFFICIAL_MODS_DIR}/PalModSettings.ini`)} 2>/dev/null || true`]);
    }
    delete reg[`${server.id}:official:${safe}`];
  } else {
    await dockerctl.exec(server.containerName, ['sh', '-c', `rm -rf '${MODS_DIR}/${safe.replace(/'/g, '')}'`]);
    delete reg[`${server.id}:${safe}`];
  }
  writeRegistry(reg);
  if (/^\d+$/.test(safe)) syncWorkshopModsEnv(server, safe, false);
  logModChange(server, 'remove', safe, safe, kind);
  return { removed: safe, restartRequired: true };
}

// ---------------------------------------------------------------- nexus
const NEXUS_BASE = 'https://api.nexusmods.com/v1';

async function nexusReq(apiKey, path) {
  const res = await fetch(NEXUS_BASE + path, {
    headers: { apikey: apiKey, 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401) throw Object.assign(new Error('Nexus API key rejected (401) — check the key under Mods → Accounts.'), { status: 400 });
  if (res.status === 403) throw Object.assign(new Error('Nexus refused the request (403) — direct API downloads require a Nexus Premium account.'), { status: 400 });
  if (!res.ok) throw new Error(`Nexus API HTTP ${res.status}`);
  return res.json();
}

async function validateNexusKey(apiKey) {
  const u = await nexusReq(apiKey, '/users/validate.json');
  return { name: u.name, premium: Boolean(u.is_premium), email: u.email || null };
}

async function nexusBrowse(server, feed = 'trending') {
  const s = getSecrets(server.id);
  if (!s.nexusApiKey) throw Object.assign(new Error('No Nexus API key configured — add it under Mods → Accounts.'), { status: 400 });
  const path = { trending: '/games/palworld/mods/trending.json', latest: '/games/palworld/mods/latest_added.json', updated: '/games/palworld/mods/latest_updated.json' }[feed];
  if (!path) throw Object.assign(new Error('unknown feed'), { status: 400 });
  const mods = await nexusReq(s.nexusApiKey, path);
  return mods.filter((m) => m.available !== false && m.status === 'published').map((m) => ({
    id: m.mod_id,
    title: m.name,
    summary: (m.summary || '').slice(0, 300),
    author: m.author,
    version: m.version,
    endorsements: m.endorsement_count ?? null,
    preview: m.picture_url || null,
    timeUpdated: m.updated_time || null,
    adult: Boolean(m.contains_adult_content),
    url: `https://www.nexusmods.com/palworld/mods/${m.mod_id}`,
  }));
}

/** Premium-only: pick the primary file, get a CDN link, download + install pak content. */
async function installFromNexus(server, modId) {
  if (!/^\d+$/.test(String(modId))) throw Object.assign(new Error('invalid mod id'), { status: 400 });
  const s = getSecrets(server.id);
  if (!s.nexusApiKey) throw Object.assign(new Error('No Nexus API key configured — add it under Mods → Accounts.'), { status: 400 });
  if (!s.nexusPremium) throw Object.assign(new Error('Direct Nexus downloads are only possible with a Nexus Premium account (their API restriction). Download the mod in your browser and use the upload installer instead.'), { status: 400 });

  const info = await nexusReq(s.nexusApiKey, `/games/palworld/mods/${modId}.json`);
  const files = await nexusReq(s.nexusApiKey, `/games/palworld/mods/${modId}/files.json`);
  const main = (files.files || []).find((f) => f.category_name === 'MAIN' || f.is_primary) || (files.files || [])[0];
  if (!main) throw Object.assign(new Error('Mod has no downloadable files.'), { status: 400 });
  if (!/\.(zip|pak)$/i.test(main.file_name)) {
    throw Object.assign(new Error(`Main file is ${main.file_name} — only .zip and .pak can be auto-installed. Download manually and upload the pak files.`), { status: 400 });
  }
  const links = await nexusReq(s.nexusApiKey, `/games/palworld/mods/${modId}/files/${main.file_id}/download_link.json`);
  const uri = links[0]?.URI;
  if (!uri) throw new Error('Nexus returned no download link.');

  const c = server.containerName;
  const tmp = `/tmp/pw-nexus-${modId}`;
  const fname = main.file_name.replace(/[^\w.\- ]/g, '_');
  await dockerctl.exec(c, ['sh', '-c', `rm -rf ${q(tmp)} && mkdir -p ${q(tmp)}`]);
  await dockerctl.exec(c, ['sh', '-c',
    `cd ${q(tmp)} && (command -v curl >/dev/null && curl -fsSL -o ${q(fname)} ${q(uri)} || wget -q -O ${q(fname)} ${q(uri)})`], 600000);
  if (/\.zip$/i.test(fname)) {
    await dockerctl.exec(c, ['sh', '-c', `cd ${q(tmp)} && (command -v unzip >/dev/null && unzip -o ${q(fname)} || python3 -m zipfile -e ${q(fname)} .)`], 300000);
  }
  const found = await dockerctl.exec(c, ['sh', '-c', `find ${q(tmp)} -type f \\( -name '*.pak' -o -name '*.utoc' -o -name '*.ucas' \\) 2>/dev/null`]);
  const pakFiles = found.trim() ? found.trim().split('\n') : [];
  if (!pakFiles.length) {
    await dockerctl.exec(c, ['sh', '-c', `rm -rf ${q(tmp)}`]);
    throw Object.assign(new Error('Archive contains no .pak files — this mod type only works on Windows servers / clients.'), { status: 400 });
  }
  const dir = `nexus-${modId}`;
  const destDir = `${MODS_DIR}/${dir}`;
  await dockerctl.exec(c, ['sh', '-c', `mkdir -p ${q(destDir)} && find ${q(tmp)} -type f \\( -name '*.pak' -o -name '*.utoc' -o -name '*.ucas' \\) -exec mv {} ${q(destDir)}/ \\; && rm -rf ${q(tmp)}`]);
  const reg = readRegistry();
  reg[`${server.id}:${dir}`] = {
    source: 'nexus', id: String(modId), title: info.name || `Nexus mod ${modId}`,
    url: `https://www.nexusmods.com/palworld/mods/${modId}`,
    installedAt: new Date().toISOString(),
    files: pakFiles.map((f) => path.basename(f)),
  };
  writeRegistry(reg);
  logModChange(server, 'install', dir, (info && info.name) || dir, 'nexus');
  return { installed: dir, files: pakFiles.map((f) => path.basename(f)), restartRequired: true };
}

module.exports = {
  searchWorkshop, getDetails, listInstalled, installFromWorkshop, installFromUpload, removeMod,
  steamCreds, testSteamLogin, validateNexusKey, nexusBrowse, installFromNexus,
  startQrLogin, qrLoginStatus, modPlatform, readStoredSteamUsername, pendingModChanges,
};
