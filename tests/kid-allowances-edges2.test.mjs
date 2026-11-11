/**
 * Kid items: allowance lines' edge cases, part 2 (the view, older check-ins, lines deleted by hand, the rehearsal).
 * Made-up kids and a pretend JobTread only.
 */
// Scratch review tests, part 2: the view, migration, rows deleted by hand, the rehearsal
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { checkinView } from '../functions/api/_kid-checkin.js';
import { receive, decide, typedIn, decisionKey } from '../functions/api/_kid-record.js';
import { writeKids, rehearse, fieldIds, linesOf, makeAlso } from '../functions/api/_kid-jt.js';

let env;
const part = (name, extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source: 'buy', key: `name:${name.toLowerCase()}`, ...extra });
async function line(jobId, jobName, itemId, lineName, words, parts, { group = 'G', cents = 100, readBy = 'ai' } = {}) {
  await env.DB.prepare('INSERT OR REPLACE INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, group, lineName, cents, `h${itemId}`, JSON.stringify(parts), readBy, '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
const ALLOWANCE = { group: 'Bedroom Makeover Selection & Allowance', cents: 500000 };
async function order(id, store, at, read) {
  await env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, state, read) VALUES ('pat@soardcharity.com', ?, ?, ?, ?, 'read', ?)").bind(id, at, store, read.kind, JSON.stringify(read)).run();
}
const view = () => checkinView(env, { photos: false });
const kidOf = (v, short) => v.kids.find((k) => k.short === short);
const itemOf = (v, short, name) => kidOf(v, short)?.items.find((i) => i.name === name);
let taps = 0;
const tap = () => `tap-rev-${String(++taps).padStart(4, '0')}`;

beforeEach(async () => {
  env = { DB: await createD1(), JOBTREAD_GRANT_KEY: 'k' };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-shower', 'Shower System', 'Raincan Shower Head 52214-CZ, two valves', [part('Raincan Shower Head', { model: '52214-CZ' }), part('Shower Valve', { quantity: 2 })]);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')], ALLOWANCE);
  await line('j-ava', 'Ava Example (2026)', 'a-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')], ALLOWANCE);
  await line('j-ava', 'Ava Example (2026)', 'a-rug', 'Rug', 'Round Rainbow Rug', [part('Round Rainbow Rug')]);
});

function fakeJobTread({ before = null, strictMove = false } = {}) {
  const allowance = (group, cost = 5000, price = cost) => ({ name: 'Decor', quantity: 1, unitCost: cost, unitPrice: price, costGroupId: group, costCodeId: 'c-dec', costTypeId: 't-mat', values: {} });
  const jt = { fields: [], items: new Map([['r-shower', { values: {} }], ['a-rug', { values: {} }], ['r-decor', allowance('g-sel-r')], ['a-decor', allowance('g-sel-a')]]), groups: [], calls: [], n: 0, allowance };
  jt.fetch = async (url, init) => {
    const q = JSON.parse(init.body).query;
    const name = Object.keys(q).filter((k) => k !== '$')[0];
    jt.calls.push(name === 'costItem' ? `costItem:${q.costItem.$.id}` : name);
    if (before) await before(q, name, jt);
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (q.organization?.customFields) return ok({ organization: { customFields: { nodes: jt.fields } } });
    if (q.organization?.costTypes) return ok({ organization: { costTypes: { nodes: [{ id: 't-mat', name: 'Materials' }] } } });
    if (q.organization?.costCodes) return ok({ organization: { costCodes: { nodes: [{ id: 'c-fur', name: 'Furnishings', number: '1200' }] } } });
    if (q.createCustomField) { const f = { id: `f-${++jt.n}`, ...q.createCustomField.$ }; jt.fields.push(f); return ok({ createCustomField: { createdCustomField: { id: f.id } } }); }
    if (q.job?.costItems) { const gid = q.job.costItems.$.where[2]; const hit = [...jt.items].find(([, v]) => v.globalId === gid); return ok({ job: { costItems: { nodes: hit ? [{ id: hit[0] }] : [] } } }); }
    if (q.job?.costGroups) { const nm = q.job.costGroups.$.where?.and?.[0]?.[2]; const g = jt.groups.find((x) => x.jobId === q.job.$.id && (!nm || x.name === nm)); return ok({ job: { costGroups: { nodes: g ? [{ id: g.id }] : [] } } }); }
    if (q.createCostGroup) { const g = { id: `g-${++jt.n}`, ...q.createCostGroup.$ }; jt.groups.push(g); return ok({ createCostGroup: { createdCostGroup: { id: g.id } } }); }
    if (q.createCostItem) { const id = `ci-${++jt.n}`; jt.items.set(id, { ...q.createCostItem.$, values: { ...(q.createCostItem.$.customFieldValues || {}) } }); return ok({ createCostItem: { createdCostItem: { id } } }); }
    if (q.costItem) {
      const it = jt.items.get(q.costItem.$.id);
      return ok({ costItem: it ? { id: q.costItem.$.id, name: it.name, quantity: it.quantity, unitCost: it.unitCost, unitPrice: it.unitPrice, unitCostFormula: it.unitCostFormula ?? null, unitPriceFormula: null,
        costGroup: { id: it.costGroupId }, costCode: { id: it.costCodeId }, costType: { id: it.costTypeId },
        customFieldValues: { nodes: Object.entries(it.values).filter(([, v]) => v !== null).map(([fid, value]) => ({ value, customField: { id: fid } })) } } : null });
    }
    if (q.updateCostItem) {
      const { id, customFieldValues, ...rest } = q.updateCostItem.$;
      if (strictMove && rest.positionAfter) return new Response('positionAfter refused on update', { status: 400 });
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
const printOrder = () => order('m9', 'Target', '2026-11-03T15:00:00Z', { kind: 'order', orderNumber: 'T9', jobPo: 'ROWAN', items: [{ name: 'Framed Wall Print', quantity: 1, price: '$80.00' }] });

// ─── 4. An allowance is an allowance only while another open makeover has the same words ───
test('allowances stay the kid’s when another makeover with the same words closes', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await printOrder();
  await order('m10', 'Target', '2026-11-04T15:00:00Z', { kind: 'order', orderNumber: 'T10', jobPo: 'ROWAN', items: [{ name: 'Wall Shelf', quantity: 1, price: '$30.00' }] });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  let v = await view();
  const shelf = itemOf(v, 'Rowan S.', 'Wall Shelf');
  // A person put the shelf on the Decor allowance
  await decide(env.DB, { orderKey: shelf.order.key, itemName: shelf.orderedAs, decision: { type: 'line', kid: 'j-rowan', itemId: 'r-decor', partKey: 'allow' } });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  v = await view();
  const printRow = itemOf(v, 'Rowan S.', 'Framed Wall Print').also.costItemId;
  const shelfKey = itemOf(v, 'Rowan S.', 'Wall Shelf').also.key;
  const shelfRow = itemOf(v, 'Rowan S.', 'Wall Shelf').also.costItemId;
  assert.equal(jt.items.get('r-decor').unitCost, 4890);
  // Ava's makeover is finished: the selection reader drops her lines
  await env.DB.prepare("DELETE FROM kid_parts WHERE job_id = 'j-ava'").run();
  const r = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  v = await view();
  assert.equal(kidOf(v, 'Rowan S.').allowances.length, 1);
  assert.ok(jt.items.has(shelfRow), 'the line a person put on the allowance stays');
  assert.equal(jt.items.get('r-decor').unitCost, 4890, 'Rowan’s own Decor allowance and its rows shouldn’t change because Ava’s job closed');
  delete env.AI;
});

// ─── 5. Live migration: a person's 'allow' answer from before this change, checked in on the old part ───
test('a check-in made on an allowance by the older page stays with its thing', async () => {
  await order('m2', 'Rug Store', '2026-11-01T15:00:00Z', { kind: 'order', orderNumber: 'B2', jobPo: 'ROWEN', items: [{ name: 'Framed Print' }] });
  let v = await view();
  const look = v.needsLook.find((o) => o.orderNumber === 'B2');
  await decide(env.DB, { orderKey: look.key, itemName: 'Framed Print', decision: { type: 'line', kid: 'j-ava', itemId: 'a-decor', partKey: 'allow' } });
  // The old code's item for that answer was { itemId: 'a-decor', partKey: `allow:${decisionKey(...)}` }; its check-in names those
  const oldPart = `allow:${decisionKey(look.key, 'Framed Print')}`;
  await receive(env.DB, { tap: tap(), jobId: 'j-ava', itemId: 'a-decor', partKey: oldPart, name: 'Framed Print', line: 'Decor', units: 1, boxes: 1 });
  v = await view();
  const things = kidOf(v, 'Ava E.').items.filter((i) => /Framed Print/.test(i.name)).map((i) => ({ id: i.id, line: i.line, status: i.status, also: Boolean(i.also), gone: i.gone }));
  const lines = linesOf(v).filter((l) => l.jobId === 'j-ava').map((l) => [l.itemId, l.items.map((i) => `${i.name}:${i.status}`)]);
  assert.equal(things.length, 1, 'one thing, checked in');
});

// ─── 6. A row deleted by hand in JobTread ───
test('a line a person deleted in JobTread stays off, and its allowance gets the money back', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await printOrder();
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const row = itemOf(await view(), 'Rowan S.', 'Framed Wall Print').also.costItemId;
  assert.equal(jt.items.get('r-decor').unitCost, 4920);
  jt.items.delete(row);
  for (let i = 0; i < 3; i++) await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  // Then the person moves it to Also bought: an error every run
  const p = itemOf(await view(), 'Rowan S.', 'Framed Wall Print');
  await decide(env.DB, { orderKey: p.order.key, itemName: p.orderedAs, decision: { type: 'also', kid: 'j-rowan' } });
  const r = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const r2 = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.ok(rowOf(jt, p.also.key) || jt.items.get('r-decor').unitCost === 5000, 'either the row is back, or the allowance isn’t down by a row that isn’t there');
  delete env.AI;
});

// ─── 7. Rehearsal: one failure after the move leaves the sandbox row in Also bought; every rehearsal after fails ───
test('the rehearsal cleans up after one cut off half-way', async () => {
  let n = 0;
  // A JobTread hiccup on the update that gives the allowance back (the 2nd settle), once
  const bad = fakeJobTread({ before: async (q) => { if (q.updateCostItem?.$?.unitCost === 500 && q.updateCostItem.$.id && ++n === 1) throw new Error('JobTread 503'); } });
  const r1 = await rehearse(env, { fetchImpl: bad.fetch, now: '2026-11-11T20:00:00Z' });
  // JobTread is fine again: the same sandbox, a healthy JobTread
  const good = { ...bad }; good.fetch = fakeJobTread().fetch;
  // reuse the same store: rebuild a fake over the same items
  const healthy = fakeJobTread(); healthy.items = bad.items; healthy.groups = bad.groups; healthy.fields = bad.fields;
  const fetch2 = async (url, init) => healthy.fetch(url, init);
  // (healthy.fetch closes over its own jt object, whose items we replaced)
  const r2 = await rehearse(env, { fetchImpl: fetch2, now: '2026-11-11T20:30:00Z' });
  const r3 = await rehearse(env, { fetchImpl: fetch2, now: '2026-11-11T21:00:00Z' });
  assert.equal(r2.ok, true, 'JobTread is healthy again, the rehearsal should pass');
});

// ─── 8. Rehearsal never moves a line onto an allowance (the migration's call) ───
test('the rehearsal proves a line moved next to its allowance by an update', async () => {
  const jt = fakeJobTread({ strictMove: true });
  const r = await rehearse(env, { fetchImpl: jt.fetch, now: '2026-11-11T20:00:00Z' });
  // A row made before the change in Also bought, now sorted onto Decor
  env.AI = { run: async () => { throw new Error('off'); } };
  const ids = await fieldIds(env, { fetchImpl: jt.fetch });
  await printOrder();
  env.AI = sortingAi(/$^/); // sorts nothing onto Decor, so it's made in Also bought
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const p = itemOf(await view(), 'Rowan S.', 'Framed Wall Print');
  await env.DB.prepare("UPDATE kid_allow_class SET item_id = 'r-decor', how = 'site' WHERE key = ?").bind(p.also.key).run();
  const run = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.ok(!(r.ok && run.errors.length), 'the rehearsal passed but the call the live move makes failed');
  delete env.AI;
});

// ─── 9. Typed in for a kid whose lines aren't all read: it used to be made at once; now it waits ───
test('something typed in is sorted and made even while a line is unread', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await line('j-rowan', 'Rowan Sample (2026)', 'r-lamp', 'Lighting', 'Two lamps, see link', [], { readBy: 'none:1' });
  await typedIn(env.DB, { tap: tap(), jobId: 'j-rowan', name: 'Bean bag cover', cents: 2500, units: 1, boxes: 1 });
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' }));
  const it = itemOf(await view(), 'Rowan S.', 'Bean bag cover');
  assert.ok(it.also.costItemId, 'a typed thing used to be made even while a line was unread (the code says so: `&& !it.also.typed`)');
  delete env.AI;
});

// ─── 10. A row taken off (allowance changed, a person answers again): never made again ───
test('a line taken off and answered again is made again', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi(/$^/);
  await order('m10', 'Target', '2026-11-04T15:00:00Z', { kind: 'order', orderNumber: 'T10', jobPo: 'ROWAN', items: [{ name: 'Wall Shelf', quantity: 1, price: '$30.00' }] });
  let v = await view();
  const shelf = itemOf(v, 'Rowan S.', 'Wall Shelf');
  await decide(env.DB, { orderKey: shelf.order.key, itemName: shelf.orderedAs, decision: { type: 'line', kid: 'j-rowan', itemId: 'r-decor', partKey: 'allow' } });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const key = itemOf(await view(), 'Rowan S.', 'Wall Shelf').also.key;
  const first = rowOf(jt, key);
  assert.ok(first);
  // The designer replaces the Decor allowance line in JobTread (a new line id); the reader picks it up
  await env.DB.prepare("DELETE FROM kid_parts WHERE item_id = 'r-decor'").run();
  await line('j-rowan', 'Rowan Sample (2026)', 'r-decor2', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')], ALLOWANCE);
  jt.items.set('r-decor2', jt.allowance('g-sel-r'));
  const r1 = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  v = await view();
  // The person answers again: the new Decor line
  await decide(env.DB, { orderKey: shelf.order.key, itemName: shelf.orderedAs, decision: { type: 'line', kid: 'j-rowan', itemId: 'r-decor2', partKey: 'allow' } });
  const r2 = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const r3 = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  v = await view();
  assert.ok(rowOf(jt, key), 'its row should be on the budget again');
  delete env.AI;
});

// ─── 11. An allowance gone from JobTread or set by a formula: read again on every run, forever ───
test('an allowance gone or set by a formula isn’t read again until what’s bought on it changes', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await printOrder();
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  jt.items.get('r-decor').unitCostFormula = '5000';
  const p = itemOf(await view(), 'Rowan S.', 'Framed Wall Print');
  await decide(env.DB, { orderKey: p.order.key, itemName: p.orderedAs, decision: { type: 'also', kid: 'j-rowan' } });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const reads = [];
  for (let i = 0; i < 3; i++) { jt.calls.length = 0; await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' }); reads.push(jt.calls.filter((c) => c === 'costItem:r-decor').length); }
  assert.deepEqual(reads, [0, 0, 0]);
  delete env.AI;
});

// ─── 12. "Something else" for a kid with allowances: the page says "Received in JobTread" with nothing in JobTread ───
test('something typed in waiting to be sorted is never said to be in JobTread', async () => {
  const { onRequestPost } = await import('../functions/api/kid-items-admin.js');
  const { writeState } = await import('../functions/api/_kid-record.js');
  const jt = fakeJobTread();
  const realFetch = globalThis.fetch;
  globalThis.fetch = jt.fetch; // never the real JobTread
  try {
    await writeState(env.DB, 'jt', { rehearsal: { ok: true, v: 5 } });
    const res = await onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?other=1', { method: 'POST', body: JSON.stringify({ tap: tap(), jobId: 'j-rowan', name: 'Bean bag cover', cents: 2500, units: 1, boxes: 1 }) }), waitUntil: () => {} });
    const body = await res.json();
    const it = body.view.kids.find((k) => k.short === 'Rowan S.').items.find((i) => i.name === 'Bean bag cover');
    assert.notEqual(body.jt, 'written', 'nothing is in JobTread yet');
  } finally { globalThis.fetch = realFetch; }
});

// ─── 13. Part of an order cancelled: each thing on an allowance is asked about with "Also bought" as where it is now ───
test('part of an order cancelled: a thing on an allowance shows as on that allowance', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await order('m9', 'Target', '2026-11-03T15:00:00Z', { kind: 'order', orderNumber: 'T9', jobPo: 'ROWAN', items: [{ name: 'Framed Wall Print', price: '$20.00' }, { name: 'Picture Frame', price: '$10.00' }] });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.equal(jt.items.get('r-decor').unitCost, 4970);
  await order('m11', 'Target', '2026-11-05T15:00:00Z', { kind: 'cancelled', orderNumber: 'T9', items: [{ name: 'Picture Frame' }] });
  const v = await view();
  const look = v.needsLook.find((o) => o.orderNumber === 'T9');
  // The cancel names the frame: it's what's asked about (the print, not named, stays on the allowance unasked)
  assert.deepEqual(look.items.map((i) => i.name), ['Picture Frame']);
  assert.equal(look.items[0].current, 'allow:r-decor', 'it is on the Decor allowance now; the sheet pre-selects `current`');
  delete env.AI;
});

// ─── Nov 11 (review): a Selection & Allowance line with picks in it stays a selection after a JobTread run ───
test('after a JobTread run, a Selection & Allowance line with the designer’s picks is still matched to orders (only lines alike on every makeover are kept as allowances)', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await line('j-ava', 'Ava Example (2026)', 'a-bed', 'Bedding', 'Stripe Duvet Cover = $129', [part('Stripe Duvet Cover')], ALLOWANCE);
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  const kept = (await env.DB.prepare("SELECT item_id FROM kid_allow_lines WHERE job_id = 'j-ava' ORDER BY item_id").all()).results.map((r) => r.item_id);
  assert.deepEqual(kept, ['a-decor'], 'Decor (alike on both makeovers) is kept; Bedding (with a pick) isn’t');
  const v = await view();
  assert.ok(itemOf(v, 'Ava E.', 'Stripe Duvet Cover'), 'its pick is still a thing to order and check in');
  assert.deepEqual(kidOf(v, 'Ava E.').allowances.map((a) => a.line).sort(), ['Bedding', 'Decor'], 'and both are allowances for things bought on top');
  delete env.AI;
});
