/**
 * A kid's gallery photo full size (src/utils/lightbox-photo.ts): the lightbox makes it from the cell's own picture,
 * so the page no longer carries every photo's full-size addresses. They must be exactly the ones the page used to
 * name, for every photo of every kid, so the browser's copy of a photo it already has is the one it uses.
 * Run: node --test tests/lightbox-photo.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildSync } from 'esbuild';

const load = (entry) => import(`data:text/javascript,${encodeURIComponent(buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].text)}#${Math.random()}`);
const { lightboxPhoto, LIGHTBOX_WIDTHS, LIGHTBOX_WIDTH } = await load('src/utils/lightbox-photo.ts');
const { cfRaw, cfSrcset } = await load('src/utils/cf-image.ts');
const page = readFileSync('src/pages/kids/[slug].astro', 'utf8');

test('every gallery photo of every kid opens at the addresses the page used to name', () => {
  let photos = 0;
  for (const f of readdirSync('src/content/kids').filter((n) => n.endsWith('.json'))) {
    const kid = JSON.parse(readFileSync(`src/content/kids/${f}`, 'utf8'));
    (kid.photos || []).slice(0, 30).forEach((photo, i) => {
      // The cell's picture: the first two are the large ones
      const thumb = cfRaw(photo.url, i < 2 ? 'w=1200,q=85' : 'w=700,q=85');
      assert.deepEqual(lightboxPhoto(thumb), { src: cfRaw(photo.url, 'w=1600,q=85'), srcset: cfSrcset(photo.url, [800, 1200, 1600, 2400]) }, `${f} photo ${i + 1}`);
      photos++;
    });
  }
  assert.ok(photos > 1000, `${photos} photos checked`);
});

test('the gallery cells carry only their picture; the hidden plan entries name their crop at the same widths', () => {
  assert.deepEqual([LIGHTBOX_WIDTHS, LIGHTBOX_WIDTH], [[800, 1200, 1600, 2400], 1600]);
  const cells = [...page.matchAll(/class="masonry__item gallery__cell[^"]*"[\s\S]*?<img/g)].map((m) => m[0]);
  assert.equal(cells.length, 3, 'the two large photos, the next six, the rest');
  for (const c of cells) assert.doesNotMatch(c, /data-src|data-srcset|data-alt/);
  assert.match(page, /data-src=\{planUrl\(plan, LIGHTBOX_WIDTH\)\}\s+data-srcset=\{planSrcset\(plan, LIGHTBOX_WIDTHS\)\}/);
  assert.match(page, /if \(item\.dataset\.src\) return \{ src: item\.dataset\.src/);
  assert.match(page, /return \{ \.\.\.lightboxPhoto\(thumb\?\.getAttribute\('src'\) \|\| ''\), alt: thumb\?\.alt \|\| '' \};/);
  // The admin's Preview builds its cells the same way
  assert.doesNotMatch(readFileSync('public/admin/kid-preview.js', 'utf8'), /b\.dataset\.src = cfRaw\(photo\.url/);
});
