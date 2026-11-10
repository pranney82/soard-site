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
 *      makeover and no staff member ("COLIN", "#DYLAN"). OFFICE, SOARD, SUNNY &
 *      RANNEY, S&R and STORE say it isn't a kid's: nothing happens. Any other
 *      word ("LIZZY", "Dylan bed", "#Home") needs a look.
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
  // Exactly the name (or names) of one kid and nothing else typed: that kid. "Dylan bed" or a second word: a person looks
  if (hits.size === 1) {
    const id = [...hits][0];
    const n = namesOf(jobs.find((j) => j.id === id).name);
    if (words.every((w) => w === n.first || w === n.last)) return { kid: id };
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

/** The emails about one order, together */
export function orderGroups(reads) {
  const groups = new Map();
  for (const r of reads) {
    const key = groupKey(r);
    const g = groups.get(key) || { key, store: r.store, orderNumber: r.read.orderNumber || null, po: null, at: r.at, kinds: [], items: [], buyer: r.mailbox };
    g.kinds.push(r.read.kind);
    g.po ||= r.read.jobPo || null;
    if (r.at < g.at) g.at = r.at;
    for (const it of r.read.items || []) if (!g.items.some((x) => x.name === it.name)) g.items.push(it);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * One order → { decision: 'placed' | 'not-kid' | 'look' | 'skip', kid, how, items: [{ name, line, part, score, how } | { name, look }], why }
 * jobs: [{ id, name }], lines: [{ jobId, itemId, lineName, words, wordsKey, parts }], staff: Set of lower-case names
 */
export function matchOrder(order, { jobs, lines, staff = new Set(), templates = templateLines(lines) }) {
  if (!order.items.length) return { decision: 'skip', why: 'no items read' };
  const po = kidFromPo(order.po, jobs, staff);
  if (po?.notKid) return { decision: 'not-kid', why: `PO "${order.po}"` };
  const per = order.items.map((it) => ({ it, c: candidates(it, lines, templates) }));
  const jobName = (id) => String(jobs.find((j) => j.id === id)?.name || id).replace(/\s*\(\d{4}\)\s*$/, '');
  if (po?.kid) {
    const items = per.map(({ it, c }) => {
      const mine = c.filter((x) => x.jobId === po.kid);
      const other = c.find((x) => x.jobId !== po.kid && x.score >= PLAIN);
      if (mine[0]?.score >= 2 && !(other && other.score > mine[0].score)) return { name: it.name, itemId: mine[0].itemId, line: mine[0].line, part: mine[0].part, score: mine[0].score, how: mine[0].how };
      if (other) return { name: it.name, look: `the PO says ${jobName(po.kid)}, but it looks like ${jobName(other.jobId)}'s ${other.line}` };
      // The PO says whose it is and nothing on their lines fits: bought for them on top of the selections
      return { name: it.name, alsoBought: true };
    });
    return { decision: items.some((i) => i.look) ? 'look' : 'placed', kid: po.kid, how: `PO "${order.po}"`, items };
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
