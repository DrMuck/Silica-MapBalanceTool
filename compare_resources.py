#!/usr/bin/env python3
"""
Semantic diff of map resource data against the last committed baseline (git HEAD).

Workflow:
    1. Re-dump maps in-game (admin: !mapdump on each map).
    2. python preprocess.py [Map ...]      # overwrites data/resources/*.json
    3. python compare_resources.py         # shows what actually changed

Because preprocess.py rewrites the JSON in place, the "before" side is read from
git HEAD rather than from disk. A clean working tree therefore reports no changes.

Patches are matched by (type, x, z) with a small tolerance so a re-dump of an
unchanged map produces zero diff even if the dump order shifts. Anything that
can't be matched is reported as ADDED or REMOVED.

Usage:
    python compare_resources.py                 # every map with resource data
    python compare_resources.py GreatErg TheMaw # specific maps
    python compare_resources.py --json          # machine-readable output
"""

import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
RES_DIR = SCRIPT_DIR / "data" / "resources"

# Max horizontal distance (metres) at which two patches are considered "the same
# patch, possibly nudged". Dumps print positions at 1 decimal, so anything beyond
# a couple of metres is a real move rather than float noise.
MATCH_TOLERANCE = 3.0
# Below this, a position delta isn't worth reporting as a move.
MOVE_REPORT_MIN = 0.5


def git_show(relpath):
    """Read a file's committed (HEAD) contents. Returns None if not in HEAD."""
    try:
        out = subprocess.run(
            ["git", "show", f"HEAD:{relpath}"],
            cwd=SCRIPT_DIR, capture_output=True, text=True, check=True,
        )
        return json.loads(out.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return None


def load_current(map_name):
    path = RES_DIR / f"{map_name}.json"
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def match_patches(old, new):
    """
    Pair up old/new patches by type + proximity.

    Returns (pairs, added, removed) where pairs is a list of (old, new).
    Greedy nearest-match; each old patch is consumed at most once.
    """
    unclaimed = list(old)
    pairs, added = [], []

    for n in new:
        best, best_d = None, None
        for o in unclaimed:
            if o.get("type") != n.get("type"):
                continue
            dx = (o.get("x", 0.0) - n.get("x", 0.0))
            dz = (o.get("z", 0.0) - n.get("z", 0.0))
            d = (dx * dx + dz * dz) ** 0.5
            if d <= MATCH_TOLERANCE and (best_d is None or d < best_d):
                best, best_d = o, d
        if best is None:
            added.append(n)
        else:
            unclaimed.remove(best)
            pairs.append((best, n, best_d))

    return pairs, added, unclaimed


def describe(p):
    return (f"{p.get('type','?')} @ ({p.get('x',0):.0f}, {p.get('z',0):.0f}) "
            f"max={p.get('resources_max',0)} active={p.get('active')}")


def diff_map(map_name):
    """Diff one map. Returns a result dict (None if there's nothing to compare)."""
    new_data = load_current(map_name)
    if new_data is None:
        return None
    old_data = git_show(f"data/resources/{map_name}.json")

    new = new_data.get("resources", [])
    if old_data is None:
        return {
            "map": map_name, "new_map": True,
            "added": new, "removed": [], "changed": [], "moved": [],
            "old_total": 0, "new_total": len(new),
        }

    old = old_data.get("resources", [])

    # Some early dumps were taken before the round initialised resources, so every
    # patch landed with resources_max=0 / active=False. Those baselines carry valid
    # POSITIONS but meaningless amounts, and diffing them would flag every single
    # patch as "changed". Detect that and report the amount/active deltas as one
    # summary line instead of per-patch noise.
    stale_baseline = old and all(
        (o.get("resources_max") or 0) == 0 and not o.get("active") for o in old
    )

    pairs, added, removed = match_patches(old, new)

    changed, moved = [], []
    for o, n, dist in pairs:
        deltas = []
        if not stale_baseline:
            if o.get("resources_max") != n.get("resources_max"):
                deltas.append(f"max {o.get('resources_max')} -> {n.get('resources_max')}")
            if bool(o.get("active")) != bool(n.get("active")):
                deltas.append(f"active {o.get('active')} -> {n.get('active')}")
        if o.get("cell_size") != n.get("cell_size"):
            deltas.append(f"cell_size {o.get('cell_size')} -> {n.get('cell_size')}")
        if (o.get("grid_w"), o.get("grid_h")) != (n.get("grid_w"), n.get("grid_h")):
            deltas.append(f"grid {o.get('grid_w')}x{o.get('grid_h')} -> "
                          f"{n.get('grid_w')}x{n.get('grid_h')}")
        if deltas:
            changed.append({"patch": n, "deltas": deltas})
        if dist is not None and dist >= MOVE_REPORT_MIN:
            moved.append({"patch": n, "dist": dist,
                          "dx": n.get("x", 0.0) - o.get("x", 0.0),
                          "dz": n.get("z", 0.0) - o.get("z", 0.0)})

    # A map whose terrain origin was nudged shifts EVERY patch by the same vector.
    # That's not a gameplay change (patches are unmoved relative to terrain), so
    # collapse it into a single note instead of one line per patch.
    global_shift = None
    if pairs and len(moved) >= 0.8 * len(pairs):
        buckets = {}
        for m in moved:
            key = (round(m["dx"] * 2) / 2, round(m["dz"] * 2) / 2)
            buckets.setdefault(key, []).append(m)
        key, members = max(buckets.items(), key=lambda kv: len(kv[1]))
        if len(members) >= 0.8 * len(pairs):
            global_shift = {"dx": key[0], "dz": key[1], "count": len(members)}
            moved = [m for m in moved if m not in members]

    return {
        "map": map_name, "new_map": False, "stale_baseline": stale_baseline,
        "global_shift": global_shift,
        "added": added, "removed": removed, "changed": changed, "moved": moved,
        "old_total": len(old), "new_total": len(new),
        "n_repaired": len(pairs) if stale_baseline else 0,
    }


def print_report(r):
    n_add, n_rem = len(r["added"]), len(r["removed"])
    n_chg, n_mov = len(r["changed"]), len(r["moved"])
    total_changes = n_add + n_rem + n_chg + n_mov

    if r["new_map"]:
        print(f"\n### {r['map']}  [NEW MAP] {r['new_total']} patches (no baseline)")
        return total_changes

    if total_changes == 0 and not r.get("stale_baseline"):
        print(f"### {r['map']}: unchanged ({r['new_total']} patches)")
        return 0

    print(f"\n### {r['map']}: {r['old_total']} -> {r['new_total']} patches  "
          f"(+{n_add} added, -{n_rem} removed, {n_chg} changed, {n_mov} moved)")

    if r.get("stale_baseline"):
        print(f"    ! BASELINE WAS UNINITIALISED — old dump had every patch at "
              f"max=0/inactive (taken pre-round).")
        print(f"      {r['n_repaired']} existing patch(es) now have real amounts + "
              f"active flags for the first time.")
        print(f"      Amount/active deltas suppressed as noise; added/removed/moved "
              f"below are the real signal.")

    for p in r["added"]:
        print(f"    + ADDED    {describe(p)}")
    for p in r["removed"]:
        print(f"    - REMOVED  {describe(p)}")
    # Group identical delta signatures — a map-wide tweak (e.g. every Biotics patch
    # changing cell size) is one line, not 50 near-identical ones.
    groups = {}
    for c in r["changed"]:
        sig = (c["patch"].get("type", "?"),) + tuple(c["deltas"])
        groups.setdefault(sig, []).append(c["patch"])
    for sig, patches in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        rtype, deltas = sig[0], sig[1:]
        print(f"    ~ CHANGED  {len(patches)}x {rtype}: {'; '.join(deltas)}")
        for p in patches[:3]:
            print(f"                 e.g. ({p.get('x',0):.0f}, {p.get('z',0):.0f})")
        if len(patches) > 3:
            print(f"                 ... and {len(patches) - 3} more")
    gs = r.get("global_shift")
    if gs:
        print(f"    > MAP SHIFTED  all {gs['count']} matched patches moved by "
              f"(dx={gs['dx']}, dz={gs['dz']}) - terrain origin nudged, "
              f"patches unmoved relative to map (not a gameplay change)")
    for m in r["moved"]:
        print(f"    > MOVED    {describe(m['patch'])}  by {m['dist']:.1f}m")

    return total_changes


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv

    if args:
        maps = args
    else:
        maps = sorted(p.stem for p in RES_DIR.glob("*.json"))

    results = []
    for m in maps:
        r = diff_map(m)
        if r is None:
            print(f"[WARN] {m}: no data/resources/{m}.json — skipped")
            continue
        results.append(r)

    if as_json:
        print(json.dumps(results, indent=2))
        return

    print(f"Comparing {len(results)} map(s) against git HEAD baseline\n")
    total = 0
    changed_maps = []
    for r in results:
        n = print_report(r)
        total += n
        if n:
            changed_maps.append(r["map"])

    print("\n" + "=" * 60)
    if total == 0:
        print("No resource changes detected.")
    else:
        print(f"{total} change(s) across {len(changed_maps)} map(s): "
              f"{', '.join(changed_maps)}")
        print("\nMaps listed above should get a FULL !mapdump so their placement masks")
        print("and refinery-accessibility data are regenerated for the new patches.")


if __name__ == "__main__":
    main()
