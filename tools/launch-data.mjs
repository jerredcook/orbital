// launch-data.mjs — is this a recent.json we are willing to publish?
//
// tools/fetch-recent-launches.mjs runs unattended twice a week and its output is
// committed and deployed without anyone looking.  So before it writes anything,
// the result has to pass this: the right shape, plausible sizes, real dates, and
// dates that make sense for "just flew" and "up next".  An upstream outage that
// answers 200 with an empty list, an error object, or last year's cache then
// fails the job (GitHub emails the owner) and the site keeps the last good file.
//
// Pure — also run by the unit tests against the committed file.

const DAY = 86_400_000;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function checkLaunch(l, where, problems) {
  if (!l || typeof l !== 'object') { problems.push(`${where}: not an object`); return null; }
  if (!isStr(l.name, 120) || !l.name.trim()) problems.push(`${where}: missing name`);
  for (const [k, max] of [['agency', 60], ['status', 24], ['desc', 260], ['pad', 60]]) {
    if (!isStr(l[k], max)) problems.push(`${where}: ${k} is not a string of at most ${max} characters`);
  }
  if (l.img !== null && !(isStr(l.img, 400) && l.img.startsWith('https://'))) problems.push(`${where}: img is not null or an https URL`);
  const t = typeof l.date === 'string' ? Date.parse(l.date) : NaN;
  if (!Number.isFinite(t)) { problems.push(`${where}: date is not a parseable time`); return null; }
  return t;
}

// Returns a list of problems; empty means publishable.  `now` is injectable for
// tests.  Pass `fresh: false` to check shape only (a committed file ages).
export function validateRecent(data, { now = Date.now(), fresh = true } = {}) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['not an object'];
  if (typeof data.updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.updated)) problems.push('updated is not a YYYY-MM-DD date');

  const times = {};
  for (const key of ['previous', 'upcoming']) {
    const list = data[key];
    if (!Array.isArray(list)) { problems.push(`${key} is not a list`); continue; }
    if (list.length < 3 || list.length > 8) problems.push(`${key} has ${list.length} launches (expected 3–8)`);
    times[key] = list.map((l, i) => checkLaunch(l, `${key}[${i}]`, problems)).filter((t) => t !== null);
  }
  if (!fresh) return problems;

  const prev = times.previous ?? [], next = times.upcoming ?? [];
  // "Just flew": none in the future (a day's grace for clock skew), and the
  // newest within a month — somebody launches every few days.
  if (prev.some((t) => t > now + DAY)) problems.push('previous contains a launch dated in the future');
  if (prev.length && Math.max(...prev) < now - 30 * DAY) problems.push('newest "previous" launch is over 30 days old — stale data');
  // "Up next": launches slip, so a recent past date is normal; an old one is not.
  if (next.some((t) => t < now - 7 * DAY)) problems.push('upcoming contains a launch dated over a week ago');
  if (next.length && Math.max(...next) < now) problems.push('no "upcoming" launch is in the future — stale data');
  return problems;
}
