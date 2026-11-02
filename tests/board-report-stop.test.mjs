/**
 * A report on an item that shows live facts (the makeovers, the money) is a stop of its own on the screen, right after
 * the facts: the facts fill the item's own slide, so its report would never be read there. An item's motion beside more
 * than it is a slide of its own at the end ("The decision"); a statement takes as many slides as its lines; a very tall
 * page as many stops as its parts; and the figures read in one form
 *
 *   node --test tests/board-report-stop.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMeeting, deckOf, cleanLive, liveOfStop, stopIndex, NOTHING_NEW, statementBreaks, mainLines, linePlaces, SLIDE_LINES } from '../public/admin/board-shared.js';
import { amount, monthsText, moneyTiles, shortAsOf, overIn } from '../public/admin/board/money.js';

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

// ─── The decision: an item's motion on a slide of its own ──────────

test('a motion beside a report, notes or live facts is a slide of its own, last on its item, after all it shows', () => {
  const deck = deckOf(meeting({ pro: { motion: 'Move to approve the build plan.' }, gov: { motion: 'Move to adopt the bylaws.' } }), { books: BOOKS });
  assert.deepEqual(keys(deck).filter((k) => k.startsWith('i_pro1')), ['i_pro1', 'i_pro1:report', 'i_pro1:live:reveals', 'i_pro1:f_plan1:0', 'i_pro1:decision'], 'after its report, its live slides and its documents: the vote follows them');
  assert.deepEqual(keys(deck).filter((k) => k.startsWith('i_gov1')), ['i_gov1', 'i_gov1:decision'], 'a plain item’s report on its card, then the decision');
  const stop = deck.find((s) => s.key === 'i_gov1:decision');
  assert.deepEqual({ kind: stop.kind, fileId: stop.fileId, page: stop.page, sectionId: stop.sectionId, n: stop.n }, { kind: 'decision', fileId: 'decision', page: 0, sectionId: 's_one1', n: deck.find((s) => s.key === 'i_gov1').n });
  // The notes are more to show, so are live facts with no report
  assert.ok(keys(deckOf(meeting({ gov: { report: '', notes: '- Two changes', motion: 'Move to adopt.' } }))).includes('i_gov1:decision'));
  assert.ok(keys(deckOf(meeting({ fin: { report: '', motion: 'Move to open the account.' } }), { books: BOOKS })).includes('i_fin1:decision'), 'the money’s figures fill its slide');
});

test('no decision slide for a motion on its own, a report with nothing in it, or no motion', () => {
  const only = deckOf(meeting({ gov: { report: '', motion: 'Move to adjourn.' } }));
  assert.ok(!keys(only).includes('i_gov1:decision'), 'the motion alone shares its card');
  assert.ok(!keys(deckOf(meeting({ gov: { report: NOTHING_NEW, motion: 'Move to adjourn.' } }))).includes('i_gov1:decision'), 'nothing new this time, nothing beside the motion');
  assert.ok(!keys(deckOf(meeting())).some((k) => k.endsWith(':decision')), 'no motion, no decision');
});

test('the vote on the last minutes has its usual motion: a decision slide only once there’s more than it to show', () => {
  const min = (patch) => cleanMeeting({ id: 'm_min1', date: '2099-11-05', sections: [{ id: 's_min1', title: 'Approve meeting minutes', items: [{ id: 'i_min1', title: 'Minutes', live: 'minutes', ...patch }] }] });
  assert.ok(!keys(deckOf(min({}))).includes('i_min1:decision'));
  assert.ok(keys(deckOf(min({ notes: '- One correction' }))).includes('i_min1:decision'));
});

test('the live state that puts the decision on the screen, and back from it', () => {
  const deck = deckOf(meeting({ gov: { motion: 'Move to adopt the bylaws.' } }), { books: BOOKS });
  const i = deck.findIndex((s) => s.key === 'i_gov1:decision');
  const kept = cleanLive({ ...liveOfStop(deck[i]), startedAt: '2099-11-05T13:00:00.000Z' });
  assert.equal(kept.fileId, 'decision');
  assert.equal(stopIndex(deck, kept), i);
  // The motion taken off since: the item's own slide
  const without = deckOf(meeting(), { books: BOOKS });
  assert.equal(without[stopIndex(without, kept)].key, 'i_gov1');
});

// ─── A statement in slides a room reads ─────────────────────────────

const ROWS = [
  { k: 'head', label: 'Revenue', d: 0 }, ...Array.from({ length: 6 }, (_, i) => ({ k: 'acct', label: `Gifts ${i + 1}`, d: 1, a: 1000 * (i + 1), p: 900 * (i + 1) })), { k: 'total', label: 'Total Revenue', d: 0, a: 21000, p: 18900 },
  { k: 'head', label: 'Expenses', d: 0 }, ...Array.from({ length: 14 }, (_, i) => ({ k: 'acct', label: `Cost ${i + 1}`, d: 1, a: 500 * (i + 1), p: 400 * (i + 1) })), { k: 'total', label: 'Total Expenses', d: 0, a: 52500, p: 42000 },
  { k: 'sum', label: 'Net Revenue', d: 0, a: -31500, p: -23100 },
];

test('a statement’s lines go on as many slides as they take, its top headings together where they fit, never cut after a heading', () => {
  const breaks = statementBreaks(ROWS);
  const lines = mainLines(ROWS);
  const at = linePlaces(ROWS, lines);
  const pages = breaks.map((b, i) => lines.filter((_, j) => at[j] >= b && at[j] < (breaks[i + 1] ?? Infinity)));
  assert.ok(pages.every((p) => p.length <= SLIDE_LINES), pages.map((p) => p.length).join(' '));
  assert.deepEqual(pages.flat(), lines, 'every line once, in order');
  assert.equal(pages[0][0].label, 'Revenue');
  assert.equal(pages[1][0].label, 'Expenses', 'the expenses start a slide of their own');
  assert.ok(pages.every((p) => p.at(-1).k !== 'head'), 'no slide ends on a heading');
  assert.equal(pages.at(-1).at(-1).label, 'Net Revenue');
  assert.deepEqual(statementBreaks([{ k: 'sum', label: 'Net', d: 0, a: 1, p: 2 }]), [0], 'a short one: one slide');
  assert.deepEqual(statementBreaks([]), [0]);
});

test('the deck gives each statement its slides, keys kept for the first, the same item and statement for the rest', () => {
  const books = { ...BOOKS, statements: { ...BOOKS.statements, activity: ROWS } };
  const deck = deckOf(meeting(), { books });
  const act = deck.filter((s) => s.fileId === 'books:act');
  assert.equal(act.length, statementBreaks(ROWS).length);
  assert.ok(act.length > 1);
  assert.deepEqual(act.map((s) => s.key), act.map((s, p) => `i_fin1:books:act${p ? `:${p}` : ''}`));
  assert.deepEqual(act.map((s) => s.page), act.map((_, p) => p));
  assert.equal(deck.filter((s) => s.fileId === 'books:pos').length, 1, 'a short one stays one');
  // The chair on the second, and back
  const live = cleanLive({ ...liveOfStop(act[1]), startedAt: '2099-11-05T13:00:00.000Z' });
  assert.equal(deck[stopIndex(deck, live)].key, 'i_fin1:books:act:1');
});

// ─── A very tall page in as many parts as it takes ─────────────────

test('a very tall page is as many stops as its parts, each one the live state names and finds again', () => {
  const m = meeting();
  const deck = deckOf(m, { pages: { f_plan1: 2 }, parts: { f_plan1: [4, 2] }, books: BOOKS });
  const plan = deck.filter((s) => s.fileId === 'f_plan1');
  assert.deepEqual(plan.map((s) => s.key), ['i_pro1:f_plan1:0', 'i_pro1:f_plan1:0:b', 'i_pro1:f_plan1:0:p2', 'i_pro1:f_plan1:0:p3', 'i_pro1:f_plan1:1', 'i_pro1:f_plan1:1:b'], 'the keys there were stay as they were');
  assert.deepEqual(plan.map((s) => [s.page, s.part, s.parts]), [[0, 0, 4], [0, 1, 4], [0, 2, 4], [0, 3, 4], [1, 0, 2], [1, 1, 2]]);
  for (const s of plan) {
    const live = cleanLive({ ...liveOfStop(s), startedAt: '2099-11-05T13:00:00.000Z' });
    assert.equal(live.part, s.part);
    assert.equal(deck[stopIndex(deck, live)].key, s.key);
  }
  // A deck that cut the page into fewer: the nearest part above
  const fewer = deckOf(m, { pages: { f_plan1: 2 }, parts: { f_plan1: [2, 1] }, books: BOOKS });
  assert.equal(fewer[stopIndex(fewer, { itemId: 'i_pro1', fileId: 'f_plan1', page: 0, part: 3 })].key, 'i_pro1:f_plan1:0:b');
  // Never more than eight, never a part the live state can't hold
  assert.equal(deckOf(m, { pages: { f_plan1: 1 }, parts: { f_plan1: [30] } }).filter((s) => s.fileId === 'f_plan1').length, 8);
  assert.equal(cleanLive({ itemId: 'i_pro1', fileId: 'f_plan1', part: 9 }).part, 0);
  assert.equal(cleanLive({ itemId: 'i_pro1', fileId: 'f_plan1', part: 2.5 }).part, 0);
});

// ─── Figures on the screen ─────────────────────────────────────────

test('amounts read in one form: a true minus, the short form from $10M, an overdrawn account said so, never “−0.3 months”', () => {
  assert.equal(amount(-48210), '−$48,210');
  assert.equal(amount(9999999), '$9,999,999');
  assert.equal(amount(1400000000), '$1.4B');
  assert.equal(amount(12500000), '$12.5M');
  assert.equal(monthsText(-0.3), 'Under a month');
  assert.equal(monthsText(0), 'Under a month');
  assert.equal(monthsText(8.46), '8.5');
  const [bank] = moneyTiles({ cash: { total: -48210, asOf: 'Nov 2, 2026', live: true, accounts: [] }, budget: null, n: null });
  assert.deepEqual([bank.label, bank.value, bank.quiet], ['Overdrawn', '$48,210', true]);
  assert.equal(moneyTiles({ cash: { total: 1400000000, asOf: '', live: true, accounts: [] }, budget: null, n: null })[0].value, '$1.4B');
  assert.equal(shortAsOf('Nov 2, 2026'), 'Nov 2', 'the month and its day never on two lines');
  assert.equal(overIn(1000, 1004, 'pct'), 'Even', 'a percent column never falls back to dollars');
});
