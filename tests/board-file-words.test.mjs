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
import { wordsOf, pdfPages, readBoardWords, wordsStatus, filingWordsFor, joinStrips, READER } from '../functions/api/_board-file-words.js';
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
// A scan of `n` pages, each a JPEG whose fifth byte is its page number (the fake vision model reads it from that)
function scanOf(n) {
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  for (let i = 1; i <= n; i++) {
    const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, i]), Buffer.alloc(64, 7), Buffer.from([0xFF, 0xD9])]);
    parts.push(Buffer.from(`${i} 0 obj\n<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'), jpeg, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  parts.push(Buffer.from('%%EOF', 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
const pageOf = (input) => Buffer.from(input.messages[1].content[1].image_url.url.split(',')[1], 'base64')[4];

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
  async run(model, input) { this.calls.vision++; assert.match(model, /mistral-small/); assert.match(input.messages[1].content[1].image_url.url, /^data:image\/(jpeg|png);base64,/); return { response: 'MINUTES OF THE BOARD\nThe board approved the conflict of interest policy.' }; },
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

test('a page Mistral sees no words on gets a second look by Llama 4 Scout; a blank one is blank to both', async () => {
  const asked = [];
  env.AI = { async run(model) { asked.push(model.split('/').pop()); return { response: /scout/.test(model) ? 'Form W-9 Request for Taxpayer Identification Number' : '' }; } };
  const r = await wordsOf(env, { name: 'w9 page.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xFF, 0xD8, 0xFF]) });
  assert.equal(r.how, 'pictures');
  assert.match(r.words, /Form W-9/);
  assert.deepEqual(asked, ['mistral-small-3.1-24b-instruct', 'llama-4-scout-17b-16e-instruct']);
  // One Mistral reads: never asked twice
  asked.length = 0;
  env.AI = { async run(model) { asked.push(model); return { response: 'Treasurer report' }; } };
  await wordsOf(env, { name: 'chart.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xFF, 0xD8, 0xFF]) });
  assert.equal(asked.length, 1);
  // Blank to both
  env.AI = { async run() { return { response: '' }; } };
  assert.deepEqual(await wordsOf(env, { name: 'photo.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xFF, 0xD8, 0xFF]) }), { words: '', how: 'none' });
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
  const st = await wordsStatus(env.DB);
  assert.deepEqual({ ...st, lastAt: undefined }, { files: 3, read: 3, withWords: 3, failed: 0, toRead: 0, lastAt: undefined });
  assert.ok(Date.now() - Date.parse(st.lastAt) < 60000, 'when the last was read (Automations says when reading stops)');
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
  // (one that couldn't be read is tried at the start of a run of its own: one a run)
  for (let i = 0; i < 4; i++) await readBoardWords(env);
  assert.equal((await row(f.id)).words_v, -3);
  assert.equal((await row(g.id)).words_v, -3);
  assert.equal(await readBoardWords(env), 0, 'then let be');
  assert.deepEqual(await wordsStatus(env.DB), { files: 2, read: 0, withWords: 0, failed: 2, toRead: 0, lastAt: null });
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
  // The browser there but not to be had just then (the site's other work has it): tried again later
  const busy = { launch: async () => { throw new Error('Browser limit reached'); } };
  assert.deepEqual(await wordsOf(env, { name: 'W-9.pdf', type: 'application/pdf', bytes: pdf() }, { ctx: busy }), { words: '', how: 'error' });
});

test('a long scan is read a few pages a run (a dense page takes the vision model ~20 s, a run has ~27), kept as it goes, and goes on first until every page is read', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const seen = [];
  env.AI = {
    async toMarkdown(doc) { return { format: 'markdown', data: doc.name === 'Agenda.pdf' ? '### Page 1\nAgenda for the annual meeting of the board, every item in order.' : '### Page 1\n' }; },
    async run(model, input) { assert.match(model, /mistral-small/); const p = pageOf(input); seen.push(p); clock += 5000; return { response: `Bylaws page ${p}: Article ${p} of the Board` }; },
  };
  const m = await meeting('2024-04-25');
  const f = await put(m, 'Signed Amended Bylaws.pdf', scanOf(10));
  const row = (id = f.id) => env.DB.prepare('SELECT words, words_v, words_next, words_try FROM board_files WHERE id = ?').bind(id).first();
  assert.equal(await readBoardWords(env, { now }), 1);
  let r = await row();
  assert.equal(r.words_next, 4, 'a group of four pages, then no time for another');
  assert.equal(r.words.split('\f').length, 4);
  assert.match(r.words.split('\f')[3], /page 4/);
  assert.equal(r.words_v, 0, 'read in part: not a try that failed');
  assert.equal(r.words_try, null, 'let go');
  // A newer file comes in: the scan under way goes on first
  await new Promise((res) => setTimeout(res, 5));
  const g = await put(m, 'Agenda.pdf', pdf());
  clock += 60000;
  assert.equal(await readBoardWords(env, { now, limit: 1 }), 1);
  assert.equal((await row()).words_next, 8);
  assert.equal((await row(g.id)).words_v, null, 'the agenda waits for the scan');
  clock += 60000;
  await readBoardWords(env, { now, limit: 1 });
  r = await row();
  assert.equal(r.words_v, READER);
  assert.equal(r.words_next, null);
  const pages = r.words.split('\f');
  assert.equal(pages.length, 10, 'every page, each its own');
  assert.match(pages[6], /page 7/);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'each page read once, never converted again');
  assert.equal(await readBoardWords(env, { now }), 1);
  assert.match((await row(g.id)).words, /Agenda for the annual meeting/);
});

test('a try counts as it starts: a run Cloudflare cuts short leaves its file held a minute, then it’s tried again; two runs at once never read one file', async () => {
  let clock = 5_000_000;
  const now = () => clock;
  env.AI = ai({ 'minutes.pdf': ['Minutes of the annual meeting'], 'agenda.pdf': ['Agenda of the annual meeting'] });
  const m = await meeting('2025-07-24');
  const a = await put(m, 'minutes.pdf', pdf());
  await new Promise((res) => setTimeout(res, 5));
  const b = await put(m, 'agenda.pdf', pdf());
  // Cut short while reading the agenda (the newest): nothing after its try is written
  const real = env.FILES.get;
  env.FILES.get = async () => { throw new Error('cut short'); };
  await readBoardWords(env, { now });
  env.FILES.get = real;
  const row = (id) => env.DB.prepare('SELECT words_v, words_try FROM board_files WHERE id = ?').bind(id).first();
  assert.deepEqual({ ...(await row(b.id)) }, { words_v: -1, words_try: clock }, 'its try counted, and held');
  clock += 30000;
  assert.equal(await readBoardWords(env, { now }), 1, 'within the minute: the other one');
  assert.equal((await row(a.id)).words_v, READER);
  assert.equal((await row(b.id)).words_v, -1);
  clock += 31000;
  assert.equal(await readBoardWords(env, { now }), 1);
  assert.equal((await row(b.id)).words_v, READER);
  // The heartbeat and a visit at once: each file read by one of them
  const c = await put(m, 'c.pdf', pdf());
  const d = await put(m, 'd.pdf', pdf());
  env.AI = ai({ 'c.pdf': ['Treasurer report for the quarter'], 'd.pdf': ['Chair report for the quarter'] });
  const [x, y] = await Promise.all([readBoardWords(env, { now }), readBoardWords(env, { now })]);
  assert.equal(x + y, 2);
  assert.equal(env.AI.calls.markdown, 2, 'never twice');
  for (const id of [c.id, d.id]) assert.equal((await row(id)).words_v, READER);
});

test('a scan’s page the vision model can’t read twice is left out, the rest read, and each page keeps its number', async () => {
  env.AI = {
    async toMarkdown() { return { format: 'markdown', data: '### Page 1\n' }; },
    async run(model, input) { const p = pageOf(input); if (p === 2) throw new Error('busy'); return { response: `Page ${p} words` }; },
  };
  const m = await meeting('2016-03-01');
  const f = await put(m, 'old minutes.pdf', scanOf(3));
  for (let i = 0; i < 4; i++) await readBoardWords(env);
  const r = await env.DB.prepare('SELECT words, words_v, words_next FROM board_files WHERE id = ?').bind(f.id).first();
  assert.equal(r.words_v, READER);
  assert.equal(r.words_next, null);
  assert.deepEqual(r.words.split('\f'), ['Page 1 words', '', 'Page 3 words']);
});

test('nothing is started that can’t end in the run’s time, and a file not given the time isn’t a try', async () => {
  let clock = 7_000_000;
  const now = () => clock;
  env.AI = {
    async toMarkdown() { clock += 20000; return { format: 'markdown', data: '### Page 1\n' }; },
    async run() { clock += 5000; return { response: 'A page' }; },
  };
  const m = await meeting('2017-05-01');
  const f = await put(m, 'scan.pdf', scanOf(2));
  // Its converter took 20 s of the run's 27: known as a scan, its pages left for the next run, no try counted
  assert.equal(await readBoardWords(env, { now }), 1);
  let r = await env.DB.prepare('SELECT words_v, words_next, words_try FROM board_files WHERE id = ?').bind(f.id).first();
  assert.deepEqual({ ...r }, { words_v: 0, words_next: 0, words_try: null });
  clock += 60000;
  await readBoardWords(env, { now });
  r = await env.DB.prepare('SELECT words, words_v FROM board_files WHERE id = ?').bind(f.id).first();
  assert.equal(r.words_v, READER);
  assert.equal(r.words, 'A page\fA page');
  // A page that couldn't be read when it started late in a run isn't a try; with the run's whole time, it is
  env.AI = {
    async toMarkdown() { clock += 12000; return { format: 'markdown', data: '### Page 1\n' }; },
    async run() { throw new Error('timeout'); },
  };
  const late = await put(m, 'late scan.pdf', scanOf(1));
  const lateRow = () => env.DB.prepare('SELECT words_v, words_next FROM board_files WHERE id = ?').bind(late.id).first();
  await readBoardWords(env, { now });
  assert.deepEqual({ ...(await lateRow()) }, { words_v: 0, words_next: 0 }, 'started with 15 s left: not a try');
  clock += 60000;
  await readBoardWords(env, { now });
  assert.deepEqual({ ...(await lateRow()) }, { words_v: -1, words_next: 0 }, 'the whole run: a try');
  await env.DB.prepare('DELETE FROM board_files WHERE id = ?').bind(late.id).run();
  // A picture with too little of the run left waits, untried
  env.AI = { async toMarkdown() { return { format: 'markdown', data: '' }; }, async run() { return { response: 'Chart words' }; } };
  const pic = await put(m, 'chart.png', new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]), { type: 'image/png', kind: 'other' });
  assert.equal(await readBoardWords(env, { now, windowMs: 5000 }), 0, 'started with too little time: nothing');
  assert.equal((await env.DB.prepare('SELECT words_v FROM board_files WHERE id = ?').bind(pic.id).first()).words_v, null);
});

// A JPEG whose fifth byte is its page and sixth its strip (the fake vision model reads them)
const jpegOf = (page, strip = 0) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, page, strip, 0xFF, 0xD9]);
const stripOf = (input) => Buffer.from(input.messages[1].content[1].image_url.url.split(',')[1], 'base64')[5];

test('a scan that’s only partly photos (a 990 with two of its pages as photos) is drawn, every page, a group at a time', async () => {
  // Six pages; one of them a photo
  const photo = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 9]), Buffer.alloc(64, 7), Buffer.from([0xFF, 0xD9])]);
  const pdfBytes = new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 6 >> endobj\n' + [2, 3, 4, 5, 6, 7].map((i) => `${i} 0 obj << /Type /Page /Parent 1 0 R >> endobj\n`).join('') + '8 0 obj\n<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 /Filter /DCTDecode /Length 71 >>\nstream\n', 'latin1'), photo, Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')]));
  const drawn = [];
  const draw = async (bytes, { from, max }) => { drawn.push([from, max]); return { pics: Array.from({ length: Math.min(max, 6 - from) }, (_, i) => ({ bytes: jpegOf(from + i + 1), type: 'image/jpeg' })), total: 6 }; };
  env.AI = { async toMarkdown() { return { format: 'markdown', data: '### Page 1\n' }; }, async run(model, input) { return { response: `Form 990 page ${pageOf(input)}` }; } };
  const r = await wordsOf(env, { name: '2025 990.pdf', type: 'application/pdf', bytes: pdfBytes }, { draw });
  assert.equal(r.how, 'pictures');
  assert.deepEqual(r.words.split('\f'), [1, 2, 3, 4, 5, 6].map((p) => `Form 990 page ${p}`), 'every page, in order, never the one photo alone');
  assert.deepEqual(drawn, [[0, 4], [4, 4]]);
});

test('a page dense with words is read in strips at once (a scan’s every page in two; a big screenshot in two, then three, then four), joined where they meet', async () => {
  const cuts = [];
  const cut = async (image, n) => { cuts.push(n); return Array.from({ length: n }, (_, k) => ({ bytes: jpegOf(image.bytes[4], k), type: 'image/jpeg' })); };
  // Each strip has its own lines and the next strip's first (where they run into each other)
  env.AI = { async toMarkdown() { return { format: 'markdown', data: '### Page 1\n' }; }, async run(model, input) { const p = pageOf(input); const k = stripOf(input); return { response: `Page ${p} row ${k * 2 + 1}\nPage ${p} row ${k * 2 + 2}\nPage ${p} row ${k * 2 + 3}` }; } };
  const scan = await wordsOf(env, { name: 'minutes scan.pdf', type: 'application/pdf', bytes: scanOf(2) }, { cut });
  assert.deepEqual(cuts, [2, 2], 'each page in two');
  assert.equal(scan.words, 'Page 1 row 1\nPage 1 row 2\nPage 1 row 3\nPage 1 row 4\nPage 1 row 5\fPage 2 row 1\nPage 2 row 2\nPage 2 row 3\nPage 2 row 4\nPage 2 row 5', 'the row both strips have kept once');
  // A screenshot of a store's sales (a big PNG): in two; once it couldn't be read, three, then four
  const big = new Uint8Array(400 * 1024);
  big.set([0x89, 0x50, 0x4E, 0x47, 4, 0]);
  cuts.length = 0;
  for (const tries of [0, 1, 2]) await wordsOf(env, { name: 'Stores TY YTD.png', type: 'image/png', bytes: big }, { cut, tries });
  assert.deepEqual(cuts, [2, 3, 4]);
  // A small picture whole
  cuts.length = 0;
  await wordsOf(env, { name: 'chart.png', type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 5, 0]) }, { cut });
  assert.deepEqual(cuts, []);
  // No browser to cut with: read whole
  assert.match((await wordsOf(env, { name: 'Stores LY.png', type: 'image/png', bytes: big })).words, /Page 4 row 1/);
});

test('strips joined: a line two strips both have where they meet is kept once, and nothing else is lost', () => {
  assert.equal(joinStrips(['Total sales\nStore 1 $4,200\nStore 2 $3,100', 'Store 2 $3,100\nStore 3 $2,900\nTotal $10,200']), 'Total sales\nStore 1 $4,200\nStore 2 $3,100\nStore 3 $2,900\nTotal $10,200');
  assert.equal(joinStrips(['A', '', 'B']), 'A\nB');
  assert.equal(joinStrips(['Store 1 $4,200', 'Store 1 $4,200 (returns)']), 'Store 1 $4,200\nStore 1 $4,200 (returns)', 'a line only like one kept');
});

test('while the board’s files are only being read again by a newer reader, a filing nobody can find yet is read each run too', async () => {
  env.AI = ai({ 'minutes.pdf': ['Minutes words'], '2024 990.pdf': ['Return of Organization Exempt From Income Tax'] });
  await env.FILES.put('financials/2024 990.pdf', pdf(), {});
  await env.DB.prepare("INSERT INTO site_config (key, data) VALUES ('financials', ?)").bind(JSON.stringify({ documents: [{ title: '2024 990', url: 'https://files.sunshineonaranneyday.com/financials/2024%20990.pdf' }] })).run();
  const m = await meeting('2025-07-24');
  const f = await put(m, 'minutes.pdf', pdf());
  // Read by an older reader: words there, being read again
  await env.DB.prepare("UPDATE board_files SET words = 'Minutes words', words_v = ? WHERE id = ?").bind(READER - 1, f.id).run();
  assert.equal(await readBoardWords(env, { limit: 1 }), 2, 'the filing, then the board’s file');
  assert.match((await filingWordsFor(env.DB, ['/files/financials/2024%20990.pdf']))['/files/financials/2024%20990.pdf'], /Exempt From Income Tax/);
});

test('a file an older reader gave up on is tried afresh by a newer one, three times, then let be until the next', async () => {
  env.AI = { async toMarkdown() { throw new Error('converter down'); } };
  const m = await meeting('2024-04-25');
  const f = await put(m, 'Q3 Totals.pdf', pdf());
  await env.DB.prepare('UPDATE board_files SET words_v = -3, words_fail = ? WHERE id = ?').bind(READER - 1, f.id).run();
  const row = () => env.DB.prepare('SELECT words, words_v, words_fail FROM board_files WHERE id = ?').bind(f.id).first();
  assert.equal((await wordsStatus(env.DB)).failed, 0, 'not this reader’s to give up on');
  assert.equal((await wordsStatus(env.DB)).toRead, 1);
  await readBoardWords(env);
  assert.deepEqual({ ...(await row()) }, { words: null, words_v: -1, words_fail: READER }, 'its count started again');
  await readBoardWords(env);
  await readBoardWords(env);
  assert.equal((await row()).words_v, -3);
  assert.equal(await readBoardWords(env), 0, 'then let be');
  assert.equal((await wordsStatus(env.DB)).failed, 1);
  // Read by this reader once Workers AI is back? Only by a newer one; a file given up on by an older one with words read now
  await env.DB.prepare('UPDATE board_files SET words_fail = NULL WHERE id = ?').bind(f.id).run();
  env.AI = ai({ 'Q3 Totals.pdf': ['Q3 totals for both stores'] });
  assert.equal(await readBoardWords(env), 1);
  assert.equal((await row()).words, 'Q3 totals for both stores');
});
