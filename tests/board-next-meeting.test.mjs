/**
 * The next meeting (board-shared.js nextMeeting): the soonest from today on, except one the chair already started
 * and ended before its day (moved up and held early), which is past. One held today is still today's meeting.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMeeting, heldEarly } from '../public/admin/board-shared.js';

const TODAY = '2026-11-02';
const meeting = (id, date, live = {}) => ({ id, date, live: { startedAt: '', endedAt: '', ...live } });
const ran = { startedAt: '2026-11-02T13:00:00.000Z', endedAt: '2026-11-02T14:10:00.000Z' };

test('the soonest meeting from today on is next; a past one never is', () => {
  const list = [meeting('q3', '2026-08-20'), meeting('q1', '2027-02-11'), meeting('q4', '2026-11-05')];
  assert.equal(nextMeeting(list, TODAY)?.id, 'q4');
  assert.equal(nextMeeting([meeting('q3', '2026-08-20')], TODAY), null);
});

test('a meeting held early (started and ended before its day) is past: the next is the one after it', () => {
  const list = [meeting('q4', '2026-11-05', ran), meeting('q1', '2027-02-11')];
  assert.equal(heldEarly(list[0], TODAY), true);
  assert.equal(nextMeeting(list, TODAY)?.id, 'q1');
});

test('one being held now, or held today, is still the next meeting; Resume (no end) puts it back', () => {
  assert.equal(nextMeeting([meeting('q4', '2026-11-05', { startedAt: ran.startedAt }), meeting('q1', '2027-02-11')], TODAY)?.id, 'q4');
  assert.equal(nextMeeting([meeting('q4', TODAY, ran), meeting('q1', '2027-02-11')], TODAY)?.id, 'q4');
  assert.equal(heldEarly(meeting('q4', TODAY, ran), TODAY), false);
  assert.equal(heldEarly(meeting('q4', '2026-11-05', { ...ran, endedAt: '' }), TODAY), false);
});
