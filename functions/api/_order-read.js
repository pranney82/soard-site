/**
 * Reading a store's order email: what was ordered, where it's going, how it's coming
 * ===========================================================================
 * Pure functions, no I/O. ./_order-sweep.js finds the emails and calls these;
 * tests/order-read.test.mjs drives them directly.
 *
 * An order, shipping, delivery, pickup, delay, cancel, refund or return email
 * from a store becomes one read:
 *
 *   { kind, store, orderNumber, items: [{ name, sku, quantity, cents }],
 *     tracking: [{ carrier, number }], expected, shipTo, jobPo, productIds, source }
 *
 * Best source first, each filling only what the one before left empty:
 *   1. the store's own order markup (schema.org Order / ParcelDelivery, which
 *      many stores put in their emails for Gmail);
 *   2. a reader for a store whose plain words are regular (Amazon);
 *   3. rules any email answers to: tracking numbers in the words and in the
 *      Track links, the Job / PO box, an Office ship-to, the order number;
 *   4. Workers AI (./_order-sweep.js) for the items when nothing above found them.
 *
 * Tracking numbers come from links as well as words: a store often prints only
 * a "Track package" button, and the number is in its address. Links are kept
 * for that, never followed.
 */

// ─── Which store, which kind of email ───────────────────────────────

const STORES = [
  [/(^|\.)amazon\.com$/, 'Amazon'], [/(^|\.)crateandbarrel\.com$/, 'Crate & Barrel'], [/(^|\.)cb2\.com$/, 'CB2'],
  [/(^|\.)wayfair\.com$/, 'Wayfair'], [/(^|\.)allmodern\.com$/, 'AllModern'], [/(^|\.)perigold\.com$/, 'Perigold'],
  [/(^|\.)birchlane\.com$/, 'Birch Lane'], [/(^|\.)jossandmain\.com$/, 'Joss & Main'], [/(^|\.)bestbuy\.com$/, 'Best Buy'],
  [/(^|\.)homedepot\.com$/, 'The Home Depot'], [/(^|\.)lowes\.com$/, 'Lowe’s'], [/(^|\.)target\.com$/, 'Target'],
  [/(^|\.)walmart\.com$/, 'Walmart'], [/(^|\.)potterybarnkids\.com$/, 'Pottery Barn Kids'], [/(^|\.)pbteen\.com$/, 'Pottery Barn Teen'],
  [/(^|\.)potterybarn\.com$/, 'Pottery Barn'], [/(^|\.)westelm\.com$/, 'West Elm'], [/(^|\.)rejuvenation\.com$/, 'Rejuvenation'],
  [/(^|\.)williams-sonoma\.com$/, 'Williams Sonoma'], [/(^|\.)containerstore\.com$/, 'The Container Store'], [/(^|\.)etsy\.com$/, 'Etsy'],
  [/(^|\.)ikea\.(com|us)$/, 'IKEA'], [/(^|\.)lego\.com$/, 'LEGO'], [/(^|\.)walgreens\.com$/, 'Walgreens'], [/(^|\.)costco\.com$/, 'Costco'],
];
// Carriers write too ("Your FedEx shipment is on its way"): their notices carry tracking, never items
const CARRIERS = [[/(^|\.)ups\.com$/, 'UPS'], [/(^|\.)fedex\.com$/, 'FedEx'], [/(^|\.)usps\.(com|gov)$/, 'USPS']];
// The display name's own noise: "'The Home Depot' via orders", "Best Buy Notifications", "Etsy Shipping Notifications"
const NAME_NOISE = /\b(via \w+|notifications?|shipping|orders?|customer (service|care)|no-?reply|updates?|team)\b/gi;

/** The store an email is from: { store, carrier } by its sender's domain, else its display name tidied */
export function storeOf(fromHeader) {
  const s = String(fromHeader || '');
  const email = (s.match(/<([^<>\s]+@[^<>\s]+)>/) || s.match(/([^\s<>"]+@[^\s<>"]+)/) || [])[1] || '';
  const domain = email.split('@')[1]?.toLowerCase() || '';
  for (const [re, name] of CARRIERS) if (re.test(domain)) return { store: null, carrier: name, domain };
  for (const [re, name] of STORES) if (re.test(domain)) return { store: name, carrier: null, domain };
  const shown = s.replace(/<[^>]*>/g, '').replace(/["']/g, '').replace(NAME_NOISE, '').replace(/\s+/g, ' ').trim();
  return { store: shown || domain.replace(/^(mail|email|e|info|orders?|shop|em|t)\./, '') || null, carrier: null, domain };
}

// Not about an order at all: ads, carts, reviews. A subject naming an order kind still counts ("Your order has arrived")
const ADVERT = /\b(\d+% off|sale\b|deals?\b|coupons?|promo|cart\b|wish ?list|review (your|us)|rate (your|us)|how did we do|survey|back in stock|price drop|new arrivals|gift card balance|newsletter)\b/i;
// In order: what the email most is (a refund email also says "order"; a delivered one also says "shipped")
const KINDS = [
  ['refund', /\brefund(ed|s)?\b|\bcredit (has been )?issued\b/i],
  ['return', /\breturn (received|label|started|request(ed)?|is on its way|confirmation|processed)\b|\byour return\b|\breturn(ed)? (item|order|package)\b/i],
  ['cancelled', /\bcancel(l?ed|lation)\b/i],
  ['delayed', /\bdelay(ed)?\b|\brunning late\b|\bnew (estimated |expected )?(delivery|arrival) date\b|\bback-?order(ed)?\b|\bupdated (delivery|arrival)\b/i],
  ['pickup', /\bready (for|to) (pick ?up|pickup)\b|\bpicked up\b|\bpickup (is )?ready\b/i],
  ['out', /\bout for delivery\b|\barriving today\b|\bdelivery today\b|\bwill be delivered today\b/i],
  // "Your order will be delivered tomorrow" is still on its way
  ['shipped', /\b(will|to|scheduled to|set to|expected to) be delivered\b|\bscheduled for delivery\b/i],
  // "Arrived: Your Bathroom Storage Cart..." (Walmart's), "Your package arrived"
  ['delivered', /\bdelivered\b|\b(has|have) arrived\b|\border has arrived\b|\bwas left at\b|^\s*arrived\b|\b(package|order|delivery|items?|box) arrived\b/i],
  ['shipped', /\bshipped\b|\bon (its|the|their) way\b|\b(is|are|has) shipping\b|\btrack (your )?(package|order|shipment)\b|\barriving (soon|tomorrow|on|(mon|tues|wednes|thurs|fri|satur|sun)day)\b|\bshipment\b|\bin transit\b/i],
  ['order', /\border (confirmation|confirmed|received|placed|#|no\.?|number|summary|details)\b|\bthanks? (you )?for (your |shopping)?(order|purchase)\b|\b(we('ve| have)|has been) received your order\b|\byour (\w+ )?order (is confirmed|has been (placed|received|confirmed))\b|\border is confirmed\b|\byour order confirmation\b|\bwe got your order\b|\bprocessing your order\b|\byour (\w+ )?purchase from\b|^ordered:|\bwe (have |'ve |’ve )?received your order\b/i],
];

/** What kind of order email a subject (and its preview) is → kind | null */
export function orderKind(subject, snippet = '') {
  const s = String(subject || '');
  for (const [kind, re] of KINDS) if (re.test(s)) return kind;
  if (ADVERT.test(s)) return null;
  // Some stores put it only in the preview: "Your package was delivered!" under a subject of the item's name
  const p = String(snippet || '').slice(0, 160);
  for (const [kind, re] of KINDS) if (kind !== 'order' && re.test(p)) return kind;
  // An order confirmation whose subject says only thanks ("Thanks from The Container Store!"): its preview names the
  // order by its number ("your order 899120272624"). An ad's "order 2 or more" has no number that long
  if (ORDER_NUMBER_SAID.test(p)) return 'order';
  return null;
}
const ORDER_NUMBER_SAID = /\border\s*(?:#|no\.?|number:?)?\s*#?\s*[A-Z]{0,4}-?\d{6,}/i;

/**
 * An order email's total, in cents: what was paid for it all ("Order Total $502.10", Walmart's "Includes all fees,
 * taxes and discounts $83.76") → cents | null. Its subtotal is never taken for it
 */
export function orderTotalCents(...texts) {
  const RULES = [
    /\b(?:order total|grand total|total amount|amount charged|total charged|total paid|payment total)\b[^$\d]{0,40}\$\s?([\d,]+\.\d{2})/i,
    /\bincludes all fees,? taxes(?: and discounts)?[^$\d]{0,20}\$\s?([\d,]+\.\d{2})/i,
    /(?<!sub)(?<!sub-)(?<!sub )\btotal\b:?[^$\d\n]{0,20}\$\s?([\d,]+\.\d{2})/i,
  ];
  for (const re of RULES) {
    for (const t of texts) {
      const m = re.exec(String(t || ''));
      if (m) return centsOf(m[1]);
    }
  }
  return null;
}

/**
 * A one-thing order whose email gives only what was paid in all (Walmart's): that is the thing's price (each, when
 * several of it came), tax and fees in. A read with its price, or with more than one thing, is left as it is
 */
export function withOneTotal(read, ...texts) {
  if (read?.kind !== 'order' || (read.items || []).length !== 1 || read.items[0].cents) return read;
  const total = orderTotalCents(...texts);
  if (!total) return read;
  const it = read.items[0];
  return { ...read, items: [{ ...it, cents: Math.round(total / Math.max(1, it.quantity || 1)), fromTotal: true }] };
}

// ─── Links and tracking ─────────────────────────────────────────────

const decodeEntities = (s) => String(s).replace(/&amp;/g, '&').replace(/&#x3[dD];/g, '=').replace(/&#61;/g, '=').replace(/&quot;/g, '"');

/** Every link in an HTML email, decoded once (tracking redirects wrap the real address in a parameter) */
export function linksOf(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = decodeEntities(m[1]);
    out.push(raw);
    // A click-tracking redirect carries the store's link in a parameter: ?url=https%3A%2F%2Fwww.ups.com…
    for (const p of raw.matchAll(/[?&](?:url|u|target|redirect|dest|destination|link|r)=([^&]+)/gi)) {
      try { const inner = decodeURIComponent(p[1]); if (/^https?:/i.test(inner)) out.push(inner); } catch { /* not encoded */ }
    }
  }
  return [...new Set(out)];
}

const TRACK_PARAM = /[?&#](?:tracknum|tracknumbers|trackingnumber|tracking_number|trackingnumbers|trknbr|tlabels|tracking|trackingid|tracking_id|inquirynumber\d?|qtc_tlabels1)=([A-Za-z0-9]{8,34})/i;
const carrierOfHost = (u) => {
  const host = (String(u).match(/^https?:\/\/([^/?#]+)/i) || [])[1]?.toLowerCase() || '';
  if (/(^|\.)ups\.com$/.test(host)) return 'UPS';
  if (/(^|\.)fedex\.com$/.test(host)) return 'FedEx';
  if (/(^|\.)usps\.com$/.test(host)) return 'USPS';
  if (/(^|\.)ontrac\.com$/.test(host)) return 'OnTrac';
  if (/(^|\.)lasership\.com$/.test(host)) return 'LaserShip';
  return null;
};

/** A tracking number's carrier from its shape alone → carrier | null */
export function carrierOfNumber(n) {
  const s = String(n || '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(s)) return 'UPS';
  if (/^TBA\d{9,13}$/.test(s)) return 'Amazon';
  if (/^9[1-5]\d{18,24}$/.test(s)) return 'USPS';
  if (/^(\d{12}|\d{15}|\d{20})$/.test(s)) return 'FedEx';
  return null;
}

/** Tracking numbers in an email's words and links → [{ carrier, number }], each once */
export function trackingIn(text, links = []) {
  const found = new Map();
  const add = (number, carrier) => {
    const n = String(number).toUpperCase();
    const c = carrier || carrierOfNumber(n);
    if (!c || found.has(n)) return;
    found.set(n, { carrier: c, number: n });
  };
  // UPS and Amazon numbers by their exact shape, upper case, standing on their own (not the middle of a link's code)
  const SHAPED = /(?<![A-Za-z0-9])(1Z[0-9A-Z]{16}|TBA\d{9,13})(?![A-Za-z0-9])/g;
  for (const u of links) {
    const m = TRACK_PARAM.exec(u);
    // A tracking parameter's value counts only when it has a carrier's shape ("tracking=ENABLED" doesn't)
    if (m && carrierOfNumber(m[1])) add(m[1], carrierOfHost(u));
    // ups.com/track?loc=…&tracknum=1Z…, fedex.com/fedextrack/?trknbr=…, and the path kind: /track/1Z…
    for (const p of String(u).matchAll(SHAPED)) add(p[1]);
  }
  const t = String(text || '');
  for (const m of t.matchAll(SHAPED)) add(m[1]);
  // A long bare number only where the words call it tracking with a carrier named: an order number (Target's and
  // Walmart's run to 15 digits) or a phone number mustn't pass for one
  for (const m of t.matchAll(/\b(USPS|FedEx|Fed Ex)\b[^\n]{0,40}?\btracking\b[^\n]{0,25}?\b(\d{12,26})\b/gi)) {
    const carrier = /usps/i.test(m[1]) ? 'USPS' : 'FedEx';
    if (carrierOfNumber(m[2]) === carrier) add(m[2], carrier);
  }
  for (const m of t.matchAll(/\btracking\b[^\n]{0,25}?\b(\d{12,26})\b[^\n]{0,30}?\b(USPS|FedEx|Fed Ex)\b/gi)) {
    const carrier = /usps/i.test(m[2]) ? 'USPS' : 'FedEx';
    if (carrierOfNumber(m[1]) === carrier) add(m[1], carrier);
  }
  // A UPS number in either case where the words name UPS beside it: The Container Store writes "UPS # 1z12d1r2…"
  // (seen Nov 11 2026; every one of its emails was missed while only upper case counted)
  for (const m of t.matchAll(/\bUPS\b[^\n]{0,30}?(?<![A-Za-z0-9])(1Z[0-9A-Z]{16})(?![A-Za-z0-9])/gi)) add(m[1], 'UPS');
  // Any case for the label, but the number as printed: upper case and digits
  for (const m of t.matchAll(/\btracking (?:number|#|no\.?)[ \t]*:?[ \t]*([A-Za-z0-9]{10,34})\b/gi)) if (m[1] === m[1].toUpperCase()) add(m[1]);
  return [...found.values()];
}

/** Store product ids in links, for matching to a designer's link: Amazon ASINs, Wayfair SKUs, Home Depot ids */
export function productIdsIn(links = [], text = '') {
  const ids = new Set();
  for (const u of [...links, ...String(text).match(/https?:\/\/\S+/g) || []]) {
    const s = String(u);
    for (const m of s.matchAll(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})\b/g)) ids.add(`amazon:${m[1]}`);
    for (const m of s.matchAll(/wayfair\.com\/[^?#]*?[-/]((?:w\d{6,}|[a-z]{3,5}\d{4,}))\.html/gi)) ids.add(`wayfair:${m[1].toLowerCase()}`);
    for (const m of s.matchAll(/homedepot\.com\/p\/[^?#]*\/(\d{9})\b/gi)) ids.add(`homedepot:${m[1]}`);
    for (const m of s.matchAll(/[?&](?:sku|skuid|skuId)=(\d{5,})/g)) ids.add(`sku:${m[1]}`);
  }
  return [...ids];
}

// ─── The rules any email answers to ─────────────────────────────────

/** What was typed in the order's Job / PO box: "Lizzie" → 'Lizzie' | null */
export function jobPoIn(text) {
  // A label, then what was typed: "Job / PO Number: Lizzie", "PO #: Office", "Purchase order: …" (never "your purchase order has shipped")
  const m = /\b(?:job[ \t]*\/[ \t]*po(?:[ \t]*(?:number|#|no\.?))?[ \t]*:?|po[ \t]*(?:number|#|no\.?)[ \t]*:?|purchase order[ \t]*(?:(?:number|#|no\.?)[ \t]*:?|:))[ \t]*([^\n]{1,60})/i.exec(String(text || ''));
  if (!m) return null;
  const v = m[1].split(/\s{2,}|\s(?=(?:customer|phone|order|delivery|deliver|ship|email|billing|payment|date|total)\b)/i)[0].trim().replace(/[.;,]+$/, '');
  return v && !/^(n\/?a|none|-+)$/i.test(v) ? v.slice(0, 40) : null;
}

// SOARD's Office at Hembree Park; Amazon Business writes the account's ship-to as "Sunshine - ROSWELL, GA"
const OFFICE = /\bhembree park\b|\bsunshine\s*-\s*roswell\b/i;
const ADDRESSED = /\b(ship(ping)? to|deliver(ed|ing)? to|delivery address|shipping address)\b/i;
// A street address: a number, up to four words, then the kind of street
const STREET = /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(st|street|rd|road|ave|avenue|ln|lane|dr|drive|ct|court|way|blvd|boulevard|pkwy|parkway|cir|circle|trl|trail|pl|place|ter|terrace|hwy|highway)\b/i;
const BILLING = /\b(bill(ing)?[ \t]+(to|address|info(rmation)?)|billed to|payment (method|info(rmation)?))\b/i;
/**
 * Where it's going: 'office' | 'elsewhere' (a ship-to that isn't the Office) | null (the email doesn't say).
 * Only the words after a ship-to label count, up to a billing block: an order billed to the Office but shipped to
 * a family's home is going to the home. With no label, the email's words without its billing block
 */
export function shipToIn(text) {
  const t = String(text || '');
  const blocks = [];
  const re = new RegExp(ADDRESSED.source, 'gi');
  for (const m of t.matchAll(re)) {
    const after = t.slice(m.index, m.index + 260);
    const stop = BILLING.exec(after.slice(m[0].length));
    blocks.push(stop ? after.slice(0, m[0].length + stop.index) : after);
  }
  if (blocks.length) {
    if (blocks.some((b) => OFFICE.test(b))) return 'office';
    return blocks.some((b) => STREET.test(b)) ? 'elsewhere' : null;
  }
  // No ship-to label (Amazon Business writes only "Sunshine - ROSWELL, GA"): anything but a billing block
  const unbilled = t.replace(new RegExp(`${BILLING.source}[\\s\\S]{0,260}`, 'gi'), ' ');
  return OFFICE.test(unbilled) ? 'office' : null;
}

/** The store's order number → string | null (Amazon's 111-1234567-1234567, "Order # WH51088760", "order 359672268") */
export function orderNumberIn(text, subject = '') {
  const both = `${subject}\n${text}`;
  const amazon = /\b(\d{3}-\d{7}-\d{7})\b/.exec(both);
  if (amazon) return amazon[1];
  // A plain label may sit above its number ("Order Number\nW123456789", a table's cells); otherwise the label and
  // the number share a line: "Questions about your order\n1-800-…" is a phone number
  const m = /\border[ \t]*(?:#|no\.|number)[ \t]*:?[ \t]*(?:\n[ \t]*){0,2}#?[ \t]*([A-Z]{0,4}\d[A-Z0-9-]{4,24})\b/i.exec(both)
    || /\border[ \t]*(?:confirmation(?: is| number)?)?[ \t]*:?[ \t]*#?[ \t]*([A-Z]{0,4}\d[A-Z0-9-]{4,24})\b/i.exec(both);
  return m ? m[1].toUpperCase() : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// A month as written: its full name or its short form, never a word that starts like one ("Marketplace", "Decor")
const MONTH = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[ \t]+(\d{1,2})\b/i;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const iso = (d) => d.toISOString().slice(0, 10);
/** The day an email was sent, in Eastern time (SOARD's): noon UTC that day, and its weekday */
function sentDay(sentAt) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(sentAt || Date.now())).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 12));
}
/** The day it's expected: "Arriving Thursday", "Delivery NOV 16 Est", "Estimated delivery: November 16" → 'YYYY-MM-DD' | null */
export function expectedIn(text, sentAt) {
  const t = String(text || '');
  const base = sentDay(sentAt);
  // Words that say it's about delivery, then what follows them on the line
  const near = /\b(arriv\w*|deliver\w*|expected|estimated|est\.|get it(?: by)?|arrive by|deliver(?:ed)? by)[ \t:]*([^\n]{0,40})/gi;
  for (const m of t.matchAll(near)) {
    const s = m[2];
    const md = MONTH.exec(s);
    if (md) {
      const d = new Date(Date.UTC(base.getUTCFullYear(), MONTHS[md[1].toLowerCase().slice(0, 3)], Number(md[2]), 12));
      // A date in January read in late December is next year's
      if (d.getTime() < base.getTime() - 60 * 86400e3) d.setUTCFullYear(d.getUTCFullYear() + 1);
      return iso(d);
    }
    const numeric = /^(?:[^\d\n]{0,12})\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
    if (numeric) {
      const y = numeric[3] ? (numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])) : base.getUTCFullYear();
      return iso(new Date(Date.UTC(y, Number(numeric[1]) - 1, Number(numeric[2]), 12)));
    }
    // Today, tomorrow or a weekday right after the words ("Arriving Thursday", "Delivery: tomorrow"), not later in the line
    const lead = s.slice(0, 16);
    if (/^\W*(by[ \t]+)?today\b/i.test(lead)) return iso(base);
    if (/^\W*(by[ \t]+)?tomorrow\b/i.test(lead)) return iso(new Date(base.getTime() + 86400e3));
    const wd = DAYS.findIndex((d) => new RegExp(`^\\W*(by[ \\t]+|on[ \\t]+)?${d}\\b`, 'i').test(lead));
    if (wd >= 0) {
      const ahead = (wd - base.getUTCDay() + 7) % 7 || 7;
      return iso(new Date(base.getTime() + ahead * 86400e3));
    }
  }
  return null;
}

const centsOf = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

// ─── The store's own markup ─────────────────────────────────────────

/** schema.org Order / ParcelDelivery in an email's ld+json → a partial read | null */
export function markupRead(html) {
  const blocks = [];
  for (const m of String(html || '').matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { blocks.push(JSON.parse(decodeEntities(m[1]).trim())); } catch { /* a broken block is skipped */ }
  }
  const nodes = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (x['@graph']) walk(x['@graph']);
    const t = [].concat(x['@type'] || []).join(' ');
    if (/\b(Order|ParcelDelivery)\b/.test(t)) nodes.push(x);
  };
  walk(blocks);
  if (!nodes.length) return null;
  const read = { orderNumber: null, items: [], tracking: [], expected: null, shipTo: null };
  const nameOf = (o) => (typeof o === 'string' ? o : o?.name) || '';
  for (const n of nodes) {
    const order = /\bParcelDelivery\b/.test([].concat(n['@type']).join(' ')) ? n.partOfOrder || {} : n;
    read.orderNumber ||= order.orderNumber ? String(order.orderNumber) : null;
    for (const it of [].concat(order.orderedItem || n.itemShipped || [])) {
      const product = it.orderedItem || it;
      const name = nameOf(product).trim();
      if (!name) continue;
      const sku = String(product.sku || product.productID || product.mpn || '') || null;
      // An email with both an Order and its ParcelDelivery names each item twice: once is enough
      if (read.items.some((x) => x.name === name && x.sku === sku)) continue;
      read.items.push({ name, sku, quantity: Number(it.orderQuantity || 1) || 1, cents: centsOf(it.price ?? it.offers?.price ?? product.offers?.price) });
    }
    if (n.trackingNumber) read.tracking.push({ carrier: nameOf(n.carrier || n.provider) || carrierOfNumber(n.trackingNumber), number: String(n.trackingNumber).toUpperCase() });
    const until = n.expectedArrivalUntil || n.expectedArrivalFrom;
    if (until && !read.expected) read.expected = String(until).slice(0, 10);
    const addr = n.deliveryAddress || order.deliveryAddress;
    if (addr && !read.shipTo) read.shipTo = OFFICE.test(JSON.stringify(addr)) ? 'office' : 'elsewhere';
  }
  return read;
}

// ─── Amazon's plain words ───────────────────────────────────────────

/** Amazon's emails (often through the orders@ group): "* Zinus 10 Inch … Quantity: 1 271.75 USD" → a partial read */
export function amazonRead(text) {
  const t = String(text || '').replace(/[ \t]+/g, ' ');
  const items = [];
  for (const m of t.matchAll(/\*\s+([^*\n][^*]*?)\s+Quantity:\s*(\d+)(?:\s+([\d,]+\.\d{2})\s*USD)?/g)) {
    const name = m[1].replace(/\s+/g, ' ').trim();
    if (name) items.push({ name, sku: null, quantity: Number(m[2]) || 1, cents: m[3] ? centsOf(m[3]) : null });
  }
  return { items, orderNumber: (/\bOrder #\s*(\d{3}-\d{7}-\d{7})/.exec(t) || [])[1] || null };
}

// ─── Putting it together ────────────────────────────────────────────

/**
 * One email → its read, from everything but the AI. `needsAi` says the items are still unknown
 * (an order, shipping or delivery email names what's in it; a refund or carrier notice may not)
 */
export function readOrderEmail({ subject = '', from = '', snippet = '', text = '', html = '', sentAt = Date.now() }) {
  const { store, carrier, domain } = storeOf(from);
  const kind = orderKind(subject, snippet);
  const links = linksOf(html);
  const words = [text, html ? htmlTextLite(html) : ''].filter(Boolean).join('\n');
  const markup = markupRead(html);
  const amazon = store === 'Amazon' ? amazonRead(words) : null;
  // A confirmation listing each thing as how many, its name, its SKU and its price (The Container Store's): read by rule,
  // so a long order needs no AI (the AI can't list 16 things in the time it has)
  const table = !markup?.items?.length && !amazon?.items?.length && kind === 'order' ? skuTable(text || (html ? htmlTextLite(html) : '')) : [];
  const items = markup?.items?.length ? markup.items : amazon?.items?.length ? amazon.items : table;
  const tracking = [...(markup?.tracking || [])];
  for (const tr of trackingIn(words, links)) if (!tracking.some((x) => x.number === tr.number)) tracking.push(tr);
  const read = {
    kind, store, carrier, domain,
    orderNumber: markup?.orderNumber || amazon?.orderNumber || orderNumberIn(words, subject),
    items, tracking,
    expected: markup?.expected || (['order', 'shipped', 'out', 'delayed'].includes(kind) ? expectedIn(words, sentAt) : null),
    shipTo: markup?.shipTo || shipToIn(words),
    jobPo: jobPoIn(words),
    productIds: productIdsIn(links, words),
    source: markup?.items?.length ? 'markup' : amazon?.items?.length ? 'amazon' : table.length ? 'table' : 'rules',
  };
  read.needsAi = !carrier && !read.items.length && ['order', 'shipped', 'out', 'delivered', 'pickup', 'cancelled', 'delayed'].includes(kind);
  return read;
}

/**
 * An order's things laid out a line each as: how many, its name, its SKU ("SKU#: 10079901", "Item #", "Model #"), then
 * its price ("$26.42", or FREE) → [{ name, sku, quantity, cents }]. Two or more such, or none: one alone could be a
 * coincidence of lines
 */
export function skuTable(text) {
  const lines = String(text || '').split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 3 < lines.length; i++) {
    const qty = /^(\d{1,3})$/.exec(lines[i]);
    const sku = /^(?:SKU|Item|Model|Article)\s*(?:#|No\.?|Number)?\s*:?\s*#?\s*([A-Z0-9-]{4,})$/i.exec(lines[i + 2]);
    const price = /^(?:\$\s?([\d,]+\.\d{2})|FREE)$/i.exec(lines[i + 3]);
    if (!qty || !sku || !price || !/[a-z]/i.test(lines[i + 1]) || lines[i + 1].length > 200) continue;
    out.push({ name: lines[i + 1], sku: sku[1], quantity: Number(qty[1]) || 1, cents: price[1] ? centsOf(price[1]) : null });
    i += 3;
  }
  return out.length >= 2 ? out : [];
}

/** The AI's items and anything else it read, under what the rules already had → the final read */
export function withAi(read, ai) {
  if (!ai) return read;
  const items = (ai.items || [])
    .map((i) => ({ name: String(i.name || '').trim(), sku: String(i.sku || '').trim() || null, quantity: Number(i.quantity) || 1, cents: centsOf(i.price) }))
    .filter((i) => i.name);
  const tracking = [...read.tracking];
  for (const n of ai.trackingNumbers || []) {
    const number = String(n || '').toUpperCase().replace(/\s+/g, '');
    if (carrierOfNumber(number) && !tracking.some((x) => x.number === number)) tracking.push({ carrier: carrierOfNumber(number), number });
  }
  return {
    ...read,
    items: read.items.length ? read.items : items,
    tracking,
    orderNumber: read.orderNumber || (String(ai.orderNumber || '').trim() || null),
    expected: read.expected || (/^\d{4}-\d{2}-\d{2}$/.test(ai.expected || '') ? ai.expected : null),
    shipTo: read.shipTo || (ai.shipTo === 'office' || ai.shipTo === 'elsewhere' ? ai.shipTo : null),
    jobPo: read.jobPo || (String(ai.jobPo || '').trim() || null),
    source: read.items.length ? read.source : items.length ? 'ai' : read.source,
    needsAi: false,
  };
}

/**
 * An image's alt text as words in its place: Wayfair and Best Buy name their items only on the product pictures
 * (seen in SOARD's mail, Nov 9 2026). Tracking pixels and logos have empty or one-word alts and add nothing
 */
export function withAltText(html) {
  return String(html || '').replace(/<img\b[^>]*?\balt\s*=\s*(["'])([^"']*)\1[^>]*>/gi, (m, q, alt) => (alt.trim().split(/\s+/).length > 1 ? ` ${alt.trim()} \n` : ' '));
}

/** HTML to words for the rules, keeping each cell's text apart (the AI gets ./_mailbox.js htmlText) */
function htmlTextLite(html) {
  return withAltText(html)
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n');
}

/** The AI's answer shape: Workers AI's JSON mode drops anything not required, so all of it is */
export const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['order', 'shipped', 'out', 'delivered', 'pickup', 'delayed', 'cancelled', 'refund', 'return', 'not_order'] },
    orderNumber: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, sku: { type: 'string' }, quantity: { type: 'number' }, price: { type: 'string' } },
        required: ['name', 'sku', 'quantity', 'price'],
      },
    },
    trackingNumbers: { type: 'array', items: { type: 'string' } },
    expected: { type: 'string' },
    shipTo: { type: 'string', enum: ['office', 'elsewhere', 'unknown'] },
    jobPo: { type: 'string' },
  },
  required: ['kind', 'orderNumber', 'items', 'trackingNumbers', 'expected', 'shipTo', 'jobPo'],
};

export const ORDER_PROMPT = [
  'You read one email a store sent about an order. Answer in JSON only.',
  'kind: order (confirmation), shipped, out (out for delivery), delivered, pickup (ready for pickup), delayed, cancelled, refund, return, or not_order (an ad, a review request, anything else).',
  'items: every product the email names as in this order or this package: its name as written, the store\'s SKU or model number if shown (else ""), quantity, and its price as written (else "").',
  'trackingNumbers: carrier tracking numbers written in the email (not order numbers or phone numbers).',
  'expected: the expected delivery day as YYYY-MM-DD, else "". The email was sent on the date given.',
  'shipTo: office if it is going to Hembree Park or "Sunshine - Roswell", elsewhere if another address is shown, else unknown.',
  'jobPo: what is written in a Job, PO or purchase order field, else "".',
  'Never guess: leave a field "" (or the list empty) when the email doesn\'t say.',
].join('\n');
