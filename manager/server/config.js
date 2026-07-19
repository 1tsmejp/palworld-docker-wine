const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.MANAGER_CONFIG_DIR || path.join(__dirname, '..', 'config');
const DATA_DIR = process.env.MANAGER_DATA_DIR || path.join(__dirname, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8'));
}

function loadServers() {
  return readJson('servers.json');
}

function saveServers(data) {
  fs.writeFileSync(path.join(CONFIG_DIR, 'servers.json'), JSON.stringify(data, null, 2));
}

function loadSchema() {
  return readJson('settings-schema.json');
}

function loadCannedMessages() {
  return readJson('canned-messages.json');
}

function saveCannedMessages(msgs) {
  fs.writeFileSync(path.join(CONFIG_DIR, 'canned-messages.json'), JSON.stringify(msgs, null, 2));
}

function getServer(id) {
  const s = loadServers().servers.find((x) => x.id === id);
  if (!s) { const e = new Error(`Unknown server: ${id}`); e.status = 404; throw e; }
  return s;
}

function appendHistory(kind, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.join(DATA_DIR, `${kind}.jsonl`), line + '\n');
}

function readHistory(kind, limit = 50) {
  const file = path.join(DATA_DIR, `${kind}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}

module.exports = { CONFIG_DIR, DATA_DIR, loadServers, saveServers, loadSchema, loadCannedMessages, saveCannedMessages, getServer, appendHistory, readHistory };
