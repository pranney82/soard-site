/**
 * Kid items: what Clareece's check-in page shows (/admin/checkin/), and what JobTread is told
 * ===========================================================================
 * Each open makeover's parts to receive (from ./_selection-parts.js), each
 * marked ordered when a store's order email was matched to it (./_order-sweep.js
 * read, ./_kid-match.js matched), plus what was bought for the kid on top of the
 * selections ("Also bought"), plus the orders a person needs to look at. Then
 * the site's own record (./_kid-record.js) on top: what a person decided about
 * an order, what was checked in, how many, and on which shelf. The JobTread
 * writer (./_kid-jt.js) writes each line from this same view, so the page and
 * JobTread always say the same thing.
 */

import { matchOrder, orderGroups, orderKeys, groupKey, templateLines, namesOf, fit, tokensOf } from './_kid-match.js';
import { loadCostRecords } from './_makeover-costs.js';
import { matchProject } from './_reveals.js';
import { readRecord, readState, decisionKey, alsoKey, shelfName, SHELVES, FLOOR, outState, WHOLE_ORDER } from './_kid-record.js';

const ORDER_KINDS = new Set(['order', 'shipped', 'out', 'delivered', 'pickup']);
// An order nobody's placed shows (asking whose it is) this long after it was ordered
const UNPLACED_DAYS = 30;
const UNDO_KINDS = new Set(['cancelled', 'refund', 'return']);
// Where a shipment is: the order kinds, and a delay email (its new expected day, never a sign it shipped)
const SHIP_KINDS = new Set([...ORDER_KINDS, 'delayed']);
// Every email about an order, to tell which emails are one order
const ALL_KINDS = new Set([...SHIP_KINDS, ...UNDO_KINDS]);

// strict: the JobTread writer's view, where a failed read must stop the run, never look like an empty list
async function rows(DB, sql, strict = false) {
  try { return (await DB.prepare(sql).all()).results || []; } catch (err) { if (strict) throw err; return []; }
}
const parse = (s, fallback) => { try { return JSON.parse(s || ''); } catch { return fallback; } };
const lower = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** "Lizzie Francis (2026)" → "Lizzie F."; a school or practice keeps its name */
export function shortName(jobName) {
  const n = namesOf(jobName);
  const words = String(jobName || '').replace(/\s*\(\d{4}\)\s*$/, '').split(/\s+/);
  return n ? `${words[0]} ${words[words.length - 1][0]}.` : words.join(' ');
}

/**
 * A kid page's photo, small and square for the page (Cloudflare Images resizes it; the face-heavy middle is kept):
 * "https://imagedelivery.net/<account>/<id>/public" → "/cdn-cgi/imagedelivery/<account>/<id>/w=160,h=160,fit=cover,gravity=auto"
 */
export function avatarOf(url) {
  const m = /^(?:https:\/\/imagedelivery\.net|\/cdn-cgi\/imagedelivery)\/([\w-]+)\/(.+)\/[^/]+$/.exec(String(url || ''));
  return m ? `/cdn-cgi/imagedelivery/${m[1]}/${m[2]}/w=160,h=160,fit=cover,gravity=auto` : null;
}

/** "$1,299.00" → 129900; nothing readable → null */
export function priceCents(s) {
  const m = /(\d[\d,]*)(\.\d{1,2})?/.exec(String(s ?? ''));
  if (!m) return null;
  const n = Number(`${m[1].replace(/,/g, '')}${m[2] || ''}`);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** The store order emails read so far, for matching: [{ mailbox, id, store, at, read }] */
export async function orderReads(DB, kinds = ORDER_KINDS, strict = false) {
  return (await rows(DB, "SELECT mailbox, id, store, at, read FROM order_mail WHERE state = 'read'", strict))
    .map((r) => ({ ...r, read: parse(r.read, {}) })).filter((r) => kinds.has(r.read.kind));
}

/** Where an item stands from its receipts: not · ordered · partly · here · house (it went to the house) */
/**
 * Where an item stands from its receipts: not · ordered · partly · here · out (all that came went to the house at
 * load-out) · house (it went straight to the house). got: how many came; sent: how many went out to the house
 */
function settle(it, whoOf = () => null) {
  const live = it.receipts.filter((r) => !r.undoneAt);
  // What's out, by the boxes (./_kid-record.js outState: the same rule the server frees shelves by)
  const ins = live.filter((r) => r.kind === 'receive');
  const st = outState(ins, live.filter((r) => r.kind === 'out'));
  it.got = st.got;
  it.sent = st.sent;
  it.boxesLeft = st.boxesLeft;
  // Check-ins every box of which went out (for the server only: never sent to the page)
  Object.defineProperty(it, 'allOutIds', { value: new Set(ins.filter((r) => st.per.get(r.id)?.full).map((r) => r.id)), enumerable: false, configurable: true, writable: true });
  // Where it is: the shelves of its check-ins with a box still at the Office, newest first (one that went out isn't
  // where the rest is); all of it out, the last shelf it was on
  it.shelves = [...new Set(ins.filter((r) => r.shelf && !st.per.get(r.id)?.full).reverse().map((r) => r.shelf))];
  it.shelf = it.shelves[0] || [...ins].reverse().find((r) => r.shelf)?.shelf || null;
  // "Not coming here" is the rest of it: what came is at the Office (and loaded from there) like anything else
  it.house = live.some((r) => r.kind === 'house');
  if (it.house && !it.got) it.status = 'house';
  else if (st.allOut && (it.got >= it.qty || it.house)) it.status = 'out';
  else if (it.got >= it.qty || it.house) it.status = 'here';
  else if (it.got > 0) it.status = 'partly';
  else it.status = it.order ? 'ordered' : 'not';
  it.receipts = it.receipts.map(({ id, kind, units, boxes, shelf, at, undoneAt, by, ref, box }) => ({ id, kind, units, boxes, shelf, at, who: whoOf(by), ...(ref ? { ref } : {}), ...(box ? { box } : {}), undone: Boolean(undoneAt) }));
  return it;
}
const OPEN = new Set(['not', 'ordered']);

/**
 * → { practice, since, kids: [{ jobId, name, short, shelves, photo, others, allowances, items }], needsLook, orders, shelves }
 * Each item: { id, itemId, partKey, name, line, qty, source, status, got, shelf, order, orderedAs, before, receipts, also?, allowance? }
 */
export async function checkinView(env, opts = {}) {
  return (await checkinData(env, opts)).view;
}

/**
 * The view, with the emails it was made from and which order each is (the scan matches a label to them the same way)
 * → { view, reads, keyOf, nameOf: (mailbox) → who ordered, by first name }
 */
export async function checkinData(env, { photos = true, strict = false } = {}) {
  const DB = env.DB;
  const record = await readRecord(DB);
  // Lines the site made itself (Also bought) were read as selections before the reader knew them: never parts
  const made = new Set(record.also.map((a) => a.costItemId).filter(Boolean));
  const partRows = (await rows(DB, 'SELECT job_id, item_id, job_name, group_name, line_name, cents, parts, words, words_key, read_by FROM kid_parts ORDER BY job_name, group_name, line_name', strict))
    .filter((r) => !made.has(r.item_id));
  const lines = partRows.map((r) => ({ jobId: r.job_id, itemId: r.item_id, jobName: r.job_name, groupName: r.group_name || '', cents: r.cents ?? null, lineName: r.line_name, words: r.words || '', wordsKey: r.words_key || '', parts: parse(r.parts, []).map((p) => (r.read_by === 'whole' ? { ...p, whole: true } : p)) }));
  const jobs = [...new Map(lines.map((l) => [l.jobId, { id: l.jobId, name: l.jobName }])).values()];
  // Kids with selection lines the reader couldn't split yet: their orders may belong on those lines
  const unread = [...new Set(partRows.filter((r) => String(r.read_by || '').startsWith('none')).map((r) => r.job_id))];
  const dir = parse((await rows(DB, "SELECT data FROM staff_state WHERE key = 'directory'", strict))[0]?.data, {});
  const staff = new Set((dir.accounts || []).flatMap((a) => String(a.name || '').toLowerCase().split(/\s+/)).filter((w) => w.length > 1));
  // Who ordered, by first name: "Clareece", not her mailbox
  const firstOf = new Map((dir.accounts || []).map((a) => [String(a.email || '').toLowerCase(), String(a.name || '').split(/\s+/)[0]]));
  const templates = templateLines(lines);
  // An allowance seen once stays the kid's (its words alike on another open makeover made it one): it isn't matched to
  // orders as a selection, whoever else's budget changes
  const allowanceAt = (l) => /allowance/i.test(l.groupName) && (templates.has(`${l.jobId}|${l.itemId}`) || record.allowLines.has(`${l.jobId}|${l.itemId}`));
  for (const l of lines) if (allowanceAt(l)) templates.add(`${l.jobId}|${l.itemId}`);
  const live = await readState(DB, 'live');
  // Each makeover's Project Manager (the selection reader keeps it): they load out, so the page opens on Check out for them
  const jobState = new Map((parse((await rows(DB, "SELECT data FROM kid_parts_state WHERE key = 'state'"))[0]?.data, {}).jobs || []).map((j) => [j.id, j]));
  const pmOf = new Map([...jobState].map(([id, j]) => [id, j.pm || null]));
  const since = live.since || null;

  // Each kid's own page, for their photo (the same match the board's costs use: pinned job, else name and year)
  const pages = photos ? await loadCostRecords(DB).catch(() => []) : [];
  const kids = jobs.map((j) => {
    const page = photos ? matchProject(j.name, pages, j.id) : null;
    const shelves = SHELVES.filter((s) => record.shelves.get(s) === j.id);
    return { jobId: j.id, name: j.name, short: shortName(j.name), pm: pmOf.get(j.id) || null, stage: jobState.get(j.id)?.status || null, shelves, shelf: shelves[0] ? shelfName(shelves[0]) : null, photo: avatarOf(page?.photo), others: 0, allowances: [], items: [] };
  });
  const kidOf = new Map(kids.map((k) => [k.jobId, k]));
  const lineOf = new Map(lines.map((l) => [`${l.jobId}|${l.itemId}`, l]));
  for (const l of lines) {
    const kid = kidOf.get(l.jobId);
    // An allowance: a sum set aside for a kind of thing, in a Selection & Allowance group. Every line there is one
    // ("Decor/Accessories" $2,000, "Furniture", "Bedding"): what the designer picked for it is in its words, and
    // something bought on top of those for that kind of thing goes next to it, the line down by it (Peter, Nov 11 2026:
    // the Container Store's drawers "were not in JT yet since only an allowance was in"). A labor line that's alike on
    // every makeover ("Plumbing Final") is in no such group, and never one
    if (/allowance/i.test(l.groupName)) kid.allowances.push({ itemId: l.itemId, line: l.lineName, words: l.words.slice(0, 120), cents: l.cents });
    if (templates.has(`${l.jobId}|${l.itemId}`)) continue;
    const seen = new Map();
    l.parts.forEach((p) => {
      // The part's own key (model, link or name) keeps its record when the designer edits the line; two alike are told apart
      const base = p.key || `name:${lower(p.name)}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const partKey = n > 1 ? `${base}#${n}` : base;
      if (p.source === 'buy' || p.source === 'donated') {
        // "Lighting: Wayfair Louis Parisian Globe" on the Lighting line reads as the product alone
        const name = p.name.toLowerCase().startsWith(`${l.lineName.toLowerCase()}:`) ? p.name.slice(l.lineName.length + 1).trim() || p.name : p.name;
        kid.items.push({ id: `${l.itemId}|${partKey}`, itemId: l.itemId, partKey, part: p.name, name, line: l.lineName, qty: Math.max(1, Math.round(p.quantity || 1)), cents: p.cents || null, source: p.source, order: null, receipts: [], ...(p.model ? { model: p.model } : {}), ...(p.whole ? { whole: true } : {}) });
      } else kid.others++;
    });
  }
  const itemById = (kid, itemId, partKey) => kid.items.find((x) => x.itemId === itemId && x.partKey === partKey);
  /**
   * A line read as one whole part (its products weren't split): each thing ordered for it is its own item on that line,
   * so Dylan's fifteen sensory items are fifteen things to receive, not one that the first order fills
   */
  const onWhole = (kid, whole, orderKey, name, qty, cents) => {
    whole.used = true;
    const dk = `w:${decisionKey(orderKey, name)}`;
    return itemById(kid, whole.itemId, dk) || kid.items[kid.items.push({ id: `${whole.itemId}|${dk}`, itemId: whole.itemId, partKey: dk, part: name, name, line: whole.line, qty, cents, source: 'buy', order: null, receipts: [], allocated: true }) - 1];
  };
  /**
   * Bought for a kid on top of their selections: its own line on their budget, made by the site (./_kid-jt.js). Next to
   * one of their allowances (allow: that line, which goes down by it) or in Also bought. A person's answer says which;
   * else the site sorts it (./_kid-allow.js), and until then it waits (pending), so no line is made in the wrong place
   */
  const alsoItem = (kid, key, name, { qty = 1, cents = null, order = null, donated = false, typed = false, allow = null, pending = false } = {}) => {
    let it = itemById(kid, key, 'also');
    if (!it) {
      const rec = record.also.find((a) => a.key === key && a.jobId === kid.jobId);
      const made = rec && !rec.retiredAt ? rec : null;
      it = { id: `${key}|also`, itemId: key, partKey: 'also', name, line: allow ? `${allow.line} allowance` : 'Also bought', qty, cents, source: donated ? 'donated' : 'buy', order, receipts: [],
        also: { key, typed, costItemId: made?.costItemId || null, allowItemId: allow?.itemId || null, allowLine: allow?.line || null, rowAllow: made ? made.allowItemId || null : undefined,
          // A person deleted its line in JobTread: it stays off the budget (it's still the kid's to check in)
          ...(rec?.offByHand ? { offByHand: true } : {}), ...(pending ? { pending: true } : {}) } };
      kid.items.push(it);
    }
    return it;
  };
  /** Bought on top, not by a person's answer: on the allowance the site sorted it under, or (none) Also bought */
  const sorted = (kid, key, name, opts) => {
    if (!kid.allowances.length) return alsoItem(kid, key, name, opts);
    const s = record.sorts.get(key);
    const allow = s?.itemId ? kid.allowances.find((a) => a.itemId === s.itemId) : null;
    // Not sorted yet, or sorted onto an allowance that's gone from the budget since: sorted (again) before any line is made
    if (!s?.how || (s.itemId && !allow)) return alsoItem(kid, key, name, { ...opts, pending: true });
    return alsoItem(kid, key, name, { ...opts, allow });
  };

  // Which emails are one order (its number, a tracking number, a thing both name), each order by the key it's always
  // had. An email whose own key a person's answer or a budget line is kept by keeps it (./_kid-match.js orderKeys)
  const all = await orderReads(DB, ALL_KINDS, strict);
  const said = new Set([...record.decisions.values()].map((d) => d.orderKey).filter(Boolean));
  const alsoKeys = new Set(record.also.filter((a) => !a.typed).map((a) => a.key));
  const keyOf = orderKeys(all, {
    settled: (key, emails) => said.has(key) || emails.some((r) => (r.read.items || []).some((i) => kids.some((k) => alsoKeys.has(alsoKey(key, i.name, k.jobId))))),
  });
  // Cancelled, refunded or sent back, by the store's emails: what they name (none named: it may be any of it), and
  // when they first named all of the order
  const moved = new Map();
  for (const r of all.filter((x) => ['shipped', 'out', 'delivered', 'pickup'].includes(x.read.kind))) moved.set(keyOf(r), [...(moved.get(keyOf(r)) || []), r.at]);
  const undoes = undoneBy(all.filter((r) => UNDO_KINDS.has(r.read.kind)), keyOf, moved);

  // An email that's about one of several orders (the same thing on two orders, and no number of its own) is no order:
  // which one is for a person, when its box is scanned
  const reads = all.filter((r) => ORDER_KINDS.has(r.read.kind) && !keyOf.maybe?.(r));
  // Shipped to a house (not the Office): the things those emails name, or (naming none) all of the order
  const houseBound = new Map();
  for (const r of reads.filter((x) => x.read.shipTo === 'elsewhere')) {
    const h = houseBound.get(keyOf(r)) || { all: false, names: new Set() };
    const named = (r.read.items || []).map((i) => lower(i.name)).filter(Boolean);
    if (!named.length) h.all = true;
    for (const n of named) h.names.add(n);
    houseBound.set(keyOf(r), h);
  }
  const needsLook = [];
  let orders = 0;
  // Orders nobody's placed (no PO, and nothing in them fits a selection): bought on an allowance, or for the office.
  // Each shows as a shipment asking whose it is, until a person says (a kid, or not a kid's)
  const unplaced = [];
  for (const g of orderGroups(reads, keyOf)) {
    // A person's answers: for the whole order (whose it is, or not a kid's, or cancelled) and for each thing in it.
    // Whose a thing is (a line, Also bought) stands until a newer whole-order answer says another kid (Whose is it? after
    // Needs a look, Wrong kid after Whose is it?). That a thing isn't a kid's, or was cancelled, is about the thing,
    // not whose: it stands whatever is said of the order later
    const whole = record.decisions.get(decisionKey(g.key, WHOLE_ORDER));
    const wholeKid = whole?.type === 'kid' && kidOf.has(whole.kid) ? whole.kid : null;
    const dropped = whole?.type === 'notKid' || whole?.type === 'cancelled';
    const newer = (d) => !whole || String(d.at || '') >= String(whole.at || '');
    const answerOf = (name) => {
      const d = record.decisions.get(decisionKey(g.key, name));
      if (!d) return null;
      if (d.type === 'notKid' || d.type === 'cancelled') return dropped && !newer(d) ? null : d;
      return newer(d) ? d : null;
    };
    if (dropped && !g.items.some((it) => answerOf(it.name) && newer(answerOf(it.name)))) continue;
    const m = matchOrder(g, { jobs, lines, staff, templates, kid: wholeKid });
    // Cancelled whole by the store: off the list, unless a person said whose it is after the emails first said all of
    // it was (the box came anyway; a refund for that same cancel says nothing new)
    const undo = undoes.get(g.key);
    const allAt = undo?.allAt(g.items);
    if (allAt && !(wholeKid && String(whole.at || '') > allAt)) continue;
    const house = houseBound.get(g.key);
    const toHouse = (name) => Boolean(house && (house.all || house.names.has(lower(name))));
    const order = { key: g.key, store: g.store, orderNumber: g.orderNumber, at: g.at, buyer: firstOf.get(String(g.buyer || '').toLowerCase()) || String(g.buyer || '').split('@')[0], ...(g.items.length && g.items.every((it) => toHouse(it.name)) ? { elsewhere: true } : {}) };
    const before = Boolean(since && g.at < since);
    const byName = new Map((m.items || []).map((x) => [x.name, x]));
    const looks = [];
    const current = new Map(); // item name → where it was put ('also' or 'line:<item id>'), for a partly cancelled order
    let placed = 0;
    for (const it of g.items) {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
      // The reader keeps an item's price in cents; an older read had it as written. None in any email: a person's
      const emailed = Number.isFinite(Number(it.cents)) && Number(it.cents) > 0 ? Math.round(Number(it.cents)) : priceCents(it.price);
      const said = emailed ? null : record.prices.get(decisionKey(g.key, it.name));
      const cents = emailed || said?.cents || null;
      const d = answerOf(it.name);
      const put = (kid, target) => { Object.assign(target, { order: { ...order, cents, ...(said ? { pricedBy: firstOf.get(String(said.by || '').toLowerCase()) || 'a person' } : {}) }, orderedAs: it.name, before }); current.set(it.name, target.also ? (target.also.allowItemId ? `allow:${target.also.allowItemId}` : 'also') : `line:${target.id}`); placed++; };
      if (d) {
        // A person said: that answer stands over the matcher's
        const kid = d.kid && kidOf.get(d.kid);
        if (d.type === 'notKid' || d.type === 'cancelled' || !kid) continue;
        if (d.type === 'also') { put(kid, alsoItem(kid, alsoKey(g.key, it.name, kid.jobId), it.name, { qty, cents })); continue; }
        if (d.partKey === 'allow') {
          // A person said: bought on that allowance. Its own line next to it; the allowance goes down by it
          const allow = kid.allowances.find((a) => a.itemId === d.itemId);
          if (allow) put(kid, alsoItem(kid, alsoKey(g.key, it.name, kid.jobId), it.name, { qty, cents, allow }));
          else looks.push({ name: it.name, look: 'its allowance changed: which line now?' });
          continue;
        }
        let t = itemById(kid, d.itemId, d.partKey);
        if (t?.whole) t = onWhole(kid, t, g.key, it.name, qty, cents);
        else if (t?.order && t.order.key !== g.key) {
          // That part has another order on it already: a person says this is another one for the same line
          const dk = `${d.partKey}+${decisionKey(g.key, it.name)}`;
          t = itemById(kid, d.itemId, dk) || kid.items[kid.items.push({ ...t, id: `${d.itemId}|${dk}`, partKey: dk, name: it.name, qty, order: null, receipts: [] }) - 1];
        }
        if (t) put(kid, t);
        else looks.push({ name: it.name, look: 'its line changed: which one now?' });
        continue;
      }
      if (dropped || !['placed', 'look'].includes(m.decision)) continue;
      const x = byName.get(it.name);
      const kid = m.kid ? kidOf.get(m.kid) : null;
      if (!x || x.look || !kid) { looks.push({ name: it.name, look: x?.look || 'which kid?' }); continue; }
      if (x.alsoBought) { put(kid, sorted(kid, alsoKey(g.key, it.name, kid.jobId), it.name, { qty, cents })); continue; }
      const whole = kid.items.find((y) => y.itemId === x.itemId && y.whole);
      const target = whole ? onWhole(kid, whole, g.key, it.name, qty, cents)
        : kid.items.find((y) => y.itemId === x.itemId && y.part === x.part && !y.order) || kid.items.find((y) => y.itemId === x.itemId && !y.order);
      if (target) put(kid, target);
      else {
        // Name the part that was ordered already, not just its line
        const first = kid.items.find((y) => y.itemId === x.itemId && y.part === x.part && y.order) || kid.items.find((y) => y.itemId === x.itemId && y.order);
        looks.push({ name: it.name, look: first ? `${first.name} (${first.line}) was ordered already from ${first.order.store}: another one?` : 'which line?' });
      }
    }
    if (placed || looks.length) orders++;
    // Part of the order cancelled or refunded: each thing the emails name (naming none, any of it) that nobody has
    // answered for is asked about ("Cancelled" is an answer; one placed by a person's answer was looked at already)
    const partly = undo && (placed || looks.length) ? (undo.kinds.includes('cancelled') ? 'cancelled' : 'refunded') : null;
    const asked = new Set(looks.map((x) => x.name));
    if (partly) {
      for (const it of g.items) {
        if (!asked.has(it.name) && undo.names(it.name) && !record.decisions.get(decisionKey(g.key, it.name))) looks.push({ name: it.name, look: `part of the order was ${partly}: is this one?`, current: current.get(it.name) || null });
      }
    }
    // Nobody's: no thing in it placed by an answer, nothing to ask item by item, not going to a house, and recent. Part
    // of it cancelled or refunded: asked all the same, saying so (and "Cancelled" is an answer)
    if (m.decision === 'unplaced' && !placed && !looks.length && !order.elsewhere && Date.now() - Date.parse(g.at) < UNPLACED_DAYS * 86400e3) {
      unplaced.push({ key: g.key, store: g.store, orderNumber: g.orderNumber, at: g.at, buyer: order.buyer, ...(undo ? { undo: undo.kinds.includes('cancelled') ? 'cancelled' : 'refunded' } : {}),
        things: g.items.filter((it) => !toHouse(it.name)).map((it) => ({ name: it.name, qty: Math.max(1, Math.round(Number(it.quantity) || 1)), cents: Number.isFinite(Number(it.cents)) && Number(it.cents) > 0 ? Math.round(Number(it.cents)) : priceCents(it.price), ...(undo?.named(it.name) ? { undone: true } : {}) })) });
    }
    if (looks.length) {
      // Kids by the short names the page uses ("Peter R.")
      const shortly = (s) => kids.reduce((t, k) => t.split(String(k.name).replace(/\s*\(\d{4}\)\s*$/, '')).join(k.short), String(s || ''));
      needsLook.push({
        key: g.key, store: g.store, orderNumber: g.orderNumber, at: g.at, buyer: order.buyer, po: g.po, kid: m.kid || null,
        why: m.why ? shortly(m.why) : null, undo: partly,
        items: looks.map((x) => ({ ...x, look: shortly(x.look), guesses: guessesFor(x.name, kids, lineOf) })),
      });
    }
  }

  // What was typed in for a kid ("Something else")
  for (const a of record.also.filter((x) => x.typed)) {
    const kid = kidOf.get(a.jobId);
    if (kid) sorted(kid, a.key, a.name, { cents: a.cents, donated: a.donated, typed: true, order: null });
  }
  // Receipts onto their items; one whose part can't be found any more stays on its line, never dropped
  for (const r of record.receipts) {
    const kid = kidOf.get(r.jobId);
    if (!kid) continue;
    let it = itemById(kid, r.itemId, r.partKey) || kid.items.find((x) => x.itemId === r.itemId && lower(x.name) === lower(r.name))
      // Checked in as Also bought, and since found on one of the kid's lines (their lines were read later): it follows
      || (r.partKey === 'also' && !record.also.some((a) => a.key === r.itemId && a.typed) ? kid.items.find((x) => lower(x.orderedAs) === lower(r.name)) : null)
      // Checked in on an allowance by the page before Nov 11 2026 (a part "allow:…" of the allowance line): the thing bought on it now
      || (String(r.partKey).startsWith('allow:') ? kid.items.find((x) => x.also?.allowItemId === r.itemId && (lower(x.orderedAs) === lower(r.name) || lower(x.name) === lower(r.name))) : null);
    // Undone, and what it was for is on no list now (moved to another kid, another order): nothing to show
    if (!it && r.undoneAt) continue;
    if (!it) {
      const l = r.partKey === 'also' ? null : lineOf.get(`${r.jobId}|${r.itemId}`);
      it = { id: `${r.itemId}|${r.partKey}`, itemId: r.itemId, partKey: r.partKey, name: r.name || 'Checked in', line: l?.lineName || r.line || 'A line that changed', qty: 0, cents: null, source: 'buy', order: null, receipts: [], gone: !l };
      kid.items.push(it);
    }
    if (it) it.receipts.push(r);
  }
  for (const k of kids) {
    // A whole line with things ordered for it shows those things, not itself (unless something was checked in against it)
    k.items = k.items.filter((it) => !(it.whole && it.used && !it.receipts.length));
    for (const it of k.items) {
      if (it.qty === 0) it.qty = Math.max(1, it.receipts.filter((r) => !r.undoneAt).reduce((t, r) => t + (r.units || 0), 0));
      settle(it, (email) => (email ? firstOf.get(String(email).toLowerCase()) || String(email).split('@')[0] : null));
    }
    const rank = { partly: 0, ordered: 1, not: 2, here: 3, out: 4, house: 5 };
    k.items.sort((a, b) => (rank[a.status] - rank[b.status]) || String(a.order?.at || '').localeCompare(String(b.order?.at || '')));
  }
  const shelves = SHELVES.map((s) => {
    const kid = kidOf.get(record.shelves.get(s));
    const here = kids.flatMap((k) => k.items.filter((i) => (i.status === 'here' || i.status === 'partly') && (i.shelves || [i.shelf]).includes(s)).map(() => k.jobId));
    return { shelf: s, name: shelfName(s), kid: kid?.jobId || (s === FLOOR ? null : record.shelves.get(s) || null), things: here.length };
  });
  // Labels that never printed (the printer was off or not set up), for boxes still at the Office: none is lost, all
  // print with one tap once it's ready (the heartbeat prints the last two hours' by itself)
  const atOfficeIds = new Map();
  for (const k of kids) for (const it of k.items) if ((it.status === 'here' || it.status === 'partly') && it.boxesLeft > 0) for (const r of it.receipts) if (!it.allOutIds?.has(r.id)) atOfficeIds.set(r.id, { k, it });
  const unprinted = record.receipts.filter((r) => r.kind === 'receive' && !r.undoneAt && !r.printedAt && atOfficeIds.has(r.id))
    .map((r) => { const { k, it } = atOfficeIds.get(r.id); return { tap: r.id, jobId: k.jobId, short: k.short, name: it.name, boxes: Math.max(1, r.boxes || 1), at: r.at }; });
  // Every open makeover's kid, for "whose is it?": a kid whose budget has only allowances yet is who an allowance buy is for
  const everyKid = kids.map(({ jobId, name, short, photo, shelf, shelves: s, allowances }) => ({ jobId, name, short, photo, shelf, shelves: s, allowances }))
    .sort((a, b) => String(a.short).localeCompare(String(b.short)));
  const view = { practice: !live.on, since, kids: kids.filter((k) => k.items.length || k.shelves.length), everyKid, unprinted, open: jobs.map((j) => j.id), unread, needsLook, orders, shelves, shipments: shipmentsOf(kids, all.filter((r) => SHIP_KINDS.has(r.read.kind) && !keyOf.maybe?.(r)), unplaced, keyOf) };
  // Who ordered, as the page says it ("Clareece")
  const nameOf = (email) => firstOf.get(String(email || '').toLowerCase()) || String(email || '').split('@')[0] || null;
  return { view, reads: all, keyOf, nameOf };
}

/** For an item a person places: each kid's likeliest open part ({ [jobId]: item id }), by the designer's words */
function guessesFor(name, kids, lineOf) {
  const out = {};
  for (const k of kids) {
    let best = null;
    for (const it of k.items) {
      if (it.order || it.also || it.allowance) continue;
      // The part's own words first; its line's words (which every part on the line shares) only break a tie
      const own = fit({ name }, { name: it.part || it.name, brand: '', model: '' }, '').score;
      const l = lineOf.get(`${k.jobId}|${it.itemId}`);
      const score = own * 10 + (own ? 0 : fit({ name }, { name: it.part || it.name, brand: '', model: '' }, l?.words || '').score);
      if (score && (!best || score > best.score)) best = { id: it.id, score };
    }
    if (best) out[k.jobId] = best.id;
  }
  return out;
}

export { OPEN };

/**
 * Does an item named in a delivered email name this one? Its model number, or most of both names' words (a Jaccard
 * of 0.6: "Delta Faucet Handle Kit" isn't "Delta Faucet Cartridge Kit")
 */
const sameThing = (named, it) => {
  const model = String(it.model || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (model.length >= 4 && String(named).toUpperCase().replace(/[^A-Z0-9]/g, '').includes(model)) return true;
  const x = new Set(tokensOf(named)), y = new Set(tokensOf(`${it.orderedAs || it.name}`));
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.6;
};

/**
 * Each order placed on a kid, as a shipment, with where it is by the store's own emails (Peter, Nov 11 2026: "show
 * expected shipments so clareece can print labels from expected shipments and she visually sees that shipment as
 * arrived"): ordered → shipped (the day it's expected; a delay email moves it) → out for delivery → delivered, or
 * ready for pickup → checked in. One shipped to the house says so. A delivered email that names its items marks those
 * (when none of them is one of the order's, it's taken as the whole order). A shipping email with no order number
 * joins its order by its tracking number.
 * → [{ key, store, orderNumber, orderedAt, stage, shippedAt, outAt, deliveredAt, expected, checkedAt, house, items: [{ kid, id, delivered }] }]
 */
/**
 * What the store's cancel, refund and return emails say of each order → key → { kinds, names(name): could it be this
 * thing (an email naming none could be any), named(name): an email names it, allAt(items): when they first said all of
 * it (null: not yet) }. A cancel naming nothing ("Your order has been cancelled") is all of it, unless the order shipped
 * or came after it (a store that cancels part of an order that way: Faire's sellers); a refund or return naming
 * nothing could be part. moved: key → the times its shipping, delivered and pickup emails came
 */
export function undoneBy(reads, keyOf = orderKeys(reads), moved = new Map()) {
  const by = new Map();
  for (const r of [...reads].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const k = keyOf(r);
    const u = by.get(k) || { kinds: [], emails: [] };
    u.kinds.push(r.read.kind);
    const names = (r.read.items || []).map((i) => lower(i.name)).filter(Boolean);
    const wentOn = (moved.get(k) || []).some((at) => String(at) > String(r.at));
    u.emails.push({ at: r.at, names, all: !names.length && r.read.kind === 'cancelled' && !wentOn });
    by.set(k, u);
  }
  for (const u of by.values()) {
    const named = new Set(u.emails.flatMap((e) => e.names));
    const unnamed = u.emails.some((e) => !e.names.length);
    u.named = (name) => named.has(lower(name));
    u.names = (name) => unnamed || named.has(lower(name));
    u.allAt = (items) => {
      if (!items.length) return null;
      const seen = new Set();
      for (const e of u.emails) {
        if (e.all) return e.at;
        for (const n of e.names) seen.add(n);
        if (items.every((it) => seen.has(lower(it.name)))) return e.at;
      }
      return null;
    };
  }
  return by;
}

/** Where each order is by its emails: key → { shippedAt, outAt, deliveredAt, pickupAt, expected, deliveredNames, deliveredAll, house } */
export function orderMail(reads, keyOf = orderKeys(reads)) {
  const mail = new Map();
  for (const r of [...reads].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const k = keyOf(r);
    const t = mail.get(k) || { shippedAt: null, outAt: null, deliveredAt: null, pickupAt: null, expected: null, deliveredNames: [], deliveredAll: false, house: false, houseNames: [] };
    const later = (a, b) => (!a || b > a ? b : a);
    // Oldest first, so the newest email's expected day is the one that stands
    if (r.read.expected) t.expected = r.read.expected;
    // Shipped to a house: the things it names (a store can send part of an order there), or naming none, all of it
    if (r.read.shipTo === 'elsewhere') { const n = (r.read.items || []).map((i) => i.name).filter(Boolean); if (n.length) t.houseNames.push(...n); else t.house = true; }
    if (r.read.kind === 'shipped') t.shippedAt = later(t.shippedAt, r.at);
    if (r.read.kind === 'out') t.outAt = later(t.outAt, r.at);
    if (r.read.kind === 'pickup') t.pickupAt = later(t.pickupAt, r.at);
    if (r.read.kind === 'delivered') {
      t.deliveredAt = later(t.deliveredAt, r.at);
      const names = (r.read.items || []).map((i) => i.name).filter(Boolean);
      if (names.length) t.deliveredNames.push(...names); else t.deliveredAll = true;
    }
    mail.set(k, t);
  }
  return mail;
}

/** Where an order is from its emails alone: delivered · pickup · out · shipped · ordered · house */
export const mailStage = (t = {}) => (t.house ? 'house' : t.deliveredAt ? 'delivered' : t.pickupAt ? 'pickup' : t.outAt ? 'out' : t.shippedAt ? 'shipped' : 'ordered');

export function shipmentsOf(kids, reads, unplaced = [], keyOf = orderKeys(reads)) {
  const mail = orderMail(reads, keyOf);
  const itemOf = new Map(kids.flatMap((k) => k.items.map((i) => [i.id, i])));
  // A delivered email whose names match none of the order's things: it's about this order, so all of it
  const anyNamed = new Map();
  for (const k of kids) for (const it of k.items) {
    const t = it.order?.key && mail.get(it.order.key);
    if (t && t.deliveredNames.some((n) => sameThing(n, it))) anyNamed.set(it.order.key, true);
  }
  const byKey = new Map();
  for (const k of kids) {
    for (const it of k.items) {
      if (!it.order?.key) continue;
      const sh = byKey.get(it.order.key) || { key: it.order.key, store: it.order.store, orderNumber: it.order.orderNumber || null, orderedAt: it.order.at, items: [] };
      const t = mail.get(it.order.key);
      const delivered = Boolean(t && (t.deliveredAll || (t.deliveredNames.length && !anyNamed.get(it.order.key)) || t.deliveredNames.some((n) => sameThing(n, it))));
      sh.items.push({ kid: k.jobId, id: it.id, delivered, here: ['here', 'out', 'house'].includes(it.status) });
      byKey.set(it.order.key, sh);
    }
  }
  const out = [];
  for (const sh of byKey.values()) {
    const t = mail.get(sh.key) || {};
    const waiting = sh.items.filter((i) => !i.here);
    // A delivered email that named only some items: the order is delivered as far as those go
    const houseAll = Boolean(t.house || (t.houseNames?.length && waiting.length && waiting.every((i) => { const it = itemOf.get(i.id); return it && t.houseNames.some((n) => sameThing(n, it)); })));
    const stage = !waiting.length ? 'in' : houseAll ? 'house' : waiting.some((i) => i.delivered) ? 'delivered' : t.pickupAt ? 'pickup' : t.outAt ? 'out' : t.shippedAt ? 'shipped' : 'ordered';
    const lastIn = kids.flatMap((k) => k.items.filter((i) => i.order?.key === sh.key)).flatMap((i) => i.receipts || []).filter((r) => r.kind === 'receive' && !r.undone).map((r) => r.at).sort().pop() || null;
    out.push({ ...sh, stage, house: houseAll, shippedAt: t.shippedAt || null, outAt: t.outAt || null, pickupAt: t.pickupAt || null, deliveredAt: t.deliveredAt || null, expected: t.expected || null, checkedAt: stage === 'in' ? lastIn : null, items: sh.items.map(({ here, ...i }) => i) });
  }
  // Nobody's orders: a shipment like any other (delivered, on the way), its things by name, asking whose it is
  for (const u of unplaced) {
    const t = mail.get(u.key) || {};
    const stage = mailStage(t);
    if (stage === 'house') continue;
    out.push({ key: u.key, store: u.store, orderNumber: u.orderNumber || null, orderedAt: u.at, buyer: u.buyer, unplaced: true, ...(u.undo ? { undo: u.undo } : {}), things: u.things, items: [], stage, house: false, shippedAt: t.shippedAt || null, outAt: t.outAt || null, pickupAt: t.pickupAt || null, deliveredAt: t.deliveredAt || null, expected: t.expected || null, checkedAt: null });
  }
  const rank = { delivered: 0, pickup: 1, out: 2, shipped: 3, ordered: 4, house: 5, in: 6 };
  const when = (x) => x.stage === 'delivered' ? x.deliveredAt : x.stage === 'pickup' ? x.pickupAt : x.stage === 'out' ? x.outAt : x.stage === 'in' ? x.checkedAt : x.orderedAt;
  return out.sort((a, b) => rank[a.stage] - rank[b.stage]
    || (a.stage === 'shipped' ? String(a.expected || '9').localeCompare(String(b.expected || '9')) : String(when(b) || '').localeCompare(String(when(a) || ''))));
}
