// tle-snapshot.mjs — is this a satellite snapshot we are willing to bundle?
//
// public/fallback/active.tle is what the app shows when the live feed is
// unreachable, and what the test suites and image tools use instead of
// CelesTrak.  It must really be CelesTrak's ACTIVE-satellite list: an earlier
// snapshot taken from a third-party mirror turned out to carry thousands of
// debris fragments and spent rocket bodies, which the app then counted and
// drew as satellites.  So before anything is written the text has to pass this.
//
// Pure — also run by the unit tests against the committed file.

const DAY = 86_400_000;
// Names CelesTrak gives fragments and spent stages: "FENGYUN 1C DEB", "SL-6 R/B(2)".
export const JUNK_NAME = /\bDEB\b|\bR\/B/;

export function parseSnapshot(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) out.push({ name: lines[i], l1: lines[i + 1], l2: lines[i + 2] });
  return { sets: out, leftover: lines.length % 3 };
}

export function epochMs(l1) {
  const yy = parseInt(l1.slice(18, 20), 10), day = parseFloat(l1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return NaN;
  return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (day - 1) * DAY;
}

// Returns { problems, count, junk, medianEpochMs }.  `fresh: false` skips the
// age rule (a committed file ages; a fetch must be current).
export function validateSnapshot(text, { now = Date.now(), fresh = true } = {}) {
  const problems = [];
  const { sets, leftover } = parseSnapshot(text);
  if (leftover) problems.push('line count is not a multiple of three (name / line 1 / line 2)');
  if (sets.length < 8000 || sets.length > 60_000) problems.push(`${sets.length} objects (expected 8,000–60,000 for the active catalog)`);
  const bad = sets.filter((s) => !/^1 [ \d]{5}/.test(s.l1) || !/^2 [ \d]{5}/.test(s.l2) || s.l1.length < 60 || s.l2.length < 60 || s.l1.slice(2, 7) !== s.l2.slice(2, 7));
  if (bad.length) problems.push(`${bad.length} element sets are malformed (first: ${JSON.stringify(bad[0].name)})`);
  const junk = sets.filter((s) => JUNK_NAME.test(s.name)).length;
  if (junk > sets.length * 0.01) problems.push(`${junk} objects are named as debris or rocket bodies — this is not the active-satellite list`);
  const epochs = sets.map((s) => epochMs(s.l1)).filter(Number.isFinite).sort((a, b) => a - b);
  const median = epochs.length ? epochs[epochs.length >> 1] : NaN;
  if (!Number.isFinite(median)) problems.push('no readable element-set dates');
  else if (fresh && Math.abs(now - median) > 7 * DAY) problems.push(`element sets are dated ${new Date(median).toISOString().slice(0, 10)} — not current`);
  return { problems, count: sets.length, junk, medianEpochMs: median };
}
