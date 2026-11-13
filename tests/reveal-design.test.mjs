/**
 * A kid's design on their reveal screen: when it opens, what it shows, and
 * that nothing of it (nor the family's address) gets out early.
 * public/admin/reveal-design.js, functions/api/reveal-design.js,
 * kids-shared.js kidRecord (before-only pairs, design boards).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  DESIGN_LEAD_MS, BEFORE_SHOWN, revealSlides, designWindow, kindFromText, suggestBefores, addressWords,
  needsTitleCrop, planKind, normalizePlanType, completePairs, isRevealed, pagePlans, pageBefores,
  onPage, keptOff, pageState, revealPlaces, revealMoveTo, beforePhotosOf, freeBeforePlaces, pagePairs,
} from '../public/admin/reveal-design.js';
import { beforeAfterUrls } from '../functions/api/_project-email.js';
import { kidRecord } from '../public/admin/kids-shared.js';
import { onRequestGet } from '../functions/api/reveal-design.js';

const NOW = Date.parse('2026-11-18T19:30:00Z'); // 2:30 PM Eastern, reveal day
const STARTS = '2026-11-18T21:00:00.000Z';      // 4:00 PM Eastern
const img = (n) => `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/${n}/public`;
const DYLAN = {
  name: 'Dylan', slug: 'dylan-2026', status: 'in-progress', publishStatus: 'published',
  // Photos → Before photos (Peter, Nov 12 2026: "they should go into photos, not the before and after section"), each
  // looked at (staff added them)
  beforePhotos: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ url: img(`before-${n}.jpg`), alt: '', room: n === 1 ? 'Bathroom' : '', looked: 'staff' })),
  // A pair being made: never on the reveal screen
  beforeAfterPhotos: [{ before: img('pair-before.jpg'), after: '', room: '', beforeAlt: '', afterAlt: '' }],
  plans: [
    { url: img('board-1.png'), label: 'Therapy room design board', type: 'board' },
    { url: img('plan-2-notitle.png'), label: 'Proposed floor plan', type: 'proposed', w: 2400, h: 1600, addressCheck: 'wiped' },
    { url: img('plan-1.png'), label: 'Existing floor plan', type: 'as-built', addressCheck: 'checked' },
  ],
};

test('the slides tell the story in order: before photos (six at most), as-built, proposed; never a design board (Peter, Nov 12 2026)', () => {
  const s = revealSlides(DYLAN);
  assert.deepEqual(s.map((x) => x.kind), [...Array(BEFORE_SHOWN).fill('before'), 'as-built', 'proposed']);
  assert.equal(s[0].caption, 'Bathroom');
  assert.equal(s[1].caption, 'Dylan’s room today');
  assert.equal(s[0].kicker, 'Before');
  assert.equal(s[6].caption, 'The floor plan today');
  assert.equal(s[7].caption, 'The new floor plan');
  // Each picture says what it is, on it (Peter, Nov 11 2026): the room before, the existing plan, the proposed one
  assert.deepEqual(s.map((x) => x.badge), [...Array(BEFORE_SHOWN).fill('Before'), 'Existing', 'Proposed']);
  assert.equal(revealSlides(DYLAN, { after: true })[6].badge, 'Existing', 'still the existing plan after the reveal');
  // Sizes go along when known
  assert.deepEqual([s[7].w, s[7].h], [2400, 1600]);
  assert.equal(s[6].w, undefined);
});

test('the family\'s address: an untrimmed floor plan is always cropped; a trimmed one and a board are shown whole', () => {
  const s = revealSlides(DYLAN);
  assert.equal(s.find((x) => x.kind === 'as-built').crop, true);
  assert.equal(s.find((x) => x.kind === 'proposed').crop, false); // -notitle
  // An older plan with no kind and a caption that names it a plan, or an as-built of any caption, is cropped
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Before' }), true);
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Sheet 3', type: 'as-built' }), true);
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Floor plan', type: 'board' }), true);
  assert.equal(needsTitleCrop({ url: img('x-notitle.png'), label: 'Floor plan', type: 'as-built' }), false);
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Mood board', type: 'board' }), false);
});

test('an unrevealed kid\'s drawing goes out only once its address is checked; a board never does', () => {
  const unchecked = { ...DYLAN, plans: [
    { url: img('a.png'), label: 'Existing floor plan', type: 'as-built' },
    { url: img('b.png'), label: 'Proposed', type: 'proposed', addressCheck: 'maybe' },
    { url: img('c.png'), label: 'Proposed', type: 'proposed', addressCheck: 'covered' },
    { url: img('d.png'), label: 'Board', type: 'board' },
  ] };
  assert.deepEqual(revealSlides(unchecked).filter((s) => s.kind !== 'before').map((s) => s.url), [img('c.png')]);
  // Plans from before the check (and before boards had their own kind) never go out here, revealed or not
  const revealed = { ...unchecked, status: 'completed' };
  assert.deepEqual(revealSlides(revealed).filter((s) => s.kind !== 'before').map((s) => s.url), [img('c.png')]);
});

test('a board never plays; a before photo with no room is the kid\'s room "today"', () => {
  assert.deepEqual(revealSlides({ name: 'Max', plans: [{ url: img('b.png'), label: 'Max 2026_Plan Set_09302026', type: 'board' }] }), []);
  const [photo] = revealSlides({ name: 'James', beforePhotos: [{ url: img('a.jpg'), alt: '', looked: 'site' }] });
  assert.equal(photo.caption, 'James’ room today');
  assert.equal(photo.alt, 'James’ room before the makeover');
  // Unsaved uploads (blob:) never go out, and a Before & after pair's before isn't a before photo of the reveal's
  assert.equal(revealSlides({ name: 'A', plans: [{ url: 'blob:abc', type: 'board' }], beforePhotos: [{ url: 'blob:x' }], beforeAfterPhotos: [{ before: img('p.jpg'), after: '' }] }).length, 0);
  assert.equal(revealSlides({ name: 'A', beforeAfterPhotos: [{ before: img('p.jpg'), after: '' }] }).length, 0, 'not before the reveal either');
  // A room revealed before Before photos existed: its replay plays its pairs' befores, as it always did
  const old = revealSlides({ name: 'Dex', status: 'completed', beforeAfterPhotos: [{ before: img('b1.jpg'), after: img('a1.jpg'), room: 'Bedroom', beforeAlt: 'The bedroom before' }] }, { after: true });
  assert.deepEqual(old.map((x) => [x.kind, x.caption, x.alt]), [['before', 'Bedroom', 'The bedroom before']]);
  // ...but one with Before photos plays those
  assert.equal(revealSlides({ name: 'Dex', status: 'completed', beforePhotos: [{ url: img('own.jpg'), looked: 'site' }], beforeAfterPhotos: [{ before: img('b1.jpg'), after: img('a1.jpg') }] })[0].url, img('own.jpg'));
});

test('the kid page: from the confirmed reveal every before photo and the existing then proposed plans, address seen to; from the reveal everything (Peter, Nov 12 2026)', () => {
  const kid = { ...DYLAN, plans: [
    { url: img('p.png'), label: 'Proposed', type: 'proposed', addressCheck: 'wiped' },
    { url: img('e.png'), label: 'Existing', type: 'as-built', addressCheck: 'covered' },
    { url: img('u.png'), label: 'Unchecked', type: 'as-built' },
    { url: img('b.png'), label: 'Board', type: 'board' },
  ] };
  assert.deepEqual(pagePlans(kid), [], 'nothing before the confirm');
  assert.deepEqual(pageBefores(kid), []);
  assert.deepEqual(pagePlans(kid, { confirmed: true }).map((p) => p.url), [img('e.png'), img('p.png')], 'existing first, then proposed; no board; never an unchecked drawing');
  assert.equal(pageBefores(kid, { confirmed: true }).length, 7, 'every before photo, not just the six the reveal screen plays');
  const done = { ...kid, status: 'completed' };
  assert.deepEqual(pagePlans(done).map((p) => p.url), [img('p.png'), img('e.png'), img('u.png'), img('b.png')], 'after the reveal, every plan staff put there, boards too');
  assert.equal(pageBefores(done).length, 7);
  // A drawing brought in from JobTread whose address nobody has seen to stays off, after the reveal too
  const imported = { ...done, plans: [...done.plans, { url: img('jt.png'), label: 'Plan set (3)', type: 'proposed', source: 'jt:SET#3', addressCheck: null }, { url: img('jtok.png'), label: 'Plan set (2)', type: 'as-built', source: 'jt:SET#2', addressCheck: 'wiped' }, { url: img('jtb.png'), label: 'Board', type: 'board', source: 'jt:BRD' }] };
  assert.deepEqual(pagePlans(imported).map((p) => p.url).slice(4), [img('jtok.png'), img('jtb.png')]);
  assert.deepEqual(pagePlans(imported, { revealed: false, confirmed: true }).map((p) => p.url), [img('e.png'), img('jtok.png'), img('p.png')], 'a reveal moved ahead again: as confirmed, no board');
});

test('once the reveal has started the room is "before", not "today"', () => {
  const s = revealSlides(DYLAN, { after: true });
  assert.equal(s[1].caption, 'Dylan’s room before');
  assert.equal(s.find((x) => x.kind === 'as-built').caption, 'The floor plan before');
  assert.equal(s.find((x) => x.kind === 'proposed').caption, 'The new floor plan');
  const reveal = { startsAt: STARTS, confirmed: true };
  assert.equal(designWindow({ kid: DYLAN, reveal, now: Date.parse(STARTS) - 60_000 }).after, false);
  assert.equal(designWindow({ kid: DYLAN, reveal, now: Date.parse(STARTS) + 60_000 }).after, true);
  assert.equal(designWindow({ kid: DYLAN, broadcast: { kidSlug: 'dylan-2026', phase: 'live' }, now: NOW }).after, true);
  assert.equal(designWindow({ kid: DYLAN, broadcast: { kidSlug: 'dylan-2026', phase: 'armed', scheduledAt: STARTS }, now: NOW }).after, false);
});

test('closed until an hour before a confirmed reveal; open from then on', () => {
  const reveal = { startsAt: STARTS, confirmed: true };
  const before = designWindow({ kid: DYLAN, reveal, now: Date.parse(STARTS) - DESIGN_LEAD_MS - 1000 });
  assert.equal(before.open, false);
  assert.equal(before.opensAt, new Date(Date.parse(STARTS) - DESIGN_LEAD_MS).toISOString());
  assert.equal(designWindow({ kid: DYLAN, reveal, now: Date.parse(STARTS) - DESIGN_LEAD_MS }).open, true);
  // During and after the reveal
  assert.equal(designWindow({ kid: DYLAN, reveal, now: Date.parse(STARTS) + 3 * 86_400_000 }).open, true);
  // A tentative reveal ("mid November") never opens it
  assert.equal(designWindow({ kid: DYLAN, reveal: { startsAt: STARTS, confirmed: false }, now: NOW + DESIGN_LEAD_MS }).open, false);
  // No reveal at all
  assert.deepEqual(designWindow({ kid: DYLAN, now: NOW }), { open: false, opensAt: null, after: false });
});

test('the broadcast opens it too: its own time, or its stream being up for this kid', () => {
  const sched = { kidSlug: 'dylan-2026', phase: 'scheduled', scheduledAt: STARTS };
  assert.equal(designWindow({ kid: DYLAN, broadcast: sched, now: NOW }).open, false);
  assert.equal(designWindow({ kid: DYLAN, broadcast: sched, now: Date.parse(STARTS) - DESIGN_LEAD_MS + 1 }).open, true);
  for (const phase of ['armed', 'live', 'ending', 'replay']) {
    assert.equal(designWindow({ kid: DYLAN, broadcast: { kidSlug: 'dylan-2026', phase }, now: NOW - 5 * 86_400_000 }).open, true, phase);
  }
  // Another kid's broadcast says nothing about this one
  assert.equal(designWindow({ kid: DYLAN, broadcast: { kidSlug: 'max', phase: 'live' }, now: NOW }).open, false);
  // The sooner of the two times decides
  assert.equal(designWindow({ kid: DYLAN, reveal: { startsAt: '2026-11-25T21:00:00Z', confirmed: true }, broadcast: sched, now: Date.parse(STARTS) - 30 * 60_000 }).open, true);
});

test('a room revealed long ago isn\'t open here (its design is on its kid page); a hidden profile never', () => {
  assert.equal(designWindow({ kid: { ...DYLAN, status: 'completed' }, now: NOW }).open, false);
  // Revealed this season: still open, and "after"
  const w = designWindow({ kid: { ...DYLAN, status: 'completed' }, reveal: { startsAt: STARTS, confirmed: true }, now: Date.parse(STARTS) + 3 * 86_400_000 });
  assert.deepEqual([w.open, w.after], [true, true]);
  assert.equal(designWindow({ kid: { ...DYLAN, status: 'completed', publishStatus: 'draft' }, now: NOW }).open, false);
  assert.equal(designWindow({ kid: { ...DYLAN, publishStatus: 'draft' }, broadcast: { kidSlug: 'dylan-2026', phase: 'live' }, now: NOW }).open, false);
  assert.equal(isRevealed({ status: 'completed' }), true);
  assert.equal(isRevealed({ status: 'in-progress' }), false);
});

test('a JobTread sheet\'s kind from its title or words', () => {
  assert.equal(kindFromText('A1.0 EXISTING FLOOR PLAN'), 'as-built');
  assert.equal(kindFromText('As-Built Plan'), 'as-built');
  assert.equal(kindFromText('DEMOLITION PLAN'), 'as-built');
  assert.equal(kindFromText('A2.0 PROPOSED FLOOR PLAN'), 'proposed');
  assert.equal(kindFromText('New Floor Plan'), 'proposed');
  assert.equal(kindFromText('Floor Plan'), 'proposed');
  assert.equal(kindFromText('Bathroom Design Board'), 'board');
  assert.equal(kindFromText('MOOD BOARD'), 'board');
  assert.equal(kindFromText('3D Rendering - Shower'), 'board');
  assert.equal(kindFromText('Finishes Board'), 'board');
  assert.equal(kindFromText('COVER SHEET'), null);
  assert.equal(kindFromText('ELECTRICAL PLAN NOTES'), null);
  assert.equal(kindFromText(''), null);
});

test('six before photos spread across the visit; fewer taken stay as they are', () => {
  const list = Array.from({ length: 22 }, (_, i) => i);
  const picked = suggestBefores(list);
  assert.equal(picked.length, 6);
  assert.equal(picked[0], 0);
  assert.equal(picked[5], 21);
  assert.deepEqual(suggestBefores([1, 2, 3]), [1, 2, 3]);
});

test('the address words to wipe: street, its name alone, number, city, zip, family name', () => {
  const w = addressWords({ street: '426 Mountain View Ln', city: 'Marietta', zip: '30064', family: 'Marchena' });
  for (const x of ['426 mountain view ln', 'mountain view', '426', 'marietta', '30064', 'marchena']) assert.ok(w.includes(x), x);
  // Nothing shorter than three letters (it would wipe half the drawing)
  assert.deepEqual(addressWords({ street: '7 Oak St', city: 'X' }).sort(), ['7 oak st', 'oak'].sort());
});

test('plan kinds and pairs keep their shape through the editor\'s record', () => {
  assert.equal(normalizePlanType('board'), 'board');
  assert.equal(normalizePlanType('proposed'), 'proposed');
  assert.equal(normalizePlanType(undefined), 'as-built');
  assert.equal(planKind({ type: 'weird' }), 'as-built');
  const rec = kidRecord({ ...DYLAN, beforePhotos: [...DYLAN.beforePhotos, { url: 'blob:y', alt: '', _key: 'k', _tempId: 'k' }], beforeAfterPhotos: [...DYLAN.beforeAfterPhotos, { before: '', after: img('after.jpg') }, { before: 'blob:x', after: '' }] });
  // Before photos keep their order, alt and room; an unsaved upload isn't kept, nor the editor's keys
  assert.equal(rec.beforePhotos.length, 7);
  assert.deepEqual(rec.beforePhotos[0], { url: img('before-1.jpg'), alt: '', room: 'Bathroom', looked: 'staff' });
  // A pair waiting for its after is kept; an after with no before, or an unsaved upload, isn't
  assert.equal(rec.beforeAfterPhotos.length, 1);
  assert.ok(rec.beforeAfterPhotos.every((p) => p.before && p.after === ''));
  assert.deepEqual(rec.plans.map((p) => p.type), ['board', 'proposed', 'as-built']);
  assert.equal(completePairs(rec.beforeAfterPhotos).length, 0);
  assert.equal(completePairs([{ before: 'a', after: 'b' }, { before: 'c', after: '' }]).length, 1);
});

// ── The endpoint ──

async function makeEnv({ kids = [DYLAN], reveals = null, broadcast = null } = {}) {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, status TEXT, data TEXT NOT NULL)',
  ] });
  for (const k of kids) await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, 2026, k.status, JSON.stringify(k)).run();
  if (reveals) await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('reveals', JSON.stringify(reveals), new Date().toISOString()).run();
  if (broadcast) await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('broadcast', JSON.stringify(broadcast), new Date().toISOString()).run();
  return { DB };
}
const ask = async (env, q) => {
  const res = await onRequestGet({ env, request: new Request(`https://sunshineonaranneyday.com/api/reveal-design${q}`) });
  return { status: res.status, cache: res.headers.get('Cache-Control'), body: await res.json() };
};
const dayOf = (iso) => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 10);

test('the endpoint says nothing of the design before it opens, only when it will', async () => {
  const startsAt = new Date(Date.now() + 3 * 3600e3).toISOString();
  const env = await makeEnv({ reveals: { reveals: [], upcoming: [{ slug: 'dylan-2026', name: 'Dylan', confirmed: true, startsAt, date: dayOf(startsAt) }], updatedAt: new Date().toISOString() } });
  const r = await ask(env, '?kid=dylan-2026');
  assert.equal(r.status, 200);
  assert.equal(r.body.open, false);
  assert.equal(r.body.opensAt, new Date(Date.parse(startsAt) - DESIGN_LEAD_MS).toISOString());
  assert.equal(r.body.slides, undefined);
  assert.ok(!JSON.stringify(r.body).includes('imagedelivery'), 'no picture address before it opens');
  // The edge copy never outlives a minute
  assert.match(r.cache, /max-age=(\d|[1-5]\d|60)\b/);
});

test('the endpoint opens an hour before, and while the stream is up', async () => {
  const startsAt = new Date(Date.now() + 40 * 60_000).toISOString();
  const env = await makeEnv({ reveals: { reveals: [], upcoming: [{ slug: 'dylan-2026', name: 'Dylan', confirmed: true, startsAt, date: dayOf(startsAt) }], updatedAt: new Date().toISOString() } });
  const r = await ask(env, '?kid=dylan-2026');
  assert.equal(r.body.open, true);
  assert.equal(r.body.name, 'Dylan');
  assert.deepEqual(r.body.slides.map((s) => s.kind), [...Array(6).fill('before'), 'as-built', 'proposed']);

  const live = await makeEnv({ broadcast: { phase: 'live', kidSlug: 'dylan-2026', kidName: 'Dylan' } });
  assert.equal((await ask(live, '?kid=dylan-2026')).body.open, true);
  // Max's broadcast doesn't open Dylan's
  const other = await makeEnv({ broadcast: { phase: 'live', kidSlug: 'max', kidName: 'Max' } });
  assert.equal((await ask(other, '?kid=dylan-2026')).body.open, false);
});

test('a reveal from earlier this season keeps it open (after the reveal, before the room is marked done)', async () => {
  const startsAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const env = await makeEnv({ reveals: { reveals: [{ slug: 'dylan-2026', name: 'Dylan', startsAt, date: dayOf(startsAt) }], upcoming: [], updatedAt: new Date().toISOString() } });
  assert.equal((await ask(env, '?kid=dylan-2026')).body.open, true);
});

test('unknown, hidden or badly named kids', async () => {
  const env = await makeEnv({ kids: [DYLAN, { ...DYLAN, slug: 'hidden-kid', name: 'Hidden', status: 'completed', publishStatus: 'draft' }] });
  assert.equal((await ask(env, '?kid=nobody')).status, 404);
  assert.equal((await ask(env, '?kid=hidden-kid')).status, 404);
  assert.equal((await ask(env, '?kid=../etc')).status, 400);
  assert.equal((await ask(env, '')).status, 400);
});

// ── Which before photos may be seen (Peter, Nov 12 2026: "you can review those photos and leave off the ones you think
// arent good to publish? is there a way to keep a photo from publishing?") ──

const look = (n, extra = {}) => ({ url: img(`l-${n}.jpg`), alt: '', room: '', ...extra });

test('a before photo is seen only once someone has looked at it and it isn’t kept off: never one just in from JobTread', () => {
  const fresh = look(1);
  const fine = look(2, { looked: 'site' });
  const off = look(3, { looked: 'site', offPage: true, offWhy: 'A person in it' });
  const staffOn = look(4, { looked: 'staff' });
  const staffOff = look(5, { looked: 'staff', offPage: true });
  assert.deepEqual([fresh, fine, off, staffOn, staffOff].map(pageState), ['waiting', 'on', 'off', 'on', 'off']);
  assert.deepEqual([fresh, fine, off].map(onPage), [false, true, false]);
  assert.deepEqual([fresh, off, staffOff].map(keptOff), [false, true, true]);
  // An old record with offPage but nobody's look is still waiting, so still off
  assert.equal(onPage(look(6, { offPage: false })), false);
  const kid = { ...DYLAN, beforePhotos: [fresh, fine, off, staffOn, staffOff] };
  assert.deepEqual(pageBefores(kid, { confirmed: true }).map((p) => p.url), [fine.url, staffOn.url], 'the kid page');
  assert.deepEqual(pageBefores({ ...kid, status: 'completed' }).map((p) => p.url), [fine.url, staffOn.url], 'after the reveal too');
  assert.deepEqual(beforePhotosOf(kid).map((p) => p.url), [fine.url, staffOn.url]);
  assert.deepEqual(revealSlides(kid).filter((x) => x.kind === 'before').map((x) => x.url), [fine.url, staffOn.url], 'the reveal screen and live page');
  // None on the page: a room revealed long ago still doesn't fall back to its pairs once it has before photos of its own
  assert.deepEqual(beforePhotosOf({ status: 'completed', beforePhotos: [off], beforeAfterPhotos: [{ before: img('p.jpg'), after: img('a.jpg') }] }), []);
});

test('the reveal screen plays the first six on the page: places skip the rest, and moving one in or out goes by those places', () => {
  // 0 on, 1 off, 2..7 on, 8 waiting, 9 on: the six that play are 0, 2, 3, 4, 5, 6
  const list = [look(0, { looked: 'site' }), look(1, { looked: 'site', offPage: true }), ...[2, 3, 4, 5, 6, 7].map((n) => look(n, { looked: 'staff' })), look(8), look(9, { looked: 'site' })];
  assert.deepEqual(revealPlaces(list), [0, null, 1, 2, 3, 4, 5, null, null, null]);
  // Photo 9 onto the screen: in as the last of the six (where 6 was), so 6 steps off
  const to = revealMoveTo(list, 9, true);
  const moved = [...list];
  moved.splice(to, 0, moved.splice(9, 1)[0]);
  assert.deepEqual(revealPlaces(moved).map((p, i) => (p === null ? null : moved[i].url.match(/l-(\d)/)[1])).filter(Boolean), ['0', '2', '3', '4', '5', '9']);
  // Photo 0 off the screen: just past the six, so 7 plays
  const off = revealMoveTo(list, 0, false);
  const out = [...list];
  out.splice(off, 0, out.splice(0, 1)[0]);
  assert.deepEqual(revealPlaces(out).map((p, i) => (p === null ? null : out[i].url.match(/l-(\d)/)[1])).filter(Boolean), ['2', '3', '4', '5', '6', '7']);
  assert.equal(revealPlaces(out)[out.findIndex((p) => p.url === list[0].url)], null);
});

test('places on the reveal screen still free: one kept off takes none, one not looked at yet does', () => {
  assert.equal(freeBeforePlaces({ beforePhotos: [look(1), look(2, { looked: 'site' }), look(3, { looked: 'site', offPage: true })] }), BEFORE_SHOWN - 2);
  assert.equal(freeBeforePlaces({ beforePhotos: [] }), BEFORE_SHOWN);
});

test('saved, a before photo says who looked and whether it’s kept off only when it says something', () => {
  const rec = kidRecord({ ...DYLAN, beforePhotos: [
    look(1),
    look(2, { looked: 'site', offPage: false, offWhy: 'stale' }),
    look(3, { looked: 'site', offPage: true, offWhy: 'A person in it' }),
    look(4, { looked: 'staff', offPage: true, offWhy: '' }),
  ] });
  assert.deepEqual(rec.beforePhotos.map(({ url, alt, room, ...rest }) => rest), [
    {}, { looked: 'site' }, { looked: 'site', offPage: true, offWhy: 'A person in it' }, { looked: 'staff', offPage: true },
  ]);
});

test('a Before & after pair is off the page with its before photo: kept off, or not looked at yet, the pair is too', () => {
  const on = look(1, { looked: 'site' });
  const off = look(2, { looked: 'site', offPage: true, offWhy: 'A person in it' });
  const waiting = look(3);
  const pair = (before, n) => ({ before, after: img(`after-${n}.jpg`), room: '', beforeAlt: '', afterAlt: '' });
  const kid = { status: 'completed', beforePhotos: [on, off, waiting], beforeAfterPhotos: [
    pair(on.url, 1), pair(off.url, 2), pair(waiting.url, 3),
    pair(img('own-upload.jpg'), 4), // a pair's own before, never one of the before photos: stands as it always did
    { before: on.url, after: '' }, // half a pair: never
  ] };
  assert.deepEqual(pagePairs(kid).map((p) => p.after.match(/after-(\d)/)[1]), ['1', '4']);
  // The reveal email's before and after: the same pairs
  assert.equal(beforeAfterUrls(kid).filter((u) => /after-/.test(u)).length, 2);
  assert.ok(!beforeAfterUrls(kid).some((u) => /l-2\.jpg|l-3\.jpg/.test(u)), 'never the kept-off or waiting before');
});
