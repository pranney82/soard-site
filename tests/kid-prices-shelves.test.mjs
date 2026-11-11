/**
 * Kid items: what a thing bought on top cost when no email says, every Selection & Allowance line an allowance, a
 * shipment's boxes moved to another shelf, and labels that never printed (Peter, Nov 11 2026)
 * Run: node --test tests/kid-prices-shelves.test.mjs
 * Made-up kids, stores and orders only.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { checkinView } from '../functions/api/_kid-checkin.js';
import { decide, receive, setPrice, WHOLE_ORDER, alsoKey } from '../functions/api/_kid-record.js';
import { onRequestPost } from '../functions/api/kid-items-admin.js';

let env;
const part = (name, extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source: 'buy', key: `name:${name.toLowerCase()}`, ...extra });
async function line(jobId, jobName, itemId, lineName, words, parts, { group = 'G', cents = 100 } = {}) {
  await env.DB.prepare('INSERT OR REPLACE INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, group, lineName, cents, `h${itemId}`, JSON.stringify(parts), 'ai', '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();
const mail = (id, store, at, read) => env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, state, read) VALUES ('pat@soardcharity.com', ?, ?, ?, ?, 'read', ?)").bind(id, at, store, read.kind, JSON.stringify(read)).run();
const view = () => checkinView(env, { photos: false });
const post = async (action, body) => (await onRequestPost({ env, request: new Request(`https://site.example/api/kid-items-admin?${action}=1`, { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} })).json();
const SA = { group: 'Bedroom Makeover Selection & Allowance', cents: 200000 };

beforeEach(async () => {
  env = { DB: await createD1() };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  // A designer's Selection & Allowance lines: what's picked for each kind of thing, in its words (no line alike on another makeover)
  await line('j-nico', 'Nico Example (2026)', 'n-decor', 'Decor/Accessories', 'Felt Engraved Wall Tile = $319', [part('Felt Engraved Wall Tile', { cents: 31900 })], SA);
  await line('j-nico', 'Nico Example (2026)', 'n-bed', 'Bedding', 'Stripe Duvet Cover = $129', [part('Stripe Duvet Cover', { cents: 12900 })], { ...SA, cents: 50000 });
  await line('j-nico', 'Nico Example (2026)', 'n-fan', 'Plumbing Final', 'Plumbing Final', [part('Plumbing Final')], { group: '19 Plumbing', cents: 130000 });
});

test('every line in a Selection & Allowance group is an allowance for things bought on top, and its picks are still selections', async () => {
  const v = await view();
  const nico = v.kids.find((k) => k.jobId === 'j-nico');
  assert.deepEqual(nico.allowances.map((a) => a.line).sort(), ['Bedding', 'Decor/Accessories'], 'a labor line is no allowance');
  assert.deepEqual(nico.items.map((i) => i.name).sort(), ['Felt Engraved Wall Tile', 'Plumbing Final', 'Stripe Duvet Cover']);
  // Drawers bought for Nico on top of his picks: waiting to be sorted onto one of his allowances (not straight to Also bought)
  await mail('o1', 'The Container Store', daysAgo(3), { kind: 'delivered', orderNumber: '899120272624', items: [{ name: 'Elfa Mesh Drawer', quantity: 2 }] });
  await decide(env.DB, { orderKey: 'The Container Store|899120272624', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-nico' } });
  const drawer = (await view()).kids.find((k) => k.jobId === 'j-nico').items.find((i) => /Elfa/.test(i.name));
  assert.equal(drawer.also.pending, true);
});

test('no email gives a price: a person’s price goes on it (per one), the email’s own stands over it, and the page’s price action saves it', async () => {
  await mail('o1', 'The Container Store', daysAgo(3), { kind: 'delivered', orderNumber: '899120272624', items: [{ name: 'Elfa Mesh Drawer', quantity: 2 }] });
  await decide(env.DB, { orderKey: 'The Container Store|899120272624', itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-nico' } });
  const drawer = () => view().then((v) => v.kids.find((k) => k.jobId === 'j-nico').items.find((i) => /Elfa/.test(i.name)));
  assert.equal((await drawer()).order.cents, null);
  const r = await post('price', { orderKey: 'The Container Store|899120272624', jobId: 'j-nico', items: [{ itemName: 'Elfa Mesh Drawer', cents: 4999 }] });
  assert.equal(r.success, true);
  const d = await drawer();
  assert.deepEqual([d.order.cents, d.qty, d.order.pricedBy], [4999, 2, 'a person']);
  await assert.rejects(() => setPrice(env.DB, { orderKey: 'x', itemName: 'y', cents: 0 }), /cost/);
  // An email that does say wins
  await env.DB.prepare("UPDATE order_mail SET read = ? WHERE id = 'o1'").bind(JSON.stringify({ kind: 'delivered', orderNumber: '899120272624', items: [{ name: 'Elfa Mesh Drawer', quantity: 2, cents: 3500 }] })).run();
  assert.equal((await drawer()).order.cents, 3500);
});

test('a shipment’s boxes for one kid moved to another shelf: all of them move, their labels print again, and until then they’re labels that never printed', async () => {
  await mail('o1', 'Shop', daysAgo(3), { kind: 'delivered', orderNumber: 'S-100', jobPo: 'NICO', items: [{ name: 'Felt Engraved Wall Tile' }, { name: 'Stripe Duvet Cover' }] });
  let v = await view();
  const its = v.kids.find((k) => k.jobId === 'j-nico').items.filter((i) => i.order);
  for (const [n, it] of its.entries()) await receive(env.DB, { tap: `tap-ship-000${n}`, jobId: 'j-nico', itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units: 1, boxes: n + 1 });
  await env.DB.prepare('UPDATE kid_receipts SET printed_at = ?').bind(daysAgo(0)).run();
  v = await view();
  assert.deepEqual(v.unprinted, [], 'printed already');
  const r = await post('shelf', { taps: ['tap-ship-0000', 'tap-ship-0001'], shelf: '7' });
  assert.equal(r.success, true);
  const rows = (await env.DB.prepare('SELECT shelf, printed_at FROM kid_receipts ORDER BY id').all()).results;
  assert.deepEqual(rows, [{ shelf: '7', printed_at: null }, { shelf: '7', printed_at: null }], 'on Shelf 7, their labels to print again (no printer here)');
  v = r.view;
  assert.deepEqual(v.unprinted.map((x) => [x.short, x.boxes]), [['Nico E.', 1], ['Nico E.', 2]]);
  assert.deepEqual(v.kids.find((k) => k.jobId === 'j-nico').shelves, ['7'], 'Nico’s shelf is 7 now (the old one is free)');
  const p = await post('print-waiting', {});
  assert.equal(p.success, true);
  assert.equal(p.print.setUp, false, 'no printer set up: they keep waiting');
});
