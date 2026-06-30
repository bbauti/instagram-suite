// Shared UI fragments: avatars, badges, profile links (lit templates), toasts,
// the scan overlay (with optional Lottie enhancement) and the pure-SVG growth
// chart. toast/scanOverlay stay imperative (transient nodes outside any tool's
// declarative tree); chartSVG stays a string builder (injected via unsafeHTML).
import { html } from 'lit-html';
import { esc, $ } from '../core/utils.js';
import { app } from '../core/state.js';

// ── inline templates: avatar / badge / profile link ─────────────────────────

// ponytail: @error swaps the broken <img> for a letter <div> imperatively, which
// detaches the node from lit's part. The avatar-bearing lists (ledger rows,
// followers cards) are keyed with repeat() by user id, so each user's avatar node
// stays stable and a swapped node is never recycled onto a different user.
const onAvatarErr = (letter) => (event) =>
  event.target.replaceWith(Object.assign(document.createElement('div'), { className: 'av', textContent: letter }));

export const avatar = (user) => {
  const letter = (user.username || '?').charAt(0).toUpperCase();
  return user.picUrl
    ? html`<img class="av" loading="lazy" src=${user.picUrl} alt="" @error=${onAvatarErr(letter)}>`
    : html`<div class="av">${letter}</div>`;
};

export const badge = (label, cls = '') => html`<span class="badge ${cls}">${label}</span>`;

export const profileLink = (username) => html`<a href="https://www.instagram.com/${encodeURIComponent(username)}/" target="_blank" rel="noreferrer">@${username}</a>`;

// ── toast ────────────────────────────────────────────────────────────────────
export const toast = (msg) => {
  const toastEl = document.createElement('div');
  toastEl.className = 'igs-toast';
  toastEl.textContent = msg;
  app.root.appendChild(toastEl);
  setTimeout(() => toastEl.remove(), 4200);
};

// ── scan overlay: CSS radar + optional Lottie ring ───────────────────────────

// Lottie scan animation (progressive enhancement over the CSS radar)
const LOTTIE_RING = {
  v: '5.9.0', fr: 60, ip: 0, op: 120, w: 120, h: 120, nm: 'scan', ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: 'ring', sr: 1,
    ks: { o: { a: 0, k: 100 }, r: { a: 1, k: [{ t: 0, s: [0] }, { t: 120, s: [360] }] }, p: { a: 0, k: [60, 60, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
    shapes: [{ ty: 'gr', it: [
      { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [86, 86] } },
      { ty: 'st', c: { a: 0, k: [0.894, 0, 0.168, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 6 }, lc: 2, lj: 2 },
      { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [15] }, { t: 60, s: [85] }, { t: 120, s: [15] }] }, o: { a: 0, k: 0 }, m: 1 },
      { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ] }],
    ip: 0, op: 120, st: 0, bm: 0,
  }],
};

// Load lottie-web (cached or lazily injected) and mount the ring over the CSS
// radar; any failure just leaves the CSS fallback in place.
const tryLottie = (container, cssFallback) => {
  const mount = () => {
    try {
      const animation = globalThis.lottie.loadAnimation({ container, renderer: 'svg', loop: true, autoplay: true, animationData: LOTTIE_RING });
      animation.addEventListener('DOMLoaded', () => { if (cssFallback) cssFallback.style.opacity = '0'; });
    } catch { /* keep CSS fallback */ }
  };

  try {
    if (globalThis.lottie?.loadAnimation) return mount();

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/lottie-web@5.12.2/build/player/lottie_light.min.js';
    script.onload = mount;
    script.onerror = () => { /* CSP/offline: CSS radar stays */ };
    document.head.appendChild(script);
  } catch { /* keep CSS fallback */ }
};

// Generic scan overlay used by Ledger + Followers
export const scanOverlay = (label) => {
  const overlay = document.createElement('div');
  overlay.className = 'scan';
  overlay.innerHTML =
    '<div class="radar"><div class="lot"></div><div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="sweep"></div></div>' +
    '<div class="pct" data-pct>0%</div><div class="bar"><i data-prog></i></div>' +
    `<div class="st" data-st>${esc(label || 'Starting…')}</div>` +
    '<button class="ghost" data-cancel style="margin-top:20px">Cancel</button>';
  app.root.appendChild(overlay);
  tryLottie($('.lot', overlay), $('.radar', overlay));
  return overlay;
};

// ── growth chart: pure SVG, no deps ──────────────────────────────────────────
export const chartSVG = (timeline) => {
  if (!timeline || timeline.length < 2) return '<div class="empty">Growth chart appears after your second scan.</div>';

  // viewBox dimensions + inner padding (left / right / top / bottom).
  const width = 1000, height = 200, pad = { l: 8, r: 8, t: 14, b: 22 };

  // Data ranges: x axis = timestamps, y axis = follower (f) + following (g) counts.
  const timestamps = timeline.map((point) => point.ts);
  const values = timeline.flatMap((point) => [point.f, point.g]);
  const minTs = Math.min(...timestamps), maxTs = Math.max(...timestamps), minVal = Math.min(...values);
  let maxVal = Math.max(...values);
  if (maxVal === minVal) maxVal = minVal + 1;

  // Project a timestamp / value into SVG coordinate space.
  const scaleX = (ts) => pad.l + (maxTs === minTs ? 0 : (ts - minTs) / (maxTs - minTs)) * (width - pad.l - pad.r);
  const scaleY = (value) => pad.t + (1 - (value - minVal) / (maxVal - minVal)) * (height - pad.t - pad.b);

  // Build the polyline path for one series key ('f' followers, 'g' following).
  const linePath = (key) => timeline.map((point, i) => `${i ? 'L' : 'M'}${scaleX(point.ts).toFixed(1)} ${scaleY(point[key]).toFixed(1)}`).join(' ');
  const followerArea = `${linePath('f')} L${scaleX(maxTs).toFixed(1)} ${height - pad.b} L${scaleX(minTs).toFixed(1)} ${height - pad.b} Z`;
  const dotMarkers = timeline.map((point) => `<circle cx="${scaleX(point.ts).toFixed(1)}" cy="${scaleY(point.f).toFixed(1)}" r="2.5" fill="#111"/>`).join('');

  const firstPoint = timeline[0], lastPoint = timeline[timeline.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    `<line x1="${pad.l}" y1="${height - pad.b}" x2="${width - pad.r}" y2="${height - pad.b}" stroke="#e3e3e3"/>` +
    `<path d="${followerArea}" fill="#f6f6f6"/><path d="${linePath('g')}" fill="none" stroke="#bbb" stroke-width="2"/>` +
    `<path d="${linePath('f')}" fill="none" stroke="#e4002b" stroke-width="2.5"/>${dotMarkers}` +
    `<text x="${pad.l}" y="14" font-family="monospace" font-size="11" fill="#6b6b6b">${new Date(firstPoint.ts).toLocaleDateString()}</text>` +
    `<text x="${width - pad.r}" y="14" text-anchor="end" font-family="monospace" font-size="11" fill="#6b6b6b">${new Date(lastPoint.ts).toLocaleDateString()}</text></svg>`;
};
