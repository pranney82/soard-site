/**
 * Who issues each home's building permits (functions/api/_permit-office.js):
 * the Census map's city limits and county by map point (the jurisdiction),
 * then who issues permits there (what staff taught, the checked list, else
 * the jurisdiction, flagged), written to the location's Permitting
 * Municipality field in JobTread. Only values the site wrote are changed.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { jurisdictionFrom, jurisdictionAt, plan, learnFromStaff, officeFor, fillPermitOffices, permitFacts, PERMIT_FIELD_NAME, VERIFIED } from '../functions/api/_permit-office.js';
import { maybeSyncApplicants } from '../functions/api/_applicants.js';

// What the Census map answered for real Georgia points (Nov 9 2026), and one made-up town
const CENSUS = {
  '34.0988,-84.4821': { 'Incorporated Places': [{ NAME: 'Woodstock city', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Cherokee County' }] },
  '33.977,-84.425': { Counties: [{ NAME: 'Cobb County' }] },
  '33.93,-84.379': { 'Incorporated Places': [{ NAME: 'Sandy Springs city', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Fulton County' }] },
  '32.75,-84.87': { 'Incorporated Places': [{ NAME: 'Testville city', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Harris County' }] },
  '32.76,-84.88': { 'Incorporated Places': [{ NAME: 'Testville city', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Harris County' }] },
  '32.77,-84.89': { 'Incorporated Places': [{ NAME: 'Testville city', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Harris County' }] },
};
// Tests put made-up towns on the checked list and take them off again
const added = [];
const verify = (j, office) => { added.push([j, VERIFIED[j]]); VERIFIED[j] = { office, source: 'https://example.gov', checked: '2026-11-09' }; };
afterEach(() => { while (added.length) { const [j, was] = added.pop(); if (was) VERIFIED[j] = was; else delete VERIFIED[j]; } });

test('the jurisdiction: the city inside its limits, the county outside, a consolidated government by its name', () => {
  assert.equal(jurisdictionFrom(CENSUS['34.0988,-84.4821']), 'City of Woodstock');
  assert.equal(jurisdictionFrom(CENSUS['33.977,-84.425']), 'Cobb County', 'unincorporated: the county');
  assert.equal(jurisdictionFrom({ 'Incorporated Places': [{ NAME: 'Braselton town', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Gwinnett County' }] }), 'Town of Braselton');
  assert.equal(jurisdictionFrom({ 'Incorporated Places': [{ NAME: 'Augusta-Richmond County consolidated government (balance)', FUNCSTAT: 'A' }], Counties: [{ NAME: 'Richmond County' }] }), 'Augusta-Richmond County consolidated government');
  assert.equal(jurisdictionFrom({ 'Incorporated Places': [{ NAME: 'Ghost town', FUNCSTAT: 'I' }], Counties: [{ NAME: 'Cobb County' }] }), 'Cobb County', 'a place with no active government governs nothing');
  assert.equal(jurisdictionFrom({}), null);
});

test('asks the Census by map point only, never an address', async () => {
  let asked = '';
  const r = await jurisdictionAt(34.0988, -84.4821, async (url) => { asked = url; return Response.json({ result: { geographies: CENSUS['34.0988,-84.4821'] } }); });
  assert.equal(r.jurisdiction, 'City of Woodstock');
  assert.match(asked, /\/geographies\/coordinates\?x=-84\.4821&y=34\.0988/);
  assert.match(decodeURIComponent(asked), /layers=Incorporated Places,Counties/);
  await assert.rejects(jurisdictionAt(1, 2, async () => new Response('down', { status: 502 })), /Census map returned 502/);
});

test('who issues permits: what staff taught, else the checked list, else the jurisdiction (unconfirmed)', () => {
  verify('City of Testville', 'Harris County');
  assert.deepEqual(officeFor('City of Testville'), { office: 'Harris County', why: 'verified' });
  assert.deepEqual(officeFor('City of Nowhere'), { office: 'City of Nowhere', why: 'unconfirmed' });
  const taught = new Map([['City of Nowhere', { office: 'Nowhere County', homes: 1 }], ['City of Testville', { conflict: ['A', 'B'] }]]);
  assert.deepEqual(officeFor('City of Nowhere', taught), { office: 'Nowhere County', why: 'taught' });
  assert.deepEqual(officeFor('City of Testville', taught), { office: 'Harris County', why: 'verified' }, 'a disagreement teaches nothing');
});

test('learning from staff: a value staff changed teaches its town; two different ones teach nothing', () => {
  const written = new Map([
    ['a', { jurisdiction: 'City of X', office: 'City of X' }], ['b', { jurisdiction: 'City of X', office: 'City of X' }],
    ['c', { jurisdiction: 'City of Y', office: 'City of Y' }], ['d', { jurisdiction: 'City of Y', office: 'City of Y' }],
    ['e', { jurisdiction: 'Cobb County', office: 'Cobb County' }],
  ]);
  const homes = [
    { id: 'a', value: 'X County' }, { id: 'b', value: 'City of X' },
    { id: 'c', value: 'Y County' }, { id: 'd', value: 'Somewhere Else' },
    { id: 'e', value: 'Cobb County' }, { id: 'f', value: 'Typed before the site got there' },
  ];
  const taught = learnFromStaff(homes, written);
  assert.deepEqual([...taught], [['City of X', { office: 'X County', homes: 1 }], ['City of Y', { conflict: ['Somewhere Else', 'Y County'] }]]);
});

test('the plan: blanks and due or moved homes get a lookup; known homes get rewritten when their town’s office changes; staff’s never', () => {
  const now = Date.parse('2026-11-09T20:00:00Z');
  const fresh = '2026-11-01T00:00:00Z';
  const written = new Map([
    ['moved', { lat: 34.0, lng: -84.0, office: 'Cobb County', jurisdiction: 'Cobb County', written_at: fresh }],
    ['same', { lat: 34.0, lng: -84.0, office: 'Cobb County', jurisdiction: 'Cobb County', written_at: fresh }],
    ['staff', { lat: 34.0, lng: -84.0, office: 'Cobb County', jurisdiction: 'Cobb County', written_at: fresh }],
    ['nowhere', { lat: 10, lng: 10, office: null, jurisdiction: null, written_at: fresh }],
    ['town', { lat: 32.75, lng: -84.87, office: 'City of Testville', jurisdiction: 'City of Testville', written_at: fresh }],
  ]);
  const homes = [
    { id: 'blank', lat: 34, lng: -84, value: '' },
    { id: 'noPoint', lat: null, lng: null, value: '' },
    { id: 'moved', lat: 34.01, lng: -84.0, value: 'Cobb County' },
    { id: 'same', lat: 34.0001, lng: -84.0, value: 'Cobb County' },
    { id: 'staff', lat: 34.5, lng: -84.0, value: 'City of Acworth (per the permit desk)' },
    { id: 'nowhere', lat: 10, lng: 10, value: '' },
    { id: 'town', lat: 32.75, lng: -84.87, value: 'City of Testville' },
  ];
  assert.deepEqual(plan(homes, written, new Map(), now).map(h => `${h.id}:${h.need}`), ['blank:lookup', 'moved:lookup']);
  // Once the checked list says the county issues Testville's permits, its homes are rewritten with no new lookup
  verify('City of Testville', 'Harris County');
  assert.deepEqual(plan(homes, written, new Map(), now).map(h => `${h.id}:${h.need}:${h.office || ''}`), ['blank:lookup:', 'moved:lookup:', 'town:write:Harris County']);
  // 90 days on, everything the site wrote is looked up again (cities annex land), blanks first; staff's words never
  assert.deepEqual(plan(homes, written, new Map(), now + 91 * 864e5).map(h => h.id), ['blank', 'nowhere', 'moved', 'same', 'town']);
});

// A small JobTread for this: the location fields, the homes, createCustomField and updateLocation
function fakeJT({ fields = [{ id: '22PK2MzzJD93', name: 'County' }], homes = [] } = {}) {
  const world = { fields, homes, made: [], updates: [], census: 0, censusDown: false };
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://geocoding.geo.census.gov')) {
      world.census++;
      if (world.censusDown) return new Response('', { status: 502 });
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
  const value = (id) => world.homes.find(h => h.id === id).values?.f2;
  const staffSets = (id, v) => { const h = world.homes.find(x => x.id === id); (h.values ||= {}).f2 = v; };
  return { world, fetchImpl, value, staffSets };
}

let env;
beforeEach(async () => { env = { DB: await createD1(), JOBTREAD_GRANT_KEY: 'k' }; });

test('a turn: makes the field after County once, fills the blanks, leaves staff’s words, and says how every town stands', async () => {
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
  assert.deepEqual(r.towns.map(t => `${t.jurisdiction} ${t.homes} ${t.why}`), ['City of Woodstock 1 verified', 'Cobb County 1 verified']);
  // The next turn asks the Census nothing new and writes nothing
  const census = jt.world.census;
  const again = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(again.made, false);
  assert.equal(jt.world.census, census);
  assert.equal(jt.world.updates.length, 2);
  // A home whose point moved (its address fixed) is looked up again
  jt.world.homes[0].lat = 33.93; jt.world.homes[0].lng = -84.379;
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.deepEqual(jt.world.updates.at(-1), { id: 'L1', f2: 'City of Sandy Springs' });
  const facts = await permitFacts(env.DB);
  assert.equal(facts.run.homes, 4);
  assert.equal(facts.fieldId, 'f2');
  assert.equal(facts.error, null);
});

test('one correction teaches the town: staff change one home, the others follow, new homes too; changing it back undoes it', async () => {
  const jt = fakeJT({ fields: [{ id: '22PK2MzzJD93', name: 'County' }, { id: 'f2', name: PERMIT_FIELD_NAME }], homes: [
    { id: 'T1', lat: 32.75, lng: -84.87 }, { id: 'T2', lat: 32.76, lng: -84.88 },
  ] });
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.deepEqual([jt.value('T1'), jt.value('T2')], ['City of Testville', 'City of Testville']);
  // Staff learn Harris County issues Testville's permits, and fix one home in JobTread
  jt.staffSets('T1', 'Harris County');
  const census = jt.world.census;
  const taught = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(jt.value('T2'), 'Harris County', 'the rest of the town follows');
  assert.equal(jt.world.census, census, 'with no new lookup');
  assert.deepEqual(taught.taught, [{ jurisdiction: 'City of Testville', office: 'Harris County', homes: 1 }]);
  assert.deepEqual(taught.towns.map(t => `${t.jurisdiction} ${t.office} ${t.why}`), ['City of Testville Harris County taught']);
  // A new home in that town gets the taught office straight away
  jt.world.homes.push({ id: 'T3', lat: 32.77, lng: -84.89 });
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(jt.value('T3'), 'Harris County');
  // Staff change it back: the town goes back to the city
  jt.staffSets('T1', 'City of Testville');
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.deepEqual([jt.value('T2'), jt.value('T3')], ['City of Testville', 'City of Testville']);
});

test('two different corrections in one town: nothing spreads, and the summary names the disagreement', async () => {
  const jt = fakeJT({ fields: [{ id: '22PK2MzzJD93', name: 'County' }, { id: 'f2', name: PERMIT_FIELD_NAME }], homes: [
    { id: 'T1', lat: 32.75, lng: -84.87 }, { id: 'T2', lat: 32.76, lng: -84.88 }, { id: 'T3', lat: 32.77, lng: -84.89 },
  ] });
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  jt.staffSets('T1', 'Harris County');
  jt.staffSets('T2', 'City of Testville Building Dept');
  const r = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(jt.value('T3'), 'City of Testville');
  assert.deepEqual(r.conflicts, [{ jurisdiction: 'City of Testville', values: ['City of Testville Building Dept', 'Harris County'] }]);
});

test('a field staff already made by that name is used, not a second one', async () => {
  const jt = fakeJT({ fields: [{ id: '22PK2MzzJD93', name: 'County' }, { id: 'staffs', name: 'permitting municipality' }], homes: [{ id: 'L1', lat: 33.977, lng: -84.425 }] });
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(jt.world.made.length, 0);
  assert.deepEqual(jt.world.updates, [{ id: 'L1', staffs: 'Cobb County' }]);
});

test('a few homes a turn; a Census outage stops the turn and is kept, then clears', async () => {
  const homes = Array.from({ length: 25 }, (_, i) => ({ id: `L${i}`, lat: 33.977, lng: -84.425 }));
  const jt = fakeJT({ homes });
  const first = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl, limit: 20 });
  assert.equal(first.filled, 20);
  assert.equal(first.waiting, 5);
  jt.world.censusDown = true;
  const failed = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.match(failed.error, /Census map returned 502/);
  assert.match((await permitFacts(env.DB)).error.message, /Census map returned 502/);
  jt.world.censusDown = false;
  const after = await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(after.filled, 5);
  assert.equal((await permitFacts(env.DB)).error, null);
});

test('rows the first version wrote (no jurisdiction kept) take their own office as the jurisdiction', async () => {
  const { DB } = env;
  await DB.exec('CREATE TABLE IF NOT EXISTS permit_offices (location_id TEXT PRIMARY KEY, lat REAL, lng REAL, office TEXT, written_at TEXT NOT NULL)');
  await DB.prepare("INSERT INTO permit_offices (location_id, lat, lng, office, written_at) VALUES ('T1', 32.75, -84.87, 'City of Testville', ?)").bind(new Date().toISOString()).run();
  const jt = fakeJT({ fields: [{ id: '22PK2MzzJD93', name: 'County' }, { id: 'f2', name: PERMIT_FIELD_NAME }], homes: [{ id: 'T1', lat: 32.75, lng: -84.87, values: { f2: 'City of Testville' } }] });
  verify('City of Testville', 'Harris County');
  await fillPermitOffices(env, { fetchImpl: jt.fetchImpl });
  assert.equal(jt.value('T1'), 'Harris County', 'the checked list reaches homes filled before it existed');
  assert.equal(jt.world.census, 0);
});

test('the applicant sync gives it its own turn every 10 minutes, and its trouble never marks the sync as failing', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const t0 = Date.parse('2026-11-09T20:00:00Z');
  const out = await maybeSyncApplicants(env, { fetchImpl, now: t0 });
  assert.ok(out.permits?.error, 'it ran, and kept its own error');
  const second = await maybeSyncApplicants(env, { fetchImpl, now: t0 + 5 * 60 * 1000 });
  assert.equal(second.permits, undefined, 'not again within 10 minutes');
  const third = await maybeSyncApplicants(env, { fetchImpl, now: t0 + 11 * 60 * 1000 });
  assert.ok(third.permits);
});

test('the checked list: every town and county SOARD has homes in (Nov 2026), each with its own source; Hamilton is Harris County’s', () => {
  const towns = ['City of Woodstock', 'City of Roswell', 'City of Johns Creek', 'City of Alpharetta', 'City of Atlanta', 'City of Dunwoody', 'City of Sandy Springs',
    'City of Holly Springs', 'City of Douglasville', 'City of Hamilton', 'City of Jefferson', 'City of Stockbridge', 'City of Mulberry', 'City of Smyrna', 'City of Lawrenceville',
    'City of South Fulton', 'City of Newnan', 'City of McDonough', 'City of Hampton', 'City of Union City', 'City of Snellville', 'City of Brookhaven', 'Town of Braselton',
    'City of Austell', 'City of Mableton', 'City of Kennesaw', 'Cobb County', 'Gwinnett County', 'Cherokee County', 'Forsyth County', 'Paulding County', 'DeKalb County',
    'Douglas County', 'Rockdale County', 'Peach County', 'Spalding County', 'Henry County', 'Gilmer County', 'Bartow County'];
  for (const t of towns) {
    assert.ok(VERIFIED[t], `${t} is checked`);
    assert.match(VERIFIED[t].source, /^https:\/\//, `${t}: a source`);
    assert.doesNotMatch(VERIFIED[t].source, /jaspector|permitplace|permitsguide|permitflow|zoneomics|mapquest/, `${t}: the government’s own page, not an aggregator`);
  }
  assert.equal(officeFor('City of Hamilton').office, 'Harris County');
  assert.deepEqual(Object.entries(VERIFIED).filter(([k, v]) => k !== v.office).map(([k, v]) => `${k} → ${v.office}`), ['City of Hamilton → Harris County'], 'the only town whose permits come from someone else');
});
