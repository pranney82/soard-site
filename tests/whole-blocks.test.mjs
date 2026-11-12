/**
 * "Whole when it shows" (src/styles/global.css): a block marked data-whole keeps its children invisible until its
 * last child, <span data-whole-end hidden></span>, has arrived. One without it would never show, so every data-whole
 * in the site's templates must end with its marker, and the menu bar and every split hero must have one.
 * Run: node --test tests/whole-blocks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.astro') ? [p] : []; });
const files = walk('src');
const END = '<span data-whole-end hidden></span>';

/** Every opening tag carrying data-whole, with what comes right before its closing tag */
function wholes(src) {
  const out = [];
  const open = /<([a-z][a-z0-9-]*)\b[^>]*\sdata-whole(?=[\s>])[^>]*>/gi;
  for (const m of src.matchAll(open)) {
    const name = m[1].toLowerCase();
    const tag = new RegExp(`<${name}\\b|</${name}>`, 'gi');
    tag.lastIndex = m.index + m[0].length;
    let depth = 1;
    let t;
    while (depth && (t = tag.exec(src))) depth += t[0].startsWith('</') ? -1 : 1;
    const close = t ? t.index : -1;
    out.push({ tag: m[0].slice(0, 80), before: close < 0 ? '' : src.slice(0, close).trimEnd() });
  }
  return out;
}

test('every data-whole block ends with its marker, so it always shows', () => {
  let n = 0;
  for (const f of files) {
    for (const w of wholes(readFileSync(f, 'utf8'))) {
      n++;
      assert.ok(w.before.endsWith(END), `${f}: ${w.tag} must end with ${END}`);
    }
  }
  assert.ok(n >= 20, `the menu bar and the split heroes are marked (${n} found)`);
});

test('the menu bar and every split hero are whole when they show', () => {
  const header = readFileSync('src/components/global/Header.astro', 'utf8');
  assert.match(header, /<div class="header-inner" data-whole>/);
  assert.match(header, /class="logo"[^>]*data-whole-keep/, 'the logo shows from the start');
  // A split hero is one using the shared top spacing
  for (const f of files.filter((p) => /var\(--hero-space-top\)/.test(readFileSync(p, 'utf8')))) {
    assert.match(readFileSync(f, 'utf8'), /<section\b[^>]*\bdata-whole[\s>]/, `${f}: its hero is data-whole`);
  }
});

/**
 * Blocks on a first screen whose pieces lay each other out without the shared hero spacing: each of these moved on
 * a slow connection (Nov 11 2026, 300 ms / 400 kbps at laptop and phone widths) while its pieces arrived
 */
test('the other first-screen blocks whose pieces lay each other out are whole too', () => {
  const blocks = {
    'src/components/global/ApplicationBar.astro': /<aside id="apply-bar"[^>]*\sdata-whole>/, // its words centred, the close button last
    'src/layouts/PageLayout.astro': /<section class="page-hero" data-whole>/, // centred label, headline and subtitle
    'src/components/ui/MediaLogos.astro': /<div class="ml" data-theme=\{theme\} data-whole>/, // a centred row of logos
    'src/components/events/EventRecap.astro': /<section class="rh" aria-labelledby="rh-title" data-whole>/,
    'src/pages/kids/[slug].astro': /<section class="hero" id="chapter-meet"[^>]*\sdata-whole>/, // words centred beside the photo
    'src/pages/about/index.astro': /<section class="founders" id="our-story"[^>]*\sdata-whole>/,
    'src/pages/about/financials.astro': /<section class="hero" data-whole>/,
    'src/pages/about/leadership.astro': /<div class="founders-row" data-whole>[\s\S]*<div class="ribbon-inner" data-whole>|<div class="ribbon-inner" data-whole>[\s\S]*<div class="founders-row" data-whole>/,
    'src/pages/publicity.astro': /<div class="stats__row" data-whole>/,
    'src/pages/sunny-and-ranney.astro': /<section class="sr-hero" data-whole>/,
    'src/pages/events/[slug].astro': /<section class="ev-hero" data-whole>/,
    'src/pages/community/[slug].astro': /<section class="cp-detail-hero"[^>]*\sdata-whole>/,
    'src/pages/branding.astro': /<section class="brand-hero" data-whole>/,
    'src/pages/profile-update.astro': /<section class="pu-hero" data-whole>/,
    'src/pages/404.astro': /<section class="lost" data-whole>/,
    'src/components/global/Footer.astro': /<div class="footer-container footer-newsletter-inner" data-whole>/, // the newsletter words centred beside its form
    'src/pages/kids/index.astro': /<section class="kids-hero"[^>]*\sdata-whole>[\s\S]*<div class="kid-card__frame"[^>]*\sdata-whole>/, // and each card: its badge grows leftward as its words arrive
  };
  for (const [f, re] of Object.entries(blocks)) assert.match(readFileSync(f, 'utf8'), re, `${f}: its first-screen block is data-whole`);
});

test('the rule itself: children hidden, their space kept, until the marker arrives', () => {
  const css = readFileSync('src/styles/global.css', 'utf8');
  assert.match(css, /\[data-whole\]:not\(:has\(> \[data-whole-end\]\)\) > :not\(\[data-whole-keep\]\) \{ visibility: hidden; \}/);
});
