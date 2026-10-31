#!/usr/bin/env node
// Spawn Generator harness (docs/SPAWN_GENERATOR.md, T5 and 12.6).
//
//   node tools/gen_harness.js [--maps A,B] [--modes hvh,hva,hvhva] [--seed N] [--out dir]
//                             [--no-determinism] [--no-seed-check] [--no-selftest] [--strict]
//   node tools/gen_harness.js --layout <file.json> [--layout <file.json> ...]
//   node tools/gen_harness.js [--kit N] [--nest M] ...            exact start kits (spec 13) on every run
//   node tools/gen_harness.js --sweep-kit 3,5,8,12 --sweep-nest 4,8,15 [--maps ..] [--modes ..]
//
// Builds GenRaw from disk (pngjs for masks and heights, Terrain.decode for heights), runs
// GenContext.build + GenSearch.run for every map x mode, writes <out>/gen_report.md,
// <out>/gen_report.json and <out>/layouts/<GenLayout.fileName> (top 3).
// Exit code 1 if a run throws, a run has no candidate, the determinism check fails or a
// selftest fails; --strict also fails on threshold violations (timing, gates, layout checks).
//
// --layout mode (spec 12.6): evaluates existing layout JSONs (the tool's export or a generated
// one: spawns + removed_patches, radii from its `settings`) with GenMetrics.evaluate on the
// geodesic fields and prints gates, terms and the expansion curves; nothing else runs.
//
// Exact kits (spec 13.8): --kit N / --nest M set kitExact / nestKitExact on every run (the Nest
// setting only in hva / hvhva); a run may then end infeasible (GenResult.infeasible, not fatal),
// every presented result's kit is re-counted from its layout (removed_patches + the resource
// JSON + the spawn positions), and the gap check is report-only. --sweep-kit / --sweep-nest run
// one row per map x mode x value (kit: hvh, hva, hvhva; Nest: hva, hvhva; the other setting
// auto) and write <out>/sweep_report.md / .json; exit 1 on an exception, an empty result without
// a reason, a kit miscount, ms > 3000 or a determinism miss on the seed-repeat sample.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const JS = path.join(ROOT, 'js');
const GEN = process.env.GEN_DIR ? path.resolve(process.env.GEN_DIR) : path.join(JS, 'gen');   // override: test stubs
const MODES = ['hvh', 'hva', 'hvhva'];
const AMOUNTS = { balterium: 40000, biotics: 42000 };   // tool slider defaults (spec 10.3)

// ── loading ───────────────────────────────────────────────────────────────

let PNG = null;
function png() {
  if (!PNG) {
    try { PNG = require('pngjs').PNG; } catch (e) {
      throw new Error('pngjs missing: run "npm install" inside tools/');
    }
  }
  return PNG;
}

const Terrain = require(path.join(JS, 'terrain.js'));

function loadMapConfig() {
  const src = fs.readFileSync(path.join(JS, 'map_config.js'), 'utf8');
  // map_config.js declares a top-level `const MAP_CONFIG`; evaluate it in a function scope.
  return new Function(`${src}\n;return MAP_CONFIG;`)();
}

function readPng(file) {
  return png().sync.read(fs.readFileSync(file));   // RGBA, 4 bytes per pixel even for RGB input
}

/** Uint8Array mask on the scan grid, 1 = alpha > 50 (layers.isValidPlacement). */
function readMask(file, cfg) {
  const img = readPng(file);
  if (img.width !== cfg.grid_w || img.height !== cfg.grid_h) {
    throw new Error(`${path.basename(file)} is ${img.width}x${img.height}, map_config says ${cfg.grid_w}x${cfg.grid_h}`);
  }
  const n = img.width * img.height, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = img.data[i * 4 + 3] > 50 ? 1 : 0;
  return out;
}

function readHeights(base) {
  const jf = path.join(DATA, 'heights', `${base}.json`), pf = path.join(DATA, 'heights', `${base}.png`);
  if (!fs.existsSync(jf) || !fs.existsSync(pf)) return { heights: null, meta: null };
  const meta = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const img = readPng(pf);
  if (img.width !== meta.grid_w || img.height !== meta.grid_h) {
    throw new Error(`heights ${base}.png is ${img.width}x${img.height}, json says ${meta.grid_w}x${meta.grid_h}`);
  }
  const bad = Terrain.checkSamples(img.data, meta);
  if (bad.length) throw new Error(`heights ${base}: ${bad.length} sample cells differ from the json`);
  return { heights: Terrain.decode(img.data, meta), meta };
}

const rawCache = new Map();

/** GenRaw (spec 8.2) for one map, read from data/. */
function loadRaw(mapName, MAP_CONFIG) {
  if (rawCache.has(mapName)) return rawCache.get(mapName);
  const cfg = MAP_CONFIG[mapName];
  if (!cfg) throw new Error(`unknown map ${mapName}`);
  const base = cfg.base_map || mapName;
  const maskFile = (type, fac) => {
    const own = path.join(DATA, 'masks', `${type}_${fac}_${mapName}.png`);
    return fs.existsSync(own) ? own : path.join(DATA, 'masks', `${type}_${fac}_${base}.png`);
  };
  const masks = {
    hqSol: readMask(maskFile('hq', 'Sol'), cfg), hqCent: readMask(maskFile('hq', 'Cent'), cfg),
    refSol: readMask(maskFile('ref', 'Sol'), cfg), refCent: readMask(maskFile('ref', 'Cent'), cfg),
  };
  const resources = JSON.parse(fs.readFileSync(path.join(DATA, 'resources', `${base}.json`), 'utf8'));
  const { heights, meta } = readHeights(base);
  const raw = { mapName, cfg, resources, masks, heights, heightsMeta: meta };
  rawCache.set(mapName, raw);
  return raw;
}

function vanillaCounts(resources) {
  const c = { Balterium: 0, Biotics: 0 };
  for (const p of resources.resources || []) if (c[p.type] !== undefined) c[p.type]++;
  return c;
}

/** GenSettings defaults (spec 7 + 8.2) for one map and mode. */
function defaultSettings(raw, mode, seed) {
  const v = vanillaCounts(raw.resources);
  const extent = raw.cfg.extent;
  return {
    mode, seed,
    radii: { build: 1000, chain: 2500, nest: 1200 },
    enemyDistance: Math.min(2700, Math.max(1300, 0.9 * extent)),
    counts: { balterium: Math.round(0.75 * v.Balterium), biotics: Math.round(0.75 * v.Biotics) },
    minKit: 3, minKitAlien: 4, kitCap: null,
    weights: { T1: 1, T2: 0.5, T3: 0.5, T4: 1, T6: 1 },
    expansion: { K: 3, reach: 0.85, w: [0.45, 0.35, 0.20] },
    exposure: { overlook: 0.5, highground: 0.3, openness: 0.2, weight: 1.0 },
    exposureCut: 0.75,
    controlModel: 'geodesic', slopeCost: { k: 1.0, s0: 0.25, sMax: 0.7 },
    nestFlatness: 8, edgeMargin: 250,
    topN: 5, distinctness: null, stage1Keep: null, refineRounds: 2,
  };
}

const ENGINE_FILES = ['rng', 'context', 'grid', 'candidates', 'patches', 'metrics', 'search', 'layout'];

function missingEngineFiles() {
  return ENGINE_FILES.filter(f => !fs.existsSync(path.join(GEN, `${f}.js`)));
}

function loadEngine() {
  const missing = missingEngineFiles();
  if (missing.length) throw new Error(`engine files missing in js/gen/: ${missing.join(', ')}`);
  const m = {};
  for (const f of ENGINE_FILES) m[f] = require(path.join(GEN, `${f}.js`));
  return {
    GenRng: m.rng, GenContext: m.context, GenGrid: m.grid, GenCandidates: m.candidates,
    GenPatches: m.patches, GenMetrics: m.metrics, GenSearch: m.search, GenLayout: m.layout,
  };
}

// ── canonical hashing ─────────────────────────────────────────────────────

const VOLATILE_KEYS = new Set(['ms', 'generated', 'elapsed', 'time', 'timeMs', 'timing', 'timings']);

/** JSON with typed arrays as arrays, Sets sorted, Maps as entries, volatile timing keys dropped. */
function canonical(value) {
  return JSON.stringify(value, function (key, v) {
    if (VOLATILE_KEYS.has(key)) return undefined;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (v instanceof Set) return Array.from(v).sort();
    if (v instanceof Map) return Array.from(v.entries());
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    return v;
  });
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── formatting ────────────────────────────────────────────────────────────

const ROLES = ['Sol', 'Cent', 'Alien'];
const f0 = v => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '-');
const f2 = v => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '-');
const short = r => ({ Sol: 'S', Cent: 'C', Alien: 'A' }[r] || r);

function rolesOf(set, mode) {
  if (!set) return [];
  if (mode === 'hva') return ['Sol', 'Alien'].filter(r => set[r]);
  return ROLES.filter(r => set[r]);
}

function fmtMap(obj, fmt, keyFmt) {
  if (!obj || typeof obj !== 'object') return '-';
  const ks = Object.keys(obj);
  if (!ks.length) return '-';
  return ks.map(k => `${keyFmt ? keyFmt(k) : k}:${fmt(obj[k])}`).join(' ');
}
const pairKey = k => k.split(/[-|,]/).map(short).join('');
const cell = s => String(s).replace(/\|/g, '/');

// ── run one map x mode ───────────────────────────────────────────────────

function runOne(E, raw, mode, seed, exact) {
  // the engine's defaults when it has them (same values as defaultSettings above)
  const over = { mode, seed };
  if (exact && exact.kit != null) over.kitExact = exact.kit;
  if (exact && exact.nest != null && mode !== 'hvh') over.nestKitExact = exact.nest;
  const settings = typeof E.GenContext.defaultSettings === 'function'
    ? E.GenContext.defaultSettings(raw, over) : Object.assign(defaultSettings(raw, mode, seed), over);
  const t0 = process.hrtime.bigint();
  const ctx = E.GenContext.build(raw, settings);
  const t1 = process.hrtime.bigint();
  const result = E.GenSearch.run(ctx, settings);
  const t2 = process.hrtime.bigint();
  return {
    settings, ctx, result,
    buildMs: Number(t1 - t0) / 1e6, searchMs: Number(t2 - t1) / 1e6,
  };
}

const vanillaGapCache = new Map();

/** Largest blank radius per type with every vanilla patch kept (the floor of the coverage fill). */
function vanillaGap(E, raw, ctx) {
  if (vanillaGapCache.has(raw.mapName)) return vanillaGapCache.get(raw.mapName);
  let g = null;
  try {
    const s = E.GenContext.defaultSettings(raw, { counts: { balterium: 1e9, biotics: 1e9 } });
    const p = E.GenPatches.plan(ctx, s, {}, null).gap;
    g = { Balterium: p.Balterium, Biotics: p.Biotics };
  } catch (e) { g = null; }
  vanillaGapCache.set(raw.mapName, g);
  return g;
}

/** Spec 11 F3/F5: gap_B <= max(900 m, 1.05 x vanilla gap_B). */
function gapLimit(row) {
  return row.gapVanilla && Number.isFinite(row.gapVanilla.Balterium) ? Math.max(900, 1.05 * row.gapVanilla.Balterium) : 900;
}
function gapOk(row) {
  return !row.gap || !Number.isFinite(row.gap.Balterium) || row.gap.Balterium <= gapLimit(row);
}

function isExact(settings) {
  return !!settings && (settings.kitExact != null || settings.nestKitExact != null);
}

/**
 * Kit counts of a layout JSON from its own data only (spec 13.8): kept = the resource JSON's
 * active patches not in removed_patches; human kit = kept Balterium within solBuildRadius of
 * Sol[0] (and Cent[0]); Nest kit = kept Biotics within alienBuildRadius of Alien[0].
 */
function layoutKits(L, raw, mode) {
  const rm = new Set((L.resources && L.resources.removed_patches) || []);
  const st = L.settings || {}, sp = L.spawns || {};
  const kept = (raw.resources.resources || []).filter(p => p.active !== false && !rm.has(p.idx));
  const count = (s, type, R) => (s ? kept.filter(p => p.type === type && Math.hypot(p.x - s.x, p.z - s.z) <= R).length : null);
  const out = { Sol: count((sp.Sol || [])[0], 'Balterium', st.solBuildRadius || 1000) };
  if (mode !== 'hva') out.Cent = count((sp.Cent || [])[0], 'Balterium', st.centBuildRadius || st.solBuildRadius || 1000);
  if (mode !== 'hvh') out.Alien = count((sp.Alien || [])[0], 'Biotics', st.alienBuildRadius || 1200);
  return out;
}

/** Issues of a layout against the exact kits asked for ([] when they match or are auto). */
function kitIssues(L, raw, mode, settings) {
  const k = layoutKits(L, raw, mode), out = [];
  if (settings.kitExact != null) for (const r of ['Sol', 'Cent']) if (k[r] !== undefined && k[r] !== settings.kitExact) out.push(`${r} kit ${k[r]} != ${settings.kitExact}`);
  if (settings.nestKitExact != null && mode !== 'hvh' && k.Alien !== settings.nestKitExact) out.push(`Nest kit ${k.Alien} != ${settings.nestKitExact}`);
  return out;
}

function summarize(raw, mode, seed, run, E) {
  const { settings, result, ctx } = run;
  const ev = (result && result.candidates && result.candidates[0]) || null;
  const stats = (result && result.stats) || {};
  const row = {
    map: raw.mapName, mode, seed, extent: raw.cfg.extent,
    ms: stats.ms, buildMs: run.buildMs, searchMs: run.searchMs,
    candidates: stats.candidates || null, stage1Sets: stats.stage1Sets, stage2Sets: stats.stage2Sets,
    nResults: result && result.candidates ? result.candidates.length : 0,
    counts: settings.counts, enemyDistance: settings.enemyDistance,
    timing: stats.timing || null,
    gapVanilla: vanillaGap(E, raw, ctx),
  };
  if (isExact(settings)) {
    row.exact = { kit: settings.kitExact, nest: mode === 'hvh' ? null : settings.nestKitExact };
    row.kitRange = stats.kitRange || null;
  }
  if (result && result.infeasible) row.infeasible = result.infeasible;
  if (!ev) return row;
  const roles = rolesOf(ev.set, mode);
  const m = ev.metrics || {};
  row.gateFails = ev.gateFails || [];
  row.score = ev.score;
  row.terms = ev.terms || {};
  row.positions = {};
  row.exposure = {};
  row.elev = {};
  for (const r of roles) {
    const c = ev.set[r];
    row.positions[r] = { x: c.x, z: c.z };
    row.exposure[r] = m.exposure && m.exposure[r] !== undefined ? m.exposure[r] : c.E;
    row.elev[r] = c.z0;
  }
  const zs = Object.values(row.elev).filter(v => typeof v === 'number');
  row.elevSpan = zs.length ? Math.max(...zs) - Math.min(...zs) : null;
  row.distances = m.distances || null;
  if (!row.distances) {
    row.distances = {};
    for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) {
      const a = ev.set[roles[i]], b = ev.set[roles[j]];
      row.distances[`${roles[i]}-${roles[j]}`] = Math.hypot(a.x - b.x, a.z - b.z);
    }
  }
  row.squeeze = m.squeeze;
  row.shares = m.shares || null;
  row.shares2 = m.shares2 || null;
  row.kit = m.kit || (ev.plan && ev.plan.kit) || null;
  row.gap = m.gap || (ev.plan && ev.plan.gap) || null;
  row.T = m.T || null;
  row.expansion = m.expansion || null;
  row.expRatio = m.expansionRatio || null;
  // G5 (spec 12.6): does any presented set pass it (the top-1 then must, unless it ranks on fewer gate fails)
  row.g5Shown = result.candidates.map(e => !(e.gateFails || []).includes('G5'));
  if (ev.plan && ev.plan.kept) {
    row.kept = { Balterium: ev.plan.kept.Balterium.length, Biotics: ev.plan.kept.Biotics.length };
    row.removed = ev.plan.removed ? ev.plan.removed.length : null;
  }
  // top-3 layouts
  row.layouts = [];
  const top = result.candidates.slice(0, 3);
  top.forEach((e, i) => {
    const layout = E.GenLayout.build(ctx, settings, e, i + 1, AMOUNTS);
    row.layouts.push({ rank: i + 1, layout, issues: checkLayout(layout, mode, raw, settings, e) });
  });
  // exact kits: every presented result, re-counted from its layout
  if (row.exact) {
    row.kitMiss = [];
    result.candidates.forEach((e, i) => {
      const L = i < 3 ? row.layouts[i].layout : E.GenLayout.build(ctx, settings, e, i + 1, AMOUNTS);
      const iss = kitIssues(L, raw, mode, settings);
      if (iss.length) row.kitMiss.push(`#${i + 1}: ${iss.join(', ')}`);
    });
    row.layoutKit = layoutKits(row.layouts[0].layout, raw, mode);
  }
  return row;
}

/** Contract checks on a layout JSON (spec 8.1, T3 verify). */
function checkLayout(L, mode, raw, settings, ev) {
  const issues = [];
  if (!L || typeof L !== 'object') return ['layout is not an object'];
  if (L.map !== raw.mapName) issues.push(`map=${L.map}`);
  const gm = L.game_modes || {};
  const trues = Object.keys(gm).filter(k => gm[k] === true);
  if (trues.length !== 1 || trues[0] !== mode) issues.push(`game_modes true=[${trues}]`);
  const sp = L.spawns || {};
  const first = f => (Array.isArray(sp[f]) && sp[f][0]) || null;
  if (!first('Sol')) issues.push('no Sol[0]');
  if (mode !== 'hva' && !first('Cent')) issues.push('no Cent[0]');
  if (mode === 'hva') {
    const s = first('Sol'), c = first('Cent');
    if (!s || !c || s.x !== c.x || s.z !== c.z) issues.push('hva: Sol[0] != Cent[0]');
  }
  if (mode !== 'hvh' && !first('Alien')) issues.push('no Alien[0]');
  if (mode === 'hvh' && first('Alien')) issues.push('hvh has an Alien spawn');
  const res = L.resources || {};
  const rm = res.removed_patches;
  if (!Array.isArray(rm)) issues.push('removed_patches missing');
  else {
    for (let i = 1; i < rm.length; i++) if (!(rm[i] > rm[i - 1])) { issues.push('removed_patches not sorted unique'); break; }
    const byIdx = new Map((raw.resources.resources || []).map(p => [p.idx, p.type]));
    const kept = { Balterium: 0, Biotics: 0 };
    const rmSet = new Set(rm);
    for (const [idx, t] of byIdx) if (!rmSet.has(idx) && kept[t] !== undefined) kept[t]++;
    const v = vanillaCounts(raw.resources);
    const wantB = Math.min(settings.counts.balterium, v.Balterium), wantO = Math.min(settings.counts.biotics, v.Biotics);
    if (kept.Balterium !== wantB) issues.push(`kept Balterium ${kept.Balterium} != ${wantB}`);
    if (kept.Biotics !== wantO) issues.push(`kept Biotics ${kept.Biotics} != ${wantO}`);
    for (const i of rm) if (!byIdx.has(i)) { issues.push(`removed idx ${i} unknown`); break; }
  }
  if (res.patch_overrides && Object.keys(res.patch_overrides).length) issues.push('patch_overrides not empty');
  if (!L._meta || !L._meta.generator) issues.push('_meta.generator missing');
  return issues;
}

// ── report ────────────────────────────────────────────────────────────────

const EXPECTED_GATE_FAILS = new Set(['BlackIsle|hvhva', 'Citadel|hvhva']);

function msLimit() { return 3000; }   // spec 6 / 10.9: 3 s on every map

function thresholdIssues(row) {
  const out = [];
  if (row.error) return out;
  const ms = typeof row.ms === 'number' ? row.ms : row.searchMs;
  if (ms > msLimit(row.extent)) out.push(`ms ${Math.round(ms)} > ${msLimit(row.extent)}`);
  const g14 = (row.gateFails || []).filter(g => g !== 'G5');
  if (g14.length && !EXPECTED_GATE_FAILS.has(`${row.map}|${row.mode}`)) out.push(`top-1 fails ${g14.join(',')}`);
  if (g5Miss(row)) out.push('top-1 fails G5 while a presented set passes it');
  // spec 13.6: report-only when an exact kit is on
  if (!gapOk(row) && !row.exact) out.push(`gap B ${Math.round(row.gap.Balterium)} > ${Math.round(gapLimit(row))}`);
  if (row.kitMiss && row.kitMiss.length) out.push(`exact kit miss ${row.kitMiss.join('; ')}`);
  for (const l of row.layouts || []) if (l.issues.length) out.push(`layout #${l.rank}: ${l.issues.join('; ')}`);
  return out;
}

/** Spec 12.6: the top-1 fails G5 although a presented set passes it. */
function g5Miss(row) {
  return !!(row.gateFails && row.gateFails.includes('G5') && row.g5Shown && row.g5Shown.some(Boolean));
}

/** Human keys of an expansion report (hva: the one human position). */
function expHumans(exp) { return exp ? ['Sol', 'Cent'].filter(k => exp[k]) : []; }

/** "S 7/11/13 C 14/18/20" */
function fmtCurves(exp) {
  return expHumans(exp).map(k => `${short(k)} ${exp[k].V.join('/')}`).join(' ') || '-';
}

/** min/max at k = 1 and k = K, or null (hva, no curves). */
function expEnds(row) {
  const r = row.expRatio;
  return r && r.length ? { first: r[0], last: r[r.length - 1] } : null;
}

function writeReport(outDir, rows, extra) {
  const L = [];
  L.push('# Spawn Generator harness report', '');
  L.push(`Generated ${new Date().toISOString()} | Node ${process.version} | seed ${extra.seed} | ` +
    `${rows.length} runs | amounts ${AMOUNTS.balterium}/${AMOUNTS.biotics}`, '');
  L.push('Times: `ms` = GenResult.stats.ms, `ctx` = GenContext.build wall time, `run` = GenSearch.run wall time. ' +
    'Limit: 3000 ms on every map. Gate fails are expected only for BlackIsle and Citadel hvhva. ' +
    'Gap check: gap B <= max(900 m, 1.05 x vanilla gap B). ' +
    'G5 (spec 12.2) is reported separately: a top-1 G5 fail is a miss only if a presented set passes G5.', '');

  L.push('## Summary', '');
  L.push('| map | mode | ms | ctx | run | stages cand/s1/s2/ref | cand h/a | s1/s2 sets | results | gate fails | score | T1 | T2 | T3 | T4 | T6 | status |');
  L.push('|---|---|--:|--:|--:|---|---|---|--:|---|--:|--:|--:|--:|--:|--:|---|');
  for (const r of rows) {
    if (r.error) {
      L.push(`| ${r.map} | ${r.mode} | - | - | - | - | - | - | - | - | - | - | - | - | - | - | ERROR ${cell(r.error)} |`);
      continue;
    }
    const c = r.candidates || {};
    const t = r.terms || {};
    const thr = thresholdIssues(r);
    const status = r.infeasible ? `infeasible: ${cell(r.infeasible.reason)}: ${cell(r.infeasible.detail)}`
      : r.nResults === 0 ? 'NO CANDIDATE' : thr.length ? `WARN ${cell(thr.join('; '))}` : 'ok';
    const tm = r.timing || {};
    const stages = r.timing ? `${f0(tm.candidates)}/${f0(tm.stage1)}/${f0(tm.stage2)}/${f0(tm.refine)}` : '-';
    L.push(`| ${r.map} | ${r.mode} | ${f0(r.ms)} | ${f0(r.buildMs)} | ${f0(r.searchMs)} | ${stages} | ${f0(c.human)}/${f0(c.alien)} | ` +
      `${f0(r.stage1Sets)}/${f0(r.stage2Sets)} | ${r.nResults} | ${r.gateFails ? (r.gateFails.join(',') || '-') : 'n/a'} | ${f2(r.score)} | ` +
      `${f2(t.T1)} | ${f2(t.T2)} | ${f2(t.T3)} | ${f2(t.T4)} | ${f2(t.T6)} | ${status} |`);
  }
  L.push('');

  L.push('## Expansion layer (top-1, spec 12)', '');
  L.push('V(1..K) = Balterium grabbed by the best 1..K expansion HQs per human (greedy, own side, outside the kit); ' +
    'layer = own-side kept Balterium outside R_b within reach x R_c + R_b; min/max = min_i V_i(k) / max_i V_i(k) at k = 1 and k = K ' +
    '(target >= 0.85 on >= 11 of 13 hvh maps); G5 = |dV(1)| <= 1 and |dV(K)| <= 2; G5 shown = presented sets passing G5.', '');
  L.push('| map | mode | V(1..K) | layer | min/max k=1 | min/max k=K | G5 | G5 shown | T6 |');
  L.push('|---|---|---|---|--:|--:|---|---|--:|');
  for (const r of rows) {
    if (r.error || !r.expansion) continue;
    const e = expEnds(r);
    const g5 = r.mode === 'hva' ? '-' : (r.gateFails.includes('G5') ? (g5Miss(r) ? 'FAIL (miss)' : 'fail (none passes)') : 'ok');
    const shown = r.mode === 'hva' ? '-' : `${r.g5Shown.filter(Boolean).length}/${r.g5Shown.length}`;
    L.push(`| ${r.map} | ${r.mode} | ${fmtCurves(r.expansion)} | ${expHumans(r.expansion).map(k => `${short(k)} ${r.expansion[k].layer}`).join(' ')} | ` +
      `${e ? f2(e.first) : '-'} | ${e ? f2(e.last) : '-'} | ${g5} | ${shown} | ${f2((r.terms || {}).T6)} |`);
  }
  L.push('');

  L.push('## Top-1 detail', '');
  L.push('`d*` = enemy distance setting; positions x,z in m; distances in m; exposure E per structure; ' +
    'elev = ground height span over the structures; gap = largest blank radius per type (m); vanilla gap = the same with every ' +
    'vanilla patch kept; gap ok = gap B <= max(900, 1.05 x vanilla gap B); shares = control-area shares (T3); shares2 = share of ' +
    'the own resource type in the soft territory (T2); kept = kept patch totals (requested).', '');
  L.push('| map | mode | d* | positions | distances | squeeze | shares | shares2 | kit | exposure | elev span | gap B/O | vanilla gap B/O | gap ok | kept B/O (req) | T per side |');
  L.push('|---|---|--:|---|---|--:|---|---|---|---|--:|---|---|---|---|---|');
  for (const r of rows) {
    if (r.error || !r.positions) continue;
    const pos = Object.keys(r.positions).map(k => `${short(k)}(${f0(r.positions[k].x)},${f0(r.positions[k].z)})`).join(' ');
    const gap = r.gap ? `${f0(r.gap.Balterium)}/${f0(r.gap.Biotics)}` : '-';
    const vgap = r.gapVanilla ? `${f0(r.gapVanilla.Balterium)}/${f0(r.gapVanilla.Biotics)}` : '-';
    const gok = r.gap ? (gapOk(r) ? 'ok' : `FAIL > ${f0(gapLimit(r))}`) : '-';
    const kept = r.kept ? `${r.kept.Balterium}/${r.kept.Biotics} (${r.counts.balterium}/${r.counts.biotics})` : '-';
    L.push(`| ${r.map} | ${r.mode} | ${f0(r.enemyDistance)} | ${pos} | ${fmtMap(r.distances, f0, pairKey)} | ${f2(r.squeeze)} | ` +
      `${fmtMap(r.shares, f2, short)} | ${fmtMap(r.shares2, f2, short)} | ${fmtMap(r.kit, f0, short)} | ${fmtMap(r.exposure, f2, short)} | ${f0(r.elevSpan)} | ` +
      `${gap} | ${vgap} | ${gok} | ${kept} | ${fmtMap(r.T, v => (typeof v === 'number' ? v.toExponential(2) : '-'), short)} |`);
  }
  L.push('');

  L.push('## Checks', '');
  for (const line of extra.checks) L.push(`- ${line}`);
  L.push('');
  if (extra.errors.length) {
    L.push('## Errors', '');
    for (const e of extra.errors) { L.push(`### ${e.map} ${e.mode}`, '', '```', e.stack, '```', ''); }
  }
  fs.writeFileSync(path.join(outDir, 'gen_report.md'), L.join('\n'));
  const json = rows.map(r => Object.assign({}, r, { layouts: (r.layouts || []).map(l => ({ rank: l.rank, issues: l.issues })) }));
  fs.writeFileSync(path.join(outDir, 'gen_report.json'), JSON.stringify({ seed: extra.seed, checks: extra.checks, rows: json }, null, 1));
}

// ── main ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { maps: null, modes: MODES.slice(), seed: 1, out: path.join(__dirname, 'out'),
    determinism: true, seedCheck: true, selftest: true, strict: false, layouts: [],
    kit: null, nest: null, sweepKit: null, sweepNest: null, sweepDet: 5 };
  const ints = (k, v) => {
    const out = String(v).split(',').map(s => s.trim()).filter(Boolean).map(Number);
    if (!out.length || out.some(n => !Number.isInteger(n) || n < 0)) throw new Error(`${k} wants whole numbers >= 0, got ${v}`);
    return out;
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], next = () => argv[++i];
    if (k === '--maps') a.maps = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--modes') a.modes = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--seed') a.seed = Number(next());
    else if (k === '--out') a.out = path.resolve(next());
    else if (k === '--no-determinism') a.determinism = false;
    else if (k === '--no-seed-check') a.seedCheck = false;
    else if (k === '--no-selftest') a.selftest = false;
    else if (k === '--strict') a.strict = true;
    else if (k === '--layout') a.layouts.push(path.resolve(next()));
    else if (k === '--kit') a.kit = ints(k, next())[0];
    else if (k === '--nest') a.nest = ints(k, next())[0];
    else if (k === '--sweep-kit') a.sweepKit = ints(k, next());
    else if (k === '--sweep-nest') a.sweepNest = ints(k, next());
    else if (k === '--sweep-det') a.sweepDet = ints(k, next())[0];
    else if (k === '-h' || k === '--help') {
      console.log('node tools/gen_harness.js [--maps A,B] [--modes hvh,hva,hvhva] [--seed N] [--out dir] ' +
        '[--no-determinism] [--no-seed-check] [--no-selftest] [--strict] [--kit N] [--nest M]\n' +
        'node tools/gen_harness.js --layout <file.json> [--layout <file.json> ...]\n' +
        'node tools/gen_harness.js --sweep-kit 3,5,8,12 --sweep-nest 4,8,15 [--maps A,B] [--modes ..] [--sweep-det every-Nth-row]');
      process.exit(0);
    } else throw new Error(`unknown argument ${k}`);
  }
  for (const m of a.modes) if (!MODES.includes(m)) throw new Error(`unknown mode ${m}`);
  if (!Number.isFinite(a.seed)) throw new Error('--seed must be a number');
  return a;
}

function posKey(row) {
  if (!row || !row.positions) return null;
  return Object.keys(row.positions).sort().map(k => `${k}:${Math.round(row.positions[k].x)},${Math.round(row.positions[k].z)}`).join(' ');
}

// ── --layout mode (spec 12.6) ─────────────────────────────────────────────

/**
 * Evaluates one layout JSON: settings = the engine defaults for its map and mode, radii from
 * layout.settings; a generated layout also brings enemyDistance / counts / minKit from
 * _meta.generator.settings (weights and expansion stay the current defaults), a hand-made one
 * gets counts = its kept totals (G4 then only checks the plan). Spawns: the isSpawn entry (else
 * [0]) per faction, G1 on the scan cell under it, distances from the exact position.
 */
function evalLayout(E, file, MAP_CONFIG) {
  const L = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = loadRaw(L.map, MAP_CONFIG);
  const gm = L.game_modes || {};
  const mode = MODES.find(m => gm[m]) || 'hvh';
  const ls = L.settings || {}, meta = (L._meta && L._meta.generator && L._meta.generator.settings) || {};
  const removed = new Set((L.resources && L.resources.removed_patches) || []);
  const kept = { Balterium: [], Biotics: [] };
  for (const p of raw.resources.resources || []) {
    if (p.active === false || !kept[p.type] || removed.has(p.idx)) continue;
    kept[p.type].push(p.idx);
  }
  const over = {
    mode, seed: meta.seed !== undefined ? meta.seed : 1,
    radii: { build: ls.solBuildRadius || 1000, chain: ls.solChainRange || 2500, nest: ls.alienBuildRadius || 1200 },
    counts: meta.counts || { balterium: kept.Balterium.length, biotics: kept.Biotics.length },
  };
  for (const k of ['enemyDistance', 'minKit', 'minKitAlien', 'edgeMargin', 'controlModel']) if (meta[k] !== undefined) over[k] = meta[k];
  const settings = E.GenContext.defaultSettings(raw, over);
  const ctx = E.GenContext.build(raw, settings);
  const sc = ctx.scan;
  const spawnOf = fac => {
    const list = (L.spawns && L.spawns[fac]) || [];
    return list.find(s => s && s.isSpawn) || list[0] || null;
  };
  const candOf = (fac, role) => {
    const s = spawnOf(fac);
    if (!s) throw new Error(`${path.basename(file)}: no ${fac} spawn`);
    const px = Math.round((s.x - sc.minX) / sc.step), py = Math.round((sc.maxZ - s.z) / sc.step);
    const c = E.GenCandidates.at(ctx, settings, role, px, py, fac);
    c.x = s.x; c.z = s.z;
    for (let k = 0; k < ctx.patches.length; k++) c.pd[k] = Math.hypot(ctx.patches[k].x - s.x, ctx.patches[k].z - s.z);
    delete c.v1solo;
    return c;
  };
  const set = {};
  set.Sol = candOf('Sol', 'human');
  set.Cent = mode === 'hva' ? set.Sol : candOf('Cent', 'human');
  if (mode !== 'hvh') set.Alien = candOf('Alien', 'alien');
  const fields = E.GenGrid.fields(ctx, settings, set, new Map());
  const plan = {
    kept, removed: Array.from(removed).sort((a, b) => a - b), frozen: new Set(), kit: {}, rings: {}, gap: null,
    target: { Balterium: kept.Balterium.length, Biotics: kept.Biotics.length },
  };
  const ev = E.GenMetrics.evaluate(ctx, settings, set, fields, plan);
  return { file, L, mode, settings, set, ev };
}

function printLayoutEval(r) {
  const { ev, settings, mode, set } = r, m = ev.metrics || {};
  const gates = E_GATES(r).map(g => `${g}:${ev.gateFails.includes(g) ? 'FAIL' : 'ok'}`).join(' ');
  const pos = rolesOf(set, mode).map(k => `${short(k)}(${f0(set[k].x)},${f0(set[k].z)})`).join(' ');
  console.log(`${path.basename(r.file)}: ${r.L.map} ${mode}  R_b ${settings.radii.build} R_c ${settings.radii.chain} ` +
    `d* ${f0(settings.enemyDistance)}  kept B/O ${m.kept ? `${m.kept.Balterium}/${m.kept.Biotics}` : '-'}`);
  console.log(`  spawns ${pos}  d ${fmtMap(m.distances, f0, pairKey)}  kit ${fmtMap(m.kit, f0, short)}`);
  console.log(`  gates ${gates}${ev.gateFails.length ? `  -> fails ${ev.gateFails.join(',')}` : ''}`);
  console.log(`  terms ${Object.keys(ev.terms).map(k => `${k} ${f2(ev.terms[k])}`).join('  ')}  score ${f2(ev.score)}`);
  const ex = m.expansion || {};
  for (const k of expHumans(ex)) {
    const cells = ex[k].cells.map(c => (c ? `(${f0(c.x)},${f0(c.z)})` : '-')).join(' ');
    console.log(`  V ${k.padEnd(4)} ${ex[k].V.join('/').padEnd(10)} layer ${ex[k].layer}  cells ${cells}`);
  }
  if (m.expansionRatio) console.log(`  min/max per k ${m.expansionRatio.map(v => f2(v)).join(' / ')}`);
}

function E_GATES(r) { return r.mode === 'hva' ? ['G1', 'G2', 'G3', 'G4'] : ['G1', 'G2', 'G3', 'G4', 'G5']; }

function layoutMode(args) {
  const MAP_CONFIG = loadMapConfig();
  const E = loadEngine();
  let bad = false;
  for (const file of args.layouts) {
    try { printLayoutEval(evalLayout(E, file, MAP_CONFIG)); } catch (e) {
      bad = true;
      console.log(`${path.basename(file)}: ERROR ${e.stack || e.message}`);
    }
    console.log('');
  }
  process.exitCode = bad ? 1 : 0;
}

// ── sweep mode (spec 13.8) ───────────────────────────────────────────────

/**
 * One row per map x mode x value: --sweep-kit values (nest auto) in hvh / hva / hvhva and
 * --sweep-nest values (kit auto) in hva / hvhva. Status ok (every presented result re-counted
 * from its layout) or infeasible: <reason>; FAIL on an exception, an empty result without a
 * reason, a kit miscount or ms > 3000. Every --sweep-det-th row is run again with the same seed
 * (SHA-256 of the canonical result must match).
 */
async function sweepMode(args) {
  const MAP_CONFIG = loadMapConfig();
  const maps = args.maps || Object.keys(MAP_CONFIG);
  for (const m of maps) if (!MAP_CONFIG[m]) throw new Error(`unknown map ${m}`);
  const E = loadEngine();
  fs.mkdirSync(args.out, { recursive: true });
  const jobs = [];
  for (const map of maps) {
    for (const mode of args.modes) {
      for (const n of args.sweepKit || []) jobs.push({ map, mode, kind: 'kit', value: n, exact: { kit: n, nest: null } });
      if (mode !== 'hvh') for (const m of args.sweepNest || []) jobs.push({ map, mode, kind: 'nest', value: m, exact: { kit: null, nest: m } });
    }
  }
  const rows = [];
  let fatal = false;
  for (let q = 0; q < jobs.length; q++) {
    const j = jobs[q];
    process.stdout.write(`${j.map.padEnd(18)} ${j.mode.padEnd(6)} ${j.kind} ${String(j.value).padEnd(3)} `);
    const row = { map: j.map, mode: j.mode, kind: j.kind, value: j.value };
    try {
      const raw = loadRaw(j.map, MAP_CONFIG);
      const run = runOne(E, raw, j.mode, args.seed, j.exact);
      const s = summarize(raw, j.mode, args.seed, run, E);
      Object.assign(row, {
        ms: s.ms, nResults: s.nResults, kitRange: s.kitRange, infeasible: s.infeasible || null,
        gateFails: s.gateFails || null, kitMiss: s.kitMiss || [], layoutKit: s.layoutKit || null,
        g4: run.result.candidates.filter(e => (e.gateFails || []).includes('G4')).length,
        g5: run.result.candidates.filter(e => (e.gateFails || []).includes('G5')).length,
        gap: s.gap || null, gapOk: s.gap ? gapOk(s) : null,
        hash: sha256(canonical(run.result)),
      });
      const problems = [];
      if (!row.nResults && !(row.infeasible && row.infeasible.reason && row.infeasible.detail)) problems.push('empty result without a reason');
      if (row.nResults && row.infeasible) problems.push('results and infeasible at once');
      if (row.kitMiss.length) problems.push(`kit miss ${row.kitMiss.join('; ')}`);
      if (!(row.ms <= 3000)) problems.push(`ms ${row.ms} > 3000`);
      if (row.nResults && run.result.candidates.some(e => (e.gateFails || []).some(g => g === 'G1' || g === 'G2' || g === 'G3'))) problems.push('a presented set fails G1-G3');
      // spec 13.5 (manager ruling): exact mode never presents a G4 fail (kit_total / nest_total instead)
      if (row.g4) problems.push(`${row.g4} presented set(s) fail G4`);
      row.status = problems.length ? `FAIL ${problems.join('; ')}` : row.infeasible ? `infeasible: ${row.infeasible.reason}` : 'ok';
      if (problems.length) fatal = true;
      if (args.sweepDet > 0 && q % args.sweepDet === 0) {
        const h2 = sha256(canonical(runOne(E, raw, j.mode, args.seed, j.exact).result));
        row.det = h2 === row.hash;
        if (!row.det) { fatal = true; row.status += ' DETERMINISM FAIL'; }
      }
    } catch (e) {
      row.status = `FAIL exception ${e.message}`;
      row.stack = e.stack;
      fatal = true;
    }
    console.log(`${f0(row.ms)} ms  ${row.status}` + (row.infeasible ? `: ${row.infeasible.detail}` : row.layoutKit ? `  kit ${fmtMap(row.layoutKit, f0, short)}` : ''));
    rows.push(row);
  }

  // report
  const L = ['# Spawn Generator exact-kit sweep (spec 13.8)', '',
    `Generated ${new Date().toISOString()} | seed ${args.seed} | ${rows.length} rows | kit values ${(args.sweepKit || []).join(',') || '-'} | ` +
    `Nest values ${(args.sweepNest || []).join(',') || '-'} | determinism sample every ${args.sweepDet}th row`, '',
    'kit = Balterium within R_b per human (S/C) and Biotics within R_n for the Nest (A), re-counted from the top-1 layout ' +
    '(removed_patches + resource JSON); every presented result is checked the same way. G4/G5 = presented results failing them. ' +
    'Gap check report-only.', '',
    '| map | mode | setting | ms | results | kit (top-1 layout) | max h/a | G4 | G5 | gap B ok | det | status |',
    '|---|---|---|--:|--:|---|---|--:|--:|---|---|---|'];
  for (const r of rows) {
    const kr = r.kitRange ? `${r.kitRange.humanMax ?? '-'}/${r.kitRange.alienMax ?? '-'}` : '-';
    L.push(`| ${r.map} | ${r.mode} | ${r.kind} ${r.value} | ${f0(r.ms)} | ${r.nResults ?? '-'} | ${r.layoutKit ? fmtMap(r.layoutKit, f0, short) : '-'} | ${kr} | ` +
      `${r.g4 ?? '-'} | ${r.g5 ?? '-'} | ${r.gapOk === null || r.gapOk === undefined ? '-' : r.gapOk ? 'ok' : 'over'} | ${r.det === undefined ? '' : r.det ? 'same' : 'DIFF'} | ` +
      `${cell(r.status)}${r.infeasible ? ': ' + cell(r.infeasible.detail) : ''} |`);
  }
  L.push('', '## Summary per setting', '', '| setting | rows | ok | infeasible | reasons | FAIL |', '|---|--:|--:|--:|---|--:|');
  const keys = [...new Set(rows.map(r => `${r.kind} ${r.value}`))];
  const summary = [];
  for (const k of keys) {
    const rs = rows.filter(r => `${r.kind} ${r.value}` === k);
    const reasons = {};
    for (const r of rs) if (r.infeasible && !String(r.status).startsWith('FAIL')) reasons[r.infeasible.reason] = (reasons[r.infeasible.reason] || 0) + 1;
    const line = { setting: k, rows: rs.length, ok: rs.filter(r => r.status === 'ok').length,
      infeasible: rs.filter(r => String(r.status).startsWith('infeasible')).length, reasons,
      fail: rs.filter(r => String(r.status).startsWith('FAIL') || String(r.status).includes('DETERMINISM')).length };
    summary.push(line);
    L.push(`| ${k} | ${line.rows} | ${line.ok} | ${line.infeasible} | ${Object.keys(reasons).map(x => `${x} ${reasons[x]}`).join(', ') || '-'} | ${line.fail} |`);
  }
  const det = rows.filter(r => r.det !== undefined);
  const msMax = Math.max(0, ...rows.filter(r => typeof r.ms === 'number').map(r => r.ms));
  const checks = [
    `rows: ${rows.length}; ok ${rows.filter(r => r.status === 'ok').length}, infeasible ${rows.filter(r => String(r.status).startsWith('infeasible')).length}, FAIL ${rows.filter(r => String(r.status).startsWith('FAIL')).length}`,
    `ms <= 3000: ${rows.filter(r => r.ms <= 3000).length}/${rows.length}; max ${f0(msMax)} ms`,
    `determinism (seed repeated) on the sample: ${det.filter(r => r.det).length}/${det.length} identical`,
    `presented results with a G4 fail: ${rows.reduce((a, r) => a + (r.g4 || 0), 0)} over ${rows.filter(r => r.g4).length} rows; top-1 G4 fails: ${rows.filter(r => r.gateFails && r.gateFails.includes('G4')).length}`,
    `gap B over the auto limit on the top-1 (report-only): ${rows.filter(r => r.gapOk === false).length} rows`,
  ];
  L.push('', '## Checks', '', ...checks.map(c => `- ${c}`), '');
  fs.writeFileSync(path.join(args.out, 'sweep_report.md'), L.join('\n'));
  fs.writeFileSync(path.join(args.out, 'sweep_report.json'), JSON.stringify({ seed: args.seed, checks, summary, rows }, null, 1));
  console.log('');
  for (const c of checks) console.log(c);
  for (const s of summary) console.log(`${s.setting}: ${s.rows} rows, ok ${s.ok}, infeasible ${s.infeasible} (${Object.keys(s.reasons).map(x => `${x} ${s.reasons[x]}`).join(', ') || '-'}), FAIL ${s.fail}`);
  console.log(`\nreport: ${path.join(args.out, 'sweep_report.md')}`);
  process.exitCode = fatal ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.layouts.length) return layoutMode(args);
  if (args.sweepKit || args.sweepNest) return sweepMode(args);
  const exact = args.kit != null || args.nest != null ? { kit: args.kit, nest: args.nest } : null;
  const MAP_CONFIG = loadMapConfig();
  const maps = args.maps || Object.keys(MAP_CONFIG);
  for (const m of maps) if (!MAP_CONFIG[m]) throw new Error(`unknown map ${m}`);
  const E = loadEngine();
  fs.mkdirSync(path.join(args.out, 'layouts'), { recursive: true });

  const rows = [], errors = [], checks = [];
  let fatal = false;

  for (const map of maps) {
    let raw;
    try { raw = loadRaw(map, MAP_CONFIG); } catch (e) {
      for (const mode of args.modes) {
        rows.push({ map, mode, error: `data: ${e.message}` });
        errors.push({ map, mode, stack: e.stack });
      }
      fatal = true;
      continue;
    }
    for (const mode of args.modes) {
      process.stdout.write(`${map.padEnd(18)} ${mode.padEnd(6)} `);
      let row;
      try {
        const run = runOne(E, raw, mode, args.seed, exact);
        row = summarize(raw, mode, args.seed, run, E);
        row._hash = sha256(canonical(run.result));
        for (const l of row.layouts || []) {
          fs.writeFileSync(path.join(args.out, 'layouts', E.GenLayout.fileName(l.layout)),
            JSON.stringify(l.layout, null, 1));
        }
        // an infeasible exact request is a named result, not a failure (spec 13.5)
        if (row.nResults === 0 && !row.infeasible) fatal = true;
        if (row.kitMiss && row.kitMiss.length) fatal = true;
        console.log(row.infeasible ? `${f0(row.ms)} ms  infeasible: ${row.infeasible.reason}: ${row.infeasible.detail}`
          : `${f0(row.ms)} ms  score ${f2(row.score)}  fails [${(row.gateFails || []).join(',')}]` +
          (row.nResults === 0 ? '  NO CANDIDATE' : '') + (row.kitMiss && row.kitMiss.length ? `  KIT MISS ${row.kitMiss.join('; ')}` : ''));
      } catch (e) {
        row = { map, mode, error: e.message };
        errors.push({ map, mode, stack: e.stack });
        fatal = true;
        console.log(`ERROR ${e.message}`);
      }
      rows.push(row);
    }
  }

  // determinism: same seed again -> same SHA-256 of the canonical result
  if (args.determinism) {
    let bad = 0, n = 0;
    for (const r of rows) {
      if (r.error) continue;
      try {
        const run = runOne(E, loadRaw(r.map, MAP_CONFIG), r.mode, args.seed, exact);
        const h = sha256(canonical(run.result));
        n++;
        if (h !== r._hash) { bad++; checks.push(`determinism FAIL ${r.map} ${r.mode}: ${r._hash.slice(0, 12)} vs ${h.slice(0, 12)}`); }
      } catch (e) { bad++; checks.push(`determinism ERROR ${r.map} ${r.mode}: ${e.message}`); }
    }
    checks.push(`determinism: ${n - bad}/${n} runs identical (SHA-256 of the result, timing keys ${[...VOLATILE_KEYS].join('/')} dropped)`);
    if (bad) fatal = true;
  }

  // seed check: seed+1 changes at least one top-1 position on >= 10 maps; seeds 1-5 on GreatErg hvh
  if (args.seedCheck) {
    const changed = new Set(), mapsSeen = new Set();
    for (const r of rows) {
      if (r.error || !r.positions) continue;
      mapsSeen.add(r.map);
      try {
        const raw = loadRaw(r.map, MAP_CONFIG);
        const run = runOne(E, raw, r.mode, args.seed + 1, exact);
        const ev = run.result.candidates[0];
        const r2 = { positions: {} };
        if (ev) for (const k of rolesOf(ev.set, r.mode)) r2.positions[k] = { x: ev.set[k].x, z: ev.set[k].z };
        if (posKey(r2) !== posKey(r)) changed.add(r.map);
      } catch (e) { checks.push(`seed check ERROR ${r.map} ${r.mode}: ${e.message}`); }
    }
    const need = Math.min(10, mapsSeen.size);
    checks.push(`seed ${args.seed} -> ${args.seed + 1}: top-1 changed on ${changed.size}/${mapsSeen.size} maps ` +
      `(need >= ${need}) ${changed.size >= need ? 'ok' : 'WARN'}; unchanged: ${[...mapsSeen].filter(m => !changed.has(m)).join(', ') || '-'}`);
    if (maps.includes('GreatErg') && args.modes.includes('hvh')) {
      const keys = new Set();
      for (let s = 1; s <= 5; s++) {
        try {
          const run = runOne(E, loadRaw('GreatErg', MAP_CONFIG), 'hvh', s, exact);
          const ev = run.result.candidates[0];
          const r2 = { positions: {} };
          if (ev) for (const k of rolesOf(ev.set, 'hvh')) r2.positions[k] = { x: ev.set[k].x, z: ev.set[k].z };
          keys.add(posKey(r2));
        } catch (e) { checks.push(`GreatErg hvh seed ${s} ERROR: ${e.message}`); }
      }
      checks.push(`GreatErg hvh seeds 1-5: ${keys.size} distinct top-1 sets (need >= 2) ${keys.size >= 2 ? 'ok' : 'WARN'}`);
    }
  }

  // thresholds
  let thrBad = 0;
  for (const r of rows) {
    const t = thresholdIssues(r);
    if (t.length) { thrBad++; checks.push(`threshold ${r.map} ${r.mode}: ${t.join('; ')}`); }
  }
  const gapRows = rows.filter(r => !r.error && r.gap);
  const gapBad = gapRows.filter(r => !gapOk(r));
  checks.push(`gap check (gap B <= max(900, 1.05 x vanilla gap B))${exact ? ' [report-only: exact kit]' : ''}: ${gapRows.length - gapBad.length}/${gapRows.length} ok` +
    (gapBad.length ? `; fails: ${gapBad.map(r => `${r.map} ${r.mode} ${f0(r.gap.Balterium)} > ${f0(gapLimit(r))}`).join(', ')}` : ''));
  checks.push(`thresholds: ${rows.length - thrBad}/${rows.length} rows clean`);

  // spec 12.6 acceptance
  const ok = rows.filter(r => !r.error && r.gateFails);
  const g14 = ok.filter(r => !r.gateFails.some(g => g !== 'G5'));
  checks.push(`G1-G4 on the top-1: ${g14.length}/${rows.length} pass` +
    (g14.length < ok.length ? `; fails: ${ok.filter(r => !g14.includes(r)).map(r => `${r.map} ${r.mode} ${r.gateFails.join(',')}`).join(', ')}` : ''));
  const g5Rows = ok.filter(r => r.mode !== 'hva'), g5Pass = g5Rows.filter(r => !r.gateFails.includes('G5'));
  const g5Miss_ = g5Rows.filter(g5Miss), g5None = g5Rows.filter(r => r.gateFails.includes('G5') && !g5Miss(r));
  checks.push(`G5 on the hvh/hvhva top-1: ${g5Pass.length}/${g5Rows.length} pass; misses (a presented set passes): ` +
    `${g5Miss_.map(r => `${r.map} ${r.mode}`).join(', ') || '-'}; no presented set passes: ${g5None.map(r => `${r.map} ${r.mode}`).join(', ') || '-'} ` +
    `${g5Miss_.length ? 'FAIL' : 'ok'}`);
  const hvhRows = ok.filter(r => r.mode === 'hvh' && expEnds(r));
  const fair = hvhRows.filter(r => expEnds(r).first >= 0.85 && expEnds(r).last >= 0.85);
  const needFair = Math.min(11, hvhRows.length);
  checks.push(`expansion min/max >= 0.85 at k = 1 and k = K on the hvh top-1: ${fair.length}/${hvhRows.length} (need >= ${needFair}) ` +
    `${fair.length >= needFair ? 'ok' : 'WARN'}; below: ${hvhRows.filter(r => !fair.includes(r)).map(r => `${r.map} ${fmtCurves(r.expansion)}`).join(', ') || '-'}`);
  const five = rows.filter(r => !r.error && r.nResults === 5);
  checks.push(`5 results per row: ${five.length}/${rows.length}` +
    (five.length < rows.length ? `; short: ${rows.filter(r => !five.includes(r)).map(r => `${r.map} ${r.mode} ${r.nResults || 0}`).join(', ')}` : ''));
  const msBad = rows.filter(r => !r.error && (typeof r.ms === 'number' ? r.ms : r.searchMs) > 3000);
  checks.push(`ms <= 3000: ${rows.length - msBad.length}/${rows.length}; max ${f0(Math.max(...rows.filter(r => !r.error).map(r => r.ms || 0)))} ms`);
  checks.push(`rows: ${rows.length} (${rows.filter(r => r.error).length} errors, ${rows.filter(r => !r.error && r.nResults === 0 && !r.infeasible).length} without candidates` +
    `, ${rows.filter(r => r.infeasible).length} infeasible)`);
  if (exact) {
    const ex = rows.filter(r => r.exact && r.nResults);
    checks.push(`exact kits (kit ${args.kit ?? 'auto'}, nest ${args.nest ?? 'auto'}): every presented result re-counted from its layout: ` +
      `${ex.filter(r => !r.kitMiss.length).length}/${ex.length} rows exact; infeasible: ${rows.filter(r => r.infeasible).map(r => `${r.map} ${r.mode} ${r.infeasible.reason}`).join(', ') || '-'}`);
  }
  if (args.strict && thrBad) fatal = true;

  // selftests
  if (args.selftest) {
    const { runAll } = require('./gen_selftest.js');
    const st = await runAll({ quiet: true });
    for (const s of st.suites) checks.push(`selftest ${s.name}: ${s.ok ? 'ok' : 'FAIL'} (${s.passed}/${s.total})${s.note ? ' ' + s.note : ''}`);
    if (!st.ok) fatal = true;
  }

  writeReport(args.out, rows, { seed: args.seed, checks, errors });
  console.log('');
  for (const c of checks) console.log(c);
  console.log(`\nreport: ${path.join(args.out, 'gen_report.md')}`);
  process.exitCode = fatal ? 1 : 0;
}

module.exports = { loadMapConfig, loadRaw, defaultSettings, vanillaCounts, loadEngine, missingEngineFiles, canonical, sha256, layoutKits, ROOT, GEN };

if (require.main === module) {
  main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
}
