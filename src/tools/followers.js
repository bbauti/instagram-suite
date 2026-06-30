// Followers — load any profile's followers, enrich cards (posts/highlights/
// mutuals) on demand, follow/unfollow. Rendered with lit-html: one `template()`
// describes the whole tool and `update()` re-renders it; lit diffs so the search
// caret and page scroll survive queue-driven re-renders (no manual partials).
import { html, render, nothing } from 'lit-html';
import { live } from 'lit-html/directives/live.js';
import { repeat } from 'lit-html/directives/repeat.js';
import { ROW_CAP } from '../core/constants.js';
import { store } from '../core/store.js';
import { queue } from '../core/queue.js';
import { api, RateLimit, scanList } from '../core/api.js';
import { fmt, $ } from '../core/utils.js';
import { avatar, badge, profileLink, toast, scanOverlay } from '../ui/components.js';

export const followers = (() => {
  // ── state ──
  const state = { profile: null, users: [], query: '', filter: 'all', scanning: false };
  let container = null;

  // ── data model ──
  const RESERVED = new Set(['explore', 'reels', 'reel', 'direct', 'stories', 'p', 'tv', 'accounts', 'about', 'developer', 'legal', 'directory', 'lite', 'session', 'graphql', 'api', 'your_activity', 'emails', 'challenge', 'privacy', 'web']);
  const detectUsername = () => {
    const match = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    return match && !RESERVED.has(match[1].toLowerCase()) ? match[1] : '';
  };
  const snapKey = (name) => `igs-fm-snap-${name.toLowerCase()}`;

  const loadSnapshot = (name) => {
    const snap = store.get(snapKey(name), null);
    if (snap) {
      state.profile = snap.profile;
      state.users = snap.users || [];
      return true;
    }
    return false;
  };
  const persistSnapshot = () => {
    if (state.profile) {
      store.save(snapKey(state.profile.username), { profile: state.profile, users: state.users, ts: Date.now() });
    }
  };
  const userById = (id) => state.users.find((u) => u.id === id);

  // queue handlers mutate the loaded follower's relationship flag + persist
  const onFollowDone = (item, requested) => {
    const u = userById(item.userId);
    if (u) {
      u.followedByViewer = !requested;
      u.requestedByViewer = !!requested;
    }
    persistSnapshot();
  };
  const onUnfollowDone = (item) => {
    const u = userById(item.userId);
    if (u) {
      u.followedByViewer = false;
      u.requestedByViewer = false;
    }
    persistSnapshot();
  };

  const FILTERS = [
    ['all', 'All'], ['public', 'Public'], ['private', 'Private'], ['verified', 'Verified'],
    ['following', 'You follow'], ['notfollowing', "You don't follow"],
  ];
  const matchFilter = (u) => {
    switch (state.filter) {
      case 'public': return !u.isPrivate;
      case 'private': return u.isPrivate;
      case 'verified': return u.isVerified;
      case 'following': return u.followedByViewer === true;
      case 'notfollowing': return u.followedByViewer === false;
      default: return true;
    }
  };

  // ── templates ──
  const postThumb = (post) => html`<a href="https://www.instagram.com/p/${post.shortcode}/" target="_blank" rel="noreferrer"><img loading="lazy" src=${post.thumb} alt=""></a>`;
  const highlightChip = (highlight) => html`<span>${highlight.title || '•'}</span>`;
  const enrichRow = (u) => {
    if (!u.enriched) return nothing;
    const enriched = u.enriched;
    const postsTpl = enriched.posts?.length
      ? html`<div class="thumbs">${enriched.posts.map(postThumb)}</div>`
      : html`<div class="note" style="margin:0">no posts</div>`;
    const highlightsTpl = enriched.highlights?.length
      ? html`<div class="hl">${enriched.highlights.map(highlightChip)}</div>`
      : nothing;
    return html`<div class="note" style="margin:4px 0 0">${fmt(enriched.followerCount)} followers · ${fmt(enriched.followingCount)} following · ${fmt(enriched.mutualCount)} mutual</div>${postsTpl}${highlightsTpl}`;
  };
  const cardActions = (u) => {
    const followStatus = queue.statusOf(u.id, 'fm-follow');
    const unfollowStatus = queue.statusOf(u.id, 'fm-unfollow');
    if (followStatus) {
      return html`<span class="qbadge ${followStatus}">${followStatus === 'done' ? 'followed ✓' : 'follow ' + followStatus}</span>`;
    }
    if (unfollowStatus) {
      return html`<span class="qbadge ${unfollowStatus}">${unfollowStatus === 'done' ? 'unfollowed ✓' : 'unfollow ' + unfollowStatus}</span>`;
    }
    let relationshipTpl;
    if (u.followedByViewer === true) {
      relationshipTpl = html`<button class="actbtn" @click=${() => runCardAction('unfollow', u)}>Unfollow</button>`;
    } else if (u.requestedByViewer === true) {
      relationshipTpl = html`<span class="qbadge pending">requested</span>`;
    } else {
      relationshipTpl = html`<button class="actbtn plain" @click=${() => runCardAction('follow', u)}>Follow</button>`;
    }
    const loadDetailsTpl = u.enriched
      ? nothing
      : html`<button class="actbtn plain" @click=${() => runCardAction('enrich', u)}>Load details</button>`;
    return [relationshipTpl, loadDetailsTpl];
  };
  const cardHTML = (u) => {
    const badges = [
      u.isVerified ? badge('✓', 'v') : nothing,
      u.isPrivate ? badge('private') : nothing,
      u.followsViewer === true ? badge('follows you', 'blue') : nothing,
    ];
    const nameTpl = u.fullName ? html`<div class="fn">${u.fullName}</div>` : nothing;
    return html`<div class="card"><div class="chead">${avatar(u)}<div class="meta"><div class="u">${profileLink(u.username)}</div>${nameTpl}</div>${badges}</div>${enrichRow(u)}<div class="cact">${cardActions(u)}</div></div>`;
  };

  const cardsHTML = () => {
    const queryLower = state.query.toLowerCase();
    const filtered = state.users.filter((u) => matchFilter(u) && (!queryLower || u.username?.toLowerCase().includes(queryLower) || u.fullName?.toLowerCase().includes(queryLower)));
    if (!state.users.length) return html`<div class="empty">No followers loaded yet — hit Scan followers.</div>`;
    if (!filtered.length) return html`<div class="empty">No matches.</div>`;
    const shown = filtered.slice(0, ROW_CAP);
    const more = filtered.length > shown.length
      ? html`<div class="more">Showing ${fmt(shown.length)} of ${fmt(filtered.length)} — search/filter to narrow.</div>`
      : nothing;
    return html`<div class="cards">${repeat(shown, (u) => u.id ?? u.username, cardHTML)}</div>${more}`;
  };

  // ponytail: the Load-profile input is intentionally uncontrolled — a plain
  // attribute binding seeds it (username/detected) but it is NOT bound to per-
  // keystroke state, so the user's typing survives unrelated queue-driven
  // re-renders. We read its live value via this one [data-user] selector hook.
  const onLoad = () => loadProfile($('[data-user]', container).value.trim());
  const onSearch = (event) => {
    state.query = event.target.value;
    update();
  };

  const kickerTpl = (profile) => profile
    ? html`<div class="kicker"><span class="accent">●</span> ${profile.username} — ${fmt(profile.followerCount)} followers · ${fmt(profile.followingCount)} following</div>`
    : html`<div class="kicker"><span class="accent">●</span> Followers manager</div>`;
  const loadToolbarTpl = (profile, detected) => html`<div class="toolbar"><h3>Load a profile</h3>
        <input class="search" data-user placeholder="username (no @)" value=${profile?.username || detected || ''}>
        <button class="primary" @click=${onLoad}>Load profile</button>
        ${profile ? html`<button class="ghost" @click=${runScan}>Scan followers</button><button class="ghost" @click=${exportJSON}>Export</button>` : nothing}
        ${profile ? html`<span class="note" style="margin:0">${fmt(state.users.length)} loaded</span>` : nothing}</div>`;
  const followersToolbarTpl = () => html`<div class="toolbar"><h3>Followers</h3><input class="search" placeholder="Search…" .value=${live(state.query)} @input=${onSearch}></div>`;
  const filterChipsTpl = () => html`<div class="chips">${FILTERS.map(([key, label]) => html`<button class="chip${state.filter === key ? ' on' : ''}" @click=${() => { state.filter = key; update(); }}>${label}</button>`)}</div>`;

  const template = () => {
    const profile = state.profile;
    const detected = detectUsername();
    return html`
      ${kickerTpl(profile)}
      ${loadToolbarTpl(profile, detected)}
      ${profile
        ? html`${followersToolbarTpl()}
          ${filterChipsTpl()}
          <div>${cardsHTML()}</div>`
        : html`<div class="note">Open or type any profile, Load it, then Scan followers. Details (posts, highlights, mutuals) load per-card on demand.</div>`}`;
  };
  const update = () => render(template(), container);

  // ── actions ──
  const runCardAction = (action, u) => {
    if (action === 'follow') {
      queue.enqueue([{ kind: 'fm-follow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified }]);
    } else if (action === 'unfollow') {
      queue.enqueue([{ kind: 'fm-unfollow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified }]);
    } else if (action === 'enrich') {
      enrichUser(u);
    }
    update();
  };
  const enrichUser = async (u) => {
    if (u.enriched || u._enriching) return;
    u._enriching = true;
    try {
      const [webProfile, highlights] = await Promise.all([
        api.getWebProfile(u.username),
        api.getHighlights(u.id).catch(() => ({ count: 0, items: [] })),
      ]);
      u.enriched = {
        followerCount: webProfile.followerCount,
        followingCount: webProfile.followingCount,
        mutualCount: webProfile.mutualCount,
        postsCount: webProfile.postsCount,
        posts: webProfile.posts,
        highlights: highlights.items,
        fetchedAt: Date.now(),
      };
      u.picUrl = u.picUrl || webProfile.picUrl;
      persistSnapshot();
      update();
    } catch (err) {
      toast(err instanceof RateLimit ? 'Rate-limited — wait a bit' : `Couldn’t load @${u.username}`);
    } finally {
      u._enriching = false;
    }
  };

  const loadProfile = async (name) => {
    if (!name) return;
    if (loadSnapshot(name)) update();
    if (!api.loggedIn) {
      toast('Open instagram.com logged in to load live');
      if (state.profile) update();
      return;
    }
    try {
      const webProfile = await api.getWebProfile(name);
      state.profile = {
        id: webProfile.id,
        username: webProfile.username,
        fullName: webProfile.fullName,
        picUrl: webProfile.picUrl,
        followerCount: webProfile.followerCount,
        followingCount: webProfile.followingCount,
        isPrivate: webProfile.isPrivate,
        isVerified: webProfile.isVerified,
      };
      persistSnapshot();
      update();
    } catch {
      toast(`Profile not found: @${name}`);
    }
  };
  const runScan = async () => {
    if (state.scanning || !state.profile) return;
    if (!api.loggedIn) {
      toast('Open instagram.com logged in to scan');
      return;
    }
    state.scanning = true;
    let cancelled = false;
    const overlay = scanOverlay(`Loading @${state.profile.username} followers…`);
    $('[data-cancel]', overlay).onclick = () => {
      cancelled = true;
      $('[data-st]', overlay).textContent = 'Cancelling…';
    };
    const total = state.profile.followerCount;
    const progress = (kind, loaded) => {
      const percent = Math.min(100, Math.round(loaded / Math.max(1, total) * 100));
      $('[data-prog]', overlay).style.width = `${percent}%`;
      $('[data-pct]', overlay).textContent = `${percent}%`;
      $('[data-st]', overlay).textContent = `Loaded ${fmt(loaded)} / ${fmt(total)}…`;
    };
    try {
      const users = await scanList('followers', progress, state.profile.id, () => cancelled);
      state.users = users;
      persistSnapshot();
      state.scanning = false;
      overlay.remove();
      update();
      toast(`Loaded ${fmt(users.length)} followers of @${state.profile.username}`);
    } catch (err) {
      state.scanning = false;
      overlay.remove();
      if (cancelled || /cancelled/.test(String(err?.message))) toast('Scan cancelled');
      else if (err instanceof RateLimit) toast('Rate-limited — wait ~10–15 min');
      else toast(`Scan failed: ${err?.message || err}`);
    }
  };
  const exportJSON = () => {
    if (!state.profile) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), profile: state.profile, users: state.users }, null, 2)], { type: 'application/json' }));
    link.download = `instagram-followers-${state.profile.username}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  };

  // ── lifecycle ──
  return {
    id: 'followers', label: 'Followers',
    boot() {
      queue.register('fm-follow', {
        run: async (item) => {
          const result = await api.follow(item.userId);
          return result?.friendship_status?.outgoing_request;
        },
        onDone: (item, requested) => onFollowDone(item, requested),
      });
      queue.register('fm-unfollow', {
        run: (item) => api.unfollow(item.userId),
        onDone: (item) => onUnfollowDone(item),
      });
      const last = store.get('igs-fm-last', null);
      if (last) loadSnapshot(last);
    },
    mount(el) { container = el; update(); },
    unmount() { if (state.profile) store.save('igs-fm-last', state.profile.username); },
    onQueueChange() { if (container) update(); },
  };
})();
