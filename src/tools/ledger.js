// Ledger — scan YOUR followers/following, diff over time, dashboard, growth
// chart, activity feed, paced unfollow. Rendered with lit-html: a `template()`
// built from small named sub-templates describes the whole tool and `update()`
// re-renders it; lit diffs so search focus and scroll survive partial state
// changes (no manual partial re-renders).
import { html, render, nothing } from 'lit-html';
import { live } from 'lit-html/directives/live.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { repeat } from 'lit-html/directives/repeat.js';
import { ROW_CAP } from '../core/constants.js';
import { store } from '../core/store.js';
import { queue } from '../core/queue.js';
import { api, RateLimit, scanList } from '../core/api.js';
import { byId, fmt, fmtAgo, fmtDate, fmtDelta, $ } from '../core/utils.js';
import { avatar, badge, profileLink, toast, scanOverlay, chartSVG } from '../ui/components.js';

export const ledger = (() => {
  // ── storage keys, limits & state ──
  const KEYS = { current: 'igs-ledger-current', previous: 'igs-ledger-previous', timeline: 'igs-ledger-timeline', events: 'igs-ledger-events' };
  const EVENTS_LIMIT = 1500;
  const TIMELINE_LIMIT = 300;
  const UNFOLLOW_TABS = { following: 1, mutuals: 1, nonfollowers: 1 };
  const EMPTY_ANALYSIS = { followers: [], following: [], mutuals: [], fans: [], nonFollowers: [], verified: [], private: [] };

  const state = { tab: 'gained', query: '', scanning: false, selected: new Set() };
  let model = null;
  let container = null;

  // ── data model ──
  // set helpers: keep the users from `list` that are absent from / present in an id-map.
  const usersNotIn = (list, byIdMap) => (list || []).filter((u) => !byIdMap[u.id]);
  const usersIn = (list, byIdMap) => (list || []).filter((u) => byIdMap[u.id]);

  const computeDiff = (prev, curr) => {
    if (!prev) return null;
    const currFollowersById = byId(curr.followers);
    const currFollowingById = byId(curr.following);
    return {
      gained: usersNotIn(curr.followers, byId(prev.followers)),
      lost: usersNotIn(prev.followers, currFollowersById),
      startedFollowing: usersNotIn(curr.following, byId(prev.following)),
      stoppedFollowing: usersNotIn(prev.following, currFollowingById),
    };
  };

  const analyze = (snapshot) => {
    const followersById = byId(snapshot.followers);
    const followingById = byId(snapshot.following);
    return {
      followers: snapshot.followers,
      following: snapshot.following,
      mutuals: usersIn(snapshot.following, followersById),
      fans: usersNotIn(snapshot.followers, followingById),
      nonFollowers: usersNotIn(snapshot.following, followersById),
      verified: snapshot.followers.filter((u) => u.isVerified),
      private: snapshot.followers.filter((u) => u.isPrivate),
    };
  };

  const rebuildModel = () => {
    const curr = store.get(KEYS.current, null);
    const prev = store.get(KEYS.previous, null);
    model = {
      curr,
      prev,
      timeline: store.get(KEYS.timeline, []),
      events: store.get(KEYS.events, []),
      analysis: curr ? analyze(curr) : EMPTY_ANALYSIS,
      diff: computeDiff(prev, curr),
    };
    return model;
  };

  const commitScan = (curr) => {
    const prev = store.get(KEYS.current, null);
    const diff = computeDiff(prev, curr);
    if (diff) {
      let events = store.get(KEYS.events, []);
      const appendEvents = (users, type) => {
        for (const u of users) {
          events.push({ ts: curr.ts, type, id: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified });
        }
      };
      appendEvents(diff.gained, 'gained');
      appendEvents(diff.lost, 'lost');
      appendEvents(diff.startedFollowing, 'followed');
      appendEvents(diff.stoppedFollowing, 'unfollowed');
      if (events.length > EVENTS_LIMIT) events = events.slice(-EVENTS_LIMIT);
      store.save(KEYS.events, events);
    }

    let timeline = store.get(KEYS.timeline, []);
    timeline.push({ ts: curr.ts, f: curr.counts.followers, g: curr.counts.following });
    if (timeline.length > TIMELINE_LIMIT) timeline = timeline.slice(-TIMELINE_LIMIT);
    store.save(KEYS.timeline, timeline);

    if (prev) store.save(KEYS.previous, prev);
    const storedOk = store.save(KEYS.current, curr);
    return { diff, storedOk };
  };

  // queue 'unfollow' handler: drop from following snapshot + log on success
  const afterUnfollow = (item) => {
    const curr = store.get(KEYS.current, null);
    if (curr) {
      const before = curr.following.length;
      curr.following = curr.following.filter((u) => u.id !== item.userId);
      if (curr.following.length !== before) {
        curr.counts.following = curr.following.length;
        store.save(KEYS.current, curr);
      }
      let events = store.get(KEYS.events, []);
      events.push({ ts: Date.now(), type: 'unfollowed', id: item.userId, username: item.username, fullName: item.fullName, isVerified: item.isVerified });
      if (events.length > EVENTS_LIMIT) events = events.slice(-EVENTS_LIMIT);
      store.save(KEYS.events, events);
    }
    rebuildModel();
  };

  // ── templates ──
  const rowTpl = (u, opts = {}) => {
    const queueStatus = opts.queueAware ? queue.statusOf(u.id, 'unfollow') : null;
    const badges = [
      u.isVerified ? badge('✓ verified', 'v') : nothing,
      u.isPrivate ? badge('private') : nothing,
      opts.badge ? badge(opts.badge, opts.badgeClass || '') : nothing,
    ];

    let right = nothing;
    if (queueStatus) {
      const statusLabel = { pending: 'queued', running: 'unfollowing…', done: 'unfollowed ✓', failed: 'failed' }[queueStatus] || queueStatus;
      right = html`<span class="qbadge ${queueStatus}">${statusLabel}</span>`;
    } else if (opts.unfollowable) {
      right = html`<button class="actbtn" @click=${() => enqueueUnfollow([u.id])}>Unfollow</button>`;
    }

    const when = opts.when ? html`<span class="when">${opts.when}</span>` : nothing;

    let checkboxTpl = nothing;
    if (opts.selectable && queueStatus) {
      checkboxTpl = html`<span style="min-width:44px;flex:none"></span>`;
    } else if (opts.selectable) {
      checkboxTpl = html`<label class="ckwrap"><input type="checkbox" class="ck" .checked=${live(state.selected.has(u.id))} @change=${(event) => toggleSel(u.id, event.target.checked)}></label>`;
    }

    const nameTpl = u.fullName ? html`<div class="fn">${u.fullName}</div>` : nothing;
    return html`<div class="row${queueStatus === 'done' ? ' q-done' : ''}">${checkboxTpl}${avatar(u)}<div class="meta"><div class="u">${profileLink(u.username)}</div>${nameTpl}</div>${badges}${when}${right}</div>`;
  };

  const listTpl = (users, opts = {}) => {
    const query = state.query.toLowerCase();
    const filtered = query ? users.filter((u) => u.username?.toLowerCase().includes(query) || u.fullName?.toLowerCase().includes(query)) : users;
    if (!filtered.length) {
      const hint = query ? ` for “${state.query}”` : '';
      return html`<div class="empty">${opts.empty || `Nothing here${hint}.`}</div>`;
    }
    const shown = filtered.slice(0, ROW_CAP);
    // keyed so a broken-image avatar node (swapped imperatively in @error) is
    // never recycled onto a different user when the list filters/reorders.
    const rows = repeat(shown, (u) => u.id ?? u.username, (u) => rowTpl(u, typeof opts.row === 'function' ? opts.row(u) : opts.row));
    return html`<div class="rows">${rows}</div>${filtered.length > shown.length ? html`<div class="more">Showing first ${fmt(shown.length)} of ${fmt(filtered.length)} — search to narrow.</div>` : nothing}`;
  };

  const tabUsers = (key, model) => {
    const analysis = model.analysis;
    const diff = model.diff || { gained: [], lost: [] };
    return ({ gained: diff.gained, lost: diff.lost, nonfollowers: analysis.nonFollowers, fans: analysis.fans, mutuals: analysis.mutuals, followers: analysis.followers, following: analysis.following })[key] || [];
  };

  const ACT_LABELS = { gained: ['new follower', ''], lost: ['unfollowed you', 'red'], followed: ['you followed', ''], unfollowed: ['you unfollowed', 'red'] };
  const activityTpl = (events) => {
    if (!events.length) return html`<div class="empty">No history yet. Scans and unfollows are logged here.</div>`;
    const query = state.query.toLowerCase();
    let feed = events.slice().reverse();
    if (query) feed = feed.filter((event) => event.username?.toLowerCase().includes(query));
    const rows = feed.slice(0, ROW_CAP).map((event) => {
      const [badgeText, badgeClass] = ACT_LABELS[event.type] || [event.type, ''];
      return rowTpl(event, { badge: badgeText, badgeClass, when: fmtAgo(event.ts) });
    });
    return html`<div class="rows">${rows}</div>`;
  };

  const tabDefs = (model) => {
    const analysis = model.analysis;
    const events = model.events;
    const diff = model.diff || { gained: [], lost: [], startedFollowing: [], stoppedFollowing: [] };
    const unfollowRowOpts = { selectable: true, unfollowable: true, queueAware: true };
    return {
      gained: { label: 'New followers', count: diff.gained.length, render: () => listTpl(diff.gained, { empty: 'No new followers since the previous scan.', row: { badge: 'new' } }) },
      lost: { label: 'Removed follow', count: diff.lost.length, render: () => listTpl(diff.lost, { empty: 'Nobody unfollowed you since the previous scan.', row: { badge: 'unfollowed you', badgeClass: 'red' } }) },
      nonfollowers: { label: "Don't follow back", count: analysis.nonFollowers.length, render: () => listTpl(analysis.nonFollowers, { empty: 'Everyone you follow follows you back.', row: unfollowRowOpts }) },
      fans: { label: 'Fans', count: analysis.fans.length, render: () => listTpl(analysis.fans, { empty: 'No one-way fans.', row: { badge: 'you don’t follow' } }) },
      mutuals: { label: 'Mutuals', count: analysis.mutuals.length, render: () => listTpl(analysis.mutuals, { empty: 'No mutuals yet.', row: unfollowRowOpts }) },
      followers: { label: 'All followers', count: analysis.followers.length, render: () => listTpl(analysis.followers, { empty: 'No followers loaded — run a scan.' }) },
      following: { label: 'Following', count: analysis.following.length, render: () => listTpl(analysis.following, { empty: 'Not following anyone, or no scan yet.', row: unfollowRowOpts }) },
      activity: { label: 'Activity', count: events.length, render: () => activityTpl(events) },
    };
  };

  const metricTpl = (value, label, delta = nothing) => html`<div class="metric"><div class="v">${value}</div>${delta}<div class="l">${label}</div></div>`;
  const deltaTpl = (value) => {
    if (value == null) return nothing;
    let cls = '';
    let arrow = '';
    if (value > 0) {
      cls = 'up';
      arrow = '▲ ';
    } else if (value < 0) {
      cls = 'down';
      arrow = '▼ ';
    }
    return html`<div class="d ${cls}">${arrow}${fmtDelta(value)} since last</div>`;
  };
  const metricsTpl = (model) => {
    const curr = model.curr;
    if (!curr) return nothing;
    const analysis = model.analysis;
    const diff = model.diff;
    const followerCount = curr.counts.followers;
    const followingCount = curr.counts.following;
    const netFollowers = diff ? diff.gained.length - diff.lost.length : null;
    const ratio = followerCount ? followingCount / followerCount : null;
    return [
      metricTpl(fmt(followerCount), 'Followers', deltaTpl(netFollowers)),
      metricTpl(fmt(followingCount), 'Following'),
      metricTpl(diff ? fmtDelta(diff.gained.length) : '—', 'Gained', diff ? html`<div class="d up">new followers</div>` : nothing),
      metricTpl(diff ? fmtDelta(-diff.lost.length) : '—', 'Removed', diff ? html`<div class="d down">unfollowed you</div>` : nothing),
      metricTpl(fmt(analysis.mutuals.length), 'Mutuals'),
      metricTpl(fmt(analysis.nonFollowers.length), 'No follow-back'),
      metricTpl(fmt(analysis.fans.length), 'Fans'),
      metricTpl(fmt(analysis.verified.length), 'Verified'),
      metricTpl(fmt(analysis.private.length), 'Private'),
      metricTpl(ratio == null ? '—' : ratio.toFixed(2), 'Follow ratio'),
      metricTpl(diff ? fmtDelta(diff.startedFollowing.length) : '—', 'You followed'),
      metricTpl(diff ? fmtDelta(-diff.stoppedFollowing.length) : '—', 'You unfollowed'),
    ];
  };

  const selToolTpl = (model) => {
    const selectable = tabUsers(state.tab, model).filter((u) => !queue.statusOf(u.id, 'unfollow'));
    const selectedCount = state.selected.size;
    return html`<div class="seltool">
      <button class="ghost" @click=${() => selAction('all')}>Select all (${fmt(selectable.length)})</button>
      <button class="ghost" @click=${() => selAction('none')}>Clear</button>
      <span class="sc"><b>${fmt(selectedCount)}</b> selected</span><span class="sp"></span>
      <button class="primary" ?disabled=${!selectedCount} @click=${() => selAction('go')}>Unfollow selected →</button></div>`;
  };

  const tabOrder = ['gained', 'lost', 'nonfollowers', 'fans', 'mutuals', 'followers', 'following', 'activity'];

  // top toolbar: title, last-scan note, Scan now / Export actions.
  const headerToolbarTpl = (curr, hasData) => html`<div class="toolbar"><h3>Your followers &amp; following</h3>
        <span class="note" style="margin:0">last scan: ${curr ? fmtAgo(curr.ts) : 'never'}</span><span class="sp" style="flex:1"></span>
        <button class="primary" @click=${runScan}>Scan now</button>
        <button class="ghost" ?disabled=${!hasData} @click=${exportJSON}>Export</button></div>`;

  // dashboard: metrics grid + growth chart once we have data, else a getting-started hint.
  const dashboardTpl = (model, hasData) => hasData
    ? html`<div class="kicker"><span class="accent">●</span> Dashboard — ${fmtDate(model.curr.ts)}</div>
          <div class="metrics">${metricsTpl(model)}</div>
          <div class="kicker">Growth over time</div>
          <div class="chartbox">${unsafeHTML(chartSVG(model.timeline))}<div class="legend"><span><i style="border-color:#e4002b"></i>followers</span><span><i style="border-color:#bbb"></i>following</span></div></div>`
    : html`<div class="kicker"><span class="accent">●</span> Getting started</div><div class="note">No snapshot yet. Hit <b>Scan now</b> to capture who follows you, then scan again to see who joined and who left.</div>`;

  // breakdown: the row of category tabs with per-tab counts.
  const breakdownTpl = (tabs) => html`<div class="kicker">Breakdown — select on Following / Mutuals / Don’t-follow-back to unfollow</div>
      <div class="tabs">${tabOrder.map((key) => html`<button class="tab${state.tab === key ? ' on' : ''}" @click=${() => { state.tab = key; update(); }}>${tabs[key].label}<span class="n">${fmt(tabs[key].count)}</span></button>`)}</div>`;

  // active tab: header + search box, then the rendered user list / activity feed.
  const listSectionTpl = (tabs) => html`<div class="toolbar"><h3>${tabs[state.tab].label}</h3><input class="search" placeholder="Search username or name…" .value=${live(state.query)} @input=${onSearch}></div>
      <div>${tabs[state.tab].render()}</div>`;

  const template = () => {
    if (!model) rebuildModel();
    const curr = model.curr;
    const hasData = !!curr;
    const tabs = tabDefs(model);
    if (!tabs[state.tab]) state.tab = 'gained';
    return html`
      ${headerToolbarTpl(curr, hasData)}
      ${hasData && !model.prev ? html`<div class="note">Baseline saved. Scan again later for a full change report.</div>` : nothing}
      ${dashboardTpl(model, hasData)}
      ${breakdownTpl(tabs)}
      ${UNFOLLOW_TABS[state.tab] && hasData ? selToolTpl(model) : nothing}
      ${listSectionTpl(tabs)}`;
  };
  const update = () => render(template(), container);

  // ── actions ──
  const onSearch = (event) => {
    state.query = event.target.value;
    update();
  };

  const toggleSel = (id, on) => {
    if (on) {
      state.selected.add(id);
    } else {
      state.selected.delete(id);
    }
    update();
  };

  const selAction = (action) => {
    if (action === 'all') {
      tabUsers(state.tab, model).forEach((u) => {
        if (!queue.statusOf(u.id, 'unfollow')) state.selected.add(u.id);
      });
      update();
    } else if (action === 'none') {
      state.selected.clear();
      update();
    } else if (action === 'go') {
      unfollowSelected();
    }
  };

  const enqueueUnfollow = (ids) => {
    const followingById = byId(model.analysis.following);
    const users = ids.map((id) => followingById[id]).filter((u) => u && !queue.statusOf(u.id, 'unfollow'));
    queue.enqueue(users.map((u) => ({ kind: 'unfollow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified })));
  };

  const unfollowSelected = () => {
    const followingById = byId(model.analysis.following);
    const users = [...state.selected].map((id) => followingById[id]).filter((u) => u && !queue.statusOf(u.id, 'unfollow'));
    if (!users.length) return;
    const speed = queue.speed();
    const mins = Math.max(1, Math.round(users.length * ((speed.min + speed.max) / 2) / 60000));
    if (!confirm(`Unfollow ${users.length} account(s)? One at a time on "${speed.label}" pace, ~${mins} min. Survives refresh; pause/cancel anytime.`)) return;
    queue.enqueue(users.map((u) => ({ kind: 'unfollow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified })));
    state.selected.clear();
    update();
  };

  const exportJSON = () => {
    const dump = { exportedAt: new Date().toISOString(), current: store.get(KEYS.current, null), previous: store.get(KEYS.previous, null), timeline: store.get(KEYS.timeline, []), events: store.get(KEYS.events, []) };
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
    anchor.download = `instagram-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 4000);
  };

  const runScan = async () => {
    if (state.scanning) return;
    if (!api.loggedIn) {
      toast('Open instagram.com logged in to scan');
      return;
    }
    state.scanning = true;
    let cancelled = false;
    const overlay = scanOverlay('Starting…');
    $('[data-cancel]', overlay).onclick = () => {
      cancelled = true;
      $('[data-st]', overlay).textContent = 'Cancelling…';
    };
    const prevCount = store.get(KEYS.current, null)?.counts ?? {};
    const progress = (kind, loaded, total) => {
      const base = kind === 'followers' ? 0 : 60;
      const span = kind === 'followers' ? 60 : 40;
      const known = total || prevCount[kind] || loaded + 1;
      const pct = Math.min(100, Math.round(base + span * Math.min(1, loaded / Math.max(1, known))));
      $('[data-prog]', overlay).style.width = `${pct}%`;
      $('[data-pct]', overlay).textContent = `${pct}%`;
      const totalTxt = total ? ` / ${fmt(total)}` : '';
      $('[data-st]', overlay).textContent = `Loading ${kind} — ${fmt(loaded)}${totalTxt}…`;
    };
    try {
      const followers = await scanList('followers', progress, api.viewerId, () => cancelled);
      const following = await scanList('following', progress, api.viewerId, () => cancelled);
      $('[data-prog]', overlay).style.width = '100%';
      $('[data-pct]', overlay).textContent = '100%';
      const snapshot = { ts: Date.now(), counts: { followers: followers.length, following: following.length }, followers, following };
      const out = commitScan(snapshot);
      if (!out.storedOk) toast('Scan stored partially (storage full)');
      state.scanning = false;
      overlay.remove();
      rebuildModel();
      update();
      toast(out.diff ? `${out.diff.gained.length} new · ${out.diff.lost.length} removed since last scan` : 'Baseline captured — scan again later');
    } catch (err) {
      state.scanning = false;
      overlay.remove();
      if (cancelled || /cancelled/.test(String(err?.message))) {
        toast('Scan cancelled — nothing saved');
      } else if (err instanceof RateLimit) {
        toast('Rate-limited — nothing saved. Wait ~10–15 min.');
      } else {
        toast(`Scan failed: ${err?.message || err}`);
      }
    }
  };

  // ── tool API ──
  return {
    id: 'ledger',
    label: 'Ledger',
    boot() {
      queue.register('unfollow', { run: (item) => api.unfollow(item.userId), onDone: (item) => afterUnfollow(item) });
    },
    mount(el) {
      container = el;
      rebuildModel();
      update();
    },
    unmount() {},
    onQueueChange() {
      rebuildModel();
      if (container) update();
    },
  };
})();
