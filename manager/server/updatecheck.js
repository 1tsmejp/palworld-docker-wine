// Pending-update detection: compares the buildid installed in the game volume
// (steamapps/appmanifest_2394010.acf, same path in both image flavors) against
// Steam's public branch via api.steamcmd.net — the same source the images'
// own auto-update flows use. Both sides are cached: the Steam call for
// LATEST_TTL, the installed buildid until the container restarts (the acf
// only changes during the entrypoint's boot-time steamcmd pass).
const { dockerctl } = require('./dockerctl');

const APP_ID = '2394010';
const LATEST_TTL = 10 * 60 * 1000;

let latestCache = { at: 0, buildid: null };
const installedCache = new Map(); // containerName -> { startedAt, buildid }

async function latestBuildid() {
  if (Date.now() - latestCache.at < LATEST_TTL) return latestCache.buildid;
  let buildid = null;
  try {
    const res = await fetch(`https://api.steamcmd.net/v1/info/${APP_ID}`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      buildid = data?.data?.[APP_ID]?.depots?.branches?.public?.buildid || null;
    }
  } catch { /* Steam api down — cache the miss so we don't hammer it */ }
  latestCache = { at: Date.now(), buildid };
  return buildid;
}

async function installedBuildid(containerName, startedAt) {
  const cached = installedCache.get(containerName);
  if (cached && cached.startedAt === startedAt) return cached.buildid;
  let buildid = null;
  try {
    const out = await dockerctl.exec(containerName,
      ['sh', '-c', `grep -m1 '"buildid"' /palworld/steamapps/appmanifest_${APP_ID}.acf`], 15000);
    const m = out.match(/"buildid"\s*"(\d+)"/);
    buildid = m ? m[1] : null;
  } catch { /* container mid-boot or acf missing (failed update) */ }
  installedCache.set(containerName, { startedAt, buildid });
  return buildid;
}

/** { current, latest, available } for a RUNNING container, or null if unknown. */
async function updateStatus(containerName, startedAt) {
  const [latest, current] = await Promise.all([latestBuildid(), installedBuildid(containerName, startedAt)]);
  if (!latest || !current) return null;
  return { current, latest, available: current !== latest };
}

module.exports = { updateStatus };
