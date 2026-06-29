// Shared UI fragments: avatars, badges, profile links, toasts, the scan overlay
// (with optional Lottie enhancement) and the pure-SVG growth chart.
import { esc, $ } from '../core/utils.js';
import { app } from '../core/state.js';

export const avatar = (u) => {
  const letter = esc((u.username || '?').charAt(0).toUpperCase());
  return u.picUrl
    ? `<img class="av" loading="lazy" src="${esc(u.picUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'av',textContent:'${letter}'}))">`
    : `<div class="av">${letter}</div>`;
};
export const badge = (label, cls = '') => `<span class="badge ${cls}">${esc(label)}</span>`;
export const profileLink = (username) => `<a href="https://www.instagram.com/${encodeURIComponent(username)}/" target="_blank" rel="noreferrer">@${esc(username)}</a>`;

export const toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'igs-toast';
  t.textContent = msg;
  app.root.appendChild(t);
  setTimeout(() => t.remove(), 4200);
};

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
const tryLottie = (container, cssFallback) => {
  const mount = () => {
    try {
      const anim = globalThis.lottie.loadAnimation({ container, renderer: 'svg', loop: true, autoplay: true, animationData: LOTTIE_RING });
      anim.addEventListener('DOMLoaded', () => { if (cssFallback) cssFallback.style.opacity = '0'; });
    } catch { /* keep CSS fallback */ }
  };
  try {
    if (globalThis.lottie?.loadAnimation) return mount();
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/lottie-web@5.12.2/build/player/lottie_light.min.js';
    s.onload = mount;
    s.onerror = () => { /* CSP/offline: CSS radar stays */ };
    document.head.appendChild(s);
  } catch { /* keep CSS fallback */ }
};
// Generic scan overlay used by Ledger + Followers
export const scanOverlay = (label) => {
  const el = document.createElement('div');
  el.className = 'scan';
  el.innerHTML =
    '<div class="radar"><div class="lot"></div><div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="sweep"></div></div>' +
    '<div class="pct" data-pct>0%</div><div class="bar"><i data-prog></i></div>' +
    `<div class="st" data-st>${esc(label || 'Starting…')}</div>` +
    '<button class="ghost" data-cancel style="margin-top:20px">Cancel</button>';
  app.root.appendChild(el);
  tryLottie($('.lot', el), $('.radar', el));
  return el;
};

// Growth chart (pure SVG, no deps)
export const chartSVG = (timeline) => {
  if (!timeline || timeline.length < 2) return '<div class="empty">Growth chart appears after your second scan.</div>';
  const W = 1000, H = 200, pad = { l: 8, r: 8, t: 14, b: 22 };
  const xs = timeline.map((p) => p.ts);
  const ys = timeline.flatMap((p) => [p.f, p.g]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  if (maxY === minY) maxY = minY + 1;
  const sx = (t) => pad.l + (maxX === minX ? 0 : (t - minX) / (maxX - minX)) * (W - pad.l - pad.r);
  const sy = (v) => pad.t + (1 - (v - minY) / (maxY - minY)) * (H - pad.t - pad.b);
  const path = (key) => timeline.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)} ${sy(p[key]).toFixed(1)}`).join(' ');
  const fArea = `${path('f')} L${sx(maxX).toFixed(1)} ${H - pad.b} L${sx(minX).toFixed(1)} ${H - pad.b} Z`;
  const dots = timeline.map((p) => `<circle cx="${sx(p.ts).toFixed(1)}" cy="${sy(p.f).toFixed(1)}" r="2.5" fill="#111"/>`).join('');
  const first = timeline[0], last = timeline[timeline.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" stroke="#e3e3e3"/>` +
    `<path d="${fArea}" fill="#f6f6f6"/><path d="${path('g')}" fill="none" stroke="#bbb" stroke-width="2"/>` +
    `<path d="${path('f')}" fill="none" stroke="#e4002b" stroke-width="2.5"/>${dots}` +
    `<text x="${pad.l}" y="14" font-family="monospace" font-size="11" fill="#6b6b6b">${new Date(first.ts).toLocaleDateString()}</text>` +
    `<text x="${W - pad.r}" y="14" text-anchor="end" font-family="monospace" font-size="11" fill="#6b6b6b">${new Date(last.ts).toLocaleDateString()}</text></svg>`;
};
