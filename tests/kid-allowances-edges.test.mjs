/**
 * Kid items: allowance lines' edge cases (functions/api/_kid-jt.js, _kid-allow.js, _kid-checkin.js), from the independent
 * review of Nov 11 2026. Made-up kids and a pretend JobTread only.
 */
// Scratch review tests for the allowance change (bd46314a). Run: node --test ux7/review.test.mjs (from scratchpad)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { checkinView } from '../functions/api/_kid-checkin.js';
import { receive, decide, typedIn } from '../functions/api/_kid-record.js';
import { writeKids, rehearse, settleAllowance, fieldIds, linesOf } from '../functions/api/_kid-jt.js';

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

// The test file's fake JobTread, plus hooks: before(q) may throw or wait; strict=true refuses positionAfter on update
function fakeJobTread({ before = null, strictMove = false } = {}) {
  const allowance = (group, cost = 5000, price = cost) => ({ name: 'Decor', quantity: 1, unitCost: cost, unitPrice: price, costGroupId: group, costCodeId: 'c-dec', costTypeId: 't-mat', values: {} });
  const jt = { fields: [], items: new Map([['r-shower', { values: {} }], ['a-rug', { values: {} }], ['r-decor', allowance('g-sel-r')], ['a-decor', allowance('g-sel-a')]]), groups: [], calls: [], n: 0, allowance };
  jt.fetch = async (url, init) => {
    const q = JSON.parse(init.body).query;
    const name = Object.keys(q).filter((k) => k !== '$')[0];
    jt.calls.push(name);
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

export { env, line, order, view, kidOf, itemOf, tap, fakeJobTread, sortingAi, rowOf, printOrder, ALLOWANCE, part };

// ─── 1. settleAllowance: the floor loses information; a later hand edit of one field inflates the other ───
test('allowance amounts: at $0, a person’s change to the price alone leaves the cost’s start as it was', async () => {
  const jt = fakeJobTread();
  jt.items.set('r-decor', jt.allowance('g-sel-r', 50, 50));
  await settleAllowance(env, 'j-rowan', 'r-decor', 8000, { fetchImpl: jt.fetch });
  assert.deepEqual([jt.items.get('r-decor').unitCost, jt.items.get('r-decor').unitPrice], [0, 0], 'floored');
  // A person sets only the price (say a markup) to $10
  jt.items.get('r-decor').unitPrice = 10;
  // Everything bought on it later moves away (spent 0): the cost should be back to its original $50
  const r = await settleAllowance(env, 'j-rowan', 'r-decor', 0, { fetchImpl: jt.fetch });
  assert.equal(jt.items.get('r-decor').unitCost, 50, `cost should be its original $50, got ${jt.items.get('r-decor').unitCost}`);
});

// ─── 2. A run cut short between the JobTread write and the D1 record: taken off twice, for good ───
test('allowance amounts: a run cut off after JobTread’s write never takes the money off twice', async () => {
  const jt = fakeJobTread();
  env.AI = sortingAi();
  await printOrder();
  // Fail the kid_allowances insert once, after JobTread was written
  const realPrepare = env.DB.prepare.bind(env.DB);
  let failOnce = true;
  env.DB.prepare = (sql) => {
    const st = realPrepare(sql);
    if (failOnce && /INSERT OR REPLACE INTO kid_allowances/.test(sql)) {
      return { ...st, bind: (...p) => ({ ...st.bind(...p), run: async () => { failOnce = false; throw new Error('D1_ERROR: Network connection lost'); } }) };
    }
    return st;
  };
  const r1 = await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  await writeKids(env, { fetchImpl: jt.fetch, mode: 'on' });
  assert.equal(jt.items.get('r-decor').unitCost, 4920);
  delete env.AI;
});

// ─── 3. Two writes at once (decide fires writeKidNow for the kid twice; heartbeat overlap) ───
test('allowance amounts: two runs at once, one a JobTread call behind, take it off once', async () => {
  const jt = fakeJobTread();
  jt.items.set('r-decor', jt.allowance('g-sel-r', 500, 500));
  // R1's update lands in JobTread at once but its answer comes back only after R2 has read the allowance
  let release; const gate = new Promise((r) => { release = r; });
  let r1Updated = false;
  const f1 = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.updateCostItem) { const res = await jt.fetch(url, init); r1Updated = true; await gate; return res; }
    return jt.fetch(url, init);
  };
  const f2 = async (url, init) => {
    const q = JSON.parse(init.body).query;
    const res = await jt.fetch(url, init);
    if (q.updateCostItem) setTimeout(release, 0);
    return res;
  };
  const p1 = settleAllowance(env, 'j-rowan', 'r-decor', 4500, { fetchImpl: f1 });
  while (!r1Updated) await new Promise((r) => setTimeout(r, 1));
  const p2 = settleAllowance(env, 'j-rowan', 'r-decor', 4500, { fetchImpl: f2 }).finally(() => release());
  const st = await env.DB.prepare('SELECT * FROM kid_allowances').first();
  assert.equal(jt.items.get('r-decor').unitCost, 455, `$500 less $45 once; got ${jt.items.get('r-decor').unitCost}`);
});
