# Instagram Integration Reference (`core/api.js`)

This document describes how Instagram Suite talks to Instagram. All of it lives in
[`src/core/api.js`](../src/core/api.js), backed by a handful of values in
[`src/core/constants.js`](../src/core/constants.js). There is **one** client object,
`api`, shared by all three tools (Ledger, Followers, Pending).

> **Disclaimer — read this first.** Everything below uses Instagram's *private*,
> *unofficial* web endpoints (the same ones the website calls internally). They are
> not a public API, are undocumented, and **can change or disappear at any time**.
> GraphQL `query_hash` values in particular rot when Instagram ships changes. This is
> a personal-use tool against your own logged-in session; expect to update hashes and
> endpoint shapes occasionally. Nothing here is uploaded anywhere — every request goes
> straight from your browser to `instagram.com` using your existing cookies.

---

## Authentication

The client carries **no tokens of its own**. It rides on the cookies of your already
logged-in `instagram.com` browser session and sends every request with
`credentials: 'include'`.

Two cookies are read via getters on `api`:

| Getter | Cookie | Purpose |
| --- | --- | --- |
| `api.viewerId` | `ds_user_id` | Your numeric user id (the "viewer"). Default target for follower/following scans. |
| `api.csrf` | `csrftoken` | Sent as the `x-csrftoken` header on every write (follow/unfollow). |

```js
get viewerId() { return getCookie('ds_user_id'); },
get csrf()     { return getCookie('csrftoken'); },
get loggedIn() { return !!this.viewerId && location.hostname === HOST; },
```

`api.loggedIn` is `true` only when a `ds_user_id` cookie exists **and** you are on
`www.instagram.com` (`HOST`). Browsing-only features (e.g. the Pending tool reading a
data export) work off-site, but anything that hits the API needs `loggedIn`.

### Request headers

Read requests go through `api.request(url)`, which uses `appHeaders()`:

```js
appHeaders() { return { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }; },
```

- `x-ig-app-id` — the Instagram web app id, `'936619743392459'` (`IG_APP_ID` in
  `constants.js`). Instagram rejects most private endpoints without it.
- `x-requested-with: XMLHttpRequest` — marks the call as an in-page XHR.

Write requests go through `api.friendshipPost(primary, fallback)`, which adds:

- `content-type: application/x-www-form-urlencoded`
- `x-csrftoken: <csrftoken>` — taken from `api.csrf`.

If there is no `csrftoken` cookie, writes throw `ApiError('No csrftoken cookie — are
you logged in?', 401)` before any network call.

---

## Endpoints

All requests pass through one private helper, `api._fetch(url, opts)`, which parses the
JSON body, runs rate-limit detection (see below), and throws `ApiError` on non-OK
responses. `api.request()` (GET, read) and `api.friendshipPost()` (POST, write) wrap it.

### `web_profile_info` — profile + last 3 posts

```
GET /api/v1/users/web_profile_info/?username=<username>
```

`api.getWebProfile(username)` fetches a full profile and the three most recent posts.
Reads `body.data.user`; throws `ApiError('Profile "<username>" not found', 404)` if
absent. Returns the [normalized user model](#normalized-user-data-model) plus counts
and a `posts` array of up to three `{ thumb, shortcode }` items.

### `graphql/query` — followers / following (one page)

```
GET /graphql/query/?query_hash=<HASH[kind]>&variables=<json>
```

`api.page(kind, after, userId)` fetches one page of `followers` or `following` for any
user id (defaults to `api.viewerId`). `variables` is
`{ id, include_reel: false, fetch_mutual: false, first: PAGE_SIZE }`, plus `after` for
pagination. The response edge is selected by `EDGE[kind]`
(`edge_followed_by` for followers, `edge_follow` for following); each node is normalized
through `_mapGraph`. The page result is `{ users, next, total }`, where `next` is
`page_info.end_cursor` when `has_next_page` is true, otherwise `null`.

#### `api/v1/friendships/{id}/{kind}` — GraphQL fallback

If the GraphQL call fails for any reason **other than a rate limit**, `page()` falls back
to `_pageApi(kind, after, id)`:

```
GET /api/v1/friendships/<id>/<followers|following>/?count=<PAGE_SIZE>[&search_surface=follow_list_page][&max_id=<cursor>]
```

Here the cursor is `max_id` (vs. GraphQL's `after`), `search_surface=follow_list_page`
is added for `followers`, users come from `body.users` mapped through `_mapApi`, and the
next cursor is `body.next_max_id`. A `RateLimit` from the GraphQL attempt is re-thrown
immediately and is **not** retried via the fallback.

### `highlights_tray` — first 5 highlights

```
GET /api/v1/highlights/<userId>/highlights_tray/
```

`api.getHighlights(userId)` returns `{ count, items }` where `items` is up to five
`{ id, title, cover }`. Cover URL is taken from
`cover_media.cropped_image_version.url`, falling back to the first
`image_versions2.candidates` entry.

#### GraphQL highlights fallback

On any non-`RateLimit` error it falls back to GraphQL with `HASH.highlights`:

```
GET /graphql/query/?query_hash=<HASH.highlights>&variables=<json>
```

`variables` requests `include_highlight_reels: true` (and disables the other chaining/
suggested-user extras). Items come from `data.user.edge_highlight_reels.edges`, with the
cover taken from `cover_media_cropped_thumbnail.url` or `cover_media.thumbnail_src`.

### `friendships/show` — friendship status

```
GET /api/v1/friendships/show/<userId>/
```

`api.getFriendship(userId)` returns `{ outgoingRequest, following }` from
`outgoing_request` and `following`. Used to confirm whether a follow request is still
pending or has already gone through.

### `friendships/create` / `friendships/destroy` — follow / unfollow

Both go through `api.friendshipPost(primary, fallback)`, a POST with the CSRF header.

```js
follow(userId) {
  return this.friendshipPost(
    `https://${HOST}/api/v1/friendships/create/${userId}/`,
    `https://${HOST}/web/friendships/${userId}/follow/`);
},
unfollow(userId) {
  return this.friendshipPost(
    `https://${HOST}/api/v1/friendships/destroy/${userId}/`,
    `https://${HOST}/web/friendships/${userId}/unfollow/`);
},
```

| Action | Primary endpoint | Fallback endpoint |
| --- | --- | --- |
| Follow | `POST /api/v1/friendships/create/<id>/` | `POST /web/friendships/<id>/follow/` |
| Unfollow | `POST /api/v1/friendships/destroy/<id>/` | `POST /web/friendships/<id>/unfollow/` |

If the primary POST throws a `RateLimit`, it is re-thrown without trying the fallback.
Any other error makes `friendshipPost` retry once against the `/web/friendships/...`
fallback URL.

---

## GraphQL query hashes

The hashes live in `HASH` in `src/core/constants.js`:

```js
export const HASH = {
  followers:  'c76146de99bb02f6415203be841dd25a', // edge_followed_by
  following:  '3dec7e2c57367ef3da3d987d89f9dbc8', // edge_follow
  highlights: 'd4d88dc1500312af6f937f7b804c68c3', // edge_highlight_reels
};
export const EDGE = { followers: 'edge_followed_by', following: 'edge_follow' };
```

> **These hashes can rot.** Each `query_hash` is tied to a specific persisted GraphQL
> query on Instagram's side. When Instagram changes those queries, the old hash returns
> an error and the client falls through to the `api/v1` fallback path. If both paths
> break for a given list, the hash needs to be re-captured from a live
> `instagram.com` session (DevTools → Network → a `graphql/query` request) and updated
> in `constants.js`.

---

## Normalized user data model

The raw GraphQL and `api/v1` payloads differ, so three mappers fold them into one shape
the tools can rely on.

**`_mapGraph(node)`** (GraphQL nodes from `page()`):

| Field | Source |
| --- | --- |
| `id` | `String(n.id)` |
| `username` | `n.username` |
| `fullName` | `n.full_name` (or `''`) |
| `picUrl` | `n.profile_pic_url` (or `''`) |
| `isPrivate` | `!!n.is_private` |
| `isVerified` | `!!n.is_verified` |
| `followedByViewer` | `n.followed_by_viewer` (or `null`) |
| `requestedByViewer` | `n.requested_by_viewer` (or `null`) |
| `followsViewer` | `n.follows_viewer` (or `null`) |

**`_mapApi(u)`** (`api/v1` users from `_pageApi()`): same shape, with `id` from
`u.pk ?? u.pk_id`. The `api/v1` list payload does not carry viewer-relationship flags,
so `followedByViewer`, `requestedByViewer`, and `followsViewer` are all `null`.

**`getWebProfile(username)`** returns the richest object (a superset of the mapper
shape):

| Field | Source |
| --- | --- |
| `id` | `String(u.id)` |
| `username` / `fullName` | `u.username` / `u.full_name` |
| `picUrl` / `picUrlHd` | `u.profile_pic_url` / `u.profile_pic_url_hd` |
| `isPrivate` / `isVerified` | `u.is_private` / `u.is_verified` |
| `followerCount` | `u.edge_followed_by.count` |
| `followingCount` | `u.edge_follow.count` |
| `mutualCount` | `u.edge_mutual_followed_by.count` |
| `postsCount` | `u.edge_owner_to_timeline_media.count` |
| `followedByViewer` / `requestedByViewer` | `u.followed_by_viewer` / `u.requested_by_viewer` |
| `posts` | up to 3 `{ thumb, shortcode }` from `edge_owner_to_timeline_media.edges` |

`getFriendship()` and `getHighlights()` return their own small shapes
(`{ outgoingRequest, following }` and `{ count, items }`) documented in their sections
above.

---

## Pagination — `scanList`

`scanList(kind, onProgress, userId, shouldCancel)` walks a whole follower/following
list by repeatedly calling `api.page()` and stitching the pages together.

- **Page size** is `PAGE_SIZE = 48` (`constants.js`) — `first` for GraphQL, `count` for
  the `api/v1` fallback.
- **Cursors** chain automatically: each page's `next` (GraphQL `end_cursor` or `api/v1`
  `next_max_id`) becomes the next `after`. The loop ends when `next` is `null`.
- **De-duplication**: a `Set` of seen ids guards against overlap between pages, so the
  returned array has no duplicates.
- **Progress**: `onProgress(kind, users.length, total)` is called after every page;
  `total` comes from the list count when available.
- **Cancellation**: if `shouldCancel?.()` returns truthy, the scan throws
  `Error('cancelled')`.
- **Human pacing** — between pages it sleeps a jittered amount, with a longer pause every
  sixth page to look less like a bot:

```js
await sleep(pages % 6 === 0 ? randInt(4000, 8000) : randInt(700, 1700));
```

So roughly 0.7–1.7 s between normal pages and 4–8 s on every sixth. Combined with the
queue's pacing for write actions, this keeps scans well under Instagram's radar — see
the [safety note](#safety).

---

## Rate-limit handling

### `RateLimit` vs. `ApiError`

`api.js` exports two error classes:

- **`RateLimit`** — Instagram is throttling or action-blocking you. Carries a `detail`
  string. Treated specially everywhere: it is **never** retried via a fallback path and
  triggers the queue's global pause.
- **`ApiError(message, status)`** — any other failure (network error → status `0`,
  non-OK HTTP, malformed payload, missing cookie, not-found). Ordinary, retryable
  failure.

### Detection

Inside `_fetch`, after parsing the JSON body, a response is flagged as a rate limit when
**any** of these holds:

```js
const flagged = res.status === 429 ||
  body?.feedback_required || body?.spam || body?.checkpoint_url ||
  RATE_LIMIT_RE.some((re) => re.test(text));
```

- HTTP **429** (Too Many Requests).
- A truthy `feedback_required`, `spam`, or `checkpoint_url` field in the body.
- The stringified body matching any pattern in `RATE_LIMIT_RE` (`constants.js`):
  `try again later`, `wait a few minutes`, `feedback_required`, `checkpoint_required`,
  `action blocked`, `rate_limit`, `spam`.

When flagged, `_fetch` throws `new RateLimit(body?.feedback_message || body?.message ||
"HTTP <status>")`. Only if **not** flagged and the response is non-OK does it throw
`ApiError`.

### How the queue reacts — 10-minute auto-pause

The shared action queue ([`src/core/queue.js`](../src/core/queue.js)) catches
`RateLimit` from any tool's `run()` and pauses **everything**:

```js
const RL_WAIT_MS = 10 * 60 * 1000;
// ...
_onRateLimit(item) {
  // ...
  this.paused = true;
  this.rateLimitedUntil = Date.now() + RL_WAIT_MS;
}
```

- The whole queue is paused for **10 minutes** (`RL_WAIT_MS`), affecting all three tools
  at once — not just the action that tripped the block.
- On each tick, once `Date.now() >= rateLimitedUntil`, the queue clears the flag and
  **auto-resumes** itself.
- Ordinary `ApiError` failures don't pause the queue; they go through the normal
  exponential-backoff retry path (up to `MAX_RETRIES = 4`) and only then mark the item
  `failed`.

This is why scans and writes should be run occasionally rather than on a loop, and why
the default queue speed is the conservative one — see below.

---

## Safety

These are private endpoints and Instagram actively rate-limits and action-blocks
aggressive automation. The defaults exist for a reason:

- Read scans are paced by `scanList`'s jittered sleeps.
- Write actions are paced by the queue (default **safe** speed). Faster speeds
  materially raise block risk.
- A single `RateLimit` pauses every tool for 10 minutes.

Use the tool occasionally, on your own account. If endpoints or `query_hash` values stop
working, that is expected behaviour for an unofficial integration — update them in
`src/core/constants.js` and rebuild (`npm run build`).
