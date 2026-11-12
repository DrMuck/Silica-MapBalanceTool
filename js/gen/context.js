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
      // spec 13.1: exact start kits (null = auto): Balterium within R_b per human, Biotics within R_n
      kitExact: null, nestKitExact: null,
      // spec 12.2: T5 removed, T6 expansion balance added, T2/T3 halved
      weights: { T1: 1, T2: 0.5, T3: 0.5, T4: 1, T6: 1 },
      // spec 12.1/12.8: K expansion HQs, cells within reach * R_c, T6 weights per k
      expansion: { K: 3, reach: 0.85, w: [0.45, 0.35, 0.20] },
      exposure: { overlook: 0.5, highground: 0.3, openness: 0.2, weight: 1.0 },
      exposureCut: 0.75,
      controlModel: 'geodesic', slopeCost: { k: 1.0, s0: 0.25, sMax: 0.7 },
      nestFlatness: 8, edgeMargin: 250,
      topN: 5, distinctness: null, stage1Keep: null, refineRounds: 2,
      // spec 15.4 (revised): count only Balterium with >= minGood usable refinery placements
      // for every required faction (ref_place files); dropped below when off
      placeability: { enabled: true, minGood: PLACE_MIN_GOOD },
    };
    if (overrides) {
      for (const k in overrides) {
        const v = overrides[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object') s[k] = Object.assign({}, s[k], v);
        else if (v !== undefined) s[k] = v;
      }
    }
    // absent (not {enabled: false}) when off, so the settings hash and every output stay the
    // round-5 bytes (same rule as `random`, spec 14.8)
    if (!placeOn(s)) delete s.placeability;
    // spec 15.9: swap is absent when on (the default; round-6 bytes), false when off
    if (s.swap !== false) delete s.swap;
    return s;
  }

  // ── refinery placeability (spec 15.4) ───────────────────────────────────

  const PLACE_FACTIONS = { hva: ['Sol'], hvh: ['Sol', 'Cent'], hvhva: ['Sol', 'Cent'] };
  const PLACE_MIN_GOOD = 10;   // spec 15.4 default eligibility threshold (n_good >= 10)
  // spec 15.8: axis-aligned HQ square per faction (platform max extent + 10 m per side), m
  const HQ_FOOT = { Sol: 131, Cent: 95 };

  /** settings.placeability.enabled (absent / null / false = off). */
  function placeOn(settings) {
    return !!(settings && settings.placeability && settings.placeability.enabled);
  }

  /** Factions whose refinery must fit a patch: hva Sol (the human is Sol), hvh / hvhva both (swap). */
  function placeRequired(mode) {
    return (PLACE_FACTIONS[mode] || PLACE_FACTIONS.hvh).slice();
  }

  /**
   * ctx.place from GenRaw.placeability = {Sol, Cent: ref_place JSON} (spec 15.2), or null when
   * the setting is off. A Balterium patch is ELIGIBLE when n_good >= minGood (settings
   * .placeability.minGood, default 10, spec 15.4) in every required faction's file (a patch the
   * file does not list counts as n_good 0). nGood = {faction: Int32Array per patch k} (-1 for
   * Biotics) feeds T7 (GenMetrics) through placeNGood(). A missing file turns
   * the feature off for the map: {enabled: false, missing: [faction...]} plus a console warning
   * (only when raw.placeability exists at all).
   * Also sets ctx.patches[k].placeable = {Sol, Cent} (true / false, null without that file).
   * -> {enabled, required, missing, mask: Uint8Array per patch k (1 = counts; Biotics always 1)
   *     | null, ineligible: [idx...] sorted}
   */
  function buildPlace(raw, settings, patches) {
    if (!placeOn(settings)) return null;
    const required = placeRequired(settings.mode);
    // spec 15.9: factions per human side (by spawn role). Swap on (default) or hva: every side
    // needs every required faction; swap off: the Sol spawn needs Sol, the Cent spawn Cent.
    const split = settings.swap === false && settings.mode !== 'hva';
    const sideF = split ? { Sol: ['Sol'], Cent: ['Cent'] } : { Sol: required, Cent: required };
    const files = raw.placeability || {};
    const mg = settings.placeability.minGood, minGood = typeof mg === 'number' && mg >= 1 ? mg : PLACE_MIN_GOOD;
    const good = {}, nGood = {}, goods = {}, siteBox = {};
    let hasGoods = false;
    for (const f of ['Sol', 'Cent']) {
      const j = files[f];
      if (!j || !Array.isArray(j.patches)) continue;
      const m = new Map(), cnt = new Map(), lists = new Map();
      for (const q of j.patches) {
        if (!q || typeof q.idx !== 'number') continue;
        m.set(q.idx, (q.n_good || 0) >= minGood);
        cnt.set(q.idx, q.n_good || 0);
        if (Array.isArray(q.good)) lists.set(q.idx, q.good);
      }
      good[f] = m;
      nGood[f] = new Int32Array(patches.length).fill(-1);
      patches.forEach((p, k) => { if (p.type === 'Balterium') nGood[f][k] = cnt.has(p.idx) ? cnt.get(p.idx) : 0; });
      // spec 15.8: GOOD placements per patch [x, z, c, ...] and the site box (no list or no box:
      // n_eff = n_good for this faction)
      const sb = j.site_box;
      siteBox[f] = sb && sb.w > 0 && sb.h > 0 ? { w: sb.w, h: sb.h } : null;
      goods[f] = siteBox[f] && lists.size ? patches.map(p => (p.type === 'Balterium' && lists.has(p.idx) ? lists.get(p.idx) : null)) : null;
      if (goods[f]) hasGoods = true;
    }
    for (const p of patches) {
      if (p.type !== 'Balterium') continue;
      p.placeable = {};
      for (const f of ['Sol', 'Cent']) p.placeable[f] = good[f] ? good[f].get(p.idx) === true : null;
    }
    const missing = required.filter(f => !good[f]);
    if (missing.length) {
      // no warning when the caller does not know the feature (raw.placeability absent, e.g. the
      // synthetic self-test maps); the stats still say missing
      if (raw.placeability && typeof console !== 'undefined') {
        console.warn(`GenContext.build(${raw.mapName}): ref_place file missing for ${missing.join(', ')}; placeability off for this map`);
      }
      return { enabled: false, required, minGood, missing, mask: null, ineligible: [] };
    }
    // mask = eligible for at least one side (n_good); the global ineligible list = patches that
    // fail for every side's faction set (swap on: one set, so unchanged from round 6)
    const mask = new Uint8Array(patches.length), ineligible = [];
    const sideMasks = split ? { Sol: new Uint8Array(patches.length), Cent: new Uint8Array(patches.length) } : null;
    for (let k = 0; k < patches.length; k++) {
      const p = patches[k];
      let ok;
      if (!split) ok = p.type !== 'Balterium' || required.every(f => p.placeable[f] === true);
      else {
        for (const r of ['Sol', 'Cent']) sideMasks[r][k] = p.type !== 'Balterium' || sideF[r].every(f => p.placeable[f] === true) ? 1 : 0;
        ok = !!(sideMasks.Sol[k] || sideMasks.Cent[k]);
      }
      mask[k] = ok ? 1 : 0;
      if (!ok) ineligible.push(p.idx);
    }
    ineligible.sort((a, b) => a - b);
    const Rb = (settings.radii && settings.radii.build) || 1000;
    return { enabled: true, required, minGood, missing, mask, ineligible, nGood,
      goods, siteBox, hasGoods: hasGoods && required.some(f => goods[f]), Rb, neff: new Map(),
      split, sideF, sideMasks: split ? sideMasks : { Sol: mask, Cent: mask } };
  }

  /**
   * THE placeability helper (spec 15.4): Uint8Array per patch k of ctx.patches, 1 = the patch
   * counts for the human kits, V(k) and the human T2 share, 0 = ineligible Balterium; null when
   * the feature is off (or its data is missing), i.e. every patch counts. candidates.js,
   * patches.js, expansion.js and metrics.js read eligibility only through this function.
   */
  function placeMask(ctx) {
    const p = ctx && ctx.place;
    return p && p.enabled && p.mask ? p.mask : null;
  }

  /** Placements of a flat [x, z, c, ...] list whose site rectangle misses the HQ square (spec 15.8). */
  function countFree(g, box, hx, hz, half) {
    const a = box.w / 2 + half, b = box.h / 2 + half;   // rotIndex 0/2: w along x; 1/3 swapped
    let n = 0;
    for (let i = 0; i + 2 < g.length; i += 3) {
      const odd = (g[i + 2] >> 1) & 1, ex = odd ? b : a, ez = odd ? a : b;
      if (Math.abs(g[i] - hx) >= ex || Math.abs(g[i + 1] - hz) >= ez) n++;
    }
    return n;
  }

  /**
   * n_eff_F(patch k, HQ at pos) (spec 15.8): GOOD placements of faction F whose site box does not
   * intersect the HQ_FOOT[F] square centred on pos = {x, z, pd?}; n_good when the patch lies
   * farther than radii.build from pos or the file has no good list / site_box. Cached per
   * (position, F) in ctx.place.neff. Only called while the feature is active.
   */
  function nEff(ctx, k, pos, f) {
    const p = ctx.place, ng = p.nGood[f][k];
    const g = p.goods[f] ? p.goods[f][k] : null;
    if (!g) return ng;
    const P = ctx.patches[k], d = pos.pd ? pos.pd[k] : Math.hypot(P.x - pos.x, P.z - pos.z);
    if (d > p.Rb) return ng;
    const key = pos.x + ',' + pos.z + ',' + f;
    let a = p.neff.get(key);
    if (!a) { a = new Int32Array(ctx.patches.length).fill(-1); p.neff.set(key, a); }
    if (a[k] < 0) a[k] = countFree(g, p.siteBox[f], pos.x, pos.z, HQ_FOOT[f] / 2);
    return a[k];
  }

  /** n_eff of patch k for faction F with the HQ at pos (spec 15.8), or null when the feature is inactive. */
  function placeNEff(ctx, k, pos, f) {
    const p = ctx && ctx.place;
    if (!p || !p.enabled || !p.nGood || !p.nGood[f]) return null;
    return nEff(ctx, k, pos, f);
  }

  /** Side `role` (spawn role 'Sol' | 'Cent') passes for patch k with its HQ at pos (spec 15.9). */
  function sidePass(ctx, k, pos, role) {
    const p = ctx.place;
    if (!p.sideMasks[role][k]) return false;
    if (!p.hasGoods || ctx.patches[k].type !== 'Balterium') return true;
    for (const f of p.sideF[role]) if (nEff(ctx, k, pos, f) < p.minGood) return false;
    return true;
  }

  /**
   * THE eligibility rule (spec 15.4 / 15.8 / 15.9) of patch k as seen by the human structure of
   * spawn role `role` ('Sol' | 'Cent') at pos = {x, z, pd?}: Biotics always; Balterium when
   * n_good >= minGood for every faction of that side (swap on / hva: every required faction;
   * swap off: Sol side Sol, Cent side Cent) and, for a patch within radii.build of pos, n_eff_F >=
   * minGood for those F (the HQ square of F at pos blocks its placements). Without role (a
   * candidate before it has a side): eligible for at least one side. Always true when off.
   */
  function eligibleAt(ctx, k, pos, role) {
    const p = ctx && ctx.place;
    if (!p || !p.enabled || !p.mask) return true;
    if (!p.mask[k]) return false;
    if (p.split && ctx.patches[k].type !== 'Balterium') return true;
    if (p.split) return role && p.sideF[role] ? sidePass(ctx, k, pos, role) : sidePass(ctx, k, pos, 'Sol') || sidePass(ctx, k, pos, 'Cent');
    if (!p.hasGoods || ctx.patches[k].type !== 'Balterium') return true;
    for (const f of p.required) if (nEff(ctx, k, pos, f) < p.minGood) return false;
    return true;
  }

  /** n_good mask of one side's faction set (spec 15.9; swap on = placeMask), null when off. */
  function sideMask(ctx, role) {
    const base = placeMask(ctx);
    if (!base || !role || !ctx.place.split) return base;
    return ctx.place.sideMasks[role] || base;
  }

  /** Factions of side `role` (spec 15.9), [] when the feature is inactive. */
  function sideFactions(ctx, role) {
    const p = ctx && ctx.place;
    return p && p.enabled && p.sideF && p.sideF[role] ? p.sideF[role] : [];
  }

  /**
   * Per-set mask (spec 15.8): placeMask with, for every distinct human structure of the set, its
   * kit patches (within radii.build) cleared where eligibleAt fails. Used where one value per
   * patch is needed for the whole set (fill rank, layer zones, T2). null when the feature is off.
   */
  function setMask(ctx, set) {
    const base = placeMask(ctx);
    if (!base || (!ctx.place.hasGoods && !ctx.place.split)) return base;
    const out = Uint8Array.from(base), P = ctx.patches, Rb = ctx.place.Rb, hs = [];
    for (const r of ['Sol', 'Cent']) if (set && set[r] && !hs.some(h => h.c === set[r])) hs.push({ c: set[r], role: r });
    for (const { c: h, role } of hs) {
      for (let k = 0; k < P.length; k++) {
        if (!out[k] || P[k].type !== 'Balterium') continue;
        const d = h.pd ? h.pd[k] : Math.hypot(P[k].x - h.x, P[k].z - h.z);
        if (d <= Rb && !eligibleAt(ctx, k, h, role)) out[k] = 0;
      }
    }
    return out;
  }

  /**
   * n_good per required faction for T7 (spec 15.4): {F: Int32Array per patch k} when the feature
   * is active, else null (T7 is then absent from the score).
   */
  function placeNGood(ctx) {
    const p = ctx && ctx.place;
    if (!p || !p.enabled || !p.nGood) return null;
    const out = {};
    for (const f of p.required) out[f] = p.nGood[f];
    return out;
  }

  /** result.stats.placeability (spec 15.4) for ctx, or null when the setting is off. */
  function placeStats(ctx) {
    const p = ctx && ctx.place;
    if (!p) return null;
    const out = { enabled: p.enabled, minGood: p.minGood, required: p.required.slice(), ineligible: p.ineligible.length,
      missing: p.missing.slice(), ineligibleIdx: p.ineligible.slice() };
    if (p.split) out.sides = { Sol: p.sideF.Sol.slice(), Cent: p.sideF.Cent.slice() };   // spec 15.9, swap off only
    return out;
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
    // spec 15.4: eligibility per patch (null = setting off; nothing else changes then)
    const place = buildPlace(raw, s, patches);
    if (place) ctx.place = place;
    // spec 17: base sites (null = setting off; nothing else changes then)
    const sites = buildSites(raw, s, scan);
    if (sites) ctx.sites = sites;
    G().build(ctx, settings);
    return ctx;
  }

  // ── base sites (spec 17, docs/SITE_SCAN.md) ──────────────────────────────

  // js/sites.js: required in Node, the global Sites in the browser / worker (looked up at call time)
  function S() {
    if (root && root.Sites) return root.Sites;
    /* global require */
    return typeof require === 'function' ? require('../sites.js') : null;
  }

  // Structures that can stand at a human start: both HQs in every mode (swap on: either HQ;
  // hva: one position for both; swap off: the stricter rule keeps the start valid either way)
  const SITE_STRUCTS = { human: ['Sol', 'Cent'], alien: ['Alien'] };

  /** settings.sites.enabled (absent / null / false = off). */
  function sitesOn(settings) {
    return !!(settings && settings.sites && settings.sites.enabled);
  }

  /**
   * ctx.sites from GenRaw.sites (a Sites SiteData of the map) when settings.sites is on:
   * {enabled, sd, structs, mask: {human, alien}: Uint8Array per scan cell (1 = some yaw valid for
   * every structure of the role), minOpen: {human, alien}, open: Map cache}. Missing data turns the
   * feature off for the map ({enabled: false, missing: true} plus a console warning).
   */
  function buildSites(raw, settings, scan) {
    if (!sitesOn(settings)) return null;
    const sd = raw.sites, Sm = S();
    const g = sd && sd.meta && sd.meta.grid;
    if (!sd || !Sm || !g || g.grid_w !== scan.w || g.grid_h !== scan.h || g.scan_min_x !== scan.minX || g.scan_max_z !== scan.maxZ || g.step !== scan.step) {
      if (typeof console !== 'undefined') console.warn(`GenContext.build(${raw.mapName}): no base site data on the scan grid; base sites off for this map`);
      return { enabled: false, missing: true };
    }
    const mask = { human: Sm.anyValidMask(sd, SITE_STRUCTS.human), alien: Sm.anyValidMask(sd, SITE_STRUCTS.alien) };
    return {
      enabled: true, sd, structs: SITE_STRUCTS, mask,
      minOpen: { human: Sm.lowOpenLimit('Sol'), alien: Sm.lowOpenLimit('Alien') },
      open: new Map(), lowOpen: { human: 0, alien: 0 },
    };
  }

  function sitesActive(ctx) { return !!(ctx && ctx.sites && ctx.sites.enabled); }

  /** Base site rule at scan cell (px, py) for a role: some yaw valid for its structures (true when off). */
  function siteValid(ctx, role, px, py) {
    if (!sitesActive(ctx)) return true;
    return ctx.sites.mask[role === 'alien' ? 'alien' : 'human'][py * ctx.scan.w + px] === 1;
  }

  /** Open ground around a start (SITE_SCAN.md 7): open_reach >= 0.50 (HQ) / 0.25 (Nest); cached; true when off. */
  function siteOpenOk(ctx, role, px, py) {
    if (!sitesActive(ctx)) return true;
    const st = ctx.sites, key = (role === 'alien' ? 'a' : 'h') + (py * ctx.scan.w + px);
    let ok = st.open.get(key);
    if (ok === undefined) {
      const x = ctx.scan.minX + px * ctx.scan.step, z = ctx.scan.maxZ - py * ctx.scan.step;
      const o = S().openness(st.sd, role === 'alien' ? 'Alien' : 'Sol', x, z);
      ok = !!o && o.reach >= st.minOpen[role === 'alien' ? 'alien' : 'human'];
      st.open.set(key, ok);
    }
    return ok;
  }

  /** "rot" for a start at scan cell (px, py): the best yaw valid for every structure of the role
   *  (SITE_SCAN.md 8: most margin, then closest to the start point yaw), undefined when off / none. */
  function siteRot(ctx, role, px, py) {
    if (!sitesActive(ctx)) return undefined;
    const st = ctx.sites, Sm = S(), structs = st.structs[role === 'alien' ? 'alien' : 'human'];
    const x = ctx.scan.minX + px * ctx.scan.step, z = ctx.scan.maxZ - py * ctx.scan.step;
    const ys = Sm.bestYaws(st.sd, structs, px, py, Sm.todayYaw(st.sd, structs[0], x, z).yaw);
    return ys.length ? ys[0].rot : undefined;
  }

  return { build, defaultSettings, resourceList, placeOn, placeRequired, placeMask, placeNGood, placeStats, PLACE_MIN_GOOD,
    HQ_FOOT, eligibleAt, setMask, placeNEff, countFree, sideMask, sideFactions,
    sitesOn, sitesActive, siteValid, siteOpenOk, siteRot };
}));
