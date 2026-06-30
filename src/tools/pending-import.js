// Pending import — the self-contained in-browser ZIP reader (stored + deflate-raw,
// no library) and the HTML/JSON export parsers. Pure functions only: they turn raw
// Instagram export files into deduped pending requests plus follower/following lists,
// with zero API calls and no module state. Consumed by tools/pending.js, which owns
// the UI, storage, and queue wiring.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// ---- in-browser ZIP reader (stored + deflate-raw; no library) ----------
const ZIP = {
  list(buf) {
    const view = new DataView(buf);
    const len = buf.byteLength;

    // Scan backwards for the end-of-central-directory signature.
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .zip (no end-of-central-directory)');

    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);

    const entries = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(off, true) !== 0x02014b50) break;
      const method = view.getUint16(off + 10, true);
      const compSize = view.getUint32(off + 20, true);
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const localOff = view.getUint32(off + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen));
      entries.push({ name, method, compSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  },
  async text(buf, entry) {
    const view = new DataView(buf);
    if (view.getUint32(entry.localOff, true) !== 0x04034b50) throw new Error('bad local header');

    const nameLen = view.getUint16(entry.localOff + 26, true);
    const extraLen = view.getUint16(entry.localOff + 28, true);
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

// ---- export parsers ----------------------------------------------------
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
  const match = text.match(/([a-z]{3,9})\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}) ?(am|pm)?)?/i);
  if (!match) return null;

  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (month == null) return null;

  const meridiem = match[6]?.toLowerCase();
  let hour = match[4] ? Number(match[4]) : 0;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const minute = match[5] ? Number(match[5]) : 0;
  return new Date(Number(match[3]), month, Number(match[2]), hour, minute).getTime();
};

const linkUsername = (box) => {
  const href = box.querySelector('a[href*="instagram.com"]')?.getAttribute('href');
  const match = href?.match(/instagram\.com\/(?:_u\/)?([^#?/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
};

const parseBox = (box) => {
  let username = '', fullName = '';
  for (const row of box.querySelectorAll('table tr')) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) continue;
    const label = cells[0].textContent.trim().toLowerCase();
    const value = cells[1].textContent.trim();
    if (label === 'username') username = value;
    else if (label === 'name') fullName = value;
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
  for (const box of [...main.children]) {
    const entry = parseBox(box);
    if (entry) out.push(entry);
  }
  return out;
};

const parseJson = (text) => {
  const rootObj = JSON.parse(text);
  let list = Array.isArray(rootObj) ? rootObj : Object.values(rootObj).find((value) => Array.isArray(value));
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const stringData = item.string_list_data?.[0] || {};
    return {
      username: stringData.value || '',
      fullName: item.title && item.title !== stringData.value ? item.title : '',
      timestamp: stringData.timestamp ? stringData.timestamp * 1000 : null,
      dateText: '',
    };
  }).filter((record) => record.username);
};

const parseText = (name, text) => (/\.json$/i.test(name) ? parseJson(text) : parseHtml(text));

const dedupePending = (entries) => {
  const map = new Map();
  for (const entry of entries) {
    const existing = map.get(entry.username);
    if (!existing || (entry.timestamp || 0) > (existing.timestamp || 0)) map.set(entry.username, entry);
  }
  return [...map.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
};

// ---- export pipeline (raw files → buckets → data model) ----------------
const ingestZip = async (file, buckets) => {
  const buf = await file.arrayBuffer();
  let generatedBy = '', found = false;

  const entries = ZIP.list(buf).filter((entry) => /followers_and_following\//.test(entry.name) && classify(entry.name));
  for (const entry of entries) {
    const text = await ZIP.text(buf, entry);
    if (!generatedBy) generatedBy = text.match(/Generated by (\S+) on/)?.[1] || '';
    buckets[classify(entry.name)].push(...parseText(entry.name, text));
    found = true;
  }

  if (!generatedBy) generatedBy = file.name.match(/^instagram-([^-]+)-/)?.[1] || '';
  return { generatedBy, found };
};

const buildData = (buckets, generatedBy) => {
  const requests = dedupePending(buckets.pending);
  if (!requests.length) throw new Error('No pending follow requests found in that export.');

  const followers = [...new Set(buckets.followers.map((entry) => entry.username))];
  const following = [...new Set(buckets.following.map((entry) => entry.username))];

  return {
    generatedBy,
    importedAt: Date.now(),
    requests,
    followers,
    following,
    counts: {
      pending: requests.length,
      recent: buckets.recent.length,
      followers: followers.length,
      following: following.length,
      unfollowed: buckets.unfollowed.length,
    },
  };
};

export { classify, parseText, ingestZip, buildData };
