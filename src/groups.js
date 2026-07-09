// groups.js — focus the swarm on a single "group": a constellation (matched by
// name) or an operator / nation (matched by SATCAT owner code).  It plugs into
// the same refreshVisibility() pipeline as the orbit-regime toggles and the
// launch timeline, so a group composes with them (Starlink + LEO-only, etc.).

// Constellations by name prefix/token.  Names are upper-cased catalog names.
const CONSTELLATIONS = [
  { id: 'starlink', label: 'Starlink', test: (n) => n.startsWith('STARLINK') },
  { id: 'oneweb', label: 'OneWeb', test: (n) => n.startsWith('ONEWEB') },
  { id: 'iridium', label: 'Iridium', test: (n) => n.startsWith('IRIDIUM') },
  { id: 'planet', label: 'Planet', test: (n) => n.startsWith('FLOCK') || n.startsWith('SKYSAT') },
  { id: 'spire', label: 'Spire', test: (n) => n.startsWith('LEMUR') },
  { id: 'gps', label: 'GPS', test: (n) => /\bNAVSTAR\b/.test(n) || /^GPS\b/.test(n) },
  { id: 'galileo', label: 'Galileo', test: (n) => /\bGALILEO\b/.test(n) },
  { id: 'glonass', label: 'GLONASS', test: (n) => /\bGLONASS\b/.test(n) },
  { id: 'beidou', label: 'BeiDou', test: (n) => /\bBEIDOU\b/.test(n) },
];

// Operators / nations by SATCAT owner code (sat.meta.owner).  A few are unions
// (ESA member states; India's ISRO vs IND).
const OWNERS = [
  { id: 'us', label: '🇺🇸 USA', codes: ['US'] },
  { id: 'prc', label: '🇨🇳 China', codes: ['PRC'] },
  { id: 'cis', label: '🇷🇺 Russia', codes: ['CIS'] },
  { id: 'esa', label: '🇪🇺 Europe', codes: ['ESA', 'FR', 'GER', 'IT', 'SPN', 'UK', 'EUME', 'EUTE', 'LUXE', 'NETH', 'BEL', 'NOR', 'SWED'] },
  { id: 'ind', label: '🇮🇳 India', codes: ['IND', 'ISRO'] },
  { id: 'jpn', label: '🇯🇵 Japan', codes: ['JPN'] },
];

export function initGroups({ getCatalog, onChange }) {
  const $ = (id) => document.getElementById(id);
  const GROUPS = [
    ...CONSTELLATIONS.map((g) => ({ ...g, kind: 'con', match: (s) => g.test(s.name.toUpperCase()) })),
    ...OWNERS.map((g) => { const set = new Set(g.codes); return { ...g, kind: 'own', match: (s) => set.has(s.meta?.owner) }; }),
  ];
  const byId = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
  let active = null;

  const passes = (sat) => !active || (byId[active] ? byId[active].match(sat) : true);

  const root = $('group-filter');
  const counts = {};
  const chipEls = {};

  function build() {
    root.innerHTML = '';
    const section = (title, items) => {
      const h = document.createElement('div');
      h.className = 'group-sub'; h.textContent = title;
      root.appendChild(h);
      const row = document.createElement('div');
      row.className = 'group-row';
      for (const g of items) {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'group-chip'; chip.dataset.id = g.id;
        chip.setAttribute('aria-pressed', 'false');
        chip.innerHTML = `<span class="g-label"></span><span class="g-count"></span>`;
        chip.querySelector('.g-label').textContent = g.label;
        chip.addEventListener('click', () => setActive(g.id));
        row.appendChild(chip);
        chipEls[g.id] = chip;
      }
      root.appendChild(row);
    };
    section('Constellations', GROUPS.filter((g) => g.kind === 'con'));
    section('Operators', GROUPS.filter((g) => g.kind === 'own'));
  }

  function setActive(id) {
    active = active === id ? null : id;
    for (const g of GROUPS) {
      const on = g.id === active;
      chipEls[g.id].classList.toggle('active', on);
      chipEls[g.id].setAttribute('aria-pressed', String(on));
    }
    onChange();
  }

  // Tally each group's membership once per catalog (18k × ~15 tests), and hide
  // chips for groups with nothing in today's catalog so the panel stays honest.
  function recount() {
    const catalog = getCatalog();
    for (const g of GROUPS) counts[g.id] = 0;
    for (const s of catalog) for (const g of GROUPS) if (g.match(s)) counts[g.id]++;
    for (const g of GROUPS) {
      const el = chipEls[g.id]; if (!el) continue;
      el.querySelector('.g-count').textContent = counts[g.id] ? counts[g.id].toLocaleString() : '';
      el.hidden = counts[g.id] === 0;
    }
    // If the active group vanished from the catalog, drop the filter.
    if (active && !counts[active]) setActive(active);
  }

  build();
  return { passes, setActive, recount, activeId: () => active, has: (id) => !!byId[id] };
}
