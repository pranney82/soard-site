/**
 * A page holds its first paint until its first screen has arrived (src/components/global/FirstScreenEnd.astro):
 * the layout's firstScreenEnd and the page's <FirstScreenEnd /> go together, and the build fails on a page that
 * waits for a marker it doesn't have (scripts/first-screen-check.mjs).
 * Run: node --test tests/first-screen.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { missingTargets } from '../scripts/first-screen-check.mjs';

const HOLD = '<link rel="expect" href="#first-screen-end" blocking="render">';

test('the build check: a hold whose marker is in the page passes; one without it is named', () => {
  assert.deepEqual(missingTargets(`<head>${HOLD}</head><body><section>…</section><span id="first-screen-end" hidden></span></body>`), []);
  assert.deepEqual(missingTargets(`<head>${HOLD}</head><body><section>…</section></body>`), ['#first-screen-end']);
  assert.deepEqual(missingTargets('<head></head><body><span id="first-screen-end" hidden></span></body>'), [], 'a marker alone holds nothing');
  assert.deepEqual(missingTargets(`<head>${HOLD}</head><body><div id="first-screen-end-2"></div></body>`), ['#first-screen-end'], 'a longer id is not the marker');
  assert.deepEqual(missingTargets('<head><link rel=expect href=#hero blocking=render></head><body><div id=hero></div></body>'), [], 'unquoted attributes');
});

test('BaseLayout holds the first paint only when asked, and PageLayout passes it on', () => {
  const base = readFileSync('src/layouts/BaseLayout.astro', 'utf8');
  assert.match(base, /\{firstScreenEnd && <link rel="expect" href="#first-screen-end" blocking="render" \/>\}/);
  assert.match(base, /firstScreenEnd = false,/);
  assert.match(readFileSync('src/layouts/PageLayout.astro', 'utf8'), /firstScreenEnd=\{firstScreenEnd\}/);
  assert.match(readFileSync('src/components/global/FirstScreenEnd.astro', 'utf8'), /<span id="first-screen-end" hidden><\/span>/);
});

/** Every page that turns the hold on marks its first screen, itself or through the one component that draws it */
test('each page that holds its first paint marks where its first screen ends', () => {
  const pages = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.astro')) pages.push(p); } };
  walk('src/pages');
  const holding = pages.filter((p) => /^\s*firstScreenEnd(=\{[^}]+\})?\s*$|\sfirstScreenEnd>/m.test(readFileSync(p, 'utf8')));
  assert.ok(holding.length >= 10, `pages that hold: ${holding.join(', ')}`);
  // Gala and golf hold only while they show the recap, which marks its own first screen
  for (const p of ['src/pages/events/gala.astro', 'src/pages/events/golf.astro']) assert.match(readFileSync(p, 'utf8'), /firstScreenEnd=\{over\}[\s\S]*\{over \? \(\s*<EventRecap\b/);
  for (const p of holding) {
    const src = readFileSync(p, 'utf8');
    const marks = (src.match(/<FirstScreenEnd \/>/g) || []).length + (/<EventRecap\b/.test(src) ? 1 : 0);
    assert.ok(marks >= 1, `${p} holds its first paint but has no <FirstScreenEnd />`);
  }
  assert.match(readFileSync('src/components/events/EventRecap.astro', 'utf8'), /<\/section>\n\s+\{\/\*[^*]*\*\/\}\n\s+<FirstScreenEnd \/>/, 'the recap marks the end of its hero');
});
