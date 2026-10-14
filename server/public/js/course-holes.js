// A course layout's holes on its map: all of them, or one picked from its table (rows or cells
// with data-hole): then just that hole, a summary of its par, length and elevation change, and a
// Map | 3D switch for it, with All holes to go back. Used by the public course page and a course
// in My rounds.
import { el, feetBetween, fitTo } from './lib.js';
import { renderHole3d, TERRAIN_TILES } from './hole3d.js';

// Tee to basket in feet, from the saved tee and basket; null if either is missing.
export const holeLength = (layout) => (layout?.tee && layout?.basket ? Math.round(feetBetween(layout.tee, layout.basket)) : null);

// Basket minus tee in feet, from their saved elevations; null if either has none.
export const holeRise = (layout) => (typeof layout?.tee?.altitude === 'number' && typeof layout?.basket?.altitude === 'number'
  ? Math.round((layout.basket.altitude - layout.tee.altitude) / 0.3048)
  : null);

export const riseText = (rise) => (rise === null ? '—' : rise > 0 ? `↑ ${rise} ft` : rise < 0 ? `↓ ${-rise} ft` : 'Flat');

// Ground elevation from the public terrain tiles the 3D view uses (Terrarium-encoded: metres are
// red × 256 + green + blue / 256 − 32768), at zoom 15, about 5 m per pixel. Phone GPS heights are
// rough, and older holes have none, so this is preferred where it loads.
const TERRAIN_ZOOM = 15;
const tiles = new Map();
const tilePixels = (x, y) => {
  const key = `${x}/${y}`;
  if (!tiles.has(key)) {
    const url = TERRAIN_TILES.replace('{z}', TERRAIN_ZOOM).replace('{x}', x).replace('{y}', y);
    tiles.set(key, fetch(url).then((response) => response.blob()).then((blob) => createImageBitmap(blob)).then((bitmap) => {
      const canvas = el('canvas', { width: 256, height: 256 });
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, 256, 256).data;
    }));
  }
  return tiles.get(key);
};
const elevationAt = async ({ latitude, longitude }) => {
  const scale = 2 ** TERRAIN_ZOOM;
  const x = ((longitude + 180) / 360) * scale;
  const latitudeRad = (latitude * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latitudeRad) + 1 / Math.cos(latitudeRad)) / Math.PI) / 2) * scale;
  const pixels = await tilePixels(Math.floor(x), Math.floor(y));
  const offset = (Math.floor((y % 1) * 256) * 256 + Math.floor((x % 1) * 256)) * 4;
  return pixels[offset] * 256 + pixels[offset + 1] + pixels[offset + 2] / 256 - 32768;
};
// Basket minus tee in feet from the terrain, else from saved elevations; null if neither is known.
export const terrainRise = async (layout) => {
  if (!layout?.tee || !layout?.basket) return null;
  try {
    const [tee, basket] = await Promise.all([elevationAt(layout.tee), elevationAt(layout.basket)]);
    return Math.round((basket - tee) / 0.3048);
  } catch {
    return holeRise(layout);
  }
};

// "Hole 03 · Par 3 · 245 ft · ↓ 12 ft", leaving out what isn't known. `rise` defaults to the saved elevations.
export const holeSummary = (hole, layout, rise = holeRise(layout)) => [
  `Hole ${String(hole).padStart(2, '0')}`,
  layout?.par ? `Par ${layout.par}` : null,
  holeLength(layout) === null ? null : `${holeLength(layout)} ft`,
  rise === null || rise === undefined ? null : riseText(rise),
].filter(Boolean).join(' · ');

// `draw(holes, only)` draws a layout's holes on `map` (only = the picked hole, or undefined for
// all) and returns { group, bounds }. Table cells with data-rise-hole get each hole's elevation
// change from the terrain. Returns { show(holes), pick(hole), redraw() }.
export const setUpCourseHoles = ({ map, mapEl, rowsRoot, draw }) => {
  let holes = [];
  // Each hole's elevation change from the terrain, once worked out (by hole layout).
  const rises = new Map();
  const loadRises = (layoutHoles) => layoutHoles.forEach((layout, index) => {
    if (!layout?.tee || !layout?.basket || rises.has(layout)) return;
    rises.set(layout, null);
    terrainRise(layout).then((rise) => {
      rises.set(layout, rise);
      if (holes !== layoutHoles) return;
      rowsRoot.querySelectorAll(`[data-rise-hole="${index + 1}"]`).forEach((cell) => { cell.textContent = riseText(rise); });
      if (picked === index + 1) text.textContent = holeSummary(picked, layout, rise);
    });
  });
  let picked = null;
  let mode = 'map';
  let drawn = null;
  let view = null;
  const text = el('p', { class: 'hole-summary-text' });
  const mapButton = el('button', { type: 'button', 'aria-pressed': 'true', onclick: () => setMode('map') }, 'Map');
  const button3d = el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => setMode('3d') }, '3D');
  const summary = el('div', { class: 'hole-summary', hidden: true },
    text,
    el('div', { class: 'tabs', role: 'group', 'aria-label': 'Hole view' }, mapButton, button3d),
    el('button', { type: 'button', class: 'button secondary', onclick: () => pick(null) }, 'All holes'));
  const panel = el('div', { class: 'hole3d', hidden: true });
  mapEl.before(summary);
  mapEl.after(panel);

  const redraw = (refit) => {
    drawn?.group.remove();
    drawn = draw(holes, picked ?? undefined);
    rowsRoot.querySelectorAll('[data-hole]').forEach((row) => row.classList.toggle('active', Number(row.dataset.hole) === picked));
    if (refit && !fitTo(map, drawn.bounds, 19)) map.setView([39.8, -98.6], 3);
  };
  // 3D needs a hole; all holes is always the flat map.
  const setMode = (next) => {
    mode = picked === null ? 'map' : next;
    mapButton.setAttribute('aria-pressed', String(mode === 'map'));
    button3d.setAttribute('aria-pressed', String(mode === '3d'));
    view?.destroy();
    view = null;
    mapEl.hidden = mode === '3d';
    panel.hidden = mode !== '3d';
    if (mode === '3d') view = renderHole3d(panel, { hole: picked, layout: holes[picked - 1] ?? null, rounds: [] });
    else map.invalidateSize();
  };
  const pick = (hole, { scroll = true } = {}) => {
    picked = hole;
    summary.hidden = hole === null;
    if (hole !== null) text.textContent = holeSummary(hole, holes[hole - 1], rises.get(holes[hole - 1]) ?? holeRise(holes[hole - 1]));
    redraw(true);
    setMode(mode);
    if (hole !== null && scroll) summary.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  rowsRoot.addEventListener('click', (event) => {
    const row = event.target.closest('[data-hole]');
    if (row) pick(Number(row.dataset.hole));
  });
  return {
    show: (layoutHoles) => {
      holes = layoutHoles;
      pick(null);
      loadRises(layoutHoles);
    },
    pick: (hole) => pick(hole, { scroll: false }),
    redraw: () => redraw(false),
  };
};
