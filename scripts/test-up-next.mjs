#!/usr/bin/env node
/**
 * "Coming up": the next reveals and the reveal calendar, driven in a real browser
 * ==============================================================================
 *   npx astro build --outDir <dir> && npx astro preview --outDir <dir> --port 4392
 *   SITE=http://localhost:4392 node scripts/test-up-next.mjs
 *
 * /api/broadcast and /api/reveals are mocked (a static preview serves no
 * Functions): one confirmed reveal and tentative ones that carry only
 * "early/mid/late <month>", different from the build's copy so the live
 * refresh is tested too. Checks, at 1440, 820 and 390px:
 *   - /live/ between reveals: the hero frame lists what's coming up (no
 *     photo, no second section), in date order, a tentative row never with
 *     a day, every child with their own invite button
 *   - the invite sheet: that child's Apple (webcal ?kid=), Google (cid),
 *     Outlook (addfromweb) and Copy link; on screen above the header;
 *     Escape and the backdrop close it; the device's own app leads; a
 *     bottom sheet on phones; "Add every reveal" offers the one calendar
 *   - /live/<kid>/: that kid's timing and invite in the hero, the other
 *     reveals after the page body
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

// ── /live/ between reveals: what's coming up is in the hero ──
const KID_FEED = (slug) => `https://sunshineonaranneyday.com/api/reveals.ics?kid=${slug}`;
for (const width of [1440, 820, 390]) {
  console.log(`\n── /live/ at ${width}px ──`);
  const { page, errors } = await open('/live/', { width, height: width < 600 ? 844 : 900 });
  const r = await page.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const rows = [...document.querySelectorAll('.hnx-row')];
    return {
      next: document.querySelector('.live-page')?.hasAttribute('data-next'),
      card: vis(document.querySelector('[data-hero-next]')),
      stage: vis(document.querySelector('.hero-frame [data-stage]')),
      band: vis(document.querySelector('#up-next')),
      cardInHero: !!document.querySelector('#live-hero [data-hero-next]'),
      status: document.querySelector('[data-live="status"]')?.textContent,
      past: !document.querySelector('[data-live="cta-past"]')?.hidden,
      names: rows.map((x) => x.querySelector('.hnx-name')?.textContent),
      tentativeWhen: rows.filter((x) => x.dataset.state === 'tentative').map((x) => x.querySelector('.hnx-when')?.innerText),
      confirmedWhen: rows.filter((x) => x.dataset.state === 'confirmed').map((x) => x.querySelector('.hnx-when')?.innerText),
      invites: rows.map((x) => x.querySelector('.hnx-add')?.dataset.invite),
      bars: rows.filter((x) => x.dataset.state === 'tentative').map((x) => [...x.querySelectorAll('.hnx-month i')].findIndex((i) => i.classList.contains('is-on'))),
    };
  });
  ok(r.next && r.card && r.cardInHero && !r.stage, 'the hero frame shows what\'s coming up, not a photo');
  ok(!r.band, 'no second "Coming up" section on the page');
  ok(/^Next up: Peter's reveal, early \w+\.$/.test(r.status || ''), 'the hero line names the next reveal', r.status);
  ok(r.past, '"Watch past reveals" is in the hero');
  ok(JSON.stringify(r.names) === JSON.stringify(['Peter', 'Colin', 'Max', 'Dylan']), 'rows follow the live list, in date order', JSON.stringify(r.names));
  ok(r.tentativeWhen.every((t) => !/\d/.test(t)), 'a tentative row never shows a day', JSON.stringify(r.tentativeWhen));
  ok(r.confirmedWhen.every((t) => /\d/.test(t) && /PM ET/.test(t)), 'the confirmed row shows its day and time', JSON.stringify(r.confirmedWhen));
  ok(JSON.stringify(r.bars) === '[0,1,2]', 'month bars mark early, mid, late', JSON.stringify(r.bars));
  ok(JSON.stringify(r.invites) === JSON.stringify(['peter', 'colin', 'max', 'dylan-2026']), 'every child has their own invite button');
  await wait(1200);
  ok(await page.evaluate(() => [...document.querySelectorAll('.hnx-row')].every((x) => getComputedStyle(x).opacity === '1')), 'rows are in');
  ok(await sideways(page) <= 0, 'no sideways scroll');
  await page.evaluate(() => document.querySelector('[data-hero-next]').scrollIntoView({ block: 'center' }));
  await wait(300);
  await shot(page, `live-${width}`);
  await axeScan(page, '[data-hero-next]', `hero list at ${width}px`);

  // A tentative child's invite
  await page.click('.hnx-row[data-slug="max"] .hnx-add');
  await wait(700);
  const d = await page.evaluate(() => {
    const dlg = document.querySelector('dialog[data-reveal-invite]');
    const href = (h) => dlg.querySelector(`[data-how="${h}"]`)?.getAttribute('href');
    const box = dlg.getBoundingClientRect();
    return { open: dlg.open, title: dlg.querySelector('[data-rinv="title"]')?.textContent, text: dlg.querySelector('[data-rinv="text"]')?.textContent, apple: href('apple'), google: href('google'), outlook: href('outlook'), copy: dlg.querySelector('[data-how="copy"]')?.dataset.link, onScreen: box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1, top: document.elementFromPoint(box.left + box.width / 2, box.top + 40)?.closest('dialog') === dlg };
  });
  ok(d.open && d.title === 'Max’s room reveal', "Add opens that child's invite", JSON.stringify(d.title));
  ok(/^Planned for mid \w+\. It goes in your calendar now/.test(d.text || '') && !/\d/.test(d.text), 'it explains the day fills in later, and shows no day', d.text);
  ok(d.apple === KID_FEED('max').replace('https:', 'webcal:'), 'Apple subscribes to that child', d.apple);
  ok(d.google === `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(KID_FEED('max').replace('https:', 'webcal:'))}`, 'Google adds that child', d.google);
  ok(d.outlook?.includes(encodeURIComponent(KID_FEED('max'))) && d.outlook.includes(encodeURIComponent('Max’s room reveal')), 'Outlook adds that child', d.outlook);
  ok(d.copy === KID_FEED('max'), 'Copy link is that child\'s https address');
  ok(d.onScreen && d.top, 'the sheet is fully on screen, above everything (header included)');
  await shot(page, `invite-${width}`);
  await axeScan(page, 'dialog[data-reveal-invite]', `invite sheet at ${width}px`);
  await page.keyboard.press('Escape');
  await wait(300);
  ok(!(await page.evaluate(() => document.querySelector('dialog[data-reveal-invite]').open)), 'Escape closes it');

  // Every reveal at once
  await page.click('[data-hero-next] .hnx__all');
  await wait(500);
  const all = await page.evaluate(() => { const dlg = document.querySelector('dialog[data-reveal-invite]'); return { title: dlg.querySelector('[data-rinv="title"]')?.textContent, copy: dlg.querySelector('[data-how="copy"]')?.dataset.link }; });
  ok(all.title === 'Every room reveal' && all.copy === 'https://sunshineonaranneyday.com/api/reveals.ics', '"Add every reveal" offers the one calendar', JSON.stringify(all));
  // A tap on the dimmed backdrop closes it
  await page.mouse.click(5, 5);
  await wait(300);
  ok(!(await page.evaluate(() => document.querySelector('dialog[data-reveal-invite]').open)), 'tapping outside closes it');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();
}

// ── The invite sheet: Copy link, and the device's own calendar first ──
{
  console.log('\n── invite sheet ──');
  const { page } = await open('/live/');
  await page.click('.hnx-row[data-slug="colin"] .hnx-add');
  await wait(500);
  const confirmedText = await page.evaluate(() => document.querySelector('[data-rinv="text"]')?.textContent);
  ok(/^\w+day, \w+ \d{1,2} at \d{1,2}:\d{2} PM ET\. It goes in your calendar with the link to watch live/.test(confirmedText || ''), "a confirmed child's invite says the day and time", confirmedText);
  await page.click('dialog[data-reveal-invite] [data-how="copy"]');
  await wait(300);
  const copied = await page.evaluate(async () => ({ clip: await navigator.clipboard.readText(), label: document.querySelector('[data-rinv="copy-label"]')?.textContent, note: document.querySelector('[data-rinv="note"]')?.textContent }));
  ok(copied.clip === KID_FEED('colin'), 'Copy link puts that child\'s address on the clipboard', copied.clip);
  ok(copied.label === 'Link copied' && /Subscribe/.test(copied.note || ''), 'and says where to paste it', `${copied.label} / ${copied.note}`);
  await page.close();

  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  for (const [ua, want] of [[iphone, 'apple'], [android, 'google']]) {
    const { page: p } = await open('/live/', { width: 390, height: 844, ua });
    await p.click('.hnx-row[data-slug="peter"] .hnx-add');
    await wait(500);
    const first = await p.evaluate(() => { const o = document.querySelector('dialog[data-reveal-invite] [data-how]'); return { how: o?.dataset.how, pick: o?.classList.contains('is-pick'), focused: document.activeElement === o }; });
    ok(first.how === want && first.pick && first.focused, `${want === 'apple' ? 'iPhone' : 'Android'}: ${want} leads, in yellow, focused`, JSON.stringify(first));
    const sheet = await p.evaluate(() => { const b = document.querySelector('dialog[data-reveal-invite]').getBoundingClientRect(); return { bottom: Math.round(innerHeight - b.bottom), width: Math.round(b.width) }; });
    ok(sheet.bottom <= 1 && sheet.width === 390, 'on a phone it is a sheet along the bottom', JSON.stringify(sheet));
    await p.close();
  }
}

// ── A kid's own live page: their timing and their invite in the hero ──
{
  console.log('\n── /live/<kid>/ ──');
  const { page, errors } = await open('/live/max/');
  const r = await page.evaluate(() => {
    const cal = document.querySelector('[data-live="cta-calendar"]');
    const band = document.querySelector('#up-next');
    return {
      status: document.querySelector('[data-live="status"]')?.textContent,
      names: [...document.querySelectorAll('#up-next .upn-card__name')].map((n) => n.textContent),
      cal: { shown: !cal.hidden, invite: cal.dataset.invite, set: cal.dataset.inviteSet },
      bandAfterBody: band.getBoundingClientRect().top > document.querySelector('.live-body').getBoundingClientRect().top,
      noHeroList: !document.querySelector('#live-hero [data-hero-next]'),
    };
  });
  ok(/^Max's reveal is planned for mid /.test(r.status || '') && !/\d/.test(r.status), "a tentative kid's window, no day", r.status);
  ok(r.cal.shown && r.cal.invite === 'max' && r.cal.set === '0', "the hero's Add to calendar is that child's invite", JSON.stringify(r.cal));
  ok(r.noHeroList, 'the frame stays the kid\'s photo');
  ok(!r.names.includes('Max') && r.names.length === 3 && r.bandAfterBody, 'the other reveals close the page, without the kid', JSON.stringify(r));
  await page.click('[data-live="cta-calendar"]');
  await wait(500);
  ok(await page.evaluate(() => document.querySelector('[data-rinv="title"]')?.textContent === 'Max’s room reveal'), 'it opens Max\'s invite');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();

  const { page: c } = await open('/live/colin/');
  const rc = await c.evaluate(() => { const a = document.querySelector('[data-live="cta-calendar"]'); return { status: document.querySelector('[data-live="status"]')?.textContent, shown: !a.hidden, invite: a.dataset.invite, set: a.dataset.inviteSet }; });
  ok(/^Colin's reveal is \w+day, \w+ \d+ at \d/.test(rc.status || ''), "a confirmed kid's day and time", rc.status);
  ok(rc.shown && rc.invite === 'colin' && rc.set === '1', "the hero's calendar button is Colin's invite", JSON.stringify(rc));
  await c.close();
}

// ── A reveal scheduled: /live/ follows it, the list moves down the page without it ──
{
  console.log('\n── /live/ with a reveal scheduled ──');
  const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
  const { page, errors } = await open('/live/', { state: scheduled });
  const r = await page.evaluate(() => ({
    next: document.querySelector('.live-page')?.hasAttribute('data-next'),
    stage: getComputedStyle(document.querySelector('.hero-frame [data-stage]')).display !== 'none',
    status: document.querySelector('[data-live="status"]')?.textContent,
    names: [...document.querySelectorAll('#up-next .upn-card__name')].map((n) => n.textContent),
    cal: document.querySelector('[data-live="cta-calendar"]')?.dataset.invite,
  }));
  ok(!r.next && r.stage, 'the frame is the stage again');
  ok(/^We go live/.test(r.status || ''), 'the hero counts down to the scheduled reveal', r.status);
  ok(JSON.stringify(r.names) === JSON.stringify(['Peter', 'Max', 'Dylan']), 'the list below leaves that reveal out', JSON.stringify(r.names));
  ok(r.cal === 'colin', "Add to calendar is Colin's invite");
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();
}

// ── Nothing coming up ──
{
  console.log('\n── nothing coming up ──');
  const { page, errors } = await open('/live/', { upcoming: [] });
  const r = await page.evaluate(() => ({
    next: document.querySelector('.live-page')?.hasAttribute('data-next'),
    stage: getComputedStyle(document.querySelector('.hero-frame [data-stage]')).display !== 'none',
    band: document.querySelector('#up-next')?.hidden,
    status: document.querySelector('[data-live="status"]')?.textContent,
    past: !document.querySelector('[data-live="cta-past"]')?.hidden,
  }));
  ok(!r.next && r.stage && r.band, 'the photo, no list, no section');
  ok(/^No reveal is scheduled right now/.test(r.status || ''), 'the hero says nothing is scheduled', r.status);
  ok(r.past || !(await page.$('#past-reveals')), '"Watch past reveals" is there');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();
}

// ── Reduced motion ──
{
  console.log('\n── reduced motion ──');
  const { page } = await open('/live/', { reduced: true });
  const r = await page.evaluate(() => [...document.querySelectorAll('.hnx-row')].map((x) => getComputedStyle(x).opacity));
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
  const evInv = await page.evaluate(() => ({ adds: [...document.querySelectorAll('#reveals .upn-add')].map((b) => b.dataset.invite), all: document.querySelector('#reveals .upn-cal__btn')?.dataset.invite }));
  ok(JSON.stringify(evInv.adds) === JSON.stringify(['peter', 'colin', 'max', 'dylan-2026']) && evInv.all === 'all', 'events page: every child has their own invite, plus every reveal', JSON.stringify(evInv));
  await page.evaluate(() => document.querySelector('#reveals').scrollIntoView());
  await wait(1500);
  await page.click('#reveals .upn-row[data-slug="dylan-2026"] .upn-add');
  await wait(500);
  ok(await page.evaluate(() => document.querySelector('dialog[data-reveal-invite]')?.open && document.querySelector('[data-rinv="title"]')?.textContent === 'Dylan’s room reveal'), "events page: Add opens Dylan's invite");
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await shot(page, 'events');
  await page.close();

  const { page: k } = await open('/kids/max/');
  const badge = await k.evaluate(() => ({ badge: document.querySelector('[data-kid-reveal-badge]')?.textContent, link: document.querySelector('.hero__reveal-day')?.textContent, add: document.querySelector('.hero__reveal-add')?.dataset.invite }));
  ok(/^Reveal mid [A-Z][a-z]{2}$/.test(badge.badge || ''), 'kid badge: "Reveal mid <Mon>"', badge.badge);
  ok(badge.add === 'max', 'kid page: their own Add to calendar beside it');
  await k.click('.hero__reveal-add');
  await wait(500);
  ok(await k.evaluate(() => document.querySelector('dialog[data-reveal-invite]')?.open && document.querySelector('[data-rinv="title"]')?.textContent === 'Max’s room reveal'), "kid page: it opens Max's invite");
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
