/**
 * Kid items: what the check-in page shows (functions/api/_kid-checkin.js)
 * Run: node --test tests/kid-checkin.test.mjs
 * Made-up kids, staff, stores and orders only.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { checkinView, shortName, avatarOf } from '../functions/api/_kid-checkin.js';

let env;
const part = (name, source = 'buy', extra = {}) => ({ name, brand: '', model: '', link: '', quantity: 1, cents: null, source, key: `name:${name}`, ...extra });
async function line(jobId, jobName, itemId, lineName, words, parts) {
  await env.DB.prepare('INSERT INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)')
    .bind(jobId, itemId, jobName, 'G', lineName, `h${itemId}`, JSON.stringify(parts), 'ai', '2026-11-09', words, words.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).run();
}
async function order(id, store, at, read) {
  await env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, state, read) VALUES ('pat@soardcharity.com', ?, ?, ?, ?, 'read', ?)").bind(id, at, store, read.kind, JSON.stringify(read)).run();
}

beforeEach(async () => {
  env = { DB: await createD1() };
  await env.DB.exec(`CREATE TABLE kid_parts (job_id TEXT, item_id TEXT, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER, hash TEXT, parts TEXT, read_by TEXT, read_at TEXT, words TEXT, words_key TEXT, PRIMARY KEY (job_id, item_id));
    CREATE TABLE order_mail (mailbox TEXT, id TEXT, at TEXT, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT, read TEXT, detail TEXT, tries INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id));
    CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`);
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ accounts: [{ name: 'Pat Lee' }, { name: 'Sam Fox' }] })).run();
  await line('j-rowan', 'Rowan Sample (2026)', 'r-wall', 'Wall Treatment', 'Good Fun Co Perfect Stripe, Beige', [part('Wall Treatment')]);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-shower', 'Shower System', 'Raincan Shower Head 52214-CZ, Slide Bar Hand Shower', [part('Raincan Shower Head', 'buy', { model: '52214-CZ' }), part('Slide Bar Hand Shower')]);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-paint', 'Paint', 'Walls and trim', [part('Paint', 'others')]);
  await line('j-rowan', 'Rowan Sample (2026)', 'r-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')]);
  await line('j-ava', 'Ava Example (2026)', 'a-decor', 'Decor', 'Books, wall art, shelves, decorative objects', [part('Books, wall art, shelves')]);
  await line('j-ava', 'Ava Example (2026)', 'a-sink', 'Vanity Sink', 'White sink Donated', [part('White sink', 'donated')]);
});

test('each kid’s things to receive: ordered ones marked, someone else’s counted apart, template lines left out', async () => {
  await order('m1', 'Shop', '2026-10-30T15:00:00Z', { kind: 'order', orderNumber: 'A1', jobPo: 'ROWAN', items: [{ name: 'Raincan Shower Head 52214-CZ' }, { name: 'Bean Bag Chair' }] });
  await order('m2', 'Good Fun Co', '2026-10-28T15:00:00Z', { kind: 'shipped', orderNumber: 'B2', items: [{ name: 'Perfect Stripe, Beige' }] });
  const v = await checkinView(env);
  assert.equal(v.practice, true);
  const rowan = v.kids.find((k) => k.short === 'Rowan S.');
  const by = (name) => rowan.items.find((i) => i.name === name);
  assert.equal(by('Raincan Shower Head').status, 'ordered');
  assert.equal(by('Raincan Shower Head').order.store, 'Shop');
  assert.equal(by('Slide Bar Hand Shower').status, 'not');
  assert.equal(by('Wall Treatment').status, 'ordered', 'matched by the designer’s words, no PO');
  assert.deepEqual([by('Bean Bag Chair').line, by('Bean Bag Chair').status], ['Also bought', 'ordered'], 'the PO said Rowan; not on a line');
  assert.equal(rowan.others, 1);
  assert.ok(!rowan.items.some((i) => i.line === 'Decor'), 'the decor allowance is a template, not a thing to receive');
  assert.equal(rowan.items[0].status, 'ordered', 'ordered first');
  const ava = v.kids.find((k) => k.short === 'Ava E.');
  assert.equal(ava.items[0].source, 'donated');
  assert.notEqual(rowan.shelf, ava.shelf);
});

test('orders a person needs to look at, and ones that aren’t a kid’s', async () => {
  await order('m1', 'Shop', '2026-10-30T15:00:00Z', { kind: 'order', orderNumber: 'C3', jobPo: 'ROWEN', items: [{ name: 'Night Light' }] });
  await order('m2', 'Shop', '2026-10-30T15:00:00Z', { kind: 'order', orderNumber: 'D4', jobPo: 'OFFICE', items: [{ name: 'Printer Paper' }] });
  const v = await checkinView(env);
  assert.equal(v.needsLook.length, 1);
  assert.equal(v.needsLook[0].po, 'ROWEN');
  assert.equal(v.needsLook[0].items[0].look, 'which kid?');
});

test('no data yet: an empty page, not an error', async () => {
  const v = await checkinView({ DB: await createD1() });
  assert.deepEqual([v.kids, v.needsLook], [[], []]);
});

test('short names', () => {
  assert.equal(shortName('Lizzie Sample (2026)'), 'Lizzie S.');
  assert.equal(shortName('The Sample School (2026)'), 'The Sample School');
});

test('each kid’s photo from their kid page, small and square; none, no photo', async () => {
  assert.equal(avatarOf('https://imagedelivery.net/acct123/kids/rowan/photo-1.jpg/public'), '/cdn-cgi/imagedelivery/acct123/kids/rowan/photo-1.jpg/w=160,h=160,fit=cover,gravity=auto');
  assert.equal(avatarOf('https://elsewhere.example/x.jpg'), null);
  await env.DB.exec('CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)');
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('rowan', 'Rowan', 2026, JSON.stringify({ name: 'Rowan', year: 2026, heroImage: 'https://imagedelivery.net/acct123/kids/rowan/photo-1.jpg/public' })).run();
  const v = await checkinView(env);
  assert.equal(v.kids.find((k) => k.short === 'Rowan S.').photo, '/cdn-cgi/imagedelivery/acct123/kids/rowan/photo-1.jpg/w=160,h=160,fit=cover,gravity=auto');
  assert.equal(v.kids.find((k) => k.short === 'Ava E.').photo, null);
});
