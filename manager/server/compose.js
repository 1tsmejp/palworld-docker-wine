const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { DATA_DIR } = require('./config');

/**
 * Comment-preserving editor for the docker-compose.yml of a Palworld stack.
 * Supports both map-style (KEY: value) and list-style (- KEY=value)
 * `environment` blocks.
 */

function loadDoc(composeFile) {
  const text = fs.readFileSync(composeFile, 'utf8');
  return YAML.parseDocument(text);
}

function envNode(doc, serviceName) {
  const node = doc.getIn(['services', serviceName, 'environment']);
  if (!node) throw new Error(`No environment block for service "${serviceName}"`);
  return node;
}

/** Returns { KEY: stringValue } for the service's environment. */
function readEnv(composeFile, serviceName) {
  const doc = loadDoc(composeFile);
  const node = envNode(doc, serviceName);
  const out = {};
  if (YAML.isMap(node)) {
    for (const pair of node.items) {
      out[String(pair.key)] = pair.value == null ? '' : String(pair.value);
    }
  } else if (YAML.isSeq(node)) {
    for (const item of node.items) {
      const s = String(item);
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
    }
  }
  return out;
}

/**
 * Applies { KEY: value } updates (value === null removes the key) to the
 * compose file. Writes a timestamped backup first. Returns backup path.
 */
function updateEnv(composeFile, serviceName, updates) {
  const text = fs.readFileSync(composeFile, 'utf8');
  const doc = YAML.parseDocument(text);
  const node = envNode(doc, serviceName);
  const isMap = YAML.isMap(node);

  for (const [key, value] of Object.entries(updates)) {
    if (isMap) {
      if (value === null) {
        node.delete(key);
      } else {
        // Keep everything as scalars; quote strings that YAML would mangle.
        node.set(key, formatScalar(value));
      }
    } else {
      const idx = node.items.findIndex((it) => String(it).startsWith(key + '='));
      if (value === null) {
        if (idx >= 0) node.items.splice(idx, 1);
      } else if (idx >= 0) {
        node.items[idx] = `${key}=${value}`;
      } else {
        node.add(`${key}=${value}`);
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, 'backups', `${path.basename(composeFile)}.${stamp}.bak`);
  fs.copyFileSync(composeFile, backupPath);
  fs.writeFileSync(composeFile, doc.toString());
  pruneBackups(path.basename(composeFile));
  return backupPath;
}

/**
 * Rewrites the service's `ports:` entries to follow a port cutover.
 * - gamePort: the host side of the game mapping moves to the new value; the
 *   container side stays (the game always binds 8211 inside the container).
 * - queryPort: both sides move (the server binds QUERY_PORT inside too).
 * Returns a list of human-readable rewrites (empty if nothing matched).
 */
function syncPorts(composeFile, serviceName, { gamePort, queryPort } = {}) {
  const text = fs.readFileSync(composeFile, 'utf8');
  const doc = YAML.parseDocument(text);
  const node = doc.getIn(['services', serviceName, 'ports']);
  if (!node || !YAML.isSeq(node)) throw new Error(`No ports list for service "${serviceName}"`);

  const parse = (s) => {
    const m = String(s).match(/^(\d+):(\d+)(?:\/(udp|tcp))?$/);
    return m ? { host: Number(m[1]), container: Number(m[2]), proto: m[3] || 'tcp' } : null;
  };
  const rewrites = [];
  const rewrite = (item, next) => {
    const before = String(item.value ?? item);
    if (YAML.isScalar(item)) item.value = next; // keeps any trailing comment
    rewrites.push(`${before} → ${next}`);
  };

  for (const item of node.items) {
    const p = parse(YAML.isScalar(item) ? item.value : item);
    if (!p || p.proto !== 'udp') continue;
    if (queryPort && p.host === queryPort.old && queryPort.old !== queryPort.new) {
      rewrite(item, `${queryPort.new}:${queryPort.new}/udp`);
    } else if (gamePort && p.host === gamePort.old && gamePort.old !== gamePort.new) {
      rewrite(item, `${gamePort.new}:${p.container}/udp`);
    }
  }
  if (rewrites.length) fs.writeFileSync(composeFile, doc.toString());
  return rewrites;
}

function formatScalar(value) {
  // Booleans are written as quoted "True"/"False" strings — the convention the
  // image README documents for PalWorldSettings values — so YAML/compose never
  // re-types them (https://github.com/thijsvanloef/palworld-server-docker#editing-server-settings).
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return value;
  const s = String(value);
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s) ? 'True' : 'False';
  if (/^-?\d+$/.test(s) && String(parseInt(s, 10)) === s) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function pruneBackups(baseName, keep = 30) {
  const dir = path.join(DATA_DIR, 'backups');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(baseName)).sort();
  while (files.length > keep) fs.unlinkSync(path.join(dir, files.shift()));
}

module.exports = { readEnv, updateEnv, syncPorts };
