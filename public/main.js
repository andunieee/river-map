const COLORS = {
  ocean: '#cfe0ea',
  land: '#f3efe6',
  river: '#3a86c4',
  highlight: '#e8590c',
  label: '#1d4e75',
};

// Rivers appear once the zoom reaches their `mz` (min zoom) property.
const visibleAtZoom = ['>=', ['zoom'], ['get', 'mz']];

// Line width grows with river size (`w`) and with zoom.
// `extra` adds a fixed number of pixels (used for the highlight halo).
const riverWidth = (scale, extra = 0) => ['interpolate', ['exponential', 1.6], ['zoom'],
  0, ['+', extra, ['*', ['get', 'w'], 0.6 * scale]],
  4, ['+', extra, ['*', ['get', 'w'], 1.0 * scale]],
  8, ['+', extra, ['*', ['get', 'w'], 2.2 * scale]],
  12, ['+', extra, ['*', ['get', 'w'], 4.0 * scale]],
];

const LINE_LABEL_ZOOM = 6;
const labelSize = ['interpolate', ['linear'], ['get', 'w'], 0.5, 11, 3, 14];
const labelPaint = {
  'text-color': COLORS.label,
  'text-halo-color': 'rgba(255,255,255,0.85)',
  'text-halo-width': 1.5,
};

const NONE = ['literal', []];
const emptyData = { type: 'FeatureCollection', features: [] };

const map = new maplibregl.Map({
  container: 'map',
  center: [20, 30],
  zoom: 1.5,
  maxZoom: 12,
  renderWorldCopies: false,
  style: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      land: { type: 'geojson', data: 'data/land50.geojson' },
      lakes: { type: 'geojson', data: 'data/lakes.geojson' },
      rivers: { type: 'geojson', data: 'data/rivers.geojson', tolerance: 0.5 },
      // Filled in below; the same data also powers search and the info panel.
      labels: { type: 'geojson', data: emptyData },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': COLORS.ocean } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': COLORS.land } },
      {
        id: 'lakes', type: 'fill', source: 'lakes', filter: visibleAtZoom,
        paint: { 'fill-color': COLORS.ocean, 'fill-outline-color': '#a9c6d8' },
      },
      {
        id: 'rivers', type: 'line', source: 'rivers', filter: visibleAtZoom,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': COLORS.river,
          'line-width': riverWidth(1),
          // Lines through lakes are faint so the lake shape reads first.
          'line-opacity': ['case', ['has', 'lake'], 0.35, 0.9],
        },
      },
      {
        // The river picked by clicking or searching. No zoom filter, so the
        // whole river shows even where its smaller stretches are hidden.
        id: 'rivers-selected', type: 'line', source: 'rivers',
        filter: ['in', ['get', 'rid'], NONE],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': COLORS.highlight,
          'line-width': riverWidth(1.4, 2),
        },
      },
      {
        id: 'rivers-highlight', type: 'line', source: 'rivers',
        filter: ['in', ['get', 'rid'], NONE],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': COLORS.highlight,
          'line-opacity': 0.8,
          'line-width': riverWidth(1.4, 2),
        },
      },
      {
        // Invisible wide lines so thin rivers are easy to hover and tap.
        id: 'rivers-hit', type: 'line', source: 'rivers',
        filter: ['all', visibleAtZoom, ['has', 'name']],
        paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 },
      },
      {
        // Zoomed out: one label per river, the biggest rivers win collisions.
        id: 'river-labels-point', type: 'symbol', source: 'labels',
        filter: ['all', ['<', ['zoom'], LINE_LABEL_ZOOM], ['>=', ['zoom'], ['+', ['get', 'mz'], 1]]],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Italic'],
          'text-size': labelSize,
          'symbol-sort-key': ['get', 'prio'],
          'text-padding': 6,
        },
        paint: labelPaint,
      },
      {
        // Zoomed in: labels follow the river's course.
        id: 'river-labels-line', type: 'symbol', source: 'rivers',
        filter: ['all', ['has', 'name'], ['!', ['has', 'lake']],
          ['>=', ['zoom'], LINE_LABEL_ZOOM], ['>=', ['zoom'], ['+', ['get', 'mz'], 2]]],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Italic'],
          'text-size': labelSize,
          'symbol-sort-key': ['get', 'sr'],
          'symbol-spacing': 400,
          'text-max-angle': 60,
        },
        paint: labelPaint,
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

map.on('load', () => {
  document.getElementById('loading').remove();
});

// The detailed coastline is large; fetch it only once the user zooms in.
let detailedLand = false;
map.on('zoomend', () => {
  if (!detailedLand && map.getZoom() >= 4) {
    detailedLand = true;
    map.getSource('land').setData('data/land.geojson');
  }
});

// --- Rivers index ------------------------------------------------------------

// One entry per river. Natural Earth sometimes splits a river into pieces
// with different names (Irtysh and Ertis); pieces linked to the same
// Wikipedia article become one entry so they highlight and search together.
const entries = [];
const entryByRid = new Map();

const normalize = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function buildIndex(labels) {
  const byWiki = new Map();
  // Labels are sorted most important first, so the first piece names the entry.
  for (const { properties: p } of labels.features) {
    let entry = p.wiki && byWiki.get(p.wiki);
    if (!entry) {
      entry = { name: p.name, names: new Set(), rids: [], bbox: [...p.bbox], mz: p.mz, wiki: p.wiki };
      entries.push(entry);
      if (p.wiki) byWiki.set(p.wiki, entry);
    }
    for (const n of [p.name, p.local, ...(p.alt || [])]) if (n) entry.names.add(n);
    entry.rids.push(p.rid);
    entry.mz = Math.min(entry.mz, p.mz);
    entry.bbox = [Math.min(entry.bbox[0], p.bbox[0]), Math.min(entry.bbox[1], p.bbox[1]),
      Math.max(entry.bbox[2], p.bbox[2]), Math.max(entry.bbox[3], p.bbox[3])];
    entryByRid.set(p.rid, entry);
  }
  for (const e of entries) {
    if (e.wiki) e.names.add(e.wiki);
    e.search = [...e.names].map(normalize);
  }
}

fetch('data/labels.geojson')
  .then((r) => r.json())
  .then((labels) => {
    buildIndex(labels);
    const setLabels = () => map.getSource('labels').setData(labels);
    map.isStyleLoaded() ? setLabels() : map.once('load', setLabels);
  });

// --- Hover -------------------------------------------------------------------

const tooltip = document.getElementById('tooltip');
const isTouch = window.matchMedia('(hover: none)').matches;
let hoveredRid = null;

function riverAt(point, pad) {
  const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
  const hits = map.queryRenderedFeatures(box, { layers: ['rivers-hit'] });
  if (!hits.length) return null;
  // Prefer the most important river under the cursor (lowest scalerank).
  return hits.reduce((best, f) => (f.properties.sr < best.properties.sr ? f : best));
}

const ridsOf = (rid) => entryByRid.get(rid)?.rids ?? [rid];

function showTooltip(feature, point) {
  const { rid, name, local } = feature.properties;
  if (rid !== hoveredRid) {
    hoveredRid = rid;
    map.setFilter('rivers-highlight', ['in', ['get', 'rid'], ['literal', ridsOf(rid)]]);
    tooltip.textContent = name;
    if (local) {
      const span = document.createElement('span');
      span.className = 'local';
      span.textContent = ` (${local})`;
      tooltip.appendChild(span);
    }
  }
  tooltip.hidden = false;
  tooltip.style.left = `${point.x}px`;
  tooltip.style.top = `${point.y}px`;
}

function hideTooltip() {
  if (hoveredRid === null) return;
  hoveredRid = null;
  map.setFilter('rivers-highlight', ['in', ['get', 'rid'], NONE]);
  tooltip.hidden = true;
}

map.on('mousemove', (e) => {
  if (isTouch) return;
  const f = riverAt(e.point, 3);
  map.getCanvas().style.cursor = f ? 'pointer' : '';
  f ? showTooltip(f, e.point) : hideTooltip();
});

map.getCanvas().addEventListener('mouseleave', () => { if (!isTouch) hideTooltip(); });
// The river under a still cursor changes when the map moves.
map.on('movestart', () => { if (!isTouch) hideTooltip(); });

// --- Selection and info panel ------------------------------------------------

const panel = document.getElementById('panel');
const panelName = panel.querySelector('.name');
const panelAlt = panel.querySelector('.alt');
const panelWiki = panel.querySelector('.wiki');
const summaries = new Map();
let selected = null;

function select(entry) {
  selected = entry;
  map.setFilter('rivers-selected', ['in', ['get', 'rid'], ['literal', entry.rids]]);
  panelName.textContent = entry.name;
  const others = [...entry.names].filter((n) => n !== entry.name && n !== entry.wiki);
  // Local names, plus channels or stretches that link to the same article.
  panelAlt.textContent = `Also on the map as: ${others.join(' · ')}`;
  panelAlt.hidden = !others.length;
  panel.hidden = false;
  showWiki(entry);
}

function deselect() {
  selected = null;
  map.setFilter('rivers-selected', ['in', ['get', 'rid'], NONE]);
  panel.hidden = true;
}

function zoomTo(entry) {
  // Keep the river clear of the search box and the info panel.
  const padding = { top: 110, right: 40, bottom: 40, left: 40 };
  if (!panel.hidden) {
    if (window.matchMedia('(max-width: 600px)').matches) {
      padding.bottom += window.innerHeight * 0.5; // the sheet's max height
    } else {
      padding.right += panel.offsetWidth;
    }
  }
  const cam = map.cameraForBounds(entry.bbox, { padding });
  // Zoom in at least far enough that the river is drawn.
  map.flyTo({ ...cam, zoom: Math.min(Math.max(cam.zoom, entry.mz + 0.5), 9), duration: 1200 });
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function fetchSummary(title) {
  if (!summaries.has(title)) {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
    summaries.set(title, fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status))));
  }
  return summaries.get(title);
}

async function showWiki(entry) {
  if (!entry.wiki) {
    const q = encodeURIComponent(`${entry.name} river`);
    panelWiki.replaceChildren(
      el('p', { className: 'muted', textContent: 'No Wikipedia article is linked to this river. ' },
        el('a', { href: `https://en.wikipedia.org/w/index.php?search=${q}`, target: '_blank', rel: 'noopener', textContent: 'Search Wikipedia' })),
    );
    return;
  }
  panelWiki.replaceChildren(el('p', { className: 'muted', textContent: 'Loading from Wikipedia…' }));
  let s;
  try {
    s = await fetchSummary(entry.wiki);
  } catch {
    if (selected !== entry) return;
    summaries.delete(entry.wiki); // allow a retry on the next click
    panelWiki.replaceChildren(el('p', { className: 'muted', textContent: 'Couldn’t load the Wikipedia summary.' }));
    return;
  }
  if (selected !== entry) return; // another river was picked meanwhile
  const children = [];
  if (s.thumbnail) children.push(el('img', { className: 'thumb', src: s.thumbnail.source, alt: '' }));
  children.push(el('h3', { textContent: s.title }));
  if (s.description) children.push(el('p', { className: 'desc', textContent: s.description }));
  children.push(el('p', { className: 'extract', textContent: s.extract }));
  children.push(el('a', {
    className: 'more', href: s.content_urls.desktop.page, target: '_blank', rel: 'noopener',
    textContent: 'Read more on Wikipedia',
  }));
  panelWiki.replaceChildren(...children);
}

panel.querySelector('.close').addEventListener('click', deselect);
panel.querySelector('.zoom').addEventListener('click', () => selected && zoomTo(selected));

map.on('click', (e) => {
  const f = riverAt(e.point, isTouch ? 12 : 3);
  const entry = f && entryByRid.get(f.properties.rid);
  entry ? select(entry) : deselect();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement === document.body) deselect();
});

// --- Search ------------------------------------------------------------------

const searchInput = document.getElementById('search-input');
const resultsList = document.getElementById('search-results');
let results = [];
let active = -1;

function score(entry, q) {
  // 0 exact, 1 prefix, 2 word prefix, 3 substring; lower is better.
  let best = Infinity;
  for (const n of entry.search) {
    if (n === q) return 0;
    if (n.startsWith(q)) best = Math.min(best, 1);
    else if (n.includes(` ${q}`) || n.includes(`-${q}`)) best = Math.min(best, 2);
    else if (q.length >= 3 && n.includes(q)) best = Math.min(best, 3);
  }
  return best;
}

function search(query) {
  const q = normalize(query.trim());
  if (!q) return [];
  const hits = [];
  // `entries` is already ordered by importance, which breaks ties.
  for (const e of entries) {
    const s = score(e, q);
    if (s < Infinity) hits.push([s, hits.length, e]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.slice(0, 8).map((h) => h[2]);
}

function renderResults() {
  resultsList.replaceChildren(...results.map((entry, i) => {
    const q = normalize(searchInput.value.trim());
    // Show which name matched when it isn't the main one ("Ertis" → Irtysh).
    const matched = [...entry.names].find((n) => normalize(n).includes(q) && n !== entry.name);
    const detail = entry.wiki && entry.wiki !== entry.name ? entry.wiki : matched;
    const li = el('li', { role: 'option', id: `result-${i}` },
      el('span', { className: 'result-name', textContent: entry.name }));
    if (detail) li.append(el('span', { className: 'result-detail', textContent: detail }));
    li.setAttribute('aria-selected', i === active);
    li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(entry); });
    return li;
  }));
  if (searchInput.value.trim() && !results.length) {
    resultsList.append(el('li', { className: 'empty', textContent: 'No rivers found' }));
  }
  resultsList.hidden = !searchInput.value.trim();
  searchInput.setAttribute('aria-expanded', !resultsList.hidden);
  searchInput.setAttribute('aria-activedescendant', active >= 0 ? `result-${active}` : '');
}

function choose(entry) {
  searchInput.value = entry.name;
  results = [];
  resultsList.hidden = true;
  searchInput.blur();
  select(entry);
  zoomTo(entry);
}

searchInput.addEventListener('input', () => {
  results = search(searchInput.value);
  active = results.length ? 0 : -1;
  renderResults();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderResults();
  } else if (e.key === 'Enter' && results[active]) {
    choose(results[active]);
  } else if (e.key === 'Escape') {
    searchInput.value = '';
    results = [];
    renderResults();
    searchInput.blur();
  }
});

searchInput.addEventListener('blur', () => { resultsList.hidden = true; });
searchInput.addEventListener('focus', () => { if (results.length) renderResults(); });

// --- Info box ----------------------------------------------------------------

// Touch screens can't hover, so tapping the box toggles it instead.
const infoBox = document.getElementById('title');
infoBox.addEventListener('click', (e) => {
  if (!isTouch || e.target.closest('a')) return;
  if (infoBox.classList.toggle('open')) return;
  infoBox.blur();
});
map.on('click', () => {
  infoBox.classList.remove('open');
  infoBox.blur();
});
