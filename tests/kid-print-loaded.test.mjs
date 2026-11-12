/**
 * Review proof, Nov 12 (fixed): a check-in moved to another shelf while the printer is off has its labels printed later by the heartbeat
 * (maybePrintWaiting) for EVERY box, including a box already on the truck. c06f493f says a moved check-in's labels
 * print again "only for its boxes still at the Office". Made-up kid and store.
 * Run: node --test tests/kid-print-loaded.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { checkinView } from '../functions/api/_kid-checkin.js';
import { receive, checkOut } from '../functions/api/_kid-record.js';
import { maybePrintWaiting } from '../functions/api/_kid-print.js';
import { onRequestPost } from '../functions/api/kid-items-admin.js';

const part = (name, extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source: 'buy', key: `name:${name.toLowerCase()}`, ...extra });

test('Nov 12 review: a check-in moved while the printer is off prints later only for its boxes still at the Office; all on the truck, nothing is sent', async () => {
  const env = { DB: await createD1() };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  await env.DB.prepare('INSERT INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('j-rowan', 'r-shower', 'Rowan Sample (2026)', 'G', 'Shower System', 100, 'h', JSON.stringify([part('Raincan Shower Head', { model: '52214-CZ' })]), 'ai', '2026-11-09', 'Raincan Shower Head', 'raincan shower head').run();
  const hub = { online: true, printed: [] };
  env.PRINT_HUB = { idFromName: () => 'office', get: () => ({ fetch: async (url, init) => {
    if (String(url).endsWith('/status')) return Response.json({ seenAt: Date.now(), online: hub.online, problems: [], waiting: 0 });
    const labels = JSON.parse(init.body).labels;
    if (!hub.online) return Response.json({ sent: 0, queued: labels.length, online: false, problems: [] });
    hub.printed.push(...labels.map((l) => /Box (\d+) of (\d+)/.exec(l)[0]));
    return Response.json({ sent: labels.length, online: true, problems: [] });
  } }) };
  const post = async (action, body) => (await onRequestPost({ env, request: new Request(`https://site.example/api/kid-items-admin?${action}=1`, { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} })).json();

  const head = (await checkinView(env, { photos: false })).kids[0].items.find((i) => i.name === 'Raincan Shower Head');
  // Checked in, two boxes: both labels print
  const r = await post('receive', { tap: 'tap-head-0001', jobId: 'j-rowan', itemId: head.itemId, partKey: head.partKey, name: head.name, line: head.line, units: 1, boxes: 2 });
  assert.equal(r.success, true);
  assert.deepEqual(hub.printed, ['Box 1 of 2', 'Box 2 of 2']);
  hub.printed.length = 0;
  // Box 1 goes on the truck
  await checkOut(env.DB, { tap: 'tap-out-00001', ref: 'tap-head-0001', box: 1 });
  // The printer is off; box 2 (still at the Office) is moved to shelf 5
  hub.online = false;
  const m = await post('shelf', { taps: ['tap-head-0001'], shelf: '5' });
  assert.equal(m.success, true);
  assert.equal(m.print.queued, 1, 'the page is told one label waits (box 2 only)');
  // The printer comes back; the heartbeat prints what never printed
  hub.online = true;
  await maybePrintWaiting(env, { now: Date.now() });
  assert.deepEqual(hub.printed, ['Box 2 of 2']);
  // Box 2 loaded too, moved again: nothing to print, and the printer isn't asked
  await checkOut(env.DB, { tap: 'tap-out-00002', ref: 'tap-head-0001', box: 2 });
  hub.printed.length = 0;
  const m2 = await post('shelf', { taps: ['tap-head-0001'], shelf: '6' });
  assert.deepEqual([m2.success, m2.print?.none, hub.printed.length], [true, true, 0]);
});
