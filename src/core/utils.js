// DOM shorthands, escaping, formatting and small helpers shared everywhere.
export const $ = (sel, scope) => (scope || document).querySelector(sel);
export const $$ = (sel, scope) => [...(scope || document).querySelectorAll(sel)];

export const getCookie = (name) => {
  try {
    const parts = `; ${document.cookie}`.split(`; ${name}=`);
    return parts.length === 2 ? parts.pop().split(';').shift() : null;
  } catch {
    // Sandboxed document (no allow-same-origin flag) throws on document.cookie —
    // treat as logged-out so the suite still boots (off-host / Pending importer).
    return null;
  }
};

export const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
export const fmtDelta = (n) => {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmt(n)}`;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// crypto RNG (jitter only) — equivalent to Math.random here
export const randInt = (min, max) => {
  const fraction = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return min + Math.floor(fraction * (max - min + 1));
};

export const uid = (() => {
  let counter = 0;
  return () => `a${Date.now().toString(36)}${counter++}`;
})();

export const fmtAgo = (ts) => {
  if (!ts) return 'never';

  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(ts).toLocaleDateString();
};

export const fmtDate = (ts) => {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
};

export const fmtCountdown = (ms) => {
  if (ms <= 0) return 'now';

  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
};

export const byId = (list) => Object.fromEntries((list || []).map((u) => [u.id, u]));

// The username of the profile page you're standing on, '' anywhere else.
// Instagram's own routes live at the same depth, hence the reserved list.
const RESERVED = new Set(['explore', 'reels', 'reel', 'direct', 'stories', 'p', 'tv', 'accounts', 'about', 'developer', 'legal', 'directory', 'lite', 'session', 'graphql', 'api', 'your_activity', 'emails', 'challenge', 'privacy', 'web']);
export const detectUsername = () => {
  const match = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
  return match && !RESERVED.has(match[1].toLowerCase()) ? match[1] : '';
};
