/**
 * Files on the site's own origin (functions/files/[[path]].js) and what the
 * admin may upload there (functions/api/upload-file.js): a PDF opens in the
 * viewer, anything else downloads, nothing ever runs as a page; uploads are
 * PDFs and pictures by their first bytes, never HTML or SVG.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as serveFile, fileHeaders } from '../functions/files/[[path]].js';
import { onRequestPost as uploadFile, sniffType } from '../functions/api/upload-file.js';

const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46]);
const HTML = new TextEncoder().encode('<!doctype html><script>fetch("/api/save-content",{method:"POST"})</script>');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

function fakeR2(objects = {}) {
  const store = new Map(Object.entries(objects));
  return {
    store,
    async get(key) { const o = store.get(key); return o ? { body: new Blob([o.bytes]).stream(), httpMetadata: { contentType: o.type }, httpEtag: '"e1"' } : null; },
    async put(key, stream, opts) { store.set(key, { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), type: opts?.httpMetadata?.contentType }); },
  };
}
function fakeCache() {
  const m = new Map();
  return { m, async match(req) { const r = m.get(req.url); return r ? r.clone() : undefined; }, async put(req, res) { m.set(req.url, res); } };
}
const serve = async (path, FILES, cache = fakeCache()) => {
  globalThis.caches = { default: cache };
  const waits = [];
  const res = await serveFile({ env: { FILES }, params: { path: path.split('/') }, request: new Request(`https://sunshineonaranneyday.com/files/${path}`), waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
};
const safe = (res, { pdf = false } = {}) => {
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  // A PDF opens in the browser's own viewer; Safari and Firefox won't render it under a sandbox CSP
  assert.equal(res.headers.get('Content-Security-Policy'), pdf ? null : "sandbox; default-src 'none'");
  assert.equal(res.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains; preload');
};

test('a PDF opens in the viewer; anything else downloads, sandboxed', async () => {
  const FILES = fakeR2({
    'financials/990.pdf': { bytes: PDF, type: 'application/pdf' },
    'financials/old.pdf': { bytes: PDF, type: 'application/octet-stream' },
    'financials/evil.html': { bytes: HTML, type: 'text/html' },
    'financials/logo.svg': { bytes: SVG, type: 'image/svg+xml' },
    'financials/license.png': { bytes: PNG, type: 'image/png' },
    'financials/trick.pdf.html': { bytes: HTML, type: 'text/html; charset=utf-8' },
  });
  const pdf = await serve('financials/990.pdf', FILES);
  safe(pdf, { pdf: true });
  assert.equal(pdf.headers.get('Content-Type'), 'application/pdf');
  assert.match(pdf.headers.get('Content-Disposition'), /^inline; filename="990\.pdf"/);
  assert.equal((await serve('financials/old.pdf', FILES)).headers.get('Content-Type'), 'application/pdf', 'named .pdf: shown as a PDF whatever it was stored as');
  for (const key of ['financials/evil.html', 'financials/logo.svg', 'financials/trick.pdf.html']) {
    const res = await serve(key, FILES);
    safe(res);
    assert.equal(res.headers.get('Content-Type'), 'application/octet-stream', key);
    assert.match(res.headers.get('Content-Disposition'), /^attachment;/, key);
  }
  const png = await serve('financials/license.png', FILES);
  safe(png);
  assert.equal(png.headers.get('Content-Type'), 'image/png');
  assert.match(png.headers.get('Content-Disposition'), /^attachment; filename="license\.png"/);
  // Outside financials/, and paths that try to leave it: not found, still sandboxed
  for (const key of ['secret/x.pdf', 'financials/../secret/x.pdf', 'financials/./990.pdf']) {
    const res = await serve(key, FILES);
    assert.equal(res.status, 404, key);
    safe(res);
  }
});

test('a copy cached before these headers leaves with them; a query string doesn’t make another copy', async () => {
  const FILES = fakeR2({ 'financials/evil.html': { bytes: HTML, type: 'text/html' } });
  const cache = fakeCache();
  await serve('financials/evil.html', FILES, cache);
  assert.deepEqual([...cache.m.keys()], ['https://sunshineonaranneyday.com/files/financials/evil.html?v=2']);
  // An old copy under today's key, as the edge might still hold it
  cache.m.set('https://sunshineonaranneyday.com/files/financials/evil.html?v=2', new Response(HTML, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"old"' } }));
  FILES.store.clear();
  const res = await serve('financials/evil.html', FILES, cache);
  assert.equal(res.status, 200);
  safe(res);
  assert.equal(res.headers.get('Content-Type'), 'application/octet-stream');
  assert.match(res.headers.get('Content-Disposition'), /^attachment;/);
  assert.equal(res.headers.get('ETag'), '"old"');
});

test('fileHeaders: names are quoted safely', () => {
  const h = fileHeaders('financials/a "b";c.png', 'image/png');
  assert.match(h.get('Content-Disposition'), /^attachment; filename="a _b__c\.png"; filename\*=UTF-8''a%20%22b%22%3Bc\.png$/);
});

test('uploads are recognized by their first bytes', () => {
  assert.equal(sniffType(PDF), 'application/pdf');
  assert.equal(sniffType(new Uint8Array([0x0A, ...PDF])), 'application/pdf', 'a reader finds the header in the first 1 KB');
  assert.equal(sniffType(PNG), 'image/png');
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(new TextEncoder().encode('GIF89a....')), 'image/gif');
  assert.equal(sniffType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffType(new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftypavif')])), 'image/avif');
  assert.equal(sniffType(new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftypheic')])), 'image/heic', 'an iPhone photo');
  assert.equal(sniffType(new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftypmif1')])), 'image/heif');
  for (const bad of [HTML, SVG, new TextEncoder().encode('<?xml version="1.0"?><svg/>'), new TextEncoder().encode('alert(1)'), new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftypisom')]), new Uint8Array()]) {
    assert.equal(sniffType(bad), null);
  }
});

test('upload-file takes PDFs and pictures only, and stores the type it found', async () => {
  const FILES = fakeR2();
  const up = async (bytes, name, path, type = 'application/octet-stream') => {
    const form = new FormData();
    form.append('file', new File([bytes], name, { type }));
    form.append('path', path);
    form.append('message', 'test');
    const res = await uploadFile({ env: { FILES }, request: new Request('https://sunshineonaranneyday.com/api/upload-file', { method: 'POST', body: form }) });
    return { status: res.status, body: await res.json() };
  };
  // The browser's claim doesn't matter: what the bytes are does
  const pdf = await up(PDF, '990.pdf', 'public/financials/990.pdf', 'text/html');
  assert.equal(pdf.status, 200);
  assert.equal(FILES.store.get('financials/990.pdf').type, 'application/pdf');
  assert.equal((await up(PNG, 'license.png', 'public/financials/license.png', 'image/png')).status, 200);
  assert.equal(FILES.store.get('financials/license.png').type, 'image/png');
  // A page or an SVG, however it's named or labelled, is refused and nothing is stored
  for (const [bytes, name, type] of [[HTML, 'report.pdf', 'application/pdf'], [HTML, 'x.html', 'text/html'], [SVG, 'badge.svg', 'image/svg+xml'], [SVG, 'badge.png', 'image/png'], [PDF, 'x.html', 'application/pdf'], [PDF, 'x.svg', 'image/svg+xml'], [PDF, 'noending', 'application/pdf']]) {
    const r = await up(bytes, name, `public/financials/${name}`, type);
    assert.equal(r.status, 415, name);
    assert.match(r.body.error, /PDFs and pictures/);
    assert.ok(!FILES.store.has(`financials/${name}`), `${name} stored`);
  }
  assert.equal((await up(PDF, 'x.pdf', 'public/advisory/x.pdf')).status, 403);
  assert.equal((await up(PDF, 'x.pdf', 'public/financials/../x.pdf')).status, 403);
});
