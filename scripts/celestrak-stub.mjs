// celestrak-stub.mjs — proof that the app never contacts CelesTrak.
//
// The app loads its satellite data from its own site (data/, built from the
// snapshot committed with the code when there is no fetched copy — see
// tools/prepare-data.mjs), so a browser has no reason to talk to celestrak.org
// at all.  That matters: CelesTrak allows one download of a list per update
// (every two hours), refuses repeats with an HTTP 403, and firewalls clients
// that keep asking or use more than 100 MB a day.  This project found out on
// its second day (12 June 2026), when a caching bug made every page reload
// download the big files again; and until November 2026 every run of these
// suites — a fresh browser profile each time — did the same from CI.
//
// So every suite puts this in front of the browser: any request to CelesTrak is
// refused and recorded, and the suite fails if the list is not empty.
//
//   const hits = [];
//   await blockCelestrak(pageOrContext, hits);     // before the first navigation
//   …
//   check('neverContactsCelestrak', hits.length === 0);

export const CELESTRAK = /^https?:\/\/([a-z0-9-]+\.)*celestrak\.(org|com)\//i;

export async function blockCelestrak(target, hits = []) {
  await stubWikimedia(target, wikimediaAsked);   // every browser these suites open: no real photo requests either (below)
  await target.route(CELESTRAK, (route) => {
    hits.push(route.request().url().slice(0, 120));
    return route.abort('blockedbyclient');
  });
  return hits;
}

// Photos in the "about" panel come from Wikimedia Commons.  A test run must not
// fetch them (hundreds of runs a month, from CI addresses), so they are answered
// here with a one-pixel image.  Returns the list of what was asked for.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const wikimediaAsked = [];
export const WIKIMEDIA = /^https?:\/\/([a-z0-9-]+\.)*(wikimedia|wikipedia)\.org\//i;
export async function stubWikimedia(target, asked = []) {
  await target.route(WIKIMEDIA, (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PIXEL });
  });
  return asked;
}

