/**
 * Session-scoped light→light hop tallies.
 * Survives Reset; clears only on full page reload.
 */

export function createHopTally() {
  return {
    /** @type {Map<string, Map<string, number>>} */
    fromTo: new Map(),
    totalHops: 0,
  }
}

export function recordHop(tally, fromId, toId) {
  if (!tally || fromId == null || toId == null || fromId === toId) return
  const from = String(fromId)
  const to = String(toId)
  if (!tally.fromTo.has(from)) tally.fromTo.set(from, new Map())
  const row = tally.fromTo.get(from)
  row.set(to, (row.get(to) || 0) + 1)
  tally.totalHops += 1
}

export function hopCount(tally, fromId, toId) {
  return tally?.fromTo.get(String(fromId))?.get(String(toId)) || 0
}

export function fromTotal(tally, fromId) {
  const row = tally?.fromTo.get(String(fromId))
  if (!row) return 0
  let n = 0
  for (const c of row.values()) n += c
  return n
}

/** Empirical P(to | from) from the session tally, or null if unseen. */
export function foundProbability(tally, fromId, toId) {
  const total = fromTotal(tally, fromId)
  if (!total) return null
  return hopCount(tally, fromId, toId) / total
}

/**
 * Snapshot of found probs aligned to a given transitions list.
 * @param {Array<{from:string,to:string,probability:number}>} givenTransitions
 */
export function snapshotFoundVsGiven(tally, givenTransitions) {
  const out = []
  for (const t of givenTransitions || []) {
    if (!t?.from || !t?.to) continue
    const n = hopCount(tally, t.from, t.to)
    const fromN = fromTotal(tally, t.from)
    const found = fromN > 0 ? n / fromN : null
    out.push({
      from: String(t.from),
      to: String(t.to),
      given: Number(t.probability) || 0,
      found,
      n,
      fromN,
    })
  }
  return out
}

/**
 * Mean absolute deviation in percentage points: avg(|found - given| * 100)
 * over edges that have a found probability.
 * @returns {{ avgDeviationPct: number|null, comparedEdges: number }}
 */
export function avgFoundGivenDeviationPct(tally, givenTransitions) {
  const rows = snapshotFoundVsGiven(tally, givenTransitions)
  let sum = 0
  let n = 0
  for (const r of rows) {
    if (r.found == null) continue
    sum += Math.abs(r.found - r.given) * 100
    n += 1
  }
  if (!n) return { avgDeviationPct: null, comparedEdges: 0 }
  return { avgDeviationPct: Number((sum / n).toFixed(2)), comparedEdges: n }
}

/**
 * Build locked-style transitions from the session hop tally.
 * Each from-node's outs sum to 1 using empirical counts.
 * @returns {Array<{from:string,to:string,count:number,probability:number}>}
 */
export function transitionsFromHopTally(tally) {
  const out = []
  if (!tally?.fromTo) return out
  for (const [from, row] of tally.fromTo) {
    let fromN = 0
    for (const c of row.values()) fromN += c
    if (!fromN) continue
    for (const [to, n] of row) {
      if (!n) continue
      out.push({
        from: String(from),
        to: String(to),
        count: n,
        probability: n / fromN,
      })
    }
  }
  out.sort(
    (a, b) =>
      b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
  return out
}

/**
 * Replace outgoing edges for from-nodes that have live samples; keep old edges
 * for from-nodes with no session hops yet.
 */
export function mergeFoundIntoTransitions(tally, previousTransitions) {
  const found = transitionsFromHopTally(tally)
  const foundFrom = new Set(found.map((t) => t.from))
  const kept = (previousTransitions || []).filter((t) => !foundFrom.has(String(t.from)))
  const merged = [...found, ...kept]
  merged.sort(
    (a, b) =>
      (b.count || 0) - (a.count || 0) ||
      String(a.from).localeCompare(String(b.from)) ||
      String(a.to).localeCompare(String(b.to)),
  )
  return { transitions: merged, capturedFrom: foundFrom.size, capturedEdges: found.length }
}
