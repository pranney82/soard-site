/**
 * test-how-it-works.mjs — drive /how-it-works/ in a real browser
 * ============================================================================
 * At 1440px (sidebar rail), 900px (sticky pill bar) and a 390px phone:
 *   - no console errors, nothing wider than the screen
 *   - the hero's "Follow the build" and every chapter link glide to the chapter
 *     and seat its heading just under the sticky chrome; the link and the
 *     chapter say they're current; Back returns to the previous chapter
 *   - the rail's line fills as you read (and the pill bar's underline)
 *   - the floor plan switches Existing ⇄ Proposed (buttons, caption, picture)
 *   - the design boards step with the arrows and the counter follows
 *   - the image viewer opens above the site header from the plan, a board and
 *     a survey photo; arrows step, Escape and the dark surround close it, and
 *     focus returns to what opened it
 *   - the before/after handle sweeps once on its own, then follows the
 *     keyboard and the pointer
 *   - the rooms-per-year columns add up to the rooms-built total and the
 *     featured project's year is the highlighted column; hovering shows a tip
 *   - the reveal video loads its player on click
 *   - with reduced motion, chapters are visible at once and jumps are instant
 *   - hover never drops a control's text under WCAG contrast
 * Screenshots land in test-results/how-it-works/. Exits non-zero on failure.
 *
 *   SITE=http://localhost:4321 node scripts/test-how-it-works.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after. While
 * other sessions are writing src/content, dev reloads the page mid-run; test a
 * build instead (npx astro build --outDir <dir>, then serve <dir> statically).
 * A static server has no /api, so the live indicator's socket errors are ignored.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hoverSweep } from './lib/hover-sweep.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/how-it-works/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hoverSeen = new Set();

let SITE = process.env.SITE?.replace(/\/$/, '');
let dev = null;
if (!SITE) {
  const port = 4300 + Math.floor(Math.random() * 600);
  dev = spawn('npx', ['astro', 'dev', '--port', String(port)], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  SITE = `http://localhost:${port}`;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('astro dev did not start within 2 minutes')), 120000);
    const seen = (b) => { if (/Local\s+http/.test(String(b))) { clearTimeout(t); resolve(); } };
    dev.stdout.on('data', seen);
    dev.stderr.on('data', seen);
    dev.on('exit', (code) => { clearTimeout(t); reject(new Error(`astro dev exited (${code})`)); });
  });
}
const stopDev = () => { if (dev) try { process.kill(-dev.pid); } catch {} };
const URL_ = `${SITE}/how-it-works/`;

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'],
});

async function open(width, height, { mobile = false, reduced = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/\[vite\]|astro-dev-toolbar|Failed to load resource|WebSocket connection to .*\/api\//.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 120000 });
  // The dev toolbar sits over the bottom of the page; production has none
  await page.evaluate(() => document.querySelector('astro-dev-toolbar')?.remove());
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

// Where the chapter's heading sits relative to the bottom of the sticky chrome
const seat = (page, id) => page.evaluate((id) => {
  const header = document.querySelector('.site-header').getBoundingClientRect().bottom;
  const rail = document.querySelector('.rail');
  const pill = matchMedia('(max-width: 1024px)').matches;
  const chrome = header + (pill ? rail.getBoundingClientRect().height : 0);
  const h = document.getElementById(`h-${id}`).getBoundingClientRect().top;
  const link = document.querySelector(`[data-rail="${id}"]`);
  return {
    gap: Math.round(h - chrome), hash: location.hash, y: Math.round(scrollY),
    current: link.getAttribute('aria-current'), chapterCurrent: document.getElementById(id).classList.contains('is-current'),
    pillVisible: pill ? (() => { const a = link.getBoundingClientRect(), l = rail.querySelector('.rail__list').getBoundingClientRect(); return a.left >= l.left - 1 && a.right <= l.right + 1; })() : true,
  };
}, id);

async function clickRail(page, id) {
  await page.$eval(`[data-rail="${id}"]`, (a) => a.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await page.click(`[data-rail="${id}"]`);
  await sleep(2300);
  return seat(page, id);
}

async function checkWidth(name, width, height, mobile) {
  console.log(`\n${name} (${width}×${height})`);
  const { page, errors } = await open(width, height, { mobile });
  const ids = ['apply', 'design', 'crew', 'build', 'reveal', 'scale'];

  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: nothing wider than the screen`);

  // Hero CTA glides to the first chapter
  await page.click('[data-jump="apply"]');
  await sleep(2000);
  let s = await seat(page, 'apply');
  ok(s.gap >= 0 && s.gap <= 90, `${name}: "Follow the build" seats Apply under the chrome (gap ${s.gap}px)`);
  ok(s.hash === '#apply', `${name}: the address says #apply`);

  // Rail fill grows as you read
  const fill = () => page.evaluate(() => {
    const pill = matchMedia('(max-width: 1024px)').matches;
    const el = pill ? document.querySelector('.rail') : document.querySelector('.rail__track');
    return Number(getComputedStyle(el).getPropertyValue('--fill')) || 0;
  });
  const fills = [];
  for (const id of ids) {
    s = await clickRail(page, id);
    ok(s.gap >= 0 && s.gap <= 90, `${name}: rail → ${id} seats the heading under the chrome (gap ${s.gap}px)`);
    ok(s.hash === `#${id}` && s.current === 'location' && s.chapterCurrent, `${name}: ${id} is the current chapter (hash, aria-current, numeral)`);
    ok(s.pillVisible, `${name}: the ${id} link is in view in the rail`);
    fills.push(await fill());
  }
  ok(fills.every((f, i) => i === 0 || f >= fills[i - 1]) && fills[fills.length - 1] > 0.85 && fills[0] < 0.25, `${name}: the rail fills as you read (${fills.map((f) => f.toFixed(2)).join(' → ')})`);
  if (!mobile && width > 1024) {
    const bead = await page.$eval('.rail__bead', (b) => ({ op: getComputedStyle(b).opacity, y: b.getBoundingClientRect().top }));
    const last = await page.$eval('[data-rail="scale"]', (a) => { const r = a.getBoundingClientRect(); return r.top + r.height / 2; });
    ok(bead.op === '1' && Math.abs(bead.y + 6 - last) < 4, `${name}: the bead rides to the last chapter (${Math.round(bead.y + 6)} vs ${Math.round(last)})`);
  }

  // Back goes to the previous chapter
  await page.goBack();
  await sleep(700);
  s = await seat(page, 'reveal');
  ok(s.hash === '#reveal' && Math.abs(s.gap) <= 90, `${name}: Back returns to Reveal (hash ${s.hash}, gap ${s.gap}px)`);

  // Floor plan toggle
  await page.$eval('[data-planview]', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(900);
  await page.click('[data-plan="proposed"]');
  await sleep(800);
  const pv = await page.$eval('[data-planview]', (el) => ({
    state: el.dataset.state,
    pressed: el.querySelector('[data-plan="proposed"]').getAttribute('aria-pressed'),
    other: el.querySelector('[data-plan="existing"]').getAttribute('aria-pressed'),
    opProposed: getComputedStyle(el.querySelector('.planview__img--proposed')).opacity,
    opExisting: getComputedStyle(el.querySelector('.planview__img--existing')).opacity,
    cap: [...el.querySelectorAll('[data-cap]')].find((c) => !c.hidden)?.dataset.cap,
    loaded: [...el.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0),
  }));
  ok(pv.state === 'proposed' && pv.pressed === 'true' && pv.other === 'false', `${name}: Proposed is pressed`);
  ok(pv.opProposed === '1' && pv.opExisting === '0' && pv.cap === 'proposed', `${name}: the proposed plan and its caption show`);
  ok(pv.loaded, `${name}: both plan images loaded`);
  await shot(page, `${name}-plan-proposed`);

  // Image viewer from the plan: above the header, arrows, Escape, focus back
  await page.click('.planview__zoom');
  await sleep(700);
  let lb = await page.evaluate(() => {
    const d = document.getElementById('hiw-lb');
    const top = document.elementFromPoint(innerWidth / 2, 30);
    return { open: d.open, count: d.querySelector('.lb__count').textContent, onTop: d.contains(top), lock: document.documentElement.classList.contains('hiw-lb-open'), focus: document.activeElement?.className };
  });
  ok(lb.open && lb.onTop, `${name}: the viewer opens above the site header`);
  ok(lb.count === '2 / 2', `${name}: the viewer opens on the plan in view (${lb.count})`);
  ok(lb.lock && /lb__close/.test(lb.focus), `${name}: page scroll locks and focus moves to Close`);
  await page.waitForFunction(() => { const i = document.querySelector('.lb__img'); return i.complete && i.naturalWidth > 0 && !i.classList.contains('is-loading'); }, { timeout: 15000 }).catch(() => {});
  await shot(page, `${name}-viewer-plan`);
  await page.keyboard.press('ArrowLeft');
  await sleep(300);
  ok(await page.$eval('.lb__count', (e) => e.textContent) === '1 / 2', `${name}: ArrowLeft steps back`);
  await page.keyboard.press('Escape');
  await sleep(500);
  lb = await page.evaluate(() => ({ open: document.getElementById('hiw-lb').open, lock: document.documentElement.classList.contains('hiw-lb-open'), focus: document.activeElement?.classList.contains('planview__zoom') }));
  ok(!lb.open && !lb.lock && lb.focus, `${name}: Escape closes, unlocks, and returns focus to Enlarge`);

  // Boards
  const hasBoards = await page.$('.boards__btn');
  if (hasBoards) {
    await page.$eval('[data-boards]', (el) => el.scrollIntoView({ block: 'center' }));
    await sleep(600);
    await page.click('.boards__btn[data-dir="1"]');
    await sleep(1100);
    const b = await page.$eval('[data-boards]', (el) => ({
      count: el.querySelector('.boards__count b').textContent,
      prev: el.querySelector('[data-dir="-1"]').disabled,
      next: el.querySelector('[data-dir="1"]').disabled,
      current: [...el.querySelectorAll('.board')].findIndex((x) => x.classList.contains('is-current')),
      total: el.querySelectorAll('.board').length,
    }));
    ok(b.count === '2' && b.current === 1 && !b.prev && (b.total > 2 || b.next), `${name}: the next arrow moves to board 2 (${JSON.stringify(b)})`);
    await shot(page, `${name}-boards`);
    await page.click('.board.is-current .board__paper');
    await sleep(600);
    ok(await page.$eval('.lb__count', (e) => e.textContent) === `2 / ${b.total}`, `${name}: a board opens in the viewer`);
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  // Survey photo → viewer, step with the button, close on the surround
  await page.$eval('.site', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(1200);
  await page.click('.site__shot--lead .site__open');
  await sleep(600);
  const n = await page.$$eval('.site__shot', (x) => x.length);
  ok(await page.$eval('.lb__count', (e) => e.textContent) === `1 / ${n}`, `${name}: a survey photo opens in the viewer`);
  await page.click('.lb__nav--next');
  await sleep(300);
  ok(await page.$eval('.lb__count', (e) => e.textContent) === `2 / ${n}`, `${name}: Next steps forward`);
  await page.waitForFunction(() => !document.querySelector('.lb__img').classList.contains('is-loading'), { timeout: 15000 }).catch(() => {});
  await shot(page, `${name}-viewer-photo`);
  await page.mouse.click(8, Math.round(height / 2) + (mobile ? -100 : 0));
  await sleep(500);
  ok(!(await page.$eval('#hiw-lb', (d) => d.open)), `${name}: clicking the dark surround closes the viewer`);

  // Before/after: one sweep on its own, then keyboard and pointer
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(300);
  await page.$eval('[data-ba]', (el) => el.scrollIntoView({ block: 'center' }));
  const sweep = [];
  for (let i = 0; i < 14; i++) { await sleep(160); sweep.push(await page.$eval('[data-ba]', (el) => parseFloat(el.style.getPropertyValue('--ba-pos')))); }
  await sleep(800);
  const rest = await page.$eval('[data-ba]', (el) => parseFloat(el.style.getPropertyValue('--ba-pos')));
  ok(Math.min(...sweep) < 40 && Math.max(...sweep) > 60 && Math.abs(rest - 50) < 0.5, `${name}: the handle sweeps both ways once and settles at 50 (${Math.round(Math.min(...sweep))}–${Math.round(Math.max(...sweep))}, rest ${rest})`);
  await page.focus('.ba__range');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await sleep(100);
  ok(await page.$eval('[data-ba]', (el) => el.style.getPropertyValue('--ba-pos')) === '55%', `${name}: arrow keys move the handle`);
  const box = await (await page.$('[data-ba]')).boundingBox();
  if (mobile) {
    await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height / 2);
  } else {
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
  }
  await sleep(150);
  const dragged = await page.$eval('[data-ba]', (el) => parseFloat(el.style.getPropertyValue('--ba-pos')));
  ok(Math.abs(dragged - 25) < 4, `${name}: the pointer moves the handle (${Math.round(dragged)}%)`);

  // Chart
  await page.$eval('.yrs', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(1500);
  const chart = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.yrs__col')];
    const total = Number((document.querySelector('.scale__num')?.textContent || '').replace(/\D/g, ''));
    const sum = cols.reduce((a, c) => a + Number(c.dataset.n), 0);
    const feat = cols.filter((c) => c.classList.contains('is-featured')).map((c) => c.dataset.year);
    const bars = cols.map((c) => c.querySelector('.yrs__bar').getBoundingClientRect().height);
    const tallest = cols.reduce((m, c) => (Number(c.dataset.n) > Number(m.dataset.n) ? c : m), cols[0]);
    const tb = tallest.querySelector('.yrs__bar').getBoundingClientRect();
    const plot = document.querySelector('.yrs__grid').getBoundingClientRect();
    const note = document.querySelector('.yrs__note')?.getBoundingClientRect();
    const overlaps = note ? cols.filter((c) => !c.classList.contains('is-featured')).some((c) => { const r = c.querySelector('.yrs__bar').getBoundingClientRect(); return r.left < note.right && r.right > note.left && r.top < note.bottom; }) : false;
    return { years: cols.length, sum, total, feat, minBar: Math.min(...bars), tallestH: tb.height, plotH: plot.height, year: document.querySelector('.rail__project strong')?.textContent, overlaps };
  });
  ok(chart.sum === chart.total, `${name}: the columns add up to the rooms-built figure (${chart.sum} vs ${chart.total})`);
  ok(chart.feat.length === 1 && chart.year?.includes(chart.feat[0]), `${name}: the featured project's year is highlighted (${chart.feat})`);
  ok(chart.minBar >= 2 && chart.tallestH > chart.plotH * 0.6, `${name}: columns are drawn to scale (tallest ${Math.round(chart.tallestH)} of ${Math.round(chart.plotH)}px)`);
  ok(!chart.overlaps, `${name}: the featured value label clears the other columns`);
  if (!mobile) {
    const col = await page.$('.yrs__col:nth-child(7)');
    const cb = await col.boundingBox();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height - 40);
    await sleep(300);
    const tip = await page.$eval('.yrs__tip', (t) => ({ on: t.classList.contains('is-on'), text: t.textContent }));
    const exp = await page.$eval('.yrs__col:nth-child(7)', (c) => `${c.dataset.year}: ${c.dataset.n} rooms`);
    ok(tip.on && tip.text === exp, `${name}: hovering a column shows its year and rooms ("${tip.text}")`);
    await shot(page, `${name}-chart-hover`);
    await page.mouse.move(5, 5);
  } else {
    await shot(page, `${name}-chart`);
  }

  // Video facade loads the player
  await page.$eval('#video-facade', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await page.click('#video-facade');
  await sleep(500);
  ok(await page.$eval('.video__frame', (f) => /videodelivery|youtube/.test(f.querySelector('iframe')?.src || '')), `${name}: the reveal video loads its player on click`);

  // Full-page look at rest
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(300);
  for (const id of ['apply', 'design', 'crew', 'build', 'reveal', 'scale']) {
    await page.$eval(`#${id}`, (el) => el.scrollIntoView({ block: 'start' }));
    await sleep(1300);
    await shot(page, `${name}-${id}`);
  }

  // Contrast under the pointer
  for (const f of await hoverSweep(page, hoverSeen)) ok(false, `${name}: “${f.text}” in “${f.label}” drops to ${f.hover}:1 under the pointer (${f.resting}:1 resting, ${f.colors})`);

  ok(errors.length === 0, `${name}: no console errors${errors.length ? ` (${errors.slice(0, 3).join(' | ')})` : ''}`);
  await page.close();
}

async function checkReduced() {
  console.log('\nreduced motion (1440×900)');
  const { page, errors } = await open(1440, 900, { reduced: true });
  await page.$eval('#crew', (el) => el.scrollIntoView({ block: 'start' }));
  await sleep(80);
  const vis = await page.evaluate(() => {
    const head = document.querySelector('#crew .chapter__head');
    const h2 = head.querySelector('h2');
    const logo = document.querySelector('#crew .crew__logo');
    return { h2Clip: getComputedStyle(h2).clipPath, h2Op: getComputedStyle(h2).opacity, logoOp: getComputedStyle(logo).opacity, numOp: getComputedStyle(head.querySelector('.chapter__num')).opacity };
  });
  ok(!/100%/.test(vis.h2Clip) && vis.h2Op === '1' && vis.numOp === '1' && vis.logoOp === '1', `reduced: chapter content is visible at once (${JSON.stringify(vis)})`);
  await page.evaluate(() => scrollTo(0, 0));
  await page.click('[data-rail="reveal"]').catch(async () => { await page.click('[data-jump="apply"]'); });
  await sleep(120);
  const s = await seat(page, 'reveal');
  ok(s.gap >= 0 && s.gap <= 90, `reduced: a rail jump lands at once (gap ${s.gap}px)`);
  await page.$eval('[data-ba]', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(2600);
  ok(await page.$eval('[data-ba]', (el) => el.style.getPropertyValue('--ba-pos')) === '50%', 'reduced: the before/after handle stays put');
  ok(errors.length === 0, `reduced: no console errors${errors.length ? ` (${errors.slice(0, 3).join(' | ')})` : ''}`);
  await page.close();
}

try {
  await checkWidth('desktop', 1440, 900, false);
  await checkWidth('tablet', 900, 800, false);
  await checkWidth('phone', 390, 844, true);
  await checkReduced();
} catch (e) {
  failures.push(`crashed: ${e.stack || e}`);
  console.error(e);
} finally {
  await browser.close();
  stopDev();
}

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'All checks passed'}. Screenshots: ${OUT}`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
