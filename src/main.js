import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { parseOsm, buildGraph } from './osmParser.js'
import { buildAttractors, findLightNodes, haversineMeters } from './sim/attractors.js'
import {
  runSimulation,
  transitionsToCsv,
  transitionsToJson,
} from './sim/simulate.js'
import weights from './sim/weights.json'
import savedPairs from './sim/trafficflower-pairs.json'
import savedTransitions from './sim/trafficflower-transitions.json'
import {
  FOCUS_CENTER_ID,
  focusNeighborhoodIds,
  filterPairsToFocus,
  filterTransitionsToFocus,
} from './sim/focusIntersection.js'
import {
  HOP_DURATION_MS,
  SIGNAL_NODE_ID,
  SIGNAL_TICK_MS,
  applyLayoutSignal,
  getStopLineIds,
  buildLocalChoiceTable,
  buildPairAdjacency,
  fillMissingChoices,
  createSpawnRosterFromLayout,
  createAgents,
  createReactionarySignals,
  stepAgents,
  stepSignals,
  makeAnimRand,
  countWaiting,
  countWaitingByAxis,
  countSignalsByPhase,
  buildDestOptions,
} from './sim/intersectionAnim.js'
import layoutsDoc from './sim/layouts.json'
import {
  appendSimLog,
  defaultLogNameForLayout,
  formatSimLogLine,
  slugifyLogName,
} from './sim/simLog.js'
import {
  createHopTally,
  recordHop,
  foundProbability,
  hopCount,
  fromTotal,
  avgFoundGivenDeviationPct,
  mergeFoundIntoTransitions,
} from './sim/hopTally.js'
import './style.css'

const DEST_COLORS = {
  food_high: '#c45c26',
  food: '#e07a5f',
  food_low: '#f0a35e',
  drink: '#2a6f97',
  park: '#81b29a',
  transit: '#3d5a52',
  library: '#6b5b95',
  parking: '#1d3557',
  shop: '#bc6c25',
  culture: '#9b2226',
}

/** Live agent-characteristic knobs (Intersection tab). Predestination on by default. */
/** Live agent-characteristic knobs (Intersection tab). Predestination on by default. */
const agentTraits = {
  predestination: true,
  agentCount: 200,
  /** @type {Record<string, number>} */
  destWeights: {},
}

function initDestWeights() {
  const cats = weights.attractors || {}
  for (const [key, cfg] of Object.entries(cats)) {
    const nav = Number(cfg.weight) || 0
    const spawn = Number(cfg.spawn_weight) || 0
    // Parking is a source in the network sim (nav weight 0) — still allow it as a dest here.
    agentTraits.destWeights[key] = nav > 0 ? nav : spawn > 0 ? spawn : 0
  }
}

initDestWeights()

const osmAssets = import.meta.glob('./assets/osm/*.osm', {
  query: '?url',
  import: 'default',
  eager: true,
})

const state = {
  nodes: new Map(),
  ways: new Map(),
  graphNodes: new Map(),
  osmBounds: null,
  attractors: [],
  lights: [],
  simResult: null,
  tracked: new Set(),
  selectedId: null,
  fileName: null,
  map: null,
  pairMode: false,
  pairPending: null,
  /** @type {'network' | 'intersection'} */
  viewMode: 'intersection',
  focusIds: focusNeighborhoodIds(FOCUS_CENTER_ID, 2),
  /** @type {Array<{a: string, b: string}>} */
  pairs: [],
  /**
   * Session hop tallies — survive Reset + Vite HMR; clear only on full page reload.
   * Instant ×N and Play all append into this same tally (found % / green labels).
   */
  sessionHopTally:
    (import.meta.hot && import.meta.hot.data.sessionHopTally) || createHopTally(),
  anim: {
    running: false,
    raf: 0,
    lastTs: 0,
    signalElapsed: 0,
    signalMarkers: new Map(),
    agents: [],
    markers: new Map(),
    choices: null,
    rand: null,
    layoutId: layoutsDoc.active || 'default',
    /** @type {Map<string, object>|null} */
    signals: null,
    /** @type {null | object} */
    runStats: null,
    runLogged: false,
    /** @type {Array<{key:string, tag:string, dest:string}>} */
    killFeed: [],
  },
  layers: {
    ways: null,
    nodes: null,
    tracked: null,
    lights: null,
    attractors: null,
    flows: null,
    paths: null,
    spawns: null,
    pairs: null,
    agents: null,
  },
}

function renderShell() {
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div class="brand-text">
            <h1>TrafficFlower</h1>
            <p>Intersection signal streams</p>
          </div>
        </div>
        <nav class="view-tabs" aria-label="View">
          <button type="button" class="view-tab is-active" data-view="intersection">Intersection</button>
          <button type="button" class="view-tab" data-view="network">Network</button>
        </nav>
        <p class="source" id="osm-source">Loading map.osm…</p>
      </header>

      <main class="workspace">
        <section class="map-pane" aria-label="Network map">
          <div id="map"></div>
          <div class="sim-loading" id="sim-loading" hidden>
            <div class="sim-loading-card">
              <p class="sim-loading-title">Running instant sims</p>
              <p class="sim-loading-progress" id="sim-loading-progress">0 / 0</p>
              <div class="sim-loading-bar"><span id="sim-loading-bar"></span></div>
            </div>
          </div>
          <div class="killfeed" id="killfeed" aria-label="Killfeed">
            <div class="killfeed-list" id="killfeed-list" aria-live="polite"></div>
          </div>
          <div class="empty" id="empty-state">
            <h2>Building network</h2>
            <p>Loading OpenStreetMap data from <code>assets/osm</code>.</p>
          </div>
        </section>

        <aside class="side" aria-label="Simulation">
          <div class="stats" id="stats">
            <div class="stat"><span class="stat-label">Nodes</span><span class="stat-value" data-k="nodes">—</span></div>
            <div class="stat"><span class="stat-label">Lights</span><span class="stat-value" data-k="lights">—</span></div>
            <div class="stat"><span class="stat-label">POIs</span><span class="stat-value" data-k="pois">—</span></div>
          </div>

          <div class="panel focus-panel" id="focus-panel" hidden>
            <h3>Focus intersection</h3>
            <p class="muted" id="focus-blurb"></p>
            <label class="layout-pick">
              Layout
              <select id="layout-select"></select>
            </label>
            <div class="actions instant-actions">
              <button type="button" class="primary" id="anim-play">Play streams</button>
              <button type="button" class="ghost" id="anim-reset">Reset</button>
              <button type="button" class="ghost" id="anim-instant">Run instant</button>
              <label class="instant-runs-pick">
                ×
                <input type="number" id="instant-runs" min="1" max="5000" step="1" value="1" title="How many instant runs" />
              </label>
              <button type="button" class="ghost" id="anim-capture" title="Replace locked given % with live found %">Capture found</button>
            </div>
            <label class="layout-pick log-file-pick">
              Sim log file
              <input type="text" id="sim-log-file" spellcheck="false" autocomplete="off" />
            </label>
            <p class="muted tiny" id="sim-log-status">Finished Play runs and each Instant batch append one line to <code>logs/&lt;name&gt;.log</code>. Set × for batch size. Requires <code>npm run dev</code>.</p>
            <p class="muted" id="anim-status">Loading layout…</p>
            <div class="vapor-stats" id="vapor-stats" aria-live="polite">
              <div class="vapor-stat is-alive">
                <span class="vapor-label">Alive</span>
                <strong id="alive-count">0</strong>
              </div>
              <div class="vapor-stat is-vapor">
                <span class="vapor-label">Vaporized</span>
                <strong id="vapor-count">0</strong>
              </div>
              <div class="vapor-stat is-dev">
                <span class="vapor-label">Avg deviation</span>
                <strong id="avg-deviation">—</strong>
              </div>
              <div class="vapor-stat is-hops">
                <span class="vapor-label">Live hops</span>
                <strong id="live-hops">0</strong>
              </div>
            </div>
            <ul class="pair-list" id="focus-light-list"></ul>
          </div>

          <div class="panel agent-panel" id="agent-panel" hidden>
            <h3>Agent characteristics</h3>
            <p class="muted">Semi-experimental knobs for the intersection streams. Predestination picks a POI-weighted light and follows the shortest pair path; agents still wait on the center signal ticks.</p>
            <label class="trait-toggle">
              <input type="checkbox" id="predest-enabled" checked />
              <span>Predestination</span>
            </label>
            <div class="sim-fields agent-fields" id="predest-fields">
              <label>
                Agents
                <input type="number" id="agent-count" min="10" max="2000" step="10" value="200" />
              </label>
            </div>
            <div class="dest-weights" id="dest-weight-list"></div>
            <p class="muted tiny" id="predest-hint">Dest weights pull which light an agent is assigned. Parking uses spawn_weight when nav weight is 0.</p>
          </div>

          <div class="panel pair-panel" data-network-only>
            <h3>Node pairs</h3>
            <p class="muted" id="pair-hint">These pairs are the only legal agent moves. Edit in pair mode or load from <code>trafficflower-pairs.json</code>.</p>
            <div class="actions">
              <button type="button" class="primary" id="toggle-pair-mode">Pair mode</button>
              <button type="button" class="ghost" id="export-pairs" disabled>Export pairs</button>
              <button type="button" class="ghost" id="clear-pairs" disabled>Clear</button>
            </div>
            <ul class="pair-list" id="pair-list">
              <li class="muted-item">No pairs yet</li>
            </ul>
          </div>

          <div class="panel sim-panel" data-network-only>
            <h3>Agent sim</h3>
            <p class="muted">Most agents leave parking lots, follow pairs toward food attractors, and stop when they arrive at a restaurant or cafe.</p>
            <div class="sim-fields">
              <label>
                Agents
                <input type="number" id="sim-agents" min="1" max="50000" value="20000" />
              </label>
              <label>
                Time (steps)
                <input type="number" id="sim-steps" min="1" max="100000" value="20000" />
              </label>
            </div>
            <div class="actions">
              <button type="button" class="primary" id="run-sim">Run sim</button>
              <button type="button" class="ghost" id="export-csv" disabled>Export CSV</button>
              <button type="button" class="ghost" id="export-json" disabled>Export JSON</button>
            </div>
            <p class="sim-status muted" id="sim-status">Ready</p>
          </div>

          <div class="panel weights-panel" data-network-only>
            <h3>Attractor weights</h3>
            <ul class="weight-list" id="weight-list"></ul>
          </div>

          <div class="panel results-panel">
            <div class="panel-head">
              <h3 id="results-heading">Pair → pair hops</h3>
              <span class="pill" id="hop-pill">no run</span>
            </div>
            <div class="results-scroll" id="results-table">
              <p class="muted">Run a sim to see P(to | from) between traffic lights.</p>
            </div>
          </div>

          <div class="panel" id="detail-panel">
            <h3>Select a node</h3>
            <p class="muted">Click any point on the map to inspect it.</p>
          </div>
        </aside>
      </main>
    </div>
  `
}

function initMap() {
  state.map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView([40.7128, -74.006], 13)

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(state.map)

  state.layers.ways = L.layerGroup().addTo(state.map)
  state.layers.flows = L.layerGroup().addTo(state.map)
  state.layers.paths = L.layerGroup().addTo(state.map)
  state.layers.pairs = L.layerGroup().addTo(state.map)
  state.layers.nodes = L.layerGroup().addTo(state.map)
  state.layers.attractors = L.layerGroup().addTo(state.map)
  state.layers.lights = L.layerGroup().addTo(state.map)
  state.layers.spawns = L.layerGroup().addTo(state.map)
  state.layers.tracked = L.layerGroup().addTo(state.map)
  state.layers.agents = L.layerGroup().addTo(state.map)
}

function updateStats() {
  const el = document.getElementById('stats')
  if (!el) return
  el.querySelector('[data-k="nodes"]').textContent = String(state.graphNodes.size)
  el.querySelector('[data-k="lights"]').textContent = String(state.lights.length)
  el.querySelector('[data-k="pois"]').textContent = String(state.attractors.length)
}

function activePairs() {
  return state.pairs
}

function activeTransitions(result) {
  if (!result?.transitions) return []
  return result.transitions
}

function getActiveLayout() {
  const id = state.anim.layoutId || layoutsDoc.active || 'default'
  return layoutsDoc.layouts[id] || layoutsDoc.layouts.default
}

function populateLayoutSelect() {
  const sel = document.getElementById('layout-select')
  if (!sel) return
  const entries = Object.values(layoutsDoc.layouts || {})
  sel.innerHTML = entries
    .map(
      (l) =>
        `<option value="${escapeHtml(l.id)}"${l.id === state.anim.layoutId ? ' selected' : ''}>${escapeHtml(l.name || l.id)}</option>`,
    )
    .join('')
}

function setActiveLayout(layoutId) {
  if (!layoutsDoc.layouts[layoutId]) return
  state.anim.layoutId = layoutId
  layoutsDoc.active = layoutId
  const layout = getActiveLayout()
  applyLayoutSignal(layout.signal)
  populateLayoutSelect()
  syncLogFileInput(layout, { forceDefault: true })
  if (state.viewMode === 'intersection') {
    resetIntersectionAnim()
    playIntersectionAnim()
  }
  renderFocusPanel()
}

function syncLogFileInput(layout = getActiveLayout(), { forceDefault = false } = {}) {
  const input = document.getElementById('sim-log-file')
  if (!input) return
  if (forceDefault || !input.value.trim()) {
    input.value = defaultLogNameForLayout(layout)
  }
}

function getSelectedLogFileName() {
  const input = document.getElementById('sim-log-file')
  const layout = getActiveLayout()
  const raw = input?.value?.trim() || defaultLogNameForLayout(layout)
  return slugifyLogName(raw)
}

function beginRunStats() {
  const layout = getActiveLayout()
  state.anim.runLogged = false
  state.anim.signalElapsed = 0
  state.anim.runStats = {
    // Wall-clock spawn moment (reload / Reset / layout change).
    spawnedAt: new Date().toISOString(),
    startedAt: performance.now(),
    layoutId: layout.id,
    layoutName: layout.name || layout.id,
    agents: state.anim.agents.length,
    peakWaiting: 0,
    predestination: agentTraits.predestination,
  }
  const status = document.getElementById('sim-log-status')
  if (status) {
    const file = getSelectedLogFileName()
    status.textContent = `Run spawned → will append a new line to logs/${file}.log when Alive hits 0.`
  }
}

function getGivenTransitions() {
  return state.simResult?.transitions || savedTransitions.transitions || []
}

function currentAvgDeviation() {
  return avgFoundGivenDeviationPct(state.sessionHopTally, getGivenTransitions())
}

/** Refresh green found % on the map + results table from the session tally. */
function refreshFoundDisplay() {
  const result =
    state.simResult ||
    (savedTransitions?.transitions?.length
      ? {
          totalSteps: savedTransitions.meta?.totalSteps ?? 0,
          transitions: savedTransitions.transitions,
          spawns: savedTransitions.spawns || [],
        }
      : null)
  if (!result) return
  if (!state.simResult) state.simResult = result
  renderResults(result)
  drawFlows(result)
}

function collectRunStats() {
  const layout = getActiveLayout()
  const { alive, vaporized } = countAliveVaporized(state.anim.agents)
  const by = countWaitingByAxis(state.anim.agents)
  const waiting = countWaiting(state.anim.agents)
  const stats = state.anim.runStats || {}
  if (waiting > (stats.peakWaiting || 0)) stats.peakWaiting = waiting

  let switches = 0
  for (const sig of state.anim.signals?.values() || []) {
    switches += sig.switches || 0
  }

  const paths = state.anim.agents.filter((a) => a.path?.length)
  const hops = paths.map((a) => Math.max(0, (a.path?.length || 1) - 1))
  const avgPathHops = hops.length
    ? Number((hops.reduce((s, n) => s + n, 0) / hops.length).toFixed(2))
    : 0
  const maxPathHops = hops.length ? Math.max(...hops) : 0

  const waitCounts = state.anim.agents.map((a) => a.lightWaits || 0)
  const totalLightWaits = waitCounts.reduce((s, n) => s + n, 0)
  const avgWait = waitCounts.length
    ? Number((totalLightWaits / waitCounts.length).toFixed(3))
    : 0
  const maxWait = waitCounts.length ? Math.max(...waitCounts) : 0

  const { avgDeviationPct, comparedEdges } = avgFoundGivenDeviationPct(
    state.sessionHopTally,
    getGivenTransitions(),
  )

  // Sim clock: spawn → alive=0 (only advances while the anim is playing).
  const durationMs = Math.round(state.anim.signalElapsed || 0)
  const ticks = Math.floor(durationMs / SIGNAL_TICK_MS)

  return {
    ts: new Date().toISOString(),
    spawnedAt: stats.spawnedAt || null,
    layoutId: layout.id,
    layoutName: layout.name || layout.id,
    logFile: `${getSelectedLogFileName()}.log`,
    durationMs,
    durationSec: Number((durationMs / 1000).toFixed(2)),
    ticks,
    tickMs: SIGNAL_TICK_MS,
    agents: stats.agents ?? state.anim.agents.length,
    vaporized,
    alive,
    predestination: Boolean(stats.predestination ?? agentTraits.predestination),
    lights: state.anim.signals?.size || 0,
    signalSwitches: switches,
    peakWaiting: stats.peakWaiting || 0,
    waitingH: by.H,
    waitingV: by.V,
    avgWait,
    maxWait,
    totalLightWaits,
    avgPathHops,
    maxPathHops,
    sessionHops: state.sessionHopTally.totalHops,
    avgDeviationPct,
    comparedEdges,
  }
}

async function maybeLogCompletedRun() {
  if (state.anim.runLogged || !state.anim.agents.length) return
  const { alive, vaporized } = countAliveVaporized(state.anim.agents)
  // Complete only when everyone is gone (Alive = 0) after a real spawn.
  if (alive > 0 || vaporized <= 0) return
  if (!state.anim.runStats?.startedAt) return

  state.anim.runLogged = true
  const payload = collectRunStats()
  refreshFoundDisplay()
  const line = formatSimLogLine(payload)
  const file = getSelectedLogFileName()
  const status = document.getElementById('sim-log-status')
  if (status) status.textContent = `Alive=0 — appending run to logs/${file}.log…`

  const result = await appendSimLog(file, line)
  if (status) {
    if (result.ok) {
      status.textContent = `Saved to ${result.path || `logs/${result.file}`} · ${payload.durationSec}s · ${payload.ticks} ticks · ${payload.sessionHops} live hops · Δ ${payload.avgDeviationPct ?? '—'}%`
    } else {
      status.textContent = `Log failed: ${result.error || 'unknown error'}`
      state.anim.runLogged = false
    }
  }
}

function renderFocusPanel() {
  const panel = document.getElementById('focus-panel')
  const blurb = document.getElementById('focus-blurb')
  const list = document.getElementById('focus-light-list')
  if (!panel || !blurb || !list) return

  const show = state.viewMode === 'intersection'
  panel.hidden = !show
  const agentPanel = document.getElementById('agent-panel')
  if (agentPanel) agentPanel.hidden = !show
  if (!show) return

  populateLayoutSelect()
  renderDestWeightInputs()
  syncAgentTraitsFromUi()
  syncLogFileInput(getActiveLayout())

  const layout = getActiveLayout()
  const centerId = layout.signal?.centerId || SIGNAL_NODE_ID
  const center = state.graphNodes.get(centerId)
  const name = center?.tags?.name || centerId
  const spawn = layout.spawn || {}
  const spawnNote =
    spawn.mode === 'random'
      ? agentTraits.predestination
        ? `${agentTraits.agentCount} predest agents at random lights`
        : `random ${spawn.min}–${spawn.max} agents map-wide`
      : 'fixed corner / compete streams'
  blurb.textContent = `${layout.name}: ${spawnNote}. Signal at ${name} (${centerId}); lights stored in layout.`

  const layoutLights = layout.lights?.length
    ? layout.lights
    : [{ id: centerId, role: 'center' }, ...getStopLineIds().map((id) => ({ id, role: 'stop' }))]

  list.innerHTML = layoutLights
    .map((L) => {
      const n = state.graphNodes.get(L.id)
      const isCenter = L.role === 'center' || L.id === centerId
      const pos =
        L.lat != null && L.lon != null
          ? `${Number(L.lat).toFixed(4)}, ${Number(L.lon).toFixed(4)}`
          : n
            ? `${n.lat.toFixed(4)}, ${n.lon.toFixed(4)}`
            : ''
      return `<li class="pair-item">
        <button type="button" class="pair-jump" data-a="${escapeHtml(L.id)}">
          <code>${escapeHtml(L.id)}</code>
          <span class="pair-arrow">${isCenter ? 'center' : L.axis || L.role || ''} ${pos}</span>
        </button>
      </li>`
    })
    .join('')

  list.querySelectorAll('.pair-jump').forEach((btn) => {
    btn.addEventListener('click', () => selectNode(btn.dataset.a, true))
  })
}

function renderDestWeightInputs() {
  const list = document.getElementById('dest-weight-list')
  if (!list) return
  const cats = Object.keys(agentTraits.destWeights)
  list.innerHTML = `
    <h4 class="dest-weights-title">Destination weights</h4>
    <div class="dest-weight-grid">
      ${cats
        .map((key) => {
          const val = agentTraits.destWeights[key]
          const swatch = DEST_COLORS[key] || '#3d5a52'
          return `<label class="dest-weight-row" title="${escapeHtml(key)}">
            <span class="dest-swatch" style="background:${swatch}"></span>
            <span class="dest-name">${escapeHtml(key)}</span>
            <input type="number" data-dest-weight="${escapeHtml(key)}" min="0" max="20" step="0.1" value="${val}" />
          </label>`
        })
        .join('')}
    </div>
  `
  list.querySelectorAll('[data-dest-weight]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.getAttribute('data-dest-weight')
      agentTraits.destWeights[key] = Math.max(0, Number(input.value) || 0)
    })
  })
}

function syncAgentTraitsFromUi() {
  const predest = document.getElementById('predest-enabled')
  const count = document.getElementById('agent-count')
  if (predest) agentTraits.predestination = predest.checked
  if (count) {
    agentTraits.agentCount = Math.max(10, Math.min(2000, Number(count.value) || 200))
    count.value = String(agentTraits.agentCount)
  }
  document.querySelectorAll('[data-dest-weight]').forEach((input) => {
    const key = input.getAttribute('data-dest-weight')
    if (key) agentTraits.destWeights[key] = Math.max(0, Number(input.value) || 0)
  })
  const fields = document.getElementById('predest-fields')
  if (fields) fields.hidden = !agentTraits.predestination
  const hint = document.getElementById('predest-hint')
  if (hint) hint.hidden = !agentTraits.predestination
  const destList = document.getElementById('dest-weight-list')
  if (destList) destList.hidden = !agentTraits.predestination
}

function stopIntersectionAnim() {
  state.anim.running = false
  if (state.anim.raf) {
    cancelAnimationFrame(state.anim.raf)
    state.anim.raf = 0
  }
  state.anim.lastTs = 0
  const btn = document.getElementById('anim-play')
  if (btn) btn.textContent = 'Play streams'
}

function clearAgentMarkers() {
  state.layers.agents?.clearLayers()
  state.anim.markers.clear()
  state.anim.signalMarkers.clear()
}

function signalFillForPhase(phase) {
  return phase === 'H' ? '#2d6a4f' : '#1d3557'
}

function updateSignalMarkers() {
  if (!state.layers.agents) return
  const signals = state.anim.signals
  if (!signals?.size) return

  const centerId = SIGNAL_NODE_ID
  const seen = new Set()

  for (const sig of signals.values()) {
    seen.add(sig.id)
    const layoutLight = getActiveLayout().lights?.find((L) => L.id === sig.id)
    const node = state.graphNodes.get(sig.id)
    const lat = layoutLight?.lat ?? node?.lat
    const lon = layoutLight?.lon ?? node?.lon
    if (lat == null || lon == null) continue

    const counting = sig.countdown != null
    const fill = signalFillForPhase(sig.phase)
    const tip = [
      `Light ${sig.id}`,
      `${sig.phase} green`,
      sig.waiters ? `${sig.waiters} waiting` : 'clear',
      counting ? `switch in ${sig.countdown} tick${sig.countdown === 1 ? '' : 's'}` : 'reactionary',
    ].join(' · ')

    const existing = state.anim.signalMarkers.get(sig.id)
    const radius = sig.id === centerId ? 12 : 8
    if (!existing) {
      const marker = L.circleMarker([lat, lon], {
        radius,
        color: counting ? '#f0a35e' : '#1a3a32',
        weight: counting ? 3 : 2,
        fillColor: fill,
        fillOpacity: counting ? 0.72 : 0.48,
      })
        .bindTooltip(tip, { direction: 'top' })
        .addTo(state.layers.agents)
      state.anim.signalMarkers.set(sig.id, marker)
    } else {
      existing.setLatLng([lat, lon])
      existing.setStyle({
        radius,
        color: counting ? '#f0a35e' : '#1a3a32',
        weight: counting ? 3 : 2,
        fillColor: fill,
        fillOpacity: counting ? 0.72 : 0.48,
      })
      existing.setTooltipContent(tip)
    }
  }

  for (const [id, marker] of state.anim.signalMarkers) {
    if (seen.has(id)) continue
    state.layers.agents?.removeLayer(marker)
    state.anim.signalMarkers.delete(id)
  }
}

const VAPORIZE_MS = 480
const KILLFEED_MAX = 5
const KILLFEED_TTL_MS = 5000
const KILLFEED_EXIT_GAP_MS = 120

/** @type {ReturnType<typeof setTimeout>[]} */
const killFeedTimers = []
/** @type {HTMLElement[]} */
const killFeedExitQueue = []
let killFeedExiting = false

function formatAgentTag(agent) {
  const raw = String(agent?.id ?? 'x')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const padded = raw.padStart(7, '0').slice(-7)
  return `Agent ${padded}`
}

function clearKillFeed() {
  for (const t of killFeedTimers) clearTimeout(t)
  killFeedTimers.length = 0
  killFeedExitQueue.length = 0
  killFeedExiting = false
  state.anim.killFeed = []
  const list = document.getElementById('killfeed-list')
  if (list) list.innerHTML = ''
  document.getElementById('killfeed')?.classList.remove('has-kills')
}

function syncKillFeedVisibility() {
  const list = document.getElementById('killfeed-list')
  const remaining = list?.querySelectorAll('.killfeed-row:not(.is-exiting)').length || 0
  if (!remaining && !killFeedExitQueue.length && !killFeedExiting) {
    document.getElementById('killfeed')?.classList.remove('has-kills')
  }
}

function finishKillFeedRow(row) {
  const key = row.dataset.key
  if (row.isConnected) row.remove()
  if (key) state.anim.killFeed = state.anim.killFeed.filter((e) => e.key !== key)
  syncKillFeedVisibility()
}

function exitKillFeedRow(row, onDone) {
  if (!row?.isConnected || row.classList.contains('is-exiting')) {
    onDone?.()
    return
  }
  row.classList.remove('is-fresh')
  row.classList.add('is-exiting')
  let done = false
  const finish = () => {
    if (done) return
    done = true
    finishKillFeedRow(row)
    onDone?.()
  }
  row.addEventListener(
    'animationend',
    (e) => {
      if (e.target === row && e.animationName === 'killfeed-drop') finish()
    },
    { once: true },
  )
  window.setTimeout(finish, 420)
}

function pumpKillFeedExits() {
  if (killFeedExiting) return
  while (killFeedExitQueue.length) {
    const row = killFeedExitQueue.shift()
    if (row?.isConnected && !row.classList.contains('is-exiting')) {
      killFeedExiting = true
      exitKillFeedRow(row, () => {
        killFeedExiting = false
        if (killFeedExitQueue.length) {
          window.setTimeout(pumpKillFeedExits, KILLFEED_EXIT_GAP_MS)
        } else {
          syncKillFeedVisibility()
        }
      })
      return
    }
  }
  syncKillFeedVisibility()
}

function enqueueKillFeedExit(row) {
  if (!row || killFeedExitQueue.includes(row) || row.classList.contains('is-exiting')) return
  killFeedExitQueue.push(row)
  pumpKillFeedExits()
}

function scheduleKillFeedExpiry(row) {
  const timer = window.setTimeout(() => {
    const i = killFeedTimers.indexOf(timer)
    if (i >= 0) killFeedTimers.splice(i, 1)
    if (row.isConnected && !row.classList.contains('is-exiting')) {
      enqueueKillFeedExit(row)
    }
  }, KILLFEED_TTL_MS)
  killFeedTimers.push(timer)
}

function pushKillFeed(agent) {
  const entry = {
    key: `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tag: formatAgentTag(agent),
    dest: String(agent.destId || agent.fromId || '?'),
  }
  state.anim.killFeed.unshift(entry)
  if (state.anim.killFeed.length > KILLFEED_MAX) {
    state.anim.killFeed.length = KILLFEED_MAX
  }

  const feed = document.getElementById('killfeed')
  const list = document.getElementById('killfeed-list')
  if (!list) return
  feed?.classList.add('has-kills')

  // Capacity overflow: bottom row drops out first (same exit path).
  const live = [...list.querySelectorAll('.killfeed-row:not(.is-exiting)')]
  if (live.length >= KILLFEED_MAX) {
    enqueueKillFeedExit(live[live.length - 1])
  }

  const row = document.createElement('div')
  row.className = 'killfeed-row is-fresh'
  row.dataset.key = entry.key
  row.innerHTML = `
    <span class="killfeed-tag">${escapeHtml(entry.tag)}</span>
    <span class="killfeed-dest">@ ${escapeHtml(entry.dest)}</span>
    <span class="killfeed-blast" aria-hidden="true">
      <svg class="nuke-cloud" viewBox="0 0 32 36" width="16" height="18">
        <ellipse class="nuke-cap" cx="16" cy="10" rx="12" ry="8" />
        <ellipse class="nuke-cap-l" cx="7" cy="12" rx="5.5" ry="4.5" />
        <ellipse class="nuke-cap-r" cx="25" cy="12" rx="5.5" ry="4.5" />
        <path class="nuke-stem" d="M12 14c1.2 4 1.5 8 1.2 14h5.6c-.3-6 0-10 1.2-14z" />
        <ellipse class="nuke-base" cx="16" cy="30" rx="9" ry="3.2" />
        <ellipse class="nuke-flash" cx="16" cy="28.5" rx="3.2" ry="1.4" />
      </svg>
    </span>
  `
  list.prepend(row)
  row.addEventListener('animationend', (e) => {
    if (e.target === row && e.animationName === 'killfeed-pop') {
      row.classList.remove('is-fresh')
    }
  })
  scheduleKillFeedExpiry(row)
}

function countAliveVaporized(agents) {
  let alive = 0
  let vaporized = 0
  for (const a of agents) {
    if (a.vaporized || (a.done && !a.vaporizing)) vaporized += 1
    else if (a.vaporizing) vaporized += 1
    else alive += 1
  }
  return { alive, vaporized }
}

function updateAnimStatus() {
  const status = document.getElementById('anim-status')
  if (!status) return
  const layout = getActiveLayout()
  const waiting = countWaiting(state.anim.agents)
  const by = countWaitingByAxis(state.anim.agents)
  const lights = countSignalsByPhase(state.anim.signals)
  const n = state.anim.agents.length
  const lightN = state.anim.signals?.size || 0
  const predestN = state.anim.agents.filter((a) => a.path?.length).length
  const mode = agentTraits.predestination && predestN ? `predest ${predestN}` : 'wander'
  status.textContent = `${layout.name} · ${n} agents · ${mode} · ${lightN} lights (H:${lights.H} V:${lights.V}) · ${lights.counting} counting · ${waiting} waiting (H:${by.H} V:${by.V}) · tick ${SIGNAL_TICK_MS / 1000}s`

  const { alive, vaporized } = countAliveVaporized(state.anim.agents)
  const aliveEl = document.getElementById('alive-count')
  const vaporEl = document.getElementById('vapor-count')
  const devEl = document.getElementById('avg-deviation')
  const hopsEl = document.getElementById('live-hops')
  if (aliveEl) aliveEl.textContent = String(alive)
  if (vaporEl) vaporEl.textContent = String(vaporized)
  if (hopsEl) hopsEl.textContent = String(state.sessionHopTally.totalHops)
  if (devEl) {
    const { avgDeviationPct, comparedEdges } = currentAvgDeviation()
    devEl.textContent =
      avgDeviationPct == null ? '—' : `${avgDeviationPct.toFixed(1)}%`
    devEl.title =
      comparedEdges > 0
        ? `Mean |found − given| over ${comparedEdges} edges with live hops`
        : 'No live hop samples yet'
  }
}

function updateAgentMarkers(dt) {
  for (const a of state.anim.agents) {
    const marker = state.anim.markers.get(a.id)
    if (!marker) continue

    if (a.vaporizing) {
      if (!a.killFeedLogged) {
        a.killFeedLogged = true
        pushKillFeed(a)
      }
      a.vaporizeAge = (a.vaporizeAge || 0) + dt
      const t = Math.min(1, a.vaporizeAge / VAPORIZE_MS)
      const burst = t < 0.4
      marker.setLatLng([a.lat, a.lon])
      marker.setStyle({
        radius: 4 + t * 22,
        color: burst ? '#fff8e7' : '#c45c26',
        weight: burst ? 2 : 0,
        fillColor: burst ? '#fff8e7' : a.color || '#e07a5f',
        fillOpacity: Math.max(0, 0.95 * (1 - t) ** 1.35),
      })
      if (t >= 1) {
        a.vaporizing = false
        a.vaporized = true
        state.layers.agents?.removeLayer(marker)
        state.anim.markers.delete(a.id)
      }
      continue
    }

    if (a.vaporized || a.done) continue

    marker.setLatLng([a.lat, a.lon])
    if (a.waitingAtSignal) {
      marker.setStyle({ fillOpacity: 0.55, weight: 2 })
    } else {
      marker.setStyle({ fillOpacity: 0.92, weight: 1 })
    }
  }
}

function buildIntersectionChoices() {
  // Full-network locked hop weights so agents can use every paired road.
  const transitions = state.simResult?.transitions || savedTransitions.transitions || []
  const choices = buildLocalChoiceTable(transitions)
  const adj = buildPairAdjacency(state.pairs)
  return fillMissingChoices(adj, choices)
}

function jitterAround(node, kind, index) {
  // Small offset so stacked agents at a spawn are visible.
  const spread = kind === 'corner' ? 0.00008 : 0.00006
  const angle = (index / 10) * Math.PI * 2
  return {
    lat: node.lat + Math.cos(angle) * spread,
    lon: node.lon + Math.sin(angle) * spread * 1.15,
  }
}

function resetIntersectionAnim(opts = {}) {
  const skipMarkers = Boolean(opts.skipMarkers)
  stopIntersectionAnim()
  clearAgentMarkers()
  if (!opts.keepKillFeed) clearKillFeed()
  if (state.viewMode !== 'intersection' || !state.graphNodes.size) return

  syncAgentTraitsFromUi()

  const layout = getActiveLayout()
  applyLayoutSignal(layout.signal)

  state.anim.choices = buildIntersectionChoices()
  state.anim.rand = makeAnimRand(Date.now() % 1e9)
  const pairIds = [...new Set(state.pairs.flatMap((p) => [p.a, p.b]))].filter((id) =>
    state.graphNodes.has(id),
  )
  const adjacency = buildPairAdjacency(state.pairs)
  state.anim.signals = createReactionarySignals(pairIds, state.anim.rand)

  let spawnLayout = layout
  if (agentTraits.predestination && layout.spawn?.mode === 'random') {
    spawnLayout = {
      ...layout,
      spawn: {
        ...layout.spawn,
        min: agentTraits.agentCount,
        max: agentTraits.agentCount,
        kind: 'predest',
        color: layout.spawn.color || '#2a6f97',
      },
    }
  }

  const roster = createSpawnRosterFromLayout(spawnLayout, pairIds, state.anim.rand)
  const destOptions = agentTraits.predestination
    ? buildDestOptions(
        state.attractors,
        pairIds,
        state.graphNodes,
        agentTraits.destWeights,
        haversineMeters,
      )
    : []

  state.anim.agents = createAgents(
    roster,
    state.anim.choices,
    state.graphNodes,
    Date.now() % 1e9,
    {
      predestination: agentTraits.predestination,
      adjacency,
      destOptions,
      destColors: DEST_COLORS,
      signals: state.anim.signals,
    },
  )

  // Stagger spawn jitter + initial positions at spawn lights.
  const spawnCounts = new Map()
  for (const a of state.anim.agents) {
    const n = spawnCounts.get(a.spawnId) || 0
    spawnCounts.set(a.spawnId, n + 1)
    const node = state.graphNodes.get(a.spawnId)
    if (!node) continue
    const j = jitterAround(node, a.kind, n)
    a.lat = j.lat
    a.lon = j.lon
    // Hold briefly at spawn before first hop so you see the stacks form.
    a.progress = -0.35 - (n % 5) * 0.04

    if (skipMarkers) continue

    const tip = a.destId
      ? `Predest ${a.spawnId} → ${a.destId} (${a.destCategory || 'poi'} · ${a.path?.length ? a.path.length - 1 : '?'} hops)`
      : a.kind === 'compete'
        ? `Compete @ ${a.spawnId}`
        : a.kind === 'wander'
          ? `Wander @ ${a.spawnId}`
          : `Corner @ ${a.spawnId}`

    const marker = L.circleMarker([a.lat, a.lon], {
      radius: a.kind === 'compete' ? 5.5 : a.kind === 'predest' ? 5 : 4.5,
      color: '#1a3a32',
      weight: 1,
      fillColor: a.color,
      fillOpacity: 0.92,
    }).bindTooltip(tip, { direction: 'top' })
    marker.addTo(state.layers.agents)
    state.anim.markers.set(a.id, marker)
  }

  if (!skipMarkers) updateSignalMarkers()
  updateAnimStatus()
  beginRunStats()
}

/**
 * Fast-forward one spawned run to Alive=0. Does not write the log.
 * @returns {object} collectRunStats() snapshot
 */
function simulateInstantOnce() {
  for (const a of state.anim.agents) {
    if (a.vaporizing || (a.done && !a.vaporized)) {
      a.vaporizing = false
      a.vaporized = true
      a.done = true
    }
  }

  const DT = 250
  const MAX_ELAPSED = SIGNAL_TICK_MS * 2000
  let guard = 0
  const GUARD_MAX = 2_000_000

  while (guard++ < GUARD_MAX && state.anim.signalElapsed < MAX_ELAPSED) {
    for (const a of state.anim.agents) {
      if (a.vaporizing) {
        a.vaporizing = false
        a.vaporized = true
      }
    }

    const { alive } = countAliveVaporized(state.anim.agents)
    if (alive === 0) break

    const completedHops = []
    stepAgents(
      state.anim.agents,
      state.anim.choices,
      state.graphNodes,
      DT,
      HOP_DURATION_MS,
      state.anim.rand,
      state.anim.signals,
      completedHops,
    )
    for (const h of completedHops) {
      recordHop(state.sessionHopTally, h.from, h.to)
    }
    stepSignals(state.anim.signals, state.anim.agents, DT)
    state.anim.signalElapsed += DT

    const waiting = countWaiting(state.anim.agents)
    if (state.anim.runStats && waiting > (state.anim.runStats.peakWaiting || 0)) {
      state.anim.runStats.peakWaiting = waiting
    }
  }

  for (const a of state.anim.agents) {
    a.waitingAtSignal = false
    a.heldChoice = null
    a.done = true
    a.vaporizing = false
    a.vaporized = true
  }

  state.anim.runLogged = true // prevent accidental per-run logging
  return collectRunStats()
}

function showSimLoading(show, current = 0, total = 0) {
  const el = document.getElementById('sim-loading')
  const progress = document.getElementById('sim-loading-progress')
  const bar = document.getElementById('sim-loading-bar')
  if (!el) return
  el.hidden = !show
  if (!show) return
  if (progress) progress.textContent = `${current} / ${total}`
  if (bar) {
    const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0
    bar.style.width = `${pct}%`
  }
}

function averageRunStats(runs) {
  if (!runs.length) return null
  const keys = [
    'durationMs',
    'durationSec',
    'ticks',
    'agents',
    'vaporized',
    'signalSwitches',
    'peakWaiting',
    'avgWait',
    'maxWait',
    'totalLightWaits',
    'avgPathHops',
    'maxPathHops',
  ]
  const out = {
    ts: new Date().toISOString(),
    spawnedAt: runs[0].spawnedAt || null,
    layoutId: runs[0].layoutId,
    layoutName: runs[0].layoutName,
    logFile: runs[0].logFile,
    type: 'instant_batch',
    mode: 'instant',
    runs: runs.length,
    tickMs: runs[0].tickMs,
    predestination: runs[0].predestination,
    lights: runs[0].lights,
  }
  for (const k of keys) {
    const vals = runs.map((r) => Number(r[k])).filter((n) => Number.isFinite(n))
    if (!vals.length) continue
    const avg = vals.reduce((s, n) => s + n, 0) / vals.length
    out[`${k}Avg`] = Number(avg.toFixed(k.includes('Wait') || k.includes('Hops') || k === 'durationSec' ? 3 : 2))
    if (k === 'durationMs' || k === 'ticks' || k === 'agents' || k === 'vaporized') {
      out[k] = Math.round(avg)
    }
  }
  out.durationSec = out.durationSecAvg ?? Number(((out.durationMs || 0) / 1000).toFixed(2))
  out.ticks = out.ticks ?? out.ticksAvg
  out.agents = out.agents ?? out.agentsAvg
  out.vaporized = out.vaporized ?? out.vaporizedAvg
  out.avgWait = out.avgWaitAvg
  out.maxWait = Math.max(...runs.map((r) => Number(r.maxWait) || 0))
  out.peakWaiting = Math.max(...runs.map((r) => Number(r.peakWaiting) || 0))
  out.totalLightWaits = runs.reduce((s, r) => s + (Number(r.totalLightWaits) || 0), 0)
  out.signalSwitches = runs.reduce((s, r) => s + (Number(r.signalSwitches) || 0), 0)
  out.alive = 0
  out.waitingH = 0
  out.waitingV = 0
  out.avgPathHops = out.avgPathHopsAvg
  out.maxPathHops = Math.max(...runs.map((r) => Number(r.maxPathHops) || 0))
  const { avgDeviationPct, comparedEdges } = currentAvgDeviation()
  out.avgDeviationPct = avgDeviationPct
  out.comparedEdges = comparedEdges
  out.sessionHops = state.sessionHopTally.totalHops
  return out
}

/**
 * Spawn + fast-forward N runs with no animation. Appends ONE log line for the batch.
 */
async function runIntersectionInstant() {
  if (state.viewMode !== 'intersection' || !state.graphNodes.size) return

  const btn = document.getElementById('anim-instant')
  const runsInput = document.getElementById('instant-runs')
  const status = document.getElementById('sim-log-status')
  const runs = Math.max(1, Math.min(5000, Number(runsInput?.value) || 1))
  if (runsInput) runsInput.value = String(runs)

  if (btn) btn.disabled = true
  if (runsInput) runsInput.disabled = true
  stopIntersectionAnim()

  const showLoader = runs >= 3
  if (showLoader) showSimLoading(true, 0, runs)
  if (status) status.textContent = `Running ${runs} instant sim${runs === 1 ? '' : 's'}…`

  const batch = []
  const t0 = performance.now()
  const hopsBefore = state.sessionHopTally.totalHops

  for (let i = 0; i < runs; i++) {
    resetIntersectionAnim({ skipMarkers: true, keepKillFeed: i > 0 })
    const snap = simulateInstantOnce()
    batch.push(snap)

    if (showLoader) showSimLoading(true, i + 1, runs)
    if (status && (i % 5 === 0 || i === runs - 1)) {
      status.textContent = `Instant ${i + 1} / ${runs} · ${state.sessionHopTally.totalHops} live hops…`
    }
    // Refresh found % periodically so green labels track the growing tally.
    if (i === runs - 1 || (runs >= 10 && (i + 1) % 10 === 0)) {
      updateAnimStatus()
      refreshFoundDisplay()
    }
    // Let the loading UI paint on long batches.
    if (runs >= 3) await new Promise((r) => setTimeout(r, 0))
  }

  clearAgentMarkers()
  updateSignalMarkers()
  updateAnimStatus()
  refreshFoundDisplay()

  const payload = averageRunStats(batch)
  const hopsAdded = state.sessionHopTally.totalHops - hopsBefore
  payload.hopsAdded = hopsAdded
  payload.sessionHops = state.sessionHopTally.totalHops
  const file = getSelectedLogFileName()
  const line = formatSimLogLine(payload)
  const result = await appendSimLog(file, line)

  showSimLoading(false)
  if (btn) btn.disabled = false
  if (runsInput) runsInput.disabled = false

  const wallSec = ((performance.now() - t0) / 1000).toFixed(1)
  if (status) {
    if (result.ok) {
      status.textContent = `Saved 1 batch line · ${runs} runs · +${hopsAdded} hops (session ${payload.sessionHops}) · Δ ${payload.avgDeviationPct ?? '—'}% · ${wallSec}s`
    } else {
      status.textContent = `Log failed: ${result.error || 'unknown error'}`
    }
  }
}

/**
 * Replace locked given transition probs with live found probs for any from-node
 * that has session samples. Writes trafficflower-transitions.json (dev server).
 */
async function captureFoundAsGiven() {
  const status = document.getElementById('sim-log-status')
  const btn = document.getElementById('anim-capture')
  if (!state.sessionHopTally.totalHops) {
    if (status) status.textContent = 'Nothing to capture — run sims until Live hops > 0.'
    return
  }

  if (btn) btn.disabled = true
  if (status) status.textContent = 'Capturing found → locked given…'

  const previous = getGivenTransitions()
  const { transitions, capturedFrom, capturedEdges } = mergeFoundIntoTransitions(
    state.sessionHopTally,
    previous,
  )

  const prevResult = state.simResult || {}
  const result = {
    agents: prevResult.agents ?? savedTransitions.meta?.agents ?? 0,
    steps: prevResult.steps ?? savedTransitions.meta?.steps ?? 0,
    seed: prevResult.seed ?? savedTransitions.meta?.seed ?? 0,
    totalSteps: state.sessionHopTally.totalHops,
    pairCount: prevResult.pairCount ?? state.pairs.length,
    lightCount: prevResult.lightCount ?? state.anim.signals?.size ?? 0,
    attractorCount: prevResult.attractorCount ?? state.attractors.length,
    transitions,
    spawns: prevResult.spawns || savedTransitions.spawns || [],
    samplePaths: prevResult.samplePaths || savedTransitions.samplePaths || [],
    throughput: prevResult.throughput ?? savedTransitions.meta?.throughput ?? null,
  }
  state.simResult = result

  // Rebuild choice weights so agents use the new given probs immediately.
  if (state.viewMode === 'intersection') {
    const wasRunning = state.anim.running
    resetIntersectionAnim()
    if (wasRunning) playIntersectionAnim()
  }

  refreshFoundDisplay()
  updateAnimStatus()
  document.getElementById('export-csv').disabled = false
  document.getElementById('export-json').disabled = false

  let diskOk = false
  let diskPath = 'src/sim/trafficflower-transitions.json'
  try {
    const res = await fetch('/api/capture-transitions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta: {
          agents: result.agents,
          steps: result.steps,
          seed: result.seed,
          totalSteps: result.totalSteps,
          pairCount: result.pairCount,
          nodeCount: result.lightCount,
          attractorCount: result.attractorCount,
          throughput: result.throughput,
          sessionHops: state.sessionHopTally.totalHops,
          capturedFrom,
          capturedEdges,
        },
        transitions,
        spawns: result.spawns,
        samplePaths: result.samplePaths,
      }),
    })
    const data = await res.json()
    diskOk = Boolean(data?.ok)
    if (data?.path) diskPath = data.path
    if (!diskOk) throw new Error(data?.error || `HTTP ${res.status}`)
  } catch (err) {
    if (status) {
      status.textContent = `Captured in memory (${capturedFrom} lights, ${capturedEdges} edges) but disk write failed — restart npm run dev. ${err.message || err}`
    }
    if (btn) btn.disabled = false
    return
  }

  const { avgDeviationPct } = currentAvgDeviation()
  if (status) {
    status.textContent = diskOk
      ? `Captured found → given · ${capturedFrom} lights · ${capturedEdges} edges · wrote ${diskPath} · Δ now ${avgDeviationPct ?? 0}%`
      : `Captured in memory only`
  }
  if (btn) btn.disabled = false
}

function animFrame(ts) {
  if (!state.anim.running) return
  if (!state.anim.lastTs) state.anim.lastTs = ts
  const dt = Math.min(64, ts - state.anim.lastTs)
  state.anim.lastTs = ts
  state.anim.signalElapsed += dt

  const completedHops = []
  stepAgents(
    state.anim.agents,
    state.anim.choices,
    state.graphNodes,
    dt,
    HOP_DURATION_MS,
    state.anim.rand,
    state.anim.signals,
    completedHops,
  )
  for (const h of completedHops) {
    recordHop(state.sessionHopTally, h.from, h.to)
  }
  stepSignals(state.anim.signals, state.anim.agents, dt)

  const waiting = countWaiting(state.anim.agents)
  if (state.anim.runStats && waiting > (state.anim.runStats.peakWaiting || 0)) {
    state.anim.runStats.peakWaiting = waiting
  }

  const tickNow = Math.floor((state.anim.signalElapsed || 0) / SIGNAL_TICK_MS)
  // Refresh map/table found % on tick boundaries (no per-tick log spam).
  if (tickNow !== (state.anim._uiTick | 0)) {
    state.anim._uiTick = tickNow
    if (state.simResult) {
      renderResults(state.simResult)
      drawFlows(state.simResult)
    }
  }

  updateAgentMarkers(dt)
  updateSignalMarkers()
  updateAnimStatus()
  maybeLogCompletedRun()
  state.anim.raf = requestAnimationFrame(animFrame)
}

function playIntersectionAnim() {
  if (state.viewMode !== 'intersection') return
  if (!state.anim.agents.length) resetIntersectionAnim()
  if (state.anim.running) {
    stopIntersectionAnim()
    return
  }
  state.anim.running = true
  state.anim.lastTs = 0
  const btn = document.getElementById('anim-play')
  if (btn) btn.textContent = 'Pause'
  state.anim.raf = requestAnimationFrame(animFrame)
}

function setViewMode(mode) {
  const next = mode === 'intersection' ? 'intersection' : 'network'
  if (next !== 'intersection') stopIntersectionAnim()

  state.viewMode = next
  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === state.viewMode)
  })
  document.querySelectorAll('[data-network-only]').forEach((el) => {
    el.hidden = state.viewMode === 'intersection'
  })
  const heading = document.getElementById('results-heading')
  if (heading) {
    heading.textContent =
      state.viewMode === 'intersection' ? 'Signal streams · full map' : 'Pair → pair hops'
  }

  if (state.viewMode === 'intersection') {
    state.pairMode = false
    state.pairPending = null
  } else {
    clearAgentMarkers()
    clearKillFeed()
  }

  document.getElementById('killfeed')?.classList.toggle(
    'is-hidden',
    state.viewMode !== 'intersection',
  )

  renderFocusPanel()
  updateStats()
  drawWays()
  drawNodes()
  drawLights()
  drawAttractors()
  drawPairs()
  if (state.simResult) {
    drawFlows(state.simResult)
    renderResults(state.simResult)
  } else {
    renderResults(null)
  }
  fitViewBounds()
  updatePairButtons()

  if (state.viewMode === 'intersection') {
    resetIntersectionAnim()
    playIntersectionAnim()
  }
}

function fitViewBounds() {
  if (!state.map) return
  confineMapToData()
}

function renderWeightList() {
  const list = document.getElementById('weight-list')
  const rows = Object.entries(weights.attractors || {}).map(([key, cfg]) => {
    const role = cfg.role ? ` · ${cfg.role}` : ''
    return `<li><span class="w-name">${escapeHtml(key)}${escapeHtml(role)}</span><span class="w-val">${Number(cfg.weight).toFixed(1)}</span></li>`
  })
  rows.push(
    `<li><span class="w-name">source_spawn_share</span><span class="w-val">${Number(weights.throughput?.source_spawn_share ?? 0).toFixed(2)}</span></li>`,
  )
  rows.push(
    `<li><span class="w-name">backtrack_penalty</span><span class="w-val">${Number(weights.backtrack_penalty).toFixed(2)}</span></li>`,
  )
  rows.push(
    `<li><span class="w-name">falloff_m</span><span class="w-val">${Number(weights.distance_falloff_meters)}</span></li>`,
  )
  list.innerHTML = rows.join('')
}

function tagList(tags) {
  const entries = Object.entries(tags)
  if (!entries.length) return '<p class="muted">No tags</p>'
  return `<dl class="tags">${entries
    .slice(0, 12)
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('')}</dl>`
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderDetail(node) {
  const panel = document.getElementById('detail-panel')
  if (!node) {
    panel.innerHTML = `
      <h3>Select a node</h3>
      <p class="muted">Click any point on the map to inspect it.</p>
    `
    return
  }

  const isLight = state.lights.some((l) => l.id === node.id)
  const name = node.tags.name || node.tags.ref || `Node ${node.id}`
  panel.innerHTML = `
    <div class="detail-head">
      <h3>${escapeHtml(name)}</h3>
      <span class="pill ${isLight ? 'pill-hub' : ''}">${isLight ? 'Light' : node.isJunction ? 'Junction' : 'Node'}</span>
    </div>
    <p class="meta">id <code>${escapeHtml(node.id)}</code> · ${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}</p>
    <div class="metrics">
      <div><span>Degree</span><strong>${node.degree}</strong></div>
      <div><span>Ways</span><strong>${node.wayIds.length}</strong></div>
      <div><span>Neighbors</span><strong>${node.neighbors.length}</strong></div>
    </div>
    ${tagList(node.tags)}
  `
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function hasPair(a, b) {
  const key = pairKey(a, b)
  return state.pairs.some((p) => pairKey(p.a, p.b) === key)
}

function addPair(a, b) {
  if (a === b || hasPair(a, b)) return false
  state.pairs.push({ a, b })
  return true
}

function removePairAt(index) {
  state.pairs.splice(index, 1)
  renderPairList()
  drawPairs()
  updatePairButtons()
}

function updatePairButtons() {
  const exportBtn = document.getElementById('export-pairs')
  const clearBtn = document.getElementById('clear-pairs')
  const toggle = document.getElementById('toggle-pair-mode')
  const hint = document.getElementById('pair-hint')
  exportBtn.disabled = state.pairs.length === 0
  clearBtn.disabled = state.pairs.length === 0
  toggle.classList.toggle('active', state.pairMode)
  toggle.textContent = state.pairMode ? 'Pair mode: ON' : 'Pair mode'
  document.querySelector('.map-pane')?.classList.toggle('pair-mode', state.pairMode)

  if (!state.pairMode) {
    hint.textContent =
      'These pairs are the only legal agent moves. Edit in pair mode or via trafficflower-pairs.json.'
  } else if (!state.pairPending) {
    hint.textContent = 'Click the first node…'
  } else {
    hint.textContent = `First: ${state.pairPending} — click a second node.`
  }
}

function renderPairList() {
  const list = document.getElementById('pair-list')
  if (!state.pairs.length) {
    list.innerHTML = `<li class="muted-item">No pairs yet</li>`
    return
  }
  list.innerHTML = state.pairs
    .map(
      (p, i) => `<li class="pair-item">
        <button type="button" class="pair-jump" data-a="${escapeHtml(p.a)}" data-b="${escapeHtml(p.b)}">
          <code>${escapeHtml(p.a)}</code>
          <span class="pair-arrow">↔</span>
          <code>${escapeHtml(p.b)}</code>
        </button>
        <button type="button" class="pair-remove" data-i="${i}" aria-label="Remove pair">×</button>
      </li>`,
    )
    .join('')

  list.querySelectorAll('.pair-jump').forEach((btn) => {
    btn.addEventListener('click', () => selectNode(btn.dataset.a, true))
  })
  list.querySelectorAll('.pair-remove').forEach((btn) => {
    btn.addEventListener('click', () => removePairAt(Number(btn.dataset.i)))
  })
}

function drawPairs() {
  state.layers.pairs.clearLayers()
  for (const p of activePairs()) {
    const a = state.graphNodes.get(p.a)
    const b = state.graphNodes.get(p.b)
    if (!a || !b) continue
    L.polyline(
      [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ],
      {
        color: '#2a6f97',
        weight: 3.5,
        opacity: 0.85,
        dashArray: '6 8',
      },
    )
      .bindTooltip(`${p.a} ↔ ${p.b}`, { sticky: true })
      .addTo(state.layers.pairs)
  }

  if (state.pairPending && state.viewMode === 'network') {
    const n = state.graphNodes.get(state.pairPending)
    if (n) {
      L.circleMarker([n.lat, n.lon], {
        radius: 10,
        color: '#2a6f97',
        weight: 3,
        fillColor: '#a8dadc',
        fillOpacity: 0.9,
      }).addTo(state.layers.pairs)
    }
  }
}

function exportPairsDoc() {
  const doc = {
    bidirectional: true,
    count: state.pairs.length,
    pairs: state.pairs.map((p) => ({
      a: p.a,
      b: p.b,
      bidirectional: true,
    })),
  }
  downloadText('trafficflower-pairs.json', JSON.stringify(doc, null, 2), 'application/json')
}

function handleNodeClick(id) {
  if (!state.pairMode) {
    selectNode(id)
    return
  }

  if (!state.pairPending) {
    state.pairPending = id
    state.selectedId = id
    renderDetail(state.graphNodes.get(id))
    drawNodes()
    drawPairs()
    updatePairButtons()
    return
  }

  if (state.pairPending === id) {
    state.pairPending = null
    drawPairs()
    updatePairButtons()
    return
  }

  const first = state.pairPending
  if (addPair(first, id)) {
    state.pairPending = null
    renderPairList()
    updatePairButtons()
    drawPairs()
    selectNode(id)
  } else {
    state.pairPending = null
    updatePairButtons()
    drawPairs()
    selectNode(id)
  }
}

function selectNode(id, fly = false) {
  const node = state.graphNodes.get(id)
  if (!node) return
  state.selectedId = id
  renderDetail(node)
  drawNodes()
  if (fly) {
    state.map.flyTo([node.lat, node.lon], Math.max(state.map.getZoom(), 16), { duration: 0.6 })
  }
}

function drawWays() {
  state.layers.ways.clearLayers()
  for (const way of state.ways.values()) {
    if (!way.isRoad) continue
    const latlngs = way.refs
      .map((id) => state.nodes.get(id))
      .filter(Boolean)
      .map((n) => [n.lat, n.lon])
    if (latlngs.length < 2) continue
    L.polyline(latlngs, {
      color: '#1a3a32',
      weight: 2.5,
      opacity: 0.45,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(state.layers.ways)
  }
}

function isLightNode(node) {
  return state.lights.some((l) => l.id === node.id)
}

function nodeStyle(node) {
  const selected = state.selectedId === node.id
  const pending = state.pairPending === node.id
  if (pending) {
    return { radius: 9, color: '#2a6f97', weight: 3, fillColor: '#a8dadc', fillOpacity: 1 }
  }
  if (selected) {
    return { radius: 8, color: '#1a3a32', weight: 2, fillColor: '#e07a5f', fillOpacity: 1 }
  }
  if (isLightNode(node)) {
    return { radius: 6.5, color: '#1a3a32', weight: 2, fillColor: '#f0a35e', fillOpacity: 1 }
  }
  if (node.isJunction) {
    return { radius: 5, color: '#1a3a32', weight: 1.5, fillColor: '#81b29a', fillOpacity: 0.95 }
  }
  return { radius: 3.2, color: '#1a3a32', weight: 1, fillColor: '#3d5a52', fillOpacity: 0.65 }
}

function drawNodes() {
  state.layers.nodes.clearLayers()
  let nodes = [...state.graphNodes.values()].sort((a, b) => b.degree - a.degree)
  const maxDraw = 2500
  if (nodes.length > maxDraw) {
    nodes = nodes.filter((n) => n.isJunction || n.degree <= 1 || isLightNode(n)).slice(0, maxDraw)
  }

  for (const node of nodes) {
    const marker = L.circleMarker([node.lat, node.lon], nodeStyle(node))
    marker.bindTooltip(node.tags.name || node.tags.ref || `Node ${node.id}`, {
      direction: 'top',
      offset: [0, -6],
      opacity: 0.95,
    })
    marker.on('click', () => handleNodeClick(node.id))
    marker.addTo(state.layers.nodes)
  }
}

function drawLights() {
  state.layers.lights.clearLayers()
  for (const light of state.lights) {
    const isCenter = light.id === FOCUS_CENTER_ID
    const inSignal = state.viewMode === 'intersection' && state.focusIds.has(light.id)
    L.circleMarker([light.lat, light.lon], {
      radius: isCenter && state.viewMode === 'intersection' ? 12 : 9,
      color: isCenter && state.viewMode === 'intersection' ? '#9b2226' : '#c45c26',
      weight: 2,
      fillColor: '#f0a35e',
      fillOpacity: isCenter && state.viewMode === 'intersection' ? 0.55 : inSignal ? 0.45 : 0.35,
    })
      .bindTooltip(
        `${isCenter ? 'Focus · ' : ''}Light ${light.tags.name || light.id}`,
        { direction: 'top' },
      )
      .on('click', () => handleNodeClick(light.id))
      .addTo(state.layers.lights)
  }
}

function drawAttractors() {
  state.layers.attractors.clearLayers()
  for (const a of state.attractors) {
    const color =
      a.category === 'food_high'
        ? '#c45c26'
        : a.category === 'food_low'
          ? '#e8a87c'
          : a.category === 'food'
            ? '#e07a5f'
            : a.category === 'parking'
              ? '#3d5a80'
              : a.category === 'park'
                ? '#81b29a'
                : '#6b7f78'
    const roleTag = a.role === 'source' ? ' · source' : a.role === 'sink' ? ' · sink' : ''
    L.circleMarker([a.lat, a.lon], {
      radius: a.role === 'source' || a.role === 'sink' ? 6 : 5,
      color,
      weight: 1.5,
      fillColor: color,
      fillOpacity: 0.75,
    })
      .bindTooltip(`${a.category}${roleTag}: ${a.name} (w=${a.weight})`, { direction: 'top' })
      .addTo(state.layers.attractors)
  }
}

function drawFlows(result) {
  state.layers.flows.clearLayers()
  state.layers.paths.clearLayers()
  state.layers.spawns.clearLayers()
  if (!result) return

  for (const path of result.samplePaths || []) {
    if (path.length < 2) continue
    L.polyline(path, {
      color: '#3d5a52',
      weight: 1.5,
      opacity: 0.22,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(state.layers.paths)
  }

  const spawnDraw = (result.spawns || []).slice(0, 200)
  for (const s of spawnDraw) {
    const fromParking = s.kind === 'parking'
    L.circleMarker([s.lat, s.lon], {
      radius: fromParking ? 4 : 3,
      color: '#1a3a32',
      weight: 1,
      fillColor: fromParking ? '#f4a261' : '#f2cc8f',
      fillOpacity: 0.9,
    })
      .bindTooltip(
        fromParking
          ? `Parking spawn: ${s.label || s.id}`
          : `Spawn @ ${s.id}`,
        { direction: 'top' },
      )
      .addTo(state.layers.spawns)
  }

  // Red overlay: light→light probability (agents still only drive adjacent nodes).
  const transitions = activeTransitions(result)
  if (!transitions.length) return
  const maxCount = Math.max(...transitions.map((t) => t.count))
  for (const t of transitions) {
    const from = state.graphNodes.get(t.from)
    const to = state.graphNodes.get(t.to)
    if (!from || !to) continue
    const strength = t.count / maxCount
    const pct = `${(t.probability * 100).toFixed(0)}%`
    const found = foundProbability(state.sessionHopTally, t.from, t.to)
    const foundHtml =
      found == null
        ? ''
        : `<span class="flow-found-prob">${(found * 100).toFixed(0)}%</span>`
    const tipFound =
      found == null ? 'found: —' : `found=${found.toFixed(3)} (n=${hopCount(state.sessionHopTally, t.from, t.to)})`
    L.polyline(
      [
        [from.lat, from.lon],
        [to.lat, to.lon],
      ],
      {
        color: '#e07a5f',
        weight: 2 + strength * 7,
        opacity: 0.35 + strength * 0.55,
      },
    )
      .bindTooltip(
        `${t.from} → ${t.to} · given=${t.probability.toFixed(3)} (n=${t.count}) · ${tipFound}`,
        { sticky: true },
      )
      .addTo(state.layers.flows)

    // Label sits toward the destination so A→B and B→A don't stack.
    const lat = from.lat + (to.lat - from.lat) * 0.62
    const lon = from.lon + (to.lon - from.lon) * 0.62
    const dLat = to.lat - from.lat
    const dLon = to.lon - from.lon
    const len = Math.hypot(dLat, dLon) || 1
    const nudge = 0.00012
    const labelLat = lat + (-dLon / len) * nudge
    const labelLon = lon + (dLat / len) * nudge
    L.marker([labelLat, labelLon], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'flow-prob-label',
        html: `<span class="flow-given-prob" style="opacity:${0.55 + strength * 0.45}">${pct}</span>${foundHtml}`,
        iconSize: found == null ? [36, 16] : [64, 16],
        iconAnchor: found == null ? [18, 8] : [32, 8],
      }),
    }).addTo(state.layers.flows)
  }
}

function renderResults(result) {
  const box = document.getElementById('results-table')
  const pill = document.getElementById('hop-pill')
  if (!result) {
    pill.textContent = 'no run'
    box.innerHTML = `<p class="muted">Run a sim to see P(to | from) on your pair network.</p>`
    return
  }

  const transitions = activeTransitions(result)
  const sessionN = state.sessionHopTally.totalHops
  pill.textContent = `${result.totalSteps} locked · ${sessionN} live hops`

  if (!transitions.length) {
    box.innerHTML = `<p class="muted">No hops observed in this view.</p>`
    return
  }

  const rows = transitions
    .slice(0, 80)
    .map((t) => {
      const found = foundProbability(state.sessionHopTally, t.from, t.to)
      const nLive = hopCount(state.sessionHopTally, t.from, t.to)
      const fromN = fromTotal(state.sessionHopTally, t.from)
      const foundCell =
        found == null
          ? `<td class="found-prob is-empty">—</td>`
          : `<td class="found-prob">${(found * 100).toFixed(1)}%<span class="found-n">n=${nLive}/${fromN}</span></td>`
      return `<tr data-from="${escapeHtml(t.from)}" data-to="${escapeHtml(t.to)}">
        <td><code>${escapeHtml(t.from)}</code></td>
        <td><code>${escapeHtml(t.to)}</code></td>
        <td>${t.count}</td>
        <td>${(t.probability * 100).toFixed(1)}%</td>
        ${foundCell}
      </tr>`
    })
    .join('')

  box.innerHTML = `
    <table class="prob-table">
      <thead>
        <tr><th>From</th><th>To</th><th>n</th><th>Given</th><th>Found</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `

  box.querySelectorAll('tr[data-from]').forEach((row) => {
    row.addEventListener('click', () => selectNode(row.dataset.from, true))
  })
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function dataBounds() {
  if (
    state.osmBounds &&
    Number.isFinite(state.osmBounds.minlat) &&
    Number.isFinite(state.osmBounds.maxlat) &&
    Number.isFinite(state.osmBounds.minlon) &&
    Number.isFinite(state.osmBounds.maxlon)
  ) {
    return L.latLngBounds(
      [state.osmBounds.minlat, state.osmBounds.minlon],
      [state.osmBounds.maxlat, state.osmBounds.maxlon],
    )
  }
  const pts = [...state.graphNodes.values()].map((n) => [n.lat, n.lon])
  if (!pts.length) return null
  return L.latLngBounds(pts)
}

function bufferedBounds(bounds, buffer = 0.12) {
  const south = bounds.getSouth()
  const north = bounds.getNorth()
  const west = bounds.getWest()
  const east = bounds.getEast()
  const latPad = Math.max((north - south) * buffer, 0.0004)
  const lonPad = Math.max((east - west) * buffer, 0.0004)
  return L.latLngBounds(
    [south - latPad, west - lonPad],
    [north + latPad, east + lonPad],
  )
}

function confineMapToData() {
  const raw = dataBounds()
  if (!raw) return

  const confined = bufferedBounds(raw)
  state.map.setMaxBounds(confined)
  state.map.options.maxBoundsViscosity = 1

  state.map.fitBounds(confined, { animate: false })
  const minZoom = state.map.getBoundsZoom(confined, true)
  state.map.setMinZoom(minZoom)
  if (state.map.getZoom() < minZoom) state.map.setZoom(minZoom)
}

function loadSavedPairs() {
  const list = savedPairs?.pairs
  if (!Array.isArray(list)) return
  state.pairs = list
    .filter((p) => p?.a && p?.b && p.a !== p.b)
    .map((p) => ({ a: String(p.a), b: String(p.b) }))
}

function applyLockedTransitions() {
  if (!savedTransitions?.transitions?.length) return false
  const result = {
    agents: savedTransitions.meta?.agents ?? 0,
    steps: savedTransitions.meta?.steps ?? 0,
    seed: savedTransitions.meta?.seed ?? 0,
    totalSteps: savedTransitions.meta?.totalSteps ?? 0,
    pairCount: savedTransitions.meta?.pairCount ?? state.pairs.length,
    lightCount: savedTransitions.meta?.nodeCount ?? 0,
    attractorCount: savedTransitions.meta?.attractorCount ?? state.attractors.length,
    transitions: savedTransitions.transitions,
    spawns: savedTransitions.spawns || [],
    samplePaths: savedTransitions.samplePaths || [],
    throughput: savedTransitions.meta?.throughput ?? null,
  }
  state.simResult = result
  drawFlows(result)
  renderResults(result)
  document.getElementById('export-csv').disabled = false
  document.getElementById('export-json').disabled = false
  const t = result.throughput
  document.getElementById('sim-status').textContent = t
    ? `Locked — ${t.spawnedFromSource} from parking · ${t.stoppedAtSink} stopped at food · ${result.totalSteps} hops`
    : `Locked — ${result.totalSteps} hops`
  return true
}

function prepareSimLayers() {
  state.attractors = buildAttractors(state.nodes, state.ways, state.graphNodes, weights)
  state.lights = findLightNodes(state.graphNodes)
  drawAttractors()
  drawLights()
  updateStats()
  renderWeightList()
}

function applyOsmText(text, fileName) {
  const { nodes, ways, bounds: osmBounds } = parseOsm(text)
  const { graphNodes } = buildGraph(nodes, ways)

  if (!graphNodes.size) {
    throw new Error('No road network found. Export ways tagged with highway=* from OSM.')
  }

  state.nodes = nodes
  state.ways = ways
  state.graphNodes = graphNodes
  state.osmBounds = osmBounds
  state.simResult = null
  state.selectedId = null
  state.pairPending = null
  state.pairMode = false
  state.fileName = fileName
  loadSavedPairs()

  document.getElementById('empty-state').hidden = true
  document.getElementById('osm-source').textContent = fileName
  state.layers.tracked.clearLayers()
  state.layers.flows.clearLayers()
  state.layers.paths.clearLayers()
  state.layers.spawns.clearLayers()
  state.layers.pairs.clearLayers()
  drawWays()
  prepareSimLayers()
  drawNodes()
  drawPairs()
  confineMapToData()
  renderDetail(null)
  renderPairList()
  updatePairButtons()
  if (!applyLockedTransitions()) {
    renderResults(null)
    document.getElementById('export-csv').disabled = true
    document.getElementById('export-json').disabled = true
    document.getElementById('sim-status').textContent =
      `Ready — ${state.pairs.length} pairs · agents move only on pairs`
  }
  // Intersection is the main entry view (signal streams stay their own mode).
  setViewMode('intersection')
}

function runSim() {
  if (!state.graphNodes.size) return

  const agents = Math.max(1, Number(document.getElementById('sim-agents').value) || 1)
  const steps = Math.max(1, Number(document.getElementById('sim-steps').value) || 1)
  const seed = (Math.random() * 0xffffffff) >>> 0
  const status = document.getElementById('sim-status')
  const btn = document.getElementById('run-sim')

  status.textContent = `Running ${agents} agents × ${steps} steps…`
  btn.disabled = true

  // Yield so the status paints before a heavy sync run
  requestAnimationFrame(() => {
    try {
      const result = runSimulation({
        graphNodes: state.graphNodes,
        attractors: state.attractors,
        pairs: state.pairs,
        weights,
        agents,
        steps,
        seed,
      })
      state.simResult = result
      drawFlows(result)
      drawPairs()
      renderResults(result)
      document.getElementById('export-csv').disabled = false
      document.getElementById('export-json').disabled = false
      status.textContent = `Done — ${result.throughput?.spawnedFromSource ?? 0} from parking · ${result.throughput?.stoppedAtSink ?? 0} stopped at food · ${result.totalSteps} hops`
    } catch (err) {
      status.textContent = err.message || 'Sim failed'
    } finally {
      btn.disabled = false
    }
  })
}

async function loadOsmFromAssets() {
  const entries = Object.entries(osmAssets)
  if (!entries.length) {
    throw new Error('No .osm files found in src/assets/osm.')
  }

  const [path, url] = entries[0]
  const fileName = path.split('/').pop()
  document.getElementById('osm-source').textContent = `Loading ${fileName}…`

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${fileName} (${response.status})`)
  }

  applyOsmText(await response.text(), fileName)
}

function bindUi() {
  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view))
  })

  document.getElementById('anim-play')?.addEventListener('click', () => playIntersectionAnim())
  document.getElementById('anim-reset')?.addEventListener('click', () => {
    resetIntersectionAnim()
    playIntersectionAnim()
  })
  document.getElementById('anim-instant')?.addEventListener('click', () => {
    runIntersectionInstant()
  })
  document.getElementById('anim-capture')?.addEventListener('click', () => {
    captureFoundAsGiven()
  })
  document.getElementById('layout-select')?.addEventListener('change', (e) => {
    setActiveLayout(e.target.value)
  })
  document.getElementById('sim-log-file')?.addEventListener('change', () => {
    const input = document.getElementById('sim-log-file')
    if (!input) return
    input.value = slugifyLogName(input.value || defaultLogNameForLayout(getActiveLayout()))
    const status = document.getElementById('sim-log-status')
    if (status) {
      status.textContent = `Appends to logs/${input.value}.log when a run finishes (dev server).`
    }
  })
  document.getElementById('predest-enabled')?.addEventListener('change', () => {
    syncAgentTraitsFromUi()
    if (state.viewMode === 'intersection') {
      resetIntersectionAnim()
      playIntersectionAnim()
    }
  })
  document.getElementById('agent-count')?.addEventListener('change', () => {
    syncAgentTraitsFromUi()
    if (state.viewMode === 'intersection' && agentTraits.predestination) {
      resetIntersectionAnim()
      playIntersectionAnim()
    }
  })

  document.getElementById('run-sim').addEventListener('click', runSim)
  document.getElementById('export-csv').addEventListener('click', () => {
    if (!state.simResult) return
    downloadText(
      'trafficflower-light-transitions.csv',
      transitionsToCsv(state.simResult),
      'text/csv',
    )
  })
  document.getElementById('export-json').addEventListener('click', () => {
    if (!state.simResult) return
    downloadText(
      'trafficflower-light-transitions.json',
      transitionsToJson(state.simResult),
      'application/json',
    )
  })

  document.getElementById('toggle-pair-mode').addEventListener('click', () => {
    state.pairMode = !state.pairMode
    state.pairPending = null
    drawPairs()
    drawNodes()
    updatePairButtons()
  })
  document.getElementById('export-pairs').addEventListener('click', exportPairsDoc)
  document.getElementById('clear-pairs').addEventListener('click', () => {
    state.pairs = []
    state.pairPending = null
    renderPairList()
    drawPairs()
    updatePairButtons()
  })
}

async function boot() {
  renderShell()
  initMap()
  bindUi()
  try {
    await loadOsmFromAssets()
  } catch (err) {
    const empty = document.getElementById('empty-state')
    empty.hidden = false
    empty.innerHTML = `
      <h2>Could not load OSM</h2>
      <p>${err.message || 'Failed to load map data from assets/osm.'}</p>
    `
    document.getElementById('osm-source').textContent = 'Load failed'
  }
}

boot()

if (import.meta.hot) {
  // Keep found-hop tallies across Vite HMR of this module (full reload still clears).
  import.meta.hot.dispose(() => {
    import.meta.hot.data.sessionHopTally = state.sessionHopTally
  })
}