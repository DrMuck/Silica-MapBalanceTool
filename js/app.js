/**
 * app.js - Main application: Leaflet map init, map loading, coordination
 */

const App = (() => {
  let map = null;
  let currentMap = null;
  let baseLayer = null;

  async function init() {
    // Init Leaflet map with Simple CRS (flat coordinate system)
    map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -3,
      maxZoom: 3,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      attributionControl: false,
    });

    // Populate map selector
    const selector = document.getElementById('map-selector');
    for (const mapName of Object.keys(MAP_CONFIG)) {
      const opt = document.createElement('option');
      opt.value = mapName;
      opt.textContent = mapName;
      selector.appendChild(opt);
    }
    selector.addEventListener('change', () => loadMap(selector.value));

    // Cursor coordinate display
    map.on('mousemove', (e) => {
      const x = e.latlng.lng.toFixed(0);
      const z = e.latlng.lat.toFixed(0);
      document.getElementById('coords-bar').textContent = `X: ${x}  Z: ${z}`;
    });

    // Init modules
    Placement.init(map);
    Expansion.init(map);
    UI.init();

    // Setup layer toggles
    setupLayerToggles();

    // Load first map
    const firstMap = Object.keys(MAP_CONFIG)[0];
    selector.value = firstMap;
    await loadMap(firstMap);
  }

  async function loadMap(mapName) {
    if (!MAP_CONFIG[mapName]) return;

    currentMap = mapName;
    const cfg = MAP_CONFIG[mapName];
    const extent = cfg.extent;
    // For variants (e.g. NorthPolarCap_40K), use base map's image/masks
    const assetMap = cfg.base_map || mapName;

    // Clear existing layers
    Placement.clearAll();
    if (baseLayer) map.removeLayer(baseLayer);
    if (Layers.gridLayer) map.removeLayer(Layers.gridLayer);
    if (Layers.balteriumLayer) map.removeLayer(Layers.balteriumLayer);
    if (Layers.bioticsLayer) map.removeLayer(Layers.bioticsLayer);
    for (const f of ['Sol', 'Cent']) {
      if (Layers.hqMaskLayers[f]) map.removeLayer(Layers.hqMaskLayers[f]);
      if (Layers.refMaskLayers[f]) map.removeLayer(Layers.refMaskLayers[f]);
    }
    if (Layers.refAccessLayer) map.removeLayer(Layers.refAccessLayer);
    if (Layers.noBuildLayer) map.removeLayer(Layers.noBuildLayer);

    // Map bounds: [[south, west], [north, east]] = [[minZ, minX], [maxZ, maxX]]
    const bounds = [[-extent, -extent], [extent, extent]];

    // Base map image (use assetMap for variants)
    baseLayer = L.imageOverlay(`data/maps/${assetMap}.jpg`, bounds).addTo(map);
    map.fitBounds(bounds);

    // Grid
    Layers.gridLayer = Layers.createGridLayer(map, extent);
    if (document.getElementById('layer-grid').checked) {
      Layers.gridLayer.addTo(map);
    }

    // Resources — use mapName (variants have their own resource JSON)
    const resLayers = await Layers.loadResources(mapName);
    Layers.balteriumLayer = resLayers.balterium;
    Layers.bioticsLayer = resLayers.biotics;
    if (document.getElementById('layer-balterium').checked) {
      Layers.balteriumLayer.addTo(map);
    }
    if (document.getElementById('layer-biotics').checked) {
      Layers.bioticsLayer.addTo(map);
    }

    // No-build zones
    if (document.getElementById('layer-nobuild').checked) {
      Layers.noBuildLayer.addTo(map);
    }

    // Collect resource markers from both layers for expansion coloring
    const markers = [];
    Layers.balteriumLayer.eachLayer(m => {
      if (m._resData) markers.push(m);
    });
    Layers.bioticsLayer.eachLayer(m => {
      if (m._resData) markers.push(m);
    });
    Expansion.setResourceMarkers(markers);

    // HQ masks (use assetMap for variants)
    for (const faction of ['Sol', 'Cent']) {
      Layers.hqMaskLayers[faction] = Layers.loadMaskOverlay('hq', faction, assetMap, cfg);
      const checkId = `layer-hq-${faction.toLowerCase()}`;
      if (document.getElementById(checkId).checked) {
        Layers.hqMaskLayers[faction].addTo(map);
      }
    }

    // Refinery masks (use assetMap for variants)
    for (const faction of ['Sol', 'Cent']) {
      Layers.refMaskLayers[faction] = Layers.loadMaskOverlay('ref', faction, assetMap, cfg);
      const checkId = `layer-ref-${faction.toLowerCase()}`;
      if (document.getElementById(checkId).checked) {
        Layers.refMaskLayers[faction].addTo(map);
      }
    }

    // Ramp grids for footprint ramp indicators (use assetMap for variants)
    for (const faction of ['Sol', 'Cent']) {
      Layers.loadRampGrid(faction, assetMap, cfg);
    }

    // Refinery accessibility (use assetMap for variants)
    await Layers.loadRefAccess('Sol', assetMap);
    await Layers.loadRefAccess('Cent', assetMap);
    const resData = Layers.getResourceData();
    if (resData) {
      Layers.refAccessLayer = Layers.createRefAccessLayer(resData.resources, 'Sol');
      if (document.getElementById('layer-ref-access').checked) {
        Layers.refAccessLayer.addTo(map);
      }
    }
  }

  function setupLayerToggles() {
    const toggles = {
      'layer-grid': () => Layers.gridLayer,
      'layer-balterium': () => Layers.balteriumLayer,
      'layer-biotics': () => Layers.bioticsLayer,
      'layer-hq-sol': () => Layers.hqMaskLayers.Sol,
      'layer-hq-cent': () => Layers.hqMaskLayers.Cent,
      'layer-ref-sol': () => Layers.refMaskLayers.Sol,
      'layer-ref-cent': () => Layers.refMaskLayers.Cent,
      'layer-ref-access': () => Layers.refAccessLayer,
      'layer-nobuild': () => Layers.noBuildLayer,
    };

    for (const [id, getLayer] of Object.entries(toggles)) {
      document.getElementById(id).addEventListener('change', (e) => {
        const layer = getLayer();
        if (!layer) return;
        if (e.target.checked) {
          layer.addTo(map);
        } else {
          map.removeLayer(layer);
        }
      });
    }
  }

  function getCurrentMap() { return currentMap; }
  function getMap() { return map; }

  // Boot
  document.addEventListener('DOMContentLoaded', init);

  return { getCurrentMap, getMap, loadMap };
})();
