/**
 * Single-intersection focus for the Intersection tab / Algo.md.
 * Plus-shaped window: focus ±2 lights N/S and ±2 E/W on the 6×8 light grid,
 * plus a few extra spur lights/roads.
 */

export const FOCUS_CENTER_ID = '1020'

/** Extra lights beyond the plus arms (and the roads that connect them). */
export const EXTRA_FOCUS_IDS = ['1017', '1044', '1029']

/** Grid layout used by the synthetic map (id = 1000 + row*COLS + col). */
export const GRID = { rows: 6, cols: 8, originId: 1000 }

export function lightRowCol(id) {
  const n = Number(id) - GRID.originId
  if (!Number.isFinite(n) || n < 0) return null
  const row = Math.floor(n / GRID.cols)
  const col = n % GRID.cols
  if (row < 0 || row >= GRID.rows || col < 0 || col >= GRID.cols) return null
  return { row, col }
}

export function lightIdAt(row, col) {
  if (row < 0 || row >= GRID.rows || col < 0 || col >= GRID.cols) return null
  return String(GRID.originId + row * GRID.cols + col)
}

/**
 * Plus-shaped neighborhood: same row within ±maxArm cols, or same col within ±maxArm rows.
 * @returns {Set<string>}
 */
export function focusNeighborhoodIds(centerId = FOCUS_CENTER_ID, maxArm = 2) {
  const center = lightRowCol(centerId)
  const ids = new Set()
  if (!center) {
    ids.add(String(centerId))
    return ids
  }

  ids.add(centerId)
  for (let d = 1; d <= maxArm; d++) {
    const n = lightIdAt(center.row - d, center.col)
    const s = lightIdAt(center.row + d, center.col)
    const w = lightIdAt(center.row, center.col - d)
    const e = lightIdAt(center.row, center.col + d)
    if (n) ids.add(n)
    if (s) ids.add(s)
    if (w) ids.add(w)
    if (e) ids.add(e)
  }
  for (const id of EXTRA_FOCUS_IDS) ids.add(id)
  return ids
}

export function filterPairsToFocus(pairs, focusIds) {
  return (pairs || []).filter((p) => focusIds.has(String(p.a)) && focusIds.has(String(p.b)))
}

export function filterTransitionsToFocus(transitions, focusIds) {
  return (transitions || []).filter(
    (t) => focusIds.has(String(t.from)) && focusIds.has(String(t.to)),
  )
}
