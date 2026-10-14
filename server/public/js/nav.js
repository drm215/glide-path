// The site nav's Admin link, shown only to a signed-in site admin. Pages that already know who's
// signed in (My rounds, Admin) call showAdminLink themselves; the rest load this to ask the server.
import { TOKEN_KEY, api } from './lib.js';

export const showAdminLink = (isAdmin) => {
  document.querySelectorAll('[data-admin-link]').forEach((link) => { link.hidden = !isAdmin; });
};

export const checkAdminLink = async () => {
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable: signed out */ }
  if (!token) return;
  try {
    showAdminLink(Boolean((await api('/api/me', { token })).user?.isAdmin));
  } catch { /* signed out or offline: keep it hidden */ }
};
