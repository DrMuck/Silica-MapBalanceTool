# Base sites: where an HQ or Nest fits

For people who make layouts. The data format and the exact tests are in [SITE_SCAN.md](SITE_SCAN.md).

## Why

A spawn base (Sol HQ, Centauri HQ, Alien Nest) put next to a cliff, into a rock or between buildings
spawns wedged into the geometry, and its starter units with it. The old "HQ Zones" only looked at the
height map, ignored rocks, cliffs and buildings, did not check the Nest at all and accepted a spot when
any of the four rotations fitted. Layouts also had no rotation, so the server turned the base like the
nearest vanilla start point, which was often the one rotation that does not fit.

The tool now knows, for every 15 m spot of every map and for each of the four rotations, whether each
base fits there and why not. This was measured in the game once per map (Si_MapBalance 3.6.0 site scan);
everything in the tool works offline from that data.

## What a base must pass

| Shown as | Meaning |
|---|---|
| fits | all tests pass |
| ground too steep or uneven | the foundation would hang more than 8 m above the terrain (HQs only; the game spawns Nests regardless) |
| rock, a roof or an overhang under or over the base | the ground test fails only because of rocks or buildings |
| cuts into a cliff, rock or building | a rock, cliff, building or invisible wall reaches more than 3 m into the base |
| cut off | vehicles (HQ) or alien units (Nest) could not get away from the base: it is not on the main ground network |
| outside the playable map | off the map |

The limits sit at the edge of what the vanilla start points need, so a flagged base is worse than about
95 % of the vanilla ones.

**Which HQs a spot must fit.** In HvH and HvHvA layouts with "Random Sol/Cent swap" on (also 2v1, which
runs as an HvHvA round), Sol and Centauri trade places in half the rounds and take the rotation with them,
so a human spot must fit **both** HQs at the same rotation. In HvA layouts with one position for both HQs
the same applies. With the swap off, each spot only has to fit its own HQ.

## Rotation (`rot`)

A spawn base can carry a rotation of 0, 90, 180 or 270 degrees (0 = facing north on the tool map,
90 = east). It is saved in the layout as `"rot"` on that spawn entry (Si_MapBalance 3.6.0 and later use
it; older builds ignore it). Without `rot` the server uses the rotation of the nearest vanilla start
point, as before; the tool shows that rotation as **auto** with its angle.

- The arrow on a spawn base points where the base faces (faint arrow = auto), and the base's real
  footprint is drawn around it (dashed = auto). A red ring means the base does not fit, a yellow ring
  means little open ground.
- **Click a spawn base** to see its state and set the rotation: one button per rotation, green = fits,
  red = does not fit (hover for the reason). A rotation you pick by hand is kept even when it does not
  fit; the tool says so and offers the fix.
- Layouts without `rot` load and export without it; nothing else in the file changes.

## Placing and dragging

"Restrict to HQ Zones" (on by default) now checks the three spawn bases against the base site data
(expansions still use the old HQ zones). With **Auto-snap spawn bases to a valid site** (Base Sites
section, on by default), a base dropped where it does not fit is fixed in this order:

1. another rotation at the same spot ("rotated to 180°");
2. else the nearest spot within 120 m that fits, with its best rotation ("moved 15 m to the nearest valid
   site, rotation 90°");
3. else it is refused with the reason (no valid spot within 120 m).

The status line under Base Sites says what happened and why. With auto-snap off a spot that does not fit
is refused (a dragged base goes back). With "Restrict to HQ Zones" off you can place anywhere; the tool
only warns.

When several rotations fit, the one with the most fitting neighbour spots wins (more room to spare),
then the one closest to the start point's rotation.

## Checking a layout

Loading a layout checks every spawn base at once; **Check layout** does it on demand. Each base is listed
with its rotation and state:

- **fits**
- **does not fit**, with the reason and a **Fix** button (same order as above). **Fix all** fixes every
  base that has a fix. A fix that moves the base says when the move changes which resource patches lie
  inside the build radius; check the balance afterwards.
- **little open ground**: less than 50 % (HQ) / 25 % (Nest) of the ring 60-250 m around the base is
  ground the starter units can stand on and reach. This is a warning only; the tool never moves a base
  for it.

Click a row to jump to the base and open its rotation popup.

## The "Base sites" layer

Under Layers, **Base sites** shows where a base fits: choose Sol HQ, Cent HQ, Sol + Cent (fits both,
for swap layouts) or Nest, and a rotation, or **any** (fits at some rotation; darker green = more
rotations). Green = fits; orange = too steep; yellow = rock or roof under or over it; red = cuts into
rock, a cliff or a building; purple = cut off.

## Spawn Generator

**Only valid base sites** (on by default) makes the generator start only where every HQ that can stand
there fits at one rotation (both HQs, as for a swap layout), skips spots with little open ground and
writes the rotation into the layout as `rot`. Unticked, the generator works exactly as before.

## Fixing many layouts at once

`node tools/site_fix.js --layouts <Spawns folder> --out <new folder>` checks every layout of a server's
`Spawns` folder, writes corrected copies to the new folder (never over the originals) and a report
(`site_fix_report.csv` / `.md`) next to it: per base unchanged, rotation set, moved (with the distance)
or not fixable. Moves that change the resource patches inside a build radius are marked **REVIEW**.
Bases that already fit get no `rot` (add `--explicit-rot` to write one everywhere).
