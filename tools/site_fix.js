#!/usr/bin/env node
// Batch fix of layout JSONs against the base site data (docs/SITE_SCAN.md section 8, js/sites.js).
//
//   node tools/site_fix.js --layouts <Spawns dir> --out <dir> [--report <dir>] [--maps A,B]
//                          [--explicit-rot] [--data <data dir>]
//
// Reads every <Spawns dir>/<Map>/**/*.json (subfolders such as ~disable kept) and writes a copy of
// each to <out>/<Map>/... (never in place; unchanged files are byte copies). Per base
// (spawns.<Sol|Cent|Alien>[0]) the fix order of the user decision 2026-11-12:
//   1. valid as is at today's yaw         -> unchanged (no "rot" written, unless --explicit-rot)
//   2. another of the four yaws, same x/z -> "rot" set
//   3. nearest valid cell within 120 m    -> moved (x, z) + "rot"
//   4. nothing within 120 m               -> not fixable, left as is
// A Sol/Cent spot that can hold either HQ (swap, shared hva position) needs a yaw valid for both.
// For every moved base the report says whether the move changes the resource patches inside that
// base's build radius (layout settings, data/resources/<Map>.json, removed_patches): such moves are
// flagged for human review, because they change the balance of the layout.
// Report: <report>/site_fix_report.csv and site_fix_report.md (default <report> = parent of <out>).
'use strict';

const fs = require('fs');
const path = require('path');
const Sites = require('../js/sites.js');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = { explicitRot: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--layouts') a.layouts = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--report') a.report = argv[++i];
    else if (k === '--maps') a.maps = argv[++i].split(',');
    else if (k === '--data') a.data = argv[++i];
    else if (k === '--explicit-rot') a.explicitRot = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.layouts || !a.out) throw new Error('usage: site_fix.js --layouts <Spawns dir> --out <dir> [--report <dir>] [--maps A,B] [--explicit-rot]');
  a.data = path.resolve(a.data || path.join(ROOT, 'data'));
  a.report = path.resolve(a.report || path.dirname(path.resolve(a.out)));
  return a;
}

function walk(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (f.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out.sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0));
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLS = ['map', 'folder', 'file', 'entry', 'structures', 'action', 'x', 'z', 'yaw_today', 'yaw_src', 'why_today',
  'new_x', 'new_z', 'move_m', 'rot', 'open_reach_before', 'open_reach_after', 'low_open_after', 'kit_changed', 'kit_detail', 'review'];

(async () => {
  const a = parseArgs(process.argv);
  const io = Sites.nodeIO(path.join(a.data, 'sites'));
  const maps = (a.maps || fs.readdirSync(a.layouts).filter(d => fs.statSync(path.join(a.layouts, d)).isDirectory())).sort();
  const rows = [];
  const filesOut = { written: 0, changed: 0 };
  for (const m of maps) {
    const mdir = path.join(a.layouts, m);
    if (!fs.existsSync(mdir)) continue;
    const sd = await Sites.load(m, io);
    const resFile = path.join(a.data, 'resources', `${m}.json`);
    const resources = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : null;
    for (const p of walk(mdir)) {
      const rel = path.relative(mdir, p);
      const folder = path.dirname(rel) === '.' ? '' : path.dirname(rel).replace(/\\/g, '/');
      const text = fs.readFileSync(p, 'utf8');
      const dst = path.join(a.out, m, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      filesOut.written++;
      if (!sd) {
        fs.writeFileSync(dst, text);
        rows.push({ map: m, folder, file: path.basename(p), action: 'no_site_data' });
        continue;
      }
      const L = JSON.parse(text.replace(/^﻿/, ''));
      let changed = false;
      for (const r of Sites.auditLayout(sd, L)) {
        const e = L.spawns[r.entry][0];
        const t0 = r.today[0];
        const row = {
          map: m, folder, file: path.basename(p), entry: r.entry, structures: r.structs.join('+'),
          x: r.x, z: r.z, yaw_today: Math.round(t0.yaw * 10) / 10, yaw_src: t0.src, why_today: r.why,
          open_reach_before: r.open ? r.open.reach : '',
        };
        if (r.tier === 1) {
          row.action = 'unchanged';
          if (a.explicitRot && e.rot === undefined) {
            e.rot = Sites.YAWS[t0.yi];
            row.action = 'rot_explicit';
            row.rot = e.rot;
            changed = true;
          }
        } else if (r.tier === 2) {
          e.rot = r.fix.rot;
          row.action = 'rot';
          row.rot = r.fix.rot;
          changed = true;
        } else if (r.tier === 3) {
          const k = resources ? Sites.kitChange(resources, L, r.structs, r.x, r.z, r.fix.x, r.fix.z) : null;
          e.x = r.fix.x;
          e.z = r.fix.z;
          e.rot = r.fix.rot;
          const o = Sites.openness(sd, r.entry, r.fix.x, r.fix.z);
          Object.assign(row, {
            action: 'moved', new_x: r.fix.x, new_z: r.fix.z, move_m: r.fix.d, rot: r.fix.rot,
            open_reach_after: o ? o.reach : '', low_open_after: Sites.isLowOpen(r.entry, o),
            kit_changed: k ? k.changed : 'no resource data',
            kit_detail: k ? k.details.filter(d => d.lost.length || d.gained.length)
              .map(d => `${d.struct} ${d.type} r${Math.round(d.r)} (${d.radius}) ${d.before}->${d.after}` +
                `${d.lost.length ? ' lost #' + d.lost.join(' #') : ''}${d.gained.length ? ' gained #' + d.gained.join(' #') : ''}`).join('; ') : '',
          });
          if (!k || k.changed) row.review = 'resource kit changes';
          changed = true;
        } else {
          row.action = 'not_fixable';
          row.review = `no valid site within ${Sites.FIX_MAX_M} m` + (r.far ? ` (nearest ${r.far.d} m at ${r.far.x},${r.far.z} rot ${r.far.rot})` : '');
        }
        if (r.lowOpen && row.action !== 'moved') row.low_open_after = true;
        rows.push(row);
      }
      if (changed) {
        filesOut.changed++;
        const bom = text.charCodeAt(0) === 0xFEFF ? '﻿' : '';
        const nl = /\r?\n$/.test(text) ? (text.endsWith('\r\n') ? '\r\n' : '\n') : '';
        let body = JSON.stringify(L, null, 2);
        if (text.includes('\r\n')) body = body.replace(/\n/g, '\r\n');
        fs.writeFileSync(dst, bom + body + nl);
      } else {
        fs.writeFileSync(dst, text);
      }
    }
  }

  fs.mkdirSync(a.report, { recursive: true });
  fs.writeFileSync(path.join(a.report, 'site_fix_report.csv'),
    [COLS.join(',')].concat(rows.map(r => COLS.map(c => csvCell(r[c])).join(','))).join('\n') + '\n');
  fs.writeFileSync(path.join(a.report, 'site_fix_report.md'), markdown(a, rows, filesOut, maps));
  const n = act => rows.filter(r => r.action === act).length;
  console.log(`${filesOut.written} layouts -> ${a.out} (${filesOut.changed} changed); bases: ${rows.length}, unchanged ${n('unchanged')}, ` +
    `rot ${n('rot')}${a.explicitRot ? `, rot_explicit ${n('rot_explicit')}` : ''}, moved ${n('moved')} (kit changes ${rows.filter(r => r.action === 'moved' && r.review).length}), ` +
    `not fixable ${n('not_fixable')}, no site data ${n('no_site_data')}; report -> ${a.report}`);
})().catch(e => { console.error(e); process.exit(1); });

function markdown(a, rows, filesOut, maps) {
  const L = ['# Base site fix of the layouts', '',
    `Input: \`${a.layouts}\`; output: \`${a.out}\` (every layout, changed ones rewritten, the rest byte copies). ` +
    `Tool: \`tools/site_fix.js\` with js/sites.js (docs/SITE_SCAN.md section 8)${a.explicitRot ? ', --explicit-rot' : ''}.`, '',
    'Per base (spawns.<Sol|Cent|Alien>[0]): **unchanged** = valid at the rotation the mod uses today (no `rot` written); ' +
    '**rot** = same position, `rot` set to a rotation that is valid; **moved** = nearest valid cell within 120 m plus its `rot`; ' +
    '**not fixable** = nothing valid within 120 m, left as is. A Sol/Cent spot that can hold either HQ (swap, or one position ' +
    'for both HQs in hva) gets a rotation valid for both.', '',
    'A moved base can reach other resource patches than before. **review** marks every moved base whose patches inside ' +
    'its build radius change (Balterium within the Sol / Cent build radius of the layout settings; Biotics within the Nest ' +
    'build radius and within the effective Nest radius of the balance panel); a person should look at those layouts before ' +
    'they go live.', '',
    `Layouts: ${filesOut.written}, rewritten: ${filesOut.changed}.`, '',
    '| Map | bases | unchanged | rot set | moved | moved, kit changes | not fixable | low open ground |', '|---|---|---|---|---|---|---|---|'];
  const T = { b: 0, u: 0, r: 0, m: 0, k: 0, n: 0, lo: 0 };
  for (const m of maps) {
    const rs = rows.filter(r => r.map === m && r.entry);
    if (!rs.length) continue;
    const c = {
      b: rs.length, u: rs.filter(r => r.action === 'unchanged' || r.action === 'rot_explicit').length,
      r: rs.filter(r => r.action === 'rot').length, m: rs.filter(r => r.action === 'moved').length,
      k: rs.filter(r => r.action === 'moved' && r.review).length, n: rs.filter(r => r.action === 'not_fixable').length,
      lo: rs.filter(r => r.low_open_after === true).length,
    };
    for (const k in T) T[k] += c[k];
    L.push(`| ${m} | ${c.b} | ${c.u} | ${c.r} | ${c.m} | ${c.k} | ${c.n} | ${c.lo} |`);
  }
  L.push(`| **all** | ${T.b} | ${T.u} | ${T.r} | ${T.m} | ${T.k} | ${T.n} | ${T.lo} |`, '');
  const moved = rows.filter(r => r.action === 'moved');
  if (moved.length) {
    L.push('## Moved bases', '', '| layout | base | from | to | m | rot | kit | open reach before / after |', '|---|---|---|---|---|---|---|---|');
    for (const r of moved) {
      L.push(`| ${r.folder ? r.folder + '/' : ''}${r.file} | ${r.structures} | (${r.x}, ${r.z}) | (${r.new_x}, ${r.new_z}) | ${r.move_m} | ${r.rot} | ` +
        `${r.review ? '**REVIEW** ' + r.kit_detail : 'same patches'} | ${r.open_reach_before} / ${r.open_reach_after}${r.low_open_after ? ' LOW' : ''} |`);
    }
    L.push('');
  }
  const nf = rows.filter(r => r.action === 'not_fixable');
  if (nf.length) {
    L.push('## Not fixable', '');
    for (const r of nf) L.push(`- ${r.folder ? r.folder + '/' : ''}${r.file} ${r.structures} (${r.x}, ${r.z}): ${r.why_today}; ${r.review}`);
    L.push('');
  }
  const low = rows.filter(r => r.low_open_after === true);
  if (low.length) {
    L.push('## Little open ground (warning only, never moved for this)', '');
    for (const r of low) L.push(`- ${r.folder ? r.folder + '/' : ''}${r.file} ${r.entry} (${r.new_x ?? r.x}, ${r.new_z ?? r.z}): open reach ${r.action === 'moved' ? r.open_reach_after : r.open_reach_before}`);
    L.push('');
  }
  return L.join('\n');
}
