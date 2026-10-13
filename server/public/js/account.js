import { setUpRound3d } from './hole3d.js';
import { holeAveragesHtml, scorecardHtml, scorecardLegendHtml, scoreStripHtml } from './scorecard.js';
import { filterGroup, renderHistorySummary, renderHoleSummary, renderRoundSummary } from './summary.js';
import { discStats, discThrows, moveThrow, placedPoint, quality, roundLayouts } from './round-stats.js';
import { $, THROW_TYPE_COLORS, TOKEN_KEY, api, drawEveryThrow, fromHtml, setChildren, throwLegend, drawHoles, el, feetBetween, fitTo, formatDate, formatToPar, holesPlayed, plural, satelliteMap, setUpRoundMap, strokes, throwDetail, toParClass } from './lib.js';

const signedOutEl = $('#signed-out');
const signedInEl = $('#signed-in');
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable: stay signed out */ }
let user = null;
let data = null;
// The newest server version downloaded, so a save only brings back what changed since.
let syncCursor = 0;

const saveToken = (value) => {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable: token lasts for this page only */ }
};

// ---------------------------------------------------------------- data helpers

const MAIN_LAYOUT_ID = 'main';
const layoutsOf = (course) => [
  { id: MAIN_LAYOUT_ID, name: course.layoutName || 'Main', holes: course.holes, layouts: course.layouts },
  ...(course.extraLayouts ?? []),
];
const courseFor = (round) => data.courses.find((course) => course.clientId === round.courseClientId);
const layoutFor = (round) => {
  const course = courseFor(round);
  return course ? layoutsOf(course).find((layout) => layout.id === (round.layoutId ?? MAIN_LAYOUT_ID)) : undefined;
};
// A round's hole layouts with the pars it was played with (saved with it), not the course's current ones.
const roundHoles = (round) => roundLayouts(layoutFor(round)?.layouts ?? [], round.pars);

// Round ids are the time the round ended.
const roundDate = (round) => (Number.isFinite(Number(round.clientId)) ? Number(round.clientId) : round.updatedAt);

const roundScore = (round) => {
  const pars = roundHoles(round);
  const holes = holesPlayed(round.shots).map((item) => ({ ...item, score: strokes(item.shots), par: pars[item.hole - 1]?.par }));
  const withPar = holes.filter((item) => item.par !== undefined);
  return {
    holes,
    total: strokes(round.shots),
    par: withPar.reduce((sum, item) => sum + item.par, 0),
    toPar: withPar.length ? withPar.reduce((sum, item) => sum + item.score - item.par, 0) : null,
  };
};

// Every throw on one hole of a course layout: #hole/<course>/<layout>/<hole>, ending /practice to
// include practice sessions.
const holeHref = (courseId, layoutId, hole, includePractice) =>
  `#hole/${[courseId, layoutId, String(hole)].map(encodeURIComponent).join('/')}${includePractice ? '/practice' : ''}`;

// ---------------------------------------------------------------- views

const back = () => el('p', {}, el('a', { href: '#' }, '‹ All rounds and courses'));

const renderOverview = () => {
  const rounds = [...data.rounds].sort((a, b) => roundDate(b) - roundDate(a));
  const courses = [...data.courses].sort((a, b) => a.name.localeCompare(b.name));
  setChildren(signedInEl,
    el('div', { class: 'eyebrow' }, 'Signed in as'),
    el('h1', {}, user.displayName),
    el('p', { class: 'meta' }, user.email),
    el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('div', { class: 'label' }, 'ROUNDS'), el('div', { class: 'value' }, rounds.length)),
      el('div', { class: 'stat' }, el('div', { class: 'label' }, 'COURSES'), el('div', { class: 'value' }, courses.length)),
      el('div', { class: 'stat' }, el('div', { class: 'label' }, 'DISCS IN BAG'), el('div', { class: 'value' }, data.bag?.discs.length ?? 0))),
    rounds.length ? el('p', { class: 'links' }, el('a', { class: 'button secondary', href: '#stats' }, 'All-time stats ›'), el('a', { class: 'button secondary', href: '#discs' }, 'Disc stats ›')) : null,
    el('h2', {}, 'Rounds'),
    rounds.length
      ? el('ul', { class: 'results' }, rounds.map((round) => {
        const score = roundScore(round);
        const layout = layoutFor(round);
        const hasLayouts = courseFor(round) && layoutsOf(courseFor(round)).length > 1;
        return el('li', {}, el('a', { href: `#round/${encodeURIComponent(round.clientId)}` },
          el('span', {},
            el('span', { class: 'name' }, round.courseName),
            el('span', { class: 'sub' }, [formatDate(roundDate(round)), hasLayouts && layout ? `${layout.name} layout` : null, plural(score.holes.length, 'hole'), round.mode === 'Practice' ? 'Practice' : null, round.inProgress ? 'In progress' : null].filter(Boolean).join(' · '))),
          el('span', { class: 'name' }, `${score.total}`, score.toPar === null ? null : el('span', { class: toParClass(score.toPar) }, ` ${formatToPar(score.toPar)}`))));
      }))
      : el('p', { class: 'meta' }, 'No rounds yet. Rounds appear here after you end them in the app and it syncs.'),
    el('h2', {}, 'Courses'),
    courses.length
      ? el('ul', { class: 'results' }, courses.map((course) => el('li', {}, el('a', { href: `#course/${encodeURIComponent(course.clientId)}` },
        el('span', {},
          el('span', { class: 'name' }, course.name),
          el('span', { class: 'sub' }, [
            layoutsOf(course).length > 1 ? plural(layoutsOf(course).length, 'layout') : plural(course.holes, 'hole'),
            course.published ? 'Published' : 'Private',
          ].join(' · '))),
        el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')))))
      : el('p', { class: 'meta' }, 'No synced courses yet.'),
    el('div', { class: 'links' },
      el('button', { class: 'button secondary', type: 'button', onclick: signOut }, 'Sign out'),
      el('button', { class: 'button danger', type: 'button', onclick: deleteAccount }, 'Delete account')),
  );
};

// `hole` and `editing` keep the map where it was after a throw is moved.
const renderRound = (round, { hole, editing = false } = {}) => {
  const score = roundScore(round);
  const layout = layoutFor(round);
  const course = courseFor(round);
  // A round with no throws has no scorecard; the map still needs somewhere to listen for hole picks.
  const holes = roundHoles(round);
  const scorecard = fromHtml(scorecardHtml(round.shots, holes)) ?? el('div', {});
  const mapEl = el('div', { class: 'map', role: 'img', 'aria-label': 'Satellite map of the selected hole and its throws' });
  // Throws can be dragged to where they really landed, unless the round is still being played
  // (the phone playing it owns it until it ends).
  const moveStatus = el('p', { class: 'status', 'aria-live': 'polite' });
  const moveNote = el('p', { class: 'map-note', hidden: !editing }, 'Drag a throw to where it really landed. Its distance and the next throw’s are re-measured and saved to your account.');
  const moveButton = round.inProgress ? null : el('button', { class: 'button secondary', type: 'button', 'aria-pressed': String(editing), onclick: () => setMoving(moveButton.getAttribute('aria-pressed') !== 'true') }, 'Move throws');
  const setMoving = (on) => {
    moveButton.setAttribute('aria-pressed', String(on));
    moveNote.hidden = !on;
    shown?.setEditing(on);
  };
  const onMoveThrow = async (movedHole, index, latitude, longitude) => {
    const positions = round.shots.flatMap((shot, position) => (shot.hole === movedHole ? [position] : []));
    moveStatus.textContent = 'Saving…';
    try {
      const saved = await saveRecord('rounds', { ...round, shots: moveThrow(round.shots, positions[index], latitude, longitude, layout?.layouts?.[movedHole - 1]?.tee) }, () => { moveStatus.textContent = 'Waiting for the server to wake up…'; });
      keepScroll(() => renderRound(saved, { hole: movedHole, editing: true }));
    } catch (error) {
      moveStatus.textContent = `Couldn’t save the move: ${error.message}`;
      shown?.setEditing(true);
    }
  };
  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, [formatDate(roundDate(round)), round.mode === 'Practice' ? 'Practice' : null, round.inProgress ? 'In progress' : null].filter(Boolean).join(' · ')),
    el('h1', {}, round.courseName),
    el('p', { class: 'meta' }, [course && layoutsOf(course).length > 1 && layout ? `${layout.name} layout` : null, plural(score.holes.length, 'hole')].filter(Boolean).join(' · ')),
    fromHtml(scoreStripHtml(round.shots, holes)),
    round.shared && round.shareToken ? el('p', {}, el('a', { href: `/r/${encodeURIComponent(round.shareToken)}` }, 'Public share link')) : null,
    scorecard,
    fromHtml(scorecardLegendHtml()),
    mapEl,
    el('p', { class: 'map-note' }, 'Tap a hole in the scorecard above to see where each throw landed.'),
    throwLegend(),
    moveButton ? el('div', { class: 'map-edit' }, moveButton, moveNote, moveStatus) : null,
    renderRoundSummary(round.shots, holes),
    el('h2', {}, 'Throw by throw'),
    score.holes.map((item) => [
      el('h3', {}, `Hole ${String(item.hole).padStart(2, '0')}`),
      course ? el('p', { class: 'meta' }, el('a', { href: holeHref(course.clientId, round.layoutId ?? MAIN_LAYOUT_ID, item.hole, round.mode === 'Practice') }, 'All rounds on this hole ›')) : null,
      el('ol', { class: 'throws' }, item.shots.map((shot) => el('li', {}, throwDetail(shot)))),
    ]),
  );
  const shown = setUpRoundMap(mapEl, round.shots, layout?.layouts ?? [], scorecard, { firstHole: hole, onMoveThrow });
  if (!shown) moveButton?.remove();
  else if (editing) shown.setEditing(true);
  // The 3D view can add the other rounds played on the same course layout, starting with this one.
  const sameLayout = data.rounds
    .filter((other) => other.clientId === round.clientId || (!other.inProgress && courseFor(other) && courseFor(other) === course && (other.layoutId ?? MAIN_LAYOUT_ID) === (round.layoutId ?? MAIN_LAYOUT_ID)))
    .sort((a, b) => roundDate(b) - roundDate(a));
  if (shown) {
    setUpRound3d(mapEl, {
      firstHole: shown.first,
      rowsRoot: scorecard,
      onShowMap: () => shown.map.invalidateSize(),
      optionsFor: (hole) => ({
        hole,
        layout: layout?.layouts?.[hole - 1] ?? null,
        rounds: sameLayout.filter((other) => other.shots.some((shot) => shot.hole === hole))
          .map((other) => ({ id: other.clientId, label: `${other.clientId === round.clientId ? 'This round' : formatDate(roundDate(other))}${other.mode === 'Practice' ? ' (practice)' : ''}`, shots: other.shots })),
        selected: [round.clientId],
      }),
    });
  }
};

const RESULT_TYPES = [
  ['Eagle or better', (diff) => diff <= -2], ['Birdie', (diff) => diff === -1], ['Par', (diff) => diff === 0],
  ['Bogey', (diff) => diff === 1], ['Double bogey+', (diff) => diff >= 2],
];

// Every recorded throw on one hole of a course layout, across rounds (and practice sessions when
// `includePractice`): its scoring, all the throws on one map (or in 3D), their stats, and each visit.
const renderHoleHistory = (courseId, layoutId, hole, includePractice) => {
  const course = data.courses.find((item) => item.clientId === courseId);
  const layout = course ? layoutsOf(course).find((item) => item.id === layoutId) : undefined;
  const holeLayout = layout?.layouts?.[hole - 1] ?? null;
  const par = holeLayout?.par;
  const visits = data.rounds
    .filter((round) => !round.inProgress && round.courseClientId === courseId && (round.layoutId ?? MAIN_LAYOUT_ID) === layoutId && (includePractice || round.mode === 'Round'))
    // Each visit is scored against the par it was played with, which may differ from today's.
    .map((round) => ({ round, label: `${formatDate(roundDate(round))}${round.mode === 'Practice' ? ' (practice)' : ''}`, shots: round.shots.filter((shot) => shot.hole === hole), par: round.pars?.[hole - 1] ?? par }))
    .filter((visit) => visit.shots.length)
    .sort((a, b) => roundDate(b.round) - roundDate(a.round));
  // Practice doesn't count toward scoring.
  const played = visits.filter((visit) => visit.round.mode === 'Round').map((visit) => ({ score: strokes(visit.shots), par: visit.par }));
  const scores = played.map((item) => item.score);
  const toPars = played.filter((item) => item.par !== undefined && item.par !== null).map((item) => item.score - item.par);
  const average = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
  const best = scores.length ? Math.min(...scores) : null;
  const averageToPar = toPars.length ? toPars.reduce((sum, value) => sum + value, 0) / toPars.length : null;
  const results = RESULT_TYPES.map(([label, matches]) => [label, toPars.filter((diff) => matches(diff)).length]).filter(([, count]) => count);
  const stat = (label, value, note) => el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), note ? el('div', { class: 'stat-note' }, note) : null);
  const mapEl = el('div', { class: 'map', role: 'img', 'aria-label': `Satellite map of every throw on hole ${hole}` });

  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, [course?.name ?? 'Course', course && layoutsOf(course).length > 1 ? `${layout?.name ?? 'Deleted'} layout` : null, 'Every throw'].filter(Boolean).join(' · ')),
    el('h1', {}, `Hole ${String(hole).padStart(2, '0')}`),
    visits.length ? [
      el('div', { class: 'stats' },
        stat('PLAYED', scores.length, visits.length > scores.length ? `+ ${plural(visits.length - scores.length, 'practice session')}` : scores.length === 1 ? 'round' : 'rounds'),
        stat('PAR', par ?? '—', par === undefined ? 'Not set' : null),
        stat('AVG SCORE', average === null ? '—' : average.toFixed(1), averageToPar === null ? null : formatToPar(Math.round(averageToPar * 10) / 10)),
        stat('BEST', best ?? '—', toPars.length ? formatToPar(Math.min(...toPars)) : null)),
      results.length ? el('div', { class: 'chips' }, results.map(([label, count]) => el('span', { class: 'chip' }, `${count} ${label}${count === 1 || label.endsWith('+') || label.endsWith('better') ? '' : 's'}`))) : null,
      el('h2', {}, 'Every throw'),
      mapEl,
      el('p', { class: 'map-legend' }, Object.entries(THROW_TYPE_COLORS).map(([type, color]) => [el('span', { class: 'legend-dot', style: `background: ${color}` }), type])),
      renderHoleSummary(visits.map((visit) => ({ shots: visit.shots, layouts: roundHoles(visit.round) }))),
      el('h2', {}, 'Each time you played it'),
      el('ul', { class: 'results' }, visits.map((visit) => {
        const score = strokes(visit.shots);
        return el('li', {}, el('a', { href: `#round/${encodeURIComponent(visit.round.clientId)}` },
          el('span', {},
            el('span', { class: 'name' }, visit.label),
            el('span', { class: 'sub' }, [`${plural(score, 'stroke')}${visit.par === undefined || visit.par === null ? '' : ` (${formatToPar(score - visit.par)})`}`, visit.shots.map((shot) => shot.disc || 'No disc').join(' › ')].join(' · '))),
          el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
      })),
    ] : el('p', { class: 'meta' }, 'No throws recorded on this hole yet.'),
  );

  const map = visits.length ? satelliteMap(mapEl) : null;
  if (!map) {
    mapEl.remove();
    return;
  }
  const layers = [drawHoles(map, layout?.layouts ?? [], { only: hole }), drawEveryThrow(map, visits, holeLayout?.tee ?? null)];
  if (!fitTo(map, layers.flatMap((layer) => layer.bounds))) {
    mapEl.remove();
    return;
  }
  setUpRound3d(mapEl, {
    firstHole: hole,
    rowsRoot: el('div', {}),
    onShowMap: () => map.invalidateSize(),
    optionsFor: () => ({ hole, layout: holeLayout, rounds: visits.map((visit) => ({ id: visit.round.clientId, label: visit.label, shots: visit.shots })) }),
  });
};

// Quality bar colors, matching the throw markers on the maps.
const QUALITY_SEGMENTS = [['good', 'Good', '#2e9d5b'], ['fair', 'Fair', '#e3b505'], ['poor', 'Poor', '#d64541'], ['unrated', 'Not rated', '#59625d']];
const QUALITY_NAMES = { 1: 'poor', 2: 'fair', 3: 'good' };
const THROW_TYPES = ['Drive', 'Approach', 'Putt'];
const discFeet = (value) => (value === null || value === 0 ? '—' : `${Math.round(value).toLocaleString()} ft`);

// Every throw with one disc: #disc/<name>, then /<types> (comma-separated; 'all' for none) and
// /practice to keep disc stats' filters.
const discHref = (disc, types, includePractice) =>
  `#disc/${encodeURIComponent(disc)}/${types.length ? types.map(encodeURIComponent).join(',') : 'all'}${includePractice ? '/practice' : ''}`;

// Finished sessions for disc stats (practice too when `includePractice`), each with the layouts
// it was played on and the synced round itself, for linking back to it.
const discSessions = (includePractice) => data.rounds
  // A round still being played isn't counted until it's finished.
  .filter((round) => !round.inProgress && (includePractice || round.mode === 'Round'))
  .map((round) => ({ round, shots: round.shots, layouts: roundHoles(round) }));

// One disc's distance figures and quality bar; with `href`, the card links to the disc's throws.
const discCard = (stats, href) => {
  const segments = QUALITY_SEGMENTS.filter(([key]) => stats.quality[key]);
  return el(href ? 'a' : 'section', { class: 'disc-card', href, 'aria-label': href ? `Every throw with the ${stats.disc}` : undefined },
    el('div', { class: 'disc-card-head' },
      el('h3', {}, stats.disc),
      el('span', { class: 'meta' }, `${plural(stats.throws, 'throw')}${stats.measured < stats.throws ? ` · ${stats.measured} measured` : ''}${href ? '  ›' : ''}`)),
    el('dl', { class: 'disc-figures' }, [['Min', stats.minFeet], ['Avg', stats.averageFeet], ['90th', stats.p90Feet], ['95th', stats.p95Feet], ['Max', stats.maxFeet]]
      .map(([label, feet]) => el('div', {}, el('dt', {}, label), el('dd', {}, discFeet(feet))))),
    el('div', { class: 'disc-quality', role: 'img', 'aria-label': `Quality: ${segments.map(([key, label]) => `${stats.quality[key]} ${label.toLowerCase()}`).join(', ')}` },
      segments.map(([key, , color]) => el('span', { style: `flex: ${stats.quality[key]}; background: ${color}` }))),
    el('p', { class: 'meta disc-quality-text' }, [...segments.map(([key, label]) => `${label} ${stats.quality[key]}`), stats.averageQuality === null ? null : `avg ${stats.averageQuality.toFixed(1)} / 3`].filter(Boolean).join('  ·  ')));
};

// The throw-type buttons (several at once; none means all) and the practice box shared by disc
// stats and a disc's throws. `filters` is { types, practice }, changed in place; `render` redraws.
const discFilters = (filters, render) => {
  const practiceBox = el('input', { type: 'checkbox', id: 'discs-practice', checked: filters.practice });
  practiceBox.addEventListener('change', () => { filters.practice = practiceBox.checked; render(); });
  return [
    filterGroup('Filter by throw type', [[null, 'All throws'], ...THROW_TYPES.map((type) => [type, type])], (types) => { filters.types = types; render(); }, filters.types),
    el('div', { class: 'filters' }, el('label', { class: 'check' }, practiceBox, ' Include practice sessions')),
  ];
};

// Distance and quality by disc across finished rounds: min, average, 90th and 95th percentile,
// max, and how the throws were rated. A disc's card opens each of its throws.
const renderDiscStats = () => {
  const filters = { types: [], practice: false };
  const content = el('div', {});
  const render = () => {
    const discs = discStats(discSessions(filters.practice), { types: filters.types });
    setChildren(content, discs.length ? discs.map((stats) => discCard(stats, discHref(stats.disc, filters.types, filters.practice))) : el('p', { class: 'meta' }, 'No throws match yet.'));
  };
  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, user.displayName),
    el('h1', {}, 'Disc stats'),
    discFilters(filters, render),
    el('p', { class: 'meta' }, 'Distances use only throws with a reliable GPS measurement. The 90th percentile is the distance 9 in 10 measured throws stay within; the 95th, 19 in 20. Pick a disc to see each throw.'),
    content,
  );
  render();
};

// Every throw with one disc: its figures, then each throw longest first (unmeasured ones last),
// each linking to the round it's from.
const renderDiscThrows = (disc, types, includePractice) => {
  const filters = { types: THROW_TYPES.filter((type) => types.includes(type)), practice: includePractice };
  const content = el('div', {});
  const render = () => {
    const sessions = discSessions(filters.practice);
    const stats = discStats(sessions, { types: filters.types }).find((item) => item.disc === disc);
    const throws = discThrows(sessions, disc, { types: filters.types });
    setChildren(content,
      stats ? discCard(stats) : null,
      throws.length ? [
        el('h2', {}, 'Each throw, longest first'),
        el('ul', { class: 'results' }, throws.map(({ round: { round }, shot, feet }) => {
          const rating = quality(shot);
          return el('li', {}, el('a', { href: `#round/${encodeURIComponent(round.clientId)}` },
            el('span', { class: 'disc-throw' },
              el('span', { class: 'disc-throw-feet' }, feet === null ? '—' : `${feet} ft`),
              el('span', {},
                el('span', { class: 'name' }, [shot.type, shot.style?.toLowerCase(), shot.lie ? (shot.lie === 'Basket' && shot.type === 'Putt' ? 'made' : shot.lie.toLowerCase()) : null, rating ? QUALITY_NAMES[rating] : null].filter(Boolean).join(' · ')),
                el('span', { class: 'sub' }, [round.courseName, `hole ${shot.hole}`, formatDate(roundDate(round)), round.mode === 'Practice' ? 'practice' : null, feet === null ? 'not measured' : null].filter(Boolean).join(' · ')))),
            el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
        })),
      ] : el('p', { class: 'meta' }, 'No throws with this disc match these filters.'));
  };
  setChildren(signedInEl,
    el('p', {}, el('a', { href: '#discs' }, '‹ Disc stats')),
    el('div', { class: 'eyebrow' }, 'Disc stats · Every throw'),
    el('h1', {}, disc),
    discFilters(filters, render),
    content,
  );
  render();
};

// `layoutIndex` and `editing` keep the view where it was after a tee or basket is moved.
const renderCourse = (course, { layoutIndex = 0, editing = false } = {}) => {
  const layouts = layoutsOf(course);
  const mapEl = el('div', { class: 'map tall', role: 'img', 'aria-label': 'Satellite map of the course' });
  const panels = layouts.map((layout, index) => el('section', { 'data-layout-panel': index, hidden: index !== layoutIndex },
    layouts.length > 1 ? el('h2', {}, `${layout.name} layout`) : null,
    el('table', {},
      el('thead', {}, el('tr', {}, ['HOLE', 'PAR', 'DISTANCE'].map((heading) => el('th', {}, heading)))),
      el('tbody', {}, layout.layouts.map((hole, holeIndex) => el('tr', {},
        el('td', {}, String(holeIndex + 1).padStart(2, '0')), el('td', {}, hole.par ?? '—'),
        el('td', {}, hole.tee && hole.basket ? `${Math.round(feetBetween(hole.tee, hole.basket))} ft` : '—')))))));
  const tabs = layouts.length > 1
    ? el('div', { class: 'tabs', role: 'group', 'aria-label': 'Layouts' }, layouts.map((layout, index) => el('button', { type: 'button', 'aria-pressed': String(index === layoutIndex), onclick: () => show(index) }, layout.name)))
    : null;
  const place = [course.details?.city, course.details?.state].filter(Boolean).join(', ');
  // Tees and baskets can be dragged to fix a poor GPS save. It changes the course for every round
  // played on it (and, when published, for everyone who added it from the directory).
  let shownIndex = layoutIndex;
  const moveStatus = el('p', { class: 'status', 'aria-live': 'polite' });
  const moveNote = el('p', { class: 'map-note', hidden: !editing }, `Drag a tee or basket to where it really is. It’s saved to your account and changes the course for every round played on it${course.published ? ', and for everyone who added it from the course directory' : ''}.`);
  const moveButton = el('button', { class: 'button secondary', type: 'button', 'aria-pressed': String(editing), onclick: () => setMoving(moveButton.getAttribute('aria-pressed') !== 'true') }, 'Move tees and baskets');
  const setMoving = (on) => {
    moveButton.setAttribute('aria-pressed', String(on));
    moveNote.hidden = !on;
    show(shownIndex, { refit: false });
  };
  const onMove = async (hole, kind, latitude, longitude) => {
    const point = placedPoint(latitude, longitude, Date.now());
    const movePoint = (holeLayouts) => holeLayouts.map((item, index) => (index === hole - 1 ? { ...item, [kind]: point } : item));
    const layoutId = layouts[shownIndex].id;
    const edited = layoutId === MAIN_LAYOUT_ID
      ? { ...course, layouts: movePoint(course.layouts) }
      : { ...course, extraLayouts: course.extraLayouts.map((extra) => (extra.id === layoutId ? { ...extra, layouts: movePoint(extra.layouts) } : extra)) };
    moveStatus.textContent = 'Saving…';
    try {
      const saved = await saveRecord('courses', edited, () => { moveStatus.textContent = 'Waiting for the server to wake up…'; });
      keepScroll(() => renderCourse(saved, { layoutIndex: shownIndex, editing: true }));
    } catch (error) {
      moveStatus.textContent = `Couldn’t save the move: ${error.message}`;
      show(shownIndex, { refit: false });
    }
  };
  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, ['Your course', place].filter(Boolean).join(' · ')),
    el('h1', {}, course.name),
    el('p', { class: 'meta' }, course.published && course.uid
      ? el('a', { href: `/c/${encodeURIComponent(course.uid)}` }, 'Published: view its public page')
      : 'Private. Publish it from Course builder in the app to list it in the directory.'),
    tabs,
    mapEl,
    el('div', { class: 'map-edit' }, moveButton, moveNote, moveStatus),
    panels,
  );
  const map = satelliteMap(mapEl);
  let drawn = null;
  const show = (index, { refit = true } = {}) => {
    shownIndex = index;
    panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== index; });
    tabs?.querySelectorAll('button').forEach((button, buttonIndex) => button.setAttribute('aria-pressed', String(buttonIndex === index)));
    if (!map) return;
    drawn?.group.remove();
    drawn = drawHoles(map, layouts[index].layouts, { onMove: moveButton.getAttribute('aria-pressed') === 'true' ? onMove : undefined });
    if (refit && !fitTo(map, drawn.bounds)) map.setView([39.8, -98.6], 3);
  };
  if (!map) {
    mapEl.remove();
    moveButton.parentElement.remove();
  }
  show(layoutIndex);
};

// One course's holes, by layout: how often each was played, and the average and best scores from
// rounds (practice doesn't count toward scoring). `rounds` are that course's sessions.
const holeAverages = (key, rounds, includePractice) => {
  const course = data.courses.find((item) => item.clientId === key);
  if (!course) return null;
  const byLayout = [...rounds.reduce((map, round) => map.set(round.layoutId ?? MAIN_LAYOUT_ID, [...(map.get(round.layoutId ?? MAIN_LAYOUT_ID) ?? []), round]), new Map()).entries()];
  return [
    el('h2', {}, 'By hole'),
    el('p', { class: 'meta' }, 'Pick a hole to see every throw on it.'),
    byLayout.map(([layoutId, layoutRounds]) => {
      const layout = layoutsOf(course).find((item) => item.id === layoutId);
      const holes = holesPlayed(layoutRounds.flatMap((round) => round.shots)).map(({ hole }) => {
        const visits = layoutRounds.filter((round) => round.shots.some((shot) => shot.hole === hole));
        const scores = visits.filter((round) => round.mode === 'Round').map((round) => strokes(round.shots.filter((shot) => shot.hole === hole)));
        return {
          hole,
          par: layout?.layouts?.[hole - 1]?.par ?? null,
          played: visits.length,
          average: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
          best: scores.length ? Math.min(...scores) : null,
        };
      });
      const grid = fromHtml(holeAveragesHtml(holes));
      // A hole's column opens every throw on it.
      grid?.addEventListener('click', (event) => {
        const cell = event.target.closest('[data-hole]');
        if (cell) location.hash = holeHref(key, layoutId, Number(cell.dataset.hole), includePractice);
      });
      return [byLayout.length > 1 ? el('h3', {}, `${layout?.name ?? 'Deleted'} layout`) : null, grid];
    }),
  ];
};

// Stats across every synced round, optionally for one course and with practice sessions.
const renderStats = () => {
  // The chosen course keys (none means all courses) and whether practice sessions count.
  const filters = { courses: [], practice: false };
  const courseKey = (round) => round.courseClientId ?? `name:${round.courseName}`;
  const courseName = (key, round) => data.courses.find((course) => course.clientId === key)?.name ?? round.courseName;
  const content = el('div', {});
  const courseButtons = el('div', {});
  const practiceBox = el('input', { type: 'checkbox', id: 'stats-practice' });

  const render = () => {
    // A round still being played isn't counted until it's finished.
    const sessions = data.rounds.filter((round) => !round.inProgress && (filters.practice || round.mode === 'Round'));
    // Courses with matching sessions, most-played first.
    const courses = [...sessions.reduce((map, round) => {
      const key = courseKey(round);
      const entry = map.get(key) ?? { key, name: courseName(key, round), rounds: [] };
      entry.rounds.push(round);
      return map.set(key, entry);
    }, new Map()).values()].sort((a, b) => b.rounds.length - a.rounds.length || a.name.localeCompare(b.name));
    // Chosen courses with no sessions under the current filters are ignored.
    const picked = filters.courses.filter((key) => courses.some((course) => course.key === key));
    const pickedCourses = picked.length ? courses.filter((course) => picked.includes(course.key)) : courses;
    const pickOnly = (key) => { filters.courses = [key]; render(); };
    setChildren(courseButtons,
      filterGroup('Filter by course', [[null, `All courses (${sessions.length})`], ...courses.map((course) => [course.key, `${course.name} (${course.rounds.length})`])],
        (keys) => { filters.courses = keys; render(); }, picked),
      courses.length > 1 ? el('p', { class: 'meta' }, 'Pick one course or several to combine them.') : null);

    const selected = picked.length ? sessions.filter((round) => picked.includes(courseKey(round))) : sessions;
    const scored = selected.filter((round) => round.mode === 'Round').map((round) => ({ round, score: roundScore(round) }));
    const withPar = scored.filter((item) => item.score.toPar !== null);
    const best = withPar.reduce((top, item) => (!top || item.score.toPar < top.score.toPar ? item : top), null);
    const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const sessionWord = filters.practice ? 'session' : 'round';

    setChildren(content,
      selected.length ? null : el('p', { class: 'meta' }, `No ${sessionWord}s yet.`),
      scored.length ? el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('div', { class: 'label' }, 'ROUNDS'), el('div', { class: 'value' }, scored.length),
          filters.practice && selected.length > scored.length ? el('div', { class: 'stat-note' }, `+ ${plural(selected.length - scored.length, 'practice session')}`) : null),
        el('div', { class: 'stat' }, el('div', { class: 'label' }, 'AVG SCORE'), el('div', { class: 'value' }, average(scored.map((item) => item.score.total)).toFixed(1)),
          pickedCourses.length > 1 ? el('div', { class: 'stat-note' }, 'Across different courses') : null),
        el('div', { class: 'stat' }, el('div', { class: 'label' }, 'AVG TO PAR'), el('div', { class: 'value' }, withPar.length ? formatToPar(Math.round(average(withPar.map((item) => item.score.toPar)) * 10) / 10) : '—'),
          withPar.length < scored.length ? el('div', { class: 'stat-note' }, `${withPar.length} of ${scored.length} rounds have pars`) : null),
        el('div', { class: 'stat' }, el('div', { class: 'label' }, 'BEST ROUND'), el('div', { class: 'value' }, best ? formatToPar(best.score.toPar) : '—'),
          best ? el('div', { class: 'stat-note' }, el('a', { href: `#round/${encodeURIComponent(best.round.clientId)}` }, `${best.round.courseName}, ${formatDate(roundDate(best.round))}`)) : null)) : null,
      pickedCourses.length > 1 ? [
        el('h2', {}, 'By course'),
        el('table', {},
          el('thead', {}, el('tr', {}, ['COURSE', 'ROUNDS', 'AVG SCORE', 'AVG TO PAR', 'BEST'].map((heading) => el('th', {}, heading)))),
          el('tbody', {}, pickedCourses.map((course) => {
            const courseScores = course.rounds.filter((round) => round.mode === 'Round').map((round) => roundScore(round));
            const courseWithPar = courseScores.filter((item) => item.toPar !== null);
            return el('tr', { 'data-course': course.key, onclick: () => pickOnly(course.key) },
              el('td', {}, el('a', { href: '#stats', onclick: (event) => { event.preventDefault(); event.stopPropagation(); pickOnly(course.key); } }, course.name)),
              el('td', {}, course.rounds.length),
              el('td', {}, courseScores.length ? average(courseScores.map((item) => item.total)).toFixed(1) : '—'),
              el('td', {}, courseWithPar.length ? formatToPar(Math.round(average(courseWithPar.map((item) => item.toPar)) * 10) / 10) : '—'),
              el('td', {}, courseWithPar.length ? formatToPar(Math.min(...courseWithPar.map((item) => item.toPar))) : '—'));
          }))),
      ] : null,
      picked.length === 1 ? holeAverages(picked[0], selected, filters.practice) : null,
      renderHistorySummary(selected.map((round) => ({ shots: round.shots, layouts: roundHoles(round) }))),
    );
  };

  practiceBox.addEventListener('change', () => { filters.practice = practiceBox.checked; render(); });
  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, user.displayName),
    el('h1', {}, 'All-time stats'),
    el('p', {}, el('a', { href: '#discs' }, 'Disc stats: distances and quality by disc ›')),
    courseButtons,
    el('div', { class: 'filters' }, el('label', { class: 'check' }, practiceBox, ' Include practice sessions')),
    content,
  );
  render();
};

const route = () => {
  if (!data) return;
  // Each part is encoded on its own, so ids can't be mistaken for separators.
  const [kind, id, ...rest] = location.hash.slice(1).split('/').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const round = kind === 'round' ? data.rounds.find((item) => item.clientId === id) : undefined;
  const course = kind === 'course' ? data.courses.find((item) => item.clientId === id) : undefined;
  if (kind === 'stats') renderStats();
  else if (kind === 'discs') renderDiscStats();
  else if (kind === 'disc' && id) renderDiscThrows(id, rest[0] && rest[0] !== 'all' ? rest[0].split(',') : [], rest[1] === 'practice');
  else if (kind === 'hole' && Number(rest[1]) > 0) renderHoleHistory(id, rest[0], Number(rest[1]), rest[2] === 'practice');
  else if (round) renderRound(round);
  else if (course) renderCourse(course);
  else renderOverview();
  window.scrollTo(0, 0);
};

// ---------------------------------------------------------------- session

const showSignedOut = (message = '') => {
  signedInEl.hidden = true;
  signedOutEl.hidden = false;
  $('#auth-status').textContent = message;
};

// Everything synced to the account. The server sends it a page at a time; each record is in
// exactly one page.
const downloadAll = async () => {
  const all = { courses: [], rounds: [], bag: null };
  let cursor = 0;
  let more = true;
  while (more) {
    const page = await api('/api/sync', { method: 'POST', token, body: { cursor } });
    all.courses.push(...page.courses);
    all.rounds.push(...page.rounds);
    all.bag = page.bag ?? all.bag;
    ({ cursor, more } = page);
  }
  return { ...all, cursor };
};

// Uploads one edited course or round through sync, as the app does: the newest edit wins, and
// phones pick it up on their next sync. `kind` is 'courses' or 'rounds'. Returns the saved record.
const SAVE_RETRY_DELAYS_MS = [3_000, 10_000, 20_000, 30_000, 30_000];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A save that gets no answer (fetch rejects, Safari's "Load failed") or a gateway error is usually
// the free server waking from sleep or restarting for an update, so it's tried again for about a
// minute and a half. `onRetry` can say so meanwhile. Other errors the server answers with aren't
// retried.
const sendSave = async (body, onRetry) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api('/api/sync', { method: 'POST', token, body });
    } catch (error) {
      // No answer, or the host's "starting up" gateway errors.
      const waking = error.status === undefined || [502, 503, 504].includes(error.status);
      if (!waking || attempt >= SAVE_RETRY_DELAYS_MS.length) {
        throw waking ? new Error('Couldn’t reach the server. Check your connection and try again.') : error;
      }
      onRetry?.();
      await wait(SAVE_RETRY_DELAYS_MS[attempt]);
    }
  }
};

const saveRecord = async (kind, record, onRetry) => {
  // Courses say which server version they were edited from, so a newer save from a phone is
  // merged in rather than overwritten. The same edit time on every attempt makes a retry harmless.
  const edited = { ...record, updatedAt: Math.max(Date.now(), record.updatedAt + 1), ...(kind === 'courses' ? { baseUpdatedAt: record.updatedAt } : {}) };
  const page = await sendSave({ cursor: syncCursor, [kind]: [edited] }, onRetry);
  syncCursor = page.cursor;
  // The reply has everything changed since the last download, this edit included.
  for (const list of ['courses', 'rounds']) {
    for (const item of page[list]) {
      const rest = data[list].filter((existing) => existing.clientId !== item.clientId);
      data[list] = item.deleted ? rest : [...rest, item];
    }
  }
  return data[kind].find((item) => item.clientId === record.clientId) ?? edited;
};

// Redraws a view after a save without jumping back to the top of the page.
const keepScroll = (render) => {
  const top = window.scrollY;
  render();
  window.scrollTo(0, top);
};

const load = async () => {
  signedOutEl.hidden = true;
  signedInEl.hidden = false;
  setChildren(signedInEl, el('p', { class: 'status' }, 'Loading your rounds… The server can take up to a minute to wake if it hasn’t been used recently.'));
  try {
    const [me, synced] = await Promise.all([api('/api/me', { token }), downloadAll()]);
    user = me.user;
    // A full download includes deletion markers; only live records are shown.
    data = { courses: synced.courses.filter((item) => !item.deleted), rounds: synced.rounds.filter((item) => !item.deleted), bag: synced.bag };
    syncCursor = synced.cursor;
    route();
  } catch (error) {
    if (error.status === 401) {
      saveToken(null);
      showSignedOut('Your session expired. Sign in again.');
    } else {
      setChildren(signedInEl, el('p', { class: 'status error' }, error.message), el('button', { class: 'button', type: 'button', onclick: load }, 'Try again'));
    }
  }
};

function signOut() {
  saveToken(null);
  user = null;
  data = null;
  history.replaceState(null, '', location.pathname);
  showSignedOut();
}

async function deleteAccount() {
  if (!confirm('Delete your Glide Path account? This permanently deletes everything synced to it, including published courses and shared round links. Data on your phone is kept.')) return;
  try {
    await api('/api/me', { method: 'DELETE', token });
    signOut();
    $('#auth-status').textContent = 'Your account was deleted.';
  } catch (error) {
    alert(error.message);
  }
}

// signIn and register, plus 'forgot' (email a reset code) and 'reset' (code and new password).
let mode = 'signIn';
const SUBMIT_LABELS = { signIn: 'Sign in', register: 'Create account', forgot: 'Send reset code', reset: 'Reset password & sign in' };

const setMode = (next) => {
  mode = next;
  const choosing = mode === 'signIn' || mode === 'register';
  $('#auth-tabs').hidden = !choosing;
  document.querySelectorAll('[data-mode]').forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.mode === mode)));
  $('#auth-back').hidden = choosing;
  $('#auth-intro').hidden = mode !== 'forgot';
  $('#name-field').hidden = mode !== 'register';
  $('#code-field').hidden = mode !== 'reset';
  $('#password-field').hidden = mode === 'forgot';
  $('#password').required = mode !== 'forgot';
  $('#password-label').textContent = mode === 'reset' ? 'NEW PASSWORD' : 'PASSWORD';
  $('#password').autocomplete = mode === 'signIn' ? 'current-password' : 'new-password';
  $('#auth-submit').textContent = SUBMIT_LABELS[mode];
  $('#forgot-link').hidden = mode !== 'signIn';
  $('#resend-link').hidden = mode !== 'reset';
};

document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  setMode(button.dataset.mode);
  $('#auth-status').textContent = '';
}));
const linkTo = (selector, action) => $(selector).addEventListener('click', (event) => {
  event.preventDefault();
  action();
});
linkTo('#forgot-link', () => { setMode('forgot'); $('#auth-status').textContent = ''; });
linkTo('#back-to-sign-in', () => { setMode('signIn'); $('#auth-status').textContent = ''; });
linkTo('#resend-link', () => sendResetCode());

async function sendResetCode() {
  const email = $('#email').value.trim();
  const statusEl = $('#auth-status');
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    statusEl.textContent = 'Enter the email address for your account.';
    return;
  }
  statusEl.textContent = 'Sending… The server can take up to a minute to wake.';
  try {
    await api('/api/auth/forgot', { method: 'POST', body: { email } });
    setMode('reset');
    $('#code').value = '';
    $('#password').value = '';
    statusEl.textContent = `If ${email} has an account, a 6-digit code is on its way. It expires in 15 minutes; check your spam folder if it doesn’t arrive.`;
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

async function submitPasswordReset() {
  const email = $('#email').value.trim();
  const code = $('#code').value.trim();
  const password = $('#password').value;
  const statusEl = $('#auth-status');
  if (!/^\d{6}$/.test(code)) {
    statusEl.textContent = 'Enter the 6-digit code from the email.';
    return;
  }
  if (password.length < 8) {
    statusEl.textContent = 'Use a new password of at least 8 characters.';
    return;
  }
  statusEl.textContent = 'Resetting…';
  try {
    const result = await api('/api/auth/reset', { method: 'POST', body: { email, code, password } });
    saveToken(result.token);
    $('#password').value = '';
    $('#code').value = '';
    setMode('signIn');
    statusEl.textContent = '';
    await load();
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (mode === 'forgot') return sendResetCode();
  if (mode === 'reset') return submitPasswordReset();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const displayName = $('#name').value.trim();
  const statusEl = $('#auth-status');
  if (mode === 'register' && (!displayName || password.length < 8)) {
    statusEl.textContent = !displayName ? 'Enter your name.' : 'Use a password of at least 8 characters.';
    return;
  }
  const submit = $('#auth-submit');
  submit.disabled = true;
  statusEl.textContent = 'Signing in… The server can take up to a minute to wake.';
  try {
    const result = mode === 'register'
      ? await api('/api/auth/register', { method: 'POST', body: { email, password, displayName } })
      : await api('/api/auth/login', { method: 'POST', body: { email, password } });
    saveToken(result.token);
    $('#password').value = '';
    await load();
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

window.addEventListener('hashchange', route);
if (token) load();
else showSignedOut();
