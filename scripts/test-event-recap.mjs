/**
 * test-event-recap.mjs — drive an event's recap (its page once it's over) in a real browser
 * ==========================================================================================
 * On /events/gala/ and /events/golf/ (the newest gala and tournament, both over)
 * at 1440px and on a 390px phone:
 *   - no console errors, nothing wider than the screen
 *   - the hero thanks people and shows the cover photo and the photo count;
 *     the photos come first, then the sponsors, in that order on the page
 *   - the first tiles show and "Show all" brings the rest
 *   - a tile opens the viewer above the site header; arrows, keys and (phone)
 *     swipe step through; the counter, the link (#photo-N) and Save follow;
 *     Escape closes it, the link is clean again and focus goes back to the tile
 *   - a link to one photo (#photo-40) opens straight to it
 *   - every sponsor logo loaded and sits inside its card
 *   - old addresses forward: /events/2026-evening-of-sunshine/ → /events/gala/2026/
 *   - the year page has the same recap and a breadcrumb to its year
 * Screenshots land in test-results/event-recap/. Exits non-zero on failure.
 *
 *   SITE=http://localhost:4391 node scripts/test-event-recap.mjs
 * Test a build (npx astro build --outDir <dir>, then serve <dir> statically):
 * astro dev reloads mid-run while other sessions write src/content.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/event-recap/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://localhost:4391').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'],
});

async function open(path, { width = 1440, height = 900, mobile = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // A static server has no /api (the live indicator's socket and status checks)
    if (m.type() === 'error' && !/\/api\/|WebSocket|live-|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
  return { page, errors };
}

const viewer = (page) => page.evaluate(() => {
  const d = document.querySelector('[data-rv]');
  const img = d?.querySelector('[data-rv-img]');
  const save = d?.querySelector('[data-rv-save]');
  return {
    open: !!d?.open,
    pos: d?.querySelector('[data-rv-pos]')?.textContent,
    hash: location.hash,
    img: img?.getAttribute('src') || '',
    save: save?.getAttribute('href') || '',
    file: save?.getAttribute('download') || '',
    active: document.activeElement?.id || document.activeElement?.className || '',
  };
});

async function checkRecap(path, { name, photos, minSponsors }) {
  console.log(`\n${path} (desktop)`);
  const { page, errors } = await open(path);
  const facts = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel)?.getBoundingClientRect().top + window.scrollY;
    return {
      h1: document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim(),
      tiles: document.querySelectorAll('[data-rp-open]').length,
      shown: [...document.querySelectorAll('.rp-item')].filter((li) => !li.hidden).length,
      stat: document.querySelector('.rh-stat__num')?.textContent,
      photosTop: top('#photos'),
      sponsorsTop: top('#sponsors'),
      cards: document.querySelectorAll('.rs-card').length,
      wide: document.documentElement.scrollWidth - window.innerWidth,
      tickets: !!document.querySelector('#tickets, .gv-countdown, .ev-countdown'),
    };
  });
  ok(facts.h1?.includes(name), `the title is ${name} (${facts.h1})`);
  ok(!facts.tickets, 'no tickets or countdown once it’s over');
  ok(facts.tiles === photos, `${photos} photos in the gallery (${facts.tiles})`);
  ok(facts.stat === String(photos), `the hero counts ${photos} photos (${facts.stat})`);
  ok(facts.shown > 0 && facts.shown < facts.tiles, `the first ${facts.shown} show before “Show all”`);
  ok(facts.photosTop < facts.sponsorsTop, 'photos come before the sponsors');
  ok(facts.cards >= minSponsors, `${facts.cards} sponsor cards (at least ${minSponsors})`);
  ok(facts.wide <= 0, `nothing wider than the screen (${facts.wide}px over)`);

  // Logos: loaded, and inside their card
  await page.evaluate(async () => {
    const el = document.querySelector('#sponsors');
    el.scrollIntoView();
    for (let y = el.offsetTop; y < el.offsetTop + el.offsetHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
  });
  await sleep(1500);
  const logos = await page.evaluate(() => [...document.querySelectorAll('.rs-logo')].map((img) => {
    const c = img.closest('.rs-card').getBoundingClientRect();
    const r = img.getBoundingClientRect();
    return { alt: img.alt, loaded: img.complete && img.naturalWidth > 0, inside: r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1 };
  }));
  const broken = logos.filter((l) => !l.loaded).map((l) => l.alt);
  const spill = logos.filter((l) => !l.inside).map((l) => l.alt);
  ok(!broken.length, `every sponsor logo loaded${broken.length ? ` (not: ${broken.join(', ')})` : ''}`);
  ok(!spill.length, `every logo sits inside its card${spill.length ? ` (spills: ${spill.join(', ')})` : ''}`);

  // The viewer
  await page.evaluate(() => window.scrollTo(0, document.querySelector('#photos').offsetTop));
  await sleep(300);
  await page.click('[data-rp-open="0"]');
  await sleep(500);
  let v = await viewer(page);
  ok(v.open && v.pos === '1', `a tile opens the viewer at photo 1 (${v.pos})`);
  ok(v.hash === '#photo-1', `the link points at the photo (${v.hash})`);
  const onTop = await page.evaluate(() => {
    const b = document.querySelector('[data-rv-close]').getBoundingClientRect();
    return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-rv-close]') != null;
  });
  ok(onTop, 'the viewer sits above the site header (its close button takes the click)');
  const fits = await page.evaluate(() => {
    const img = document.querySelector('[data-rv-img]').getBoundingClientRect();
    const foot = document.querySelector('.rv-foot').getBoundingClientRect();
    return img.bottom <= foot.top + 1 && foot.bottom <= window.innerHeight + 1;
  });
  ok(fits, 'the photo fits on screen above the caption bar');
  await page.keyboard.press('ArrowRight');
  await sleep(450);
  v = await viewer(page);
  ok(v.pos === '2' && v.hash === '#photo-2', `→ steps to photo 2 (${v.pos}, ${v.hash})`);
  ok(/format=jpeg/.test(v.save) && /-02\.jpg$/.test(v.file), `Save gives a full-size JPEG named ${v.file}`);
  await sleep(1200);
  v = await viewer(page);
  ok(/w=\d+,fit=scale-down/.test(v.img), 'the sharp photo replaces the tile picture');
  await page.click('.rv-nav--next');
  await sleep(450);
  ok((await viewer(page)).pos === '3', 'the next arrow steps on');
  await page.keyboard.press('End');
  await sleep(200);
  v = await viewer(page);
  ok(v.pos === String(photos), `End jumps to the last photo (${v.pos})`);
  ok(await page.$eval('.rv-nav--next', (b) => b.disabled), 'next is off on the last photo');
  await page.keyboard.press('Home');
  await sleep(200);
  await page.keyboard.press('Escape');
  await sleep(400);
  v = await viewer(page);
  ok(!v.open && v.hash === '', `Escape closes it and the link is clean (${v.hash || 'no hash'})`);
  ok(v.active === 'photo-1', `focus returns to the photo (${v.active})`);
  await page.screenshot({ path: join(OUT, `${name.split(' ')[0].toLowerCase()}-desktop.png`) });

  // Show all
  await page.click('[data-rp-more]');
  await sleep(300);
  const after = await page.evaluate(() => ({ shown: [...document.querySelectorAll('.rp-item')].filter((li) => !li.hidden).length, btn: !!document.querySelector('[data-rp-more]') }));
  ok(after.shown === photos && !after.btn, `“Show all” shows all ${photos} (${after.shown})`);
  ok(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();

  // A link to one photo
  const deep = await open(`${path}#photo-40`);
  await sleep(800);
  v = await viewer(deep.page);
  ok(v.open && v.pos === '40', `${path}#photo-40 opens photo 40 (${v.pos})`);
  await deep.page.close();

  // Phone
  console.log(`${path} (phone)`);
  const m = await open(path, { width: 390, height: 844, mobile: true });
  const wide = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(wide <= 0, `nothing wider than the phone (${wide}px over)`);
  await m.page.evaluate(() => document.querySelector('[data-rp-open="0"]').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await m.page.tap('[data-rp-open="0"]');
  await sleep(500);
  const arrows = await m.page.evaluate(() => ({
    nav: getComputedStyle(document.querySelector('.rv-nav--next')).display,
    step: getComputedStyle(document.querySelector('.rv-step[data-rv-next]')).display,
  }));
  ok(arrows.nav === 'none' && arrows.step !== 'none', 'on a phone the arrows sit under the photo, not over it');
  const box = await m.page.$eval('[data-rv-stage]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await m.page.touchscreen.touchStart(box.x + 120, box.y);
  for (let i = 1; i <= 6; i++) await m.page.touchscreen.touchMove(box.x + 120 - i * 40, box.y);
  await m.page.touchscreen.touchEnd();
  await sleep(500);
  v = await viewer(m.page);
  ok(v.pos === '2', `swiping left shows photo 2 (${v.pos})`);
  await m.page.screenshot({ path: join(OUT, `${name.split(' ')[0].toLowerCase()}-phone-viewer.png`) });
  await m.page.touchscreen.touchStart(box.x, box.y - 100);
  for (let i = 1; i <= 6; i++) await m.page.touchscreen.touchMove(box.x, box.y - 100 + i * 35);
  await m.page.touchscreen.touchEnd();
  await sleep(500);
  ok(!(await viewer(m.page)).open, 'swiping down closes it');
  ok(!m.errors.length, `no console errors on the phone${m.errors.length ? `: ${m.errors.join(' | ')}` : ''}`);
  await m.page.close();
}

try {
  await checkRecap('/events/gala/', { name: 'Evening of Sunshine', photos: Number(process.env.GALA_PHOTOS || 86), minSponsors: 10 });
  await checkRecap('/events/golf/', { name: 'Sunshine on a Ranney Fairway', photos: Number(process.env.GOLF_PHOTOS || 73), minSponsors: 30 });

  console.log('\nAddresses');
  for (const [from, to] of [['/events/2026-evening-of-sunshine/', '/events/gala/2026/'], ['/events/sunshine-on-a-ranney-fairway/', '/events/golf/2026/']]) {
    const { page } = await open(from);
    await sleep(800);
    ok(new URL(page.url()).pathname === to, `${from} forwards to ${to} (${new URL(page.url()).pathname})`);
    await page.close();
  }
  const { page } = await open('/events/gala/2026/');
  const crumbs = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(' '));
  ok(/"name":"2026"/.test(crumbs.replace(/\s/g, '')), 'the year page’s breadcrumb ends at its year');
  ok(await page.$('#photos .rp-tile') != null && await page.$('#sponsors') != null, 'the year page has the photos and the sponsors');
  await page.close();
} catch (err) {
  failures.push(err.message);
  console.error(err);
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
