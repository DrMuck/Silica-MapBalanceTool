// GenContext: per-map model data for the spawn generator (spec 8.2). UMD, DOM-free.
// Depends on Terrain (js/terrain.js) and GenGrid (js/gen/grid.js). In the browser both are
// looked up on the global at call time, so the script order rng, context, grid works.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../terrain.js'), require('./grid.js'));
  else root.GenContext = factory(null, null, root);
}(typeof self !== 'undefined' ? self : this, function (TerrainMod, GenGridMod, root) {
  'use strict';

  const T = () => TerrainMod || root.Terrain;
  const G = () => GenGridMod || root.GenGrid;

  /** Spec 8.2 GenSettings with the spec defaults for one map; overrides are merged one level deep. */
  function defaultSettings(raw, overrides) {
    const cfg = raw.cfg, ext = cfg.extent;
    const res = resourceList(raw.resources);
    let nB = 0, nO = 0;
    for (const r of res) { if (r.type === 'Balterium') nB++; else if (r.type === 'Biotics') nO++; }
    const s = {
      mode: 'hvh', seed: 1,
      radii: { build: 1000, chain: 2500, nest: 1200 },
      enemyDistance: Math.min(2700, Math.max(1300, 0.9 * ext)),
      counts: { balterium: Math.round(0.75 * nB), biotics: Math.round(0.75 * nO) },
      minKit: 3, minKitAlien: 4, kitCap: null,
      weights: { T1: 1, T2: 1, T3: 1, T4: 1, T5: 1 },
      exposure: { overlook: 0.5, highground: 0.3, openness: 0.2, weight: 1.0 },
      exposureCut: 0.75,
      controlModel: 'geodesic', slopeCost: { k: 1.0, s0: 0.25, sMax: 0.7 },
      nestFlatness: 8, edgeMargin: 250,
      topN: 5, distinctness: null, stage1Keep: null, refineRounds: 2,
    };
    if (overrides) {
      for (const k in overrides) {
        const v = overrides[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object') s[k] = Object.assign({}, s[k], v);
        else if (v !== undefined) s[k] = v;
      }
    }
    return s;
  }

  function resourceList(resources) {
    if (!resources) return [];
    if (Array.isArray(resources)) return resources;
    return resources.resources || [];
  }

  /**
   * GenRaw -> GenContext. Extras beyond spec 8.2: cfg, masks.hqBoth (hqSol & hqCent),
   * masks.union (hq|ref of both factions), vanilla {Balterium, Biotics} counts, cache (Map used
   * by GenCandidates for exposure/blocked masks), stats (candidate list statistics).
   */
  function build(raw, settings) {
    const cfg = raw.cfg;
    if (!cfg) throw new Error('GenContext.build: raw.cfg missing');
    const scan = {
      minX: cfg.scan_min_x !== undefined ? cfg.scan_min_x : -cfg.extent,
      maxZ: cfg.scan_max_z !== undefined ? cfg.scan_max_z : cfg.extent,
      step: cfg.scan_step || 15, w: cfg.grid_w, h: cfg.grid_h,
    };
    const len = scan.w * scan.h;
    const rm = raw.masks || {};
    const masks = {};
    for (const k of ['hqSol', 'hqCent', 'refSol', 'refCent']) {
      const a = rm[k];
      if (!a || a.length !== len) throw new Error(`GenContext.build(${raw.mapName}): mask ${k} missing or not ${scan.w}x${scan.h}`);
      masks[k] = a;
    }
    if (rm.hqAlien && rm.hqAlien.length === len) masks.hqAlien = rm.hqAlien;
    const hqBoth = new Uint8Array(len), union = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      hqBoth[i] = masks.hqSol[i] && masks.hqCent[i] ? 1 : 0;
      union[i] = masks.hqSol[i] || masks.hqCent[i] || masks.refSol[i] || masks.refCent[i] ? 1 : 0;
    }
    masks.hqBoth = hqBoth;
    masks.union = union;

    let heights = raw.heights || null;
    const hm = raw.heightsMeta;
    if (heights && (heights.length !== len || (hm && (hm.grid_w !== scan.w || hm.grid_h !== scan.h)))) {
      if (typeof console !== 'undefined') console.warn(`GenContext.build(${raw.mapName}): heights grid does not match the scan grid, ignored`);
      heights = null;
    }

    const patches = resourceList(raw.resources)
      .filter(r => r.active !== false && (r.type === 'Balterium' || r.type === 'Biotics'))
      .map(r => ({
        idx: r.idx, type: r.type, x: r.x, z: r.z, y: r.y,
        amount: r.resources_max !== undefined ? r.resources_max : r.resources_current,
        w: r.world_w, h: r.world_h,
      }));
    const vanilla = { Balterium: 0, Biotics: 0 };
    for (const p of patches) vanilla[p.type]++;

    const s = settings || {};
    let nestMask;
    if (masks.hqAlien) nestMask = masks.hqAlien;
    else {
      const hForNest = heights || new Float32Array(len);
      nestMask = T().nestMask(hForNest, scan.w, scan.h, scan.step, union, {
        scan, extent: cfg.extent, patches,
        flatness: s.nestFlatness !== undefined ? s.nestFlatness : 8,
        edgeMargin: s.edgeMargin !== undefined ? s.edgeMargin : 250,
      });
    }

    const ctx = {
      map: raw.mapName, baseMap: cfg.base_map || raw.mapName, extent: cfg.extent, scan,
      masks, heights, nestMask, patches, ctrl: null,
      cfg, vanilla, cache: new Map(), stats: {},
    };
    G().build(ctx, settings);
    return ctx;
  }

  return { build, defaultSettings, resourceList };
}));
