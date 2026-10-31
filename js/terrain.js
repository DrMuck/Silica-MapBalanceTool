// Terrain heights on the 15 m scan grid (data/heights/<Map>.png + .json, written by heights.py).
// UMD, DOM-free core (decode, sample, slope, exposureAt, nestMask) usable from the browser,
// a Web Worker and Node. Only Terrain.load touches fetch/canvas.
//
// Grid convention (same as the masks, layers.isValidPlacement): cell (px, py) is world
// x = scan.minX + px*step, z = scan.maxZ - py*step; row 0 = north; index = py*w + px.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Terrain = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VMAX = 65535;

  const EXPOSURE_DEFAULTS = {
    // weights (GenSettings.exposure can be passed as-is)
    overlook: 0.5, highground: 0.3, openness: 0.2,
    // geometry (spec section 5.3)
    overlookMin: 100, overlookMax: 450, overlookOffset: 5, overlookScale: 20, overlookCap: 2,
    tpiRadius: 600, tpiScale: 15, tpiCap: 2,
    rays: 16, rayLength: 600, rayStep: 15, eye: 3,
  };

  const NEST_DEFAULTS = {
    flatness: 8,        // max height range (m) within flatRadius
    flatRadius: 30,
    nearRadius: 30,     // must lie within this of a human-mask cell
    edgeMargin: 250,    // from the map edge (extent if given, else the scan grid border)
    footprint: 36,      // footprint radius that must be clear of patch rectangles
  };

  // ── decode ────────────────────────────────────────────────────────────

  function vAt(rgba, w, px, py) {
    const i = (py * w + px) * 4;
    return rgba[i] * 256 + rgba[i + 1];
  }

  /** Samples from meta.samples that do not match the decoded RGBA ([] = all good). */
  function checkSamples(rgba, meta) {
    const bad = [];
    for (const s of meta.samples || []) {
      const got = vAt(rgba, meta.grid_w, s[0], s[1]);
      if (got !== s[2]) bad.push({ px: s[0], py: s[1], expected: s[2], got });
    }
    return bad;
  }

  /** RGBA bytes (w*h*4, e.g. ImageData.data or pngjs data) -> Float32Array heights in metres. */
  function decode(rgba, meta) {
    const w = meta.grid_w, hh = meta.grid_h, n = w * hh;
    if (rgba.length < n * 4) throw new Error(`Terrain.decode: ${rgba.length} bytes < ${n * 4} for ${w}x${hh}`);
    const bad = checkSamples(rgba, meta);
    if (bad.length && typeof console !== 'undefined') {
      console.warn(`Terrain.decode(${meta.map}): ${bad.length}/${meta.samples.length} sample cells differ ` +
        '(colour management altered the PNG?)', bad);
    }
    const hmin = meta.hmin, scale = (meta.hmax - meta.hmin) / VMAX;
    const out = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = hmin + (rgba[j] * 256 + rgba[j + 1]) * scale;
    return out;
  }

  /** {minX, maxZ, step, w, h} from the heights JSON (or a map_config entry). */
  function scanOf(meta) {
    return {
      minX: meta.scan_min_x, maxZ: meta.scan_max_z, step: meta.step || meta.scan_step || 15,
      w: meta.grid_w, h: meta.grid_h,
    };
  }

  // ── sampling ──────────────────────────────────────────────────────────

  /** Bilinear height at fractional grid coordinates (clamped to the grid). */
  function bilinear(h, w, hh, fx, fy) {
    if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
    if (fy < 0) fy = 0; else if (fy > hh - 1) fy = hh - 1;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < hh ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const a = h[y0 * w + x0], b = h[y0 * w + x1], c = h[y1 * w + x0], d = h[y1 * w + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /** Bilinear height at world (x, z); scan = {minX, maxZ, step} (or the heights JSON). */
  function sample(h, w, hh, scan, x, z) {
    const minX = scan.minX !== undefined ? scan.minX : scan.scan_min_x;
    const maxZ = scan.maxZ !== undefined ? scan.maxZ : scan.scan_max_z;
    const step = scan.step || scan.scan_step || 15;
    return bilinear(h, w, hh, (x - minX) / step, (maxZ - z) / step);
  }

  /** Max |dh| / distance to the 8 neighbours (rise over run) per cell. */
  function slope(h, w, hh, step) {
    const out = new Float32Array(w * hh);
    const diag = step * Math.SQRT2;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, hp = h[i];
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= hh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const s = Math.abs(h[yy * w + xx] - hp) / (dx && dy ? diag : step);
            if (s > m) m = s;
          }
        }
        out[i] = m;
      }
    }
    return out;
  }

  // ── exposure (spec 5.3) ───────────────────────────────────────────────

  const offsetCache = new Map();

  /** Cell offsets [dx, dy, ...] with rMin <= dist <= rMax (metres), cached. */
  function ringOffsets(step, rMin, rMax) {
    const key = `${step}|${rMin}|${rMax}`;
    let o = offsetCache.get(key);
    if (o) return o;
    const r = Math.floor(rMax / step), list = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy) * step;
        if (d >= rMin && d <= rMax) list.push(dx, dy);
      }
    }
    o = Int16Array.from(list);
    offsetCache.set(key, o);
    return o;
  }

  function withDefaults(params, defaults) {
    const p = Object.assign({}, defaults);
    if (params) for (const k in params) if (params[k] !== undefined && params[k] !== null) p[k] = params[k];
    return p;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /**
   * Exposure of cell (px, py):
   *   overlook   = mean over 100-450 m of clamp((h_q - h_p - 5) / 20, 0, 2)
   *   highground = clamp((h_p - mean h within 600 m) / 15, 0, 2)
   *   openness   = fraction of 16 horizontal rays (600 m, 15 m samples, eye h_p + 3 m) never
   *                blocked by terrain above eye level
   *   E = 0.5*overlook + 0.3*highground + 0.2*openness   (weights from params)
   * Cells outside the grid are ignored (means) or end the ray (openness).
   */
  function exposureAt(h, w, hh, step, px, py, params) {
    const p = withDefaults(params, EXPOSURE_DEFAULTS);
    const hp = h[py * w + px];

    // overlook
    let sumO = 0, nO = 0;
    const ring = ringOffsets(step, p.overlookMin, p.overlookMax);
    for (let k = 0; k < ring.length; k += 2) {
      const x = px + ring[k], y = py + ring[k + 1];
      if (x < 0 || y < 0 || x >= w || y >= hh) continue;
      sumO += clamp((h[y * w + x] - hp - p.overlookOffset) / p.overlookScale, 0, p.overlookCap);
      nO++;
    }
    const overlook = nO ? sumO / nO : 0;

    // highground (topographic position index)
    let sumH = 0, nH = 0;
    const disk = ringOffsets(step, 0, p.tpiRadius);
    for (let k = 0; k < disk.length; k += 2) {
      const x = px + disk[k], y = py + disk[k + 1];
      if (x < 0 || y < 0 || x >= w || y >= hh) continue;
      sumH += h[y * w + x];
      nH++;
    }
    const highground = nH ? clamp((hp - sumH / nH) / p.tpiScale, 0, p.tpiCap) : 0;

    // openness
    const eye = hp + p.eye, nSteps = Math.floor(p.rayLength / p.rayStep), ds = p.rayStep / step;
    let open = 0;
    for (let r = 0; r < p.rays; r++) {
      const a = (2 * Math.PI * r) / p.rays, cx = Math.cos(a) * ds, cy = -Math.sin(a) * ds;
      let blocked = false;
      for (let s = 1; s <= nSteps; s++) {
        const fx = px + cx * s, fy = py + cy * s;
        if (fx < 0 || fy < 0 || fx > w - 1 || fy > hh - 1) break;
        if (bilinear(h, w, hh, fx, fy) > eye) { blocked = true; break; }
      }
      if (!blocked) open++;
    }
    const openness = p.rays ? open / p.rays : 0;

    const E = p.overlook * overlook + p.highground * highground + p.openness * openness;
    return { overlook, highground, openness, E };
  }

  // ── Nest validity (spec 5.4) ──────────────────────────────────────────

  /**
   * nestMask[c] = 1 iff height range within flatRadius <= flatness, c within nearRadius of a
   * humanMaskUnion cell (Uint8Array, 1 = valid HQ/Refinery cell), >= edgeMargin from the edge,
   * and the footprint radius is clear of every patch rectangle.
   * params: {flatness, flatRadius, nearRadius, edgeMargin, footprint,
   *          scan: {minX, maxZ}  (needed for edge distance by extent and for patches),
   *          extent?: number     (edge = +-extent; default: the scan grid border),
   *          patches?: [{x, z, w|world_w, h|world_h}]   (axis-aligned rectangles, w along X)}
   */
  function nestMask(h, w, hh, step, humanMaskUnion, params) {
    const p = withDefaults(params, NEST_DEFAULTS);
    const n = w * hh;
    const out = new Uint8Array(n);
    const scan = p.scan || null;
    const minX = scan ? (scan.minX !== undefined ? scan.minX : scan.scan_min_x) : 0;
    const maxZ = scan ? (scan.maxZ !== undefined ? scan.maxZ : scan.scan_max_z) : (hh - 1) * step;

    // edge bounds in world coordinates
    let x0, x1, z0, z1;
    if (p.extent) { x0 = -p.extent; x1 = p.extent; z0 = -p.extent; z1 = p.extent; }
    else { x0 = minX; x1 = minX + (w - 1) * step; z0 = maxZ - (hh - 1) * step; z1 = maxZ; }
    const m = p.edgeMargin;

    // dilate the human mask by nearRadius
    const near = new Uint8Array(n);
    const nearOff = ringOffsets(step, 0, p.nearRadius);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        if (!humanMaskUnion[y * w + x]) continue;
        for (let k = 0; k < nearOff.length; k += 2) {
          const xx = x + nearOff[k], yy = y + nearOff[k + 1];
          if (xx >= 0 && yy >= 0 && xx < w && yy < hh) near[yy * w + xx] = 1;
        }
      }
    }

    const rects = (p.patches || []).map(r => ({
      x: r.x, z: r.z,
      hw: (r.world_w !== undefined ? r.world_w : r.w) / 2,
      hh: (r.world_h !== undefined ? r.world_h : r.h) / 2,
    })).filter(r => r.hw > 0 && r.hh > 0);
    const fp2 = p.footprint * p.footprint;

    const flatOff = ringOffsets(step, 0, p.flatRadius);
    for (let y = 0; y < hh; y++) {
      const wz = maxZ - y * step;
      if (wz - z0 < m || z1 - wz < m) continue;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!near[i]) continue;
        const wx = minX + x * step;
        if (wx - x0 < m || x1 - wx < m) continue;
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < flatOff.length; k += 2) {
          const xx = x + flatOff[k], yy = y + flatOff[k + 1];
          if (xx < 0 || yy < 0 || xx >= w || yy >= hh) continue;
          const v = h[yy * w + xx];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > p.flatness) continue;
        let clear = true;
        for (const r of rects) {
          const dx = Math.max(Math.abs(wx - r.x) - r.hw, 0), dz = Math.max(Math.abs(wz - r.z) - r.hh, 0);
          if (dx * dx + dz * dz < fp2) { clear = false; break; }
        }
        if (clear) out[i] = 1;
      }
    }
    return out;
  }

  // ── browser loader ────────────────────────────────────────────────────

  const cache = new Map();

  /**
   * Browser/worker only. Resolves {heights: Float32Array, meta} or, when the files are missing
   * or unreadable, {heights: null, meta: null} (callers then run without height data).
   * Variants resolve through MAP_CONFIG[mapName].base_map when that global exists.
   * opts.base: URL prefix of the height files (default 'data/heights/').
   */
  function load(mapName, opts) {
    const base = (opts && opts.base) || 'data/heights/';
    const g = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {});
    const cfgs = typeof MAP_CONFIG !== 'undefined' ? MAP_CONFIG : g.MAP_CONFIG;
    const file = (cfgs && cfgs[mapName] && cfgs[mapName].base_map) || mapName;
    const key = base + file;
    if (cache.has(key)) return cache.get(key);
    const pr = (async () => {
      try {
        const metaResp = await fetch(`${base}${file}.json`);
        if (!metaResp.ok) throw new Error(`HTTP ${metaResp.status} for ${file}.json`);
        const meta = await metaResp.json();
        const pngResp = await fetch(`${base}${file}.png`);
        if (!pngResp.ok) throw new Error(`HTTP ${pngResp.status} for ${file}.png`);
        const blob = await pngResp.blob();
        const rgba = await pixelsOf(blob, meta.grid_w, meta.grid_h);
        return { heights: decode(rgba, meta), meta };
      } catch (err) {
        if (typeof console !== 'undefined') console.warn(`Terrain.load(${mapName}): no height data`, err);
        return { heights: null, meta: null };
      }
    })();
    cache.set(key, pr);
    return pr;
  }

  async function pixelsOf(blob, w, hh) {
    let source;
    if (typeof createImageBitmap === 'function') {
      source = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } else {
      const url = URL.createObjectURL(blob);
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('PNG decode failed'));
        img.src = url;
      });
      URL.revokeObjectURL(url);
    }
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(w, hh)
      : Object.assign(document.createElement('canvas'), { width: w, height: hh });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    if (source.close) source.close();
    return ctx.getImageData(0, 0, w, hh).data;
  }

  // ── self-test (synthetic grids, no I/O) ───────────────────────────────

  /** Synthetic checks; returns {ok, results: [{name, ok, detail}]}. Used by the Node harness. */
  function selftest() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
    const n = 121, step = 15, c = 60;
    const grid = f => {
      const a = new Float32Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) a[y * n + x] = f(Math.hypot(x - c, y - c) * step);
      return a;
    };

    // flat open plain: nothing overlooks, no high ground, every ray open -> E = openness weight
    const flat = exposureAt(grid(() => 100), n, n, step, c, c);
    add('flat: overlook 0, highground 0, openness 1, E = 0.2',
      flat.overlook === 0 && flat.highground === 0 && flat.openness === 1 && Math.abs(flat.E - 0.2) < 1e-9, flat);

    // sheltered floor: flat to 450 m, 4 m wall beyond (above the 3 m eye, below the 5 m overlook offset)
    const shel = exposureAt(grid(r => (r > 460 ? 104 : 100)), n, n, step, c, c);
    add('sheltered floor: E = 0', shel.E === 0, shel);

    // cone peak 100 m high, radius 600 m
    const cone = exposureAt(grid(r => 100 * Math.max(0, 1 - r / 600)), n, n, step, c, c);
    add('cone peak: highground > 1, openness 1, overlook 0',
      cone.highground > 1 && cone.openness === 1 && cone.overlook === 0, cone);

    // bowl: 60 m deep, rim at 450 m -> overlooked, closed
    const bowl = exposureAt(grid(r => 60 * Math.min(1, r / 450)), n, n, step, c, c);
    add('bowl floor: overlook > 1, openness 0, highground 0',
      bowl.overlook > 1 && bowl.openness === 0 && bowl.highground === 0, bowl);

    // slope of a 10 % ramp along x
    const ramp = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ramp[y * n + x] = 0.1 * x * step;
    const sl = slope(ramp, n, n, step);
    add('slope of a 10 % ramp = 0.1', Math.abs(sl[c * n + c] - 0.1) < 1e-5, sl[c * n + c]);

    // bilinear sample between cells
    const sc = { minX: 0, maxZ: (n - 1) * step, step };
    const sv = sample(ramp, n, n, sc, 22.5, 0);
    add('sample bilinear on ramp at x = 22.5 m', Math.abs(sv - 2.25) < 1e-4, sv);

    // nestMask: flat island in the middle of a rough sea of cells
    const nm = nestMask(grid(r => (r < 900 ? 100 : 100 + (r % 30))), n, n, step,
      Uint8Array.from({ length: n * n }, () => 1), { scan: sc, patches: [{ x: c * step, z: c * step, w: 60, h: 60 }] });
    const centre = nm[c * n + c], nearPatch = nm[c * n + c + 4], open = nm[c * n + c + 10], edge = nm[5 * n + 5];
    add('nestMask: patch blocks, flat ok, edge excluded', !centre && !nearPatch && open && !edge,
      { centre, nearPatch, open, edge });

    return { ok: results.every(r => r.ok), results };
  }

  return {
    VMAX, EXPOSURE_DEFAULTS, NEST_DEFAULTS,
    decode, checkSamples, scanOf, sample, bilinear, slope, exposureAt, nestMask, load, selftest,
  };
}));
