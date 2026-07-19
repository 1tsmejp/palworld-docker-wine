const { loadSchema } = require('./config');
const { readEnv } = require('./compose');

function bySetting() {
  const schema = loadSchema();
  const map = {};
  for (const s of schema.settings) map[s.env] = s;
  return { schema, map };
}

function coerce(setting, raw) {
  if (raw === undefined || raw === null || raw === '') return raw === '' && setting.type === 'string' ? '' : undefined;
  switch (setting.type) {
    case 'boolean': return /^true$/i.test(String(raw));
    case 'integer': return parseInt(raw, 10);
    case 'number': return parseFloat(raw);
    default: return String(raw);
  }
}

/** Validate one value against its schema entry. Returns error string or null. */
function validateValue(setting, value) {
  if (setting.type === 'boolean') {
    if (typeof value !== 'boolean' && !/^(true|false)$/i.test(String(value))) return 'must be true or false';
    return null;
  }
  if (setting.type === 'enum') {
    if (!setting.enum.includes(String(value))) return `must be one of: ${setting.enum.join(', ')}`;
    return null;
  }
  if (setting.type === 'integer' || setting.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'must be a number';
    if (setting.type === 'integer' && !Number.isInteger(n)) return 'must be an integer';
    if (setting.min !== undefined && n < setting.min) return `below minimum (${setting.min})`;
    if (setting.max !== undefined && n > setting.max) return `above maximum (${setting.max})`;
    return null;
  }
  if (setting.pattern && !new RegExp(setting.pattern).test(String(value))) {
    return setting.patternHint || `must match ${setting.pattern}`;
  }
  return null;
}

/**
 * Validate a { ENV: value } update map. Throws 400-style error on problems.
 * When `server` is given, `requires` dependencies (e.g. AUTO_REBOOT_ENABLED
 * needs RCON_ENABLED=true) are checked against compose env + these updates.
 * Returns normalized updates.
 */
function validateUpdates(updates, server = null) {
  const { map } = bySetting();
  const errors = [];
  const normalized = {};
  for (const [env, value] of Object.entries(updates)) {
    const setting = map[env];
    if (!setting) { errors.push(`${env}: unknown setting`); continue; }
    if (value === null) { normalized[env] = null; continue; } // remove -> image default
    const err = validateValue(setting, value);
    if (err) { errors.push(`${env}: ${err}`); continue; }
    normalized[env] = setting.type === 'boolean'
      ? /^true$/i.test(String(value))
      : setting.type === 'integer' ? parseInt(value, 10)
      : setting.type === 'number' ? Number(value)
      : String(value);
  }

  if (server && !errors.length) {
    let effective = {};
    try {
      const env = readEnv(server.composeFile, server.serviceName);
      for (const s of Object.values(map)) {
        const raw = env[s.env];
        effective[s.env] = raw !== undefined ? coerce(s, raw) : s.default;
      }
    } catch { effective = null; }
    if (effective) {
      for (const [env, value] of Object.entries(normalized)) {
        effective[env] = value === null ? map[env].default : value;
      }
      for (const [env, value] of Object.entries(normalized)) {
        const req = map[env] && map[env].requires;
        if (!req || value !== true) continue;
        for (const [dep, want] of Object.entries(req)) {
          if (String(effective[dep]) !== String(want)) {
            errors.push(`${env}: requires ${dep}=${want} (currently ${effective[dep]}) — enable it in the same deploy`);
          }
        }
      }
    }
  }

  if (errors.length) {
    const e = new Error('Validation failed: ' + errors.join('; '));
    e.status = 400;
    e.details = errors;
    throw e;
  }
  return normalized;
}

/**
 * Merged view for the UI: every schema setting with its default, the value
 * pinned in the compose file, the value in the RUNNING container's env
 * (may differ if the container was edited outside the stack, e.g. via
 * Portainer's container editor), and the effective value.
 */
// Image-infrastructure env vars the Wine image's entrypoint actually honors —
// the rest of the image-scope catalog is thijsvanloef-image-only.
const WINE_SUPPORTED_IMAGE_ENVS = new Set(['UPDATE_ON_BOOT', 'TZ']);

function mergedSettings(server, runningEnv = null) {
  const { schema } = bySetting();
  const env = readEnv(server.composeFile, server.serviceName);
  const drift = [];
  const applicable = schema.settings.filter((s) =>
    s.scope !== 'image' || server.flavor !== 'wine' || WINE_SUPPORTED_IMAGE_ENVS.has(s.env));
  const settings = applicable.map((s) => {
    const pinnedRaw = env[s.env];
    const pinned = pinnedRaw !== undefined ? coerce(s, pinnedRaw) : undefined;
    const entry = { ...s, pinned, effective: pinned !== undefined ? pinned : s.default };
    if (runningEnv) {
      const runRaw = runningEnv[s.env];
      const running = runRaw !== undefined ? coerce(s, runRaw) : undefined;
      if (running !== undefined) entry.running = running;
      const a = running !== undefined ? running : s.default;
      const b = entry.effective;
      if (String(a) !== String(b)) {
        drift.push({ env: s.env, running: a, compose: b });
        entry.drift = true;
      }
    }
    return entry;
  });
  const warnings = [];
  // If settings generation is disabled, env-based settings silently stop applying:
  // https://github.com/thijsvanloef/palworld-server-docker#editing-server-settings
  if (/^true$/i.test(String(env.DISABLE_GENERATE_SETTINGS || ''))) {
    warnings.push('DISABLE_GENERATE_SETTINGS=true is set in the compose file — environment variables are NOT applied to PalWorldSettings.ini. This manager edits env vars, so settings deploys will have no effect until it is removed.');
  }
  return {
    categories: schema.categories,
    settings,
    drift,
    warnings,
    extraEnv: Object.keys(env).filter((k) => !schema.settings.some((s) => s.env === k)),
  };
}

/**
 * Compare desired env updates against the live REST /settings payload.
 * Returns [{env, iniKey, expected, actual, ok}].
 */
function compareWithLive(updates, liveSettings) {
  const { map } = bySetting();
  const results = [];
  for (const [env, value] of Object.entries(updates)) {
    const setting = map[env];
    if (!setting || setting.scope === 'image' || !setting.iniKey) continue;
    const actual = liveSettings[setting.iniKey];
    if (actual === undefined) {
      results.push({ env, iniKey: setting.iniKey, expected: value, actual: null, ok: null, note: 'not reported by REST API' });
      continue;
    }
    let ok;
    if (value === null) ok = null; // reset to default; can't easily assert
    else if (setting.type === 'boolean') ok = Boolean(actual) === Boolean(value);
    else if (setting.type === 'integer' || setting.type === 'number') ok = Math.abs(Number(actual) - Number(value)) < 1e-6;
    else ok = String(actual) === String(value);
    results.push({ env, iniKey: setting.iniKey, expected: value, actual, ok });
  }
  return results;
}

/**
 * Compare image-scope env updates against the recreated container's env.
 * Returns [{env, expected, actual, ok}].
 */
function compareImageEnv(updates, containerEnv) {
  const { map } = bySetting();
  const results = [];
  for (const [env, value] of Object.entries(updates)) {
    const setting = map[env];
    if (!setting || setting.scope !== 'image') continue;
    const raw = containerEnv[env];
    const actual = raw !== undefined ? coerce(setting, raw) : setting.default;
    const ok = value === null ? null : String(actual) === String(value);
    results.push({ env, iniKey: env, expected: value, actual, ok, note: value === null ? 'reset to default' : undefined });
  }
  return results;
}

module.exports = { validateUpdates, mergedSettings, compareWithLive, compareImageEnv };
