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
});

test('a move: the new tag on, the old tags off; families keep their papers and nothing else; a file nothing places keeps its tags', () => {
  const tags = [{ id: 'bp', name: '.BeforePics' }, { id: 'mf', name: '_MakeoverFamily' }, { id: 'ik', name: 'In Kind' }];
  assert.deepEqual(moveFor({ name: 'IMG_1.jpg', kind: 'photo', tags }, { tag: 'Before' }), { add: 'Before', remove: ['bp', 'mf'], keepFamily: false });
  const paper = moveFor({ name: 'Summary Letter.pdf', kind: 'doc', tags: [{ id: 'mf', name: '_MakeoverFamily' }, { id: 'sp', name: '_Sponsor' }] }, { tag: null });
  assert.deepEqual(paper.remove, ['sp'], 'a private paper comes off _Sponsor and stays the family’s');
  assert.deepEqual(moveFor({ name: 'scan.pdf', kind: 'doc', tags: [{ id: 'sp', name: '_Sponsor' }] }, { tag: null }).remove, [], 'nothing places it: listed, tags kept');
});

// A small JobTread: tags and their files, and the files' bytes
function world() {
  const files = [
    { id: 'p1', name: 'IMG_1.JPG', type: 'image/jpeg', job: 'j1', tags: [{ id: 'bp', name: '.BeforePics' }], bytes: jpeg(tiff({ lat: 1, lng: 1, taken: '2026:03:05 10:00:00' })) },
    { id: 'p2', name: 'IMG_2.PNG', type: 'image/png', job: 'j1', tags: [{ id: 'bp', name: '.BeforePics' }], bytes: new Uint8Array(12) },
    { id: 'd1', name: 'Final plan set.pdf', type: 'application/pdf', job: 'j1', tags: [{ id: 'fp', name: '.FinalPlans' }] },
    { id: 'd2', name: 'Summary Letter.pdf', type: 'application/pdf', job: 'j1', tags: [{ id: 'fp', name: '.FinalPlans' }] },
    { id: 'l1', name: 'IMG_9.JPG', type: 'image/jpeg', job: 'j1', dailyLog: true, tags: [{ id: 'bp', name: '.BeforePics' }] },
  ];
  const tags = [{ id: 'bp', name: '.BeforePics' }, { id: 'fp', name: '.FinalPlans' }, { id: 'ik', name: 'In Kind' }, { id: 'tB', name: 'Before' }];
  const w = { writes: [], deleted: [] };
  w.fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://cdn.example.com/')) { const f = files.find((x) => x.id === u.split('/').pop()); return new Response(f?.bytes || new Uint8Array(4), { status: 206 }); }
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
  await maybeMoveTags(e, { fetchImpl: w.fetchImpl, now: T });
  await maybeMoveTags(e, { fetchImpl: w.fetchImpl, now: T + 3 * 60 * 1000 });
  const rows = Object.fromEntries((await e.DB.prepare('SELECT file_id, add_tag, why FROM tag_moves').all()).results.map((r) => [r.file_id, [r.add_tag, r.why]]));
  assert.deepEqual(rows.p1, ['During', 'from the Demo date, before reveal day'], 'dated: by its time, not its old tag');
  assert.deepEqual(rows.p2, ['Before', 'was on .BeforePics'], 'undated: by its old tag');
  assert.deepEqual(rows.d1, ['Plans', 'named like plans']);
  assert.deepEqual(rows.d2, [null, 'a private paper']);
  assert.deepEqual(rows.l1, [null, 'a daily log’s file (left as it is)']);
  assert.deepEqual(w.writes, []);
  const facts = await movesFacts(e.DB);
  assert.equal(facts.write, false);
  assert.equal(facts.files, 5);
});

test('writing on: files move, a private paper comes off the sharing tag, and an old tag left empty is deleted', async () => {
  const e = await env();
  const { w, files } = world();
  for (let i = 0; i < 4; i++) await maybeMoveTags(e, { fetchImpl: w.fetchImpl, now: T + i * 3 * 60 * 1000, write: true });
  const tagsOf = (id) => files.find((f) => f.id === id).tags.map((t) => t.id).sort();
  assert.deepEqual(tagsOf('p1'), ['tD']);
  assert.deepEqual(tagsOf('p2'), ['tB']);
  assert.deepEqual(tagsOf('d1'), ['tP']);
  assert.deepEqual(tagsOf('d2'), [], 'the private paper is off .FinalPlans and on nothing');
  assert.deepEqual(tagsOf('l1'), ['bp'], 'the daily log’s file is left as it is');
  assert.ok(w.deleted.includes('fp'), '.FinalPlans, now empty, is deleted');
  assert.ok(!w.deleted.includes('bp'), '.BeforePics still has the daily log’s file');
  assert.ok(!w.deleted.includes('ik'), 'In Kind is never touched');
});
