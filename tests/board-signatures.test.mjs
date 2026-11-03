/**
 * The papers every board member signs each year (the Board Member Expectations, a conflict of interest policy):
 * signed by typing their name, by adding the copy they signed on paper, by a Board admin adding a copy handed in,
 * or by their copy already in Drive. Who may open a copy, what the board page is told, a signature taken off, the
 * documents email naming what's left to sign, and the board page's and the admin's routes for each.
 * Made-up people only (the repo is public).
 * Run: node --test tests/board-signatures.test.mjs
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
async function call(email, path, { method = 'GET', body = null, handler, form = null } = {}) {
  const headers = { 'CF-Access-JWT-Assertion': await signIn(email), Origin: 'https://sunshineonaranneyday.com' };
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
async function expectations({ shared = true, title = 'Board Member Expectations' } = {}) {
  const d = await saveDoc(env.DB, { title, kind: 'policy', sign: true, shared });
  const { putFile } = await import('../functions/api/_board.js');
  await putFile(env, { ownerType: 'doc', ownerId: d.id, file: pdf('Board Expectations.pdf', 'the expectations') });
  return (await listDocs(env.DB)).find((x) => x.id === d.id);
}

test('typed, or the copy signed on paper: each is the year’s signature, a copy kept staff-only beside the paper (never as its file)', async () => {
  const d = await expectations();
  const alex = memberOf('alex-rivera');
  const typed = await signDoc(env.DB, d.id, alex, 'alex rivera');
  assert.deepEqual([typed.name, typed.how, typed.year], ['Alex Rivera', 'typed', YEAR]);
  // Sam's copy, signed on paper: the paper's own file stays the paper
  const sam = memberOf('sam-ortiz');
  const copy = await signWithCopy(env, d.id, pdf('Expectations signed.pdf'), { member: sam, by: sam.email });
  assert.deepEqual([copy.name, copy.how, copy.copy.name, copy.copy.staffOnly], ['Sam Ortiz', 'copy', 'Expectations signed.pdf', true]);
  let docs = await listDocs(env.DB);
  let x = docs.find((y) => y.id === d.id);
  assert.equal(x.file.name, 'Board Expectations.pdf', 'the paper is still the paper');
  assert.deepEqual(Object.keys(x.signed).sort(), ['alex-rivera', 'sam-ortiz']);
  assert.deepEqual([x.signed['sam-ortiz'].how, x.signed['sam-ortiz'].copy.name, x.signed['alex-rivera'].copy], ['copy', 'Expectations signed.pdf', null]);
  const row = await env.DB.prepare("SELECT * FROM board_files WHERE owner_type = 'signed'").first();
  assert.deepEqual([row.owner_id, row.staff_only, row.r2_key.startsWith(`board/signed/${d.id}/`)], [d.id, 1, true]);
  // Typing after a copy is in leaves the copy (the better record)
  const again = await signDoc(env.DB, d.id, sam, 'Sam Ortiz');
  assert.equal(again.how, 'copy');
  // A photo of the signed page replaces the copy added before, and the old one is gone
  const photo = await signWithCopy(env, d.id, jpeg('IMG_2041.jpg'), { member: sam, by: sam.email });
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM board_files WHERE owner_type = 'signed'").first()).n, 1);
  x = (await listDocs(env.DB)).find((y) => y.id === d.id);
  assert.deepEqual([x.signed['sam-ortiz'].copy.id, x.signed['sam-ortiz'].copy.type], [photo.copy.id, 'image/jpeg']);
  // Not a PDF or a picture (a Word file, or words named .pdf): refused, saying what a signed copy is, nothing kept
  await assert.rejects(signWithCopy(env, d.id, new File([new TextEncoder().encode('just words')], 'note.txt'), { member: memberOf('kim-park') }), /A signed copy is a PDF, or a photo of the signed page/);
  await assert.rejects(signWithCopy(env, d.id, new File([new TextEncoder().encode('just words')], 'fake.pdf'), { member: memberOf('kim-park') }), /fake\.pdf isn’t what its name says/);
  assert.equal((await listDocs(env.DB)).find((y) => y.id === d.id).signed['kim-park'], undefined);
  // A paper nobody signs, or one not on the board page: no signature from a member
  const bylaws = await saveDoc(env.DB, { title: 'Bylaws' });
  await assert.rejects(signWithCopy(env, bylaws.id, pdf('b.pdf'), { member: alex }), /doesn’t ask for a signature/);
  const hidden = await expectations({ shared: false });
  await assert.rejects(signWithCopy(env, hidden.id, pdf('b.pdf'), { member: alex }), /isn’t on the board page anymore/);
  assert.deepEqual(SIGNED_BY, ['typed', 'copy', 'staff', 'drive']);
});

test('a copy is opened by Board’s admins and the member it belongs to, nobody else; deleting the paper takes its copies', async () => {
  const d = await expectations();
  const sam = memberOf('sam-ortiz');
  const { copy } = await signWithCopy(env, d.id, pdf('Sam signed.pdf'), { member: sam });
  assert.ok(await fileFor(env.DB, copy.id, { admin: true }));
  assert.ok(await fileFor(env.DB, copy.id, { member: sam }), 'their own');
  assert.equal(await fileFor(env.DB, copy.id, { member: memberOf('alex-rivera') }), null, 'not another member’s');
  assert.equal(await fileFor(env.DB, copy.id, {}), null);
  // Through the route: Sam opens it, Alex gets the same 404 as for nothing at all
  const mine = await call(OTHER, `/api/board-file?id=${copy.id}`, { handler: fileRoute.onRequestGet });
  assert.equal(mine.status, 200);
  assert.match(new TextDecoder().decode(mine.body), /%PDF/);
  assert.equal((await call(MEMBER, `/api/board-file?id=${copy.id}`, { handler: fileRoute.onRequestGet })).status, 404);
  assert.equal((await call(FOUNDER, `/api/board-file?id=${copy.id}`, { handler: fileRoute.onRequestGet })).status, 200);
  await deleteDoc(env, d.id);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM board_files').first()).n, 0);
  assert.equal(env.FILES.map.size, 0, 'the copy is out of storage too');
});

test('a Board admin adds a copy someone handed in, and takes off one added by mistake; a copy in Drive never overrides one they gave', async () => {
  const d = await expectations();
  const kim = await signWithCopy(env, d.id, pdf('Kim.pdf'), { slug: 'kim-park', by: FOUNDER });
  assert.deepEqual([kim.name, kim.how], ['Kim Park', 'staff']);
  await assert.rejects(signWithCopy(env, d.id, pdf('x.pdf'), { slug: 'old-timer', by: FOUNDER }), /aren’t on People → Board/, 'only someone on the board now');
  // Taken off: the copy goes, and Kim is asked again
  assert.equal(await unsignDoc(env, d.id, 'kim-park'), true);
  assert.equal((await listDocs(env.DB)).find((y) => y.id === d.id).signed['kim-park'], undefined);
  assert.equal(env.FILES.map.size, 1, 'only the paper’s own file is left');
  assert.equal(await unsignDoc(env, d.id, 'kim-park'), false);
  // Drive: a copy for Alex counts; for Sam, who typed already, theirs stays
  await signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz');
  await signFromDrive(env.DB, { docId: d.id, slug: 'alex-rivera', year: YEAR, name: 'Alex Rivera', driveId: 'drive-1', driveName: 'Expectations - Alex Rivera.pdf' });
  await signFromDrive(env.DB, { docId: d.id, slug: 'sam-ortiz', year: YEAR, name: 'Sam Ortiz', driveId: 'drive-2', driveName: 'Expectations - Sam Ortiz.pdf' });
  const x = (await listDocs(env.DB)).find((y) => y.id === d.id);
  assert.deepEqual([x.signed['alex-rivera'].how, x.signed['alex-rivera'].drive], ['drive', { id: 'drive-1', name: 'Expectations - Alex Rivera.pdf' }]);
  assert.equal(x.signed['sam-ortiz'].how, 'typed');
  // Last year's signature isn't this year's
  await signFromDrive(env.DB, { docId: d.id, slug: 'kim-park', year: YEAR - 1, name: 'Kim Park', driveId: 'drive-3', driveName: 'old.pdf' });
  assert.equal((await listDocs(env.DB)).find((y) => y.id === d.id).signed['kim-park'], undefined);
  assert.equal((await listDocs(env.DB, YEAR - 1)).find((y) => y.id === d.id).signed['kim-park'].how, 'drive');
});

test('the board page: a member sees their own signature and how many of the board signed, never who else did or their copies', async () => {
  const d = await expectations();
  await signWithCopy(env, d.id, pdf('Sam.pdf'), { member: memberOf('sam-ortiz') });
  await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera');
  // Someone who has left the board signed before: not counted
  await env.DB.prepare("INSERT INTO board_signatures (doc_id, slug, year, name, at, how) VALUES (?, 'old-timer', ?, 'Old Timer', ?, 'typed')").bind(d.id, YEAR, new Date().toISOString()).run();
  const data = await portalData(env, { member: { ...memberOf('sam-ortiz'), title: '' } });
  const x = data.docs.find((y) => y.id === d.id);
  assert.equal(x.signed, undefined, 'no one else’s signatures');
  assert.deepEqual([x.signedCount, x.signedByMe.how, x.signedByMe.copy.name, x.signedByMe.drive], [2, 'copy', 'Sam.pdf', false]);
  const kim = (await portalData(env, { member: { ...memberOf('kim-park'), title: '' } })).docs.find((y) => y.id === d.id);
  assert.deepEqual([kim.signedByMe, kim.signedCount], [null, 2]);
});

test('the board page’s route: a member adds their signed copy; an admin looking can’t sign for anyone there', async () => {
  const d = await expectations();
  const r = await call(MEMBER, `/api/board-portal?signed=${d.id}`, { method: 'POST', form: formOf({ file: pdf('My signed expectations.pdf') }), handler: portal.onRequestPost });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.how, r.body.copy.name], ['Alex Rivera', 'copy', 'My signed expectations.pdf']);
  const page = await call(MEMBER, '/api/board-portal', { handler: portal.onRequestGet });
  assert.equal(page.body.docs.find((y) => y.id === d.id).signedByMe.how, 'copy');
  const looked = await call(FOUNDER, `/api/board-portal?signed=${d.id}`, { method: 'POST', form: formOf({ file: pdf('x.pdf') }), handler: portal.onRequestPost });
  assert.equal(looked.status, 403);
  assert.equal((await call(MEMBER, '/api/board-portal?signed=..%2Fx', { method: 'POST', form: formOf({ file: pdf('x.pdf') }), handler: portal.onRequestPost })).status, 400);
});

test('the admin’s routes: a copy handed in, a signature taken off, each saying the document as it is now', async () => {
  const d = await expectations();
  const added = await call(FOUNDER, '/api/board-admin', { method: 'POST', form: formOf({ signFor: d.id, slug: 'kim-park', file: pdf('Kim paper copy.pdf') }), handler: admin.onRequestPost });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual([added.body.signed.how, added.body.doc.signed['kim-park'].copy.name], ['staff', 'Kim paper copy.pdf']);
  const listed = await call(FOUNDER, '/api/board-admin', { handler: admin.onRequestGet });
  assert.equal(listed.body.docs.find((y) => y.id === d.id).signed['kim-park'].how, 'staff');
  const off = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'unsign', docId: d.id, slug: 'kim-park' }, handler: admin.onRequestPost });
  assert.equal(off.status, 200);
  assert.equal(off.body.doc.signed['kim-park'], undefined);
  assert.equal((await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'unsign', docId: d.id, slug: 'kim-park' }, handler: admin.onRequestPost })).status, 404);
  // A board member never reaches the admin's routes
  assert.equal((await call(MEMBER, '/api/board-admin', { method: 'POST', form: formOf({ signFor: d.id, slug: 'alex-rivera', file: pdf('x.pdf') }), handler: admin.onRequestPost })).status, 403);
});

test('the documents email tells each member what they have still to sign this year, after the invite’s question; a preview shows it all', async () => {
  const m = { ...newMeeting({ date: todayEastern(Date.now() + 14 * 86400000) }), id: 'm_test1', shared: true, files: [] };
  const one = packetEmail(m, { name: 'Kim Park', toSign: ['Board Member Expectations'] });
  assert.match(one.html, new RegExp(`Still to sign for ${YEAR}`));
  assert.match(one.html, /Board Member Expectations/);
  assert.match(one.html, /#\/documents/);
  assert.match(one.html, /add the copy you signed on paper/);
  assert.ok(one.html.indexOf('Will you be there?') < one.html.indexOf('Still to sign'), 'after the invite’s question');
  assert.match(one.text, new RegExp(`Still to sign for ${YEAR}: Board Member Expectations`));
  // One written in Board opens on its own page; a PDF, or more than one, on Documents
  const written = packetEmail(m, { name: 'Kim Park', toSign: [{ title: 'Board Member Expectations', id: 'd_words1', written: true }] });
  assert.match(written.html, /#\/documents\/d_words1"/);
  assert.match(written.text, /#\/documents\/d_words1$/m);
  assert.match(written.html, /Board Member Expectations/);
  const two = packetEmail(m, { name: 'Kim Park', toSign: [{ title: 'Board Member Expectations', id: 'd_words1', written: true }, { title: 'Conflict of Interest Policy', id: 'd_pdf1', written: false }] });
  assert.match(two.html, /#\/documents"/);
  assert.match(two.html, /Board Member Expectations<br>Conflict of Interest Policy/);
  assert.match(packetEmail(m, { name: 'Kim Park', toSign: [{ title: 'Conflict of Interest Policy', id: 'd_pdf1', written: false }] }).html, /#\/documents"/);
  const none = packetEmail(m, { name: 'Alex Rivera', toSign: [] });
  assert.doesNotMatch(none.html, /Still to sign/);
  assert.doesNotMatch(none.text, /Still to sign/);
  // Sent: Alex has signed, Sam and Kim haven't
  const d = await expectations();
  await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera');
  await saveMeeting(env.DB, m, { by: FOUNDER });
  const id = (await listMeetings(env.DB))[0].id;
  const r = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'send-packet', id }, handler: admin.onRequestPost });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const to = (who) => sent.find((e) => [].concat(e.to).includes(who));
  assert.doesNotMatch(to(MEMBER).html, /Still to sign/);
  assert.match(to(OTHER).html, /Still to sign/);
  assert.match(to('kim.board@example.com').html, /Still to sign/);
  sent = [];
  await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'send-packet', id, test: true }, handler: admin.onRequestPost });
  assert.match(sent[0].html, /Still to sign/, 'a preview shows the papers');
});

test('the words written in Board: each change the next wording, kept on record; asked to sign again, earlier signatures stop counting', async () => {
  // Written here, no file: the board can read it, so it can be signed
  let d = await saveDoc(env.DB, { title: 'Board Member Expectations', kind: 'policy', sign: true, body: '### Attendance\n\n- Come to three of four meetings' }, { by: FOUNDER });
  assert.deepEqual([d.version, d.signFrom, d.wordsBy, d.file], [1, 0, FOUNDER, null]);
  await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera');
  await signWithCopy(env, d.id, pdf('Sam.pdf'), { member: memberOf('sam-ortiz') });
  d = (await listDocs(env.DB)).find((x) => x.id === d.id);
  assert.deepEqual([d.signed['alex-rivera'].version, d.signed['sam-ortiz'].version], [1, 1]);
  // A save without words (the on/off switch) keeps them; the same words aren't a new wording
  d = await saveDoc(env.DB, { ...d, body: undefined, shared: true }, { by: FOUNDER });
  d = await saveDoc(env.DB, { ...d }, { by: FOUNDER });
  assert.deepEqual([d.version, d.body], [1, '### Attendance\n\n- Come to three of four meetings']);
  // New words over signatures: the server asks (naming who signed) before anything is saved
  await assert.rejects(saveDoc(env.DB, { ...d, body: '### Attendance\n\n- Come to three of the four meetings' }, { by: FOUNDER }),
    (err) => err.status === 409 && err.extra.ask.since === 'words' && err.extra.ask.names.join() === 'Alex Rivera,Sam Ortiz');
  assert.equal((await listDocs(env.DB)).find((x) => x.id === d.id).version, 1, 'nothing saved while it asks');
  // An editor opened on an older wording: someone else's newer words aren't overwritten without a word
  await assert.rejects(saveDoc(env.DB, { ...d, body: 'mine' }, { by: FOUNDER, base: 0, askAgain: false }),
    (err) => err.status === 409 && err.extra.conflict.version === 1 && err.extra.conflict.by === FOUNDER && /three of four/.test(err.extra.conflict.body));
  // A typo fixed: the next wording, signatures kept
  d = await saveDoc(env.DB, { ...d, body: '### Attendance\n\n- Come to three of the four meetings' }, { by: FOUNDER, base: 1, askAgain: false });
  assert.deepEqual([d.version, d.signFrom, Object.keys(d.signed).sort()], [2, 0, ['alex-rivera', 'sam-ortiz']]);
  // What they agree to changed: the board signs again; who signed before shows as having signed an earlier wording
  d = await saveDoc(env.DB, { ...d, body: `${d.body}\n- Give each year` }, { by: FOUNDER, askAgain: true });
  assert.deepEqual([d.version, d.signFrom, d.signed, d.earlier.sort()], [3, 3, {}, ['alex-rivera', 'sam-ortiz']]);
  const versions = (await env.DB.prepare('SELECT version, body, by FROM board_doc_versions WHERE doc_id = ? ORDER BY version').bind(d.id).all()).results;
  assert.deepEqual(versions.map((v) => [v.version, v.by]), [[1, FOUNDER], [2, FOUNDER], [3, FOUNDER]]);
  assert.match(versions[0].body, /three of four/, 'the first wording, as it was');
  const { docVersions } = await import('../functions/api/_board.js');
  assert.deepEqual((await docVersions(env.DB, d.id)).map((v) => v.version), [3, 2, 1], 'newest first');
  assert.deepEqual(Object.keys(d.before).sort(), ['alex-rivera', 'sam-ortiz'], 'their earlier signatures, for Who’s signed');
  // A member whose page still shows wording 2 can't sign wording 3 they never saw (typed, or with a copy)
  await assert.rejects(signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera', { version: 2 }), (err) => err.status === 409 && err.extra.changed);
  await assert.rejects(signWithCopy(env, d.id, pdf('Alex.pdf'), { member: memberOf('alex-rivera'), version: 2 }), (err) => err.status === 409 && err.extra.changed);
  // Alex signs the new words; the board page says who still has to and that Sam signed an earlier wording
  const signed = await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera', { version: 3 });
  assert.equal(signed.version, 3);
  const sam = (await portalData(env, { member: { ...memberOf('sam-ortiz'), title: '' } })).docs.find((x) => x.id === d.id);
  assert.deepEqual([sam.signedByMe, sam.signedEarlier, sam.signedCount, sam.body.includes('Give each year'), sam.wordsBy, sam.earlier, sam.before], [null, true, 1, true, undefined, undefined, undefined]);
  const alex = (await portalData(env, { member: { ...memberOf('alex-rivera'), title: '' } })).docs.find((x) => x.id === d.id);
  assert.deepEqual([alex.signedByMe.version, alex.signedEarlier], [3, false]);
  // The documents email asks who hasn't signed these words, and the sign-in email too
  const { sendWelcome } = await import('../functions/api/_board.js');
  sent = [];
  await sendWelcome(env, { to: [FOUNDER] });
  assert.match(sent[0].html, /Board Member Expectations/, 'a paper written here is one to sign');
  // Required, it keeps its words or a file: emptied with neither, it isn't saved
  await assert.rejects(saveDoc(env.DB, { ...d, body: '' }, { by: FOUNDER, base: 3, askAgain: false }), /needs its words or its file/);
  // Taken off the board page: signing says so (the page reloads), not "doesn't ask for a signature"
  await saveDoc(env.DB, { ...d, body: undefined, shared: false }, { by: FOUNDER });
  await assert.rejects(signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz'), (err) => /isn’t on the board page anymore/.test(err.message) && err.extra.gone);
  // Deleted, its wordings go with it
  await deleteDoc(env, d.id);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM board_doc_versions').first()).n, 0);
});

test('a paper that came as a PDF, written in Board from its own words: who signed the PDF keeps their signature, unless the words were changed', async () => {
  const d = await expectations();
  await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera');
  // The PDF's words as read: the same paper, nobody asked
  let x = await saveDoc(env.DB, { ...d, body: '- Attend three of four meetings' }, { by: FOUNDER, base: 0, fromFile: true });
  assert.deepEqual([x.version, x.signFrom, Object.keys(x.signed)], [1, 0, ['alex-rivera']]);
  // Changed from the PDF's: asked, since the PDF is what Alex signed
  const other = await expectations({ title: 'Conflict of Interest Policy' });
  await signDoc(env.DB, other.id, memberOf('sam-ortiz'), 'Sam Ortiz');
  await assert.rejects(saveDoc(env.DB, { ...other, body: '- Tell the board of any conflict, and more' }, { by: FOUNDER, base: 0 }),
    (err) => err.status === 409 && err.extra.ask.since === 'file' && err.extra.ask.names.join() === 'Sam Ortiz');
  x = await saveDoc(env.DB, { ...other, body: '- Tell the board of any conflict, and more' }, { by: FOUNDER, base: 0, askAgain: true });
  assert.deepEqual([x.version, x.signFrom, x.signed], [1, 1, {}]);
  // Over the API: the question and the conflict come back as data the page acts on
  const r = await call(FOUNDER, '/api/board-admin', { method: 'POST', body: { action: 'save-doc', doc: { ...x, body: 'newer' }, base: 0 }, handler: admin.onRequestPost });
  assert.deepEqual([r.status, r.body.conflict?.version], [409, 1]);
  const typed = await call(MEMBER, '/api/board-portal', { method: 'POST', body: { action: 'sign', docId: x.id, name: 'Alex Rivera', version: 0 }, handler: portal.onRequestPost });
  assert.deepEqual([typed.status, typed.body.changed], [409, true]);
});

test('a new file on a paper some signed: asked, and asked to sign again it’s a version of its own; the words keep where they came from; a long paper is kept whole', async () => {
  const { docVersions } = await import('../functions/api/_board.js');
  const d = await expectations({ title: 'Code of Conduct' });
  await signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz');
  // A new PDF (its name; it uploads right after): asked, naming Sam, nothing saved yet
  await assert.rejects(saveDoc(env.DB, { ...d }, { by: FOUNDER, base: 0, newFile: 'Code of Conduct 2027.pdf' }),
    (err) => err.status === 409 && err.extra.ask.names.join() === 'Sam Ortiz' && err.extra.ask.since === 'file' && err.extra.ask.newFile === 'Code of Conduct 2027.pdf');
  // Kept: a version of its own all the same (a page still showing the old file can't sign the new one), Sam's
  // signature still counting; asked again: the next version, Sam's signature on the old one stops counting
  let x = await saveDoc(env.DB, { ...d }, { by: FOUNDER, base: 0, newFile: 'Code of Conduct 2027.pdf', askAgain: false });
  assert.deepEqual([x.version, x.signFrom, Object.keys(x.signed)], [1, 0, ['sam-ortiz']]);
  // (kept: a page still on the version before may sign, the signature on what it read)
  const fresh = await expectations({ title: 'Gift Acceptance Policy' });
  await saveDoc(env.DB, { ...fresh }, { by: FOUNDER, base: 0, newFile: 'Gift Acceptance 2027.pdf' });
  // Nobody had signed, so nobody was asked: a page still showing the old file re-reads before signing
  await assert.rejects(signDoc(env.DB, fresh.id, memberOf('alex-rivera'), 'Alex Rivera', { version: 0 }), (err) => err.status === 409 && /It changed while you had it open/.test(err.message));
  x = await saveDoc(env.DB, { ...x }, { by: FOUNDER, base: 1, newFile: 'Code of Conduct 2027.pdf', askAgain: true });
  assert.deepEqual([x.version, x.signFrom, x.signed, x.earlier], [2, 2, {}, ['sam-ortiz']]);
  // Words read from that new file: asked too (they're not what Sam signed), and recorded as from it
  await signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz', { version: 2 });
  await assert.rejects(saveDoc(env.DB, { ...x, body: '- Be kind' }, { by: FOUNDER, base: 2, fromFile: true, wordsFrom: 'Code of Conduct 2027', newFile: 'Code of Conduct 2027.pdf' }), (err) => err.status === 409 && err.extra.ask.now === 'words');
  x = await saveDoc(env.DB, { ...x, body: '- Be kind', wordsFile: 'f_newone1' }, { by: FOUNDER, base: 2, wordsFrom: 'Code of Conduct 2027', askAgain: false });
  assert.equal(x.wordsFile, 'f_newone1');
  // Written here, a new file alone changes nothing the board reads: not asked, no new version
  const written = await saveDoc(env.DB, { ...x, body: undefined }, { by: FOUNDER, base: 3, newFile: 'Code of Conduct 2028.pdf' });
  assert.equal(written.version, 3);
  // Saved again without saying: where its words came from stays
  x = await saveDoc(env.DB, { ...x, note: 'Adopted 2027', body: undefined }, { by: FOUNDER });
  assert.equal(x.wordsFile, 'f_newone1');
  const versions = await docVersions(env.DB, d.id);
  assert.deepEqual(versions.map((v) => [v.version, v.note, v.signed]), [[3, 'From Code of Conduct 2027', 0], [2, 'A new file: Code of Conduct 2027.pdf · The board signs again from here', 1], [1, 'A new file: Code of Conduct 2027.pdf', 0]], 'Sam signed the new file, kept for the small change after it');
  // An editor open on a paper deleted meanwhile: refused, not made again
  await deleteDoc(env, d.id);
  await assert.rejects(saveDoc(env.DB, { ...x, body: '- Be kind, always' }, { by: FOUNDER, base: 3 }), (err) => err.status === 410 && err.extra.deleted);
  assert.equal((await listDocs(env.DB)).some((y) => y.id === d.id), false);
  // A long paper (long bylaws): all of it kept
  const long = `${'Every article of the bylaws, said in full. '.repeat(2500)}The last line.`;
  x = await saveDoc(env.DB, { title: 'Amended Bylaws', kind: 'bylaws', body: long }, { by: FOUNDER });
  assert.ok(x.body.length > 100000 && x.body.endsWith('The last line.'));
});

test('a paper saved with a new file goes in one: a file that can’t go up changes nothing, and nobody is asked to sign again for it', async () => {
  const d = await expectations({ title: 'Conflict of Interest Policy' });
  await signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz');
  const send = (req, file) => { const f = new FormData(); f.append('saveDoc', JSON.stringify(req)); f.append('file', file); return call(FOUNDER, '/api/board-admin', { method: 'POST', form: f, handler: admin.onRequestPost }); };
  // A Word file renamed .doc: refused before anything, said as what it is
  const bad = await send({ doc: d, base: 0, askAgain: true }, new File([new Uint8Array([0x50, 0x4B, 0x03, 0x04, 1, 2, 3, 4])], 'COI disclosure.doc'));
  assert.equal(bad.status, 415);
  assert.match(bad.body.error, /isn’t what its name says/);
  let x = (await listDocs(env.DB)).find((y) => y.id === d.id);
  assert.deepEqual([x.version, x.signFrom, Object.keys(x.signed), x.file.name], [0, 0, ['sam-ortiz'], 'Board Expectations.pdf']);
  // A good one over Sam's signature: asked first, nothing stored meanwhile
  const asked = await send({ doc: d, base: 0 }, pdf('COI 2027.pdf'));
  assert.deepEqual([asked.status, asked.body.ask?.names], [409, ['Sam Ortiz']]);
  assert.equal((await listDocs(env.DB)).find((y) => y.id === d.id).file.name, 'Board Expectations.pdf');
  // Answered: the file in, the next version, Sam to sign it
  const done = await send({ doc: d, base: 0, askAgain: true }, pdf('COI 2027.pdf'));
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.doc.file.name, done.body.doc.version, done.body.doc.signed], ['COI 2027.pdf', 1, {}]);
  // A photo of a signed page named .pdf is kept as the .jpg it is
  const photo = await signWithCopy(env, d.id, new File([jpeg('x.jpg').slice ? await jpeg('x.jpg').arrayBuffer() : new Uint8Array()], 'Signed copy.pdf'), { member: memberOf('kim-park') });
  assert.equal(photo.copy.name, 'Signed copy.jpg');
});

test('signing the new version keeps the signature on the earlier one, its copy too; Required unticked asks nobody to sign again', async () => {
  const { docVersions, fileFor } = await import('../functions/api/_board.js');
  let d = await saveDoc(env.DB, { title: 'Board Member Expectations', kind: 'policy', sign: true, body: '- Come to three of four meetings' }, { by: FOUNDER });
  const kimCopy = await signWithCopy(env, d.id, pdf('Kim signed.pdf'), { slug: 'kim-park', by: FOUNDER });
  d = await saveDoc(env.DB, { ...d, body: '- Come to every meeting' }, { by: FOUNDER, base: 1, askAgain: true });
  const again = await signWithCopy(env, d.id, pdf('Kim signed again.pdf'), { slug: 'kim-park', by: FOUNDER });
  assert.notEqual(again.copy.id, kimCopy.copy.id);
  assert.ok(await fileFor(env.DB, kimCopy.copy.id, { admin: true }), 'the copy on the earlier version is still there');
  assert.deepEqual((await docVersions(env.DB, d.id)).map((v) => [v.version, v.signed]), [[2, 1], [1, 1]], 'both wordings keep who signed them');
  // A copy replaced on the same version is the one before gone
  const third = await signWithCopy(env, d.id, pdf('Kim third.pdf'), { slug: 'kim-park', by: FOUNDER });
  assert.equal(await fileFor(env.DB, again.copy.id, { admin: true }), null);
  assert.ok(await fileFor(env.DB, third.copy.id, { admin: true }));
  // New words and Required unticked in the same save: nobody to ask
  d = await saveDoc(env.DB, { ...d, body: '- Come to every meeting, and the retreat', sign: false }, { by: FOUNDER, base: 2 });
  assert.deepEqual([d.version, d.sign], [3, false]);
});

test('a small change kept (no signing again): a page on the version before still signs, on what it read; taking a signature off gives back the one before it', async () => {
  let d = await saveDoc(env.DB, { title: 'Board Member Expectations', kind: 'policy', sign: true, body: '- Come to three of four meetings' }, { by: FOUNDER });
  await signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz', { version: 1 });
  d = await saveDoc(env.DB, { ...d, body: '- Come to three of the four meetings' }, { by: FOUNDER, base: 1, askAgain: false });
  assert.deepEqual([d.version, d.signFrom, d.readFrom], [2, 0, 1]);
  // Alex's page shows wording 1: his signature goes in, on wording 1 (it counts)
  const alex = await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera', { version: 1 });
  assert.equal(alex.version, 1);
  assert.ok((await listDocs(env.DB)).find((x) => x.id === d.id).signed['alex-rivera']);
  // Then the board is asked to sign again: Sam signs the new words; taking that off, his first signature is his again
  d = await saveDoc(env.DB, { ...d, body: '- Come to every meeting' }, { by: FOUNDER, base: 2, askAgain: true });
  await signDoc(env.DB, d.id, memberOf('sam-ortiz'), 'Sam Ortiz', { version: 3 });
  assert.ok(await unsignDoc(env, d.id, 'sam-ortiz'));
  const after = (await listDocs(env.DB)).find((x) => x.id === d.id);
  assert.deepEqual([after.signed['sam-ortiz'], after.earlier.includes('sam-ortiz'), after.before['sam-ortiz']?.version], [undefined, true, 1]);
});

test('a copy replaced across a kept small change replaces it (taking it off leaves them unsigned); a paper made required again after its words changed asks about who signed before', async () => {
  const { fileFor } = await import('../functions/api/_board.js');
  let d = await saveDoc(env.DB, { title: 'Board Member Expectations', kind: 'policy', sign: true, body: '- Come to three of four meetings' }, { by: FOUNDER });
  const wrong = await signWithCopy(env, d.id, pdf('wrong.pdf'), { member: memberOf('sam-ortiz'), version: 1 });
  d = await saveDoc(env.DB, { ...d, body: '- Come to three of the four meetings' }, { by: FOUNDER, base: 1, askAgain: false });
  const right = await signWithCopy(env, d.id, pdf('right.pdf'), { member: memberOf('sam-ortiz'), version: 2 });
  assert.equal(await fileFor(env.DB, wrong.copy.id, { admin: true }), null, 'the wrong copy is gone, replaced');
  assert.ok(await unsignDoc(env, d.id, 'sam-ortiz'));
  let x = (await listDocs(env.DB)).find((y) => y.id === d.id);
  assert.deepEqual([x.signed['sam-ortiz'], x.before['sam-ortiz']], [undefined, undefined], 'taken off: unsigned, nothing coming back');
  assert.equal(await fileFor(env.DB, right.copy.id, { admin: true }), null);
  // Paused (not required), its words changed, required again: Alex, who signed before, is asked about
  await signDoc(env.DB, d.id, memberOf('alex-rivera'), 'Alex Rivera', { version: 2 });
  d = await saveDoc(env.DB, { ...x, sign: false, body: '- Come to every meeting and give $1,000' }, { by: FOUNDER, base: 2 });
  await assert.rejects(saveDoc(env.DB, { ...d, sign: true, body: undefined }, { by: FOUNDER, base: 3 }), (err) => err.status === 409 && err.extra.ask.names.join() === 'Alex Rivera');
  d = await saveDoc(env.DB, { ...d, sign: true, body: undefined }, { by: FOUNDER, base: 3, askAgain: true });
  assert.deepEqual([d.version, d.signFrom, d.signed], [3, 3, {}]);
});
