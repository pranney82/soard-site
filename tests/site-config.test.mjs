/**
 * Admin → Site Config: the logic in public/admin/site-config-shared.js (paths,
 * the save merge, checks, the page map). Site documents' history is tested in
 * tests/content-history.test.mjs; the screens by scripts/test-site-config-admin.mjs.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../public/admin/site-config-shared.js';

test('paths: get, set (copies, makes parents, undefined removes), leaf diffs', () => {
  const a = { homeHero: { eyebrow: 'e', lead: 'l' }, list: [1, 2], n: 1 };
  assert.equal(S.getPath(a, 'homeHero.lead'), 'l');
  assert.equal(S.getPath(a, 'nope.deep'), undefined);
  const b = S.setPath(a, 'homeHero.eyebrow', 'E');
  assert.equal(a.homeHero.eyebrow, 'e', 'the original is untouched');
  assert.equal(b.homeHero.eyebrow, 'E');
  assert.deepEqual(S.setPath({}, 'x.y.z', 1), { x: { y: { z: 1 } } });
  assert.deepEqual(S.setPath({ x: 1, y: 2 }, 'x', undefined), { y: 2 });
  assert.deepEqual(S.changedPaths(a, { ...b, list: [2, 1] }).sort(), ['homeHero.eyebrow', 'list'], 'lists compare whole');
  assert.deepEqual(S.changedPaths({ photoTimestamps: { 'a.b': '1' } }, { photoTimestamps: { 'a.b': '2' } }), ['photoTimestamps'], 'dotted-key maps compare whole');
});

test('the save merge lays only my changes onto a fresh copy', () => {
  const base = { homeHero: { eyebrow: 'e', lead: 'l' }, social: { facebook: 'f' }, photoTimestamps: { 'a.b': '1' } };
  let edit = S.setPath(base, 'homeHero.eyebrow', 'mine');
  edit = S.withPhoto(edit, 'sectionPhotos.process', 'kids/x/1', 'T');
  const fresh = { ...base, homeHero: { ...base.homeHero, lead: 'theirs' }, social: { facebook: 'f2' }, photoTimestamps: { 'a.b': '1', 'c.d': '9' }, application: { open: true } };
  const { next, conflicts } = S.mergeForSave(base, edit, fresh);
  assert.deepEqual(conflicts, []);
  assert.equal(next.homeHero.eyebrow, 'mine');
  assert.equal(next.homeHero.lead, 'theirs', 'their change to another field stays');
  assert.equal(next.social.facebook, 'f2');
  assert.deepEqual(next.application, { open: true }, 'Applications’ block is never touched');
  assert.equal(next.sectionPhotos.process, 'kids/x/1');
  assert.deepEqual(next.photoTimestamps, { 'a.b': '1', 'c.d': '9', 'sectionPhotos.process': 'T' }, 'photo dates merge by key');
});

test('a field both of us changed is a conflict; the same value is not', () => {
  const base = { homeHero: { eyebrow: 'e' }, kidShowcase: [{ slug: 'a' }] };
  const edit = { homeHero: { eyebrow: 'mine' }, kidShowcase: [{ slug: 'b' }] };
  assert.deepEqual(S.mergeForSave(base, edit, { homeHero: { eyebrow: 'theirs' }, kidShowcase: [{ slug: 'b' }] }).conflicts, ['homeHero.eyebrow']);
  assert.deepEqual(S.mergeForSave(base, edit, { homeHero: { eyebrow: 'mine' }, kidShowcase: [{ slug: 'a' }] }).conflicts, []);
});

test('image IDs from IDs, imagedelivery URLs and variants; kid photos', () => {
  assert.equal(S.cfIdOf('kids/dex/1-IMG.JPG'), 'kids/dex/1-IMG.JPG');
  assert.equal(S.cfIdOf('https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dex/1-IMG.JPG/public'), 'kids/dex/1-IMG.JPG');
  assert.equal(S.cfIdOf('/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/financials/cover/w=360,h=466'), 'financials/cover');
  assert.equal(S.cfIdOf('/candid-platinum-2026.svg'), '', 'a site file is not an image ID');
  assert.equal(S.kidSlugOfImage('kids/dylan-2026/123.jpeg'), 'dylan-2026');
  const kid = { slug: 'dex', heroImage: 'https://imagedelivery.net/H/kids/dex/hero.jpg/public', photos: [{ url: 'https://imagedelivery.net/H/kids/dex/hero.jpg/public' }, { url: 'kids/dex/2.jpg', alt: 'two' }] };
  assert.deepEqual(S.kidPhotos(kid).map(p => p.id), ['kids/dex/hero.jpg', 'kids/dex/2.jpg'], 'the main photo first, no repeats');
  assert.deepEqual(S.publishedKids([{ slug: 'a' }, { slug: 'b', publishStatus: 'draft' }]).map(k => k.slug), ['a']);
});

test('checks', () => {
  for (const ok of ['', '/donate/', '#stories', 'https://example.org/x', 'mailto:a@b.co', 'tel:+17709902434']) assert.equal(S.linkProblem(ok), null, ok);
  assert.match(S.linkProblem('http://x.org'), /https/);
  assert.match(S.linkProblem('donate'), /Start with \//);
  assert.equal(S.phoneProblem('(770) 990-2434'), null);
  assert.equal(S.phoneProblem('770.990.2434'), null);
  assert.ok(S.phoneProblem('990-2434'));
  assert.equal(S.einProblem('45-4773997'), null);
  assert.ok(S.einProblem('454773997'));
  assert.equal(S.zipProblem('30076'), null);
  assert.ok(S.emailProblem('info@'));
  assert.ok(S.endsWithArrow('See Our Work ↓'));
  assert.equal(S.withoutArrow('See Our Work ↓'), 'See Our Work');
  assert.ok(!S.endsWithArrow('See Our Work'));
});

test('the financial snapshot: totals and rounded shares, the page’s short money', () => {
  const s = S.withPercents({ programExpenses: 1492596, managementExpenses: 188160, fundraisingExpenses: 165233 });
  assert.equal(s.totalExpenses, 1845989);
  assert.deepEqual([s.programPct, s.managementPct, s.fundraisingPct], [81, 10, 9]);
  assert.equal(S.withPercents({ programExpenses: 0 }).totalExpenses, 0);
  assert.equal(S.moneyShort(1867189), '$1.9M');
  assert.equal(S.moneyShort(517671), '$518K');
});

test('FAQ: one category reordered by position, the others left alone', () => {
  const faq = { items: [{ id: 'a', category: 'x', order: 1 }, { id: 'b', category: 'x', order: 2 }, { id: 'c', category: 'y', order: 1 }] };
  const out = S.reorderFaq(faq, 'x', ['b', 'a']);
  assert.deepEqual(out.items.map(i => [i.id, i.order]), [['a', 2], ['b', 1], ['c', 1]]);
  assert.deepEqual(S.faqItems(out, 'x').map(i => i.id), ['b', 'a']);
  assert.ok(S.ABOUT_FAQ_CATEGORIES.about && S.ABOUT_FAQ_CATEGORIES.rooms, 'the two categories /about/ shows by id');
  const about = readFileSync(new URL('../src/pages/about/index.astro', import.meta.url), 'utf8');
  for (const id of Object.keys(S.ABOUT_FAQ_CATEGORIES)) assert.match(about, new RegExp(`['"]${id}['"]`), `/about/ still reads category "${id}"`);
});

test('the page map: every setting on one page, old tab names lead somewhere', () => {
  const keys = S.PAGES.map(p => p.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const v of Object.values(S.OLD_TABS)) assert.ok(S.pageByKey(v), v);
  // Every photo with a spec belongs to exactly one page (our-story images to Our Story)
  for (const path of Object.keys(S.PHOTO_SPECS)) {
    const doc = path.startsWith('images.') ? 'our-story' : 'settings';
    const pages = S.PAGES.filter(p => (p.fields?.[doc] || []).some(f => f === '' || path === f || path.startsWith(`${f}.`)));
    assert.equal(pages.length, 1, `${path} → ${pages.map(p => p.key).join(', ') || 'no page'}`);
  }
  assert.equal(S.pageOf('settings', 'homeHero.lead').key, 'home');
  assert.equal(S.pageOf('settings', 'applyPhotos.build').key, 'apply');
  assert.equal(S.pageOf('settings', 'sectionPhotos.process').key, 'apply', 'the reveal photo is on the Apply page');
  assert.equal(S.pageOf('faq', 'items').key, 'faq');
  assert.equal(S.pageOf('settings', 'photoTimestamps'), null);
  assert.equal(S.pageOf('settings', 'application.open'), null, 'Applications owns the application block');
  const docs = { settings: { base: { homeHero: { lead: 'a' } }, edit: { homeHero: { lead: 'b' }, donatePhotos: { hero: 'x' } } } };
  assert.deepEqual(S.pageChanges(S.pageByKey('home'), docs), [{ doc: 'settings', path: 'homeHero.lead' }]);
  assert.deepEqual(S.pageChanges(S.pageByKey('donate'), docs), [{ doc: 'settings', path: 'donatePhotos' }]);
});

test('photo crops match the pages', () => {
  assert.equal(S.cropTransforms(S.PHOTO_SPECS.heroKidPhotoId, 400), 'w=400,h=500,fit=cover,gravity=face,q=75');
  assert.equal(S.cropTransforms(S.PHOTO_SPECS['sectionPhotos.roomBath'], 700), 'w=700,h=875,fit=cover,q=75', 'a centre crop has no gravity');
  assert.equal(S.cropTransforms(S.PHOTO_SPECS['donatePhotos.story'], 600), 'w=600,q=75', 'shown whole');
  const home = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(home, /aspect-ratio:\s*4\s*\/\s*5/, 'the homepage hero is still 4:5');
  const apply = readFileSync(new URL('../src/pages/apply.astro', import.meta.url), 'utf8');
  assert.match(apply, /w=800,h=560,fit=cover,gravity=face/, 'the reveal photo is still 10:7 around faces');
});

test('the built-in trust badges match the site’s', () => {
  const ts = readFileSync(new URL('../src/utils/trust-badges.ts', import.meta.url), 'utf8');
  for (const b of S.DEFAULT_TRUST_BADGES) for (const v of Object.values(b)) assert.ok(ts.includes(v), v);
});
