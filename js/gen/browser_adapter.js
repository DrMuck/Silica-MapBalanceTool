// Spawn generator: browser glue between the tool (Layers, Terrain, MAP_CONFIG) and the
// DOM-free generator modules (docs/SPAWN_GENERATOR.md section 8.2).
//
// - buildRaw(mapName)            -> Promise<GenRaw>      (waits for the four mask canvases)
// - makeSettings(values, cfg)    -> GenSettings          (complete object, spec defaults filled in)
// - start(raw, settings, onProgress) -> { promise, cancel }   Web Worker job (js/gen/worker.js)
// - context(raw, settings)       -> GenContext            (main thread; preview fallback when a
//                                                          result carries no owner array)
// - fields(ctx, settings, set, cache) -> Fields
// - layout(mapName, settings, evaluation, rank, amounts, extra) -> layout JSON (GenLayout.build)
//
// Browser globals (Layers, Terrain, MAP_CONFIG, Worker, GenContext, GenGrid, GenLayout) are
// looked up when a function runs, so the file also loads in Node (where it does nothing useful).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.GenAdapter = factory(root);
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const WORKER_URL = 'js/gen/worker.js';
  const MASK_WAIT_MS = 15000;
  const MASK_POLL_MS = 100;

  /** Spec defaults (section 8.2 GenSettings); exposure weights match Terrain.EXPOSURE_DEFAULTS. */
  function defaultSettings() {
    return {
      mode: 'hvh', seed: 1,
      radii: { build: 1000, chain: 2500, nest: 1200 },
      enemyDistance: 2700,
      counts: { balterium: 0, biotics: 0 },
      minKit: 3, minKitAlien: 4, kitCap: null,
      weights: { T1: 1, T2: 1, T3: 1, T4: 1, T5: 1 },
      exposure: { overlook: 0.5, highground: 0.3, openness: 0.2, weight: 1.0 },
      exposureCut: 0.75,
      controlModel: 'geodesic', slopeCost: { k: 1.0, s0: 0.25, sMax: 0.7 },
      nestFlatness: 8, edgeMargin: 250,
      topN: 5, distinctness: null, stage1Keep: null, refineRounds: 2,
    };
  }

  /** Default enemy start distance for a map: clamp(0.9 * extent, 1300, 2700), on a 50 m step. */
  function defaultDistance(cfg) {
    const d = Math.round((0.9 * cfg.extent) / 50) * 50;
    return Math.max(1300, Math.min(2700, d));
  }

  /** Vanilla patch counts per type, clipped to the map extent like Layers.loadResources. */
  function vanillaCounts(resourceJson) {
    const out = { Balterium: 0, Biotics: 0 };
    if (!resourceJson || !resourceJson.resources) return out;
    const extent = resourceJson.extent || Infinity;
    for (const r of resourceJson.resources) {
      if (r.active === false || Math.abs(r.x) > extent || Math.abs(r.z) > extent) continue;
      if (r.type === 'Balterium') out.Balterium++;
      else if (r.type === 'Biotics') out.Biotics++;
    }
    return out;
  }

  /**
   * values: the UI's plain values {mode, seed, enemyDistance, radii, counts, exposureWeight,
   * weights, exposureCut, controlModel, topN}; anything missing keeps the spec default.
   */
  function makeSettings(values) {
    const s = defaultSettings();
    const v = values || {};
    if (v.mode) s.mode = v.mode;
    if (Number.isFinite(v.seed)) s.seed = v.seed;
    if (Number.isFinite(v.enemyDistance)) s.enemyDistance = v.enemyDistance;
    if (v.radii) Object.assign(s.radii, v.radii);
    if (v.counts) Object.assign(s.counts, v.counts);
    if (Number.isFinite(v.exposureWeight)) s.exposure.weight = v.exposureWeight;
    if (v.weights) Object.assign(s.weights, v.weights);
    if (Number.isFinite(v.exposureCut)) s.exposureCut = v.exposureCut;
    if (v.controlModel) s.controlModel = v.controlModel;
    if (Number.isFinite(v.topN)) s.topN = v.topN;
    return s;
  }

  // The tool's own modules are top-level `const`s (global lexical bindings, not window
  // properties), so they are reached by bare name; the gen modules and Terrain are on root.
  /* global MAP_CONFIG, Layers */
  function mapConfig() { return typeof MAP_CONFIG !== 'undefined' ? MAP_CONFIG : root.MAP_CONFIG; }
  function layers() { return typeof Layers !== 'undefined' ? Layers : root.Layers; }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForMask(type, faction, assetMap) {
    const t0 = Date.now();
    for (;;) {
      const arr = layers().getMaskArray(type, faction, assetMap);
      if (arr) return arr;
      if (Date.now() - t0 > MASK_WAIT_MS) {
        throw new Error(`mask ${type}_${faction}_${assetMap}.png not loaded`);
      }
      await sleep(MASK_POLL_MS);
    }
  }

  /** GenRaw for the map currently loaded in the tool (resources come from Layers if they match). */
  async function buildRaw(mapName) {
    const cfg = mapConfig()[mapName];
    if (!cfg) throw new Error(`unknown map ${mapName}`);
    const assetMap = cfg.base_map || mapName;

    let resources = layers().getResourceData();
    if (!resources || resources.map !== mapName) {
      const resp = await fetch(`data/resources/${mapName}.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for data/resources/${mapName}.json`);
      resources = await resp.json();
    }

    const [hqSol, hqCent, refSol, refCent, terrain] = await Promise.all([
      waitForMask('hq', 'Sol', assetMap),
      waitForMask('hq', 'Cent', assetMap),
      waitForMask('ref', 'Sol', assetMap),
      waitForMask('ref', 'Cent', assetMap),
      root.Terrain.load(mapName),
    ]);

    return {
      mapName, cfg, resources,
      masks: { hqSol, hqCent, refSol, refCent },
      heights: terrain.heights, heightsMeta: terrain.meta,
    };
  }

  /**
   * Runs one job in a fresh worker. onProgress(frac, text). The promise resolves with the
   * GenResult, rejects with Error (worker error) or {cancelled: true} after cancel().
   */
  function start(raw, settings, onProgress) {
    const worker = new root.Worker(WORKER_URL);
    let settled = false;
    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn(value);
    }

    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'progress') {
        if (onProgress && !settled) onProgress(msg.frac, msg.text);
      } else if (msg.type === 'done') {
        finish(resolveFn, msg.result);
      } else if (msg.type === 'error') {
        finish(rejectFn, new Error(msg.message || 'generator error'));
      }
    };
    worker.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      finish(rejectFn, new Error((e && e.message) || 'worker failed to start'));
    };
    // Masks/heights are cached by Layers/Terrain: copy (structured clone), never transfer.
    worker.postMessage({ type: 'run', raw, settings });

    function cancel() {
      if (settled) return;
      try { worker.postMessage({ type: 'cancel' }); } catch (_) { /* already gone */ }
      finish(rejectFn, { cancelled: true });
    }

    return { promise, cancel };
  }

  function context(raw, settings) {
    return root.GenContext.build(raw, settings);
  }

  function fields(ctx, settings, set, cache) {
    return root.GenGrid.fields(ctx, settings, set, cache || new Map());
  }

  function layout(mapName, settings, evaluation, rank, amounts, extra) {
    return root.GenLayout.build({ map: mapName }, settings, evaluation, rank, amounts, extra);
  }

  return {
    WORKER_URL, defaultSettings, defaultDistance, vanillaCounts, makeSettings,
    buildRaw, start, context, fields, layout,
  };
}));
