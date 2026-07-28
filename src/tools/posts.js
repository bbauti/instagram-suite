// Posts — load one profile's timeline, then sort/filter/search it locally.
// Read-only: nothing here enqueues an action, so there is no queue handler and
// no onQueueChange. Same lit-html contract as the other tools: one `template()`
// for the whole view, `update()` re-renders it, lit diffs the rest.
import { html, render, nothing } from 'lit-html';
import { live } from 'lit-html/directives/live.js';
import { repeat } from 'lit-html/directives/repeat.js';
import { ROW_CAP, POST_CAP_DEFAULT } from '../core/constants.js';
import { store } from '../core/store.js';
import { api, RateLimit, scanPosts } from '../core/api.js';
import { fmt, $, detectUsername } from '../core/utils.js';
import { badge, profileLink, toast, scanOverlay } from '../ui/components.js';

// Sort comparator for values that may be null (hidden like counts, views on a
// photo). Nulls sink to the bottom in BOTH directions — flipping the arrow
// should reorder the posts that have a number, not promote the ones that don't.
export const nullsLast = (a, b, desc) => {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return desc ? b - a : a - b;
};

export const posts = (() => {
  // ── state ──
  const state = {
    profile: null, posts: [], partial: false,
    query: '', sort: 'ts', desc: true, filters: new Set(), ranges: {}, from: '', to: '',
    view: 'grid', cap: String(POST_CAP_DEFAULT), scanning: false,
  };
  let container = null;

  const snapKey = (name) => `igs-posts-${name.toLowerCase()}`;
  // ponytail: thumbs are dropped before persisting — IG CDN URLs expire within
  // days, so storing them just buys broken images and eats the 5MB quota
  // (followers.js drops picUrl for the same reason). A re-scan brings them back.
  const slim = ({ thumb, ...p }) => p;
  const persist = () => {
    if (!state.profile) return;
    const ok = store.save(snapKey(state.profile.username), {
      profile: state.profile, posts: state.posts.map(slim), ts: Date.now(), partial: state.partial,
    });
    if (!ok) toast('Storage full — snapshot not saved. Export as backup!');
  };

  // ── derived metrics (computed on read; nothing extra is stored) ──
  // likes === null means the owner hid the counts — kept out of every average,
  // and sorted last rather than treated as zero.
  const engagement = (p) => (p.likes == null ? null : p.likes + p.comments);
  const engRate = (p) => {
    const eng = engagement(p);
    const followers = state.profile?.followerCount;
    return eng == null || !followers ? null : eng / followers;
  };
  const daysSince = (ts) => Math.max(1, (Date.now() - ts) / 86400000);
  const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);
  const median = (nums) => {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  // ── sorting ──
  const SORTS = [
    ['ts', 'Date', (p) => p.ts],
    ['likes', 'Likes', (p) => p.likes],
    ['comments', 'Comments', (p) => p.comments],
    ['views', 'Views', (p) => p.views],
    ['reposts', 'Reposts', (p) => p.reposts],
    ['eng', 'Engagement', engagement],
    ['rate', 'Engagement rate', engRate],
    ['ratio', 'Comments per like', (p) => (p.likes ? p.comments / p.likes : null)],
    ['perday', 'Likes per day', (p) => (p.likes == null ? null : p.likes / daysSince(p.ts))],
  ];
  const comparator = () => {
    const value = SORTS.find(([key]) => key === state.sort)[2];
    return (a, b) => nullsLast(value(a), value(b), state.desc);
  };

  // ── filters (all local — no extra requests) ──
  const TYPES = [['photo', 'Photo'], ['video', 'Video'], ['reel', 'Reel'], ['carousel', 'Carousel']];
  const CHIPS = [
    ['pinned', 'Pinned', (p) => p.pinned],
    ['location', 'Has location', (p) => !!p.location],
    ['tagged', 'Tags people', (p) => p.tagged > 0],
    ['reposted', 'Reposted', (p) => p.reposts > 0],
    ['nocaption', 'No caption', (p) => !p.caption],
    ['commentsoff', 'Comments off', (p) => p.commentsDisabled],
    ['hiddenlikes', 'Hidden likes', (p) => p.likes == null],
  ];
  const RANGES = [['likes', 'Likes'], ['comments', 'Comments'], ['views', 'Views']];
  // en-CA formats as YYYY-MM-DD in local time, so it compares directly against
  // an <input type="date"> value with no timezone arithmetic.
  const dayOf = (ts) => new Date(ts).toLocaleDateString('en-CA');

  const matchType = (p) => {
    const picked = [...state.filters].filter((k) => k.startsWith('type:')).map((k) => k.slice(5));
    return !picked.length || picked.includes(p.type); // several types read as OR
  };
  const matchChips = (p) => CHIPS.every(([key, , pred]) => !state.filters.has(key) || pred(p));
  // A range only matches posts that have that number; hidden/absent counts drop out.
  const matchRanges = (p) => RANGES.every(([key]) => {
    const min = state.ranges[`${key}Min`];
    const max = state.ranges[`${key}Max`];
    if (min == null && max == null) return true;
    const value = p[key];
    return value != null && (min == null || value >= min) && (max == null || value <= max);
  });
  const matchDates = (p) => {
    const day = dayOf(p.ts);
    return (!state.from || day >= state.from) && (!state.to || day <= state.to);
  };
  const matchQuery = (p) => {
    const q = state.query.trim().toLowerCase();
    return !q || p.caption.toLowerCase().includes(q) || p.location.toLowerCase().includes(q) || p.shortcode.toLowerCase().includes(q);
  };
  const visible = () => state.posts.filter((p) => matchType(p) && matchChips(p) && matchRanges(p) && matchDates(p) && matchQuery(p));

  // ── templates ──
  const postUrl = (p) => `https://www.instagram.com/p/${encodeURIComponent(p.shortcode)}/`;
  const thumbTpl = (p, cls) => (p.thumb
    ? html`<img class=${cls} loading="lazy" src=${p.thumb} alt="">`
    : html`<div class=${cls}></div>`);
  const statsTpl = (p) => html`<div class="pstats">♥ ${p.likes == null ? '—' : fmt(p.likes)} · 💬 ${fmt(p.comments)}${p.views == null ? nothing : html` · ▶ ${fmt(p.views)}`}${p.reposts ? html` · ↻ ${fmt(p.reposts)}` : nothing}</div>`;
  const badgesTpl = (p) => [
    badge(p.type, p.type === 'reel' ? 'blue' : ''),
    p.pinned ? badge('pinned', 'red') : nothing,
    p.slides > 1 ? badge(`${p.slides} slides`) : nothing,
    p.location ? badge(p.location) : nothing,
    p.commentsDisabled ? badge('comments off') : nothing,
  ];

  const cardTpl = (p) => html`<div class="card">
      <a class="shot" href=${postUrl(p)} target="_blank" rel="noreferrer">${thumbTpl(p, 'pic')}</a>
      ${statsTpl(p)}
      <div class="when">${dayOf(p.ts)}</div>
      ${p.caption ? html`<div class="cap">${p.caption}</div>` : nothing}
      <div class="cact">${badgesTpl(p)}</div>
    </div>`;
  const rowTpl = (p) => html`<div class="row">
      <a href=${postUrl(p)} target="_blank" rel="noreferrer">${thumbTpl(p, 'thumb')}</a>
      <div class="meta">
        <div class="cap">${p.caption || '(no caption)'}</div>
        <div class="cact">${badgesTpl(p)}</div>
      </div>
      ${statsTpl(p)}
      <div class="when">${dayOf(p.ts)}</div>
    </div>`;

  const listTpl = () => {
    if (!state.posts.length) {
      if (state.profile?.postsCount === 0) return html`<div class="empty">@${state.profile.username} has no posts.</div>`;
      return html`<div class="empty">Nothing loaded yet — hit Scan posts.</div>`;
    }
    const filtered = visible().sort(comparator());
    if (!filtered.length) return html`<div class="empty">No matches.</div>`;
    const shown = filtered.slice(0, ROW_CAP);
    const more = filtered.length > shown.length
      ? html`<div class="more">Showing ${fmt(shown.length)} of ${fmt(filtered.length)} — search/filter to narrow.</div>`
      : nothing;
    const body = state.view === 'grid'
      ? html`<div class="cards">${repeat(shown, (p) => p.id, cardTpl)}</div>`
      : html`<div class="rows">${repeat(shown, (p) => p.id, rowTpl)}</div>`;
    return html`${body}${more}`;
  };

  const metricTpl = (value, label, detail) => html`<div class="metric"><div class="v">${value}</div><div class="l">${label}</div>${detail ? html`<div class="d">${detail}</div>` : nothing}</div>`;
  const metricsTpl = () => {
    const shown = visible();
    const likes = shown.map((p) => p.likes).filter((n) => n != null);
    const hidden = shown.length - likes.length;
    const rates = shown.map(engRate).filter((n) => n != null);
    const top = shown.filter((p) => engagement(p) != null).sort((a, b) => engagement(b) - engagement(a))[0];
    const avgRate = mean(rates);
    return html`<div class="metrics">
        ${metricTpl(fmt(shown.length), 'Posts shown', state.profile?.postsCount ? `of ${fmt(state.profile.postsCount)} on profile` : '')}
        ${metricTpl(likes.length ? fmt(Math.round(mean(likes))) : '—', 'Avg likes', hidden ? `${fmt(hidden)} hidden` : '')}
        ${metricTpl(shown.length ? fmt(Math.round(mean(shown.map((p) => p.comments)))) : '—', 'Avg comments', '')}
        ${metricTpl(likes.length ? fmt(Math.round(median(likes))) : '—', 'Median likes', '')}
        ${metricTpl(avgRate == null ? '—' : `${(avgRate * 100).toFixed(1)}%`, 'Engagement rate', state.profile ? `of ${fmt(state.profile.followerCount)} followers` : '')}
        ${metricTpl(top ? fmt(engagement(top)) : '—', 'Top post', top ? html`<a href=${postUrl(top)} target="_blank" rel="noreferrer">${dayOf(top.ts)} ↗</a>` : '')}
      </div>`;
  };

  // ponytail: the username box is uncontrolled on purpose (same as followers) —
  // it is seeded from the loaded/detected profile but not bound per keystroke,
  // so typing survives unrelated re-renders. Read live via [data-user].
  const onLoad = () => loadProfile($('[data-user]', container).value);
  const kickerTpl = () => {
    if (!state.profile) return html`<div class="kicker"><span class="accent">●</span> Posts explorer</div>`;
    const p = state.profile;
    return html`<div class="kicker"><span class="accent">●</span> ${profileLink(p.username)} — ${fmt(p.postsCount)} posts · ${fmt(p.followerCount)} followers${state.partial ? ' · partial scan' : ''}</div>`;
  };
  const CAPS = [['100', 'Last 100'], [String(POST_CAP_DEFAULT), `Last ${POST_CAP_DEFAULT}`], ['1000', 'Last 1000'], ['Infinity', 'All posts']];
  const loadToolbarTpl = () => html`<div class="toolbar"><h3>Profile</h3>
      <input class="search" data-user placeholder="username" value=${state.profile?.username || detectUsername() || ''}>
      <button class="primary" @click=${onLoad}>Load</button>
      ${state.profile ? html`
        <select @change=${(e) => { state.cap = e.target.value; update(); }}>
          ${CAPS.map(([value, label]) => html`<option value=${value} ?selected=${state.cap === value}>${label}</option>`)}
        </select>
        <button class="ghost" ?disabled=${!state.profile.postsCount} @click=${runScan}>Scan posts</button>
        ${state.posts.length ? html`<button class="ghost" @click=${exportJSON}>Export</button>` : nothing}` : nothing}</div>`;

  const listToolbarTpl = () => html`<div class="toolbar"><h3>Posts</h3>
      <input class="search" placeholder="Search caption, location, shortcode…" .value=${live(state.query)} @input=${(e) => { state.query = e.target.value; update(); }}>
      <select @change=${(e) => { state.sort = e.target.value; update(); }}>
        ${SORTS.map(([key, label]) => html`<option value=${key} ?selected=${state.sort === key}>${label}</option>`)}
      </select>
      <button class="ghost" title="Reverse order" @click=${() => { state.desc = !state.desc; update(); }}>${state.desc ? '↓ High to low' : '↑ Low to high'}</button>
      <button class="chip${state.view === 'grid' ? ' on' : ''}" @click=${() => { state.view = state.view === 'grid' ? 'list' : 'grid'; update(); }}>${state.view === 'grid' ? 'Grid' : 'List'}</button>
    </div>`;

  const clearFilters = () => {
    state.filters.clear();
    state.ranges = {};
    state.from = '';
    state.to = '';
    update();
  };
  const toggleChip = (key) => {
    if (state.filters.has(key)) state.filters.delete(key);
    else state.filters.add(key);
    update();
  };
  const chipsTpl = () => {
    const chips = [...TYPES.map(([key, label]) => [`type:${key}`, label]), ...CHIPS.map(([key, label]) => [key, label])];
    const anyActive = state.filters.size || Object.keys(state.ranges).length || state.from || state.to;
    return html`<div class="chips"><button class="chip${anyActive ? '' : ' on'}" @click=${clearFilters}>All</button>
      ${chips.map(([key, label]) => html`<button class="chip${state.filters.has(key) ? ' on' : ''}" @click=${() => toggleChip(key)}>${label}</button>`)}</div>`;
  };
  const onRange = (key) => (event) => {
    const raw = event.target.value;
    if (raw === '') delete state.ranges[key];
    else state.ranges[key] = Number(raw);
    update();
  };
  const rangesTpl = () => html`<div class="ranges">
      ${RANGES.map(([key, label]) => html`<label>${label}
        <input type="number" min="0" placeholder="min" .value=${live(String(state.ranges[`${key}Min`] ?? ''))} @input=${onRange(`${key}Min`)}>
        <input type="number" min="0" placeholder="max" .value=${live(String(state.ranges[`${key}Max`] ?? ''))} @input=${onRange(`${key}Max`)}></label>`)}
      <label>From <input type="date" .value=${live(state.from)} @input=${(e) => { state.from = e.target.value; update(); }}></label>
      <label>To <input type="date" .value=${live(state.to)} @input=${(e) => { state.to = e.target.value; update(); }}></label>
    </div>`;

  const template = () => html`
      ${kickerTpl()}
      ${loadToolbarTpl()}
      ${state.profile
        ? html`${metricsTpl()}
          ${listToolbarTpl()}
          ${chipsTpl()}
          ${rangesTpl()}
          <div>${listTpl()}</div>`
        : html`<div class="note">Open or type a profile, Load, then Scan posts. Everything after that — sorting, filters, search — runs locally on what you scanned.</div>`}`;
  const update = () => render(template(), container);

  // ── actions ──
  const loadProfile = async (raw) => {
    const name = String(raw || '').trim().replace(/^@/, '');
    if (!name) return;
    const snap = store.get(snapKey(name), null);
    let profile = snap?.profile || null;
    if (api.loggedIn) {
      try {
        const webProfile = await api.getWebProfile(name);
        profile = {
          id: webProfile.id, username: webProfile.username, fullName: webProfile.fullName,
          followerCount: webProfile.followerCount, postsCount: webProfile.postsCount,
          isPrivate: webProfile.isPrivate, followedByViewer: webProfile.followedByViewer,
        };
      } catch (err) {
        if (!profile) {
          toast(`Couldn’t load @${name}: ${err?.message || err}`);
          return;
        }
      }
    } else if (!profile) {
      toast(`No saved data for @${name} — open instagram.com logged in`);
      return;
    }
    // A different profile means the loaded posts no longer belong to it.
    const sameProfile = snap && profile.username.toLowerCase() === name.toLowerCase();
    state.profile = profile;
    state.posts = sameProfile ? (snap.posts || []) : [];
    state.partial = sameProfile ? !!snap.partial : false;
    store.save('igs-posts-last', profile.username);
    update();
    if (profile.postsCount === 0) toast(`@${profile.username} has no posts`);
    else if (profile.isPrivate && profile.followedByViewer === false) toast(`@${profile.username} is private — follow them to see their posts`);
  };

  const runScan = async () => {
    if (state.scanning || !state.profile) return;
    if (!api.loggedIn) {
      toast('Open instagram.com logged in to scan');
      return;
    }
    const { username, id, postsCount, isPrivate, followedByViewer } = state.profile;
    if (!postsCount) {
      toast(`@${username} has no posts`);
      return;
    }
    if (isPrivate && followedByViewer === false) {
      toast(`@${username} is private — follow them to see their posts`);
      return;
    }
    state.scanning = true;
    let cancelled = false;
    let stopped = false;
    const overlay = scanOverlay('Starting…');
    $('[data-cancel]', overlay).onclick = () => {
      cancelled = true;
      $('[data-st]', overlay).textContent = 'Cancelling…';
    };
    $('[data-stop]', overlay).onclick = () => {
      stopped = true;
      $('[data-st]', overlay).textContent = 'Stopping — keeping what’s loaded…';
    };
    const max = Number(state.cap);
    const expected = Math.min(max, postsCount);
    try {
      const loaded = await scanPosts(id, (count) => {
        const percent = Math.min(100, Math.round(count / Math.max(1, expected) * 100));
        $('[data-prog]', overlay).style.width = `${percent}%`;
        $('[data-pct]', overlay).textContent = `${percent}%`;
        $('[data-st]', overlay).textContent = `@${username} — ${fmt(count)} / ${fmt(expected)} posts…`;
      }, max, () => cancelled, () => stopped);
      state.posts = loaded.slice(0, max);
      state.partial = stopped || state.posts.length < postsCount;
      persist();
      if (!state.posts.length) toast(`No visible posts for @${username}`);
      else toast(`Loaded ${fmt(state.posts.length)} posts`);
    } catch (err) {
      if (cancelled || /cancelled/.test(String(err?.message))) toast('Scan cancelled');
      else if (err instanceof RateLimit) toast('Rate-limited — wait ~10–15 min');
      else toast(`Scan failed: ${err?.message || err}`);
    } finally {
      state.scanning = false;
      overlay.remove();
      update();
    }
  };

  const exportJSON = () => {
    if (!state.posts.length) return;
    const dump = { exportedAt: new Date().toISOString(), profile: state.profile, partial: state.partial, posts: state.posts };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
    link.download = `instagram-posts-${state.profile.username}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  };

  // ── lifecycle ──
  return {
    id: 'posts', label: 'Posts', requiresLogin: true, // needs the live IG API
    boot() {
      const last = store.get('igs-posts-last', null);
      const snap = last ? store.get(snapKey(last), null) : null;
      if (snap) {
        state.profile = snap.profile;
        state.posts = snap.posts || [];
        state.partial = !!snap.partial;
      }
    },
    mount(el) { container = el; update(); },
    unmount() { if (state.profile) store.save('igs-posts-last', state.profile.username); },
  };
})();
