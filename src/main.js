// Entry point. Bundled by esbuild into dist/instagram-suite.js (IIFE) — the file
// you paste into the console. Tears down any previous instance, injects the
// stylesheet, boots the three tools through the shared queue, renders the shell
// and exposes the `IGS` console handle.
import { HOST } from './core/constants.js';
import { queue } from './core/queue.js';
import { app } from './core/state.js';
import { CSS } from './ui/css.js';
import { renderShell, mountModule, teardown, renderQueuePanel, setModules } from './ui/shell.js';
import { ledger } from './tools/ledger.js';
import { followers } from './tools/followers.js';
import { pending } from './tools/pending.js';
import { selfTest } from './selftest.js';

// teardown a previous instance
document.getElementById('igs-root')?.remove();
document.getElementById('igs-style')?.remove();

if (location.hostname !== HOST && location.hostname !== 'instagram.com') {
  // still usable for the Pending importer; warn but continue
  console.warn('[Instagram Suite] Not on instagram.com — scans/actions disabled; the Pending importer still works.');
}

const styleEl = document.createElement('style');
styleEl.id = 'igs-style';
styleEl.textContent = CSS;
document.head.appendChild(styleEl);

app.root = document.createElement('div');
app.root.id = 'igs-root';
document.body.appendChild(app.root);

const modules = [ledger, followers, pending];
setModules(modules);
modules.forEach((m) => m.boot?.());
queue.load();
renderShell();
mountModule('ledger');
renderQueuePanel();
// control handle (mirrors the originals' window.IGFM / window.IGPR)
globalThis.IGS = { version: '1.0.0', mount: mountModule, close: teardown, queue };
globalThis.__igsSelfTest = selfTest;
if (queue.items.some((i) => i.status === 'pending' || i.status === 'running')) queue.start();
try { globalThis.__igsSelfTest(); } catch { /* non-fatal */ }
