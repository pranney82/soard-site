/**
 * Community projects admin: the rules shared by the admin, Preview and the
 * pages (public/admin/community-shared.js, mirrored by src/utils/community.ts),
 * reordering the Community page in one request (functions/api/reorder-content.js),
 * history (functions/api/content-history.js) and the writing helpers
 * (functions/api/generate.js).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createD1 } from './lib/d1-shim.mjs';
import { reorder } from '../functions/api/reorder-content.js';
import { onRequestPost as generate } from '../functions/api/generate.js';
import { onRequestGet as historyGet } from '../functions/api/content-history.js';
import { recordVersion, recordDeletion } from '../functions/api/_content-history.js';
import { photoFocusMap } from '../scripts/d1-helpers.js';
import * as CS from '../public/admin/community-shared.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
const project = (over = {}) => ({
  name: 'Camp Joy', slug: 'camp-joy', year: '2024', status: 'completed', order: 1,
  stats: [{ value: '1,200', label: 'children served each year' }], impact: '1,200', impactLabel: 'children served each year',
  description: 'Camp Joy serves children with disabilities. SOARD renovated its lodge.',
  story: '<p>Camp Joy opened in 1990.</p><p>SOARD renovated the lodge.</p>',
  heroImage: img('community/joy/1'), imageId: 'community/joy/1', imageAlt: 'The lodge',
  photos: [1, 2, 3].map((n) => ({ url: img(`community/joy/${n}`), alt: n === 1 ? 'The lodge' : `Photo ${n}` })),
  partnerLogos: [{ url: img('partners/acme/logo'), name: 'Acme' }], metaDescription: '', ...over,
});
const REAL = readdirSync('src/content/community').filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`src/content/community/${f}`, 'utf8')));

// ── The number counted toward "children reached" ──
test('children reached: the stat marked in the admin, none when all are unmarked, else the first', () => {
  assert.equal(CS.reachedCount(project()), 1200, 'older records count their first stat');
  const three = [{ value: '4,850', label: 'hours of music therapy' }, { value: '25', label: 'groups weekly' }, { value: '1502', label: 'clients served' }];
  assert.equal(CS.reachedCount(project({ stats: three })), 4850);
  assert.equal(CS.reachedCount(project({ stats: three.map((s, i) => ({ ...s, reached: i === 2 })) })), 1502);
  assert.equal(CS.reachedCount(project({ stats: three.map((s) => ({ ...s, reached: false })) })), 0, 'every stat unmarked: none counts');
  assert.equal(CS.reachedCount(project({ stats: [], impact: '200+', impactLabel: 'students' })), 200, 'the impact pair when there are no stats');
  assert.equal(CS.reachedStat(project({ stats: [{ value: '', label: 'children' }] })), null, 'a stat with no number counts nothing');
  assert.deepEqual(CS.cleanStats([{ value: ' 5 ', label: 'kids', reached: true }, { value: '', label: '' }, { value: '6', label: 'more', reached: true }, { value: '7', label: 'x' }, { value: '8', label: 'y' }]),
    [{ value: '5', label: 'kids', reached: true }, { value: '6', label: 'more', reached: false }, { value: '7', label: 'x' }], 'trimmed, empty rows dropped, three at most, one marked');
  assert.ok(CS.countsPeople('children impacted yearly') && CS.countsPeople('families served') && CS.countsPeople('Clients Impacted'));
  assert.ok(!CS.countsPeople('Hours of Music Therapy Provided Per Year') && !CS.countsPeople('years providing education'));
});

test('the site’s total (src/utils/community.ts) agrees with the admin for every project', async () => {
  const ts = transformSync(readFileSync('src/utils/community.ts', 'utf8'), { loader: 'ts', format: 'esm' }).code;
  const site = await import(`data:text/javascript,${encodeURIComponent(ts)}`);
  const cases = [...REAL, project(), project({ stats: [{ value: '9', label: 'a', reached: false }, { value: '10', label: 'b', reached: true }] }),
    project({ stats: [{ value: '9', label: 'a', reached: false }] }), project({ stats: [], impact: '', impactLabel: '' }), project({ heroImage: '', imageId: 'x/1' })];
  for (const p of cases) {
    assert.equal(site.reachedCount(p), CS.reachedCount(p), p.slug);
    assert.equal(site.mainPhotoOf(p), CS.mainPhotoOf(p), p.slug);
  }
});

// ── Photos and the saved record ──
test('the record: the card fields follow the main photo; editor-only fields go', () => {
  const rec = CS.projectRecord(project({
    heroImage: img('community/joy/2'), imageId: 'community/joy/1', imageAlt: 'stale', badge: 'Old',
    photos: [{ url: img('community/joy/1'), alt: 'a', cfImageId: 'community/joy/1', _key: 'k1' }, { url: img('community/joy/2'), alt: ' The deck ', _tempId: 't' }, { url: 'blob:x', alt: '' }],
    stats: [{ value: '1,200 ', label: 'children', _key: 'x' }], story: '<p> </p>', quote: '  ', quoteBy: 'Ann',
  }));
  assert.equal(rec.imageId, 'community/joy/2', 'imageId is the main photo’s, so the card and the page agree');
  assert.equal(rec.imageAlt, 'The deck');
  assert.deepEqual(rec.photos, [{ url: img('community/joy/1'), alt: 'a' }, { url: img('community/joy/2'), alt: ' The deck ' }]);
  assert.deepEqual([rec.impact, rec.impactLabel], ['1,200', 'children']);
  assert.equal(rec.story, '', 'a story with no words makes no page');
  assert.deepEqual([rec.quote, rec.publishStatus, 'badge' in rec], [null, 'published', false]);
  assert.equal(CS.projectRecord(project({ heroImage: '', photos: [] })).imageId, '', 'no main photo, no card image');
});

test('editing an older record: one image field becomes a photo, the page’s alt text moves onto it, plain stories keep their paragraphs', () => {
  const old = CS.forEditing({ name: 'Old', imageId: 'community/old/1', imageAlt: 'The gym', story: 'One.\n\nTwo & three.', impact: '50', impactLabel: 'kids' });
  assert.deepEqual(old.photos, [{ url: 'community/old/1', alt: 'The gym' }]);
  assert.equal(old.heroImage, 'community/old/1');
  assert.equal(old.story, '<p>One.</p><p>Two &amp; three.</p>');
  assert.deepEqual(old.stats, [{ value: '50', label: 'kids' }]);
  // The card used imageId where it disagreed with heroImage; the editor keeps the page's photo
  const split = CS.forEditing(project({ heroImage: img('community/joy/2'), imageId: 'community/joy/1', imageAlt: '' }));
  assert.equal(split.heroImage, img('community/joy/2'));
  assert.deepEqual(CS.describeChanges(REAL[0], CS.projectRecord(CS.forEditing(REAL[0]))), [], 'opening and saving a project changes nothing on its pages');
  for (const p of REAL) assert.deepEqual(CS.describeChanges(p, CS.projectRecord(CS.forEditing(p))), [], p.slug);
});

test('the main photo and its focal point; the focus manifest covers project photos', () => {
  assert.equal(CS.mainPhotoOf({ heroImage: '', imageId: 'a/1' }), 'a/1');
  assert.equal(CS.mainPhotoOf({ heroImage: 'b/2', imageId: 'a/1' }), 'b/2', 'the page’s photo wins');
  assert.equal(CS.imageIdOf(img('community/joy/1')), 'community/joy/1');
  assert.equal(CS.imageIdOf('https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/x/community/joy/1/w=400'), 'community/joy/1');
  assert.deepEqual(photoFocusMap([project({ photos: [{ url: img('community/joy/1'), focus: { x: 0.25, y: 0.75 } }] })]), { 'community/joy/1': '0.25x0.75' });
});

// ── What's missing ──
test('issues: what changes the page first; the counted number has to be people', () => {
  const ids = (p) => CS.projectIssues(p).map((i) => `${i.tone[0]}:${i.id}`);
  assert.deepEqual(ids(project()), []);
  assert.deepEqual(ids(project({ heroImage: '', imageId: '', stats: [{ value: '', label: 'x' }], description: '', metaDescription: '' })), ['w:no-hero', 'w:no-stat', 'w:no-summary']);
  assert.deepEqual(ids(project({ stats: [{ value: '4,850', label: 'Hours of Music Therapy' }] })), ['w:reached-not-people']);
  assert.deepEqual(ids(project({ story: '', photos: [], heroImage: img('x') })), ['q:no-page']);
  assert.deepEqual(ids(project({ photos: [{ url: img('a'), alt: '' }], quote: 'Hi', partnerLogos: [{ url: img('p'), name: '' }] })),
    ['q:alt', 'q:partner-names', 'q:no-gallery', 'q:quote-by']);
  assert.deepEqual(ids(project({ description: 'x'.repeat(200) })), ['q:long-summary']);
  assert.ok(CS.needsSearchText(project({ description: 'x'.repeat(200) })) && !CS.needsSearchText(project({ description: 'x'.repeat(200), metaDescription: 'Set.' })));
  const real = new Map(REAL.map((p) => [p.slug, CS.projectIssues(p).filter((i) => i.tone === 'warn').map((i) => i.id)]));
  // (project files sync from D1 and most aren't in git, so this runs where they've synced)
  if (real.has('perfect-harmony-health') && !CS.reachedStat(REAL.find((p) => p.slug === 'perfect-harmony-health'))?.reached) {
    assert.deepEqual(real.get('perfect-harmony-health'), ['reached-not-people'], 'Perfect Harmony counts hours toward children reached');
  }
});

test('health checklist: in page order, pointing at sections the editor has', () => {
  const ids = (p) => CS.projectChecks(p).map((c) => `${c.done ? '✓' : '·'}${c.id}`);
  assert.deepEqual(ids(project()), ['✓hero', '✓stat', '✓summary', '✓reached', '✓story', '✓gallery', '✓alt', '✓partners', '✓meta']);
  assert.deepEqual(ids(project({ story: '', quote: 'Hi' })), ['✓hero', '✓stat', '✓summary', '✓reached', '·story', '✓alt', '·quote-by', '✓partners']);
  const sections = ['basics', 'story', 'photos', 'video', 'partners', 'search'];
  for (const p of [...REAL, project()]) assert.ok(CS.projectChecks(p).every((c) => sections.includes(c.section)), p.slug);
});

// ── Order ──
test('order: the Community page by order then name, drafts left out; the admin keeps them in place', () => {
  const list = [project({ slug: 'b', name: 'B', order: 2 }), project({ slug: 'a', name: 'A', order: 2 }), project({ slug: 'd', name: 'D', order: 1, publishStatus: 'draft' }), project({ slug: 'c', name: 'C', order: 0 })];
  assert.deepEqual(CS.listOrder(list).map((p) => p.slug), ['c', 'a', 'b']);
  assert.deepEqual(CS.adminOrder(list).map((p) => p.slug), ['c', 'd', 'a', 'b']);
  assert.deepEqual(CS.moreProjects(list[0], [...list, project({ slug: 'e', story: '' })]).map((p) => p.slug), ['a', 'c']);
});

test('reorder community: one request writes `order` for the movers', async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const p of [project({ slug: 'a', name: 'A', order: 1 }), project({ slug: 'b', name: 'B', order: 2 }), project({ slug: 'c', name: 'C', order: 3 })]) {
    await DB.prepare('INSERT INTO community (slug, name, order_num, data) VALUES (?, ?, ?, ?)').bind(p.slug, p.name, p.order, JSON.stringify(p)).run();
  }
  const r = await reorder({ DB }, { collection: 'community', items: [{ slug: 'c', order: 1 }, { slug: 'a', order: 2 }, { slug: 'b', order: 3 }] }, 'staff@example.org');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.sort(), ['a', 'b', 'c']);
  const row = async (s) => (await DB.prepare('SELECT order_num, data FROM community WHERE slug = ?').bind(s).first());
  assert.equal(JSON.parse((await row('c')).data).order, 1);
  assert.equal((await row('c')).order_num, 1, 'the indexed column follows');
  assert.equal(JSON.parse((await row('b')).data).name, 'B', 'the rest of the record stays');
});

// ── History ──
test('history: community saves and deletes are kept and listed, separately from kids', async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await recordVersion(DB, { collection: 'community', slug: 'camp-joy', data: project(), previous: project({ year: '2023' }), userEmail: 'a@x.org', now: '2026-10-19T12:00:00.000Z' });
  await recordDeletion(DB, { collection: 'community', slug: 'camp-joy', data: project(), userEmail: 'a@x.org', now: '2026-10-19T12:05:00.000Z' });
  const call = async (q) => (await historyGet({ request: new Request(`https://x/api/content-history?${q}`), env: { DB } })).json();
  const v = await call('collection=community&slug=camp-joy');
  assert.deepEqual(v.versions.map((x) => x.action), ['delete', 'save', 'save']);
  const del = await call('collection=community&deleted=1');
  assert.deepEqual(del.deleted.map((d) => [d.slug, d.name, d.image]), [['camp-joy', 'Camp Joy', img('community/joy/1')]]);
  assert.deepEqual((await call('collection=kids&slug=camp-joy')).versions, []);
});

test('history in words: numbers, the counted one, a page made, hidden', () => {
  const a = project();
  const words = (b) => CS.describeChanges(a, b).map((c) => `${c.label}: ${c.detail}`);
  assert.deepEqual(words(project({ stats: [{ value: '1,500', label: 'children served each year' }] })), ['Impact numbers: “1,200 children served each year” → “1,500 children served each year”']);
  assert.deepEqual(words(project({ stats: [{ value: '1,200', label: 'children served each year', reached: false }] })), ['Impact numbers: Counted toward children reached: none']);
  assert.deepEqual(words({ ...a, story: '' }), ['Story: Removed, so the project has no page']);
  assert.deepEqual(CS.describeChanges({ ...a, story: '' }, a).map((c) => c.detail), ['Added (9 words), so the project has a page']);
  assert.deepEqual(words(project({ publishStatus: 'draft', quoteBy: 'Ann Lee' })), ['Shown on the site: Hidden', 'Quote by: Added: “Ann Lee”']);
  assert.deepEqual(words(project({ photos: [...a.photos.slice(1), { ...a.photos[0], focus: { x: 0.1, y: 0.2 } }] })), ['Photos: new order, focal point on 1 photo']);
  assert.deepEqual(CS.changedLabels(['impact', 'imageId', 'videoUrl', 'quoteBy']), ['Impact numbers', 'Main photo', 'Video', 'Quote by']);
});

// ── Writing helpers ──
const ai = (body, response) => {
  const prompts = [];
  const env = { AI: { run: async (model, input) => { prompts.push({ model, input }); return { response: typeof response === 'function' ? response(input) : response }; } } };
  return generate({ request: new Request('https://x/api/generate', { method: 'POST', body: JSON.stringify(body) }), env })
    .then(async (r) => ({ status: r.status, body: await r.json(), prompts }));
};

test('AI: project photos are described as a project, not a child', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const r = await ai({ type: 'alt-text', kid: { kind: 'community', name: 'Camp Joy', description: 'A camp for kids.', photos: [{ url: 'community/joy/1' }] } }, 'Bunk beds in a sunny cabin');
  assert.deepEqual(r.body.altTexts, ['Bunk beds in a sunny cabin']);
  const prompt = r.prompts.find((p) => p.input.prompt)?.input.prompt || '';
  assert.match(prompt, /renovation project at Camp Joy/);
  assert.doesNotMatch(prompt, /The child in this photo/);
});

test('AI: a search description and a summary for a project', async () => {
  const seo = await ai({ type: 'seo', kid: { ...project(), kind: 'community' } }, 'META_DESCRIPTION: "Sunshine on a Ranney Day renovated Camp Joy’s lodge — for 1,200 kids."');
  assert.equal(seo.status, 200);
  assert.equal(seo.body.metaDescription, 'Sunshine on a Ranney Day renovated Camp Joy’s lodge, for 1,200 kids.');
  assert.ok(!('shortDescription' in seo.body), 'no kid card blurb');
  assert.match(seo.prompts[0].input.messages[0].content, /Organization: Camp Joy/);
  const sum = await ai({ type: 'project-summary', kid: { ...project(), kind: 'community' } }, `${'A'.repeat(200)}. ${'B'.repeat(150)}.`);
  assert.ok(sum.body.description.length <= 320);
  const none = await ai({ type: 'project-summary', kid: { ...project(), story: '', kind: 'community' } }, 'x');
  assert.equal(none.status, 400);
});
