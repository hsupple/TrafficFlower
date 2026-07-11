/**
 * Parse OpenStreetMap XML (.osm) into nodes, ways, and a driving-only road graph.
 * Edges exist only between consecutive <nd> refs on a driving highway way —
 * agents can never jump to a non-adjacent node.
 */

/** Car-drivable OSM highway values only. */
const DRIVING_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
])

function tagsFromElement(el) {
  const tags = {}
  for (const tag of el.getElementsByTagName('tag')) {
    const k = tag.getAttribute('k')
    const v = tag.getAttribute('v')
    if (k) tags[k] = v ?? ''
  }
  return tags
}

function isDrivingWay(tags) {
  return DRIVING_HIGHWAYS.has(tags.highway)
}

/**
 * @param {string} xmlText
 * @returns {{ nodes: Map<string, object>, ways: Map<string, object>, bounds: object|null }}
 */
export function parseOsm(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parseError = doc.querySelector('parsererror')
  if (parseError) {
    throw new Error('Invalid OSM XML — could not parse the file.')
  }

  const osmRoot = doc.querySelector('osm')
  if (!osmRoot) {
    throw new Error('Not a valid .osm file — missing <osm> root.')
  }

  const nodes = new Map()
  for (const el of osmRoot.getElementsByTagName('node')) {
    const id = el.getAttribute('id')
    const lat = Number(el.getAttribute('lat'))
    const lon = Number(el.getAttribute('lon'))
    if (!id || Number.isNaN(lat) || Number.isNaN(lon)) continue
    nodes.set(id, {
      id,
      lat,
      lon,
      tags: tagsFromElement(el),
    })
  }

  const ways = new Map()
  for (const el of osmRoot.getElementsByTagName('way')) {
    const id = el.getAttribute('id')
    if (!id) continue
    const tags = tagsFromElement(el)
    const refs = []
    for (const nd of el.getElementsByTagName('nd')) {
      const ref = nd.getAttribute('ref')
      if (ref && nodes.has(ref)) refs.push(ref)
    }
    if (refs.length < 2) continue
    ways.set(id, {
      id,
      refs,
      tags,
      isRoad: isDrivingWay(tags),
    })
  }

  let bounds = null
  const boundsEl = osmRoot.querySelector('bounds')
  if (boundsEl) {
    bounds = {
      minlat: Number(boundsEl.getAttribute('minlat')),
      minlon: Number(boundsEl.getAttribute('minlon')),
      maxlat: Number(boundsEl.getAttribute('maxlat')),
      maxlon: Number(boundsEl.getAttribute('maxlon')),
    }
  }

  return { nodes, ways, bounds }
}

/**
 * Build an undirected adjacency graph from driving ways only.
 * Each edge links two nodes that are consecutive on an OSM way (exactly next to each other).
 */
export function buildGraph(nodes, ways) {
  /** @type {Map<string, Set<string>>} */
  const adjacency = new Map()
  /** @type {Map<string, Set<string>>} */
  const nodeWays = new Map()

  const ensure = (id) => {
    if (!adjacency.has(id)) adjacency.set(id, new Set())
    if (!nodeWays.has(id)) nodeWays.set(id, new Set())
  }

  for (const way of ways.values()) {
    if (!way.isRoad) continue
    for (let i = 0; i < way.refs.length; i++) {
      const id = way.refs[i]
      ensure(id)
      nodeWays.get(id).add(way.id)
      if (i > 0) {
        const prev = way.refs[i - 1]
        ensure(prev)
        adjacency.get(prev).add(id)
        adjacency.get(id).add(prev)
      }
    }
  }

  const graphNodes = new Map()
  for (const [id, neighbors] of adjacency) {
    const base = nodes.get(id)
    if (!base) continue
    const degree = neighbors.size
    const wayIds = [...(nodeWays.get(id) ?? [])]
    const isJunction = degree >= 3 || Boolean(base.tags.highway === 'traffic_signals' || base.tags.junction)
    graphNodes.set(id, {
      ...base,
      degree,
      neighbors: [...neighbors],
      wayIds,
      isJunction,
    })
  }

  return { graphNodes, adjacency, nodeWays }
}
