// deeplink.js — mirror the current view into the URL hash so any view is
// shareable, and read it back on load.  Writes are one-way and use
// replaceState (the address bar tracks the view without spamming Back), and
// the hash is parsed once at startup; we never listen for hashchange, so there
// is no write→read feedback loop to guard against.
//
//   (none)        plain Earth view
//   #sat=25544    track an Earth satellite (by NORAD id)
//   #system       the solar-system overview
//   #body=Jupiter a planet or the Sun
//   #moon=Europa  a natural satellite in the system view
//   #probe=Juno   a robotic spacecraft in the system view
//   #luna         the Moon globe
//   #jwst         the James Webb Space Telescope, up close at L2

export function writeHash(state) {
  let h = '';
  if (state) {
    if (state.sat != null) h = `sat=${state.sat}`;
    else if (state.body) h = `body=${encodeURIComponent(state.body)}`;
    else if (state.moon) h = `moon=${encodeURIComponent(state.moon)}`;
    else if (state.probe) h = `probe=${encodeURIComponent(state.probe)}`;
    else if (state.luna) h = 'luna';
    else if (state.jwst) h = 'jwst';
    else if (state.system) h = 'system';
  }
  if (location.hash.replace(/^#/, '') === h) return;            // already there
  const target = h ? `#${h}` : `${location.pathname}${location.search}`;
  history.replaceState(null, '', target);
}

export function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  if (h === 'luna') return { luna: true };
  if (h === 'jwst') return { jwst: true };
  if (h === 'system') return { system: true };
  const eq = h.indexOf('=');
  if (eq < 0) return null;
  const k = h.slice(0, eq);
  const v = decodeURIComponent(h.slice(eq + 1));
  if (!v) return null;
  if (k === 'sat' || k === 'body' || k === 'moon' || k === 'probe') return { [k]: v };
  return null;
}
