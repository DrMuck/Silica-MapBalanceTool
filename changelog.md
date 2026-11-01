# Changelog

## 2026-11-01 — Sol/Cent swap switch

### Added
- **Random Sol/Cent swap** checkbox under Game Modes, saved as `"swap_spawns"` in the layout JSON (Si_MapBalance 3.3.2+). Unticked = the mod keeps Sol and Cent on their own positions for this layout; ticked (default) = the 50 % swap in HvH / HvHvA as before. Layouts without the field load as ticked
- Generated layouts carry `"swap_spawns": true`

## 2026-11-01 — Spawn Generator: random fair search

### Added
- **Random fair search** checkbox in the Spawn Generator: several runs (default 12) over a band of enemy start distances (default 0.6-1.4 x the map's default distance) with random seeds; the fairest distinct sets of all runs are shown
  - Fixed: mode, radii, Balterium / Biotics totals, starting kits, weights and exposure settings; only the distance and the seed vary
  - Ranked by the **fair score** = score without the part of T1 that measures closeness to the set distance (that part means nothing once the distance varies); the 3-way distance balance stays in
  - Each row shows the run it came from (`d* 2100 m · seed … · run 4/12 #2 · score …`); Apply / Download write the normal layout of that run, so the file name and `_meta` match a normal Generate with that distance and seed, plus `_meta.generator.random`
  - Same Seed field = search seed: the same seed and settings give the same results
- `tools/gen_harness.js --random N [--band lo,hi]`: one search per map x mode, checks timing, determinism, that a normal run reproduces the top set, distinctness, band and fair <= score; writes `random_report.md`

## 2026-10-31 — Spawn Generator: resource summary per result

### Added
- Each result row shows the kept Balterium / Biotics on the map (patch count and total) and inside each starting circle (Balterium within the refinery radius per human, Biotics within the Nest radius); totals follow the global amount sliders live

## 2026-10-31 — Spawn Generator: exact starting kits

The previous version (expansion layer fairness) is kept on the `old-v2` branch, the first generator on `old`.

### Added
- **Start Balterium per human** and **Start Biotics for the Nest** under *Advanced*: empty = auto (unchanged behaviour), a number = exactly that many patches inside the refinery radius / Nest radius
  - Starting spots that cannot reach the number are skipped; the other patches inside the radius are removed and none are added back by the blank-area fill
  - After a run the labels show the maximum possible on the current map
  - A request the map cannot carry returns no results and a reason in the status line instead (total too small for the kit, no spot reaches the kit, totals unreachable with the kit, no fair spawn found)
- `tools/gen_harness.js`: `--kit n`, `--nest m`, `--sweep-kit`, `--sweep-nest`; every presented exact result is re-counted from its layout

## 2026-10-31 — Spawn Generator: expansion layer fairness

The previous generator version is kept on the `old` branch.

### Added
- **Expansion curve** per human side: Balterium on its own side (outside the starting radius) that the best 1, 2 and 3 expansion HQs can grab, on valid HQ spots within 0.85 × chain range of the start. Covers both patch density (first HQ) and expansion room (three HQs)
  - New hard rule G5: first expansion HQ within 1 patch between the sides, three HQs within 2
  - New score T6 over the whole curve, weights 0.45 / 0.35 / 0.20 (share of top commanders who build at least 1 / 2 / 3 first-hop HQs, from replays)
  - Result rows show the Sol / Cent curve; `_meta.generator.expansion` in the layout JSON
- `tools/gen_harness.js --layout <file>` scores any layout JSON (e.g. a hand-made one) with the generator's gates and terms

### Changed
- Patch selection stops adding Balterium to a side's expansion layer once it is 2 patches ahead
- Territory share (T2) and territory balance (T3) default weight 0.5; the old expansion-ring term (T5) is removed
- Gate chips that do not apply to the mode are hidden (no G5 in HvA)

## 2026-10-31 — Spawn Generator

### Added
- **Spawn Generator** sidebar section: generates fair HQ / Nest positions and picks which patches to disable, for HvH, HvA and HvHvA
  - Settings: mode, seed (Reseed), enemy start distance, build / chain / Nest radius (defaults 1000 / 2500 / 1200 m = live UnitBalance values), Balterium / Biotics patch count (default 75 % of the map's vanilla count), exposure weight; *Advanced* holds the control model, term weights, exposure cut and result count
  - Hard rules: valid HQ spot away from exposed high ground, enemies at least 0.85 × the set distance, no team squeezed between the other two in 3-way, the same Balterium patch count inside every human build radius, exact patch totals
  - Ranked by separation, each side's share of its own resource over its territory (travel-distance soft Voronoi), territory balance, exposure and starting kit; patch removal keeps blank areas no larger than on the vanilla map
  - 5 distinct ranked results per run with territory overlay preview; *Apply* loads one into the tool, *Download* saves the layout JSON for `UserData/cfg/Spawns/<Map>/` as `<Map>_<mode>_gen_<distance>m_<N>bal_<N>bio_s<seed>-<rank>.json`
  - Same seed and settings give the same layouts; runs in a Web Worker, about 0.5-1.5 s per map
- `heights.py`: terrain height grids (`data/heights/*.png` + `.json`) from the client heightmaps, used for slope, travel cost and exposure (`js/terrain.js`)
- `tools/gen_harness.js` / `tools/gen_selftest.js` (Node, `npm install` in `tools/`): run all maps × modes and write a fairness report to `tools/out/`
- Design notes `docs/SPAWN_GENERATOR.md`, background research `docs/SPAWN_RESEARCH.md`

### Changed
- Balterium amount slider and the per-patch amount box step by 500 instead of 1000; slider labels show half steps (40.5K)

## 2026-10-29 — New map designs

### Added
- **Terrain Contours** layer (on by default): 5 m lines, every 25 m a major line, like the new in-game map, drawn in light lines because the game's dark ones vanish on the dark map textures. The game draws these at runtime with a shader, so they are rendered here from the client's terrain heightmaps by the new `contours.py` (UnityPy, uses the shader's MAT_MapContourWorld settings) into `data/contours/*.png`

### Changed
- Map images re-exported from the updated game assets (MapReplay `assets.pak`): new grey line-art style for CrimsonPeak, GreatErg, NarakaCity, NorthPolarCap, TheMaw, Citadel, IndustrialQuarter; Badlands, BlackIsle, CrystalChasm, MonumentValley, RiftBasin, WhisperingPlains unchanged
- Image sizes and world extents unchanged, so masks, resources and saved layouts still line up
- `preprocess.py` flattens transparent map PNGs onto the map grey (Citadel is now line art on transparency and came out blank)

## 2026-08-15 — Measure box

### Added
- **Measure box** tool: click *Measure Box*, then drag on the map to draw a rectangle
  - Reports patch count and resource total for Balterium and Biotics inside the box, plus each one's share of the map total
  - Uses the amounts currently in effect (global sliders and per-patch overrides); excluded patches are counted separately, not summed
  - Flags patches inside the box that have no valid refinery spot
  - Lists the patch indices inside the box — paste straight into `removed_patches`
  - Corner handles resize the box, dragging the body moves it; readout updates live
  - Escape or *Clear Box* dismisses it; arming a placement tool disarms the box and vice versa

## 2026-03-04

### Fixed
- Per-patch resource amount edits now immediately update balance analysis and map labels
  - Root cause: event listeners were attached via `popupopen` handler to a DOM node Leaflet didn't use in the visible popup — listeners ended up on an orphaned element
  - Fix: wire up `input` event listeners directly on the DOM element before `bindPopup()`
  - Also prevent popup from closing mid-edit when labels refresh (`isPopupOpen` guard)

## 2026-03-01 — Per-faction build/chain radii

### Added
- Separate build radius sliders for Sol and Centauri (previously shared)
- Separate chain range sliders for Sol and Centauri
- Separate alien node and biocache chain range sliders
- Effective radius visualization on placed HQs/expansions

### Changed
- Layout export/import supports per-faction settings (backwards compatible with old single-value format)

## 2026-03-01 — Footprints, game modes, resource totals

### Added
- 4-state footprint rotation (0, 90, 180, 270 degrees) with R key toggle
- Game mode checkboxes (HvH, HvA, HvHvA)
- Resource totals display in sidebar (total Balterium/Biotics with patch counts)
- JPEG map images (smaller file size)

## 2026-03-01 — Initial release

### Added
- Interactive Leaflet-based map viewer with CRS.Simple coordinate system
- Resource patch visualization (Balterium and Biotics) with amount labels
- HQ/expansion/nest placement with build radius and chain range circles
- Placement mask validation (HQ zones, refinery zones)
- Expansion tree analysis with BFS tier computation
- Resource ownership coloring by faction
- Balance analysis panel with per-tier breakdown and fairness score
- Per-patch amount overrides (click to edit) and patch exclusion (right-click)
- Global resource amount sliders
- Refinery accessibility indicators with ramp direction arrows
- No-build zone visualization (resource extent rectangles)
- Coordinate grid overlay
- Layout export/import (JSON)
- Structure footprint placement (Sol HQ, Cent HQ, Sol Refinery, Cent Refinery, Alien Nest)
- Ramp grid validation for footprint placement
- 9 maps: GreatErg, Badlands, NarakaCity, CrystalChasm, RiftBasin, TheMaw, WhisperingPlains, NorthPolarCap, CrimsonPeak
