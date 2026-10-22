/**
 * Jotform, copied home (functions/api/_jotform-backfill.js): every Jotform
 * application's answers, photos and PDF saved by the site, and what each
 * family's JobTread account is missing added to it, once
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import { runJotformBackfill, matchAccount, submissionFiles, submissionName, backfillFacts, sniffType } from '../functions/api/_jotform-backfill.js';
import { syncAllApplicants, listApplicants, FIELDS } from '../functions/api/_applicants.js';

const KEY = 'jf-secret-key';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(600).fill(7)]);
const PDF = new TextEncoder().encode(`%PDF-1.4\n${'x'.repeat(600)}`);
const F = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.id]));
const APP_URL = '22P4v2gNtdFR';

let w;
let env;
let jf;

/** A Jotform account: forms → submissions, and the files their answers point at */
function fakeJotform() {
  const state = { subs: {}, files: {}, calls: [], downloadsDown: false, leaks: [] };
  const widget = (path) => JSON.stringify({ widget_metadata: { type: 'imagelinks', value: [{ name: path.split('/').pop(), url: path }] } });
  function addSub(formId, sid, { child, photos = {}, createdAt = '2025-11-03 20:01:10', status = 'ACTIVE' }) {
    const answers = { 11: { name: 'childsName', text: "Child's Name", type: 'control_fullname', answer: { first: child.split(' ')[0], last: child.split(' ').slice(1).join(' ') } } };
    const q = { child: [53, 'Please upload a picture of the child'], family: [55, 'Please upload a picture of the child with their family'], space1: [70, 'Please upload a picture of the space'], space2: [71, 'Please upload a second picture of the space'] };
    for (const [kind, file] of Object.entries(photos)) {
      const path = `/widget-uploads/imagepreview/${formId}/${sid}${kind}${file}`;
      state.files[path] = JPEG;
      answers[q[kind][0]] = { name: `typeA${q[kind][0]}`, text: q[kind][1], type: 'control_widget', cfname: 'Image Upload Preview', answer: widget(path) };
    }
    state.subs[sid] = { id: sid, form_id: formId, created_at: createdAt, status, answers };
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const key = url.searchParams.get('apiKey') || init.headers?.APIKEY;
    if (!/(^|\.)jotform\.com$/.test(url.hostname) && (url.searchParams.get('apiKey') || init.headers?.APIKEY)) state.leaks.push(url.hostname);
    if (url.hostname === 'api.jotform.com') {
      state.calls.push(url.pathname);
      if (key !== KEY) return json({ responseCode: 401, message: 'You\'re not authorized to use (/user) ' }, 401);
      if (url.pathname === '/user') return json({ responseCode: 200, content: { username: 'soard' } });
      let m = url.pathname.match(/^\/form\/(\d+)\/submissions$/);
      if (m) return json({ responseCode: 200, content: Object.values(state.subs).filter(s => s.form_id === m[1]) });
      m = url.pathname.match(/^\/submission\/(\d+)$/);
      if (m) return state.subs[m[1]] ? json({ responseCode: 200, content: state.subs[m[1]] }) : json({ responseCode: 404, message: 'not found' }, 404);
      m = url.pathname.match(/^\/pdf-converter\/(\d+)\/fill-pdf$/);
      if (m) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
      return json({ responseCode: 404 }, 404);
    }
    if (url.hostname === 'www.jotform.com') {
      // Like Jotform (seen Oct 22 2026): a widget upload redirects to its file host, which needs the key
      // and sends the photo as application/octet-stream
      if (state.downloadsDown || !state.files[url.pathname]) return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
      return new Response(null, { status: 302, headers: { location: `https://files.jotform.com/jotformWidgets/${encodeURIComponent(url.pathname.replace(/^\/widget-uploads\//, ''))}` } });
    }
    if (url.hostname === 'files.jotform.com') {
      const bytes = state.files[`/widget-uploads/${decodeURIComponent(url.pathname.replace(/^\/jotformWidgets\//, ''))}`];
      if (!bytes || key !== KEY) return new Response('denied', { status: 403 });
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    }
    return w.fetchImpl(input, init);
  }
  return { state, addSub, fetchImpl };
}

function addAccount({ name, fields = {}, files = [], jobs = [], createdAt = '2025-10-15T12:00:00.000Z' }) {
  const id = `acct${String(Object.keys(w.world.accounts).length + 1).padStart(8, '0')}`;
  w.world.accounts[id] = { id, name, type: 'customer', org: ORG, createdAt, fields: { [F.status]: 'Denied', [F.year]: '2026', ...fields }, contacts: [], primaryContactId: null, locations: [], files: files.map((f, i) => ({ id: `${id}-f${i}`, type: 'image/jpeg', ...f })), comments: [], jobs };
  return w.world.accounts[id];
}

beforeEach(async () => {
  w = fakeApplicantWorld();
  jf = fakeJotform();
  env = { ...w.env, DB: await createD1(), JOTFORM_API_KEY: KEY };
});
const opts = (extra = {}) => ({ fetchImpl: jf.fetchImpl, ...extra });
const runUntilDone = async (max = 20) => {
  let r;
  for (let i = 0; i < max; i++) { r = await runJotformBackfill(env, opts()); if (r?.done || r?.blocked) break; }
  return r;
};

test('who each submission is, and which family: the JobTread link first, else exactly one name', () => {
  const applicants = [
    { account_id: 'a1', name: 'Milo Rivera Cruz', application_url: 'https://www.jotform.com/submission/111' },
    { account_id: 'a2', name: 'June & Wren Ellis', application_url: null },
    { account_id: 'a3', name: 'Sam Lee', application_url: null },
    { account_id: 'a4', name: 'Sam Lee', application_url: null },
  ];
  assert.deepEqual(matchAccount('111', 'Somebody Else', applicants), { accountId: 'a1', by: 'link' });
  assert.deepEqual(matchAccount('222', 'June Ellis', applicants), { accountId: 'a2', by: 'name' }, 'every word of the child\'s name is in the account\'s');
  assert.deepEqual(matchAccount('333', 'Sam Lee', applicants), { accountId: null, by: 'several' }, 'two families with the name: no guess');
  assert.deepEqual(matchAccount('444', 'Nobody Known', applicants), { accountId: null, by: 'none' });
  assert.deepEqual(matchAccount('555', '', applicants), { accountId: null, by: 'none' });
  assert.equal(submissionName({ 11: { type: 'control_fullname', text: "Child's Name", answer: { first: 'Ava', last: 'Lin' } }, 28: { type: 'control_fullname', text: 'Parent', answer: { first: 'Kim', last: 'Lin' } } }, 'makeover'), 'Ava Lin');
});

test('the files in a submission: upload widgets, native uploads and video links, each with what it is', () => {
  const files = submissionFiles({
    53: { type: 'control_widget', text: 'Please upload a picture of the child', answer: JSON.stringify({ widget_metadata: { value: [{ name: 'IMG_1.jpeg', url: '/widget-uploads/imagepreview/1/a.jpeg' }] } }) },
    55: { type: 'control_widget', text: 'Please upload a picture of the child with their family', answer: JSON.stringify({ widget_metadata: { value: [{ name: 'IMG_2.jpeg', url: '/widget-uploads/imagepreview/1/b.jpeg' }] } }) },
    71: { type: 'control_fileupload', text: 'Please upload a second picture of the space', answer: ['https://www.jotform.com/uploads/soard/1/2/room.jpg'] },
    80: { type: 'control_textarea', text: 'Interests', answer: 'Dinosaurs and trains' },
    90: { type: 'control_widget', text: 'Video', answer: 'https://videos.example/abc/video.mp4' },
  });
  assert.deepEqual(files.map(f => [f.kind, f.name]), [['child', 'IMG_1.jpeg'], ['family', 'IMG_2.jpeg'], ['space2', 'room.jpg'], ['video', 'video.mp4']]);
});

test('backfill: each family gets what JobTread is missing; the site keeps every answer, photo and PDF', async () => {
  // Linked from JobTread, with nothing there yet
  const milo = addAccount({ name: 'Milo Rivera', fields: { [APP_URL]: 'https://www.jotform.com/submission/6380000000000000001' } });
  jf.addSub('252326779451161', '6380000000000000001', { child: 'Milo Rivera', photos: { child: 'IMG_1.jpeg', family: 'IMG_2.jpeg', space1: 'image.jpg', space2: 'image.jpg' } });
  // Matched by name; staff already uploaded the child and family photos and the PDF
  const june = addAccount({ name: 'June & Wren Ellis', files: [{ name: 'June.jpeg' }, { name: 'June Family.jpeg' }, { name: 'June & Wren Ellis_Application.pdf', type: 'application/pdf' }] });
  jf.addSub('252326779451161', '6380000000000000002', { child: 'June Ellis', photos: { child: 'IMG_3.jpeg', family: 'IMG_4.jpeg', space1: 'image.jpg' } });
  // Two families with the name, and one with no family in JobTread: kept by the site only
  addAccount({ name: 'Sam Lee' });
  addAccount({ name: 'Sam Lee', createdAt: '2025-06-12T12:00:00.000Z' });
  jf.addSub('250455568355161', '6200000000000000003', { child: 'Sam Lee', photos: { child: 'IMG_5.jpeg' }, createdAt: '2025-04-09 10:00:00' });
  jf.addSub('250455568355161', '6200000000000000004', { child: 'Nobody Known', photos: { child: 'IMG_6.jpeg' }, createdAt: '2025-04-10 10:00:00' });
  // A deleted submission is left alone; an Advisory Board application is kept by the site
  jf.addSub('250455568355161', '6200000000000000005', { child: 'Gone Away', status: 'DELETED' });
  jf.state.subs['6261000000000000006'] = { id: '6261000000000000006', form_id: '261805783731058', created_at: '2026-09-01 09:00:00', status: 'ACTIVE', answers: { 3: { type: 'control_fullname', text: 'Name', answer: { first: 'Alex', last: 'Advisor' } } } };
  await syncAllApplicants(env, { fetchImpl: w.fetchImpl });
  const accountsBefore = Object.keys(w.world.accounts).length;

  const first = await runJotformBackfill(env, opts());
  assert.equal(first.listed, 5, 'the first run lists every submission (but the deleted one)');
  const r = await runUntilDone();
  assert.equal(r.done, true);

  // JobTread: the missing files, named like staff's and the form's
  const names = (a) => a.files.map(f => f.name).sort();
  assert.deepEqual(names(milo), ['Milo Rivera Family.jpg', 'Milo Rivera Space 1.jpg', 'Milo Rivera Space 2.jpg', 'Milo Rivera.jpg', 'Milo Rivera_Application.pdf']);
  assert.deepEqual(names(june), ['June & Wren Ellis Space 1.jpg', 'June & Wren Ellis_Application.pdf', 'June Family.jpeg', 'June.jpeg'], 'only what was missing: the space photo');
  assert.equal(Object.keys(w.world.accounts).length, accountsBefore, 'never makes a JobTread account');
  for (const a of Object.values(w.world.accounts).filter(x => x.name === 'Sam Lee')) assert.equal(a.files.length, 0, 'two families with the name: neither is touched');

  // The site: every submission, its answers in D1 and its files in a random folder
  const rows = (await env.DB.prepare('SELECT * FROM jotform_backfill ORDER BY submission_id').all()).results;
  assert.deepEqual(rows.map(x => [x.submission_id, x.matched_by, x.status]), [
    ['6200000000000000003', 'several', 'done'], ['6200000000000000004', 'none', 'done'], ['6261000000000000006', 'advisory', 'done'],
    ['6380000000000000001', 'link', 'done'], ['6380000000000000002', 'name', 'done'],
  ].sort());
  const keys = [...env.FILES.objects.keys()];
  for (const x of rows) {
    assert.match(x.folder, /^jotform-archive\/[0-9a-f-]{36}$/, 'a random folder, not the submission id');
    assert.equal(JSON.parse(x.answers).submissionId, x.submission_id, 'the answers are kept in D1');
    assert.ok(keys.includes(`${x.folder}/application.pdf`), 'and the PDF in the bucket');
  }
  assert.ok(keys.every(k => !/6380000000000000001|6200000000000000004/.test(k)), 'no bucket key names a submission');
  assert.equal(keys.filter(k => /-child\.jpg$/.test(k)).length, 4, 'every child photo is kept, matched or not');

  // The key: never stored, never sent anywhere but Jotform
  const everything = JSON.stringify(rows) + JSON.stringify((await env.DB.prepare('SELECT * FROM jotform_backfill_state').all()).results) + keys.join();
  assert.equal(everything.includes(KEY), false);
  assert.deepEqual(jf.state.leaks, []);

  // Milo's avatar is the photo from his application now
  const milo2 = (await listApplicants(env.DB)).find(a => a.id === milo.id);
  assert.equal(milo2.photoFrom, 'application');
  assert.match(milo2.photo, /^https:\/\/cdn\.fake\/file/);

  // Done is done: another run touches nothing
  const files = Object.values(w.world.accounts).reduce((n, a) => n + a.files.length, 0);
  const calls = jf.state.calls.length;
  assert.deepEqual(await runJotformBackfill(env, opts()), { done: true });
  assert.equal(Object.values(w.world.accounts).reduce((n, a) => n + a.files.length, 0), files);
  assert.equal(jf.state.calls.length, calls, 'Jotform isn\'t asked again');
  const facts = await backfillFacts(env.DB);
  assert.ok(facts.state.done);
});

test('when Jotform hands over no files, it stops after three tries and says what each way answered', async () => {
  for (let i = 1; i <= 4; i++) jf.addSub('252326779451161', `638000000000000001${i}`, { child: `Kid Number${i}`, photos: { child: 'IMG.jpeg' } });
  jf.state.downloadsDown = true;
  const pdfDown = jf.fetchImpl;
  const fetchImpl = (u, i) => (String(u).includes('/pdf-converter/') || String(u).includes('/generatePDF') ? new Response('nope', { status: 404 }) : pdfDown(u, i));
  let r;
  for (let n = 0; n < 6; n++) r = await runJotformBackfill(env, { fetchImpl });
  assert.equal(r.blocked, true);
  const blocked = (await env.DB.prepare("SELECT value FROM jotform_backfill_state WHERE key = 'blocked'").first()).value;
  assert.match(blocked, /www\.jotform\.com\/widget-uploads\/imagepreview 404/);
  assert.equal(blocked.includes(KEY), false);
  const calls = jf.state.calls.length;
  await runJotformBackfill(env, { fetchImpl });
  assert.equal(jf.state.calls.length, calls, 'blocked: Jotform isn\'t asked again until a fix');
});

test('a redirect to storage never carries the key, and the key only goes to Jotform', async () => {
  addAccount({ name: 'Ava Lin', fields: { [APP_URL]: 'https://www.jotform.com/submission/6380000000000000021' } });
  jf.addSub('252326779451161', '6380000000000000021', { child: 'Ava Lin', photos: { child: 'IMG.jpeg' } });
  await syncAllApplicants(env, { fetchImpl: w.fetchImpl });
  const base = jf.fetchImpl;
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(String(u));
    if (url.hostname === 'www.jotform.com' && url.pathname.startsWith('/widget-uploads/')) {
      return new Response(null, { status: 302, headers: { location: `https://storage.fake/signed${url.pathname}?sig=abc` } });
    }
    if (url.hostname === 'storage.fake') {
      if (url.searchParams.get('apiKey') || init.headers?.APIKEY) jf.state.leaks.push('storage.fake');
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    }
    return base(u, init);
  };
  for (let n = 0; n < 4; n++) await runJotformBackfill(env, { fetchImpl });
  assert.deepEqual(jf.state.leaks, []);
  assert.ok(Object.values(w.world.accounts).find(a => a.name === 'Ava Lin').files.some(f => f.name === 'Ava Lin.jpg'));
});

test('what a file is, from its first bytes (Jotform says octet-stream)', () => {
  const b = (...xs) => new Uint8Array([...xs, ...new Array(20).fill(0)]);
  const s = (str) => new Uint8Array([...new TextEncoder().encode(str), ...new Array(20).fill(0)]);
  assert.equal(sniffType(b(0xff, 0xd8, 0xff, 0xe1)), 'image/jpeg');
  assert.equal(sniffType(b(0x89, 0x50, 0x4e, 0x47)), 'image/png');
  assert.equal(sniffType(s('\0\0\0\x18ftypheic')), 'image/heic');
  assert.equal(sniffType(s('\0\0\0\x18ftypqt  ')), 'video/quicktime');
  assert.equal(sniffType(s('\0\0\0\x18ftypisom')), 'video/mp4');
  assert.equal(sniffType(s('%PDF-1.7')), 'application/pdf');
  assert.equal(sniffType(s('<html><body>')), null);
});

test('nothing runs without the key', async () => {
  delete env.JOTFORM_API_KEY;
  assert.equal(await runJotformBackfill(env, opts()), null);
  assert.equal(jf.state.calls.length, 0);
});
