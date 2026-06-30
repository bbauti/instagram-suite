// Module registry + SPA shell: the top nav, the mounted-tool swap, the global
// queue panel (fixed bottom bar) and teardown. Rendered with lit-html into a few
// independent render roots: the chrome is rendered once into `app.root`; each
// tool renders into `#igs-view`; the queue panel renders into its own `#igs-queue`
// node. `setModules` receives the tool list from main; the queue's
// `onChange`/`onTick` hooks are wired here so the panel redraws as actions run.
import { html, render, nothing } from 'lit-html';
import { app } from '../core/state.js';
import { $, $$, fmt, fmtCountdown } from '../core/utils.js';
import { api } from '../core/api.js';
import { queue, SPEEDS, KIND_VERB } from '../core/queue.js';

// ── module registry ──────────────────────────────────────────────────────────
let modules = [];
export const setModules = (mods) => { modules = mods; };

export const mountModule = (id) => {
  const mod = modules.find((entry) => entry.id === id);
  if (!mod || app.active?.id === id) return;

  app.active?.unmount?.();
  app.active = mod;
  $$('.nav button', app.root).forEach((button) => button.classList.toggle('on', button.dataset.mod === id));
  render(nothing, app.view); // drop the previous tool's lit content
  mod.mount(app.view);
};

// ── shell chrome ──────────────────────────────────────────────────────────────
// Chrome is rendered once; the nav `.on` class is toggled imperatively by
// mountModule (no need to re-render the whole shell to flip one class).
const navTpl = () => html`<div class="nav">${modules.map((mod) => html`<button data-mod=${mod.id} @click=${() => mountModule(mod.id)}>${mod.label}</button>`)}</div>`;

const whoTpl = () => html`<div class="who">viewer #${api.viewerId || '—'}${api.loggedIn ? nothing : html`<br>⚠ not on instagram.com`}</div>`;

export const renderShell = () => {
  render(html`
    <div class="wrap">
      <div class="top">
        <div class="brand">Instagram<b>Suite</b></div>
        ${navTpl()}
        <div class="spacer"></div>
        ${whoTpl()}
        <button class="iconbtn" title="Close" @click=${() => teardown()}>✕</button>
      </div>
      <div id="igs-view"></div>
    </div>
  `, app.root);
  app.view = $('#igs-view', app.root);
};

// ── global queue panel (shell-level) ─────────────────────────────────────────

// One-line status describing what the queue is doing right now.
const queueNextText = () => {
  const summary = queue.summary();

  if (Date.now() < queue.rateLimitedUntil) {
    return `Rate-limited — auto-resume in ${Math.ceil((queue.rateLimitedUntil - Date.now()) / 60000)}m`;
  }
  if (queue.paused) return `Paused — ${summary.pending} waiting`;
  if (queue._busy) {
    const running = queue.items.find((item) => item.status === 'running');
    return `${KIND_VERB[running?.kind] || 'Working'} @${running?.username || ''}…`;
  }
  if (summary.pending) {
    return `Next in ${fmtCountdown(Math.max(0, queue.cooldownUntil - Date.now()))} · ETA ${fmtCountdown(queue.etaMs())}`;
  }
  return summary.failed ? `Finished — ${summary.failed} failed` : 'All done';
};

const queueBarPct = () => {
  const total = queue.items.length;
  return total ? Math.round(queue.summary().done / total * 100) : 0;
};

const onSpeedChange = (event) => {
  queue.speedKey = event.target.value;
  queue.persist();
  renderQueuePanel();
};

const speedSelectTpl = () => html`<select @change=${onSpeedChange}>${Object.entries(SPEEDS).map(([key, speed]) => html`<option value=${key} ?selected=${queue.speedKey === key}>${speed.label}</option>`)}</select>`;

const queuePanelTpl = () => {
  const summary = queue.summary();
  const total = queue.items.length;
  const failedTxt = summary.failed ? ` · ${summary.failed} failed` : '';
  return html`
    <div class="qstat"><b>${fmt(summary.done)}</b>/${fmt(total)} done${failedTxt}</div>
    <div class="qbar"><i></i></div>
    <div class="qnext" data-qnext></div>
    ${speedSelectTpl()}
    ${queue.paused
      ? html`<button class="primary" @click=${() => qAction('resume')}>Resume</button>`
      : html`<button @click=${() => qAction('pause')}>Pause</button>`}
    <button @click=${() => qAction('cancel')}>Cancel pending</button>
    ${summary.done || summary.failed ? html`<button @click=${() => qAction('clear')}>Clear done</button>` : nothing}`;
};

export const renderQueuePanel = () => {
  if (!app.root) return;

  let panel = $('#igs-queue', app.root);
  if (!queue.items.length) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'igs-queue';
    app.root.appendChild(panel);
  }

  panel.className = `qpanel${Date.now() < queue.rateLimitedUntil ? ' rl' : ''}`;
  render(queuePanelTpl(), panel);
  onQueueTick(); // sole writer of the qnext text + bar width; populates immediately
};

const qAction = (action) => {
  if (action === 'pause') {
    queue.pause();
  } else if (action === 'resume') {
    queue.resume();
  } else if (action === 'cancel') {
    if (confirm('Cancel all pending actions? (in-flight one finishes)')) queue.cancelPending();
  } else if (action === 'clear') {
    queue.clearFinished();
  }
};

// Cheap per-tick update: only the countdown text + bar width, so the speed
// <select> is never re-rendered mid-interaction.
const onQueueTick = () => {
  const panel = $('#igs-queue', app.root);
  if (!panel || !queue.items.length) return;

  const qnextEl = $('[data-qnext]', panel);
  if (qnextEl) qnextEl.textContent = queueNextText();

  const barEl = panel.querySelector('.qbar i');
  if (barEl) barEl.style.width = `${queueBarPct()}%`;
};

const onQueueChange = () => {
  app.active?.onQueueChange?.();
  renderQueuePanel();
};
queue.onChange = onQueueChange;
queue.onTick = onQueueTick;

// ── teardown ──────────────────────────────────────────────────────────────────
export const teardown = () => {
  queue.stop();
  app.active?.unmount?.();
  app.root?.remove();
  document.getElementById('igs-style')?.remove();
};
