/**
 * Kid items, step 1: store order emails in every SOARD inbox, read (functions/api/_order-sweep.js)
 * Run: node --test tests/order-sweep.test.mjs
 *
 * Read only: Gmail is searched and read, Workers AI reads items the email's
 * own words don't give, D1 keeps the reads, and nothing else is called.
 * Made-up people, stores and orders only.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { maybeSweepOrders, orderSweepStatus, orderTriage, bodiesOf, notStoreMail, BACKFILL_DAYS } from '../functions/api/_order-sweep.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM });

const T0 = Date.parse('2026-11-09T15:00:00Z');
const MIN = 60e3, DAY = 86400e3;
const PAT = 'pat@soardcharity.com', SAM = 'sam@soardcharity.com', SHOP = 'kim@store.example';
const ACCOUNTS = [
  { email: PAT, aliases: [], name: 'Pat Lee', active: true, why: null },
  { email: SAM, aliases: ['sam@store.example'], name: 'Sam Fox', active: true, why: null },
  // The store's own account: its buying is the store's
  { email: SHOP, aliases: [], name: 'Kim Shop', active: true, why: null },
];

const b64u = (s) => Buffer.from(s).toString('base64url');
let seq, store, calls, aiAnswers, aiCap, env;
function mail({ box, at, from, to = box, subject, text = '', html = '', msgid = null, labels = ['INBOX'], extra = [] }) {
  const n = ++seq;
  const headers = [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: msgid || `<o${n}@mail.example>` }, ...extra];
  const parts = [
    ...(text ? [{ partId: '0', mimeType: 'text/plain', headers: [], body: { data: b64u(text), size: text.length } }] : []),
    ...(html ? [{ partId: '1', mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset="utf-8"' }], body: { data: b64u(html), size: html.length } }] : []),
  ];
  const m = { box, id: `m${String(n).padStart(4, '0')}`, threadId: `t${n}`, internalDate: String(at), labelIds: labels, snippet: (text || html.replace(/<[^>]+>/g, ' ')).slice(0, 80), payload: { mimeType: 'multipart/alternative', headers, parts } };
  store.push(m);
  return m;
}
const realFetch = globalThis.fetch;

beforeEach(async () => {
  seq = 0; store = []; calls = []; aiAnswers = {}; aiCap = false;
  env = {
    DB: await createD1(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT,
    AI: { run: async (model, { messages }, opts) => {
      const subject = /Subject: (.*)/.exec(messages[1].content)?.[1] || '';
      calls.push({ kind: 'ai', subject, feature: opts?.gateway?.metadata?.feature });
      if (aiCap) throw new Error('2045: spend limit reached');
      return { response: aiAnswers[subject] || { kind: 'not_order', orderNumber: '', items: [], trackingNumbers: [], expected: '', shipTo: 'unknown', jobPo: '' } };
    } },
  };
  await env.DB.exec('CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  clearTokenCache();
  globalThis.fetch = async function (input, init = {}) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      return Response.json({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')) {
      const box = String(init.headers?.Authorization || '').replace('Bearer tok:', '');
      const u = new URL(url);
      const path = u.pathname.replace('/gmail/v1/users/me', '');
      calls.push({ kind: 'gmail', box, path, q: u.searchParams.get('q'), format: u.searchParams.get('format') });
      const mine = store.filter((m) => m.box === box);
      if (path === '/messages') {
        const q = u.searchParams.get('q') || '';
        const after = Number(/after:(\d+)/.exec(q)?.[1] || 0) * 1000;
        const before = Number(/before:(\d+)/.exec(q)?.[1] || Infinity) * 1000;
        const hits = mine.filter((m) => Number(m.internalDate) > after && Number(m.internalDate) < before)
          .filter((m) => !(/-in:sent/.test(q) && m.labelIds.includes('SENT')))
          .sort((a, b) => b.internalDate - a.internalDate);
        return Response.json({ messages: hits.map((m) => ({ id: m.id })) });
      }
      const m = /^\/messages\/(\w+)$/.exec(path);
      if (m) {
        const msg = mine.find((x) => x.id === m[1]);
        if (!msg) return Response.json({ error: { message: 'not found' } }, { status: 404 });
        const { box: _b, ...clean } = msg;
        return Response.json(u.searchParams.get('format') === 'metadata' ? { ...clean, payload: { headers: clean.payload.headers } } : clean);
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const rows = async () => (await env.DB.prepare('SELECT mailbox, id, store, kind, state, detail, read, source FROM order_mail ORDER BY at').all()).results;
const run = (now, o = {}) => maybeSweepOrders(env, { now, force: true, ...o });
const amazonText = 'Your package was shipped! Arriving Thursday Sunshine - ROSWELL, GA Order # 111-1234567-7654321 * Oak Step Stool Quantity: 1 49.99 USD';

test('triage: store order mail counts; staff mail, sent mail, ads, and the store’s own buying don’t', () => {
  const ctx = { domains: new Set(['soardcharity.com', 'store.example']), storeDomains: new Set(['store.example']) };
  const t = (o) => orderTriage(mail({ box: PAT, at: T0, ...o }), ctx);
  assert.deepEqual(t({ from: 'Wayfair <hi@wayfair.com>', subject: 'Track your package! Your order is on the way.' }), { kind: 'shipped', store: 'Wayfair' });
  assert.deepEqual(t({ from: '"\'Amazon.com\' via orders" <orders@soardcharity.com>', subject: 'Delivered: "Oak Step Stool"', extra: [{ name: 'X-Original-From', value: 'Amazon.com <shipment-tracking@amazon.com>' }] }), { kind: 'delivered', store: 'Amazon' }, 'a group’s copy goes by who really sent it');
  assert.equal(t({ from: `Sam <${SAM}>`, subject: 'Fwd: Your order has shipped' }), null, 'staff forwarding');
  assert.equal(t({ from: 'Wayfair <hi@wayfair.com>', subject: 'Thanks for your order!', labels: ['SENT'] }), null);
  assert.equal(t({ from: 'Wayfair <hi@wayfair.com>', subject: '40% off rugs today' }), null);
  assert.equal(t({ from: 'Wayfair <hi@wayfair.com>', to: 'sam@store.example', subject: 'Thanks for your order!' }), null, 'addressed only to the store');
  assert.deepEqual(t({ from: 'Wayfair <hi@wayfair.com>', to: `sam@store.example, ${SAM}`, subject: 'Thanks for your order!' }), { kind: 'order', store: 'Wayfair' }, 'SOARD’s address is on it too');
});

test('the last 60 days come in, each email read once; Amazon’s without the AI, a store’s HTML with it', async () => {
  mail({ box: PAT, at: T0 - 10 * DAY, from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Shipped: "Oak Step Stool"', text: amazonText });
  mail({ box: PAT, at: T0 - 9 * DAY, from: 'Crate & Barrel <hi@crateandbarrel.com>', subject: 'Shipped! Your order 359672268', html: '<p>View this email in your browser</p><a href="https://www.ups.com/track?tracknum=1Z9620450392148623">Track</a><p>Oak Bunk Bed</p>' });
  mail({ box: PAT, at: T0 - 8 * DAY, from: `Sam <${SAM}>`, subject: 'Re: paint colors' });
  mail({ box: PAT, at: T0 - 7 * DAY, from: 'Crate & Barrel <hi@crateandbarrel.com>', subject: '30% off bedding' });
  mail({ box: PAT, at: T0 - (BACKFILL_DAYS + 5) * DAY, from: 'Wayfair <hi@wayfair.com>', subject: 'Thanks for your order!' });
  mail({ box: SHOP, at: T0 - 2 * DAY, from: 'Wayfair <hi@wayfair.com>', subject: 'Thanks for your order!' });
  aiAnswers['Shipped! Your order 359672268'] = { kind: 'shipped', orderNumber: '', items: [{ name: 'Oak Bunk Bed', sku: '', quantity: 1, price: '$899.00' }], trackingNumbers: [], expected: '2026-11-03', shipTo: 'office', jobPo: '' };

  await run(T0);
  const r = await rows();
  const read = r.filter((x) => x.state === 'read');
  assert.equal(read.length, 2);
  const amazon = JSON.parse(read.find((x) => x.store === 'Amazon').read);
  assert.equal(amazon.source, 'amazon');
  assert.equal(amazon.items[0].name, 'Oak Step Stool');
  const cb = JSON.parse(read.find((x) => x.store === 'Crate & Barrel').read);
  assert.equal(cb.source, 'ai');
  assert.deepEqual(cb.tracking, [{ carrier: 'UPS', number: '1Z9620450392148623' }], 'the Track link’s number, kept though the AI didn’t name it');
  assert.equal(cb.orderNumber, '359672268');
  assert.deepEqual(calls.filter((c) => c.kind === 'ai').map((c) => [c.subject, c.feature]), [['Shipped! Your order 359672268', 'orders']], 'one AI read, on its own gateway feature');
  assert.equal(r.filter((x) => x.state === 'skipped').length, 2, 'the staff email and the ad are passed over');
  assert.ok(!calls.some((c) => c.box === SHOP), 'the store’s account is never opened');
  assert.ok(!r.some((x) => /Thanks for your order/.test(x.detail || '') && x.mailbox === PAT), 'older than 60 days stays out');
  assert.ok(calls.filter((c) => c.kind === 'gmail' && c.path === '/messages').every((c) => /subject:\(order OR/.test(c.q)), 'Gmail is asked for order words only');
});

test('the same email in two inboxes (an orders@ copy) is read once', async () => {
  const msgid = '<same@amazon.example>';
  mail({ box: PAT, at: T0 - DAY, from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Shipped: "Oak Step Stool"', text: amazonText, msgid });
  mail({ box: SAM, at: T0 - DAY, from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Shipped: "Oak Step Stool"', text: amazonText, msgid });
  await run(T0);
  const r = await rows();
  assert.deepEqual(r.map((x) => x.state).sort(), ['duplicate', 'read']);
});

test('new mail after the backfill is found on the next look', async () => {
  await run(T0);
  mail({ box: PAT, at: T0 + 2 * MIN, from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Delivered: "Oak Step Stool"', text: 'Your package was delivered! Sunshine - ROSWELL, GA Order # 111-1234567-7654321 * Oak Step Stool Quantity: 1' });
  await run(T0 + 4 * MIN);
  const r = (await rows()).filter((x) => x.state === 'read');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'delivered');
  assert.equal(r[0].source, 'new');
});

test('a spending cap: the email waits, untouched, and the lane rests', async () => {
  mail({ box: PAT, at: T0 - DAY, from: 'Crate & Barrel <hi@crateandbarrel.com>', subject: 'Shipped! Your order 359672268', html: '<p>Oak Bunk Bed</p>' });
  aiCap = true;
  const st = await run(T0);
  assert.ok(st.aiRestUntil > T0);
  assert.match(st.error, /spending cap/);
  assert.deepEqual((await rows()).map((x) => [x.state, x.read]), [['queued', null]]);
});

test('an email the AI says isn’t an order is passed over', async () => {
  mail({ box: PAT, at: T0 - DAY, from: 'Shop <hi@shop.example>', subject: 'Your order of happiness is on its way', html: '<p>A blog post</p>' });
  await run(T0);
  assert.deepEqual((await rows()).map((x) => [x.state, x.detail]), [['skipped', 'not an order email, by its words']]);
});

test('Automations: by store, how many gave their items and tracking', async () => {
  mail({ box: PAT, at: T0 - 10 * DAY, from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Shipped: "Oak Step Stool"', text: amazonText });
  mail({ box: PAT, at: T0 - 9 * DAY, from: 'Crate & Barrel <hi@crateandbarrel.com>', subject: 'Shipped! Your order 359672268', html: '<a href="https://www.ups.com/track?tracknum=1Z9620450392148623">Track</a>' });
  aiAnswers['Shipped! Your order 359672268'] = { kind: 'shipped', orderNumber: '', items: [], trackingNumbers: [], expected: '', shipTo: 'unknown', jobPo: '' };
  await run(T0);
  const s = await orderSweepStatus(env, { now: T0 });
  assert.equal(s.watching, true);
  const amazon = s.stores.find((x) => x.store === 'Amazon');
  assert.deepEqual([amazon.emails, amazon.itemsPct, amazon.trackingPct, amazon.toOffice], [1, 100, 0, 1], 'Amazon’s emails carry no tracking number');
  const cb = s.stores.find((x) => x.store === 'Crate & Barrel');
  assert.deepEqual([cb.itemsPct, cb.trackingPct], [0, 100], 'no items when the AI had none');
  assert.equal(s.recent.length, 2);
});

test('the bodies: plain words and HTML, each decoded', () => {
  const m = mail({ box: PAT, at: T0, from: 'x@y.example', subject: 's', text: 'plain ✓', html: '<b>bold ✓</b>' });
  assert.deepEqual(bodiesOf(m.payload), { text: 'plain ✓', html: '<b>bold ✓</b>' });
});

test('without the Google key it does nothing; it never throws', async () => {
  assert.equal(await maybeSweepOrders({ DB: env.DB }), null);
  globalThis.fetch = async () => { throw new Error('network down'); };
  const st = await maybeSweepOrders(env, { now: T0, force: true });
  assert.match(st.error, /pat: network down/, 'each inbox’s trouble is noted, and the run still finishes');
  const saved = JSON.parse((await env.DB.prepare("SELECT data FROM order_sweep_state WHERE key = 'sweep'").first()).data);
  assert.equal(saved.runningUntil, 0);
});

test('review fix: a page token Gmail no longer takes starts the listing over, and a failing inbox doesn’t hold the pace', async () => {
  for (let i = 0; i < 3; i++) mail({ box: PAT, at: T0 - (i + 1) * DAY, from: 'Amazon.com <shipment-tracking@amazon.com>', subject: `Shipped: "Item ${i}"`, text: amazonText });
  const realGmail = globalThis.fetch;
  // A token from an earlier run that Gmail now refuses
  await run(T0);
  const st0 = JSON.parse((await env.DB.prepare("SELECT data FROM order_sweep_state WHERE key = 'sweep'").first()).data);
  st0.boxes[PAT] = { ...st0.boxes[PAT], backfilled: null, backfillPage: 'stale-token' };
  await env.DB.prepare("UPDATE order_sweep_state SET data = ? WHERE key = 'sweep'").bind(JSON.stringify(st0)).run();
  globalThis.fetch = async function (input, init) {
    if (String(input).includes('pageToken=stale-token')) return Response.json({ error: { message: 'Invalid pageToken' } }, { status: 400 });
    return realGmail.call(undefined, input, init);
  };
  const st1 = await run(T0 + 4 * MIN);
  assert.match(st1.boxes[PAT].error, /Gmail answered 400/);
  assert.equal(st1.boxes[PAT].backfillPage, null, 'the token is dropped');
  const st2 = await run(T0 + 8 * MIN);
  assert.equal(st2.boxes[PAT].error, null, 'the next look starts over and works');
  assert.equal((await rows()).filter((x) => x.state === 'read').length, 3, 'nothing read twice');
  // An inbox that fails every time stops counting as still bringing in its 60 days
  globalThis.fetch = async function (input, init) {
    if (String(input).includes('gmail.googleapis.com') && String(init?.headers?.Authorization || '').includes(SAM)) return Response.json({ error: { message: 'backend error' } }, { status: 500 });
    return realGmail.call(undefined, input, init);
  };
  let st;
  for (let i = 0; i < 6; i++) st = await run(T0 + (12 + 4 * i) * MIN);
  assert.ok(st.boxes[SAM].fails >= 5);
  assert.equal(st.backfilling, false);
});

test('Automations: per store, shipped orders that never had a delivered email (does email alone say when things arrive?)', async () => {
  const amazon = (subject, at, order) => mail({ box: PAT, at, from: 'Amazon.com <shipment-tracking@amazon.com>', subject, text: `Sunshine - ROSWELL, GA Order # ${order} * Oak Step Stool Quantity: 1` });
  amazon('Shipped: "Oak Step Stool"', T0 - 20 * DAY, '111-0000001-0000001');
  amazon('Delivered: "Oak Step Stool"', T0 - 18 * DAY, '111-0000001-0000001');
  amazon('Shipped: "Oak Step Stool"', T0 - 15 * DAY, '111-0000002-0000002');
  amazon('Shipped: "Oak Step Stool"', T0 - 2 * DAY, '111-0000003-0000003');
  await run(T0);
  await run(T0 + 2 * MIN);
  const a = (await orderSweepStatus(env, { now: T0 })).stores.find((x) => x.store === 'Amazon');
  assert.deepEqual([a.shippedWeekAgo, a.noDeliveredEmail, a.deliveredEmailPct], [2, 1, 50], 'the one shipped two days ago doesn’t count yet');
});

test('first live run: money tools, bounces, calendar notices and replies aren’t store order mail', async () => {
  assert.equal(notStoreMail('Ramp <receipts@ramp.com>', 'Bill payment delivered: A Contractor #12'), 'from a money or staff tool, not a store');
  assert.equal(notStoreMail('Ramp <sunshine@ap.ramp.com>', 'Re: Fwd: Invoice & Shipment Confirmation'), 'from a money or staff tool, not a store');
  assert.equal(notStoreMail('Mercury <hello@mercury.com>', 'Your IO credit card has shipped'), 'from a money or staff tool, not a store');
  assert.equal(notStoreMail('Gusto <no-reply@gusto.com>', 'Someone canceled a time off request'), 'from a money or staff tool, not a store');
  assert.equal(notStoreMail('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Delay)'), 'a mail system’s notice');
  assert.equal(notStoreMail('Pat Friend <pat@friend.example>', 'Canceled: Team Tailgate'), 'a reply, forward or calendar notice');
  assert.equal(notStoreMail('Store Rep <rep@decor.example>', 'Re: Order Summary #ACD-222'), 'a reply, forward or calendar notice');
  assert.equal(notStoreMail('Vendor <v@tile.example>', 'FW: For Rowan: shipment update'), 'a reply, forward or calendar notice');
  assert.equal(notStoreMail('The Charity <payouts@pay.example>', 'A payout is on its way to The Charity'), 'about money, not goods');
  assert.equal(notStoreMail('Wayfair <hi@wayfair.com>', 'Your order has shipped'), null);
  // An email queued before the rule: passed over when it's read, without the AI
  mail({ box: PAT, at: T0 - DAY, from: 'Mercury <hello@mercury.com>', subject: 'Your IO credit card has shipped', text: 'On its way' });
  await env.DB.exec("CREATE TABLE IF NOT EXISTS order_mail (mailbox TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, msgid TEXT, store TEXT, kind TEXT, subject TEXT, state TEXT NOT NULL, read TEXT, detail TEXT, tries INTEGER DEFAULT 0, source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id))");
  await env.DB.prepare("INSERT INTO order_mail (mailbox, id, at, store, kind, subject, state, source, updated_at) VALUES (?, 'm0001', ?, 'Mercury', 'shipped', 'Your IO credit card has shipped', 'queued', 'backfill', ?)").bind(PAT, new Date(T0 - DAY).toISOString(), new Date(T0).toISOString()).run();
  await run(T0);
  const r = (await rows()).find((x) => x.id === 'm0001');
  assert.deepEqual([r.state, r.detail], ['skipped', 'from a money or staff tool, not a store']);
  assert.equal(calls.filter((c) => c.kind === 'ai').length, 0);
});
