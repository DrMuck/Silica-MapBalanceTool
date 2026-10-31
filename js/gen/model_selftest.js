// T2 model self-test (spec section 9, T2 "Verify"). UMD, DOM-free, no I/O: the caller (the T5
// harness, or a throwaway node script) builds GenRaw objects from disk and passes them in.
//
//   GenModelSelftest.synthetic()      -> {ok, results}        flat/wall grids, timing, Voronoi
//   GenModelSelftest.map(raw)         -> {ok, results, summary}  candidates + 3 plan sets
//   GenModelSelftest.run(raws)        -> {ok, results}        synthetic() + map(raw) for each
// results = [{name, ok, detail}] like Terrain.selftest().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../terrain.js'), require('./rng.js'), require('./context.js'),
      require('./grid.js'), require('./candidates.js'), require('./patches.js'));
  } else {
    root.GenModelSelftest = factory(root.Terrain, root.GenRng, root.GenContext, root.GenGrid,
      root.GenCandidates, root.GenPatches);
  }
}(typeof self !== 'undefined' ? self : this, function (Terrain, GenRng, GenContext, GenGrid, GenCandidates, GenPatches) {
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

    return { ok: results.every(r => r.ok), results };
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
