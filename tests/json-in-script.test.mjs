/**
 * JSON written into a page's <script> (JSON-LD, data for the page's own
 * script) can't end the script early: a kid's name or a press headline
 * holding "</script>" would otherwise become markup. Every
 * set:html={JSON.stringify(…)} in src escapes "<" as <, the way
 * how-it-works.astro and functions/apply/form do. And the kids page's
 * escapeHtml is safe inside a quoted attribute.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const astroFiles = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? astroFiles(p) : p.endsWith('.astro') ? [p] : [];
});

test('every JSON.stringify written into a <script> escapes “<”', () => {
  let seen = 0;
  for (const file of astroFiles(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<script\b[^>]*\sset:html=\{JSON\.stringify\(/g)) {
      seen += 1;
      // The expression runs to the tag's end ("} />" or "}>")
      const rest = src.slice(m.index);
      const expr = rest.slice(0, rest.search(/\}\s*\/?>/) + 1);
      assert.ok(expr.includes(".replace(/</g, '\\\\u003c')"), `${file.slice(ROOT.length)}: ${expr.slice(0, 80)}…`);
    }
  }
  assert.ok(seen >= 3, `found ${seen}`);
  // What the escape does: the same data, and no way out of the script
  const data = { name: 'Ava</script><script>alert(1)</script>', headline: '<!-- x' };
  const out = JSON.stringify(data).replace(/</g, '\\u003c');
  assert.ok(!out.includes('<'));
  assert.deepEqual(JSON.parse(out), data);
});

test('the kids page’s escapeHtml is safe in text and in a quoted attribute', () => {
  const src = readFileSync(join(ROOT, 'src/pages/kids/index.astro'), 'utf8');
  const body = src.match(/function escapeHtml\(s: string\): string \{([\s\S]*?)\n\s*\}/)[1];
  const escapeHtml = new Function('s', body);
  assert.equal(escapeHtml(`Ava" onerror="alert(1)`), 'Ava&quot; onerror=&quot;alert(1)');
  assert.equal(escapeHtml(`O'Neil <b>&`), 'O&#39;Neil &lt;b&gt;&amp;');
  // Every alt="…" the card builds goes through it
  assert.match(src, /const alt = escapeHtml\(/);
});
