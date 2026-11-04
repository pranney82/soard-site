/**
 * SOARD's Drive, read-only (functions/api/_drive-search.js, /api/drive-admin)
 * Run: node --test tests/drive-search.test.mjs
 *
 * A founder searches every active staff account's Drive at once through the
 * site's Google key: founders only, Drive's read-only scope, only GETs, every
 * search and open logged, a file shared with several people listed once, and
 * files always downloaded, never shown as a page.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequestGet } from '../functions/api/drive-admin.js';
import { DRIVE_READ_SCOPE } from '../functions/api/_drive-search.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM });
const PEOPLE = [['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }], ['pat-lee', { name: 'Pat Lee', group: 'team', title: 'Program Director' }]];
const ACCOUNTS = [
  { email: 'jane@soardcharity.com', aliases: [], name: 'Jane Doe', active: true, why: null },
  { email: 'pat@soardcharity.com', aliases: [], name: 'Pat Lee', active: true, why: null },
  { email: 'old@soardcharity.com', aliases: [], name: 'Old Hand', active: false, why: 'suspended' },
];
// What each person's Drive holds (pat's plushie is shared with jane too)
const DRIVES = {
  'jane@soardcharity.com': [{ id: 'fileShared123', name: 'Plushie team.png', mimeType: 'image/png', size: '2000', modifiedTime: '2026-10-01T00:00:00Z', owners: [{ emailAddress: 'pat@soardcharity.com' }] }],
  'pat@soardcharity.com': [
    { id: 'fileShared123', name: 'Plushie team.png', mimeType: 'image/png', size: '2000', modifiedTime: '2026-10-01T00:00:00Z', owners: [{ emailAddress: 'pat@soardcharity.com' }] },
    { id: 'fileNewer4567', name: 'plushie notes.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-11-01T00:00:00Z', owners: [{ emailAddress: 'pat@soardcharity.com' }] },
  ],
};

let env; let calls;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  calls = [];
  clearTokenCache();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      calls.push({ kind: 'token', subject: claims.sub, scope: claims.scope });
      return Response.json({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files')) {
      const who = String(init.headers?.Authorization || '').replace('Bearer tok:', '');
      calls.push({ kind: 'drive', method: init.method || 'GET', url, who });
      const u = new URL(url);
      const m = /\/files\/([^/]+)$/.exec(u.pathname);
      if (!m) return Response.json({ files: DRIVES[who] || [] });
      const f = (DRIVES[who] || []).find((x) => x.id === decodeURIComponent(m[1]));
      if (!f) return Response.json({ error: { message: 'File not found' } }, { status: 404 });
      if (u.searchParams.get('alt') === 'media') return new Response('PNGBYTES', { headers: { 'Content-Type': 'image/png' } });
      return Response.json(f);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function get(me, query = '') {
  const res = await onRequestGet({ request: new Request(`https://sunshineonaranneyday.com/api/drive-admin${query}`), env, data: { userEmail: me } });
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()).toString() };
}

test('founders only; every active account searched with Drive’s read-only scope; a shared file listed once, newest first', async () => {
  assert.equal((await get('pat@soardcharity.com', '?q=plushie')).status, 403);
  assert.equal(calls.length, 0, 'a refused reader never reaches Google');
  const r = await get('jane@soardcharity.com', '?q=plushie&images=1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files.map((f) => f.id), ['fileNewer4567', 'fileShared123']);
  assert.ok(calls.filter((c) => c.kind === 'token').every((c) => c.scope === DRIVE_READ_SCOPE));
  assert.deepEqual([...new Set(calls.filter((c) => c.kind === 'token').map((c) => c.subject))].sort(), ['jane@soardcharity.com', 'pat@soardcharity.com'], 'never a suspended account');
  assert.ok(calls.filter((c) => c.kind === 'drive').every((c) => c.method === 'GET'));
  const q = new URL(calls.find((c) => c.kind === 'drive').url).searchParams.get('q');
  assert.match(q, /name contains 'plushie' or fullText contains 'plushie'/);
  assert.match(q, /mimeType contains 'image\/'/);
  const log = (await env.DB.prepare('SELECT entity_name FROM audit_log').all()).results.map((x) => x.entity_name);
  assert.match(log.join(' | '), /searched every account for “plushie” \(pictures\)/);
});

test('words can’t break out of Drive’s query', async () => {
  await get('jane@soardcharity.com', `?q=${encodeURIComponent("x' or trashed = true or name contains '")}`);
  const q = new URL(calls.find((c) => c.kind === 'drive').url).searchParams.get('q');
  assert.ok(q.startsWith("(name contains 'x\\' or trashed = true or name contains \\''"), q);
});

test('a file opens as a download, logged', async () => {
  const r = await get('jane@soardcharity.com', '?account=pat@soardcharity.com&file=fileShared123');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'PNGBYTES');
  assert.match(r.headers.get('Content-Disposition'), /^attachment;/);
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(r.headers.get('Content-Security-Policy'), /sandbox/);
  assert.equal((await get('jane@soardcharity.com', '?account=pat@soardcharity.com&file=bad')).status, 400);
});
