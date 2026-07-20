const { execFile } = require('child_process');

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
      resolve({ stdout, stderr });
    });
  });
}

const dockerctl = {
  async containerState(name) {
    try {
      const { stdout } = await run('docker', ['inspect', '--format',
        '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}', name], 15000);
      const [status, health, startedAt] = stdout.trim().split('|');
      return { status, health, startedAt };
    } catch {
      return { status: 'missing', health: 'none', startedAt: null };
    }
  },

  async composeUp(server, forceRecreate = false) {
    const args = ['compose', '-f', server.composeFile, '-p', server.composeProject, 'up', '-d'];
    if (forceRecreate) args.push('--force-recreate');
    return run('docker', args, 600000);
  },

  // `stop` (not `down`) keeps the container so it shows as "exited" and can be
  // started again; -t 60 gives the game server time to shut down cleanly.
  async composeStop(server) {
    return run('docker', ['compose', '-f', server.composeFile, '-p', server.composeProject, 'stop', '-t', '60'], 300000);
  },

  async composeRestart(server) {
    return run('docker', ['compose', '-f', server.composeFile, '-p', server.composeProject, 'restart', '-t', '60'], 600000);
  },

  async containerEnv(name) {
    const { stdout } = await run('docker', ['inspect', '--format', '{{json .Config.Env}}', name], 15000);
    const out = {};
    for (const kv of JSON.parse(stdout.trim())) {
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  },

  /** Run a command inside a container, return stdout. */
  async exec(name, cmd, timeoutMs = 120000) {
    const { stdout } = await run('docker', ['exec', name, ...cmd], timeoutMs);
    return stdout;
  },

  /** Run a command inside a container with data piped to stdin. */
  execInput(name, cmd, input, timeoutMs = 300000) {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const p = spawn('docker', ['exec', '-i', name, ...cmd]);
      let out = '', err = '';
      const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timed out')); }, timeoutMs);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: out, stderr: err }); });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.stdin.end(input || '');
    });
  },

  /** Stream a file out of a container onto res (express response). */
  execStreamFile(name, filePath, res) {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const p = spawn('docker', ['exec', name, 'cat', filePath]);
      p.stdout.pipe(res);
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
    });
  },

  /** Write a buffer to a file inside a container (via stdin). */
  execWriteFile(name, filePath, buffer) {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const p = spawn('docker', ['exec', '-i', name, 'sh', '-c', `cat > '${filePath.replace(/'/g, '')}'`]);
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
      p.stdin.end(buffer);
    });
  },

  async logs(name, tail = 100) {
    const { stdout, stderr } = await run('docker', ['logs', '--tail', String(tail), name], 30000);
    return (stdout + stderr).split('\n').slice(-tail).join('\n');
  },
};

module.exports = { dockerctl, run };
