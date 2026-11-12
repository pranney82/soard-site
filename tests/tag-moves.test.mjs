/**
 * The old tags moved onto the new ones (functions/api/_tag-rules.js, _tag-moves.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { docPick, oldStage, moveFor, isRetiring } from '../functions/api/_tag-rules.js';
import { maybeMoveTags, movesFacts } from '../functions/api/_tag-moves.js';
import { tiff, jpeg } from './lib/exif-fixtures.mjs';

test('which tags retire: the old ones and the ":" tags; In Kind, COI, W-9 and the new ones stay', () => {
  for (const n of ['.BeforePics', 'Progress Photos', ':Blue Tape', ':MEPs', '_Sponsor', '.BuildSpecDocs', '.WorkingPlans', '.FinalPlans', 'Design Documents', '.PricingQuotes', '_MakeoverFamily']) assert.ok(isRetiring(n), n);
  for (const n of ['In Kind', 'COI', 'W-9', 'Before', 'Costs', 'Plans']) assert.ok(!isRetiring(n), n);
});

test('a document’s tag: private papers never, then Costs, Design, Plans, then the old tag’s meaning', () => {
  assert.equal(docPick({ name: 'Consent form signed.pdf' }, ['.FinalPlans']).tag, null);
  assert.equal(docPick({ name: 'W9 Acme.pdf' }).tag, null);
  assert.equal(docPick({ name: 'scan001.pdf', createdBy: 'QuickBooks Online' }).tag, 'Costs');
  assert.equal(docPick({ name: 'x.pdf', documentType: 'vendorBill' }).tag, 'Costs');
  assert.equal(docPick({ name: 'Tile estimate.pdf' }).tag, 'Costs');
  assert.equal(docPick({ name: 'Mood board.png' }).tag, 'Design');
  assert.equal(docPick({ name: 'Electrical spec sheet.pdf' }).tag, 'Plans');
  assert.equal(docPick({ name: 'Letter template.docx' }).tag, 'Plans', 'a letter template is a template, not a letter');
  assert.deepEqual(docPick({ name: 'IMG_2231.pdf' }, ['.BuildSpecDocs']), { tag: 'Plans', why: 'was on .BuildSpecDocs' });
  assert.equal(docPick({ name: 'IMG_2231.pdf' }, ['.PricingQuotes']).tag, 'Costs');
  assert.equal(docPick({ name: 'IMG_2231.pdf' }, ['_Sponsor']).tag, null);
  assert.equal(oldStage(['.BeforePics']).tag, 'Before');
  assert.equal(oldStage([':PostDrywall']).tag, 'During');
  assert.equal(oldStage(['_Sponsor']).tag, null);
  // Found in the trial (Nov 11): a kid's résumé, RENDR scans, .plan files, a design consult
  assert.equal(docPick({ name: 'Axel’s Resume.pdf' }, ['.BuildSpecDocs']).tag, 'Design', 'what the designer designs from');
  assert.equal(docPick({ name: 'Dylan Résumé.pdf' }).tag, 'Design');
  assert.equal(docPick({ name: 'RENDR: Bathroom PDF' }).tag, 'Plans');
  assert.equal(docPick({ name: 'Oct 20, 2023 at 11-29-30 AM.plan' }).tag, 'Plans');
  assert.equal(docPick({ name: 'LIZZIE DESIGN CONSULT.pdf' }).tag, 'Design');
  assert.equal(docPick({ name: 'Adrian 2025_Selections Placement.PNG' }).tag, 'Design');
  assert.equal(docPick({ name: 'Design Agreement signed.pdf' }).tag, null, 'a private paper first');
  assert.equal(docPick({ name: 'Designer invoice 4.pdf' }).tag, 'Costs', 'a cost first');
});

test('a move: the new tag on, the old tags off; families keep their papers and nothing else; a file nothing places comes off its old tags', () => {
  const tags = [{ id: 'bp', name: '.BeforePics' }, { id: 'mf', name: '_MakeoverFamily' }, { id: 'ik', name: 'In Kind' }];
  assert.deepEqual(moveFor({ name: 'IMG_1.jpg', kind: 'photo', tags }, { tag: 'Before' }), { add: 'Before', remove: ['bp', 'mf'], keepFamily: false });
  const paper = moveFor({ name: 'Summary Letter.pdf', kind: 'doc', tags: [{ id: 'mf', name: '_MakeoverFamily' }, { id: 'sp', name: '_Sponsor' }] }, { tag: null });
  assert.deepEqual(paper.remove, ['sp'], 'a private paper comes off _Sponsor and stays the family’s');
  assert.deepEqual(moveFor({ name: 'scan.pdf', kind: 'doc', tags: [{ id: 'sp', name: '_Sponsor' }, { id: 'ik', name: 'In Kind' }] }, { tag: null }).remove, ['sp'], 'nothing places it: off the old tag (staff only) and listed; In Kind stays');
});

// A small JobTread: tags and their files, and the files' bytes
function world({ extra = [], failing = [] } = {}) {
  const files = [
    { id: 'p1', name: 'IMG_1.JPG', type: 'image/jpeg', job: 'j1', tags: [{ id: 'bp', name: '.BeforePics' }], bytes: jpeg(tiff({ lat: 1, lng: 1, taken: '2026:03:05 10:00:00' })) },
    { id: 'p2', name: 'IMG_2.PNG', type: 'image/png', job: 'j1', tags: [{ id: 'bp', name: '.BeforePics' }], bytes: new Uint8Array(12) },
    { id: 'd1', name: 'Final plan set.pdf', type: 'application/pdf', job: 'j1', tags: [{ id: 'fp', name: '.FinalPlans' }] },
    { id: 'd2', name: 'Summary Letter.pdf', type: 'application/pdf', job: 'j1', tags: [{ id: 'fp', name: '.FinalPlans' }] },
    { id: 'l1', name: 'IMG_9.JPG', type: 'image/jpeg', job: 'j1', dailyLog: true, tags: [{ id: 'bp', name: '.BeforePics' }] },
    ...extra,
  ];
  const tags = [{ id: 'bp', name: '.BeforePics' }, { id: 'fp', name: '.FinalPlans' }, { id: 'sp', name: '_Sponsor' }, { id: 'wp', name: '.WorkingPlans' }, { id: 'ik', name: 'In Kind' }, { id: 'tB', name: 'Before' }];
  const w = { writes: [], deleted: [], reads: [] };
  w.fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://cdn.example.com/')) {
      const id = u.split('/').pop();
      w.reads.push(id);
      if (failing.includes(id)) return new Response('busy', { status: 503 });
      const f = files.find((x) => x.id === id);
      return new Response(f?.bytes || new Uint8Array(4), { status: 206 });
    }
    const q = JSON.parse(init.body).query;
    if (q.organization?.fileTags) return Response.json({ organization: { fileTags: { nodes: tags.filter((t) => !w.deleted.includes(t.id)) } } });
    if (q.fileTag?.f && q.fileTag.f.$.size === 1) return Response.json({ fileTag: { f: { count: files.filter((f) => f.tags.some((t) => t.id === q.fileTag.$.id)).length } } });
    if (q.fileTag?.f) {
      const on = files.filter((f) => f.tags.some((t) => t.id === q.fileTag.$.id));
      return Response.json({ fileTag: { f: { nextPage: null, nodes: on.map((f) => ({ id: f.id, name: f.name, type: f.type, job: { id: f.job }, dailyLog: f.dailyLog ? { id: 'dl' } : null, document: null, createdByUser: { name: 'Clareece' }, url: `https://cdn.example.com/${f.id}`, fileTags: { nodes: f.tags } })) } } });
    }
    if (q.job?.demo) return Response.json({ job: { id: 'j1', name: 'Ava (2026)', closedOn: null, customFieldValues: { nodes: [{ value: 'Building' }] }, demo: { nodes: [{ startDate: '2026-03-02' }] }, reveal: { nodes: [{ startDate: '2026-03-20' }] } } });
    if (q.updateFile) { w.writes.push(q.updateFile.$); const f = files.find((x) => x.id === q.updateFile.$.id); f.tags = q.updateFile.$.fileTagIds.map((id) => tags.find((t) => t.id === id) || { id, name: id }); return Response.json({}); }
    if (q.deleteFileTag) { w.deleted.push(q.deleteFileTag.$.id); return Response.json({}); }
    throw new Error(`unexpected ${JSON.stringify(q).slice(0, 80)}`);
  };
  return { w, files };
}
const env = async () => {
  const e = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), JOBTREAD_GRANT_KEY: 'k' };
  await e.DB.prepare('CREATE TABLE IF NOT EXISTS file_tags (name TEXT PRIMARY KEY, id TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
  for (const [n, id] of [['Before', 'tB'], ['During', 'tD'], ['After', 'tA'], ['Plans', 'tP'], ['Costs', 'tC'], ['Design', 'tG']]) await e.DB.prepare('INSERT INTO file_tags VALUES (?, ?, ?)').bind(n, id, 'x').run();
  return e;
};
const T = Date.parse('2026-11-11T23:00:00Z');

test('writing off: every move is planned and counted, nothing written', async () => {
  const e = await env();
  const { w } = world();
  for (let i = 0; i < 4; i++) await maybeMoveTags(e, { fetchImpl: w.fetchImpl, now: T + i * 3 * 60 * 1000, write: false });
  const rows = Object.fromEntries((await e.DB.prepare('SELECT file_id, add_tag, why FROM tag_moves').all()).results.map((r) => [r.file_id, [r.add_tag, r.why]]));
  assert.deepEqual(rows.p1, ['During', 'from the Demo date, before reveal day'], 'dated: by its time, not its old tag');
  assert.deepEqual(rows.p2, ['Before', 'was on .BeforePics'], 'undated: by its old tag');
  assert.deepEqual(rows.d1, ['Plans', 'named like plans']);
  assert.deepEqual(rows.d2, [null, 'a private paper']);
  assert.deepEqual(rows.l1, ['Before', 'was on .BeforePics'], 'a daily log’s file moves like any other');
  assert.deepEqual(w.writes, []);
  const facts = await movesFacts(e.DB);
  assert.equal(facts.write, true, 'writing is on');
  assert.deepEqual([facts.files, facts.written], [5, 0]);
});

test('writing on: files move, a private paper comes off the sharing tag, and an old tag left empty is deleted', async () => {
  const e = await env();
  const { w, files } = world();
  // Each tag's page is read again after files move off it, until nothing on it moves; then the next tag
  for (let i = 0; i < 8; i++) await maybeMoveTags(e, { fetchImpl: w.fetchImpl, now: T + i * 3 * 60 * 1000, write: true });
  const tagsOf = (id) => files.find((f) => f.id === id).tags.map((t) => t.id).sort();
  assert.deepEqual(tagsOf('p1'), ['tD']);
  assert.deepEqual(tagsOf('p2'), ['tB']);
  assert.deepEqual(tagsOf('d1'), ['tP']);
  assert.deepEqual(tagsOf('d2'), [], 'the private paper is off .FinalPlans and on nothing');
  assert.deepEqual(tagsOf('l1'), ['tB'], 'the daily log’s file moved too');
  assert.ok(w.deleted.includes('fp'), '.FinalPlans, now empty, is deleted');
  assert.ok(w.deleted.includes('bp'), '.BeforePics, now empty, is deleted');
  assert.ok(!w.deleted.includes('ik'), 'In Kind is never touched');
});

test('found in the trial: a design board saved as a picture goes to Design, an unplaced file comes off its old tag, a photo that can’t be read waits', async () => {
  const e = await env();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  const { w, files } = world({ extra: [
    { id: 'g1', name: 'Harper’s Design Board.png', type: 'image/png', job: 'j1', tags: [{ id: 'sp', name: '_Sponsor' }, { id: 'wp', name: '.WorkingPlans' }], bytes: png },
    { id: 'g2', name: 'Adrian 2025_Selections.PNG', type: 'image/png', job: 'j1', tags: [{ id: 'wp', name: '.WorkingPlans' }], bytes: png },
    { id: 'g3', name: 'IMG_0178.png', type: 'image/png', job: 'j1', tags: [{ id: 'wp', name: '.WorkingPlans' }], bytes: png },
    { id: 'x1', name: 'BLANK What to Expect on Demo Day.pdf', type: 'application/pdf', job: 'j1', tags: [{ id: 'sp', name: '_Sponsor' }, { id: 'ik', name: 'In Kind' }] },
    { id: 'r1', name: 'IMG_77.JPG', type: 'image/jpeg', job: 'j1', tags: [{ id: 'sp', name: '_Sponsor' }] },
  ], failing: ['r1'] });
  for (let i = 0; i < 8; i++) await maybeMoveTags(e, { fetchImpl: w.fetchImpl, now: T + i * 3 * 60 * 1000, write: true });
  const tagsOf = (id) => files.find((f) => f.id === id).tags.map((t) => t.id).sort();
  assert.deepEqual(tagsOf('g1'), ['tG'], 'named like a design');
  assert.deepEqual(tagsOf('g2'), ['tG']);
  assert.deepEqual(tagsOf('g3'), ['tG'], 'undated, unnamed: its old tag’s meaning');
  assert.deepEqual(tagsOf('x1'), ['ik'], 'nothing places it: staff only, In Kind kept');
  assert.deepEqual(tagsOf('r1'), ['sp'], 'couldn’t be read and nothing else places it: waits, keeps its tag');
  assert.ok(!w.deleted.includes('sp'), '_Sponsor isn’t empty yet');
  assert.ok(w.deleted.includes('wp'));
  const why = (await e.DB.prepare("SELECT why FROM tag_moves WHERE file_id = 'r1'").first('why'));
  assert.equal(why, 'couldn’t be read yet');
});

test('a time read on an earlier pass isn’t read again', async () => {
  const e = await env();
  const { w } = world();
  // Three passes over the four tags
  for (let i = 0; i < 12; i++) await maybeMoveTags(e, { fetchImpl: w.fetchImpl, now: T + i * 3 * 60 * 1000, write: false });
  assert.equal((await movesFacts(e.DB)).passes, 3);
  assert.equal(w.reads.filter((id) => id === 'p1').length, 1, 'p1 (dated) read once');
  assert.equal(w.reads.filter((id) => id === 'p2').length, 3, 'p2 (no time in it) read each pass: nothing to remember');
});

test('the family keeps any paper, a picture of one too, and any document nothing places; photos and placed files come off their tag', () => {
  const mf = { id: 'mf', name: '_MakeoverFamily' };
  assert.deepEqual(moveFor({ name: 'Leland 2025_Signed Layout.jpg', kind: 'photo', tags: [mf] }, { tag: null }).remove, [], 'a picture of a signed paper stays theirs');
  assert.deepEqual(moveFor({ name: 'XLX5wNrp.pdf', kind: 'doc', tags: [mf] }, { tag: null }).remove, [], 'a document nothing places keeps their access');
  assert.deepEqual(moveFor({ name: 'Final Layout.pdf', kind: 'doc', tags: [mf] }, { tag: 'Design' }).remove, ['mf'], 'a design comes off');
  assert.deepEqual(moveFor({ name: 'IMG_44.HEIC', kind: 'photo', tags: [mf] }, { tag: null }).remove, ['mf'], 'a photo comes off even undated');
  assert.deepEqual(moveFor({ name: 'Scope of Work.pdf', kind: 'doc', tags: [mf, { id: 'sp', name: '_Sponsor' }] }, { tag: null }).remove, ['sp'], 'the scope stays theirs, off _Sponsor');
});
