/**
 * Pull POI attractors out of OSM nodes/ways using weights.json match rules,
 * then snap each attractor to the nearest road-graph node.
 */

const EARTH_M = 6371000

export function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function matchesCategory(tags, match) {
  for (const [key, values] of Object.entries(match)) {
    const v = tags[key]
    if (v && values.includes(v)) return true
  }
  return false
}

function wayCentroid(way, nodes) {
  let lat = 0
  let lon = 0
  let n = 0
  for (const id of way.refs) {
    const node = nodes.get(id)
    if (!node) continue
    lat += node.lat
    lon += node.lon
    n += 1
  }
  if (!n) return null
  return { lat: lat / n, lon: lon / n }
}

function nearestGraphNode(point, graphNodes, maxMeters) {
  let best = null
  let bestD = Infinity
  for (const node of graphNodes.values()) {
    const d = haversineMeters(point, node)
    if (d < bestD) {
      bestD = d
      best = node
    }
  }
  if (!best || bestD > maxMeters) return null
  return { node: best, distance: bestD }
}

/**
 * @param {Map<string, object>} nodes all OSM nodes
 * @param {Map<string, object>} ways all OSM ways
 * @param {Map<string, object>} graphNodes road graph
 * @param {object} weights weights.json
 */
export function buildAttractors(nodes, ways, graphNodes, weights) {
  const snapMeters = weights.poi_snap_meters ?? 120
  const categories = weights.attractors ?? {}
  /** @type {Array<object>} */
  const attractors = []

  const consider = (tags, lat, lon, sourceId, sourceKind) => {
    for (const [category, cfg] of Object.entries(categories)) {
      if (!cfg?.match || !matchesCategory(tags, cfg.match)) continue
      const snap = nearestGraphNode({ lat, lon }, graphNodes, snapMeters)
      if (!snap) continue
      attractors.push({
        category,
        weight: Number(cfg.weight) || 0,
        spawnWeight: Number(cfg.spawn_weight ?? cfg.weight) || 1,
        role: cfg.role || 'attract',
        lat,
        lon,
        sourceId,
        sourceKind,
        name: tags.name || tags.ref || category,
        graphNodeId: snap.node.id,
        snapMeters: snap.distance,
      })
    }
  }

  for (const node of nodes.values()) {
    consider(node.tags, node.lat, node.lon, node.id, 'node')
  }

  for (const way of ways.values()) {
    const c = wayCentroid(way, nodes)
    if (!c) continue
    consider(way.tags, c.lat, c.lon, way.id, 'way')
  }

  return attractors
}

/** Major traffic-signal nodes on the road graph (not every crosswalk). */
export function findLightNodes(graphNodes) {
  const lights = []
  for (const node of graphNodes.values()) {
    const t = node.tags
    // Only real signalized intersections — crossings are too dense and cause local clusters.
    if (t.highway === 'traffic_signals') lights.push(node)
  }
  return lights
}

/**
 * Map attractors with role source/sink onto the nearest paired node IDs.
 * @returns {{ sources: Array<object>, sinks: Array<object>, sourceNodeIds: string[], sinkNodeIds: Set<string> }}
 */
export function buildThroughputSites(attractors, pairNodeIds, graphNodes) {
  const pairIds = [...pairNodeIds]
  const pairSet = new Set(pairIds)

  const nearestPairId = (point) => {
    if (point.graphNodeId && pairSet.has(point.graphNodeId)) return point.graphNodeId
    let best = null
    let bestD = Infinity
    for (const id of pairIds) {
      const node = graphNodes.get(id)
      if (!node) continue
      const d = haversineMeters(point, node)
      if (d < bestD) {
        bestD = d
        best = id
      }
    }
    return best
  }

  const sources = []
  const sinks = []
  for (const a of attractors) {
    const pairId = nearestPairId(a)
    if (!pairId) continue
    const site = { ...a, pairNodeId: pairId }
    if (a.role === 'source') sources.push(site)
    if (a.role === 'sink') sinks.push(site)
  }

  return {
    sources,
    sinks,
    sourceNodeIds: sources.map((s) => s.pairNodeId),
    sinkNodeIds: new Set(sinks.map((s) => s.pairNodeId)),
  }
}
