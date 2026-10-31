// Patch plan for a spawn set (spec section 4): equalise the starting kit, then cover the map.
// UMD, DOM-free; reads ctx.ctrl (GenGrid.build) and an optional Fields object.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenPatches = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = ['Balterium', 'Biotics'];

  function radii(settings) {
    const r = (settings && settings.radii) || {};
    return { build: r.build || 1000, chain: r.chain || 2500, nest: r.nest || 1200 };
  }

  /**
   * Exact start-kit setting (spec 13.1): null when auto (null / undefined / ''), the integer when
   * it is a whole number >= 0, NaN when set but invalid (GenSearch.run reports that as infeasible
   * before any plan is made; plan() treats NaN as auto).
   */
  function exactOf(v) {
    if (v === null || v === undefined || v === '') return null;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : NaN;
  }
  function exactKits(settings) {
    const h = exactOf(settings && settings.kitExact), a = exactOf(settings && settings.nestKitExact);
    return { human: Number.isNaN(h) ? null : h, alien: Number.isNaN(a) ? null : a };
  }

  function distTo(ctx, c, k) {
    if (c.pd) return c.pd[k];
    const p = ctx.patches[k];
    return Math.hypot(p.x - c.x, p.z - c.z);
  }

  /**
   * PatchPlan for set {Sol?, Cent?, Alien?} (hva: Sol === Cent).
   * fields: GenGrid.fields result (geodesic order of the kit) or null (Euclidean order).
   * hooks.rank(patch, side) -> number (metres added to the coverage pick distance; lower =
   * preferred; side = role owning the patch's control cell, or null).
   * settings.kitCapAuto (default true): when the capped kit would freeze away so many
   * Balterium that the total cannot be met (small maps, overlapping radii), k is raised up to
   * the largest kit every human can get.
   * Extras beyond spec 8.2: target {Balterium, Biotics} (the kept total G4 asks for: the
   * requested count, or every patch not removed by the kit when the request is >= vanilla),
   * vanilla counts, kitK {human, alien} (kit size used), available {type: n} (pool left for the
   * fill), paired (number of paired adds, step 3; 0 = the plan never read the human regions),
   * layer {Sol, Cent} (spec 12.5: own-side kept Balterium with R_b < d <= reach*R_c + R_b),
   * layerCap {deflected, forced} (fill picks moved by the layer cap of spec 12.3 / taken
   * although inadmissible because no admissible patch was left).
   * Exact kits (spec 13.3, settings.kitExact / nestKitExact not null): k = n per human with no
   * paired adds, the m nearest Biotics inside R_n kept and the rest there removed; the plan then
   * also carries exact {human, alien}, achievable {Balterium, Biotics} (kept counts reached) and
   * failures: 'kit_exact' | 'nest_exact' (kit not reachable), 'kit_total' | 'nest_total' (the
   * fill pool ran dry below the requested total because of the frozen-removed radii).
   */
  function plan(ctx, settings, set, fields, hooks) {
    const P = ctx.patches, nP = P.length, ctrl = ctx.ctrl;
    const R = radii(settings);
    const rank = hooks && typeof hooks.rank === 'function' ? hooks.rank : null;
    const counts = (settings && settings.counts) || {};
    const want = { Balterium: counts.balterium, Biotics: counts.biotics };
    const vanilla = { Balterium: 0, Biotics: 0 };
    for (const p of P) vanilla[p.type]++;
    for (const t of TYPES) if (want[t] === undefined || want[t] === null) want[t] = Math.round(0.75 * vanilla[t]);

    const keep = new Uint8Array(nP), frozen = new Uint8Array(nP);
    // spec 13.3: exact kits (null = auto); failures names a kit the set cannot reach (G3 fails)
    const exact = exactKits(settings), failures = [];
    const geo =(role, c, k) => {
      const D = fields && fields.D && fields.D[role];
      return D ? D[ctrl.patchCell[k]] : distTo(ctx, c, k);
    };
    const nearestFirst = (role, c, list) => list
      .map(k => ({ k, g: geo(role, c, k), e: distTo(ctx, c, k) }))
      .sort((a, b) => (a.g - b.g) || (a.e - b.e) || (P[a.k].idx - P[b.k].idx))
      .map(o => o.k);

    // 1. Balterium kit, human positions. A patch inside both humans' R_b (shared) counts for
    // both kits; shared patches are kept only when the exclusive ones run out, so every human
    // ends with exactly k kept Balterium inside R_b. All Balterium inside any R_b is frozen.
    const humans = [];
    for (const r of ['Sol', 'Cent']) if (set[r] && !humans.some(h => h.c === set[r])) humans.push({ role: r, c: set[r] });
    const nBal = vanilla.Balterium;
    const inR = humans.map(hm => {
      const a = new Uint8Array(nP);
      for (let k = 0; k < nP; k++) if (P[k].type === 'Balterium' && distTo(ctx, hm.c, k) <= R.build) a[k] = 1;
      return a;
    });
    let kH = 0;
    if (humans.length) {
      const shared = [], excl = humans.map(() => []);
      let union = 0;
      for (let k = 0; k < nP; k++) {
        let cnt = 0, last = -1;
        for (let i = 0; i < humans.length; i++) if (inR[i][k]) { cnt++; last = i; }
        if (!cnt) continue;
        union++;
        frozen[k] = 1;
        if (cnt > 1) shared.push(k); else excl[last].push(k);
      }
      const exOrder = humans.map((hm, i) => nearestFirst(hm.role, hm.c, excl[i]));
      const shOrder = shared
        .map(k => ({ k, g: Math.max(...humans.map(hm => geo(hm.role, hm.c, k))), e: Math.max(...humans.map(hm => distTo(ctx, hm.c, k))) }))
        .sort((a, b) => (a.g - b.g) || (a.e - b.e) || (P[a.k].idx - P[b.k].idx))
        .map(o => o.k);
      const e = Math.min(...exOrder.map(l => l.length)), kMax = e + shared.length;
      const nShared = k => Math.max(0, k - e);
      const kitTotal = k => humans.length * k - (humans.length - 1) * nShared(k);
      if (exact.human !== null) {
        // spec 13.3: k = n exactly, kitCap / kitCapAuto ignored; kMax < n -> the set cannot
        // give every human n (failure 'kit_exact', G3 fails), the plan keeps what it can
        kH = Math.min(kMax, exact.human);
        if (kMax < exact.human) failures.push('kit_exact');
      } else {
        const cap = settings && settings.kitCap !== null && settings.kitCap !== undefined
          ? settings.kitCap : Math.floor(want.Balterium / (2 * humans.length));
        kH = Math.max(0, Math.min(kMax, cap));
        // kitCapAuto (default on): raise k above the cap when the capped kit would freeze away
        // so many patches that the Balterium total can no longer be met
        const outside = nBal - union;
        if (!(settings && settings.kitCapAuto === false) && want.Balterium < nBal) {
          while (kH < kMax && kitTotal(kH) + outside < want.Balterium && kitTotal(kH + 1) <= want.Balterium) kH++;
        }
      }
      const s = nShared(kH);
      for (let q = 0; q < s; q++) keep[shOrder[q]] = 1;
      for (const l of exOrder) for (let q = 0; q < kH - s; q++) keep[l[q]] = 1;
    }

    // 2. Biotics kit, Nest: keep up to min(n_A, N_O / nSides) nearest inside R_n and freeze
    // those (the rest inside R_n stays available to the coverage fill). The cap per mode is
    // the Nest's fair share of the Biotics: N_O/2 in hva, N_O/3 in hvhva (T2 compares shares).
    let kA = 0;
    if (set.Alien) {
      const c = set.Alien, l = [];
      for (let k = 0; k < nP; k++) if (P[k].type === 'Biotics' && distTo(ctx, c, k) <= R.nest) l.push(k);
      const order = nearestFirst('Alien', c, l);
      if (exact.alien !== null) {
        // spec 13.3: the m nearest stay, every other Biotics inside R_n is frozen as removed
        kA = Math.min(l.length, exact.alien);
        if (l.length < exact.alien) failures.push('nest_exact');
        for (const k of l) frozen[k] = 1;
      } else kA = Math.min(l.length, alienKitCap(want.Biotics, humans.length));
      for (let q = 0; q < kA; q++) { frozen[order[q]] = 1; keep[order[q]] = 1; }
    }

    // 3. coverage fill: farthest-first k-center over the playable control cells.
    // best[c] = distance to the nearest kept patch of the type (-Inf on non-playable cells);
    // a new patch can only lower cells closer than the current maximum, so each update scans
    // the box of half-width max/cell around the patch and refreshes the 8x8-cell block maxima.
    // Paired add (Balterium, request < vanilla): the kit-removed patches inside the human radii
    // join the pool tagged with the humans whose R_b contains them (bit i = human i). A pick
    // tagged for some humans only is taken together with one partner per other human: that
    // human's exclusive tagged patch that most lowers the largest blank inside its own R_b
    // (ties: nearest to that cell, idx). No partner left or no budget for the pair -> the pick
    // is dropped and the next-nearest patch is tried. A patch inside every radius needs no
    // partner. So the kept counts inside the radii grow in step and G3 stays exact.
    const target = {}, gap = {}, available = {};
    const tag = new Uint8Array(nP), allMask = (1 << humans.length) - 1;
    for (let k = 0; k < nP; k++) {
      if (P[k].type !== 'Balterium' || keep[k]) continue;
      for (let i = 0; i < humans.length; i++) if (inR[i][k]) tag[k] |= 1 << i;
    }
    // Layer cap (spec 12.3): zone[k] = human i when Balterium k lies on i's side (fields.owner
    // of its control cell; Euclidean fallback: nearer to i than to every other structure) with
    // R_b < d(k, s_i) <= reach*R_c + R_b, else -1. layer[i] = kept patches in i's zone. A fill
    // pick in zone i is inadmissible while layer[i] >= layer[j] + 2 for some other human j;
    // the nearest admissible patch to the farthest cell is taken instead, the nearest one when
    // none is admissible (coverage wins). Paired adds inside the kits are exempt.
    const zone = layerZones(ctx, settings, set, fields), layerN = new Int32Array(humans.length);
    for (let k = 0; k < nP; k++) if (zone[k] >= 0 && keep[k]) layerN[zone[k]]++;
    const capOn = humans.length > 1;
    const admissible = k => {
      const i = zone[k];
      if (i < 0) return true;
      for (let j = 0; j < humans.length; j++) if (j !== i && layerN[i] >= layerN[j] + 2) return false;
      return true;
    };
    const keepB = k => { if (zone[k] >= 0) layerN[zone[k]]++; };
    let capDeflected = 0, capForced = 0;
    let regions = null, nPaired = 0;
    // playable control cells whose centre lies within R_b of each human (built on first use)
    const regionsOf = () => {
      if (regions) return regions;
      regions = humans.map(hm => {
        const out = [], r2 = R.build * R.build;
        for (let c = 0; c < ctrl.n * ctrl.n; c++) {
          if (!ctrl.playable[c]) continue;
          const dx = ctrl.cx[c] - hm.c.x, dz = ctrl.cz[c] - hm.c.z;
          if (dx * dx + dz * dz <= r2) out.push(c);
        }
        return out;
      });
      return regions;
    };
    const n = ctrl.n, N = n * n, cell = ctrl.cell, BS = 8, nb = Math.ceil(n / BS);
    const play = ctrl.playable, PD = ctrl.patchDist, PC = ctrl.patchCell;
    const best = new Float32Array(N), bMax = new Float32Array(nb * nb), bArg = new Int32Array(nb * nb);
    const sideOfCell = ci => (fields && fields.owner && fields.sides && fields.owner[ci] >= 0 ? fields.sides[fields.owner[ci]] : null);
    let mx = 0, jm = 0;
    const blockMax = (bi, bj) => {
      let m = -Infinity, a = -1;
      const j1 = Math.min(n, (bj + 1) * BS), i1 = Math.min(n, (bi + 1) * BS);
      for (let j = bj * BS; j < j1; j++) {
        const row = j * n;
        for (let i = bi * BS; i < i1; i++) if (best[row + i] > m) { m = best[row + i]; a = row + i; }
      }
      bMax[bj * nb + bi] = m; bArg[bj * nb + bi] = a;
    };
    const globalMax = () => {
      mx = -Infinity; jm = -1;
      for (let b = 0; b < nb * nb; b++) if (bMax[b] > mx) { mx = bMax[b]; jm = bArg[b]; }
    };
    // Only cells closer than mx can drop; per row the scanned span is the chord of that disc
    // (with one cell of slack for the patch's offset inside its cell). A block is recomputed
    // only when its current argmax cell dropped (values only ever decrease).
    const dirty = new Int32Array(nb * nb), dirtyList = new Int32Array(nb * nb);
    let stamp = 0;
    const absorb = k => {
      const d = PD[k];
      const full = mx === Infinity;
      const pi = PC[k] % n, pj = (PC[k] - pi) / n;
      const span = full ? n : Math.ceil(mx / cell) + 1;
      const j0 = Math.max(0, pj - span), j1 = Math.min(n - 1, pj + span);
      stamp++;
      let nd = 0;
      for (let j = j0; j <= j1; j++) {
        let i0 = 0, i1 = n - 1;
        if (!full) {
          const dz = Math.max(0, Math.abs(j - pj) - 1) * cell;
          if (dz >= mx) continue;
          const half = Math.ceil(Math.sqrt(mx * mx - dz * dz) / cell) + 1;
          i0 = Math.max(0, pi - half); i1 = Math.min(n - 1, pi + half);
        }
        const row = j * n, rb = (j >> 3) * nb;
        for (let i = i0; i <= i1; i++) {
          const c = row + i;
          if (d[c] < best[c]) {
            best[c] = d[c];
            const b = rb + (i >> 3);
            if (bArg[b] === c && dirty[b] !== stamp) { dirty[b] = stamp; dirtyList[nd++] = b; }
          }
        }
      }
      for (let q = 0; q < nd; q++) { const b = dirtyList[q]; blockMax(b % nb, (b - b % nb) / nb); }
      if (nd) globalMax();
    };
    for (const t of TYPES) {
      let keptT = 0, frozenRemoved = 0;
      const pool = [];
      // exact human kit (spec 13.3): no paired adds, the in-radius pool stays empty
      const paired = t === 'Balterium' && humans.length > 0 && want[t] < vanilla[t] && exact.human === null;
      for (let k = 0; k < nP; k++) {
        if (P[k].type !== t) continue;
        if (keep[k]) keptT++;
        else if (frozen[k] && !(paired && tag[k])) frozenRemoved++;
        else pool.push(k);
      }
      target[t] = want[t] >= vanilla[t] ? vanilla[t] - frozenRemoved : want[t];
      available[t] = pool.length;
      const bias = new Float64Array(nP);
      if (rank) for (const k of pool) bias[k] = +rank(P[k], sideOfCell(PC[k])) || 0;

      for (let c = 0; c < N; c++) best[c] = play[c] ? Infinity : -Infinity;
      for (let bj = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++) blockMax(bi, bj);
      globalMax();
      for (let k = 0; k < nP; k++) if (keep[k] && P[k].type === t) absorb(k);
      let m = target[t] - keptT;
      const cap = capOn && t === 'Balterium';
      while (m > 0 && pool.length && jm >= 0) {
        let bi = -1, bv = Infinity, ai = -1, av = Infinity;
        for (let q = 0; q < pool.length; q++) {
          const k = pool[q], v = PD[k][jm] + bias[k];
          if (bi < 0 || v < bv || (v === bv && P[k].idx < P[pool[bi]].idx)) { bv = v; bi = q; }
          if (cap && (ai < 0 || v < av || (v === av && P[k].idx < P[pool[ai]].idx))
            && ((paired && tag[k]) || admissible(k))) { av = v; ai = q; }
        }
        if (cap) {
          if (ai < 0) capForced++;
          else if (ai !== bi) { capDeflected++; bi = ai; }
        }
        const k = pool[bi];
        pool.splice(bi, 1);
        const tg = paired ? tag[k] : 0;
        if (tg && tg !== allMask) {
          const need = [];
          for (let i = 0; i < humans.length; i++) if (!(tg & (1 << i))) need.push(i);
          // dropped for good: the budget and the partner pools only shrink
          if (m < 1 + need.length) continue;
          if (!need.every(i => pool.some(q => tag[q] === 1 << i))) continue;
          keep[k] = 1;
          keepB(k);
          absorb(k);
          m--;
          for (const i of need) {
            const q = pickPartner(pool, tag, 1 << i, regionsOf()[i], best, PD, bias, P);
            const kq = pool[q];
            pool.splice(q, 1);
            keep[kq] = 1;
            keepB(kq);
            absorb(kq);
            m--;
          }
          nPaired++;
          continue;
        }
        keep[k] = 1;
        keepB(k);
        absorb(k);
        m--;
      }
      gap[t] = jm >= 0 ? mx : 0;
    }

    // 4. outputs
    const kept = { Balterium: [], Biotics: [] }, removed = [], frozenSet = new Set();
    for (let k = 0; k < nP; k++) {
      if (keep[k]) kept[P[k].type].push(P[k].idx); else removed.push(P[k].idx);
      if (frozen[k]) frozenSet.add(P[k].idx);
    }
    kept.Balterium.sort((a, b) => a - b);
    kept.Biotics.sort((a, b) => a - b);
    removed.sort((a, b) => a - b);

    const am = (settings && settings.amounts) || {};
    const amountOf = p => (p.type === 'Balterium' ? am.balterium : am.biotics) || p.amount || 0;
    const kit = {}, rings = {};
    for (const r of ['Sol', 'Cent', 'Alien']) {
      const c = set[r];
      if (!c) continue;
      const t = r === 'Alien' ? 'Biotics' : 'Balterium', R0 = r === 'Alien' ? R.nest : R.build, R1 = R0 + R.chain;
      const r0 = { n: 0, amount: 0 }, r1 = { n: 0, amount: 0 };
      for (let k = 0; k < nP; k++) {
        if (!keep[k] || P[k].type !== t) continue;
        const d = distTo(ctx, c, k);
        if (d <= R0) { r0.n++; r0.amount += amountOf(P[k]); }
        else if (d <= R1) { r1.n++; r1.amount += amountOf(P[k]); }
      }
      kit[r] = r0.n;
      rings[r] = { r0, r1 };
    }

    // layer per human role (spec 12.5; hva: Sol and Cent alias the one human), from the final keep
    const layer = {};
    const layerFinal = new Int32Array(humans.length);
    for (let k = 0; k < nP; k++) if (keep[k] && zone[k] >= 0) layerFinal[zone[k]]++;
    for (const r of ['Sol', 'Cent']) {
      const i = humans.findIndex(hm => hm.c === set[r]);
      if (i >= 0) layer[r] = layerFinal[i];
    }

    const out = { kept, removed, frozen: frozenSet, kit, rings, gap, target, vanilla, kitK: { human: kH, alien: kA }, available, paired: nPaired,
      layer, layerCap: { deflected: capDeflected, forced: capForced } };
    // exact mode only (an auto plan keeps the round-3 shape): the kits asked for and the misses
    if (exact.human !== null || exact.alien !== null) {
      // spec 13.3 / 13.5: the frozen-removed patches inside the radii can leave the fill pool
      // too small for the requested total -> 'kit_total' (Balterium) / 'nest_total' (Biotics);
      // achievable = the kept count this plan reaches
      out.achievable = { Balterium: kept.Balterium.length, Biotics: kept.Biotics.length };
      if (kept.Balterium.length < target.Balterium) failures.push('kit_total');
      if (kept.Biotics.length < target.Biotics) failures.push('nest_total');
      out.exact = { human: exact.human, alien: exact.alien };
      out.failures = failures;
    }
    return out;
  }

  /**
   * Layer zones (spec 12.3/12.5), per patch k of ctx.patches: index of the human (distinct
   * structures in the order Sol, Cent) whose expansion layer holds Balterium k, else -1. In the
   * layer = on that human's side (fields.owner of the patch's control cell; without fields:
   * strictly nearer to it than to every other structure of the set) and
   * R_b < d(k, s_i) <= reach*R_c + R_b (Euclidean). plan() reads the set's positions beyond the
   * kit orders only through this array, so a plan cache keyed on the kit orders must add it.
   */
  function layerZones(ctx, settings, set, fields) {
    const P = ctx.patches, nP = P.length, R = radii(settings);
    const ex = (settings && settings.expansion) || {};
    const layerR = (ex.reach > 0 ? ex.reach : 0.85) * R.chain + R.build;
    const humans = [], structs = [];
    for (const r of ['Sol', 'Cent']) if (set[r] && !humans.some(h => h.c === set[r])) humans.push({ role: r, c: set[r] });
    for (const r of ['Sol', 'Cent', 'Alien']) if (set[r] && !structs.includes(set[r])) structs.push(set[r]);
    const own = fields && fields.owner && fields.sides ? fields : null, PC = ctx.ctrl.patchCell;
    const zone = new Int8Array(nP).fill(-1);
    for (let k = 0; k < nP; k++) {
      if (P[k].type !== 'Balterium') continue;
      for (let i = 0; i < humans.length; i++) {
        const d = distTo(ctx, humans[i].c, k);
        if (d <= R.build || d > layerR) continue;
        let mine;
        if (own) {
          const o = own.owner[PC[k]];
          mine = o >= 0 && own.sides[o] === humans[i].role;
        } else {
          mine = structs.every(c => c === humans[i].c || distTo(ctx, c, k) > d);
        }
        if (mine) { zone[k] = i; break; }
      }
    }
    return zone;
  }

  /** Nest kit cap per mode: the Nest's fair share of the Biotics budget, N_O / (humans + 1). */
  function alienKitCap(nO, nHumans) {
    return Math.floor(nO / (Math.max(1, nHumans) + 1));
  }

  /**
   * Paired-add partner (step 3): pool index of the patch tagged exactly `mask` that leaves the
   * smallest largest-blank over the human's region; ties by the distance (+ rank bias) to the
   * region's current farthest cell, then idx.
   */
  function pickPartner(pool, tag, mask, region, best, PD, bias, P) {
    let fc = -1, fmax = -Infinity;
    for (const c of region) if (best[c] > fmax) { fmax = best[c]; fc = c; }
    let bq = -1, bMax = Infinity, bFar = Infinity;
    for (let q = 0; q < pool.length; q++) {
      const k = pool[q];
      if (tag[k] !== mask) continue;
      const d = PD[k];
      let mx = -Infinity;
      for (const c of region) { const v = d[c] < best[c] ? d[c] : best[c]; if (v > mx) mx = v; }
      const far = fc >= 0 ? d[fc] + bias[k] : 0;
      if (bq < 0 || mx < bMax || (mx === bMax && (far < bFar || (far === bFar && P[k].idx < P[pool[bq]].idx)))) {
        bq = q; bMax = mx; bFar = far;
      }
    }
    return bq;
  }

  return { plan, alienKitCap, layerZones, exactOf, exactKits };
}));
