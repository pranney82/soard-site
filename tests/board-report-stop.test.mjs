/**
 * A report on an item that shows live facts (the makeovers, the money) is a stop of its own on the screen, right after
 * the facts: the facts fill the item's own slide, so its report would never be read there
 *
 *   node --test tests/board-report-stop.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMeeting, deckOf, cleanLive, liveOfStop, stopIndex, NOTHING_NEW } from '../public/admin/board-shared.js';

const BOOKS = {
  revenue: 1876045, expenses: 1200000, year: '2026',
  lastYear: { year: '2025', revenue: 1500000, expenses: 1100000 },
  statements: { asOf: '2026-10-31', priorAsOf: '2025-10-31', activity: [{ k: 'sum', d: 0, label: 'Net', a: 1, p: 2 }], position: [{ k: 'sum', d: 0, label: 'Net assets', a: 3, p: 4 }] },
};
const meeting = (patch = {}) => cleanMeeting({
  id: 'm_rep1', date: '2099-11-05', shared: true,
  sections: [{ id: 's_one1', title: 'Committee reports', items: [
    { id: 'i_pro1', title: 'Projects updates and reveals', live: 'projects', also: ['reveals'], report: '### Where we are\nEight makeovers in build.', docs: ['f_plan1'], ...(patch.pro || {}) },
    { id: 'i_fin1', title: 'Financial', live: 'cash', report: 'Cash is up.', ...(patch.fin || {}) },
    { id: 'i_gov1', title: 'Governance', report: 'Two bylaws changes.', ...(patch.gov || {}) },
  ] }],
  files: [{ id: 'f_plan1', name: 'Build plan.pdf', type: 'application/pdf', kind: 'packet' }],
});
const keys = (deck) => deck.map((s) => s.key);

test('a live item’s report follows its facts: before its other live slides and its documents', () => {
  const deck = deckOf(meeting(), { books: BOOKS });
  const pro = keys(deck).filter((k) => k.startsWith('i_pro1'));
  assert.deepEqual(pro, ['i_pro1', 'i_pro1:report', 'i_pro1:live:reveals', 'i_pro1:f_plan1:0']);
  const stop = deck.find((s) => s.key === 'i_pro1:report');
  assert.deepEqual({ kind: stop.kind, itemId: stop.itemId, fileId: stop.fileId, page: stop.page, sectionId: stop.sectionId }, { kind: 'report', itemId: 'i_pro1', fileId: 'report', page: 0, sectionId: 's_one1' });
  assert.equal(stop.n, deck.find((s) => s.key === 'i_pro1').n, 'the same agenda number as its item');
});

test('the money item: its report, then QuickBooks’ slides', () => {
  const fin = keys(deckOf(meeting(), { books: BOOKS })).filter((k) => k.startsWith('i_fin1'));
  assert.equal(fin[0], 'i_fin1');
  assert.equal(fin[1], 'i_fin1:report');
  assert.ok(fin.slice(2).every((k) => k.startsWith('i_fin1:books:')), fin.join(' '));
});

test('no report stop for an item that shows nothing live, an empty report, or nothing new this time', () => {
  assert.ok(!keys(deckOf(meeting())).includes('i_gov1:report'), 'a plain item’s report is on its own slide');
  assert.ok(!keys(deckOf(meeting({ pro: { report: '  ' } }))).includes('i_pro1:report'), 'an empty report');
  assert.ok(!keys(deckOf(meeting({ pro: { report: NOTHING_NEW } }))).includes('i_pro1:report'), 'nothing new this time');
});

test('the live state that puts the report on the screen, and back from it', () => {
  const deck = deckOf(meeting(), { books: BOOKS });
  const i = deck.findIndex((s) => s.key === 'i_pro1:report');
  const live = liveOfStop(deck[i]);
  assert.deepEqual({ itemId: live.itemId, fileId: live.fileId, screen: live.screen }, { itemId: 'i_pro1', fileId: 'report', screen: '' });
  // Saved and read back (cleanLive keeps it), then found again
  const kept = cleanLive({ ...live, startedAt: '2099-11-05T13:00:00.000Z' });
  assert.equal(kept.fileId, 'report');
  assert.equal(stopIndex(deck, kept), i);
  // A report emptied since: the item's own slide, never the cover
  const without = deckOf(meeting({ pro: { report: '' } }), { books: BOOKS });
  assert.equal(without[stopIndex(without, kept)].key, 'i_pro1');
});
