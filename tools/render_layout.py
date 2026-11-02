#!/usr/bin/env python3
"""Render a spawn/resource layout JSON (tool export or generator output) to a PNG.

    python tools/render_layout.py <layout.json | dir> [...] [--size 2048] [--out-dir DIR] [--jobs N]

A directory is searched recursively for *.json (index.json is skipped). The PNG is written next to
the JSON (same stem) unless --out-dir is given.

Map image data/maps/<Map>.jpg covers [-extent, extent] in x and z (js/app.js imageOverlay bounds),
north (+z) up: px = (x + E) / 2E * S, py = (E - z) / 2E * S. Patches from
data/resources/<Map>.json (base map via js/map_config.js `base_map`).

Drawn: kept Balterium = orange rectangles (world_w x world_h, min 7 px), kept Biotics = green dots,
removed patches faint grey, start-kit patches (kept Balterium within the build radius of a human
start, kept Biotics within the Nest radius; placeability-ineligible Balterium excluded, as the
generator counts them) white outline, ineligible Balterium red cross, Sol HQ red / Cent HQ blue
with the build radius (solid) and the chain range (dashed), Nest purple with its radius. A side
panel lists the parameters (_meta.batch / _meta.generator when present).
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
PANEL_W = 600

COL = {
    'balt': (255, 150, 30, 255), 'bio': (70, 220, 90, 255), 'removed': (190, 190, 190, 90),
    'kit': (255, 255, 255, 255), 'inel': (255, 40, 40, 255),
    'Sol': (235, 50, 50, 255), 'Cent': (60, 120, 255, 255), 'Alien': (190, 80, 230, 255),
    'hva': (235, 50, 50, 255),
}


def font(size, bold=False):
    for name in (('arialbd.ttf', 'DejaVuSans-Bold.ttf') if bold else ('arial.ttf', 'DejaVuSans.ttf')):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def base_map_of(map_name):
    """`base_map` of a variant from js/map_config.js, else the map itself."""
    src = (ROOT / 'js' / 'map_config.js').read_text(encoding='utf8', errors='replace')
    m = re.search(r'"%s"\s*:\s*\{(.*?)\n  \}' % re.escape(map_name), src, re.S)
    if m:
        b = re.search(r'"base_map"\s*:\s*"([^"]+)"', m.group(1))
        if b:
            return b.group(1)
    return map_name


def dashed_circle(draw, cx, cy, r, color, width, dash_deg=None):
    n = max(24, int(2 * math.pi * r / 18))   # ~18 px per dash+gap
    step = 360.0 / n
    for i in range(n):
        a0 = i * step
        draw.arc([cx - r, cy - r, cx + r, cy + r], a0, a0 + step * 0.55, fill=color, width=width)


def fmt_amt(v):
    return f'{v / 1000:.1f}k' if v % 1000 else f'{v // 1000}k'


def render(path, size=2048, out_dir=None):
    L = json.loads(Path(path).read_text(encoding='utf8'))
    map_name = L['map']
    base = base_map_of(map_name)
    res = json.loads((DATA / 'resources' / f'{base}.json').read_text(encoding='utf8'))
    E = float(res.get('extent') or 0)
    if not E:
        raise SystemExit(f'{path}: no extent for {map_name}')
    S = size
    to_px = lambda x, z: ((x + E) / (2 * E) * S, (E - z) / (2 * E) * S)
    m_px = S / (2 * E)

    img = Image.open(DATA / 'maps' / f'{base}.jpg').convert('RGB').resize((S, S), Image.LANCZOS)
    img = Image.blend(img, Image.new('RGB', img.size, (0, 0, 0)), 0.30).convert('RGBA')
    ov = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    st = L.get('settings') or {}
    Rb = st.get('solBuildRadius', 1000)
    Rc = st.get('solChainRange', 2500)
    Rn = st.get('alienBuildRadius', 1200)
    sp = L.get('spawns') or {}
    gm = L.get('game_modes') or {}
    mode = next((m for m in ('hvh', 'hva', 'hvhva', '4way') if gm.get(m)), '?')
    gen = (L.get('_meta') or {}).get('generator') or {}
    batch = (L.get('_meta') or {}).get('batch') or {}
    pl = gen.get('placeability') or {}
    inel = set(pl.get('ineligible') or []) if pl.get('enabled') else set()
    removed = set((L.get('resources') or {}).get('removed_patches') or [])

    first = lambda f: (sp.get(f) or [None])[0]
    sol, cent, alien = first('Sol'), first('Cent'), first('Alien')
    humans = []
    if sol:
        humans.append(('Sol', sol))
    if cent and mode != 'hva' and not (sol and sol['x'] == cent['x'] and sol['z'] == cent['z']):
        humans.append(('Cent', cent))

    patches = [p for p in res['resources'] if p.get('active', True) and p['type'] in ('Balterium', 'Biotics')]
    kept = [p for p in patches if p['idx'] not in removed]
    kit_ids = set()
    for _, h in humans:
        for p in kept:
            if p['type'] == 'Balterium' and p['idx'] not in inel and math.hypot(p['x'] - h['x'], p['z'] - h['z']) <= Rb:
                kit_ids.add(p['idx'])
    if alien and mode != 'hvh':
        for p in kept:
            if p['type'] == 'Biotics' and math.hypot(p['x'] - alien['x'], p['z'] - alien['z']) <= Rn:
                kit_ids.add(p['idx'])

    # radii first (under the patches). ImageDraw on RGBA replaces pixels instead of blending, so
    # every translucent fill goes down before any outline, or a later fill would erase a ring
    def circle_px(c, R):
        cx, cy = to_px(c['x'], c['z'])
        r = R * m_px
        return cx, cy, r
    rings = [(h, Rb, COL[f]) for f, h in humans]
    if alien and mode != 'hvh':
        rings.append((alien, Rn, COL['Alien']))
    for c, R, color in rings:
        cx, cy, r = circle_px(c, R)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color[:3] + (28,))
    for f, h in humans:
        cx, cy, r = circle_px(h, Rc)
        dashed_circle(d, cx, cy, r, COL[f][:3] + (220,), 4)
    for c, R, color in rings:
        cx, cy, r = circle_px(c, R)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=4)

    # patches: removed, then kept
    def rect(p):
        cx, cy = to_px(p['x'], p['z'])
        hw = max(3.5, p.get('world_w', 40) * m_px / 2)
        hh = max(3.5, p.get('world_h', 40) * m_px / 2)
        return cx, cy, hw, hh
    for p in patches:
        if p['idx'] not in removed:
            continue
        cx, cy, hw, hh = rect(p)
        if p['type'] == 'Balterium':
            d.rectangle([cx - hw, cy - hh, cx + hw, cy + hh], outline=COL['removed'], width=2)
        else:
            r = max(4, hw)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=COL['removed'], width=2)
    for p in kept:
        cx, cy, hw, hh = rect(p)
        is_kit = p['idx'] in kit_ids
        if p['type'] == 'Balterium':
            d.rectangle([cx - hw, cy - hh, cx + hw, cy + hh], fill=COL['balt'],
                        outline=COL['kit'] if is_kit else (60, 30, 0, 255), width=3 if is_kit else 1)
            if p['idx'] in inel:
                k = hw + 4
                d.line([cx - k, cy - k, cx + k, cy + k], fill=COL['inel'], width=3)
                d.line([cx - k, cy + k, cx + k, cy - k], fill=COL['inel'], width=3)
        else:
            r = max(5, hw * 0.9)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=COL['bio'],
                      outline=COL['kit'] if is_kit else (0, 50, 0, 255), width=3 if is_kit else 1)

    # start markers
    lab = font(26, bold=True)
    def marker(c, color, text):
        cx, cy = to_px(c['x'], c['z'])
        r = 15
        d.rectangle([cx - r, cy - r, cx + r, cy + r], fill=color, outline=(255, 255, 255, 255), width=3)
        d.text((cx + r + 6, cy - r - 4), text, font=lab, fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))
    for f, h in humans:
        marker(h, COL[f], 'Sol + Cent' if mode == 'hva' else f)
    if alien and mode != 'hvh':
        cx, cy = to_px(alien['x'], alien['z'])
        r = 17
        d.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=COL['Alien'], outline=(255, 255, 255, 255))
        d.text((cx + r + 6, cy - r - 4), 'Nest', font=lab, fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))

    img = Image.alpha_composite(img, ov)

    # side panel
    canvas = Image.new('RGBA', (S + PANEL_W, S), (24, 24, 28, 255))
    canvas.paste(img, (0, 0))
    pd = ImageDraw.Draw(canvas)
    x0, y = S + 30, 30
    f_t, f_h, f_b = font(40, True), font(28, True), font(25)
    pd.text((x0, y), map_name, font=f_t, fill=(255, 255, 255)); y += 54
    pd.text((x0, y), f'mode {mode}' + (f'   variant {batch["variant"]}' if batch.get('variant') else ''), font=f_h, fill=(230, 230, 230)); y += 48

    ra = (L.get('resources') or {})
    amt_b, amt_o = ra.get('balterium_amount', 0), ra.get('biotics_amount', 0)
    n_b = sum(1 for p in kept if p['type'] == 'Balterium')
    n_o = sum(1 for p in kept if p['type'] == 'Biotics')
    v_b = sum(1 for p in patches if p['type'] == 'Balterium')
    v_o = sum(1 for p in patches if p['type'] == 'Biotics')
    s_gen = gen.get('settings') or {}
    req = batch.get('requested') or {}
    ach = batch.get('achieved') or {}
    dist = (gen.get('metrics') or {}).get('distances') or {}
    pairs = {'hvh': ['Sol-Cent'], 'hva': ['Sol-Alien'], 'hvhva': ['Sol-Cent', 'Sol-Alien', 'Cent-Alien']}.get(mode, [])
    kit_h = [sum(1 for p in kept if p['idx'] in kit_ids and p['type'] == 'Balterium' and math.hypot(p['x'] - h['x'], p['z'] - h['z']) <= Rb) for _, h in humans]
    kit_n = sum(1 for p in kept if p['idx'] in kit_ids and p['type'] == 'Biotics') if alien and mode != 'hvh' else None

    lines = []
    d_used = s_gen.get('enemyDistance')
    if d_used is not None:
        rq = req.get('enemyDistance')
        lines.append(f'd* {d_used:.0f} m' + (f' (requested {rq})' if rq and rq != d_used else ''))
    for pk in pairs:
        if pk in dist:
            lines.append(f'  {pk}: {dist[pk]:.0f} m')
    kh = s_gen.get('kitExact')
    lines.append(f'start kit Balterium: {kh if kh is not None else "auto"}' + (f'  (drawn {"/".join(map(str, kit_h))})' if kit_h else ''))
    if mode != 'hvh':
        kn = s_gen.get('nestKitExact')
        lines.append(f'Nest kit Biotics: {kn if kn is not None else "auto"}' + (f'  (drawn {kit_n})' if kit_n is not None else ''))
    lines.append('')
    lines.append(f'Balterium {n_b}/{v_b} x {fmt_amt(amt_b)} = {n_b * amt_b / 1e6:.2f}M')
    lines.append(f'Biotics   {n_o}/{v_o} x {fmt_amt(amt_o)} = {n_o * amt_o / 1e6:.2f}M')
    if req.get('totals'):
        t = req['totals']
        lines.append(f'  requested {t["balterium"] / 1e6:.2f}M / {t["biotics"] / 1e6:.2f}M')
    lines.append('')
    if gen:
        lines.append(f'seed {gen.get("seed")}   rank {gen.get("rank")}   score {gen.get("score")}')
        if batch.get('fair') is not None:
            fr = f'  (rank {batch["fairRank"]}/{batch["fairOf"]} in {map_name} {mode})' if batch.get('fairRank') else ''
            lines.append(f'fair score {batch["fair"]:.2f}{fr}')
        terms = gen.get('terms') or {}
        if terms:
            tl = '  '.join(f'{k} {v:.2f}' for k, v in terms.items() if isinstance(v, (int, float)))
            lines.append(tl[:44])
            if len(tl) > 44:
                lines.append(tl[44:88].strip())
        gf = gen.get('gateFails') or []
        lines.append(f'gates: {"all pass" if not gf else ", ".join(gf)}')
        if pl.get('enabled'):
            lines.append(f'placeability minGood {pl.get("minGood")}, ineligible {len(inel)}')
    lines.append(f'swap Sol/Cent: {"on" if L.get("swap_spawns", True) else "off"}')
    fb = batch.get('fallbacks') or []
    for ln in lines:
        pd.text((x0, y), ln, font=f_b, fill=(225, 225, 225)); y += 34
    if fb:
        y += 6
        pd.text((x0, y), 'fallbacks:', font=f_b, fill=(255, 200, 120)); y += 32
        small = font(20)
        for f in fb[:8]:
            words, cur = f.split(' '), ''
            for w in words:
                if len(cur) + len(w) > 46:
                    pd.text((x0 + 10, y), cur, font=small, fill=(220, 190, 150)); y += 25; cur = ''
                cur = (cur + ' ' + w).strip()
            if cur:
                pd.text((x0 + 10, y), cur, font=small, fill=(220, 190, 150)); y += 25

    # legend
    y = max(y + 30, S - 420)
    pd.text((x0, y), 'Legend', font=f_h, fill=(255, 255, 255)); y += 42
    def leg(draw_fn, text):
        nonlocal y
        draw_fn(x0 + 18, y + 14)
        pd.text((x0 + 50, y), text, font=f_b, fill=(225, 225, 225)); y += 38
    leg(lambda cx, cy: pd.rectangle([cx - 10, cy - 10, cx + 10, cy + 10], fill=COL['balt']), 'Balterium kept')
    leg(lambda cx, cy: pd.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=COL['bio']), 'Biotics kept')
    leg(lambda cx, cy: pd.rectangle([cx - 10, cy - 10, cx + 10, cy + 10], outline=(150, 150, 150), width=2), 'removed patch')
    leg(lambda cx, cy: pd.rectangle([cx - 10, cy - 10, cx + 10, cy + 10], fill=COL['balt'], outline=(255, 255, 255), width=3), 'start-kit patch')
    leg(lambda cx, cy: (pd.line([cx - 10, cy - 10, cx + 10, cy + 10], fill=COL['inel'], width=3), pd.line([cx - 10, cy + 10, cx + 10, cy - 10], fill=COL['inel'], width=3)), 'Balterium not placeable')
    leg(lambda cx, cy: pd.rectangle([cx - 10, cy - 10, cx + 10, cy + 10], fill=COL['Sol']), f'Sol HQ ({Rb} m solid, {Rc} m dashed)')
    leg(lambda cx, cy: pd.rectangle([cx - 10, cy - 10, cx + 10, cy + 10], fill=COL['Cent']), 'Cent HQ')
    leg(lambda cx, cy: pd.polygon([(cx, cy - 11), (cx + 11, cy), (cx, cy + 11), (cx - 11, cy)], fill=COL['Alien']), f'Alien Nest ({Rn} m)')
    pd.text((x0, S - 40), Path(path).name, font=font(18), fill=(160, 160, 160))

    out = (Path(out_dir) / (Path(path).stem + '.png')) if out_dir else Path(path).with_suffix('.png')
    # 256-colour palette: ~4x smaller than RGB at no visible loss for an overview plot
    canvas.convert('RGB').quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(out, optimize=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--size', type=int, default=2048)
    ap.add_argument('--out-dir')
    ap.add_argument('--jobs', type=int, default=1, help='parallel worker processes')
    a = ap.parse_args()
    files = []
    for p in map(Path, a.paths):
        if p.is_dir():
            files += sorted(f for f in p.rglob('*.json') if f.name != 'index.json')
        else:
            files.append(p)
    if a.jobs > 1 and len(files) > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(a.jobs) as ex:
            for out in ex.map(render, files, [a.size] * len(files), [a.out_dir] * len(files)):
                print(out)
    else:
        for f in files:
            print(render(f, a.size, a.out_dir))
    print(f'{len(files)} PNG(s)', file=sys.stderr)


if __name__ == '__main__':
    main()
