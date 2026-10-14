// Site admins' page in My rounds: every course (each opens in the course editor), every account
// (making or removing admins, deleting accounts), and combining two courses that are the same
// place. See server/src/admin.ts.
import { api, el, formatDate, plural, setChildren } from './lib.js';

const searchForm = (label, onSearch) => {
  const input = el('input', { type: 'search', placeholder: label, 'aria-label': label });
  return el('form', { class: 'search', onsubmit: (event) => { event.preventDefault(); onSearch(input.value); } },
    input, el('button', { class: 'button', type: 'submit' }, 'Search'));
};

const coursesTab = (token) => {
  const list = el('ul', { class: 'results' });
  const status = el('p', { class: 'status' });
  const search = async (query = '') => {
    status.textContent = 'Loading…';
    try {
      const { courses } = await api(`/api/admin/courses?q=${encodeURIComponent(query)}`, { token });
      status.textContent = courses.length ? '' : 'No courses match.';
      setChildren(list, courses.map((course) => el('li', {}, el('a', { href: `#edit/${encodeURIComponent(course.uid)}` },
        el('span', {},
          el('span', { class: 'name' }, course.name),
          el('span', { class: 'sub' }, [
            [course.city, course.state].filter(Boolean).join(', ') || null,
            `created by ${course.createdBy}`,
            course.layouts > 1 ? plural(course.layouts, 'layout') : plural(course.holes, 'hole'),
            plural(course.rounds, 'round'),
            plural(course.players, 'other player'),
          ].filter(Boolean).join(' · '))),
        el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')))));
    } catch (error) {
      status.textContent = error.message;
    }
  };
  search();
  return el('section', {}, searchForm('Course, place or creator', search), status, list);
};

const accountsTab = (token, me) => {
  const list = el('ul', { class: 'results' });
  const status = el('p', { class: 'status' });
  let lastQuery = '';
  const act = async (request, done) => {
    status.textContent = '';
    try {
      await request();
      done?.();
      search(lastQuery);
    } catch (error) {
      status.textContent = error.message;
    }
  };
  const search = async (query = '') => {
    lastQuery = query;
    try {
      const { users } = await api(`/api/admin/users?q=${encodeURIComponent(query)}`, { token });
      if (!users.length) status.textContent = 'No accounts match.';
      setChildren(list, users.map((user) => el('li', {}, el('span', { class: 'row' },
        el('span', {},
          el('span', { class: 'name' }, user.displayName, user.isAdmin ? el('span', { class: 'badge' }, 'Admin') : null),
          el('span', { class: 'sub' }, [user.email, `joined ${formatDate(user.createdAt)}`, plural(user.courses, 'course'), plural(user.rounds, 'round')].join(' · '))),
        el('span', { class: 'actions' },
          el('button', { class: 'button secondary', type: 'button', onclick: () => {
            if (user.isAdmin && user.id === me.id && !confirm('Stop being a site admin yourself?')) return;
            act(() => api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PUT', token, body: { isAdmin: !user.isAdmin } }));
          } }, user.isAdmin ? 'Remove admin' : 'Make admin'),
          user.id === me.id ? null : el('button', { class: 'button danger', type: 'button', onclick: () => {
            if (!confirm(`Delete ${user.displayName}'s account (${user.email})? Their rounds go with it; courses they created pass to another owner, or are deleted if they have none.`)) return;
            act(() => api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', token }));
          } }, 'Delete'))))));
    } catch (error) {
      status.textContent = error.message;
    }
  };
  search();
  return el('section', {}, searchForm('Name or email', search), status, list);
};

// Picks a course by searching: a search box and the matches as options.
const coursePicker = (token, label) => {
  const select = el('select', { 'aria-label': label }, el('option', { value: '' }, `${label}…`));
  const find = async (query) => {
    const { courses } = await api(`/api/admin/courses?q=${encodeURIComponent(query)}`, { token });
    select.replaceChildren(el('option', { value: '' }, courses.length ? `${label}…` : 'No courses match'),
      ...courses.map((course) => el('option', { value: course.uid }, `${course.name} · created by ${course.createdBy} · ${plural(course.rounds, 'round')}`)));
  };
  return { select, form: searchForm(`Find the ${label.toLowerCase()}`, find), value: () => select.selectedOptions?.[0]?.value ?? select.value };
};

const combineTab = (token) => {
  const source = coursePicker(token, 'Course to fold in');
  const target = coursePicker(token, 'Course to keep');
  const status = el('p', { class: 'status', 'aria-live': 'polite' });
  const combine = async () => {
    const sourceUid = source.value();
    const targetUid = target.value();
    if (!sourceUid || !targetUid) { status.textContent = 'Pick both courses.'; return; }
    if (!confirm('Combine them? The first course’s holes and layouts go into the second, every round on it moves there, its owners and players move over, and it is deleted. This can’t be undone.')) return;
    status.textContent = 'Combining…';
    try {
      const { uid } = await api('/api/admin/combine', { method: 'POST', token, body: { sourceUid, targetUid } });
      location.hash = `#edit/${encodeURIComponent(uid)}`;
    } catch (error) {
      status.textContent = error.message;
    }
  };
  return el('section', {},
    el('p', { class: 'meta' }, 'For two courses that are really the same place, mapped separately. Layouts with the same name are joined; where both have a tee or basket, the more recently saved one is kept.'),
    el('h3', {}, 'Fold in'), source.form, source.select,
    el('h3', {}, 'Into'), target.form, target.select,
    el('p', {}, el('button', { class: 'button', type: 'button', onclick: combine }, 'Combine courses')),
    status);
};

export const renderAdmin = (root, { token, me, back }) => {
  const panels = { courses: coursesTab(token), accounts: accountsTab(token, me), combine: combineTab(token) };
  const content = el('div', {});
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Admin sections' },
    Object.entries({ courses: 'Courses', accounts: 'Accounts', combine: 'Combine courses' }).map(([key, label]) => el('button', {
      type: 'button', 'aria-pressed': String(key === 'courses'),
      onclick: (event) => {
        tabs.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(button === event.currentTarget)));
        setChildren(content, panels[key]);
      },
    }, label)));
  setChildren(content, panels.courses);
  setChildren(root,
    back,
    el('div', { class: 'eyebrow' }, 'Site admin'),
    el('h1', {}, 'Admin'),
    el('p', { class: 'meta' }, 'Site admins can edit or delete any course, choose its owners, combine duplicates, and manage accounts.'),
    tabs,
    content);
};
