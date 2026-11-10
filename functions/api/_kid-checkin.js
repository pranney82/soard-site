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

import { matchOrder, orderGroups, templateLines, namesOf, fit } from './_kid-match.js';
import { loadCostRecords } from './_makeover-costs.js';
import { matchProject } from './_reveals.js';
import { readRecord, readState, decisionKey, alsoKey, shelfName, SHELVES, FLOOR } from './_kid-record.js';

const ORDER_KINDS = new Set(['order', 'shipped', 'out', 'delivered', 'pickup']);
const UNDO_KINDS = new Set(['cancelled', 'refund', 'return']);

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
  it.got = live.filter((r) => r.kind === 'receive').reduce((t, r) => t + (r.units || 0), 0);
  it.sent = live.filter((r) => r.kind === 'out').reduce((t, r) => t + (r.units || 0), 0);
  it.shelf = [...live].reverse().find((r) => r.kind === 'receive' && r.shelf)?.shelf || null;
  if (live.some((r) => r.kind === 'house')) it.status = 'house';
  else if (it.got > 0 && it.sent >= it.got && it.got >= it.qty) it.status = 'out';
  else if (it.got >= it.qty) it.status = 'here';
  else if (it.got > 0) it.status = 'partly';
  else it.status = it.order ? 'ordered' : 'not';
  it.receipts = it.receipts.map(({ id, kind, units, boxes, shelf, at, undoneAt, by, ref }) => ({ id, kind, units, boxes, shelf, at, who: whoOf(by), ...(ref ? { ref } : {}), undone: Boolean(undoneAt) }));
  return it;
}
const OPEN = new Set(['not', 'ordered']);

/**
 * → { practice, since, kids: [{ jobId, name, short, shelves, photo, others, allowances, items }], needsLook, orders, shelves }
 * Each item: { id, itemId, partKey, name, line, qty, source, status, got, shelf, order, orderedAs, before, receipts, also?, allowance? }
 */
export async function checkinView(env, { photos = true, strict = false } = {}) {
  const DB = env.DB;
  const record = await readRecord(DB);
  // Lines the site made itself (Also bought) were read as selections before the reader knew them: never parts
  const made = new Set(record.also.map((a) => a.costItemId).filter(Boolean));
  const partRows = (await rows(DB, 'SELECT job_id, item_id, job_name, group_name, line_name, cents, parts, words, words_key, read_by FROM kid_parts ORDER BY job_name, group_name, line_name', strict))
    .filter((r) => !made.has(r.item_id));
  const lines = partRows.map((r) => ({ jobId: r.job_id, itemId: r.item_id, jobName: r.job_name, lineName: r.line_name, words: r.words || '', wordsKey: r.words_key || '', parts: parse(r.parts, []).map((p) => (r.read_by === 'whole' ? { ...p, whole: true } : p)) }));
  const jobs = [...new Map(lines.map((l) => [l.jobId, { id: l.jobId, name: l.jobName }])).values()];
  // Kids with selection lines the reader couldn't split yet: their orders may belong on those lines
  const unread = [...new Set(partRows.filter((r) => String(r.read_by || '').startsWith('none')).map((r) => r.job_id))];
  const dir = parse((await rows(DB, "SELECT data FROM staff_state WHERE key = 'directory'", strict))[0]?.data, {});
  const staff = new Set((dir.accounts || []).flatMap((a) => String(a.name || '').toLowerCase().split(/\s+/)).filter((w) => w.length > 1));
  // Who ordered, by first name: "Clareece", not her mailbox
  const firstOf = new Map((dir.accounts || []).map((a) => [String(a.email || '').toLowerCase(), String(a.name || '').split(/\s+/)[0]]));
  const templates = templateLines(lines);
  const live = await readState(DB, 'live');
  // Each makeover's Project Manager (the selection reader keeps it): they load out, so the page opens on Check out for them
  const pmOf = new Map((parse((await rows(DB, "SELECT data FROM kid_parts_state WHERE key = 'state'"))[0]?.data, {}).jobs || []).map((j) => [j.id, j.pm || null]));
  const since = live.since || null;

  // Each kid's own page, for their photo (the same match the board's costs use: pinned job, else name and year)
  const pages = photos ? await loadCostRecords(DB).catch(() => []) : [];
  const kids = jobs.map((j) => {
    const page = photos ? matchProject(j.name, pages, j.id) : null;
    const shelves = SHELVES.filter((s) => record.shelves.get(s) === j.id);
    return { jobId: j.id, name: j.name, short: shortName(j.name), pm: pmOf.get(j.id) || null, shelves, shelf: shelves[0] ? shelfName(shelves[0]) : null, photo: avatarOf(page?.photo), others: 0, allowances: [], items: [] };
  });
  const kidOf = new Map(kids.map((k) => [k.jobId, k]));
  const lineOf = new Map(lines.map((l) => [`${l.jobId}|${l.itemId}`, l]));
  for (const l of lines) {
    const kid = kidOf.get(l.jobId);
    if (templates.has(`${l.jobId}|${l.itemId}`)) { kid.allowances.push({ itemId: l.itemId, line: l.lineName, words: l.words.slice(0, 120) }); continue; }
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
        kid.items.push({ id: `${l.itemId}|${partKey}`, itemId: l.itemId, partKey, part: p.name, name, line: l.lineName, qty: Math.max(1, Math.round(p.quantity || 1)), cents: p.cents || null, source: p.source, order: null, receipts: [], ...(p.whole ? { whole: true } : {}) });
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
  const alsoItem = (kid, key, name, { qty = 1, cents = null, order = null, donated = false, typed = false } = {}) => {
    let it = itemById(kid, key, 'also');
    if (!it) {
      const made = record.also.find((a) => a.key === key && a.jobId === kid.jobId && !a.retiredAt);
      it = { id: `${key}|also`, itemId: key, partKey: 'also', name, line: 'Also bought', qty, cents, source: donated ? 'donated' : 'buy', order, receipts: [], also: { key, typed, costItemId: made?.costItemId || null } };
      kid.items.push(it);
    }
    return it;
  };

  // Cancelled, refunded or sent back: the whole order (every item named) undoes it; anything less is for a person
  const undoes = new Map();
  for (const g of orderGroups(await orderReads(DB, UNDO_KINDS, strict))) undoes.set(g.key, g);

  const reads = await orderReads(DB, ORDER_KINDS, strict);
  const elsewhere = new Set(reads.filter((r) => r.read.shipTo === 'elsewhere').map((r) => `${r.store}|${r.read.orderNumber}`));
  const needsLook = [];
  let orders = 0;
  for (const g of orderGroups(reads)) {
    const m = matchOrder(g, { jobs, lines, staff, templates });
    const undo = undoes.get(g.key);
    const whole = undo && undo.items.length && g.items.every((it) => undo.items.some((u) => lower(u.name) === lower(it.name)));
    if (whole) continue;
    const order = { key: g.key, store: g.store, orderNumber: g.orderNumber, at: g.at, buyer: firstOf.get(String(g.buyer || '').toLowerCase()) || String(g.buyer || '').split('@')[0], ...(elsewhere.has(`${g.store}|${g.orderNumber}`) ? { elsewhere: true } : {}) };
    const before = Boolean(since && g.at < since);
    const byName = new Map((m.items || []).map((x) => [x.name, x]));
    const looks = [];
    const current = new Map(); // item name → where it was put ('also' or 'line:<item id>'), for a partly cancelled order
    let placed = 0;
    for (const it of g.items) {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
      // The reader keeps an item's price in cents; an older read had it as written
      const cents = Number.isFinite(Number(it.cents)) && Number(it.cents) > 0 ? Math.round(Number(it.cents)) : priceCents(it.price);
      const d = record.decisions.get(decisionKey(g.key, it.name));
      const put = (kid, target) => { Object.assign(target, { order: { ...order, cents }, orderedAs: it.name, before }); current.set(it.name, target.also ? 'also' : `line:${target.id}`); placed++; };
      if (d) {
        // A person said: that answer stands over the matcher's
        const kid = d.kid && kidOf.get(d.kid);
        if (d.type === 'notKid' || d.type === 'cancelled' || !kid) continue;
        if (d.type === 'also') { put(kid, alsoItem(kid, alsoKey(g.key, it.name, kid.jobId), it.name, { qty, cents })); continue; }
        const tl = lineOf.get(`${d.kid}|${d.itemId}`);
        if (d.partKey === 'allow' && tl) {
          // Bought on the kid's allowance line (decor): its own part there, so the allowance isn't spent twice
          const dk = `allow:${decisionKey(g.key, it.name)}`;
          const t = itemById(kid, d.itemId, dk) || kid.items[kid.items.push({ id: `${d.itemId}|${dk}`, itemId: d.itemId, partKey: dk, name: it.name, line: tl.lineName, qty, cents, source: 'buy', order: null, receipts: [], allowance: true }) - 1];
          put(kid, t);
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
      if (!['placed', 'look'].includes(m.decision)) continue;
      const x = byName.get(it.name);
      const kid = m.kid ? kidOf.get(m.kid) : null;
      if (!x || x.look || !kid) { looks.push({ name: it.name, look: x?.look || 'which kid?' }); continue; }
      if (x.alsoBought) { put(kid, alsoItem(kid, alsoKey(g.key, it.name, kid.jobId), it.name, { qty, cents })); continue; }
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
    // Part of the order cancelled or refunded: each item nobody has answered for is asked about ("Cancelled" is an answer)
    const partly = undo && !whole && (placed || looks.length) ? (undo.kinds.includes('cancelled') ? 'cancelled' : 'refunded') : null;
    const asked = new Set(looks.map((x) => x.name));
    if (partly) {
      for (const it of g.items) {
        if (!asked.has(it.name) && !record.decisions.get(decisionKey(g.key, it.name))) looks.push({ name: it.name, look: `part of the order was ${partly}: is this one?`, current: current.get(it.name) || null });
      }
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
    if (kid) alsoItem(kid, a.key, a.name, { cents: a.cents, donated: a.donated, typed: true, order: null });
  }
  // Receipts onto their items; one whose part can't be found any more stays on its line, never dropped
  for (const r of record.receipts) {
    const kid = kidOf.get(r.jobId);
    if (!kid) continue;
    let it = itemById(kid, r.itemId, r.partKey) || kid.items.find((x) => x.itemId === r.itemId && lower(x.name) === lower(r.name))
      // Checked in as Also bought, and since found on one of the kid's lines (their lines were read later): it follows
      || (r.partKey === 'also' && !record.also.some((a) => a.key === r.itemId && a.typed) ? kid.items.find((x) => lower(x.orderedAs) === lower(r.name)) : null);
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
    const here = kids.flatMap((k) => k.items.filter((i) => (i.status === 'here' || i.status === 'partly') && i.shelf === s).map(() => k.jobId));
    return { shelf: s, name: shelfName(s), kid: kid?.jobId || (s === FLOOR ? null : record.shelves.get(s) || null), things: here.length };
  });
  return { practice: !live.on, since, kids: kids.filter((k) => k.items.length || k.shelves.length), open: jobs.map((j) => j.id), unread, needsLook, orders, shelves };
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
