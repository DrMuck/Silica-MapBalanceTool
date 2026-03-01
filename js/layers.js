/**
 * layers.js - Load and manage data layers (resources, masks, refinery access)
 */

const Layers = (() => {
  // Layer groups
  let gridLayer = null;
  let balteriumLayer = null;
  let bioticsLayer = null;
  let hqMaskLayers = { Sol: null, Cent: null };
  let refMaskLayers = { Sol: null, Cent: null };
  let refAccessLayer = null;
  let noBuildLayer = null;

  // Loaded data
  let resourceData = null;
  let refAccessData = { Sol: null, Cent: null };

  // Mask canvases for placement validation
  let maskCanvases = {};

  // Ramp grid canvases (per-position ramp accessibility for footprint tool)
  let rampGridCanvases = {};

  // Excluded patches (marked for deletion in-game)
  let excludedPatches = new Set();

  // Resource amount overrides (from sliders)
  let baltAmountOverride = 40000;
  let bioAmountOverride = 42000;

  // Per-patch amount overrides (idx → amount)
  let patchAmountOverrides = {};

  // Label markers (for updating when amounts change)
  let labelMarkers = []; // {marker, res, group}

  function createGridLayer(map, extent) {
    const group = L.layerGroup();
    const step = extent >= 2000 ? 500 : 250;

    for (let v = -extent; v <= extent; v += step) {
      if (v === 0) continue;
      // Horizontal line (constant Z)
      L.polyline([[v, -extent], [v, extent]], {
        color: 'rgba(255,255,255,0.08)',
        weight: 1,
      }).addTo(group);
      // Vertical line (constant X)
      L.polyline([[-extent, v], [extent, v]], {
        color: 'rgba(255,255,255,0.08)',
        weight: 1,
      }).addTo(group);
    }

    // Axis lines (X=0 and Z=0) brighter
    L.polyline([[0, -extent], [0, extent]], {
      color: 'rgba(255,255,255,0.2)',
      weight: 1,
    }).addTo(group);
    L.polyline([[-extent, 0], [extent, 0]], {
      color: 'rgba(255,255,255,0.2)',
      weight: 1,
    }).addTo(group);

    // Grid labels
    for (let v = -extent; v <= extent; v += step) {
      // Z-axis labels (left side)
      const zLabel = L.divIcon({
        className: 'grid-label',
        html: `${v}`,
        iconSize: [40, 12],
        iconAnchor: [42, 6],
      });
      L.marker([v, -extent + 10], { icon: zLabel, interactive: false }).addTo(group);

      // X-axis labels (bottom)
      const xLabel = L.divIcon({
        className: 'grid-label',
        html: `${v}`,
        iconSize: [40, 12],
        iconAnchor: [20, -2],
      });
      L.marker([-extent + 10, v], { icon: xLabel, interactive: false }).addTo(group);
    }

    return group;
  }

  const ICON_SIZE = 22;

  function buildResourceIcon(res, color, isExcluded) {
    const isBalt = res.type === 'Balterium';
    const src = `data/icons/${isBalt ? 'balterium' : 'biotics'}.png`;

    let filter = isBalt ? 'invert(1) ' : '';
    if (isExcluded) {
      filter = 'brightness(0.3) saturate(0) drop-shadow(0 0 2px #ff4444)';
    } else {
      filter += `drop-shadow(0 0 2px ${color}) drop-shadow(0 0 4px ${color})`;
    }

    return L.divIcon({
      className: '',
      html: `<img src="${src}" style="width:${ICON_SIZE}px;height:${ICON_SIZE}px;filter:${filter};" />`,
      iconSize: [ICON_SIZE, ICON_SIZE],
      iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
    });
  }

  function updateResourceMarkerIcon(marker, color, isExcluded) {
    const res = marker._resData;
    if (!res) return;
    marker._resColor = color;
    marker.setIcon(buildResourceIcon(res, color, isExcluded));
  }

  async function loadResources(mapName) {
    const resp = await fetch(`data/resources/${mapName}.json`);
    resourceData = await resp.json();

    // Reset state when loading new map
    excludedPatches = new Set();
    patchAmountOverrides = {};
    labelMarkers = [];

    const baltGroup = L.layerGroup();
    const bioGroup = L.layerGroup();

    const extent = resourceData.extent || Infinity;

    resourceData.resources.forEach(res => {
      // Clip resources outside map bounds
      if (Math.abs(res.x) > extent || Math.abs(res.z) > extent) return;

      const isBalt = res.type === 'Balterium';
      const defaultColor = isBalt ? '#ffffff' : '#9b30ff';

      const icon = buildResourceIcon(res, defaultColor, false);
      const marker = L.marker([res.z, res.x], { icon });

      // Store resource data on marker for expansion analysis
      marker._resData = res;
      marker._resColor = defaultColor;

      const group = isBalt ? baltGroup : bioGroup;
      group.addLayer(marker);

      // Right-click to toggle exclusion
      marker.on('contextmenu', (e) => {
        L.DomEvent.stopPropagation(e);
        toggleExcluded(res.idx);
      });

      // Resource amount label
      const displayAmount = getPatchAmount(res);
      if (displayAmount > 0) {
        const amountText = formatAmountLabel(displayAmount);
        const labelIcon = L.divIcon({
          className: '',
          html: `<span style="font-size:8px;color:${defaultColor};text-shadow:0 0 3px #000, 0 0 3px #000;">${amountText}</span>`,
          iconSize: [30, 10],
          iconAnchor: [15, -6],
        });
        const labelMkr = L.marker([res.z, res.x], { icon: labelIcon, interactive: false });
        group.addLayer(labelMkr);
        labelMarkers.push({ marker: labelMkr, res, group, circleMarker: marker });
      }

      updatePopup(marker, res);
    });

    // Build no-build zone rectangles from resource extents
    const noBuildGroup = L.layerGroup();
    resourceData.resources.forEach(res => {
      if (Math.abs(res.x) > extent || Math.abs(res.z) > extent) return;
      if (!res.world_w || !res.world_h) return;

      const halfW = res.world_w / 2;
      const halfH = res.world_h / 2;
      // Leaflet: [lat, lng] = [Z, X]
      const bounds = [
        [res.z - halfH, res.x - halfW],
        [res.z + halfH, res.x + halfW],
      ];

      const isBalt = res.type === 'Balterium';
      const color = isBalt ? '#ff8800' : '#cc44ff';

      L.rectangle(bounds, {
        color: color,
        fillColor: color,
        fillOpacity: 0.1,
        weight: 1.5,
        opacity: 0.5,
        dashArray: '6,3',
        interactive: false,
      }).addTo(noBuildGroup);
    });
    noBuildLayer = noBuildGroup;

    updateResourceTotals();
    return { balterium: baltGroup, biotics: bioGroup };
  }

  function formatAmountLabel(amount) {
    if (amount >= 1000) return `${(amount / 1000).toFixed(0)}K`;
    return `${amount}`;
  }

  function getPatchAmount(res) {
    if (patchAmountOverrides[res.idx] !== undefined) return patchAmountOverrides[res.idx];
    const isBalt = res.type === 'Balterium';
    const globalAmount = isBalt ? baltAmountOverride : bioAmountOverride;
    return globalAmount > 0 ? globalAmount : (res.resources_max || 0);
  }

  function setPatchAmount(idx, amount) {
    patchAmountOverrides[idx] = amount;
    refreshLabels();
    Expansion.update();
  }

  function clearPatchOverride(idx) {
    delete patchAmountOverrides[idx];
    refreshLabels();
    Expansion.update();
  }

  function setPatchOverrides(obj) {
    patchAmountOverrides = {};
    for (const [k, v] of Object.entries(obj || {})) {
      patchAmountOverrides[parseInt(k)] = v;
    }
    refreshLabels();
    Expansion.update();
  }

  function getPatchOverrides() {
    return Object.keys(patchAmountOverrides).length > 0 ? { ...patchAmountOverrides } : {};
  }

  function setExcludedPatches(patchSet) {
    excludedPatches = patchSet;
    refreshExcludedVisuals();
    Expansion.update();
  }

  function updatePopup(marker, res) {
    const isExcluded = excludedPatches.has(res.idx);
    const displayAmount = getPatchAmount(res);
    const hasOverride = patchAmountOverrides[res.idx] !== undefined;
    const excludedTag = isExcluded ? '<br><b style="color:#ff4444;">EXCLUDED</b>' : '';
    const overrideTag = hasOverride ? ' <span style="color:#ffcc00;font-size:10px;">(custom)</span>' : '';

    const popupContent = document.createElement('div');
    popupContent.innerHTML =
      `<b>#${res.idx}</b> ${res.type}<br>` +
      `Active: ${res.active}<br>` +
      `Pos: (${res.x.toFixed(0)}, ${res.z.toFixed(0)})<br>` +
      `Grid: ${res.grid_w}x${res.grid_h} @ ${res.cell_size}m<br>` +
      `Extent: ${res.world_w}x${res.world_h}m<br>` +
      `<div style="margin-top:4px;">Amount${overrideTag}: ` +
      `<input type="number" class="patch-amount-input" value="${displayAmount}" min="0" max="200000" step="1000" style="width:70px;background:#1a1a2e;color:#fff;border:1px solid #444;padding:2px 4px;font-size:11px;">` +
      `${hasOverride ? ' <button class="patch-reset-btn" style="background:#333;color:#ff8800;border:1px solid #555;padding:1px 6px;font-size:10px;cursor:pointer;">Reset</button>' : ''}` +
      `</div>` +
      excludedTag;

    // Wire up events after popup opens
    marker.bindPopup(popupContent);
    marker.off('popupopen.patchedit');
    marker.on('popupopen.patchedit', () => {
      const input = popupContent.querySelector('.patch-amount-input');
      const resetBtn = popupContent.querySelector('.patch-reset-btn');
      if (input) {
        input.addEventListener('change', () => {
          const val = parseInt(input.value);
          if (!isNaN(val) && val >= 0) {
            setPatchAmount(res.idx, val);
            updatePopup(marker, res);
          }
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') input.blur();
        });
      }
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          clearPatchOverride(res.idx);
          updatePopup(marker, res);
          marker.openPopup();
        });
      }
    });
  }

  function toggleExcluded(idx) {
    if (excludedPatches.has(idx)) {
      excludedPatches.delete(idx);
    } else {
      excludedPatches.add(idx);
    }
    refreshExcludedVisuals();
    Expansion.update();
  }

  function refreshExcludedVisuals() {
    // Update resource icon markers for excluded state
    const allMarkers = [];
    if (balteriumLayer) balteriumLayer.eachLayer(m => { if (m._resData) allMarkers.push(m); });
    if (bioticsLayer) bioticsLayer.eachLayer(m => { if (m._resData) allMarkers.push(m); });

    allMarkers.forEach(marker => {
      const res = marker._resData;
      if (!res) return;
      const isExcluded = excludedPatches.has(res.idx);
      const isBalt = res.type === 'Balterium';
      const baseColor = marker._resColor || (isBalt ? '#ffffff' : '#9b30ff');

      updateResourceMarkerIcon(marker, baseColor, isExcluded);
      updatePopup(marker, res);
    });

    // Update label visibility for excluded patches
    labelMarkers.forEach(({ marker, res, group }) => {
      const isExcluded = excludedPatches.has(res.idx);
      if (isExcluded) {
        group.removeLayer(marker);
      } else {
        group.addLayer(marker);
      }
    });
    updateResourceTotals();
  }

  function setResourceAmounts(baltAmount, bioAmount) {
    baltAmountOverride = baltAmount;
    bioAmountOverride = bioAmount;
    refreshLabels();
    Expansion.update();
  }

  function refreshLabels() {
    labelMarkers.forEach(({ marker, res, group }) => {
      const isBalt = res.type === 'Balterium';
      const baseColor = isBalt ? '#ffffff' : '#9b30ff';
      const hasOverride = patchAmountOverrides[res.idx] !== undefined;
      const displayAmount = getPatchAmount(res);
      const amountText = formatAmountLabel(displayAmount);
      const labelColor = hasOverride ? '#ffcc00' : baseColor;

      const labelIcon = L.divIcon({
        className: '',
        html: `<span style="font-size:8px;color:${labelColor};text-shadow:0 0 3px #000, 0 0 3px #000;">${amountText}</span>`,
        iconSize: [30, 10],
        iconAnchor: [15, -6],
      });
      marker.setIcon(labelIcon);

      // Also update popup on the circle marker
      const allCircles = [];
      if (balteriumLayer) balteriumLayer.eachLayer(m => { if (m._resData && m._resData.idx === res.idx) allCircles.push(m); });
      if (bioticsLayer) bioticsLayer.eachLayer(m => { if (m._resData && m._resData.idx === res.idx) allCircles.push(m); });
      allCircles.forEach(cm => updatePopup(cm, res));
    });
    updateResourceTotals();
  }

  function getExcludedPatches() { return excludedPatches; }
  function getResourceAmounts() { return { balterium: baltAmountOverride, biotics: bioAmountOverride }; }

  function updateResourceTotals() {
    const el = document.getElementById('resource-totals');
    if (!el || !resourceData) { if (el) el.textContent = ''; return; }

    let baltTotal = 0, baltCount = 0, bioTotal = 0, bioCount = 0;
    const extent = resourceData.extent || Infinity;
    resourceData.resources.forEach(res => {
      if (Math.abs(res.x) > extent || Math.abs(res.z) > extent) return;
      if (excludedPatches.has(res.idx)) return;
      const amount = getPatchAmount(res);
      if (res.type === 'Balterium') { baltTotal += amount; baltCount++; }
      else { bioTotal += amount; bioCount++; }
    });

    const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
    el.innerHTML = `Total: <span style="color:#fff;">${fmt(baltTotal)}</span> Balt (${baltCount}p) · <span style="color:#9b30ff;">${fmt(bioTotal)}</span> Bio (${bioCount}p)`;
  }

  function loadMaskOverlay(type, faction, mapName, cfg) {
    const url = `data/masks/${type}_${faction}_${mapName}.png`;
    const minX = cfg.scan_min_x || -cfg.extent;
    const maxX = cfg.scan_max_x || cfg.extent;
    const minZ = cfg.scan_min_z || -cfg.extent;
    const maxZ = cfg.scan_max_z || cfg.extent;

    // Leaflet bounds: [[south, west], [north, east]] = [[minZ, minX], [maxZ, maxX]]
    const bounds = [[minZ, minX], [maxZ, maxX]];

    const overlay = L.imageOverlay(url, bounds, {
      opacity: 0.6,
      interactive: false,
    });

    // Also load into hidden canvas for pixel-level queries
    loadMaskCanvas(`${type}_${faction}_${mapName}`, url, cfg);

    return overlay;
  }

  function loadMaskCanvas(key, url, cfg) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      maskCanvases[key] = { canvas, ctx, width: img.width, height: img.height, cfg };
    };
    img.src = url;
  }

  function isValidPlacement(type, faction, mapName, worldX, worldZ) {
    const key = `${type}_${faction}_${mapName}`;
    const data = maskCanvases[key];
    if (!data) return true; // Not loaded yet, allow placement

    const cfg = data.cfg;
    const step = cfg.scan_step || 15;
    const minX = cfg.scan_min_x || -cfg.extent;
    const maxZ = cfg.scan_max_z || cfg.extent;

    const px = Math.round((worldX - minX) / step);
    const py = Math.round((maxZ - worldZ) / step); // flip Z

    if (px < 0 || px >= data.width || py < 0 || py >= data.height) return false;

    const pixel = data.ctx.getImageData(px, py, 1, 1).data;
    return pixel[3] > 50; // any non-transparent = valid
  }

  async function loadRefAccess(faction, mapName) {
    try {
      const resp = await fetch(`data/refineries/ref_access_${faction}_${mapName}.json`);
      refAccessData[faction] = await resp.json();
    } catch (e) {
      refAccessData[faction] = null;
    }
  }

  function createRefAccessLayer(resources, faction) {
    const group = L.layerGroup();
    const accessData = refAccessData[faction];
    if (!accessData || !resources) return group;

    resources.forEach(res => {
      const access = accessData.find(a => a.idx === res.idx);
      if (!access) return;

      const accessible = access.accessible;
      const icon = L.divIcon({
        className: '',
        html: accessible
          ? '<div style="width:8px;height:8px;background:#00ff00;border-radius:50%;border:1px solid #006600;"></div>'
          : '<div style="width:8px;height:8px;color:#ff0000;font-size:10px;font-weight:bold;line-height:8px;text-align:center;">X</div>',
        iconSize: [8, 8],
        iconAnchor: [4, 4],
      });

      const marker = L.marker([res.z + 15, res.x + 15], {
        icon: icon,
        interactive: false,
      });

      // Add ramp direction arrow if accessible
      if (accessible && access.best) {
        const b = access.best;
        const arrowLen = 60;
        const startLat = b.ref_z;
        const startLng = b.ref_x;

        // Snap ramp direction to nearest cardinal axis (ramps only face N/S/E/W)
        const absX = Math.abs(b.ramp_dirX);
        const absZ = Math.abs(b.ramp_dirZ);
        const dirX = absX > absZ ? Math.sign(b.ramp_dirX) : 0;
        const dirZ = absX > absZ ? 0 : Math.sign(b.ramp_dirZ);

        const endLat = startLat + dirZ * arrowLen;
        const endLng = startLng + dirX * arrowLen;

        L.polyline([[startLat, startLng], [endLat, endLng]], {
          color: '#00cc00',
          weight: 1.5,
          opacity: 0.5,
          dashArray: '4,4',
        }).addTo(group);
      }

      group.addLayer(marker);
    });

    return group;
  }

  function loadRampGrid(faction, mapName, cfg) {
    const key = `ramp_${faction}_${mapName}`;
    const url = `data/ramps/ramp_grid_${faction}_${mapName}.png`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      rampGridCanvases[key] = { ctx, width: img.width, height: img.height, cfg };
    };
    img.src = url;
  }

  function getRampFlags(faction, mapName, worldX, worldZ) {
    const key = `ramp_${faction}_${mapName}`;
    const data = rampGridCanvases[key];
    if (!data) return null; // Not loaded yet

    const cfg = data.cfg;
    const step = cfg.scan_step || 15;
    const minX = cfg.scan_min_x || -cfg.extent;
    const maxZ = cfg.scan_max_z || cfg.extent;

    const px = Math.round((worldX - minX) / step);
    const py = Math.round((maxZ - worldZ) / step);

    if (px < 0 || px >= data.width || py < 0 || py >= data.height) return 0;

    const pixel = data.ctx.getImageData(px, py, 1, 1).data;
    return pixel[0]; // Grayscale value = 8-bit ramp flags
  }

  function getResourceData() { return resourceData; }
  function getRefAccessData(faction) { return refAccessData[faction]; }

  return {
    createGridLayer,
    loadResources,
    loadMaskOverlay,
    loadMaskCanvas,
    isValidPlacement,
    loadRefAccess,
    createRefAccessLayer,
    loadRampGrid,
    getRampFlags,
    getResourceData,
    getRefAccessData,
    setResourceAmounts,
    getExcludedPatches,
    setExcludedPatches,
    getResourceAmounts,
    refreshExcludedVisuals,
    updateResourceMarkerIcon,
    getPatchAmount,
    setPatchAmount,
    clearPatchOverride,
    setPatchOverrides,
    getPatchOverrides,

    // Expose for app.js to manage
    get gridLayer() { return gridLayer; },
    set gridLayer(v) { gridLayer = v; },
    get balteriumLayer() { return balteriumLayer; },
    set balteriumLayer(v) { balteriumLayer = v; },
    get bioticsLayer() { return bioticsLayer; },
    set bioticsLayer(v) { bioticsLayer = v; },
    hqMaskLayers,
    refMaskLayers,
    get refAccessLayer() { return refAccessLayer; },
    set refAccessLayer(v) { refAccessLayer = v; },
    get noBuildLayer() { return noBuildLayer; },
    set noBuildLayer(v) { noBuildLayer = v; },
  };
})();
