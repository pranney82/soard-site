/**
 * The application bar above the menu: what it says, where it shows, who it
 * stays away from, and the X that closes it for the season.
 * functions/_apply-bar.js, functions/api/application-bar-closed.js,
 * src/components/global/ApplicationBar.astro
 * Run: node --test tests/apply-bar.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { closeDay, barWords, barSkips, barDismissed, barFor, BAR_COOKIE, BAR_STORAGE_KEY } from '../functions/_apply-bar.js';
import { onRequestGet as barClosed } from '../functions/api/application-bar-closed.js';

const year = String(new Date().getUTCFullYear() + 1);
const NOW = Date.parse('2026-11-07T15:00:00Z');
const dbWith = (application) => ({ prepare: () => ({ first: async () => ({ data: JSON.stringify({ application }) }) }) });
const ctx = (application, cookie = '') => ({
  env: { DB: dbWith(application) },
  request: new Request('https://example.org/kids/', { headers: cookie ? { Cookie: cookie } : {} }),
  waitUntil() {},
});

test('the close day reads in Atlanta time, and a midnight close is the day before', () => {
  // Midnight Eastern on Feb 1 is the end of Jan 31
  assert.deepEqual(closeDay('2027-02-01T05:00:00.000Z', NOW), { long: 'January 31', short: 'Jan 31' });
  // 11:59 PM Eastern on Jan 31 is still Jan 31, though it's Feb 1 in UTC
  assert.deepEqual(closeDay('2027-02-01T04:59:00.000Z', NOW), { long: 'January 31', short: 'Jan 31' });
  // Noon Eastern
  assert.deepEqual(closeDay('2027-01-15T17:00:00.000Z', NOW), { long: 'January 15', short: 'Jan 15' });
  assert.equal(closeDay('', NOW), null);
  assert.equal(closeDay('not a date', NOW), null);
  assert.equal(closeDay('2026-11-01T00:00:00Z', NOW), null, 'a close time already past says nothing');
});

test('the words: the season, the sentence, the close day when there is one', () => {
  const plain = barWords({ year: '2027' }, NOW);
  assert.equal(plain.label, '2027 application');
  assert.equal(plain.msg, 'Now open for room makeovers in the greater Atlanta area.');
  assert.equal(plain.short, 'Now open');
  assert.equal(plain.aria, '2027 application. Now open for room makeovers in the greater Atlanta area. Apply.');
  const dated = barWords({ year: '2027', closesAt: '2027-02-01T05:00:00.000Z' }, NOW);
  assert.equal(dated.msg, 'Now open for room makeovers in the greater Atlanta area, through January 31.');
  assert.equal(dated.short, 'Open through Jan 31');
  for (const w of [plain, dated]) for (const v of Object.values(w)) assert.doesNotMatch(String(v), /—/, 'no em dashes in site words');
});

test('pages where someone is doing something never get it', () => {
  for (const p of ['/apply/', '/apply', '/apply/form/', '/apply/community-project/', '/donate/', '/trade-partners/', '/trade-partners/account/', '/advisory-board/apply/', '/profile-update/', '/admin/', '/api/application-open']) {
    assert.equal(barSkips(p), true, p);
  }
  for (const p of ['/', '/kids/', '/kids/max/', '/reveals/', '/faq/', '/about/financials/', '/advisory-board/', '/live/', '/application-tips/', '/applyx/']) {
    assert.equal(barSkips(p), false, p);
  }
});

test('the X: remembered for the season in a cookie the server reads', async () => {
  const res = await barClosed({ request: new Request(`https://example.org/api/application-bar-closed?year=${year}`) });
  assert.equal(res.status, 204);
  const set = res.headers.get('Set-Cookie');
  assert.match(set, new RegExp(`^${BAR_COOKIE}=${year}; Path=/; Max-Age=31536000; SameSite=Lax; Secure$`));
  assert.equal((await barClosed({ request: new Request('https://example.org/api/application-bar-closed?year=1999') })).status, 400);
  assert.equal((await barClosed({ request: new Request('https://example.org/api/application-bar-closed?year=<x>') })).status, 400);
  const mw = readFileSync('functions/api/_middleware.js', 'utf8').match(/const PUBLIC_GET_ROUTES = \[(.*?)\]/s)[1];
  assert.ok(mw.includes("'/api/application-bar-closed'"), 'anyone can close it');
});

test('the cookie closes that season only', () => {
  const req = (cookie) => new Request('https://example.org/', { headers: { Cookie: cookie } });
  assert.equal(barDismissed(req(`a=1; ${BAR_COOKIE}=2027; b=2`), '2027'), true);
  assert.equal(barDismissed(req(`${BAR_COOKIE}=2026`), '2027'), false, "last season's close is not this one's");
  assert.equal(barDismissed(req(`x${BAR_COOKIE}=2027`), '2027'), false);
  assert.equal(barDismissed(new Request('https://example.org/'), '2027'), false);
});

test('the server shows it only while open, not to someone who closed it, never on a task page', async () => {
  const words = await barFor(ctx({ open: true, year }), '/kids/');
  assert.equal(words.label, `${year} application`);
  assert.equal(await barFor(ctx({ open: false, year }), '/kids/'), null, 'closed');
  assert.equal(await barFor(ctx({ open: 'true', year }), '/kids/'), null, 'only a real true is open');
  assert.equal(await barFor(ctx({ open: true, year }, `${BAR_COOKIE}=${year}`), '/kids/'), null, 'closed by this visitor');
  assert.ok(await barFor(ctx({ open: true, year }, `${BAR_COOKIE}=2020`), '/kids/'), "an old season's close does not count");
  assert.equal(await barFor(ctx({ open: true, year }), '/donate/'), null, 'a task page');
});

// Every page section has a decision, and the ones that show it run the bar
const SHOW = ['about', 'advisory-board', 'community', 'events', 'faq', 'how-it-works', 'kids', 'partners', 'privacy-policy', 'publicity', 'resources', 'reveals', 'terms', 'ways-to-give'];
const SKIP = ['404', '[book]', 'admin', 'api', 'apply', 'book-version.json', 'branding', 'donate', 'llms-full.txt', 'llms.txt', 'og', 'profile-update', 'sunny-and-ranney', 'trade-partners'];
const SPECIAL = ['index', 'live']; // home: functions/index.js; live: functions/live/[[path]].js

test('every page section is decided: the bar runs where it shows and nowhere else', () => {
  const sections = [...new Set(readdirSync('src/pages').map((f) => f.replace(/\.(astro|ts)$/, '')))];
  for (const s of sections) assert.ok([...SHOW, ...SKIP, ...SPECIAL].includes(s), `src/pages/${s}: decide whether it shows the application bar`);
  const usesBar = (file) => existsSync(file) && /applyBarMiddleware/.test(readFileSync(file, 'utf8'));
  for (const s of SHOW) assert.ok(usesBar(`functions/${s}/_middleware.js`), `functions/${s}/_middleware.js runs the bar`);
  for (const s of SKIP) assert.ok(!usesBar(`functions/${s}/_middleware.js`) && !usesBar(`functions/${s}/index.js`), `${s} has no bar`);
  assert.ok(usesBar('functions/index.js'), 'the home page runs the bar');
  assert.match(readFileSync('functions/live/[[path]].js', 'utf8'), /party\.mode === 'starting' \|\| party\.mode === 'live'/, 'live: never while a reveal is starting or live');
});

test('the built page carries an empty, hidden bar: nothing says open until the server does', () => {
  const src = readFileSync('src/components/global/ApplicationBar.astro', 'utf8');
  const aside = src.match(/<aside id="apply-bar"[^>]*>([\s\S]*?)<\/aside>/);
  assert.ok(aside, 'the bar');
  assert.match(aside[0], /<aside id="apply-bar"[^>]*\shidden[\s>]/);
  for (const part of ['label', 'msg', 'short']) assert.match(aside[1], new RegExp(`<span class="apply-bar__${part}"></span>`), `${part} is empty`);
  assert.doesNotMatch(aside[1], /open|2027|application/i);
  assert.match(src, /\.apply-bar\[hidden\][^{]*\{ display: none !important; \}/, 'hidden means hidden');
  // The page script and the server agree on how a close is remembered
  assert.ok(src.includes(`'${BAR_STORAGE_KEY}'`) && src.includes(`'${BAR_COOKIE}'`));
  assert.ok(src.includes(`soard_apply_bar=`) && src.includes(`localStorage.getItem('${BAR_STORAGE_KEY}')`), 'the inline check reads both');
});

test("the top spot is the auction's on its day", () => {
  const layout = readFileSync('src/layouts/BaseLayout.astro', 'utf8');
  assert.match(layout, /<AuctionBar \/>\s*\{[^}]*\}\s*\{!auctionIsOpen\(\) && <ApplicationBar \/>\}\s*<Header \/>/);
});
