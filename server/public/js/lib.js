import { quality } from './round-stats.js';

// Shared helpers for the Glide Path website. Pages with maps load Leaflet as the global `L`,
// and /js/config.js sets window.GLIDE_PATH_TILES from the server's settings.

export const $ = (selector, root = document) => root.querySelector(selector);

// Builds DOM nodes; text is always set as text, never parsed as HTML.
export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
};

// Replaces an element's contents. Unlike replaceChildren, nested arrays are flattened and
// null/false entries (optional sections) are skipped instead of shown as text.
export const setChildren = (parent, ...children) => {
  parent.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
};

export const TOKEN_KEY = 'glide-path-token';

export const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error ?? `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
};

// Server-rendered pages embed their data as JSON, so they need no second request.
export const pageData = () => {
  const node = document.getElementById('page-data');
  return node ? JSON.parse(node.textContent) : null;
};

export const formatToPar = (diff) => (diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff));
export const toParClass = (diff) => (diff < 0 ? 'under' : diff > 0 ? 'over' : '');
export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Matches the app: an out-of-bounds throw adds a penalty stroke.
export const strokes = (shots) => shots.length + shots.filter((shot) => shot.lie === 'OB').length;

export const holesPlayed = (shots) => [...new Set(shots.map((shot) => shot.hole))].sort((a, b) => a - b)
  .map((hole) => ({ hole, shots: shots.filter((shot) => shot.hole === hole) }));

export const throwDetail = (shot) => [
  shot.feet ? `${shot.feet} ft` : null,
  [shot.disc || 'No disc', shot.style?.toLowerCase(), shot.type?.toLowerCase()].filter(Boolean).join(' '),
  shot.lie === 'OB' ? 'OB (+1)' : shot.lie?.toLowerCase(),
  shot.quality ? `${shot.quality}/${shot.qualityMax ?? 5}` : null,
].filter(Boolean).join(' · ');

const EARTH_RADIUS_FEET = 20_902_231;
export const feetBetween = (a, b) => {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS_FEET * Math.asin(Math.sqrt(h));
};

export const formatDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

// ---------------------------------------------------------------- maps

const latLng = (point) => [point.latitude, point.longitude];

export const satelliteMap = (container) => {
  if (!window.L || !container) return null;
  const map = L.map(container, { scrollWheelZoom: false, tap: true });
  const tiles = window.GLIDE_PATH_TILES;
  if (tiles) L.tileLayer(tiles.url, { maxZoom: 21, maxNativeZoom: 19, attribution: tiles.attribution }).addTo(map);
  return map;
};

const cssColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Draws each mapped hole's tee, basket and tee-to-basket line; returns the layer and its bounds.
export const drawHoles = (map, layouts, { only } = {}) => {
  const group = L.layerGroup();
  const bounds = [];
  layouts.forEach((layout, index) => {
    const hole = index + 1;
    if (!layout || (only !== undefined && hole !== only)) return;
    if (layout.tee) {
      L.circleMarker(latLng(layout.tee), { radius: 7, color: '#fff', weight: 2, fillColor: '#1d684c', fillOpacity: 1 })
        .bindTooltip(`${hole}`, { permanent: true, direction: 'top', offset: [0, -8], className: 'hole-label' })
        .bindPopup(`Hole ${hole} tee${layout.par ? ` · par ${layout.par}` : ''}`)
        .addTo(group);
      bounds.push(latLng(layout.tee));
    }
    if (layout.basket) {
      L.circleMarker(latLng(layout.basket), { radius: 6, color: '#fff', weight: 2, fillColor: '#d77d42', fillOpacity: 1 })
        .bindPopup(`Hole ${hole} basket`)
        .addTo(group);
      bounds.push(latLng(layout.basket));
    }
    if (layout.tee && layout.basket) {
      L.polyline([latLng(layout.tee), latLng(layout.basket)], { color: '#fff', weight: 2, dashArray: '6 5', opacity: 0.9 }).addTo(group);
    }
  });
  group.addTo(map);
  return { group, bounds };
};

// Marker color follows the throw's quality (3 good, 2 fair, 1 poor); unrated throws keep the
// default color, and an OB throw also gets a dark outline.
const QUALITY_CLASSES = { 1: 'poor', 2: 'fair', 3: 'good' };
export const throwMarkerClass = (shot) => ['throw-marker', QUALITY_CLASSES[quality(shot)], shot.lie === 'OB' ? 'ob' : null].filter(Boolean).join(' ');

// The key shown under round maps.
export const throwLegend = () => el('p', { class: 'map-legend' },
  el('span', { class: 'legend-dot good' }), 'Good', el('span', { class: 'legend-dot fair' }), 'Fair',
  el('span', { class: 'legend-dot poor' }), 'Poor', el('span', { class: 'legend-dot' }), 'Not rated',
  el('span', { class: 'legend-dot ob' }), 'OB');

// Line colors match the marker colors in styles.css; unrated throws use the default throw color.
const QUALITY_COLORS = { good: '#2e9d5b', fair: '#e3b505', poor: '#d64541' };

// Each throw's line, from where it was thrown (the previous positioned throw, or the tee) to
// where it landed, styled like its marker: quality color, dashed when OB.
export const throwSegments = (shots, tee) => {
  const segments = [];
  let previous = tee ? { latitude: tee.latitude, longitude: tee.longitude } : null;
  for (const shot of shots) {
    if (shot.latitude === undefined || shot.longitude === undefined) continue;
    const point = { latitude: shot.latitude, longitude: shot.longitude };
    if (previous) segments.push({ from: previous, to: point, shot, color: QUALITY_COLORS[QUALITY_CLASSES[quality(shot)]] ?? null, dashed: shot.lie === 'OB' });
    previous = point;
  }
  return segments;
};

// Distance labels sit at the middle of each drive's and approach's line; putts are short and
// bunched near the basket, so they're left unlabeled. Returns [midpoint, text] pairs.
export const segmentLabels = (shots, tee) => throwSegments(shots, tee)
  .filter(({ shot }) => shot.type === 'Drive' || shot.type === 'Approach')
  .map(({ from, to, shot }) => [
    [(from.latitude + to.latitude) / 2, (from.longitude + to.longitude) / 2],
    `${shot.feet > 0 ? shot.feet : Math.round(feetBetween(from, to))} ft`,
  ]);

// Numbered throw markers joined from the tee, as in the app.
export const drawThrows = (map, shots, tee) => {
  const group = L.layerGroup();
  const bounds = tee ? [latLng(tee)] : [];
  // Lines first, so markers and labels draw on top of them.
  const defaultColor = cssColor('--throw') || '#df8547';
  for (const segment of throwSegments(shots, tee)) {
    L.polyline([latLng(segment.from), latLng(segment.to)], { color: segment.color ?? defaultColor, weight: 4, opacity: 0.95, dashArray: segment.dashed ? '8 6' : null }).addTo(group);
  }
  shots.forEach((shot, index) => {
    if (shot.latitude === undefined || shot.longitude === undefined) return;
    const point = [shot.latitude, shot.longitude];
    bounds.push(point);
    L.marker(point, {
      icon: L.divIcon({ className: '', html: `<div class="${throwMarkerClass(shot)}">${index + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      title: `Throw ${index + 1}`,
    // Disc names are user text, so the popup gets a text node rather than an HTML string.
    }).bindPopup(el('span', {}, `Throw ${index + 1}: ${throwDetail(shot)}`)).addTo(group);
  });
  for (const [midpoint, text] of segmentLabels(shots, tee)) {
    // Text is built from numbers only, so it's safe as HTML.
    L.marker(midpoint, { icon: L.divIcon({ className: '', html: `<span class="segment-label">${text}</span>`, iconSize: null }), interactive: false, keyboard: false }).addTo(group);
  }
  group.addTo(map);
  return { group, bounds };
};

export const fitTo = (map, bounds, fallbackZoom = 18) => {
  if (!bounds.length) return false;
  if (bounds.length === 1) map.setView(bounds[0], fallbackZoom);
  else map.fitBounds(bounds, { padding: [28, 28], maxZoom: 19 });
  return true;
};

// Shows one hole of a round at a time: its tee and basket plus each logged throw.
// Rows with data-hole under `rowsRoot` switch the hole.
export const setUpRoundMap = (container, shots, layouts, rowsRoot = document) => {
  const map = satelliteMap(container);
  if (!map) {
    container?.remove();
    return;
  }
  const holes = [...new Set(shots.map((shot) => shot.hole))].sort((a, b) => a - b);
  let layers = [];

  const showHole = (hole) => {
    layers.forEach((layer) => layer.remove());
    const layout = layouts[hole - 1];
    const course = drawHoles(map, layouts, { only: hole });
    const throws = drawThrows(map, shots.filter((shot) => shot.hole === hole), layout?.tee ?? null);
    layers = [course.group, throws.group];
    rowsRoot.querySelectorAll('tr[data-hole]').forEach((row) => row.classList.toggle('active', Number(row.dataset.hole) === hole));
    if (!fitTo(map, [...course.bounds, ...throws.bounds])) map.setView([39.8, -98.6], 3);
  };

  // Open on the first hole that has anything to draw.
  const first = holes.find((hole) => layouts[hole - 1]?.tee || shots.some((shot) => shot.hole === hole && shot.latitude !== undefined));
  if (first === undefined) {
    container.remove();
    return;
  }
  showHole(first);
  rowsRoot.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-hole]');
    if (!row) return;
    showHole(Number(row.dataset.hole));
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
};
