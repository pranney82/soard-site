/**
 * Kid items: which kid and which selection line each order belongs to
 * ===========================================================================
 * Pure functions, no I/O. The order reads come from ./_order-sweep.js, the
 * selection parts from ./_selection-parts.js; tests/kid-match.test.mjs drives
 * this directly, and scripts/kid-match-check.mjs runs it on a read-only copy
 * of the live data for the matching test (nothing is written anywhere).
 *
 * Which kid, first answer wins, any disagreement means a person looks:
 *   1. The PO / Job box: a kid's first or last name that fits exactly one open
 *      makeover and no staff member ("COLIN", "#DYLAN"), alone or first ("#Dylan
 *      replacement door"). OFFICE, SOARD, SUNNY & RANNEY, S&R and STORE say it
 *      isn't a kid's: nothing happens. Any other word ("LIZZY", "#Home") needs a look.
 *   2. No PO name: the items matching parts on exactly one open makeover.
 *   3. Anything else needs a look.
 * Which line: each item against that kid's chosen lines, by the part's model
 * number, then the designer's own words (brand and product). Template lines
 * (the same generic words on several makeovers, with no link or model) are
 * never matched by themselves. An item that fits none of the kid's lines is "Also bought" for that kid when the
 * PO named them (Peter, Nov 9 2026: "ok do that then"), and needs a look when only its items said who it's for.
 */

// Said in the PO box when an order isn't a kid's (Peter's list, Nov 9 2026)
const NOT_A_KID = /^(office|the office|soard|sunny\s*(and|&)?\s*ranney|s\s*&\s*r|s\s*and\s*r|store|the store)$/i;
const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'set', 'pack', 'pcs', 'piece', 'pieces', 'inch', 'inches', 'size', 'color', 'colour',
  'standard', 'new', 'one', 'two', 'three', 'qty', 'each', 'item', 'items', 'black', 'white', 'finish', 'only', 'without', 'model', 'sku',
  'brand', 'quantity', 'large', 'small', 'medium', 'soft', 'modern', 'style', 'kids', 'kid', 'home', 'room', 'bathroom', 'bedroom']);

const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&');
/** A thing's significant words: "Delta 7-Setting Slide Bar Hand Shower" → ['delta', '7setting', 'slide', 'bar', 'hand', 'shower'] */
export function tokensOf(text) {
  return [...new Set(norm(text).replace(/https?:\/\/\S+/g, ' ').replace(/(\d)["”]/g, '$1in').split(/[^a-z0-9-]+/)
    .map((w) => w.replace(/-/g, '')).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w)))];
}
const compact = (s) => norm(s).replace(/[^a-z0-9]/g, '');

/**
 * How alike two names of a thing are, 0 to 1: the words they share, of the shorter's ("Duvet Cover" in "Duvet Cover -
 * Oat / Queen"), or of both; one name's model number in the other is 1. Under 0.6, not the same thing
 */
export function nameScore(a, b) {
  const x = new Set(tokensOf(a)), y = new Set(tokensOf(b));
  if (!x.size || !y.size) { const p = String(a || '').toLowerCase().trim(); return p && p === String(b || '').toLowerCase().trim() ? 1 : 0; }
  const shared = [...x].filter((w) => y.has(w)).length;
  const small = Math.min(x.size, y.size);
  return Math.max(shared / (x.size + y.size - shared), small >= 2 ? shared / small * 0.95 : 0);
}
// Every word of a name, sizes, colors and numbers too ("Large", "White", "3G"): what tells two alike things apart
const allWords = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const wordsAlike = (a, b) => { const x = allWords(a), y = allWords(b); const shared = [...x].filter((w) => y.has(w)).length; return x.size + y.size ? shared / (x.size + y.size - shared) : 0; };
/**
 * Which of an order's things some emails name → Set of the things' names. Each name goes to its one likeliest thing: the
 * same words exactly; else the most alike (by their words, then by every word: "Large Woven Basket" is the Large one).
 * Two things alike to the end ("JASPER 1G" and "JASPER 3G" read the same way): neither, and both are in .tied, so
 * a person is asked about them
 */
export function namedIn(items, names) {
  const out = new Set();
  // The things a name fits as well as each other (out.tied): neither is named, and whoever reads this asks about both
  out.tied = new Set();
  const same = (a, b) => String(a || '').toLowerCase().replace(/\s+/g, ' ').trim() === String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const n of names || []) {
    const exact = items.filter((it) => same(n, it.name));
    if (exact.length === 1) { out.add(exact[0].name); continue; }
    const scored = items.map((it) => ({ it, a: nameScore(n, it.name), b: wordsAlike(n, it.name) })).filter((x) => x.a >= 0.6)
      .sort((x, y) => y.a - x.a || y.b - x.b);
    if (!scored.length) continue;
    const [top, next] = scored;
    if (next && Math.abs(next.a - top.a) < 1e-9 && Math.abs(next.b - top.b) < 1e-9) {
      for (const x of scored) if (Math.abs(x.a - top.a) < 1e-9 && Math.abs(x.b - top.b) < 1e-9) out.tied.add(x.it.name);
      continue;
    }
    out.add(top.it.name);
  }
  return out;
}

/** A kid's names from the job: "Lizzie Francis (2026)" → { first: 'lizzie', last: 'francis' }; a school or practice has none */
export function namesOf(jobName) {
  const words = String(jobName || '').replace(/\(\d{4}\)/, '').trim().split(/\s+/);
  if (words.length < 2 || /\b(school|health|center|centre|academy|church|foundation|inc|llc|clinic)\b/i.test(jobName)) return null;
  return { first: words[0].toLowerCase(), last: words[words.length - 1].toLowerCase() };
}

/**
 * The PO box → { kid: jobId } | { notKid: true } | { unclear: 'what was typed' } | null (nothing typed)
 * jobs: [{ id, name }], staff: first and last names of SOARD's staff (lower case)
 */
export function kidFromPo(po, jobs, staff = new Set()) {
  const typed = String(po || '').replace(/[#*"'.,:]/g, ' ').replace(/\b(po|p\.o|job|for)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!typed) return null;
  if (NOT_A_KID.test(typed)) return { notKid: true };
  const words = typed.toLowerCase().split(' ');
  const hits = new Set();
  for (const j of jobs) {
    const n = namesOf(j.name);
    if (!n) continue;
    for (const w of words) {
      if ((w === n.first && !staff.has(n.first)) || (w === n.last && !staff.has(n.last))) hits.add(j.id);
    }
  }
  // The name (or names) of one kid and nothing else, or one kid's name first and then what it's for ("#Dylan replacement
  // for broken door", seen Nov 9 2026): that kid. A name further in, or two kids' names: a person looks
  if (hits.size === 1) {
    const id = [...hits][0];
    const n = namesOf(jobs.find((j) => j.id === id).name);
    if (words.every((w) => w === n.first || w === n.last) || words[0] === n.first) return { kid: id };
  }
  return { unclear: String(po).trim() };
}

/** Template lines: the same generic words on two or more makeovers, and no link or model number in any of its parts */
export function templateLines(lines) {
  const byWords = new Map();
  for (const l of lines) if (l.wordsKey) byWords.set(l.wordsKey, new Set([...(byWords.get(l.wordsKey) || []), l.jobId]));
  return new Set(lines.filter((l) => l.wordsKey && byWords.get(l.wordsKey).size >= 2 && !(l.parts || []).some((p) => p.link || (p.model && p.model.length >= 4))).map((l) => `${l.jobId}|${l.itemId}`));
}

/**
 * How well an ordered item fits a part on a line → { score, how }:
 *   10  the part's model number is in the item's name or SKU
 *   2-6 the designer's words: shared significant words (at least 2, and most of the item's)
 *   0   no fit
 */
export function fit(item, part, lineWords) {
  const itemText = `${item.name} ${item.sku || ''}`;
  const model = compact(part.model);
  if (model.length >= 4 && compact(itemText).includes(model)) return { score: 10, how: 'model' };
  const it = tokensOf(item.name);
  if (!it.length) return { score: 0, how: null };
  const partWords = new Set([...tokensOf(`${part.brand || ''} ${part.name}`), ...tokensOf(lineWords)]);
  const shared = it.filter((w) => partWords.has(w));
  const share = shared.length / it.length;
  if (shared.length >= 3 && share >= 0.5) return { score: 4 + Math.min(2, shared.length - 3), how: `words: ${shared.join(' ')}` };
  if (shared.length >= 2 && share >= 0.4) return { score: 2, how: `words: ${shared.join(' ')}` };
  return { score: 0, how: null };
}
/**
 * When the PO already says whose it is, only the line is in question, and a store's long title ("Emberela HEXlights
 * Sensory Lights for Kids Room, Smart Hexagon…") shares too small a part of its words with the designer's to fit
 * above. Then: two of the part's own significant words, or three of the line's, decide the line
 */
export function looseFit(item, part, lineWords) {
  const it = new Set(tokensOf(item.name));
  if (!it.size) return 0;
  const own = tokensOf(`${part.brand || ''} ${part.name}`).filter((w) => it.has(w)).length;
  const line = tokensOf(lineWords).filter((w) => it.has(w)).length;
  return own >= 2 ? 1 + own : line >= 3 ? line / 2 : 0;
}
const STRONG = 4;
// Enough to say an item is plainly another kid's: its model number, or five of the designer's words
const PLAIN = 6;

/** Each item's best line on each kid → [{ jobId, itemId, line, part, score, how }], best first */
function candidates(item, lines, templates) {
  const out = [];
  for (const l of lines) {
    if (templates.has(`${l.jobId}|${l.itemId}`)) continue;
    let best = null;
    for (const p of l.parts || []) {
      const f = fit(item, p, l.words);
      if (f.score && (!best || f.score > best.score)) best = { jobId: l.jobId, itemId: l.itemId, line: l.lineName, part: p.name, score: f.score, how: f.how };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Which order an email belongs to: store + order number; with none, the PO and the first item; else the email alone */
export const groupKey = (r) => (r.read.orderNumber ? `${r.store}|${r.read.orderNumber}` : r.read.jobPo && r.read.items?.[0] ? `${r.store}|po:${r.read.jobPo}|${r.read.items[0].name}` : `${r.store}|email:${r.id}`);

const lower = (x) => String(x || '').toLowerCase().trim();
// A carrier's own email ("Your FedEx package is on its way") is about a store's order, never an order of its own
const CARRIER = /^(fedex( freight| ground)?|ups|usps|dhl|ontrac|lasership|ltl select|amazon logistics|veho|uniuni|ups freight)$/i;
export const isCarrier = (store) => CARRIER.test(String(store || '').trim());
const orderNo = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const storeNo = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const trackNo = (t) => String(t?.number || t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * One key for each order, whichever of its emails is read: emails are about one order when they share the store and
 * its number ("#8MK7RPPS5F" and "8MK7RPPS5F" alike), or a tracking number (a carrier's own email included), or, a
 * shipping or delivered email with no number of its own, the one order of that store before it that names a thing it
 * names. Two numbered orders are never one (Amazon sends two orders in one box), an order email is never taken into
 * another (a PO-only order is an order), and a thing two orders name joins neither (the same garland for two kids).
 * The key is the one the order always had: its store's email with an order number. settled(key, emails): something is
 * kept by that key already (a person's answer, a budget line). One of an order's emails with its own settled key keeps
 * it, and the order is called by it; two or more stay apart as they were, so nothing answered or made moves.
 * reads: every kind (orders, shipping, cancellations) → (read) → its order's key; .storeOf, .numberOf: the order's store
 * and number as its store's own email says them
 */
export function orderKeys(reads, { settled = null, alone = null } = {}) {
  const id = (r) => `${r.mailbox}|${r.id}`;
  const parent = new Map(reads.map((r) => [id(r), id(r)]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const numbered = (r) => orderNo(r.read.orderNumber).length >= 4 && !CARRIER.test(String(r.store || '').trim());
  const numberOf = (r) => `${storeNo(r.store)}|${orderNo(r.read.orderNumber)}`;
  // Each order's own numbers: a tracking number or a thing's name never makes two numbered orders one
  const nums = new Map(reads.map((r) => [id(r), new Set(numbered(r) ? [numberOf(r)] : [])]));
  const join = (a, b, loose = false) => {
    const x = find(a), y = find(b);
    if (x === y) return;
    const nx = nums.get(x), ny = nums.get(y);
    if (loose && nx.size && ny.size && ![...ny].some((n) => nx.has(n))) return;
    parent.set(y, x);
    for (const n of ny) nx.add(n);
  };
  const firstBy = new Map();
  const link = (k, r, loose) => { if (firstBy.has(k)) join(firstBy.get(k), id(r), loose); else firstBy.set(k, id(r)); };
  for (const r of reads) if (numbered(r)) link(`n|${numberOf(r)}`, r, false);
  for (const r of reads) for (const t of r.read.tracking || []) { const c = trackNo(t); if (c.length >= 8) link(`t|${c}`, r, true); }
  // A shipping or delivered email still with no number (Faire's carry none): the one numbered order of that store, from
  // before it, that names a thing it names (and no other PO). Two or more: it's about one of them, and which is for a
  // person (the box's scan offers those orders); it's no order of its own
  const HOUR = 3600e3;
  const maybe = new Map();
  for (const r of reads) {
    if (r.read.kind === 'order' || nums.get(find(id(r))).size) continue;
    const names = new Set((r.read.items || []).map((i) => lower(i.name)).filter(Boolean));
    if (!names.size) continue;
    const fits = reads.filter((x) => x.read.kind === 'order' && numbered(x) && storeNo(x.store) === storeNo(r.store)
      && Date.parse(x.at) <= Date.parse(r.at) + HOUR && !(r.read.jobPo && x.read.jobPo && lower(r.read.jobPo) !== lower(x.read.jobPo))
      && (x.read.items || []).some((i) => names.has(lower(i.name))));
    const orders = new Set(fits.map((x) => numberOf(x)));
    if (orders.size === 1) join(id(fits[0]), id(r), true);
    else if (orders.size > 1) maybe.set(id(r), fits);
  }
  // About one of several orders: the whole of what it was joined to (a carrier's email with its tracking number too),
  // while none of it has a number of its own
  const maybeOf = new Map();
  for (const [x, fits] of maybe) { const root = find(x); if (!nums.get(root).size) maybeOf.set(root, [...(maybeOf.get(root) || []), ...fits]); }
  // Each order's emails, and the one that names it: its store's email with an order number (the oldest)
  const rank = (x) => (CARRIER.test(String(x.store || '').trim()) ? 2 : 0) + (numbered(x) ? 0 : 1);
  const best = (list) => list.reduce((b, r) => (!b || rank(r) < rank(b) || (rank(r) === rank(b) && String(r.at) < String(b.at)) ? r : b), null);
  const members = new Map();
  for (const r of reads) members.set(find(id(r)), [...(members.get(find(id(r))) || []), r]);
  const keys = new Map(), names = new Map();
  for (const list of members.values()) {
    const byOwn = new Map();
    for (const r of list) byOwn.set(groupKey(r), [...(byOwn.get(groupKey(r)) || []), r]);
    const repKey = groupKey(best(list));
    const kept = settled && byOwn.size > 1 ? [...byOwn].filter(([k, rs]) => settled(k, rs)).map(([k]) => k) : [];
    // Something kept by one of its keys: an email the matcher places on a kid by itself stays its own too, as it was
    // (a person answered the others knowing it was there: "Not a kid's" to a duplicate of it)
    if (kept.length && alone) for (const [k, rs] of byOwn) if (!kept.includes(k) && alone(k, rs)) kept.push(k);
    // The rest of the order goes with the key it's called by: its own, or the one answer kept it by
    const home = kept.length === 0 ? repKey : kept.includes(repKey) ? repKey : kept.sort((a, b) => rank(best(byOwn.get(a))) - rank(best(byOwn.get(b))))[0];
    const parts = new Map([[home, []]]);
    for (const [k, rs] of byOwn) (kept.includes(k) && k !== home ? parts.set(k, rs) : parts.get(home).push(...rs));
    for (const [k, rs] of parts) {
      const shown = best(rs);
      for (const r of rs) { keys.set(id(r), k); names.set(id(r), shown); }
    }
  }
  const keyOf = (r) => keys.get(id(r)) || groupKey(r);
  // An email about one of several orders (and joined to nothing since): their keys, else null
  keyOf.maybe = (r) => {
    const fits = maybeOf.get(find(id(r)));
    return fits ? [...new Set(fits.map((x) => keys.get(id(x))))] : null;
  };
  keyOf.storeOf = (r) => names.get(id(r))?.store || r.store;
  keyOf.numberOf = (r) => (names.has(id(r)) ? names.get(id(r)).read.orderNumber || null : r.read.orderNumber || null);
  return keyOf;
}

/**
 * The emails about one order, together (keyOf: orderKeys over every email read, so an order's emails are one order).
 * What was ordered: as the emails the order is called by name it (the answers about it were given for those names),
 * else its order email's, else its shipping and delivered emails'
 */
export function orderGroups(reads, keyOf = null) {
  const groups = new Map();
  const of = keyOf || orderKeys(reads);
  const add = (list, it) => { if (!list.some((x) => x.name === it.name)) list.push(it); };
  for (const r of reads) {
    const key = of(r);
    const g = groups.get(key) || { key, store: of.storeOf ? of.storeOf(r) : r.store, orderNumber: of.numberOf ? of.numberOf(r) : r.read.orderNumber || null, po: null, at: r.at, lastAt: r.at, kinds: [], items: [], ownOrder: [], ownLater: [], later: [], buyer: r.mailbox };
    g.kinds.push(r.read.kind);
    g.po ||= r.read.jobPo || null;
    if (r.at < g.at) g.at = r.at;
    if (r.at > g.lastAt) g.lastAt = r.at;
    // The buyer is whoever got the store's own email (a carrier's might have gone to anyone)
    if (!CARRIER.test(String(r.store || '').trim()) && r.read.kind === 'order') g.buyer = r.mailbox;
    // A shipping or delivered email names the same things its own way ("Raincan Showerhead…"): counted again they'd
    // be things nobody ordered, so one list is the order's
    const own = groupKey(r) === key;
    for (const it of r.read.items || []) add(r.read.kind === 'order' ? (own ? g.ownOrder : g.items) : (own ? g.ownLater : g.later), it);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.items = [g.ownOrder, g.ownLater, g.items, g.later].find((l) => l.length) || [];
    delete g.ownOrder; delete g.ownLater; delete g.later;
  }
  return [...groups.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * One order → { decision: 'placed' | 'not-kid' | 'look' | 'skip', kid, how, items: [{ name, line, part, score, how } | { name, look }], why }
 * jobs: [{ id, name }], lines: [{ jobId, itemId, lineName, words, wordsKey, parts }], staff: Set of lower-case names
 */
export function matchOrder(order, { jobs, lines, staff = new Set(), templates = templateLines(lines), kid = null }) {
  if (!order.items.length) return { decision: 'skip', why: 'no items read' };
  // A person said whose the whole order is: as a PO with the kid's name
  const po = kid ? { kid, said: true } : kidFromPo(order.po, jobs, staff);
  if (po?.notKid) return { decision: 'not-kid', why: `PO "${order.po}"` };
  const per = order.items.map((it) => ({ it, c: candidates(it, lines, templates) }));
  const jobName = (id) => String(jobs.find((j) => j.id === id)?.name || id).replace(/\s*\(\d{4}\)\s*$/, '');
  if (po?.kid) {
    const items = per.map(({ it, c }) => {
      const mine = c.filter((x) => x.jobId === po.kid);
      const other = c.find((x) => x.jobId !== po.kid && x.score >= PLAIN);
      if (mine[0]?.score >= 2 && !(other && other.score > mine[0].score)) return { name: it.name, itemId: mine[0].itemId, line: mine[0].line, part: mine[0].part, score: mine[0].score, how: mine[0].how };
      if (other) return { name: it.name, look: `the PO says ${jobName(po.kid)}, but it looks like ${jobName(other.jobId)}'s ${other.line}` };
      // Nothing fits closely: the kid's line whose words the title shares most, else bought on top of the selections
      let loose = null;
      for (const l of lines.filter((x) => x.jobId === po.kid && !templates.has(`${x.jobId}|${x.itemId}`))) {
        for (const p of l.parts || []) {
          const score = looseFit(it, p, l.words);
          if (score && (!loose || score > loose.score)) loose = { itemId: l.itemId, line: l.lineName, part: p.name, score };
        }
      }
      if (loose) return { name: it.name, itemId: loose.itemId, line: loose.line, part: loose.part, score: 2, how: 'title words' };
      return { name: it.name, alsoBought: true };
    });
    return { decision: items.some((i) => i.look) ? 'look' : 'placed', kid: po.kid, how: po.said ? 'a person said whose' : `PO "${order.po}"`, items };
  }
  // No PO name: the items say which kid, when they all point at one and nothing else comes close
  const strong = per.map(({ it, c }) => ({ it, best: c[0], next: c.find((x) => x.jobId !== c[0]?.jobId) }));
  const kids = new Set(strong.filter((s) => s.best?.score >= STRONG).map((s) => s.best.jobId));
  if (kids.size === 1) {
    const kid = [...kids][0];
    const items = strong.map(({ it, best, next }) => {
      if (best?.jobId === kid && best.score >= 2 && !(next && next.score >= best.score)) return { name: it.name, itemId: best.itemId, line: best.line, part: best.part, score: best.score, how: best.how };
      return { name: it.name, look: best ? `fits ${jobName(best.jobId)}'s ${best.line} and ${next ? `${jobName(next.jobId)}'s ${next.line}` : 'nothing else'} as well` : `which of ${jobName(kid)}'s lines?` };
    });
    return { decision: items.some((i) => i.look) ? 'look' : 'placed', kid, how: 'its items', items, ...(po?.unclear ? { why: `PO "${po.unclear}" isn't a kid's name` } : {}) };
  }
  if (kids.size > 1) return { decision: 'look', why: `its items fit ${[...kids].map(jobName).join(' and ')}`, items: order.items.map((it) => ({ name: it.name, look: 'which kid?' })) };
  if (po?.unclear) return { decision: 'look', why: `PO "${po.unclear}" isn't a kid's name`, items: order.items.map((it) => ({ name: it.name, look: 'which kid?' })) };
  return { decision: 'unplaced', why: 'no PO, and nothing fits a selection', items: order.items.map((it) => ({ name: it.name })) };
}
