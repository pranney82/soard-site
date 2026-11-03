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
import { readFileSync } from 'node:fs';
import { cleanMeeting, deckOf, cleanLive, liveOfStop, stopIndex, NOTHING_NEW, statementBreaks, mainLines, linePlaces, SLIDE_LINES } from '../public/admin/board-shared.js';
import { amount, compact, monthsText, monthsPhrase, moneyTiles, shortAsOf, overIn } from '../public/admin/board/money.js';
import { StatementLines } from '../public/admin/board/books.js';

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

test('no statement slide holds more than a slide’s lines, "continued" line and all, whatever the shape (three headings, every size)', () => {
  // A top heading with g groups (a heading, an account, a total each) and o accounts of its own, then its total
  const blk = (h, g, o) => [{ k: 'head', label: h, d: 0 }, ...Array.from({ length: g }, (_, i) => [{ k: 'head', label: `${h} G${i}`, d: 1 }, { k: 'acct', label: 'x', d: 2, a: 1, p: 1 }, { k: 'total', label: `Total ${h} G${i}`, d: 1, a: 1, p: 1 }]).flat(), ...Array.from({ length: o }, (_, i) => ({ k: 'acct', label: `${h} A${i}`, d: 1, a: 1, p: 1 })), { k: 'total', label: `Total ${h}`, d: 0, a: 1, p: 1 }];
  const over = [];
  for (let g = 0; g <= 9; g++) for (let o1 = 0; o1 <= 18; o1++) for (let o2 = 0; o2 <= 18; o2++) for (let o3 = 0; o3 <= 12; o3++) {
    const rows = [...blk('Income', g, o1), ...blk('Expenses', 0, o2), ...(o3 ? blk('Other Income', 0, o3) : [])];
    const lines = mainLines(rows);
    const at = linePlaces(rows, lines);
    const breaks = statementBreaks(rows);
    const pages = breaks.map((b, i) => lines.filter((_, j) => at[j] >= b && at[j] < (breaks[i + 1] ?? Infinity)));
    // A slide that goes on with a heading begun before has a line for that ("Expenses, continued")
    const sizes = pages.map((p, i) => p.length + (i > 0 && !(p[0].k === 'head' && p[0].d === 0) ? 1 : 0));
    if (Math.max(...sizes) > SLIDE_LINES || pages.flat().length !== lines.length) over.push(`g=${g} ${o1}/${o2}/${o3}: ${sizes.join(',')}`);
  }
  assert.deepEqual(over.slice(0, 5), [], `${over.length} shapes over ${SLIDE_LINES} lines a slide`);
});

test('a statement’s change column is one unit on all its slides: percents only when every line has a base to take one of', () => {
  // The words a slide's table says, its cells apart
  const text = (v) => (v == null || typeof v === 'boolean' ? '' : typeof v !== 'object' ? String(v) : Array.isArray(v) ? v.map(text).join('|') : text(v.props?.children));
  const units = (rows) => statementBreaks(rows).map((_, page) => {
    const changes = text(StatementLines({ rows, asOf: '2026-10-31', priorAsOf: '2025-10-31', page, as: 'pct' })).match(/[▲▼] [^|]+/g) || [];
    return [...new Set(changes.map((c) => (c.endsWith('%') ? '%' : '$')))].join('');
  });
  const rows = (net) => [
    { k: 'head', label: 'Revenue', d: 0 }, ...Array.from({ length: 9 }, (_, i) => ({ k: 'acct', label: `Gifts ${i + 1}`, d: 1, a: 1100 * (i + 1), p: 1000 * (i + 1) })), { k: 'total', label: 'Total Revenue', d: 0, a: 49500, p: 45000 },
    { k: 'head', label: 'Expenses', d: 0 }, ...Array.from({ length: 9 }, (_, i) => ({ k: 'acct', label: `Cost ${i + 1}`, d: 1, a: 600 * (i + 1), p: 500 * (i + 1) })), { k: 'total', label: 'Total Expenses', d: 0, a: 27000, p: 22500 },
    { k: 'sum', label: 'Net Revenue', d: 0, ...net },
  ];
  // Every line has a year-ago base: percents on every slide
  assert.ok(units(rows({ a: 22500, p: 22500 * 0.9 })).length > 1);
  assert.deepEqual([...new Set(units(rows({ a: 22500, p: 20250 })))], ['%']);
  // The net was nothing a year ago (on the last slide): dollars on every slide, never % then $
  assert.deepEqual([...new Set(units(rows({ a: 1200, p: 0 })))], ['$']);
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

test('what rounds to nothing reads as nothing: "$0" (never −$0 or +$0), "Under a month" in a sentence, a tile never blank', () => {
  for (const n of [0, -0.4, 0.4, -0]) { assert.equal(amount(n), '$0', String(n)); assert.equal(compact(n), '$0', String(n)); }
  assert.equal(amount(-0.6), '−$1');
  // Months of cash in the board page's sentence: "Under a month of spending", "1 month", "8.5 months"
  assert.equal(monthsText(0.04), 'Under a month', 'never "0"');
  assert.deepEqual([0, -2, 0.04, 1, 1.04, 8.46, 16.8].map(monthsPhrase), ['Under a month', 'Under a month', 'Under a month', '1 month', '1 month', '8.5 months', '17 months']);
  // Overdrawn by 30¢ is $0 in the bank, not "Overdrawn $0"; a total that isn't a figure says so
  const tile = (total) => moneyTiles({ cash: { total, asOf: 'Nov 2, 2026', live: true, accounts: [] }, budget: null, n: null })[0];
  assert.deepEqual([tile(-0.3).label, tile(-0.3).value, tile(-0.3).quiet], ['Cash in the bank', '$0', false]);
  assert.equal(tile(NaN).value, '–');
  assert.equal(tile(undefined).value, '–');
  // Mercury's year so far: a sign only on a figure that has one
  const ytd = (net) => moneyTiles({ cash: { total: 5000, asOf: '', live: true, banks: ['Mercury'], accounts: [] }, budget: null, n: { finance: { ytd: { year: 2026, net, income: 1000, makeovers: 0, store: 0, operating: 1000, through: '2026-10-31' } } } }).find((t) => t.k === 'ytd').value;
  assert.deepEqual([ytd(0), ytd(-0.4), ytd(0.4), ytd(1200), ytd(-1200)], ['$0', '$0', '$0', '+$1,200', '−$1,200']);
});

test('the money item\'s generic figures list grows with the screen (the one type scale, no fixed most)', () => {
  const css = readFileSync(new URL('../public/admin/board/portal.css', import.meta.url), 'utf8');
  const rules = css.split('\n').filter((l) => l.startsWith('.bs-numbers'));
  assert.ok(rules.length >= 2);
  for (const r of rules) assert.ok(!/rem\)|\dvh/.test(r) && /--bs-(u|body)/.test(r), r);
});

test('a report with notes is a slide of its own after the item, which keeps the notes; the decision after both', () => {
  const d = keys(deckOf(meeting({ gov: { notes: '- Read the redline first', motion: 'Move to adopt the bylaws changes.' } })));
  const at = d.indexOf('i_gov1');
  assert.deepEqual(d.slice(at, at + 3), ['i_gov1', 'i_gov1:report', 'i_gov1:decision']);
  // No notes: the report is on the item's own slide, the decision after it
  const plain = keys(deckOf(meeting({ gov: { motion: 'Move to adopt the bylaws changes.' } })));
  assert.ok(!plain.includes('i_gov1:report'));
  assert.ok(plain.includes('i_gov1:decision'));
});

test("the board's faces keep their slide: a motion on the roll call is the decision's slide, a report on it a slide of its own", () => {
  const m = cleanMeeting({ id: 'm_roll1', date: '2099-11-05', shared: true, files: [], sections: [{ id: 's_c1', title: 'Call to order', items: [
    { id: 'i_roll1', title: 'Roll call', motion: 'Move to excuse Kim Park.' },
    { id: 'i_wel1', title: 'Welcome and introductions', report: 'Three guests tonight.' },
  ] }] });
  const d = keys(deckOf(m));
  assert.ok(d.includes('i_roll1:decision'));
  assert.ok(d.includes('i_wel1:report'));
});

test('the screen titles an untitled live item by what it shows, on its report and decision slides and in the foot', () => {
  const src = readFileSync(new URL('../public/admin/board/screen.js', import.meta.url), 'utf8');
  assert.match(src, /const itemTitle = item \? item\.title \|\| LIVE_TITLES\[item\.live\] \|\| MORE\.title : ''/);
  assert.ok(!/<\$\{Title\} text=\$\{item\.title\}/.test(src), 'no slide titles itself from item.title alone');
  assert.ok(!/\$\{item\?\.title\}/.test(src), 'nor the foot');
});

test("the vote on the last minutes shows the meeting's own motion approving them, never one that only mentions minutes", () => {
  const src = readFileSync(new URL('../public/admin/board/screen.js', import.meta.url), 'utf8');
  const re = new RegExp(src.match(/const MINUTES_MOTION = \/(.+)\/i;/)[1], 'i');
  for (const t of ['Approve the minutes of the Q3 Board Meeting', 'Move to approve the Q3 2026 board meeting minutes as written', 'I move that we adopt the minutes of Aug 10, 2026', 'Motion to accept the draft minutes']) assert.ok(re.test(t), t);
  for (const t of ['Move to approve the 2027 operating budget as presented and to report it in the minutes', 'Record the vote in the minutes', 'Approve the agenda as written']) assert.ok(!re.test(t), t);
});
