/**
 * Kid items: one order is one order, whichever of its emails is read, and the newest answer about it stands
 * (functions/api/_kid-match.js orderKeys, _kid-checkin.js, _kid-scan.js, kid-items-admin.js ?decide=1)
 * Run: node --test tests/kid-order-identity.test.mjs
 * Review of Nov 11 2026 (scan and "Whose is it?"): each test was a proof of a bug; it now says what should happen.
 * Made-up kids, stores, orders and labels only.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { checkinView, checkinData, orderReads } from '../functions/api/_kid-checkin.js';
import { findBox, likelyBoxes, storeOfTracking } from '../functions/api/_kid-scan.js';
import { decide, WHOLE_ORDER, alsoKey, receive, undoMany } from '../functions/api/_kid-record.js';
import { orderKeys, groupKey } from '../functions/api/_kid-match.js';
import { onRequestPost } from '../functions/api/kid-items-admin.js';

let env;
const part = (name, extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source: 'buy', key: `name:${name.toLowerCase()}`, ...extra });
async function line(jobId, jobName, itemId, lineName, words, parts, { group = 'G', cents = 100 } = {}) {
  await env.DB.prepare('INSERT OR REPLACE INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, group, lineName, cents, `h${itemId}`, JSON.stringify(parts), 'ai', '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();
async function mail(id, store, at, read, mailbox = 'pat@soardcharity.com') {
  await env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, state, read) VALUES (?, ?, ?, ?, ?, 'read', ?)").bind(mailbox, id, at, store, read.kind, JSON.stringify(read)).run();
}
const blank = { trackingNumbers: [], orderNumbers: [], po: '', store: '', items: [], references: [], models: [], names: [] };
const view = () => checkinView(env, { photos: false });
const later = (ms) => new Date(Date.now() + ms).toISOString();
const post = (action, body) => onRequestPost({ env, request: new Request(`https://site.example/api/kid-items-admin?${action}=1`, { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} });

beforeEach(async () => {
  env = { DB: await createD1() };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-shower', 'Shower System', 'Raincan Shower Head 52214-CZ', [part('Raincan Shower Head', { model: '52214-CZ' })]);
  await line('j-ava', 'Ava Example (2026)', 'a-lamp', 'Lighting', 'Cloud Pendant Light, Warm', [part('Cloud Pendant Light')]);
});

// ─── One order, whichever email ───

test('an order email and its shipping email with no order number are one order: one card, one answer, one thing on the kid, and the box finds her', async () => {
  const elfa = [{ name: 'Elfa Mesh Hanging Drawer Graphite', quantity: 2, cents: 3000 }];
  await mail('o1', 'Shop', daysAgo(5), { kind: 'order', orderNumber: '899120', items: elfa, tracking: [] });
  await mail('s1', 'Shop', daysAgo(3), { kind: 'shipped', orderNumber: null, items: elfa, tracking: [{ carrier: 'UPS', number: '1Z12D1R20300649275' }] });
  let v = await view();
  assert.deepEqual(v.shipments.filter((s) => s.unplaced).map((s) => [s.key, s.stage]), [['Shop|899120', 'shipped']], 'one card, as far along as its newest email says');
  await decide(env.DB, { orderKey: 'Shop|899120', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } });
  v = await view();
  const reads = await orderReads(env.DB);
  const found = findBox(v, reads, { ...blank, trackingNumbers: ['1Z12D1R20300649275'] });
  assert.deepEqual([found.short, found.items.length, found.exact], ['Ava E.', 1, true], 'the box she placed is hers');
  assert.equal(v.kids.find((k) => k.jobId === 'j-ava').items.filter((i) => /Elfa/.test(i.name)).length, 1);
});

test('an order number with or without its "#" is one order', () => {
  const r = (id, n) => ({ mailbox: 'm', id, store: 'Faire', at: '2026-11-01', read: { kind: 'order', orderNumber: n, items: [] } });
  const keyOf = orderKeys([r('a', '#8MK7RPPS5F'), r('b', '8MK7RPPS5F')]);
  assert.equal(keyOf(r('a', '#8MK7RPPS5F')), keyOf(r('b', '8MK7RPPS5F')));
  assert.equal(keyOf(r('a', '#8MK7RPPS5F')), 'Faire|#8MK7RPPS5F', 'the key the order always had');
});

test('a carrier’s email read first (no order number) is the store’s order, so the box finds the kid', async () => {
  await mail('f1', 'FedEx', daysAgo(4), { kind: 'shipped', orderNumber: null, items: [], tracking: [{ carrier: 'FedEx', number: '879483612551' }] });
  await mail('s1', 'Faire', daysAgo(4), { kind: 'shipped', orderNumber: null, items: [{ name: 'Delta Raincan Shower Head 52214-CZ' }], tracking: [{ carrier: 'FedEx', number: '879483612551' }] });
  const v = await view();
  const reads = await orderReads(env.DB);
  assert.equal(findBox(v, reads, { ...blank, trackingNumbers: ['879483612551'], models: ['52214-CZ'] })?.short, 'Rowan S.');
});

test('a carrier’s email with a reference as its order number never takes the store’s order', async () => {
  await mail('s1', 'Faire', daysAgo(4), { kind: 'shipped', orderNumber: null, items: [{ name: 'Delta Raincan Shower Head 52214-CZ' }], tracking: [{ carrier: 'FedEx', number: '878861163000' }] });
  await mail('f1', 'FedEx', daysAgo(4), { kind: 'shipped', orderNumber: 'PN2PA7KHCM', items: [], tracking: [{ carrier: 'FedEx', number: '878861163000' }] });
  const v = await view();
  const reads = await orderReads(env.DB);
  assert.equal(findBox(v, reads, { ...blank, trackingNumbers: ['878861163000'] })?.short, 'Rowan S.');
});

test('two orders in one box (one tracking number) stay two orders, and the box finds the kid’s', async () => {
  await mail('a1', 'Amazon', daysAgo(3), { kind: 'shipped', orderNumber: '111-0000000-0000001', jobPo: 'ROWAN', items: [{ name: 'Raincan Shower Head 52214-CZ' }], tracking: [{ carrier: 'UPS', number: '1ZDDD4440300000004' }] });
  await mail('a2', 'Amazon', daysAgo(3), { kind: 'shipped', orderNumber: '111-0000000-0000002', items: [{ name: 'Printer Paper' }], tracking: [{ carrier: 'UPS', number: '1ZDDD4440300000004' }] });
  const v = await view();
  const reads = await orderReads(env.DB);
  const keyOf = orderKeys(reads);
  assert.notEqual(keyOf(reads.find((r) => r.id === 'a1')), keyOf(reads.find((r) => r.id === 'a2')));
  assert.equal(findBox(v, reads, { ...blank, trackingNumbers: ['1ZDDD4440300000004'] })?.short, 'Rowan S.');
});

test('an order whose answer was kept by its shipping email’s key keeps that key when the two are joined (its budget line isn’t made again)', async () => {
  const elfa = [{ name: 'Elfa Mesh Hanging Drawer Graphite', quantity: 1 }];
  await mail('s1', 'Shop', daysAgo(3), { kind: 'shipped', orderNumber: null, items: elfa, tracking: [{ carrier: 'UPS', number: '1Z12D1R20300649275' }] });
  // Answered while only the shipping email was read
  await decide(env.DB, { orderKey: 'Shop|email:s1', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } });
  let v = await view();
  const before = v.kids.find((k) => k.jobId === 'j-ava').items.find((i) => /Elfa/.test(i.name));
  assert.equal(before.order.key, 'Shop|email:s1');
  // The order email is read later
  await mail('o1', 'Shop', daysAgo(5), { kind: 'order', orderNumber: '899120', items: elfa, tracking: [] });
  v = await view();
  const now = v.kids.find((k) => k.jobId === 'j-ava').items.filter((i) => /Elfa/.test(i.name));
  assert.deepEqual(now.map((i) => [i.order.key, i.also.key]), [['Shop|email:s1', before.also.key]], 'the same thing, by the same key: the answer stands and its budget line is the same one');
  assert.equal(now[0].order.orderNumber, '899120', 'shown by the order’s number, from its order email');
});

test('the scan matches the way the view was made (checkinData), and a stale page gets the list with the answer', async () => {
  await line('j-ava', 'Ava Example (2026)', 'a-decor', 'Decor', 'Books, wall art, shelves', [part('Books, wall art, shelves')], { group: 'Bedroom Selection & Allowance' });
  await line('j-rowan', 'Rowan Sample (2026)', 'r-decor', 'Decor', 'Books, wall art, shelves', [part('Books, wall art, shelves')], { group: 'Bedroom Selection & Allowance' });
  await mail('w1', 'West Elm', daysAgo(1), { kind: 'delivered', orderNumber: 'WE-1001', items: [{ name: 'Woven Wall Hanging' }], tracking: [{ carrier: 'UPS', number: '1ZEEE5550300000005' }] });
  const { view: v, reads, keyOf } = await checkinData(env, { photos: false });
  const f = findBox(v, reads, { ...blank, trackingNumbers: ['1ZEEE5550300000005'] }, { keyOf });
  assert.deepEqual([f.unplaced, f.known.store, f.known.stage, f.known.things.map((t) => t.name)], ['West Elm|WE-1001', 'West Elm', 'delivered', ['Woven Wall Hanging']]);
});

// ─── The newest answer stands ───

test('things answered “Not a kid’s” one by one, then “Whose is it?” says Ava’s: they’re Ava’s, and the box finds her', async () => {
  await mail('o1', 'Shop', daysAgo(3), { kind: 'shipped', orderNumber: 'Q77001', jobPo: 'LIZZY', items: [{ name: 'Linen Pillow Cover' }, { name: 'Woven Basket' }], tracking: [{ carrier: 'UPS', number: '1ZAAA1110300000001' }] });
  for (const n of ['Linen Pillow Cover', 'Woven Basket']) await decide(env.DB, { orderKey: 'Shop|Q77001', itemName: n, decision: { type: 'notKid' } }, { now: daysAgo(1) });
  let v = await view();
  const reads = await orderReads(env.DB);
  const label = { ...blank, trackingNumbers: ['1ZAAA1110300000001'] };
  const f = findBox(v, reads, label);
  assert.equal(f.known.things.length, 2);
  // The sheet shows its things and sends them with the answer
  await decide(env.DB, { orderKey: f.known.key, itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' }, things: f.known.things.map((t) => t.name) });
  v = await view();
  assert.equal(v.kids.find((k) => k.jobId === 'j-ava').items.filter((i) => i.order?.key === 'Shop|Q77001').length, 2);
  assert.equal(findBox(v, reads, label)?.short, 'Ava E.');
});

test('a thing moved to another kid after the whole order was said to be Ava’s stays moved (the newer answer)', async () => {
  await line('j-ava', 'Ava Example (2026)', 'a-rug', 'Rug', 'Round Rainbow Rug', [part('Round Rainbow Rug')]);
  await mail('o1', 'Shop', daysAgo(3), { kind: 'order', orderNumber: 'Z9001', items: [{ name: 'Linen Pillow Cover' }, { name: 'Woven Basket' }] });
  await decide(env.DB, { orderKey: 'Shop|Z9001', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } }, { now: daysAgo(2) });
  await decide(env.DB, { orderKey: 'Shop|Z9001', itemName: 'Woven Basket', decision: { type: 'also', kid: 'j-rowan' } }, { now: daysAgo(1) });
  const v = await view();
  assert.deepEqual(v.kids.find((k) => k.jobId === 'j-ava').items.filter((i) => i.order?.key === 'Shop|Z9001').map((i) => i.name), ['Linen Pillow Cover']);
  assert.deepEqual(v.kids.find((k) => k.jobId === 'j-rowan').items.filter((i) => i.order?.key === 'Shop|Z9001').map((i) => i.name), ['Woven Basket']);
});

test('Wrong kid: the whole order said to be Ava’s, then Rowan’s: all of it is Rowan’s, none is Ava’s, and Ava’s lines are written again', async () => {
  await mail('o1', 'The Container Store', daysAgo(2), { kind: 'delivered', orderNumber: '899120272624', items: [{ name: 'Elfa Mesh Drawer', quantity: 2 }] });
  const first = await (await post('decide', { orderKey: 'The Container Store|899120272624', items: [{ itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } }] })).json();
  assert.deepEqual(first.placed, { kid: 'j-ava', things: 1, look: false }, 'the page says what really happened');
  const d = await decide(env.DB, { orderKey: 'The Container Store|899120272624', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-rowan' } });
  assert.equal(d.was, 'j-ava', 'whoever had it before is written again (their line comes off)');
  const v = await view();
  assert.equal(v.kids.find((k) => k.jobId === 'j-ava').items.some((i) => /Elfa/.test(i.name)), false);
  assert.deepEqual(v.kids.find((k) => k.jobId === 'j-rowan').items.filter((i) => /Elfa/.test(i.name)).map((i) => [i.qty, i.line]), [[2, 'Also bought']]);
});

test('Wrong kid after it was checked in: its check-in is undone, it moves, and nothing is left behind on the first kid’s list', async () => {
  await mail('o1', 'The Container Store', daysAgo(2), { kind: 'delivered', orderNumber: '899120272624', items: [{ name: 'Elfa Mesh Drawer', quantity: 2 }] });
  const key = 'The Container Store|899120272624';
  await decide(env.DB, { orderKey: key, itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } });
  let v = await view();
  const it = v.kids.find((k) => k.jobId === 'j-ava').items.find((i) => /Elfa/.test(i.name));
  await receive(env.DB, { tap: 'tap-elfa-1', jobId: 'j-ava', itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units: 2, boxes: 1 });
  // The page's Wrong kid: the check-in comes back first, then the whole order is Rowan's
  await undoMany(env.DB, ['tap-elfa-1']);
  await decide(env.DB, { orderKey: key, itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-rowan' } });
  v = await view();
  assert.deepEqual((v.kids.find((k) => k.jobId === 'j-ava')?.items || []).filter((i) => /Elfa/.test(i.name) || i.gone).map((i) => i.name), [], 'no leftover on Ava’s list');
  assert.deepEqual(v.kids.find((k) => k.jobId === 'j-rowan').items.filter((i) => /Elfa/.test(i.name)).map((i) => [i.status, i.got]), [['ordered', 0]], 'Rowan’s, to check in again');
});

test('a scanned Needs-a-look order (its things fit two kids) opens Needs a look, never one “whose” for all of it', async () => {
  await line('j-ava', 'Ava Example (2026)', 'a-rug', 'Rug', 'Round Rainbow Rug', [part('Round Rainbow Rug')]);
  await mail('o1', 'Shop', daysAgo(3), { kind: 'shipped', orderNumber: 'MX-10001', items: [{ name: 'Round Rainbow Rug' }, { name: 'Raincan Shower Head' }], tracking: [{ carrier: 'UPS', number: '1ZBBB2220300000002' }] });
  const v = await view();
  assert.equal(v.needsLook.find((x) => x.key === 'Shop|MX-10001')?.why, 'its items fit Ava E. and Rowan S.');
  const reads = await orderReads(env.DB);
  assert.deepEqual(findBox(v, reads, { ...blank, trackingNumbers: ['1ZBBB2220300000002'] }), { look: 'Shop|MX-10001', how: 'Tracking …000002', exact: true });
});

// ─── Cancelled ───

test('a cancelled order nobody placed doesn’t ask whose it is (a cancel email naming no things, or the number without its #)', async () => {
  await mail('o1', 'Faire', daysAgo(6), { kind: 'order', orderNumber: '#8MK7RPPS5F', items: [{ name: 'Small Santa with Glasses Mug' }, { name: 'Holiday Icon Goblet' }] });
  await mail('c1', 'Faire', daysAgo(2), { kind: 'cancelled', orderNumber: '8MK7RPPS5F', items: [] });
  await mail('o2', 'Shop', daysAgo(6), { kind: 'order', orderNumber: 'W5550001', items: [{ name: 'Velvet Throw Blanket' }] });
  await mail('c2', 'Shop', daysAgo(2), { kind: 'cancelled', orderNumber: 'W5550001', items: [] });
  const v = await view();
  assert.deepEqual(v.shipments.filter((s) => s.unplaced).map((s) => s.key), []);
});

test('a cancelled order whose box came anyway: the scan asks whose, and the answer places it', async () => {
  await mail('o1', 'Shop', daysAgo(5), { kind: 'shipped', orderNumber: 'CX-20001', items: [{ name: 'Velvet Throw Blanket' }], tracking: [{ carrier: 'UPS', number: '1ZCCC3330300000003' }] });
  await mail('c1', 'Shop', daysAgo(4), { kind: 'cancelled', orderNumber: 'CX-20001', items: [{ name: 'Velvet Throw Blanket' }] });
  let v = await view();
  const reads = await orderReads(env.DB);
  const f = findBox(v, reads, { ...blank, trackingNumbers: ['1ZCCC3330300000003'] });
  assert.equal(f.known?.things.length, 1);
  await decide(env.DB, { orderKey: f.known.key, itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } });
  v = await view();
  assert.equal(v.kids.find((k) => k.jobId === 'j-ava').items.some((i) => i.order?.key === 'Shop|CX-20001'), true);
});

test('a cancel email after a person said whose: the cancel stands', async () => {
  await mail('o1', 'Shop', daysAgo(5), { kind: 'order', orderNumber: 'CX-30001', items: [{ name: 'Velvet Throw Blanket' }] });
  await decide(env.DB, { orderKey: 'Shop|CX-30001', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } }, { now: daysAgo(4) });
  await mail('c1', 'Shop', daysAgo(1), { kind: 'cancelled', orderNumber: 'CX-30001', items: [{ name: 'Velvet Throw Blanket' }] });
  const v = await view();
  assert.equal(v.kids.find((k) => k.jobId === 'j-ava').items.some((i) => i.order?.key === 'Shop|CX-30001'), false);
});

// ─── Who and where ───

test('one no-number email to the house doesn’t hide that store’s other no-number orders', async () => {
  await mail('h1', 'Faire', daysAgo(5), { kind: 'shipped', orderNumber: null, shipTo: 'elsewhere', items: [{ name: 'Tea Towel Set' }], tracking: [{ carrier: 'FedEx', number: '533392671037' }] });
  await mail('h2', 'Faire', daysAgo(2), { kind: 'delivered', orderNumber: null, shipTo: 'office', items: [{ name: 'Wooden Toy Train' }], tracking: [{ carrier: 'FedEx', number: '533392679999' }] });
  const v = await view();
  assert.deepEqual(v.shipments.filter((s) => s.unplaced).map((s) => [s.key, s.stage]), [['Faire|email:h2', 'delivered']]);
});

test('a kid whose budget has only allowances yet can be picked: every open kid is in everyKid, and the answer puts it on their list', async () => {
  const ALLOW = { group: 'Bedroom Makeover Selection & Allowance', cents: 50000 };
  await line('j-rowan', 'Rowan Sample (2026)', 'r-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')], ALLOW);
  await line('j-mia', 'Mia Newkid (2026)', 'm-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')], ALLOW);
  await mail('o1', 'The Container Store', daysAgo(2), { kind: 'delivered', orderNumber: '899120272624', items: [{ name: 'Elfa Mesh Drawer' }] });
  const v = await view();
  assert.equal(v.kids.some((k) => k.jobId === 'j-mia'), false, 'nothing on her list yet');
  const mia = v.everyKid.find((k) => k.jobId === 'j-mia');
  assert.deepEqual([mia?.short, mia?.allowances.map((a) => a.line)], ['Mia N.', ['Decor']]);
  assert.deepEqual(v.everyKid.map((k) => k.short), ['Ava E.', 'Mia N.', 'Rowan S.']);
  await decide(env.DB, { orderKey: 'The Container Store|899120272624', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-mia' } });
  const v2 = await view();
  // On her list, waiting to be sorted onto her allowance (./_kid-allow.js) before its budget line is made
  assert.deepEqual(v2.kids.find((k) => k.jobId === 'j-mia')?.items.filter((i) => /Elfa/.test(i.name)).map((i) => i.also?.pending), [true]);
});

test('the store the label prints and the one its UPS account says both count (a warehouse ships for the store)', async () => {
  await mail('p1', 'Plank Hardware', daysAgo(3), { kind: 'shipped', orderNumber: 'US35949', items: [{ name: 'Brass Cabinet Pull 5in' }], tracking: [{ carrier: 'UPS', number: '1ZK180F30300000001' }] });
  // The carrier's own email with the same account says only "UPS"
  await mail('u1', 'UPS', daysAgo(3), { kind: 'shipped', orderNumber: null, items: [], tracking: [{ carrier: 'UPS', number: '1ZK180F30300000001' }] });
  const v = await view();
  const reads = await orderReads(env.DB);
  const label = { ...blank, trackingNumbers: ['1ZK180F30314821221'], store: 'TRADEWINDS LOGISTICS', references: ['49156'], names: ['CLAREECE CUNNINGHAM'] };
  assert.equal(storeOfTracking(label.trackingNumbers, reads), 'Plank Hardware');
  assert.deepEqual(likelyBoxes(v, reads, label).map((x) => x.why), ['From Plank Hardware']);
});

test('who ordered it counts orders, not things, and “ATTN:” before a name is read past', async () => {
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ accounts: [{ email: 'linzi@soardcharity.com', name: 'Linzi Berkowitz' }, { email: 'clareece@soardcharity.com', name: 'Clareece Cunningham' }] })).run();
  await mail('l1', 'Amazon', daysAgo(10), { kind: 'order', orderNumber: '111-0000000-0000001', jobPo: 'AVA', items: ['Shower Curtain Liner', 'Bath Towel', 'Soap Dish', 'Hand Towel'].map((name) => ({ name })) }, 'linzi@soardcharity.com');
  for (const n of [2, 3, 4]) await mail(`c${n}`, 'Target', daysAgo(10), { kind: 'order', orderNumber: `TG-90000${n}`, items: [{ name: `Storage Cube ${n}` }] }, 'clareece@soardcharity.com');
  const v = await view();
  const reads = await orderReads(env.DB);
  const by = (names) => likelyBoxes(v, reads, { ...blank, trackingNumbers: ['TBA000000000999'], store: 'UPS', names });
  assert.equal(by(['Linzi Berkowitz']).some((x) => /Linzi ordered it/.test(x.why)), true, '1 of 4 orders is hers (4 of 7 things)');
  assert.equal(by(['ATTN: LINZI BERKOWITZ']).some((x) => /Linzi ordered it/.test(x.why)), true);
  assert.equal(by(['ATTN: CLAREECE CUNNINGHAM']).some((x) => /Clareece ordered it/.test(x.why)), false, 'hers are most orders: her name says nothing');
});

test('groupKey is the key a lone email always had (answers saved by it still find it)', () => {
  assert.equal(groupKey({ id: 'x1', store: 'Shop', read: { orderNumber: null, items: [] } }), 'Shop|email:x1');
  assert.ok(alsoKey('Shop|1', 'Lamp', 'j-ava').startsWith('soard-also-'));
  assert.ok(later(1) > daysAgo(0));
});

// ─── Review of f5ee1a0b (Nov 11 2026): what was answered or made before stays as it was ───

const thingsOf = (v, jobId) => (v.kids.find((k) => k.jobId === jobId)?.items || []).filter((i) => i.order).map((i) => i.name).sort();
/** A budget line the JobTread writer made for an Also bought thing (as the live record keeps it) */
const madeAlso = (key, jobId, name) => env.DB.prepare("INSERT INTO kid_also (key, job_id, name, at, cost_item_id) VALUES (?, ?, ?, '2026-11-01', ?)").bind(key, jobId, name, `ci-${key}`).run();

test('a freight carrier’s email answered on its own before (its own things’ names): joined to the store’s order, the answer and its budget line stay, shown under the store', async () => {
  await mail('o1', 'Plank Hardware', daysAgo(35), { kind: 'order', orderNumber: '55120', items: [{ name: 'Oak Wall Shelf 36in Natural', quantity: 1, cents: 8900 }], tracking: [] });
  await mail('s1', 'Plank Hardware', daysAgo(33), { kind: 'shipped', orderNumber: '55120', items: [{ name: 'Oak Wall Shelf 36in Natural' }], tracking: [{ carrier: 'LTL', number: 'PRO7766554433' }] });
  await mail('c1', 'LTL Select', daysAgo(33), { kind: 'shipped', orderNumber: null, jobPo: '55120', items: [{ name: 'SHELF OAK KD/36 NAT' }], tracking: [{ carrier: 'LTL', number: 'PRO7766554433' }] });
  const old = 'LTL Select|po:55120|SHELF OAK KD/36 NAT';
  await decide(env.DB, { orderKey: old, itemName: 'SHELF OAK KD/36 NAT', decision: { type: 'also', kid: 'j-ava' } });
  await madeAlso(alsoKey(old, 'SHELF OAK KD/36 NAT', 'j-ava'), 'j-ava', 'SHELF OAK KD/36 NAT');
  const v = await view();
  const it = v.kids.find((k) => k.jobId === 'j-ava').items.find((i) => i.name === 'SHELF OAK KD/36 NAT');
  assert.deepEqual([it?.also.key, it?.also.costItemId, it?.order.store, it?.order.orderNumber], [alsoKey(old, 'SHELF OAK KD/36 NAT', 'j-ava'), `ci-${alsoKey(old, 'SHELF OAK KD/36 NAT', 'j-ava')}`, 'Plank Hardware', '55120']);
  assert.deepEqual(v.needsLook, [], 'nothing asked again');
});

test('two cards for one order answered differently before (the shipped one Ava’s, the order email’s “Not a kid’s”): they stay apart as they were, Ava keeps hers', async () => {
  const bins = [{ name: 'Canvas Toy Bin Set of 3', quantity: 1, cents: 3600 }];
  await mail('o1', 'Shop Co', daysAgo(5), { kind: 'order', orderNumber: '899120', items: bins, tracking: [] });
  await mail('s1', 'Shop Co', daysAgo(2), { kind: 'shipped', orderNumber: null, items: bins, tracking: [{ carrier: 'UPS', number: '1Z12D1R20300649275' }] });
  await decide(env.DB, { orderKey: 'Shop Co|email:s1', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } });
  await decide(env.DB, { orderKey: 'Shop Co|899120', itemName: WHOLE_ORDER, decision: { type: 'notKid' } });
  await madeAlso(alsoKey('Shop Co|email:s1', 'Canvas Toy Bin Set of 3', 'j-ava'), 'j-ava', 'Canvas Toy Bin Set of 3');
  const v = await view();
  const ava = v.kids.find((k) => k.jobId === 'j-ava').items.filter((i) => /Toy Bin/.test(i.name));
  assert.deepEqual(ava.map((i) => i.also.key), [alsoKey('Shop Co|email:s1', 'Canvas Toy Bin Set of 3', 'j-ava')]);
  assert.equal(v.shipments.filter((s) => s.unplaced).length, 0);
});

test('Wrong kid moves whose the order is, not what was said of a thing: the office’s tape and the cancelled pillow stay off Rowan’s list, nothing asked again', async () => {
  await mail('o1', 'Pine Supply', daysAgo(4), { kind: 'order', orderNumber: 'PS-40021', jobPo: 'AVA', items: [{ name: 'Cloud Pendant Light', cents: 4500 }, { name: 'Packing Tape 6-Roll', cents: 1800 }, { name: 'Linen Throw Pillow', cents: 2500 }], tracking: [] });
  await mail('x1', 'Pine Supply', daysAgo(3), { kind: 'cancelled', orderNumber: 'PS-40021', items: [{ name: 'Linen Throw Pillow' }], tracking: [] });
  const key = 'Pine Supply|PS-40021';
  let v = await view();
  const lamp = v.kids.find((k) => k.jobId === 'j-ava').items.find((i) => i.itemId === 'a-lamp');
  await decide(env.DB, { orderKey: key, itemName: 'Packing Tape 6-Roll', decision: { type: 'notKid' } }, { now: daysAgo(2) });
  await decide(env.DB, { orderKey: key, itemName: 'Linen Throw Pillow', decision: { type: 'cancelled' } }, { now: daysAgo(2) });
  await decide(env.DB, { orderKey: key, itemName: 'Cloud Pendant Light', decision: { type: 'line', kid: 'j-ava', itemId: lamp.itemId, partKey: lamp.partKey } }, { now: daysAgo(2) });
  v = await view();
  assert.deepEqual([thingsOf(v, 'j-ava'), v.needsLook.length], [['Cloud Pendant Light'], 0]);
  // The shipment sheet's Wrong kid: its things (what's on Ava's list) go with the answer
  const r = await (await post('decide', { orderKey: key, from: 'j-ava', things: ['Cloud Pendant Light'], items: [{ itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-rowan' } }] })).json();
  assert.equal(r.success, true);
  v = await view();
  assert.deepEqual([thingsOf(v, 'j-rowan'), thingsOf(v, 'j-ava'), v.needsLook.length], [['Cloud Pendant Light'], [], 0]);
});

test('the same thing on two orders: a shipping email with no number joins neither, makes no card, and its box offers both orders to pick', async () => {
  const g = [{ name: 'Felt Star Garland', quantity: 1, cents: 2200 }];
  await mail('o1', 'Juniper Gifts', daysAgo(9), { kind: 'order', orderNumber: '#JG10001', jobPo: 'AVA', items: g, tracking: [] });
  await mail('o2', 'Juniper Gifts', daysAgo(6), { kind: 'order', orderNumber: '#JG10002', jobPo: 'ROWAN', items: g, tracking: [] });
  await mail('s1', 'Juniper Gifts', daysAgo(4), { kind: 'shipped', orderNumber: null, items: g, tracking: [{ carrier: 'USPS', number: '9400111899223344556677' }] });
  const { view: v, reads, keyOf } = await checkinData(env, { photos: false });
  const sh = (who) => v.shipments.find((s) => s.items.some((i) => i.kid === who));
  assert.deepEqual([sh('j-ava').stage, sh('j-rowan').stage, v.shipments.filter((s) => s.unplaced).length], ['ordered', 'ordered', 0]);
  const found = findBox(v, reads, { ...blank, trackingNumbers: ['9400111899223344556677'] }, { keyOf });
  assert.deepEqual([found.which?.sort(), found.how], [['Juniper Gifts|#JG10001', 'Juniper Gifts|#JG10002'], 'Tracking …556677']);
});

test('an order email with no number (a PO-only order) is an order of its own, never taken into another that names the same thing', async () => {
  await mail('o1', 'Plank Hardware', daysAgo(8), { kind: 'order', orderNumber: '77001', jobPo: 'ROWAN', items: [{ name: 'Oak Wall Shelf 36in', cents: 8900 }], tracking: [] });
  await mail('o2', 'Plank Hardware', daysAgo(3), { kind: 'order', orderNumber: null, jobPo: 'AVA', items: [{ name: 'Oak Wall Shelf 36in', cents: 8900 }, { name: 'Brass Hook Set', cents: 1500 }], tracking: [] });
  const v = await view();
  assert.deepEqual([thingsOf(v, 'j-rowan'), thingsOf(v, 'j-ava')], [['Oak Wall Shelf 36in'], ['Brass Hook Set', 'Oak Wall Shelf 36in']]);
});

test('part of an order nobody placed refunded: it still asks whose it is, saying so, and the refunded thing is marked', async () => {
  const things = [{ name: 'Velvet Storage Bin', cents: 2400 }, { name: 'Rope Basket Large', cents: 3100 }, { name: 'Mini Desk Fan', cents: 1900 }];
  await mail('o1', 'Hollow Home', daysAgo(6), { kind: 'order', orderNumber: 'HH-88231', items: things, tracking: [] });
  await mail('d1', 'Hollow Home', daysAgo(2), { kind: 'delivered', orderNumber: 'HH-88231', items: [], tracking: [] });
  await mail('r1', 'Hollow Home', daysAgo(1), { kind: 'refund', orderNumber: 'HH-88231', items: [{ name: 'Mini Desk Fan' }], tracking: [] });
  const v = await view();
  const card = v.shipments.find((s) => s.unplaced);
  assert.deepEqual([card?.key, card?.undo, card?.things.filter((t) => t.undone).map((t) => t.name)], ['Hollow Home|HH-88231', 'refunded', ['Mini Desk Fan']]);
  // Ava's: the refunded fan is asked about, the rest is hers
  await decide(env.DB, { orderKey: card.key, itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' }, things: card.things.map((t) => t.name) });
  const v2 = await view();
  assert.deepEqual(thingsOf(v2, 'j-ava'), ['Mini Desk Fan', 'Rope Basket Large', 'Velvet Storage Bin']);
  assert.deepEqual(v2.needsLook.map((o) => o.items.map((i) => i.name)), [['Mini Desk Fan']]);
});

test('cancelled, then a person said Ava’s (the box came anyway), then the refund for that same cancel: it stays Ava’s', async () => {
  const things = [{ name: 'Rattan Wall Mirror', cents: 6400 }];
  await mail('o1', 'Hollow Home', daysAgo(6), { kind: 'order', orderNumber: 'HH-90001', items: things, tracking: [] });
  await mail('x1', 'Hollow Home', daysAgo(3), { kind: 'cancelled', orderNumber: 'HH-90001', items: things, tracking: [] });
  await decide(env.DB, { orderKey: 'Hollow Home|HH-90001', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } }, { now: daysAgo(2) });
  await mail('r1', 'Hollow Home', daysAgo(1), { kind: 'refund', orderNumber: 'HH-90001', items: things, tracking: [] });
  assert.deepEqual(thingsOf(await view(), 'j-ava'), ['Rattan Wall Mirror']);
});

test('a cancel naming nothing is all of the order, unless it shipped after it (part cancelled)', async () => {
  await mail('o1', 'Faire', daysAgo(10), { kind: 'order', orderNumber: '#FA10001', items: [{ name: 'Ceramic Mug' }, { name: 'Tea Towel' }] });
  await mail('x1', 'Faire', daysAgo(8), { kind: 'cancelled', orderNumber: 'FA10001', items: [] });
  await mail('s1', 'Faire', daysAgo(5), { kind: 'shipped', orderNumber: '#FA10001', items: [], tracking: [{ carrier: 'UPS', number: '1ZFFF6660300000006' }] });
  const v = await view();
  const card = v.shipments.find((s) => s.unplaced);
  assert.deepEqual([card?.key, card?.undo], ['Faire|#FA10001', 'cancelled'], 'it shipped after the cancel: part of it, and asked');
});

test('one email to the house naming some of an order’s things: the rest still asks whose it is', async () => {
  await mail('o1', 'Faire', daysAgo(10), { kind: 'order', orderNumber: '#FB20001', items: [{ name: 'Ceramic Mug' }, { name: 'Tea Towel' }, { name: 'Wool Throw' }] });
  await mail('s1', 'Faire', daysAgo(5), { kind: 'shipped', orderNumber: null, shipTo: 'elsewhere', items: [{ name: 'Ceramic Mug' }, { name: 'Tea Towel' }], tracking: [{ carrier: 'FedEx', number: '533392600001' }] });
  const v = await view();
  const card = v.shipments.find((s) => s.unplaced);
  assert.deepEqual([card?.key, card?.things.map((t) => t.name)], ['Faire|#FB20001', ['Wool Throw']]);
});
