# Tools reference

Instagram Suite bundles four tools over one shared core (the global action queue, the API
client, the store, and the SPA shell). The nav at the top of the overlay switches between them;
`globalThis.IGS.mount('ledger' | 'followers' | 'posts' | 'pending')` jumps straight to one.

Every tool is the same object contract — `{ id, label, requiresLogin?, boot(), mount(el), unmount(), onQueueChange() }`
— defined in its file under `src/tools/`. `boot()` registers the tool's queue handlers and loads
persisted state; `mount(el)` renders into the container the shell gives it (via lit-html);
`onQueueChange()` is called by the shell whenever queue state changes so the tool can re-render
(it calls `update()`; lit diffs the DOM).

Every tool that *acts* shares the single paced queue in `src/core/queue.js` (Posts is read-only and
registers nothing). A tool never runs an action itself:
it calls `queue.register(kind, handler)` once in `boot()` and `queue.enqueue([items])` to schedule
work. The engine owns pacing (`SPEEDS`: safe 45–90s default, normal 25–50s, fast 12–25s), one
cooldown between actions, exponential backoff (`MAX_RETRIES = 4`), and a 10-minute rate-limit
auto-pause/auto-resume that applies across **all** tools at once.

Rendered rows are capped at `ROW_CAP = 600` (`src/core/constants.js`); search and filters still run
over the full in-memory set, only the displayed slice is capped.

---

## Ledger

`src/tools/ledger.js` — `export const ledger`

### What it does

Scans **your own** followers and following, snapshots them, and diffs each scan against the previous
one so you can see who joined, who left, who you don't follow back, your fans, your mutuals, and your
follow ratio. It shows a dashboard of big numerals with deltas, a pure-SVG growth chart, a persistent
activity feed, and lets you select accounts and unfollow them on a paced queue.

### Tabs / views

A dashboard sits above a tabbed breakdown. The dashboard (`metricsHTML`) renders metric cards —
Followers (with net delta since last scan), Following, Gained, Removed, Mutuals, No follow-back,
Fans, Verified, Private, Follow ratio, You followed, You unfollowed — plus the growth chart
(`chartSVG` over the timeline).

Tabs (`tabDefs`, order in `render`):

- **gained** — New followers since the previous scan (`diff.gained`). Rows show a "you follow" badge
  when the account is in your following list.
- **lost** — Removed follows: accounts that unfollowed you since the previous scan (`diff.lost`).
  Same "you follow" badge (useful for deciding whether to unfollow back).
- **nonfollowers** — "Don't follow back": people you follow who don't follow you (`an.nonFollowers`). Unfollowable.
- **fans** — One-way fans: follow you, you don't follow them back (`an.fans`).
- **mutuals** — You follow each other (`an.mutuals`). Unfollowable.
- **followers** — All loaded followers, each with the same "you follow" badge.
- **following** — Everyone you follow (`an.following`). Unfollowable.
- **activity** — The persistent event feed (scans + unfollows logged over time).

The select-to-unfollow toolbar (`selToolHTML`) appears only on the three tabs in `UNFOLLOW_TABS`:
**following**, **mutuals**, **nonfollowers**.

### User workflow

1. Hit **Scan now** (`runScan`). Needs a logged-in instagram.com session. `scanList('followers', …)`
   then `scanList('following', …)` paginate both lists with a progress overlay; **Cancel** aborts and
   nothing is saved, **Stop & keep** saves what loaded so far as a `partial` snapshot (browsable and
   unfollowable, but excluded from diffs and the growth timeline until the next full scan; if stopped
   before the following pass, the last known following list is carried over).
2. The first scan saves a **baseline** ("Scan again later for a full change report"). The second and
   later scans produce a diff and toast `N new · M removed since last scan`.
3. Browse tabs, **Search** by username/full name (lit diffing keeps focus), **Export** the full
   ledger as JSON.
4. On Following / Mutuals / Don't-follow-back: tick accounts (or per-row **Unfollow**), then
   **Unfollow selected →**. A confirm shows the count, pace, and a rough ETA; the work goes onto the
   shared queue and survives refresh.

### localStorage keys it owns

| Key | Holds |
| --- | --- |
| `igs-ledger-current` | The latest snapshot. |
| `igs-ledger-previous` | The snapshot before it (for diffing). |
| `igs-ledger-timeline` | Growth points (capped at 300). |
| `igs-ledger-events` | Activity feed events (capped at 1500). |

### Queue kind it registers

**`unfollow`** (registered in `boot()`):

- **run** — `api.unfollow(item.userId)`.
- **onDone** — `afterUnfollow(item)`: removes that user from the `igs-ledger-current` following list,
  decrements `counts.following`, appends an `unfollowed` event to `igs-ledger-events`, then rebuilds
  the in-memory model.
- **onFail** — none registered; failures are surfaced by the queue panel (the queue retries with
  backoff up to `MAX_RETRIES` before marking an item failed).

Enqueued items carry `{ kind: 'unfollow', userId, username, fullName, isVerified }`. Rows already in
the queue show a status badge (`queued` / `unfollowing…` / `unfollowed ✓` / `failed`) instead of an
Unfollow button, via `queue.statusOf(id, 'unfollow')`.

### Data shapes

**Snapshot** (`igs-ledger-current` / `igs-ledger-previous`):

```js
{
  ts: 1719700000000,                  // capture time
  counts: { followers: 1234, following: 567 },
  followers: [ { id, username, fullName, isVerified, isPrivate, picUrl }, … ],
  following: [ … same user shape … ],
}
```

**Timeline point** (`igs-ledger-timeline`): `{ ts, f, g }` — followers and following counts at scan time.

**Event** (`igs-ledger-events`): `{ ts, type, id, username, fullName, isVerified }` where `type` is
one of `gained`, `lost`, `followed`, `unfollowed`.

### Notable behaviour

- **Diff math** (`computeDiff`, by user id): `gained` = current followers not in previous followers;
  `lost` = previous followers no longer present; `startedFollowing` = newly followed; `stoppedFollowing`
  = no longer following. The "you followed / you unfollowed" metrics come from the latter two.
- **Analysis** (`analyze`): `mutuals` = following ∩ followers; `fans` = followers you don't follow;
  `nonFollowers` = following who don't follow back; plus `verified` and `private` follower subsets.
- **Growth timeline** records one `{ ts, f, g }` point per scan (capped at 300, oldest dropped) and
  feeds the SVG chart.
- `commitScan` writes events + timeline first, rotates current → previous, then saves the new current;
  if storage is full the partial-store path toasts "Scan stored partially (storage full)".
- **Partial snapshots** (Stop & keep) carry `partial: true`: they never produce a diff or events
  (`computeDiff` returns `null`), add no timeline point, and never rotate into `previous` — the next
  full scan diffs against the last full snapshot instead. The header marks them "last scan: … (partial)".

---

## Followers

`src/tools/followers.js` — `export const followers`

### What it does

Loads the followers of **any** profile — or several at once, typed as a comma-separated list — and
shows the merged, de-duplicated set as cards (each card lists which loaded profile(s) it follows via
`u.sources` badges when more than one is loaded). Each card can be enriched on demand with the
account's last posts, highlights, and follower/following/mutual counts. You can filter, search, and
follow/unfollow per card. Each profile's scan is saved as its own snapshot.

### Views

A single screen. The header shows the loaded profile(s) and counts. The toolbar loads profiles
(`detectUsername()` pre-fills the box from the current `/username/` URL when valid), scans followers,
and exports. Below sits the search box, the filter chips, the count-range inputs, and the card grid.

Filter chips (`CHIPS`) are multi-select and AND-combined: **Public**, **Private**, **Verified**,
**You follow**, **You don't follow**, **Follows you**, **Doesn't follow you**, **Requested**,
**Mutual**, **Female** / **Male** / **Unidentified** (a local guess — see below), **No full name**,
**Has details**, **No posts**, **Has highlights** — plus, with multiple profiles loaded, one chip
per source profile and **In all profiles**. **All** clears everything.

Gender (`src/core/gender.js` → `guessGender`, cached as `u.gender` at merge time): a pure local
heuristic with zero API calls — a dictionary of common given names (Spanish/English/Italian/
Portuguese/Arabic/Slavic focus) checked against the first two full-name tokens, then the Romance
suffix rule (`-a` → female, `-o` → male; exceptions like Luca/Rocío and Argentine nicknames like
Caro/Anto/Rama live in the dictionary), then a longest-prefix dictionary match on username tokens
(`juanperez99` → juan) whose remainder must itself be a name or common Hispanic surname — so
`hernandez`/`martinez` don't false-match hernan/martin. Ambiguous names (alex, sam, jordan, taylor…)
and businesses stay **Unidentified**. It is a guess, not a fact.
All predicates run on already-scanned data; no extra requests. Flags unknown for a user (`null`,
e.g. from the `api/v1` fallback) match neither the positive nor the negative chip.

Range inputs (`RANGES`): min/max on follower, following, post, and mutual counts. These fields only
exist on enriched cards, so a set range filters to cards whose details were loaded.

View toggles next to the search box: **Hover zoom** (enlarge card avatars ~3.4× on hover, CSS only)
and — with multiple profiles loaded — **Mix profiles** (interleave all profiles' followers via a
stable pseudo-shuffle on the id's tail digits, instead of the default one-block-per-profile order).

### User workflow

1. **Load** (`loadProfiles`) — accepts one or more usernames separated by commas; for each, loads a
   saved snapshot if one exists and, if logged in, refreshes profile details via `api.getWebProfile`.
2. **Scan followers** (`runScan`) — scans each loaded profile in turn with a progress overlay
   (`@name (i/n)`); **Cancel** discards the in-flight profile's scan (profiles finished earlier keep
   theirs), **Stop & keep** saves what loaded so far as a `partial` snapshot.
3. **Search** / filter the card grid (lit diffing keeps focus and scroll).
4. Per card: **Load details** to enrich, **Follow** / **Unfollow**, or open the profile link.
5. **Export** the profile metadata + merged users as JSON; **Import** restores such a file (per-profile
   lists are rebuilt from each user's `sources`; old single-profile exports also work).
6. Under the toolbar, each loaded profile shows as an `@name ✕` chip — click to remove it and delete
   its saved snapshot (confirm-gated). **Clear all ✕** wipes every `igs-fm-*` key.

Browsing/loading a snapshot works without login; live load, scan, follow, and unfollow need a
logged-in session.

### localStorage keys it owns

| Key | Holds |
| --- | --- |
| `igs-fm-snap-<username>` | Per-profile snapshot (lowercased username). |
| `igs-fm-last` | Comma-separated usernames of the last-viewed profiles, saved on load/`unmount()` and reloaded on `boot()`. |

### Queue kinds it registers

Both registered in `boot()`:

**`fm-follow`**

- **run** — `await api.follow(item.userId)`; returns `r?.friendship_status?.outgoing_request` (true
  when the target is private and the follow became a pending **request** rather than an instant follow).
- **onDone** — `onFollowDone(item, requested)`: sets the loaded user's `followedByViewer = !requested`
  and `requestedByViewer = !!requested`, then persists the snapshot.

**`fm-unfollow`**

- **run** — `api.unfollow(item.userId)`.
- **onDone** — `onUnfollowDone(item)`: clears `followedByViewer` and `requestedByViewer` on the loaded
  user, then persists the snapshot.

Enqueued items carry `{ kind, userId, username, fullName, isVerified }`. A card with a queued
follow/unfollow shows a status badge instead of buttons; a pending private request shows a
`requested` badge.

### Data shape

**Per-profile snapshot** (`igs-fm-snap-<username>`):

```js
{
  profile: { id, username, fullName, picUrl, followerCount, followingCount, isPrivate, isVerified },
  users: [ {
    id, username, fullName, picUrl, isPrivate, isVerified,
    followsViewer,            // they follow you (drives the "follows you" badge)
    followedByViewer,         // you follow them
    requestedByViewer,        // you have a pending follow request to them
    enriched: {               // present only after "Load details"
      followerCount, followingCount, mutualCount, postsCount,
      posts: [ { shortcode, thumb }, … ],     // last posts
      highlights: [ { title }, … ],
      fetchedAt,
    },
  }, … ],
  ts,
  partial,                     // true when the scan was stopped mid-way (Stop & keep)
}
```

In memory, `state.profiles` holds one `{ profile, users, partial? }` entry per loaded profile and
`state.users` is the merged view (`mergeUsers`): de-duplicated by id, first copy wins (shared
reference, so card mutations persist into that profile's snapshot), `sources` unioned, and missing
relationship flags / enrichment backfilled from later copies.

### Notable behaviour

- **On-demand enrichment** (`enrichUser`): fetches `api.getWebProfile(username)` and
  `api.getHighlights(id)` in parallel (highlights failure degrades to empty), stores the result on the
  user's `enriched` field, backfills the avatar URL, and persists. A `_enriching` guard prevents double
  fetches. Enrichment runs directly (not through the queue) since it is read-only.
- **Relationship flags** drive both badges and the right-hand action: `followsViewer` → "follows you"
  badge; `followedByViewer` → Unfollow button; `requestedByViewer` → "requested" badge; otherwise a
  Follow button. The filters key off these same flags.
- Snapshots persist after load, scan, enrich, and each completed queue action, so reopening a profile
  restores its cards (including any enrichment) without re-scanning.
- **Persisted users are slimmed**: `picUrl` (IG CDN URLs expire within days and dominate snapshot
  size — large multi-profile scans blew the ~5MB localStorage quota with them), `sources`, and
  `gender` (both recomputed by `mergeUsers`) are dropped on save. After a reload, avatars fall back
  to letters until a re-scan, an enrich, or the shell's **↻** (reload photos) button. If a save still
  fails, a toast warns to keep an Export backup.

---

## Posts

`src/tools/posts.js` — `export const posts`

Nav label **Posts**. `requiresLogin: true`. **Read-only**: it registers no queue kinds and has no
`onQueueChange()` — every action after the scan is local.

### What it does

Loads one profile's timeline in bulk, then lets you rank and slice it entirely offline: sort by
likes / comments / views / reposts / engagement / engagement rate / comments-per-like /
likes-per-day, filter
by media type and post properties, bound by count ranges and a date range, and full-text search
captions, locations and shortcodes.

**Instagram does not expose save counts, DM sends or story shares on any public endpoint** — only
the account owner sees those, in Insights. What the feed payload does carry (and this tool uses) is
likes, comments, plays/views, **reposts** (`media_repost_count`, the Reels repost counter — usually
zero and absent entirely on most posts), timestamp, media type, caption, location, tagged-user
count, pinned state, comments-disabled state, slide count and video duration. The rest of the
metrics are derived locally from those.

### Views

Grid (default) and List, toggled from the toolbar:

- **Grid** — square thumbnail, `♥ likes · 💬 comments · ▶ views` counter line, date, clamped caption,
  and badges (type, `pinned`, slide count, location, `comments off`).
- **List** — dense rows: 44px thumbnail, clamped caption, the same badges, counters and date.

Above both, a six-cell metrics row recomputed over the **currently filtered** set: posts shown,
average likes, average comments, median likes, engagement rate, and top post (linked).

### Sorting

`SORTS` is a `[key, label, valueFn]` table; the toolbar renders a `<select>` from it plus a
direction button. The shared comparator is the exported `nullsLast(a, b, desc)` — values that are
`null` (hidden likes, views on a photo) sink to the bottom in **both** directions, so flipping the
arrow reorders the posts that have a number instead of promoting the ones that don't.

### Filters

- **Type chips** (`Photo`/`Video`/`Reel`/`Carousel`) combine as **OR** with each other and AND
  against everything else — picking Reel + Video shows both, not an empty intersection.
- **Property chips**: `Pinned`, `Has location`, `Tags people`, `Reposted`, `No caption`,
  `Comments off`, `Hidden likes`.
- **Ranges**: min/max on likes, comments, views. A post with no value for a bounded field drops out.
- **Dates**: two native `<input type="date">` boxes. Comparison is a string compare against
  `toLocaleDateString('en-CA')` (`YYYY-MM-DD`, local time), so there is no timezone arithmetic.

### User workflow

1. Type a username (the box is pre-seeded from the profile page you're on) and **Load** — fetches
   `getWebProfile` for the id, follower count and post count, and restores any saved snapshot.
2. Pick a ceiling (`Last 100` / `Last 300` (default) / `Last 1000` / `All posts`) and **Scan posts**.
   The scan overlay shows progress against `min(ceiling, postsCount)` with **Stop & keep** (keeps the
   partial haul) and **Cancel** (discards).
3. Sort, filter, search — all local, no further requests.
4. **Export** the profile + posts as JSON.

### localStorage keys it owns

| Key | Holds |
| --- | --- |
| `igs-posts-<username>` | Per-profile snapshot (lowercased username): `{ profile, posts, ts, partial }`. |
| `igs-posts-last` | Last-loaded username, saved on load/`unmount()` and reloaded on `boot()`. |

### Data shape

```js
// one post, normalised by api._mapMedia / api._mapMediaGraph
{ id, shortcode, thumb, likes, comments, views, reposts, ts, type, caption,
  location, tagged, pinned, commentsDisabled, slides, duration }
```

`type` is `'photo' | 'video' | 'reel' | 'carousel'`. `likes: null` means the owner hid the counts —
distinct from `0`, and excluded from every average, median and sort position. `views` is `null` on
stills.

### Notable behaviour

- **Empty profiles** — `postsCount === 0` disables **Scan posts** and shows
  "@x has no posts"; no feed request is made. If the feed comes back empty anyway, a toast says so
  rather than throwing.
- **Private profiles** you don't follow are refused before the scan starts, with a toast.
- **Pinned posts** are returned first by Instagram regardless of date, hence the `pinned` badge —
  without it the date sort looks broken.
- **Persisted posts are slimmed**: `thumb` is dropped on save, same reason as Followers' `picUrl`
  (IG CDN URLs expire within days, so storing them buys broken images and eats the ~5MB quota).
  After a reload the numbers are all there and the images are blank until a re-scan.
- **Partial** is set when you Stop early *or* when the ceiling cut the scan short, and is shown in
  the kicker line.
- Scanning uses `scanPosts()`, which paces exactly like `scanList()` (a longer breather every 6th
  page). A rate limit mid-scan toasts and keeps nothing — re-run the scan.

---

## Pending

`src/tools/pending.js` — `export const pending`

### What it does

Imports your **Instagram data export** (a `.zip`, or loose `.html`/`.json` files) and lists every
follow request **you sent** that is still pending, so you can Verify or Cancel them. It reads the ZIP
in-browser with no library, parses both the HTML and JSON export formats, and cross-references your
followers/following lists from the same export — all with **zero** Instagram API calls just to browse.
Verify and Cancel each resolve the username to an id at run time and need a logged-in session.

### Views

A sub-nav (`subnav`) with three tabs:

- **Requests** — stat cards, the bulk select/verify/cancel toolbar, filter chips, search, and the
  request rows.
- **Activity** — the action history feed (`igs-pending-history`) plus an "Export results JSON" button.
- **Import** — import counts, a "Delete imported data & results" button, and the dropzone for
  re-importing.

Before anything is imported, the screen is just the dropzone.

Request filter chips (`FILTERS` / `matchFilter`): **All**, **Unprocessed**, **Queued**, **Cancelled**,
**Still pending** (`verified-pending`), **Gone/accepted** (`not-pending`), **Failed**.

### User workflow

1. Get your export from Instagram → Settings → Accounts Center → Your information & permissions →
   Download your information → "Followers and following" (HTML or JSON).
2. Drop the `.zip` (or loose files) on the dropzone (`handleFiles` → `importFiles`). Browsing/filtering
   works **off** instagram.com.
3. Review the requests — badges show "in following" / "follows you" from your export lists; the
   timestamp shows when each request was sent.
4. **Verify** (non-destructive) or **Cancel** any request, single or via Select-all / bulk; or
   **Cancel ALL pending**. Verify/Cancel are disabled when not logged in (a warning explains this).
5. Watch progress in **Activity**; **Export results JSON**; or **Delete imported data & results** to
   start over.

### localStorage keys it owns

| Key | Holds |
| --- | --- |
| `igs-pending-data` | The parsed import (requests + followers/following lists + counts). |
| `igs-pending-results` | Per-username result of the last Verify/Cancel. |
| `igs-pending-history` | Action history log (capped at 3000). |

### Queue kinds it registers

Both registered in `boot()`. Each enqueued item is `{ kind, userId: username, username }` — note the
username is used as the queue's `userId`, since the numeric id isn't known until run time.

**`verify`** (non-destructive)

- **run** — `runVerify(item)`: `resolve(username)` looks up the profile; if there is still an outgoing
  request returns `{ status: 'verified-pending', detail: 'still pending' }`, otherwise
  `{ status: 'not-pending', detail: 'accepted — you follow them' | 'no outgoing request (cancelled/declined)' }`.
  No follow/unfollow call is ever made.
- **onDone** — `setResult(username, res)`.
- **onFail** — `setResult` with status `not-found` on an `ApiError` 404, else `failed`.

**`cancel`** (destructive)

- **run** — `runCancel(item)`: `resolve(username)`; if there is no outgoing request returns
  `not-pending` (already accepted / nothing to do); otherwise calls `api.unfollow(id)` to withdraw the
  request and returns `{ status: 'cancelled', detail: 'request cancelled' }`.
- **onDone** — `setResult(username, res)`.
- **onFail** — same `not-found` / `failed` mapping as verify.

`setResult` writes `igs-pending-results[username]` and appends a row to `igs-pending-history`.

### Data shapes

**Imported data** (`igs-pending-data`, built by `buildData`):

```js
{
  generatedBy,                 // username parsed from the export ("Generated by X on …")
  importedAt,
  requests: [ { username, fullName, timestamp, dateText }, … ],  // deduped, newest first
  followers: [ "user1", … ],   // usernames, from followers_*.{html,json}
  following: [ "user2", … ],   // usernames, from following.{html,json}
  counts: { pending, recent, followers, following, unfollowed },
}
```

**Results** (`igs-pending-results`): map `username → { status, at, detail, userId }` where `status`
is one of `cancelled`, `not-pending`, `verified-pending`, `not-found`, `failed`.

**History** (`igs-pending-history`): `[ { time, username, action, detail }, … ]`, capped at 3000.

### Notable behaviour

- **In-browser ZIP reader** (`ZIP`): finds the end-of-central-directory record, walks the central
  directory for entries, then reads each local file. Stored entries (method 0) are decoded directly;
  deflated entries (method 8) are inflated with `DecompressionStream('deflate-raw')` — no external
  library. If `DecompressionStream` is unavailable it tells the user to unzip and drop the loose files.
  Only entries under `followers_and_following/` that classify are read.
- **Export file classification** (`classify`, by base filename): `pending_follow_requests` → `pending`,
  `recent_follow_requests` → `recent`, `followers` / `followers_N` → `followers`, `following` →
  `following`, `recently_unfollowed_profiles` → `unfollowed`. Both `.html` and `.json` are handled
  (`parseHtml` via `DOMParser`; `parseJson` via `string_list_data`). HTML dates are parsed loosely
  (`parseExportDate`); JSON timestamps are seconds → ms.
- **Cross-reference** — `rebuildSets` builds `followingSet` / `followersSet` from the import so each
  request can show "in following" / "follows you" badges with no API calls.
- **Username→id resolution at run time** (`resolve`): the export only has usernames, so Verify/Cancel
  call `api.getWebProfile` (falling back to `api.getFriendship`) to get the id and the live
  outgoing-request / following status when the action actually runs — not at import time.
- **Verify vs Cancel** — Verify only reads status and never changes anything; Cancel withdraws a still-
  pending request via `api.unfollow`. Both short-circuit cleanly when the request is already gone or
  accepted.
- **Dedupe** — `dedupePending` keeps the newest entry per username and sorts newest-first.
