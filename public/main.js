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
      labels: { type: 'geojson', data: 'data/labels.geojson' },
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
        id: 'rivers-highlight', type: 'line', source: 'rivers',
        filter: ['==', ['get', 'rid'], -2],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': COLORS.highlight,
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

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

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

// --- Hover / tap -----------------------------------------------------------

const tooltip = document.getElementById('tooltip');
const isTouch = window.matchMedia('(hover: none)').matches;
if (isTouch) tooltip.classList.add('card');
let currentRid = null;

function riverAt(point, pad) {
  const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
  const hits = map.queryRenderedFeatures(box, { layers: ['rivers-hit'] });
  if (!hits.length) return null;
  // Prefer the most important river under the cursor (lowest scalerank).
  return hits.reduce((best, f) => (f.properties.sr < best.properties.sr ? f : best));
}

function show(feature, point) {
  const { rid, name, local } = feature.properties;
  if (rid !== currentRid) {
    currentRid = rid;
    map.setFilter('rivers-highlight', ['==', ['get', 'rid'], rid]);
    tooltip.textContent = name;
    if (local) {
      const span = document.createElement('span');
      span.className = 'local';
      span.textContent = ` (${local})`;
      tooltip.appendChild(span);
    }
  }
  tooltip.hidden = false;
  if (!isTouch) {
    tooltip.style.left = `${point.x}px`;
    tooltip.style.top = `${point.y}px`;
  }
}

function hide() {
  if (currentRid === null) return;
  currentRid = null;
  map.setFilter('rivers-highlight', ['==', ['get', 'rid'], -2]);
  tooltip.hidden = true;
}

map.on('mousemove', (e) => {
  if (isTouch) return;
  const f = riverAt(e.point, 3);
  map.getCanvas().style.cursor = f ? 'pointer' : '';
  f ? show(f, e.point) : hide();
});

map.getCanvas().addEventListener('mouseleave', () => { if (!isTouch) hide(); });
// The river under a still cursor changes when the map moves.
map.on('movestart', () => { if (!isTouch) hide(); });

map.on('click', (e) => {
  if (!isTouch) return;
  const f = riverAt(e.point, 12);
  f ? show(f, e.point) : hide();
});
