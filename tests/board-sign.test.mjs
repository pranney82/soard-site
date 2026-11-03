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
  const got = await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'sign', docId: d.id, version: 1, as: 'alex-rivera', year: YEAR, mark: typedMark(), consent: true }, handler: portal.onRequestPost });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const row = await env.DB.prepare("SELECT * FROM board_signatures WHERE slug = 'alex-rivera'").first();
  assert.deepEqual([row.signer_email, row.ip, row.device, !!row.signin_at, row.hash], [MEMBER, '203.0.113.7', 'iPhone · Safari', true, await sha256Hex(d.body)]);
  const version = await env.DB.prepare('SELECT hash FROM board_doc_versions WHERE doc_id = ? AND version = 1').bind(d.id).first();
  assert.equal(version.hash, row.hash, 'the signature’s hash is its wording’s');
  const ev = await eventsAll();
  assert.deepEqual(ev.map((e) => [e.kind, e.slug, e.ip]), [['signed', 'alex-rivera', '203.0.113.7'], ['consented', 'alex-rivera', '203.0.113.7']]);
  assert.deepEqual([JSON.parse(ev[0].detail).signerEmail, ev[0].prev, ev[1].prev], [MEMBER, 'genesis', ev[0].hash]);
  assert.deepEqual(await checkChain(env.DB), { ok: true, count: 2, broken: null });
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
    assert.deepEqual((await slugsOf(env.DB, 'samuel-ortiz')).map((x) => x.slug), ['samuel-ortiz', 'sam-ortiz']);
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

const MARKED = '### Giving\n\n- Annual minimum $6,000.00 Donation/Sponsorship {initials}\n- My giving commitment: {answer}\n\nAttend three of four meetings. {initials}';
const typedMark = (text = 'Alex Rivera', initials = 'AR') => ({ type: 'typed', style: 'caveat', text, initials });
const signAs = (email, body) => call(email, '/api/board-portal', { method: 'POST', body: { action: 'sign', year: YEAR, ...body }, handler: portal.onRequestPost });

test('signing a paper that asks for initials and an answer: every one required, consent once, the mark and fields kept', async () => {
  const d = await written('Board Member Expectations', MARKED);
  const { paperFields } = await import('../public/admin/board-md.js');
  assert.deepEqual(paperFields(d.body).map((f) => [f.n, f.kind]), [[1, 'initials'], [2, 'answer'], [3, 'initials']]);
  // A page from before marks (a name only): this paper asks for initials, so it reloads
  let r = await signAs(MEMBER, { docId: d.id, name: 'Alex Rivera', version: 1 });
  assert.deepEqual([r.status, r.body.reload], [409, true]);
  // Points left blank: named, the first one
  r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: { 1: 'AR' }, consent: true });
  assert.deepEqual([r.status, r.body.missing, /Answer point 2 first/.test(r.body.error)], [400, [2, 3], true]);
  // Initials that aren't theirs (the adopted ones) don't count
  r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: { 1: 'XX', 2: '$1,500', 3: 'AR' }, consent: true });
  assert.deepEqual([r.status, r.body.missing], [400, [1]]);
  // Not agreeing to sign electronically (the first time): asked
  r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: { 1: 'AR', 2: '$1,500', 3: 'AR' } });
  assert.deepEqual([r.status, r.body.consent], [409, true]);
  // Someone else's name is no signature, typed or drawn
  r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark('Kim Park', 'KP'), fields: { 1: 'KP', 2: 'x', 3: 'KP' }, consent: true });
  assert.equal(r.status, 400);
  // A page left open over New Year's
  r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: { 1: 'AR', 2: '$1,500', 3: 'AR' }, consent: true, year: YEAR - 1 });
  assert.deepEqual([r.status, r.body.newYear], [409, true]);
  // All of it: signed, with the mark, each field and the consent kept
  r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: { 1: 'ar', 2: ' $1,500  a year ', 3: 'AR' }, consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.how, r.body.mark.style, r.body.fields.map((f) => f.value)], ['typed', 'caveat', ['ar', '$1,500 a year', 'AR']]);
  const row = await env.DB.prepare("SELECT * FROM board_signatures WHERE slug = 'alex-rivera'").first();
  const { CONSENT_TEXT, PROCESS_V } = await import('../functions/api/_board-sign.js');
  assert.deepEqual([JSON.parse(row.fields).length, JSON.parse(row.mark).text, row.consent_hash, row.process_v], [3, 'Alex Rivera', await sha256Hex(CONSENT_TEXT), PROCESS_V]);
  const marks = await env.DB.prepare("SELECT * FROM board_member_marks WHERE slug = 'alex-rivera'").first();
  assert.deepEqual([JSON.parse(marks.mark).style, marks.initials, !!marks.consent_at, marks.consent_ip], ['caveat', 'AR', true, '203.0.113.7']);
  const kinds = (await eventsAll()).map((e) => e.kind);
  assert.deepEqual(kinds, ['signed', 'consented']);
  // The board page brings their mark back next time, consent given
  const page = await call(MEMBER, '/api/board-portal', { handler: portal.onRequestGet });
  assert.deepEqual([page.body.me.mark.style, page.body.me.mark.consented, page.body.docs.find((x) => x.id === d.id).signedByMe.fields.length], ['caveat', true, 3]);
  // Signing again with the same wording: the first signature stands
  r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: { 1: 'AR', 2: 'more', 3: 'AR' } });
  assert.equal(r.body.fields, undefined);
  assert.equal((await eventsAll()).filter((e) => e.kind === 'signed').length, 1);
});

test('a drawn signature is a path, checked; a page from before (a name alone) reloads: nobody signs without agreeing to sign electronically', async () => {
  const d = await written();
  const drawn = { type: 'drawn', style: 'caveat', text: 'Sam Ortiz', initials: 'SO', path: 'M10 100 L40 80 L80 120 L120 60 L160 110' };
  let r = await signAs(OTHER, { docId: d.id, version: 1, mark: { ...drawn, path: '<script>' }, consent: true });
  assert.equal(r.status, 400);
  r = await signAs(OTHER, { docId: d.id, version: 1, mark: drawn, consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.how, r.body.mark.path], ['drawn', drawn.path]);
  // Kim's page from before marks (her name only): it reloads, and nothing is signed
  r = await call('kim.board@example.com', '/api/board-portal', { method: 'POST', body: { action: 'sign', docId: d.id, name: 'Kim Park', version: 1 }, handler: portal.onRequestPost });
  assert.deepEqual([r.status, r.body.reload], [409, true]);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM board_signatures WHERE slug = 'kim-park'").first().then((x) => x.n), 0);
});

test('marking a point for initials makes a page from before read it again, and the sign-again question says what keeping means', async () => {
  let d = await written();
  await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera', { version: 1 });
  await assert.rejects(saveDoc(env.DB, { ...d, body: `${d.body} {initials}` }, { by: FOUNDER, base: 1 }), (err) => err.status === 409 && err.extra.ask.fields === true);
  // Kept (their signatures stay): still a page on wording 1 can't sign without the new initials
  d = await saveDoc(env.DB, { ...d, body: `${d.body} {initials}` }, { by: FOUNDER, base: 1, askAgain: false });
  assert.deepEqual([d.version, d.readFrom], [2, 2], 'a change to what they initial is read again, kept or not');
  await assert.rejects(signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz', { version: 1 }), (err) => err.status === 409 && err.extra.changed);
});

test('opening a paper or being asked isn’t signing it: a paper nobody signed can still be deleted', async () => {
  const d = await written('A draft policy');
  await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'opened', docId: d.id }, handler: portal.onRequestPost });
  assert.equal((await eventsAll()).filter((e) => e.kind === 'opened').length, 1);
  const del = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'delete-doc', id: d.id }, handler: admin.onRequestPost });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual(await checkChain(env.DB), { ok: true, count: 1, broken: null }, 'its opened event stays in the chain');
});

test('a signature’s SHA-256 is of the wording its page showed: one before a small change kept is that one’s', async () => {
  let d = await written('Board Member Expectations', '- Come in good faith');
  const v1 = await sha256Hex(d.body);
  d = await saveDoc(env.DB, { ...d, body: '- Come in good-faith' }, { by: FOUNDER, base: 1, askAgain: false });
  assert.deepEqual([d.version, d.readFrom], [2, 1]);
  const r = await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera', { version: 1 });
  assert.equal(r.version, 1);
  const row = await env.DB.prepare("SELECT hash FROM board_signatures WHERE slug = 'alex-rivera'").first();
  assert.equal(row.hash, v1, 'wording 1’s words, not wording 2’s');
  await signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz', { version: 2 });
  assert.equal((await env.DB.prepare("SELECT hash FROM board_signatures WHERE slug = 'sam-ortiz'").first()).hash, await sha256Hex('- Come in good-faith'));
});

test('a copy kept (replaced or taken off) and an iPhone photo’s original are linked for Board, never on the board page', async () => {
  const d = await expectations();
  const first = await signWithCopy(env, d.id, pdf('first.pdf'), { slug: 'kim-park', by: FOUNDER });
  const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])], 'IMG.HEIC', { type: 'image/heic' });
  await signWithCopy(env, d.id, jpeg('IMG.jpg'), { slug: 'kim-park', by: FOUNDER, replace: true, original: heic });
  const kept = (await listDocs(env.DB)).find((x) => x.id === d.id).kept['kim-park'];
  assert.deepEqual(kept.map((f) => [f.id === first.copy.id, !!f.supersededAt, !!f.originalOf]).sort(), [[false, false, true], [true, true, false]].sort());
  const page = await call('kim.board@example.com', '/api/board-portal', { handler: portal.onRequestGet });
  assert.equal(page.body.docs.find((x) => x.id === d.id).kept, undefined, 'the board page never lists anyone’s kept copies');
});

// A stand-in for Cloudflare's browser: a real PDF (pdf-lib) holding the page's words, so what's printed can be read back
const { PDFDocument, StandardFonts } = await import('pdf-lib');
let printedHtml = [];
const fakeRender = async (html) => {
  printedHtml.push(html);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('printed', { x: 72, y: 700, size: 12, font });
  return doc.save();
};
const sb = await import('../functions/api/_board-sign.js');
const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = await import('pdf-lib');
/** A PDF's attached files → { name: text } */
function attachmentsOf(pdfDoc) {
  const out = {};
  const names = pdfDoc.catalog.lookup(PDFName.of('Names'), PDFDict)?.lookup(PDFName.of('EmbeddedFiles'), PDFDict)?.lookup(PDFName.of('Names'), PDFArray);
  for (let i = 0; names && i < names.size(); i += 2) {
    const spec = names.lookup(i + 1, PDFDict);
    const stream = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'));
    const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
    out[names.lookup(i).decodeText()] = new TextDecoder().decode(bytes);
  }
  return out;
}

test('the signed copy: made once, the words as signed with each initial and answer, the record, the words and evidence attached inside; the receipt once, with it attached', async () => {
  printedHtml = [];
  const d = await written('Board Member Expectations', MARKED);
  const r = await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: { 1: 'AR', 2: '<img src=http://x.example/a.png><style>p{display:none}</style>$1,500', 3: 'AR' }, consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const key = { docId: d.id, slug: 'alex-rivera', year: YEAR };
  // Two makers at once: one copy
  const [a, b] = await Promise.all([sb.buildRecord(env, key, { render: fakeRender }), sb.buildRecord(env, key, { render: fakeRender })]);
  assert.deepEqual([a.built || b.built, a.built && b.built], [true, false]);
  assert.equal(printedHtml.length, 1);
  const html = printedHtml[0];
  assert.ok(/Annual minimum \$6,000\.00 Donation\/Sponsorship<\/p><p class="fld"><span class="ini"[^>]*>AR<\/span>/.test(html), 'each initial beside its point');
  assert.ok(html.includes('&lt;img src=http://x.example/a.png&gt;&lt;style&gt;') && !/<img|<style>p\{display/.test(html.replace(/<style>\n/, '')), 'an answer is words, never markup');
  assert.ok(/Signing record/.test(html) && html.includes(await sha256Hex(d.body)) && html.includes('203.0.113.7') && /Agreed to sign electronically/.test(html), 'the record: the words’ SHA-256, where from, consent');
  const row = await env.DB.prepare("SELECT record_id, record_hash FROM board_signatures WHERE slug = 'alex-rivera'").first();
  const file = await env.DB.prepare('SELECT * FROM board_files WHERE id = ?').bind(row.record_id).first();
  assert.deepEqual([file.owner_type, file.slug, file.staff_only, file.sha256 === row.record_hash], ['record', 'alex-rivera', 1, true]);
  // The PDF itself: the exact words and the evidence inside, its fingerprint in its properties
  const bytes = env.FILES.map.get(file.r2_key).bytes;
  const pdfDoc = await PDFDocument.load(bytes);
  assert.match(pdfDoc.getSubject(), new RegExp(await sha256Hex(d.body)));
  const attached = attachmentsOf(pdfDoc);
  assert.deepEqual(Object.keys(attached).sort(), ['evidence.json', 'words.md'], 'the words and the evidence attached');
  assert.equal(attached['words.md'], d.body, 'the exact words');
  assert.equal(JSON.parse(attached['evidence.json']).signature.fields.find((f) => f.n === 2).value, '<img src=http://x.example/a.png><style>p{display:none}</style>$1,500');
  // Theirs to open; another member's never
  assert.equal((await call(MEMBER, `/api/board-file?id=${row.record_id}`, { handler: fileRoute.onRequestGet })).status, 200);
  assert.equal((await call(OTHER, `/api/board-file?id=${row.record_id}`, { handler: fileRoute.onRequestGet })).status, 404);
  // The receipt: once, to the address Access checked, the copy attached, its key so Resend sends it once
  sent = [];
  await sb.sendReceipt(env, key);
  await sb.sendReceipt(env, key);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].to[0], /^You signed the Board Member Expectations for \d{4}$/.test(sent[0].subject), sent[0].attachments?.length, /If you didn’t sign this, reply/.test(sent[0].text)], [MEMBER, true, 1, true]);
  assert.ok(sent[0].text.includes(row.record_hash) && sent[0].text.includes(await sha256Hex(d.body)), 'both fingerprints in it');
  assert.equal((await eventsAll()).filter((e) => e.kind === 'receipt-sent').length, 1);
  // The board page offers it
  const page = await call(MEMBER, '/api/board-portal', { handler: portal.onRequestGet });
  const mine = page.body.docs.find((x) => x.id === d.id);
  assert.deepEqual([mine.signedByMe.record.id, mine.myCopies.map((c) => c.year)], [row.record_id, [YEAR]]);
});

test('a copy signed on paper, or one SOARD added, gets its record quietly: never a receipt', async () => {
  const d = await expectations();
  await signWithCopy(env, d.id, pdf('Kim.pdf'), { slug: 'kim-park', by: FOUNDER });
  sent = [];
  await sb.maybeRunSigning(env, { render: fakeRender });
  const row = await env.DB.prepare("SELECT record_id, process_v FROM board_signatures WHERE slug = 'kim-park'").first();
  assert.ok(row.record_id, 'its record made by the heartbeat');
  await sb.maybeRunSigning(env, { render: fakeRender });
  assert.equal(sent.length, 0, 'nobody emailed');
});

test('a copy that won’t make: tried 3 times, the admins told once, and the receipt goes without it', async () => {
  const d = await written();
  await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), consent: true });
  const broken = async () => { throw new Error('the browser is busy'); };
  sent = [];
  for (let i = 0; i < 3; i++) {
    await env.DB.prepare('UPDATE board_signatures SET record_claim_at = NULL').run();
    await sb.maybeRunSigning(env, { render: broken });
  }
  const row = await env.DB.prepare("SELECT record_id, record_tries FROM board_signatures WHERE slug = 'alex-rivera'").first();
  assert.deepEqual([row.record_id, row.record_tries], [null, 3]);
  assert.ok(sent.some((m) => /couldn’t be made/.test(m.subject)), 'the admins are told');
  assert.equal((await eventsAll()).filter((e) => e.kind === 'record-failed').length, 3);
  await sb.maybeRunSigning(env, { render: broken });
  const receipt = sent.find((m) => /^You signed/.test(m.subject));
  assert.ok(receipt && !receipt.attachments, 'the receipt, with no PDF');
});

test('taking off a member’s own signature tells them; a changed email tells the old address, once', async () => {
  const d = await written();
  await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), consent: true });
  sent = [];
  const off = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'unsign', docId: d.id, slug: 'alex-rivera', reason: 'Signed the wrong paper' }, handler: admin.onRequestPost });
  assert.equal(off.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sent.some((m) => m.to[0] === MEMBER && /was taken off/.test(m.subject) && /Signed the wrong paper/.test(m.text)), `told (${sent.map((m) => m.subject)})`);
  // An address changed on People
  const { setBoardEmail } = await import('../functions/api/_reveal-invites.js');
  await setBoardEmail(env.DB, 'sam-ortiz', 'sam.new@example.org');
  sent = [];
  await sb.maybeRunSigning(env, { render: fakeRender });
  await sb.maybeRunSigning(env, { render: fakeRender });
  const told = sent.filter((m) => /Your board page no longer signs in with this email/.test(m.subject));
  assert.deepEqual([told.length, told[0]?.to[0], /sam\.new@example\.org|Sam/.test(`${told[0]?.text}${told[0]?.html}`)], [1, OTHER, false], 'the old address told, never the new one or whose');
  // Cleared, then set again: the address it had is told too
  await setBoardEmail(env.DB, 'kim-park', '');
  await setBoardEmail(env.DB, 'kim-park', 'kim.later@example.com');
  sent = [];
  await sb.maybeRunSigning(env, { render: fakeRender });
  assert.deepEqual(sent.filter((m) => /no longer signs in with this email/.test(m.subject)).map((m) => m.to[0]), ['kim.board@example.com']);
});

// ── Step 4: due dates, declining, reminders, the whole board signed, the year's record
const settle = () => new Promise((r) => setTimeout(r, 60));
/** A weekday this year, 10 AM Eastern, that isn't a holiday (the first in January after the 5th, then on) */
function workday(after = 0) {
  let t = Date.parse(`${YEAR}-01-06T15:00:00Z`) + after;
  while (!sb.businessHours(t)) t += 24 * 60 * 60 * 1000;
  return t;
}
const DAYMS = 24 * 60 * 60 * 1000;

test('holidays and hours: reminders wait for a weekday, 8 AM to 7 PM Eastern, that isn’t a holiday', () => {
  const h = sb.usHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-19', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25', '2026-12-31']) assert.ok(h.has(d), d);
  assert.ok(sb.usHolidays(2027).has('2027-07-05') && sb.usHolidays(2027).has('2027-12-24'), 'a Sunday holiday is kept on the Monday; Christmas Eve 2027 is its Friday');
  assert.equal(sb.businessHours(Date.parse('2026-11-10T15:00:00Z')), true, 'Tuesday 10 AM');
  assert.equal(sb.businessHours(Date.parse('2026-11-10T12:30:00Z')), false, '7:30 AM');
  assert.equal(sb.businessHours(Date.parse('2026-11-11T00:30:00Z')), false, '7:30 PM');
  assert.equal(sb.businessHours(Date.parse('2026-11-14T15:00:00Z')), false, 'Saturday');
  assert.equal(sb.businessHours(Date.parse('2026-11-26T15:00:00Z')), false, 'Thanksgiving');
  assert.equal(sb.businessHours(Date.parse('2026-07-01T14:00:00Z')), true, 'summer time: 10 AM Eastern is 14:00 UTC');
});

test('a due date: a real day, kept as month and day so it rolls forward; on the board page and in the ask', async () => {
  const { cleanDoc } = await import('../functions/api/_board.js');
  assert.deepEqual(['01-31', '02-29', '02-30', '13-01', 'Jan 31', ''].map((due) => cleanDoc({ title: 'x', due }).due), ['01-31', '02-29', '', '', '', '']);
  assert.equal(sb.dueOn({ due: '02-29' }, 2027), '2027-02-28');
  // (a due date still ahead this year, and one gone by: Jan 1 is never ahead, Dec 31 always is but on Dec 31)
  const ahead = todayEastern() < `${YEAR}-12-31` ? '12-31' : null;
  const d = await saveDoc(env.DB, { title: 'Board Member Expectations', kind: 'policy', sign: true, due: ahead || '01-01', body: '### Attendance\n\n- Come to three of four meetings' }, { by: FOUNDER });
  const page = await call(MEMBER, '/api/board-portal', { handler: portal.onRequestGet });
  assert.equal(page.body.docs.find((x) => x.id === d.id).due, ahead || '01-01');
  sent = [];
  await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'ask-to-sign', slugs: ['alex-rivera'] }, handler: admin.onRequestPost });
  if (ahead) {
    assert.match(sent[0]?.subject || '', /^Please sign the Board Member Expectations for \d{4} by December 31$/);
    assert.match(sent[0].text, /once a year by December 31\. On the board page it takes a few minutes: read it, then sign at the end\./);
  }
  // Gone by: said as a date gone by, never "by January 1" as though it were ahead
  await saveDoc(env.DB, { ...(await listDocs(env.DB)).find((x) => x.id === d.id), due: '01-01' }, { by: FOUNDER });
  sent = [];
  await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'ask-to-sign', slugs: ['sam-ortiz'] }, handler: admin.onRequestPost });
  assert.match(sent[0]?.subject || '', /^Please sign the Board Member Expectations for \d{4}$/);
  assert.match(sent[0].text, /once a year\. It was due January 1\. On the board page/);
});

test('can’t sign it as written: why is kept and the admins told once; Declined until they sign, which they still can', async () => {
  const d = await written();
  const none = await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'decline', docId: d.id, reason: ' ', as: 'alex-rivera', year: YEAR }, handler: portal.onRequestPost });
  assert.deepEqual([none.status, /Say what you can’t agree to/.test(none.body.error)], [400, true]);
  sent = [];
  const why = 'I can’t commit to $6,000 this year <b>at all</b>';
  const r = await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'decline', docId: d.id, reason: why, as: 'alex-rivera', year: YEAR }, handler: portal.onRequestPost });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await settle();
  const told = sent.filter((m) => /Alex Rivera can’t sign the Board Member Expectations as written/.test(m.subject));
  assert.ok(told.length >= 1 && told.every((m) => m.to[0].endsWith('@soardcharity.com')) && told[0].reply_to?.includes?.(MEMBER) !== false, `the admins (${sent.map((m) => m.subject)})`);
  assert.ok(told[0].html.includes('&lt;b&gt;at all&lt;/b&gt;') && !told[0].html.includes('<b>at all'), 'their words, never markup');
  // What they said, changed: the admins hear the new words; Send pressed again with the same words: nobody emailed
  sent = [];
  await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'decline', docId: d.id, reason: 'The giving minimum, this year', as: 'alex-rivera', year: YEAR }, handler: portal.onRequestPost });
  await settle();
  assert.ok(sent.length >= 1 && sent.every((m) => /The giving minimum, this year/.test(m.text)), 'the new words go to the admins');
  assert.ok(sent.every((m) => m.html.includes('/admin/#board/documents')), 'their button opens Board → Documents');
  sent = [];
  await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'decline', docId: d.id, reason: 'The giving minimum, this year', as: 'alex-rivera', year: YEAR }, handler: portal.onRequestPost });
  await settle();
  assert.equal(sent.length, 0);
  // Their page says so; the admin's lists say Declined, with why
  const page = await call(MEMBER, '/api/board-portal', { handler: portal.onRequestGet });
  const mine = page.body.docs.find((x) => x.id === d.id);
  assert.deepEqual([mine.declinedByMe?.reason, mine.declined], ['The giving minimum, this year', undefined]);
  const other = await call(OTHER, '/api/board-portal', { handler: portal.onRequestGet });
  assert.equal(other.body.docs.find((x) => x.id === d.id).declinedByMe, null, 'nobody else sees it');
  assert.equal((await listDocs(env.DB)).find((x) => x.id === d.id).declined['alex-rivera'].reason, 'The giving minimum, this year');
  // Signed after all: Declined ends
  assert.equal((await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), consent: true })).status, 200);
  assert.deepEqual((await listDocs(env.DB)).find((x) => x.id === d.id).declined, {});
  const again = await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'decline', docId: d.id, reason: 'Changed my mind', as: 'alex-rivera', year: YEAR }, handler: portal.onRequestPost });
  assert.equal(again.status, 409, 'signed: nothing to decline');
});

test('Remind by email: off until turned on; then each unsigned member once a claim, every 3 days, weekdays, at most 4, not a decliner or a week past due', async () => {
  const d = await written();
  const t0 = workday();
  sent = [];
  assert.deepEqual(await sb.maybeRemindSigners(env, { now: t0 }), { off: true });
  assert.equal(sent.length, 0, 'off by default');
  const on = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'save-settings', settings: { remind: '3' } }, handler: admin.onRequestPost });
  assert.equal(on.body.settings.remind, '3');
  // Sam declined; Kim signed: Alex alone is reminded. Two heartbeats at once: one email
  await call(OTHER, '/api/board-portal', { method: 'POST', body: { action: 'decline', docId: d.id, reason: 'Not this year', as: 'sam-ortiz', year: YEAR }, handler: portal.onRequestPost });
  await signDoc(env.DB, d.id, { slug: 'kim-park', name: 'Kim Park', email: 'kim.board@example.com' }, '', { version: 1, mark: typedMark('Kim Park', 'KP'), consent: true });
  await settle();
  sent = [];
  const [a, b] = await Promise.all([sb.maybeRemindSigners(env, { now: t0 }), sb.maybeRemindSigners(env, { now: t0 })]);
  assert.equal(a.sent + b.sent, 1);
  assert.deepEqual([sent.length, sent[0].to[0], /Please sign the Board Member Expectations/.test(sent[0].subject)], [1, MEMBER, true]);
  // A Saturday, or the next day: nothing
  sent = [];
  await sb.maybeRemindSigners(env, { now: t0 + 1 * DAYMS });
  assert.equal(sent.length, 0, 'within 3 days');
  let t = t0;
  const subjects = [];
  for (let i = 0; i < 6; i++) {
    t = workday(t - Date.parse(`${YEAR}-01-06T15:00:00Z`) + 3 * DAYMS);
    sent = [];
    await sb.maybeRemindSigners(env, { now: t });
    subjects.push(...sent.map((m) => m.subject));
  }
  assert.equal(subjects.length, 3, `4 in all (${subjects})`);
  assert.ok(subjects.every((x) => /^Reminder: please sign/.test(x)));
  const row = await env.DB.prepare("SELECT n, reminders FROM board_sign_asks WHERE slug = 'alex-rivera'").first();
  assert.deepEqual([row.n, row.reminders], [4, 4]);
  assert.equal((await eventsAll()).filter((e) => e.kind === 'reminded').length, 4);
});

test('reminders: a paper past its due date is still asked for, as overdue; a sign-in email counts as the ask; a failed send is tried again', async () => {
  const d = await saveDoc(env.DB, { title: 'Conflict of Interest Policy', kind: 'policy', sign: true, due: '01-01', body: '### Interests\n\n- I disclose them' }, { by: FOUNDER });
  await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'save-settings', settings: { remind: '7' } }, handler: admin.onRequestPost });
  sent = [];
  await sb.maybeRemindSigners(env, { now: workday(10 * DAYMS) });
  assert.equal(sent.length, 3, 'two weeks past it, all three are asked');
  assert.ok(sent.every((m) => /It was due January 1\./.test(m.text) && !/by January 1/.test(m.subject)), 'as a date gone by');
  await env.DB.prepare('DELETE FROM board_sign_asks').run();
  await saveDoc(env.DB, { ...(await listDocs(env.DB)).find((x) => x.id === d.id), due: '' }, { by: FOUNDER });
  // Alex had the sign-in email two days ago: it was the ask
  const t = workday();
  await env.DB.prepare("INSERT OR REPLACE INTO board_state (key, data, updated_at) VALUES ('welcome', ?, ?)").bind(JSON.stringify({ sentAt: new Date(t - 2 * DAYMS).toISOString(), members: { 'alex-rivera': new Date(t - 2 * DAYMS).toISOString() }, addresses: { 'alex-rivera': MEMBER } }), new Date().toISOString()).run();
  // Resend down for the first try
  const real = globalThis.fetch;
  let down = true;
  globalThis.fetch = async (input, init) => (down && String(input).startsWith('https://api.resend.com/') ? new Response('{"message":"down"}', { status: 500 }) : real(input, init));
  sent = [];
  await sb.maybeRemindSigners(env, { now: t });
  assert.deepEqual(sent.map((m) => m.to[0]).sort(), [], 'nothing went');
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM board_sign_asks").first().then((r) => r.n), 0, 'and nobody counts as asked');
  down = false;
  await sb.maybeRemindSigners(env, { now: t });
  globalThis.fetch = real;
  assert.deepEqual(sent.map((m) => m.to[0]).sort(), ['kim.board@example.com', OTHER], 'Alex waits a week from the sign-in email');
});

test('every board member signed a paper: the admins told once', async () => {
  const d = await written();
  for (const [slug, name] of [['alex-rivera', 'Alex Rivera'], ['sam-ortiz', 'Sam Ortiz'], ['kim-park', 'Kim Park']]) {
    await signDoc(env.DB, d.id, { slug, name, email: `${slug}@example.com` }, '', { version: 1, mark: typedMark(name, name.split(' ').map((x) => x[0]).join('')), consent: true });
  }
  sent = [];
  await sb.maybeTellAllSigned(env);
  await sb.maybeTellAllSigned(env);
  const told = sent.filter((m) => /^Every board member has signed the Board Member Expectations for \d{4}$/.test(m.subject));
  assert.ok(told.length >= 1 && new Set(told.map((m) => m.to[0])).size === told.length, 'each admin once');
});

test('the year’s record: one ZIP with the copies, the words, a spreadsheet that can’t hold formulas, the chain; members who left too', async () => {
  const d = await written();
  await signAs(MEMBER, { docId: d.id, version: 1, mark: typedMark(), fields: {}, consent: true });
  await sb.buildRecord(env, { docId: d.id, slug: 'alex-rivera', year: YEAR }, { render: fakeRender });
  // Someone who has since left the board (alumni on People), with a formula for a name
  await env.DB.prepare('INSERT INTO board_signatures (doc_id, slug, year, version, name, at, how) VALUES (?, ?, ?, 1, ?, ?, ?)').bind(d.id, 'old-timer', YEAR, '=HYPERLINK("http://x.example","Old Timer")', new Date().toISOString(), 'typed').run();
  await call(OTHER, '/api/board-portal', { method: 'POST', body: { action: 'decline', docId: d.id, reason: '+1 for later', as: 'sam-ortiz', year: YEAR }, handler: portal.onRequestPost });
  const got = await call(FOUNDER, `/api/board-admin?record=${d.id}&year=${YEAR}`, { handler: admin.onRequestGet });
  assert.equal(got.status, 200);
  // (read the ZIP by hand, from its central directory: name, size, where each file starts)
  const buf = Buffer.from(got.body);
  const entries = {};
  for (let i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), n = buf.readUInt16LE(i + 10), k = 0, p = buf.readUInt32LE(i + 16); k < n; k++) {
    const len = buf.readUInt16LE(p + 28);
    entries[buf.subarray(p + 46, p + 46 + len).toString('utf8')] = { size: buf.readUInt32LE(p + 20), offset: buf.readUInt32LE(p + 42), crc: buf.readUInt32LE(p + 16) };
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  const names = Object.keys(entries);
  assert.ok(['README.txt', 'signatures.csv', 'summary.html', 'wordings/wording 1.md', 'events.json'].every((x) => names.includes(x)), names.join(' | '));
  assert.ok(names.some((x) => /^signed-copies\/Alex Rivera - .*\.pdf$/.test(x)), `Alex’s signed copy (${names.join(' | ')})`);
  const at = (name) => { const e = entries[name]; const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28); return buf.subarray(start, start + e.size).toString('utf8'); };
  assert.equal(at('wordings/wording 1.md'), d.body, 'the exact words');
  const csv = at('signatures.csv');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x.example"",""Old Timer"")"`), `a formula is only words (${csv})`);
  assert.ok(/Sam Ortiz,Declined,/.test(csv) && csv.includes("'+1 for later"), 'a decline, and its reason, read as words');
  assert.ok(/Kim Park,Not signed/.test(csv));
  assert.equal(JSON.parse(at('events.json')).chain.ok, true);
});

test('a copy signed on paper: its signed copy is that copy as it came in, then the record; never the words with their name as though signed here', async () => {
  printedHtml = [];
  const d = await written();
  const packet = await PDFDocument.create();
  const font = await packet.embedFont(StandardFonts.Helvetica);
  for (const t of ['Commitment Form, page 1', 'page 2', 'Signature: Kim Park']) packet.addPage([612, 792]).drawText(t, { x: 72, y: 700, size: 12, font });
  await signWithCopy(env, d.id, new File([await packet.save()], 'Board Manual - Kim Park.pdf', { type: 'application/pdf' }), { slug: 'kim-park', by: FOUNDER });
  const made = await sb.buildRecord(env, { docId: d.id, slug: 'kim-park', year: YEAR }, { render: fakeRender });
  assert.ok(made.built, made.error);
  const html = printedHtml.at(-1);
  assert.ok(/Their signed copy/.test(html) && html.includes('Board Manual - Kim Park.pdf') && /the pages before this one, as it came in/.test(html));
  assert.ok(!/class="sign"/.test(html) && !html.includes('Come to three of four meetings'), 'no words signed in their name here');
  assert.ok(/<th>Added<\/th><td>[^<]+ by jane@soardcharity\.com/.test(html), 'when and by whom it was added');
  const file = await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(made.id).first();
  const pdfDoc = await PDFDocument.load(env.FILES.map.get(file.r2_key).bytes);
  assert.equal(pdfDoc.getPageCount(), 4, 'its 3 pages, then the record');
  assert.deepEqual(Object.keys(attachmentsOf(pdfDoc)).sort(), ['Board Manual - Kim Park.pdf', 'evidence.json', 'words.md'], 'the copy itself inside, untouched');
  sent = [];
  await sb.sendReceipt(env, { docId: d.id, slug: 'kim-park', year: YEAR });
  assert.equal(sent.length, 0, 'and nobody is emailed');
});
