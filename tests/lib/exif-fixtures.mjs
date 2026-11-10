/**
 * Photo and video files built byte by byte, for the "whose photos are these?"
 * tests (tests/kid-guess.test.mjs, scripts/test-kids-admin.mjs): a TIFF block
 * with EXIF GPS and the time taken, a JPEG and a HEIC carrying it, and the
 * ISO base media boxes a MOV is made of.
 */
export function tiff({ lat, lng, taken, le = false }) {
  const b = new ArrayBuffer(200);
  const v = new DataView(b);
  const u16 = (o, x) => v.setUint16(o, x, le);
  const u32 = (o, x) => v.setUint32(o, x, le);
  v.setUint16(0, le ? 0x4949 : 0x4d4d);
  u16(2, 42);
  u32(4, 8);
  const entry = (at, tag, type, count, value) => { u16(at, tag); u16(at + 2, type); u32(at + 4, count); u32(at + 8, value); };
  // IFD0 at 8: Exif pointer, GPS pointer
  u16(8, 2);
  entry(10, 0x8769, 4, 1, 38);
  entry(22, 0x8825, 4, 1, 56);
  u32(34, 0);
  // Exif IFD at 38: DateTimeOriginal
  u16(38, 1);
  entry(40, 0x9003, 2, 20, 110);
  u32(52, 0);
  // GPS IFD at 56
  u16(56, 4);
  entry(58, 1, 2, 2, 0);
  v.setUint8(58 + 8, (lat < 0 ? 'S' : 'N').charCodeAt(0));
  entry(70, 2, 5, 3, 130);
  entry(82, 3, 2, 2, 0);
  v.setUint8(82 + 8, (lng < 0 ? 'W' : 'E').charCodeAt(0));
  entry(94, 4, 5, 3, 154);
  u32(106, 0);
  const t = `${taken} `.slice(0, 19);
  for (let i = 0; i < 19; i++) v.setUint8(110 + i, t.charCodeAt(i));
  const dms = (at, x) => {
    const a = Math.abs(x);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = Math.round(((a - d) * 60 - m) * 60 * 1000);
    [[d, 1], [m, 1], [s, 1000]].forEach(([n, den], i) => { u32(at + i * 8, n); u32(at + i * 8 + 4, den); });
  };
  dms(130, lat);
  dms(154, lng);
  return new Uint8Array(b, 0, 178);
}
export function jpeg(t) {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xe1];
  const len = 2 + 6 + t.length;
  return new Uint8Array([...head, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...t, 0xff, 0xd9]);
}
export const box = (type, ...parts) => {
  const body = parts.flatMap((p) => [...p]);
  const n = 8 + body.length;
  return new Uint8Array([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body]);
};
const u16 = (x) => [x >> 8, x & 255];
const u32 = (x) => [x >>> 24, (x >> 16) & 255, (x >> 8) & 255, x & 255];
export function heic(t, ilocVersion = 0) {
  const payload = [...u32(6), ...[0x45, 0x78, 0x69, 0x66, 0, 0], ...t];
  const ftyp = box('ftyp', [...'heic'].map((c) => c.charCodeAt(0)), u32(0));
  const infe = box('infe', [2, 0, 0, 0], u16(1), u16(0), [...'hvc1'].map((c) => c.charCodeAt(0)), [0]);
  const infeExif = box('infe', [2, 0, 0, 0], u16(7), u16(0), [...'Exif'].map((c) => c.charCodeAt(0)), [0]);
  const iinf = box('iinf', [0, 0, 0, 0], u16(2), infe, infeExif);
  const build = (offset) => {
    const item = (id, off, len) => (ilocVersion === 1 ? [...u16(id), ...u16(0), ...u16(0), ...u16(1), ...u32(off), ...u32(len)] : [...u16(id), ...u16(0), ...u16(1), ...u32(off), ...u32(len)]);
    const iloc = box('iloc', [ilocVersion, 0, 0, 0], [0x44, 0x00], u16(2), item(1, 0, 0), item(7, offset, payload.length));
    return box('meta', [0, 0, 0, 0], box('hdlr', [0, 0, 0, 0], u32(0), [...'pict'].map((c) => c.charCodeAt(0)), u32(0), u32(0), u32(0), [0]), iinf, iloc);
  };
  const metaLen = build(0).length;
  const offset = ftyp.length + metaLen + 8;
  return new Uint8Array([...ftyp, ...build(offset), ...box('mdat', payload)]);
}

/** A real PNG of w×h, each pixel from paint(x, y) → [r, g, b]: pictures that differ, or match at two sizes */
import { deflateSync } from 'node:zlib';
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = [...type].map((ch) => ch.charCodeAt(0));
  const body = new Uint8Array([...t, ...data]);
  const len = data.length;
  const crc = crc32(body);
  return [len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...body, crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255];
};
export function pngImage(w, h, paint) {
  const raw = [];
  for (let y = 0; y < h; y++) { raw.push(0); for (let x = 0; x < w; x++) raw.push(...paint(x, y)); }
  const ihdr = [w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 2, 0, 0, 0];
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', [...deflateSync(Buffer.from(raw))]), ...chunk('IEND', [])]);
}
