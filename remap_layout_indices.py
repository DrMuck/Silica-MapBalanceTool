#!/usr/bin/env python3
"""
Remap resource-patch indices in the server's Spawns layout JSONs after a re-dump.

Si_MapBalance layouts reference patches POSITIONALLY by index:
    resources.removed_patches  = [3, 7, 8, ...]
    resources.patch_overrides  = {"1": 20000, ...}

When a game update adds resource patches, those indices shift and every layout
silently starts targeting the wrong patches. This rewrites each index to point at
the same PHYSICAL patch it referred to before, by matching old->new patch positions.

The "before" side is read from a git revision of data/resources (default HEAD~1),
the "after" side from the working tree.

Indices whose patch no longer exists (genuinely removed from the map) are dropped
and reported — they cannot be remapped.

Running this twice would remap already-remapped indices and corrupt the layouts, so
it writes a stamp file and refuses to run again unless --force is passed.

Usage:
    python remap_layout_indices.py --dry-run     # report only, touch nothing
    python remap_layout_indices.py               # back up, then rewrite
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
RES_DIR = SCRIPT_DIR / "data" / "resources"
SPAWNS = Path(r"E:\Steam\steamapps\common\Silica Dedicated Server\UserData\cfg\Spawns")
STAMP = SPAWNS / ".index_remap_done.json"

# Must exceed any whole-map origin shift (CrimsonPeak moved ~1.4m) while staying
# well below the spacing between distinct patches.
TOL = 4.0

# Not real maps - a scratch copy directory sitting alongside the map folders.
SKIP_DIRS = {"New folder"}


def old_resources(map_name, rev):
    out = subprocess.run(
        ["git", "show", f"{rev}:data/resources/{map_name}.json"],
        cwd=SCRIPT_DIR, capture_output=True, text=True)
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)["resources"]
    except (json.JSONDecodeError, KeyError):
        return None


def new_resources(map_name):
    p = RES_DIR / f"{map_name}.json"
    if not p.exists():
        return None
    with open(p) as f:
        return json.load(f)["resources"]


def build_index_map(old, new):
    """old_idx -> new_idx, matching each old patch to the nearest new patch of the
    same type. Unmatched old indices are simply absent from the mapping."""
    mapping, used = {}, set()
    for o in old:
        best, best_d = None, None
        for n in new:
            if n.get("type") != o.get("type") or n["idx"] in used:
                continue
            d = ((n.get("x", 0) - o.get("x", 0)) ** 2 +
                 (n.get("z", 0) - o.get("z", 0)) ** 2) ** 0.5
            if d <= TOL and (best_d is None or d < best_d):
                best, best_d = n, d
        if best is not None:
            used.add(best["idx"])
            mapping[o["idx"]] = best["idx"]
    return mapping


def remap_file(path, imap, dry_run):
    with open(path) as f:
        data = json.load(f)
    res = data.get("resources")
    if not isinstance(res, dict):
        return None

    rp = res.get("removed_patches")
    po = res.get("patch_overrides")
    if not rp and not po:
        return None

    dropped = []
    changed = False

    if rp:
        new_rp = []
        for i in rp:
            if i in imap:
                new_rp.append(imap[i])
            else:
                dropped.append(("removed_patches", i))
        new_rp = sorted(set(new_rp))
        if new_rp != rp:
            res["removed_patches"] = new_rp
            changed = True

    if po:
        new_po = {}
        for k, v in po.items():
            i = int(k)
            if i in imap:
                new_po[str(imap[i])] = v
            else:
                dropped.append(("patch_overrides", i))
        if new_po != po:
            res["patch_overrides"] = new_po
            changed = True

    if changed and not dry_run:
        with open(path, "w", newline="\n") as f:
            json.dump(data, f, indent=2)
            f.write("\n")

    return {"changed": changed, "dropped": dropped,
            "n_rp": len(rp or []), "n_po": len(po or {})}


def main():
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    rev = "HEAD~1"
    for a in sys.argv[1:]:
        if a.startswith("--rev="):
            rev = a.split("=", 1)[1]

    if STAMP.exists() and not force and not dry_run:
        print(f"[ABORT] {STAMP.name} exists - indices were already remapped on "
              f"{json.load(open(STAMP)).get('when')}.")
        print("        Re-running would double-remap and corrupt the layouts.")
        print("        Pass --force only if you are certain.")
        return 1

    if not dry_run:
        backup = SPAWNS.parent / f"Spawns_backup_indexremap_{datetime.now():%Y%m%d_%H%M%S}"
        shutil.copytree(SPAWNS, backup)
        print(f"[OK] Backed up Spawns -> {backup.name}\n")

    total_files = total_changed = total_dropped = 0
    touched_maps = []

    for map_dir in sorted(SPAWNS.iterdir()):
        if not map_dir.is_dir() or map_dir.name in SKIP_DIRS:
            continue
        map_name = map_dir.name
        old, new = old_resources(map_name, rev), new_resources(map_name)
        if not old or not new:
            continue

        imap = build_index_map(old, new)
        shifted = sum(1 for k, v in imap.items() if k != v)
        unmapped = len(old) - len(imap)
        if shifted == 0 and unmapped == 0:
            print(f"{map_name}: indices stable - skipped")
            continue

        print(f"\n{map_name}: {shifted} shifted index/indices"
              f"{f', {unmapped} old patch(es) no longer exist' if unmapped else ''}")
        touched_maps.append(map_name)

        for path in sorted(map_dir.glob("*.json")):
            r = remap_file(path, imap, dry_run)
            if r is None:
                continue
            total_files += 1
            if r["changed"]:
                total_changed += 1
                print(f"    {'would fix' if dry_run else 'FIXED':9} {path.name}"
                      f"  ({r['n_rp']} removed, {r['n_po']} overrides)")
            for kind, i in r["dropped"]:
                total_dropped += 1
                print(f"      ! dropped {kind}[{i}] - patch no longer exists")

    print("\n" + "=" * 60)
    print(f"{'Would rewrite' if dry_run else 'Rewrote'} {total_changed} of "
          f"{total_files} index-bearing file(s) across {len(touched_maps)} map(s)")
    if total_dropped:
        print(f"{total_dropped} index ref(s) dropped (patch removed from map)")

    if not dry_run and total_changed:
        with open(STAMP, "w") as f:
            json.dump({"when": datetime.now().isoformat(timespec="seconds"),
                       "rev": rev, "maps": touched_maps,
                       "files_changed": total_changed}, f, indent=2)
        print(f"\nWrote {STAMP.name} to prevent accidental double-remapping.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
