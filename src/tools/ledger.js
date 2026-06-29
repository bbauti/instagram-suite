// Ledger — scan YOUR followers/following, diff over time, dashboard, growth
// chart, activity feed, paced unfollow.
import { ROW_CAP } from '../core/constants.js';
import { store } from '../core/store.js';
import { queue } from '../core/queue.js';
import { api, RateLimit, scanList } from '../core/api.js';
import { byId, esc, fmt, fmtAgo, fmtDate, fmtDelta, $, $$ } from '../core/utils.js';
import { avatar, badge, profileLink, toast, scanOverlay, chartSVG } from '../ui/components.js';

export const ledger = (() => {
  const K = { current: 'igs-ledger-current', previous: 'igs-ledger-previous', timeline: 'igs-ledger-timeline', events: 'igs-ledger-events' };
  const EVENTS_LIMIT = 1500, TIMELINE_LIMIT = 300;
  const UNFOLLOW_TABS = { following: 1, mutuals: 1, nonfollowers: 1 };
  const EMPTY_AN = { followers: [], following: [], mutuals: [], fans: [], nonFollowers: [], verified: [], private: [] };
  const st = { tab: 'gained', query: '', scanning: false, selected: new Set() };
  let MODEL = null, container = null;

  const not = (list, other) => (list || []).filter((u) => !other[u.id]);
  const inter = (list, other) => (list || []).filter((u) => other[u.id]);
  const computeDiff = (prev, curr) => {
    if (!prev) return null;
    const cf = byId(curr.followers), cg = byId(curr.following);
    return {
      gained: not(curr.followers, byId(prev.followers)), lost: not(prev.followers, cf),
      startedFollowing: not(curr.following, byId(prev.following)), stoppedFollowing: not(prev.following, cg),
    };
  };
  const analyze = (snap) => {
    const fMap = byId(snap.followers), gMap = byId(snap.following);
    return {
      followers: snap.followers, following: snap.following,
      mutuals: inter(snap.following, fMap), fans: not(snap.followers, gMap), nonFollowers: not(snap.following, fMap),
      verified: snap.followers.filter((u) => u.isVerified), private: snap.followers.filter((u) => u.isPrivate),
    };
  };
  const rebuildModel = () => {
    const curr = store.get(K.current, null), prev = store.get(K.previous, null);
    MODEL = { curr, prev, timeline: store.get(K.timeline, []), events: store.get(K.events, []), an: curr ? analyze(curr) : EMPTY_AN, diff: computeDiff(prev, curr) };
    return MODEL;
  };
  const commitScan = (curr) => {
    const prev = store.get(K.current, null);
    const diff = computeDiff(prev, curr);
    if (diff) {
      let events = store.get(K.events, []);
      const push = (arr, type) => { for (const u of arr) events.push({ ts: curr.ts, type, id: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified }); };
      push(diff.gained, 'gained'); push(diff.lost, 'lost'); push(diff.startedFollowing, 'followed'); push(diff.stoppedFollowing, 'unfollowed');
      if (events.length > EVENTS_LIMIT) events = events.slice(-EVENTS_LIMIT);
      store.save(K.events, events);
    }
    let timeline = store.get(K.timeline, []);
    timeline.push({ ts: curr.ts, f: curr.counts.followers, g: curr.counts.following });
    if (timeline.length > TIMELINE_LIMIT) timeline = timeline.slice(-TIMELINE_LIMIT);
    store.save(K.timeline, timeline);
    if (prev) store.save(K.previous, prev);
    const storedOk = store.save(K.current, curr);
    return { diff, storedOk };
  };
  // queue 'unfollow' handler: drop from following snapshot + log on success
  const afterUnfollow = (item) => {
    const curr = store.get(K.current, null);
    if (curr) {
      const before = curr.following.length;
      curr.following = curr.following.filter((u) => u.id !== item.userId);
      if (curr.following.length !== before) { curr.counts.following = curr.following.length; store.save(K.current, curr); }
      let events = store.get(K.events, []);
      events.push({ ts: Date.now(), type: 'unfollowed', id: item.userId, username: item.username, fullName: item.fullName, isVerified: item.isVerified });
      if (events.length > EVENTS_LIMIT) events = events.slice(-EVENTS_LIMIT);
      store.save(K.events, events);
    }
    rebuildModel();
  };

  const rowOf = (u, opts = {}) => {
    const qs = opts.queueAware ? queue.statusOf(u.id, 'unfollow') : null;
    let badges = '';
    if (u.isVerified) badges += badge('✓ verified', 'v');
    if (u.isPrivate) badges += badge('private');
    if (opts.badge) badges += badge(opts.badge, opts.badgeClass || '');
    let right = '';
    if (qs) {
      const lab = { pending: 'queued', running: 'unfollowing…', done: 'unfollowed ✓', failed: 'failed' }[qs] || qs;
      right = `<span class="qbadge ${qs}">${lab}</span>`;
    } else if (opts.unfollowable) {
      right = `<button class="actbtn" data-act="unfollow" data-uid="${esc(u.id)}">Unfollow</button>`;
    }
    const when = opts.when ? `<span class="when">${esc(opts.when)}</span>` : '';
    let ck = '';
    if (opts.selectable && qs) ck = '<span style="min-width:44px;flex:none"></span>';
    else if (opts.selectable) {
      const checked = st.selected.has(u.id) ? ' checked' : '';
      ck = `<label class="ckwrap"><input type="checkbox" class="ck" data-uid="${esc(u.id)}"${checked}></label>`;
    }
    const fn = u.fullName ? `<div class="fn">${esc(u.fullName)}</div>` : '';
    return `<div class="row${qs === 'done' ? ' q-done' : ''}">${ck}${avatar(u)}` +
      `<div class="meta"><div class="u">${profileLink(u.username)}</div>${fn}</div>${badges}${when}${right}</div>`;
  };
  const listHTML = (users, opts = {}) => {
    const q = st.query.toLowerCase();
    const filtered = q ? users.filter((u) => u.username?.toLowerCase().includes(q) || u.fullName?.toLowerCase().includes(q)) : users;
    if (!filtered.length) {
      const hint = q ? ` for “${st.query}”` : '';
      const msg = opts.empty || `Nothing here${hint}.`;
      return `<div class="empty">${esc(msg)}</div>`;
    }
    const shown = filtered.slice(0, ROW_CAP);
    let html = `<div class="rows">${shown.map((u) => rowOf(u, typeof opts.row === 'function' ? opts.row(u) : opts.row)).join('')}</div>`;
    if (filtered.length > shown.length) html += `<div class="more">Showing first ${fmt(shown.length)} of ${fmt(filtered.length)} — search to narrow.</div>`;
    return html;
  };
  const tabUsers = (key, M = MODEL) => {
    const an = M.an, d = M.diff || { gained: [], lost: [] };
    return ({ gained: d.gained, lost: d.lost, nonfollowers: an.nonFollowers, fans: an.fans, mutuals: an.mutuals, followers: an.followers, following: an.following })[key] || [];
  };
  const ACT_LABELS = { gained: ['new follower', ''], lost: ['unfollowed you', 'red'], followed: ['you followed', ''], unfollowed: ['you unfollowed', 'red'] };
  const activityHTML = (events) => {
    if (!events.length) return '<div class="empty">No history yet. Scans and unfollows are logged here.</div>';
    const q = st.query.toLowerCase();
    let feed = events.slice().reverse();
    if (q) feed = feed.filter((e) => e.username?.toLowerCase().includes(q));
    const rows = feed.slice(0, ROW_CAP).map((e) => {
      const [b, bc] = ACT_LABELS[e.type] || [e.type, ''];
      return rowOf(e, { badge: b, badgeClass: bc, when: fmtAgo(e.ts) });
    }).join('');
    return `<div class="rows">${rows}</div>`;
  };
  const tabDefs = (M) => {
    const an = M.an, events = M.events, d = M.diff || { gained: [], lost: [], startedFollowing: [], stoppedFollowing: [] };
    const uf = { selectable: true, unfollowable: true, queueAware: true };
    return {
      gained: { label: 'New followers', count: d.gained.length, render: () => listHTML(d.gained, { empty: 'No new followers since the previous scan.', row: { badge: 'new' } }) },
      lost: { label: 'Removed follow', count: d.lost.length, render: () => listHTML(d.lost, { empty: 'Nobody unfollowed you since the previous scan.', row: { badge: 'unfollowed you', badgeClass: 'red' } }) },
      nonfollowers: { label: "Don't follow back", count: an.nonFollowers.length, render: () => listHTML(an.nonFollowers, { empty: 'Everyone you follow follows you back.', row: uf }) },
      fans: { label: 'Fans', count: an.fans.length, render: () => listHTML(an.fans, { empty: 'No one-way fans.', row: { badge: 'you don’t follow' } }) },
      mutuals: { label: 'Mutuals', count: an.mutuals.length, render: () => listHTML(an.mutuals, { empty: 'No mutuals yet.', row: uf }) },
      followers: { label: 'All followers', count: an.followers.length, render: () => listHTML(an.followers, { empty: 'No followers loaded — run a scan.' }) },
      following: { label: 'Following', count: an.following.length, render: () => listHTML(an.following, { empty: 'Not following anyone, or no scan yet.', row: uf }) },
      activity: { label: 'Activity', count: events.length, render: () => activityHTML(events) },
    };
  };
  const metricsHTML = (M) => {
    const curr = M.curr;
    if (!curr) return '';
    const an = M.an, d = M.diff;
    const fc = curr.counts.followers, gc = curr.counts.following;
    const netF = d ? d.gained.length - d.lost.length : null;
    const ratio = fc ? gc / fc : null;
    const metric = (v, l, dh = '') => `<div class="metric"><div class="v">${v}</div>${dh}<div class="l">${l}</div></div>`;
    const delta = (n) => {
      if (n == null) return '';
      let cls = '', arrow = '';
      if (n > 0) { cls = 'up'; arrow = '▲ '; } else if (n < 0) { cls = 'down'; arrow = '▼ '; }
      return `<div class="d ${cls}">${arrow}${fmtDelta(n)} since last</div>`;
    };
    return metric(fmt(fc), 'Followers', delta(netF)) + metric(fmt(gc), 'Following') +
      metric(d ? fmtDelta(d.gained.length) : '—', 'Gained', d ? '<div class="d up">new followers</div>' : '') +
      metric(d ? fmtDelta(-d.lost.length) : '—', 'Removed', d ? '<div class="d down">unfollowed you</div>' : '') +
      metric(fmt(an.mutuals.length), 'Mutuals') + metric(fmt(an.nonFollowers.length), 'No follow-back') +
      metric(fmt(an.fans.length), 'Fans') + metric(fmt(an.verified.length), 'Verified') + metric(fmt(an.private.length), 'Private') +
      metric(ratio == null ? '—' : ratio.toFixed(2), 'Follow ratio') +
      metric(d ? fmtDelta(d.startedFollowing.length) : '—', 'You followed') +
      metric(d ? fmtDelta(-d.stoppedFollowing.length) : '—', 'You unfollowed');
  };
  const selToolHTML = (M) => {
    const selectable = tabUsers(st.tab, M).filter((u) => !queue.statusOf(u.id, 'unfollow'));
    const n = st.selected.size;
    return '<div class="seltool">' +
      `<button class="ghost" data-sel="all">Select all (${fmt(selectable.length)})</button>` +
      '<button class="ghost" data-sel="none">Clear</button>' +
      `<span class="sc"><b data-selcount>${fmt(n)}</b> selected</span><span class="sp"></span>` +
      `<button class="primary" data-sel="go"${n ? '' : ' disabled'}>Unfollow selected →</button></div>`;
  };

  const render = () => {
    if (!MODEL) rebuildModel();
    const M = MODEL, curr = M.curr, hasData = !!curr;
    const tabs = tabDefs(M);
    if (!tabs[st.tab]) st.tab = 'gained';
    const firstScanNote = hasData && !M.prev ? '<div class="note">Baseline saved. Scan again later for a full change report.</div>' : '';
    const tabOrder = ['gained', 'lost', 'nonfollowers', 'fans', 'mutuals', 'followers', 'following', 'activity'];
    const tabsHTML = tabOrder.map((key) => `<button class="tab${st.tab === key ? ' on' : ''}" data-tab="${key}">${esc(tabs[key].label)}<span class="n">${fmt(tabs[key].count)}</span></button>`).join('');
    const dashboard = hasData
      ? `<div class="kicker"><span class="accent">●</span> Dashboard — ${esc(fmtDate(curr.ts))}</div>` +
        `<div class="metrics" data-metrics>${metricsHTML(M)}</div>` +
        '<div class="kicker">Growth over time</div>' +
        `<div class="chartbox">${chartSVG(M.timeline)}<div class="legend"><span><i style="border-color:#e4002b"></i>followers</span><span><i style="border-color:#bbb"></i>following</span></div></div>`
      : '<div class="kicker"><span class="accent">●</span> Getting started</div><div class="note">No snapshot yet. Hit <b>Scan now</b> to capture who follows you, then scan again to see who joined and who left.</div>';
    container.innerHTML =
      '<div class="toolbar"><h3>Your followers &amp; following</h3>' +
        `<span class="note" style="margin:0">last scan: ${curr ? fmtAgo(curr.ts) : 'never'}</span><span class="sp" style="flex:1"></span>` +
        '<button class="primary" data-scan>Scan now</button>' +
        `<button class="ghost" data-export${hasData ? '' : ' disabled'}>Export</button></div>` +
      firstScanNote + dashboard +
      '<div class="kicker">Breakdown — select on Following / Mutuals / Don’t-follow-back to unfollow</div>' +
      `<div class="tabs">${tabsHTML}</div>` +
      (UNFOLLOW_TABS[st.tab] && hasData ? selToolHTML(M) : '') +
      `<div class="toolbar"><h3>${esc(tabs[st.tab].label)}</h3><input class="search" data-search placeholder="Search username or name…" value="${esc(st.query)}"></div>` +
      `<div data-list>${tabs[st.tab].render()}</div>`;
    wire();
  };
  const refreshListBody = () => { const lb = $('[data-list]', container); if (lb && MODEL) lb.innerHTML = tabDefs(MODEL)[st.tab].render(); };
  const updateSelCount = () => {
    const c = $('[data-selcount]', container); if (c) c.textContent = fmt(st.selected.size);
    const b = $('[data-sel="go"]', container); if (b) b.disabled = !st.selected.size;
  };
  const refreshDynamic = () => {
    if (!MODEL || !container) return;
    const tabs = tabDefs(MODEL);
    if (!tabs[st.tab]) st.tab = 'gained';
    const m = $('[data-metrics]', container); if (m) m.innerHTML = metricsHTML(MODEL);
    $$('.tab', container).forEach((b) => { const t = tabs[b.dataset.tab]; const n = b.querySelector('.n'); if (n && t) n.textContent = fmt(t.count); });
    refreshListBody(); updateSelCount();
  };
  const onTabClick = (e) => { st.tab = e.currentTarget.dataset.tab; render(); };
  const onSelClick = (e) => selAction(e.currentTarget.dataset.sel);
  const wire = () => {
    $('[data-scan]', container).onclick = () => runScan();
    const exp = $('[data-export]', container); if (exp) exp.onclick = exportJSON;
    $$('.tab', container).forEach((b) => { b.onclick = onTabClick; });
    const search = $('[data-search]', container); if (search) search.oninput = () => { st.query = search.value; refreshListBody(); };
    $$('[data-sel]', container).forEach((b) => { b.onclick = onSelClick; });
    const list = $('[data-list]', container);
    if (list && !list._wired) {
      list._wired = true;
      list.addEventListener('change', (e) => { const t = e.target; if (t.classList?.contains('ck')) toggleSel(t.dataset.uid, t.checked); });
      list.addEventListener('click', (e) => { const b = e.target.closest?.('[data-act="unfollow"]'); if (b) enqueueUnfollow([b.dataset.uid]); });
    }
  };
  const toggleSel = (id, on) => { if (on) { st.selected.add(id); } else { st.selected.delete(id); } updateSelCount(); };
  const selAction = (a) => {
    if (a === 'all') { tabUsers(st.tab).forEach((u) => { if (!queue.statusOf(u.id, 'unfollow')) st.selected.add(u.id); }); refreshListBody(); updateSelCount(); }
    else if (a === 'none') { st.selected.clear(); refreshListBody(); updateSelCount(); }
    else if (a === 'go') unfollowSelected();
  };
  const enqueueUnfollow = (ids) => {
    const fById = byId(MODEL.an.following);
    const users = ids.map((id) => fById[id]).filter((u) => u && !queue.statusOf(u.id, 'unfollow'));
    queue.enqueue(users.map((u) => ({ kind: 'unfollow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified })));
  };
  const unfollowSelected = () => {
    const fById = byId(MODEL.an.following);
    const users = [...st.selected].map((id) => fById[id]).filter((u) => u && !queue.statusOf(u.id, 'unfollow'));
    if (!users.length) return;
    const sp = queue.speed();
    const mins = Math.max(1, Math.round(users.length * ((sp.min + sp.max) / 2) / 60000));
    if (!confirm(`Unfollow ${users.length} account(s)? One at a time on "${sp.label}" pace, ~${mins} min. Survives refresh; pause/cancel anytime.`)) return;
    queue.enqueue(users.map((u) => ({ kind: 'unfollow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified })));
    st.selected.clear(); refreshDynamic();
  };
  const exportJSON = () => {
    const dump = { exportedAt: new Date().toISOString(), current: store.get(K.current, null), previous: store.get(K.previous, null), timeline: store.get(K.timeline, []), events: store.get(K.events, []) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
    a.download = `instagram-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const runScan = async () => {
    if (st.scanning) return;
    if (!api.loggedIn) { toast('Open instagram.com logged in to scan'); return; }
    st.scanning = true;
    let cancelled = false;
    const ov = scanOverlay('Starting…');
    $('[data-cancel]', ov).onclick = () => { cancelled = true; $('[data-st]', ov).textContent = 'Cancelling…'; };
    const prevCount = store.get(K.current, null)?.counts ?? {};
    const progress = (kind, loaded, total) => {
      const base = kind === 'followers' ? 0 : 60, span = kind === 'followers' ? 60 : 40;
      const known = total || prevCount[kind] || loaded + 1;
      const pct = Math.min(100, Math.round(base + span * Math.min(1, loaded / Math.max(1, known))));
      $('[data-prog]', ov).style.width = `${pct}%`;
      $('[data-pct]', ov).textContent = `${pct}%`;
      const totalTxt = total ? ` / ${fmt(total)}` : '';
      $('[data-st]', ov).textContent = `Loading ${kind} — ${fmt(loaded)}${totalTxt}…`;
    };
    try {
      const followers = await scanList('followers', progress, api.viewerId, () => cancelled);
      const following = await scanList('following', progress, api.viewerId, () => cancelled);
      $('[data-prog]', ov).style.width = '100%'; $('[data-pct]', ov).textContent = '100%';
      const snap = { ts: Date.now(), counts: { followers: followers.length, following: following.length }, followers, following };
      const out = commitScan(snap);
      if (!out.storedOk) toast('Scan stored partially (storage full)');
      st.scanning = false;
      ov.remove();
      rebuildModel(); render();
      toast(out.diff ? `${out.diff.gained.length} new · ${out.diff.lost.length} removed since last scan` : 'Baseline captured — scan again later');
    } catch (err) {
      st.scanning = false; ov.remove();
      if (cancelled || /cancelled/.test(String(err?.message))) toast('Scan cancelled — nothing saved');
      else if (err instanceof RateLimit) toast('Rate-limited — nothing saved. Wait ~10–15 min.');
      else toast(`Scan failed: ${err?.message || err}`);
    }
  };

  return {
    id: 'ledger', label: 'Ledger',
    boot() { queue.register('unfollow', { run: (i) => api.unfollow(i.userId), onDone: (i) => afterUnfollow(i) }); },
    mount(el) { container = el; rebuildModel(); render(); },
    unmount() {},
    onQueueChange() { rebuildModel(); refreshDynamic(); },
  };
})();
