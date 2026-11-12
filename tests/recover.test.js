// recover.js — how a browser error event is bucketed for counting.  Only the
// category is ever reported; these check the buckets and the noise filter.
import { describe, it, expect } from 'vitest';
import { errorKind, gpuLossAction } from '../src/recover.js';
import { track, trackedEvents } from '../src/analytics.js';

describe('errorKind', () => {
  it('counts an ordinary script error', () => {
    expect(errorKind({ type: 'error', message: 'Uncaught TypeError: x is not a function' })).toBe('error/script');
  });
  it('separates errors from scripts on other sites, which arrive with no detail', () => {
    expect(errorKind({ type: 'error', message: 'Script error.' })).toBe('error/third-party-script');
  });
  it('counts a failed promise', () => {
    expect(errorKind({ type: 'unhandledrejection', reason: new Error('nope') })).toBe('error/promise');
    expect(errorKind({ type: 'unhandledrejection', reason: 'a bare string' })).toBe('error/promise');
    expect(errorKind({ type: 'unhandledrejection', reason: undefined })).toBe('error/promise');
  });
  it('buckets network failures apart from bugs', () => {
    expect(errorKind({ type: 'unhandledrejection', reason: new TypeError('Failed to fetch') })).toBe('error/network');
    expect(errorKind({ type: 'unhandledrejection', reason: new TypeError('NetworkError when attempting to fetch resource.') })).toBe('error/network');
    expect(errorKind({ type: 'unhandledrejection', reason: new TypeError('Load failed') })).toBe('error/network');
  });
  it('ignores noise: our own fetch timeouts and ResizeObserver chatter', () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(errorKind({ type: 'unhandledrejection', reason: abort })).toBe(null);
    expect(errorKind({ type: 'error', message: 'ResizeObserver loop completed with undelivered notifications.' })).toBe(null);
  });
  it('never throws on a malformed event', () => {
    expect(() => errorKind(null)).not.toThrow();
    expect(() => errorKind({})).not.toThrow();
  });
});

describe('gpuLossAction — a lost graphics context', () => {
  it('shows the card when the visitor is looking at the page', () => {
    expect(gpuLossAction({ event: 'lost', hidden: false })).toBe('card');
  });
  it('waits when the tab is in the background', () => {
    expect(gpuLossAction({ event: 'lost', hidden: true })).toBe('wait');
  });
  it('reloads quietly when they come back', () => {
    expect(gpuLossAction({ event: 'return', lastReloadMs: NaN, now: 1_000_000 })).toBe('reload');
    expect(gpuLossAction({ event: 'return', lastReloadMs: 1_000_000 - 61_000, now: 1_000_000 })).toBe('reload');
  });
  it('will not reload twice inside a minute — the card instead of a loop', () => {
    expect(gpuLossAction({ event: 'return', lastReloadMs: 1_000_000 - 5_000, now: 1_000_000 })).toBe('card');
  });
});

describe('track', () => {
  it('remembers an event once, even where nothing is sent', () => {
    track('error/test-only');
    track('error/test-only');
    expect(trackedEvents().filter((n) => n === 'error/test-only').length).toBe(1);
  });
});
