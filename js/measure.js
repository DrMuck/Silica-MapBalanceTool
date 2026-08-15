/**
 * measure.js - Draggable measuring box that reports the resources inside it.
 *
 * Arm with the "Measure Box" button, then drag on the map to draw a rectangle.
 * The box reports patch counts and resource totals for everything whose centre
 * falls inside it, using the amounts currently in effect (sliders, per-patch
 * overrides, exclusions). Corner handles resize it, the whole box can be
 * dragged to move it.
 */

const Measure = (() => {
  let map = null;
  let group = null;
  let rect = null;
  let handles = [];
  let armed = false;
  let drawing = false;
  let startLL = null;
  let dragOrigin = null; // {latlng, bounds} while the box is being moved

  const BOX_STYLE = { color: '#ffcc00', weight: 2, fillColor: '#ffcc00', fillOpacity: 0.08 };
  const MIN_SIZE = 15; // metres — anything smaller is treated as a stray click

  function init(m) {
    map = m;
    group = L.layerGroup().addTo(map);

    map.on('mousedown', onMapDown);
    map.on('mousemove', onMapMove);
    map.on('mouseup', onMapUp);
    // Releasing outside the map container never reaches Leaflet's mouseup
    window.addEventListener('mouseup', () => { if (drawing) onMapUp(); });
  }

  // --- arming ---------------------------------------------------------------

  function arm() {
    if (typeof Placement !== 'undefined') Placement.setPlacementMode(null);
    armed = true;
    map.dragging.disable();
    map.getContainer().style.cursor = 'crosshair';
    const btn = document.getElementById('btn-measure');
    if (btn) btn.classList.add('btn-active');
    render();
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    drawing = false;
    map.dragging.enable();
    map.getContainer().style.cursor = '';
    const btn = document.getElementById('btn-measure');
    if (btn) btn.classList.remove('btn-active');
    render();
  }

  function toggle() {
    if (armed) disarm();
    else arm();
  }

  // --- drawing --------------------------------------------------------------

  function onMapDown(e) {
    if (!armed) return;
    drawing = true;
    startLL = e.latlng;
    clearBox();
    rect = L.rectangle([[startLL.lat, startLL.lng], [startLL.lat, startLL.lng]], BOX_STYLE).addTo(group);
  }

  function onMapMove(e) {
    if (!drawing || !rect) return;
    rect.setBounds([[startLL.lat, startLL.lng], [e.latlng.lat, e.latlng.lng]]);
    render();
  }

  function onMapUp() {
    if (!drawing || !rect) return;
    drawing = false;
    const b = rect.getBounds();
    if (Math.abs(b.getEast() - b.getWest()) < MIN_SIZE || Math.abs(b.getNorth() - b.getSouth()) < MIN_SIZE) {
      clearBox();      // stray click, not a drag
      render();
      return;
    }
    disarm();          // one-shot: panning works again, the box stays editable
    addHandles();
    render();
  }

  // --- editing --------------------------------------------------------------

  function handleIcon() {
    return L.divIcon({
      className: '',
      html: '<div style="width:10px;height:10px;background:#ffcc00;border:1px solid #000;border-radius:2px;"></div>',
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    });
  }

  function addHandles() {
    removeHandles();
    if (!rect) return;
    const b = rect.getBounds();
    // corner order: SW, NW, NE, SE — each drags against the opposite corner
    const corners = [
      { lat: b.getSouth(), lng: b.getWest() },
      { lat: b.getNorth(), lng: b.getWest() },
      { lat: b.getNorth(), lng: b.getEast() },
      { lat: b.getSouth(), lng: b.getEast() },
    ];
    corners.forEach((c, i) => {
      const h = L.marker([c.lat, c.lng], { icon: handleIcon(), draggable: true, zIndexOffset: 1000 }).addTo(group);
      h.on('drag', () => {
        const opp = handles[(i + 2) % 4].getLatLng();
        const p = h.getLatLng();
        rect.setBounds([[opp.lat, opp.lng], [p.lat, p.lng]]);
        syncHandles(i);
        render();
      });
      h.on('dragend', () => { addHandles(); render(); });
      handles.push(h);
    });

    // dragging the rectangle body moves the whole box
    rect.off('mousedown');
    rect.on('mousedown', (e) => {
      if (armed) return;                      // arming a new box wins
      dragOrigin = { latlng: e.latlng, bounds: rect.getBounds() };
      map.dragging.disable();
      L.DomEvent.stopPropagation(e);
      map.on('mousemove', onBoxDrag);
      map.once('mouseup', () => {
        map.off('mousemove', onBoxDrag);
        map.dragging.enable();
        dragOrigin = null;
        addHandles();
      });
    });
  }

  function onBoxDrag(e) {
    if (!dragOrigin || !rect) return;
    const dLat = e.latlng.lat - dragOrigin.latlng.lat;
    const dLng = e.latlng.lng - dragOrigin.latlng.lng;
    const b = dragOrigin.bounds;
    rect.setBounds([
      [b.getSouth() + dLat, b.getWest() + dLng],
      [b.getNorth() + dLat, b.getEast() + dLng],
    ]);
    handles.forEach(h => map.removeLayer(h));
    handles = [];
    render();
  }

  // Keep the two neighbouring handles in sync while corner `i` is dragged.
  function syncHandles(i) {
    const b = rect.getBounds();
    const pos = [
      [b.getSouth(), b.getWest()],
      [b.getNorth(), b.getWest()],
      [b.getNorth(), b.getEast()],
      [b.getSouth(), b.getEast()],
    ];
    handles.forEach((h, j) => { if (j !== i) h.setLatLng(pos[j]); });
  }

  function removeHandles() {
    handles.forEach(h => group.removeLayer(h));
    handles = [];
  }

  function clearBox() {
    removeHandles();
    if (rect) { group.removeLayer(rect); rect = null; }
  }

  function clear() {
    clearBox();
    render();
  }

  // --- stats ----------------------------------------------------------------

  function compute() {
    const data = Layers.getResourceData();
    if (!data || !rect) return null;

    const b = rect.getBounds();
    const minX = b.getWest(), maxX = b.getEast();
    const minZ = b.getSouth(), maxZ = b.getNorth();
    const excluded = Layers.getExcludedPatches();
    const accessList = Layers.getRefAccessData('Sol');
    const refAccess = {};
    if (accessList) accessList.forEach(a => { refAccess[a.idx] = a; });

    const out = {
      minX, maxX, minZ, maxZ,
      w: maxX - minX,
      h: maxZ - minZ,
      Balterium: { count: 0, total: 0, idx: [], excluded: 0, noRefinery: 0 },
      Biotics: { count: 0, total: 0, idx: [], excluded: 0, noRefinery: 0 },
      mapTotal: { Balterium: 0, Biotics: 0 },
    };

    data.resources.forEach(res => {
      const bucket = out[res.type];
      if (!bucket) return;
      const amount = Layers.getPatchAmount(res);
      if (!excluded.has(res.idx)) out.mapTotal[res.type] += amount;

      if (res.x < minX || res.x > maxX || res.z < minZ || res.z > maxZ) return;
      if (excluded.has(res.idx)) { bucket.excluded++; return; }

      bucket.count++;
      bucket.total += amount;
      bucket.idx.push(res.idx);
      if (refAccess && refAccess[res.idx] && refAccess[res.idx].accessible === false) bucket.noRefinery++;
    });

    return out;
  }

  // --- panel ----------------------------------------------------------------

  const fmt = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : `${n}`);

  function render() {
    const panel = document.getElementById('measure-panel');
    if (!panel) return;

    const s = compute();
    if (!s) {
      panel.innerHTML = armed
        ? '<span style="color:#ffcc00;">Drag on the map to draw a box.</span>'
        : 'No box. Click <b>Measure Box</b>, then drag on the map.';
      return;
    }

    const pct = (v, tot) => (tot > 0 ? `${(100 * v / tot).toFixed(1)}%` : '-');
    const area = (s.w * s.h) / 1e6;
    const rows = [];

    for (const [type, color] of [['Balterium', '#ffffff'], ['Biotics', '#9b30ff']]) {
      const d = s[type];
      const notes = [];
      if (d.excluded) notes.push(`${d.excluded} excluded`);
      if (d.noRefinery) notes.push(`${d.noRefinery} no refinery spot`);
      rows.push(
        `<div style="margin-top:4px;">` +
        `<span style="color:${color};font-weight:600;">${type}</span>: ` +
        `<span style="color:#fff;">${d.count}</span> patches · ` +
        `<span style="color:#fff;">${fmt(d.total)}</span> ` +
        `<span style="color:#667;">(${pct(d.total, s.mapTotal[type])} of map)</span>` +
        (notes.length ? `<div style="color:#c8963c;">${notes.join(' · ')}</div>` : '') +
        (d.idx.length ? `<div style="color:#667;word-break:break-all;">idx: ${d.idx.join(', ')}</div>` : '') +
        `</div>`
      );
    }

    panel.innerHTML =
      `<div style="color:#ffcc00;">X ${s.minX.toFixed(0)} … ${s.maxX.toFixed(0)} · ` +
      `Z ${s.minZ.toFixed(0)} … ${s.maxZ.toFixed(0)}</div>` +
      `<div style="color:#667;">${s.w.toFixed(0)} × ${s.h.toFixed(0)} m · ${area.toFixed(2)} km²</div>` +
      rows.join('') +
      `<div style="color:#556;margin-top:6px;">Drag corners to resize, box body to move.</div>`;
  }

  // Called by layers.js whenever amounts/exclusions change so the box stays current.
  function refresh() { render(); }

  return { init, arm, disarm, toggle, clear, refresh, isArmed: () => armed };
})();
