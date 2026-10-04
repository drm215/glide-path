import { renderHistorySummary, renderRoundSummary } from './summary.js';
import { $, TOKEN_KEY, api, setChildren, throwLegend, drawHoles, el, feetBetween, fitTo, formatDate, formatToPar, holesPlayed, plural, satelliteMap, setUpRoundMap, strokes, throwDetail, toParClass } from './lib.js';

const signedOutEl = $('#signed-out');
const signedInEl = $('#signed-in');
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable: stay signed out */ }
let user = null;
let data = null;

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
// Round ids are the time the round ended.
const roundDate = (round) => (Number.isFinite(Number(round.clientId)) ? Number(round.clientId) : round.updatedAt);

const roundScore = (round) => {
  const pars = layoutFor(round)?.layouts ?? [];
  const holes = holesPlayed(round.shots).map((item) => ({ ...item, score: strokes(item.shots), par: pars[item.hole - 1]?.par }));
  const withPar = holes.filter((item) => item.par !== undefined);
  return {
    holes,
    total: strokes(round.shots),
    par: withPar.reduce((sum, item) => sum + item.par, 0),
    toPar: withPar.length ? withPar.reduce((sum, item) => sum + item.score - item.par, 0) : null,
  };
};

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
    rounds.length ? el('p', {}, el('a', { class: 'button secondary', href: '#stats' }, 'All-time stats ›')) : null,
    el('h2', {}, 'Rounds'),
    rounds.length
      ? el('ul', { class: 'results' }, rounds.map((round) => {
        const score = roundScore(round);
        const layout = layoutFor(round);
        const hasLayouts = courseFor(round) && layoutsOf(courseFor(round)).length > 1;
        return el('li', {}, el('a', { href: `#round/${encodeURIComponent(round.clientId)}` },
          el('span', {},
            el('span', { class: 'name' }, round.courseName),
            el('span', { class: 'sub' }, [formatDate(roundDate(round)), hasLayouts && layout ? `${layout.name} layout` : null, plural(score.holes.length, 'hole'), round.mode === 'Practice' ? 'Practice' : null].filter(Boolean).join(' · '))),
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

const renderRound = (round) => {
  const score = roundScore(round);
  const layout = layoutFor(round);
  const course = courseFor(round);
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ['HOLE', 'PAR', 'SCORE', '+/−'].map((heading) => el('th', {}, heading)))),
    el('tbody', {}, score.holes.map((item) => {
      const diff = item.par === undefined ? null : item.score - item.par;
      return el('tr', { 'data-hole': item.hole },
        el('td', {}, String(item.hole).padStart(2, '0')), el('td', {}, item.par ?? '—'), el('td', {}, el('strong', {}, item.score)),
        el('td', { class: diff === null ? '' : toParClass(diff) }, diff === null ? '—' : formatToPar(diff)));
    })),
    el('tfoot', {}, el('tr', {}, el('td', {}, 'TOTAL'), el('td', {}, score.toPar === null ? '—' : score.par), el('td', {}, score.total),
      el('td', { class: score.toPar === null ? '' : toParClass(score.toPar) }, score.toPar === null ? '—' : formatToPar(score.toPar)))));
  const mapEl = el('div', { class: 'map', role: 'img', 'aria-label': 'Satellite map of the selected hole and its throws' });
  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, [formatDate(roundDate(round)), round.mode === 'Practice' ? 'Practice' : null].filter(Boolean).join(' · ')),
    el('h1', {}, round.courseName),
    el('p', { class: 'meta' }, [course && layoutsOf(course).length > 1 && layout ? `${layout.name} layout` : null, plural(score.holes.length, 'hole')].filter(Boolean).join(' · ')),
    el('div', { class: 'score' }, el('span', { class: 'total' }, score.total), score.toPar === null ? null : el('span', { class: `par ${toParClass(score.toPar)}` }, formatToPar(score.toPar))),
    round.shared && round.shareToken ? el('p', {}, el('a', { href: `/r/${encodeURIComponent(round.shareToken)}` }, 'Public share link')) : null,
    mapEl,
    el('p', { class: 'map-note' }, 'Tap a hole in the scorecard to see where each throw landed.'),
    throwLegend(),
    table,
    renderRoundSummary(round.shots, layout?.layouts ?? []),
    el('h2', {}, 'Throw by throw'),
    score.holes.map((item) => [el('h3', {}, `Hole ${String(item.hole).padStart(2, '0')}`), el('ol', { class: 'throws' }, item.shots.map((shot) => el('li', {}, throwDetail(shot))))]),
  );
  setUpRoundMap(mapEl, round.shots, layout?.layouts ?? [], table);
};

const renderCourse = (course) => {
  const layouts = layoutsOf(course);
  const mapEl = el('div', { class: 'map tall', role: 'img', 'aria-label': 'Satellite map of the course' });
  const panels = layouts.map((layout, index) => el('section', { 'data-layout-panel': index, hidden: index > 0 },
    layouts.length > 1 ? el('h2', {}, `${layout.name} layout`) : null,
    el('table', {},
      el('thead', {}, el('tr', {}, ['HOLE', 'PAR', 'DISTANCE'].map((heading) => el('th', {}, heading)))),
      el('tbody', {}, layout.layouts.map((hole, holeIndex) => el('tr', {},
        el('td', {}, String(holeIndex + 1).padStart(2, '0')), el('td', {}, hole.par ?? '—'),
        el('td', {}, hole.tee && hole.basket ? `${Math.round(feetBetween(hole.tee, hole.basket))} ft` : '—')))))));
  const tabs = layouts.length > 1
    ? el('div', { class: 'tabs', role: 'group', 'aria-label': 'Layouts' }, layouts.map((layout, index) => el('button', { type: 'button', 'aria-pressed': String(index === 0), onclick: () => show(index) }, layout.name)))
    : null;
  const place = [course.details?.city, course.details?.state].filter(Boolean).join(', ');
  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, ['Your course', place].filter(Boolean).join(' · ')),
    el('h1', {}, course.name),
    el('p', { class: 'meta' }, course.published && course.uid
      ? el('a', { href: `/c/${encodeURIComponent(course.uid)}` }, 'Published: view its public page')
      : 'Private. Publish it from Course builder in the app to list it in the directory.'),
    tabs,
    mapEl,
    panels,
  );
  const map = satelliteMap(mapEl);
  let drawn = null;
  const show = (index) => {
    panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== index; });
    tabs?.querySelectorAll('button').forEach((button, buttonIndex) => button.setAttribute('aria-pressed', String(buttonIndex === index)));
    if (!map) return;
    drawn?.group.remove();
    drawn = drawHoles(map, layouts[index].layouts);
    if (!fitTo(map, drawn.bounds)) map.setView([39.8, -98.6], 3);
  };
  if (!map) mapEl.remove();
  show(0);
};

// Stats across every synced round, optionally for one course and with practice sessions.
const renderStats = () => {
  const filters = { course: 'all', practice: false };
  const courseKey = (round) => round.courseClientId ?? `name:${round.courseName}`;
  const courseName = (key, round) => data.courses.find((course) => course.clientId === key)?.name ?? round.courseName;
  const content = el('div', {});
  const courseSelect = el('select', { id: 'stats-course', 'aria-label': 'Course' });
  const practiceBox = el('input', { type: 'checkbox', id: 'stats-practice' });

  const render = () => {
    const sessions = data.rounds.filter((round) => filters.practice || round.mode === 'Round');
    // Courses with matching sessions, most-played first.
    const courses = [...sessions.reduce((map, round) => {
      const key = courseKey(round);
      const entry = map.get(key) ?? { key, name: courseName(key, round), rounds: [] };
      entry.rounds.push(round);
      return map.set(key, entry);
    }, new Map()).values()].sort((a, b) => b.rounds.length - a.rounds.length || a.name.localeCompare(b.name));
    if (filters.course !== 'all' && !courses.some((course) => course.key === filters.course)) filters.course = 'all';
    courseSelect.replaceChildren(
      el('option', { value: 'all', selected: filters.course === 'all' }, `All courses (${sessions.length})`),
      ...courses.map((course) => el('option', { value: course.key, selected: filters.course === course.key }, `${course.name} (${course.rounds.length})`)));

    const selected = filters.course === 'all' ? sessions : courses.find((course) => course.key === filters.course).rounds;
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
          filters.course === 'all' && courses.length > 1 ? el('div', { class: 'stat-note' }, 'Across different courses') : null),
        el('div', { class: 'stat' }, el('div', { class: 'label' }, 'AVG TO PAR'), el('div', { class: 'value' }, withPar.length ? formatToPar(Math.round(average(withPar.map((item) => item.score.toPar)) * 10) / 10) : '—'),
          withPar.length < scored.length ? el('div', { class: 'stat-note' }, `${withPar.length} of ${scored.length} rounds have pars`) : null),
        el('div', { class: 'stat' }, el('div', { class: 'label' }, 'BEST ROUND'), el('div', { class: 'value' }, best ? formatToPar(best.score.toPar) : '—'),
          best ? el('div', { class: 'stat-note' }, el('a', { href: `#round/${encodeURIComponent(best.round.clientId)}` }, `${best.round.courseName}, ${formatDate(roundDate(best.round))}`)) : null)) : null,
      filters.course === 'all' && courses.length > 1 ? [
        el('h2', {}, 'By course'),
        el('table', {},
          el('thead', {}, el('tr', {}, ['COURSE', 'ROUNDS', 'AVG SCORE', 'AVG TO PAR', 'BEST'].map((heading) => el('th', {}, heading)))),
          el('tbody', {}, courses.map((course) => {
            const courseScores = course.rounds.filter((round) => round.mode === 'Round').map((round) => roundScore(round));
            const courseWithPar = courseScores.filter((item) => item.toPar !== null);
            return el('tr', { 'data-course': course.key, onclick: () => { filters.course = course.key; render(); } },
              el('td', {}, el('a', { href: '#stats', onclick: (event) => { event.preventDefault(); filters.course = course.key; render(); } }, course.name)),
              el('td', {}, course.rounds.length),
              el('td', {}, courseScores.length ? average(courseScores.map((item) => item.total)).toFixed(1) : '—'),
              el('td', {}, courseWithPar.length ? formatToPar(Math.round(average(courseWithPar.map((item) => item.toPar)) * 10) / 10) : '—'),
              el('td', {}, courseWithPar.length ? formatToPar(Math.min(...courseWithPar.map((item) => item.toPar))) : '—'));
          }))),
      ] : null,
      renderHistorySummary(selected.map((round) => ({ shots: round.shots, layouts: layoutFor(round)?.layouts ?? [] }))),
    );
  };

  courseSelect.addEventListener('change', () => { filters.course = courseSelect.selectedOptions?.[0]?.value ?? courseSelect.value; render(); });
  practiceBox.addEventListener('change', () => { filters.practice = practiceBox.checked; render(); });
  setChildren(signedInEl,
    back(),
    el('div', { class: 'eyebrow' }, user.displayName),
    el('h1', {}, 'All-time stats'),
    el('div', { class: 'filters' },
      el('label', { for: 'stats-course' }, 'Course'), courseSelect,
      el('label', { class: 'check' }, practiceBox, ' Include practice sessions')),
    content,
  );
  render();
};

const route = () => {
  if (!data) return;
  const [kind, id] = decodeURIComponent(location.hash.slice(1)).split('/');
  const round = kind === 'round' ? data.rounds.find((item) => item.clientId === id) : undefined;
  const course = kind === 'course' ? data.courses.find((item) => item.clientId === id) : undefined;
  if (kind === 'stats') renderStats();
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
  return all;
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
