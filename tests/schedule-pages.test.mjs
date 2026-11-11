/**
 * /reveals/ and /events/ go out with the reveal schedule already drawn (functions/_schedule-pages.js): the Coming up
 * band (./_upcoming-band.js), its "Get every reveal by email" card, and the /reveals/ hero (./_reveals-hero.js), each
 * the way the page script would leave it, so nothing on the page moves after load.
 * Node has no HTMLRewriter: the handlers run here on stand-in elements that record what they're given.
 * Run: node --test tests/schedule-pages.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const load = (entry) => import(`data:text/javascript,${encodeURIComponent(buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].text)}#${Math.random()}`);
const { bandFor, onBands } = await load('functions/_upcoming-band.js');
const { nextShown, onRevealsHero } = await load('functions/_reveals-hero.js');
const { drawSchedule, schedulePagesMiddleware } = await load('functions/_schedule-pages.js');
const { bandRowsHtml, bandShows } = await load('src/utils/band-rows.ts');
const { rowsSignature } = await load('src/utils/upcoming-rows.ts');
const { signupOf, scheduleOnPage } = await load('src/utils/reveals-client.ts');
const { showingKid } = await load('functions/live/[[path]].js');
const { scheduleAttr } = await load('functions/_kid-reveal.js');
const { remindPromise } = await load('src/utils/live-banner.ts');

const max = { slug: 'max', name: 'Max', confirmed: true, date: '2026-11-20', time: '15:00', startsAt: '2026-11-20T20:00:00.000Z', image: '/cdn-cgi/imagedelivery/h/max-photo/public', rooms: ['Bedroom'], liveUrl: '/live/max/', kidUrl: '/kids/max/', window: null };
const colin = { slug: 'colin', name: "Colin O'Neil", confirmed: false, date: null, time: null, startsAt: null, image: null, rooms: [], liveUrl: '/live/colin/', kidUrl: '/kids/colin/', window: { part: 'early', month: '2026-12', through: '2026-12-10', label: 'early December' } };
const ON = { email: true, hours: [24, 1] };
const OFF = { email: false, hours: [24, 1] };

/** An element as HTMLRewriter hands it over, recording what's done to it */
class El {
  constructor(attrs = {}) { this.attrs = new Map(Object.entries(attrs)); this.content = null; this.added = null; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  hasAttribute(n) { return this.attrs.has(n); }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  setInnerContent(c, o) { this.content = { text: c, html: !!o?.html }; }
  onEndTag(fn) { fn({ before: (html, o) => { this.added = { html, asHtml: !!o?.html }; } }); }
}
/** The handlers, by selector; elements are given to them in document order, as the rewriter does */
class Rw {
  constructor() { this.handlers = []; }
  on(selector, h) { this.handlers.push([selector, h]); return this; }
  el(selector, attrs) { const e = attrs instanceof El ? attrs : new El(attrs); for (const [s, h] of this.handlers) if (s === selector) h.element(e); return e; }
}
/** One band as the build drew it: the section, then its list, its "See every reveal", its email card and its notes */
function band(rw, attrs = {}, mailAttrs = {}) {
  const section = rw.el('[data-upnext]', { 'data-upnext': '', 'data-exclude': '', ...attrs });
  return {
    section,
    list: rw.el('[data-upnext] [data-upn-list]', { 'data-upn-list': '', 'data-sig': 'build' }),
    more: rw.el('[data-upnext] [data-upn-more]', { 'data-upn-more': '' }),
    mail: rw.el('[data-upnext] [data-upn-mail]', { 'data-upn-mail': '', ...mailAttrs }),
    lead: rw.el('[data-upnext] [data-upn-mail-lead]', {}),
  };
}

test('the sign-up setting reads the same on the server and in the page script', () => {
  assert.deepEqual(signupOf({ email: true, hours: [24, 1, 6] }), { email: true, hours: [24, 1] });
  assert.deepEqual(signupOf({ email: false }), { email: false, hours: [24, 1] });
  assert.equal(signupOf(null), null);
  assert.equal(signupOf({ email: 'yes' }), null, 'not said plainly: not known');
  const client = readFileSync('src/utils/reveals-client.ts', 'utf8');
  assert.match(client, /signup: signupOf\(body\?\.signup\)/, 'the page script reads it by signupOf');
  assert.match(readFileSync('functions/_kid-reveal.js', 'utf8'), /signup: signupOf\(body\.signup\)/, 'and so does the server');
});

test('whether a band shows: anything scheduled, or a band kept for sign-ups while they may be open', () => {
  assert.equal(bandShows(2, false, OFF), true);
  assert.equal(bandShows(0, false, ON), false);
  assert.equal(bandShows(0, true, ON), true);
  assert.equal(bandShows(0, true, undefined), true, 'not read yet: stays');
  assert.equal(bandShows(0, true, null), false, 'not said: goes');
  assert.equal(bandShows(0, true, OFF), false);
  // The page script decides by the same rule, from the setting the server left on the band
  const page = readFileSync('src/components/live/UpcomingReveals.astro', 'utf8');
  assert.match(page, /section\.hidden = !bandShows\(shown\.length, keepEmpty, signup\)/);
  assert.match(page, /let signup: Signup \| null \| undefined = edge\?\.signup;/);
});

test('a band: the schedule less its own child, its rows in the visitor\'s zone, and "See every reveal" when there\'s more', () => {
  const b = bandFor([max, colin], { exclude: ['colin', ''], limit: 1, tz: 'America/Chicago' });
  assert.deepEqual(b.shown, [max]);
  assert.equal(b.html, bandRowsHtml([max], { limit: 1, tz: 'America/Chicago' }));
  assert.match(b.html, /2:00 PM/, 'Chicago time, an hour behind Eastern');
  assert.equal(b.sig, rowsSignature([max], 'America/Chicago'));
  assert.equal(b.moreHidden, true);
  assert.equal(bandFor([max, colin], { limit: 1, tz: 'America/New_York' }).moreHidden, false);
});

test('the band goes out drawn, with what it was drawn from for the page script to start from', () => {
  const rw = onBands(new Rw(), { upcoming: [max, colin], signup: ON }, 'America/New_York');
  const b = band(rw, { 'data-exclude': 'max', 'data-limit': '3', 'data-empty': '', hidden: '' });
  assert.deepEqual(JSON.parse(b.section.getAttribute('data-schedule')), { upcoming: [max, colin], signup: ON });
  // read back on the page as the server wrote it
  assert.deepEqual(scheduleOnPage({ dataset: { schedule: b.section.getAttribute('data-schedule') } }), { upcoming: [max, colin], signup: ON });
  assert.equal(b.section.hasAttribute('hidden'), false);
  assert.equal(b.section.hasAttribute('data-empty'), false);
  assert.deepEqual(b.list.content, { text: bandRowsHtml([colin], { limit: 3, tz: 'America/New_York' }), html: true });
  assert.equal(b.list.getAttribute('data-sig'), rowsSignature([colin], 'America/New_York'));
  assert.equal(b.more.hasAttribute('hidden'), true);
  // The band's script starts from it
  assert.match(readFileSync('src/components/live/UpcomingReveals.astro', 'utf8'), /const edge = scheduleOnPage\(section\);\s+let all = edge\?\.upcoming \?\? upcomingAtBuild\(\);/);
});

test('the email card: in, with its notes, while sign-ups are open; out when they\'re off or not said', () => {
  const open = band(onBands(new Rw(), { upcoming: [max], signup: { email: true, hours: [24] } }, 'America/New_York'), {}, { hidden: '' });
  assert.equal(open.mail.hasAttribute('hidden'), false);
  assert.deepEqual(open.lead.content, { text: remindPromise([24]), html: false }, 'the notes, as text');
  assert.doesNotMatch(open.lead.content.text, /an hour before/);
  const off = band(onBands(new Rw(), { upcoming: [max], signup: OFF }, 'America/New_York'), {});
  assert.equal(off.mail.hasAttribute('hidden'), true);
  assert.deepEqual(off.lead.content, { text: remindPromise([24, 1]), html: false });
  const unsaid = band(onBands(new Rw(), { upcoming: [max], signup: null }, 'America/New_York'), {});
  assert.equal(unsaid.mail.hasAttribute('hidden'), true, 'the page script takes it out too (apply(null))');
  assert.equal(unsaid.lead.content, null, 'its notes left as built');
});

test('nothing scheduled: a band goes, and one kept for sign-ups stays only while they may be open', () => {
  const gone = band(onBands(new Rw(), { upcoming: [], signup: ON }, 'America/New_York'), {});
  assert.equal(gone.section.hasAttribute('hidden'), true);
  assert.equal(gone.section.hasAttribute('data-empty'), true);
  const kept = band(onBands(new Rw(), { upcoming: [], signup: ON }, 'America/New_York'), { 'data-keep-empty': '' });
  assert.equal(kept.section.hasAttribute('hidden'), false);
  assert.equal(kept.section.hasAttribute('data-empty'), true);
  const off = band(onBands(new Rw(), { upcoming: [max], signup: OFF }, 'America/New_York'), { 'data-keep-empty': '', 'data-exclude': 'max' });
  assert.equal(off.section.hasAttribute('hidden'), true, 'its only reveal is its own child, and sign-ups are off');
});

test('the /reveals/ hero: the next reveal, in the visitor\'s zone, with their photo', () => {
  const n = nextShown(max, 'America/Chicago', 'https://example.org');
  assert.equal(n.when, 'Friday, November 20 at 2:00 PM CST');
  assert.equal(n.href, '/live/max/');
  assert.equal(n.img.alt, 'Max, whose room reveal is next');
  assert.match(n.img.src, /^https:\/\/example\.org\/cdn-cgi\/image\/|max-photo/);
  assert.equal(nextShown(colin, 'America/Chicago', 'https://example.org').when, 'early December');
  assert.equal(nextShown(null), null);

  const rw = onRevealsHero(new Rw(), [max], 'America/Chicago', 'https://example.org', ON);
  const signup = rw.el('[data-rh-signup]', { href: '#up-next-mail' });
  assert.equal(signup.getAttribute('href'), '#up-next-mail', 'sign-ups open: to the band\'s card');
  const frame = rw.el('[data-rh]', { 'data-sizes': '(max-width: 475px) 80vw, 420px', 'data-mode': 'latest' });
  assert.equal(frame.getAttribute('data-mode'), 'next');
  const when = rw.el('[data-rh-when]', { hidden: '', href: '/live/' });
  assert.equal(when.hasAttribute('hidden'), false);
  assert.equal(when.getAttribute('href'), '/live/max/');
  assert.equal(rw.el('[data-rh-when-name]', {}).content.text, 'Max');
  assert.equal(rw.el('[data-rh-when-time]', {}).content.text, 'Friday, November 20 at 2:00 PM CST');
  // The build had no photo for the link: it goes in at the link's end, at the frame's sizes
  const link = rw.el('[data-rh-next]', { href: '/live/' });
  assert.equal(link.getAttribute('href'), '/live/max/');
  assert.equal(link.added.asHtml, true);
  assert.match(link.added.html, /^<img src="[^"]+" srcset="[^"]+" sizes="\(max-width: 475px\) 80vw, 420px" alt="Max, whose room reveal is next" width="640" height="800" decoding="async" data-rh-next-img data-slug="max">$/);
});

test('the hero keeps the build\'s photo of the same child, and puts in the next child\'s over another', () => {
  const same = onRevealsHero(new Rw(), [max], 'America/New_York', 'https://example.org', ON);
  same.el('[data-rh]', { 'data-sizes': '420px' });
  const link = new El({});
  const img = same.el('[data-rh-next-img]', { src: 'built.jpg', alt: 'Max, whose room reveal is next' });
  // its end tag comes after the img inside it
  for (const [s, h] of same.handlers) if (s === '[data-rh-next]') h.element(link);
  assert.equal(img.getAttribute('src'), 'built.jpg');
  assert.equal(link.added, null, 'no second photo');
  const other = onRevealsHero(new Rw(), [max], 'America/New_York', 'https://example.org', ON);
  other.el('[data-rh]', { 'data-sizes': '420px' });
  const old = other.el('[data-rh-next-img]', { src: 'abby.jpg', alt: 'Abby, whose room reveal is next', 'data-slug': 'abby' });
  assert.notEqual(old.getAttribute('src'), 'abby.jpg');
  assert.equal(old.getAttribute('alt'), 'Max, whose room reveal is next');
  assert.equal(old.getAttribute('data-slug'), 'max');
  assert.equal(old.getAttribute('sizes'), '420px');
});

test('nothing planned: the line goes and the latest video shows; sign-ups off send its button to the live page\'s form', () => {
  const rw = onRevealsHero(new Rw(), [], 'America/New_York', 'https://example.org', OFF);
  assert.equal(rw.el('[data-rh-when]', {}).hasAttribute('hidden'), true);
  assert.equal(rw.el('[data-rh]', { 'data-has-latest': '', 'data-mode': 'next' }).getAttribute('data-mode'), 'latest');
  assert.equal(rw.el('[data-rh]', { 'data-mode': 'next' }).getAttribute('data-mode'), 'next', 'no video: the photo the build drew');
  assert.equal(rw.el('[data-rh-signup]', { href: '#up-next-mail' }).getAttribute('href'), '/live/#remind');
  assert.equal(onRevealsHero(new Rw(), [], 'America/New_York', 'https://example.org', null).el('[data-rh-signup]', { href: '#up-next-mail' }).getAttribute('href'), '/live/#remind', 'not said: as the page script does (loadSignup)');
});

test('the page leaves with headers that never reuse the build\'s copy; anything else passes as it came', async () => {
  globalThis.HTMLRewriter = class { on() { return this; } transform(res) { return res; } };
  try {
    const page = new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: '"b"', 'Last-Modified': 'x', 'Content-Length': '13' } });
    const out = drawSchedule(page, { upcoming: [max], signup: ON }, { hero: true, tz: 'America/New_York', origin: 'https://example.org' });
    assert.equal(out.headers.get('Cache-Control'), 'private, max-age=30');
    for (const h of ['ETag', 'Last-Modified', 'Content-Length']) assert.equal(out.headers.get(h), null, h);
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    assert.equal(drawSchedule(json, { upcoming: [], signup: null }, { hero: false, tz: 'UTC', origin: '' }), json);
    const notFound = new Response('', { status: 404, headers: { 'content-type': 'text/html' } });
    assert.equal(drawSchedule(notFound, { upcoming: [], signup: null }, { hero: false, tz: 'UTC', origin: '' }), notFound);
  } finally { delete globalThis.HTMLRewriter; }
});

test('a schedule that can\'t be read: the page goes out exactly as built', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  try {
    const built = new Response('<html>built</html>', { headers: { 'content-type': 'text/html' } });
    let nextArg = 'unset';
    const res = await schedulePagesMiddleware({ request: new Request('https://example.org/reveals/'), next: (r) => { nextArg = r; return built; }, waitUntil() {} });
    assert.equal(res, built);
    assert.equal(nextArg, undefined, 'the request untouched');
    // Other pages and methods never wait on it
    let calls = 0;
    await schedulePagesMiddleware({ request: new Request('https://example.org/about/'), next: () => { calls++; return built; } });
    await schedulePagesMiddleware({ request: new Request('https://example.org/reveals/', { method: 'POST' }), next: () => { calls++; return built; } });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('the page-side reader: what the server left, or null when it left nothing (the page as built)', () => {
  const attr = scheduleAttr({ upcoming: [colin], signup: { email: true, hours: [1, 6] } });
  assert.deepEqual(scheduleOnPage({ dataset: { schedule: attr } }), { upcoming: [colin], signup: { email: true, hours: [1] } });
  assert.equal(scheduleOnPage({ dataset: {} }), null);
  assert.equal(scheduleOnPage(null), null);
  assert.equal(scheduleOnPage({ dataset: { schedule: '{"upcoming":' } }), null, 'cut short: as built');
  assert.equal(scheduleOnPage({ dataset: { schedule: '{"reveals":[]}' } }), null);
});

test('/live/\'s band leaves out the reveal the page is showing, as LivePage marks it', () => {
  const pub = (phase, kidSlug = 'max') => ({ phase, kidSlug });
  assert.equal(showingKid(pub('scheduled')), 'max');
  assert.equal(showingKid(pub('live')), 'max');
  assert.equal(showingKid(pub('replay')), 'max');
  assert.equal(showingKid(pub('idle')), '');
  assert.equal(showingKid(null), '');
  assert.equal(showingKid(pub('live', '')), '', 'a stream with no kid named');
  assert.equal(showingKid(pub('live'), 'max'), 'max');
  assert.equal(showingKid(pub('live'), 'colin'), '', 'another child\'s broadcast: this page shows nothing on');
  const rw = onBands(new Rw(), { upcoming: [max, colin], signup: ON }, 'America/New_York', { current: 'max' });
  const b = band(rw, {});
  assert.equal(b.section.getAttribute('data-current'), 'max');
  assert.deepEqual(b.list.content, { text: bandRowsHtml([colin], { tz: 'America/New_York' }), html: true });
  // The live page starts from the schedule the server left on its hero
  const live = readFileSync('src/components/live/LivePage.astro', 'utf8');
  assert.match(live, /const drawnFrom = scheduleOnPage\(hero\);\s+let upcoming: UpcomingReveal\[\] = drawnFrom\?\.upcoming \?\? upcomingAtBuild\(\);\s+let upcomingLoaded = !!drawnFrom;/);
  assert.match(live, /const showing = view !== 'idle' \? kidSlug : '';/, 'the rule showingKid mirrors');
});
