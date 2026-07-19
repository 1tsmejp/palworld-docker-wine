const { spawn } = require('child_process');
const { dockerctl } = require('./dockerctl');
const { PalApi } = require('./palapi');

/**
 * World save export / import / migration.
 * Palworld worlds live in /palworld/Pal/Saved/SaveGames/0/<WorldGUID>/ and are
 * portable between dedicated servers (Linux and Windows builds share the same
 * save format). The active world is selected by DedicatedServerName in
 * GameUserSettings.ini. A restart is required for imports to take effect.
 */
const SAVES_DIR = '/palworld/Pal/Saved/SaveGames/0';
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function assertGuid(guid) {
  if (!/^[0-9A-Fa-f]{32}$/.test(guid)) {
    throw Object.assign(new Error('invalid world GUID'), { status: 400 });
  }
}

async function configDir(server) {
  const out = await dockerctl.exec(server.containerName,
    ['sh', '-c', 'ls -d /palworld/Pal/Saved/Config/*Server 2>/dev/null | head -1']);
  return out.trim() || '/palworld/Pal/Saved/Config/LinuxServer';
}

async function listSaves(server) {
  let out = '';
  try {
    out = await dockerctl.exec(server.containerName,
      ['sh', '-c', `for d in ${SAVES_DIR}/*/; do [ -d "$d" ] && printf "%s|%s|%s\\n" "$(basename $d)" "$(du -sk $d | cut -f1)" "$(date -r $d +%Y-%m-%dT%H:%M:%S 2>/dev/null)"; done`]);
  } catch { /* no saves yet */ }
  let activeGuid = null;
  try { activeGuid = (await new PalApi(server).info()).worldguid; } catch { /* offline */ }
  if (!activeGuid) {
    try {
      const cfg = await dockerctl.exec(server.containerName,
        ['sh', '-c', `cat "$(ls -d /palworld/Pal/Saved/Config/*Server | head -1)/GameUserSettings.ini" 2>/dev/null`]);
      const m = cfg.match(/DedicatedServerName=([0-9A-Fa-f]+)/);
      if (m) activeGuid = m[1].toUpperCase();
    } catch { /* ignore */ }
  }
  const saves = out.trim() ? out.trim().split('\n').map((line) => {
    const [guid, sizeKb, mtime] = line.split('|');
    return { guid, sizeKb: Number(sizeKb) || 0, mtime, active: activeGuid ? guid.toUpperCase() === activeGuid.toUpperCase() : false };
  }) : [];
  return { saves, activeGuid };
}

/** Stream a world as tar.gz onto an express response. */
function exportSave(server, guid, res) {
  assertGuid(guid);
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', server.containerName, 'tar', '-czf', '-', '-C', SAVES_DIR, guid]);
    p.stdout.pipe(res);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `tar exit ${code}`)));
  });
}

/** Point GameUserSettings.ini at a world GUID (takes effect on restart). */
async function setActiveWorld(server, guid) {
  assertGuid(guid);
  const dir = await configDir(server);
  const file = `${dir}/GameUserSettings.ini`;
  await dockerctl.exec(server.containerName, ['sh', '-c', `
    if [ -f ${q(file)} ] && grep -q "DedicatedServerName=" ${q(file)}; then
      sed -i "s/DedicatedServerName=.*/DedicatedServerName=${guid}/" ${q(file)}
    else
      mkdir -p ${q(dir)}
      printf "[/Script/Pal.PalGameLocalSettings]\\nDedicatedServerName=%s\\n" "${guid}" >> ${q(file)}
    fi`]);
}

function newGuidHex() {
  return require('crypto').randomBytes(16).toString('hex').toUpperCase();
}

/**
 * Post-copy fixup on the target: optionally rename to a fresh GUID (so each
 * server's world stays an independent identity), detect WorldOption.sav
 * (world-embedded settings that OVERRIDE PalWorldSettings.ini / env values),
 * then activate the world.
 */
async function finalizeWorldOnServer(server, guid, { assignNewGuid = false, removeWorldOption = false } = {}) {
  let finalGuid = guid;
  if (assignNewGuid) {
    finalGuid = newGuidHex();
    await dockerctl.exec(server.containerName,
      ['sh', '-c', `mv ${q(`${SAVES_DIR}/${guid}`)} ${q(`${SAVES_DIR}/${finalGuid}`)}`]);
  }
  let hasWorldOption = false;
  try {
    const out = await dockerctl.exec(server.containerName,
      ['sh', '-c', `[ -f ${q(`${SAVES_DIR}/${finalGuid}/WorldOption.sav`)} ] && echo yes || echo no`]);
    hasWorldOption = out.trim() === 'yes';
  } catch { /* ignore */ }
  if (hasWorldOption && removeWorldOption) {
    await dockerctl.exec(server.containerName, ['rm', `${SAVES_DIR}/${finalGuid}/WorldOption.sav`]);
    hasWorldOption = false;
  }
  await setActiveWorld(server, finalGuid);
  return { finalGuid, hasWorldOption };
}

/**
 * Copy a world from one server container to another (same docker host) via a
 * tar pipe — the copy is fully independent afterwards (separate volumes, and
 * optionally a fresh GUID so the two servers' worlds never share an identity).
 */
async function migrateSave(fromServer, toServer, guid, opts = {}) {
  assertGuid(guid);
  await dockerctl.exec(toServer.containerName, ['sh', '-c', `mkdir -p ${q(SAVES_DIR)}`]);
  await new Promise((resolve, reject) => {
    const src = spawn('docker', ['exec', fromServer.containerName, 'tar', '-czf', '-', '-C', SAVES_DIR, guid]);
    const dst = spawn('docker', ['exec', '-i', toServer.containerName, 'tar', '-xzf', '-', '-C', SAVES_DIR]);
    src.stdout.pipe(dst.stdin);
    let err = '';
    src.stderr.on('data', (d) => { err += d; });
    dst.stderr.on('data', (d) => { err += d; });
    let pending = 2;
    const done = (codeOk) => { pending--; if (!codeOk.ok) reject(new Error(err || codeOk.msg)); else if (pending === 0) resolve(); };
    src.on('close', (c) => done({ ok: c === 0, msg: `source tar exit ${c}` }));
    dst.on('close', (c) => done({ ok: c === 0, msg: `target tar exit ${c}` }));
  });
  const fin = await finalizeWorldOnServer(toServer, guid, opts);
  return { migrated: fin.finalGuid, sourceGuid: guid, from: fromServer.id, to: toServer.id, hasWorldOption: fin.hasWorldOption, restartRequired: true };
}

/** Import an uploaded tar.gz (containing <GUID>/ at top level) into a server. */
async function importSave(server, buffer, opts = {}) {
  const c = server.containerName;
  const tmp = '/tmp/pw-save-import.tgz';
  await dockerctl.execWriteFile(c, tmp, buffer);
  const listing = await dockerctl.exec(c, ['sh', '-c', `tar -tzf ${q(tmp)} | head -50`]);
  const top = [...new Set(listing.trim().split('\n').map((l) => l.split('/')[0]))].filter(Boolean);
  const guids = top.filter((t) => /^[0-9A-Fa-f]{32}$/.test(t));
  if (guids.length !== 1) {
    await dockerctl.exec(c, ['rm', '-f', tmp]).catch(() => {});
    throw Object.assign(new Error(`Archive must contain exactly one <WorldGUID>/ folder at its root (found: ${top.join(', ') || 'nothing'}). Export from the manager produces the right format.`), { status: 400 });
  }
  await dockerctl.exec(c, ['sh', '-c', `mkdir -p ${q(SAVES_DIR)} && tar -xzf ${q(tmp)} -C ${q(SAVES_DIR)} && rm -f ${q(tmp)}`], 600000);
  const fin = await finalizeWorldOnServer(server, guids[0], opts);
  return { imported: fin.finalGuid, sourceGuid: guids[0], hasWorldOption: fin.hasWorldOption, restartRequired: true };
}

module.exports = { listSaves, exportSave, migrateSave, importSave, setActiveWorld };
