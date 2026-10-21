/**
 * Images the site takes from outside, and deleting one by id:
 *   - /api/profile-request (a board member's own photo) and /api/fetch-og-image
 *     (a press card's picture) keep only JPEG, PNG, WebP, HEIC and GIF, by the
 *     file's bytes as well as its label: never SVG.
 *   - /api/delete-image only takes an image id, never another API path.
 * Run: node --test tests/uploads.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { imageKind, checkImage } from '../functions/api/_image-types.js';
import { onRequestPost as deleteImage, validImageId } from '../functions/api/delete-image.js';
import { onRequestPost as profilePost } from '../functions/api/profile-request.js';
import { onRequestPost as fetchOgImage } from '../functions/api/fetch-og-image.js';
import { createRequest } from '../functions/api/_profile-requests.js';

// First bytes of each kind of file
const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const pad = (b) => { const out = new Uint8Array(Math.max(64, b.length)); out.set(b); return out; };
const FILES = {
  jpeg: pad(bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10], 'JFIF')),
  png: pad(bytes([0x89], 'PNG', [0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13], 'IHDR')),
  webp: pad(bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')),
  gif: pad(bytes('GIF89a', [1, 0, 1, 0])),
  heic: pad(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic')),
  heif: pad(bytes([0, 0, 0, 0x18], 'ftypmif1', [0, 0, 0, 0], 'mif1heic')),
  svg: pad(bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')),
  svgXml: pad(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')),
  avif: pad(bytes([0, 0, 0, 0x1C], 'ftypavif', [0, 0, 0, 0], 'avifmif1miaf')),
  mp4: pad(bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0], 'isomiso2')),
  html: pad(bytes('<!doctype html><script>alert(1)</script>')),
};

test('the bytes say what a file is; only the five kinds are taken', () => {
  for (const kind of ['jpeg', 'png', 'webp', 'gif', 'heic']) assert.equal(imageKind(FILES[kind]), kind, kind);
  assert.equal(imageKind(FILES.heif), 'heic', 'HEIF stills too');
  for (const kind of ['svg', 'svgXml', 'avif', 'mp4', 'html']) assert.equal(imageKind(FILES[kind]), null, kind);
  assert.equal(imageKind(new Uint8Array(3)), null, 'too short to tell');

  assert.deepEqual(checkImage(FILES.png, 'image/png'), { ok: true, kind: 'png', type: 'image/png' });
  assert.equal(checkImage(FILES.jpeg, '').ok, true, 'no label: the bytes decide');
  assert.equal(checkImage(FILES.heic, 'image/heif').ok, true);
  assert.equal(checkImage(FILES.svg, 'image/png').ok, false, 'an SVG labeled PNG');
  assert.equal(checkImage(FILES.png, 'image/svg+xml').ok, false, 'labeled SVG');
  assert.equal(checkImage(FILES.png, 'image/jpeg').ok, false, 'label and bytes disagree');
});

// ─── A fake Cloudflare Images, and outlets' pages ───────────────────

const realFetch = globalThis.fetch;
let calls;
let outlet; // { html, image: { body, type } }
beforeEach(() => {
  calls = [];
  outlet = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
      if (init.method === 'DELETE') return Response.json({ success: true });
      const file = init.body.get('file');
      return Response.json({ success: true, result: { id: init.body.get('id') || 'img1', variants: [`https://imagedelivery.net/hash/${init.body.get('id') || 'img1'}/public`], type: file.type } });
    }
    if (url === 'https://news.example/story') return new Response(outlet.html, { headers: { 'content-type': 'text/html' } });
    if (url === 'https://news.example/pic') return new Response(outlet.image.body, { headers: { 'content-type': outlet.image.type } });
    throw new Error(`unexpected fetch ${url}`);
  };
});
after(() => { globalThis.fetch = realFetch; });
const CF = { CF_ACCOUNT_ID: 'acct123', CF_IMAGES_TOKEN: 'tok' };
const uploads = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/images/v1'));

// ─── delete-image ───────────────────────────────────────────────────

test('delete-image takes an image id and nothing that reaches another API path', async () => {
  for (const id of ['kids/amari/photo-1', '2cdc28f0-017a-49c4-9ed7-87056c83901', 'library/1783359086511-rowan.png']) assert.equal(validImageId(id), true, id);
  for (const id of ['../../stream/abc', 'kids/../../stream/x', 'a//b', '/abs', 'a/./b', 'a b', '%2e%2e/stream', 'x?y=1', 'x#y', '', 'x'.repeat(257), 42]) assert.equal(validImageId(id), false, String(id));

  const del = (imageId) => deleteImage({ env: CF, request: new Request('https://sunshineonaranneyday.com/api/delete-image', { method: 'POST', body: JSON.stringify({ imageId }) }) });
  const bad = await del('../../stream/abc123');
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 0, 'Cloudflare never called');

  const ok = await del('kids/amari/photo-1');
  assert.equal((await ok.json()).success, true);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct123/images/v1/kids/amari/photo-1');
  assert.equal(calls[0].method, 'DELETE');
});

// ─── profile-request ────────────────────────────────────────────────

test('a profile photo must really be a JPG, PNG, WebP, HEIC or GIF', async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare("INSERT INTO team (slug, name, \"group\", order_num, data) VALUES ('jamie-test', 'Jamie Test', 'board', 0, ?)").bind(JSON.stringify({ name: 'Jamie Test', group: 'board' })).run();
  const { token } = await createRequest(DB, { slug: 'jamie-test' });
  const env = { DB, ...CF };
  const send = (body, type, name = 'me.png') => {
    const form = new FormData();
    form.append('token', token);
    form.append('bio', 'Hello.');
    form.append('photo', new File([body], name, { type }));
    return profilePost({ env, waitUntil: () => {}, request: new Request('https://sunshineonaranneyday.com/api/profile-request', { method: 'POST', body: form }) });
  };

  for (const [body, type, label] of [[FILES.svg, 'image/svg+xml', 'an SVG'], [FILES.svg, 'image/png', 'an SVG called a PNG'], [FILES.png, 'image/svg+xml', 'labeled SVG'], [FILES.html, 'image/jpeg', 'a web page'], [FILES.avif, 'image/avif', 'AVIF']]) {
    const res = await send(body, type);
    assert.equal(res.status, 400, label);
    assert.match((await res.json()).error, /JPG, PNG, WebP or HEIC/);
  }
  assert.equal(uploads().length, 0, 'nothing reached Cloudflare Images');

  for (const [body, type] of [[FILES.png, 'image/png'], [FILES.heic, 'image/heic'], [FILES.jpeg, '']]) {
    const res = await send(body, type);
    assert.equal(res.status, 200, `${type || 'unlabeled'} accepted`);
  }
  assert.equal(uploads().length, 3);
});

// ─── fetch-og-image ─────────────────────────────────────────────────

test('a press image is saved only when the download is an image type we keep', async () => {
  const run = () => fetchOgImage({ env: CF, request: new Request('https://sunshineonaranneyday.com/api/fetch-og-image', { method: 'POST', body: JSON.stringify({ url: 'https://news.example/story', id: 'press/test-outlet' }) }) });
  outlet = { html: '<meta property="og:image" content="https://news.example/pic">' };

  outlet.image = { body: FILES.svg, type: 'image/svg+xml' };
  let res = await run();
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /JPG, PNG, WebP or GIF/);
  outlet.image = { body: FILES.avif, type: 'image/avif' };
  assert.equal((await run()).status, 422);
  outlet.image = { body: FILES.svg, type: 'image/png' };
  assert.equal((await run()).status, 422, 'an SVG served as a PNG');
  assert.equal(uploads().length, 0);

  // Labeled loosely or wrongly, but really an image we keep: saved as what the bytes are
  for (const [body, type, want, ext] of [
    [FILES.png, 'application/octet-stream', 'image/png', 'png'],
    [FILES.png, 'image/x-png', 'image/png', 'png'],
    [FILES.webp, 'image/jpeg', 'image/webp', 'webp'],
    [FILES.jpeg, 'text/html', 'image/jpeg', 'jpg'],
    [FILES.gif, '', 'image/gif', 'gif'],
  ]) {
    calls = [];
    outlet.image = { body, type };
    res = await run();
    assert.equal(res.status, 200, `${type || 'unlabeled'} → ${want}`);
    const sent = uploads()[0].body.get('file');
    assert.equal(sent.type, want);
    assert.equal(sent.name, `press-image.${ext}`);
  }
});
