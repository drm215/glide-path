// The website's course editor, for a course's owners and site admins: its details, layouts,
// holes and pars, its tees and baskets (dragged, or placed by clicking the map), moving a layout
// in from another course, its owners, and deleting it. Each change saves at once (PUT /api/courses/:uid); a phone's newer save is merged
// in on the server rather than overwritten, and phones pick the change up on their next sync.
import { api, drawHoles, el, plural, satelliteMap, setChildren } from './lib.js';
import { holeLength, holeRise, riseText, setUpCourseHoles } from './course-holes.js';
import { placedPoint } from './round-stats.js';

const MAIN_LAYOUT_ID = 'main';
const PARS = [2, 3, 4, 5, 6];
const DETAIL_FIELDS = [['street', 'Street'], ['city', 'City'], ['state', 'State'], ['phone', 'Phone'], ['email', 'Email'], ['website', 'Website']];

// The course's layouts: its main one (index 0), then the rest.
const layoutsOf = (course) => [
  { id: MAIN_LAYOUT_ID, name: course.layoutName || 'Main', layouts: course.layouts },
  ...course.extraLayouts,
];

// `course` with layout `index`'s holes replaced.
const withHoles = (course, index, holes) => (index === 0
  ? { ...course, holes: holes.length, layouts: holes }
  : { ...course, extraLayouts: course.extraLayouts.map((layout, extra) => (extra === index - 1 ? { ...layout, holes: holes.length, layouts: holes } : layout)) });

// The parts of a course an edit sends.
const editOf = ({ name, holes, layouts, layoutName, extraLayouts, details }) => ({ name, holes, layouts, layoutName, extraLayouts, details });

// Renders the editor for course `uid` into `root`. `token` signs requests; `back` is the link
// above it; `onDeleted` runs after the course is deleted. `state` keeps the layout, picked hole
// and drag mode across saves.
export const renderCourseEditor = async (root, { uid, token, back, onDeleted, state = {} }) => {
  setChildren(root, back, el('p', { class: 'status' }, 'Loading the course…'));
  let loaded;
  try {
    loaded = await api(`/api/courses/${encodeURIComponent(uid)}`, { token });
  } catch (error) {
    setChildren(root, back, el('p', { class: 'status error' }, error.message));
    return;
  }
  showEditor(root, { ...loaded, uid, token, back, onDeleted, state });
};

const showEditor = (root, { course, canEdit, isAdmin, role, uid, token, back, onDeleted, state }) => {
  const layouts = layoutsOf(course);
  const layoutIndex = Math.min(state.layoutIndex ?? 0, layouts.length - 1);
  const layout = layouts[layoutIndex];
  const status = el('p', { class: 'status', 'aria-live': 'polite' }, state.message ?? '');
  let picked = state.hole ?? null;
  let dragging = Boolean(state.dragging);

  // Saves an edit: `change` gets the course and returns it changed. Then shows the saved course.
  // Progress shows next to the map tools, or in `near` (another status line) when given.
  const save = async (change, message = 'Saved.', near = status) => {
    near.textContent = 'Saving…';
    try {
      const result = await api(`/api/courses/${encodeURIComponent(uid)}`, { method: 'PUT', token, body: { course: editOf(change(course)), baseUpdatedAt: course.updatedAt } });
      const top = window.scrollY;
      showEditor(root, { ...result, uid, token, back, onDeleted, state: { layoutIndex: currentLayout, hole: picked, dragging, message } });
      window.scrollTo(0, top);
    } catch (error) {
      near.textContent = `Couldn’t save: ${error.message}`;
    }
  };
  let currentLayout = layoutIndex;
  const detailsStatus = el('p', { class: 'status', 'aria-live': 'polite' });
  const layoutStatus = el('p', { class: 'status', 'aria-live': 'polite' });
  const setHoles = (holes, message) => save((current) => withHoles(current, currentLayout, holes), message);

  // ---- details
  const nameInput = el('input', { value: course.name, 'aria-label': 'Course name', required: true });
  const detailInputs = DETAIL_FIELDS.map(([key, label]) => [key, el('input', { value: course.details?.[key] ?? '', 'aria-label': label })]);
  const notesInput = el('textarea', { rows: 4, 'aria-label': 'Info to know' }, course.details?.notes ?? '');
  const details = el('form', { class: 'editor-form', onsubmit: (event) => {
    event.preventDefault();
    if (!nameInput.value.trim()) return;
    save((current) => ({
      ...current,
      name: nameInput.value.trim(),
      details: { ...current.details, ...Object.fromEntries(detailInputs.map(([key, input]) => [key, input.value.trim() || undefined])), notes: notesInput.value.trim() || undefined },
    }), 'Details saved.', detailsStatus);
  } },
  el('label', {}, 'Name', nameInput),
  el('div', { class: 'editor-grid' }, detailInputs.map(([key, input]) => el('label', {}, DETAIL_FIELDS.find(([field]) => field === key)[1], input))),
  el('label', {}, 'Info to know', notesInput),
  el('button', { class: 'button', type: 'submit' }, 'Save details'),
  detailsStatus);

  // ---- layouts
  const layoutTabs = layouts.length > 1
    ? el('div', { class: 'tabs', role: 'group', 'aria-label': 'Layouts' }, layouts.map((item, index) => el('button', {
      type: 'button', 'aria-pressed': String(index === layoutIndex),
      onclick: () => showEditor(root, { course, canEdit, isAdmin, role, uid, token, back, onDeleted, state: { layoutIndex: index } }),
    }, item.name)))
    : null;
  const renameInput = el('input', { value: layout.name, 'aria-label': 'Layout name' });
  const newLayoutName = el('input', { placeholder: 'e.g. Long tees', 'aria-label': 'New layout name' });
  const newLayoutHoles = el('input', { type: 'number', min: 1, max: 100, value: layout.layouts.length, 'aria-label': 'Holes in the new layout' });
  const layoutTools = el('div', { class: 'editor-layouts' },
    el('form', { class: 'search', onsubmit: (event) => {
      event.preventDefault();
      const name = renameInput.value.trim();
      if (!name) return;
      save((current) => (currentLayout === 0
        ? { ...current, layoutName: name }
        : { ...current, extraLayouts: current.extraLayouts.map((item, index) => (index === currentLayout - 1 ? { ...item, name } : item)) }), 'Layout renamed.', layoutStatus);
    } }, renameInput, el('button', { class: 'button secondary', type: 'submit' }, 'Rename layout')),
    layoutIndex > 0 ? el('button', { class: 'button danger', type: 'button', onclick: () => {
      if (!confirm(`Delete the ${layout.name} layout? Rounds played on it keep their scores but lose its map.`)) return;
      currentLayout = 0;
      save((current) => ({ ...current, extraLayouts: current.extraLayouts.filter((_, index) => index !== layoutIndex - 1) }), 'Layout deleted.', layoutStatus);
    } }, 'Delete layout') : null,
    el('form', { class: 'search', onsubmit: (event) => {
      event.preventDefault();
      const name = newLayoutName.value.trim();
      const holes = Math.min(100, Math.max(1, Math.round(Number(newLayoutHoles.value) || 1)));
      if (!name) return;
      currentLayout = layouts.length;
      save((current) => ({ ...current, extraLayouts: [...current.extraLayouts, { id: `layout-${Date.now()}`, name, holes, layouts: Array.from({ length: holes }, () => ({ tee: null, basket: null })) }] }), 'Layout added.', layoutStatus);
    } }, newLayoutName, newLayoutHoles, el('button', { class: 'button secondary', type: 'submit' }, 'Add layout')),
    layoutStatus);

  // ---- holes
  const holeRows = layout.layouts.map((hole, index) => {
    const par = el('select', { 'aria-label': `Par for hole ${index + 1}`, onchange: (event) => {
      const value = Number(event.target.value);
      setHoles(layout.layouts.map((item, position) => (position === index ? { ...item, par: value || undefined } : item)), `Hole ${index + 1} is par ${value || 'unset'}.`);
    } }, el('option', { value: '' }, '—'), PARS.map((value) => el('option', { value, selected: hole.par === value }, value)));
    return el('tr', { 'data-hole': index + 1 },
      el('td', {}, String(index + 1).padStart(2, '0')),
      el('td', { class: 'editor-par' }, par),
      el('td', {}, holeLength(hole) === null ? '—' : `${holeLength(hole)} ft`),
      el('td', { 'data-rise-hole': index + 1 }, riseText(holeRise(hole))),
      el('td', {}, layout.layouts.length > 1 ? el('button', { class: 'button danger small', type: 'button', 'aria-label': `Remove hole ${index + 1}`, onclick: (event) => {
        event.stopPropagation();
        if (!confirm(`Remove hole ${index + 1}? Later holes move up a number.`)) return;
        picked = null;
        setHoles(layout.layouts.filter((_, position) => position !== index), `Hole ${index + 1} removed.`);
      } }, 'Remove') : null));
  });
  const holeTable = el('table', { class: 'editor-holes' },
    el('thead', {}, el('tr', {}, ['HOLE', 'PAR', 'LENGTH', 'ELEVATION', ''].map((heading) => el('th', {}, heading)))),
    el('tbody', {}, holeRows));
  const addHole = el('button', { class: 'button secondary', type: 'button', onclick: () => setHoles([...layout.layouts, { tee: null, basket: null }], `Hole ${layout.layouts.length + 1} added.`) }, '+ Add hole');

  // ---- map: drag tees and baskets, or pick a hole and click to place them
  const mapEl = el('div', { class: 'map tall', role: 'img', 'aria-label': 'Satellite map of the course' });
  const dragButton = el('button', { class: 'button secondary', type: 'button', 'aria-pressed': String(dragging), onclick: () => {
    dragging = !dragging;
    dragButton.setAttribute('aria-pressed', String(dragging));
    holes?.redraw();
  } }, 'Drag tees and baskets');
  const placeButtons = ['tee', 'basket'].map((kind) => el('button', { class: 'button secondary', type: 'button', onclick: () => startPlacing(kind) }, `Place ${kind}`));
  const placeTools = el('div', { class: 'links', hidden: picked === null }, placeButtons);
  // Removed (keeping the status line) when the map can't load.
  const mapTools = el('div', {}, el('div', { class: 'links' }, dragButton), placeTools,
    el('p', { class: 'map-note' }, 'Pick a hole in the table to see it on its own and place its tee or basket by clicking the map, or drag them to fix a poor GPS save. Changes save at once, for everyone who plays this course; throws that went in on a hole move with its basket.'));
  const movePoint = (hole, kind, latitude, longitude) => setHoles(
    layout.layouts.map((item, index) => (index === hole - 1 ? { ...item, [kind]: placedPoint(latitude, longitude, Date.now()) } : item)),
    `Hole ${hole}’s ${kind} moved.`,
  );
  let placing = null;
  const startPlacing = (kind) => {
    if (picked === null || !map) return;
    placing = kind;
    status.textContent = `Click the map where hole ${picked}’s ${kind} is.`;
    mapEl.classList.add('placing');
  };

  const deleteButton = el('button', { class: 'button danger', type: 'button', onclick: async () => {
    if (!confirm(`Delete ${course.name} for everyone? Everyone who plays it loses it; their rounds keep their scores.`)) return;
    try {
      await api(`/api/courses/${encodeURIComponent(uid)}`, { method: 'DELETE', token });
      onDeleted?.();
    } catch (error) {
      status.textContent = error.message;
    }
  } }, 'Delete course');

  const place = [course.details?.city, course.details?.state].filter(Boolean).join(', ');
  setChildren(root,
    back,
    el('div', { class: 'eyebrow' }, [`Created by ${course.createdBy}`, place].filter(Boolean).join(' · ')),
    el('h1', {}, course.name),
    el('p', { class: 'meta' }, [isAdmin && role !== 'owner' ? 'You’re a site admin' : 'You own this course', el('a', { href: `/c/${encodeURIComponent(uid)}` }, 'View its public page')].flatMap((item, index) => (index ? [' · ', item] : [item]))),
    canEdit ? null : el('p', { class: 'status error' }, 'Only its owners and site admins can edit this course.'),
    el('h2', {}, 'Holes'),
    layoutTabs,
    mapEl,
    el('div', { class: 'map-edit' }, mapTools, status),
    holeTable,
    addHole,
    el('h2', {}, 'Layouts'),
    layoutTools,
    moveLayoutSection(uid, token, layouts, (result) => {
      const moved = layoutsOf(result.course).findIndex((item) => item.id === result.layoutId);
      showEditor(root, { ...result, uid, token, back, onDeleted, state: { layoutIndex: Math.max(0, moved), message: `Layout moved here${result.movedRounds ? `, with ${plural(result.movedRounds, 'round')} played on it` : ''}.` } });
      window.scrollTo(0, 0);
    }),
    el('h2', {}, 'Details'),
    details,
    ownersSection(uid, token),
    el('h2', {}, 'Delete'),
    el('p', { class: 'meta' }, 'Deleting it removes it for everyone who plays it.'),
    deleteButton,
  );

  const map = satelliteMap(mapEl);
  const holes = map ? setUpCourseHoles({
    map, mapEl, rowsRoot: holeTable,
    draw: (holeLayouts, only) => {
      picked = only ?? null;
      placeTools.hidden = picked === null;
      return drawHoles(map, holeLayouts, { only, onMove: dragging ? movePoint : undefined });
    },
  }) : null;
  map?.on('click', (event) => {
    if (!placing || picked === null) return;
    const kind = placing;
    placing = null;
    mapEl.classList.remove('placing');
    movePoint(picked, kind, event.latlng.lat, event.latlng.lng);
  });
  if (!map) {
    mapEl.remove();
    mapTools.remove();
  }
  // Showing the layout clears the picked hole, so the one kept across a save is put back after.
  const keptHole = picked;
  holes?.show(layout.layouts);
  if (keptHole !== null) holes?.pick(keptHole);
};

// A course's owners: add one by email, or remove one (its creator always stays).
const ownersSection = (uid, token) => {
  const list = el('ul', { class: 'results members' });
  const status = el('p', { class: 'status', 'aria-live': 'polite' });
  const emailInput = el('input', { type: 'email', placeholder: 'their@email.com', autocomplete: 'off', 'aria-label': 'Email of a new owner' });
  const path = `/api/courses/${encodeURIComponent(uid)}/owners`;
  const show = (owners) => setChildren(list, owners.map((owner) => el('li', {},
    el('span', { class: 'row' },
      el('span', {}, el('span', { class: 'name' }, owner.displayName), el('span', { class: 'sub' }, [owner.creator ? 'Created it' : 'Owner', owner.email].join(' · '))),
      owner.creator ? null : el('button', { class: 'button danger', type: 'button', onclick: () => remove(owner) }, 'Remove')))));
  const remove = async (owner) => {
    status.textContent = '';
    try {
      await api(`${path}/${encodeURIComponent(owner.userId)}`, { method: 'DELETE', token });
      show((await api(path, { token })).owners);
    } catch (error) {
      status.textContent = error.message;
    }
  };
  const add = async (event) => {
    event.preventDefault();
    if (!emailInput.value.trim()) return;
    status.textContent = 'Adding…';
    try {
      show((await api(path, { method: 'POST', token, body: { email: emailInput.value.trim() } })).owners);
      emailInput.value = '';
      status.textContent = '';
    } catch (error) {
      status.textContent = error.message;
    }
  };
  api(path, { token }).then((result) => show(result.owners), () => { status.textContent = 'Couldn’t load this course’s owners.'; });
  return el('section', { class: 'sharing' },
    el('h2', {}, 'Owners'),
    el('p', { class: 'meta' }, 'Owners can edit this course, add and remove owners, and delete it. Add them by the email they use for Glide Path.'),
    list,
    el('form', { class: 'search', onsubmit: add }, emailInput, el('button', { class: 'button', type: 'submit' }, 'Add owner')),
    status);
};

const mappedCount = (holes) => holes.filter((hole) => hole.tee && hole.basket).length;

// Moving a layout here from another course (one this account can also edit), e.g. when the same
// place was mapped twice: as a new layout, or in place of one of this course's. Its holes and the
// rounds played on it come across, and it leaves the other course (a main layout is copied, since
// a course can't be without one). See moveLayout in server/src/courses.ts.
const moveLayoutSection = (uid, token, targetLayouts, onMoved) => {
  const status = el('p', { class: 'status', 'aria-live': 'polite' });
  const results = el('ul', { class: 'results' });
  const picker = el('div', {});
  const searchInput = el('input', { type: 'search', placeholder: 'Course name or place', 'aria-label': 'Course to move a layout from' });

  const pick = async (sourceUid) => {
    status.textContent = 'Loading its layouts…';
    setChildren(picker);
    try {
      const { course: source, canEdit } = await api(`/api/courses/${encodeURIComponent(sourceUid)}`, { token });
      if (!canEdit) { status.textContent = `You can only move a layout from a course you own. Ask an owner of ${source.name} to add you.`; return; }
      status.textContent = '';
      const sourceLayouts = layoutsOf(source);
      const layoutSelect = el('select', { 'aria-label': 'Layout to move' }, sourceLayouts.map((item) => el('option', { value: item.id },
        `${item.name} · ${plural(item.layouts.length, 'hole')}, ${mappedCount(item.layouts)} mapped`)));
      const intoSelect = el('select', { 'aria-label': 'Where it goes' },
        el('option', { value: '' }, 'As a new layout'),
        targetLayouts.map((item) => el('option', { value: item.id }, `In place of ${item.name}`)));
      const move = async () => {
        const layoutId = layoutSelect.value;
        const moving = sourceLayouts.find((item) => item.id === layoutId);
        const replacing = targetLayouts.find((item) => item.id === intoSelect.value);
        const from = layoutId === MAIN_LAYOUT_ID ? `It’s ${source.name}’s main layout, so it stays there too.` : `It leaves ${source.name}.`;
        if (!confirm(`Move ${moving.name} here${replacing ? `, replacing ${replacing.name}’s holes` : ''}? Rounds played on it come with it. ${from}`)) return;
        status.textContent = 'Moving…';
        try {
          onMoved(await api(`/api/courses/${encodeURIComponent(uid)}/layouts/move`, {
            method: 'POST', token, body: { sourceUid, layoutId, ...(replacing ? { replaceLayoutId: replacing.id } : {}) },
          }));
        } catch (error) {
          status.textContent = `Couldn’t move it: ${error.message}`;
        }
      };
      setChildren(picker,
        el('h3', {}, `From ${source.name}`),
        el('div', { class: 'editor-form' },
          el('label', {}, 'Layout', layoutSelect),
          el('label', {}, 'Put it here', intoSelect),
          el('button', { class: 'button', type: 'button', onclick: move }, 'Move layout')));
    } catch (error) {
      status.textContent = error.message;
    }
  };

  const search = async (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    status.textContent = 'Searching…';
    setChildren(picker);
    try {
      const { courses } = await api(`/api/public/courses?q=${encodeURIComponent(query)}`);
      const others = courses.filter((item) => item.uid !== uid);
      status.textContent = others.length ? '' : 'No other courses match.';
      setChildren(results, others.map((item) => el('li', {}, el('button', { class: 'row', type: 'button', onclick: () => { setChildren(results); pick(item.uid); } },
        el('span', {},
          el('span', { class: 'name' }, item.name),
          el('span', { class: 'sub' }, [[item.city, item.state].filter(Boolean).join(', ') || null, `mapped by ${item.mappedBy}`, item.layoutCount > 1 ? plural(item.layoutCount, 'layout') : plural(item.holes, 'hole')].filter(Boolean).join(' · '))),
        el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')))));
    } catch (error) {
      status.textContent = error.message;
    }
  };

  return el('section', {},
    el('h2', {}, 'Move a layout here'),
    el('p', { class: 'meta' }, 'For a layout mapped on another copy of this course. Its holes, tees, baskets and pars come here, with the rounds played on it. You need to own both courses.'),
    el('form', { class: 'search', onsubmit: search }, searchInput, el('button', { class: 'button secondary', type: 'submit' }, 'Find course')),
    results,
    picker,
    status);
};
