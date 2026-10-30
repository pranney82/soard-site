/**
 * Google's help with the home address (functions/api/_google.js, through /api/apply): suggestions as
 * a family types, the parts of the one they pick, the Postal Service's word on the finished address,
 * the free monthly allowance it never goes past, and the free path when there's no key.
 * Google is faked here: every request is checked for what it asks and how.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { googleSuggest, googlePlace, googleVerify, spend, GOOGLE_MONTHLY } from '../functions/api/_google.js';
import * as applyApi from '../functions/api/apply.js';

const KEY = 'test-key-not-real';
let env;
let asked;
let google; // what the fake Google answers: { suggest, place, verify } → body, or a number (an HTTP error)
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  env = { DB: await createD1(), GOOGLE_MAPS_KEY: KEY };
  asked = [];
  google = {
    suggest: { suggestions: [
      { placePrediction: { placeId: 'ChIJ_home_one_0001', structuredFormat: { mainText: { text: '3167 Main Street' }, secondaryText: { text: 'Duluth, GA, USA' } } } },
      { placePrediction: { placeId: 'ChIJ_home_two_0002', structuredFormat: { mainText: { text: '3167 Main Street Northwest' }, secondaryText: { text: 'Kennesaw, GA, USA' } } } },
    ] },
    place: { addressComponents: [
      { longText: '3167', shortText: '3167', types: ['street_number'] },
      { longText: 'Main Street', shortText: 'Main St', types: ['route'] },
      { longText: '2', shortText: '2', types: ['subpremise'] },
      { longText: 'Duluth', shortText: 'Duluth', types: ['locality', 'political'] },
      { longText: 'Gwinnett County', shortText: 'Gwinnett County', types: ['administrative_area_level_2', 'political'] },
      { longText: 'Georgia', shortText: 'GA', types: ['administrative_area_level_1', 'political'] },
      { longText: '30096', shortText: '30096', types: ['postal_code'] },
    ] },
    verify: { result: { verdict: { possibleNextAction: 'ACCEPT' }, uspsData: { dpvConfirmation: 'Y', county: 'GWINNETT' } } },
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = new Headers(init.headers || {});
    const body = init.body ? JSON.parse(init.body) : null;
    const which = u.host === 'addressvalidation.googleapis.com' ? 'verify' : u.pathname.endsWith(':autocomplete') ? 'suggest' : u.host === 'places.googleapis.com' ? 'place' : 'other';
    asked.push({ which, url: u.href, key: headers.get('X-Goog-Api-Key'), mask: headers.get('X-Goog-FieldMask'), body });
    if (which === 'other') return json({ type: 'FeatureCollection', features: [] }); // OpenStreetMap: nothing
    const a = google[which];
    return typeof a === 'number' ? new Response('no', { status: a }) : json(a);
  };
});

test('suggestions: homes in the US near Atlanta, the key in a header, a street and its town', async () => {
  const out = await googleSuggest(env, '3167 Main');
  assert.deepEqual(out, [
    { id: 'ChIJ_home_one_0001', line1: '3167 Main St', sub: 'Duluth, GA' },
    { id: 'ChIJ_home_two_0002', line1: '3167 Main St NW', sub: 'Kennesaw, GA' },
  ]);
  const [req] = asked;
  assert.equal(req.key, KEY);
  assert.ok(!req.url.includes(KEY), 'the key never rides in a URL');
  assert.deepEqual(req.body.includedPrimaryTypes, ['street_address', 'premise', 'subpremise'], 'homes only, no businesses');
  assert.deepEqual(req.body.includedRegionCodes, ['us']);
  assert.equal(req.body.locationBias.circle.radius, 50000);
  assert.match(req.mask, /placePrediction\.placeId/);
  assert.equal(await googleSuggest(env, '31'), null, 'too short to ask');
  assert.equal(await googleSuggest({ DB: env.DB }, '3167 Main'), null, 'no key: the free path');
});

test('the home they pick: street (with its unit), city, state and ZIP; only the address parts are asked for', async () => {
  assert.deepEqual(await googlePlace(env, 'ChIJ_home_one_0001'), { line1: '3167 Main St', line2: '#2', city: 'Duluth', state: 'GA', zip: '30096' });
  assert.equal(asked[0].mask, 'addressComponents', 'Place Details: the address parts, nothing billed beyond them');
  assert.equal(await googlePlace(env, '../../etc'), null, 'not a place id: not asked');
  google.place = { addressComponents: [{ longText: 'Duluth', types: ['locality'] }] };
  assert.equal(await googlePlace(env, 'ChIJ_home_one_0001'), null, 'no street number: nothing to fill');
});

test('the Postal Service: known, a unit number may be missing, or check it; USPS processing on', async () => {
  const home = { line1: '3167 Main St', line2: '', city: 'Duluth', state: 'GA', zip: '30096' };
  assert.equal(await googleVerify(env, home), 'confirmed');
  const req = asked.at(-1);
  assert.equal(req.body.enableUspsCass, true);
  assert.deepEqual(req.body.address, { regionCode: 'US', addressLines: ['3167 Main St', 'Duluth GA 30096'] });
  assert.ok(!req.url.includes(KEY), 'the key in a header here too');
  google.verify = { result: { uspsData: { dpvConfirmation: 'D' } } };
  assert.equal(await googleVerify(env, home), 'unit');
  google.verify = { result: { verdict: { possibleNextAction: 'CONFIRM_ADD_SUBPREMISES' }, uspsData: {} } };
  assert.equal(await googleVerify(env, home), 'unit');
  google.verify = { result: { uspsData: { dpvConfirmation: 'N' } } };
  assert.equal(await googleVerify(env, home), 'check');
  google.verify = { result: { verdict: { validationGranularity: 'ROUTE', possibleNextAction: 'CONFIRM' }, uspsData: {} } };
  assert.equal(await googleVerify(env, { ...home, line1: '9999 Main St' }), 'check', 'only the street matched: no such house');
  google.verify = { result: { verdict: { validationGranularity: 'PREMISE', possibleNextAction: 'ACCEPT' } } };
  assert.equal(await googleVerify(env, home), null, 'the building matched but no Postal Service answer: no word');
  google.verify = 503;
  assert.equal(await googleVerify(env, home), null, 'Google down: no word, nothing in the way');
  assert.equal(await googleVerify(env, { ...home, zip: '300' }), null, 'not asked before the ZIP is whole');
});

test('never past the free allowance: at the cap each kind stops asking Google for the rest of the month', async () => {
  const may = new Date('2026-11-03T12:00:00Z');
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS google_usage (month TEXT NOT NULL, sku TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (month, sku))').run();
  await env.DB.prepare("INSERT INTO google_usage (month, sku, n) VALUES ('2026-11', 'verify', ?)").bind(GOOGLE_MONTHLY.verify - 1).run();
  assert.equal(await spend(env.DB, 'verify', may), true, 'the last one inside the allowance');
  assert.equal(await spend(env.DB, 'verify', may), false, 'then no more this month');
  assert.equal(await spend(env.DB, 'verify', new Date('2026-12-01T00:00:00Z')), true, 'a new month starts over');
  assert.ok(GOOGLE_MONTHLY.suggest < 10000 && GOOGLE_MONTHLY.place < 10000 && GOOGLE_MONTHLY.verify < 5000, 'every cap short of Google’s free allowance');
});

test('/api/apply: Google’s suggestions, the picked home’s parts and the Postal Service’s word; no key, the free path and no word', async () => {
  const get = async (q, e = env) => (await applyApi.onRequestGet({ env: e, request: new Request(`https://example.test/api/apply?${q}`, { headers: { 'CF-Connecting-IP': `ip-${q.length}` } }), waitUntil() {}, data: {} })).json();
  const s = await get('address=3167%20Main');
  assert.equal(s.source, 'google');
  assert.equal(s.results[0].line1, '3167 Main St');
  const p = await get('place=ChIJ_home_one_0001');
  assert.equal(p.address.zip, '30096');
  const v = await get('usps=1&line1=3167%20Main%20St&city=Duluth&state=GA&zip=30096');
  assert.equal(v.usps, 'confirmed');
  assert.equal((await get('config')).usps, true, 'the page knows to keep room for the word');

  const free = { DB: env.DB };
  const f = await get('address=3167%20Main%20St', free);
  assert.notEqual(f.source, 'google');
  assert.equal((await get('usps=1&line1=3167%20Main%20St&city=Duluth&state=GA&zip=30096', free)).usps, null);
  assert.equal((await get('config', free)).usps, false);
});
