/**
 * The image types the site takes from outside (a board member's own photo on
 * /profile-update/, an article's preview image for a press card): JPEG, PNG,
 * WebP, HEIC/HEIF and GIF. Never SVG, which is a document that can carry
 * script, nor anything else a browser might be talked into running.
 *
 * Both the declared type and the file's first bytes must say the same
 * allowed type: a renamed or mislabeled file is turned away.
 *
 *   imageKind(bytes)                 'jpeg' | 'png' | 'webp' | 'heic' | 'gif' | null
 *   checkImage(bytes, declaredType)  { ok, kind, type } | { ok: false, why }
 */

export const IMAGE_TYPES = Object.freeze({
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  heic: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'],
  gif: ['image/gif'],
});
const TYPE_FOR = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', gif: 'image/gif' };
// ISO-BMFF brands for HEIC/HEIF stills and sequences (the "ftyp" box)
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

/** What the file's first bytes say it is, or null when it isn't one we take */
export function imageKind(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(b, 4, 8) === 'ftyp') {
    // The major brand, then the compatible brands, up to the box's own size.
    // AVIF shares the "mif1" brand with HEIF, and isn't one we take.
    const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 || 32, 64);
    const brands = [ascii(b, 8, 12)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, i + 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return null;
    if (brands.some((x) => HEIF_BRANDS.has(x))) return 'heic';
  }
  return null;
}

/** The declared type (a File's or a response's Content-Type), bare and lowercase */
export function bareType(type) {
  return String(type || '').split(';')[0].trim().toLowerCase();
}

/**
 * Is this an image we take? The bytes decide the kind; a declared type, when
 * there is one, must agree. → { ok, kind, type } (type: the clean MIME type
 * to upload with) | { ok: false, why }
 */
export function checkImage(bytes, declaredType = '') {
  const kind = imageKind(bytes);
  if (!kind) return { ok: false, why: 'not a JPG, PNG, WebP, HEIC or GIF image' };
  const declared = bareType(declaredType);
  if (declared && declared !== 'application/octet-stream' && !IMAGE_TYPES[kind].includes(declared)) {
    return { ok: false, why: `says ${declared} but is a ${kind.toUpperCase()}` };
  }
  return { ok: true, kind, type: TYPE_FOR[kind] };
}
