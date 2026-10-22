/**
 * Confirmed reveal dates from JobTread (functions/api/_reveals.js)
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  normalizeName, parseJobName, matchKid, easternParts, cfImageId, buildReveals, getReveals,
  buildSchedule, revealWindow, carryPast,
  FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED, FIELD_JOB_STATUS,
} from '../functions/api/_reveals.js';

// Real 2026 kids and the JobTread job names their reveals live on
const KIDS = [
  { slug: 'max', name: 'Max', year: 2026, heroImage: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/max/1774379084543-Max.jpeg/public' },
  { slug: 'dex', name: 'Dex', year: 2026 },
  { slug: 'josue', name: 'Josué', year: 2026 },
  { slug: 'junializ', name: 'Junailiz', year: 2026 },
  { slug: 'remi-and-nico', name: 'Remi & Nico', year: 2026 },
  { slug: 'tyrece-maddie', name: 'Tyrece & Maddie', year: 2026 },
  { slug: 'dylan-2026', name: 'Dylan', year: 2026 },
  { slug: 'peter', name: 'Peter', year: 2026 },
  { slug: 'adrian-2025', name: 'Adrian', year: 2026 },
];

test('job names match the right kid', () => {
  const slug = (job) => matchKid(job, KIDS)?.slug ?? null;
  assert.equal(slug('Max Sample (2026)'), 'max');
  assert.equal(slug('Declan "Dex" Noel (2026)'), 'dex');
  assert.equal(slug('Josue Castillo (2026)'), 'josue');
  assert.equal(slug('Junailiz “Gigi” Torres (2026)'), 'junializ');
  assert.equal(slug('Remi & Nico Powell (2026)'), 'remi-and-nico');
  assert.equal(slug('Tyrece & Maddie Black (2026)'), 'tyrece-maddie');
  assert.equal(slug('Dylan Marchena (2026)'), 'dylan-2026');
  assert.equal(slug('Peter Raish (2026)'), 'peter');
});

test('no match is better than a wrong match', () => {
  assert.equal(matchKid('Max Sample (2025)', KIDS), null, 'wrong year');
  assert.equal(matchKid('Sunshine Office 2025', KIDS), null, 'no year suffix');
  assert.equal(matchKid('Perfect Harmony Health (2026)', KIDS), null, 'not a kid');
  assert.equal(matchKid('Max Smith (2026)', [...KIDS, { slug: 'max-2', name: 'Max', year: 2026 }]), null, 'two kids could match');
  assert.equal(matchKid('Remi Powell (2026)', KIDS), null, 'only half of a sibling pair');
});

test('name helpers', () => {
  assert.equal(normalizeName('Josué'), 'josue');
  assert.deepEqual([...parseJobName('Declan "Dex" Noel (2026)').tokens], ['declan', 'dex', 'noel']);
  assert.equal(parseJobName('Declan "Dex" Noel (2026)').year, 2026);
  assert.equal(cfImageId('https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/max/1774379084543-Max.jpeg/public'), 'kids/max/1774379084543-Max.jpeg');
  assert.equal(cfImageId('kids/remi/hero'), 'kids/remi/hero');
});

test('UTC field values become Eastern dates and times', () => {
  assert.deepEqual(easternParts('2026-11-20T20:00:00.000Z'), { date: '2026-11-20', time: '15:00' }, 'standard time');
  assert.deepEqual(easternParts('2027-07-15T18:00:00.000Z'), { date: '2027-07-15', time: '14:00' }, 'daylight time');
  assert.deepEqual(easternParts('2027-01-15T01:00:00.000Z'), { date: '2027-01-14', time: '20:00' }, 'previous Eastern day');
  assert.deepEqual(easternParts('2026-11-11T05:00:00.000Z'), { date: '2026-11-11', time: null }, 'midnight means no time yet');
  assert.deepEqual(easternParts('2027-07-20T04:00:00.000Z'), { date: '2027-07-20', time: null }, 'midnight in daylight time');
  assert.equal(easternParts('not a date'), null);
});

const job = (name, date, confirmed = 'Yes 👍') => ({
  id: name, name,
  customFieldValues: { nodes: [
    ...(date ? [{ value: date, customField: { id: FIELD_REVEAL_DATE } }] : []),
    ...(confirmed ? [{ value: confirmed, customField: { id: FIELD_REVEAL_CONFIRMED } }] : []),
  ] },
});
const NOW = Date.parse('2026-10-15T16:00:00Z');

test('only confirmed reveals from today on are public', () => {
  const reveals = buildReveals([
    job('Dylan Marchena (2026)', '2026-11-18T20:00:00.000Z'),
    job('Max Sample (2026)', '2026-10-27T20:00:00.000Z'),
    job('Peter Raish (2026)', '2026-10-07T04:00:00.000Z'),            // passed
    job('Josue Castillo (2026)', '2026-10-30T20:00:00.000Z', null),    // not confirmed
    job('Remi & Nico Powell (2026)', null),                            // no date
    job('Perfect Harmony Health (2026)', '2026-10-28T20:00:00.000Z'),  // no kid page
    job('Junailiz “Gigi” Torres (2026)', '2026-10-15T04:00:00.000Z'), // today, no time
  ], KIDS, NOW);
  assert.deepEqual(reveals.map(r => r.slug), ['junializ', 'max', 'dylan-2026']);
  const max = reveals.find(r => r.slug === 'max');
  assert.deepEqual(max, {
    slug: 'max', name: 'Max', startsAt: '2026-10-27T20:00:00.000Z', date: '2026-10-27', time: '16:00',
    image: '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/kids/max/1774379084543-Max.jpeg/w=640,h=480,fit=cover,gravity=face,q=80',
    kidUrl: '/kids/max/', liveUrl: '/live/max/',
  });
  assert.equal(reveals.find(r => r.slug === 'junializ').time, null);
  // Job names carry family surnames; none may leak
  assert.ok(!JSON.stringify(reveals).includes('Daniel'));
  assert.ok(!JSON.stringify(reveals).includes('Marchena'));
});

async function makeEnv(extra = {}) {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, status TEXT, data TEXT NOT NULL)',
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  ] });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)')
    .bind('max', 'Max', 2026, 'in-progress', JSON.stringify({ name: 'Max', slug: 'max', publishStatus: 'published' })).run();
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)')
    .bind('lizzie', 'Lizzie', 2026, 'in-progress', JSON.stringify({ name: 'Lizzie', slug: 'lizzie', publishStatus: 'draft' })).run();
  return { DB, ...extra };
}

const jobtread = (jobs, calls = []) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return Response.json({ organization: { jobs: { nodes: jobs, nextPage: null } } });
};

test('reads JobTread with the grant key and remembers the result', async () => {
  const env = await makeEnv({ JOBTREAD_GRANT_KEY: 'grant_test' });
  const calls = [];
  const r = await getReveals(env, { now: NOW, fetchImpl: jobtread([
    job('Max Sample (2026)', '2026-10-27T20:00:00.000Z'),
    job('Lizzie Francis (2026)', '2026-10-22T20:00:00.000Z'), // draft kid page: hidden
  ], calls) });
  assert.equal(r.source, 'jobtread');
  assert.deepEqual(r.reveals.map(x => x.slug), ['max']);
  assert.equal(calls[0].url, 'https://api.jobtread.com/pave');
  assert.equal(calls[0].body.query.$.grantKey, 'grant_test');
  assert.equal(calls[0].body.query.organization.$.id, '22NJw42j5GLg');

  // JobTread down: the last good copy is served
  const down = await getReveals(env, { now: NOW, fetchImpl: async () => new Response('nope', { status: 500 }) });
  assert.equal(down.source, 'cache');
  assert.deepEqual(down.reveals.map(x => x.slug), ['max']);
  assert.match(down.error, /500/);

  // ...and a cached reveal drops off once its day has passed
  const later = await getReveals(env, { now: Date.parse('2026-10-28T16:00:00Z'), fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(later.reveals, []);
});

test('without a grant key nothing breaks', async () => {
  const env = await makeEnv();
  const r = await getReveals(env, { now: NOW, fetchImpl: () => { throw new Error('should not be called'); } });
  assert.equal(r.source, 'none');
  assert.deepEqual(r.reveals, []);
  assert.match(r.error, /JOBTREAD_GRANT_KEY/);
});

// ─── Tentative reveals: public only as a third of a month (Oct 22 2026) ───

const jobAt = (name, date, { confirmed = null, status = 'Build', id = name } = {}) => ({
  id, name,
  customFieldValues: { nodes: [
    ...(date ? [{ value: date, customField: { id: FIELD_REVEAL_DATE } }] : []),
    ...(confirmed ? [{ value: confirmed, customField: { id: FIELD_REVEAL_CONFIRMED } }] : []),
    ...(status ? [{ value: status, customField: { id: FIELD_JOB_STATUS } }] : []),
  ] },
});

test('a tentative date becomes early, mid or late in its month', () => {
  const today = '2026-10-22';
  assert.deepEqual(revealWindow('2026-11-06', today), { part: 'early', month: '2026-11', through: '2026-11-10', label: 'early November' });
  assert.deepEqual(revealWindow('2026-11-17', today), { part: 'mid', month: '2026-11', through: '2026-11-20', label: 'mid November' });
  assert.equal(revealWindow('2026-11-10', today).part, 'early');
  assert.equal(revealWindow('2026-11-11', today).part, 'mid');
  assert.equal(revealWindow('2026-11-21', today).part, 'late');
  assert.equal(revealWindow('2026-11-25', today).through, '2026-11-30');
  assert.equal(revealWindow('2027-02-24', today).through, '2027-02-28', 'February ends on the 28th');
  assert.equal(revealWindow('2028-02-24', today).through, '2028-02-29', 'leap year');
  assert.equal(revealWindow('2027-01-05', today).label, 'early January 2027', 'another year is named');
});

test('the schedule lists confirmed and tentative reveals in date order, never a tentative day', () => {
  const now = Date.parse('2026-10-22T16:00:00Z');
  const kids = [...KIDS, { slug: 'colin', name: 'Colin', year: 2026, rooms: ['Bathroom'] }, { slug: 'lizzie', name: 'Lizzie', year: 2026 }, { slug: 'jackson', name: 'Jackson', year: 2026 }, { slug: 'axel', name: 'Axel', year: 2026 }];
  const { reveals, upcoming } = buildSchedule([
    jobAt('Peter Raish (2026)', '2026-11-06T05:00:00.000Z', { status: 'Mobilization' }),
    jobAt('Max Daniel (2026)', '2026-11-17T21:00:00.000Z', { status: 'Build' }),
    jobAt('Lizzie Francis (2026)', '2026-11-17T05:00:00.000Z', { status: 'Approval' }),
    jobAt('Dylan Marchena (2026)', '2026-11-18T05:00:00.000Z', { status: 'Mobilization' }),
    jobAt('Colin Lindsay (2026)', '2026-11-25T21:00:00.000Z', { status: 'Build', confirmed: 'Yes 👍' }),
    jobAt('Jackson Getbehead (2026)', '2026-12-03T05:00:00.000Z', { status: 'Awaiting Funding' }), // not being built
    jobAt('Axel Puente Arnao (2026)', '2026-10-07T04:00:00.000Z', { status: 'Design' }),           // date passed
    jobAt('Josue Castillo (2026)', '2026-11-12T05:00:00.000Z', { status: 'Closed Done' }),          // finished
    jobAt('Remi & Nico Powell (2026)', '2026-11-13T05:00:00.000Z', { status: null }),                // no status
  ], kids, now);

  assert.deepEqual(upcoming.map((r) => [r.slug, r.confirmed, r.window?.label || r.date]), [
    ['peter', false, 'early November'],
    ['lizzie', false, 'mid November'],
    ['max', false, 'mid November'],
    ['dylan-2026', false, 'mid November'],
    ['colin', true, '2026-11-25'],
  ]);
  assert.deepEqual(reveals.map((r) => r.slug), ['colin'], 'the confirmed-only list is unchanged');
  const max = upcoming.find((r) => r.slug === 'max');
  assert.deepEqual(Object.keys(max).sort(), ['confirmed', 'image', 'kidUrl', 'liveUrl', 'name', 'rooms', 'slug', 'window']);
  const colin = upcoming.find((r) => r.slug === 'colin');
  assert.equal(colin.time, '16:00');
  assert.deepEqual(colin.rooms, ['Bathroom']);
  // Nothing finer than the window, and no surnames
  const text = JSON.stringify(upcoming.filter((r) => !r.confirmed));
  for (const leak of ['2026-11-06', '2026-11-17', '2026-11-18', 'T05:00', 'T21:00', 'Daniel', 'Raish', 'Francis', 'Marchena']) {
    assert.ok(!text.includes(leak), `tentative reveals must not carry ${leak}`);
  }
});

test('rehearsal jobs and the office sandbox are never public, confirmed or not', () => {
  const now = Date.parse('2026-10-22T16:00:00Z');
  const { reveals, upcoming } = buildSchedule([
    jobAt('TEST Max Example (2026)', '2026-10-30T20:00:00.000Z', { confirmed: 'Yes 👍' }),
    jobAt('TEST Dylan Example (2026)', '2026-11-03T20:00:00.000Z'),
    jobAt('Sunshine Office 2025', '2026-11-03T20:00:00.000Z', { id: '22P3HTX9cXn4', confirmed: 'Yes 👍' }),
  ], KIDS, now);
  assert.deepEqual(reveals, []);
  assert.deepEqual(upcoming, []);
});

test('past reveals are kept for the calendar after their day', () => {
  const prev = {
    reveals: [{ slug: 'max', name: 'Max', date: '2026-10-21', time: '16:00', startsAt: '2026-10-21T20:00:00.000Z' }, { slug: 'colin', name: 'Colin', date: '2026-11-25' }],
    past: [{ slug: 'isla', name: 'Isla', date: '2026-08-01' }, { slug: 'old', name: 'Old', date: '2026-01-02' }],
  };
  assert.deepEqual(carryPast(prev, '2026-10-22').map((r) => r.slug), ['max', 'isla'], 'yesterday joins, older than 120 days drops, upcoming stays out');
  assert.deepEqual(carryPast(null, '2026-10-22'), []);
});

test('the upcoming list survives JobTread being down, and closed windows drop off', async () => {
  const env = await makeEnv({ JOBTREAD_GRANT_KEY: 'grant_test' });
  await env.DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)')
    .bind('dylan-2026', 'Dylan', 2026, 'in-progress', JSON.stringify({ name: 'Dylan', slug: 'dylan-2026', roomTypes: ['Therapy Room'] })).run();
  const now = Date.parse('2026-10-22T16:00:00Z');
  const fresh = await getReveals(env, { now, fetchImpl: jobtread([
    jobAt('Max Daniel (2026)', '2026-10-27T20:00:00.000Z', { confirmed: 'Yes 👍' }),
    jobAt('Dylan Marchena (2026)', '2026-11-18T05:00:00.000Z', { status: 'Mobilization' }),
  ]) });
  assert.deepEqual(fresh.upcoming.map((r) => r.slug), ['max', 'dylan-2026']);
  assert.deepEqual(fresh.upcoming[1].rooms, ['Therapy Room']);

  const offline = async () => { throw new Error('offline'); };
  const down = await getReveals(env, { now, fetchImpl: offline });
  assert.equal(down.source, 'cache');
  assert.deepEqual(down.upcoming.map((r) => r.slug), ['max', 'dylan-2026']);

  // After Max's day, Max moves to past; after mid November closes, Dylan's window drops off
  const later = await getReveals(env, { now: Date.parse('2026-11-21T16:00:00Z'), fetchImpl: offline });
  assert.deepEqual(later.upcoming, []);
  assert.deepEqual(later.past.map((r) => r.slug), ['max']);
});
