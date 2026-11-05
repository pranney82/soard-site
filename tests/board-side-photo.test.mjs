/**
 * A photo filed "Photo beside the report" sits on its item's report slide: one slide, no stop of its own. Every other
 * file on an item, and the same photo on an item whose slide holds no report, stays a stop
 *
 *   node --test tests/board-side-photo.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMeeting, deckOf, sidePhoto, FILE_KINDS } from '../public/admin/board-shared.js';

const photo = { id: 'f_side1', name: 'Ryan.jpg', type: 'image/jpeg', kind: 'side' };
const shot = { id: 'f_shot1', name: 'Home.png', type: 'image/png', kind: 'other' };
const paper = { id: 'f_doc01', name: 'Bio.pdf', type: 'application/pdf', kind: 'side' };
const meeting = (item, files = [photo]) => cleanMeeting({
  id: 'm_side1', date: '2099-11-05', shared: true,
  sections: [{ id: 's_one1', title: 'Call to order', items: [{ id: 'i_one1', title: 'Welcoming Ryan', docs: files.map((f) => f.id), ...item }] }],
  files,
});
const stops = (m) => deckOf(m).filter((s) => s.itemId === 'i_one1').map((s) => s.kind);

test('it can be filed from the kind menu, and a clean meeting keeps it', () => {
  assert.ok(FILE_KINDS.some((k) => k.id === 'side'));
  assert.equal(meeting({ report: '- One\n- Two' }).files[0].kind, 'side');
});

test('with a report, the photo is on that slide: one stop', () => {
  const m = meeting({ report: '- One\n- Two' });
  assert.deepEqual(stops(m), ['item']);
  assert.equal(sidePhoto(m.sections[0].items[0], m.files).id, 'f_side1');
});

test('a photo with no report to sit beside is a stop like any file', () => {
  assert.deepEqual(stops(meeting({ report: '' })), ['item', 'doc']);
});

test('an item whose report has a slide of its own keeps the photo a stop', () => {
  assert.deepEqual(stops(meeting({ report: '- One\n- Two', notes: 'Said on its own slide' })), ['item', 'report', 'doc']);
});

test('only a photo: a PDF under that kind is still a stop', () => {
  assert.deepEqual(stops(meeting({ report: '- One\n- Two' }, [paper])), ['item', 'doc']);
});

test('nothing else moves: a screenshot on the same item stays a stop of its own', () => {
  assert.deepEqual(stops(meeting({ report: '- One\n- Two' }, [photo, shot])), ['item', 'doc']);
  assert.equal(deckOf(meeting({ report: '- One\n- Two' }, [photo, shot])).find((s) => s.kind === 'doc').fileId, 'f_shot1');
  assert.deepEqual(stops(meeting({ report: '- One\n- Two' }, [shot])), ['item', 'doc']);
});

test('an item called "Welcome" is the go-around (its faces, then its report), so the photo stays a stop; "Welcoming" is a report', () => {
  assert.deepEqual(stops(meeting({ title: 'Welcome new board member', report: '- One\n- Two' })), ['item', 'report', 'doc']);
  assert.deepEqual(stops(meeting({ title: 'Welcoming new board member', report: '- One\n- Two' })), ['item']);
});
