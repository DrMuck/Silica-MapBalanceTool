// Spawn generator search (docs/SPAWN_GENERATOR.md section 6): candidates -> stage-1 cheap
// screen over all sets -> stage-2 full evaluation (fields, plan, gates, terms) -> refinement of
// the top sets -> ranking with the distinctness filter. UMD, DOM-free; dependencies are looked
// up on the global at call time in the browser (script order rng, context, grid, candidates,
// patches, metrics, search).
//
// Determinism: one GenRng stream per run, consumed by GenCandidates.list (bin picks, tie
// breaks), the stage-1 tie keys and the refinement order. stableStringify(result) leaves out
// the wall-clock fields (stats.ms, stats.timing), so equal seed + inputs + settings give an
// identical string.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rng.js'), require('./grid.js'), require('./candidates.js'),
      require('./patches.js'), require('./metrics.js'), root, require('./context.js'));
  } else {
    root.GenSearch = factory(null, null, null, null, null, root, null);
  }
}(typeof self !== 'undefined' ? self : this, function (RngMod, GridMod, CandMod, PatchMod, MetMod, root, CtxMod) {
  'use strict';

  const Rng = () => RngMod || root.GenRng;
  const Grid = () => GridMod || root.GenGrid;
  const Cand = () => CandMod || root.GenCandidates;
  const Patches = () => PatchMod || root.GenPatches;
  const Met = () => MetMod || root.GenMetrics;
  const Ctx = () => CtxMod || root.GenContext;

  const VERSION = '1.0.0';
  const REFINE_TOP = 6;
  const BUCKET_CAP = 0.6;

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function cancelled() {
    const e = new Error('cancelled');
    e.cancelled = true;
    return e;
  }

  // ── set helpers ───────────────────────────────────────────────────────

  /** Structure keys a set moves independently (hva: Sol carries Cent). */
  function movable(mode) {
    return mode === 'hvh' ? ['Sol', 'Cent'] : mode === 'hva' ? ['Sol', 'Alien'] : ['Sol', 'Cent', 'Alien'];
  }

  function makeSet(mode, a, b, c) {
    if (mode === 'hvh') return { Sol: a, Cent: b };
    if (mode === 'hva') return { Sol: a, Cent: a, Alien: c };
    return { Sol: a, Cent: b, Alien: c };
  }

  function replaceIn(set, mode, key, cand) {
    const s = Object.assign({}, set);
    s[key] = cand;
    if (mode === 'hva' && key === 'Sol') s.Cent = cand;
    return s;
  }

  /** Canonical signature (scan cells; Sol/Cent ordered so the swapped set has the same key). */
  function signature(set, mode) {
    const c = q => q.px + ',' + q.py;
    if (mode === 'hva') return c(set.Sol) + '|' + c(set.Alien);
    const a = c(set.Sol), b = c(set.Cent);
    const h = a < b ? a + '|' + b : b + '|' + a;
    return mode === 'hvhva' ? h + '|' + c(set.Alien) : h;
  }

  function better(a, b) {
    // true if evaluation a ranks before b: (failed gates, score, signature)
    if (a.gateFails.length !== b.gateFails.length) return a.gateFails.length < b.gateFails.length;
    if (a.score !== b.score) return a.score < b.score;
    return a.sig < b.sig;
  }
  function cmpEval(a, b) { return better(a, b) ? -1 : better(b, a) ? 1 : 0; }

  function posClass(ctx, c) {
    const a = Math.abs(c.x) / ctx.extent, b = Math.abs(c.z) / ctx.extent;
    if (a > 0.5 && b > 0.5) return 'corner';
    if (a > 0.5 || b > 0.5) return 'edge';
    return 'inner';
  }

  // ── bounded pool (max-heap on score, keeps the best M) ────────────────

  function Pool(cap) {
    this.cap = cap;
    this.items = [];
  }
  Pool.prototype.worst = function () { return this.items.length < this.cap ? Infinity : this.items[0].score; };
  Pool.prototype.push = function (it) {
    const h = this.items;
    if (h.length < this.cap) {
      h.push(it);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!worse(h[i], h[p])) break;
        const t = h[i]; h[i] = h[p]; h[p] = t; i = p;
      }
      return;
    }
    if (!worse(h[0], it)) return;
    h[0] = it;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && worse(h[l], h[m])) m = l;
      if (r < h.length && worse(h[r], h[m])) m = r;
      if (m === i) break;
      const t = h[i]; h[i] = h[m]; h[m] = t; i = m;
    }
  };
  // a is worse than b: higher score, ties by the enumeration order (later = worse)
  function worse(a, b) { return a.score > b.score || (a.score === b.score && a.ord > b.ord); }

  // ── stage 1 ───────────────────────────────────────────────────────────

  function stage1(ctx, s, H, A, opts, stop) {
    const M = Met(), mode = s.mode, floor = 0.85 * s.enemyDistance, f2 = floor * floor;
    const K1 = s.stage1Keep || (mode === 'hvhva' ? 150 : 100);
    const pool = new Pool(Math.max(4 * K1, 400));
    let scored = 0, enumerated = 0, ord = 0, kitRejected = 0;
    const noReject = !!opts.noReject;
    // exact kits (spec 13): kit screen per human pair / Nest, null in auto mode
    const ks = kitScreen(ctx, s, mode);
    const offer = (set, ia, ib, ic, pen) => {
      enumerated++;
      const g = M.cheapGeom(ctx, s, set, opts);
      if (g.reject) return;
      scored++;
      const partial = pen ? g.partial + pen : g.partial;
      if (partial >= pool.worst()) return;
      const score = partial + M.cheapT2(ctx, s, set);
      pool.push({ score, ord: ord++, set, key: [ia, ib, ic] });
    };
    const d2 = (p, q) => (p.x - q.x) * (p.x - q.x) + (p.z - q.z) * (p.z - q.z);
    const nestPen = ks && A.length ? A.map(ks.nest) : null;

    if (mode === 'hvh') {
      for (let i = 0; i < H.length; i++) {
        if ((i & 15) === 0 && stop()) throw cancelled();
        for (let j = i + 1; j < H.length; j++) {
          if (!noReject && d2(H[i], H[j]) < f2) continue;
          let pen = 0;
          if (ks) { pen = ks.humans([H[i], H[j]]); if (pen === Infinity) { kitRejected++; continue; } }
          offer(makeSet(mode, H[i], H[j]), i, j, -1, pen);
        }
      }
    } else if (mode === 'hva') {
      for (let i = 0; i < H.length; i++) {
        if ((i & 15) === 0 && stop()) throw cancelled();
        let penH = 0;
        if (ks) { penH = ks.humans([H[i]]); if (penH === Infinity) { kitRejected += A.length; continue; } }
        for (let a = 0; a < A.length; a++) {
          if (!noReject && d2(H[i], A[a]) < f2) continue;
          offer(makeSet(mode, H[i], null, A[a]), i, -1, a, ks ? penH + nestPen[a] : 0);
        }
      }
    } else {
      for (let i = 0; i < H.length; i++) {
        if (stop()) throw cancelled();
        for (let j = i + 1; j < H.length; j++) {
          const dij2 = d2(H[i], H[j]);
          if (!noReject && dij2 < f2) continue;
          let penH = 0;
          if (ks) { penH = ks.humans([H[i], H[j]]); if (penH === Infinity) { kitRejected += A.length; continue; } }
          const dij = Math.sqrt(dij2);
          for (let a = 0; a < A.length; a++) {
            if (!noReject) {
              const dia2 = d2(H[i], A[a]);
              if (dia2 < f2) continue;
              const dja2 = d2(H[j], A[a]);
              if (dja2 < f2) continue;
              if (M.squeeze3(dij, Math.sqrt(dia2), Math.sqrt(dja2)) < 0.3) continue;
            }
            offer(makeSet(mode, H[i], H[j], A[a]), i, j, a, ks ? penH + nestPen[a] : 0);
          }
        }
      }
    }
    return { items: pool.items, K1, scored, enumerated, kitRejected };
  }

  /**
   * Exact-kit screen for stage 1 (spec 13.3), null in auto mode. humans(list) -> Infinity when
   * the plan cannot give every human n Balterium within R_b (kMax = fewest exclusive + shared
   * < n: G3 must fail, the set is dropped), else KIT_SHORT_PEN per Balterium the total would
   * miss (the frozen radii leave too few patches for counts.balterium: G4 must fail);
   * nest(alien) -> the same penalty for Biotics (the rest of R_n is removed).
   */
  const KIT_SHORT_PEN = 10;
  function kitScreen(ctx, s, mode) {
    const ex = Patches().exactKits(s), n = ex.human, m = mode === 'hvh' ? null : ex.alien;
    if (n === null && m === null) return null;
    const r = s.radii || {}, Rb = r.build || 1000, Rn = r.nest || 1200, P = ctx.patches, cnt = s.counts || {};
    const BK = [], OK = [];
    for (let k = 0; k < P.length; k++) { if (P[k].type === 'Balterium') BK.push(k); else if (P[k].type === 'Biotics') OK.push(k); }
    const wantB = cnt.balterium != null ? cnt.balterium : Math.round(0.75 * BK.length);
    const wantO = cnt.biotics != null ? cnt.biotics : Math.round(0.75 * OK.length);
    const humans = n === null ? () => 0 : hs => {
      const excl = hs.map(() => 0);
      let shared = 0, union = 0;
      for (const k of BK) {
        let c = 0, last = -1;
        for (let i = 0; i < hs.length; i++) if (hs[i].pd[k] <= Rb) { c++; last = i; }
        if (!c) continue;
        union++;
        if (c > 1) shared++; else excl[last]++;
      }
      const e = Math.min(...excl);
      if (e + shared < n) return Infinity;
      if (!(wantB < BK.length)) return 0;
      const kitTotal = hs.length * n - (hs.length - 1) * Math.max(0, n - e);
      return KIT_SHORT_PEN * Math.max(0, wantB - (BK.length - union + kitTotal));
    };
    const nest = m === null ? () => 0 : c => {
      if (!(wantO < OK.length)) return 0;
      let inside = 0;
      for (const k of OK) if (c.pd[k] <= Rn) inside++;
      return KIT_SHORT_PEN * Math.max(0, wantO - (OK.length - inside + Math.min(inside, m)));
    };
    return { humans, nest };
  }

  /**
   * Sort the pool, seeded tie keys, then the bucket cap (no class above 60 % of K1) and the
   * diversity rule: a set that is not distinctFrom an already shortlisted one at dmin / 2 is
   * skipped. A short list is filled up with the skipped sets, the diverse ones first.
   */
  function shortlist(ctx, s, items, K1, rng, dmin) {
    items.sort((a, b) => (a.score - b.score) || (a.ord - b.ord));
    for (const it of items) it.tie = rng.next();
    items.sort((a, b) => (a.score - b.score) || (a.tie - b.tie));
    const cap = Math.max(1, Math.floor(BUCKET_CAP * K1)), count = new Map(), out = [], skipped = [];
    const half = dmin / 2, diverse = it => out.every(o => distinctFrom(o, it, s.mode, half));
    for (const it of items) {
      if (out.length >= K1) break;
      const cls = movable(s.mode).map(k => posClass(ctx, it.set[k])).sort().join('+');
      const n = count.get(cls) || 0;
      if (n >= cap || !diverse(it)) { skipped.push(it); continue; }
      count.set(cls, n + 1);
      out.push(it);
    }
    // too few classes or too little diversity: fill up rather than shrink the list
    const rest = [];
    for (const it of skipped) {
      if (out.length >= K1) break;
      if (diverse(it)) out.push(it); else rest.push(it);
    }
    for (const it of rest) { if (out.length >= K1) break; out.push(it); }
    return out;
  }

  // ── stage 2 / refinement ──────────────────────────────────────────────

  /**
   * Key of the patch plan (GenPatches.plan) of a set: the plan depends on the structures only
   * through the kit orders, i.e. each human's Balterium inside R_b ordered by (geodesic,
   * Euclidean, idx) (this also fixes the paired-add tags), the Balterium inside two human
   * radii ordered by the larger of those, and the first kA Biotics of the Nest's order. Sets
   * with equal keys share one plan (most 15 m refinement moves) unless the plan made a paired
   * add: its partner choice reads the cells inside each human's R_b, so regionKey() is added.
   */
  function planKey(ctx, s, set, fields) {
    const r = s.radii || {}, Rb = r.build || 1000, Rn = r.nest || 1200, P = ctx.patches, pc = ctx.ctrl.patchCell;
    const geo = (role, c, k) => {
      const D = fields && fields.D && fields.D[role];
      return D ? D[pc[k]] : c.pd[k];
    };
    const order = (role, c, list) => list
      .map(k => ({ k, g: geo(role, c, k), e: c.pd[k] }))
      .sort((a, b) => (a.g - b.g) || (a.e - b.e) || (P[a.k].idx - P[b.k].idx));
    const parts = [], hs = [];
    for (const role of ['Sol', 'Cent']) {
      const c = set[role];
      if (!c || hs.some(h => h.c === c)) continue;
      hs.push({ role, c });
      const inside = [];
      for (let k = 0; k < P.length; k++) if (P[k].type === 'Balterium' && c.pd[k] <= Rb) inside.push(k);
      parts.push(role[0] + ':' + order(role, c, inside).map(o => o.k).join(','));
    }
    if (hs.length > 1) {
      const sh = [];
      for (let k = 0; k < P.length; k++) {
        if (P[k].type !== 'Balterium' || !hs.every(h => h.c.pd[k] <= Rb)) continue;
        sh.push({ k, g: Math.max(...hs.map(h => geo(h.role, h.c, k))), e: Math.max(...hs.map(h => h.c.pd[k])) });
      }
      sh.sort((a, b) => (a.g - b.g) || (a.e - b.e) || (P[a.k].idx - P[b.k].idx));
      if (sh.length) parts.push('X:' + sh.map(o => o.k).join(','));
    }
    if (set.Alien) {
      const c = set.Alien, inside = [];
      for (let k = 0; k < P.length; k++) if (P[k].type === 'Biotics' && c.pd[k] <= Rn) inside.push(k);
      const cnt = s.counts || {};
      let nO = 0;
      for (const p of P) if (p.type === 'Biotics') nO++;
      const want = cnt.biotics != null ? cnt.biotics : Math.round(0.75 * nO);
      // exact Nest kit (spec 13.3): every Biotics inside R_n is fixed (kept or removed) -> all of them
      const kA = Patches().exactKits(s).alien !== null ? inside.length
        : Math.min(inside.length, Patches().alienKitCap(want, hs.length));
      parts.push('A:' + order('Alien', c, inside).slice(0, kA).map(o => o.k).join(','));
    }
    // the layer cap (spec 12.3) reads each human's layer zone, so the plan depends on it too
    if (hs.length > 1) parts.push('Z:' + Patches().layerZones(ctx, s, set, fields).join(','));
    // spec 15.8: kit eligibility depends on the HQ position (footprint), not only on the orders
    const C = Ctx();
    if (C && C.placeMask && C.placeMask(ctx) && ctx.place.hasGoods) {
      const sm = C.setMask(ctx, set), inel = [];
      for (const h of hs) for (let k = 0; k < P.length; k++) {
        if (P[k].type === 'Balterium' && h.c.pd[k] <= Rb && !C.eligibleAt(ctx, k, h.c)) inel.push(k);
      }
      parts.push('E:' + inel.join(',') + '/' + Array.from(sm).join(''));
    }
    return parts.join('|');
  }

  /** Human positions (the paired-add regions of GenPatches.plan are cells within R_b of them). */
  function regionKey(set) {
    const hs = [];
    for (const role of ['Sol', 'Cent']) if (set[role] && !hs.includes(set[role])) hs.push(set[role]);
    return 'R:' + hs.map(c => c.x + ',' + c.z).join(';');
  }

  /** Per-structure kit / ring report of a shared plan for this set (same rule as GenPatches). */
  function planFor(ctx, s, set, base) {
    const r = s.radii || {}, Rb = r.build || 1000, Rc = r.chain || 2500, Rn = r.nest || 1200;
    const P = ctx.patches, am = s.amounts || {}, kit = {}, rings = {};
    const keep = new Set(base.kept.Balterium.concat(base.kept.Biotics));
    for (const role of ['Sol', 'Cent', 'Alien']) {
      const c = set[role];
      if (!c) continue;
      const t = role === 'Alien' ? 'Biotics' : 'Balterium', R0 = role === 'Alien' ? Rn : Rb, R1 = R0 + Rc;
      const r0 = { n: 0, amount: 0 }, r1 = { n: 0, amount: 0 };
      for (let k = 0; k < P.length; k++) {
        if (P[k].type !== t || !keep.has(P[k].idx)) continue;
        const v = (t === 'Balterium' ? am.balterium : am.biotics) || P[k].amount || 0, d = c.pd[k];
        if (d <= R0) { r0.n++; r0.amount += v; } else if (d <= R1) { r1.n++; r1.amount += v; }
      }
      kit[role] = r0.n;
      rings[role] = { r0, r1 };
    }
    return Object.assign({}, base, { kit, rings });
  }

  function evalSet(ctx, s, set, cache, memo, plans) {
    const sig = signature(set, s.mode);
    if (memo.has(sig)) return memo.get(sig);
    const fields = Grid().fields(ctx, s, set, cache);
    let pk = planKey(ctx, s, set, fields), hit = plans.get(pk), plan;
    if (hit && hit.paired) { pk += '|' + regionKey(set); hit = plans.get(pk); }
    if (hit) plan = planFor(ctx, s, set, hit);
    else {
      plan = Patches().plan(ctx, s, set, fields);
      plans.set(pk, plan);
      // a paired plan stays under the kit key as the marker that the regions matter
      if (plan.paired && pk.indexOf('|R:') < 0) plans.set(pk + '|' + regionKey(set), plan);
    }
    const ev = Met().evaluate(ctx, s, set, fields, plan);
    ev.sig = sig;
    memo.set(sig, ev);
    return ev;
  }

  function neighbourCells(c, bin) {
    const out = [];
    for (const r of [1, bin]) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (dx || dy) out.push([c.px + dx * r, c.py + dy * r]);
      }
    }
    return out;
  }

  function refine(ctx, s, ev, rng, cache, memo, plans, candAt, stop, skipped) {
    const keys = movable(s.mode), bin = Math.max(1, Math.round(120 / ctx.scan.step));
    let cur = ev;
    for (let round = 0; round < (s.refineRounds != null ? s.refineRounds : 2); round++) {
      const order = rng.shuffle(keys.slice());
      let moved = false;
      for (const key of order) {
        if (stop()) throw cancelled();
        const c = cur.set[key];
        let best = cur;
        for (const [px, py] of neighbourCells(c, bin)) {
          const nc = candAt(c.role, px, py);
          if (!nc) continue;
          const set = replaceIn(cur.set, s.mode, key, nc);
          // exact skip: with no gate failing, a move whose position-only lower bound already
          // reaches the incumbent's score cannot rank before it
          if (!best.gateFails.length && !memo.has(signature(set, s.mode)) && Met().lowerBound(ctx, s, set) >= best.score) { skipped.n++; continue; }
          const e = evalSet(ctx, s, set, cache, memo, plans);
          if (better(e, best)) best = e;
        }
        if (best !== cur) { cur = best; moved = true; }
      }
      if (!moved) break;
    }
    return cur;
  }

  // ── presentation ──────────────────────────────────────────────────────

  function d(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

  /**
   * B is distinct from A when, under the Sol/Cent assignment that matches A best (least total
   * displacement), the mean displacement of the structures is >= dmin and the largest is
   * >= dmin (spec 6.5): one structure may stay near its place when the others move.
   */
  function distinctFrom(a, b, mode, dmin) {
    const keys = movable(mode);
    const assigns = [keys.map(k => [k, k])];
    if (mode !== 'hva') assigns.push(keys.map(k => [k, k === 'Sol' ? 'Cent' : k === 'Cent' ? 'Sol' : k]));
    let bestTot = Infinity, bestMax = 0;
    for (const as of assigns) {
      let tot = 0, mx = 0;
      for (const [kb, ka] of as) {
        const v = d(b.set[kb], a.set[ka]);
        tot += v;
        if (v > mx) mx = v;
      }
      if (tot < bestTot) { bestTot = tot; bestMax = mx; }
    }
    return bestTot / keys.length >= dmin && bestMax >= dmin;
  }

  function leanCand(c) {
    return { id: c.id, role: c.role, x: c.x, z: c.z, px: c.px, py: c.py, ci: c.ci, E: c.E, z0: c.z0, nBalt: c.nBalt, nBio: c.nBio, ring1: c.ring1 };
  }

  function leanSet(set) {
    const out = {}, seen = new Map();
    for (const k of ['Sol', 'Cent', 'Alien']) {
      const c = set[k];
      if (!c) continue;
      if (!seen.has(c)) seen.set(c, leanCand(c));
      out[k] = seen.get(c);   // hva: Sol === Cent stays the same object
    }
    return out;
  }

  // ── run ───────────────────────────────────────────────────────────────

  /**
   * GenResult = {settings, settingsHash, seed, version, ctrl: {n, cell, minX, maxZ},
   *   candidates: Evaluation[] (presented, ranked; each + rank, sig, owner Int8Array,
   *   ownerSides, aboveBar), stats: {candidates, stage1Sets, stage1Enumerated, stage2Sets,
   *   refined, fallback, kitRange: {humanMax, alienMax}, ms, timing}}.
   * Infeasible request (spec 13.5): candidates [] plus infeasible {reason, detail}, reason one of
   * kit_invalid, nest_invalid, kit_budget, nest_budget, kit_candidates, nest_candidates, no_set,
   * kit_total, nest_total
   * (and no_candidates when the map has no valid spot at all); never thrown.
   * Throws an Error with .cancelled = true when shouldStop() returns true.
   */
  function run(ctx, settings, onProgress, shouldStop) {
    const t0 = now(), s = settings, mode = s.mode;
    if (mode !== 'hvh' && mode !== 'hva' && mode !== 'hvhva') throw new Error(`GenSearch.run: unknown mode ${mode}`);
    const prog = typeof onProgress === 'function' ? onProgress : () => {};
    const stop = typeof shouldStop === 'function' ? shouldStop : () => false;
    const rng = Rng().create(s.seed);
    const timing = {};
    let t = now();

    // 1. candidates
    prog(0.02, 'candidates');
    const H = Cand().list(ctx, s, 'human', rng);
    const cutH = ctx.stats && ctx.stats.candidates && ctx.stats.candidates.human ? ctx.stats.candidates.human.cutE : Infinity;
    let A = [], cutA = Infinity;
    if (mode !== 'hvh') {
      A = Cand().list(ctx, s, 'alien', rng);
      cutA = ctx.stats && ctx.stats.candidates && ctx.stats.candidates.alien ? ctx.stats.candidates.alien.cutE : Infinity;
    }
    timing.candidates = now() - t;
    if (stop()) throw cancelled();

    const result = {
      version: VERSION, settings: s, settingsHash: settingsHash(s), seed: s.seed,
      ctrl: ctx.ctrl ? { n: ctx.ctrl.n, cell: ctx.ctrl.cell, minX: ctx.ctrl.minX, maxZ: ctx.ctrl.maxZ } : null,
      candidates: [],
      stats: { candidates: { human: H.length, alien: A.length }, stage1Sets: 0, stage1Enumerated: 0, stage2Sets: 0, refined: 0, fallback: false, ms: 0, timing },
    };
    // spec 13.2: the largest kit any unfiltered spot reaches (the UI shows it as the maximum)
    const cs = (ctx.stats && ctx.stats.candidates) || {};
    result.stats.kitRange = {
      humanMax: cs.human && typeof cs.human.maxKit === 'number' ? cs.human.maxKit : null,
      alienMax: mode !== 'hvh' && cs.alien && typeof cs.alien.maxKit === 'number' ? cs.alien.maxKit : null,
    };
    // spec 15.4: {enabled, required, ineligible, missing, ineligibleIdx}; absent when the setting is off
    const place = Ctx() && Ctx().placeStats ? Ctx().placeStats(ctx) : null;
    if (place) result.stats.placeability = place;
    const infeasible = (reason, detail, text) => {
      result.candidates = [];
      result.infeasible = { reason, detail };
      result.stats.ms = Math.round(now() - t0);
      prog(1, text || `infeasible: ${reason}`);
      return result;
    };
    const exact = exactCheck(ctx, s, mode, H, A, result.stats.kitRange);
    if (exact.fail) return infeasible(exact.fail.reason, exact.fail.detail);
    if (!H.length || (mode !== 'hvh' && !A.length)) {
      return infeasible('no_candidates', `no valid ${!H.length ? 'HQ' : 'Nest'} spot on this map`, 'no candidates');
    }

    // 2. stage 1
    prog(0.1, 'stage 1');
    t = now();
    let st = stage1(ctx, s, H, A, {}, stop);
    if (!st.items.length) {
      // nothing passes G2: rank by the soft terms alone, the gates then name the failure
      st = stage1(ctx, s, H, A, { noReject: true }, stop);
      result.stats.fallback = true;
    }
    const dmin = s.distinctness != null ? s.distinctness : (2 * ctx.extent >= 4000 ? 800 : 500);
    const short = shortlist(ctx, s, st.items, st.K1, rng, dmin);
    result.stats.stage1Sets = st.scored;
    result.stats.stage1Enumerated = st.enumerated;
    timing.stage1 = now() - t;

    // 3. stage 2
    t = now();
    const cache = new Map(), memo = new Map(), plans = new Map();
    let evals = [];
    for (let q = 0; q < short.length; q++) {
      if (stop()) throw cancelled();
      if ((q & 7) === 0) prog(0.4 + 0.35 * q / short.length, `stage 2: ${q}/${short.length}`);
      evals.push(evalSet(ctx, s, short[q].set, cache, memo, plans));
    }
    result.stats.stage2Sets = evals.length;
    evals.sort(cmpEval);
    timing.stage2 = now() - t;

    // 4. refinement of the top sets
    t = now();
    const candMemo = new Map();
    const candAt = (role, px, py) => {
      const key = role + px + ',' + py;
      if (candMemo.has(key)) return candMemo.get(key);
      let c = null;
      if (Cand().valid(ctx, s, role, px, py)) {
        c = Cand().at(ctx, s, role, px, py);
        if (c.E > (role === 'alien' ? cutA : cutH)) c = null;   // G1 exposure cut
        // exact kits (spec 13.2): the same necessary condition as the candidate list
        else if (role === 'alien' ? (exact.alien !== null && c.nBio < exact.alien) : (exact.human !== null && c.nBalt < exact.human)) c = null;
      }
      candMemo.set(key, c);
      return c;
    };
    const nRef = Math.min(REFINE_TOP, evals.length), memoBefore = memo.size, skipped = { n: 0 };
    for (let q = 0; q < nRef; q++) {
      prog(0.75 + 0.2 * q / nRef, `refine ${q + 1}/${nRef}`);
      evals[q] = refine(ctx, s, evals[q], rng, cache, memo, plans, candAt, stop, skipped);
    }
    result.stats.refined = memo.size - memoBefore;
    result.stats.fields = cache.size;
    result.stats.plans = new Set(plans.values()).size;
    result.stats.refineSkipped = skipped.n;
    timing.refine = now() - t;

    // 5. ranking + distinctness
    const seen = new Set();
    evals = evals.filter(e => (seen.has(e.sig) ? false : (seen.add(e.sig), true)));
    evals.sort(cmpEval);
    if (!evals.length) {
      return infeasible('no_set', exact.on
        ? 'no start set passes the kit screen (every pair of spots shares too much of its kit, or nothing passes stage 1)'
        : 'no start set can be formed from the candidates');
    }
    // exact kits (spec 13.5): only sets passing G1-G3 are presented, no fallback
    // and a set whose fill ran dry below the total (kit_total / nest_total, G4) is never shown
    if (exact.on) {
      const pass = evals.filter(e => !e.gateFails.some(g => g === 'G1' || g === 'G2' || g === 'G3'));
      if (!pass.length) return infeasible('no_set', noSetDetail(evals[0], evals.length, exact, mode));
      const full = pass.filter(e => !e.gateFails.includes('G4') && !totalFails(e).length);
      if (!full.length) {
        const t = totalDetail(pass, exact, s);
        return infeasible(t.reason, t.detail);
      }
      evals = full;
    }
    const topN = s.topN || 5;
    const shown = [];
    for (const e of evals) {
      if (shown.length >= topN) break;
      if (shown.every(a => distinctFrom(a, e, mode, dmin))) shown.push(e);
    }
    result.stats.distinctness = dmin;
    const bar = Met().PRESENTATION_BAR;
    result.candidates = shown.map((e, i) => {
      const f = Grid().fields(ctx, s, e.set, cache);
      return {
        rank: i + 1, sig: e.sig, set: leanSet(e.set), gateFails: e.gateFails.slice(), terms: e.terms,
        score: e.score, aboveBar: e.score > bar, metrics: e.metrics, plan: e.plan,
        owner: f.owner, ownerSides: f.sides,
      };
    });
    result.stats.ms = Math.round(now() - t0);
    prog(1, 'done');
    return result;
  }

  // ── exact kits (spec 13.5) ────────────────────────────────────────────

  /**
   * Validates the exact-kit settings and checks the budget / candidate conditions of spec 13.5.
   * -> {on, human, alien, fail: null | {reason, detail}}; human / alien are null when auto (the
   * Nest setting is ignored in hvh).
   */
  function exactCheck(ctx, s, mode, H, A, range) {
    const P = Patches(), out = { on: false, human: null, alien: null, fail: null };
    const hRaw = P.exactOf(s.kitExact), aRaw = mode === 'hvh' ? null : P.exactOf(s.nestKitExact);
    if (Number.isNaN(hRaw)) { out.fail = { reason: 'kit_invalid', detail: `start Balterium must be a whole number >= 0 or empty (auto), got ${JSON.stringify(s.kitExact)}` }; return out; }
    if (Number.isNaN(aRaw)) { out.fail = { reason: 'nest_invalid', detail: `start Biotics must be a whole number >= 0 or empty (auto), got ${JSON.stringify(s.nestKitExact)}` }; return out; }
    out.human = hRaw; out.alien = aRaw; out.on = hRaw !== null || aRaw !== null;
    if (!out.on) return out;
    const v = ctx.vanilla || { Balterium: 0, Biotics: 0 }, c = s.counts || {};
    const totB = Math.min(c.balterium != null ? c.balterium : Math.round(0.75 * v.Balterium), v.Balterium);
    const totO = Math.min(c.biotics != null ? c.biotics : Math.round(0.75 * v.Biotics), v.Biotics);
    const nH = mode === 'hva' ? 1 : 2, r = s.radii || {}, Rb = r.build || 1000, Rn = r.nest || 1200;
    if (out.human !== null && out.human * nH > totB) {
      out.fail = { reason: 'kit_budget', detail: `kit needs ${out.human * nH} Balterium (${out.human} x ${nH}), total is ${totB}` };
    } else if (out.alien !== null && out.alien > totO) {
      out.fail = { reason: 'nest_budget', detail: `Nest kit needs ${out.alien} Biotics, total is ${totO}` };
    } else if (out.human !== null && H.length < nH) {
      const max = range && range.humanMax != null ? range.humanMax : '?';
      // spec 15.5: with placeability on, the counts are placeable Balterium only
      const pl = Ctx() && Ctx().placeMask ? Ctx().placeMask(ctx) : null;
      out.fail = { reason: 'kit_candidates', detail: `${H.length} HQ spot(s) reach ${out.human}${pl ? ' placeable' : ''} Balterium within ${Rb} m, ${nH} needed; max reachable on this map: ${max}` };
    } else if (out.alien !== null && !A.length) {
      const max = range && range.alienMax != null ? range.alienMax : '?';
      out.fail = { reason: 'nest_candidates', detail: `no Nest spot reaches ${out.alien} Biotics within ${Rn} m; max: ${max}` };
    }
    return out;
  }

  function totalFails(e) {
    const f = (e.plan && e.plan.failures) || [];
    return f.filter(x => x === 'kit_total' || x === 'nest_total');
  }

  /**
   * kit_total / nest_total (spec 13.5): every set passing G1-G3 misses a total. Reason = the
   * best such set's first total failure (Biotics first when it misses both); X = the largest
   * achievable kept count of that type over those sets.
   */
  function totalDetail(pass, exact, s) {
    const best = pass[0], tf = totalFails(best);
    const reason = tf.includes('nest_total') ? 'nest_total' : tf.includes('kit_total') ? 'kit_total'
      : (best.plan && best.plan.achievable && best.plan.achievable.Biotics < best.plan.target.Biotics ? 'nest_total' : 'kit_total');
    const type = reason === 'nest_total' ? 'Biotics' : 'Balterium';
    let X = 0;
    for (const e of pass) {
      const a = e.plan && e.plan.achievable ? e.plan.achievable[type] : (e.plan && e.plan.kept ? e.plan.kept[type].length : 0);
      if (a > X) X = a;
    }
    const c = s.counts || {}, Y = type === 'Biotics' ? c.biotics : c.balterium;
    const kitTxt = type === 'Biotics'
      ? `m=${exact.alien !== null ? exact.alien : 'auto'}` : `n=${exact.human !== null ? exact.human : 'auto'}`;
    return { reason, detail: `with ${kitTxt}, at most ${X} ${type} can be kept on this map (requested ${Y}); lower the total or the kit` };
  }

  /** Detail of a no_set result: the best evaluated set's gate fails and kits. */
  function noSetDetail(best, nEval, exact, mode) {
    const kit = (best.metrics && best.metrics.kit) || {}, keys = mode === 'hva' ? ['Sol', 'Alien'] : ['Sol', 'Cent', 'Alien'];
    const kitTxt = keys.filter(k => kit[k] !== undefined).map(k => `${k} ${kit[k]}`).join(' / ');
    const want = [exact.human !== null ? `${exact.human} per human` : null, exact.alien !== null ? `${exact.alien} for the Nest` : null].filter(Boolean).join(', ');
    const pf = best.plan && best.plan.failures && best.plan.failures.length ? ` (${best.plan.failures.join(', ')})` : '';
    return `no start set passes G1-G3 (${nEval} evaluated); best set fails ${best.gateFails.join(', ') || '-'}${pf}, kit ${kitTxt || '-'}, wanted ${want}`;
  }

  // ── hashing / stable serialisation ────────────────────────────────────

  function canon(v, dropTiming) {
    if (v === null || typeof v !== 'object') return typeof v === 'number' && !isFinite(v) ? String(v) : v;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (v instanceof Set) return Array.from(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (v instanceof Map) return Array.from(v.entries()).map(([k, x]) => [k, canon(x, false)]);
    if (Array.isArray(v)) return v.map(x => canon(x, false));
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (dropTiming && (k === 'ms' || k === 'timing')) continue;
      out[k] = canon(v[k], k === 'stats');
    }
    return out;
  }

  /** JSON with sorted keys, typed arrays/Sets as arrays, stats.ms/timing removed. */
  function stableStringify(result) { return JSON.stringify(canon(result, false)); }

  /** Settings hash (FNV-1a over the canonical settings without the seed). */
  function settingsHash(settings) {
    const c = canon(settings, false);
    delete c.seed;
    return Rng().hashString(JSON.stringify(c));
  }

  return { VERSION, run, stableStringify, settingsHash, signature, distinctFrom, movable };
}));
