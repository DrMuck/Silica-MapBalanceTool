/**
 * ui.js - Sidebar controls, fairness panel, settings, export
 */

const UI = (() => {
  function init() {
    // Placement buttons
    document.getElementById('btn-place-sol').addEventListener('click', () => {
      Placement.setPlacementMode('sol-hq');
    });
    document.getElementById('btn-place-cent').addEventListener('click', () => {
      Placement.setPlacementMode('cent-hq');
    });
    document.getElementById('btn-expand-sol').addEventListener('click', () => {
      Placement.setPlacementMode('sol-expand');
    });
    document.getElementById('btn-expand-cent').addEventListener('click', () => {
      Placement.setPlacementMode('cent-expand');
    });
    document.getElementById('btn-place-alien').addEventListener('click', () => {
      Placement.setPlacementMode('alien-nest');
    });
    document.getElementById('btn-expand-alien').addEventListener('click', () => {
      Placement.setPlacementMode('alien-expand');
    });
    document.getElementById('btn-place-biocache').addEventListener('click', () => {
      Placement.setPlacementMode('alien-biocache');
    });
    document.getElementById('btn-clear').addEventListener('click', () => {
      Placement.clearAll();
    });

    // Footprint buttons
    document.getElementById('btn-fp-sol-hq').addEventListener('click', () => {
      Placement.setPlacementMode('fp-sol-hq');
    });
    document.getElementById('btn-fp-cent-hq').addEventListener('click', () => {
      Placement.setPlacementMode('fp-cent-hq');
    });
    document.getElementById('btn-fp-sol-ref').addEventListener('click', () => {
      Placement.setPlacementMode('fp-sol-ref');
    });
    document.getElementById('btn-fp-cent-ref').addEventListener('click', () => {
      Placement.setPlacementMode('fp-cent-ref');
    });
    document.getElementById('btn-fp-alien-nest').addEventListener('click', () => {
      Placement.setPlacementMode('fp-alien-nest');
    });

    // Resource amount sliders
    const baltSlider = document.getElementById('setting-balt-amount');
    const bioSlider = document.getElementById('setting-bio-amount');
    const baltVal = document.getElementById('val-balt-amount');
    const bioVal = document.getElementById('val-bio-amount');

    baltSlider.addEventListener('input', () => {
      const v = parseInt(baltSlider.value);
      baltVal.textContent = formatSliderK(v);
      Layers.setResourceAmounts(v, parseInt(bioSlider.value));
    });

    bioSlider.addEventListener('input', () => {
      const v = parseInt(bioSlider.value);
      bioVal.textContent = formatSliderK(v);
      Layers.setResourceAmounts(parseInt(baltSlider.value), v);
    });

    // Settings sliders
    const solBuildSlider = document.getElementById('setting-sol-build-radius');
    const solBuildVal = document.getElementById('val-sol-build-radius');
    solBuildSlider.addEventListener('input', () => {
      const v = parseInt(solBuildSlider.value);
      solBuildVal.textContent = `${v}m`;
      Placement.setSolBuildRadius(v);
    });

    const centBuildSlider = document.getElementById('setting-cent-build-radius');
    const centBuildVal = document.getElementById('val-cent-build-radius');
    centBuildSlider.addEventListener('input', () => {
      const v = parseInt(centBuildSlider.value);
      centBuildVal.textContent = `${v}m`;
      Placement.setCentBuildRadius(v);
    });

    const solChainSlider = document.getElementById('setting-sol-chain-range');
    const solChainVal = document.getElementById('val-sol-chain-range');
    solChainSlider.addEventListener('input', () => {
      const v = parseInt(solChainSlider.value);
      solChainVal.textContent = `${v}m`;
      Placement.setSolChainRange(v);
    });

    const centChainSlider = document.getElementById('setting-cent-chain-range');
    const centChainVal = document.getElementById('val-cent-chain-range');
    centChainSlider.addEventListener('input', () => {
      const v = parseInt(centChainSlider.value);
      centChainVal.textContent = `${v}m`;
      Placement.setCentChainRange(v);
    });

    // Alien chain range sliders (build radius = chain range for aliens)
    const alienNodeSlider = document.getElementById('setting-alien-node-range');
    const alienNodeVal = document.getElementById('val-alien-node-range');
    alienNodeSlider.addEventListener('input', () => {
      const v = parseInt(alienNodeSlider.value);
      alienNodeVal.textContent = `${v}m`;
      Placement.setAlienNodeChainRange(v);
    });

    const alienBcSlider = document.getElementById('setting-alien-bc-range');
    const alienBcVal = document.getElementById('val-alien-bc-range');
    alienBcSlider.addEventListener('input', () => {
      const v = parseInt(alienBcSlider.value);
      alienBcVal.textContent = `${v}m`;
      Placement.setAlienBiocacheChainRange(v);
    });

    // Export
    document.getElementById('btn-export').addEventListener('click', () => {
      const layout = Placement.exportLayout();
      const json = JSON.stringify(layout, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `layout_${layout.map}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Load / Import
    const fileInput = document.getElementById('file-load');
    document.getElementById('btn-load').addEventListener('click', () => {
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          await importLayout(data);
        } catch (err) {
          console.error('Failed to load layout:', err);
          alert('Failed to load layout: ' + err.message);
        }
      };
      reader.readAsText(file);
      fileInput.value = ''; // reset so same file can be loaded again
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        Placement.setPlacementMode(null);
      }
      if (e.key === 'r' || e.key === 'R') {
        const rot = Placement.toggleFootprintRotation();
        const indicator = document.getElementById('fp-rotation-indicator');
        if (indicator) indicator.textContent = `(${rot * 90}°)`;
      }
    });
  }

  function updateBalance(resources, ownership) {
    const panel = document.getElementById('balance-panel');

    const hqs = Placement.getHQs();
    const excluded = Layers.getExcludedPatches();
    const numExcluded = excluded.size;

    if (hqs.Sol.length === 0 && hqs.Cent.length === 0 && hqs.Alien.length === 0) {
      let hint = '<p style="color:#555;font-size:12px;">Place HQs/Nest to see analysis</p>';
      if (numExcluded > 0) {
        hint += `<p style="color:#ff4444;font-size:11px;margin-top:4px;">${numExcluded} patch(es) excluded</p>`;
      }
      panel.innerHTML = hint;
      return;
    }

    // Compute stats per faction per tier — Balterium for humans, Biotics for aliens
    const stats = { Sol: {}, Cent: {}, contested: {}, Alien: {} };
    let uncapturedBalt = { patches: 0, resources: 0 };
    let uncapturedBio = { patches: 0, resources: 0 };

    resources.forEach(res => {
      // Skip excluded patches entirely
      if (excluded.has(res.idx)) return;

      const own = ownership[res.idx];
      if (!own) return;

      const isBalt = res.type === 'Balterium';
      const amount = Layers.getPatchAmount(res);

      if (own.owner === 'none') {
        if (isBalt) { uncapturedBalt.patches++; uncapturedBalt.resources += amount; }
        else { uncapturedBio.patches++; uncapturedBio.resources += amount; }
        return;
      }

      const bucket = own.owner;
      const tier = `T${own.tier}`;

      if (!stats[bucket][tier]) stats[bucket][tier] = { patches: 0, resources: 0 };
      stats[bucket][tier].patches++;
      stats[bucket][tier].resources += amount;
    });

    // Compute totals
    const totals = {};
    for (const faction of ['Sol', 'Cent', 'contested', 'Alien']) {
      totals[faction] = { patches: 0, resources: 0 };
      for (const tier of Object.values(stats[faction])) {
        totals[faction].patches += tier.patches;
        totals[faction].resources += tier.resources;
      }
    }

    // Compute HvH fairness (Balterium only)
    const solTotal = totals.Sol.resources;
    const centTotal = totals.Cent.resources;
    const maxRes = Math.max(solTotal, centTotal, 1);
    const fairness = 1 - Math.abs(solTotal - centTotal) / maxRes;

    // Build HTML — Balterium table (HvH)
    let html = '<div style="font-size:11px;color:#8899aa;margin-bottom:4px;">Balterium (HvH)</div>';
    html += '<table class="balance-table">';
    html += '<tr><th></th><th class="sol-col">Sol</th><th class="cent-col">Cent</th><th>Contest</th></tr>';

    const humanTiers = new Set();
    for (const faction of ['Sol', 'Cent', 'contested']) {
      Object.keys(stats[faction]).forEach(t => humanTiers.add(t));
    }
    const sortedHumanTiers = [...humanTiers].sort();

    for (const tier of sortedHumanTiers) {
      const sol = stats.Sol[tier] || { patches: 0, resources: 0 };
      const cent = stats.Cent[tier] || { patches: 0, resources: 0 };
      const cont = stats.contested[tier] || { patches: 0, resources: 0 };
      html += `<tr>
        <td>${tier}</td>
        <td class="sol-col">${sol.patches}p ${formatK(sol.resources)}</td>
        <td class="cent-col">${cent.patches}p ${formatK(cent.resources)}</td>
        <td>${cont.patches}p ${formatK(cont.resources)}</td>
      </tr>`;
    }

    html += `<tr style="border-top:1px solid #0f3460;">
      <td><b>Total</b></td>
      <td class="sol-col"><b>${totals.Sol.patches}p ${formatK(totals.Sol.resources)}</b></td>
      <td class="cent-col"><b>${totals.Cent.patches}p ${formatK(totals.Cent.resources)}</b></td>
      <td><b>${totals.contested.patches}p ${formatK(totals.contested.resources)}</b></td>
    </tr>`;
    html += '</table>';

    html += `<div style="margin-top:4px;font-size:11px;color:#555;">Uncaptured: ${uncapturedBalt.patches}p (${formatK(uncapturedBalt.resources)})</div>`;

    const fairColor = fairness > 0.9 ? '#00ff88' : fairness > 0.7 ? '#ffcc00' : '#ff4444';
    html += `<div class="fairness-score" style="color:${fairColor};">Fairness: ${(fairness * 100).toFixed(1)}%</div>`;

    if (numExcluded > 0) {
      html += `<div style="font-size:11px;color:#ff4444;margin-top:2px;text-align:center;">${numExcluded} patch(es) excluded</div>`;
    }

    // Biotics table (Aliens) — only show if aliens are placed
    if (hqs.Alien.length > 0) {
      html += '<div style="font-size:11px;color:#8899aa;margin-top:8px;margin-bottom:4px;">Biotics (Alien)</div>';
      html += '<table class="balance-table">';
      html += '<tr><th></th><th class="alien-col">Alien</th></tr>';

      const alienTiers = Object.keys(stats.Alien).sort();
      for (const tier of alienTiers) {
        const a = stats.Alien[tier];
        html += `<tr><td>${tier}</td><td class="alien-col">${a.patches}p ${formatK(a.resources)}</td></tr>`;
      }
      html += `<tr style="border-top:1px solid #0f3460;">
        <td><b>Total</b></td>
        <td class="alien-col"><b>${totals.Alien.patches}p ${formatK(totals.Alien.resources)}</b></td>
      </tr>`;
      html += '</table>';
      html += `<div style="margin-top:4px;font-size:11px;color:#555;">Uncaptured Biotics: ${uncapturedBio.patches}p (${formatK(uncapturedBio.resources)})</div>`;
    }

    panel.innerHTML = html;
  }

  function formatK(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
    return `${n}`;
  }

  function formatSliderK(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
    return `${n}`;
  }

  async function importLayout(data) {
    // 1. Switch map
    const mapName = data.map;
    if (!mapName) throw new Error('No map name in layout');

    const selector = document.getElementById('map-selector');
    selector.value = mapName;
    await App.loadMap(mapName);

    // 2. Apply settings
    if (data.settings) {
      const s = data.settings;
      // Support old single buildRadius and new per-faction build radii
      const solBR = s.solBuildRadius ?? s.buildRadius;
      const centBR = s.centBuildRadius ?? s.buildRadius;
      if (solBR !== undefined) {
        document.getElementById('setting-sol-build-radius').value = solBR;
        document.getElementById('val-sol-build-radius').textContent = `${solBR}m`;
        Placement.setSolBuildRadius(solBR);
      }
      if (centBR !== undefined) {
        document.getElementById('setting-cent-build-radius').value = centBR;
        document.getElementById('val-cent-build-radius').textContent = `${centBR}m`;
        Placement.setCentBuildRadius(centBR);
      }
      // Support old single chainRange and new per-faction chain ranges
      if (s.solChainRange !== undefined) {
        document.getElementById('setting-sol-chain-range').value = s.solChainRange;
        document.getElementById('val-sol-chain-range').textContent = `${s.solChainRange}m`;
        Placement.setSolChainRange(s.solChainRange);
      } else if (s.chainRange !== undefined) {
        document.getElementById('setting-sol-chain-range').value = s.chainRange;
        document.getElementById('val-sol-chain-range').textContent = `${s.chainRange}m`;
        Placement.setSolChainRange(s.chainRange);
      }
      if (s.centChainRange !== undefined) {
        document.getElementById('setting-cent-chain-range').value = s.centChainRange;
        document.getElementById('val-cent-chain-range').textContent = `${s.centChainRange}m`;
        Placement.setCentChainRange(s.centChainRange);
      } else if (s.chainRange !== undefined) {
        document.getElementById('setting-cent-chain-range').value = s.chainRange;
        document.getElementById('val-cent-chain-range').textContent = `${s.chainRange}m`;
        Placement.setCentChainRange(s.chainRange);
      }
      // Support old single alienChainRange and new per-type ranges
      const alienNodeR = s.alienNodeChainRange ?? s.alienChainRange;
      const alienBcR = s.alienBiocacheChainRange ?? s.alienChainRange;
      if (alienNodeR !== undefined) {
        document.getElementById('setting-alien-node-range').value = alienNodeR;
        document.getElementById('val-alien-node-range').textContent = `${alienNodeR}m`;
        Placement.setAlienNodeChainRange(alienNodeR);
      }
      if (alienBcR !== undefined) {
        document.getElementById('setting-alien-bc-range').value = alienBcR;
        document.getElementById('val-alien-bc-range').textContent = `${alienBcR}m`;
        Placement.setAlienBiocacheChainRange(alienBcR);
      }
    }

    // 3. Apply resource amounts
    if (data.resources) {
      const r = data.resources;
      if (r.balterium_amount !== undefined || r.biotics_amount !== undefined) {
        const balt = r.balterium_amount || 0;
        const bio = r.biotics_amount || 0;
        document.getElementById('setting-balt-amount').value = balt;
        document.getElementById('val-balt-amount').textContent = formatSliderK(balt);
        document.getElementById('setting-bio-amount').value = bio;
        document.getElementById('val-bio-amount').textContent = formatSliderK(bio);
        Layers.setResourceAmounts(balt, bio);
      }

      // 4. Apply excluded patches
      if (r.removed_patches && r.removed_patches.length > 0) {
        Layers.setExcludedPatches(new Set(r.removed_patches));
      }

      // 5. Apply per-patch overrides
      if (r.patch_overrides) {
        Layers.setPatchOverrides(r.patch_overrides);
      }
    }

    // 6. Place HQs
    if (data.spawns) {
      // Detect format: web tool export has arrays, server config has variant objects
      const firstValue = Object.values(data.spawns)[0];
      if (Array.isArray(firstValue)) {
        // Web tool export format: spawns.Sol = [{x, z, isSpawn, isBiocache}, ...]
        for (const faction of ['Sol', 'Cent', 'Alien']) {
          const entries = data.spawns[faction];
          if (!entries || !Array.isArray(entries)) continue;
          for (const entry of entries) {
            Placement.addHQAt(faction, entry.x, entry.z, entry.isSpawn || false, entry.isBiocache || false);
          }
        }
      } else {
        // Server config format: spawns.variant_A.Sol = {x, z}
        const variant = data.spawns.variant_A || Object.values(data.spawns)[0];
        if (variant) {
          for (const faction of ['Sol', 'Cent', 'Alien']) {
            const pos = variant[faction];
            if (!pos || pos.x === undefined) continue;
            Placement.addHQAt(faction, pos.x, pos.z, true, false);
          }
        }
      }
    }

    // 7. Place footprints
    if (data.footprints && Array.isArray(data.footprints)) {
      for (const fp of data.footprints) {
        // Support both old boolean 'rotated' and new integer 'rotation'
        const rot = fp.rotation !== undefined ? fp.rotation : (fp.rotated ? 1 : 0);
        Placement.placeFootprintAt(fp.type, fp.x, fp.z, rot);
      }
    }

    // 8. Game modes
    if (data.game_modes) {
      document.getElementById('mode-hvh').checked = data.game_modes.hvh ?? true;
      document.getElementById('mode-hva').checked = data.game_modes.hva ?? true;
      document.getElementById('mode-hvhva').checked = data.game_modes.hvhva ?? true;
    }
  }

  return { init, updateBalance };
})();
