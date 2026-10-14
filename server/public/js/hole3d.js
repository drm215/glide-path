// A hole in 3D: satellite imagery over real terrain, the tee, basket and each logged landing
// spot, with every throw drawn as an arc from where it was thrown to where it landed. Only
// landing spots are logged, so the arcs show the throw's path along the ground, not its flight.
// Used by the website's round pages and, through /3d, by the app.
import { el, setChildren, throwDetail, throwMarkerClass, throwSegments } from './lib.js';
import { filterGroup } from './summary.js';

const MAPLIBRE = '/vendor/maplibre/maplibre-gl.mjs';
// Public terrain tiles (Terrarium-encoded heights) on AWS, built from USGS 3DEP, SRTM and others.
export const TERRAIN_TILES = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const TERRAIN_ATTRIBUTION = 'Elevation: Mapzen Terrain Tiles on AWS (USGS 3DEP, SRTM and others)';
// Hills on a disc golf hole are gentle; a little exaggeration makes them readable.
export const EXAGGERATION = 1.5;
const DEFAULT_ARC_COLOR = '#df8547';

const M_PER_DEGREE = 111_320;
const rad = (degrees) => (degrees * Math.PI) / 180;
// Meters east and north of `origin`, and back; accurate enough over a hole's few hundred meters.
const toMeters = (origin, point) => ({
  x: (point.longitude - origin.longitude) * M_PER_DEGREE * Math.cos(rad(origin.latitude)),
  y: (point.latitude - origin.latitude) * M_PER_DEGREE,
});
const fromMeters = (origin, { x, y }) => [
  origin.longitude + x / (M_PER_DEGREE * Math.cos(rad(origin.latitude))),
  origin.latitude + y / M_PER_DEGREE,
];

// Compass bearing (degrees) from one point to another, for pointing the camera down the hole.
export const bearingBetween = (from, to) => {
  const { x, y } = toMeters(from, to);
  return (Math.atan2(x, y) * 180) / Math.PI;
};

// One throw's arc as short floating boxes (fill-extrusion polygons): a parabola from the lie to
// the landing spot, peaking at about an eighth of the distance (1–18 m). `color` paints it.
export const arcFeatures = (from, to, color) => {
  const { x: dx, y: dy } = toMeters(from, to);
  const length = Math.hypot(dx, dy);
  if (length < 1) return [];
  const apex = Math.min(18, Math.max(1, length / 8));
  const steps = Math.min(48, Math.max(8, Math.ceil(length / 1.5)));
  const half = 0.35;
  // A sideways offset that gives each box its width.
  const side = { x: (-dy / length) * half, y: (dx / length) * half };
  const along = (t) => ({ x: dx * t, y: dy * t });
  return Array.from({ length: steps }, (_, index) => {
    const start = along(index / steps);
    const end = along((index + 1) / steps);
    const middle = (index + 0.5) / steps;
    const height = 4 * apex * middle * (1 - middle);
    const ring = [
      { x: start.x + side.x, y: start.y + side.y }, { x: end.x + side.x, y: end.y + side.y },
      { x: end.x - side.x, y: end.y - side.y }, { x: start.x - side.x, y: start.y - side.y },
    ].map((point) => fromMeters(from, point));
    return {
      type: 'Feature',
      properties: { color, base: Math.max(0, height - half), height: height + half },
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    };
  });
};

// A circle around the basket, `radius` meters, as a line.
const circleFeature = (center, radius) => ({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'LineString',
    coordinates: Array.from({ length: 65 }, (_, index) => fromMeters(center, { x: radius * Math.sin((index / 64) * 2 * Math.PI), y: radius * Math.cos((index / 64) * 2 * Math.PI) })),
  },
});

const lngLat = (point) => [point.longitude, point.latitude];
const hasPosition = (shot) => shot.latitude !== undefined && shot.longitude !== undefined;

// The hole's throws from the chosen rounds, each made throw without a logged spot placed at the
// basket. Returns { arcs, markers, unplaced } for drawing.
export const holeThrows = (rounds, hole, layout) => {
  const arcs = [];
  const markers = [];
  let unplaced = 0;
  for (const round of rounds) {
    const shots = round.shots.filter((shot) => shot.hole === hole)
      .map((shot) => (!hasPosition(shot) && shot.lie === 'Basket' && layout?.basket ? { ...shot, latitude: layout.basket.latitude, longitude: layout.basket.longitude } : shot));
    unplaced += shots.filter((shot) => !hasPosition(shot)).length;
    for (const segment of throwSegments(shots, layout?.tee ?? null)) arcs.push(...arcFeatures(segment.from, segment.to, segment.color ?? DEFAULT_ARC_COLOR));
    shots.forEach((shot, index) => { if (hasPosition(shot)) markers.push({ shot, number: index + 1, round }); });
  }
  return { arcs, markers, unplaced };
};

let maplibrePromise = null;
const loadMapLibre = () => {
  if (!maplibrePromise) {
    if (!document.querySelector('link[data-maplibre]')) document.head.append(el('link', { rel: 'stylesheet', href: '/vendor/maplibre/maplibre-gl.css', 'data-maplibre': true }));
    maplibrePromise = import(MAPLIBRE);
  }
  return maplibrePromise;
};

const feetText = (meters) => `${Math.round(Math.abs(meters) / 0.3048)} ft`;

// Draws one hole in `container`. `rounds` are [{ id, label, shots }] with all of each round's
// throws; `selected` are the round ids shown first (none means all). With more than one round,
// buttons pick which are shown. Returns { destroy }.
export const renderHole3d = (container, { hole, layout, rounds, selected = [] }) => {
  let map = null;
  let library = null;
  let markers = [];
  let destroyed = false;
  let picked = selected.filter((id) => rounds.some((round) => round.id === id));
  const mapEl = el('div', { class: 'map map3d', role: 'img', 'aria-label': `3D view of hole ${hole} and its throws` });
  const status = el('p', { class: 'map-note' });
  const caption = el('p', { class: 'map-note' });
  setChildren(container,
    rounds.length > 1 ? filterGroup('Rounds shown', [[null, 'All rounds'], ...rounds.map((round) => [round.id, round.label])], (ids) => { picked = ids; draw(); }, picked) : null,
    mapEl, status, caption,
  );
  const shown = () => (picked.length ? rounds.filter((round) => picked.includes(round.id)) : rounds);

  // Puts the chosen rounds' arcs and markers on the map.
  const draw = () => {
    if (!map) return;
    const { arcs, markers: spots, unplaced } = holeThrows(shown(), hole, layout);
    map.getSource('arcs').setData({ type: 'FeatureCollection', features: arcs });
    markers.forEach((marker) => marker.remove());
    markers = spots.map(({ shot, number, round }) => {
      const dot = el('div', { class: throwMarkerClass(shot), title: `${rounds.length > 1 ? `${round.label}, ` : ''}throw ${number}: ${throwDetail(shot)}` }, number);
      return new library.Marker({ element: dot }).setLngLat(lngLat(shot)).addTo(map);
    });
    status.textContent = [
      spots.length || !rounds.length ? null : 'No throws on this hole have a logged spot.',
      unplaced ? `${unplaced} ${unplaced === 1 ? 'throw has' : 'throws have'} no logged spot and ${unplaced === 1 ? "isn't" : "aren't"} shown.` : null,
    ].filter(Boolean).join(' ');
  };

  const tiles = window.GLIDE_PATH_TILES;
  const points = [layout?.tee, layout?.basket, ...rounds.flatMap((round) => round.shots.filter((shot) => shot.hole === hole && hasPosition(shot)))].filter(Boolean);
  if (!tiles || !points.length) {
    mapEl.remove();
    status.textContent = points.length ? 'The 3D view needs the satellite map, which isn’t set up.' : 'Nothing on this hole has a map position yet.';
    return { destroy: () => {} };
  }

  loadMapLibre().then((loaded) => {
    library = loaded;
    if (destroyed) return;
    const bounds = points.reduce((box, point) => box.extend(lngLat(point)), new library.LngLatBounds(lngLat(points[0]), lngLat(points[0])));
    // Looking down the hole from a little to the side of the tee, so the arcs' curves show.
    const bearing = (layout?.tee && layout?.basket ? bearingBetween(layout.tee, layout.basket) : 0) + 30;
    try {
      map = new library.Map({
        container: mapEl,
        style: {
          version: 8,
          sources: {
            satellite: { type: 'raster', tiles: [tiles.url], tileSize: 256, maxzoom: 19, attribution: tiles.attribution },
            terrain: { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: TERRAIN_ATTRIBUTION },
          },
          layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
          terrain: { source: 'terrain', exaggeration: EXAGGERATION },
        },
        center: bounds.getCenter(),
        zoom: 17,
        maxPitch: 80,
        attributionControl: { compact: true },
      });
    } catch {
      mapEl.remove();
      status.textContent = 'This browser can’t show the 3D view (it needs WebGL).';
      return;
    }
    map.addControl(new library.NavigationControl({ visualizePitch: true }), 'top-right');
    map.on('load', () => {
      // The credits start folded away (an i button opens them); they'd cover a phone-sized map.
      mapEl.querySelectorAll('.maplibregl-ctrl-attrib').forEach((credits) => { credits.classList.remove('maplibregl-compact-show'); credits.removeAttribute('open'); });
      // Everything in view.
      const camera = map.cameraForBounds(bounds, { padding: { top: 50, right: 50, bottom: 90, left: 50 }, bearing, pitch: 62, maxZoom: 19 });
      if (camera) map.jumpTo({ ...camera, bearing, pitch: 62 });
      const features = [];
      if (layout?.tee && layout?.basket) features.push({ type: 'Feature', properties: { kind: 'fairway' }, geometry: { type: 'LineString', coordinates: [lngLat(layout.tee), lngLat(layout.basket)] } });
      // C1 (10 m) and C2 (20 m) around the basket.
      if (layout?.basket) features.push(circleFeature(layout.basket, 10), circleFeature(layout.basket, 20));
      map.addSource('hole', { type: 'geojson', data: { type: 'FeatureCollection', features } });
      map.addLayer({ id: 'fairway', type: 'line', source: 'hole', filter: ['==', ['get', 'kind'], 'fairway'], paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'circles', type: 'line', source: 'hole', filter: ['!=', ['get', 'kind'], 'fairway'], paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.75 } });
      map.addSource('arcs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'arcs', type: 'fill-extrusion', source: 'arcs', paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.9 } });
      for (const [point, kind, label] of [[layout?.tee, 'tee', 'Tee'], [layout?.basket, 'basket', 'Basket']]) {
        // Pins stand above their spot, so throw markers landing there don't cover them.
        if (point) new library.Marker({ element: el('div', { class: `hole3d-pin ${kind}`, title: `Hole ${hole} ${label.toLowerCase()}` }, label), anchor: 'bottom', offset: [0, -14] }).setLngLat(lngLat(point)).addTo(map);
      }
      draw();
      // Once the terrain has loaded, the tee-to-basket rise or drop, from the terrain data.
      map.once('idle', () => {
        if (!layout?.tee || !layout?.basket) return;
        const tee = map.queryTerrainElevation(lngLat(layout.tee));
        const basket = map.queryTerrainElevation(lngLat(layout.basket));
        if (tee === null || basket === null) return;
        const rise = (basket - tee) / EXAGGERATION;
        caption.textContent = `${Math.abs(rise) < 0.5 ? 'The basket is level with the tee' : `The basket is ${feetText(rise)} ${rise > 0 ? 'above' : 'below'} the tee`} (terrain data; heights drawn ${EXAGGERATION}× for readability).${rounds.length ? ' Arcs show where each throw went, not its flight.' : ''}`;
      });
    });
  });

  return {
    destroy: () => {
      destroyed = true;
      map?.remove();
    },
  };
};

// Map and 3D tabs over a round's map. The 3D view shows the hole picked in the scorecard (cells
// with data-hole under `rowsRoot`), starting with `firstHole`; `optionsFor(hole)` gives
// renderHole3d its options. `onShowMap` runs when the flat map is shown again.
export const setUpRound3d = (mapEl, { firstHole, optionsFor, rowsRoot, onShowMap }) => {
  let hole = firstHole;
  let view = null;
  const panel = el('div', { class: 'hole3d', hidden: true });
  const draw = () => {
    view?.destroy();
    view = renderHole3d(panel, optionsFor(hole));
  };
  const show3d = (on) => {
    tabs.querySelectorAll('button').forEach((button, index) => button.setAttribute('aria-pressed', String(index === (on ? 1 : 0))));
    mapEl.hidden = on;
    panel.hidden = !on;
    if (on) draw();
    else {
      view?.destroy();
      view = null;
      onShowMap?.();
    }
  };
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Map view' },
    el('button', { type: 'button', 'aria-pressed': 'true', onclick: () => show3d(false) }, 'Map'),
    el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => show3d(true) }, '3D'));
  mapEl.before(tabs);
  mapEl.after(panel);
  rowsRoot.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-hole]');
    if (!cell) return;
    hole = Number(cell.dataset.hole);
    if (!panel.hidden) draw();
  });
};
