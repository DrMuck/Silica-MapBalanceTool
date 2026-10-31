// Seeded RNG for the spawn generator (mulberry32). UMD, DOM-free.
// One stream per run (spec 6.6): consumed only by candidate thinning tie-breaks, stage-1 bucket
// tie-breaks and refinement order.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenRng = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** mulberry32 stream: next() in [0, 1), int(n) in [0, n), shuffle(arr) in place (Fisher-Yates). */
  function create(seed) {
    let a = (Number(seed) >>> 0) || 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function int(n) { return Math.floor(next() * n); }
    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }
    return { next, int, shuffle };
  }

  /** 32-bit FNV-1a of a string as 8 hex digits (e.g. the settings hash in _meta). */
  function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  return { create, hashString };
}));
