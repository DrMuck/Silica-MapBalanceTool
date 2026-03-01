#!/usr/bin/env python3
"""
Preprocess Si_MapBalance scan data into compact browser-friendly formats.

Reads raw dump/scan files from UserData\\MapBalance\\ and produces:
  - data/maps/*.jpg         (map images extracted from assets.pak, JPEG q90)
  - data/resources/*.json   (resource area positions per map)
  - data/masks/*.png        (RGBA placement masks for HQ/refinery per faction)
  - data/refineries/*.json  (per-resource refinery accessibility + ramp dirs)
  - js/map_config.js        (auto-generated per-map metadata)

Usage:
    python preprocess.py                # Process all maps with scan data
    python preprocess.py GreatErg       # Process single map
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

# Add MapReplay modules to path for AssetPack
sys.path.insert(0, str(MAPREPLAY_DIR / "modules"))

# Map world extents (from MapReplay config.py)
MAP_WORLD_EXTENTS = {
    "Badlands": 3000,
    "BlackIsle": 1000,
    "CrimsonPeak": 2048,
    "CrystalChasm": 1500,
    "GreatErg": 3000,
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
            img = pak.load_image(rel).convert("RGB")
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


def generate_map_config(processed_maps):
    """Auto-generate js/map_config.js with per-map metadata."""
    config = {}
    for map_name, data in processed_maps.items():
        extent = MAP_WORLD_EXTENTS.get(map_name, 3000)
        entry = {
            "extent": extent,
            "image_size": 4096,
            "factions": ["Sol", "Cent"],
        }
        # Add scan grid info if available
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

    return result


def main():
    # Ensure output dirs exist
    for subdir in ["maps", "resources", "masks", "refineries", "ramps"]:
        (DATA_DIR / subdir).mkdir(parents=True, exist_ok=True)
    (SCRIPT_DIR / "js").mkdir(parents=True, exist_ok=True)

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
