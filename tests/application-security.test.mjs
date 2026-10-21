/**
 * The application's security fixes (Oct 2026 review): the HTML cleaner can't be
 * slipped an unclosed tag, the CSV can't carry a formula, the resume link can't
 * be aimed at strangers, photos are checked by their bytes, deleting a family's
 * data takes the site's notes about them too, IP hashes take a pepper, and the
 * admin serves only photos and PDFs inline.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld } from './lib/fake-applicant-world.mjs';
import { sanitizeHtml } from '../functions/api/_application-form.js';
import {
  createDraft, getDraft, saveDraft, submitDraft, setDraftFile, photoKey, TEST_JPEG, testAnswers, exportCsv,
  deleteApplicationData, getApplication, hashIp, areaCheck,
} from '../functions/api/_applications.js';
import { formFor, clearFormCache } from '../functions/api/_application-forms.js';
import * as applyApi from '../functions/api/apply.js';
import * as adminApi from '../functions/api/applications-admin.js';

const YEAR = '2027';
let w;
let env;
beforeEach(async () => {
  w = fakeApplicantWorld();
  w.world.census = { '205 lawrence': { lat: 33.95327, lng: -84.54682, county: 'Cobb', matched: '205 LAWRENCE ST NE, MARIETTA, GA, 30060' } };
  env = { ...w.env, DB: await createD1() };
  globalThis.fetch = w.fetchImpl;
  clearFormCache();
});
const ctx = (body, headers = {}) => ({
  env, waitUntil() {}, data: {},
  request: body instanceof FormData
    ? new Request('https://example.test/api/apply', { method: 'POST', body, headers: { 'CF-Connecting-IP': '5.6.7.8' } })
    : new Request('https://example.test/api/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '5.6.7.8', ...headers }, body: JSON.stringify(body) }),
});
const post = async (body) => { const res = await applyApi.onRequestPost(ctx(body)); return { status: res.status, body: await res.json() }; };
const HOME = { line1: '205 Lawrence St NE', line2: '', city: 'Marietta', state: 'GA', zip: '30060' };

test('the HTML cleaner shows a tag left unclosed as text, attributes and all', () => {
  assert.equal(sanitizeHtml('<p>ok</p><img src=x onerror=alert(1) '), '<p>ok</p>&lt;img src=x onerror=alert(1)');
  assert.equal(sanitizeHtml('<a href="https://x.org" onmouseover="steal()"'), '&lt;a href="https://x.org" onmouseover="steal()"');
  assert.equal(sanitizeHtml('<svg/onload=alert(1)>'), '&lt;svg/onload=alert(1)&gt;');
  assert.equal(sanitizeHtml('<scr<script>ipt>alert(1)</script>'), '&lt;scr');
  assert.equal(sanitizeHtml('<p>5 > 3</p><br/><BR>'), '<p>5 &gt; 3</p><br><br>');
  assert.equal(sanitizeHtml('<a href="https://a b">x</a><a href=\'/ok\'>y</a>'), '<a>x</a><a href="/ok">y</a>');
  const long = `<p>${'x'.repeat(19990)}</p><strong>bold</strong>`;
  assert.ok(!/<[^>]*$/.test(sanitizeHtml(long)), 'cut to size on a whole tag');
});

test('a CSV cell that would run as a formula is kept as text', async () => {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  await saveDraft(env.DB, await getDraft(env.DB, id), { answers: { ...testAnswers('mom@example.com', YEAR), childName: { first: 'Avery', last: 'Stone' }, referredBy: '=HYPERLINK("https://evil.example","Click")' }, page: 'finish' });
  for (const f of ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2']) await setDraftFile(env.DB, id, f, { key: photoKey(id, f), type: 'image/jpeg', size: 10, name: 'p.jpg' });
  await setDraftFile(env.DB, id, 'video', { uid: 'v', uploaded: true, size: 10, name: 'v.mov' });
  assert.equal((await submitDraft(env, await getDraft(env.DB, id))).ok, true);
  const csv = await exportCsv(env.DB, { year: YEAR });
  assert.ok(csv.includes(`"'=HYPERLINK(""https://evil.example"",""Click"")"`), 'starts with an apostrophe, quoted');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
});

test('the resume link only goes to the address it went to before (or the email they answered), greeting by a plain first name', async () => {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  await saveDraft(env.DB, await getDraft(env.DB, id), { answers: { parentName: { first: 'Visit http://evil.example now', last: 'X' } }, page: 'welcome' });
  const first = await post({ action: 'email-link', token: id, email: 'mom@example.com' });
  assert.equal(first.status, 200);
  const sent = w.world.emails.at(-1);
  assert.deepEqual(sent.to, ['mom@example.com']);
  assert.match(sent.html, /<p>Hi,<\/p>/, 'no free text in the greeting');
  assert.ok(!/evil\.example/.test(sent.html));
  const other = await post({ action: 'email-link', token: id, email: 'stranger@example.com' });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, 'email-locked');
  assert.match(other.body.error, /m•••@example\.com/);
  assert.equal(w.world.emails.length, 1, 'nothing went to the stranger');
  await saveDraft(env.DB, await getDraft(env.DB, id), { answers: { parentName: { first: 'María', last: 'X' }, parentEmail: 'maria@example.com' }, page: 'parents' });
  const answered = await post({ action: 'email-link', token: id, email: 'maria@example.com' });
  assert.equal(answered.status, 200, 'the email they gave in the form is fine');
  assert.match(w.world.emails.at(-1).html, /Hi María,/);
});

test('a photo is checked by its own bytes, and stored as what it really is', async () => {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  const upload = async (bytes, type, name) => {
    const fd = new FormData();
    fd.append('action', 'photo'); fd.append('token', id); fd.append('field', 'photoChild');
    fd.append('file', new File([bytes], name, { type }));
    const res = await applyApi.onRequestPost(ctx(fd));
    return { status: res.status, body: await res.json() };
  };
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  const fake = await upload(html, 'image/jpeg', 'kid.jpg');
  assert.equal(fake.status, 400);
  assert.match(fake.body.error, /Please choose a photo/);
  const png = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  assert.equal((await upload(png, 'image/jpeg', 'kid.jpg')).status, 400, 'a PNG labeled JPEG is turned away');
  const real = await upload(TEST_JPEG, 'image/jpeg', 'kid.jpg');
  assert.equal(real.status, 200);
  assert.equal((await getDraft(env.DB, id)).files.photoChild.type, 'image/jpeg');
});

test('deleting a family’s data takes where the check placed their home, the site’s timeline and the change log entries', async () => {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  const answers = { ...testAnswers('mom@example.com', YEAR), childName: { first: 'Avery', last: 'Stone' }, address: HOME };
  await saveDraft(env.DB, await getDraft(env.DB, id), { answers, page: 'finish' });
  await areaCheck(env, await formFor(env.DB, { year: YEAR }), HOME, { draft: await getDraft(env.DB, id) });
  for (const f of ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2']) await setDraftFile(env.DB, id, f, { key: photoKey(id, f), type: 'image/jpeg', size: 10, name: 'p.jpg' });
  await setDraftFile(env.DB, id, 'video', { uid: 'v', uploaded: true, size: 10, name: 'v.mov' });
  const sub = await submitDraft(env, await getDraft(env.DB, id));
  await env.DB.prepare("UPDATE applications SET jt_account_id = 'acct1' WHERE id = ?").bind(sub.id).run();
  await env.DB.exec('CREATE TABLE IF NOT EXISTS applicant_activity (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT)');
  await env.DB.prepare("INSERT INTO applicant_activity (id, account_id, at, kind, title) VALUES ('e1', 'acct1', '2026-10-01', 'field', 'Diagnosis: Autism')").run();
  await env.DB.exec('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)');
  await env.DB.prepare("INSERT INTO audit_log (user_email, action, entity_type, entity_slug, entity_name, changes) VALUES ('kim@x', 'updated', 'applicant', 'acct1', 'Avery Stone', '{\"diagnosis\":\"Autism\"}')").run();
  const out = await deleteApplicationData(env, sub.id, { user: 'peter@soardcharity.com', fetchImpl: w.fetchImpl });
  assert.equal(out.ok, true);
  const app = await getApplication(env.DB, sub.id);
  assert.deepEqual(app.jt_state.formArea, { band: 'inside', status: null }, 'only inside / close / far stays');
  assert.ok(!JSON.stringify(app.jt_state).includes('LAWRENCE'));
  const draft = await env.DB.prepare('SELECT area, email, ip_hash FROM application_drafts WHERE id = ?').bind(id).first();
  assert.deepEqual([draft.area, draft.email, draft.ip_hash], [null, null, null]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM applicant_activity WHERE account_id = 'acct1'").first()).n, 0);
  const log = await env.DB.prepare("SELECT entity_name, changes FROM audit_log WHERE entity_slug = 'acct1'").first();
  assert.equal(log.entity_name, 'Deleted family');
  assert.ok(!/Autism/.test(log.changes));
});

test('IP hashes take a pepper when one is set', async () => {
  const plain = await hashIp('203.0.113.9');
  const peppered = await hashIp('203.0.113.9', 'secret-pepper');
  assert.match(plain, /^[0-9a-f]{24}$/);
  assert.match(peppered, /^[0-9a-f]{24}$/);
  assert.notEqual(plain, peppered);
  assert.equal(peppered, await hashIp('203.0.113.9', 'secret-pepper'), 'the same address, the same hash');
});

test('the admin shows only photos and PDFs in the browser; anything else downloads', async () => {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  await env.DB.prepare("INSERT INTO applications (id, draft_id, year, child_name, answers, files, jt_state, status, submitted_at, updated_at) VALUES ('app-abc123-00ff00', ?, '2027', 'Avery', '{}', ?, '{}', 'done', '2026-10-01', '2026-10-01')")
    .bind(id, JSON.stringify({ photoChild: { key: 'applications/x/photoChild.jpg' }, odd: { key: 'applications/x/odd.html' } })).run();
  await env.FILES.put('applications/x/photoChild.jpg', TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.FILES.put('applications/x/odd.html', new TextEncoder().encode('<script>alert(1)</script>'), { httpMetadata: { contentType: 'text/html' } });
  const get = (field) => adminApi.onRequestGet({ env, request: new Request(`https://admin.test/api/applications-admin?file=app-abc123-00ff00&field=${field}`), data: {} });
  const photo = await get('photoChild');
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal(photo.headers.get('content-disposition'), 'inline');
  const odd = await get('odd');
  assert.equal(odd.headers.get('content-type'), 'application/octet-stream');
  assert.match(odd.headers.get('content-disposition'), /^attachment/);
  assert.equal(odd.headers.get('x-content-type-options'), 'nosniff');
});
