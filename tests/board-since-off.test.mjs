/**
 * "Since we last met" can be taken out of one meeting's presentation (Board's list of slides): gone from the deck the
 * chair and the board both follow, kept through a save and a merge, and it comes back. Every other meeting opens as before
 *
 *   node --test tests/board-since-off.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMeeting, deckOf, forBoard, hasSince, mergeMeeting } from '../public/admin/board-shared.js';

const meeting = (patch = {}) => cleanMeeting({
  id: 'm_since1', date: '2099-11-05', shared: true,
  sections: [{ id: 's_one1', title: 'Approve meeting minutes', items: [{ id: 'i_min1', title: 'Minutes', live: 'minutes', about: 'm_last1' }] }],
  ...patch,
});
const kinds = (m) => deckOf(m).map((s) => s.kind);

test('it opens every meeting that approves minutes, unless it was taken out', () => {
  assert.equal(meeting().noSince, false);
  assert.equal(kinds(meeting())[1], 'since');
});

test('off: gone from the deck, the rest of it the same', () => {
  const on = kinds(meeting());
  const off = kinds(meeting({ noSince: true }));
  assert.deepEqual(off, on.filter((k) => k !== 'since'));
  assert.ok(hasSince(meeting({ noSince: true })), 'Board can still offer to put it back');
});

test('the board sees the same deck as the chair', () => {
  assert.deepEqual(kinds(forBoard(meeting({ noSince: true }))), kinds(meeting({ noSince: true })));
});

test('a meeting with no minutes to approve never had it, and offers nothing to put back', () => {
  assert.equal(hasSince(meeting({ sections: [{ id: 's_one1', title: 'Other', items: [{ id: 'i_one1', title: 'News' }] }] })), false);
});

test('it survives someone else saving at the same moment', () => {
  const base = meeting();
  const { merged, clashes } = mergeMeeting(base, meeting({ noSince: true }), meeting({ location: 'Roswell' }));
  assert.equal(merged.noSince, true);
  assert.equal(clashes.length, 0);
});
