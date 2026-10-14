import { $, drawHoles, pageData, satelliteMap } from './lib.js';
import { setUpCourseHoles } from './course-holes.js';

const data = pageData();
const mapEl = $('#map');
const map = satelliteMap(mapEl);

if (!map) {
  mapEl?.remove();
} else {
  // A hole picked in a layout's table shows on its own, with its summary and a 3D view.
  const holes = setUpCourseHoles({ map, mapEl, rowsRoot: document, draw: (layouts, only) => drawHoles(map, layouts, { only }) });
  const showLayout = (index) => {
    document.querySelectorAll('[data-layout-panel]').forEach((panel) => { panel.hidden = Number(panel.dataset.layoutPanel) !== index; });
    document.querySelectorAll('[data-layout]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.layout) === index)));
    holes.show(data.layouts[index]);
  };
  showLayout(0);
  document.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => showLayout(Number(button.dataset.layout))));
}
