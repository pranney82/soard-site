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
import { kidFromPo, tokensOf, orderGroups, orderKeys, isCarrier } from './_kid-match.js';
import { orderMail, mailStage } from './_kid-checkin.js';

// Cancelled, refunded, sent back: about an order, never what's in a box
const UNDO = new Set(['cancelled', 'refund', 'return']);
/** A name line as printed ("ATTN: DYLAN", "c/o Linzi Berkowitz") → the name */
const nameOn = (line) => String(line || '').replace(/^\s*(attn|attention|c\/o|care of|deliver to|ship to|name|po)\b[\s.:#-]*/i, '').trim();

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
    references: { type: 'array', items: { type: 'string' } },
    models: { type: 'array', items: { type: 'string' } },
    names: { type: 'array', items: { type: 'string' } },
  },
  required: ['trackingNumbers', 'orderNumbers', 'po', 'store', 'items', 'boxTotal', 'references', 'models', 'names'],
};
const LABEL_PROMPT = [
  'You read the photo of something delivered to an office: a box\'s shipping label, its packing slip, or the product\'s own box or tag. Answer in JSON only.',
  'trackingNumbers: every carrier tracking number printed (UPS 1Z…, FedEx, USPS, Amazon TBA…), digits and letters only, no spaces.',
  'orderNumbers: order numbers printed (e.g. "Order # 111-1234567-1234567", "Order: W123456789").',
  'po: what is printed as PO, P.O., Job, Job Name or Reference, else "".',
  'store: the store or sender, else "".',
  'items: the products named: each one a packing slip lists, or the product\'s own name printed on its box or tag, as written, else an empty list.',
  'models: model numbers, SKUs and item numbers printed (e.g. "52214-CZ", "Model # 7800", "SKU 1001234567"), as printed, else an empty list.',
  'names: people\'s names printed, each line on its own as printed: Ship to, Deliver to, Attn, Attention, c/o, PO or Name lines (e.g. "ATTN: DYLAN"), else an empty list.',
  'boxTotal: when the label says which box of how many ("1 of 3", "PKG 2/3", "Box 1 of 2"), the how many (3); else 0.',
  'references: every other number printed as Ref, Reference, Ref 1, Ref 2, Invoice, Customer, Dept, Shipment or PO, as printed (stores often put their order number there), else an empty list.',
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
          references: (a.references || []).map((n) => String(n).trim()).filter((n) => n.length >= 4).slice(0, 8),
          models: (a.models || []).map((n) => String(n).trim()).filter((n) => n.length >= 4).slice(0, 10),
          names: (a.names || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 8),
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
// A label's reference with the order number inside it ("SO-359672268-01"), long enough not to be chance
const inOrder = (order, ref) => { const x = orderDigits(order), y = orderDigits(ref); return x.length >= 7 && y.length > x.length && y.includes(x); };

const compactAll = (list) => (list || []).map((x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).join('|');
/** How much of a printed product name an ordered item's words cover (the best of the names printed) */
const wordsShare = (item, names) => {
  const words = new Set(tokensOf(`${item.name} ${item.orderedAs || ''} ${item.line && item.line !== 'Also bought' ? item.line : ''}`));
  return Math.max(0, ...names.map((n) => { const t = tokensOf(n); return t.length ? t.filter((w) => words.has(w)).length / t.length : 0; }));
};

/**
 * The store a box is from by its tracking number: Amazon's own ("TBA…"), or the UPS shipper account in it ("1Z" and
 * six) that another of that store's emails used. The box is from the store; which order, the rest of the label says
 */
export function storeOfTracking(numbers, reads) {
  for (const t of numbers || []) {
    const c = clean(t);
    if (/^TBA\d{6,}/.test(c)) return 'Amazon';
    if (/^1Z[A-Z0-9]{6}/.test(c)) {
      const account = c.slice(0, 8);
      // The store's own email with that account (a carrier's would say only "UPS")
      const with_ = reads.filter((x) => (x.read.tracking || []).some((tr) => clean(tr.number).startsWith(account)));
      const r = with_.find((x) => !isCarrier(x.store));
      if (r) return r.store;
    }
  }
  return null;
}

/**
 * Which kid and items a read label is → one of
 *   { kid, short, items: [item ids], how, exact? }   the kid's (exact: its own order, by tracking, order or model number)
 *   { kid, short, items: [], done, exact, order }     its order is all checked in already
 *   { look: order key, how, exact }                  its order is in Needs a look: each thing in it to its kid
 *   { which: [order keys], how }                     its email is about one of these orders (the same thing on each)
 *   { unplaced: order key, how, exact, known }        its order is known and nobody's: whose is it?
 *   { known: { key, store, orderNumber, at, buyer, things, stage, …when }, how }   its order is in the emails but on no list
 *   null
 * view: checkinView(); reads: the order emails read ({ id, store, read }); keyOf: which order each is, nameOf: who
 * ordered (checkinData's, so an order is the one the view has)
 */
export function findBox(view, reads, label, { keyOf = orderKeys(reads), nameOf = (m) => String(m || '').split('@')[0] || null } = {}) {
  const coming = (i) => i.status === 'ordered' || i.status === 'partly';
  const ordered = view.kids.flatMap((k) => k.items.filter(coming).map((i) => ({ kid: k, item: i })));
  // exact: the box's own order (its tracking or order number, or the product's model): its shipment opens. Anything
  // looser (a name, a PO, words) only narrows it down, and a person picks
  const fromOrder = (key, how) => {
    const hits = ordered.filter((x) => x.item.order?.key === key);
    if (!hits.length) {
      // The order is known and everything in it is checked in already (the second box of a shipment)
      const kid = view.kids.find((k) => k.items.some((i) => i.order?.key === key));
      return kid ? { kid: kid.jobId, short: kid.short, items: [], done: true, exact: true, order: key, how } : null;
    }
    const kid = hits[0].kid;
    return { kid: kid.jobId, short: kid.short, items: hits.filter((h) => h.kid === kid).map((h) => h.item.id), how, exact: true };
  };
  // The order the emails say it is (every email about one order is that order: its store's, a carrier's, a shipping
  // email with no order number); a kid's, in Needs a look (each thing to its kid), nobody's yet (whose is it?), or known
  // but on no list. Never "nothing found" for a box the emails know
  const groups = new Map(orderGroups(reads.filter((r) => !UNDO.has(r.read.kind)), keyOf).map((g) => [g.key, g]));
  const mail = orderMail(reads.filter((r) => !UNDO.has(r.read.kind)), keyOf);
  const knownOf = (key) => {
    const g = groups.get(key);
    const t = mail.get(key) || {};
    return { key, store: g?.store || keyOf.storeOf?.(reads.find((r) => keyOf(r) === key)) || '', orderNumber: g?.orderNumber || null, at: g?.at || null, buyer: g?.buyer ? nameOf(g.buyer) : null,
      things: (g?.items || []).map((i) => ({ name: i.name, qty: Math.max(1, Math.round(Number(i.quantity) || 1)) })),
      stage: mailStage(t), shippedAt: t.shippedAt || null, outAt: t.outAt || null, pickupAt: t.pickupAt || null, deliveredAt: t.deliveredAt || null, expected: t.expected || null };
  };
  const ofOrder = (key, how) => {
    const kid = fromOrder(key, how);
    if (kid) return kid;
    if ((view.needsLook || []).some((x) => x.key === key)) return { look: key, how, exact: true };
    if ((view.shipments || []).some((s) => s.key === key && s.unplaced)) return { unplaced: key, how, exact: true, known: knownOf(key) };
    return { known: knownOf(key), how };
  };
  // Two orders in one box (one tracking number): a kid's first, then one to look at, nobody's, known
  const ofOrders = (keys, how) => {
    const all = keys.map((k) => ofOrder(k, how));
    return all.find((x) => x.kid && x.items.length) || all.find((x) => x.look) || all.find((x) => x.unplaced) || all.find((x) => x.kid) || all.find((x) => x.known?.things.length) || all[0];
  };
  const keysOf = (hit) => [...new Set(reads.filter(hit).map(keyOf))];
  for (const t of label.trackingNumbers || []) {
    const hits = reads.filter((x) => (x.read.tracking || []).some((tr) => sameTracking(tr.number, t)));
    const how = `Tracking …${clean(t).slice(-6)}`;
    // Its email is about one of several orders (the same thing on each): those orders, for a person to pick
    const which = hits.length && hits.every((x) => keyOf.maybe?.(x)) ? [...new Set(hits.flatMap((x) => keyOf.maybe(x)))] : null;
    if (which) return { which, how };
    const keys = [...new Set(hits.filter((x) => !keyOf.maybe?.(x)).map(keyOf))];
    if (keys.length) return ofOrders(keys, how);
  }
  for (const o of [...(label.orderNumbers || []), ...(label.references || [])]) {
    const keys = keysOf((x) => !isCarrier(x.store) && (sameOrder(x.read.orderNumber, o) || inOrder(x.read.orderNumber, o)));
    if (keys.length) return ofOrders(keys, `Order ${orderDigits(o) || o}`);
  }
  for (const ref of label.references || []) {
    const po = kidFromPo(ref, view.kids.map((k) => ({ id: k.jobId, name: k.name })));
    const kid = po?.kid && view.kids.find((k) => k.jobId === po.kid);
    if (kid) return { kid: kid.jobId, short: kid.short, items: kid.items.filter((i) => i.status === 'ordered' || i.status === 'partly').map((i) => i.id), how: `Reference “${ref}”` };
  }
  // The product's own model number (on its box, its tag or the packing slip) against the designer's: one kid, these items
  const printed = compactAll([...(label.models || []), ...(label.items || [])]);
  if (printed) {
    const hits = ordered.filter(({ item }) => { const m = compactAll([item.model]); return m.length >= 4 && printed.includes(m); });
    const kids = new Set(hits.map((h) => h.kid.jobId));
    if (kids.size === 1) return { kid: hits[0].kid.jobId, short: hits[0].kid.short, items: hits.map((h) => h.item.id), how: `Model ${hits[0].item.model}`, exact: true };
  }
  // The kid's name on the label ("Attn: Dylan" in the address, or the PO box): that kid; the slip's or the box's names
  // narrow it to the things it is
  const jobs = view.kids.map((k) => ({ id: k.jobId, name: k.name }));
  for (const line of label.names || []) {
    const po = kidFromPo(nameOn(line), jobs);
    const kid = po?.kid && view.kids.find((k) => k.jobId === po.kid);
    if (!kid) continue;
    const mine = ordered.filter((x) => x.kid === kid);
    const named = (label.items || []).length ? mine.filter(({ item }) => wordsShare(item, label.items) >= 0.5) : [];
    return { kid: kid.jobId, short: kid.short, items: (named.length ? named : mine).map((x) => x.item.id), how: `${kid.short} on the label` };
  }
  if (label.po) {
    const po = kidFromPo(label.po, jobs);
    const kid = po?.kid && view.kids.find((k) => k.jobId === po.kid);
    if (kid) return { kid: kid.jobId, short: kid.short, items: kid.items.filter(coming).map((i) => i.id), how: `PO “${label.po}”` };
  }
  // A packing slip's items against what's been ordered: the kid whose ordered items share the most words
  if ((label.items || []).length) {
    const scored = [];
    for (const { kid, item } of ordered) {
      const best = wordsShare(item, label.items);
      if (best >= 0.5) scored.push({ kid, item, best });
    }
    const kids = new Set(scored.map((s) => s.kid.jobId));
    if (kids.size === 1) {
      const kid = scored[0].kid;
      return { kid: kid.jobId, short: kid.short, items: scored.sort((a, b) => b.best - a.best).map((s) => s.item.id), how: 'Its name on the box' };
    }
  }
  return null;
}

/**
 * When a label ties to no order the emails know (Amazon's and Crate & Barrel's emails never carry the box's tracking
 * number; some orders send no email at all): the boxes it most likely is, best first, each with why → [
 *   { kid, short, item, why }   one of a kid's things not here yet (ordered, or not ordered as far as the emails say)
 *   { order, why }              an order nobody's placed yet
 * ]. What counts: the store (on the label, or told by its tracking number), the label's own words for what's in it
 * against each thing's name and line, who ordered it (a staff name on the label: "Linzi"), and delivered lately
 */
export function likelyBoxes(view, reads, label, { now = Date.now(), max = 6, keyOf = orderKeys(reads) } = {}) {
  const delivered = new Map();
  for (const r of reads) {
    if (r.read.kind !== 'delivered' && r.read.kind !== 'out') continue;
    const at = Date.parse(r.at);
    if (now - at > 7 * 86400e3) continue;
    const k = keyOf(r);
    if (!delivered.has(k) || delivered.get(k) < at) delivered.set(k, at);
  }
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'inc', 'llc', 'com', 'store', 'logistics', 'supply'].includes(w)));
  // The store the label prints, and the one its tracking number says (a warehouse ships for the store: "TRADEWINDS
  // LOGISTICS" on a box of Plank Hardware's, by its UPS account)
  const from = new Set([label.store, storeOfTracking(label.trackingNumbers, reads)].flatMap((s) => [...words(s)]));
  const sameStore = (s) => from.size > 0 && [...words(s)].some((w) => from.has(w));
  // A staff name on the label says who ordered it only when few orders are theirs (Clareece's is on nearly every box):
  // counted by orders, one each, however many things are in it
  const named = new Set((label.names || []).map((n) => nameOn(n).split(/\s+/)[0].toLowerCase()).filter((w) => w.length > 1));
  const buyerOf = new Map();
  for (const k of view.kids) for (const i of k.items) if (i.order?.key && i.order.buyer) buyerOf.set(i.order.key, i.order.buyer);
  for (const x of view.shipments || []) if (x.unplaced && x.buyer) buyerOf.set(x.key, x.buyer);
  const buyersOf = [...buyerOf.values()].map((b) => String(b).toLowerCase());
  const firsts = new Set([...named].filter((n) => buyersOf.length && buyersOf.filter((b) => b === n).length / buyersOf.length <= 0.3));
  const printed = [...(label.items || []), ...(label.models || [])].filter(Boolean);
  const said = (name) => printed.find((p) => wordsShare({ name }, [p]) >= 0.5) || printed[0];
  const score = ({ storeName, buyer, share, deliveredAt, ordered }) => {
    const why = [];
    let n = 0;
    if (storeName && sameStore(storeName)) { n += 3; why.push(`From ${storeName}`); }
    if (share >= 0.5) { n += 3 + share; why.push('Its name is on the box'); }
    if (buyer && firsts.has(String(buyer).toLowerCase())) { n += 2; why.push(`${buyer} ordered it`); }
    if (deliveredAt) { n += 2; why.push('Delivered lately'); }
    if (!ordered && share < 0.5) return null;
    return n >= 2 ? { n, why: why.join(' · ') } : null;
  };
  const out = [];
  for (const kid of view.kids) {
    for (const it of kid.items.filter((i) => ['ordered', 'partly', 'not'].includes(i.status))) {
      const share = printed.length ? wordsShare(it, printed) : 0;
      const d = it.order && delivered.get(it.order.key);
      const s2 = score({ storeName: it.order?.store, buyer: it.order?.buyer, share, deliveredAt: d, ordered: Boolean(it.order) });
      if (s2) out.push({ kid: kid.jobId, short: kid.short, item: it.id, rank: s2.n, at: d || Date.parse(it.order?.at || 0) || 0, why: s2.why || (share >= 0.5 ? `“${said(it.name)}” on the box` : '') });
    }
  }
  for (const sh of (view.shipments || []).filter((x) => x.unplaced)) {
    const share = printed.length ? Math.max(0, ...sh.things.map((t) => wordsShare({ name: t.name }, printed))) : 0;
    const d = delivered.get(sh.key);
    const s2 = score({ storeName: sh.store, buyer: sh.buyer, share, deliveredAt: d, ordered: true });
    if (s2) out.push({ order: sh.key, rank: s2.n, at: d || Date.parse(sh.orderedAt || 0) || 0, why: s2.why });
  }
  return out.sort((a, b) => b.rank - a.rank || b.at - a.at).slice(0, max).map(({ rank, at, ...x }) => x);
}
