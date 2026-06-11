// propagator.worker.js — runs SGP4 for the whole catalog off the main thread.
//
// Protocol:
//   main → worker  { type: 'init', tles: [{ norad, l1, l2 }] }
//   main → worker  { type: 'propagate', isoTime: '…' }
//   worker → main  { type: 'ready', count, bad }            after init
//   worker → main  { type: 'positions', isoTime, buf }       Float64Array
//                   buf layout: [x, y, z, x, y, z, …] in meters, Earth-fixed
//                   (ECF) frame, NaN triple for objects that failed to propagate.

import * as satellite from 'satellite.js';

let satrecs = [];

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    satrecs = [];
    let bad = 0;
    for (const t of msg.tles) {
      const rec = satellite.twoline2satrec(t.l1, t.l2);
      if (rec.error !== 0) bad++;
      satrecs.push(rec);
    }
    self.postMessage({ type: 'ready', count: satrecs.length, bad });
    return;
  }

  if (msg.type === 'propagate') {
    const date = new Date(msg.isoTime);
    const gmst = satellite.gstime(date);
    const n = satrecs.length;
    const buf = new Float64Array(n * 3);

    for (let i = 0; i < n; i++) {
      const pv = satellite.propagate(satrecs[i], date);
      const p = pv?.position;
      if (!p || Number.isNaN(p.x)) {
        buf[i * 3] = NaN; buf[i * 3 + 1] = NaN; buf[i * 3 + 2] = NaN;
        continue;
      }
      const ecf = satellite.eciToEcf(p, gmst);
      buf[i * 3] = ecf.x * 1000;       // km → m
      buf[i * 3 + 1] = ecf.y * 1000;
      buf[i * 3 + 2] = ecf.z * 1000;
    }

    self.postMessage({ type: 'positions', isoTime: msg.isoTime, buf }, [buf.buffer]);
  }
};
