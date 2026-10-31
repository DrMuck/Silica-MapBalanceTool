// Control grid and path-cost distance fields for the spawn generator (spec section 2).
// UMD, DOM-free; no dependencies.
//
// Grid: n = 101, cell = 2*extent/100, cell centre x = -extent + (i+0.5)*cell,
// z = extent - (j+0.5)*cell, index ci = j*101 + i (row 0 = north).
//
// Travel cost per move: len * (1 + k*(s/s0)^2), s = |dh|/len, impassable if s > sMax.
// Stencil: 16 neighbours by default (8 + the 8 knight moves; a knight move is split at its
// midpoint, whose height is the mean of the two cells it crosses, so a 1-cell wall still
// blocks it). The 8-neighbour stencil overestimates straight distances by up to 8.2 % at
// 22.5 deg, which breaks the spec's "within 8 %" check; 16 neighbours cap the error at 2.7 %.
// settings.slopeCost.stencil = 8 restores the plain 8-neighbour stencil.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenGrid = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N_SIDE = 101;
  const ROLES = ['Sol', 'Cent', 'Alien'];

  function bilinear(h, w, hh, fx, fy) {
    if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
    if (fy < 0) fy = 0; else if (fy > hh - 1) fy = hh - 1;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < hh ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const a = h[y0 * w + x0], b = h[y0 * w + x1], c = h[y1 * w + x0], d = h[y1 * w + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /**
   * Builds ctx.ctrl = {n, cell, minX, maxZ, h, playable, patchDist, ...extras} and returns it.
   * Extras: playableIdx (Int32Array of playable ci), nPlayable, patchCell (Int32Array, ci of
   * patch k), cx/cz (Float32Array cell-centre coordinates).
   * Needs ctx.extent, ctx.scan, ctx.heights (or null), ctx.masks.union (or the four masks),
   * ctx.patches.
   */
  function build(ctx /* , settings */) {
    const n = N_SIDE, N = n * n, ext = ctx.extent, cell = (2 * ext) / (n - 1);
    const minX = -ext, maxZ = ext;
    const sc = ctx.scan, w = sc.w, hh = sc.h, step = sc.step;

    const h = new Float32Array(N);
    if (ctx.heights) {
      for (let j = 0; j < n; j++) {
        const z = maxZ - (j + 0.5) * cell, fy = (sc.maxZ - z) / step;
        for (let i = 0; i < n; i++) {
          const x = minX + (i + 0.5) * cell, fx = (x - sc.minX) / step;
          h[j * n + i] = bilinear(ctx.heights, w, hh, fx, fy);
        }
      }
    }

    // playable: any union-mask scan cell inside, then dilated by one control cell (8-neighbour)
    const m = ctx.masks;
    const union = m.union || unionOf(m, w * hh);
    const hit = new Uint8Array(N);
    for (let py = 0; py < hh; py++) {
      const z = sc.maxZ - py * step, j = Math.floor((maxZ - z) / cell);
      if (j < 0 || j >= n) continue;
      for (let px = 0; px < w; px++) {
        if (!union[py * w + px]) continue;
        const x = sc.minX + px * step, i = Math.floor((x - minX) / cell);
        if (i >= 0 && i < n) hit[j * n + i] = 1;
      }
    }
    const playable = new Uint8Array(N);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!hit[j * n + i]) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= n) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii >= 0 && ii < n) playable[jj * n + ii] = 1;
          }
        }
      }
    }
    let nPlayable = 0;
    for (let c = 0; c < N; c++) nPlayable += playable[c];
    const playableIdx = new Int32Array(nPlayable);
    for (let c = 0, q = 0; c < N; c++) if (playable[c]) playableIdx[q++] = c;

    const cx = new Float32Array(N), cz = new Float32Array(N);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        cx[j * n + i] = minX + (i + 0.5) * cell;
        cz[j * n + i] = maxZ - (j + 0.5) * cell;
      }
    }

    const patches = ctx.patches || [];
    const patchDist = new Array(patches.length);
    const patchCell = new Int32Array(patches.length);
    for (let k = 0; k < patches.length; k++) {
      const p = patches[k], d = new Float32Array(N);
      for (let c = 0; c < N; c++) d[c] = Math.hypot(cx[c] - p.x, cz[c] - p.z);
      patchDist[k] = d;
      patchCell[k] = cellOfCtrl(n, cell, minX, maxZ, p.x, p.z);
    }

    const ctrl = { n, cell, minX, maxZ, h, playable, patchDist, playableIdx, nPlayable, patchCell, cx, cz };
    ctx.ctrl = ctrl;
    return ctrl;
  }

  function unionOf(m, len) {
    const u = new Uint8Array(len);
    for (const k of ['hqSol', 'hqCent', 'refSol', 'refCent']) {
      const a = m[k];
      if (!a) continue;
      for (let i = 0; i < len; i++) if (a[i]) u[i] = 1;
    }
    return u;
  }

  function cellOfCtrl(n, cell, minX, maxZ, x, z) {
    let i = Math.floor((x - minX) / cell), j = Math.floor((maxZ - z) / cell);
    if (i < 0) i = 0; else if (i >= n) i = n - 1;
    if (j < 0) j = 0; else if (j >= n) j = n - 1;
    return j * n + i;
  }

  function cellOf(ctx, x, z) {
    const c = ctx.ctrl;
    return cellOfCtrl(c.n, c.cell, c.minX, c.maxZ, x, z);
  }

  function cellXZ(ctx, ci) {
    const c = ctx.ctrl, i = ci % c.n, j = (ci - i) / c.n;
    return { x: c.minX + (i + 0.5) * c.cell, z: c.maxZ - (j + 0.5) * c.cell };
  }

  // ── edge costs (cached on ctrl per slope parameters) ─────────────────

  function slopeParams(settings) {
    const s = (settings && settings.slopeCost) || {};
    return {
      k: s.k !== undefined ? s.k : 1.0,
      s0: s.s0 !== undefined ? s.s0 : 0.25,
      sMax: s.sMax !== undefined ? s.sMax : 0.7,
      stencil: s.stencil === 8 ? 8 : 16,
    };
  }

  const STENCIL16 = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
  ];

  /** {edge: Float32Array(N*S), off: Int32Array(S), S}; edge[u*S+d] = cost u -> u+off[d] (Inf = blocked). */
  function edges(ctrl, settings) {
    const p = slopeParams(settings);
    const key = `${p.k}|${p.s0}|${p.sMax}|${p.stencil}`;
    if (ctrl._edges && ctrl._edges.key === key) return ctrl._edges;
    const n = ctrl.n, N = n * n, h = ctrl.h, cell = ctrl.cell, S = p.stencil;
    const st = STENCIL16.slice(0, S);
    const edge = new Float32Array(N * S).fill(Infinity);
    const off = Int32Array.from(st.map(([di, dj]) => dj * n + di));
    const ks = p.k / (p.s0 * p.s0);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const u = j * n + i, hu = h[u];
        for (let d = 0; d < S; d++) {
          const di = st[d][0], dj = st[d][1], ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const v = jj * n + ii, len = Math.hypot(di, dj) * cell;
          if (Math.abs(di) + Math.abs(dj) <= 2) {
            const s = Math.abs(h[v] - hu) / len;
            if (s > p.sMax) continue;
            edge[u * S + d] = len * (1 + ks * s * s);
          } else {
            // knight move: crosses cells A and B; midpoint height = their mean
            let ai, aj, bi, bj;
            if (Math.abs(dj) === 2) { ai = i; aj = j + Math.sign(dj); bi = i + di; bj = aj; }
            else { ai = i + Math.sign(di); aj = j; bi = ai; bj = j + dj; }
            const hm = (h[aj * n + ai] + h[bj * n + bi]) / 2, half = len / 2;
            const s1 = Math.abs(hm - hu) / half, s2 = Math.abs(h[v] - hm) / half;
            if (s1 > p.sMax || s2 > p.sMax) continue;
            edge[u * S + d] = half * (2 + ks * (s1 * s1 + s2 * s2));
          }
        }
      }
    }
    ctrl._edges = { key, edge, off, S };
    return ctrl._edges;
  }

  /** Drops cached edge costs (call after editing ctrl.h). */
  function resetCache(ctrl) { ctrl._edges = null; }

  // ── Dijkstra (binary heap, lazy deletion) ─────────────────────────────

  let hKey = new Float64Array(1 << 16), hVal = new Int32Array(1 << 16);
  let dist64 = new Float64Array(0);

  function dijkstra(ctrl, settings, src) {
    const { edge, off, S } = edges(ctrl, settings);
    const N = ctrl.n * ctrl.n;
    if (dist64.length < N) dist64 = new Float64Array(N);
    const dist = dist64;
    dist.fill(Infinity, 0, N);
    let size = 0;
    const push = (k, v) => {
      if (size >= hKey.length) {
        const nk = new Float64Array(hKey.length * 2), nv = new Int32Array(hKey.length * 2);
        nk.set(hKey); nv.set(hVal); hKey = nk; hVal = nv;
      }
      let i = size++;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (hKey[pi] <= k) break;
        hKey[i] = hKey[pi]; hVal[i] = hVal[pi]; i = pi;
      }
      hKey[i] = k; hVal[i] = v;
    };
    dist[src] = 0;
    push(0, src);
    while (size > 0) {
      const du = hKey[0], u = hVal[0];
      // pop
      size--;
      if (size > 0) {
        const k = hKey[size], v = hVal[size];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= size) break;
          if (c + 1 < size && hKey[c + 1] < hKey[c]) c++;
          if (hKey[c] >= k) break;
          hKey[i] = hKey[c]; hVal[i] = hVal[c]; i = c;
        }
        hKey[i] = k; hVal[i] = v;
      }
      if (du > dist[u]) continue;
      const base = u * S;
      for (let d = 0; d < S; d++) {
        const c = edge[base + d];
        if (c === Infinity) continue;
        const v = u + off[d], nd = du + c;
        if (nd < dist[v]) { dist[v] = nd; push(nd, v); }
      }
    }
    return Float32Array.from(dist.subarray(0, N));
  }

  function euclidField(ctrl, src) {
    const n = ctrl.n, N = n * n, out = new Float32Array(N);
    const si = src % n, sj = (src - si) / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) out[j * n + i] = Math.hypot(i - si, j - sj) * ctrl.cell;
    }
    return out;
  }

  /** Distance field (m) from control cell ci; +Inf where unreachable. */
  function field(ctx, settings, ci) {
    if (settings && settings.controlModel === 'euclidean') return euclidField(ctx.ctrl, ci);
    return dijkstra(ctx.ctrl, settings, ci);
  }

  // ── fields + hard Voronoi ─────────────────────────────────────────────

  /**
   * Fields for a SpawnSet. D[role] per present role (hva: Sol and Cent share one array);
   * owner[c] = index into fields.sides (distinct structures, order Sol, Cent, Alien) on playable
   * cells, -1 elsewhere or where no side reaches; shares[role] = playable-cell share (sums to 1
   * over sides); borders['A-B'] = mean of (A cells with a 4-neighbour of B, B cells with a
   * 4-neighbour of A). Aliased roles (hva Cent) repeat their side's values.
   * cache: Map keyed by ci (geodesic) or -1-ci (euclidean).
   */
  function fields(ctx, settings, set, cache) {
    const ctrl = ctx.ctrl, n = ctrl.n, N = n * n;
    const eu = settings && settings.controlModel === 'euclidean';
    const roles = ROLES.filter(r => set[r]);
    const sides = [], sideOf = {}, D = {};
    for (const r of roles) {
      const c = set[r];
      let s = sides.findIndex(q => set[q] === c);
      if (s < 0) { s = sides.length; sides.push(r); }
      sideOf[r] = s;
      const ci = c.ci !== undefined ? c.ci : cellOf(ctx, c.x, c.z);
      const key = eu ? -1 - ci : ci;
      let f = cache ? cache.get(key) : null;
      if (!f) { f = field(ctx, settings, ci); if (cache) cache.set(key, f); }
      D[r] = f;
    }
    const S = sides.length, Ds = sides.map(r => D[r]);
    const owner = new Int8Array(N).fill(-1);
    const count = new Float64Array(S);
    let total = 0;
    const play = ctrl.playable;
    for (let c = 0; c < N; c++) {
      if (!play[c]) continue;
      let best = Infinity, bs = -1;
      for (let s = 0; s < S; s++) {
        const v = Ds[s][c];
        if (v < best) { best = v; bs = s; }
      }
      if (bs >= 0) { owner[c] = bs; count[bs]++; total++; }
    }
    const adj = [];
    for (let s = 0; s < S; s++) adj.push(new Float64Array(S));
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i, o = owner[c];
        if (o < 0) continue;
        let mask = 0;
        if (i > 0) { const q = owner[c - 1]; if (q >= 0 && q !== o) mask |= 1 << q; }
        if (i < n - 1) { const q = owner[c + 1]; if (q >= 0 && q !== o) mask |= 1 << q; }
        if (j > 0) { const q = owner[c - n]; if (q >= 0 && q !== o) mask |= 1 << q; }
        if (j < n - 1) { const q = owner[c + n]; if (q >= 0 && q !== o) mask |= 1 << q; }
        for (let q = 0; q < S; q++) if (mask & (1 << q)) adj[o][q]++;
      }
    }
    const shares = {}, borders = {};
    for (const r of roles) shares[r] = total ? count[sideOf[r]] / total : 0;
    for (let a = 0; a < roles.length; a++) {
      for (let b = a + 1; b < roles.length; b++) {
        const sa = sideOf[roles[a]], sb = sideOf[roles[b]];
        if (sa === sb) continue;
        borders[`${roles[a]}-${roles[b]}`] = (adj[sa][sb] + adj[sb][sa]) / 2;
      }
    }
    return { D, owner, shares, borders, sides };
  }

  return { N_SIDE, build, cellOf, cellXZ, field, fields, edges, resetCache, slopeParams };
}));
