/**
 * scripts/csp-hash.mjs: the post-build step that allows the site's inline
 * scripts by hash in dist/_headers, and fails the build on inline handlers.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanHtml, hashScript, renderHeaders, policyDrift, patternRegex, urlForFile, cspHash, hasPlaceholder, PLACEHOLDER, MAX_LINE } from '../scripts/csp-hash.mjs';

const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const ROOT = new URL('..', import.meta.url).pathname;

test('finds the inline scripts that run, and skips data, external files and markup in raw text', () => {
  const html = `<!doctype html><html><head>
    <script>var a = 1;</script>
    <script type="module">import('/x.js')</script>
    <script type="text/javascript">b()</script>
    <script type="application/ld+json">{"@type":"Organization"}</script>
    <script type="application/json" id="cfg">{"a":"<b onclick=x>"}</script>
    <script type="module" src="/_astro/page.js"></script>
    <script src="/sw.js">ignored()</script>
    <meta name="astro-view-transitions-enabled" content="true">
    </head><body>
    <!-- <img onerror="commented()"> -->
    <textarea><img src=x onerror=alert(1)></textarea>
    <p data-onerror="fine" title="onclick=no">x</p>
    <SCRIPT>upper()</SCRIPT>
  </body></html>`;
  const scan = scanHtml(html);
  assert.deepEqual(scan.scripts.map((s) => s.body), ['var a = 1;', "import('/x.js')", 'b()', 'upper()']);
  assert.deepEqual(scan.scripts.map((s) => s.type), ['classic', 'module', 'text/javascript', 'classic']);
  assert.deepEqual(scan.handlers, []);
  assert.deepEqual(scan.jsUrls, []);
  assert.equal(scan.clientRouter, true);
});

test('a script body with markup in it is one script, read to its end tag', () => {
  const body = 'const t = html`<img onerror=${f} src="a>b">`; if (a < b && c > d) go();';
  const scan = scanHtml(`<script type="module">${body}</script><p>after</p>`);
  assert.deepEqual(scan.scripts.map((s) => s.body), [body]);
  assert.deepEqual(scan.handlers, [], 'Preact props inside a script are not HTML attributes');
});

test('inline handlers and javascript: URLs are caught, quoted or not', () => {
  const scan = scanHtml(`<img src="a.png" onerror="this.remove()"><div ONCLICK=go()></div>
    <a href="javascript:void(0)">x</a><a href=" &#106;avascript:alert(1)">y</a><iframe src="https://ok.example/"></iframe>
    <img alt="a > b" onload='x()'>`);
  assert.equal(scan.handlers.length, 3);
  assert.match(scan.handlers[0], /^onerror= on <img>/);
  assert.match(scan.handlers[1], /^onclick= on <div>/);
  assert.match(scan.handlers[2], /^onload= on <img>/, 'a > inside a quoted value does not end the tag');
  assert.equal(scan.jsUrls.length, 2);
});

test('hashes match what the browser computes (UTF-8, CRLF read as LF)', () => {
  assert.equal(hashScript('alert(1)'), sha('alert(1)'));
  assert.equal(hashScript('a\r\nb\rc'), sha('a\nb\nc'));
  assert.equal(hashScript('"☀"'), sha(Buffer.from('"☀"', 'utf8')));
});

test('_headers patterns and built file paths', () => {
  assert.ok(patternRegex('/admin/*').test('/admin/'));
  assert.ok(patternRegex('/admin/*').test('/admin/kid-template/a/'));
  assert.ok(!patternRegex('/admin/*').test('/administrator/'));
  assert.ok(patternRegex('/*').test('/'));
  assert.ok(patternRegex('/apply/form/*').test('/apply/form/'));
  assert.equal(urlForFile('index.html'), '/');
  assert.equal(urlForFile(join('kids', 'eli', 'index.html')), '/kids/eli/');
  assert.equal(urlForFile('404.html'), '/404.html');
});

const ENF = "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.example; img-src 'self'";
const STRICT = `default-src 'none'; script-src 'self' ${PLACEHOLDER} https://cdn.example; script-src-attr 'none'; img-src 'self'; report-uri /api/csp-report; report-to csp`;
const HEADERS = `## comment with /* and ${PLACEHOLDER} in it
/*
  X-Content-Type-Options: nosniff
  Content-Security-Policy: ${ENF}
  Content-Security-Policy-Report-Only: ${STRICT}

/admin/*
  ! Content-Security-Policy
  Content-Security-Policy: ${ENF}
  ! Content-Security-Policy-Report-Only
  Content-Security-Policy-Report-Only: ${STRICT}

/_astro/*
  Cache-Control: public, max-age=31536000, immutable
`;

test('report-only: hashes go into each route\'s strict line, the enforced line is untouched', () => {
  const r = renderHeaders(HEADERS, (p) => (p === '/admin/*' ? ["'sha256-A'"] : ["'sha256-B'", "'sha256-C'"]), { enforce: false });
  assert.deepEqual(r.errors, []);
  const lines = r.text.split('\n');
  assert.ok(lines.includes(`  Content-Security-Policy-Report-Only: ${STRICT.replace(PLACEHOLDER, "'sha256-B' 'sha256-C'")}`));
  assert.ok(lines.includes(`  Content-Security-Policy-Report-Only: ${STRICT.replace(PLACEHOLDER, "'sha256-A'")}`));
  assert.equal(lines.filter((l) => l === `  Content-Security-Policy: ${ENF}`).length, 2);
  assert.equal(lines.filter((l) => l === '  ! Content-Security-Policy-Report-Only').length, 1);
  assert.ok(!hasPlaceholder(r.text), 'no header line keeps the placeholder (the comment may)');
  assert.deepEqual(r.policies.map((p) => [p.pattern, p.hashes.length]), [['/*', 2], ['/admin/*', 1]]);
});

test('ENFORCE: the strict policy becomes the enforced one and the old line goes', () => {
  const r = renderHeaders(HEADERS, () => ["'sha256-A'"], { enforce: true });
  assert.deepEqual(r.errors, []);
  assert.ok(!r.text.includes('Report-Only'));
  assert.ok(!r.text.includes("'unsafe-inline'"));
  const csp = r.text.split('\n').filter((l) => l.startsWith('  Content-Security-Policy: '));
  assert.equal(csp.length, 2);
  for (const l of csp) assert.ok(l.includes("script-src 'self' 'sha256-A' https://cdn.example; script-src-attr 'none'"));
  assert.ok(r.text.includes('  ! Content-Security-Policy\n'), 'the admin block still detaches the site-wide policy');
});

test('no hashes leaves a clean script-src', () => {
  const r = renderHeaders(HEADERS, () => [], { enforce: false });
  assert.ok(r.text.includes("script-src 'self' https://cdn.example; script-src-attr"));
});

test('a Report-Only line that drifted from its enforced line fails', () => {
  assert.equal(policyDrift(ENF, STRICT), '');
  assert.match(policyDrift(ENF, STRICT.replace("img-src 'self'", "img-src 'self' https://x.example")), /img-src differs/);
  assert.match(policyDrift(ENF, STRICT.replace(PLACEHOLDER, `${PLACEHOLDER} 'unsafe-inline'`)), /unsafe-inline/);
  assert.match(policyDrift(`${ENF}; frame-src 'self'`, STRICT), /frame-src is missing/);
  const r = renderHeaders(HEADERS.replace(`Report-Only: ${STRICT}\n\n/admin`, `Report-Only: ${STRICT.replace("img-src 'self'", 'img-src *')}\n\n/admin`), () => []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /_headers \/\*: img-src differs/);
});

test('a line over 2,000 characters fails', () => {
  const many = Array.from({ length: 40 }, (_, i) => `'sha256-${String(i).padStart(43, 'x')}='`);
  const r = renderHeaders(HEADERS, () => many);
  assert.ok(r.errors.some((e) => e.includes(`limit is ${MAX_LINE}`)));
});

/** A small built site in a temp folder */
function site(files) {
  const dir = mkdtempSync(join(tmpdir(), 'csp-hash-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
const NO_SRC = join(tmpdir(), 'csp-hash-no-src');
const ROUTER = '<meta name="astro-view-transitions-enabled" content="true">';

test('a built site: hashes per route, 404 everywhere, client-router pages share', () => {
  const dir = site({
    '_headers': HEADERS,
    'index.html': `${ROUTER}<script>home()</script><script type="application/ld+json">{}</script>`,
    'kids/eli/index.html': `${ROUTER}<script>home()</script><script type="module">kid()</script>`,
    'admin/index.html': '<script type="module">admin()</script>',
    'admin/kid-template/a/index.html': `${ROUTER}<script>preview()</script>`,
    '404.html': '<script>lost()</script>',
  });
  try {
    const r = cspHash(dir, { srcDir: NO_SRC, enforce: false });
    assert.deepEqual(r.errors, []);
    const out = readFileSync(join(dir, '_headers'), 'utf8');
    const [pub, adm] = out.split('/admin/*');
    for (const s of ['home()', 'kid()', 'lost()', 'preview()']) assert.ok(pub.includes(sha(s)), `public policy allows ${s}`);
    assert.ok(!pub.includes(sha('admin()')), 'the admin script stays out of the public policy');
    for (const s of ['admin()', 'preview()', 'home()', 'kid()', 'lost()']) assert.ok(adm.includes(sha(s)), `admin policy allows ${s}`);
    assert.deepEqual(r.policies.map((p) => [p.pattern, p.pages]), [['/*', 3], ['/admin/*', 3]]);
    // Run twice: the placeholder is gone, so a second run says so instead of hashing nothing
    assert.match(cspHash(dir, { srcDir: NO_SRC }).errors[0], /no 'csp-hashes' placeholder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a built page with an inline handler fails the build and writes nothing', () => {
  const dir = site({ '_headers': HEADERS, 'partners/index.html': '<img src="/l.png" onerror="this.style.display=\'none\'">' });
  try {
    const r = cspHash(dir, { srcDir: NO_SRC });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /partners\/index\.html: inline event handler onerror=/);
    assert.match(r.errors[0], /data-img-fallback/);
    assert.ok(readFileSync(join(dir, '_headers'), 'utf8').includes(PLACEHOLDER), '_headers is left as it was');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('<script define:vars> in src/ fails the build', () => {
  const src = site({ 'components/A.astro': '<script is:inline define:vars={{ a }}>use(a)</script>', 'components/B.astro': '<script>ok()</script>' });
  const dir = site({ '_headers': HEADERS, 'index.html': '<p>hi</p>' });
  try {
    const r = cspHash(dir, { srcDir: src });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /A\.astro:1: <script define:vars>/);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repo: public/_headers has a strict line per route that matches its enforced line', () => {
  const r = renderHeaders(readFileSync(join(ROOT, 'public/_headers'), 'utf8'), () => []);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.policies.map((p) => p.pattern), ['/*', '/vendor-documents/*', '/apply/form/*', '/admin/*']);
});
