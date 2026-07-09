// passfind.js — the pure minimum-elevation window finder at the heart of the
// pass worker.  Given one above-HORIZON run [runStart, runEnd] and an elevation
// sampler elAt(tMs) → degrees (NaN on propagation failure), return EVERY window
// where the elevation clears minEl: sub-scan the run, refine each above-minEl
// segment independently (an eccentric HEO object makes several apparitions per
// orbit without ever setting between them), with a whole-run fallback for the
// ultra-short pop that clears minEl between two sub-samples.
//
// Parameterized by the sampler so it is unit-testable with synthetic elevation
// profiles — no SGP4, no station geometry (see tests/passfind.test.js).

// Bisect the minEl crossing between a below-minEl time and an above-minEl time.
// Direction-agnostic: works for a rise (tBelow earlier) and a set (tBelow
// later), since each step moves the endpoint whose side matches, never relying
// on the numeric ordering of the two times.
export function crossing(elAt, minEl, tBelow, tAbove) {
  for (let it = 0; it < 24 && Math.abs(tAbove - tBelow) > 500; it++) {
    const tm = (tBelow + tAbove) / 2;
    if (elAt(tm) >= minEl) tAbove = tm; else tBelow = tm;
  }
  return (tBelow + tAbove) / 2;
}

// Peak time within [a, b] by ternary search (elevation is unimodal within one
// above-minEl hump).
export function ternaryPeak(elAt, a, b) {
  while (b - a > 1000) {
    const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
    if (elAt(m1) < elAt(m2)) a = m1; else b = m2;
  }
  return (a + b) / 2;
}

// One window from a single above-minEl hump: peak by ternary between the first
// and last above-minEl sub-samples; exact minEl rise/set by bisection against
// the below-minEl brackets on either side.  Null if the peak misses minEl.
function refine(elAt, minEl, tBelowRise, tAboveRise, tAboveSet, tBelowSet) {
  const peakMs = ternaryPeak(elAt, tAboveRise, tAboveSet);
  const peakEl = elAt(peakMs);
  if (!(peakEl >= minEl)) return null;
  return {
    riseMs: crossing(elAt, minEl, tBelowRise, tAboveRise),
    setMs: crossing(elAt, minEl, tBelowSet, tAboveSet),
    peakMs, peakEl,
  };
}

export function findWindows({ elAt, minEl, runStart, runEnd, subMs = 15_000 }) {
  const ts = [], ab = [];
  for (let t = runStart; t < runEnd; t += subMs) { ts.push(t); ab.push(elAt(t) >= minEl); }
  ts.push(runEnd); ab.push(elAt(runEnd) >= minEl);

  const out = [];
  let a = -1;   // index of the first above-minEl sub-sample of the current segment
  for (let s = 0; s < ts.length; s++) {
    if (ab[s] && a < 0) a = s;
    if ((!ab[s] || s === ts.length - 1) && a >= 0) {
      const b = ab[s] ? s : s - 1;   // last above-minEl sub-sample of the segment
      const w = refine(elAt, minEl, a > 0 ? ts[a - 1] : runStart, ts[a], ts[b], ab[s] ? runEnd : ts[s]);
      if (w) out.push(w);
      a = -1;
    }
  }
  // Short-pop fallback: the peak clears minEl only between two sub-samples.
  // Relies on the run being one smooth hump when NO sub-sample clears minEl —
  // true for orbital geometry (elevation rises from the horizon, peaks, and
  // falls; multi-hump runs always hold ≥ minEl for whole minutes per hump and
  // are caught by the segment scan above).
  if (!out.length) {
    const peakMs = ternaryPeak(elAt, runStart, runEnd);
    const peakEl = elAt(peakMs);
    if (peakEl >= minEl) {
      const w = refine(elAt, minEl, runStart, peakMs, peakMs, runEnd);
      if (w) out.push(w);
    }
  }
  return out;
}
