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
  let solBuildRadius = 620;
  let centBuildRadius = 600;
  let solChainRange = 1520;
  let centChainRange = 1500;
  let alienNodeChainRange = 150;
  let alienBiocacheChainRange = 150;

  // Structure half-dimensions: { h: longest side / 2, w: shortest side / 2 }
  // Effective radius = sqrt(R² - h²) - w
  const HALF_DIMS = {
    Sol:      { h: 111 / 2, w: 76 / 2 },   // Sol HQ 76×111
    Cent:     { h: 75 / 2,  w: 47 / 2 },    // Cent HQ 47×75
    nest:     { h: 50 / 2,  w: 50 / 2 },    // Alien Nest 50×50
    node:     { h: 10 / 2,  w: 10 / 2 },    // Alien Node 10×10
    biocache: { h: 8,       w: 8 },          // Biocache ~16×16
  };

  // Effective radius: sqrt(R² - h²) - w
  // h = half-length (perpendicular to radial), w = half-width (along radial)
  function effectiveRadius(R, dims) {
    const sq = R * R - dims.h * dims.h;
    return sq > 0 ? Math.sqrt(sq) - dims.w : 0;
  }

  // Get half-dimensions for a specific structure entry
  function getHalfDims(hqEntry) {
    if (hqEntry.faction !== 'Alien') return HALF_DIMS[hqEntry.faction];
    if (hqEntry.isSpawn) return HALF_DIMS.nest;
    if (hqEntry.isBiocache) return HALF_DIMS.biocache;
    return HALF_DIMS.node;
  }

  // Get the base chain range for a specific structure
  function getStructureChainRange(hqEntry) {
    if (hqEntry.faction !== 'Alien') return getBaseChainRange(hqEntry.faction);
    return hqEntry.isBiocache ? alienBiocacheChainRange : alienNodeChainRange;
  }

  // Get the base chain range for a faction (used for chain lines/BFS)
  function getBaseChainRange(faction) {
    if (faction === 'Sol') return solChainRange;
    if (faction === 'Cent') return centChainRange;
    return alienNodeChainRange; // chain connectivity uses node range
  }

  // Structure footprint definitions (from scan AboveGroundPoints, meters)
  //
  // Ramp data encoding (8 bits in ramp grid PNG):
  //   bit 0: rampA@rot0,   bit 1: rampB@rot0
  //   bit 2: rampA@rot90,  bit 3: rampB@rot90
  //   bit 4: rampA@rot180, bit 5: rampB@rot180
  //   bit 6: rampA@rot270, bit 7: rampB@rot270
  //
  // rampSide: which dimension has ramps at rot=0 ('h' for Sol=Z edges, 'w' for Cent=X edges)
  // rampData[i]: per-rotation ramp config (i=0..3 for 0°/90°/180°/270°)
  //   edgeOffset: offset along the edge perpendicular to ramps (from structure center)
  //   minus/plus: bit indices for the -1/+1 edge in drawRampIndicators
  const FOOTPRINTS = {
    'sol-hq':     { w: 76,  h: 111, color: '#328cff', label: 'Sol HQ' },
    'cent-hq':    { w: 47,  h: 75,  color: '#eb4646', label: 'Cent HQ' },
    'sol-ref':    { w: 152, h: 96,  color: '#328cff', label: 'Sol Ref', hasRamps: true,
      rampSide: 'h', faction: 'Sol',
      // Sol ramp entries at local (25.52, ±57)
      rampData: [
        { edgeOffset:  25.52, minus: [0], plus: [1] }, // 0°:   Z edges, offset +25.52 along X
        { edgeOffset: -25.52, minus: [2], plus: [3] }, // 90°:  X edges, offset -25.52 along Z
        { edgeOffset: -25.52, minus: [5], plus: [4] }, // 180°: Z edges, offset -25.52 along X
        { edgeOffset:  25.52, minus: [7], plus: [6] }, // 270°: X edges, offset +25.52 along Z
      ],
    },
    'cent-ref':   { w: 64,  h: 116, color: '#eb4646', label: 'Cent Ref', hasRamps: true,
      rampSide: 'w', faction: 'Cent',
      // Cent ramp entries at local (±55, -34.20)
      rampData: [
        { edgeOffset: -34.20, minus: [0], plus: [1] }, // 0°:   X edges, offset -34.20 along Z
        { edgeOffset: -34.20, minus: [3], plus: [2] }, // 90°:  Z edges, offset -34.20 along X
        { edgeOffset:  34.20, minus: [5], plus: [4] }, // 180°: X edges, offset +34.20 along Z
        { edgeOffset:  34.20, minus: [6], plus: [7] }, // 270°: Z edges, offset +34.20 along X
      ],
    },
    'alien-nest': { w: 50,  h: 50,  color: '#50c832', label: 'Nest' },
  };

  // Footprint state
  let footprints = []; // [{marker, rect, type, rotation, w, h}]
  let footprintRotation = 0; // 0=0°, 1=90°, 2=180°, 3=270°

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

    for (const hq of hqs[faction]) {
      // Effective chain range = sqrt(R² - h²) where h = parent's half-length
      const base = getStructureChainRange(hq);
      const dims = getHalfDims(hq);
      const effRange = effectiveRadius(base, dims);

      const worldDist = Math.sqrt(
        Math.pow(latlng.lat - hq.latlng.lat, 2) +
        Math.pow(latlng.lng - hq.latlng.lng, 2)
      );
      if (worldDist <= effRange && worldDist < bestDist) {
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
    let bR, cR;
    if (faction === 'Alien') {
      // Aliens: effective radius = sqrt(R² - h²)
      const structCR = isBiocache ? alienBiocacheChainRange : alienNodeChainRange;
      const dims = isBiocache ? HALF_DIMS.biocache
        : (isSpawn ? HALF_DIMS.nest : HALF_DIMS.node);
      bR = effectiveRadius(structCR, dims);
      // Chain circle for nests/nodes (not biocaches)
      if (!isBiocache) {
        cR = effectiveRadius(structCR, dims);
      } else {
        cR = null;
      }
    } else {
      bR = faction === 'Sol' ? solBuildRadius : centBuildRadius;
      cR = null; // humans use 4 dedicated circles below
    }

    // For humans: 4 circles. For aliens: 2 circles (build + chain).
    let buildCircle, effBuildCircle = null, chainCircle = null, effChainCircle = null;

    if (faction === 'Alien') {
      // Alien: solid build circle + dashed chain circle
      buildCircle = createCircle(latlng, bR, {
        color: buildColor, fillColor: buildColor, fillOpacity: 0.08,
        weight: 2, opacity: 0.6,
      }).addTo(placementGroup);
      if (cR !== null) {
        chainCircle = createCircle(latlng, cR, {
          color: buildColor, fillColor: 'transparent', fillOpacity: 0,
          weight: 2, opacity: 0.6, dashArray: '8,8',
        }).addTo(placementGroup);
      }
    } else {
      // Human: 4 circles
      const dims = HALF_DIMS[faction];
      const base = faction === 'Sol' ? solChainRange : centChainRange;
      const fBR = faction === 'Sol' ? solBuildRadius : centBuildRadius;
      const effColor = faction === 'Sol' ? '#9944ff' : '#ff66aa'; // purple / pink

      // 1) Build radius — solid faction color, with fill
      buildCircle = createCircle(latlng, fBR, {
        color: buildColor, fillColor: buildColor, fillOpacity: 0.08,
        weight: 2, opacity: 0.7,
      }).addTo(placementGroup);

      // 2) Effective build radius — dotted faction color, no fill
      effBuildCircle = createCircle(latlng, effectiveRadius(fBR, dims), {
        color: buildColor, fillColor: 'transparent', fillOpacity: 0,
        weight: 2, opacity: 0.7, dashArray: '4,6',
      }).addTo(placementGroup);

      // 3) Chain range (expansion radius) — dashed faction color, no fill
      chainCircle = createCircle(latlng, base, {
        color: buildColor, fillColor: 'transparent', fillOpacity: 0,
        weight: 2, opacity: 0.7, dashArray: '10,8',
      }).addTo(placementGroup);

      // 4) Effective chain range (expansion effective) — dotted purple/pink, no fill
      effChainCircle = createCircle(latlng, effectiveRadius(base, dims), {
        color: effColor, fillColor: 'transparent', fillOpacity: 0,
        weight: 2, opacity: 0.7, dashArray: '4,6',
      }).addTo(placementGroup);
    }

    const hqEntry = { marker, buildCircle, effBuildCircle, chainCircle, effChainCircle, latlng, isSpawn, faction, isBiocache };
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
      if (faction === 'Alien') {
        const dims = getHalfDims(hqEntry);
        const R = getStructureChainRange(hqEntry);
        updateCirclePosition(hqEntry.buildCircle, newLatLng, effectiveRadius(R, dims));
        if (hqEntry.chainCircle) {
          updateCirclePosition(hqEntry.chainCircle, newLatLng, effectiveRadius(R, dims));
        }
      } else {
        const dims = HALF_DIMS[faction];
        const base = faction === 'Sol' ? solChainRange : centChainRange;
        const fBR = faction === 'Sol' ? solBuildRadius : centBuildRadius;
        updateCirclePosition(hqEntry.buildCircle, newLatLng, fBR);
        updateCirclePosition(hqEntry.effBuildCircle, newLatLng, effectiveRadius(fBR, dims));
        updateCirclePosition(hqEntry.chainCircle, newLatLng, base);
        updateCirclePosition(hqEntry.effChainCircle, newLatLng, effectiveRadius(base, dims));
      }
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
    if (hqEntry.effBuildCircle) placementGroup.removeLayer(hqEntry.effBuildCircle);
    if (hqEntry.chainCircle) placementGroup.removeLayer(hqEntry.chainCircle);
    if (hqEntry.effChainCircle) placementGroup.removeLayer(hqEntry.effChainCircle);
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
      const range = getBaseChainRange(faction);
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

    const rot = entry.rotation; // 0-3
    const rd = fp.rampData[rot];

    // Determine which axis ramps are on:
    // rampSide='h': ramps on lat (Z) at rot 0°/180°, on lng (X) at 90°/270°
    // rampSide='w': ramps on lng (X) at rot 0°/180°, on lat (Z) at 90°/270°
    const isOdd = rot % 2 === 1;
    const rampOnLat = (fp.rampSide === 'h') ? !isOdd : isOdd;

    // Look up terrain-based ramp accessibility
    const mapName = App.getCurrentMap();
    const flags = Layers.getRampFlags(fp.faction, mapName, latlng.lng, latlng.lat);

    const minusOk = flags === null || rd.minus.some(bit => (flags >> bit) & 1);
    const plusOk = flags === null || rd.plus.some(bit => (flags >> bit) & 1);

    const arrowLen = 20;
    const arrowSpread = 10;
    const indicators = [];

    if (rampOnLat) {
      // Ramps on Z+/Z- edges (lat axis), offset along lng
      for (const sign of [-1, 1]) {
        const ok = sign === -1 ? minusOk : plusOk;
        const color = ok ? '#00cc00' : '#ff4444';
        const edgeLat = latlng.lat + sign * entry.h / 2;
        const rampLng = latlng.lng + rd.edgeOffset;
        const tri = L.polygon([
          [edgeLat, rampLng - arrowSpread],
          [edgeLat, rampLng + arrowSpread],
          [edgeLat + sign * arrowLen, rampLng],
        ], {
          color, fillColor: color,
          fillOpacity: ok ? 0.5 : 0.3,
          weight: 1.5, opacity: 0.8, interactive: false,
        }).addTo(placementGroup);
        indicators.push(tri);
      }
    } else {
      // Ramps on X+/X- edges (lng axis), offset along lat
      for (const sign of [-1, 1]) {
        const ok = sign === -1 ? minusOk : plusOk;
        const color = ok ? '#00cc00' : '#ff4444';
        const edgeLng = latlng.lng + sign * entry.w / 2;
        const rampLat = latlng.lat + rd.edgeOffset;
        const tri = L.polygon([
          [rampLat - arrowSpread, edgeLng],
          [rampLat + arrowSpread, edgeLng],
          [rampLat, edgeLng + sign * arrowLen],
        ], {
          color, fillColor: color,
          fillOpacity: ok ? 0.5 : 0.3,
          weight: 1.5, opacity: 0.8, interactive: false,
        }).addTo(placementGroup);
        indicators.push(tri);
      }
    }
    return indicators;
  }

  const ROT_LABELS = ['', ' (90°)', ' (180°)', ' (270°)'];

  function getFootprintDims(fp, rotation) {
    // 0°/180° use original w,h; 90°/270° swap
    return (rotation % 2 === 0)
      ? { w: fp.w, h: fp.h }
      : { w: fp.h, h: fp.w };
  }

  function placeFootprint(type, latlng) {
    const fp = FOOTPRINTS[type];
    if (!fp) return;

    const rotation = footprintRotation;
    const { w, h } = getFootprintDims(fp, rotation);

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

    marker.bindTooltip(fp.label + ROT_LABELS[rotation], {
      permanent: false,
      direction: 'top',
      offset: [0, -6],
      className: 'grid-label',
    });

    const entry = { marker, rect, type, rotation, w, h, rampIndicators: [] };
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
      entry.rampIndicators.forEach(ind => placementGroup.removeLayer(ind));
      entry.rampIndicators = drawRampIndicators(newLatLng, entry);
    });

    // Click to advance rotation (0→90→180→270→0)
    marker.on('click', () => {
      entry.rotation = (entry.rotation + 1) % 4;
      const dims = getFootprintDims(fp, entry.rotation);
      entry.w = dims.w;
      entry.h = dims.h;
      const pos = marker.getLatLng();
      rect.setBounds([
        [pos.lat - entry.h / 2, pos.lng - entry.w / 2],
        [pos.lat + entry.h / 2, pos.lng + entry.w / 2],
      ]);
      marker.setTooltipContent(fp.label + ROT_LABELS[entry.rotation]);
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
    footprintRotation = (footprintRotation + 1) % 4;
    return footprintRotation;
  }

  function clearAll() {
    for (const faction of ['Sol', 'Cent', 'Alien']) {
      hqs[faction].forEach(hq => {
        placementGroup.removeLayer(hq.marker);
        placementGroup.removeLayer(hq.buildCircle);
        if (hq.effBuildCircle) placementGroup.removeLayer(hq.effBuildCircle);
        if (hq.chainCircle) placementGroup.removeLayer(hq.chainCircle);
        if (hq.effChainCircle) placementGroup.removeLayer(hq.effChainCircle);
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

  function setSolBuildRadius(r) {
    solBuildRadius = r;
    hqs.Sol.forEach(hq => {
      updateCirclePosition(hq.buildCircle, hq.latlng, r);
      if (hq.effBuildCircle) updateCirclePosition(hq.effBuildCircle, hq.latlng, effectiveRadius(r, HALF_DIMS.Sol));
    });
    Expansion.update();
  }

  function setCentBuildRadius(r) {
    centBuildRadius = r;
    hqs.Cent.forEach(hq => {
      updateCirclePosition(hq.buildCircle, hq.latlng, r);
      if (hq.effBuildCircle) updateCirclePosition(hq.effBuildCircle, hq.latlng, effectiveRadius(r, HALF_DIMS.Cent));
    });
    Expansion.update();
  }

  function setSolChainRange(r) {
    solChainRange = r;
    hqs.Sol.forEach(hq => {
      if (hq.chainCircle) updateCirclePosition(hq.chainCircle, hq.latlng, r);
      if (hq.effChainCircle) updateCirclePosition(hq.effChainCircle, hq.latlng, effectiveRadius(r, HALF_DIMS.Sol));
    });
    updateChainLines();
  }

  function setCentChainRange(r) {
    centChainRange = r;
    hqs.Cent.forEach(hq => {
      if (hq.chainCircle) updateCirclePosition(hq.chainCircle, hq.latlng, r);
      if (hq.effChainCircle) updateCirclePosition(hq.effChainCircle, hq.latlng, effectiveRadius(r, HALF_DIMS.Cent));
    });
    updateChainLines();
  }

  function setAlienNodeChainRange(r) {
    alienNodeChainRange = r;
    hqs.Alien.forEach(hq => {
      if (hq.isBiocache) return;
      const dims = getHalfDims(hq);
      updateCirclePosition(hq.buildCircle, hq.latlng, effectiveRadius(r, dims));
      if (hq.chainCircle) updateCirclePosition(hq.chainCircle, hq.latlng, effectiveRadius(r, dims));
    });
    updateChainLines();
    Expansion.update();
  }

  function setAlienBiocacheChainRange(r) {
    alienBiocacheChainRange = r;
    hqs.Alien.forEach(hq => {
      if (!hq.isBiocache) return;
      updateCirclePosition(hq.buildCircle, hq.latlng, effectiveRadius(r, HALF_DIMS.biocache));
    });
    Expansion.update();
  }

  function addHQAt(faction, x, z, isSpawn, isBiocache) {
    const latlng = L.latLng(z, x); // lat=Z, lng=X
    addHQ(faction, latlng, isSpawn, null, isBiocache || false);
  }

  function placeFootprintAt(type, x, z, rotation) {
    const saved = footprintRotation;
    footprintRotation = rotation;
    placeFootprint(type, L.latLng(z, x));
    footprintRotation = saved;
  }

  function getHQs() { return hqs; }
  function getBuildRadius(faction) {
    if (faction === 'Sol') return solBuildRadius;
    if (faction === 'Cent') return centBuildRadius;
    return solBuildRadius; // fallback
  }

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
      rotation: fp.rotation,
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

    layout.settings = { solBuildRadius, centBuildRadius, solChainRange, centChainRange, alienNodeChainRange, alienBiocacheChainRange };

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
    setSolBuildRadius,
    setCentBuildRadius,
    setSolChainRange,
    setCentChainRange,
    setAlienNodeChainRange,
    setAlienBiocacheChainRange,
    getHQs,
    getBuildRadius,
    getChainRange: (faction) => getBaseChainRange(faction),
    getAlienEffectiveRadius: (hqEntry) => effectiveRadius(getStructureChainRange(hqEntry), getHalfDims(hqEntry)),
    exportLayout,
    addHQAt,
    placeFootprintAt,
    toggleFootprintRotation,
  };
})();
