// Pending — import your Instagram data export, list every follow request you SENT
// that's still pending, verify/cancel them. Self-contained in-browser ZIP reader
// (stored + deflate-raw, no library) + HTML/JSON export parser; zero API calls to
// browse, a logged-in session only to Verify/Cancel.
import { ROW_CAP } from '../core/constants.js';
import { store } from '../core/store.js';
import { queue } from '../core/queue.js';
import { api, ApiError } from '../core/api.js';
import { esc, fmt, fmtAgo, $, $$ } from '../core/utils.js';
import { badge, profileLink, toast } from '../ui/components.js';

export const pending = (() => {
  const DKEY = 'igs-pending-data', RKEY = 'igs-pending-results', HKEY = 'igs-pending-history';
  const HISTORY_LIMIT = 3000;
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const st = { tab: 'requests', query: '', filter: 'all', selected: new Set(), msg: '' };
  let data = null, results = {}, container = null, followingSet = new Set(), followersSet = new Set();

  // ---- in-browser ZIP reader (stored + deflate-raw; no library) ----------
  const ZIP = {
    list(buf) {
      const dv = new DataView(buf), len = buf.byteLength;
      let eocd = -1;
      for (let i = len - 22; i >= Math.max(0, len - 65557); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
      if (eocd < 0) throw new Error('Not a valid .zip (no end-of-central-directory)');
      const count = dv.getUint16(eocd + 10, true);
      let off = dv.getUint32(eocd + 16, true);
      const entries = [];
      for (let n = 0; n < count; n++) {
        if (dv.getUint32(off, true) !== 0x02014b50) break;
        const method = dv.getUint16(off + 10, true), compSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen));
        entries.push({ name, method, compSize, localOff });
        off += 46 + nameLen + extraLen + commentLen;
      }
      return entries;
    },
    async text(buf, entry) {
      const dv = new DataView(buf);
      if (dv.getUint32(entry.localOff, true) !== 0x04034b50) throw new Error('bad local header');
      const nameLen = dv.getUint16(entry.localOff + 26, true), extraLen = dv.getUint16(entry.localOff + 28, true);
      const start = entry.localOff + 30 + nameLen + extraLen;
      const slice = new Uint8Array(buf, start, entry.compSize);
      if (entry.method === 0) return new TextDecoder().decode(slice);
      if (entry.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t unzip — extract the .zip and drop the .html/.json files instead.');
        const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new TextDecoder().decode(await new Response(stream).arrayBuffer());
      }
      throw new Error(`unsupported zip method ${entry.method}`);
    },
  };

  // ---- export parser -----------------------------------------------------
  const classify = (filename) => {
    const base = filename.split('/').pop().toLowerCase();
    if (/^pending_follow_requests\.(html|json)$/.test(base)) return 'pending';
    if (/^recent_follow_requests\.(html|json)$/.test(base)) return 'recent';
    if (/^followers(_\d+)?\.(html|json)$/.test(base)) return 'followers';
    if (/^following\.(html|json)$/.test(base)) return 'following';
    if (/^recently_unfollowed_profiles\.(html|json)$/.test(base)) return 'unfollowed';
    return null;
  };
  const parseExportDate = (text) => {
    const m = text.match(/([a-z]{3,9})\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}) ?(am|pm)?)?/i);
    if (!m) return null;
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon == null) return null;
    let hr = m[4] ? Number(m[4]) : 0;
    if (m[6]?.toLowerCase() === 'pm' && hr < 12) hr += 12;
    if (m[6]?.toLowerCase() === 'am' && hr === 12) hr = 0;
    return new Date(Number(m[3]), mon, Number(m[2]), hr, m[5] ? Number(m[5]) : 0).getTime();
  };
  const linkUsername = (box) => {
    const href = box.querySelector('a[href*="instagram.com"]')?.getAttribute('href');
    const m = href?.match(/instagram\.com\/(?:_u\/)?([^#?/]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  };
  const parseBox = (box) => {
    let username = '', fullName = '';
    for (const tr of box.querySelectorAll('table tr')) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) continue;
      const label = tds[0].textContent.trim().toLowerCase(), val = tds[1].textContent.trim();
      if (label === 'username') username = val;
      else if (label === 'name') fullName = val;
    }
    if (!username) username = linkUsername(box);
    if (!username) return null;
    const dateEl = box.querySelector('._a6-o') || [...box.querySelectorAll('div._a6-p div div')].pop();
    const dateText = dateEl?.textContent.trim() || '';
    return { username, fullName, timestamp: parseExportDate(dateText), dateText };
  };
  const parseHtml = (text) => {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const main = doc.querySelector('main') || doc.body;
    const out = [];
    for (const box of [...main.children]) { const e = parseBox(box); if (e) out.push(e); }
    return out;
  };
  const parseJson = (text) => {
    const rootObj = JSON.parse(text);
    let list = Array.isArray(rootObj) ? rootObj : Object.values(rootObj).find((v) => Array.isArray(v));
    if (!Array.isArray(list)) return [];
    return list.map((item) => {
      const sld = item.string_list_data?.[0] || {};
      return { username: sld.value || '', fullName: item.title && item.title !== sld.value ? item.title : '', timestamp: sld.timestamp ? sld.timestamp * 1000 : null, dateText: '' };
    }).filter((r) => r.username);
  };
  const parseText = (name, text) => (/\.json$/i.test(name) ? parseJson(text) : parseHtml(text));
  const dedupePending = (entries) => {
    const map = new Map();
    for (const e of entries) { const ex = map.get(e.username); if (!ex || (e.timestamp || 0) > (ex.timestamp || 0)) map.set(e.username, e); }
    return [...map.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  };

  const ingestZip = async (file, buckets) => {
    const buf = await file.arrayBuffer();
    let generatedBy = '', found = false;
    for (const e of ZIP.list(buf).filter((x) => /followers_and_following\//.test(x.name) && classify(x.name))) {
      const text = await ZIP.text(buf, e);
      if (!generatedBy) generatedBy = text.match(/Generated by (\S+) on/)?.[1] || '';
      buckets[classify(e.name)].push(...parseText(e.name, text));
      found = true;
    }
    if (!generatedBy) generatedBy = file.name.match(/^instagram-([^-]+)-/)?.[1] || '';
    return { generatedBy, found };
  };
  const buildData = (buckets, generatedBy) => {
    const requests = dedupePending(buckets.pending);
    if (!requests.length) throw new Error('No pending follow requests found in that export.');
    const followers = [...new Set(buckets.followers.map((e) => e.username))];
    const following = [...new Set(buckets.following.map((e) => e.username))];
    return { generatedBy, importedAt: Date.now(), requests, followers, following, counts: { pending: requests.length, recent: buckets.recent.length, followers: followers.length, following: following.length, unfollowed: buckets.unfollowed.length } };
  };
  const importFiles = async (files) => {
    const buckets = { pending: [], recent: [], followers: [], following: [], unfollowed: [] };
    let generatedBy = '', recognized = false;
    for (const file of files) {
      if (/\.zip$/i.test(file.name)) {
        const z = await ingestZip(file, buckets);
        if (z.generatedBy && !generatedBy) generatedBy = z.generatedBy;
        if (z.found) recognized = true;
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
  const rebuildSets = () => { followingSet = new Set(data?.following || []); followersSet = new Set(data?.followers || []); };

  // ---- results + history -------------------------------------------------
  const setResult = (username, res) => {
    results[username] = { status: res.status, at: Date.now(), detail: res.detail, userId: res.id };
    store.save(RKEY, results);
    let hist = store.get(HKEY, []);
    hist.push({ time: Date.now(), username, action: res.status, detail: res.detail || '' });
    if (hist.length > HISTORY_LIMIT) hist = hist.slice(-HISTORY_LIMIT);
    store.save(HKEY, hist);
  };

  // ---- queue handlers (resolve username→id at run time) ------------------
  const resolve = async (username) => {
    const prof = await api.getWebProfile(username);
    let outgoing = prof.requestedByViewer, following = prof.followedByViewer;
    if (outgoing == null) { const fs = await api.getFriendship(prof.id); outgoing = fs.outgoingRequest; following = fs.following; }
    return { id: prof.id, outgoing, following };
  };
  const runVerify = async (item) => {
    const r = await resolve(item.username);
    if (r.outgoing) return { id: r.id, status: 'verified-pending', detail: 'still pending' };
    return { id: r.id, status: 'not-pending', detail: r.following ? 'accepted — you follow them' : 'no outgoing request (cancelled/declined)' };
  };
  const runCancel = async (item) => {
    const r = await resolve(item.username);
    if (!r.outgoing) return { id: r.id, status: 'not-pending', detail: r.following ? 'already accepted' : 'no outgoing request' };
    await api.unfollow(r.id);
    return { id: r.id, status: 'cancelled', detail: 'request cancelled' };
  };

  // ---- rendering ---------------------------------------------------------
  const STATUS = { cancelled: ['cancelled', 'done'], 'not-pending': ['not pending', 'pending'], 'verified-pending': ['still pending', 'failed'], 'not-found': ['not found', 'pending'], failed: ['failed', 'failed'] };
  const rowStatus = (username) => {
    const qs = queue.statusOf(username, 'cancel') || queue.statusOf(username, 'verify');
    if (qs === 'pending' || qs === 'running' || qs === 'done') return { queued: qs };
    const r = results[username];
    return r ? { result: r.status, detail: r.detail } : {};
  };
  const FILTERS = [['all', 'All'], ['unprocessed', 'Unprocessed'], ['queued', 'Queued'], ['cancelled', 'Cancelled'], ['verified-pending', 'Still pending'], ['not-pending', 'Gone/accepted'], ['failed', 'Failed']];
  const matchFilter = (req) => {
    if (st.filter === 'all') return true;
    const s = rowStatus(req.username);
    if (st.filter === 'queued') return !!s.queued;
    if (st.filter === 'unprocessed') return !s.queued && !s.result;
    return s.result === st.filter;
  };
  const filteredRequests = () => {
    const q = st.query.toLowerCase();
    return (data?.requests || []).filter((r) => matchFilter(r) && (!q || r.username.toLowerCase().includes(q) || r.fullName?.toLowerCase().includes(q)));
  };
  const statusChip = (s) => {
    if (s.queued) return `<span class="qbadge ${s.queued}">${s.queued === 'done' ? 'done ✓' : s.queued}</span>`;
    if (!s.result) return '';
    const [lbl, cls] = STATUS[s.result] || [s.result, 'pending'];
    return `<span class="qbadge ${cls}" title="${esc(s.detail || '')}">${esc(lbl)}</span>`;
  };
  const reqBadges = (req) => {
    let b = '';
    if (followingSet.has(req.username)) b += badge('in following', 'ok');
    if (followersSet.has(req.username)) b += badge('follows you', 'blue');
    return b;
  };
  const reqWhen = (req) => {
    if (req.timestamp) return `<span class="when">${fmtAgo(req.timestamp)}</span>`;
    if (req.dateText) return `<span class="when">${esc(req.dateText)}</span>`;
    return '';
  };
  const reqCheckbox = (req, done) => {
    if (done) return '<span style="min-width:44px;flex:none"></span>';
    const checked = st.selected.has(req.username) ? ' checked' : '';
    return `<label class="ckwrap"><input type="checkbox" class="ck" data-u="${esc(req.username)}"${checked}></label>`;
  };
  const reqActions = (req, s, done) => {
    if (s.queued === 'pending' || s.queued === 'running') return `<button class="actbtn plain" data-pact="unqueue" data-u="${esc(req.username)}">Unqueue</button>`;
    if (!done && api.loggedIn) return `<button class="actbtn plain" data-pact="verify" data-u="${esc(req.username)}">Verify</button><button class="actbtn" data-pact="cancel" data-u="${esc(req.username)}">Cancel</button>`;
    return '';
  };
  const reqRow = (req) => {
    const s = rowStatus(req.username);
    const done = !!s.result || s.queued === 'done';
    const fn = req.fullName ? `<div class="fn">${esc(req.fullName)}</div>` : '';
    return `<div class="row${done ? ' q-done' : ''}">${reqCheckbox(req, done)}` +
      `<div class="av">${esc(req.username.charAt(0).toUpperCase())}</div>` +
      `<div class="meta"><div class="u">${profileLink(req.username)}</div>${fn}</div>` +
      `${reqBadges(req)}${reqWhen(req)}${statusChip(s)}${reqActions(req, s, done)}</div>`;
  };
  const histRow = (h) => {
    const detail = h.detail ? ` · ${esc(h.detail)}` : '';
    return `<div class="row"><div class="meta"><div class="u">${profileLink(h.username)}</div><div class="fn">${esc(h.action)}${detail}</div></div><span class="when">${fmtAgo(h.time)}</span></div>`;
  };

  const dropzone = () =>
    '<div class="kicker"><span class="accent">●</span> Import your data export</div>' +
    '<div class="drop" data-drop>Drop your Instagram export <b>.zip</b> here, or click to choose files<br><span style="font-size:11px">also accepts loose pending_follow_requests.html/.json, followers_*.html, following.html</span></div>' +
    '<input type="file" accept=".zip,.html,.json" multiple data-file style="display:none">' +
    (st.msg ? `<div class="warn">${esc(st.msg)}</div>` : '') +
    '<div class="note">Instagram → Settings → Accounts Center → Your information &amp; permissions → Download your information → “Followers and following”. HTML or JSON both work. Nothing is uploaded.</div>';

  const statCards = () => {
    const counts = { queued: 0, cancelled: 0, gone: 0, failed: 0 };
    for (const r of data.requests) {
      const s = rowStatus(r.username);
      if (s.queued === 'pending' || s.queued === 'running') counts.queued += 1;
      else if (s.result === 'cancelled') counts.cancelled += 1;
      else if (s.result === 'not-pending' || s.result === 'not-found') counts.gone += 1;
      else if (s.result === 'failed') counts.failed += 1;
    }
    const card = (v, l) => `<div class="metric"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    return `<div class="metrics" data-stats>${card(fmt(data.requests.length), 'Imported')}${card(fmt(counts.queued), 'Queued')}${card(fmt(counts.cancelled), 'Cancelled')}${card(fmt(counts.gone), 'Gone/accepted')}${card(fmt(counts.failed), 'Failed')}${card(esc(data.generatedBy || '—'), 'From')}</div>`;
  };
  const subnav = () => {
    const tabs = [['requests', `Requests (${fmt(data.counts.pending)})`], ['activity', 'Activity'], ['import', 'Import']];
    const btns = tabs.map(([k, lbl]) => `<button class="tab${st.tab === k ? ' on' : ''}" data-ptab="${k}">${esc(lbl)}</button>`).join('');
    return `<div class="tabs">${btns}</div>`;
  };

  const renderImport = () =>
    subnav() + `<div class="note">${fmt(data.counts.pending)} pending · ${fmt(data.counts.followers)} followers · ${fmt(data.counts.following)} following imported.</div>` +
    '<button class="danger" data-pact="wipe">Delete imported data &amp; results</button>' + dropzone();
  const renderActivity = () => {
    const hist = store.get(HKEY, []).slice().reverse().slice(0, 400);
    const rows = hist.length ? hist.map(histRow).join('') : '<div class="empty">No actions yet.</div>';
    return subnav() + '<div class="toolbar"><h3>Activity</h3><button class="ghost" data-pact="export">Export results JSON</button></div>' + `<div class="rows">${rows}</div>`;
  };
  const renderRequests = () => {
    const reqs = filteredRequests();
    const chips = FILTERS.map(([k, lbl]) => `<button class="chip${st.filter === k ? ' on' : ''}" data-pfilter="${k}">${esc(lbl)}</button>`).join('');
    const warn = api.loggedIn ? '' : '<div class="warn">Not logged in on instagram.com — browse/filter works, but Verify/Cancel are disabled. Open instagram.com and re-run to act.</div>';
    const shown = reqs.slice(0, ROW_CAP);
    const rows = shown.length ? shown.map(reqRow).join('') : '<div class="empty">No requests match.</div>';
    const more = reqs.length > shown.length ? `<div class="more">Showing ${fmt(shown.length)} of ${fmt(reqs.length)} — search/filter to narrow.</div>` : '';
    const bulkOff = st.selected.size && api.loggedIn ? '' : ' disabled';
    return subnav() + warn + statCards() +
      `<div class="seltool"><button class="ghost" data-pact="selall">Select all (${fmt(reqs.length)})</button><button class="ghost" data-pact="selnone">Clear</button>` +
        `<span class="sc"><b data-selc>${fmt(st.selected.size)}</b> selected</span><span class="sp"></span>` +
        `<button class="ghost" data-pact="verifysel"${bulkOff}>Verify selected</button>` +
        `<button class="primary" data-pact="cancelsel"${bulkOff}>Cancel selected →</button></div>` +
      `<div class="toolbar"><input class="search" data-search placeholder="Search username or name…" value="${esc(st.query)}">` +
        `<button class="danger" data-pact="cancelall"${api.loggedIn ? '' : ' disabled'}>Cancel ALL pending</button></div>` +
      `<div class="chips">${chips}</div><div data-rows>${rows}${more}</div>`;
  };
  const render = () => {
    if (!data) container.innerHTML = dropzone();
    else if (st.tab === 'import') container.innerHTML = renderImport();
    else if (st.tab === 'activity') container.innerHTML = renderActivity();
    else container.innerHTML = renderRequests();
    wire();
  };
  const refreshRows = () => { const host = $('[data-rows]', container); if (host) host.innerHTML = filteredRequests().slice(0, ROW_CAP).map(reqRow).join('') || '<div class="empty">No requests match.</div>'; };
  const updateSelCount = () => { const c = $('[data-selc]', container); if (c) c.textContent = fmt(st.selected.size); };
  const enqueueReqs = (usernames, kind) => queue.enqueue(usernames.map((u) => ({ kind, userId: u, username: u })));

  const handleFiles = async (files) => {
    if (!files.length) return;
    st.msg = 'Reading…'; render();
    try { await importFiles(files); st.tab = 'requests'; st.msg = ''; render(); toast(`Imported ${fmt(data.requests.length)} pending requests`); }
    catch (err) { st.msg = String(err?.message || err); render(); }
  };
  const cancelAll = () => {
    const all = (data.requests || []).filter((r) => !results[r.username] && !queue.statusOf(r.username, 'cancel')).map((r) => r.username);
    if (!all.length) return;
    const sp = queue.speed(), mins = Math.max(1, Math.round(all.length * ((sp.min + sp.max) / 2) / 60000));
    if (confirm(`Cancel ALL ${all.length} pending request(s)? One at a time (${sp.label}), ~${mins} min.`)) enqueueReqs(all, 'cancel');
  };
  const exportResults = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), results, history: store.get(HKEY, []) }, null, 2)], { type: 'application/json' }));
    a.download = `instagram-pending-results-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const wipeData = () => {
    if (!confirm('Delete all imported export data and results?')) return;
    for (const k of [DKEY, RKEY, HKEY]) store.remove(k);
    data = null; results = {}; rebuildSets(); st.selected.clear();
  };
  const unqueueOne = (username) => { const it = queue.items.find((i) => i.username === username && (i.kind === 'cancel' || i.kind === 'verify')); if (it) queue.removeItem(it.id); };
  const cancelSelected = () => { if (confirm(`Cancel ${st.selected.size} request(s)?`)) { enqueueReqs([...st.selected], 'cancel'); st.selected.clear(); } };
  const pActions = {
    verify: (u) => enqueueReqs([u], 'verify'),
    cancel: (u) => enqueueReqs([u], 'cancel'),
    unqueue: (u) => unqueueOne(u),
    selall: () => { for (const r of filteredRequests()) st.selected.add(r.username); },
    selnone: () => st.selected.clear(),
    verifysel: () => { enqueueReqs([...st.selected], 'verify'); st.selected.clear(); },
    cancelsel: () => cancelSelected(),
    cancelall: () => cancelAll(),
    export: () => exportResults(),
    wipe: () => wipeData(),
  };
  const pAction = (act, username) => { pActions[act]?.(username); render(); };

  // ---- event handlers (module-scope to avoid deep nesting) ---------------
  const onPtabClick = (e) => { st.tab = e.currentTarget.dataset.ptab; render(); };
  const onPfilterClick = (e) => { st.filter = e.currentTarget.dataset.pfilter; render(); };
  const onPactClick = (e) => pAction(e.currentTarget.dataset.pact, e.currentTarget.dataset.u);
  const onSearchInput = (e) => { st.query = e.currentTarget.value; refreshRows(); };
  const onDragOver = (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); };
  const onDragLeave = (e) => e.currentTarget.classList.remove('over');
  const onDrop = (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); handleFiles([...e.dataTransfer.files]); };
  const onRowsChange = (e) => { const t = e.target; if (!t.classList?.contains('ck')) { return; } if (t.checked) { st.selected.add(t.dataset.u); } else { st.selected.delete(t.dataset.u); } updateSelCount(); };
  const onRowsClick = (e) => { const b = e.target.closest?.('[data-pact]'); if (b) pAction(b.dataset.pact, b.dataset.u); };
  const wire = () => {
    $$('[data-ptab]', container).forEach((b) => { b.onclick = onPtabClick; });
    $$('[data-pfilter]', container).forEach((b) => { b.onclick = onPfilterClick; });
    const search = $('[data-search]', container); if (search) search.oninput = onSearchInput;
    const file = $('[data-file]', container), drop = $('[data-drop]', container);
    if (drop && file) {
      drop.onclick = () => file.click();
      drop.ondragover = onDragOver; drop.ondragleave = onDragLeave; drop.ondrop = onDrop;
      file.onchange = () => handleFiles([...file.files]);
    }
    // toolbar buttons bound directly; per-row buttons use delegation (below)
    $$('[data-pact]', container).forEach((b) => { if (!b.closest('[data-rows]')) b.onclick = onPactClick; });
    const rows = $('[data-rows]', container);
    if (rows && !rows._wired) { rows._wired = true; rows.addEventListener('change', onRowsChange); rows.addEventListener('click', onRowsClick); }
  };

  return {
    id: 'pending', label: 'Pending',
    boot() {
      queue.register('verify', { run: runVerify, onDone: (i, res) => setResult(i.username, res), onFail: (i, err) => setResult(i.username, { status: err instanceof ApiError && err.status === 404 ? 'not-found' : 'failed', detail: String(err?.message || err) }) });
      queue.register('cancel', { run: runCancel, onDone: (i, res) => setResult(i.username, res), onFail: (i, err) => setResult(i.username, { status: err instanceof ApiError && err.status === 404 ? 'not-found' : 'failed', detail: String(err?.message || err) }) });
      data = store.get(DKEY, null); results = store.get(RKEY, {}); rebuildSets();
    },
    mount(el) { container = el; render(); },
    unmount() {},
    onQueueChange() { if (container && data && st.tab === 'requests') render(); },
  };
})();
