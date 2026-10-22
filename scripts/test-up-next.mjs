#!/usr/bin/env node
/**
 * "Coming up": the next reveals and the reveal calendar, driven in a real browser
 * ==============================================================================
 *   npx astro build --outDir <dir> && npx astro preview --outDir <dir> --port 4392
 *   SITE=http://localhost:4392 node scripts/test-up-next.mjs
 *
 * /api/broadcast and /api/reveals are mocked (a static preview serves no
 * Functions): one confirmed reveal and tentative ones that carry only
 * "early/mid/late <month>". Checks, at 1440, 820 and 390px:
 *   - /live/ between reveals: the hero names the next reveal, "See what's
 *     coming up" replaces "Watch past reveals", the section leads the page
 *     and its rows come in date order; a tentative row never shows a day
 *   - the confirmed row: day, time, Watch live, its own calendar file
 *   - the calendar panel: Apple (webcal), Google (cid), Outlook (addfromweb)
 *     and Copy link (clipboard + where to paste); the device's own app leads
 *   - the "See what's coming up" link lands below the header
 *   - /live/<kid>/: that kid's timing in the hero, the kid left out of the
 *     list, and a confirmed kid's own calendar button
 *   - while a reveal is scheduled, /live/ follows it and the list leaves it out
 *   - nothing coming up: no section, the old hero line, past reveals back
 *   - the events page section, a kid page's badge, the /kids/ cards'
 *     badges, the home page's Up Next date line, the slate's
 *     "Coming up next" card (current kid left out, joins the rotation)
 *   - reduced motion shows every row at once
 *   - no console errors, no sideways scroll, axe (WCAG 2.1 AA) on the section
 * SHOTS=<dir> saves screenshots.
 */
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const SITE = (process.env.SITE || '').replace(/\/$/, '');
if (!SITE) { console.error('Set SITE to a served build, e.g. SITE=http://localhost:4392'); process.exit(2); }
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

// ── Fixtures: real in-progress kids, one confirmed reveal, the rest tentative ──
const day = (n) => new Date(Date.now() + n * 86400e3);
const iso = (d) => d.toISOString().slice(0, 10);
const confirmedAt = day(18); confirmedAt.setUTCHours(21, 0, 0, 0);
const win = (part, d) => {
  const month = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return { part, month: iso(d).slice(0, 7), through: iso(day(60)), label: `${part} ${month}` };
};
const kid = (slug, name, rooms) => ({ slug, name, image: null, kidUrl: `/kids/${slug}/`, liveUrl: `/live/${slug}/`, rooms });
const UPCOMING = [
  { ...kid('peter', 'Peter', ['Bathroom', 'Bedroom']), confirmed: false, window: win('early', day(14)) },
  { ...kid('colin', 'Colin', ['Accessible Bathroom']), confirmed: true, startsAt: confirmedAt.toISOString(), date: iso(confirmedAt), time: '16:00' },
  { ...kid('max', 'Max', ['Bathroom']), confirmed: false, window: win('mid', day(24)) },
  { ...kid('dylan-2026', 'Dylan', ['Therapy Room']), confirmed: false, window: win('late', day(34)) },
];
const REVEALS = UPCOMING.filter((r) => r.confirmed).map(({ confirmed, rooms, ...r }) => r);
const IDLE = {
  phase: 'idle', live: false, upcoming: false, replay: false, id: null, kidSlug: null, kidName: null, title: null, message: null, image: null,
  scheduledAt: null, liveAt: null, endedAt: null, replayUntil: null, url: `${SITE}/live/`, liveUrl: `${SITE}/live/`, player: null,
  facebookUrl: 'https://www.facebook.com/SunshineOnaRanneyDay', orientation: 'portrait', source: 'test', updatedAt: new Date().toISOString(),
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(SITE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

async function open(path, { width = 1440, height = 900, upcoming = UPCOMING, ua = null, reduced = false, state = IDLE } = {}) {
  const page = await browser.newPage();
  const phone = width < 600;
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  if (ua) await page.setUserAgent(ua);
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A static preview has no live socket or images: those misses aren't the page's
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') return req.abort();
    if (url.pathname === '/api/reveals') return json({ reveals: upcoming.length ? REVEALS : [], upcoming, updatedAt: new Date().toISOString(), source: 'test' });
    if (url.pathname === '/api/broadcast') return json({ state, reminders: { enabled: true, email: true, push: false }, messages: { enabled: true }, timezone: 'America/New_York', hub: false });
    if (url.pathname === '/api/live-ws' || url.pathname === '/api/live-messages') return req.abort();
    if (url.pathname === '/api/broadcast-event') return req.respond({ status: 204, body: '' });
    if (url.pathname.startsWith('/api/')) return json({ ok: true });
    if (url.hostname !== new URL(SITE).hostname && !url.hostname.endsWith('sunshineonaranneyday.com')) return req.abort();
    return req.continue();
  });
  await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(600);
  return { page, errors };
}

const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function axeScan(page, scope, label) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, scope);
  ok(res.length === 0, `axe: ${label}`, res.join('\n      '));
}

// ── /live/ between reveals ──
for (const width of [1440, 820, 390]) {
  console.log(`\n── /live/ at ${width}px ──`);
  const { page, errors } = await open('/live/', { width, height: width < 600 ? 844 : 900 });
  const hero = await page.evaluate(() => ({
    status: document.querySelector('[data-live="status"]')?.textContent,
    next: !document.querySelector('[data-live="cta-next"]')?.hidden,
    past: !document.querySelector('[data-live="cta-past"]')?.hidden,
  }));
  ok(hero.status === "Next up: Peter's reveal, early " + UPCOMING[0].window.label.split(' ')[1] + '.', 'hero names the next reveal and its window', hero.status);
  ok(hero.next && !hero.past, '"See what\'s coming up" replaces "Watch past reveals"');

  const sec = await page.evaluate(() => {
    const s = document.querySelector('#up-next');
    const past = document.querySelector('#past-reveals');
    const rows = [...s.querySelectorAll('.upn-row')];
    return {
      hidden: s.hidden,
      leadsPast: past ? s.getBoundingClientRect().top < past.getBoundingClientRect().top : true,
      names: rows.map((r) => r.querySelector('.upn-card__name')?.textContent),
      states: rows.map((r) => r.dataset.state),
      tentativeWhen: rows.filter((r) => r.dataset.state === 'tentative').map((r) => r.querySelector('.upn-when')?.textContent),
      bars: rows.filter((r) => r.dataset.state === 'tentative').map((r) => [...r.querySelectorAll('.upn-month span')].findIndex((x) => x.classList.contains('is-on'))),
      confirmed: (() => {
        const r = rows.find((x) => x.dataset.state === 'confirmed');
        return r && { when: r.querySelector('.upn-when')?.textContent, watch: r.querySelector('.upn-act:not(.upn-act--quiet)')?.getAttribute('href'), cal: r.querySelector('.upn-act--quiet')?.getAttribute('href') };
      })(),
      cardLink: rows[0]?.querySelector('.upn-card__name a')?.getAttribute('href'),
    };
  });
  ok(!sec.hidden, 'section shows');
  ok(sec.leadsPast, 'it comes before past reveals');
  ok(JSON.stringify(sec.names) === JSON.stringify(['Peter', 'Colin', 'Max', 'Dylan']), 'rows in date order', JSON.stringify(sec.names));
  ok(sec.tentativeWhen.every((t) => !/\d/.test(t)), 'a tentative row never shows a day', JSON.stringify(sec.tentativeWhen));
  ok(JSON.stringify(sec.bars) === '[0,1,2]', 'month bar marks early, mid, late', JSON.stringify(sec.bars));
  ok(/\d/.test(sec.confirmed?.when || '') && /PM ET/.test(sec.confirmed?.when || ''), 'confirmed row shows its day and time', sec.confirmed?.when);
  ok(sec.confirmed?.watch === '/live/colin/' && sec.confirmed?.cal === '/api/reveals.ics?reveal=colin', 'Watch live and its own calendar file', JSON.stringify(sec.confirmed));
  ok(sec.cardLink === '/kids/peter/', 'a card opens the kid\'s story');

  const links = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#up-next [data-how]')].map((a) => [a.dataset.how, a.getAttribute('href') || a.dataset.link])));
  ok(links.apple === 'webcal://sunshineonaranneyday.com/api/reveals.ics', 'Apple subscribes over webcal', links.apple);
  ok(links.google === `https://calendar.google.com/calendar/render?cid=${encodeURIComponent('webcal://sunshineonaranneyday.com/api/reveals.ics')}`, 'Google adds by URL', links.google);
  ok(links.outlook?.startsWith('https://outlook.live.com/calendar/0/addfromweb?url=https%3A%2F%2Fsunshineonaranneyday.com%2Fapi%2Freveals.ics'), 'Outlook adds from web', links.outlook);
  ok(links.copy === 'https://sunshineonaranneyday.com/api/reveals.ics', 'Copy link is the https address');

  // Motion settles: rows visible once the section is in view
  await page.evaluate(() => document.querySelector('#up-next').scrollIntoView());
  await wait(1800);
  const shown = await page.evaluate(() => [...document.querySelectorAll('.upn-row')].every((r) => getComputedStyle(r).opacity === '1'));
  ok(shown, 'rows are in after scrolling to them');
  ok(await sideways(page) <= 0, 'no sideways scroll');
  await shot(page, `live-${width}`);
  await axeScan(page, '#up-next', `up-next at ${width}px`);
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();
}

// ── The hero link lands below the header ──
{
  console.log('\n── "See what\'s coming up" ──');
  const { page } = await open('/live/');
  await page.click('[data-live="cta-next"]');
  await wait(2200);
  const pos = await page.evaluate(() => {
    const h = document.querySelector('header')?.getBoundingClientRect().bottom || 0;
    return { top: document.querySelector('#up-next').getBoundingClientRect().top, header: h };
  });
  ok(Math.abs(pos.top - pos.header) <= 4, 'the section top sits flush under the header', JSON.stringify(pos));
  await page.close();
}

// ── Copy link and the device's own calendar ──
{
  console.log('\n── calendar panel ──');
  const { page } = await open('/live/');
  await page.evaluate(() => document.querySelector('#up-next').scrollIntoView());
  await page.click('#up-next [data-how="copy"]');
  await wait(300);
  const copied = await page.evaluate(async () => ({ clip: await navigator.clipboard.readText(), label: document.querySelector('#up-next [data-copy-label]')?.textContent, note: document.querySelector('#up-next [data-upn-note]')?.textContent }));
  ok(copied.clip === 'https://sunshineonaranneyday.com/api/reveals.ics', 'Copy link puts the address on the clipboard', copied.clip);
  ok(copied.label === 'Link copied' && /Subscribe/.test(copied.note || ''), 'and says where to paste it', `${copied.label} / ${copied.note}`);
  await page.close();

  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  for (const [ua, want] of [[iphone, 'apple'], [android, 'google']]) {
    const { page: p } = await open('/live/', { width: 390, height: 844, ua });
    const first = await p.evaluate(() => { const o = document.querySelector('#up-next [data-how]'); return { how: o?.dataset.how, pick: o?.classList.contains('is-pick') }; });
    ok(first.how === want && first.pick, `${want === 'apple' ? 'iPhone' : 'Android'}: ${want} leads, in yellow`, JSON.stringify(first));
    await p.close();
  }
}

// ── A kid's own live page ──
{
  console.log('\n── /live/<kid>/ ──');
  const { page, errors } = await open('/live/max/');
  const r = await page.evaluate(() => ({
    status: document.querySelector('[data-live="status"]')?.textContent,
    names: [...document.querySelectorAll('.upn-card__name')].map((n) => n.textContent),
    cal: !document.querySelector('[data-live="cta-calendar"]')?.hidden,
  }));
  ok(/^Max's reveal is planned for mid /.test(r.status || '') && !/\d/.test(r.status), "a tentative kid's window, no day", r.status);
  ok(!r.names.includes('Max') && r.names.length === 3, 'the kid is left out of the list', JSON.stringify(r.names));
  ok(!r.cal, 'no calendar button without a day');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();

  const { page: c } = await open('/live/colin/');
  const rc = await c.evaluate(() => ({ status: document.querySelector('[data-live="status"]')?.textContent, cal: document.querySelector('[data-live="cta-calendar"]') }));
  const cal = await c.evaluate(() => { const a = document.querySelector('[data-live="cta-calendar"]'); return { shown: !a.hidden, href: a.getAttribute('href') }; });
  ok(/^Colin's reveal is \w+day, \w+ \d+ at \d/.test(rc.status || ''), "a confirmed kid's day and time", rc.status);
  ok(cal.shown && cal.href === '/api/reveals.ics?reveal=colin', "the hero's calendar button is that reveal's file", JSON.stringify(cal));
  await c.close();
}

// ── A reveal scheduled: /live/ follows it, the list leaves it out ──
{
  console.log('\n── /live/ with a reveal scheduled ──');
  const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
  const { page, errors } = await open('/live/', { state: scheduled });
  const r = await page.evaluate(() => ({
    status: document.querySelector('[data-live="status"]')?.textContent,
    names: [...document.querySelectorAll('#up-next .upn-card__name')].map((n) => n.textContent),
  }));
  ok(/^We go live/.test(r.status || ''), 'the hero counts down to the scheduled reveal', r.status);
  ok(JSON.stringify(r.names) === JSON.stringify(['Peter', 'Max', 'Dylan']), 'the list leaves that reveal out', JSON.stringify(r.names));
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();
}

// ── Nothing coming up ──
{
  console.log('\n── nothing coming up ──');
  const { page, errors } = await open('/live/', { upcoming: [] });
  const r = await page.evaluate(() => ({
    hidden: document.querySelector('#up-next')?.hidden,
    status: document.querySelector('[data-live="status"]')?.textContent,
    next: !document.querySelector('[data-live="cta-next"]')?.hidden,
    past: !document.querySelector('[data-live="cta-past"]')?.hidden,
  }));
  ok(r.hidden, 'no section, no placeholder');
  ok(/^No reveal is scheduled right now/.test(r.status || ''), 'the hero says nothing is scheduled', r.status);
  ok(!r.next && (r.past || !(await page.$('#past-reveals'))), '"Watch past reveals" is back');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();
}

// ── Reduced motion ──
{
  console.log('\n── reduced motion ──');
  const { page } = await open('/live/', { reduced: true });
  const r = await page.evaluate(() => [...document.querySelectorAll('.upn-row')].map((x) => getComputedStyle(x).opacity));
  ok(r.length === 4 && r.every((o) => o === '1'), 'every row shows at once', JSON.stringify(r));
  await page.close();
}

// ── Events page, kid page, slate ──
{
  console.log('\n── events, kid page, slate ──');
  const { page, errors } = await open('/events/');
  const ev = await page.evaluate(() => { const s = document.querySelector('#reveals'); return { hidden: s?.hidden, rows: s?.querySelectorAll('.upn-row').length, title: s?.querySelector('h2')?.textContent }; });
  ok(ev.hidden === false && ev.rows === 4, 'events page lists the reveals', JSON.stringify(ev));
  ok(ev.title === 'Watch a room reveal live', 'with its own heading', ev.title);
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await shot(page, 'events');
  await page.close();

  const { page: k } = await open('/kids/max/');
  const badge = await k.evaluate(() => ({ badge: document.querySelector('[data-kid-reveal-badge]')?.textContent, link: document.querySelector('.hero__reveal-day')?.textContent }));
  ok(/^Reveal mid [A-Z][a-z]{2}$/.test(badge.badge || ''), 'kid badge: "Reveal mid <Mon>"', badge.badge);
  ok(/^Reveal planned for mid \w+/.test(badge.link || '') && !/\d{1,2}\b(?! *\d{4})/.test(badge.link.replace(/\d{4}/, '')), 'kid link: the window, no day', badge.link);
  await k.close();

  const { page: list, errors: le } = await open('/kids/');
  await wait(400);
  const cards = await list.evaluate(() => Object.fromEntries([...document.querySelectorAll('a.kid-card')]
    .filter((a) => a.querySelector('.kid-card__badge--building'))
    .map((a) => [a.getAttribute('href'), a.querySelector('.kid-card__badge--building').textContent.trim()])));
  ok(/^Reveal early [A-Z][a-z]{2}$/.test(cards['/kids/peter/'] || ''), '/kids/ card: "Reveal early <Mon>"', cards['/kids/peter/']);
  ok(/^Reveal [A-Z][a-z]{2} \d{1,2}$/.test(cards['/kids/colin/'] || ''), '/kids/ card: a confirmed day', cards['/kids/colin/']);
  ok(Object.entries(cards).filter(([h]) => !['/kids/peter/', '/kids/colin/', '/kids/max/', '/kids/dylan-2026/'].includes(h)).every(([, t]) => t === 'Building'), '/kids/ cards with no reveal date still say Building', JSON.stringify(cards));
  ok(le.length === 0, '/kids/: no console errors', le.join(' | '));
  await list.close();

  const { page: home, errors: he } = await open('/');
  const line = await home.evaluate(() => { const el = document.querySelector('.upnext-date'); return { text: el?.textContent, kid: el?.dataset.revealKid, headline: document.querySelector('.upnext-headline')?.textContent }; });
  if (line.kid === 'colin') ok(/^Reveal \w+day, \w+ \d{1,2}$/.test(line.text || ''), "home Up Next: Colin's confirmed day, live", JSON.stringify(line));
  else if (line.kid) ok(/^Reveal (early|mid|late) \w+$|^Reveal \w+day, \w+ \d{1,2}$|^Reveal coming soon$/.test(line.text || ''), 'home Up Next: dated from JobTread', JSON.stringify(line));
  else ok(true, `home Up Next: staff wrote their own date line (${line.text})`);
  ok(he.length === 0, 'home: no console errors', he.join(' | '));
  await home.close();

  const { page: s, errors: se } = await open('/live/colin/slate/?music=0&still=1', { width: 960, height: 540 });
  const slate = await s.evaluate(() => {
    const c = document.querySelector('[data-card="next"]');
    return { shown: c && !c.hidden, items: [...document.querySelectorAll('[data-next-list] li')].map((l) => l.querySelector('b').textContent + ' | ' + l.querySelector('span').textContent) };
  });
  ok(slate.shown, 'slate: "Coming up next" card joins');
  ok(slate.items.length === 3 && !slate.items.some((i) => i.startsWith('Colin')), 'slate: the next three, this kid left out', JSON.stringify(slate.items));
  ok(slate.items.every((i) => !/\d/.test(i.split('|')[1]) || i.startsWith('Colin')), 'slate: tentative ones show only their window', JSON.stringify(slate.items));
  ok(se.length === 0, 'slate: no console errors', se.join(' | '));
  await s.close();
}

await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
