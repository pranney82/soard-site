/**
 * Event pages after the event: the rules in public/admin/events-shared.js
 * (series, "over" in Atlanta time, year pages, which photos and sponsors
 * belong to which year) and the heartbeat job in functions/api/_event-recap.js
 * (the rebuild the morning after, and each year keeping its photos and
 * sponsors once next year's event is added).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { ensureHistory } from '../functions/api/_content-history.js';
import {
  seriesOf, dayIn, isOver, eventPath, yearPath, yearPages, hasOwnPage, uploadedAt, galleryPhotosFor,
  recapPhotos, recapSponsors, splitSponsors, momentName, cleanHighlights, recapLead, sponsorCount, cleanSponsors,
} from '../public/admin/events-shared.js';
import { planRecaps, runEventRecaps, maybeRunEventRecaps, recapCard, SYNC_USER } from '../functions/api/_event-recap.js';

const ROOT = new URL('..', import.meta.url).pathname;
const gala26 = { title: '2026 Evening of Sunshine ', slug: '2026-evening-of-sunshine', date: '2026-08-22', endDate: '2026-08-22', location: 'You42 Studios', status: 'upcoming', photos: [] };
const gala27 = { title: '2027 Evening of Sunshine', slug: '2027-evening-of-sunshine', date: '2027-08-21', location: 'You42 Studios', status: 'upcoming', photos: [] };
const golf26 = { title: 'Sunshine on a Ranney Fairway', slug: 'sunshine-on-a-ranney-fairway', date: '2026-05-18', endDate: '2026-05-18', location: 'Indian Hills Country Club', status: 'upcoming', photos: [] };
const volunteer = { title: 'Build Day', slug: 'build-day', date: '2026-09-12', location: 'Roswell', status: 'upcoming', photos: [] };
const at = (iso) => Date.parse(iso);
const ts = (iso) => at(iso); // an upload made at this moment
const photo = (iso, name) => ({ id: `gallery/gala/${ts(iso)}-${name}.jpg`, alt: '' });
const OCT_21 = '2026-10-21';

test('events join a series by slug; the rest stand alone', () => {
  assert.equal(seriesOf(gala26).key, 'gala');
  assert.equal(seriesOf(gala27).key, 'gala');
  assert.equal(seriesOf(golf26).key, 'golf');
  assert.equal(seriesOf({ slug: 'golf-2027' }).key, 'golf');
  assert.equal(seriesOf(volunteer), null);
});

test('an event is over from the morning after its last day, in Atlanta', () => {
  // 11:30 PM on gala night (EDT) is already the 23rd in UTC: still the gala
  assert.equal(dayIn(at('2026-08-23T03:30:00Z')), '2026-08-22');
  assert.equal(isOver(gala26, dayIn(at('2026-08-23T03:30:00Z'))), false);
  assert.equal(isOver(gala26, dayIn(at('2026-08-23T04:30:00Z'))), true);
  // A two-day event stays on through its last day; a cancelled one never turns into a recap
  assert.equal(isOver({ ...volunteer, endDate: '2026-09-13' }, '2026-09-13'), false);
  assert.equal(isOver({ ...volunteer, endDate: '2026-09-13' }, '2026-09-14'), true);
  assert.equal(isOver({ ...gala26, status: 'cancelled' }, OCT_21), false);
});

test('the newest of a series is at its page; older ones keep a page per year', () => {
  assert.equal(eventPath(gala26, [gala26, golf26]), '/events/gala/');
  assert.equal(eventPath(golf26, [gala26, golf26]), '/events/golf/');
  const both = [gala26, gala27, golf26];
  assert.equal(eventPath(gala27, both, OCT_21), '/events/gala/');
  assert.equal(eventPath(gala26, both, OCT_21), '/events/gala/2026/');
  assert.equal(yearPath(gala26, both), '/events/gala/2026/');
  // A cancelled 2027 gala doesn't take the page
  assert.equal(eventPath(gala26, [gala26, { ...gala27, status: 'cancelled' }], OCT_21), '/events/gala/');
  // Year pages: every series event that's over
  assert.deepEqual(yearPages(both, OCT_21).map((p) => p.path).sort(), ['/events/gala/2026/', '/events/golf/2026/']);
  // Stand-alone events: their own page once over, or sooner with content
  assert.equal(eventPath(volunteer, [volunteer]), '/events/build-day/');
  assert.equal(hasOwnPage(volunteer, [volunteer], '2026-09-01'), false);
  assert.equal(hasOwnPage(volunteer, [volunteer], OCT_21), true);
  assert.equal(hasOwnPage({ ...volunteer, body: '<p>Details</p>' }, [volunteer], '2026-09-01'), true);
  assert.equal(hasOwnPage(gala26, both, OCT_21), false, 'a gala forwards to its series pages');
});

test('a series event shows the gallery photos uploaded from its date until the next one', () => {
  const before = photo('2025-09-01T15:00:00Z', 'last-year');
  const after = photo('2026-09-24T15:32:21Z', 'dsc-7362');
  const nextYear = photo('2027-09-02T12:00:00Z', 'next-year');
  const doc = { galleryPhotos: [before, after, after, { id: '', alt: '' }, 'partners/no-time', nextYear] };
  assert.equal(uploadedAt(after.id), ts('2026-09-24T15:32:21Z'));
  // Only 2026 exists: everything from Aug 22, 2026 on, once each
  assert.deepEqual(galleryPhotosFor(gala26, [gala26], doc).map((p) => p.id), [after.id, nextYear.id]);
  // 2027 added: 2026 stops at 2027's date, 2027 starts there
  assert.deepEqual(galleryPhotosFor(gala26, [gala26, gala27], doc).map((p) => p.id), [after.id]);
  assert.deepEqual(galleryPhotosFor(gala27, [gala26, gala27], doc).map((p) => p.id), [nextYear.id]);
  // The event's own photos come first
  assert.deepEqual(recapPhotos({ ...gala26, photos: [{ id: 'events/x/1', alt: 'Own' }] }, [gala26], doc).map((p) => p.id), ['events/x/1']);
  // Stand-alone events only ever show their own
  assert.deepEqual(galleryPhotosFor(volunteer, [volunteer], doc), []);
});

test('sponsors: the event’s own list, else the page’s for the newest only', () => {
  const doc = { sponsors: [{ tier: 'Gold Sponsor', size: 'md', names: [{ name: 'Pella', logo: 'partners/pella' }, { name: ' ' }] }, { tier: 'Empty', names: [] }] };
  assert.deepEqual(recapSponsors(gala26, [gala26], doc), [{ tier: 'Gold Sponsor', size: 'md', names: [{ name: 'Pella', logo: 'partners/pella' }] }]);
  assert.deepEqual(recapSponsors(gala26, [gala26, gala27], doc), [], 'an older gala never shows next year’s list');
  const own = [{ tier: 'Title Sponsor', size: 'xl', names: [{ name: 'Kids R Kids' }] }];
  assert.deepEqual(recapSponsors({ ...gala26, sponsors: own }, [gala26, gala27], doc).map((t) => t.tier), ['Title Sponsor']);
});

test('levels get a logo wall; named moments read like a program', () => {
  // The 2026 gala's list, as the Gala editor has it (src/content/site/gala.json comes from D1, not git)
  const gala = [
    { tier: 'Diamond Sponsor', size: 'xl', names: [{ name: 'Kids R Kids Corporate' }] },
    { tier: 'Platinum Sponsor', size: 'lg', names: [{ name: 'Pella' }, { name: 'Jackson Health Care' }] },
    { tier: 'Gold Sponsor', size: 'md', names: [{ name: 'Five Arrows Farms' }, { name: 'Real Floors Commercial' }] },
    { tier: 'Silver Sponsor', size: 'md', names: [{ name: 'Crosby Design Group' }, { name: 'Paul & Adro Nielsen' }] },
    { tier: 'Signature Cocktail Sponsor', size: 'md', names: [{ name: 'Paulson Mitchell Wise' }] },
    { tier: 'Cigar Rolling Sponsor', size: 'md', names: [{ name: 'Crosby Design Group' }] },
  ];
  const { levels, moments } = splitSponsors(gala);
  assert.ok(levels.some((t) => /diamond/i.test(t.tier)) && levels.some((t) => /silver/i.test(t.tier)), levels.map((t) => t.tier).join());
  assert.deepEqual(moments.map((t) => momentName(t.tier)), ['Signature Cocktail', 'Cigar Rolling']);
  const golf = splitSponsors([
    { tier: 'Hole Sponsor', size: 'md', names: Array.from({ length: 14 }, (_, i) => ({ name: `H${i}` })) },
    { tier: 'Closest to the Pin Sponsor', size: 'md', names: [{ name: 'A' }, { name: 'B' }] },
    { tier: 'Gold Sponsor', size: 'lg', names: [{ name: 'C' }] },
  ]);
  assert.deepEqual(golf.levels.map((t) => t.tier), ['Hole Sponsor', 'Gold Sponsor']);
  assert.deepEqual(golf.moments.map((t) => momentName(t.tier)), ['Closest to the Pin']);
  assert.equal(momentName('Putting Contest Sponsors'), 'Putting Contest');
  assert.equal(sponsorCount([{ tier: 'A', names: [{ name: 'Crosby' }] }, { tier: 'B', names: [{ name: 'crosby' }, { name: 'Pella' }] }]), 2);
});

test('the recap’s words: night for the gala, the team’s own note when there is one, at most four numbers', () => {
  assert.match(recapLead(gala26, { photos: 86, sponsors: 17 }), /at You42 Studios on August 22\. Here’s the night in photos, followed by the sponsors/);
  assert.match(recapLead(golf26, { photos: 0, sponsors: 51 }), /pictures are on the way.*made the day possible/);
  assert.equal(recapLead({ ...gala26, recapNote: ' What a night. ' }), 'What a night.');
  assert.deepEqual(cleanHighlights([{ value: '350', label: 'Guests' }, { value: '', label: 'Half' }, { value: '1', label: 'a' }, { value: '2', label: 'b' }, { value: '3', label: 'c' }, { value: '4', label: 'd' }]).map((h) => h.value), ['350', '1', '2', '3']);
});

test('planRecaps: when next year’s gala is added, this year keeps its photos and sponsors', () => {
  const after = photo('2026-09-24T15:32:21Z', 'dsc-7362');
  const asOfDoc = { galleryPhotos: [after], sponsors: [{ tier: 'Diamond Sponsor', size: 'xl', names: [{ name: 'Kids R Kids' }] }] };
  const nowDoc = { galleryPhotos: [after], sponsors: [{ tier: 'Diamond Sponsor', size: 'xl', names: [{ name: 'Next Year Co' }] }] };
  // Only the 2026 gala: nothing to keep yet, it reads the Gala editor live
  assert.deepEqual(planRecaps([gala26], { gala: nowDoc }, { today: OCT_21 }).saves, []);

  const p = planRecaps([gala26, gala27], { gala: nowDoc }, { today: OCT_21, asOf: { [gala27.slug]: { doc: asOfDoc, trusted: true } }, nowIso: 'T' });
  assert.equal(p.saves.length, 1);
  assert.equal(p.saves[0].slug, gala26.slug);
  assert.deepEqual(p.saves[0].after.photos.map((x) => x.id), [after.id]);
  assert.deepEqual(p.saves[0].after.sponsors[0].names.map((n) => n.name), ['Kids R Kids'], 'the list as it was, not next year’s');
  assert.equal(p.saves[0].after.recapSaved, 'T');
  assert.deepEqual(p.over, [gala26.slug]);

  // No saved version and an old doc: photos only (the sponsors may already be next year's)
  const q = planRecaps([gala26, gala27], { gala: nowDoc }, { today: OCT_21, asOf: { [gala27.slug]: { doc: nowDoc, trusted: false } } });
  assert.equal(q.saves[0].after.sponsors, undefined);
  // Saved once, never again; its own photos are left alone
  assert.deepEqual(planRecaps([{ ...gala26, recapSaved: 'x' }, gala27], { gala: nowDoc }, { today: OCT_21 }).saves, []);
  const own = planRecaps([{ ...gala26, photos: [{ id: 'events/own/1', alt: '' }] }, gala27], { gala: nowDoc }, { today: OCT_21, asOf: { [gala27.slug]: { doc: asOfDoc, trusted: true } } });
  assert.deepEqual(own.saves[0].after.photos.map((x) => x.id), ['events/own/1']);
});

async function world(events, docs) {
  const DB = await createD1({ schemaFiles: [`${ROOT}scripts/schema.sql`] });
  await ensureHistory(DB);
  for (const e of events) await DB.prepare('INSERT INTO events (slug, title, date, status, data) VALUES (?, ?, ?, ?, ?)').bind(e.slug, e.title, e.date, e.status, JSON.stringify(e)).run();
  for (const [k, v] of Object.entries(docs)) await DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind(k, JSON.stringify(v)).run();
  const hooks = [];
  const fetchImpl = async (url) => { hooks.push(url); return new Response('{"result":{"id":"b1"}}', { status: 200 }); };
  return { DB, hooks, fetchImpl, env: { DB, CF_PAGES_DEPLOY_HOOK: 'https://hook.test/deploy' } };
}

test('the morning after an event, the site rebuilds itself once', async () => {
  const w = await world([gala26, golf26, volunteer], { gala: { galleryPhotos: [], sponsors: [] } });
  // First run (Oct 21): galas and golf already built as recaps, nothing to do
  let r = await runEventRecaps(w.env, { now: at('2026-10-21T14:00:00Z'), fetchImpl: w.fetchImpl });
  assert.deepEqual(r.newlyOver, []);
  assert.equal(w.hooks.length, 0);
  // Build Day is Sept 12 in this world, so it was over too; add one that ends tonight
  const party = { title: 'Fall Party', slug: 'fall-party', date: '2026-10-21', location: 'Roswell', status: 'upcoming', photos: [] };
  await w.DB.prepare('INSERT INTO events (slug, title, date, status, data) VALUES (?, ?, ?, ?, ?)').bind(party.slug, party.title, party.date, party.status, JSON.stringify(party)).run();
  r = await runEventRecaps(w.env, { now: at('2026-10-22T03:00:00Z'), fetchImpl: w.fetchImpl }); // 11 PM on party night
  assert.deepEqual(r.newlyOver, []);
  r = await runEventRecaps(w.env, { now: at('2026-10-22T04:15:00Z'), fetchImpl: w.fetchImpl }); // 12:15 AM
  assert.deepEqual(r.newlyOver, ['fall-party']);
  assert.equal(r.deployed, true);
  assert.deepEqual(w.hooks, ['https://hook.test/deploy']);
  r = await runEventRecaps(w.env, { now: at('2026-10-22T04:45:00Z'), fetchImpl: w.fetchImpl });
  assert.equal(w.hooks.length, 1, 'once');
  const audit = await w.DB.prepare("SELECT user_email FROM audit_log WHERE action = 'deployed'").all();
  assert.deepEqual(audit.results.map((x) => x.user_email), [SYNC_USER]);
});

test('without a deploy hook the rebuild waits, and the heartbeat paces itself', async () => {
  const w = await world([gala26], {});
  delete w.env.CF_PAGES_DEPLOY_HOOK;
  await runEventRecaps(w.env, { now: at('2026-08-20T14:00:00Z'), fetchImpl: w.fetchImpl });
  const r = await runEventRecaps(w.env, { now: at('2026-08-23T14:00:00Z'), fetchImpl: w.fetchImpl });
  assert.equal(r.deployed, false);
  const state = JSON.parse((await w.DB.prepare("SELECT value FROM event_recap_state WHERE key = 'state'").first()).value);
  assert.equal(state.deployPending, true);
  assert.deepEqual(state.unannounced, [gala26.slug]);
  // A run 5 minutes later is skipped (every 15, or 10 after a waiting rebuild)
  assert.equal(await maybeRunEventRecaps(w.env, { now: at('2026-08-23T14:05:00Z'), fetchImpl: w.fetchImpl }), null);
});

test('2027 is added: 2026 keeps the sponsors the Gala editor had then, saved like an admin save', async () => {
  const after = photo('2026-09-24T15:32:21Z', 'dsc-7362');
  const then = { galleryPhotos: [after], sponsors: [{ tier: 'Diamond Sponsor', size: 'xl', names: [{ name: 'Kids R Kids', logo: 'partners/kids-r-kids' }] }] };
  const now = { galleryPhotos: [after], sponsors: [{ tier: 'Diamond Sponsor', size: 'xl', names: [{ name: 'Next Year Co' }] }] };
  const w = await world([gala26, gala27], { gala: now });
  await w.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('site', 'gala', ?, 'save', 'staff', '2026-12-01T10:00:00.000Z')").bind(JSON.stringify(then)).run();
  await w.DB.prepare("INSERT INTO audit_log (user_email, action, entity_type, entity_slug, entity_name, created_at) VALUES ('staff', 'created', 'events', ?, '2027', '2027-01-05 09:00:00')").bind(gala27.slug).run();
  await w.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('site', 'gala', ?, 'save', 'staff', '2027-01-06T10:00:00.000Z')").bind(JSON.stringify(now)).run();

  const r = await runEventRecaps(w.env, { now: at('2027-01-06T12:00:00Z'), fetchImpl: w.fetchImpl });
  assert.deepEqual(r.saved, [gala26.slug]);
  const saved = JSON.parse((await w.DB.prepare('SELECT data FROM events WHERE slug = ?').bind(gala26.slug).first()).data);
  assert.deepEqual(saved.photos.map((p) => p.id), [after.id]);
  assert.deepEqual(cleanSponsors(saved.sponsors)[0].names.map((n) => n.name), ['Kids R Kids']);
  assert.ok(saved.recapSaved);
  const log = await w.DB.prepare("SELECT user_email, entity_slug FROM audit_log WHERE action = 'updated'").all();
  assert.deepEqual(log.results, [{ user_email: SYNC_USER, entity_slug: gala26.slug }]);
  // Next pass: nothing more to save
  assert.deepEqual((await runEventRecaps(w.env, { now: at('2027-01-06T12:30:00Z'), fetchImpl: w.fetchImpl })).saved, []);
});

test('the Slack card says what the page shows now, and asks for photos when there are none', () => {
  const doc = { galleryPhotos: [], sponsors: [{ tier: 'Gold', names: [{ name: 'A' }, { name: 'B' }] }] };
  const card = recapCard(gala26, [gala26], { gala: doc });
  assert.match(card.plain || card.text, /Evening of Sunshine 2026 page is now its thank-you/);
  const json = JSON.stringify(card.blocks);
  assert.match(json, /photos are on the way/);
  assert.match(json, /Gala editor’s Gallery tab/);
  assert.match(json, /sunshineonaranneyday\.com\/events\/gala\//);
  const withPhotos = JSON.stringify(recapCard(gala26, [gala26], { gala: { ...doc, galleryPhotos: [photo('2026-09-24T15:32:21Z', 'x')] } }).blocks);
  assert.doesNotMatch(withPhotos, /What to do/);
});
