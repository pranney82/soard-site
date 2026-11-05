/**
 * What makeovers cost (functions/api/_makeover-costs.js, public/admin/makeover-costs-shared.js), the sponsors'
 * pledges (_sponsor-pledges.js), the families the board reads (_board-families.js), and the board page's routes for
 * them (board-portal.js). Made-up families and costs only (the repo is public). Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  TYPES, roomList, typeOf, median, middleHalf, rowsOf, estimateFor, typicalLately, planOf, pipelineOf, recentSeasons, cashOf, operatingOf, OPERATING_BALANCE,
} from '../public/admin/makeover-costs-shared.js';
import { costsFrom, looseMatch, recordFromJob, isFinished, makeoverCostsNow, orderWaiting, PAGE_MAX_AGE_MS } from '../functions/api/_makeover-costs.js';
import { savePledge, pledgesFor, cleanAmount } from '../functions/api/_sponsor-pledges.js';
import { familiesList, familyOne, ageFrom, nameFromEmail } from '../functions/api/_board-families.js';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { saveScorecard } from '../functions/api/_applicant-scores.js';
import { getSettings, saveSettings, liveNumbers, takeSnapshot, ensureSchema, createMeeting, getMeeting } from '../functions/api/_board.js';
import { liveOfTitle, cleanMeeting, costLines, SHOW_KINDS, DEFAULT_TEMPLATE } from '../public/admin/board-shared.js';
import { criteriaOf, SHEET_RUBRIC } from '../public/admin/scoring-shared.js';
import * as portal from '../functions/api/board-portal.js';
import * as sponsorsAdmin from '../functions/api/sponsors-admin.js';

const STATUS = '22P52qfFub9b';
const job = (o) => ({ id: o.id, name: o.name, description: o.description ?? null, createdAt: o.createdAt || '2025-02-01T12:00:00Z', closedOn: o.closedOn ?? null, actualCost: o.cost ?? null, location: { account: { name: o.account || o.name } }, customFieldValues: { nodes: o.status ? [{ value: o.status }] : [] } });
const kid = (slug, name, year, rooms, extra = {}) => ({ slug, name, year, jobtreadJobId: extra.jobtreadJobId || null, rooms, sponsors: extra.sponsors || [], url: `/kids/${slug}/`, ...extra });
const m = (key, type, season, cost) => ({ key, name: key, type, season, cost, rooms: [] });

// ─── The math ───────────────────────────────────────────────────────

test('rooms read as one of the chart’s types: a ramp goes with the room it serves', () => {
  assert.deepEqual(roomList('Accessible Bathroom,Wheelchair Ramp'), ['Accessible Bathroom', 'Wheelchair Ramp']);
  assert.equal(typeOf(['Accessible Bathroom']), 'bathroom');
  assert.equal(typeOf(['Accessible Bathroom', 'Wheelchair Ramp']), 'bathroom');
  assert.equal(typeOf(['Dream Bedroom']), 'bedroom');
  assert.equal(typeOf(['Therapy Room']), 'therapy');
  assert.equal(typeOf(['Accessible Bathroom', 'Dream Bedroom']), 'bath-bed');
  assert.equal(typeOf(['Chair Lift', 'Dream Bedroom', 'Accessible Bathroom']), 'bath-bed');
  assert.equal(typeOf(['Dream Bedroom', 'Therapy Room']), 'mixed');
  assert.equal(typeOf(['Accessible Bathroom', 'Dream Bedroom', 'Therapy Room']), 'mixed');
  assert.equal(typeOf([], { community: true }), 'community');
  assert.equal(TYPES.length, 6);
});

test('the typical cost is the middle one, and the middle half needs four', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(middleHalf([1, 2, 3]), null);
  assert.deepEqual(middleHalf([10, 20, 30, 40]), { low: 17.5, high: 32.5 });
});

test('rows: each type with its makeovers, cheapest first; a season filter keeps only those', () => {
  const list = [m('a', 'bathroom', 2026, 30000), m('b', 'bathroom', 2025, 10000), m('c', 'bedroom', 2024, 5000)];
  const rows = rowsOf(list);
  assert.deepEqual(rows.map((r) => [r.id, r.count, r.typical]), [['bathroom', 2, 20000], ['bedroom', 1, 5000]]);
  assert.deepEqual(rows[0].list.map((x) => x.key), ['b', 'a']);
  assert.deepEqual(rowsOf(list, [2026]).map((r) => r.id), ['bathroom']);
  assert.deepEqual(recentSeasons(list), [2026, 2025]);
});

test('one more makeover’s likely cost: its type lately, then its type, then every type lately, then all', () => {
  const list = [
    m('t1', 'therapy', 2026, 18000), m('t2', 'therapy', 2025, 3000), m('t3', 'therapy', 2025, 22000), m('t4', 'therapy', 2024, 6000),
    m('b1', 'bedroom', 2024, 5000), m('b2', 'bedroom', 2026, 7000),
    m('x1', 'bathroom', 2026, 40000), m('x2', 'bathroom', 2025, 30000),
  ];
  assert.deepEqual(estimateFor('therapy', list), { cost: 18000, count: 3, basis: 'type-recent', type: 'therapy', seasons: [2026, 2025] });
  // Two dream bedrooms lately isn't enough: every year's has only two too, so every type lately
  assert.equal(estimateFor('bedroom', list).basis, 'all-recent');
  assert.equal(estimateFor('community', [m('c', 'community', 2024, 9000)]).basis, 'all');
  assert.equal(estimateFor('bathroom', []), null);
  assert.equal(typicalLately(list).count, 6);
});

test('the plan: what’s over the operating balance covers families in order, and says what the next needs', () => {
  const list = [m('a', 'therapy', 2026, 20000), m('b', 'therapy', 2025, 20000), m('c', 'therapy', 2026, 20000)];
  const fam = (name, pledged = 0) => ({ key: name, name, type: 'therapy', pledged });
  // $545,000 in the bank: $45,000 over; two families at $20,000, the second with $5,000 pledged
  const p = planOf({ cash: 545000, makeovers: list, waiting: [fam('Ann'), fam('Ben', 5000), fam('Cy')] });
  assert.equal(p.free, 45000);
  assert.equal(p.operating, OPERATING_BALANCE);
  assert.deepEqual(p.families.map((f) => [f.name, f.net, f.covered]), [['Ann', 20000, true], ['Ben', 15000, true], ['Cy', 20000, false]]);
  assert.equal(p.covered, 2);
  assert.equal(p.need, 10000, 'Cy needs what the money doesn’t cover');
  assert.equal(p.more, 0, 'no room for more while a family waits');
  // Under the operating balance: nothing over it, and the first family needs its cost and what the money is short
  const short = planOf({ cash: 480000, makeovers: list, waiting: [fam('Ann')] });
  assert.equal(short.short, 20000);
  assert.equal(short.covered, 0);
  assert.equal(short.need, 40000);
  // Nobody waiting: how many typical makeovers the money starts
  assert.equal(planOf({ cash: 600000, makeovers: list, waiting: [] }).more, 5);
  assert.equal(planOf({ cash: null, makeovers: list }), null);
  // No finished makeover with bills yet: a family's cost isn't known, so nothing says it needs $0
  const unknown = planOf({ cash: 375000, makeovers: [], waiting: [fam('Ann')] });
  assert.equal(unknown.families[0].net, null);
  assert.equal(unknown.families[0].covered, false);
  assert.equal(unknown.need, null);
  assert.equal(unknown.more, 0);
  assert.equal(planOf({ cash: 600000, operating: 550000, makeovers: list }).free, 50000);
});

test('the open jobs come first: what each has still to come (its budget, else its rooms’ median) is spoken for', () => {
  const list = [m('a', 'therapy', 2026, 20000), m('b', 'therapy', 2025, 20000), m('c', 'therapy', 2026, 20000)];
  const underway = [
    { key: 'u1', name: 'Kim', type: 'therapy', paid: 8000, budget: 30000 },   // budget: 22,000 to come
    { key: 'u2', name: 'Lee', type: 'therapy', paid: 5000, budget: null },    // no budget: the median, 20,000, less 5,000
    { key: 'u3', name: 'Mo', type: 'therapy', paid: 35000, budget: 30000 },   // over its budget: nothing more expected here
  ];
  const p = planOf({ cash: 560000, makeovers: list, underway, waiting: [{ key: 'w', name: 'Ann', type: 'therapy' }] });
  assert.deepEqual(p.jobs.map((j) => [j.name, j.left, j.basis]), [['Kim', 22000, 'budget'], ['Lee', 15000, 'median'], ['Mo', 0, 'budget']]);
  assert.equal(p.over, 60000);
  assert.equal(p.committed, 37000);
  assert.equal(p.paid, 48000);
  assert.equal(p.free, 23000, 'over the operating balance, less what’s still to come');
  assert.equal(p.families[0].covered, true);
  // Less in the bank: the open jobs take it all, and Ann needs her 20,000 and the 7,000 the money is short
  const q = planOf({ cash: 530000, makeovers: list, underway, waiting: [{ key: 'w', name: 'Ann', type: 'therapy' }] });
  assert.equal(q.free, -7000);
  assert.equal(q.need, 27000);
  // No way to tell (no budget, no completed makeover to go by): counted as unknown, never as $0 spoken for
  const r = planOf({ cash: 600000, makeovers: [], underway: [{ key: 'u', name: 'Zed', type: 'bathroom', paid: 0, budget: null }] });
  assert.equal(r.unknown, 1);
  assert.equal(r.committed, 0);
});

test('the recommended pipeline: how many SOARD builds, less what’s already in line, never what the money allows', () => {
  const today = '2026-11-04';
  const reveals = [
    { on: '2026-02-20', done: true }, { on: '2026-05-08', done: true }, { on: '2026-09-25', done: true },
    { on: '2026-10-09', done: false },                                   // a date passed, not done: not this year's pace
    { on: '2026-11-20', done: false }, { on: '2026-12-12', done: false }, // set for the rest of the year
    { on: '2025-11-20', done: true },                                    // last year's
  ];
  const underway = [
    { name: 'Lia', kind: 'kid', status: 'Mobilization', revealOn: '2026-11-20' },
    { name: 'Pat', kind: 'kid', status: 'Mobilization', revealOn: '2026-12-12' },
    { name: 'Abe', kind: 'kid', status: 'Design', revealOn: '2026-10-09' },  // no season, its date passed: carries over
    { name: 'Oak School', kind: 'community', status: 'Design', revealOn: null, season: 2027 },  // next season's
    { name: 'Kai', kind: 'kid', status: 'Design', revealOn: null, season: 2026 },  // this season's, finishing late: not next's
  ];
  const waiting = [{ name: 'Jon' }, { name: 'Bo', season: 2026 }];
  const p = pipelineOf({ reveals, underway, waiting, plan: { season: '2027', capacity: {} }, today });
  assert.deepEqual([p.year, p.done, p.scheduled, p.pace, p.lastDay, p.next, p.planned, p.capacity, p.room], [2026, 3, 2, 5, '2026-12-12', 2027, null, 5, 2]);
  assert.deepEqual(p.carry.map((c) => c.name), ['Abe', 'Oak School', 'Jon']);
  // Staff's plan for next season (Applicants → Scores) wins over the pace
  const q = pipelineOf({ reveals, underway, waiting, plan: { season: '2027', capacity: { 2027: 12 } }, today });
  assert.equal(q.capacity, 12);
  assert.equal(q.room, 9);
  // A plan with no reveal on record yet still counts; nothing at all is no pipeline
  assert.equal(pipelineOf({ reveals: [], plan: { capacity: { 2027: 4 } }, today }).room, 4);
  assert.equal(pipelineOf({ reveals: [], today }), null);
});

test('the cash a set of numbers carries, and its operating balance', () => {
  assert.equal(cashOf({ cash: { total: 700, accounts: [{ bank: 'Chase' }] }, books: { cash: { total: 650 } } }), 700, 'a bank besides Mercury first');
  assert.equal(cashOf({ cash: { total: 5, accounts: [{ bank: 'Mercury' }] }, books: { cash: { total: 650 } } }), 650, 'QuickBooks before Mercury alone');
  assert.equal(cashOf({}), null);
  assert.equal(operatingOf({ operating: { balance: 400000 } }), 400000);
  assert.equal(operatingOf({}), 500000);
});

// ─── From JobTread ──────────────────────────────────────────────────

const RECORDS = [
  kid('ava', 'Ava', 2026, ['Accessible Bathroom']),
  kid('ben', 'Ben', 2025, ['Therapy Room']),
  kid('cara', 'Cara', 2025, ['Dream Bedroom']),
  kid('dee', 'Dee', 2024, ['Accessible Bathroom', 'Dream Bedroom']),
  kid('eli', 'Eli & Finn', 2023, ['Accessible Bathroom', 'Therapy Room']),
  kid('gus-2023', 'Gus', 2023, ['Dream Bedroom']),
  kid('gus-2024', 'Gus', 2024, ['Dream Bedroom']),
  kid('hana', 'Hana', 2026, ['Therapy Room'], { sponsors: ['acme'] }),
  { kind: 'community', slug: 'oak-school', name: 'Oak School', year: '2025', status: 'completed', rooms: [], sponsors: [], url: null },
];

test('finished: Closed Done or Warranty, or closed before jobs had a status; never by the job being closed alone', () => {
  assert.equal(isFinished(job({ id: 'j', name: 'x', status: 'Closed Done' })), true, 'open in JobTread, finished');
  assert.equal(isFinished(job({ id: 'j', name: 'x', status: 'Warranty' })), true);
  assert.equal(isFinished(job({ id: 'j', name: 'x', closedOn: '2024-01-01' })), true);
  assert.equal(isFinished(job({ id: 'j', name: 'x', closedOn: '2024-01-01', status: 'Denied' })), false);
  assert.equal(isFinished(job({ id: 'j', name: 'x', status: 'Build' })), false);
});

test('a job named before names carried the season matches by its customer and its years, only when one page fits', () => {
  // "Job 8": the customer's full name, a page in the years it ran
  assert.equal(looseMatch(job({ id: 'j8', name: 'Job 8', account: 'Dee Marie Example', createdAt: '2023-04-01T00:00:00Z', closedOn: '2024-05-01' }), RECORDS)?.slug, 'dee');
  // A season off by one ("Ben Example (2024)" for a 2025 page)
  assert.equal(looseMatch(job({ id: 'jb', name: 'Ben Example (2024)', createdAt: '2023-11-01T00:00:00Z', closedOn: '2025-02-10' }), RECORDS)?.slug, 'ben');
  // "Eli- Bathroom": every word that isn't a room
  assert.equal(looseMatch(job({ id: 'je', name: 'Eli- Bathroom', account: 'Eli Example', createdAt: '2023-01-01T00:00:00Z', closedOn: '2023-09-01' }), RECORDS)?.slug, 'eli');
  // Two pages named Gus in those years: no match, never a guess
  assert.equal(looseMatch(job({ id: 'jg', name: 'Gus- Bedroom', createdAt: '2023-06-01T00:00:00Z', closedOn: '2024-06-01' }), RECORDS), null);
  // A page linked to another job never matches by name
  assert.equal(looseMatch(job({ id: 'jx', name: 'Job 9', account: 'Ava Sample', createdAt: '2025-06-01T00:00:00Z' }), [kid('ava', 'Ava', 2026, [], { jobtreadJobId: 'other' })]), null);
});

test('a finished job no page matches counts only when it says what it was', () => {
  assert.deepEqual(recordFromJob(job({ id: 'jl', name: 'Lou Example (2023)', description: 'Accessible Bathroom,Dream Bedroom', closedOn: '2025-02-03' })), { slug: 'job-jl', name: 'Lou', year: 2023, rooms: ['Accessible Bathroom', 'Dream Bedroom'], sponsors: [], fromJob: true });
  assert.equal(recordFromJob(job({ id: 'js', name: 'Pine Gray', account: 'Pine Gray Middle School', closedOn: '2024-08-01' })).kind, 'community');
  assert.equal(recordFromJob(job({ id: 'jw', name: 'Warranty', description: 'Previous projects that require additional work', closedOn: '2025-03-12' })), null);
  assert.equal(recordFromJob(job({ id: 'jp', name: 'Job 17', account: 'Partly Sunny', closedOn: '2023-09-01' })), null, 'the store’s job');
});

test('costs from the jobs: finished makeovers by page, two jobs for one kid add up, no bills named not counted, waiting families kept', () => {
  const jobs = [
    job({ id: 'j1', name: 'Ava Example (2026)', status: 'Closed Done', cost: 26000 }),
    job({ id: 'j2', name: 'Ben Example (2025)', status: 'Closed Done', cost: 18000.5, closedOn: '2026-03-04' }),
    job({ id: 'j2b', name: 'Ben- Therapy Room', account: 'Ben Example', createdAt: '2024-11-01T00:00:00Z', closedOn: '2025-01-30', cost: 1999.5 }),
    job({ id: 'j3', name: 'Cara Example (2025)', status: 'Closed Done', closedOn: '2026-03-04', cost: null }),
    job({ id: 'j4', name: 'Job 8', account: 'Dee Marie Example', createdAt: '2023-04-01T00:00:00Z', closedOn: '2024-05-01', cost: 24000 }),
    job({ id: 'j5', name: 'Oak School (2025)', status: 'Closed Done', cost: 16000 }),
    job({ id: 'j6', name: 'Hana Example (2026)', status: 'Awaiting Funding' }),
    job({ id: 'j7', name: 'Ivy Example (2026)', status: 'Awaiting Funding', description: null }),
    job({ id: 'j8', name: 'Ava Example (2026)', status: 'Build', cost: 9000 }),
    { ...job({ id: 'j12', name: 'Pine School (2026)', account: 'Pine Academy', status: 'Design' }), budgetCost: { sum: 12000 } },
    job({ id: 'j9', name: 'TEST Ava Example (2026)', status: 'Closed Done', cost: 99999 }),
    job({ id: '22P3HTX9cXn4', name: 'Sunshine Office 2025', status: 'Closed Done', cost: 845 }),
    job({ id: 'j10', name: 'Warranty', description: 'Previous projects that require additional work', closedOn: '2025-03-12', cost: 1500 }),
    job({ id: 'j11', name: 'Lou Example (2023)', description: 'Accessible Bathroom,Dream Bedroom', closedOn: '2025-02-03', cost: 19000 }),
  ];
  const out = costsFrom(jobs, RECORDS);
  const by = Object.fromEntries(out.makeovers.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['Ava', 'Ben', 'Dee', 'Lou', 'Oak School']);
  assert.equal(by.Ava.cost, 26000, 'an open Closed Done job counts; one still building doesn’t');
  assert.equal(by.Ben.cost, 20000, 'a kid’s two jobs add up');
  assert.equal(by.Ben.jobs, 2);
  assert.equal(by.Ben.type, 'therapy');
  assert.equal(by.Dee.type, 'bath-bed');
  assert.equal(by['Oak School'].type, 'community');
  assert.equal(by.Lou.type, 'bath-bed');
  assert.equal(by.Lou.season, 2023);
  assert.deepEqual(out.noBills.map((x) => x.name), ['Cara']);
  assert.equal(out.skipped, 1, 'the warranty job: finished, with bills, not a makeover');
  assert.deepEqual(out.waiting.map((w) => [w.name, w.type]), [['Hana', 'therapy'], ['', 'mixed']]);
  assert.ok(!JSON.stringify(out).includes('99999'), 'a TEST job never counts');
  // Open jobs being built: what's been paid and the budget, furthest along first
  assert.deepEqual(out.underway.map((u) => [u.name, u.status, u.paid, u.budget, u.kind]), [['Ava', 'Build', 9000, null, 'kid'], ['Pine Academy', 'Design', 0, 12000, 'community']]);
  assert.ok(!out.makeovers.some((x) => x.name === 'Ava' && x.cost === 9000 + 26000), 'a job still being built is never a completed makeover’s cost');
});

test('a project’s season is its page’s: next season’s project takes one of next season’s places, whatever the job’s name says', () => {
  const records = [{ kind: 'community', slug: 'elm-school', name: 'Elm School', year: '2027', status: 'in-progress', rooms: [], sponsors: [], url: null }];
  const out = costsFrom([job({ id: 'je', name: 'Elm School (2026)', account: 'Elm School', status: 'Design', createdAt: '2026-09-15T00:00:00Z' })], records);
  assert.deepEqual(out.underway.map((u) => [u.name, u.season]), [['Elm School', 2027]]);
  const p = pipelineOf({ reveals: [{ on: '2026-03-01', done: true }], underway: out.underway, waiting: [], plan: { season: '2027', capacity: { 2027: 15 } }, today: '2026-11-04' });
  assert.deepEqual([p.capacity, p.carry.map((c) => c.name), p.room], [15, ['Elm School'], 14]);
});

// ─── D1: pledges, waiting order, the board's copy ───────────────────

async function db() {
  const DB = await createD1();
  await DB.exec('CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)');
  await DB.exec('CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)');
  await DB.exec('CREATE TABLE partners (slug TEXT PRIMARY KEY, data TEXT)');
  await DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  await DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  const put = (slug, d) => DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.year, JSON.stringify({ slug, ...d })).run();
  await put('ava', { name: 'Ava', year: 2026, roomTypes: ['Accessible Bathroom'], status: 'completed' });
  await put('ben', { name: 'Ben', year: 2025, roomTypes: ['Therapy Room'], status: 'completed' });
  await put('dee', { name: 'Dee', year: 2025, roomTypes: ['Therapy Room'], status: 'completed' });
  await put('hana', { name: 'Hana', year: 2026, roomTypes: ['Therapy Room'], status: 'needs-funding', sponsors: ['acme'], publishStatus: 'draft', heroImage: 'https://imagedelivery.net/abc/hana-photo/public' });
  await put('jo', { name: 'Jo', year: 2026, roomTypes: ['Accessible Bathroom'], status: 'needs-funding' });
  await DB.prepare('INSERT INTO partners (slug, data) VALUES (?, ?)').bind('acme', JSON.stringify({ slug: 'acme', name: 'Acme Builders' })).run();
  return DB;
}
const jtFor = (jobs) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body).query);
    return { ok: true, json: async () => ({ organization: { jobs: { nextPage: null, nodes: jobs } } }) };
  };
  return { fetchImpl, calls };
};

test('a pledge is dollars, kept per kid and sponsor, never on the kid’s record; both empty takes it off', async () => {
  const DB = await db();
  assert.equal(cleanAmount('$25,000'), 25000);
  assert.equal(cleanAmount(''), null);
  assert.throws(() => cleanAmount('-5'), /dollars/);
  assert.deepEqual(await savePledge(DB, { kid: 'hana', partner: 'acme', pledged: '10,000', received: '2500' }, { by: 'pat@soardcharity.com', now: Date.parse('2026-11-04T12:00:00Z') }), { pledged: 10000, received: 2500, updatedAt: '2026-11-04T12:00:00.000Z', by: 'pat@soardcharity.com' });
  assert.equal((await pledgesFor(DB, ['hana'])).hana.acme.pledged, 10000);
  assert.ok(!(await DB.prepare("SELECT data FROM kids WHERE slug = 'hana'").first()).data.includes('10000'), 'the kid’s record (public) never has it');
  assert.equal(await savePledge(DB, { kid: 'hana', partner: 'acme', pledged: '', received: '' }), null);
  assert.deepEqual(await pledgesFor(DB, ['hana']), {});
});

test('the sponsors API: a pledge only for a sponsor the saved page names; the kid’s view carries its pledges', async () => {
  const DB = await db();
  const env = { DB };
  const post = (body) => sponsorsAdmin.onRequestPost({ env, request: new Request('https://x.test/api/sponsors-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), data: { userEmail: 'pat@soardcharity.com' } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await post({ pledge: { kid: 'ben', partner: 'acme', pledged: 5000 } })).status, 409, 'Ben’s page names no sponsor');
  assert.equal((await post({ pledge: { kid: 'nobody', partner: 'acme', pledged: 5000 } })).status, 404);
  const ok = await post({ pledge: { kid: 'hana', partner: 'acme', pledged: 7500, received: 0 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pledge.pledged, 7500);
  const audit = await DB.prepare("SELECT entity_type FROM audit_log WHERE entity_slug = 'hana'").first();
  assert.equal(audit.entity_type, 'sponsor-pledge');
});

test('waiting families: ranked ones first, best score first; each netted by its sponsors’ pledges, named from Applicants without a page', async () => {
  const DB = await db();
  await ensureApplicantSchema(DB);
  const fam = (id, name, jobId, types) => DB.prepare('INSERT INTO applicants (account_id, name, status, year, types, fields, job_id, job_name, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, 'Approved', '2026', JSON.stringify(types), '{}', jobId, `${name} (2026)`, '2026-01-01T00:00:00Z', '2026-11-01T00:00:00Z').run();
  await fam('acctHana01', 'Hana Example', 'jHana', ['Therapy Room']);
  await fam('acctJo0001', 'Jo Example', 'jJo', ['Bathroom']);
  await fam('acctIvy001', 'Ivy Example', 'jIvy', ['Bedroom']);
  const full = { mobility: 5, safety: 5, medical: 5, caregiver: 5, readiness: 5, mission: 5, feasibility: 5, impact: 5, independence: 5, sustainability: 5 };
  const keys = criteriaOf(SHEET_RUBRIC).map((c) => c.key);
  const score = (n) => Object.fromEntries(keys.map((k) => [k, n]));
  await saveScorecard(DB, 'acctJo0001', { evaluator: 'lin@soardcharity.com', name: 'Lin', scores: score(4) });
  await saveScorecard(DB, 'acctHana01', { evaluator: 'lin@soardcharity.com', name: 'Lin', scores: score(3) });
  void full;
  await savePledge(DB, { kid: 'hana', partner: 'acme', pledged: 5000, received: 1000 });
  const waiting = [
    { key: 'k:hana', name: 'Hana', slug: 'hana', kind: 'kid', season: 2026, rooms: ['Therapy Room'], type: 'therapy', jobId: 'jHana', sponsors: ['acme'], since: '2026-02-01T00:00:00Z' },
    { key: 'k:jo', name: 'Jo', slug: 'jo', kind: 'kid', season: 2026, rooms: ['Accessible Bathroom'], type: 'bathroom', jobId: 'jJo', sponsors: [], since: '2026-02-03T00:00:00Z' },
    { key: 'j:jIvy', name: '', slug: null, kind: 'kid', season: 2026, rooms: [], type: 'mixed', jobId: 'jIvy', sponsors: [], since: '2026-01-01T00:00:00Z' },
  ];
  const out = await orderWaiting(DB, waiting);
  assert.deepEqual(out.map((w) => w.name), ['Jo', 'Hana', 'Ivy Example'], 'scored best first, then the rest');
  assert.equal(out[0].score.total, 40);
  assert.equal(out[1].pledged, 5000);
  assert.equal(out[1].received, 1000);
  assert.deepEqual(out[1].sponsors, [{ slug: 'acme', name: 'Acme Builders', pledged: 5000, received: 1000 }]);
  assert.equal(out[2].type, 'bedroom', 'no rooms on a page: what the family asked for');
  assert.ok(out.every((w) => !('jobId' in w)), 'never the job’s id');
});

test('the board’s copy: JobTread at most every 15 minutes, the last good copy when it doesn’t answer', async () => {
  const DB = await db();
  const jobs = [job({ id: 'j1', name: 'Ava Example (2026)', status: 'Closed Done', cost: 26000 }), job({ id: 'jH', name: 'Hana Example (2026)', status: 'Awaiting Funding' })];
  const jt = jtFor(jobs);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const t0 = Date.parse('2026-11-04T12:00:00Z');
  const a = await makeoverCostsNow(env, { fetchImpl: jt.fetchImpl, now: t0 });
  assert.deepEqual(a.makeovers.map((x) => [x.name, x.cost]), [['Ava', 26000]]);
  assert.deepEqual(a.waiting.map((x) => x.name), ['Hana'], 'a draft page’s family still waits');
  assert.equal(a.waiting[0].photo, undefined, 'no photo before the page is public');
  assert.equal(jt.calls.length, 1);
  assert.deepEqual(jt.calls[0].organization.jobs.nodes.customFieldValues.$.where, [['customField', 'id'], '=', STATUS], 'only the Status field (JobTread’s size limit)');
  await makeoverCostsNow(env, { fetchImpl: jt.fetchImpl, now: t0 + 5 * 60000 });
  assert.equal(jt.calls.length, 1, 'a copy under 15 minutes old');
  // A board page reads the heartbeat's copy, never waiting on JobTread, until it's six hours old
  await makeoverCostsNow(env, { fetchImpl: jt.fetchImpl, now: t0 + 3 * 3600000, maxAge: PAGE_MAX_AGE_MS });
  assert.equal(jt.calls.length, 1, 'a page three hours on: the copy, no JobTread');
  await makeoverCostsNow(env, { fetchImpl: jt.fetchImpl, now: t0 + 7 * 3600000, maxAge: PAGE_MAX_AGE_MS });
  assert.equal(jt.calls.length, 2, 'seven hours on (the heartbeat stopped): JobTread');
  const down = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const c = await makeoverCostsNow(env, { fetchImpl: down, now: t0 + 8 * 3600000 });
  assert.equal(c.makeovers.length, 1, 'JobTread down: the last good copy');
  assert.equal(await makeoverCostsNow({ DB: await db() }, { fetchImpl: down }), null);
});

// ─── The board page ─────────────────────────────────────────────────

test('the Qualification Committee’s item shows what makeovers cost, as a new meeting’s template has it', () => {
  assert.equal(liveOfTitle('Qualification Committee'), 'costs');
  assert.equal(liveOfTitle('Selection committee report'), 'costs');
  assert.ok(SHOW_KINDS.includes('costs'));
  assert.equal(DEFAULT_TEMPLATE.flatMap((s) => s.items).find((i) => i.title === 'Qualification Committee').live, 'costs');
  const kept = cleanMeeting({ date: '2026-12-01', sections: [{ title: 'Committee reports', items: [{ title: 'Qualification Committee', live: 'costs' }] }] });
  assert.equal(kept.sections[0].items[0].live, 'costs');
  const lines = costLines({
    costs: { makeovers: [m('Ava', 'therapy', 2026, 20000), m('Ben', 'therapy', 2025, 20000), m('Cy', 'therapy', 2026, 20000)], waiting: [{ key: 'h', name: 'Hana', type: 'therapy', pledged: 0 }] },
    cash: { total: 530000, accounts: [{ bank: 'Chase' }] }, operating: { balance: 500000 },
  });
  assert.match(lines[0], /^Completed makeovers, 2025 and 2026 \(3\): median \$20,000, average \$20,000, low \$20,000, high \$20,000/);
  assert.ok(lines.includes('$30,000 free for new makeovers: the cash over the $500,000 operating balance, less what\'s still to come underway'), lines.join(' | '));
  assert.ok(lines.some((l) => /^Hana \(therapy room\): about \$20,000, covered$/.test(l)));
  assert.ok(lines.every((l) => !/—/.test(l)), 'no em dashes');
});

async function boardEnv() {
  const DB = await db();
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  await DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind('jane-doe', 'Jane Doe', 'team', JSON.stringify({ name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', email: 'jane@soardcharity.com' })).run();
  await DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind('alex-rivera', 'Alex Rivera', 'board', JSON.stringify({ name: 'Alex Rivera', group: 'board', title: 'Board Member' })).run();
  await ensureSchema(DB);
  await ensureApplicantSchema(DB);
  return env;
}
const MEMBER = { slug: 'alex-rivera', name: 'Alex Rivera', email: 'alex.board@example.com' };
const ask = (env, q, data) => portal.onRequestGet({ env, request: new Request(`https://x.test/api/board-portal?${q}`), data, waitUntil: () => {} }).then(async (r) => ({ status: r.status, body: await r.json() }));
const tell = (env, body, data) => portal.onRequestPost({ env, request: new Request('https://x.test/api/board-portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), data, waitUntil: () => {} }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('the operating balance: $500,000 to begin, a Board admin’s to change, locked into a meeting with the costs', async () => {
  const env = await boardEnv();
  assert.equal((await getSettings(env.DB)).operatingBalance, 500000);
  assert.equal((await tell(env, { action: 'operating-balance', amount: '450,000' }, { boardMember: MEMBER })).status, 403, 'a board member can’t');
  const r = await tell(env, { action: 'operating-balance', amount: '$450,000' }, { userEmail: 'jane@soardcharity.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.operatingBalance, 450000);
  await assert.rejects(saveSettings(env.DB, { operatingBalance: 'lots' }, 'jane@soardcharity.com'), /dollars/);
  const jt = jtFor([job({ id: 'j1', name: 'Ava Example (2026)', status: 'Closed Done', cost: 26000 })]);
  const n = await liveNumbers(env, { fetchImpl: jt.fetchImpl });
  assert.equal(n.operating.balance, 450000);
  assert.equal(n.costs.makeovers[0].cost, 26000);
  const made = await createMeeting(env, { date: '2026-12-01', by: 'jane@soardcharity.com' });
  assert.equal(made.sections.flatMap((x) => x.items).find((i) => i.title === 'Qualification Committee')?.live, 'costs', 'a new meeting’s Qualification Committee item shows the costs');
  const locked = await takeSnapshot(env, made.id, { by: 'jane@soardcharity.com', fetchImpl: jt.fetchImpl });
  assert.equal(locked.snapshot.operating.balance, 450000);
  assert.equal(locked.snapshot.costs.makeovers[0].name, 'Ava');
  // A change afterwards never moves what the meeting locked
  await saveSettings(env.DB, { operatingBalance: 600000 }, 'jane@soardcharity.com');
  assert.equal((await getMeeting(env.DB, made.id)).snapshot.operating.balance, 450000);
});

test('the families, to read: the board and its admins only; never how to reach a family, their messages, files or a scorer’s notes', async () => {
  const env = await boardEnv();
  const add = (id, name, status, fields, extra = {}) => env.DB.prepare(`INSERT INTO applicants (account_id, name, status, year, types, fields, address, city, county, contact_name, contact_email, contact_phone, job_id, job_name, created_at, archived_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, name, status, '2027', JSON.stringify(['Bathroom']), JSON.stringify(fields), '12 Elm St, Roswell, GA', 'Roswell', 'Fulton', 'Parent Example', 'parent@example.com', '+15555550100', extra.job || null, extra.job ? `${name} (2027)` : null, '2026-10-01T00:00:00Z', extra.archived || null, '2026-11-01T00:00:00Z').run();
  // (Approved: a 2027 card scores family readiness only after the home visit, and a decision counts as one)
  await add('acctMia001', 'Mia Example', 'Approved', { diagnosis: 'Example diagnosis', birthday: '2017-03-04', mobile: 'No', verbal: 'Yes', referredBy: 'A teacher', denialReason: 'never shown unless denied' });
  await add('acctOld001', 'Old Example', 'Applied', {}, { archived: '2026-10-05T00:00:00Z' });
  await add('acctTest01', 'TEST Example', 'Applied', {});
  await saveScorecard(env.DB, 'acctMia001', { evaluator: 'lin.smith@soardcharity.com', scores: Object.fromEntries(criteriaOf(2).map((c) => [c.key, 4])), notes: 'a private note' });

  assert.equal((await ask(env, 'families', {})).status, 403, 'nobody signed in as the board');
  const list = await ask(env, 'families', { boardMember: MEMBER });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.families.map((f) => f.name), ['Mia Example'], 'not archived, not a test');
  const one = await ask(env, 'family=acctMia001', { boardMember: MEMBER });
  assert.equal(one.status, 200);
  const f = one.body.family;
  assert.equal(f.facts.diagnosis, 'Example diagnosis');
  assert.equal(f.facts.denialReason, undefined, 'a reason only for a family denied');
  assert.equal(f.cards[0].name, 'Lin Smith');
  assert.equal(f.cards[0].scores.mobility, 4);
  const text = JSON.stringify(one.body);
  for (const secret of ['parent@example.com', '+15555550100', '12 Elm St', 'Parent Example', 'a private note', 'lin.smith@']) assert.ok(!text.includes(secret), `never ${secret}`);
  assert.equal((await ask(env, 'family=acctOld001', { boardMember: MEMBER })).status, 404);
  assert.equal((await ask(env, 'family=acctTest01', { boardMember: MEMBER })).status, 404);
  assert.equal((await ask(env, 'family=../x', { boardMember: MEMBER })).status, 400);
  assert.equal((await ask(env, 'families', { userEmail: 'jane@soardcharity.com' })).status, 200, 'a Board admin looking');
  const listed = await familiesList(env);
  assert.ok(!JSON.stringify(listed).includes('parent@example.com'));
});

test('the four numbers: average, median, low and high, with who each end is', async () => {
  const { statsOf } = await import('../public/admin/makeover-costs-shared.js');
  const s = statsOf([m('a', 'bathroom', 2026, 10000), m('b', 'bathroom', 2026, 30000), m('c', 'bedroom', 2025, 50000), m('d', 'therapy', 2025, 2000)]);
  assert.deepEqual([s.count, s.average, s.median, s.low, s.high, s.lowOf.key, s.highOf.key], [4, 23000, 20000, 2000, 50000, 'd', 'c']);
  assert.equal(statsOf([]), null);
});

test('small words', () => {
  assert.equal(ageFrom('2017-03-04', Date.parse('2026-11-04T12:00:00Z')), 9);
  assert.equal(ageFrom('2017-12-04', Date.parse('2026-11-04T12:00:00Z')), 8);
  assert.equal(ageFrom('', Date.now()), null);
  assert.equal(nameFromEmail('sam.lee@soardcharity.com'), 'Sam Lee');
  void familyOne;
});
