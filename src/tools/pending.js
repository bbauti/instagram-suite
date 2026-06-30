// Pending — import your Instagram data export, list every follow request you SENT
// that's still pending, verify/cancel them. The in-browser ZIP reader (stored +
// deflate-raw, no library) and the HTML/JSON export parsers live in ./pending-import.js;
// browsing makes zero API calls, a logged-in session is needed only to Verify/Cancel.
// Rendered with lit-html: one `template()` describes the whole tool and `update()`
// re-renders it; lit diffs so search focus and scroll survive partial state changes
// (no manual re-renders).
import { html, render, nothing } from 'lit-html';
import { live } from 'lit-html/directives/live.js';
import { ROW_CAP } from '../core/constants.js';
import { store } from '../core/store.js';
import { queue } from '../core/queue.js';
import { api, ApiError } from '../core/api.js';
import { fmt, fmtAgo, $ } from '../core/utils.js';
import { badge, profileLink, toast } from '../ui/components.js';
import { classify, parseText, ingestZip, buildData } from './pending-import.js';

export const pending = (() => {
  // ---- state -------------------------------------------------------------
  const DKEY = 'igs-pending-data', RKEY = 'igs-pending-results', HKEY = 'igs-pending-history';
  const HISTORY_LIMIT = 3000;
  const state = { tab: 'requests', query: '', filter: 'all', selected: new Set(), msg: '' };
  let data = null, results = {}, container = null, followingSet = new Set(), followersSet = new Set();

  // ---- import (parse export → module state) ------------------------------
  // ZIP reading + file parsing live in ./pending-import.js; this only orchestrates
  // the buckets, persists the result, and refreshes the follower/following sets.
  const importFiles = async (files) => {
    const buckets = { pending: [], recent: [], followers: [], following: [], unfollowed: [] };
    let generatedBy = '', recognized = false;
    for (const file of files) {
      if (/\.zip$/i.test(file.name)) {
        const zipResult = await ingestZip(file, buckets);
        if (zipResult.generatedBy && !generatedBy) generatedBy = zipResult.generatedBy;
        if (zipResult.found) recognized = true;
      } else {
        const kind = classify(file.name);
        if (!kind) continue;
        buckets[kind].push(...parseText(file.name, await file.text()));
        recognized = true;
      }
    }
    if (!recognized) throw new Error('No recognizable files. Drop the export .zip, or pending_follow_requests.html / followers_*.html / following.html.');
    data = buildData(buckets, generatedBy);
    store.save(DKEY, data);
    rebuildSets();
  };
  const rebuildSets = () => {
    followingSet = new Set(data?.following || []);
    followersSet = new Set(data?.followers || []);
  };

  // ---- results + history -------------------------------------------------
  const setResult = (username, outcome) => {
    results[username] = { status: outcome.status, at: Date.now(), detail: outcome.detail, userId: outcome.id };
    store.save(RKEY, results);

    let hist = store.get(HKEY, []);
    hist.push({ time: Date.now(), username, action: outcome.status, detail: outcome.detail || '' });
    if (hist.length > HISTORY_LIMIT) hist = hist.slice(-HISTORY_LIMIT);
    store.save(HKEY, hist);
  };

  // ---- queue handlers (resolve username→id at run time) ------------------
  const resolve = async (username) => {
    const prof = await api.getWebProfile(username);
    let outgoing = prof.requestedByViewer;
    let following = prof.followedByViewer;
    if (outgoing == null) {
      const friendship = await api.getFriendship(prof.id);
      outgoing = friendship.outgoingRequest;
      following = friendship.following;
    }
    return { id: prof.id, outgoing, following };
  };
  const runVerify = async (item) => {
    const resolved = await resolve(item.username);
    if (resolved.outgoing) return { id: resolved.id, status: 'verified-pending', detail: 'still pending' };
    return { id: resolved.id, status: 'not-pending', detail: resolved.following ? 'accepted — you follow them' : 'no outgoing request (cancelled/declined)' };
  };
  const runCancel = async (item) => {
    const resolved = await resolve(item.username);
    if (!resolved.outgoing) return { id: resolved.id, status: 'not-pending', detail: resolved.following ? 'already accepted' : 'no outgoing request' };
    await api.unfollow(resolved.id);
    return { id: resolved.id, status: 'cancelled', detail: 'request cancelled' };
  };

  // ---- row status + filtering --------------------------------------------
  const STATUS = { cancelled: ['cancelled', 'done'], 'not-pending': ['not pending', 'pending'], 'verified-pending': ['still pending', 'failed'], 'not-found': ['not found', 'pending'], failed: ['failed', 'failed'] };
  const rowStatus = (username) => {
    const queueStatus = queue.statusOf(username, 'cancel') || queue.statusOf(username, 'verify');
    if (queueStatus === 'pending' || queueStatus === 'running' || queueStatus === 'done') return { queued: queueStatus };
    const storedResult = results[username];
    return storedResult ? { result: storedResult.status, detail: storedResult.detail } : {};
  };
  const FILTERS = [['all', 'All'], ['unprocessed', 'Unprocessed'], ['queued', 'Queued'], ['cancelled', 'Cancelled'], ['verified-pending', 'Still pending'], ['not-pending', 'Gone/accepted'], ['failed', 'Failed']];
  const matchFilter = (req) => {
    if (state.filter === 'all') return true;
    const status = rowStatus(req.username);
    if (state.filter === 'queued') return !!status.queued;
    if (state.filter === 'unprocessed') return !status.queued && !status.result;
    return status.result === state.filter;
  };
  const filteredRequests = () => {
    const query = state.query.toLowerCase();
    return (data?.requests || []).filter((req) => matchFilter(req) && (!query || req.username.toLowerCase().includes(query) || req.fullName?.toLowerCase().includes(query)));
  };

  // ---- row templates -----------------------------------------------------
  const statusChip = (status) => {
    if (status.queued) return html`<span class="qbadge ${status.queued}">${status.queued === 'done' ? 'done ✓' : status.queued}</span>`;
    if (!status.result) return nothing;
    const [statusLabel, badgeClass] = STATUS[status.result] || [status.result, 'pending'];
    return html`<span class="qbadge ${badgeClass}" title=${status.detail || nothing}>${statusLabel}</span>`;
  };
  const reqBadges = (req) => [
    followingSet.has(req.username) ? badge('in following', 'ok') : nothing,
    followersSet.has(req.username) ? badge('follows you', 'blue') : nothing,
  ];
  const reqWhen = (req) => {
    if (req.timestamp) return html`<span class="when">${fmtAgo(req.timestamp)}</span>`;
    if (req.dateText) return html`<span class="when">${req.dateText}</span>`;
    return nothing;
  };
  const reqCheckbox = (req, done) => {
    if (done) return html`<span style="min-width:44px;flex:none"></span>`;
    return html`<label class="ckwrap"><input type="checkbox" class="ck" .checked=${live(state.selected.has(req.username))} @change=${(event) => toggleSel(req.username, event.target.checked)}></label>`;
  };
  const reqActions = (req, status, done) => {
    if (status.queued === 'pending' || status.queued === 'running') return html`<button class="actbtn plain" @click=${() => pAction('unqueue', req.username)}>Unqueue</button>`;
    if (!done && api.loggedIn) return html`<button class="actbtn plain" @click=${() => pAction('verify', req.username)}>Verify</button><button class="actbtn" @click=${() => pAction('cancel', req.username)}>Cancel</button>`;
    return nothing;
  };
  const reqRow = (req) => {
    const status = rowStatus(req.username);
    const done = !!status.result || status.queued === 'done';
    const nameTpl = req.fullName ? html`<div class="fn">${req.fullName}</div>` : nothing;
    return html`<div class="row${done ? ' q-done' : ''}">${reqCheckbox(req, done)}<div class="av">${req.username.charAt(0).toUpperCase()}</div><div class="meta"><div class="u">${profileLink(req.username)}</div>${nameTpl}</div>${reqBadges(req)}${reqWhen(req)}${statusChip(status)}${reqActions(req, status, done)}</div>`;
  };
  const histRow = (entry) => {
    const detail = entry.detail ? ` · ${entry.detail}` : '';
    return html`<div class="row"><div class="meta"><div class="u">${profileLink(entry.username)}</div><div class="fn">${entry.action}${detail}</div></div><span class="when">${fmtAgo(entry.time)}</span></div>`;
  };

  // ---- section templates (one per tab) -----------------------------------
  const dropzone = () => html`<div class="kicker"><span class="accent">●</span> Import your data export</div>
    <div class="drop" @click=${() => $('input[type=file]', container)?.click()} @dragover=${onDragOver} @dragleave=${onDragLeave} @drop=${onDrop}>Drop your Instagram export <b>.zip</b> here, or click to choose files<br><span style="font-size:11px">also accepts loose pending_follow_requests.html/.json, followers_*.html, following.html</span></div>
    <input type="file" accept=".zip,.html,.json" multiple style="display:none" @change=${(event) => handleFiles([...event.target.files])}>
    ${state.msg ? html`<div class="warn">${state.msg}</div>` : nothing}
    <div class="note">Instagram → Settings → Accounts Center → Your information &amp; permissions → Download your information → “Followers and following”. HTML or JSON both work. Nothing is uploaded.</div>`;

  const statCards = () => {
    const counts = { queued: 0, cancelled: 0, gone: 0, failed: 0 };
    for (const req of data.requests) {
      const status = rowStatus(req.username);
      if (status.queued === 'pending' || status.queued === 'running') counts.queued += 1;
      else if (status.result === 'cancelled') counts.cancelled += 1;
      else if (status.result === 'not-pending' || status.result === 'not-found') counts.gone += 1;
      else if (status.result === 'failed') counts.failed += 1;
    }
    const card = (value, label) => html`<div class="metric"><div class="v">${value}</div><div class="l">${label}</div></div>`;
    return html`<div class="metrics">${card(fmt(data.requests.length), 'Imported')}${card(fmt(counts.queued), 'Queued')}${card(fmt(counts.cancelled), 'Cancelled')}${card(fmt(counts.gone), 'Gone/accepted')}${card(fmt(counts.failed), 'Failed')}${card(data.generatedBy || '—', 'From')}</div>`;
  };
  const subnav = () => {
    const tabs = [['requests', `Requests (${fmt(data.counts.pending)})`], ['activity', 'Activity'], ['import', 'Import']];
    return html`<div class="tabs">${tabs.map(([key, label]) => html`<button class="tab${state.tab === key ? ' on' : ''}" @click=${() => { state.tab = key; update(); }}>${label}</button>`)}</div>`;
  };

  const renderImport = () => html`${subnav()}<div class="note">${fmt(data.counts.pending)} pending · ${fmt(data.counts.followers)} followers · ${fmt(data.counts.following)} following imported.</div><button class="danger" @click=${() => pAction('wipe')}>Delete imported data &amp; results</button>${dropzone()}`;
  const renderActivity = () => {
    const hist = store.get(HKEY, []).slice().reverse().slice(0, 400);
    const rows = hist.length ? hist.map(histRow) : html`<div class="empty">No actions yet.</div>`;
    return html`${subnav()}<div class="toolbar"><h3>Activity</h3><button class="ghost" @click=${() => pAction('export')}>Export results JSON</button></div><div class="rows">${rows}</div>`;
  };
  const renderRequests = () => {
    const requests = filteredRequests();
    const shown = requests.slice(0, ROW_CAP);
    const rows = shown.length ? shown.map(reqRow) : html`<div class="empty">No requests match.</div>`;
    const more = requests.length > shown.length ? html`<div class="more">Showing ${fmt(shown.length)} of ${fmt(requests.length)} — search/filter to narrow.</div>` : nothing;
    const bulkOff = !(state.selected.size && api.loggedIn);
    return html`${subnav()}
      ${api.loggedIn ? nothing : html`<div class="warn">Not logged in on instagram.com — browse/filter works, but Verify/Cancel are disabled. Open instagram.com and re-run to act.</div>`}
      ${statCards()}
      <div class="seltool"><button class="ghost" @click=${() => pAction('selall')}>Select all (${fmt(requests.length)})</button><button class="ghost" @click=${() => pAction('selnone')}>Clear</button><span class="sc"><b>${fmt(state.selected.size)}</b> selected</span><span class="sp"></span><button class="ghost" ?disabled=${bulkOff} @click=${() => pAction('verifysel')}>Verify selected</button><button class="primary" ?disabled=${bulkOff} @click=${() => pAction('cancelsel')}>Cancel selected →</button></div>
      <div class="toolbar"><input class="search" placeholder="Search username or name…" .value=${live(state.query)} @input=${onSearch}><button class="danger" ?disabled=${!api.loggedIn} @click=${() => pAction('cancelall')}>Cancel ALL pending</button></div>
      <div class="chips">${FILTERS.map(([key, label]) => html`<button class="chip${state.filter === key ? ' on' : ''}" @click=${() => { state.filter = key; update(); }}>${label}</button>`)}</div>
      <div>${rows}${more}</div>`;
  };
  const template = () => {
    if (!data) return dropzone();
    if (state.tab === 'import') return renderImport();
    if (state.tab === 'activity') return renderActivity();
    return renderRequests();
  };
  const update = () => render(template(), container);

  // ---- actions -----------------------------------------------------------
  const toggleSel = (username, on) => {
    if (on) state.selected.add(username);
    else state.selected.delete(username);
    update();
  };
  const enqueueReqs = (usernames, kind) => queue.enqueue(usernames.map((u) => ({ kind, userId: u, username: u })));

  const handleFiles = async (files) => {
    if (!files.length) return;
    state.msg = 'Reading…';
    update();
    try {
      await importFiles(files);
      state.tab = 'requests';
      state.msg = '';
      update();
      toast(`Imported ${fmt(data.requests.length)} pending requests`);
    } catch (error) {
      state.msg = String(error?.message || error);
      update();
    }
  };
  const cancelAll = () => {
    const all = (data.requests || []).filter((req) => !results[req.username] && !queue.statusOf(req.username, 'cancel')).map((req) => req.username);
    if (!all.length) return;
    const speed = queue.speed();
    const mins = Math.max(1, Math.round(all.length * ((speed.min + speed.max) / 2) / 60000));
    if (confirm(`Cancel ALL ${all.length} pending request(s)? One at a time (${speed.label}), ~${mins} min.`)) enqueueReqs(all, 'cancel');
  };
  const exportResults = () => {
    const link = document.createElement('a');
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), results, history: store.get(HKEY, []) }, null, 2)], { type: 'application/json' });
    link.href = URL.createObjectURL(blob);
    link.download = `instagram-pending-results-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  };
  const wipeData = () => {
    if (!confirm('Delete all imported export data and results?')) return;
    for (const key of [DKEY, RKEY, HKEY]) store.remove(key);
    data = null;
    results = {};
    rebuildSets();
    state.selected.clear();
  };
  const unqueueOne = (username) => {
    const match = queue.items.find((item) => item.username === username && (item.kind === 'cancel' || item.kind === 'verify'));
    if (match) queue.removeItem(match.id);
  };
  const cancelSelected = () => {
    if (!confirm(`Cancel ${state.selected.size} request(s)?`)) return;
    enqueueReqs([...state.selected], 'cancel');
    state.selected.clear();
  };
  const pActions = {
    verify: (u) => enqueueReqs([u], 'verify'),
    cancel: (u) => enqueueReqs([u], 'cancel'),
    unqueue: (u) => unqueueOne(u),
    selall: () => { for (const req of filteredRequests()) state.selected.add(req.username); },
    selnone: () => state.selected.clear(),
    verifysel: () => { enqueueReqs([...state.selected], 'verify'); state.selected.clear(); },
    cancelsel: () => cancelSelected(),
    cancelall: () => cancelAll(),
    export: () => exportResults(),
    wipe: () => wipeData(),
  };
  const pAction = (act, username) => {
    pActions[act]?.(username);
    update();
  };

  // ---- event handlers (module-scope to avoid deep nesting) ---------------
  const onSearch = (event) => {
    state.query = event.target.value;
    update();
  };
  const onDragOver = (event) => {
    event.preventDefault();
    event.currentTarget.classList.add('over');
  };
  const onDragLeave = (event) => event.currentTarget.classList.remove('over');
  const onDrop = (event) => {
    event.preventDefault();
    event.currentTarget.classList.remove('over');
    handleFiles([...event.dataTransfer.files]);
  };

  return {
    id: 'pending', label: 'Pending',
    boot() {
      queue.register('verify', {
        run: runVerify,
        onDone: (item, result) => setResult(item.username, result),
        onFail: (item, error) => setResult(item.username, { status: error instanceof ApiError && error.status === 404 ? 'not-found' : 'failed', detail: String(error?.message || error) }),
      });
      queue.register('cancel', {
        run: runCancel,
        onDone: (item, result) => setResult(item.username, result),
        onFail: (item, error) => setResult(item.username, { status: error instanceof ApiError && error.status === 404 ? 'not-found' : 'failed', detail: String(error?.message || error) }),
      });
      data = store.get(DKEY, null);
      results = store.get(RKEY, {});
      rebuildSets();
    },
    mount(el) { container = el; update(); },
    unmount() {},
    onQueueChange() { if (container && data && state.tab === 'requests') update(); },
  };
})();
