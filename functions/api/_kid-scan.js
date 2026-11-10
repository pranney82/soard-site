/**
 * Kid items: "Scan a box" at check-in — a photo of the box's label → which kid and which items
 * ===========================================================================
 * Clareece photographs the shipping label or packing slip. Workers AI reads
 * what's printed on it (tracking numbers, order numbers, the PO, the items on a
 * packing slip), and the site finds the order it read from the store's emails:
 *   1. a tracking number from the store's shipping email (UPS, FedEx, USPS print
 *      extra digits around it in the barcode, so the end of the number counts);
 *   2. an order number (Amazon's packing slip shows it; its emails carry no
 *      tracking number);
 *   3. the PO typed at checkout, when it names a kid;
 *   4. the items a packing slip lists, against what's been ordered for each kid.
 * The answer is the kid and the ordered items the box could be, or nothing found
 * (then she picks from the list). Read only: nothing is saved but the photo's
 * read, nothing goes to JobTread.
 */

import { viaGateway, aiCapped } from './_ai.js';
import { imageKind } from './_image-types.js';
import { answerOf } from './_vendor-read.js';
import { READERS } from './_score-scans.js';
import { kidFromPo, tokensOf, groupKey } from './_kid-match.js';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 25 * 1000;

export const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    trackingNumbers: { type: 'array', items: { type: 'string' } },
    orderNumbers: { type: 'array', items: { type: 'string' } },
    po: { type: 'string' },
    store: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
    boxTotal: { type: 'number' },
  },
  required: ['trackingNumbers', 'orderNumbers', 'po', 'store', 'items', 'boxTotal'],
};
const LABEL_PROMPT = [
  'You read the photo of a shipping label or packing slip on a box delivered to an office. Answer in JSON only.',
  'trackingNumbers: every carrier tracking number printed (UPS 1Z…, FedEx, USPS, Amazon TBA…), digits and letters only, no spaces.',
  'orderNumbers: order numbers printed (e.g. "Order # 111-1234567-1234567", "Order: W123456789").',
  'po: what is printed as PO, P.O., Job, Job Name or Reference, else "".',
  'store: the store or sender, else "".',
  'items: the products a packing slip lists, as written, else an empty list.',
  'boxTotal: when the label says which box of how many ("1 of 3", "PKG 2/3", "Box 1 of 2"), the how many (3); else 0.',
  'Never guess: leave a field empty when it isn\'t printed.',
].join('\n');

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A label photo read → { trackingNumbers, orderNumbers, po, store, items } | throws a plain-words error */
export async function readLabel(env, bytes) {
  const kind = imageKind(bytes);
  if (!['jpeg', 'png', 'webp'].includes(kind)) throw Object.assign(new Error('That isn’t a photo the site can read. Take it again.'), { status: 400 });
  if (bytes.length > MAX_BYTES) throw Object.assign(new Error('That photo is too big. Take it again.'), { status: 400 });
  if (!env.AI?.run) throw Object.assign(new Error('The site can’t read photos right now.'), { status: 503 });
  const url = `data:image/${kind};base64,${toBase64(bytes)}`;
  // One reader, the other if the first doesn't answer: a person is waiting
  for (const [model, extra] of Object.entries(READERS)) {
    let timer;
    try {
      const out = await Promise.race([
        env.AI.run(model, {
          messages: [{ role: 'system', content: LABEL_PROMPT }, { role: 'user', content: [{ type: 'text', text: 'Read this label.' }, { type: 'image_url', image_url: { url } }] }],
          max_tokens: 500, temperature: 0, ...extra, response_format: { type: 'json_schema', json_schema: LABEL_SCHEMA },
        }, viaGateway('checkin-scan')),
        new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), TIMEOUT_MS); }),
      ]);
      const a = answerOf(out);
      if (a && typeof a === 'object') {
        return {
          trackingNumbers: (a.trackingNumbers || []).map(clean).filter((n) => n.length >= 8).slice(0, 6),
          orderNumbers: (a.orderNumbers || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 6),
          po: String(a.po || '').trim().slice(0, 60),
          store: String(a.store || '').trim().slice(0, 60),
          items: (a.items || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 20),
          boxTotal: Number.isInteger(Number(a.boxTotal)) && Number(a.boxTotal) > 1 && Number(a.boxTotal) <= 20 ? Number(a.boxTotal) : 0,
        };
      }
    } catch (err) {
      if (aiCapped(err)) throw Object.assign(new Error('The site’s photo reading is paused for now (its spending cap). Pick the item from the list.'), { status: 503 });
      console.error('[kid-scan]', model, err.message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw Object.assign(new Error('The label couldn’t be read. Take the photo again, closer and straight on.'), { status: 502 });
}

/** Do two tracking numbers name the same package? Equal, or one ends with the other (12 characters at least) */
export function sameTracking(a, b) {
  const x = clean(a), y = clean(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.endsWith(short);
}
// An order number as printed ("Order # 111-1234567-1234567", "ORDER NO. W123456789") against the one from the email
const orderDigits = (s) => clean(String(s || '').replace(/\b(order|ord|no|number|num|confirmation)\b\.?/gi, ' '));
const sameOrder = (a, b) => { const x = orderDigits(a), y = orderDigits(b); return x.length >= 5 && x === y; };

/**
 * Which kid and items a read label is → { kid, short, items: [item ids], how } | null
 * view: checkinView(); reads: the order emails read ({ id, store, read })
 */
export function findBox(view, reads, label) {
  const coming = (i) => i.status === 'ordered' || i.status === 'partly';
  const ordered = view.kids.flatMap((k) => k.items.filter(coming).map((i) => ({ kid: k, item: i })));
  const fromOrder = (key, how) => {
    const hits = ordered.filter((x) => x.item.order?.key === key);
    if (!hits.length) return null;
    const kid = hits[0].kid;
    return { kid: kid.jobId, short: kid.short, items: hits.filter((h) => h.kid === kid).map((h) => h.item.id), how };
  };
  for (const t of label.trackingNumbers || []) {
    const r = reads.find((x) => (x.read.tracking || []).some((tr) => sameTracking(tr.number, t)));
    const found = r && fromOrder(groupKey(r), `Tracking …${t.slice(-6)}`);
    if (found) return found;
  }
  for (const o of label.orderNumbers || []) {
    const r = reads.find((x) => sameOrder(x.read.orderNumber, o));
    const found = r && fromOrder(groupKey(r), `Order ${o}`);
    if (found) return found;
  }
  if (label.po) {
    const jobs = view.kids.map((k) => ({ id: k.jobId, name: k.name }));
    const po = kidFromPo(label.po, jobs);
    const kid = po?.kid && view.kids.find((k) => k.jobId === po.kid);
    if (kid) return { kid: kid.jobId, short: kid.short, items: kid.items.filter(coming).map((i) => i.id), how: `PO “${label.po}”` };
  }
  // A packing slip's items against what's been ordered: the kid whose ordered items share the most words
  if ((label.items || []).length) {
    const scored = [];
    for (const { kid, item } of ordered) {
      const words = new Set(tokensOf(`${item.name} ${item.orderedAs || ''}`));
      const best = Math.max(0, ...label.items.map((n) => { const t = tokensOf(n); return t.length ? t.filter((w) => words.has(w)).length / t.length : 0; }));
      if (best >= 0.5) scored.push({ kid, item, best });
    }
    const kids = new Set(scored.map((s) => s.kid.jobId));
    if (kids.size === 1) {
      const kid = scored[0].kid;
      return { kid: kid.jobId, short: kid.short, items: scored.sort((a, b) => b.best - a.best).map((s) => s.item.id), how: 'Packing slip' };
    }
  }
  return null;
}
