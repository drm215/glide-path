import { $, drawHoles, fitTo, pageData, satelliteMap } from './lib.js';

const data = pageData();
const map = satelliteMap($('#map'));
let current = { index: 0, drawn: null };

const showLayout = (index) => {
  current.drawn?.group.remove();
  current = { index, drawn: map ? drawHoles(map, data.layouts[index]) : null };
  document.querySelectorAll('[data-layout-panel]').forEach((panel) => { panel.hidden = Number(panel.dataset.layoutPanel) !== index; });
  document.querySelectorAll('[data-layout]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.layout) === index)));
  document.querySelectorAll('tr.active').forEach((row) => row.classList.remove('active'));
  if (map && !fitTo(map, current.drawn.bounds)) {
    $('#map').replaceWith(Object.assign(document.createElement('p'), { className: 'meta', textContent: 'No holes on this layout have been mapped yet.' }));
  }
};

const focusHole = (row) => {
  const layout = data.layouts[current.index][Number(row.dataset.hole) - 1];
  const points = [layout?.tee, layout?.basket].filter(Boolean).map((point) => [point.latitude, point.longitude]);
  if (!map || !points.length) return;
  document.querySelectorAll('tr.active').forEach((active) => active.classList.remove('active'));
  row.classList.add('active');
  fitTo(map, points, 19);
  $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

if (!map) {
  $('#map')?.remove();
} else {
  showLayout(0);
  document.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => showLayout(Number(button.dataset.layout))));
  document.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-hole]');
    if (row) focusHole(row);
  });
}
