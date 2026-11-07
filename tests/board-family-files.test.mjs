/**
 * What the board may see of a family (functions/api/_board-families.js): their video, photos and application, through
 * the board's own route, and nothing else. Made-up families; JobTread and its file CDN are faked. The page itself is
 * walked in scripts/test-board-family-map.mjs.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { familiesList, familyOne, familyFile } from '../functions/api/_board-families.js';
import { ensureActivitySchema, noteFamilyOpen } from '../functions/api/_board-activity.js';
import { said } from '../public/admin/board-activity.js';
import { applicationParts, provenParts, fileKind, photoLabel } from '../public/admin/application-files.js';
import { deleteApplicationData, ensureSchema as ensureApplicationTables } from '../functions/api/_applications.js';
import { writeState } from '../functions/api/_board-roles.js';

const FILE = (id, name, type, more = {}) => ({ id, name, type, size: 1000, createdAt: '2026-11-03T14:00:00Z', url: `https://cdn.jobtread.com/${id}`, thumb: `https://cdn.jobtread.com/${id}?size=600`, job: null, ...more });
const FILES = [
  FILE('fNote1', 'Linzi_Iris_Onsite_Notes.pdf', 'application/pdf'), FILE('fNote2', 'Iris_ZoomNotes.pdf', 'application/pdf'),
  FILE('fNote3', 'Clareece_Iris_Application_Notes.pdf', 'application/pdf'), FILE('fNote4', 'Clareece_IrisOnsiteNotes', 'application/pdf'),
  FILE('fSvg', 'Iris Drawing.svg', 'image/svg+xml'), FILE('fHtml', 'Iris.html', 'text/html'), FILE('fOdd', 'Iris Application.exe', 'application/octet-stream'),
  FILE('fJob', 'Iris Example Before.jpg', 'image/jpeg', { job: { id: 'job1' } }),
  FILE('fOffSite', 'Iris Example Space 3.jpg', 'image/jpeg', { url: 'https://example.com/x.jpg' }),
  FILE('fSpace', 'Iris Example Space 1.jpg', 'image/jpeg'), FILE('fFam', 'Iris Example Family.jpg', 'image/jpeg'), FILE('fKid', 'Iris Example.jpg', 'image/jpeg'),
  FILE('fVid', 'Iris Example_Application.mp4', 'video/mp4'), FILE('fPdf', 'Iris Example_Application.pdf', 'application/pdf'),
];

let DB;
let env;
let calls;
let down;
let cdnStatus;
const realFetch = globalThis.fetch;
const member = { slug: 'kim-park', name: 'Kim Park' };
const applicant = (id, name, more = {}) => DB.prepare(`INSERT INTO applicants (account_id, name, status, year, types, fields, address, city, county, lat, lng, area, area_miles, contact_name, contact_email, contact_phone, contacts, photo_url, archived_at, synced_at)
  VALUES (?, ?, ?, '2027', '["Bedroom"]', ?, '12 Elm St', 'Roswell', 'Fulton', 34.02, -84.36, 'inside', 0, 'Parent Example', 'parent@example.com', '4045550100', '[]', ?, ?, ?)`)
  .bind(id, name, 'status' in more ? more.status : 'Applied', JSON.stringify({ diagnosis: 'Example' }), more.photo || null, more.archived || null, new Date().toISOString()).run();
const ask = async (q, { headers = {}, data = { boardMember: member } } = {}) => {
  const params = new URLSearchParams(q);
  const waits = [];
  const context = { env, data, waitUntil: (p) => waits.push(p), request: new Request(`https://x.test/api/board-file?${params}`, { headers }) };
  const res = await familyFile(context, params, { fetchImpl: globalThis.fetch });
  await Promise.all(waits);
  return res;
};

beforeEach(async () => {
  DB = await createD1();
  await ensureApplicantSchema(DB);
  await ensureActivitySchema(DB);
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, jt_account_id TEXT, lang TEXT, jt_state TEXT, files TEXT, is_test INTEGER DEFAULT 0, submitted_at TEXT, kind TEXT, deleted_at TEXT)',
    'CREATE TABLE IF NOT EXISTS kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)',
    'CREATE TABLE IF NOT EXISTS community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)',
    'CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)',
  ]) await DB.exec(sql);
  await applicant('acctIris01', 'Iris Example', { photo: 'https://cdn.jobtread.com/fKid?size=256' });
  await applicant('acctTest01', 'TEST Applicant');
  await applicant('acctRun001', 'Sample Child');
  await applicant('acctGone01', 'Gone Example', { archived: '2026-01-01T00:00:00Z' });
  await applicant('acctNone01', 'None Example', { status: null });
  await applicant('acctForm01', 'Rosa Example');
  await DB.prepare("INSERT INTO applications (id, jt_account_id, jt_state, files, is_test, submitted_at) VALUES ('app-1', 'acctRun001', '{}', '{}', 1, '2026-11-06')").run();
  await DB.prepare("INSERT INTO applications (id, jt_account_id, jt_state, files, is_test, submitted_at) VALUES ('app-2', 'acctForm01', ?, ?, 0, '2026-11-06')")
    .bind(JSON.stringify({ pdf: { key: 'r2/rosa.pdf' } }), JSON.stringify({ photoChild: { key: 'r2/rosa.jpg', thumbKey: 'r2/rosa-t.jpg' }, video: { uploaded: true } })).run();
  calls = [];
  down = false;
  cdnStatus = 200;
  env = {
    DB, JOBTREAD_GRANT_KEY: 'jt',
    FILES: { get: async (key) => ({ body: 'bytes', httpMetadata: { contentType: key.endsWith('.pdf') ? 'application/pdf' : key.includes('svg') ? 'image/svg+xml' : 'image/jpeg' } }) },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.jobtread.com/pave') {
      if (down) return new Response('down', { status: 503 });
      const id = JSON.parse(init.body).query.account.$.id;
      return Response.json({ account: { files: { nodes: id === 'acctIris01' ? FILES : [] } } });
    }
    if (url.startsWith('https://cdn.jobtread.com/')) {
      if (cdnStatus !== 200) return new Response('no', { status: cdnStatus });
      const range = new Headers(init.headers || {}).get('range');
      return range
        ? new Response('pa', { status: 206, headers: { 'content-range': 'bytes 5-6/100', 'content-length': '2', 'accept-ranges': 'bytes', 'content-type': 'application/x-whatever' } })
        : new Response('whole', { headers: { 'content-length': '5', 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('a family’s files, sorted', () => {
  const parts = applicationParts(FILES, 'Iris Example');
  test('the application, never a note that mentions it', () => {
    assert.equal(parts.pdf.id, 'fPdf');
    assert.equal(applicationParts([FILES[2]], 'Iris').pdf, null, 'Clareece_Iris_Application_Notes is a note');
  });
  test('the family’s video, or an older family’s one video', () => {
    assert.equal(parts.video.id, 'fVid');
    assert.equal(applicationParts([FILE('v', 'IMG_4471 (2).mov', 'video/quicktime')], 'Iris').video.id, 'v');
  });
  test('the photos in the form’s order', () => {
    assert.deepEqual(applicationParts(FILES.slice(9), 'Iris Example').photos.map((f) => photoLabel(f, 'Iris Example')), ['Child', 'Family', 'Space 1']);
  });
  test('the rest stay with staff', () => {
    assert.ok(parts.docs.some((f) => f.id === 'fNote1') && parts.docs.some((f) => f.id === 'fNote4'));
  });
  test('a file’s kind by its name when it has no type', () => {
    assert.equal(fileKind({ name: 'a.MOV' }), 'video');
    assert.equal(fileKind({ name: 'a.HEIC' }), 'image');
    assert.equal(fileKind({ name: 'a.pdf' }), 'pdf');
  });
});

describe('what the board sees is proven by its name', () => {
  const child = 'Iris Example';
  const beside = [FILE('real', 'Iris Example_Application.pdf', 'application/pdf', { createdAt: '2026-01-01' }), FILE('realv', 'Iris Example_Application.mp4', 'video/mp4', { createdAt: '2026-01-01' }), FILE('kid', 'Iris Example.jpg', 'image/jpeg')].map((f) => ({ ...f, at: f.createdAt }));
  const at = (f) => ({ ...f, at: f.createdAt });
  const photosOf = (name, more = []) => provenParts([at(FILE('x', name, /\.png$/i.test(name) ? 'image/png' : 'image/jpeg')), ...more], child).photos.map((f) => f.label);

  for (const name of [
    // (an independent review's names, Nov 7 2026: each got through when a name only had to share a word with theirs)
    'Iris_DriversLicense.jpg', 'Iris_InsuranceCard.jpg', 'Iris_MedicaidCard.jpg', 'Iris_BirthCertificate.jpg', 'Iris_TaxReturn.jpg', 'Clareece_Iris_OnsiteNotes.jpg', 'Iris_ZoomNotes.png',
    'Iris_DoctorsNote.jpg', 'Iris Xray.jpg', 'Iris MRI.jpg', 'Iris IEP.jpg', 'Iris Hospital.jpg', 'Iris Social Security.jpg', 'Iris EOB.png', 'Iris DL.jpg', 'Iris 1040.jpg', 'Iris W-2.jpg',
    'Iris 2025 1099.jpg', 'Iris Rash Photo 3.jpg', 'Iris Example Xray.jpg',
    'Iris Drivers License.jpg', 'Iris Insurance Card.png', 'Iris Birth Certificate.jpg', 'Iris Tax Return 2025.jpg', 'W2.png', 'Doctor Letter.jpg', 'Iris Medical Records.heic',
    'Signed Agreement.jpg', 'Screenshot 2026-10-04 at 3.12.40 PM.png', 'Zoom Screenshot.png', 'Family Medical Letter.jpg', 'Home visit · Oct 21, 2026.jpg', 'Onsite Visit.jpg', 'IMG_4471.jpeg', 'Iris Insurance Family.jpg', 'Medical Space.jpg', 'photo.jpg', 'Untitled.png']) {
    test(`a photo called “${name}” stays with staff`, () => assert.deepEqual(photosOf(name), []));
  }
  for (const [name, label] of [['Iris Example.jpg', 'Child'], ['Iris.jpeg', 'Child'], ['Iris Example Family.jpg', 'Family'], ['Family.jpg', 'Family'], ['Iris Example Space 1.jpg', 'Space 1'], ['Iris Example Space 3.png', 'Space 3'], ['Iris Example Space.jpg', 'Space'], ['Iris Example Space 1 (1).jpg', 'Space 1'], ['Iris & Rosa Example Space 2.jpg', 'Space 2'], ['7d4faceIris_5e81d0.jpeg', 'Child'], ['5f2familyIris_a1b2c3.jpg', 'Family']]) {
    test(`a photo called “${name}” shows as ${label}`, () => assert.deepEqual(photosOf(name), [label]));
  }
  test('a nickname counts when their own photos go by it', () => {
    const f = [at(FILE('a', 'Lizzie.jpeg', 'image/jpeg')), at(FILE('b', 'Lizzie Family.jpeg', 'image/jpeg')), at(FILE('c', 'Lizzie_Application.pdf', 'application/pdf')), at(FILE('d', 'Lizzie_Application.mp4', 'video/mp4'))];
    const p = provenParts(f, 'Elizabeth Stone');
    assert.deepEqual(p.photos.map((x) => x.label), ['Child', 'Family']);
    assert.equal(p.pdf.id, 'c');
    assert.equal(p.video.id, 'd');
  });
  test('an organization’s own name can be any word', () => {
    const p = provenParts([at(FILE('a', 'Lionheart School Space 1.jpg', 'image/jpeg')), at(FILE('b', 'Lionheart School_Application.pdf', 'application/pdf'))], 'Lionheart School');
    assert.deepEqual(p.photos.map((x) => x.label), ['Space 1']);
    assert.equal(p.pdf.id, 'b');
  });
  for (const name of ['Iris_PeachCare_Application.pdf', 'Iris_KatieBeckett_Application.pdf', 'Iris_OnsiteNotes_Application.pdf', 'Iris_Rental_Application.pdf', 'Iris Example PeachCare Application.pdf',
    'Iris_Application_Review.pdf', 'Iris_Application_Interview_Summary.pdf', 'Iris_Application_Zoom.pdf', 'Iris_Application_Onsite.pdf', 'Iris_Application_Scoring.pdf', 'Iris_Application_Agreement_Signed.pdf',
    'Iris_Medicaid_Application.pdf', 'Katie_Beckett_Application.pdf', 'SNAP_Application_2026.pdf', 'Application_Denial_Letter.pdf', 'Clareece_ApplicationNotesIris.pdf', 'IrisOnsiteNotesApplication.pdf', 'Iris_NotesOnApplication.pdf', 'Application.pdf', 'Housing_Application.pdf']) {
    test(`“${name}” is never the application, alone or newer than the real one`, () => {
      const f = at(FILE('x', name, 'application/pdf'));
      assert.equal(provenParts([f], child).pdf, null);
      assert.equal(provenParts([f, ...beside], child).pdf.id, 'real');
    });
  }
  test('a PDF typed but named .Notes isn’t the application: only a real extension comes off a name', () => {
    assert.equal(provenParts([at(FILE('x', 'Iris_Application.Notes', 'application/pdf'))], child).pdf, null);
  });
  for (const name of ['Iris_Zoom_Recording.mp4', 'Onsite_Walkthrough.mov', 'Iris_Interview.mp4', 'IMG_4471 (2).mov', 'GMT20261004-143000_Recording.mp4']) {
    test(`“${name}” is never their video`, () => {
      assert.equal(provenParts([at(FILE('x', name, 'video/mp4'))], child).video, null);
      assert.equal(provenParts([at(FILE('x', name, 'video/mp4')), ...beside], child).video.id, 'realv');
    });
  }
  test('an application named the other way round is still theirs', () => {
    assert.equal(provenParts([at(FILE('x', 'Application_Iris Example.pdf', 'application/pdf'))], child).pdf.id, 'x');
    assert.equal(provenParts([at(FILE('x', 'Application_Denial_Letter.pdf', 'application/pdf'))], child).pdf, null);
    assert.equal(provenParts([at(FILE('x', 'Application_Iris_Review.pdf', 'application/pdf'))], child).pdf, null);
  });
  test('the oldest wins, and exactly their name beats their nickname', () => {
    const a = at(FILE('a', 'Iris Example_Application.pdf', 'application/pdf', { createdAt: '2026-01-01' }));
    const b = at(FILE('b', 'Iris Example_Application (1).pdf', 'application/pdf', { createdAt: '2026-06-01' }));
    const c = at(FILE('c', 'Izzy_Application.pdf', 'application/pdf', { createdAt: '2025-01-01' }));
    const izzy = at(FILE('d', 'Izzy Family.jpg', 'image/jpeg'));
    assert.equal(provenParts([b, a], child).pdf.id, 'a');
    assert.equal(provenParts([c, b, a, izzy], child).pdf.id, 'a');
    assert.equal(provenParts([c, izzy], child).pdf.id, 'c');
  });
  test('a word that isn’t theirs, even a surname, and it stays with staff (staff rename it in JobTread to show it)', () => {
    assert.equal(provenParts([at(FILE('c', 'Iris Morgan Application.pdf', 'application/pdf'))], child).pdf, null);
    assert.deepEqual(provenParts([at(FILE('c', 'Iris Morgan.jpg', 'image/jpeg'))], child).photos, []);
    assert.equal(provenParts([at(FILE('c', 'IrisExample_Application.pdf', 'application/pdf'))], child).pdf.id, 'c', 'their name run together is still theirs');
  });
  test('staff still see everything, the application first', () => {
    const p = applicationParts([at(FILE('x', 'Iris Drivers License.jpg', 'image/jpeg')), at(FILE('z', 'Zoom Recording.mp4', 'video/mp4')), ...beside], child);
    assert.equal(p.pdf.id, 'real');
    assert.ok(p.photos.some((f) => f.id === 'x'));
    assert.equal(p.video.id, 'realv');
    assert.ok(p.docs.some((f) => f.id === 'z'));
    assert.equal(applicationParts([at(FILE('c', 'Clareece_ApplicationNotesIris.pdf', 'application/pdf'))], child).docs.length, 1, 'a glued note is a note');
  });
});

describe('the board’s list', () => {
  test('where they are, the service area, and no way to reach them', async () => {
    const { families, boundary } = await familiesList(env);
    assert.ok(boundary.polygon.length >= 3);
    const iris = families.find((f) => f.id === 'acctIris01');
    assert.equal(iris.lat, 34.02);
    assert.equal(iris.area, 'inside');
    assert.equal(iris.photo, '/api/board-file?family=acctIris01&face=1', 'the child’s photo through the board’s route, never JobTread’s');
    const text = JSON.stringify(families);
    assert.ok(!/cdn\.jobtread\.com|parent@example|4045550100|12 Elm/.test(text), text);
  });
  test('test runs stay off it: a TEST name, and a website test with an ordinary name', async () => {
    const ids = (await familiesList(env)).families.map((f) => f.id);
    assert.ok(!ids.includes('acctTest01') && !ids.includes('acctRun001') && !ids.includes('acctGone01'));
  });
  test('a website test whose answers were deleted is still a test', async () => {
    await DB.prepare("UPDATE applications SET deleted_at = '2026-11-06' WHERE id = 'app-1'").run();
    assert.ok(!(await familiesList(env)).families.some((f) => f.id === 'acctRun001'));
  });
  test('unsure is not shown: when the applications can’t be read, the list stops', async () => {
    const real = DB.prepare.bind(DB);
    DB.prepare = (sql) => { if (/FROM applications WHERE is_test/.test(sql)) throw new Error('D1 is busy'); return real(sql); };
    await assert.rejects(familiesList(env), /D1 is busy/);
    DB.prepare = real;
  });
  test('no status is no status, never “Applied”', async () => {
    assert.equal((await familiesList(env)).families.find((f) => f.id === 'acctNone01').status, '');
  });
});

describe('one family', () => {
  test('the application, the video and the photos, each through the board’s route', async () => {
    const { media } = (await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch })).family;
    assert.equal(media.application.url, '/api/board-file?family=acctIris01&file=fPdf');
    assert.equal(media.video.url, '/api/board-file?family=acctIris01&file=fVid');
    assert.deepEqual(media.photos.map((p) => p.label), ['Child', 'Family', 'Space 1']);
    assert.equal(media.photos[0].preview, '/api/board-file?family=acctIris01&file=fKid&size=2048');
    assert.ok(media.video.private && media.application.private, 'never fetched ahead of being shown');
    assert.equal(media.unavailable, false);
  });
  test('nothing else, and JobTread’s address nowhere', async () => {
    const text = JSON.stringify(await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch }));
    assert.ok(!/cdn\.jobtread\.com|fNote|Notes|fSvg|fHtml|fOdd|fJob|fOffSite/.test(text), text);
  });
  test('a family that isn’t the board’s to read', async () => {
    for (const id of ['acctTest01', 'acctRun001', 'acctGone01', 'acctNobody']) {
      await assert.rejects(familyOne(env, id, { fetchImpl: globalThis.fetch }), { status: 404 }, id);
    }
  });
  test('the website’s copy until JobTread has it, and a video on its way', async () => {
    const { media } = (await familyOne(env, 'acctForm01', { fetchImpl: globalThis.fetch })).family;
    assert.equal(media.application.url, '/api/board-file?family=acctForm01&site=pdf');
    assert.equal(media.photos[0].url, '/api/board-file?family=acctForm01&site=photoChild');
    assert.equal(media.videoSoon, true);
  });
  test('an application deleted from the site takes the site’s copies with it', async () => {
    await DB.prepare("UPDATE applications SET deleted_at = '2026-11-06' WHERE id = 'app-2'").run();
    const { media } = (await familyOne(env, 'acctForm01', { fetchImpl: globalThis.fetch })).family;
    assert.equal(media.application, null);
    assert.deepEqual(media.photos, []);
    assert.equal((await ask({ family: 'acctForm01', site: 'pdf' })).status, 404);
  });
  test('JobTread down: what was read stays for an hour; a family never read says it can’t be reached', async () => {
    const t = Date.now();
    await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch, now: t });
    down = true;
    assert.equal((await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch, now: t + 30 * 60_000 })).family.media.video.id, 'fVid');
    assert.equal((await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch, now: t + 61 * 60_000 })).family.media.unavailable, true, 'then it’s gone, not kept for good');
    assert.equal((await familyOne(env, 'acctNone01', { fetchImpl: globalThis.fetch })).family.media.unavailable, true);
  });
  test('none is fetched ahead of being shown, and a video’s card reads its length at its own address', async () => {
    const { media } = (await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch })).family;
    assert.ok([media.application, media.video, ...media.photos].every((f) => f.private));
    assert.equal(media.video.probe, '/api/board-file?family=acctIris01&file=fVid&peek=1');
  });
  test('oldest first, as many as JobTread gives, so a family with 60 newer files keeps their application', async () => {
    let asked = null;
    const was = globalThis.fetch;
    globalThis.fetch = async (u, i) => { if (String(u).endsWith('/pave')) asked = JSON.parse(i.body).query.account.files.$; return was(u, i); };
    await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch });
    globalThis.fetch = was;
    assert.deepEqual([asked.size, asked.sortBy[0].order], [100, 'asc']);
  });
  test('a file JobTread has no type for goes by its name', async () => {
    FILES.push(FILE('fRaw', 'Iris Example Space 2.jpg', 'application/octet-stream'));
    const { media } = (await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch })).family;
    FILES.pop();
    assert.equal(media.photos.find((p) => p.id === 'fRaw')?.type, 'image/jpeg');
  });
});

describe('/api/board-file?family=', () => {
  const opened = (kind = 'family') => DB.prepare('SELECT slug, ref, sub FROM board_activity WHERE kind = ? ORDER BY id').bind(kind).all().then((r) => r.results || []);

  test('the application: its own type, shown in the page, kept nowhere', async () => {
    const res = await ask({ family: 'acctIris01', file: 'fPdf' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf', 'never the type the CDN claims');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="Iris Example_Application\.pdf"$/);
  });
  test('a video seeks: its Range goes through and comes back', async () => {
    const res = await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=5-6' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 5-6/100');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-type'), 'video/mp4');
  });
  for (const [what, id] of [['staff’s onsite notes', 'fNote1'], ['staff’s Zoom notes', 'fNote2'], ['a note naming the application', 'fNote3'], ['an SVG, which could run on the site', 'fSvg'], ['a web page', 'fHtml'], ['a program', 'fOdd'], ['a build photo from the job', 'fJob'], ['a file that isn’t on JobTread’s CDN', 'fOffSite'], ['an id that doesn’t exist', 'nope']]) {
    test(`never ${what}, even with its address`, async () => {
      assert.equal((await ask({ family: 'acctIris01', file: id })).status, 404);
    });
  }
  test('another family’s file by this family’s address', async () => {
    assert.equal((await ask({ family: 'acctNone01', file: 'fPdf' })).status, 404);
  });
  test('nothing of a test run, an archived family or a bad id', async () => {
    for (const q of [{ family: 'acctTest01', face: '1' }, { family: 'acctRun001', file: 'fPdf' }, { family: 'acctGone01', file: 'fPdf' }, { family: '../etc', file: 'fPdf' }, { family: 'acctIris01' }]) {
      assert.equal((await ask(q)).status, 404, JSON.stringify(q));
    }
  });
  test('a thumbnail is the sizes the page asks for and nothing else, and is the only thing kept', async () => {
    const res = await ask({ family: 'acctIris01', file: 'fKid', size: '600' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
    assert.equal(calls.at(-1), 'https://cdn.jobtread.com/fKid?size=600');
    assert.equal((await ask({ family: 'acctIris01', file: 'fKid', size: '99999' })).status, 404);
    assert.equal((await opened()).length, 0, 'a tile’s thumbnail isn’t opening it');
  });
  test('the viewer’s big picture is the file itself: never kept, and noted', async () => {
    const res = await ask({ family: 'acctIris01', file: 'fPdf', size: '2048' });
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await opened()).map((r) => r.sub), ['application|Iris Example']);
  });
  test('seeing a video’s card isn’t watching it', async () => {
    assert.equal((await ask({ family: 'acctIris01', file: 'fVid', peek: '1' }, { headers: { range: 'bytes=0-' } })).status, 206);
    assert.equal((await opened()).length, 0);
  });
  test('only a video reads without being noted: the application by that address is still an opening', async () => {
    assert.equal((await ask({ family: 'acctIris01', file: 'fPdf', peek: '1' })).status, 200);
    assert.equal((await ask({ family: 'acctIris01', file: 'fKid', peek: '1' })).status, 200);
    assert.deepEqual((await opened()).map((r) => r.sub.split('|')[0]).sort(), ['application', 'photos']);
  });
  test('JobTread down: one try a minute, however many pieces and addresses are asked for', async () => {
    const paves = () => calls.filter((u) => u.endsWith('/pave')).length;
    await familyOne(env, 'acctIris01', { fetchImpl: globalThis.fetch, now: Date.now() - 15 * 60_000 });
    down = true;
    const before = paves();
    assert.equal((await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=5-6' } })).status, 206, 'what was read still plays');
    await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=7-8' } });
    for (const file of ['nope1', 'nope2', 'nope3']) assert.equal((await ask({ family: 'acctIris01', file })).status, 404);
    await ask({ family: 'acctIris01', face: '1' });
    assert.equal(paves() - before, 1);
  });
  test('a failed open isn’t noted as read', async () => {
    cdnStatus = 403;
    assert.equal((await ask({ family: 'acctIris01', file: 'fPdf' })).status, 500);
    assert.equal((await opened()).length, 0);
  });
  test('an unknown id asks JobTread at most once a minute', async () => {
    await ask({ family: 'acctIris01', file: 'fPdf' });
    const before = calls.filter((u) => u.endsWith('/pave')).length;
    await ask({ family: 'acctIris01', file: 'nope1' });
    await ask({ family: 'acctIris01', file: 'nope2' });
    assert.equal(calls.filter((u) => u.endsWith('/pave')).length, before);
  });
  test('a list’s face: the mirror’s photo, or the site’s, and only from JobTread', async () => {
    assert.equal((await ask({ family: 'acctIris01', face: '1' })).status, 200);
    assert.equal(calls.at(-1), 'https://cdn.jobtread.com/fKid?size=256');
    assert.equal((await ask({ family: 'acctForm01', face: '1' })).status, 200);
    assert.equal((await ask({ family: 'acctNone01', face: '1' })).status, 404);
  });
  test('a list’s face is never a photo the board couldn’t open itself', async () => {
    // Staff's list picked a photo whose name proves nothing (its rule is looser): the board's face is a proven one, or none
    await applicant('acctAva001', 'Ava Example', { photo: 'https://cdn.jobtread.com/fAva1040?size=600' });
    const before = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => (String(input).endsWith('/pave') && JSON.parse(init.body).query.account.$.id === 'acctAva001'
      ? Response.json({ account: { files: { nodes: [FILE('fAva1040', 'Ava 1040.jpg', 'image/jpeg'), FILE('fAvaW2', 'Ava W-2.jpg', 'image/jpeg')] } } })
      : before(input, init));
    assert.equal((await ask({ family: 'acctAva001', face: '1' })).status, 404);
    assert.ok(!calls.some((u) => /fAva/.test(u)), 'nothing of theirs was fetched');
    await DB.prepare("UPDATE applicants SET photo_url = 'https://cdn.jobtread.com/fNote1?size=600' WHERE account_id = 'acctIris01'").run();
    assert.equal((await ask({ family: 'acctIris01', face: '1' })).status, 200);
    assert.equal(calls.at(-1), 'https://cdn.jobtread.com/fKid?size=256', 'their photo named as the child, not staff’s pick');
  });
  test('the site’s copy: a photo or the PDF, nothing a browser could run', async () => {
    assert.equal((await ask({ family: 'acctForm01', site: 'pdf' })).headers.get('content-type'), 'application/pdf');
    assert.equal((await ask({ family: 'acctForm01', site: 'photoChild', thumb: '1' })).headers.get('cache-control'), 'private, max-age=300');
    assert.equal((await ask({ family: 'acctForm01', site: 'photoChild' })).headers.get('cache-control'), 'private, no-store');
    assert.equal((await ask({ family: 'acctForm01', site: 'video' })).status, 404, 'only the form’s photos');
    assert.equal((await ask({ family: 'acctIris01', site: 'pdf' })).status, 404, 'a family with no site application');
  });
  test('a video’s pieces don’t each ask JobTread', async () => {
    await ask({ family: 'acctIris01', file: 'fVid' });
    const asked = calls.filter((u) => u.endsWith('/pave')).length;
    await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=5-6' } });
    await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=7-8' } });
    assert.equal(calls.filter((u) => u.endsWith('/pave')).length, asked);
  });
  test('a member’s opening is noted once, in words, for Board → Members', async () => {
    await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=0-' } });
    await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=500-' } });
    await ask({ family: 'acctIris01', file: 'fVid' }, { headers: { range: 'bytes=0-' } });
    await ask({ family: 'acctIris01', file: 'fPdf' });
    await ask({ family: 'acctIris01', file: 'fKid' });
    await ask({ family: 'acctIris01', file: 'fKid', size: '256' });
    const rows = await opened();
    assert.deepEqual(rows.map((r) => r.sub), ['video|Iris Example', 'application|Iris Example', 'photos|Iris Example']);
    assert.deepEqual(rows.map((r) => said({ kind: 'family', ...r }, { meetings: new Map(), files: new Map(), items: new Map(), docs: new Map(), motions: new Map(), actions: new Map() }).text), ['Watched Iris Example’s video', 'Read Iris Example’s application', 'Looked at Iris Example’s photos']);
  });
  test('an admin looking is never noted', async () => {
    await ask({ family: 'acctIris01', file: 'fVid' }, { data: {} });
    assert.equal((await opened()).length, 0);
  });
});

describe('deleting an application', () => {
  test('takes what the board page kept with it (the real delete, on the real tables)', async () => {
    const db = await createD1();
    await ensureApplicationTables(db);
    await ensureApplicantSchema(db);
    await ensureActivitySchema(db);
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO applications (id, year, child_name, answers, files, jt_account_id, jt_state, status, submitted_at, updated_at) VALUES ('app-del', '2027', 'Iris Example', '{}', '{}', 'acctIris01', '{}', 'done', ?, ?)").bind(now, now).run();
    await writeState(db, 'family-files:acctIris01', { at: Date.now(), pdf: { id: 'fPdf', url: 'https://cdn.jobtread.com/fPdf' } });
    await db.prepare("INSERT INTO team (slug, name, \"group\", data) VALUES ('kim-park', 'Kim', 'board', '{}')").run().catch(() => {});
    await noteFamilyOpen({ DB: db }, member, new Request('https://x.test/'), 'acctIris01', 'application', 'Iris Example');
    assert.equal((await db.prepare("SELECT sub FROM board_activity WHERE ref = 'acctIris01'").first()).sub, 'application|Iris Example');

    assert.equal((await deleteApplicationData({ DB: db }, 'app-del', { user: 'test' })).ok, true);

    assert.equal(await db.prepare("SELECT 1 FROM board_state WHERE key = 'family-files:acctIris01'").first(), null, 'JobTread’s links are gone');
    const row = await db.prepare("SELECT sub FROM board_activity WHERE ref = 'acctIris01'").first();
    assert.equal(row.sub, 'application|', 'who opened it stays, the child’s name doesn’t');
    assert.equal(said({ kind: 'family', sub: row.sub }, { meetings: new Map() }).text, 'Read a family’s application');
  });
});
