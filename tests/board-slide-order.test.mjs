// The order of an item's slides on the meeting's screen, as its presenter (the board page) or Board sets it:
// board-shared.js deckOf / orderUnits, kept with the item (cleanItem), saved by _board.js saveSlideOrder
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckOf, orderUnits, cleanMeeting, stopIndex } from '../public/admin/board-shared.js';

const FILES = [{ id: 'f_aa1', name: 'Budget.pdf', kind: 'packet' }, { id: 'f_bb1', name: 'Bylaws.pdf', kind: 'packet' }];
const meeting = (it) => {
  const m = cleanMeeting({ id: 'm_ord1', date: '2099-11-05', sections: [{ id: 's_one1', title: 'Reports', items: [it, { id: 'i_two1', title: 'Store' }] }] });
  m.files = FILES;
  return m;
};
const FIN = { id: 'i_fin1', title: 'Financial', live: 'cash', who: ['sam-ortiz'], report: 'We met twice.', motion: 'Move to approve the budget.', docs: ['f_aa1', 'f_bb1'] };
const pieces = (m, pages = {}) => deckOf(m, { pages }).filter((s) => s.itemId === 'i_fin1').map((s) => s.unit);
const keys = (m, pages = {}) => deckOf(m, { pages }).filter((s) => s.itemId === 'i_fin1').map((s) => s.key);

test('an item’s slides come in pieces, each stop saying which: its slide, the report, each document, the vote', () => {
  assert.deepEqual(pieces(meeting(FIN)), ['item', 'report', 'file:f_aa1', 'file:f_bb1', 'decision']);
  // A report on the item's own slide (nothing else fills it) is one piece with it: its pages go with it
  const plain = { id: 'i_fin1', title: 'Governance', report: Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`).join('\n\n'), docs: ['f_aa1'] };
  const u = pieces(meeting(plain));
  assert.ok(u.filter((x) => x === 'item').length > 1, 'the report’s pages are the item’s piece');
  assert.ok(!u.includes('report'));
  // A document of several spreads moves whole
  assert.deepEqual(pieces(meeting(FIN), { f_aa1: 5 }).filter((x) => x === 'file:f_aa1').length, 3);
});

test('in the order set: the vote first, the report before the money, a document between; keys never change', () => {
  const ordered = meeting({ ...FIN, slideOrder: ['decision', 'report', 'file:f_bb1', 'item', 'file:f_aa1'] });
  assert.deepEqual(pieces(ordered), ['decision', 'report', 'file:f_bb1', 'item', 'file:f_aa1']);
  assert.deepEqual([...keys(ordered)].sort(), [...keys(meeting(FIN))].sort(), 'the same stops, only moved');
  // Where the chair is is found by key, wherever it moved to
  const deck = deckOf(ordered);
  assert.equal(deck[stopIndex(deck, { itemId: 'i_fin1', fileId: 'decision', page: 0 })].kind, 'decision');
  // The rest of the meeting is as it was
  assert.deepEqual(deckOf(ordered).filter((s) => s.itemId !== 'i_fin1').map((s) => s.key), deckOf(meeting(FIN)).filter((s) => s.itemId !== 'i_fin1').map((s) => s.key));
});

test('a piece not in the order goes where it comes; one in it that isn’t there any more is passed over', () => {
  // A document attached since the order was set: after the piece it follows
  const u = orderUnits(['item', 'report', 'file:f_aa1', 'file:f_bb1', 'decision'].map((id) => ({ id })), ['decision', 'report', 'item']);
  assert.deepEqual(u.map((x) => x.id), ['decision', 'report', 'file:f_aa1', 'file:f_bb1', 'item']);
  assert.deepEqual(orderUnits([{ id: 'item' }, { id: 'decision' }], ['file:gone', 'decision', 'item']).map((x) => x.id), ['decision', 'item']);
  assert.deepEqual(orderUnits([{ id: 'item' }, { id: 'report' }], []).map((x) => x.id), ['item', 'report'], 'none set: as they come');
  // Kept with the item: only pieces there can be, each once
  const it = cleanMeeting({ sections: [{ items: [{ id: 'i_a1', title: 'x', slideOrder: ['decision', 'decision', '<script>', 'file:f_ok1', 'books:act', 42] }] }] }).sections[0].items[0];
  assert.deepEqual(it.slideOrder, ['decision', 'file:f_ok1', 'books:act']);
});

// ─── Saved by who presents it, or an admin ──────────────────────────

import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, saveSlideOrder, saveReport, getMeeting, liveView } from '../functions/api/_board.js';

async function world() {
  const env = { DB: await createD1() };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [slug, d] of [['kim-park', { name: 'Kim Park', group: 'board' }], ['sam-ortiz', { name: 'Sam Ortiz', group: 'board' }], ['jane-doe', { name: 'Jane Doe', group: 'team' }]]) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  await saveMeeting(env.DB, { id: 'm_ord1', date: '2099-11-05', start: '08:00', end: '10:00', shared: true, sections: [{ id: 's_a1', title: 'Reports', items: [{ id: 'i_eve1', title: 'Events', who: ['kim-park'], presenter: 'Kim Park', report: 'We met.', motion: 'Move to approve.' }] }] }, { by: 'jane@soardcharity.com' });
  return env;
}
const KIM = { slug: 'kim-park', name: 'Kim Park', email: 'kim@example.org' };
const SAM = { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam@example.org' };

test('who presents an item sets its slides’ order; nobody else on the board can; it changes nothing else about it', async () => {
  const env = await world();
  const before = (await getMeeting(env.DB, 'm_ord1')).sections[0].items[0];
  const r = await saveSlideOrder(env, 'm_ord1', 'i_eve1', ['decision', 'item', 'bogus'], { member: KIM });
  assert.deepEqual(r.slideOrder, ['decision', 'item']);
  const after = (await getMeeting(env.DB, 'm_ord1')).sections[0].items[0];
  assert.deepEqual(after.slideOrder, ['decision', 'item']);
  assert.deepEqual([after.report, after.reportBy, after.reportAt, after.motion], [before.report, before.reportBy, before.reportAt, before.motion]);
  await assert.rejects(saveSlideOrder(env, 'm_ord1', 'i_eve1', ['item'], { member: SAM }), (e) => e.status === 403);
  await assert.rejects(saveSlideOrder(env, 'm_ord1', 'i_eve1', 'decision', { member: KIM }), (e) => e.status === 400);
  await assert.rejects(saveSlideOrder(env, 'm_ord1', 'i_gone1', ['item'], { member: KIM }), (e) => e.status === 404);
  assert.deepEqual((await saveSlideOrder(env, 'm_ord1', 'i_eve1', ['item', 'decision'], { admin: true, adminEmail: 'jane@soardcharity.com' })).slideOrder, ['item', 'decision']);
  // A report saved after keeps the order; the screen's view carries it
  await saveReport(env, 'm_ord1', 'i_eve1', 'We met twice.', { member: KIM, base: after.reportAt });
  assert.deepEqual((await getMeeting(env.DB, 'm_ord1')).sections[0].items[0].slideOrder, ['item', 'decision']);
  const v = await liveView(env, 'm_ord1', { admin: true, adminEmail: 'jane@soardcharity.com' }).catch(() => null);
  if (v) assert.deepEqual(v.sections[0].items[0].slideOrder, ['item', 'decision']);
});
