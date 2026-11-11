/**
 * Kid items: the labels, in ZPL for SOARD's Zebra (4 × 6 in, 203 dpi)
 * ===========================================================================
 * One label a box: the kid's name, big; what it is and its line; "Box 2 of 3";
 * the shelf, in a black band; the day it came in; and a QR for that one box
 * (/admin/checkin/?r=<check-in id>&b=<box>): it opens the item on the check-in page, and at
 * load-out a scan counts exactly that box.
 * A shelf's own sign: its name, as big as it fits, and a QR to what's on it.
 * The page shows the same layout before it prints (public/admin/checkin/).
 */

export const SITE = 'https://sunshineonaranneyday.com';
// Direct thermal labels (no ribbon): ^MTD on every label, so the ZD421t prints with no ribbon loaded instead of
// stopping with "ribbon out" (Peter, Nov 10 2026: 4 x 6 yellow direct thermal labels). Thermal transfer labels with a
// ribbon would be 'T'
const MEDIA = 'D';
const W = 812;   // 4 in at 203 dpi
const H = 1218;  // 6 in

/** Words safe inside a ZPL field: no ^ or ~ (ZPL's own marks), no line breaks, kept to a length */
export function zplText(s, max = 200) {
  return String(s ?? '').normalize('NFC').replace(/[\^~\\]/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const day = (iso) => new Date(iso || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
// Each box's own code: the check-in and which box it is (Peter, Nov 10 2026: "we will be labeling individual boxes")
export const itemUrl = (tap, box = null) => `${SITE}/admin/checkin/?r=${encodeURIComponent(tap)}${box ? `&b=${box}` : ''}`;
export const shelfUrl = (shelf) => `${SITE}/admin/checkin/?shelf=${encodeURIComponent(shelf)}`;

// Zebra's built-in font 0 is about half as wide as it is tall (measured on Labelary's render, Nov 10 2026: capitals
// 0.55, mixed words 0.48). A field wider than the label doesn't shrink or wrap by itself: Zebra prints the overflow
// on top of it, so every line here is measured and cut to fit before it's sent
const INNER = W - 80;   // 40 dots each side
const fits = (text, size, caps = false) => Math.floor(INNER / (size * (caps ? 0.58 : 0.5)));

/** Words into at most n lines of a size; the last one ends "..." when there's more */
export function wrapText(text, size, n) {
  const max = fits(text, size);
  const words = zplText(text, 300).split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = w.length > max ? w.slice(0, max) : w;
    if (out.length === n) break;
  }
  if (cur && out.length < n) out.push(cur);
  const more = out.join(' ').length < zplText(text, 300).length;
  if (more && out.length) {
    const last = out[out.length - 1];
    out[out.length - 1] = `${last.length > max - 3 ? last.slice(0, max - 3).trimEnd() : last}...`;
  }
  return out.slice(0, n);
}

/** The kid's name as big as fits on one line (150 dots tall for "ROWAN S.", smaller for a long name, cut only past that) */
function kidLine(kid) {
  const name = zplText(kid, 40).toUpperCase();
  for (const size of [150, 130, 110, 96, 84, 72, 64]) if (name.length <= fits(name, size, true)) return { name, size };
  return { name: name.slice(0, fits(name, 64, true)), size: 64 };
}

// The QR for one box: medium error correction, 9 dots a module (about 46 mm across for the label's link, so a phone
// reads it from arm's length), kept inside the label's edges with room for a longer link (up to 45 modules)
const QR_MAG = 9;
const QR_ROOM = 45 * QR_MAG;

/**
 * One box's label → ZPL
 * { kid: 'Lizzie F.', item, line, set?: { n, of }, box, boxes, shelf: 'Shelf 7', at, tap }
 */
export function itemLabel({ kid, item, line, set = null, box = 1, boxes = 1, shelf, at, tap }) {
  const { name, size } = kidLine(kid);
  const itemLines = wrapText(item, 54, 3);
  // Its line, and which part of the set it is ("Shower System · Part 2 of 4"): the parts go to the house together
  const lineName = wrapText(set ? `${line} · Part ${set.n} of ${set.of}` : line, 36, 1)[0] || '';
  let y = 50;
  const f = [];
  f.push(`^FO40,${y}^A0N,${size},${size}^FD${name}^FS`);
  y += size + 22;
  f.push(`^FO40,${y}^GB${INNER},4,4^FS`);
  y += 26;
  for (const l of itemLines) { f.push(`^FO40,${y}^A0N,54,54^FD${l}^FS`); y += 62; }
  y += 6;
  if (lineName) { f.push(`^FO40,${y}^A0N,36,36^FD${lineName}^FS`); y += 52; }
  f.push(`^FO40,${y}^A0N,70,70^FDBox ${box} of ${boxes}^FS`);
  y += 96;
  // The shelf, white on a black band
  const shelfText = zplText(shelf || 'Shelf', 20).toUpperCase();
  f.push(`^FO40,${y}^GB${INNER},150,150^FS`);
  f.push(`^FO40,${y + 22}^A0N,110,110^FB${INNER},1,0,C^FR^FD${shelfText}^FS`);
  // The day it came in and SOARD, bottom left; the box's QR, bottom right, inside the edges
  const qrX = W - 40 - QR_ROOM, qrY = H - 30 - QR_ROOM;
  f.push(`^FO40,${H - 150}^A0N,40,40^FDIn ${day(at)}^FS`);
  f.push(`^FO40,${H - 95}^A0N,40,40^FDSOARD^FS`);
  f.push(`^FO${qrX},${qrY}^BQN,2,${QR_MAG}^FDMA,${itemUrl(tap, box)}^FS`);
  return ['^XA', '^CI28', `^MT${MEDIA}`, `^PW${W}`, `^LL${H}`, '^LH0,0', ...f, '^PQ1', '^XZ'].join('\n');
}

/** A shelf's sign → ZPL: SOARD, SHELF, the number as big as the label allows, and a QR to what's on it */
export function shelfLabel({ shelf, name }) {
  const big = String(shelf) === 'Floor' ? 'FLOOR' : zplText(shelf, 4);
  const numberSize = big.length <= 2 ? 420 : big.length <= 3 ? 300 : 200;
  const qr = 10;
  return [
    '^XA', '^CI28', `^MT${MEDIA}`, `^PW${W}`, `^LL${H}`, '^LH0,0',
    `^FO40,70^A0N,80,80^FB${INNER},1,0,C^FDSOARD^FS`,
    String(shelf) === 'Floor' ? '' : `^FO40,190^A0N,110,110^FB${INNER},1,0,C^FDSHELF^FS`,
    `^FO40,${String(shelf) === 'Floor' ? 260 : 320}^A0N,${numberSize},${numberSize}^FB${INNER},1,0,C^FD${big}^FS`,
    `^FO${Math.round((W - 41 * qr) / 2)},${H - 40 - 45 * qr}^BQN,2,${qr}^FDMA,${shelfUrl(shelf)}^FS`,
    '^PQ1', '^XZ',
  ].filter(Boolean).join('\n');
}

/** Every label for one check-in: one a box */
export function receiptLabels({ kid, item, line, set = null, boxes, shelf, at, tap }) {
  const n = Math.max(1, Math.min(20, boxes || 1));
  return Array.from({ length: n }, (_, i) => itemLabel({ kid, item, line, set, box: i + 1, boxes: n, shelf, at, tap }));
}
