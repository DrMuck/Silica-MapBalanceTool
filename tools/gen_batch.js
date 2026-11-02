#!/usr/bin/env node
// Batch of fair spawn + resource layouts over a variant grid (docs/SPAWN_GENERATOR.md 13-15).
//
//   node tools/gen_batch.js [--maps A,B] [--modes hvh,hva,hvhva] [--variants 10] [--out dir] [--dry]
//
// Per map x mode, N (default 10, max 20) variants picked Latin-square style from
//   enemy distance d*  : 5-step ladder per map extent (distLadder),
//   amount level       : Balterium 30k / 45k / 60k / 75k with Biotics 20k / 30k / 40k / 50k per patch,
//   human kit          : kitExact 3 / 4 / 6 / 8 (Balterium within R_b of every human start),
// plus a Nest kit (nestKitExact 4 / 6 / 10 / 15, hva / hvhva) and per-type total targets spread
// over 0.9-1.9M independently of the amount level. Variant i: d = i mod 5, amount = i mod 4,
// kit = (i + floor(i / 4)) mod 4, so the first 10 cover 10 distinct (d, amount) pairs and every
// (amount, kit) pair at least once over 16. Each variant has its own seed (100 i + 101).
// Kept count = clamp(round(total / amount), kit need, vanilla); the amount is then fitted so that
// count x amount lies in [800k, 2.0M] (Balterium amount >= 30k and a multiple of 7.5k, Biotics
// >= 20k, multiple of 1k). Everything else stays at GenContext.defaultSettings (placeability on,
// minGood 10, swap on, radii 1000 / 2500 / 1200); settings.amounts carries the per-patch amounts.
//
// One GenContext per map x mode (ctx does not depend on d*, kits, counts or seed; GenRandom reuses
// it the same way). The top-1 result is kept only when it passes every gate. Steps, all recorded:
//   no_set or top-1 with gate fails  -> next seed; after 3 seeds: d* - 250 m while d* > 2000,
//                                       else the kit one ladder step down
//   kit_candidates / nest_candidates -> kit = the map's max (stats.kitRange) or one ladder step down
//   kit_budget / nest_budget         -> raise the kept count (same total)
//   kit_total / nest_total           -> count = the achievable X, amount raised towards the total
//   count = vanilla but fewer kept   -> count = kept, amount raised (exact kits freeze removed patches)
// Gives up at d* < 1000 m or 60 runs (recorded as failed).
//
// Ranking: fair score F = score - w_T1 * t1dist (GenRandom.fair, spec 14.3; lower is better),
// ranked within map x mode. Writes <out>/<Map>/v<NN>_<GenLayout.fileName>.json (+ _meta.batch),
// <out>/index.json and <out>/index.md. --dry prints the request grid without running the search.
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./gen_harness.js');

const DEFAULT_MAPS = ['IndustrialQuarter', 'MonumentValley', 'NarakaCity', 'NorthPolarCap', 'RiftBasin', 'TheMaw', 'WhisperingPlains'];
const MODES = ['hvh', 'hva', 'hvhva'];
const DEFAULT_OUT = 'C:/Users/schwe/Projects/Si_MapBalance/analysis/gen_layouts_2026-11-02';

const TOTAL_LO = 800000, TOTAL_HI = 2000000;
const AMT = {
  balterium: { step: 7500, min: 30000 },
  biotics: { step: 1000, min: 20000 },
};
const BALT_AMOUNT = [30000, 45000, 60000, 75000];
const BIO_AMOUNT = [20000, 30000, 40000, 50000];
const KITS = [3, 4, 6, 8];
const NESTS = [4, 6, 10, 15];
const D_STEP = 250, D_FLOOR = 1000, MAX_RUNS = 60, SEEDS_PER_STEP = 3;

function distLadder(extent) {
  if (extent >= 3000) return [2000, 3000, 4000, 5000, 6000];
  if (extent >= 2000) return [2000, 2750, 3500, 4250, 5000];
  return [2000, 2400, 2800, 3200, 3600];
}

/** Variant i of the grid (indices into the ladders + total targets + seed). */
function variantSpec(i) {
  const frac = j => ((j % 10) + 0.5) / 10;
  return {
    dIdx: i % 5, aIdx: i % 4, kIdx: (i + Math.floor(i / 4)) % 4, nIdx: (3 * i + 1) % 4,
    totals: {   // stratified over 0.905-1.895M, decorrelated from the amount level
      balterium: Math.round((850000 + 1100000 * frac(7 * i)) / 5000) * 5000,
      biotics: Math.round((850000 + 1100000 * frac(3 * i + 5)) / 5000) * 5000,
    },
    seed: 100 * i + 101,
  };
}

function parseArgs(argv) {
  const a = { maps: DEFAULT_MAPS, modes: MODES, variants: 10, out: DEFAULT_OUT, dry: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--maps') { a.maps = v.split(','); i++; }
    else if (k === '--modes') { a.modes = v.split(','); i++; }
    else if (k === '--variants') { a.variants = Math.max(1, Math.min(20, +v)); i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--dry') a.dry = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

// ── resource totals ──────────────────────────────────────────────────────

const ceilStep = (v, t) => Math.max(AMT[t].min, Math.ceil(v / AMT[t].step) * AMT[t].step);
const floorStep = (v, t) => Math.max(AMT[t].min, Math.floor(v / AMT[t].step) * AMT[t].step);

/** Amount for a fixed count so that count x amount lies in [LO, HI]; lowers the count when even the minimum amount is too much. */
function fitAmount(type, count, amount) {
  let a = Math.max(AMT[type].min, amount);
  if (count * a < TOTAL_LO) a = ceilStep(TOTAL_LO / count, type);
  if (count * a > TOTAL_HI) a = floorStep(TOTAL_HI / count, type);
  if (count * a > TOTAL_HI) count = Math.floor(TOTAL_HI / a);
  return { count, amount: a };
}

/** count = clamp(round(T / amount), minCount, vanilla), then the amount fitted to the total range. */
function planType(type, total, amount, vanilla, minCount) {
  let count = Math.max(1, Math.min(vanilla, Math.round(total / amount)));
  if (count < minCount) count = Math.min(vanilla, minCount);
  return fitAmount(type, count, amount);
}

/** New count (e.g. the achievable X), amount raised towards the original total target. */
function recount(type, count, targetTotal) {
  return fitAmount(type, count, ceilStep(targetTotal / count, type));
}

// ── one request ──────────────────────────────────────────────────────────

function enemyPairs(mode) {
  if (mode === 'hvh') return ['Sol-Cent'];
  if (mode === 'hva') return ['Sol-Alien'];
  return ['Sol-Cent', 'Sol-Alien', 'Cent-Alien'];
}

function request(raw, mode, i) {
  const vanilla = H.vanillaCounts(raw.resources), nH = mode === 'hva' ? 1 : 2, v = variantSpec(i);
  const kit = KITS[v.kIdx], nest = mode === 'hvh' ? null : NESTS[v.nIdx];
  const ladder = { balterium: BALT_AMOUNT[v.aIdx], biotics: BIO_AMOUNT[v.aIdx] };
  const b = planType('balterium', v.totals.balterium, ladder.balterium, vanilla.Balterium, kit * nH + 2);
  const o = planType('biotics', v.totals.biotics, ladder.biotics, vanilla.Biotics, nest != null ? nest + 2 : 1);
  const dl = distLadder(raw.cfg.extent);
  return {
    variant: i + 1, d: dl[v.dIdx], dMinLadder: dl[0], kit, nest, seed: v.seed,
    grid: { d: v.dIdx, amount: v.aIdx, kit: v.kIdx, nest: mode === 'hvh' ? null : v.nIdx },
    target: v.totals, ladder,
    counts: { balterium: b.count, biotics: o.count }, amounts: { balterium: b.amount, biotics: o.amount },
    vanilla,
  };
}

function numFrom(detail, re) {
  const m = re.exec(detail || '');
  return m ? +m[1] : null;
}

const kitDown = k => { const i = KITS.indexOf(k); return i > 0 ? KITS[i - 1] : i < 0 ? KITS.filter(x => x < k).pop() || k - 1 : k - 1; };
const nestDown = k => { const i = NESTS.indexOf(k); return i > 0 ? NESTS[i - 1] : i < 0 ? NESTS.filter(x => x < k).pop() || k - 1 : k - 1; };

function runRequest(E, raw, ctx, mode, req) {
  const st = {
    d: req.d, kit: req.kit, nest: req.nest, seed: req.seed, seedTries: 0,
    counts: Object.assign({}, req.counts), amounts: Object.assign({}, req.amounts),
  };
  const fallbacks = [], nH = mode === 'hva' ? 1 : 2;
  let runs = 0, lastWhy = null;
  /** 3 seeds failed at this (d*, kit): step d* down (above the ladder's lowest step) or the kit. */
  const stepDown = why => {
    const seeds = `seeds ${req.seed}-${st.seed}`;
    if (st.d - D_STEP >= req.dMinLadder) { fallbacks.push(`d* ${st.d}->${st.d - D_STEP} (${why}, ${seeds})`); st.d -= D_STEP; }
    else if (st.kit > KITS[0]) { const nk = kitDown(st.kit); fallbacks.push(`kit ${st.kit}->${nk} (${why}, ${seeds})`); st.kit = nk; }
    else { fallbacks.push(`d* ${st.d}->${st.d - D_STEP} (${why}, ${seeds})`); st.d -= D_STEP; }
    st.seed = req.seed; st.seedTries = 0;
  };
  const failed = why => {
    st.seedTries++;
    if (st.seedTries < SEEDS_PER_STEP) st.seed++;
    else stepDown(why);
  };
  while (runs < MAX_RUNS) {
    runs++;
    const over = { mode, seed: st.seed, enemyDistance: st.d, kitExact: st.kit, counts: Object.assign({}, st.counts), amounts: Object.assign({}, st.amounts) };
    if (mode !== 'hvh') over.nestKitExact = st.nest;
    const settings = E.GenContext.defaultSettings(raw, over);
    const res = E.GenSearch.run(ctx, settings);
    if (res.infeasible) {
      const { reason, detail } = res.infeasible;
      lastWhy = `${reason}: ${detail}`;
      const kr = res.stats.kitRange || {};
      if (reason === 'kit_candidates') {
        const nk = kr.humanMax != null && kr.humanMax < st.kit ? kr.humanMax : kitDown(st.kit);
        fallbacks.push(`kit ${st.kit}->${nk} (kit_candidates, map max ${kr.humanMax})`); st.kit = nk;
      } else if (reason === 'nest_candidates') {
        const nk = kr.alienMax != null && kr.alienMax < st.nest ? kr.alienMax : nestDown(st.nest);
        fallbacks.push(`nest ${st.nest}->${nk} (nest_candidates, map max ${kr.alienMax})`); st.nest = nk;
      } else if (reason === 'kit_budget' || reason === 'nest_budget') {
        const t = reason === 'kit_budget' ? 'balterium' : 'biotics';
        const need = reason === 'kit_budget' ? st.kit * nH + 2 : st.nest + 2;
        const f = recount(t, Math.min(need, req.vanilla[t === 'balterium' ? 'Balterium' : 'Biotics']), req.target[t]);
        fallbacks.push(`${t} count ${st.counts[t]}->${f.count}, amount ${st.amounts[t]}->${f.amount} (${reason})`);
        st.counts[t] = f.count; st.amounts[t] = f.amount;
      } else if (reason === 'kit_total' || reason === 'nest_total') {
        const t = reason === 'kit_total' ? 'balterium' : 'biotics';
        const X = numFrom(detail, /at most (\d+)/);
        if (X == null || X < 1 || X >= st.counts[t]) {
          if (t === 'balterium') { const nk = kitDown(st.kit); fallbacks.push(`kit ${st.kit}->${nk} (${reason})`); st.kit = nk; }
          else { const nk = nestDown(st.nest); fallbacks.push(`nest ${st.nest}->${nk} (${reason})`); st.nest = nk; }
        } else {
          const f = recount(t, X, req.target[t]);
          fallbacks.push(`${t} count ${st.counts[t]}->${f.count}, amount ${st.amounts[t]}->${f.amount} (${reason})`);
          st.counts[t] = f.count; st.amounts[t] = f.amount;
        }
      } else if (reason === 'no_set') {
        failed('no_set');
      } else {
        break;   // no_candidates / invalid: nothing to step
      }
      if (st.d < D_FLOOR || st.kit < 1 || (st.nest != null && st.nest < 1)) break;
      continue;
    }
    const ev = res.candidates[0];
    if (ev && !ev.gateFails.length) {
      // a count at the vanilla number means "every patch the exact kits did not freeze as
      // removed" (GenPatches target), so fewer are kept: take the kept number as the count and
      // raise the amount towards the total target, then run again
      const short = ['balterium', 'biotics'].filter(t => ev.plan.kept[t === 'balterium' ? 'Balterium' : 'Biotics'].length < st.counts[t]);
      if (short.length) {
        for (const t of short) {
          const n = ev.plan.kept[t === 'balterium' ? 'Balterium' : 'Biotics'].length, f = recount(t, n, req.target[t]);
          fallbacks.push(`${t} count ${st.counts[t]}->${f.count}, amount ${st.amounts[t]}->${f.amount} (vanilla count minus kit-frozen patches)`);
          st.counts[t] = f.count; st.amounts[t] = f.amount;
        }
        continue;
      }
      return { ok: true, runs, fallbacks, settings, result: res, ev, st };
    }
    lastWhy = ev ? `gate fails ${ev.gateFails.join(',')}` : 'no candidate';
    failed(lastWhy);
    if (st.d < D_FLOOR) break;
  }
  return { ok: false, runs, fallbacks, why: lastWhy, st };
}

// ── output ───────────────────────────────────────────────────────────────

const k = v => (v % 1000 ? `${(v / 1000).toFixed(1)}k` : `${v / 1000}k`);
const M = v => `${(v / 1e6).toFixed(2)}M`;
const vTag = n => `v${String(n).padStart(2, '0')}`;

/** Row + layout (not yet written) of one request. */
function row(raw, mode, req, out, E, R, ctx) {
  const r = {
    map: raw.mapName, mode, variant: req.variant, extent: raw.cfg.extent, grid: req.grid,
    dRequested: req.d, kitRequested: req.kit, nestRequested: req.nest, seedRequested: req.seed,
    plannedCounts: req.counts, plannedAmounts: req.amounts, ladder: req.ladder, target: req.target,
    runs: out.runs, fallbacks: out.fallbacks, ok: out.ok, ms: out.ms,
  };
  if (!out.ok) { r.status = `FAILED: ${out.why}`; return r; }
  const { settings, ev, result, st } = out;
  const layout = E.GenLayout.build(ctx, settings, ev, 1, st.amounts, { stats: result.stats });
  const kits = H.layoutKits(layout, raw, mode);
  const kept = { balterium: ev.plan.kept.Balterium.length, biotics: ev.plan.kept.Biotics.length };
  const ds = enemyPairs(mode).map(p => ev.metrics.distances && ev.metrics.distances[p]).filter(x => typeof x === 'number');
  Object.assign(r, {
    dAchieved: st.d, seed: st.seed, kit: st.kit, nest: st.nest,
    distances: ev.metrics.distances, dMin: Math.min(...ds), dMax: Math.max(...ds),
    counts: st.counts, amounts: st.amounts, kept,
    totals: { balterium: kept.balterium * st.amounts.balterium, biotics: kept.biotics * st.amounts.biotics },
    kitsLayout: kits, score: ev.score, fair: R.fair(ev, st.d, settings), terms: ev.terms,
    T7: ev.terms && ev.terms.T7 != null ? ev.terms.T7 : null, gateFails: ev.gateFails,
  });
  const issues = [];
  if (kits.Sol !== st.kit || (mode !== 'hva' && kits.Cent !== st.kit)) issues.push(`kit ${kits.Sol}/${kits.Cent} != ${st.kit}`);
  if (mode !== 'hvh' && kits.Alien !== st.nest) issues.push(`nest ${kits.Alien} != ${st.nest}`);
  for (const t of ['balterium', 'biotics']) {
    if (kept[t] !== st.counts[t]) issues.push(`${t} kept ${kept[t]} != count ${st.counts[t]}`);
    if (r.totals[t] < TOTAL_LO || r.totals[t] > TOTAL_HI) issues.push(`${t} total ${r.totals[t]} outside range`);
  }
  if (st.amounts.balterium % 7500 || st.amounts.balterium < 30000 || st.amounts.biotics < 20000) issues.push('amount rule');
  r.issues = issues;
  r.status = issues.length ? `ok, check: ${issues.join('; ')}` : 'ok';
  layout._meta.batch = {
    variant: req.variant, grid: req.grid,
    requested: { enemyDistance: req.d, kitExact: req.kit, nestKitExact: req.nest, seed: req.seed, totals: req.target, amounts: req.ladder },
    achieved: { enemyDistance: st.d, kitExact: st.kit, nestKitExact: st.nest, seed: st.seed, counts: st.counts, amounts: st.amounts, totals: r.totals },
    fair: Math.round(r.fair * 1000) / 1000, fallbacks: out.fallbacks, runs: out.runs,
  };
  r.layout = layout;
  return r;
}

function writeLayouts(outDir, rows, E) {
  // fair rank within map x mode (lower fair = better)
  const groups = new Map();
  for (const r of rows) if (r.ok) {
    const key = `${r.map}|${r.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.fair - b.fair || a.variant - b.variant);
    g.forEach((r, i) => { r.fairRank = i + 1; r.fairOf = g.length; });
  }
  for (const r of rows) {
    if (!r.ok) continue;
    r.layout._meta.batch.fairRank = r.fairRank;
    r.layout._meta.batch.fairOf = r.fairOf;
    const dir = path.join(outDir, r.map);
    fs.mkdirSync(dir, { recursive: true });
    r.file = `${r.map}/${vTag(r.variant)}_${E.GenLayout.fileName(r.layout)}`;
    fs.writeFileSync(path.join(outDir, r.file), JSON.stringify(r.layout, null, 2));
    delete r.layout;
  }
}

function writeIndex(outDir, rows, meta) {
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ meta, rows }, null, 2));
  const ok = rows.filter(r => r.ok);
  const L = [
    `# Generated layouts ${meta.date.slice(0, 10)}`, '',
    'Tool: `tools/gen_batch.js` (Si_MapBalanceTool), PNGs by `tools/render_layout.py`. Engine defaults: placeability on (minGood 10), swap on, radii 1000 / 2500 / 1200.',
    `Grid: per map x mode ${meta.variants} variants, Latin-square picks of d* ladder (5 steps per extent) x amount level ` +
      '(Balterium 30/45/60/75k with Biotics 20/30/40/50k) x human kit (3/4/6/8); Nest kit 4/6/10/15 (hva, hvhva); total targets 0.9-1.9M per type; own seed per variant.',
    'Totals = kept count x per-patch amount, both in [800k, 2.0M]. Only top-1 results passing every gate. Rows ranked by the fair score ' +
      '(score minus the distance-target part of T1, spec 14.3; lower is better) within each map x mode.',
    `${ok.length}/${rows.length} requests produced a layout; ${meta.runs} search runs; ${(meta.ms / 1000).toFixed(0)} s total.`, '',
  ];
  let curMap = null;
  const sorted = rows.slice().sort((a, b) => (a.map < b.map ? -1 : a.map > b.map ? 1 : 0) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode) ||
    (a.ok ? a.fairRank : 999) - (b.ok ? b.fairRank : 999) || a.variant - b.variant);
  let curMode = null;
  for (const r of sorted) {
    if (r.map !== curMap) { L.push(`## ${r.map} (extent ${r.extent})`, ''); curMap = r.map; curMode = null; }
    if (r.mode !== curMode) {
      if (curMode) L.push('');
      L.push(`### ${r.mode}`, '',
        '| fair rank | v | d* req -> used | enemy d (min-max) | kit req -> got | nest req -> got | Balterium count x amount = total | Biotics count x amount = total | seed | fair | score | T7 | gates | file |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      curMode = r.mode;
    }
    if (!r.ok) {
      L.push(`| - | ${r.variant} | ${r.dRequested} -> - | - | ${r.kitRequested} | ${r.nestRequested ?? '-'} | - | - | ${r.seedRequested} | - | - | - | ${r.status.replace(/\|/g, '/')} | - |`);
      continue;
    }
    const arrow = (a, b) => (a === b ? `${a}` : `${a} -> ${b}`);
    L.push(`| ${r.fairRank} | ${r.variant} | ${arrow(r.dRequested, r.dAchieved)} | ${Math.round(r.dMin)}-${Math.round(r.dMax)} | ${arrow(r.kitRequested, r.kit)} | ` +
      `${r.nest == null ? '-' : arrow(r.nestRequested, r.nest)} | ` +
      `${r.kept.balterium} x ${k(r.amounts.balterium)} = ${M(r.totals.balterium)} | ${r.kept.biotics} x ${k(r.amounts.biotics)} = ${M(r.totals.biotics)} | ` +
      `${r.seed} | ${r.fair.toFixed(2)} | ${r.score.toFixed(2)} | ${r.T7 == null ? '-' : r.T7.toFixed(2)} | ${r.status === 'ok' ? 'all pass' : r.status} | ${path.basename(r.file)} |`);
  }
  L.push('', '## Steps taken (fallbacks)', '');
  for (const r of rows) if (r.fallbacks.length) L.push(`- ${r.map} ${r.mode} v${r.variant}: ${r.fallbacks.join('; ')}`);
  fs.writeFileSync(path.join(outDir, 'index.md'), L.join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv);
  const MC = H.loadMapConfig();
  if (args.dry) {
    for (const map of args.maps) {
      const raw = H.loadRaw(map, MC);
      for (const mode of args.modes) for (let v = 0; v < args.variants; v++) {
        const q = request(raw, mode, v);
        console.log(`${map} ${mode} ${vTag(q.variant)}: d* ${q.d} kit ${q.kit} nest ${q.nest ?? '-'} seed ${q.seed} | ` +
          `balt ${q.counts.balterium}/${q.vanilla.Balterium} x ${k(q.amounts.balterium)} = ${M(q.counts.balterium * q.amounts.balterium)} (target ${M(q.target.balterium)}) | ` +
          `bio ${q.counts.biotics}/${q.vanilla.Biotics} x ${k(q.amounts.biotics)} = ${M(q.counts.biotics * q.amounts.biotics)} (target ${M(q.target.biotics)})`);
      }
    }
    return;
  }
  const E = H.loadEngine();
  const R = require(path.join(H.GEN, 'random.js'));
  fs.mkdirSync(args.out, { recursive: true });
  const rows = [], t0 = Date.now();
  let runs = 0;
  for (const map of args.maps) {
    const raw = H.loadRaw(map, MC);
    for (const mode of args.modes) {
      const ctx = E.GenContext.build(raw, E.GenContext.defaultSettings(raw, { mode, seed: 1 }));
      for (let v = 0; v < args.variants; v++) {
        const req = request(raw, mode, v);
        const t = Date.now();
        const out = runRequest(E, raw, ctx, mode, req);
        out.ms = Date.now() - t;
        runs += out.runs;
        const r = row(raw, mode, req, out, E, R, ctx);
        rows.push(r);
        console.log(`${map} ${mode} ${vTag(req.variant)}: ${r.status} | d* ${req.d}->${r.dAchieved ?? '-'} kit ${req.kit}->${r.kit ?? '-'} nest ${req.nest ?? '-'}->${r.nest ?? '-'} | ` +
          (r.ok ? `balt ${r.kept.balterium}x${r.amounts.balterium} bio ${r.kept.biotics}x${r.amounts.biotics} fair ${r.fair.toFixed(2)} | ` : '') + `${out.runs} runs ${out.ms} ms`);
      }
    }
  }
  writeLayouts(args.out, rows, E);
  writeIndex(args.out, rows, { date: new Date().toISOString(), maps: args.maps, modes: args.modes, variants: args.variants, runs, ms: Date.now() - t0 });
  console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} layouts, ${runs} runs, ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${args.out}`);
}

if (require.main === module) main();
module.exports = { request, variantSpec, planType, fitAmount, distLadder };
