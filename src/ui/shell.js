// Module registry + SPA shell: the top nav, the mounted-tool swap, the global
// queue panel (fixed bottom bar) and teardown. `setModules` receives the tool
// list from main; the queue's `onChange`/`onTick` hooks are wired here so the
// panel redraws as actions run.
import { app } from '../core/state.js';
import { $, $$, esc, fmt, fmtCountdown } from '../core/utils.js';
import { api } from '../core/api.js';
import { queue, SPEEDS, KIND_VERB } from '../core/queue.js';

let modules = [];
export const setModules = (mods) => { modules = mods; };

export const mountModule = (id) => {
  const mod = modules.find((m) => m.id === id);
  if (!mod || app.active?.id === id) return;
  app.active?.unmount?.();
  app.active = mod;
  $$('.nav button', app.root).forEach((b) => b.classList.toggle('on', b.dataset.mod === id));
  app.view.innerHTML = '';
  mod.mount(app.view);
};

export const renderShell = () => {
  const navHTML = modules.map((m) => `<button data-mod="${m.id}">${esc(m.label)}</button>`).join('');
  app.root.innerHTML =
    '<div class="wrap">' +
      '<div class="top">' +
        '<div class="brand">Instagram<b>Suite</b></div>' +
        `<div class="nav">${navHTML}</div>` +
        '<div class="spacer"></div>' +
        `<div class="who">viewer #${esc(api.viewerId || '—')}${api.loggedIn ? '' : '<br>⚠ not on instagram.com'}</div>` +
        '<button class="iconbtn" data-close title="Close">✕</button>' +
      '</div>' +
      '<div id="igs-view"></div>' +
    '</div>';
  app.view = $('#igs-view', app.root);
  $('[data-close]', app.root).onclick = () => teardown();
  $$('.nav button', app.root).forEach((b) => { b.onclick = () => mountModule(b.dataset.mod); });
};

// ---- global queue panel (shell-level) --------------------------------------
const queueNextText = () => {
  const c = queue.summary();
  if (Date.now() < queue.rateLimitedUntil) return `Rate-limited — auto-resume in ${Math.ceil((queue.rateLimitedUntil - Date.now()) / 60000)}m`;
  if (queue.paused) return `Paused — ${c.pending} waiting`;
  if (queue._busy) {
    const r = queue.items.find((i) => i.status === 'running');
    return `${KIND_VERB[r?.kind] || 'Working'} @${r?.username || ''}…`;
  }
  if (c.pending) return `Next in ${fmtCountdown(Math.max(0, queue.cooldownUntil - Date.now()))} · ETA ${fmtCountdown(queue.etaMs())}`;
  return c.failed ? `Finished — ${c.failed} failed` : 'All done';
};
const queueBarPct = () => { const t = queue.items.length; return t ? Math.round(queue.summary().done / t * 100) : 0; };
export const renderQueuePanel = () => {
  if (!app.root) return;
  let el = $('#igs-queue', app.root);
  if (!queue.items.length) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'igs-queue'; app.root.appendChild(el); }
  const c = queue.summary(), total = queue.items.length;
  const failedTxt = c.failed ? ` · ${c.failed} failed` : '';
  el.className = `qpanel${Date.now() < queue.rateLimitedUntil ? ' rl' : ''}`;
  const speedOpts = Object.entries(SPEEDS).map(([k, sp]) => `<option value="${k}"${queue.speedKey === k ? ' selected' : ''}>${esc(sp.label)}</option>`).join('');
  el.innerHTML =
    `<div class="qstat"><b>${fmt(c.done)}</b>/${fmt(total)} done${failedTxt}</div>` +
    `<div class="qbar"><i style="width:${queueBarPct()}%"></i></div>` +
    `<div class="qnext" data-qnext>${esc(queueNextText())}</div>` +
    `<select data-qspeed>${speedOpts}</select>` +
    (queue.paused ? '<button class="primary" data-q="resume">Resume</button>' : '<button data-q="pause">Pause</button>') +
    '<button data-q="cancel">Cancel pending</button>' +
    (c.done || c.failed ? '<button data-q="clear">Clear done</button>' : '');
  $$('[data-q]', el).forEach((b) => { b.onclick = () => qAction(b.dataset.q); });
  const sp = $('[data-qspeed]', el);
  if (sp) sp.onchange = () => { queue.speedKey = sp.value; queue.persist(); renderQueuePanel(); };
};
const qAction = (a) => {
  if (a === 'pause') queue.pause();
  else if (a === 'resume') queue.resume();
  else if (a === 'cancel') { if (confirm('Cancel all pending actions? (in-flight one finishes)')) queue.cancelPending(); }
  else if (a === 'clear') queue.clearFinished();
};
const onQueueTick = () => {
  const el = $('#igs-queue', app.root);
  if (!el || !queue.items.length) return;
  const nb = $('[data-qnext]', el); if (nb) nb.textContent = queueNextText();
  const bar = el.querySelector('.qbar i'); if (bar) bar.style.width = `${queueBarPct()}%`;
};
const onQueueChange = () => { app.active?.onQueueChange?.(); renderQueuePanel(); };
queue.onChange = onQueueChange;
queue.onTick = onQueueTick;

export const teardown = () => {
  queue.stop();
  app.active?.unmount?.();
  app.root?.remove();
  document.getElementById('igs-style')?.remove();
};
