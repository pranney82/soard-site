/**
 * Address suggestions from OpenStreetMap (functions/api/_address.js): the free path, used when Google's
 * key is off or its free allowance is used up
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestAddresses } from '../functions/api/_address.js';

const house = (n, street, city = 'Duluth', zip = '30096') => ({ properties: { countrycode: 'US', housenumber: n, street, city, state: 'Georgia', postcode: zip, county: 'Gwinnett County' } });
const photon = (features) => async () => new Response(JSON.stringify({ type: 'FeatureCollection', features }), { headers: { 'Content-Type': 'application/json' } });

test('the house number typed is the house: a neighbor on the same street is never offered', async () => {
  const out = await suggestAddresses('3167 Main St Duluth', photon([house('3180', 'Main Street'), house('3167', 'Main Street'), house('2450', 'Main Street')]));
  assert.deepEqual(out.map((a) => a.label), ['3167 Main St, Duluth, GA 30096']);
  assert.equal(out[0].county, 'Gwinnett');
});

test('no house with that number: nothing offered (the family enters it themselves)', async () => {
  assert.deepEqual(await suggestAddresses('3167 Main', photon([house('3180', 'Main Street')])), []);
});

test('too short, or no number: not asked', async () => {
  let asked = 0;
  const count = async () => { asked++; return new Response('{}'); };
  assert.deepEqual(await suggestAddresses('31', count), []);
  assert.deepEqual(await suggestAddresses('Main Street', count), []);
  assert.equal(asked, 0);
});
