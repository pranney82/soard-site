/**
 * Kid items: checking in, a person's answers, shelves, JobTread's lines, labels and the printer
 * (functions/api/_kid-record.js, _kid-checkin.js, _kid-jt.js, _kid-labels.js, _kid-print.js, kid-items-admin.js)
 * Run: node --test tests/kid-receive.test.mjs
 * Made-up kids, stores, orders, and a pretend JobTread only.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { checkinView } from '../functions/api/_kid-checkin.js';
import { receive, undo, moveShelf, decide, typedIn, shelfFor, writeState, shelvesOf } from '../functions/api/_kid-record.js';
import { lineStatus, lineValues, partLine, withHand, linesOf, writeKids, rehearse, makeAlso, fieldIds, STATUSES } from '../functions/api/_kid-jt.js';
import { itemLabel, zplText, receiptLabels, shelfLabel } from '../functions/api/_kid-labels.js';
import { printerAllowed, printerSetup, printerToken, sameSecret } from '../functions/api/_kid-print.js';
import { PRINTER_ROOTS } from '../functions/api/_printer-roots.js';
import { onRequestPost } from '../functions/api/kid-items-admin.js';

let env;
const part = (name, extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source: 'buy', key: `name:${name.toLowerCase()}`, ...extra });
async function line(jobId, jobName, itemId, lineName, words, parts) {
  await env.DB.prepare('INSERT INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, 'G', lineName, `h${itemId}`, JSON.stringify(parts), 'ai', '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
async function order(id, store, at, read) {
  await env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, state, read) VALUES ('pat@soardcharity.com', ?, ?, ?, ?, 'read', ?)").bind(id, at, store, read.kind, JSON.stringify(read)).run();
}
const view = () => checkinView(env, { photos: false });
const kidOf = (v, short) => v.kids.find((k) => k.short === short);
const itemOf = (v, short, name) => kidOf(v, short)?.items.find((i) => i.name === name);
let taps = 0;
const tap = () => `tap-test-${String(++taps).padStart(4, '0')}`;

beforeEach(async () => {
  env = { DB: await createD1() };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-shower', 'Shower System', 'Raincan Shower Head 52214-CZ, two valves', [part('Raincan Shower Head', { model: '52214-CZ' }), part('Shower Valve', { quantity: 2 })]);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-lamp', 'Lighting', 'Cloud Pendant Light', [part('Cloud Pendant Light')]);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')]);
  await line('j-ava', 'Ava Example (2026)', 'a-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')]);
  await line('j-ava', 'Ava Example (2026)', 'a-rug', 'Rug', 'Round Rainbow Rug', [part('Round Rainbow Rug')]);
  await order('m1', 'Shop', '2026-10-30T15:00:00Z', { kind: 'order', orderNumber: 'A1', jobPo: 'ROWAN', items: [{ name: 'Raincan Shower Head 52214-CZ', quantity: 1, price: '$129.00' }, { name: 'Bean Bag Chair', quantity: 1, price: '$80.00' }] });
});

test('a check-in: the item is here, the kid gets the first free shelf, and a retry counts nothing twice', async () => {
  const v = await view();
  const head = itemOf(v, 'Rowan S.', 'Raincan Shower Head');
  assert.equal(head.status, 'ordered');
  const t = tap();
  const a = await receive(env.DB, { tap: t, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, line: head.line, units: 1, boxes: 2 });
  assert.deepEqual([a.shelf, a.repeat], ['1', false]);
  const again = await receive(env.DB, { tap: t, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, units: 1, boxes: 2 });
  assert.equal(again.repeat, true);
  const v2 = await view();
  assert.deepEqual([itemOf(v2, 'Rowan S.', 'Raincan Shower Head').status, itemOf(v2, 'Rowan S.', 'Raincan Shower Head').got], ['here', 1]);
  assert.equal(kidOf(v2, 'Rowan S.').shelf, 'Shelf 1');
  assert.equal(await shelfFor(env.DB, 'j-ava'), '2', 'the next kid, the next shelf');
  assert.equal(await shelfFor(env.DB, 'j-rowan'), '1', 'a kid keeps their shelf');
});

test('units and boxes are separate: 1 of 2 valves is partly here; undo takes it back; not coming here', async () => {
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.equal(valve.qty, 2);
  const t = tap();
  await receive(env.DB, { tap: t, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 1, boxes: 1 });
  let v = await view();
  assert.deepEqual([itemOf(v, 'Rowan S.', 'Shower Valve').status, itemOf(v, 'Rowan S.', 'Shower Valve').got], ['partly', 1]);
  assert.equal(kidOf(v, 'Rowan S.').items[0].name, 'Shower Valve', 'partly here comes first');
  await undo(env.DB, t);
  v = await view();
  assert.equal(itemOf(v, 'Rowan S.', 'Shower Valve').status, 'not');
  assert.equal(itemOf(v, 'Rowan S.', 'Shower Valve').receipts[0].undone, true, 'kept, marked undone');
  const lamp = itemOf(v, 'Rowan S.', 'Cloud Pendant Light');
  await receive(env.DB, { tap: tap(), kind: 'house', jobId: 'j-rowan', itemId: lamp.itemId, partKey: lamp.partKey, name: lamp.name });
  assert.equal(itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light').status, 'house');
  await assert.rejects(receive(env.DB, { tap: 'x', jobId: 'j-rowan', itemId: 'a', partKey: 'b' }), /no id/);
});

test('shelves: moved to the Floor or another free shelf; another kid’s shelf is refused', async () => {
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const t = tap();
  await receive(env.DB, { tap: t, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1 });
  const rug = itemOf(await view(), 'Ava E.', 'Round Rainbow Rug');
  await receive(env.DB, { tap: tap(), jobId: 'j-ava', itemId: rug.itemId, partKey: rug.partKey, name: rug.name, units: 1, boxes: 1 });
  await assert.rejects(moveShelf(env.DB, t, '2'), /another kid’s/);
  await moveShelf(env.DB, t, 'Floor');
  assert.equal(itemOf(await view(), 'Rowan S.', 'Raincan Shower Head').shelf, 'Floor');
  await moveShelf(env.DB, t, '5');
  const v = await view();
  assert.deepEqual(kidOf(v, 'Rowan S.').shelves, ['5'], 'moved to 5; shelf 1 had nothing left on it, so it’s free again');
  assert.equal(v.shelves.find((s) => s.shelf === '5').kid, 'j-rowan');
});

test('Also bought: from the PO, from a person’s answer, and typed in at check-in', async () => {
  let v = await view();
  const bean = itemOf(v, 'Rowan S.', 'Bean Bag Chair');
  assert.deepEqual([bean.line, bean.status, bean.order.cents], ['Also bought', 'ordered', 8000]);
  assert.match(bean.also.key, /^soard-also-[0-9a-z]{14}$/);
  await typedIn(env.DB, { tap: tap(), jobId: 'j-ava', name: 'Bean bag cover', cents: 2500, units: 1, boxes: 1 });
  v = await view();
  const typed = itemOf(v, 'Ava E.', 'Bean bag cover');
  assert.deepEqual([typed.status, typed.line, typed.also.typed, typed.cents], ['here', 'Also bought', true, 2500]);
});

test('Needs a look: a person’s answer places it (a line, the allowance, Also bought, not a kid’s); Wrong kid moves it', async () => {
  await order('m2', 'Rug Store', '2026-11-01T15:00:00Z', { kind: 'order', orderNumber: 'B2', jobPo: 'ROWEN', items: [{ name: 'Round Rainbow Rug 5ft' }, { name: 'Framed Print' }, { name: 'Tape' }] });
  let v = await view();
  const look = v.needsLook.find((o) => o.orderNumber === 'B2');
  assert.deepEqual(look.items.map((i) => i.name), ['Framed Print', 'Tape'], 'the rug placed itself on Ava’s Rug line');
  assert.equal(look.kid, 'j-ava');
  assert.equal(itemOf(v, 'Ava E.', 'Round Rainbow Rug').status, 'ordered');
  await decide(env.DB, { orderKey: look.key, itemName: 'Framed Print', decision: { type: 'line', kid: 'j-ava', itemId: 'a-decor', partKey: 'allow' } });
  await decide(env.DB, { orderKey: look.key, itemName: 'Tape', decision: { type: 'notKid' } });
  v = await view();
  assert.equal(v.needsLook.find((o) => o.orderNumber === 'B2'), undefined, 'answered, gone from the list');
  assert.equal(itemOf(v, 'Ava E.', 'Round Rainbow Rug').status, 'ordered');
  const print = itemOf(v, 'Ava E.', 'Framed Print');
  assert.deepEqual([print.line, print.allowance, print.status], ['Decor', true, 'ordered'], 'on the decor allowance, its own part');
  // Wrong kid: the bean bag was Ava's
  const bean = itemOf(v, 'Rowan S.', 'Bean Bag Chair');
  await decide(env.DB, { orderKey: bean.order.key, itemName: bean.orderedAs, decision: { type: 'also', kid: 'j-ava' } });
  v = await view();
  assert.equal(itemOf(v, 'Rowan S.', 'Bean Bag Chair'), undefined);
  assert.equal(itemOf(v, 'Ava E.', 'Bean Bag Chair').status, 'ordered');
  await assert.rejects(decide(env.DB, { orderKey: 'k', itemName: 'x', decision: { type: 'line', kid: 'j-ava' } }), /Pick the line/);
});

test('cancelled: the whole order puts its items back; part of it asks a person', async () => {
  await order('m3', 'Shop', '2026-11-02T15:00:00Z', { kind: 'cancelled', orderNumber: 'A1', items: [{ name: 'Raincan Shower Head 52214-CZ' }, { name: 'Bean Bag Chair' }] });
  let v = await view();
  assert.equal(itemOf(v, 'Rowan S.', 'Raincan Shower Head').status, 'not');
  assert.equal(itemOf(v, 'Rowan S.', 'Bean Bag Chair'), undefined);
  await env.DB.prepare("UPDATE order_mail SET read = ? WHERE id = 'm3'").bind(JSON.stringify({ kind: 'cancelled', orderNumber: 'A1', items: [{ name: 'Bean Bag Chair' }] })).run();
  v = await view();
  const look = v.needsLook.find((o) => o.orderNumber === 'A1');
  assert.equal(look.undo, 'cancelled');
  assert.equal(look.items.length, 2);
  await decide(env.DB, { orderKey: look.key, itemName: 'Bean Bag Chair', decision: { type: 'cancelled' } });
  const head = itemOf(v, 'Rowan S.', 'Raincan Shower Head');
  await decide(env.DB, { orderKey: look.key, itemName: 'Raincan Shower Head 52214-CZ', decision: { type: 'line', kid: 'j-rowan', itemId: head.itemId, partKey: head.partKey } });
  v = await view();
  assert.equal(itemOf(v, 'Rowan S.', 'Bean Bag Chair'), undefined);
  assert.equal(itemOf(v, 'Rowan S.', 'Raincan Shower Head').status, 'ordered');
  assert.equal(v.needsLook.find((o) => o.orderNumber === 'A1'), undefined);
});

test('a line’s status and details, from its parts; an allowance line is never complete', () => {
  const o = { store: 'Shop', orderNumber: 'A1', at: '2026-11-02T15:00:00Z', cents: 12900 };
  const here = { name: 'Head', qty: 1, got: 1, status: 'here', shelf: '3', order: o, receipts: [{ kind: 'receive', units: 1, at: '2026-11-09T15:00:00Z' }] };
  const valve = { name: 'Valve', qty: 2, got: 1, status: 'partly', shelf: '3', order: o, receipts: [{ kind: 'receive', units: 1, at: '2026-11-09T15:00:00Z' }] };
  const not = { name: 'Bar', qty: 1, got: 0, status: 'not', order: null, receipts: [] };
  const donated = { name: 'Sink', qty: 1, got: 0, status: 'not', source: 'donated', order: null, receipts: [] };
  assert.equal(lineStatus([not]), 'Not ordered');
  assert.equal(lineStatus([{ ...not, order: o, status: 'ordered' }, not]), 'Partly ordered');
  assert.equal(lineStatus([{ ...not, order: o, status: 'ordered' }, donated]), 'Ordered', 'a donated part is coming');
  assert.equal(lineStatus([here, valve]), 'Partly received');
  assert.equal(lineStatus([here, { ...here, status: 'house' }]), 'Received');
  assert.equal(lineStatus([here], { allowance: true }), 'Partly received');
  assert.equal(partLine(valve), 'Valve (2): ordered Nov 2, from Shop, order A1, $129.00; 1 of 2 here Nov 9, Shelf 3');
  assert.equal(partLine(donated), 'Sink: donated, coming');
  assert.equal(partLine(not), 'Bar: not ordered yet');
  assert.deepEqual(lineValues([here, valve, not]), { status: 'Partly received', details: `${partLine(here)}\n${partLine(valve)}\n${partLine(not)}`, shelf: 'Shelf 3' });
  assert.deepEqual(STATUSES, ['Not ordered', 'Partly ordered', 'Ordered', 'Partly received', 'Received']);
});

test('a person’s edit in JobTread stands: their status until the line moves, their note always', () => {
  const last = { status: 'Ordered', details: 'Head: ordered', shelf: null };
  const now = { status: 'Received', details: 'Head: ordered\nCalled the store', shelf: null };
  const a = withHand({ status: 'Ordered', details: 'Head: ordered', shelf: null }, last, now, {});
  assert.deepEqual(a.values, { status: 'Received', details: 'Head: ordered\nNote: Called the store', shelf: null });
  const b = withHand({ status: 'Partly received', details: 'Head: here', shelf: 'Shelf 1' }, a.values, a.values, a.hand);
  assert.equal(b.values.status, 'Partly received', 'the site’s news wins');
  assert.equal(b.values.details, 'Head: here\nNote: Called the store');
});

/** A pretend JobTread: custom fields, cost groups and items, their field values */
function fakeJobTread() {
  const jt = { fields: [{ id: 'f-discount', name: '% Discount', type: 'number' }], items: new Map([['r-shower', { values: {} }], ['r-lamp', { values: {} }], ['a-rug', { values: {} }]]), groups: [], calls: [], n: 0 };
  jt.fetch = async (url, init) => {
    const q = JSON.parse(init.body).query;
    jt.calls.push(Object.keys(q).filter((k) => k !== '$')[0]);
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (q.organization?.customFields) return ok({ organization: { customFields: { nodes: jt.fields } } });
    if (q.organization?.costTypes) return ok({ organization: { costTypes: { nodes: [{ id: 't-mat', name: 'Materials' }, { id: 't-lab', name: 'Labor' }] } } });
    if (q.organization?.costCodes) return ok({ organization: { costCodes: { nodes: [{ id: 'c-fur', name: 'Furnishings', number: '1200' }] } } });
    if (q.createCustomField) { const f = { id: `f-${++jt.n}`, ...q.createCustomField.$ }; jt.fields.push(f); return ok({ createCustomField: { createdCustomField: { id: f.id } } }); }
    if (q.job?.costItems) { const gid = q.job.costItems.$.where[2]; const hit = [...jt.items].find(([, v]) => v.globalId === gid); return ok({ job: { costItems: { nodes: hit ? [{ id: hit[0] }] : [] } } }); }
    if (q.job?.costGroups) { const g = jt.groups.find((x) => x.jobId === q.job.$.id); return ok({ job: { costGroups: { nodes: g ? [{ id: g.id }] : [] } } }); }
    if (q.createCostGroup) { const g = { id: `g-${++jt.n}`, ...q.createCostGroup.$ }; jt.groups.push(g); return ok({ createCostGroup: { createdCostGroup: { id: g.id } } }); }
    if (q.createCostItem) { const id = `ci-${++jt.n}`; jt.items.set(id, { ...q.createCostItem.$, values: { ...(q.createCostItem.$.customFieldValues || {}) } }); return ok({ createCostItem: { createdCostItem: { id } } }); }
    if (q.costItem) {
      const it = jt.items.get(q.costItem.$.id);
      return ok({ costItem: it ? { id: q.costItem.$.id, customFieldValues: { nodes: Object.entries(it.values).filter(([, v]) => v !== null).map(([fid, value]) => ({ value, customField: { id: fid } })) } } : null });
    }
    // JobTread refuses a selection on updateCostItem ("A non-null value is required at updateCostItem.costItem.$", Nov 10 2026)
    if (q.updateCostItem && Object.keys(q.updateCostItem).some((k) => k !== '$')) return new Response('A non-null value is required at "updateCostItem"."costItem"."$"', { status: 400 });
    if (q.updateCostItem) { const it = jt.items.get(q.updateCostItem.$.id); Object.assign(it.values, q.updateCostItem.$.customFieldValues || {}); return ok({ updateCostItem: { costItem: { id: q.updateCostItem.$.id } } }); }
    if (q.deleteCostItem) { jt.items.delete(q.deleteCostItem.$.id); jt.deleted = [...(jt.deleted || []), q.deleteCostItem.$.id]; return ok({ deleteCostItem: {} }); }
    return new Response('not faked', { status: 400 });
  };
  return jt;
}

test('JobTread: the fields made once, each line written once, Also bought made once by its globalId, a dry run writes nothing', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  const jt = fakeJobTread();
  const dry = await writeKids(env, { fetchImpl: jt.fetch, mode: 'dry' });
  assert.equal(jt.calls.length, 0, 'a dry run never calls JobTread');
  assert.ok(dry.planned >= 3);
  const ids = await fieldIds(env, { fetchImpl: jt.fetch });
  assert.deepEqual(jt.fields.filter((f) => f.targetType === 'costItem').map((f) => [f.name, f.type, f.showOnSpecifications]), [['Order status', 'option', false], ['Order details', 'text', false], ['Shelf', 'text', false], ['Also bought', 'boolean', false]]);
  const first = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual([first.made, first.errors], [1, []], 'the bean bag chair added to Rowan’s budget');
  const bean = [...jt.items.values()].find((i) => i.name === 'Bean Bag Chair');
  assert.deepEqual([bean.unitCost, bean.quantity, bean.isSelected, bean.costTypeId, bean.costCodeId, bean.values[ids.also]], [80, 1, true, 't-mat', 'c-fur', true]);
  assert.equal(jt.groups[0].name, 'Also bought');
  assert.equal(jt.items.get('r-shower').values[ids.status], 'Partly ordered');
  assert.match(jt.items.get('r-shower').values[ids.details], /Raincan Shower Head: ordered Oct 30, from Shop, order A1, \$129\.00\nShower Valve \(2\): not ordered yet/);
  assert.equal(jt.items.get('r-lamp').values[ids.status], 'Not ordered');
  jt.calls.length = 0;
  const second = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual([second.wrote, second.made, jt.calls.filter((c) => c === 'updateCostItem' || c === 'createCostItem').length], [0, 0, 0], 'nothing new, nothing written');
  // Checked in: the line moves, its shelf shows
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  await receive(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1 });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual([jt.items.get('r-shower').values[ids.status], jt.items.get('r-shower').values[ids.shelf]], ['Partly received', 'Shelf 1']);
  // Asked twice for the same Also bought line (a retry): one line
  const again = await makeAlso(env, ids, { key: bean.globalId, jobId: 'j-rowan', name: 'Bean Bag Chair', qty: 1, cents: 8000 }, { fetchImpl: jt.fetch });
  assert.equal([...jt.items.values()].filter((i) => i.globalId === bean.globalId).length, 1);
  assert.ok(again);
});

test('the rehearsal on the sandbox job passes against JobTread', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  const jt = fakeJobTread();
  const r = await rehearse(env, { fetchImpl: jt.fetch, now: '2026-11-09T20:00:00Z' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.steps.map((s) => s.name), ['fields', 'a line made once though asked twice', 'written', 'nothing new, nothing written', 'a hand edit kept', 'news after a hand edit', 'put back']);
});

test('POST: check in, print, JobTread; an unknown action is refused', async () => {
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const post = (q, body) => onRequestPost({ env, request: new Request(`https://site.example/api/kid-items-admin?${q}=1`, { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} });
  const res = await post('receive', { tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, line: head.line, units: 1, boxes: 2 });
  const body = await res.json();
  assert.equal(body.success, true, JSON.stringify(body));
  assert.deepEqual([body.shelf, body.jt, body.print.setUp], ['1', 'off', false], 'no printer bound, JobTread off: said so');
  assert.equal(body.view.kids.find((k) => k.short === 'Rowan S.').items.find((i) => i.name === 'Raincan Shower Head').status, 'here');
  const u = await (await post('undo', { tap: body.receipt })).json();
  assert.equal(u.view.kids.find((k) => k.short === 'Rowan S.').items.find((i) => i.name === 'Raincan Shower Head').status, 'ordered');
  assert.equal((await post('nothing', {})).status, 400);
});

test('labels: the kid, the item, box n of N, the shelf, a QR to the check-in; ZPL marks can’t break out', () => {
  const z = itemLabel({ kid: 'Rowan S.', item: 'Raincan ^FS Shower Head', line: 'Shower System', box: 2, boxes: 3, shelf: 'Shelf 7', at: '2026-11-09T20:00:00Z', tap: 'tap-abc12345' });
  assert.match(z, /\^FDROWAN S\.\^FS/);
  assert.match(z, /\^FDRaincan FS Shower Head\^FS/);
  assert.match(z, /\^FDBox 2 of 3\^FS/);
  assert.match(z, /\^FR\^FDSHELF 7\^FS/);
  assert.match(z, /\^FDMA,https:\/\/sunshineonaranneyday\.com\/admin\/checkin\/\?r=tap-abc12345&b=2\^FS/, 'each box its own code');
  assert.ok(z.startsWith('^XA') && z.endsWith('^XZ'));
  assert.match(z, /\^MTD/, 'direct thermal: prints with no ribbon');
  assert.match(shelfLabel({ shelf: '3', name: 'Shelf 3' }), /\^MTD/);
  assert.equal(zplText('a^b~c\nd'), 'a b c d');
  assert.equal(receiptLabels({ kid: 'A', item: 'B', boxes: 3, tap: 't' }).length, 3);
  assert.match(shelfLabel({ shelf: '12', name: 'Shelf 12' }), /\^FDSHELF\^FS[\s\S]*\^A0N,420,420[^\n]*\^FD12\^FS[\s\S]*\?shelf=12/, 'SHELF, then the number as big as it goes');
});

test('the printer: its own sign-in, and the setup file with the root certificates', async () => {
  const token = await printerToken(env.DB);
  assert.ok(token.length >= 30);
  assert.equal(await printerToken(env.DB), token, 'made once');
  const basic = (u, p) => new Request('https://site.example/api/printer-ws/', { headers: { Authorization: `Basic ${btoa(`${u}:${p}`)}` } });
  assert.equal(await printerAllowed(basic('soard', token), env.DB), true);
  assert.equal(await printerAllowed(basic('soard', `${token}x`), env.DB), false);
  assert.equal(await printerAllowed(basic('other', token), env.DB), false);
  assert.equal(await printerAllowed(new Request('https://site.example/api/printer-ws/'), env.DB), false);
  assert.equal(sameSecret('', ''), false);
  const file = await printerSetup(env.DB);
  assert.match(file, /! U1 setvar "weblink\.ip\.conn1\.location" "https:\/\/sunshineonaranneyday\.com\/api\/printer-ws\/"/);
  assert.ok(file.includes(`"sunshineonaranneyday.com soard ${token}"`));
  const m = /! CISDFCRC16\r\n0000\r\nWEBLINK1_CA\.NRD\r\n([0-9A-F]{8})\r\n0000\r\n/.exec(file);
  assert.ok(m);
  assert.equal(parseInt(m[1], 16), new TextEncoder().encode(PRINTER_ROOTS).length);
  assert.equal((PRINTER_ROOTS.match(/BEGIN CERTIFICATE/g) || []).length, 9);
  await writeState(env.DB, 'printer', {});
});

test('a guess for a person: the part whose own words fit, not just any part on that line', async () => {
  await line('j-ava', 'Ava Example (2026)', 'a-sink', 'Sink Plumbing', 'Touch2O Faucet, Angled Supply Stop Valve, P-Trap', [part('Touch2O Faucet'), part('Angled Supply Stop Valve'), part('P-Trap Kit')]);
  // Rowan's vanity needs one too, so the order needs a person: which kid?
  await line('j-rowan', 'Rowan Sample (2026)', 'r-vanity', 'Vanity Plumbing', 'Angled Supply Stop Valve, Drain', [part('Vanity Drain'), part('Angled Supply Stop Valve')]);
  await order('m9', 'Pipe Store', '2026-11-03T15:00:00Z', { kind: 'order', orderNumber: 'P9', jobPo: 'SINK', items: [{ name: 'Angled Supply Stop Valve 3/8 in' }] });
  const v = await view();
  const look = v.needsLook.find((o) => o.orderNumber === 'P9');
  assert.equal(look.items[0].guesses['j-ava'], itemOf(v, 'Ava E.', 'Angled Supply Stop Valve').id);
  assert.equal(look.items[0].guesses['j-rowan'], itemOf(v, 'Rowan S.', 'Angled Supply Stop Valve').id);
});

test('review fixes: prices from the reader’s cents; the site’s own Also bought line is never read back as a selection', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  await order('m5', 'Shop', '2026-11-04T15:00:00Z', { kind: 'order', orderNumber: 'C5', jobPo: 'AVA', items: [{ name: 'Floor Cushion', quantity: 2, cents: 3450 }] });
  let v = await view();
  assert.equal(itemOf(v, 'Ava E.', 'Floor Cushion').order.cents, 3450);
  const jt = fakeJobTread();
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const cushion = [...jt.items].find(([, i]) => i.name === 'Floor Cushion');
  assert.deepEqual([cushion[1].unitCost, cushion[1].quantity], [34.5, 2]);
  // The selection reader picked the new line up before it knew the site's own lines
  await line('j-ava', 'Ava Example (2026)', cushion[0], 'Floor Cushion', 'Floor Cushion', [part('Floor Cushion')]);
  v = await view();
  assert.equal(kidOf(v, 'Ava E.').items.filter((i) => i.name === 'Floor Cushion').length, 1);
  assert.equal(itemOf(v, 'Ava E.', 'Floor Cushion').line, 'Also bought');
  const { isSiteLine } = await import('../functions/api/_selection-parts.js');
  assert.equal(isSiteLine({ globalId: 'soard-also-abc' }), true);
  assert.equal(isSiteLine({ costGroup: { name: 'Also bought' } }), true);
  assert.equal(isSiteLine({ globalId: null, costGroup: { name: 'Bathroom' } }), false);
});

test('review fixes: Wrong kid on an Also bought line already in JobTread makes the new kid’s line and takes the old one off', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  const jt = fakeJobTread();
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const before = [...jt.items].find(([, i]) => i.name === 'Bean Bag Chair');
  const bean = itemOf(await view(), 'Rowan S.', 'Bean Bag Chair');
  await decide(env.DB, { orderKey: bean.order.key, itemName: bean.orderedAs, decision: { type: 'also', kid: 'j-ava' } });
  const r = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.equal(r.retired, 1);
  assert.deepEqual(jt.deleted, [before[0]], 'Rowan’s line deleted');
  const now = [...jt.items].find(([, i]) => i.name === 'Bean Bag Chair');
  assert.notEqual(now[0], before[0]);
  assert.equal(now[1].jobId, 'j-ava');
  assert.equal(itemOf(await view(), 'Ava E.', 'Bean Bag Chair').also.costItemId, now[0]);
});

test('review fixes: an Also bought line asked for twice at once is made once', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  const jt = fakeJobTread();
  const ids = await fieldIds(env, { fetchImpl: jt.fetch });
  const thing = { key: 'soard-also-twice00000000', jobId: 'j-rowan', name: 'Desk Lamp', qty: 1, cents: 1999 };
  const [a, b] = await Promise.all([makeAlso(env, ids, thing, { fetchImpl: jt.fetch }), makeAlso(env, ids, thing, { fetchImpl: jt.fetch })]);
  assert.equal([...jt.items.values()].filter((i) => i.name === 'Desk Lamp').length, 1);
  assert.ok(a || b);
});

test('review fixes: a hand-set status gives way to news; every line of a typed note stays, even one starting Note:', () => {
  const site = { status: 'Ordered', details: 'Head: ordered', shelf: null };
  const person = { status: 'Received', details: 'Head: ordered\nCalled the store\nThey ship Friday\nNote: back order', shelf: null };
  const news = withHand({ status: 'Partly received', details: 'Head: 1 of 2 here', shelf: 'Shelf 1' }, site, person, {});
  assert.equal(news.values.status, 'Partly received', 'the check-in is news');
  assert.equal(news.values.details, 'Head: 1 of 2 here\nNote: Called the store\nThey ship Friday\nback order');
  const first = withHand({ status: 'Not ordered', details: 'Head: not ordered yet', shelf: null }, null, { status: 'Ordered', details: 'Ordered by phone' }, {});
  assert.deepEqual([first.values.status, first.hand.note], ['Ordered', 'Ordered by phone'], 'what was there before the site’s first write is kept');
});

test('review fixes: a shelf picked by mistake is let go; scanning finds what’s partly here', async () => {
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const t = tap();
  await receive(env.DB, { tap: t, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1 });
  await moveShelf(env.DB, t, '6');
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), ['6'], 'shelf 1 had nothing left on it');
  await moveShelf(env.DB, t, '1');
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), ['1']);
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  await order('m6', 'Valve Co', '2026-11-05T15:00:00Z', { kind: 'shipped', orderNumber: 'V6', jobPo: 'ROWAN', items: [{ name: 'Shower Valve', quantity: 2 }], tracking: [{ carrier: 'UPS', number: '1Z9999999999999999' }] });
  await receive(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 1, boxes: 1 });
  const { findBox } = await import('../functions/api/_kid-scan.js');
  const { orderReads } = await import('../functions/api/_kid-checkin.js');
  const found = findBox(await view(), await orderReads(env.DB), { trackingNumbers: ['1Z9999999999999999'], orderNumbers: [], po: '', items: [] });
  assert.deepEqual(found?.items, [valve.id], 'the second valve’s box');
});

test('Nov 10 live check: no Also bought line for a kid whose lines aren’t all read; a check-in follows its order to the real line', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  await env.DB.prepare("INSERT INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES ('j-rowan', 'r-furn', 'Rowan Sample (2026)', 'G', 'Furniture', 30000, 'hf', '[]', 'none:1', '2026-11-10', 'Bean Bag Chair, Big Joe', 'bean bag chair big joe')").run();
  let v = await view();
  assert.deepEqual(v.unread, ['j-rowan']);
  const bean = itemOf(v, 'Rowan S.', 'Bean Bag Chair');
  assert.equal(bean.line, 'Also bought', 'on the page meanwhile, so it can be checked in');
  await receive(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: bean.itemId, partKey: bean.partKey, name: bean.orderedAs, units: 1, boxes: 1 });
  const jt = fakeJobTread();
  const r = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual([r.made, r.waiting], [0, 1], 'held until Rowan’s Furniture line is read');
  // The reader reads it: the chair is on Rowan's Furniture line, and its check-in went with it
  await env.DB.prepare("UPDATE kid_parts SET parts = ?, read_by = 'ai' WHERE item_id = 'r-furn'").bind(JSON.stringify([part('Bean Bag Chair', { brand: 'Big Joe' })])).run();
  v = await view();
  const chair = kidOf(v, 'Rowan S.').items.filter((i) => /bean bag/i.test(i.name));
  assert.equal(chair.length, 1);
  assert.deepEqual([chair[0].line, chair[0].status], ['Furniture', 'here']);
});

test('Nov 10 live check: the trades’ work and the job’s own costs aren’t things to receive', async () => {
  const { isGoodsLine } = await import('../functions/api/_selection-parts.js');
  for (const name of ['Portalet', 'Final Clean', 'Large Dumpster', 'Dust Protection', 'Drywall Material', 'Electrical all', 'Floor repair', 'Homeowner Agreement', 'Interior Door Install']) {
    assert.equal(isGoodsLine({ name, isSelected: false, costType: { name: 'Materials' } }), false, name);
  }
  for (const name of ['Sink Plumbing', 'Therapy Equipment', 'Sensory Items', 'Furniture', 'Lighting']) {
    assert.equal(isGoodsLine({ name, isSelected: false, costType: { name: 'Materials' } }), true, name);
  }
  assert.equal(isGoodsLine({ name: 'Cleaning cart', isSelected: true }), true, 'a family’s chosen selection is always goods');
});

test('Nov 10 live check: a line read as one whole part takes each thing ordered for it as its own item', async () => {
  await line('j-ava', 'Ava Example (2026)', 'a-sensory', 'Sensory Items', 'Bubble Tube Lamp, Fiber Optic Lights, Weighted Blanket, Sensory Swing', [{ ...part('Sensory Items'), whole: true }]);
  await order('m7', 'Amazon', '2026-11-05T15:00:00Z', { kind: 'order', orderNumber: 'S7', jobPo: 'AVA', items: [{ name: 'Sensory Bubble Tube Lamp 4ft' }, { name: 'Fiber Optic Lights Sensory' }] });
  await order('m8', 'Amazon', '2026-11-06T15:00:00Z', { kind: 'order', orderNumber: 'S8', jobPo: 'AVA', items: [{ name: 'Weighted Blanket Sensory 10lb' }] });
  const v = await view();
  const ava = kidOf(v, 'Ava E.');
  const sensory = ava.items.filter((i) => i.line === 'Sensory Items');
  assert.deepEqual(sensory.map((i) => i.name).sort(), ['Fiber Optic Lights Sensory', 'Sensory Bubble Tube Lamp 4ft', 'Weighted Blanket Sensory 10lb']);
  assert.ok(sensory.every((i) => i.status === 'ordered'));
  assert.equal(v.needsLook.filter((o) => ['S7', 'S8'].includes(o.orderNumber)).length, 0, 'none of them asks “another one?”');
  const l = linesOf(v).find((x) => x.itemId === 'a-sensory');
  assert.equal(lineValues(l.items, { allowance: l.allowance }).status, 'Partly ordered', 'never “Ordered”: the line’s full list isn’t known');
});

test('check-out: a scanned label sends its check-in to the house once; when all of it is out the shelf frees, and JobTread says where', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ accounts: [{ name: 'Pat Lee', email: 'pat@soardcharity.com' }, { name: 'Sam Fox', email: 'sam@soardcharity.com' }] })).run();
  const v0 = await view();
  const head = itemOf(v0, 'Rowan S.', 'Raincan Shower Head');
  const valve = itemOf(v0, 'Rowan S.', 'Shower Valve');
  const a = tap(), b = tap(), c = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, line: head.line, units: 1, boxes: 1 }, { by: 'pat@soardcharity.com' });
  await receive(env.DB, { tap: b, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, line: valve.line, units: 1, boxes: 1 }, { by: 'pat@soardcharity.com' });
  await receive(env.DB, { tap: c, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, line: valve.line, units: 1, boxes: 1 }, { by: 'pat@soardcharity.com' });
  const out1 = await checkOut(env.DB, { tap: tap(), ref: a }, { by: 'sam@soardcharity.com' });
  assert.equal(out1.repeat, false);
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a })).repeat, true, 'the same label again counts once');
  await checkOut(env.DB, { tap: tap(), ref: b }, { by: 'sam@soardcharity.com' });
  let v = await view();
  assert.equal(itemOf(v, 'Rowan S.', 'Raincan Shower Head').status, 'out');
  assert.deepEqual([itemOf(v, 'Rowan S.', 'Shower Valve').status, itemOf(v, 'Rowan S.', 'Shower Valve').sent], ['here', 1], 'one of the two valves is still at the Office');
  assert.deepEqual(kidOf(v, 'Rowan S.').shelves, ['1']);
  const l = linesOf(v).find((x) => x.itemId === 'r-shower');
  let vals = lineValues(l.items);
  assert.equal(vals.shelf, 'Shelf 1');
  assert.match(vals.details, /Raincan Shower Head: ordered Oct 30.*; here Nov \d+ \(Pat\); out to the house Nov \d+ \(Sam\)/);
  assert.match(vals.details, /Shower Valve \(2\): all 2 here .*\(Pat\), Shelf 1; 1 of 2 out to the house/);
  await checkOut(env.DB, { tap: tap(), ref: c }, { by: 'sam@soardcharity.com' });
  v = await view();
  assert.deepEqual(kidOf(v, 'Rowan S.').shelves, [], 'everything out: the shelf is free for the next kid');
  vals = lineValues(linesOf(v).find((x) => x.itemId === 'r-shower').items);
  assert.deepEqual([vals.status, vals.shelf], ['Received', 'At the house']);
  await assert.rejects(checkOut(env.DB, { tap: tap(), ref: 'not-a-real-label' }), /isn’t one of SOARD’s/);
});

test('each makeover’s Project Manager rides along, for who opens on Check out', async () => {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS kid_parts_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)");
  await env.DB.prepare("INSERT INTO kid_parts_state (key, data) VALUES ('state', ?)").bind(JSON.stringify({ jobs: [{ id: 'j-rowan', name: 'Rowan Sample (2026)', pm: 'Sam' }] })).run();
  const v = await view();
  assert.equal(kidOf(v, 'Rowan S.').pm, 'Sam');
  assert.equal(kidOf(v, 'Ava E.').pm, null);
});

test('check-out: a label scanned after Load all counts once', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 2 });
  await checkOut(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, units: 1, name: head.name });
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a })).repeat, true);
  const it = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  assert.deepEqual([it.status, it.sent], ['out', 1]);
});

test('check-out by the box: each label is one box; a sink in three boxes is out when the third is; towels two a box', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const v0 = await view();
  const head = itemOf(v0, 'Rowan S.', 'Raincan Shower Head');
  const valve = itemOf(v0, 'Rowan S.', 'Shower Valve');
  const a = tap(), b = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 3 });
  await receive(env.DB, { tap: b, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 2, boxes: 1 });
  const r1 = await checkOut(env.DB, { tap: tap(), ref: a, box: 1 });
  assert.deepEqual([r1.repeat, r1.receipt.units, r1.receipt.box], [false, 0, 1], 'box 1 of 3 carries no whole unit yet');
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a, box: 1 })).repeat, true, 'the same box again counts once');
  await checkOut(env.DB, { tap: tap(), ref: a, box: 2 });
  assert.equal(itemOf(await view(), 'Rowan S.', 'Raincan Shower Head').status, 'here', 'two of its three boxes are out: not all of it yet');
  const r3 = await checkOut(env.DB, { tap: tap(), ref: a, box: 3 });
  assert.equal(r3.receipt.units, 1);
  assert.equal(itemOf(await view(), 'Rowan S.', 'Raincan Shower Head').status, 'out');
  const rv = await checkOut(env.DB, { tap: tap(), ref: b, box: 1 });
  assert.equal(rv.receipt.units, 2, 'both valves in the one box');
  assert.equal(itemOf(await view(), 'Rowan S.', 'Shower Valve').status, 'out');
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: b, box: 9 })).repeat, true, 'a box number past the last is the whole check-in, already out');
});

test('review 2: box n carries the same share in any order; undo and rescan can’t over- or under-count', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  await env.DB.prepare("UPDATE kid_parts SET parts = ? WHERE item_id = 'r-shower'").bind(JSON.stringify([part('Raincan Shower Head', { model: '52214-CZ' }), part('Shower Valve', { quantity: 7 })])).run();
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 7, boxes: 5 });
  const outs = {};
  for (const b of [1, 2, 3, 4]) outs[b] = (await checkOut(env.DB, { tap: tap(), ref: a, box: b })).receipt;
  assert.deepEqual([1, 2, 3, 4].map((b) => outs[b].units), [1, 1, 2, 1], 'seven towels in five boxes: 1, 1, 2, 1, 2');
  await undo(env.DB, outs[3].id);
  await checkOut(env.DB, { tap: tap(), ref: a, box: 3 });
  await checkOut(env.DB, { tap: tap(), ref: a, box: 5 });
  const it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.deepEqual([it.sent, it.got, it.status], [7, 7, 'out']);
});

test('review 3, 11: a stale tick is capped at what’s still here; the same box twice at once counts once', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 2 });
  const [x, y] = await Promise.all([checkOut(env.DB, { tap: tap(), ref: a, box: 1 }), checkOut(env.DB, { tap: tap(), ref: a, box: 1 })]);
  assert.equal([x, y].filter((r) => !r.repeat).length, 1, 'one of the two phones counts it');
  await checkOut(env.DB, { tap: tap(), ref: a, box: 2 });
  const late = await checkOut(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, units: 4, name: head.name });
  assert.equal(late.repeat, true, 'everything is out already: the old tick adds nothing');
  const it = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  assert.deepEqual([it.sent, it.got], [1, 1]);
});

test('review 4, 5: a check-in taken back takes its check-outs with it; a check-out taken back gets the shelf back', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const lamp = itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: lamp.itemId, partKey: lamp.partKey, name: lamp.name, units: 1, boxes: 1 });
  const out = (await checkOut(env.DB, { tap: tap(), ref: a, box: 1 })).receipt;
  assert.deepEqual(kidOf(await view(), 'Rowan S.').shelves, [], 'all out: shelf free');
  await undo(env.DB, out.id);
  assert.deepEqual(kidOf(await view(), 'Rowan S.').shelves, ['1'], 'back from the truck, back on Shelf 1');
  const rug = itemOf(await view(), 'Ava E.', 'Round Rainbow Rug');
  assert.equal((await receive(env.DB, { tap: tap(), jobId: 'j-ava', itemId: rug.itemId, partKey: rug.partKey, name: rug.name, units: 1, boxes: 1 })).shelf, '2', 'Ava gets the next shelf, not Rowan’s');
  // Out again, then the check-in itself is taken back: its check-out goes with it
  await checkOut(env.DB, { tap: tap(), ref: a, box: 1 });
  await undo(env.DB, a);
  let it = itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light');
  assert.deepEqual([it.got, it.sent, it.status], [0, 0, 'not']);
  await receive(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: lamp.itemId, partKey: lamp.partKey, name: lamp.name, units: 1, boxes: 1 });
  it = itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light');
  assert.equal(it.status, 'here', 'checked in again, it’s here, not out');
});

test('review 10: JobTread names a shelf only while something is still on it', () => {
  const o = { store: 'Shop', orderNumber: 'A1', at: '2026-11-02T15:00:00Z' };
  const it = { name: 'Towel', qty: 8, got: 2, sent: 2, status: 'partly', shelf: '1', order: o, receipts: [{ kind: 'receive', units: 2, at: '2026-11-09T15:00:00Z' }, { kind: 'out', units: 2, at: '2026-11-10T15:00:00Z' }] };
  assert.doesNotMatch(partLine(it), /Shelf 1/);
  assert.match(partLine(it), /2 of 8 here .*; out to the house/);
});

test('a whole load confirmed in one request: each goes on its own; one that can’t go doesn’t stop the rest', async () => {
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 2 });
  const res = await onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?out=1', { method: 'POST', body: JSON.stringify({ items: [{ tap: tap(), ref: 'gone-label-0001', box: 1 }, { tap: tap(), ref: a, box: 1 }, { tap: tap(), ref: a, box: 2 }] }) }), waitUntil: () => {} });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.results.map((r) => r.status || 'ok'), [404, 'ok', 'ok']);
  assert.equal(body.view.kids.find((k) => k.short === 'Rowan S.').items.find((i) => i.name === 'Raincan Shower Head').status, 'out');
});

test('labels as Zebra prints them (checked on Labelary’s render, Nov 10 2026): nothing wider than the label, the QR inside its edges', async () => {
  const { wrapText } = await import('../functions/api/_kid-labels.js');
  assert.deepEqual(wrapText('Wayfair Louis Parisian Globe 3-Light Modern Contemporary LED Vanity Light in Matte Black with Frosted Glass Shades, Dimmable', 54, 3),
    ['Wayfair Louis Parisian', 'Globe 3-Light Modern', 'Contemporary LED Vanity...']);
  const z = itemLabel({ kid: 'Christopher-Alexander Montgomery', item: 'x'.repeat(200), line: 'y'.repeat(120), box: 12, boxes: 14, shelf: 'Floor', at: '2026-11-10T15:00:00Z', tap: '3f2b8c1e-9a4d-4e7b-8f21-6c0d5a9e7b13' });
  for (const m of z.matchAll(/\^A0N,(\d+),\d+\^FD([^^]*)\^FS/g)) {
    const [, size, text] = m;
    assert.ok(text.length * Number(size) * 0.5 <= 732 + 1, `"${text}" at ${size} fits 732 dots`);
  }
  const qr = /\^FO(\d+),(\d+)\^BQN,2,(\d+)/.exec(z);
  assert.ok(Number(qr[1]) + 45 * Number(qr[3]) <= 812 && Number(qr[2]) + 45 * Number(qr[3]) <= 1218, 'the QR, even a large one, stays on the label');
});
