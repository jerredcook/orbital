// fetch-recent-launches.mjs — the Missions chapter's self-updating tail.  Pulls
// the latest completed launches and the next scheduled ones from The Space Devs'
// Launch Library 2 (free, keyless; please keep the call count tiny) and writes
// public/missions/recent.json, which the Missions view renders as "the story
// continues".  Run on a schedule by .github/workflows/refresh-missions.yml —
// a data change commits, which runs the smoke-gated deploy.
//
//   node tools/fetch-recent-launches.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://ll.thespacedevs.com/2.2.0/launch';
const FIELDS = (l) => ({
  name: String(l.name ?? '').slice(0, 120),
  date: l.net ?? null,
  agency: String(l.launch_service_provider?.name ?? '').slice(0, 60),
  status: String(l.status?.abbrev ?? '').slice(0, 24),
  desc: String(l.mission?.description ?? '').replace(/\s+/g, ' ').slice(0, 260),
  img: typeof l.image === 'string' && l.image.startsWith('https://') ? l.image : null,
  pad: String(l.pad?.location?.name ?? '').slice(0, 60),
});

async function grab(path) {
  const res = await fetch(`${API}/${path}`, { headers: { 'User-Agent': 'orbital (github.com/jerredcook/orbital; hobby tracker)' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()).results.map(FIELDS);
}

const previous = await grab('previous/?limit=8');
const upcoming = await grab('upcoming/?limit=8');

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'missions', 'recent.json');
await mkdir(dirname(dest), { recursive: true });
await writeFile(dest, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), previous, upcoming }, null, 1));
console.log(`wrote ${previous.length} previous + ${upcoming.length} upcoming → ${dest}`);
