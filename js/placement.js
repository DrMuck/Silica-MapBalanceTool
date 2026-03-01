/**
 * placement.js - Interactive HQ spawn placement with radius circles
 */

const Placement = (() => {
  const GRID_SNAP = 15;
  const CIRCLE_SEGMENTS = 64;

  // Create a polygon circle that works correctly in CRS.Simple
  function createCircle(center, radius, options) {
    const points = [];
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
      const angle = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
      points.push([
        center.lat + radius * Math.sin(angle),
        center.lng + radius * Math.cos(angle),
      ]);
    }
    return L.polygon(points, options);
  }

  function updateCirclePosition(polygon, center, radius) {
    const points = [];
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
      const angle = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
      points.push([
        center.lat + radius * Math.sin(angle),
        center.lng + radius * Math.cos(angle),
      ]);
    }
    polygon.setLatLngs(points);
  }

  // State
  let placementMode = null; // 'sol-hq', 'cent-hq', 'alien-nest', 'alien-biocache', 'sol-expand', 'cent-expand', 'alien-expand'
  let hqs = {
    Sol: [],  // [{marker, buildCircle, chainCircle, latlng, isSpawn}]
    Cent: [],
    Alien: [],
  };
  let chainLines = { Sol: [], Cent: [], Alien: [] };

  // Settings (updated by UI)
  let buildRadius = 550;
  let chainRange = 1300;
  let alienNodeRadius = 150;
  let alienBiocacheRadius = 150;
  const ALIEN_CHAIN_RANGE = 400;

  // Structure footprint definitions (from scan AboveGroundPoints, meters)
  //
  // Ramp data encoding (8 bits in ramp grid PNG):
  //   bit 0: rampA@rot0,   bit 1: rampB@rot0
  //   bit 2: rampA@rot90,  bit 3: rampB@rot90
  //   bit 4: rampA@rot180, bit 5: rampB@rot180
  //   bit 6: rampA@rot270, bit 7: rampB@rot270
  //
  // rampSide: which dimension has ramps at rot=0 ('h' for Sol=Z edges, 'w' for Cent=X edges)
  // rampMapping: bit indices for each edge per footprint orientation
  //   minus/plus refer to sign=-1/+1 edge in drawRampIndicators
  const FOOTPRINTS = {
    'sol-hq':     { w: 76,  h: 111, color: '#328cff', label: 'Sol HQ' },
    'cent-hq':    { w: 47,  h: 75,  color: '#eb4646', label: 'Cent HQ' },
    'sol-ref':    { w: 152, h: 96,  color: '#328cff', label: 'Sol Ref', hasRamps: true,
      rampSide: 'h', faction: 'Sol',
      // Ramp entry offset along the edge (from structure center)
      // Sol ramp entries at local (25.52, ±57): offset +25.52 in X at rot=0
      // unrotated (Z edges): lng offset = +25.52
      // rotated (X edges): lat offset = -25.52 (90° rotation: x→-z)
      rampEdgeOffset: { unrotated: 25.52, rotated: -25.52 },
      rampMapping: {
        unrotated: { minus: [0, 5], plus: [1, 4] },
        rotated: { minus: [2, 7], plus: [3, 6] },
      },
    },
    'cent-ref':   { w: 64,  h: 116, color: '#eb4646', label: 'Cent Ref', hasRamps: true,
      rampSide: 'w', faction: 'Cent',
      // Ramp entry offset along the edge (from structure center)
      // Cent ramp entries at local (±55, -34.20): offset -34.20 in Z at rot=0
      // unrotated (X edges): lat offset = -34.20
      // rotated (Z edges): lng offset = -34.20 (90° rotation: z→-x, but symmetric)
      rampEdgeOffset: { unrotated: -34.20, rotated: -34.20 },
      rampMapping: {
        unrotated: { minus: [0, 5], plus: [1, 4] },
        rotated: { minus: [3, 6], plus: [2, 7] },
      },
    },
    'alien-nest': { w: 50,  h: 50,  color: '#50c832', label: 'Nest' },
  };

  // Footprint state
  let footprints = []; // [{marker, rect, type, rotated, w, h}]
  let footprintRotated = false;

  // Layer group for all placement visuals
  let placementGroup = null;

  function init(map) {
    placementGroup = L.layerGroup().addTo(map);

    map.on('click', (e) => {
      if (!placementMode) return;
      handleMapClick(e.latlng, map);
    });
  }

  function snapToGrid(latlng) {
    return L.latLng(
      Math.round(latlng.lat / GRID_SNAP) * GRID_SNAP,
      Math.round(latlng.lng / GRID_SNAP) * GRID_SNAP
    );
  }

  function handleMapClick(latlng, map) {
    const snapped = snapToGrid(latlng);
    const worldX = snapped.lng;
    const worldZ = snapped.lat;

    // Footprint placement
    if (placementMode && placementMode.startsWith('fp-')) {
      placeFootprint(placementMode.slice(3), snapped);
      return;
    }

    const faction = placementMode.startsWith('sol') ? 'Sol'
      : placementMode.startsWith('cent') ? 'Cent' : 'Alien';
    const isExpansion = placementMode.includes('expand') || placementMode === 'alien-biocache';
    const isBiocache = placementMode === 'alien-biocache';
    const mapName = App.getCurrentMap();

    // Validate placement against HQ mask (skip for aliens — they place anywhere)
    const restrictToZones = document.getElementById('setting-restrict-hq').checked;
    if (restrictToZones && faction !== 'Alien') {
      if (!Layers.isValidPlacement('hq', faction, mapName, worldX, worldZ)) {
        showPlacementError(snapped, 'Invalid HQ zone');
        return;
      }
    }

    // Expansion/biocache must be within chain range of existing HQ/nest
    if (isExpansion) {
      const parent = findParentHQ(faction, snapped);
      if (!parent) {
        showPlacementError(snapped, 'Out of chain range');
        return;
      }
    }

    // Place HQ/nest/biocache
    const isSpawn = !isExpansion && hqs[faction].length === 0;
    addHQ(faction, snapped, isSpawn, map, isBiocache);

    // Exit placement mode after placing spawn HQ/nest
    if (!isExpansion) {
      setPlacementMode(null);
    }
  }

  function showPlacementError(latlng, msg) {
    const icon = L.divIcon({
      className: '',
      html: `<div style="color:#ff4444;font-size:11px;font-weight:bold;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000;">${msg}</div>`,
      iconSize: [100, 16],
      iconAnchor: [50, 20],
    });
    const marker = L.marker(latlng, { icon, interactive: false }).addTo(placementGroup);
    setTimeout(() => placementGroup.removeLayer(marker), 1500);
  }

  function findParentHQ(faction, latlng) {
    let bestParent = null;
    let bestDist = Infinity;
    const range = faction === 'Alien' ? ALIEN_CHAIN_RANGE : chainRange;

    for (const hq of hqs[faction]) {
      const worldDist = Math.sqrt(
        Math.pow(latlng.lat - hq.latlng.lat, 2) +
        Math.pow(latlng.lng - hq.latlng.lng, 2)
      );
      if (worldDist <= range && worldDist < bestDist) {
        bestDist = worldDist;
        bestParent = hq;
      }
    }
    return bestParent;
  }

  // Faction colors: Sol=blue, Cent=red, Alien=green
  function getFactionColor(faction) {
    if (faction === 'Sol') return '#328cff';
    if (faction === 'Cent') return '#eb4646';
    return '#50c832';
  }

  function addHQ(faction, latlng, isSpawn, map, isBiocache) {
    const fKey = faction === 'Sol' ? 'sol' : faction === 'Cent' ? 'cent' : 'alien';

    let markerClass;
    let iconSize;
    if (isBiocache) {
      markerClass = 'biocache-marker';
      iconSize = [12, 12];
    } else if (isSpawn) {
      markerClass = `hq-marker hq-marker-${fKey}`;
      iconSize = [20, 20];
    } else {
      markerClass = `expansion-marker expansion-marker-${fKey}`;
      iconSize = [14, 14];
    }

    const icon = L.divIcon({
      className: markerClass,
      iconSize: iconSize,
    });

    const marker = L.marker(latlng, {
      icon: icon,
      draggable: true,
      zIndexOffset: isSpawn ? 1000 : 500,
    }).addTo(placementGroup);

    // Build radius circle (polygon-based for correct CRS.Simple rendering)
    const buildColor = getFactionColor(faction);
    const bR = faction === 'Alien' ? (isBiocache ? alienBiocacheRadius : alienNodeRadius) : buildRadius;
    const cR = faction === 'Alien' ? ALIEN_CHAIN_RANGE : chainRange;

    const buildCircle = createCircle(latlng, bR, {
      color: buildColor,
      fillColor: buildColor,
      fillOpacity: 0.08,
      weight: 2,
      opacity: 0.6,
    }).addTo(placementGroup);

    // Chain range circle (dashed) — skip for biocaches
    let chainCircle = null;
    if (!isBiocache) {
      chainCircle = createCircle(latlng, cR, {
        color: buildColor,
        fillColor: 'transparent',
        fillOpacity: 0,
        weight: 2,
        opacity: 0.6,
        dashArray: '8,8',
      }).addTo(placementGroup);
    }

    const hqEntry = { marker, buildCircle, chainCircle, latlng, isSpawn, faction, isBiocache };
    hqs[faction].push(hqEntry);

    // Label
    let label;
    if (isBiocache) {
      const bioIdx = hqs[faction].filter(h => h.isBiocache).length;
      label = `BC${bioIdx}`;
    } else if (isSpawn) {
      label = faction === 'Alien' ? 'Nest' : 'HQ';
    } else {
      label = faction === 'Alien' ? `N${hqs[faction].length - 1}` : `E${hqs[faction].length - 1}`;
    }
    marker.bindTooltip(label, {
      permanent: true,
      direction: 'top',
      offset: [0, -10],
      className: 'grid-label',
    });

    // Drag handler
    marker.on('drag', (e) => {
      const newLatLng = snapToGrid(e.latlng);
      marker.setLatLng(newLatLng);
      hqEntry.latlng = newLatLng;
      const curBR = faction === 'Alien' ? (hqEntry.isBiocache ? alienBiocacheRadius : alienNodeRadius) : buildRadius;
      const curCR = faction === 'Alien' ? ALIEN_CHAIN_RANGE : chainRange;
      updateCirclePosition(buildCircle, newLatLng, curBR);
      if (chainCircle) updateCirclePosition(chainCircle, newLatLng, curCR);
      updateChainLines();
      Expansion.update();
    });

    marker.on('dragend', () => {
      updateChainLines();
      Expansion.update();
    });

    // Right-click to remove
    marker.on('contextmenu', () => {
      removeHQ(faction, hqEntry);
    });

    updateChainLines();
    Expansion.update();
  }

  function removeHQ(faction, hqEntry) {
    placementGroup.removeLayer(hqEntry.marker);
    placementGroup.removeLayer(hqEntry.buildCircle);
    if (hqEntry.chainCircle) placementGroup.removeLayer(hqEntry.chainCircle);
    hqs[faction] = hqs[faction].filter(h => h !== hqEntry);
    updateChainLines();
    Expansion.update();
  }

  function updateChainLines() {
    // Clear old lines
    for (const faction of ['Sol', 'Cent', 'Alien']) {
      chainLines[faction].forEach(l => placementGroup.removeLayer(l));
      chainLines[faction] = [];

      // Draw lines between HQs that are within chain range (skip biocaches)
      const color = getFactionColor(faction);
      const range = faction === 'Alien' ? ALIEN_CHAIN_RANGE : chainRange;
      const chainable = hqs[faction].filter(h => !h.isBiocache);
      for (let i = 0; i < chainable.length; i++) {
        for (let j = i + 1; j < chainable.length; j++) {
          const a = chainable[i].latlng;
          const b = chainable[j].latlng;
          const dist = Math.sqrt(Math.pow(a.lat - b.lat, 2) + Math.pow(a.lng - b.lng, 2));
          if (dist <= range) {
            const line = L.polyline([a, b], {
              color: color,
              weight: 2,
              opacity: 0.4,
              dashArray: '6,6',
            }).addTo(placementGroup);
            chainLines[faction].push(line);
          }
        }
      }
    }
  }

  function setPlacementMode(mode) {
    placementMode = mode;

    // Update button states
    document.querySelectorAll('.btn').forEach(b => b.classList.remove('btn-active'));
    if (mode) {
      const btnId = {
        'sol-hq': 'btn-place-sol',
        'cent-hq': 'btn-place-cent',
        'alien-nest': 'btn-place-alien',
        'alien-biocache': 'btn-place-biocache',
        'sol-expand': 'btn-expand-sol',
        'cent-expand': 'btn-expand-cent',
        'alien-expand': 'btn-expand-alien',
        'fp-sol-hq': 'btn-fp-sol-hq',
        'fp-cent-hq': 'btn-fp-cent-hq',
        'fp-sol-ref': 'btn-fp-sol-ref',
        'fp-cent-ref': 'btn-fp-cent-ref',
        'fp-alien-nest': 'btn-fp-alien-nest',
      }[mode];
      if (btnId) document.getElementById(btnId).classList.add('btn-active');
    }

    // Update cursor
    const mapEl = document.getElementById('map');
    mapEl.style.cursor = mode ? 'crosshair' : '';
  }

  // Draw ramp indicators on refinery footprint edges.
  // Uses ramp grid data to show which ramps are terrain-accessible at this position.
  function drawRampIndicators(latlng, entry) {
    const fp = FOOTPRINTS[entry.type];
    if (!fp || !fp.hasRamps) return [];

    // Determine which axis ramps are on:
    // rampSide='h': ramps on h-dimension (lat/Z when not rotated, lng/X when rotated)
    // rampSide='w': ramps on w-dimension (lng/X when not rotated, lat/Z when rotated)
    let rampOnLat;
    if (fp.rampSide === 'h') {
      rampOnLat = !entry.rotated;
    } else {
      rampOnLat = entry.rotated;
    }

    // Look up terrain-based ramp accessibility
    const mapName = App.getCurrentMap();
    const worldX = latlng.lng;
    const worldZ = latlng.lat;
    const flags = Layers.getRampFlags(fp.faction, mapName, worldX, worldZ);

    // Determine per-edge accessibility from ramp flags
    const orient = entry.rotated ? fp.rampMapping.rotated : fp.rampMapping.unrotated;
    const minusOk = flags === null || orient.minus.some(bit => (flags >> bit) & 1);
    const plusOk = flags === null || orient.plus.some(bit => (flags >> bit) & 1);
    const rampAccess = { [-1]: minusOk, [1]: plusOk };

    // Ramp entry offset along the edge (from structure center)
    const edgeOffset = fp.rampEdgeOffset
      ? (entry.rotated ? fp.rampEdgeOffset.rotated : fp.rampEdgeOffset.unrotated)
      : 0;

    const arrowLen = 20;
    const arrowSpread = 10;
    const indicators = [];

    if (rampOnLat) {
      // Ramps on Z+/Z- edges (lat axis), offset along lng
      for (const sign of [-1, 1]) {
        const ok = rampAccess[sign];
        const color = ok ? '#00cc00' : '#ff4444';
        const edgeLat = latlng.lat + sign * entry.h / 2;
        const rampLng = latlng.lng + edgeOffset;
        const tri = L.polygon([
          [edgeLat, rampLng - arrowSpread],
          [edgeLat, rampLng + arrowSpread],
          [edgeLat + sign * arrowLen, rampLng],
        ], {
          color: color,
          fillColor: color,
          fillOpacity: ok ? 0.5 : 0.3,
          weight: 1.5,
          opacity: 0.8,
          interactive: false,
        }).addTo(placementGroup);
        indicators.push(tri);
      }
    } else {
      // Ramps on X+/X- edges (lng axis), offset along lat
      for (const sign of [-1, 1]) {
        const ok = rampAccess[sign];
        const color = ok ? '#00cc00' : '#ff4444';
        const edgeLng = latlng.lng + sign * entry.w / 2;
        const rampLat = latlng.lat + edgeOffset;
        const tri = L.polygon([
          [rampLat - arrowSpread, edgeLng],
          [rampLat + arrowSpread, edgeLng],
          [rampLat, edgeLng + sign * arrowLen],
        ], {
          color: color,
          fillColor: color,
          fillOpacity: ok ? 0.5 : 0.3,
          weight: 1.5,
          opacity: 0.8,
          interactive: false,
        }).addTo(placementGroup);
        indicators.push(tri);
      }
    }
    return indicators;
  }

  function placeFootprint(type, latlng) {
    const fp = FOOTPRINTS[type];
    if (!fp) return;

    const rotated = footprintRotated;
    const w = rotated ? fp.h : fp.w; // X dimension (lng)
    const h = rotated ? fp.w : fp.h; // Z dimension (lat)

    const bounds = [
      [latlng.lat - h / 2, latlng.lng - w / 2],
      [latlng.lat + h / 2, latlng.lng + w / 2],
    ];

    const rect = L.rectangle(bounds, {
      color: fp.color,
      fillColor: fp.color,
      fillOpacity: 0.15,
      weight: 2,
      opacity: 0.7,
      dashArray: '6,4',
      interactive: false,
    }).addTo(placementGroup);

    const markerIcon = L.divIcon({
      className: '',
      html: `<div style="width:8px;height:8px;background:${fp.color};border:1px solid #fff;border-radius:50;opacity:0.8;"></div>`,
      iconSize: [8, 8],
      iconAnchor: [4, 4],
    });

    const marker = L.marker(latlng, {
      icon: markerIcon,
      draggable: true,
      zIndexOffset: 200,
    }).addTo(placementGroup);

    marker.bindTooltip(fp.label + (rotated ? ' (90°)' : ''), {
      permanent: false,
      direction: 'top',
      offset: [0, -6],
      className: 'grid-label',
    });

    const entry = { marker, rect, type, rotated, w, h, rampIndicators: [] };
    entry.rampIndicators = drawRampIndicators(latlng, entry);
    footprints.push(entry);

    // Drag handler
    marker.on('drag', (e) => {
      const newLatLng = snapToGrid(e.latlng);
      marker.setLatLng(newLatLng);
      const newBounds = [
        [newLatLng.lat - entry.h / 2, newLatLng.lng - entry.w / 2],
        [newLatLng.lat + entry.h / 2, newLatLng.lng + entry.w / 2],
      ];
      rect.setBounds(newBounds);
      // Redraw ramp indicators
      entry.rampIndicators.forEach(ind => placementGroup.removeLayer(ind));
      entry.rampIndicators = drawRampIndicators(newLatLng, entry);
    });

    // Click to toggle rotation
    marker.on('click', () => {
      const tmpW = entry.w;
      entry.w = entry.h;
      entry.h = tmpW;
      entry.rotated = !entry.rotated;
      const pos = marker.getLatLng();
      const newBounds = [
        [pos.lat - entry.h / 2, pos.lng - entry.w / 2],
        [pos.lat + entry.h / 2, pos.lng + entry.w / 2],
      ];
      rect.setBounds(newBounds);
      marker.setTooltipContent(fp.label + (entry.rotated ? ' (90°)' : ''));
      // Redraw ramp indicators
      entry.rampIndicators.forEach(ind => placementGroup.removeLayer(ind));
      entry.rampIndicators = drawRampIndicators(pos, entry);
    });

    // Right-click to remove
    marker.on('contextmenu', () => {
      placementGroup.removeLayer(marker);
      placementGroup.removeLayer(rect);
      entry.rampIndicators.forEach(ind => placementGroup.removeLayer(ind));
      footprints = footprints.filter(f => f !== entry);
    });
  }

  function toggleFootprintRotation() {
    footprintRotated = !footprintRotated;
    return footprintRotated;
  }

  function clearAll() {
    for (const faction of ['Sol', 'Cent', 'Alien']) {
      hqs[faction].forEach(hq => {
        placementGroup.removeLayer(hq.marker);
        placementGroup.removeLayer(hq.buildCircle);
        if (hq.chainCircle) placementGroup.removeLayer(hq.chainCircle);
      });
      hqs[faction] = [];
      chainLines[faction].forEach(l => placementGroup.removeLayer(l));
      chainLines[faction] = [];
    }
    // Clear footprints
    footprints.forEach(fp => {
      placementGroup.removeLayer(fp.marker);
      placementGroup.removeLayer(fp.rect);
      if (fp.rampIndicators) fp.rampIndicators.forEach(ind => placementGroup.removeLayer(ind));
    });
    footprints = [];
    setPlacementMode(null);
    Expansion.update();
  }

  function setBuildRadius(r) {
    buildRadius = r;
    for (const faction of ['Sol', 'Cent']) {
      hqs[faction].forEach(hq => updateCirclePosition(hq.buildCircle, hq.latlng, r));
    }
    Expansion.update();
  }

  function setChainRange(r) {
    chainRange = r;
    for (const faction of ['Sol', 'Cent']) {
      hqs[faction].forEach(hq => {
        if (hq.chainCircle) updateCirclePosition(hq.chainCircle, hq.latlng, r);
      });
    }
    updateChainLines();
  }

  function setAlienNodeRadius(r) {
    alienNodeRadius = r;
    hqs.Alien.forEach(hq => {
      if (!hq.isBiocache) updateCirclePosition(hq.buildCircle, hq.latlng, r);
    });
    Expansion.update();
  }

  function setAlienBiocacheRadius(r) {
    alienBiocacheRadius = r;
    hqs.Alien.forEach(hq => {
      if (hq.isBiocache) updateCirclePosition(hq.buildCircle, hq.latlng, r);
    });
    Expansion.update();
  }

  function addHQAt(faction, x, z, isSpawn, isBiocache) {
    const latlng = L.latLng(z, x); // lat=Z, lng=X
    addHQ(faction, latlng, isSpawn, null, isBiocache || false);
  }

  function placeFootprintAt(type, x, z, rotated) {
    const savedRotation = footprintRotated;
    footprintRotated = rotated;
    placeFootprint(type, L.latLng(z, x));
    footprintRotated = savedRotation;
  }

  function getHQs() { return hqs; }
  function getBuildRadius() { return buildRadius; }
  function getChainRange() { return chainRange; }

  function exportLayout() {
    const layout = {};
    layout.map = App.getCurrentMap();

    // Spawns
    layout.spawns = {};
    for (const faction of ['Sol', 'Cent', 'Alien']) {
      layout.spawns[faction] = hqs[faction].map(hq => ({
        x: hq.latlng.lng,
        z: hq.latlng.lat,
        isSpawn: hq.isSpawn,
        isBiocache: hq.isBiocache || false,
      }));
    }

    // Footprints
    layout.footprints = footprints.map(fp => ({
      type: fp.type,
      x: fp.marker.getLatLng().lng,
      z: fp.marker.getLatLng().lat,
      rotated: fp.rotated,
    }));

    // Resource config
    const amounts = Layers.getResourceAmounts();
    const excluded = Layers.getExcludedPatches();
    const patchOverrides = Layers.getPatchOverrides();
    layout.resources = {
      balterium_amount: amounts.balterium,
      biotics_amount: amounts.biotics,
      removed_patches: [...excluded].sort((a, b) => a - b),
    };
    if (Object.keys(patchOverrides).length > 0) {
      layout.resources.patch_overrides = patchOverrides;
    }

    layout.settings = { buildRadius, chainRange, alienNodeRadius, alienBiocacheRadius, alienChainRange: ALIEN_CHAIN_RANGE };

    // Game modes
    layout.game_modes = {
      hvh: document.getElementById('mode-hvh').checked,
      hva: document.getElementById('mode-hva').checked,
      hvhva: document.getElementById('mode-hvhva').checked,
    };

    return layout;
  }

  return {
    init,
    setPlacementMode,
    clearAll,
    setBuildRadius,
    setChainRange,
    setAlienNodeRadius,
    setAlienBiocacheRadius,
    getHQs,
    getBuildRadius,
    getChainRange,
    getAlienNodeRadius: () => alienNodeRadius,
    getAlienBiocacheRadius: () => alienBiocacheRadius,
    getAlienChainRange: () => ALIEN_CHAIN_RANGE,
    exportLayout,
    addHQAt,
    placeFootprintAt,
    toggleFootprintRotation,
  };
})();
