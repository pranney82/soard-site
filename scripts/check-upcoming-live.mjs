#!/usr/bin/env node
/**
 * check-upcoming-live.mjs — prove "Coming up" on the live site, real data
 * ======================================================================
 *   node scripts/check-upcoming-live.mjs            (production)
 *   SITE=https://… node scripts/check-upcoming-live.mjs
 *
 * Run after a deploy. Read-only: it only loads public pages and feeds.
 *   - /api/reveals answers with an upcoming list; tentative entries carry
 *     only early/mid/late <month> (no startsAt, date or time, no surname)
 *   - /api/reveals.ics is a calendar: CRLF, lines ≤ 75 octets, named, one
 *     event per confirmed reveal with its live link, no tentative kid in it;
 *     ?reveal= for a confirmed kid is a file, for a tentative kid a 404
 *   - in a browser: /live/ (the hero line and the list match the feed), each
 *     tentative kid's page badge, /kids/ cards, the events page, the home
 *     strip's date line, and the slate's "Coming up next" card
 *   - no console errors on any of them, no sideways scroll on a phone
 * Exits non-zero on any failure.
 */
import puppeteer from 'puppeteer';

const SITE = (process.env.SITE || 'https://sunshineonaranneyday.com').replace(/\/$/, '');
let failures = 0;
let passes = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const WINDOW = /^(early|mid|late) (January|February|March|April|May|June|July|August|September|October|November|December)( \d{4})?$/;

// ── The feed ──
console.log(`\n── ${SITE}/api/reveals ──`);
const res = await fetch(`${SITE}/api/reveals?check=${Date.now()}`);
const body = await res.json();
const upcoming = Array.isArray(body.upcoming) ? body.upcoming : null;
ok(res.ok && upcoming, 'answers with an upcoming list', `${res.status} source=${body.source}`);
ok(body.source === 'jobtread' || body.source === 'cache', `read from JobTread or its copy (${body.source}${body.error ? `: ${body.error}` : ''})`);
ok(!('past' in body), 'the calendar-only past list stays out');
const tentative = (upcoming || []).filter((r) => !r.confirmed);
const confirmed = (upcoming || []).filter((r) => r.confirmed);
console.log(`    ${confirmed.length} confirmed, ${tentative.length} tentative: ${(upcoming || []).map((r) => `${r.name} (${r.confirmed ? `${r.date} ${r.time || ''}`.trim() : r.window?.label})`).join(', ') || 'none'}`);
ok(tentative.every((r) => WINDOW.test(r.window?.label || '') && !('startsAt' in r) && !('date' in r) && !('time' in r)), 'tentative reveals carry only their window');
ok((upcoming || []).every((r) => /^[A-Z][^()]*$/.test(r.name) && !/\(\d{4}\)/.test(r.name)), 'names are kid names, never JobTread job names');
ok(confirmed.every((r) => (body.reveals || []).some((x) => x.slug === r.slug)), 'every confirmed one is in the confirmed list too');

console.log(`\n── ${SITE}/api/reveals.ics ──`);
const ics = await fetch(`${SITE}/api/reveals.ics`);
const raw = Buffer.from(await ics.arrayBuffer());
const text = raw.toString('utf8');
ok(ics.ok && /^text\/calendar/.test(ics.headers.get('content-type') || ''), 'served as a calendar', `${ics.status} ${ics.headers.get('content-type')}`);
ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.trimEnd().endsWith('END:VCALENDAR'), 'a whole calendar');
ok(!text.replace(/\r\n/g, '').includes('\n'), 'CRLF line ends only');
ok(text.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75), 'every line ≤ 75 octets');
const unfolded = text.replace(/\r\n /g, '');
ok(unfolded.includes('X-WR-CALNAME:Sunshine on a Ranney Day reveals'), 'named for the calendar list');
for (const r of confirmed) {
  ok(unfolded.includes(`UID:live-reveal-${r.slug}@sunshineonaranneyday.com`) && unfolded.includes(`URL:${SITE.replace(/^http:/, 'https:')}/live/${r.slug}/`), `${r.name}: in the calendar with the live link`);
}
for (const r of tentative) ok(!unfolded.includes(`live-reveal-${r.slug}@`), `${r.name} (tentative): not in the calendar`);
if (confirmed[0]) {
  const one = await fetch(`${SITE}/api/reveals.ics?reveal=${confirmed[0].slug}`);
  ok(one.ok && /attachment/.test(one.headers.get('content-disposition') || ''), `${confirmed[0].name}: its own calendar file`);
}
if (tentative[0]) {
  const none = await fetch(`${SITE}/api/reveals.ics?reveal=${tentative[0].slug}`);
  ok(none.status === 404, `${tentative[0].name} (tentative): no calendar file yet`, String(none.status));
}

// ── The pages ──
const browser = await puppeteer.launch({ headless: 'new', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
async function open(path, { width = 1440, height = 900 } = {}) {
  const page = await browser.newPage();
  const phone = width < 600;
  await page.setViewport({ width, height, isMobile: phone, hasTouch: phone });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(800);
  return { page, errors };
}

for (const width of [1440, 390]) {
  console.log(`\n── /live/ at ${width}px ──`);
  const { page, errors } = await open('/live/', { width, height: width < 600 ? 844 : 900 });
  const r = await page.evaluate(() => ({
    view: document.querySelector('.live-page')?.dataset.view,
    status: document.querySelector('[data-live="status"]')?.textContent || '',
    hidden: document.querySelector('#up-next')?.hidden,
    names: [...document.querySelectorAll('#up-next .upn-card__name')].map((n) => n.textContent),
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  if (r.view === 'idle') {
    const next = upcoming?.[0];
    ok(next ? r.status.startsWith(`Next up: ${next.name}'s reveal, `) : /^No reveal is scheduled/.test(r.status), 'the hero line matches the feed', r.status);
    ok(JSON.stringify(r.names) === JSON.stringify((upcoming || []).map((x) => x.name)), 'the list matches the feed, in order', JSON.stringify(r.names));
  } else {
    ok(true, `a reveal is on (${r.view}); the list leaves it out: ${JSON.stringify(r.names)}`);
  }
  ok(upcoming?.length ? r.hidden === false : r.hidden === true, upcoming?.length ? 'the section shows' : 'no section with nothing coming up');
  ok(r.sideways <= 0, 'no sideways scroll');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
  await page.close();
}

console.log('\n── kid pages, /kids/, events, home, slate ──');
for (const r of tentative.slice(0, 3)) {
  const { page, errors } = await open(r.kidUrl);
  const badge = await page.evaluate(() => ({ badge: document.querySelector('[data-kid-reveal-badge]')?.textContent, link: document.querySelector('.hero__reveal-day')?.textContent }));
  ok(/^Reveal (early|mid|late) [A-Z][a-z]{2}$/.test(badge.badge || '') && badge.link === `Reveal planned for ${r.window.label}`, `${r.name}'s page: ${badge.badge} / ${badge.link}`);
  ok(errors.length === 0, `${r.name}'s page: no console errors`, errors.join(' | '));
  await page.close();
}
{
  const { page, errors } = await open('/kids/');
  const cards = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('a.kid-card')].filter((a) => a.querySelector('.kid-card__badge--building')).map((a) => [a.getAttribute('href'), a.querySelector('.kid-card__badge--building').textContent.trim()])));
  const dated = (upcoming || []).filter((r) => cards[r.kidUrl]);
  ok(dated.every((r) => cards[r.kidUrl] !== 'Building'), `/kids/: ${dated.length} in-build cards show their reveal timing`, JSON.stringify(cards));
  ok(errors.length === 0, '/kids/: no console errors', errors.join(' | '));
  await page.close();
}
{
  const { page, errors } = await open('/events/');
  const ev = await page.evaluate(() => ({ hidden: document.querySelector('#reveals')?.hidden, rows: document.querySelectorAll('#reveals .upn-row').length }));
  ok(upcoming?.length ? ev.hidden === false && ev.rows === upcoming.length : ev.hidden === true, `events page: ${ev.rows} reveals`);
  ok(errors.length === 0, 'events page: no console errors', errors.join(' | '));
  await page.close();
}
{
  const { page, errors } = await open('/');
  const line = await page.evaluate(() => { const el = document.querySelector('.upnext-date'); return { text: el?.textContent, kid: el?.dataset.revealKid || null }; });
  const r = (upcoming || []).find((x) => x.slug === line.kid);
  if (line.kid) ok(r ? (r.confirmed ? /^Reveal \w+day, \w+ \d{1,2}$/.test(line.text) : line.text === `Reveal ${r.window.label}`) : line.text === 'Reveal coming soon', `home Up Next: "${line.text}"`);
  else ok(true, `home Up Next: staff's own date line or not a build ("${line.text}")`);
  ok(errors.length === 0, 'home: no console errors', errors.join(' | '));
  await page.close();
}
{
  const { page, errors } = await open('/live/slate/?music=0&still=1', { width: 960, height: 540 });
  await wait(1500);
  const s = await page.evaluate(() => ({ shown: !document.querySelector('[data-card="next"]')?.hidden, items: [...document.querySelectorAll('[data-next-list] li')].map((l) => l.textContent) }));
  ok(upcoming?.length ? s.shown && s.items.length === Math.min(3, upcoming.length) : !s.shown, `slate: "Coming up next" ${JSON.stringify(s.items)}`);
  ok(errors.length === 0, 'slate: no console errors', errors.join(' | '));
  await page.close();
}

await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
