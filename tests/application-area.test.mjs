/**
 * The service-area check: the geometry (public/admin/area-shared.js), the form's
 * 'area' question and its rules (functions/api/_application-form.js), the check
 * as a family types their address and again on submit (_applications.js,
 * apply.js), intake reusing it, the settings (close distance, families farther
 * out, the outline's history) and what Insights counts.
 * The Census is the fake world's (tests/lib/fake-applicant-world.mjs).
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld } from './lib/fake-applicant-world.mjs';
import { placeHome, nearRing, milesToEdge, insidePolygon, bandCounts, bandChanges, areaRules } from '../public/admin/area-shared.js';
import {
  DEFAULT_DEFINITION, DEFAULT_SERVICE_AREA, AREA_VALUES, applicationForm, normalizeDefinition, validateDefinition,
  translationStatus, allFields, stopFor, diffDefinitions,
} from '../functions/api/_application-form.js';
import {
  createDraft, getDraft, saveDraft, setDraftFile, submitDraft, processApplication, getApplication, areaCheck, placedArea,
  photoKey, TEST_JPEG, testAnswers, insights, expireDrafts, MAX_AREA_CHECKS, DRAFT_TTL_DAYS,
} from '../functions/api/_applications.js';
import { saveFormRules, areaHistory, formFor, clearFormCache } from '../functions/api/_application-forms.js';
import * as applyApi from '../functions/api/apply.js';

const YEAR = '2027';
const POLY = DEFAULT_SERVICE_AREA.polygon;
const AREA = { polygon: POLY, nearMiles: 15 };
const PHOTOS = ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const field = (def, id) => def.pages.flatMap(p => p.fields).find(f => f.id === id);
const problems = (def) => validateDefinition(normalizeDefinition(def)).map(e => e.message).join(' | ');

// Real places (the Census's own points for these addresses)
const MARIETTA = { lat: 33.95327, lng: -84.54682, county: 'Cobb', matched: '205 LAWRENCE ST NE, MARIETTA, GA, 30060' };
const CARTERSVILLE = { lat: 34.16424, lng: -84.79914, county: 'Bartow', matched: '121 E MAIN ST, CARTERSVILLE, GA, 30120' };
const MACON = { lat: 32.83603, lng: -83.63183, county: 'Bibb', matched: '700 POPLAR ST, MACON, GA, 31201' };
const addr = (line1, city, zip) => ({ line1, line2: '', city, state: 'GA', zip });
const HOME_IN = addr('205 Lawrence St NE', 'Marietta', '30060');
const HOME_NEAR = addr('121 E Main St', 'Cartersville', '30120');
const HOME_FAR = addr('700 Poplar St', 'Macon', '31201');

let w;
let env;
beforeEach(async () => {
  w = fakeApplicantWorld();
  w.world.census = { '205 lawrence': MARIETTA, '121 e main': CARTERSVILLE, '700 poplar': MACON };
  env = { ...w.env, DB: await createD1() };
  globalThis.fetch = w.fetchImpl;
  clearFormCache();
});
const calls = () => w.world.censusCalls || 0;
const form = () => formFor(env.DB, { year: YEAR });

async function readyDraft(answers) {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  await saveDraft(env.DB, await getDraft(env.DB, id), { answers, page: 'finish' });
  for (const f of PHOTOS) {
    await env.FILES.put(photoKey(id, f), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await setDraftFile(env.DB, id, f, { key: photoKey(id, f), type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${f}.jpg` });
  }
  w.world.videos.vid1 = { uid: 'vid1', readyToStream: false, status: { state: 'inprogress' }, duration: -1 };
  await setDraftFile(env.DB, id, 'video', { uid: 'vid1', uploaded: true, size: 1000, name: 'clip.mov' });
  return getDraft(env.DB, id);
}
const answersAt = (address, over = {}) => ({ ...testAnswers('mom@example.com', YEAR), childName: { first: 'Avery', last: 'Stone' }, address, ...over });

// ── Geometry ────────────────────────────────────────────────────────

test('a home lands inside, close (within the close miles) or farther out', () => {
  assert.equal(placeHome(MARIETTA.lat, MARIETTA.lng, AREA).band, 'inside');
  const near = placeHome(CARTERSVILLE.lat, CARTERSVILLE.lng, AREA);
  assert.equal(near.band, 'near');
  assert.ok(near.miles > 9 && near.miles < 11, `Cartersville is about 10 miles out (${near.miles})`);
  assert.equal(placeHome(CARTERSVILLE.lat, CARTERSVILLE.lng, { polygon: POLY, nearMiles: 5 }).band, 'far', 'a smaller close distance makes it farther out');
  assert.equal(placeHome(CARTERSVILLE.lat, CARTERSVILLE.lng, { polygon: POLY, nearMiles: 0 }).band, 'far', '0 turns "close" off');
  assert.equal(placeHome(MACON.lat, MACON.lng, AREA).band, 'far');
  assert.equal(placeHome(null, null, AREA).band, 'unknown');
  assert.equal(placeHome(MARIETTA.lat, MARIETTA.lng, { polygon: [] }).band, 'unknown');
});

test('the close ring sits the close distance outside the line, all the way round', () => {
  const ring = nearRing(POLY, 15);
  assert.equal(ring.length, 144);
  for (const pt of ring) {
    assert.equal(insidePolygon(pt, POLY), false);
    assert.ok(Math.abs(milesToEdge(pt, POLY) - 15) < 0.05, `${pt} is ${milesToEdge(pt, POLY)} miles out`);
  }
  assert.deepEqual(nearRing(POLY, 0), [], 'no ring when "close" is off');
});

test('counting families by band, and who changes band when the area changes', () => {
  const pts = [{ id: 'a', ...MARIETTA }, { id: 'b', ...CARTERSVILLE }, { id: 'c', ...MACON }, { id: 'd', lat: null, lng: null }];
  assert.deepEqual(bandCounts(pts, AREA), { inside: 1, near: 1, far: 1, unknown: 1 });
  const smaller = { polygon: [[34.2, -84.4], [34.0, -84.2], [33.9, -84.4]], nearMiles: 15 };
  assert.deepEqual(bandChanges(pts, AREA, smaller).map(c => `${c.id}:${c.from}>${c.to}`), ['a:inside>near', 'b:near>far']);
  assert.deepEqual(areaRules({ nearMiles: 99, beyond: 'nope' }, POLY), { polygon: POLY, nearMiles: 50, beyond: 'warn' });
});

// ── The form's question ─────────────────────────────────────────────

test('the built-in form asks the service area under the address, and only stops families far out when Settings say so', () => {
  const f = applicationForm({ year: YEAR });
  const page = f.pages.find(p => p.id === 'service-area');
  assert.deepEqual(page.fields.map(x => x.id), ['serviceAreaText', 'address', 'boundary', 'county', 'resides50'], 'address, then the check, county and the 50% question');
  const b = allFields(f).find(x => x.id === 'boundary');
  assert.equal(b.type, 'area');
  assert.deepEqual(b.options, Object.values(AREA_VALUES), 'the stored answers are the Jotform ones, so every application reads the same');
  assert.match(b.descriptions[AREA_VALUES.near], /\{miles\}/, 'what close families read carries the distance');
  assert.equal(b.stops, undefined);
  assert.equal(stopFor(f, { boundary: AREA_VALUES.far }), null);
  const stopping = applicationForm({ year: YEAR, definition: { ...DEFAULT_DEFINITION, serviceArea: { ...DEFAULT_SERVICE_AREA, beyond: 'stop' } } });
  assert.equal(stopFor(stopping, { boundary: AREA_VALUES.far })?.key, 'outside');
  assert.ok(!/\bred\b/i.test(JSON.stringify(DEFAULT_DEFINITION.pages[1]) + DEFAULT_DEFINITION.stops.outside.body), 'no "outlined in red" left anywhere');
  assert.deepEqual(Object.entries(translationStatus(DEFAULT_DEFINITION)).filter(([, v]) => v !== 'done'), [], 'all of it is in Spanish');
});

test('the editor can reword the check but not break it', () => {
  const moved = clone(DEFAULT_DEFINITION);
  const b = moved.pages[1].fields.splice(2, 1)[0];
  moved.pages[2].fields.push(b);
  assert.match(problems(moved), /same page, below/);

  const above = clone(DEFAULT_DEFINITION);
  const fs = above.pages[1].fields;
  [fs[1], fs[2]] = [fs[2], fs[1]];
  assert.match(problems(above), /same page, below/);

  const two = clone(DEFAULT_DEFINITION);
  two.pages[1].fields.push({ ...clone(field(two, 'boundary')), id: 'boundary2' });
  assert.match(problems(two), /one service-area check/);

  const noStop = clone(DEFAULT_DEFINITION);
  delete noStop.stops.outside;
  assert.match(problems(noStop), /Keep the "outside" stop screen/);

  const gone = clone(DEFAULT_DEFINITION);
  gone.pages[1].fields = gone.pages[1].fields.filter(f => f.id !== 'boundary');
  assert.match(problems(gone), /"boundary" feeds/);

  const extra = clone(DEFAULT_DEFINITION);
  field(extra, 'boundary').options.push('Somewhere else');
  assert.match(problems(extra), /reword them, not add new ones/);

  const reworded = clone(DEFAULT_DEFINITION);
  field(reworded, 'boundary').options[0].label = 'Yes, inside';
  field(reworded, 'boundary').stops = { [AREA_VALUES.near]: 'outside' };
  assert.equal(problems(reworded), '', 'rewording is fine');
  assert.equal(field(normalizeDefinition(reworded), 'boundary').stops, undefined, 'its stop comes from Settings, never the field');

  const d = diffDefinitions(normalizeDefinition(DEFAULT_DEFINITION), normalizeDefinition({ ...DEFAULT_DEFINITION, serviceArea: { ...DEFAULT_SERVICE_AREA, nearMiles: 8, beyond: 'stop' } }));
  assert.deepEqual(d.filter(x => x.area === 'Settings').map(x => x.text), ['"Close to the area" is now within 8 miles', 'Families far outside the area are now stopped']);
});

// ── The check as families type, and on submit ───────────────────────

test('a check is stored on the draft, and the same address is never looked up twice', async () => {
  const draft = await readyDraft(answersAt(HOME_IN));
  const f = await form();
  const before = calls();
  const one = await areaCheck(env, f, HOME_IN, { draft });
  assert.equal(one.band, 'inside');
  assert.equal(one.county, 'Cobb');
  assert.equal(calls(), before + 1);
  const again = await areaCheck(env, f, { ...HOME_IN, line1: '205  lawrence st ne' }, { draft: await getDraft(env.DB, draft.id) });
  assert.equal(again.band, 'inside');
  assert.equal(calls(), before + 1, 'spacing and case don’t make it a new address');
  assert.equal((await getDraft(env.DB, draft.id)).area_checks, 1);
  assert.equal((await areaCheck(env, f, { line1: '205 Lawrence', city: '', state: 'GA', zip: '' }, { draft })).reason, 'incomplete', 'half an address isn’t asked about');
});

test('the saved answer is the check’s, not the browser’s word for it', async () => {
  const draft = await readyDraft(answersAt(HOME_FAR, { boundary: AREA_VALUES.inside }));
  const f = await form();
  await areaCheck(env, f, HOME_FAR, { draft });
  await saveDraft(env.DB, await getDraft(env.DB, draft.id), { answers: answersAt(HOME_FAR, { boundary: AREA_VALUES.inside }), page: 'service-area' });
  assert.equal((await getDraft(env.DB, draft.id)).answers.boundary, AREA_VALUES.far);
  // The outline moves: the stored point is placed again, no new lookup
  const before = calls();
  const placed = placedArea((await getDraft(env.DB, draft.id)).area, HOME_FAR, { polygon: [[33.0, -84.0], [33.0, -83.3], [32.6, -83.3], [32.6, -84.0]], nearMiles: 15 });
  assert.equal(placed.band, 'inside');
  assert.equal(calls(), before);
});

test('submit checks the address on file again, and the family is told (not stopped) by default', async () => {
  // They changed the address after the last check: submit looks it up
  const draft = await readyDraft(answersAt(HOME_IN));
  await areaCheck(env, await form(), HOME_IN, { draft });
  await saveDraft(env.DB, await getDraft(env.DB, draft.id), { answers: answersAt(HOME_FAR, { boundary: AREA_VALUES.inside }), page: 'finish' });
  const before = calls();
  const sub = await submitDraft(env, await getDraft(env.DB, draft.id));
  assert.equal(sub.ok, true);
  assert.equal(calls(), before + 1);
  const app = await getApplication(env.DB, sub.id);
  assert.equal(app.answers.boundary, AREA_VALUES.far);
  assert.equal(app.jt_state.formArea.band, 'far');
  assert.ok(app.jt_state.formArea.miles > 70);
});

test('an answer to a question the family no longer sees (Sensory Yes, explained, then No) is never sent; the draft keeps it', async () => {
  const draft = await readyDraft(answersAt(HOME_IN, { sensory: 'No', sensoryDetail: 'Loud noises', destructive: 'Yes', destructiveDetail: 'Kicks the wall' }));
  await areaCheck(env, await form(), HOME_IN, { draft });
  const sub = await submitDraft(env, await getDraft(env.DB, draft.id));
  assert.equal(sub.ok, true);
  const app = await getApplication(env.DB, sub.id);
  assert.equal(app.answers.sensoryDetail, undefined);
  assert.equal(app.answers.destructiveDetail, 'Kicks the wall', 'one still asked for is sent');
  assert.equal((await getDraft(env.DB, draft.id)).answers.sensoryDetail, 'Loud noises');
});

test('with Settings stopping families far out, submit refuses a far home', async () => {
  await saveFormRules(env.DB, { serviceArea: { beyond: 'stop' } }, { user: 'peter@soardcharity.com' });
  const sub = await submitDraft(env, await readyDraft(answersAt(HOME_FAR, { boundary: AREA_VALUES.inside })));
  assert.deepEqual([sub.ok, sub.error, sub.stop], [false, 'stopped', 'outside']);
  const near = await submitDraft(env, await readyDraft(answersAt(HOME_NEAR)));
  assert.equal(near.ok, true, 'close homes always can');
});

test('an address the Census can’t find, or a Census outage, leaves the answer to the family', async () => {
  const lost = await readyDraft(answersAt(addr('9 Nowhere Ln', 'Faketown', '30999'), { boundary: AREA_VALUES.near }));
  const sub = await submitDraft(env, lost);
  assert.equal(sub.ok, true);
  const app = await getApplication(env.DB, sub.id);
  assert.equal(app.answers.boundary, AREA_VALUES.near, 'their own answer');
  assert.equal(app.jt_state.formArea.reason, 'no-match');

  w.world.censusDown = true;
  const down = await readyDraft(answersAt(HOME_IN, { boundary: AREA_VALUES.near }));
  const out = await areaCheck(env, await form(), HOME_IN, { draft: down });
  assert.equal(out.reason, 'error');
  assert.equal((await getDraft(env.DB, down.id)).area, null, 'an outage isn’t kept: the next try asks again');
  const s2 = await submitDraft(env, await getDraft(env.DB, down.id));
  assert.equal((await getApplication(env.DB, s2.id)).answers.boundary, AREA_VALUES.near);
});

test('a Census outage: OpenStreetMap places the home on its street instead, and only a street that matches', async () => {
  w.world.censusDown = true;
  // OpenStreetMap knows a building a few doors down the same street (Photon's long street names)
  w.world.osm = {
    'lawrence': [{ lat: 33.95354, lng: -84.54665, housenumber: '211', street: 'Lawrence Street Northeast', postcode: '30060', city: 'Marietta', county: 'Cobb County' }],
    'poplar': [{ lat: 32.83601, lng: -83.63224, housenumber: '700', street: 'Poplar Street', postcode: '31201', city: 'Macon', county: 'Bibb' }],
    'nowhere': [{ lat: 33.9, lng: -84.4, housenumber: '1', street: 'Elsewhere Road', postcode: '30339', city: 'Atlanta' }],
  };
  const draft = await readyDraft(answersAt(HOME_IN));
  const inside = await areaCheck(env, await form(), HOME_IN, { draft });
  assert.equal(inside.band, 'inside', 'placed inside from its street');
  assert.equal(inside.county, 'Cobb');
  assert.match(inside.matched, /^205 LAWRENCE ST NE, MARIETTA, GA, 30060$/);
  assert.ok(w.world.osmCalls >= 1);
  const far = await areaCheck(env, await form(), HOME_FAR, { draft: await getDraft(env.DB, draft.id) });
  assert.equal(far.band, 'far', 'far out, from OpenStreetMap too');
  assert.ok(far.miles > 60);
  const lost = await areaCheck(env, await form(), addr('1 Nowhere Ln', 'Faketown', '30999'), { draft: await getDraft(env.DB, draft.id) });
  assert.equal(lost.reason, 'error', 'a place on another street is no answer: the family is asked');
});

test('a house the Census doesn’t know: OpenStreetMap places it, but only the house itself (never a neighbor)', async () => {
  // A newer home on Main St in Duluth: not in the Census, mapped on OpenStreetMap
  w.world.osm = {
    '2450 main': [{ lat: 34.0024, lng: -84.1456, housenumber: '2450', street: 'Main Street', postcode: '30096', city: 'Duluth', county: 'Gwinnett County' }],
    '2460 main': [{ lat: 34.0025, lng: -84.1457, housenumber: '2450', street: 'Main Street', postcode: '30096', city: 'Duluth', county: 'Gwinnett County' }],
  };
  const draft = await readyDraft(answersAt(addr('2450 Main St', 'Duluth', '30096')));
  const found = await areaCheck(env, await form(), addr('2450 Main St', 'Duluth', '30096'), { draft });
  assert.equal(found.band, 'inside', 'placed from the house OpenStreetMap has');
  assert.equal(found.county, 'Gwinnett');
  const neighbor = await areaCheck(env, await form(), addr('2460 Main St', 'Duluth', '30096'), { draft: await getDraft(env.DB, draft.id) });
  assert.equal(neighbor.reason, 'no-match', 'only a neighbor is mapped: the family is asked');
});

test('a draft gets a limited number of lookups', async () => {
  const draft = await readyDraft(answersAt(HOME_IN));
  await env.DB.prepare('UPDATE application_drafts SET area_checks = ? WHERE id = ?').bind(MAX_AREA_CHECKS, draft.id).run();
  const before = calls();
  const out = await areaCheck(env, await form(), HOME_NEAR, { draft: await getDraft(env.DB, draft.id) });
  assert.equal(out.reason, 'limit');
  assert.equal(calls(), before);
});

test('intake uses the form’s check (no second lookup) and tells staff about a home far out', async () => {
  const sub = await submitDraft(env, await readyDraft(answersAt(HOME_FAR)));
  const before = calls();
  await processApplication(env, sub.id, { fetchImpl: w.fetchImpl });
  const app = await getApplication(env.DB, sub.id);
  assert.equal(calls(), before, 'intake didn’t ask the Census again');
  assert.equal(app.jt_state.area.from, 'form');
  assert.equal(app.jt_state.area.band, 'far');
  const note = w.account(app.jt_account_id).comments.find(c => c.name === 'Service area check (automatic)');
  assert.ok(note, 'an internal note for staff');
  assert.match(note.message, /About \d+(\.\d)? miles outside the service area/);
  assert.match(note.message, /The form placed the home from its address/);
});

// ── /api/apply ──────────────────────────────────────────────────────

const ctx = (body, headers = {}) => {
  const waits = [];
  return { env, request: new Request('https://example.test/api/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '5.6.7.8', ...headers }, body: JSON.stringify(body) }), waitUntil: (p) => waits.push(p), waits, data: {} };
};
const post = async (body, headers) => { const res = await applyApi.onRequestPost(ctx(body, headers)); return { status: res.status, body: await res.json() }; };

test('the area action answers with where the home is, and resume brings it back', async () => {
  const draft = await readyDraft(answersAt(HOME_NEAR));
  const r = await post({ action: 'area', token: draft.id, address: HOME_NEAR });
  assert.equal(r.status, 200);
  assert.equal(r.body.area.band, 'near');
  assert.equal(r.body.area.answer, AREA_VALUES.near);
  assert.equal(r.body.area.county, 'Bartow');
  assert.equal(r.body.area.key, undefined, 'no address key back to the page');
  const before = calls();
  await post({ action: 'area', token: draft.id, address: HOME_NEAR });
  assert.equal(calls(), before, 'asking again for the same address is free');
  const back = await post({ action: 'resume', token: draft.id });
  assert.equal(back.body.area.band, 'near');
  const strangers = await post({ action: 'area', address: HOME_NEAR });
  assert.equal(strangers.status, 404, 'no draft, no lookup (only signed-in staff may try it in a preview)');
});

test('the page gets the outline to draw, with the close distance and the far setting', async () => {
  const res = await applyApi.onRequestGet({ env, request: new Request('https://example.test/api/apply?config'), waitUntil() {}, data: {} });
  const j = await res.json();
  assert.deepEqual(j.definition.serviceArea, { polygon: POLY, nearMiles: 15, beyond: 'warn' });
  assert.deepEqual(j.form.serviceArea.polygon, POLY);
});

// ── Settings ────────────────────────────────────────────────────────

test('the close distance and the far setting save on their own, audited, and keep the outline', async () => {
  const out = await saveFormRules(env.DB, { serviceArea: { nearMiles: 8 } }, { user: 'peter@soardcharity.com' });
  assert.deepEqual(out.changes, [{ field: 'application.serviceArea.nearMiles', from: 15, to: 8 }]);
  assert.deepEqual(out.rules.serviceArea.polygon, POLY);
  const b = await saveFormRules(env.DB, { serviceArea: { beyond: 'stop' } }, { user: 'peter@soardcharity.com', base: out.updatedAt });
  assert.deepEqual(b.changes, [{ field: 'application.serviceArea.beyond', from: 'warn', to: 'stop' }]);
  assert.equal(b.rules.serviceArea.nearMiles, 8);
  const live = await form();
  assert.deepEqual([live.serviceArea.nearMiles, live.serviceArea.beyond], [8, 'stop']);
});

test('every outline is kept, newest first, so an old one can be put back', async () => {
  assert.deepEqual(await areaHistory(env.DB), []);
  const second = [[34.3, -84.5], [34.2, -84.0], [33.9, -84.1], [33.9, -84.5]];
  const a = await saveFormRules(env.DB, { serviceArea: { polygon: second } }, { user: 'peter@soardcharity.com' });
  let h = await areaHistory(env.DB);
  assert.equal(h.length, 2, 'the original and the new one');
  assert.deepEqual(h[0].polygon, second);
  assert.equal(h[0].live, true);
  assert.equal(h[0].by, 'peter@soardcharity.com');
  assert.deepEqual(h[1].polygon, POLY);
  assert.equal(h[1].note, 'The original outline');
  await saveFormRules(env.DB, { serviceArea: { nearMiles: 10 } }, { user: 'peter@soardcharity.com', base: a.updatedAt });
  assert.equal((await areaHistory(env.DB)).length, 2, 'only outline changes are history');
  await saveFormRules(env.DB, { serviceArea: { polygon: POLY } }, { user: 'kim@soardcharity.com' });
  h = await areaHistory(env.DB);
  assert.equal(h.length, 3);
  assert.deepEqual([h[0].polygon, h[0].by], [POLY, 'kim@soardcharity.com']);
});

// ── Insights and expiry ─────────────────────────────────────────────

test('Insights counts where families live and what the ones far out did', async () => {
  const mk = async (address, over = {}) => {
    const d = await readyDraft(answersAt(address));
    await areaCheck(env, await form(), address, { draft: d });
    if (over.stop) await env.DB.prepare("UPDATE application_drafts SET stop_key = 'outside' WHERE id = ?").bind(d.id).run();
    return d;
  };
  await mk(HOME_IN);
  await mk(HOME_NEAR);
  const far = await mk(HOME_FAR);
  await mk(HOME_FAR, { stop: true });
  await mk(addr('9 Nowhere Ln', 'Faketown', '30999'));
  await submitDraft(env, await getDraft(env.DB, far.id));
  const a = (await insights(env.DB, { year: YEAR })).area;
  assert.deepEqual([a.checked, a.inside, a.near, a.far, a.notFound], [5, 1, 1, 2, 1]);
  assert.deepEqual(a.farDid, { applied: 1, stopped: 1, left: 0 });
  assert.equal(a.nearMiles, 15);
  assert.deepEqual(a.steps.map(s => [s.from, s.to, s.count, s.close]), [[0, 5, 0, true], [5, 10, 0, true], [10, 15, 1, true], [15, 25, 0, false], [25, 50, 0, false], [50, null, 2, false]]);
});

test('an expired draft keeps only its band (inside / close / far) for the funnel', async () => {
  const d = await readyDraft(answersAt(HOME_NEAR));
  await areaCheck(env, await form(), HOME_NEAR, { draft: d });
  const later = Date.now() + (DRAFT_TTL_DAYS + 1) * 864e5;
  await expireDrafts(env, { now: later, fetchImpl: w.fetchImpl });
  const row = await env.DB.prepare('SELECT area, answers FROM application_drafts WHERE id = ?').bind(d.id).first();
  assert.deepEqual(JSON.parse(row.area), { band: 'near' });
  assert.equal(row.answers, '{}');
});
