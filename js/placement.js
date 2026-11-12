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
  let placementMode = null; // 'sol-hq', 'cent-hq', 'alien-nest', 'alien-biocache', 'sol-expand', 'cent-expand', 'alien-expand', 'wildlife-nest', 'wildlife-biocache', 'wildlife-expand', 'koh', 'fusion-reactor'
  let hqs = {
    Sol: [],  // [{marker, buildCircle, chainCircle, latlng, isSpawn}]
    Cent: [],
    Alien: [],
    Wildlife: [],
  };
  let chainLines = { Sol: [], Cent: [], Alien: [], Wildlife: [] };

  // KoH (single) + Fusion Reactors (many).
  // koh = null OR {marker, captureCircle, exclusionCircle, latlng, captureR, exclR}
  // fusionReactors = [{marker, captureCircle, latlng, captureR}, ...]
  let koh = null;
  let fusionReactors = [];

  // Settings (updated by UI)
  let solBuildRadius = 620;
  let centBuildRadius = 600;
  let solChainRange = 1520;
  let centChainRange = 1500;
  let alienBuildRadius = 150;
  let alienNodeChainRange = 150;
  let alienBiocacheChainRange = 150;
  let wildlifeBuildRadius = 150;
  let wildlifeNodeChainRange = 150;
  let wildlifeBiocacheChainRange = 150;

  // KoH / FusionReactor default radii — used when placing new entries from sliders.
  let kohCaptureRadius = 50;
  let kohExclusionRadius = 75;
  let fusionCaptureRadius = 40;

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
    if (!isAlienType(hqEntry.faction)) return HALF_DIMS[hqEntry.faction];
    if (hqEntry.isSpawn) return HALF_DIMS.nest;
    if (hqEntry.isBiocache) return HALF_DIMS.biocache;
    return HALF_DIMS.node;
  }

  // Get the effective radius parameter for a specific structure
  // Wildlife uses same values as Alien
  function getStructureChainRange(hqEntry) {
    if (isAlienType(hqEntry.faction)) {
      if (hqEntry.isSpawn) return alienBuildRadius;      // nest uses build radius
      if (hqEntry.isBiocache) return alienBiocacheChainRange;
      return alienNodeChainRange;
    }
    return getBaseChainRange(hqEntry.faction);
  }

  // Get the base chain range for a faction (used for chain lines/BFS)
  function getBaseChainRange(faction) {
    if (faction === 'Sol') return solChainRange;
    if (faction === 'Cent') return centChainRange;
    if (faction === 'Wildlife') return wildlifeNodeChainRange;
    return alienNodeChainRange;
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

    // KoH (single — placing a second replaces the first)
    if (placementMode === 'koh') {
      addKohAt(worldX, worldZ, kohCaptureRadius, kohExclusionRadius);
      setPlacementMode(null);
      return;
    }

    // Fusion Reactor (multiple)
    if (placementMode === 'fusion-reactor') {
      addFusionReactorAt(worldX, worldZ, fusionCaptureRadius);
      // Stay in mode so user can keep adding reactors. Right-click removes; ESC / re-click button exits.
      return;
    }

    const faction = placementMode.startsWith('sol') ? 'Sol'
      : placementMode.startsWith('cent') ? 'Cent'
      : placementMode.startsWith('wildlife') ? 'Wildlife' : 'Alien';
    const isExpansion = placementMode.includes('expand') || placementMode === 'alien-biocache' || placementMode === 'wildlife-biocache';
    const isBiocache = placementMode === 'alien-biocache' || placementMode === 'wildlife-biocache';
    const mapName = App.getCurrentMap();

    // Validate placement against HQ mask (skip for aliens — they place anywhere)
    const restrictToZones = document.getElementById('setting-restrict-hq').checked;
    const siteChecked = !isExpansion && hqs[faction].length === 0 && isSiteBase(faction) &&
      typeof SiteUI !== 'undefined' && SiteUI.hasData();
    if (restrictToZones && faction !== 'Alien' && !siteChecked) {
      if (!Layers.isValidPlacement('hq', faction, mapName, worldX, worldZ)) {
        showPlacementError(snapped, 'Invalid HQ zone');
        return;
      }
    }

    // Expansion/biocache must be within build radius of the structure being placed
    if (isExpansion) {
      const placingRadius = faction === 'Alien'
        ? (isBiocache ? alienBiocacheChainRange : alienNodeChainRange)
        : getBaseChainRange(faction);
      const parent = findParentHQ(faction, snapped, placingRadius);
      if (!parent) {
        showPlacementError(snapped, 'Out of build radius');
        return;
      }
    }

    // Place HQ/nest/biocache
    const isSpawn = !isExpansion && hqs[faction].length === 0;
    // Spawn bases (Sol/Cent HQ, Nest) are checked against the base site data (SiteUI); the old
    // HQ-zone mask check above stays for expansions and maps without site data.
    if (isSpawn && isSiteBase(faction) && typeof SiteUI !== 'undefined' && SiteUI.hasData()) {
      const d = SiteUI.decide(faction, worldX, worldZ, undefined, false, restrictToZones);
      if (!d.ok) {
        showPlacementError(snapped, d.short || 'Invalid base site');
        SiteUI.status(d.msg, 'error');
        return;
      }
      addHQ(faction, L.latLng(d.z, d.x), true, map, false, { rot: d.rot });
      if (d.msg) {
        showPlacementError(L.latLng(d.z, d.x), d.short, d.level);
        SiteUI.status(d.msg, d.level);
      }
      setPlacementMode(null);
      return;
    }
    addHQ(faction, snapped, isSpawn, map, isBiocache);

    // Exit placement mode after placing spawn HQ/nest
    if (!isExpansion) {
      setPlacementMode(null);
    }
  }

  // level: undefined / 'error' red, 'warn' yellow, 'info' green
  function showPlacementError(latlng, msg, level) {
    const color = level === 'info' ? '#44ff88' : level === 'warn' ? '#ffcc00' : '#ff4444';
    const icon = L.divIcon({
      className: '',
      html: `<div style="color:${color};font-size:11px;font-weight:bold;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000;">${msg}</div>`,
      iconSize: [100, 16],
      iconAnchor: [50, 20],
    });
    const marker = L.marker(latlng, { icon, interactive: false }).addTo(placementGroup);
    setTimeout(() => placementGroup.removeLayer(marker), level ? 3000 : 1500);
  }

  // Spawn bases with base site data: Sol HQ, Cent HQ, Alien Nest (not Wildlife)
  function isSiteBase(faction) {
    return faction === 'Sol' || faction === 'Cent' || faction === 'Alien';
  }

  function findParentHQ(faction, latlng, placingRadius) {
    let bestParent = null;
    let bestDist = Infinity;

    for (const hq of hqs[faction]) {
      // Use the build radius of what's being placed, not the parent
      const dims = getHalfDims(hq);
      const effRange = effectiveRadius(placingRadius, dims);

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

  // Is this an alien-type faction (Alien or Wildlife)?
  function isAlienType(faction) {
    return faction === 'Alien' || faction === 'Wildlife';
  }

  // Faction colors: Sol=blue, Cent=red, Alien=green, Wildlife=brown
  function getFactionColor(faction) {
    if (faction === 'Sol') return '#328cff';
    if (faction === 'Cent') return '#eb4646';
    if (faction === 'Wildlife') return '#c8963c';
    return '#50c832';
  }

  function addHQ(faction, latlng, isSpawn, map, isBiocache, opts) {
    const fKey = faction === 'Sol' ? 'sol' : faction === 'Cent' ? 'cent' : faction === 'Wildlife' ? 'wildlife' : 'alien';
    const siteBase = isSpawn && !isBiocache && isSiteBase(faction);

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

    // Spawn bases carry an orientation cue (rotated by refreshSiteVisual)
    const icon = L.divIcon({
      className: markerClass,
      iconSize: iconSize,
      html: siteBase ? '<div class="site-rot-arrow"></div>' : '',
    });

    const marker = L.marker(latlng, {
      icon: icon,
      draggable: true,
      zIndexOffset: isSpawn ? 1000 : 500,
    }).addTo(placementGroup);

    // Build radius circle (polygon-based for correct CRS.Simple rendering)
    const buildColor = getFactionColor(faction);
    let bR, cR;
    if (isAlienType(faction)) {
      const dims = isBiocache ? HALF_DIMS.biocache
        : (isSpawn ? HALF_DIMS.nest : HALF_DIMS.node);
      if (isSpawn) {
        bR = effectiveRadius(alienBuildRadius, dims);
        cR = null;
      } else if (isBiocache) {
        bR = effectiveRadius(alienBiocacheChainRange, dims);
        cR = null;
      } else {
        bR = effectiveRadius(alienNodeChainRange, dims);
        cR = null;
      }
    } else {
      bR = faction === 'Sol' ? solBuildRadius : centBuildRadius;
      cR = null; // humans use 4 dedicated circles below
    }

    // For humans: 4 circles. For aliens: 2 circles (build + chain).
    let buildCircle, effBuildCircle = null, chainCircle = null, effChainCircle = null;

    if (isAlienType(faction)) {
      // Alien/Wildlife: nest gets dashed unfilled circle, nodes/biocaches get solid filled
      buildCircle = createCircle(latlng, bR, isSpawn ? {
        color: buildColor, fillColor: 'transparent', fillOpacity: 0,
        weight: 2, opacity: 0.6, dashArray: '8,8',
      } : {
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
    if (siteBase) {
      // rot: layout "rot" (0/90/180/270) or undefined = the mod uses the nearest start point's yaw;
      // rotManual: picked by hand (auto-snap never overrides it); siteFoot: rotated footprint
      hqEntry.siteBase = true;
      hqEntry.rot = opts && typeof opts.rot === 'number' && Number.isFinite(opts.rot) ? opts.rot : undefined;
      hqEntry.rotManual = false;
      hqEntry.siteFoot = null;
    }
    hqs[faction].push(hqEntry);

    // Label
    let label;
    if (isBiocache) {
      const bioIdx = hqs[faction].filter(h => h.isBiocache).length;
      label = `BC${bioIdx}`;
    } else if (isSpawn) {
      label = isAlienType(faction) ? (faction === 'Wildlife' ? 'WNest' : 'Nest') : 'HQ';
    } else {
      label = isAlienType(faction) ? `N${hqs[faction].length - 1}` : `E${hqs[faction].length - 1}`;
    }
    marker.bindTooltip(label, {
      permanent: true,
      direction: 'top',
      offset: [0, -10],
      className: 'grid-label',
    });

    // Drag handler
    let dragStart = null;
    marker.on('dragstart', () => { dragStart = hqEntry.latlng; });
    marker.on('drag', (e) => {
      moveHQVisuals(hqEntry, snapToGrid(e.latlng));
      if (hqEntry.siteBase) refreshSiteVisual(hqEntry);
      updateChainLines();
      Expansion.update();
    });

    marker.on('dragend', () => {
      // Spawn base: base site check on the drop spot (auto-snap / reject / warn, SiteUI.decide)
      if (hqEntry.siteBase && typeof SiteUI !== 'undefined' && SiteUI.hasData()) {
        const p = hqEntry.latlng;
        const restrict = document.getElementById('setting-restrict-hq').checked;
        const d = SiteUI.decide(faction, p.lng, p.lat, hqEntry.rot, hqEntry.rotManual, restrict, hqEntry);
        if (!d.ok) {
          showPlacementError(p, d.short || 'Invalid base site');
          SiteUI.status(d.msg + ' Moved back.', 'error');
          if (dragStart) moveHQVisuals(hqEntry, dragStart);
        } else {
          if (d.x !== p.lng || d.z !== p.lat) moveHQVisuals(hqEntry, L.latLng(d.z, d.x));
          if (d.rot !== hqEntry.rot) { hqEntry.rot = d.rot; hqEntry.rotManual = false; }
          if (d.msg) {
            showPlacementError(hqEntry.latlng, d.short, d.level);
            SiteUI.status(d.msg, d.level);
          }
        }
        refreshSiteVisual(hqEntry);
        SiteUI.changed();
      }
      dragStart = null;
      updateChainLines();
      Expansion.update();
    });

    // Spawn base: click opens the rotation / site popup
    if (siteBase) {
      marker.on('click', () => {
        if (typeof SiteUI !== 'undefined') SiteUI.openPopup(hqEntry);
      });
    }

    // Right-click to remove
    marker.on('contextmenu', () => {
      removeHQ(faction, hqEntry);
    });

    if (siteBase) refreshSiteVisual(hqEntry);
    updateChainLines();
    Expansion.update();
    if (siteBase && typeof SiteUI !== 'undefined') SiteUI.changed();
  }

  // Move an HQ/nest marker and its circles (drag, auto-snap, site fix)
  function moveHQVisuals(hqEntry, newLatLng) {
    const faction = hqEntry.faction;
    hqEntry.marker.setLatLng(newLatLng);
    hqEntry.latlng = newLatLng;
    if (isAlienType(faction)) {
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
  }

  // Orientation cue, rotated site footprint, validity ring and label of a spawn base.
  // Shown yaw: rot, else the start point yaw the mod will use (SiteUI.shownYaw).
  function refreshSiteVisual(hqEntry) {
    if (!hqEntry.siteBase) return;
    const info = typeof SiteUI !== 'undefined' ? SiteUI.visualInfo(hqEntry) : null;
    const el = hqEntry.marker.getElement && hqEntry.marker.getElement();
    if (el) {
      const arrow = el.querySelector('.site-rot-arrow');
      if (arrow) {
        arrow.style.display = info && info.yaw != null ? '' : 'none';
        if (info && info.yaw != null) arrow.style.transform = `rotate(${info.yaw}deg)`;
        arrow.classList.toggle('site-rot-auto', hqEntry.rot === undefined);
      }
      el.classList.toggle('site-bad', !!(info && info.bad));
      el.classList.toggle('site-warn', !!(info && !info.bad && info.low));
    }
    if (hqEntry.siteFoot) { placementGroup.removeLayer(hqEntry.siteFoot); hqEntry.siteFoot = null; }
    if (info && info.corners) {
      const color = info.bad ? '#ff4444' : getFactionColor(hqEntry.faction);
      hqEntry.siteFoot = L.polygon(info.corners, {
        color, weight: 1.5, opacity: 0.9, fillColor: color, fillOpacity: 0.12,
        dashArray: hqEntry.rot === undefined ? '4,4' : null, interactive: false,
      }).addTo(placementGroup);
    }
  }

  function refreshSiteVisuals() {
    for (const f of ['Sol', 'Cent', 'Alien']) hqs[f].forEach(h => { if (h.siteBase) refreshSiteVisual(h); });
  }

  /** Spawn base of a faction (the isSpawn entry, also spawns.<faction>[0] on export) or null. */
  function getSpawnBase(faction) {
    const h = hqs[faction] && hqs[faction][0];
    return h && h.siteBase ? h : null;
  }

  /** Set position and/or rotation of a spawn base (site fix, rotation popup). */
  function setSpawnPose(hqEntry, x, z, rot, manual) {
    if (x !== hqEntry.latlng.lng || z !== hqEntry.latlng.lat) moveHQVisuals(hqEntry, L.latLng(z, x));
    hqEntry.rot = rot;
    hqEntry.rotManual = !!manual && rot !== undefined;
    refreshSiteVisual(hqEntry);
    updateChainLines();
    Expansion.update();
  }

  function removeHQ(faction, hqEntry) {
    placementGroup.removeLayer(hqEntry.marker);
    placementGroup.removeLayer(hqEntry.buildCircle);
    if (hqEntry.effBuildCircle) placementGroup.removeLayer(hqEntry.effBuildCircle);
    if (hqEntry.chainCircle) placementGroup.removeLayer(hqEntry.chainCircle);
    if (hqEntry.effChainCircle) placementGroup.removeLayer(hqEntry.effChainCircle);
    if (hqEntry.siteFoot) placementGroup.removeLayer(hqEntry.siteFoot);
    hqs[faction] = hqs[faction].filter(h => h !== hqEntry);
    updateChainLines();
    Expansion.update();
    if (hqEntry.siteBase && typeof SiteUI !== 'undefined') SiteUI.changed();
  }

  function updateChainLines() {
    // Clear old lines
    for (const faction of ['Sol', 'Cent', 'Alien', 'Wildlife']) {
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
    // Placing and measuring both own the drag gesture — only one can be active
    if (mode && typeof Measure !== 'undefined' && Measure.isArmed()) Measure.disarm();
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
        'wildlife-nest': 'btn-place-wildlife',
        'wildlife-biocache': 'btn-place-wildlife-biocache',
        'wildlife-expand': 'btn-expand-wildlife',
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
    for (const faction of ['Sol', 'Cent', 'Alien', 'Wildlife']) {
      hqs[faction].forEach(hq => {
        placementGroup.removeLayer(hq.marker);
        placementGroup.removeLayer(hq.buildCircle);
        if (hq.effBuildCircle) placementGroup.removeLayer(hq.effBuildCircle);
        if (hq.chainCircle) placementGroup.removeLayer(hq.chainCircle);
        if (hq.effChainCircle) placementGroup.removeLayer(hq.effChainCircle);
        if (hq.siteFoot) placementGroup.removeLayer(hq.siteFoot);
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
    // Clear KoH + Fusion Reactors
    removeKoh();
    fusionReactors.forEach(fr => {
      placementGroup.removeLayer(fr.marker);
      placementGroup.removeLayer(fr.captureCircle);
    });
    fusionReactors = [];
    setPlacementMode(null);
    Expansion.update();
    if (typeof SiteUI !== 'undefined') SiteUI.changed();
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

  function setAlienBuildRadius(r) {
    alienBuildRadius = r;
    for (const f of ['Alien', 'Wildlife']) {
      hqs[f].forEach(hq => {
        if (!hq.isSpawn) return;
        const dims = getHalfDims(hq);
        updateCirclePosition(hq.buildCircle, hq.latlng, effectiveRadius(r, dims));
        if (hq.chainCircle) updateCirclePosition(hq.chainCircle, hq.latlng, effectiveRadius(r, dims));
      });
    }
  }

  function setAlienNodeChainRange(r) {
    alienNodeChainRange = r;
    for (const f of ['Alien', 'Wildlife']) {
      hqs[f].forEach(hq => {
        if (hq.isBiocache || hq.isSpawn) return;
        const dims = getHalfDims(hq);
        updateCirclePosition(hq.buildCircle, hq.latlng, effectiveRadius(r, dims));
      });
    }
    updateChainLines();
    Expansion.update();
  }

  function setAlienBiocacheChainRange(r) {
    alienBiocacheChainRange = r;
    for (const f of ['Alien', 'Wildlife']) {
      hqs[f].forEach(hq => {
        if (!hq.isBiocache) return;
        updateCirclePosition(hq.buildCircle, hq.latlng, effectiveRadius(r, HALF_DIMS.biocache));
      });
    }
    Expansion.update();
  }

  // Wildlife uses same radii as Alien — update Wildlife circles when Alien settings change

  // opts.rot: layout "rot" of a spawn base (import)
  function addHQAt(faction, x, z, isSpawn, isBiocache, opts) {
    const latlng = L.latLng(z, x); // lat=Z, lng=X
    addHQ(faction, latlng, isSpawn, null, isBiocache || false, opts);
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
    if (faction === 'Alien') return alienBuildRadius;
    return solBuildRadius; // fallback
  }

  // === KoH + Fusion Reactor placement ===

  const KOH_COLOR = '#f0c020';     // amber / gold
  const FUSION_COLOR = '#22c8ff';  // cyan

  function addKohAt(x, z, captureR, exclR) {
    // Single per map — replace existing.
    if (koh) removeKoh();

    const latlng = L.latLng(z, x);
    const icon = L.divIcon({
      className: 'koh-marker',
      html: '<div style="width:14px;height:14px;background:#f0c020;border:2px solid #000;border-radius:2px;transform:rotate(45deg);box-shadow:0 0 4px #000;"></div>',
      iconSize: [18, 18],
    });
    const marker = L.marker(latlng, { icon, draggable: true, zIndexOffset: 1500 }).addTo(placementGroup);
    marker.bindTooltip('KoH', { permanent: true, direction: 'top', offset: [0, -10], className: 'grid-label' });

    const captureCircle = createCircle(latlng, captureR, {
      color: KOH_COLOR, fillColor: KOH_COLOR, fillOpacity: 0.10, weight: 2, opacity: 0.8,
    }).addTo(placementGroup);
    const exclusionCircle = createCircle(latlng, exclR, {
      color: KOH_COLOR, fillColor: 'transparent', fillOpacity: 0, weight: 2, opacity: 0.6, dashArray: '8,8',
    }).addTo(placementGroup);

    koh = { marker, captureCircle, exclusionCircle, latlng, captureR, exclR };

    marker.on('drag', (e) => {
      const newLatLng = snapToGrid(e.latlng);
      marker.setLatLng(newLatLng);
      koh.latlng = newLatLng;
      updateCirclePosition(koh.captureCircle, newLatLng, koh.captureR);
      updateCirclePosition(koh.exclusionCircle, newLatLng, koh.exclR);
    });

    // Right-click to remove
    marker.on('contextmenu', () => removeKoh());
  }

  function removeKoh() {
    if (!koh) return;
    placementGroup.removeLayer(koh.marker);
    placementGroup.removeLayer(koh.captureCircle);
    placementGroup.removeLayer(koh.exclusionCircle);
    koh = null;
  }

  function addFusionReactorAt(x, z, captureR) {
    const latlng = L.latLng(z, x);
    const icon = L.divIcon({
      className: 'fusion-marker',
      html: '<div style="width:12px;height:12px;background:#22c8ff;border:2px solid #000;border-radius:50%;box-shadow:0 0 4px #000;"></div>',
      iconSize: [16, 16],
    });
    const marker = L.marker(latlng, { icon, draggable: true, zIndexOffset: 1400 }).addTo(placementGroup);
    const idx = fusionReactors.length;
    marker.bindTooltip(`FR${idx}`, { permanent: true, direction: 'top', offset: [0, -10], className: 'grid-label' });

    const captureCircle = createCircle(latlng, captureR, {
      color: FUSION_COLOR, fillColor: FUSION_COLOR, fillOpacity: 0.08, weight: 2, opacity: 0.8,
    }).addTo(placementGroup);

    const entry = { marker, captureCircle, latlng, captureR };
    fusionReactors.push(entry);

    marker.on('drag', (e) => {
      const newLatLng = snapToGrid(e.latlng);
      marker.setLatLng(newLatLng);
      entry.latlng = newLatLng;
      updateCirclePosition(entry.captureCircle, newLatLng, entry.captureR);
    });

    // Right-click to remove
    marker.on('contextmenu', () => {
      placementGroup.removeLayer(entry.marker);
      placementGroup.removeLayer(entry.captureCircle);
      fusionReactors = fusionReactors.filter(f => f !== entry);
      // Renumber tooltips after removal
      fusionReactors.forEach((fr, i) => fr.marker.setTooltipContent(`FR${i}`));
    });
  }

  // Setters — used by the UI sliders. Update default for new placements AND resize existing.

  function setKohCaptureRadius(r) {
    kohCaptureRadius = r;
    if (koh) { koh.captureR = r; updateCirclePosition(koh.captureCircle, koh.latlng, r); }
  }
  function setKohExclusionRadius(r) {
    kohExclusionRadius = r;
    if (koh) { koh.exclR = r; updateCirclePosition(koh.exclusionCircle, koh.latlng, r); }
  }
  function setFusionCaptureRadius(r) {
    fusionCaptureRadius = r;
    fusionReactors.forEach(fr => {
      fr.captureR = r;
      updateCirclePosition(fr.captureCircle, fr.latlng, r);
    });
  }

  function exportLayout() {
    const layout = {};
    layout.map = App.getCurrentMap();

    // Spawns
    layout.spawns = {};
    for (const faction of ['Sol', 'Cent', 'Alien', 'Wildlife']) {
      layout.spawns[faction] = hqs[faction].map(hq => {
        const e = {
          x: hq.latlng.lng,
          z: hq.latlng.lat,
          isSpawn: hq.isSpawn,
          isBiocache: hq.isBiocache || false,
        };
        // Si_MapBalance 3.6.0: yaw of the base; absent = the nearest start point's rotation,
        // so layouts without a set rotation stay byte-identical
        if (hq.siteBase && hq.rot !== undefined) e.rot = hq.rot;
        return e;
      });
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

    layout.settings = {
      solBuildRadius, centBuildRadius, solChainRange, centChainRange,
      alienBuildRadius, alienNodeChainRange, alienBiocacheChainRange,
      wildlifeBuildRadius: alienBuildRadius,
      wildlifeNodeChainRange: alienNodeChainRange,
      wildlifeBiocacheChainRange: alienBiocacheChainRange,
    };

    // Game modes
    layout.game_modes = {
      hvh: document.getElementById('mode-hvh').checked,
      hva: document.getElementById('mode-hva').checked,
      hvhva: document.getElementById('mode-hvhva').checked,
      '4way': document.getElementById('mode-4way').checked,
    };
    // Si_MapBalance 3.4.0: 2v1 layout (Sol + Cent allied vs Aliens), used only in
    // Si_VersusVote 2v1 rounds and never in a normal HvHvA round. Written only when
    // ticked, so normal layouts stay byte-identical.
    if (document.getElementById('mode-2v1').checked) layout.game_modes['2v1'] = true;
    // Si_MapBalance 3.3.2: false = the mod never swaps Sol and Cent for this layout
    layout.swap_spawns = document.getElementById('swap-spawns').checked;

    // KoH (single)
    if (koh) {
      layout.koh = {
        x: koh.latlng.lng,
        z: koh.latlng.lat,
        capture_radius: koh.captureR,
        exclusion_radius: koh.exclR,
      };
    }

    // Fusion Reactors (many)
    if (fusionReactors.length > 0) {
      layout.fusion_reactors = fusionReactors.map(fr => ({
        x: fr.latlng.lng,
        z: fr.latlng.lat,
        capture_radius: fr.captureR,
      }));
    }

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
    setAlienBuildRadius,
    setAlienNodeChainRange,
    setAlienBiocacheChainRange,
    setKohCaptureRadius,
    setKohExclusionRadius,
    setFusionCaptureRadius,
    getHQs,
    getBuildRadius,
    getChainRange: (faction) => getBaseChainRange(faction),
    getAlienEffectiveRadius: (hqEntry) => effectiveRadius(getStructureChainRange(hqEntry), getHalfDims(hqEntry)),
    exportLayout,
    addHQAt,
    addKohAt,
    addFusionReactorAt,
    placeFootprintAt,
    toggleFootprintRotation,
    getSpawnBase,
    setSpawnPose,
    refreshSiteVisuals,
  };
})();
