/**
 * An item shows several live lists (the makeovers and the reveals under one item), and the money item shows
 * QuickBooks' own slides: each a stop on the screen, the chair's and the board's decks the same
 *
 *   node --test tests/board-shows.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMeeting, deckOf, forBoard, showsOf, booksDraw, cleanLive, liveOfStop, stopIndex, isFilled } from '../public/admin/board-shared.js';

const BOOKS = {
  revenue: 1876045, expenses: 1200000, year: '2026',
  lastYear: { year: '2025', revenue: 1500000, expenses: 1100000 },
  monthly: { year: '2026', months: [{ month: '2026-01', revenue: 100, spent: 50 }], lastYear: '2025', last: [{ month: '2025-01', revenue: 90, spent: 40 }] },
  statements: { asOf: '2026-10-31', priorAsOf: '2025-10-31', activity: [{ k: 'sum', d: 0, label: 'Net', a: 1, p: 2 }], position: [{ k: 'sum', d: 0, label: 'Net assets', a: 3, p: 4 }] },
};
const meeting = () => cleanMeeting({
  id: 'm_show1', date: '2099-11-05', shared: true,
  sections: [{ id: 's_one1', title: 'Committee reports', items: [
    { id: 'i_pro1', title: 'Projects and reveals', live: 'projects', also: ['reveals', 'projects', 'bogus', 'minutes'] },
    { id: 'i_fin1', title: 'Financial', live: 'cash', docs: ['f_bs1', 'f_bud1'] },
  ] }],
  files: [
    { id: 'f_bs1', name: 'Balance sheet.pdf', type: 'application/pdf', kind: 'financials' },
    { id: 'f_bud1', name: '2026 budget.xlsx', type: 'application/vnd.ms-excel', kind: 'financials' },
  ],
});

test('an item keeps the live lists it shows after its first, each once, never its first again or the minutes', () => {
  const it = meeting().sections[0].items[0];
  assert.deepEqual(it.also, ['reveals']);
  assert.deepEqual(showsOf(it), ['projects', 'reveals']);
  assert.equal(isFilled({ also: ['events'] }), true);
  assert.deepEqual(forBoard(meeting()).sections[0].items[0].also, ['reveals'], 'the board sees them');
});

test('each show is a stop; after the money QuickBooks’ slides, and its statements never again as files (a budget still is)', () => {
  const plain = deckOf(meeting()).map((s) => s.key);
  assert.deepEqual(plain.filter((k) => k.startsWith('i_')), ['i_pro1', 'i_pro1:live:reveals', 'i_fin1', 'i_fin1:f_bs1:0', 'i_fin1:f_bud1:0']);
  const withBooks = deckOf(meeting(), { books: BOOKS }).map((s) => s.key);
  assert.deepEqual(withBooks.filter((k) => k.startsWith('i_fin1')), ['i_fin1', 'i_fin1:books:year', 'i_fin1:books:act', 'i_fin1:books:pos', 'i_fin1:f_bud1:0']);
  assert.deepEqual(deckOf(forBoard(meeting()), { books: BOOKS }).map((s) => s.key), withBooks, 'the screen’s deck, stop for stop');
  // With the store in the books, its slide comes after the year and before the statements
  const withStore = deckOf(meeting(), { books: { ...BOOKS, store: { sales: 415000, cost: 250000, profit: 165000 } } }).map((s) => s.key);
  assert.deepEqual(withStore.filter((k) => k.startsWith('i_fin1')), ['i_fin1', 'i_fin1:books:year', 'i_fin1:books:store', 'i_fin1:books:act', 'i_fin1:books:pos', 'i_fin1:f_bud1:0']);
  assert.deepEqual(booksDraw({ revenue: 1, store: { sales: 0, cost: 0, profit: 0 } }), [], 'a store at zero is no slide');
  assert.deepEqual(booksDraw({ revenue: 1, store: { sales: 1, cost: 0, profit: 1 } }), ['store'], 'nor is a store a statement: the year and statements stay their own');
  assert.deepEqual(booksDraw({ revenue: 1 }), [], 'no year to set it beside, no statements: none');
  assert.deepEqual(booksDraw(null), []);
});

test('the chair moves to a show or a QuickBooks slide, and the board page follows it there', () => {
  const deck = deckOf(meeting(), { books: BOOKS });
  for (const key of ['i_pro1:live:reveals', 'i_fin1:books:act']) {
    const stop = deck.find((s) => s.key === key);
    const live = cleanLive({ ...liveOfStop(stop), startedAt: '2099-11-05T13:00:00.000Z' });
    assert.equal(live.fileId, stop.fileId);
    assert.equal(deck[stopIndex(deck, live)].key, key);
  }
  assert.equal(cleanLive({ itemId: 'i_fin1', fileId: 'books:../../x' }).fileId, '', 'only the slides there are');
});

test('the meeting as it’s held carries each item’s other shows, so the screen’s deck has their stops', async () => {
  const { createD1 } = await import('./lib/d1-shim.mjs');
  const { saveMeeting, liveView } = await import('../functions/api/_board.js');
  const env = { DB: await createD1() };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await saveMeeting(env.DB, { ...meeting(), files: [] }, { by: 'jane@soardcharity.com' });
  const v = await liveView(env, 'm_show1', { admin: true });
  assert.deepEqual(v.sections[0].items.find((it) => it.id === 'i_pro1').also, ['reveals']);
  assert.ok(deckOf(v).some((s) => s.key === 'i_pro1:live:reveals'));
});
