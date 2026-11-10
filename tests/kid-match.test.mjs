/**
 * Kid items: which kid and which line an order belongs to (functions/api/_kid-match.js)
 * Run: node --test tests/kid-match.test.mjs
 * Made-up kids, staff and products only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kidFromPo, namesOf, tokensOf, fit, templateLines, orderGroups, matchOrder } from '../functions/api/_kid-match.js';

const jobs = [
  { id: 'j-rowan', name: 'Rowan Sample (2026)' },
  { id: 'j-ava', name: 'Ava Example (2026)' },
  { id: 'j-pat', name: 'Pat Kidd (2026)' },
  { id: 'j-school', name: 'The Sample School (2026)' },
];
const staff = new Set(['pat', 'lee', 'sam', 'fox']);
const lines = [
  { jobId: 'j-rowan', itemId: 'r-wall', lineName: 'Wall Treatment', words: 'Good Fun Co Perfect Stripe, Beige https://x.example/stripe', wordsKey: 'good fun co perfect stripe beige', parts: [{ name: 'Wall Treatment', brand: '', model: '', link: 'https://x.example/stripe' }] },
  { jobId: 'j-rowan', itemId: 'r-shower', lineName: 'Shower System', words: 'Raincan Shower Head Model#: 52214-CZ\nSlide Bar Hand Shower', wordsKey: 'raincan', parts: [{ name: 'Raincan Shower Head', model: '52214-CZ' }, { name: 'Slide Bar Hand Shower', model: '' }] },
  { jobId: 'j-ava', itemId: 'a-light', lineName: 'Lighting', words: 'Louis Parisian Globe 3-Light Modern Contemporary LED', wordsKey: 'louis', parts: [{ name: 'Louis Parisian Globe 3-Light', model: '' }] },
  { jobId: 'j-ava', itemId: 'a-decor', lineName: 'Decor', words: 'Books, wall art, shelves, decorative objects', wordsKey: 'books wall art shelves decorative objects', parts: [{ name: 'Books, wall art, shelves, decorative objects', model: '' }] },
  { jobId: 'j-rowan', itemId: 'r-decor', lineName: 'Decor', words: 'Books, wall art, shelves, decorative objects', wordsKey: 'books wall art shelves decorative objects', parts: [{ name: 'Books, wall art, shelves, decorative objects', model: '' }] },
  { jobId: 'j-pat', itemId: 'p-shower', lineName: 'Shower System', words: 'Raincan Shower Head 52214-CZ', wordsKey: 'raincan2', parts: [{ name: 'Raincan Shower Head', model: '52214-CZ' }] },
];
const order = (o) => ({ store: 'Shop', orderNumber: '1', po: null, at: '2026-11-01', kinds: ['order'], items: [], ...o });

test('the PO box: a kid’s name, a not-a-kid word, or something a person looks at', () => {
  assert.deepEqual(kidFromPo('COLIN', [{ id: 'c', name: 'Colin Sample (2026)' }], staff), { kid: 'c' });
  assert.deepEqual(kidFromPo('#Rowan', jobs, staff), { kid: 'j-rowan' });
  assert.deepEqual(kidFromPo('ROWAN SAMPLE', jobs, staff), { kid: 'j-rowan' });
  assert.deepEqual(kidFromPo('Example', jobs, staff), { kid: 'j-ava' }, 'a last name');
  assert.deepEqual(kidFromPo('OFFICE', jobs, staff), { notKid: true });
  assert.deepEqual(kidFromPo('SUNNY & RANNEY', jobs, staff), { notKid: true });
  assert.deepEqual(kidFromPo('s&r', jobs, staff), { notKid: true });
  assert.deepEqual(kidFromPo('ROWEN', jobs, staff), { unclear: 'ROWEN' }, 'a misspelling is looked at, never guessed');
  assert.deepEqual(kidFromPo('Rowan bed', jobs, staff), { unclear: 'Rowan bed' });
  assert.deepEqual(kidFromPo('#Home', jobs, staff), { unclear: '#Home' });
  assert.deepEqual(kidFromPo('Pat', jobs, staff), { unclear: 'Pat' }, 'a staff member’s name never names a kid');
  assert.equal(kidFromPo('', jobs, staff), null);
  assert.equal(namesOf('The Sample School (2026)'), null);
});

test('fitting an item to a part: model number, then the designer’s words', () => {
  assert.equal(fit({ name: 'Delta Raincan Shower Head 52214-CZ-PR' }, lines[1].parts[0], lines[1].words).how, 'model');
  assert.ok(fit({ name: 'Sommers Louis Parisian Globe Modern Contemporary LED' }, lines[2].parts[0], lines[2].words).score >= 4);
  assert.equal(fit({ name: 'Brown Paper Gift Bags, 100 pcs' }, lines[2].parts[0], lines[2].words).score, 0);
  assert.deepEqual(tokensOf('Delta 7-Setting Slide Bar 36" Hand Shower'), ['delta', '7setting', 'slide', 'bar', '36in', 'hand', 'shower']);
});

test('template lines are never matched by themselves', () => {
  const t = templateLines(lines);
  assert.ok(t.has('j-ava|a-decor') && t.has('j-rowan|r-decor'));
  assert.ok(!t.has('j-rowan|r-wall'), 'a line with a link is a product');
  const m = matchOrder(order({ items: [{ name: 'Books for a reading nook, wall art shelves' }] }), { jobs, lines, staff });
  assert.equal(m.decision, 'unplaced');
});

test('placed by the PO, each item on its line', () => {
  const m = matchOrder(order({ po: '#ROWAN', items: [{ name: 'Raincan Shower Head 52214-CZ' }, { name: 'Good Fun Co Perfect Stripe, Beige' }] }), { jobs, lines, staff });
  assert.equal(m.decision, 'placed');
  assert.equal(m.kid, 'j-rowan');
  assert.deepEqual(m.items.map((i) => i.line), ['Shower System', 'Wall Treatment']);
});

test('the PO names one kid but an item is plainly another kid’s: a person looks', () => {
  const m = matchOrder(order({ po: 'ROWAN', items: [{ name: 'Sommers Louis Parisian Globe Modern Contemporary LED' }] }), { jobs, lines, staff });
  assert.equal(m.decision, 'look');
  assert.match(m.items[0].look, /looks like Ava Example/);
});

test('the PO names a kid but an item fits none of their lines: a person picks the line', () => {
  const m = matchOrder(order({ po: 'ROWAN', items: [{ name: 'Bean Bag Chair, Teal' }] }), { jobs, lines, staff });
  assert.equal(m.decision, 'look');
  assert.match(m.items[0].look, /which of Rowan Sample/);
});

test('no PO: the items name the kid when they fit only one; the same product on two kids is looked at', () => {
  const one = matchOrder(order({ items: [{ name: 'Sommers Louis Parisian Globe Modern Contemporary LED' }] }), { jobs, lines, staff });
  assert.deepEqual([one.decision, one.kid, one.how], ['placed', 'j-ava', 'its items']);
  const two = matchOrder(order({ items: [{ name: 'Raincan Shower Head 52214-CZ' }] }), { jobs, lines, staff });
  assert.equal(two.decision, 'look', 'Rowan and Pat both have that shower head');
});

test('not a kid’s, or nothing read', () => {
  assert.equal(matchOrder(order({ po: 'OFFICE', items: [{ name: 'Dehumidifier' }] }), { jobs, lines, staff }).decision, 'not-kid');
  assert.equal(matchOrder(order({ items: [] }), { jobs, lines, staff }).decision, 'skip');
  const unclear = matchOrder(order({ po: 'ROWEN', items: [{ name: 'Bean Bag Chair' }] }), { jobs, lines, staff });
  assert.equal(unclear.decision, 'look');
});

test('an order’s emails go together: items once, the PO from whichever email had it', () => {
  const g = orderGroups([
    { id: 'm1', mailbox: 'pat@soardcharity.com', store: 'Amazon', at: '2026-11-01', read: { kind: 'order', orderNumber: '111-1', jobPo: 'ROWAN', items: [{ name: 'Stool' }] } },
    { id: 'm2', mailbox: 'pat@soardcharity.com', store: 'Amazon', at: '2026-11-03', read: { kind: 'shipped', orderNumber: '111-1', jobPo: null, items: [{ name: 'Stool' }] } },
    { id: 'm3', mailbox: 'pat@soardcharity.com', store: 'Wayfair', at: '2026-11-02', read: { kind: 'shipped', orderNumber: null, items: [] } },
  ]);
  assert.equal(g.length, 2);
  const a = g.find((x) => x.store === 'Amazon');
  assert.deepEqual([a.po, a.items.length, a.kinds], ['ROWAN', 1, ['order', 'shipped']]);
});

test('a loose likeness to another kid’s line isn’t a reason to stop: it needs the model or five of the designer’s words', () => {
  const near = [...lines, { jobId: 'j-ava', itemId: 'a-fan', lineName: 'Bath Fan', words: 'Exhaust Fan with Heater, RGB LED light', wordsKey: 'fan', parts: [{ name: 'Exhaust Fan with Heater', model: '' }] }];
  const m = matchOrder(order({ po: 'ROWAN', items: [{ name: 'RGB Neon LED Rope Light 50 ft' }] }), { jobs, lines: near, staff });
  assert.match(m.items[0].look, /which of Rowan Sample/, 'asked for Rowan’s line, not flagged as Ava’s');
});
