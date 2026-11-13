// celestrak-stub.mjs — a stand-in for CelesTrak in the browser suites.
//
// The suites must never contact the real CelesTrak: every run starts from an
// empty browser profile, so every run would download the whole catalog again,
// from the developer's own address or a CI runner's.  CelesTrak rate-limits and
// then firewalls clients that do that — which would take the live data away
// from the very machine the app is being developed on.  So the element sets are
// answered from the snapshot bundled with the app, and the optional SATCAT
// metadata (owner, launch site) with a 404, which the app treats as "none".
//
//   await stubCelestrak(pageOrContext);     // before the first navigation
import { readFileSync } from 'node:fs';

const SNAPSHOT = readFileSync(new URL('../public/fallback/active.tle', import.meta.url), 'utf8');
const CORS = { 'access-control-allow-origin': '*' };
export const CELESTRAK = /^https:\/\/celestrak\.org\//;

export const celestrakOk = (route) => {
  const u = route.request().url();
  if (u.includes('GROUP=active')) return route.fulfill({ status: 200, contentType: 'text/plain', headers: CORS, body: SNAPSHOT });
  if (u.includes('GROUP=')) return route.fulfill({ status: 200, contentType: 'text/plain', headers: CORS, body: '' });
  return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
};

export const stubCelestrak = (target, handler = celestrakOk) => target.route(CELESTRAK, handler);
