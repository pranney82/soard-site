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

/** The kid's name sized to fit the label's width (a long name gets smaller letters) */
const nameSize = (name) => (name.length <= 9 ? 150 : name.length <= 13 ? 120 : name.length <= 18 ? 92 : 72);

/**
 * One box's label → ZPL
 * { kid: 'Lizzie F.', item, line, box, boxes, shelf: 'Shelf 7', at, tap }
 */
export function itemLabel({ kid, item, line, box = 1, boxes = 1, shelf, at, tap }) {
  const name = zplText(kid, 24).toUpperCase();
  const size = nameSize(name);
  return [
    '^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0',
    // The kid
    `^FO40,50^A0N,${size},${size}^FB732,1,0,L^FD${name}^FS`,
    `^FO40,${80 + size}^GB732,4,4^FS`,
    // What it is, up to three lines, and its line
    `^FO40,${110 + size}^A0N,54,54^FB732,3,6,L^FD${zplText(item, 140)}^FS`,
    `^FO40,${300 + size}^A0N,36,36^FB732,1,0,L^FD${zplText(line, 60)}^FS`,
    // Box n of N
    `^FO40,${370 + size}^A0N,70,70^FDBox ${box} of ${boxes}^FS`,
    // The shelf, white on a black band
    `^FO40,${480 + size}^GB732,150,150^FS`,
    `^FO40,${505 + size}^A0N,110,110^FB732,1,0,C^FR^FD${zplText(shelf || 'Shelf', 20).toUpperCase()}^FS`,
    // The day it came in, SOARD, and the QR for load-out
    `^FO40,${H - 300}^A0N,40,40^FDIn ${day(at)}^FS`,
    `^FO40,${H - 245}^A0N,40,40^FDSOARD^FS`,
    `^FO${W - 300},${H - 320}^BQN,2,7^FDQA,${itemUrl(tap, box)}^FS`,
    '^PQ1', '^XZ',
  ].join('\n');
}

/** A shelf's sign → ZPL */
export function shelfLabel({ shelf, name }) {
  const big = zplText(name, 12).toUpperCase();
  return [
    '^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0',
    `^FO40,80^A0N,90,90^FB732,1,0,C^FDSOARD^FS`,
    `^FO40,230^A0N,${big.length <= 8 ? 220 : 160},${big.length <= 8 ? 200 : 140}^FB732,1,0,C^FD${big}^FS`,
    `^FO256,${H - 470}^BQN,2,10^FDQA,${shelfUrl(shelf)}^FS`,
    '^PQ1', '^XZ',
  ].join('\n');
}

/** Every label for one check-in: one a box */
export function receiptLabels({ kid, item, line, boxes, shelf, at, tap }) {
  const n = Math.max(1, Math.min(20, boxes || 1));
  return Array.from({ length: n }, (_, i) => itemLabel({ kid, item, line, box: i + 1, boxes: n, shelf, at, tap }));
}
