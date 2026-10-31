// Spawn generator Web Worker (docs/SPAWN_GENERATOR.md section 8.2 protocol):
//   in:  {type: 'run', raw: GenRaw, settings: GenSettings}   |   {type: 'cancel'}
//   out: {type: 'progress', frac, text}*  then  {type: 'done', result: GenResult}
//        or {type: 'error', message}  (a cancelled run posts {type: 'error', message: 'cancelled', cancelled: true})
// The search runs synchronously, so a 'cancel' message is only seen between runs; the page
// cancels a running job with worker.terminate(). Paths are relative to this file (js/gen/).
/* global importScripts, GenContext, GenSearch */
'use strict';

importScripts('../terrain.js', 'rng.js', 'grid.js', 'context.js', 'candidates.js', 'patches.js',
  'metrics.js', 'search.js', 'layout.js');

let cancelRequested = false;

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === 'cancel') { cancelRequested = true; return; }
  if (msg.type !== 'run') return;
  cancelRequested = false;
  try {
    const ctx = GenContext.build(msg.raw, msg.settings);
    let last = -1;
    const result = GenSearch.run(ctx, msg.settings, (frac, text) => {
      // throttle to whole percent steps
      const p = Math.floor(frac * 100);
      if (p === last && frac < 1) return;
      last = p;
      self.postMessage({ type: 'progress', frac, text });
    }, () => cancelRequested);
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({
      type: 'error', message: (err && err.message) || String(err), cancelled: !!(err && err.cancelled),
      stack: err && err.stack ? String(err.stack) : undefined,
    });
  }
};
