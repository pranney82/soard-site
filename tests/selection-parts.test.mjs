/**
 * Kid items, step 2: each open makeover's chosen selections as parts (functions/api/_selection-parts.js)
 * Run: node --test tests/selection-parts.test.mjs
 *
 * Read only: JobTread is queried, Workers AI splits lines with several
 * products in them, D1 keeps the parts. Made-up jobs, lines and products.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  maybeReadSelections, selectionPartsStatus, simpleParts, sourceOf, partKey, lineHash, wordsKey, PARTS_SCHEMA,
} from '../functions/api/_selection-parts.js';

const T0 = Date.parse('2026-11-12T15:00:00Z'); // after MISSED_BEFORE, so a miss waits its six hours
const MIN = 60e3;
let env, jobs, lines, calls, aiParts, aiCap;
const realFetch = globalThis.fetch;

const SHOWER = {
  id: 'ci-shower', name: 'Shower System', cost: 746.57, quantity: 1, group: 'Bathroom Selections',
  description: 'Hand Shower: 7-Setting Slide Bar Hand Shower *$183.90*\nhttps://faucets.example/hand-shower-51584\nShower Head: Raincan Shower Head\nModel#: 52214-CZ = *$273.90*\nhttps://faucets.example/52214',
};

beforeEach(async () => {
  calls = []; aiCap = false;
  jobs = [
    { id: 'job-rowan', name: 'Rowan Sample (2026)', status: 'Build' },
    { id: 'job-done', name: 'Finished Kid (2025)', status: 'Closed Done' },
    { id: 'job-test', name: 'TEST Applicant (2026)', status: 'Design' },
  ];
  lines = {
    'job-rowan': [
      { id: 'ci-paint', name: 'Paint', cost: 0, quantity: 1, group: 'Bathroom Selections', description: 'Trim, walls & ceiling' },
      { id: 'ci-sink', name: 'Vanity Sink', cost: 0, quantity: 1, group: 'Bathroom Selections', description: 'White Rectangular Sink Donated' },
      SHOWER,
      { id: 'ci-tile', name: 'Floor Tile', cost: 0, quantity: 1, group: 'Bathroom Selections', description: 'Porcelain Tile 12x24\nID#: TILE1224\nGrout: Ivory\nhttps://tile.example/porcelain\nhttps://tile.example/grout' },
    ],
  };
  aiParts = {
    'Shower System': [
      { name: '7-Setting Slide Bar Hand Shower', brand: '', model: '', link: 'https://faucets.example/hand-shower-51584', quantity: 1, price: '$183.90', source: 'buy' },
      { name: 'Raincan Shower Head', brand: '', model: '52214-CZ', link: 'https://made-up.example/not-in-the-line', quantity: 1, price: '$273.90', source: 'buy' },
    ],
    'Floor Tile': [{ name: 'Porcelain Tile 12x24', brand: '', model: 'TILE1224', link: 'https://tile.example/porcelain', quantity: 1, price: '', source: 'buy' }],
  };
  env = {
    DB: await createD1(), JOBTREAD_GRANT_KEY: 'grant-main',
    AI: { run: async (model, { messages }, opts) => {
      const name = /Line: (.*)/.exec(messages[1].content)?.[1] || '';
      calls.push({ kind: 'ai', name, feature: opts?.gateway?.metadata?.feature });
      if (aiCap) throw new Error('2045: spend limit reached');
      return { response: { parts: aiParts[name] || [] } };
    } },
  };
  globalThis.fetch = async function (input, init = {}) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    const url = String(input);
    if (url !== 'https://api.jobtread.com/pave') throw new Error(`unexpected fetch ${url}`);
    const { query } = JSON.parse(init.body);
    if (query.organization?.jobs) {
      calls.push({ kind: 'jobs' });
      return Response.json({ organization: { jobs: { nextPage: null, nodes: jobs.map((j) => ({ id: j.id, name: j.name, customFieldValues: { nodes: [{ value: j.status }] } })) } } });
    }
    if (query.job?.costItems) {
      const id = query.job.$.id;
      calls.push({ kind: 'lines', job: id, where: query.job.costItems.$.where });
      return Response.json({ job: { costItems: { nextPage: null, nodes: (lines[id] || []).map((l) => ({
        id: l.id, name: l.name, description: l.description, cost: l.cost, quantity: l.quantity, isSelected: l.isSelected ?? true,
        costType: { name: l.costType || 'Materials' }, costGroup: { name: l.group, maxSelectionsAllowed: l.choice ? 20 : null, minSelectionsRequired: l.choice ? 0 : null, parentCostGroup: null },
      })) } } });
    }
    throw new Error(`unexpected query ${JSON.stringify(query).slice(0, 80)}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const parts = async (item) => JSON.parse((await env.DB.prepare('SELECT parts FROM kid_parts WHERE item_id = ?').bind(item).first())?.parts || 'null');

test('where a part comes from: donated, the family’s, someone else’s, bought', () => {
  assert.equal(sourceOf('White Sink Donated', '', 0), 'donated');
  assert.equal(sourceOf('Records (supplied by family)', '', 40000), 'family');
  assert.equal(sourceOf('Installed by the fabricator', '', 0), 'others');
  assert.equal(sourceOf('LVP', 'Flooring LVP', 0), 'others', 'a $0 line is someone else’s');
  assert.equal(sourceOf('Sink', 'Vanity Sink: donated by a partner', 0), 'donated', 'unless the line says donated');
  assert.equal(sourceOf('Sconce', 'Lighting', 99700), 'buy');
});

test('a part’s matching key: model, then the link’s product id, then the name', () => {
  assert.equal(partKey({ model: '52214-CZ' }), 'model:52214-CZ');
  assert.equal(partKey({ link: 'https://www.wayfair.com/x/pdp/vanity-w118123869.html' }), 'link:w118123869');
  assert.equal(partKey({ link: 'https://www.amazon.com/dp/B07ABCDEF1' }), 'link:B07ABCDEF1');
  assert.equal(partKey({ name: 'Brass Sconce, Large' }), 'name:brass sconce large');
});

test('a plain line needs no reading; one with several products does', () => {
  assert.deepEqual(simpleParts({ name: 'Paint', description: 'Trim, walls & ceiling', cost: 0, quantity: 1 }).map((p) => [p.name, p.source]), [['Paint: Trim, walls & ceiling', 'others']]);
  assert.equal(simpleParts(SHOWER), null);
  assert.equal(lineHash(SHOWER), lineHash({ ...SHOWER }));
  assert.notEqual(lineHash(SHOWER), lineHash({ ...SHOWER, cost: 700 }));
});

test('open makeovers’ chosen lines become parts; finished and TEST jobs stay out; nothing is written to JobTread', async () => {
  await maybeReadSelections(env, { now: T0, force: true });
  assert.deepEqual(calls.filter((c) => c.kind === 'lines').map((c) => c.job), ['job-rowan']);
  assert.deepEqual(calls.find((c) => c.kind === 'lines').where, [['document', 'id'], '=', null], 'the budget’s lines (not documents’)');
  assert.deepEqual((await parts('ci-paint')).map((p) => p.source), ['others']);
  assert.deepEqual((await parts('ci-sink')).map((p) => p.source), ['donated']);
  const shower = await parts('ci-shower');
  assert.deepEqual(shower.map((p) => [p.name, p.source, p.cents]), [['7-Setting Slide Bar Hand Shower', 'buy', 18390], ['Raincan Shower Head', 'buy', 27390]]);
  assert.equal(shower[1].link, '', 'a link the line doesn’t have is dropped');
  assert.equal(shower[1].key, 'model:52214-CZ');
  assert.deepEqual((await parts('ci-tile')).map((p) => p.source), ['others'], 'a $0 line read by the AI is still someone else’s');
  assert.deepEqual(calls.filter((c) => c.kind === 'ai').map((c) => [c.name, c.feature]), [['Shower System', 'kid-parts'], ['Floor Tile', 'kid-parts']]);
});

test('a line is read again only when it changes, and leaves when it’s no longer chosen', async () => {
  await maybeReadSelections(env, { now: T0, force: true });
  calls.length = 0;
  await maybeReadSelections(env, { now: T0 + MIN, force: true });
  assert.equal(calls.filter((c) => c.kind === 'ai').length, 0, 'nothing changed, nothing read');
  lines['job-rowan'] = lines['job-rowan'].filter((l) => l.id !== 'ci-tile').map((l) => (l.id === 'ci-shower' ? { ...l, description: `${l.description}\nArm: 16" Shower Arm =*$54.08*` } : l));
  aiParts['Shower System'] = [...aiParts['Shower System'], { name: '16" Shower Arm', brand: '', model: '', link: '', quantity: 1, price: '$54.08', source: 'buy' }];
  await maybeReadSelections(env, { now: T0 + 2 * MIN, force: true });
  assert.deepEqual(calls.filter((c) => c.kind === 'ai').map((c) => c.name), ['Shower System']);
  assert.equal((await parts('ci-shower')).length, 3);
  assert.equal(await parts('ci-tile'), null, 'the tile line was taken off');
});

test('a spending cap: the lines wait for the next run and the reader rests', async () => {
  aiCap = true;
  const st = await maybeReadSelections(env, { now: T0, force: true });
  assert.ok(st.aiRestUntil > T0);
  assert.equal(await parts('ci-shower'), null);
  assert.ok(st.behind);
  aiCap = false;
  // Resting: nothing happens until the rest is over, even when it's due
  calls.length = 0;
  await maybeReadSelections(env, { now: T0 + 2 * MIN });
  assert.equal(calls.length, 0);
  await maybeReadSelections(env, { now: st.aiRestUntil + MIN });
  assert.equal((await parts('ci-shower')).length, 2);
});

test('Automations: lines and parts per makeover, by where they come from', async () => {
  await maybeReadSelections(env, { now: T0, force: true });
  const s = await selectionPartsStatus(env, { detail: true });
  assert.equal(s.firstPassDone, true);
  const j = s.jobs.find((x) => x.id === 'job-rowan');
  assert.deepEqual([j.lines, j.parts, j.buy, j.donated, j.others], [4, 5, 2, 1, 2]);
  assert.equal(j.list.find((l) => l.line === 'Shower System').parts.length, 2);
});

test('the AI’s answer shape requires every field', () => {
  const item = PARTS_SCHEMA.properties.parts.items;
  assert.deepEqual(item.required.sort(), Object.keys(item.properties).sort());
  assert.deepEqual(PARTS_SCHEMA.required, ['parts']);
});

test('without JobTread’s key it does nothing; it never throws', async () => {
  assert.equal(await maybeReadSelections({ DB: env.DB }), null);
  globalThis.fetch = async () => { throw new Error('JobTread down'); };
  assert.equal(await maybeReadSelections(env, { now: T0, force: true }), null);
  assert.match((await selectionPartsStatus(env)).error, /JobTread down/);
});

test('the admin read-out: orders and parts together, read-only', async () => {
  const { onRequestGet, onRequestPost } = await import('../functions/api/kid-items-admin.js');
  await maybeReadSelections(env, { now: T0, force: true });
  const res = await onRequestGet({ env, request: new Request('https://site.example/api/kid-items-admin') });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.orders.watching, true);
  assert.equal(body.parts.jobs[0].list.length, 4);
  // Its one POST reads a box's label at check-in; anything else changes nothing
  const other = await onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin', { method: 'POST', body: '{}' }) });
  assert.equal(other.status, 400);
});

test('review fix: a line the AI can’t split doesn’t hold up the other makeovers, and is tried again only a few times', async () => {
  jobs = [
    { id: 'job-a', name: 'Kid A (2026)', status: 'Build' },
    { id: 'job-b', name: 'Kid B (2026)', status: 'Design' },
  ];
  lines = { 'job-a': [SHOWER], 'job-b': [{ id: 'ci-b', name: 'Paint', cost: 0, quantity: 1, group: 'G', description: 'Walls' }] };
  aiParts = {};
  await maybeReadSelections(env, { now: T0, force: true });
  assert.deepEqual(await parts('ci-shower'), [], 'the miss is kept against the line');
  assert.equal((await parts('ci-b')).length, 1, 'the next makeover is still read');
  const st = await selectionPartsStatus(env);
  assert.equal(st.jobs.find((j) => j.id === 'job-a').unread, 1);
  calls.length = 0;
  await maybeReadSelections(env, { now: T0 + 60 * MIN, force: true });
  assert.equal(calls.filter((c) => c.kind === 'ai').length, 0, 'not asked again within six hours');
  for (let i = 1; i <= 4; i++) await maybeReadSelections(env, { now: T0 + i * 7 * 60 * MIN, force: true });
  assert.equal(calls.filter((c) => c.kind === 'ai').length, 2, 'three tries in all, then left until the line changes');
});

test('review fix: every open makeover is looked at each run; a closed one leaves the list', async () => {
  jobs = Array.from({ length: 8 }, (_, i) => ({ id: `job-${i}`, name: `Kid ${i} (2026)`, status: 'Build' }));
  lines = Object.fromEntries(jobs.map((j) => [j.id, [{ id: `ci-${j.id}`, name: 'Paint', cost: 0, quantity: 1, group: 'G', description: 'Walls' }]]));
  await maybeReadSelections(env, { now: T0, force: true });
  assert.equal((await selectionPartsStatus(env)).jobs.length, 8);
  jobs = jobs.slice(1);
  await maybeReadSelections(env, { now: T0 + 30 * MIN, force: true });
  assert.equal((await selectionPartsStatus(env)).jobs.length, 7, 'the closed makeover’s parts are gone');
  jobs = [];
  const st = await maybeReadSelections(env, { now: T0 + 60 * MIN, force: true });
  assert.equal(st.runningUntil, 0);
  assert.equal(st.error, null);
  assert.equal((await selectionPartsStatus(env)).jobs.length, 0);
});

test('second review: a pass over many makeovers spans runs, then rests', async () => {
  jobs = Array.from({ length: 6 }, (_, i) => ({ id: `job-${i}`, name: `Kid ${i} (2026)`, status: 'Build' }));
  lines = Object.fromEntries(jobs.map((j) => [j.id, [{ ...SHOWER, id: `ci-${j.id}` }]]));
  aiParts['Shower System'] = [{ name: 'Hand Shower', brand: '', model: '', link: '', quantity: 1, price: '', source: 'buy' }];
  // Eight AI turns a run: six lines to split fit in one
  let st = await maybeReadSelections(env, { now: T0, force: true });
  assert.equal(st.behind, false, 'six lines fit one run');
  // Ten jobs with a changed line each: the eight AI turns run out, the pass goes on next run
  jobs = Array.from({ length: 10 }, (_, i) => ({ id: `job-${i}`, name: `Kid ${i} (2026)`, status: 'Build' }));
  lines = Object.fromEntries(jobs.map((j) => [j.id, [{ ...SHOWER, id: `ci-${j.id}`, description: `${SHOWER.description}\nchanged` }]]));
  st = await maybeReadSelections(env, { now: T0 + 30 * MIN, force: true });
  assert.equal(st.behind, true);
  assert.ok(st.passLeft > 0);
  st = await maybeReadSelections(env, { now: T0 + 31 * MIN });
  assert.equal(st.behind, false, 'the pass finished on the next run');
  assert.equal(st.firstPassDone, true);
  assert.equal((await selectionPartsStatus(env)).jobs.length, 10);
  const later = await maybeReadSelections(env, { now: T0 + 32 * MIN });
  assert.equal(later, null, 'and it rests until the next 30 minutes');
});

test('gate 2: "Provided by" or "Supplied by" anyone is someone else’s; the line’s words are kept for matching', async () => {
  assert.equal(sourceOf('Mirror: Provided by a glass partner', 'Mirror', 15000), 'others');
  assert.equal(sourceOf('Countertop: Supplied by a stone partner', 'Countertop', 0), 'others');
  assert.equal(sourceOf('Records (supplied by family)', '', 40000), 'family', 'the family’s own is still the family’s');
  assert.equal(wordsKey('Perfect Stripe, Beige https://shop.example/x *$352.00*'), 'perfect stripe beige');
  await maybeReadSelections(env, { now: T0, force: true });
  const row = await env.DB.prepare("SELECT words, words_key FROM kid_parts WHERE item_id = 'ci-shower'").first();
  assert.match(row.words, /Raincan Shower Head/);
  assert.match(row.words_key, /raincan shower head/);
  // A row read before words were kept gets them with no new reading
  await env.DB.prepare("UPDATE kid_parts SET words = NULL, words_key = NULL WHERE item_id = 'ci-shower'").run();
  calls.length = 0;
  await maybeReadSelections(env, { now: T0 + 60 * MIN, force: true });
  assert.equal(calls.filter((c) => c.kind === 'ai').length, 0);
  assert.match((await env.DB.prepare("SELECT words FROM kid_parts WHERE item_id = 'ci-shower'").first()).words, /Raincan/);
});

test('the lines to buy or receive: chosen selections and plain product lines; never options nobody chose, labor or fees', async () => {
  lines['job-rowan'] = [
    { id: 'ci-chosen', name: 'Vanity Sink', cost: 0, quantity: 1, group: 'Selections', description: 'White sink Donated', choice: true, isSelected: true },
    { id: 'ci-option', name: 'Furniture', cost: 0, quantity: 1, group: 'Selections', description: 'Therapy table, desk', choice: true, isSelected: false },
    { id: 'ci-plain', name: 'Therapy Equipment', cost: 3595.6, quantity: 1, group: 'Room', description: 'Treatment Table AM500', isSelected: false },
    { id: 'ci-labor', name: 'Demo', cost: 1200, quantity: 1, group: 'Scope of Work', description: 'Demo and haul off', isSelected: false, costType: 'Labor' },
    { id: 'ci-sub', name: 'Plumbing', cost: 2400, quantity: 1, group: 'Scope of Work', description: 'Rough in', isSelected: false, costType: 'Subcontractor' },
  ];
  await maybeReadSelections(env, { now: T0, force: true });
  const kept = ((await env.DB.prepare("SELECT item_id FROM kid_parts WHERE job_id = 'job-rowan' ORDER BY item_id").all()).results || []).map((r) => r.item_id);
  assert.deepEqual(kept, ['ci-chosen', 'ci-plain']);
});

test('Nov 10: a line missed before the AI got enough time is read again at once, not six hours later', async () => {
  const OLD = Date.parse('2026-11-10T02:00:00Z');
  jobs = [{ id: 'job-a', name: 'Kid A (2026)', status: 'Build' }];
  lines = { 'job-a': [SHOWER] };
  aiParts = {};
  await maybeReadSelections(env, { now: OLD, force: true });
  calls.length = 0;
  await maybeReadSelections(env, { now: OLD + 60 * MIN, force: true });
  assert.equal(calls.filter((c) => c.kind === 'ai').length, 1);
});

test('Nov 10: a link written by its start is the line’s own link; a line missed three times becomes one whole part', async () => {
  const { linkFrom, wholeLine } = await import('../functions/api/_selection-parts.js');
  const words = 'VEVOR Bubble Tube https://www.lowes.com/pd/VEVOR-Sensory-Bubble-Tube-Lamp-4-ft/5014 and a Fan https://x.example/fan';
  assert.equal(linkFrom('https://www.lowes.com/pd/VEVOR-Sensory-Bubb', words), 'https://www.lowes.com/pd/VEVOR-Sensory-Bubble-Tube-Lamp-4-ft/5014');
  assert.equal(linkFrom('https://made.up/elsewhere-thing', words), '', 'a link the line doesn’t have');
  assert.equal(linkFrom('https://', words), '', 'too short to say');
  const [whole] = wholeLine({ name: 'Towel Bars', description: 'Delta: 70% discount Top Knobs: 100% discount Hand towel holder', cost: 120, quantity: 1 });
  assert.deepEqual([whole.name, whole.source, whole.cents], ['Towel Bars', 'buy', 12000]);
  jobs = [{ id: 'job-a', name: 'Kid A (2026)', status: 'Build' }];
  lines = { 'job-a': [SHOWER] };
  aiParts = {};
  for (let i = 0; i < 4; i++) await maybeReadSelections(env, { now: T0 + i * 7 * 60 * MIN, force: true });
  const p = await parts('ci-shower');
  assert.equal(p.length, 1, 'the whole line, one part');
  assert.equal(p[0].name, SHOWER.name);
});
