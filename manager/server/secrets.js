const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

/**
 * Per-server credential store for mod deployment (Steam account, Nexus API key).
 * Lives in the manager's data volume (mode 0600), NOT in the compose stack file,
 * so game-server deploys never touch or expose it.
 */
const FILE = path.join(DATA_DIR, 'secrets.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function writeAll(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

function getSecrets(serverId) {
  return readAll()[serverId] || {};
}

function setSecrets(serverId, patch) {
  const all = readAll();
  const cur = all[serverId] || {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete cur[k];
    else cur[k] = v;
  }
  all[serverId] = cur;
  writeAll(all);
  return cur;
}

/** Safe-to-display status: which credentials exist, never their values. */
function secretsStatus(serverId) {
  const s = getSecrets(serverId);
  return {
    steam: s.steamUsername ? { username: s.steamUsername, verified: Boolean(s.steamVerified) } : null,
    nexus: s.nexusApiKey ? { name: s.nexusName || null, premium: Boolean(s.nexusPremium), verified: Boolean(s.nexusVerified) } : null,
  };
}

module.exports = { getSecrets, setSecrets, secretsStatus };
