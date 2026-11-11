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
async function line(jobId, jobName, itemId, lineName, words, parts, { group = 'G', cents = 100 } = {}) {
  await env.DB.prepare('INSERT INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, group, lineName, cents, `h${itemId}`, JSON.stringify(parts), 'ai', '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
// An allowance: the same generic words on every makeover, in a Selection & Allowance group, with money set aside
const ALLOWANCE = { group: 'Bedroom Makeover Selection & Allowance', cents: 500000 };
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
  await line('j-rowan', 'Rowan Sample (2026)', 'r-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')], ALLOWANCE);
  await line('j-ava', 'Ava Example (2026)', 'a-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')], ALLOWANCE);
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
  assert.deepEqual([print.line, print.also.allowItemId, print.also.pending, print.status], ['Decor allowance', 'a-decor', undefined, 'ordered'], 'on the decor allowance: its own line next to it, not sorted again');
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
  // The kids' Decor allowances: $5,000 each, in their Selection & Allowance groups
  const allowance = (group) => ({ name: 'Decor', quantity: 1, unitCost: 5000, unitPrice: 5000, costGroupId: group, costCodeId: 'c-dec', costTypeId: 't-mat', values: {} });
  const jt = { fields: [{ id: 'f-discount', name: '% Discount', type: 'number' }], items: new Map([['r-shower', { values: {} }], ['r-lamp', { values: {} }], ['a-rug', { values: {} }], ['r-decor', allowance('g-sel-r')], ['a-decor', allowance('g-sel-a')]]), groups: [], calls: [], n: 0 };
  jt.fetch = async (url, init) => {
    const q = JSON.parse(init.body).query;
    jt.calls.push(Object.keys(q).filter((k) => k !== '$')[0]);
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (q.organization?.customFields) return ok({ organization: { customFields: { nodes: jt.fields } } });
    if (q.organization?.costTypes) return ok({ organization: { costTypes: { nodes: [{ id: 't-mat', name: 'Materials' }, { id: 't-lab', name: 'Labor' }] } } });
    if (q.organization?.costCodes) return ok({ organization: { costCodes: { nodes: [{ id: 'c-fur', name: 'Furnishings', number: '1200' }] } } });
    if (q.createCustomField) { const f = { id: `f-${++jt.n}`, ...q.createCustomField.$ }; jt.fields.push(f); return ok({ createCustomField: { createdCustomField: { id: f.id } } }); }
    if (q.job?.costItems) { const gid = q.job.costItems.$.where[2]; const hit = [...jt.items].find(([, v]) => v.globalId === gid); return ok({ job: { costItems: { nodes: hit ? [{ id: hit[0] }] : [] } } }); }
    if (q.job?.costGroups) { const name = q.job.costGroups.$.where?.and?.[0]?.[2]; const g = jt.groups.find((x) => x.jobId === q.job.$.id && (!name || x.name === name)); return ok({ job: { costGroups: { nodes: g ? [{ id: g.id }] : [] } } }); }
    if (q.createCostGroup) { const g = { id: `g-${++jt.n}`, ...q.createCostGroup.$ }; jt.groups.push(g); return ok({ createCostGroup: { createdCostGroup: { id: g.id } } }); }
    if (q.createCostItem) { const id = `ci-${++jt.n}`; jt.items.set(id, { ...q.createCostItem.$, values: { ...(q.createCostItem.$.customFieldValues || {}) } }); return ok({ createCostItem: { createdCostItem: { id } } }); }
    if (q.costItem) {
      const it = jt.items.get(q.costItem.$.id);
      return ok({ costItem: it ? { id: q.costItem.$.id, name: it.name, quantity: it.quantity, unitCost: it.unitCost, unitPrice: it.unitPrice, unitCostFormula: it.unitCostFormula ?? null, unitPriceFormula: null,
        costGroup: { id: it.costGroupId }, costCode: { id: it.costCodeId }, costType: { id: it.costTypeId },
        customFieldValues: { nodes: Object.entries(it.values).filter(([, v]) => v !== null).map(([fid, value]) => ({ value, customField: { id: fid } })) } } : null });
    }
    // JobTread refuses a selection on updateCostItem ("A non-null value is required at updateCostItem.costItem.$", Nov 10 2026)
    if (q.updateCostItem && Object.keys(q.updateCostItem).some((k) => k !== '$')) return new Response('A non-null value is required at "updateCostItem"."costItem"."$"', { status: 400 });
    if (q.updateCostItem) {
      const { id, customFieldValues, ...rest } = q.updateCostItem.$;
      const it = jt.items.get(id);
      if (!it) return new Response('That cost item doesn’t exist', { status: 400 });
      Object.assign(it.values, customFieldValues || {});
      Object.assign(it, rest);
      return ok({ updateCostItem: { costItem: { id } } });
    }
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
  assert.deepEqual(r.steps.map((s) => s.name), ['fields', 'a line made once though asked twice', 'written', 'nothing new, nothing written', 'a hand edit kept', 'news after a hand edit', 'put back',
    'a line next to its allowance', 'the allowance down by it', 'moved to Also bought, the allowance back', 'moved next to its allowance again', 'the allowance put back', 'a real allowance’s group']);
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
  assert.match(vals.details, /Shower Valve \(2\): all 2 here .*\(Pat\), Shelf 1; 1 of 2 boxes out to the house/);
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

test('check-out: a label scanned after Load all (its boxes one by one) counts once', async () => {
  const { checkOut, checkOutMany } = await import('../functions/api/_kid-record.js');
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 2 });
  const all = await checkOutMany(env.DB, [{ tap: tap(), ref: a, box: 1 }, { tap: tap(), ref: a, box: 2 }]);
  assert.deepEqual(all.map((r) => r.repeat), [false, false]);
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a, box: 2 })).repeat, true);
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a })).repeat, true, 'an older label with no box number: out already');
  const it = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  assert.deepEqual([it.status, it.sent], ['out', 1]);
});



test('review 3, 11: the same box twice at once counts once; a check-out that names no box is refused, never guessed', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 2 });
  const [x, y] = await Promise.all([checkOut(env.DB, { tap: tap(), ref: a, box: 1 }), checkOut(env.DB, { tap: tap(), ref: a, box: 1 })]);
  assert.equal([x, y].filter((r) => !r.repeat).length, 1, 'one of the two phones counts it');
  await assert.rejects(checkOut(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, units: 4, name: head.name }), (e) => e.status === 400 && /older copy of the page/.test(e.message));
  await assert.rejects(checkOut(env.DB, { tap: tap(), ref: a, box: 3 }), (e) => e.status === 400 && /isn’t one of its 2 boxes/.test(e.message), 'box 3 of 2 is a misread, not the whole thing');
  const it = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  assert.deepEqual([it.sent, it.boxesLeft, it.status], [0, 1, 'here']);
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

test('shipments: by the store’s emails, an order is ordered, on the way (with its day), out, delivered (the items its email names), then checked in', async () => {
  const { shipmentsOf } = await import('../functions/api/_kid-checkin.js');
  await order('s1', 'Shop', '2026-11-01T16:00:00Z', { kind: 'shipped', orderNumber: 'A1', expected: '2026-11-04', items: [{ name: 'Raincan Shower Head 52214-CZ' }] });
  let v = await view();
  let sh = v.shipments.find((x) => x.orderNumber === 'A1');
  assert.deepEqual([sh.stage, sh.expected, sh.items.length], ['shipped', '2026-11-04', 2], 'the head and the bean bag chair, two kids’ lines, one order');
  await order('s2', 'Shop', '2026-11-04T18:00:00Z', { kind: 'delivered', orderNumber: 'A1', items: [{ name: 'Raincan Shower Head 52214-CZ' }] });
  v = await view();
  sh = v.shipments.find((x) => x.orderNumber === 'A1');
  assert.equal(sh.stage, 'delivered');
  assert.deepEqual(sh.items.map((i) => i.delivered), [true, false], 'its email named the head only');
  assert.equal(v.shipments[0].orderNumber, 'A1', 'delivered first');
  // The whole shipment checked in at once
  const items = sh.items.map((i) => itemOf(v, 'Rowan S.', kidOf(v, 'Rowan S.').items.find((x) => x.id === i.id).name)).map((it) => ({ tap: tap(), jobId: 'j-rowan', itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units: it.qty, boxes: 1 }));
  const res = await onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?receive=1', { method: 'POST', body: JSON.stringify({ items }) }), waitUntil: () => {} });
  const body = await res.json();
  assert.deepEqual(body.results.map((r) => [r.shelf, r.repeat]), [['1', false], ['1', false]]);
  assert.equal(body.view.shipments.find((x) => x.orderNumber === 'A1').stage, 'in');
  assert.equal(shipmentsOf([], []).length, 0);
});

test('shipments review: a delay moves the day; a shipping email with no order number joins by tracking; delivered names its things strictly; nothing phantom', async () => {
  await order('d1', 'Shop', '2026-11-02T16:00:00Z', { kind: 'shipped', orderNumber: 'A1', expected: '2026-11-04', items: [{ name: 'Raincan Shower Head 52214-CZ' }], tracking: [{ carrier: 'UPS', number: '1Z9999999999999991' }] });
  await order('d2', 'Shop', '2026-11-03T16:00:00Z', { kind: 'delayed', orderNumber: 'A1', expected: '2026-11-12', items: [] });
  let sh = (await view()).shipments.find((x) => x.orderNumber === 'A1');
  assert.equal(sh.expected, '2026-11-12', 'the newest email’s day');
  // The carrier's delivered email, with no order number, but the same tracking number; it names the head its own way
  await order('d3', 'UPS', '2026-11-05T16:00:00Z', { kind: 'delivered', items: [{ name: 'Raincan Showerhead, Chrome' }], tracking: [{ carrier: 'UPS', number: '1Z9999999999999991' }] });
  const v = await view();
  sh = v.shipments.find((x) => x.orderNumber === 'A1');
  assert.equal(sh.stage, 'delivered', 'joined its order by the tracking number');
  assert.ok(sh.items.every((i) => i.delivered), 'its names matched none of the order’s things exactly: the whole order');
  assert.equal(kidOf(v, 'Rowan S.').items.filter((i) => /showerhead/i.test(i.name)).length, 0, 'the delivered email’s own names add no phantom thing');
});

test('shipments review: one shipped to the house is its own; ready for pickup is not delivered', async () => {
  await order('h1', 'Rug Store', '2026-11-02T16:00:00Z', { kind: 'shipped', orderNumber: 'R9', jobPo: 'AVA', shipTo: 'elsewhere', items: [{ name: 'Round Rainbow Rug' }] });
  await order('p1', 'Lamp Shop', '2026-11-03T16:00:00Z', { kind: 'pickup', orderNumber: 'L7', jobPo: 'ROWAN', items: [{ name: 'Cloud Pendant Light' }] });
  const v = await view();
  assert.deepEqual([v.shipments.find((x) => x.orderNumber === 'R9').stage, v.shipments.find((x) => x.orderNumber === 'R9').house], ['house', true]);
  assert.equal(v.shipments.find((x) => x.orderNumber === 'L7').stage, 'pickup');
});

test('scan review: the box’s own order is exact; a name only narrows; an order already all in says so', async () => {
  const { findBox } = await import('../functions/api/_kid-scan.js');
  const { orderReads } = await import('../functions/api/_kid-checkin.js');
  await order('t1', 'Shop', '2026-11-02T16:00:00Z', { kind: 'shipped', orderNumber: 'A1', items: [{ name: 'Raincan Shower Head 52214-CZ' }], tracking: [{ carrier: 'UPS', number: '1Z9999999999999992' }] });
  let v = await view();
  const reads = await orderReads(env.DB);
  const base = { trackingNumbers: [], orderNumbers: [], po: '', store: '', items: [], references: [], models: [], names: [] };
  assert.equal(findBox(v, reads, { ...base, trackingNumbers: ['1Z9999999999999992'] }).exact, true);
  assert.equal(Boolean(findBox(v, reads, { ...base, names: ['Attn: Rowan'] }).exact), false);
  for (const it of kidOf(v, 'Rowan S.').items.filter((i) => i.order?.orderNumber === 'A1')) await receive(env.DB, { tap: tap(), jobId: 'j-rowan', itemId: it.itemId, partKey: it.partKey, name: it.name, units: it.qty, boxes: 1 });
  v = await view();
  const done = findBox(v, reads, { ...base, trackingNumbers: ['1Z9999999999999992'] });
  assert.deepEqual([done.done, done.items.length, done.short], [true, 0, 'Rowan S.']);
});

test('batch review: past 60 are refused, not lost; a retry prints only what never reached the printer; JobTread said only when every kid was written', async () => {
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  // A pretend print hub: it counts the labels it takes, and can be out of reach
  const printed = [];
  let reachable = true;
  env.PRINT_HUB = { idFromName: () => 'office', get: () => ({ fetch: async (url, init) => {
    if (!reachable) throw new Error('hub out of reach');
    if (String(url).endsWith('/print')) { const n = JSON.parse(init.body).labels.length; printed.push(n); return Response.json({ sent: n, online: true, problems: [] }); }
    return Response.json({ seenAt: Date.now(), online: true, problems: [] });
  } }) };
  const items = [{ tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 2 }];
  const post = (body, q = 'receive') => onRequestPost({ env, request: new Request(`https://site.example/api/kid-items-admin?${q}=1`, { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} }).then((r) => r.json());
  const first = await post({ items });
  assert.equal(first.results[0].repeat, false);
  assert.deepEqual(printed, [2], 'both boxes’ labels');
  // The phone never got that answer and sends it again: saved once, and its labels aren't printed a second time
  const again = await post({ items });
  assert.equal(again.results[0].repeat, true);
  assert.equal(again.print, undefined);
  assert.deepEqual(printed, [2]);
  // Saved, but the printer was never reached (the request was cut off, or the hub was down): the retry prints them
  const more = [{ tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1 }];
  reachable = false;
  await post({ items: more });
  reachable = true;
  assert.deepEqual(printed, [2]);
  await post({ items: more });
  assert.deepEqual(printed, [2, 1], 'the retry printed what never reached the printer');
  await post({ items: more });
  assert.deepEqual(printed, [2, 1], 'and only once');
  // One check-in at a time, the same rule
  const one = { tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1 };
  reachable = false;
  await post(one);
  reachable = true;
  await post(one);
  await post(one);
  assert.deepEqual(printed, [2, 1, 1]);
  delete env.PRINT_HUB;
  const many = Array.from({ length: 62 }, () => ({ tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1 }));
  const big = await post({ items: many });
  assert.equal(big.results.length, 62);
  assert.equal(big.results.filter((r) => r.status === 400).length, 2);
});

test('check-out by the box (round 2): a check-in is out only when every box is; units go as the boxes do, in any order', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const v0 = await view();
  const head = itemOf(v0, 'Rowan S.', 'Raincan Shower Head');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 3 });
  // The review's case: the LAST of the sink's three boxes scanned first
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a, box: 3 })).repeat, false);
  let it = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  assert.deepEqual([it.status, it.sent, it.boxesLeft], ['here', 0, 2], 'one of three boxes out: not out, two boxes left');
  assert.deepEqual(kidOf(await view(), 'Rowan S.').shelves, ['1'], 'the shelf stays: two boxes are still on it');
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a, box: 1 })).repeat, false, 'box 1 isn’t “already loaded”');
  assert.equal((await checkOut(env.DB, { tap: tap(), ref: a, box: 1 })).repeat, true, 'the same box again counts once');
  await checkOut(env.DB, { tap: tap(), ref: a, box: 2 });
  it = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  assert.deepEqual([it.status, it.sent, it.boxesLeft], ['out', 1, 0]);
  assert.deepEqual(kidOf(await view(), 'Rowan S.').shelves, []);
});

test('check-out by the box (round 2): seven towels in five boxes, a box undone and rescanned, ends seven of seven', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  await env.DB.prepare("UPDATE kid_parts SET parts = ? WHERE item_id = 'r-shower'").bind(JSON.stringify([part('Raincan Shower Head', { model: '52214-CZ' }), part('Shower Valve', { quantity: 7 })])).run();
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 7, boxes: 5 });
  const outs = {};
  for (const b of [1, 2, 3, 4]) outs[b] = (await checkOut(env.DB, { tap: tap(), ref: a, box: b })).receipt;
  assert.deepEqual([itemOf(await view(), 'Rowan S.', 'Shower Valve').sent, itemOf(await view(), 'Rowan S.', 'Shower Valve').boxesLeft], [5, 1], 'four of five boxes: five of seven towels');
  await undo(env.DB, outs[3].id);
  assert.equal(itemOf(await view(), 'Rowan S.', 'Shower Valve').boxesLeft, 2);
  await checkOut(env.DB, { tap: tap(), ref: a, box: 3 });
  await checkOut(env.DB, { tap: tap(), ref: a, box: 5 });
  const it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.deepEqual([it.sent, it.got, it.status], [7, 7, 'out']);
  const { outState } = await import('../functions/api/_kid-record.js');
  const st = outState([{ id: 'r1', units: 4, boxes: 2 }], [{ ref: 'r1', box: 1 }, { ref: 'r1', box: 2 }]);
  assert.deepEqual([st.sent, st.allOut, st.boxesLeft], [4, true, 0], 'one box scanned and the other ticked: all out');
  const half = outState([{ id: 'r1', units: 4, boxes: 2 }], [{ ref: 'r1', box: 1 }, { units: 2 }]);
  assert.deepEqual([half.sent, half.allOut, half.boxesLeft], [2, false, 1], 'a count with no check-in counts for nothing');
});

// ─── Round 3 (Nov 11 2026): every check-out names a box of a check-in ───

const outRows = async () => (await env.DB.prepare("SELECT id, ref, box, undone_at FROM kid_receipts WHERE kind = 'out'").all()).results;
const postOut = (q, body) => onRequestPost({ env, request: new Request(`https://site.example/api/kid-items-admin?${q}=1`, { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} }).then((r) => r.json());

test('round 3, A: a thing whose check-in followed it to its real line goes out by its boxes, and the shelf frees', async () => {
  await env.DB.prepare("INSERT INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES ('j-rowan', 'r-furn', 'Rowan Sample (2026)', 'G', 'Furniture', 30000, 'hf', '[]', 'none:1', '2026-11-10', 'Bean Bag Chair, Big Joe', 'bean bag chair big joe')").run();
  const bean = itemOf(await view(), 'Rowan S.', 'Bean Bag Chair');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: bean.itemId, partKey: bean.partKey, name: bean.orderedAs, line: bean.line, units: 1, boxes: 2 });
  // The Furniture line is read: the chair and its check-in move there, under another key
  await env.DB.prepare("UPDATE kid_parts SET parts = ?, read_by = 'ai' WHERE item_id = 'r-furn'").bind(JSON.stringify([part('Bean Bag Chair', { brand: 'Big Joe' })])).run();
  const chair = itemOf(await view(), 'Rowan S.', 'Bean Bag Chair');
  assert.notEqual(`${chair.itemId}|${chair.partKey}`, `${bean.itemId}|${bean.partKey}`, 'the case: the thing’s key isn’t its check-in’s');
  // Its circle (or Load all) puts each of its boxes in the load by its check-in
  const res = await postOut('out', { items: [1, 2].map((box) => ({ tap: tap(), ref: a, box })) });
  assert.deepEqual(res.results.map((r) => r.repeat), [false, false]);
  const after = itemOf(res.view, 'Rowan S.', 'Bean Bag Chair');
  assert.deepEqual([after.status, after.sent, after.boxesLeft], ['out', 1, 0]);
  assert.equal((await outRows()).length, 2);
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), []);
});

test('round 3, B and C: taking back one check-in takes back only its own boxes; the next one in is at the Office', async () => {
  const { checkOutMany } = await import('../functions/api/_kid-record.js');
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  const A = tap(), B = tap();
  await receive(env.DB, { tap: A, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 3, boxes: 1 }, { now: '2026-11-10T11:00:00Z' });
  await receive(env.DB, { tap: B, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 1, boxes: 1 }, { now: '2026-11-10T12:00:00Z' });
  // Load all: both check-ins' boxes
  await checkOutMany(env.DB, [{ tap: tap(), ref: A, box: 1 }, { tap: tap(), ref: B, box: 1 }]);
  assert.equal(itemOf(await view(), 'Rowan S.', 'Shower Valve').status, 'out');
  // B was a double check-in: taken back. A's three stay on the truck
  await undo(env.DB, B);
  let it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.deepEqual([it.got, it.sent, it.boxesLeft, it.status], [3, 3, 0, 'out']);
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), [], 'nothing at the Office: the shelf stays free');
  // Two more come in: they're on the shelf, not "loaded"
  const C = tap();
  await receive(env.DB, { tap: C, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 2, boxes: 1 });
  it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.deepEqual([it.got, it.sent, it.boxesLeft], [5, 3, 1]);
  assert.equal(lineValues(linesOf(await view()).find((x) => x.itemId === 'r-shower').items).shelf, 'Shelf 1');
  assert.equal((await checkOutMany(env.DB, [{ tap: tap(), ref: C, box: 1 }]))[0].repeat, false, 'its label loads it');
});

test('round 3, E: a load longer than one request takes is answered for every box, the rest marked to send again', async () => {
  const { OUT_BATCH } = await import('../functions/api/_kid-record.js');
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const refs = [];
  for (let i = 0; i < 6; i++) { const t = tap(); refs.push(t); await receive(env.DB, { tap: t, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 17 }); }
  const items = refs.flatMap((ref) => Array.from({ length: 17 }, (_, b) => ({ tap: tap(), ref, box: b + 1 })));
  assert.equal(items.length, 102);
  const res = await postOut('out', { items });
  assert.equal(res.results.length, 102, 'every box gets an answer');
  assert.deepEqual(res.results.slice(OUT_BATCH).map((r) => r.status), [413, 413]);
  assert.equal(res.results.slice(0, OUT_BATCH).filter((r) => r.error).length, 0);
  assert.equal((await outRows()).length, OUT_BATCH);
});

test('round 3, F: back off the truck, a box goes back on its own shelf (another kid’s by now: the kid’s own), once', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const v = await view();
  const lamp = itemOf(v, 'Rowan S.', 'Cloud Pendant Light'), head = itemOf(v, 'Rowan S.', 'Raincan Shower Head');
  const L = tap(), H = tap();
  await receive(env.DB, { tap: L, jobId: 'j-rowan', itemId: lamp.itemId, partKey: lamp.partKey, name: lamp.name, units: 1, boxes: 1, shelf: '1' });
  await receive(env.DB, { tap: H, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1, shelf: '2' });
  const outL = (await checkOut(env.DB, { tap: tap(), ref: L, box: 1 })).receipt;
  await checkOut(env.DB, { tap: tap(), ref: H, box: 1 });
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), []);
  assert.equal((await undo(env.DB, outL.id)).shelf, '1');
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), ['1'], 'only the lamp’s shelf: Shelf 2 is empty');
  // The lamp out again; the old take-back replayed from a phone's queue changes nothing
  await checkOut(env.DB, { tap: tap(), ref: L, box: 1 });
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), []);
  assert.equal((await undo(env.DB, outL.id)).repeat, true);
  assert.deepEqual(await shelvesOf(env.DB, 'j-rowan'), []);
  assert.equal(itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light').status, 'out');
  // Ava has Shelf 1 now; the lamp comes back off the truck: Rowan's next free shelf, and the check-in says so
  const rug = itemOf(await view(), 'Ava E.', 'Round Rainbow Rug');
  await receive(env.DB, { tap: tap(), jobId: 'j-ava', itemId: rug.itemId, partKey: rug.partKey, name: rug.name, units: 1, boxes: 1, shelf: '1' });
  const outs = (await outRows()).filter((r) => r.ref === L && !r.undone_at);
  const back = await undo(env.DB, outs[0].id);
  assert.equal(back.shelf, '2');
  const it = itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light');
  assert.deepEqual([it.status, it.shelf], ['here', '2']);
});

test('round 3, Take back: every box of a thing in one request, each said, JobTread after', async () => {
  const { checkOutMany } = await import('../functions/api/_kid-record.js');
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  const A = tap();
  await receive(env.DB, { tap: A, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 2, boxes: 3 });
  const outs = [tap(), tap(), tap()];
  await checkOutMany(env.DB, outs.map((t, i) => ({ tap: t, ref: A, box: i + 1 })));
  let waited = 0;
  const res = await onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?undo=1', { method: 'POST', body: JSON.stringify({ taps: [...outs, 'tap-not-saved-0001'] }) }), waitUntil: () => { waited++; } }).then((r) => r.json());
  assert.equal(res.success, true);
  assert.deepEqual(res.results.map((r) => r.shelf ?? r.status), ['1', '1', '1', 404]);
  assert.equal(waited, 1, 'JobTread in the background');
  const it = itemOf(res.view, 'Rowan S.', 'Shower Valve');
  assert.deepEqual([it.sent, it.boxesLeft, it.status], [0, 3, 'here']);
});

test('round 3, G: a load of 80 boxes is a few reads and one write, not hundreds', async () => {
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const refs = [];
  for (let i = 0; i < 4; i++) { const t = tap(); refs.push(t); await receive(env.DB, { tap: t, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 6, boxes: 20 }); }
  const { checkOutMany } = await import('../functions/api/_kid-record.js');
  let q = 0;
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => { q++; return prepare(sql); };
  const r = await checkOutMany(env.DB, refs.flatMap((ref) => Array.from({ length: 20 }, (_, b) => ({ tap: tap(), ref, box: b + 1 }))));
  env.DB.prepare = prepare;
  assert.equal(r.filter((x) => !x.repeat && !x.error).length, 80);
  assert.ok(q <= 90, `${q} statements`);
});

test('round 3, H: a thing on two shelves is where its boxes still at the Office are', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  const A = tap(), B = tap();
  await receive(env.DB, { tap: A, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 1, boxes: 2, shelf: '1' }, { now: '2026-11-10T11:00:00Z' });
  await receive(env.DB, { tap: B, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 1, boxes: 1, shelf: 'Floor' }, { now: '2026-11-10T12:00:00Z' });
  let it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.deepEqual(it.shelves, ['Floor', '1'], 'newest first');
  await checkOut(env.DB, { tap: tap(), ref: B, box: 1 });
  it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.deepEqual([it.shelf, it.shelves, it.boxesLeft], ['1', ['1'], 2]);
  assert.equal(lineValues(linesOf(await view()).find((x) => x.itemId === 'r-shower').items).shelf, 'Shelf 1');
});

// ─── Round 4 (Nov 11 2026) ───

/** A pretend print hub: on or off, how many labels it takes a request (the real one: 40), what it was sent */
function pretendHub({ online = true, take = 40 } = {}) {
  const hub = { online, sent: [], statusAsked: 0 };
  env.PRINT_HUB = { idFromName: () => 'office', get: () => ({ fetch: async (url, init) => {
    if (String(url).endsWith('/status')) { hub.statusAsked++; return Response.json({ seenAt: Date.now(), online: hub.online, problems: [], waiting: 0 }); }
    const labels = JSON.parse(init.body).labels.slice(0, take);
    if (!hub.online) return Response.json({ sent: 0, queued: labels.length, online: false, problems: [] });
    hub.sent.push(labels.length);
    return Response.json({ sent: labels.length, online: true, problems: [] });
  } }) };
  return hub;
}

test('round 4: a thing partly in, the rest "Not coming here": what came is at the Office until it’s loaded, and JobTread says both', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  await env.DB.prepare("UPDATE kid_parts SET parts = ? WHERE item_id = 'r-shower'").bind(JSON.stringify([part('Raincan Shower Head', { model: '52214-CZ' }), part('Shower Valve', { quantity: 2 })])).run();
  const valve = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name, units: 1, boxes: 1 });
  await receive(env.DB, { tap: tap(), kind: 'house', jobId: 'j-rowan', itemId: valve.itemId, partKey: valve.partKey, name: valve.name });
  let it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.deepEqual([it.status, it.house, it.boxesLeft, it.shelf], ['here', true, 1, '1'], 'here, on its shelf, to be loaded');
  let line = lineValues(linesOf(await view()).find((x) => x.itemId === 'r-shower').items);
  assert.match(line.details, /Shower Valve \(2\): 1 of 2 here .*, Shelf 1; the rest went to the house/);
  assert.equal(line.shelf, 'Shelf 1');
  await checkOut(env.DB, { tap: tap(), ref: a, box: 1 });
  it = itemOf(await view(), 'Rowan S.', 'Shower Valve');
  assert.equal(it.status, 'out');
  line = lineValues(linesOf(await view()).find((x) => x.itemId === 'r-shower').items);
  assert.match(line.details, /the rest went to the house; out to the house/);
});

test('round 4: JobTread says boxes on the truck before a whole unit is ("2 of 3 boxes out to the house")', async () => {
  const { checkOutMany } = await import('../functions/api/_kid-record.js');
  const lamp = itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light');
  const a = tap();
  await receive(env.DB, { tap: a, jobId: 'j-rowan', itemId: lamp.itemId, partKey: lamp.partKey, name: lamp.name, units: 1, boxes: 3 });
  await checkOutMany(env.DB, [{ tap: tap(), ref: a, box: 1 }, { tap: tap(), ref: a, box: 2 }]);
  const line = lineValues(linesOf(await view()).find((x) => x.itemId === 'r-lamp').items);
  assert.match(line.details, /Cloud Pendant Light: here .*, Shelf 1; 2 of 3 boxes out to the house/);
});

test('round 4: labels go in parts the hub takes (40); each check-in is printed once, however the tries overlap', async () => {
  const hub = pretendHub();
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const post = (body) => onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?receive=1', { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} }).then((r) => r.json());
  const items = Array.from({ length: 5 }, () => ({ tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 9 }));
  const first = await post({ items });
  assert.deepEqual(hub.sent, [36, 9], 'all 45, in parts of 40 or fewer, never a check-in split');
  assert.equal(first.print.printed, 45);
  // Two tries of the same shipment at once (the phone's retry overlapping its first): one prints
  const more = Array.from({ length: 2 }, () => ({ tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 2 }));
  await Promise.all([post({ items: more }), post({ items: more })]);
  assert.deepEqual(hub.sent, [36, 9, 4]);
  delete env.PRINT_HUB;
});

test('round 4: the printer off, labels wait on the site (never dropped by the hub) and print once when it’s back, if recent', async () => {
  const { maybePrintWaiting } = await import('../functions/api/_kid-print.js');
  const hub = pretendHub({ online: false });
  const head = itemOf(await view(), 'Rowan S.', 'Raincan Shower Head');
  const post = (body) => onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?receive=1', { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} }).then((r) => r.json());
  const old = tap();
  await receive(env.DB, { tap: old, jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 1 }, { now: new Date(Date.now() - 3 * 3600e3).toISOString() });
  const many = Array.from({ length: 8 }, () => ({ tap: tap(), jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, units: 1, boxes: 10 }));
  const r = await post({ items: many });
  assert.equal(r.print.queued, 80, 'said: they print when it’s back on');
  assert.deepEqual(hub.sent, [], 'nothing handed to a hub that holds only 60');
  assert.equal(await maybePrintWaiting(env), null, 'still off: nothing');
  hub.online = true;
  const p = await maybePrintWaiting(env);
  assert.equal(p.printed, 80, 'all 80 once it’s back');
  assert.deepEqual(hub.sent, [40, 40]);
  assert.equal(await maybePrintWaiting(env), null, 'and only once');
  const left = await env.DB.prepare("SELECT id FROM kid_receipts WHERE printed_at IS NULL AND kind = 'receive'").all();
  assert.deepEqual(left.results.map((x) => x.id), [old], 'a check-in from hours ago isn’t printed out of the blue (Print again is there)');
  delete env.PRINT_HUB;
});

test('round 4: a box back from the truck whose shelf is another kid’s now goes on a new one, and its label prints again', async () => {
  const { checkOut } = await import('../functions/api/_kid-record.js');
  const hub = pretendHub();
  const lamp = itemOf(await view(), 'Rowan S.', 'Cloud Pendant Light');
  const L = tap();
  await receive(env.DB, { tap: L, jobId: 'j-rowan', itemId: lamp.itemId, partKey: lamp.partKey, name: lamp.name, units: 1, boxes: 2, shelf: '1' });
  const outs = [(await checkOut(env.DB, { tap: tap(), ref: L, box: 1 })).receipt.id, (await checkOut(env.DB, { tap: tap(), ref: L, box: 2 })).receipt.id];
  const rug = itemOf(await view(), 'Ava E.', 'Round Rainbow Rug');
  await receive(env.DB, { tap: tap(), jobId: 'j-ava', itemId: rug.itemId, partKey: rug.partKey, name: rug.name, units: 1, boxes: 1, shelf: '1' });
  hub.sent.length = 0;
  const res = await onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?undo=1', { method: 'POST', body: JSON.stringify({ taps: [outs[1]] }) }), waitUntil: () => {} }).then((r) => r.json());
  assert.deepEqual([res.results[0].shelf, res.results[0].moved], ['2', true]);
  assert.deepEqual(hub.sent, [1], 'box 2’s label, with its new shelf');
  delete env.PRINT_HUB;
});

// ─── Allowances (Nov 11 2026): bought on top of the selections, next to the allowance it's bought under ───

/** A pretend Workers AI sorting things: each thing whose name matches `decor` goes on allowance 1, else none */
function sortingAi(decor = /Print|Frame/) {
  const ai = { asked: [] };
  ai.run = async (model, input) => {
    const user = input.messages[1].content;
    ai.asked.push(user);
    const things = user.split('Things:\n')[1].split('\n').filter(Boolean);
    return { response: { things: things.map((t, i) => ({ n: i + 1, allowance: decor.test(t) ? 1 : 0 })) } };
  };
  return ai;
}
const rowOf = (jt, key) => [...jt.items.entries()].map(([id, v]) => ({ id, ...v })).find((i) => i.globalId === key);

test('allowances: only a Selection & Allowance group’s template lines are allowances (not a labor line alike on every makeover)', async () => {
  await line('j-rowan', 'Rowan Sample (2026)', 'r-plumb', 'Plumbing Final', 'Plumbing Final', [part('Plumbing Final')], { group: '19 Plumbing', cents: 130000 });
  await line('j-ava', 'Ava Example (2026)', 'a-plumb', 'Plumbing Final', 'Plumbing Final', [part('Plumbing Final')], { group: '19 Plumbing', cents: 130000 });
  const v = await view();
  assert.deepEqual(kidOf(v, 'Rowan S.').allowances.map((a) => [a.line, a.cents]), [['Decor', 500000]]);
});

test('allowances: sorted onto the kid’s allowance, its line goes right after it (its codes, its words), and the allowance goes down by it', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await order('m9', 'Target', '2026-11-03T15:00:00Z', { kind: 'order', orderNumber: 'T9', jobPo: 'ROWAN', items: [{ name: 'Framed Wall Print', quantity: 2, price: '$22.50' }] });
  let v = await view();
  assert.equal(itemOf(v, 'Rowan S.', 'Framed Wall Print').also.pending, true, 'not sorted yet: nothing is made');
  const ids = await fieldIds(env, { fetchImpl: jt.fetch });
  const run = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual(run.errors, []);
  assert.match(env.AI.asked[0], /Allowances:\n1\. Decor: Books, wall art, shelves, decorative objects\n\nThings:\n1\. Bean Bag Chair, from Shop \(\$80\.00\)\n2\. Framed Wall Print, from Target \(\$22\.50\)/, 'one question for each kid’s things');
  v = await view();
  const print = itemOf(v, 'Rowan S.', 'Framed Wall Print');
  assert.deepEqual([print.line, print.also.allowItemId, print.also.pending], ['Decor allowance', 'r-decor', undefined]);
  const row = rowOf(jt, print.also.key);
  assert.deepEqual([row.name, row.costGroupId, row.positionAfter, row.quantity, row.unitCost, row.costCodeId, row.costTypeId, row.values[ids.also]],
    ['Decor: Framed Wall Print', 'g-sel-r', { type: 'costItem', id: 'r-decor' }, 2, 22.5, 'c-dec', 't-mat', false]);
  assert.match(row.description, /on the Decor allowance \(Target, order T9\): the allowance went down by it/);
  assert.deepEqual([jt.items.get('r-decor').unitCost, jt.items.get('r-decor').unitPrice], [4955, 4955], '$5,000 less 2 × $22.50');
  // The bean bag chair (the other order) is none of Rowan's allowances: Also bought
  const bean = rowOf(jt, itemOf(v, 'Rowan S.', 'Bean Bag Chair').also.key);
  assert.deepEqual([bean.name, bean.costGroupId === jt.groups.find((g) => g.name === 'Also bought').id, bean.values[ids.also]], ['Bean Bag Chair', true, true]);
  // Nothing new: nothing written, nothing asked again
  jt.calls.length = 0;
  const again = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual([again.made, again.kept || 0, again.allowances || 0, jt.calls.filter((c) => c === 'updateCostItem' || c === 'createCostItem').length, env.AI.asked.length], [0, 0, 0, 0, 1]);
  delete env.AI;
});

test('allowances: a person moves it to Also bought and back (its line moves, never remade); a hand edit to the allowance stands; cancelled, its line comes off', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await order('m9', 'Target', '2026-11-03T15:00:00Z', { kind: 'order', orderNumber: 'T9', jobPo: 'ROWAN', items: [{ name: 'Framed Wall Print', quantity: 2, price: '$22.50' }] });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  let print = itemOf(await view(), 'Rowan S.', 'Framed Wall Print');
  const rowId = print.also.costItemId;
  const alsoGroupId = () => jt.groups.find((g) => g.name === 'Also bought')?.id;
  // A person: it's Also bought, not decor
  await decide(env.DB, { orderKey: print.order.key, itemName: print.orderedAs, decision: { type: 'also', kid: 'j-rowan' } });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  print = itemOf(await view(), 'Rowan S.', 'Framed Wall Print');
  assert.equal(print.also.costItemId, rowId, 'the same line, moved');
  assert.deepEqual([jt.items.get(rowId).costGroupId, jt.items.get(rowId).name, jt.items.get('r-decor').unitCost], [alsoGroupId(), 'Framed Wall Print', 5000], 'in Also bought; the allowance back to $5,000');
  // And back onto the allowance
  await decide(env.DB, { orderKey: print.order.key, itemName: print.orderedAs, decision: { type: 'line', kid: 'j-rowan', itemId: 'r-decor', partKey: 'allow' } });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual([jt.items.get(rowId).costGroupId, jt.items.get(rowId).name, jt.items.get('r-decor').unitCost], ['g-sel-r', 'Decor: Framed Wall Print', 4955]);
  assert.equal([...jt.items.values()].filter((i) => /Framed Wall Print/.test(i.name || '')).length, 1, 'one line all along');
  // Someone raises the allowance in JobTread to $6,000: what they set is what's left, and the next thing comes off that
  Object.assign(jt.items.get('r-decor'), { unitCost: 6000, unitPrice: 6000 });
  await order('m10', 'Target', '2026-11-04T15:00:00Z', { kind: 'order', orderNumber: 'T10', jobPo: 'ROWAN', items: [{ name: 'Picture Frame', quantity: 1, price: '$10.00' }] });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.equal(jt.items.get('r-decor').unitCost, 5990);
  // The print's order cancelled: its line comes off, and the allowance is $45 more
  await order('m11', 'Target', '2026-11-05T15:00:00Z', { kind: 'cancelled', orderNumber: 'T9', items: [{ name: 'Framed Wall Print' }] });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.ok(jt.deleted.includes(rowId));
  assert.equal(jt.items.get('r-decor').unitCost, 6035);
  delete env.AI;
});

test('allowances: unsorted after three tries is Also bought; an allowance set by a formula is left alone; an Also bought line made before is moved, not remade', async () => {
  env.JOBTREAD_GRANT_KEY = 'test-key';
  const jt = fakeJobTread();
  // The AI answers nothing: asked again each run, Also bought after the third
  env.AI = { asked: 0, run: async () => { env.AI.asked++; return { response: { things: [] } }; } };
  let r = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.equal(r.made, 0, 'the bean bag chair waits to be sorted');
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  r = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.equal(r.made, 1, 'after three tries, Also bought');
  const bean = itemOf(await view(), 'Rowan S.', 'Bean Bag Chair');
  assert.equal(jt.items.get(bean.also.costItemId).costGroupId, jt.groups.find((g) => g.name === 'Also bought').id);
  // Sorted again later onto the decor allowance (say its sort is cleared): the same line moves next to it
  await env.DB.prepare("UPDATE kid_allow_class SET item_id = 'r-decor', how = 'site' WHERE key = ?").bind(bean.also.key).run();
  jt.items.get('r-decor').unitCostFormula = '5000';
  jt.calls.length = 0;
  r = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.deepEqual([r.errors, jt.calls.filter((c) => c === 'createCostItem').length], [[], 0], 'moved, not remade');
  assert.deepEqual([jt.items.get(bean.also.costItemId).costGroupId, jt.items.get(bean.also.costItemId).name], ['g-sel-r', 'Decor: Bean Bag Chair']);
  assert.equal(jt.items.get('r-decor').unitCost, 5000, 'a formula sets it: left as it is');
  delete env.AI;
});
