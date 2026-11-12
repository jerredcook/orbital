// analytics.js — anonymous usage counts via GoatCounter (no cookies, no
// fingerprinting, nothing that identifies a person).  Two questions only:
//   • which features do visitors actually open?   → `use/<feature>` events
//   • do people come back?                         → `visit/<nth>` + `back-after/<span>`
// …and one about the app itself:
//   • did it break for them?                       → `error/<kind>` + `degraded/<what>`
//     (recover.js, data.js — a bare category, never a message or a stack)
// The visit count lives in this browser's localStorage and never leaves it —
// only the coarse bucket ("3rd-5th visit", "7-29 days") is sent.  Each event
// is sent at most once per page load, so a count reads as "visitors who did X".
//
// Nothing loads off the production host, or under automation (the smoke suite,
// the guide's screenshot runs), so tests and local dev never show up as traffic.
// To exclude your own device: open the site once with #toggle-goatcounter.

const ENDPOINT = 'https://jerredcook.goatcounter.com/count';
const PROD_HOSTS = ['jerredcook.github.io'];   // add a custom domain here if the site ever moves
const VISITS_KEY = 'orbital.visits';
const DAY_MS = 86_400_000;
const SAME_VISIT_MS = 30 * 60_000;   // a reload inside half an hour is the same visit

const nthBucket = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n <= 5 ? '3rd-5th' : '6th-plus');
const spanBucket = (days) => (days < 7 ? '1-6-days' : days < 30 ? '7-29-days' : '30-days-plus');

// Pure: given the stored record (or null) and the time now, the record to store
// and the events to send.  `first` never moves, so "back-after" measures the
// span since someone's very first visit.
export function nextVisit(prev, now) {
  const ok = prev && Number.isFinite(prev.n) && Number.isFinite(prev.first) && Number.isFinite(prev.last)
    && prev.n >= 1 && prev.first <= now;
  if (!ok) return { state: { n: 1, first: now, last: now }, events: ['visit/1st'] };
  if (now - prev.last < SAME_VISIT_MS) return { state: { ...prev, last: now }, events: [] };
  const n = prev.n + 1;
  const events = [`visit/${nthBucket(n)}`];
  const days = Math.floor((now - prev.first) / DAY_MS);
  if (days >= 1) events.push(`back-after/${spanBucket(days)}`);
  return { state: { n, first: prev.first, last: now }, events };
}

// What kind of link someone arrived on (#sat=25544 → "sat", none → "home").
export function landingKind(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return 'home';
  const k = h.split('=')[0];
  return /^[a-z0-9]{1,16}$/.test(k) ? k : 'other';
}

const CLICK_IDS = {
  'system-toggle': 'system', 'moon-toggle': 'moon', 'missions-toggle': 'missions',
  'catalog-toggle': 'catalog', 'help-toggle': 'help', 'welcome-tour': 'tour',
  'welcome-guide': 'guide', 'welcome-install': 'install-prompt',
  'tl-play': 'timeline-play', 'ptl-play': 'probe-timeline-play',
  'pass-setloc': 'station-place', 'pass-geoloc': 'station-geolocate',
  'info-track': 'follow', 'info-screen': 'screening',
  'sys-enter-planet': 'planet-descend', 'sys-moon-orbits': 'moon-orbits',
};
const CLICK_CLASSES = { 'copy-link': 'copy-link', 'welcome-chip': 'jump-chip', 'group-chip': 'group-focus' };
const CHECK_IDS = {
  'toggle-conj': 'conjunctions', 'toggle-station': 'station', 'toggle-timeline': 'timeline',
  'toggle-coverage': 'coverage', 'ptl-toggle': 'probe-timeline',
};

let enabled = false;
let ready = false;
const sent = new Set();
const queue = [];

// The GoatCounter site is shared with other projects, so every event carries an
// `orbital/` prefix — typing "orbital" in the dashboard's filter box then shows
// this app's page views (/orbital/) and events together, and nothing else.
function send(name) {
  const path = `orbital/${name}`;
  try { window.goatcounter.count({ path, title: path, event: true }); } catch { /* never break the app */ }
}

// Record one named event (once per page load).  Safe to call anywhere, any time.
// The name is remembered even when nothing is sent (local dev, the test
// suites), so a test can ask what WOULD have been reported — see trackedEvents.
export function track(name) {
  if (sent.has(name)) return;
  sent.add(name);
  if (!enabled) return;
  if (ready) send(name); else queue.push(name);
}

// Every event recorded this page load, sent or not (debug + the smoke suites).
export const trackedEvents = () => [...sent];

function featureFor(target) {
  for (let el = target, hops = 0; el && el.nodeType === 1 && hops < 5; el = el.parentElement, hops++) {
    if (el.id && CLICK_IDS[el.id]) return CLICK_IDS[el.id];
    for (const cls in CLICK_CLASSES) if (el.classList.contains(cls)) return CLICK_CLASSES[cls];
  }
  return null;
}

export function initAnalytics() {
  let local = true;
  try { local = !PROD_HOSTS.includes(location.hostname) || navigator.webdriver === true; } catch { /* stay off */ }
  if (local) return;
  enabled = true;

  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = ENDPOINT;
  s.onload = () => { ready = true; queue.splice(0).forEach(send); };
  document.head.appendChild(s);   // a blocked/failed load just leaves the queue unsent

  // Feature use: one delegated listener each for buttons and checkboxes, so no
  // feature module needs to know analytics exists.
  document.addEventListener('click', (e) => {
    const f = featureFor(e.target);
    if (f) track(`use/${f}`);
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.type !== 'checkbox' || !t.checked) return;
    if (CHECK_IDS[t.id]) track(`use/${CHECK_IDS[t.id]}`);
    else if (t.closest?.('#system-scale')) track('use/true-scale');
  }, true);

  track(`land/${landingKind(location.hash)}`);
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) track('mode/installed-app');
  } catch { /* ignore */ }
  window.addEventListener('appinstalled', () => track('install/accepted'));

  try {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(VISITS_KEY)); } catch { /* none / corrupt */ }
    const { state, events } = nextVisit(prev, Date.now());
    localStorage.setItem(VISITS_KEY, JSON.stringify(state));
    events.forEach(track);
  } catch { /* storage blocked (private mode): no visit counting, everything else still works */ }
}
