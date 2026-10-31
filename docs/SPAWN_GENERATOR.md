# Spawn Generator: design and task breakdown (lean revision)

Status: design v2, 2026-10-31, after the user's answers and the metric research
(`docs/SPAWN_RESEARCH.md` §5). T1 (heights + `js/terrain.js`) is done; T2-T5 remain (section 9).
Appendix A lists what the first draft had and why it was dropped.

The generator produces, for one map and one team mode, ranked start-position sets (Sol HQ,
Cent HQ, Alien Nest) and the list of resource patches to disable, as a normal layout JSON that
the user downloads and drops into `UserData/cfg/Spawns/<Map>/`. The user's six wishes, in
priority order, are the whole specification:

1. equal number of patches inside each human's starter build radius (hard);
2. resources approximately equal per side over each side's prospective map control (a
   weighting on spawn positions);
3. settable enemy start distance;
4. 3-way fair: distance and control, nobody squeezed;
5. avoid high or exposed starts;
6. the generator chooses which patches to disable to meet a settable total per resource
   type; no large blank areas without resources.

## 1. Facts the design rests on

- **Layout JSON the mod reads** (`Si_MapBalance.cs`): `map`, `description`, `spawns.<Faction>[0].{x,z}`
  (web-tool array format), `resources.{balterium_amount, biotics_amount, removed_patches[],
  patch_overrides{}}`, `game_modes`, `koh`, `fusion_reactors`. Unknown keys (`_meta`) are ignored.
  The layout's `settings` radii are not used in-game. In hvh/hvhva the mod swaps the Sol and
  Cent positions in 50 % of rounds, so every human position must suit both factions. hva =
  Sol vs Alien in vanilla; the proposal files write the one human position into `Sol[0]` and
  `Cent[0]`.
- **Radii** (user decision): refinery-from-HQ `R_b` = 1000 m, HQ chain `R_c` = 2500 m,
  Nest `R_n` = 1200 m, one value per radius for both human factions, editable in the
  generator; no hook into the UnitBalance config.
- **Grids**: masks `data/masks/{hq,ref}_{Sol,Cent}_<Map>.png` and heights
  `data/heights/<Map>.png/.json` share the 15 m scan grid of `js/map_config.js`
  (`px = round((x − scan_min_x)/15)`, `py = round((scan_max_z − z)/15)`, row 0 = north; mask
  valid if alpha > 50). Resources `data/resources/<Map>.json` (`idx, type, x, y, z, world_w,
  world_h, resources_max`), 23-88 Balterium and 66-107 Biotics per map.
- **Terrain module (done)**: `Terrain.decode/sample/slope/exposureAt/nestMask/load/selftest`
  in `js/terrain.js`, UMD, DOM-free core. `exposureAt(h, w, hh, step, px, py, params)` →
  `{overlook, highground, openness, E}` with `params = GenSettings.exposure`; a flat open grid
  gives E = 0.2 (openness 1), a sheltered floor 0; per-map medians 0.21-0.42, maxima 0.8-1.1.
  `nestMask(h, w, hh, step, humanMaskUnion, {scan, extent, patches, flatness, ...})` → Uint8Array.
  `Terrain.load(mapName)` resolves `{heights: null, meta: null}` with a warning when files are
  missing; 13 base maps, variants via `base_map`.
- **Vanilla** places 2 teams ~0.5-0.75 half-extents apart on a ring; the v2 proposals used
  `0.9·extent`.
- Node 24 is installed; GitHub Pages deploys the whole repository tree.

## 2. Map-control model

Path-cost (geodesic) distance fields on a fixed 101² control grid, hard Voronoi for area and
borders, soft Voronoi (softmax) for the resource weighting. Reach rings for the starting kit are
Euclidean because the game's build rules are Euclidean.

- **Control grid**: `n = 101`, `cell = 2·extent/100` (60 m on 6 km maps, 20 m on BlackIsle),
  cell centres `x = −extent + (i+0.5)·cell`, `z = extent − (j+0.5)·cell`, index `j·101 + i`.
  Per cell: `h` (bilinear from the 15 m heights, 0 if no height data), `playable` (1 if any 15 m
  cell of `hq_Sol ∪ hq_Cent ∪ ref_Sol ∪ ref_Cent` lies inside, dilated by one control cell).
- **Travel cost** (16-neighbour stencil: 8 + knight moves, so straight distances are within
  2.7 % instead of 8.2 %; `slopeCost.stencil = 8` restores 8 neighbours): `cost = len·(1 + (s/0.25)²)`,
  `s = |Δh|/len`, impassable if `s > 0.70` (≈35°). No up/down asymmetry.
  `controlModel: 'euclidean'` replaces the fields by Euclidean distance for comparison;
  everything downstream is unchanged.
- **Fields**: `D_p` = Dijkstra distance (Float32Array, 10 201 cells, +Inf unreachable) from the
  cell of structure p; binary heap; ~2-4 ms per field in V8; cached per candidate.
- **Hard Voronoi** on playable cells: `owner[c] = argmin_p D_p[c]`, `share_p`, border length
  `L_pq` = playable cells of p with a 4-neighbour of q.
- **Soft Voronoi** (research M5) for resources: `w_p(r) = exp(−D_p(r)/τ) / Σ_q exp(−D_q(r)/τ)`,
  `τ = 0.15·d*`, `D_p(r)` = field value at the patch's cell.

The renderer draws `owner` as a 101² RGBA canvas in an `L.imageOverlay` so the user sees the
model.

**Plug-in point A (control model).** `GenGrid.fields(ctx, settings, set, cache)` returns
`{D, owner, shares, borders}`; another model (influence map, navmesh cost once exported) only
has to return the same shape.

## 3. Objective

A set is evaluated fully built: its patch plan (section 4) is computed first, then the gates
and terms read it. Penalties are normalised so that 1.0 = "a player would notice"; score =
weighted sum, lower is better; presentation bar 3.0 (above it the candidate is shown with a
warning). There is no relaxation ladder: if no set passes every gate, the result lists the
best sets by (number of failed gates, score) with the failures named, and the UI flags them.

### 3.1 Hard gates

| id | rule | modes |
|---|---|---|
| G1 placement | human: cell valid on `hq_Sol ∧ hq_Cent` with all 8 scan neighbours valid, ≥ 250 m from the edge, circumscribed footprint radius 67 m clear of every patch rectangle, on the 15 m grid. Nest: `nestMask` valid (flatness 8 m in 30 m, within 30 m of a human-valid cell, 250 m margin, 36 m footprint clear). Position cut: candidates above the map's 75th exposure percentile are dropped before the search (`exposureCut`). | all |
| G2 separation | every enemy pair `d ≥ 0.85·d*` (Euclidean, `d*` = setting). hvhva: squeeze `S_sq = min_i (ρ_i − 1) ≥ 0.3`, `ρ_i = (d_ij + d_ik)/d_jk` (research M2; 0 = collinear, 1 = equilateral, 0.3 ≈ max angle 100°). | all / hvhva |
| G3 starting kit | after the plan: the number of kept Balterium within `R_b` of each human position is equal (hvh, hvhva) and ≥ `minKit` (default 3) in every mode including hva. Alien: kept Biotics within `R_n` ≥ `minKitAlien` (default 4). | all |
| G4 budget | the plan keeps exactly `N_B` Balterium and `N_O` Biotics (or all patches of a type if the total is ≥ the vanilla count). | all |

### 3.2 Soft terms (five)

`Δ(x)` = difference between the two human positions (hva: between Human and Alien where the
quantity is type-free). Each term has a weight `w` (default 1) in `settings.weights`.

| id | term | formula | modes |
|---|---|---|---|
| T1 separation | `Σ_pairs |d − d*| / (0.15·d*)` + hvhva `CV(d) / 0.10` (research M1) | all |
| T2 resources over control | per side p with resource type t(p): `T_p = Σ_{r kept, type t(p)} v_r · w_p(r)` (soft Voronoi over all sides, section 2), `v_r` = kept amount; **share** `s_p = T_p / Σ_{r kept, type t(p)} v_r` = the fraction of its own resource type that sits in p's soft territory (type-free, so the Biotics-vs-Balterium supply ratio cannot dominate). `b = min_p s_p / max_p s_p`; penalty `(1 − b) / 0.10` (research M5). The raw `T_p` in harvest-minutes stays in the metadata for information. | all |
| T3 control balance | hard-Voronoi playable-area shares: `(1 − min share / max share) / 0.10`; hvhva adds border balance `(0.5 − min L / max L)⁺ / 0.2` and squeeze softness `(0.6 − S_sq)⁺ / 0.2` (research M2) | all / hvhva |
| T4 exposure | `w_exp · Σ_p E_p` + `ΔE / 0.3` + elevation parity `(|z_i − z_j| − 15)⁺ / 15` over enemy pairs, `E` from `Terrain.exposureAt`, `z` = ground height (research M6 lite) | all |
| T5 kit softness | nearest kept patch: `(0.85 − min_i d_i^near / max_i d_i^near)⁺ / 0.10`; kit amount parity `(1 − min A⁰ / max A⁰) / 0.10`; one-hop ring `(R_b, R_b + R_c]`: `max(0, |Δn| − 1) · 0.5` (research M3) | hvh, hvhva |

**Plug-in point B (metrics registry).** Each gate and term is an entry
`{id, kind:'hard'|'soft', modes, weight, compute(ctx, settings, set, built) → number|boolean, label}`
in `GenMetrics.registry`. Research M4 (resource safety), M7 (entrances) or anything else is one
more entry; the UI's "Weights" block is generated from the registry.

## 4. Patch selection: equalise the kit, then cover the map

Inputs: the set, the fields, the vanilla patches, `counts = {balterium: N_B, biotics: N_O}`
(defaults `round(0.75 · vanilla count)` per type, per map, editable), radii. Output: `PatchPlan`.
No roles, no amounts: every kept patch keeps the tool's global amount
(`balterium_amount` / `biotics_amount` from the sliders, `patch_overrides` empty).

1. **Kit (Balterium, human positions).** `n_i` = vanilla Balterium within `R_b` of human
   position i. `k = min(min_i n_i, kitCap)` (`kitCap` default = `N_B / (2·nHumans)`, so the kit
   never eats more than half the budget; `kitCapAuto`, default on, raises k when the capped kit
   would freeze away so many patches that the total cannot be met on small maps). For every
   human position keep its `k` nearest Balterium inside `R_b` (geodesic distance). A patch
   inside two humans' radii counts for both and is kept only when the exclusive ones run out.
   hva: one position, same rule.
2. **Kit (Biotics, Nest).** Keep up to `min(n_A, floor(N_O / (nHumans + 1)))` nearest Biotics
   within `R_n` (`GenPatches.alienKitCap`; N_O/2 in hva, N_O/3 in hvhva) and freeze those; the
   rest inside `R_n` stays available to the fill. hvh: no Nest, skip.
3. **Coverage fill, per resource type.** Remaining budget `m_t = N_t − kept_t`. Greedy
   farthest-first (k-center): with `best[c]` = Euclidean distance from playable control cell c
   to the nearest kept patch of type t (precomputed patch-to-cell table, built once per map),
   repeat: `c* = argmax_c best[c]`, keep the unkept patch of type t nearest to `c*`, update
   `best`. **Paired add inside the human radii (Balterium):** a pick that lies inside human i's
   `R_b` is allowed only together with one extra pick inside every other human's `R_b` (that
   human's unkept in-radius patch nearest to its own current farthest cell; if some human has
   none left, the pick is skipped and the next-nearest patch to `c*` is tried). Each paired pick
   consumes `nHumans` of the budget, so the in-radius counts stay equal and G3 holds exactly
   while kit-removed patches can still close blank areas. Deterministic; ~10 k ops per pick.
   Result: the kept set minimises the largest blank area (`gap_t = max_c best[c]`, reported;
   `plan().paired` lists the paired picks). The gap limit is a property of searched results,
   not of arbitrary positions: a fixed pair where one human's whole in-radius set is its kit
   has no partner patches, so the model selftest reports gaps on fixed sets without failing
   and the harness enforces the limit on the search's top-1.
4. Everything else → `removed_patches`. Report `gap_B`, `gap_O`, kit counts per position, ring
   counts per position, `target`, `vanilla`, `kitK`, `available`.

Wish 2 (resources per control) is deliberately **not** a selection rule: it acts through T2 on
the spawn positions, as the user asked ("a weighting on spawn positions"). Because the
coverage fill is nearly spawn-independent, the plan is cheap (< 1 ms) and the kit step is the
only spawn-dependent part.

**Plug-in point C.** `GenPatches.plan(ctx, settings, set, fields, hooks)` accepts
`hooks.rank(patch, side) → number` to bias the coverage pick (e.g. toward resource safety, M4).

## 5. Heights and exposure (delivered by T1)

`heights.py` writes `data/heights/<Map>.png` (opaque RGB, 16-bit height in R/G, 15 m scan
grid) + `.json` (`hmin, hmax, samples`, asserted on load). Exposure
`E = 0.5·overlook + 0.3·highground + 0.2·openness` (terrain above you within 100-450 m;
TPI vs the 600 m mean; fraction of 16 unblocked 600 m rays with the eye at +3 m). Nest validity
is derived from heights (no Nest scan exists); a Nest scan in the mod exported as
`hq_Alien_<Map>.png` remains the recommended follow-up and would be consumed through
`ctx.masks.hqAlien` with `nestMask` as the fallback.

## 6. Search

Target: ≤ 3 s per map and mode (every map, unloaded machine) in a Web Worker with a progress
bar; byte-identical results for equal seed, inputs and settings.

1. **Candidates.** Humans: cells of the eroded `hq_Sol ∧ hq_Cent` mask passing G1, binned to
   120 m (one seeded random valid cell per bin as representative), exposure percentile cut
   (G1), thinned greedily to ≥ `min(300 m, extent/10)` apart, best first by `nBalt(R_b) − 2·E`
   (ties by the seeded RNG), cap 250. Aliens: the same on `nestMask` with `nBio(R_n) − 2·E`.
   Per candidate precompute `E`, `z`, `nBalt(R_b)`, `nBio(R_n)`, ring counts, and a Float32Array
   of Euclidean distances to every patch.
2. **Stage 1, cheap screen (Euclidean, all sets).** Enumerate all human pairs (≤ 31 k) or, in
   hvhva, pairs × alien candidates with early rejection on G2 (distance band, squeeze) before
   the inner loop. Score = T1 + T4 + a Euclidean T2 proxy on vanilla amounts (soft Voronoi over
   the precomputed patch distances) + `|Δ nBalt(R_b)|·0.5` (kit proxy). Keep the best `K1 = 100`
   (hvh, hva) / `150` (hvhva), bucketed by position class (corner / edge / inner) so no class
   exceeds 60 % of the shortlist, **and diverse**: a set is skipped when an already shortlisted
   set has a mean displacement below `dmin/2` from it (best Sol/Cent assignment).
3. **Stage 2, full evaluation.** Fields per candidate (cached), plan, all gates and terms
   (section 3). ≤ 300 distinct fields × ~3 ms + 150 sets × < 1 ms.
4. **Refinement.** Top 6 sets: each structure tries its 8 scan-grid neighbours (15 m) and the
   valid cells one bin (120 m) away, accepts the best improvement, 2 rounds, seeded order; a
   move whose position-only lower bound already reaches the incumbent is skipped.
5. **Ranking and presentation.** Sort by (failed gates, score). Present `topN = 5` with the
   distinctness filter: under the best Sol/Cent assignment, the **mean** displacement of the
   structures from every already presented set is ≥ `dmin` and the largest is ≥ `dmin`
   (`dmin` = 800 m on ≥ 4 km maps / 500 m otherwise; mean ≥ dmin implies the max condition), so
   one structure may stay near its place when the others move.
6. **Determinism.** One `mulberry32(seed)` stream per run, consumed only by thinning
   tie-breaks, stage-1 bucket tie-breaks and refinement order. The seed and a settings hash go
   into the metadata; "Reseed" draws a new seed.

## 7. Settings UI

One sidebar section **Spawn Generator** (ids prefixed `gen-`), between "Game Modes" and
"Export":

| control | id | default |
|---|---|---|
| Mode radio hvh / hva / hvhva | `gen-mode-*` | hvh |
| Seed (number) + Reseed | `gen-seed`, `gen-reseed` | 1 |
| Enemy start distance (m) | `gen-dist` | `clamp(0.9·extent, 1300, 2700)`, range 800-5000 |
| Refinery radius / HQ chain / Nest radius (m) | `gen-r-build`, `gen-r-chain`, `gen-r-nest` | 1000 / 2500 / 1200 |
| Balterium patches / Biotics patches (number inputs, label shows "of N vanilla") | `gen-n-balt`, `gen-n-bio` | `round(0.75·N)` per map, reset on map change |
| Exposure weight | `gen-w-exposure` | 1.0 (0-3) |
| Generate / Cancel, progress bar | `gen-run`, `gen-cancel`, `gen-progress` | |
| Results: rank, score, gate flags, five term bars; click = preview; Apply, Download per row | `gen-results` | |
| `<details>` Advanced: control model geodesic/euclidean, one number per registry weight, exposure cut percentile, topN | `gen-adv-*` | |
| Layer toggle "Territory (generator)" | `layer-territory` | on while a preview is shown |

Preview = temporary layer group (markers, territory overlay, kept patches tinted by type,
removed patches dimmed); nothing is written to `Placement`/`Layers` until **Apply**, which
builds the layout JSON and calls `UI.importLayout(layout)` (exported from `ui.js`; it reloads
the map, sets the sliders from `settings`, places the HQs and exclusions). **Download** saves
the JSON (`GenLayout.fileName`: `<Map>_<mode>_gen_<dist>m_<B>bal_<O>bio_s<seed>-<rank>.json`) via a Blob. The generator runs in a Web
Worker (`js/gen/worker.js`); Cancel terminates it; a map switch cancels a running job.

## 8. Output and interfaces

### 8.1 Layout JSON

`Placement.exportLayout()`'s shape, plus `description` and `_meta.generator`:

```json
{
  "map": "GreatErg",
  "description": "gen hvhva seed 42 #1 score 1.21",
  "spawns": { "Sol": [{"x":1020,"z":2220,"isSpawn":true,"isBiocache":false}], "Cent": [...], "Alien": [...], "Wildlife": [] },
  "footprints": [],
  "resources": { "balterium_amount": 40000, "biotics_amount": 42000, "removed_patches": [3, 7, ...] },
  "settings": { "solBuildRadius": 1000, "centBuildRadius": 1000, "solChainRange": 2500, "centChainRange": 2500,
                "alienBuildRadius": 1200, "alienNodeChainRange": 150, "alienBiocacheChainRange": 150,
                "wildlifeBuildRadius": 1200, "wildlifeNodeChainRange": 150, "wildlifeBiocacheChainRange": 150 },
  "game_modes": { "hvh": false, "hva": false, "hvhva": true, "4way": false },
  "_meta": { "generator": {
      "version": "1.0.0", "generated": "2026-10-31T12:00:00Z", "seed": 42, "settingsHash": "a1b2c3",
      "settings": { "...": "GenSettings used" },
      "rank": 1, "score": 1.21, "gateFails": [],
      "terms": { "T1": 0.2, "T2": 0.4, "T3": 0.3, "T4": 0.25, "T5": 0.06 },
      "metrics": { "distances": {"Sol-Cent": 2710, "Sol-Alien": 2650, "Cent-Alien": 2800}, "squeeze": 0.62,
                   "shares": {"Sol": 0.34, "Cent": 0.33, "Alien": 0.33}, "borders": {...},
                   "kit": {"Sol": 5, "Cent": 5, "Alien": 7}, "rings": {...}, "exposure": {"Sol": 0.31, "Cent": 0.28, "Alien": 0.40},
                   "elevation": {...}, "T": {"Sol": 1.0e6, "Cent": 0.97e6, "Alien": 0.95e6}, "gap": {"Balterium": 640, "Biotics": 520} },
      "stats": { "candidates": {"human": 180, "alien": 140}, "stage1Sets": 20000, "stage2Sets": 150, "ms": 1800 }
  } }
}
```

hva writes the human position into both `Sol[0]` and `Cent[0]`; `game_modes` has exactly the
generated mode true; `patch_overrides` is omitted (none).

### 8.2 Module contracts

Every `js/gen/*.js` file is UMD, DOM-free and Node-loadable, like `js/terrain.js`:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rng.js'), require('./grid.js'));
  else root.GenSearch = factory(root.GenRng, root.GenGrid);
}(typeof self !== 'undefined' ? self : this, function (GenRng, GenGrid) { 'use strict'; /* ... */ return api; }));
```

Browser: classic `<script>` tags in dependency order (`importScripts` in the worker); Node:
`require`. No ES modules, no DOM or Leaflet inside `js/gen/`.

```ts
GenSettings = {
  mode: 'hvh'|'hva'|'hvhva', seed: number,
  radii: { build: 1000, chain: 2500, nest: 1200 },                 // m
  enemyDistance: number,                                           // d*, m
  counts: { balterium: number, biotics: number },                  // kept totals (default round(0.75·vanilla))
  amounts: { balterium: 40000, biotics: 42000 },                   // per-patch amounts used in T2/T5 and the layout (the tool's sliders)
  minKit: 3, minKitAlien: 4, kitCap: null, kitCapAuto: true,       // kitCap null = N_B / (2·nHumans)
  weights: { T1: 1, T2: 1, T3: 1, T4: 1, T5: 1 },
  exposure: { overlook: 0.5, highground: 0.3, openness: 0.2, weight: 1.0 },   // passed to Terrain.exposureAt
  exposureCut: 0.75,
  controlModel: 'geodesic'|'euclidean', slopeCost: { k: 1.0, s0: 0.25, sMax: 0.7, stencil: 16 },
  nestFlatness: 8, edgeMargin: 250,
  topN: 5, distinctness: number|null, stage1Keep: number|null, refineRounds: 2
}
// GenContext.defaultSettings(raw, overrides) builds this with the per-map defaults (merge one level deep).

GenRaw = {                       // plain data, transferable to the worker; built by browser_adapter.js or the harness
  mapName, cfg: MAP_CONFIG[mapName], resources: <data/resources JSON>,
  masks: { hqSol, hqCent, refSol, refCent: Uint8Array },           // scan grid, 1 = valid (alpha > 50)
  heights: Float32Array|null, heightsMeta: object|null
}

GenContext = {
  map, baseMap, extent, cfg, scan: { minX, maxZ, step, w, h },
  masks: { hqSol, hqCent, refSol, refCent, hqBoth, union },        // hqBoth = hqSol & hqCent, union = hq|ref of both
  heights, nestMask: Uint8Array, vanilla: { Balterium, Biotics }, cache: Map, stats,
  patches: [{ idx, type: 'Balterium'|'Biotics', x, z, y, amount, w, h }],   // amount = resources_max
  ctrl: { n: 101, cell, minX, maxZ, h: Float32Array, playable: Uint8Array, playableIdx: Int32Array, nPlayable,
          patchDist: Float32Array[], patchCell: Int32Array, cx, cz: Float32Array }   // patchDist[k] = Euclidean distance of patch k to every cell
}

Candidate  = { id, role: 'human'|'alien', x, z, px, py, ci, E, z0, nBalt, nBio, ring1: number, pd: Float32Array /* distance to every patch */, ... }  // further fields as candidates.js documents
SpawnSet   = { Sol?: Candidate, Cent?: Candidate, Alien?: Candidate }       // hva: Sol === Cent (same object)
Fields     = { D: { [role]: Float32Array }, owner: Int8Array, sides: string[], shares: {[role]: number}, borders: {[pair]: number} }
PatchPlan  = { kept: { Balterium: number[], Biotics: number[] }, removed: number[], frozen: Set<number>,
               kit: {[role]: number}, rings: {[role]: {r0: {n, amount}, r1: {n, amount}}}, gap: { Balterium: number, Biotics: number },
               target: {type: n}, vanilla: {type: n}, kitK: { human, alien }, available: {type: n}, paired: [[idx, ...], ...] }
Evaluation = { set, sig, gateFails: string[], terms: {[id]: number}, score, metrics: object, plan: PatchPlan }
GenResult  = { settings, candidates: Evaluation[], stats: { candidates: {human, alien}, stage1Sets, stage1Enumerated, stage2Sets,
               refined, refineSkipped, fields, plans, distinctness, fallback, ms, timing: {cand, s1, s2, ref} } }
```

```
GenRng.create(seed) → { next(), int(n), shuffle(arr) }                         mulberry32
GenContext.build(raw: GenRaw, settings) → GenContext                           calls Terrain.nestMask, GenGrid.build
GenGrid.build(ctx, settings) → ctx.ctrl
GenGrid.cellOf(ctx, x, z) → ci;  GenGrid.cellXZ(ctx, ci) → {x, z}
GenGrid.field(ctx, settings, ci) → Float32Array
GenGrid.fields(ctx, settings, set, cache: Map<ci, Float32Array>) → Fields
GenCandidates.list(ctx, settings, role, rng) → Candidate[]
GenPatches.plan(ctx, settings, set, fields, hooks?) → PatchPlan;  GenPatches.alienKitCap(settings, nHumans) → number
GenMetrics.registry: Entry[];  GenMetrics.evaluate(ctx, settings, set, fields, plan) → Evaluation
GenMetrics.softShares(ctx, settings, m) → {side: s_p}                           T2 shares of own type (metrics.shares2)
GenMetrics.cheap(ctx, settings, set) → { reject: boolean, score: number }      stage 1, no fields
GenSearch.run(ctx, settings, onProgress?: (frac, text) => void, shouldStop?: () => boolean) → GenResult
GenLayout.build(ctx, settings, evaluation, rank, amounts: {balterium, biotics}, extra?: {stats, generated}) → layout JSON   (ctx may be a {map} stub)
GenSearch.stableStringify(result), GenSearch.settingsHash(settings), GenSearch.distinctFrom(a, b, mode, dmin)
GenContext.defaultSettings(raw, overrides) → GenSettings
worker protocol: postMessage({type:'run', raw, settings}) → {type:'progress', frac, text}* → {type:'done', result} | {type:'error', message}; {type:'cancel'}
```

## 9. Task breakdown

Status 2026-10-31: T1-T5 implemented; harness `node tools/gen_harness.js` (flags `--maps`,
`--modes`, `--seed`, `--strict`, `--no-determinism`) and `node tools/gen_selftest.js`; first
report 39/39 top-1 sets pass G1-G4, determinism 39/39, selftests green. The review fix round
(section 11) follows. File ownership below is historical; the fixer may touch any of them.

File ownership is exclusive; a task may read but not edit another task's files. Contracts are
section 8.2; an executor who must deviate edits section 8.2 in the same change and reports it.
Nothing is committed by executors.

### T2: Model (grid, candidates, patch plan)

- Owns: `js/gen/rng.js`, `js/gen/context.js`, `js/gen/grid.js`, `js/gen/candidates.js`,
  `js/gen/patches.js`, `js/gen/model_selftest.js` (new).
- Inputs: sections 2, 4, 6.1, 8.2; `Terrain` (done).
- Verify (functions exported from `model_selftest.js`, called by the T5 harness; until T5
  exists run them with `node -e`):
  - Dijkstra on a flat synthetic 101² grid equals Euclidean within 8 % for 100 random cell
    pairs; with a wall of impassable cells the path goes round it; a field takes ≤ 5 ms (print).
  - Voronoi shares sum to 1 over playable cells; two mirrored points on a flat synthetic map
    give 0.5 ± 0.02.
  - On all 13 maps: 40-250 human and 20-250 alien candidates; every human candidate re-checked
    against the raw masks (8 neighbours), edge margin and patch rectangles; no candidate above
    the exposure percentile cut.
  - Plan on 3 fixed sets per map (hand-chosen valid positions, hvh/hva/hvhva): kept counts
    equal the requested totals exactly; kit counts equal across human positions; every kept
    kit patch lies within `R_b`; `kept ∪ removed` = all patches, disjoint; `gap_B ≤ 900 m`
    on 6 km maps at 75 % (print the gaps); plan time ≤ 2 ms.

### T3: Scoring, search, layout, worker

- Owns: `js/gen/metrics.js`, `js/gen/search.js`, `js/gen/layout.js`, `js/gen/worker.js` (new).
- Inputs: sections 3, 6, 8; T2's API (develop against the signatures with a stub plan/fields
  fixture until T2 lands; the final verification needs T2).
- Verify (via the T5 harness): all 13 maps × 3 modes complete; top-1 passes every gate on every
  map and mode except BlackIsle hvhva and Citadel hvhva (report what fails there); runtime
  ≤ 3 s per run on 6 km maps and ≤ 1 s on ≤ 3 km maps in Node on this machine; same seed twice
  → identical SHA-256 of the stringified result; seeds 1-5 on GreatErg hvh give ≥ 2 distinct
  top-1 sets; the presented sets respect the distinctness distance; hand-computed T1, squeeze
  and T4 parity values on 3 fixed sets match (write them into a `metrics_selftest` export).
  `GenLayout.build` output loads in the tool (`importLayout`) and has exactly one true
  `game_modes` entry, `Sol[0] === Cent[0]` in hva, `removed_patches` sorted unique.

### T4: UI, preview, apply, wiring

- Owns: `index.html`, `css/style.css`, `js/generator_ui.js`, `js/gen/browser_adapter.js` (new),
  `js/app.js`, `js/ui.js`, `js/layers.js`.
- Inputs: section 7; T1 `Terrain.load`; the worker protocol (develop against a fake worker
  that returns a canned `GenResult` until T3 lands).
- Outputs: the sidebar section; `Layers.getMaskArray(type, faction, mapName) → Uint8Array|null`
  in `layers.js` (scan grid, 1 = valid, null while the canvas is not loaded; the adapter waits
  for all four); `Terrain.load` called from `App.loadMap` and cached; `UI.importLayout` exported;
  `browser_adapter.js` builds `GenRaw` and `GenSettings` from the DOM, posts to the worker,
  renders results, preview layer (markers, 101² territory `L.imageOverlay`, patch tints),
  Apply, Download; `<script>` tags for `js/terrain.js` and `js/gen/*` in dependency order
  (rng, context, grid, candidates, patches, metrics, search, layout).
- Verify (manual in `python serve.py`, results in the task report): GreatErg hvhva generates in
  < 5 s with the progress bar moving; the overlay matches the markers; Apply places three
  structures, excludes the listed patches, the balance panel updates and the radius sliders show
  1000/2500/1200; Download → Load Layout JSON round-trips; hva Apply puts Sol and Cent on the
  same spot; map switch during a run cancels without console errors; BlackIsle works; the
  Balterium/Biotics inputs reset to 75 % on map change.

### T5: Harness and report

- Owns: `tools/gen_harness.js`, `tools/gen_selftest.js`, `tools/package.json` (`pngjs` dev
  dependency), `.gitignore` (add `tools/node_modules/`, `tools/out/`).
- Inputs: all `js/gen/*`, `js/terrain.js`, `data/*`.
- Outputs: `node tools/gen_harness.js [--maps A,B] [--modes hvh,hva,hvhva] [--seed N] [--out dir]`
  → `tools/out/gen_report.md` with one row per map × mode: ms, candidates, stage-1/2 set
  counts, gate fails, score, five terms, top-1 positions, distances, squeeze, shares, kit
  counts, exposure per structure, elevation span, gaps, kept totals; `tools/out/layouts/*.json`
  for the top 3. `node tools/gen_selftest.js` runs `Terrain.selftest`, T2's `model_selftest`
  and T3's `metrics_selftest`, exits non-zero on any failure. The harness builds `GenRaw`
  from disk (pngjs for masks and heights, `Terrain.decode` for heights).
- Verify: 39 rows; thresholds of T3; exit code non-zero if any row has no candidate or any
  selftest fails; a `--seed` change changes at least one top-1 position on ≥ 10 maps.

### Order

```
wave 1 (parallel, disjoint files):  T2 model  |  T3 scoring/search (stub fixtures)  |  T4 UI (fake worker)  |  T5 harness skeleton + selftest runner
wave 2:  T5 full run on 13 × 3; T3 and T2 fix what the report shows; manager review
```

## 10. Decisions taken in the review (2026-10-31)

1. Biotics in hvh are thinned to the total by coverage like every other mode.
2. `kitCap` = half the Balterium budget per human, with `kitCapAuto` raising it when the total
   cannot otherwise be met.
3. Kept patches use the tool's global amount sliders (`settings.amounts`), no per-patch overrides.
4. The exposure cut stays at the 75th percentile (a setting).
5. T2 compares each side's **share of its own resource type** (section 3.2), not harvest-minutes.
6. G3 enforces `minKit` for the human position in hva as well.
7. Coverage fill may re-add kit-removed patches inside the human radii in matched pairs
   (section 4, step 3), so blank areas never grow beyond what the vanilla patch set allows.
8. Distinctness: shortlist diversity at `dmin/2` plus the mean/max rule at presentation
   (section 6, steps 2 and 5).
9. Runtime target is 3 s on every map (worker + progress bar); refinement covers the top 6.
10. hvhva and hva scores above the 3.0 bar are expected on maps whose geometry does not allow
    better and are shown with the bar warning; the bar is presentation only.

## 11. Review fix round (one fixer)

Acceptance is read from `node tools/gen_harness.js` (`tools/out/gen_report.md`) and
`node tools/gen_selftest.js` after the change, on an otherwise idle machine.

| # | file | change | acceptance |
|---|---|---|---|
| F1 | `js/gen/metrics.js` | T2 = share of own type: `s_p = T_p / Σ v_r` over kept patches of `t(p)`; penalty `(1 − min s / max s)/0.10`; keep `T` (harvest-minutes) and add `shares2: {side: s_p}` to the metrics; update `cheapT2` to the same share formula on vanilla amounts; adjust `metrics_selftest` (0.75/0.25 fixture: shares 0.75/0.25 → penalty 6.667 unchanged; add a hva fixture with 10 Biotics vs 2 Balterium mirrored → T2 = 0). | hvhva top-1 scores on all 13 maps ≤ the current ones, median hvhva score ≤ 4.0; GreatErg hvhva T2 reflects Sol vs Cent (report `shares2`); IndustrialQuarter hvhva T2 < 2.0; selftests green. |
| F2 | `js/gen/metrics.js` (G3) | remove the `m.mode !== 'hva'` guard for `minKit`: in hva the single human kit must be ≥ `minKit`. | all 13 hva rows: `kit S ≥ 3`; 39/39 still pass G1-G4. |
| F3 | `js/gen/patches.js` | paired add (section 4 step 3): kit-removed Balterium inside human radii join the pool with the tag of the human(s) whose `R_b` contains them; when the farthest-first pick is such a patch, also pick for every other human its nearest-to-own-farthest-cell tagged patch (prefer the one that most reduces that human's `max best`); skip the pick if any human has none; a shared patch (inside two radii) counts for both and needs no partner. Budget bookkeeping: each paired pick consumes one per human. Keep `frozen` reporting the kit-decided patches. Extend `model_selftest`: kit equality after paired adds on all 13 maps × 3 fixed sets; gap ≤ max(900 m, 1.05 × vanilla gap) for Balterium. | report `gap B` ≤ max(900, 1.05 × vanilla gap) on 39/39 rows (CrimsonPeak ≤ ~950, WhisperingPlains ≤ ~990); kit counts still equal on every hvh/hvhva row; G4 totals exact. |
| F4 | `js/gen/search.js` | (a) shortlist diversity: while filling the K1 shortlist, skip a set whose every structure is within `dmin/2` of an already shortlisted set under the best Sol/Cent assignment (reuse `distinctFrom` with `dmin/2`), fall back to the skipped ones if the shortlist is short; (b) presentation: `distinctFrom` = mean displacement ≥ dmin AND max displacement ≥ dmin; (c) `REFINE_TOP = 6`. | results column = 5 on all hvh and hva rows and ≥ 4 on ≥ 11 of 13 hvhva rows (BlackIsle may stay below); determinism 39/39; `ms` ≤ 3000 on 39/39 rows. |
| F5 | `tools/gen_harness.js` | thresholds: 3000 ms for every map; add columns `shares2` (T2 shares) and `vanilla gap B/O`; add check "gap B ≤ max(900, 1.05·vanilla)". | report shows the new columns and the gap check with 39/39 ok. |
| F6 | `js/generator_ui.js` / `index.html` | results row: show the T2 shares (`s_Sol/s_Cent[/s_A]`) and the gaps next to the score; the bar warning text reads "above 3.0: geometry limits fairness on this map". | manual: GreatErg hvhva and IndustrialQuarter hva rows show the shares; no console errors. |
| F7 | `docs/SPAWN_GENERATOR.md` | none; this section is the spec of the round. Report the final harness numbers in the task report. | |

Outcome 2026-10-31: F1-F6 pass; gates 39/39, 5 results on 39/39, determinism 39/39, slowest run
1.4 s; medians hvh 1.05, hva 0.82, hvhva 3.45 (max 8.1 on cramped maps, shown with the bar
warning); gap within limit on 39/39. hvh top-1 scores rose by 0.04-0.45 on 5 maps because the
paired adds enlarge the kits (e.g. CrystalChasm 8 → 11 per side); accepted as the price of no
blank areas. F8 (closing): `js/gen/model_selftest.js` gap check on fixed sets is report-only
(`node tools/gen_selftest.js` exits 0); the harness keeps the hard gap check.

## Appendix A: dropped from the first draft

Home/contested zoning (r < 0.6), role quotas, home-share settings, alternating contested
split, centroid and home-distance terms, filler patch class and amounts, per-faction radii
with the dead annulus, the 5-level relaxation ladder, lock-placed-HQs, the research terms
M4 (resource safety; can return via plug-in B), M7 (entrances) and M8 (AI validation).
Reason: the user asked to keep it simple; T2 (soft-Voronoi resources over control) covers what
the zoning terms were for, and the coverage fill covers what fillers were for.

## 12. Expansion layer fairness (design round 3, 2026-10-31)

**Finding.** The starting kit (G3) is equal, but the first expansion layer is not: in Davey's
NarakaCity layout the best single expansion HQ grabs 7 Balterium for Sol and 14 for Cent
(10/10 at the start); several of our own hvh top-1 layouts show 9/3 (RiftBasin), 10/6
(NarakaCity), 5/9 (CrimsonPeak). No existing term measures what an expansion HQ can actually
reach: T5's one-hop annulus includes enemy ground and ignores HQ validity and clustering;
T2/T3 weigh all territory alike. User view: the first expansion layer matters more than
overall control, deeper layers much less; players build 1-3 expansion HQs at once; patch
density within an HQ's build radius matters; keep the model simple and robust.

### 12.1 Model: the expansion curve V(k)

For human i with spawn s_i, after the patch plan:

- **Own side** of a patch or control cell = its geodesic Voronoi owner is i (`fields.owner`,
  section 2.3); in hvhva the Alien region therefore blocks both human layers (the alien
  expands by node lines and is not modelled further). Euclidean fallback when no fields:
  nearer to s_i than to any other spawn.
- **Expansion cells** C_i = control cells c with `ctrl.hqOk[c]` (centre scan cell and its 8
  neighbours valid on `hq_Sol ∧ hq_Cent`, i.e. valid for both factions because of the swap),
  `d(c, s_i) ≤ expReach · R_c` (Euclidean, the game's chain rule; `expReach` default 0.85 = replay p75-p90 of first-hop distance, see Si_MapBalance/analysis/expansion_2026-10-31/NOTES.md) and
  owner(c) = i.
- **Grab set** of a cell: kept Balterium within `R_b` of the cell centre, on i's side, and not
  inside the kit (`d(r, s_i) > R_b`).
- **Curve**: greedy maximum coverage, `V_i(k)` = patches grabbed by the best k expansion cells
  chosen one after another, k = 1..K, `K = 3` (default; the replay study sets K and `expReach`,
  nothing else). `V_i(1)` is the density of the best cluster, `V_i(K)` the breadth of the layer.

Why this and not more: one curve per side with two data-settable parameters captures both
things the user named (density and the 1-3 HQ layer), uses only inputs we already compute, is
monotone and cheap, and degenerates gracefully. **Small maps:** one HQ saturates the layer, so
V(1) = V(K) = the own-side layer count and the gates reduce to layer equality. **Large maps:**
the curve rises over k and the gates compare the first cluster and the three-HQ breadth
separately. **hvhva:** both humans are compared pairwise with the Alien as blocker. **hva:** one
human, the curve is reported only. Whole-layer totals (every own-side patch within
`R_c + R_b`) are reported but not scored: beyond K HQs the user says it matters little.

### 12.2 Gates and terms

| id | rule | modes |
|---|---|---|
| G5 expansion | `abs(V_Sol(1) − V_Cent(1)) ≤ 1` and `abs(V_Sol(K) − V_Cent(K)) ≤ 2` | hvh, hvhva |
| T6 expansion balance (soft) | `(1 − Σ_k w_k · min_i V_i(k) / max_i V_i(k)) / 0.10`, k = 1..K, `w = (0.45, 0.35, 0.20)` = the share of top-20 team-rounds with ≥ k first-hop HQs (89/68/40 %, normalised); ratio 1 when both are 0 | hvh, hvhva |

Changes to the existing terms so the total stays at five soft terms:

- **T5 removed.** Its ring component is superseded by T6; its kit-amount parity is always 0
  with uniform amounts; its nearest-patch ratio adds nothing the kit gate does not.
- **T2 default weight 0.5, T3 default weight 0.5** (all components, incl. the hvhva border and
  squeeze softness; the squeeze hard gate G2 is unchanged). The first layer outranks overall
  control, as the user said.
- Terms: T1 separation, T2 resources over control, T3 control balance, T4 exposure, T6 expansion.
- Stage-1 proxy: `abs(V1_solo(Sol) − V1_solo(Cent)) · expansion.proxy`, where `V1_solo(c)` is
  the best single expansion cell for candidate c ignoring the enemy (vanilla Balterium outside
  `R_b`, cells within `expReach·R_c`), precomputed per candidate. **Default `proxy = 0`**
  (implementation round: at 0.5 the enemy-blind value pushed better sets out of the shortlist,
  equal or worse top-1 on 38/39 rows and a gap failure on GreatErg hvhva, while G5 and the
  min/max targets were met either way). `V1_solo` stays precomputed and the weight settable.

### 12.3 Patch selection: layer cap in the coverage fill

After the kit step nothing in the layer is kept yet, so the coverage fill decides the layer.
Add a cap to the Balterium fill (section 4 step 3): a pick that lies on human i's side within
`expReach·R_c + R_b` of s_i is **inadmissible** while `layer_i ≥ layer_j + 2` for the other
human j (hvhva: for any other human). When the patch nearest to the farthest cell `c*` is
inadmissible, take the nearest admissible patch to `c*`; if none exists, take the nearest
anyway (coverage wins, G5 may fail and the search moves on). Paired adds inside the kits are
unchanged. Cost O(1) per trial (owner lookup + distance). `V(1)` itself is not enforced in the
fill: with a coverage-driven fill one side rarely gets a dense cluster the other lacks, and
the search optimises it through G5/T6.

### 12.4 Performance

Once per map and `R_b` (`GenExpansion.prepare`, cached in `ctx.cache`): for every control cell
with `ctrl.hqOk`, the Uint16 list of Balterium patch indices within `R_b` of its centre
(≤ 10 201 cells × ≤ 90 patches ≈ 1 M distance checks, < 20 ms). Per set: for each human the
cells within `expReach·R_c` with owner = i (≤ ~5 k on 6 km maps), K greedy passes over their
lists with a `got` bitset over patches: ≈ 0.3 ms per set, ≈ 50 ms for 150 stage-2 sets plus the
refinement evaluations. `V1_solo` per candidate: one pass of the same lists, ≤ 250 candidates.
Budget stays well under the 3 s target.

### 12.5 Interfaces (new module `js/gen/expansion.js`)

```
GenExpansion.prepare(ctx, settings) → ctx.exp = { cover: Array<Uint16Array|null> /* per ci; null = no valid HQ */, Rb }
GenExpansion.curve(ctx, settings, spawn: Candidate, sideIndex: number, fields: Fields|null, keptBalt: Uint8Array /* per patch k */, K) →
    { V: number[K], cells: number[K] /* chosen ci or -1 */, layer: number /* own-side kept Balterium outside R_b within expReach·R_c + R_b */ }
GenExpansion.solo(ctx, settings, cand) → number                     // V1 ignoring enemies, vanilla patches
GenSettings additions: expansion: { K: 3, reach: 0.85, w: [0.45, 0.35, 0.20], proxy: 0 }; weights: { T1: 1, T2: 0.5, T3: 0.5, T4: 1, T6: 1 }  (T5 gone)
PatchPlan additions: layer: {[role]: number}; Evaluation.metrics additions: expansion: {[role]: {V: number[], cells: [{x,z}], layer}}, expansionRatio: number[]
ctrl addition (grid.js): hqOk: Uint8Array per control cell
```

### 12.6 Acceptance (harness)

- New harness mode `node tools/gen_harness.js --layout <file.json> [--layout ...]`: evaluates an
  existing layout (spawns + removed_patches, radii from its `settings`) with
  `GenMetrics.evaluate` and prints gates, terms and the curve. **Davey's NarakaCity layout must
  fail G5** (V(1) 7 vs 14) and show T6 > 3.
- Report columns per row: `V(1..K)` per human, `layer` per human, `min/max` at k = 1 and k = K.
- Target: `min/max ≥ 0.85` at k = 1 and at k = K on ≥ 11 of 13 hvh maps for the top-1; G5 holds
  on every hvh/hvhva top-1 where any set passes it (the fallback lists the failure otherwise).
- Unchanged: gates G1-G4 39/39, 5 results per row, determinism 39/39, gap check 39/39, `ms ≤ 3000`.
- Selftests: synthetic fixture where Sol has one cluster of 6 within `R_b` of one valid cell
  and Cent has 6 spread over three cells → V_Sol = [6,6,6], V_Cent = [2,4,6],
  T6 = (1 − (0.45·1/3 + 0.35·2/3 + 0.20·1))/0.10 = 4.167; the layer cap keeps `abs(Δlayer) ≤ 2` on 13 maps × 3
  fixed sets unless the pool runs dry (report).

### 12.7 Tasks (two executors, disjoint files)

**E1 model** — owns `js/gen/expansion.js` (new), `js/gen/grid.js` (`ctrl.hqOk`), `js/gen/patches.js`
(layer cap, `plan.layer`), `js/gen/model_selftest.js`, `js/gen/context.js` (settings defaults
`expansion`, `weights` without T5). Verify: selftest fixture above, `prepare` ≤ 20 ms per map,
`curve` ≤ 0.5 ms per set on GreatErg (print), layer cap check on 13 × 3 fixed sets.

**E2 scoring, harness, UI** — owns `js/gen/metrics.js` (G5, T6, remove T5, weights, stage-1
proxy, `metrics.expansion`), `js/gen/candidates.js` (`V1_solo` per candidate via
`GenExpansion.solo`), `js/gen/layout.js` (metadata passthrough), `tools/gen_harness.js`
(`--layout` mode, curve columns, acceptance checks), `js/generator_ui.js` + `index.html`
(curve `V_Sol/V_Cent` per result row, weight inputs follow the registry). E2 develops against
the §12.5 signatures with a stub until E1 lands; the final run needs E1. Verify: §12.6.

Order: E1 ∥ E2, then one harness run, then manager review.

### 12.8 Outcome (implemented 2026-10-31)

Davey's NarakaCity layout fails G5 (V 7/11/13 vs 12/17/19, T6 3.74); G5 passes on 26/26
hvh/hvhva top-1; min/max ≥ 0.85 at k = 1 and k = K on 13/13 hvh top-1 (3/13 before); G1-G4,
5 results, determinism and gap check 39/39; slowest run 1.1 s. Also: the UI hides gate chips
that do not apply to the mode; `--layout` uses the map's default d* and the layout's kept
totals as counts; the plan cache key includes the layer zones.

### 12.9 Parameters from the replay study (`Si_MapBalance/analysis/expansion_2026-10-31/NOTES.md`)

324 rounds, 377 top-20 team-rounds, 973 first-hop HQs, current radii era (chain 2500, build
~1000). HQs alive (HvH, median): 1 at 10 min, 2 at 15, 3 at 20-30; first-hop HQs per team-round
median 2 [1-4], ≥ 1/2/3 in 89/68/40 %; anchor distance median 0.67 × chain, p90 0.92; a first-hop
HQ opens 5 [3-7] new Balterium against a greedy best of 10 [9-12]. Taken over: **K = 3**,
**expReach = 0.85**, **T6 weights 0.45/0.35/0.20**. Not taken: a lower placement bound (cells
near the spawn grab little because kit patches are excluded) and the "half of greedy" scale (a
constant factor does not change ratios).

## 13. Exact starting kits (round 4)

User request: fix the number of patches each starter spawn has in reach (humans: Balterium
within `R_b`; Nest: Biotics within `R_n`), so the algorithm cannot "break" the start.

### 13.1 Settings and semantics

`GenSettings.kitExact: null | int` (per human, Balterium) and `nestKitExact: null | int`
(Biotics). `null` = auto (today's behaviour, default). With a number n / m: every presented
layout has **exactly** n kept Balterium within `R_b` of every human spawn and exactly m kept
Biotics within `R_n` of the Nest; spawn spots that cannot reach that are rejected. The kit
exceeds the budget rule (`kitCap`, `kitCapAuto`), which is ignored when exact.

### 13.2 Candidate filtering (`candidates.js`)

When `kitExact = n`: drop human candidates with `nBalt(R_b) < n` (vanilla Balterium within
`R_b`, already precomputed). When `nestKitExact = m`: drop alien candidates with `nBio(R_n) < m`.
`stats.kitRange = { humanMax, alienMax }` = the maxima over the unfiltered candidates (the UI
shows them). Overlapping human radii are not filtered here: a patch inside both radii counts
for both kits, so the per-candidate count is a necessary condition and the plan (13.3) decides;
with `d ≥ 0.85·d* > 2·R_b` overlaps are rare.

### 13.3 Patch plan (`patches.js`)

- Human kit: `k = n` exactly; `kitCapAuto` off; shared-patch handling unchanged (`kMax = e +
  shared`; a set with `kMax < n` cannot reach n for every human and the plan reports
  `failures: ['kit_exact']`, which G3 turns into a gate fail). All Balterium inside any human
  `R_b` stays frozen and the **paired adds are disabled** (the in-radius pool is empty), so the
  count stays n.
- Nest kit: freeze the m nearest Biotics inside `R_n` as kept and **freeze the remaining
  Biotics inside `R_n` as removed** (excluded from the fill); auto keeps today's behaviour.
- Everything else (coverage fill, layer cap, G4 target) unchanged. If the fill pool runs dry
  because of the frozen-removed patches, the plan reports `failures: ['kit_total' | 'nest_total']`
  with the achievable count (13.5).

### 13.4 G3

Exact mode: `kit[h] === n` for every human and `kit.Alien === m`; auto mode as today
(equal, ≥ minKit / ≥ minKitAlien). The gate fails cleanly, never throws.

### 13.5 Infeasibility: a named result, no clamping

`GenSearch.run` returns `{ candidates: [], infeasible: { reason, detail }, stats }` (no exception,
worker posts `done`) when:

| reason | condition | detail |
|---|---|---|
| `kit_budget` | `n · nHumans > counts.balterium` | "kit needs X Balterium, total is Y" |
| `nest_budget` | `m > counts.biotics` | likewise |
| `kit_candidates` | fewer human candidates with `nBalt ≥ n` than human roles (hvh/hvhva 2, hva 1) | "max reachable on this map: humanMax" |
| `nest_candidates` | no alien candidate with `nBio ≥ m` | "max: alienMax" |
| `no_set` | candidates exist but no set passes G1-G3 at stage 2 (e.g. only overlapping spots) | best set's gate fails |
| `kit_total` / `nest_total` | exact mode freezes patches as removed inside the radii, so the pool can run dry: `kept_t < target_t` (G4) for a set. Such a set is **excluded from presentation** in exact mode (never shown with a red G4); if no set survives, the run is infeasible with this reason | "with n/m = …, at most X Balterium/Biotics can be kept on this map (requested Y); lower the total or the kit" with X = the largest achievable kept count over the evaluated sets |

Both sides can hit this: the Nest clears the other Biotics inside `R_n`, and the human exact
kit freezes the other Balterium inside `R_b` as removed with the paired adds off. Auto mode is
unchanged (G4 shown as a gate, fallback allowed).

No silent clamping of n, m or the totals: the user set them and sees the reason plus the
feasible maxima. The existing fallback (show the best sets with gate fails) applies only to
auto mode; in exact mode a set that misses the kit is never presented.

### 13.6 Interactions

- **Gap check:** with paired adds off, blank areas near the starts can grow (that is what
  the user asked for). The harness gap check becomes **report-only when either exact setting is
  on**; it stays hard in auto mode. The fill still minimises the gap outside the frozen zones.
- **G5 / layer cap:** unchanged; the curve already excludes kit patches (`d > R_b`).
- **Plan cache:** `planKey` is built per run from the set and its zones; settings are
  constant within a run, so no key change. Confirm in the task that the key covers the kit
  zones (it does today via the in-radius patch sets).
- **Determinism:** unchanged; auto results must stay byte-identical.

### 13.7 UI

Advanced block: two number inputs `gen-adv-kit` ("Start Balterium per human") and
`gen-adv-nestkit` ("Start Biotics for the Nest"), empty = auto, placeholder "auto"; after a run
the label shows "max on this map: X" from `stats.kitRange`. An infeasible run shows
`infeasible: <reason>: <detail>` in `gen-status` and an empty result list; no console errors.

### 13.8 Acceptance

- Auto: SHA-256 of the result identical to the committed round-3 output on 39/39 rows.
- Outcome 2026-10-31: auto identical 39/39 (new null keys stripped); sweep 216 ok, 18 infeasible
  with reasons, 0 crashes, max 1.15 s; the G4-in-exact-mode rule above was added after the
  first sweep showed 46 presented results with a red G4 (BlackIsle every m).
- Sweeps `node tools/gen_harness.js --sweep-kit 3,5,8,12 --sweep-nest 4,8,15` (hvh: kit only;
  hva, hvhva: both): one row per map × mode × value, status `ok` (every presented result has
  exactly n per human and m for the Nest, verified from the layout's `removed_patches`) or
  `infeasible: <reason>`; never an exception or an empty result without a reason; `ms ≤ 3000`;
  determinism on a sample (seed repeated) 100 %.
- Selftests: fixture with n = 2 on the synthetic hvh context (kit 2/2, paired adds absent);
  fixture with n larger than any candidate → `kit_candidates`.

### 13.9 Task (one executor)

Owns: `js/gen/candidates.js`, `js/gen/patches.js`, `js/gen/metrics.js` (G3), `js/gen/search.js`
(infeasible result, `stats.kitRange`), `js/gen/context.js` (defaults `kitExact: null`,
`nestKitExact: null`), `js/gen/model_selftest.js`, `js/gen/browser_adapter.js` (settings from
the DOM), `js/generator_ui.js`, `index.html`, `tools/gen_harness.js` (`--kit`, `--nest`,
`--sweep-kit`, `--sweep-nest`, report-only gap when exact). Verify: 13.8. Doc: none (this
section is the spec); report the sweep table in the task report.
