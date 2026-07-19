const fs = require('fs');
const path = require('path');
const { loadServers, saveServers } = require('./config');

/**
 * UI-driven server provisioning: generates a docker-compose stack for a new
 * Palworld server (native Linux image or the Wine/Windows-build image) under
 * STACKS_DIR, and registers it in servers.json. The server is NOT started —
 * it appears in the UI as "not launched" so every setting can be tuned via
 * the normal Settings tab (which edits the compose env) before first boot.
 */
const STACKS_DIR = process.env.MANAGER_STACKS_DIR || '/stacks/managed';
const NATIVE_IMAGE = process.env.NATIVE_IMAGE || 'thijsvanloef/palworld-server-docker:latest';
const WINE_IMAGE = process.env.WINE_IMAGE || 'palworld-wine-test:latest';

function assertProvisioningAvailable() {
  if (!fs.existsSync(STACKS_DIR)) {
    const e = new Error(`Stack directory ${STACKS_DIR} is not mounted — add a host bind for it to the manager service to enable server provisioning.`);
    e.status = 400;
    throw e;
  }
}

function validate(input, existing) {
  const errors = [];
  const id = String(input.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) errors.push('id must be 2-31 chars: lowercase letters, digits, dashes');
  if (existing.servers.some((s) => s.id === id)) errors.push(`server id "${id}" already exists`);
  const gamePort = parseInt(input.gamePort, 10);
  const restPort = parseInt(input.restPort, 10);
  for (const [label, p] of [['gamePort', gamePort], ['restPort', restPort]]) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) errors.push(`${label} must be 1024-65535`);
  }
  if (gamePort === restPort) errors.push('gamePort and restPort must differ');
  const usedPorts = existing.servers.flatMap((s) => [s.gamePort, s.restPort]).filter(Boolean);
  for (const p of [gamePort, restPort]) {
    if (usedPorts.includes(p)) errors.push(`port ${p} is already used by another managed server`);
  }
  if (!input.adminPassword || String(input.adminPassword).length < 8) errors.push('adminPassword must be at least 8 characters');
  if (!['native', 'wine'].includes(input.flavor)) errors.push('flavor must be native or wine');
  if (errors.length) {
    const e = new Error('Validation failed: ' + errors.join('; '));
    e.status = 400;
    e.details = errors;
    throw e;
  }
  return { id, gamePort, restPort };
}

function composeYaml({ id, flavor, gamePort, restPort, serverName, serverDescription, serverPassword, adminPassword, players, community }) {
  const image = flavor === 'wine' ? WINE_IMAGE : NATIVE_IMAGE;
  const yq = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const lines = [
    `name: pw-${id}`,
    ``,
    `services:`,
    `  palworld:`,
    `    image: ${image}`,
    `    container_name: palworld-${id}`,
    `    restart: unless-stopped`,
    `    stop_grace_period: 45s`,
    `    ports:`,
    `      - "${gamePort}:8211/udp"`,
    `      - "${restPort}:8212/tcp"  # REST API — do NOT forward to the internet`,
    `    environment:`,
    `      SERVER_NAME: ${yq(serverName || id)}`,
    `      SERVER_DESCRIPTION: ${yq(serverDescription || '')}`,
    `      SERVER_PASSWORD: ${yq(serverPassword || '')}`,
    `      ADMIN_PASSWORD: ${yq(adminPassword)}`,
    `      PLAYERS: ${parseInt(players, 10) || 16}`,
    `      COMMUNITY: ${community ? '"True"' : '"False"'}`,
    `      REST_API_ENABLED: "True"`,
    `      REST_API_PORT: 8212`,
    `      TZ: "UTC"`,
  ];
  if (flavor === 'wine') {
    lines.push(`      UPDATE_ON_BOOT: "false"`);
    lines.push(`      # Required under Wine — the game's save-backup pipeline fails there`);
    lines.push(`      USE_BACKUP_SAVE_DATA: "False"`);
  } else {
    lines.push(`      PUID: 1000`);
    lines.push(`      PGID: 1000`);
  }
  lines.push(
    `    volumes:`,
    flavor === 'wine' ? `      - palworld_data:/palworld` : `      - palworld_data:/palworld/`,
    ``,
    `volumes:`,
    `  palworld_data:`,
    ``);
  return lines.join('\n');
}

/** Create the stack + registry entry. Returns the new server entry. */
function createServer(input) {
  assertProvisioningAvailable();
  const registry = loadServers();
  const { id, gamePort, restPort } = validate(input, registry);
  const dir = path.join(STACKS_DIR, id);
  const composeFile = path.join(dir, 'docker-compose.yml');
  if (fs.existsSync(composeFile)) {
    const e = new Error(`stack already exists at ${composeFile}`);
    e.status = 409;
    throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(composeFile, composeYaml({ ...input, id, gamePort, restPort }));
  const host = registry.hostAddress || 'host.docker.internal';
  const entry = {
    id,
    name: input.name || input.serverName || id,
    composeFile,
    composeProject: `pw-${id}`,
    serviceName: 'palworld',
    containerName: `palworld-${id}`,
    apiUrl: `http://${host}:${restPort}`,
    flavor: input.flavor === 'wine' ? 'wine' : 'thijsvanloef',
    gamePort,
    restPort,
    provisioned: true,
  };
  registry.servers.push(entry);
  saveServers(registry);
  return entry;
}

/** Unregister a server (files and volumes are left untouched unless destroy). */
function removeServer(id, { destroyFiles = false } = {}) {
  const registry = loadServers();
  const idx = registry.servers.findIndex((s) => s.id === id);
  if (idx === -1) { const e = new Error(`unknown server: ${id}`); e.status = 404; throw e; }
  const entry = registry.servers[idx];
  registry.servers.splice(idx, 1);
  saveServers(registry);
  if (destroyFiles && entry.provisioned && entry.composeFile.startsWith(STACKS_DIR)) {
    fs.rmSync(path.dirname(entry.composeFile), { recursive: true, force: true });
  }
  return { removed: id, filesDestroyed: Boolean(destroyFiles && entry.provisioned) };
}

module.exports = { createServer, removeServer, STACKS_DIR };
