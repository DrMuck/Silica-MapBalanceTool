// Random fair search (docs/SPAWN_GENERATOR.md section 14): several GenSearch runs over a band of
// enemy distances with random run seeds, pooled and ranked by the fair score (score without the
// distance-target part of T1). UMD, DOM-free. Uses GenRng, GenSearch, GenMetrics.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rng.js'), require('./search.js'), require('./metrics.js'), root);
  } else {
    root.GenRandom = factory(null, null, null, root);
  }
}(typeof self !== 'undefined' ? self : this, function (RngMod, SearchMod, MetMod, root) {
  'use strict';

  const Rng = () => RngMod || root.GenRng;
  const Search = () => SearchMod || root.GenSearch;
  const Met = () => MetMod || root.GenMetrics;
  const VERSION = '1.0.0';
  const D_MIN = 800, D_MAX = 5000, RUNS_MIN = 2, RUNS_MAX = 60;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function round50(v) { return Math.round(v / 50) * 50; }
  function clampD(v) { return Math.max(D_MIN, Math.min(D_MAX, v)); }

  /** Default band for a map's default distance d0 (spec 14.1): [0.6 d0, 1.4 d0] on 50 m. */
  function defaultBand(d0) {
    return [clampD(round50(0.6 * d0)), clampD(round50(1.4 * d0))];
  }

  /** settings.random normalised: {runs (2-60), band [lo, hi] (800-5000, lo <= hi)}. */
  function params(settings) {
    const r = settings.random || {};
    const runs = Math.max(RUNS_MIN, Math.min(RUNS_MAX, Math.round(Number(r.runs) || 12)));
    const b = Array.isArray(r.band) ? r.band : defaultBand(settings.enemyDistance || 2000);
    let lo = clampD(Number(b[0]) || D_MIN), hi = clampD(Number(b[1]) || D_MAX);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    return { runs, band: [lo, hi] };
  }

  /** Spec 14.2: stratified distances over the band, random run seeds, one stream from settings.seed. */
  function plan(settings) {
    const { runs, band } = params(settings);
    const rng = Rng().create(settings.seed);
    const out = [];
    for (let i = 0; i < runs; i++) {
      const u = rng.next();
      const enemyDistance = round50(band[0] + (band[1] - band[0]) * (i + u) / runs);
      const seed = Math.floor(rng.next() * 2147483648);
      out.push({ index: i, enemyDistance: clampD(enemyDistance), seed });
    }
    return out;
  }

  /**
   * The settings of one run: the base with d* and seed replaced and no `random` key, so its
   * settings hash and layout are exactly those of a normal Generate with these values.
   */
  function runSettings(settings, p) {
    const s = Object.assign({}, settings, { enemyDistance: p.enemyDistance, seed: p.seed });
    delete s.random;
    return s;
  }

  /** Enemy pair distances of a (lean) set in the order of GenMetrics.sidesOf / lowerBound. */
  function pairDistances(set, mode) {
    const sides = Met().sidesOf(set, mode), ds = [];
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        ds.push(Math.hypot(sides[i].cand.x - sides[j].cand.x, sides[i].cand.z - sides[j].cand.z));
      }
    }
    return ds;
  }

  function weightT1(settings) {
    const w = settings.weights && settings.weights.T1;
    return Number.isFinite(w) ? w : 1;
  }

  /** Spec 14.3: F = score - w_T1 * sum |d - d*| / (0.15 d*); the hvhva CV part stays in F. */
  function fair(ev, dstar, settings) {
    const ds = pairDistances(ev.set, settings.mode);
    return ev.score - weightT1(settings) * Met().t1Of(ds, dstar, false);
  }

  function failCount(ev) { return (ev.gateFails || []).length; }

  function cmpPool(a, b) {
    const fa = failCount(a), fb = failCount(b);
    if (fa !== fb) return fa - fb;
    if (a.fair !== b.fair) return a.fair - b.fair;
    return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0;
  }

  function cancelled() {
    const e = new Error('cancelled');
    e.cancelled = true;
    return e;
  }

  /**
   * RandomResult (spec 14.5): {version, kind: 'random', settings, searchSeed, plan, infeasible?,
   * runs: [{index, enemyDistance, seed, ms, nResults, infeasible, stats}],
   * candidates: [GenResult candidate + fair, run: {index, enemyDistance, seed, rank, score}],
   * stats: {ms, pool, runsOk, runsInfeasible, distinctness, kitRange}}.
   */
  function run(ctx, settings, onProgress, shouldStop) {
    const t0 = now(), s = settings, mode = s.mode;
    const prog = typeof onProgress === 'function' ? onProgress : () => {};
    const stop = typeof shouldStop === 'function' ? shouldStop : () => false;
    const prm = params(s), pl = plan(s);
    const lo = 0.85 * prm.band[0], hi = 1.15 * prm.band[1];
    const result = {
      version: VERSION, kind: 'random', settings: s, searchSeed: s.seed, plan: pl,
      runs: [], candidates: [],
      stats: { ms: 0, pool: 0, runsOk: 0, runsInfeasible: 0, distinctness: null, kitRange: null },
    };
    const pool = [], reasons = {};
    for (const p of pl) {
      if (stop()) throw cancelled();
      const rs = runSettings(s, p), n = pl.length, i = p.index;
      const tr = now();
      const res = Search().run(ctx, rs, (frac, text) => {
        prog((i + Math.max(0, Math.min(1, frac || 0))) / n, `run ${i + 1}/${n} · d* ${p.enemyDistance} m: ${text || ''}`);
      }, stop);
      const entry = {
        index: i, enemyDistance: p.enemyDistance, seed: p.seed, ms: Math.round(now() - tr),
        nResults: res.candidates.length, infeasible: res.infeasible || null, stats: res.stats,
      };
      result.runs.push(entry);
      if (res.stats && res.stats.kitRange) result.stats.kitRange = res.stats.kitRange;
      if (res.stats && res.stats.distinctness != null) result.stats.distinctness = res.stats.distinctness;
      if (res.infeasible) {
        result.stats.runsInfeasible++;
        reasons[res.infeasible.reason] = (reasons[res.infeasible.reason] || 0) + 1;
        continue;
      }
      result.stats.runsOk++;
      for (const c of res.candidates) {
        const ds = pairDistances(c.set, mode);
        if (ds.some(d => d < lo || d > hi)) continue;   // spec 14.3 band filter
        pool.push(Object.assign({}, c, {
          fair: fair(c, p.enemyDistance, s),
          run: { index: i, enemyDistance: p.enemyDistance, seed: p.seed, rank: c.rank, score: c.score },
        }));
      }
    }
    result.stats.pool = pool.length;

    if (!result.stats.runsOk) {
      let best = null;
      for (const k of Object.keys(reasons).sort()) if (!best || reasons[k] > reasons[best]) best = k;
      const first = result.runs.find(r => r.infeasible && r.infeasible.reason === best);
      result.infeasible = { reason: best || 'no_set', detail: `all ${pl.length} runs: ${first ? first.infeasible.detail : 'no result'}` };
      result.stats.ms = Math.round(now() - t0);
      prog(1, `infeasible: ${result.infeasible.reason}`);
      return result;
    }

    // spec 14.4: gate-failing sets only when nothing passes
    pool.sort(cmpPool);
    const passing = pool.filter(e => !failCount(e));
    const ranked = passing.length ? passing : pool;
    const dmin = result.stats.distinctness != null ? result.stats.distinctness : 500;
    const topN = s.topN || 5, shown = [];
    for (const e of ranked) {
      if (shown.length >= topN) break;
      if (shown.every(a => Search().distinctFrom(a, e, mode, dmin))) shown.push(e);
    }
    result.candidates = shown.map((e, k) => Object.assign(e, { rank: k + 1 }));
    result.stats.ms = Math.round(now() - t0);
    prog(1, 'done');
    return result;
  }

  // ── self-test (no map data): plan, runSettings, fair score ─────────────

  function selftest() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
    const close = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);
    const base = { mode: 'hvh', seed: 7, enemyDistance: 2000, weights: { T1: 1 }, random: { runs: 12, band: [1200, 2800] } };
    const p1 = plan(base), p2 = plan(base), p3 = plan(Object.assign({}, base, { seed: 8 }));
    add('plan: same search seed -> same plan', JSON.stringify(p1) === JSON.stringify(p2), p1.slice(0, 2));
    add('plan: other search seed -> other plan', JSON.stringify(p1) !== JSON.stringify(p3));
    const strat = p1.every((p, i) => p.enemyDistance >= 1200 + 1600 * i / 12 - 25 && p.enemyDistance <= 1200 + 1600 * (i + 1) / 12 + 25 && p.enemyDistance % 50 === 0);
    add('plan: d* stratified over the band, on 50 m', strat, p1.map(p => p.enemyDistance));
    add('plan: run seeds are whole numbers in [0, 2^31)', p1.every(p => Number.isInteger(p.seed) && p.seed >= 0 && p.seed < 2147483648));
    const pc = params({ enemyDistance: 2000, random: { runs: 100, band: [6000, 500] } });
    add('params: runs clamped to 60, band ordered and clamped to 800-5000', pc.runs === 60 && pc.band[0] === 800 && pc.band[1] === 5000, pc);
    add('defaultBand(2000) = [1200, 2800]', defaultBand(2000).join() === '1200,2800', defaultBand(2000));
    const rs = runSettings(base, p1[3]);
    add('runSettings: d* and seed replaced, no random key, base untouched',
      rs.enemyDistance === p1[3].enemyDistance && rs.seed === p1[3].seed && !('random' in rs) && base.random && base.seed === 7, rs);
    const hvh = { set: { Sol: { x: 0, z: 0 }, Cent: { x: 3000, z: 0 } }, score: 2 };
    const f1 = fair(hvh, 2700, base);
    add('fair hvh: d = 3000, d* = 2700 -> score - 300/405', close(f1, 2 - 300 / 405), f1);
    add('fair hvh: d = d* -> fair === score', fair(hvh, 3000, base) === 2);
    const s3 = { mode: 'hvhva', weights: { T1: 2 } };
    const tri = { set: { Sol: { x: 0, z: 0 }, Cent: { x: 3000, z: 0 }, Alien: { x: 0, z: 4000 } }, score: 10 };
    const f3 = fair(tri, 4000, s3);
    // pairs 3000 / 4000 / 5000 at d* = 4000: distance part 2000 / 600, weighted x2; the CV part stays
    add('fair hvhva: 3-4-5, d* = 4000, w_T1 = 2 -> score - 2 x 3.333333', close(f3, 10 - 2 * 2000 / 600, 1e-9), f3);
    return { ok: results.every(r => r.ok), results };
  }

  return { VERSION, defaultBand, params, plan, runSettings, fair, pairDistances, run, selftest };
}));
