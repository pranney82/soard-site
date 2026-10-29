/**
 * SOARD mailboxes, read-only (functions/api/_mailbox.js, /api/mailbox-admin)
 * Run: node --test tests/mailbox.test.mjs
 *
 * A founder searches and reads a staff inbox through the site's Google key:
 * only founders, only active soardcharity.com accounts (an alias opens its
 * account), Gmail's read-only scope, nothing but GETs to Google, every read
 * logged, and attached files always downloaded, never shown as a page.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequestGet } from '../functions/api/mailbox-admin.js';
import { htmlText } from '../functions/api/_mailbox.js';
import { clearTokenCache, GMAIL_READ_SCOPE } from '../functions/api/_google-calendar.js';

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM });

const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['pat-lee', { name: 'Pat Lee', group: 'team', title: 'Program Director' }],
];
const ACCOUNTS = [
  { email: 'jane@soardcharity.com', aliases: [], name: 'Jane Doe', active: true, why: null },
  { email: 'pat@soardcharity.com', aliases: ['hello@soardcharity.com'], name: 'Pat Lee', active: true, why: null },
  { email: 'old@soardcharity.com', aliases: [], name: 'Old Hand', active: false, why: 'suspended' },
];

const b64u = (s) => Buffer.from(s).toString('base64url');
const PDF = '%PDF-1.4 receipt';
const RECEIPT_HTML = '<html><head><style>p{color:red}</style></head><body><p>Thanks for your order&nbsp;#123</p><table><tr><td>Paint</td><td>$42.10</td></tr></table><p>Total &amp; tax: $45.00</p></body></html>';
const MAIL = {
  m1aaaaaa: {
    id: 'm1aaaaaa', threadId: 't1aaaaaa', internalDate: String(Date.parse('2026-10-20T15:00:00Z')), snippet: 'Thanks for your order', labelIds: ['INBOX'],
    payload: {
      partId: '', mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Store <orders@store.example>' }, { name: 'To', value: 'pat@soardcharity.com' }, { name: 'Subject', value: 'Your receipt' }],
      parts: [
        { partId: '0', mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { data: b64u(RECEIPT_HTML), size: RECEIPT_HTML.length } },
        { partId: '1', mimeType: 'application/pdf', filename: 'receipt.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="receipt.pdf"' }], body: { attachmentId: 'ATT-PDF', size: PDF.length } },
        { partId: '2', mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline' }], body: { data: b64u('png'), size: 3 } },
        { partId: '3', mimeType: 'text/html', filename: 'invoice.html', headers: [], body: { data: b64u('<script>alert(1)</script>'), size: 25 } },
      ],
    },
  },
  m2bbbbbb: {
    id: 'm2bbbbbb', threadId: 't1aaaaaa', internalDate: String(Date.parse('2026-10-21T15:00:00Z')), snippet: 'Hi, about our kitchen', labelIds: ['INBOX', 'UNREAD'],
    payload: {
      partId: '', mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'A Parent <parent@example.com>' }, { name: 'Subject', value: 'Re: Your receipt' }],
      parts: [
        { partId: '0', mimeType: 'text/plain', headers: [], body: { data: b64u('Hi, about our kitchen.'), size: 22 } },
        { partId: '1', mimeType: 'text/html', headers: [], body: { data: b64u('<p>Hi, about our <b>kitchen</b>.</p>'), size: 36 } },
      ],
    },
  },
};
const metadataOf = (m) => ({ ...m, payload: { headers: m.payload.headers } });

let env;
let calls; // Google calls: { kind, subject?, scope?, method?, url? }
let scopeGranted;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  calls = [];
  scopeGranted = true;
  clearTokenCache();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      calls.push({ kind: 'token', subject: claims.sub, scope: claims.scope });
      if (!scopeGranted) return Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method.' }, { status: 401 });
      return Response.json({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')) {
      calls.push({ kind: 'gmail', method: init.method || 'GET', url, subject: String(init.headers?.Authorization || '').replace('Bearer tok:', '') });
      const u = new URL(url);
      const path = u.pathname.replace('/gmail/v1/users/me', '');
      if (path === '/messages') return Response.json({ messages: Object.keys(MAIL).map((id) => ({ id })), resultSizeEstimate: 2, nextPageToken: 'NEXT1' });
      let m;
      if ((m = /^\/messages\/(\w+)\/attachments\/(.+)$/.exec(path))) return m[2] === 'ATT-PDF' ? Response.json({ data: b64u(PDF), size: PDF.length }) : Response.json({ error: { message: 'no' } }, { status: 404 });
      if ((m = /^\/messages\/(\w+)$/.exec(path))) {
        const msg = MAIL[m[1]];
        if (!msg) return Response.json({ error: { code: 404, message: 'Requested entity was not found.' } }, { status: 404 });
        return Response.json(u.searchParams.get('format') === 'metadata' ? metadataOf(msg) : msg);
      }
      if ((m = /^\/threads\/(\w+)$/.exec(path))) return Response.json({ id: m[1], messages: Object.values(MAIL).filter((x) => x.threadId === m[1]) });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function get(me, query = '') {
  const res = await onRequestGet({ request: new Request(`https://sunshineonaranneyday.com/api/mailbox-admin${query}`), env, data: { userEmail: me } });
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()).toString() };
}
const audits = async () => (await env.DB.prepare('SELECT user_email, action, entity_type, entity_slug, entity_name FROM audit_log ORDER BY id').all()).results;

test('only a founder can read a mailbox; they see the active accounts and their aliases', async () => {
  const pat = await get('pat@soardcharity.com');
  assert.equal(pat.status, 403);
  assert.match(pat.body.error, /founders/);
  assert.equal((await get('jane@example.com')).status, 403);
  assert.equal(calls.length, 0, 'a refused reader never reaches Google');

  const jane = await get('jane@soardcharity.com');
  assert.equal(jane.status, 200);
  assert.deepEqual(jane.body.mailboxes.map((m) => m.email), ['jane@soardcharity.com', 'pat@soardcharity.com']);
  assert.deepEqual(jane.body.mailboxes[1].aliases, ['hello@soardcharity.com']);
});

test('an alias opens the account it belongs to; groups, outsiders and suspended accounts are refused', async () => {
  const r = await get('jane@soardcharity.com', '?mailbox=hello@soardcharity.com&q=receipt');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.mailbox, { email: 'pat@soardcharity.com', name: 'Pat Lee', alias: 'hello@soardcharity.com' });
  assert.ok(calls.filter((c) => c.kind === 'gmail').every((c) => c.subject === 'pat@soardcharity.com'));

  const group = await get('jane@soardcharity.com', '?mailbox=team@soardcharity.com');
  assert.equal(group.status, 404);
  assert.match(group.body.error, /isn’t a Google account of its own/);
  assert.equal((await get('jane@soardcharity.com', '?mailbox=someone@example.com')).status, 400);
  const old = await get('jane@soardcharity.com', '?mailbox=old@soardcharity.com');
  assert.equal(old.status, 403);
  assert.match(old.body.error, /suspended/);
});

test('search: Gmail read-only, the search words passed on, newest summaries, logged', async () => {
  const r = await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&q=' + encodeURIComponent('has:attachment receipt') + '&max=500');
  assert.equal(r.status, 200);
  assert.equal(r.body.next, 'NEXT1');
  assert.deepEqual(r.body.messages.map((m) => m.subject), ['Your receipt', 'Re: Your receipt']);
  assert.equal(r.body.messages[0].from, 'Store <orders@store.example>');
  assert.equal(r.body.messages[0].at, '2026-10-20T15:00:00.000Z');

  const tokens = calls.filter((c) => c.kind === 'token');
  assert.deepEqual(tokens.map((t) => [t.subject, t.scope]), [['pat@soardcharity.com', GMAIL_READ_SCOPE]]);
  const list = new URL(calls.find((c) => c.kind === 'gmail').url);
  assert.equal(list.searchParams.get('q'), 'has:attachment receipt');
  assert.equal(list.searchParams.get('maxResults'), '50', 'max is capped');
  assert.ok(calls.filter((c) => c.kind === 'gmail').every((c) => c.method === 'GET'), 'only reads');

  assert.deepEqual(await audits(), [{ user_email: 'jane@soardcharity.com', action: 'viewed', entity_type: 'mailbox', entity_slug: 'pat@soardcharity.com', entity_name: 'searched for “has:attachment receipt”' }]);
});

test('an email: an HTML-only receipt reads as text, plain text wins over HTML, files are listed', async () => {
  const receipt = await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&id=m1aaaaaa');
  assert.equal(receipt.status, 200);
  const m = receipt.body.message;
  assert.equal(m.text, 'Thanks for your order #123\nPaint $42.10\n\nTotal & tax: $45.00');
  assert.deepEqual(m.files.map((f) => [f.part, f.name, f.inline]), [['1', 'receipt.pdf', false], ['2', 'logo.png', true], ['3', 'invoice.html', false]]);

  const family = await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&id=m2bbbbbb');
  assert.equal(family.body.message.text, 'Hi, about our kitchen.');
  assert.deepEqual(family.body.message.labels, ['INBOX', 'UNREAD']);
  assert.equal((await audits()).at(-1).entity_name, 'opened “Re: Your receipt”');

  assert.equal((await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&id=../../x')).status, 400);
  assert.equal((await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&id=zzzzzzzz')).status, 404);
});

test('a conversation comes back whole', async () => {
  const r = await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&thread=t1aaaaaa');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.messages.map((m) => m.id), ['m1aaaaaa', 'm2bbbbbb']);
  assert.match((await audits()).at(-1).entity_name, /conversation “Your receipt”/);
});

test('a file always downloads; only safe types keep their type', async () => {
  const pdf = await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&id=m1aaaaaa&part=1');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('Content-Type'), 'application/pdf');
  assert.match(pdf.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''receipt\.pdf$/);
  assert.equal(pdf.body, PDF);

  const html = await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&id=m1aaaaaa&part=3');
  assert.equal(html.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(html.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(html.headers.get('Content-Security-Policy'), /sandbox/);

  assert.equal((await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com&id=m1aaaaaa&part=9')).status, 404);
  assert.equal((await audits()).filter((a) => /downloaded/.test(a.entity_name)).length, 2);
});

test('without Gmail on the delegation, the error says where to grant it', async () => {
  scopeGranted = false;
  const r = await get('jane@soardcharity.com', '?mailbox=pat@soardcharity.com');
  assert.equal(r.status, 500);
  assert.match(r.body.error, /Domain-wide delegation needs gmail\.readonly/);
});

test('htmlText keeps the words and drops the markup', () => {
  assert.equal(htmlText('<div>A&#39;s &lt;b&gt;</div><br>B&#x2014;C<!-- x --><script>bad()</script>'), 'A\'s <b>\n\nB—C');
});
