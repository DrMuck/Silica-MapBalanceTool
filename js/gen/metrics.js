// Spawn generator: hard gates G1-G4, soft terms T1-T5, the stage-1 cheap screen and the
// metrics self-test (docs/SPAWN_GENERATOR.md sections 3 and 6.2). UMD, DOM-free.
//
// Sides: hvh = Sol, Cent; hva = Sol (the one human position, set.Sol === set.Cent) and Alien;
// hvhva = Sol, Cent, Alien. Every pair of sides is an enemy pair. Distances in the gates and
// in T1 are Euclidean (G2); the soft Voronoi of T2 reads the control fields.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let grid = null;
    try { grid = require('./grid.js'); } catch (e) { grid = null; }
    module.exports = factory(grid);
  } else {
    root.GenMetrics = factory(root.GenGrid);
  }
}(typeof self !== 'undefined' ? self : this, function (GenGrid) {
  'use strict';

  const PRESENTATION_BAR = 3.0;
  const HUMAN_FOOTPRINT = 67;          // circumscribed HQ footprint radius (m), G1
  const HARVEST_RATE = { Balterium: 3000, Biotics: 3300 };   // amount per harvest-minute (T2)
  const DEFAULT_AMOUNTS = { balterium: 40000, biotics: 42000 };

  // ── settings helpers ──────────────────────────────────────────────────

  function radii(settings) {
    const r = (settings && settings.radii) || {};
    return { build: r.build || 1000, chain: r.chain || 2500, nest: r.nest || 1200 };
  }
  function weightOf(settings, id, dflt) {
    const w = settings && settings.weights;
    return w && typeof w[id] === 'number' ? w[id] : dflt;
  }
  function amountOf(settings, type) {
    const a = (settings && settings.amounts) || DEFAULT_AMOUNTS;
    return type === 'Balterium' ? (a.balterium != null ? a.balterium : DEFAULT_AMOUNTS.balterium)
      : (a.biotics != null ? a.biotics : DEFAULT_AMOUNTS.biotics);
  }
  function dStar(settings) { return settings.enemyDistance; }
  function pos(v) { return v > 0 ? v : 0; }

  // ── sides and pairs ───────────────────────────────────────────────────

  /** [{key, cand, human, type}] for the mode; hva yields Sol (human) and Alien. */
  function sidesOf(set, mode) {
    const out = [];
    if (mode === 'hva') {
      out.push({ key: 'Sol', cand: set.Sol || set.Cent, human: true, type: 'Balterium' });
      out.push({ key: 'Alien', cand: set.Alien, human: false, type: 'Biotics' });
    } else {
      out.push({ key: 'Sol', cand: set.Sol, human: true, type: 'Balterium' });
      out.push({ key: 'Cent', cand: set.Cent, human: true, type: 'Balterium' });
      if (mode === 'hvhva') out.push({ key: 'Alien', cand: set.Alien, human: false, type: 'Biotics' });
    }
    return out;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

  /** Enemy pair distances [{a, b, key, d}] in side order. */
  function pairsOf(sides) {
    const out = [];
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        out.push({ a: i, b: j, key: sides[i].key + '-' + sides[j].key, d: dist(sides[i].cand, sides[j].cand) });
      }
    }
    return out;
  }

  /** Detour-ratio squeeze S_sq = min_i (rho_i - 1) for three points (research M2). */
  function squeeze3(dab, dac, dbc) {
    const ra = (dab + dac) / dbc, rb = (dab + dbc) / dac, rc = (dac + dbc) / dab;
    return Math.min(ra, rb, rc) - 1;
  }

  function pairGet(obj, a, b) {
    if (!obj) return undefined;
    const k1 = a + '-' + b, k2 = b + '-' + a;
    return obj[k1] !== undefined ? obj[k1] : obj[k2];
  }

  // ── pure term formulas (also used by the self-test) ───────────────────

  /** T1 = sum_pairs |d - d*| / (0.15 d*) + (3 pairs) CV(d) / 0.10. */
  function t1Of(ds, dstar, threeWay) {
    let s = 0;
    for (const d of ds) s += Math.abs(d - dstar) / (0.15 * dstar);
    if (threeWay && ds.length > 1) {
      let m = 0;
      for (const d of ds) m += d;
      m /= ds.length;
      let v = 0;
      for (const d of ds) v += (d - m) * (d - m);
      const cv = Math.sqrt(v / ds.length) / m;
      s += cv / 0.10;
    }
    return s;
  }

  /**
   * T4 = wExp * sum E + (max E - min E) / 0.3 + sum_pairs (|z_i - z_j| - 15)+ / 15.
   * structs = [{E, z0}] (distinct structures).
   */
  function t4Of(structs, wExp) {
    let sum = 0, lo = Infinity, hi = -Infinity, elev = 0;
    for (const s of structs) {
      sum += s.E;
      if (s.E < lo) lo = s.E;
      if (s.E > hi) hi = s.E;
    }
    for (let i = 0; i < structs.length; i++) {
      for (let j = i + 1; j < structs.length; j++) elev += pos(Math.abs(structs[i].z0 - structs[j].z0) - 15) / 15;
    }
    return { value: wExp * sum + (structs.length > 1 ? (hi - lo) / 0.3 : 0) + elev, sumE: sum, dE: hi - lo, elev };
  }

  /** Balance b = min/max of nonnegative values (1 if all zero); penalty (1 - b) / scale. */
  function balance(vals) {
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi > 0)) return 1;
    return lo / hi;
  }

  /**
   * Soft-Voronoi resource totals (research M5). D[s][r] = distance of side s to resource r
   * (Infinity = unreachable), v[r] = value, typeOf[r] = type, sideType[s] = the type side s
   * harvests. Returns T[s] = sum over r of side s's type of v_r * w_s(r).
   */
  function softTotals(D, v, typeOf, sideType, tau) {
    return softShares(D, v, typeOf, sideType, tau).T;
  }

  /**
   * T2 shares (spec 3.2): {T, s}, T as softTotals and s[s] = T[s] / (sum of v_r over the
   * resources of side s's type) = the fraction of its own resource type that sits in side s's
   * soft territory (0 when the type has no value). Resources unreachable from every side count
   * in neither.
   */
  function softShares(D, v, typeOf, sideType, tau) {
    const ns = D.length, nr = v.length, T = new Float64Array(ns), e = new Float64Array(ns), tot = {};
    for (let r = 0; r < nr; r++) {
      let dmin = Infinity;
      for (let s = 0; s < ns; s++) if (D[s][r] < dmin) dmin = D[s][r];
      if (!isFinite(dmin)) continue;
      let sum = 0;
      for (let s = 0; s < ns; s++) {
        const d = D[s][r];
        e[s] = isFinite(d) ? Math.exp(-(d - dmin) / tau) : 0;
        sum += e[s];
      }
      for (let s = 0; s < ns; s++) if (sideType[s] === typeOf[r]) T[s] += v[r] * e[s] / sum;
      tot[typeOf[r]] = (tot[typeOf[r]] || 0) + v[r];
    }
    const sh = new Float64Array(ns);
    for (let s = 0; s < ns; s++) sh[s] = tot[sideType[s]] > 0 ? T[s] / tot[sideType[s]] : 0;
    return { T, s: sh };
  }

  // ── per-context caches ────────────────────────────────────────────────

  const ctxCache = new WeakMap();

  function cellOf(ctx, x, z) {
    if (GenGrid && typeof GenGrid.cellOf === 'function') return GenGrid.cellOf(ctx, x, z);
    const c = ctx.ctrl, n = c.n;
    let i = Math.floor((x - c.minX) / c.cell), j = Math.floor((c.maxZ - z) / c.cell);
    if (i < 0) i = 0; else if (i >= n) i = n - 1;
    if (j < 0) j = 0; else if (j >= n) j = n - 1;
    return j * n + i;
  }

  /** {kOfIdx: Map(idx -> k), byType: {Balterium: k[], Biotics: k[]}, cells: Int32Array|null} */
  function ctxInfo(ctx) {
    let info = ctxCache.get(ctx);
    if (info) return info;
    const kOfIdx = new Map(), byType = { Balterium: [], Biotics: [] };
    ctx.patches.forEach((p, k) => {
      kOfIdx.set(p.idx, k);
      if (byType[p.type]) byType[p.type].push(k);
    });
    let cells = null;
    if (ctx.ctrl && ctx.ctrl.patchCell && ctx.ctrl.patchCell.length === ctx.patches.length) cells = ctx.ctrl.patchCell;
    else if (ctx.ctrl) {
      cells = new Int32Array(ctx.patches.length);
      ctx.patches.forEach((p, k) => { cells[k] = cellOf(ctx, p.x, p.z); });
    }
    info = { kOfIdx, byType, cells };
    ctxCache.set(ctx, info);
    return info;
  }

  // ── G1 placement ──────────────────────────────────────────────────────

  function rectDist(p, x, z) {
    const dx = Math.max(Math.abs(x - p.x) - p.w / 2, 0), dz = Math.max(Math.abs(z - p.z) - p.h / 2, 0);
    return Math.hypot(dx, dz);
  }

  /** Human G1 at scan cell (px, py): hq_Sol AND hq_Cent with 8 neighbours, edge margin, footprint. */
  function humanCellOk(ctx, settings, px, py) {
    const s = ctx.scan, w = s.w;
    if (px < 1 || py < 1 || px >= w - 1 || py >= s.h - 1) return false;
    const a = ctx.masks.hqSol, b = ctx.masks.hqCent;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = (py + dy) * w + px + dx;
        if (!a[i] || !b[i]) return false;
      }
    }
    const x = s.minX + px * s.step, z = s.maxZ - py * s.step;
    const m = settings && settings.edgeMargin != null ? settings.edgeMargin : 250;
    if (ctx.extent - Math.abs(x) < m || ctx.extent - Math.abs(z) < m) return false;
    for (const p of ctx.patches) if (rectDist(p, x, z) < HUMAN_FOOTPRINT) return false;
    return true;
  }

  /** Alien G1: ctx.nestMask valid at (px, py). */
  function alienCellOk(ctx, settings, px, py) {
    const s = ctx.scan;
    if (px < 0 || py < 0 || px >= s.w || py >= s.h) return false;
    return !!(ctx.nestMask && ctx.nestMask[py * s.w + px]);
  }

  function placementOk(ctx, settings, cand) {
    return cand.role === 'alien' ? alienCellOk(ctx, settings, cand.px, cand.py) : humanCellOk(ctx, settings, cand.px, cand.py);
  }

  // ── shared evaluation context ─────────────────────────────────────────

  /** Everything the registry entries read: sides, pairs, kept patches, kit/ring counts. */
  function prepare(ctx, settings, set, fields, plan) {
    const mode = settings.mode, sides = sidesOf(set, mode), pairs = pairsOf(sides);
    const info = ctxInfo(ctx), R = radii(settings);
    const kept = { Balterium: [], Biotics: [] };
    for (const type of ['Balterium', 'Biotics']) {
      for (const idx of (plan && plan.kept[type]) || []) {
        const k = info.kOfIdx.get(idx);
        if (k !== undefined) kept[type].push(k);
      }
    }
    // kit / ring / nearest per side (Euclidean, the game's build rule)
    const kit = {}, rings = {}, near = {}, amount0 = {};
    for (const sd of sides) {
      const pd = sd.cand.pd, type = sd.type;
      const r0 = sd.human ? R.build : R.nest, r1 = r0 + R.chain, v = amountOf(settings, type);
      let n0 = 0, n1 = 0, dn = Infinity;
      for (const k of kept[type]) {
        const d = pd[k];
        if (d <= r0) n0++;
        else if (d <= r1) n1++;
        if (d < dn) dn = d;
      }
      kit[sd.key] = n0;
      rings[sd.key] = { r0: { n: n0, amount: n0 * v }, r1: { n: n1, amount: n1 * v } };
      near[sd.key] = dn;
      amount0[sd.key] = n0 * v;
    }
    return { mode, sides, pairs, kept, kit, rings, near, amount0, R, info, fields, plan };
  }

  // ── registry ──────────────────────────────────────────────────────────

  const ALL = ['hvh', 'hva', 'hvhva'];

  const registry = [
    {
      id: 'G1', kind: 'hard', modes: ALL, weight: 1, label: 'G1 placement',
      compute(ctx, settings, set, m) {
        for (const sd of m.sides) if (!placementOk(ctx, settings, sd.cand)) return false;
        return true;
      },
    },
    {
      id: 'G2', kind: 'hard', modes: ALL, weight: 1, label: 'G2 separation',
      compute(ctx, settings, set, m) {
        const floor = 0.85 * dStar(settings);
        for (const p of m.pairs) if (p.d < floor) return false;
        if (m.mode === 'hvhva' && squeezeOf(m) < 0.3) return false;
        return true;
      },
    },
    {
      id: 'G3', kind: 'hard', modes: ALL, weight: 1, label: 'G3 starting kit',
      compute(ctx, settings, set, m) {
        const minKit = settings.minKit != null ? settings.minKit : 3;
        const minKitA = settings.minKitAlien != null ? settings.minKitAlien : 4;
        // every human kit >= minKit (hva too: its one human position), equal in hvh / hvhva
        const hs = m.sides.filter(s => s.human).map(s => m.kit[s.key]);
        for (const n of hs) if (n !== hs[0] || n < minKit) return false;
        if (m.mode !== 'hvh') {
          if (m.kit.Alien < minKitA) return false;
        }
        return true;
      },
    },
    {
      id: 'G4', kind: 'hard', modes: ALL, weight: 1, label: 'G4 budget',
      compute(ctx, settings, set, m) {
        // target: the requested count; a request >= vanilla means every patch the kit step
        // did not remove (GenPatches reports it as plan.target)
        const c = settings.counts || {};
        const want = { Balterium: c.balterium, Biotics: c.biotics };
        for (const type of ['Balterium', 'Biotics']) {
          const vanilla = m.info.byType[type].length;
          let target = want[type] != null ? want[type] : Math.round(0.75 * vanilla);
          if (target >= vanilla) target = m.plan && m.plan.target ? m.plan.target[type] : vanilla;
          if (m.kept[type].length !== target) return false;
        }
        return true;
      },
    },
    {
      id: 'T1', kind: 'soft', modes: ALL, weight: 1, label: 'T1 separation',
      compute(ctx, settings, set, m) {
        return t1Of(m.pairs.map(p => p.d), dStar(settings), m.mode === 'hvhva');
      },
    },
    {
      id: 'T2', kind: 'soft', modes: ALL, weight: 1, label: 'T2 resources over control',
      compute(ctx, settings, set, m) {
        // balance of the shares of each side's own resource type; T (harvest-minutes) is reported
        const r = territoryTotals(ctx, settings, m);
        m.T = r.T;
        m.shares2 = r.s;
        return (1 - balance(Object.values(r.s))) / 0.10;
      },
    },
    {
      id: 'T3', kind: 'soft', modes: ALL, weight: 1, label: 'T3 control balance',
      compute(ctx, settings, set, m) {
        const sh = sharesOf(m);
        let v = (1 - balance(Object.values(sh))) / 0.10;
        if (m.mode === 'hvhva') {
          const L = m.pairs.map(p => pairGet(m.fields && m.fields.borders, m.sides[p.a].key, m.sides[p.b].key) || 0);
          v += pos(0.5 - balance(L)) / 0.2;
          v += pos(0.6 - squeezeOf(m)) / 0.2;
        }
        return v;
      },
    },
    {
      id: 'T4', kind: 'soft', modes: ALL, weight: 1, label: 'T4 exposure',
      compute(ctx, settings, set, m) {
        const wExp = settings.exposure && settings.exposure.weight != null ? settings.exposure.weight : 1;
        return t4Of(m.sides.map(s => s.cand), wExp).value;
      },
    },
    {
      id: 'T5', kind: 'soft', modes: ['hvh', 'hvhva'], weight: 1, label: 'T5 kit softness',
      compute(ctx, settings, set, m) {
        const hs = m.sides.filter(s => s.human).map(s => s.key);
        const near = hs.map(k => m.near[k]);
        let v = 0;
        if (near.every(isFinite)) v += pos(0.85 - balance(near)) / 0.10;
        else if (near.some(isFinite)) v += 0.85 / 0.10;
        v += (1 - balance(hs.map(k => m.amount0[k]))) / 0.10;
        const n1 = hs.map(k => m.rings[k].r1.n);
        v += pos(Math.max(...n1) - Math.min(...n1) - 1) * 0.5;
        return v;
      },
    },
  ];

  function squeezeOf(m) {
    if (m.pairs.length !== 3) return 1;
    if (m.sq === undefined) m.sq = squeeze3(m.pairs[0].d, m.pairs[1].d, m.pairs[2].d);
    return m.sq;
  }

  function sharesOf(m) {
    const out = {}, sh = (m.fields && m.fields.shares) || {};
    for (const sd of m.sides) {
      // hva: GenGrid.fields gives the aliased Cent the same values as Sol; read Sol only
      out[sd.key] = sh[sd.key] || 0;
    }
    return out;
  }

  /**
   * T2 per side (soft Voronoi over the control fields): {T: harvest-minutes, s: share of the
   * side's own resource type}.
   */
  function territoryTotals(ctx, settings, m) {
    const info = m.info, tau = 0.15 * dStar(settings);
    const ks = m.kept.Balterium.concat(m.kept.Biotics);
    const v = new Float64Array(ks.length), typeOf = new Array(ks.length);
    for (let r = 0; r < ks.length; r++) {
      const p = ctx.patches[ks[r]];
      typeOf[r] = p.type;
      v[r] = amountOf(settings, p.type) / HARVEST_RATE[p.type];
    }
    const D = m.sides.map(sd => {
      const f = m.fields && m.fields.D && m.fields.D[sd.key];
      const a = new Float64Array(ks.length);
      for (let r = 0; r < ks.length; r++) {
        const k = ks[r];
        a[r] = f && info.cells ? f[info.cells[k]] : sd.cand.pd[k];
      }
      return a;
    });
    // a patch unreachable from every side falls back to Euclidean distances
    for (let r = 0; r < ks.length; r++) {
      let any = false;
      for (const a of D) if (isFinite(a[r])) { any = true; break; }
      if (!any) m.sides.forEach((sd, s) => { D[s][r] = sd.cand.pd[ks[r]]; });
    }
    const r = softShares(D, v, typeOf, m.sides.map(s => s.type), tau);
    const T = {}, sh = {};
    m.sides.forEach((sd, s) => { T[sd.key] = r.T[s]; sh[sd.key] = r.s[s]; });
    return { T, s: sh };
  }

  // ── evaluate ──────────────────────────────────────────────────────────

  function round(v, d) {
    if (!isFinite(v)) return v;
    const f = Math.pow(10, d);
    return Math.round(v * f) / f;
  }

  /** Full evaluation of a built set (spec 3): gates, terms, weighted score, report metrics. */
  function evaluate(ctx, settings, set, fields, plan) {
    const m = prepare(ctx, settings, set, fields, plan);
    const gateFails = [], terms = {};
    let score = 0;
    for (const e of registry) {
      if (e.modes.indexOf(m.mode) < 0) continue;
      if (e.kind === 'hard') {
        if (!e.compute(ctx, settings, set, m)) gateFails.push(e.id);
      } else {
        const v = e.compute(ctx, settings, set, m);
        terms[e.id] = v;
        score += weightOf(settings, e.id, e.weight) * v;
      }
    }
    const metrics = reportMetrics(ctx, settings, m);
    return { set, gateFails, terms, score, metrics, plan };
  }

  function reportMetrics(ctx, settings, m) {
    const distances = {}, elevation = {}, exposure = {}, shares = sharesOf(m), borders = {}, T = {}, shares2 = {};
    for (const p of m.pairs) {
      distances[p.key] = round(p.d, 1);
      elevation[p.key] = round(Math.abs(m.sides[p.a].cand.z0 - m.sides[p.b].cand.z0), 1);
      borders[p.key] = pairGet(m.fields && m.fields.borders, m.sides[p.a].key, m.sides[p.b].key) || 0;
    }
    for (const sd of m.sides) {
      exposure[sd.key] = round(sd.cand.E, 3);
      shares[sd.key] = round(shares[sd.key], 4);
      T[sd.key] = m.T ? round(m.T[sd.key], 2) : null;
      shares2[sd.key] = m.shares2 ? round(m.shares2[sd.key], 4) : null;
    }
    const near = {};
    for (const sd of m.sides) near[sd.key] = round(m.near[sd.key], 1);
    return {
      distances, squeeze: m.mode === 'hvhva' ? round(squeezeOf(m), 4) : null,
      shares, shares2, borders, kit: Object.assign({}, m.kit), rings: m.rings, nearest: near, exposure, elevation, T,
      gap: m.plan && m.plan.gap ? { Balterium: round(m.plan.gap.Balterium, 1), Biotics: round(m.plan.gap.Biotics, 1) } : null,
      kept: { Balterium: m.kept.Balterium.length, Biotics: m.kept.Biotics.length },
    };
  }

  // ── stage 1: cheap screen (Euclidean, vanilla amounts, no fields) ─────

  const expCache = new WeakMap();   // candidate -> {tau, e: Float64Array exp(-pd/tau)}

  function expOf(cand, tau) {
    let c = expCache.get(cand);
    if (c && c.tau === tau) return c.e;
    const pd = cand.pd, e = new Float64Array(pd.length);
    for (let k = 0; k < pd.length; k++) e[k] = Math.exp(-pd[k] / tau);
    expCache.set(cand, { tau, e });
    return e;
  }

  /** Vanilla values per patch in harvest-minutes (cached per ctx). */
  function vanillaValues(ctx) {
    const info = ctxInfo(ctx);
    if (!info.v0) {
      info.v0 = new Float64Array(ctx.patches.length);
      ctx.patches.forEach((p, k) => { info.v0[k] = (p.amount || 0) / (HARVEST_RATE[p.type] || 3000); });
    }
    return info.v0;
  }

  /**
   * Geometry part of the cheap screen: G2 rejection and T1 + T4 + kit proxy (weighted).
   * Returns {reject, partial}. opts.noReject: never reject (fallback when no set passes G2).
   */
  function cheapGeom(ctx, settings, set, opts) {
    const noReject = !!(opts && opts.noReject);
    const mode = settings.mode, sides = sidesOf(set, mode), ds = [];
    for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) ds.push(dist(sides[i].cand, sides[j].cand));
    const dstar = dStar(settings), floor = 0.85 * dstar;
    if (!noReject) for (const d of ds) if (d < floor) return { reject: true, partial: Infinity };
    let partial = 0;
    if (mode === 'hvhva') {
      const sq = squeeze3(ds[0], ds[1], ds[2]);
      if (sq < 0.3 && !noReject) return { reject: true, partial: Infinity };
      partial += weightOf(settings, 'T3', 1) * pos(0.6 - sq) / 0.2;
    }
    partial += weightOf(settings, 'T1', 1) * t1Of(ds, dstar, mode === 'hvhva');
    const wExp = settings.exposure && settings.exposure.weight != null ? settings.exposure.weight : 1;
    partial += weightOf(settings, 'T4', 1) * t4Of(sides.map(s => s.cand), wExp).value;
    if (mode !== 'hva') partial += Math.abs(set.Sol.nBalt - set.Cent.nBalt) * 0.5;
    return { reject: false, partial };
  }

  /** Euclidean soft-Voronoi T2 proxy on vanilla amounts (weighted penalty, own-type shares). */
  function cheapT2(ctx, settings, set) {
    const sides = sidesOf(set, settings.mode), tau = 0.15 * dStar(settings), info = ctxInfo(ctx);
    const v0 = vanillaValues(ctx), es = sides.map(s => expOf(s.cand, tau)), ns = sides.length;
    const T = new Float64Array(ns), tot = {};
    for (const type of ['Balterium', 'Biotics']) {
      const ks = info.byType[type];
      let anySide = false;
      for (let s = 0; s < ns; s++) if (sides[s].type === type) anySide = true;
      if (!anySide) continue;
      tot[type] = 0;
      for (let r = 0; r < ks.length; r++) {
        const k = ks[r];
        let sum = 0;
        for (let s = 0; s < ns; s++) sum += es[s][k];
        if (!(sum > 0)) continue;
        const vv = v0[k] / sum;
        tot[type] += v0[k];
        for (let s = 0; s < ns; s++) if (sides[s].type === type) T[s] += vv * es[s][k];
      }
    }
    // share of the own type, like T2
    for (let s = 0; s < ns; s++) T[s] = tot[sides[s].type] > 0 ? T[s] / tot[sides[s].type] : 0;
    return weightOf(settings, 'T2', 1) * (1 - balance(T)) / 0.10;
  }

  /**
   * Exact lower bound of evaluate().score from positions alone: weighted T1 + T4 (+ the
   * squeeze-softness part of T3 in hvhva); the other terms are >= 0. Used to skip refinement
   * moves that cannot beat the incumbent.
   */
  function lowerBound(ctx, settings, set) {
    const mode = settings.mode, sides = sidesOf(set, mode), ds = [];
    for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) ds.push(dist(sides[i].cand, sides[j].cand));
    const wExp = settings.exposure && settings.exposure.weight != null ? settings.exposure.weight : 1;
    let lb = weightOf(settings, 'T1', 1) * t1Of(ds, dStar(settings), mode === 'hvhva') +
      weightOf(settings, 'T4', 1) * t4Of(sides.map(q => q.cand), wExp).value;
    if (mode === 'hvhva') lb += weightOf(settings, 'T3', 1) * pos(0.6 - squeeze3(ds[0], ds[1], ds[2])) / 0.2;
    return lb;
  }

  /** Stage-1 score (spec 6.2): T1 + T4 + Euclidean T2 proxy + |delta nBalt| * 0.5. */
  function cheap(ctx, settings, set, opts) {
    const g = cheapGeom(ctx, settings, set, opts);
    if (g.reject) return { reject: true, score: Infinity };
    return { reject: false, score: g.partial + cheapT2(ctx, settings, set) };
  }

  // ── self-test (hand-computed fixtures) ────────────────────────────────

  function selftest() {
    const results = [];
    const close = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);
    const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

    // T1, hvh: d = 3000, d* = 2700 -> 300 / 405
    const v1 = t1Of([3000], 2700, false);
    add('T1 hvh: |3000-2700|/(0.15*2700) = 0.740741', close(v1, 300 / 405), v1);

    // T1, hvhva: 3-4-5 triangle (x1000), d* = 4000 -> 2000/600 + CV/0.1,
    // CV = sqrt(2e6/3)/4000 = 0.2041241
    const v2 = t1Of([3000, 4000, 5000], 4000, true);
    add('T1 hvhva 3-4-5, d*=4000: 3.333333 + 2.041241 = 5.374574', close(v2, 5.374574, 1e-5), v2);

    // squeeze: 3-4-5 right triangle -> rho = 1.4 at the right angle -> 0.4; equilateral -> 1;
    // collinear (A between B and C) -> 0
    const s1 = squeeze3(3000, 4000, 5000), s2 = squeeze3(2000, 2000, 2000), s3 = squeeze3(1000, 1000, 2000);
    add('squeeze 3-4-5 = 0.4', close(s1, 0.4), s1);
    add('squeeze equilateral = 1', close(s2, 1), s2);
    add('squeeze collinear = 0', close(s3, 0), s3);
    // isosceles with apex 100 deg: rho = 1/sin(50 deg) = 1.3054 -> 0.3054 (the G2 limit ~0.3)
    const apex = 100 * Math.PI / 180, legs = 1000, base = 2 * legs * Math.sin(apex / 2);
    const s4 = squeeze3(legs, legs, base);
    add('squeeze isosceles apex 100 deg = 0.305407', close(s4, 1 / Math.sin(apex / 2) - 1), s4);

    // T4: hvh, E = 0.3 / 0.5, z = 100 / 130, wExp 1 -> 0.8 + 0.2/0.3 + (30-15)/15 = 2.466667
    const e1 = t4Of([{ E: 0.3, z0: 100 }, { E: 0.5, z0: 130 }], 1).value;
    add('T4 hvh: 0.8 + 0.666667 + 1 = 2.466667', close(e1, 2.466667, 1e-5), e1);
    // T4 hvhva: + Alien E 0.4, z 110: 1.2 + 0.666667 + (1 + 0 + 0.333333) = 3.2
    const e2 = t4Of([{ E: 0.3, z0: 100 }, { E: 0.5, z0: 130 }, { E: 0.4, z0: 110 }], 1).value;
    add('T4 hvhva: 1.2 + 0.666667 + 1.333333 = 3.2', close(e2, 3.2, 1e-5), e2);
    // T4 elevation parity inside 15 m and wExp 0: only dE / 0.3
    const e3 = t4Of([{ E: 0.2, z0: 100 }, { E: 0.2, z0: 114 }], 0).value;
    add('T4 equal E, |dz| = 14 m, wExp 0 -> 0', close(e3, 0), e3);

    // soft Voronoi: one Balterium patch at d = 0 (Sol) and tau*ln3 (Cent) -> w = 0.75 / 0.25
    const tau = 100;
    const T = softTotals([[0], [tau * Math.log(3)]], [1], ['Balterium'], ['Balterium', 'Balterium'], tau);
    add('soft Voronoi w = 0.75 / 0.25', close(T[0], 0.75) && close(T[1], 0.25), Array.from(T));
    const S = softShares([[0], [tau * Math.log(3)]], [1], ['Balterium'], ['Balterium', 'Balterium'], tau).s;
    add('T2 shares 0.75 / 0.25 -> penalty (1 - 1/3)/0.1 = 6.666667',
      close(S[0], 0.75) && close(S[1], 0.25) && close((1 - balance(S)) / 0.10, 6.666667, 1e-5), Array.from(S));

    // G1 / G2 / G3 / G4 / T3 / T5 on a small synthetic context
    const fx = fixtureContext();
    const settings = {
      mode: 'hvh', enemyDistance: 990, radii: { build: 200, chain: 500, nest: 200 },
      counts: { balterium: 4, biotics: 2 }, minKit: 1, minKitAlien: 1, edgeMargin: 100,
      weights: { T1: 1, T2: 1, T3: 1, T4: 1, T5: 1 }, exposure: { weight: 1 },
    };
    const ev = evaluate(fx.ctx, settings, fx.set, fx.fields, fx.plan);
    add('fixture hvh: no gate fails', ev.gateFails.length === 0, ev.gateFails);
    add('fixture hvh: T1 = 0 at d = d*', close(ev.terms.T1, 0), ev.terms.T1);
    add('fixture hvh: T2 = 0 for mirrored patches', close(ev.terms.T2, 0, 1e-9), ev.terms.T2);
    add('fixture hvh: T3 = (1 - 0.4/0.6)/0.1 = 3.333333', close(ev.terms.T3, 3.333333, 1e-5), ev.terms.T3);
    add('fixture hvh: T5 = 0 (equal kit, equal nearest)', close(ev.terms.T5, 0), ev.terms.T5);
    const ev2 = evaluate(fx.ctx, Object.assign({}, settings, { enemyDistance: 1300 }), fx.set, fx.fields, fx.plan);
    add('fixture hvh: G2 fails at d* = 1300 (990 < 1105)', ev2.gateFails.indexOf('G2') >= 0, ev2.gateFails);
    const plan3 = Object.assign({}, fx.plan, { kept: { Balterium: [0, 2, 3], Biotics: [4, 5] } });
    const ev3 = evaluate(fx.ctx, settings, fx.set, fx.fields, plan3);
    add('fixture hvh: unequal kit -> G3 and G4 fail', ev3.gateFails.indexOf('G3') >= 0 && ev3.gateFails.indexOf('G4') >= 0, ev3.gateFails);
    const bad = Object.assign({}, fx.set.Sol, { px: 1, py: 1, x: fx.ctx.scan.minX + 15, z: fx.ctx.scan.maxZ - 15 });
    const ev4 = evaluate(fx.ctx, settings, { Sol: bad, Cent: fx.set.Cent }, fx.fields, fx.plan);
    add('fixture hvh: cell at the edge -> G1 fails', ev4.gateFails.indexOf('G1') >= 0, ev4.gateFails);
    const ch = cheap(fx.ctx, settings, fx.set);
    add('cheap: mirrored set not rejected, score = T4 part only', !ch.reject && close(ch.score, 0.4, 1e-6), ch);

    // T2 = share of the own type: hva, 2 Balterium round Sol mirrored by 10 Biotics round the
    // Nest (5 on each mirror point). Harvest-minutes differ ~5x, the shares are equal -> T2 = 0.
    const hx = hvaFixture();
    const sHva = Object.assign({}, settings, { mode: 'hva', counts: { balterium: 2, biotics: 10 } });
    const evH = evaluate(hx.ctx, sHva, hx.set, hx.fields, hx.plan);
    const sh2 = evH.metrics.shares2, Th = evH.metrics.T;
    add('fixture hva 10 Biotics vs 2 Balterium mirrored: T2 = 0, shares2 equal',
      close(evH.terms.T2, 0, 1e-9) && close(sh2.Sol, sh2.Alien, 1e-9) && Th.Alien > 4 * Th.Sol,
      { T2: evH.terms.T2, shares2: sh2, T: Th });
    add('fixture hva: no gate fails (G3 minKit applies to the hva human)', evH.gateFails.length === 0, evH.gateFails);
    const evH3 = evaluate(hx.ctx, Object.assign({}, sHva, { minKit: 3 }), hx.set, hx.fields, hx.plan);
    add('fixture hva: human kit 2 < minKit 3 -> G3 fails', evH3.gateFails.indexOf('G3') >= 0, evH3.gateFails);
    const chH = cheapT2(hx.ctx, sHva, hx.set);
    add('cheapT2 hva mirrored = 0 (own-type shares)', close(chH, 0, 1e-9), chH);

    return { ok: results.every(r => r.ok), results };
  }

  /**
   * Flat 2 km test map: scan 15 m, extent 1000, Sol at (-495, 0), Cent at (495, 0), 2 Balterium
   * ~100 m from each HQ (kit), Biotics mirrored; fields = Euclidean distances on the 101 grid.
   */
  function fixtureContext() {
    const patches = [
      { idx: 0, type: 'Balterium', x: -500, z: 100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 1, type: 'Balterium', x: -500, z: -100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 2, type: 'Balterium', x: 500, z: 100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 3, type: 'Balterium', x: 500, z: -100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 4, type: 'Biotics', x: 0, z: 600, y: 0, amount: 42000, w: 20, h: 20 },
      { idx: 5, type: 'Biotics', x: 0, z: -600, y: 0, amount: 42000, w: 20, h: 20 },
    ];
    const b = fixtureBase(patches);
    const set = { Sol: b.cand(0, -495, 0, 0.2), Cent: b.cand(1, 495, 0, 0.2) };
    const fields = {
      D: { Sol: b.field(set.Sol), Cent: b.field(set.Cent) }, owner: new Int8Array(b.n * b.n),
      shares: { Sol: 0.4, Cent: 0.6 }, borders: { 'Sol-Cent': 100 },
    };
    const plan = {
      kept: { Balterium: [0, 1, 2, 3], Biotics: [4, 5] }, removed: [], frozen: new Set([0, 1, 2, 3]),
      kit: { Sol: 2, Cent: 2 }, rings: {}, gap: { Balterium: 0, Biotics: 0 },
    };
    return { ctx: b.ctx, set, fields, plan };
  }

  /** hva on the same flat map: Sol (-495, 0) with 2 Balterium, Nest (495, 0) with 10 Biotics. */
  function hvaFixture() {
    const patches = [
      { idx: 0, type: 'Balterium', x: -500, z: 100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 1, type: 'Balterium', x: -500, z: -100, y: 0, amount: 40000, w: 20, h: 20 },
    ];
    for (let q = 0; q < 10; q++) {
      patches.push({ idx: 2 + q, type: 'Biotics', x: 500, z: q < 5 ? 100 : -100, y: 0, amount: 42000, w: 20, h: 20 });
    }
    const b = fixtureBase(patches);
    const sol = b.cand(0, -495, 0, 0.2), alien = Object.assign(b.cand(1, 495, 0, 0.2), { role: 'alien' });
    const set = { Sol: sol, Cent: sol, Alien: alien };
    const fields = {
      D: { Sol: b.field(sol), Cent: b.field(sol), Alien: b.field(alien) }, owner: new Int8Array(b.n * b.n),
      shares: { Sol: 0.5, Cent: 0.5, Alien: 0.5 }, borders: { 'Sol-Alien': 100 },
    };
    const kB = [0, 1], kO = patches.slice(2).map(p => p.idx);
    const plan = {
      kept: { Balterium: kB, Biotics: kO }, removed: [], frozen: new Set(kB.concat(kO)),
      kit: { Sol: 2, Alien: 10 }, rings: {}, gap: { Balterium: 0, Biotics: 0 },
    };
    return { ctx: b.ctx, set, fields, plan };
  }

  /**
   * Flat 2 km map for the fixtures: scan 15 m, extent 1000, all masks valid; cand(id, x, z, E)
   * builds a human candidate, field(c) its Euclidean field on the 101 grid.
   */
  function fixtureBase(patches) {
    const extent = 1000, step = 15, w = 133, minX = -990, maxZ = 990;
    const ones = new Uint8Array(w * w).fill(1);
    const n = 101, cell = 2 * extent / 100;
    const ctrl = { n, cell, minX: -extent, maxZ: extent, h: new Float32Array(n * n), playable: new Uint8Array(n * n).fill(1) };
    const ctx = {
      map: 'Fixture', baseMap: 'Fixture', extent, scan: { minX, maxZ, step, w, h: w },
      masks: { hqSol: ones, hqCent: ones, refSol: ones, refCent: ones }, heights: null,
      nestMask: ones, patches, ctrl,
    };
    const cand = (id, x, z, E) => {
      const px = Math.round((x - minX) / step), py = Math.round((maxZ - z) / step);
      const pd = new Float32Array(patches.length);
      patches.forEach((p, k) => { pd[k] = Math.hypot(p.x - x, p.z - z); });
      return { id, role: 'human', x, z, px, py, ci: 0, E, z0: 0, nBalt: 2, nBio: 0, ring1: 0, pd };
    };
    const field = c => {
      const f = new Float32Array(n * n);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) f[j * n + i] = Math.hypot(-extent + (i + 0.5) * cell - c.x, extent - (j + 0.5) * cell - c.z);
      }
      // the patch cells carry the exact distance, so mirrored patches stay mirrored
      const info = ctxInfo(ctx);
      patches.forEach((p, k) => { f[info.cells[k]] = Math.hypot(p.x - c.x, p.z - c.z); });
      return f;
    };
    return { ctx, n, cand, field };
  }

  return {
    PRESENTATION_BAR, HUMAN_FOOTPRINT, HARVEST_RATE, DEFAULT_AMOUNTS,
    registry, evaluate, cheap, cheapGeom, cheapT2, lowerBound,
    sidesOf, pairsOf, squeeze3, t1Of, t4Of, softTotals, softShares, balance,
    humanCellOk, alienCellOk, placementOk, ctxInfo,
    selftest, metrics_selftest: selftest,
  };
}));
