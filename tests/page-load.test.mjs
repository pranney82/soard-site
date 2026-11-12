/**
 * onPageLoad (src/utils/page-load.ts): a page's scripts set it up as soon as it's read in, not when every photo has
 * arrived (Astro's first astro:page-load waits for the window's load event), and once for every page the tab shows.
 * Run: node --test tests/page-load.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const code = buildSync({ entryPoints: ['src/utils/page-load.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' }).outputFiles[0].text;

/** A tab: a document that is still being read in (or already read), drawn or not yet, and its own copy of the module */
async function tab(readyState = 'loading', { painted = false } = {}) {
  const doc = new EventTarget();
  doc.readyState = readyState;
  globalThis.document = doc;
  const frames = [];
  const paints = painted ? [{ name: 'first-paint' }] : [];
  globalThis.requestAnimationFrame = (cb) => frames.push(cb);
  Object.defineProperty(globalThis, 'performance', { value: { getEntriesByType: (t) => (t === 'paint' ? paints : []) }, configurable: true, writable: true });
  const mod = await import(`data:text/javascript,${encodeURIComponent(code)}#${Math.random()}`);
  const fire = (type) => { if (type === 'DOMContentLoaded') doc.readyState = 'interactive'; doc.dispatchEvent(new Event(type)); };
  /** The browser draws the page: the next frame's callbacks, then what they put off until after it */
  const paint = async () => { paints.push({ name: 'first-paint' }); frames.splice(0).forEach((cb) => cb()); await new Promise((r) => setTimeout(r, 5)); };
  return { ...mod, doc, fire, paint };
}

test('the page a tab opens is set up once it has been read in and drawn, and not again at window load', async () => {
  const t = await tab('loading');
  let n = 0;
  t.onPageLoad(() => n++);
  assert.equal(n, 0, 'not while the page is still arriving');
  t.fire('DOMContentLoaded');
  assert.equal(n, 0, 'read in, not drawn yet: the setup never holds the first paint back');
  await t.paint();
  assert.equal(n, 1, 'right after it is drawn');
  t.fire('astro:page-load'); // Astro's own, at window load
  assert.equal(n, 1, 'once');
});

test('a script that arrives after the page was drawn (a slow connection) sets it up at once', async () => {
  const t = await tab('interactive', { painted: true });
  let n = 0;
  t.onPageLoad(() => n++);
  assert.equal(n, 1);
  t.fire('astro:page-load');
  assert.equal(n, 1);
});

test('every page the router swaps in is set up once', async () => {
  const t = await tab('interactive', { painted: true });
  let n = 0;
  t.onPageLoad(() => n++);
  assert.equal(t.firstPage(), true);
  t.fire('astro:after-swap');
  assert.equal(t.firstPage(), false);
  t.fire('astro:page-load');
  assert.equal(n, 2);
  t.fire('astro:page-load');
  assert.equal(n, 2, 'a repeat of the same page changes nothing');
  t.fire('astro:after-swap');
  t.fire('astro:page-load');
  assert.equal(n, 3);
});

test('a script first run after a move sets up the page it lands on, once', async () => {
  const t = await tab('complete', { painted: true });
  t.fire('astro:after-swap'); // the module was already here; this page's script is new
  let n = 0;
  t.onPageLoad(() => n++);
  assert.equal(n, 1, 'at once, for the page it lands on');
  t.fire('astro:page-load');
  assert.equal(n, 1, 'and not again when the router says that page is ready');
});

test('a page never drawn (a tab opened in the background) is set up by Astro\'s own call at window load', async () => {
  const t = await tab('loading');
  let n = 0;
  t.onPageLoad(() => n++);
  t.fire('DOMContentLoaded');
  t.fire('astro:page-load');
  assert.equal(n, 1);
  await t.paint();
  assert.equal(n, 1, 'and not again when it is shown');
});

test('no page script waits for Astro\'s first page-load any more', () => {
  // Tracked or not: a new script is caught before it's committed too
  const raw = execSync("git grep -n --untracked \"addEventListener('astro:page-load'\" -- src || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  // onPageLoad itself, and the auction bar's inline script, which sets itself up where it's read and uses the event
  // only after in-site moves
  assert.deepEqual(raw.map((l) => l.split(':')[0]).sort(), ['src/components/global/AuctionBar.astro', 'src/utils/page-load.ts']);
  assert.match(readFileSync('src/components/global/AuctionBar.astro', 'utf8'), /wire\(\);\s+tick\(\);\s+setTimeout\(enter, 350\);/);
});

test('what the scroll-in rise shows on screen is shown before the opened page is drawn', () => {
  const sr = readFileSync('src/components/ui/ScrollReveal.astro', 'utf8');
  assert.match(sr, /\n  revealAboveFold\(\);\n[\s\S]*onPageLoad\(initReveal\);/);
});

test('pictures already arriving on the page a tab opens keep drawing; lazy ones fade in', () => {
  const lqip = readFileSync('src/components/ui/LqipReveal.astro', 'utf8');
  assert.match(lqip, /if \(firstPage\(\) && img\.loading !== 'lazy'\) \{/);
  assert.match(lqip, /onPageLoad\(initLqip\);/);
});

test('the phone menu works before any script file has arrived: its code is in the page, after the menu', () => {
  const header = readFileSync('src/components/global/Header.astro', 'utf8');
  const panelEnd = header.indexOf('<script is:inline>(function(){if(window.__mnav)');
  assert.ok(panelEnd > header.indexOf('id="mobile-panel"'), 'right after the menu it works');
  const inline = header.slice(panelEnd, header.indexOf('</script>', panelEnd));
  for (const part of ["closest('#mobile-toggle')", "e.key==='Escape'", "e.key!=='Tab'", "'(min-width: 1024px)'", "'astro:before-swap'", "toggleAttribute('inert',on)", "'--apply-bar-h'"]) assert.ok(inline.includes(part), part);
  // and only there: the header's script file has no second copy
  const moduleStart = header.indexOf("<script>\nimport { prefetch }");
  const moduleScript = header.slice(moduleStart, header.indexOf('</script>', moduleStart));
  assert.doesNotMatch(moduleScript, /mobile-toggle|mobileOpen|menu-open/);
});

test('onPageLoad and the site helpers ride in the one shared file the page router imports, so no page waits on a file found late', () => {
  const config = readFileSync('astro.config.mjs', 'utf8');
  const chunks = config.slice(config.indexOf('const SHARED_CHUNKS = ['), config.indexOf('];', config.indexOf('const SHARED_CHUNKS = [')));
  assert.equal((chunks.match(/\['[a-z-]+', /g) || []).length, 1, 'one shared file');
  for (const m of ['node_modules[\\\\/]astro', 'page-load', 'cf-image', 'live-client', 'live-banner', 'reveals-client', 'signup-check']) assert.ok(chunks.includes(m), m);
});
