const express = require('express');
const path = require('path');
const { loadServers, saveServers, loadCannedMessages, saveCannedMessages, getServer, appendHistory, readHistory } = require('./config');
const { PalApi } = require('./palapi');
const { dockerctl } = require('./dockerctl');
const { mergedSettings, validateUpdates } = require('./schema');
const { startDeploy, getJob, listJobs } = require('./deploy');
const mods = require('./mods');
const { readEnv } = require('./compose');
const { setSecrets, secretsStatus } = require('./secrets');

const app = express();
app.use(express.json());

// Optional basic auth: set MANAGER_PASSWORD to enable.
const PASSWORD = process.env.MANAGER_PASSWORD;
if (PASSWORD) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [, b64] = hdr.split(' ');
    const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (pass === PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="palworld-manager"').status(401).send('Auth required');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(e.status || 500).json({ error: e.message, details: e.details });
});

// ---- server provisioning ----------------------------------------------------
const provision = require('./provision');

// Create a new managed server: writes its compose stack + registers it. The
// server is NOT started — configure it in Settings, then hit Launch.
app.post('/api/servers', wrap(async (req, res) => {
  const entry = provision.createServer(req.body || {});
  appendHistory('provisioning', { action: 'create', serverId: entry.id, flavor: entry.flavor });
  res.status(201).json(entry);
}));

// Unregister (files/volumes kept unless ?destroy=1 and the stack was created here)
app.delete('/api/servers/:id', wrap(async (req, res) => {
  const result = provision.removeServer(req.params.id, { destroyFiles: req.query.destroy === '1' });
  appendHistory('provisioning', { action: 'remove', serverId: req.params.id, destroyed: result.filesDestroyed });
  res.json(result);
}));

// First launch / start after stop: compose up (creates the container).
app.post('/api/servers/:id/start', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  await dockerctl.composeUp(server, false);
  appendHistory('provisioning', { action: 'start', serverId: server.id });
  res.json({ ok: true, note: 'starting — first boot downloads the game server, which can take several minutes' });
}));

// Rename: updates the manager's display name only. The in-game name is the
// ServerName setting (Settings tab), which requires a deploy to change.
app.patch('/api/servers/:id', wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name || name.length > 60) { const e = new Error('name required (max 60 chars)'); e.status = 400; throw e; }
  const data = loadServers();
  const s = data.servers.find((x) => x.id === req.params.id);
  if (!s) { const e = new Error(`Unknown server: ${req.params.id}`); e.status = 404; throw e; }
  s.name = name;
  saveServers(data);
  appendHistory('provisioning', { action: 'rename', serverId: s.id, name });
  res.json({ ok: true, name });
}));

// Graceful stop: save the world (when the REST API is reachable), then stop
// the container. It stays created, so Start brings it back with compose up.
app.post('/api/servers/:id/stop', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  try { await new PalApi(server).save(); } catch { /* offline or paused — stop anyway */ }
  await dockerctl.composeStop(server);
  appendHistory('provisioning', { action: 'stop', serverId: server.id });
  res.json({ ok: true });
}));

// Quick restart (world saved first when possible). For a restart with an
// in-game countdown announcement, use the deploy flow instead.
app.post('/api/servers/:id/restart', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  try { await new PalApi(server).save(); } catch { /* offline or paused */ }
  await dockerctl.composeRestart(server);
  appendHistory('provisioning', { action: 'restart', serverId: server.id });
  res.json({ ok: true });
}));

// ---- servers & live status --------------------------------------------------
app.get('/api/servers', wrap(async (req, res) => {
  const { servers } = loadServers();
  const out = await Promise.all(servers.map(async (s) => {
    const state = await dockerctl.containerState(s.containerName);
    let info = null, metrics = null, paused = false;
    if (state.status === 'running') {
      try {
        const api = new PalApi(s);
        [info, metrics] = await Promise.all([api.info(), api.metrics()]);
      } catch {
        // REST down but container healthy + auto-pause on => most likely paused
        try {
          const env = readEnv(s.composeFile, s.serviceName);
          paused = /^true$/i.test(String(env.AUTO_PAUSE_ENABLED || '')) && state.health !== 'unhealthy';
        } catch { /* ignore */ }
      }
    }
    const pendingMods = mods.pendingModChanges(s, state.startedAt);
    return {
      id: s.id, name: s.name, container: state, info, metrics, paused, apiUrl: s.apiUrl,
      pendingModChanges: pendingMods.length,
      flavor: s.flavor || 'thijsvanloef', provisioned: Boolean(s.provisioned), gamePort: s.gamePort,
    };
  }));
  res.json(out);
}));

app.get('/api/servers/:id/players', wrap(async (req, res) => {
  res.json(await new PalApi(getServer(req.params.id)).players());
}));

app.get('/api/servers/:id/logs', wrap(async (req, res) => {
  const tail = Math.min(parseInt(req.query.tail || '100', 10), 1000);
  res.json({ logs: await dockerctl.logs(getServer(req.params.id).containerName, tail) });
}));

// ---- settings ---------------------------------------------------------------
app.get('/api/servers/:id/settings', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  let runningEnv = null;
  try { runningEnv = await dockerctl.containerEnv(server.containerName); } catch { /* no docker */ }
  const merged = mergedSettings(server, runningEnv);
  let live = null;
  try { live = await new PalApi(server).settings(); } catch { /* offline */ }
  res.json({ ...merged, live });
}));

// Validate without applying (used by UI for inline feedback)
app.post('/api/servers/:id/settings/validate', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json({ ok: true, normalized: validateUpdates(req.body.updates || {}, server) });
}));

// ---- player moderation --------------------------------------------------
app.post('/api/servers/:id/players/:action(kick|ban|unban)', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const { userId, message } = req.body || {};
  if (!userId) { const e = new Error('userId required'); e.status = 400; throw e; }
  const api = new PalApi(server);
  if (req.params.action === 'kick') await api.kick(userId, message);
  else if (req.params.action === 'ban') await api.ban(userId, message);
  else await api.unban(userId);
  appendHistory('moderation', { serverId: server.id, action: req.params.action, userId, message });
  res.json({ ok: true });
}));

// ---- backups ------------------------------------------------------------
app.get('/api/servers/:id/backups', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const out = await dockerctl.exec(server.containerName,
    ['sh', '-c', 'ls -l --time-style=+%Y-%m-%dT%H:%M:%S /palworld/backups/ 2>/dev/null | tail -n +2']);
  const backups = out.trim() ? out.trim().split('\n').map((line) => {
    const parts = line.split(/\s+/);
    return { size: Number(parts[4]) || 0, date: parts[5], name: parts.slice(6).join(' ') };
  }).filter((b) => b.name).reverse() : [];
  res.json(backups);
}));

app.post('/api/servers/:id/backups', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  try { await new PalApi(server).save(); } catch { /* still make the backup */ }
  const out = await dockerctl.exec(server.containerName, ['backup'], 600000);
  appendHistory('backups', { serverId: server.id, action: 'manual' });
  res.json({ ok: true, output: out.split('\n').slice(-4).join('\n') });
}));

app.get('/api/servers/:id/backups/:name/download', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const name = req.params.name;
  if (!/^[\w.\- ]+$/.test(name)) { const e = new Error('bad name'); e.status = 400; throw e; }
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  await dockerctl.execStreamFile(server.containerName, `/palworld/backups/${name}`, res);
}));

app.delete('/api/servers/:id/backups/:name', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const name = req.params.name;
  if (!/^[\w.\- ]+$/.test(name)) { const e = new Error('bad name'); e.status = 400; throw e; }
  await dockerctl.exec(server.containerName, ['rm', `/palworld/backups/${name}`]);
  res.json({ ok: true });
}));

// ---- world saves (export / import / migrate) ----------------------------
const saves = require('./saves');

app.get('/api/servers/:id/saves', wrap(async (req, res) => {
  res.json(await saves.listSaves(getServer(req.params.id)));
}));

app.get('/api/servers/:id/saves/:guid/export', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="palworld-${server.id}-${req.params.guid}.tar.gz"`);
  res.setHeader('Content-Type', 'application/gzip');
  await saves.exportSave(server, req.params.guid, res);
}));

app.post('/api/servers/:id/saves/import', express.raw({ type: '*/*', limit: '2gb' }), wrap(async (req, res) => {
  const server = getServer(req.params.id);
  if (!req.body || !req.body.length) { const e = new Error('empty upload'); e.status = 400; throw e; }
  const opts = {
    assignNewGuid: req.query.newGuid === '1',
    removeWorldOption: req.query.stripWorldOption === '1',
  };
  const result = await saves.importSave(server, req.body, opts);
  appendHistory('saves', { serverId: server.id, action: 'import', guid: result.imported });
  let job = null;
  if (req.query.restart === '1') {
    job = await startDeploy(server, {
      reboot: true,
      countdownSeconds: parseInt(req.query.countdown || '60', 10),
      message: 'Restarting to load imported world in {time}!',
    });
  }
  res.json({ ...result, job: job ? job.id : null });
}));

// Migrate a world between two managed servers on this host. Overwrites the
// same-GUID world on the target; a target restart is needed to load it.
app.post('/api/saves/migrate', wrap(async (req, res) => {
  const { from, to, guid, restart, countdownSeconds = 0, message, assignNewGuid, stripWorldOption } = req.body || {};
  const fromServer = getServer(from), toServer = getServer(to);
  if (from === to) { const e = new Error('source and target are the same server'); e.status = 400; throw e; }
  const result = await saves.migrateSave(fromServer, toServer, guid, { assignNewGuid: Boolean(assignNewGuid), removeWorldOption: Boolean(stripWorldOption) });
  appendHistory('saves', { serverId: to, action: 'migrate', from, guid });
  let job = null;
  if (restart) {
    job = await startDeploy(toServer, { reboot: true, countdownSeconds, message: message || 'Restarting to load migrated world in {time}!' });
  }
  res.json({ ...result, job: job ? job.id : null });
}));

// ---- mod accounts (Steam / Nexus credentials) ---------------------------
app.get('/api/servers/:id/accounts', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  // Self-healing: a persisted DepotDownloader token without stored secrets
  // (e.g. sign-in verified but name extraction failed) is adopted here.
  let status = secretsStatus(server.id);
  if (!status.steam) {
    const username = await mods.readStoredSteamUsername(server).catch(() => null);
    if (username) {
      setSecrets(server.id, { steamUsername: username, steamTokenOnly: true, steamVerified: true });
      status = secretsStatus(server.id);
    }
  }
  res.json(status);
}));

// Steam sign-in: verifies with a real DepotDownloader login in the game
// container (handles Steam Guard code via `guardCode`), then stores creds.
app.post('/api/servers/:id/accounts/steam', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const { username, password, guardCode } = req.body || {};
  if (!username || !password) { const e = new Error('username and password required'); e.status = 400; throw e; }
  const result = await mods.testSteamLogin(server, { username, password, guardCode });
  if (result.ok) {
    setSecrets(server.id, { steamUsername: username, steamPassword: password, steamVerified: true });
  }
  res.status(result.ok ? 200 : 400).json(result);
}));

app.delete('/api/servers/:id/accounts/steam', wrap(async (req, res) => {
  getServer(req.params.id);
  setSecrets(req.params.id, { steamUsername: null, steamPassword: null, steamVerified: null, steamTokenOnly: null });
  res.json({ ok: true });
}));

// QR sign-in ("Sign in with the Steam app"): start a session, then poll.
app.post('/api/servers/:id/accounts/steam/qr', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json(mods.startQrLogin(server));
}));

app.get('/api/servers/:id/accounts/steam/qr/:sid', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json(mods.qrLoginStatus(server, req.params.sid));
}));

// Nexus key: validated against their API; stores name/premium for the UI.
app.post('/api/servers/:id/accounts/nexus', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const { apiKey } = req.body || {};
  if (!apiKey) { const e = new Error('apiKey required'); e.status = 400; throw e; }
  const v = await mods.validateNexusKey(apiKey.trim());
  setSecrets(server.id, { nexusApiKey: apiKey.trim(), nexusName: v.name, nexusPremium: v.premium, nexusVerified: true });
  res.json({ ok: true, ...v });
}));

app.delete('/api/servers/:id/accounts/nexus', wrap(async (req, res) => {
  getServer(req.params.id);
  setSecrets(req.params.id, { nexusApiKey: null, nexusName: null, nexusPremium: null, nexusVerified: null });
  res.json({ ok: true });
}));

// ---- nexus browse / install ---------------------------------------------
app.get('/api/servers/:id/nexus/browse', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json({ feed: req.query.feed || 'trending', items: await mods.nexusBrowse(server, req.query.feed || 'trending') });
}));

app.post('/api/servers/:id/nexus/install', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json(await mods.installFromNexus(server, req.body.id));
}));

// Mod installs/removals since the container's current start — i.e. staged on
// disk but not active until the next restart (mods only load at boot).
app.get('/api/servers/:id/mods-pending', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const state = await dockerctl.containerState(server.containerName);
  res.json(mods.pendingModChanges(server, state.startedAt));
}));

// ---- mods ---------------------------------------------------------------
app.get('/api/mods/search', wrap(async (req, res) => {
  res.json(await mods.searchWorkshop({ q: req.query.q || '', sort: req.query.sort || 'trend', page: req.query.page || 1, compat: req.query.compat || 'all' }));
}));

app.get('/api/servers/:id/mods', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json({
    installed: await mods.listInstalled(server),
    steamCredsConfigured: mods.steamCreds(server) !== null,
    accounts: secretsStatus(server.id),
    modPlatform: mods.modPlatform(server),
  });
}));

app.post('/api/servers/:id/mods/install', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json(await mods.installFromWorkshop(server, req.body.id));
}));

app.post('/api/servers/:id/mods/upload', express.raw({ type: '*/*', limit: '500mb' }), wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const filename = String(req.query.filename || 'mod.pak');
  const modName = req.query.modName ? String(req.query.modName) : null;
  if (!req.body || !req.body.length) { const e = new Error('empty upload'); e.status = 400; throw e; }
  res.json(await mods.installFromUpload(server, filename, req.body, modName));
}));

app.delete('/api/servers/:id/mods/:dir', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  res.json(await mods.removeMod(server, req.params.dir, req.query.kind === 'official' ? 'official' : 'pak'));
}));

// ---- announcements ----------------------------------------------------------
app.post('/api/servers/:id/announce', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const message = String(req.body.message || '').trim();
  if (!message) { const e = new Error('message required'); e.status = 400; throw e; }
  await new PalApi(server).announce(message);
  appendHistory('announcements', { serverId: server.id, message });
  res.json({ ok: true });
}));

app.get('/api/servers/:id/announcements', wrap(async (req, res) => {
  res.json(readHistory('announcements').filter((h) => h.serverId === req.params.id));
}));

// ---- canned messages --------------------------------------------------------
app.get('/api/canned-messages', wrap(async (req, res) => res.json(loadCannedMessages())));
app.put('/api/canned-messages', wrap(async (req, res) => {
  const body = req.body || {};
  for (const k of ['announcements', 'rebootCountdown', 'rebootComplete']) {
    if (!Array.isArray(body[k]) || !body[k].every((x) => typeof x === 'string')) {
      const e = new Error(`${k} must be an array of strings`); e.status = 400; throw e;
    }
  }
  saveCannedMessages({ announcements: body.announcements, rebootCountdown: body.rebootCountdown, rebootComplete: body.rebootComplete });
  res.json({ ok: true });
}));

// ---- deploy -----------------------------------------------------------------
app.post('/api/servers/:id/deploy', wrap(async (req, res) => {
  const server = getServer(req.params.id);
  const running = listJobs(server.id).find((j) => j.status === 'running');
  if (running) { const e = new Error(`deploy ${running.id} already running`); e.status = 409; throw e; }
  const job = await startDeploy(server, req.body || {});
  res.status(202).json(job);
}));

app.get('/api/jobs/:id', wrap(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  res.json(job);
}));

app.get('/api/servers/:id/jobs', wrap(async (req, res) => res.json(listJobs(req.params.id))));
app.get('/api/servers/:id/deploy-history', wrap(async (req, res) => {
  res.json(readHistory('deploys').filter((h) => h.serverId === req.params.id));
}));

const port = loadServers().managerPort || 8220;
app.listen(port, () => console.log(`palworld-manager listening on :${port}`));
