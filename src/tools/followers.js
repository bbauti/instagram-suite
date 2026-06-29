// Followers — load any profile's followers, enrich cards (posts/highlights/
// mutuals) on demand, follow/unfollow.
import { ROW_CAP } from '../core/constants.js';
import { store } from '../core/store.js';
import { queue } from '../core/queue.js';
import { api, RateLimit, scanList } from '../core/api.js';
import { esc, fmt, $, $$ } from '../core/utils.js';
import { avatar, badge, profileLink, toast, scanOverlay } from '../ui/components.js';

export const followers = (() => {
  const RESERVED = new Set(['explore', 'reels', 'reel', 'direct', 'stories', 'p', 'tv', 'accounts', 'about', 'developer', 'legal', 'directory', 'lite', 'session', 'graphql', 'api', 'your_activity', 'emails', 'challenge', 'privacy', 'web']);
  const detectUsername = () => {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    return m && !RESERVED.has(m[1].toLowerCase()) ? m[1] : '';
  };
  const snapKey = (name) => `igs-fm-snap-${name.toLowerCase()}`;
  const st = { profile: null, users: [], query: '', filter: 'all', scanning: false };
  let container = null;

  const loadSnapshot = (name) => {
    const snap = store.get(snapKey(name), null);
    if (snap) { st.profile = snap.profile; st.users = snap.users || []; return true; }
    return false;
  };
  const persistSnapshot = () => {
    if (st.profile) store.save(snapKey(st.profile.username), { profile: st.profile, users: st.users, ts: Date.now() });
  };
  const userById = (id) => st.users.find((u) => u.id === id);

  // queue handlers mutate the loaded follower's relationship flag + persist
  const onFollowDone = (item, requested) => { const u = userById(item.userId); if (u) { u.followedByViewer = !requested; u.requestedByViewer = !!requested; } persistSnapshot(); };
  const onUnfollowDone = (item) => { const u = userById(item.userId); if (u) { u.followedByViewer = false; u.requestedByViewer = false; } persistSnapshot(); };

  const FILTERS = [
    ['all', 'All'], ['public', 'Public'], ['private', 'Private'], ['verified', 'Verified'],
    ['following', 'You follow'], ['notfollowing', "You don't follow"],
  ];
  const matchFilter = (u) => {
    switch (st.filter) {
      case 'public': return !u.isPrivate;
      case 'private': return u.isPrivate;
      case 'verified': return u.isVerified;
      case 'following': return u.followedByViewer === true;
      case 'notfollowing': return u.followedByViewer === false;
      default: return true;
    }
  };

  const postThumb = (p) => `<a href="https://www.instagram.com/p/${esc(p.shortcode)}/" target="_blank" rel="noreferrer"><img loading="lazy" src="${esc(p.thumb)}" alt=""></a>`;
  const hlChip = (h) => `<span>${esc(h.title || '•')}</span>`;
  const enrichRow = (u) => {
    if (!u.enriched) return '';
    const e = u.enriched;
    const posts = e.posts?.length ? `<div class="thumbs">${e.posts.map(postThumb).join('')}</div>` : '<div class="note" style="margin:0">no posts</div>';
    const hls = e.highlights?.length ? `<div class="hl">${e.highlights.map(hlChip).join('')}</div>` : '';
    return `<div class="note" style="margin:4px 0 0">${fmt(e.followerCount)} followers · ${fmt(e.followingCount)} following · ${fmt(e.mutualCount)} mutual</div>${posts}${hls}`;
  };
  const cardActions = (u) => {
    const fStatus = queue.statusOf(u.id, 'fm-follow'), uStatus = queue.statusOf(u.id, 'fm-unfollow');
    if (fStatus) return `<span class="qbadge ${fStatus}">${fStatus === 'done' ? 'followed ✓' : 'follow ' + fStatus}</span>`;
    if (uStatus) return `<span class="qbadge ${uStatus}">${uStatus === 'done' ? 'unfollowed ✓' : 'unfollow ' + uStatus}</span>`;
    let rel = '';
    if (u.followedByViewer === true) rel = `<button class="actbtn" data-fmact="unfollow" data-uid="${esc(u.id)}">Unfollow</button>`;
    else if (u.requestedByViewer === true) rel = '<span class="qbadge pending">requested</span>';
    else rel = `<button class="actbtn plain" data-fmact="follow" data-uid="${esc(u.id)}">Follow</button>`;
    const enrich = u.enriched ? '' : `<button class="actbtn plain" data-fmact="enrich" data-uid="${esc(u.id)}">Load details</button>`;
    return rel + enrich;
  };
  const cardHTML = (u) => {
    let badges = '';
    if (u.isVerified) badges += badge('✓', 'v');
    if (u.isPrivate) badges += badge('private');
    if (u.followsViewer === true) badges += badge('follows you', 'blue');
    const fn = u.fullName ? `<div class="fn">${esc(u.fullName)}</div>` : '';
    return `<div class="card"><div class="chead">${avatar(u)}<div class="meta"><div class="u">${profileLink(u.username)}</div>${fn}</div>${badges}</div>` +
      enrichRow(u) + `<div class="cact">${cardActions(u)}</div></div>`;
  };

  const cardsHTML = () => {
    const q = st.query.toLowerCase();
    const filtered = st.users.filter((u) => matchFilter(u) && (!q || u.username?.toLowerCase().includes(q) || u.fullName?.toLowerCase().includes(q)));
    if (!st.users.length) return '<div class="empty">No followers loaded yet — hit Scan followers.</div>';
    if (!filtered.length) return '<div class="empty">No matches.</div>';
    const shown = filtered.slice(0, ROW_CAP);
    const more = filtered.length > shown.length ? `<div class="more">Showing ${fmt(shown.length)} of ${fmt(filtered.length)} — search/filter to narrow.</div>` : '';
    return `<div class="cards">${shown.map(cardHTML).join('')}</div>${more}`;
  };
  // re-render only the card grid (keeps search focus + page scroll)
  const renderCards = () => { const host = $('[data-cards]', container); if (host) host.innerHTML = cardsHTML(); };
  const onFilterClick = (e) => {
    st.filter = e.currentTarget.dataset.filter;
    $$('[data-filter]', container).forEach((x) => x.classList.toggle('on', x.dataset.filter === st.filter));
    renderCards();
  };

  const render = () => {
    const p = st.profile;
    const detected = detectUsername();
    const head = p
      ? `<div class="kicker"><span class="accent">●</span> ${esc(p.username)} — ${fmt(p.followerCount)} followers · ${fmt(p.followingCount)} following</div>`
      : '<div class="kicker"><span class="accent">●</span> Followers manager</div>';
    let html = head +
      '<div class="toolbar"><h3>Load a profile</h3>' +
        `<input class="search" data-user placeholder="username (no @)" value="${esc(p?.username || detected || '')}">` +
        '<button class="primary" data-load>Load profile</button>' +
        (p ? '<button class="ghost" data-scan>Scan followers</button><button class="ghost" data-export>Export</button>' : '') +
        (p ? `<span class="note" style="margin:0">${fmt(st.users.length)} loaded</span>` : '') + '</div>';
    if (p) {
      const chips = FILTERS.map(([k, lbl]) => `<button class="chip${st.filter === k ? ' on' : ''}" data-filter="${k}">${esc(lbl)}</button>`).join('');
      html += `<div class="toolbar"><h3>Followers</h3><input class="search" data-search placeholder="Search…" value="${esc(st.query)}"></div>` +
        `<div class="chips">${chips}</div><div data-cards>${cardsHTML()}</div>`;
    } else {
      html += '<div class="note">Open or type any profile, Load it, then Scan followers. Details (posts, highlights, mutuals) load per-card on demand.</div>';
    }
    container.innerHTML = html;
    wire();
  };

  const wire = () => {
    $('[data-load]', container).onclick = () => loadProfile($('[data-user]', container).value.trim());
    const scanBtn = $('[data-scan]', container); if (scanBtn) scanBtn.onclick = () => runScan();
    const expBtn = $('[data-export]', container); if (expBtn) expBtn.onclick = exportJSON;
    const search = $('[data-search]', container); if (search) search.oninput = () => { st.query = search.value; renderCards(); };
    $$('[data-filter]', container).forEach((b) => { b.onclick = onFilterClick; });
    const host = $('[data-cards]', container);
    if (host && !host._wired) {
      host._wired = true;
      host.addEventListener('click', (e) => { const b = e.target.closest?.('[data-fmact]'); if (b) cardAction(b.dataset.fmact, b.dataset.uid); });
    }
  };

  const cardAction = (act, uidStr) => {
    const u = userById(uidStr);
    if (!u) return;
    if (act === 'follow') queue.enqueue([{ kind: 'fm-follow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified }]);
    else if (act === 'unfollow') queue.enqueue([{ kind: 'fm-unfollow', userId: u.id, username: u.username, fullName: u.fullName, isVerified: u.isVerified }]);
    else if (act === 'enrich') enrichUser(u);
    renderCards();
  };
  const enrichUser = async (u) => {
    if (u.enriched || u._enriching) return;
    u._enriching = true;
    try {
      const [prof, hl] = await Promise.all([api.getWebProfile(u.username), api.getHighlights(u.id).catch(() => ({ count: 0, items: [] }))]);
      u.enriched = { followerCount: prof.followerCount, followingCount: prof.followingCount, mutualCount: prof.mutualCount, postsCount: prof.postsCount, posts: prof.posts, highlights: hl.items, fetchedAt: Date.now() };
      u.picUrl = u.picUrl || prof.picUrl;
      persistSnapshot();
      renderCards();
    } catch (err) {
      toast(err instanceof RateLimit ? 'Rate-limited — wait a bit' : `Couldn’t load @${u.username}`);
    } finally { u._enriching = false; }
  };

  const loadProfile = async (name) => {
    if (!name) return;
    if (loadSnapshot(name)) render();
    if (!api.loggedIn) { toast('Open instagram.com logged in to load live'); if (st.profile) { render(); } return; }
    try {
      const prof = await api.getWebProfile(name);
      st.profile = { id: prof.id, username: prof.username, fullName: prof.fullName, picUrl: prof.picUrl, followerCount: prof.followerCount, followingCount: prof.followingCount, isPrivate: prof.isPrivate, isVerified: prof.isVerified };
      persistSnapshot();
      render();
    } catch { toast(`Profile not found: @${name}`); }
  };
  const runScan = async () => {
    if (st.scanning || !st.profile) return;
    if (!api.loggedIn) { toast('Open instagram.com logged in to scan'); return; }
    st.scanning = true;
    let cancelled = false;
    const ov = scanOverlay(`Loading @${st.profile.username} followers…`);
    $('[data-cancel]', ov).onclick = () => { cancelled = true; $('[data-st]', ov).textContent = 'Cancelling…'; };
    const total = st.profile.followerCount;
    const progress = (kind, loaded) => {
      const pct = Math.min(100, Math.round(loaded / Math.max(1, total) * 100));
      $('[data-prog]', ov).style.width = `${pct}%`;
      $('[data-pct]', ov).textContent = `${pct}%`;
      $('[data-st]', ov).textContent = `Loaded ${fmt(loaded)} / ${fmt(total)}…`;
    };
    try {
      const users = await scanList('followers', progress, st.profile.id, () => cancelled);
      st.users = users;
      persistSnapshot();
      st.scanning = false; ov.remove(); render();
      toast(`Loaded ${fmt(users.length)} followers of @${st.profile.username}`);
    } catch (err) {
      st.scanning = false; ov.remove();
      if (cancelled || /cancelled/.test(String(err?.message))) toast('Scan cancelled');
      else if (err instanceof RateLimit) toast('Rate-limited — wait ~10–15 min');
      else toast(`Scan failed: ${err?.message || err}`);
    }
  };
  const exportJSON = () => {
    if (!st.profile) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), profile: st.profile, users: st.users }, null, 2)], { type: 'application/json' }));
    a.download = `instagram-followers-${st.profile.username}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  return {
    id: 'followers', label: 'Followers',
    boot() {
      queue.register('fm-follow', { run: async (i) => { const r = await api.follow(i.userId); return r?.friendship_status?.outgoing_request; }, onDone: (i, requested) => onFollowDone(i, requested) });
      queue.register('fm-unfollow', { run: (i) => api.unfollow(i.userId), onDone: (i) => onUnfollowDone(i) });
      const last = store.get('igs-fm-last', null);
      if (last) loadSnapshot(last);
    },
    mount(el) { container = el; render(); },
    unmount() { if (st.profile) store.save('igs-fm-last', st.profile.username); },
    onQueueChange() { if (container) renderCards(); },
  };
})();
