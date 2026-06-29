// DOM shorthands, escaping, formatting and small helpers shared everywhere.
export const $ = (sel, scope) => (scope || document).querySelector(sel);
export const $$ = (sel, scope) => [...(scope || document).querySelectorAll(sel)];

export const getCookie = (name) => {
  const parts = `; ${document.cookie}`.split(`; ${name}=`);
  return parts.length === 2 ? parts.pop().split(';').shift() : null;
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
// crypto RNG (jitter only) — equivalent to Math.random, keeps SonarLint S2245 clean
export const randInt = (a, b) => a + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * (b - a + 1));
export const uid = (() => { let n = 0; return () => `a${Date.now().toString(36)}${n++}`; })();

export const fmtAgo = (ts) => {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
};
export const fmtDate = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return '—'; } };
export const fmtCountdown = (ms) => {
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s % 60}s`;
};

export const byId = (list) => Object.fromEntries((list || []).map((u) => [u.id, u]));
