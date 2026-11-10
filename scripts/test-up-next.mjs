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
// What the build drew the band from (src/data/upcoming-reveals.json, the reveals copy, or BUILT_FILE: the copy a test
// build was made with). Locally it's often empty; the drawn-at-build checks need a build made with some in it, and
// say so when skipped.
const BUILT = (() => { try { return JSON.parse(readFileSync(process.env.BUILT_FILE || new URL('../src/data/upcoming-reveals.json', import.meta.url), 'utf8')).upcoming || []; } catch { return []; } })();
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

// headless 'shell': plain headless stalls on screenshots and evaluates once the Mac's display sleeps
const browser = await puppeteer.launch({
  headless: 'shell',
  protocolTimeout: 120000,
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(SITE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

const REMINDERS_ON = { enabled: true, email: true, push: false, hours: [24, 1] };
const SIGNUP_ON = { email: true, hours: [24, 1] };
/**
 * signup: the every-reveal card's settings, as /api/reveals answers them. broadcast: 'fail' answers /api/broadcast
 * with a 500. turnstile: a site key turns the quick check on; checkSays: what the stand-in check frame posts up.
 */
// The page's own form starts on every reveal (Peter, Nov 9 2026: "why not default to them all"); picking "Just <name>'s"
// makes it that child's, and brings the band's every-reveal card back
const pickJust = (page) => page.evaluate(() => { const i = document.querySelector('input[name="remind-scope"][value="one"]'); if (i && !i.checked) i.click(); return !!i?.checked; }).then((on) => wait(300).then(() => on));
const visibleLead = (page) => page.$eval('[data-live="remind-lead"]', (l) => (l.querySelector('[data-lead]:not([aria-hidden="true"])') || l).textContent);

async function open(path, { width = 1440, height = 900, upcoming = UPCOMING, ua = null, reduced = false, state = IDLE, live = null, reminders = REMINDERS_ON, signup = SIGNUP_ON, broadcast = 'ok', turnstile = null, config = 'ok', checkSays = [], checkPages = null, posts = [], answer = null, tz = 'America/New_York', reveals = 'ok', revealsDelay = 0 } = {}) {
  const page = await browser.newPage();
  // Times show in the visitor's own zone: pinned, so the checks don't depend on this machine's
  await page.emulateTimezone(tz);
  const phone = width < 600;
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  if (ua) await page.setUserAgent(ua);
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A static preview has no live socket or images: those misses aren't the page's
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) errors.push(m.text()); });
  // When the band first shows, is its email card already in place? (It must never pop in afterwards.)
  await page.evaluateOnNewDocument(() => {
    const t0 = performance.now();
    // Drawn at build (the reveals copy had some): on screen from the first paint, card and all
    document.addEventListener('DOMContentLoaded', () => {
      const band = document.querySelector('[data-upnext]');
      if (band && !band.hidden && !window.__bandOpen) { const mail = band.querySelector('[data-upn-mail]'); window.__bandOpen = { at: 0, card: !!mail && !mail.hidden, built: true }; }
    });
    new MutationObserver((_m, mo) => {
      const band = document.querySelector('[data-upnext]');
      if (!band || band.hidden || window.__bandOpen) return;
      const mail = band.querySelector('[data-upn-mail]');
      window.__bandOpen = { at: Math.round(performance.now() - t0), card: !!mail && !mail.hidden };
      mo.disconnect();
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') return req.abort();
    if (url.pathname === '/api/reveals') {
      if (reveals === 'fail') return json({ error: 'down' }, 500);
      const answer = () => json({ reveals: upcoming.length ? REVEALS : [], upcoming, signup, updatedAt: new Date().toISOString(), source: 'test' });
      return revealsDelay ? void setTimeout(answer, revealsDelay) : answer();
    }
    // live: { state } the test can change mid-page (then window.__soardLiveClient.refresh())
    if (url.pathname === '/api/broadcast') return broadcast === 'fail' ? json({ error: 'down' }, 500) : json({ state: live ? live.state : state, reminders, messages: { enabled: true }, timezone: 'America/New_York', hub: false });
    if (url.pathname === '/api/reminders' && url.searchParams.has('config')) return config === 'fail' ? json({ ok: false }, 500) : json({ ok: true, turnstile });
    if (url.pathname === '/api/reminders' && url.searchParams.has('check')) {
      // checkPages: one answer per frame built ({ status } fails it, { says } is what it posts); else checkSays every time
      const next = checkPages ? checkPages.shift() || { says: [] } : { says: checkSays };
      if (next.status) return req.respond({ status: next.status, contentType: 'application/json', body: '{"ok":false,"error":"boom"}' });
      const say = (next.says || []).map((m) => `parent.postMessage(${JSON.stringify({ type: 'soard-check', ...m })}, location.origin);`).join('');
      return req.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><body style="margin:0"><script>setTimeout(() => { ${say} }, 50);</script></body>` });
    }
    if (url.pathname === '/api/reminders' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      posts.push(body);
      // answer(body) → [status, json], or 'hang' to never answer
      const a = answer ? answer(body) : [200, { ok: true, channel: 'email' }];
      return a === 'hang' ? undefined : json(a[1], a[0]);
    }
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
  ok(r.confirmedWhen.every((t) => /\d/.test(t) && /PM E[SD]T/.test(t)), 'the confirmed row shows its day and time', JSON.stringify(r.confirmedWhen));
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
  ok(/^\w+day, \w+ \d{1,2} at \d{1,2}:\d{2} PM E[SD]T\. It goes in your calendar with the link to watch live/.test(confirmedText || ''), "a confirmed child's invite says the day and time", confirmedText);
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

// ── Every reveal by email: the card beside "Add every reveal" ──
{
  console.log('\n── every reveal by email ──');
  const card = (page, band) => page.evaluate((sel) => {
    const s = document.querySelector(sel);
    const mail = s?.querySelector('[data-upn-mail]');
    const cal = s?.querySelector('[data-upn-cal]');
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const r = (el) => el?.getBoundingClientRect();
    return {
      shown: vis(mail), calShown: vis(cal),
      first: !!mail && !!cal && r(mail).top < r(cal).top,
      title: mail?.querySelector('h3')?.textContent,
      lead: mail?.querySelector('[data-upn-mail-lead]')?.textContent,
      label: mail?.querySelector('label[for]')?.textContent,
      // The address box and its button: side by side when there's room, the button full width when not
      row: (() => { const i = r(mail?.querySelector('input[name="email"]')); const b = r(mail?.querySelector('button[type="submit"]')); return i && b ? { same: Math.abs(i.top - b.top) < 2, btnW: Math.round(b.width), formW: Math.round(r(mail.querySelector('form')).width), inputW: Math.round(i.width), h: Math.round(b.height) } : null; })(),
    };
  }, band);

  for (const width of [1440, 1024, 820, 390]) {
    const { page, errors } = await open('/events/', { width, height: width < 600 ? 844 : 900 });
    const c = await card(page, '#reveals');
    ok(c.shown && c.calShown && c.first, `events ${width}px: the email card shows, before the calendar card`, JSON.stringify(c));
    ok(c.title === 'Get every reveal by email' && /about every reveal: when it gets a date, the day before, an hour before, when we go live, and when the replay is up\. Nothing else, ever\./.test(c.lead || ''), `events ${width}px: its promise`, c.lead);
    ok(c.row && c.row.h >= 44 && c.row.inputW >= 180, `events ${width}px: a full-size box and button`, JSON.stringify(c.row));
    if (width === 390) ok(c.row && !c.row.same && c.row.btnW === c.row.formW, 'phone: the button takes its own line, full width', JSON.stringify(c.row));
    else if (width === 1440) ok(c.row && c.row.same, 'desktop: box and button on one line', JSON.stringify(c.row));
    ok((await sideways(page)) <= 0, `events ${width}px: no sideways scroll`);
    if (width === 1440 || width === 390) await axeScan(page, '#reveals', `email card at ${width}px`);
    await shot(page, `mail-events-${width}`);
    ok(errors.length === 0, `events ${width}px: no console errors`, errors.join(' | '));
    await page.close();
  }

  // An address that once pressed Stop: the server emails it a link to come back (pending), and the form says so
  {
    const { page } = await open('/events/', { answer: () => [200, { ok: true, channel: 'email', pending: true }] });
    await page.evaluate(() => document.querySelector('#reveals [data-upn-mail]').scrollIntoView({ block: 'center' }));
    await page.type('#reveals-email', 'back@gmail.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    const note = await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => n.textContent).catch(() => '');
    ok(/Check your email to confirm\. We sent a link to back@gmail\.com/.test(note), 'an address that pressed Stop before: the note says to check the email for the link', note);
    await page.close();
  }

  // Signing up: every reveal (no kid), counted as the events page's card, and a typo asked about first
  {
    const posts = [];
    const { page, errors } = await open('/events/', { posts });
    await page.evaluate(() => document.querySelector('#reveals [data-upn-mail]').scrollIntoView({ block: 'center' }));
    await page.type('#reveals-email', 'fan@gmial.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(300);
    const fix = await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => n.textContent).catch(() => '');
    ok(/Did you mean fan@gmail\.com\?/.test(fix) && posts.length === 0, 'a likely typo is asked about before sending', fix);
    await page.click('#reveals [data-upn-mail] .remind-fix');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    const done = await page.evaluate(() => {
      const f = document.querySelector('#reveals [data-upn-mail-form]');
      return { done: f.classList.contains('is-done'), note: f.querySelector('.remind-note').textContent, btn: f.querySelector('button[type="submit"]').innerText.trim() };
    });
    ok(done.done && /You're on the list\. We'll email fan@gmail\.com about every reveal\./.test(done.note) && done.btn === 'Done', 'one press signs up: the button says Done, the note says they are on the list (nothing to confirm)', JSON.stringify(done));
    const body = posts[0] || {};
    ok(posts.length === 1 && body.channel === 'email' && body.email === 'fan@gmail.com' && !('kidSlug' in body && body.kidSlug) && body.source === 'events-all', 'the sign-up is for every reveal, from the events card', JSON.stringify(posts));
    await page.type('#reveals-email', 'x');
    ok(!(await page.$eval('#reveals [data-upn-mail-form]', (f) => f.classList.contains('is-done'))), 'editing the address opens the form again');
    ok(errors.length === 0, 'sign-up: no console errors', errors.join(' | '));
    await page.close();
  }

  // Settings: off means no card; the promise follows the hours saved
  {
    const { page } = await open('/events/', { signup: { email: false, hours: [24, 1] } });
    const c = await card(page, '#reveals');
    ok(!c.shown && c.calShown, 'reminders off: no email card, the calendar card stays', JSON.stringify(c));
    await page.close();
  }
  {
    const { page } = await open('/events/', { signup: { email: true, hours: [24] } });
    const c = await card(page, '#reveals');
    ok(c.shown && /the day before, when we go live/.test(c.lead || '') && !/an hour before/.test(c.lead || ''), 'day-before only: the card promises just that', c.lead);
    await page.close();
  }

  // ── What the first tester found (Nov 9), each kept from coming back ──
  const rect = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; });
  const press = async (page, sel) => { const b = await rect(page, sel); await page.mouse.click(b.x + b.w / 2, b.y - (await page.evaluate(() => scrollY)) + b.h / 2); };

  // A double-click is one press: it never sends the misspelled address past "Did you mean"
  {
    const posts = [];
    const { page } = await open('/events/', { posts });
    await page.evaluate(() => document.querySelector('#reveals [data-upn-mail]').scrollIntoView({ block: 'center' }));
    await page.type('#reveals-email', 'fan@gmial.com');
    const btn = '#reveals [data-upn-mail] button[type="submit"]';
    await press(page, btn); await wait(60); await press(page, btn);
    await page.keyboard.press('Enter'); // and a held Enter on top
    await wait(300);
    const note = await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => n.textContent);
    ok(posts.length === 0 && /Did you mean fan@gmail\.com\?/.test(note), 'a double-click or held Enter never skips "Did you mean"', JSON.stringify({ posts, note }));
    await wait(1100);
    await press(page, btn);
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    ok(posts.length === 1 && posts[0].email === 'fan@gmial.com', 'pressing again on purpose sends it as typed (it may be right)', JSON.stringify(posts));
    await page.close();
  }

  // Addresses the server turns down are caught on the page first
  {
    const posts = [];
    const { page } = await open('/events/', { posts });
    // A slip with an answer is offered the answer; anything else is marked on the box, which gets focus back
    for (const [bad, want] of [['ana@gmail.com.', 'Did you mean ana@gmail.com?'], ['ana@gmail..com', 'Did you mean ana@gmail.com?'], ['ana@example.com,', 'Did you mean ana@example.com?'], ['<ana@gmail.com>', 'Enter a valid email address.'], ['ana@gmail', 'Enter a valid email address.']]) {
      await page.$eval('#reveals-email', (i) => { i.value = ''; });
      await page.type('#reveals-email', bad);
      await page.click('#reveals [data-upn-mail] button[type="submit"]');
      await wait(150);
      await page.click('#reveals [data-upn-mail] button[type="submit"]');
      await wait(1200);
      await page.click('#reveals [data-upn-mail] button[type="submit"]');
      await wait(150);
      const r = await page.evaluate(() => { const i = document.querySelector('#reveals-email'); const n = document.querySelector('#reveals [data-upn-mail] .remind-note'); return { note: n.textContent, invalid: i.getAttribute('aria-invalid'), described: i.getAttribute('aria-describedby') === n.id, focused: document.activeElement === i }; });
      const isError = want.startsWith('Enter');
      ok(r.note === want && posts.length === 0 && (!isError || (r.invalid === 'true' && r.described && r.focused)), `"${bad}": ${isError ? 'marked on the box, focus back on it' : 'offered the fix'}, never sent, however often pressed`, JSON.stringify(r));
    }
    // Fixing it clears the mark
    await page.type('#reveals-email', 'x');
    ok(await page.$eval('#reveals-email', (i) => !i.hasAttribute('aria-invalid')), 'editing the address clears "not valid"');
    await page.close();
  }

  // "Email me" → "You're on the list" moves nothing: not the box, not the button, not the calendar card
  for (const [width, height] of [[1024, 768], [1100, 800], [1440, 900], [390, 844]]) {
    const { page } = await open('/events/', { width, height });
    await page.evaluate(() => document.querySelector('#reveals [data-upn-mail]').scrollIntoView({ block: 'center' }));
    const where = () => Promise.all(['#reveals-email', '#reveals [data-upn-mail] button[type="submit"]', '#reveals [data-upn-cal]'].map((s) => rect(page, s)));
    const before = await where();
    await page.type('#reveals-email', 'fan@example.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    const after = await where();
    const same = (a, b) => a.x === b.x && a.w === b.w && a.h === b.h;
    ok(same(before[0], after[0]) && same(before[1], after[1]) && before[0].y === after[0].y && before[1].y === after[1].y, `${width}px: the label swap moves neither the box nor the button`, JSON.stringify({ before: before.slice(0, 2), after: after.slice(0, 2) }));
    // Below the form, the calendar card moves down by exactly the note that appeared (its words and its 12px margin), nothing more
    const note = await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => Math.round(n.getBoundingClientRect().height + parseFloat(getComputedStyle(n).marginTop)));
    ok(Math.abs(after[2].y - before[2].y - note) <= 1, `${width}px: the calendar card moves only by the note's own height`, `${before[2].y} → ${after[2].y}, note ${note}px`);
    // The done button holds its color under the pointer (it can't be pressed again)
    if (width === 1440) {
      await page.hover('#reveals [data-upn-mail] button[type="submit"]');
      await wait(250);
      const bg = await page.$eval('#reveals [data-upn-mail] button[type="submit"]', (b) => getComputedStyle(b).backgroundColor);
      ok(bg === 'rgb(255, 218, 36)', 'the done button doesn’t react to hover', bg);
    }
    await page.close();
  }

  // The band opens with its card in place, and doesn't wait on the live connection (here it fails)
  for (const broadcast of ['ok', 'fail']) {
    const { page, errors } = await open('/events/', { broadcast });
    const open1 = await page.evaluate(() => window.__bandOpen);
    ok(open1 && open1.card === true && open1.at < 1500, `the band opens with its email card already in place (live connection ${broadcast})`, JSON.stringify(open1));
    if (broadcast === 'fail') ok((await card(page, '#reveals')).shown, 'a failed live connection takes nothing away from the band');
    await page.close();
    void errors;
  }

  // Keyboard: Tab to the button and press it. Focus stays on the button (it's aria-disabled, never disabled, so a
  // keyboard user's place isn't lost), the news is read from the status line, and the ring is plain to see
  {
    const { page } = await open('/events/');
    await page.focus('#reveals-email');
    await page.keyboard.type('fan@example.com');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const b = document.activeElement; const cs = getComputedStyle(b); return { isBtn: b?.matches('#reveals [data-upn-mail] button[type="submit"]'), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, offset: cs.outlineOffset, shadow: cs.boxShadow }; });
    ok(ring.isBtn && ring.outline === 'solid 2px rgb(255, 218, 36)' && ring.offset === '3px' && ring.shadow === 'none', 'keyboard focus on the yellow button: a yellow ring a dark gap away, no glow melting into it', JSON.stringify(ring));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    const f = await page.evaluate(() => { const b = document.querySelector('#reveals [data-upn-mail] button[type="submit"]'); return { onBtn: document.activeElement === b, aria: b.getAttribute('aria-disabled'), disabled: b.disabled, note: document.querySelector('#reveals [data-upn-mail] .remind-note').textContent }; });
    ok(f.onBtn && f.aria === 'true' && !f.disabled && /You're on the list/.test(f.note), 'keyboard sign-up: focus stays put on the button, the news is on the status line', JSON.stringify(f));
    await page.keyboard.press('Enter');
    await wait(200);
    ok(await page.$eval('#reveals [data-upn-mail-form]', (fm) => fm.classList.contains('is-done')), 'pressing the Sent button again does nothing');
    await page.close();
  }

  // A slow answer: a spinner in the button (same size), and focus isn't pulled back from where the person went
  {
    const { page } = await open('/events/');
    // The sign-up's answer takes 1.5s
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = (u, o) => (String(u).includes('/api/reminders') && o?.method === 'POST' ? new Promise((r) => setTimeout(r, 1500)).then(() => real(u, o)) : real(u, o));
    });
    const before = await rect(page, '#reveals [data-upn-mail] button[type="submit"]');
    await page.focus('#reveals-email');
    await page.keyboard.type('fan@example.com');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await wait(300);
    const mid = await page.evaluate(() => { const f = document.querySelector('#reveals [data-upn-mail-form]'); const sp = f.querySelector('.btn-busy'); return { busy: f.classList.contains('is-busy'), ariaBusy: f.getAttribute('aria-busy'), spinner: getComputedStyle(sp).visibility }; });
    const during = await rect(page, '#reveals [data-upn-mail] button[type="submit"]');
    ok(mid.busy && mid.ariaBusy === null && mid.spinner === 'visible' && during.w === before.w && during.h === before.h, 'while it sends: a spinner in the button (named "Sending"), and the button keeps its size', JSON.stringify({ mid, before, during }));
    await page.keyboard.press('Tab'); // on to the calendar card's button
    const went = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60));
    await wait(1700);
    const after = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60));
    ok(after === went && await page.$eval('#reveals [data-upn-mail-form]', (fm) => fm.classList.contains('is-done')), 'the answer lands without pulling focus back', JSON.stringify({ went, after }));
    await page.close();
  }

  // The check's own page fails to load: the form says so within seconds (no 90-second wait over a blank or broken box),
  // and the next press builds a fresh check and goes through
  {
    const posts = [];
    const { page } = await open('/events/', { posts, turnstile: '0xTEST', checkPages: [{ status: 500 }, { says: [{ ready: true }, { token: 'tok-2' }] }] });
    await page.type('#reveals-email', 'fan@example.com');
    const t0 = Date.now();
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await page.waitForFunction(() => /couldn.t load/.test(document.querySelector('#reveals [data-upn-mail] .remind-note').textContent), { timeout: 20000 }).catch(() => {});
    const said = await page.evaluate(() => ({ note: document.querySelector('#reveals [data-upn-mail] .remind-note').textContent, shown: document.querySelector('#reveals [data-upn-mail-check]').classList.contains('is-shown'), busy: document.querySelector('#reveals [data-upn-mail-form]').classList.contains('is-busy') }));
    const took = Date.now() - t0;
    ok(/The quick check couldn.t load here/.test(said.note) && !said.shown && !said.busy && took < 10000 && posts.length === 0, `a check that fails to load is said plainly in ${Math.round(took / 1000)}s, never shown broken`, JSON.stringify(said));
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 15000 }).catch(() => {});
    ok(posts.length === 1 && posts[0].turnstileToken === 'tok-2', 'the next press builds a fresh check and signs up', JSON.stringify(posts));
    await page.close();
  }

  // The check fails under a press, then sorts itself out: that sign-up carries on by itself; and once signed up,
  // a click Cloudflare asks for next never appears under the finished form
  {
    const posts = [];
    const { page } = await open('/events/', { posts, turnstile: '0xTEST', checkSays: [{ ready: true }] });
    // What the check frame says, as if from inside it
    const fromCheck = (m) => page.evaluate((msg) => { const f = document.querySelector('#reveals [data-upn-mail-check] iframe'); window.dispatchEvent(new MessageEvent('message', { data: { type: 'soard-check', ...msg }, origin: location.origin, source: f.contentWindow })); }, m);
    await page.focus('#reveals-email');
    await wait(600);
    await page.type('#reveals-email', 'fan@example.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(300);
    await fromCheck({ error: true }); // Cloudflare's widget fails while the press waits on it
    await wait(200);
    const failed = await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => n.textContent);
    await fromCheck({ token: 'late' }); // then recovers on its own
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    ok(/quick check/.test(failed) && posts.length === 1 && posts[0].turnstileToken === 'late', 'a check that recovers carries the held-up sign-up on, with no second press', JSON.stringify({ failed, posts }));
    await fromCheck({ show: true });
    await wait(200);
    ok(!(await page.$eval('#reveals [data-upn-mail-check]', (b) => b.classList.contains('is-shown'))), 'after Sent, a new click Cloudflare wants stays out of sight');
    await page.close();
  }

  // Reading order is the order on screen at every width: the intro, the list, then the two cards
  for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]]) {
    const { page } = await open('/events/', { width, height });
    const order = await page.evaluate(() => {
      const s = document.querySelector('#reveals');
      const [intro, list, ways] = ['.upn__intro', '.upn__list', '.upn-ways'].map((q) => s.querySelector(q));
      const dom = !!(intro.compareDocumentPosition(list) & 4) && !!(list.compareDocumentPosition(ways) & 4);
      const y = (el) => el.getBoundingClientRect().top;
      const screen = innerWidth > 960 ? y(intro) <= y(ways) : y(intro) < y(list) && y(list) < y(ways);
      return { dom, screen };
    });
    ok(order.dom && order.screen, `${width}px: tab and screen-reader order match the screen`, JSON.stringify(order));
    await page.close();
  }

  // The quick check: dark to match the band, and its frame as tall as what Cloudflare draws (the compact one on a small phone)
  for (const width of [320, 390, 1440]) {
    const { page } = await open('/events/', { width, height: width < 600 ? 700 : 900, turnstile: '0xTEST', checkSays: [{ h: width < 400 ? 140 : 65 }, { show: true }] });
    await page.evaluate(() => document.querySelector('#reveals [data-upn-mail]').scrollIntoView({ block: 'center' }));
    await page.focus('#reveals-email');
    await page.waitForSelector('#reveals [data-upn-mail-check] iframe', { timeout: 5000 }).catch(() => {});
    await wait(700);
    const fr = await page.evaluate(() => {
      const box = document.querySelector('#reveals [data-upn-mail-check]');
      const f = box?.querySelector('iframe');
      const card = document.querySelector('#reveals [data-upn-mail]').getBoundingClientRect();
      const r = f?.getBoundingClientRect();
      return { src: f?.getAttribute('src'), shown: box?.classList.contains('is-shown'), h: Math.round(r?.height || 0), inside: !!r && r.left >= card.left && r.right <= card.right };
    });
    const want = width < 400 ? 140 : 65;
    ok(fr.src === '/api/reminders?check=1&theme=dark' && fr.shown && fr.h === want && fr.inside, `${width}px: the quick check is dark, ${want}px tall as drawn, inside the card`, JSON.stringify(fr));
    ok((await sideways(page)) <= 0, `${width}px: the check never pushes the page sideways`);
    await page.close();
  }

  // Long lists on real laptop screens (inner heights of 1366x768, 1536x864 browsers, and roomy ones): the cards stick
  // only when they fit with room to grow, and pressing Email me never moves the button under the pointer, whatever opens
  {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...UPCOMING[i % UPCOMING.length], slug: `kid-${i}`, name: `Kid ${i + 1}` }));
    for (const [width, height] of [[1366, 657], [1536, 750], [1440, 900], [1920, 1080], [1093, 530]]) {
      for (const what of ['typo', 'sent', 'check']) {
        const { page } = await open('/events/', { width, height, upcoming: many, turnstile: what === 'check' ? '0xTEST' : null, checkSays: [{ ready: true }, { h: 65 }] });
        // Mid-list, where a sticking column would be pinned
        await page.evaluate(() => { const l = document.querySelector('#reveals [data-upn-list]'); const r = l.getBoundingClientRect(); scrollTo(0, scrollY + r.top + r.height * 0.5 - innerHeight / 2); });
        await wait(300);
        const mode = await page.$eval('#reveals', (s) => s.dataset.ways);
        const btnSel = '#reveals [data-upn-mail] button[type="submit"]';
        const onScreen = () => page.$eval(btnSel, (b) => { const r = b.getBoundingClientRect(); return { y: Math.round(r.top), vh: innerHeight }; });
        // Bring the button into view the way a person would, by scrolling, then hold still
        await page.$eval(btnSel, (b) => { const r = b.getBoundingClientRect(); if (r.top < 100 || r.bottom > innerHeight - 20) scrollBy(0, r.top - innerHeight / 2); });
        await wait(300);
        const before = await onScreen();
        await page.type('#reveals-email', what === 'typo' ? 'fan@gmial.com' : 'fan@example.com');
        if (what === 'check') {
          await page.$eval(btnSel, (b) => b.click());
          await wait(300);
          await page.evaluate(() => { const f = document.querySelector('#reveals [data-upn-mail-check] iframe'); window.dispatchEvent(new MessageEvent('message', { data: { type: 'soard-check', show: true, h: 140 }, origin: location.origin, source: f.contentWindow })); });
        } else {
          await page.$eval(btnSel, (b) => b.click());
        }
        await wait(500);
        const after = await onScreen();
        ok(after.y === before.y, `${width}x${height} (${mode}), ${what}: the button stays under the pointer`, `${before.y} → ${after.y}`);
        if (what === 'sent' && mode === 'stick') {
          // Sticking, both cards stay on screen all the way down the list
          const seen = [];
          for (const at of [0.3, 0.6, 0.9]) {
            await page.evaluate((f) => { const l = document.querySelector('#reveals [data-upn-list]'); const r = l.getBoundingClientRect(); scrollTo(0, scrollY + r.top + r.height * f - innerHeight / 2); }, at);
            await wait(200);
            seen.push(await page.evaluate(() => { const c = document.querySelector('#reveals [data-upn-cal] .upn-cal__btn').getBoundingClientRect(); const m = document.querySelector('#reveals [data-upn-mail]').getBoundingClientRect(); return { calBottom: Math.round(c.bottom), mailTop: Math.round(m.top), vh: innerHeight }; }));
          }
          ok(seen.every((v) => v.calBottom <= v.vh && v.mailTop >= 84), `${width}x${height}: sticking, both cards stay fully on screen down the list`, JSON.stringify(seen));
        }
        await page.close();
      }
    }
  }

  // /live/: the band's card in use never vanishes when the broadcast moves on; the page form keeps its reveal while typed in
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const replay = { ...IDLE, phase: 'replay', replay: true, id: 'live-0', kidSlug: 'abby', kidName: 'Abby', title: "Abby's room reveal", endedAt: day(-1).toISOString(), replayUntil: day(2).toISOString(), player: { kind: 'replay', uid: 'vid0', customerCode: 'x' } };
    const refresh = (page) => page.evaluate(() => window.__soardLiveClient.refresh()).then(() => wait(500));

    // (a) Typing in the band's card while scheduled → replay (the page's form becomes every-reveal)
    {
      const live = { state: scheduled };
      const { page } = await open('/live/', { live });
      await pickJust(page);
      await page.evaluate(() => document.querySelector('#up-next [data-upn-mail]').scrollIntoView({ block: 'center' }));
      await page.focus('#up-next-email');
      await page.keyboard.type('fan@exa');
      live.state = replay;
      await refresh(page);
      const mid = await page.evaluate(() => ({ here: document.querySelector('#up-next').hasAttribute('data-remind-here'), shown: getComputedStyle(document.querySelector('#up-next [data-upn-mail]')).display !== 'none', focus: document.activeElement?.id, value: document.querySelector('#up-next-email').value }));
      ok(mid.here && mid.shown && mid.focus === 'up-next-email' && mid.value === 'fan@exa', '/live/: the band card someone is typing in stays put when the broadcast moves on', JSON.stringify(mid));
      await page.$eval('#up-next-email', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); });
      await wait(200);
      ok(await page.$eval('#up-next [data-upn-mail]', (m) => getComputedStyle(m).display !== 'none'), '/live/: left empty, it stays while it’s on screen');
      await page.evaluate(() => scrollTo(0, 0));
      await wait(600);
      ok(await page.$eval('#up-next [data-upn-mail]', (m) => getComputedStyle(m).display === 'none'), '/live/: once off screen, it steps aside for the page’s own every-reveal form');
      await page.close();
    }
    // (b) Typing in the page's every-reveal form while replay → scheduled for Colin
    {
      const posts = [];
      const live = { state: replay };
      const { page } = await open('/live/', { live, posts });
      await page.focus('#remind-email');
      await page.keyboard.type('fan@example.com');
      live.state = scheduled;
      await refresh(page);
      const held = await page.evaluate(() => ({ heading: document.querySelector('[data-live="remind-heading"]').textContent, label: document.querySelector('[data-live="remind-email-label"]').textContent }));
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-live="form-email"].is-done', { timeout: 5000 }).catch(() => {});
      ok(held.heading === 'Hear about the next reveal' && held.label === 'Email address for every reveal' && posts.length === 1 && !posts[0].kidSlug, '/live/: a form being typed in keeps "every reveal" when Colin’s reveal is scheduled mid-word, and signs up for every reveal', JSON.stringify({ held, posts }));
      // Done with it and away: the page moves on to Colin, and the every-reveal sign-up (which covers Colin) stays shown as sent
      await page.$eval('#remind-email', (i) => i.blur());
      await page.evaluate(() => document.body.focus());
      await refresh(page);
      const after = await page.evaluate(() => ({ heading: document.querySelector('[data-live="remind-heading"]').textContent, label: document.querySelector('[data-live="remind-email-label"]').textContent, done: document.querySelector('[data-live="form-email"]').classList.contains('is-done') }));
      ok(/^(Never miss a reveal|Hear about the next reveal)$/.test(after.heading) && after.label === 'Email address for every reveal' && after.done, '/live/: an every-reveal "Sent" keeps saying every reveal when Colin is scheduled (it covers Colin)', JSON.stringify(after));
      const size = await page.$eval('#remind-email', (i) => getComputedStyle(i).fontSize);
      ok(size === '16px', '/live/: the page form’s box is 16px, so an iPhone doesn’t zoom in on tap', size);
      await page.close();
    }
    // (c) The live state can't be read: the page still offers the every-reveal sign-up
    {
      const { page } = await open('/live/', { broadcast: 'fail' });
      await page.waitForFunction(() => { const f = document.querySelector('[data-live="form-email"]'); return f && !f.closest('[hidden]') && f.getBoundingClientRect().height > 0; }, { timeout: 12000 }).catch(() => {});
      const r = await page.evaluate(() => ({ view: document.querySelector('.live-page')?.dataset.view, form: !document.querySelector('[data-live="form-email"]').closest('[hidden]'), heading: document.querySelector('[data-live="remind-heading"]').textContent }));
      ok(r.view === 'idle' && r.form && r.heading === 'Never miss a reveal', '/live/ with its live connection down: the every-reveal sign-up still shows', JSON.stringify(r));
      await page.close();
    }
  }

  // ── Round three (Nov 9): each kept from coming back ──
  // A sign-up that hears nothing back says so (no endless "One moment…"); while it sends the button is named "Sending"
  // and the address can't change (what goes is what's shown)
  {
    const posts = [];
    const { page } = await open('/events/', { posts, answer: () => 'hang' });
    // (20s in real life; shortened here)
    await page.evaluate(() => { const real = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = (ms) => real(Math.min(ms, 1500)); });
    await page.type('#reveals-email', 'fan@example.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(300);
    const btn = await page.$('#reveals [data-upn-mail] button[type="submit"]');
    const name = (await page.accessibility.snapshot({ root: btn, interestingOnly: false }))?.name;
    await page.type('#reveals-email', 'zzz');
    const during = await page.evaluate(() => ({ value: document.querySelector('#reveals-email').value, readOnly: document.querySelector('#reveals-email').readOnly }));
    ok(name === 'Sending' && during.readOnly && during.value === 'fan@example.com', 'while it sends: the button reads "Sending", and the address can’t be changed', JSON.stringify({ name, during }));
    await page.waitForFunction(() => /didn.t hear back/.test(document.querySelector('#reveals [data-upn-mail] .remind-note').textContent), { timeout: 8000 }).catch(() => {});
    const after = await page.evaluate(() => { const f = document.querySelector('#reveals [data-upn-mail-form]'); return { note: f.querySelector('.remind-note').textContent, busy: f.classList.contains('is-busy'), readOnly: f.querySelector('input[name="email"]').readOnly, color: getComputedStyle(f.querySelector('.remind-note')).color }; });
    ok(/We didn.t hear back\. Please try again\./.test(after.note) && !after.busy && !after.readOnly, 'no answer: it says so and can be tried again (never stuck on "One moment…")', JSON.stringify(after));
    ok(after.color === 'rgb(254, 252, 245)', 'an error on the band reads in full colour, not muted', after.color);
    await page.close();
  }

  // The check never opens empty for a slow invisible check; once its token comes, the note says "One moment…" again
  {
    const posts = [];
    const { page } = await open('/events/', { posts, turnstile: '0xTEST', checkSays: [{ ready: true }], answer: () => 'hang' });
    const fromCheck = (m) => page.evaluate((msg) => { const f = document.querySelector('#reveals [data-upn-mail-check] iframe'); window.dispatchEvent(new MessageEvent('message', { data: { type: 'soard-check', ...msg }, origin: location.origin, source: f.contentWindow })); }, m);
    await page.focus('#reveals-email');
    await wait(600);
    await page.type('#reveals-email', 'fan@example.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(7000);
    const slow = await page.evaluate(() => ({ shown: document.querySelector('#reveals [data-upn-mail-check]').classList.contains('is-shown'), note: document.querySelector('#reveals [data-upn-mail] .remind-note').textContent }));
    ok(!slow.shown && slow.note === 'One moment…', 'a slow invisible check: no empty box, no "finish the check" with nothing to finish', JSON.stringify(slow));
    await fromCheck({ show: true });
    await wait(150);
    const asked = await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => n.textContent);
    await fromCheck({ token: 'tok' });
    await wait(300);
    const sending = await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => n.textContent);
    ok(asked === 'Almost there. Finish the quick check below.' && sending === 'One moment…' && posts.length === 1, 'asked for a click: "Almost there"; clicked: back to "One moment…" while it sends', JSON.stringify({ asked, sending }));
    await page.close();
  }

  // The settings answer fails, but the server wants the check: the form loads the check and goes through
  {
    const posts = [];
    const answer = (b) => (b.turnstileToken ? [200, { ok: true, channel: 'email' }] : [403, { ok: false, code: 'turnstile', error: 'Please finish the quick check, then try again.' }]);
    const { page } = await open('/events/', { posts, turnstile: '0xTEST', config: 'fail', checkSays: [{ ready: true }, { token: 'tok-c' }], answer });
    await page.type('#reveals-email', 'fan@example.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 15000 }).catch(() => {});
    ok(posts.length === 2 && !posts[0].turnstileToken && posts[1].turnstileToken === 'tok-c', 'no settings answer: the server’s "check first" brings the check, and the sign-up goes through', JSON.stringify(posts));
    await page.close();
  }

  // A server "not valid" puts focus back on the box, as the page's own check does
  {
    const { page } = await open('/events/', { answer: () => [400, { ok: false, error: 'Enter a valid email address.' }] });
    await page.focus('#reveals-email');
    await page.keyboard.type('fan@example.com');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await wait(500);
    const r = await page.evaluate(() => ({ focus: document.activeElement?.id, invalid: document.querySelector('#reveals-email').getAttribute('aria-invalid') }));
    ok(r.focus === 'reveals-email' && r.invalid === 'true', 'the server says the address is wrong: focus goes back to the box, marked', JSON.stringify(r));
    await page.close();
  }

  // The events page with nothing scheduled keeps the band: the way to hear about the next one
  {
    const { page } = await open('/events/', { upcoming: [] });
    const r = await page.evaluate(() => { const s = document.querySelector('#reveals'); const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; return { hidden: s.hidden, empty: s.hasAttribute('data-empty'), mail: vis(s.querySelector('[data-upn-mail]')), cal: vis(s.querySelector('[data-upn-cal]')), list: vis(s.querySelector('.upn__list')), lead: [...s.querySelectorAll('.upn__lead')].find(vis)?.textContent, one: vis(s.querySelector('[data-cal-one]')) }; });
    ok(!r.hidden && r.empty && r.mail && r.cal && !r.list && /isn't on the schedule yet/.test(r.lead || '') && !r.one, 'events, nothing scheduled: the band stays with "get the next one" by email or calendar', JSON.stringify(r));
    await page.close();
    const off = await open('/events/', { upcoming: [], signup: { email: false, hours: [24, 1] } });
    ok(await off.page.$eval('#reveals', (s) => s.hidden), 'events, nothing scheduled and sign-up off: no band');
    await off.page.close();
  }

  // One reveal on a phone: a dot, no line hanging under it
  {
    const { page } = await open('/events/', { width: 390, height: 844, upcoming: [UPCOMING[0]] });
    const line = await page.$eval('#reveals .upn__list', (l) => getComputedStyle(l, '::before').display);
    ok(line === 'none', 'one reveal: no timeline line', line);
    await page.close();
  }

  // /live/: the broadcast going idle mid-sign-up never takes the form away or moves it
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const replay = { ...IDLE, phase: 'replay', replay: true, id: 'live-0', kidSlug: 'abby', kidName: 'Abby', title: "Abby's room reveal", endedAt: day(-1).toISOString(), replayUntil: day(2).toISOString(), player: { kind: 'replay', uid: 'vid0', customerCode: 'x' } };
    const refresh = (page) => page.evaluate(() => window.__soardLiveClient.refresh()).then(() => wait(600));
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      // The band's card, scheduled → idle (the hero takes over the list, which hid the band)
      {
        const live = { state: scheduled };
        const { page } = await open('/live/', { width, height, live });
        await pickJust(page);
        await page.evaluate(() => document.querySelector('#up-next [data-upn-mail]').scrollIntoView({ block: 'center' }));
        await page.focus('#up-next-email');
        await page.keyboard.type('fan@exa');
        const y0 = await page.$eval('#up-next-email', (i) => Math.round(i.getBoundingClientRect().top));
        live.state = IDLE;
        await refresh(page);
        const r = await page.evaluate(() => { const i = document.querySelector('#up-next-email'); return { y: Math.round(i.getBoundingClientRect().top), shown: i.getBoundingClientRect().height > 0, focus: document.activeElement === i }; });
        ok(r.shown && r.focus && Math.abs(r.y - y0) <= 1, `/live/ ${width}px: scheduled → idle mid-sign-up: the band’s card stays, focused, in place (to the pixel)`, JSON.stringify({ y0, ...r }));
        await page.keyboard.type('mple.com');
        ok(await page.$eval('#up-next-email', (i) => i.value) === 'fan@example.com', `/live/ ${width}px: and typing carries on in it`);
        await page.close();
      }
      // The page's own form, replay → idle (past reveals move up above it)
      {
        const live = { state: replay };
        const { page } = await open('/live/', { width, height, live });
        await page.evaluate(() => document.querySelector('#remind').scrollIntoView({ block: 'center' }));
        await page.focus('#remind-email');
        await page.keyboard.type('fan@exa');
        const y0 = await page.$eval('#remind-email', (i) => Math.round(i.getBoundingClientRect().top));
        live.state = IDLE;
        await refresh(page);
        const r = await page.evaluate(() => { const i = document.querySelector('#remind-email'); return { y: Math.round(i.getBoundingClientRect().top), focus: document.activeElement === i, view: document.querySelector('.live-page').dataset.view }; });
        ok(r.view === 'idle' && r.focus && Math.abs(r.y - y0) <= 1, `/live/ ${width}px: replay → idle mid-sign-up: the page form stays where it was on screen`, JSON.stringify({ y0, ...r }));
        await page.close();
      }
    }
    // The promise under the page form is about whom it's for, and holds while typed in
    {
      const soon = { ...scheduled, scheduledAt: new Date(Date.now() + 40 * 60e3).toISOString() };
      const live = { state: IDLE };
      const { page } = await open('/live/', { live });
      const leadNow = () => visibleLead(page);
      const every = await leadNow();
      await page.focus('#remind-email');
      await page.keyboard.type('fan@');
      live.state = soon;
      await refresh(page);
      const held = await leadNow();
      ok(every.startsWith("We'll email you about every reveal: when it gets a date, the day before, an hour before") && held === every, '/live/: the every-reveal promise holds while typed in, even when a reveal is 40 minutes out', JSON.stringify({ every, held }));
      await page.$eval('#remind-email', (i) => { i.value = ''; i.blur(); });
      await page.evaluate(() => document.body.focus());
      await refresh(page);
      const colinAll = await leadNow();
      ok(colinAll.startsWith("We'll email you about every reveal, Colin's included: when it gets a date"), '/live/: then the form names Colin and starts on every reveal, Colin\'s included', colinAll);
      await pickJust(page);
      const colin = await leadNow();
      ok(colin === "We'll email you about Colin's reveal: when we go live and when the replay is up. Nothing else, ever.", '/live/: "Just Colin\'s" names Colin in the promise, with only what can still be sent', colin);
      // Its button's keyboard ring shows on the cream page
      await page.focus('#remind-email');
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { cls: document.activeElement.className, outline: cs.outlineColor, shadow: cs.boxShadow }; });
      ok(/remind-btn/.test(ring.cls) && ring.outline === 'rgb(55, 58, 54)' && /255, 218, 36/.test(ring.shadow), '/live/: the Email me button’s keyboard ring is dark (with the yellow glow), plain on cream', JSON.stringify(ring));
      await page.close();
    }
  }

  // ── Round four (Nov 9): each kept from coming back ──
  // The line runs through the first and last dots exactly, rising rows or not, at every width
  for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]]) {
    const { page } = await open('/events/', { width, height });
    await page.evaluate(() => document.querySelector('#reveals .upn__list').scrollIntoView({ block: 'center' }));
    await wait(1800);
    const m = await page.evaluate(() => {
      const l = document.querySelector('#reveals .upn__list');
      const lr = l.getBoundingClientRect();
      const cs = getComputedStyle(l, '::before');
      const top = lr.top + parseFloat(cs.top);
      const bottom = top + parseFloat(cs.height);
      const dots = [...l.querySelectorAll('.upn-node')].map((n) => { const r = n.getBoundingClientRect(); return r.top + r.height / 2; });
      return { top: Math.round(top), first: Math.round(dots[0]), bottom: Math.round(bottom), last: Math.round(dots.at(-1)) };
    });
    ok(Math.abs(m.top - m.first) <= 1 && Math.abs(m.bottom - m.last) <= 1, `${width}px: the line starts and ends at the dots`, JSON.stringify(m));
    await page.close();
  }

  // The list rises in however tall the band is next to the screen (a landscape phone, 400% zoom)
  for (const [width, height, n] of [[667, 300, 12], [320, 150, 4]]) {
    const many = Array.from({ length: n }, (_, i) => ({ ...UPCOMING[i % UPCOMING.length], slug: `kid-${i}`, name: `Kid ${i + 1}` }));
    const { page } = await open('/events/', { width, height, upcoming: many });
    await page.evaluate(() => document.querySelector('#reveals .upn__list').scrollIntoView({ block: 'start' }));
    await wait(1500);
    const opacity = await page.$eval('#reveals .upn-row', (r) => getComputedStyle(r).opacity);
    ok(opacity === '1', `${width}x${height} with ${n} reveals: the list shows`, opacity);
    await page.close();
  }

  // Another year's month carries its year on its own line, clear of the dot
  {
    const d = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 8, 25));
    const sept = { ...kid('nora', 'Nora', ['Bedroom']), confirmed: false, window: { part: 'late', month: d.toISOString().slice(0, 7), through: d.toISOString().slice(0, 10), label: `late September ${d.getUTCFullYear()}` } };
    const { page } = await open('/events/', { upcoming: [sept, ...UPCOMING] });
    const r = await page.$eval('#reveals .upn-row[data-slug="nora"]', (row) => { const main = row.querySelector('.upn-when__main'); const node = row.querySelector('.upn-node'); return { main: main.textContent, sub: row.querySelector('.upn-when__sub')?.textContent, gap: Math.round(node.getBoundingClientRect().left - main.getBoundingClientRect().right) }; });
    ok(r.main === 'September' && /^\d{4}$/.test(r.sub || '') && r.gap >= 8, 'next year: "September" over its year, clear of the dot', JSON.stringify(r));
    await page.close();
  }

  // 320px: every card keeps its words and buttons inside it
  {
    const { page } = await open('/events/', { width: 320, height: 640 });
    const r = await page.evaluate(() => [...document.querySelectorAll('#reveals .upn-card')].map((c) => {
      const cr = c.getBoundingClientRect(); const pad = parseFloat(getComputedStyle(c).paddingRight);
      const inner = cr.right - pad;
      const add = c.querySelector('.upn-add').getBoundingClientRect(); const pill = c.querySelector('.upn-pill');
      return { addOver: Math.round(add.right - inner), pillOver: pill ? Math.round(pill.getBoundingClientRect().right - inner) : 0, pillOneLine: pill ? getComputedStyle(pill).whiteSpace === 'nowrap' : true };
    }));
    ok(r.every((x) => x.addOver <= 0 && x.pillOver <= 0 && x.pillOneLine), '320px: buttons inside the card, "Exact day to come" on one line', JSON.stringify(r));
    await page.close();
  }

  // The check never stays open under Sent (it asked again while the sign-up was on its way); the address can be
  // corrected while the check waits on a click, which calls that press off
  {
    const posts = [];
    const { page } = await open('/events/', { posts, turnstile: '0xTEST', checkSays: [{ ready: true }] });
    const fromCheck = (m) => page.evaluate((msg) => { const f = document.querySelector('#reveals [data-upn-mail-check] iframe'); window.dispatchEvent(new MessageEvent('message', { data: { type: 'soard-check', ...msg }, origin: location.origin, source: f.contentWindow })); }, m);
    await page.focus('#reveals-email');
    await wait(600);
    await page.type('#reveals-email', 'fan@exmaple.co');
    await fromCheck({ show: true }); // Cloudflare wants a click first
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(300);
    // Spots the typo while the check waits
    const ro = await page.$eval('#reveals-email', (i) => i.readOnly);
    await page.$eval('#reveals-email', (i) => { i.focus(); i.select(); });
    await page.keyboard.type('fan@example.com');
    await wait(200);
    const r = await page.evaluate(() => { const f = document.querySelector('#reveals [data-upn-mail-form]'); return { busy: f.classList.contains('is-busy'), note: f.querySelector('.remind-note').textContent, value: f.querySelector('input[name="email"]').value }; });
    ok(!ro && !r.busy && r.value === 'fan@example.com' && posts.length === 0, 'the address can be corrected while the check waits; that press is called off, nothing sent', JSON.stringify({ ro, ...r }));
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(200);
    await fromCheck({ token: 'tok-a' });
    await wait(50);
    await fromCheck({ show: true }); // the next token, fetched ahead, asks for a click while this one sends
    await page.waitForSelector('#reveals [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    await wait(200);
    const shown = await page.$eval('#reveals [data-upn-mail-check]', (b) => b.classList.contains('is-shown'));
    ok(posts.length === 1 && posts[0].email === 'fan@example.com' && !shown, 'sent the corrected address, and no check is left open under Sent', JSON.stringify({ posts, shown }));
    ok(await page.$eval('#reveals [data-upn-mail-form]', (f) => !f.hasAttribute('aria-busy')), 'the form is never marked busy (a screen reader would hold its news back)');
    await page.close();
  }

  // An empty box asks for an address
  {
    const { page } = await open('/events/');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(150);
    ok(await page.$eval('#reveals [data-upn-mail] .remind-note', (n) => n.textContent) === 'Enter your email address.', 'an empty box asks for an address');
    await page.close();
  }

  // Windows high contrast: the yellow buttons keep an edge (headless Chrome can't switch the mode on, so the rule is read)
  {
    const { page } = await open('/events/');
    const r = await page.evaluate(() => {
      const found = { band: false, btn: false };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (!(rule instanceof CSSMediaRule) || !/forced-colors:\s*active/.test(rule.conditionText)) continue;
          for (const inner of rule.cssRules) {
            if (/\.upn-cal__btn/.test(inner.selectorText) && /ButtonText/i.test(inner.style.borderTopColor || inner.cssText)) found.band = true;
            if (/^\.btn$/.test(inner.selectorText) && /ButtonText/i.test(inner.cssText)) found.btn = true;
          }
        }
      }
      return found;
    });
    ok(r.band && r.btn, 'high contrast: the band’s buttons and every .btn keep an edge', JSON.stringify(r));
    await page.close();
  }

  // The empty state on a tablet: one gap between the intro and the cards, not two
  {
    const { page } = await open('/events/', { width: 768, height: 1024, upcoming: [] });
    const gap = await page.evaluate(() => { const s = document.querySelector('#reveals'); return Math.round(s.querySelector('.upn-ways').getBoundingClientRect().top - s.querySelector('.upn__intro').getBoundingClientRect().bottom); });
    ok(gap === 36, 'events, nothing scheduled, 768px: one 36px gap before the cards', String(gap));
    await page.close();
  }

  // Drawn at build: the band, its rows and its card are in the HTML itself, so nothing jumps when the list arrives
  // and Back or a reload lands where the visitor was
  if (BUILT.length) {
    const html = await (await fetch(`${SITE}/events/`)).text();
    const band = html.slice(html.indexOf('id="reveals"') - 40, html.indexOf('</section>', html.indexOf('id="reveals"')));
    ok(!/\shidden[\s>]/.test(band.slice(0, band.indexOf('>'))) && (band.match(/class="upn-row/g) || []).length === BUILT.length && /data-upn-mail(?![^>]*hidden)/.test(band), 'events: the band, its rows and its email card are in the built page', `${(band.match(/class="upn-row/g) || []).length} rows`);
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      // The schedule answers late (2.5s) with what the build had: nothing on screen moves
      const p = await browser.newPage();
      await p.setViewport({ width, height });
      await p.evaluateOnNewDocument(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
      await p.setRequestInterception(true);
      p.on('request', (req) => {
        const u = new URL(req.url());
        if (u.pathname === '/api/reveals') return setTimeout(() => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ reveals: [], upcoming: BUILT, signup: SIGNUP_ON }) }), 2500);
        if (u.pathname.startsWith('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        if (u.hostname !== new URL(SITE).hostname) return req.abort();
        return req.continue();
      });
      await p.goto(`${SITE}/events/`, { waitUntil: 'domcontentloaded' });
      await wait(3500);
      const cls = await p.evaluate(() => window.__cls);
      ok(cls < 0.1, `events ${width}px: a late schedule moves nothing on screen (layout shift ${cls.toFixed(3)})`);
      // Scrolled past the band, then reload: back in the same place
      await p.evaluate(() => scrollTo(0, document.querySelector('#reveals').getBoundingClientRect().bottom + scrollY + 200));
      await wait(300);
      const y0 = await p.evaluate(() => scrollY);
      await p.reload({ waitUntil: 'domcontentloaded' });
      await wait(3500);
      const y1 = await p.evaluate(() => scrollY);
      ok(Math.abs(y1 - y0) <= 4, `events ${width}px: a reload lands where the visitor was`, `${y0} → ${y1}`);
      await p.close();
    }
    // A link to the band lands on it
    {
      const { page } = await open('/events/#reveals');
      const top = await page.$eval('#reveals', (s) => Math.round(s.getBoundingClientRect().top));
      ok(Math.abs(top) <= 90, 'events/#reveals lands on the band', String(top));
      await page.close();
    }
  } else {
    console.log('  – drawn-at-build checks skipped: this build had no reveals copy (src/data/upcoming-reveals.json is empty)');
  }

  // /live/: after a sign-up in the band, the page going idle leaves one list (the hero's), not two
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const live = { state: scheduled };
    const { page } = await open('/live/', { live });
    await pickJust(page);
    await page.type('#up-next-email', 'fan@example.com');
    await page.click('#up-next [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#up-next [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
    live.state = IDLE;
    await page.evaluate(() => window.__soardLiveClient.refresh());
    await wait(700);
    // (It stays while it's on screen; once the visitor has moved on, it goes)
    await page.evaluate(() => scrollTo(0, 0));
    await wait(900);
    const band = await page.$eval('.live-next', (n) => getComputedStyle(n).display);
    ok(band === 'none', '/live/: signed up in the band, then idle: once off screen the band steps aside for the hero’s list (one list, not two)', band);
    await page.close();
  }

  // /live/: sign-up switched off mid-typing (a schedule refresh) never takes the card from under someone
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const signup = { ...SIGNUP_ON };
    const { page } = await open('/live/', { state: scheduled, signup });
    await pickJust(page);
    await page.focus('#up-next-email');
    await page.keyboard.type('fan@exa');
    signup.email = false;
    // (the page keeps its schedule a minute: step past that, as a long visit would)
    await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 61_000; document.querySelector('#up-next').dispatchEvent(new Event('upnext:refresh')); });
    await wait(1500);
    const mid = await page.evaluate(() => ({ shown: document.querySelector('#up-next [data-upn-mail]').getBoundingClientRect().height > 0, focus: document.activeElement?.id }));
    await page.$eval('#up-next-email', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); });
    await wait(300);
    const after = await page.$eval('#up-next [data-upn-mail]', (m) => m.hidden);
    ok(mid.shown && mid.focus === 'up-next-email' && after, '/live/: switched off mid-typing, the card waits until it’s left, then goes', JSON.stringify({ mid, after }));
    await page.close();
  }

  // /live/ form: an edge you can see on cream, a readable address after Sent, and a phone layout like the band's
  {
    const { page } = await open('/live/', { width: 390, height: 844 });
    const r = await page.evaluate(() => { const i = document.querySelector('#remind-email'); const b = document.querySelector('[data-live="form-email"] button[type="submit"]'); return { border: getComputedStyle(i).borderTopColor, stacked: b.getBoundingClientRect().top > i.getBoundingClientRect().bottom - 1, full: Math.round(i.getBoundingClientRect().width) }; });
    ok(r.border === 'rgba(45, 46, 51, 0.6)' && r.stacked, '/live/ form: a visible edge, and on a phone the button under a full-width box', JSON.stringify(r));
    await page.type('#remind-email', 'fan@example.com');
    await page.click('[data-live="form-email"] button[type="submit"]');
    await page.waitForSelector('[data-live="form-email"].is-done', { timeout: 5000 }).catch(() => {});
    const done = await page.$eval('#remind-email', (i) => ({ color: getComputedStyle(i).color, opacity: getComputedStyle(i).opacity }));
    ok(done.color === 'rgb(90, 91, 97)' && done.opacity === '1', '/live/ form, Sent: the address stays readable (4.5:1, no fading)', JSON.stringify(done));
    await page.close();
  }

  // ── Round five (Nov 9): each kept from coming back ──
  // Spoken names begin with the words on screen (WCAG 2.5.3), and the calendar icon never squashes
  {
    const { page } = await open('/events/', { width: 320, height: 640 });
    const r = await page.evaluate(() => ({
      adds: [...document.querySelectorAll('#reveals .upn-add')].map((b) => b.getAttribute('aria-label')),
      watch: [...document.querySelectorAll('#reveals .upn-act')].map((a) => a.getAttribute('aria-label')),
      icons: [...document.querySelectorAll('#reveals .upn-add svg')].map((v) => Math.round(v.getBoundingClientRect().width)),
    }));
    ok(r.adds.every((l) => l.startsWith('Add to calendar: ')) && r.watch.every((l) => l.startsWith('Watch live: ')), 'spoken names begin with the words on the button', JSON.stringify(r));
    ok(r.icons.every((w) => w >= 15), '320px: the calendar icons keep their size', JSON.stringify(r.icons));
    await page.close();
  }

  // Times in the visitor's own zone, as the banner and the hero say them (Los Angeles: PST, not ET)
  {
    const { page } = await open('/events/', { tz: 'America/Los_Angeles' });
    const when = await page.$eval('#reveals .upn-row[data-state="confirmed"] .upn-when__sub', (p) => p.textContent);
    ok(/\b1:00 PM P[SD]T$/.test(when || ''), 'Los Angeles: the band gives the time where the visitor is', when);
    await page.close();
  }

  // Reduced motion: the button shows three still dots while it sends, not a frozen ring
  {
    const { page } = await open('/events/', { reduced: true, answer: () => 'hang' });
    await page.type('#reveals-email', 'fan@example.com');
    await page.click('#reveals [data-upn-mail] button[type="submit"]');
    await wait(300);
    const dots = await page.$eval('#reveals .btn-spinner', (sp) => ({ before: getComputedStyle(sp, '::before').content, border: getComputedStyle(sp).borderTopWidth }));
    ok(/•••/.test(dots.before) && dots.border === '0px', 'reduced motion: "•••" in the button while it sends', JSON.stringify(dots));
    await page.close();
  }

  // The button is off until the script wires it, and the form posts: an early Enter never puts the address in a link
  {
    const html = await (await fetch(`${SITE}/events/`)).text();
    const form = html.slice(html.indexOf('data-upn-mail-form') - 60, html.indexOf('</form>', html.indexOf('data-upn-mail-form')));
    ok(/method="post"/.test(form) && /type="submit" disabled/.test(form), 'in the built page: the form posts, its button starts off');
    const p = await browser.newPage();
    await p.setJavaScriptEnabled(false);
    await p.goto(`${SITE}/events/`, { waitUntil: 'domcontentloaded' });
    const had = await p.$('#reveals-email');
    if (had) {
      await p.type('#reveals-email', 'fan@example.com');
      await p.keyboard.press('Enter');
      await wait(800);
    }
    ok(!/email=/.test(p.url()), 'no script: Enter goes nowhere, the address never lands in the address bar', p.url());
    if (BUILT.length) ok(await p.$eval('#reveals .upn-row', (r) => getComputedStyle(r).opacity) === '1', 'no script: the rows the build drew are there to read');
    await p.close();
  }

  // A schedule that can't be read leaves the band as the build drew it
  if (BUILT.length) {
    const { page } = await open('/events/', { reveals: 'fail' });
    const r = await page.evaluate(() => { const s = document.querySelector('#reveals'); return { hidden: s.hidden, rows: s.querySelectorAll('.upn-row').length, mail: s.querySelector('[data-upn-mail]').getBoundingClientRect().height > 0 }; });
    ok(!r.hidden && r.rows > 0 && r.mail, 'events, /api/reveals failing: the band, its rows and its card stay', JSON.stringify(r));
    await page.close();
    // A changed name (or photo, or rooms) is drawn even when the date is the same
    const renamed = BUILT.map((x, i) => (i === 0 ? { ...x, name: `${x.name}ie`, rooms: ['Library'] } : x));
    const r2 = await open('/events/', { upcoming: renamed });
    const first = await r2.page.$eval('#reveals .upn-row .upn-card__name a', (a) => a.textContent);
    const rooms = await r2.page.$eval('#reveals .upn-row .upn-card__rooms', (p) => p.textContent);
    ok(first === renamed[0].name && rooms === 'Library', 'a renamed child (same date) is redrawn with the new name and rooms', JSON.stringify({ first, rooms }));
    await r2.page.close();
  }

  // /live/<kid>/ opens with that child's form, before the schedule answers (the build knew)
  if (BUILT.some((r) => r.slug === 'max')) {
    const posts = [];
    const { page } = await open('/live/max/', { revealsDelay: 4000, posts });
    const heading = await page.$eval('[data-live="remind-heading"]', (h) => h.textContent);
    ok(/Max's reveal/.test(heading || ''), '/live/max/: Max’s form from the start (no "every reveal" until the schedule comes)', heading);
    await page.close();
  }

  // /live/: the page form signs up for every reveal unless "Just Colin's" is picked, and the choice holds once sent
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    for (const just of [false, true]) {
      const posts = [];
      const { page } = await open('/live/', { state: scheduled, posts });
      if (just) await pickJust(page);
      const y0 = await page.$eval('#remind-email', (i) => Math.round(i.getBoundingClientRect().top));
      await page.type('#remind-email', 'fan@example.com');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-live="form-email"].is-done', { timeout: 5000 }).catch(() => {});
      ok(posts.length === 1 && (just ? posts[0].kidSlug === 'colin' : !posts[0].kidSlug), just ? '/live/: "Just Colin\'s" signs up for Colin\'s reveal' : '/live/: left as it is, the page form signs up for every reveal', JSON.stringify(posts));
      // Sent: the other choice can't change what was sent
      await page.evaluate((j) => document.querySelector(`input[name="remind-scope"][value="${j ? 'all' : 'one'}"]`).click(), just);
      await wait(300);
      const held = await page.evaluate(() => ({ picked: document.querySelector('input[name="remind-scope"]:checked')?.value, label: document.querySelector('[data-live="remind-email-label"]').textContent, off: document.querySelector('[data-live="remind-scope"]').getAttribute('aria-disabled') }));
      ok(held.off === 'true' && (just ? held.picked === 'one' && /Colin/.test(held.label) : held.picked === 'all' && /every reveal/.test(held.label)), '/live/: once sent, the choice it went with stays', JSON.stringify(held));
      await page.close();
    }
    // Switching the choice moves nothing on the page (both promises keep one height)
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const { page } = await open('/live/', { state: scheduled, width, height });
      const at = () => page.$eval('#remind-email', (i) => Math.round(i.getBoundingClientRect().top + scrollY));
      const y0 = await at();
      await pickJust(page);
      const y1 = await at();
      await page.evaluate(() => document.querySelector('input[name="remind-scope"][value="all"]').click());
      await wait(300);
      const y2 = await at();
      ok(y0 === y1 && y1 === y2, `/live/ ${width}px: picking every reveal or just Colin's never moves the form`, JSON.stringify({ y0, y1, y2 }));
      // Keyboard: the choice is two radios in one group, arrow keys move between them
      await page.focus('input[name="remind-scope"][value="all"]');
      await page.keyboard.press('ArrowRight');
      await wait(300);
      const k = await page.evaluate(() => ({ picked: document.querySelector('input[name="remind-scope"]:checked')?.value, label: document.querySelector('[data-live="remind-email-label"]').textContent }));
      ok(k.picked === 'one' && k.label === "Email address for Colin's reveal", `/live/ ${width}px: arrow keys pick between the two, and the form follows`, JSON.stringify(k));
      await page.close();
    }
  }

  // /live/: a one-child "Sent", then that child goes live: heading, label and who it signs up for move together
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const nowLive = { ...scheduled, phase: 'live', live: true, upcoming: false, liveAt: new Date().toISOString() };
    const posts = [];
    const live = { state: scheduled };
    const { page } = await open('/live/', { live, posts });
    // (A one-child sign-up: "Just Colin's")
    await pickJust(page);
    await page.type('#remind-email', 'fan@example.com');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-live="form-email"].is-done', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
    live.state = nowLive;
    await page.evaluate(() => window.__soardLiveClient.refresh());
    await wait(700);
    const r = await page.evaluate(() => ({ heading: document.querySelector('[data-live="remind-heading"]').textContent, label: document.querySelector('[data-live="remind-email-label"]').textContent, lead: document.querySelector('[data-live="remind-lead"]').textContent }));
    await page.click('[data-live="form-email"] button[type="submit"]');
    await wait(600);
    const second = posts[1] || {};
    const allEvery = !/Colin/.test(r.heading + r.label + r.lead);
    ok(allEvery && posts.length === 2 && !second.kidSlug, '/live/: when Colin goes live, the form says every reveal everywhere, and signs up for every reveal', JSON.stringify({ r, posts }));
    await page.close();
  }

  // /live/: a sign-up in the band keeps its confirmation when the broadcast moves on
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const replay = { ...IDLE, phase: 'replay', replay: true, id: 'live-0', kidSlug: 'abby', kidName: 'Abby', title: "Abby's room reveal", endedAt: day(-1).toISOString(), replayUntil: day(2).toISOString(), player: { kind: 'replay', uid: 'vid0', customerCode: 'x' } };
    const live = { state: scheduled };
    const { page } = await open('/live/', { live });
    await pickJust(page);
    await page.type('#up-next-email', 'fan@example.com');
    await page.click('#up-next [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#up-next [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    live.state = replay;
    await page.evaluate(() => window.__soardLiveClient.refresh());
    await wait(600);
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
    await wait(400);
    const r = await page.evaluate(() => { const m = document.querySelector('#up-next [data-upn-mail]'); return { shown: m.getBoundingClientRect().height > 0, note: m.querySelector('.remind-note').textContent }; });
    ok(r.shown && /You're on the list/.test(r.note), '/live/: the band’s "Done" stays when the broadcast moves on', JSON.stringify(r));
    await page.close();
  }

  // Coming back to /live/ (a reload) lands on what was on screen, though the page reorders once it knows the broadcast
  for (const [path, width, height, target] of [['/live/max/', 1366, 768, '#up-next'], ['/live/', 1366, 768, '#remind'], ['/live/', 390, 844, '#remind']]) {
    const { page } = await open(path, { width, height });
    await page.evaluate((sel) => { const el = document.querySelector(sel); scrollTo(0, el.getBoundingClientRect().top + scrollY - 140); }, target);
    await wait(500);
    const before = await page.$eval(target, (el) => Math.round(el.getBoundingClientRect().top));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(3000);
    const after = await page.$eval(target, (el) => Math.round(el.getBoundingClientRect().top));
    ok(Math.abs(after - before) <= 8, `${path} ${width}px: a reload lands where the visitor was (${target})`, `${before} → ${after}`);
    await page.close();
  }

  // ── Round six (Nov 9): each kept from coming back ──
  // The list rises in without waiting on the schedule (slow, or never answering), and on /live/ the reveal the page
  // is showing is left out from the start
  if (BUILT.length) {
    for (const delay of [6000, 600000]) {
      const { page } = await open('/events/', { revealsDelay: delay });
      await page.evaluate(() => document.querySelector('#reveals .upn__list').scrollIntoView({ block: 'center' }));
      await wait(1500);
      const op = await page.$eval('#reveals .upn-row', (r) => getComputedStyle(r).opacity);
      ok(op === '1', `events: the list shows while the schedule is ${delay > 10000 ? 'never answering' : 'slow (6s)'}`, op);
      await page.close();
    }
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const { page } = await open('/live/', { state: scheduled, revealsDelay: 600000 });
    await wait(800);
    const slugs = await page.$$eval('#up-next .upn-row', (rs) => rs.map((r) => r.dataset.slug));
    ok(!slugs.includes('colin') && slugs.length === BUILT.length - 1, '/live/ scheduled: the band leaves out Colin from the start, schedule or not', JSON.stringify(slugs));
    await page.close();
  }

  // A schedule refresh keeps keyboard focus on the same child's button
  {
    const { page } = await open('/events/');
    await page.focus('#reveals .upn-row[data-slug="max"] .upn-add');
    await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 61_000; });
    // Peter's reveal is called off
    await page.setRequestInterception(true).catch(() => {});
    await page.evaluate(() => {
      const realFetch = window.fetch;
      window.fetch = (u, o) => String(u).includes('/api/reveals') ? realFetch(u, o).then((r) => r.json()).then((d) => new Response(JSON.stringify({ ...d, upcoming: d.upcoming.filter((x) => x.slug !== 'peter') }), { headers: { 'Content-Type': 'application/json' } })) : realFetch(u, o);
      document.querySelector('#reveals').dispatchEvent(new Event('upnext:refresh'));
    });
    await wait(800);
    const r = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#reveals .upn-row')].map((x) => x.dataset.slug), focus: document.activeElement?.closest('.upn-row')?.dataset.slug, cls: document.activeElement?.className }));
    ok(!r.rows.includes('peter') && r.focus === 'max' && /upn-add/.test(r.cls || ''), 'a schedule change redraws the list and keyboard focus stays on Max’s Add to calendar', JSON.stringify(r));
    // A card's name link: one ring (round the card), none round the name
    await page.focus('#reveals .upn-row[data-slug="max"] .upn-card__name a');
    const ring = await page.$eval('#reveals .upn-row[data-slug="max"] .upn-card__name a', (a) => getComputedStyle(a).boxShadow);
    ok(ring === 'none', 'focus on a child’s name: the ring is round the card, not a second one round the name', ring);
    await page.close();
  }

  // A confirmed reveal next year says the year beside its day
  {
    const y = new Date().getUTCFullYear() + 1;
    const next = { ...kid('nora', 'Nora', ['Bedroom']), confirmed: true, startsAt: `${y}-01-08T21:00:00.000Z`, date: `${y}-01-08`, time: '16:00' };
    const { page } = await open('/events/', { upcoming: [...UPCOMING, next] });
    const main = await page.$eval('#reveals .upn-row[data-slug="nora"] .upn-when__main', (p) => p.textContent);
    ok(main === `Jan 8, ${y}`, 'a confirmed reveal next year: "Jan 8, <year>"', main);
    await page.close();
  }

  // Nothing scheduled and sign-up settings unreadable: no band promising email it can't take
  {
    const { page } = await open('/events/', { upcoming: [], signup: null });
    ok(await page.$eval('#reveals', (s) => s.hidden), 'events, nothing scheduled, sign-up unknown: no band');
    await page.close();
  }

  // No script: no controls that do nothing; "Add every reveal" is the calendar feed itself
  {
    const p = await browser.newPage();
    await p.setJavaScriptEnabled(false);
    await p.goto(`${SITE}/events/`, { waitUntil: 'domcontentloaded' });
    const r = await p.evaluate(() => {
      const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
      const s = document.querySelector('#reveals');
      return { mail: vis(s?.querySelector('[data-upn-mail]')), adds: [...(s?.querySelectorAll('.upn-add') || [])].some(vis), sheet: vis(s?.querySelector('[data-upn-cal] button[data-invite]')), feed: s?.querySelector('.upn-cal__nojs') && vis(s.querySelector('.upn-cal__nojs')) ? s.querySelector('.upn-cal__nojs').getAttribute('href') : null };
    });
    ok(!r.mail && !r.adds && !r.sheet && /^webcal:\/\/.+\/api\/reveals\.ics$/.test(r.feed || ''), 'no script: only working controls, and the calendar feed for every reveal', JSON.stringify(r));
    await p.close();
  }

  // /live/: signed up in the band, the page goes idle: the band stays while it's on screen, the page's own form shows
  // the sign-up (never asks again), and when the band goes, what's on screen stays put
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const live = { state: scheduled };
    const { page } = await open('/live/', { live, width: 1366, height: 657 });
    await pickJust(page);
    await page.evaluate(() => document.querySelector('#up-next [data-upn-mail]').scrollIntoView({ block: 'center' }));
    await page.type('#up-next-email', 'fan@example.com');
    await page.click('#up-next [data-upn-mail] button[type="submit"]');
    await page.waitForSelector('#up-next [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
    live.state = IDLE;
    await page.evaluate(() => window.__soardLiveClient.refresh());
    await wait(700);
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
    await wait(500);
    const mid = await page.evaluate(() => ({ band: getComputedStyle(document.querySelector('.live-next')).display !== 'none', note: document.querySelector('#up-next .remind-note').textContent, page: document.querySelector('[data-live="form-email"]').classList.contains('is-done') }));
    ok(mid.band && /You're on the list/.test(mid.note) && mid.page, '/live/ → idle after a band sign-up: the band stays on screen with its "Done", and the page form shows it too', JSON.stringify(mid));
    // Scroll down past it to the past reveals: the band goes, and what's on screen doesn't move
    await page.evaluate(() => document.querySelector('#past-reveals').scrollIntoView({ block: 'start' }));
    await wait(300);
    const y0 = await page.$eval('#past-reveals', (s) => Math.round(s.getBoundingClientRect().top));
    await wait(900);
    const after = await page.evaluate(() => ({ band: getComputedStyle(document.querySelector('.live-next')).display, y: Math.round(document.querySelector('#past-reveals').getBoundingClientRect().top) }));
    ok(after.band === 'none' && Math.abs(after.y - y0) <= 2, '/live/: once out of view the band goes (one list, the hero’s), and the screen holds still', JSON.stringify({ y0, ...after }));
    await page.close();
  }

  // ── Round seven (Nov 9): the four in the sign-up ──
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const nowLive = { ...scheduled, phase: 'live', live: true, upcoming: false, liveAt: new Date().toISOString() };
    const replay = { ...IDLE, phase: 'replay', replay: true, id: 'live-0', kidSlug: 'abby', kidName: 'Abby', title: "Abby's room reveal", endedAt: day(-1).toISOString(), replayUntil: day(2).toISOString(), player: { kind: 'replay', uid: 'vid0', customerCode: 'x' } };
    const refresh = (page) => page.evaluate(() => window.__soardLiveClient.refresh()).then(() => wait(600));
    // (1) On screen, the band's card doesn't vanish when the broadcast changes: nothing jumps under a finger
    for (const [width, height] of [[390, 844], [1366, 657]]) {
      const live = { state: scheduled };
      const { page } = await open('/live/', { live, width, height });
      await pickJust(page);
      await page.evaluate(() => document.querySelector('#up-next [data-upn-mail]').scrollIntoView({ block: 'center' }));
      await wait(400);
      const y0 = await page.$eval('#up-next [data-upn-cal] .upn-cal__btn', (b) => Math.round(b.getBoundingClientRect().top));
      live.state = nowLive;
      await refresh(page);
      const r = await page.evaluate(() => ({ card: getComputedStyle(document.querySelector('#up-next [data-upn-mail]')).display, cal: Math.round(document.querySelector('#up-next [data-upn-cal] .upn-cal__btn').getBoundingClientRect().top) }));
      ok(r.card !== 'none' && Math.abs(r.cal - y0) <= 1, `/live/ ${width}px: the broadcast going live doesn't pull the card from under someone looking at it`, JSON.stringify({ y0, ...r }));
      await page.close();
    }
    // (2) Signing up in the page's own every-reveal form doesn't bring back the band's card as a second "Sent"
    {
      const live = { state: replay };
      const { page } = await open('/live/', { live });
      await page.type('#remind-email', 'fan@example.com');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-live="form-email"].is-done', { timeout: 5000 }).catch(() => {});
      await wait(400);
      const card = await page.$eval('#up-next [data-upn-mail]', (m) => getComputedStyle(m).display);
      ok(card === 'none', '/live/ replay: a sign-up in the page form doesn’t bring the band’s card back with a second "Sent"', card);
      await page.close();
    }
    // (3) A sign-up in the band shows in the page form at once, heading and all (not on the next redraw)
    {
      const live = { state: scheduled };
      const { page } = await open('/live/', { live });
      await pickJust(page);
      await page.type('#up-next-email', 'fan@example.com');
      await page.click('#up-next [data-upn-mail] button[type="submit"]');
      await page.waitForSelector('#up-next [data-upn-mail-form].is-done', { timeout: 5000 }).catch(() => {});
      await wait(300);
      const at = await page.evaluate(() => ({ heading: document.querySelector('[data-live="remind-heading"]').textContent, done: document.querySelector('[data-live="form-email"]').classList.contains('is-done') }));
      await wait(16000); // past the 15s countdown redraw
      const later = await page.$eval('[data-live="remind-heading"]', (h) => h.textContent);
      ok(at.done && at.heading === later, '/live/: a band sign-up shows in the page form at once, and its heading doesn’t change on its own later', JSON.stringify({ at, later }));
      await page.close();
    }
    // (4) The live state failing fast: the every-reveal form at once, not after 5 seconds
    {
      const { page } = await open('/live/', { broadcast: 'fail' });
      const t0 = Date.now();
      await page.waitForFunction(() => { const f = document.querySelector('[data-live="form-email"]'); return f && !f.closest('[hidden]') && f.getBoundingClientRect().height > 0; }, { timeout: 8000 }).catch(() => {});
      const took = Date.now() - t0;
      ok(took < 2500, `/live/ with the live state failing at once: the sign-up shows in ${(took / 1000).toFixed(1)}s, not 5`);
      await page.close();
    }
  }

  // /live/: while the page's own form names a reveal, the band offers every reveal; when the page's form is already every reveal, the band leaves its card out
  {
    const scheduled = { ...IDLE, phase: 'scheduled', upcoming: true, id: 'live-1', kidSlug: 'colin', kidName: 'Colin', title: "Colin's room reveal", scheduledAt: confirmedAt.toISOString(), url: `${SITE}/live/colin/`, liveUrl: `${SITE}/live/colin/` };
    const { page, errors } = await open('/live/', { state: scheduled });
    await wait(400);
    const c0 = await card(page, '#up-next');
    const heading = await page.$eval('[data-live="remind-heading"]', (h) => h.textContent);
    const label0 = await page.$eval('[data-live="remind-email-label"]', (l) => l.textContent);
    const scope0 = await page.evaluate(() => [...document.querySelectorAll('[data-live="remind-scope"] label')].map((l) => l.textContent.trim() + (l.querySelector('input').checked ? '*' : '')));
    ok(heading === "Don't miss Colin's reveal" && label0 === 'Email address for every reveal' && !c0.shown && scope0.join('|') === "Every reveal*|Just Colin's",
      '/live/ scheduled: the page form names Colin and starts on every reveal, so the band leaves its card out', JSON.stringify({ heading, label0, scope0, c0 }));
    const ctas = await page.evaluate(() => [...document.querySelectorAll('.hero-ctas [data-live^="cta-"]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.textContent.trim()));
    ok(ctas.join('|') === 'Get every reveal by email|Add to calendar', '/live/ scheduled: two buttons in the hero, the every-reveal sign-up first', ctas.join(' | '));
    await pickJust(page);
    const c = await card(page, '#up-next');
    const label = await page.$eval('[data-live="remind-email-label"]', (l) => l.textContent);
    ok(label === "Email address for Colin's reveal" && c.shown, '/live/ scheduled: "Just Colin\'s" makes the page form Colin\'s, and the band offers every reveal', JSON.stringify({ label, c }));
    ok(await page.evaluate(() => new Set([...document.querySelectorAll('input[id]')].map((i) => i.id)).size === document.querySelectorAll('input[id]').length), '/live/: no repeated ids');
    ok(errors.length === 0, '/live/ scheduled: no console errors', errors.join(' | '));
    await page.close();
  }
  {
    const replay = { ...IDLE, phase: 'replay', replay: true, id: 'live-0', kidSlug: 'abby', kidName: 'Abby', title: "Abby's room reveal", endedAt: day(-1).toISOString(), replayUntil: day(2).toISOString(), player: { kind: 'replay', uid: 'vid0', customerCode: 'x' } };
    const { page } = await open('/live/', { state: replay });
    await wait(400);
    const c = await card(page, '#up-next');
    const heading = await page.$eval('[data-live="remind-heading"]', (h) => h.textContent);
    const band = await page.$eval('#up-next', (s) => ({ hidden: s.hidden, here: s.hasAttribute('data-remind-here') }));
    ok(heading === 'Hear about the next reveal' && band.here && !c.shown, '/live/ replay: the page form is already every reveal, so the band leaves its card out', JSON.stringify({ heading, band, c }));
    await page.close();
  }
}

// ── Events page, kid page, slate ──
{
  console.log('\n── events, kid page, slate ──');
  const { page, errors } = await open('/events/');
  const ev = await page.evaluate(() => { const s = document.querySelector('#reveals'); return { hidden: s?.hidden, rows: s?.querySelectorAll('.upn-row').length, title: s?.querySelector('h2')?.textContent }; });
  ok(ev.hidden === false && ev.rows === 4, 'events page lists the reveals', JSON.stringify(ev));
  ok(ev.title === 'Watch a room reveal live', 'with its own heading', ev.title);
  const evInv = await page.evaluate(() => ({ adds: [...document.querySelectorAll('#reveals .upn-add')].map((b) => b.dataset.invite), all: document.querySelector('#reveals [data-upn-cal] .upn-cal__btn')?.dataset.invite }));
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
