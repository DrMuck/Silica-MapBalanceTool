# Base site scan: data format and test definitions

Status: v2, 2026-11-12 (v2: Nest ground = info, start points in the meta, offline audit). Producer: Si_MapBalance 3.6.0 site scan mode (`SiteTest.cs`, `SiteScan.cs`);
converter: `python preprocess.py --sites [Map ...]`; consumer: the Map Balance Tool (stage 2) and
`tools/site_audit.py`. This document is the contract; everything a consumer needs is here.

## 1. What the data answers

For every cell of a map's 15 m grid and each yaw 0/90/180/270:

- can a **Sol HQ**, a **Centauri HQ**, an **Alien Nest** stand there (and if not, why), and
- can a ground **vehicle** / an **alien ground unit** stand on that cell and move away (open ground),

plus the surface height of every cell. The tool uses the site layers to validate and suggest base
positions and rotations, and the open-ground layer to measure how much room the starter units get
around a base (section 7).

The same site test runs in the mod at every round start (one warning line per bad base), so a position
that is valid in the data is valid for the server's warning too (same code, same thresholds).

## 2. Files (all in `data/sites/`)

| File | Format | Content |
|------|--------|---------|
| `site_<S>_<Map>_r<YYY>.png` | 8-bit grayscale (mode L), `grid_w` x `grid_h` | site code byte (section 4) of structure `S` at yaw `YYY` |
| `open_<Map>.png` | 8-bit grayscale | open-ground bits (section 5) |
| `surf_<Map>.png` | opaque RGB, no gAMA/sRGB chunks | surface height, 16 bit in R (high byte) / G (low byte), B = 0 |
| `site_meta_<Map>.json` | JSON | grid, code legend, structure and probe descriptions, counts, source scan, `scan_format`, `nest_ground_rule`, and `start_points` (section 8) |

`S` is `Sol`, `Cent` or `Alien` (the Nest); `YYY` is `000`, `090`, `180`, `270`. Maps with layers in
v1: Badlands, BlackIsle, Citadel, CrimsonPeak, CrystalChasm, GreatErg, IndustrialQuarter,
MonumentValley, NarakaCity, NorthPolarCap, RiftBasin, TheMaw, WhisperingPlains (see the meta file's
presence). **NorthPolarCap_40K is not a scene**: the game database has no such level (checked
in-game, `GameDatabase.Database.AllLevels`); it is a layout variant of NorthPolarCap and uses the
NorthPolarCap layers (as `js/app.js` already does for its image and masks).

The existing `data/masks/hq_<Sol|Cent>_<Map>.png` are untouched and keep their old meaning (the
terrain-only rule). Bit 4 of the site code reproduces that rule cell by cell, so a consumer can drop
the old masks once it reads the site layers.

## 3. Grid and pixel mapping

Identical to the hq_scan grid of `js/map_config.js` (same origin, step and extent):

```
step = site_meta.grid.step                 (15)
px   = round((x - scan_min_x) / step)      column, 0 = west (min x)
py   = round((scan_max_z - z) / step)      row,    0 = north (max z)
x    = scan_min_x + px * step
z    = scan_max_z - py * step
```

`scan_min_x = ceil(terrain.x / step) * step`, `scan_max_x = floor((terrain.x + size.x) / step) * step`,
same for z, where `terrain` is `Game.MainTerrain` (all 13 maps have a single terrain tile; the scan
logs a warning otherwise). `grid_w = (scan_max_x - scan_min_x) / step + 1`, same for `grid_h`.
Each pixel is the test **at the cell centre** (x, z) exactly; there is no averaging. Layout positions
made by the tool are on this grid already (multiples of 15).

## 4. Site code byte (site_*.png)

```
bit 0      VALID          all tests below pass
bits 1-3   REASON         first failing test (0 = none), value = (code >> 1) & 7
bit 4      TERRAIN_RULE   legacy terrain-only rule passes (what data/masks/hq_*.png encode)
bit 5      GAME_RULE      the exact game build rule passes (GetGroundSlopeClear == true, no tolerance)
bit 6      NO_OVERLAP     no static collider penetrates the structure deeper than OverlapDepth
bit 7      NAVMESH        the navmesh test passes
```

Reason codes (tests run in this order; every test is evaluated, the reason is the first failure):

| Value | Name | Meaning |
|------:|------|---------|
| 0 | `ok` | valid |
| 1 | `offmap` | outside the FogOfWar bounds or no terrain tile (all other bits 0) |
| 2 | `ground_terrain` | ground test fails, and it fails on the bare heightmap too (slope / uneven terrain) |
| 3 | `ground_static` | ground test fails only because of non-terrain geometry under or over the footprint (rock, roof, overhang) |
| 4 | `on_static` | not produced by v1 (see 6.3); reserved |
| 5 | `overlap` | a static collider penetrates the structure's collision boxes |
| 6 | `navmesh` | fewer than 2 of 8 footprint probes on the main navmesh component |
| 7 | `no_data` | structure could not be resolved on this map (no team / prefab) |

Typical consumer use: `valid = code & 1`; "why" = `REASONS[(code >> 1) & 7]`; "valid except for the
navmesh" = `(code & 0x0E) == (6 << 1)` etc. Ground-within-tolerance is not a separate bit: it holds iff
the reason is not 1, 2 or 3.

**Rotation.** One layer per yaw. Yaw is the structure's rotation about +Y in degrees, Unity
convention (`Quaternion.Euler(0, yaw, 0)`, clockwise seen from above; yaw 0 = the prefab's forward
along +Z = north on the tool map, yaw 90 = forward along +X = east). The layout field `"rot"` uses
exactly these values (section 8).

**Nest.** The alien Nest is covered like the HQs (`site_Alien_*`). It has its own ConstructionData
(`ConstructionData_Alien_Nest`, GridSnapXZ 5, RotateToSurface on, max 30 deg) and bits 4/5 record that
rule, but **for the Nest the ground test is not a failure** (reasons 2 and 3 never occur in
`site_Alien_*`): 11 of 266 vanilla Nest placements break it (tilt measured by the game from a 1 m ray
triangle on rock, ray misses, foundation gaps of 8-35 m) and vanilla spawns them upright and unchanged
anyway (`MP_Strategy.SpawnBaseStructures` applies no build rule). A Nest site is valid when it is on the
map, nothing static penetrates it deeper than 3 m and the navmesh test passes. Scans of format 1 (the
first 3.6.0 build) still failed the Nest on ground; `preprocess.py` rewrites those codes from the flag
bits (every test was evaluated), meta `nest_codes_normalized` counts them.

## 5. Open-ground byte (open_*.png)

```
bit 0  VEHICLE_OK      a vehicle probe lands here on walkable ground and is on the main Small Vehicle navmesh
bit 1  ALIEN_OK        the alien probe lands here and is on the main Voxel Graph component
bit 2  GROUND          the vehicle probe's down-cast found any ground at all
bit 3  ON_STATIC       the landing surface is a non-terrain collider > 4 m above the heightmap (info only)
bit 4  VEHICLE_OVERLAP vehicle box overlaps static geometry at yaw 0 and at yaw 90
bit 5  VEHICLE_NAV     vehicle navmesh test failed
bit 6  ALIEN_NAV       alien navmesh test failed
bit 7  ALIEN_OVERLAP   alien box overlaps static geometry at yaw 0 and at yaw 90
```

`VEHICLE_OK = GROUND && !VEHICLE_OVERLAP && !VEHICLE_NAV` (same for the alien bits with the alien
probe). Probe boxes (logged in the meta `probes`): vehicle = the solid colliders of the Sol *Platoon
Hauler* (6.6 x 3.3 x 9.9 m) + 1 m per side = 8.6 x 3.3 x 11.9 m; alien = the *Shocker* collider
(4 x 4 x 4 m) + 1 m per side = 6 x 4 x 6 m. Definitions in 6.5.

## 6. Game-side definition of each test

All physics queries ignore triggers. Masks:
`CAST = GamePhysics.TRACELAYERMASK_IGNOREDYNAMIC` (everything except units, debris, triggers, AI
obstacles, invisible walls, ...), `STATIC = CAST & ~Terrain & ~(Water | No Collide | Gizmos | UI)`,
`WALLS = "Invisible Walls"`. Colliders that belong to a `BaseGameObject` (structures, units) are
ignored: they are game objects, not world geometry. Surface height `sy` = first hit of a ray from
terrain + 500 m straight down (CAST).

### 6.1 Structure and pose

- Structure = `Team.BaseStructure` of the team whose name contains Sol / Cent / Alien (not Worm);
  its prefab is `Sol_Headquarters` / `Cent_Headquarters` / `Alien_Nest`.
- Rule = the `ConstructionData` whose `ObjectInfo` is that structure (`ConstructionData_Sol_Headquarters`,
  `ConstructionData_Cent_Headquarters`, `ConstructionData_Alien_Nest`) and its `ObjectPreviewSetup`
  (`ConstructionPreview`).
- Pose, as the commander's placement preview (`StrategyMode` ~1965): `p = ConstructionData.SnapToGrid((x, sy, z))`
  with x/z kept as given (y snapped to GridSnapY = 1 m); `rot = ConstructionPreview.GetSnappedRotation(p, Euler(0, yaw, 0), GridSnapY)`
  (tilts the Nest to the surface; HQs stay upright).
- Collision shape = one box per solid collider of the prefab (non-trigger; layers that take part in
  movement, i.e. not Ignore Raycast, Trigger, AIObstacle, Zone, CharacterHitZone, Debris, Damage Bounds,
  avoidance layers, ...), as an axis-aligned box in the prefab root frame computed from the collider
  shape (box/sphere/capsule/mesh bounds). Sol HQ 647 boxes (union 107 x 142 x 142 m), Cent HQ 571
  (109 x 132 x 132 m), Nest 324 (52 x 19 x 47 m). Boxes are clipped below `min(AboveGround point y) + 0.5 m`
  (foundations and the Nest's flat sand mounds sit in the ground by design).
- Footprint rectangle = x/z extent of the AboveGround points united with the collision boxes.

### 6.2 Ground (reasons 2, 3; bits 4, 5)

`ConstructionPreview.GetGroundSlopeClear(p, rot, out adjustY)` is called (bit 5) and replicated to get
the size of the violation (the replica agreed with the real call in 9 806 of 9 810 calls on the 13 maps; the 4
disagreements are sites where the structure would be lifted 20-58 m, and all of them fail on overlap
anyway; the grid uses the replica for bit 5, start points, layouts and the runtime check call the game):
1. every AboveGround point `a`: ray from `a + 100 m` down 200 m (CAST); `adjustY = max(hit.y - a.y)`, start -30;
2. lift the structure by adjustY;
3. every BelowGround point `b`: ray as above; **gap** = `max(b.y - hit.y)` (how far the foundation edge
   hangs above the ground); the game rule requires gap <= 0, a missing ray fails, the preview entries
   (`ConstructionPreviewEntry.Evaluate`) must pass, and with RotateToSurface the tilt must stay within
   StructureRotateMaxAngle.

Ground passes when there is no missing ray, no tilt or entry failure and **gap <= GroundTol =
8 m** (calibrated, section 9). The same computation on the bare heightmap (yaw only, no tilt;
this is the old hq_scan) gives bit 4 and decides between reason 2 (heightmap fails too) and 3.
For the Nest the ground result only sets bits 4/5; it never makes the site invalid (section 4).

### 6.3 On static (info only)

Rays at the AboveGround points of the final pose: landing on a non-terrain collider more than 4 m
above the heightmap. **Not a failure** since calibration: Citadel's alien starts stand on rock-mesh
plateaus (surface 120 m, heightmap 25 m) and every IndustrialQuarter alien start stands on 13 m
industrial floor platforms; those are playable ground. Roof tops and pillar tops are rejected by the
navmesh test instead (they are not on the main component). Reason 4 is reserved for a stricter mode
(`"on_static_fails": true` in the scan config).

### 6.4 Overlap (reason 5, bit 6)

For each collision box at the final pose: `Physics.OverlapBox` (STATIC | WALLS), and for every hit
`Physics.ComputePenetration(box, hit collider)` gives the penetration depth. The site fails when any
depth exceeds **OverlapDepth = 3 m** (calibrated). A first OverlapBox of the clipped union
box skips the per-box queries where nothing static is near. The grid scan stops at the first penetration
deeper than 3 m (same code byte, fewer queries); layout, start point and runtime checks report the deepest.

### 6.5 Navmesh (reason 6, bit 7) and open ground

- Graphs (A* `GameAI.NamedGraphMasks`, identical on all maps): `Soldier`, `Small Vehicle`,
  `Harvester` (RecastGraph), `Voxel Graph` (alien, `NavMeshGenerator.VoxelGraph.VoxelGraph`, point
  nodes, slack = VoxelSize + |SurfaceOffset| = 8.1 m on Citadel), `Air Unit Graph`. Site graph: HQs
  `Small Vehicle` (also what vanilla `MP_Strategy.GetStartPointOffNavmesh` checks with `Soldier`), Nest
  `Voxel Graph`.
- **Main component** = the `GraphNode.Area` with the most walkable nodes of that graph on the map
  (Citadel Small Vehicle: 26 395 of 38 666 nodes in the main area, 1 271 components; Voxel Graph:
  212 574 of 222 042).
- **Probe** at a ground point g: `AstarPath.active.GetNearest(g, graph, maxDistance 20 m)`; passes when a
  node is found within 6 m horizontally and 4 m vertically (+ the voxel slack for the alien graph) and
  its Area is the main component.
- **Site**: 8 probes on the footprint rectangle grown by 12 m (4 corners + 4 edge midpoints), each at
  the surface height there; at least **2** must pass.
- **Open ground cell**: `Physics.BoxCast` of the probe box (yaw 0) from terrain + 500 m down (CAST)
  = landing; GROUND if it lands; overlap = `OverlapBox` of the landed box + 0.15 m against STATIC | WALLS
  at yaw 0 and at yaw 90 (either clear is enough); navmesh = one probe at the landing point (vehicle:
  Small Vehicle; alien: Voxel Graph).

## 7. Openness of a base's surroundings (how the tool should use open_*.png)

Starter units (Si_StarterUnits 1.3.0) are placed on a 120 m ring and may be moved within 60..250 m of
the base. Measure (as implemented in `tools/site_audit.py`, `openness()`):

- annulus cells: 60 m <= distance from the base <= 250 m, cell on the map (`surf` != 0);
- standable: `VEHICLE_OK` (Sol/Cent base) or `ALIEN_OK` (Nest), and the cell's surface within 25 m of
  the base ground (Si_StarterUnits `max_step_from_base_m`); base ground = median surface of the cells
  within 40 m that have GROUND and not ON_STATIC (the base cell itself may sample a roof or rock top);
- **open_raw** = standable / annulus cells;
- **open_reach** (recommended) = annulus cells reachable by an 8-connected flood fill over standable
  cells inside the 250 m disk, seeded from the standable cells 40..95 m from the base, / annulus cells.
  It drops when the open ground lies behind a wall or cliff the units cannot cross locally.
- Flag a base when **open_reach < 0.50 (HQ) or < 0.25 (Nest)**: below about 98 % / 97 % of the vanilla
  placements (6 of 312 vanilla HQ and 8 of 266 vanilla Nest placements fall below; section 9).
- Limitation: `ALIEN_OK` is almost everywhere (99.9 % of Citadel, 100 % of GreatErg) because the alien
  Voxel Graph covers walls and roofs (alien ground units climb). For a Nest the measure is therefore
  mostly the 25 m step rule, i.e. how much ground on the base's own level surrounds it.

## 8. The layout field `"rot"` (Si_MapBalance 3.6.0)

`spawns.<Sol|Cent|Alien>[0].rot`, optional number, degrees; the tool writes one of 0, 90, 180, 270.
Present: the mod spawns that base with `Quaternion.Euler(0, rot, 0)`. Absent: unchanged behaviour,
the rotation of the nearest vanilla start point of that team (often 0/90/180/270, sometimes 355, 225,
315 ...). The rotation belongs to the **position**: in hvh / hvhva with `swap_spawns` not false, the
Sol and Cent HQs trade positions in 50 % of rounds and take the entry's `rot` with them, so for a
swappable layout the tool must offer only yaws valid for **both** HQs at that cell
(`site_Sol & site_Cent & 1` at the same yaw). hva layouts put one position into both `Sol[0]` and
`Cent[0]`; either HQ can stand there, so the same "valid for both" rule applies. Si_StarterUnits rings
start from the spawned structure's forward and so follow `rot` automatically; the relocated vanilla
start point keeps its own rotation. Older mod builds ignore the field.

**Today's yaw, offline.** Without `rot` the mod uses the rotation of the start point of that team's
`BaseStructureStartPoints` nearest (2D) to the layout position (`SpawnAtBestStartPoint`). The meta lists
them: `start_points: [{team: "Sol"|"Cent"|"Alien", idx, name, x, z, yaw}]` (yaw in [0, 360), as read from
the start point transform). For a Sol entry look in the Sol list, after a swap the Cent HQ uses the Cent
list. Some yaws are not multiples of 90 (mostly Nest points: 355, 225, 315 ...); round to the nearest
layer for a lookup and treat the result as approximate. Sol and Centauri share most human start point
transforms and the mod takes the nearest *unused* one, so if both human spots of a layout are nearest
to the same shared transform, the second team gets its next-nearest point; the audit ignores this case.

**Fixing a bad base (how `tools/site_audit.py` ranks it, user decision 2026-11-12).** 1) valid as is;
2) same x/z, another of the four yaws valid for every structure that can stand there: set `rot`; if
several, take the one with the most margin = number of valid 8-neighbour cells at that yaw, summed over
the structures (the data has no finer margin), ties: closest to today's yaw; 3) the nearest cell with a
yaw valid for every structure (same margin rule for its yaw), reported with distance; 4) nothing within
120 m.

## 9. Calibration

Reference set: every vanilla start point (`MP_Strategy.TeamSetups[].BaseStructureStartPoints`) of the
13 maps, tested in game with its team's base structure at the start point's own yaw (the place and
rotation where vanilla spawns the HQ/Nest): 312 HQ placements (Sol and Centauri share the human points
on most maps, so each point counts once per HQ) and 266 Nest placements. Per-map table and every
exception: `Si_MapBalance/analysis/site_audit_2026-11-12/calibration.md`.

What the first version got wrong and what changed (each found on this reference set):

| Problem | Evidence | Change |
|---|---|---|
| exact game build rule rejected vanilla HQs | 70 of 312 vanilla HQ and 74 of 266 Nest placements fail `GetGroundSlopeClear` (foundation gap up to 18.9 m; GreatErg, NorthPolarCap, CrystalChasm slopes) | ground passes up to a gap of 8 m (vanilla p95); the exact rule stays as bit 5 |
| "on top of static" rejected playable ground | Citadel alien starts stand on rock-mesh plateaus (surface 122 m, heightmap 25 m); 22 of 25 IndustrialQuarter alien starts on 13 m `Industrial_Floor_06` platforms | info only; roofs and pillar tops are caught by the navmesh test |
| bounding-box overlap rejected near misses | first version (0.5 m shrink, on-static and exact rule as failures): 5 of 6 Citadel alien starts failed | depth from `Physics.ComputePenetration`; 3 m (vanilla p97: 306/312 HQ, 266/266 Nest within 3 m) |
| palms counted as rock | CrimsonPeak HQs 5 m "into" `Centaurus_PalmTall_01/AIVehicleObstacle` | layer `AIVehicleObstacle` (AI steering volume, not physical) excluded |
| navmesh failed whole maps | 42 CrystalChasm layout bases had 0/8 probes on the main component: A* renumbered `GraphNode.Area` after the main area was computed (same component seen as 13955, 13957, 13959) | main component tracked by a reference node, compared at query time |

| vanilla Nests failed the build rule | 11 of 266 vanilla Nest placements break it (3 x tilt from the game's 1 m ray triangle on rock, 1 ray miss, 7 foundation gaps of 8-35 m, e.g. Citadel `StrategyStart_Alien` (-355,27) next to a 100 m rock pillar); vanilla spawns Nests upright without any rule | ground is info only for the Nest (bits 4/5 kept); with that all 266 pass in game |
| a 359.99 deg start point yaw | in game 0 m penetration at yaw 359.99 where yaw 0 (same rotation) gives 3.6 m (Citadel s867035281-2 Sol) | yaws within 0.05 deg of a multiple of 90 snapped, quaternion kept at w >= 0 |

Result in game with the final rules (start point CSVs of the full run): 296 of 312 vanilla HQ placements
(94.9 %) and all 266 vanilla Nest placements are valid; no vanilla placement fails the navmesh test
(minimum 4 of 8 probes). Looked up offline in the layers (`calibration.md`): Sol 141/156, Cent 154/156,
Nest 264/266 (vanilla points are not on the 15 m grid; the nearest cell is up to 7.5 m away, which
flips the two Nest results). The HQ exceptions: CrystalChasm canyon points whose Sol HQ clips a cliff by
3.2-4.3 m, BlackIsle `StrategyStart_Human_03` (3.5 m Sol, 6.8 m Cent), CrimsonPeak `StrategyStart_Human_10`
(Cent), and Sol HQ foundation gaps of 8.5-13.7 m on GreatErg / NorthPolarCap / RiftBasin / CrystalChasm
slopes (the bigger Sol footprint; Centauri passes at the same points). These are positions the
designers accepted; the thresholds sit at the edge of the vanilla distribution on purpose, so a
flagged layout base is worse than about 95 % of the vanilla ones.

**Is the 15 m grid good enough for the tool?** The mod tested every base of the 267 live layouts in
game at its exact position and at each of the four yaws during the scan (`site_layouts_<Map>_*.csv`).
Looked up offline in the layers, 4 311 of 4 312 four-yaw results agree; the one disagreement is a
penetration of exactly 3.0 m (threshold). At today's yaw 1 077 of 1 078 agree, including all 107 bases
whose today's yaw is not a multiple of 90 and was rounded; the one disagreement is the 359.99 deg
artefact above (now fixed in the mod). Layout positions are on the grid, so the lookup is exact for
them; arbitrary positions (vanilla points) can differ near a threshold.

Known-good layouts: there is no curated list. Layout bases within 30 m of a vanilla start point are
marked in the audit (`near_vanilla*` columns) and behave like the vanilla point they sit on.

Openness: vanilla `open_reach` HQ min 0.36, p5 0.59, median 0.93; Nest min 0.07, p5 0.37, median 0.80
(Citadel Nests sit on plateaus: 0.20-0.29). Thresholds in section 7.
## 10. When to scan, and checking layouts offline

**The scan is needed once per map and game version.** Everything after it is offline: validating a
layout, ranking fixes, computing openness, the audit, the tool. No server run per layout or per spawn.

The layers go stale when, and only when, the game changes something the tests read:
- a map update (terrain, rock/cliff/building meshes, invisible walls, start points) or a new map;
- a base structure prefab change (Sol / Centauri HQ, Nest: colliders, AboveGround/BelowGround points,
  ConstructionData);
- a navmesh change (rebaked graphs, graph names), or the probe units' colliders (Platoon Hauler, Shocker);
- a change of the site test itself (thresholds in `SiteTest.cs`; then also bump the scan format).
Each meta records the scan file (`source`, with date and time), the game version line and the mod
version, so a consumer can show "scanned with game x.y.z". After a game update: rescan, then compare the
counts in the metas.

Re-running:
1. On the local server, `UserData/cfg/MapBalance/site_scan.json` with `"enabled": true` and the maps (see
   the Si_MapBalance README, "Base site check and site scan"); start the server; it loads and scans the
   listed maps one after the other (3-10 minutes per 1000-2048 m map, 13-17 minutes for IndustrialQuarter
   and the 3000 m maps; 2 h 05 for all 13 on 2026-11-12). Delete the file afterwards.
2. `python preprocess.py --sites` (newest `site_scan_<Map>_*.txt` and `site_startpoints_<Map>_*.csv` per
   map from `E:\...\UserData\MapBalance\site_scan\`, or `--site-dir DIR`).
3. Audit layouts, offline: `python tools/site_audit.py --layouts <Spawns dir> --out <dir> [--maps ...]`;
   `--ingame <site_scan dir>` adds the cross-check against the mod's in-game test of the same layouts
   (only for layouts that were in `layouts_dir` during the scan).
