// Global action queue — ONE paced/rate-limit-safe queue for every tool.
// Modules register a handler per `kind` ({ run, onDone?, onFail? }); the engine
// owns pacing, exponential backoff, rate-limit pause/auto-resume and
// persistence (survives refresh). The shell wires `onChange`/`onTick` to redraw
// the queue panel — they default to no-ops so the queue has no UI dependency.
import { store } from './store.js';
import { uid, randInt } from './utils.js';
import { RateLimit, ApiError } from './api.js';

const QKEY = 'igs-queue';
export const SPEEDS = {
  safe: { min: 45000, max: 90000, label: 'Safe · 45–90s' },
  normal: { min: 25000, max: 50000, label: 'Normal · 25–50s' },
  fast: { min: 12000, max: 25000, label: 'Fast · 12–25s ⚠' },
};
const MAX_RETRIES = 4;
const RL_WAIT_MS = 10 * 60 * 1000;
export const KIND_VERB = { unfollow: 'Unfollowing', follow: 'Following', cancel: 'Cancelling', verify: 'Checking', 'fm-follow': 'Following', 'fm-unfollow': 'Unfollowing' };

export const queue = {
  items: [], paused: false, cooldownUntil: 0, rateLimitedUntil: 0, speedKey: 'safe',
  _busy: false, _timer: null, handlers: {},
  onChange: () => {}, onTick: () => {},

  register(kind, handler) { this.handlers[kind] = handler; },
  load() {
    const s = store.get(QKEY, null);
    if (!s || !Array.isArray(s.items)) return;
    this.items = s.items; this.paused = !!s.paused;
    this.cooldownUntil = s.cooldownUntil || 0; this.speedKey = s.speedKey || 'safe';
    this.items.forEach((i) => { if (i.status === 'running') { i.status = 'pending'; i.nextRunAt = Date.now() + randInt(4000, 12000); } });
  },
  persist() { store.save(QKEY, { items: this.items, paused: this.paused, cooldownUntil: this.cooldownUntil, speedKey: this.speedKey }); },
  speed() { return SPEEDS[this.speedKey] || SPEEDS.safe; },
  statusOf(userId, kind) {
    const it = this.items.find((i) => i.userId === userId && (!kind || i.kind === kind));
    return it?.status ?? null;
  },
  summary() {
    const c = { pending: 0, running: 0, done: 0, failed: 0 };
    this.items.forEach((i) => { c[i.status] = (c[i.status] || 0) + 1; });
    return c;
  },
  add(item) {
    if (this.items.some((i) => i.userId === item.userId && i.kind === item.kind && i.status !== 'failed')) return false;
    this.items.push({ id: uid(), status: 'pending', attempts: 0, nextRunAt: Date.now(), ...item });
    return true;
  },
  enqueue(items) {
    const added = items.reduce((acc, it) => acc + (this.add(it) ? 1 : 0), 0);
    if (added) { this.paused = false; this.persist(); this.start(); this.changed(); }
    return added;
  },
  removeItem(id) { this.items = this.items.filter((i) => i.id !== id || i.status === 'running'); this.persist(); this.changed(); },
  cancelPending() { this.items = this.items.filter((i) => i.status === 'running' || i.status === 'done'); this.persist(); this.changed(); },
  clearFinished() { this.items = this.items.filter((i) => i.status === 'pending' || i.status === 'running'); this.persist(); this.changed(); },
  retryItem(id) {
    const it = this.items.find((i) => i.id === id);
    if (it && it.status === 'failed') { it.status = 'pending'; it.attempts = 0; it.nextRunAt = Date.now(); it.error = undefined; this.persist(); this.start(); this.changed(); }
  },
  pause() { this.paused = true; this.persist(); this.changed(); },
  resume() { this.paused = false; this.rateLimitedUntil = 0; this.persist(); this.start(); this.changed(); },
  start() { if (!this._timer) this._timer = setInterval(() => this.tick(), 1000); },
  stop() { if (this._timer) { clearInterval(this._timer); } this._timer = null; },
  etaMs() {
    const pending = this.summary().pending;
    if (!pending) return 0;
    const sp = this.speed();
    return Math.max(0, this.cooldownUntil - Date.now()) + pending * (sp.min + sp.max) / 2;
  },
  changed() { this.onChange(); },

  async tick() {
    this.onTick();
    if (this.rateLimitedUntil && Date.now() >= this.rateLimitedUntil) {
      this.rateLimitedUntil = 0;
      if (this.paused) { this.paused = false; this.persist(); this.changed(); }
    }
    if (this._busy || this.paused) return;
    const now = Date.now();
    if (now < this.cooldownUntil || now < this.rateLimitedUntil) return;
    const item = this.items.find((i) => i.status === 'pending' && i.nextRunAt <= now);
    if (!item) return;
    const handler = this.handlers[item.kind];
    if (!handler) { item.status = 'failed'; item.error = 'no handler'; this.persist(); this.changed(); return; }

    this._busy = true; item.status = 'running'; item.attempts += 1; this.persist(); this.changed();
    try {
      const res = await handler.run(item);
      item.status = 'done';
      handler.onDone?.(item, res);
    } catch (err) {
      if (err instanceof RateLimit) this._onRateLimit(item);
      else this._onFailure(item, err, handler);
    } finally {
      const sp = this.speed();
      this.cooldownUntil = Date.now() + randInt(sp.min, sp.max);
      this._busy = false; this.persist(); this.changed();
    }
  },
  _onFailure(item, err, handler) {
    item.error = String(err?.message || err);
    if (err instanceof ApiError && err.status === 404) { item.status = 'failed'; }
    else if (item.attempts >= MAX_RETRIES) { item.status = 'failed'; }
    else { item.status = 'pending'; item.nextRunAt = Date.now() + Math.min(16, 2 ** (item.attempts - 1)) * 60000; }
    if (item.status === 'failed') handler.onFail?.(item, err);
  },
  _onRateLimit(item) {
    item.status = 'pending'; item.attempts = Math.max(0, item.attempts - 1);
    item.nextRunAt = Date.now() + RL_WAIT_MS;
    this.paused = true; this.rateLimitedUntil = Date.now() + RL_WAIT_MS;
  },
};
