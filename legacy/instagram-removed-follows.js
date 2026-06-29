/* ============================================================================
 *  Instagram Follower Ledger — scan, diff & dashboard
 * ----------------------------------------------------------------------------
 *  A self-contained, dependency-free overlay you paste into the browser
 *  console. It scans your CURRENT followers (and who you follow), stores a
 *  snapshot, and on the next scan shows exactly what changed:
 *    • new followers            (people who started following you)
 *    • removed follows          (people who unfollowed you)
 *    • don't-follow-you-back    (you follow them, they don't follow you)
 *    • fans                     (they follow you, you don't follow back)
 *    • mutuals, verified, private, follow ratio, growth-over-time chart,
 *      and a persistent activity feed of every gain/loss across all scans.
 *  Plus a paced, persistent UNFOLLOW queue on the Following / Mutuals /
 *  Don't-follow-back tabs (select + batch, one at a time, refresh-safe).
 *
 *  Builds on the same techniques as:
 *    /instagramfollowaccount  (GraphQL query_hash pagination + ActionQueue)
 *    /InstagramUnfollowers     (edge_follow non-follower detection, getCookie)
 *    /instagrampendingreqs     (api/v1 friendships endpoints, rate-limit guard)
 *
 *  Design: Müller-Brockmann International Typographic Style — white paper,
 *  near-black ink, one accent (Swiss red). Big numerals, mono labels, a
 *  strict modular grid. UX laws baked in (AA contrast, 44px targets, 1.5
 *  body line-height, left-aligned). Optional Lottie scan animation with a
 *  CSS radar fallback when Instagram's CSP blocks the CDN.
 *
 *  USAGE
 *    1. Open https://www.instagram.com/ in Chrome, logged in.
 *    2. DevTools → Console. If asked, type: allow pasting
 *    3. Paste this whole file, press Enter. Click "Scan now".
 *    4. Come back later, run it again, hit "Scan now" → see what changed.
 *
 *  Nothing leaves your browser. All data lives in localStorage on this device.
 * ========================================================================== */

(() => {
  'use strict';

  // --- re-run: tear down a previous instance ---------------------------------
  document.getElementById('igrf-root')?.remove();
  document.getElementById('igrf-style')?.remove();

  // ==========================================================================
  // Constants  (query hashes are the InstagramUnfollowers / followaccount set)
  // ==========================================================================
  const HOST = 'www.instagram.com';
  const IG_APP_ID = '936619743392459';
  const PAGE_SIZE = 48;

  const LIST = {
    followers: { hash: 'c76146de99bb02f6415203be841dd25a', edge: 'edge_followed_by', api: 'followers' },
    following: { hash: '3dec7e2c57367ef3da3d987d89f9dbc8', edge: 'edge_follow', api: 'following' },
  };

  const K = { current: 'igrf-current', previous: 'igrf-previous', timeline: 'igrf-timeline', events: 'igrf-events' };

  const EVENTS_LIMIT = 1500;
  const TIMELINE_LIMIT = 300;
  const ROW_CAP = 600; // ponytail: cap rendered rows; search still filters the full set

  const RATE_LIMIT_RE = [
    /try again later/i, /wait a few minutes/i, /feedback[_ ]required/i,
    /checkpoint[_ ]required/i, /action blocked/i, /rate[_ ]?limit/i, /\bspam\b/i,
  ];

  // ==========================================================================
  // Utils
  // ==========================================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const getCookie = (name) => { // InstagramUnfollowers utils.ts
    const parts = `; ${document.cookie}`.split(`; ${name}=`);
    return parts.length === 2 ? parts.pop().split(';').shift() : null;
  };
  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
  const fmtDelta = (n) => {
    if (!Number.isFinite(n)) return '—';
    return `${n > 0 ? '+' : ''}${fmt(n)}`;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // crypto RNG (delay jitter only) — equivalent to Math.random but keeps SonarLint S2245 clean
  const randInt = (a, b) => a + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * (b - a + 1));
  const fmtAgo = (ts) => {
    if (!ts) return 'never';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  };
  const fmtDate = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return '—'; } };
  const fmtCountdown = (ms) => {
    if (ms <= 0) return 'now';
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s % 60}s`;
  };

  // ==========================================================================
  // Storage  (localStorage; degrades to compact records on quota — ponytail:
  // localStorage ceiling ~5MB, two full snapshots. Move to IndexedDB only if a
  // very large account actually overflows the compact fallback.)
  // ==========================================================================
  const store = {
    get(key, dflt) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; }
      catch { return dflt; }
    },
    setRaw(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); },
    save(key, obj) {
      try { this.setRaw(key, obj); return true; }
      catch {
        // quota: retry with compact user records (drop pics + names)
        try {
          const compact = structuredClone(obj);
          for (const k of ['followers', 'following']) {
            if (Array.isArray(compact[k])) {
              compact[k] = compact[k].map((u) => ({ id: u.id, username: u.username, isVerified: u.isVerified, isPrivate: u.isPrivate }));
            }
          }
          compact._compact = true;
          this.setRaw(key, compact);
          return true;
        } catch { return false; }
      }
    },
  };

  // ==========================================================================
  // Instagram API  (followaccount InstagramAPI, trimmed to what we need)
  // ==========================================================================
  class RateLimit extends Error {
    constructor(detail) { super('Instagram rate limit / action block'); this.name = 'RateLimit'; this.detail = detail; }
  }

  const api = {
    viewerId: getCookie('ds_user_id'),
    csrf: getCookie('csrftoken'),
    appHeaders() { return { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }; },
    // Shared response handling: parse JSON, detect soft-blocks, surface errors.
    async _fetch(url, opts) {
      const res = await fetch(url, opts);
      const body = await res.json().catch(() => null);
      const text = body ? JSON.stringify(body) : '';
      const flagged = res.status === 429 ||
        body?.feedback_required || body?.spam || body?.checkpoint_url ||
        RATE_LIMIT_RE.some((re) => re.test(text));
      if (flagged) throw new RateLimit(body?.feedback_message || body?.message || `HTTP ${res.status}`);
      if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
      return body;
    },
    request(url) { return this._fetch(url, { credentials: 'include', mode: 'cors', headers: this.appHeaders() }); },
    // POST a friendship action (destroy = unfollow). api/v1 first, legacy /web
    // fallback — the followaccount _friendshipPost / InstagramUnfollowers technique.
    async friendshipPost(primary, fallback) {
      if (!this.csrf) throw new Error('No csrftoken cookie — are you logged in?');
      const opts = {
        method: 'POST', credentials: 'include', mode: 'cors',
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': this.csrf },
      };
      try { return await this._fetch(primary, opts); }
      catch (err) { if (err instanceof RateLimit) { throw err; } return this._fetch(fallback, opts); }
    },
    unfollow(userId) {
      return this.friendshipPost(
        `https://${HOST}/api/v1/friendships/destroy/${userId}/`,
        `https://${HOST}/web/friendships/${userId}/unfollow/`,
      );
    },
    mapGraph(n) {
      return {
        id: String(n.id), username: n.username, fullName: n.full_name || '',
        picUrl: n.profile_pic_url || '', isPrivate: !!n.is_private, isVerified: !!n.is_verified,
      };
    },
    mapApi(u) {
      return {
        id: String(u.pk ?? u.pk_id), username: u.username, fullName: u.full_name || '',
        picUrl: u.profile_pic_url || '', isPrivate: !!u.is_private, isVerified: !!u.is_verified,
      };
    },
    // One page of followers|following. GraphQL first, api/v1 fallback.
    async page(kind, after) {
      const spec = LIST[kind];
      const vars = { id: this.viewerId, include_reel: false, fetch_mutual: false, first: PAGE_SIZE };
      if (after) vars.after = after;
      const url = `https://${HOST}/graphql/query/?query_hash=${spec.hash}&variables=${encodeURIComponent(JSON.stringify(vars))}`;
      try {
        const body = await this.request(url);
        const edge = body?.data?.user?.[spec.edge];
        if (!edge) throw new Error('bad graphql payload');
        return {
          users: (edge.edges || []).map((e) => this.mapGraph(e.node)),
          next: edge.page_info?.has_next_page ? edge.page_info.end_cursor : null,
          total: edge.count ?? null,
        };
      } catch (err) {
        if (err instanceof RateLimit) throw err;
        return this.pageApi(kind, after);
      }
    },
    async pageApi(kind, after) {
      const spec = LIST[kind];
      const maxId = after ? `&max_id=${encodeURIComponent(after)}` : '';
      const url = `https://${HOST}/api/v1/friendships/${this.viewerId}/${spec.api}/?count=${PAGE_SIZE}${maxId}`;
      const body = await this.request(url);
      if (!Array.isArray(body?.users)) throw new Error('bad api/v1 payload');
      return { users: body.users.map((u) => this.mapApi(u)), next: body.next_max_id || null, total: null };
    },
  };

  // Paginate one whole list with human-like pacing + progress callback.
  const scanList = async (kind, onProgress) => {
    const users = [], seen = new Set();
    let after = null, total = null, pages = 0;
    for (;;) {
      const res = await api.page(kind, after);
      if (res.total != null) total = res.total;
      for (const u of res.users) if (!seen.has(u.id)) { seen.add(u.id); users.push(u); }
      pages += 1;
      onProgress(kind, users.length, total);
      after = res.next;
      if (!after) return users;
      await sleep(pages % 6 === 0 ? randInt(4000, 8000) : randInt(700, 1700));
    }
  };

  // ==========================================================================
  // Diff & analysis  (pure functions — see __igrfSelfTest below)
  // ==========================================================================
  const byId = (list) => Object.fromEntries((list || []).map((u) => [u.id, u]));
  const not = (list, otherMap) => (list || []).filter((u) => !otherMap[u.id]);
  const inter = (list, otherMap) => (list || []).filter((u) => otherMap[u.id]);

  const computeDiff = (prev, curr) => {
    if (!prev) return null;
    const cf = byId(curr.followers), cg = byId(curr.following);
    return {
      gained: not(curr.followers, byId(prev.followers)), // new followers
      lost: not(prev.followers, cf),                     // removed their follow
      startedFollowing: not(curr.following, byId(prev.following)),
      stoppedFollowing: not(prev.following, cg),
    };
  };

  const analyze = (snap) => {
    const fMap = byId(snap.followers), gMap = byId(snap.following);
    return {
      followers: snap.followers, following: snap.following,
      mutuals: inter(snap.following, fMap),    // follow each other
      fans: not(snap.followers, gMap),         // they follow you, you don't
      nonFollowers: not(snap.following, fMap), // you follow, they don't (the classic unfollowers)
      verified: snap.followers.filter((u) => u.isVerified),
      private: snap.followers.filter((u) => u.isPrivate),
    };
  };

  // ==========================================================================
  // Persist a completed scan: rotate snapshots, append timeline + event feed.
  // ==========================================================================
  const commitScan = (curr) => {
    const prev = store.get(K.current, null);
    const diff = computeDiff(prev, curr);
    if (diff) {
      let events = store.get(K.events, []);
      const push = (arr, type) => arr.forEach((u) =>
        events.push({ ts: curr.ts, type, id: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified }));
      push(diff.gained, 'gained'); push(diff.lost, 'lost');
      push(diff.startedFollowing, 'followed'); push(diff.stoppedFollowing, 'unfollowed');
      if (events.length > EVENTS_LIMIT) events = events.slice(-EVENTS_LIMIT);
      store.save(K.events, events);
    }
    let timeline = store.get(K.timeline, []);
    timeline.push({ ts: curr.ts, f: curr.counts.followers, g: curr.counts.following });
    if (timeline.length > TIMELINE_LIMIT) timeline = timeline.slice(-TIMELINE_LIMIT);
    store.save(K.timeline, timeline);

    if (prev) store.save(K.previous, prev);
    const storedOk = store.save(K.current, curr);
    return { diff, prev, storedOk };
  };

  // ==========================================================================
  // Action queue — clones the followaccount ActionQueue: one unfollow at a
  // time, human-like delay between actions, exponential backoff on failure,
  // rate-limit auto-pause, and full persistence so a long run survives a page
  // refresh. Leaner (no per-item pause/whitelist) + speed presets & batch ETA.
  // ==========================================================================
  const QKEY = 'igrf-queue';
  const SPEEDS = {
    safe: { min: 45000, max: 90000, label: 'Safe · 45–90s' },   // followaccount default
    normal: { min: 25000, max: 50000, label: 'Normal · 25–50s' },
    fast: { min: 12000, max: 25000, label: 'Fast · 12–25s ⚠' },
  };
  const MAX_RETRIES = 4;             // attempts before giving up on an item
  const RL_WAIT_MS = 10 * 60 * 1000; // rate-limit cooldown (followaccount: 10 min)
  const uid = (() => { let n = 0; return () => `q${Date.now().toString(36)}${n++}`; })();

  const queue = {
    items: [], paused: false, cooldownUntil: 0, rateLimitedUntil: 0, speedKey: 'safe',
    _busy: false, _timer: null,

    load() {
      const s = store.get(QKEY, null);
      if (!s || !Array.isArray(s.items)) return;
      this.items = s.items;
      this.paused = !!s.paused;
      this.cooldownUntil = s.cooldownUntil || 0;
      this.speedKey = s.speedKey || 'safe';
      // recover anything mid-flight when the tab closed
      this.items.forEach((i) => { if (i.status === 'running') { i.status = 'pending'; i.nextRunAt = Date.now() + randInt(4000, 12000); } });
    },
    persist() {
      store.save(QKEY, { items: this.items, paused: this.paused, cooldownUntil: this.cooldownUntil, speedKey: this.speedKey });
    },
    speed() { return SPEEDS[this.speedKey] || SPEEDS.safe; },
    statusOf(userId) { return this.items.find((i) => i.userId === userId)?.status ?? null; },
    summary() {
      const c = { pending: 0, running: 0, done: 0, failed: 0 };
      this.items.forEach((i) => { c[i.status] = (c[i.status] || 0) + 1; });
      return c;
    },
    add(user) {
      if (this.items.some((i) => i.userId === user.id && i.status !== 'failed')) return false;
      this.items.push({ id: uid(), userId: user.id, username: user.username, fullName: user.fullName, isVerified: user.isVerified, status: 'pending', attempts: 0, nextRunAt: Date.now() });
      return true;
    },
    cancelPending() {
      this.items = this.items.filter((i) => i.status === 'running' || i.status === 'done');
      this.persist(); onQueueChange();
    },
    clearFinished() {
      this.items = this.items.filter((i) => i.status === 'pending' || i.status === 'running');
      this.persist(); onQueueChange();
    },
    pause() { this.paused = true; this.persist(); onQueueChange(); },
    resume() { this.paused = false; this.rateLimitedUntil = 0; this.persist(); onQueueChange(); },

    start() { if (!this._timer) this._timer = setInterval(() => this.tick(), 1000); },
    stop() { if (this._timer) { clearInterval(this._timer); } this._timer = null; },
    etaMs() {
      const pending = this.summary().pending;
      if (!pending) return 0;
      const sp = this.speed();
      return Math.max(0, this.cooldownUntil - Date.now()) + pending * (sp.min + sp.max) / 2;
    },

    async tick() {
      onQueueTick(); // refresh countdown display every second
      // auto-resume once a rate-limit cooldown elapses (only rate-limit pauses
      // set rateLimitedUntil; a manual pause leaves it 0 and is untouched).
      if (this.rateLimitedUntil && Date.now() >= this.rateLimitedUntil) {
        this.rateLimitedUntil = 0;
        if (this.paused) { this.paused = false; this.persist(); onQueueChange(); }
      }
      if (this._busy || this.paused) return;
      const now = Date.now();
      if (now < this.cooldownUntil || now < this.rateLimitedUntil) return;
      const item = this.items.find((i) => i.status === 'pending' && i.nextRunAt <= now);
      if (!item) return;

      this._busy = true; item.status = 'running'; item.attempts += 1; this.persist(); onQueueChange();
      try {
        await api.unfollow(item.userId);
        item.status = 'done';
        afterUnfollow(item);
      } catch (err) {
        if (err instanceof RateLimit) this._onRateLimit(item, err);
        else this._onFailure(item, err);
      } finally {
        const sp = this.speed();
        this.cooldownUntil = Date.now() + randInt(sp.min, sp.max);
        this._busy = false; this.persist(); onQueueChange();
      }
    },
    _onFailure(item, err) {
      item.error = String(err?.message || err);
      if (item.attempts >= MAX_RETRIES) {
        item.status = 'failed';
      } else {
        const backoffMin = Math.min(16, 2 ** (item.attempts - 1)); // 1,2,4,8,16 min
        item.status = 'pending'; item.nextRunAt = Date.now() + backoffMin * 60000;
      }
    },
    _onRateLimit(item, err) {
      item.status = 'pending'; item.attempts = Math.max(0, item.attempts - 1); // not the item's fault
      item.nextRunAt = Date.now() + RL_WAIT_MS;
      this.paused = true; this.rateLimitedUntil = Date.now() + RL_WAIT_MS;
      this.rlDetail = err.detail || '';
    },
  };

  // Persist a successful unfollow into the snapshot so the dashboard stays
  // accurate without a re-scan: drop them from `following`, log the event.
  const afterUnfollow = (item) => {
    const curr = store.get(K.current, null);
    if (curr) {
      const before = curr.following.length;
      curr.following = curr.following.filter((u) => u.id !== item.userId);
      if (curr.following.length !== before) {
        curr.counts.following = curr.following.length;
        store.save(K.current, curr);
      }
      let events = store.get(K.events, []);
      events.push({ ts: Date.now(), type: 'unfollowed', id: item.userId, username: item.username, fullName: item.fullName, isVerified: item.isVerified });
      if (events.length > EVENTS_LIMIT) events = events.slice(-EVENTS_LIMIT);
      store.save(K.events, events);
    }
    rebuildModel();
    onQueueChange();
  };

  // ==========================================================================
  // Styles — Müller-Brockmann: white paper, ink, one Swiss-red accent.
  // Scoped under #igrf-root; reset locally so Instagram's CSS can't bleed in.
  // ==========================================================================
  const CSS = [
    '#igrf-root,#igrf-root *{box-sizing:border-box;margin:0;padding:0;}',
    '#igrf-root{position:fixed;inset:0;z-index:2147483647;background:#fff;color:#111;',
    'font-family:Inter,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif;',
    'font-size:15px;line-height:1.5;overflow:auto;-webkit-font-smoothing:antialiased;',
    '--ink:#111;--paper:#fff;--accent:#e4002b;--mut:#6b6b6b;--line:#111;--hair:#e3e3e3;--bl:8px;',
    '--mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;}',
    '#igrf-root .wrap{max-width:1180px;margin:0 auto;padding:0 32px 96px;}',
    // top bar
    '#igrf-root .top{position:sticky;top:0;z-index:5;background:#fff;border-bottom:2px solid var(--line);',
    'display:flex;align-items:center;gap:16px;padding:18px 0;margin-bottom:24px;}',
    '#igrf-root .brand{font-family:var(--mono);font-size:12px;letter-spacing:.18em;text-transform:uppercase;}',
    '#igrf-root .brand b{display:block;font-family:Inter,sans-serif;font-size:22px;letter-spacing:-.02em;font-weight:800;text-transform:none;}',
    '#igrf-root .spacer{flex:1;}',
    '#igrf-root .who{font-family:var(--mono);font-size:11px;color:var(--mut);text-align:right;line-height:1.4;}',
    // buttons (≥44px targets, AA contrast)
    '#igrf-root button{font:inherit;cursor:pointer;border:2px solid var(--line);background:#fff;color:#111;',
    'min-height:44px;padding:0 18px;font-weight:600;letter-spacing:.01em;transition:background .12s,color .12s;}',
    '#igrf-root button:hover{background:#111;color:#fff;}',
    '#igrf-root button.primary{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '#igrf-root button.primary:hover{background:#b80023;border-color:#b80023;}',
    '#igrf-root button.ghost{border-color:var(--hair);min-height:38px;padding:0 12px;}',
    '#igrf-root button:disabled{opacity:.45;cursor:not-allowed;}',
    '#igrf-root .iconbtn{min-height:44px;min-width:44px;padding:0;font-size:20px;line-height:1;}',
    // kicker
    '#igrf-root .kicker{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut);margin:40px 0 12px;}',
    '#igrf-root .kicker .accent{color:var(--accent);}',
    // metric grid (big numerals — the Müller-Brockmann data-set-large move)
    '#igrf-root .metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--hair);border:1px solid var(--hair);}',
    '#igrf-root .metric{background:#fff;padding:18px 16px 16px;min-height:104px;}',
    '#igrf-root .metric .v{font-size:40px;font-weight:800;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums;}',
    '#igrf-root .metric .l{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin-top:10px;}',
    '#igrf-root .metric .d{font-family:var(--mono);font-size:12px;margin-top:6px;font-variant-numeric:tabular-nums;}',
    '#igrf-root .metric .d.up{color:#111;} #igrf-root .metric .d.down{color:var(--accent);font-weight:700;}',
    '#igrf-root .metric.span2{grid-column:span 2;}',
    // chart
    '#igrf-root .chartbox{border:1px solid var(--hair);padding:20px 20px 12px;}',
    '#igrf-root .chartbox svg{display:block;width:100%;height:200px;}',
    '#igrf-root .legend{font-family:var(--mono);font-size:11px;color:var(--mut);display:flex;gap:20px;margin-top:8px;}',
    '#igrf-root .legend i{display:inline-block;width:16px;height:0;border-top:3px solid;vertical-align:middle;margin-right:6px;}',
    // tabs
    '#igrf-root .tabs{display:flex;flex-wrap:wrap;gap:0;border-bottom:2px solid var(--line);margin:8px 0 0;}',
    '#igrf-root .tab{border:none;border-bottom:3px solid transparent;background:none;min-height:48px;padding:0 16px;',
    'font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);}',
    '#igrf-root .tab:hover{background:none;color:#111;}',
    '#igrf-root .tab.on{color:#111;border-bottom-color:var(--accent);font-weight:700;}',
    '#igrf-root .tab .n{font-weight:800;margin-left:6px;color:#111;}',
    // search + list
    '#igrf-root .listhead{display:flex;align-items:center;gap:12px;margin:18px 0 10px;}',
    '#igrf-root .listhead h3{font-size:13px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--mut);font-weight:600;}',
    '#igrf-root input.search{flex:1;max-width:340px;min-height:40px;border:2px solid var(--line);padding:0 12px;font:inherit;}',
    '#igrf-root input.search:focus{outline:2px solid var(--accent);outline-offset:1px;}',
    '#igrf-root .rows{border-top:1px solid var(--hair);}',
    '#igrf-root .row{display:flex;align-items:center;gap:14px;padding:10px 4px;border-bottom:1px solid var(--hair);}',
    '#igrf-root .row .av{width:44px;height:44px;border-radius:50%;flex:none;background:#f0f0f0;object-fit:cover;',
    'display:flex;align-items:center;justify-content:center;font-weight:700;color:#999;font-size:16px;}',
    '#igrf-root .row .meta{min-width:0;flex:1;}',
    '#igrf-root .row .u{font-weight:600;}',
    '#igrf-root .row .u a{color:#111;text-decoration:none;}',
    '#igrf-root .row .u a:hover{text-decoration:underline;text-decoration-color:var(--accent);}',
    '#igrf-root .row .fn{color:var(--mut);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#igrf-root .row .when{font-family:var(--mono);font-size:11px;color:var(--mut);white-space:nowrap;}',
    '#igrf-root .badge{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;',
    'border:1px solid var(--hair);padding:3px 6px;color:var(--mut);white-space:nowrap;}',
    '#igrf-root .badge.v{border-color:#111;color:#111;} #igrf-root .badge.red{border-color:var(--accent);color:var(--accent);}',
    '#igrf-root .empty{color:var(--mut);padding:36px 4px;font-family:var(--mono);font-size:13px;}',
    '#igrf-root .more{color:var(--mut);font-family:var(--mono);font-size:12px;padding:14px 4px;}',
    // selection + per-row unfollow
    '#igrf-root .row .ck{width:22px;height:22px;flex:none;accent-color:var(--accent);cursor:pointer;}',
    '#igrf-root .row .ckwrap{display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;margin:-10px 0 -10px -4px;cursor:pointer;}',
    '#igrf-root .row.q-done{opacity:.5;}',
    '#igrf-root .ufbtn{min-height:36px;padding:0 12px;border:2px solid var(--accent);background:#fff;color:var(--accent);font-size:12px;font-weight:700;white-space:nowrap;}',
    '#igrf-root .ufbtn:hover{background:var(--accent);color:#fff;}',
    '#igrf-root .qbadge{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:3px 7px;white-space:nowrap;border:1px solid var(--hair);color:var(--mut);}',
    '#igrf-root .qbadge.pending{border-color:#111;color:#111;} #igrf-root .qbadge.running{border-color:var(--accent);color:var(--accent);}',
    '#igrf-root .qbadge.done{border-color:#0a7d28;color:#0a7d28;} #igrf-root .qbadge.failed{border-color:var(--accent);color:#fff;background:var(--accent);}',
    // selection toolbar
    '#igrf-root .seltool{display:flex;align-items:center;flex-wrap:wrap;gap:10px;border:2px solid var(--line);padding:10px 12px;margin:14px 0 6px;background:#fafafa;}',
    '#igrf-root .seltool .sc{font-family:var(--mono);font-size:12px;color:var(--mut);}',
    '#igrf-root .seltool .sc b{color:#111;font-size:14px;}',
    '#igrf-root .seltool select{font:inherit;min-height:38px;border:2px solid var(--line);background:#fff;padding:0 8px;}',
    '#igrf-root .seltool .sp{flex:1;}',
    // queue panel (fixed bottom bar)
    '#igrf-root .qpanel{position:fixed;left:0;right:0;bottom:0;z-index:15;background:#111;color:#fff;',
    'display:flex;align-items:center;gap:16px;padding:12px 24px;border-top:3px solid var(--accent);}',
    '#igrf-root .qpanel .qstat{font-family:var(--mono);font-size:12px;line-height:1.45;white-space:nowrap;}',
    '#igrf-root .qpanel .qstat b{font-size:15px;}',
    '#igrf-root .qpanel .qbar{flex:1;height:6px;background:#333;min-width:80px;}',
    '#igrf-root .qpanel .qbar i{display:block;height:100%;background:var(--accent);transition:width .4s;}',
    '#igrf-root .qpanel .qnext{font-family:var(--mono);font-size:12px;color:#ccc;white-space:nowrap;}',
    '#igrf-root .qpanel button{min-height:38px;padding:0 12px;border-color:#555;background:#111;color:#fff;}',
    '#igrf-root .qpanel button:hover{background:#fff;color:#111;}',
    '#igrf-root .qpanel button.primary{background:var(--accent);border-color:var(--accent);}',
    '#igrf-root .qpanel.rl{background:#5a0011;}',
    // scan overlay
    '#igrf-root .scan{position:fixed;inset:0;background:rgba(255,255,255,.97);z-index:20;display:flex;',
    'flex-direction:column;align-items:center;justify-content:center;gap:8px;}',
    '#igrf-root .radar{position:relative;width:140px;height:140px;}',
    '#igrf-root .radar .ring{position:absolute;inset:0;border:3px solid var(--accent);border-radius:50%;animation:igrfpulse 1.8s ease-out infinite;}',
    '#igrf-root .radar .ring:nth-child(2){animation-delay:.6s;} #igrf-root .radar .ring:nth-child(3){animation-delay:1.2s;}',
    '#igrf-root .radar .sweep{position:absolute;inset:0;border-radius:50%;border-top:3px solid #111;animation:igrfspin 1s linear infinite;}',
    '@keyframes igrfpulse{0%{transform:scale(.2);opacity:.9;}100%{transform:scale(1);opacity:0;}}',
    '@keyframes igrfspin{to{transform:rotate(360deg);}}',
    '#igrf-root .scan .lot{width:140px;height:140px;position:absolute;}',
    '#igrf-root .scan .st{font-family:var(--mono);font-size:13px;letter-spacing:.04em;margin-top:24px;text-align:center;}',
    '#igrf-root .scan .pct{font-size:64px;font-weight:800;letter-spacing:-.04em;font-variant-numeric:tabular-nums;}',
    '#igrf-root .scan .bar{width:280px;height:6px;background:var(--hair);margin-top:8px;}',
    '#igrf-root .scan .bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .3s;}',
    '#igrf-root .note{font-family:var(--mono);font-size:12px;color:var(--mut);margin:14px 0;}',
    '#igrf-root .warn{border-left:3px solid var(--accent);background:#fff5f6;padding:12px 14px;font-size:13px;margin:14px 0;}',
    '@media(max-width:880px){#igrf-root .metrics{grid-template-columns:repeat(3,1fr);}#igrf-root .wrap{padding:0 16px 80px;}}',
    '@media(max-width:520px){#igrf-root .metrics{grid-template-columns:repeat(2,1fr);}}',
  ].join('');

  // ==========================================================================
  // Lottie scan animation (progressive enhancement over the CSS radar)
  // ==========================================================================
  const LOTTIE_RING = {
    v: '5.9.0', fr: 60, ip: 0, op: 120, w: 120, h: 120, nm: 'scan', ddd: 0, assets: [],
    layers: [{
      ddd: 0, ind: 1, ty: 4, nm: 'ring', sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 1, k: [{ t: 0, s: [0] }, { t: 120, s: [360] }] },
        p: { a: 0, k: [60, 60, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
      },
      shapes: [{
        ty: 'gr', it: [
          { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [86, 86] } },
          { ty: 'st', c: { a: 0, k: [0.894, 0, 0.168, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 6 }, lc: 2, lj: 2 },
          { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [15] }, { t: 60, s: [85] }, { t: 120, s: [15] }] }, o: { a: 0, k: 0 }, m: 1 },
          { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
        ],
      }],
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

  // ==========================================================================
  // Growth chart (pure SVG, no deps)
  // ==========================================================================
  const chartSVG = (timeline) => {
    if (!timeline || timeline.length < 2) {
      return '<div class="empty">Growth chart appears after your second scan.</div>';
    }
    const W = 1000, H = 200, pad = { l: 8, r: 8, t: 14, b: 22 };
    const xs = timeline.map((p) => p.ts);
    const ys = timeline.flatMap((p) => [p.f, p.g]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys);
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
      `<path d="${fArea}" fill="#f6f6f6"/>` +
      `<path d="${path('g')}" fill="none" stroke="#bbb" stroke-width="2"/>` +
      `<path d="${path('f')}" fill="none" stroke="#e4002b" stroke-width="2.5"/>${dots}` +
      `<text x="${pad.l}" y="14" font-family="monospace" font-size="11" fill="#6b6b6b">${new Date(first.ts).toLocaleDateString()}</text>` +
      `<text x="${W - pad.r}" y="14" text-anchor="end" font-family="monospace" font-size="11" fill="#6b6b6b">${new Date(last.ts).toLocaleDateString()}</text>` +
      '</svg>';
  };

  // ==========================================================================
  // Rendering
  // ==========================================================================
  let root;
  const state = { tab: 'gained', query: '', scanning: false, selected: new Set() };
  const UNFOLLOW_TABS = { following: 1, mutuals: 1, nonfollowers: 1 };
  const EMPTY_AN = { followers: [], following: [], mutuals: [], fans: [], nonFollowers: [], verified: [], private: [] };

  // MODEL caches the computed analysis so analyze()/computeDiff() run once per
  // data change instead of on every tab switch, search keystroke or queue tick.
  let MODEL = null;
  const rebuildModel = () => {
    const curr = store.get(K.current, null), prev = store.get(K.previous, null);
    MODEL = {
      curr, prev,
      timeline: store.get(K.timeline, []), events: store.get(K.events, []),
      an: curr ? analyze(curr) : EMPTY_AN, diff: computeDiff(prev, curr),
    };
    return MODEL;
  };

  const avatar = (u) => {
    const letter = esc((u.username || '?').charAt(0).toUpperCase());
    return u.picUrl
      ? `<img class="av" loading="lazy" src="${esc(u.picUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'av',textContent:'${letter}'}))">`
      : `<div class="av">${letter}</div>`;
  };

  const rowHTML = (u, opts = {}) => {
    const qs = opts.queueAware ? queue.statusOf(u.id) : null;
    let badges = '';
    if (u.isVerified) badges += '<span class="badge v">✓ verified</span>';
    if (u.isPrivate) badges += '<span class="badge">private</span>';
    if (opts.badge) badges += `<span class="badge ${opts.badgeClass || ''}">${esc(opts.badge)}</span>`;
    let right = '';
    if (qs) {
      const lab = { pending: 'queued', running: 'unfollowing…', done: 'unfollowed ✓', failed: 'failed' }[qs] || qs;
      right = `<span class="qbadge ${qs}">${lab}</span>`;
    } else if (opts.unfollowable) {
      right = `<button class="ufbtn" data-act="unfollow" data-uid="${esc(u.id)}">Unfollow</button>`;
    }
    const when = opts.when ? `<span class="when">${esc(opts.when)}</span>` : '';
    let ck = '';
    if (opts.selectable && qs) {
      ck = '<span style="min-width:44px;flex:none"></span>';
    } else if (opts.selectable) {
      const checked = state.selected.has(u.id) ? ' checked' : '';
      ck = `<label class="ckwrap"><input type="checkbox" class="ck" data-uid="${esc(u.id)}"${checked}></label>`;
    }
    const fn = u.fullName ? `<div class="fn">${esc(u.fullName)}</div>` : '';
    return `<div class="row${qs === 'done' ? ' q-done' : ''}">${ck}${avatar(u)}` +
      `<div class="meta"><div class="u"><a href="https://www.instagram.com/${encodeURIComponent(u.username)}/" target="_blank" rel="noreferrer">@${esc(u.username)}</a></div>` +
      `${fn}</div>${badges}${when}${right}</div>`;
  };

  const listHTML = (users, opts = {}) => {
    const q = state.query.toLowerCase();
    const filtered = q
      ? users.filter((u) => u.username?.toLowerCase().includes(q) || u.fullName?.toLowerCase().includes(q))
      : users;
    if (!filtered.length) {
      const hint = q ? ` for “${state.query}”` : '';
      const msg = opts.empty || `Nothing here${hint}.`;
      return `<div class="empty">${esc(msg)}</div>`;
    }
    const shown = filtered.slice(0, ROW_CAP);
    let html = `<div class="rows">${shown.map((u) => rowHTML(u, typeof opts.row === 'function' ? opts.row(u) : opts.row)).join('')}</div>`;
    if (filtered.length > shown.length) {
      html += `<div class="more">Showing first ${fmt(shown.length)} of ${fmt(filtered.length)} — type in search to narrow down.</div>`;
    }
    return html;
  };

  // The user array behind each list tab (used for select-all + unfollow).
  const tabUsers = (key, M = MODEL) => {
    const { an } = M, d = M.diff || { gained: [], lost: [] };
    return ({
      gained: d.gained, lost: d.lost, nonfollowers: an.nonFollowers, fans: an.fans,
      mutuals: an.mutuals, followers: an.followers, following: an.following,
    })[key] || [];
  };

  // Each tab: {label, count, render()}. Unfollow tabs get checkboxes + buttons.
  const tabDefs = (M) => {
    const { an, events } = M;
    const d = M.diff || { gained: [], lost: [], startedFollowing: [], stoppedFollowing: [] };
    const uf = { selectable: true, unfollowable: true, queueAware: true };
    return {
      gained: { label: 'New followers', count: d.gained.length, render: () => listHTML(d.gained, { empty: 'No new followers since the previous scan.', row: { badge: 'new' } }) },
      lost: { label: 'Removed follow', count: d.lost.length, render: () => listHTML(d.lost, { empty: 'Nobody unfollowed you since the previous scan.', row: { badge: 'unfollowed you', badgeClass: 'red' } }) },
      nonfollowers: { label: "Don't follow back", count: an.nonFollowers.length, render: () => listHTML(an.nonFollowers, { empty: 'Everyone you follow follows you back.', row: uf }) },
      fans: { label: 'Fans', count: an.fans.length, render: () => listHTML(an.fans, { empty: 'No one-way fans.', row: { badge: 'you don’t follow' } }) },
      mutuals: { label: 'Mutuals', count: an.mutuals.length, render: () => listHTML(an.mutuals, { empty: 'No mutuals yet.', row: uf }) },
      followers: { label: 'All followers', count: an.followers.length, render: () => listHTML(an.followers, { empty: 'No followers loaded — run a scan.' }) },
      following: { label: 'Following', count: an.following.length, render: () => listHTML(an.following, { empty: 'Not following anyone, or no scan yet.', row: uf }) },
      activity: {
        label: 'Activity', count: events.length, render: () => {
          if (!events.length) return '<div class="empty">No history yet. Scans and unfollows are logged here.</div>';
          const labels = { gained: ['new follower', ''], lost: ['unfollowed you', 'red'], followed: ['you followed', ''], unfollowed: ['you unfollowed', 'red'] };
          const q = state.query.toLowerCase();
          let feed = events.slice().reverse();
          if (q) feed = feed.filter((e) => e.username?.toLowerCase().includes(q));
          return `<div class="rows">${feed.slice(0, ROW_CAP).map((e) => {
            const [badge, badgeClass] = labels[e.type] || [e.type, ''];
            return rowHTML(e, { badge, badgeClass, when: fmtAgo(e.ts) });
          }).join('')}</div>`;
        },
      },
    };
  };

  const metricsHTML = (M) => {
    const curr = M.curr;
    if (!curr) return '';
    const { an, diff: d } = M;
    const fc = curr.counts.followers, gc = curr.counts.following;
    const netF = d ? d.gained.length - d.lost.length : null;
    const ratio = fc ? gc / fc : null;
    const metric = (v, l, dh = '') => `<div class="metric"><div class="v">${v}</div>${dh}<div class="l">${l}</div></div>`;
    const delta = (n) => {
      if (n == null) return '';
      let cls = '', arrow = '';
      if (n > 0) { cls = 'up'; arrow = '▲ '; }
      else if (n < 0) { cls = 'down'; arrow = '▼ '; }
      return `<div class="d ${cls}">${arrow}${fmtDelta(n)} since last</div>`;
    };
    return metric(fmt(fc), 'Followers', delta(netF)) +
      metric(fmt(gc), 'Following') +
      metric(d ? fmtDelta(d.gained.length) : '—', 'Gained', d ? '<div class="d up">new followers</div>' : '') +
      metric(d ? fmtDelta(-d.lost.length) : '—', 'Removed', d ? '<div class="d down">unfollowed you</div>' : '') +
      metric(fmt(an.mutuals.length), 'Mutuals') +
      metric(fmt(an.nonFollowers.length), 'No follow-back') +
      metric(fmt(an.fans.length), 'Fans') +
      metric(fmt(an.verified.length), 'Verified') +
      metric(fmt(an.private.length), 'Private') +
      metric(ratio == null ? '—' : ratio.toFixed(2), 'Follow ratio') +
      metric(d ? fmtDelta(d.startedFollowing.length) : '—', 'You followed') +
      metric(d ? fmtDelta(-d.stoppedFollowing.length) : '—', 'You unfollowed');
  };

  const selToolHTML = (M) => {
    const selectable = tabUsers(state.tab, M).filter((u) => !queue.statusOf(u.id));
    const speedOpts = Object.entries(SPEEDS)
      .map(([k, sp]) => `<option value="${k}"${queue.speedKey === k ? ' selected' : ''}>${esc(sp.label)}</option>`).join('');
    const n = state.selected.size;
    return '<div class="seltool">' +
      `<button class="ghost" data-act="selall">Select all (${fmt(selectable.length)})</button>` +
      '<button class="ghost" data-act="selnone">Clear</button>' +
      `<span class="sc"><b id="igrf-selcount">${fmt(n)}</b> selected</span>` +
      '<span class="sp"></span>' +
      `<label class="sc">Pace <select id="igrf-speed">${speedOpts}</select></label>` +
      `<button class="primary" data-act="unfsel"${n ? '' : ' disabled'}>Unfollow selected →</button>` +
      '</div>';
  };

  const render = () => {
    if (!MODEL) rebuildModel();
    const M = MODEL, curr = M.curr, hasData = !!curr, lastScan = curr ? curr.ts : null;
    const tabs = tabDefs(M);
    if (!tabs[state.tab]) state.tab = 'gained';

    const firstScanNote = hasData && !M.prev
      ? '<div class="note">Baseline saved. Run a scan again later and this turns into a full change report.</div>' : '';
    const compactWarn = curr?._compact
      ? '<div class="warn">Your account is large — snapshots are stored in compact mode (names &amp; avatars dropped) to fit the browser. Usernames, counts and diffs are fully intact.</div>' : '';

    const tabOrder = ['gained', 'lost', 'nonfollowers', 'fans', 'mutuals', 'followers', 'following', 'activity'];
    const tabsHTML = tabOrder.map((key) =>
      `<button class="tab${state.tab === key ? ' on' : ''}" data-tab="${key}">${esc(tabs[key].label)}<span class="n">${fmt(tabs[key].count)}</span></button>`).join('');

    const gettingStarted = hasData ? '' :
      '<div class="kicker"><span class="accent">●</span> Getting started</div>' +
      '<div class="note">No snapshot yet. Hit <b>Scan now</b> to capture who follows you. Scan again any time to see exactly who joined and who left.</div>';

    const dashboard = hasData
      ? `<div class="kicker"><span class="accent">●</span> Dashboard — ${esc(fmtDate(lastScan))}</div>` +
        `<div class="metrics" id="igrf-metrics">${metricsHTML(M)}</div>` +
        '<div class="kicker">Growth over time</div>' +
        `<div class="chartbox">${chartSVG(M.timeline)}` +
          '<div class="legend"><span><i style="border-color:#e4002b"></i>followers</span><span><i style="border-color:#bbb"></i>following</span></div></div>'
      : '';

    root.innerHTML =
      '<div class="wrap">' +
        '<div class="top">' +
          '<div class="brand">Instagram<b>Follower Ledger</b></div>' +
          '<div class="spacer"></div>' +
          `<div class="who">viewer #${esc(api.viewerId || '—')}<br>last scan: ${lastScan ? fmtAgo(lastScan) : 'never'}</div>` +
          '<button class="primary" id="igrf-scan">Scan now</button>' +
          `<button class="ghost" id="igrf-export"${hasData ? '' : ' disabled'}>Export</button>` +
          '<button class="iconbtn" id="igrf-close" title="Close">✕</button>' +
        '</div>' +
        compactWarn + firstScanNote + gettingStarted + dashboard +
        '<div class="kicker">Breakdown — select on Following, Mutuals or Don’t-follow-back to unfollow</div>' +
        `<div class="tabs">${tabsHTML}</div>` +
        (UNFOLLOW_TABS[state.tab] && hasData ? selToolHTML(M) : '') +
        `<div class="listhead"><h3>${esc(tabs[state.tab].label)}</h3>` +
          `<input class="search" id="igrf-search" placeholder="Search username or name…" value="${esc(state.query)}"></div>` +
        `<div id="igrf-list">${tabs[state.tab].render()}</div>` +
      '</div>';

    wire();
    renderQueuePanel();
  };

  // Re-render just the list body (search, select-all, queue changes) — keeps
  // page scroll + search focus because the surrounding DOM is untouched.
  const refreshListBody = () => {
    const lb = $('#igrf-list', root);
    if (lb && MODEL) lb.innerHTML = tabDefs(MODEL)[state.tab].render();
  };
  const updateSelCount = () => {
    const c = $('#igrf-selcount', root); if (c) c.textContent = fmt(state.selected.size);
    const b = root.querySelector('.seltool [data-act="unfsel"]'); if (b) b.disabled = !state.selected.size;
  };
  // Live update after a data/queue change without nuking the whole page.
  const refreshDynamic = () => {
    if (!MODEL || !root) return;
    const tabs = tabDefs(MODEL);
    if (!tabs[state.tab]) state.tab = 'gained';
    const m = $('#igrf-metrics', root); if (m) m.innerHTML = metricsHTML(MODEL);
    root.querySelectorAll('.tab').forEach((b) => {
      const k = b.dataset.tab, n = b.querySelector('.n');
      if (n && tabs[k]) n.textContent = fmt(tabs[k].count);
    });
    refreshListBody();
    updateSelCount();
    renderQueuePanel();
  };

  const wire = () => {
    $('#igrf-close', root).onclick = () => teardown();
    $('#igrf-scan', root).onclick = () => runScan();
    const exp = $('#igrf-export', root); if (exp) exp.onclick = exportJSON;
    root.querySelectorAll('.tab').forEach((btn) => {
      btn.onclick = () => { state.tab = btn.dataset.tab; render(); };
    });
    const search = $('#igrf-search', root);
    if (search) search.oninput = () => { state.query = search.value; refreshListBody(); };
    // selection toolbar
    root.querySelectorAll('.seltool [data-act]').forEach((b) => {
      b.onclick = () => selToolAction(b.dataset.act);
    });
    const sp = $('#igrf-speed', root);
    if (sp) sp.onchange = () => { queue.speedKey = sp.value; queue.persist(); renderQueuePanel(); };
    // list: delegate checkbox + unfollow-button clicks (survives innerHTML swaps)
    const list = $('#igrf-list', root);
    if (list && !list._wired) {
      list._wired = true;
      list.addEventListener('change', (e) => {
        const t = e.target;
        if (t.classList?.contains('ck')) toggleSel(t.dataset.uid, t.checked);
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest?.('.ufbtn');
        if (b) singleUnfollow(b.dataset.uid);
      });
    }
  };

  // ---- selection + unfollow actions ----------------------------------------
  const toggleSel = (id, on) => { if (on) { state.selected.add(id); } else { state.selected.delete(id); } updateSelCount(); };
  const selToolAction = (a) => {
    if (a === 'selall') {
      tabUsers(state.tab).forEach((u) => { if (!queue.statusOf(u.id)) state.selected.add(u.id); });
      refreshListBody(); updateSelCount();
    } else if (a === 'selnone') {
      state.selected.clear(); refreshListBody(); updateSelCount();
    } else if (a === 'unfsel') {
      unfollowSelected();
    }
  };
  const enqueueUsers = (users) => {
    const added = users.reduce((acc, u) => acc + (queue.add(u) ? 1 : 0), 0);
    if (added) { queue.paused = false; queue.persist(); queue.start(); onQueueChange(); }
    return added;
  };
  const singleUnfollow = (uidStr) => {
    const u = byId(MODEL.an.following)[uidStr];
    if (u) enqueueUsers([u]);
  };
  const unfollowSelected = () => {
    const followingById = byId(MODEL.an.following);
    const users = [...state.selected].map((id) => followingById[id]).filter((u) => u && !queue.statusOf(u.id));
    if (!users.length) return;
    const sp = queue.speed();
    const mins = Math.max(1, Math.round(users.length * ((sp.min + sp.max) / 2) / 60000));
    if (!globalThis.confirm(`Unfollow ${users.length} account(s)?\n\nThey run ONE AT A TIME on the "${sp.label}" pace, so this takes ~${mins} min. The queue survives page refreshes — you can pause or cancel anytime.`)) return;
    enqueueUsers(users);
    state.selected.clear();
    refreshDynamic();
  };

  // ---- queue panel ---------------------------------------------------------
  const queueNextText = () => {
    const c = queue.summary();
    if (Date.now() < queue.rateLimitedUntil) return `Rate-limited — auto-resume in ${Math.ceil((queue.rateLimitedUntil - Date.now()) / 60000)}m`;
    if (queue.paused) return `Paused — ${c.pending} waiting`;
    if (queue._busy) return `Unfollowing @${queue.items.find((i) => i.status === 'running')?.username || ''}…`;
    if (c.pending) return `Next in ${fmtCountdown(Math.max(0, queue.cooldownUntil - Date.now()))} · ETA ${fmtCountdown(queue.etaMs())}`;
    return c.failed ? `Finished — ${c.failed} failed` : 'All done';
  };
  const queueBarPct = () => { const t = queue.items.length; return t ? Math.round(queue.summary().done / t * 100) : 0; };
  const renderQueuePanel = () => {
    if (!root) return;
    let el = $('#igrf-queue', root);
    if (!queue.items.length) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'igrf-queue'; root.appendChild(el); }
    const c = queue.summary(), total = queue.items.length;
    const failedTxt = c.failed ? ` · ${c.failed} failed` : '';
    el.className = `qpanel${Date.now() < queue.rateLimitedUntil ? ' rl' : ''}`;
    el.innerHTML =
      `<div class="qstat"><b>${fmt(c.done)}</b>/${fmt(total)} unfollowed${failedTxt}</div>` +
      `<div class="qbar"><i style="width:${queueBarPct()}%"></i></div>` +
      `<div class="qnext" id="igrf-qnext">${esc(queueNextText())}</div>` +
      (queue.paused ? '<button class="primary" data-q="resume">Resume</button>' : '<button data-q="pause">Pause</button>') +
      '<button data-q="cancel">Cancel pending</button>' +
      (c.done || c.failed ? '<button data-q="clear">Clear done</button>' : '');
    el.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => qAction(b.dataset.q); });
  };
  const qAction = (a) => {
    if (a === 'pause') queue.pause();
    else if (a === 'resume') queue.resume();
    else if (a === 'cancel') { if (globalThis.confirm('Cancel all pending unfollows? (in-flight one finishes)')) queue.cancelPending(); }
    else if (a === 'clear') queue.clearFinished();
  };
  // Cheap per-second refresh: only the countdown + bar, no rebind/reflow.
  const onQueueTick = () => {
    const el = $('#igrf-queue', root);
    if (!el || !queue.items.length) return;
    const nb = $('#igrf-qnext', el); if (nb) nb.textContent = queueNextText();
    const bar = el.querySelector('.qbar i'); if (bar) bar.style.width = `${queueBarPct()}%`;
  };
  const onQueueChange = () => refreshDynamic();

  const exportJSON = () => {
    const dump = {
      exportedAt: new Date().toISOString(),
      current: store.get(K.current, null),
      previous: store.get(K.previous, null),
      timeline: store.get(K.timeline, []),
      events: store.get(K.events, []),
      queue: store.get(QKEY, null),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
    a.download = `instagram-follower-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // ==========================================================================
  // Scan flow
  // ==========================================================================
  const scanOverlay = () => {
    const el = document.createElement('div');
    el.className = 'scan';
    el.innerHTML =
      '<div class="radar"><div class="lot"></div><div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="sweep"></div></div>' +
      '<div class="pct" id="igrf-pct">0%</div>' +
      '<div class="bar"><i id="igrf-prog"></i></div>' +
      '<div class="st" id="igrf-st">Starting…</div>' +
      '<button class="ghost" id="igrf-cancel" style="margin-top:20px">Cancel</button>';
    root.appendChild(el);
    tryLottie($('.lot', el), $('.radar', el));
    return el;
  };

  const runScan = async () => {
    if (state.scanning) return;
    if (!api.viewerId) {
      alert('Not logged in to instagram.com (no ds_user_id cookie). Log in, open instagram.com, and re-run.');
      return;
    }
    state.scanning = true;
    let cancelled = false;
    const ov = scanOverlay();
    $('#igrf-cancel', ov).onclick = () => { cancelled = true; $('#igrf-st', ov).textContent = 'Cancelling…'; };

    // followers ≈ 60% of the bar, following ≈ 40%
    const prevCount = store.get(K.current, null)?.counts ?? {};
    const progress = (kind, loaded, total) => {
      if (cancelled) throw new Error('cancelled');
      const base = kind === 'followers' ? 0 : 60, span = kind === 'followers' ? 60 : 40;
      const known = total || prevCount[kind] || loaded + 1;
      const pct = Math.min(100, Math.round(base + span * Math.min(1, loaded / Math.max(1, known))));
      $('#igrf-prog', ov).style.width = `${pct}%`;
      $('#igrf-pct', ov).textContent = `${pct}%`;
      const totalTxt = total ? ` / ${fmt(total)}` : '';
      $('#igrf-st', ov).textContent = `Loading ${kind} — ${fmt(loaded)}${totalTxt}…`;
    };

    try {
      const followers = await scanList('followers', progress);
      const following = await scanList('following', progress);
      $('#igrf-prog', ov).style.width = '100%';
      $('#igrf-pct', ov).textContent = '100%';
      const snap = {
        ts: Date.now(),
        counts: { followers: followers.length, following: following.length },
        followers, following,
      };
      const out = commitScan(snap);
      if (!out.storedOk) alert('Scan finished but the browser could not store it (storage full). Export still works for this session.');
      state.scanning = false;
      rebuildModel();
      render();
      toast(out.diff
        ? `${out.diff.gained.length} new · ${out.diff.lost.length} removed since last scan`
        : 'Baseline captured — scan again later to see changes');
    } catch (err) {
      state.scanning = false;
      ov.remove();
      if (cancelled || /cancelled/.test(String(err?.message))) {
        toast('Scan cancelled — nothing saved');
      } else if (err instanceof RateLimit) {
        showWarn(`Instagram rate-limited the scan (${esc(err.detail || '')}). Nothing was saved (a partial list would look like a mass unfollow). Wait ~10–15 min and try again.`);
      } else {
        showWarn(`Scan failed: ${esc(String(err?.message || err))}. Your previous snapshot is untouched.`);
      }
    }
  };

  const toast = (msg) => {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111;color:#fff;' +
      'font:600 13px Inter,sans-serif;padding:12px 18px;z-index:2147483647;border-left:3px solid #e4002b;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  };
  const showWarn = (html) => {
    const w = document.createElement('div');
    w.className = 'warn';
    w.innerHTML = `${html} <button class="ghost" style="margin-left:8px">Dismiss</button>`;
    const wrap = $('.wrap', root);
    wrap.insertBefore(w, wrap.children[1]);
    w.querySelector('button').onclick = () => w.remove();
  };

  const teardown = () => {
    queue.stop(); // halt unfollowing when the panel closes; persisted run resumes on reopen
    root?.remove();
    document.getElementById('igrf-style')?.remove();
  };

  // ==========================================================================
  // Self-test (ponytail: one runnable check on the diff/analysis logic).
  // Run globalThis.__igrfSelfTest() in the console to verify.
  // ==========================================================================
  globalThis.__igrfSelfTest = () => {
    const U = (id) => ({ id: String(id), username: `u${id}`, fullName: '', picUrl: '', isPrivate: false, isVerified: false });
    const prev = { followers: [U(1), U(2), U(3)], following: [U(2), U(9)] };
    const curr = { followers: [U(2), U(3), U(4)], following: [U(2), U(3)] };
    const d = computeDiff(prev, curr);
    const ids = (arr) => arr.map((u) => u.id).join();
    console.assert(ids(d.gained) === '4', 'gained should be [4]');
    console.assert(ids(d.lost) === '1', 'lost should be [1]');
    console.assert(ids(d.startedFollowing) === '3', 'startedFollowing [3]');
    console.assert(ids(d.stoppedFollowing) === '9', 'stoppedFollowing [9]');
    const a = analyze(curr);
    console.assert(ids(a.mutuals) === '2,3', 'mutuals [2,3]');
    console.assert(ids(a.fans) === '4', 'fans [4] (follow you, you dont follow back)');
    console.assert(a.nonFollowers.length === 0, 'nonFollowers should be empty here');
    console.assert(computeDiff(null, curr) === null, 'no diff without a previous snapshot');
    const backoff = [1, 2, 3, 4, 5].map((att) => Math.min(16, 2 ** (att - 1)));
    console.assert(backoff.join() === '1,2,4,8,16', 'backoff should be 1,2,4,8,16');
    console.log('%c__igrfSelfTest passed', 'color:#e4002b;font-weight:700');
    return true;
  };

  // ==========================================================================
  // Boot
  // ==========================================================================
  if (location.hostname !== HOST && location.hostname !== 'instagram.com') {
    alert('Open https://www.instagram.com/ (logged in) and run this there.');
    return;
  }
  const styleEl = document.createElement('style');
  styleEl.id = 'igrf-style';
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
  root = document.createElement('div');
  root.id = 'igrf-root';
  document.body.appendChild(root);
  queue.load();          // restore any in-flight unfollow run from a prior session
  rebuildModel();
  render();
  // resume processing if the queue survived a refresh with work left
  if (queue.items.some((i) => i.status === 'pending' || i.status === 'running')) queue.start();
  try { globalThis.__igrfSelfTest(); } catch { /* non-fatal */ }
})();  // arrow IIFE: early `return` on a non-instagram host still exits cleanly
