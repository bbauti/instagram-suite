# Instagram Suite

**Instagram Suite** is a single paste-into-the-browser-console SPA that bundles
three Instagram tools — **Ledger**, **Followers**, and **Pending** — behind one
shared core and one design system. There is no backend and nothing to install to
run it: you open `instagram.com` while logged in, paste one JavaScript file into
the Chrome DevTools console, and a full-screen overlay opens with a three-tool nav
at the top. Every byte of data it produces stays in your browser's `localStorage`
— nothing is ever uploaded anywhere.

---

## Quick start (just use it)

You do not need Node, a terminal, or any developer setup to *use* the suite — only
to build it. To just run it:

1. Open <https://www.instagram.com/> in Chrome and make sure you are **logged in**.
2. Press `F12` (or `Cmd/Ctrl+Shift+I`) and click the **Console** tab.
3. If the console warns about pasting, type `allow pasting` and press Enter.
4. Open **`dist/instagram-suite.js`**, copy its entire contents, paste it into the
   console, and press Enter.

A full-screen overlay opens. Use the nav at the top to switch between the three
tools, or drive it from the console handle:

```js
IGS.mount('ledger')     // open the Ledger tool
IGS.mount('followers')  // open the Followers tool
IGS.mount('pending')    // open the Pending tool
IGS.close()             // tear down the overlay
IGS.version             // → '1.0.0'
```

**Nothing is uploaded.** The suite talks only to Instagram's own web endpoints (the
same ones the site uses), and it persists everything locally in your browser's
`localStorage`. Close the tab and your snapshots, history, and queue are still
there next time. There is no server, no account, no telemetry.

> The **Pending** tool's importer also works **off** `instagram.com` — you can
> browse your data export from any tab. Live actions (scanning, follow/unfollow,
> verify/cancel) require an active, logged-in `instagram.com` session.

---

## The three tools

### Ledger — track your own followers and following over time

Scan **your** followers and following lists, then diff the new snapshot against the
previous one to see what changed:

- New followers, removed follows (**who unfollowed you**), don't-follow-back,
  fans, mutuals, verified, private, and your follow ratio.
- A big-numeral dashboard with ▲/▼ deltas, a pure-SVG followers-vs-following
  growth chart, a persistent activity feed, and full-text search.
- **JSON export** of the current model.
- Select accounts and run a **paced unfollow** on the Following, Mutuals, and
  Don't-follow-back tabs (every action goes through the shared queue).

### Followers — explore the followers of any profile

Load the followers of **any** profile you open or type in, then inspect them:

- **On-demand per-card enrichment**: last posts, highlights, and
  follower/following/mutual counts (loaded only when you ask, to stay light).
- Filters: public, private, verified, you-follow, you-don't — plus search.
- Per-card **follow / unfollow** (paced through the shared queue).
- A snapshot is saved **per profile**, and the whole list can be exported as JSON.

### Pending — manage the follow requests you sent

Import your official **Instagram data export** and clean up follow requests you
**sent** that are still pending:

- A **self-contained, in-browser ZIP reader** (stored + `deflate-raw` via the
  native `DecompressionStream`, no library) plus an HTML/JSON parser. Drop the
  export `.zip` or loose files like `pending_follow_requests.html`.
- Each pending request is cross-referenced against the export's *follows-you* and
  *in-following* data and badged accordingly — **zero API calls just to browse**.
- **Verify** (a non-destructive status check) or **Cancel** each request, one at a
  time or in bulk. Results and an activity log are kept, and everything exports to
  JSON.
- Browsing works off `instagram.com`; Verify and Cancel need a logged-in session.

---

## Privacy & safety

- **All data is local.** Snapshots, timelines, activity feeds, import results, and
  the action queue live in your browser's `localStorage` and never leave it.
- **Unofficial tool, private endpoints.** The suite uses Instagram's internal web
  API, which is undocumented and can change or break at any time. It is intended
  for **personal use on your own account**.
- **Respect the rate limits.** Instagram aggressively rate-limits and
  **action-blocks** automated follow/unfollow activity. Every write action in the
  suite runs through a single paced queue (one action at a time) with a built-in
  cooldown, exponential-backoff retries, and automatic 10-minute pauses when a rate
  limit is detected.
- **Safe pace is the default for a reason.** The queue offers three speeds —
  **Safe (45–90s, default)**, **Normal (25–50s)**, and **Fast (12–25s ⚠)**. Fast
  materially raises your block risk. Scan and act **occasionally, not on a loop**.

---

## For developers

The pasteable file in `dist/` is **generated** from modular sources under `src/`.
The codebase is deliberately lean and lightly commented, written in modern ES; the UI is
rendered with [lit-html](https://lit.dev/docs/libraries/standalone-templates/) (bundled into
the output). Documentation lives in `docs/`, not in comment walls.

### Source layout

```
src/
  core/
    constants.js   HOST, IG_APP_ID, PAGE_SIZE, ROW_CAP, HASH (GraphQL query hashes), EDGE, RATE_LIMIT_RE
    utils.js       $, $$, getCookie, esc, fmt, fmtDelta, sleep, randInt, uid, fmtAgo, fmtDate, fmtCountdown, byId
    store.js       store {get,setRaw,save,remove} — localStorage with quota-safe compaction
    state.js       app = { root, view, active } — shared mutable app/DOM state holder
    api.js         RateLimit + ApiError classes, the API client, and scanList() paginator
    queue.js       the global paced action queue engine, SPEEDS, KIND_VERB
  ui/
    css.js         the CSS string (one Müller-Brockmann design system)
    components.js  avatar, badge, profileLink, toast, scanOverlay (CSS radar + optional Lottie), chartSVG
    shell.js       module registry + SPA shell: renderShell, mountModule, teardown, renderQueuePanel, setModules
  tools/
    ledger.js      export const ledger
    followers.js   export const followers
    pending.js     export const pending
    pending-import.js  pure ZIP reader + export parsers used by pending.js
  selftest.js      selfTest() — runnable check on diff/backoff/esc logic (globalThis.__igsSelfTest)
  main.js          entry: teardown previous, inject CSS, boot tools, render shell, expose globalThis.IGS
dist/
  instagram-suite.js   the BUILT, pasteable file (generated — do not edit)
```

### Build workflow

Requires Node + npm. Two devDependencies: `esbuild` (bundler) and `lit-html` (UI rendering,
bundled into the output). No runtime dependencies.

```bash
npm install        # one-time: installs esbuild + lit-html
npm run build      # bundle src/main.js → dist/instagram-suite.js (IIFE)
npm run watch      # rebuild on every save
```

`npm run build` runs `esbuild src/main.js --bundle --format=iife --minify` (plus
`--charset=utf8 --legal-comments=none`), producing a minified `dist/instagram-suite.js` — the
IIFE you paste into the console.

### The golden rule

> **Edit files under `src/`, never `dist/`.** `dist/instagram-suite.js` is
> generated output. Make your change in `src/`, run `npm run build`, then re-paste
> the rebuilt `dist/instagram-suite.js`.

### Console handles

- `globalThis.IGS = { version, mount(id), close(), queue }` — drive the suite from
  the console; `mount('ledger'|'followers'|'pending')`.
- `globalThis.__igsSelfTest()` — runs the self-check on the diff/backoff/esc logic.

### Documentation

Deeper references live in `docs/`, plus a guide for AI coding agents at the repo
root:

- `docs/ARCHITECTURE.md` — the shared core, `state.js` app holder, the tool
  contract, the one global paced action queue, and the rendering model.
- `docs/DEVELOPMENT.md` — setup, the esbuild build/watch workflow, the golden
  rule, and the self-test.
- `docs/TOOLS.md` — per-tool reference for Ledger, Followers, and Pending.
- `docs/API.md` — the Instagram web API client, endpoints, and `scanList()`.
- `AGENTS.md` — conventions and guardrails for AI agents working in this repo.

---

## Project layout

```
.
├── dist/
│   └── instagram-suite.js   generated, pasteable bundle (do not edit)
├── src/                     modular source (edit here)
│   ├── core/                constants, utils, store, state, api, queue
│   ├── ui/                  css, components, shell
│   ├── tools/               ledger, followers, pending, pending-import
│   ├── selftest.js          self-check (__igsSelfTest)
│   └── main.js              entry point
├── docs/                    architecture, development, tools, api docs
├── README.md                this file
├── AGENTS.md                guide for AI coding agents
├── LICENSE                  MIT
├── package.json             build scripts + esbuild/lit-html devDependencies
└── .gitignore
```

---

## License

Released under the **MIT License** — see [`LICENSE`](./LICENSE).
