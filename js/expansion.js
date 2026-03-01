/**
 * expansion.js - Expansion tree analysis and resource ownership computation
 */

const Expansion = (() => {
  let expansionGroup = null;
  let resourceMarkers = []; // references to resource circle markers on map

  function init(map) {
    expansionGroup = L.layerGroup().addTo(map);
  }

  function setResourceMarkers(markers) {
    resourceMarkers = markers;
  }

  function update() {
    if (!expansionGroup) return;
    expansionGroup.clearLayers();

    const hqs = Placement.getHQs();
    const resData = Layers.getResourceData();
    if (!resData) return;

    const resources = resData.resources;

    // Compute ownership: which resources are within each faction's build radii
    // Humans (Sol/Cent) claim Balterium; Aliens claim Biotics
    const ownership = computeOwnership(hqs, resources);

    // Update resource marker colors
    updateResourceColors(resources, ownership);

    // Update balance panel
    UI.updateBalance(resources, ownership);
  }

  function computeOwnership(hqs, resources) {
    const ownership = {};

    // Precompute tiers for each faction
    const tierCache = {};
    for (const faction of ['Sol', 'Cent', 'Alien']) {
      if (hqs[faction].length > 0) {
        tierCache[faction] = computeHQTiers(faction, hqs[faction]);
      }
    }

    const excluded = Layers.getExcludedPatches();

    resources.forEach(res => {
      const idx = res.idx;

      // Excluded patches are not owned by anyone
      if (excluded.has(idx)) {
        ownership[idx] = { owner: 'none', tier: Infinity, solTier: Infinity, centTier: Infinity, alienTier: Infinity, excluded: true };
        return;
      }

      const isBalt = res.type === 'Balterium';

      let solTier = Infinity;
      let centTier = Infinity;
      let alienTier = Infinity;

      // Humans claim Balterium only
      if (isBalt) {
        for (const faction of ['Sol', 'Cent']) {
          const factionHqs = hqs[faction];
          if (factionHqs.length === 0) continue;
          const tiers = tierCache[faction];

          for (let i = 0; i < factionHqs.length; i++) {
            const hq = factionHqs[i];
            const dist = Math.sqrt(
              Math.pow(res.x - hq.latlng.lng, 2) +
              Math.pow(res.z - hq.latlng.lat, 2)
            );
            if (dist <= Placement.getBuildRadius(faction)) {
              const tier = tiers[i];
              if (faction === 'Sol') solTier = Math.min(solTier, tier);
              else centTier = Math.min(centTier, tier);
            }
          }
        }
      }

      // Aliens claim Biotics only
      if (!isBalt) {
        const factionHqs = hqs.Alien;
        if (factionHqs.length > 0) {
          const tiers = tierCache.Alien;
          for (let i = 0; i < factionHqs.length; i++) {
            const hq = factionHqs[i];
            const r = Placement.getAlienEffectiveRadius(hq);
            const dist = Math.sqrt(
              Math.pow(res.x - hq.latlng.lng, 2) +
              Math.pow(res.z - hq.latlng.lat, 2)
            );
            if (dist <= r) {
              alienTier = Math.min(alienTier, tiers[i]);
            }
          }
        }
      }

      let owner = 'none';
      let tier = Infinity;

      if (isBalt) {
        // Human ownership logic
        if (solTier < Infinity && centTier < Infinity) {
          if (solTier <= centTier) {
            owner = solTier === centTier ? 'contested' : 'Sol';
            tier = solTier;
          } else {
            owner = 'Cent';
            tier = centTier;
          }
        } else if (solTier < Infinity) {
          owner = 'Sol';
          tier = solTier;
        } else if (centTier < Infinity) {
          owner = 'Cent';
          tier = centTier;
        }
      } else {
        // Alien ownership of Biotics
        if (alienTier < Infinity) {
          owner = 'Alien';
          tier = alienTier;
        }
      }

      ownership[idx] = { owner, tier, solTier, centTier, alienTier };
    });

    return ownership;
  }

  function computeHQTiers(faction, factionHqs) {
    // BFS from spawn HQ to compute chain depth
    const chainRange = Placement.getChainRange(faction);
    const tiers = new Array(factionHqs.length).fill(Infinity);

    // Find spawn HQ (isSpawn = true, or first one)
    let spawnIdx = factionHqs.findIndex(h => h.isSpawn);
    if (spawnIdx === -1) spawnIdx = 0;
    tiers[spawnIdx] = 0;

    // BFS
    const queue = [spawnIdx];
    const visited = new Set([spawnIdx]);

    while (queue.length > 0) {
      const curr = queue.shift();
      const currHQ = factionHqs[curr];

      for (let i = 0; i < factionHqs.length; i++) {
        if (visited.has(i)) continue;
        const otherHQ = factionHqs[i];
        const dist = Math.sqrt(
          Math.pow(currHQ.latlng.lat - otherHQ.latlng.lat, 2) +
          Math.pow(currHQ.latlng.lng - otherHQ.latlng.lng, 2)
        );
        if (dist <= chainRange) {
          tiers[i] = tiers[curr] + 1;
          visited.add(i);
          queue.push(i);
        }
      }
    }

    return tiers;
  }

  function updateResourceColors(resources, ownership) {
    if (!resourceMarkers || resourceMarkers.length === 0) return;

    const excluded = Layers.getExcludedPatches();
    const colors = {
      Sol: '#4488ff',
      Cent: '#ff4444',
      Alien: '#50c832',
      contested: '#ffcc00',
    };

    resourceMarkers.forEach(marker => {
      const res = marker._resData;
      if (!res) return;

      // Excluded patches get special styling
      if (excluded.has(res.idx)) {
        Layers.updateResourceMarkerIcon(marker, '#ff4444', true);
        return;
      }

      const own = ownership[res.idx];
      if (!own) return;

      const isOwned = own.owner !== 'none';
      const defaultColor = res.type === 'Balterium' ? '#ffffff' : '#9b30ff';
      const color = isOwned ? (colors[own.owner] || defaultColor) : defaultColor;

      Layers.updateResourceMarkerIcon(marker, color, false);

      // Add tier label if owned
      if (isOwned && own.tier < Infinity) {
        const tierLabel = L.divIcon({
          className: '',
          html: `<span style="font-size:9px;color:${color};font-weight:bold;text-shadow:0 0 3px #000;">T${own.tier}</span>`,
          iconSize: [20, 12],
          iconAnchor: [10, -4],
        });
        L.marker([res.z, res.x], { icon: tierLabel, interactive: false }).addTo(expansionGroup);
      }
    });
  }

  return {
    init,
    setResourceMarkers,
    update,
    computeOwnership,
  };
})();
