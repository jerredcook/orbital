// tca.worker.js — close-approach search, off both the main thread and the
// position-tick worker.
//
// Protocol:
//   main → worker  { type: 'tca', startIso, horizonHours,
//                    pairs: [{ key, l1a, l2a, l1b, l2b }] }
//   worker → main  { type: 'tca-results',
//                    results: [{ key, tcaMs, missM }] }
//
//   main → worker  { type: 'screen', startIso, horizonHours, reportKm,
//                    targetL1, targetL2, candidates: [{ i, l1, l2 }] }
//   worker → main  { type: 'screen-progress', done, total,
//                    found: [{ i, tcaMs, missM }] }        (incremental)
//   worker → main  { type: 'screen-done' }
//   main → worker  { type: 'screen-cancel' }
//
// The searching itself (the coarse grids, gates and refinement, with their
// caveats) lives in tca.js so it can be unit-tested; this file is the protocol
// and the scheduling.  Screening runs in ~200 ms time slices via setTimeout so
// cancel messages and TCA batches interleave cleanly.

import * as satellite from 'satellite.js';
import { findTca, targetTrack, screenCandidate } from './tca.js';

// ------------------------------------------------------------- screening ----

let activeScreen = null;

function startScreen(msg) {
  const run = { cancelled: false, gen: msg.gen };
  activeScreen = run;

  const startMs = new Date(msg.startIso).getTime();
  const horizonMs = msg.horizonHours * 3.6e6;
  const reportM = msg.reportKm * 1000;

  const track = targetTrack(satellite.twoline2satrec(msg.targetL1, msg.targetL2), startMs, horizonMs);
  const candidates = msg.candidates;
  const total = candidates.length;
  const found = [];
  let idx = 0;

  function processCandidate(c) {
    const rec = satellite.twoline2satrec(c.l1, c.l2);
    if (rec.error !== 0) return;
    const best = screenCandidate(rec, track, reportM);
    if (best) found.push({ i: c.i, ...best });
  }

  function chunk() {
    if (run.cancelled || activeScreen !== run) return;
    const sliceStart = Date.now();
    while (idx < total && Date.now() - sliceStart < 200) {
      processCandidate(candidates[idx++]);
    }
    self.postMessage({ type: 'screen-progress', done: idx, total, found: found.splice(0), gen: run.gen });
    if (idx < total) setTimeout(chunk, 0);
    else self.postMessage({ type: 'screen-done', gen: run.gen });
  }
  chunk();
}

// -------------------------------------------------------------- messages ----

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'screen') { startScreen(msg); return; }
  if (msg.type === 'screen-cancel') {
    if (activeScreen) activeScreen.cancelled = true;
    return;
  }

  if (msg.type !== 'tca') return;
  const startMs = new Date(msg.startIso).getTime();
  const horizonMs = msg.horizonHours * 3.6e6;
  const results = [];
  for (const p of msg.pairs) {
    const recA = satellite.twoline2satrec(p.l1a, p.l2a);
    const recB = satellite.twoline2satrec(p.l1b, p.l2b);
    const hit = findTca(recA, recB, startMs, horizonMs);
    if (hit) results.push({ key: p.key, ...hit });
    else results.push({ key: p.key, tcaMs: null, missM: null });
  }
  self.postMessage({ type: 'tca-results', results, gen: msg.gen });
};
