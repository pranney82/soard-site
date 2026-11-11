/**
 * A picture goes up without where it was taken (functions/api/_photo-location.js,
 * functions/api/_cf-images.js): the GPS block and XMP GPS come out of JPEG,
 * PNG, WebP and HEIC files, in place, and everything else stays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { stripLocation, hasLocation, wipeTiffGps } from '../functions/api/_photo-location.js';
import { uploadImage } from '../functions/api/_cf-images.js';
import { jpegFacts, heicExifPlace, heicExifFacts, tiffFacts } from '../public/admin/kid-guess.js';
import { tiff, jpeg, heic, pngImage } from './lib/exif-fixtures.mjs';

const HOME = { lat: 33.7456, lng: -84.3902, taken: '2025:03:06 10:16:15' };
const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const enc = (s) => [...s].map((c) => c.charCodeAt(0));
const seg = (marker, body) => { const n = body.length + 2; return [0xff, marker, n >> 8, n & 255, ...body]; };
const heicFacts = (u8) => { const b = buf(u8); const p = heicExifPlace(b); return p ? heicExifFacts(b.slice(p.offset, p.offset + p.length)) : null; };

test('a JPEG loses its GPS and keeps the time taken, the same size, the input untouched', () => {
  for (const le of [false, true]) {
    const file = jpeg(tiff({ ...HOME, le }));
    const before = file.slice();
    assert.equal(jpegFacts(buf(file)).lat.toFixed(4), '33.7456');
    const r = stripLocation(file);
    assert.equal(r.removed, true);
    assert.equal(r.kind, 'jpeg');
    assert.equal(r.bytes.length, file.length);
    const after = jpegFacts(buf(r.bytes));
    assert.equal(after.lat, undefined);
    assert.equal(after.lng, undefined);
    assert.equal(after.taken.getFullYear(), 2025, 'the time taken stays');
    assert.deepEqual(file, before, 'the caller’s bytes are not changed');
    assert.equal(hasLocation(r.bytes), false);
    // No trace of the coordinates is left: the TIFF block starts at 18, its GPS rationals at 130..178
    assert.equal(new DataView(buf(file)).getUint32(18 + 130, le), 33, 'the original held the degrees');
    assert.ok(r.bytes.subarray(18 + 130, 18 + 178).every((b) => b === 0));
  }
});

test('the GPS block’s bytes are zeroed, not just unlinked', () => {
  const t = tiff(HOME);
  const copy = t.slice();
  assert.equal(wipeTiffGps(copy, 0), true);
  // GPS IFD lived at 56..110 and its rationals at 130..178 in the fixture
  assert.ok(copy.subarray(56, 110).every((b) => b === 0));
  assert.ok(copy.subarray(130, 178).every((b) => b === 0));
  // IFD0 now has one entry (the Exif pointer) and the time taken still reads
  assert.equal(new DataView(buf(copy)).getUint16(8), 1);
  assert.equal(tiffFacts(new DataView(buf(copy)), 0).taken.getMonth(), 2);
  assert.equal(wipeTiffGps(copy, 0), false, 'nothing left the second time');
});

test('a HEIC (both item-location layouts) loses its GPS in place', () => {
  for (const v of [0, 1]) {
    const file = heic(tiff(HOME), v);
    assert.ok(heicFacts(file).lat);
    const r = stripLocation(file);
    assert.equal(r.removed, true);
    assert.equal(r.kind, 'heif');
    assert.equal(r.bytes.length, file.length);
    const after = heicFacts(r.bytes);
    assert.equal(after.lat, undefined);
    assert.ok(after.taken, 'the time taken stays');
  }
});

test('XMP GPS is blanked (any namespace, attribute or element) and the rest of the XMP stays', () => {
  const xmp = 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreateDate="2025-03-06" exif:GPSLatitude="33,44.7N" drone-dji:GpsLongitude="-84.39">'
    + '<exif:GPSLongitude>84,23.4W</exif:GPSLongitude><dc:title>Bedroom</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
  const file = new Uint8Array([0xff, 0xd8, ...seg(0xe1, enc(xmp)), 0xff, 0xd9]);
  const r = stripLocation(file);
  assert.equal(r.removed, true);
  assert.equal(r.bytes.length, file.length);
  const text = String.fromCharCode(...r.bytes);
  assert.doesNotMatch(text, /gps/i);
  assert.doesNotMatch(text, /33,44|84,23|-84\.39/);
  assert.match(text, /xmp:CreateDate="2025-03-06"/);
  assert.match(text, /<dc:title>Bedroom<\/dc:title>/);
  assert.match(text, /<\/x:xmpmeta>/);
});

test('a picture stored after the main one (an iPhone gain map) loses its GPS too', () => {
  const main = jpeg(tiff({ lat: 0.0001, lng: 0.0001, taken: HOME.taken }));
  const gain = jpeg(tiff(HOME));
  // Main JPEG with a scan, then the second JPEG after its EOI
  const scan = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
  const file = new Uint8Array([...main.subarray(0, main.length - 2), ...scan, 0xff, 0xd9, ...gain]);
  const r = stripLocation(file);
  assert.equal(r.removed, true);
  assert.equal(jpegFacts(buf(r.bytes)).lat, undefined);
  const second = r.bytes.subarray(file.length - gain.length);
  assert.equal(jpegFacts(buf(second.slice())).lat, undefined);
  assert.ok(jpegFacts(buf(second.slice())).taken);
});

// PNG chunk helpers
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (x) => [x >>> 24, (x >> 16) & 255, (x >> 8) & 255, x & 255];
const chunk = (type, data) => { const body = [...enc(type), ...data]; return [...u32(data.length), ...body, ...u32(crc32(body))]; };
const chunks = (u8) => {
  const out = [];
  const v = new DataView(buf(u8));
  for (let p = 8; p + 12 <= u8.length;) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    out.push({ type, ok: crc32(u8.subarray(p + 4, p + 8 + len)) === v.getUint32(p + 8 + len), data: u8.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
};
const withChunks = (png, extra) => {
  const iend = png.length - 12;
  return new Uint8Array([...png.subarray(0, iend), ...extra.flat(), ...png.subarray(iend)]);
};

test('a PNG’s eXIf loses its GPS with its checksum redone; compressed metadata text is dropped', () => {
  const png = pngImage(2, 2, () => [200, 100, 50]);
  const file = withChunks(new Uint8Array(png), [chunk('eXIf', [...tiff(HOME)]), chunk('zTXt', [...enc('Raw profile type exif'), 0, 0, 1, 2, 3]), chunk('tEXt', [...enc('Comment'), 0, ...enc('kept')])]);
  const r = stripLocation(file);
  assert.equal(r.removed, true);
  assert.equal(r.kind, 'png');
  const list = chunks(r.bytes);
  assert.deepEqual(list.map((c) => c.type), ['IHDR', 'IDAT', 'eXIf', 'tEXt', 'IEND']);
  assert.ok(list.every((c) => c.ok), 'every checksum is right');
  const exif = list.find((c) => c.type === 'eXIf').data.slice();
  assert.equal(tiffFacts(new DataView(buf(exif)), 0).lat, undefined);
  assert.equal(hasLocation(r.bytes), false);
});

test('a WebP’s EXIF chunk loses its GPS', () => {
  const t = [...enc('Exif'), 0, 0, ...tiff(HOME)];
  const body = [...enc('WEBP'), ...enc('VP8X'), 10, 0, 0, 0, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...enc('EXIF'), t.length & 255, (t.length >> 8) & 255, 0, 0, ...t];
  const file = new Uint8Array([...enc('RIFF'), body.length & 255, (body.length >> 8) & 255, 0, 0, ...body]);
  const r = stripLocation(file);
  assert.equal(r.kind, 'webp');
  assert.equal(r.removed, true);
  assert.equal(hasLocation(r.bytes), false);
});

test('a picture with no location is left byte for byte as it was', () => {
  const png = new Uint8Array(pngImage(3, 3, (x, y) => [x * 40, y * 40, 0]));
  const r = stripLocation(png);
  assert.equal(r.removed, false);
  assert.deepEqual(r.bytes, png);
  const plain = new Uint8Array([0xff, 0xd8, ...seg(0xe0, enc('JFIF\0')), 0xff, 0xd9]);
  assert.equal(stripLocation(plain).removed, false);
  assert.deepEqual(stripLocation(plain).bytes, plain);
});

test('uploadImage sends the picture without its location, under its id and name', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, auth: init.headers.Authorization, file: init.body.get('file'), id: init.body.get('id') });
    return new Response(JSON.stringify({ success: true, result: { id: init.body.get('id'), variants: [] } }));
  };
  const env = { CF_ACCOUNT_ID: 'acct', CF_IMAGES_TOKEN: 'tok' };
  const j = await uploadImage(env, { file: new File([jpeg(tiff(HOME))], 'IMG_1.jpg', { type: 'image/jpeg' }), id: 'kids/test/a' }, fetchImpl);
  assert.equal(j.success, true);
  assert.equal(sent[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct/images/v1');
  assert.equal(sent[0].auth, 'Bearer tok');
  assert.equal(sent[0].id, 'kids/test/a');
  assert.equal(sent[0].file.name, 'IMG_1.jpg');
  assert.equal(sent[0].file.type, 'image/jpeg');
  assert.equal(jpegFacts(await sent[0].file.arrayBuffer()).lat, undefined);
  // Bytes in, same
  await uploadImage(env, { bytes: heic(tiff(HOME)), type: 'image/heic', filename: 'x.heic' }, fetchImpl);
  assert.equal(sent[1].id, null, 'no id unless one is given');
  assert.equal(heicFacts(new Uint8Array(await sent[1].file.arrayBuffer())).lat, undefined);
});

test('/api/upload-image strips the location before Cloudflare sees it', async () => {
  const { onRequestPost } = await import('../functions/api/upload-image.js');
  const real = globalThis.fetch;
  let got = null;
  globalThis.fetch = async (url, init) => { got = init.body.get('file'); return new Response(JSON.stringify({ success: true, result: { id: 'kids/x/1', variants: ['https://imagedelivery.net/h/kids/x/1/public'] } })); };
  try {
    const form = new FormData();
    form.append('file', new File([jpeg(tiff(HOME))], 'p.jpg', { type: 'image/jpeg' }));
    form.append('id', 'kids/x/1');
    const res = await onRequestPost({ env: { CF_ACCOUNT_ID: 'a', CF_IMAGES_TOKEN: 't' }, request: new Request('https://x/api/upload-image', { method: 'POST', body: form }) });
    const j = await res.json();
    assert.equal(j.success, true);
    assert.equal(j.imageUrl, 'https://imagedelivery.net/h/kids/x/1/public');
    assert.equal(jpegFacts(await got.arrayBuffer()).lat, undefined);
  } finally {
    globalThis.fetch = real;
  }
});

test('nothing on the site uploads to Cloudflare Images except through _cf-images.js', () => {
  const dir = new URL('../functions/api/', import.meta.url);
  const offenders = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== '_cf-images.js').filter((f) => {
    const s = readFileSync(new URL(f, dir), 'utf8');
    return /images\/v1/.test(s) && /append\(\s*['"](file|url)['"]/.test(s);
  });
  assert.deepEqual(offenders, []);
});
