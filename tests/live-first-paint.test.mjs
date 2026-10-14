/**
 * Live page first paint — when the server lays the page out for the video
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchParty } from '../functions/live/_watch-party.js';

const now = Date.parse('2026-10-14T18:00:00Z');
const at = (min) => new Date(now + min * 60e3).toISOString();
const pub = (extra) => ({ phase: 'idle', kidSlug: 'axel', player: null, scheduledAt: null, orientation: 'portrait', ...extra });
const live = pub({ phase: 'live', player: { kind: 'live', uid: 'in1', customerCode: 'c' } });

test('live with a video: watch party on /live/ and on that kid\'s page', () => {
  assert.deepEqual(watchParty(live, { now }), { mode: 'live', orientation: 'portrait', eyebrow: 'Live now' });
  assert.equal(watchParty(live, { pageKid: 'axel', now }).mode, 'live');
  assert.equal(watchParty({ ...live, phase: 'ending' }, { now }).mode, 'live', 'a dropped camera is still the live reveal');
});

test('never on another kid\'s page', () => {
  assert.equal(watchParty(live, { pageKid: 'dana', now }), null);
});

test('a Facebook-only broadcast keeps the photo hero', () => {
  assert.equal(watchParty(pub({ phase: 'live', player: null }), { now }), null);
});

test('replay with a video', () => {
  const r = watchParty(pub({ phase: 'replay', player: { kind: 'replay', uid: 'v1', customerCode: 'c' }, orientation: 'landscape' }), { now });
  assert.deepEqual(r, { mode: 'replay', orientation: 'landscape', eyebrow: 'Replay' });
});

test('starting soon only in the last 30 minutes, and only for a published kid', () => {
  assert.equal(watchParty(pub({ phase: 'armed', scheduledAt: at(10) }), { kidPublished: true, now }).mode, 'starting');
  assert.equal(watchParty(pub({ phase: 'scheduled', scheduledAt: at(45) }), { kidPublished: true, now }), null);
  assert.equal(watchParty(pub({ phase: 'armed', scheduledAt: at(10) }), { kidPublished: false, now }), null, 'no starting-soon screen without a built kid page');
  assert.equal(watchParty(pub({ phase: 'armed', scheduledAt: at(10), kidSlug: null }), { kidPublished: true, now }), null);
});

test('idle is the plain hero', () => {
  assert.equal(watchParty(pub({}), { now }), null);
  assert.equal(watchParty(null, { now }), null);
});
