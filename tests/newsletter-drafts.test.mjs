/**
 * Event Recap and Monthly Impact: drafted in Kit by themselves (the morning
 * after an event once its photos are on the live page; on the 1st for the month
 * before), kept up to date until someone touches them, and drafted by hand from
 * the admin. Kit, Resend, Cloudflare Images and the live site are faked.
 * Run: node --test tests/newsletter-drafts.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { eventRecapEmail, monthlyImpactEmail, monthlyHasNews, recapUrl } from '../functions/api/_newsletter-email.js';
import {
  runNewsletterDrafts, maybeRunNewsletterDrafts, draftNewsletterNow, newsletterStatus, readNewsletterRow, recapKey, monthlyKey, monthBefore, newsletterNote,
} from '../functions/api/_newsletter-drafts.js';
import { writeConfig } from '../functions/api/_reveal-invites.js';

const IMG = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const SITE = 'https://sunshineonaranneyday.com';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (s) => Date.parse(s);
// Gallery uploads carry their time in the ID; these were added the morning after the gala
const upload = (n) => `gallery/gala/${at('2027-08-22T15:00:00Z') + n}-dsc-${n}.jpg`;
const GALA = { slug: '2027-evening-of-sunshine', title: '2027 Evening of Sunshine', date: '2027-08-21', status: 'upcoming', location: 'You42 Studios', photographer: 'Jessica Ruiz', highlights: [{ value: '350', label: 'guests' }, { value: '28', label: 'sponsors' }] };
const GOLF = { slug: 'fairway-2027', title: 'Sunshine on a Ranney Fairway', date: '2027-05-10', status: 'upcoming' };
const GALA_DOC = {
  galleryPhotos: Array.from({ length: 12 }, (_, i) => ({ id: upload(i), alt: '' })),
  sponsors: [
    { tier: 'Diamond Sponsor', size: 'xl', names: [{ name: 'Kids R Kids', logo: 'partners/kids-r-kids' }] },
    { tier: 'Platinum Sponsor', size: 'lg', names: [{ name: 'Pella', logo: 'partners/pella' }, { name: 'Traci Messier & Thomas Wilson' }] },
    { tier: 'Signature Cocktail Sponsor', size: 'sm', names: [{ name: 'Paulson Mitchell' }] },
    { tier: 'Cigar Rolling Sponsor', size: 'sm', names: [{ name: 'Crosby Design Group' }] },
    { tier: 'Bidding Paddle Sponsor', size: 'sm', names: [{ name: 'Crosby Design Group' }] },
  ],
};
const kid = (slug, name, extra = {}) => ({ slug, name, year: 2027, status: 'completed', publishStatus: 'published', roomTypes: ['Accessible Bathroom'], roomCount: 1, childCount: 1,
  heroImage: `${IMG}/kids/${slug}/hero/public`, photos: Array.from({ length: 8 }, (_, i) => ({ url: `${IMG}/kids/${slug}/p${i}/public` })), ...extra });
const KIDS = [
  kid('isla', 'Isla', { roomTypes: ['Therapy Room'], videoUrl: 'https://youtu.be/abc123def45' }),
  kid('remi-and-nico', 'Remi & Nico', { childCount: 2, roomCount: 2, roomTypes: ['Dream Bedroom'] }),
  kid('dylan', 'Dylan', { status: 'in-progress', roomTypes: ['Therapy Room'], sortOrder: 1 }),
  kid('max', 'Max', { status: 'in-progress', sortOrder: 2 }),
  kid('hidden', 'Hidden', { publishStatus: 'draft' }),
];

let kit; let emails; let site; let jt = { open: [], closed: [] };
const REVEAL_DATE = '22PgGhcE8jte';
const CONFIRMED = '22PgGhWscUgE';
const job = (id, name, revealIso, confirmed = 'Yes') => ({ id, name, customFieldValues: { nodes: [{ value: revealIso, customField: { id: REVEAL_DATE } }, { value: confirmed, customField: { id: CONFIRMED } }] } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.startsWith('https://api.kit.com/v4/')) {
    const path = url.slice('https://api.kit.com/v4'.length);
    kit.calls.push(`${method} ${path.split('?')[0]}`);
    if (path.startsWith('/tags')) return Response.json({ tags: [{ id: 555, name: 'Application Waitlist only (no newsletter)' }] });
    if (path.startsWith('/broadcasts?')) {
      if (kit.down) return new Response('down', { status: 503 });
      return Response.json({ broadcasts: [...kit.broadcasts.values()].filter((b) => b.status === 'draft').map(({ content, ...b }) => b) });
    }
    if (path === '/broadcasts' && method === 'POST') {
      if (kit.down) return new Response('down', { status: 503 });
      const id = String(kit.next++);
      kit.broadcasts.set(id, { id: Number(id), status: 'draft', ...body });
      if (kit.loseAnswer) { kit.loseAnswer = false; return new Response('gateway', { status: 502 }); }
      return Response.json({ broadcast: { id: Number(id) } }, { status: 201 });
    }
    const one = path.match(/^\/broadcasts\/(\d+)$/);
    if (one && method === 'GET') {
      if (kit.down) return new Response('down', { status: 503 });
      const b = kit.broadcasts.get(one[1]);
      return b ? Response.json({ broadcast: b }) : Response.json({ errors: ['Not found'] }, { status: 404 });
    }
    if (one && method === 'PUT') {
      const b = kit.broadcasts.get(one[1]);
      if (!b) return Response.json({ errors: ['Not found'] }, { status: 404 });
      kit.puts.push({ id: one[1], ...body });
      kit.broadcasts.set(one[1], { ...b, ...body, subscriber_filter: body.subscriber_filter || [{ all: [{ type: 'all_subscribers' }], any: null, none: null }] });
      return Response.json({ broadcast: kit.broadcasts.get(one[1]) });
    }
    return Response.json({ errors: ['unexpected'] }, { status: 500 });
  }
  if (url.startsWith('https://imagedelivery.net/')) {
    if (/broken/.test(url)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    return new Response('img', { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url.startsWith(SITE)) {
    site.reads.push(url);
    if (site.down) throw new Error('connection reset');
    const page = site.pages[url.replace(SITE, '')];
    return page ? new Response(page, { headers: { 'Content-Type': 'text/html' } }) : new Response('Not found', { status: 404 });
  }
  if (url.startsWith('https://api.resend.com/emails/batch')) {
    for (const e of body) emails.push(e);
    return Response.json({ data: body.map((_, i) => ({ id: `re_${emails.length}_${i}` })) });
  }
  if (url === 'https://api.jobtread.com/pave') {
    const where = JSON.stringify(body.query.organization.jobs.$.where);
    const nodes = where.includes('closedOn","=",null') ? jt.open : jt.closed;
    return Response.json({ organization: { jobs: { nodes, nextPage: null } } });
  }
  if (/slack/.test(url)) throw new Error(`Slack was called (${url}): the reviewer hears by email only`);
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
const putEvent = (ev) => env.DB.prepare('INSERT OR REPLACE INTO events (slug, title, date, status, data) VALUES (?, ?, ?, ?, ?)').bind(ev.slug, ev.title, ev.date, ev.status, JSON.stringify(ev)).run();
const putDoc = (key, doc) => env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(doc), new Date().toISOString()).run();
/** The gala's page as the live site serves it: with its photos once published */
const publish = (photos = GALA_DOC.galleryPhotos) => { site.pages['/events/gala/2027/'] = `<html>${photos.map((p) => `<img src="${IMG}/${p.id}/w=800">`).join('')}</html>`; };
beforeEach(async () => {
  kit = { broadcasts: new Map(), calls: [], puts: [], next: 9001 };
  emails = [];
  site = { pages: {}, reads: [] };
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of KIDS) await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, k.status, JSON.stringify(k)).run();
  env = { DB, KIT_API_KEY: 'kit_test', RESEND_API_KEY: 're_test' };
  await putEvent(GALA);
  await putEvent(GOLF);
  await putDoc('gala', GALA_DOC);
  await writeConfig(DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
});
const only = () => [...kit.broadcasts.values()][0];
const look = (when) => runNewsletterDrafts(env, { now: at(when) });
const STAFF = 'clareece@soardcharity.com';

// ── The emails ─────────────────────────────────────────────────────────────

test('Event Recap: the gala’s photos, numbers and sponsors, linked to its page for good, signed by the team', () => {
  const e = eventRecapEmail({ event: GALA, events: [GALA, GOLF], pageDoc: GALA_DOC });
  assert.equal(e.subject, 'What a Night! See the Photos from our Evening of Sunshine');
  assert.match(e.html, /Evening of Sunshine\u00A0·\u00A02027/);
  assert.match(e.html, /What a <em[^>]*>Night<\/em>!/);
  assert.match(e.html, /See All 12 Photos/);
  assert.match(e.html, new RegExp(`href="${SITE}/events/gala/2027/"`), 'the year page, which never turns into next year’s tickets');
  assert.ok(!/href="https:\/\/sunshineonaranneyday\.com\/events\/gala\/"/.test(e.html));
  assert.match(e.html, /You42 Studios on August 21/);
  assert.match(e.html, />350</);
  assert.match(e.html, /Photos by Jessica Ruiz/);
  assert.match(e.html, /incredible<\/em>&nbsp;sponsors\./);
  assert.match(e.html, /partners\/kids-r-kids\/trim=border/);
  assert.match(e.html, /Traci&nbsp;Messier/, 'a sponsor with no logo is thanked by name');
  assert.match(e.html, /Cigar Rolling · Bidding Paddle/, 'one row per sponsor, its moments together');
  assert.equal((e.html.match(/Crosby Design(&nbsp;| )Group/g) || []).length, 1);
  assert.match(e.html, /emails\/soard-team-plushie/);
  assert.ok(!/—/.test(e.html + e.text + e.subject), 'no em dashes');
  assert.ok(!/gradient/i.test(e.html));
  assert.ok(!/unsubscribe/i.test(e.html), 'Kit adds that itself');
});

test('Event Recap: a photo that won’t load is passed over; golf is a day', () => {
  const doc = { ...GALA_DOC, galleryPhotos: [{ id: 'gallery/gala/1818000000000-broken.jpg' }, ...GALA_DOC.galleryPhotos] };
  const broken = new Set([`${IMG}/gallery/gala/1818000000000-broken.jpg/w=500,h=500,fit=cover,gravity=face,q=75`]);
  const e = eventRecapEmail({ event: GALA, events: [GALA], pageDoc: doc, brokenLogos: broken });
  assert.ok(!/broken\.jpg/.test(e.html));
  const golf = eventRecapEmail({ event: { ...GOLF, photos: [{ id: 'events/golf/a.jpg' }, { id: 'events/golf/b.jpg' }] }, events: [GOLF] });
  assert.equal(golf.subject, 'What a Day! See the Photos from our Sunshine on a Ranney Fairway');
  assert.match(golf.html, /Thank you for an unforgettable(&nbsp;| )day\./);
});

test('Monthly Impact: one reveal leads by name, several by how many, none by the month', () => {
  const [isla, remi, dylan, max] = KIDS;
  const one = monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', revealed: [{ kid: isla, date: '2027-09-22' }], building: [dylan, max], totals: { kids: 214, rooms: 233 } });
  assert.equal(one.subject, 'Your Monthly Dose of Sunshine: Isla’s Big Reveal');
  assert.match(one.html, /Monthly Dose of Sunshine · September 2027/);
  assert.match(one.html, /Watch the Reveal/);
  assert.match(one.html, /Revealed September 22\. The new therapy room is finished/);
  assert.match(one.html, />214</);
  assert.match(one.html, /Being built(&nbsp;| )now/i);
  assert.match(one.html, /Meet(&nbsp;| )Dylan&nbsp;→/);
  const two = monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', revealed: [{ kid: isla, date: '2027-09-05' }, { kid: remi, date: '2027-09-22' }] });
  assert.equal(two.subject, 'Your Monthly Dose of Sunshine: Two Big Reveals');
  assert.match(two.html, /dream bedrooms are finished, and the family has seen them/);
  const none = monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', building: [dylan] });
  assert.equal(none.subject, 'Your Monthly Dose of Sunshine: September at SOARD');
  assert.ok(!/—/.test(one.html + one.text + two.html + none.html), 'no em dashes');
  assert.ok(!/\[|write here|lorem/i.test(one.text + none.text), 'no placeholder that could go out by mistake');
});

test('Monthly Impact: what’s coming up is from today on, tentative only as its window', () => {
  const e = monthlyImpactEmail({
    month: '2027-09', today: '2027-10-05',
    upcoming: [
      { name: 'Gone', slug: 'gone', confirmed: true, date: '2027-10-02', time: '16:00' },
      { name: 'Dylan', slug: 'dylan', confirmed: true, date: '2027-10-18', time: '16:00' },
      { name: 'Max', slug: 'max', confirmed: false, window: { label: 'mid November', through: '2027-11-20' } },
    ],
    events: [{ title: 'Evening of Sunshine', date: '2027-10-30', url: `${SITE}/events/gala/`, tickets: 'https://www.zeffy.com/en-US/ticketing/gala' }],
  });
  assert.ok(!/Gone’s/.test(e.html), 'a reveal that has passed is left out');
  assert.match(e.html, /Mon, Oct 18 · 4:00 PM/);
  assert.match(e.html, new RegExp(`href="${SITE}/live/dylan/"`));
  assert.match(e.html, /Mid November/);
  assert.ok(!/2027-11/.test(e.html.replace(/href="[^"]*"/g, '')), 'no tentative day leaks');
  assert.match(e.html, /Get(&nbsp;| )tickets&nbsp;→/);
  assert.equal(monthlyHasNews({}), false);
});

// ── By itself ──────────────────────────────────────────────────────────────

test('the first look marks the past as done: nothing old is drafted when this goes live', async () => {
  await putEvent({ ...GALA, slug: '2026-evening-of-sunshine', title: '2026 Evening of Sunshine', date: '2026-08-22' });
  publish();
  await look('2027-08-30T14:00:00Z');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).state, 'skipped');
  assert.equal((await readNewsletterRow(env.DB, recapKey('2026-evening-of-sunshine'))).state, 'skipped');
  assert.equal((await readNewsletterRow(env.DB, monthlyKey('2027-07'))).state, 'skipped');
  assert.equal(emails.length, 0);
});

test('Event Recap drafts itself once the photos are on the live page, never before, never twice', async () => {
  await look('2027-08-01T14:00:00Z'); // live, before the gala
  await look('2027-08-22T13:00:00Z'); // the morning after: photos saved, not published
  assert.equal(kit.broadcasts.size, 0);
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).state, 'waiting');
  publish();
  const r = await look('2027-08-22T15:00:00Z');
  assert.equal(r.find((x) => x.key === recapKey(GALA.slug)).newsletter, 'drafted');
  const b = only();
  assert.equal(b.subject, 'What a Night! See the Photos from our Evening of Sunshine');
  assert.equal(b.send_at, null, 'a draft only');
  assert.equal(b.public, false);
  assert.deepEqual(b.subscriber_filter, [{ all: null, any: null, none: [{ type: 'tag', ids: [555] }] }], 'the newsletter list, less the families who only asked about applications');
  assert.match(b.description, /· recap:2027-evening-of-sunshine ·/);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['linzi@soardcharity.com']);
  assert.match(emails[0].text, /The event is over and its photos are on the page/);
  await look('2027-08-22T17:00:00Z');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(emails.length, 1);
});

test('a recap still without photos: one reminder a week on, let go after 60 days', async () => {
  await look('2027-08-01T14:00:00Z');
  await putDoc('gala', { ...GALA_DOC, galleryPhotos: [] });
  await look('2027-08-22T13:00:00Z');
  await look('2027-08-27T13:00:00Z');
  assert.equal(emails.length, 0);
  const recapNotes = () => emails.filter((e) => /recap/i.test(e.subject));
  await look('2027-08-29T14:00:00Z');
  assert.equal(recapNotes().length, 1);
  assert.match(recapNotes()[0].subject, /waiting on the photos/);
  await look('2027-09-05T14:00:00Z');
  assert.equal(recapNotes().length, 1, 'once');
  await look('2027-10-22T14:00:00Z');
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).state, 'skipped');
});

test('a waiting draft follows the page until someone touches it; then it’s theirs', async () => {
  await look('2027-08-01T14:00:00Z');
  publish();
  await look('2027-08-22T15:00:00Z');
  const id = String(only().id);
  // Two more photos added: the untouched draft is rebuilt, its audience said again
  await putDoc('gala', { ...GALA_DOC, galleryPhotos: [...GALA_DOC.galleryPhotos, { id: upload(20) }, { id: upload(21) }] });
  await look('2027-08-23T15:00:00Z');
  assert.equal(kit.puts.length, 1);
  assert.match(kit.broadcasts.get(id).content, /See All 14 Photos/);
  assert.deepEqual(kit.puts[0].subscriber_filter, [{ all: null, any: null, none: [{ type: 'tag', ids: [555] }] }], 'never reset to everyone');
  assert.equal(emails.length, 1, 'a rebuild emails nobody');
  // Linzi edits it in Kit: the site leaves it alone for good
  kit.broadcasts.get(id).subject = 'What a night it was!';
  await putDoc('gala', { ...GALA_DOC, galleryPhotos: [...GALA_DOC.galleryPhotos, { id: upload(30) }] });
  await look('2027-08-24T15:00:00Z');
  assert.equal(kit.puts.length, 1);
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).state, 'edited');
  assert.equal(kit.broadcasts.get(id).subject, 'What a night it was!');
});

test('a scheduled or sent draft is never rewritten', async () => {
  await look('2027-08-01T14:00:00Z');
  publish();
  await look('2027-08-22T15:00:00Z');
  Object.assign(only(), { status: 'scheduled', send_at: '2027-08-25T14:00:00Z' });
  await putDoc('gala', { ...GALA_DOC, galleryPhotos: [...GALA_DOC.galleryPhotos, { id: upload(40) }] });
  await look('2027-08-23T15:00:00Z');
  assert.equal(kit.puts.length, 0);
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).state, 'scheduled');
});

test('Monthly Impact drafts itself on the 1st for the month before, from the site’s own data', async () => {
  await look('2027-08-15T14:00:00Z'); // live mid-August: July is marked done
  publish();
  await putDoc('reveals', { reveals: [], upcoming: [{ slug: 'dylan', name: 'Dylan', confirmed: true, date: '2027-09-18', time: '16:00' }],
    past: [{ slug: 'isla', name: 'Isla', date: '2027-08-20', time: '16:00' }, { slug: 'hidden', name: 'Hidden', date: '2027-08-21' }, { slug: 'remi-and-nico', name: 'Remi & Nico', date: '2027-07-30' }], updatedAt: '2027-08-31T00:00:00Z' });
  await env.DB.prepare('INSERT INTO press (slug, title, date, data) VALUES (?, ?, ?, ?)').bind('wsb', 'A Room for Isla', '2027-08-25', JSON.stringify({ title: 'A Room for Isla', outlet: 'WSB-TV', date: '2027-08-25', url: 'https://www.wsbtv.com/isla' })).run();
  await look('2027-08-31T14:00:00Z');
  assert.ok(![...kit.broadcasts.values()].some((b) => /Monthly Dose/.test(b.subject)), 'not before the month is over');
  await look('2027-09-01T13:00:00Z');
  const m = [...kit.broadcasts.values()].find((b) => /Monthly Dose/.test(b.subject));
  assert.equal(m.subject, 'Your Monthly Dose of Sunshine: Isla’s Big Reveal');
  assert.ok(!/Hidden/.test(m.content), 'a hidden page is never in it');
  assert.ok(!/Remi/.test(m.content.replace(/Being built now[\s\S]*/, '')), 'only the month’s own reveals');
  assert.match(m.content, /WSB-TV/);
  assert.match(m.content, /Dylan’s(&nbsp;| )reveal/);
  assert.match(m.content, /the photos from our Evening of Sunshine/);
  assert.match(m.content, /Monthly Dose of Sunshine · August 2027/);
  assert.equal(m.send_at, null);
  assert.ok(emails.some((e) => /August 2027 Monthly Impact/.test(e.subject)));
  // July, marked done when this went live, never drafts
  assert.equal([...kit.broadcasts.values()].filter((b) => /Monthly Dose/.test(b.subject)).length, 1);
});

test('the hourly slot: overlapping heartbeats run one look', async () => {
  const a = await maybeRunNewsletterDrafts(env, { now: at('2027-08-01T14:00:00Z') });
  const b = await maybeRunNewsletterDrafts(env, { now: at('2027-08-01T14:20:00Z') });
  const c = await maybeRunNewsletterDrafts(env, { now: at('2027-08-01T15:01:00Z') });
  assert.ok(Array.isArray(a));
  assert.equal(b, null);
  assert.ok(Array.isArray(c));
});

// ── By hand ────────────────────────────────────────────────────────────────

test('by hand: a recap for an event from before this went live, as a draft only, and Linzi hears who', async () => {
  await look('2027-08-30T14:00:00Z'); // seeds: the gala is already over
  publish();
  const r = await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now: at('2027-08-30T15:00:00Z') });
  assert.equal(r.newsletter, 'drafted');
  assert.equal(only().send_at, null);
  assert.match(emails[0].text, /Clareece drafted it from the admin/);
  assert.equal((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now: at('2027-08-30T16:00:00Z') })).newsletter, 'unchanged');
  assert.equal(kit.broadcasts.size, 1);
});

test('by hand: held back only by what would make it untrue, in words', async () => {
  const now = at('2027-08-22T15:00:00Z');
  assert.match((await draftNewsletterNow(env, { key: recapKey(GOLF.slug), by: STAFF, now })).reason, /Add the photographer’s photos/);
  await putEvent({ ...GALA, date: '2027-09-20' });
  assert.match((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now })).reason, /morning after the event/);
  await putEvent(GALA);
  assert.match((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now })).reason, /Publish first/);
  site.down = true;
  assert.match((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now })).reason, /couldn’t be checked/);
  site.down = false;
  assert.match((await draftNewsletterNow(env, { key: monthlyKey('2027-08'), by: STAFF, now })).reason, /Ready on the 1st of September/);
  assert.equal(kit.broadcasts.size, 0);
  assert.equal((await draftNewsletterNow(env, { key: 'recap:../x', by: STAFF, now })).newsletter, 'error');
  assert.equal((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: 'unknown', now })).newsletter, 'error');
});

test('by hand: deleted in Kit, it can be drafted again; Linzi drafting it herself gets no email', async () => {
  publish();
  const now = at('2027-08-22T15:00:00Z');
  await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: 'linzi@soardcharity.com', now });
  assert.equal(emails.length, 0);
  kit.broadcasts.clear();
  assert.equal((await newsletterStatus(env, recapKey(GALA.slug), { now })).state, 'deleted');
  const r = await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now });
  assert.equal(r.newsletter, 'drafted');
  assert.equal(kit.calls.filter((c) => c === 'POST /broadcasts').length, 2);
});

test('by hand: off while invites are paused; Kit down drafts nothing and says so', async () => {
  publish();
  const now = at('2027-08-22T15:00:00Z');
  await writeConfig(env.DB, { enabled: false });
  assert.equal((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now })).newsletter, 'off');
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  kit.down = true;
  const r = await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now });
  assert.equal(r.newsletter, 'error');
  assert.match(r.error, /Kit couldn’t be reached/);
  assert.equal(kit.broadcasts.size, 0);
});

test('a lost answer from Kit never makes a second draft', async () => {
  publish();
  kit.loseAnswer = true;
  const now = at('2027-08-22T15:00:00Z');
  assert.equal((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now })).newsletter, 'error');
  assert.equal((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now: now + 11 * 60 * 1000 })).newsletter, 'drafted');
  assert.equal(kit.broadcasts.size, 1);
});

test('status: where each stands, read from Kit', async () => {
  const now = at('2027-08-22T15:00:00Z');
  let st = await newsletterStatus(env, recapKey(GALA.slug), { now });
  assert.equal(st.state, 'none');
  assert.match(st.block, /Publish first/);
  assert.equal(st.title, 'Evening of Sunshine 2027');
  publish();
  await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now });
  st = await newsletterStatus(env, recapKey(GALA.slug), { now });
  assert.equal(st.state, 'draft');
  Object.assign(only(), { status: 'completed', published_at: '2027-08-23T14:00:00Z' });
  st = await newsletterStatus(env, recapKey(GALA.slug), { now });
  assert.equal(st.state, 'sent');
  assert.equal(monthBefore('2027-01-04'), '2026-12');
  assert.equal(recapUrl(GALA, [GALA]), `${SITE}/events/gala/2027/`);
});

test('the reviewer’s notes read plainly, with no em dashes', () => {
  const a = newsletterNote('ready', { kind: 'monthly', title: 'August 2027 Monthly Impact', id: '9001', subject: 'Your Monthly Dose of Sunshine: Isla’s Big Reveal' });
  assert.match(a.text, /August 2027 is over, so the Monthly Impact email is drafted in Kit/);
  const w = newsletterNote('waiting', { kind: 'recap', title: 'Evening of Sunshine 2027', block: 'Publish first: the page doesn’t show the photos yet, and the email links to it' });
  assert.match(w.text, /drafts itself as soon as the photos are on the event’s page/);
  assert.ok(!/—/.test(a.html + a.text + w.html + w.text));
});


test('Monthly Impact takes each reveal day from JobTread, closed jobs too: never a rehearsal, another month or a hidden page', async () => {
  const { monthlyFacts } = await import('../functions/api/_newsletter-drafts.js');
  jt = {
    open: [job('22PJOB0000001', 'Dylan Smith (2027)', '2027-08-12T20:00:00Z'), job('22PJOB0000002', 'TEST Isla Example (2027)', '2027-08-13T20:00:00Z'), job('22PJOB0000003', 'Max Jones (2027)', '2027-09-02T20:00:00Z')],
    // Closed soon after their reveals: Isla's day was never marked confirmed, but she's finished; Hidden's page is hidden
    closed: [job('22PJOB0000004', 'Isla Brown (2027)', '2027-08-20T19:30:00Z', ''), job('22PJOB0000005', 'Hidden Doe (2027)', '2027-08-21T19:30:00Z'), job('22PJOB0000006', 'Remi & Nico Lee (2027)', '2027-07-30T19:30:00Z')],
  };
  const facts = await monthlyFacts({ ...env, JOBTREAD_GRANT_KEY: 'jt_test' }, '2027-08', { now: at('2027-09-01T14:00:00Z') });
  assert.deepEqual(facts.revealed.map((r) => `${r.kid.slug} ${r.date}`), ['dylan 2027-08-12', 'isla 2027-08-20']);
  assert.ok(!facts.building.some((k) => k.slug === 'dylan'), 'a kid revealed this month isn’t also "being built"');
  jt = { open: [], closed: [] };
});


test('Monthly Impact: an event’s photos only once they’re on its live page; hidden press stays out; a gone story links its saved copy', async () => {
  const { monthlyFacts } = await import('../functions/api/_newsletter-drafts.js');
  await env.DB.prepare('INSERT INTO press (slug, title, date, data) VALUES (?, ?, ?, ?)').bind('hid', 'Hidden story', '2027-08-10', JSON.stringify({ title: 'Hidden story', outlet: 'X', date: '2027-08-10', url: 'https://x.example/a', publishStatus: 'draft' })).run();
  await env.DB.prepare('INSERT INTO press (slug, title, date, data) VALUES (?, ?, ?, ?)').bind('gone', 'Gone story', '2027-08-11', JSON.stringify({ title: 'Gone story', outlet: 'Y', date: '2027-08-11', url: 'https://y.example/dead', linkGone: '2027-09-01', archiveUrl: 'https://web.archive.org/y' })).run();
  const now = at('2027-09-01T14:00:00Z');
  let f = await monthlyFacts(env, '2027-08', { now });
  assert.equal(f.recaps.length, 0, 'saved, not published: the page still says the photos are on the way');
  assert.deepEqual(f.press.map((p) => p.url), ['https://web.archive.org/y']);
  publish();
  f = await monthlyFacts(env, '2027-08', { now });
  assert.equal(f.recaps.length, 1);
  assert.equal(f.recaps[0].name, 'Evening of Sunshine');
});

test('a backfilled old event never drafts by itself; an event whose date moved ahead starts over', async () => {
  await look('2027-08-01T14:00:00Z');
  await putEvent({ slug: 'kids-fest-2019', title: '2019 Kids Fest', date: '2019-04-06', status: 'upcoming', photos: [{ id: 'events/kids-fest/a.jpg' }] });
  site.pages['/events/kids-fest-2019/'] = '<img src="events/kids-fest/a.jpg">';
  await look('2027-08-02T15:00:00Z');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(await readNewsletterRow(env.DB, recapKey('kids-fest-2019')), null, 'not even queued');
  // Saved with last year's date by mistake, then fixed: the row it got is cleared, and it drafts after the real day
  await putEvent({ ...GOLF, slug: 'golf-2027b', date: '2027-07-25' });
  await look('2027-08-03T15:00:00Z');
  assert.ok(await readNewsletterRow(env.DB, recapKey('golf-2027b')));
  await putEvent({ ...GOLF, slug: 'golf-2027b', date: '2027-09-25' });
  await look('2027-08-04T16:00:00Z');
  assert.equal(await readNewsletterRow(env.DB, recapKey('golf-2027b')), null);
});

test('a failed read is never taken for “nothing there”: no seed, no drafts, nothing skipped', async () => {
  const real = env.DB.prepare.bind(env.DB);
  let fail = true;
  env.DB.prepare = (sql) => (fail && /FROM events/.test(sql) ? { bind: () => ({ all: async () => { throw new Error('D1_ERROR: network'); } }), all: async () => { throw new Error('D1_ERROR: network'); } } : real(sql));
  await putEvent({ ...GALA, slug: '2026-evening-of-sunshine', date: '2026-08-22' });
  assert.deepEqual(await look('2027-08-30T14:00:00Z'), []);
  assert.equal(await readNewsletterRow(env.DB, '__seeded__'), null);
  fail = false;
  env.DB.prepare = real;
  publish();
  await look('2027-08-30T15:00:00Z');
  assert.equal(kit.broadcasts.size, 0, 'the seed ran once the read worked: the past stays out');
});

test('drafts paused past an event’s 60 days: when they’re back on, it’s let go', async () => {
  await look('2027-08-01T14:00:00Z');
  await writeConfig(env.DB, { enabled: false });
  publish();
  await look('2027-08-22T15:00:00Z');
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  await look('2027-11-05T15:00:00Z');
  assert.ok(![...kit.broadcasts.values()].some((b) => /What a Night/.test(b.subject)));
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).state, 'skipped');
});

test('an edit made in Kit while the site checks pictures is never written over', async () => {
  await look('2027-08-01T14:00:00Z');
  publish();
  await look('2027-08-22T15:00:00Z');
  const id = String(only().id);
  await putDoc('gala', { ...GALA_DOC, galleryPhotos: [...GALA_DOC.galleryPhotos, { id: upload(50) }] });
  // Linzi's edit lands between the site's first read of Kit and its write
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://imagedelivery.net/')) kit.broadcasts.get(id).subject = 'Linzi’s own subject';
    return realFetch2(input, init);
  };
  try { await look('2027-08-23T15:00:00Z'); } finally { globalThis.fetch = realFetch2; }
  assert.equal(kit.puts.length, 0);
  assert.equal(kit.broadcasts.get(id).subject, 'Linzi’s own subject');
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).state, 'edited');
});

test('by hand, not ready: nothing is written, so the 1st still drafts that month', async () => {
  const now = at('2027-08-20T15:00:00Z');
  assert.match((await draftNewsletterNow(env, { key: monthlyKey('2027-08'), by: STAFF, now })).reason, /Ready on the 1st of September/);
  assert.equal(await readNewsletterRow(env.DB, monthlyKey('2027-08')), null);
  assert.match((await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: STAFF, now: at('2027-08-10T15:00:00Z') })).reason, /morning after/);
  assert.equal(await readNewsletterRow(env.DB, recapKey(GALA.slug)), null);
});

test('the recap’s photos come from its own year, even after next year’s event exists; long numbers don’t collide', () => {
  const next = { slug: '2028-evening-of-sunshine', title: '2028 Evening of Sunshine', date: '2028-08-19', status: 'upcoming' };
  const e = eventRecapEmail({ event: GALA, events: [GALA, next], pageDoc: GALA_DOC });
  assert.match(e.html, /See All 12 Photos/);
  const big = eventRecapEmail({ event: { ...GALA, highlights: [{ value: '$1,250,000', label: 'raised' }, { value: '350', label: 'guests' }] }, events: [GALA], pageDoc: GALA_DOC });
  assert.match(big.html, /font-size:22px;font-weight:700;line-height:1\.15;[^"]*white-space:nowrap;">\$1,250,000/);
  const titled = eventRecapEmail({ event: { slug: 'kids-fest-2027', title: '2027 Kids Fest', date: '2027-04-06', photos: [{ id: 'events/kf/a.jpg' }, { id: 'events/kf/b.jpg' }] }, events: [] });
  assert.ok(!/2027 Kids Fest 2027|Kids Fest · 2027 Kids/.test(titled.html + titled.preview), 'the year once');
  assert.match(titled.preview, /The photos from Kids Fest 2027\./);
});

test('the small things a reader would catch', async () => {
  const [isla] = KIDS;
  // A ramp with no video: the cover button names what's there, never "Room"
  const ramp = kid('marcus', 'Marcus Jr.', { roomTypes: ['Wheelchair Ramp'] });
  const m = monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', revealed: [{ kid: ramp, date: '2027-09-10' }] });
  assert.match(m.html, />See the Photos</);
  assert.ok(!/’s Room</.test(m.html));
  assert.ok(!/coming up/i.test(m.preview), 'no "what’s coming up" with nothing coming up');
  // Two kinds of room are two rooms, even when an older page counts 1
  const two = monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', revealed: [{ kid: { ...isla, roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], roomCount: 1 }, date: '2027-09-10' }] });
  assert.match(two.html, /are finished, and the family has seen them/);
  // Two events' photos in one month
  const recaps = [{ name: 'Evening of Sunshine', year: '2027', url: `${SITE}/events/gala/2027/`, when: 'night', count: 3, series: true }, { name: 'Kids Fest', year: '2027', url: `${SITE}/events/kids-fest/`, when: 'day', count: 2 }];
  assert.match(monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', recaps }).html, /From the(&nbsp;| )events/);
  // Typed em dashes never reach the email; each sponsor thanked once in the text
  const doc = { ...GALA_DOC, galleryPhotos: GALA_DOC.galleryPhotos.map((p) => ({ ...p, alt: 'Guests — dancing' })),
    sponsors: [...GALA_DOC.sponsors, { tier: 'Wine Wall — Sponsor', size: 'sm', names: [{ name: 'Pella' }] }] };
  const r = eventRecapEmail({ event: { ...GALA, highlights: [{ value: '350 — and counting', label: 'guests' }] }, events: [GALA], pageDoc: doc });
  assert.ok(!/—/.test(r.html + r.text + r.preview));
  assert.equal((r.text.match(/Pella/g) || []).length, 1);
});

test('Coming up links an event’s own page only when it has one', async () => {
  const { monthlyFacts } = await import('../functions/api/_newsletter-drafts.js');
  await putEvent({ slug: 'kids-fest-2027', title: 'Kids Fest', date: '2027-10-20', status: 'upcoming' });
  const f = await monthlyFacts(env, '2027-08', { now: at('2027-09-01T14:00:00Z') });
  assert.equal(f.events.find((e) => e.title === 'Kids Fest').url, `${SITE}/events/`);
});

test('status: an event long over that the site never saw end says it won’t come by itself', async () => {
  await look('2027-08-01T14:00:00Z');
  await putEvent({ slug: 'kids-fest-2019', title: '2019 Kids Fest', date: '2019-04-06', status: 'upcoming', photos: [{ id: 'events/kids-fest/a.jpg' }] });
  site.pages['/events/kids-fest-2019/'] = '<img src="events/kids-fest/a.jpg">';
  const st = await newsletterStatus(env, recapKey('kids-fest-2019'), { now: at('2027-08-02T15:00:00Z') });
  assert.equal(st.state, 'skipped');
  assert.equal(st.block, null, 'and By hand still drafts it');
});


test('the reviewers by default: Linzi and Peter; whoever drafts it by hand isn’t emailed about it, the other is', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: {} });
  publish();
  await draftNewsletterNow(env, { key: recapKey(GALA.slug), by: 'Peter@soardcharity.com', now: at('2027-08-22T15:00:00Z') });
  assert.deepEqual(emails.map((e) => e.to[0]), ['linzi@soardcharity.com']);
  assert.match(emails[0].text, /Peter drafted it from the admin/);
  assert.ok((await readNewsletterRow(env.DB, recapKey(GALA.slug))).told);
});


test('the recap wears its event’s colors, the same as its page: the gala’s, golf’s, else SOARD’s', async () => {
  const { RECAP_COLORS } = await import('../public/admin/events-shared.js');
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../src/components/events/EventRecap.astro', import.meta.url), 'utf8');
  // The page's own colors: if it changes them, this fails until RECAP_COLORS follows
  for (const [key, c] of Object.entries(RECAP_COLORS)) {
    const block = page.match(new RegExp(`\\.rc--${key} \\{[\\s\\S]*?\\n  \\}`))?.[0] || '';
    for (const hex of [c.paper, c.ink, c.muted, c.dark]) assert.ok(block.toLowerCase().includes(hex.toLowerCase()), `${key} ${hex} is the page’s`);
    if (key === 'gala') assert.ok(block.toLowerCase().includes(c.accent.toLowerCase()));
  }
  const gala = eventRecapEmail({ event: { ...GALA, slug: '2026-evening-of-sunshine', date: '2026-08-22' }, events: [], pageDoc: { ...GALA_DOC, galleryPhotos: [{ id: 'gallery/gala/1787400000000-a.jpg' }, { id: 'gallery/gala/1787400000001-b.jpg' }] } });
  assert.match(gala.html, /#0d2f3f/);
  assert.match(gala.html, /#f0c35a/);
  assert.ok(!/#1E1F25|#FFDA24|#FEFCF5/i.test(gala.html), 'no SOARD dark, yellow or cream left in it');
  assert.match(gala.html, /Havana Nights · Evening of Sunshine/, 'the year’s theme on top');
  const own = eventRecapEmail({ event: { ...GALA, theme: 'Moulin Rouge' }, events: [GALA], pageDoc: GALA_DOC });
  assert.match(own.html, /Moulin Rouge · Evening of Sunshine/);
  const golf = eventRecapEmail({ event: { ...GOLF, photos: [{ id: 'events/golf/a.jpg' }, { id: 'events/golf/b.jpg' }] }, events: [GOLF] });
  assert.match(golf.html, /#1a472a/);
  assert.ok(!/#1E1F25/i.test(golf.html));
  assert.ok(!/Havana/.test(golf.html));
  const fest = eventRecapEmail({ event: { slug: 'kids-fest-2027', title: 'Kids Fest', date: '2027-04-06', photos: [{ id: 'events/kf/a.jpg' }, { id: 'events/kf/b.jpg' }] }, events: [] });
  assert.match(fest.html, /#1E1F25/, 'any other event keeps SOARD’s colors');
  // The monthly is SOARD’s own
  assert.match(monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', building: [KIDS[2]] }).html, /#1E1F25/);
});

test('a draft written in an older design is rebuilt on the next hourly look, not hours later', async () => {
  await look('2027-08-01T14:00:00Z');
  publish();
  await look('2027-08-22T15:00:00Z');
  const id = String(only().id);
  await env.DB.prepare("UPDATE newsletter_drafts SET design = 'old', facts = 'old' WHERE key = ?").bind(recapKey(GALA.slug)).run();
  await look('2027-08-22T16:05:00Z'); // an hour on: well before the usual six-hour look
  assert.equal(kit.puts.length, 1);
  assert.equal(kit.puts[0].id, id);
  const { NEWSLETTER_DESIGN } = await import('../functions/api/_newsletter-email.js');
  assert.equal((await readNewsletterRow(env.DB, recapKey(GALA.slug))).design, NEWSLETTER_DESIGN);
});
