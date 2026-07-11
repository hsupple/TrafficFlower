/**
 * Simulation run logging — appends one line per completed Intersection run
 * into logs/<name>.log via the Vite /api/sim-log endpoint (dev server).
 */

export function slugifyLogName(name) {
  const base = String(name || 'default')
    .trim()
    .replace(/\.log$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (base || 'default').toLowerCase()
}

export function defaultLogNameForLayout(layout) {
  return slugifyLogName(layout?.id || layout?.name || 'default')
}

/**
 * @param {object} stats
 * @returns {string} one appendable log line (JSON)
 */
export function formatSimLogLine(stats) {
  return JSON.stringify({
    ts: stats.ts || new Date().toISOString(),
    spawnedAt: stats.spawnedAt || null,
    type: stats.type || 'run',
    mode: stats.mode || null,
    runs: stats.runs || 1,
    layout: stats.layoutId,
    layoutName: stats.layoutName,
    logFile: stats.logFile,
    durationMs: stats.durationMs,
    durationSec: stats.durationSec ?? Number(((stats.durationMs || 0) / 1000).toFixed(2)),
    ticks: stats.ticks,
    tickMs: stats.tickMs,
    agents: stats.agents,
    vaporized: stats.vaporized,
    alive: stats.alive,
    predestination: Boolean(stats.predestination),
    lights: stats.lights,
    signalSwitches: stats.signalSwitches,
    peakWaiting: stats.peakWaiting,
    waitingH: stats.waitingH,
    waitingV: stats.waitingV,
    avgWait: stats.avgWait,
    maxWait: stats.maxWait,
    totalLightWaits: stats.totalLightWaits,
    avgPathHops: stats.avgPathHops,
    maxPathHops: stats.maxPathHops,
    sessionHops: stats.sessionHops,
    hopsAdded: stats.hopsAdded,
    avgDeviationPct: stats.avgDeviationPct,
    comparedEdges: stats.comparedEdges,
  })
}

/** Serialize log writes so tick + run lines never race. */
let writeChain = Promise.resolve()

async function appendSimLogNow(fileName, line) {
  const slug = slugifyLogName(fileName)
  const res = await fetch('/api/sim-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: slug, line }),
  })
  const text = await res.text()
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(
      `Log API returned non-JSON (${res.status}). Restart the Vite dev server (npm run dev) so /api/sim-log is loaded.`,
    )
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return { ok: true, file: data.file || `${slug}.log`, path: data.path || `logs/${slug}.log` }
}

/**
 * Append a line to logs/<file>.log through the Vite dev API.
 * @returns {Promise<{ok:boolean, file?:string, path?:string, error?:string}>}
 */
export function appendSimLog(fileName, line) {
  const job = writeChain.then(() => appendSimLogNow(fileName, line))
  writeChain = job.then(
    () => undefined,
    () => undefined,
  )
  return job.then(
    (ok) => ok,
    (err) => ({
      ok: false,
      error:
        err?.message ||
        String(err) ||
        'Could not write logs/. Restart npm run dev and try again.',
    }),
  )
}
