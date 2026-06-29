# Tools reference

Instagram Suite bundles three tools over one shared core (the global action queue, the API
client, the store, and the SPA shell). The nav at the top of the overlay switches between them;
`globalThis.IGS.mount('ledger' | 'followers' | 'pending')` jumps straight to one.

Every tool is the same object contract — `{ id, label, boot(), mount(el), unmount(), onQueueChange() }`
— defined in its file under `src/tools/`. `boot()` registers the tool's queue handlers and loads
persisted state; `mount(el)` renders into the container the shell gives it; `onQueueChange()` is
called by the shell whenever queue state changes so the tool can re-render the affected part.

All three share the single paced queue in `src/core/queue.js`. A tool never runs an action itself:
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

- **gained** — New followers since the previous scan (`diff.gained`).
- **lost** — Removed follows: accounts that unfollowed you since the previous scan (`diff.lost`).
- **nonfollowers** — "Don't follow back": people you follow who don't follow you (`an.nonFollowers`). Unfollowable.
- **fans** — One-way fans: follow you, you don't follow them back (`an.fans`).
- **mutuals** — You follow each other (`an.mutuals`). Unfollowable.
- **followers** — All loaded followers.
- **following** — Everyone you follow (`an.following`). Unfollowable.
- **activity** — The persistent event feed (scans + unfollows logged over time).

The select-to-unfollow toolbar (`selToolHTML`) appears only on the three tabs in `UNFOLLOW_TABS`:
**following**, **mutuals**, **nonfollowers**.

### User workflow

1. Hit **Scan now** (`runScan`). Needs a logged-in instagram.com session. `scanList('followers', …)`
   then `scanList('following', …)` paginate both lists with a progress overlay; **Cancel** aborts and
   nothing is saved.
2. The first scan saves a **baseline** ("Scan again later for a full change report"). The second and
   later scans produce a diff and toast `N new · M removed since last scan`.
3. Browse tabs, **Search** by username/full name (partial re-render keeps focus), **Export** the full
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

---

## Followers

`src/tools/followers.js` — `export const followers`

### What it does

Loads the followers of **any** profile (the one you have open, or a username you type) and shows them
as cards. Each card can be enriched on demand with the account's last posts, highlights, and
follower/following/mutual counts. You can filter, search, and follow/unfollow per card. Each profile's
scan is saved as its own snapshot.

### Views

A single screen. The header shows the loaded profile and its follower/following counts. The toolbar
loads a profile (`detectUsername()` pre-fills the box from the current `/username/` URL when valid),
scans followers, and exports. Below sits the search box, the filter chips, and the card grid.

Filter chips (`FILTERS` / `matchFilter`): **All**, **Public**, **Private**, **Verified**,
**You follow** (`followedByViewer === true`), **You don't follow** (`followedByViewer === false`).

### User workflow

1. **Load profile** (`loadProfile`) — loads a saved snapshot immediately if one exists, then, if
   logged in, refreshes profile details via `api.getWebProfile`.
2. **Scan followers** (`runScan`) — `scanList('followers', …, profile.id, …)` paginates the target's
   followers with a progress overlay; cancellable.
3. **Search** / filter the card grid (partial `renderCards` keeps focus and scroll).
4. Per card: **Load details** to enrich, **Follow** / **Unfollow**, or open the profile link.
5. **Export** the profile + loaded users as JSON.

Browsing/loading a snapshot works without login; live load, scan, follow, and unfollow need a
logged-in session.

### localStorage keys it owns

| Key | Holds |
| --- | --- |
| `igs-fm-snap-<username>` | Per-profile snapshot (lowercased username). |
| `igs-fm-last` | The last-viewed profile's username, saved on `unmount()` and reloaded on `boot()`. |

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
}
```

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
