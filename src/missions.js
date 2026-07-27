// missions.js — the Missions chapter: the story of spaceflight from Sputnik to
// this week.  Renders the curated milestones (missions-data.js, photos from
// mission-images.json) as an era-grouped timeline, then a live "story
// continues" tail from public/missions/recent.json — which CI refreshes on a
// schedule, so the chapter keeps itself current.
//
// Everything renders via textContent (the live tail is external text from
// Launch Library 2; the same discipline is applied everywhere).  Cards whose
// subject exists in the app carry a "Fly to it" button — that's the point of
// telling this story inside a tracker: Apollo is a place you can go.

import { ERAS, MISSIONS } from './missions-data.js';
import IMAGES from './mission-images.json';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

const mk = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const safeImg = (cls, url, alt) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  const img = mk('img', cls);
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = alt ?? '';
  img.addEventListener('error', () => img.remove(), { once: true });   // a dead archive link just drops the photo
  img.src = url;
  return img;
};

// deps: { onFly(spec) — close the overlay and navigate to an in-app target }
export function initMissions({ onFly }) {
  const $ = (id) => document.getElementById(id);
  let built = false;

  function missionCard(m) {
    const card = mk('article', 'mi-card');
    const img = safeImg('mi-img', IMAGES[m.id]?.img, '');
    if (img) card.appendChild(img);
    const body = mk('div', 'mi-body');

    const head = mk('div', 'mi-head');
    head.appendChild(mk('span', 'mi-date', fmtDate(m.date)));
    head.appendChild(mk('span', 'mi-agency', `${m.flag} ${m.agency}`));
    body.appendChild(head);
    body.appendChild(mk('h4', 'mi-name', m.name));
    if (m.crew) body.appendChild(mk('div', 'mi-crew', `👩‍🚀 ${m.crew}`));
    body.appendChild(mk('p', 'mi-story', m.story));
    if (m.disc) body.appendChild(mk('p', 'mi-disc', m.disc));
    if (m.fly) {
      const btn = mk('button', 'mi-fly', 'Fly to it →');
      btn.type = 'button';
      btn.addEventListener('click', () => onFly(m.fly));
      body.appendChild(btn);
    }
    card.appendChild(body);
    return card;
  }

  function liveRow(l, upcoming) {
    const row = mk('div', 'mi-live-row');
    const img = safeImg('mi-live-img', l.img, '');
    if (img) row.appendChild(img);
    const body = mk('div', 'mi-body');
    const head = mk('div', 'mi-head');
    head.appendChild(mk('span', 'mi-date', fmtDate(l.date)));
    head.appendChild(mk('span', 'mi-agency', l.agency || ''));
    if (upcoming) head.appendChild(mk('span', 'mi-upcoming', l.status === 'TBD' ? 'planned' : 'upcoming'));
    body.appendChild(head);
    body.appendChild(mk('h4', 'mi-name mi-name-live', l.name || 'Launch'));
    if (l.desc) body.appendChild(mk('p', 'mi-story', l.desc));
    row.appendChild(body);
    return row;
  }

  async function loadLive(host) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}missions/recent.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      host.replaceChildren();
      const head = mk('div', 'mi-era');
      head.appendChild(mk('div', 'mi-era-span', `updated ${fmtDate(data.updated)} · refreshes automatically`));
      head.appendChild(mk('h3', 'mi-era-title', 'The story continues'));
      head.appendChild(mk('p', 'mi-era-blurb',
        'Spaceflight no longer pauses between chapters — these are the latest launches and what’s scheduled next, pulled from live launch data. Check back; this page keeps itself current.'));
      host.appendChild(head);
      const prev = mk('div', 'mi-live-sub', 'Just flew');
      host.appendChild(prev);
      for (const l of (data.previous ?? []).slice(0, 8)) host.appendChild(liveRow(l, false));
      const up = mk('div', 'mi-live-sub', 'Up next');
      host.appendChild(up);
      for (const l of (data.upcoming ?? []).slice(0, 8)) host.appendChild(liveRow(l, true));
    } catch {
      host.replaceChildren(mk('p', 'mi-era-blurb', 'The live launch feed couldn’t be loaded right now — the story above still stands.'));
    }
  }

  function build() {
    if (built) return;
    built = true;
    const host = $('missions-body');

    // era jump nav
    const nav = mk('nav', 'mi-nav');
    for (const era of ERAS) {
      const a = mk('a', 'mi-nav-chip', era.title);
      a.href = `#mi-${era.id}`;
      a.addEventListener('click', (e) => {
        e.preventDefault();   // keep the app's deep-link hash out of it
        document.getElementById(`mi-${era.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      nav.appendChild(a);
    }
    const liveChip = mk('a', 'mi-nav-chip mi-nav-now', 'Now ●');
    liveChip.href = '#mi-live';
    liveChip.addEventListener('click', (e) => { e.preventDefault(); $('mi-live')?.scrollIntoView({ behavior: 'smooth' }); });
    nav.appendChild(liveChip);
    host.appendChild(nav);

    // the eras
    for (const era of ERAS) {
      const sec = mk('section', 'mi-era');
      sec.id = `mi-${era.id}`;
      sec.appendChild(mk('div', 'mi-era-span', era.span));
      sec.appendChild(mk('h3', 'mi-era-title', era.title));
      sec.appendChild(mk('p', 'mi-era-blurb', era.blurb));
      host.appendChild(sec);
      const list = mk('div', 'mi-list');
      for (const m of MISSIONS.filter((x) => x.era === era.id).sort((a, b) => a.date.localeCompare(b.date))) {
        list.appendChild(missionCard(m));
      }
      host.appendChild(list);
    }

    // the live tail
    const live = mk('div', 'mi-live');
    live.id = 'mi-live';
    live.appendChild(mk('p', 'mi-era-blurb', 'Loading the latest launches…'));
    host.appendChild(live);
    loadLive(live);

    host.appendChild(mk('p', 'mi-foot',
      'Milestones curated and fact-checked by hand · live launch data: Launch Library 2 by The Space Devs · photos: NASA Image and Video Library (public domain) and launch providers via Launch Library.'));
  }

  return { build, count: MISSIONS.length };
}
