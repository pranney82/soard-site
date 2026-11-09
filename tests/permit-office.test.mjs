/**
 * Who issues each home's building permits (functions/api/_permit-office.js):
 * the Census map's city limits and county by map point, written to the
 * location's Permitting Municipality field in JobTread, blanks only.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { officeFrom, permitOfficeAt, homesToLookUp, fillPermitOffices, permitFacts, PERMIT_FIELD_NAME } from '../functions/api/_permit-office.js';
import { maybeSyncApplicants } from '../functions/api/_applicants.js';

// What the Census map answered for real Georgia points (Nov 9 2026)
const CENSUS = {
  '34.0988,-84.4821': { 'Incorporated Places': [{ NAME: 'Woodstock city', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Cherokee County' }] },
  '33.977,-84.425': { Counties: [{ NAME: 'Cobb County' }] },
  '33.93,-84.379': { 'Incorporated Places': [{ NAME: 'Sandy Springs city', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Fulton County' }] },
};

test('the office: the city inside its limits, the county outside, a consolidated government by its name', () => {
  assert.equal(officeFrom(CENSUS['34.0988,-84.4821']), 'City of Woodstock');
  assert.equal(officeFrom(CENSUS['33.977,-84.425']), 'Cobb County', 'unincorporated: the county issues permits');
  assert.equal(officeFrom({ 'Incorporated Places': [{ NAME: 'Braselton town', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Gwinnett County' }] }), 'Town of Braselton');
  assert.equal(officeFrom({ 'Incorporated Places': [{ NAME: 'Augusta-Richmond County consolidated government (balance)', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Richmond County' }] }), 'Augusta-Richmond County consolidated government');
  assert.equal(officeFrom({ 'Incorporated Places': [{ NAME: 'Ghost town', FUNCSTAT: 'I' }], Counties: [{ NAME: 'Cobb County' }] }), 'Cobb County', 'a place with no active government issues nothing');
  assert.equal(officeFrom({}), null);
});

test('asks the Census by map point only, never an address', async () => {
  let asked = '';
  const r = await permitOfficeAt(34.0988, -84.4821, async (url) => { asked = url; return Response.json({ result: { geographies: CENSUS['34.0988,-84.4821'] } }); });
  assert.equal(r.office, 'City of Woodstock');
  assert.match(asked, /\/geographies\/coordinates\?x=-84\.4821&y=34\.0988/);
  assert.match(decodeURIComponent(asked), /layers=Incorporated Places,Counties/);
  await assert.rejects(permitOfficeAt(1, 2, async () => new Response('down', { status: 502 })), /Census map returned 502/);
});

test('which homes need a look: blanks with a point; a value the site wrote whose home moved; never one staff typed', () => {
  const written = new Map([
    ['moved', { lat: 34.0, lng: -84.0, office: 'Cobb County' }],
    ['same', { lat: 34.0, lng: -84.0, office: 'Cobb County' }],
    ['staff', { lat: 34.0, lng: -84.0, office: 'Cobb County' }],
    ['nowhere', { lat: 10, lng: 10, office: null }],
  ]);
  const homes = [
    { id: 'blank', lat: 34, lng: -84, value: '' },
    { id: 'noPoint', lat: null, lng: null, value: '' },
    { id: 'moved', lat: 34.01, lng: -84.0, value: 'Cobb County' },
    { id: 'same', lat: 34.0001, lng: -84.0, value: 'Cobb County' },
    { id: 'staff', lat: 34.5, lng: -84.0, value: 'City of Acworth (per the permit desk)' },
    { id: 'nowhere', lat: 10, lng: 10, value: '' },
  ];
  const now = Date.parse('2026-11-09T20:00:00Z');
  for (const w of written.values()) w.written_at = '2026-11-01T00:00:00Z';
  assert.deepEqual(homesToLookUp(homes, written, now).map(h => h.id), ['blank', 'moved']);
  // 90 days on, what the site wrote is checked again (cities annex land), blanks first; staff's words still never
  const later = now + 91 * 864e5;
  assert.deepEqual(homesToLookUp(homes, written, later).map(h => h.id), ['blank', 'nowhere', 'moved', 'same']);
});

// A small JobTread for this: the location fields, the homes, createCustomField and updateLocation
function fakeJT({ fields = [{ id: '22PK2MzzJD93', name: 'County' }], homes = [] } = {}) {
  const world = { fields, homes, made: [], updates: [], census: 0 };
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://geocoding.geo.census.gov')) {
      world.census++;
      const u = new URL(url);
      const key = `${Number(u.searchParams.get('y'))},${Number(u.searchParams.get('x'))}`;
      return Response.json({ result: { geographies: CENSUS[key] || {} } });
    }
    const q = JSON.parse(init.body).query;
    if (q.createCustomField) {
      const id = `f${world.fields.length + 1}`;
      world.made.push(q.createCustomField.$);
      world.fields.push({ id, name: q.createCustomField.$.name });
      return Response.json({ createCustomField: { createdCustomField: { id } } });
    }
    if (q.updateLocation) {
      const { id, customFieldValues } = q.updateLocation.$;
      world.updates.push({ id, ...customFieldValues });
      const h = world.homes.find(x => x.id === id);
      Object.assign(h.values ||= {}, customFieldValues);
      return Response.json({});
    }
    const org = q.organization;
    if (org?.customFields) return Response.json({ organization: { customFields: { nodes: world.fields } } });
    if (org?.locations) {
      const fid = org.locations.nodes.customFieldValues.$.where[2];
      return Response.json({ organization: { locations: { nextPage: null, nodes: world.homes.map(h => ({
        id: h.id, latitude: h.lat, longitude: h.lng, account: { name: h.name || 'Family' },
        customFieldValues: { nodes: h.values?.[fid] ? [{ value: h.values[fid] }] : [] },
      })) } } });
    }
    throw new Error(`fake JobTread doesn't know ${Object.keys(q).join(',')}`);
  };
  return { world, fetchImpl };
}

let env;
beforeEach(async () => { env = { DB: await createD1(), JOBTREAD_GRANT_KEY: 'k' }; });

test('a turn: makes the field after County once, fills the blanks, leaves staff’s words, and says how it went', async () => {
  const jt = fakeJT({ homes: [
    { id: 'L1', lat: 34.0988, lng: -84.4821 },
    { id: 'L2', lat: 33.977, lng: -84.425 },
    { id: 'L3', lat: 33.93, lng: -84.379, values: { f2: 'City of Sandy Springs (permit desk on Mount Vernon)' } },
    { id: 'L4', lat: null, lng: null },
    { id: 'L5', lat: 34.0988, lng: -84.4821, name: 'TEST Family' },
  ] });
  const r = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(r.made, true);
  assert.deepEqual(jt.world.made, [{ organizationId: '22NJw42j5GLg', name: PERMIT_FIELD_NAME, targetType: 'location', type: 'text', minValuesRequired: 0, maxValuesAllowed: 1, positionAfterCustomFieldId: '22PK2MzzJD93' }]);
  assert.deepEqual(jt.world.updates, [{ id: 'L1', f2: 'City of Woodstock' }, { id: 'L2', f2: 'Cobb County' }]);
  assert.deepEqual([r.homes, r.filled, r.withOffice, r.unplaced, r.waiting], [4, 2, 3, 1, 0], 'TEST accounts are left out');
  // The next turn finds the field it made, asks the Census nothing new, writes nothing
  const census = jt.world.census;
  const again = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(again.made, false);
  assert.equal(jt.world.made.length, 1);
  assert.equal(jt.world.census, census);
  assert.equal(jt.world.updates.length, 2);
  // A home whose point moved (its address fixed) is looked up again
  jt.world.homes[0].lat = 33.93; jt.world.homes[0].lng = -84.379;
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.deepEqual(jt.world.updates.at(-1), { id: 'L1', f2: 'City of Sandy Springs' });
  const facts = await permitFacts(env.DB);
  assert.equal(facts.run.homes, 4);
  assert.equal(facts.fieldId, 'f2');
  assert.ok(facts.lastFilledAt);
  assert.equal(facts.error, null);
});

test('a field staff already made by that name is used, not a second one', async () => {
  const jt = fakeJT({ fields: [{ id: '22PK2MzzJD93', name: 'County' }, { id: 'staffs', name: 'permitting municipality' }], homes: [{ id: 'L1', lat: 33.977, lng: -84.425 }] });
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(jt.world.made.length, 0);
  assert.deepEqual(jt.world.updates, [{ id: 'L1', staffs: 'Cobb County' }]);
});

test('a few homes a turn; a Census outage stops the turn and shows on Automations, then clears', async () => {
  const homes = Array.from({ length: 25 }, (_, i) => ({ id: `L${i}`, lat: 33.977, lng: -84.425 }));
  const jt = fakeJT({ homes });
  const first = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl, limit: 20 });
  assert.equal(first.filled, 20);
  assert.equal(first.waiting, 5);
  const down = async (url, init) => (String(url).includes('census.gov') ? new Response('', { status: 502 }) : jt.fetchImpl(url, init));
  const failed = await fillPermitOffices(env, { fetchImpl: down });
  assert.match(failed.error, /Census map returned 502/);
  assert.match((await permitFacts(env.DB)).error.message, /Census map returned 502/);
  const after = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(after.filled, 5);
  assert.equal((await permitFacts(env.DB)).error, null);
});

test('the applicant sync gives it its own turn every 10 minutes, and its trouble never marks the sync as failing', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(String(url)); throw new Error('offline'); };
  const t0 = Date.parse('2026-11-09T20:00:00Z');
  const out = await maybeSyncApplicants(env, { fetchImpl, now: t0 });
  assert.ok(out.permits?.error, 'it ran, and kept its own error');
  const second = await maybeSyncApplicants(env, { fetchImpl, now: t0 + 5 * 60 * 1000 });
  assert.equal(second.permits, undefined, 'not again within 10 minutes');
  const third = await maybeSyncApplicants(env, { fetchImpl, now: t0 + 11 * 60 * 1000 });
  assert.ok(third.permits);
});
