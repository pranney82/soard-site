/**
 * Kid items: a line's parts are one set (Peter, Nov 11 2026: "how can we tie multiple items together like 1 of, for
 * shower parts for example"). Run: node --test tests/kid-sets.test.mjs. Made-up kids and stores only.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { checkinView } from '../functions/api/_kid-checkin.js';
import { receive } from '../functions/api/_kid-record.js';
import { itemLabel } from '../functions/api/_kid-labels.js';
import { onRequestPost } from '../functions/api/kid-items-admin.js';

let env;
const part = (name, extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source: 'buy', key: `name:${name.toLowerCase()}`, ...extra });
async function line(jobId, jobName, itemId, lineName, words, parts) {
  await env.DB.prepare('INSERT OR REPLACE INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, 'Bathroom Selection & Allowance', lineName, `h${itemId}`, JSON.stringify(parts), 'ai', '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
const view = () => checkinView(env, { photos: false });

beforeEach(async () => {
  env = { DB: await createD1() };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  await line('j-ava', 'Ava Example (2026)', 'a-shower', 'Shower System', 'Valve, trim, shower head, hand shower', [part('Shower Valve'), part('Valve Trim'), part('Raincan Shower Head'), part('Hand Shower'), { ...part('Plumber labor'), source: 'labor' }]);
  await line('j-ava', 'Ava Example (2026)', 'a-lamp', 'Lighting', 'Cloud Pendant Light', [part('Cloud Pendant Light')]);
});

test('a line’s parts are one set: each says which of how many, in the designer’s order; a line of one thing is no set', async () => {
  const ava = (await view()).kids.find((k) => k.jobId === 'j-ava');
  const sets = Object.fromEntries(ava.items.map((i) => [i.name, i.set ? `${i.set.n} of ${i.set.of}` : null]));
  assert.deepEqual(sets, { 'Shower Valve': '1 of 4', 'Valve Trim': '2 of 4', 'Raincan Shower Head': '3 of 4', 'Hand Shower': '4 of 4', 'Cloud Pendant Light': null });
});

test('a part’s label says its line and which part it is; a thing alone says its line only', () => {
  const zpl = itemLabel({ kid: 'Ava E.', item: 'Valve Trim', line: 'Shower System', set: { n: 2, of: 4 }, box: 1, boxes: 1, shelf: 'Shelf 3', at: '2026-11-11T15:00:00Z', tap: 'tap-x' });
  assert.match(zpl, /\^FDShower System · Part 2 of 4\^FS/);
  assert.match(itemLabel({ kid: 'Ava E.', item: 'Cloud Pendant Light', line: 'Lighting', box: 1, boxes: 1, shelf: 'Shelf 3', at: '2026-11-11T15:00:00Z', tap: 'tap-y' }), /\^FDLighting\^FS/);
});

test('the labels printed for a part of a set (by the site) say which part', async () => {
  const trim = (await view()).kids.find((k) => k.jobId === 'j-ava').items.find((i) => i.name === 'Valve Trim');
  await receive(env.DB, { tap: 'tap-trim-0001', jobId: 'j-ava', itemId: trim.itemId, partKey: trim.partKey, name: trim.name, line: trim.line, units: 1, boxes: 1 });
  // A pretend printer hub (the Durable Object the site prints through): online, takes every label
  const sent = [];
  env.PRINT_HUB = { idFromName: () => 'office', get: () => ({ fetch: async (url, init) => {
    if (String(url).endsWith('/status')) return Response.json({ seenAt: Date.now(), online: true, problems: [] });
    const { labels } = JSON.parse(init.body);
    sent.push(...labels);
    return Response.json({ sent: labels.length, queued: 0, online: true, problems: [] });
  } }) };
  const r = await (await onRequestPost({ env, request: new Request('https://site.example/api/kid-items-admin?reprint=1', { method: 'POST', body: JSON.stringify({ tap: 'tap-trim-0001' }) }), waitUntil: () => {} })).json();
  assert.equal(r.success, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\^FDShower System · Part 2 of 4\^FS/);
});
