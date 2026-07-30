// catalog-browser.js — a browsable reference of every tracked object, searchable
// by name or NORAD ID and filterable by orbit type.  The live catalog is ~17,000
// objects, so the list is virtual-scrolled: only the ~two dozen rows in view
// exist in the DOM at once, positioned absolutely inside a full-height sizer.
// Click a row (or press Enter on an exact ID) to fly straight to it.

const ROW_H = 46;   // px — MUST match .cat-row height in style.css

const REGIMES = [
  { id: 'ALL', label: 'All' },
  { id: 'LEO', label: 'LEO' },
  { id: 'MEO', label: 'MEO' },
  { id: 'GEO', label: 'GEO' },
  { id: 'HEO', label: 'HEO' },
  { id: 'DEB', label: 'Debris' },
];

// Same bucketing the legend uses: debris is its own class, everything else by regime.
const catOf = (s) => (s.kind === 'DEB' ? 'DEB' : s.regime);

// deps: { getCatalog(), decodeOwner(code), onPick(norad) }
export function initCatalogBrowser({ getCatalog, decodeOwner, onPick }) {
  const $ = (id) => document.getElementById(id);
  let built = false;
  let filtered = [];        // catalog indices, in display order
  let regime = 'ALL';
  let sortMode = 'id';      // 'id' | 'name'
  let qInput, scroller, sizer, rowsLayer, countEl, emptyEl, rafPending = false;

  function recompute() {
    const cat = getCatalog();
    const q = qInput.value.trim().toUpperCase();
    const out = [];
    for (let i = 0; i < cat.length; i++) {
      const s = cat[i];
      if (regime !== 'ALL' && catOf(s) !== regime) continue;
      if (q && !String(s.norad).includes(q) && !s.name.toUpperCase().includes(q)) continue;
      out.push(i);
    }
    out.sort(sortMode === 'id'
      ? (a, b) => cat[a].norad - cat[b].norad
      : (a, b) => cat[a].name.localeCompare(cat[b].name) || cat[a].norad - cat[b].norad);
    filtered = out;
    sizer.style.height = `${filtered.length * ROW_H}px`;
    countEl.textContent = cat.length
      ? `${filtered.length.toLocaleString()} of ${cat.length.toLocaleString()} objects`
      : 'catalog still loading…';
    emptyEl.hidden = filtered.length > 0;
    scroller.scrollTop = 0;
    renderWindow();
  }

  // Render only the rows intersecting the viewport (plus a small overscan).
  function renderWindow() {
    rafPending = false;
    const cat = getCatalog();
    const top = scroller.scrollTop;
    const h = scroller.clientHeight || 420;
    const first = Math.max(0, Math.floor(top / ROW_H) - 6);
    const last = Math.min(filtered.length, Math.ceil((top + h) / ROW_H) + 6);
    const frag = document.createDocumentFragment();
    for (let k = first; k < last; k++) {
      const s = cat[filtered[k]];
      if (!s) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cat-row';
      row.style.top = `${k * ROW_H}px`;
      row.addEventListener('click', () => onPick(s.norad));

      const reg = catOf(s);
      const id = document.createElement('span'); id.className = 'cat-id'; id.textContent = s.norad;
      const name = document.createElement('span'); name.className = 'cat-name'; name.textContent = s.name;
      const badge = document.createElement('span'); badge.className = `cat-badge ${reg.toLowerCase()}`; badge.textContent = reg;
      // Owner comes from SATCAT metadata (present for live-catalog users); when
      // it's absent leave the cell blank rather than a wall of "Unknown".
      const owner = document.createElement('span'); owner.className = 'cat-owner';
      owner.textContent = s.meta?.owner ? decodeOwner(s.meta.owner) : '';
      row.append(id, name, badge, owner);
      frag.appendChild(row);
    }
    rowsLayer.replaceChildren(frag);
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(renderWindow);
  }

  function build() {
    if (built) return;
    built = true;
    const host = $('catalog-ui');

    const controls = document.createElement('div');
    controls.className = 'cat-controls';
    controls.innerHTML = `
      <input id="catalog-q" type="search" placeholder="Filter by name or NORAD ID…" autocomplete="off"
             aria-label="Filter the catalog by name or NORAD ID" />
      <div class="cat-chips" role="group" aria-label="Filter by orbit type"></div>
      <div class="cat-meta">
        <span id="catalog-count" class="cat-count"></span>
        <label class="cat-sort">sort
          <select id="catalog-sort" aria-label="Sort order">
            <option value="id">NORAD ID</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
      </div>`;
    host.appendChild(controls);

    const chipWrap = controls.querySelector('.cat-chips');
    REGIMES.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cat-chip' + (r.id === 'ALL' ? ' active' : '');
      b.textContent = r.label;
      b.dataset.reg = r.id;
      b.addEventListener('click', () => {
        regime = r.id;
        chipWrap.querySelectorAll('.cat-chip').forEach((c) => c.classList.toggle('active', c === b));
        recompute();
      });
      chipWrap.appendChild(b);
    });

    scroller = document.createElement('div'); scroller.className = 'cat-scroll'; scroller.id = 'catalog-scroll';
    sizer = document.createElement('div'); sizer.className = 'cat-sizer';
    rowsLayer = document.createElement('div'); rowsLayer.className = 'cat-rows';
    sizer.appendChild(rowsLayer);
    scroller.appendChild(sizer);
    emptyEl = document.createElement('p'); emptyEl.className = 'cat-empty'; emptyEl.textContent = 'No matching objects.'; emptyEl.hidden = true;
    host.append(scroller, emptyEl);

    qInput = controls.querySelector('#catalog-q');
    countEl = controls.querySelector('#catalog-count');
    qInput.addEventListener('input', recompute);
    qInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !filtered.length) return;
      e.preventDefault();
      const cat = getCatalog();
      const q = qInput.value.trim();
      const exact = filtered.find((i) => String(cat[i].norad) === q);   // exact ID wins over the first row
      onPick(cat[exact ?? filtered[0]].norad);
    });
    controls.querySelector('#catalog-sort').addEventListener('change', (e) => { sortMode = e.target.value; recompute(); });
    scroller.addEventListener('scroll', onScroll, { passive: true });

    recompute();
  }

  return {
    build,
    // re-run against a possibly hot-swapped catalog and re-measure now that the
    // overlay is visible (clientHeight is 0 while it's display:none)
    refresh: () => { if (built) recompute(); },
    focusSearch: () => qInput?.focus(),
  };
}
