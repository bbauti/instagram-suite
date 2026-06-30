# Architecture

This is the system-design reference for **Instagram Suite** — the console SPA that bundles
three Instagram tools (**Ledger**, **Followers**, **Pending**) over one shared core. It
describes the *post-refactor* layout under `src/`: a set of small ES modules bundled by
esbuild into a single pasteable IIFE at `dist/instagram-suite.js`.

If you only want to *use* the tool, read `README.md`. This document is for understanding and
extending the code. The golden rule throughout: **edit files under `src/`, never `dist/`** —
`dist/instagram-suite.js` is generated output.

---

## Big picture: a console SPA

There is no backend and no runtime server. You open `instagram.com` logged in, paste the
built file into Chrome DevTools, and a full-screen overlay opens. Everything runs in the
page's own JavaScript context, reusing your logged-in session cookies for API calls.

- **One entry point**: `src/main.js` tears down any previous instance, injects the
  stylesheet, boots the three tools through one shared queue, renders the shell, and exposes
  the `globalThis.IGS` console handle.
- **All state is local**: snapshots, history, and the action queue live in `localStorage`.
  Nothing is uploaded; there is no telemetry.
- **Cookie auth, private web endpoints**: `src/core/api.js` reads `ds_user_id` and
  `csrftoken` from cookies and talks to Instagram's private web/GraphQL endpoints with an
  `x-ig-app-id` header. These are unofficial and can change.

### Build pipeline (one IIFE from ES modules)

Development happens in many small ES modules; distribution is a single self-contained file.

```bash
npm install        # one-time: installs esbuild + lit-html (the two devDependencies)
npm run build      # bundles src/main.js -> dist/instagram-suite.js (IIFE)
npm run watch      # rebuild on save
```

**esbuild** (bundler) and **lit-html** (the UI rendering library) are the two devDependencies.
lit-html is bundled into the IIFE, so there is nothing extra to install at runtime.

The exact build command (from `package.json`) is:

```
esbuild src/main.js --bundle --format=iife --minify --charset=utf8 --legal-comments=none --outfile=dist/instagram-suite.js
```

`--format=iife` wraps the whole graph in one immediately-invoked function so a single paste
executes top to bottom with no module loader. `--minify` shrinks the output (it renames only
local identifiers, so the `globalThis.IGS` handle and the `console` self-test survive);
`--charset=utf8` keeps the UI glyphs raw; `--legal-comments=none` strips bundled-dep license
comments. `dist/instagram-suite.js` carries a banner warning not to edit it directly.

---

## Module dependency graph

The graph fans out from two dependency-free leaves (`constants.js`, `utils.js`) up to
`main.js`, which wires everything together. Lower layers never import upward.

```
            core/constants.js        core/utils.js          (no imports; pure leaves)
                  │                        │
      ┌───────────┼───────────┬───────────┼──────────────┐
      ▼           ▼           ▼           ▼               ▼
 core/store.js  core/state.js          core/api.js   (api uses constants + utils)
      │           │                        │
      └─────┬─────┘                        │
            ▼                              ▼
        core/queue.js  ◄── uses store, utils, api ─────────┘

   ui/css.js     ui/components.js   (components uses utils + state)
       │               │
       └───────┬───────┘
               ▼
          ui/shell.js   ── uses state, utils, api, queue ──┐
               │                                           │
   ┌───────────┼───────────────┐                           │
   ▼           ▼               ▼                            │
tools/ledger tools/followers tools/pending  (each uses core/* + ui/*)
   └───────────┼───────────────┘
               ▼
           src/main.js   ── imports css, shell, tools, queue, state, constants, selftest
               │
               ▼
     dist/instagram-suite.js   (esbuild IIFE bundle)
```

In words:

- **`core/`** is the foundation. `constants.js` and `utils.js` import nothing.
  `store.js`, `state.js`, and `api.js` build on them; `queue.js` sits above `store`,
  `utils`, and `api`.
- **`ui/`** has the design system (`css.js`), shared fragments (`components.js`, which reads
  shared state via `state.js`), and the shell (`shell.js`, which knows about the queue).
- **`tools/`** each depend on `core/*` and `ui/*` but **not on each other** and **not on the
  shell's module list** — they only touch the shell indirectly through the shared `queue`.
- **`main.js`** is the only place that knows the concrete tool list and assembles the app.

---

## The shared-state pattern (`core/state.js`) and why it exists

`core/state.js` is four lines:

```js
export const app = { root: null, view: null, active: null };
```

- `app.root` — the overlay's outermost DOM node (`#igs-root`), created in `main.js`.
- `app.view` — the mounted-tool container (`#igs-view`), set by `renderShell`.
- `app.active` — the tool object currently mounted, set by `mountModule`.

**Why a separate holder?** It breaks two would-be circular imports:

1. **shell ↔ components.** `ui/components.js` helpers like `toast` and `scanOverlay` need to
   append into the overlay root. The shell owns the overlay, but if components imported the
   shell *and* the shell imported components, you'd have a cycle. Instead both read
   `app.root` / `app.view` from `state.js`, which imports nothing.
2. **queue ↔ shell.** The shell wires `queue.onChange` / `queue.onTick` and reads
   `app.active` to re-render the active tool. The queue must not import the shell (it has
   zero UI dependency by design). The shell reaches the active tool through `app.active`
   rather than through a back-reference the queue would have to hold.

`state.js` is a tiny dependency-free node every layer can import safely, so shared references
flow through data instead of through import edges.

---

## The SPA shell and module registry (`ui/shell.js`)

The shell is the chrome around the tools: top nav, the mounted-tool swap, the global queue
panel, and teardown. It holds a private `modules` array, seeded by `main.js`:

- **`setModules(mods)`** — receives the tool list `[ledger, followers, pending]`.
- **`renderShell()`** — builds the overlay markup into `app.root`: brand, a nav button per
  module (`data-mod="<id>"`), a viewer badge (`api.viewerId`, with a warning if not on
  `instagram.com`), and the empty `#igs-view` container. It then caches
  `app.view = #igs-view` and wires the close button and nav clicks. Nav buttons for
  `requiresLogin` tools are disabled when `!api.loggedIn`, and a sandboxed-storage warning
  banner appears when `store.usable` is false.
- **`mountModule(id)`** — the SPA router. It finds the module, no-ops if it's already
  active, calls the previous tool's `unmount?.()`, sets `app.active`, toggles the nav
  `.on` class, clears `app.view`, and calls the new tool's `mount(app.view)`.
- **`teardown()`** — stops the queue timer, unmounts the active tool, removes `#igs-root`
  and the injected `#igs-style`. This is also `globalThis.IGS.close`.

The shell additionally owns the **global queue panel** (`renderQueuePanel`, the fixed
`#igs-queue` bar): live done/total progress, the speed selector, and pause/resume/cancel/
clear buttons. It registers the queue hooks at module-evaluation time:

```js
queue.onChange = onQueueChange;   // redraw active tool + queue panel
queue.onTick   = onQueueTick;     // update countdown + progress bar each second
```

`onQueueChange` calls `app.active?.onQueueChange?.()` and re-renders the panel, so any tool's
view stays in sync with the one shared queue.

---

## The tool contract

Every tool is a plain object with this shape (see `tools/ledger.js`, `tools/followers.js`,
`tools/pending.js`):

```js
{ id, label, requiresLogin?, boot(), mount(el), unmount(), onQueueChange() }
```

- **`id` / `label`** — stable id (used by `mountModule` and the nav `data-mod`) and the
  human nav label.
- **`requiresLogin`** (optional) — `true` for tools that need the live IG API (Ledger,
  Followers). Off instagram (`!api.loggedIn`) the shell disables their nav button and
  `mountModule` refuses to mount them; `main.js` opens the first usable tool instead (Pending,
  which works from an imported export). Pending omits the flag.
- **`boot()`** — called once by `main.js` for every tool at startup, *before* anything is
  mounted. It registers the tool's queue handlers (`queue.register(kind, …)`) and loads any
  persisted state. Booting all tools up front means the queue can run actions for a tool that
  isn't currently on screen.
- **`mount(el)`** — render the tool's full UI into the supplied container (`app.view`).
- **`unmount()`** — cleanup hook on tab switch / teardown (e.g. Followers persists
  `igs-fm-last` here).
- **`onQueueChange()`** — call `update()` to re-render when the queue changes (queued/running/
  done badges, counts). lit diffs the DOM, so re-rendering the whole tool stays cheap.

`main.js` is the only place that knows the concrete list:

```js
const modules = [ledger, followers, pending];
setModules(modules);
modules.forEach((m) => m.boot?.());
```

Registered queue kinds, by tool: `unfollow` (Ledger); `fm-follow` / `fm-unfollow`
(Followers); `verify` / `cancel` (Pending).

---

## The queue engine in depth (`core/queue.js`)

There is exactly **one** action queue, shared by all three tools. It owns pacing, retries,
rate-limit handling, and persistence; tools only supply per-kind handlers and items.

```js
queue.register(kind, { run(item), onDone?(item, res), onFail?(item, err) });
queue.enqueue([ { kind, userId, username, ... } ]);
```

### Lifecycle of an item

An item moves through four statuses: **pending → running → done | failed**.

1. **enqueue.** `add(item)` deduplicates (skips an existing item with the same `userId` +
   `kind` unless that one already `failed`), then pushes
   `{ id: uid(), status: 'pending', attempts: 0, nextRunAt: Date.now(), ...item }`.
   `enqueue` clears `paused`, persists, starts the tick timer, and fires `onChange`.
2. **tick (every 1s).** `start()` runs `tick()` on a 1-second `setInterval`. Each tick:
   fires `onTick`; clears an expired rate-limit window (auto-resume); returns early if busy,
   paused, or still inside a cooldown / rate-limit window; otherwise picks the first
   `pending` item whose `nextRunAt <= now`.
3. **running.** With a handler found, it sets `_busy = true`, marks the item `running`,
   increments `attempts`, persists, and `await`s `handler.run(item)`.
4. **done / failed.** On success the item becomes `done` and `handler.onDone?.(item, res)`
   runs. On error it routes to rate-limit or failure handling (below). A missing handler
   marks the item `failed` with `error: 'no handler'`.
5. **cooldown (always).** In the `finally` block — regardless of outcome — the engine sets a
   single cooldown before the next action, clears `_busy`, persists, and fires `onChange`.

### Pacing and the single cooldown

Only one action runs at a time, and exactly one cooldown separates actions. After each
attempt:

```js
this.cooldownUntil = Date.now() + randInt(sp.min, sp.max);
```

`SPEEDS` (jittered, human-looking intervals):

| key      | range     | note                     |
|----------|-----------|--------------------------|
| `safe`   | 45–90s    | default                  |
| `normal` | 25–50s    |                          |
| `fast`   | 12–25s    | higher block risk        |

`etaMs()` estimates remaining time as `max(0, cooldownUntil - now) + pending * avg(min,max)`.

### Exponential backoff (transient failures)

`_onFailure` decides retry vs. give up. A `404` `ApiError` fails immediately (the target is
gone); otherwise, once `attempts >= MAX_RETRIES` (4) the item `fails`. In between, it goes
back to `pending` with a growing delay:

```js
item.nextRunAt = Date.now() + Math.min(16, 2 ** (item.attempts - 1)) * 60000;
```

That is a **1, 2, 4, 8, 16-minute** schedule (capped at 16). `handler.onFail?.()` runs only
when the item ultimately fails. (The self-test asserts this exact backoff series.)

### Rate-limit auto-pause / auto-resume (global)

The API client throws a `RateLimit` error when Instagram signals throttling (HTTP 429,
`feedback_required`, `spam`, `checkpoint_url`, or any `RATE_LIMIT_RE` match). The queue treats
it specially in `_onRateLimit`:

- the item returns to `pending` and its `attempts` is **decremented** (a rate limit isn't the
  item's fault, so it doesn't burn a retry);
- `nextRunAt` is pushed out by `RL_WAIT_MS` (**10 minutes**);
- the whole queue is `paused` and `rateLimitedUntil` is set 10 minutes out.

Because there's one queue for all tools, this pause is **global** — every tool's actions
wait. On a later tick, once `now >= rateLimitedUntil`, the window clears and the queue
auto-resumes. `resume()` (and the panel's Resume button) clears the window immediately.

### Persistence (survives refresh)

State is saved to `localStorage` key `igs-queue` after every mutation (`persist()`). On
`load()`, any item left `running` from a previous session is reset to `pending` with a short
randomized `nextRunAt`, so an action interrupted mid-flight is retried rather than lost.
`main.js` calls `queue.load()` at startup and restarts the timer if anything is still
pending/running.

### `onChange` / `onTick` hooks

Both default to **no-ops**, so the queue has zero UI dependency and can be tested headless.
The shell assigns them at load: `onChange` redraws the active tool and the queue panel on any
state change; `onTick` cheaply updates the countdown text and progress bar each second
without a full re-render.

---

## The rendering model

The UI is rendered with **lit-html**. Each tool exposes one pure `template()` returning an
`` html`…` `` template for its whole view, plus `const update = () => render(template(), container)`.
Any state change calls `update()`; lit diffs the live DOM and patches only what changed.

- **One code path.** There are no manual partial re-renders. Tab switches, search, filter, and
  queue updates all just call `update()` and lit reconciles. (The pre-lit version hand-wrote
  `refreshListBody`/`renderCards`/`refreshRows` to touch sub-trees; lit makes that unnecessary.)
- **Events are inline** — `@click`, `@input`, `@change` — so there is no separate wiring step
  and no event delegation to maintain.

**Why diffing matters:** because lit patches in place instead of replacing `innerHTML`, typing
in the search box re-renders the whole tool without recreating the `<input>`, so **focus and
caret survive** (search inputs bind `.value=${live(st.query)}`; the `live` directive keeps the
value in sync without resetting the cursor). Likewise queue badges updating mid-scroll only
patch the changed nodes, so **scroll position is preserved**. Avatar-bearing lists are keyed
with `` repeat(items, u => u.id, …) `` so a row's node (and its image) is never recycled onto a
different user.

**Shared fragments** (`ui/components.js`) — `avatar`, `badge`, `profileLink` — return lit
templates and compose via `${…}`. `toast`, `scanOverlay`, and the pure-SVG `chartSVG` stay
imperative/string-built (transient nodes outside the declarative tree; `chartSVG` is injected
with the `unsafeHTML` directive).

**Row cap.** Rendered rows are capped at `ROW_CAP = 600` (from `core/constants.js`). The cap
applies to *output only*: search/filter always run over the full set first, then the result is
sliced, and a "Showing first N of M — search to narrow" hint appears when truncated. This
keeps the DOM small on large accounts without hiding data from search.

---

## Data flow: a Ledger scan

A full scan in `tools/ledger.js` (`runScan` → `commitScan` → `rebuildModel` → `render`) shows
how the layers cooperate:

1. **Guard + overlay.** `runScan` bails if a scan is already running or `api.loggedIn` is
   false, then shows `scanOverlay()` (CSS radar, optional Lottie) with a Cancel button.
2. **Paginate (api).** It calls `scanList('followers', …)` then `scanList('following', …)`
   for `api.viewerId`. `scanList` walks every page via `api.page()` (GraphQL first, `api/v1`
   fallback), de-duplicates by id into a `Set`, reports progress to the overlay, honors the
   cancel callback, and **paces itself** — short jittered sleeps between pages and a longer
   pause every 6th page.
3. **Snapshot.** The two lists become one snapshot:
   `{ ts, counts: { followers, following }, followers, following }`.
4. **Diff vs. previous (`commitScan`).** It reads the *old* current snapshot as `prev` and
   computes `computeDiff(prev, curr)` → `gained` / `lost` followers and `startedFollowing` /
   `stoppedFollowing`.
5. **Events + timeline.** Diff entries are appended to the activity feed (`igs-ledger-events`,
   capped at 1500) and a `{ ts, f, g }` point is pushed onto the growth timeline
   (`igs-ledger-timeline`, capped at 300).
6. **Persist (store).** The old current is saved as `igs-ledger-previous`, and the new
   snapshot is saved as `igs-ledger-current` via `store.save`, which falls back to a compact
   record if `localStorage` quota is exceeded (returning `storedOk`).
7. **Rebuild model.** `rebuildModel()` reloads current/previous/timeline/events from the
   store and derives the analysis with `analyze(curr)`: `mutuals` (following ∩ followers),
   `fans` (followers you don't follow), `nonFollowers` (you follow, they don't follow back),
   plus `verified` / `private`. The result is held in the module-local `MODEL`.
8. **Render.** `render()` paints the dashboard (big numerals + deltas), the pure-SVG
   `chartSVG(timeline)`, the breakdown tabs, and a toast summarizing the diff. Subsequent
   queue-driven unfollows feed back through the same store → `rebuildModel` → `update()`
   (`afterUnfollow` + `onQueueChange`).

---

## Reference: `localStorage` keys

| Area      | Keys                                                                                          |
|-----------|-----------------------------------------------------------------------------------------------|
| Queue     | `igs-queue`                                                                                    |
| Ledger    | `igs-ledger-current`, `igs-ledger-previous`, `igs-ledger-timeline`, `igs-ledger-events`        |
| Followers | `igs-fm-snap-<username>` (per profile), `igs-fm-last`                                          |
| Pending   | `igs-pending-data`, `igs-pending-results`, `igs-pending-history`                               |

---

## Console handle and self-test

`main.js` exposes a control handle and a self-check:

```js
globalThis.IGS = { version, mount(id), close(), queue };  // mount('ledger'|'followers'|'pending')
globalThis.__igsSelfTest = selfTest;
```

`IGS.mount` is the shell's `mountModule`; `IGS.close` is `teardown`; `IGS.queue` is the live
shared queue. `__igsSelfTest()` (from `src/selftest.js`) asserts the diff math, the
1,2,4,8,16 backoff schedule, and HTML escaping — the smallest checks that fail loudly if the
shared logic regresses. It runs once (non-fatally) at startup.
