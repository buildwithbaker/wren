// perf-note-open.mjs
// Measures note-open latency (click -> content painted) in a REAL Chromium,
// against the shipped app, on the local-folder backend. Not part of the build,
// the test suite or the shipped app - run by hand when touching the open path.
//
//   PLAYWRIGHT_CORE=<dir containing node_modules/playwright-core> \
//     node scripts/perf-note-open.mjs [url] [--browser=chrome|msedge] [--switches=30]
//
// playwright-core is deliberately NOT a dependency of this repo; install it
// anywhere (e.g. `npm i playwright-core` in a temp dir) and point
// PLAYWRIGHT_CORE at that directory. Uses the system Chrome/Edge (no download).
//
// Seam (no app changes): page.addInitScript stubs window.showDirectoryPicker to
// return an OPFS directory (navigator.storage.getDirectory()) seeded with 500
// ~2 KB notes plus one 50 KB note. When the URL is the Vite DEV server, module
// responses for the open path are rewritten in flight to record per-stage
// timings (readNote, parseNote, flush, teardownEditor, createEditor,
// createToolbar, ...). Against `npm run preview` only the click->painted total
// is available. Default URL: http://localhost:5173

/* global document, window, requestAnimationFrame, MutationObserver, innerWidth */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a)) || 'http://localhost:5173';
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const channel = opt('browser', 'chrome');
const SWITCHES = Number(opt('switches', 30));
const NOTE_COUNT = 500;
const BIG_ID = '2026-10-22 - Perf BIG note.md';

const core = process.env.PLAYWRIGHT_CORE;
if (!core) {
  console.error('Set PLAYWRIGHT_CORE to a directory containing node_modules/playwright-core');
  process.exit(2);
}
const { chromium } = createRequire(resolve(core, 'package.json'))('playwright-core');

// --- in-flight instrumentation (dev server only) -----------------------------
const PUSH = "(window.__perf||(window.__perf=[])).push";
function wrapExport(text, name) {
  if (!text.includes(`export function ${name}(`)) return text;
  return (
    text.replace(`export function ${name}(`, `function __orig_${name}(`) +
    `\nexport function ${name}(...a){const t=performance.now();try{return __orig_${name}(...a)}finally{${PUSH}(['${name}',performance.now()-t])}}\n`
  );
}
function instrument(path, text) {
  if (/\/src\/editor\.js/.test(path)) return wrapExport(text, 'createEditor');
  if (/\/src\/ui\/toolbar\.js/.test(path)) return wrapExport(text, 'createToolbar');
  if (/\/src\/ui\/note-editor\.js/.test(path)) {
    let t = text.replace(
      /function teardownEditor\(\) \{/,
      `function teardownEditor(){const t=performance.now();try{return __teardownImpl()}finally{${PUSH}(['teardownEditor',performance.now()-t])}}\nfunction __teardownImpl() {`
    );
    t = t.replace(
      /await flush\(\);\s+teardownEditor\(\);/,
      `{const t=performance.now();await flush();${PUSH}(['flush',performance.now()-t]);const p=performance.now();void document.body.offsetHeight;${PUSH}(['  layout probe after flush (offsetHeight)',performance.now()-p]);}\n    teardownEditor();`
    );
    return t;
  }
  // render() of the three list surfaces + Kanban's refresh(): one timed wrapper each.
  if (/\/src\/ui\/(notes-list|compact-view)\.js/.test(path)) {
    const label = /compact-view/.test(path) ? 'compact render' : 'list render';
    return text.replace(
      /function render\(\) \{/,
      `function render(){const t=performance.now();try{return __renderImpl()}finally{${PUSH}(['${label}',performance.now()-t])}}
function __renderImpl() {`
    );
  }
  if (/\/src\/ui\/kanban-view\.js/.test(path)) {
    return text.replace(
      'refresh: () => render({ rebuildToolbar: !addingTag }),',
      `refresh: () => { const t=performance.now(); try { return render({ rebuildToolbar: !addingTag }); } finally { ${PUSH}(['kanban refresh',performance.now()-t]); } },`
    );
  }
  if (/\/src\/app-controller\.js/.test(path)) {
    const at = text.indexOf('async function openNote(noteId');
    if (at < 0) return text;
    const head = text.slice(0, at);
    let tail = text.slice(at);
    tail = tail.replace(
      'const { content, revision, name } = await adapter.readNote(noteId);',
      `const __t1=performance.now();const { content, revision, name } = await adapter.readNote(noteId);${PUSH}(['readNote',performance.now()-__t1]);`
    );
    tail = tail.replace(
      'const parsed = parseNote(content, noteId);',
      `const __t2=performance.now();const parsed = parseNote(content, noteId);${PUSH}(['parseNote',performance.now()-__t2]);`
    );
    tail = tail.replace(
      /await noteEditor\.openNote\(fresh, \{ focusTitle \}\);/,
      `{const __t3=performance.now();await noteEditor.openNote(fresh, { focusTitle });${PUSH}(['noteEditor.openNote (total)',performance.now()-__t3]);}`
    );
    // Save path (runs inside flush() when a pending edit is flushed on switch).
    const sAt = tail.indexOf('async function handleSave(note)');
    if (sAt >= 0) {
      const a = tail.slice(0, sAt);
      let b = tail.slice(sAt);
      let n = 0;
      const timed = (needle, label) => {
        const v = `__s${n++}`;
        b = b.replace(needle, `const ${v}=performance.now();${needle}${PUSH}(['  save: ${label}',performance.now()-${v}]);`);
      };
      timed('const { revision } = await adapter.writeNote(note.id, content, note.revision);', 'adapter.writeNote');
      timed('await syncBackendFilename(note);', 'syncBackendFilename');
      timed('list.setNotes(notes);', 'list.setNotes (re-render)');
      tail = a + b;
    }
    return head + tail;
  }
  return text;
}

// --- fixture -----------------------------------------------------------------
function seedFixture() {
  return async ({ count, bigBytes }) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('wren-notes', { recursive: true });
    } catch {
      /* first run */
    }
    const dir = await root.getDirectoryHandle('wren-notes', { create: true });
    const para = (i, j) =>
      `Paragraph ${j} of note ${i}: **bold** text, *italic* text, a [link](https://example.com/${i}/${j}) and \`code\`. ` +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.';
    const body = (i, target) => {
      let s = `MARKER-${i}\n\n## Heading ${i}\n\n`;
      let j = 0;
      while (s.length < target) {
        s += para(i, j) + '\n\n';
        if (j % 4 === 0) s += `- item a ${i}\n- item b ${i}\n- item c ${i}\n\n`;
        if (j % 5 === 0) s += `- [ ] task ${i}\n- [x] done ${i}\n\n`;
        j++;
      }
      return s;
    };
    const now = '2026-10-22T12:00:00.000Z';
    const write = async (name, text) => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
    };
    for (let i = 0; i < count; i++) {
      const id = String(i).padStart(4, '0');
      const fm = `---\nid: wren-perf${id}\ntitle: ${JSON.stringify(`Perf note ${id}`)}\ncreated: ${now}\nmodified: ${now}\ncolor: default\ntags: ["project:perf", "status:${i % 3}"]\n---\n`;
      // Real Wren filenames (`<created date> - <title>.md`) so a save never triggers a rename.
      await write(`2026-10-22 - Perf note ${id}.md`, fm + body(id, 2000));
    }
    const fm = `---\nid: wren-perfbig\ntitle: ${JSON.stringify('Perf BIG note')}\ncreated: ${now}\nmodified: ${now}\ncolor: default\ntags: ["project:perf"]\n---\n`;
    await write('2026-10-22 - Perf BIG note.md', fm + body('BIG', bigBytes));
  };
}

// Runs in the page: click a card, resolve when the note's content is painted.
function pageOpen() {
  return async ({ id, title, marker }) => {
    const btn = document.querySelector(`.sc-list:not(.sc-list--compact) .sc-card[data-id="${id}"] .sc-card-open`);
    if (!btn) throw new Error(`no card for ${id}`);
    window.__perf = [];
    const titleInput = document.querySelector('.sc-title-input');
    const done = (resolve) => {
      const check = () =>
        titleInput.value === title &&
        document.querySelector('.sc-editor-body .ProseMirror')?.textContent.includes(marker) &&
        !!document.querySelector('.sc-toolbar') &&
        document.querySelector('.sc-editor-body .ProseMirror').offsetParent !== null;
      if (check()) return resolve();
      const mo = new MutationObserver(() => {
        if (check()) {
          mo.disconnect();
          resolve();
        }
      });
      mo.observe(document.querySelector('.sc-editor-body'), { childList: true, subtree: true, characterData: true });
      mo.observe(document.querySelector('.sc-editor'), { childList: true, subtree: true });
    };
    const t0 = performance.now();
    btn.click();
    await new Promise(done);
    // Two frames: the first runs before the next paint, the second after it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const total = performance.now() - t0;
    const stages = Object.fromEntries(window.__perf);
    return { total, stages };
  };
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const f = (n) => (n === undefined ? '   -  ' : n.toFixed(1).padStart(7));

function report(label, runs) {
  const names = new Set(['TOTAL click->painted']);
  runs.forEach((r) => Object.keys(r.stages).forEach((k) => names.add(k)));
  console.log(`\n## ${label}  (n=${runs.length})`);
  console.log('stage'.padEnd(32) + '    p50 ms    p95 ms');
  for (const n of names) {
    const vals = runs.map((r) => (n.startsWith('TOTAL') ? r.total : r.stages[n])).filter((v) => v !== undefined);
    if (!vals.length) continue;
    console.log(n.padEnd(32) + f(pct(vals, 50)) + '   ' + f(pct(vals, 95)));
  }
}

// --- run ---------------------------------------------------------------------
const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({
      type: 'longtask',
      buffered: true,
    });
  } catch {
    /* Long Tasks API unavailable */
  }
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('wren-notes', { create: true });
  };
});
await context.route('**/src/**/*.js*', async (route) => {
  const u = new URL(route.request().url());
  const resp = await route.fetch();
  const text = await resp.text();
  const out = instrument(u.pathname, text);
  await route.fulfill({ response: resp, body: out });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(url);
await page.evaluate(seedFixture(), { count: NOTE_COUNT, bigBytes: 50 * 1024 });
await page.getByRole('button', { name: 'Choose folder' }).click();
await page.waitForSelector(`.sc-card[data-id="${BIG_ID}"]`, { state: "attached", timeout: 60000 });
// The app always LAUNCHES in Compact (editor display:none); measure in List view
// so the editor is laid out and painted like a real open.
await page.locator('.sc-viewtoggle button[data-mode="list"]').first().evaluate((b) => b.click());
await page.waitForSelector('.sc-editor', { state: 'visible' });
const cards = await page.locator('.sc-card').count();
console.log(`app: ${url}  browser: ${channel}  cards rendered: ${cards}`);

const open = pageOpen();
const ids = [];
// Deterministic pseudo-random order over the small notes.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
while (ids.length < Math.max(SWITCHES, 20) + 3) {
  const n = Math.floor(rnd() * NOTE_COUNT);
  if (!ids.length || ids[ids.length - 1] !== n) ids.push(n);
}
const spec = (n) => {
  const id = String(n).padStart(4, '0');
  return { id: `2026-10-22 - Perf note ${id}.md`, title: `Perf note ${id}`, marker: `MARKER-${id}` };
};

const small = [];
for (let k = 0; k < ids.length; k++) {
  const r = await page.evaluate(open, spec(ids[k]));
  if (k === 0 && process.env.PERF_SHOT_OPEN) await page.screenshot({ path: process.env.PERF_SHOT_OPEN });
  if (k >= 3) small.push(r); // first 3 are warm-up
}
report(`500 notes x ~2 KB, ${SWITCHES} switches (previous note clean)`, small);

// 50 KB note on its own, alternating with a small note.
const big = [];
for (let k = 0; k < SWITCHES + 3; k++) {
  await page.evaluate(open, spec(ids[k % ids.length]));
  const r = await page.evaluate(open, { id: BIG_ID, title: 'Perf BIG note', marker: 'MARKER-BIG' });
  if (k >= 3) big.push(r);
}
report(`50 KB note, ${SWITCHES} opens`, big);

// Dirty switch: a pending edit in the previous note must be flushed + saved.
const dirty = [];
for (let k = 0; k < 15; k++) {
  await page.evaluate(open, spec(ids[k]));
  try {
    await page.click('.sc-editor-body .ProseMirror', { timeout: 5000 });
  } catch (e) {
    await page.screenshot({ path: process.env.PERF_SHOT || 'perf-fail.png' });
    console.log(await page.evaluate(() => { const e = document.querySelector('.sc-editor-body'); const r = e.getBoundingClientRect(); return JSON.stringify({ r: [r.x, r.y, r.width, r.height], vw: innerWidth, view: document.querySelector('[data-view]')?.dataset.view }); }));
    console.log('page errors:', [...new Set(errors)].slice(0, 6));
    throw e;
  }
  await page.keyboard.type('x');
  const r = await page.evaluate(open, spec(ids[k + 1]));
  if (k >= 2) dirty.push(r);
}
report('switch away from a note with a pending edit (flush writes the file)', dirty);

// --- post-save list update ---------------------------------------------------
// Edit one note and let the debounced autosave fire (no switch). Reports the
// list re-render the save triggers and any long tasks (>50 ms) in the window.
const stageRows = (label, samples) => {
  const names = new Set();
  samples.forEach((r) => Object.keys(r.stages).forEach((k) => names.add(k)));
  console.log(`
## ${label}  (n=${samples.length})`);
  console.log('stage'.padEnd(40) + '    p50 ms    p95 ms');
  for (const n of names) {
    const vals = samples.map((r) => r.stages[n]).filter((v) => v !== undefined);
    if (vals.length) console.log(n.padEnd(40) + f(pct(vals, 50)) + '   ' + f(pct(vals, 95)));
  }
  const lts = samples.flatMap((r) => r.lt || []);
  if (samples.some((r) => r.lt)) console.log(`long tasks >50 ms: count ${lts.length}, longest ${lts.length ? Math.max(...lts).toFixed(0) : 0} ms`);
};
const saves = [];
for (let k = 0; k < SWITCHES; k++) {
  await page.evaluate(open, spec(ids[k]));
  await page.evaluate(() => { window.__perf = []; window.__lt = []; });
  await page.click('.sc-editor-body .ProseMirror', { timeout: 5000 });
  await page.keyboard.type('x');
  await page.waitForTimeout(900); // 500 ms debounce + save + re-render
  saves.push(await page.evaluate(() => ({ stages: Object.fromEntries(window.__perf), lt: [...window.__lt] })));
}
stageRows('one post-save list update (edit, wait for autosave)', saves);

// --- typing for 10 s with autosave firing ----------------------------------
await page.evaluate(open, spec(ids[0]));
await page.click('.sc-editor-body .ProseMirror', { timeout: 5000 });
await page.evaluate(() => { window.__perf = []; window.__lt = []; });
const typingStart = Date.now();
let bursts = 0;
while (Date.now() - typingStart < 10000) {
  await page.keyboard.type('word ', { delay: 60 }); // ~300 ms of typing
  await page.waitForTimeout(650); // pause > the 500 ms debounce, so a save fires
  bursts++;
}
await page.waitForTimeout(800);
const typing = await page.evaluate(() => ({ lt: [...window.__lt] }));
console.log(
  `
## typing for 10 s (${bursts} type-pause bursts, one autosave each)
long tasks >50 ms: count ${typing.lt.length}, longest ${typing.lt.length ? Math.max(...typing.lt).toFixed(0) : 0} ms`
);

// --- Kanban refresh + compact render at 500 notes --------------------------
const views = [];
for (let k = 0; k < 10; k++) {
  for (const sel of ['.sc-viewtoggle button[data-mode="kanban"]', '.sc-compact-btn']) {
    await page.evaluate(() => { window.__perf = []; });
    await page.locator(sel).first().evaluate((b) => b.click());
    await page.waitForTimeout(400);
    views.push({ stages: await page.evaluate(() => Object.fromEntries(window.__perf)) });
    await page.locator('.sc-viewtoggle button[data-mode="list"]').first().evaluate((b) => b.click());
    await page.waitForTimeout(200);
  }
}
stageRows('Kanban / Compact view switch (each switch re-renders that surface)', views);

if (errors.length) console.log('\nconsole/page errors:\n' + [...new Set(errors)].slice(0, 10).join('\n'));
await browser.close();
