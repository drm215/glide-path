import { $, api, el, fitTo, plural, satelliteMap } from './lib.js';

const statusEl = $('#status');
const resultsEl = $('#results');
const mapEl = $('#map');
let map = null;
let markers = null;

const setStatus = (text, isError = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
};

const describe = (course) => [
  [course.city, course.state].filter(Boolean).join(', ') || null,
  plural(course.holes, 'hole'),
  course.par === null ? null : `Par ${course.par}`,
  course.layoutCount > 1 ? plural(course.layoutCount, 'layout') : null,
  course.distanceMiles === null ? null : `${course.distanceMiles} mi away`,
].filter(Boolean).join(' · ');

const showResults = (courses, heading) => {
  resultsEl.replaceChildren(...courses.map((course) => el('li', {},
    el('a', { href: `/c/${encodeURIComponent(course.uid)}` },
      el('span', {}, el('span', { class: 'name' }, course.name), el('span', { class: 'sub' }, describe(course)), el('span', { class: 'sub' }, `Mapped by ${course.mappedBy}`)),
      el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')))));
  setStatus(courses.length ? heading : 'No published courses found yet.');

  const located = courses.filter((course) => course.latitude !== null && course.longitude !== null);
  mapEl.hidden = !located.length;
  if (!located.length) return;
  map ??= satelliteMap(mapEl);
  if (!map) return;
  map.invalidateSize();
  markers?.remove();
  markers = L.layerGroup(located.map((course) => L.circleMarker([course.latitude, course.longitude], { radius: 8, color: '#fff', weight: 2, fillColor: '#1d684c', fillOpacity: 1 })
    .bindPopup(el('a', { href: `/c/${encodeURIComponent(course.uid)}` }, course.name)))).addTo(map);
  fitTo(map, located.map((course) => [course.latitude, course.longitude]), 15);
};

const search = async (params, heading) => {
  setStatus('Searching… The server can take up to a minute to wake if it hasn’t been used recently.');
  try {
    const { courses } = await api(`/api/public/courses?${new URLSearchParams(params)}`);
    showResults(courses, heading(courses));
  } catch (error) {
    setStatus(error.message, true);
  }
};

$('#search').addEventListener('submit', (event) => {
  event.preventDefault();
  const q = $('#query').value.trim();
  search(q ? { q } : {}, (courses) => (q ? `${plural(courses.length, 'course')} matching “${q}”` : `${plural(courses.length, 'published course')}`));
});

$('#near-me').addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus('Your browser can’t share its location.', true);
    return;
  }
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => search({ near: `${coords.latitude.toFixed(4)},${coords.longitude.toFixed(4)}` }, () => 'Closest courses to you'),
    () => setStatus('Location access was denied. Search by name instead.', true),
    { enableHighAccuracy: false, timeout: 15_000, maximumAge: 300_000 },
  );
});

search({}, (courses) => plural(courses.length, 'published course'));
