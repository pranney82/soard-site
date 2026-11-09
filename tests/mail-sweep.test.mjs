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
import { maybeSweepMail, mailSweepStatus, triage, senderOf, withoutQuoted, familyAddresses, receiptText, judgeReceipt, amountsIn, WATCH_MS } from '../functions/api/_mail-sweep.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { forgetRampToken } from '../functions/api/_ramp.js';

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM });

const T0 = Date.parse('2026-11-02T15:00:00Z');
const MIN = 60e3, DAY = 86400e3, BRAKE_AGE = 3 * DAY;
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
  const m = { box, id: id || `msg${String(n).padStart(4, '0')}`, threadId: thread || `th${n}`, internalDate: String(at), labelIds: labels, snippet: (text || html || '').replace(/<[^>]+>/g, '').slice(0, 80), payload: { partId: '', mimeType: 'multipart/mixed', headers, parts }, _files: files, _words: `${subject} ${text || ''} ${html || ''}` };
  store.push(m);
  return m;
}

let env, store, calls, resendOk, aiVerdicts, aboutVerdicts, refuseScopes, rampTxns, rampUsers, photoReads;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  seq = 0;
  store = [];
  calls = [];
  resendOk = true;
  aiVerdicts = {};
  photoReads = {};
  refuseScopes = new Set();
  rampTxns = [];
  rampUsers = [{ id: 'u-pat', email: PAT }, { id: 'u-sam', email: SAM }, { id: 'u-samstore', email: 'sam@store.example' }];
  forgetRampToken();
  aboutVerdicts = {};
  env = {
    DB: await createD1(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT, RESEND_API_KEY: 're_test', JOBTREAD_GRANT_KEY: 'grant-main',
    AI: { run: async (model, { messages }) => {
      // A photo read (an email to ap@): photoReads by words in the picture, per reader when it's a function
      if (Array.isArray(messages[1].content)) {
        const url = messages[1].content.find((x) => x.type === 'image_url').image_url.url;
        const said = Buffer.from(url.split(',')[1], 'base64').toString('latin1');
        const key = Object.keys(photoReads).find((k) => said.includes(k));
        calls.push({ kind: 'photo', model, key });
        const r = typeof photoReads[key] === 'function' ? photoReads[key](model) : photoReads[key];
        return { response: r || { type: 'not_receipt', vendor: '', total: '', date: '', reason: 'a room' } };
      }
      const subject = /Subject: (.*)/.exec(messages[1].content)?.[1] || '';
      // Is it about the kid or the project? Yes unless the test says otherwise
      if (/belongs on that record/.test(messages[0].content)) {
        calls.push({ kind: 'about', subject, input: messages[1].content });
        return { response: aboutVerdicts[subject] || { about: true, reason: 'about the room' } };
      }
      calls.push({ kind: 'ai', subject });
      return { response: aiVerdicts[subject] || { type: 'not_receipt', reason: 'an ad' } };
    } },
  };
  await env.DB.exec('CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  await env.DB.exec('CREATE TABLE applicants (account_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, fields TEXT, created_at TEXT, contact_name TEXT, contact_email TEXT, contacts TEXT)');
  // Approved a while ago, so the last year of their email comes in
  for (const [id, name, email, contacts] of FAMILIES) await env.DB.prepare("INSERT INTO applicants (account_id, name, status, fields, created_at, contact_email, contacts) VALUES (?, ?, 'Approved', '{\"birthday\":\"2016-04-01\"}', '2026-01-05T15:00:00Z', ?, ?)").bind(id, name, email, JSON.stringify(contacts)).run();
  clearTokenCache();

  globalThis.fetch = async function (input, init = {}) {
    // Like Cloudflare's fetch: called as some object's method, it refuses
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      if (refuseScopes.has(claims.scope)) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 });
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
        const said = [...q.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        const hits = mine.filter((m) => Number(m.internalDate) > after && Number(m.internalDate) < before)
          .filter((m) => !/(^|\s)-in:drafts\b/.test(q) || !m.labelIds.includes('DRAFT'))
          // Spam only when the search names its group (list:) and the email is that group's copy
          .filter((m) => !m.labelIds.includes('SPAM') || [...q.matchAll(/list:(\S+?)(?=\)|\s|$)/g)].some((x) => m.payload.headers.some((h) => h.name === 'List-Id' && h.value.includes(`<${x[1].replace('@', '.')}>`))))
          .filter((m) => !who.length || who.some((e) => m.payload.headers.some((h) => ['From', 'To', 'Cc'].includes(h.name) && h.value.toLowerCase().includes(e))))
          .filter((m) => !said.length || said.some((w) => m._words.includes(w)))
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
        const { box: _b, _files, _words, ...clean } = msg;
        return Response.json(u.searchParams.get('format') === 'metadata' ? { ...clean, payload: { headers: clean.payload.headers } } : clean);
      }
      if ((m = /^\/messages\/(\w+)\/modify$/.exec(path))) return Response.json({ id: m[1], ...JSON.parse(init.body) });
      if ((m = /^\/threads\/(\w+)$/.exec(path))) return Response.json({ id: m[1], messages: mine.filter((x) => x.threadId === m[1]).map((x) => ({ id: x.id, payload: { headers: x.payload.headers } })) });
    }
    if (url.startsWith('https://api.ramp.com/developer/v1/')) {
      const u = new URL(url);
      const path = u.pathname.replace('/developer/v1', '');
      if (path === '/token') {
        const scope = new URLSearchParams(init.body).get('scope');
        calls.push({ kind: 'ramp-token', scope });
        if (refuseScopes.has(scope)) return new Response('{"error":"invalid_scope"}', { status: 400 });
        return Response.json({ access_token: `ramp:${scope}`, expires_in: 3600 });
      }
      if (path === '/users') return Response.json({ data: rampUsers });
      if (path.startsWith('/transactions/')) return Response.json(rampTxns.find((t) => t.id === path.split('/').pop()) || {});
      if (path === '/transactions') {
        const from = Date.parse(u.searchParams.get('from_date')), to = u.searchParams.get('to_date') ? Date.parse(u.searchParams.get('to_date')) : Infinity;
        return Response.json({ data: rampTxns.filter((t) => Date.parse(t.user_transaction_time) >= from && Date.parse(t.user_transaction_time) <= to) });
      }
      if (path === '/receipts' && init.method === 'POST') {
        const f = init.body;
        calls.push({ kind: 'ramp-receipt', transaction: f.get('transaction_id'), user: f.get('user_id'), key: f.get('idempotency_key'), file: f.get('receipt')?.name });
        return Response.json({ id: 'rcpt1' }, { status: 201 });
      }
    }
    if (url.startsWith('https://mercury-relay.sunshineonaranneyday.com/api/v1/')) {
      const file = init.body instanceof FormData ? init.body.get('file') : null;
      calls.push({ kind: 'mercury', path: new URL(url).pathname.replace('/api/v1', ''), method: init.method || 'GET', file: file?.name, type: file?.type, attachmentType: init.body instanceof FormData ? init.body.get('attachmentType') : null });
      return Response.json({});
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
  assert.deepEqual(t({ from: 'Walmart <help@walmart.example>', subject: 'Thanks for your delivery order, Pat' }), { kind: 'receipt' });
  assert.deepEqual(t({ from: 'Etsy <transaction@etsy.example>', subject: 'Your Etsy Purchase from PrintShop (4223036227)' }), { kind: 'receipt' });
  assert.equal(t({ from: 'Etsy <deals@etsy.example>', subject: '15% off your next purchase' }), null);
  assert.equal(t({ from: 'Wayfair <orders@wayfair.example>', subject: 'Your order has shipped' }), null);
  assert.equal(t({ from: 'CB2 <hi@cb2.example>', subject: 'DELIVERED: Your order 147790499' }), null);
  assert.equal(t({ from: 'Pottery Barn <hi@pb.example>', subject: 'Your cart misses you (+ 20% off)' }), null);
  assert.equal(t({ from: 'Holly <holly@soardcharity.com>', subject: 'Receipt for the paint' }), null, 'mail between staff');
  assert.equal(t({ from: 'Ramp <no-reply@ramp.com>', subject: 'Bill payment delivered: Pulley #10311' }), null, 'the money tools’ own notices');
  assert.equal(t({ from: 'Wayfair <orders@wayfair.example>', subject: 'Thanks for your order', labels: ['SENT'] }), null);
  assert.equal(t({ from: 'Dan <dad@example.com>', subject: "Accepted: Max's Reveal Day (tentative) @ Mon Nov 2" }), null, 'calendar replies');
  assert.deepEqual(t({ from: 'Dan <dad@example.com>', subject: 'Question about the room' }), { kind: 'family', accounts: ['acctRivera1'] });
  assert.deepEqual(t({ from: `Pat <${PAT}>`, to: 'kim@example.com', subject: 'Paint colors', labels: ['SENT'] }), { kind: 'family', accounts: ['acctKim0002'] });
  assert.equal(t({ from: `Pat <${PAT}>`, to: 'kim@example.com', subject: 'Paint colors', labels: ['DRAFT'] }), null, 'a draft to a family');
  assert.equal(t({ from: `Pat <${PAT}>`, to: PAT, subject: 'Receipt [receipt 12]', labels: ['DRAFT'] }), null, 'a draft of a tagged receipt');
  assert.equal(t({ from: 'Case Worker <cw@example.org>', subject: 'Checking in' }), null, 'an address on two families points at neither');
  const listed = (extra) => { const m = mail({ box: PAT, at: T0, from: 'Ana <parent@example.com>', to: PAT, subject: 'Black Friday Presale', text: '' }); m.payload.headers.push(...extra); return triage(m, fam); };
  assert.equal(listed([{ name: 'List-Unsubscribe', value: '<https://shop.example/unsub>' }]), null, 'a family’s business newsletter');
  assert.deepEqual(listed([{ name: 'List-Id', value: '<info.soardcharity.com>' }, { name: 'List-Unsubscribe', value: '<mailto:googlegroups-manage+1+unsubscribe@soardcharity.com>' }]), { kind: 'family', accounts: ['acctRivera1'] }, 'a family writing to info@ (SOARD’s own group)');
  const invite = 'Re: Invitation: TENTATIVE: Max’s Reveal! @ Fri Sep 25, 2026';
  assert.equal(t({ from: 'A Board Member <board@example.net>', to: `${PAT}, parent@example.com, kim@example.com`, subject: invite }), null, 'another guest replying all on a reveal invite');
  assert.deepEqual(t({ from: 'Ana Rivera <parent@example.com>', to: PAT, subject: invite }), { kind: 'family', accounts: ['acctRivera1'] }, 'the family’s own reply counts');
  assert.deepEqual(t({ from: `Pat <${PAT}>`, to: 'parent@example.com, board@example.net', subject: `Re: ${invite}`, labels: ['SENT'] }), { kind: 'family', accounts: ['acctRivera1'] }, 'and so does staff’s');
  assert.equal(t({ from: 'JobTread <notifications@jobtread.com>', to: 'parent@example.com', subject: 'New message' }), null, 'JobTread already has it');
  const crowd = Array.from({ length: 12 }, (_, i) => `friend${i}@example.net`).join(', ');
  assert.equal(t({ from: 'Nicole Photography <nicole@photo.example>', to: `${crowd}, parent@example.com`, subject: 'Fall Evening Mini Sessions' }), null, 'a photographer’s promo with a family among 13 people');
  assert.equal(t({ from: 'Jess <jess@example.net>', to: 'nicole@photo.example', cc: `${crowd}, parent@example.com`, subject: 'Re: Fall Evening Mini Sessions' }), null, 'and a reply-all on it');
  assert.deepEqual(t({ from: 'Ana Rivera <parent@example.com>', to: `${PAT}, ${crowd}`, subject: 'Our room is done!' }), { kind: 'family', accounts: ['acctRivera1'] }, 'the family writing to many still counts');
  assert.deepEqual(t({ from: `Pat <${PAT}>`, to: `parent@example.com, ${crowd}`, subject: 'Demo day crew', labels: ['SENT'] }), { kind: 'family', accounts: ['acctRivera1'] }, 'and so does staff writing to many');
  assert.deepEqual(t({ from: 'Ryan <ryan@studio.example>', to: `${PAT}, parent@example.com, a@studio.example, b@studio.example`, subject: 'Updated project slides' }), { kind: 'family', accounts: ['acctRivera1'] }, 'a designer writing to a few, the family among them');
});

test('on a family’s account only the family counts; on an organization’s, everyone on it', async () => {
  const add = (id, name, main, contacts) => env.DB.prepare('INSERT INTO applicants (account_id, name, contact_email, contacts) VALUES (?, ?, ?, ?)').bind(id, name, main, JSON.stringify(contacts)).run();
  await add('acctYork001', 'Isla Sample', 'coord@wish.example.org', [
    { name: 'Emily', title: 'Senior Wish Coordinator', email: 'coord@wish.example.org' }, { name: 'Erin', title: 'Mothe', email: 'erin@gmail.com' },
    { name: 'Jay', title: '', email: 'jay@gmail.com' }, { name: 'Abby', title: 'Designer', email: 'abby@studio.example' }, { name: 'Lee', title: '', email: 'lee@work.example' }]);
  await add('acctSchool1', 'The Sample School', 'dev@school.example.org', [{ name: 'Dana', title: 'Development Officer', email: 'dev@school.example.org' }]);
  const fam = await familyAddresses(env.DB);
  assert.deepEqual(['coord@wish.example.org', 'erin@gmail.com', 'jay@gmail.com', 'abby@studio.example', 'lee@work.example'].map((e) => fam.byEmail.has(e)), [false, true, true, false, false]);
  assert.deepEqual(fam.byEmail.get('dev@school.example.org'), ['acctSchool1']);
  const t = (o) => triage(mail({ box: PAT, at: T0, to: PAT, text: '', ...o }), fam);
  assert.equal(t({ from: 'Emily <coord@wish.example.org>', subject: 'Isla In-kind!' }), null, 'the wish coordinator’s threads aren’t the family’s');
  assert.equal(t({ from: 'Erin <erin@gmail.com>', subject: '*Out of Office* Re: Paint colors' }), null, 'auto-replies never count');
  assert.deepEqual(t({ from: 'Erin <erin@gmail.com>', subject: 'Re: Paint colors' }), { kind: 'family', accounts: ['acctYork001'] });
});

test('a TEST account’s addresses never count as a family', async () => {
  await env.DB.prepare('INSERT INTO applicants (account_id, name, contact_email, contacts) VALUES (?, ?, ?, ?)').bind('acctTest001', 'TEST Family (Pat)', 'pat.home@example.net', '[]').run();
  const fam = await familyAddresses(env.DB);
  assert.equal(fam.byEmail.has('pat.home@example.net'), false);
  assert.equal(fam.names.has('acctTest001'), false);
  assert.equal(fam.byEmail.get('parent@example.com')[0], 'acctRivera1');
});

test('staff’s own mail never goes on an account, even from the personal addresses staff put on a try of the form', async () => {
  const add = (id, name, mainName, main, contacts) => env.DB.prepare('INSERT INTO applicants (account_id, name, contact_name, contact_email, contacts) VALUES (?, ?, ?, ?, ?)').bind(id, name, mainName, main, JSON.stringify(contacts)).run();
  // Pat and Sam fill in the form as Mom and Dad, with their own Gmail
  await add('acctPets001', 'Belly Rubs Lee', 'Pat Lee', 'patlee@gmail.com', [{ name: 'Pat Lee', title: 'Mom', email: 'patlee@gmail.com' }, { name: 'Sam Fox', title: 'Dad', email: 'samfox@gmail.com' }]);
  // A real family that also lists Sam (a friend helping out) and Pat's middle initial on another try
  await add('acctReal001', 'Ortiz Family', 'Rosa Ortiz', 'rosa@gmail.com', [{ name: 'Rosa Ortiz', title: 'Mother', email: 'rosa@gmail.com' }, { name: 'Sam Fox', title: '', email: 'samfox@gmail.com' }]);
  await add('acctPets002', 'Second Try', '', 'pat.lee.home@yahoo.com', [{ name: 'Pat Q. Lee', title: 'Parent', email: 'pat.lee.home@yahoo.com' }]);
  await env.DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id IN ('acctReal001', 'acctPets001')").run();
  const fam = await familyAddresses(env.DB, { staff: ['Pat Lee', 'Sam Fox'] });
  assert.deepEqual(['patlee@gmail.com', 'samfox@gmail.com', 'pat.lee.home@yahoo.com'].map((e) => fam.byEmail.has(e)), [false, false, false]);
  assert.equal(fam.names.has('acctPets001'), false);
  assert.equal(fam.names.has('acctPets002'), false);
  assert.deepEqual(fam.byEmail.get('rosa@gmail.com'), ['acctReal001'], 'the real family still counts');

  // A year of Pat's mail with their own Gmail: none of it goes to JobTread
  mail({ box: PAT, at: T0 - 30 * DAY, from: 'Pat Lee <patlee@gmail.com>', to: PAT, subject: 'Fwd: Report card', text: 'For the file' });
  mail({ box: PAT, at: T0 - 20 * DAY, from: `Pat <${PAT}>`, to: 'samfox@gmail.com', subject: 'Mortgage', text: 'Paid', labels: ['SENT'] });
  mail({ box: PAT, at: T0 - 10 * DAY, from: 'Rosa Ortiz <rosa@gmail.com>', to: PAT, subject: 'Room ideas', text: 'Blue walls' });
  await maybeSweepMail(env, { now: T0, force: true });
  await maybeSweepMail(env, { now: T0 + WATCH_MS + MIN, force: true });
  assert.deepEqual(of('comment').map((c) => [c.input.targetId, c.input.name]), [['acctReal001', 'Email: Room ideas']]);
});

test('staff’s own address goes by the name on it, even on an account that lists it under another name', async () => {
  await env.DB.prepare("INSERT INTO applicants (account_id, name, status, contact_name, contact_email, contacts) VALUES ('acctFake001', 'Bob Smith', 'Approved', 'Bob Smith', 'patlee@gmail.com', ?)")
    .bind(JSON.stringify([{ name: 'Bob Smith', title: 'Dad', email: 'patlee@gmail.com' }])).run();
  const fam = await familyAddresses(env.DB, { staff: ['Pat Lee', 'Sam Fox'] });
  assert.deepEqual(fam.byEmail.get('patlee@gmail.com'), ['acctFake001'], 'the account alone can’t tell');
  const t = (o) => triage(mail({ box: PAT, at: T0, to: PAT, text: '', ...o }), fam);
  assert.equal(t({ from: 'Pat Lee <patlee@gmail.com>', subject: 'Fwd: Mortgage statement' }), null, 'Pat’s own Gmail, by Pat’s name on it');
  assert.equal(t({ from: `Pat <${PAT}>`, to: '"Pat Lee" <patlee@gmail.com>', subject: 'note to self', labels: ['SENT'] }), null);
  assert.deepEqual(t({ from: 'Bob <patlee@gmail.com>', subject: 'Room question' }), { kind: 'family', accounts: ['acctFake001'] }, 'without the name, the brake and the check are what stop it');
  assert.deepEqual(t({ from: 'Pat Lee <patlee@gmail.com>', subject: 'Your receipt from Paint Co' }), { kind: 'receipt' }, 'a receipt Pat forwards from home still counts');
});

test('the check: only email about the kid or project goes on; a reply in a conversation already there isn’t asked again; no answer, nothing posted', async () => {
  const f1 = mail({ box: PAT, at: T0 - 60 * DAY, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Photos of the room', text: 'Here is the room!', msgid: '<f1@mail.example>' });
  const f2 = mail({ box: PAT, at: T0 - 59 * DAY, from: `Pat Lee <${PAT}>`, to: 'parent@example.com', subject: 'Re: Photos of the room', text: 'Got them!', refs: '<f1@mail.example>', labels: ['SENT'] });
  const promo = mail({ box: PAT, at: T0 - 30 * DAY, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Black Friday at my shop', text: '20% off candles' });
  aboutVerdicts['Black Friday at my shop'] = { about: false, reason: 'a promotion for her business' };
  await maybeSweepMail(env, { now: T0, force: true });
  calls.length = 0;
  await maybeSweepMail(env, { now: T0 + WATCH_MS + MIN, force: true });
  assert.deepEqual(of('comment').map((c) => c.input.name || 'reply'), ['Email: Photos of the room', 'reply']);
  assert.deepEqual(of('about').map((c) => c.subject), ['Photos of the room'], 'the reply rides on its conversation (the promo was settled during the watch)');
  assert.match(of('about')[0].input, /^Record: Rivera Family \(a child SOARD is helping, and their family\)\nInbox of: Pat Lee\nFrom: Ana Rivera <parent@example\.com>/);
  assert.deepEqual((await byId(promo.id)).map((r) => [r.state, r.detail]), [['skipped', 'not about Rivera Family: a promotion for her business']]);

  // Every comment it made is on record, the reply's own as well as its conversation's
  const rec = async (id) => env.DB.prepare('SELECT comment_ids, posted_ids FROM mail_sweep WHERE id = ?').bind(id).first();
  const [root, reply] = of('comment');
  assert.deepEqual(await rec(f1.id), { comment_ids: JSON.stringify({ acctRivera1: root.id }), posted_ids: JSON.stringify({ acctRivera1: root.id }) });
  assert.deepEqual(await rec(f2.id), { comment_ids: JSON.stringify({ acctRivera1: root.id }), posted_ids: JSON.stringify({ acctRivera1: reply.id }) });

  // Workers AI not answering: the email waits, it isn't posted unread
  delete env.AI;
  const late = mail({ box: PAT, at: T0 + WATCH_MS + 2 * MIN, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Paint colors', text: 'Blue?' });
  calls.length = 0;
  await maybeSweepMail(env, { now: T0 + WATCH_MS + 5 * MIN, force: true });
  assert.equal(of('comment').length, 0);
  assert.equal((await byId(late.id))[0].state, 'failed');
});

test('the last year comes in only once the application is approved; before that, new email only', async () => {
  await env.DB.prepare("INSERT INTO applicants (account_id, name, status, fields, created_at, contact_email, contacts) VALUES ('acctGomez01', 'Gomez Family', 'Applied', '{}', '2026-10-01T15:00:00Z', 'luz@example.com', ?)")
    .bind(JSON.stringify([{ name: 'Luz Gomez', title: 'Mom', email: 'luz@example.com' }])).run();
  mail({ box: PAT, at: T0 - 40 * DAY, from: 'Luz Gomez <luz@example.com>', to: PAT, subject: 'Before we applied', text: 'Hi!' });
  mail({ box: PAT, at: T0 + 2 * MIN, from: 'Luz Gomez <luz@example.com>', to: PAT, subject: 'A question on the application', text: 'Do you need photos?' });
  for (const k of [0, 1, 2]) await maybeSweepMail(env, { now: T0 + (k ? WATCH_MS + k * MIN : 0), force: true });
  assert.deepEqual(of('comment').filter((c) => c.input.targetId === 'acctGomez01').map((c) => c.input.name), ['Email: A question on the application']);

  await env.DB.prepare("UPDATE applicants SET status = 'Approved' WHERE account_id = 'acctGomez01'").run();
  for (const k of [3, 4, 5]) await maybeSweepMail(env, { now: T0 + WATCH_MS + k * MIN, force: true });
  assert.deepEqual(of('comment').filter((c) => c.input.targetId === 'acctGomez01').map((c) => c.input.name), ['Email: A question on the application', 'Email: Before we applied']);
});

test('the brake: a new account with a pile of email at once waits until it’s 3 days old, and Slack hears once', async () => {
  env.SLACK_WEBHOOK_URL = 'https://hooks.slack.example/T/B/x';
  const base = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u) === env.SLACK_WEBHOOK_URL) { calls.push({ kind: 'slack', body: JSON.parse(init.body) }); return new Response('ok'); }
    return base(u, init);
  };
  const born = T0 + WATCH_MS;
  await env.DB.prepare("INSERT INTO applicants (account_id, name, status, fields, created_at, contact_email, contacts) VALUES ('acctBelly01', 'Belly Rubs', 'Approved', '{}', ?, 'jo@example.net', ?)")
    .bind(new Date(born).toISOString(), JSON.stringify([{ name: 'Jo Ray', title: 'Mom', email: 'jo@example.net' }])).run();
  for (let i = 0; i < 12; i++) mail({ box: PAT, at: T0 - (100 - i) * DAY, from: 'Jo Ray <jo@example.net>', to: PAT, subject: `Note ${i + 1}`, text: 'hi' });
  for (const k of [0, 1, 2, 3]) await maybeSweepMail(env, { now: k ? born + k * MIN : T0, force: true });
  assert.equal(of('comment').filter((c) => c.input.targetId === 'acctBelly01').length, 0, 'nothing on the account');
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sweep WHERE state = 'held'").first()).n, 12);
  assert.equal(of('slack').length, 1, 'one heads-up, not one an email');
  assert.match(JSON.stringify(of('slack')[0].body), /Belly Rubs’s emails are waiting[\s\S]*12 emails in staff inboxes matched it at once/);
  assert.match(JSON.stringify(of('slack')[0].body), /app\.jobtread\.com\/customers\/acctBelly01/);

  // Three days on (still real, still there): each is checked and goes on
  for (const k of [0, 1, 2]) await maybeSweepMail(env, { now: born + BRAKE_AGE + (k + 1) * MIN, force: true });
  assert.equal(of('comment').filter((c) => c.input.targetId === 'acctBelly01').length, 12);
  assert.equal(of('slack').length, 1);
});

test('a receipt’s words: the HTML when the plain text is only a link, and no links for the model', async () => {
  const part = (mimeType, s) => ({ partId: mimeType, mimeType, headers: [], body: { data: b64u(s), size: s.length } });
  const payload = (...parts) => ({ partId: '', mimeType: 'multipart/alternative', headers: [], parts });
  const stub = 'Your order confirmation is 359672268\nView your order ( https://crate.example/o/359672268?key=abc )';
  const html = '<table><tr><td>Sofa</td><td>$1,299.00</td></tr><tr><td>Order Total</td><td>$1,402.92</td></tr></table>';
  assert.match(receiptText(payload(part('text/plain', stub), part('text/html', html))), /Order Total +\$1,402\.92/);
  assert.equal(receiptText(payload(part('text/plain', 'Total: $54.78'), part('text/html', html))), 'Total: $54.78', 'a plain part with the amount is kept');
  assert.equal(receiptText(payload(part('text/plain', stub), part('text/html', '<p>Thanks!</p>'))), stub, 'neither has an amount: the plain part');

  let seen = '';
  env.AI.run = async (_model, { messages }) => { seen = messages[1].content; return { response: { type: 'receipt', personal: false, vendor: 'Crate' } }; };
  const link = `( https://t.crate.example/${'x'.repeat(1500)} )\n`;
  const padding = '\u034f \u200c \u00ad '.repeat(1000);
  await judgeReceipt(env, { subject: 'Your order confirmation is 359672268', from: 'Crate <hi@crate.example>', owner: 'Pat Lee', text: `We're getting it ready.${padding}\n${link.repeat(3)}Order Total $1,402.92`, files: [] });
  assert.doesNotMatch(seen, /https?:|\u034f|\u200c/);
  assert.match(seen, /Order Total \$1,402\.92/, 'the order isn’t pushed out of the model’s share by tracking links or preview padding');
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
  aiVerdicts['Your order confirmation'] = { type: 'not_receipt', vendor: 'Shop', total: '$54.00', date: '', reason: 'a quote' };
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
  assert.match((await byId(m.r4.id))[0].detail, /^not a receipt: a quote/);
  assert.equal((await byId(m.r5.id))[0].detail, 'its conversation already went to the receipt inbox');
  assert.equal((await byId(m.old.id)).length, 0, 'receipts only from the start: older ones were forwarded by hand');
  assert.equal((await byId(m.f1.id))[0].source, 'backfill');
  assert.equal((await byId(m.f1.id))[0].state, 'would');
  assert.match((await byId(m.f1.id))[0].detail, /would add to Rivera Family with a file/);
  assert.equal((await byId(m.f1copy.id))[0].state, 'duplicate');
  assert.equal((await rows()).filter((r) => /Accepted/.test(r.detail || '')).length, 0);

  const s = await mailSweepStatus(env, { now: T0 + WATCH_MS });
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
  assert.deepEqual((await mailSweepStatus(env, { now: T0 + WATCH_MS })).lastSent, { to: 'ap@soardcharity.com', status: 'bounced', at: new Date(T0 + WATCH_MS + 2 * MIN).toISOString(), detail: 'The group only takes mail from members' });
  assert.equal((await byId(m.f1.id))[0].state, 'posted');
  assert.equal((await byId(m.f2.id))[0].state, 'posted');

  // Nothing twice: the next sweeps find nothing new to do
  calls.length = 0;
  await maybeSweepMail(env, { now: T0 + WATCH_MS + 5 * MIN, force: true });
  assert.equal(of('resend').length + of('comment').length, 0);
});

test('a reply carrying the conversation’s files again doesn’t add them twice', async () => {
  const photo = { name: 'room.jpg', type: 'image/jpeg', data: 'jpegbytes', size: 200000 };
  mail({ box: PAT, at: T0 - 9 * DAY, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Brand kit', text: 'Here you go', msgid: '<kit@mail.example>', files: [photo] });
  mail({ box: PAT, at: T0 - 8 * DAY, from: `Pat <${PAT}>`, to: 'parent@example.com', subject: 'Re: Brand kit', text: 'Thanks!', refs: '<kit@mail.example>', labels: ['SENT'], files: [photo] });
  mail({ box: PAT, at: T0 - 7 * DAY, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Re: Brand kit', text: 'One more', refs: '<kit@mail.example>', files: [photo, { name: 'logo-final.png', type: 'image/png', data: 'png', size: 90000 }] });
  await maybeSweepMail(env, { now: T0, force: true });
  assert.deepEqual((await rows()).map((r) => r.detail), ['would add to Rivera Family with a file', 'would add to Rivera Family', 'would add to Rivera Family with a file']);
  await maybeSweepMail(env, { now: T0 + WATCH_MS + MIN, force: true });
  assert.deepEqual(of('comment').map((c) => (c.input.files || []).length), [1, 0, 1]);
  assert.match(of('comment')[2].input.message, /Files: logo-final\.png$/);
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

test('a draft isn’t an email yet: one being written isn’t picked up, one already waiting is passed over, and the sent copy goes on', async () => {
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  const draft = mail({ box: PAT, at, from: `Pat <${PAT}>`, to: 'parent@example.com', subject: 'Paint colors', text: 'Hi Ana, the blue we', labels: ['DRAFT'] });
  // Queued before drafts were left out (Clareece's, Nov 5 2026): still a draft when its turn comes
  const waiting = mail({ box: PAT, at: at + 1000, from: `Pat <${PAT}>`, to: 'parent@example.com', subject: 'Re: Room ideas', text: 'Sounds go', labels: ['DRAFT'] });
  await env.DB.prepare("INSERT INTO mail_sweep (mailbox, id, at, kind, state, accounts, subject, source, updated_at) VALUES (?, ?, ?, 'family', 'queued', ?, ?, 'new', ?)")
    .bind(PAT, waiting.id, new Date(at + 1000).toISOString(), JSON.stringify(['acctRivera1']), 'Re: Room ideas', new Date(at).toISOString()).run();
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  assert.deepEqual(await byId(draft.id), [], 'never queued');
  assert.equal((await byId(waiting.id))[0].state, 'skipped');
  const searches = of('gmail').filter((c) => c.path === '/messages' && !/"/.test(c.q));
  assert.ok(searches.length && searches.every((c) => /-in:drafts/.test(c.q)), 'the new-mail and last-year searches leave drafts out');
  assert.equal(of('comment').length, 0);

  const sent = mail({ box: PAT, at: at + 6 * MIN, from: `Pat <${PAT}>`, to: 'parent@example.com', subject: 'Paint colors', text: 'Hi Ana, the blue we picked is in.', labels: ['SENT'] });
  await maybeSweepMail(env, { now: at + 10 * MIN, force: true });
  assert.equal((await byId(sent.id))[0].state, 'posted');
  assert.equal(of('comment').length, 1);
  assert.match(of('comment')[0].input.message, /the blue we picked is in/);
});

test('the heartbeat: every 3 minutes when there’s nothing waiting, never without the Google key', async () => {
  assert.ok(await maybeSweepMail(env, { now: T0 }));
  assert.equal(await maybeSweepMail(env, { now: T0 + MIN }), null);
  assert.ok(await maybeSweepMail(env, { now: T0 + 4 * MIN }));
  assert.equal(await maybeSweepMail({ ...env, GOOGLE_CALENDAR_KEY: '' }, { now: T0 + 10 * MIN }), null);
});
const row = (id) => env.DB.prepare('SELECT state, tries, detail FROM mail_sweep WHERE id = ?').bind(id).first();
const CAP = "2045: Spend limit exceeded: rule 'site-day' (cost limit 5 per 86400s, sliding) for internal-workers-ai @cf/meta/llama-3.3-70b-instruct-fp8-fast";

test('a cap reached: a receipt and a family email wait with no try spent, the judging rests, and both go through when it lifts', async () => {
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  // Its subject doesn't say receipt: the rules alone would pass it over for good
  const receipt = mail({ box: PAT, at, from: 'Studio <billing@studio.example>', to: PAT, subject: 'Thanks for your order #77', text: 'Total $44.00' });
  const family = mail({ box: PAT, at: at + 1000, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Paint colors', text: 'Blue?' });
  const answers = env.AI.run;
  let refused = 0;
  env.AI.run = async () => { refused++; throw new Error(CAP); };
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  assert.equal(refused, 1, 'one refusal stops the run');
  const r = await row(receipt.id);
  assert.deepEqual([r.state, r.tries], ['queued', 0], 'no try spent, nothing recorded about the email');
  assert.match(r.detail, /^Waiting: Workers AI reached its spending cap/);
  assert.equal((await byId(family.id))[0].state, 'queued');
  assert.match((await mailSweepStatus(env, { now: T0 + WATCH_MS })).error || '', /spending cap/);
  await maybeSweepMail(env, { now: at + 6 * MIN, force: true });
  assert.equal(refused, 1, 'it rests: the AI isn’t asked again every minute');

  env.AI.run = answers;
  aiVerdicts['Thanks for your order #77'] = { type: 'receipt', vendor: 'Studio', total: '$44.00', date: '', personal: false, reason: 'an order' };
  await maybeSweepMail(env, { now: at + 25 * MIN, force: true });
  assert.equal((await byId(receipt.id))[0].state, 'sent', 'read after all, and sent on');
  assert.equal((await byId(family.id))[0].state, 'posted');
  assert.equal(of('comment').length, 1);
});

test('a family email is never spent at a cap: three sweeps at the cap leave it with no tries used', async () => {
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  const m = mail({ box: PAT, at, from: 'Ana Rivera <parent@example.com>', to: PAT, subject: 'Paint colors', text: 'Blue?' });
  env.AI.run = async () => { throw new Error('2003: Rate limited'); };
  for (let k = 1; k <= 3; k++) await maybeSweepMail(env, { now: at + k * 20 * MIN, force: true });
  const r = await row(m.id);
  assert.deepEqual([r.state, r.tries], ['queued', 0]);
});

test('Workers AI not answering about a receipt: tried again, and only its last try goes by the rules', async () => {
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  const m = mail({ box: PAT, at, from: 'Studio <billing@studio.example>', to: PAT, subject: 'Thanks for your order #78', text: 'Total $44.00' });
  env.AI.run = async () => { throw new Error('timeout'); };
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  assert.deepEqual((({ state, tries }) => [state, tries])(await row(m.id)), ['failed', 1]);
  await maybeSweepMail(env, { now: at + 16 * MIN, force: true });
  assert.deepEqual((({ state, tries }) => [state, tries])(await row(m.id)), ['failed', 2]);
  await maybeSweepMail(env, { now: at + 27 * MIN, force: true });
  assert.equal((await byId(m.id))[0].state, 'skipped');
});

const MERCURY_CHARGES = 'CREATE TABLE IF NOT EXISTS spend_charges (id TEXT PRIMARY KEY, kind TEXT, status TEXT, cents INTEGER NOT NULL, vendor TEXT, card_id TEXT, email TEXT, created_at TEXT, has_receipt INTEGER, link TEXT)';
const mercuryCharge = (id, cents, vendor, at, email = PAT) => env.DB.prepare('INSERT INTO spend_charges (id, kind, status, cents, vendor, email, created_at, has_receipt) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
  .bind(id, 'creditCardTransaction', 'pending', cents, vendor, email, new Date(at).toISOString()).run();
const cardRow = (charge) => env.DB.prepare('SELECT state, msg_id, detail FROM card_receipts WHERE charge = ?').bind(charge).first();
const archivedOf = (...ms) => Promise.all(ms.map((m) => env.DB.prepare('SELECT archived FROM mail_sweep WHERE id = ?').bind(m.id).first('archived')));

test('a Mercury card charge finds its receipt in the cardholder’s email, puts the best one on the charge, and the emails are archived', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('ch1', 1000, 'Texting.app', at - 2 * MIN);
  const paid = mail({ box: PAT, at, from: 'Texting <billing@texting.example>', to: PAT, subject: 'Payment received: USD $10.00', html: '<p>We received your payment of <b>USD $10.00</b>.</p>' });
  const receipt = mail({ box: PAT, at: at + MIN, from: 'Stripe <receipts@stripe.example>', to: PAT, subject: 'Your Texting receipt [#1277]', text: 'Amount paid $10.00', files: [{ name: 'Receipt-1277.pdf', type: 'application/pdf', data: '%PDF receipt 1277' }] });
  const digest = mail({ box: PAT, at: at + 2 * MIN, from: 'The Paper <news@paper.example>', to: PAT, subject: 'This week in the city', text: 'Subscribe for $10.00 a month' });
  for (const x of ['Payment received: USD $10.00', 'Your Texting receipt [#1277]']) aiVerdicts[x] = { type: 'receipt', vendor: 'Texting', total: '$10.00', reason: 'top up' };
  refuseScopes.add('https://www.googleapis.com/auth/gmail.modify');
  calls.length = 0;
  const st = await maybeSweepMail(env, { now: at + 5 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });

  assert.equal(of('resend').length, 0, 'not emailed: Mercury sends a makeover’s receipt on itself');
  assert.deepEqual(of('mercury').map((c) => [c.method, c.path, c.attachmentType, c.file]), [['POST', '/transaction/ch1/attachments', 'receipt', 'Receipt-1277.pdf']], 'one receipt, the store’s own PDF');
  assert.deepEqual(await cardRow('mercury:ch1'), { state: 'attached', msg_id: `${PAT}:${receipt.id}`, detail: 'put “Your Texting receipt [#1277]” on the Mercury card charge (Texting.app $10.00)' });
  assert.equal((await byId(paid.id))[0].detail, 'another email for the Mercury card charge (Texting.app $10.00)');
  assert.equal((await byId(digest.id)).length, 0, 'the same amount in a newsletter isn’t a receipt');
  assert.equal(await env.DB.prepare("SELECT state FROM spend_receipts WHERE charge_id = 'ch1' AND way = 'to-mercury'").first('state'), 'sent', 'a bill’s file won’t follow it');

  // Google hasn't allowed archiving yet: the emails wait, and Automations says what to add
  assert.deepEqual(await archivedOf(paid, receipt), ['no', 'no']);
  assert.match(st.error, /Domain-wide delegation, add https:\/\/www\.googleapis\.com\/auth\/gmail\.modify/);
  refuseScopes.clear();
  calls.length = 0;
  const st2 = await maybeSweepMail(env, { now: at + 10 * MIN, force: true });
  assert.deepEqual(calls.filter((c) => c.kind === 'gmail' && c.method === 'POST').map((c) => c.path), [paid, receipt].map((m) => `/messages/${m.id}/modify`));
  assert.deepEqual(await archivedOf(paid, receipt), ['yes', 'yes']);
  assert.equal(st2.error, null);
  assert.equal(of('mercury').length, 0, 'nothing on the charge twice');
  assert.equal((await mailSweepStatus(env, { now: T0 + WATCH_MS })).cards.attached, 1);
});

test('a charge finds a receipt the email side didn’t take, and one with none says so after a week', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('ch2', 6461, 'LEGO', at - 30 * MIN);
  await mercuryCharge('ch3', 1234, 'Hardware Hut', at - 20 * MIN);
  const lego = mail({ box: PAT, at, from: 'LEGO Shop <shop@lego.example>', to: PAT, subject: 'We’ve got it! Your LEGO order is confirmed', text: 'Order total $64.61' });
  mail({ box: PAT, at: at + MIN, from: 'Bank <alerts@bank.example>', to: PAT, subject: 'Your balance', text: 'A charge of $64.61 posted' });
  calls.length = 0;
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.equal((await byId(lego.id))[0].state, 'card', 'the model called it no receipt; the charge found it anyway');
  assert.deepEqual(of('mercury').map((c) => [c.path, c.file]), [['/transaction/ch2/attachments', 'LEGO Shop receipt 2026-11-03.pdf']]);
  assert.equal((await cardRow('mercury:ch2')).state, 'attached');
  assert.equal((await cardRow('mercury:ch3')).state, 'looking');

  await maybeSweepMail(env, { now: at + 7 * DAY + 60 * MIN, force: true });
  assert.deepEqual(await cardRow('mercury:ch3'), { state: 'none', msg_id: null, detail: 'no receipt found in SOARD’s email' });
  assert.equal((await mailSweepStatus(env, { now: T0 + WATCH_MS })).cards.none, 1);
});

test('a receipt in a coworker’s inbox: found after the charge’s first hour when the store matches, and a cardholder known by an alias', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  const LEE = 'lee@store.example';
  await env.DB.prepare("UPDATE staff_state SET data = ? WHERE key = 'directory'").bind(JSON.stringify({ ok: true, accounts: [...ACCOUNTS, { email: LEE, aliases: ['lee@soardcharity.com'], name: 'Lee Park', active: true, why: null }] })).run();
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('ch4', 4200, 'Etsy', at - 2 * 60 * MIN, SAM);
  await mercuryCharge('ch5', 1999, 'Home Depot', at - 2 * 60 * MIN, SAM);
  await mercuryCharge('ch6', 8376, 'Walmart', at - 2 * 60 * MIN, 'lee@soardcharity.com');
  const etsy = mail({ box: PAT, at: at - 2 * 60 * MIN, from: 'Etsy <transaction@etsy.example>', to: PAT, subject: 'Your Etsy Purchase from PrintShop', text: 'Order total $42.00' });
  const bakery = mail({ box: PAT, at: at - 2 * 60 * MIN, from: 'Corner Bakery <hi@bakery.example>', to: PAT, subject: 'Your receipt from Corner Bakery', text: 'Total $19.99' });
  const walmart = mail({ box: LEE, at: at - 2 * 60 * MIN, from: 'Walmart <help@walmart.example>', to: 'lee@soardcharity.com', subject: 'Lee, thanks for your order', text: 'Bins $83.76' });
  calls.length = 0;
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.deepEqual(await cardRow('mercury:ch4'), { state: 'attached', msg_id: `${PAT}:${etsy.id}`, detail: 'put “Your Etsy Purchase from PrintShop” on the Mercury card charge (Etsy $42.00)' }, 'the order went to a coworker');
  assert.equal((await cardRow('mercury:ch5')).state, 'looking', 'another store’s receipt for the same amount isn’t taken from a coworker');
  assert.equal(await env.DB.prepare('SELECT charge_id FROM mail_sweep WHERE id = ?').bind(bakery.id).first('charge_id'), null, 'and isn’t put on any charge');
  assert.deepEqual(await cardRow('mercury:ch6'), { state: 'attached', msg_id: `${LEE}:${walmart.id}`, detail: 'put “Lee, thanks for your order” on the Mercury card charge (Walmart $83.76)' }, 'the card’s email is an alias on the account');
  assert.equal(await env.DB.prepare('SELECT archived FROM mail_sweep WHERE mailbox = ? AND id = ?').bind(PAT, etsy.id).first('archived'), 'yes', 'archived where it was found');
});

test('a store’s email through a SOARD group (orders@) is the store’s: a receipt, and found by its card charge', async () => {
  const fam = await familyAddresses(env.DB);
  const relayed = (o, extra) => { const m = mail({ box: PAT, at: T0, to: 'orders@soardcharity.com', text: '', ...o }); m.payload.headers.push(...extra); return m; };
  const amazon = relayed({ from: "'Amazon.com' via orders <orders@soardcharity.com>", subject: 'Your Amazon.com order of 3 Ring Binders' }, [{ name: 'X-Original-From', value: 'Amazon.com <auto-confirm@amazon.example>' }]);
  assert.equal(senderOf(amazon.payload.headers), 'Amazon.com <auto-confirm@amazon.example>');
  assert.deepEqual(triage(amazon, fam), { kind: 'receipt' });
  const viaReply = relayed({ from: "'Lumber Co' via orders <orders@soardcharity.com>", subject: 'Your receipt from Lumber Co' }, [{ name: 'Reply-To', value: 'sales@lumber.example' }]);
  assert.deepEqual(triage(viaReply, fam), { kind: 'receipt' }, 'Reply-To when the group keeps no X-Original-From');
  const staff = relayed({ from: "'Holly' via info <info@soardcharity.com>", subject: 'Receipt for the paint' }, [{ name: 'X-Original-From', value: 'Holly <holly@soardcharity.com>' }]);
  assert.equal(triage(staff, fam), null, 'staff through a group is still staff');

  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('ch7', 3447, 'Amazon', at - 10 * MIN);
  const shipped = mail({ box: PAT, at, from: "'Amazon.com' via orders <orders@soardcharity.com>", to: 'orders@soardcharity.com', subject: 'Shipped: 3 Ring Yellow Binder', text: 'Your package is on its way. Shipment total $34.47' });
  shipped.payload.headers.push({ name: 'X-Original-From', value: 'Amazon.com <shipment-tracking@amazon.example>' });
  calls.length = 0;
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.deepEqual(await cardRow('mercury:ch7'), { state: 'attached', msg_id: `${PAT}:${shipped.id}`, detail: 'put “Shipped: 3 Ring Yellow Binder” on the Mercury card charge (Amazon $34.47)' });
  assert.deepEqual(of('mercury').map((c) => c.file), ['Amazon.com receipt 2026-11-03.pdf'], 'named for the store, not the group');
});

test('a Ramp card charge gets its receipt in Ramp, its receipt still goes to the receipt inbox once, and every receipt is SOARD’s', async () => {
  Object.assign(env, { RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' });
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  rampTxns.push(
    { id: 'tx1', state: 'CLEARED', entity_amount: { value: 4836, currency: 'USD' }, user_transaction_time: new Date(at - 3 * MIN).toISOString(), merchant_name: 'Etsy', card_holder: { user_id: 'u-pat' }, receipts: [] },
    { id: 'tx2', state: 'CLEARED', entity_amount: { value: 2299, currency: 'USD' }, user_transaction_time: new Date(at - DAY).toISOString(), merchant_name: 'Lumber Co', card_holder: { user_id: 'u-pat' }, receipts: ['r-by-hand'] },
  );
  const order = mail({ box: PAT, at, from: 'Etsy <transaction@etsy.example>', to: PAT, subject: 'Your Etsy Purchase from PrintShop', text: 'Nursery print set. Order total $48.36' });
  const again = mail({ box: PAT, at: at + MIN, from: 'Etsy <transaction@etsy.example>', to: PAT, subject: 'Thanks for your order, Pat', text: 'You paid $48.36' });
  const lumber = mail({ box: PAT, at: at + 2 * MIN, from: 'Lumber Co <sales@lumber.example>', to: PAT, subject: 'Your receipt from Lumber Co', text: 'Paid $22.99' });
  const plan = mail({ box: PAT, at: at + 3 * MIN, from: 'Stream <billing@stream.example>', to: PAT, subject: 'Your receipt from Stream', text: 'Premium plan $15.49' });
  aiVerdicts['Your Etsy Purchase from PrintShop'] = { type: 'receipt', vendor: 'PrintShop', total: '$48.36', reason: 'an order' };
  aiVerdicts['Thanks for your order, Pat'] = { type: 'receipt', vendor: 'Etsy', total: '$48.36', reason: 'an order' };
  aiVerdicts['Your receipt from Lumber Co'] = { type: 'receipt', vendor: 'Lumber Co', total: '$22.99', reason: 'paid' };
  aiVerdicts['Your receipt from Stream'] = { type: 'receipt', vendor: 'Stream', total: '$15.49', reason: 'a plan' };
  calls.length = 0;
  const st = await maybeSweepMail(env, { now: at + 5 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });

  assert.equal(st.error, null);
  assert.ok(of('ramp-token').every((c) => c.scope === 'transactions:read receipts:write users:read'));
  assert.deepEqual(of('ramp-receipt').map((c) => [c.transaction, c.user, c.key, c.file]), [['tx1', 'u-pat', `ramp:tx1:${order.id}:0`, 'Etsy receipt 2026-11-03.pdf']], 'once, and never on a charge that has a receipt');
  const sent = of('resend');
  assert.deepEqual(sent.map((x) => x.body.subject.split(' on ')[0]), ['Receipt: PrintShop $48.36', 'Receipt: Lumber Co $22.99', 'Receipt: Stream $15.49'], 'a Ramp charge’s receipt once; one on no card as before');
  assert.match(sent[0].body.text, /Card charge: Etsy \$48\.36 on Pat’s Ramp card/);
  assert.equal((await byId(again.id))[0].state, 'duplicate');
  assert.equal((await cardRow('ramp:tx1')).state, 'attached');
  assert.equal((await cardRow('ramp:tx2')).state, 'had');
  assert.deepEqual(calls.filter((c) => c.kind === 'gmail' && c.method === 'POST').map((c) => c.path), [order, again, lumber].map((m) => `/messages/${m.id}/modify`), 'the card charges’ emails leave the inbox; the plan on no card stays');
  assert.equal((await byId(plan.id))[0].state, 'sent');
});

test('the first run catches up on the last 90 days of card charges once; after that it reads a week', async () => {
  Object.assign(env, { RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' });
  const old = T0 - 40 * DAY;
  rampTxns.push(
    { id: 'tx-old', state: 'CLEARED', entity_amount: { value: 12900, currency: 'USD' }, user_transaction_time: new Date(old).toISOString(), merchant_name: 'Paint Depot', card_holder: { user_id: 'u-pat' }, receipts: [] },
    { id: 'tx-none', state: 'CLEARED', entity_amount: { value: 5500, currency: 'USD' }, user_transaction_time: new Date(old).toISOString(), merchant_name: 'Fabric Barn', card_holder: { user_id: 'u-pat' }, receipts: [] },
    { id: 'tx-older', state: 'CLEARED', entity_amount: { value: 999, currency: 'USD' }, user_transaction_time: new Date(T0 - 100 * DAY).toISOString(), merchant_name: 'Too Old Co', card_holder: { user_id: 'u-pat' }, receipts: [] },
    { id: 'tx-sam', state: 'CLEARED', entity_amount: { value: 3100, currency: 'USD' }, user_transaction_time: new Date(old).toISOString(), merchant_name: 'Glue Co', card_holder: { user_id: 'u-samstore' }, receipts: [] },
  );
  const paint = mail({ box: PAT, at: old + 20 * MIN, from: 'Paint Depot <orders@paint.example>', to: PAT, subject: 'Your Paint Depot receipt', text: 'Total $129.00' });
  calls.length = 0;
  const st = await maybeSweepMail(env, { now: T0, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.ok(st.cardsCaughtUp);
  assert.deepEqual(of('ramp-receipt').map((c) => c.transaction), ['tx-old'], 'a receipt from before this began goes on its charge');
  assert.equal(await env.DB.prepare('SELECT archived FROM mail_sweep WHERE id = ?').bind(paint.id).first('archived'), 'yes');
  assert.deepEqual(await cardRow('ramp:tx-none'), { state: 'none', msg_id: null, detail: 'no receipt found in SOARD’s email' }, 'an old charge with none is listed now, after one full look');
  assert.equal(await cardRow('ramp:tx-older'), null, 'past 90 days is left alone');
  assert.equal((await mailSweepStatus(env, { now: T0 + WATCH_MS })).cards.none, 1);

  // Caught up: from now on Ramp is read a week back
  rampTxns.push({ id: 'tx-late', state: 'CLEARED', entity_amount: { value: 777, currency: 'USD' }, user_transaction_time: new Date(T0 - 30 * DAY).toISOString(), merchant_name: 'Late Co', card_holder: { user_id: 'u-pat' }, receipts: [] });
  await maybeSweepMail(env, { now: T0 + 20 * MIN, force: true });
  assert.equal(await cardRow('ramp:tx-late'), null);
  assert.equal((await cardRow('ramp:tx-sam')).state, 'no_inbox', 'Sam’s account isn’t in Google yet');

  // Sam's account joins: his old charge looks now, however old, and his inbox starts from today
  await env.DB.prepare("UPDATE staff_state SET data = ? WHERE key = 'directory'").bind(JSON.stringify({ ok: true, accounts: [...ACCOUNTS, { email: 'sam@store.example', aliases: [], name: 'Sam Ray', active: true, why: null }] })).run();
  mail({ box: 'sam@store.example', at: old + 30 * MIN, from: 'Glue Co <orders@glue.example>', to: 'sam@store.example', subject: 'Your Glue Co receipt', text: 'Total $31.00' });
  const before = mail({ box: 'sam@store.example', at: T0 - 2 * DAY, from: 'Tape Co <orders@tape.example>', to: 'sam@store.example', subject: 'Your Tape Co receipt', text: 'Total $9.00' });
  calls.length = 0;
  await maybeSweepMail(env, { now: T0 + 40 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.equal((await cardRow('ramp:tx-sam')).state, 'attached');
  assert.equal((await byId(before.id)).length, 0, 'mail from before the inbox joined isn’t swept as new');
});

test('a Ramp cardholder whose Ramp email moves to SOARD’s: their old charges with no inbox look in it', async () => {
  Object.assign(env, { RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' });
  rampUsers.push({ id: 'u-moved', email: 'pat@other-business.example' });
  const old = T0 - 30 * DAY;
  rampTxns.push({ id: 'tx-moved', state: 'CLEARED', entity_amount: { value: 2386, currency: 'USD' }, user_transaction_time: new Date(old).toISOString(), merchant_name: 'FaxOnline', card_holder: { user_id: 'u-moved' }, receipts: [] });
  mail({ box: PAT, at: old + 10 * MIN, from: 'FaxOnline <billing@fax.example>', to: PAT, subject: 'Your FaxOnline receipt', text: 'Amount paid $23.86' });
  await maybeSweepMail(env, { now: T0, force: true });
  assert.equal((await cardRow('ramp:tx-moved')).state, 'no_inbox', 'another business’s email isn’t read');

  // Changed in Ramp to their SOARD address: the next time Ramp is read (15 minutes), the charge looks there
  rampUsers.find((u) => u.id === 'u-moved').email = PAT;
  await maybeSweepMail(env, { now: T0 + 5 * MIN, force: true });
  assert.equal((await cardRow('ramp:tx-moved')).state, 'no_inbox', 'not before Ramp is read again');
  calls.length = 0;
  await maybeSweepMail(env, { now: T0 + 16 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.equal((await cardRow('ramp:tx-moved')).state, 'attached');
  assert.deepEqual(of('ramp-receipt').map((c) => c.transaction), ['tx-moved']);
});

const noneCharge = (charge, card, mailbox, cents, vendor, at) => env.DB.prepare("INSERT INTO card_receipts (charge, card, mailbox, user_id, cents, vendor, charged_at, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'none', ?)")
  .bind(charge, card, mailbox, card === 'ramp' ? 'u-pat' : null, cents, vendor, new Date(at).toISOString(), new Date(at).toISOString()).run();
const codeOf = (charge) => env.DB.prepare('SELECT rowid FROM card_receipts WHERE charge = ?').bind(charge).first('rowid');

test('Monday morning: each cardholder gets one email listing their charges still needing a receipt, with links and an Email the receipt button', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test', RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' });
  await maybeSweepMail(env, { now: T0, force: true });
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('m1', 12900, 'Paint Depot', T0 - 20 * DAY);
  await env.DB.prepare("UPDATE spend_charges SET link = 'https://bank.example/transactions/m1' WHERE id = 'm1'").run();
  rampTxns.push(
    { id: 'tx-a', state: 'CLEARED', entity_amount: { value: 2386, currency: 'USD' }, user_transaction_time: new Date(T0 - 30 * DAY).toISOString(), merchant_name: 'FaxOnline', card_holder: { user_id: 'u-pat' }, receipts: [] },
    { id: 'tx-b', state: 'CLEARED', entity_amount: { value: 500, currency: 'USD' }, user_transaction_time: new Date(T0 - 25 * DAY).toISOString(), merchant_name: 'Coffee', card_holder: { user_id: 'u-sam' }, receipts: [] },
    { id: 'tx-c', state: 'CLEARED', entity_amount: { value: 900, currency: 'USD' }, user_transaction_time: new Date(T0 - 21 * DAY).toISOString(), merchant_name: 'Added By Hand', card_holder: { user_id: 'u-pat' }, receipts: ['r1'] },
  );
  await noneCharge('mercury:m1', 'mercury', PAT, 12900, 'Paint Depot', T0 - 20 * DAY);
  await noneCharge('ramp:tx-a', 'ramp', PAT, 2386, 'FaxOnline', T0 - 30 * DAY);
  await noneCharge('ramp:tx-b', 'ramp', SAM, 500, 'Coffee', T0 - 25 * DAY);
  await noneCharge('ramp:tx-c', 'ramp', PAT, 900, 'Added By Hand', T0 - 21 * DAY);
  await noneCharge('ramp:tx-x', 'ramp', 'someone@outside.example', 700, 'Elsewhere', T0 - 22 * DAY);
  const monday = T0 + 7 * DAY; // Monday Nov 9, 10 AM Eastern
  calls.length = 0;
  const st = await maybeSweepMail(env, { now: monday, force: true });
  assert.equal(st.error, null);

  assert.equal((await cardRow('ramp:tx-c')).state, 'had', 'a receipt added by hand in Ramp takes it off the list');
  const sent = of('resend');
  assert.deepEqual(sent.map((x) => [x.body.to[0], x.body.subject]), [
    [PAT, '2 card charges need a receipt'],
    [SAM, `Coffee $5.00 needs a receipt [receipt ${await codeOf('ramp:tx-b')}]`],
  ], 'one email a cardholder, only for SOARD inboxes; a single charge’s code rides in its subject, so a reply works');
  const pat = sent[0].body;
  assert.equal(pat.reply_to, PAT);
  assert.match(pat.text, /^Hi Pat,\n\nThese charges on your SOARD card have no receipt anywhere in SOARD email\./);
  assert.match(pat.text, /Oct 13  Paint Depot  \$129\.00  \(Mercury card\)\n  Add it in Mercury: https:\/\/bank\.example\/transactions\/m1/);
  assert.match(pat.text, /Oct 3  FaxOnline  \$23\.86  \(Ramp card\)\n  Add it in Ramp: https:\/\/app\.ramp\.com\/details\/transactions\/tx-a/);
  const code = await codeOf('ramp:tx-a');
  assert.ok(pat.text.includes(`mailto:${PAT}?subject=${encodeURIComponent(`Receipt for FaxOnline $23.86 (Oct 3) [receipt ${code}]`)}`));
  assert.match(pat.html, /Email the receipt/);
  assert.doesNotMatch(pat.text + pat.html, /\u2014/, 'no em dashes');

  calls.length = 0;
  await maybeSweepMail(env, { now: monday + 30 * MIN, force: true });
  assert.equal(of('resend').length, 0, 'once a week');
  assert.deepEqual((await mailSweepStatus(env, { now: monday })).lists, { week: '2026-11-09', people: 2, at: new Date(monday).toISOString() });
  await maybeSweepMail(env, { now: monday + 6 * DAY, force: true });
  assert.equal(of('resend').length, 0, 'not on other days');
});

test('Email the receipt: sent to themselves with the photo, it goes on that charge and the email is archived', async () => {
  Object.assign(env, { RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' });
  await maybeSweepMail(env, { now: T0, force: true });
  rampTxns.push({ id: 'tx-a', state: 'CLEARED', entity_amount: { value: 2386, currency: 'USD' }, user_transaction_time: new Date(T0 - 30 * DAY).toISOString(), merchant_name: 'FaxOnline', card_holder: { user_id: 'u-pat' }, receipts: [] });
  await noneCharge('ramp:tx-a', 'ramp', PAT, 2386, 'FaxOnline', T0 - 30 * DAY);
  const code = await codeOf('ramp:tx-a');
  const at = T0 + WATCH_MS + MIN;
  const early = mail({ box: PAT, at, from: `Pat Lee <${PAT}>`, to: PAT, subject: `Receipt for FaxOnline $23.86 (Oct 3) [receipt ${code}]`, text: 'Attach the receipt (a photo or a PDF) and send this to yourself.', labels: ['SENT', 'INBOX'] });
  const photo = mail({ box: PAT, at: at + MIN, from: `Pat Lee <${PAT}>`, to: PAT, subject: `Receipt for FaxOnline $23.86 (Oct 3) [receipt ${code}]`, text: 'Attach the receipt (a photo or a PDF) and send this to yourself.', labels: ['SENT', 'INBOX'],
    files: [{ name: 'IMG_2041.jpg', type: 'image/jpeg', data: 'jpegbytes', size: 900000 }] });
  const spoof = mail({ box: PAT, at: at + 2 * MIN, from: 'Someone <x@outside.example>', to: PAT, subject: `Hello [receipt ${code}]`, text: 'hi', files: [{ name: 'a.jpg', type: 'image/jpeg', data: 'j', size: 900000 }] });
  calls.length = 0;
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  assert.equal((await byId(early.id))[0].detail, 'no receipt attached');
  assert.deepEqual(of('ramp-receipt').map((c) => [c.transaction, c.file]), [['tx-a', 'IMG_2041.jpg']]);
  assert.equal((await cardRow('ramp:tx-a')).state, 'attached');
  assert.equal((await byId(photo.id))[0].state, 'card');
  assert.equal(await env.DB.prepare('SELECT archived FROM mail_sweep WHERE id = ?').bind(photo.id).first('archived'), 'yes');
  assert.notEqual((await byId(spoof.id))[0]?.kind, 'tagged', 'only SOARD’s own people can send a charge its receipt');
});

test('Ramp refusing the card scopes: its receipts go to the receipt inbox as before, and Automations says why', async () => {
  Object.assign(env, { RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' });
  refuseScopes.add('transactions:read receipts:write users:read');
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  const m = mail({ box: PAT, at, from: 'Etsy <transaction@etsy.example>', to: PAT, subject: 'Your Etsy Purchase from PrintShop', text: 'Order total $48.36' });
  aiVerdicts['Your Etsy Purchase from PrintShop'] = { type: 'receipt', vendor: 'PrintShop', total: '$48.36', reason: 'an order' };
  calls.length = 0;
  const st = await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  assert.equal(of('resend').length, 1);
  assert.equal((await byId(m.id))[0].state, 'sent');
  assert.match(st.error, /Ramp’s card charges can’t be read, so Ramp receipts go to the receipt inbox only: Ramp refused the keys \(400\)\. .*transactions:read, receipts:write, users:read/);
});

test('every account in SOARD’s Google is SOARD’s, on any of its domains: all its mail is read, and its people are staff', async () => {
  const LEE = 'lee@store.example', NIKKI = 'nikki@store.example';
  await env.DB.prepare("UPDATE staff_state SET data = ? WHERE key = 'directory'").bind(JSON.stringify({ ok: true, accounts: [...ACCOUNTS,
    { email: LEE, aliases: ['lee@soardcharity.com'], name: 'Lee Park', active: true, why: null },
    { email: NIKKI, aliases: [], name: 'Nikki Fox', active: true, why: null }] })).run();
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  const store = mail({ box: LEE, at, from: 'Perigold <orders@perigold.example>', to: LEE, subject: 'Order received. Thanks for your order #88', text: 'Mirror $480.00' });
  const soard = mail({ box: LEE, at: at + MIN, from: 'Walmart <help@walmart.example>', to: 'lee@soardcharity.com', subject: 'Lee, thanks for your order', text: 'Bins $83.76' });
  const nikki = mail({ box: NIKKI, at: at + 2 * MIN, from: 'Lumber Co <sales@lumber.example>', to: NIKKI, subject: 'Your receipt from Lumber Co', text: 'Paid $22.99' });
  const coworker = mail({ box: PAT, at: at + 3 * MIN, from: `Nikki Fox <${NIKKI}>`, to: PAT, subject: 'Receipt for the paint', text: 'Paid $40.00' });
  aiVerdicts['Order received. Thanks for your order #88'] = { type: 'receipt', vendor: 'Perigold', total: '$480.00', reason: 'an order' };
  aiVerdicts['Lee, thanks for your order'] = { type: 'receipt', vendor: 'Walmart', total: '$83.76', reason: 'an order' };
  aiVerdicts['Your receipt from Lumber Co'] = { type: 'receipt', vendor: 'Lumber Co', total: '$22.99', reason: 'paid' };
  calls.length = 0;
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  for (const m of [store, soard, nikki]) assert.equal((await byId(m.id))[0].state, 'sent');
  assert.deepEqual(of('resend').map((c) => c.body.subject.split(' on ')[0]), ['Receipt: Perigold $480.00', 'Receipt: Walmart $83.76', 'Receipt: Lumber Co $22.99'], 'the store account’s own mail too, and a store-only account’s');
  assert.equal((await byId(coworker.id)).length, 0, 'a store coworker writing to staff is staff mail');
});

test('a family email on two accounts: when the second fails, the try after it doesn’t post on the first again', async () => {
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  const m = mail({ box: PAT, at, from: `Pat <${PAT}>`, to: 'parent@example.com, kim@example.com', subject: 'Both families', text: 'Hello both', labels: ['SENT'] });
  // The second account's comment fails once
  const real = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async function (input, init = {}) {
    if (String(input).includes('jobtread') && String(init.body || '').includes('createComment') && ++posts === 2) return Response.json({ errors: [{ message: 'JobTread is busy' }] }, { status: 500 });
    return real(input, init);
  };
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  assert.equal((await row(m.id)).state, 'failed');
  globalThis.fetch = real;
  await maybeSweepMail(env, { now: at + 16 * MIN, force: true });
  assert.equal((await row(m.id)).state, 'posted');
  assert.deepEqual(of('comment').map((c) => c.input.targetId).sort(), ['acctKim0002', 'acctRivera1'], 'one comment on each');
});

// ─── Sent to the receipt inbox (ap@) ────────────────────────────────

const AP = 'ap@soardcharity.com', GRACIE = 'automation@soardcharity.com';
const JPEG = (words) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]), Buffer.from(` ${words} `)]);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The inbox the ap@ group delivers to: an account of its own */
const withGracie = () => env.DB.prepare("UPDATE staff_state SET data = ? WHERE key = 'directory'")
  .bind(JSON.stringify({ ok: true, accounts: [...ACCOUNTS, { email: GRACIE, aliases: [], name: 'Agent Gracie', active: true, why: null }] })).run();
/** The ap@ group's copy of an email, in Gracie's inbox */
function toAp(o) {
  const m = mail({ box: GRACIE, to: AP, text: '', subject: '', ...o });
  m.payload.headers.push({ name: 'List-Id', value: '"Accounts Payable" <ap.soardcharity.com>' }, { name: 'Delivered-To', value: GRACIE });
  return m;
}
const readRow = async (m) => env.DB.prepare('SELECT state, detail, charge_id, archived FROM mail_sweep WHERE mailbox = ? AND id = ?').bind(GRACIE, m.id).first();
/** Two sweeps: the first reads Gracie's new mail, the next one reads the photos first thing */
const twice = async (at) => { await maybeSweepMail(env, { now: at, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) }); return maybeSweepMail(env, { now: at + MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) }); };

test('ap@: what the group passes on is read for its card charge, but never the site’s own forwards or Ramp’s replies', async () => {
  const fam = await familyAddresses(env.DB);
  const t = (o, extra = []) => { const m = toAp({ box: GRACIE, at: T0, ...o }); m.payload.headers.push(...extra); return triage(m, fam, { receiptInbox: AP }); };
  assert.deepEqual(t({ from: '+14045550123@tmomail.net' }), { kind: 'ap' }, 'a photo texted from a phone');
  assert.deepEqual(t({ from: `Sam Fox <${SAM}>`, subject: 'Fwd: Elements Invoice 2265598' }), { kind: 'ap' }, 'staff passing one on');
  assert.deepEqual(t({ from: 'TKO Plumbing <billing@tko.example>', subject: 'Receipt from TKO PLUMBING SERVICES' }), { kind: 'ap' }, 'a store’s own');
  assert.deepEqual(t({ from: 'Dan <dad@example.com>', subject: 'Paint receipt' }), { kind: 'ap' }, 'anyone’s, a family’s address too: ap@ is for money');
  assert.equal(t({ from: 'Sunshine on a Ranney Day <sunshine@comms.sunshineonaranneyday.com>', subject: 'Receipt: Etsy $2.16 on 2026-11-06 (from Pat’s email)' }), null, 'the site’s own forward');
  assert.equal(t({ from: "'Sunshine on a Ranney Day' via Accounts Payable <ap@soardcharity.com>", subject: 'Re: Receipt: All City Decor $215.00' }, [{ name: 'X-Original-From', value: 'Sunshine on a Ranney Day <sunshineonaranneyday@ap.ramp.com>' }]), null, 'Ramp’s bill inbox answering');
  assert.equal(t({ from: 'Mercury <hello@mercury.com>', subject: 'Your receipt' }), null, 'a money tool');
  assert.deepEqual(triage(mail({ box: GRACIE, at: T0, from: 'Shop <hi@shop.example>', to: AP, subject: 'Your receipt' }), fam, { receiptInbox: AP }), { kind: 'receipt' }, 'not the group’s copy: an inbox’s own mail, as before');
  const own = mail({ box: AP, at: T0, from: 'Shop <hi@shop.example>', to: AP, subject: 'hello' });
  own.payload.headers.push({ name: 'Delivered-To', value: AP });
  assert.deepEqual(triage(own, fam, { receiptInbox: AP }), { kind: 'ap' }, 'a receipt inbox that is a mailbox of its own');
});

test('ap@: a receipt photo texted in, filed as spam, goes on the card charge it’s for, whoever’s card, and other spam stays unread', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  await withGracie();
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('ch10', 5877, 'The Home Depot', at - 2 * DAY, SAM);
  await mercuryCharge('ch11', 5877, 'Ace Hardware', at - 6 * DAY, PAT);
  const photo = toAp({ at, from: '+14045550123@tmomail.net', labels: ['SPAM', 'UNREAD'], files: [{ name: '815939890.jpg', type: 'image/jpeg', data: JPEG('home depot receipt'), size: 310000 }] });
  const junk = mail({ box: GRACIE, at, from: 'Prize Desk <win@prize.example>', to: GRACIE, subject: 'Your receipt for $58.77 is waiting', labels: ['SPAM'] });
  photoReads['home depot receipt'] = { type: 'receipt', vendor: 'THE HOME DEPOT #0123', total: '$58.77', date: dayOf(at - 2 * DAY), reason: 'a store receipt' };
  calls.length = 0;
  await twice(at + 5 * MIN);

  assert.deepEqual(of('photo').map((c) => c.model).sort(), ['@cf/moonshotai/kimi-k2.6', '@cf/qwen/qwen3.8-27b'], 'both readers read it');
  assert.deepEqual(of('mercury').map((c) => [c.method, c.path, c.attachmentType, c.file, c.type]), [['POST', '/transaction/ch10/attachments', 'receipt', '815939890.jpg', 'image/jpeg']], 'the photo itself, on Sam’s charge');
  assert.deepEqual(await cardRow('mercury:ch10'), { state: 'attached', msg_id: `${GRACIE}:${photo.id}`, detail: 'put “815939890.jpg” (THE HOME DEPOT #0123 $58.77), texted to ap@, on the Mercury card charge (The Home Depot $58.77)' });
  assert.equal((await cardRow('mercury:ch11')).state, 'looking', 'the same amount at another store the week before isn’t it');
  assert.deepEqual(await readRow(photo), { state: 'card', detail: 'put “815939890.jpg” (THE HOME DEPOT #0123 $58.77), texted to ap@, on the Mercury card charge (The Home Depot $58.77)', charge_id: 'mercury:ch10', archived: 'yes' });
  assert.equal(await readRow(junk), null, 'other spam is never read');
  assert.ok(!calls.some((c) => c.kind === 'gmail' && c.path === `/messages/${junk.id}`), 'not even opened');
  assert.equal(of('resend').length, 0, 'nothing is sent anywhere');
});

test('ap@: a receipt whose card charge comes in later waits for it, then goes on; one with none after 8 days says so', async () => {
  Object.assign(env, { RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' });
  await withGracie();
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  const lumber = toAp({ at, from: `Sam Fox <${SAM}>`, subject: 'receipt', files: [{ name: 'IMG_2041.jpg', type: 'image/jpeg', data: JPEG('lumber receipt'), size: 900000 }] });
  const other = toAp({ at: at + MIN, from: `Sam Fox <${SAM}>`, subject: 'another', files: [{ name: 'IMG_2042.jpg', type: 'image/jpeg', data: JPEG('cafe receipt'), size: 900000 }] });
  photoReads['lumber receipt'] = { type: 'receipt', vendor: 'Lumber Co', total: '22.99', date: dayOf(at), reason: 'a receipt' };
  photoReads['cafe receipt'] = { type: 'receipt', vendor: 'Corner Cafe', total: '$14.10', date: dayOf(at), reason: 'a receipt' };
  await twice(at + 5 * MIN);
  await maybeSweepMail(env, { now: at + 7 * MIN, force: true });
  assert.deepEqual(await readRow(lumber), { state: 'waiting', detail: '“IMG_2041.jpg” (Lumber Co $22.99): waiting for its card charge', charge_id: null, archived: null });

  rampTxns.push({ id: 'tx9', state: 'CLEARED', entity_amount: { value: 2299, currency: 'USD' }, user_transaction_time: new Date(at - 60 * MIN).toISOString(), merchant_name: 'LUMBER CO', card_holder: { user_id: 'u-sam' }, receipts: [] });
  calls.length = 0;
  await maybeSweepMail(env, { now: at + 30 * MIN, force: true });
  assert.deepEqual(of('ramp-receipt').map((c) => [c.transaction, c.user, c.file, c.key]), [['tx9', 'u-sam', 'IMG_2041.jpg', `ramp:tx9:${lumber.id}:0:0`]]);
  assert.equal(of('photo').length, 0, 'read once, not again');
  assert.equal((await cardRow('ramp:tx9')).state, 'attached');
  assert.equal((await readRow(lumber)).state, 'card');

  await maybeSweepMail(env, { now: at + 8 * DAY + 2 * MIN, force: true });
  await maybeSweepMail(env, { now: at + 8 * DAY + 3 * MIN, force: true });
  assert.deepEqual(await readRow(other), { state: 'skipped', detail: '“IMG_2042.jpg” (Corner Cafe $14.10): no card charge for it came in within 8 days', charge_id: null, archived: null });
});

test('ap@: only a sure match goes on: readers who disagree need the store’s name, two charges it fits as well wait, and a picture that isn’t a receipt is let go', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  await withGracie();
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('p1', 5877, 'Paint Depot', at - DAY, PAT);
  await mercuryCharge('p2', 4410, 'Studio Supply', at - DAY, PAT);
  await mercuryCharge('p3', 2500, 'Gas Station', at - DAY, PAT);
  await mercuryCharge('p4', 2500, 'Bakery', at - DAY, SAM);
  const split = (a, b) => (model) => ({ ...a, ...(model.includes('qwen') ? b : {}) });
  photoReads.paint = split({ type: 'receipt', vendor: 'PAINT DEPOT', total: '$58.77', date: '', reason: 'a receipt' }, { total: '$58.11' });
  photoReads.smudged = split({ type: 'receipt', vendor: '', total: '$44.10', date: '', reason: 'a receipt' }, { total: '$44.70' });
  photoReads.twenty = { type: 'receipt', vendor: '', total: '$25.00', date: dayOf(at - DAY), reason: 'a receipt' };
  photoReads.room = { type: 'not_receipt', vendor: '', total: '', date: '', reason: 'a photo of a bedroom' };
  const m = (name, words) => toAp({ at, from: '+14045550123@tmomail.net', files: [{ name, type: 'image/jpeg', data: JPEG(words), size: 200000 }] });
  const paint = m('a.jpg', 'paint'), smudged = m('b.jpg', 'smudged'), twenty = m('c.jpg', 'twenty'), room = m('d.jpg', 'room');
  const gif = toAp({ at, from: '+14045550123@tmomail.net', files: [{ name: 'e.gif', type: 'image/gif', data: Buffer.from('GIF89a receipt'), size: 2000 }] });
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true });
  for (let i = 1; i <= 5; i++) await maybeSweepMail(env, { now: at + (5 + i) * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });

  assert.equal((await cardRow('mercury:p1')).state, 'attached', 'the readers differ, but the store and one reading match');
  assert.equal((await readRow(paint)).state, 'card');
  assert.equal((await cardRow('mercury:p2')).state, 'looking', 'readers differing with no store to go by: nothing goes on');
  assert.equal((await readRow(smudged)).state, 'waiting');
  assert.deepEqual([(await cardRow('mercury:p3')).state, (await cardRow('mercury:p4')).state], ['looking', 'looking'], 'two charges it fits as well');
  assert.match((await readRow(twenty)).detail, /^“c\.jpg” \(\$25\.00\): waiting for its card charge \(2 card charges could be it: the Mercury card charge \((Gas Station|Bakery) \$25\.00\), the Mercury card charge \((Gas Station|Bakery) \$25\.00\)\)$/);
  assert.deepEqual(await readRow(room), { state: 'skipped', detail: '“d.jpg”: not a receipt (a photo of a bedroom)', charge_id: null, archived: null });
  assert.deepEqual(await readRow(gif), { state: 'skipped', detail: '“e.gif”: a GIF picture the readers can’t open', charge_id: null, archived: null });
  assert.equal(of('mercury').length, 1);
});

test('ap@: an email passed on with no photo is read from its words and printed onto its charge; a PDF invoice is read from its text', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  env.AI.toMarkdown = async ({ blob }) => ({ format: 'text', data: await blob.text() });
  await withGracie();
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('f1', 32325, 'Pottery Barn Teen', at - 3 * DAY, PAT);
  const fwd = toAp({ at, from: `Pat Lee <${PAT}>`, subject: 'Fwd: Your Pottery Barn Teen order', text: '---------- Forwarded message ---------\nOrder total: $323.25\nThanks for shopping' });
  aiVerdicts['Fwd: Your Pottery Barn Teen order'] = { type: 'receipt', vendor: 'Pottery Barn Teen', total: '$323.25', date: dayOf(at - 3 * DAY), reason: 'an order' };
  const invoice = toAp({ at, from: 'Copan Imports <billing@copan.example>', subject: 'Invoices # 0436', text: 'Attached is the invoice.', files: [{ name: 'INV-0436.pdf', type: 'application/pdf', data: 'Copan Imports invoice 0436. Amount due $1,950.00. Due Dec 1.', size: 52000 }] });
  aiVerdicts['Invoices # 0436 (INV-0436.pdf)'] = { type: 'bill', vendor: 'Copan Imports', total: '$1,950.00', date: '', reason: 'an invoice' };
  calls.length = 0;
  for (let i = 0; i < 4; i++) await maybeSweepMail(env, { now: at + (5 + i) * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.deepEqual(of('mercury').map((c) => [c.path, c.file]), [['/transaction/f1/attachments', `Pottery Barn Teen receipt ${dayOf(at)}.pdf`]], 'the email printed, as a card charge’s look does');
  assert.equal((await readRow(fwd)).detail, 'put the email (Pottery Barn Teen $323.25), sent to ap@ by Pat, on the Mercury card charge (Pottery Barn Teen $323.25)');
  assert.deepEqual(await readRow(invoice), { state: 'waiting', detail: '“INV-0436.pdf” (Copan Imports $1950.00): waiting for its card charge', charge_id: null, archived: null }, 'a bill on no card waits, then is let go');
});

test('a card charge’s own look never takes the site’s own forward to ap@ for its receipt', async () => {
  Object.assign(env, { MERCURY_API_TOKEN: 'mercury-test', MERCURY_RELAY_KEY: 'relay-test' });
  await withGracie();
  await maybeSweepMail(env, { now: T0, force: true });
  const at = T0 + WATCH_MS + MIN;
  await env.DB.exec(MERCURY_CHARGES);
  await mercuryCharge('s1', 216, 'MagicPixiePalette', at - 3 * 60 * MIN, PAT);
  toAp({ at: at - 2 * 60 * MIN, from: 'Sunshine on a Ranney Day <sunshine@comms.sunshineonaranneyday.com>', subject: 'Receipt: MagicPixiePalette $2.16 on 2026-11-06 (from Pat’s email)', text: 'A receipt found in Pat Lee’s email. Amount: $2.16', files: [{ name: 'receipt.pdf', type: 'application/pdf', data: '%PDF magic', size: 30000 }] });
  calls.length = 0;
  await maybeSweepMail(env, { now: at + 5 * MIN, force: true, print: async () => new Uint8Array([37, 80, 68, 70]) });
  assert.equal((await cardRow('mercury:s1')).state, 'looking');
  assert.equal(of('mercury').length, 0);
});
