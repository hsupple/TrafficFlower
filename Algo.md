# Algo

## Scope (step 1): one intersection

We start the algorithm write-up on a **single focus intersection**, not the full 48-light network.

**Focus light:** `1020` (Light R2C4) — a central **5-way** on the synthetic grid.

**Local window:** a plus-shaped neighborhood around that light:

- up to **2 lights north / south** (same column)
- up to **2 lights east / west** (same row)
- the focus light itself

## Layouts

Stored in `src/sim/layouts.json` (includes **light positions** + spawn + signal config):

| Layout | Spawns | Lights |
|--------|--------|--------|
| **Default** | 50–250 agents at **random** paired lights map-wide | Same center `1020` + stop lines `1012` / `1019` / `1021` / `1028` |
| **Layout 1** | Fixed streams: 10/corner + 4 at `1019`/`1012` | Same signal lights / positions |

Switch layouts from the Intersection panel dropdown.

## What is kept

Locked transition probabilities from the full-network run:

- **20 000 agents × 20 000 steps**, seed **78**
- stored in `src/sim/trafficflower-transitions.json`

In the Intersection tab those **same** \(P(\text{to} \mid \text{from})\) values are reused — we do not re-estimate them. We only **filter** to hops whose endpoints both lie in the local cross.

## Local objects

| Object | Role |
|--------|------|
| Focus light | Center of the cross; primary intersection under study |
| Arm lights | Neighbors within ±2 along the row/column |
| Spur lights | Extra focus nodes `1017`, `1044`, `1029` with connecting roads |
| Local pairs | Bidirectional legal moves between local lights |
| Local weights | Locked hop probabilities on those pairs |

## Local streams (Thoughts)

On the **Intersection** tab we animate competing flows with locked weights:

- **Corners** `1004`, `1044`, `1017`, `1022` — **10 agents each** (blue)
- **Competitors** `1019`, `1012` — **4 agents each** (coral)
- Extra spur lights in view: `1017` (west), `1044` (south), `1029` (SE) with their connecting roads
- Each hop follows renormalized local \(P(\text{to}\mid\text{from})\) from the locked run
- Motion is eased and slow (~2.2s per light hop)
- Agents **queue between lights** on the approach (not stacked on the node / intersection box)

### Dual signal at `1020`

Two opposing phases (never both green):

- **H green / V red** — east–west may move; north–south wait
- **V green / H red** — north–south may move; east–west wait

**Stop lines** (queue here when your axis is red): `1012`, `1028`, `1019`, `1021`.

On arrival at a stop line or the center, an agent **rolls once** and holds that hop:

- **Backtrack** may leave on red
- Otherwise needs its axis green; ticks do **not** re-roll while waiting
- Phase length ~4.5s each

Play / Reset controls live in the focus panel; streams auto-start when you open the tab.

