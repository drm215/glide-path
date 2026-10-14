// The Admin page (/admin): site admins' tools (see admin.js). Anyone else is sent to sign in, or
// told it's only for site admins.
import { renderAdmin } from './admin.js';
import { TOKEN_KEY, api, el, setChildren } from './lib.js';
import { showAdminLink } from './nav.js';

const root = document.getElementById('admin');
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable: signed out */ }

const notAllowed = (message) => setChildren(root,
  el('div', { class: 'eyebrow' }, 'Site admin'),
  el('h1', {}, 'Admin'),
  el('p', { class: 'lede' }, message),
  el('p', {}, el('a', { class: 'button', href: '/account' }, 'Go to My rounds')));

const start = async () => {
  if (!token) { notAllowed('Sign in with a site admin account to use this page.'); return; }
  try {
    const { user } = await api('/api/me', { token });
    showAdminLink(user.isAdmin);
    if (!user.isAdmin) { notAllowed('This page is only for site admins.'); return; }
    renderAdmin(root, { token, me: user });
  } catch (error) {
    notAllowed(error.status === 401 ? 'Your session expired. Sign in again on My rounds.' : error.message);
  }
};

start();
