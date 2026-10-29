/**
 * popup-audit.mjs — is every pop-up a test opens fully on top?
 * ============================================================================
 * Loaded ahead of any puppeteer test, it watches each page for menus,
 * listboxes and popovers (anything positioned absolute or fixed, or in the
 * top layer) and, as each one shows and again after the page scrolls under
 * it, hit-tests a grid of points across it. A point that lands on something
 * else means the pop-up is covered there (a sticky bar, a later card, a
 * toast) or clipped by a parent: the "…" menu that slid under the editors'
 * section bar. Nothing in the test itself changes.
 *
 *   node --import ./scripts/lib/popup-audit.mjs scripts/test-kids-admin.mjs
 *
 * Findings print when the test exits and land in
 * test-results/popup-audit/<test>.json. With POPUP_AUDIT_STRICT=1 a finding
 * makes the run exit non-zero.
 */
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const findings = new Map();

// Runs in the page: find pop-ups as they show, sample them, report the misses
const watcher = () => {
  const SEL = '[role="menu"], [role="listbox"], [popover], .apl-popover, .bd-pop__panel';
  const shown = new WeakSet();
  const describe = (el) => {
    if (!el) return 'nothing';
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    const label = el.getAttribute('aria-label') || (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}${label ? ` “${label}”` : ''}`;
  };
  // The pop-up's own box: itself, or the nearest absolute/fixed parent within a few levels
  const boxOf = (el) => {
    for (let n = el, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      const pos = getComputedStyle(n).position;
      if (pos === 'absolute' || pos === 'fixed' || n.matches(':popover-open')) return n;
    }
    return null;
  };
  // Dialog overlays fill the screen and sit under toasts by design: not pop-ups
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const fills = r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
    return r.width > 8 && r.height > 8 && !fills && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const check = (box, when) => {
    if (!box.isConnected || !visible(box)) return;
    const r = box.getBoundingClientRect();
    // Inset past the rounded corners, whose tips show what's behind
    const inset = Math.max(3, Math.min(parseFloat(getComputedStyle(box).borderTopLeftRadius) || 0, 16));
    const x0 = Math.max(r.left, 0) + inset, x1 = Math.min(r.right, innerWidth) - inset;
    const y0 = Math.max(r.top, 0) + inset, y1 = Math.min(r.bottom, innerHeight) - inset;
    if (x1 <= x0 || y1 <= y0) return;
    const by = new Map();
    let total = 0;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const x = x0 + ((x1 - x0) * i) / 4, y = y0 + ((y1 - y0) * j) / 4;
      total++;
      const hit = document.elementFromPoint(x, y);
      if (hit && box.contains(hit)) continue;
      // Clipped (the point shows what's under the box) or covered (something above it)
      const what = hit && hit.contains(box) ? `clipped by ${describe(hit)}` : `covered by ${describe(hit)}`;
      by.set(what, (by.get(what) || 0) + 1);
    }
    for (const [what, n] of by) {
      window.__popupAuditReport?.(JSON.stringify({
        popup: describe(box), what, points: `${n} of ${total}`, when,
        width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), at: location.pathname + location.hash,
      }));
    }
  };
  const scan = () => {
    document.querySelectorAll(SEL).forEach((el) => {
      const box = boxOf(el);
      if (!box || shown.has(box) || !visible(box)) return;
      shown.add(box);
      requestAnimationFrame(() => requestAnimationFrame(() => check(box, 'opened')));
      setTimeout(() => check(box, 'settled'), 220);
    });
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; scan(); });
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'aria-expanded', 'style'] });
  let scrolled = 0;
  addEventListener('scroll', () => {
    clearTimeout(scrolled);
    scrolled = setTimeout(() => document.querySelectorAll(SEL).forEach((el) => { const box = boxOf(el); if (box && visible(box)) check(box, 'after scrolling'); }), 150);
  }, true);
};

async function watch(page) {
  await page.exposeFunction('__popupAuditReport', (json) => {
    const f = JSON.parse(json);
    const key = `${f.popup} | ${f.what} | ${f.width}px`;
    if (!findings.has(key)) findings.set(key, f);
  }).catch(() => {});
  await page.evaluateOnNewDocument(watcher).catch(() => {});
}

function hook(browser) {
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => { const page = await newPage(...args); await watch(page); return page; };
  const newContext = browser.createBrowserContext?.bind(browser);
  if (newContext) browser.createBrowserContext = async (...args) => {
    const ctx = await newContext(...args);
    const ctxPage = ctx.newPage.bind(ctx);
    ctx.newPage = async (...a) => { const page = await ctxPage(...a); await watch(page); return page; };
    return ctx;
  };
  return browser;
}

const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async (...args) => hook(await launch(...args));
const connect = puppeteer.connect.bind(puppeteer);
puppeteer.connect = async (...args) => hook(await connect(...args));

process.on('exit', (code) => {
  const test = basename(process.argv[1] || 'test', '.mjs');
  const list = [...findings.values()];
  const dir = join(ROOT, 'test-results/popup-audit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${test}.json`), JSON.stringify(list, null, 2));
  console.log(`\nPop-up audit (${test}): ${list.length ? `${list.length} pop-up${list.length === 1 ? '' : 's'} not fully on top` : 'every pop-up opened fully on top'}`);
  for (const f of list) console.log(`  ✗ ${f.popup}: ${f.what} (${f.points} points, ${f.width}×${f.height}, ${f.when}, ${f.at})`);
  if (list.length && process.env.POPUP_AUDIT_STRICT === '1' && !code) process.exitCode = 1;
});
