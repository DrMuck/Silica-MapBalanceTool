// Layout JSON for one generated set (docs/SPAWN_GENERATOR.md section 8.1): the shape of
// Placement.exportLayout() plus description and _meta.generator. UMD, DOM-free.
//
// ctx only needs ctx.map (a {map} stub on the main thread is enough); evaluation is a
// GenResult.candidates entry or a GenMetrics.evaluate result.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rng.js'), root);
  else root.GenLayout = factory(null, root);
}(typeof self !== 'undefined' ? self : this, function (RngMod, root) {
  'use strict';

  const Rng = () => RngMod || root.GenRng;
  const VERSION = '1.0.0';
  const MODES = ['hvh', 'hva', 'hvhva'];
  const DEFAULT_AMOUNTS = { balterium: 40000, biotics: 42000 };
  // alien chain ranges are not generator settings; the tool's slider defaults
  const ALIEN_CHAIN = { node: 150, biocache: 150 };

  function r1(v) { return Math.round(v * 10) / 10; }
  function spawn(c) { return { x: r1(c.x), z: r1(c.z), isSpawn: true, isBiocache: false }; }

  function canon(v) {
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (v instanceof Set) return Array.from(v).sort((a, b) => a - b);
    if (Array.isArray(v)) return v.map(canon);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }

  function settingsHash(settings) {
    const c = canon(settings);
    delete c.seed;
    return Rng().hashString(JSON.stringify(c));
  }

  function round3(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : v; }

  /**
   * build(ctx, settings, evaluation, rank, amounts, extra?) -> layout JSON.
   * amounts = {balterium, biotics} (the tool's global sliders; default 40000 / 42000).
   * extra = {stats, generated} (optional: GenResult.stats, ISO timestamp; default now).
   */
  function build(ctx, settings, evaluation, rank, amounts, extra) {
    const mode = settings.mode;
    if (MODES.indexOf(mode) < 0) throw new Error(`GenLayout.build: unknown mode ${mode}`);
    const set = evaluation.set, am = Object.assign({}, DEFAULT_AMOUNTS, amounts || {});
    const r = settings.radii || {};
    const Rb = r.build || 1000, Rc = r.chain || 2500, Rn = r.nest || 1200;
    const ex = extra || {};
    const mapName = typeof ctx === 'string' ? ctx : (ctx.map || ctx.mapName);

    const human = set.Sol || set.Cent;
    const spawns = { Sol: [], Cent: [], Alien: [], Wildlife: [] };
    if (mode === 'hva') {
      const sp = spawn(human);
      spawns.Sol.push(sp);
      spawns.Cent.push(sp);   // the same entry: Sol[0] === Cent[0]
    } else {
      spawns.Sol.push(spawn(set.Sol));
      spawns.Cent.push(spawn(set.Cent));
    }
    if (mode !== 'hvh') spawns.Alien.push(spawn(set.Alien));

    const removed = Array.from(new Set((evaluation.plan && evaluation.plan.removed) || [])).sort((a, b) => a - b);
    const score = round3(evaluation.score);
    const game_modes = { hvh: false, hva: false, hvhva: false, '4way': false };
    game_modes[mode] = true;

    return {
      map: mapName,
      description: `gen ${mode} seed ${settings.seed} #${rank} score ${typeof score === 'number' ? score.toFixed(2) : score}`,
      spawns,
      footprints: [],
      resources: { balterium_amount: am.balterium, biotics_amount: am.biotics, removed_patches: removed },
      settings: {
        solBuildRadius: Rb, centBuildRadius: Rb, solChainRange: Rc, centChainRange: Rc,
        alienBuildRadius: Rn, alienNodeChainRange: ALIEN_CHAIN.node, alienBiocacheChainRange: ALIEN_CHAIN.biocache,
        wildlifeBuildRadius: Rn, wildlifeNodeChainRange: ALIEN_CHAIN.node, wildlifeBiocacheChainRange: ALIEN_CHAIN.biocache,
      },
      game_modes,
      _meta: {
        generator: {
          version: VERSION,
          generated: ex.generated || new Date().toISOString(),
          seed: settings.seed,
          settingsHash: settingsHash(settings),
          settings: canon(settings),
          rank,
          score,
          gateFails: (evaluation.gateFails || []).slice(),
          terms: Object.fromEntries(Object.entries(evaluation.terms || {}).map(([k, v]) => [k, round3(v)])),
          metrics: evaluation.metrics || {},
          stats: ex.stats || null,
        },
      },
    };
  }

  /**
   * Download file name, sorted next to the hand-made <Map>_<mode>_<n>.json in cfg/Spawns:
   * <Map>_<mode>_gen_<enemy distance>m_<Balterium>bal_<Biotics>bio_s<seed>-<rank>.json,
   * e.g. GreatErg_hvh_gen_1350m_48bal_26bio_s1-1.json. The mod picks layouts by game_modes,
   * the name only shows up as the active config name in the server log.
   */
  function fileName(layout) {
    const g = (layout._meta && layout._meta.generator) || {};
    const s = g.settings || {};
    const mode = MODES.find(m => layout.game_modes && layout.game_modes[m]) || 'gen';
    const parts = [layout.map, mode, 'gen'];
    if (s.enemyDistance) parts.push(`${Math.round(s.enemyDistance / 50) * 50}m`);
    if (s.counts) parts.push(`${s.counts.balterium}bal`, `${s.counts.biotics}bio`);
    parts.push(`s${g.seed !== undefined ? g.seed : 0}-${g.rank || 1}`);
    return `${parts.join('_')}.json`;
  }

  return { VERSION, build, fileName, settingsHash };
}));
