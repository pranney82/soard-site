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

test('the Order status field brought to the four: Received renamed At the Office, At the house added, the Partly ones let go only once no line or hand edit has them', async () => {
  const { fieldIds, letGoOldStatuses } = await import('../functions/api/_kid-jt.js');
  const field = { id: 'f-status', name: 'Order status', type: 'option', options: ['Not ordered', 'Partly ordered', 'Ordered', 'Partly received', 'Received'] };
  const others = ['Order details', 'Shelf', 'Also bought'].map((name, i) => ({ id: `f-${i}`, name, type: 'text', options: [] }));
  const updates = [];
  const fetchImpl = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.organization) return new Response(JSON.stringify({ organization: { customFields: { nodes: [field, ...others] } } }));
    if (q.updateCustomField) {
      updates.push(q.updateCustomField.$.options);
      // As JobTread takes them: a name, or a rename { from, to } (anything else it refuses, as it did on Nov 11)
      const opts = q.updateCustomField.$.options;
      if (opts.some((o) => typeof o !== 'string' && (typeof o?.from !== 'string' || typeof o?.to !== 'string'))) return new Response('A non-null value is required at "updateCustomField"."$"."options"."2"."from"', { status: 400 });
      field.options = opts.map((o) => (typeof o === 'string' ? o : o.to));
      return new Response(JSON.stringify({ updateCustomField: {} }));
    }
    return new Response('not faked', { status: 400 });
  };
  const jtEnv = { DB: env.DB, JOBTREAD_GRANT_KEY: 'k' };
  await fieldIds(jtEnv, { fetchImpl });
  assert.deepEqual(updates[0], ['Not ordered', 'Ordered', { from: 'Received', to: 'At the Office' }, 'At the house', 'Partly ordered', 'Partly received']);
  // A line still says an old one: they stay
  await env.DB.exec('CREATE TABLE IF NOT EXISTS kid_jt_lines (job_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT, wrote TEXT, hand TEXT, planned TEXT, wrote_at TEXT, error TEXT, PRIMARY KEY (job_id, item_id))');
  await env.DB.prepare("INSERT INTO kid_jt_lines (job_id, item_id, kind, wrote, hand, wrote_at) VALUES ('j-nico', 'n-bed', 'line', ?, '{}', 'x')").bind(JSON.stringify({ status: 'Partly received' })).run();
  assert.equal(await letGoOldStatuses(jtEnv, { fetchImpl }), false);
  assert.equal(updates.length, 1);
  // Every line written with the four: they go
  await env.DB.prepare("UPDATE kid_jt_lines SET wrote = ?").bind(JSON.stringify({ status: 'Ordered' })).run();
  assert.equal(await letGoOldStatuses(jtEnv, { fetchImpl }), true);
  assert.deepEqual(field.options, ['Not ordered', 'Ordered', 'At the Office', 'At the house']);
});

test('Nov 11 review: a hand-set status from before the four stands (its word as JobTread says it now) until the line has news', async () => {
  const { withHand, lineValues } = await import('../functions/api/_kid-jt.js');
  const o = { store: 'Shop', orderNumber: 'A1', at: '2026-11-02T15:00:00Z', cents: 12900 };
  const head = { name: 'Raincan Shower Head', qty: 1, got: 0, status: 'ordered', order: o, receipts: [] };
  const valve = { name: 'Shower Valve', qty: 1, got: 0, status: 'not', order: null, receipts: [] };
  const computed = lineValues([head, valve]);
  const a = withHand(computed, { status: 'Ordered', details: computed.details, shelf: null }, { status: 'Ordered', details: computed.details, shelf: null }, { status: { value: 'Ordered', basis: 'Partly ordered' } });
  assert.deepEqual([a.values.status, a.hand.status], ['Ordered', { value: 'Ordered', basis: 'Not ordered' }]);
  // Their Received is At the Office now (JobTread renamed it)
  const here = { ...head, got: 1, status: 'here', shelf: '3', receipts: [{ kind: 'receive', units: 1, at: '2026-11-09T15:00:00Z' }] };
  const c2 = lineValues([here, { ...valve, status: 'ordered', order: o }]);
  const b = withHand(c2, { status: 'Received', details: c2.details, shelf: 'Shelf 3' }, { status: 'At the Office', details: c2.details, shelf: 'Shelf 3' }, { status: { value: 'Received', basis: 'Partly received' } });
  assert.equal(b.values.status, 'At the Office');
  // The site's own Received, renamed by JobTread, isn't taken for a person's
  const c = withHand(c2, { status: 'Received', details: c2.details, shelf: 'Shelf 3' }, { status: 'At the Office', details: c2.details, shelf: 'Shelf 3' }, {});
  assert.deepEqual([c.values.status, c.hand.status], ['Ordered', undefined]);
  // News on the line: the site's status wins
  const d = withHand(lineValues([here, { ...valve, ...here, name: 'Shower Valve' }]), b.values, b.values, b.hand);
  assert.equal(d.values.status, 'At the Office');
});

test('Nov 11 review: things alike but for a size: the exact name wins, and a name that fits both names neither', async () => {
  const { namedIn } = await import('../functions/api/_kid-match.js');
  const items = [{ name: 'Large Woven Storage Basket' }, { name: 'Small Woven Storage Basket' }];
  assert.deepEqual([...namedIn(items, ['Large Woven Storage Basket'])], ['Large Woven Storage Basket']);
  assert.deepEqual([...namedIn(items, ['Woven Storage Basket - Large'])], ['Large Woven Storage Basket']);
  assert.deepEqual([...namedIn(items, ['Woven Storage Basket'])], []);
  assert.deepEqual([...namedIn(items, ['Large Woven Storage Basket', 'Small Woven Storage Basket'])].sort(), ['Large Woven Storage Basket', 'Small Woven Storage Basket']);
  assert.deepEqual([...namedIn([{ name: 'JASPER 1G Universal Plate' }, { name: 'JASPER 3G Universal Plate' }], ['Universal Plate'])], []);
});

test('Nov 11 review: a shelf move sent again (its answer was lost) moves nothing and prints nothing twice; one box’s label prints alone', async () => {
  await mail('o1', 'Shop', daysAgo(3), { kind: 'delivered', orderNumber: 'S-101', jobPo: 'NICO', items: [{ name: 'Felt Engraved Wall Tile' }] });
  const it = (await view()).kids.find((k) => k.jobId === 'j-nico').items.find((i) => i.order);
  await receive(env.DB, { tap: 'tap-move-0001', jobId: 'j-nico', itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units: 1, boxes: 3 });
  await post('shelf', { taps: ['tap-move-0001'], shelf: '9' });
  await env.DB.prepare("UPDATE kid_receipts SET printed_at = 'printed'").run();
  await post('shelf', { taps: ['tap-move-0001'], shelf: '9' });
  assert.equal((await env.DB.prepare("SELECT printed_at FROM kid_receipts WHERE id = 'tap-move-0001'").first()).printed_at, 'printed', 'the same move again: nothing to print again');
  const same = await post('shelf', { taps: ['tap-move-0001'], shelf: '9' });
  assert.equal(same.moved, 0, 'the page says it’s on that shelf already (no labels promised)');
  // One never saved (undone on the phone before it went): left out, the saved one moves
  const missing = await post('shelf', { taps: ['tap-move-0001', 'tap-not-saved'], shelf: '4' });
  assert.deepEqual([missing.success, missing.moved], [true, 1]);
  assert.equal((await env.DB.prepare("SELECT shelf FROM kid_receipts WHERE id = 'tap-move-0001'").first()).shelf, '4');
  assert.equal((await post('shelf', { taps: ['tap-not-saved'], shelf: '4' })).success, false, 'none saved: nothing to move');
});

test('Nov 11 review 2: a person’s status from before the four, moved onto the line as it is, is saved on the first run (no news) and gives way to the next news', async () => {
  const { writeLine, lineValues } = await import('../functions/api/_kid-jt.js');
  const ids = { status: 'f-status', details: 'f-details', shelf: 'f-shelf' };
  const o = { store: 'Maple Market', orderNumber: 'MM-7001', at: '2026-11-02T15:00:00Z', cents: 12900 };
  const head = { name: 'Raincan Shower Head', qty: 1, got: 0, status: 'ordered', order: o, receipts: [] };
  const valve = { name: 'Shower Valve', qty: 1, got: 0, status: 'not', order: null, receipts: [] };
  const arrived = (it) => ({ ...it, order: it.order || o, got: 1, status: 'here', shelf: '3', boxesLeft: 1, receipts: [{ kind: 'receive', units: 1, boxes: 1, at: '2026-11-12T15:00:00Z' }] });
  const jt = { status: 'Ordered', details: null, shelf: null };
  const fetchImpl = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.costItem) return new Response(JSON.stringify({ costItem: { id: q.costItem.$.id, customFieldValues: { nodes: [{ value: jt.status, customField: { id: ids.status } }, { value: jt.details, customField: { id: ids.details } }, { value: jt.shelf, customField: { id: ids.shelf } }] } } }));
    if (q.updateCostItem) { const v = q.updateCostItem.$.customFieldValues; Object.assign(jt, { status: v[ids.status], details: v[ids.details], shelf: v[ids.shelf] }); return new Response('{}'); }
    return new Response('not faked', { status: 400 });
  };
  const line = { jobId: 'j-nico', itemId: 'c-shower', allowance: false, items: [head, valve] };
  const before = lineValues(line.items);
  jt.details = before.details;
  await env.DB.exec('CREATE TABLE IF NOT EXISTS kid_jt_lines (job_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT, wrote TEXT, hand TEXT, planned TEXT, wrote_at TEXT, error TEXT, PRIMARY KEY (job_id, item_id))');
  await env.DB.prepare("INSERT INTO kid_jt_lines (job_id, item_id, kind, wrote, hand, wrote_at) VALUES ('j-nico', 'c-shower', 'line', ?, ?, '2026-11-10')")
    .bind(JSON.stringify({ status: 'Ordered', details: before.details, shelf: null }), JSON.stringify({ status: { value: 'Ordered', basis: 'Partly ordered' } })).run();
  const jtEnv = { DB: env.DB, JOBTREAD_GRANT_KEY: 'k' };
  await writeLine(jtEnv, ids, line, { fetchImpl });
  assert.equal(jt.status, 'Ordered', 'their status stands');
  const hand = JSON.parse((await env.DB.prepare("SELECT hand FROM kid_jt_lines WHERE item_id = 'c-shower'").first()).hand);
  assert.deepEqual(hand.status, { value: 'Ordered', basis: 'Not ordered' }, 'saved, moved onto the line as it is');
  await writeLine(jtEnv, ids, { ...line, items: [arrived(head), arrived(valve)] }, { fetchImpl });
  assert.equal(jt.status, 'At the Office', 'news on the line: the site’s status');
});

test('Nov 11 review 3: an undone check-in is left out of a shelf move (a move that waited on the phone lands after the undo)', async () => {
  const { undoMany } = await import('../functions/api/_kid-record.js');
  await mail('o1', 'Shop', daysAgo(3), { kind: 'delivered', orderNumber: 'S-102', jobPo: 'NICO', items: [{ name: 'Felt Engraved Wall Tile' }] });
  const it = (await view()).kids.find((k) => k.jobId === 'j-nico').items.find((i) => i.order);
  await receive(env.DB, { tap: 'tap-undone-0001', jobId: 'j-nico', itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units: 1, boxes: 1 });
  await undoMany(env.DB, ['tap-undone-0001']);
  const r = await post('shelf', { taps: ['tap-undone-0001'], shelf: '6' });
  assert.equal(r.success, false);
  assert.equal((await env.DB.prepare("SELECT shelf FROM kid_receipts WHERE id = 'tap-undone-0001'").first()).shelf, '1');
});
