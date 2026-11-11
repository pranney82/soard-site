/**
 * Kid items: Scan a box (functions/api/_kid-scan.js, POST /api/kid-items-admin?scan=1)
 * Run: node --test tests/kid-scan.test.mjs
 * Made-up kids, stores, orders and label reads only.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { findBox, sameTracking, readLabel } from '../functions/api/_kid-scan.js';
import { onRequestPost } from '../functions/api/kid-items-admin.js';

let env, aiAnswer, aiCalls;
const part = (name, extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source: 'buy', key: `name:${name}`, ...extra });
async function line(jobId, jobName, itemId, lineName, words, parts) {
  await env.DB.prepare('INSERT INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, 'G', lineName, `h${itemId}`, JSON.stringify(parts), 'ai', '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
async function order(id, store, read) {
  await env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, state, read) VALUES ('pat@soardcharity.com', ?, '2026-11-01T15:00:00Z', ?, ?, 'read', ?)").bind(id, store, read.kind, JSON.stringify(read)).run();
}
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, ...new Array(40).fill(0)]).toString('base64')}`;
const post = (body) => onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?scan=1', { method: 'POST', body: JSON.stringify(body) }) });

beforeEach(async () => {
  aiAnswer = null; aiCalls = [];
  env = {
    DB: await createD1(),
    AI: { run: async (model, input, opts) => { aiCalls.push({ model, feature: opts?.gateway?.metadata?.feature, image: input.messages[1].content[1]?.type }); return { response: aiAnswer }; } },
  };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-shower', 'Shower System', 'Raincan Shower Head 52214-CZ', [part('Raincan Shower Head', { model: '52214-CZ' })]);
  await line('j-ava', 'Ava Example (2026)', 'a-lamp', 'Lighting', 'Cloud Pendant Light, Warm', [part('Cloud Pendant Light')]);
  await order('m1', 'Shop', { kind: 'shipped', orderNumber: 'A1', jobPo: 'ROWAN', items: [{ name: 'Raincan Shower Head 52214-CZ' }], tracking: [{ carrier: 'FedEx', number: '771234567890' }] });
  await order('m2', 'Amazon', { kind: 'order', orderNumber: '111-1234567-7654321', jobPo: 'AVA', items: [{ name: 'Cloud Pendant Light, Warm White' }], tracking: [] });
});

test('tracking numbers: the same package even when the barcode adds digits around it', () => {
  assert.ok(sameTracking('1Z9620450392148623', '1z 962 045 03 9214 8623'));
  assert.ok(sameTracking('9622001900005105600771234567890', '771234567890'), 'a FedEx barcode ends with the tracking number');
  assert.ok(!sameTracking('12345', '12345678912345'), 'too short to say');
  assert.ok(!sameTracking('771234567890', '771234567891'));
});

test('a box found by its tracking number, its order number, its PO, or its packing slip', async () => {
  const { checkinView, orderReads } = await import('../functions/api/_kid-checkin.js');
  const view = await checkinView(env);
  const reads = await orderReads(env.DB);
  const by = (label) => findBox(view, reads, { trackingNumbers: [], orderNumbers: [], po: '', store: '', items: [], ...label });
  assert.deepEqual([by({ trackingNumbers: ['9622001900005105600771234567890'] })?.short, by({ trackingNumbers: ['9622001900005105600771234567890'] })?.items.length], ['Rowan S.', 1]);
  assert.equal(by({ orderNumbers: ['Order # 111-1234567-7654321'] })?.short, 'Ava E.', 'Amazon’s packing slip');
  assert.equal(by({ po: 'AVA' })?.short, 'Ava E.');
  assert.equal(by({ items: ['Cloud Pendant Light Warm White'] })?.short, 'Ava E.');
  assert.equal(by({ trackingNumbers: ['1Z0000000000000000'], po: 'OFFICE' }), null, 'nothing to go on');
});

test('POST: the photo is read on its own AI feature and matched', async () => {
  aiAnswer = { trackingNumbers: ['7712 3456 7890'], orderNumbers: [], po: '', store: 'FedEx', items: [], boxTotal: 3 };
  const res = await post({ image: JPEG });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.found.short, 'Rowan S.');
  assert.equal(body.found.how, 'Tracking …567890');
  assert.equal(body.label.boxTotal, 3, '"1 of 3" on the label: three labels');
  assert.deepEqual([aiCalls[0].feature, aiCalls[0].image], ['checkin-scan', 'image_url']);
});

test('POST: nothing found is an answer, not an error; a bad photo and an unreadable label say what to do', async () => {
  aiAnswer = { trackingNumbers: [], orderNumbers: [], po: '', store: '', items: [] };
  assert.equal((await (await post({ image: JPEG })).json()).found, null);
  const bad = await post({ image: 'data:text/plain;base64,aGk=' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Take it again/);
  aiAnswer = 'not json at all';
  const none = await post({ image: JPEG });
  assert.equal(none.status, 502);
  assert.match((await none.json()).error, /couldn’t be read/);
  await assert.rejects(readLabel({}, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, ...new Array(20).fill(0)])), /can’t read photos/);
});

test('Nov 11: a shipper’s reference is often the store’s order number; a label that matches nothing lists the boxes likely in hand', async () => {
  const { likelyBoxes } = await import('../functions/api/_kid-scan.js');
  const { checkinView, orderReads } = await import('../functions/api/_kid-checkin.js');
  await order('m3', 'Amazon', { kind: 'delivered', orderNumber: '111-1234567-7654321', items: [{ name: 'Cloud Pendant Light, Warm White' }], tracking: [] });
  await env.DB.prepare("UPDATE order_mail SET at = ? WHERE id = 'm3'").bind(new Date().toISOString()).run();
  const view = await checkinView(env);
  const reads = await orderReads(env.DB);
  const by = (label) => findBox(view, reads, { trackingNumbers: [], orderNumbers: [], po: '', store: '', items: [], references: [], ...label });
  assert.equal(by({ references: ['A1'] }), null, 'too short to be anyone’s order number');
  await order('m4', 'Shop', { kind: 'shipped', orderNumber: '359672268', jobPo: 'ROWAN', items: [{ name: 'Raincan Shower Head 52214-CZ' }], tracking: [] });
  const view2 = await checkinView(env);
  const reads2 = await orderReads(env.DB);
  assert.equal(findBox(view2, reads2, { trackingNumbers: [], orderNumbers: [], po: '', store: '', items: [], references: ['SO-359672268-01'] })?.short, 'Rowan S.', 'the order number inside the label’s reference');
  // An Amazon box: its label has only Amazon's own tracking number. Delivered lately comes first
  const likely = likelyBoxes(view, reads, { store: 'Amazon', trackingNumbers: ['TBA123456789000'] });
  assert.deepEqual(likely.map((x) => [x.short, x.why]), [['Ava E.', 'From Amazon · Delivered lately']]);
  assert.deepEqual(likelyBoxes(view, reads, { store: 'Shop' }).map((x) => x.short), ['Rowan S.', 'Ava E.'], 'the store the label names first, then other deliveries');
});

test('Nov 11: the POST answers with the likely boxes and keeps a record of the scan (never the photo)', async () => {
  aiAnswer = { trackingNumbers: ['TBA123456789000'], orderNumbers: [], po: '', store: 'Shop', items: [], boxTotal: 0, references: [] };
  const body = await (await post({ image: JPEG })).json();
  assert.equal(body.found, null);
  assert.deepEqual(body.likely.map((x) => x.short), ['Rowan S.']);
  const scans = (await env.DB.prepare('SELECT label, found, likely FROM kid_scans').all()).results;
  assert.equal(scans.length, 1);
  assert.equal(JSON.parse(scans[0].label).trackingNumbers[0], 'TBA123456789000');
  assert.equal(scans[0].likely, 1);
});

test('Nov 11: the product’s own box (its model number or its name), and the kid’s name on the label, find it', async () => {
  const { checkinView, orderReads } = await import('../functions/api/_kid-checkin.js');
  // An Amazon order for Rowan with no tracking number anywhere (Amazon's emails never carry it)
  await order('m5', 'Amazon', { kind: 'delivered', orderNumber: '111-0000000-0000001', jobPo: 'ROWAN', items: [{ name: 'Raincan Shower Head 52214-CZ' }], tracking: [] });
  const view = await checkinView(env);
  const reads = await orderReads(env.DB);
  const by = (label) => findBox(view, reads, { trackingNumbers: ['TBA987654321000'], orderNumbers: [], po: '', store: 'Amazon', items: [], references: [], models: [], names: [], ...label });
  assert.equal(by({}), null, 'Amazon’s own tracking number alone: nothing to go on');
  const head = view.kids.find((k) => k.short === 'Rowan S.').items.find((i) => i.name === 'Raincan Shower Head');
  assert.deepEqual([by({ models: ['52214-CZ'] })?.short, by({ models: ['52214-CZ'] })?.items, by({ models: ['52214-CZ'] })?.how], ['Rowan S.', [head.id], 'Model 52214-CZ'], 'the model number on the product’s box');
  assert.equal(by({ items: ['Delta Raincan 52214 CZ Shower Head Chrome'] })?.short, 'Rowan S.', 'its name on its box');
  assert.equal(by({ names: ['ATTN: ROWAN'] })?.short, 'Rowan S.', '“Attn: Rowan” on the label');
  assert.equal(by({ names: ['Clareece Cunningham'] }), null, 'a staff member’s name isn’t a kid');
});

// ─── Nov 11 (Peter's labels): a box the emails know is never "nothing found" ───

const nowIso = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
/** The Container Store's order: shipping and delivered emails only (no order email, no PO), its things on no selection */
async function containerStore() {
  const put = (id, at, read) => env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, state, read) VALUES ('pat@soardcharity.com', ?, ?, 'The Container Store', ?, 'read', ?)").bind(id, at, read.kind, JSON.stringify(read)).run();
  await put('cs1', nowIso(7), { kind: 'shipped', orderNumber: '899120272624', tracking: [{ carrier: 'UPS', number: '1Z12D1R20300649275' }, { carrier: 'UPS', number: '1Z12D1R20300649284' }], items: [], shipTo: 'office' });
  await put('cs2', nowIso(6), { kind: 'delivered', orderNumber: '899120272624', tracking: [], shipTo: 'office', items: [{ name: 'Elfa 24" 2-Runner Mesh Hanging Drawer Graphite', quantity: 2 }, { name: 'Elfa 24" 1-Runner Mesh Hanging Drawer Graphite', quantity: 1 }] });
}
const blank = { trackingNumbers: [], orderNumbers: [], po: '', store: '', items: [], references: [], models: [], names: [] };

test('Peter’s Container Store box: its tracking finds its order, nobody’s yet, and it asks whose; a person’s answer places it', async () => {
  const { checkinView, orderReads } = await import('../functions/api/_kid-checkin.js');
  const { decide, WHOLE_ORDER } = await import('../functions/api/_kid-record.js');
  await containerStore();
  let view = await checkinView(env);
  const sh = view.shipments.find((x) => x.key === 'The Container Store|899120272624');
  assert.deepEqual([sh?.unplaced, sh?.stage, sh?.things.map((t) => t.qty)], [true, 'delivered', [2, 1]], 'a delivered shipment, asking whose it is');
  const reads = await orderReads(env.DB);
  // The label: UPS tracking, the shipper's references, Clareece and Liam Agans as who it's to
  const label = { ...blank, trackingNumbers: ['1Z 12D 1R2 03 0064 9275'], references: ['146890757', 'L210769544'], names: ['CLAREECE CUNNINGHAM', 'LIAM AGANS'] };
  assert.deepEqual(findBox(view, reads, label), { unplaced: 'The Container Store|899120272624', how: 'Tracking …649275', exact: true });
  // Clareece: it's Ava's. Its things are Ava's now (bought on top of her selections), and the box finds her shipment
  await decide(env.DB, { orderKey: sh.key, itemName: WHOLE_ORDER, decision: { type: 'kid', kid: 'j-ava' } });
  view = await checkinView(env);
  assert.equal(view.shipments.find((x) => x.key === sh.key).unplaced, undefined);
  const ava = view.kids.find((k) => k.jobId === 'j-ava');
  assert.deepEqual(ava.items.filter((i) => i.order?.key === sh.key).map((i) => [i.name.slice(0, 26), i.qty, Boolean(i.also)]), [['Elfa 24" 2-Runner Mesh Han', 2, true], ['Elfa 24" 1-Runner Mesh Han', 1, true]]);
  const found = findBox(view, reads, label);
  assert.deepEqual([found.short, found.items.length, found.exact], ['Ava E.', 2, true]);
  // Not a kid's after all: off every list, and its label says so (known, on no list)
  await decide(env.DB, { orderKey: sh.key, itemName: WHOLE_ORDER, decision: { type: 'notKid' } });
  view = await checkinView(env);
  assert.equal(view.shipments.some((x) => x.key === sh.key), false);
  assert.deepEqual(Object.keys(findBox(view, reads, label)), ['known', 'how']);
});

test('the store from the tracking number (Amazon’s own, a UPS shipper account another email used), and the label’s words and names rank the likely boxes', async () => {
  const { checkinView, orderReads } = await import('../functions/api/_kid-checkin.js');
  const { storeOfTracking, likelyBoxes } = await import('../functions/api/_kid-scan.js');
  await containerStore();
  // Ava's shower curtain: on her selections, its order email never read (bought on another account)
  await line('j-ava', 'Ava Example (2026)', 'a-curtain', 'Shower Curtain', 'Hotel Collection Fabric Shower Curtain', [part('Hotel Collection XL Fabric Shower Curtain')]);
  const view = await checkinView(env);
  const reads = await orderReads(env.DB);
  assert.equal(storeOfTracking(['TBA336325732548'], reads), 'Amazon');
  assert.equal(storeOfTracking(['1Z12D1R20399999999'], reads), 'The Container Store', 'another box from the same UPS account');
  assert.equal(storeOfTracking(['1ZK180F30314821221'], reads), null);
  // Linzi's Amazon box: "SHOWER CURTAIN" printed on it. Ava's curtain (not ordered, as far as the emails say) is the one
  const likely = likelyBoxes(view, reads, { ...blank, trackingNumbers: ['TBA336325732548'], items: ['SHOWER CURTAIN'], names: ['Linzi Berkowitz'] });
  assert.equal(likely[0].short, 'Ava E.');
  assert.equal(view.kids.find((k) => k.jobId === 'j-ava').items.find((i) => i.id === likely[0].item).name, 'Hotel Collection XL Fabric Shower Curtain');
  assert.match(likely[0].why, /Its name is on the box/);
  // Another box from the Container Store's UPS account, nothing else on it: its nobody's order is first
  const cs = likelyBoxes(view, reads, { ...blank, trackingNumbers: ['1Z12D1R20399999999'] });
  assert.deepEqual([cs[0].order, cs[0].why], ['The Container Store|899120272624', 'From The Container Store · Delivered lately']);
});
