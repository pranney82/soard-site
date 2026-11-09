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
  needsTitleCrop, planKind, normalizePlanType, completePairs, isRevealed,
} from '../public/admin/reveal-design.js';
import { kidRecord } from '../public/admin/kids-shared.js';
import { onRequestGet } from '../functions/api/reveal-design.js';

const NOW = Date.parse('2026-11-18T19:30:00Z'); // 2:30 PM Eastern, reveal day
const STARTS = '2026-11-18T21:00:00.000Z';      // 4:00 PM Eastern
const img = (n) => `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/${n}/public`;
const DYLAN = {
  name: 'Dylan', slug: 'dylan-2026', status: 'in-progress', publishStatus: 'published',
  beforeAfterPhotos: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ before: img(`before-${n}.jpg`), after: '', room: n === 1 ? 'Bathroom' : '', beforeAlt: '', afterAlt: '' })),
  plans: [
    { url: img('board-1.png'), label: 'Therapy room design board', type: 'board' },
    { url: img('plan-2-notitle.png'), label: 'Proposed floor plan', type: 'proposed', w: 2400, h: 1600, addressCheck: 'wiped' },
    { url: img('plan-1.png'), label: 'Existing floor plan', type: 'as-built', addressCheck: 'checked' },
  ],
};

test('the slides tell the story in order: before photos (six at most), as-built, proposed, boards', () => {
  const s = revealSlides(DYLAN);
  assert.deepEqual(s.map((x) => x.kind), [...Array(BEFORE_SHOWN).fill('before'), 'as-built', 'proposed', 'board']);
  assert.equal(s[0].caption, 'Bathroom');
  assert.equal(s[1].caption, 'Dylan’s room today');
  assert.equal(s[0].kicker, 'Before');
  assert.equal(s[6].caption, 'The floor plan today');
  assert.equal(s[7].caption, 'The new floor plan');
  assert.equal(s[8].caption, 'Therapy room design board');
  assert.equal(s[8].kicker, 'The look');
  // Sizes go along when known
  assert.deepEqual([s[7].w, s[7].h], [2400, 1600]);
  assert.equal(s[6].w, undefined);
});

test('the family\'s address: an untrimmed floor plan is always cropped; a trimmed one and a board are shown whole', () => {
  const s = revealSlides(DYLAN);
  assert.equal(s.find((x) => x.kind === 'as-built').crop, true);
  assert.equal(s.find((x) => x.kind === 'proposed').crop, false); // -notitle
  assert.equal(s.find((x) => x.kind === 'board').crop, false);
  // An older plan with no kind and a caption that names it a plan, or an as-built of any caption, is cropped
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Before' }), true);
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Sheet 3', type: 'as-built' }), true);
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Floor plan', type: 'board' }), true);
  assert.equal(needsTitleCrop({ url: img('x-notitle.png'), label: 'Floor plan', type: 'as-built' }), false);
  assert.equal(needsTitleCrop({ url: img('x.png'), label: 'Mood board', type: 'board' }), false);
});

test('an unrevealed kid\'s drawing goes out only once its address is checked; a board and a revealed kid\'s plans don\'t wait', () => {
  const unchecked = { ...DYLAN, plans: [
    { url: img('a.png'), label: 'Existing floor plan', type: 'as-built' },
    { url: img('b.png'), label: 'Proposed', type: 'proposed', addressCheck: 'maybe' },
    { url: img('c.png'), label: 'Proposed', type: 'proposed', addressCheck: 'covered' },
    { url: img('d.png'), label: 'Board', type: 'board' },
  ] };
  assert.deepEqual(revealSlides(unchecked).filter((s) => s.kind !== 'before').map((s) => s.url), [img('c.png'), img('d.png')]);
  // Plans from before the check (and before boards had their own kind) never go out here, revealed or not
  const revealed = { ...unchecked, status: 'completed' };
  assert.deepEqual(revealSlides(revealed).filter((s) => s.kind !== 'before').map((s) => s.url), [img('c.png'), img('d.png')]);
});

test('a caption that is a file name never shows on a board', () => {
  const [board] = revealSlides({ name: 'Max', plans: [{ url: img('b.png'), label: 'Max 2026_Plan Set_09302026', type: 'board' }] });
  assert.equal(board.caption, 'The design');
  assert.equal(board.alt, 'Max 2026_Plan Set_09302026');
  const [photo] = revealSlides({ name: 'James', beforeAfterPhotos: [{ before: img('a.jpg'), after: '' }] });
  assert.equal(photo.caption, 'James’ room today');
  // Unsaved uploads (blob:) never go out
  assert.equal(revealSlides({ name: 'A', plans: [{ url: 'blob:abc', type: 'board' }], beforeAfterPhotos: [{ before: 'blob:x' }] }).length, 0);
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
  const rec = kidRecord({ ...DYLAN, beforeAfterPhotos: [...DYLAN.beforeAfterPhotos, { before: '', after: img('after.jpg') }, { before: 'blob:x', after: '' }] });
  // A before photo waiting for its after is kept; an after with no before, or an unsaved upload, isn't
  assert.equal(rec.beforeAfterPhotos.length, 7);
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
  assert.deepEqual(r.body.slides.map((s) => s.kind), [...Array(6).fill('before'), 'as-built', 'proposed', 'board']);

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
