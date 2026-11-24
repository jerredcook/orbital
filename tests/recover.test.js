// recover.js — how a browser error event is bucketed for counting.  Only the
// category is ever reported; these check the buckets and the noise filter.
import { describe, it, expect } from 'vitest';
import { errorKind, gpuLossAction, renderErrorKind, renderErrorWhen, watchViewer } from '../src/recover.js';
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

// Cesium's own error types: plain objects with a name and a message.
const cesiumError = (name, message) => ({ name, message });

describe('renderErrorKind — what sort of failure stopped the 3D view', () => {
  it('names a graphics chip that could not build or run the scene', () => {
    expect(renderErrorKind(cesiumError('RuntimeError', 'Fragment shader failed to compile.  Compile log: ERROR: 0:12: texture2D'))).toBe('shader');
    expect(renderErrorKind(cesiumError('RuntimeError', 'Program failed to link.  Link log: out of memory'))).toBe('shader');
    expect(renderErrorKind(cesiumError('DeveloperError', 'Framebuffer is not complete.  Unsupported: the combination of internal formats of the attached images…'))).toBe('framebuffer');
    expect(renderErrorKind(cesiumError('DeveloperError', 'Width must be less than or equal to the maximum texture size (4096).'))).toBe('texture');
    expect(renderErrorKind(cesiumError('RuntimeError', 'Floating point textures are not supported'))).toBe('texture');
    expect(renderErrorKind(cesiumError('RuntimeError', 'WebGL 2 is not supported here'))).toBe('unsupported');
  });
  it('names a device that ran out of room, in each browser\'s wording', () => {
    expect(renderErrorKind(new RangeError('Array buffer allocation failed'))).toBe('memory');
    expect(renderErrorKind(new RangeError('Invalid typed array length: 4294967296'))).toBe('memory');
    expect(renderErrorKind(new RangeError('invalid array length'))).toBe('memory');
    expect(renderErrorKind(new Error('Out of memory'))).toBe('memory');
  });
  it('names a bad number reaching the drawing code', () => {
    expect(renderErrorKind(cesiumError('DeveloperError', 'normalized result is not a number'))).toBe('not-a-number');
    expect(renderErrorKind(cesiumError('DeveloperError', 'Expected longitude to be a finite number'))).toBe('not-a-number');
    expect(renderErrorKind(cesiumError('DeveloperError', 'x is NaN'))).toBe('not-a-number');
  });
  it('goes by name for a plain code bug, whatever property its message quotes', () => {
    expect(renderErrorKind(new TypeError("Cannot read properties of undefined (reading 'shaderProgram')"))).toBe('type');
    expect(renderErrorKind(new TypeError('texture.framebuffer is undefined'))).toBe('type');
    expect(renderErrorKind(new ReferenceError('texture is not defined'))).toBe('reference');
    expect(renderErrorKind(new RangeError('Maximum call stack size exceeded'))).toBe('recursion');
    expect(renderErrorKind(Object.assign(new Error('too much recursion'), { name: 'InternalError' }))).toBe('recursion');
  });
  it('falls back to the type of error, then to "other"', () => {
    expect(renderErrorKind(cesiumError('DeveloperError', 'cartesian is required'))).toBe('cesium-check');
    expect(renderErrorKind(cesiumError('RuntimeError', 'An error occurred'))).toBe('cesium-runtime');
    expect(renderErrorKind(new RangeError('precision is out of range'))).toBe('range');
    expect(renderErrorKind(new Error('something else'))).toBe('other');
    expect(renderErrorKind('a bare string')).toBe('other');
  });
  it('only ever answers with one of its fixed labels, and never throws', () => {
    const labels = /^(type|reference|recursion|shader|framebuffer|memory|texture|not-a-number|unsupported|cesium-check|cesium-runtime|range|other)$/;
    const hostile = { get name() { throw new Error('no'); } };
    for (const e of [null, undefined, 0, '', {}, [], hostile, new Error('https://example.com/?who=someone'), cesiumError('RuntimeError', 'x'.repeat(5000))]) {
      expect(renderErrorKind(e)).toMatch(labels);
    }
  });
});

describe('renderErrorWhen — when in a view\'s life it stopped', () => {
  it('says a view that never drew a frame failed on its first', () => {
    expect(renderErrorWhen({ frames: 0, sinceFirstFrameMs: 999_999 })).toBe('first-frame');
    expect(renderErrorWhen({ frames: undefined, sinceFirstFrameMs: NaN })).toBe('first-frame');
  });
  it('separates the first seconds from later on', () => {
    expect(renderErrorWhen({ frames: 3, sinceFirstFrameMs: 50 })).toBe('early');
    expect(renderErrorWhen({ frames: 900, sinceFirstFrameMs: 19_999 })).toBe('early');
    expect(renderErrorWhen({ frames: 900, sinceFirstFrameMs: 20_000 })).toBe('later');
  });
});

describe('watchViewer — a render-loop crash is counted with its view, kind and time', () => {
  // The least of a Cesium viewer that watchViewer touches.
  const fakeViewer = () => {
    const event = () => { const fns = []; return { addEventListener: (f) => fns.push(f), raise: (...a) => fns.forEach((f) => f(...a)) }; };
    const canvas = { getContext: () => ({ isContextLost: () => false }) };
    return { scene: { canvas, postRender: event(), renderError: event() } };
  };
  it('reports all three parts, and nothing from the message', () => {
    const v = fakeViewer();
    watchViewer(v, 'moon');
    v.scene.renderError.raise(v.scene, cesiumError('RuntimeError', 'Vertex shader failed to compile.  Compile log: secret-detail'));
    expect(trackedEvents()).toContain('error/render/moon/shader/first-frame');
    expect(trackedEvents().join(' ')).not.toContain('secret-detail');
  });
  it('knows a view that had been drawing', () => {
    const v = fakeViewer();
    watchViewer(v, 'earth');
    v.scene.postRender.raise();
    v.scene.postRender.raise();
    v.scene.renderError.raise(v.scene, new TypeError('x is undefined'));
    expect(trackedEvents()).toContain('error/render/earth/type/early');
  });
});

describe('track', () => {
  it('remembers an event once, even where nothing is sent', () => {
    track('error/test-only');
    track('error/test-only');
    expect(trackedEvents().filter((n) => n === 'error/test-only').length).toBe(1);
  });
});
