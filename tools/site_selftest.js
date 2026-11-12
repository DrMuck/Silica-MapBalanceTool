#!/usr/bin/env node
// Checks of the shared base-site module js/sites.js (docs/SITE_SCAN.md):
//
//   node tools/site_selftest.js                         decode check only (all data/sites PNGs)
//   node tools/site_selftest.js --layouts <Spawns dir> --csv <site_audit.csv> [--rules v1]
//
// 1. Decode: every data/sites PNG decoded by Sites.decodePng (the browser's code path, here with
//    zlib instead of DecompressionStream) equals pngjs byte for byte.
// 2. Reproduction: Sites.auditLayout over every layout of <Spawns dir> against tools/site_audit.py's
//    site_audit.csv, row for row (structures, codes, today's yaws, valid yaws, valid today, why, tier,
//    fix rot/x/z/d/margin, open raw/reach/cells, low open). --rules v1 = the rules of the first
//    site_audit.py (no 2v1 swap, no shared hva spot); default = SITE_SCAN.md section 8.
// Exit 1 on any difference.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Sites = require('../js/sites.js');

const ROOT = path.resolve(__dirname, '..');
const SITES = path.join(ROOT, 'data', 'sites');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function decodeCheck() {
  const { PNG } = require('pngjs');
  let n = 0, bad = 0;
  for (const f of fs.readdirSync(SITES).filter(f => f.endsWith('.png')).sort()) {
    const bytes = fs.readFileSync(path.join(SITES, f));
    const mine = await Sites.decodePng(new Uint8Array(bytes), d => new Uint8Array(zlib.inflateSync(d)));
    const ref = PNG.sync.read(bytes);   // RGBA
    let diff = 0;
    for (let i = 0; i < mine.width * mine.height; i++) {
      for (let c = 0; c < mine.channels; c++) {
        const want = mine.channels === 1 ? ref.data[i * 4] : ref.data[i * 4 + c];
        if (mine.data[i * mine.channels + c] !== want) diff++;
      }
    }
    if (mine.width !== ref.width || mine.height !== ref.height || diff) { bad++; console.log(`DECODE ${f}: ${diff} bytes differ`); }
    n++;
  }
  console.log(`decode: ${n} PNGs, ${bad} differ from pngjs`);
  return bad === 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** Python-style text of a value as csv.DictWriter writes it. */
const py = {
  bool: v => (v ? 'True' : 'False'),
  float: v => {   // repr of a float: 555.0, 0.87
    if (v === null || v === undefined) return '';
    return Number.isInteger(v) ? `${v}.0` : String(v);
  },
  int: v => (v === null || v === undefined ? '' : String(v)),
};

function walk(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (f.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

async function reproduce(layoutsDir, csvFile, rules) {
  const want = parseCsv(fs.readFileSync(csvFile, 'utf8'));
  const byKey = new Map(want.map(r => [`${r.map}|${r.folder}|${r.file}|${r.entry}`, r]));
  const maps = fs.readdirSync(layoutsDir).filter(d => fs.statSync(path.join(layoutsDir, d)).isDirectory()).sort();
  const io = Sites.nodeIO(SITES);
  let rowsN = 0, diffRows = 0, missing = 0;
  const seen = new Set(), fieldDiffs = {};
  for (const m of maps) {
    const sd = await Sites.load(m, io);
    if (!sd) { console.log(`${m}: no site data`); continue; }
    const mdir = path.join(layoutsDir, m);
    const files = walk(mdir).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    for (const p of files) {
      let folder = path.relative(mdir, path.dirname(p)).replace(/\\/g, '/');
      const L = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
      for (const r of Sites.auditLayout(sd, L, rules)) {
        rowsN++;
        const key = `${m}|${folder}|${path.basename(p)}|${r.entry}`;
        seen.add(key);
        const w = byKey.get(key);
        if (!w) { missing++; console.log(`MISSING in csv: ${key}`); continue; }
        const got = {
          structures: r.structs.join('+'),
          valid_today: py.bool(r.validToday),
          why_today: r.why,
          tier: String(r.tier),
          low_open: py.bool(r.lowOpen),
          open_raw: r.open ? py.float(r.open.raw) : '',
          open_reach: r.open ? py.float(r.open.reach) : '',
          open_cells: r.open ? py.int(r.open.cells) : '',
        };
        const fx = r.fix || r.far || null;
        got.fix_rot = fx ? String(fx.rot) : '';
        got.fix_x = fx ? py.float(fx.x) : '';
        got.fix_z = fx ? py.float(fx.z) : '';
        got.fix_d = fx ? String(fx.d) : '';
        got.fix_margin = r.fix ? String(r.fix.margin) : '';
        for (const t of r.today) {
          got[`code_${t.struct}`] = String(t.code);
          got[`yaw_${t.struct}`] = py.float(Math.round(t.yaw * 10) / 10);
          got[`yaw_exact_${t.struct}`] = py.bool(t.exact);
          got[`valid_yaws_${t.struct}`] = t.validYaws.join('/') || '-';
        }
        let diff = false;
        for (const [k, v] of Object.entries(got)) {
          // numbers by value: the csv has 675 (numpy int, tier 3) and 555.0 (float, tier 2)
          const same = w[k] === v || (w[k] !== '' && v !== '' && !Number.isNaN(Number(w[k])) && Number(w[k]) === Number(v));
          if (!same) {
            diff = true;
            fieldDiffs[k] = (fieldDiffs[k] || 0) + 1;
            if ((fieldDiffs[k] || 0) <= 5) console.log(`DIFF ${key} ${k}: csv '${w[k]}' js '${v}'`);
          }
        }
        if (diff) diffRows++;
      }
    }
  }
  const extra = want.filter(r => !seen.has(`${r.map}|${r.folder}|${r.file}|${r.entry}`)).length;
  console.log(`reproduction (${rules && rules.sharedSpot === false ? 'rules v1' : 'rules SITE_SCAN.md'}): ` +
    `${rowsN} rows, csv ${want.length}, differing rows ${diffRows}, missing in csv ${missing}, csv rows not produced ${extra}` +
    (Object.keys(fieldDiffs).length ? `; fields: ${JSON.stringify(fieldDiffs)}` : ''));
  return diffRows === 0 && missing === 0 && extra === 0 && rowsN === want.length;
}

(async () => {
  let ok = await decodeCheck();
  const layouts = arg('--layouts'), csv = arg('--csv');
  if (layouts && csv) {
    const rules = arg('--rules') === 'v1' ? { swap2v1: false, sharedSpot: false } : undefined;
    ok = (await reproduce(layouts, csv, rules)) && ok;
  }
  console.log(ok ? 'OK' : 'FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
