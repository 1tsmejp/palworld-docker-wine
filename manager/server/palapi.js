const { readEnv } = require('./compose');

/**
 * Client for the Palworld dedicated server REST API.
 * Docs: https://docs.palworldgame.com/category/rest-api
 * Auth is HTTP basic with user "admin" and the server's AdminPassword.
 */
class PalApi {
  constructor(server) {
    this.base = server.apiUrl.replace(/\/$/, '');
    // ADMIN_PASSWORD lives in the compose file — single source of truth.
    const env = readEnv(server.composeFile, server.serviceName);
    this.auth = 'Basic ' + Buffer.from(`admin:${env.ADMIN_PASSWORD || ''}`).toString('base64');
  }

  async req(method, p, body, timeoutMs = 10000) {
    const res = await fetch(this.base + p, {
      method,
      headers: { Authorization: this.auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Palworld API ${method} ${p} -> HTTP ${res.status}`);
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
  }

  info() { return this.req('GET', '/v1/api/info'); }
  metrics() { return this.req('GET', '/v1/api/metrics'); }
  players() { return this.req('GET', '/v1/api/players'); }
  settings() { return this.req('GET', '/v1/api/settings'); }
  announce(message) { return this.req('POST', '/v1/api/announce', { message }); }
  kick(userid, message = 'You were kicked by an admin.') { return this.req('POST', '/v1/api/kick', { userid, message }); }
  ban(userid, message = 'You were banned by an admin.') { return this.req('POST', '/v1/api/ban', { userid, message }); }
  unban(userid) { return this.req('POST', '/v1/api/unban', { userid }); }
  save() { return this.req('POST', '/v1/api/save', undefined, 60000); }
  shutdown(waittime, message) { return this.req('POST', '/v1/api/shutdown', { waittime, message }); }
}

module.exports = { PalApi };
