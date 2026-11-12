/**
 * site_ui.js - Base sites in the tool (docs/SITE_SCAN.md): site data per map, the check of a spawn
 * base (Sol HQ, Centauri HQ, Nest) on placing and dragging, auto-snap, the rotation popup, the
 * layout check list with Fix / Fix all, and the "Base sites" layer. Every rule (validity, which HQs
 * a spot must fit, today's yaw, the fix ranking, openness) comes from js/sites.js.
 */

const SiteUI = (() => {
  let map = null;
  let sd = null;          // Sites SiteData of the current map; null while loading or without data
  let loading = Promise.resolve(null);
  let token = 0;
  let overlay = null;
  let foot = {};          // struct -> {x0, x1, z0, z1}: footprint rectangle in the prefab frame (meta)
  let changeTimer = null;
  let popup = null;

  const $ = id => document.getElementById(id);
  const NAME = s => Sites.NAMES[s];
  const pct = v => `${Math.round(v * 100)} %`;

  function init(m) {
    map = m;
    $('site-check').addEventListener('click', () => refreshCheck(true));
    $('site-fix-all').addEventListener('click', fixAll);
    for (const id of ['site-layer-struct', 'site-layer-rot']) $(id).addEventListener('change', refreshOverlay);
  }

  // ── data ──

  /** New map: drop the old data and load data/sites for assetMap (variants: the base map). */
  function onMapChange(mapName, assetMap) {
    const t = ++token;
    sd = null;
    foot = {};
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    if (popup) { map.closePopup(popup); popup = null; }
    renderList([]);
    status('');
    loading = Sites.load(assetMap).then(d => {
      if (t !== token) return null;
      sd = d;
      foot = d ? parseFootprints(d.meta) : {};
      if (!d) status(`No base site data for ${assetMap}: spawn bases use the old HQ zones.`, 'warn');
      Placement.refreshSiteVisuals();
      refreshOverlay();
      refreshCheck(false);
      return d;
    }).catch(err => {
      console.warn(`Base sites ${assetMap}: not loaded`, err);
      if (t === token) { sd = null; status(`Base site data failed to load (${err.message}).`, 'error'); }
      return null;
    });
    return loading;
  }

  function hasData() { return !!sd; }
  function data() { return sd; }

  /** "footprint x[-53.5,53.7] z[-70.5,71.7]" per structure from the meta's structure lines. */
  function parseFootprints(meta) {
    const out = {};
    for (const line of meta.structures || []) {
      const m = /^(Sol|Cent|Alien):.*?footprint x\[(-?[\d.]+),(-?[\d.]+)\] z\[(-?[\d.]+),(-?[\d.]+)\]/.exec(line);
      if (m) out[m[1]] = { x0: +m[2], x1: +m[3], z0: +m[4], z1: +m[5] };
    }
    return out;
  }

  /** Footprint corners [[lat=z, lng=x] x4] at (x, z), rotated by yaw (Unity: clockwise from above). */
  function corners(struct, x, z, yaw) {
    const f = foot[struct];
    if (!f) return null;
    const a = yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[f.x0, f.z0], [f.x1, f.z0], [f.x1, f.z1], [f.x0, f.z1]]
      .map(([lx, lz]) => [z - lx * s + lz * c, x + lx * c + lz * s]);
  }

  // ── rules in the tool's terms ──

  /** The tool state as a layout for Sites.structuresOf (modes, swap, the human spawn positions). */
  function layoutCtx(faction, x, z) {
    const gm = {
      hvh: $('mode-hvh').checked, hva: $('mode-hva').checked,
      hvhva: $('mode-hvhva').checked, '4way': $('mode-4way').checked,
    };
    if ($('mode-2v1').checked) gm['2v1'] = true;
    const spawns = {};
    for (const f of ['Sol', 'Cent']) {
      const h = Placement.getSpawnBase(f);
      if (h) spawns[f] = [{ x: h.latlng.lng, z: h.latlng.lat }];
    }
    if (faction === 'Sol' || faction === 'Cent') spawns[faction] = [{ x, z }];
    return { game_modes: gm, swap_spawns: $('swap-spawns').checked, spawns };
  }

  function structsFor(faction, x, z) { return Sites.structuresOf(layoutCtx(faction, x, z), faction); }

  function mustFit(structs) {
    if (structs.length < 2) return '';
    const shared = !$('swap-spawns').checked || !Sites.canSwap(layoutCtx(), {});
    return `${structs.map(NAME).join(' and ')} (${shared ? 'one position for both HQs' : 'Sol/Cent swap'})`;
  }

  /** Plain words for why a base fails today: "Sol HQ: cuts into a cliff ... (at 90°)". */
  function failText(st) {
    const bad = st.today.filter(t => !(t.code & 1));
    return bad.map(t => `${st.structs.length > 1 ? NAME(t.struct) + ': ' : ''}${Sites.reasonText(t.code, t.struct)} ` +
      `(at ${Math.round(t.yaw)}°${t.exact ? '' : `, checked at the nearest 90° step, ${Sites.YAWS[t.yi]}°`})`).join('; ');
  }

  function shortFix(fix) {
    if (!fix) return 'no valid site nearby';
    return fix.kind === 'rot' ? `rotated to ${fix.rot}°` : `moved ${fix.d} m, rot ${fix.rot}°`;
  }

  function autoSnap() { return $('site-autosnap').checked; }

  function lowText(faction, o) {
    return `Little open ground around the ${NAME(faction)}: ${pct(o.reach)} of the 60-250 m ring is reachable for its ` +
      `${faction === 'Alien' ? 'units' : 'vehicles'} (warning below ${pct(Sites.lowOpenLimit(faction))}). Not moved automatically.`;
  }

  /**
   * A spawn base lands at (x, z) with rot (undefined = start point yaw); manual = rot picked by hand.
   * -> {ok, x, z, rot, msg, short, level}: ok false = reject (place: nothing placed; drag: moved back).
   * Restrict off: always accepted, with a warning. Auto-snap: fix order of SITE_SCAN.md section 8
   * (another rotation, then the nearest valid cell within 120 m), except for a rotation picked by
   * hand, which is kept with a warning and the fix offered in the popup / check list.
   */
  function decide(faction, x, z, rot, manual, restrict) {
    const structs = structsFor(faction, x, z);
    const st = Sites.checkBase(sd, structs, x, z, rot);
    if (st.validToday) {
      const o = Sites.openness(sd, faction, x, z);
      if (Sites.isLowOpen(faction, o)) return { ok: true, x, z, rot, msg: lowText(faction, o), short: 'little open ground', level: 'warn' };
      return { ok: true, x, z, rot };
    }
    const why = failText(st);
    if (!restrict) {
      return { ok: true, x, z, rot, msg: `Not a valid base site: ${why}. Placed anyway ("Restrict" is off).`, short: 'invalid base site', level: 'warn' };
    }
    if (!autoSnap()) return { ok: false, msg: `Not a valid base site: ${why}.`, short: 'invalid base site' };
    if (manual && rot !== undefined) {
      return {
        ok: true, x, z, rot, level: 'warn', short: `${rot}° does not fit`,
        msg: `Your rotation ${rot}° does not fit here: ${why}. Suggested fix: ${Sites.fixText(st.fix)} (click the base).`,
      };
    }
    if (!st.fix) return { ok: false, msg: `No valid site within 120 m: ${why}.`, short: 'no valid site nearby' };
    let msg = `${NAME(faction)} ${Sites.fixText(st.fix)}${structs.length > 1 ? ', valid for ' + structs.map(NAME).join(' and ') : ''}. Before: ${why}.`;
    const o = Sites.openness(sd, faction, st.fix.x, st.fix.z);
    if (Sites.isLowOpen(faction, o)) msg += ' ' + lowText(faction, o);
    return { ok: true, x: st.fix.x, z: st.fix.z, rot: st.fix.rot, msg, short: shortFix(st.fix), level: 'info' };
  }

  /** State of a placed spawn base: structs, Sites.checkBase result, openness. */
  function stateOf(h) {
    const x = h.latlng.lng, z = h.latlng.lat;
    const structs = structsFor(h.faction, x, z);
    const st = Sites.checkBase(sd, structs, x, z, h.rot);
    const o = Sites.openness(sd, h.faction, x, z);
    return { structs, st, open: o, low: Sites.isLowOpen(h.faction, o) };
  }

  /** For Placement.refreshSiteVisual: shown yaw, bad / low flags, footprint corners. */
  function visualInfo(h) {
    if (!sd) return null;
    const s = stateOf(h);
    const yaw = s.st.today[0].yaw;
    return { yaw, bad: !s.st.validToday, low: s.low, corners: corners(h.faction, h.latlng.lng, h.latlng.lat, yaw) };
  }

  /** The other human spawn base at the same position (one position for both HQs), else null. */
  function sharedPartner(h) {
    if (h.faction !== 'Sol' && h.faction !== 'Cent') return null;
    const o = Placement.getSpawnBase(h.faction === 'Sol' ? 'Cent' : 'Sol');
    if (!o || o === h) return null;
    return Math.abs(o.latlng.lng - h.latlng.lng) < 0.5 && Math.abs(o.latlng.lat - h.latlng.lat) < 0.5 ? o : null;
  }

  function applyPose(h, x, z, rot, manual) {
    const partner = Sites.DEFAULT_RULES.sharedSpot ? sharedPartner(h) : null;
    Placement.setSpawnPose(h, x, z, rot, manual);
    if (partner) Placement.setSpawnPose(partner, x, z, rot, manual);
  }

  function applyFix(h, fix) {
    applyPose(h, fix.x, fix.z, fix.rot, false);
    changed();
  }

  // ── status line, change hook ──

  function status(msg, level) {
    const el = $('site-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('gen-error', level === 'error');
    el.classList.toggle('site-status-warn', level === 'warn');
    el.classList.toggle('site-status-info', level === 'info');
  }

  /** Spawn bases, modes or swap changed: refresh markers and the check list (batched). */
  function changed() {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (!sd) return;
      Placement.refreshSiteVisuals();
      refreshCheck(false);
    }, 30);
  }

  /** After a layout import: check every spawn base once the site data is there. */
  function afterImport() {
    loading.then(() => {
      if (changeTimer) { clearTimeout(changeTimer); changeTimer = null; }
      if (sd) { Placement.refreshSiteVisuals(); refreshCheck(true); }
    });
  }

  // ── rotation popup ──

  function openPopup(h) {
    if (!sd || !map) return;
    if (popup) map.closePopup(popup);
    popup = L.popup({ maxWidth: 320, autoPan: true }).setLatLng(h.latlng).setContent(popupContent(h)).openOn(map);
  }

  function popupContent(h) {
    const s = stateOf(h), st = s.st, t0 = st.today[0];
    const el = document.createElement('div');
    el.className = 'site-pop';
    const x = h.latlng.lng, z = h.latlng.lat;
    let rotLine;
    if (h.rot === undefined) {
      rotLine = `<b>auto</b>: the mod uses the rotation of the nearest start point` +
        (t0.point ? ` (${t0.point.name}), <b>${Math.round(t0.yaw)}°</b>` : `, ${Math.round(t0.yaw)}°`) +
        (t0.exact ? '' : ' (not a multiple of 90°, checked at the nearest 90° step)');
    } else rotLine = `<b>${h.rot}°</b> (${h.rotManual ? 'set by hand' : 'set'}; exported as "rot")`;
    const fit = mustFit(s.structs);
    let html = `<b>${NAME(h.faction)}</b> at (${x}, ${z})<br>Rotation: ${rotLine}` +
      (fit ? `<br><span class="site-dim">Must fit: ${fit}</span>` : '') +
      '<div class="site-rot-btns">';
    const opts = [{ label: 'auto', rot: undefined }].concat(Sites.YAWS.map(y => ({ label: `${y}°`, rot: y })));
    for (const o of opts) {
      let ok, title;
      if (o.rot === undefined) {
        const a = Sites.checkBase(sd, s.structs, x, z, undefined);   // start point yaw(s)
        ok = a.validToday;
        title = ok ? 'start point rotation fits' : failText(a);
      } else {
        const ck = Sites.checkYaw(sd, s.structs, x, z, o.rot);
        ok = ck.ok;
        title = ok ? 'fits' : ck.failing.map(f => `${s.structs.length > 1 ? NAME(f.struct) + ': ' : ''}${Sites.reasonText(f.code, f.struct)}`).join('; ');
      }
      const cur = (o.rot === undefined && h.rot === undefined) || o.rot === h.rot;
      html += `<button class="btn ${ok ? 'site-rot-ok' : 'site-rot-bad'}${cur ? ' site-rot-cur' : ''}" data-rot="${o.rot === undefined ? 'auto' : o.rot}" title="${title.replace(/"/g, '&quot;')}">${o.label}</button>`;
    }
    html += '</div>';
    html += st.validToday
      ? '<div class="site-ok">Fits here.</div>'
      : `<div class="site-badtext">Does not fit: ${failText(st)}.</div>`;
    if (s.open) {
      html += `<div class="${s.low ? 'site-warntext' : 'site-dim'}">Open ground: ${pct(s.open.reach)} of the 60-250 m ring reachable` +
        `${s.low ? ` (below ${pct(Sites.lowOpenLimit(h.faction))}: little room for the starter units)` : ''}.</div>`;
    }
    if (!st.validToday) {
      html += st.fix
        ? `<button class="btn btn-alien site-pop-fix">Fix: ${Sites.fixText(st.fix)}</button>`
        : `<div class="site-badtext">No valid site within 120 m${st.far ? ` (nearest: ${st.far.d} m away)` : ''}.</div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.site-rot-btns .btn').forEach(b => {
      b.addEventListener('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const v = b.dataset.rot === 'auto' ? undefined : Number(b.dataset.rot);
        applyPose(h, h.latlng.lng, h.latlng.lat, v, v !== undefined);
        const a = stateOf(h);
        if (a.st.validToday) status(`${NAME(h.faction)}: rotation ${v === undefined ? 'auto' : v + '°'} fits.`, 'info');
        else status(`${NAME(h.faction)}: rotation ${v === undefined ? 'auto (' + Math.round(a.st.today[0].yaw) + '°)' : v + '°'} does not fit here: ` +
          `${failText(a.st)}. ${a.st.fix ? 'Suggested fix: ' + Sites.fixText(a.st.fix) + '.' : 'No valid site within 120 m.'}`, 'warn');
        changed();
        popup.setContent(popupContent(h));
      });
    });
    const fb = el.querySelector('.site-pop-fix');
    if (fb) {
      fb.addEventListener('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const fix = st.fix;
        applyFix(h, fix);
        status(`${NAME(h.faction)} ${Sites.fixText(fix)}.`, 'info');
        popup.setLatLng(h.latlng);
        popup.setContent(popupContent(h));
      });
    }
    return el;
  }

  // ── layout check list ──

  function bases() {
    const out = [];
    for (const f of ['Sol', 'Cent', 'Alien']) {
      const h = Placement.getSpawnBase(f);
      if (h) out.push({ h, s: stateOf(h) });
    }
    return out;
  }

  function refreshCheck(announce) {
    if (!sd) { renderList([]); return; }
    const list = bases();
    renderList(list);
    const bad = list.filter(b => !b.s.st.validToday), low = list.filter(b => b.s.low);
    $('site-fix-all').disabled = !bad.some(b => b.s.st.fix);
    if (announce) {
      if (!list.length) status('No spawn bases placed.');
      else if (!bad.length && !low.length) status(`Layout check: all ${list.length} spawn bases fit.`, 'info');
      else {
        status(`Layout check: ${list.length} spawn bases, ${bad.length} need${bad.length === 1 ? 's' : ''} a fix` +
          `${low.length ? `, ${low.length} with little open ground` : ''}.`, bad.length ? 'error' : 'warn');
      }
    }
  }

  /** Words for a move fix that changes the patches inside the base's build radius, else ''. */
  function kitNote(h, s, layout) {
    const fix = s.st.fix, res = Layers.getResourceData();
    if (!fix || fix.kind !== 'move' || !res) return '';
    const k = Sites.kitChange(res, layout, s.structs, h.latlng.lng, h.latlng.lat, fix.x, fix.z);
    if (!k.changed) return '';
    const seen = new Set(), parts = [];
    for (const d of k.details) {
      for (const i of d.gained) if (!seen.has('+' + i)) { seen.add('+' + i); parts.push(`+#${i}`); }
      for (const i of d.lost) if (!seen.has('-' + i)) { seen.add('-' + i); parts.push(`-#${i}`); }
    }
    return `this move changes the start kit (${parts.join(' ')}): check the balance after fixing`;
  }

  function renderList(list) {
    const el = $('site-list');
    if (!el) return;
    el.innerHTML = '';
    const layout = list.length ? Placement.exportLayout() : null;
    for (const { h, s } of list) {
      const st = s.st, t0 = st.today[0];
      const row = document.createElement('div');
      row.className = 'gen-row' + (!st.validToday ? ' gen-row-fail' : s.low ? ' gen-row-warn' : '');
      const rot = h.rot === undefined ? `auto ${Math.round(t0.yaw)}°` : `${h.rot}°`;
      let html = `<div class="gen-row-head"><span>${NAME(h.faction)} (${h.latlng.lng}, ${h.latlng.lat})</span><span>${rot}</span></div>`;
      html += st.validToday
        ? `<div class="gen-row-sub site-ok">fits${s.structs.length > 1 ? ' (' + s.structs.map(NAME).join(' + ') + ')' : ''}</div>`
        : `<div class="gen-row-sub site-badtext">${failText(st)}</div>`;
      if (s.low) html += `<div class="gen-row-warntext">little open ground: ${pct(s.open.reach)} reachable (below ${pct(Sites.lowOpenLimit(h.faction))})</div>`;
      if (!st.validToday) {
        const kn = kitNote(h, s, layout);
        if (kn) html += `<div class="gen-row-warntext">${kn}</div>`;
        html += st.fix
          ? `<div class="gen-row-actions"><button class="btn btn-alien site-fix">Fix: ${shortFix(st.fix)}</button></div>`
          : '<div class="gen-row-warntext">no valid site within 120 m: move it by hand</div>';
      }
      row.innerHTML = html;
      row.addEventListener('click', () => {
        map.panTo(h.latlng);
        openPopup(h);
      });
      const fb = row.querySelector('.site-fix');
      if (fb) {
        fb.addEventListener('click', (e) => {
          e.stopPropagation();
          applyFix(h, st.fix);
          status(`${NAME(h.faction)} ${Sites.fixText(st.fix)}.`, 'info');
        });
      }
      el.appendChild(row);
    }
  }

  function fixAll() {
    if (!sd) return;
    const done = [], left = [];
    for (const f of ['Sol', 'Cent', 'Alien']) {
      const h = Placement.getSpawnBase(f);
      if (!h) continue;
      const s = stateOf(h);   // fresh: a shared-position partner may be fixed already
      if (s.st.validToday) continue;
      if (s.st.fix) {
        applyPose(h, s.st.fix.x, s.st.fix.z, s.st.fix.rot, false);
        done.push(`${NAME(f)} ${Sites.fixText(s.st.fix)}`);
      } else left.push(NAME(f));
    }
    Placement.refreshSiteVisuals();
    refreshCheck(false);
    status(done.length || left.length
      ? `${done.length ? 'Fixed: ' + done.join('; ') + '.' : ''}${left.length ? ' No valid site within 120 m for ' + left.join(', ') + ': move by hand.' : ''}`
      : 'Nothing to fix.', left.length ? 'warn' : 'info');
  }

  // ── "Base sites" layer ──

  const COLORS = {
    valid: [40, 220, 60, 130],
    ground_terrain: [255, 140, 30, 115],
    ground_static: [235, 215, 40, 115],
    on_static: [235, 215, 40, 115],
    overlap: [255, 40, 40, 125],
    navmesh: [180, 80, 255, 115],
    no_data: [120, 120, 120, 90],
    offmap: [0, 0, 0, 0],
  };

  function refreshOverlay() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    const which = $('site-layer-struct').value, rv = $('site-layer-rot').value;
    if (!sd || rv === 'off') return;
    const structs = which === 'Both' ? ['Sol', 'Cent'] : [which];
    const w = sd.w, h = sd.h, n = w * h;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h), px = img.data;
    const yis = rv === 'any' ? [0, 1, 2, 3] : [Sites.YAWS.indexOf(Number(rv))];
    for (let i = 0; i < n; i++) {
      let nValid = 0, reason = null;
      for (const yi of yis) {
        let ok = true;
        for (const s of structs) {
          const c = sd.code[s][yi][i];
          if (!(c & 1)) { ok = false; if (reason === null) reason = Sites.reasonOf(c); break; }
        }
        if (ok) nValid++;
      }
      let c;
      if (nValid) {
        c = COLORS.valid.slice();
        if (rv === 'any') c[3] = 50 + 30 * nValid;
      } else c = COLORS[reason] || COLORS.no_data;
      px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = c[3];
    }
    ctx.putImageData(img, 0, 0);
    // pixel = the test at the cell centre: the image spans half a cell beyond the outer centres
    const hs = sd.step / 2, maxX = sd.minX + (w - 1) * sd.step, minZ = sd.maxZ - (h - 1) * sd.step;
    overlay = L.imageOverlay(canvas.toDataURL('image/png'), [[minZ - hs, sd.minX - hs], [sd.maxZ + hs, maxX + hs]], {
      interactive: false, className: 'ref-layer-img',
    }).addTo(map);
  }

  return {
    init, onMapChange, hasData, data, decide, visualInfo, openPopup, status, changed, afterImport,
    refreshCheck, fixAll, refreshOverlay,
  };
})();
