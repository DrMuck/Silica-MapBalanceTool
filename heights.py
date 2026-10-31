#!/usr/bin/env python3
"""
Export terrain heights on the 15 m scan grid of the placement masks, for the
browser (js/terrain.js) and the spawn generator.

Per base map writes:
  - data/heights/<Map>.png   opaque RGB, grid_w x grid_h, 16-bit height in R (high) / G (low), B = 0,
                             no gAMA/sRGB/iCCP chunks; pixel (px, py) = world
                             (scan_min_x + px*step, scan_max_z - py*step), row 0 = north
  - data/heights/<Map>.json  {map, grid_w, grid_h, scan_min_x, scan_max_z, step, hmin, hmax,
                              samples: [[px, py, v], ...], sea_level: null}
                             h = hmin + v / 65535 * (hmax - hmin)

Usage:
    python heights.py                    # every base map in js/map_config.js
    python heights.py GreatErg TheMaw    # selected maps
    python heights.py --verify           # re-read the PNGs and check them against the terrain
    python heights.py --contours         # also print contours.py's image-grid height range
    python heights.py --game-dir "D:/SteamLibrary/steamapps/common/Silica"

Requires: pip install UnityPy Pillow numpy scipy
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

from contours import (DATA_DIR, DEFAULT_GAME_DIR, load_map_config, load_tiles,
                      resample, scene_indices)

OUT_DIR = DATA_DIR / "heights"
VMAX = 65535
FORBIDDEN_CHUNKS = (b"gAMA", b"sRGB", b"iCCP", b"cHRM", b"tRNS")


def scan_of(cfg):
    step = cfg.get("scan_step", 15)
    min_x = cfg.get("scan_min_x", -cfg["extent"])
    max_z = cfg.get("scan_max_z", cfg["extent"])
    w = cfg.get("grid_w") or int(round((cfg.get("scan_max_x", cfg["extent"]) - min_x) / step)) + 1
    h = cfg.get("grid_h") or int(round((max_z - cfg.get("scan_min_z", -cfg["extent"])) / step)) + 1
    return {"min_x": float(min_x), "max_z": float(max_z), "step": float(step), "w": int(w), "h": int(h)}


def resample_grid(tiles, scan):
    """Sample the stitched heightmaps on the scan grid: cell (px, py) at
    x = min_x + px*step, z = max_z - py*step (row 0 = north), as in layers.isValidPlacement."""
    xs = scan["min_x"] + np.arange(scan["w"]) * scan["step"]
    zs = scan["max_z"] - np.arange(scan["h"]) * scan["step"]
    zz, xx = np.meshgrid(zs, xs, indexing="ij")
    h = np.zeros((scan["h"], scan["w"]), dtype=np.float32)
    for heights, tx, tz, size in tiles:
        inside = (xx >= tx) & (xx <= tx + size) & (zz >= tz) & (zz <= tz + size)
        res = heights.shape[0]
        rows = (zz[inside] - tz) / size * (res - 1)
        cols = (xx[inside] - tx) / size * (res - 1)
        h[inside] = map_coordinates(heights, [rows, cols], order=3, mode="nearest")
    return h


def encode(h):
    """Quantise to 16 bit. The range is rounded outward to 4 decimals so the JSON's hmin/hmax
    are exactly the values the PNG was encoded with."""
    hmin = float(np.floor(float(h.min()) * 1e4) / 1e4)
    hmax = float(np.ceil(float(h.max()) * 1e4) / 1e4)
    span = hmax - hmin
    v = np.zeros(h.shape, dtype=np.int64) if span <= 0 else         np.rint((h.astype(np.float64) - hmin) / span * VMAX).astype(np.int64)
    v = np.clip(v, 0, VMAX)
    rgb = np.dstack([(v >> 8), (v & 255), np.zeros_like(v)]).astype(np.uint8)
    return v, rgb, hmin, hmax


def sample_cells(v):
    """8 fixed cells: 4 corners, centre, lowest, highest, one off-axis interior cell."""
    hh, w = v.shape
    cells = [(0, 0), (w - 1, 0), (0, hh - 1), (w - 1, hh - 1), (w // 2, hh // 2)]
    lo = np.unravel_index(int(np.argmin(v)), v.shape)
    hi = np.unravel_index(int(np.argmax(v)), v.shape)
    cells += [(int(lo[1]), int(lo[0])), (int(hi[1]), int(hi[0])), (w // 4, hh // 3)]
    return [[px, py, int(v[py, px])] for px, py in cells]


def png_chunks(path):
    data = path.read_bytes()
    pos, out = 8, []
    while pos < len(data):
        n = int.from_bytes(data[pos:pos + 4], "big")
        out.append(data[pos + 4:pos + 8])
        pos += 12 + n
    return out


def export(name, h, scan):
    v, rgb, hmin, hmax = encode(h)
    png = OUT_DIR / f"{name}.png"
    Image.fromarray(rgb, "RGB").save(png, optimize=True)
    meta = {
        "map": name, "grid_w": scan["w"], "grid_h": scan["h"],
        "scan_min_x": scan["min_x"], "scan_max_z": scan["max_z"], "step": scan["step"],
        "hmin": hmin, "hmax": hmax,
        "samples": sample_cells(v), "sea_level": None,
    }
    (OUT_DIR / f"{name}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta, png


def verify(name, h, scan):
    """Re-read the PNG + JSON and compare with freshly resampled heights. Returns (ok, text)."""
    meta = json.loads((OUT_DIR / f"{name}.json").read_text(encoding="utf-8"))
    png = OUT_DIR / f"{name}.png"
    problems = []
    bad = [c for c in png_chunks(png) if c in FORBIDDEN_CHUNKS]
    if bad:
        problems.append(f"colour chunks {bad}")
    img = Image.open(png)
    if img.mode != "RGB":
        problems.append(f"mode {img.mode} != RGB")
    a = np.asarray(img.convert("RGB"), dtype=np.int64)
    if a.shape[:2] != (scan["h"], scan["w"]) or (meta["grid_w"], meta["grid_h"]) != (scan["w"], scan["h"]):
        problems.append(f"size {a.shape[1]}x{a.shape[0]} vs scan {scan['w']}x{scan['h']}")
        return False, "; ".join(problems)
    if a[..., 2].any():
        problems.append("B channel not zero")
    v = a[..., 0] * 256 + a[..., 1]
    for px, py, sv in meta["samples"]:
        if v[py, px] != sv:
            problems.append(f"sample ({px},{py}) {v[py, px]} != {sv}")
    span = meta["hmax"] - meta["hmin"]
    dec = meta["hmin"] + v / VMAX * span
    err = float(np.abs(dec - h.astype(np.float64)).max())
    tol = span / VMAX + 0.01
    if err > tol:
        problems.append(f"max err {err:.4f} m > {tol:.4f} m")
    lsb = span / VMAX if span > 0 else 0.0
    text = f"max|dec-res| {err:.4f} m (1 LSB {lsb:.4f} m, tol {tol:.4f})"
    return not problems, text + ("" if not problems else "  FAIL: " + "; ".join(problems))


def compare_contours(tiles, cfg, scan, h):
    """contours.py's image-grid range, plus an alignment check: the image grid interpolated
    (bilinear) at every scan cell vs the scan-grid heights (median / 99th percentile |diff|)."""
    n, e = cfg.get("image_size", 4096), cfg["extent"]
    hc = resample(tiles, e, n)
    xs = scan["min_x"] + np.arange(scan["w"]) * scan["step"]
    zs = scan["max_z"] - np.arange(scan["h"]) * scan["step"]
    zz, xx = np.meshgrid(zs, xs, indexing="ij")
    cols = (xx + e) / (2 * e) * n - 0.5
    rows = (e - zz) / (2 * e) * n - 0.5
    hi = map_coordinates(hc, [rows.ravel(), cols.ravel()], order=1, mode="nearest").reshape(h.shape)
    d = np.abs(hi - h)
    return (f"contours {hc.min():.1f}-{hc.max():.1f} m (d {float(h.min()) - float(hc.min()):+.2f}/"
            f"{float(h.max()) - float(hc.max()):+.2f}), align med {np.median(d):.3f} p99 {np.percentile(d, 99):.3f} m")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("maps", nargs="*")
    ap.add_argument("--game-dir", default=DEFAULT_GAME_DIR)
    ap.add_argument("--verify", action="store_true", help="check the existing PNG/JSON files, write nothing")
    ap.add_argument("--contours", action="store_true",
                    help="also compare with contours.py's 4096 px image grid (range + alignment)")
    args = ap.parse_args()

    data_dir = os.path.join(args.game_dir, "Silica_Data")
    config = load_map_config()
    maps = args.maps or sorted({cfg.get("base_map", name) for name, cfg in config.items()})
    scenes = scene_indices(data_dir)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    failed = 0
    for name in maps:
        cfg = config[name]
        scan = scan_of(cfg)
        tiles = load_tiles(data_dir, scenes[name], cfg["extent"])
        if not tiles:
            print(f"  [WARN] {name}: no terrain tile inside the map extent")
            failed += 1
            continue
        h = resample_grid(tiles, scan)
        extra = ""
        if args.contours:
            extra = " | " + compare_contours(tiles, cfg, scan, h)
        if args.verify:
            ok, text = verify(name, h, scan)
            failed += not ok
            print(f"  [{'OK' if ok else 'FAIL'}] {name}: {text}{extra}")
            continue
        meta, png = export(name, h, scan)
        print(f"  [OK] {name}: {scan['w']}x{scan['h']}, heights {meta['hmin']:.1f}-{meta['hmax']:.1f} m "
              f"-> {png.name} ({png.stat().st_size / 1e3:.0f} KB){extra}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
