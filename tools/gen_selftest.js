#!/usr/bin/env node
// Spawn Generator selftest runner (docs/SPAWN_GENERATOR.md, T5).
//
//   node tools/gen_selftest.js [--verbose]
//
// Runs Terrain.selftest(), the exports of js/gen/model_selftest.js (T2) and GenMetrics'
// metrics_selftest (T3). Exit code 1 if any suite fails or cannot be loaded.
//
// model_selftest: run(raws) is called with the GenRaw of all 13 maps (T2 contract).
// Otherwise (generic): if the module exports runAll/run/selftest, only
// that function is called; otherwise every exported function is. Each is called with one
// `env` argument {MAP_CONFIG, maps, loadRaw(map), defaultSettings(raw, mode, seed), Terrain,
// engine()} and may be async. Accepted results: true/false, {ok, results: [{name, ok, detail}]},
// [{name, ok}], or {ok}. A throw is a failure; undefined counts as a pass (noted).
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./gen_harness.js');

const Terrain = require(path.join(H.ROOT, 'js', 'terrain.js'));

function normalize(name, r) {
  if (r === undefined || r === null) return [{ name, ok: true, detail: 'returned nothing' }];
  if (typeof r === 'boolean') return [{ name, ok: r }];
  if (Array.isArray(r)) return r.map((x, i) => ({ name: `${name}/${x && x.name ? x.name : i}`, ok: !!(x && x.ok), detail: x && x.detail }));
  if (typeof r === 'object') {
    if (Array.isArray(r.results)) {
      const sub = r.results.map((x, i) => ({ name: `${name}/${x && x.name ? x.name : i}`, ok: !!(x && x.ok), detail: x && x.detail }));
      if (r.ok === false && sub.every(s => s.ok)) sub.push({ name: `${name}/overall`, ok: false, detail: r });
      return sub.length ? sub : [{ name, ok: r.ok !== false }];
    }
    if ('ok' in r) return [{ name, ok: !!r.ok, detail: r.detail !== undefined ? r.detail : r }];
  }
  return [{ name, ok: true, detail: r }];
}

async function callAll(label, mod, env) {
  const fns = [];
  if (typeof mod === 'function') fns.push([label, mod]);
  else {
    const entry = ['runAll', 'run', 'selftest'].find(k => typeof mod[k] === 'function');
    if (entry) fns.push([`${label}.${entry}`, mod[entry]]);
    else for (const k of Object.keys(mod)) if (typeof mod[k] === 'function') fns.push([`${label}.${k}`, mod[k]]);
  }
  const results = [];
  for (const [name, fn] of fns) {
    const t0 = Date.now();
    try {
      const r = await fn.call(mod, env);
      const xs = normalize(name, r);
      if (xs.length === 1) xs[0].ms = Date.now() - t0;
      results.push(...xs);
    } catch (e) {
      results.push({ name, ok: false, detail: e.stack || String(e), ms: Date.now() - t0 });
    }
  }
  return results;
}

function suite(name, results, note) {
  const passed = results.filter(r => r.ok).length;
  return { name, ok: results.length > 0 && passed === results.length, passed, total: results.length, results, note };
}

async function runAll(opts) {
  opts = opts || {};
  const MAP_CONFIG = H.loadMapConfig();
  let engine = null;
  const env = {
    MAP_CONFIG, maps: Object.keys(MAP_CONFIG), Terrain,
    loadRaw: m => H.loadRaw(m, MAP_CONFIG),
    defaultSettings: H.defaultSettings,
    engine: () => (engine = engine || H.loadEngine()),
  };
  const suites = [];

  // T1
  try {
    const t = Terrain.selftest();
    suites.push(suite('Terrain.selftest', normalize('Terrain', t)));
  } catch (e) { suites.push(suite('Terrain.selftest', [{ name: 'Terrain', ok: false, detail: e.stack }])); }

  // T2
  const modelFile = path.join(H.GEN, 'model_selftest.js');
  if (!fs.existsSync(modelFile)) suites.push(suite('model_selftest (T2)', [], 'js/gen/model_selftest.js missing'));
  else {
    try {
      const M = require(modelFile);
      let results;
      if (typeof M.run === 'function') {
        // T2 contract: GenModelSelftest.run(raws) -> {ok, results, summaries}
        const t0 = Date.now();
        const r = M.run(env.maps.map(env.loadRaw));
        results = normalize('model_selftest.run', r);
        console.log && opts.verbose && console.log(`model_selftest.run: ${Date.now() - t0} ms`);
        if (opts.verbose && r && r.summaries) console.log(JSON.stringify(r.summaries, null, 1));
      } else results = await callAll('model_selftest', M, env);
      suites.push(suite('model_selftest (T2)', results));
    } catch (e) {
      suites.push(suite('model_selftest (T2)', [{ name: 'load', ok: false, detail: e.stack }]));
    }
  }

  // T3
  const metricsFile = path.join(H.GEN, 'metrics.js');
  const separate = path.join(H.GEN, 'metrics_selftest.js');
  try {
    let fn = null, label = null;
    if (fs.existsSync(metricsFile)) {
      const M = require(metricsFile);
      if (M && typeof M.metrics_selftest === 'function') { fn = M.metrics_selftest; label = 'GenMetrics.metrics_selftest'; }
      else if (M && typeof M.selftest === 'function') { fn = M.selftest; label = 'GenMetrics.selftest'; }
      else if (M && M.metrics_selftest && typeof M.metrics_selftest === 'object') { fn = M.metrics_selftest; label = 'GenMetrics.metrics_selftest'; }
    }
    if (!fn && fs.existsSync(separate)) { fn = require(separate); label = 'metrics_selftest.js'; }
    if (!fn) suites.push(suite('metrics_selftest (T3)', [], fs.existsSync(metricsFile)
      ? 'js/gen/metrics.js has no metrics_selftest export' : 'js/gen/metrics.js missing'));
    else suites.push(suite('metrics_selftest (T3)', await callAll(label, fn, env)));
  } catch (e) {
    suites.push(suite('metrics_selftest (T3)', [{ name: 'load', ok: false, detail: e.stack }]));
  }

  const ok = suites.every(s => s.ok);
  if (!opts.quiet) {
    for (const s of suites) {
      console.log(`${s.ok ? 'PASS' : 'FAIL'} ${s.name} ${s.passed}/${s.total}${s.note ? ' - ' + s.note : ''}`);
      for (const r of s.results) {
        if (!r.ok || opts.verbose || /\binfo \(report-only\)/.test(r.name)) {
          const d = r.detail === undefined ? '' : typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail, (k, v) => (ArrayBuffer.isView(v) ? `[${v.constructor.name} ${v.length}]` : v));
          console.log(`   ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ms !== undefined ? ` (${r.ms} ms)` : ''}${d ? ': ' + d.slice(0, 600) : ''}`);
        }
      }
    }
    console.log(ok ? 'selftest: all suites pass' : 'selftest: FAILURES');
  }
  return { ok, suites };
}

module.exports = { runAll };

if (require.main === module) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  runAll({ verbose }).then(r => { process.exitCode = r.ok ? 0 : 1; })
    .catch(e => { console.error(e.stack || e); process.exitCode = 1; });
}
