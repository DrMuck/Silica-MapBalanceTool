#!/usr/bin/env node
// Spawn Generator harness (docs/SPAWN_GENERATOR.md, T5).
//
//   node tools/gen_harness.js [--maps A,B] [--modes hvh,hva,hvhva] [--seed N] [--out dir]
//                             [--no-determinism] [--no-seed-check] [--no-selftest] [--strict]
//
// Builds GenRaw from disk (pngjs for masks and heights, Terrain.decode for heights), runs
// GenContext.build + GenSearch.run for every map x mode, writes <out>/gen_report.md,
// <out>/gen_report.json and <out>/layouts/<GenLayout.fileName> (top 3).
// Exit code 1 if a run throws, a run has no candidate, the determinism check fails or a
// selftest fails; --strict also fails on threshold violations (timing, gates, layout checks).
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
    weights: { T1: 1, T2: 1, T3: 1, T4: 1, T5: 1 },
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

function runOne(E, raw, mode, seed) {
  // the engine's defaults when it has them (same values as defaultSettings above)
  const settings = typeof E.GenContext.defaultSettings === 'function'
    ? E.GenContext.defaultSettings(raw, { mode, seed }) : defaultSettings(raw, mode, seed);
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
  if (row.gateFails && row.gateFails.length && !EXPECTED_GATE_FAILS.has(`${row.map}|${row.mode}`)) {
    out.push(`top-1 fails ${row.gateFails.join(',')}`);
  }
  if (!gapOk(row)) out.push(`gap B ${Math.round(row.gap.Balterium)} > ${Math.round(gapLimit(row))}`);
  for (const l of row.layouts || []) if (l.issues.length) out.push(`layout #${l.rank}: ${l.issues.join('; ')}`);
  return out;
}

function writeReport(outDir, rows, extra) {
  const L = [];
  L.push('# Spawn Generator harness report', '');
  L.push(`Generated ${new Date().toISOString()} | Node ${process.version} | seed ${extra.seed} | ` +
    `${rows.length} runs | amounts ${AMOUNTS.balterium}/${AMOUNTS.biotics}`, '');
  L.push('Times: `ms` = GenResult.stats.ms, `ctx` = GenContext.build wall time, `run` = GenSearch.run wall time. ' +
    'Limit: 3000 ms on every map. Gate fails are expected only for BlackIsle and Citadel hvhva. ' +
    'Gap check: gap B <= max(900 m, 1.05 x vanilla gap B).', '');

  L.push('## Summary', '');
  L.push('| map | mode | ms | ctx | run | stages cand/s1/s2/ref | cand h/a | s1/s2 sets | results | gate fails | score | T1 | T2 | T3 | T4 | T5 | status |');
  L.push('|---|---|--:|--:|--:|---|---|---|--:|---|--:|--:|--:|--:|--:|--:|---|');
  for (const r of rows) {
    if (r.error) {
      L.push(`| ${r.map} | ${r.mode} | - | - | - | - | - | - | - | - | - | - | - | - | - | - | ERROR ${cell(r.error)} |`);
      continue;
    }
    const c = r.candidates || {};
    const t = r.terms || {};
    const thr = thresholdIssues(r);
    const status = r.nResults === 0 ? 'NO CANDIDATE' : thr.length ? `WARN ${cell(thr.join('; '))}` : 'ok';
    const tm = r.timing || {};
    const stages = r.timing ? `${f0(tm.candidates)}/${f0(tm.stage1)}/${f0(tm.stage2)}/${f0(tm.refine)}` : '-';
    L.push(`| ${r.map} | ${r.mode} | ${f0(r.ms)} | ${f0(r.buildMs)} | ${f0(r.searchMs)} | ${stages} | ${f0(c.human)}/${f0(c.alien)} | ` +
      `${f0(r.stage1Sets)}/${f0(r.stage2Sets)} | ${r.nResults} | ${r.gateFails ? (r.gateFails.join(',') || '-') : 'n/a'} | ${f2(r.score)} | ` +
      `${f2(t.T1)} | ${f2(t.T2)} | ${f2(t.T3)} | ${f2(t.T4)} | ${f2(t.T5)} | ${status} |`);
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
    determinism: true, seedCheck: true, selftest: true, strict: false };
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
    else if (k === '-h' || k === '--help') {
      console.log('node tools/gen_harness.js [--maps A,B] [--modes hvh,hva,hvhva] [--seed N] [--out dir] ' +
        '[--no-determinism] [--no-seed-check] [--no-selftest] [--strict]');
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

async function main() {
  const args = parseArgs(process.argv);
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
        const run = runOne(E, raw, mode, args.seed);
        row = summarize(raw, mode, args.seed, run, E);
        row._hash = sha256(canonical(run.result));
        for (const l of row.layouts) {
          fs.writeFileSync(path.join(args.out, 'layouts', E.GenLayout.fileName(l.layout)),
            JSON.stringify(l.layout, null, 1));
        }
        if (row.nResults === 0) fatal = true;
        console.log(`${f0(row.ms)} ms  score ${f2(row.score)}  fails [${(row.gateFails || []).join(',')}]` +
          (row.nResults === 0 ? '  NO CANDIDATE' : ''));
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
        const run = runOne(E, loadRaw(r.map, MAP_CONFIG), r.mode, args.seed);
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
        const run = runOne(E, raw, r.mode, args.seed + 1);
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
          const run = runOne(E, loadRaw('GreatErg', MAP_CONFIG), 'hvh', s);
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
  checks.push(`gap check (gap B <= max(900, 1.05 x vanilla gap B)): ${gapRows.length - gapBad.length}/${gapRows.length} ok` +
    (gapBad.length ? `; fails: ${gapBad.map(r => `${r.map} ${r.mode} ${f0(r.gap.Balterium)} > ${f0(gapLimit(r))}`).join(', ')}` : ''));
  checks.push(`thresholds: ${rows.length - thrBad}/${rows.length} rows clean`);
  checks.push(`rows: ${rows.length} (${rows.filter(r => r.error).length} errors, ${rows.filter(r => !r.error && r.nResults === 0).length} without candidates)`);
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

module.exports = { loadMapConfig, loadRaw, defaultSettings, vanillaCounts, loadEngine, missingEngineFiles, canonical, sha256, ROOT, GEN };

if (require.main === module) {
  main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
}
