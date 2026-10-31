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

test('the street typed is the street: the same number on another street is never offered', async () => {
  const out = await suggestAddresses('1000 Holcomb Woods Pkwy, Roswell, GA 30076', photon([house('1000', 'Woodstock Road', 'Roswell', '30075'), house('1000', 'Holcomb Woods Parkway', 'Roswell', '30076')]));
  assert.deepEqual(out.map((a) => a.label), ['1000 Holcomb Woods Pkwy, Roswell, GA 30076']);
  const galleria = await suggestAddresses('200 Galleria Pkwy SE, Atlanta, GA 30339', photon([house('200', 'Interstate North Parkway Southeast', 'Atlanta', '30339'), house('200', 'Galleria Parkway Southeast', 'Atlanta', '30339')]));
  assert.deepEqual(galleria.map((a) => a.line1), ['200 Galleria Pkwy SE']);
  // Begun, and with a direction first
  assert.equal((await suggestAddresses('1000 Holc', photon([house('1000', 'Holcomb Bridge Road', 'Roswell', '30076')]))).length, 1);
  assert.equal((await suggestAddresses('12 N Main', photon([house('12', 'North Main Street')]))).length, 1);
});
