#!/usr/bin/env python3
"""
Render terrain contour overlays from the Silica client's terrain heightmaps.

The in-game map draws its contour lines at runtime (shader
Hidden/Silica/MapContourWorld), so they exist in no texture. This script
rebuilds them from TerrainData with the shader's MAT_MapContourWorld
settings and writes a transparent overlay per map:

  - data/contours/<Map>.png  (RGBA, same size as data/maps/<Map>.jpg)

Usage:
    python contours.py                  # every map in js/map_config.js
    python contours.py GreatErg TheMaw  # selected maps
    python contours.py --game-dir "D:/SteamLibrary/steamapps/common/Silica"

Requires: pip install UnityPy Pillow numpy scipy
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

try:
    import UnityPy
except ImportError:
    print("ERROR: UnityPy not installed. Run: pip install UnityPy")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent.resolve()
DATA_DIR = SCRIPT_DIR / "data"
DEFAULT_GAME_DIR = r"C:\SteamLibrary\steamapps\common\Silica"

# MAT_MapContourWorld (resources.assets), Silica 1.0.x
CONTOUR_INTERVAL = 5.0       # metres between lines
CONTOUR_MAJOR_EVERY = 5      # every 5th line is a major line (25 m)
CONTOUR_WIDTH = 2.5          # line width in pixels (minor and major)
CONTOUR_MIN_PIXELS = 5.0     # lines closer than this fade out (cliffs)
# The shader's dark lines (0.20,0.19,0.17 / 0.10,0.09,0.08) vanish on the dark
# map textures, so the overlay uses MAT_GeneratedMap's light outline colour.
CONTOUR_COLOR = (0.96, 0.94, 0.88, 0.40)
CONTOUR_MAJOR_COLOR = (1.00, 0.97, 0.88, 0.85)

# Unity stores heights as int16 in [0, 32766] scaled by m_Scale.y.
HEIGHT_NORM = 32766.0


def load_map_config():
    # preprocess.py writes the file in the locale codepage; only the JSON matters.
    text = (SCRIPT_DIR / "js" / "map_config.js").read_bytes().decode("utf-8", "replace")
    return json.loads(re.search(r"=\s*(\{.*\});", text, re.S).group(1))


def scene_indices(data_dir):
    env = UnityPy.load(os.path.join(data_dir, "globalgamemanagers"))
    for obj in env.objects:
        if obj.type.name == "BuildSettings":
            return {Path(p).stem: i for i, p in enumerate(obj.read_typetree()["scenes"])}
    return {}


def load_tiles(data_dir, scene_idx, extent):
    """Return [(heights_m, min_x, min_z, size)] of the active terrain tiles overlapping the map."""
    env = UnityPy.load(os.path.join(data_dir, f"level{scene_idx}"),
                       os.path.join(data_dir, f"sharedassets{scene_idx}.assets"))
    tiles = []
    for obj in env.objects:
        if obj.type.name != "Terrain":
            continue
        terrain = obj.read()
        go = terrain.m_GameObject.read()
        if not go.m_IsActive:
            continue
        x, y, z = world_position(go)
        hm = terrain.m_TerrainData.read().m_Heightmap
        size = (hm.m_Resolution - 1) * hm.m_Scale.x
        if x < extent and x + size > -extent and z < extent and z + size > -extent:
            res = hm.m_Resolution
            heights = np.asarray(hm.m_Heights, dtype=np.float32).reshape(res, res)
            tiles.append((heights / HEIGHT_NORM * hm.m_Scale.y + y, x, z, size))
    return tiles


def world_position(go):
    """Sum local positions up the parent chain (terrain parents are unrotated, unscaled).

    MonumentValley parents its tiles under an object at (-9000, 39, -3000).
    """
    tr = None
    for comp in go.m_Component:
        c = comp.component.read() if hasattr(comp, "component") else comp.read()
        if c.object_reader.type.name == "Transform":
            tr = c
            break
    x = y = z = 0.0
    while tr is not None:
        p = tr.m_LocalPosition
        x, y, z = x + p.x, y + p.y, z + p.z
        tr = tr.m_Father.read() if tr.m_Father.path_id else None
    return x, y, z


def resample(tiles, extent, image_size):
    """Sample the stitched heightmaps on the map image grid (row 0 = north = +Z)."""
    px = (np.arange(image_size) + 0.5) / image_size
    xs = -extent + px * 2 * extent             # world X per column
    zs = extent - px * 2 * extent              # world Z per row (north up)
    zz, xx = np.meshgrid(zs, xs, indexing="ij")
    h = np.zeros((image_size, image_size), dtype=np.float32)
    for heights, tx, tz, size in tiles:
        inside = (xx >= tx) & (xx <= tx + size) & (zz >= tz) & (zz <= tz + size)
        res = heights.shape[0]
        rows = (zz[inside] - tz) / size * (res - 1)
        cols = (xx[inside] - tx) / size * (res - 1)
        h[inside] = map_coordinates(heights, [rows, cols], order=3, mode="nearest")
    return h


def contour_alpha(h, interval, width, min_pixels):
    """Anti-aliased line coverage for contours of h every `interval` metres."""
    gy, gx = np.gradient(h)
    grad = np.hypot(gx, gy) + 1e-6             # metres per pixel
    dist_px = np.abs(h / interval - np.round(h / interval)) * interval / grad
    cover = np.clip(width / 2 + 0.5 - dist_px, 0.0, 1.0)
    cover[grad < 1e-3] = 0.0                   # dead-flat ground sitting exactly on a level
    spacing_px = interval / grad               # pixels between adjacent lines
    fade = np.clip((spacing_px - min_pixels) / min_pixels, 0.0, 1.0)
    return cover * fade


def render(h):
    minor = contour_alpha(h, CONTOUR_INTERVAL, CONTOUR_WIDTH, CONTOUR_MIN_PIXELS)
    major_interval = CONTOUR_INTERVAL * CONTOUR_MAJOR_EVERY
    major = contour_alpha(h, major_interval, CONTOUR_WIDTH, CONTOUR_MIN_PIXELS)
    a_minor = minor * CONTOUR_COLOR[3]
    a_major = major * CONTOUR_MAJOR_COLOR[3]
    # Major lines are drawn over minor lines.
    alpha = a_major + a_minor * (1 - a_major)
    rgb = np.zeros(h.shape + (3,), dtype=np.float32)
    for i in range(3):
        rgb[..., i] = (CONTOUR_MAJOR_COLOR[i] * a_major
                       + CONTOUR_COLOR[i] * a_minor * (1 - a_major)) / np.maximum(alpha, 1e-6)
    out = np.dstack([rgb, alpha])
    img = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")
    # 32-colour palette: ~2 MB instead of ~10 MB per 4096px map, visually identical.
    return img.quantize(32, method=Image.Quantize.FASTOCTREE)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("maps", nargs="*")
    ap.add_argument("--game-dir", default=DEFAULT_GAME_DIR)
    args = ap.parse_args()

    data_dir = os.path.join(args.game_dir, "Silica_Data")
    config = load_map_config()
    maps = args.maps or sorted({cfg.get("base_map", name) for name, cfg in config.items()})
    scenes = scene_indices(data_dir)
    (DATA_DIR / "contours").mkdir(parents=True, exist_ok=True)

    for name in maps:
        extent = config[name]["extent"]
        image_size = Image.open(DATA_DIR / "maps" / f"{name}.jpg").size[0]
        tiles = load_tiles(data_dir, scenes[name], extent)
        if not tiles:
            print(f"  [WARN] {name}: no terrain tile inside the map extent")
            continue
        h = resample(tiles, extent, image_size)
        out = DATA_DIR / "contours" / f"{name}.png"
        render(h).save(out, optimize=True)
        print(f"  [OK] {name}: {image_size}px, heights {h.min():.0f}-{h.max():.0f} m -> {out.name} "
              f"({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
