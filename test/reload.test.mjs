/**
 * Reload regression test.
 *
 * `WKWebView.reload()` re-navigates to the document's URL. Documents created by
 * `loadHTMLString(_:baseURL:)` have no URL, so a plain reload lands on
 * `about:blank` and the window stays blank forever — this is what broke GAPPs,
 * whose host injects state and runtime into an inline HTML string.
 *
 * The host now remembers each window's content source and replays it on reload.
 * These cases pin that behaviour for both inline HTML and on-disk files.
 */

import { open } from '../src/glimpse.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 10_000;
const SETTLE_MS = 1_400;

/** Mirrors a GAPP document: runtime + state inlined before the page scripts run. */
const GAPP_HTML = (state) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>reload</title>
<script>
window.__GAPP_STATE__ = ${JSON.stringify(state)};
window.GappStore = {
  get: function(){ return window.__GAPP_STATE__; },
  set: function(p){ window.__GAPP_STATE__ = Object.assign({}, window.__GAPP_STATE__, p); render(); },
  subscribe: function(){ return function(){}; }
};
</script></head><body>
<h1 id="title"></h1><ul id="list"></ul>
<script>
  function render(){
    var s = window.GappStore.get() || {};
    document.getElementById('title').textContent = 'items=' + (s.items || []).length;
    document.getElementById('list').innerHTML =
      (s.items || []).map(function(i){ return '<li>' + i + '</li>'; }).join('');
  }
  render();
</script></body></html>`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
}

function check(name, ok, detail) {
  if (ok) pass(name);
  else fail(`${name} — ${detail}`);
}

function waitForReady(win) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ready')), TIMEOUT_MS);
    win.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Read page-visible facts back through the Glimpse message channel. */
function probe(win) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for probe')), TIMEOUT_MS);
    const onMessage = (msg) => {
      clearTimeout(timer);
      win.off('message', onMessage);
      resolve(msg);
    };
    win.on('message', onMessage);
    win.send(`window.glimpse.send({
      url: location.href,
      body: document.body ? document.body.innerText.trim() : '',
      state: window.__GAPP_STATE__ ?? null
    })`);
  });
}

console.log('glimpse reload regression test\n');

let win;
let fileWin;
try {
  // ── Case 1: inline HTML keeps its content and re-runs its scripts ────────
  win = open(GAPP_HTML({ items: ['a', 'b'] }), { width: 420, height: 260, title: 'reload-inline' });
  await waitForReady(win);
  await wait(300);

  const before = await probe(win);
  check('inline: initial render', before.body.includes('items=2'), JSON.stringify(before));

  // A user edit, like ticking a checkbox in a GAPP.
  win.send(`window.GappStore.set({ items: ['a','b','c'] })`);
  await wait(300);
  const edited = await probe(win);
  check('inline: edit applied before reload', edited.body.includes('items=3'), JSON.stringify(edited));

  // Exactly what Cmd-R / View > Reload Page / location.reload() does.
  win.send(`location.reload()`);
  await wait(SETTLE_MS);
  const after = await probe(win);

  check('inline: document URL unchanged', after.url === 'about:blank', after.url);
  check('inline: page is not blank after reload', after.body.length > 0, JSON.stringify(after.body));
  check('inline: runtime reinstalled', typeof after.state === 'object' && after.state !== null, JSON.stringify(after.state));
  check(
    'inline: state matches the open-time snapshot',
    (after.state?.items ?? []).length === 2,
    JSON.stringify(after.state),
  );
  check('inline: UI consistent with state', after.body.includes('items=2'), JSON.stringify(after.body));

  // ── Case 2: a file source re-reads from disk instead of replaying bytes ──
  const dir = mkdtempSync(join(tmpdir(), 'glimpse-reload-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, '<!DOCTYPE html><html><body><h1>v1</h1></body></html>');

  fileWin = open('<html><body>placeholder</body></html>', { width: 400, height: 200, title: 'reload-file' });
  await waitForReady(fileWin);
  fileWin.loadFile(file);
  await wait(700);

  const fileBefore = await probe(fileWin);
  check('file: loaded from disk', fileBefore.body.includes('v1'), JSON.stringify(fileBefore));

  writeFileSync(file, '<!DOCTYPE html><html><body><h1>v2</h1></body></html>');
  fileWin.send(`location.reload()`);
  await wait(SETTLE_MS);

  const fileAfter = await probe(fileWin);
  check('file: reload re-reads disk', fileAfter.body.includes('v2'), JSON.stringify(fileAfter.body));

  win.close();
  fileWin.close();
  await wait(600);

  console.log(process.exitCode ? '\nReload regression FAILED' : '\nAll reload tests passed');
  process.exit(process.exitCode ?? 0);
} catch (error) {
  console.error(`\n  ✗ ${error.message}`);
  win?.close();
  fileWin?.close();
  process.exit(1);
}
