// Candidate start positions for the spawn generator (spec 3.1 G1, 6.1). UMD, DOM-free.
// Depends on Terrain and GenGrid (looked up on the global at call time in the browser).
//
// list(): valid cells (G1) -> one representative per 120 m bin (a seeded random valid cell of
// the bin; deterministic centre-most cell without rng) -> exposure cut at the
// settings.exposureCut percentile of the representatives -> best first by
// nBalt(R_b) - 2E (human) / nBio(R_n) - 2E (alien), ties by the seeded rng -> greedy thinning
// to >= min(300 m, extent/10) (300 m on 6 km maps, 150 m on 3 km, 100 m on BlackIsle; at a flat
// 300 m the 2-3 km maps get only 13-39 candidates) -> cap 250.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../terrain.js'), require('./grid.js'));
  else root.GenCandidates = factory(null, null, root);
}(typeof self !== 'undefined' ? self : this, function (TerrainMod, GenGridMod, root) {
  'use strict';

  const T = () => TerrainMod || root.Terrain;
  const G = () => GenGridMod || root.GenGrid;

  const HUMAN_FOOTPRINT = 67;   // circumscribed HQ footprint radius (m)

  function opt(settings, key, def) {
    return settings && settings[key] !== undefined && settings[key] !== null ? settings[key] : def;
  }

  /** Scan-grid mask: 1 where a circle of radius r around the cell centre touches a patch rectangle. */
  function blockedMask(ctx, r) {
    const key = `blk|${r}`;
    let m = ctx.cache && ctx.cache.get(key);
    if (m) return m;
    const sc = ctx.scan, w = sc.w, hh = sc.h, step = sc.step;
    m = new Uint8Array(w * hh);
    const r2 = r * r;
    for (const p of ctx.patches) {
      const hw = p.w / 2, hz = p.h / 2;
      if (!(hw > 0 && hz > 0)) continue;
      const x0 = Math.max(0, Math.floor((p.x - hw - r - sc.minX) / step));
      const x1 = Math.min(w - 1, Math.ceil((p.x + hw + r - sc.minX) / step));
      const y0 = Math.max(0, Math.floor((sc.maxZ - (p.z + hz + r)) / step));
      const y1 = Math.min(hh - 1, Math.ceil((sc.maxZ - (p.z - hz - r)) / step));
      for (let py = y0; py <= y1; py++) {
        const wz = sc.maxZ - py * step, dz = Math.max(Math.abs(wz - p.z) - hz, 0);
        for (let px = x0; px <= x1; px++) {
          const wx = sc.minX + px * step, dx = Math.max(Math.abs(wx - p.x) - hw, 0);
          if (dx * dx + dz * dz < r2) m[py * w + px] = 1;
        }
      }
    }
    if (ctx.cache) ctx.cache.set(key, m);
    return m;
  }

  /** G1 placement check of scan cell (px, py) for 'human' or 'alien'. */
  function valid(ctx, settings, role, px, py) {
    const sc = ctx.scan, w = sc.w, hh = sc.h;
    if (px < 0 || py < 0 || px >= w || py >= hh) return false;
    if (role === 'alien') return !!ctx.nestMask[py * w + px];
    if (px < 1 || py < 1 || px >= w - 1 || py >= hh - 1) return false;
    const both = ctx.masks.hqBoth;
    for (let dy = -1; dy <= 1; dy++) {
      const row = (py + dy) * w;
      for (let dx = -1; dx <= 1; dx++) if (!both[row + px + dx]) return false;
    }
    const m = opt(settings, 'edgeMargin', 250), lim = ctx.extent - m;
    const x = sc.minX + px * sc.step, z = sc.maxZ - py * sc.step;
    if (Math.abs(x) > lim || Math.abs(z) > lim) return false;
    return !blockedMask(ctx, HUMAN_FOOTPRINT)[py * w + px];
  }

  function exposureKey(settings) {
    const e = (settings && settings.exposure) || {};
    return `E|${e.overlook}|${e.highground}|${e.openness}`;
  }

  /** Exposure E of scan cell (px, py) (0 without height data), cached per ctx and weights. */
  function exposure(ctx, settings, px, py) {
    if (!ctx.heights) return 0;
    const key = exposureKey(settings);
    let m = ctx.cache.get(key);
    if (!m) { m = new Map(); ctx.cache.set(key, m); }
    const i = py * ctx.scan.w + px;
    let e = m.get(i);
    if (e === undefined) {
      e = T().exposureAt(ctx.heights, ctx.scan.w, ctx.scan.h, ctx.scan.step, px, py, settings && settings.exposure).E;
      m.set(i, e);
    }
    return e;
  }

  /** Full Candidate at scan cell (px, py); does not check validity. */
  function at(ctx, settings, role, px, py, id) {
    const sc = ctx.scan;
    const x = sc.minX + px * sc.step, z = sc.maxZ - py * sc.step;
    const r = (settings && settings.radii) || {};
    const Rb = r.build || 1000, Rc = r.chain || 2500, Rn = r.nest || 1200;
    const P = ctx.patches, pd = new Float32Array(P.length);
    let nBalt = 0, nBio = 0, ring1 = 0;
    const own = role === 'alien' ? 'Biotics' : 'Balterium', R0 = role === 'alien' ? Rn : Rb;
    for (let k = 0; k < P.length; k++) {
      const d = Math.hypot(P[k].x - x, P[k].z - z);
      pd[k] = d;
      if (P[k].type === 'Balterium' && d <= Rb) nBalt++;
      if (P[k].type === 'Biotics' && d <= Rn) nBio++;
      if (P[k].type === own && d > R0 && d <= R0 + Rc) ring1++;
    }
    return {
      id: id !== undefined ? id : `${role === 'alien' ? 'a' : 'h'}${px}_${py}`,
      role, x, z, px, py, ci: G().cellOf(ctx, x, z),
      E: exposure(ctx, settings, px, py),
      z0: ctx.heights ? ctx.heights[py * sc.w + px] : 0,
      nBalt, nBio, ring1, pd,
    };
  }

  function countWithin(ctx, type, x, z, R) {
    let n = 0;
    const R2 = R * R;
    for (const p of ctx.patches) {
      if (p.type !== type) continue;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz <= R2) n++;
    }
    return n;
  }

  /**
   * Candidate[] for role 'human' | 'alien'. rng = GenRng stream (optional; without it the bin
   * representative is the centre-most valid cell and ties keep scan order).
   * Statistics go to ctx.stats.candidates[role].
   */
  function list(ctx, settings, role, rng) {
    const sc = ctx.scan, w = sc.w, hh = sc.h, step = sc.step;
    const binM = opt(settings, 'candidateBin', 120);
    const spacing = opt(settings, 'candidateSpacing', Math.min(300, ctx.extent / 10));
    const cap = opt(settings, 'candidateCap', 250), cut = opt(settings, 'exposureCut', 0.75);
    const r = (settings && settings.radii) || {};
    const R = role === 'alien' ? (r.nest || 1200) : (r.build || 1000);
    const type = role === 'alien' ? 'Biotics' : 'Balterium';
    const bin = Math.max(1, Math.round(binM / step));

    // 1. one representative per bin
    const reps = [];
    let nValid = 0;
    const cells = [];
    for (let by = 0; by * bin < hh; by++) {
      for (let bx = 0; bx * bin < w; bx++) {
        cells.length = 0;
        const y1 = Math.min(hh, (by + 1) * bin), x1 = Math.min(w, (bx + 1) * bin);
        for (let py = by * bin; py < y1; py++) {
          for (let px = bx * bin; px < x1; px++) if (valid(ctx, settings, role, px, py)) cells.push(py * w + px);
        }
        if (!cells.length) continue;
        nValid += cells.length;
        let pick;
        if (rng) pick = cells[rng.int(cells.length)];
        else {
          const cxm = bx * bin + (x1 - bx * bin - 1) / 2, cym = by * bin + (y1 - by * bin - 1) / 2;
          let bd = Infinity;
          for (const c of cells) {
            const px = c % w, py = (c - px) / w, d = (px - cxm) ** 2 + (py - cym) ** 2;
            if (d < bd) { bd = d; pick = c; }
          }
        }
        const px = pick % w, py = (pick - px) / w;
        reps.push({ px, py, E: exposure(ctx, settings, px, py) });
      }
    }

    // 2. exposure percentile cut (nearest rank)
    let cutE = Infinity;
    if (cut !== null && cut < 1 && reps.length) {
      const es = reps.map(q => q.E).sort((a, b) => a - b);
      cutE = es[Math.max(0, Math.ceil(cut * es.length) - 1)];
    }
    const kept = reps.filter(q => q.E <= cutE);

    // 3. score, seeded tie-break, sort
    for (let i = 0; i < kept.length; i++) {
      const q = kept[i], x = sc.minX + q.px * step, z = sc.maxZ - q.py * step;
      q.score = countWithin(ctx, type, x, z, R) - 2 * q.E;
      q.tie = rng ? rng.next() : i;
      q.x = x; q.z = z;
    }
    kept.sort((a, b) => (b.score - a.score) || (a.tie - b.tie));

    // 4. greedy thinning, cap
    const acc = [], sp2 = spacing * spacing;
    for (const q of kept) {
      if (acc.length >= cap) break;
      let ok = true;
      for (const a of acc) {
        const dx = a.x - q.x, dz = a.z - q.z;
        if (dx * dx + dz * dz < sp2) { ok = false; break; }
      }
      if (ok) acc.push(q);
    }

    const pre = role === 'alien' ? 'a' : 'h';
    const out = acc.map((q, i) => at(ctx, settings, role, q.px, q.py, `${pre}${i}`));
    if (ctx.stats) {
      ctx.stats.candidates = ctx.stats.candidates || {};
      ctx.stats.candidates[role] = { validCells: nValid, bins: reps.length, cutE, afterCut: kept.length, count: out.length };
    }
    return out;
  }

  return { HUMAN_FOOTPRINT, list, at, valid, exposure, blockedMask };
}));
