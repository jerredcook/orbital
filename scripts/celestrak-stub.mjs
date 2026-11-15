// celestrak-stub.mjs — proof that the app never contacts CelesTrak.
//
// The app loads its satellite data from its own site (data/, built from the
// snapshot committed with the code when there is no fetched copy — see
// tools/prepare-data.mjs), so a browser has no reason to talk to celestrak.org
// at all.  That matters: CelesTrak firewalls clients that download its big
// files repeatedly, and an earlier version of these suites — every run a fresh
// browser profile, every profile a full download — got the developer's home
// connection blocked.
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
  await target.route(CELESTRAK, (route) => {
    hits.push(route.request().url().slice(0, 120));
    return route.abort('blockedbyclient');
  });
  return hits;
}
