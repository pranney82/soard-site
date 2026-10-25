/**
 * The admin's file viewer (public/admin/file-viewer.js): what it needs from the
 * server and the admin's Content-Security-Policy, and that pdf.js's files are
 * there and can't restyle the rest of the admin. Clicking through it in a
 * browser is scripts/test-file-viewer.mjs.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import { applicantDetail, syncAllApplicants, FIELDS } from '../functions/api/_applicants.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

test('the admin policy lets the viewer read JobTread’s files (pdf.js, Download), show its photos and play its videos', () => {
  const block = read('public/_headers').split('/admin/*')[1];
  for (const name of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']) {
    const csp = (block.match(new RegExp(`^\\s+${name}: (.+)$`, 'm')) || [])[1] || '';
    for (const dir of ['connect-src', 'img-src', 'media-src']) {
      const list = (csp.match(new RegExp(`${dir} ([^;]+)`)) || [])[1]?.split(/\s+/) || [];
      assert.ok(list.includes('https://cdn.jobtread.com'), `${name} ${dir} allows https://cdn.jobtread.com`);
    }
    assert.ok(!/wasm-unsafe-eval/.test(csp), `${name}: pdf.js runs without WebAssembly (useWasm: false)`);
  }
});

test('pdf.js is there: the bundle, its worker, the standard fonts and the image decoders it imports', () => {
  const bundle = read('public/admin/vendor-pdf.js');
  assert.match(bundle, /pdfjs-dist@\d+\.\d+\.\d+/);
  assert.match(bundle, /new URL\("\.\/vendor-pdf\.worker\.js",import\.meta\.url\)/);
  for (const f of ['vendor-pdf.worker.js', 'pdf/standard_fonts/LiberationSans-Regular.ttf', 'pdf/standard_fonts/FoxitSerif.pfb', 'pdf/wasm/jbig2_nowasm_fallback.js', 'pdf/wasm/openjpeg_nowasm_fallback.js']) {
    assert.ok(existsSync(`${ROOT}public/admin/${f}`), f);
  }
  const viewer = read('public/admin/file-viewer.js');
  assert.match(viewer, /new URL\('\.\/pdf\/', import\.meta\.url\)/);
  assert.match(viewer, /useWasm: false/);
});

test('pdf.js’s stylesheet styles only the pages it draws, never the rest of the admin', () => {
  const bundle = read('public/admin/vendor-pdf.js');
  const start = bundle.indexOf('`.fv{');
  assert.ok(start > 0, 'the stylesheet is in the bundle, its variables on the viewer');
  let end = start + 1;
  while (bundle[end] !== '`') end += bundle[end] === '\\' ? 2 : 1;
  const css = bundle.slice(start + 1, end);
  const tops = [];
  let depth = 0;
  let sel = '';
  for (const ch of css) {
    if (ch === '{') { if (depth === 0) tops.push(sel.trim()); depth++; sel = ''; } else if (ch === '}') { depth--; sel = ''; } else if (ch === ';' && depth === 0) sel = ''; else sel += ch;
  }
  const allowed = /^(\.fv|\.pdfViewer|\.page\b|\.canvasWrapper|\.textLayer|\.annotationLayer|:is\(\.annotationLayer|\.hiddenCanvasElement|\.dummyPage|\[data-main-rotation|@media|@keyframes|@property)/;
  const stray = tops.flatMap((t) => (t.startsWith('@') ? [t] : t.split(','))).map((t) => t.trim()).filter((t) => !allowed.test(t));
  assert.deepEqual(stray, [], `rules outside the viewer: ${stray.join(' | ')}`);
  assert.ok(!/:root/.test(css), 'nothing on :root');
});

test('a family’s files and what they attach to messages come with links and thumbnails', async () => {
  const w = fakeApplicantWorld();
  const env = { ...w.env, DB: await createD1() };
  const F = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.id]));
  w.world.accounts.acct1 = {
    id: 'acct1', name: 'Avery Stone', type: 'customer', org: ORG, createdAt: '2026-10-01T12:00:00.000Z', fields: { [F.status]: 'Applied', [F.year]: '2027' },
    contacts: [], primaryContactId: null, locations: [], jobs: [],
    files: [
      { id: 'f1', name: 'Avery Stone.jpg', type: 'image/jpeg', size: 1000 },
      { id: 'f2', name: 'Avery Stone_Application.pdf', type: 'application/pdf', size: 2000 },
      { id: 'f3', name: 'Avery Stone_Application.mp4', type: 'video/mp4', size: 3000 },
      { id: 'f4', name: 'Letter.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 4000 },
    ],
    comments: [{ id: 'c1', name: 'Application Status', message: 'A copy is attached.', by: 'Qualification Committee', createdAt: '2026-10-01T12:00:00.000Z', attachments: [{ id: 'a1', name: 'Avery Stone_Application.pdf', type: 'application/pdf', size: 2000 }] }],
  };
  await syncAllApplicants(env, { fetchImpl: w.fetchImpl });
  const d = await applicantDetail(env, 'acct1', { fetchImpl: w.fetchImpl });
  const byName = Object.fromEntries(d.files.map((f) => [f.name, f]));
  assert.equal(byName['Avery Stone.jpg'].url, 'https://cdn.fake/f1');
  assert.ok(byName['Avery Stone.jpg'].thumb, 'a photo has its thumbnail');
  assert.ok(byName['Avery Stone_Application.pdf'].thumb, 'a PDF has JobTread’s picture of its first page');
  assert.ok(byName['Avery Stone_Application.mp4'].thumb, 'a video has a frame for the strip and the poster');
  assert.equal(byName['Letter.docx'].thumb, null, 'a Word file has none (its icon shows)');
  assert.deepEqual(d.comments.find((c) => c.id === 'c1').files, [{ id: 'a1', name: 'Avery Stone_Application.pdf', type: 'application/pdf', size: 2000, at: null, url: 'https://cdn.fake/a1', thumb: 'https://cdn.fake/a1?size=600' }]);
});
