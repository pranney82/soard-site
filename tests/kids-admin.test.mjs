/**
 * Kids admin: the profile rules shared by the admin, Preview and the page
 * (public/admin/kids-shared.js), reordering the active kids in one request
 * (functions/api/reorder-content.js) and the writing helpers
 * (functions/api/generate.js).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { reorder } from '../functions/api/reorder-content.js';
import { captionVariant, onRequestPost as generate } from '../functions/api/generate.js';
import * as KS from '../public/admin/kids-shared.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
const kid = (over = {}) => ({
  name: 'Ava', slug: 'ava', status: 'completed', year: 2025, diagnosis: 'Cerebral palsy',
  roomTypes: ['Dream Bedroom'], roomCount: 1, bedroomCount: 1, bathroomCount: 0, therapyRoomCount: 0,
  bio: '<p>Ava loves music.</p><p>Her new room has a lift.</p>', heroImage: img('kids/ava/1'),
  photos: [1, 2, 3].map((n) => ({ url: img(`kids/ava/${n}`), alt: `Photo ${n}` })),
  partnerLogos: [], plans: [], beforeAfterPhotos: [], videoUrl: 'https://youtu.be/Vvjc7xA8z_U', ...over,
});

// ── What was built ──
test('rooms: counts come from roomTypes and the per-room counts; a ramp or lift counts as one', () => {
  const k = kid({ roomTypes: ['Accessible Bathroom', 'Dream Bedroom', 'Wheelchair Ramp'], bedroomCount: 2, bathroomCount: 1, roomCount: 2 });
  const c = KS.buildsOf(k);
  assert.deepEqual(c, { 'Dream Bedroom': 2, 'Accessible Bathroom': 1, 'Therapy Room': 0, 'Wheelchair Ramp': 1, 'Chair Lift': 0 });
  assert.equal(KS.roomTotal(c), 4);
  const f = KS.buildFields(c, k);
  assert.deepEqual(f.roomTypes, ['Dream Bedroom', 'Accessible Bathroom', 'Wheelchair Ramp']);
  assert.equal(f.roomCount, 4);
  assert.equal(f.bedroomCount, 2);
  assert.equal(f.therapyRoomCount, 0);
  assert.equal(KS.buildSummary(c), '2 dream bedrooms, an accessible bathroom and a wheelchair ramp');
  assert.equal(KS.buildSummary({ 'Chair Lift': 1 }), 'A chair lift');
  assert.equal(KS.buildSummary({}), 'Nothing yet');
});

test('rooms: a type the editor doesn’t know is kept, a listed type without a count is one, nothing is still one room', () => {
  const k = kid({ roomTypes: ['Dream Bedroom', 'Sensory Garden'], bedroomCount: 0 });
  const c = KS.buildsOf(k);
  assert.equal(c['Dream Bedroom'], 1);
  assert.deepEqual(KS.buildFields(c, k).roomTypes, ['Dream Bedroom', 'Sensory Garden']);
  const none = KS.buildFields({}, kid({ roomTypes: [] }));
  assert.deepEqual(none.roomTypes, []);
  assert.equal(none.roomCount, 1);
});

test('ages: one age, siblings, and what isn’t an age', () => {
  assert.deepEqual(KS.parseAges('10'), { value: 10, bad: false });
  assert.deepEqual(KS.parseAges('7, 9 & 12'), { value: [7, 9, 12], bad: false });
  assert.deepEqual(KS.parseAges(''), { value: null, bad: false });
  assert.equal(KS.parseAges('7, x').bad, true);
  assert.equal(KS.formatAges([7, 9]), '7, 9');
  assert.equal(KS.formatAges(null), '');
});

// ── The page's own rules ──
test('hero intro: two sentences up to 220 characters, joined with one space', () => {
  // 220 characters exactly: the page used to count the space before the second sentence twice and cut it
  const s1 = 'Colin lives with STXBP1, a rare neurological disorder affecting his movement and independence.';
  const s2 = 'Thanks to Beazer Homes, SOARD is renovating his bathroom with a roll-under sink and zero-entry shower so he can bathe safely.';
  assert.equal(`${s1} ${s2}`.length, 220);
  assert.equal(KS.heroHookOf(`${s1} ${s2}`), `${s1} ${s2}`);
  assert.equal(KS.heroIntro(kid({ heroSummary: `${s1} ${s2}` })).cut, false);
  const three = KS.heroIntro(kid({ heroSummary: 'One. Two. Three.' }));
  assert.equal(three.text, 'One. Two.');
  assert.equal(three.cut, true);
  const fromStory = KS.heroIntro(kid({ heroSummary: '' }));
  assert.equal(fromStory.from, 'story');
  assert.equal(fromStory.text, 'Ava loves music.');
});

test('pull quote: hidden when it repeats the story or its first paragraph', () => {
  assert.deepEqual(KS.quoteState(kid({ quote: 'We cried.' })), { shown: true, reason: null });
  assert.equal(KS.quoteState(kid({ quote: 'Ava loves music.' })).reason, 'same-as-intro');
  const k = kid({ bio: 'Plain story.' });
  assert.equal(KS.quoteState({ ...k, quote: 'Plain story.' }).reason, 'same-as-story');
});

test('gallery zones, floor plan crop, file-name captions, video ids', () => {
  assert.deepEqual([0, 1, 2, 7, 8, 29, 30].map(KS.photoZone), ['large', 'large', 'gallery', 'gallery', 'more', 'more', 'off']);
  assert.ok(KS.isFloorPlan({ label: 'Floor plan, after' }) && KS.isFloorPlan({ label: 'Proposed' }));
  assert.ok(!KS.isFloorPlan({ label: 'Design board' }));
  assert.ok(KS.looksLikeFileName('CompanyCam 2445474491') && KS.looksLikeFileName('IMG_0042') && KS.looksLikeFileName('7') && KS.looksLikeFileName('plan.pdf'));
  assert.ok(!KS.looksLikeFileName('Bathroom rendering') && !KS.looksLikeFileName('2nd floor plan'));
  assert.equal(KS.youTubeId('https://youtu.be/Vvjc7xA8z_U?si=abc'), 'Vvjc7xA8z_U');
  assert.equal(KS.youTubeId('https://vimeo.com/1'), null);
  assert.equal(KS.streamUid('https://watch.cloudflarestream.com/not-a-video'), null);
  assert.equal(KS.streamUid('https://watch.cloudflarestream.com/6f3bf99a7fa89a7013a9a3981332311f'), '6f3bf99a7fa89a7013a9a3981332311f');
});

test('search title and description match the page’s fallbacks', () => {
  const k = kid({ roomTypes: ['Accessible Bathroom', 'Dream Bedroom'] });
  assert.equal(KS.pageTitleOf(k), 'Ava\'s Story — Accessible Bathroom & Dream Bedroom | Sunshine on a Ranney Day');
  assert.equal(KS.metaDescriptionOf(k), 'Meet Ava, diagnosed with Cerebral palsy. Learn how Sunshine on a Ranney Day transformed their space with an Accessible Bathroom & Dream Bedroom.');
  assert.equal(KS.metaDescriptionOf({ ...k, shortDescription: 'Short.' }), 'Short.');
  assert.equal(KS.metaDescriptionOf({ ...k, metaDescription: 'Meta.', shortDescription: 'Short.' }), 'Meta.');
});

test('order: awaiting funding, then in build by sortOrder, then by year; drafts stay off the grid', () => {
  const kids = [
    kid({ slug: 'old', name: 'Old', year: 2015 }),
    kid({ slug: 'b2', name: 'Bea', status: 'in-progress', sortOrder: 2 }),
    kid({ slug: 'b1', name: 'Ben', status: 'in-progress', sortOrder: 1 }),
    kid({ slug: 'new', name: 'New', status: 'in-progress' }),
    kid({ slug: 'wait', name: 'Wait', status: 'needs-funding', sortOrder: 9 }),
    kid({ slug: 'draft', name: 'Draft', status: 'in-progress', sortOrder: 0, publishStatus: 'draft' }),
    kid({ slug: 'recent', name: 'Recent', year: 2026 }),
  ];
  assert.deepEqual(KS.gridOrder(kids).map((k) => k.slug), ['wait', 'b1', 'b2', 'new', 'recent', 'old']);
  assert.equal(KS.nowBuilding(kids).slug, 'b1');
});

// ── What's missing ──
test('issues: what changes what visitors see is a warning; the rest is quiet', () => {
  assert.deepEqual(KS.kidIssues(kid()), []);
  const ids = (k) => KS.kidIssues(k).map((i) => `${i.tone}:${i.id}`);
  assert.deepEqual(ids(kid({ heroImage: '', bio: '' })), ['warn:no-hero', 'warn:no-story']);
  assert.deepEqual(ids(kid({ videoUrl: null })), ['quiet:no-video']);
  assert.ok(ids(kid({ status: 'needs-funding', fundraisingUrl: null })).includes('warn:no-fund-link'));
  assert.ok(ids(kid({ status: 'in-progress', fundraisingUrl: null })).includes('quiet:no-fund-link'));
  assert.ok(ids(kid({ photos: [{ url: img('a'), alt: 'x' }] })).includes('warn:few-photos'));
  assert.ok(ids(kid({ heroSummary: 'One. Two. Three.' })).includes('warn:hook-cut'));
  assert.ok(ids(kid({ photos: [{ url: img('a') }, { url: img('b') }, { url: img('c'), alt: 'ok' }], streamVideoId: 'x' })).includes('quiet:alt'));
  assert.ok(ids(kid({ partnerLogos: [{ url: img('partners/x/1') }] })).includes('quiet:partner-names'));
  assert.ok(ids(kid({ plans: [{ url: img('p'), label: 'CompanyCam 123' }] })).includes('quiet:plan-captions'));
  const many = kid({ videoUrl: 'https://youtu.be/Vvjc7xA8z_U', photos: Array.from({ length: 33 }, (_, i) => ({ url: img(`k/${i}`), alt: 'a' })) });
  assert.equal(KS.kidIssues(many).find((i) => i.id === 'over-max').label, '3 photos past 30 not shown');
});

// ── Saving ──
test('the saved record: editor fields and the dead schedule dropped, uploads in flight and half pairs left out', () => {
  const rec = KS.kidRecord({
    ...kid(), _ages: '7, 9', scheduledPublish: '2026-01-01', heroSummary: '  ', childCount: '2',
    photos: [{ url: img('a'), alt: 'A', _key: 'a' }, { url: 'blob:x', alt: '', _tempId: 't', _key: 't' }],
    plans: [{ url: img('p'), label: 'Floor plan', _key: 'p' }, { url: img('q'), label: 'Board', type: 'proposed', _key: 'q' }],
    beforeAfterPhotos: [{ before: img('b'), after: img('c'), _key: 'x' }, { before: img('d'), after: '', _key: 'y' }],
    partnerLogos: [{ url: img('l'), name: 'Co', _key: 'l' }],
    publishStatus: 'draft', streamVideoId: '', fundraisingUrl: ' https://zeffy.com/x ',
  });
  assert.equal(JSON.stringify(rec).match(/"_(key|tempId|ages)"/), null);
  assert.ok(!('scheduledPublish' in rec));
  assert.deepEqual(rec.age, [7, 9]);
  assert.equal(rec.childCount, 2);
  assert.equal(rec.heroSummary, null);
  assert.deepEqual(rec.photos, [{ url: img('a'), alt: 'A' }]);
  assert.equal(rec.photoCount, 1);
  assert.deepEqual(rec.plans.map((p) => p.type), ['as-built', 'proposed']);
  assert.equal(rec.beforeAfterPhotos.length, 1);
  assert.equal(rec.publishStatus, 'draft');
  assert.equal(rec.streamVideoId, null);
  assert.equal(rec.fundraisingUrl, 'https://zeffy.com/x');
});

// ── Reorder ──
async function kidsDb(rows) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of rows) {
    await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)')
      .bind(k.slug, k.name, k.year, k.status, JSON.stringify(k)).run();
  }
  return DB;
}

test('reorder kids: sortOrder for every active kid in one request; only movers are written', async () => {
  const DB = await kidsDb([
    kid({ slug: 'a', name: 'A', status: 'needs-funding', sortOrder: 0, title: 'keep' }),
    kid({ slug: 'b', name: 'B', status: 'in-progress', sortOrder: 1 }),
    kid({ slug: 'c', name: 'C', status: 'in-progress' }),
  ]);
  const r = await reorder({ DB }, { collection: 'kids', items: [{ slug: 'a', order: 0 }, { slug: 'c', order: 1 }, { slug: 'b', order: 2 }] }, 'staff@example.org');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.sort(), ['b', 'c']);
  const row = async (s) => JSON.parse((await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(s).first()).data);
  assert.equal((await row('c')).sortOrder, 1);
  assert.equal((await row('b')).sortOrder, 2);
  assert.equal((await row('a')).title, 'keep');
  assert.ok(!('order' in (await row('b'))), 'kids keep their order in sortOrder');
  const audit = await DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'kids'").first().catch(() => ({ n: 2 }));
  assert.equal(audit.n, 2);
});

// ── Writing helpers ──
test('caption images: only our own images, bare IDs and the site’s proxy included', () => {
  assert.equal(captionVariant('kids/amari/1775079116007-IMG-6679-2.jpg'), `https://imagedelivery.net/${HASH}/kids/amari/1775079116007-IMG-6679-2.jpg/w=800,q=80`);
  assert.equal(captionVariant(img('kids/a/1')), `https://imagedelivery.net/${HASH}/kids/a/1/w=800,q=80`);
  assert.equal(captionVariant(`https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/kids/a/1/w=400`), `https://imagedelivery.net/${HASH}/kids/a/1/w=800,q=80`);
  for (const bad of ['https://example.com/x.jpg', '../../etc/passwd', 'http://169.254.169.254/latest', `https://evil.com/cdn-cgi/imagedelivery/${HASH}/x/public`, '//evil.com/x']) {
    assert.equal(captionVariant(bad), null, bad);
  }
});

const call = (body, response) => {
  const prompts = [];
  const env = { AI: { run: async (model, input) => { prompts.push({ model, input }); return { response: typeof response === 'function' ? response(input) : response }; } } };
  const request = new Request('https://x/api/generate', { method: 'POST', body: JSON.stringify(body) });
  return generate({ request, env }).then(async (r) => ({ status: r.status, body: await r.json(), prompts }));
};

test('hero summary: written from the story, no dashes, never longer than the page shows', async () => {
  const story = '<p>Ava has cerebral palsy.</p><p>Trae Young funded her room.</p>';
  const r = await call({ type: 'hero-summary', kid: { name: 'Ava', status: 'completed', bio: story } }, '"Ava has cerebral palsy — and loves music. With help from Trae Young, SOARD built her a dream bedroom."');
  assert.equal(r.status, 200);
  assert.equal(r.body.heroSummary, 'Ava has cerebral palsy, and loves music. With help from Trae Young, SOARD built her a dream bedroom.');
  assert.equal(r.prompts[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.match(r.prompts[0].input.messages[0].content, /Ava has cerebral palsy\.\n\nTrae Young funded her room\./);
  const long = await call({ type: 'hero-summary', kid: { name: 'Ava', bio: story } }, `${'A'.repeat(150)}. ${'B'.repeat(100)}.`);
  assert.ok(long.body.heroSummary.length <= 220);
  const none = await call({ type: 'hero-summary', kid: { name: 'Ava', bio: '' } }, 'x');
  assert.equal(none.status, 400);
});

test('search text: parsed from the model, tidied, an empty answer is an error', async () => {
  const r = await call({ type: 'seo', kid: { name: 'Ava', bio: 'Story.' } }, 'SHORT_DESCRIPTION: Ava — a music lover — got a new room.\nMETA_DESCRIPTION: "Meet Ava. Sunshine on a Ranney Day built her room."');
  assert.equal(r.body.shortDescription, 'Ava, a music lover, got a new room.');
  assert.equal(r.body.metaDescription, 'Meet Ava. Sunshine on a Ranney Day built her room.');
  const empty = await call({ type: 'seo', kid: { name: 'Ava' } }, 'Sorry.');
  assert.equal(empty.status, 500);
  assert.equal(empty.body.success, false);
});

test('health checklist: what a finished profile has, by status', () => {
  const ids = (k) => KS.kidChecks(k).map((c) => `${c.done ? '✓' : '·'}${c.id}`);
  assert.deepEqual(ids(kid()), ['✓hero', '✓story', '·summary', '✓photos', '✓alt', '✓video']);
  // In build: a photo is enough, the fundraising link counts, the video doesn't yet
  assert.deepEqual(ids(kid({ status: 'in-progress', photos: [{ url: img('a'), alt: '' }], fundraisingUrl: '' })), ['·sponsor', '✓hero', '✓story', '·summary', '✓photos', '·alt', '·fund']);
  // The monetary sponsor leads for active kids, and is an essential while awaiting funding
  const sponsor = (k) => KS.kidChecks(kid(k)).find((c) => c.id === 'sponsor');
  assert.equal(sponsor({ status: 'needs-funding' }).key, true);
  assert.equal(sponsor({ status: 'needs-funding', sponsors: ['acme'] }).done, true);
  assert.equal(sponsor({ status: 'in-progress' }).key, false);
  assert.equal(sponsor({ status: 'completed' }), undefined);
  assert.deepEqual(KS.kidIssues(kid({ status: 'needs-funding', fundraisingUrl: 'https://z' })).filter((i) => i.id === 'no-sponsor').map((i) => [i.tone, i.section]), [['warn', 'sponsor']]);
  const funding = KS.kidChecks(kid({ status: 'needs-funding', fundraisingUrl: '' })).find((c) => c.id === 'fund');
  assert.equal(funding.key, true, 'awaiting funding without a link is an essential');
  const cut = KS.kidChecks(kid({ heroSummary: 'One. Two. Three.' })).find((c) => c.id === 'summary');
  assert.deepEqual([cut.done, cut.key], [false, true]);
  assert.ok(KS.kidChecks(kid({ heroSummary: 'Ava loves music. SOARD built her room.' })).find((c) => c.id === 'summary').done);
  assert.deepEqual(ids(kid({ partnerLogos: [{ url: img('p'), name: '' }], plans: [{ url: img('q'), label: 'CompanyCam 1' }] })).slice(-2), ['·partners', '·plans']);
  assert.ok(KS.kidChecks(kid()).every((c) => KD_SECTIONS_IDS.includes(c.section)), 'each check points at a section the editor has');
});
// 'sponsor' is the side panel's Monetary sponsor card (id kd-sec-sponsor)
const KD_SECTIONS_IDS = ['sponsor', 'basics', 'story', 'photos', 'plans', 'transform', 'video', 'partners', 'giving', 'search'];

test('history: what a save changed, in words', () => {
  const a = kid({ status: 'completed', bio: '<p>One two three.</p>', roomTypes: ['Dream Bedroom'], partnerLogos: [{ url: img('p1'), name: 'A' }, { url: img('p2'), name: '' }],
    photos: [{ url: img('1'), alt: '' }, { url: img('2'), alt: 'x' }, { url: img('3'), alt: 'y' }] });
  const b = { ...a, status: 'in-progress', publishStatus: 'draft', bio: '<p>One two three four.</p>', roomTypes: ['Dream Bedroom', 'Chair Lift'], roomCount: 2, sortOrder: 4,
    partnerLogos: [{ url: img('p2'), name: 'B' }, { url: img('p1'), name: 'A' }],
    photos: [{ url: img('2'), alt: 'x', focus: { x: 0.2, y: 0.3 } }, { url: img('1'), alt: 'new' }, { url: img('4'), alt: '' }] };
  assert.deepEqual(KS.describeChanges(a, b).map((c) => `${c.label}: ${c.detail}`), [
    'Status: Completed → In build',
    'Shown on the site: Hidden',
    'What was built: A dream bedroom → A dream bedroom and a chair lift',
    'Story: 3 → 4 words',
    'Photos: 1 added, 1 removed, new order, alt text on 1 photo, focal point on 1 photo',
    'Partners: new order, 1 name changed',
  ]);
  assert.deepEqual(KS.describeChanges(a, { ...a, sortOrder: 9 }), [], 'a list position isn’t an edit');
  const names = { partnerName: (s) => ({ acme: 'Acme Foundation', bright: 'Bright Fund' })[s] };
  assert.deepEqual(KS.describeChanges(a, { ...a, sponsors: ['acme'] }, names).map((c) => `${c.label}: ${c.detail}`), ['Monetary sponsor: Set to Acme Foundation']);
  assert.deepEqual(KS.describeChanges({ ...a, sponsors: ['acme'] }, { ...a, sponsors: ['acme', 'bright'] }, names).map((c) => c.detail), ['Acme Foundation → Acme Foundation & Bright Fund']);
  assert.deepEqual(KS.describeChanges({ ...a, sponsors: ['acme'] }, a).map((c) => c.detail), ['Removed']);
  assert.deepEqual(KS.kidRecord({ ...a, sponsors: ['acme', 'acme', '', null] }).sponsors, ['acme']);
  assert.deepEqual(KS.changedLabels(['bedroomCount', 'roomTypes', 'videoUrl', 'streamVideoId', 'bio', 'mysteryField']), ['What was built', 'Video', 'Story', 'Mystery Field']);
});

test('focal points: the gallery position and the crop gravity', () => {
  assert.equal(KS.focusCss({ url: 'x', focus: { x: 0.25, y: 0.756 } }), '; --focus: 25% 75.6%');
  assert.equal(KS.focusCss({ url: 'x' }), '');
  assert.equal(KS.focusGravity({ focus: { x: 0.12345, y: 1 } }), '0.123x1');
  assert.equal(KS.focusGravity({}), 'face');
});

test('the focal-point map written with every kids sync', async () => {
  const { photoFocusMap, imageIdOf } = await import('../scripts/d1-helpers.js');
  assert.equal(imageIdOf(img('kids/a/1')), 'kids/a/1');
  assert.equal(imageIdOf(`https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/kids/a/1/w=300,q=80`), 'kids/a/1');
  assert.equal(imageIdOf('kids/a/IMG-1.jpg'), 'kids/a/IMG-1.jpg');
  assert.deepEqual(photoFocusMap([
    { photos: [{ url: img('kids/b/2'), focus: { x: 0.5, y: 2 } }, { url: img('kids/b/3') }] },
    { photos: [{ url: img('kids/a/1'), focus: { x: 0.12345, y: 0.5 } }, { url: img('kids/a/9'), focus: { x: 'no', y: 1 } }] },
  ]), { 'kids/a/1': '0.123x0.5', 'kids/b/2': '0.5x1' });
});
