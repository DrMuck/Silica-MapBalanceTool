# Changelog

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
