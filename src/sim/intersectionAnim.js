/**
 * Intersection-tab agent animation (see Thoughts.md).
 *
 * Reactionary lights at every paired intersection:
 * - Each light starts green on a random axis (H or V)
 * - Waiters approaching on red arm a 2-tick countdown, then the light switches
 * - Agents freeze mid-hop toward a red destination; green resumes the same lerp
 *
 * Predestination (optional, default in UI): spawn at a light, pick a POI-weighted
 * destination light, follow hop-shortest path on pairs. Signal gating still applies.
 */

import { lightRowCol } from './focusIntersection.js'

export const CORNER_SPAWNS = ['1004', '1044', '1017', '1022']
export const COMPETE_SPAWNS = ['1019', '1012']
export const CORNER_COUNT = 10
export const COMPETE_COUNT = 4

/** Mutable focus center — updated from layouts.json via applyLayoutSignal. */
export let SIGNAL_NODE_ID = '1020'

/** Legacy stop-line labels for focus panel (not the sole gates anymore). */
export const STOP_LINES = {
  '1012': 'V',
  '1028': 'V',
  '1019': 'H',
  '1021': 'H',
}

export const STOP_TOWARD = {
  '1012': '1020',
  '1028': '1020',
  '1019': '1020',
  '1021': '1020',
}

export function getStopLineIds() {
  return Object.keys(STOP_LINES)
}

/** @deprecated use getStopLineIds() — kept in sync by applyLayoutSignal */
export let STOP_LINE_IDS = getStopLineIds()

export function applyLayoutSignal(signal) {
  if (!signal?.centerId || !signal?.stopLines) return
  SIGNAL_NODE_ID = String(signal.centerId)
  for (const k of Object.keys(STOP_LINES)) delete STOP_LINES[k]
  Object.assign(STOP_LINES, signal.stopLines)
  for (const k of Object.keys(STOP_TOWARD)) delete STOP_TOWARD[k]
  Object.assign(STOP_TOWARD, signal.stopToward || {})
  for (const id of Object.keys(STOP_LINES)) {
    if (!STOP_TOWARD[id]) STOP_TOWARD[id] = SIGNAL_NODE_ID
  }
  STOP_LINE_IDS = getStopLineIds()
}

/** Milliseconds to travel one light→light hop (semi-slow). */
export const HOP_DURATION_MS = 2200

/** One reactionary signal tick. */
export const SIGNAL_TICK_MS = 2000

/** Waiters arm this many ticks before the light flips. */
export const SIGNAL_SWITCH_TICKS = 2

/** @deprecated fixed-timer phase — reactionary lights replace this. */
export const SIGNAL_PHASE_MS = SIGNAL_TICK_MS

/**
 * @param {number} elapsedMs
 * @returns {'H' | 'V'}
 * @deprecated use per-intersection signals from createReactionarySignals
 */
export function signalPhase(elapsedMs) {
  const cycle = SIGNAL_TICK_MS * 2
  const t = ((elapsedMs % cycle) + cycle) % cycle
  return t < SIGNAL_TICK_MS ? 'H' : 'V'
}

/**
 * Axis of a hop on the light grid.
 * @returns {'H' | 'V' | null}
 */
export function hopAxis(fromId, toId) {
  const a = lightRowCol(fromId)
  const b = lightRowCol(toId)
  if (!a || !b) return null
  if (a.row === b.row && a.col !== b.col) return 'H'
  if (a.col === b.col && a.row !== b.row) return 'V'
  return null
}

/**
 * @typedef {{ id: string, phase: 'H'|'V', countdown: number|null, tickAcc: number, waiters: number }} SignalState
 */

/**
 * Every paired intersection gets a reactionary light, random initial green axis.
 * @param {string[]} nodeIds
 * @param {() => number} rand
 * @returns {Map<string, SignalState>}
 */
export function createReactionarySignals(nodeIds, rand = Math.random) {
  /** @type {Map<string, SignalState>} */
  const signals = new Map()
  for (const raw of nodeIds || []) {
    const id = String(raw)
    if (!id || signals.has(id)) continue
    signals.set(id, {
      id,
      phase: rand() < 0.5 ? 'H' : 'V',
      countdown: null,
      tickAcc: 0,
      waiters: 0,
      switches: 0,
    })
  }
  return signals
}

/** Waiters are agents frozen approaching a destination light. */
export function countWaitersBySignal(agents) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const a of agents || []) {
    if (!a.waitingAtSignal || !a.heldChoice) continue
    const id = String(a.heldChoice)
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return counts
}

/**
 * Advance reactionary lights: demand → arm 2-tick countdown → switch.
 * @param {Map<string, SignalState>} signals
 * @param {Array<object>} agents
 * @param {number} dtMs
 */
export function stepSignals(signals, agents, dtMs) {
  if (!signals?.size) return signals
  const waiters = countWaitersBySignal(agents)

  for (const sig of signals.values()) {
    sig.waiters = waiters.get(sig.id) || 0
    sig.tickAcc += dtMs

    while (sig.tickAcc >= SIGNAL_TICK_MS) {
      sig.tickAcc -= SIGNAL_TICK_MS

      if (sig.waiters > 0) {
        if (sig.countdown == null) {
          // Arm: two full ticks of demand before flip.
          sig.countdown = SIGNAL_SWITCH_TICKS
        } else {
          sig.countdown -= 1
          if (sig.countdown <= 0) {
            sig.phase = sig.phase === 'H' ? 'V' : 'H'
            sig.countdown = null
            sig.switches = (sig.switches || 0) + 1
          }
        }
      } else {
        // No demand — cancel any pending switch.
        sig.countdown = null
      }
    }
  }
  return signals
}

export function getSignalPhase(signals, nodeId) {
  return signals?.get(String(nodeId))?.phase || null
}

/** True when the hop target is a signalized intersection. */
export function isApproachingSignal(fromId, heldChoice, signals) {
  if (!heldChoice) return false
  if (signals?.size) return signals.has(String(heldChoice))
  // Legacy fallback: stop-line → center.
  if (!STOP_LINES[fromId]) return false
  const toward = STOP_TOWARD[fromId] || SIGNAL_NODE_ID
  return String(heldChoice) === String(toward)
}

/**
 * Inbound traffic waits when the destination light's green axis ≠ hop axis.
 * @param {Map<string, SignalState>} [signals]
 */
export function canLeaveSignal(heldChoice, fromId, prevId, phaseOrSignals) {
  if (!heldChoice) return false

  /** @type {'H'|'V'|null} */
  let green = null
  if (phaseOrSignals && typeof phaseOrSignals === 'object' && typeof phaseOrSignals.get === 'function') {
    if (!isApproachingSignal(fromId, heldChoice, phaseOrSignals)) return true
    green = getSignalPhase(phaseOrSignals, heldChoice)
  } else {
    if (!isApproachingSignal(fromId, heldChoice, null)) return true
    green = phaseOrSignals || 'H'
  }
  if (!green) return true

  const axis = hopAxis(fromId, heldChoice) || STOP_LINES[fromId]
  if (!axis) return true
  return axis === green
}

/** @deprecated approach gating is destination-based now */
export function isGatedNode(id, signals) {
  if (signals?.size) return true
  return Boolean(STOP_LINES[id])
}

/**
 * @param {Array<{from:string,to:string,probability:number,count:number}>} transitions
 * @returns {Map<string, Array<{to:string, weight:number}>>}
 */
export function buildLocalChoiceTable(transitions) {
  /** @type {Map<string, Array<{to:string, weight:number}>>} */
  const raw = new Map()
  for (const t of transitions || []) {
    if (!t?.from || !t?.to) continue
    if (!raw.has(t.from)) raw.set(t.from, [])
    raw.get(t.from).push({ to: String(t.to), weight: Math.max(0, Number(t.probability) || 0) })
  }

  /** @type {Map<string, Array<{to:string, weight:number}>>} */
  const normalized = new Map()
  for (const [from, outs] of raw) {
    const total = outs.reduce((s, o) => s + o.weight, 0)
    if (total <= 0) {
      const u = 1 / outs.length
      normalized.set(
        from,
        outs.map((o) => ({ to: o.to, weight: u })),
      )
    } else {
      normalized.set(
        from,
        outs.map((o) => ({ to: o.to, weight: o.weight / total })),
      )
    }
  }
  return normalized
}

export function fillMissingChoices(adjacency, choices) {
  for (const [id, neighbors] of adjacency) {
    if (!neighbors.length) continue
    const existing = choices.get(id) || []
    const have = new Set(existing.map((o) => o.to))
    const merged = [...existing]
    for (const to of neighbors) {
      if (have.has(to)) continue
      merged.push({ to, weight: 0.2 })
    }
    if (!merged.length) continue
    const total = merged.reduce((s, o) => s + o.weight, 0) || merged.length
    choices.set(
      id,
      merged.map((o) => ({ to: o.to, weight: (o.weight || 1 / merged.length) / total })),
    )
  }
  return choices
}

export function buildPairAdjacency(pairs) {
  /** @type {Map<string, Set<string>>} */
  const adj = new Map()
  for (const p of pairs || []) {
    if (!p?.a || !p?.b || p.a === p.b) continue
    if (!adj.has(p.a)) adj.set(p.a, new Set())
    if (!adj.has(p.b)) adj.set(p.b, new Set())
    adj.get(p.a).add(p.b)
    adj.get(p.b).add(p.a)
  }
  /** @type {Map<string, string[]>} */
  const out = new Map()
  for (const [id, set] of adj) out.set(id, [...set])
  return out
}

/**
 * Hop-count shortest path on the pair graph (BFS).
 * @param {Map<string, string[]>} adjacency
 * @param {string} fromId
 * @param {string} toId
 * @returns {string[] | null} path including endpoints, or null if unreachable
 */
export function shortestPath(adjacency, fromId, toId) {
  const start = String(fromId)
  const goal = String(toId)
  if (start === goal) return [start]
  if (!adjacency.has(start) || !adjacency.has(goal)) return null

  /** @type {Map<string, string | null>} */
  const prev = new Map([[start, null]])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]
    for (const nb of adjacency.get(cur) || []) {
      if (prev.has(nb)) continue
      prev.set(nb, cur)
      if (nb === goal) {
        const path = [goal]
        let p = cur
        while (p != null) {
          path.push(p)
          p = prev.get(p) ?? null
        }
        path.reverse()
        return path
      }
      queue.push(nb)
    }
  }
  return null
}

/**
 * Aggregate attractor sites onto paired lights using category dest weights.
 * @param {Array<object>} attractors
 * @param {string[]} pairNodeIds
 * @param {Map<string, object>} graphNodes
 * @param {Record<string, number>} categoryWeights
 * @param {(a: {lat:number,lon:number}, b: {lat:number,lon:number}) => number} distFn
 * @returns {Array<{to:string, weight:number, category:string, name:string}>}
 */
export function buildDestOptions(attractors, pairNodeIds, graphNodes, categoryWeights, distFn) {
  const pairIds = (pairNodeIds || []).filter(Boolean)
  const pairSet = new Set(pairIds)
  if (!pairIds.length) return []

  const nearestPairId = (point) => {
    if (point.graphNodeId && pairSet.has(String(point.graphNodeId))) {
      return String(point.graphNodeId)
    }
    let best = null
    let bestD = Infinity
    for (const id of pairIds) {
      const node = graphNodes.get(id)
      if (!node) continue
      const d = distFn(point, node)
      if (d < bestD) {
        bestD = d
        best = id
      }
    }
    return best
  }

  /** @type {Map<string, {to:string, weight:number, category:string, name:string, topW:number}>} */
  const byLight = new Map()
  for (const a of attractors || []) {
    const cat = a.category || 'other'
    const w = Number(categoryWeights?.[cat] ?? a.weight) || 0
    if (w <= 0) continue
    const pairId = nearestPairId(a)
    if (!pairId) continue
    const existing = byLight.get(pairId)
    if (!existing) {
      byLight.set(pairId, {
        to: pairId,
        weight: w,
        category: cat,
        name: a.name || cat,
        topW: w,
      })
    } else {
      existing.weight += w
      if (w > existing.topW) {
        existing.category = cat
        existing.name = a.name || cat
        existing.topW = w
      }
    }
  }
  return [...byLight.values()].map(({ to, weight, category, name }) => ({
    to,
    weight,
    category,
    name,
  }))
}

function mulberry32(seed) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function pickWeighted(options, rand) {
  if (!options?.length) return null
  let r = rand() * options.reduce((s, o) => s + o.weight, 0)
  for (const o of options) {
    r -= o.weight
    if (r <= 0) return o.to
  }
  return options[options.length - 1].to
}

export function pickDestAwayFrom(spawnId, destOptions, rand, maxTries = 12) {
  const pool = (destOptions || []).filter((o) => o.to !== spawnId && o.weight > 0)
  if (!pool.length) return null
  for (let i = 0; i < maxTries; i++) {
    const to = pickWeighted(pool, rand)
    if (to && to !== spawnId) {
      const hit = pool.find((o) => o.to === to)
      return hit || { to, weight: 1, category: 'other', name: to }
    }
  }
  return pool[Math.floor(rand() * pool.length)] || null
}

function rollNext(fromId, choices, rand) {
  return pickWeighted(choices.get(fromId) || [], rand)
}

/** Next hop: follow predest path when present, else locked transition probs. */
function nextHopFor(a, choices, rand) {
  if (a.path?.length) {
    const idx = a.pathIndex ?? 0
    if (idx >= a.path.length - 1) return null
    return a.path[idx + 1] || null
  }
  return rollNext(a.fromId, choices, rand)
}

function markArrived(a) {
  if (a.done) return
  a.done = true
  a.toId = a.fromId
  a.waitingAtSignal = false
  a.heldChoice = null
  // Blow up at destination (animated in the RAF loop).
  a.vaporizing = true
  a.vaporizeAge = 0
  a.vaporized = false
}

function ease(t) {
  return t * t * (3 - 2 * t)
}

function placeOnHop(a, graphNodes, side = 0) {
  const from = graphNodes.get(a.fromId)
  const to = graphNodes.get(a.toId)
  if (!from || !to) return
  const t = Math.min(1, Math.max(0, a.progress))
  const e = ease(t)
  const dLat = to.lat - from.lat
  const dLon = to.lon - from.lon
  const len = Math.hypot(dLat, dLon) || 1
  a.lat = from.lat + dLat * e + (-dLon / len) * side
  a.lon = from.lon + dLon * e + (dLat / len) * side
}

/**
 * Gate departure toward a destination light.
 * While red, freeze mid-hop on from→heldChoice; green resumes that same hop.
 * @param {Map<string, SignalState>} signals
 */
function resolveGatedDeparture(a, choices, rand, signals, graphNodes, queueSlot = 0) {
  if (!a.heldChoice) {
    a.heldChoice = nextHopFor(a, choices, rand)
  }
  if (!a.heldChoice) {
    markArrived(a)
    return
  }

  // Hop target is always the held destination (keeps one continuous animation).
  a.toId = a.heldChoice

  if (!isApproachingSignal(a.fromId, a.heldChoice, signals)) {
    a.waitingAtSignal = false
    a.heldChoice = null
    if (!(a.progress > 0 && a.progress < 1)) a.progress = 0
    placeOnHop(a, graphNodes, 0)
    return
  }

  if (canLeaveSignal(a.heldChoice, a.fromId, a.prevId, signals)) {
    a.waitingAtSignal = false
    a.heldChoice = null
    if (!(a.progress > 0 && a.progress < 1)) a.progress = 0
    placeOnHop(a, graphNodes, 0)
  } else {
    if (!a.waitingAtSignal) {
      a.lightWaits = (a.lightWaits || 0) + 1
    }
    a.waitingAtSignal = true
    // Entering wait: sit between the lights on this hop.
    if (!(a.progress > 0.05 && a.progress < 0.95)) {
      a.progress = 0.38 + Math.min(queueSlot, 8) * 0.035
    }
    const side = (queueSlot % 2 === 0 ? 1 : -1) * (0.000035 + (queueSlot % 3) * 0.000012)
    placeOnHop(a, graphNodes, side)
  }
}

/**
 * Build spawn roster from a layout definition.
 * @param {object} layout
 * @param {string[]} pairNodeIds all paired light ids (for random spawns)
 * @param {() => number} rand
 */
export function createSpawnRosterFromLayout(layout, pairNodeIds, rand = Math.random) {
  const spawn = layout?.spawn || { mode: 'fixed' }
  const roster = []
  let n = 0

  if (spawn.mode === 'random') {
    const min = Math.max(1, Number(spawn.min) || 100)
    const max = Math.max(min, Number(spawn.max) || 500)
    const count = min + Math.floor(rand() * (max - min + 1))
    const pool = (pairNodeIds || []).filter(Boolean)
    if (!pool.length) return roster
    for (let i = 0; i < count; i++) {
      const spawnId = pool[Math.floor(rand() * pool.length)]
      roster.push({
        id: `r${n++}`,
        spawnId,
        kind: spawn.kind || 'wander',
        color: spawn.color || '#2a6f97',
      })
    }
    return roster
  }

  // Fixed groups (Layout 1 style).
  const groups = spawn.groups || [
    { ids: CORNER_SPAWNS, countEach: CORNER_COUNT, kind: 'corner', color: '#2a6f97' },
    { ids: COMPETE_SPAWNS, countEach: COMPETE_COUNT, kind: 'compete', color: '#c45c26' },
  ]
  for (const g of groups) {
    for (const spawnId of g.ids || []) {
      for (let i = 0; i < (g.countEach || 1); i++) {
        roster.push({
          id: `${g.kind || 'a'}${n++}`,
          spawnId: String(spawnId),
          kind: g.kind || 'corner',
          color: g.color || '#2a6f97',
        })
      }
    }
  }
  return roster
}

/** @deprecated prefer createSpawnRosterFromLayout */
export function createSpawnRoster() {
  return createSpawnRosterFromLayout({
    spawn: {
      mode: 'fixed',
      groups: [
        { ids: CORNER_SPAWNS, countEach: CORNER_COUNT, kind: 'corner', color: '#2a6f97' },
        { ids: COMPETE_SPAWNS, countEach: COMPETE_COUNT, kind: 'compete', color: '#c45c26' },
      ],
    },
  })
}

/**
 * @param {Array<object>} roster
 * @param {Map<string, Array<{to:string, weight:number}>>} choices
 * @param {Map<string, object>} graphNodes
 * @param {number} seed
 * @param {{
 *   predestination?: boolean,
 *   adjacency?: Map<string, string[]>,
 *   destOptions?: Array<{to:string, weight:number, category?:string, name?:string}>,
 *   destColors?: Record<string, string>,
 *   signals?: Map<string, SignalState>,
 * }} [opts]
 */
export function createAgents(roster, choices, graphNodes, seed = 11, opts = {}) {
  const rand = mulberry32(seed)
  const predestination = Boolean(opts.predestination)
  const adjacency = opts.adjacency || null
  const destOptions = opts.destOptions || []
  const destColors = opts.destColors || {}
  const signals = opts.signals || null

  return roster.map((r) => {
    const node = graphNodes.get(r.spawnId)
    let path = null
    let destId = null
    let destCategory = null
    let destName = null
    let color = r.color
    let kind = r.kind

    if (predestination && adjacency && destOptions.length) {
      const dest = pickDestAwayFrom(r.spawnId, destOptions, rand)
      if (dest) {
        const found = shortestPath(adjacency, r.spawnId, dest.to)
        if (found && found.length >= 2) {
          path = found
          destId = dest.to
          destCategory = dest.category || null
          destName = dest.name || dest.to
          kind = 'predest'
          if (destCategory && destColors[destCategory]) color = destColors[destCategory]
        }
      }
    }

    const firstOut = path ? path[1] : pickWeighted(choices.get(r.spawnId) || [], rand)
    const needsGate = Boolean(firstOut && isApproachingSignal(r.spawnId, firstOut, signals))
    const arrived = path && path.length === 1

    return {
      ...r,
      kind,
      color,
      fromId: r.spawnId,
      toId: firstOut || r.spawnId,
      prevId: null,
      progress: rand() * 0.15,
      lat: node?.lat ?? 0,
      lon: node?.lon ?? 0,
      done: arrived || !firstOut,
      heldChoice: needsGate ? firstOut : null,
      waitingAtSignal: false,
      queueSlot: 0,
      lightWaits: 0,
      path,
      pathIndex: path ? 0 : null,
      destId,
      destCategory,
      destName,
      vaporizing: false,
      vaporizeAge: 0,
      // Spawn-stuck agents count as already gone (no boom).
      vaporized: arrived || !firstOut,
    }
  })
}

/**
 * Advance path cursor after arriving at a node. Returns true if destination reached.
 */
function advancePath(a) {
  if (!a.path?.length) return false
  const idx = a.path.indexOf(a.fromId)
  a.pathIndex = idx >= 0 ? idx : (a.pathIndex ?? 0) + 1
  if (a.destId && a.fromId === a.destId) return true
  if (a.pathIndex >= a.path.length - 1) return true
  return false
}

/**
 * @param {Map<string, SignalState>} signals
 * @param {Array<{from:string,to:string}>} [hopSink] completed hops this frame
 */
export function stepAgents(
  agents,
  choices,
  graphNodes,
  dtMs,
  hopMs = HOP_DURATION_MS,
  rand,
  signals = null,
  hopSink = null,
) {
  const rate = dtMs / hopMs

  const noteHop = (fromId, toId) => {
    if (!hopSink || fromId == null || toId == null || fromId === toId) return
    hopSink.push({ from: String(fromId), to: String(toId) })
  }

  // Stable queue slots per approach for side offsets while waiting.
  const waitBuckets = new Map()
  for (const a of agents) {
    if (!a.waitingAtSignal || !a.heldChoice) continue
    const key = `${a.fromId}->${a.heldChoice}`
    if (!waitBuckets.has(key)) waitBuckets.set(key, [])
    waitBuckets.get(key).push(a)
  }
  for (const list of waitBuckets.values()) {
    list.forEach((a, i) => {
      a.queueSlot = i
    })
  }

  for (const a of agents) {
    if (a.done) continue

    if (a.progress < 0) {
      a.progress += rate
      if (a.progress >= 0 && a.heldChoice) {
        a.progress = 0
        resolveGatedDeparture(a, choices, rand, signals, graphNodes, a.queueSlot || 0)
      }
      continue
    }

    // Frozen mid-hop — green resumes the same lerp (no teleport).
    if (a.waitingAtSignal) {
      const wasWaiting = true
      const savedProgress = a.progress
      resolveGatedDeparture(a, choices, rand, signals, graphNodes, a.queueSlot || 0)
      // If still waiting, keep frozen. If released, advance this frame with same hop.
      if (!a.waitingAtSignal && wasWaiting) {
        a.progress = savedProgress + rate
        if (a.progress >= 1) {
          const to = graphNodes.get(a.toId)
          const hopFrom = a.fromId
          const hopTo = a.toId
          a.progress = 0
          a.prevId = a.fromId
          a.fromId = a.toId
          if (to) {
            a.lat = to.lat
            a.lon = to.lon
          }
          noteHop(hopFrom, hopTo)
          if (advancePath(a)) {
            markArrived(a)
          } else {
            resolveGatedDeparture(a, choices, rand, signals, graphNodes, 0)
          }
        } else {
          placeOnHop(a, graphNodes, 0)
        }
      }
      continue
    }

    const from = graphNodes.get(a.fromId)
    const to = graphNodes.get(a.toId)
    if (!from || !to) {
      markArrived(a)
      continue
    }

    a.progress += rate
    if (a.progress >= 1) {
      const hopFrom = a.fromId
      const hopTo = a.toId
      a.progress = 0
      a.prevId = a.fromId
      a.fromId = a.toId
      a.lat = to.lat
      a.lon = to.lon
      noteHop(hopFrom, hopTo)

      if (advancePath(a)) {
        markArrived(a)
        continue
      }

      resolveGatedDeparture(a, choices, rand, signals, graphNodes, 0)
    } else {
      placeOnHop(a, graphNodes, 0)
    }
  }

  return agents
}

export function makeAnimRand(seed = 11) {
  return mulberry32(seed)
}

export function countWaiting(agents) {
  return agents.filter((a) => a.waitingAtSignal).length
}

export function countWaitingByAxis(agents) {
  let H = 0
  let V = 0
  for (const a of agents) {
    if (!a.waitingAtSignal) continue
    const axis = hopAxis(a.fromId, a.heldChoice || a.toId) || STOP_LINES[a.fromId]
    if (axis === 'H') H += 1
    else if (axis === 'V') V += 1
  }
  return { H, V }
}

export function countSignalsByPhase(signals) {
  let H = 0
  let V = 0
  let counting = 0
  for (const sig of signals?.values() || []) {
    if (sig.phase === 'H') H += 1
    else V += 1
    if (sig.countdown != null) counting += 1
  }
  return { H, V, counting }
}
