/* Palworld Manager SPA */
'use strict';

const state = {
  servers: [],
  serverId: null,
  tab: 'overview',
  settings: null,      // /settings payload for current server
  pending: {},         // env -> new value (null = reset to default)
  canned: { announcements: [], rebootCountdown: [], rebootComplete: [] },
  job: null,           // active/last deploy job
  jobTimer: null,
  pollTimer: null,
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// ---------------------------------------------------------------- helpers
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-box').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function confirmModal({ title, body, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-back">
        <div class="modal">
          <h3>${esc(title)}</h3>
          <div>${body}</div>
          <div class="actions">
            <button class="btn ghost" data-x="no">Cancel</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-x="yes">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    root.onclick = (e) => {
      const x = e.target.dataset.x;
      if (x || e.target.classList.contains('modal-back')) {
        root.innerHTML = '';
        resolve(x === 'yes');
      }
    };
  });
}

// ---------------------------------------------------------------- sidebar
async function refreshServers() {
  try {
    state.servers = await api('/servers');
    if (!state.serverId && state.servers.length) state.serverId = state.servers[0].id;
    renderSidebar();
    renderTopbar();
    updatePendingUI();
    if (state.tab === 'overview') renderView();
  } catch (e) { toast('Failed to load servers: ' + e.message, 'err'); }
}

function currentServer() {
  return state.servers.find((s) => s.id === state.serverId);
}

function renderSidebar() {
  $('#server-list').innerHTML = state.servers.map((s) => {
    const on = s.container.status === 'running' && s.info;
    return `
      <div class="srv-item ${s.id === state.serverId ? 'active' : ''}" data-id="${s.id}">
        <span class="dot ${on ? 'on' : s.container.status === 'running' ? '' : 'off'}"></span>
        <div>
          <div>${esc(s.name)}</div>
          <div class="meta">${on ? `${s.metrics?.currentplayernum ?? '?'}/${s.metrics?.maxplayernum ?? '?'} players` : s.container.status === 'missing' ? 'not launched' : esc(s.container.status)}</div>
        </div>
      </div>`;
  }).join('');
  $('#server-list').insertAdjacentHTML('beforeend',
    '<button class="btn ghost small" id="add-server" style="width:100%;margin-top:6px">＋ Add server</button>');
  $$('.srv-item').forEach((el) => el.onclick = () => selectServer(el.dataset.id));
  $('#add-server').onclick = addServerWizard;
}

function addServerWizard() {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-back"><div class="modal">
      <h3>Add a new Palworld server</h3>
      <p class="muted" style="font-size:.78rem;margin-bottom:12px">
        Creates the server's docker stack and registers it here — it is <b>not started</b> yet.
        You can tune every world setting in the Settings tab first, then press <b>Launch</b>.
      </p>
      <div class="deploy-cols">
        <div>
          <div class="field"><label>Server ID (short, lowercase)</label><input type="text" id="ns-id" placeholder="e.g. events"></div>
          <div class="field"><label>Display name</label><input type="text" id="ns-name" placeholder="Events Server"></div>
          <div class="field"><label>Server type</label>
            <select id="ns-flavor">
              <option value="native">Native Linux (thijsvanloef image — pak mods only)</option>
              <option value="wine">Windows build under Wine (full mod support)</option>
            </select></div>
          <div class="field"><label>Game port (UDP)</label><input type="text" id="ns-gameport" value=""></div>
          <div class="field"><label>REST API port (TCP, LAN only)</label><input type="text" id="ns-restport" value=""></div>
        </div>
        <div>
          <div class="field"><label>In-game server name</label><input type="text" id="ns-sname"></div>
          <div class="field"><label>Description</label><input type="text" id="ns-sdesc"></div>
          <div class="field"><label>Join password (empty = open)</label><input type="text" id="ns-spass"></div>
          <div class="field"><label>Admin password (min 8 chars, required)</label><input type="text" id="ns-apass"></div>
          <div class="field"><label>Max players</label><input type="text" id="ns-players" value="16"></div>
          <div class="field"><label><input type="checkbox" id="ns-community"> List in community server browser</label></div>
        </div>
      </div>
      <div class="actions">
        <button class="btn ghost" id="ns-cancel">Cancel</button>
        <button class="btn primary" id="ns-create">Create server</button>
      </div>
    </div></div>`;
  // suggest free ports
  const used = state.servers.flatMap((s) => [s.gamePort, s.restPort]).filter(Boolean).concat([8211, 8212, 8311, 8312, 8220]);
  let gp = 8411; while (used.includes(gp)) gp += 100;
  $('#ns-gameport').value = gp;
  $('#ns-restport').value = gp + 1;
  $('#ns-cancel').onclick = () => { root.innerHTML = ''; };
  $('#ns-create').onclick = async () => {
    const body = {
      id: $('#ns-id').value.trim(), name: $('#ns-name').value.trim(),
      flavor: $('#ns-flavor').value,
      gamePort: $('#ns-gameport').value, restPort: $('#ns-restport').value,
      serverName: $('#ns-sname').value.trim() || $('#ns-name').value.trim(),
      serverDescription: $('#ns-sdesc').value.trim(),
      serverPassword: $('#ns-spass').value, adminPassword: $('#ns-apass').value,
      players: $('#ns-players').value, community: $('#ns-community').checked,
    };
    $('#ns-create').disabled = true;
    try {
      const entry = await api('/servers', { method: 'POST', body });
      root.innerHTML = '';
      toast(`Server "${entry.id}" created — configure it, then press Launch`, 'ok');
      await refreshServers();
      selectServer(entry.id);
    } catch (e) { $('#ns-create').disabled = false; toast(e.message, 'err'); }
  };
}

function selectServer(id) {
  document.body.classList.remove('sidebar-open');
  $('#menu-btn')?.setAttribute('aria-expanded', 'false');
  if (state.serverId !== id) {
    state.serverId = id;
    state.settings = null;
    state.pending = {};
    state.job = null;
    updatePendingUI();
  }
  renderSidebar();
  renderTopbar();
  renderView();
}

function renderTopbar() {
  const s = currentServer();
  if (!s) return;
  $('#srv-title').textContent = s.name;
  const on = s.container.status === 'running';
  const api_ = s.info;
  $('#srv-badges').innerHTML = `
    <span class="badge ${on ? 'ok' : 'err'}">${on ? '● running' : '○ ' + esc(s.container.status)}</span>
    ${s.paused ? '<span class="badge warn">⏸ paused (auto-pause)</span>' : `<span class="badge ${api_ ? 'ok' : 'err'}">REST ${api_ ? 'connected' : 'unreachable'}</span>`}
    ${api_ ? `<span class="badge">version <b>${esc(api_.version)}</b></span>` : ''}
    ${s.metrics ? `<span class="badge">FPS <b>${s.metrics.serverfps}</b></span>
    <span class="badge">uptime <b>${fmtUptime(s.metrics.uptime)}</b></span>
    <span class="badge">day <b>${s.metrics.days}</b></span>` : ''}`;
}

// ---------------------------------------------------------------- tabs
$$('#tabs .tab').forEach((b) => b.onclick = () => {
  state.tab = b.dataset.tab;
  $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  renderView();
});

function renderView() {
  const v = $('#view');
  const s = currentServer();
  if (!s) { v.innerHTML = '<p class="muted">No servers configured.</p>'; return; }
  ({ overview: renderOverview, settings: renderSettings, announce: renderAnnounce, deploy: renderDeploy, mods: renderMods, backups: renderBackups, logs: renderLogs }[state.tab])(v, s);
}

// ---------------------------------------------------------------- overview
async function renderOverview(v, s) {
  if (s.container.status === 'missing' || s.container.status === 'exited') {
    const fresh = s.container.status === 'missing';
    v.innerHTML = `
      <div class="card" style="text-align:center;padding:40px">
        <h3 style="margin-bottom:10px">${fresh ? '🚀 This server has not been launched yet' : '⏹ Server is stopped'}</h3>
        <p class="muted" style="margin-bottom:18px;font-size:.85rem">
          ${fresh
            ? 'Its configuration lives in the compose stack — review the <b>Settings</b> tab first (everything is editable before first boot), then launch. First boot downloads the game server (~6 GB) and can take several minutes.'
            : 'The container exists but is not running.'}
        </p>
        <button class="btn primary" id="launch-server">${fresh ? '🚀 Launch server' : '▶ Start server'}</button>
        ${s.provisioned && fresh ? '<button class="btn ghost small" id="unregister-server" style="margin-left:10px">Unregister</button>' : ''}
      </div>`;
    $('#launch-server').onclick = async () => {
      const btn = $('#launch-server');
      btn.disabled = true; btn.textContent = 'Starting…';
      try {
        const r = await api(`/servers/${s.id}/start`, { method: 'POST', body: {} });
        toast(r.note || 'Starting…', 'ok');
        setTimeout(refreshServers, 4000);
      } catch (e) { btn.disabled = false; toast('Start failed: ' + e.message, 'err'); }
    };
    const unreg = $('#unregister-server');
    if (unreg) unreg.onclick = async () => {
      const ok = await confirmModal({
        title: `Unregister "${s.name}"?`,
        body: '<p>Removes it from the manager. The stack files and any data volume are kept on disk.</p>',
        confirmText: 'Unregister', danger: true,
      });
      if (!ok) return;
      try {
        await api(`/servers/${s.id}`, { method: 'DELETE' });
        toast('Server unregistered', 'ok');
        state.serverId = null;
        await refreshServers();
        renderView();
      } catch (e) { toast(e.message, 'err'); }
    };
    return;
  }
  const m = s.metrics;
  v.innerHTML = `
    <div class="srv-actions">
      <button class="btn" id="restart-server">⟳ Restart</button>
      <button class="btn danger" id="stop-server">⏹ Stop server</button>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="v">${m ? `${m.currentplayernum}/${m.maxplayernum}` : '—'}</div><div class="l">Players</div></div>
      <div class="stat"><div class="v">${m ? m.serverfps : '—'}</div><div class="l">Server FPS</div></div>
      <div class="stat"><div class="v">${m ? m.days : '—'}</div><div class="l">In-game days</div></div>
      <div class="stat"><div class="v">${m ? fmtUptime(m.uptime) : '—'}</div><div class="l">Uptime</div></div>
      <div class="stat"><div class="v">${m ? m.basecampnum ?? '—' : '—'}</div><div class="l">Base camps</div></div>
      <div class="stat"><div class="v">${m ? Math.round(m.serverframetime * 10) / 10 + 'ms' : '—'}</div><div class="l">Frame time</div></div>
    </div>
    <div class="card">
      <h3>Online players</h3>
      <div id="players-box"><span class="muted">Loading…</span></div>
    </div>
    <div class="card">
      <h3>Server</h3>
      <table>
        <tr><td class="muted">Name</td><td>${s.info ? esc(s.info.servername) : '—'}</td></tr>
        <tr><td class="muted">Description</td><td>${s.info ? esc(s.info.description) : '—'}</td></tr>
        <tr><td class="muted">Container</td><td class="mono">${esc(s.container.status)} / health: ${esc(s.container.health)}</td></tr>
        <tr><td class="muted">REST API</td><td class="mono">${esc(s.apiUrl)}</td></tr>
      </table>
    </div>`;
  const online = m ? m.currentplayernum : 0;
  $('#stop-server').onclick = async () => {
    const ok = await confirmModal({
      title: `Stop "${s.name}"?`,
      body: `<p>The world is saved first, then the container is stopped.${online ? ` <b>${online} player${online === 1 ? '' : 's'} online</b> will be disconnected.` : ''}</p>`,
      confirmText: 'Stop server', danger: true,
    });
    if (!ok) return;
    const btn = $('#stop-server');
    btn.disabled = true; btn.textContent = 'Stopping…';
    try {
      await api(`/servers/${s.id}/stop`, { method: 'POST', body: {} });
      toast('Server stopped', 'ok');
      await refreshServers();
      renderView();
    } catch (e) { btn.disabled = false; btn.textContent = '⏹ Stop server'; toast('Stop failed: ' + e.message, 'err'); }
  };
  $('#restart-server').onclick = async () => {
    const ok = await confirmModal({
      title: `Restart "${s.name}"?`,
      body: `<p>The world is saved first, then the server restarts.${online ? ` <b>${online} player${online === 1 ? '' : 's'} online</b> will be disconnected.` : ''}</p>
             <p class="muted" style="font-size:.78rem;margin-top:8px">For a restart with an in-game countdown warning, use the Deploy tab.</p>`,
      confirmText: 'Restart',
    });
    if (!ok) return;
    const btn = $('#restart-server');
    btn.disabled = true; btn.textContent = 'Restarting…';
    try {
      await api(`/servers/${s.id}/restart`, { method: 'POST', body: {} });
      toast('Server restarting…', 'ok');
      setTimeout(refreshServers, 5000);
    } catch (e) { btn.disabled = false; btn.textContent = '⟳ Restart'; toast('Restart failed: ' + e.message, 'err'); }
  };
  try {
    const p = await api(`/servers/${s.id}/players`);
    const players = p.players || [];
    $('#players-box').innerHTML = players.length
      ? `<table><tr><th>Name</th><th>Account</th><th>Level</th><th>Platform</th><th>Ping</th><th></th></tr>
         ${players.map((pl) => `<tr>
            <td>${esc(pl.name)}</td><td class="mono">${esc(pl.accountName || '')}</td>
            <td>${pl.level ?? ''}</td>
            <td>${esc((pl.userId || '').split('_')[0])}</td>
            <td>${pl.ping ? Math.round(pl.ping) + 'ms' : ''}</td>
            <td>
              <button class="btn small ghost" data-mod-action="kick" data-uid="${esc(pl.userId)}" data-name="${esc(pl.name)}">Kick</button>
              <button class="btn small danger" data-mod-action="ban" data-uid="${esc(pl.userId)}" data-name="${esc(pl.name)}">Ban</button>
            </td>
          </tr>`).join('')}</table>`
      : '<span class="muted">Nobody online.</span>';
    $$('#players-box [data-mod-action]').forEach((btn) => btn.onclick = async () => {
      const { modAction, uid, name } = btn.dataset;
      const ok = await confirmModal({
        title: `${modAction === 'kick' ? 'Kick' : 'Ban'} ${name}?`,
        body: `<p class="mono muted">${esc(uid)}</p>${modAction === 'ban' ? '<p>Bans are permanent until unbanned via REST/RCON.</p>' : ''}`,
        confirmText: modAction === 'kick' ? 'Kick' : 'Ban', danger: true,
      });
      if (!ok) return;
      try {
        await api(`/servers/${s.id}/players/${modAction}`, { method: 'POST', body: { userId: uid, message: `You were ${modAction}ned by an admin.` } });
        toast(`${name} ${modAction}ed`, 'ok');
        renderView();
      } catch (e) { toast(`${modAction} failed: ` + e.message, 'err'); }
    });
  } catch {
    $('#players-box').innerHTML = '<span class="muted">Player list unavailable (server offline or paused).</span>';
  }
}

// ---------------------------------------------------------------- settings
async function loadSettings(s) {
  state.settings = await api(`/servers/${s.id}/settings`);
}

async function renderSettings(v, s) {
  v.innerHTML = '<p class="muted">Loading settings…</p>';
  try { if (!state.settings) await loadSettings(s); }
  catch (e) { v.innerHTML = `<p class="muted">Failed to load settings: ${esc(e.message)}</p>`; return; }
  const data = state.settings;

  const driftHtml = data.drift && data.drift.length ? `
    <div class="drift-banner">
      ⚠️ <b>Config drift:</b> the running container differs from the compose file for
      ${data.drift.map((d) => `<span class="mono">${esc(d.env)}</span> (running: <b>${esc(String(d.running))}</b>, compose: ${esc(String(d.compose))})`).join(', ')}.
      A deploy from the compose file would change these live values.
      <button class="btn small" id="adopt-drift">Adopt running values into compose</button>
    </div>` : '';

  const warnHtml = (data.warnings || []).map((w) => `<div class="drift-banner">⚠️ ${esc(w)}</div>`).join('');

  v.innerHTML = `
    ${warnHtml}
    ${driftHtml}
    <div class="settings-toolbar">
      <input type="search" id="set-search" placeholder="Search settings… (name, env var, description)">
      <button class="chip active" data-cat="*">All</button>
      ${data.categories.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div id="settings-list"></div>`;

  let filter = { q: '', cat: '*' };
  const renderList = () => {
    const q = filter.q.toLowerCase();
    const groups = {};
    for (const set of data.settings) {
      if (filter.cat !== '*' && set.category !== filter.cat) continue;
      if (q && !(set.env.toLowerCase().includes(q) || (set.iniKey || '').toLowerCase().includes(q) || (set.description || '').toLowerCase().includes(q))) continue;
      (groups[set.category] ??= []).push(set);
    }
    $('#settings-list').innerHTML = Object.entries(groups).map(([cat, sets]) => `
      <div class="cat-block">
        <div class="cat-head">${esc(cat)}</div>
        ${sets.map(settingRow).join('')}
      </div>`).join('') || '<p class="muted">No settings match.</p>';
    bindSettingRows();
  };

  $('#set-search').oninput = (e) => { filter.q = e.target.value; renderList(); };
  $$('.chip', v).forEach((c) => c.onclick = () => {
    filter.cat = c.dataset.cat;
    $$('.chip', v).forEach((x) => x.classList.toggle('active', x === c));
    renderList();
  });
  const adopt = $('#adopt-drift');
  if (adopt) adopt.onclick = () => {
    for (const d of state.settings.drift) state.pending[d.env] = d.running;
    updatePendingUI();
    renderView();
    toast(`${state.settings.drift.length} running value(s) staged — review in Deploy tab`, 'ok');
  };
  renderList();
}

function displayVal(set) {
  if (set.env in state.pending) return state.pending[set.env] === null ? set.default : state.pending[set.env];
  return set.effective;
}

function settingRow(set) {
  const val = displayVal(set);
  const changed = set.env in state.pending;
  const isPinned = set.pinned !== undefined;
  let ctrl = '';
  if (set.type === 'boolean') {
    ctrl = `<label class="toggle"><input type="checkbox" data-env="${set.env}" ${val === true || val === 'true' ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>`;
  } else if (set.type === 'enum') {
    ctrl = `<select data-env="${set.env}">${set.enum.map((o) => `<option ${String(val) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (set.type === 'integer' || set.type === 'number') {
    const hasRange = set.min !== undefined && set.max !== undefined;
    ctrl = `
      ${hasRange ? `<input type="range" data-env="${set.env}" min="${set.min}" max="${set.max}" step="${set.step ?? 1}" value="${val}">` : ''}
      <input type="number" data-env="${set.env}" value="${val}" ${set.min !== undefined ? `min="${set.min}"` : ''} ${set.max !== undefined ? `max="${set.max}"` : ''} step="${set.step ?? 'any'}">
      ${hasRange ? `<span class="range-hint">${set.min}–${set.max}</span>` : ''}`;
  } else {
    ctrl = `<input type="text" data-env="${set.env}" value="${esc(val ?? '')}" ${set.sensitive ? 'placeholder="(hidden)"' : ''}>`;
  }
  return `
    <div class="setting ${changed ? 'changed' : ''} ${isPinned ? 'pinned-row' : ''}" data-row="${set.env}">
      <div class="info">
        <span class="name">${esc(set.iniKey || set.env)}</span><span class="env-name">${esc(set.env)}</span>
        <div class="desc">${esc(set.description || '')}</div>
        <div class="flags">
          <span class="flag">default: ${esc(String(set.default))}</span>
          ${isPinned ? '<span class="flag pinned">pinned in compose</span>' : ''}
          ${set.drift ? `<span class="flag drift">running: ${esc(String(set.running ?? 'default'))}</span>` : ''}
          ${changed ? '<span class="flag drift">pending change</span>' : ''}
        </div>
      </div>
      <div class="ctrl">${ctrl}
        <button class="reset-btn" title="Reset to image default" data-reset="${set.env}">↺</button>
      </div>
    </div>`;
}

function bindSettingRows() {
  $$('#settings-list [data-env]').forEach((el) => {
    const env = el.dataset.env;
    const set = state.settings.settings.find((x) => x.env === env);
    const handler = () => {
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else value = el.value;
      // sync twin range/number inputs
      $$(`#settings-list [data-env="${env}"]`).forEach((twin) => {
        if (twin !== el && twin.type !== 'checkbox') twin.value = el.value;
      });
      if (set.type === 'integer' || set.type === 'number') {
        const n = Number(value);
        const bad = !Number.isFinite(n) || (set.min !== undefined && n < set.min) || (set.max !== undefined && n > set.max);
        el.classList.toggle('invalid', bad);
        if (bad) return;
        value = n;
      }
      const effective = set.effective;
      if (String(value) === String(effective)) delete state.pending[env];
      else state.pending[env] = value;
      const row = $(`[data-row="${env}"]`);
      row.classList.toggle('changed', env in state.pending);
      updatePendingUI();
    };
    el.addEventListener(el.type === 'range' ? 'input' : 'change', handler);
    if (el.type === 'range') el.addEventListener('change', handler);
  });
  $$('#settings-list [data-reset]').forEach((btn) => btn.onclick = () => {
    const env = btn.dataset.reset;
    const set = state.settings.settings.find((x) => x.env === env);
    if (set.pinned !== undefined) state.pending[env] = null; // remove from compose -> default
    else delete state.pending[env];
    updatePendingUI();
    renderView();
  });
}

function updatePendingUI() {
  const n = Object.keys(state.pending).length;
  const m = currentServer()?.pendingModChanges || 0;
  const total = n + m;
  const pill = $('#pending-pill');
  pill.textContent = total;
  pill.classList.toggle('hidden', total === 0);
  let bar = $('#pending-bar');
  if (total === 0) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pending-bar';
    document.body.appendChild(bar);
  }
  const parts = [];
  if (n) parts.push(`<b>${n}</b> setting change${n === 1 ? '' : 's'}`);
  if (m) parts.push(`<b>${m}</b> mod change${m === 1 ? '' : 's'}`);
  bar.innerHTML = `
    <div class="grow">${parts.join(' + ')} awaiting a server restart</div>
    ${n ? '<button class="btn ghost" id="discard-pending">Discard settings</button>' : ''}
    <button class="btn primary" id="review-pending">Review &amp; Deploy</button>`;
  const d = $('#discard-pending');
  if (d) d.onclick = () => { state.pending = {}; updatePendingUI(); renderView(); };
  $('#review-pending').onclick = () => { state.tab = 'deploy'; $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'deploy')); renderView(); };
}

// ---------------------------------------------------------------- announce
async function renderAnnounce(v, s) {
  v.innerHTML = `
    <div class="card">
      <h3>Send announcement</h3>
      <textarea id="ann-text" placeholder="Message shown in-game to all players…"></textarea>
      <div class="canned-list" id="ann-canned"></div>
      <button class="btn primary" id="ann-send">📢 Send announcement</button>
      <button class="btn ghost small" id="ann-edit-canned">Edit canned messages</button>
    </div>
    <div class="card">
      <h3>History</h3>
      <div id="ann-history" class="muted">Loading…</div>
    </div>`;
  $('#ann-canned').innerHTML = state.canned.announcements.map((m, i) =>
    `<button class="canned" data-i="${i}">${esc(m)}</button>`).join('') || '<span class="muted">No canned messages.</span>';
  $$('#ann-canned .canned').forEach((b) => b.onclick = () => { $('#ann-text').value = state.canned.announcements[b.dataset.i]; });
  $('#ann-send').onclick = async () => {
    const message = $('#ann-text').value.trim();
    if (!message) return toast('Enter a message first', 'err');
    try {
      await api(`/servers/${s.id}/announce`, { method: 'POST', body: { message } });
      toast('Announcement sent', 'ok');
      $('#ann-text').value = '';
      loadAnnHistory(s);
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  };
  $('#ann-edit-canned').onclick = editCannedModal;
  loadAnnHistory(s);
}

async function loadAnnHistory(s) {
  try {
    const h = await api(`/servers/${s.id}/announcements`);
    $('#ann-history').innerHTML = h.length
      ? h.map((x) => `<div class="history-item"><div class="ts">${new Date(x.ts).toLocaleString()}</div>${esc(x.message)}</div>`).join('')
      : 'No announcements sent yet.';
  } catch { /* view switched */ }
}

function editCannedModal() {
  const c = state.canned;
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-back">
      <div class="modal">
        <h3>Canned messages</h3>
        <p class="muted" style="margin-bottom:10px">One message per line. <span class="mono">{time}</span> is replaced with the countdown in reboot messages.</p>
        <div class="field"><label>Announcements</label><textarea id="cm-a">${esc(c.announcements.join('\n'))}</textarea></div>
        <div class="field"><label>Reboot countdown</label><textarea id="cm-r">${esc(c.rebootCountdown.join('\n'))}</textarea></div>
        <div class="field"><label>Reboot complete</label><textarea id="cm-c">${esc(c.rebootComplete.join('\n'))}</textarea></div>
        <div class="actions">
          <button class="btn ghost" id="cm-cancel">Cancel</button>
          <button class="btn primary" id="cm-save">Save</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  $('#cm-cancel').onclick = close;
  root.firstElementChild.onclick = (e) => { if (e.target.classList.contains('modal-back')) close(); };
  $('#cm-save').onclick = async () => {
    const lines = (id) => $(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    const next = { announcements: lines('#cm-a'), rebootCountdown: lines('#cm-r'), rebootComplete: lines('#cm-c') };
    try {
      await api('/canned-messages', { method: 'PUT', body: next });
      state.canned = next;
      close();
      toast('Canned messages saved', 'ok');
      renderView();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  };
}

// ---------------------------------------------------------------- deploy
function renderDeploy(v, s) {
  const pend = Object.entries(state.pending);
  const sets = state.settings?.settings || [];
  const findSet = (env) => sets.find((x) => x.env === env);
  const running = s.container.status === 'running';
  const fresh = s.container.status === 'missing';
  const optionsCard = running ? `
        <div class="card">
          <h3>Restart options</h3>
          <div class="field">
            <label>Countdown before restart</label>
            <select id="dp-countdown">
              <option value="0">No countdown — restart immediately</option>
              <option value="30">30 seconds</option>
              <option value="60" selected>1 minute</option>
              <option value="120">2 minutes</option>
              <option value="300">5 minutes</option>
              <option value="600">10 minutes</option>
            </select>
          </div>
          <div class="field">
            <label>Countdown announcement (<span class="mono">{time}</span> = time left)</label>
            <select id="dp-msg-canned">${state.canned.rebootCountdown.map((m) => `<option>${esc(m)}</option>`).join('')}<option value="__custom">Custom…</option></select>
            <input type="text" id="dp-msg" class="hidden" style="margin-top:8px" placeholder="Custom countdown message">
          </div>
          <div class="field">
            <label>Completion announcement (sent when back online)</label>
            <select id="dp-done-msg"><option value="">— none —</option>${state.canned.rebootComplete.map((m) => `<option>${esc(m)}</option>`).join('')}</select>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary" id="dp-go">🚀 ${pend.length ? 'Apply settings & restart' : 'Announced restart'}</button>
            ${pend.length ? '<button class="btn" id="dp-write-only">Write to compose only (no restart)</button>' : ''}
          </div>
          <p class="muted" style="margin-top:10px;font-size:.78rem">
            Pipeline: announce countdown → save world → update compose → recreate container → wait for online → validate settings live.
          </p>
        </div>` : `
        <div class="card">
          <h3>${fresh ? 'Launch options' : 'Start options'}</h3>
          <p class="muted" style="margin-bottom:14px;font-size:.85rem">
            The server is ${fresh ? 'not launched yet' : 'stopped'} — no countdown or announcements needed.
            ${pend.length ? 'Your pending settings are written to the compose file first.' : ''}
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary" id="dp-go">${pend.length ? '🚀 Save settings & start server' : fresh ? '🚀 Launch server' : '▶ Start server'}</button>
            ${pend.length ? '<button class="btn" id="dp-write-only">Save config only (don’t start)</button>' : ''}
          </div>
          <p class="muted" style="margin-top:10px;font-size:.78rem">
            Pipeline: update compose → start container → wait for online → validate settings live.
            ${fresh ? 'First boot downloads the game server (~6 GB) and can take several minutes.' : ''}
          </p>
        </div>`;
  v.innerHTML = `
    <div class="deploy-cols">
      <div>
        <div class="card">
          <h3>Pending changes</h3>
          ${pend.length ? `<table>
            <tr><th>Setting</th><th>Current</th><th>New</th></tr>
            ${pend.map(([env, val]) => {
              const set = findSet(env) || { effective: '?', iniKey: env };
              return `<tr>
                <td><span class="mono">${esc(env)}</span></td>
                <td class="diff-val"><span class="diff-old">${esc(String(set.effective))}</span></td>
                <td class="diff-val"><span class="diff-new">${val === null ? 'image default (' + esc(String(set.default)) + ')' : esc(String(val))}</span></td>
              </tr>`;
            }).join('')}</table>`
          : '<p class="muted">No pending setting changes.</p>'}
        </div>
        <div class="card">
          <h3>Mod changes awaiting restart</h3>
          <div id="dp-mods-pending" class="muted">Loading…</div>
        </div>
        ${optionsCard}
      </div>
      <div>
        <div class="card">
          <h3>Deploy progress</h3>
          <div id="job-box">${state.job ? '' : '<p class="muted">No deploy running.</p>'}</div>
        </div>
        <div class="card">
          <h3>Recent deploys</h3>
          <div id="dp-history" class="muted">Loading…</div>
        </div>
      </div>
    </div>`;

  const canned = $('#dp-msg-canned');
  if (canned) canned.onchange = (e) => $('#dp-msg').classList.toggle('hidden', e.target.value !== '__custom');

  api(`/servers/${s.id}/mods-pending`).then((changes) => {
    const el = $('#dp-mods-pending');
    if (!el) return;
    el.innerHTML = changes.length
      ? `<table><tr><th>Action</th><th>Mod</th><th>Kind</th><th>When</th></tr>
        ${changes.map((c) => `<tr>
          <td>${c.action === 'install' ? '<span class="val-ok">+ install</span>' : '<span class="val-bad">− remove</span>'}</td>
          <td>${esc(c.title)}</td>
          <td>${esc(c.kind || '')}</td>
          <td class="muted">${new Date(c.ts).toLocaleTimeString()}</td>
        </tr>`).join('')}</table>
        <p class="muted" style="font-size:.75rem;margin-top:8px">Staged on disk — they load when the server restarts.</p>`
      : 'None — the running server matches the installed mod set.';
  }).catch(() => {});

  $('#dp-go').onclick = async () => {
    const countdownSeconds = running ? parseInt($('#dp-countdown').value, 10) : 0;
    const sel = running ? $('#dp-msg-canned').value : '';
    const message = sel === '__custom' ? $('#dp-msg').value.trim() : sel;
    const completeMessage = running ? ($('#dp-done-msg').value || null) : null;
    const n = pend.length;
    const playerCount = currentServer()?.metrics?.currentplayernum ?? '?';
    const ok = await confirmModal({
      title: running
        ? (n ? `Apply ${n} change(s) and restart?` : 'Restart server?')
        : (n ? `Save ${n} change(s) and start the server?` : 'Start the server?'),
      body: running
        ? `<p><b>${playerCount}</b> player(s) currently online. The server will restart after
             ${countdownSeconds ? 'a <b>' + countdownSeconds + 's</b> announced countdown' : '<b>no countdown</b>'}.
             World is saved before restart.</p>`
        : `<p>${n ? 'Your pending settings are written to the compose file, then the server starts with them.' : 'The server starts with the current compose configuration.'}</p>`,
      confirmText: running ? (n ? 'Apply & restart' : 'Restart') : (n ? 'Save & start' : 'Start'),
      danger: running,
    });
    if (!ok) return;
    try {
      const job = await api(`/servers/${s.id}/deploy`, {
        method: 'POST',
        body: { updates: state.pending, countdownSeconds, message, completeMessage, reboot: true },
      });
      state.pending = {};
      state.settings = null;
      updatePendingUI();
      watchJob(job.id, s);
    } catch (e) { toast('Deploy failed to start: ' + e.message, 'err'); }
  };

  const writeOnly = $('#dp-write-only');
  if (writeOnly) writeOnly.onclick = async () => {
    const ok = await confirmModal({
      title: running ? 'Write settings to compose without restart?' : 'Save settings without starting?',
      body: running
        ? '<p>The compose file is updated and backed up, but the running server keeps its current settings until the next restart.</p>'
        : '<p>The compose file is updated and backed up. The server stays stopped — it picks the settings up when you start it.</p>',
      confirmText: running ? 'Write compose' : 'Save config',
    });
    if (!ok) return;
    try {
      const job = await api(`/servers/${s.id}/deploy`, { method: 'POST', body: { updates: state.pending, reboot: false } });
      state.pending = {};
      state.settings = null;
      updatePendingUI();
      watchJob(job.id, s);
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  };

  if (state.job) drawJob(state.job);
  loadDeployHistory(s);
}

async function loadDeployHistory(s) {
  try {
    const h = await api(`/servers/${s.id}/deploy-history`);
    const el = $('#dp-history');
    if (!el) return;
    el.innerHTML = h.length ? h.slice(0, 8).map((x) => `
      <div class="history-item">
        <div class="ts">${new Date(x.ts).toLocaleString()} — ${esc(x.kind)}</div>
        <span class="${x.status === 'succeeded' ? 'val-ok' : 'val-bad'}">${esc(x.status)}</span>
        ${x.updates?.length ? `<span class="muted"> · ${x.updates.map(esc).join(', ')}</span>` : ''}
        ${x.error ? `<div class="val-bad">${esc(x.error)}</div>` : ''}
      </div>`).join('') : 'No deploys yet.';
  } catch { /* ignore */ }
}

function watchJob(id, s) {
  clearInterval(state.jobTimer);
  const poll = async () => {
    try {
      const job = await api(`/jobs/${id}`);
      state.job = job;
      if (state.tab === 'deploy') drawJob(job);
      if (job.status !== 'running') {
        clearInterval(state.jobTimer);
        state.jobTimer = null;
        toast(job.status === 'succeeded' ? 'Deploy finished ✔' : 'Deploy failed: ' + (job.error || ''), job.status === 'succeeded' ? 'ok' : 'err');
        refreshServers();
        if (state.tab === 'deploy') loadDeployHistory(s);
      }
    } catch { /* transient */ }
  };
  state.jobTimer = setInterval(poll, 1500);
  poll();
}

function drawJob(job) {
  const box = $('#job-box');
  if (!box) return;
  const icon = (st) => st === 'ok' ? '<span class="val-ok">✔</span>'
    : st === 'warn' ? '<span style="color:var(--amber)">⚠</span>'
    : st === 'failed' ? '<span class="val-bad">✖</span>'
    : '<span class="spin"></span>';
  box.innerHTML = `
    <div class="muted" style="margin-bottom:8px">
      ${esc(job.kind)} · started ${new Date(job.startedAt).toLocaleTimeString()} ·
      <b class="${job.status === 'succeeded' ? 'val-ok' : job.status === 'failed' ? 'val-bad' : ''}">${esc(job.status)}</b>
    </div>
    ${job.steps.map((st) => `
      <div class="step">
        <div class="step-icon">${icon(st.status)}</div>
        <div><div>${esc(st.name)}</div>${st.detail ? `<div class="detail">${esc(st.detail)}</div>` : ''}</div>
      </div>`).join('')}
    ${job.validation ? `
      <h3 style="margin-top:14px">Validation</h3>
      <table><tr><th>Setting</th><th>Expected</th><th>Live</th><th></th></tr>
      ${job.validation.map((r) => `<tr>
        <td class="mono">${esc(r.iniKey)}</td>
        <td class="diff-val">${esc(String(r.expected))}</td>
        <td class="diff-val">${esc(String(r.actual))}</td>
        <td>${r.ok === true ? '<span class="val-ok">✔ match</span>' : r.ok === false ? '<span class="val-bad">✖ mismatch</span>' : `<span class="val-na">${esc(r.note || 'n/a')}</span>`}</td>
      </tr>`).join('')}</table>` : ''}`;
}

// ---------------------------------------------------------------- mods
const modState = { q: '', sort: 'trend', page: 1, compat: 'pak', results: null, loading: false, forServer: null };

function fmtBytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

async function renderMods(v, s) {
  v.innerHTML = `
    <div class="drift-banner" id="mods-platform-banner">
      ℹ️ <b>Linux server mod support:</b> only <b>pak-format</b> mods work on this server.
      Palworld's official Workshop mod system (UE4SS / Lua / PalSchema types) is Windows-only —
      installs are checked and rejected if they contain no pak files. Mods load from
      <span class="mono">Pal/Content/Paks/~mods</span> and take effect after a server restart.
    </div>
    <div class="card">
      <h3>Accounts for mod deployment</h3>
      <div class="deploy-cols">
        <div>
          <h4 style="font-size:.85rem;margin-bottom:8px">🎮 Steam <span id="steam-status" class="muted" style="font-weight:400"></span></h4>
          <p class="muted" style="font-size:.76rem;margin-bottom:10px">
            One-click Workshop installs download through the game container and need a Steam account that
            <b>owns Palworld</b> (Steam doesn't allow anonymous Workshop downloads).
            <b>Easiest: QR sign-in</b> — press the QR button, scan the code with the <b>Steam mobile app</b>
            (Shield icon / <i>Confirm sign in</i> → scan), approve, done. No password ever entered here.
            Or use username + password: if Steam Guard asks for a mobile confirmation, <b>approve it on your phone while this page waits</b>;
            if it asks for a code, a code field appears. Credentials/token stay in the manager's data volume on this host.
          </p>
          <div id="steam-form">
            <button class="btn primary" id="steam-qr-btn" style="margin-bottom:10px">📱 Sign in with Steam app (QR code)</button>
            <div id="steam-qr-box" class="hidden" style="margin-bottom:12px">
              <div id="steam-qr-hint" class="muted" style="font-size:.78rem;margin-bottom:8px"></div>
              <pre id="steam-qr" class="qr-pre"></pre>
            </div>
            <details>
              <summary class="muted" style="cursor:pointer;font-size:.8rem;margin-bottom:8px">…or sign in with username &amp; password</summary>
              <div class="field"><label>Steam username</label><input type="text" id="steam-user" autocomplete="off"></div>
              <div class="field"><label>Password</label><input type="password" id="steam-pass" autocomplete="new-password" style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 12px;outline:none"></div>
              <div class="field hidden" id="steam-guard-field"><label>Steam Guard code (from email / mobile authenticator)</label><input type="text" id="steam-guard" autocomplete="off" placeholder="e.g. J2K7P"></div>
              <div style="display:flex;gap:8px;align-items:center">
                <button class="btn" id="steam-login">Sign in</button>
                <span id="steam-login-hint" class="muted hidden" style="font-size:.75rem">Waiting for Steam — if a confirmation pops up in your Steam mobile app, approve it now (up to ~1 min)…</span>
              </div>
            </details>
            <button class="btn ghost hidden" id="steam-logout" style="margin-top:8px">Sign out</button>
          </div>
        </div>
        <div>
          <h4 style="font-size:.85rem;margin-bottom:8px">🧩 Nexus Mods <span id="nexus-status" class="muted" style="font-weight:400"></span></h4>
          <p class="muted" style="font-size:.76rem;margin-bottom:10px">
            <b>How to get your personal API key:</b> log in at nexusmods.com → avatar → <i>Settings</i> → <i>API keys</i>
            (<a href="https://www.nexusmods.com/settings/api-keys" target="_blank">direct link ↗</a>) → copy the <i>Personal API Key</i> and paste it below.
            The key unlocks Nexus browsing here; <b>one-click installs additionally require Nexus Premium</b>
            (their API only issues download links to Premium accounts) — without Premium, download in your browser and use the upload installer.
          </p>
          <div class="field"><label>Personal API key</label><input type="text" id="nexus-key" autocomplete="off" placeholder="paste key…"></div>
          <div style="display:flex;gap:8px">
            <button class="btn primary" id="nexus-save">Validate &amp; save</button>
            <button class="btn ghost hidden" id="nexus-remove">Remove key</button>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>Installed mods</h3>
      <div id="mods-installed" class="muted">Loading…</div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="file" id="mod-upload-file" accept=".pak,.utoc,.ucas" multiple style="display:none">
        <button class="btn" id="mod-upload-btn">⬆ Upload .pak mod</button>
        <span class="muted" style="font-size:.75rem">Manual install: download any mod in your browser, then upload its .pak (+ .utoc/.ucas) files here.</span>
      </div>
    </div>
    <div class="card" id="nexus-browse-card">
      <h3>Nexus Mods</h3>
      <div class="settings-toolbar">
        <select id="nexus-feed" class="chip">
          <option value="trending">Trending</option>
          <option value="latest">Latest added</option>
          <option value="updated">Recently updated</option>
        </select>
        <a class="btn ghost small" href="https://www.nexusmods.com/games/palworld" target="_blank">Open Nexus ↗</a>
      </div>
      <div id="nexus-results" class="muted"></div>
    </div>
    <div class="card">
      <h3>Steam Workshop</h3>
      <div class="settings-toolbar">
        <input type="search" id="mod-search" placeholder="Search Palworld Workshop…" value="${esc(modState.q)}">
        <select id="mod-sort" class="chip">
          <option value="trend" ${modState.sort === 'trend' ? 'selected' : ''}>Trending</option>
          <option value="mostrecent" ${modState.sort === 'mostrecent' ? 'selected' : ''}>Most recent</option>
          <option value="lastupdated" ${modState.sort === 'lastupdated' ? 'selected' : ''}>Last updated</option>
          <option value="subscribers" ${modState.sort === 'subscribers' ? 'selected' : ''}>Most subscribed</option>
        </select>
        <button class="btn" id="mod-go">Search</button>
      </div>
      <div class="settings-toolbar" id="compat-chips" style="margin-top:-6px">
        <button class="chip ${modState.compat === 'pak' ? 'active' : ''}" data-compat="pak">🐧 Linux-compatible (pak)</button>
        <button class="chip ${modState.compat === 'unknown' ? 'active' : ''}" data-compat="unknown">❔ Untagged (verified at install)</button>
        <button class="chip ${modState.compat === 'windows' ? 'active' : ''}" data-compat="windows">🪟 Windows-only types</button>
        <button class="chip ${modState.compat === 'all' ? 'active' : ''}" data-compat="all">All</button>
        <span class="muted" id="compat-counts" style="font-size:.72rem"></span>
      </div>
      <div id="mods-creds-note"></div>
      <div id="mods-results" class="muted">Loading…</div>
      <div class="pager">
        <button class="btn small" id="mod-prev">← Prev</button>
        <span class="muted" id="mod-page">page ${modState.page}</span>
        <button class="btn small" id="mod-next">Next →</button>
      </div>
    </div>`;

  const doSearch = async (page = 1) => {
    modState.page = page;
    modState.q = $('#mod-search').value.trim();
    modState.sort = $('#mod-sort').value;
    $('#mods-results').innerHTML = '<span class="muted">Searching Workshop…</span>';
    $('#mod-page').textContent = `page ${page}`;
    try {
      modState.results = await api(`/mods/search?q=${encodeURIComponent(modState.q)}&sort=${modState.sort}&page=${page}&compat=${modState.compat}`);
      const c = modState.results.counts;
      const cc = $('#compat-counts');
      if (cc && c) cc.textContent = `this page: ${c.pak} pak · ${c.unknown} untagged · ${c.windows} windows-only`;
      drawModResults(s);
    } catch (e) { $('#mods-results').innerHTML = `<span class="val-bad">Workshop search failed: ${esc(e.message)}</span>`; }
  };
  $$('#compat-chips [data-compat]').forEach((ch) => ch.onclick = () => {
    modState.compat = ch.dataset.compat;
    $$('#compat-chips [data-compat]').forEach((x) => x.classList.toggle('active', x === ch));
    doSearch(1);
  });
  $('#mod-go').onclick = () => doSearch(1);
  $('#mod-search').onkeydown = (e) => { if (e.key === 'Enter') doSearch(1); };
  $('#mod-sort').onchange = () => doSearch(1);
  $('#mod-prev').onclick = () => modState.page > 1 && doSearch(modState.page - 1);
  $('#mod-next').onclick = () => doSearch(modState.page + 1);

  $('#mod-upload-btn').onclick = () => $('#mod-upload-file').click();
  $('#mod-upload-file').onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const modName = files.length > 1 ? files[0].name.replace(/\.(pak|utoc|ucas)$/i, '') : null;
    for (const f of files) {
      toast(`Uploading ${f.name}…`);
      try {
        const res = await fetch(`/api/servers/${s.id}/mods/upload?filename=${encodeURIComponent(f.name)}${modName ? '&modName=' + encodeURIComponent(modName) : ''}`, {
          method: 'POST', body: f,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.status);
        toast(`${f.name} installed — review & deploy to activate`, 'ok');
      } catch (err) { toast(`Upload failed: ${err.message}`, 'err'); }
    }
    loadInstalledMods(s);
  };

  // ---- account forms ----
  const refreshAccounts = async () => {
    try {
      const acc = await api(`/servers/${s.id}/accounts`);
      state.accounts = acc;
      const st = $('#steam-status');
      if (st) st.innerHTML = acc.steam
        ? `— <span class="val-ok">signed in as <b>${esc(acc.steam.username)}</b> ✔</span>`
        : '— <span class="muted">not signed in</span>';
      $('#steam-logout')?.classList.toggle('hidden', !acc.steam);
      if (acc.steam && $('#steam-user') && !$('#steam-user').value) $('#steam-user').value = acc.steam.username;
      const nx = $('#nexus-status');
      if (nx) nx.innerHTML = acc.nexus
        ? `— <span class="val-ok">key valid for <b>${esc(acc.nexus.name || '?')}</b>${acc.nexus.premium ? ' (Premium ✔)' : ' (free — installs need Premium)'}</span>`
        : '— <span class="muted">no key</span>';
      $('#nexus-remove')?.classList.toggle('hidden', !acc.nexus);
      $('#nexus-browse-card')?.classList.toggle('hidden', !acc.nexus);
      if (acc.nexus) loadNexus(s);
    } catch { /* tab switched */ }
  };

  // --- QR sign-in flow ---
  let qrPoll = null;
  $('#steam-qr-btn').onclick = async () => {
    clearInterval(qrPoll);
    const btn = $('#steam-qr-btn');
    btn.disabled = true;
    $('#steam-qr-box').classList.remove('hidden');
    $('#steam-qr').textContent = '';
    $('#steam-qr-hint').textContent = 'Generating QR code…';
    try {
      const { id } = await api(`/servers/${s.id}/accounts/steam/qr`, { method: 'POST', body: {} });
      qrPoll = setInterval(async () => {
        try {
          const st = await api(`/servers/${s.id}/accounts/steam/qr/${id}`);
          if (st.qr && !$('#steam-qr').textContent) $('#steam-qr').textContent = st.qr;
          if (st.status === 'waiting') $('#steam-qr-hint').innerHTML = '<b>Scan with the Steam mobile app</b> (Guard/Shield icon → scan QR) and approve the sign-in. Waiting…';
          if (st.status === 'success') {
            clearInterval(qrPoll); btn.disabled = false;
            $('#steam-qr-box').classList.add('hidden');
            toast(`Signed in to Steam as ${st.username} ✔`, 'ok');
            refreshAccounts(); loadInstalledMods(s);
          } else if (st.status === 'failed' || st.status === 'expired' || st.status === 'unknown') {
            clearInterval(qrPoll); btn.disabled = false;
            $('#steam-qr-hint').innerHTML = `<span class="val-bad">${esc(st.error || 'Session ended — try again.')}</span>`;
            $('#steam-qr').textContent = '';
          }
        } catch { /* transient */ }
      }, 2000);
    } catch (e) {
      btn.disabled = false;
      $('#steam-qr-hint').innerHTML = `<span class="val-bad">${esc(e.message)}</span>`;
    }
  };

  $('#steam-login').onclick = async () => {
    const username = $('#steam-user').value.trim();
    const password = $('#steam-pass').value;
    const guardCode = $('#steam-guard').value.trim() || undefined;
    if (!username || !password) return toast('Enter Steam username and password', 'err');
    const btn = $('#steam-login');
    btn.disabled = true; btn.textContent = 'Verifying with Steam…';
    $('#steam-login-hint').classList.remove('hidden');
    try {
      const r = await api(`/servers/${s.id}/accounts/steam`, { method: 'POST', body: { username, password, guardCode } });
      toast(`Steam sign-in verified for ${username}`, 'ok');
      $('#steam-pass').value = ''; $('#steam-guard').value = '';
      $('#steam-guard-field').classList.add('hidden');
      refreshAccounts(); loadInstalledMods(s);
    } catch (e) {
      if (/Steam Guard/i.test(e.message)) $('#steam-guard-field').classList.remove('hidden');
      toast(e.message, 'err');
    }
    btn.disabled = false; btn.textContent = 'Sign in';
    $('#steam-login-hint').classList.add('hidden');
  };
  $('#steam-logout').onclick = async () => {
    await api(`/servers/${s.id}/accounts/steam`, { method: 'DELETE' });
    toast('Steam credentials removed', 'ok');
    $('#steam-user').value = '';
    refreshAccounts(); loadInstalledMods(s);
  };
  $('#nexus-save').onclick = async () => {
    const apiKey = $('#nexus-key').value.trim();
    if (!apiKey) return toast('Paste your Nexus personal API key first', 'err');
    const btn = $('#nexus-save');
    btn.disabled = true; btn.textContent = 'Validating…';
    try {
      const r = await api(`/servers/${s.id}/accounts/nexus`, { method: 'POST', body: { apiKey } });
      toast(`Nexus key valid — ${r.name}${r.premium ? ' (Premium)' : ''}`, 'ok');
      $('#nexus-key').value = '';
      refreshAccounts();
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false; btn.textContent = 'Validate & save';
  };
  $('#nexus-remove').onclick = async () => {
    await api(`/servers/${s.id}/accounts/nexus`, { method: 'DELETE' });
    toast('Nexus key removed', 'ok');
    refreshAccounts();
  };
  $('#nexus-feed').onchange = () => loadNexus(s);
  $('#nexus-browse-card').classList.add('hidden');

  refreshAccounts();
  if (modState.forServer !== s.id) { modState.forServer = s.id; modState.results = null; modState.compat = 'pak'; }
  await loadInstalledMods(s);
  if (modState.results) drawModResults(s); else doSearch(1);
}

async function loadNexus(s) {
  const el = $('#nexus-results');
  if (!el) return;
  el.innerHTML = '<span class="muted">Loading Nexus feed…</span>';
  try {
    const feed = $('#nexus-feed').value;
    const data = await api(`/servers/${s.id}/nexus/browse?feed=${feed}`);
    const premium = state.accounts?.nexus?.premium;
    const items = data.items.filter((m) => !m.adult);
    el.innerHTML = items.length ? `<div class="mod-grid">
      ${items.map((m) => `
        <div class="mod-card">
          ${m.preview ? `<img src="${esc(m.preview)}" loading="lazy" alt="">` : '<img alt="">'}
          <div class="body">
            <div class="title">${esc(m.title)}</div>
            <div class="stats">
              <span>by ${esc(m.author || '?')}</span>
              ${m.version ? `<span>v${esc(m.version)}</span>` : ''}
              ${m.endorsements != null ? `<span>👍 ${m.endorsements}</span>` : ''}
            </div>
            <div class="actions">
              <a class="btn small ghost" href="${esc(m.url)}" target="_blank">Nexus ↗</a>
              <button class="btn small ${premium ? 'primary' : ''}" data-nexus-install="${m.id}" data-title="${esc(m.title)}"
                ${premium ? '' : 'title="One-click install requires Nexus Premium — download in browser and upload instead"'}>Install</button>
            </div>
          </div>
        </div>`).join('')}
    </div>` : '<span class="muted">No mods in this feed.</span>';
    $$('#nexus-results [data-nexus-install]').forEach((b) => b.onclick = async () => {
      const ok = await confirmModal({
        title: `Install "${b.dataset.title}" from Nexus?`,
        body: `<p>Downloads the mod's main file via the Nexus API into the game container and installs any pak files to <span class="mono">~mods</span>. Takes effect after restart.</p>
               ${premium ? '' : '<p><b>Your Nexus account is not Premium — this will fail.</b></p>'}`,
        confirmText: 'Install',
      });
      if (!ok) return;
      b.disabled = true; b.textContent = 'Installing…';
      try {
        const r = await api(`/servers/${s.id}/nexus/install`, { method: 'POST', body: { id: b.dataset.nexusInstall } });
        toast(`Installed ${(r.files || [r.installed]).join(', ')} — review & deploy to activate`, 'ok');
        loadInstalledMods(s);
        refreshServers();
      } catch (e) { toast('Install failed: ' + e.message, 'err'); }
      b.disabled = false; b.textContent = 'Install';
    });
  } catch (e) { el.innerHTML = `<span class="val-bad">${esc(e.message)}</span>`; }
}

// ---------------------------------------------------------------- mod config editor
// JSON configs render as a generated form (toggles / number / text inputs,
// nested objects as sections); anything else gets a raw text editor.
function modConfigEditor(s, dir, kind, title) {
  const apiBase = `/servers/${s.id}/mods/${encodeURIComponent(dir)}`;
  const root = $('#modal-root');
  let currentFile = null, jsonMode = false;

  const isScalar = (v) => v === null || ['boolean', 'number', 'string'].includes(typeof v);
  const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function formHtml(obj, path = []) {
    return Object.entries(obj).map(([k, v]) => {
      const p = esc(JSON.stringify([...path, k]));
      if (typeof v === 'boolean') return `
        <div class="setting" style="padding:8px 12px;margin-bottom:4px">
          <div class="info"><div class="name" style="font-size:.82rem">${esc(k)}</div></div>
          <div class="ctrl"><label class="toggle"><input type="checkbox" data-cfg-path="${p}" ${v ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>
        </div>`;
      if (typeof v === 'number') return `
        <div class="setting" style="padding:8px 12px;margin-bottom:4px">
          <div class="info"><div class="name" style="font-size:.82rem">${esc(k)}</div></div>
          <div class="ctrl"><input type="number" step="any" data-cfg-path="${p}" value="${v}"></div>
        </div>`;
      if (typeof v === 'string' || v === null) return `
        <div class="setting" style="padding:8px 12px;margin-bottom:4px">
          <div class="info"><div class="name" style="font-size:.82rem">${esc(k)}</div></div>
          <div class="ctrl"><input type="text" data-cfg-path="${p}" value="${esc(v ?? '')}"></div>
        </div>`;
      if (isPlainObj(v)) return `
        <div class="cat-head" style="padding:10px 4px 6px">${esc([...path, k].join(' › '))}</div>
        ${formHtml(v, [...path, k])}`;
      // arrays / mixed structures: raw JSON for just this key
      return `
        <div class="setting" style="padding:8px 12px;margin-bottom:4px;align-items:flex-start;flex-direction:column">
          <div class="name" style="font-size:.82rem;margin-bottom:6px">${esc(k)} <span class="muted" style="font-size:.68rem">(JSON)</span></div>
          <textarea data-cfg-json-path="${p}" style="min-height:60px;font-family:ui-monospace,monospace;font-size:.75rem">${esc(JSON.stringify(v, null, 2))}</textarea>
        </div>`;
    }).join('');
  }

  const setDeep = (obj, path, val) => {
    let o = obj;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]] = val;
  };

  async function openFile(rel) {
    currentFile = rel;
    const box = $('#cfg-editor');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { content } = await api(`${apiBase}/config-file?kind=${kind}&path=${encodeURIComponent(rel)}`);
      let parsed = null;
      if (/\.json$/i.test(rel)) { try { parsed = JSON.parse(content); } catch { /* fall back to raw */ } }
      jsonMode = isPlainObj(parsed);
      box.innerHTML = jsonMode
        ? formHtml(parsed)
        : `<textarea id="cfg-raw" style="min-height:320px;font-family:ui-monospace,monospace;font-size:.78rem">${esc(content)}</textarea>`;
      box.dataset.original = jsonMode ? JSON.stringify(parsed) : '';
    } catch (e) { box.innerHTML = `<p class="val-bad">${esc(e.message)}</p>`; }
  }

  async function save() {
    let content;
    if (jsonMode) {
      const obj = JSON.parse($('#cfg-editor').dataset.original);
      try {
        $$('#cfg-editor [data-cfg-path]').forEach((el) => {
          const path = JSON.parse(el.dataset.cfgPath);
          setDeep(obj, path, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value);
        });
        $$('#cfg-editor [data-cfg-json-path]').forEach((el) => {
          setDeep(obj, JSON.parse(el.dataset.cfgJsonPath), JSON.parse(el.value));
        });
      } catch (e) { toast('Invalid JSON in one of the fields: ' + e.message, 'err'); return; }
      content = JSON.stringify(obj, null, 2) + '\n';
    } else {
      content = $('#cfg-raw').value;
    }
    const btn = $('#cfg-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api(`${apiBase}/config-file?kind=${kind}`, { method: 'PUT', body: { path: currentFile, content } });
      toast('Saved — restart the server to apply (Deploy tab)', 'ok');
      btn.disabled = false; btn.textContent = 'Save';
    } catch (e) { btn.disabled = false; btn.textContent = 'Save'; toast('Save failed: ' + e.message, 'err'); }
  }

  (async () => {
    let files = [];
    try { ({ files } = await api(`${apiBase}/configs?kind=${kind}`)); }
    catch (e) { toast('Could not scan mod files: ' + e.message, 'err'); return; }
    if (!files.length) { toast('No editable config files found in this mod', 'err'); return; }
    root.innerHTML = `
      <div class="modal-back"><div class="modal" style="width:min(720px,94vw)">
        <h3>⚙ ${esc(title)} — settings</h3>
        <div class="field"><label>Config file</label>
          <select id="cfg-file">${files.map((f) => `<option>${esc(f)}</option>`).join('')}</select></div>
        <div id="cfg-editor"></div>
        <p class="muted" style="font-size:.72rem;margin-top:8px">A one-shot backup (<span class="mono">.mgr-bak</span>) is kept next to the file. Changes load on the next server restart.</p>
        <div class="actions">
          <button class="btn ghost" id="cfg-close">Close</button>
          <button class="btn primary" id="cfg-save">Save</button>
        </div>
      </div></div>`;
    $('#cfg-close').onclick = () => { root.innerHTML = ''; };
    $('#cfg-file').onchange = (e) => openFile(e.target.value);
    $('#cfg-save').onclick = save;
    // Prefer a root-level .json config (the usual feature-toggle file)
    const first = files.find((f) => !f.includes('/') && /\.json$/i.test(f)) || files[0];
    $('#cfg-file').value = first;
    openFile(first);
  })();
}

async function loadInstalledMods(s) {
  try {
    const data = await api(`/servers/${s.id}/mods`);
    const el = $('#mods-installed');
    if (!el) return;
    state.steamCreds = data.steamCredsConfigured;
    state.modPlatform = data.modPlatform || 'linux';
    // Platform-aware banner + filters
    const banner = $('#mods-platform-banner');
    if (banner && state.modPlatform === 'windows') {
      banner.innerHTML = `✅ <b>Full mod support:</b> this server runs the <b>Windows build</b> —
        UE4SS, PalSchema, Lua and pak mods all work. Official-format Workshop mods install through
        Palworld's own mod system (<span class="mono">Mods/Workshop</span> + auto-enable in
        <span class="mono">PalModSettings.ini</span>); plain pak mods go to <span class="mono">~mods</span>.
        Changes load on restart.`;
      banner.style.borderColor = '#1e4d3d';
      banner.style.color = 'var(--green)';
      banner.style.background = '#12241c';
      const chips = $('#compat-chips');
      if (chips && modState.compat !== 'all') {
        modState.compat = 'all';
        $$('#compat-chips [data-compat]').forEach((x) => x.classList.toggle('active', x.dataset.compat === 'all'));
      }
    }
    el.innerHTML = data.installed.length
      ? `<table><tr><th>Mod</th><th>Type</th><th>Files</th><th>Source</th><th></th></tr>
        ${data.installed.map((m) => `<tr>
          <td>${m.meta ? `<a href="${esc(m.meta.url || '#')}" target="_blank">${esc(m.meta.title)}</a>` : esc(m.dir)}</td>
          <td>${m.kind === 'official' ? '<span class="tag" style="color:var(--accent)">official</span>' : '<span class="tag">pak</span>'}</td>
          <td class="mono" style="font-size:.72rem">${m.files.map(esc).join('<br>')}</td>
          <td>${esc(m.meta?.source || '')}</td>
          <td style="white-space:nowrap">
            <button class="btn small" data-cfg-mod="${esc(m.dir)}" data-cfg-kind="${esc(m.kind)}" data-cfg-title="${esc(m.meta?.title || m.dir)}">⚙ Settings</button>
            <button class="btn small danger" data-rm-mod="${esc(m.dir)}" data-rm-kind="${esc(m.kind)}">Remove</button>
          </td>
        </tr>`).join('')}</table>
        <p class="muted" style="font-size:.75rem;margin-top:8px">Changes to mods take effect after a restart (Deploy tab).</p>`
      : 'No mods installed.';
    $$('#mods-installed [data-cfg-mod]').forEach((b) => b.onclick = () =>
      modConfigEditor(s, b.dataset.cfgMod, b.dataset.cfgKind, b.dataset.cfgTitle));
    $$('#mods-installed [data-rm-mod]').forEach((b) => b.onclick = async () => {
      const ok = await confirmModal({ title: `Remove mod "${b.dataset.rmMod}"?`, body: '<p>Files are deleted from the server. Takes effect on next restart.</p>', confirmText: 'Remove', danger: true });
      if (!ok) return;
      try { await api(`/servers/${s.id}/mods/${encodeURIComponent(b.dataset.rmMod)}?kind=${b.dataset.rmKind}`, { method: 'DELETE' }); toast('Mod removed — review & deploy to apply', 'ok'); loadInstalledMods(s); refreshServers(); }
      catch (e) { toast('Remove failed: ' + e.message, 'err'); }
    });
    const note = $('#mods-creds-note');
    if (note) note.innerHTML = data.steamCredsConfigured ? '' : `
      <p class="muted" style="font-size:.78rem;margin-bottom:10px">
        ⚠️ One-click Workshop installs need a Steam sign-in — use the <b>Accounts</b> card above.
        Without it you can still browse, and install pak mods via upload.
      </p>`;
  } catch { /* tab switched */ }
}

function drawModResults(s) {
  const el = $('#mods-results');
  if (!el || !modState.results) return;
  const items = modState.results.items;
  const isWinServer = state.modPlatform === 'windows';
  const winOnly = (m) => !isWinServer && (m.compat ? m.compat === 'windows' : m.tags.some((t) => /ue4ss|palschema|lua/i.test(t)));
  const compatBadge = (m) => isWinServer
    ? '<span class="tag" style="color:var(--green)">✔ supported on this server</span> '
    : m.compat === 'pak' ? '<span class="tag" style="color:var(--green)">🐧 Linux-compatible</span> '
    : m.compat === 'windows' ? '<span class="tag" style="color:var(--amber)">🪟 Windows-only type</span> '
    : '<span class="tag">❔ type untagged — install verifies pak content</span> ';
  el.innerHTML = items.length ? `<div class="mod-grid">
    ${items.map((m) => `
      <div class="mod-card">
        ${m.preview ? `<img src="${esc(m.preview)}" loading="lazy" alt="">` : '<img alt="">'}
        <div class="body">
          <div class="title">${esc(m.title)}</div>
          <div class="stats">
            ${m.fileSize ? `<span>${fmtBytes(m.fileSize)}</span>` : ''}
            ${m.subscriptions != null ? `<span>👥 ${m.subscriptions}</span>` : ''}
            ${m.timeUpdated ? `<span>upd ${new Date(m.timeUpdated).toLocaleDateString()}</span>` : ''}
          </div>
          <div>${compatBadge(m)}${m.tags.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</div>
          <div class="actions">
            <a class="btn small ghost" href="${esc(m.url)}" target="_blank">Steam ↗</a>
            <button class="btn small ${winOnly(m) ? '' : 'primary'}" data-install="${m.id}" data-title="${esc(m.title)}" ${winOnly(m) ? 'title="Tagged UE4SS/PalSchema/Lua — these mod types do not run on Linux servers"' : ''}>Install</button>
          </div>
        </div>
      </div>`).join('')}
  </div>` : '<span class="muted">No results.</span>';
  $$('#mods-results [data-install]').forEach((b) => b.onclick = async () => {
    const ok = await confirmModal({
      title: `Install "${b.dataset.title}"?`,
      body: `<p>Downloads via the game container's DepotDownloader and installs ${isWinServer
               ? 'through Palworld\'s official mod system (or <span class="mono">~mods</span> for plain paks)'
               : 'pak files to <span class="mono">~mods</span>'}.
             ${state.steamCreds ? '' : '<b>Steam credentials are not configured — this will fail.</b>'}
             Takes effect after restart.</p>`,
      confirmText: 'Install',
    });
    if (!ok) return;
    b.disabled = true; b.textContent = 'Installing…';
    try {
      const r = await api(`/servers/${s.id}/mods/install`, { method: 'POST', body: { id: b.dataset.install } });
      const what = r.kind === 'official'
        ? `${r.packageName || r.installed} via the official mod system`
        : (r.files || []).join(', ');
      toast(`Installed ${what} — review & deploy to activate`, 'ok');
      if (r.missingDependencies && r.missingDependencies.length) {
        toast(`⚠ This mod requires: ${r.missingDependencies.join(', ')} — search the Workshop for them and install them too, or it will not run.`, 'err');
      }
      loadInstalledMods(s);
      refreshServers();
    } catch (e) { toast('Install failed: ' + e.message, 'err'); }
    b.disabled = false; b.textContent = 'Install';
  });
}

// ---------------------------------------------------------------- backups
async function renderBackups(v, s) {
  v.innerHTML = `
    <div class="card">
      <h3>World saves</h3>
      <p class="muted" style="font-size:.8rem;margin-bottom:12px">
        Worlds live in <span class="mono">SaveGames/0/&lt;GUID&gt;</span> and are portable between servers
        (Linux ↔ Windows). Export downloads a .tar.gz; Migrate copies a world to another managed server
        and points it there — the target loads it after a restart. Players keep their characters.
      </p>
      <div id="saves-list" class="muted">Loading…</div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="file" id="save-import-file" accept=".gz,.tgz" style="display:none">
        <button class="btn" id="save-import-btn">⬆ Import world (.tar.gz)</button>
        <span class="muted" style="font-size:.75rem">Overwrites a same-GUID world; restart required afterwards.</span>
      </div>
    </div>
    <div class="card">
      <h3>Backups</h3>
      <p class="muted" style="font-size:.8rem;margin-bottom:12px">
        Backups are tar.gz archives of the save data in <span class="mono">/palworld/backups</span>.
        Scheduled backups are controlled by <span class="mono">BACKUP_ENABLED</span> / <span class="mono">BACKUP_CRON_EXPRESSION</span> in Settings → Image: Backups.
      </p>
      <button class="btn primary" id="bk-create">💾 Create backup now</button>
      <div id="bk-list" class="muted" style="margin-top:14px">Loading…</div>
    </div>`;
  const load = async () => {
    try {
      const backups = await api(`/servers/${s.id}/backups`);
      const el = $('#bk-list');
      if (!el) return;
      el.innerHTML = backups.length
        ? `<table><tr><th>File</th><th>Date</th><th>Size</th><th></th></tr>
          ${backups.map((b) => `<tr>
            <td class="mono" style="font-size:.78rem">${esc(b.name)}</td>
            <td>${esc((b.date || '').replace('T', ' '))}</td>
            <td>${fmtBytes(b.size)}</td>
            <td>
              <a class="btn small ghost" href="/api/servers/${s.id}/backups/${encodeURIComponent(b.name)}/download">Download</a>
              <button class="btn small danger" data-del-bk="${esc(b.name)}">Delete</button>
            </td>
          </tr>`).join('')}</table>`
        : 'No backups yet.';
      $$('#bk-list [data-del-bk]').forEach((btn) => btn.onclick = async () => {
        const ok = await confirmModal({ title: 'Delete backup?', body: `<p class="mono">${esc(btn.dataset.delBk)}</p>`, confirmText: 'Delete', danger: true });
        if (!ok) return;
        try { await api(`/servers/${s.id}/backups/${encodeURIComponent(btn.dataset.delBk)}`, { method: 'DELETE' }); toast('Backup deleted', 'ok'); load(); }
        catch (e) { toast('Delete failed: ' + e.message, 'err'); }
      });
    } catch (e) { const el = $('#bk-list'); if (el) el.innerHTML = `<span class="val-bad">Failed to list backups: ${esc(e.message)}</span>`; }
  };
  const loadSaves = async () => {
    try {
      const data = await api(`/servers/${s.id}/saves`);
      const el = $('#saves-list');
      if (!el) return;
      const others = state.servers.filter((x) => x.id !== s.id);
      el.innerHTML = data.saves.length
        ? `<table><tr><th>World GUID</th><th>Size</th><th>Modified</th><th></th></tr>
          ${data.saves.map((w) => `<tr>
            <td class="mono" style="font-size:.75rem">${esc(w.guid)} ${w.active ? '<span class="tag" style="color:var(--green)">active</span>' : ''}</td>
            <td>${fmtBytes(w.sizeKb * 1024)}</td>
            <td>${esc((w.mtime || '').replace('T', ' '))}</td>
            <td style="white-space:nowrap">
              <a class="btn small ghost" href="/api/servers/${s.id}/saves/${w.guid}/export">Export</a>
              ${others.length ? `<button class="btn small" data-migrate="${w.guid}">Migrate to…</button>` : ''}
            </td>
          </tr>`).join('')}</table>`
        : 'No worlds on this server yet.';
      $$('#saves-list [data-migrate]').forEach((btn) => btn.onclick = async () => {
        const guid = btn.dataset.migrate;
        const root = $('#modal-root');
        root.innerHTML = `
          <div class="modal-back"><div class="modal">
            <h3>Migrate world to another server</h3>
            <p class="muted" style="font-size:.8rem">World <span class="mono">${esc(guid)}</span> from <b>${esc(s.name)}</b>.
            The target's world with the same GUID is <b>overwritten</b>, its active world is switched, and it restarts to load it.</p>
            <div class="field"><label>Target server</label>
              <select id="mig-target">${others.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></div>
            <div class="field"><label><input type="checkbox" id="mig-newguid"> Assign a new world GUID on the target</label>
              <p class="muted" style="font-size:.72rem;margin-top:4px">⚠ A new GUID makes clients treat this as an unexplored world: players keep their characters and fast-travel unlocks, but their map exploration and discovered fast-travel icons reset. Keep the same GUID when cutting a community over to this server.</p></div>
            <div class="field"><label><input type="checkbox" id="mig-stripwo" checked> Remove WorldOption.sav if present (so the target's env settings stay in control)</label></div>
            <div class="field"><label><input type="checkbox" id="mig-restart" checked> Restart target after migration (60s countdown announcement)</label></div>
            <div class="actions">
              <button class="btn ghost" id="mig-cancel">Cancel</button>
              <button class="btn danger" id="mig-go">Migrate world</button>
            </div>
          </div></div>`;
        $('#mig-cancel').onclick = () => { root.innerHTML = ''; };
        $('#mig-go').onclick = async () => {
          const to = $('#mig-target').value;
          const restart = $('#mig-restart').checked;
          $('#mig-go').disabled = true; $('#mig-go').textContent = 'Migrating…';
          try {
            const r = await api('/saves/migrate', { method: 'POST', body: {
              from: s.id, to, guid, restart, countdownSeconds: restart ? 60 : 0,
              assignNewGuid: $('#mig-newguid').checked, stripWorldOption: $('#mig-stripwo').checked,
            } });
            root.innerHTML = '';
            toast(`World migrated to ${to} as ${r.migrated}${r.job ? ' — restarting target' : ' — restart target to load it'}`, 'ok');
            if (r.hasWorldOption) toast('Heads up: the world contains WorldOption.sav — its embedded settings override the target\'s env values', 'err');
            if (r.job) watchJob(r.job, s);
          } catch (e) { $('#mig-go').disabled = false; $('#mig-go').textContent = 'Migrate world'; toast('Migration failed: ' + e.message, 'err'); }
        };
      });
    } catch (e) { const el = $('#saves-list'); if (el) el.innerHTML = `<span class="val-bad">${esc(e.message)}</span>`; }
  };
  $('#save-import-btn').onclick = () => $('#save-import-file').click();
  $('#save-import-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-back"><div class="modal">
        <h3>Import world from ${esc(f.name)}?</h3>
        <p class="muted" style="font-size:.8rem">The imported world becomes this server's active world.
        The copy belongs to <b>${esc(s.name)}</b> only — it never affects the server it came from.</p>
        <div class="field"><label><input type="checkbox" id="imp-newguid"> Assign a new world GUID</label>
          <p class="muted" style="font-size:.72rem;margin-top:4px">⚠ A new GUID makes clients treat this as an unexplored world: players keep their characters and fast-travel unlocks, but their map exploration and discovered fast-travel icons reset. Keep the same GUID when cutting a community over to this server.</p></div>
        <div class="field"><label><input type="checkbox" id="imp-stripwo" checked> Remove WorldOption.sav if present (so this server's env settings stay in control)</label></div>
        <div class="field"><label><input type="checkbox" id="imp-restart" checked> Restart after import (60s countdown announcement)</label></div>
        <div class="actions">
          <button class="btn ghost" id="imp-cancel">Cancel</button>
          <button class="btn danger" id="imp-go">Import world</button>
        </div>
      </div></div>`;
    const close = () => { root.innerHTML = ''; $('#save-import-file').value = ''; };
    $('#imp-cancel').onclick = close;
    $('#imp-go').onclick = async () => {
      const qs = new URLSearchParams({
        newGuid: $('#imp-newguid').checked ? '1' : '0',
        stripWorldOption: $('#imp-stripwo').checked ? '1' : '0',
        restart: $('#imp-restart').checked ? '1' : '0',
        countdown: '60',
      });
      $('#imp-go').disabled = true; $('#imp-go').textContent = 'Uploading…';
      try {
        const res = await fetch(`/api/servers/${s.id}/saves/import?${qs}`, { method: 'POST', body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.status);
        close();
        toast(`World imported as ${data.imported}${data.job ? ' — restarting now' : ' — restart to load it'}`, 'ok');
        if (data.hasWorldOption) toast('Heads up: this world contains WorldOption.sav — its embedded settings override env values', 'err');
        if (data.job) watchJob(data.job, s);
        loadSaves();
      } catch (err) { $('#imp-go').disabled = false; $('#imp-go').textContent = 'Import world'; toast('Import failed: ' + err.message, 'err'); }
    };
  };
  loadSaves();

  $('#bk-create').onclick = async () => {
    const btn = $('#bk-create');
    btn.disabled = true; btn.textContent = 'Creating backup…';
    try {
      await api(`/servers/${s.id}/backups`, { method: 'POST' });
      toast('Backup created', 'ok');
      load();
    } catch (e) { toast('Backup failed: ' + e.message, 'err'); }
    btn.disabled = false; btn.textContent = '💾 Create backup now';
  };
  load();
}

// ---------------------------------------------------------------- logs
async function renderLogs(v, s) {
  v.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:12px;align-items:center">
      <button class="btn small" id="logs-refresh">↻ Refresh</button>
      <span class="muted" style="font-size:.78rem">last 200 lines of container output</span>
    </div>
    <pre class="logs" id="logs-pre">Loading…</pre>`;
  const load = async () => {
    try {
      const r = await api(`/servers/${s.id}/logs?tail=200`);
      const pre = $('#logs-pre');
      if (pre) { pre.textContent = r.logs || '(empty)'; pre.scrollTop = pre.scrollHeight; }
    } catch (e) { const pre = $('#logs-pre'); if (pre) pre.textContent = 'Failed to load logs: ' + e.message; }
  };
  $('#logs-refresh').onclick = load;
  load();
}

// ---------------------------------------------------------------- rename
function renameServerModal(s) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-back"><div class="modal">
      <h3>Rename server</h3>
      <p class="muted" style="font-size:.78rem;margin-bottom:12px">
        Changes the display name in the manager only. The in-game name is the
        <b>ServerName</b> setting in the Settings tab (needs a deploy to apply).
      </p>
      <div class="field"><label>Display name</label><input type="text" id="rn-name" value="${esc(s.name)}" maxlength="60"></div>
      <div class="actions">
        <button class="btn ghost" id="rn-cancel">Cancel</button>
        <button class="btn primary" id="rn-save">Save</button>
      </div>
    </div></div>`;
  const save = async () => {
    const name = $('#rn-name').value.trim();
    if (!name) { toast('Name cannot be empty', 'err'); return; }
    try {
      await api(`/servers/${s.id}`, { method: 'PATCH', body: { name } });
      root.innerHTML = '';
      toast('Server renamed', 'ok');
      await refreshServers();
    } catch (e) { toast('Rename failed: ' + e.message, 'err'); }
  };
  $('#rn-cancel').onclick = () => { root.innerHTML = ''; };
  $('#rn-save').onclick = save;
  $('#rn-name').onkeydown = (e) => { if (e.key === 'Enter') save(); };
  $('#rn-name').focus();
  $('#rn-name').select();
}
$('#rename-btn').onclick = () => { const s = currentServer(); if (s) renameServerModal(s); };

// ---------------------------------------------------------------- mobile sidebar drawer
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
$('#menu-btn').onclick = () => setSidebar(!document.body.classList.contains('sidebar-open'));
$('#sidebar-back').onclick = () => setSidebar(false);

// ---------------------------------------------------------------- init
(async function init() {
  try { state.canned = await api('/canned-messages'); } catch { /* defaults */ }
  await refreshServers();
  state.pollTimer = setInterval(refreshServers, 10000);
  renderView();
})();
