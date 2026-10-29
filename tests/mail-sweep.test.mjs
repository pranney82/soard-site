/**
 * Staff inboxes, swept (functions/api/_mail-sweep.js)
 * Run: node --test tests/mail-sweep.test.mjs
 *
 * Every active inbox's new mail is sorted: receipts go to the receipt inbox
 * with their files, family emails become comments on the family's JobTread
 * account that the family can't see and nobody is assigned to (replies under
 * the conversation's first email). The last year's family mail comes in
 * once; receipts only from the start. The first day only watches. Each email
 * is handled once across inboxes.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { maybeSweepMail, mailSweepStatus, triage, withoutQuoted, familyAddresses, WATCH_MS } from '../functions/api/_mail-sweep.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM });

const T0 = Date.parse('2026-11-02T15:00:00Z');
const MIN = 60e3, DAY = 86400e3;
const PAT = 'pat@soardcharity.com', SAM = 'sam@soardcharity.com';
const ACCOUNTS = [
  { email: PAT, aliases: [], name: 'Pat Lee', active: true, why: null },
  { email: SAM, aliases: [], name: 'Sam Fox', active: true, why: null },
];
const FAMILIES = [
  ['acctRivera1', 'Rivera Family', 'parent@example.com', [{ name: 'Dan Rivera', email: 'dad@example.com' }, { name: 'Case Worker', email: 'cw@example.org' }]],
  ['acctKim0002', 'Kim Family', 'kim@example.com', [{ name: 'Case Worker', email: 'cw@example.org' }]],
];

const b64u = (s) => Buffer.from(s).toString('base64url');
let seq = 0;
/** A Gmail message: { id, threadId, internalDate, labelIds, snippet, payload } */
function mail({ box, at, from, to, cc = '', subject, text = '', html = null, msgid = null, refs = '', labels = ['INBOX'], files = [], thread = null, id = null }) {
  const n = ++seq;
  const headers = [
    { name: 'From', value: from }, { name: 'To', value: to }, ...(cc ? [{ name: 'Cc', value: cc }] : []),
    { name: 'Subject', value: subject }, { name: 'Message-ID', value: msgid || `<m${n}@mail.example>` },
    ...(refs ? [{ name: 'References', value: refs }, { name: 'In-Reply-To', value: refs.split(' ').pop() }] : []),
  ];
  const parts = [
    html ? { partId: '0', mimeType: 'text/html', headers: [], body: { data: b64u(html), size: html.length } } : { partId: '0', mimeType: 'text/plain', headers: [], body: { data: b64u(text), size: text.length } },
    ...files.map((f, i) => ({ partId: String(i + 1), mimeType: f.type, filename: f.name, headers: [{ name: 'Content-Disposition', value: f.inline ? 'inline' : 'attachment' }], body: { attachmentId: `att-${n}-${i}`, size: f.size || f.data.length } })),
  ];
  const m = { box, id: id || `msg${String(n).padStart(4, '0')}`, threadId: thread || `th${n}`, internalDate: String(at), labelIds: labels, snippet: (text || html || '').replace(/<[^>]+>/g, '').slice(0, 80), payload: { partId: '', mimeType: 'multipart/mixed', headers, parts }, _files: files };
  store.push(m);
  return m;
}

let env, store, calls, resendOk, aiVerdicts;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  seq = 0;
  store = [];
  calls = [];
  resendOk = true;
  aiVerdicts = {};
  env = {
    DB: await createD1(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT, RESEND_API_KEY: 're_test', JOBTREAD_GRANT_KEY: 'grant-main',
    AI: { run: async (_model, { messages }) => {
      const subject = /Subject: (.*)/.exec(messages[1].content)?.[1] || '';
      calls.push({ kind: 'ai', subject });
      return { response: aiVerdicts[subject] || { type: 'not_receipt', personal: false, reason: 'an ad' } };
    } },
  };
  await env.DB.exec('CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  await env.DB.exec('CREATE TABLE applicants (account_id TEXT PRIMARY KEY, name TEXT NOT NULL, contact_email TEXT, contacts TEXT)');
  for (const [id, name, email, contacts] of FAMILIES) await env.DB.prepare('INSERT INTO applicants (account_id, name, contact_email, contacts) VALUES (?, ?, ?, ?)').bind(id, name, email, JSON.stringify(contacts)).run();
  clearTokenCache();

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      return Response.json({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')) {
      const box = String(init.headers?.Authorization || '').replace('Bearer tok:', '');
      const u = new URL(url);
      const path = u.pathname.replace('/gmail/v1/users/me', '');
      calls.push({ kind: 'gmail', box, path, method: init.method || 'GET', q: u.searchParams.get('q') });
      const mine = store.filter((m) => m.box === box);
      if (path === '/messages') {
        const q = u.searchParams.get('q') || '';
        const after = Number(/after:(\d+)/.exec(q)?.[1] || 0) * 1000;
        const before = Number(/before:(\d+)/.exec(q)?.[1] || Infinity) * 1000;
        const who = [...q.matchAll(/(?:from|to|cc):(\S+?)(?=\)|\s|$)/g)].map((x) => x[1]);
        const hits = mine.filter((m) => Number(m.internalDate) > after && Number(m.internalDate) < before)
          .filter((m) => !who.length || who.some((e) => m.payload.headers.some((h) => ['From', 'To', 'Cc'].includes(h.name) && h.value.toLowerCase().includes(e))))
          .sort((a, b) => b.internalDate - a.internalDate);
        return Response.json({ messages: hits.map((m) => ({ id: m.id })), resultSizeEstimate: hits.length });
      }
      let m;
      if ((m = /^\/messages\/(\w+)\/attachments\/(.+)$/.exec(path))) {
        const msg = mine.find((x) => x.id === m[1]);
        const i = Number(decodeURIComponent(m[2]).split('-').pop());
        return Response.json({ data: b64u(msg._files[i].data) });
      }
      if ((m = /^\/messages\/(\w+)$/.exec(path))) {
        const msg = mine.find((x) => x.id === m[1]);
        if (!msg) return Response.json({ error: { message: 'not found' } }, { status: 404 });
        const { box: _b, _files, ...clean } = msg;
        return Response.json(u.searchParams.get('format') === 'metadata' ? { ...clean, payload: { headers: clean.payload.headers } } : clean);
      }
      if ((m = /^\/threads\/(\w+)$/.exec(path))) return Response.json({ id: m[1], messages: mine.filter((x) => x.threadId === m[1]).map((x) => ({ id: x.id, payload: { headers: x.payload.headers } })) });
    }
    if (url === 'https://api.resend.com/emails') {
      const body = JSON.parse(init.body);
      calls.push({ kind: 'resend', body });
      return resendOk ? Response.json({ id: 'em1' }) : new Response('down', { status: 500 });
    }
    if (url === 'https://api.jobtread.com/pave') {
      const { query } = JSON.parse(init.body);
      if (query.createUploadRequest) {
        calls.push({ kind: 'upload', input: query.createUploadRequest.$ });
        return Response.json({ createUploadRequest: { createdUploadRequest: { id: `up${calls.length}`, url: 'https://uploads.example/put', method: 'PUT', headers: {} } } });
      }
      if (query.createComment) {
        const id = `cm${calls.filter((c) => c.kind === 'comment').length + 1}`;
        calls.push({ kind: 'comment', input: query.createComment.$, grant: query.$.grantKey, id });
        return Response.json({ createComment: { createdComment: { id } } });
      }
    }
    if (url === 'https://uploads.example/put') return new Response(null, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const rows = async () => (await env.DB.prepare('SELECT mailbox, id, kind, state, detail, source FROM mail_sweep ORDER BY at').all()).results;
const byId = async (id) => (await rows()).filter((r) => r.id === id);
const of = (kind) => calls.filter((c) => c.kind === kind);

test('triage: receipts, shipping, ads, staff mail, money tools, calendar replies, families, caseworkers and mailings', async () => {
  const fam = await familyAddresses(env.DB);
  const t = (o) => triage(mail({ box: PAT, at: T0, to: PAT, text: '', ...o }), fam);
  assert.deepEqual(t({ from: 'Wayfair <orders@wayfair.example>', subject: 'Thanks for your order! #123' }), { kind: 'receipt' });
  assert.deepEqual(t({ from: 'Studio <billing@studio.example>', subject: 'Invoice 4410 from Studio' }), { kind: 'receipt' });
  assert.equal(t({ from: 'Wayfair <orders@wayfair.example>', subject: 'Your order has shipped' }), null);
  assert.equal(t({ from: 'CB2 <hi@cb2.example>', subject: 'DELIVERED: Your order 147790499' }), null);
  assert.equal(t({ from: 'Pottery Barn <hi@pb.example>', subject: 'Your cart misses you (+ 20% off)' }), null);
  assert.equal(t({ from: 'Holly <holly@soardcharity.com>', subject: 'Receipt for the paint' }), null, 'mail between staff');
  assert.equal(t({ from: 'Ramp <no-reply@ramp.com>', subject: 'Bill payment delivered: Pulley #10311' }), null, 'the money tools’ own notices');
  assert.equal(t({ from: 'Wayfair <orders@wayfair.example>', subject: 'Thanks for your order', labels: ['SENT'] }), null);
  assert.equal(t({ from: 'Dan <dad@example.com>', subject: "Accepted: Max's Reveal Day (tentative) @ Mon Nov 2" }), null, 'calendar replies');
  assert.deepEqual(t({ from: 'Dan <dad@example.com>', subject: 'Question about the room' }), { kind: 'family', accounts: ['acctRivera1'] });
  assert.deepEqual(t({ from: `Pat <${PAT}>`, to: 'kim@example.com', subject: 'Paint colors', labels: ['SENT'] }), { kind: 'family', accounts: ['acctKim0002'] });
  assert.equal(t({ from: 'Case Worker <cw@example.org>', subject: 'Checking in' }), null, 'an address on two families points at neither');
  const invite = 'Re: Invitation: TENTATIVE: Max’s Reveal! @ Fri Sep 25, 2026';
  assert.equal(t({ from: 'A Board Member <board@example.net>', to: `${PAT}, parent@example.com, kim@example.com`, subject: invite }), null, 'another guest replying all on a reveal invite');
  assert.deepEqual(t({ from: 'Ana Rivera <parent@example.com>', to: PAT, subject: invite }), { kind: 'family', accounts: ['acctRivera1'] }, 'the family’s own reply counts');
  assert.deepEqual(t({ from: `Pat <${PAT}>`, to: 'parent@example.com, board@example.net', subject: `Re: ${invite}`, labels: ['SENT'] }), { kind: 'family', accounts: ['acctRivera1'] }, 'and so does staff’s');
  assert.equal(t({ from: 'JobTread <notifications@jobtread.com>', to: 'parent@example.com', subject: 'New message' }), null, 'JobTread already has it');
});

test('a TEST account’s addresses never count as a family', async () => {
  await env.DB.prepare('INSERT INTO applicants (account_id, name, contact_email, contacts) VALUES (?, ?, ?, ?)').bind('acctTest001', 'TEST Family (Pat)', 'pat.home@example.net', '[]').run();
  const fam = await familyAddresses(env.DB);
  assert.equal(fam.byEmail.has('pat.home@example.net'), false);
  assert.equal(fam.names.has('acctTest001'), false);
  assert.equal(fam.byEmail.get('parent@example.com')[0], 'acctRivera1');
});

test('withoutQuoted keeps the email’s own words and cuts the history', () => {
  assert.equal(withoutQuoted('Sounds good!\n\nOn Mon, Oct 20, 2026 at 3:15 PM Pat Lee <pat@soardcharity.com>\nwrote:\n> earlier'), 'Sounds good!');
  assert.equal(withoutQuoted('Yes please\nOn Tue, Oct 21, 2026, Dan wrote:\n> hi'), 'Yes please');
  assert.equal(withoutQuoted('Thanks\n-----Original Message-----\nFrom: x'), 'Thanks');
  assert.equal(withoutQuoted('Here it is\n\n---------- Forwarded message ---------\nFrom: Store\nOrder 1'), 'Here it is\n\n---------- Forwarded message ---------\nFrom: Store\nOrder 1');
  assert.equal(withoutQuoted('> only quoted'), '> only quoted', 'nothing of its own: the whole text');
});

function seed() {
  const pdf = { name: 'order-123.pdf', type: 'application/pdf', data: '%PDF receipt' };
  const r1 = mail({ box: PAT, at: T0 - 5 * MIN, from: 'Wayfair <orders@wayfair.example>', to: PAT, subject: 'Thanks for your order #123', text: 'Bunk bed $899.00 charged to Visa', files: [pdf, { name: 'logo.png', type: 'image/png', data: 'x', inline: true }] });
  mail({ box: PAT, at: T0 - 4 * MIN, from: 'Wayfair <orders@wayfair.example>', to: PAT, subject: 'Your order has shipped', text: 'On its way' });
  const r3 = mail({ box: PAT, at: T0 - 3 * MIN, from: 'Lumber <sales@lumber.example>', to: PAT, cc: 'ap@soardcharity.com', subject: 'Your receipt from Lumber', text: '$120.00 paid' });
  const r4 = mail({ box: PAT, at: T0 - 2 * MIN, from: 'Shop <orders@shop.example>', to: PAT, subject: 'Your order confirmation', text: 'Groceries $54.00, shipped to your home' });
  const old = mail({ box: PAT, at: T0 - 30 * DAY, from: 'Store <orders@store.example>', to: PAT, subject: 'Your receipt from Store', text: '$10.00' });
  const f1 = mail({ box: PAT, at: T0 - 60 * DAY, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Photos of the room', text: 'Here is the room!\n\nThanks, Ana', msgid: '<f1@mail.example>', files: [{ name: 'room.jpg', type: 'image/jpeg', data: 'jpegbytes', size: 200000 }] });
  const f2 = mail({ box: PAT, at: T0 - 59 * DAY, from: `Pat Lee <${PAT}>`, to: 'parent@example.com', subject: 'Re: Photos of the room', text: 'Got them, thank you!\n\nOn Mon, Sep 3, 2026 Ana Rivera <parent@example.com> wrote:\n> Here is the room!', refs: '<f1@mail.example>', labels: ['SENT'] });
  mail({ box: PAT, at: T0 - 10 * DAY, from: 'Dan <dad@example.com>', to: PAT, subject: "Accepted: Max's Reveal Day (tentative)", text: '' });
  const f1copy = mail({ box: SAM, at: T0 - 60 * DAY, from: 'Ana Rivera <parent@example.com>', to: `${PAT}, ${SAM}`, subject: 'Photos of the room', text: 'Here is the room!', msgid: '<f1@mail.example>' });
  const r5a = mail({ box: SAM, at: T0 - 20 * MIN, from: `Sam Fox <${SAM}>`, to: 'ap@soardcharity.com', subject: 'Fwd: Paint receipt', text: 'fwd', thread: 'thPaint', labels: ['SENT'] });
  const r5 = mail({ box: SAM, at: T0 - MIN, from: 'Paint Co <orders@paint.example>', to: SAM, subject: 'Re: Paint receipt', text: '$66.00 paid', thread: 'thPaint' });
  aiVerdicts['Thanks for your order #123'] = { type: 'receipt', vendor: 'Wayfair', total: '$899.00', date: '2026-11-02', personal: false, reason: 'an order confirmation' };
  aiVerdicts['Your order confirmation'] = { type: 'receipt', vendor: 'Shop', total: '$54.00', date: '', personal: true, reason: 'groceries shipped home' };
  aiVerdicts['Re: Paint receipt'] = { type: 'receipt', vendor: 'Paint Co', total: '$66.00', personal: false, reason: 'paid' };
  return { r1, r3, r4, old, f1, f2, f1copy, r5, r5a };
}

test('the first day only watches: what it would do is listed, nothing is sent or posted', async () => {
  const m = seed();
  const st = await maybeSweepMail(env, { now: T0, force: true });
  assert.ok(st && !st.error, st?.error);
  assert.equal(st.watchUntil, T0 + WATCH_MS);
  assert.equal(of('resend').length, 0);
  assert.equal(of('comment').length, 0);
  assert.equal(of('upload').length, 0);
  assert.ok(of('gmail').every((c) => c.method === 'GET'), 'Gmail is only read');

  assert.equal((await byId(m.r1.id))[0].state, 'would');
  assert.match((await byId(m.r1.id))[0].detail, /would send Wayfair \$899\.00 to ap@soardcharity\.com/);
  assert.equal((await byId(m.r3.id))[0].detail, 'already at the receipt inbox');
  assert.match((await byId(m.r4.id))[0].detail, /^personal: groceries/);
  assert.equal((await byId(m.r5.id))[0].detail, 'its conversation already went to the receipt inbox');
  assert.equal((await byId(m.old.id)).length, 0, 'receipts only from the start: older ones were forwarded by hand');
  assert.equal((await byId(m.f1.id))[0].source, 'backfill');
  assert.equal((await byId(m.f1.id))[0].state, 'would');
  assert.match((await byId(m.f1.id))[0].detail, /would add to Rivera Family with a file/);
  assert.equal((await byId(m.f1copy.id))[0].state, 'duplicate');
  assert.equal((await rows()).filter((r) => /Accepted/.test(r.detail || '')).length, 0);

  const s = await mailSweepStatus(env);
  assert.equal(s.backfillDone, true);
  assert.equal(s.inboxes, 2);
  assert.ok(s.counts.receipt.would >= 1 && s.counts.family.would >= 2);
  assert.ok(s.recent.every((r) => !('subject' in r)), 'Automations shows names, not subjects');
});

test('after the watch: receipts go to the receipt inbox, family emails become hidden comments, replies under the first', async () => {
  const m = seed();
  await maybeSweepMail(env, { now: T0, force: true });
  calls.length = 0;
  await maybeSweepMail(env, { now: T0 + WATCH_MS + MIN, force: true });

  const sent = of('resend');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.to, ['ap@soardcharity.com']);
  assert.equal(sent[0].body.subject, 'Receipt: Wayfair $899.00 on 2026-11-02 (from Pat’s email)');
  assert.deepEqual(sent[0].body.attachments.map((a) => a.filename), ['order-123.pdf'], 'the receipt’s file, not the signature logo');
  assert.equal(Buffer.from(sent[0].body.attachments[0].content, 'base64').toString(), '%PDF receipt');
  assert.match(sent[0].body.text, /found in Pat Lee’s email \(pat@soardcharity\.com\)[\s\S]*Bunk bed \$899\.00/);

  const comments = of('comment');
  assert.equal(comments.length, 2, 'the same email in two inboxes is posted once');
  const [root, reply] = comments;
  assert.equal(root.input.targetId, 'acctRivera1');
  assert.equal(root.input.targetType, 'account');
  assert.equal(root.input.name, 'Email: Photos of the room');
  assert.equal(root.input.isVisibleToCustomerRoles, false);
  assert.equal(root.input.assignees, undefined, 'nobody assigned, so JobTread emails no one');
  assert.equal(root.grant, 'grant-main');
  assert.match(root.input.message, /^Email, .* \(from Pat Lee’s inbox\)\nFrom: Ana Rivera <parent@example\.com>[\s\S]*Here is the room!\n\nThanks, Ana\n\nFiles: room\.jpg$/);
  assert.equal(root.input.files.length, 1);
  assert.equal(reply.input.parentCommentId, root.id, 'the reply goes under the first email');
  assert.equal(reply.input.name, undefined);
  assert.match(reply.input.message, /Got them, thank you!$/, 'the quoted history is cut');
  assert.equal(of('upload')[0].input.type, 'image/jpeg');

  assert.equal((await byId(m.r1.id))[0].state, 'sent');
  const logged = await env.DB.prepare('SELECT type, to_addr, status FROM email_log').all();
  assert.deepEqual(logged.results, [{ type: 'receipt-from-inbox', to_addr: 'ap@soardcharity.com', status: 'sent' }], 'Resend’s reports on it can land');
  await env.DB.prepare("UPDATE email_log SET status = 'bounced', detail = 'The group only takes mail from members', status_at = ?").bind(new Date(T0 + WATCH_MS + 2 * MIN).toISOString()).run();
  assert.deepEqual((await mailSweepStatus(env)).lastSent, { to: 'ap@soardcharity.com', status: 'bounced', at: new Date(T0 + WATCH_MS + 2 * MIN).toISOString(), detail: 'The group only takes mail from members' });
  assert.equal((await byId(m.f1.id))[0].state, 'posted');
  assert.equal((await byId(m.f2.id))[0].state, 'posted');

  // Nothing twice: the next sweeps find nothing new to do
  calls.length = 0;
  await maybeSweepMail(env, { now: T0 + WATCH_MS + 5 * MIN, force: true });
  assert.equal(of('resend').length + of('comment').length, 0);
});

test('an email queued under older rules is sorted again before anything is done with it', async () => {
  const chatter = mail({ box: PAT, at: T0 - 40 * DAY, from: 'A Board Member <board@example.net>', to: `${PAT}, parent@example.com`, subject: 'Re: Invitation: TENTATIVE: Max’s Reveal!', text: 'Can’t wait!' });
  await maybeSweepMail(env, { now: T0, force: true });
  await env.DB.prepare(`INSERT INTO mail_sweep (mailbox, id, at, kind, state, accounts, source, updated_at) VALUES (?, ?, ?, 'family', 'queued', '["acctRivera1"]', 'backfill', ?)`)
    .bind(PAT, chatter.id, new Date(T0 - 40 * DAY).toISOString(), new Date(T0).toISOString()).run();
  await maybeSweepMail(env, { now: T0 + WATCH_MS + MIN, force: true });
  assert.deepEqual((await byId(chatter.id)).map((r) => [r.state, r.detail]), [['skipped', 'not a family email after all']]);
  assert.ok(!of('comment').some((c) => /Can’t wait/.test(c.input.message)));
});

test('new mail after the start is picked up; a failed send is tried again later', async () => {
  seed();
  await maybeSweepMail(env, { now: T0, force: true });
  await maybeSweepMail(env, { now: T0 + WATCH_MS + MIN, force: true });
  const later = T0 + WATCH_MS + 2 * MIN;
  const r = mail({ box: SAM, at: later, from: 'Fabric <orders@fabric.example>', to: SAM, subject: 'Your receipt from Fabric', text: 'Curtains $45.10' });
  aiVerdicts['Your receipt from Fabric'] = { type: 'receipt', vendor: 'Fabric', total: '$45.10', date: '', personal: false, reason: 'receipt' };
  resendOk = false;
  calls.length = 0;
  await maybeSweepMail(env, { now: later + MIN, force: true });
  assert.equal((await byId(r.id))[0].state, 'failed');
  resendOk = true;
  await maybeSweepMail(env, { now: later + 2 * MIN, force: true });
  assert.equal((await byId(r.id))[0].state, 'failed', 'not retried straight away');
  await maybeSweepMail(env, { now: later + 15 * MIN, force: true });
  assert.equal((await byId(r.id))[0].state, 'sent');
  assert.equal(of('resend').filter((c) => /Fabric/.test(c.body.subject)).length, 2);
});

test('the heartbeat: every 3 minutes when there’s nothing waiting, never without the Google key', async () => {
  assert.ok(await maybeSweepMail(env, { now: T0 }));
  assert.equal(await maybeSweepMail(env, { now: T0 + MIN }), null);
  assert.ok(await maybeSweepMail(env, { now: T0 + 4 * MIN }));
  assert.equal(await maybeSweepMail({ ...env, GOOGLE_CALENDAR_KEY: '' }, { now: T0 + 10 * MIN }), null);
});
