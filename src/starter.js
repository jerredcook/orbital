// starter.js — what a first-time visitor sees.
//
// It used to be the full welcome card: a dialog over a dimmed, blurred globe,
// which on a phone filled the screen with a hundred words before anything
// moved.  The first real crowd (a Reddit post, November 2026) mostly looked and
// left — three in four never tapped a satellite.  So the globe now comes first:
// this is a small card that sits beside it, not over it, says what the dots are
// in one line and offers three ways in.  Nothing is blocked — the globe turns
// and dots can be tapped with the card still up.  The full welcome card is
// unchanged behind the "?" button.
//
// It goes away for good once the visitor does anything that shows they have
// found their feet: one of its buttons, its ✕, picking a satellite, or any
// top-bar button (main.js calls dismiss()).

export function initStarter({ getCount, actions, onDismiss }) {
  const $ = (id) => document.getElementById(id);
  const el = $('starter');
  let open = false, poll = 0;

  function dismiss() {
    if (!open) return;
    open = false;
    el.hidden = true;
    clearInterval(poll);
    onDismiss?.();
  }

  function show() {
    if (open) return;
    open = true;
    try { if (!window.matchMedia('(pointer: coarse)').matches) $('starter-verb').textContent = 'Click'; } catch { /* keep "Tap" */ }
    el.hidden = false;
    // The headline gets the real number once the catalog is in.
    poll = setInterval(() => {
      const n = getCount();
      if (!n) return;
      clearInterval(poll);
      $('starter-head').textContent = `${n.toLocaleString()} satellites, where they are right now.`;
    }, 300);
  }

  $('starter-close').addEventListener('click', dismiss);
  for (const [id, run] of Object.entries(actions)) {
    $(id).addEventListener('click', () => { dismiss(); run(); });
  }

  return { show, dismiss, get open() { return open; } };
}
