/**
 * first-screen-check.mjs: every page that holds its first paint for a marker has that marker, after `astro build`
 * ==================================================================================================================
 * A page whose layout has firstScreenEnd tells Chrome to paint only once #first-screen-end has arrived
 * (<link rel="expect" ... blocking="render">, src/components/global/FirstScreenEnd.astro). A page without that
 * marker would show nothing until the whole page had downloaded. The build fails, naming the page, on any
 * rel="expect" whose element isn't in the page.
 *
 * Run: node scripts/first-screen-check.mjs [outDir]   (default dist; `npm run build` runs it)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The ids a page's first paint waits for that the page doesn't have */
export function missingTargets(html) {
  const missing = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*\brel=["']?expect\b[^>]*>/gi)) {
    const id = /\bhref=["']?#([^"'\s>]+)/i.exec(tag)?.[1];
    if (!id) { missing.push(tag); continue; }
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\bid=["']?${esc}(?=["'\\s>])`).test(html)) missing.push(`#${id}`);
  }
  return missing;
}

function* pages(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* pages(p);
    else if (name.endsWith('.html')) yield p;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = process.argv[2] || 'dist';
  const errors = [];
  let held = 0;
  for (const file of pages(outDir)) {
    const html = readFileSync(file, 'utf8');
    if (/\brel=["']?expect\b/i.test(html)) held++;
    for (const m of missingTargets(html)) errors.push(`${relative(outDir, file)}: its first paint waits for ${m}, which isn't in the page`);
  }
  if (errors.length) {
    console.error(`[first-screen-check] ${errors.length} page(s) would show nothing until they had fully downloaded:`);
    for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
    console.error('  Put <FirstScreenEnd /> in the page (outside any condition), or take firstScreenEnd off its layout.');
    process.exit(1);
  }
  console.log(`[first-screen-check] ${held} page(s) hold their first paint for their first screen; every marker is there`);
}
