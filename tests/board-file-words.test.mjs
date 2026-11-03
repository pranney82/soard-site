/**
 * Every board file's words, for the board page's search (functions/api/_board-file-words.js): a PDF by its pages, a
 * scan by its pages' pictures, Word, Excel and PowerPoint by their own readers, a picture by the vision model; read
 * once, SOARD's papers first, then the newest; and a board member gets the words of only what their page shows.
 * Workers AI is faked. Made-up content only (the repo is public).
 * Run: node --test tests/board-file-words.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createD1 } from './lib/d1-shim.mjs';
import { wordsOf, pdfPages, readBoardWords, wordsStatus, filingWordsFor, READER } from '../functions/api/_board-file-words.js';
import { saveMeeting, putFile, portalWords, saveDoc, ensureSchema, maybeRunBoard } from '../functions/api/_board.js';
import { newMeeting, todayEastern } from '../public/admin/board-shared.js';

function zip(files) {
  const enc = new TextEncoder();
  const locals = []; const central = []; let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameB = enc.encode(name); const raw = typeof body === 'string' ? enc.encode(body) : body; const data = deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'xmlns:w="w"';
const docx = (lines) => zip({ 'word/document.xml': `<w:document ${W}><w:body>${lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${l}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>` });
const xlsx = () => zip({
  'xl/workbook.xml': `<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/sharedStrings.xml': '<sst><si><t>Gala sponsorships</t></si><si><t>Store sales</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>45500</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>12000</v></c></row></sheetData></worksheet>',
});
const pptx = () => {
  const ns = 'xmlns:a="a" xmlns:p="p" xmlns:r="r"';
  const sp = (t) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
  return zip({
    'ppt/presentation.xml': `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld ${ns}><p:cSld><p:spTree>${sp('Strategic plan 2027')}</p:spTree></p:cSld></p:sld>`,
    'ppt/slides/slide2.xml': `<p:sld ${ns}><p:cSld><p:spTree>${sp('Grow the volunteer base')}</p:spTree></p:cSld></p:sld>`,
  });
};
// A scan: a PDF whose one page is a JPEG, nothing else to read
function scanPdf() {
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7), Buffer.from([0xFF, 0xD9])]);
  return new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 /Filter /DCTDecode /Length 70 >>\nstream\n', 'latin1'), jpeg, Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')]));
}
const pdf = (text = '') => new TextEncoder().encode(`%PDF-1.4 ${text}`);

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length } : null; }
  async delete(key) { this.map.delete(key); }
}
// Workers AI: the converter gives each PDF's pages as its own words say; the vision model reads a picture
const ai = (pages = {}) => ({
  calls: { markdown: 0, vision: 0 },
  async toMarkdown(doc) { this.calls.markdown++; const p = pages[doc.name]; return { name: doc.name, format: 'markdown', data: p ? `# ${doc.name}\n## Metadata\n- PDFFormatVersion=1.4\n## Contents\n${p.map((t, i) => `### Page ${i + 1}\n${t}`).join('\n')}` : `# ${doc.name}\n## Metadata\n- Creator=Scanner\n## Contents\n### Page 1\n` }; },
  async run(model, input) { this.calls.vision++; assert.match(model, /vision|llama-4-scout/); assert.match(input.messages[1].content[1].image_url.url, /^data:image\/(jpeg|png);base64,/); return { response: 'MINUTES OF THE BOARD\nThe board approved the conflict of interest policy.' }; },
});

let env;
beforeEach(async () => {
  env = { DB: await createD1(), FILES: new FakeR2() };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await ensureSchema(env.DB);
});

test('toMarkdown’s text as pages, its own framing (the name, Metadata, Contents) left out', () => {
  const pages = pdfPages('# minutes.pdf\n## Metadata\n- PDFFormatVersion=1.7\n- Creator=Word\n## Contents\n### Page 1\nCall to order\n### Page 2\n| Motion | Carried |\n|---|---|\nAdjourned');
  assert.equal(pages.length, 2);
  assert.match(pages[0], /Call to order/);
  assert.doesNotMatch(pages.join(' '), /Metadata|PDFFormatVersion|Creator|Contents|\|/);
  assert.match(pages[1], /Motion\s+Carried/);
});

test('each kind of file read the way it’s written: a PDF’s pages, a scan by its pictures, Word, Excel, PowerPoint, a picture', async () => {
  env.AI = ai({ 'minutes.pdf': ['Call to order at 6 pm.', 'The reserve fund policy was adopted.'] });
  const p = await wordsOf(env, { name: 'minutes.pdf', type: 'application/pdf', bytes: pdf() });
  assert.equal(p.how, 'text');
  assert.equal(p.words, 'Call to order at 6 pm.\fThe reserve fund policy was adopted.', 'a form feed between pages');
  const scan = await wordsOf(env, { name: 'old minutes.pdf', type: 'application/pdf', bytes: scanPdf() });
  assert.equal(scan.how, 'pictures');
  assert.match(scan.words, /conflict of interest policy/);
  assert.equal(env.AI.calls.vision, 1, 'its one page read once');
  assert.match((await wordsOf(env, { name: 'Report.docx', bytes: docx(['Executive Director Report', 'Seven makeovers this quarter']) })).words, /Executive Director Report\nSeven makeovers/);
  const sheet = (await wordsOf(env, { name: 'Budget.xlsx', bytes: xlsx() })).words;
  assert.match(sheet, /Budget/);
  assert.match(sheet, /Gala sponsorships/);
  assert.match(sheet, /45,?500/);
  assert.equal((await wordsOf(env, { name: 'Plan.pptx', bytes: pptx() })).words, 'Strategic plan 2027\fGrow the volunteer base', 'a slide a page');
  const pic = await wordsOf(env, { name: 'Store sales.png', type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]) });
  assert.equal(pic.how, 'pictures');
  assert.deepEqual(await wordsOf(env, { name: 'Old.doc', type: 'application/msword', bytes: new Uint8Array([0xD0, 0xCF]) }), { words: '', how: 'none' });
});

test('a model that answers about the page instead of with it keeps nothing', async () => {
  env.AI = { async run() { return { response: 'The image shows a blurry page with a logo.' }; } };
  assert.deepEqual(await wordsOf(env, { name: 'photo.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xFF, 0xD8, 0xFF]) }), { words: '', how: 'none' });
});

async function meeting(date, shared = true) {
  return saveMeeting(env.DB, { ...newMeeting({ date }), shared }, { by: 'jane@soardcharity.com' });
}
const put = (m, name, bytes, { kind = 'minutes', type = 'application/pdf', staffOnly = false } = {}) => putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([bytes], name, { type }), kind, staffOnly, by: 'jane@soardcharity.com' });

test('read once, a few at a time: SOARD’s papers first, then the newest meeting’s files; a member’s signed copy never', async () => {
  env.AI = ai({ 'old.pdf': ['Old words'], 'new.pdf': ['New words'], 'Bylaws.pdf': ['Article IV term limits'] });
  const old = await meeting('2019-02-11');
  const fresh = await meeting(todayEastern());
  const a = await put(old, 'old.pdf', pdf());
  await new Promise((r) => setTimeout(r, 5));
  const b = await put(fresh, 'new.pdf', pdf());
  const doc = await saveDoc(env.DB, { title: 'Bylaws', kind: 'governance', shared: true }, { by: 'jane@soardcharity.com' });
  await new Promise((r) => setTimeout(r, 5));
  const paper = await putFile(env, { ownerType: 'doc', ownerId: doc.id, file: new File([pdf()], 'Bylaws.pdf', { type: 'application/pdf' }), by: 'jane@soardcharity.com' });
  await env.DB.prepare("INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES ('f_signed01', 'signed', ?, 'board/x', 'Signed.pdf', 'application/pdf', 10, 'other', 1, ?, 'x')").bind(doc.id, new Date().toISOString()).run();
  assert.equal(await readBoardWords(env, { limit: 2 }), 2);
  const got = Object.fromEntries(((await env.DB.prepare('SELECT id, words, words_v FROM board_files').all()).results).map((r) => [r.id, r]));
  assert.equal(got[paper.id].words, 'Article IV term limits', 'the paper first');
  assert.equal(got[b.id].words, 'New words', 'then the newest meeting’s');
  assert.equal(got[a.id].words, null, 'the older one waits');
  assert.equal(await readBoardWords(env), 1);
  assert.equal(await readBoardWords(env), 0, 'each read once');
  assert.equal(got.f_signed01.words, null);
  assert.equal(env.AI.calls.markdown, 3);
  assert.deepEqual(await wordsStatus(env.DB), { files: 3, read: 3, withWords: 3, failed: 0, toRead: 0 });
  // A paper read by the old reader (PDFs only, a scan left empty) is read again by this one
  await env.DB.prepare("UPDATE board_files SET words = '', words_v = NULL WHERE id = ?").bind(paper.id).run();
  assert.equal(await readBoardWords(env), 1);
  assert.equal((await env.DB.prepare('SELECT words_v FROM board_files WHERE id = ?').bind(paper.id).first()).words_v, READER);
});

test('the heartbeat reads them by itself; one Workers AI couldn’t read just then is tried again later, three times at most', async () => {
  env.AI = { async toMarkdown() { throw new Error('converter down'); }, async run() { throw new Error('vision down'); } };
  const m = await meeting('2025-07-24');
  const f = await put(m, 'minutes.pdf', pdf());
  const g = await put(m, 'photo.jpg', new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]), { type: 'image/jpeg', kind: 'other' });
  await maybeRunBoard(env, { fetchImpl: async () => { throw new Error('offline'); } });
  const row = async (id) => env.DB.prepare('SELECT words, words_v FROM board_files WHERE id = ?').bind(id).first();
  assert.deepEqual({ ...(await row(f.id)) }, { words: null, words_v: -1 }, 'not read: tried again');
  assert.deepEqual({ ...(await row(g.id)) }, { words: null, words_v: -1 });
  await readBoardWords(env);
  await readBoardWords(env);
  assert.equal((await row(f.id)).words_v, -3);
  assert.equal(await readBoardWords(env), 0, 'then let be');
  assert.deepEqual(await wordsStatus(env.DB), { files: 2, read: 0, withWords: 0, failed: 2, toRead: 0 });
  // Back up: a file put in now is read at once, ahead of the ones that failed
  env.AI = ai({ 'agenda.pdf': ['Agenda for the meeting, every item.'] });
  const h = await put(m, 'agenda.pdf', pdf(), { kind: 'agenda' });
  assert.equal(await readBoardWords(env, { limit: 1 }), 1);
  assert.match((await row(h.id)).words, /Agenda for the meeting/);
});

test('the board page gets the words of what it shows only: never a staff-only file, a meeting not shared, or a paper off the page', async () => {
  env.AI = ai({ 'open.pdf': ['Shared minutes'], 'staff.pdf': ['Staff only notes'], 'draft.pdf': ['Draft agenda'], 'Off.pdf': ['A paper off the page'] });
  const shared = await meeting('2025-04-17');
  const hidden = await meeting('2025-05-16', false);
  const open = await put(shared, 'open.pdf', pdf());
  const staff = await put(shared, 'staff.pdf', pdf(), { staffOnly: true });
  const draft = await put(hidden, 'draft.pdf', pdf());
  const off = await saveDoc(env.DB, { title: 'Off', kind: 'other', shared: false }, { by: 'jane@soardcharity.com' });
  const offFile = await putFile(env, { ownerType: 'doc', ownerId: off.id, file: new File([pdf()], 'Off.pdf', { type: 'application/pdf' }), by: 'jane@soardcharity.com' });
  while (await readBoardWords(env, { limit: 10 })) { /* every one read */ }
  const member = await portalWords(env, { member: { slug: 'sam-ortiz', name: 'Sam Ortiz' } });
  assert.deepEqual(Object.keys(member.files), [open.id]);
  assert.equal(member.files[open.id], 'Shared minutes');
  for (const id of [staff.id, draft.id, offFile.id]) assert.ok(!(id in member.files));
  // An admin looking sees the papers off the page (as their Documents does), never the staff-only file or the draft
  const admin = await portalWords(env, {});
  assert.deepEqual(Object.keys(admin.files).sort(), [open.id, offFile.id].sort());
});

test('GET ?words: the words for this viewer’s page, and a few files not read yet are read after', async () => {
  const portal = await import('../functions/api/board-portal.js');
  env.AI = ai({ 'open.pdf': ['Golf tournament sponsorships'] });
  const m = await meeting('2025-04-17');
  const f = await put(m, 'open.pdf', pdf());
  await env.DB.exec("INSERT INTO team (slug, name, \"group\", order_num, data) VALUES ('sam-ortiz', 'Sam Ortiz', 'board', 1, '{\"name\":\"Sam Ortiz\",\"group\":\"board\",\"title\":\"Board Treasurer\"}')");
  const later = [];
  const ctx = (url) => ({ env, request: new Request(url), data: { boardMember: { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam@example.org' } }, waitUntil: (p) => later.push(p) });
  let r = await (await portal.onRequestGet(ctx('https://x/api/board-portal?words'))).json();
  assert.deepEqual(r, { ok: true, files: {}, filings: {}, reading: 1 }, 'nothing read yet, one to read');
  await Promise.all(later);
  r = await (await portal.onRequestGet(ctx('https://x/api/board-portal?words'))).json();
  assert.equal(r.files[f.id], 'Golf tournament sponsorships');
  assert.equal(r.reading, 0);
});

test('without Workers AI’s converter nothing is read, so nothing is kept as having no words', async () => {
  const m = await meeting('2025-04-17');
  const f = await put(m, 'open.pdf', pdf());
  assert.equal(await readBoardWords(env), 0);
  assert.equal((await env.DB.prepare('SELECT words_v FROM board_files WHERE id = ?').bind(f.id).first()).words_v, null);
});

test('the public tax returns and audits are read too, once the board’s own files are, and found by what they say', async () => {
  env.AI = ai({ 'minutes.pdf': ['Minutes words'], '2025 990.pdf': ['Return of Organization Exempt From Income Tax', 'Part VII Compensation of Officers, Directors'] });
  await env.FILES.put('financials/2025 990.pdf', pdf(), {});
  await env.DB.prepare("INSERT INTO site_config (key, data) VALUES ('financials', ?)").bind(JSON.stringify({ documents: [{ title: '2025 990 Tax Return', year: 2025, url: 'https://files.sunshineonaranneyday.com/financials/2025%20990.pdf' }, { title: 'Gone', year: 2020, url: 'https://files.sunshineonaranneyday.com/financials/gone.pdf' }] })).run();
  const m = await meeting('2025-07-24');
  await put(m, 'minutes.pdf', pdf());
  assert.equal(await readBoardWords(env, { limit: 1 }), 1, 'the board’s file first');
  assert.equal((await wordsStatus(env.DB)).toRead, 2, 'two filings still to read');
  assert.equal(await readBoardWords(env, { limit: 5 }), 2);
  assert.equal(await readBoardWords(env, { limit: 5 }), 0, 'each once (one that isn’t in the bucket kept as nothing to read)');
  const page = await portalWords(env, { member: { slug: 'sam-ortiz', name: 'Sam Ortiz' } });
  assert.deepEqual(Object.keys(page.filings), ['/files/financials/2025%20990.pdf'], 'by its address on the board page');
  assert.match(page.filings['/files/financials/2025%20990.pdf'], /Compensation of Officers/);
  assert.deepEqual(await filingWordsFor(env.DB, ['/files/financials/nope.pdf', 'https://elsewhere.example/x.pdf']), {});
});

test('a scan whose pages aren’t photos (a black-and-white fax-style scan) is drawn, then read by its pictures', async () => {
  env.AI = ai({});
  let drawn = 0;
  const draw = async () => { drawn++; return [{ bytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]), type: 'image/jpeg' }]; };
  const r = await wordsOf(env, { name: 'fax.pdf', type: 'application/pdf', bytes: pdf() }, { draw });
  assert.equal(drawn, 1);
  assert.equal(r.how, 'pictures');
  assert.match(r.words, /conflict of interest policy/);
  // Nothing to draw it with (no browser): kept as having no words, never an error to try again
  assert.deepEqual(await wordsOf(env, { name: 'fax.pdf', type: 'application/pdf', bytes: pdf() }, { draw: async () => [] }), { words: '', how: 'none' });
});
