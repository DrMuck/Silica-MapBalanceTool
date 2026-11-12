#!/usr/bin/env python3
"""
Offline audit of a folder of layout JSONs against the base site data (docs/SITE_SCAN.md, sections 7-9).

Input is only what the tool ships: data/sites/site_<S>_<Map>_r<yaw>.png, open_<Map>.png, surf_<Map>.png
and site_meta_<Map>.json (incl. the vanilla start points with their yaw). No game, no server.

Per base = one spawn entry [0] of a layout (Sol / Cent / Alien). The structures that can stand there:
the entry's own one, plus the other human HQ when the layout can swap (swap_spawns != false and the
layout has hvh, hvhva or 2v1 - a 2v1 round is an hvhva round in the mod) or when Sol[0] and Cent[0]
are the same position (hva: either HQ stands there). A base is valid when every one of them is valid.
(Before 2026-11-12 stage 2 the 2v1 and shared-position cases were checked for the entry's own HQ only.)
The JS implementation of these rules is js/sites.js; tools/site_selftest.js checks both agree.

  yaw today   layout "rot", else the yaw of the nearest vanilla start point of that structure's team (as
              Si_MapBalance.SpawnAtBestStartPoint does), rounded to the nearest of 0/90/180/270 for the
              grid lookup (flagged when the real yaw is not a multiple of 90)
  tier 1      valid as is at today's yaw
  tier 2      same x/z, valid at another of the four yaws (fix = set "rot"); several: the most margin
              (valid 8-neighbour cells at that yaw, summed over the structures), then closest to today's yaw
  tier 3      nearest grid cell with a yaw valid for all structures within FIX_MAX_M (fix = move + rot)
  tier 4      nothing valid within FIX_MAX_M
  openness    share of the 60..250 m annulus that the base's ground units can stand on and reach

Optional cross-check: --ingame <dir with site_layouts_<Map>_*.csv> compares every grid lookup with the
mod's in-game test of the same base (exact yaw and position) and counts disagreements.

Writes <out>/site_audit.csv, <out>/site_audit.json, <out>/summary.md, <out>/calibration.md.

Usage:
  python tools/site_audit.py --layouts <Spawns dir> --out <dir> [--data data] [--maps ...] [--ingame <dir>]
"""

import argparse
import csv
import glob
import json
import math
import os
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
from PIL import Image

KEYS = ("Sol", "Cent", "Alien")
YAWS = (0, 90, 180, 270)
REASONS = ["ok", "offmap", "ground_terrain", "ground_static", "on_static", "overlap", "navmesh", "no_data"]

ANNULUS = (60.0, 250.0)       # Si_StarterUnits min_radius_m .. max_radius_m
STEP_LIMIT = 25.0             # Si_StarterUnits max_step_from_base_m
SEED_BAND = (40.0, 95.0)      # flood-fill seeds: standable cells just outside the footprint
LOW_OPEN_REACH = {"HQ": 0.50, "Alien": 0.25}   # below ~97 % of the vanilla placements (calibration.md)
FIX_MAX_M = 120.0             # tier 3 search radius
# in-game thresholds of Si_MapBalance 3.6.0 (for the cross-check of v1 in-game CSVs)
GROUND_TOL, OVERLAP_DEPTH = 8.0, 3.0


# ------------------------------------------------------------------ data

def load_site_data(data_dir, m):
    sd = Path(data_dir) / "sites"
    meta_p = sd / f"site_meta_{m}.json"
    if not meta_p.exists():
        return None
    meta = json.loads(meta_p.read_text())
    sites = {k: np.stack([np.array(Image.open(sd / f"site_{k}_{m}_r{y:03d}.png")) for y in YAWS]) for k in KEYS}
    open_ = np.array(Image.open(sd / f"open_{m}.png"))
    rgb = np.array(Image.open(sd / f"surf_{m}.png")).astype(np.int64)
    v = rgb[:, :, 0] * 256 + rgb[:, :, 1]
    s = meta["surf"]
    surf = np.where(v > 0, s["hmin"] + (v - 1) / 65534.0 * (s["hmax"] - s["hmin"]), np.nan)
    valid = {k: (sites[k] & 1) > 0 for k in KEYS}
    marg = {}   # margin: number of valid 8-neighbours at the same yaw
    for k in KEYS:
        a = valid[k].astype(np.int16)
        p = np.pad(a, ((0, 0), (1, 1), (1, 1)))
        n = np.zeros_like(a)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy or dx:
                    n += p[:, 1 + dy:1 + dy + a.shape[1], 1 + dx:1 + dx + a.shape[2]]
        marg[k] = n
    return {"meta": meta, "g": meta["grid"], "sites": sites, "valid": valid, "margin": marg,
            "open": open_, "surf": surf}


def cell(g, x, z):
    return int(round((x - g["scan_min_x"]) / g["step"])), int(round((g["scan_max_z"] - z) / g["step"]))


def world(g, px, py):
    return g["scan_min_x"] + px * g["step"], g["scan_max_z"] - py * g["step"]


def yaw_index(yaw):
    return int(round((yaw % 360) / 90.0)) % 4


def today_yaw(sd, st, x, z, rot):
    if rot is not None:
        return float(rot) % 360, "rot field"
    pts = [p for p in sd["meta"].get("start_points", []) if p["team"] == st]
    if not pts:
        return 0.0, "no start points"
    p = min(pts, key=lambda p: (p["x"] - x) ** 2 + (p["z"] - z) ** 2)
    return float(p["yaw"]) % 360, f"start point {p['name']} ({math.hypot(p['x'] - x, p['z'] - z):.0f} m)"


def openness(sd, key, x, z):
    """Raw = standable share of the annulus; reach = share of the annulus reachable (8-connected flood over
    standable cells within 250 m) from standable seed cells 40..95 m from the base. Standable: open-ground
    vehicle_ok (HQs) / alien_ok (Nest), and surface within 25 m of the base ground (median surface of the
    ground, non-static cells within 40 m)."""
    g = sd["g"]
    bit = 2 if key == "Alien" else 1
    stand = (sd["open"] & bit) > 0
    surf = sd["surf"]
    px0, py0 = cell(g, x, z)
    h, w = stand.shape
    if not (0 <= px0 < w and 0 <= py0 < h):
        return None
    r = int(math.ceil(ANNULUS[1] / g["step"])) + 1
    ys, xs = np.mgrid[max(0, py0 - r):min(h, py0 + r + 1), max(0, px0 - r):min(w, px0 + r + 1)]
    wx, wz = world(g, xs, ys)
    d = np.hypot(wx - x, wz - z)
    o = sd["open"][ys, xs]
    near = (d <= 40.0) & ((o & 4) > 0) & ((o & 8) == 0) & np.isfinite(surf[ys, xs])
    base_y = float(np.median(surf[ys, xs][near])) if near.any() else surf[py0, px0]
    st = stand[ys, xs]
    if np.isfinite(base_y):
        st = st & (np.abs(np.nan_to_num(surf[ys, xs], nan=1e9) - base_y) <= STEP_LIMIT)
    inmap = np.isfinite(surf[ys, xs])
    ann = (d >= ANNULUS[0]) & (d <= ANNULUS[1]) & inmap
    n_ann = int(ann.sum())
    if n_ann == 0:
        return None
    raw = float((st & ann).sum()) / n_ann
    disk = (d <= ANNULUS[1]) & st
    seen = disk & (d >= SEED_BAND[0]) & (d <= SEED_BAND[1])
    q = deque(zip(*np.nonzero(seen)))
    hh, ww = disk.shape
    while q:
        a, b = q.popleft()
        for da in (-1, 0, 1):
            for db in (-1, 0, 1):
                na, nb = a + da, b + db
                if 0 <= na < hh and 0 <= nb < ww and disk[na, nb] and not seen[na, nb]:
                    seen[na, nb] = True
                    q.append((na, nb))
    return {"raw": round(raw, 3), "reach": round(float((seen & ann).sum()) / n_ann, 3), "cells": n_ann}


def first_reason(code):
    return REASONS[(int(code) >> 1) & 7]


# ------------------------------------------------------------------ in-game cross-check

def read_ingame(ingame_dir, m):
    if not ingame_dir:
        return {}
    files = sorted(glob.glob(os.path.join(ingame_dir, f"site_layouts_{m}_*.csv")), key=os.path.getmtime)
    if not files:
        return {}
    rows = defaultdict(dict)
    with open(files[-1], newline='', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            rows[(r["folder"], r["file"], r["entry"], r["structure"])][r["variant"]] = r
    return rows


def ingame_valid(r):
    """Validity of an in-game CSV row under the final 3.6.0 rules (v1 CSVs failed the Nest on ground)."""
    if r["reason"] in ("offmap", "no_data"):
        return False
    nav = int(r["nav_ok"])
    ok = float(r["overlap_depth"]) <= OVERLAP_DEPTH and (nav >= 2 or nav < 0)
    if r["structure"] != "Alien":
        det = r["detail"]
        ok = ok and float(r["gap"]) <= GROUND_TOL and not any(t in det for t in ("missed", "tilt", "entry"))
    return ok


# ------------------------------------------------------------------ audit

def modes_of(j):
    gm = j.get("game_modes") or {}
    return [k for k, v in gm.items() if v is True]


def best_yaw(sd, structs, px, py, prefer_yaw):
    """Yaws valid for all structures at the cell, best first: margin, then closeness to prefer_yaw."""
    out = []
    for yi, y in enumerate(YAWS):
        if all(sd["valid"][s][yi, py, px] for s in structs):
            m = sum(int(sd["margin"][s][yi, py, px]) for s in structs)
            dy = abs(y - prefer_yaw) % 360
            out.append((-m, min(dy, 360 - dy), y, m))
    out.sort()
    return [(t[2], t[3]) for t in out]


def nearest_fix(sd, structs, x, z, prefer_yaw, max_d):
    g = sd["g"]
    allv = np.ones_like(sd["valid"][structs[0]])
    for s in structs:
        allv &= sd["valid"][s]
    anyv = allv.any(axis=0)
    px0, py0 = cell(g, x, z)
    r = int(math.ceil(max_d / g["step"])) + 1
    h, w = anyv.shape
    y0, y1, x0, x1 = max(0, py0 - r), min(h, py0 + r + 1), max(0, px0 - r), min(w, px0 + r + 1)
    ys, xs = np.mgrid[y0:y1, x0:x1]
    wx, wz = world(g, xs, ys)
    d = np.hypot(wx - x, wz - z)
    cand = anyv[y0:y1, x0:x1] & (d <= max_d) & (d > 0.5)
    if not cand.any():
        return None
    dd = np.where(cand, d, np.inf)
    i = np.unravel_index(np.argmin(dd), dd.shape)
    py, px = int(ys[i]), int(xs[i])
    yaws = best_yaw(sd, structs, px, py, prefer_yaw)
    fx, fz = world(g, px, py)
    return {"d": round(float(dd[i])), "x": fx, "z": fz, "rot": yaws[0][0], "margin": yaws[0][1]}


def is_low(r):
    v = r.get("open_reach")
    return v is not None and v < LOW_OPEN_REACH["Alien" if r["entry"] == "Alien" else "HQ"]


def spawn0(sp, key):
    arr = sp.get(key)
    return arr[0] if isinstance(arr, list) and arr and isinstance(arr[0], dict) else None


def audit_map(m, layouts_dir, data_dir, ingame_dir):
    sd = load_site_data(data_dir, m)
    if sd is None:
        return [], {"missing": True}
    g = sd["g"]
    ing = read_ingame(ingame_dir, m)
    xc = defaultdict(int)
    xc_list = []
    out = []
    mdir = Path(layouts_dir) / m
    for p in sorted(mdir.rglob("*.json"), key=lambda q: str(q).lower()):
        folder = str(p.parent.relative_to(mdir)).replace("\\", "/")
        folder = "" if folder == "." else folder
        j = json.loads(p.read_text(encoding="utf-8-sig"))
        sp = j.get("spawns") or {}
        modes = modes_of(j)
        swap = j.get("swap_spawns", True) is not False
        # 2v1 layouts run in hvhva rounds (Si_MapBalance.IsTwoVsOneRound), where the mod swaps too
        swap_mode = (not j.get("game_modes")) or ("hvh" in modes or "hvhva" in modes or "2v1" in modes)
        # hva: one position in both Sol[0] and Cent[0] serves either HQ (SITE_SCAN.md section 8)
        s0, c0 = spawn0(sp, "Sol"), spawn0(sp, "Cent")
        shared = bool(s0 and c0 and abs(float(s0.get("x", 0)) - float(c0.get("x", 0))) < 0.5
                      and abs(float(s0.get("z", 0)) - float(c0.get("z", 0))) < 0.5)
        for entry in KEYS:
            arr = sp.get(entry)
            if not isinstance(arr, list) or not arr or not isinstance(arr[0], dict):
                continue
            e = arr[0]
            x, z = float(e.get("x", 0)), float(e.get("z", 0))
            rot = e.get("rot") if isinstance(e.get("rot"), (int, float)) else None
            structs = [entry] + (["Cent" if entry == "Sol" else "Sol"]
                                 if entry != "Alien" and ((swap and swap_mode) or shared) else [])
            px, py = cell(g, x, z)
            gx_, gz_ = world(g, px, py)
            row = {"map": m, "file": p.name, "inactive": folder != "", "folder": folder, "modes": "+".join(modes),
                   "swap": len(structs) > 1, "entry": entry, "structures": "+".join(structs), "x": x, "z": z,
                   "on_grid": abs(gx_ - x) < 0.5 and abs(gz_ - z) < 0.5}
            inside = 0 <= px < g["grid_w"] and 0 <= py < g["grid_h"]
            today = {}
            for st in structs:
                yaw, src = today_yaw(sd, st, x, z, rot)
                yi = yaw_index(yaw)
                code = int(sd["sites"][st][yi, py, px]) if inside else 2
                exact = min(abs(yaw - YAWS[yi]), abs(yaw - YAWS[yi] - 360), abs(yaw - YAWS[yi] + 360)) < 1.0
                today[st] = (yaw, yi, code)
                row.update({f"yaw_{st}": round(yaw, 1), f"yaw_src_{st}": src, f"yaw_exact_{st}": exact,
                            f"code_{st}": code, f"reason_{st}": first_reason(code),
                            f"valid_yaws_{st}": "/".join(str(y) for yi2, y in enumerate(YAWS)
                                                         if inside and sd["valid"][st][yi2, py, px]) or "-"})
                if inside:
                    row[f"legacy_yaws_{st}"] = "/".join(str(y) for yi2, y in enumerate(YAWS) if sd["sites"][st][yi2, py, px] & 0x10) or "-"
                v = ing.get((folder, p.name, entry, st))
                if v and inside:
                    for yi2, y in enumerate(YAWS):
                        r = v.get(f"r{y:03d}")
                        if r is None:
                            continue
                        a, b = bool(sd["valid"][st][yi2, py, px]), ingame_valid(r)
                        xc["grid_yaw_checks"] += 1
                        if a != b:
                            xc["grid_yaw_disagree"] += 1
                            xc_list.append(f"{p.name} {entry}->{st} ({x:.0f},{z:.0f}) r{y:03d}: grid "
                                           f"{'valid' if a else first_reason(sd['sites'][st][yi2, py, px])}, in game "
                                           f"{'valid' if b else r['reason']} (gap {float(r['gap']):.1f} m, depth "
                                           f"{float(r['overlap_depth']):.1f} m, nav {r['nav_ok']}/8)")
                    cur = v.get("current")
                    if cur:
                        a, b = bool(code & 1), ingame_valid(cur)
                        xc["today_checks"] += 1
                        if not exact:
                            xc["today_checks_non90"] += 1
                        if a != b:
                            xc["today_disagree" if exact else "today_disagree_non90"] += 1
                        dyaw = abs(float(cur["yaw"]) - yaw) % 360
                        if min(dyaw, 360 - dyaw) > 0.5:
                            xc["yaw_resolution_mismatch"] += 1
            own = today[entry]
            row["valid_today"] = all(today[s][2] & 1 for s in structs)
            row["why_today"] = "; ".join(f"{s}: {first_reason(today[s][2])}" for s in structs if not today[s][2] & 1)
            if row["valid_today"]:
                row["tier"] = 1
            else:
                ys_ = best_yaw(sd, structs, px, py, own[0]) if inside else []
                if ys_:
                    row.update(tier=2, fix_rot=ys_[0][0], fix_margin=ys_[0][1], fix_x=x, fix_z=z, fix_d=0)
                else:
                    nf = nearest_fix(sd, structs, x, z, own[0], FIX_MAX_M)
                    if nf:
                        row.update(tier=3, fix_rot=nf["rot"], fix_margin=nf["margin"], fix_x=nf["x"], fix_z=nf["z"], fix_d=nf["d"])
                    else:
                        row["tier"] = 4
                        far = nearest_fix(sd, structs, x, z, own[0], 600.0)
                        if far:
                            row.update(fix_rot=far["rot"], fix_x=far["x"], fix_z=far["z"], fix_d=far["d"])
            o = openness(sd, entry, x, z)
            if o:
                row.update(open_raw=o["raw"], open_reach=o["reach"], open_cells=o["cells"])
            row["low_open"] = is_low(row)
            pts = [q for q in sd["meta"].get("start_points", []) if q["team"] == entry]
            if pts:
                q = min(pts, key=lambda q: (q["x"] - x) ** 2 + (q["z"] - z) ** 2)
                d0 = math.hypot(q["x"] - x, q["z"] - z)
                if d0 <= 30.0:
                    row.update(near_vanilla=q["name"], near_vanilla_d=round(d0))
            out.append(row)
    xc = dict(xc)
    xc["examples"] = xc_list
    return out, xc


COLS = ["map", "file", "inactive", "folder", "modes", "swap", "entry", "structures", "x", "z", "on_grid",
        "yaw_Sol", "yaw_src_Sol", "yaw_exact_Sol", "code_Sol", "reason_Sol", "valid_yaws_Sol", "legacy_yaws_Sol",
        "yaw_Cent", "yaw_src_Cent", "yaw_exact_Cent", "code_Cent", "reason_Cent", "valid_yaws_Cent", "legacy_yaws_Cent",
        "yaw_Alien", "yaw_src_Alien", "yaw_exact_Alien", "code_Alien", "reason_Alien", "valid_yaws_Alien", "legacy_yaws_Alien",
        "valid_today", "why_today", "tier", "fix_rot", "fix_x", "fix_z", "fix_d", "fix_margin",
        "open_raw", "open_reach", "open_cells", "low_open", "near_vanilla", "near_vanilla_d"]


# ------------------------------------------------------------------ reports

def ground_question(rows):
    """Structure placements failing on ground at today's yaw."""
    res = defaultdict(int)
    for r in rows:
        for st in r["structures"].split("+"):
            c = r.get(f"code_{st}")
            if c is None or first_reason(c) not in ("ground_terrain", "ground_static"):
                continue
            res["n"] += 1
            res["valid_other_yaw" if r.get(f"valid_yaws_{st}", "-") != "-" else "valid_no_yaw"] += 1
            res["legacy_mask_some_yaw" if r.get(f"legacy_yaws_{st}", "-") != "-" else "legacy_mask_no_yaw"] += 1
            res["game_rule_today"] += 1 if c & 0x20 else 0
            res["legacy_today"] += 1 if c & 0x10 else 0
            if not r.get(f"yaw_exact_{st}", True):
                res["non90_today"] += 1
    return res


def md_summary(rows, maps, xcs, notes):
    L = ["# Base site audit of the live layouts (offline, from data/sites)", ""] + notes + [""]
    L.append("One row per base = layout x spawn entry. A swappable Sol/Cent spot (swap_spawns not false, hvh, "
             "hvhva or 2v1) and a position that is both Sol[0] and Cent[0] (hva) must suit both HQs. Tiers: 1 valid as is at today's yaw; 2 same x/z, another of the four "
             "yaws (fix = set `rot`); 3 nearest valid cell within 120 m (fix = move + `rot`); 4 nothing within "
             f"120 m. Low open: open_reach below {LOW_OPEN_REACH['HQ']:.2f} (HQ) / {LOW_OPEN_REACH['Alien']:.2f} (Nest).")
    L.append("")
    L.append("| Map | layouts (inactive) | bases | tier 1 | tier 2 | tier 3 <=30 / <=60 / <=120 m | tier 4 | low open | today's yaw not a multiple of 90 |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    T = defaultdict(int)
    for m in maps:
        rs = [r for r in rows if r["map"] == m]
        if not rs:
            continue
        files = {(r["folder"], r["file"]) for r in rs}
        inact = {(r["folder"], r["file"]) for r in rs if r["inactive"]}
        t = defaultdict(int)
        for r in rs:
            t[r["tier"]] += 1
            if r["tier"] == 3:
                t["3a" if r["fix_d"] <= 30 else "3b" if r["fix_d"] <= 60 else "3c"] += 1
        low = sum(1 for r in rs if r["low_open"])
        non90 = sum(1 for r in rs if any(r.get(f"yaw_exact_{s}") is False for s in r["structures"].split("+")))
        L.append(f"| {m} | {len(files)} ({len(inact)}) | {len(rs)} | {t[1]} | {t[2]} | {t['3a']} / {t['3b']} / {t['3c']} | {t[4]} | {low} | {non90} |")
        for k, v in (("files", len(files)), ("inact", len(inact)), ("bases", len(rs)), (1, t[1]), (2, t[2]), ("3a", t["3a"]),
                     ("3b", t["3b"]), ("3c", t["3c"]), (4, t[4]), ("low", low), ("non90", non90)):
            T[k] += v
    L.append(f"| **all** | {T['files']} ({T['inact']}) | {T['bases']} | {T[1]} | {T[2]} | {T['3a']} / {T['3b']} / {T['3c']} | {T[4]} | {T['low']} | {T['non90']} |")
    L.append("")
    gq = ground_question(rows)
    L += ["## Ground failures at today's yaw", "",
          f"{gq['n']} structure placements fail the ground test at today's yaw (foundation gap > 8 m). "
          f"{gq['valid_other_yaw']} are fully valid at another of the four yaws, {gq['valid_no_yaw']} at none. "
          f"The old terrain-only mask rule (gap <= 0, what the tool's hq masks encode) holds at some yaw for "
          f"{gq['legacy_mask_some_yaw']} of them and at none for {gq['legacy_mask_no_yaw']}; at today's yaw it holds for "
          f"{gq['legacy_today']}, the exact game rule for {gq['game_rule_today']}. {gq['non90_today']} of them have a "
          "today's yaw that is not a multiple of 90 (rounded for the lookup).", ""]
    L += ["## Grid data vs the in-game test of the same bases", ""]
    for m in maps:
        x = xcs.get(m, {})
        if not x or x.get("missing"):
            continue
        L.append(f"- {m}: four-yaw lookups {x.get('grid_yaw_checks', 0)}, disagree {x.get('grid_yaw_disagree', 0)}; "
                 f"today's yaw {x.get('today_checks', 0)} ({x.get('today_checks_non90', 0)} rounded from a non-90 yaw), "
                 f"disagree {x.get('today_disagree', 0)} at exact yaws and {x.get('today_disagree_non90', 0)} at rounded ones; "
                 f"offline yaw resolution differs from the mod's in {x.get('yaw_resolution_mismatch', 0)}")
        for ex in x.get("examples", [])[:5]:
            L.append(f"  - {ex}")
    L.append("")
    for m in maps:
        rs = [r for r in rows if r["map"] == m]
        if not rs:
            continue
        L += [f"## {m}", ""]
        bad = sorted([r for r in rs if r["tier"] > 1 or r["low_open"]],
                     key=lambda r: (-r["tier"], r.get("open_reach") if r.get("open_reach") is not None else 1))
        if not bad:
            L += ["All bases valid at today's yaw with enough open ground.", ""]
            continue
        L.append("| layout | base | pos | yaw today | why | tier | fix | open raw / reach |")
        L.append("|---|---|---|---|---|---|---|---|")
        for r in bad[:30]:
            fix = ""
            if r["tier"] == 2:
                fix = f"rot {r['fix_rot']}"
            elif r.get("fix_d") is not None:
                fix = f"{r['fix_d']} m to ({r['fix_x']:.0f},{r['fix_z']:.0f}) rot {r['fix_rot']}"
            yaws = "/".join(f"{r.get('yaw_' + s, 0):.0f}" for s in r["structures"].split("+"))
            L.append(f"| {('~' + r['folder'] + '/') if r['inactive'] else ''}{r['file']} | {r['structures']} | ({r['x']:.0f},{r['z']:.0f}) | {yaws} | "
                     f"{r['why_today'] or '-'} | {r['tier']} | {fix} | {r.get('open_raw', '')} / {r.get('open_reach', '')}{' LOW' if r['low_open'] else ''} |")
        if len(bad) > 30:
            L.append(f"| ... {len(bad) - 30} more in site_audit.csv | | | | | | | |")
        L.append("")
    return "\n".join(L) + "\n"


def calibration_md(data_dir, maps):
    L = ["# Calibration: vanilla start points (from data/sites, offline)", "",
         "Every vanilla start point of each team at its own yaw (`site_meta.start_points`), looked up in the site "
         "layers (yaws that are not a multiple of 90 rounded). Sol and Centauri share the human points on most "
         "maps, so each human point appears once per HQ.", "",
         "| Map | Sol HQ valid | Cent HQ valid | Nest valid | open_reach HQ min / median | open_reach Nest min / median |",
         "|---|---|---|---|---|---|"]
    tot = defaultdict(lambda: [0, 0])
    allopen = defaultdict(list)
    exc = []
    for m in maps:
        sd = load_site_data(data_dir, m)
        if sd is None:
            continue
        cnt = defaultdict(lambda: [0, 0])
        op = defaultdict(list)
        for p in sd["meta"].get("start_points", []):
            st = p["team"]
            px, py = cell(sd["g"], p["x"], p["z"])
            c = int(sd["sites"][st][yaw_index(p["yaw"]), py, px])
            ok = bool(c & 1)
            cnt[st][0] += ok
            cnt[st][1] += 1
            tot[st][0] += ok
            tot[st][1] += 1
            if not ok:
                exc.append(f"| {m} | {st} | {p['name']} ({p['x']:.0f},{p['z']:.0f}) yaw {p['yaw']:.0f} | {first_reason(c)} |")
            o = openness(sd, st, p["x"], p["z"])
            if o:
                cls = "Alien" if st == "Alien" else "HQ"
                op[cls].append(o["reach"])
                allopen[cls].append((o["reach"], m, p["name"]))
        c = lambda t: f"{cnt[t][0]}/{cnt[t][1]}" if cnt[t][1] else "-"
        q = lambda a: f"{min(a):.2f} / {float(np.median(a)):.2f}" if a else "-"
        L.append(f"| {m} | {c('Sol')} | {c('Cent')} | {c('Alien')} | {q(op['HQ'])} | {q(op['Alien'])} |")
    L.append(f"| **all** | {tot['Sol'][0]}/{tot['Sol'][1]} | {tot['Cent'][0]}/{tot['Cent'][1]} | {tot['Alien'][0]}/{tot['Alien'][1]} | | |")
    L.append("")
    for cls in ("HQ", "Alien"):
        a = sorted(v[0] for v in allopen[cls])
        if a:
            pc = lambda p: a[min(len(a) - 1, int(p * (len(a) - 1)))]
            L.append(f"open_reach of vanilla {'HQ' if cls == 'HQ' else 'Nest'} placements: n={len(a)}, min {a[0]:.2f}, "
                     f"p5 {pc(.05):.2f}, p10 {pc(.10):.2f}, median {pc(.5):.2f}. Lowest: " +
                     ", ".join(f"{m} {n} {v:.2f}" for v, m, n in sorted(allopen[cls])[:6]))
            L.append("")
    L.append(f"Low-openness flag: open_reach < {LOW_OPEN_REACH['HQ']:.2f} (HQ) / {LOW_OPEN_REACH['Alien']:.2f} (Nest).")
    L += ["", "## Vanilla placements the site layers reject", "", "| Map | team | point | reason |", "|---|---|---|---|"] + exc
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layouts", required=True)
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--maps", nargs="*")
    ap.add_argument("--ingame", help="dir with the mod's site_layouts_<Map>_*.csv (optional cross-check)")
    a = ap.parse_args()
    maps = a.maps or sorted(d.name for d in Path(a.layouts).iterdir() if d.is_dir())
    rows, xcs, notes = [], {}, ["Sources: data/sites (site layers + meta); layouts from " + str(a.layouts)]
    for m in maps:
        rs, xc = audit_map(m, a.layouts, a.data, a.ingame)
        rows += rs
        xcs[m] = xc
        if xc.get("missing"):
            notes.append(f"- {m}: NO site data, not audited")
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "site_audit.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
    with open(os.path.join(a.out, "site_audit.json"), "w", encoding="utf-8") as f:
        json.dump({"rows": rows, "crosscheck": xcs}, f, indent=1)
    with open(os.path.join(a.out, "summary.md"), "w", encoding="utf-8") as f:
        f.write(md_summary(rows, maps, xcs, notes))
    with open(os.path.join(a.out, "calibration.md"), "w", encoding="utf-8") as f:
        f.write(calibration_md(a.data, maps))
    print(f"{len(rows)} bases -> {a.out}")


if __name__ == "__main__":
    main()
