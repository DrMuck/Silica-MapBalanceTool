// Expansion curve V(k) of the first expansion layer (spec section 12). UMD, DOM-free; reads
// ctx.ctrl (GenGrid.build: hqOk, patchDist, patchCell, cx/cz) and an optional Fields object.
//
// For human i with spawn s_i: expansion cells = control cells with ctrl.hqOk, centre within
// reach*R_c of s_i (Euclidean) and owner i; grab set of a cell = kept Balterium within R_b of
// the cell centre, on i's side and outside i's kit (d(r, s_i) > R_b); V(k) = patches grabbed by
// the best k cells chosen greedily (maximum coverage), k = 1..K.
//
//   GenExpansion.prepare(ctx, settings) -> ctx.exp = {cover, Rb}   cached in ctx.cache per R_b
//   GenExpansion.curve(ctx, settings, spawn, sideIndex, fields, keptBalt, K[, others])
//       -> {V: number[K], cells: number[K] (ci or -1), layer}
//   GenExpansion.solo(ctx, settings, cand) -> number               V(1) ignoring enemies, vanilla
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenExpansion = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = { K: 3, reach: 0.85, w: [0.45, 0.35, 0.20] };

  function params(settings) {
    const r = (settings && settings.radii) || {}, e = (settings && settings.expansion) || {};
    return {
      Rb: r.build || 1000, Rc: r.chain || 2500,
      K: e.K > 0 ? e.K : DEFAULTS.K,
      reach: e.reach > 0 ? e.reach : DEFAULTS.reach,
    };
  }

  /**
   * Per control cell with ctrl.hqOk: Uint16Array of the indices k (into ctx.patches) of the
   * Balterium within R_b of the cell centre; null on cells without a valid HQ (and on valid
   * cells with no Balterium in reach). Built once per map and R_b, cached in ctx.cache.
   */
  function prepare(ctx, settings) {
    const { Rb } = params(settings);
    if (ctx.exp && ctx.exp.Rb === Rb) return ctx.exp;
    const key = 'exp|' + Rb;
    let exp = ctx.cache ? ctx.cache.get(key) : null;
    if (!exp) {
      exp = build(ctx, Rb);
      if (ctx.cache) ctx.cache.set(key, exp);
    }
    ctx.exp = exp;
    return exp;
  }

  function build(ctx, Rb) {
    const ctrl = ctx.ctrl, N = ctrl.n * ctrl.n, P = ctx.patches, PD = ctrl.patchDist, ok = ctrl.hqOk;
    const balt = [];
    for (let k = 0; k < P.length; k++) if (P[k].type === 'Balterium') balt.push(k);
    const cover = new Array(N).fill(null);
    const tmp = new Uint16Array(balt.length);
    for (let c = 0; c < N; c++) {
      if (!ok || !ok[c]) continue;
      let m = 0;
      for (let q = 0; q < balt.length; q++) { const k = balt[q]; if (PD[k][c] <= Rb) tmp[m++] = k; }
      if (m) cover[c] = tmp.slice(0, m);
    }
    return { cover, Rb };
  }

  function dPatch(ctx, s, k) {
    if (s.pd) return s.pd[k];
    const p = ctx.patches[k];
    return Math.hypot(p.x - s.x, p.z - s.z);
  }

  // scratch buffers reused across calls (single-threaded; one per worker)
  let elig = new Uint8Array(0), got = new Uint8Array(0), flat = new Int32Array(0);

  /**
   * Expansion curve of one human. spawn = Candidate-like {x, z, pd?}; sideIndex = index into
   * fields.sides of this human; keptBalt[k] = 1 for kept patches (index into ctx.patches).
   * Own side: fields.owner[cell] === sideIndex. Without fields: nearer to spawn than to every
   * structure in `others` (optional array of {x, z}); without others nothing is excluded.
   * layer = own-side kept Balterium with R_b < d(r, s_i) <= reach*R_c + R_b.
   */
  function curve(ctx, settings, spawn, sideIndex, fields, keptBalt, K, others) {
    const pr = params(settings), Rb = pr.Rb, reachM = pr.reach * pr.Rc;
    if (!(K > 0)) K = pr.K;
    const exp = prepare(ctx, settings);
    const ctrl = ctx.ctrl, n = ctrl.n, P = ctx.patches, nP = P.length, PC = ctrl.patchCell;
    const owner = fields && fields.owner ? fields.owner : null;
    const oth = !owner && others && others.length ? others : null;
    const ownAt = (x, z, ci) => {
      if (owner) return owner[ci] === sideIndex;
      if (!oth) return true;
      const d = (x - spawn.x) * (x - spawn.x) + (z - spawn.z) * (z - spawn.z);
      for (const o of oth) if ((x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) <= d) return false;
      return true;
    };

    if (elig.length < nP) { elig = new Uint8Array(nP); got = new Uint8Array(nP); }
    let layer = 0;
    const layerR = reachM + Rb;
    for (let k = 0; k < nP; k++) {
      elig[k] = 0; got[k] = 0;
      if (P[k].type !== 'Balterium' || (keptBalt && !keptBalt[k])) continue;
      const d = dPatch(ctx, spawn, k);
      if (d <= Rb || d > layerR) continue;
      if (!ownAt(P[k].x, P[k].z, PC[k])) continue;
      elig[k] = 1;
      layer++;
    }

    // expansion cells: hqOk (cover != null), within reach*R_c, own side; their eligible lists
    // packed into flat = [ci, m, k1..km, ci, m, ...]
    const cell = ctrl.cell, r2 = reachM * reachM;
    let i0 = Math.floor((spawn.x - reachM - ctrl.minX) / cell), i1 = Math.floor((spawn.x + reachM - ctrl.minX) / cell);
    let j0 = Math.floor((ctrl.maxZ - spawn.z - reachM) / cell), j1 = Math.floor((ctrl.maxZ - spawn.z + reachM) / cell);
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0; if (i1 > n - 1) i1 = n - 1; if (j1 > n - 1) j1 = n - 1;
    let f = 0;
    const cover = exp.cover, cx = ctrl.cx, cz = ctrl.cz;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * n + i, lst = cover[c];
        if (!lst) continue;
        const dx = cx[c] - spawn.x, dz = cz[c] - spawn.z;
        if (dx * dx + dz * dz > r2) continue;
        let m = 0;
        for (let q = 0; q < lst.length; q++) if (elig[lst[q]]) m++;
        if (!m || !ownAt(cx[c], cz[c], c)) continue;
        if (flat.length < f + 2 + m) { const nf = new Int32Array(Math.max(2 * flat.length, f + 2 + m, 4096)); nf.set(flat.subarray(0, f)); flat = nf; }
        flat[f++] = c; flat[f++] = m;
        for (let q = 0; q < lst.length; q++) if (elig[lst[q]]) flat[f++] = lst[q];
      }
    }

    // greedy maximum coverage, K passes; ties keep the lowest ci (scan order)
    const V = new Array(K).fill(0), cells = new Array(K).fill(-1);
    let total = 0;
    for (let t = 0; t < K; t++) {
      let bc = -1, bg = 0, bo = -1;
      for (let o = 0; o < f;) {
        const m = flat[o + 1];
        let g = 0;
        if (m > bg) for (let q = o + 2, e = o + 2 + m; q < e; q++) if (!got[flat[q]]) g++;
        if (g > bg) { bg = g; bc = flat[o]; bo = o; }
        o += 2 + m;
      }
      if (bc >= 0) {
        for (let q = bo + 2, e = bo + 2 + flat[bo + 1]; q < e; q++) got[flat[q]] = 1;
        total += bg;
        cells[t] = bc;
      }
      V[t] = total;
    }
    return { V, cells, layer };
  }

  /** V(1) of a candidate ignoring enemies: best single expansion cell, vanilla Balterium. */
  function solo(ctx, settings, cand) {
    return curve(ctx, settings, cand, -1, null, null, 1, null).V[0];
  }

  return { prepare, curve, solo, params, DEFAULTS };
}));
