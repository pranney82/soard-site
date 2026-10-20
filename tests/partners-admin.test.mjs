/**
 * Partners (Admin → Partners): the record rules (public/admin/partners-shared.js),
 * changes to many partners at once and switching kid pages to a new logo
 * (functions/api/partners-batch.js), and reordering partners, community
 * partners and media logos (functions/api/reorder-content.js).
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './lib/d1-shim.mjs';
import { updatePartners, swapLogo } from '../functions/api/partners-batch.js';
import { reorder } from '../functions/api/reorder-content.js';
import {
  categoriesOf, categoryUnset, normalizeWebsite, domainOf, partnerRecord, sections, nextOrder, logoQuality, issuesOf,
  kidUsage, duplicatesOf, describeChanges, changedLabels, partnersCsv, placesOf, matches, logoSrc, cfId,
  communityRecord, communityIssues, communityListed, describeCommunityChanges, pressUsing,
  applyPartnerChange, homeStrip, contentBox, cropBox, marginFactor, svgCropViewBox, similarPartners, LEVELS, CATEGORIES,
  describeMediaChanges, MARGIN_WARN,
} from '../public/admin/partners-shared.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;

async function db({ partners = [], kids = [] } = {}) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const p of partners) {
    await DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(p.slug, p.name, p.level || 'friend', [].concat(p.category || []).join(','), p.featured ? 1 : 0, JSON.stringify(p)).run();
  }
  for (const k of kids) {
    await DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(k.slug, k.name, k.year || null, JSON.stringify(k)).run();
  }
  return DB;
}
const rowOf = async (DB, table, slug) => {
  const r = await DB.prepare(`SELECT * FROM ${table} WHERE slug = ?`).bind(slug).first();
  return r ? { ...r, data: JSON.parse(r.data) } : null;
};

// ── Record rules ──

test('categories: a string or nothing reads the way the site reads it', () => {
  assert.deepEqual(categoriesOf({ category: 'design' }), ['design']);
  assert.deepEqual(categoriesOf({}), ['build']);
  assert.deepEqual(categoriesOf({ category: ['funding', 'funding', 'bogus'] }), ['funding']);
  assert.deepEqual(categoriesOf({ category: [] }), ['build']);
  assert.equal(categoryUnset({}), true);
  assert.equal(categoryUnset({ category: 'community' }), false);
  assert.equal(categoryUnset({ category: ['nope'] }), true);
});

test('websites: bare domains get https://, names and sentences are not links', () => {
  assert.deepEqual(normalizeWebsite('example.com'), { url: 'https://example.com', ok: true, note: 'https:// added' });
  assert.equal(normalizeWebsite('www.Example.com/about').url, 'https://www.example.com/about');
  assert.equal(normalizeWebsite('http://example.com').url, 'https://example.com');
  assert.equal(normalizeWebsite('  ').url, '');
  assert.equal(normalizeWebsite('').ok, true);
  assert.equal(normalizeWebsite('tridentconstructiongroup').ok, false);
  assert.equal(normalizeWebsite('Accurate Lock & Hardware').ok, false);
  assert.equal(normalizeWebsite('mailto:x@y.com').ok, false);
  assert.equal(domainOf('https://www.Bell.com/x'), 'bell.com');
});

test('Save keeps fields it does not own, files the directory A to Z, and tidies the rest', () => {
  const r = partnerRecord({ name: ' Bell ', slug: 'bell', tier: 'construction', level: 'friend', order: 7, website: 'bell.com', tagline: '  ', category: 'design', logo: undefined });
  assert.equal(r.name, 'Bell');
  assert.equal(r.tier, 'construction', 'the old tier stays as it was');
  assert.equal(r.order, 0, 'directory partners sort A to Z');
  assert.equal(r.website, 'https://bell.com');
  assert.ok(!('tagline' in r), 'an empty tagline is dropped');
  assert.deepEqual(r.category, ['design']);
  assert.equal(r.logo, '');
  assert.equal(partnerRecord({ name: 'A', level: 'signature', order: 3 }).order, 3);
  assert.equal(partnerRecord({ name: 'A', level: 'bogus' }).level, 'friend');
  assert.equal(partnerRecord({ name: 'A', website: 'not a site' }).website, 'not a site', 'a bad address is kept for the editor to flag');
  assert.ok(!('website' in partnerRecord({ name: 'A', website: '' })));
  assert.ok(!('category' in partnerRecord({ name: 'A' })), 'no category chosen stays unchosen');
  assert.ok(!('website' in partnerRecord({ name: 'A', website: 'javascript:alert(1)' })), 'only http(s) links are kept');
  assert.ok(!('website' in partnerRecord({ name: 'A', website: 'data:text/html,x' })));
});

test('a save writes only what changed: untouched fields keep their old spelling', () => {
  const base = { name: 'Atlanta Kitchen ', slug: 'a', level: 'friend', website: 'http://ak.com/', tagline: ' x ', logo: img('l') };
  const r = partnerRecord({ ...base, featured: true }, base);
  assert.equal(r.name, 'Atlanta Kitchen ');
  assert.equal(r.website, 'http://ak.com/');
  assert.equal(r.tagline, ' x ');
  assert.ok(!('category' in r) && !('order' in r), 'no category or order appears from nowhere');
  assert.equal(r.featured, true);
  const edited = partnerRecord({ ...base, website: 'ak.com', category: ['design'] }, base);
  assert.equal(edited.website, 'https://ak.com');
  assert.deepEqual(edited.category, ['design']);
  assert.ok(!('website' in partnerRecord({ ...base, website: 'javascript:x' }, { ...base, website: 'javascript:x' })), 'an unsafe link goes even when untouched');
});

test('changes to many: Save’s rules for the fields changed, nothing else', () => {
  const b = { name: 'A ', slug: 'a', level: 'signature', order: 4, website: 'http://a.com/', category: 'design' };
  assert.deepEqual(applyPartnerChange(b, { level: 'friend' }), { ...b, level: 'friend', order: 0 });
  assert.deepEqual(applyPartnerChange(b, { featured: true }), { ...b, featured: true });
  assert.ok(!('category' in applyPartnerChange(b, { category: null })), 'null puts it back to none chosen');
  assert.deepEqual(applyPartnerChange({ ...b, level: 'friend', order: undefined }, { category: ['funding'] }).category, ['funding']);
});

test('the shared lists match the site’s schema', () => {
  const cfg = readFileSync(new URL('../src/content/config.ts', import.meta.url), 'utf8');
  const partners = cfg.slice(cfg.indexOf('const partners = defineCollection'), cfg.indexOf('const medialogos'));
  const ids = (re) => [...partners.match(re)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids(/level: z\.enum\(\[([^\]]+)\]/), LEVELS.map((l) => l.id));
  assert.deepEqual(ids(/z\.array\(z\.enum\(\[([^\]]+)\]/), CATEGORIES.map((c) => c.id));
  const mw = readFileSync(new URL('../functions/api/_middleware.js', import.meta.url), 'utf8');
  assert.ok(!mw.includes("'/api/partners-batch'"), 'partners-batch stays admin-only');
});

test('the home page strip: Signature partners with a logo, in their order', () => {
  const strip = homeStrip([{ slug: 'b', name: 'B', level: 'signature', order: 2, logo: img('b') }, { slug: 'a', name: 'A', level: 'signature', order: 1, logo: img('a') }, { slug: 'n', name: 'N', level: 'signature' }, { slug: 'c', name: 'C', level: 'champion', logo: img('c') }]);
  assert.deepEqual(strip.map((p) => p.slug), ['a', 'b']);
  const home = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(home, /signaturePartners = [\s\S]{0,400}\.sort\(/, 'the home page sorts the strip the same way');
});

test('empty margins: what a logo draws, the crop, and how much bigger it would show', () => {
  // 20 × 10, a dark block at x 5..14, y 3..6, the rest white and transparent
  const w = 20, h = 10, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const ink = x >= 5 && x <= 14 && y >= 3 && y <= 6;
    px.set(ink ? [20, 30, 40, 255] : x < 10 ? [255, 255, 255, 255] : [0, 0, 0, 0], i);
  }
  assert.deepEqual(contentBox(px, w, h), { x: 5, y: 3, w: 10, h: 4 });
  assert.equal(contentBox(new Uint8ClampedArray(16), 2, 2), null);
  const crop = cropBox({ x: 5, y: 3, w: 10, h: 4 }, w, h);
  assert.deepEqual(crop, { x: 3, y: 1, w: 14, h: 8 });
  // Mohawk: 412 × 132 drawn inside a 600 × 600 file shows ~4× smaller than it could on a Signature card
  const f = marginFactor([600, 600], cropBox({ x: 94, y: 234, w: 412, h: 132 }, 600, 600), 'signature');
  assert.ok(f > 3.5 && f < 4.5 && f >= MARGIN_WARN, `factor ${f}`);
  assert.equal(marginFactor([400, 120], { x: 0, y: 0, w: 400, h: 120 }, 'friend'), 1);
  assert.equal(issuesOf({ name: 'A', logo: img('x'), website: 'a.com', category: 'build' }, { margins: 3.2 })[0].id, 'margins');
  // SVG: a new viewBox around the content, drawn 200 × 100 from a 0 0 400 200 box
  assert.deepEqual(svgCropViewBox([0, 0, 400, 200], 200, 100, { x: 50, y: 25, w: 100, h: 50 }), [100, 50, 200, 100]);
  // A taller drawing (letterboxed): 200 × 200 from 0 0 400 200 has 50px bands top and bottom
  assert.deepEqual(svgCropViewBox([0, 0, 400, 200], 200, 200, { x: 0, y: 50, w: 200, h: 100 }), [0, 0, 400, 200]);
});

test('who a name probably means: typos, shared words, initials', () => {
  const ps = [{ slug: 'cr', name: 'Construction Resources' }, { slug: 'cf', name: 'Comfort Research' }, { slug: 'm', name: 'Marcelino Aguilar Photography' },
    { slug: 'c', name: 'Cobb EMC Foundation' }, { slug: 's', name: 'Sawnee Electric Operation Electrical' }, { slug: 'k', name: 'Kids R Kids Foundation' }, { slug: 'p', name: 'Pella' }];
  const top = (n) => similarPartners(n, ps)[0];
  assert.equal(top('CR Construction').partner.slug, 'cr', 'initials and a shared word beat initials alone');
  assert.equal(top('Marcelino Aquilar Photography').why, 'Nearly the same name');
  assert.equal(top('Cobb Emc Community Foundation').partner.slug, 'c');
  assert.equal(top('Sawnee Electric Round Up').partner.slug, 's');
  assert.ok(top('Kids R Kids').score < 1, 'repeated words don’t count twice');
  assert.equal(top('pella ').score, 1);
  assert.deepEqual(similarPartners('Donors', ps), []);
  assert.deepEqual(similarPartners('Pella', ps, { except: 'p' }), []);
});

test('kid pages: folders linked by hand count, a generic "new" folder never guesses', () => {
  const partners = [{ slug: 'construction-resources', name: 'Construction Resources', logo: img('partners/construction-resources/1'), logoFolders: ['cr-construction'] },
    { slug: 'acme', name: 'Acme', logo: img('partners/new/1') }, { slug: 'beta', name: 'Beta', logo: img('partners/new/2') }];
  const kids = [{ slug: 'k', name: 'K', partnerLogos: [{ url: img('partners/cr-construction-v2') }, { url: img('partners/new/9') }, { url: img('partners/new/1') }] }];
  const { byPartner, unmatched } = kidUsage(kids, partners);
  assert.deepEqual(byPartner.get('construction-resources').map((k) => k.slug), ['k'], 'cr-construction-v2 is the linked folder under a later name');
  assert.deepEqual(byPartner.get('acme').map((k) => k.slug), ['k'], 'the exact file still matches');
  assert.equal(byPartner.has('beta'), false);
  assert.deepEqual(unmatched.map((g) => g.folders), [['new']]);
});

test('sections: order, then name, as the Partners page sorts them', () => {
  const s = sections([
    { slug: 'b', name: 'Beta', level: 'signature', order: 1 },
    { slug: 'a', name: 'Alpha', level: 'signature', order: 1 },
    { slug: 'z', name: 'Zed', level: 'signature', order: 0 },
    { slug: 'f', name: 'Friend', category: 'design' },
  ]);
  assert.deepEqual(s.signature.map((p) => p.slug), ['z', 'a', 'b']);
  assert.deepEqual(s.friend[0].category, ['design']);
  assert.equal(nextOrder([{ level: 'champion', order: 4 }, { level: 'champion' }, { level: 'signature', order: 9 }], 'champion'), 5);
});

test('logo sharpness: twice the box is sharp, once is soft, less is blurry; SVGs always sharp', () => {
  assert.equal(logoQuality([400, 120], 'friend').verdict, 'sharp');
  assert.equal(logoQuality([120, 40], 'friend').verdict, 'soft');
  assert.equal(logoQuality([60, 20], 'friend').verdict, 'blurry');
  assert.equal(logoQuality([300, 90], 'signature').verdict, 'soft');
  assert.equal(logoQuality([1200, 400], 'signature').verdict, 'sharp');
  // Signature logos also fill the home page strip (up to 145 × 64): a square one is drawn bigger there
  assert.equal(logoQuality([125, 125], 'champion').verdict, 'sharp');
  assert.equal(logoQuality([125, 125], 'signature').verdict, 'soft');
  assert.equal(logoQuality([125, 125], 'signature').need, 128);
  assert.equal(logoQuality('svg', 'signature').vector, true);
  assert.equal(logoQuality(null), null);
});

test('what needs attention, by level', () => {
  const ids = (p, ctx) => issuesOf(p, ctx).map((i) => `${i.id}:${i.tone}`);
  assert.deepEqual(ids({ name: 'A', level: 'friend' }), ['logo:warn', 'website:info', 'category:info']);
  assert.deepEqual(ids({ name: 'A', level: 'signature', logo: img('x'), website: 'a.com', category: ['build'] }), ['tagline:info']);
  assert.deepEqual(ids({ name: 'A', level: 'champion', logo: img('x'), website: 'a.com' }), [], 'champions have no directory category');
  assert.deepEqual(ids({ name: 'A', logo: img('x'), website: 'nope', category: 'build' }, { broken: true }), ['logo:warn', 'website:warn']);
  assert.deepEqual(ids({ name: 'A', logo: img('x'), website: 'a.com', category: 'build' }, { size: [60, 20] }), ['logo-small:warn']);
  assert.deepEqual(ids({ name: 'A', logo: img('x'), website: 'a.com', category: 'build' }, { dupes: ['B'] }), ['duplicate:warn']);
  assert.equal(issuesOf({ name: 'A' }).find((i) => i.id === 'logo').label, 'No logo');
  assert.deepEqual(ids({ name: 'A', logo: img('x'), website: 'a.com', category: 'build' }, { blank: true }), ['logo-blank:warn'], 'a file that draws nothing is a blank logo');
  assert.equal(communityIssues({ name: 'A', logo: img('x'), website: 'a.org' }, { blank: true })[0].id, 'logo-blank');
});

test('kid pages: a logo finds its partner by file, by folder, or by an older folder name', () => {
  const partners = [
    { slug: 'cambria-black', name: 'Cambria', logo: img('partners/cambria-black/public') },
    { slug: 'tko-plumbing-services', name: 'TKO Plumbing Services', logo: img('partners/tko-plumbing') },
    { slug: 'bell', name: 'Bell', logo: img('partners/bell/123') },
    { slug: 'reliable-heating-and-air', name: 'Reliable Heating & Air', logo: img('partners/reliable-heating-and-air') },
  ];
  const kids = [
    { slug: 'a', name: 'Ann', year: 2024, partnerLogos: [{ url: img('partners/bell/123') }, { url: img('partners/cambria') }, { url: `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/partners/bell/123/w=200` }] },
    { slug: 'b', name: 'Bo', year: 2026, partnerLogos: [{ url: img('partners/tko-plumbing-2023') }, { url: img('partners/reliable-heatingair') }, { url: img('partners/cr-construction-v2'), name: 'CR Construction' }] },
    { slug: 'c', name: 'Cy', year: 2019, partnerLogos: [{ url: img('partners/cr-construction') }, { url: img('kids/c/partner-1') }] },
    { slug: 'd', name: 'Di', year: 2025, publishStatus: 'draft', partnerLogos: [{ url: img('partners/bell/123') }] },
  ];
  const { byPartner, unmatched } = kidUsage(kids, partners);
  assert.deepEqual(byPartner.get('bell').map((k) => k.slug), ['a'], 'once per kid, and drafts aren’t on the site');
  assert.deepEqual(byPartner.get('cambria-black').map((k) => k.slug), ['a']);
  assert.deepEqual(byPartner.get('tko-plumbing-services').map((k) => k.slug), ['b']);
  assert.deepEqual(byPartner.get('reliable-heating-and-air').map((k) => k.slug), ['b']);
  assert.equal(unmatched.length, 1, 'kid-only images aren’t partner logos');
  assert.equal(unmatched[0].name, 'CR Construction');
  assert.deepEqual(unmatched[0].kids.map((k) => k.slug), ['b', 'c'], 'newest first');
  assert.equal(unmatched[0].url, img('partners/cr-construction-v2'), 'starts from the newest build’s logo');
});

test('possible duplicates: same name or same website, social pages aside', () => {
  const d = duplicatesOf([
    { slug: 'a', name: 'Deck South', website: 'https://decksouth.com' },
    { slug: 'b', name: '33N', website: 'decksouth.com/33n' },
    { slug: 'c', name: 'The Drake Co.', website: 'https://facebook.com/x' },
    { slug: 'e', name: 'Drake', website: 'https://facebook.com/y' },
    { slug: 'f', name: 'Solo' },
  ]);
  assert.deepEqual(d.get('a'), ['b']);
  assert.deepEqual(d.get('c'), ['e'], 'by name ("The" and "Co." aside), not by Facebook');
  assert.equal(d.has('f'), false);
});

test('media logo history reads like the strip', () => {
  assert.deepEqual(describeMediaChanges({ name: 'AJC', logo: img('a') }, { name: 'The AJC', logo: img('b') }).map((c) => c.label), ['Outlet', 'Logo']);
});

test('history and export read like the site', () => {
  const c = describeChanges({ name: 'A', level: 'friend', category: 'build' }, { name: 'A', level: 'champion', category: ['build'], logo: img('x') });
  assert.deepEqual(c.map((x) => x.label), ['Level', 'Logo']);
  assert.equal(c[0].detail, 'Friend → Champion');
  assert.deepEqual(changedLabels(['level', 'category', 'sortOrder']), ['Level', 'Categories']);
  const csv = partnersCsv([{ slug: 'b', name: 'Bell', level: 'signature', website: 'https://bell.com' }, { slug: 'f', name: 'F, Inc' }],
    new Map([['b', [{ slug: 'k', year: 2026 }]]]));
  assert.ok(csv.startsWith('﻿Name,Level'));
  assert.ok(csv.includes('Bell,Signature,Build,https://bell.com,,,1,2026,No'));
  assert.ok(csv.includes('"F, Inc",Friend'));
});

test('where a partner shows, search, and image sizes', () => {
  assert.deepEqual(placesOf({ name: 'A', level: 'signature', logo: img('x') }).map((p) => p.id), ['signature', 'home']);
  assert.deepEqual(placesOf({ name: 'A', level: 'builder', category: ['design', 'funding'] }).map((p) => p.label), ['Directory: Design, Funding']);
  assert.equal(matches({ name: 'Pella', website: 'pella.com' }, 'PELL'), true);
  assert.equal(matches({ name: 'Pella', category: 'design' }, 'design'), true);
  assert.equal(matches({ name: 'Pella' }, 'zz'), false);
  assert.equal(cfId(img('partners/bell/1')), 'partners/bell/1');
  assert.equal(logoSrc(img('partners/bell/1'), 160, 80), `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/partners/bell/1/w=160,h=80,fit=contain,q=80`);
  assert.equal(logoSrc('blob:x', 1, 1), 'blob:x');
});

test('community partners: the page lists those with a logo; Save tidies the record', () => {
  assert.equal(communityListed({ name: 'A' }), false);
  assert.deepEqual(communityIssues({ name: 'A' }).map((i) => i.id), ['logo', 'website']);
  const r = communityRecord({ name: ' A ', description: ' x ', category: 'bogus', website: 'a.org', impact: '', location: ' Roswell ' });
  assert.deepEqual(r, { name: 'A', description: 'x', category: 'community', website: 'https://a.org', location: 'Roswell', order: 0, featured: false });
  assert.deepEqual(describeCommunityChanges({ name: 'A', description: 'x' }, { name: 'A', description: 'y', logo: img('l') }).map((c) => c.label), ['Logo', 'About']);
  assert.deepEqual(pressUsing([{ outletLogo: 'ajc' }, { outletLogo: 'fox5' }], 'ajc').length, 1);
});

// ── Many partners at once ──

const P = (slug, extra = {}) => ({ slug, name: slug.toUpperCase(), logo: img(`partners/${slug}/1`), level: 'friend', ...extra });

test('moving partners into a section lines them up after the ones there; into the directory, A to Z', async () => {
  const DB = await db({ partners: [P('s1', { level: 'signature', order: 0 }), P('s2', { level: 'signature', order: 4 }), P('f1'), P('f2', { category: 'design' }), P('c1', { level: 'champion', order: 2 })] });
  const r = await updatePartners({ DB }, [{ slug: 'f1', set: { level: 'signature' } }, { slug: 'f2', set: { level: 'signature' } }, { slug: 'c1', set: { level: 'builder' } }], 'p@x.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ['f1', 'f2', 'c1']);
  assert.equal((await rowOf(DB, 'partners', 'f1')).data.order, 5);
  assert.equal((await rowOf(DB, 'partners', 'f2')).data.order, 6);
  const c1 = await rowOf(DB, 'partners', 'c1');
  assert.equal(c1.data.order, 0);
  assert.equal(c1.level, 'builder', 'the indexed level column follows');
  assert.equal((await rowOf(DB, 'partners', 'f2')).data.category, 'design', 'the rest of the record is kept exactly');
  const audit = (await DB.prepare('SELECT entity_slug FROM audit_log ORDER BY id').all()).results.map((a) => a.entity_slug);
  assert.deepEqual(audit, ['f1', 'f2', 'c1']);
  const versions = (await DB.prepare("SELECT slug FROM content_versions WHERE collection = 'partners'").all()).results;
  assert.ok(versions.length >= 3, 'each save is kept in history');
});

test('categories: add and remove on each partner’s own list; the last one stays', async () => {
  const DB = await db({ partners: [P('a', { category: ['build'] }), P('b', { category: 'funding' }), P('c')] });
  await updatePartners({ DB }, [{ slug: 'a', add: ['design'] }, { slug: 'b', add: ['design'], remove: ['funding'] }, { slug: 'c', remove: ['build'] }]);
  assert.deepEqual((await rowOf(DB, 'partners', 'a')).data.category, ['build', 'design']);
  assert.deepEqual((await rowOf(DB, 'partners', 'b')).data.category, ['design']);
  assert.ok(!('category' in (await rowOf(DB, 'partners', 'c')).data), 'taking away the last leaves it as it was: none chosen');
  const r = await updatePartners({ DB }, [{ slug: 'a', set: { featured: true } }, { slug: 'b', set: { category: ['community'], order: 0, level: 'friend' } }]);
  assert.deepEqual(r.body.changed, ['a', 'b']);
  assert.equal((await rowOf(DB, 'partners', 'a')).featured, 1);
  assert.deepEqual((await rowOf(DB, 'partners', 'b')).data.category, ['community'], 'Undo puts a whole list back');
  await updatePartners({ DB }, [{ slug: 'a', set: { category: ['funding'] }, add: ['design'] }, { slug: 'b', set: { category: null } }]);
  assert.deepEqual((await rowOf(DB, 'partners', 'a')).data.category, ['funding', 'design'], 'add applies after a whole list');
  assert.ok(!('category' in (await rowOf(DB, 'partners', 'b')).data), 'null: back to none chosen');
});

test('a change to many touches only what was asked: no category, website or tagline appears changed', async () => {
  const DB = await db({ partners: [P('w', { website: 'http://w.com/', tagline: '  hi ', name: 'W ' })] });
  await updatePartners({ DB }, [{ slug: 'w', set: { featured: true } }]);
  const d = (await rowOf(DB, 'partners', 'w')).data;
  assert.deepEqual({ website: d.website, tagline: d.tagline, name: d.name, category: d.category, featured: d.featured }, { website: 'http://w.com/', tagline: '  hi ', name: 'W ', category: undefined, featured: true });
  const audit = (await DB.prepare("SELECT changes, git_status FROM audit_log WHERE entity_slug = 'w'").first());
  assert.deepEqual(JSON.parse(audit.changes).map((c) => c.field), ['featured']);
  assert.equal(audit.git_status, 'ok');
});

test('a save made meanwhile is kept: the row is read again and changed once more, or skipped', async () => {
  const DB = await db({ partners: [P('a', { tagline: 'old' }), P('b')] });
  // Someone saves partner a between the read and the write
  let hits = 0;
  const racy = { prepare: (q) => DB.prepare(q), batch: async (stmts) => {
    if (hits++ === 0) await DB.prepare('UPDATE partners SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...P('a'), tagline: 'theirs' }), 'a').run();
    return DB.batch(stmts);
  } };
  const r = await updatePartners({ DB: racy }, [{ slug: 'a', set: { featured: true } }, { slug: 'b', set: { featured: true } }]);
  assert.deepEqual(r.body.changed.sort(), ['a', 'b']);
  const a = (await rowOf(DB, 'partners', 'a')).data;
  assert.equal(a.tagline, 'theirs', 'their save is kept');
  assert.equal(a.featured, true, 'and the change still applied');
  // Changed again on the second try: skipped, and said so
  let n = 0;
  const busy = { prepare: (q) => DB.prepare(q), batch: async (stmts) => {
    if (n++ < 2) await DB.prepare('UPDATE partners SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...P('a'), tagline: `again ${n}` }), 'a').run();
    return DB.batch(stmts);
  } };
  const r2 = await updatePartners({ DB: busy }, [{ slug: 'a', set: { featured: false } }]);
  assert.deepEqual(r2.body.changed, []);
  assert.deepEqual(r2.body.conflicts, ['a']);
});

test('logo folders link kid pages to a partner, and unlink', async () => {
  const DB = await db({ partners: [P('cr', { name: 'Construction Resources' })] });
  await updatePartners({ DB }, [{ slug: 'cr', addFolders: ['cr-construction', 'cr-construction-v2'] }]);
  assert.deepEqual((await rowOf(DB, 'partners', 'cr')).data.logoFolders, ['cr-construction', 'cr-construction-v2']);
  await updatePartners({ DB }, [{ slug: 'cr', removeFolders: ['cr-construction', 'cr-construction-v2'] }]);
  assert.ok(!('logoFolders' in (await rowOf(DB, 'partners', 'cr')).data));
  assert.equal((await updatePartners({ DB }, [{ slug: 'cr', addFolders: ['../x'] }])).status, 400);
});

test('only allowed changes, to partners that exist', async () => {
  const DB = await db({ partners: [P('a')] });
  assert.equal((await updatePartners({ DB }, [{ slug: 'a', set: { name: 'Hacked' } }])).status, 400);
  assert.equal((await updatePartners({ DB }, [{ slug: 'a', set: { level: 'platinum' } }])).status, 400);
  assert.equal((await updatePartners({ DB }, [{ slug: 'a', add: ['catering'] }])).status, 400);
  assert.equal((await updatePartners({ DB }, [{ slug: 'a' }])).status, 400);
  assert.equal((await updatePartners({ DB }, [{ slug: 'a', set: { featured: true } }, { slug: 'a', set: { featured: false } }])).status, 400);
  assert.equal((await updatePartners({ DB }, [])).status, 400);
  assert.equal((await updatePartners({ DB }, Array.from({ length: 101 }, (_, i) => ({ slug: `x${i}`, set: { featured: true } })))).status, 400);
  assert.equal((await updatePartners({ DB }, [{ slug: 'zz', set: { featured: true } }])).status, 409);
  const same = await updatePartners({ DB }, [{ slug: 'a', set: { level: 'friend' } }]);
  assert.equal(same.status, 200);
});

test('a new logo reaches every kid page that shows the old one, however its address is written', async () => {
  const old = img('partners/bell/1');
  const kids = [
    { slug: 'k1', name: 'K1', partnerLogos: [{ url: old }, { url: img('partners/x/1'), name: 'X' }] },
    { slug: 'k2', name: 'K2', partnerLogos: [{ url: `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${HASH}/partners/bell/1/w=200`, name: 'Bell Cabinetry' }] },
    { slug: 'k3', name: 'K3', partnerLogos: [{ url: img('partners/other/1') }] },
  ];
  const DB = await db({ kids });
  const r = await swapLogo({ DB }, { from: old, to: img('partners/bell/2'), name: 'Bell' }, 'p@x.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ['k1', 'k2']);
  assert.deepEqual((await rowOf(DB, 'kids', 'k1')).data.partnerLogos, [{ url: img('partners/bell/2'), name: 'Bell' }, { url: img('partners/x/1'), name: 'X' }]);
  assert.equal((await rowOf(DB, 'kids', 'k2')).data.partnerLogos[0].name, 'Bell Cabinetry', 'a name written by hand stays');
  assert.equal((await rowOf(DB, 'kids', 'k3')).data.partnerLogos[0].url, img('partners/other/1'));
  const versions = (await DB.prepare("SELECT slug FROM content_versions WHERE collection = 'kids'").all()).results.map((v) => v.slug);
  assert.ok(versions.includes('k1') && versions.includes('k2') && !versions.includes('k3'), 'each kid page changed keeps its history');
  assert.equal((await swapLogo({ DB }, { from: old, to: old })).status, 400);
  assert.equal((await swapLogo({ DB }, { from: 'javascript:alert(1)', to: old })).status, 400);
});

test('partners, community partners and media logos can be reordered in one request', async () => {
  const DB = await db({ partners: [P('a', { level: 'signature', order: 0 }), P('b', { level: 'signature', order: 1 })] });
  const r = await reorder({ DB }, { collection: 'partners', items: [{ slug: 'b', order: 0 }, { slug: 'a', order: 1 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.sort(), ['a', 'b']);
  assert.equal((await rowOf(DB, 'partners', 'b')).data.order, 0);
  await DB.prepare('INSERT INTO medialogos (slug, name, data) VALUES (?, ?, ?)').bind('ajc', 'AJC', JSON.stringify({ slug: 'ajc', name: 'AJC', order: 3 })).run();
  const m = await reorder({ DB }, { collection: 'medialogos', items: [{ slug: 'ajc', order: 0 }] });
  assert.equal(m.status, 200);
  assert.equal((await rowOf(DB, 'medialogos', 'ajc')).data.order, 0);
});
