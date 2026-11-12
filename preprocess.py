#!/usr/bin/env python3
"""
Preprocess Si_MapBalance scan data into compact browser-friendly formats.

Reads raw dump/scan files from UserData\\MapBalance\\ and produces:
  - data/maps/*.jpg         (map images extracted from assets.pak, JPEG q90)
  - data/resources/*.json   (resource area positions per map)
  - data/masks/*.png        (RGBA placement masks for HQ/refinery per faction)
  - data/refineries/*.json  (per-resource refinery accessibility + ramp dirs)
  - data/refineries/ref_layer_*.png + ref_place_*.json (refinery placeability, spec 15.2)
  - js/map_config.js        (auto-generated per-map metadata)

Usage:
    python preprocess.py                # Process all maps with scan data
    python preprocess.py GreatErg       # Process single map
    python preprocess.py --sites [Map ...] [--site-dir DIR]
                                        # only data/sites/* from the base site scan (docs/SITE_SCAN.md)
"""

import sys
import os
import re
import json
import glob
import numpy as np
from pathlib import Path
from PIL import Image

# --- Paths ---
SCRIPT_DIR = Path(__file__).parent.resolve()
DATA_DIR = SCRIPT_DIR / "data"
SCAN_DIR = Path(r"E:\Steam\steamapps\common\Silica Dedicated Server\UserData\MapBalance")
MAPREPLAY_DIR = Path(r"E:\Steam\steamapps\common\Silica Dedicated Server\Mod MapReplay")
ASSETS_PAK = MAPREPLAY_DIR / "assets.pak"

# Refinery placeability (spec 15.2): a harvester-ramp placement is GOOD for a Balterium patch when
# its entry point is within PLACE_D_GOOD m of the patch rectangle and faces it (align >= PLACE_ALIGN_GOOD).
PLACE_D_GOOD = 150
PLACE_ALIGN_GOOD = 0.7
# Vanilla ConstructionPreview.GetObstructed rejects a site whose non-Entry construction bounds touch a
# non-empty ResourceArea (any type). Site box = AboveGroundPoints extent of the scan header plus the
# prefab's ConstructionBoundsMin/MaxOffset (Si_RefineryPlacement/analysis/refinery_dump.json).
REFINERY_SITE_OFFSET = {"Sol": 10.0, "Cent": 0.0}

# Add MapReplay modules to path for AssetPack
sys.path.insert(0, str(MAPREPLAY_DIR / "modules"))

# Map world extents (from MapReplay config.py)
MAP_WORLD_EXTENTS = {
    "Badlands": 3000,
    "BlackIsle": 1000,
    "Citadel": 1500,
    "CrimsonPeak": 2048,
    "CrystalChasm": 1500,
    "GreatErg": 3000,
    "IndustrialQuarter": 2000,
    "MonumentValley": 3000,
    "NarakaCity": 3000,
    "NorthPolarCap": 2048,
    "RiftBasin": 1500,
    "SmallStrategyTest": 500,
    "TheMaw": 1500,
    "WhisperingPlains": 2048,
}


def find_latest_file(pattern):
    """Find the latest timestamped file matching a glob pattern."""
    files = glob.glob(str(SCAN_DIR / pattern))
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def extract_map_image(map_name):
    """Extract map image from assets.pak and save as JPEG."""
    out_path = DATA_DIR / "maps" / f"{map_name}.jpg"
    if out_path.exists():
        print(f"  [SKIP] {out_path.name} already exists")
        return True

    try:
        from asset_loader import AssetPack
        pak = AssetPack(str(ASSETS_PAK))
        rel = f"Maps/{map_name}.png"
        if pak.has_asset(rel):
            # Some maps (e.g. Citadel since the 1.0.x redesign) are white line
            # art on transparency; flatten onto the grey of the opaque maps.
            img = pak.load_image(rel).convert("RGBA")
            bg = Image.new("RGBA", img.size, (79, 81, 82, 255))
            img = Image.alpha_composite(bg, img).convert("RGB")
            img.save(str(out_path), "JPEG", quality=90)
            print(f"  [OK] Extracted {map_name}.jpg ({img.size[0]}x{img.size[1]})")
            return True
        else:
            print(f"  [WARN] Map '{map_name}' not found in assets.pak")
            return False
    except Exception as e:
        print(f"  [ERROR] Failed to extract {map_name}: {e}")
        return False


def parse_resource_dump(map_name):
    """Parse resource areas from dump file -> JSON."""
    dump_file = find_latest_file(f"dump_{map_name}_*.txt")
    if not dump_file:
        print(f"  [WARN] No dump file for {map_name}")
        return None

    extent = MAP_WORLD_EXTENTS.get(map_name, 3000)
    terrain_pos = None
    terrain_size = None
    resources = []
    current = None

    with open(dump_file, 'r') as f:
        for line in f:
            line = line.rstrip()

            # Terrain info
            m = re.match(r'Terrain Position: \(([-\d.]+), ([-\d.]+), ([-\d.]+)\)', line)
            if m:
                terrain_pos = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
                continue

            m = re.match(r'Terrain Size: \(([-\d.]+), ([-\d.]+), ([-\d.]+)\)', line)
            if m:
                terrain_size = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
                continue

            # Resource area header
            m = re.match(r'\[(\d+)\] "([^"]+)" \((\w+)\)', line)
            if m:
                if current is not None:
                    resources.append(current)
                current = {
                    "idx": int(m.group(1)),
                    "name": m.group(2),
                    "type": m.group(3),
                }
                continue

            if current is None:
                continue

            # Active status
            m = re.match(r'\s+Active: (True|False)', line)
            if m:
                current["active"] = m.group(1) == "True"
                continue

            # Position
            m = re.match(r'\s+Position: \(([-\d.]+), ([-\d.]+), ([-\d.]+)\)', line)
            if m:
                current["x"] = float(m.group(1))
                current["y"] = float(m.group(2))
                current["z"] = float(m.group(3))
                continue

            # Grid
            m = re.match(r'\s+Grid: (\d+)x(\d+) cells, CellSize=([\d.]+)m', line)
            if m:
                current["grid_w"] = int(m.group(1))
                current["grid_h"] = int(m.group(2))
                current["cell_size"] = float(m.group(3))
                continue

            # World extent
            m = re.match(r'\s+World extent: ([\d.]+)x([\d.]+)m', line)
            if m:
                current["world_w"] = float(m.group(1))
                current["world_h"] = float(m.group(2))
                continue

            # Resources
            m = re.match(r'\s+Resources: (\d+) / (\d+)', line)
            if m:
                current["resources_current"] = int(m.group(1))
                current["resources_max"] = int(m.group(2))
                continue

    if current is not None:
        resources.append(current)

    # Filter out clone entries (spawned by old mod versions) and re-index
    original_count = len(resources)
    resources = [r for r in resources if "(Clone)" not in r.get("name", "")]
    if len(resources) < original_count:
        print(f"  [INFO] Filtered {original_count - len(resources)} clone entries, re-indexing {len(resources)} originals")
        for i, r in enumerate(resources):
            r["idx"] = i

    result = {
        "map": map_name,
        "extent": extent,
        "terrain_pos": terrain_pos,
        "terrain_size": terrain_size,
        "resources": resources,
    }

    out_path = DATA_DIR / "resources" / f"{map_name}.json"
    with open(out_path, 'w') as f:
        json.dump(result, f, indent=1)

    n_active = sum(1 for r in resources if r.get("active"))
    print(f"  [OK] {map_name}: {len(resources)} resources ({n_active} active) -> {out_path.name}")
    return result


def parse_scan_header(filepath):
    """Parse header of a scan file, return metadata dict and line number where CSV starts."""
    meta = {}
    csv_start_line = None

    with open(filepath, 'r') as f:
        for i, line in enumerate(f):
            line = line.rstrip()

            m = re.match(r'Map: (\w+)', line)
            if m:
                meta['map'] = m.group(1)

            m = re.match(r'Faction: (\w+)', line)
            if m:
                meta['faction'] = m.group(1)

            m = re.match(r'Scan: X=\[([-\d]+),([-\d]+)\] Z=\[([-\d]+),([-\d]+)\] step=(\d+)', line)
            if m:
                meta['scan_min_x'] = int(m.group(1))
                meta['scan_max_x'] = int(m.group(2))
                meta['scan_min_z'] = int(m.group(3))
                meta['scan_max_z'] = int(m.group(4))
                meta['scan_step'] = int(m.group(5))

            if line.startswith("=== CSV DATA"):
                csv_start_line = i + 2  # skip the header line too
                break

    if csv_start_line is None:
        return meta, None

    # Compute grid dimensions
    if 'scan_step' in meta:
        step = meta['scan_step']
        meta['grid_w'] = (meta['scan_max_x'] - meta['scan_min_x']) // step + 1
        meta['grid_h'] = (meta['scan_max_z'] - meta['scan_min_z']) // step + 1

    return meta, csv_start_line


def generate_hq_mask(map_name, faction):
    """Generate HQ placement mask PNG from scan data."""
    pattern = f"hq_scan_{faction}_{map_name}_*.txt"
    scan_file = find_latest_file(pattern)
    if not scan_file:
        print(f"  [WARN] No HQ scan for {faction} {map_name}")
        return None

    meta, csv_start = parse_scan_header(scan_file)
    if csv_start is None:
        print(f"  [WARN] No CSV data in {scan_file}")
        return None

    step = meta['scan_step']
    min_x, max_x = meta['scan_min_x'], meta['scan_max_x']
    min_z, max_z = meta['scan_min_z'], meta['scan_max_z']
    grid_w = meta['grid_w']
    grid_h = meta['grid_h']

    # Create mask: RGBA with green tint for valid
    mask = np.zeros((grid_h, grid_w, 4), dtype=np.uint8)

    with open(scan_file, 'r') as f:
        for i, line in enumerate(f):
            if i < csv_start:
                continue
            parts = line.strip().split(',')
            if len(parts) < 3:
                continue
            try:
                x = int(float(parts[0]))
                z = int(float(parts[1]))
            except ValueError:
                continue

            gx = (x - min_x) // step
            gz = (max_z - z) // step  # flip: row 0 = north (max Z)
            if 0 <= gx < grid_w and 0 <= gz < grid_h:
                mask[gz, gx] = [0, 200, 0, 100]

    out_path = DATA_DIR / "masks" / f"hq_{faction}_{map_name}.png"
    Image.fromarray(mask).save(str(out_path))

    n_valid = np.sum(mask[:, :, 3] > 0)
    print(f"  [OK] HQ mask {faction} {map_name}: {n_valid} valid cells -> {out_path.name}")
    return meta


def generate_refinery_mask(map_name, faction):
    """Generate refinery placement mask PNG from scan data."""
    pattern = f"refinery_scan_{faction}_{map_name}_*.txt"
    scan_file = find_latest_file(pattern)
    if not scan_file:
        print(f"  [WARN] No refinery scan for {faction} {map_name}")
        return None

    meta, csv_start = parse_scan_header(scan_file)
    if csv_start is None:
        print(f"  [WARN] No CSV data in {scan_file}")
        return None

    step = meta['scan_step']
    min_x, max_x = meta['scan_min_x'], meta['scan_max_x']
    min_z, max_z = meta['scan_min_z'], meta['scan_max_z']
    grid_w = meta['grid_w']
    grid_h = meta['grid_h']

    # Create mask: RGBA with blue tint for valid
    mask = np.zeros((grid_h, grid_w, 4), dtype=np.uint8)

    # Also collect ramp data for per-resource analysis
    ramp_data = []  # list of (x, z, rampA_ok, rampA_dirX, rampA_dirZ, rampB_ok, rampB_dirX, rampB_dirZ)

    with open(scan_file, 'r') as f:
        for i, line in enumerate(f):
            if i < csv_start:
                continue
            parts = line.strip().split(',')
            if len(parts) < 6:
                continue
            try:
                x = float(parts[0])
                z = float(parts[1])
            except ValueError:
                continue

            gx = int((x - min_x) / step)
            gz = int((max_z - z) / step)
            if 0 <= gx < grid_w and 0 <= gz < grid_h:
                mask[gz, gx] = [0, 100, 255, 100]

            # Parse ramp data if present (refinery scans have 12 columns)
            if len(parts) >= 12:
                try:
                    rampA_ok = int(parts[6])
                    rampA_dirX = float(parts[7])
                    rampA_dirZ = float(parts[8])
                    rampB_ok = int(parts[9])
                    rampB_dirX = float(parts[10])
                    rampB_dirZ = float(parts[11])
                    if rampA_ok or rampB_ok:
                        ramp_data.append((x, z, rampA_ok, rampA_dirX, rampA_dirZ,
                                          rampB_ok, rampB_dirX, rampB_dirZ))
                except (ValueError, IndexError):
                    pass

    out_path = DATA_DIR / "masks" / f"ref_{faction}_{map_name}.png"
    Image.fromarray(mask).save(str(out_path))

    n_valid = np.sum(mask[:, :, 3] > 0)
    print(f"  [OK] Ref mask {faction} {map_name}: {n_valid} valid cells -> {out_path.name}")

    return meta, ramp_data


def compute_refinery_access(map_name, faction, ramp_data, resources):
    """For each resource area, find best refinery placement with ramp facing it."""
    if not ramp_data or not resources:
        return

    # Convert ramp data to numpy for fast filtering
    ramp_arr = np.array([(r[0], r[1]) for r in ramp_data])  # (x, z) only
    ramp_full = ramp_data  # keep full tuples

    results = []

    for res in resources:
        rx, rz = res.get('x', 0), res.get('z', 0)

        # Bounding box filter: within 600m
        dist_x = np.abs(ramp_arr[:, 0] - rx)
        dist_z = np.abs(ramp_arr[:, 1] - rz)
        bbox_mask = (dist_x <= 600) & (dist_z <= 600)
        candidates = np.where(bbox_mask)[0]

        if len(candidates) == 0:
            results.append({
                "idx": res["idx"],
                "accessible": False,
                "n_valid": 0,
            })
            continue

        best_align = -1
        best_entry = None
        n_valid = 0

        for ci in candidates:
            entry = ramp_full[ci]
            ref_x, ref_z = entry[0], entry[1]

            # Euclidean distance check
            dist = ((ref_x - rx) ** 2 + (ref_z - rz) ** 2) ** 0.5
            if dist > 600 or dist < 1:
                continue

            # Direction from refinery to resource
            to_res_x = (rx - ref_x) / dist
            to_res_z = (rz - ref_z) / dist

            # Check ramp A
            if entry[2]:  # rampA_ok
                align = to_res_x * entry[3] + to_res_z * entry[4]
                if align > 0.5:
                    n_valid += 1
                    if align > best_align:
                        best_align = align
                        best_entry = {
                            "ref_x": round(ref_x, 1),
                            "ref_z": round(ref_z, 1),
                            "ramp_dirX": round(entry[3], 3),
                            "ramp_dirZ": round(entry[4], 3),
                            "dist": round(dist, 1),
                            "align": round(align, 3),
                        }

            # Check ramp B
            if entry[5]:  # rampB_ok
                align = to_res_x * entry[6] + to_res_z * entry[7]
                if align > 0.5:
                    n_valid += 1
                    if align > best_align:
                        best_align = align
                        best_entry = {
                            "ref_x": round(ref_x, 1),
                            "ref_z": round(ref_z, 1),
                            "ramp_dirX": round(entry[6], 3),
                            "ramp_dirZ": round(entry[7], 3),
                            "dist": round(dist, 1),
                            "align": round(align, 3),
                        }

        entry_out = {
            "idx": res["idx"],
            "accessible": n_valid > 0,
            "n_valid": n_valid,
        }
        if best_entry:
            entry_out["best"] = best_entry
        results.append(entry_out)

    out_path = DATA_DIR / "refineries" / f"ref_access_{faction}_{map_name}.json"
    with open(out_path, 'w') as f:
        json.dump(results, f, indent=1)

    n_accessible = sum(1 for r in results if r["accessible"])
    print(f"  [OK] Ref access {faction} {map_name}: {n_accessible}/{len(results)} accessible -> {out_path.name}")


def generate_ramp_grid(map_name, faction):
    """Generate per-position ramp accessibility grid from refinery scan data.

    Produces a grayscale PNG where each pixel encodes 8 bits of ramp data:
      bit 0: rampA accessible at rot=0
      bit 1: rampB accessible at rot=0
      bit 2: rampA accessible at rot=90
      bit 3: rampB accessible at rot=90
      bit 4: rampA accessible at rot=180
      bit 5: rampB accessible at rot=180
      bit 6: rampA accessible at rot=270
      bit 7: rampB accessible at rot=270

    The frontend uses these bits + per-structure mapping to determine which
    ramp edges are accessible for a given footprint position and orientation.
    """
    pattern = f"refinery_scan_{faction}_{map_name}_*.txt"
    scan_file = find_latest_file(pattern)
    if not scan_file:
        print(f"  [WARN] No refinery scan for {faction} {map_name}")
        return

    meta, csv_start = parse_scan_header(scan_file)
    if csv_start is None:
        print(f"  [WARN] No CSV data in {scan_file}")
        return

    step = meta['scan_step']
    min_x, max_x = meta['scan_min_x'], meta['scan_max_x']
    min_z, max_z = meta['scan_min_z'], meta['scan_max_z']
    grid_w = meta['grid_w']
    grid_h = meta['grid_h']

    # Collect ramp flags per grid cell: accumulate OR of flags across all entries
    # Key: (gx, gz) -> 8-bit value
    grid = np.zeros((grid_h, grid_w), dtype=np.uint8)

    rot_to_shift = {0: 0, 90: 2, 180: 4, 270: 6}

    with open(scan_file, 'r') as f:
        for i, line in enumerate(f):
            if i < csv_start:
                continue
            parts = line.strip().split(',')
            if len(parts) < 12:
                continue
            try:
                x = float(parts[0])
                z = float(parts[1])
                rot = int(float(parts[2]))
                rampA_ok = int(parts[6])
                rampB_ok = int(parts[9])
            except (ValueError, IndexError):
                continue

            gx = int((x - min_x) / step)
            gz = int((max_z - z) / step)  # flip: row 0 = north (max Z)
            if not (0 <= gx < grid_w and 0 <= gz < grid_h):
                continue

            shift = rot_to_shift.get(rot)
            if shift is None:
                continue

            bits = 0
            if rampA_ok:
                bits |= (1 << shift)
            if rampB_ok:
                bits |= (1 << (shift + 1))

            grid[gz, gx] |= bits

    out_path = DATA_DIR / "ramps" / f"ramp_grid_{faction}_{map_name}.png"
    Image.fromarray(grid, mode='L').save(str(out_path))

    n_any = np.sum(grid > 0)
    print(f"  [OK] Ramp grid {faction} {map_name}: {n_any} cells with ramp data -> {out_path.name}")


def parse_refinery_platform_box(filepath):
    """Local XZ extent (x0, x1, z0, z1) of the 'AboveGroundPoints' of a refinery scan header, or None."""
    xs, zs = [], []
    on = False
    with open(filepath, 'r') as f:
        for line in f:
            if line.startswith("=== CSV DATA"):
                break
            if line.startswith("---"):
                on = line.startswith("--- AboveGroundPoints")
                continue
            m = re.match(r'\s*\(([-\d.]+), ([-\d.]+), ([-\d.]+)\)', line)
            if on and m:
                xs.append(float(m.group(1)))
                zs.append(float(m.group(3)))
    if not xs:
        return None
    return min(xs), max(xs), min(zs), max(zs)


def parse_harvester_ramp_entries(filepath):
    """Return {"A": |entryLocal|_xz, "B": ...} for the two harvester ramps of a refinery scan.

    The 'Ramps' section lists every ramp as `[i] type=... check=(...) entry=(x,y,z)`; the
    'Harvester ramps' summary maps `Ramp A (idx n)` / `Ramp B (idx m)` to those indices, in the
    same order as the CSV rampA/rampB columns.
    """
    entries = {}
    harvester = {}
    with open(filepath, 'r') as f:
        for line in f:
            if line.startswith("=== CSV DATA"):
                break
            m = re.match(r'\s*\[(\d+)\] type=\w+ check=\([^)]*\) entry=\(([-\d.]+),([-\d.]+),([-\d.]+)\)', line)
            if m:
                entries[int(m.group(1))] = (float(m.group(2)), float(m.group(4)))
                continue
            m = re.match(r'\s*Ramp ([AB]) \(idx (\d+)\)', line)
            if m:
                harvester[m.group(1)] = int(m.group(2))
    out = {}
    for ramp, idx in harvester.items():
        if idx in entries:
            ex, ez = entries[idx]
            out[ramp] = float(np.hypot(ex, ez))
    return out


def generate_refinery_layers(map_name, faction, resources=None):
    """Refinery placeability layers + per-patch placeability (spec 15.2).

    Writes data/refineries/ref_layer_{faction}_{map}_r{000,090,180,270}.png (8-bit grayscale on the
    scan grid, bit0 valid, bit1/2 rampA/B ok, bit3/4 rampA/B GOOD for some Balterium patch) and
    data/refineries/ref_place_{faction}_{map}.json. Placements whose site box (platform extent +
    REFINERY_SITE_OFFSET, rotated by the yaw) touches any resource rectangle are dropped (vanilla
    rejects them). Each remaining ramp placement is attributed to the nearest Balterium rectangle
    (P = nearest point to the ramp entry E). Returns the set of
    Balterium idx with n_good >= 1, or None when the scan or the resources are missing.
    """
    scan_file = find_latest_file(f"refinery_scan_{faction}_{map_name}_*.txt")
    if not scan_file:
        print(f"  [WARN] No refinery scan for {faction} {map_name}")
        return None
    meta, csv_start = parse_scan_header(scan_file)
    if csv_start is None or 'scan_step' not in meta:
        print(f"  [WARN] No CSV data in {scan_file}")
        return None
    entry_len = parse_harvester_ramp_entries(scan_file)
    if 'A' not in entry_len or 'B' not in entry_len:
        print(f"  [WARN] No harvester ramp entries in {scan_file}")
        return None
    box = parse_refinery_platform_box(scan_file)
    if box is None:
        print(f"  [WARN] No AboveGroundPoints in {scan_file}")
        return None

    if not resources:
        res_path = DATA_DIR / "resources" / f"{map_name}.json"
        if not res_path.exists():
            print(f"  [WARN] No resources JSON for {map_name}")
            return None
        with open(res_path) as f:
            resources = json.load(f).get("resources", [])

    step = meta['scan_step']
    min_x, max_z = meta['scan_min_x'], meta['scan_max_z']
    grid_w, grid_h = meta['grid_w'], meta['grid_h']

    # CSV: x,z,rot,terrainY,adjustY,finalY,rampA_ok,rampA_dirX,rampA_dirZ,rampB_ok,rampB_dirX,rampB_dirZ
    data = np.loadtxt(scan_file, delimiter=',', skiprows=csv_start,
                      usecols=(0, 1, 2, 6, 7, 8, 9, 10, 11), ndmin=2)
    rot = np.rint(data[:, 2]).astype(np.int32) % 360

    # Drop sites whose box touches a resource rectangle (Balterium or Biotics; Unity Bounds.Intersects
    # counts touching). Yaw maps local (x, z) to world (x cos + z sin, -x sin + z cos).
    off = REFINERY_SITE_OFFSET.get(faction, 0.0)
    bx0, bx1, bz0, bz1 = box[0] - off, box[1] + off, box[2] - off, box[3] + off
    local = {0: (bx0, bx1, bz0, bz1), 90: (bz0, bz1, -bx1, -bx0),
             180: (-bx1, -bx0, -bz1, -bz0), 270: (-bz1, -bz0, bx0, bx1)}
    lx0, lx1, lz0, lz1 = (np.zeros(len(rot)) for _ in range(4))
    for r, (a, b, c, d_) in local.items():
        sel = rot == r
        lx0[sel], lx1[sel], lz0[sel], lz1[sel] = a, b, c, d_
    sx0, sx1 = data[:, 0] + lx0, data[:, 0] + lx1
    sz0, sz1 = data[:, 1] + lz0, data[:, 1] + lz1
    clear = np.isin(rot, list(local.keys()))
    for r in resources:
        if not r.get('world_w') or not r.get('world_h'):
            continue
        rx0, rx1 = r['x'] - r['world_w'] / 2, r['x'] + r['world_w'] / 2
        rz0, rz1 = r['z'] - r['world_h'] / 2, r['z'] + r['world_h'] / 2
        clear &= ~((sx0 <= rx1) & (sx1 >= rx0) & (sz0 <= rz1) & (sz1 >= rz0))
    n_scan = len(data)
    data, rot = data[clear], rot[clear]
    x, z = data[:, 0], data[:, 1]
    n = len(x)

    balt = [r for r in resources if r.get('type') == 'Balterium']
    rect = np.array([[r['x'] - r['world_w'] / 2, r['x'] + r['world_w'] / 2,
                      r['z'] - r['world_h'] / 2, r['z'] + r['world_h'] / 2] for r in balt],
                    dtype=np.float64).reshape(-1, 4)

    per_ramp = {}  # ramp -> (ok mask, rows, d, align, nearest patch k, is_good)
    for ramp, c_ok, c_dx, c_dz in (("A", 3, 4, 5), ("B", 6, 7, 8)):
        ok = data[:, c_ok] > 0.5
        rows = np.nonzero(ok)[0]
        dx, dz = data[rows, c_dx], data[rows, c_dz]
        norm = np.hypot(dx, dz)
        norm[norm == 0] = 1.0
        dx, dz = dx / norm, dz / norm
        ex = x[rows] + dx * entry_len[ramp]
        ez = z[rows] + dz * entry_len[ramp]

        # Nearest Balterium rectangle per entry point (running min over the patches).
        best_d2 = np.full(len(rows), np.inf)
        best_k = np.full(len(rows), -1, dtype=np.int32)
        best_px = np.zeros(len(rows))
        best_pz = np.zeros(len(rows))
        for k in range(len(rect)):
            px = np.clip(ex, rect[k, 0], rect[k, 1])
            pz = np.clip(ez, rect[k, 2], rect[k, 3])
            d2 = (px - ex) ** 2 + (pz - ez) ** 2
            upd = d2 < best_d2
            best_d2[upd] = d2[upd]
            best_k[upd] = k
            best_px[upd] = px[upd]
            best_pz[upd] = pz[upd]

        d = np.sqrt(best_d2)
        with np.errstate(invalid='ignore', divide='ignore'):
            align = (dx * (best_px - ex) + dz * (best_pz - ez)) / d
        align[d < 5.0] = 1.0
        align[~np.isfinite(align)] = -1.0
        align = np.minimum(align, 1.0)
        is_good = (best_k >= 0) & (d <= PLACE_D_GOOD) & (align >= PLACE_ALIGN_GOOD)
        per_ramp[ramp] = (ok, rows, d, align, best_k, is_good)

    def row_mask(ramp, which):
        ok, rows, _, _, _, is_good = per_ramp[ramp]
        if which == "ok":
            return ok
        g = np.zeros(n, dtype=bool)
        g[rows[is_good]] = True
        return g

    # Rotation layers (same px/py mapping as generate_ramp_grid; row 0 = north).
    gx = np.rint((x - min_x) / step).astype(np.int64)
    gy = np.rint((max_z - z) / step).astype(np.int64)
    inside = (gx >= 0) & (gx < grid_w) & (gy >= 0) & (gy < grid_h)
    bits = (np.uint8(1)
            | (row_mask("A", "ok").astype(np.uint8) << 1) | (row_mask("B", "ok").astype(np.uint8) << 2)
            | (row_mask("A", "good").astype(np.uint8) << 3) | (row_mask("B", "good").astype(np.uint8) << 4))
    bits = bits.astype(np.uint8)
    out_dir = DATA_DIR / "refineries"
    good_cells = []
    for r in (0, 90, 180, 270):
        grid = np.zeros((grid_h, grid_w), dtype=np.uint8)
        sel = inside & (rot == r)
        np.bitwise_or.at(grid, (gy[sel], gx[sel]), bits[sel])
        Image.fromarray(grid, mode='L').save(str(out_dir / f"ref_layer_{faction}_{map_name}_r{r:03d}.png"))
        good_cells.append(int(np.count_nonzero(grid & 0x18)))

    # Per-patch placeability.
    def placement(ramp, i):
        _, rows, d, align, _, _ = per_ramp[ramp]
        row = rows[i]
        return {"x": round(float(x[row]), 1), "z": round(float(z[row]), 1), "rot": int(rot[row]),
                "ramp": ramp, "d": round(float(d[i]), 1), "align": round(float(align[i]), 3)}

    balt_k = {r['idx']: k for k, r in enumerate(balt)}
    patches = []
    placeable = set()
    for res in resources:
        k = balt_k.get(res['idx'])
        entry = {"idx": res['idx'], "n_good": 0, "best": None, "best_any": None, "good": []}
        if k is not None:
            cand_good, cand_any = [], []
            good_flat = []
            for ramp_i, ramp in enumerate(("A", "B")):
                _, rows, d, align, best_k, is_good = per_ramp[ramp]
                mine = best_k == k
                gi = np.nonzero(mine & is_good)[0]
                entry["n_good"] += int(len(gi))
                if len(gi):
                    # spec 15.8: flat [x, z, c] per GOOD placement, c = rotIndex * 2 + ramp (A 0, B 1)
                    gr = rows[gi]
                    trip = np.stack([np.rint(x[gr]), np.rint(z[gr]), (rot[gr] // 90) * 2 + ramp_i], axis=1)
                    good_flat.append(trip.astype(np.int64))
                if len(gi):
                    j = gi[np.argmin(d[gi])]
                    cand_good.append((d[j], ramp, j))
                ai = np.nonzero(mine & (align >= PLACE_ALIGN_GOOD))[0]
                if len(ai):
                    j = ai[np.argmin(d[ai])]
                    cand_any.append((d[j], ramp, j))
            if good_flat:
                entry["good"] = np.concatenate(good_flat).ravel().tolist()
            if cand_good:
                _, ramp, j = min(cand_good, key=lambda t: t[0])
                entry["best"] = placement(ramp, j)
                placeable.add(res['idx'])
            if cand_any:
                _, ramp, j = min(cand_any, key=lambda t: t[0])
                entry["best_any"] = placement(ramp, j)
        patches.append(entry)

    # site_box: x / z extent of the site box at rot 0 incl. the ConstructionBounds offsets (spec 15.8)
    header = {"map": map_name, "faction": faction, "d_good": PLACE_D_GOOD, "align_good": PLACE_ALIGN_GOOD,
              "scan": {"min_x": min_x, "max_z": max_z, "step": step},
              "site_box": {"w": int(round(bx1 - bx0)), "h": int(round(bz1 - bz0))}}
    out_path = out_dir / f"ref_place_{faction}_{map_name}.json"
    # Header keys indented, one compact line per patch (the "good" lists are long).
    with open(out_path, 'w') as f:
        f.write("{\n")
        for key, val in header.items():
            f.write(f' {json.dumps(key)}: {json.dumps(val)},\n')
        f.write(' "patches": [\n')
        f.write(",\n".join("  " + json.dumps(e, separators=(',', ':')) for e in patches))
        f.write("\n ]\n}\n")

    print(f"  [OK] Ref layers {faction} {map_name}: {n}/{n_scan} placements clear of resources, cells with a GOOD ramp per rot "
          f"{'/'.join(str(c) for c in good_cells)}; Balterium placeable {len(placeable)}/{len(balt)} "
          f"-> {out_path.name} + 4 PNG")
    return placeable


SITE_SCAN_DIR = SCAN_DIR / "site_scan"
SITE_KEYS = ("Sol", "Cent", "Alien")
SITE_YAWS = (0, 90, 180, 270)
SITE_REASONS = ["ok", "offmap", "ground_terrain", "ground_static", "on_static", "overlap", "navmesh", "no_data"]


def _png_plain(img, path):
    """Save without gAMA/sRGB chunks (PIL writes none for these modes unless asked)."""
    img.save(str(path), optimize=True)


def generate_site_layers(map_name, scan_dir=None):
    """Base site scan (Si_MapBalance 3.6.0 site scan mode) -> data/sites/ (spec: docs/SITE_SCAN.md).

    Reads the newest site_scan_<Map>_*.txt and writes, on the scan grid (row 0 = north):
      site_<Sol|Cent|Alien>_<Map>_r<000|090|180|270>.png  8-bit grayscale, pixel = site code byte
      open_<Map>.png                                       8-bit grayscale, pixel = open-ground bits
      surf_<Map>.png                                       opaque RGB, 16-bit surface height R/G (0 = none)
      site_meta_<Map>.json                                 grid, code legend, structures, probes, counts
    Existing masks (data/masks/hq_*.png) are not touched.
    """
    sdir = Path(scan_dir) if scan_dir else SITE_SCAN_DIR
    files = glob.glob(str(sdir / f"site_scan_{map_name}_*.txt"))
    if not files:
        print(f"  [WARN] No site scan for {map_name} in {sdir}")
        return None
    scan_file = max(files, key=os.path.getmtime)

    header = {}
    structures, probes, extra = [], {}, {}
    csv_start = None
    with open(scan_file, 'r', encoding='utf-8-sig') as f:
        lines = f.readlines()
    for i, line in enumerate(lines):
        line = line.rstrip('\n')
        m = re.match(r'Scan: X=\[([-\d]+),([-\d]+)\] Z=\[([-\d]+),([-\d]+)\] step=(\d+)', line)
        if m:
            header.update(min_x=int(m.group(1)), max_x=int(m.group(2)), min_z=int(m.group(3)),
                          max_z=int(m.group(4)), step=int(m.group(5)))
        elif line.startswith("Structure "):
            structures.append(line[len("Structure "):])
        elif line.startswith("Probe "):
            k, _, v = line[len("Probe "):].partition(": ")
            probes[k] = v
        elif re.match(r'(Time|Map|Mod|Game|Terrain|Params|FogOfWarBounds|Scan time|Cells|Open vehicle): ', line):
            k, _, v = line.partition(": ")
            extra[k] = v
        elif line.startswith("=== CSV DATA"):
            csv_start = i + 2
            break
    if csv_start is None or 'step' not in header:
        print(f"  [WARN] Malformed site scan {scan_file}")
        return None

    step = header['step']
    min_x, max_z = header['min_x'], header['max_z']
    grid_w = (header['max_x'] - min_x) // step + 1
    grid_h = (max_z - header['min_z']) // step + 1

    # x,z,sy,s000,s090,s180,s270,c000,c090,c180,c270,n000,n090,n180,n270,o,vy,ay
    def num(s):
        return float(s) if s.strip() != '' else np.nan
    rows = [l.rstrip('\n').split(',') for l in lines[csv_start:] if l.strip()]
    data = np.array([[num(v) for v in r[:18]] for r in rows if len(r) >= 16], dtype=np.float64)
    gx = np.rint((data[:, 0] - min_x) / step).astype(np.int64)
    gy = np.rint((max_z - data[:, 1]) / step).astype(np.int64)
    inside = (gx >= 0) & (gx < grid_w) & (gy >= 0) & (gy < grid_h)
    gx, gy, data = gx[inside], gy[inside], data[inside]

    # Scan format 1 (Si_MapBalance 3.6.0 before the Nest rule change) failed the Nest on the ground rule.
    # Since format 2 the Nest's ground result is info only. Every test was evaluated in format 1 too, so
    # the new code follows from the flag bits: reason = overlap if bit 6 is clear, else navmesh if bit 7 is
    # clear, else valid. Idempotent (format 2 files never carry a ground reason for the Nest).
    scan_version = 1
    mv = re.search(r'=== Base Site Scan v(\d+)', ''.join(lines[:3]))
    if mv:
        scan_version = int(mv.group(1))
    nest_fixed = 0
    for ri in range(4):
        col = 3 + 2 * 4 + ri
        c = data[:, col].astype(np.int64)
        reason = (c >> 1) & 7
        sel = (reason == 2) | (reason == 3)
        if sel.any():
            newr = np.where((c & 0x40) == 0, 5, np.where((c & 0x80) == 0, 6, 0))
            nc = (c & 0xF0) | (newr << 1) | (newr == 0).astype(np.int64)
            data[sel, col] = nc[sel]
            nest_fixed += int(sel.sum())

    out_dir = DATA_DIR / "sites"
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {}
    for si, key in enumerate(SITE_KEYS):
        counts[key] = {}
        for ri, yaw in enumerate(SITE_YAWS):
            grid = np.zeros((grid_h, grid_w), dtype=np.uint8)
            grid[gy, gx] = data[:, 3 + si * 4 + ri].astype(np.uint8)
            _png_plain(Image.fromarray(grid, mode='L'), out_dir / f"site_{key}_{map_name}_r{yaw:03d}.png")
            counts[key][f"r{yaw:03d}"] = int(np.count_nonzero(grid & 1))
    og = np.zeros((grid_h, grid_w), dtype=np.uint8)
    og[gy, gx] = data[:, 15].astype(np.uint8)
    _png_plain(Image.fromarray(og, mode='L'), out_dir / f"open_{map_name}.png")

    sy = data[:, 2]
    ok = np.isfinite(sy)
    hmin = float(np.nanmin(sy)) if ok.any() else 0.0
    hmax = float(np.nanmax(sy)) if ok.any() else 1.0
    span = max(hmax - hmin, 1e-3)
    v = np.zeros(len(sy), dtype=np.int64)
    v[ok] = np.rint((sy[ok] - hmin) / span * 65534).astype(np.int64) + 1
    rgb = np.zeros((grid_h, grid_w, 3), dtype=np.uint8)
    rgb[gy, gx, 0] = (v >> 8).astype(np.uint8)
    rgb[gy, gx, 1] = (v & 0xFF).astype(np.uint8)
    _png_plain(Image.fromarray(rgb, mode='RGB'), out_dir / f"surf_{map_name}.png")

    # Vanilla start points (position + yaw per team) from the scan's site_startpoints_<Map>_*.csv, so the
    # rotation the mod uses without a layout "rot" (nearest start point of the team) resolves offline.
    start_points = []
    sp_files = glob.glob(str(sdir / f"site_startpoints_{map_name}_*.csv"))
    if sp_files:
        import csv as _csv
        seen = set()
        with open(max(sp_files, key=os.path.getmtime), newline='', encoding='utf-8-sig') as f:
            for r in _csv.DictReader(f):
                k = (r["team"], r["idx"])
                if k in seen:
                    continue
                seen.add(k)
                start_points.append({"team": r["team"], "idx": int(r["idx"]), "name": r["name"],
                                     "x": round(float(r["x"]), 1), "z": round(float(r["z"]), 1),
                                     "yaw": round(float(r["yaw"]) % 360, 1)})
    else:
        print(f"  [WARN] No site_startpoints for {map_name}: meta without start points")

    meta = {
        "map": map_name, "version": 2, "source": os.path.basename(scan_file),
        "scan_format": scan_version, "nest_ground_rule": "info",
        "nest_codes_normalized": nest_fixed,
        "start_points": start_points,
        "grid": {"scan_min_x": min_x, "scan_max_x": header['max_x'], "scan_min_z": header['min_z'],
                 "scan_max_z": max_z, "step": step, "grid_w": int(grid_w), "grid_h": int(grid_h)},
        "site_code": {"bit0": "valid", "bits1_3": "reason", "bit4": "terrain_rule", "bit5": "game_rule",
                      "bit6": "no_static_overlap", "bit7": "navmesh", "reasons": SITE_REASONS},
        "open_code": {"bit0": "vehicle_ok", "bit1": "alien_ok", "bit2": "ground", "bit3": "on_static",
                      "bit4": "vehicle_overlap", "bit5": "vehicle_nav_fail", "bit6": "alien_nav_fail",
                      "bit7": "alien_overlap"},
        "surf": {"hmin": round(hmin, 3), "hmax": round(hmax, 3),
                 "decode": "v = R*256+G; v == 0: no data; y = hmin + (v-1)/65534*(hmax-hmin)"},
        "structures": structures, "probes": probes, "scan": extra,
        "valid_counts": counts,
        "open_counts": {"vehicle_ok": int(np.count_nonzero(og & 1)), "alien_ok": int(np.count_nonzero(og & 2))},
    }
    with open(out_dir / f"site_meta_{map_name}.json", 'w') as f:
        json.dump(meta, f, indent=1)
    print(f"  [OK] Site layers {map_name}: {grid_w}x{grid_h}, valid " +
          ", ".join(f"{k} {'/'.join(str(c) for c in counts[k].values())}" for k in SITE_KEYS) +
          f", open vehicle {meta['open_counts']['vehicle_ok']} alien {meta['open_counts']['alien_ok']}"
          f" <- {os.path.basename(scan_file)}")
    return meta


def discover_all_data_maps():
    """Find all maps that have processed resource JSON data on disk."""
    res_dir = DATA_DIR / "resources"
    maps = set()
    if res_dir.exists():
        for f in res_dir.iterdir():
            if f.suffix == ".json":
                maps.add(f.stem)
    return sorted(maps)


def generate_map_config(processed_maps):
    """Auto-generate js/map_config.js with per-map metadata.

    Includes all maps with resource data on disk, not just those processed
    in the current run.  Freshly-processed maps get scan grid info from
    their HQ scan headers; previously-processed maps get defaults.
    """
    config = {}

    # Start with all maps that have resource data on disk
    all_maps = discover_all_data_maps()
    for map_name in all_maps:
        extent = MAP_WORLD_EXTENTS.get(map_name, 3000)
        entry = {
            "extent": extent,
            "image_size": 4096,
            "factions": ["Sol", "Cent"],
        }

        # Try to get scan grid info from HQ scan file on disk
        hq_file = find_latest_file(f"hq_scan_Sol_{map_name}_*.txt")
        if hq_file:
            m, _ = parse_scan_header(hq_file)
            entry["scan_min_x"] = m.get("scan_min_x", -extent)
            entry["scan_max_x"] = m.get("scan_max_x", extent)
            entry["scan_min_z"] = m.get("scan_min_z", -extent)
            entry["scan_max_z"] = m.get("scan_max_z", extent)
            entry["scan_step"] = m.get("scan_step", 15)
            entry["grid_w"] = m.get("grid_w", (2 * extent) // 15 + 1)
            entry["grid_h"] = m.get("grid_h", (2 * extent) // 15 + 1)

        config[map_name] = entry

    # Override with freshly-processed data (has richer metadata)
    for map_name, data in processed_maps.items():
        extent = MAP_WORLD_EXTENTS.get(map_name, 3000)
        entry = config.get(map_name, {
            "extent": extent,
            "image_size": 4096,
            "factions": ["Sol", "Cent"],
        })
        if "hq_meta" in data and data["hq_meta"]:
            m = data["hq_meta"]
            entry["scan_min_x"] = m.get("scan_min_x", -extent)
            entry["scan_max_x"] = m.get("scan_max_x", extent)
            entry["scan_min_z"] = m.get("scan_min_z", -extent)
            entry["scan_max_z"] = m.get("scan_max_z", extent)
            entry["scan_step"] = m.get("scan_step", 15)
            entry["grid_w"] = m.get("grid_w", 401)
            entry["grid_h"] = m.get("grid_h", 401)
        config[map_name] = entry

    js_content = "// Auto-generated by preprocess.py — do not edit\n"
    js_content += "const MAP_CONFIG = " + json.dumps(config, indent=2) + ";\n"

    out_path = SCRIPT_DIR / "js" / "map_config.js"
    with open(out_path, 'w') as f:
        f.write(js_content)

    print(f"\n[OK] Generated js/map_config.js with {len(config)} maps")


def discover_maps():
    """Find all maps that have scan data."""
    maps = set()
    for f in os.listdir(SCAN_DIR):
        # Match dump_MapName_YYYYMMDD_HHMMSS.txt (timestamp is 8+6 digits)
        m = re.match(r'dump_([A-Za-z]+)_\d{8}_\d{6}\.txt', f)
        if m:
            maps.add(m.group(1))
    return sorted(maps)


def process_map(map_name):
    """Process all data for a single map."""
    print(f"\n{'='*60}")
    print(f"Processing: {map_name}")
    print(f"{'='*60}")

    result = {"map": map_name}

    # 1. Extract map image
    print("\n[1] Map image:")
    extract_map_image(map_name)

    # 2. Parse resource dump
    print("\n[2] Resource dump:")
    res_data = parse_resource_dump(map_name)
    resources = res_data["resources"] if res_data else []

    # 3. HQ masks (both factions)
    print("\n[3] HQ placement masks:")
    hq_meta = None
    for faction in ["Sol", "Cent"]:
        m = generate_hq_mask(map_name, faction)
        if m and not hq_meta:
            hq_meta = m
    result["hq_meta"] = hq_meta

    # 4. Refinery masks + ramp data (both factions)
    print("\n[4] Refinery placement masks:")
    for faction in ["Sol", "Cent"]:
        ret = generate_refinery_mask(map_name, faction)
        if ret:
            meta, ramp_data = ret
            if not hq_meta:
                hq_meta = meta
                result["hq_meta"] = hq_meta

            # 5. Per-resource refinery accessibility
            print(f"\n[5] Refinery accessibility ({faction}):")
            compute_refinery_access(map_name, faction, ramp_data, resources)

            # 6. Ramp accessibility grid (for footprint tool)
            print(f"\n[6] Ramp grid ({faction}):")
            generate_ramp_grid(map_name, faction)

    # 7. Refinery placeability layers + per-patch placeability (spec 15.2)
    print("\n[7] Refinery placeability layers:")
    placeable = {f: generate_refinery_layers(map_name, f, resources) for f in ["Sol", "Cent"]}
    if placeable["Sol"] is not None and placeable["Cent"] is not None:
        if not resources:
            with open(DATA_DIR / "resources" / f"{map_name}.json") as f:
                resources = json.load(f).get("resources", [])
        n_balt = sum(1 for r in resources if r.get('type') == 'Balterium')
        sol, cent = placeable["Sol"], placeable["Cent"]
        print(f"  [SUMMARY] {map_name}: Balterium {n_balt}, placeable Sol {len(sol)} / Cent {len(cent)} / "
              f"both {len(sol & cent)} / neither {n_balt - len(sol | cent)}")
    result["placeable"] = placeable

    # 8. Base site layers (Si_MapBalance 3.6.0 site scan, docs/SITE_SCAN.md); skipped without a scan
    print("\n[8] Base site layers:")
    generate_site_layers(map_name)

    return result


def main():
    # Ensure output dirs exist
    for subdir in ["maps", "resources", "masks", "refineries", "ramps"]:
        (DATA_DIR / subdir).mkdir(parents=True, exist_ok=True)
    (SCRIPT_DIR / "js").mkdir(parents=True, exist_ok=True)

    # Site layers only (docs/SITE_SCAN.md): python preprocess.py --sites [Map ...] [--site-dir DIR]
    if "--sites" in sys.argv:
        args = [a for a in sys.argv[1:] if a != "--sites"]
        site_dir = None
        if "--site-dir" in args:
            i = args.index("--site-dir")
            site_dir = args[i + 1]
            del args[i:i + 2]
        if not args:
            sdir = Path(site_dir) if site_dir else SITE_SCAN_DIR
            args = sorted({re.match(r'site_scan_(.+)_\d{8}_\d{6}\.txt', os.path.basename(p)).group(1)
                           for p in glob.glob(str(sdir / "site_scan_*_*.txt"))})
        print(f"Site layers for: {', '.join(args)}")
        for map_name in args:
            generate_site_layers(map_name, site_dir)
        return

    # Determine which maps to process
    if len(sys.argv) > 1:
        maps_to_process = sys.argv[1:]
    else:
        maps_to_process = discover_maps()

    print(f"Maps to process: {', '.join(maps_to_process)}")

    processed = {}
    for map_name in maps_to_process:
        result = process_map(map_name)
        processed[map_name] = result

    # Generate map_config.js
    generate_map_config(processed)

    print(f"\nDone! Processed {len(processed)} maps.")
    print(f"Data output: {DATA_DIR}")
    print(f"Config output: {SCRIPT_DIR / 'js' / 'map_config.js'}")


if __name__ == "__main__":
    main()
