/**
 * Taking the location out of a picture before it goes up
 * =======================================================
 * Phones and CompanyCam write where a photo was taken into the file (EXIF GPS,
 * and XMP when an editor saved it). For a kid's before photos that place is
 * the family's home. Cloudflare Images keeps each file as it was uploaded and
 * hands its metadata to anyone who asks for it (a flexible variant with
 * metadata=keep), so every picture the site uploads goes through
 * stripLocation() first (./_cf-images.js does it for every upload).
 *
 * Only the location goes. The picture, its orientation, the time it was taken
 * and the camera stay, byte for byte, in place: the GPS block's pointer is
 * taken out of the TIFF block and the block itself is zeroed, and XMP GPS
 * properties are blanked with spaces, so nothing else in the file moves.
 * JPEG (with any pictures stored after it, as iPhones store a gain map), PNG,
 * WebP, HEIC/HEIF/AVIF and TIFF. A PNG's checksums are recomputed for the
 * chunks it changes; compressed PNG metadata (zTXt, compressed iTXt, the
 * "Raw profile type exif/xmp" text ImageMagick writes) can't be blanked in
 * place, so those chunks are dropped.
 */

import { heicExifPlace } from '../../public/admin/kid-guess.js';
import { imageKind } from './_image-types.js';

// Bytes per value of each TIFF field type
const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const GPS_POINTER = 0x8825;

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
/** Where `pattern` (a string or bytes) first appears in u8 between from and to, or -1 */
function indexOf(u8, pattern, from = 0, to = u8.length) {
  const p = typeof pattern === 'string' ? ascii(pattern) : pattern;
  const last = to - p.length;
  for (let i = u8.indexOf(p[0], from); i !== -1 && i <= last; i = u8.indexOf(p[0], i + 1)) {
    let j = 1;
    while (j < p.length && u8[i + j] === p[j]) j++;
    if (j === p.length) return i;
  }
  return -1;
}

/**
 * Take the GPS block out of the TIFF block whose header is at `t` (EXIF):
 * IFD0's pointer to it is removed (later entries move up, the table keeps its
 * size) and the block, with every value it points to, is zeroed. In place;
 * nothing outside [t, end) is touched. → true when there was one
 */
export function wipeTiffGps(u8, t, end = u8.length) {
  if (t < 0 || t + 8 > end) return false;
  const le = u8[t] === 0x49 && u8[t + 1] === 0x49;
  if (!le && !(u8[t] === 0x4d && u8[t + 1] === 0x4d)) return false;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  if (u16(t + 2) !== 42) return false;
  const ifd0 = t + u32(t + 4);
  if (ifd0 < t + 8 || ifd0 + 2 > end) return false;
  let wiped = false;
  for (;;) {
    const n = u16(ifd0);
    const table = ifd0 + 2;
    const tableEnd = table + n * 12;
    if (tableEnd > end) return wiped;
    let at = -1;
    for (let i = 0; i < n; i++) if (u16(table + i * 12) === GPS_POINTER) { at = i; break; }
    if (at < 0) return wiped;
    const gps = t + u32(table + at * 12 + 8);
    if (gps >= t + 8 && gps + 2 <= end) {
      const gn = u16(gps);
      const gEnd = Math.min(end, gps + 2 + gn * 12 + 4);
      for (let j = 0; j < gn && gps + 2 + j * 12 + 12 <= end; j++) {
        const e = gps + 2 + j * 12;
        const bytes = (TYPE_BYTES[u16(e + 2)] || 1) * u32(e + 4);
        if (bytes <= 4) continue;
        const o = t + u32(e + 8);
        // A value stored outside the entry: zero it, unless a broken file points it into IFD0's table
        if (o >= t + 8 && o + bytes <= end && (o + bytes <= ifd0 || o >= tableEnd + 4)) u8.fill(0, o, o + bytes);
      }
      if (gps + 2 + gn * 12 <= ifd0 || gps >= tableEnd + 4) u8.fill(0, gps, gEnd);
    }
    // Entries after the pointer move up one; the next-IFD offset follows them; the freed slot is zeroed
    const e0 = table + at * 12;
    const keep = Math.min(end, tableEnd + 4);
    u8.copyWithin(e0, e0 + 12, keep);
    u8.fill(0, keep - 12, keep);
    v.setUint16(ifd0, n - 1, le);
    wiped = true;
  }
}

/**
 * Blank every XMP GPS property (exif:GPSLatitude="…", <exif:GPSLongitude>…</…>,
 * and the GPS fields inside Iptc4xmpExt:LocationCreated/LocationShown) between
 * from and to with spaces of the same length, so the XML stays well formed and
 * nothing moves. → true when there was one
 */
export function wipeXmpGps(u8, from = 0, to = u8.length) {
  let text = '';
  for (let i = from; i < to; i += 8192) text += String.fromCharCode(...u8.subarray(i, Math.min(to, i + 8192)));
  // Any namespace, any case: exif:GPSLatitude, and drone makers' own (drone-dji:GpsLatitude)
  if (!/:gps/i.test(text)) return false;
  let wiped = false;
  const blank = (re) => {
    for (const m of text.matchAll(re)) {
      u8.fill(0x20, from + m.index, from + m.index + m[0].length);
      wiped = true;
    }
  };
  // Elements first (their contents may hold attributes too), then attributes
  blank(/<([\w.-]+:gps[\w]*)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/gi);
  blank(/\s[\w.-]+:gps[\w]*\s*=\s*(?:"[^"]*"|'[^']*')/gi);
  return wiped;
}

/** Every XMP packet in [from, to): blank its GPS → true when there was any */
function wipeXmpPackets(u8, from = 0, to = u8.length) {
  let wiped = false;
  for (let i = indexOf(u8, '<x:xmpmeta', from, to); i >= 0; i = indexOf(u8, '<x:xmpmeta', i + 1, to)) {
    const close = indexOf(u8, '</x:xmpmeta>', i, to);
    const stop = close < 0 ? to : close + 12;
    if (wipeXmpGps(u8, i, stop)) wiped = true;
    if (close < 0) break;
  }
  return wiped;
}

/** Every TIFF block introduced by 'Exif\0\0' in [from, to): take its GPS out → true when there was any */
function wipeExifBlocks(u8, from = 0, to = u8.length) {
  let wiped = false;
  for (let i = indexOf(u8, 'Exif\0\0', from, to); i >= 0; i = indexOf(u8, 'Exif\0\0', i + 6, to)) {
    if (wipeTiffGps(u8, i + 6, to)) wiped = true;
  }
  return wiped;
}

// ── JPEG ────────────────────────────────────────────────────────────
const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_NS = 'http://ns.adobe.com/xmp/extension/\0';
/** One JPEG starting at `start`: its APP1 EXIF and XMP → { wiped, end } (end: just past its EOI, or -1) */
function wipeJpeg(u8, start) {
  let wiped = false;
  let p = start + 2;
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xff) return { wiped, end: -1 };
    const m = u8[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (m === 0xd9) return { wiped, end: p + 2 };
    const len = (u8[p + 2] << 8) | u8[p + 3];
    const s = p + 4;
    const segEnd = Math.min(u8.length, p + 2 + len);
    if (m === 0xe1) {
      if (indexOf(u8, 'Exif\0\0', s, s + 6) === s) { if (wipeTiffGps(u8, s + 6, segEnd)) wiped = true; }
      else if (indexOf(u8, XMP_NS, s, s + XMP_NS.length) === s || indexOf(u8, XMP_EXT_NS, s, s + XMP_EXT_NS.length) === s) {
        if (wipeXmpGps(u8, s, segEnd)) wiped = true;
      }
    }
    if (m === 0xda) {
      // Scan data: the next marker that isn't a stuffed byte or a restart is the end of it
      let q = segEnd;
      for (;;) {
        q = u8.indexOf(0xff, q);
        if (q < 0 || q + 1 >= u8.length) return { wiped, end: -1 };
        const n = u8[q + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { q += 1; continue; }
        break;
      }
      p = q;
      continue;
    }
    p = segEnd;
  }
  return { wiped, end: -1 };
}
function wipeJpegFile(u8) {
  let { wiped, end } = wipeJpeg(u8, 0);
  // Pictures stored after the main one (an iPhone's gain map, a depth map; MPF): each its own JPEG
  while (end > 0) {
    const next = indexOf(u8, [0xff, 0xd8, 0xff], end);
    if (next < 0) break;
    const r = wipeJpeg(u8, next);
    if (r.wiped) wiped = true;
    end = r.end;
  }
  return wiped;
}

// ── PNG ─────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8, from, to) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A PNG: eXIf and uncompressed XMP blanked in place (checksums recomputed), compressed metadata text dropped → { wiped, bytes } */
function wipePng(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const drop = [];
  let wiped = false;
  let p = 8;
  while (p + 12 <= u8.length) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const s = p + 8;
    const e = Math.min(u8.length, s + len);
    let changed = false;
    if (type === 'eXIf') changed = wipeTiffGps(u8, indexOf(u8, 'Exif\0\0', s, s + 6) === s ? s + 6 : s, e);
    else if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const nul = u8.indexOf(0, s);
      const keyword = nul > s && nul < e ? String.fromCharCode(...u8.subarray(s, nul)) : '';
      const compressed = type === 'zTXt' || (type === 'iTXt' && u8[nul + 1] === 1);
      if (/xmp|exif/i.test(keyword)) {
        if (compressed || /^Raw profile type/i.test(keyword)) drop.push([p, s + len + 4]);
        else changed = wipeXmpGps(u8, nul + 1, e);
      }
    }
    if (changed) {
      v.setUint32(s + len, crc32(u8, p + 4, s + len));
      wiped = true;
    }
    if (type === 'IEND') break;
    p = s + len + 4;
  }
  if (!drop.length) return { wiped, bytes: u8 };
  const size = u8.length - drop.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Uint8Array(size);
  let from = 0;
  let o = 0;
  for (const [a, b] of drop) { out.set(u8.subarray(from, a), o); o += a - from; from = b; }
  out.set(u8.subarray(from), o);
  return { wiped: true, bytes: out };
}

// ── WebP ────────────────────────────────────────────────────────────
function wipeWebp(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let wiped = false;
  let p = 12;
  while (p + 8 <= u8.length) {
    const type = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const len = v.getUint32(p + 4, true);
    const s = p + 8;
    const e = Math.min(u8.length, s + len);
    if (type === 'EXIF' && wipeTiffGps(u8, indexOf(u8, 'Exif\0\0', s, s + 6) === s ? s + 6 : s, e)) wiped = true;
    if (type === 'XMP ' && wipeXmpGps(u8, s, e)) wiped = true;
    p = s + len + (len & 1);
  }
  return wiped;
}

// ── HEIC / HEIF / AVIF ──────────────────────────────────────────────
function wipeHeif(u8) {
  let wiped = false;
  const place = heicExifPlace(u8.buffer.byteLength === u8.length && !u8.byteOffset ? u8.buffer : u8.slice().buffer);
  if (place && place.length >= 8 && place.offset + place.length <= u8.length) {
    // The Exif item: 4 bytes saying how far past them the TIFF header is
    const skip = new DataView(u8.buffer, u8.byteOffset + place.offset, 4).getUint32(0);
    if (wipeTiffGps(u8, place.offset + 4 + skip, place.offset + place.length)) wiped = true;
  }
  // Also any Exif block the item table didn't lead to (stored in idat, or a second item), and XMP items
  if (wipeExifBlocks(u8)) wiped = true;
  if (wipeXmpPackets(u8)) wiped = true;
  return wiped;
}

/** Which reader a picture needs: 'jpeg' | 'png' | 'webp' | 'heif' (HEIC, AVIF) | 'tiff' | 'gif' | '' */
export function pictureKind(u8) {
  const kind = imageKind(u8);
  if (kind) return kind === 'heic' ? 'heif' : kind;
  if (u8.length >= 12 && indexOf(u8, 'ftyp', 4, 8) === 4) return 'heif';
  if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42 && u8[3] === 0) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0 && u8[3] === 42)) return 'tiff';
  return '';
}

const toBytes = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input));

/**
 * The picture without where it was taken → { bytes, removed, kind }.
 * `bytes` is a new Uint8Array (the input is never changed); `removed` says
 * whether there was any location to take out.
 */
export function stripLocation(input) {
  const u8 = toBytes(input).slice();
  const kind = pictureKind(u8);
  try {
    if (kind === 'jpeg') return { bytes: u8, removed: wipeJpegFile(u8), kind };
    if (kind === 'png') { const r = wipePng(u8); return { bytes: r.bytes, removed: r.wiped, kind }; }
    if (kind === 'webp') return { bytes: u8, removed: wipeWebp(u8), kind };
    if (kind === 'heif') return { bytes: u8, removed: wipeHeif(u8), kind };
    if (kind === 'tiff') { const a = wipeTiffGps(u8, 0); const b = wipeXmpPackets(u8); return { bytes: u8, removed: a || b, kind }; }
  } catch {
    // Too broken to walk: every EXIF block and XMP packet anywhere in it is cleaned instead
    try { wipeExifBlocks(u8); wipeXmpPackets(u8); } catch { /* nothing more can be read */ }
    return { bytes: u8, removed: true, kind };
  }
  return { bytes: u8, removed: false, kind };
}

/**
 * Whether a picture has location data to take out: a GPS block, XMP GPS
 * properties, or metadata stored compressed (a PNG's), which may hold it
 */
export const hasLocation = (input) => stripLocation(input).removed;
