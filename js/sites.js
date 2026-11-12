// Base sites: where a Sol HQ, a Centauri HQ or an Alien Nest can stand, at which rotation, and
// how much open ground surrounds it (docs/SITE_SCAN.md is the contract). UMD, DOM-free core, the
// one implementation of the rules for the browser UI, the Spawn Generator and the Node tools
// (tools/site_fix.js, tools/site_selftest.js). tools/site_audit.py is the Python reference.
//
//   load(mapName, io?)            -> Promise<SiteData|null>  (io: {readBytes, readJson, inflate};
//                                    browser default fetches data/sites/ and inflates with
//                                    DecompressionStream, so the bytes never pass a canvas)
//   loadSync(mapName, nodeIO(dir)) -> SiteData|null           (Node, synchronous)
//   fromLayers(meta, layers)      -> SiteData                (already-decoded byte arrays)
//   decodePng(bytes, inflate)     -> Promise<{width, height, channels, data}>
//   cell / world / inside / codeAt / validAt
//   structuresOf(layout, entry, rules?) -> ['Sol'] | ['Sol', 'Cent'] | ['Alien'] ...
//   todayYaw(sd, team, x, z, rot) -> {yaw, src, point}       (SITE_SCAN.md section 8)
//   bestYaws(sd, structs, px, py, preferYaw) -> [{rot, margin}] best first
//   nearestFix(sd, structs, x, z, preferYaw, maxD) -> {x, z, d, rot, margin} | null
//   checkBase(sd, structs, x, z, rot) -> {validToday, today[], why, tier, fix}
//   openness(sd, entry, x, z)     -> {raw, reach, cells} | null   (section 7)
//   auditLayout(sd, layout, rules?) -> rows (one per spawns.<Sol|Cent|Alien>[0])
//   kitChange(resources, layout, structs, x0, z0, x1, z1) -> {changed, details} (does a move change
//                                    the patches inside the base's build radius?)
//   reasonText(code, struct), fixText(fix, todayYaw)
//
// Grid: cell (px, py) is world x = scan_min_x + px*step, z = scan_max_z - py*step (row 0 = north),
// index py*w + px, same as js/terrain.js and the masks.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sites = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = ['Sol', 'Cent', 'Alien'];
  const YAWS = [0, 90, 180, 270];
  const REASONS = ['ok', 'offmap', 'ground_terrain', 'ground_static', 'on_static', 'overlap', 'navmesh', 'no_data'];
  const ANNULUS = [60, 250];          // Si_StarterUnits min_radius_m .. max_radius_m
  const STEP_LIMIT = 25;              // Si_StarterUnits max_step_from_base_m
  const SEED_BAND = [40, 95];         // flood-fill seeds: standable cells just outside the footprint
  const LOW_OPEN_REACH = { HQ: 0.50, Alien: 0.25 };
  const FIX_MAX_M = 120;              // tier 3 search radius (user decision 2026-11-12)
  const FAR_MAX_M = 600;              // tier 4: nearest valid cell reported for information only
  const OFFMAP_CODE = 1 << 1;         // reason 1, all other bits 0

  // Default rules = SITE_SCAN.md section 8 as written: a Sol/Cent spot must suit both HQs when the
  // layout can swap (hvh / hvhva, and 2v1 layouts, which run in hvhva rounds) or when one position
  // is in both Sol[0] and Cent[0] (hva). {swap2v1: false, sharedSpot: false} = the rules of the first
  // site_audit.py (2026-11-12 20:29 output), kept only to reproduce that CSV.
  const DEFAULT_RULES = { swap2v1: true, sharedSpot: true };

  const NAMES = { Sol: 'Sol HQ', Cent: 'Centauri HQ', Alien: 'Nest' };

  // ── small numeric helpers (Python semantics where the reference relies on them) ──

  /** Python round(): half to even. */
  function roundHalfEven(v) {
    const f = Math.floor(v), d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  /** a / b rounded to 3 decimals exactly as Python round(a / b, 3) (a, b whole numbers, b > 0). */
  function ratio3(a, b) {
    const n = a * 1000, q = Math.floor(n / b), r = n - q * b;
    let k = q;
    if (2 * r > b) k = q + 1;
    else if (2 * r === b) k = q % 2 === 0 ? q : q + 1;
    return k / 1000;
  }
  function mod360(v) { const m = v % 360; return m < 0 ? m + 360 : (m === 0 ? 0 : m); }
  function yawIndex(yaw) { return roundHalfEven(mod360(yaw) / 90) % 4; }
  function yawDist(a, b) { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); }

  // ── PNG decoding (8-bit, non-interlaced; what preprocess.py writes) ──

  function u32(b, i) { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }

  /** IHDR fields and the concatenated IDAT data. */
  function parsePng(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error('not a PNG');
    let i = 8, info = null;
    const parts = [];
    let total = 0;
    while (i + 8 <= b.length) {
      const n = u32(b, i), type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      const d = b.subarray(i + 8, i + 8 + n);
      if (type === 'IHDR') {
        info = { width: u32(d, 0), height: u32(d, 4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
      } else if (type === 'IDAT') { parts.push(d); total += n; } else if (type === 'IEND') break;
      i += 12 + n;
    }
    if (!info) throw new Error('PNG without IHDR');
    const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[info.colorType];
    if (info.bitDepth !== 8 || !ch || info.interlace !== 0) {
      throw new Error(`unsupported PNG (bit depth ${info.bitDepth}, colour type ${info.colorType}, interlace ${info.interlace})`);
    }
    info.channels = ch;
    const idat = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { idat.set(p, o); o += p.length; }
    info.idat = idat;
    return info;
  }

  /** Reverse the PNG row filters: inflated scanlines -> width*height*channels bytes. */
  function unfilter(info, raw) {
    const w = info.width, h = info.height, bpp = info.channels, stride = w * bpp;
    if (raw.length < h * (stride + 1)) throw new Error(`PNG data too short (${raw.length} < ${h * (stride + 1)})`);
    const out = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
      for (let x = 0; x < stride; x++) {
        const v = raw[src + x];
        const a = x >= bpp ? out[dst + x - bpp] : 0;
        const c = y > 0 && x >= bpp ? out[up + x - bpp] : 0;
        const bb = y > 0 ? out[up + x] : 0;
        let p;
        switch (f) {
          case 0: p = 0; break;
          case 1: p = a; break;
          case 2: p = bb; break;
          case 3: p = (a + bb) >> 1; break;
          case 4: {
            const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
            p = pa <= pb && pa <= pc ? a : (pb <= pc ? bb : c);
            break;
          }
          default: throw new Error(`PNG filter ${f}`);
        }
        out[dst + x] = (v + p) & 255;
      }
    }
    return out;
  }

  /** bytes -> {width, height, channels, data}; inflate(Uint8Array) -> Uint8Array | Promise of it (zlib). */
  async function decodePng(bytes, inflate) {
    const info = parsePng(bytes);
    const raw = await inflate(info.idat);
    return { width: info.width, height: info.height, channels: info.channels, data: unfilter(info, raw) };
  }

  /** zlib inflate with the browser's DecompressionStream (no canvas, so no colour management). */
  async function inflateBrowser(data) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function browserIO(base) {
    const b = base || 'data/sites/';
    return {
      async readBytes(name) {
        const r = await fetch(b + name);
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${name}`);
        return new Uint8Array(await r.arrayBuffer());
      },
      async readJson(name) {
        const r = await fetch(b + name);
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${name}`);
        return r.json();
      },
      inflate: inflateBrowser,
    };
  }

  /** Node only: io over a data/sites directory (fs + zlib, required when called). */
  function nodeIO(dir) {
    /* global require */
    const fs = require('fs'), path = require('path'), zlib = require('zlib');
    return {
      readBytes: n => new Uint8Array(fs.readFileSync(path.join(dir, n))),
      readJson: n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')),
      inflate: d => new Uint8Array(zlib.inflateSync(d)),
    };
  }

  // ── loading ──

  function channel(img, c) {
    const n = img.width * img.height, out = new Uint8Array(n), ch = img.channels;
    for (let i = 0; i < n; i++) out[i] = img.data[i * ch + c];
    return out;
  }

  const cache = new Map();

  /**
   * SiteData of a map (variants: pass the base map's name). Resolves null when the map has no
   * site data (no site_meta_<Map>.json). io defaults to the browser loader (fetch data/sites/).
   * Browser calls are cached per map.
   */
  function load(mapName, io) {
    const useCache = !io;
    if (useCache && cache.has(mapName)) return cache.get(mapName);
    const pr = (async () => {
      const o = io || browserIO();
      let meta;
      try { meta = await o.readJson(`site_meta_${mapName}.json`); } catch (e) { return null; }
      const imgs = {};
      for (const name of fileNames(mapName)) imgs[name] = await decodePng(await o.readBytes(name), o.inflate);
      return fromImages(meta, mapName, imgs);
    })();
    if (useCache) {
      cache.set(mapName, pr);
      pr.catch(() => cache.delete(mapName));
    }
    return pr;
  }

  /** load() for a synchronous io (Node: nodeIO); null when the map has no site data. */
  function loadSync(mapName, io) {
    let meta;
    try { meta = io.readJson(`site_meta_${mapName}.json`); } catch (e) { return null; }
    const imgs = {};
    for (const name of fileNames(mapName)) {
      const info = parsePng(io.readBytes(name));
      imgs[name] = { width: info.width, height: info.height, channels: info.channels, data: unfilter(info, io.inflate(info.idat)) };
    }
    return fromImages(meta, mapName, imgs);
  }

  function siteFile(k, mapName, y) { return `site_${k}_${mapName}_r${String(y).padStart(3, '0')}.png`; }

  function fileNames(mapName) {
    const out = [];
    for (const k of KEYS) for (const y of YAWS) out.push(siteFile(k, mapName, y));
    out.push(`open_${mapName}.png`, `surf_${mapName}.png`);
    return out;
  }

  function fromImages(meta, mapName, imgs) {
    const site = {};
    for (const k of KEYS) site[k] = YAWS.map(y => channel(imgs[siteFile(k, mapName, y)], 0));
    const s = imgs[`surf_${mapName}.png`];
    return fromLayers(meta, { site, open: channel(imgs[`open_${mapName}.png`], 0), surfR: channel(s, 0), surfG: channel(s, 1) });
  }

  /** layers: {site: {Sol|Cent|Alien: [4 x Uint8Array w*h]}, open: Uint8Array, surfR, surfG: Uint8Array}. */
  function fromLayers(meta, layers) {
    const g = meta.grid, w = g.grid_w, h = g.grid_h, n = w * h;
    const code = {}, valid = {}, margin = {};
    for (const k of KEYS) {
      code[k] = layers.site[k];
      valid[k] = code[k].map(a => { const v = new Uint8Array(n); for (let i = 0; i < n; i++) v[i] = a[i] & 1; return v; });
      margin[k] = valid[k].map(v => marginOf(v, w, h));
    }
    const s = meta.surf, surf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = layers.surfR[i] * 256 + layers.surfG[i];
      // same operation order as site_audit.py (numpy float64)
      surf[i] = v > 0 ? s.hmin + (v - 1) / 65534.0 * (s.hmax - s.hmin) : NaN;
    }
    return {
      map: meta.map, meta, w, h, step: g.step, minX: g.scan_min_x, maxZ: g.scan_max_z,
      code, valid, margin, open: layers.open, surf, startPoints: meta.start_points || [],
    };
  }

  /** Number of valid 8-neighbours (outside the grid counts as invalid). */
  function marginOf(v, w, h) {
    const out = new Uint8Array(w * h);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const y = py + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = px + dx;
            if ((dx || dy) && x >= 0 && x < w && v[y * w + x]) m++;
          }
        }
        out[py * w + px] = m;
      }
    }
    return out;
  }

  // ── grid ──

  function cell(sd, x, z) { return [roundHalfEven((x - sd.minX) / sd.step), roundHalfEven((sd.maxZ - z) / sd.step)]; }
  function world(sd, px, py) { return [sd.minX + px * sd.step, sd.maxZ - py * sd.step]; }
  function inside(sd, px, py) { return px >= 0 && px < sd.w && py >= 0 && py < sd.h; }
  function codeAt(sd, s, yi, px, py) { return inside(sd, px, py) ? sd.code[s][yi][py * sd.w + px] : OFFMAP_CODE; }
  function validAt(sd, s, yi, px, py) { return inside(sd, px, py) && sd.valid[s][yi][py * sd.w + px] === 1; }
  function reasonOf(code) { return REASONS[(code >> 1) & 7]; }

  // ── rules ──

  function modesOf(layout) {
    const gm = (layout && layout.game_modes) || {};
    return Object.keys(gm).filter(k => gm[k] === true);
  }

  /** The mod swaps Sol and Cent in 50 % of hvh / hvhva rounds (2v1 rounds are hvhva rounds). */
  function canSwap(layout, rules) {
    const r = Object.assign({}, DEFAULT_RULES, rules);
    if (layout.swap_spawns === false) return false;
    const gm = layout.game_modes;
    if (!gm || Object.keys(gm).length === 0) return true;
    const m = modesOf(layout);
    return m.includes('hvh') || m.includes('hvhva') || (r.swap2v1 && m.includes('2v1'));
  }

  function spawn0(layout, k) {
    const a = layout.spawns && layout.spawns[k];
    return Array.isArray(a) && a.length && a[0] && typeof a[0] === 'object' ? a[0] : null;
  }

  /** Sol[0] and Cent[0] at the same x/z (hva layouts: one human position for either HQ). */
  function sharedSpot(layout) {
    const s = spawn0(layout, 'Sol'), c = spawn0(layout, 'Cent');
    return !!(s && c && Math.abs(num(s.x) - num(c.x)) < 0.5 && Math.abs(num(s.z) - num(c.z)) < 0.5);
  }

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  /** Structures that can stand at spawns.<entry>[0]: the entry's own, plus the other HQ (section 8). */
  function structuresOf(layout, entry, rules) {
    if (entry === 'Alien') return ['Alien'];
    const r = Object.assign({}, DEFAULT_RULES, rules);
    const other = entry === 'Sol' ? 'Cent' : 'Sol';
    if (canSwap(layout, r) || (r.sharedSpot && sharedSpot(layout))) return [entry, other];
    return [entry];
  }

  /** Yaw the mod uses today: rot, else the nearest (2D) vanilla start point of that team. */
  function todayYaw(sd, team, x, z, rot) {
    if (typeof rot === 'number' && Number.isFinite(rot)) return { yaw: mod360(rot), src: 'rot field', point: null };
    let best = null, bd = Infinity;
    for (const p of sd.startPoints) {
      if (p.team !== team) continue;
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return { yaw: 0, src: 'no start points', point: null };
    return { yaw: mod360(best.yaw), src: `start point ${best.name} (${Math.round(Math.sqrt(bd))} m)`, point: best };
  }

  /** Yaws valid for every structure at the cell, best first: margin, then closeness to preferYaw. */
  function bestYaws(sd, structs, px, py, preferYaw) {
    const out = [];
    if (!inside(sd, px, py)) return out;
    const i = py * sd.w + px;
    for (let yi = 0; yi < 4; yi++) {
      if (!structs.every(s => sd.valid[s][yi][i])) continue;
      let m = 0;
      for (const s of structs) m += sd.margin[s][yi][i];
      out.push({ rot: YAWS[yi], margin: m, dy: yawDist(YAWS[yi], preferYaw) });
    }
    out.sort((a, b) => (b.margin - a.margin) || (a.dy - b.dy) || (a.rot - b.rot));
    return out.map(o => ({ rot: o.rot, margin: o.margin }));
  }

  /** Any yaw valid for every structure (Uint8Array over the grid). */
  function anyValidMask(sd, structs) {
    const n = sd.w * sd.h, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      for (let yi = 0; yi < 4; yi++) {
        if (structs.every(s => sd.valid[s][yi][i])) { out[i] = 1; break; }
      }
    }
    return out;
  }

  /** Nearest other cell within maxD with a yaw valid for every structure (first in row order on ties). */
  function nearestFix(sd, structs, x, z, preferYaw, maxD) {
    const [px0, py0] = cell(sd, x, z);
    const r = Math.ceil(maxD / sd.step) + 1;
    const y0 = Math.max(0, py0 - r), y1 = Math.min(sd.h, py0 + r + 1);
    const x0 = Math.max(0, px0 - r), x1 = Math.min(sd.w, px0 + r + 1);
    let best = null, bd = Infinity;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const [wx, wz] = world(sd, px, py);
        const d = Math.hypot(wx - x, wz - z);
        if (d > maxD || d <= 0.5 || d >= bd) continue;
        const i = py * sd.w + px;
        let any = false;
        for (let yi = 0; yi < 4 && !any; yi++) any = structs.every(s => sd.valid[s][yi][i]);
        if (any) { bd = d; best = [px, py]; }
      }
    }
    if (!best) return null;
    const ys = bestYaws(sd, structs, best[0], best[1], preferYaw);
    const [fx, fz] = world(sd, best[0], best[1]);
    return { x: fx, z: fz, d: roundHalfEven(bd), dExact: bd, rot: ys[0].rot, margin: ys[0].margin };
  }

  /**
   * One base: structs[0] is the layout entry, rot the entry's rot (undefined = absent).
   * tier 1 valid as is; 2 another yaw at the same x/z; 3 nearest valid cell within 120 m; 4 none.
   */
  function checkBase(sd, structs, x, z, rot) {
    const [px, py] = cell(sd, x, z);
    const ins = inside(sd, px, py);
    const today = structs.map(st => {
      const t = todayYaw(sd, st, x, z, rot);
      const yi = yawIndex(t.yaw);
      const code = ins ? sd.code[st][yi][py * sd.w + px] : OFFMAP_CODE;
      const exact = yawDist(t.yaw, YAWS[yi]) < 1.0;
      const validYaws = ins ? YAWS.filter((y, k) => sd.valid[st][k][py * sd.w + px]) : [];
      return { struct: st, yaw: t.yaw, src: t.src, point: t.point, yi, code, reason: reasonOf(code), exact, validYaws };
    });
    const res = { structs: structs.slice(), x, z, px, py, inside: ins, today };
    res.validToday = today.every(t => t.code & 1);
    res.why = today.filter(t => !(t.code & 1)).map(t => `${t.struct}: ${t.reason}`).join('; ');
    const pref = today[0].yaw;
    if (res.validToday) { res.tier = 1; res.fix = null; return res; }
    const ys = ins ? bestYaws(sd, structs, px, py, pref) : [];
    if (ys.length) {
      res.tier = 2;
      res.fix = { kind: 'rot', rot: ys[0].rot, margin: ys[0].margin, x, z, d: 0 };
      return res;
    }
    const nf = nearestFix(sd, structs, x, z, pref, FIX_MAX_M);
    if (nf) {
      res.tier = 3;
      res.fix = Object.assign({ kind: 'move' }, nf);
      return res;
    }
    res.tier = 4;
    res.fix = null;
    res.far = nearestFix(sd, structs, x, z, pref, FAR_MAX_M);
    return res;
  }

  /** Validity of one explicit yaw for every structure at x/z: {ok, failing: [{struct, code, reason}]}. */
  function checkYaw(sd, structs, x, z, yaw) {
    const [px, py] = cell(sd, x, z);
    const yi = yawIndex(yaw);
    const failing = [];
    for (const s of structs) {
      const c = codeAt(sd, s, yi, px, py);
      if (!(c & 1)) failing.push({ struct: s, code: c, reason: reasonOf(c) });
    }
    return { ok: failing.length === 0, failing };
  }

  // ── openness (section 7) ──

  function openness(sd, entry, x, z) {
    const bit = entry === 'Alien' ? 2 : 1;
    const [px0, py0] = cell(sd, x, z);
    if (!inside(sd, px0, py0)) return null;
    const r = Math.ceil(ANNULUS[1] / sd.step) + 1;
    const y0 = Math.max(0, py0 - r), y1 = Math.min(sd.h, py0 + r + 1);
    const x0 = Math.max(0, px0 - r), x1 = Math.min(sd.w, px0 + r + 1);
    const ww = x1 - x0, hh = y1 - y0, n = ww * hh;
    const d = new Float64Array(n), sf = new Float64Array(n), op = new Uint8Array(n);
    const near = [];
    for (let a = 0; a < hh; a++) {
      for (let b = 0; b < ww; b++) {
        const k = a * ww + b, i = (y0 + a) * sd.w + (x0 + b);
        const [wx, wz] = world(sd, x0 + b, y0 + a);
        d[k] = Math.hypot(wx - x, wz - z);
        sf[k] = sd.surf[i];
        op[k] = sd.open[i];
        if (d[k] <= 40 && (op[k] & 4) && !(op[k] & 8) && Number.isFinite(sf[k])) near.push(sf[k]);
      }
    }
    let baseY;
    if (near.length) {
      near.sort((p, q) => p - q);
      const m = near.length >> 1;
      baseY = near.length % 2 ? near[m] : (near[m - 1] + near[m]) / 2;
    } else baseY = sd.surf[py0 * sd.w + px0];
    const st = new Uint8Array(n);
    let nAnn = 0, nRaw = 0;
    for (let k = 0; k < n; k++) {
      let s = (op[k] & bit) ? 1 : 0;
      if (s && Number.isFinite(baseY)) s = Number.isFinite(sf[k]) && Math.abs(sf[k] - baseY) <= STEP_LIMIT ? 1 : 0;
      st[k] = s;
      if (d[k] >= ANNULUS[0] && d[k] <= ANNULUS[1] && Number.isFinite(sf[k])) {
        nAnn++;
        if (s) nRaw++;
      }
    }
    if (nAnn === 0) return null;
    const seen = new Uint8Array(n), q = [];
    for (let k = 0; k < n; k++) {
      if (st[k] && d[k] <= ANNULUS[1] && d[k] >= SEED_BAND[0] && d[k] <= SEED_BAND[1]) { seen[k] = 1; q.push(k); }
    }
    for (let h = 0; h < q.length; h++) {
      const a = Math.floor(q[h] / ww), b = q[h] - a * ww;
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          const na = a + da, nb = b + db;
          if (na < 0 || na >= hh || nb < 0 || nb >= ww) continue;
          const k = na * ww + nb;
          if (!seen[k] && st[k] && d[k] <= ANNULUS[1]) { seen[k] = 1; q.push(k); }
        }
      }
    }
    let nReach = 0;
    for (let k = 0; k < n; k++) if (seen[k] && d[k] >= ANNULUS[0] && d[k] <= ANNULUS[1] && Number.isFinite(sf[k])) nReach++;
    return { raw: ratio3(nRaw, nAnn), reach: ratio3(nReach, nAnn), cells: nAnn };
  }

  function lowOpenLimit(entry) { return entry === 'Alien' ? LOW_OPEN_REACH.Alien : LOW_OPEN_REACH.HQ; }
  function isLowOpen(entry, o) { return !!o && o.reach < lowOpenLimit(entry); }

  // ── layouts ──

  /**
   * One row per spawns.<Sol|Cent|Alien>[0] of a layout JSON (what the mod spawns), with
   * structures, today's state, tier, fix and openness. rules: see DEFAULT_RULES.
   */
  function auditLayout(sd, layout, rules) {
    const rows = [];
    for (const entry of KEYS) {
      const e = spawn0(layout, entry);
      if (!e) continue;
      const x = num(e.x), z = num(e.z);
      const rot = typeof e.rot === 'number' && Number.isFinite(e.rot) ? e.rot : undefined;
      const structs = structuresOf(layout, entry, rules);
      const row = checkBase(sd, structs, x, z, rot);
      row.entry = entry;
      row.rot = rot;
      row.open = openness(sd, entry, x, z);
      row.lowOpen = isLowOpen(entry, row.open);
      rows.push(row);
    }
    return rows;
  }

  // ── start kits: does a move change which patches a base reaches? ──

  // Tool defaults when a layout has no settings (index.html sliders)
  const KIT_DEFAULTS = { Sol: 620, Cent: 600, Alien: 150 };
  const NEST_HALF = 25;   // placement.js HALF_DIMS.nest: the balance panel's effective Nest radius

  /**
   * Radii a structure's start kit is counted with, from the layout's settings: humans = Balterium
   * within the build radius (balance panel, gen harness); Nest = Biotics within the build radius
   * (gen harness) and within the effective radius sqrt(R^2 - 25^2) - 25 (balance panel).
   */
  function kitRadii(settings, struct) {
    const s = settings || {};
    if (struct === 'Alien') {
      const R = s.alienBuildRadius ?? s.alienNodeChainRange ?? s.alienChainRange ?? KIT_DEFAULTS.Alien;
      const sq = R * R - NEST_HALF * NEST_HALF;
      return { type: 'Biotics', radii: [{ name: 'build', r: R }, { name: 'effective', r: sq > 0 ? Math.sqrt(sq) - NEST_HALF : 0 }] };
    }
    const R = struct === 'Sol' ? (s.solBuildRadius ?? s.buildRadius ?? KIT_DEFAULTS.Sol) : (s.centBuildRadius ?? s.buildRadius ?? KIT_DEFAULTS.Cent);
    return { type: 'Balterium', radii: [{ name: 'build', r: R }] };
  }

  /** Patch idx of the kept patches (active, not in removed_patches) of a type within r of (x, z). */
  function patchesWithin(resources, removed, type, x, z, r) {
    const list = Array.isArray(resources) ? resources : (resources && resources.resources) || [];
    return list.filter(p => p.type === type && p.active !== false && !removed.has(p.idx) && Math.hypot(p.x - x, p.z - z) <= r)
      .map(p => p.idx).sort((a, b) => a - b);
  }

  /**
   * Kit change of a base moved from (x0, z0) to (x1, z1), for every structure that can stand there
   * (its own radius each): {changed, details: [{struct, type, radius, r, lost: [idx], gained: [idx]}]}.
   */
  function kitChange(resources, layout, structs, x0, z0, x1, z1) {
    const removed = new Set((layout && layout.resources && layout.resources.removed_patches) || []);
    const details = [];
    for (const s of structs) {
      const k = kitRadii(layout && layout.settings, s);
      for (const rr of k.radii) {
        const a = patchesWithin(resources, removed, k.type, x0, z0, rr.r), b = patchesWithin(resources, removed, k.type, x1, z1, rr.r);
        const lost = a.filter(i => !b.includes(i)), gained = b.filter(i => !a.includes(i));
        details.push({ struct: s, type: k.type, radius: rr.name, r: rr.r, before: a.length, after: b.length, lost, gained });
      }
    }
    return { changed: details.some(d => d.lost.length || d.gained.length), details };
  }

  // ── words for layout makers ──

  function reasonText(code, struct) {
    const r = reasonOf(code);
    const unit = struct === 'Alien' ? 'alien units' : 'vehicles';
    switch (r) {
      case 'ok': return 'fits';
      case 'offmap': return 'outside the playable map';
      case 'ground_terrain': return 'ground too steep or uneven: the foundation would hang more than 8 m above the terrain';
      case 'ground_static': return 'rock, a roof or an overhang under or over the base';
      case 'on_static': return 'stands on top of a rock or building';
      case 'overlap': return 'cuts into a cliff, rock or building (more than 3 m deep)';
      case 'navmesh': return `cut off: ${unit} could not get away from the base (not on the main ground network)`;
      case 'no_data': return 'no site data for this structure on this map';
      default: return r;
    }
  }

  /** "rotated to 180" / "moved 15 m to the nearest valid site, rotation 90". */
  function fixText(fix) {
    if (!fix) return 'no valid site within 120 m';
    if (fix.kind === 'rot' || !fix.d) return `rotated to ${fix.rot}°`;
    return `moved ${fix.d} m to the nearest valid site, rotation ${fix.rot}°`;
  }

  return {
    KEYS, YAWS, REASONS, NAMES, ANNULUS, STEP_LIMIT, SEED_BAND, LOW_OPEN_REACH, FIX_MAX_M, FAR_MAX_M, DEFAULT_RULES,
    roundHalfEven, ratio3, mod360, yawIndex, yawDist,
    parsePng, unfilter, decodePng, inflateBrowser, browserIO, nodeIO, load, loadSync, fromLayers,
    cell, world, inside, codeAt, validAt, reasonOf,
    modesOf, canSwap, sharedSpot, structuresOf, todayYaw, bestYaws, anyValidMask, nearestFix, checkBase, checkYaw,
    openness, lowOpenLimit, isLowOpen, auditLayout, kitRadii, patchesWithin, kitChange, reasonText, fixText,
  };
}));
