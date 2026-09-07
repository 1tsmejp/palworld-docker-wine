'use strict';
/**
 * "Test mods safely" — verify that the current mod set can actually launch on
 * the current game build WITHOUT touching production.
 *
 * It clones the production /palworld volume (game install + Workshop mod
 * sources + the world save) into a throwaway volume, boots a temporary Wine
 * instance on spare ports with mods ENABLED and the boot watchdog DISABLED (so
 * a mod-induced hang stays observable instead of auto-reverting to vanilla),
 * then waits for that instance's REST API. REST up within the timeout => the
 * mods launch on this build; timeout => they still hang. Everything is torn
 * down afterwards (throwaway container + volume + stack dir).
 *
 * Only one test runs at a time. State is kept in-process and polled by the UI.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { STACKS_DIR } = require('./provision');

const PROJECT = 'pw-staging-test';
const CONTAINER = 'palworld-staging-test';
const VOLUME = 'pw_staging_test_data';            // external, created/destroyed here
const IMAGE = 'palworld-wine-test:latest';
const STACK_DIR = path.join(STACKS_DIR, 'staging-test');
const COMPOSE_FILE = path.join(STACK_DIR, 'docker-compose.yml');
const GAME_PORT = 18211, REST_PORT = 18212, QUERY_PORT = 27017, REST_INTERNAL = 8212;
const ADMIN = 'stagingtest';
const REST_TIMEOUT_MS = 12 * 60 * 1000;           // generous: seed skipped, but fresh prefix + modded load
const POLL_MS = 10 * 1000;

let job = null; // { id, phase, steps:[{t,msg}], verdict, running, startedAt, finishedAt, error }

function now() { return new Date().toISOString(); }
function step(msg) { if (job) { job.steps.push({ t: now(), msg }); job.phase = msg; } }

/** Run a command, resolving { code, out }. Never rejects. */
function sh(cmd, args, { timeoutMs = 600000, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', done = false;
    const finish = (code) => { if (!done) { done = true; resolve({ code, out }); } };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } finish(-1); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { clearTimeout(timer); finish(code); });
    p.on('error', () => { clearTimeout(timer); finish(-1); });
    if (input != null) { p.stdin.write(input); p.stdin.end(); } else { p.stdin.end(); }
  });
}
const docker = (args, opts) => sh('docker', args, opts);

async function prodVolumeName(server) {
  const { out } = await docker(['inspect', server.containerName,
    '--format', '{{range .Mounts}}{{if eq .Destination "/palworld"}}{{.Name}}{{end}}{{end}}']);
  return out.trim();
}

function composeYaml() {
  return [
    `name: ${PROJECT}`,
    ``,
    `services:`,
    `  palworld:`,
    `    image: ${IMAGE}`,
    `    container_name: ${CONTAINER}`,
    `    restart: "no"`,             // a hang must NOT restart-loop; we tear it down
    `    stop_grace_period: 20s`,
    `    ports:`,
    `      - "${GAME_PORT}:8211/udp"`,
    `      - "${QUERY_PORT}:${QUERY_PORT}/udp"`,
    `      - "${REST_PORT}:${REST_INTERNAL}/tcp"`,
    `    environment:`,
    `      SERVER_NAME: "STAGING mod test"`,
    `      ADMIN_PASSWORD: "${ADMIN}"`,
    `      COMMUNITY: "False"`,       // never advertised
    `      REST_API_ENABLED: "True"`,
    `      REST_API_PORT: ${REST_INTERNAL}`,
    `      QUERY_PORT: ${QUERY_PORT}`,
    `      UPDATE_ON_BOOT: "false"`,  // install is already seeded from prod
    `      AUTO_UPDATE_ENABLED: "false"`,
    `      MOD_WATCHDOG_ENABLED: "false"`, // observe the real result, don't auto-revert
    `      USE_BACKUP_SAVE_DATA: "False"`,
    `      TZ: "UTC"`,
    `    volumes:`,
    `      - staging_data:/palworld`,
    ``,
    `volumes:`,
    `  staging_data:`,
    `    external: true`,
    `    name: ${VOLUME}`,
    ``,
  ].join('\n');
}

async function teardown() {
  try { await docker(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'down', '-t', '20'], { timeoutMs: 120000 }); } catch { /* */ }
  await docker(['rm', '-f', CONTAINER], { timeoutMs: 60000 });
  await docker(['volume', 'rm', '-f', VOLUME], { timeoutMs: 60000 });
  try { fs.rmSync(STACK_DIR, { recursive: true, force: true }); } catch { /* */ }
}

async function restUp() {
  const { code } = await docker(['exec', CONTAINER, 'sh', '-c',
    `curl -sf -m 5 -u admin:${ADMIN} http://127.0.0.1:${REST_INTERNAL}/v1/api/info`], { timeoutMs: 20000 });
  return code === 0;
}

async function containerAlive() {
  const { out } = await docker(['inspect', CONTAINER, '--format', '{{.State.Status}}'], { timeoutMs: 20000 });
  return out.trim() === 'running';
}

async function runTest(server) {
  try {
    step('Cleaning up any previous staging instance');
    await teardown();

    step('Flushing the production world save');
    // best-effort; prod may be paused/offline
    await docker(['exec', server.containerName, 'sh', '-c',
      `curl -sf -m 30 -u admin:"$REST_ADMIN" -X POST http://127.0.0.1:8212/v1/api/save || true`], { timeoutMs: 40000 }).catch(() => {});

    const prodVol = await prodVolumeName(server);
    if (!prodVol) throw new Error('could not resolve the production /palworld volume');

    step('Creating throwaway volume');
    await docker(['volume', 'create', VOLUME], { timeoutMs: 60000 });

    step(`Cloning game install + world save + mods from ${prodVol} (this takes a few minutes)`);
    // reuse the game image (has coreutils); override entrypoint so it just copies
    const seed = await docker(['run', '--rm', '-u', '0',
      '-v', `${prodVol}:/src:ro`, '-v', `${VOLUME}:/dst`,
      '--entrypoint', 'sh', IMAGE, '-c', 'cp -a /src/. /dst/'], { timeoutMs: 20 * 60 * 1000 });
    if (seed.code !== 0) throw new Error(`volume clone failed: ${seed.out.split('\n').filter(Boolean).slice(-2).join(' | ')}`);

    step('Enabling mods in the copy (clearing safe-mode marker; entrypoint will un-stash on boot)');
    await docker(['run', '--rm', '-u', '0', '-v', `${VOLUME}:/palworld`, '--entrypoint', 'sh', IMAGE, '-c',
      'rm -f /palworld/.mods_safe_mode'], { timeoutMs: 120000 });

    step('Writing staging compose + booting the instance');
    fs.mkdirSync(STACK_DIR, { recursive: true });
    fs.writeFileSync(COMPOSE_FILE, composeYaml());
    const up = await docker(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'up', '-d'], { timeoutMs: 120000 });
    if (up.code !== 0) throw new Error(`compose up failed: ${up.out.split('\n').filter(Boolean).slice(-2).join(' | ')}`);

    step('Waiting for the modded server to come online (REST API)…');
    const deadline = Date.now() + REST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!(await containerAlive())) {
        // it exited on its own (crash) — that's a fail
        job.verdict = 'fail';
        step('❌ Staging instance exited before binding — the mods do not launch on this build.');
        break;
      }
      if (await restUp()) {
        job.verdict = 'pass';
        step('✅ REST API is up — the current mods LAUNCH on this build. Safe to restore on production.');
        break;
      }
    }
    if (!job.verdict) {
      job.verdict = 'fail';
      step(`❌ No REST API within ${Math.round(REST_TIMEOUT_MS / 60000)} min — the mods still hang world load on this build.`);
    }
  } catch (e) {
    job.error = e.message || String(e);
    job.verdict = 'error';
    step(`⚠️ Test error: ${job.error}`);
  } finally {
    step('Tearing down the staging instance');
    await teardown();
    job.running = false;
    job.finishedAt = now();
    step('Done.');
  }
}

function startTest(server) {
  if (job && job.running) { const e = new Error('a mod test is already running'); e.status = 409; throw e; }
  job = { id: `test-${Date.now()}`, phase: 'starting', steps: [], verdict: null, running: true, startedAt: now(), finishedAt: null, error: null, serverId: server.id };
  runTest(server); // fire-and-forget; polled via status()
  return { id: job.id, running: true };
}

function status() {
  if (!job) return { running: false, verdict: null, steps: [] };
  return job;
}

module.exports = { startTest, status, teardown };
