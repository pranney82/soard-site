/**
 * The record of what the board signs (functions/api/_board-sign.js): each signature's evidence (its IP, device,
 * this sign-in's start, the address Access checked, the wording's or file's SHA-256), one append-only chain of
 * events that shows any edit afterwards, nothing a signature rests on deleted (a replaced row into the chain, a
 * copy superseded, a signed paper and its files kept), a second Sign or a second device never doubling a
 * signature, a paper's first open each year, renames following the record, an iPhone photo's original kept.
 * Made-up people only (the repo is public).
 * Run: node --test tests/board-sign.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequest, _resetKeyCacheForTests } from '../functions/api/_middleware.js';
import * as admin from '../functions/api/board-admin.js';
import * as portal from '../functions/api/board-portal.js';
import * as fileRoute from '../functions/api/board-file.js';
import { listDocs, saveDoc, deleteDoc, signDoc, signWithCopy, signFromDrive, unsignDoc, fileFor, packetEmail, portalData, saveMeeting, listMeetings, SIGNED_BY } from '../functions/api/_board.js';
import { todayEastern, newMeeting } from '../public/admin/board-shared.js';

// ── A real RS256 key served as Access's certs (as tests/board.test.mjs does)
const TEAM = 'soard';
const AUD = 'aud-tag';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
async function signIn(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ISS, aud: [AUD], email, iat: now, nbf: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}

const FOUNDER = 'jane@soardcharity.com';
const MEMBER = 'alex.board@example.com';
const OTHER = 'sam.board@example.org';
const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
  ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
  ['old-timer', { name: 'Old Timer', group: 'board', title: 'Board Member', status: 'alumni' }],
];
const YEAR = Number(todayEastern().slice(0, 4));

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}
const pdf = (name, words = 'signed') => new File([new TextEncoder().encode(`%PDF-1.4 ${words}`)], name, { type: 'application/pdf' });
const jpeg = (name) => new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 1, 2])], name, { type: 'image/jpeg' });

let env;
const realFetch = globalThis.fetch;
let sent = [];
beforeEach(async () => {
  env = { DB: await createD1(), FILES: new FakeR2(), CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, RESEND_API_KEY: 're_test' };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of [['alex-rivera', MEMBER], ['sam-ortiz', OTHER], ['kim-park', 'kim.board@example.com']]) {
    await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  }
  _resetKeyCacheForTests();
  sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.startsWith('https://api.resend.com/')) {
      const b = JSON.parse(init.body);
      sent.push(...(Array.isArray(b) ? b : [b]));
      return Response.json(Array.isArray(b) ? { data: b.map((_, i) => ({ id: `em_${i}` })) } : { id: `em_${sent.length}` });
    }
    // Nothing else outside answers in these tests (the numbers, the calendar): they come back empty
    return new Response('{}', { status: 503 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

/** A request through the middleware, signed in as `email`, landing on `handler` */
async function call(email, path, { method = 'GET', body = null, handler, form = null, ip = '203.0.113.7', ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } = {}) {
  const headers = { 'CF-Access-JWT-Assertion': await signIn(email), Origin: 'https://sunshineonaranneyday.com', 'CF-Connecting-IP': ip, 'User-Agent': ua };
  if (body) headers['Content-Type'] = 'application/json';
  const request = new Request(`https://sunshineonaranneyday.com${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const ctx = { request, env, data: {}, waitUntil: () => {} };
  ctx.next = async () => handler(ctx);
  const res = await onRequest(ctx);
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
}
const formOf = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };
const memberOf = (slug) => ({ slug, name: PEOPLE.find((p) => p[0] === slug)[1].name, email: `${slug}@example.com` });
/** The expectations, every member signing them each year, with their file */
/** The expectations, every member signing them each year, with their file */
async function expectations({ shared = true, title = 'Board Member Expectations' } = {}) {
  const d = await saveDoc(env.DB, { title, kind: 'policy', sign: true, shared });
  const { putFile } = await import('../functions/api/_board.js');
  await putFile(env, { ownerType: 'doc', ownerId: d.id, file: pdf('Board Expectations.pdf', 'the expectations') });
  return (await listDocs(env.DB)).find((x) => x.id === d.id);
}

const { checkChain, appendEvents, sha256Hex, eventsOf, slugsOf } = await import('../functions/api/_board-sign.js');
const eventsAll = async () => (await env.DB.prepare('SELECT * FROM board_sign_events ORDER BY seq').all()).results;
const written = async (title = 'Board Member Expectations', body = '### Attendance\n\n- Come to three of four meetings') => saveDoc(env.DB, { title, kind: 'policy', sign: true, body }, { by: FOUNDER });

test('a signature on the board page keeps its evidence: the address Access checked, IP, device, the sign-in, the wording’s SHA-256, in the chain', async () => {
  const d = await written();
  const got = await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'sign', docId: d.id, name: 'Alex Rivera', version: 1, as: 'alex-rivera' }, handler: portal.onRequestPost });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const row = await env.DB.prepare("SELECT * FROM board_signatures WHERE slug = 'alex-rivera'").first();
  assert.deepEqual([row.signer_email, row.ip, row.device, !!row.signin_at, row.hash], [MEMBER, '203.0.113.7', 'iPhone · Safari', true, await sha256Hex(d.body)]);
  const version = await env.DB.prepare('SELECT hash FROM board_doc_versions WHERE doc_id = ? AND version = 1').bind(d.id).first();
  assert.equal(version.hash, row.hash, 'the signature’s hash is its wording’s');
  const ev = await eventsAll();
  assert.deepEqual(ev.map((e) => [e.kind, e.slug, e.ip]), [['signed', 'alex-rivera', '203.0.113.7']]);
  assert.deepEqual([JSON.parse(ev[0].detail).signerEmail, ev[0].prev], [MEMBER, 'genesis']);
  assert.deepEqual(await checkChain(env.DB), { ok: true, count: 1, broken: null });
  // Opened, once a year: the first time only
  for (let i = 0; i < 2; i++) await call(OTHER, '/api/board-portal', { method: 'POST', body: { action: 'opened', docId: d.id }, handler: portal.onRequestPost, ip: '198.51.100.2' });
  const opened = (await eventsAll()).filter((e) => e.kind === 'opened');
  assert.deepEqual(opened.map((e) => [e.slug, e.ip]), [['sam-ortiz', '198.51.100.2']]);
  // An admin looking at the board page opens nothing on anyone's record
  await call(FOUNDER, '/api/board-portal', { method: 'POST', body: { action: 'opened', docId: d.id }, handler: portal.onRequestPost });
  assert.equal((await eventsAll()).filter((e) => e.kind === 'opened').length, 1);
});

test('the chain shows an edit made afterwards, and two writers never fork it (the second goes after the first)', async () => {
  const d = await written();
  await Promise.all(['alex-rivera', 'sam-ortiz', 'kim-park'].map((s) => signDoc(env.DB, d.id, memberOf(s), PEOPLE.find((p) => p[0] === s)[1].name)));
  const ev = await eventsAll();
  assert.equal(ev.length, 3);
  assert.equal(new Set(ev.map((e) => e.prev)).size, 3, 'each follows a different one');
  assert.deepEqual(await checkChain(env.DB), { ok: true, count: 3, broken: null });
  // Someone edits the record directly: the chain says where
  await env.DB.prepare("UPDATE board_sign_events SET ip = '10.0.0.1' WHERE seq = 2").run();
  assert.deepEqual(await checkChain(env.DB), { ok: false, count: 3, broken: 2 });
});

test('Sign pressed twice, or on two devices at once: one signature, one event', async () => {
  const d = await written();
  const alex = memberOf('alex-rivera');
  const [a, b] = await Promise.all([signDoc(env.DB, d.id, alex, 'Alex Rivera', { version: 1 }), signDoc(env.DB, d.id, alex, 'Alex Rivera', { version: 1 })]);
  assert.equal(a.at, b.at, 'the second returns the first');
  assert.equal((await eventsAll()).filter((e) => e.kind === 'signed').length, 1);
  await signDoc(env.DB, d.id, alex, 'Alex Rivera', { version: 1 });
  assert.equal((await eventsAll()).length, 1);
});

test('a batch that fails changes nothing: a signature never goes in without its event', async () => {
  const d = await written();
  await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera');
  const before = await eventsAll();
  // A writer that took the chain's place first (the same prev): its whole batch is refused, the row with it
  await assert.rejects(env.DB.batch([
    env.DB.prepare("INSERT INTO board_signatures (doc_id, slug, year, name, at, how, version) VALUES (?, 'kim-park', ?, 'Kim Park', ?, 'typed', 1)").bind(d.id, YEAR, new Date().toISOString()),
    env.DB.prepare("INSERT INTO board_sign_events (prev, hash, slug, kind, at) VALUES (?, 'x', 'kim-park', 'signed', ?)").bind(before[0].prev, new Date().toISOString()),
  ]), /UNIQUE/);
  assert.equal(await env.DB.prepare("SELECT slug FROM board_signatures WHERE slug = 'kim-park'").first(), null, 'rolled back whole');
  // Another writer lands between reading the chain's head and writing after it: appendEvents looks again and goes after it
  let tries = 0;
  const realBatch = env.DB.batch;
  env.DB.batch = async (stmts) => {
    if (tries === 1) {
      const head = await env.DB.prepare('SELECT hash FROM board_sign_events ORDER BY seq DESC LIMIT 1').first();
      await env.DB.prepare("INSERT INTO board_sign_events (prev, hash, slug, kind, at) VALUES (?, 'racer', 'sam-ortiz', 'opened', ?)").bind(head.hash, new Date().toISOString()).run();
    }
    return realBatch(stmts);
  };
  await appendEvents(env.DB, async () => { tries++; return { events: [{ kind: 'asked', slug: 'kim-park', year: YEAR }] }; });
  env.DB.batch = realBatch;
  assert.equal(tries, 2, 'asked again after the other writer');
  const ev = await eventsAll();
  assert.deepEqual(ev.map((e) => e.kind), ['signed', 'opened', 'asked']);
});

test('nothing a signature rests on is deleted: a signed paper, its file and copies are kept; the admin can’t delete them; an unsigned one goes', async () => {
  const d = await expectations();
  const kim = await signWithCopy(env, d.id, pdf('Kim.pdf'), { slug: 'kim-park', by: FOUNDER });
  const del = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'delete-doc', id: d.id }, handler: admin.onRequestPost });
  assert.deepEqual([del.status, del.body.signed], [409, true]);
  for (const id of [kim.copy.id, d.file.id]) {
    const r = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'delete-file', id }, handler: admin.onRequestPost });
    assert.deepEqual([r.status, r.body.kept], [409, true], `kept: ${id}`);
  }
  assert.ok(await fileFor(env.DB, kim.copy.id, { admin: true }));
  // Taken off too: the paper's file is still kept (someone signed it once)
  await unsignDoc(env, d.id, 'kim-park', YEAR, { by: FOUNDER });
  assert.equal((await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'delete-file', id: d.file.id }, handler: admin.onRequestPost })).status, 409);
  // The general upload takes a meeting's file only
  const up = await call(FOUNDER, '/api/board-admin', { method: 'POST', form: formOf({ ownerType: 'doc', ownerId: d.id, file: pdf('x.pdf') }), handler: admin.onRequestPost });
  assert.equal(up.status, 400);
  const rec = await call(FOUNDER, '/api/board-admin', { method: 'POST', form: formOf({ ownerType: 'record', ownerId: d.id, file: pdf('x.pdf') }), handler: admin.onRequestPost });
  assert.equal(rec.status, 400);
});

test('a copy is its member’s by the file itself: theirs to open, a renamed member’s too; an iPhone photo’s original is kept beside its JPEG', async () => {
  const d = await expectations();
  const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])], 'IMG_0001.HEIC', { type: 'image/heic' });
  const got = await call(OTHER, `/api/board-portal?signed=${d.id}`, { method: 'POST', form: formOf({ file: jpeg('IMG_0001.jpg'), original: heic, version: '0', as: 'sam-ortiz' }), handler: portal.onRequestPost });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const files = (await env.DB.prepare("SELECT * FROM board_files WHERE owner_type = 'signed'").all()).results;
  const view = files.find((f) => f.type === 'image/jpeg');
  const orig = files.find((f) => f.id === view.original_id);
  assert.ok(orig, 'the original is kept, linked from the copy a browser shows');
  assert.deepEqual([view.slug, orig.slug, /^[0-9a-f]{64}$/.test(orig.sha256)], ['sam-ortiz', 'sam-ortiz', true]);
  assert.ok(await fileFor(env.DB, view.id, { member: memberOf('sam-ortiz') }));
  assert.ok(await fileFor(env.DB, orig.id, { member: memberOf('sam-ortiz') }));
  assert.equal(await fileFor(env.DB, view.id, { member: memberOf('kim-park') }), null);
  // The signature's evidence says what came in: the copy's and the original's hashes
  const ev = (await eventsAll()).find((e) => e.kind === 'signed');
  assert.deepEqual([JSON.parse(ev.detail).copySha256, JSON.parse(ev.detail).original.sha256], [view.sha256, orig.sha256]);
  // Renamed on People: their signature, copy and record follow them; the chain says the old slug is theirs
  const { rename } = await import('../functions/api/rename-content.js');
  await env.DB.exec('CREATE TABLE IF NOT EXISTS content_versions (id INTEGER PRIMARY KEY, collection TEXT, slug TEXT, data TEXT, created_at TEXT, user_email TEXT)');
  await rename({ ...env, CF_IMAGES_TOKEN: '' }, { collection: 'team', from: 'sam-ortiz', to: 'samuel-ortiz' }, FOUNDER).catch((e) => e);
  const moved = await env.DB.prepare("SELECT slug FROM board_signatures WHERE doc_id = ?").bind(d.id).first();
  if (moved?.slug === 'samuel-ortiz') {
    assert.equal((await env.DB.prepare('SELECT slug FROM board_files WHERE id = ?').bind(view.id).first()).slug, 'samuel-ortiz');
    assert.deepEqual(await slugsOf(env.DB, 'samuel-ortiz'), ['samuel-ortiz', 'sam-ortiz']);
    assert.ok((await eventsOf(env.DB, { slug: 'samuel-ortiz' })).some((e) => e.kind === 'signed'), 'their events before the rename are theirs still');
    assert.deepEqual(await checkChain(env.DB), { ok: true, count: 2, broken: null });
  } else assert.fail(`rename didn't move the signature (${JSON.stringify(moved)})`);
});

test('copies from before files said whose: the migration fills it in from their signatures', async () => {
  const d = await expectations();
  const c = await signWithCopy(env, d.id, pdf('Kim.pdf'), { slug: 'kim-park', by: FOUNDER });
  await env.DB.prepare('UPDATE board_files SET slug = NULL WHERE id = ?').bind(c.copy.id).run();
  const { ensureSchema } = await import('../functions/api/_board.js');
  // (a fresh isolate runs the migration again)
  const fresh = { ...env.DB, prepare: env.DB.prepare.bind(env.DB), batch: env.DB.batch.bind(env.DB), exec: env.DB.exec.bind(env.DB) };
  await ensureSchema(fresh);
  assert.equal((await env.DB.prepare('SELECT slug FROM board_files WHERE id = ?').bind(c.copy.id).first()).slug, 'kim-park');
});
