/**
 * Staff view of reveal dates (functions/api/reveals-admin.js): confirmed and
 * tentative reveals, plus each kid's JobTread job for the admin's links.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminView, fetchAllJobs } from '../functions/api/reveals-admin.js';
import { FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED } from '../functions/api/_reveals.js';

const KIDS = [
  { slug: 'max', name: 'Max', year: 2026 },
  { slug: 'axel', name: 'Axel', year: 2026 },
  { slug: 'dylan-2026', name: 'Dylan', year: 2026 },
  { slug: 'lizzie', name: 'Lizzie', year: 2026 },
  { slug: 'adrian-2025', name: 'Adrian', year: 2026 },
  { slug: 'bennett-lacey', name: 'Bennett & Lacey', year: 2019 },
];

const job = (id, name, date, confirmed, closedOn = null) => ({
  id, name, closedOn,
  customFieldValues: { nodes: [
    ...(date ? [{ value: date, customField: { id: FIELD_REVEAL_DATE } }] : []),
    ...(confirmed ? [{ value: confirmed, customField: { id: FIELD_REVEAL_CONFIRMED } }] : []),
  ] },
});
const NOW = Date.parse('2026-10-16T16:00:00Z');

test('confirmed and tentative reveals from today on, soonest first', () => {
  const { reveals, unmatched } = buildAdminView([
    job('j-max', 'Max Sample (2026)', '2026-10-27T20:00:00.000Z', 'Yes 👍'),
    job('j-dylan', 'Dylan Marchena (2026)', '2026-10-24T04:00:00.000Z', null),       // tentative, no time
    job('j-axel', 'Axel Rivera (2026)', '2026-10-07T04:00:00.000Z', null),           // placeholder in the past
    job('j-lizzie', 'Lizzie Francis (2026)', null, null),                            // no date yet
    job('j-office', 'Perfect Harmony Health (2026)', '2026-10-28T20:00:00.000Z', null), // no kid page
  ], KIDS, NOW);
  assert.deepEqual(reveals.map((r) => [r.slug, r.confirmed]), [['dylan-2026', false], ['max', true]]);
  assert.deepEqual(reveals[0], { slug: 'dylan-2026', name: 'Dylan', startsAt: '2026-10-24T04:00:00.000Z', date: '2026-10-24', time: null, confirmed: false, jobId: 'j-dylan' });
  assert.equal(reveals[1].time, '16:00');
  assert.equal(unmatched, 1);
  assert.ok(!JSON.stringify(reveals).includes('Marchena'), 'job names (family surnames) never leave the server');
});

test('only "Yes" in Reveal Date Confirmed counts as confirmed', () => {
  const { reveals } = buildAdminView([
    job('a', 'Max Sample (2026)', '2026-11-01T20:00:00.000Z', 'No'),
    job('b', 'Dylan Marchena (2026)', '2026-11-02T20:00:00.000Z', ' yes '),
  ], KIDS, NOW);
  assert.deepEqual(reveals.map((r) => r.confirmed), [false, true]);
});

test('every matched kid gets a JobTread link, closed jobs included, open job preferred', () => {
  const { jobs, reveals } = buildAdminView([
    job('j-old', 'Bennett & Lacey Smith (2019)', null, null, '2019-06-01'),
    job('j-adrian-closed', 'Adrian Carlos (2026)', null, null, '2026-05-01'),
    job('j-adrian-open', 'Adrian Carlos (2026)', null, null),
    job('j-max', 'Max Sample (2026)', '2026-10-27T20:00:00.000Z', 'Yes'),
    job('j-closed-future', 'Lizzie Francis (2026)', '2026-12-01T20:00:00.000Z', 'Yes', '2026-10-01'),
  ], KIDS, NOW);
  assert.deepEqual(jobs, { 'bennett-lacey': 'j-old', 'adrian-2025': 'j-adrian-open', max: 'j-max', lizzie: 'j-closed-future' });
  assert.deepEqual(reveals.map((r) => r.slug), ['max'], 'closed jobs never list a reveal');
});

test('one reveal per kid, the soonest', () => {
  const { reveals } = buildAdminView([
    job('late', 'Max Sample (2026)', '2026-12-01T20:00:00.000Z', 'Yes'),
    job('soon', 'Max Sample (2026)', '2026-11-01T20:00:00.000Z', null),
  ], KIDS, NOW);
  assert.deepEqual(reveals.map((r) => r.jobId), ['soon']);
});

test('reads every page of jobs, open and closed', async () => {
  const calls = [];
  const pages = [
    { nodes: [job('1', 'Max Sample (2026)', null, null)], nextPage: 'p2' },
    { nodes: [job('2', 'Dylan Marchena (2026)', null, null, '2026-01-01')], nextPage: null },
  ];
  const jobs = await fetchAllJobs('grant_test', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return Response.json({ organization: { jobs: pages[calls.length - 1] } });
  });
  assert.deepEqual(jobs.map((j) => j.id), ['1', '2']);
  assert.equal(calls[0].query.$.grantKey, 'grant_test');
  assert.equal(calls[0].query.organization.$.id, '22NJw42j5GLg');
  assert.equal(calls[0].query.organization.jobs.$.where, undefined, 'closed jobs are included');
  assert.equal(calls[1].query.organization.jobs.$.page, 'p2');
});
