// Followers — load one or more profiles' followers (comma-separated), enrich
// cards (posts/highlights/mutuals) on demand, filter locally, follow/unfollow.
// Rendered with lit-html: one `template()` describes the whole tool and
// `update()` re-renders it; lit diffs so the search caret and page scroll
// survive queue-driven re-renders (no manual partials).
import { html, render, nothing } from 'lit-html';
import { live } from 'lit-html/directives/live.js';
import { repeat } from 'lit-html/directives/repeat.js';
import { ROW_CAP } from '../core/constants.js';
import { store } from '../core/store.js';
import { queue } from '../core/queue.js';
import { api, RateLimit, scanList } from '../core/api.js';
import { guessGender } from '../core/gender.js';
import { fmt, $, detectUsername } from '../core/utils.js';
import { avatar, badge, profileLink, toast, scanOverlay } from '../ui/components.js';

export const followers = (() => {
  // ── state ──
  // profiles: [{ profile, users, partial? }] — one entry per loaded profile.
  // users: merged de-duplicated view across them (u.sources = source usernames).
  const state = { profiles: [], users: [], query: '', filters: new Set(), ranges: {}, scanning: false, hoverZoom: false, mix: false };
  let container = null;

  // ── data model ──
  const snapKey = (name) => `igs-fm-snap-${name.toLowerCase()}`;
  const parseNames = (raw) => [...new Set(String(raw || '').split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean))];
  const loadedNames = () => state.profiles.map((entry) => entry.profile.username);

  // Rebuild the merged view. First occurrence wins (shared reference, so card
  // mutations land back in that profile's snapshot); duplicates union `sources`
  // and fill in relationship flags / enrichment the first copy didn't know.
  const mergeUsers = () => {
    const map = new Map();
    for (const entry of state.profiles) {
      for (const u of entry.users) {
        const seen = map.get(u.id);
        if (!seen) {
          u.sources = [entry.profile.username];
          map.set(u.id, u);
        } else {
          seen.sources.push(entry.profile.username);
          for (const key of ['followedByViewer', 'requestedByViewer', 'followsViewer']) {
            if (seen[key] == null && u[key] != null) seen[key] = u[key];
          }
          if (!seen.enriched && u.enriched) seen.enriched = u.enriched;
        }
      }
    }
    state.users = [...map.values()];
    for (const u of state.users) u.gender = guessGender(u);
  };

  // picUrl is dropped from persisted users: IG CDN URLs expire within days
  // anyway, and they dominate snapshot size (10k+ avatars ≈ the whole ~5MB
  // localStorage quota — the silent cause of lost scans). Avatars fall back to
  // letters after a reload until re-scan/enrich. sources/gender are recomputed
  // by mergeUsers on load.
  const slim = ({ picUrl, sources, gender, _enriching, ...u }) => u;
  const persistSnapshots = () => {
    let ok = true;
    for (const entry of state.profiles) {
      ok = store.save(snapKey(entry.profile.username), { profile: entry.profile, users: entry.users.map(slim), ts: Date.now(), partial: entry.partial }) && ok;
    }
    if (!ok) toast('Storage full — snapshot(s) only partially saved. Export as backup!');
  };
  const snapshotEntry = (name) => {
    const snap = store.get(snapKey(name), null);
    return snap ? { profile: snap.profile, users: snap.users || [], partial: snap.partial } : null;
  };

  // Apply fn to every copy of the user (merged view + each profile's list).
  const forUser = (id, fn) => {
    for (const list of [state.users, ...state.profiles.map((entry) => entry.users)]) {
      const u = list.find((x) => x.id === id);
      if (u) fn(u);
    }
  };

  // queue handlers mutate the loaded follower's relationship flag + persist
  const onFollowDone = (item, requested) => {
    forUser(item.userId, (u) => {
      u.followedByViewer = !requested;
      u.requestedByViewer = !!requested;
    });
    persistSnapshots();
  };
  const onUnfollowDone = (item) => {
    forUser(item.userId, (u) => {
      u.followedByViewer = false;
      u.requestedByViewer = false;
    });
    persistSnapshots();
  };

  // ── filters (all local — no extra requests; unknown flags fail both sides) ──
  const CHIPS = [
    ['public', 'Public', (u) => !u.isPrivate],
    ['private', 'Private', (u) => u.isPrivate],
    ['verified', 'Verified', (u) => u.isVerified],
    ['following', 'You follow', (u) => u.followedByViewer === true],
    ['notfollowing', "You don't follow", (u) => u.followedByViewer === false],
    ['followsyou', 'Follows you', (u) => u.followsViewer === true],
    ['notfollowsyou', "Doesn't follow you", (u) => u.followsViewer === false],
    ['requested', 'Requested', (u) => u.requestedByViewer === true],
    ['mutual', 'Mutual', (u) => u.followedByViewer === true && u.followsViewer === true],
    ['female', 'Female', (u) => u.gender === 'f'],
    ['male', 'Male', (u) => u.gender === 'm'],
    ['nogender', 'Unidentified', (u) => !u.gender],
    ['noname', 'No full name', (u) => !u.fullName],
    ['details', 'Has details', (u) => !!u.enriched],
    ['noposts', 'No posts', (u) => u.enriched?.postsCount === 0],
    ['highlights', 'Has highlights', (u) => !!u.enriched?.highlights?.length],
  ];
  const RANGES = [['followerCount', 'Followers'], ['followingCount', 'Following'], ['postsCount', 'Posts'], ['mutualCount', 'Mutuals']];

  const activePredicates = () => {
    const preds = CHIPS.filter(([key]) => state.filters.has(key)).map(([, , pred]) => pred);
    for (const key of state.filters) {
      if (key === 'inall') preds.push((u) => u.sources?.length === state.profiles.length);
      else if (key.startsWith('src:')) preds.push((u) => u.sources?.includes(key.slice(4)));
    }
    return preds;
  };
  // Count ranges only apply to cards whose details were loaded; others are excluded.
  const matchRanges = (u) => RANGES.every(([key]) => {
    const min = state.ranges[`${key}Min`];
    const max = state.ranges[`${key}Max`];
    if (min == null && max == null) return true;
    const value = u.enriched?.[key];
    return value != null && (min == null || value >= min) && (max == null || value <= max);
  });

  // ── templates ──
  const postThumb = (post) => html`<a href="https://www.instagram.com/p/${post.shortcode}/" target="_blank" rel="noreferrer"><img loading="lazy" src=${post.thumb} alt=""></a>`;
  const highlightChip = (highlight) => html`<span>${highlight.title || '•'}</span>`;
  const enrichRow = (u) => {
    if (!u.enriched) return nothing;
    const enriched = u.enriched;
    // No thumbnails can mean "posted nothing" or "came from the fallback
    // profile lookup, which carries none" — the count is what tells them apart.
    const postsTpl = enriched.posts?.length
      ? html`<div class="thumbs">${enriched.posts.map(postThumb)}</div>`
      : html`<div class="note" style="margin:0">${enriched.postsCount ? `${fmt(enriched.postsCount)} posts` : 'no posts'}</div>`;
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
      u.followedByViewer === true ? badge('you follow', 'ok') : nothing,
      u.followsViewer === true ? badge('follows you', 'blue') : nothing,
      state.profiles.length > 1 ? (u.sources || []).map((source) => badge(`@${source}`)) : nothing,
    ];
    const nameTpl = u.fullName ? html`<div class="fn">${u.fullName}</div>` : nothing;
    return html`<div class="card"><div class="chead">${avatar(u)}<div class="meta"><div class="u">${profileLink(u.username)}</div>${nameTpl}</div>${badges}</div>${enrichRow(u)}<div class="cact">${cardActions(u)}</div></div>`;
  };

  const cardsHTML = () => {
    const queryLower = state.query.toLowerCase();
    const preds = activePredicates();
    const filtered = state.users.filter((u) => preds.every((pred) => pred(u)) && matchRanges(u)
      && (!queryLower || u.username?.toLowerCase().includes(queryLower) || u.fullName?.toLowerCase().includes(queryLower)));
    // "Mix profiles": interleave instead of profile-1-then-profile-2 blocks.
    // Sorting by the id's tail digits is a stable pseudo-shuffle (no reorder churn on re-render).
    if (state.mix && state.profiles.length > 1) {
      const mixKey = (u) => parseInt(String(u.id).slice(-7), 10) || 0;
      filtered.sort((a, b) => mixKey(a) - mixKey(b));
    }
    if (!state.users.length) return html`<div class="empty">No followers loaded yet — hit Scan followers.</div>`;
    if (!filtered.length) return html`<div class="empty">No matches.</div>`;
    const shown = filtered.slice(0, ROW_CAP);
    const more = filtered.length > shown.length
      ? html`<div class="more">Showing ${fmt(shown.length)} of ${fmt(filtered.length)} — search/filter to narrow.</div>`
      : nothing;
    return html`<div class="cards${state.hoverZoom ? ' zoom' : ''}">${repeat(shown, (u) => u.id ?? u.username, cardHTML)}</div>${more}`;
  };

  // ponytail: the Load-profiles input is intentionally uncontrolled — a plain
  // attribute binding seeds it (loaded list/detected) but it is NOT bound to per-
  // keystroke state, so the user's typing survives unrelated queue-driven
  // re-renders. We read its live value via this one [data-user] selector hook.
  const onLoad = () => loadProfiles($('[data-user]', container).value);
  const onSearch = (event) => {
    state.query = event.target.value;
    update();
  };

  const kickerTpl = () => {
    if (!state.profiles.length) return html`<div class="kicker"><span class="accent">●</span> Followers manager</div>`;
    const partial = state.profiles.some((entry) => entry.partial) ? ' · partial scan' : '';
    if (state.profiles.length === 1) {
      const profile = state.profiles[0].profile;
      return html`<div class="kicker"><span class="accent">●</span> ${profile.username} — ${fmt(profile.followerCount)} followers · ${fmt(profile.followingCount)} following${partial}</div>`;
    }
    return html`<div class="kicker"><span class="accent">●</span> ${loadedNames().join(', ')} — ${fmt(state.users.length)} unique followers${partial}</div>`;
  };
  const loadToolbarTpl = (detected) => html`<div class="toolbar"><h3>Load profiles</h3>
        <input class="search" data-user placeholder="username(s), comma-separated" value=${loadedNames().join(', ') || detected || ''}>
        <button class="primary" @click=${onLoad}>Load</button>
        <button class="ghost" @click=${importJSON}>Import</button>
        ${state.profiles.length ? html`<button class="ghost" @click=${runScan}>Scan followers</button><button class="ghost" @click=${exportJSON}>Export</button>` : nothing}
        ${state.profiles.length ? html`<span class="note" style="margin:0">${fmt(state.users.length)} loaded</span>` : nothing}</div>
      ${state.profiles.length ? html`<div class="chips" style="margin:0 0 4px">
        ${state.profiles.map((entry) => html`<button class="chip" title="Remove and delete this profile's saved scan" @click=${() => removeProfile(entry.profile.username)}>@${entry.profile.username} ✕</button>`)}
        <button class="chip" title="Delete all saved followers scans" @click=${clearAll}>Clear all ✕</button></div>` : nothing}`;
  const followersToolbarTpl = () => html`<div class="toolbar"><h3>Followers</h3><input class="search" placeholder="Search…" .value=${live(state.query)} @input=${onSearch}>
      <button class="chip${state.hoverZoom ? ' on' : ''}" title="Enlarge profile photos on hover" @click=${() => { state.hoverZoom = !state.hoverZoom; update(); }}>Hover zoom</button>
      ${state.profiles.length > 1 ? html`<button class="chip${state.mix ? ' on' : ''}" title="Interleave all profiles instead of one block per profile" @click=${() => { state.mix = !state.mix; update(); }}>Mix profiles</button>` : nothing}</div>`;

  const clearFilters = () => {
    state.filters.clear();
    state.ranges = {};
    update();
  };
  const toggleChip = (key) => {
    if (state.filters.has(key)) state.filters.delete(key);
    else state.filters.add(key);
    update();
  };
  const filterChipsTpl = () => {
    const dynamic = state.profiles.length > 1
      ? [...loadedNames().map((name) => [`src:${name}`, `@${name}`]), ['inall', 'In all profiles']]
      : [];
    const chips = [...CHIPS.map(([key, label]) => [key, label]), ...dynamic];
    const anyActive = state.filters.size || Object.keys(state.ranges).length;
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
      <span class="note" style="margin:0">ranges use per-card “Load details” data</span></div>`;

  const template = () => {
    const detected = detectUsername();
    return html`
      ${kickerTpl()}
      ${loadToolbarTpl(detected)}
      ${state.profiles.length
        ? html`${followersToolbarTpl()}
          ${filterChipsTpl()}
          ${rangesTpl()}
          <div>${cardsHTML()}</div>`
        : html`<div class="note">Open or type profiles (comma-separated), Load, then Scan followers. Details (posts, highlights, mutuals) load per-card on demand.</div>`}`;
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
      persistSnapshots();
      update();
    } catch (err) {
      toast(err instanceof RateLimit ? 'Rate-limited — wait a bit' : `Couldn’t load @${u.username}`);
    } finally {
      u._enriching = false;
    }
  };

  const loadProfiles = async (raw) => {
    const names = parseNames(raw);
    if (!names.length) return;
    const entries = [];
    for (const name of names) {
      let entry = snapshotEntry(name);
      if (api.loggedIn) {
        try {
          const webProfile = await api.getWebProfile(name);
          const profile = {
            id: webProfile.id,
            username: webProfile.username,
            fullName: webProfile.fullName,
            picUrl: webProfile.picUrl,
            followerCount: webProfile.followerCount,
            followingCount: webProfile.followingCount,
            isPrivate: webProfile.isPrivate,
            isVerified: webProfile.isVerified,
          };
          entry = { profile, users: entry?.users || [], partial: entry?.partial };
        } catch (err) {
          if (!entry) {
            toast(`Couldn’t load @${name}: ${err?.message || err}`);
            continue;
          }
        }
      } else if (!entry) {
        toast(`No saved data for @${name} — open instagram.com logged in`);
        continue;
      }
      entries.push(entry);
    }
    if (!entries.length) return;
    state.profiles = entries;
    // drop filters pointing at profiles no longer loaded
    for (const key of [...state.filters]) {
      if ((key.startsWith('src:') && !loadedNames().includes(key.slice(4))) || (key === 'inall' && state.profiles.length < 2)) state.filters.delete(key);
    }
    mergeUsers();
    persistSnapshots();
    store.save('igs-fm-last', loadedNames().join(','));
    update();
  };

  const runScan = async () => {
    if (state.scanning || !state.profiles.length) return;
    if (!api.loggedIn) {
      toast('Open instagram.com logged in to scan');
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
    const count = state.profiles.length;
    try {
      for (const [index, entry] of state.profiles.entries()) {
        if (cancelled || stopped) break;
        const name = entry.profile.username;
        const expected = entry.profile.followerCount;
        const step = count > 1 ? ` (${index + 1}/${count})` : '';
        const progress = (kind, loaded) => {
          const percent = Math.min(100, Math.round(loaded / Math.max(1, expected) * 100));
          $('[data-prog]', overlay).style.width = `${percent}%`;
          $('[data-pct]', overlay).textContent = `${percent}%`;
          $('[data-st]', overlay).textContent = `@${name}${step} — ${fmt(loaded)} / ${fmt(expected)}…`;
        };
        entry.users = await scanList('followers', progress, entry.profile.id, () => cancelled, () => stopped);
        entry.partial = stopped || undefined;
      }
      mergeUsers();
      persistSnapshots();
      toast(stopped
        ? `Stopped — kept ${fmt(state.users.length)} followers loaded so far`
        : `Loaded ${fmt(state.users.length)} unique followers`);
    } catch (err) {
      // profiles fully scanned before the failure keep their fresh lists
      mergeUsers();
      persistSnapshots();
      if (cancelled || /cancelled/.test(String(err?.message))) toast('Scan cancelled');
      else if (err instanceof RateLimit) toast('Rate-limited — wait ~10–15 min');
      else toast(`Scan failed: ${err?.message || err}`);
    } finally {
      state.scanning = false;
      overlay.remove();
      update();
    }
  };
  const removeProfile = (name) => {
    if (!confirm(`Remove @${name} and delete its saved scan?`)) return;
    store.remove(snapKey(name));
    state.profiles = state.profiles.filter((entry) => entry.profile.username !== name);
    for (const key of [...state.filters]) {
      if (key === `src:${name}` || (key === 'inall' && state.profiles.length < 2)) state.filters.delete(key);
    }
    mergeUsers();
    if (state.profiles.length) store.save('igs-fm-last', loadedNames().join(','));
    else store.remove('igs-fm-last');
    update();
  };
  const clearAll = () => {
    if (!confirm('Remove all loaded profiles and delete every saved followers scan?')) return;
    try {
      Object.keys(localStorage).filter((key) => key.startsWith('igs-fm-')).forEach((key) => store.remove(key));
    } catch { /* sandboxed: nothing persisted anyway */ }
    state.profiles = [];
    state.users = [];
    state.filters.clear();
    state.ranges = {};
    update();
  };

  // Restore an Export file. Per-profile lists are rebuilt from each merged
  // user's `sources`; old single-profile exports ({profile, users}) also work.
  const importJSON = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      try {
        const dump = JSON.parse(await input.files[0].text());
        const profiles = dump.profiles || (dump.profile ? [dump.profile] : []);
        if (!profiles.length || !Array.isArray(dump.users)) throw new Error('not a followers export');
        state.profiles = profiles.map((p) => ({
          profile: { id: p.id, username: p.username, fullName: p.fullName, picUrl: p.picUrl, followerCount: p.followerCount, followingCount: p.followingCount, isPrivate: p.isPrivate, isVerified: p.isVerified },
          users: dump.users.filter((u) => !u.sources || u.sources.includes(p.username)),
          partial: p.partial || undefined,
        }));
        mergeUsers();
        persistSnapshots();
        store.save('igs-fm-last', loadedNames().join(','));
        update();
        toast(`Imported ${fmt(state.users.length)} followers across ${state.profiles.length} profile(s)`);
      } catch (err) {
        toast(`Import failed: ${err?.message || err}`);
      }
    };
    input.click();
  };
  const exportJSON = () => {
    if (!state.profiles.length) return;
    const dump = {
      exportedAt: new Date().toISOString(),
      profiles: state.profiles.map((entry) => ({ ...entry.profile, partial: !!entry.partial, followerCountLoaded: entry.users.length })),
      users: state.users,
    };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
    link.download = `instagram-followers-${loadedNames().join('+')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  };

  // ── lifecycle ──
  return {
    id: 'followers', label: 'Followers', requiresLogin: true, // needs the live IG API
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
      if (last) {
        state.profiles = parseNames(last).map(snapshotEntry).filter(Boolean);
        mergeUsers();
      }
    },
    mount(el) { container = el; update(); },
    unmount() { if (state.profiles.length) store.save('igs-fm-last', loadedNames().join(',')); },
    onQueueChange() { if (container) update(); },
  };
})();
