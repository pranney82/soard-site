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
  assert.deepEqual(likely.map((x) => [x.short, x.why]), [['Ava E.', 'Delivered lately']]);
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
