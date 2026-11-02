// T2 model self-test (spec section 9, T2 "Verify"). UMD, DOM-free, no I/O: the caller (the T5
// harness, or a throwaway node script) builds GenRaw objects from disk and passes them in.
//
//   GenModelSelftest.synthetic()      -> {ok, results}        flat/wall grids, timing, Voronoi,
//                                                              expansion-curve fixture (spec 12.6),
//                                                              exact-kit fixtures (spec 13.8),
//                                                              placeability fixture (spec 15.5)
//   GenModelSelftest.map(raw)         -> {ok, results, summary}  candidates + 3 plan sets, layer
//                                                              cap, expansion prepare/curve timing
//   GenModelSelftest.run(raws)        -> {ok, results}        synthetic() + map(raw) for each
// results = [{name, ok, detail}] like Terrain.selftest().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../terrain.js'), require('./rng.js'), require('./context.js'),
      require('./grid.js'), require('./candidates.js'), require('./patches.js'), require('./expansion.js'));
  } else {
    root.GenModelSelftest = factory(root.Terrain, root.GenRng, root.GenContext, root.GenGrid,
      root.GenCandidates, root.GenPatches, root.GenExpansion);
  }
}(typeof self !== 'undefined' ? self : this, function (Terrain, GenRng, GenContext, GenGrid, GenCandidates, GenPatches, GenExpansion) {
  'use strict';

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const r2 = v => Math.round(v * 100) / 100;
  // {p10, median} wall time (ms) of fn over reps runs. The checks use p10: on a busy machine
  // (other processes at ~90 % CPU) the median doubles while p10 tracks the algorithm's cost.
  function timeStats(fn, reps) {
    const ts = [];
    for (let q = 0; q < reps; q++) { const t = now(); fn(q); ts.push(now() - t); }
    ts.sort((a, b) => a - b);
    return { p10: r2(ts[Math.floor(ts.length / 10)]), median: r2(ts[ts.length >> 1]) };
  }

  function flatRaw(extent, step) {
    const g = Math.round((2 * extent) / step) + 1, len = g * g;
    const ones = () => new Uint8Array(len).fill(1);
    return {
      mapName: 'SyntheticFlat',
      cfg: { extent, scan_min_x: -extent, scan_max_z: extent, scan_step: step, grid_w: g, grid_h: g },
      resources: { resources: [] },
      masks: { hqSol: ones(), hqCent: ones(), refSol: ones(), refCent: ones() },
      heights: new Float32Array(len), heightsMeta: null,
    };
  }

  // ── synthetic checks ──────────────────────────────────────────────────

  function synthetic() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
    const raw = flatRaw(1500, 15);
    const settings = GenContext.defaultSettings(raw);
    const ctx = GenContext.build(raw, settings);
    const c = ctx.ctrl, n = c.n, cell = c.cell;
    const ci = (i, j) => j * n + i;

    // 1. flat: Dijkstra vs Euclidean on 100 random cell pairs
    const rng = GenRng.create(7);
    let maxErr = 0, sumErr = 0;
    const fieldMs = [];
    for (let q = 0; q < 100; q++) {
      let a, b, e;
      do { a = rng.int(n * n); b = rng.int(n * n); e = Math.hypot(a % n - b % n, Math.floor(a / n) - Math.floor(b / n)) * cell; } while (e < 5 * cell);
      const tq = now();
      const D = GenGrid.field(ctx, settings, a);
      fieldMs.push(now() - tq);
      const err = Math.abs(D[b] / e - 1);
      sumErr += err;
      if (err > maxErr) maxErr = err;
    }
    fieldMs.sort((x, y) => x - y);
    const msPerField = fieldMs[10];
    add('flat 101^2: Dijkstra = Euclidean within 8 % (100 random pairs)', maxErr <= 0.08,
      { maxErrPct: r2(100 * maxErr), meanErrPct: r2(sumErr), stencil: GenGrid.slopeParams(settings).stencil });
    add('field time <= 5 ms (flat, p10 of 100)', msPerField <= 5, { p10: r2(msPerField), median: r2(fieldMs[50]) });

    // 2. Voronoi: shares sum to 1, mirrored points -> 0.5 +- 0.02
    const cache = new Map();
    const F = GenGrid.fields(ctx, settings, { Sol: { ci: ci(25, 50) }, Cent: { ci: ci(75, 50) } }, cache);
    const sum = F.shares.Sol + F.shares.Cent;
    add('Voronoi shares sum to 1 over playable cells', Math.abs(sum - 1) < 1e-9, { sum });
    add('mirrored points on a flat map: shares 0.5 +- 0.02',
      Math.abs(F.shares.Sol - 0.5) <= 0.02 && Math.abs(F.shares.Cent - 0.5) <= 0.02,
      { Sol: r2(F.shares.Sol * 1000) / 1000, Cent: r2(F.shares.Cent * 1000) / 1000, border: F.borders['Sol-Cent'] });
    const F3 = GenGrid.fields(ctx, settings, { Sol: { ci: ci(20, 80) }, Cent: { ci: ci(80, 80) }, Alien: { ci: ci(50, 20) } }, cache);
    const s3 = F3.shares.Sol + F3.shares.Cent + F3.shares.Alien;
    add('3 sides: shares sum to 1', Math.abs(s3 - 1) < 1e-9, { shares: F3.shares, borders: F3.borders });

    // 3. wall of impassable cells: column i = 50, rows 10..90
    for (let j = 10; j <= 90; j++) c.h[ci(50, j)] = 1000;
    GenGrid.resetCache(c);
    const src = ci(40, 50), dst = ci(60, 50);
    const Dw = GenGrid.field(ctx, settings, src);
    const straight = 20 * cell, around = 2 * Math.hypot(10, 41) * cell;
    add('wall: path goes round it (D >= 0.95 x detour, finite)', Dw[dst] >= 0.95 * around && Dw[dst] <= 1.1 * around,
      { straight_m: straight, detour_m: Math.round(around), dijkstra_m: Math.round(Dw[dst]), wallCell: Dw[ci(50, 50)] });
    for (let j = 10; j <= 90; j++) c.h[ci(50, j)] = 0;
    GenGrid.resetCache(c);

    results.push(...expansionFixture());
    results.push(...exactKitFixtures());
    results.push(...placeabilityFixture());
    return { ok: results.every(r => r.ok), results };
  }

  /**
   * Spec 12.6 fixture on a flat 8 km map, R_b 1000, R_c 2500, reach 0.85: Sol (-2500, 0) has one
   * cluster of 6 Balterium around (-900, 0); Cent (2500, 0) has 3 pairs > 2 R_b apart, all 1600 m
   * out -> V_Sol = [6,6,6], V_Cent = [2,4,6], T6 = (1 - (0.45/3 + 0.35*2/3 + 0.20))/0.10 = 4.167.
   */
  function expansionFixture() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name: `expansion fixture: ${name}`, ok: !!ok, detail });
    const raw = flatRaw(4000, 15);
    raw.mapName = 'SyntheticExpansion';
    const res = [];
    const put = (x, z) => res.push({ idx: res.length, type: 'Balterium', x, z, y: 0, resources_max: 40000, world_w: 40, world_h: 40 });
    for (const [dx, dz] of [[0, 0], [50, 0], [-50, 0], [0, 50], [0, -50], [35, 35]]) put(-900 + dx, dz);
    for (const [gx, gz] of [[2500, 1600], [2500, -1600], [900, 0]]) { put(gx - 30, gz); put(gx + 30, gz); }
    raw.resources = { resources: res };
    const settings = GenContext.defaultSettings(raw, { counts: { balterium: 1e9, biotics: 1e9 } });
    const ctx = GenContext.build(raw, settings);
    const sp = (x, z) => ({ x, z, ci: GenGrid.cellOf(ctx, x, z) });
    const set = { Sol: sp(-2500, 0), Cent: sp(2500, 0) };
    const F = GenGrid.fields(ctx, settings, set, new Map());
    const plan = GenPatches.plan(ctx, settings, set, F);
    const keptB = new Uint8Array(ctx.patches.length);
    const keptIdx = new Set(plan.kept.Balterium);
    ctx.patches.forEach((p, k) => { keptB[k] = keptIdx.has(p.idx) ? 1 : 0; });
    const K = settings.expansion.K, cv = {};
    for (const r of ['Sol', 'Cent']) cv[r] = GenExpansion.curve(ctx, settings, set[r], F.sides.indexOf(r), F, keptB, K);
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    add('V_Sol = [6,6,6], V_Cent = [2,4,6]', eq(cv.Sol.V, [6, 6, 6]) && eq(cv.Cent.V, [2, 4, 6]),
      { Sol: cv.Sol.V, Cent: cv.Cent.V, cellsSol: cv.Sol.cells, cellsCent: cv.Cent.cells });
    const w = settings.expansion.w;
    let acc = 0;
    for (let k = 0; k < K; k++) {
      const a = cv.Sol.V[k], b = cv.Cent.V[k], mx = Math.max(a, b);
      acc += w[k] * (mx ? Math.min(a, b) / mx : 1);
    }
    const t6 = (1 - acc) / 0.10;
    add('T6 from the curve = 4.167', Math.abs(t6 - 25 / 6) < 0.001, Math.round(t6 * 1000) / 1000);
    add('layer 6/6, plan.layer = curve layer', cv.Sol.layer === 6 && cv.Cent.layer === 6
      && plan.layer.Sol === 6 && plan.layer.Cent === 6, { curve: [cv.Sol.layer, cv.Cent.layer], plan: plan.layer });
    const eu = ['Sol', 'Cent'].map(r => GenExpansion.curve(ctx, settings, set[r], -1, null, keptB, K, [set[r === 'Sol' ? 'Cent' : 'Sol']]).V);
    add('no fields: Euclidean own side gives the same curves', eq(eu[0], cv.Sol.V) && eq(eu[1], cv.Cent.V), eu);
    const so = [GenExpansion.solo(ctx, settings, set.Sol), GenExpansion.solo(ctx, settings, set.Cent)];
    add('solo V1: Sol 6, Cent 2', so[0] === 6 && so[1] === 2, so);
    return results;
  }

  /**
   * Spec 13.8 fixtures on a flat 6 km map (R_b 1000, R_n 1200): Sol (-1800, 0) and Cent
   * (1800, 0) have 4 Balterium each within R_b, the Nest (0, 1800) 6 Biotics within R_n, plus 10
   * Balterium and 4 Biotics on a ring of radius 2600. Requested totals are below vanilla, so the
   * auto plan may pair-add inside the radii.
   * 1. kitExact 2 (hvh and hvhva sets): kit 2/2, no paired adds, no failures, exactly 2 kept per
   *    radius; kitExact 5 > 4 reachable -> failures ['kit_exact']; nestKitExact 2 -> Nest kit 2
   *    and the other 4 Biotics inside R_n removed.
   * 2. GenSearch.run with kitExact 8 (budget 16 <= total, but no spot reaches 8) ->
   *    infeasible 'kit_candidates', no exception, candidates [], kitRange.humanMax < 8.
   */
  function exactKitFixtures() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name: `exact-kit fixture: ${name}`, ok: !!ok, detail });
    const raw = flatRaw(3000, 15);
    raw.mapName = 'SyntheticExactKit';
    const res = [];
    const put = (type, x, z) => res.push({ idx: res.length, type, x, z, y: 0, resources_max: type === 'Balterium' ? 40000 : 42000, world_w: 40, world_h: 40 });
    for (const [dx, dz] of [[300, 0], [0, 450], [-500, 100], [200, -650]]) { put('Balterium', -1800 + dx, dz); put('Balterium', 1800 - dx, dz); }
    for (const [dx, dz] of [[300, 0], [-300, 0], [0, 400], [0, -500], [600, 300], [-700, -200]]) put('Biotics', dx, 1800 + dz);
    for (let q = 0; q < 10; q++) { const a = (q + 0.5) * Math.PI / 5; put('Balterium', 2600 * Math.cos(a), 2600 * Math.sin(a)); }
    for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2 + Math.PI / 4; put('Biotics', 2600 * Math.cos(a), 2600 * Math.sin(a)); }
    raw.resources = { resources: res };
    const base = { counts: { balterium: 12, biotics: 6 } };
    const settings = GenContext.defaultSettings(raw, base);
    const ctx = GenContext.build(raw, settings);
    const sp = (x, z) => {
      const c = { x, z, ci: GenGrid.cellOf(ctx, x, z), pd: new Float32Array(ctx.patches.length) };
      ctx.patches.forEach((p, k) => { c.pd[k] = Math.hypot(p.x - x, p.z - z); });
      return c;
    };
    const set = { Sol: sp(-1800, 0), Cent: sp(1800, 0) };
    const set3 = Object.assign({ Alien: sp(0, 1800) }, set);
    const within = (plan, c, type, R) => ctx.patches.filter((p, k) => p.type === type && c.pd[k] <= R && plan.kept[type].includes(p.idx)).length;
    const s2 = GenContext.defaultSettings(raw, Object.assign({ kitExact: 2 }, base));
    const F = GenGrid.fields(ctx, s2, set, new Map());
    const auto = GenPatches.plan(ctx, settings, set, F);
    const p2 = GenPatches.plan(ctx, s2, set, F);
    add('auto plan on the fixture (reference)', true, { kit: auto.kit, paired: auto.paired, kitK: auto.kitK });
    add('kitExact 2 (hvh): kit 2/2, kept within R_b 2/2, no paired adds, no failures',
      p2.kit.Sol === 2 && p2.kit.Cent === 2 && within(p2, set.Sol, 'Balterium', 1000) === 2 && within(p2, set.Cent, 'Balterium', 1000) === 2
      && p2.paired === 0 && Array.isArray(p2.failures) && !p2.failures.length && p2.kept.Balterium.length === 12,
      { kit: p2.kit, paired: p2.paired, failures: p2.failures, kept: p2.kept.Balterium.length });
    const p5 = GenPatches.plan(ctx, GenContext.defaultSettings(raw, Object.assign({ kitExact: 5 }, base)), set, F);
    add('kitExact 5 > 4 reachable: failures [kit_exact], kit stays 4/4', p5.failures.join() === 'kit_exact' && p5.kit.Sol === 4 && p5.kit.Cent === 4,
      { kit: p5.kit, failures: p5.failures });
    const s3 = GenContext.defaultSettings(raw, Object.assign({ mode: 'hvhva', kitExact: 2, nestKitExact: 2 }, base));
    const F3 = GenGrid.fields(ctx, s3, set3, new Map());
    const p3 = GenPatches.plan(ctx, s3, set3, F3);
    const bioIn = ctx.patches.filter((p, k) => p.type === 'Biotics' && set3.Alien.pd[k] <= 1200).map(p => p.idx);
    add('nestKitExact 2 (hvhva): Nest kit 2, the other 4 Biotics inside R_n removed, human kit 2/2, no paired adds',
      p3.kit.Alien === 2 && bioIn.length === 6 && bioIn.filter(i => p3.removed.includes(i)).length === 4
      && p3.kit.Sol === 2 && p3.kit.Cent === 2 && p3.paired === 0 && !p3.failures.length,
      { kit: p3.kit, bioInside: bioIn.length, failures: p3.failures, paired: p3.paired });
    // nest_total (spec 13.5): 10 Biotics, 6 inside R_n; m = 2 removes the other 4, so at most
    // 6 can be kept -> a request of 8 runs the pool dry
    const sT = GenContext.defaultSettings(raw, { mode: 'hvhva', kitExact: 2, nestKitExact: 2, counts: { balterium: 12, biotics: 8 } });
    const pT = GenPatches.plan(ctx, sT, set3, F3);
    add('nestKitExact 2 with 8 Biotics requested: failures [nest_total], achievable 6, kit still 2/2/2',
      pT.failures.join() === 'nest_total' && pT.achievable.Biotics === 6 && pT.kept.Biotics.length === 6 && pT.target.Biotics === 8
      && pT.kit.Alien === 2 && pT.kit.Sol === 2 && pT.kit.Cent === 2,
      { failures: pT.failures, achievable: pT.achievable, target: pT.target, kit: pT.kit });
    const pA = GenPatches.plan(ctx, GenContext.defaultSettings(raw, { mode: 'hvhva', counts: { balterium: 12, biotics: 8 } }), set3, F3);
    add('auto plan on the same set: no failures key (round-3 shape)', pA.failures === undefined && pA.achievable === undefined, Object.keys(pA));
    const S = GenSearchMod();
    if (!S) { add('GenSearch available for the infeasible fixture', false, 'GenSearch not loaded'); return results; }
    let out = null, err = null;
    try {
      const s8 = GenContext.defaultSettings(raw, { kitExact: 8, counts: { balterium: 17, biotics: 6 } });
      out = S.run(GenContext.build(raw, s8), s8);
    } catch (e) { err = e && e.stack ? e.stack : String(e); }
    add('kitExact 8 > any spot -> infeasible kit_candidates, no exception, no results',
      !err && out && out.infeasible && out.infeasible.reason === 'kit_candidates' && out.candidates.length === 0
      && out.stats.kitRange && out.stats.kitRange.humanMax < 8,
      err || { infeasible: out && out.infeasible, kitRange: out && out.stats.kitRange });
    return results;
  }

  /**
   * Spec 15.5 fixture on a flat 6 km map (R_b 1000): Sol (-1800, 0) and Cent (1800, 0) have 4
   * Balterium each within R_b (mirrored) and a cluster of 3 in their expansion layer around
   * (-+1500, 1800); one more patch (0, -2600) lies outside both layers. Synthetic ref_place
   * files: the Sol refinery fits neither Sol kit patch #0 nor two of the Sol cluster patches;
   * the Cent refinery fits everything but the far patch. One fixed plan keeps all 15 patches.
   * Toggle off: kit 4/4, V(1) 3/3, G3 and G5 pass. Toggle on (hvh needs Sol AND Cent): 4
   * ineligible (n_good < minGood 10: 3 Sol-side + the far one), kit 3/4 -> G3 fails, V(1) 1/3 -> G5
   * fails, T2 > 0, T7 = 2.5 (ease Sol 0.5 / 1, Cent 1 / 1); T7 absent when off.
   * hva needs Sol only: the far patch is eligible there. A missing Cent file turns it off.
   */
  function placeabilityFixture() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name: `placeability fixture: ${name}`, ok: !!ok, detail });
    const Met = GenMetricsMod();
    if (!Met) { add('GenMetrics available', false, 'GenMetrics not loaded'); return results; }
    const raw = flatRaw(3000, 15);
    raw.mapName = 'SyntheticPlaceability';
    const res = [];
    const put = (x, z) => res.push({ idx: res.length, type: 'Balterium', x, z, y: 0, resources_max: 40000, world_w: 40, world_h: 40 });
    // idx 0-7: kits (Sol even, Cent odd); 8-13: layer clusters (Sol even, Cent odd); 14: far patch
    for (const [dx, dz] of [[300, 0], [0, 450], [-500, 100], [200, -650]]) { put(-1800 + dx, dz); put(1800 - dx, dz); }
    for (const [dx, dz] of [[0, 0], [60, 0], [0, 60]]) { put(-1500 - dx, 1800 + dz); put(1500 + dx, 1800 + dz); }
    put(0, -2600);
    raw.resources = { resources: res };
    // n_good: below minGood (10) = ineligible; Sol file 100 on the Sol kit, 200 on the Cent kit
    // (ease Sol A 0.5 / B 1.0), Cent file 200 everywhere but the far patch (ease 1 / 1) -> T7 =
    // mean(|0.5 - 1|, 0) / 0.10 = 2.5
    const solN = idx => (idx === 0 ? 5 : idx === 8 || idx === 10 ? 0 : idx < 8 ? (idx % 2 ? 200 : 100) : 50);
    const centN = idx => (idx === 14 ? 3 : 200);
    const file = (f, nOf) => ({ map: raw.mapName, faction: f, d_good: 150, align_good: 0.7,
      patches: res.map(p => ({ idx: p.idx, n_good: nOf(p.idx), best: null, best_any: null })) });
    raw.placeability = { Sol: file('Sol', solN), Cent: file('Cent', centN) };
    const counts = { balterium: 15, biotics: 0 };
    const sOff = GenContext.defaultSettings(raw, { counts, placeability: { enabled: false } });
    const sOn = GenContext.defaultSettings(raw, { counts });
    add('defaults: placeability on; {enabled: false} drops the key (round-5 settings hash)',
      sOn.placeability && sOn.placeability.enabled === true && !('placeability' in sOff), { on: sOn.placeability, offHasKey: 'placeability' in sOff });
    const evalOf = settings => {
      const ctx = GenContext.build(raw, settings);
      const at = (x, z, id) => GenCandidates.at(ctx, settings, 'human',
        Math.round((x - ctx.scan.minX) / ctx.scan.step), Math.round((ctx.scan.maxZ - z) / ctx.scan.step), id);
      const set = { Sol: at(-1800, 0, 'S'), Cent: at(1800, 0, 'C') };
      const F = GenGrid.fields(ctx, settings, set, new Map());
      const plan = { kept: { Balterium: res.map(p => p.idx), Biotics: [] }, removed: [], frozen: new Set(), kit: {}, rings: {}, gap: null,
        target: { Balterium: 15, Biotics: 0 } };
      return { ctx, set, F, ev: Met.evaluate(ctx, settings, set, F, plan) };
    };
    const off = evalOf(sOff), on = evalOf(sOn);
    const V1 = ev => ['Sol', 'Cent'].map(r => ev.metrics.expansion[r].V[0]);
    add('off: no ctx.place, kit 4/4, V(1) 3/3, G3 and G5 pass',
      off.ctx.place === undefined && GenContext.placeMask(off.ctx) === null && off.ev.metrics.kit.Sol === 4 && off.ev.metrics.kit.Cent === 4
      && V1(off.ev).join() === '3,3' && !off.ev.gateFails.includes('G3') && !off.ev.gateFails.includes('G5'),
      { kit: off.ev.metrics.kit, V1: V1(off.ev), gateFails: off.ev.gateFails });
    add('on (hvh, Sol and Cent required): ineligible [0, 8, 10, 14], patches[k].placeable set',
      on.ctx.place.enabled && on.ctx.place.required.join() === 'Sol,Cent' && on.ctx.place.ineligible.join() === '0,8,10,14'
      && on.ctx.patches[0].placeable.Sol === false && on.ctx.patches[0].placeable.Cent === true && on.ctx.patches[14].placeable.Cent === false,
      { enabled: on.ctx.place.enabled, required: on.ctx.place.required, ineligible: on.ctx.place.ineligible, p0: on.ctx.patches[0].placeable });
    add('on: kit 3/4 -> G3 fails; V(1) 1/3 -> G5 fails; G4 still counts all 15 kept',
      on.ev.metrics.kit.Sol === 3 && on.ev.metrics.kit.Cent === 4 && on.ev.gateFails.includes('G3')
      && V1(on.ev).join() === '1,3' && on.ev.gateFails.includes('G5') && !on.ev.gateFails.includes('G4'),
      { kit: on.ev.metrics.kit, V1: V1(on.ev), gateFails: on.ev.gateFails });
    add('on: candidate nBalt 3 vs 4 (off 4 vs 4); T2 > 0 (off ~0, mirrored)',
      on.set.Sol.nBalt === 3 && on.set.Cent.nBalt === 4 && off.set.Sol.nBalt === 4 && on.ev.terms.T2 > 1 && Math.abs(off.ev.terms.T2) < 0.01,
      { nBaltOn: [on.set.Sol.nBalt, on.set.Cent.nBalt], T2: [off.ev.terms.T2, on.ev.terms.T2] });
    const pe = on.ev.metrics.placeEase || {};
    add('T7: off absent (terms and metrics); on ease Sol 0.5/1, Cent 1/1, T7 = 2.5, weight 0.5 in the score',
      !('T7' in off.ev.terms) && !('placeEase' in off.ev.metrics) && pe.Sol && pe.Sol.A === 0.5 && pe.Sol.B === 1 && pe.Cent.A === 1 && pe.Cent.B === 1
      && Math.abs(on.ev.terms.T7 - 2.5) < 1e-9 && Math.abs(on.ev.score - Object.keys(on.ev.terms).reduce((a, k) => a + Met.weightOf(sOn, k) * on.ev.terms[k], 0)) < 1e-9
      && Met.weightOf(sOn, 'T7') === 0.5,
      { offTerms: Object.keys(off.ev.terms), ease: pe, T7: on.ev.terms.T7 });
    const sMin = GenContext.defaultSettings(raw, { counts, placeability: { minGood: 60 } });
    const cMin = GenContext.build(raw, sMin);
    add('minGood 60: every cluster patch (Sol file 50) also drops out -> ineligible [0, 8-14]',
      sMin.placeability.enabled && cMin.place.minGood === 60 && cMin.place.ineligible.join() === '0,8,9,10,11,12,13,14', cMin.place.ineligible);
    // spec 15.8 HQ footprint: Sol kit patch #2 (n_good 100) gets a good list with 95 placements at
    // (-1800, 100) (inside the Sol HQ square at (-1800, 0) + site box) and 5 at (-1800, 450)
    // -> n_eff_Sol 5 < 10: ineligible at the Sol start only. Site rectangle: rotIndex 1/3 swaps w/h.
    const cf = GenContext.countFree([-1660, 0, 0, -1660, 0, 2, -1660, 0, 5], { w: 172, h: 116 }, -1800, 0, 65.5);
    add('HQ square vs site box: dx 140 blocks rot 0 and 180 (86 + 65.5), not rot 90 (58 + 65.5)', cf === 1, cf);
    const rawH = Object.assign({}, raw, { placeability: {
      Sol: Object.assign({}, raw.placeability.Sol, { site_box: { w: 172, h: 116 }, patches: raw.placeability.Sol.patches.map(q => (q.idx !== 2 ? q
        : Object.assign({}, q, { good: [].concat(...Array.from({ length: 100 }, (_, i) => (i < 95 ? [-1800, 100, 0] : [-1800, 450, 0]))) }))) }),
      Cent: raw.placeability.Cent } });
    const hq = (() => {
      const ctx = GenContext.build(rawH, sOn);
      const set = { Sol: GenCandidates.at(ctx, sOn, 'human', on.set.Sol.px, on.set.Sol.py, 'S'), Cent: GenCandidates.at(ctx, sOn, 'human', on.set.Cent.px, on.set.Cent.py, 'C') };
      const F = GenGrid.fields(ctx, sOn, set, new Map());
      const plan = { kept: { Balterium: res.map(p => p.idx), Biotics: [] }, removed: [], frozen: new Set(), kit: {}, rings: {}, gap: null, target: { Balterium: 15, Biotics: 0 } };
      return { ctx, set, ev: Met.evaluate(ctx, sOn, set, F, plan) };
    })();
    const sm = GenContext.setMask(hq.ctx, hq.set);
    add('HQ footprint: n_eff_Sol(#2, Sol start) 5, n_good 100; ineligible at the Sol start, not in placeMask; Sol kit 3 -> 2, nBalt 2',
      GenContext.placeNEff(hq.ctx, 2, hq.set.Sol, 'Sol') === 5 && hq.ctx.place.nGood.Sol[2] === 100 && !GenContext.eligibleAt(hq.ctx, 2, hq.set.Sol)
      && GenContext.placeMask(hq.ctx)[2] === 1 && sm[2] === 0 && hq.ev.metrics.kit.Sol === 2 && hq.set.Sol.nBalt === 2
      && GenContext.placeNEff(hq.ctx, 2, hq.set.Cent, 'Sol') === 100,
      { nEff: GenContext.placeNEff(hq.ctx, 2, hq.set.Sol, 'Sol'), kit: hq.ev.metrics.kit, nBalt: hq.set.Sol.nBalt, ease: hq.ev.metrics.placeEase });
    // spec 15.9 swap off: Sol start = Sol factions only, Cent start = Cent only. Kit patch #0 is
    // Cent-only placeable (Sol 5, Cent 200): it counts when the Cent spawn stands at (-1800, 0)
    // (side B) but not when the Sol spawn does (side A); swap on it counts for neither.
    const sNo = GenContext.defaultSettings(raw, { counts, swap: false });
    const evSwap = (settings, solX) => {
      const ctx = GenContext.build(raw, settings);
      const at = (x, id) => GenCandidates.at(ctx, settings, 'human', Math.round((x - ctx.scan.minX) / ctx.scan.step), Math.round(ctx.scan.maxZ / ctx.scan.step), id);
      const set = { Sol: at(solX, 'S'), Cent: at(-solX, 'C') };
      const F = GenGrid.fields(ctx, settings, set, new Map());
      const plan = { kept: { Balterium: res.map(p => p.idx), Biotics: [] }, removed: [], frozen: new Set(), kit: {}, rings: {}, gap: null, target: { Balterium: 15, Biotics: 0 } };
      return { ctx, ev: Met.evaluate(ctx, settings, set, F, plan) };
    };
    const offA = evSwap(sNo, -1800), offB = evSwap(sNo, 1800), onB = evSwap(sOn, 1800);
    add('swap setting: absent when on, false kept; global ineligible = placeable for neither faction ([] off vs [0, 8, 10, 14] on)',
      !('swap' in sOn) && sNo.swap === false && offA.ctx.place.split && offA.ctx.place.ineligible.join() === '' && !onB.ctx.place.split,
      { swapOn: 'swap' in sOn, ineligibleOff: offA.ctx.place.ineligible });
    add('swap off: Cent-only patch #0 counts on side B (Cent spawn at its start, kit Cent 4) but not on side A (Sol spawn there, kit Sol 3); swap on: 3 either way',
      offA.ev.metrics.kit.Sol === 3 && offB.ev.metrics.kit.Cent === 4 && onB.ev.metrics.kit.Cent === 3
      && !GenContext.eligibleAt(offA.ctx, 0, { x: -1800, z: 0 }, 'Sol') && GenContext.eligibleAt(offA.ctx, 0, { x: -1800, z: 0 }, 'Cent'),
      { offA: offA.ev.metrics.kit, offB: offB.ev.metrics.kit, onB: onB.ev.metrics.kit });
    const pe2 = offB.ev.metrics.placeEase || {};
    add('swap off: ease Sol has side A only, Cent side B only; T7 = |ease_Sol(A) - ease_Cent(B)| / 0.10',
      pe2.Sol && pe2.Cent && pe2.Sol.B === undefined && pe2.Cent.A === undefined
      && Math.abs(offB.ev.terms.T7 - Math.abs(pe2.Sol.A - pe2.Cent.B) / 0.10) < 1e-3,
      { ease: pe2, T7: offB.ev.terms.T7 });
    // patch plan: the auto kit is equal on eligible patches, the ineligible kit patch is not
    // frozen; with 8 kept the fill takes eligible patches first, so no ineligible one is kept
    const c8 = { balterium: 8, biotics: 0 };
    const p8 = GenPatches.plan(on.ctx, GenContext.defaultSettings(raw, { counts: c8 }), on.set, on.F);
    const p8off = GenPatches.plan(off.ctx, GenContext.defaultSettings(raw, { counts: c8, placeability: { enabled: false } }), off.set, off.F);
    const inelKept = p8.kept.Balterium.filter(i => on.ctx.place.ineligible.includes(i));
    add('on, 8 kept: kit equal on eligible patches, kit patch #0 not frozen, no ineligible patch kept (ranked last)',
      p8.kit.Sol === p8.kit.Cent && !p8.frozen.has(0) && p8.kept.Balterium.length === 8 && inelKept.length === 0,
      { kit: p8.kit, kept: p8.kept.Balterium, ineligibleKept: inelKept, offKept: p8off.kept.Balterium });
    const ha = GenContext.build(raw, GenContext.defaultSettings(raw, { mode: 'hva', counts }));
    add('hva (Sol required only): ineligible [0, 8, 10], the far patch counts',
      ha.place.required.join() === 'Sol' && ha.place.ineligible.join() === '0,8,10', ha.place.ineligible);
    const rawM = Object.assign({}, raw, { placeability: { Sol: raw.placeability.Sol, Cent: null } });
    const warn = console.warn;
    let warned = 0, cm = null;
    console.warn = () => { warned++; };
    try { cm = GenContext.build(rawM, sOn); } finally { console.warn = warn; }
    add('Cent file missing (hvh): feature off for the map, missing [Cent], one warning, mask null',
      cm.place.enabled === false && cm.place.missing.join() === 'Cent' && warned === 1 && GenContext.placeMask(cm) === null,
      { enabled: cm.place.enabled, missing: cm.place.missing, warned });
    return results;
  }

  function GenMetricsMod() {
    if (typeof module === 'object' && module.exports) { try { return require('./metrics.js'); } catch (e) { return null; } }
    return (typeof self !== 'undefined' ? self : this).GenMetrics || null;
  }

  // GenSearch is not a load-time dependency of this file (it pulls in metrics); looked up on use
  function GenSearchMod() {
    if (typeof module === 'object' && module.exports) { try { return require('./search.js'); } catch (e) { return null; } }
    return (typeof self !== 'undefined' ? self : this).GenSearch || null;
  }

  // ── real-map checks ───────────────────────────────────────────────────

  function rectDist(p, x, z) {
    const dx = Math.max(Math.abs(x - p.x) - p.w / 2, 0), dz = Math.max(Math.abs(z - p.z) - p.h / 2, 0);
    return Math.hypot(dx, dz);
  }

  function pickSets(ctx, settings, H, A) {
    const dstar = settings.enemyDistance, lo = 0.85 * dstar;
    const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    let hvh = null, hb = -Infinity;
    for (let i = 0; i < H.length; i++) {
      for (let j = i + 1; j < H.length; j++) {
        const dd = d(H[i], H[j]);
        if (dd < lo || dd > 1.3 * dstar) continue;
        const s = 1000 * Math.min(H[i].nBalt, H[j].nBalt, 6) - Math.abs(dd - dstar);
        if (s > hb) { hb = s; hvh = { Sol: H[i], Cent: H[j] }; }
      }
    }
    let hva = null, ab = -Infinity;
    for (const h of H) {
      for (const a of A) {
        const dd = d(h, a);
        if (dd < lo || dd > 1.3 * dstar) continue;
        const s = 1000 * (Math.min(h.nBalt, 6) + Math.min(a.nBio, 8)) - Math.abs(dd - dstar);
        if (s > ab) { ab = s; hva = { Sol: h, Cent: h, Alien: a }; }
      }
    }
    let hvhva = null;
    if (hvh) {
      let tb = -Infinity, alien = null;
      for (const a of A) {
        const d1 = d(a, hvh.Sol), d2 = d(a, hvh.Cent);
        const s = Math.min(d1, d2) >= lo
          ? 1e6 + 1000 * Math.min(a.nBio, 8) - Math.abs(d1 - dstar) - Math.abs(d2 - dstar)
          : Math.min(d1, d2);
        if (s > tb) { tb = s; alien = a; }
      }
      if (alien) hvhva = { Sol: hvh.Sol, Cent: hvh.Cent, Alien: alien };
    }
    return { hvh, hva, hvhva };
  }

  function map(raw) {
    const results = [];
    const add = (name, ok, detail) => results.push({ name: `${raw.mapName}: ${name}`, ok: !!ok, detail });
    const base = GenContext.defaultSettings(raw);
    const t0 = now();
    const ctx = GenContext.build(raw, base);
    const msCtx = now() - t0;
    const sc = ctx.scan, w = sc.w;
    const summary = { map: raw.mapName, extent: ctx.extent, msCtx: Math.round(msCtx), playable: ctx.ctrl.nPlayable };

    // candidates
    const t1 = now();
    const H = GenCandidates.list(ctx, base, 'human', GenRng.create(1));
    const A = GenCandidates.list(ctx, base, 'alien', GenRng.create(1));
    summary.msCand = Math.round(now() - t1);
    summary.candidates = { human: H.length, alien: A.length };
    add('40-250 human candidates', H.length >= 40 && H.length <= 250, H.length);
    add('20-250 alien candidates', A.length >= 20 && A.length <= 250, A.length);
    const lim = ctx.extent - base.edgeMargin;
    const badH = [];
    for (const c of H) {
      let ok = c.px >= 1 && c.py >= 1 && c.px < w - 1 && c.py < sc.h - 1;
      for (let dy = -1; ok && dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = (c.py + dy) * w + c.px + dx;
          if (!raw.masks.hqSol[i] || !raw.masks.hqCent[i]) { ok = false; break; }
        }
      }
      if (ok && (Math.abs(c.x) > lim || Math.abs(c.z) > lim)) ok = false;
      if (ok) for (const p of ctx.patches) if (rectDist(p, c.x, c.z) < GenCandidates.HUMAN_FOOTPRINT) { ok = false; break; }
      if (!ok) badH.push(c.id);
    }
    add('human candidates re-checked (raw masks + 8 neighbours, edge margin, 67 m patch clearance)', !badH.length, badH.slice(0, 5));
    const badA = A.filter(c => !ctx.nestMask[c.py * w + c.px]).map(c => c.id);
    add('alien candidates on nestMask', !badA.length, badA.slice(0, 5));
    const cutH = ctx.stats.candidates.human.cutE, cutA = ctx.stats.candidates.alien.cutE;
    let overCut = 0, eMismatch = 0;
    for (const c of H) if (c.E > cutH) overCut++;
    for (const c of A) if (c.E > cutA) overCut++;
    for (const c of H.slice(0, 10).concat(A.slice(0, 10))) {
      const e = Terrain.exposureAt(ctx.heights, w, sc.h, sc.step, c.px, c.py, base.exposure).E;
      if (Math.abs(e - c.E) > 1e-9) eMismatch++;
    }
    add('no candidate above the exposure cut; E matches Terrain.exposureAt', !overCut && !eMismatch,
      { cutHuman: r2(cutH), cutAlien: r2(cutA), overCut, eMismatch });

    // fields on the real map
    const cache = new Map();
    summary.msField = timeStats(i => GenGrid.field(ctx, base, H[i % H.length].ci), 30);
    add('field time <= 5 ms (real map, p10 of 30)', summary.msField.p10 <= 5, summary.msField);

    // expansion (spec 12.4): prepare once per map and R_b, <= 20 ms
    const hqOk = ctx.ctrl.hqOk;
    let nOk = 0, okOff = 0;
    for (let q = 0; q < hqOk.length; q++) if (hqOk[q]) { nOk++; if (!ctx.ctrl.playable[q]) okOff++; }
    add('ctrl.hqOk: valid HQ cells exist, all playable', nOk > 0 && !okOff, { hqOk: nOk, notPlayable: okOff });
    const Rb0 = base.radii.build;
    summary.msExpPrepare = timeStats(() => { ctx.exp = null; ctx.cache.delete('exp|' + Rb0); GenExpansion.prepare(ctx, base); }, 11);
    add('expansion prepare <= 20 ms (p10 of 11)', summary.msExpPrepare.p10 <= 20, summary.msExpPrepare);

    // plans on 3 fixed sets
    const sets = pickSets(ctx, base, H, A);
    summary.plans = {};
    const vg = GenPatches.plan(ctx, GenContext.defaultSettings(raw, { counts: { balterium: 1e9, biotics: 1e9 } }), {}, null).gap;
    for (const mode of ['hvh', 'hva', 'hvhva']) {
      const set = sets[mode];
      if (!set) { add(`${mode}: fixed set found`, false, 'no pair/triple at >= 0.85 d*'); continue; }
      const settings = GenContext.defaultSettings(raw, { mode });
      const F = GenGrid.fields(ctx, settings, set, cache);
      const shareSum = Object.keys(F.shares).filter(r => !(mode === 'hva' && r === 'Cent')).reduce((s, r) => s + F.shares[r], 0);
      let plan = GenPatches.plan(ctx, settings, set, F);
      const ms = timeStats(() => { plan = GenPatches.plan(ctx, settings, set, F); }, 51);

      const P = ctx.patches, all = P.map(p => p.idx);
      const kB = plan.kept.Balterium.length, kO = plan.kept.Biotics.length;
      const exact = kB === plan.target.Balterium && kO === plan.target.Biotics
        && (settings.counts.balterium >= plan.vanilla.Balterium || plan.target.Balterium === settings.counts.balterium)
        && (settings.counts.biotics >= plan.vanilla.Biotics || plan.target.Biotics === settings.counts.biotics);
      const humans = mode === 'hva' ? ['Sol'] : ['Sol', 'Cent'];
      // paired adds (spec 4.3) may raise every kit above kitK in step; they must stay equal
      const kits = humans.map(r => plan.kit[r]);
      const kitEqual = kits.every(v => v === kits[0]) && kits[0] >= plan.kitK.human;
      const byIdx = new Map(P.map(p => [p.idx, p]));
      let kitOutside = 0;
      for (const idx of plan.frozen) {
        const p = byIdx.get(idx), kept = plan.kept[p.type].includes(idx);
        if (!kept) continue;
        const R0 = p.type === 'Balterium' ? settings.radii.build : settings.radii.nest;
        const owners = p.type === 'Balterium' ? humans.map(r => set[r]) : [set.Alien];
        if (!owners.some(c => c && Math.hypot(c.x - p.x, c.z - p.z) <= R0)) kitOutside++;
      }
      const keptAll = plan.kept.Balterium.concat(plan.kept.Biotics);
      const keptSet = new Set(keptAll), remSet = new Set(plan.removed);
      const disjoint = keptAll.every(i => !remSet.has(i)) && keptSet.size === keptAll.length && remSet.size === plan.removed.length;
      const cover = keptSet.size + remSet.size === all.length && all.every(i => keptSet.has(i) || remSet.has(i));
      const d = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
      const info = {
        set: Object.fromEntries(Object.keys(set).map(r => [r, `${Math.round(set[r].x)},${Math.round(set[r].z)}`])),
        dist: mode === 'hvhva' ? [d(set.Sol, set.Cent), d(set.Sol, set.Alien), d(set.Cent, set.Alien)] : [d(set.Sol, mode === 'hva' ? set.Alien : set.Cent)],
        kept: { B: `${kB}/${settings.counts.balterium} (target ${plan.target.Balterium}, vanilla ${plan.vanilla.Balterium})`,
          O: `${kO}/${settings.counts.biotics} (target ${plan.target.Biotics}, vanilla ${plan.vanilla.Biotics})` },
        kit: plan.kit, kitK: plan.kitK, paired: plan.paired, gap: { B: Math.round(plan.gap.Balterium), O: Math.round(plan.gap.Biotics) },
        shares: Object.fromEntries(Object.entries(F.shares).map(([k, v]) => [k, r2(v)])), ms,
      };
      summary.plans[mode] = info;
      add(`${mode}: kept counts = requested totals exactly`, exact, info.kept);
      add(`${mode}: kit equal across human positions (after ${plan.paired} paired adds)`, kitEqual,
        { kit: plan.kit, kitK: plan.kitK, paired: plan.paired });
      if (set.Alien) {
        const capA = GenPatches.alienKitCap(settings.counts.biotics, humans.length);
        add(`${mode}: Nest kit <= N_O / ${humans.length + 1} (${capA})`, plan.kitK.alien <= capA, plan.kitK);
      }
      add(`${mode}: every kept kit patch within its radius`, !kitOutside, kitOutside);
      add(`${mode}: kept u removed = all, disjoint`, disjoint && cover, { kept: keptSet.size, removed: remSet.size, all: all.length });
      add(`${mode}: shares sum to 1`, Math.abs(shareSum - 1) < 1e-9, info.shares);
      // spec 11 F3: gap_B <= max(900 m, 1.05 x the gap with every vanilla patch kept) on every
      // map; the k-center fill cannot beat the vanilla gap (GreatErg 1218 m, MonumentValley
      // 1556 m), and the paired add lets kit-removed patches close blanks inside the radii.
      // Spec 11 F8: report-only here. The gap is a search-quality property, not a plan
      // invariant for arbitrary fixed positions; the harness keeps the hard check on top-1.
      info.gapVanilla = { B: Math.round(vg.Balterium), O: Math.round(vg.Biotics) };
      const gapLimit = Math.round(Math.max(900, 1.05 * vg.Balterium));
      if (plan.gap.Balterium > gapLimit) {
        add(`info (report-only): ${mode}: gap_B ${info.gap.B} m > limit ${gapLimit} m on this fixed set`, true,
          { gap: info.gap, vanilla: info.gapVanilla, limit: gapLimit });
      }
      add(`${mode}: plan time <= 2 ms (p10 of 51)`, ms.p10 <= 2, info.ms);

      // expansion curve per human (spec 12.1) and the layer cap (spec 12.3)
      const keptB = new Uint8Array(P.length), keptIdx = new Set(plan.kept.Balterium);
      P.forEach((p, k) => { keptB[k] = keptIdx.has(p.idx) ? 1 : 0; });
      const K = settings.expansion.K, cv = {};
      const curves = () => { for (const r of humans) cv[r] = GenExpansion.curve(ctx, settings, set[r], F.sides.indexOf(r), F, keptB, K); };
      curves();
      info.expansion = Object.fromEntries(humans.map(r => [r, { V: cv[r].V, layer: cv[r].layer }]));
      info.layerCap = plan.layerCap;
      add(`${mode}: plan.layer = curve layer`, humans.every(r => plan.layer[r] === cv[r].layer),
        { plan: plan.layer, curve: humans.map(r => cv[r].layer) });
      info.msCurve = timeStats(curves, 51);
      add(`${mode}: expansion curve <= 0.5 ms per set (all humans, p10 of 51)`, info.msCurve.p10 <= 0.5, info.msCurve);
      if (humans.length > 1) {
        const dl = Math.abs(plan.layer.Sol - plan.layer.Cent);
        if (dl <= 2) add(`${mode}: layer cap |layer Sol - layer Cent| <= 2`, true, { layer: plan.layer, cap: plan.layerCap });
        else if (plan.layerCap.forced > 0) {
          add(`info (report-only): ${mode}: |dlayer| ${dl} > 2, admissible pool ran dry`, true, { layer: plan.layer, cap: plan.layerCap });
        } else add(`${mode}: layer cap |layer Sol - layer Cent| <= 2`, false, { layer: plan.layer, cap: plan.layerCap });
      }
    }
    return { ok: results.every(r => r.ok), results, summary };
  }

  function run(raws) {
    const s = synthetic();
    const results = s.results.slice(), summaries = [];
    let paired = 0;
    for (const raw of raws || []) {
      const m = map(raw);
      results.push(...m.results);
      summaries.push(m.summary);
      for (const k in m.summary.plans || {}) paired += m.summary.plans[k].paired || 0;
    }
    if (raws && raws.length > 1) {
      results.push({ name: 'paired add exercised on the fixed sets (kit equality above covers it)', ok: paired > 0, detail: { paired } });
    }
    return { ok: results.every(r => r.ok), results, summaries };
  }

  return { synthetic, map, run, pickSets };
}));
