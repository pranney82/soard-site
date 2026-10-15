/**
 * Confirmed reveal dates from JobTread (functions/api/_reveals.js)
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  normalizeName, parseJobName, matchKid, easternParts, cfImageId, buildReveals, getReveals,
  FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED,
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
