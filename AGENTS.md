# AGENTS.md — Instagram Suite

Read this first. It is the orientation for working in this repo as if you built it.

**Instagram Suite** is a single paste-into-the-browser-console SPA bundling three Instagram
tools (Ledger, Followers, Pending) over one shared core. No backend, no runtime build: you paste
`dist/instagram-suite.js` into Chrome DevTools on `instagram.com` (logged in) and a full-screen
overlay opens. All data lives in `localStorage`; nothing is uploaded.

## GOLDEN RULE

**Edit files under `src/`. Run `npm run build`. NEVER edit `dist/instagram-suite.js`.**
`dist/` is generated output (an esbuild IIFE bundle). Hand-edits there are overwritten on the next
build and lost. Change `src/`, rebuild, re-paste.

## Build / test commands

```bash
npm install                 # one-time; installs esbuild (the only devDependency)
npm run build               # bundles src/main.js -> dist/instagram-suite.js (esbuild --bundle --format=iife)
npm run watch               # rebuild on save
```

There is no test runner. The check is a runnable self-test on the diff/backoff/esc logic:
in the browser console after pasting, run `globalThis.__igsSelfTest()` (source: `src/selftest.js`).

## Module map (`src/`)

```
core/constants.js  HOST, IG_APP_ID, PAGE_SIZE, ROW_CAP, HASH (GraphQL query hashes), EDGE, RATE_LIMIT_RE
core/utils.js      $, $$, getCookie, esc, fmt, fmtDelta, sleep, randInt, uid, fmtAgo, fmtDate, fmtCountdown, byId
core/store.js      store {get,setRaw,save,remove} — localStorage with quota-safe compaction
core/state.js      app = { root, view, active } — shared mutable app/DOM state holder
core/api.js        RateLimit + ApiError classes; api client; scanList() paginator
core/queue.js      global paced action queue; SPEEDS, KIND_VERB, MAX_RETRIES=4
ui/css.js          CSS string (one Müller-Brockmann design system)
ui/components.js   avatar, badge, profileLink, toast, scanOverlay, chartSVG
ui/shell.js        module registry + SPA shell: renderShell, mountModule, teardown, renderQueuePanel, setModules
tools/ledger.js    export const ledger
tools/followers.js export const followers
tools/pending.js   export const pending
selftest.js        selfTest() — exposed as globalThis.__igsSelfTest
main.js            entry: teardown, inject CSS, boot tools, render shell, expose globalThis.IGS
```

## The tool contract

Each tool is an object: `{ id, label, boot(), mount(el), unmount(), onQueueChange() }`.

- `boot()` — register queue handlers and load persisted state (called once at startup).
- `mount(el)` — render the tool's HTML into the given container.
- `unmount()` — tear down (the shell calls this on the outgoing tool before swapping).
- `onQueueChange()` — re-render the queue-affected part when queue state changes.

`src/main.js` holds the list `const modules = [ledger, followers, pending]`, calls
`setModules(modules)`, then `modules.forEach(m => m.boot?.())`. The shell's `mountModule(id)`
sets `app.active`, calls the old tool's `unmount()` and the new tool's `mount(app.view)`.

### Add a new tool

1. Create `src/tools/x.js` exporting `export const x = { id, label, boot, mount, unmount, onQueueChange }`.
2. In `src/main.js`, `import { x } from './tools/x.js'` and add `x` to the `modules` array.
3. The shell auto-builds the top-nav from the modules list. Rebuild and re-paste.

## The queue (one global paced action queue)

`src/core/queue.js` is ONE queue shared by all three tools: paces one action at a time on a
`SPEEDS` pace, single cooldown between actions, exponential backoff retries (`MAX_RETRIES=4`),
rate-limit detection -> 10-minute auto-pause/auto-resume across ALL tools, and persistence to
`localStorage` key `igs-queue` (running -> pending on reload). SPEEDS: safe 45–90s (default),
normal 25–50s, fast 12–25s (higher block risk).

### Add a new queue action kind

In the tool's `boot()`, register a handler then enqueue with that kind:

```js
queue.register('mykind', {
  run(item)        { /* perform the paced action; throw RateLimit/ApiError on failure */ },
  onDone(item, res){ /* optional: update state on success */ },
  onFail(item, err){ /* optional: update state on failure */ },
});
queue.enqueue([{ kind: 'mykind', userId, username }]);
```

Existing kinds: `unfollow` (ledger), `fm-follow`/`fm-unfollow` (followers), `verify`/`cancel`
(pending). Add a label to `KIND_VERB` in `queue.js` if the UI should name your action.

## Shared state

Lives in `src/core/state.js`: `export const app = { root, view, active }`. `root`/`view` are the
overlay DOM roots; `active` is the mounted tool. UI helpers (`toast`, `scanOverlay`) and the shell
read these references; `mountModule` sets `app.active`. Centralised here to avoid a circular import —
do not reintroduce one by importing the shell from a tool for state.

## Console handle

`globalThis.IGS = { version, mount(id), close(), queue }` where `mount('ledger'|'followers'|'pending')`.

## Coding conventions

- Modern ES: arrows, `const`/`let`, template literals, `async`/`await`, optional chaining,
  `structuredClone`, `replaceAll`, `dataset`, `crypto.getRandomValues`.
- Lean and minimal: the smallest thing that works, lightly commented. Keep it SonarLint/SonarJS-clean.
- Documentation lives in `docs/`, NOT as comment walls in the code.
- Rendering: full `render()` on structural change; partial re-renders
  (`refreshListBody`/`renderCards`/`refreshRows`) for search/filter/queue updates to preserve
  focus + scroll. Rendered rows cap at `ROW_CAP=600`; search still filters the full set.
- Do NOT propose refactors or invent features. Match the existing structure.

## Safety

Instagram action-blocks aggressive automation. Safe pace is the default for a reason; Fast
materially raises block risk. Scan/act occasionally, not on a loop. Unofficial tool on private web
endpoints; personal use on your own account.

## Further reading (`docs/`)

- `docs/ARCHITECTURE.md` — shared core, state holder, shell, queue engine, rendering model.
- `docs/DEVELOPMENT.md` — setup, build/watch, the GOLDEN RULE, self-test.
- `docs/TOOLS.md` — Ledger / Followers / Pending behaviour and storage keys.
- `docs/API.md` — `core/api.js` client, GraphQL hashes/fallbacks, `scanList()`, rate limits.
