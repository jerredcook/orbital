// recover.js — what happens when something breaks on a visitor's device.
//
// Two jobs:
//   • COUNT it.  Script errors, failed promises, dead workers, a lost graphics
//     context and render-loop crashes each send one anonymous `error/<kind>`
//     event (analytics.js — no message text, no stack, nothing about the
//     person), so "nobody came back" can be told apart from "it broke".  A
//     render-loop crash also says which view, what sort of failure and when
//     (renderErrorKind, renderErrorWhen) — fixed labels, chosen here.
//   • RECOVER.  The one failure the app cannot repair in place is losing the
//     GPU: phones reclaim a background tab's graphics context routinely, and
//     Cesium cannot rebuild a scene on a new one.  Left alone the visitor
//     returns to a frozen or black globe.  Instead: if the context went while
//     the tab was hidden, reload quietly on return (the URL hash already holds
//     the view, so they land where they were); otherwise show a card with a
//     Reload button.
//
// Everything here is defensive: a bug in the safety net must never be the thing
// that takes the app down.

import { track } from './analytics.js';

// Pure: which `error/<kind>` event (if any) a window 'error' or
// 'unhandledrejection' event should be counted as.  null = noise, don't count.
export function errorKind(e) {
  const reason = e?.reason;
  const msg = String(e?.message ?? reason?.message ?? reason ?? '');
  if (/ResizeObserver loop/i.test(msg)) return null;              // benign browser chatter
  if (e?.type === 'unhandledrejection') {
    if (reason?.name === 'AbortError' || /aborted/i.test(msg)) return null;   // our own fetch timeouts
    if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'error/network';
    return 'error/promise';
  }
  if (msg === 'Script error.' || msg === 'Script error') return 'error/third-party-script';   // cross-origin, no detail given
  return 'error/script';
}

const RELOAD_KEY = 'orbital.auto-reload';
const RELOAD_GAP_MS = 60_000;

// A blocking card with one way out.  One at a time; safe to call repeatedly.
export function reloadCard(title, text) {
  try {
    if (document.getElementById('recover-card')) return;
    const el = document.createElement('div');
    el.id = 'recover-card';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'recover-title');
    const box = document.createElement('div'); box.className = 'recover-box';
    const h = document.createElement('div'); h.id = 'recover-title'; h.className = 'recover-title'; h.textContent = title;
    const p = document.createElement('p'); p.textContent = text;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'recover-reload'; btn.textContent = 'Reload';
    btn.addEventListener('click', () => location.reload());
    box.append(h, p, btn);
    el.appendChild(box);
    document.body.appendChild(el);
    btn.focus();
  } catch { /* nothing more we can do */ }
}

// Pure: what to do about a lost graphics context.
//   when it is lost  → 'wait' if nobody is looking (decide when they return), else 'card'
//   when they return → 'reload' quietly, but at most once a minute: a device that
//                      cannot hold a context gets the 'card', not a reload loop.
export function gpuLossAction({ event, hidden, lastReloadMs, now }) {
  if (event === 'lost') return hidden ? 'wait' : 'card';
  return Number.isFinite(lastReloadMs) && now - lastReloadMs < RELOAD_GAP_MS ? 'card' : 'reload';
}

// Reload without asking; false if it is too soon since the last one (or the
// browser gives us nowhere to remember that — then never reload unasked).
function quietReload() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? NaN);
    if (gpuLossAction({ event: 'return', lastReloadMs: last, now: Date.now() }) !== 'reload') return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { return false; }
  location.reload();
  return true;
}

const GPU_TITLE = 'The 3D view was interrupted';
const GPU_TEXT = 'Your device took back the graphics memory this page was using. Reload to pick up where you were.';

let gpuLost = false;
function gpuLoss() {
  if (gpuLost) return;
  gpuLost = true;
  track('error/webgl-lost');
  if (gpuLossAction({ event: 'lost', hidden: document.hidden }) === 'card') reloadCard(GPU_TITLE, GPU_TEXT);
  // otherwise: decided on return — see the visibility listener
}
function onContextLost(e) {
  // A viewer we destroyed on purpose (bodyglobe swaps its globe per body) drops
  // its context too — that canvas is already out of the page; ignore it.
  if (!e.target?.isConnected || e.target.tagName !== 'CANVAS') return;
  gpuLoss();
}
const contextGone = (canvas) => {
  try { return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))?.isContextLost(); } catch { return false; }
};

// Pure: a short fixed label for what a render-loop error was.  The label is all
// that is ever reported — the message is only read here, to choose it.
//   type / reference / recursion — a plain code bug on this browser's path
//   shader / framebuffer / texture / unsupported — the graphics chip or driver
//     could not do something the scene asked of it
//   memory — the device ran out of room
//   not-a-number — a bad position or direction reached the drawing code
//   cesium-check / cesium-runtime / range / other — none of the above
// TypeError and ReferenceError go by name first: their messages quote property
// names ("reading 'shaderProgram'") that would otherwise look like a GPU fault.
export function renderErrorKind(err) {
  let name = '', msg = '';
  try { name = String(err?.name ?? ''); msg = String(err?.message ?? err ?? ''); } catch { return 'other'; }
  if (name === 'TypeError') return 'type';
  if (name === 'ReferenceError') return 'reference';
  if (/call stack|too much recursion/i.test(msg)) return 'recursion';
  if (/shader|failed to (compile|link)/i.test(msg)) return 'shader';
  if (/framebuffer/i.test(msg)) return 'framebuffer';
  if (/out of memory|allocation|array (buffer )?length|typed array length/i.test(msg)) return 'memory';
  if (/texture|cube ?map/i.test(msg)) return 'texture';
  if (/\bNaN\b|not a number|finite/.test(msg)) return 'not-a-number';
  if (/not supported|unsupported/i.test(msg)) return 'unsupported';
  if (name === 'DeveloperError') return 'cesium-check';
  if (name === 'RuntimeError') return 'cesium-runtime';
  if (name === 'RangeError') return 'range';
  return 'other';
}

// Pure: when in a view's life it stopped.  A view that never drew one frame is
// a device that cannot run it at all; one that stops in its first seconds
// usually met something it could not draw as the scene filled in; later than
// that, something the visitor did set it off.
const EARLY_MS = 20_000;
export function renderErrorWhen({ frames, sinceFirstFrameMs }) {
  if (!(frames > 0)) return 'first-frame';
  return sinceFirstFrameMs < EARLY_MS ? 'early' : 'later';
}

// Hook a Cesium viewer's render loop: when it stops on an error, Cesium's own
// panel is a wall of stack trace — replace it with the reload card, and count
// it as `error/render/<view>/<kind>/<when>` (e.g. error/render/earth/shader/early).
// `view` names the viewer: 'earth', 'moon', 'system' or 'planet'.
export function watchViewer(viewer, view = 'earth') {
  try {
    let frames = 0, firstFrameAt = 0;
    viewer.scene.postRender.addEventListener(() => { if (frames++ === 0) firstFrameAt = Date.now(); });
    viewer.scene.renderError.addEventListener((scene, error) => {
      // Drawing on a lost context fails too — and the frame can get there
      // before the browser's "context lost" event does.  That is the GPU case
      // (which may be waiting quietly for a hidden tab), not a second failure.
      if (gpuLost || contextGone(scene?.canvas ?? viewer.scene.canvas)) { gpuLoss(); return; }
      let name = 'error/render';
      try {
        name = `error/render/${view}/${renderErrorKind(error)}/${renderErrorWhen({ frames, sinceFirstFrameMs: Date.now() - firstFrameAt })}`;
      } catch { /* count it anyway */ }
      track(name);
      reloadCard('The 3D view stopped', 'Something went wrong while drawing the scene. Reload to start it again.');
    });
  } catch { /* an API change must not break boot */ }
}

export function initRecovery() {
  // Capture phase on window: the event doesn't bubble, and this way every
  // viewer's canvas (Earth, system, Moon, planet globes) is covered at once.
  window.addEventListener('webglcontextlost', onContextLost, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && gpuLost && !quietReload()) reloadCard(GPU_TITLE, GPU_TEXT);
  });

  const count = (e) => { try { const k = errorKind(e); if (k) track(k); } catch { /* never throw from here */ } };
  window.addEventListener('error', count);
  window.addEventListener('unhandledrejection', count);
}
