#!/usr/bin/env node
/**
 * The Events page, driven in a real browser: the look back at the latest
 * year (recap hero, chapters, achievements, sponsors) and the photo tour.
 *
 *   SITE=http://127.0.0.1:4479 node scripts/test-events-page.mjs
 *
 * SITE is a served build (`npx astro build --outDir <dir>`, then any static
 * server on that folder). Don't point it at `astro dev` while other sessions
 * write src/content: its reloads kill the page mid-run.
 *
 * What it checks, at 1440, 1024, 820 and 390px:
 *   - no console errors, no broken images, no sideways scroll
 *   - the tour's photos don't download until someone opens it
 *   - with nothing scheduled: the recap hero, one chapter per event of the
 *     latest year, the year's numbers, and no made-up quote
 *   - the tour: opens above the header, grid → photo → arrows → Escape back
 *     to the grid → Escape closes; a mosaic photo opens at that photo; a
 *     click with a key held is left to the browser
 *   - "Hear About … First" lands in the footer's newsletter box
 *   - axe (WCAG 2.1 AA) on the page and on the open tour
 * SHOTS=<dir> saves screenshots of each view.
 */
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const SITE = (process.env.SITE || '').replace(/\/$/, '');
if (!SITE) { console.error('Set SITE to a served build, e.g. SITE=http://127.0.0.1:4479'); process.exit(2); }
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let failures = 0;
let passes = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

async function axeScan(page, scope, label) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, scope);
  ok(res.length === 0, `axe: ${label}`, res.join('\n      '));
}

async function run(width) {
  const phone = width < 600;
  console.log(`\n── ${width}px ──`);
  const page = await browser.newPage();
  await page.setViewport({ width, height: phone ? 844 : 900, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  const errors = [];
  // A static server has no Pages Functions, so /api/* 404s there; that's the server, not the page.
  // Cloudflare's bot check (footer signup) logs "%c%d … NaN" from its own frame on every page.
  page.on('console', (m) => { if (m.type() === 'error' && !/\/api\/|challenges\.cloudflare\.com/.test(`${m.location()?.url || ''} ${m.text()}`)) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // Tour thumbnails are the only width-only, q=78 transforms on the page
  let tourOpened = false;
  const earlyTour = [];
  page.on('request', (req) => { const u = req.url(); if (!tourOpened && /imagedelivery/.test(u) && /\/w=\d+,q=78/.test(u) && !/fit=/.test(u)) earlyTour.push(u); });
  const res = await page.goto(`${SITE}/events/`, { waitUntil: 'networkidle2', timeout: 60000 });
  const html = await res.text();
  if (width === 1440) console.log(`  page HTML: ${Math.round(html.length / 1024)} KB`);

  // ── The page ──
  const info = await page.evaluate(() => ({
    recap: !!document.querySelector('.hero--recap'),
    upcoming: !!document.querySelector('.hero--event'),
    h1: document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim(),
    sub: document.querySelector('.hero-sub')?.textContent?.replace(/\s+/g, ' ').trim(),
    chapters: [...document.querySelectorAll('.ev-chapter')].map((c) => ({
      title: c.querySelector('.ev-chapter__title')?.textContent?.trim(),
      tiles: c.querySelectorAll('.ev-mosaic__tile').length,
      logos: c.querySelectorAll('.ev-chapter__logo img').length,
      lead: c.querySelector('.ev-chapter__lead')?.textContent?.trim(),
    })),
    year: [...document.querySelectorAll('.ev-year__item')].map((i) => `${i.querySelector('dd')?.textContent} ${i.querySelector('dt')?.textContent}`),
    fakeQuote: document.body.textContent.includes('Sarah Mitchell'),
    heroPhotos: document.querySelectorAll('.hero--recap [data-photo-tour] img').length,
    thumbs: document.querySelectorAll('[data-pt] [data-pt-photo]').length,
    dashes: (document.querySelector('main')?.innerText.match(/—/g) || []).length,
  }));
  console.log(`  hero: ${info.h1}`);
  console.log(`  ${info.sub}`);
  console.log(`  year: ${info.year.join(' · ')}`);
  info.chapters.forEach((c) => console.log(`  chapter: ${c.title} (${c.tiles} tiles, ${c.logos} logos) ${c.lead}`));
  if (info.upcoming) {
    console.log('  An event is scheduled, so the recap hero is off; checking the chapters and tour only.');
  } else {
    ok(info.recap, 'recap hero shows when nothing is scheduled');
    ok(/Full of Sunshine/.test(info.h1 || ''), 'hero headline names the year');
    ok(/Thank you for joining us at .+ in [A-Z][a-z]+/.test(info.sub || ''), 'hero thanks people by place and month', info.sub);
    ok(info.heroPhotos >= 1, 'hero shows real event photos');
  }
  ok(info.chapters.length >= 1, 'one chapter per event of the latest year');
  ok(info.chapters.every((c) => c.tiles > 0), 'every chapter has its photos');
  ok(info.year.length >= 2, 'the year at a glance has its numbers');
  ok(!info.fakeQuote, 'the made-up attendee quote is gone');
  ok(info.thumbs > 0, `the tour holds every photo (${info.thumbs})`);
  ok(info.dashes <= 1, `em dashes in the page copy: ${info.dashes}`);

  // Phone: nothing wider than the screen
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(overflow <= 0, `no sideways scroll (${overflow}px over)`);
  // The hero badge isn't cut off by the screen edge (the hero clips what hangs out)
  const badge = await page.evaluate(() => { const b = document.querySelector('.hero-stat')?.getBoundingClientRect(); return b ? { l: b.left, r: b.right } : null; });
  if (badge) ok(badge.l >= 0 && badge.r <= width, `the hero badge is fully on screen (${Math.round(badge.l)}–${Math.round(badge.r)} of ${width})`);

  // Every image on the page loads (scroll through so lazy ones fire)
  await page.evaluate(async () => {
    document.querySelectorAll('[data-reveal]').forEach((e) => e.classList.add('is-visible'));
    for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
  });
  await wait(2500);
  const broken = await page.evaluate(() => [...document.querySelectorAll('main img')]
    .filter((i) => !i.closest('[data-pt]') && i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src));
  ok(broken.length === 0, 'no broken images on the page', broken.slice(0, 5).join(', '));
  // Logos sit inside their tiles
  const spill = await page.evaluate(() => [...document.querySelectorAll('.ev-chapter__logo')].filter((li) => {
    const img = li.querySelector('img'); if (!img) return false;
    const a = li.getBoundingClientRect(); const b = img.getBoundingClientRect();
    return b.bottom > a.bottom + 1 || b.top < a.top - 1 || b.left < a.left - 1 || b.right > a.right + 1;
  }).length);
  ok(spill === 0, `sponsor logos fit their tiles (${spill} spill)`);
  if (SHOTS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(300);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewport({ width, height: Math.min(h, 12000), deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
    await wait(800);
    await page.screenshot({ path: `${SHOTS}/page-${width}.png` });
    await page.setViewport({ width, height: phone ? 844 : 900, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  }
  await axeScan(page, 'main', 'the page');

  // ── The tour, from the hero (or the first chapter) ──
  await page.evaluate(() => window.scrollTo(0, 0));
  ok(earlyTour.length === 0, `the tour's ${info.thumbs} photos wait until it opens (${earlyTour.length} loaded early)`);
  tourOpened = true;
  const opener = info.recap ? '.hero-ctas [data-photo-tour]' : '.ev-chapter__actions [data-photo-tour]';
  await page.$eval(opener, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(opener);
  await wait(400);
  let st = await page.evaluate(() => {
    const d = document.querySelector('[data-pt]');
    const close = d?.querySelector('[data-pt-close]');
    const r = close?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return {
      open: !!d?.open, grid: !d?.querySelector('[data-pt-grid]')?.hidden, url: location.pathname,
      closeOnTop: !!hit && !!close?.contains(hit), locked: document.documentElement.classList.contains('pt-open'),
      title: d?.querySelector('[data-pt-title]')?.textContent,
    };
  });
  ok(st.open && st.grid, 'the tour opens on the grid');
  ok(st.url === '/events/', 'opening it stays on the page');
  ok(st.closeOnTop, 'the tour sits above the sticky header');
  ok(st.locked, 'the page behind it stops scrolling');
  await wait(1500);
  const gridBroken = await page.evaluate(() => [...document.querySelectorAll('[data-pt] .pt__thumb img')].slice(0, 12)
    .filter((i) => i.complete && i.naturalWidth === 0).length);
  ok(gridBroken === 0, 'the first grid photos load');
  const rows = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-pt] .pt__grid li')].slice(0, 8).map((li) => li.getBoundingClientRect());
    const firstRow = items.filter((b) => Math.abs(b.top - items[0].top) < 2);
    return { n: firstRow.length, heights: [...new Set(firstRow.map((b) => Math.round(b.height)))] };
  });
  ok(rows.n >= 2 && rows.heights.length === 1, `grid rows share one height (${rows.n} in row one, heights ${rows.heights.join('/')})`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tour-grid-${width}.png` });
  await axeScan(page, '[data-pt]', 'the tour grid');

  // Grid → photo
  await page.click('[data-pt] [data-pt-photo]');
  await page.waitForFunction(() => { const i = document.querySelector('[data-pt-img]'); return i?.complete && i.naturalWidth > 0; }, { timeout: 15000 }).catch(() => {});
  st = await page.evaluate(() => {
    const d = document.querySelector('[data-pt]');
    const img = d.querySelector('[data-pt-img]');
    return { single: !d.querySelector('[data-pt-single]').hidden, count: d.querySelector('[data-pt-count]').textContent, loaded: img.complete && img.naturalWidth > 0, back: !d.querySelector('[data-pt-back]').hidden };
  });
  ok(st.single && /^1 \/ \d+$/.test(st.count), `a grid photo opens big (${st.count})`);
  ok(st.loaded, 'the big photo loads');
  ok(st.back, 'there is a way back to the grid');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tour-photo-${width}.png` });
  await axeScan(page, '[data-pt]', 'the photo view');
  // The photo stays clear of the controls (nothing drawn on the picture)
  const clear = await page.evaluate(() => {
    const d = document.querySelector('[data-pt]');
    const img = d.querySelector('[data-pt-img]').getBoundingClientRect();
    return [...d.querySelectorAll('[data-pt-prev], [data-pt-next], [data-pt-close], .pt__caption')].every((el) => {
      const b = el.getBoundingClientRect();
      return b.right <= img.left + 1 || b.left >= img.right - 1 || b.bottom <= img.top + 1 || b.top >= img.bottom - 1;
    });
  });
  ok(clear, 'arrows, caption and close sit beside the photo, not on it');

  await page.keyboard.press('ArrowRight');
  await wait(200);
  ok(/^2 \//.test(await page.$eval('[data-pt-count]', (e) => e.textContent)), 'ArrowRight shows the next photo');
  await page.keyboard.press('ArrowLeft');
  await wait(200);
  ok(/^1 \//.test(await page.$eval('[data-pt-count]', (e) => e.textContent)), 'ArrowLeft goes back');
  if (phone) {
    // Swipe left = next
    const box = await page.$eval('[data-pt-img]', (e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.touchscreen.touchStart(box.x + 80, box.y);
    await page.touchscreen.touchMove(box.x - 80, box.y);
    await page.touchscreen.touchEnd();
    await wait(300);
    ok(/^2 \//.test(await page.$eval('[data-pt-count]', (e) => e.textContent)), 'a swipe shows the next photo');
  }
  await page.keyboard.press('Escape');
  await wait(300);
  st = await page.evaluate(() => {
    const d = document.querySelector('[data-pt]');
    return { open: d.open, grid: !d.querySelector('[data-pt-grid]').hidden, focus: !!document.activeElement?.matches('[data-pt-photo]') };
  });
  ok(st.open && st.grid, 'Escape in the photo goes back to the grid');
  ok(st.focus, 'focus lands back on that photo in the grid');
  await page.keyboard.press('Escape');
  await wait(300);
  st = await page.evaluate(() => ({ open: document.querySelector('[data-pt]').open, locked: document.documentElement.classList.contains('pt-open') }));
  ok(!st.open && !st.locked, 'Escape in the grid closes the tour and frees the page');

  // ── A mosaic photo opens at that photo ──
  const tile = '.ev-chapter .ev-mosaic__tile:nth-child(3)';
  await page.$eval(tile, (el) => el.scrollIntoView({ block: 'center' }));
  await wait(300);
  const want = await page.$eval(tile, (a) => Number(a.dataset.photoIndex) + 1);
  await page.click(tile);
  await wait(800);
  st = await page.evaluate(() => {
    const d = document.querySelector('[data-pt]');
    return { open: d.open, count: d.querySelector('[data-pt-count]').textContent, back: !d.querySelector('[data-pt-back]').hidden, url: location.pathname };
  });
  ok(st.open && st.count.startsWith(`${want} /`), `a mosaic photo opens at that photo (${st.count}, expected ${want})`);
  ok(!st.back, 'opened straight to a photo, there is no grid to go back to');
  await page.click('[data-pt-close]');
  await wait(300);
  ok(!(await page.$eval('[data-pt]', (d) => d.open)), 'the close button closes it');

  // A click with a key held is left to the browser (new tab to the recap page)
  if (!phone) {
    const opened = await page.evaluate((sel) => {
      const a = document.querySelector(sel);
      let handled = null;
      // Last in line: note whether anyone took the click, then stop the real new tab
      window.addEventListener('click', (e) => { handled = e.defaultPrevented; e.preventDefault(); }, { once: true });
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, button: 0 }));
      return { open: document.querySelector('[data-pt]').open, handled, href: a.getAttribute('href') };
    }, tile);
    ok(!opened.open && opened.handled === false, `a key-held click is left to the browser (link: ${opened.href})`);
  }

  // ── "Hear About … First" ──
  if (info.recap) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(200);
    await page.click('.hero-ctas [data-newsletter-focus]');
    await wait(1800);
    st = await page.evaluate(() => ({ focus: document.activeElement?.id, url: location.href }));
    ok(st.focus === 'newsletter-email', 'the newsletter link puts the cursor in the signup box');
    ok(!st.url.includes('#'), 'and leaves the address bar alone');
  }

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
  await page.close();
}

for (const w of [1440, 1024, 820, 390]) await run(w);
await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
