#!/usr/bin/env python3
"""
Verify that preprocessed resource data reflects VANILLA map state, not a state
that Si_MapBalance already modified.

The mod applies a per-round layout from UserData/cfg/Spawns/{Map}/layout_*.json which
can disable patches (removed_patches), override individual amounts (patch_overrides),
and force global amounts (balterium_amount / biotics_amount). If !mapdump runs after
that has been applied, the dump captures the MODIFIED map and the tool's reference
data becomes wrong.

This script cross-checks each map's data against every layout defined for it and
reports whether the data looks vanilla.

Usage:
    python check_vanilla.py                  # every map with resource data
    python check_vanilla.py RiftBasin        # specific maps
"""

import glob
import json
import os
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
RES_DIR = SCRIPT_DIR / "data" / "resources"
SPAWNS_DIR = Path(r"E:\Steam\steamapps\common\Silica Dedicated Server\UserData\cfg\Spawns")

# If this fraction or more of a layout's removed_patches are inactive in our data,
# treat it as evidence the layout was applied before the dump.
REMOVED_MATCH_THRESHOLD = 0.9


def load_layouts(map_name):
    out = []
    for f in sorted(glob.glob(str(SPAWNS_DIR / map_name / "layout_*.json"))):
        try:
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        out.append((os.path.basename(f), d.get("resources") or {}))
    return out


def vanilla_uniform_norms(map_names):
    """
    Some resource types are uniform in vanilla (every Biotics patch is 22000), so a
    layout that forces that same value is a no-op and must NOT be read as evidence
    the layout was applied. Derive the vanilla norm per type as the most common
    single-value-across-the-whole-map figure, seen over every map we have data for.
    """
    seen = {}
    for m in map_names:
        path = RES_DIR / f"{m}.json"
        if not path.exists():
            continue
        with open(path) as f:
            res = json.load(f)["resources"]
        for t in {r["type"] for r in res}:
            vals = {r.get("resources_max") for r in res if r["type"] == t}
            # Skip zeros: a map dumped pre-initialisation is uniformly 0, which is a
            # broken capture rather than a vanilla norm.
            if len(vals) == 1 and next(iter(vals)):
                seen.setdefault(t, Counter())[next(iter(vals))] += 1
    return {t: c.most_common(1)[0][0] for t, c in seen.items()}


def check_map(map_name, norms=None):
    norms = norms or {}
    path = RES_DIR / f"{map_name}.json"
    if not path.exists():
        return None
    with open(path) as f:
        res = json.load(f)["resources"]

    by_idx = {r["idx"]: r for r in res}
    inactive = {r["idx"] for r in res if not r.get("active")}
    findings = []

    # Amount spread per type. A layout's global override collapses every patch of a
    # type onto one value, so low variety is itself a yellow flag worth showing.
    amounts = {}
    for t in {r["type"] for r in res}:
        vals = Counter(r.get("resources_max") for r in res if r["type"] == t)
        amounts[t] = vals

    layouts = load_layouts(map_name)
    for name, lr in layouts:
        removed = set(lr.get("removed_patches") or [])
        overrides = {int(k): v for k, v in (lr.get("patch_overrides") or {}).items()}

        # 1. removed_patches applied?
        if removed:
            hit = len(removed & inactive)
            frac = hit / len(removed)
            if frac >= REMOVED_MATCH_THRESHOLD:
                findings.append(
                    f"CONTAMINATED: {hit}/{len(removed)} of {name}'s removed_patches "
                    f"are inactive in our data ({frac:.0%})")

        # 2. patch_overrides applied?
        if overrides:
            hit = sum(1 for i, v in overrides.items()
                      if i in by_idx and by_idx[i].get("resources_max") == v)
            if hit and hit / len(overrides) >= REMOVED_MATCH_THRESHOLD:
                findings.append(
                    f"CONTAMINATED: {hit}/{len(overrides)} of {name}'s patch_overrides "
                    f"amounts match our data exactly")

        # 3. global amount override applied?
        for key, rtype in (("balterium_amount", "Balterium"), ("biotics_amount", "Biotics")):
            forced = lr.get(key)
            if not forced or rtype not in amounts:
                continue
            vals = amounts[rtype]
            if len(vals) != 1:
                continue
            only = next(iter(vals))
            if only != forced:
                continue
            # A layout forcing the value this type already has in vanilla changes
            # nothing, so it proves nothing. Only an off-norm value is evidence.
            if norms.get(rtype) == only:
                continue
            findings.append(
                f"CONTAMINATED: every {rtype} patch == {forced} (vanilla norm is "
                f"{norms.get(rtype, '?')}), matching {name}'s {key}")

    return {
        "map": map_name,
        "total": len(res),
        "inactive": len(inactive),
        "layouts": len(layouts),
        "amounts": amounts,
        "findings": findings,
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    maps = args or sorted(p.stem for p in RES_DIR.glob("*.json"))

    # Derive norms from every map we have, not just the ones being checked, so a
    # single-map run still benefits from the full picture.
    norms = vanilla_uniform_norms(sorted(p.stem for p in RES_DIR.glob("*.json")))
    if norms:
        print("Vanilla uniform norms: " +
              ", ".join(f"{t}={v}" for t, v in sorted(norms.items())))

    bad = []
    for m in maps:
        r = check_map(m, norms)
        if r is None:
            print(f"[WARN] {m}: no resource data — skipped")
            continue

        status = "CONTAMINATED" if r["findings"] else "VANILLA"
        print(f"\n### {r['map']}: {status}")
        print(f"    {r['total']} patches, {r['inactive']} inactive, "
              f"{r['layouts']} layout(s) on disk")
        for t, vals in sorted(r["amounts"].items()):
            top = ", ".join(f"{v}x{c}" for v, c in vals.most_common(3))
            print(f"    {t}: {len(vals)} distinct amount(s) [{top}]")
        for f in r["findings"]:
            print(f"    !! {f}")
        if r["findings"]:
            bad.append(r["map"])

    print("\n" + "=" * 60)
    if bad:
        print(f"{len(bad)} map(s) look layout-modified: {', '.join(bad)}")
        print("Re-dump these BEFORE a round starts (or with UserData/cfg/Spawns moved aside)")
        print("so the dump captures vanilla map state.")
    else:
        print(f"All {len(maps)} map(s) look vanilla — no layout effects detected.")


if __name__ == "__main__":
    main()
