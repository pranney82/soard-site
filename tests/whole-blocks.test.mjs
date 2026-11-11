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

test('the rule itself: children hidden, their space kept, until the marker arrives', () => {
  const css = readFileSync('src/styles/global.css', 'utf8');
  assert.match(css, /\[data-whole\]:not\(:has\(> \[data-whole-end\]\)\) > :not\(\[data-whole-keep\]\) \{ visibility: hidden; \}/);
});
