/**
 * generator_ui.js - Spawn Generator sidebar section: settings, run/cancel, results,
 * preview layer (markers, territory overlay, patch tints), Apply and Download.
 * Spec: docs/SPAWN_GENERATOR.md section 7. Data glue lives in js/gen/browser_adapter.js.
 */

const GeneratorUI = (() => {
  const ROLES = ['Sol', 'Cent', 'Alien'];
  const ROLE_RGB = { Sol: [50, 140, 255], Cent: [235, 70, 70], Alien: [80, 200, 50] };
  const ROLE_CSS = { Sol: 'sol', Cent: 'cent', Alien: 'alien' };
  const DEFAULT_GATES = [
    { id: 'G1', label: 'placement' }, { id: 'G2', label: 'separation' },
    { id: 'G3', label: 'starting kit' }, { id: 'G4', label: 'budget' }, { id: 'G5', label: 'expansion' },
  ];
  // fallbacks only; the live lists come from GenMetrics.registry
  const DEFAULT_TERMS = [
    { id: 'T1', label: 'separation', weight: 1 }, { id: 'T2', label: 'resources over control', weight: 0.5 },
    { id: 'T3', label: 'control balance', weight: 0.5 }, { id: 'T4', label: 'exposure', weight: 1 },
    { id: 'T6', label: 'expansion balance', weight: 1 },
  ];
  const PRESENTATION_BAR = (typeof GenMetrics !== 'undefined' && GenMetrics.PRESENTATION_BAR) || 3.0;
  const BAR_WARNING = `above ${PRESENTATION_BAR.toFixed(1)}: geometry limits fairness on this map`;
  const TERRITORY_OPACITY = 0.35;

  let map = null;
  let job = null;            // { token, cancel, mapName }
  let runToken = 0;
  let run = null;            // { mapName, raw, settings, result, ctx, ctxError, fieldCache }
  let countsMap = null;      // map the patch-count inputs were last reset for
  let vanilla = { Balterium: 0, Biotics: 0 };
  let previewGroup = null;
  let territoryOverlay = null;
  let previewIdx = -1;

  const $ = (id) => document.getElementById(id);

  function registryEntries(kind) {
    const reg = (typeof GenMetrics !== 'undefined' && Array.isArray(GenMetrics.registry)) ? GenMetrics.registry : null;
    if (!reg) return kind === 'hard' ? DEFAULT_GATES : DEFAULT_TERMS;
    const list = reg.filter(e => e.kind === kind);
    return list.length ? list : (kind === 'hard' ? DEFAULT_GATES : DEFAULT_TERMS);
  }

  /** Registry labels carry the id ("T1 separation"); show the text part only. */
  function labelOf(e) {
    const l = String(e.label || '');
    return l.startsWith(e.id + ' ') ? l.slice(e.id.length + 1) : l;
  }

  // ── init / wiring ──────────────────────────────────────────────────────

  function init(leafletMap) {
    map = leafletMap;
    // Preview patch tints must sit above the resource icons (markerPane 600) to dim them;
    // the preview structures above those.
    map.createPane('genPatchPane').style.zIndex = 610;
    map.getPane('genPatchPane').style.pointerEvents = 'none';
    map.createPane('genMarkerPane').style.zIndex = 620;

    const weightsBox = $('gen-adv-weights');
    for (const t of registryEntries('soft')) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.title = labelOf(t) || t.id;
      row.innerHTML = `<span>Weight ${t.id} <span class="gen-of">${labelOf(t)}</span></span>` +
        `<input type="number" class="gen-num gen-adv-weight" id="gen-adv-w-${t.id}" data-term="${t.id}" ` +
        `value="${t.weight ?? 1}" min="0" max="10" step="0.1">`;
      weightsBox.appendChild(row);
    }

    $('gen-reseed').addEventListener('click', () => {
      $('gen-seed').value = 1 + Math.floor(Math.random() * 2147483646);
    });
    const expSlider = $('gen-w-exposure');
    expSlider.addEventListener('input', () => {
      $('val-gen-w-exposure').textContent = parseFloat(expSlider.value).toFixed(1);
    });
    // spec 14.1: the random search varies d* over the band, so the single distance is unused
    $('gen-random').addEventListener('change', () => {
      const on = $('gen-random').checked;
      $('gen-dist').disabled = on;
      document.querySelectorAll('.gen-random-opt').forEach(el => { el.style.display = on ? '' : 'none'; });
    });
    $('gen-run').addEventListener('click', () => { startRun(); });
    $('gen-cancel').addEventListener('click', () => { cancelRun('cancelled'); });
    $('layer-territory').addEventListener('change', (e) => {
      if (!territoryOverlay) return;
      if (e.target.checked) territoryOverlay.addTo(map);
      else map.removeLayer(territoryOverlay);
    });
    // the resource lines use the global amount sliders (the amounts a downloaded layout carries)
    for (const id of ['setting-balt-amount', 'setting-bio-amount']) {
      const el = $(id);
      if (el) el.addEventListener('input', updateResourceLines);
    }
  }

  /** Called by App.loadMap before anything is cleared. */
  function onMapChange(mapName) {
    clearPreview();
    if (run && run.mapName !== mapName) {
      run = null;
      $('gen-results').innerHTML = '';
      setStatus('');
      showKitRange(null);
    }
    if (job) cancelRun(`cancelled (map ${mapName === job.mapName ? 'reload' : 'switch'})`);
  }

  /** Called by App.loadMap once the resource JSON is loaded. */
  function onMapLoaded(mapName) {
    vanilla = GenAdapter.vanillaCounts(Layers.getResourceData());
    $('gen-n-balt-of').textContent = `of ${vanilla.Balterium} vanilla`;
    $('gen-n-bio-of').textContent = `of ${vanilla.Biotics} vanilla`;
    $('gen-n-balt').max = vanilla.Balterium;
    $('gen-n-bio').max = vanilla.Biotics;
    if (mapName !== countsMap) {
      countsMap = mapName;
      $('gen-n-balt').value = Math.round(0.75 * vanilla.Balterium);
      $('gen-n-bio').value = Math.round(0.75 * vanilla.Biotics);
      const d0 = GenAdapter.defaultDistance(MAP_CONFIG[mapName]);
      $('gen-dist').value = d0;
      const band = GenRandom.defaultBand(d0);
      $('gen-random-dlo').value = band[0];
      $('gen-random-dhi').value = band[1];
    }
  }

  // ── settings ───────────────────────────────────────────────────────────

  function num(id, fallback) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  }

  /** Exact-kit input (spec 13.7): empty = null (auto); anything else goes to the engine as typed. */
  function exactKit(id) {
    const el = $(id);
    const t = el ? String(el.value).trim() : '';
    if (!t) return null;
    const v = Number(t);
    return Number.isNaN(v) ? NaN : v;
  }

  /** "max on this map: X" next to the exact-kit inputs, from GenResult.stats.kitRange. */
  function showKitRange(range) {
    const r = range || {};
    $('gen-adv-kit-max').textContent = Number.isFinite(r.humanMax) ? `max on this map: ${r.humanMax}` : '';
    $('gen-adv-nestkit-max').textContent = Number.isFinite(r.alienMax) ? `max on this map: ${r.alienMax}` : '';
  }

  function readSettings() {
    const modeEl = document.querySelector('input[name="gen-mode"]:checked');
    const weights = {};
    document.querySelectorAll('.gen-adv-weight').forEach(el => {
      const v = parseFloat(el.value);
      if (Number.isFinite(v)) weights[el.dataset.term] = v;
    });
    return GenAdapter.makeSettings({
      mode: modeEl ? modeEl.value : 'hvh',
      seed: Math.trunc(num('gen-seed', 1)),
      enemyDistance: Math.max(800, Math.min(5000, num('gen-dist', 2700))),
      radii: { build: num('gen-r-build', 1000), chain: num('gen-r-chain', 2500), nest: num('gen-r-nest', 1200) },
      counts: {
        balterium: Math.max(0, Math.min(vanilla.Balterium, Math.round(num('gen-n-balt', 0)))),
        biotics: Math.max(0, Math.min(vanilla.Biotics, Math.round(num('gen-n-bio', 0)))),
      },
      exposureWeight: num('gen-w-exposure', 1),
      weights,
      exposureCut: Math.max(0.01, Math.min(1, num('gen-adv-expcut', 75) / 100)),
      controlModel: $('gen-adv-control').value,
      topN: Math.max(1, Math.round(num('gen-adv-topn', 5))),
      kitExact: exactKit('gen-adv-kit'),
      nestKitExact: exactKit('gen-adv-nestkit'),
      placeability: $('gen-placeable') ? $('gen-placeable').checked : true,   // spec 15.4
      minGood: Math.max(1, Math.round(num('gen-adv-mingood', 10))),
      swap: $('gen-swap') ? $('gen-swap').checked : true,   // spec 15.9 (Apply sets swap-spawns via UI.importLayout)
      sites: $('gen-sites') ? $('gen-sites').checked : true,   // spec 17: valid base sites + rot, open ground
      random: $('gen-random').checked ? {
        runs: Math.max(2, Math.min(60, Math.round(num('gen-random-runs', 12)))),
        band: [num('gen-random-dlo', 1600), num('gen-random-dhi', 3800)],
      } : null,
    });
  }

  // ── run / cancel ───────────────────────────────────────────────────────

  function setStatus(text, isError) {
    const el = $('gen-status');
    el.textContent = text;
    el.classList.toggle('gen-error', !!isError);
  }

  function setRunning(on) {
    $('gen-run').disabled = on;
    $('gen-cancel').disabled = !on;
    if (!on) $('gen-progress').value = 0;
  }

  async function startRun() {
    if (job) return;
    const mapName = App.getCurrentMap();
    if (!mapName) return;
    const settings = readSettings();
    const token = ++runToken;
    job = { token, cancel: null, mapName };
    setRunning(true);
    clearPreview();
    setStatus('loading map data...');
    $('gen-progress').value = 0;

    let raw;
    try {
      raw = await GenAdapter.buildRaw(mapName, { sites: !!settings.sites });
    } catch (err) {
      if (token !== runToken) return;
      job = null;
      setRunning(false);
      setStatus(`Error: ${err.message}`, true);
      console.error('Generator: data load failed', err);
      return;
    }
    if (token !== runToken) return; // cancelled or map switched while loading

    const t0 = performance.now();
    let handle;
    try {
      handle = GenAdapter.start(raw, settings, (frac, text) => {
        if (token !== runToken) return;
        $('gen-progress').value = Math.max(0, Math.min(1, frac || 0));
        if (text) setStatus(text);
      });
    } catch (err) {
      job = null;
      setRunning(false);
      setStatus(`Error: ${err.message}`, true);
      console.error('Generator: worker start failed', err);
      return;
    }
    job.cancel = handle.cancel;
    setStatus('generating...');

    try {
      const result = await handle.promise;
      if (token !== runToken) return;
      job = null;
      setRunning(false);
      run = { mapName, raw, settings, result, ctx: null, ctxError: null, fieldCache: new Map() };
      renderResults(performance.now() - t0);
    } catch (err) {
      if (token !== runToken) return;
      job = null;
      setRunning(false);
      if (err && err.cancelled) return;
      setStatus(`Error: ${err.message || err}`, true);
      console.error('Generator: run failed', err);
    }
  }

  function cancelRun(reason) {
    if (!job) return;
    const j = job;
    job = null;
    runToken++;
    if (j.cancel) j.cancel();
    setRunning(false);
    setStatus(reason || 'cancelled');
  }

  // ── results ────────────────────────────────────────────────────────────

  function fmt(v, digits) {
    return Number.isFinite(v) ? v.toFixed(digits ?? 2) : '-';
  }

  function gateFailed(ev, id) {
    return (ev.gateFails || []).some(f => String(f) === id || String(f).startsWith(id + ' ') ||
      String(f).startsWith(id + ':') || String(f).startsWith(id + '_'));
  }

  function rolesOf(obj) {
    return obj ? ROLES.filter(r => obj[r] !== undefined) : [];
  }

  function metricsLine(ev, mode) {
    const m = ev.metrics || {};
    const parts = [];
    if (m.distances) {
      parts.push('d ' + Object.values(m.distances).map(d => Math.round(d)).join('/'));
    }
    if (Number.isFinite(m.squeeze) && mode === 'hvhva') parts.push(`sq ${fmt(m.squeeze)}`);
    if (m.kit) parts.push('kit ' + rolesOf(m.kit).map(r => m.kit[r]).join('/'));
    if (m.shares) parts.push('share ' + rolesOf(m.shares).map(r => Math.round(m.shares[r] * 100)).join('/') + '%');
    if (m.exposure) parts.push('E ' + rolesOf(m.exposure).map(r => fmt(m.exposure[r])).join('/'));
    return parts.join(' · ');
  }

  /** Next to the score: T2 shares of the own resource type (S/C[/A], hva H/A) and the gaps B/O. */
  function sharesGapLine(ev, mode) {
    const m = ev.metrics || {};
    const parts = [];
    const s2 = m.shares2;
    if (s2) {
      const roles = rolesOf(s2).filter(r => Number.isFinite(s2[r]));
      const keys = roles.map(r => (mode === 'hva' && r !== 'Alien' ? 'H' : r[0])).join('/');
      if (roles.length) {
        parts.push(`<span title="T2: share of each side's own resource type in its soft territory">` +
          `s ${keys} ${roles.map(r => fmt(s2[r])).join('/')}</span>`);
      }
    }
    if (m.gap) {
      parts.push(`<span title="largest blank radius without a kept patch, Balterium / Biotics">` +
        `gap ${Math.round(m.gap.Balterium)}/${Math.round(m.gap.Biotics)} m</span>`);
    }
    return parts.join(' · ');
  }

  /**
   * Expansion curve V(k) per human (spec 12.1): a small line chart (Sol blue, Cent red; hva one
   * human line) plus the values and min/max at k = 1 and k = K.
   */
  function expansionLine(ev, mode) {
    const ex = (ev.metrics || {}).expansion;
    if (!ex) return '';
    const keys = ['Sol', 'Cent'].filter(k => ex[k] && Array.isArray(ex[k].V));
    if (!keys.length) return '';
    const K = ex[keys[0]].V.length;
    let vmax = 1;
    for (const k of keys) for (const v of ex[k].V) if (v > vmax) vmax = v;
    const W = 54, H = 18, P = 2;
    const xy = (v, i) => `${(P + (K > 1 ? i * (W - 2 * P) / (K - 1) : (W - 2 * P) / 2)).toFixed(1)},${(H - P - v * (H - 2 * P) / vmax).toFixed(1)}`;
    const lines = keys.map(k => `<polyline points="${ex[k].V.map(xy).join(' ')}" fill="none" ` +
      `stroke="rgb(${ROLE_RGB[k].join(',')})" stroke-width="1.5"/>`).join('');
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="vertical-align:middle;margin-right:4px;` +
      `background:rgba(255,255,255,0.06);border-radius:2px;">${lines}</svg>`;
    const lab = k => (mode === 'hva' ? 'H' : k[0]);
    const vals = keys.map(k => `${lab(k)} ${ex[k].V.join('/')}`).join(' · ');
    const r = (ev.metrics || {}).expansionRatio;
    const ratio = Array.isArray(r) && r.length ? ` · min/max ${fmt(r[0])}/${fmt(r[r.length - 1])}` : '';
    const layer = keys.map(k => ex[k].layer).join('/');
    const title = `Expansion curve V(k): Balterium the best 1..${K} expansion HQs can grab per human (own side, outside the kit); ` +
      `layer ${layer}` + (ratio ? '; min/max at k = 1 and k = K' : '');
    return `<span title="${title}">${svg}V ${vals}${ratio}</span>`;
  }

  function fmtAmount(v) {
    if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 ? 2 : 0)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v % 1e3 ? 1 : 0)}K`;
    return `${v}`;
  }

  /**
   * Kept patches and resource on the whole map, and inside each starting circle (Balterium
   * within the refinery radius per human, Biotics within the Nest radius). Every kept patch
   * holds the global slider amount (generated layouts carry no patch_overrides).
   */
  function resourceLine(ev, mode) {
    const am = Layers.getResourceAmounts();
    const per = { Balterium: am.balterium, Biotics: am.biotics };
    const kept = (ev.plan && ev.plan.kept) || {};
    const nB = (kept.Balterium || []).length, nO = (kept.Biotics || []).length;
    const onMap = `Map: Balt ${nB} <b>${fmtAmount(nB * per.Balterium)}</b>` +
      ` · Bio ${nO} <b>${fmtAmount(nO * per.Biotics)}</b>`;
    const kit = (ev.metrics || {}).kit || {};
    const roles = rolesOf(kit).filter(r => !(mode === 'hva' && r === 'Cent'));   // hva: Sol === Cent
    const start = roles.map(r => {
      const type = r === 'Alien' ? 'Biotics' : 'Balterium';
      const lab = mode === 'hva' && r === 'Sol' ? 'H' : r[0];
      return `${lab} ${kit[r]} ${type === 'Balterium' ? 'Balt' : 'Bio'} ${fmtAmount(kit[r] * per[type])}`;
    }).join(' · ');
    const title = `Patch count and resource total (every kept patch holds the global slider amount: ` +
      `Balterium ${fmtAmount(per.Balterium)}, Biotics ${fmtAmount(per.Biotics)}). Start = inside the starting circle: ` +
      'Balterium within the refinery radius per human, Biotics within the Nest radius';
    return `<span title="${title}">${onMap}${start ? `<br>Start: ${start}` : ''}</span>`;
  }

  function updateResourceLines() {
    if (!run || !run.result) return;
    const cands = run.result.candidates || [];
    document.querySelectorAll('#gen-results .gen-row').forEach(row => {
      const ev = cands[parseInt(row.dataset.idx)];
      const el = row.querySelector('.gen-row-res');
      if (ev && el) el.innerHTML = resourceLine(ev, run.settings.mode);
    });
  }

  /** Status suffix for spec 15.4: unplaceable Balterium left out, or the feature off for lack of data. */
  function placeNote(st) {
    const p = st && st.placeability;
    if (!p) return '';
    if (!p.enabled) return ` · placeability off: ref_place file missing (${(p.missing || []).join(', ')})`;
    return ` · ${p.ineligible} Balterium with < ${p.minGood} usable placements not counted (${p.sides ? 'swap off: Sol start Sol, Cent start Cent' : (p.required || []).join('+')})`;
  }

  /** Status suffix for spec 17: base sites on (low-open spots skipped) or off for lack of data. */
  function siteNote(st) {
    const p = st && st.sites;
    if (!p) return '';
    if (!p.enabled) return ' · base sites off: no site data for this map';
    const lo = p.lowOpen || {};
    return ` · valid base sites only, ${(lo.human || 0) + (lo.alien || 0)} spots with little open ground skipped`;
  }

  function renderResults(wallMs) {
    const box = $('gen-results');
    box.innerHTML = '';
    const { result, settings } = run;
    const cands = (result && result.candidates) || [];
    const st = (result && result.stats) || {};
    const c = st.candidates || {};
    const ms = Number.isFinite(st.ms) ? st.ms : wallMs;
    // the kit maxima; an hvh run knows no Nest maximum, so keep the last one shown for this map
    const prevNest = $('gen-adv-nestkit-max').textContent;
    showKitRange(st.kitRange);
    if (!(st.kitRange && Number.isFinite(st.kitRange.alienMax)) && settings.mode === 'hvh') $('gen-adv-nestkit-max').textContent = prevNest;
    const isRandom = result && result.kind === 'random';
    if (isRandom) {
      const inf = (result.runs || []).filter(r => r.infeasible);
      const why = Array.from(new Set(inf.map(r => r.infeasible.reason))).join(', ');
      setStatus(`${cands.length} set(s) from ${(result.runs || []).length} runs` +
        (inf.length ? ` (${inf.length} infeasible: ${why})` : '') +
        ` in ${(ms / 1000).toFixed(1)} s · pool ${st.pool ?? '?'}` + placeNote(st) + siteNote(st));
    } else {
      setStatus(`${cands.length} set(s) in ${Math.round(ms)} ms · candidates ${c.human ?? '?'}h/${c.alien ?? '?'}a · ` +
        `stage 1 ${st.stage1Sets ?? '?'} · stage 2 ${st.stage2Sets ?? '?'}` + placeNote(st) + siteNote(st));
    }
    // spec 13.5 / 13.7: an infeasible request is a named result, not an error
    if (result && result.infeasible) {
      setStatus(`infeasible: ${result.infeasible.reason}: ${result.infeasible.detail}`, true);
      return;
    }
    if (!cands.length) {
      setStatus('No valid start set found. Try a smaller enemy distance or fewer patches.', true);
      return;
    }

    // only the gates of this mode (G5 is hvh / hvhva only)
    const gates = registryEntries('hard').filter(g => !Array.isArray(g.modes) || g.modes.includes(settings.mode));
    const terms = registryEntries('soft');
    cands.forEach((ev, i) => {
      const fails = ev.gateFails || [];
      const row = document.createElement('div');
      const above = ev.aboveBar !== undefined ? ev.aboveBar : ev.score > PRESENTATION_BAR;
      row.className = 'gen-row' + (fails.length ? ' gen-row-fail' : (above ? ' gen-row-warn' : ''));
      row.dataset.idx = i;
      row.title = fails.length ? `Failed gates: ${fails.join(', ')}` :
        (above ? BAR_WARNING : 'Click to preview');

      const gateHtml = gates.map(g => {
        const bad = gateFailed(ev, g.id);
        return `<span class="gen-gate ${bad ? 'gen-gate-fail' : 'gen-gate-ok'}" title="${g.id} ${labelOf(g)}">${g.id}</span>`;
      }).join('');
      const termHtml = terms.filter(t => ev.terms && ev.terms[t.id] !== undefined).map(t => {
        const v = ev.terms[t.id];
        const pct = Math.max(0, Math.min(1, (v || 0) / PRESENTATION_BAR)) * 100;
        const color = v < 1 ? '#4fc3f7' : v < PRESENTATION_BAR ? '#ffcc00' : '#ff6666';
        return `<div class="gen-term" title="${t.id} ${labelOf(t)}: ${fmt(v, 3)}">` +
          `<span class="gen-term-label">${t.id}</span>` +
          `<span class="gen-term-track"><span class="gen-term-bar" style="display:block;width:${pct.toFixed(1)}%;background:${color};"></span></span>` +
          `<span class="gen-term-val">${fmt(v)}</span></div>`;
      }).join('');

      const head = isRandom && ev.run
        ? `<span class="gen-score" title="score without the distance-target part of T1 (comparable across runs)">fair ${fmt(ev.fair)}</span>`
        : `<span class="gen-score">score ${fmt(ev.score)}</span>`;
      const runLine = isRandom && ev.run
        ? `<div class="gen-row-sub">d* ${ev.run.enemyDistance} m · seed ${ev.run.seed} · run ${ev.run.index + 1}/${result.runs.length} #${ev.run.rank} · score ${fmt(ev.run.score)}</div>`
        : '';
      row.innerHTML =
        `<div class="gen-row-head"><b>#${ev.rank || i + 1}</b>${head}` +
        `<span class="gen-gates">${gateHtml}</span></div>` +
        runLine +
        `<div class="gen-row-sub gen-row-res">${resourceLine(ev, settings.mode)}</div>` +
        `<div class="gen-row-sub">${sharesGapLine(ev, settings.mode)}</div>` +
        `<div class="gen-row-sub gen-row-exp">${expansionLine(ev, settings.mode)}</div>` +
        (above && !fails.length ? `<div class="gen-row-warntext">${BAR_WARNING}</div>` : '') +
        `<div class="gen-terms">${termHtml}</div>` +
        `<div class="gen-metrics">${metricsLine(ev, settings.mode)}</div>` +
        `<div class="gen-row-actions">` +
        `<button class="btn btn-alien gen-apply">Apply</button>` +
        `<button class="btn btn-clear gen-download">Download</button></div>`;

      row.addEventListener('click', () => {
        if (previewIdx === i) clearPreview();
        else showPreview(i);
      });
      row.querySelector('.gen-apply').addEventListener('click', (e) => {
        e.stopPropagation();
        applyResult(i);
      });
      row.querySelector('.gen-download').addEventListener('click', (e) => {
        e.stopPropagation();
        downloadResult(i);
      });
      box.appendChild(row);
    });
  }

  function markActiveRow() {
    document.querySelectorAll('#gen-results .gen-row').forEach(r => {
      r.classList.toggle('gen-row-active', parseInt(r.dataset.idx) === previewIdx);
    });
  }

  // ── preview ────────────────────────────────────────────────────────────

  /** Main-thread GenContext for preview fields and layout building (built once per run). */
  function ensureContext() {
    if (run.ctx || run.ctxError) return run.ctx;
    try {
      run.ctx = GenAdapter.context(run.raw, run.settings);
    } catch (err) {
      run.ctxError = err;
      console.warn('Generator: main-thread context build failed', err);
    }
    return run.ctx;
  }

  /** Owner array of an evaluation: carried by the result if present, else recomputed. */
  function ownerOf(ev) {
    if (ev.owner) return { owner: ev.owner, fields: ev.ownerSides ? { sides: ev.ownerSides } : null };
    const ctx = ensureContext();
    if (!ctx) return null;
    try {
      const f = GenAdapter.fields(ctx, run.settings, ev.set, run.fieldCache);
      return { owner: f.owner, fields: f };
    } catch (err) {
      console.warn('Generator: territory fields failed', err);
      return null;
    }
  }

  /** Role per owner index: Fields.sides (hva: Sol and Cent share one side), else derived from the set. */
  function ownerRoles(set, fields) {
    if (fields && Array.isArray(fields.sides)) return fields.sides;
    if (set.Sol && set.Sol === set.Cent) return ['Sol', ...(set.Alien ? ['Alien'] : [])];
    return ROLES.filter(r => set[r]);
  }

  function territoryImage(owner, roles, n) {
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const g = canvas.getContext('2d');
    const img = g.createImageData(n, n);
    for (let c = 0; c < n * n; c++) {
      const o = owner[c];
      if (o < 0 || o >= roles.length) continue;
      const rgb = ROLE_RGB[roles[o]] || [200, 200, 200];
      img.data[c * 4] = rgb[0];
      img.data[c * 4 + 1] = rgb[1];
      img.data[c * 4 + 2] = rgb[2];
      img.data[c * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }

  function structureIcon(role, label) {
    return L.divIcon({
      className: `hq-marker hq-marker-${ROLE_CSS[role]}`,
      html: `<span style="font-size:9px;font-weight:700;line-height:14px;display:block;text-align:center;color:#fff;">${label}</span>`,
      iconSize: [20, 20],
    });
  }

  function showPreview(i) {
    clearPreview();
    const ev = run.result.candidates[i];
    if (!ev || !ev.set) return;
    previewIdx = i;
    previewGroup = L.layerGroup().addTo(map);
    const settings = run.settings;
    const set = ev.set;

    // Territory overlay (101² control grid, row 0 = north; spec: [-extent, extent])
    const own = ownerOf(ev);
    if (own && own.owner) {
      const n = Math.round(Math.sqrt(own.owner.length));
      const extent = run.raw.cfg.extent;
      const g = run.result.ctrl;
      const bounds = g && g.n === n && Number.isFinite(g.cell)
        ? [[g.maxZ - n * g.cell, g.minX], [g.maxZ, g.minX + n * g.cell]]
        : [[-extent, -extent], [extent, extent]];
      const roles = ownerRoles(set, own.fields);
      territoryOverlay = L.imageOverlay(territoryImage(own.owner, roles, n), bounds, {
        opacity: TERRITORY_OPACITY, interactive: false,
      });
      const cb = $('layer-territory');
      cb.disabled = false;
      cb.checked = true;
      territoryOverlay.addTo(map);
    }

    // Patch tints: kept by type, removed dimmed, kit (frozen) patches emphasised
    const plan = ev.plan || {};
    const kept = plan.kept || {};
    const keptBalt = new Set(kept.Balterium || []);
    const keptBio = new Set(kept.Biotics || []);
    const removed = new Set(plan.removed || []);
    const frozen = plan.frozen instanceof Set ? plan.frozen : new Set(plan.frozen || []);
    for (const r of run.raw.resources.resources) {
      const latlng = [r.z, r.x];
      if (removed.has(r.idx)) {
        L.circleMarker(latlng, {
          pane: 'genPatchPane', radius: 9, color: '#ff4444', weight: 1, opacity: 0.6,
          fillColor: '#000', fillOpacity: 0.6, interactive: false,
        }).addTo(previewGroup);
      } else if (keptBalt.has(r.idx) || keptBio.has(r.idx)) {
        const color = keptBalt.has(r.idx) ? '#ffffff' : '#c070ff';
        L.circleMarker(latlng, {
          pane: 'genPatchPane', radius: frozen.has(r.idx) ? 13 : 11, color, weight: frozen.has(r.idx) ? 3 : 1.5,
          opacity: 0.9, fill: false, interactive: false,
        }).addTo(previewGroup);
      }
    }

    // Structures + their starting radii
    const humanSame = set.Sol && set.Sol === set.Cent;
    const drawn = [];
    for (const role of ROLES) {
      const c = set[role];
      if (!c || drawn.includes(c)) continue;
      drawn.push(c);
      const isAlien = role === 'Alien';
      const label = isAlien ? 'A' : (humanSame ? 'H' : role[0]);
      L.circle([c.z, c.x], {
        radius: isAlien ? settings.radii.nest : settings.radii.build,
        color: `rgb(${ROLE_RGB[role].join(',')})`, weight: 1.5, dashArray: '6,4', fill: false, interactive: false,
      }).addTo(previewGroup);
      const title = `${humanSame && !isAlien ? 'Sol + Cent' : role} (${Math.round(c.x)}, ${Math.round(c.z)})` +
        (Number.isFinite(c.E) ? ` E ${c.E.toFixed(2)}` : '') + (Number.isFinite(c.z0) ? ` h ${Math.round(c.z0)} m` : '');
      L.marker([c.z, c.x], { pane: 'genMarkerPane', icon: structureIcon(role, label), title }).addTo(previewGroup);
    }

    markActiveRow();
  }

  function clearPreview() {
    if (previewGroup && map) map.removeLayer(previewGroup);
    if (territoryOverlay && map) map.removeLayer(territoryOverlay);
    previewGroup = null;
    territoryOverlay = null;
    previewIdx = -1;
    const cb = $('layer-territory');
    if (cb) { cb.checked = false; cb.disabled = true; }
    markActiveRow();
  }

  // ── apply / download ───────────────────────────────────────────────────

  /**
   * A random search result is written as the normal layout of its own run (spec 14.4): the run's
   * settings, in-run rank and stats, plus _meta.generator.random.
   */
  function buildLayout(i) {
    const ev = run.result.candidates[i];
    if (run.result.kind === 'random' && ev.run) {
      const r = run.result, p = { enemyDistance: ev.run.enemyDistance, seed: ev.run.seed };
      const prm = GenRandom.params(r.settings);
      return GenAdapter.layout(run.mapName, GenRandom.runSettings(r.settings, p), ev, ev.run.rank, Layers.getResourceAmounts(), {
        stats: r.runs[ev.run.index].stats,
        random: { searchSeed: r.searchSeed, runs: prm.runs, band: prm.band, runIndex: ev.run.index, poolRank: ev.rank || i + 1, fair: Math.round(ev.fair * 1000) / 1000 },
      });
    }
    return GenAdapter.layout(run.mapName, run.settings, ev, ev.rank || i + 1, Layers.getResourceAmounts(),
      { stats: run.result.stats });
  }

  async function applyResult(i) {
    let layout;
    try {
      layout = buildLayout(i);
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      console.error('Generator: layout build failed', err);
      return;
    }
    clearPreview();
    try {
      await UI.importLayout(layout);
      const g = layout._meta.generator;
      setStatus(`Applied #${i + 1} (${run.settings.mode}, seed ${g.seed}${g.random ? `, d* ${g.settings.enemyDistance} m` : ''}).`);
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      console.error('Generator: apply failed', err);
    }
  }

  function downloadResult(i) {
    let layout;
    try {
      layout = buildLayout(i);
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      console.error('Generator: layout build failed', err);
      return;
    }
    const json = JSON.stringify(layout, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = GenLayout.fileName(layout);
    a.click();
    URL.revokeObjectURL(url);
  }

  return {
    init, onMapChange, onMapLoaded, readSettings,
    // exposed for tests / console
    get state() { return { running: !!job, run, previewIdx }; },
    showPreview, clearPreview, buildLayout, startRun, cancelRun,
  };
})();
