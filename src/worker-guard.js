// worker-guard.js — keeps a web worker alive.
//
// A bare Worker that fails stays failed: if its script never loads (a network
// blip at the wrong moment) or it dies mid-task, every later postMessage goes
// nowhere and the feature it powers silently freezes.  guardWorker() wraps the
// worker so a failure terminates it, builds a fresh one after a short backoff,
// and tells the owner to re-send whatever state the new worker needs.
//
// It refuses to loop: more than `maxRestarts` failures inside `windowMs` means
// something is deterministically wrong (bad data, an unsupported browser), so
// it stops and calls onGiveUp — the owner then tells the user instead of
// burning their battery.
//
//   const engine = guardWorker({
//     create:    () => new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' }),
//     onMessage: (e) => { … },
//     onDown:    (err) => { … clear busy latches, note the failure … },
//     onRestart: () => { engine.post({ type: 'init', … }); },
//     onGiveUp:  (err) => { … tell the user … },
//   });
//   engine.post(msg)        → false if there is no live worker right now
//   engine.restart('why')   → treat the current worker as failed (a watchdog's verdict)
//
// No DOM, no imports: unit-tested with fake workers (tests/worker-guard.test.js).

export function guardWorker({
  create, onMessage, onDown, onRestart, onGiveUp,
  maxRestarts = 3, windowMs = 60_000, baseDelayMs = 400,
}) {
  let w = null;          // the live worker, or null while down / after giving up
  let gaveUp = false;
  let restarts = 0;      // lifetime count, for diagnostics
  const recent = [];     // restart timestamps inside the window

  function spawn() {
    let mine;
    try { mine = create(); }
    catch (err) { setTimeout(() => fail(err), 0); return; }   // async, so the caller always has its handle first
    w = mine;
    // Each handler is bound to ITS worker: a late event from one we already
    // replaced must not be mistaken for the new worker's.
    mine.onmessage = (e) => { if (w === mine) onMessage?.(e); };
    mine.onerror = mine.onmessageerror = (err) => { if (w === mine) fail(err); };
  }

  function fail(err) {
    if (gaveUp) return;
    try { w?.terminate(); } catch { /* already gone */ }
    w = null;
    onDown?.(err);
    const now = Date.now();
    while (recent.length && now - recent[0] > windowMs) recent.shift();
    if (recent.length >= maxRestarts) { gaveUp = true; onGiveUp?.(err); return; }
    recent.push(now);
    setTimeout(() => {
      if (gaveUp || w) return;
      restarts++;
      spawn();
      if (w) onRestart?.();
    }, baseDelayMs * 2 ** (recent.length - 1));
  }

  spawn();

  return {
    post(msg, transfer) {
      if (!w) return false;
      try { if (transfer) w.postMessage(msg, transfer); else w.postMessage(msg); }
      catch (err) { fail(err); return false; }   // e.g. an uncloneable message — don't let it throw into a timer
      return true;
    },
    restart(reason = 'restart requested') { if (w) fail(new Error(reason)); },
    get alive() { return !!w; },
    get gaveUp() { return gaveUp; },
    get restarts() { return restarts; },
  };
}
