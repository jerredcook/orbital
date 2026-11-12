// worker-guard.js with fake workers and fake timers: a failed worker is
// replaced and re-initialised, late events from a replaced worker are ignored,
// and a worker that keeps dying is given up on instead of looped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { guardWorker } from '../src/worker-guard.js';

class FakeWorker {
  constructor() { this.posted = []; this.terminated = false; }
  postMessage(m) { if (this.terminated) throw new Error('posted to a terminated worker'); this.posted.push(m); }
  terminate() { this.terminated = true; }
  crash(msg = 'boom') { this.onerror?.({ message: msg }); }
  say(data) { this.onmessage?.({ data }); }
}

function setup(opts = {}) {
  const made = [];
  const log = { down: 0, restart: 0, gaveUp: 0, got: [] };
  const g = guardWorker({
    create: () => { const w = new FakeWorker(); made.push(w); return w; },
    onMessage: (e) => log.got.push(e.data),
    onDown: () => { log.down++; },
    onRestart: () => { log.restart++; g.post({ type: 'init' }); },
    onGiveUp: () => { log.gaveUp++; },
    ...opts,
  });
  return { g, made, log };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('guardWorker', () => {
  it('passes messages both ways while healthy', () => {
    const { g, made, log } = setup();
    expect(g.post({ a: 1 })).toBe(true);
    made[0].say('hello');
    expect(made[0].posted).toEqual([{ a: 1 }]);
    expect(log.got).toEqual(['hello']);
    expect(g.alive).toBe(true);
  });

  it('replaces a crashed worker and asks the owner to re-initialise it', () => {
    const { g, made, log } = setup();
    made[0].crash();
    expect(made[0].terminated).toBe(true);
    expect(log.down).toBe(1);
    expect(g.alive).toBe(false);
    expect(g.post({ a: 1 })).toBe(false);          // down: the message is refused, not lost silently
    vi.advanceTimersByTime(400);
    expect(made.length).toBe(2);
    expect(log.restart).toBe(1);
    expect(made[1].posted).toEqual([{ type: 'init' }]);   // state re-sent to the NEW worker
    expect(g.post({ a: 2 })).toBe(true);
    expect(g.restarts).toBe(1);
  });

  it('ignores late events from a worker it already replaced', () => {
    const { made, log } = setup();
    const old = made[0];
    old.crash();
    vi.advanceTimersByTime(400);
    old.say('stale answer');
    old.crash('again');
    expect(log.got).toEqual([]);
    expect(log.down).toBe(1);
    expect(made.length).toBe(2);
  });

  it('backs off between restarts', () => {
    const { made } = setup();
    made[0].crash();
    vi.advanceTimersByTime(400);          // 1st restart after 400 ms
    made[1].crash();
    vi.advanceTimersByTime(700);
    expect(made.length).toBe(2);          // 2nd waits 800 ms
    vi.advanceTimersByTime(100);
    expect(made.length).toBe(3);
  });

  it('gives up on a worker that keeps dying, and stays down', () => {
    const { g, made, log } = setup();
    for (let i = 0; i < 3; i++) { made[i].crash(); vi.advanceTimersByTime(5000); }
    expect(made.length).toBe(4);
    expect(log.gaveUp).toBe(0);
    made[3].crash();                      // the 4th failure inside a minute
    vi.advanceTimersByTime(60_000);
    expect(log.gaveUp).toBe(1);
    expect(g.gaveUp).toBe(true);
    expect(made.length).toBe(4);          // no further workers built
    expect(g.post({ a: 1 })).toBe(false);
  });

  it('forgives old failures: three a minute is the limit, not three ever', () => {
    const { g, made, log } = setup();
    for (let i = 0; i < 8; i++) { made[i].crash(); vi.advanceTimersByTime(40_000); }
    expect(log.gaveUp).toBe(0);
    expect(g.alive).toBe(true);
    expect(made.length).toBe(9);
  });

  it('restart() lets a watchdog condemn a worker that never errors', () => {
    const { g, made, log } = setup();
    g.restart('stalled');
    expect(made[0].terminated).toBe(true);
    expect(log.down).toBe(1);
    vi.advanceTimersByTime(400);
    expect(g.alive).toBe(true);
    expect(made.length).toBe(2);
  });

  it('survives a worker that cannot even be constructed', () => {
    let n = 0;
    const made = [];
    const log = { down: 0, restart: 0 };
    const g = guardWorker({
      create: () => { if (n++ === 0) throw new Error('blocked'); const w = new FakeWorker(); made.push(w); return w; },
      onDown: () => { log.down++; },
      onRestart: () => { log.restart++; },
    });
    expect(g.alive).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(log.down).toBe(1);
    expect(g.alive).toBe(true);
    expect(log.restart).toBe(1);
  });

  it('treats a message that cannot be posted as a failure, without throwing', () => {
    const { g, made, log } = setup();
    made[0].postMessage = () => { throw new Error('DataCloneError'); };
    expect(g.post({ bad: true })).toBe(false);
    expect(log.down).toBe(1);
  });
});
