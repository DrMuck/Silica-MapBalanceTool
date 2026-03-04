# Changelog

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
