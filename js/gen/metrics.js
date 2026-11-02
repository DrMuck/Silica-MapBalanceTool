// Spawn generator: hard gates G1-G5, soft terms T1-T4 + T6, the stage-1 cheap screen and the
// metrics self-test (docs/SPAWN_GENERATOR.md sections 3, 6.2 and 12). UMD, DOM-free.
// G5 / T6 read the expansion curve V(k) of GenExpansion (js/gen/expansion.js, spec 12.5).
//
// Sides: hvh = Sol, Cent; hva = Sol (the one human position, set.Sol === set.Cent) and Alien;
// hvhva = Sol, Cent, Alien. Every pair of sides is an enemy pair. Distances in the gates and
// in T1 are Euclidean (G2); the soft Voronoi of T2 reads the control fields.
// Placeability (spec 15.4, GenContext.placeMask): ineligible Balterium is not counted in the
// human kits / rings / nearest (G3), in T2 (and the stage-1 T2 proxy) or in V(k) (G5 / T6,
// via GenExpansion); G4 still counts every kept patch. T3 is area only and does not change.
// T7 placement ease balance (spec 15.4) exists only while the feature is active (registry
// entry with active()); with the setting off it is absent from terms and score.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let grid = null;
    try { grid = require('./grid.js'); } catch (e) { grid = null; }
    module.exports = factory(grid, require('./expansion.js'), root, require('./context.js'));
  } else {
    root.GenMetrics = factory(root.GenGrid, null, root, null);
  }
}(typeof self !== 'undefined' ? self : this, function (GenGrid, ExpMod, root, CtxMod) {
  'use strict';

  // browser: looked up on the global at call time (script order does not matter)
  const Exp = () => ExpMod || (root && root.GenExpansion) || null;
  const Ctx = () => CtxMod || (root && root.GenContext) || null;
  /** GenContext.placeMask (spec 15.4): per patch k, 0 = ineligible Balterium; null = all count. */
  function placeMask(ctx) { const C = Ctx(); return C && C.placeMask ? C.placeMask(ctx) : null; }
  /** GenContext.placeNGood (spec 15.4): {F: n_good per patch k} of the required factions, or null. */
  function placeNGood(ctx) { const C = Ctx(); return C && C.placeNGood ? C.placeNGood(ctx) : null; }
  /** GenContext.eligibleAt / setMask / placeNEff (spec 15.8: eligibility with the HQ footprint). */
  function eligibleAt(ctx, k, pos, role) { return Ctx().eligibleAt(ctx, k, pos, role); }
  /** spec 15.9: swap off splits the factions by side (ctx.place.split). */
  function splitSides(ctx) { return !!(ctx && ctx.place && ctx.place.enabled && ctx.place.split); }
  function setMask(ctx, set) { const C = Ctx(); return C && C.setMask ? C.setMask(ctx, set) : null; }

  const EASE_CAP = 200;   // spec 15.4: n_good saturates at 200 (~ Sol's median)

  /**
   * Placement ease (spec 15.4 / 15.8), cached on m: {F: {A, B}} with A = Sol side, B = Cent side
   * (hva: A only) = mean over the side's kit Balterium (kept, eligible, within R_b) of
   * min(n_eff_F, 200) / 200 (n_eff = n_good minus the placements the HQ square of F at that
   * side blocks; 0 for an empty kit); null when the feature is inactive.
   */
  function easeOf(ctx, m) {
    if (m.ease !== undefined) return m.ease;
    const ng = placeNGood(ctx);
    if (!ng) { m.ease = null; return null; }
    const Rb = m.R.build, out = {}, C = Ctx();
    const humans = m.sides.filter(sd => sd.human);
    for (const f of Object.keys(ng)) {
      out[f] = {};
      humans.forEach((sd, i) => {
        if (C.sideFactions(ctx, sd.key).indexOf(f) < 0) return;   // spec 15.9: the side's own factions
        let sum = 0, n = 0;
        for (const k of m.kept.Balterium) {
          if (sd.cand.pd[k] > Rb || !eligibleAt(ctx, k, sd.cand, sd.key)) continue;
          sum += Math.min(Math.max(C.placeNEff(ctx, k, sd.cand, f), 0), EASE_CAP) / EASE_CAP;
          n++;
        }
        out[f][i === 0 ? 'A' : 'B'] = n ? sum / n : 0;
      });
    }
    m.ease = out;
    return out;
  }

  /**
   * T7 = mean over the required factions of |ease_F(A) - ease_F(B)|, scaled / 0.10 like T2/T3; 0
   * in hva. split (swap off, spec 15.9): |ease_Sol(A) - ease_Cent(B)| / 0.10.
   */
  function t7Of(ease, split) {
    if (split) return ease && ease.Sol && ease.Cent ? Math.abs((ease.Sol.A || 0) - (ease.Cent.B || 0)) / 0.10 : 0;
    const fs = Object.keys(ease || {});
    if (!fs.length) return 0;
    let s = 0;
    for (const f of fs) s += ease[f].B === undefined ? 0 : Math.abs(ease[f].A - ease[f].B);
    return s / fs.length / 0.10;
  }

  const PRESENTATION_BAR = 3.0;
  const HUMAN_FOOTPRINT = 67;          // circumscribed HQ footprint radius (m), G1
  const HARVEST_RATE = { Balterium: 3000, Biotics: 3300 };   // amount per harvest-minute (T2)
  const DEFAULT_AMOUNTS = { balterium: 40000, biotics: 42000 };
  const DEFAULT_EXPANSION = { K: 3, reach: 0.85, w: [0.45, 0.35, 0.20] };   // spec 12.5 / 12.8

  // ── settings helpers ──────────────────────────────────────────────────

  function radii(settings) {
    const r = (settings && settings.radii) || {};
    return { build: r.build || 1000, chain: r.chain || 2500, nest: r.nest || 1200 };
  }
  /** settings.weights[id], else the registry default of the term. */
  function weightOf(settings, id) {
    const w = settings && settings.weights;
    if (w && typeof w[id] === 'number') return w[id];
    const e = registry.find(q => q.id === id);
    return e ? e.weight : 1;
  }
  /** {K, reach, w}: settings.expansion over the spec defaults; w cut to K entries, sum 1. */
  function expansionParams(settings) {
    const e = (settings && settings.expansion) || {};
    const K = Number.isInteger(e.K) && e.K >= 1 ? e.K : DEFAULT_EXPANSION.K;
    const reach = typeof e.reach === 'number' && e.reach > 0 ? e.reach : DEFAULT_EXPANSION.reach;
    return { K, reach, w: curveWeights(Array.isArray(e.w) ? e.w : DEFAULT_EXPANSION.w, K) };
  }
  /** The first K curve weights normalised to sum 1 (equal weights when w is short or invalid). */
  function curveWeights(w, K) {
    let out = [];
    for (let k = 0; k < K; k++) out.push(typeof w[k] === 'number' && w[k] >= 0 ? w[k] : NaN);
    if (out.some(v => !isFinite(v))) out = out.map(() => 1);
    const sum = out.reduce((a, b) => a + b, 0);
    return sum > 0 ? out.map(v => v / sum) : out.map(() => 1 / K);
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
   * T6 (spec 12.2) from the curves Vs = [V_i] (one array of K values per human): ratio_k =
   * min_i V_i(k) / max_i V_i(k) (1 when all are 0), T6 = (1 - sum_k w_k ratio_k) / 0.10.
   */
  function t6Of(Vs, w) {
    const ratio = [];
    let s = 0;
    for (let k = 0; k < w.length; k++) {
      const r = balance(Vs.map(V => V[k] || 0));
      ratio.push(r);
      s += w[k] * r;
    }
    return { value: (1 - s) / 0.10, ratio };
  }

  /** G5 (spec 12.2): max_i - min_i over the humans of V(1) <= 1 and of V(K) <= 2. */
  function g5Of(Vs) {
    if (Vs.length < 2) return true;
    const spread = k => {
      const xs = Vs.map(V => V[k] || 0);
      return Math.max(...xs) - Math.min(...xs);
    };
    return spread(0) <= 1 && spread(Vs[0].length - 1) <= 2;
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
  function softShares(D, v, typeOf, sideType, tau, ok) {
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
      // ok[s][r] = 0: resource r does not count for side s (spec 15.9, swap off); absent = counts
      for (let s = 0; s < ns; s++) if (sideType[s] === typeOf[r] && (!ok || !ok[s] || ok[s][r])) T[s] += v[r] * e[s] / sum;
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
    const kit = {}, rings = {}, near = {}, el = placeMask(ctx);
    for (const sd of sides) {
      const pd = sd.cand.pd, type = sd.type;
      const r0 = sd.human ? R.build : R.nest, r1 = r0 + R.chain, v = amountOf(settings, type);
      let n0 = 0, n1 = 0, dn = Infinity;
      for (const k of kept[type]) {
        if (el && !eligibleAt(ctx, k, sd.cand, sd.key)) continue;   // spec 15.4 / 15.8 / 15.9: in no human kit
        const d = pd[k];
        if (d <= r0) n0++;
        else if (d <= r1) n1++;
        if (d < dn) dn = d;
      }
      kit[sd.key] = n0;
      rings[sd.key] = { r0: { n: n0, amount: n0 * v }, r1: { n: n1, amount: n1 * v } };
      near[sd.key] = dn;
    }
    return { mode, set, sides, pairs, kept, kit, rings, near, R, info, fields, plan };
  }

  /**
   * Expansion curves of the humans (spec 12.1), once per evaluation (cached on m):
   * {keys: [human key], Vs: [V per human], res: {[key]: {V, cells, layer}}, K}. hva: the one
   * human position (reported, not scored). Own side = fields.owner; without fields the
   * Euclidean rule against the other structures.
   */
  function expansionOf(ctx, settings, m) {
    if (m.exp) return m.exp;
    const X = Exp();
    if (!X) throw new Error('GenMetrics: GenExpansion (js/gen/expansion.js) is not loaded');
    const K = expansionParams(settings).K;
    const keptBalt = new Uint8Array(ctx.patches.length);
    for (const k of m.kept.Balterium) keptBalt[k] = 1;
    const fsides = m.fields && Array.isArray(m.fields.sides) ? m.fields.sides : null;
    const keys = [], Vs = [], res = {};
    m.sides.forEach((sd, s) => {
      if (!sd.human) return;
      const idx = fsides ? fsides.indexOf(sd.key) : s;
      const others = m.sides.filter(o => o.cand !== sd.cand).map(o => o.cand);
      const r = X.curve(ctx, settings, sd.cand, idx, m.fields || null, keptBalt, K, others, sd.key);
      keys.push(sd.key);
      Vs.push(r.V);
      res[sd.key] = r;
    });
    m.exp = { keys, Vs, res, K };
    return m.exp;
  }

  // ── registry ──────────────────────────────────────────────────────────

  const ALL = ['hvh', 'hva', 'hvhva'];

  /** Exact kit setting (spec 13.1): the whole number >= 0, else null (auto). */
  function exactKit(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null; }

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
        // spec 13.4: an exact kit (whole number >= 0) must be met exactly; a plan that could not
        // reach it says so in plan.failures
        const exH = exactKit(settings.kitExact), exA = exactKit(settings.nestKitExact);
        // (kit_total / nest_total are budget misses: G4 reports them, not G3)
        if (m.plan && Array.isArray(m.plan.failures) && m.plan.failures.some(f => f === 'kit_exact' || f === 'nest_exact')) return false;
        // every human kit >= minKit (hva too: its one human position), equal in hvh / hvhva
        const hs = m.sides.filter(s => s.human).map(s => m.kit[s.key]);
        if (exH !== null) { for (const n of hs) if (n !== exH) return false; }
        else for (const n of hs) if (n !== hs[0] || n < minKit) return false;
        if (m.mode !== 'hvh') {
          if (exA !== null) { if (m.kit.Alien !== exA) return false; }
          else if (m.kit.Alien < minKitA) return false;
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
      id: 'G5', kind: 'hard', modes: ['hvh', 'hvhva'], weight: 1, label: 'G5 expansion',
      compute(ctx, settings, set, m) {
        return g5Of(expansionOf(ctx, settings, m).Vs);
      },
    },
    {
      id: 'T1', kind: 'soft', modes: ALL, weight: 1, label: 'T1 separation',
      compute(ctx, settings, set, m) {
        return t1Of(m.pairs.map(p => p.d), dStar(settings), m.mode === 'hvhva');
      },
    },
    {
      id: 'T2', kind: 'soft', modes: ALL, weight: 0.5, label: 'T2 resources over control',
      compute(ctx, settings, set, m) {
        // balance of the shares of each side's own resource type; T (harvest-minutes) is reported
        const r = territoryTotals(ctx, settings, m);
        m.T = r.T;
        m.shares2 = r.s;
        return (1 - balance(Object.values(r.s))) / 0.10;
      },
    },
    {
      id: 'T3', kind: 'soft', modes: ALL, weight: 0.5, label: 'T3 control balance',
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
      id: 'T6', kind: 'soft', modes: ['hvh', 'hvhva'], weight: 1, label: 'T6 expansion balance',
      compute(ctx, settings, set, m) {
        const t = t6Of(expansionOf(ctx, settings, m).Vs, expansionParams(settings).w);
        m.expRatio = t.ratio;
        return t.value;
      },
    },
    {
      // spec 15.4: only while placeability is active (absent otherwise, so the round-5 score
      // stays byte-identical); 0 in hva (one human)
      id: 'T7', kind: 'soft', modes: ALL, weight: 0.5, label: 'T7 placement ease balance',
      active(ctx) { return !!placeNGood(ctx); },
      compute(ctx, settings, set, m) {
        return m.mode === 'hva' ? 0 : t7Of(easeOf(ctx, m), splitSides(ctx));
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
    const info = m.info, tau = 0.15 * dStar(settings), el = setMask(ctx, m.set);
    // spec 15.4: ineligible Balterium counts for no side (only the humans harvest Balterium)
    const ks = (el ? m.kept.Balterium.filter(k => el[k]) : m.kept.Balterium).concat(m.kept.Biotics);
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
    // spec 15.9: with swap off a patch counts only for the sides whose factions can use it
    let ok = null;
    if (el && splitSides(ctx)) {
      ok = m.sides.map(sd => {
        if (!sd.human) return null;
        const a = new Uint8Array(ks.length);
        for (let r = 0; r < ks.length; r++) a[r] = typeOf[r] !== 'Balterium' || eligibleAt(ctx, ks[r], sd.cand, sd.key) ? 1 : 0;
        return a;
      });
    }
    const r = softShares(D, v, typeOf, m.sides.map(s => s.type), tau, ok);
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
      if (e.active && !e.active(ctx, settings)) continue;
      if (e.kind === 'hard') {
        if (!e.compute(ctx, settings, set, m)) gateFails.push(e.id);
      } else {
        const v = e.compute(ctx, settings, set, m);
        terms[e.id] = v;
        score += weightOf(settings, e.id) * v;
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
    // expansion curves (spec 12.5): every mode reports them, hvh / hvhva also the min/max ratios
    const ex = expansionOf(ctx, settings, m), expansion = {}, c = ctx.ctrl;
    for (const key of ex.keys) {
      const r = ex.res[key];
      expansion[key] = {
        V: r.V.slice(), layer: r.layer,
        cells: r.cells.map(ci => (ci >= 0 ? { x: round(c.cx[ci], 1), z: round(c.cz[ci], 1) } : null)),
      };
    }
    let expansionRatio = null;
    if (ex.keys.length > 1) expansionRatio = (m.expRatio || t6Of(ex.Vs, expansionParams(settings).w).ratio).map(v => round(v, 4));
    const out = {
      distances, squeeze: m.mode === 'hvhva' ? round(squeezeOf(m), 4) : null,
      shares, shares2, borders, kit: Object.assign({}, m.kit), rings: m.rings, nearest: near, exposure, elevation, T,
      gap: m.plan && m.plan.gap ? { Balterium: round(m.plan.gap.Balterium, 1), Biotics: round(m.plan.gap.Biotics, 1) } : null,
      kept: { Balterium: m.kept.Balterium.length, Biotics: m.kept.Biotics.length },
      expansion, expansionRatio,
    };
    // spec 15.4: placement ease per required faction and human side (A = Sol, B = Cent); only
    // when the feature is active (no key otherwise: round-5 bytes)
    const ease = easeOf(ctx, m);
    if (ease) {
      out.placeEase = {};
      for (const f of Object.keys(ease)) {
        out.placeEase[f] = {};
        for (const s of Object.keys(ease[f])) out.placeEase[f][s] = round(ease[f][s], 4);
      }
    }
    return out;
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
      partial += weightOf(settings, 'T3') * pos(0.6 - sq) / 0.2;
    }
    partial += weightOf(settings, 'T1') * t1Of(ds, dstar, mode === 'hvhva');
    const wExp = settings.exposure && settings.exposure.weight != null ? settings.exposure.weight : 1;
    partial += weightOf(settings, 'T4') * t4Of(sides.map(s => s.cand), wExp).value;
    if (mode !== 'hva') {
      partial += Math.abs(set.Sol.nBalt - set.Cent.nBalt) * 0.5;
      // expansion proxy (spec 12.2): |V1_solo(Sol) - V1_solo(Cent)| * settings.expansion.proxy.
      // Default 0: at the spec's 0.5 the full harness lost the gap check on GreatErg hvhva and
      // equal-or-worse top-1 scores on 38/39 rows (G5 / min-max targets met either way), since
      // the vanilla, enemy-blind V1_solo displaced good sets from the stage-1 shortlist.
      const kx = settings.expansion && typeof settings.expansion.proxy === 'number' ? settings.expansion.proxy : 0;
      if (kx) partial += Math.abs(v1Solo(ctx, settings, set.Sol) - v1Solo(ctx, settings, set.Cent)) * kx;
    }
    return { reject: false, partial };
  }

  /** cand.v1solo (GenCandidates.at precomputes it); computed and stored once when missing. */
  function v1Solo(ctx, settings, cand) {
    if (typeof cand.v1solo !== 'number') {
      const X = Exp();
      cand.v1solo = X ? X.solo(ctx, settings, cand) : 0;
    }
    return cand.v1solo;
  }

  /** Euclidean soft-Voronoi T2 proxy on vanilla amounts (weighted penalty, own-type shares). */
  function cheapT2(ctx, settings, set) {
    const sides = sidesOf(set, settings.mode), tau = 0.15 * dStar(settings), info = ctxInfo(ctx);
    const v0 = vanillaValues(ctx), es = sides.map(s => expOf(s.cand, tau)), ns = sides.length, el = placeMask(ctx);
    const T = new Float64Array(ns), tot = {};
    for (const type of ['Balterium', 'Biotics']) {
      const ks = info.byType[type];
      let anySide = false;
      for (let s = 0; s < ns; s++) if (sides[s].type === type) anySide = true;
      if (!anySide) continue;
      tot[type] = 0;
      for (let r = 0; r < ks.length; r++) {
        const k = ks[r];
        if (el && !el[k]) continue;   // spec 15.4: like T2
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
    return weightOf(settings, 'T2') * (1 - balance(T)) / 0.10;
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
    let lb = weightOf(settings, 'T1') * t1Of(ds, dStar(settings), mode === 'hvhva') +
      weightOf(settings, 'T4') * t4Of(sides.map(q => q.cand), wExp).value;
    if (mode === 'hvhva') lb += weightOf(settings, 'T3') * pos(0.6 - squeeze3(ds[0], ds[1], ds[2])) / 0.2;
    return lb;
  }

  /**
   * Stage-1 score (spec 6.2, 12.2): T1 + T4 + Euclidean T2 proxy + |delta nBalt| * 0.5 +
   * |delta V1_solo| * settings.expansion.proxy (default 0, see cheapGeom).
   */
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

    // T6 / G5 formulas (spec 12.2, 12.6): V_Sol = [6,6,6], V_Cent = [2,4,6]
    const w0 = expansionParams({}).w;
    const t6 = t6Of([[6, 6, 6], [2, 4, 6]], w0).value;
    add('T6 [6,6,6] vs [2,4,6], w 0.45/0.35/0.20 = (1 - (0.15 + 0.233333 + 0.2))/0.1 = 4.166667', close(t6, 4.166667, 1e-5), t6);
    add('T6 both curves 0 -> ratio 1 -> 0', close(t6Of([[0, 0, 0], [0, 0, 0]], w0).value, 0), t6Of([[0, 0, 0], [0, 0, 0]], w0));
    add('G5: [6,6,6] vs [2,4,6] fails; [7,9,11] vs [6,8,9] passes; [7,9,11] vs [6,8,8] fails (dK 3)',
      !g5Of([[6, 6, 6], [2, 4, 6]]) && g5Of([[7, 9, 11], [6, 8, 9]]) && !g5Of([[7, 9, 11], [6, 8, 8]]));
    const wK2 = expansionParams({ expansion: { K: 2, w: [0.45, 0.35, 0.20] } }).w;
    add('curve weights cut to K = 2 and normalised: 0.5625 / 0.4375', close(wK2[0], 0.5625) && close(wK2[1], 0.4375) && wK2.length === 2, wK2);

    // G1 / G2 / G3 / G4 / T3 / T6 on a small synthetic context
    const fx = fixtureContext();
    const settings = {
      mode: 'hvh', enemyDistance: 990, radii: { build: 200, chain: 500, nest: 200 },
      counts: { balterium: 4, biotics: 2 }, minKit: 1, minKitAlien: 1, edgeMargin: 100,
      weights: { T1: 1, T2: 1, T3: 1, T4: 1, T6: 1 }, exposure: { weight: 1 },
    };
    const ev = evaluate(fx.ctx, settings, fx.set, fx.fields, fx.plan);
    add('fixture hvh: no gate fails', ev.gateFails.length === 0, ev.gateFails);
    add('fixture hvh: T1 = 0 at d = d*', close(ev.terms.T1, 0), ev.terms.T1);
    add('fixture hvh: T2 = 0 for mirrored patches', close(ev.terms.T2, 0, 1e-9), ev.terms.T2);
    add('fixture hvh: T3 = (1 - 0.4/0.6)/0.1 = 3.333333', close(ev.terms.T3, 3.333333, 1e-5), ev.terms.T3);
    add('fixture hvh: no expansion patches -> V = 0/0, T6 = 0, G5 holds',
      close(ev.terms.T6, 0) && ev.metrics.expansion.Sol.V.join() === '0,0,0' && ev.metrics.expansion.Cent.V.join() === '0,0,0',
      { T6: ev.terms.T6, expansion: ev.metrics.expansion });
    const ev2 = evaluate(fx.ctx, Object.assign({}, settings, { enemyDistance: 1300 }), fx.set, fx.fields, fx.plan);
    add('fixture hvh: G2 fails at d* = 1300 (990 < 1105)', ev2.gateFails.indexOf('G2') >= 0, ev2.gateFails);
    const plan3 = Object.assign({}, fx.plan, { kept: { Balterium: [0, 2, 3], Biotics: [4, 5] } });
    const ev3 = evaluate(fx.ctx, settings, fx.set, fx.fields, plan3);
    add('fixture hvh: unequal kit -> G3 and G4 fail', ev3.gateFails.indexOf('G3') >= 0 && ev3.gateFails.indexOf('G4') >= 0, ev3.gateFails);
    // spec 13.4: exact kit = n passes, n + 1 fails, a plan failure fails
    const kS = ev.metrics.kit.Sol;
    const evK = evaluate(fx.ctx, Object.assign({}, settings, { kitExact: kS }), fx.set, fx.fields, fx.plan);
    const evK1 = evaluate(fx.ctx, Object.assign({}, settings, { kitExact: kS + 1 }), fx.set, fx.fields, fx.plan);
    const evKf = evaluate(fx.ctx, Object.assign({}, settings, { kitExact: kS }), fx.set, fx.fields, Object.assign({}, fx.plan, { failures: ['kit_exact'] }));
    add('fixture hvh: G3 exact kit n passes, n + 1 fails, plan failure kit_exact fails',
      evK.gateFails.indexOf('G3') < 0 && evK1.gateFails.indexOf('G3') >= 0 && evKf.gateFails.indexOf('G3') >= 0,
      { kit: kS, exact: evK.gateFails, plus1: evK1.gateFails, failure: evKf.gateFails });
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
    add('fixture hva: no G5 / T6, the curve is reported for the one human',
      !('T6' in evH.terms) && evH.metrics.expansion.Sol && !evH.metrics.expansion.Cent && evH.metrics.expansionRatio === null,
      { terms: evH.terms, expansion: evH.metrics.expansion });

    // spec 12.6 fixture: R_b 200, R_c 500, reach 425. Sol has one cluster of 6 within R_b of
    // one cell, Cent the same 6 as three pairs >= 527 m apart -> V_Sol [6,6,6], V_Cent [2,4,6]
    const ex = expansionFixture(false), sEx = Object.assign({}, settings, { counts: { balterium: 16, biotics: 2 } });
    const evX = evaluate(ex.ctx, sEx, ex.set, ex.fields, ex.plan), mx = evX.metrics.expansion;
    add('expansion fixture: V_Sol = [6,6,6], V_Cent = [2,4,6], layer 6/6',
      mx.Sol.V.join() === '6,6,6' && mx.Cent.V.join() === '2,4,6' && mx.Sol.layer === 6 && mx.Cent.layer === 6, mx);
    add('expansion fixture: T6 = 4.166667, ratios 1/3, 2/3, 1',
      close(evX.terms.T6, 4.166667, 1e-5) && close(evX.metrics.expansionRatio[0], 0.3333, 1e-4) && close(evX.metrics.expansionRatio[2], 1),
      { T6: evX.terms.T6, ratio: evX.metrics.expansionRatio });
    add('expansion fixture: only G5 fails', evX.gateFails.join() === 'G5', evX.gateFails);
    const exM = expansionFixture(true), evM = evaluate(exM.ctx, sEx, exM.set, exM.fields, exM.plan);
    add('expansion fixture mirrored (both one cluster of 6): G5 holds, T6 = 0',
      evM.gateFails.length === 0 && close(evM.terms.T6, 0) && evM.metrics.expansion.Cent.V.join() === '6,6,6',
      { fails: evM.gateFails, T6: evM.terms.T6, expansion: evM.metrics.expansion });
    const sPx = Object.assign({}, sEx, { expansion: { proxy: 0.5 } });
    const gX = cheapGeom(ex.ctx, sPx, ex.set), gM = cheapGeom(exM.ctx, sPx, exM.set);
    const g0 = cheapGeom(ex.ctx, sEx, ex.set).partial - cheapGeom(exM.ctx, sEx, exM.set).partial;
    add('stage-1 proxy 0.5: V1_solo 6 vs 2 adds |6 - 2| * 0.5 = 2 over the mirrored set; default (0) adds nothing',
      ex.set.Sol.v1solo === 6 && ex.set.Cent.v1solo === 2 && close(gX.partial - gM.partial, 2, 1e-9) && close(g0, 0, 1e-9),
      { solo: [ex.set.Sol.v1solo, ex.set.Cent.v1solo], dPartial: gX.partial - gM.partial, dDefault: g0 });

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
      D: { Sol: b.field(set.Sol), Cent: b.field(set.Cent) }, owner: b.splitOwner(),
      shares: { Sol: 0.4, Cent: 0.6 }, borders: { 'Sol-Cent': 100 },
    };
    const plan = {
      kept: { Balterium: [0, 1, 2, 3], Biotics: [4, 5] }, removed: [], frozen: new Set([0, 1, 2, 3]),
      kit: { Sol: 2, Cent: 2 }, rings: {}, gap: { Balterium: 0, Biotics: 0 },
    };
    return { ctx: b.ctx, set, fields, plan };
  }

  /**
   * Spec 12.6 expansion fixture on the flat map (R_b 200, R_c 500): the hvh fixture's kits plus
   * a cluster of 6 Balterium round (-495, 400) for Sol and, for Cent, three pairs round
   * (495, 390), (495, -390), (850, 0) (mirrored = Cent gets the mirrored cluster instead).
   */
  function expansionFixture(mirrored) {
    const patches = [
      { idx: 0, type: 'Balterium', x: -500, z: 100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 1, type: 'Balterium', x: -500, z: -100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 2, type: 'Balterium', x: 500, z: 100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 3, type: 'Balterium', x: 500, z: -100, y: 0, amount: 40000, w: 20, h: 20 },
      { idx: 4, type: 'Biotics', x: 0, z: 600, y: 0, amount: 42000, w: 20, h: 20 },
      { idx: 5, type: 'Biotics', x: 0, z: -600, y: 0, amount: 42000, w: 20, h: 20 },
    ];
    const add = (x, z) => patches.push({ idx: patches.length, type: 'Balterium', x, z, y: 0, amount: 40000, w: 20, h: 20 });
    const cluster = sx => { for (let q = 0; q < 6; q++) add(sx * 495 + 30 * Math.cos(q * Math.PI / 3), 400 + 30 * Math.sin(q * Math.PI / 3)); };
    cluster(-1);
    if (mirrored) cluster(1);
    else for (const [x, z] of [[495, 390], [495, -390], [850, 0]]) { add(x - 10, z); add(x + 10, z); }
    const b = fixtureBase(patches);
    const set = { Sol: b.cand(0, -495, 0, 0.2), Cent: b.cand(1, 495, 0, 0.2) };
    const fields = {
      D: { Sol: b.field(set.Sol), Cent: b.field(set.Cent) }, owner: b.splitOwner(), sides: ['Sol', 'Cent'],
      shares: { Sol: 0.5, Cent: 0.5 }, borders: { 'Sol-Cent': 100 },
    };
    const kB = patches.filter(p => p.type === 'Balterium').map(p => p.idx);
    const plan = {
      kept: { Balterium: kB, Biotics: [4, 5] }, removed: [], frozen: new Set([0, 1, 2, 3]),
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
      D: { Sol: b.field(sol), Cent: b.field(sol), Alien: b.field(alien) }, owner: b.splitOwner(), sides: ['Sol', 'Alien'],
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
   * Flat 2 km map for the fixtures: scan 15 m, extent 1000, all masks valid (every control cell
   * hqOk); cand(id, x, z, E) builds a human candidate, field(c) its Euclidean field on the 101
   * grid, splitOwner() the owner array of a West (0) / East (1) split at x = 0.
   */
  function fixtureBase(patches) {
    const extent = 1000, step = 15, w = 133, minX = -990, maxZ = 990;
    const ones = new Uint8Array(w * w).fill(1);
    const n = 101, N = n * n, cell = 2 * extent / 100;
    const cx = new Float32Array(N), cz = new Float32Array(N);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) { cx[j * n + i] = -extent + (i + 0.5) * cell; cz[j * n + i] = extent - (j + 0.5) * cell; }
    }
    const patchDist = patches.map(p => {
      const d = new Float32Array(N);
      for (let c = 0; c < N; c++) d[c] = Math.hypot(cx[c] - p.x, cz[c] - p.z);
      return d;
    });
    const ctrl = {
      n, cell, minX: -extent, maxZ: extent, h: new Float32Array(N), playable: new Uint8Array(N).fill(1),
      hqOk: new Uint8Array(N).fill(1), cx, cz, patchDist,
    };
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
    const splitOwner = () => {
      const o = new Int8Array(N);
      for (let c = 0; c < N; c++) o[c] = cx[c] < 0 ? 0 : 1;
      return o;
    };
    ctrl.patchCell = ctxInfo(ctx).cells;
    return { ctx, n, cand, field, splitOwner };
  }

  return {
    PRESENTATION_BAR, HUMAN_FOOTPRINT, HARVEST_RATE, DEFAULT_AMOUNTS,
    registry, evaluate, cheap, cheapGeom, cheapT2, lowerBound,
    sidesOf, pairsOf, squeeze3, t1Of, t4Of, t6Of, t7Of, g5Of, expansionParams, softTotals, softShares, balance, weightOf,
    humanCellOk, alienCellOk, placementOk, ctxInfo,
    selftest, metrics_selftest: selftest,
  };
}));
