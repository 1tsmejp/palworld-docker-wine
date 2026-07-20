const crypto = require('crypto');
const { PalApi } = require('./palapi');
const { updateEnv } = require('./compose');
const { dockerctl } = require('./dockerctl');
const { validateUpdates, compareWithLive, compareImageEnv } = require('./schema');
const { appendHistory } = require('./config');

const jobs = new Map(); // id -> job

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJob(serverId, kind) {
  const job = {
    id: crypto.randomUUID(),
    serverId,
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    steps: [],
    error: null,
    validation: null,
  };
  jobs.set(job.id, job);
  // keep the map from growing forever
  if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
  return job;
}

function step(job, name) {
  const s = { name, status: 'running', detail: '', startedAt: new Date().toISOString(), finishedAt: null };
  job.steps.push(s);
  return {
    ok(detail = '') { s.status = 'ok'; s.detail = detail; s.finishedAt = new Date().toISOString(); },
    warn(detail) { s.status = 'warn'; s.detail = detail; s.finishedAt = new Date().toISOString(); },
    fail(detail) { s.status = 'failed'; s.detail = detail; s.finishedAt = new Date().toISOString(); },
    note(detail) { s.detail = detail; },
  };
}

function fmtCountdown(sec) {
  if (sec >= 60) {
    const m = Math.round(sec / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${sec} seconds`;
}

/**
 * Deploy pipeline:
 *  1. validate updates          (skipped for plain reboot)
 *  2. announce countdown        (canned message, {time} placeholder)
 *  3. save world via REST
 *  4. write compose env         (timestamped backup kept)
 *  5. docker compose up -d      (graceful recreate; image saves + backs up on SIGTERM)
 *  6. wait for healthy + REST up
 *  7. validate live settings vs desired
 *  8. optional completion announcement
 */
async function startDeploy(server, opts) {
  const {
    updates = {},           // { ENV: value|null }
    countdownSeconds = 60,
    message = 'SERVER RESTART in {time} — settings update incoming!',
    completeMessage = null,
    reboot = true,
  } = opts;

  const hasUpdates = Object.keys(updates).length > 0;
  const normalized = hasUpdates ? validateUpdates(updates, server) : {};
  const job = newJob(server.id, hasUpdates ? (reboot ? 'settings+reboot' : 'settings-only') : 'reboot');

  (async () => {
    try {
      // Stopped / never-launched servers skip the countdown and REST save —
      // there is nobody to warn and no API to reach; compose up starts them.
      const wasRunning = (await dockerctl.containerState(server.containerName)).status === 'running';
      if (!wasRunning && reboot) job.kind = hasUpdates ? 'settings+start' : 'start';

      // --- announce countdown -------------------------------------------
      if (reboot && countdownSeconds > 0 && wasRunning) {
        const st = step(job, `Announce countdown (${fmtCountdown(countdownSeconds)})`);
        try {
          const api = new PalApi(server);
          const marks = [countdownSeconds, 60, 30, 10]
            .filter((m, i, a) => m <= countdownSeconds && a.indexOf(m) === i)
            .sort((a, b) => b - a);
          for (let i = 0; i < marks.length; i++) {
            const msg = message.replace(/\{time\}/g, fmtCountdown(marks[i]));
            await api.announce(msg);
            st.note(`announced at T-${fmtCountdown(marks[i])}`);
            const next = marks[i + 1] ?? 0;
            await sleep((marks[i] - next) * 1000);
          }
          st.ok(`${marks.length} announcement(s) sent`);
        } catch (e) {
          st.warn(`announcements failed (${e.message}) — continuing`);
        }
      }

      // --- save world ---------------------------------------------------
      if (reboot && wasRunning) {
        const st = step(job, 'Save world');
        try { await new PalApi(server).save(); st.ok(); }
        catch (e) { st.warn(`REST save failed (${e.message}) — image also saves on graceful stop`); }
      }

      // --- write compose ------------------------------------------------
      if (hasUpdates) {
        const st = step(job, 'Update docker-compose.yml');
        const backup = updateEnv(server.composeFile, server.serviceName, normalized);
        st.ok(`${Object.keys(normalized).length} setting(s) written, backup: ${backup.split('/').pop()}`);
      }

      if (reboot) {
        // --- recreate / start -------------------------------------------
        const st = step(job, wasRunning ? 'Recreate container' : 'Start container');
        await dockerctl.composeUp(server, !hasUpdates); // env change triggers recreate on its own
        st.ok();

        // --- wait for healthy -------------------------------------------
        const st2 = step(job, 'Wait for server online');
        const deadline = Date.now() + 15 * 60 * 1000;
        let online = false;
        while (Date.now() < deadline) {
          await sleep(5000);
          const state = await dockerctl.containerState(server.containerName);
          st2.note(`container: ${state.status}/${state.health}`);
          if (state.status === 'running') {
            try { await new PalApi(server).info(); online = true; break; } catch { /* not up yet */ }
          }
          if (state.status === 'exited' || state.status === 'dead') {
            throw new Error(`container ${state.status} during startup — check logs`);
          }
        }
        if (!online) throw new Error('server did not come online within 15 minutes');
        st2.ok('REST API responding');
      }

      // --- validate -----------------------------------------------------
      if (hasUpdates && reboot) {
        const st = step(job, 'Validate applied settings');
        try {
          const live = await new PalApi(server).settings();
          const results = compareWithLive(normalized, live);
          try {
            const cenv = await dockerctl.containerEnv(server.containerName);
            results.push(...compareImageEnv(normalized, cenv));
          } catch { /* container env unavailable */ }
          job.validation = results;
          const bad = results.filter((r) => r.ok === false);
          if (bad.length) st.warn(`${bad.length} setting(s) mismatch: ${bad.map((b) => b.iniKey).join(', ')}`);
          else st.ok(`${results.length} setting(s) verified against live server`);
        } catch (e) {
          st.warn(`could not validate (${e.message})`);
        }
      }

      // --- completion announcement -------------------------------------
      if (reboot && completeMessage) {
        const st = step(job, 'Completion announcement');
        try { await new PalApi(server).announce(completeMessage); st.ok(); }
        catch (e) { st.warn(e.message); }
      }

      job.status = 'succeeded';
    } catch (e) {
      job.error = e.message;
      job.status = 'failed';
      const last = job.steps[job.steps.length - 1];
      if (last && last.status === 'running') {
        last.status = 'failed';
        last.detail = e.message;
        last.finishedAt = new Date().toISOString();
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      appendHistory('deploys', {
        serverId: server.id, jobId: job.id, kind: job.kind, status: job.status,
        updates: Object.keys(normalized), error: job.error,
      });
    }
  })();

  return job;
}

function getJob(id) { return jobs.get(id) || null; }
function listJobs(serverId) {
  return [...jobs.values()].filter((j) => !serverId || j.serverId === serverId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

module.exports = { startDeploy, getJob, listJobs };
