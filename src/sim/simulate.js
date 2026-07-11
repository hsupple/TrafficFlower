import { haversineMeters, buildThroughputSites } from './attractors.js'

function mulberry32(seed) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const φ1 = toRad(a.lat)
  const φ2 = toRad(b.lat)
  const Δλ = toRad(b.lon - a.lon)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function angleDiffDeg(a, b) {
  let d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * Build bidirectional adjacency from user-defined pairs.
 * These edges are the ONLY legal agent moves.
 *
 * @param {Array<{a: string, b: string}>} pairs
 * @returns {Map<string, string[]>}
 */
export function buildPairAdjacency(pairs) {
  /** @type {Map<string, Set<string>>} */
  const adj = new Map()
  const add = (from, to) => {
    if (!adj.has(from)) adj.set(from, new Set())
    adj.get(from).add(to)
  }
  for (const p of pairs) {
    if (!p?.a || !p?.b || p.a === p.b) continue
    add(p.a, p.b)
    add(p.b, p.a)
  }
  /** @type {Map<string, string[]>} */
  const out = new Map()
  for (const [id, set] of adj) out.set(id, [...set])
  return out
}

/**
 * Score legal pair-neighbors only (1 neighbor → 100%, else weighted).
 */
export function neighborScores(fromId, prevId, graphNodes, adjacency, attractors, weights) {
  const from = graphNodes.get(fromId)
  if (!from) return []

  const neighbors = (adjacency.get(fromId) || []).filter((id) => graphNodes.has(id))
  if (!neighbors.length) return []

  if (neighbors.length === 1) {
    return [{ id: neighbors[0], score: 1, probability: 1 }]
  }

  const falloff = weights.distance_falloff_meters ?? 450
  const backtrackPenalty = weights.backtrack_penalty ?? 0.85
  const momentum = weights.momentum ?? 2.2
  const scored = []

  const inboundBearing =
    prevId && graphNodes.has(prevId) ? bearingDeg(graphNodes.get(prevId), from) : null

  for (const nid of neighbors) {
    const to = graphNodes.get(nid)
    if (!to) continue

    let score = 1

    if (prevId && nid === prevId) {
      score *= Math.max(0.02, 1 - backtrackPenalty)
    }

    if (inboundBearing != null) {
      const outbound = bearingDeg(from, to)
      const turn = angleDiffDeg(inboundBearing, outbound)
      const forward = Math.max(0, 1 - turn / 180)
      score *= 1 + momentum * forward
    }

    for (const a of attractors) {
      if (!a.weight) continue
      const dFrom = haversineMeters(from, a)
      const dTo = haversineMeters(to, a)
      if (dTo >= dFrom) continue
      const proximity = Math.exp(-dFrom / falloff)
      const progress = (dFrom - dTo) / (dFrom + 1)
      score += a.weight * proximity * progress
    }

    scored.push({ id: nid, score: Math.max(score, 0.0001) })
  }

  const total = scored.reduce((s, x) => s + x.score, 0)
  return scored.map((x) => ({
    ...x,
    probability: x.score / total,
  }))
}

function pickNeighbor(choices, rand) {
  let r = rand()
  for (const c of choices) {
    r -= c.probability
    if (r <= 0) return c.id
  }
  return choices[choices.length - 1]?.id ?? null
}

export function pickRandomNodeId(nodeIds, rand) {
  return nodeIds[Math.floor(rand() * nodeIds.length)]
}

function pickWeightedSource(sources, rand) {
  if (!sources.length) return null
  const total = sources.reduce((s, x) => s + (x.spawnWeight || 1), 0)
  let r = rand() * total
  for (const src of sources) {
    r -= src.spawnWeight || 1
    if (r <= 0) return src
  }
  return sources[sources.length - 1]
}

/**
 * Agents move ONLY along user pairs.
 * Throughput: most agents spawn at parking sources and stop when they reach a food sink.
 */
export function runSimulation({
  graphNodes,
  attractors,
  pairs,
  weights,
  agents,
  steps,
  seed = 42,
}) {
  const rand = mulberry32(seed)
  const adjacency = buildPairAdjacency(pairs || [])
  const nodeIds = [...adjacency.keys()].filter((id) => graphNodes.has(id))
  const pathSampleLimit = weights.path_sample_agents ?? 40
  const throughput = weights.throughput ?? {}
  const sourceSpawnShare = Math.min(1, Math.max(0, throughput.source_spawn_share ?? 0.85))
  const stopAtSinks = throughput.stop_at_sinks !== false

  if (!nodeIds.length) {
    throw new Error('No usable pairs — add pairs before running the sim.')
  }

  const sites = buildThroughputSites(attractors, nodeIds, graphNodes)
  const sinkIds = stopAtSinks ? sites.sinkNodeIds : new Set()

  /** @type {Map<string, Map<string, number>>} */
  const counts = new Map()
  const ensure = (a, b) => {
    if (!counts.has(a)) counts.set(a, new Map())
    const row = counts.get(a)
    row.set(b, (row.get(b) || 0) + 1)
  }

  let totalSteps = 0
  let stoppedAtSink = 0
  let spawnedFromSource = 0
  /** @type {Array<{lat:number, lon:number, id:string, kind:string, label?:string}>} */
  const spawns = []
  /** @type {Array<Array<[number, number]>>} */
  const samplePaths = []

  for (let a = 0; a < agents; a++) {
    let current
    let spawnKind = 'random'
    let spawnLabel

    if (sites.sources.length && rand() < sourceSpawnShare) {
      const src = pickWeightedSource(sites.sources, rand)
      current = src.pairNodeId
      spawnKind = 'parking'
      spawnLabel = src.name
      spawnedFromSource += 1
    } else {
      current = pickRandomNodeId(nodeIds, rand)
    }

    let prev = null

    const spawnNode = graphNodes.get(current)
    spawns.push({
      id: current,
      lat: spawnNode.lat,
      lon: spawnNode.lon,
      kind: spawnKind,
      label: spawnLabel,
    })

    const recordPath = a < pathSampleLimit
    /** @type {Array<[number, number]>} */
    const path = recordPath ? [[spawnNode.lat, spawnNode.lon]] : null

    for (let t = 0; t < steps; t++) {
      const choices = neighborScores(
        current,
        prev,
        graphNodes,
        adjacency,
        attractors,
        weights,
      )
      if (!choices.length) break

      const next = pickNeighbor(choices, rand)
      const legal = adjacency.get(current) || []
      if (!next || !legal.includes(next)) break

      const toNode = graphNodes.get(next)
      ensure(current, next)
      totalSteps += 1

      prev = current
      current = next

      if (recordPath) path.push([toNode.lat, toNode.lon])

      // Arrived at a food (or other) sink — stop and count as throughput arrival.
      if (sinkIds.has(current)) {
        stoppedAtSink += 1
        break
      }
    }

    if (recordPath && path.length > 1) samplePaths.push(path)
  }

  const transitions = []
  for (const [from, row] of counts) {
    const fromTotal = [...row.values()].reduce((s, n) => s + n, 0)
    for (const [to, count] of row) {
      transitions.push({
        from,
        to,
        count,
        probability: fromTotal ? count / fromTotal : 0,
      })
    }
  }
  transitions.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))

  return {
    agents,
    steps,
    seed,
    totalSteps,
    lightHops: totalSteps,
    lightCount: nodeIds.length,
    pairCount: pairs.length,
    attractorCount: attractors.length,
    transitions,
    counts,
    spawns,
    samplePaths,
    adjacency,
    throughput: {
      spawnedFromSource,
      stoppedAtSink,
      sourceCount: sites.sources.length,
      sinkCount: sites.sinks.length,
      sourceSpawnShare,
    },
  }
}

export function transitionsToCsv(result) {
  const header = 'from_node,to_node,count,probability'
  const lines = result.transitions.map(
    (t) => `${t.from},${t.to},${t.count},${t.probability.toFixed(6)}`,
  )
  return [header, ...lines].join('\n')
}

export function transitionsToJson(result) {
  return JSON.stringify(
    {
      meta: {
        agents: result.agents,
        steps: result.steps,
        seed: result.seed,
        totalSteps: result.totalSteps,
        pairCount: result.pairCount,
        nodeCount: result.lightCount,
        attractorCount: result.attractorCount,
        spawnCount: result.spawns?.length ?? 0,
        throughput: result.throughput ?? null,
      },
      transitions: result.transitions,
    },
    null,
    2,
  )
}
