/**
 * Kid items → JobTread: each selection line says what's ordered and what's here
 * ===========================================================================
 * Peter, Nov 9 2026: "i really just care about ordering and updating in JT, then
 * receiving and updating in JT". Every open makeover's budget lines that SOARD
 * buys or receives get three cost item fields (hidden from families):
 *   Order status   Not ordered · Ordered · At the Office · At the house (the line's part furthest behind)
 *   Order details  each part: when, where, order number, price; how many came, when, which shelf
 *   Shelf          where it is at the Office ("Shelf 7", "Floor")
 * and everything bought on top of the selections is added to the kid's budget at
 * what was paid (the order email's quantity and price), chosen: right after the
 * allowance it's bought under ("Decor: Wall Art Print"), which goes down by it so
 * the money isn't counted twice (Peter, Nov 11 2026: "some items arent yet in JT
 * because we only made an allowance for them in the budget"); when it's none of
 * the kid's allowances, in an "Also bought" group with Also bought ticked. Which
 * one is a person's answer or the site's sorting (./_kid-allow.js); a line moves
 * when that changes and comes off when it isn't the kid's. The page and JobTread
 * are drawn from one view (./_kid-checkin.js), so they can't disagree.
 *
 * Written once: a line is written only when what it should say changed since the
 * last write (kid_jt_lines); an Also bought line carries its key in JobTread's
 * globalId and is looked for before it's made, so a retry makes nothing twice.
 * A person's own edit in JobTread is kept: an Order status set by hand stays
 * until something new happens on that line (a new order or a check-in), and
 * words typed into Order details by hand stay at the bottom of it.
 *
 * Before any makeover is written, the rehearsal runs on the office sandbox job
 * (SANDBOX_JOB_ID): fields, a write, a second write that changes nothing, a hand
 * edit kept, an Also bought line made once though asked twice, a line next to an
 * allowance that goes down by it and comes back when it's moved. Its result is kept
 * in kid_items_state 'rehearsal'; makeovers are written only after it passed.
 */

import { pave, SOARD_ORG_ID, FIELD_JOB_STATUS } from './_reveals.js';
import { SANDBOX_JOB_ID } from './_reveal-nudges.js';
import { checkinView } from './_kid-checkin.js';
import { ensureRecord, readState, writeState, readRecord, shelfName, SHELVES } from './_kid-record.js';
import { costCodes } from './_job-ledger.js';
import { sortAllowances } from './_kid-allow.js';

// Where a line is, as Peter put it (Nov 11 2026: "simplify the JT order status to ordered, office, check out"): its
// part furthest behind says it, and Order details says each part
export const STATUSES = ['Not ordered', 'Ordered', 'At the Office', 'At the house'];
// The options before: Received is At the Office now (a rename, so no line loses its value); the Partly ones go once
// no line or hand edit has them (every line is written again with the new ones first)
export const OLD_STATUSES = { Received: 'At the Office', 'Partly received': null, 'Partly ordered': null };
export const FIELDS = {
  status: { name: 'Order status', type: 'option', options: STATUSES, maxValuesAllowed: 1 },
  details: { name: 'Order details', type: 'text' },
  shelf: { name: 'Shelf', type: 'text' },
  also: { name: 'Also bought', type: 'boolean' },
};
export const ALSO_GROUP = 'Also bought';
export const REHEARSAL_V = 7; // 7: the four statuses (Received renamed At the Office, At the house added); // 6: moved next to an allowance by an update too, and a run cut off half-way cleaned up; 5: a line next to an allowance, the allowance down by it, moved to Also bought (Nov 11 2026); 2: the cost code JobTread requires on a new line; 3: and the cost type; 4: an update asks for nothing back (Nov 10 2026)
const EVERY_MS = 2 * 60 * 1000;
const WRITES_A_RUN = 24;
const RUN_MS = 20 * 1000;
const DETAILS_MAX = 3800;
const NOTE_HEAD = 'Note:';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kid_jt_lines (
    job_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT, wrote TEXT, hand TEXT, planned TEXT, wrote_at TEXT, error TEXT,
    PRIMARY KEY (job_id, item_id))`,
];
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  await ensureRecord(DB);
  for (const s of SCHEMA) await DB.prepare(s).run();
  _ready.add(DB);
}
const parse = (s, fallback) => { try { return JSON.parse(s || ''); } catch { return fallback; } };

// ─── What a line says ───────────────────────────────────────────────

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : '');
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One part, in a line of words: "Raincan Shower Head: ordered Nov 2 from Home Depot, order W123, $129.00; here Nov 9, Shelf 3" */
export function partLine(it) {
  const bits = [];
  if (it.order) bits.push([`ordered ${day(it.order.at)}`, it.order.store ? `from ${it.order.store}` : null, it.order.orderNumber ? `order ${it.order.orderNumber}` : null, it.order.cents ? usd(it.order.cents) : null].filter(Boolean).join(', '));
  else if (it.source === 'donated') bits.push('donated, coming');
  else if (it.also?.typed) bits.push(`bought${it.cents ? `, ${usd(it.cents)}` : ''}`);
  const got = (it.receipts || []).filter((r) => !r.undone && r.kind === 'receive');
  const outs = (it.receipts || []).filter((r) => !r.undone && r.kind === 'out');
  const last = got[got.length - 1];
  const lastOut = outs[outs.length - 1];
  const by = (r) => (r?.who ? ` (${r.who})` : '');
  const boxesIn = got.reduce((t, r) => t + Math.max(1, r.boxes || 1), 0);
  // Boxes still at the Office: the view's count (a line read without one: all out once every unit went)
  const boxesOut = Math.max(0, boxesIn - (it.boxesLeft ?? (it.got && (it.sent || 0) >= it.got ? 0 : boxesIn)));
  const where = it.shelf && boxesOut < boxesIn ? `, ${shelfName(it.shelf)}` : '';
  if (it.status === 'house') bits.push('went to the house, not the Office');
  else if (it.house && it.got < it.qty) bits.push(`${it.got} of ${it.qty} here ${day(last?.at)}${by(last)}${where}; the rest went to the house`);
  else if (it.status === 'here' || it.status === 'out') bits.push(`${it.qty > 1 ? `all ${it.qty} here` : 'here'} ${day(last?.at)}${by(last)}${it.status === 'here' ? where : ''}`);
  else if (it.status === 'partly') bits.push(`${it.got} of ${it.qty} here ${day(last?.at)}${by(last)}${where}`);
  else if (!bits.length) bits.push('not ordered yet');
  // By the boxes, as they're loaded: 2 of a vanity's 3 boxes on the truck is said before the whole vanity is
  if (boxesOut) bits.push(`${boxesOut >= boxesIn ? 'out to the house' : `${boxesOut} of ${boxesIn} boxes out to the house`} ${day(lastOut?.at)}${by(lastOut)}`);
  return `${it.qty > 1 ? `${it.name} (${it.qty})` : it.name}: ${bits.join('; ')}`;
}

/**
 * Where one part is: 0 not ordered · 1 ordered (or part of it here, the rest coming) · 2 at the Office · 3 at the house
 * (all of it went out at load-out, or straight there)
 */
const stageOf = (i) => (i.status === 'out' || i.status === 'house' ? 3 : i.status === 'here' ? 2 : i.order || i.source === 'donated' || i.also || i.status === 'partly' || i.status === 'ordered' ? 1 : 0);
/** A line's status: its part furthest behind (a shower system is At the Office when every part of it is) */
export function lineStatus(items) {
  if (!items.length) return null;
  return STATUSES[Math.min(...items.map(stageOf))];
}

/** What a line's three fields should say → { status, details, shelf } */
export function lineValues(items, { allowance = false } = {}) {
  // Where it is: the shelves holding what's still at the Office; once all of it went out, the house
  const atOffice = items.filter((i) => i.shelf && (i.status === 'here' || i.status === 'partly') && (i.boxesLeft ?? (i.got - (i.sent || 0))) > 0);
  const shelves = [...new Set(atOffice.flatMap((i) => (i.shelves?.length ? i.shelves : [i.shelf])))].sort((a, b) => SHELVES.indexOf(a) - SHELVES.indexOf(b));
  const allOut = !atOffice.length && items.some((i) => i.sent);
  let details = items.map(partLine).join('\n');
  if (details.length > DETAILS_MAX) details = `${details.slice(0, DETAILS_MAX - 1)}…`;
  return { status: lineStatus(items), details, shelf: shelves.length ? shelves.map(shelfName).join(', ') : allOut ? 'At the house' : null };
}

/** Each JobTread line the site writes, from the view → [{ jobId, kid, itemId, also, allowance, items }] */
export function linesOf(view) {
  const out = [];
  for (const k of view.kids) {
    const byLine = new Map();
    for (const it of k.items) {
      if (it.gone) continue;
      const id = it.also ? it.also.costItemId || `pending:${it.also.key}` : it.itemId;
      const l = byLine.get(id) || { jobId: k.jobId, kid: k.short, itemId: id, also: it.also || null, allowance: false, items: [] };
      // A line whose products aren't known one by one (what's bought for it is each its own part)
      if (it.allowance || it.allocated) l.allowance = true;
      l.items.push(it);
      byLine.set(id, l);
    }
    out.push(...byLine.values());
  }
  return out;
}

/**
 * A person's edit in JobTread, kept: → { status, details } to write
 *   values  what the site's record says now; last: what the site last wrote; now: what JobTread says; hand: kept edits
 */
export function withHand(values, last, now, hand = {}) {
  const h = { ...hand, ...(hand.status ? { status: { ...hand.status } } : {}) };
  // A word from before the four, as JobTread says it now (Received is At the Office; the Partly ones have none)
  const renamed = (st) => (st && OLD_STATUSES[st] ? OLD_STATUSES[st] : st);
  // JobTread's status isn't what the site last wrote (or there was one before the site's first write): a person set
  // it. It stands while the site's own status stays where it was then, and goes when the line has news
  if (now?.status != null && now.status !== values.status && now.status !== renamed(last ? last.status : undefined) && now.status !== (last ? last.status : undefined)) {
    h.status = { value: now.status, basis: last ? last.status : values.status };
  }
  // A person's status from before the four: its word as it is now, and the line as the site says it now is where it
  // stood (the change of words is no news on the line)
  if (h.status) {
    h.status.value = renamed(h.status.value);
    if (!STATUSES.includes(h.status.basis)) h.status.basis = values.status;
  }
  if (h.status && (h.status.basis !== values.status || !STATUSES.includes(h.status.value))) delete h.status;
  // Lines in Order details the site didn't write: a person's note, every line of it, kept at the bottom
  if (now?.details && now.details !== (last?.details ?? null)) {
    const mine = new Set([...String(last?.details || '').split('\n'), ...String(values.details || '').split('\n')].map((l) => l.trim()));
    let note = String(h.note || '');
    const kept = new Set(note.split('\n'));
    for (const raw of String(now.details).split('\n')) {
      const line = raw.trim();
      if (!line || mine.has(line)) continue;
      const text = line.replace(new RegExp(`^${NOTE_HEAD}\\s*`), '').trim();
      if (!text || kept.has(text)) continue;
      note = note ? `${note}\n${text}` : text;
      kept.add(text);
    }
    if (note) h.note = note;
  }
  const out = { ...values };
  if (h.status) out.status = h.status.value;
  if (h.note) out.details = `${values.details}\n${NOTE_HEAD} ${h.note}`.slice(0, DETAILS_MAX + 400);
  return { values: out, hand: h };
}

// ─── JobTread ───────────────────────────────────────────────────────

let _fields = null;
/** The four cost item fields' ids, made the first time (hidden from families: showOnSpecifications false) */
export async function fieldIds(env, { fetchImpl = fetch } = {}) {
  if (_fields && _fields.env === env) return _fields.ids;
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: { $: { id: SOARD_ORG_ID }, customFields: { $: { size: 100, where: ['targetType', '=', 'costItem'] }, nodes: { id: {}, name: {}, type: {}, options: {} } } },
  }, fetchImpl);
  const have = new Map((data?.organization?.customFields?.nodes || []).map((f) => [String(f.name).trim().toLowerCase(), f]));
  const ids = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const found = have.get(f.name.toLowerCase());
    if (found) {
      ids[k] = found.id;
      if (k === 'status') await settleOptions(env, found, { fetchImpl });
      continue;
    }
    const made = await pave(env.JOBTREAD_GRANT_KEY, {
      createCustomField: {
        $: { organizationId: SOARD_ORG_ID, targetType: 'costItem', type: f.type, name: f.name, minValuesRequired: 0, showOnSpecifications: false, ...(f.options ? { options: f.options } : {}), ...(f.maxValuesAllowed ? { maxValuesAllowed: f.maxValuesAllowed } : {}) },
        createdCustomField: { id: {} },
      },
    }, fetchImpl);
    ids[k] = made?.createCustomField?.createdCustomField?.id;
    if (!ids[k]) throw new Error(`JobTread didn’t make the “${f.name}” field`);
  }
  _fields = { env, ids };
  return ids;
}

/**
 * The Order status field's options, brought to the four: Received renamed At the Office (the lines that say it keep
 * it), At the house added. The old Partly ones stay until no line or hand edit has them (letGo), then go
 */
async function settleOptions(env, field, { fetchImpl = fetch, letGo = false } = {}) {
  const have = (Array.isArray(field.options) ? field.options : []).map((o) => (typeof o === 'string' ? o : o?.name || o?.value)).filter(Boolean);
  const renamed = (to) => Object.keys(OLD_STATUSES).find((from) => OLD_STATUSES[from] === to && have.includes(from) && !have.includes(to));
  const want = STATUSES.map((s) => (renamed(s) ? { rename: { from: renamed(s), to: s } } : s));
  const old = letGo ? [] : have.filter((o) => !STATUSES.includes(o) && !want.some((w) => w.rename?.from === o));
  const next = [...want, ...old];
  const plain = next.map((o) => (typeof o === 'string' ? o : o.rename.to));
  if (plain.length === have.length && plain.every((o, i) => o === have[i])) return false;
  await pave(env.JOBTREAD_GRANT_KEY, { updateCustomField: { $: { id: field.id, options: next } } }, fetchImpl);
  field.options = plain;
  return true;
}

/** Once every line says one of the four (none, nor a hand edit, says an old one): the old options go → true if they did */
export async function letGoOldStatuses(env, { fetchImpl = fetch } = {}) {
  await ensure(env.DB);
  // Open makeovers' lines only: a closed one's last write (or a line gone from JobTread) never holds the old words up
  const rows = (await env.DB.prepare('SELECT wrote, hand FROM kid_jt_lines WHERE job_id IN (SELECT DISTINCT job_id FROM kid_parts) AND error IS NULL').all()).results || [];
  const old = (v) => v && !STATUSES.includes(v);
  if (rows.some((r) => old(parse(r.wrote, {})?.status) || old(parse(r.hand, {})?.status?.value))) return false;
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: { $: { id: SOARD_ORG_ID }, customFields: { $: { size: 100, where: ['targetType', '=', 'costItem'] }, nodes: { id: {}, name: {}, type: {}, options: {} } } },
  }, fetchImpl);
  const field = (data?.organization?.customFields?.nodes || []).find((f) => String(f.name).trim().toLowerCase() === FIELDS.status.name.toLowerCase());
  if (!field) return false;
  await settleOptions(env, field, { fetchImpl, letGo: true });
  return true;
}

/** A cost item's three fields as JobTread has them now → { status, details, shelf } | null (gone) */
export async function readLine(env, ids, id, { fetchImpl = fetch } = {}) {
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    costItem: { $: { id }, id: {}, customFieldValues: { $: { size: 20 }, nodes: { value: {}, customField: { id: {} } } } },
  }, fetchImpl);
  if (!data?.costItem?.id) return null;
  const v = (fid) => data.costItem.customFieldValues?.nodes?.find((n) => n.customField?.id === fid)?.value;
  const status = v(ids.status);
  return { status: Array.isArray(status) ? status[0] ?? null : status ?? null, details: v(ids.details) ?? null, shelf: v(ids.shelf) ?? null };
}

const same = (a, b) => a && b && (a.status ?? null) === (b.status ?? null) && (a.details ?? null) === (b.details ?? null) && (a.shelf ?? null) === (b.shelf ?? null);

/**
 * Write one line if it should say something new → { wrote, values } (never writes what JobTread already says)
 * line: { jobId, itemId, allowance, items }
 */
export async function writeLine(env, ids, line, { fetchImpl = fetch, now = new Date().toISOString(), dry = false } = {}) {
  await ensure(env.DB);
  const row = await env.DB.prepare('SELECT wrote, hand FROM kid_jt_lines WHERE job_id = ? AND item_id = ?').bind(line.jobId, line.itemId).first();
  const last = parse(row?.wrote, null);
  const computed = lineValues(line.items, { allowance: line.allowance });
  if (!computed.status && !last) return { wrote: false, values: computed };
  const stored = parse(row?.hand, {});
  const kept = withHand(computed, null, null, stored);
  // A person's status from before the four, moved onto the line as it is now: kept so, on this run, written or not (the
  // next run with news on the line takes it away, as with any hand edit)
  if (row && JSON.stringify(kept.hand) !== JSON.stringify(stored) && !dry) {
    await env.DB.prepare('UPDATE kid_jt_lines SET hand = ? WHERE job_id = ? AND item_id = ?').bind(JSON.stringify(kept.hand), line.jobId, line.itemId).run();
    row.hand = JSON.stringify(kept.hand);
  }
  if (last && same(kept.values, last)) return { wrote: false, values: last };
  if (dry) {
    await env.DB.prepare('INSERT INTO kid_jt_lines (job_id, item_id, kind, planned, wrote_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, item_id) DO UPDATE SET planned = excluded.planned')
      .bind(line.jobId, line.itemId, line.also ? 'also' : 'line', JSON.stringify(computed), now).run();
    return { wrote: false, planned: computed };
  }
  const current = await readLine(env, ids, line.itemId, { fetchImpl });
  if (!current) {
    await env.DB.prepare('INSERT INTO kid_jt_lines (job_id, item_id, kind, error, wrote_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, item_id) DO UPDATE SET error = excluded.error')
      .bind(line.jobId, line.itemId, line.also ? 'also' : 'line', 'The line is gone from JobTread', now).run();
    // A line the site made, deleted by a person in JobTread: off the budget for good, never made again behind their back
    if (line.also?.key) await env.DB.prepare('UPDATE kid_also SET retired_at = ?, off_by_hand = ? WHERE key = ?').bind(now, now, line.also.key).run();
    return { wrote: false, gone: true };
  }
  const { values, hand } = withHand(computed, last, current, parse(row?.hand, {}));
  let wrote = false;
  if (!same(values, current)) {
    await pave(env.JOBTREAD_GRANT_KEY, {
      updateCostItem: { $: { id: line.itemId, customFieldValues: { [ids.status]: values.status, [ids.details]: values.details || null, [ids.shelf]: values.shelf } } },
    }, fetchImpl);
    wrote = true;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO kid_jt_lines (job_id, item_id, kind, wrote, hand, wrote_at, error) VALUES (?, ?, ?, ?, ?, ?, NULL)')
    .bind(line.jobId, line.itemId, line.also ? 'also' : 'line', JSON.stringify(values), JSON.stringify(hand), now).run();
  return { wrote, values };
}

/** The job's "Also bought" budget group, made the first time */
async function groupNamed(env, jobId, name, description, { fetchImpl }) {
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    job: { $: { id: jobId }, costGroups: { $: { size: 5, where: { and: [['name', '=', name], [['document', 'id'], '=', null]] } }, nodes: { id: {} } } },
  }, fetchImpl);
  const found = data?.job?.costGroups?.nodes?.[0]?.id;
  if (found) return found;
  const made = await pave(env.JOBTREAD_GRANT_KEY, { createCostGroup: { $: { jobId, name, description }, createdCostGroup: { id: {} } } }, fetchImpl);
  const id = made?.createCostGroup?.createdCostGroup?.id;
  if (!id) throw new Error(`JobTread didn’t make the ${name} group`);
  return id;
}
const alsoGroup = (env, jobId, { fetchImpl }) => groupNamed(env, jobId, ALSO_GROUP, 'Bought for the kid on top of the selections (added by the website at check-in and from order emails)', { fetchImpl });

let _types = null;
/**
 * The cost type and code for an Also bought line (JobTread requires a code): Materials, and the code the kid's own
 * goods lines use most; else one named for furnishings, decor or materials; else SOARD's first code
 */
async function alsoCodes(env, jobId, { fetchImpl }) {
  if (!_types || _types.env !== env) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, { organization: { $: { id: SOARD_ORG_ID }, costTypes: { $: { size: 50 }, nodes: { id: {}, name: {} } } } }, fetchImpl);
    const types = data?.organization?.costTypes?.nodes || [];
    const codes = await costCodes(env, { fetchImpl }).catch(() => []);
    _types = { env, costTypeId: types.find((t) => /material/i.test(t.name))?.id || null, otherType: types.find((t) => !/labor|subcontract/i.test(t.name))?.id || null, codes };
  }
  const job = await pave(env.JOBTREAD_GRANT_KEY, {
    job: { $: { id: jobId }, costItems: { $: { size: 50, where: [['document', 'id'], '=', null] }, nodes: { costCode: { id: {} }, costType: { id: {}, name: {} }, isSelected: {} } } },
  }, fetchImpl).catch(() => null);
  const count = new Map();
  const typeCount = new Map();
  for (const c of job?.job?.costItems?.nodes || []) {
    if (/labor|subcontract/i.test(c.costType?.name || '')) continue;
    const w = c.isSelected ? 2 : 1;
    if (c.costCode?.id) count.set(c.costCode.id, (count.get(c.costCode.id) || 0) + w);
    if (c.costType?.id) typeCount.set(c.costType.id, (typeCount.get(c.costType.id) || 0) + w);
  }
  const mostUsed = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const mostType = [...typeCount].sort((a, b) => b[1] - a[1])[0]?.[0];
  const { codes } = _types;
  return {
    // JobTread requires a type too: Materials, else the type the kid's goods lines use most, else any that isn't labor
    costTypeId: _types.costTypeId || mostType || _types.otherType || null,
    costCodeId: mostUsed || codes.find((c) => /furnish|furniture|decor|accessor/i.test(c.name))?.id || codes.find((c) => /material|finish|fixture/i.test(c.name))?.id || codes[0]?.id || null,
  };
}

/**
 * Make an Also bought line once (its key is the line's globalId: looked for first) → its cost item id
 * thing: { key, jobId, name, qty, cents, donated, store, orderNumber, kid }
 */
export async function makeAlso(env, ids, thing, { fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  await ensure(env.DB);
  const DB = env.DB;
  await DB.prepare('INSERT OR IGNORE INTO kid_also (key, job_id, name, cents, qty, donated, store, order_number, typed, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .bind(thing.key, thing.jobId, String(thing.name).slice(0, 250), thing.cents || null, Math.max(1, thing.qty || 1), thing.donated ? 1 : 0, thing.store || null, thing.orderNumber || null, now).run();
  // Taken off the budget before (moved to another kid, cancelled, its allowance gone) and the kid's again: made again.
  // One a person deleted in JobTread stays off
  await DB.prepare('UPDATE kid_also SET cost_item_id = NULL, retired_at = NULL, allow_item_id = NULL WHERE key = ? AND retired_at IS NOT NULL AND off_by_hand IS NULL').bind(thing.key).run();
  // Claimed for a minute before JobTread is asked: a check-in's write and the heartbeat's can't both make it
  const ms = Date.parse(now) || Date.now();
  const claim = await DB.prepare('UPDATE kid_also SET claim_until = ? WHERE key = ? AND cost_item_id IS NULL AND (claim_until IS NULL OR claim_until < ?)').bind(ms + 60000, thing.key, ms).run();
  if (!claim.meta?.changes) { const r = await DB.prepare('SELECT cost_item_id, retired_at FROM kid_also WHERE key = ?').bind(thing.key).first(); return r && !r.retired_at ? r.cost_item_id || null : null; }
  try {
    return await makeClaimed(env, ids, thing, { fetchImpl, now });
  } finally {
    await DB.prepare('UPDATE kid_also SET claim_until = NULL WHERE key = ?').bind(thing.key).run().catch(() => {});
  }
}

/** An allowance line as JobTread has it now (its group and codes, for a line next to it; its amount, to take purchases off) */
export async function allowanceOf(env, id, { fetchImpl = fetch } = {}) {
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    costItem: { $: { id }, id: {}, name: {}, quantity: {}, unitCost: {}, unitPrice: {}, unitCostFormula: {}, unitPriceFormula: {}, isSelected: {}, costGroup: { id: {}, name: {}, isSimpleSelection: {}, maxSelectionsAllowed: {}, minSelectionsRequired: {}, parentCostGroup: { id: {} } }, costCode: { id: {} }, costType: { id: {} } },
  }, fetchImpl);
  const c = data?.costItem;
  if (!c?.id) return null;
  const g = c.costGroup || {};
  return { id: c.id, name: c.name, quantity: Number(c.quantity) || 1, unitCost: Number(c.unitCost) || 0, unitPrice: Number(c.unitPrice) || 0, formula: Boolean(c.unitCostFormula || c.unitPriceFormula), selected: c.isSelected !== false,
    groupId: g.id || null, groupName: g.name || null, picks: g.maxSelectionsAllowed ?? null, parentId: g.parentCostGroup?.id || null, simple: Boolean(g.isSimpleSelection), costCodeId: c.costCode?.id || null, costTypeId: c.costType?.id || null };
}

/** A bought-on-top line's name and words: "Decor: Wall Art Print", "Bought for Ava on the Decor allowance (Target, order 12)…" */
const rowName = (thing) => String(thing.allowItemId ? `${thing.allowLine}: ${thing.name}` : thing.name).slice(0, 250);
function rowWords(thing) {
  const where = [thing.store, thing.orderNumber ? `order ${thing.orderNumber}` : null].filter(Boolean).join(', ');
  return [thing.allowItemId
    ? `Bought for ${thing.kid || 'the kid'} on the ${thing.allowLine} allowance${where ? ` (${where})` : ''}: the allowance went down by it.`
    : `Bought for ${thing.kid || 'the kid'} on top of the selections${where ? ` (${where})` : ''}.`,
  thing.donated ? 'Donated.' : !thing.cents ? 'No price given yet.' : null].filter(Boolean).join(' ');
}
/** Where a bought-on-top line goes: right after its allowance, in the allowance's group, with its codes; else Also bought */
async function placeOf(env, thing, { fetchImpl }) {
  if (thing.allowItemId) {
    const a = await allowanceOf(env, thing.allowItemId, { fetchImpl });
    if (!a?.groupId) throw new Error(`JobTread doesn’t have ${thing.kid || 'the kid'}’s ${thing.allowLine} allowance line any more`);
    const codes = a.costCodeId && a.costTypeId ? { costCodeId: a.costCodeId, costTypeId: a.costTypeId } : await alsoCodes(env, thing.jobId, { fetchImpl });
    // A selection group that limits how many are picked (an option to choose): one more picked line would change the
    // choice, so the line goes right after the group, in the group it's in
    if (a.picks != null) return { costGroupId: a.parentId, positionAfter: { type: 'costGroup', id: a.groupId }, ...codes };
    return { costGroupId: a.groupId, positionAfter: { type: 'costItem', id: a.id }, ...codes };
  }
  const [costGroupId, codes] = await Promise.all([alsoGroup(env, thing.jobId, { fetchImpl }), alsoCodes(env, thing.jobId, { fetchImpl })]);
  return { costGroupId, ...codes };
}

async function makeClaimed(env, ids, thing, { fetchImpl, now }) {
  const look = await pave(env.JOBTREAD_GRANT_KEY, {
    job: { $: { id: thing.jobId }, costItems: { $: { size: 2, where: ['globalId', '=', thing.key] }, nodes: { id: {} } } },
  }, fetchImpl);
  let id = look?.job?.costItems?.nodes?.[0]?.id || null;
  if (!id) {
    const place = await placeOf(env, thing, { fetchImpl });
    if (!place.costCodeId || !place.costTypeId) throw new Error('JobTread has no cost code or type to put it under');
    const qty = Math.max(1, thing.qty || 1);
    const unit = thing.donated || !thing.cents ? 0 : Math.round(thing.cents) / 100;
    const made = await pave(env.JOBTREAD_GRANT_KEY, {
      createCostItem: {
        $: {
          jobId: thing.jobId, ...place, name: rowName(thing), globalId: thing.key, isSelected: true, quantity: qty, unitCost: unit, unitPrice: unit,
          description: rowWords(thing),
          customFieldValues: { [ids.also]: !thing.allowItemId },
        },
        createdCostItem: { id: {} },
      },
    }, fetchImpl);
    id = made?.createCostItem?.createdCostItem?.id || null;
    if (!id) throw new Error(`JobTread didn’t add ${thing.name}`);
  }
  await env.DB.prepare('UPDATE kid_also SET cost_item_id = ?, allow_item_id = ?, qty = ?, cents = ?, made_at = ?, error = NULL, retired_at = NULL WHERE key = ?')
    .bind(id, thing.allowItemId || null, Math.max(1, thing.qty || 1), thing.cents || null, now, thing.key).run();
  return id;
}

/**
 * A bought-on-top line already on the budget, kept as the record says: moved next to the allowance it's bought under (or
 * to Also bought) when that changed, and its quantity and price when the order's changed. → true when JobTread was written
 * row: its kid_also record
 */
export async function keepAlso(env, ids, thing, row, { fetchImpl = fetch } = {}) {
  const qty = Math.max(1, thing.qty || 1);
  const moved = (row.allowItemId || null) !== (thing.allowItemId || null);
  // A line made before its quantity was kept (Nov 11 2026) was made with the order's: only its price is compared
  const priced = (row.qty != null && row.qty !== qty) || (row.cents || null) !== (thing.cents || null);
  if (!moved && !priced) {
    if (row.qty == null) await env.DB.prepare('UPDATE kid_also SET qty = ? WHERE key = ?').bind(qty, thing.key).run();
    return false;
  }
  const $ = { id: row.costItemId };
  if (moved) Object.assign($, await placeOf(env, thing, { fetchImpl }), { name: rowName(thing), description: rowWords(thing), customFieldValues: { [ids.also]: !thing.allowItemId } });
  if (priced) { const unit = thing.donated || !thing.cents ? 0 : Math.round(thing.cents) / 100; Object.assign($, { quantity: qty, unitCost: unit, unitPrice: unit }); }
  await pave(env.JOBTREAD_GRANT_KEY, { updateCostItem: { $ } }, fetchImpl);
  await env.DB.prepare('UPDATE kid_also SET allow_item_id = ?, qty = ?, cents = ?, error = NULL WHERE key = ?').bind(thing.allowItemId || null, qty, thing.cents || null, thing.key).run();
  return true;
}

/**
 * An allowance line's amount: what it was before the site took anything off it, less what's bought on it now (never
 * below $0), so the money isn't counted twice and nothing is ever taken off twice. The amount it started from is kept
 * (kid_allowances); a person who changes the amount in JobTread changes what's left, and that stands. An amount set by
 * a formula is left as it is. spentCents: what its bought-on-top lines cost → { wrote, cost, price } or { skipped }
 */
export async function settleAllowance(env, jobId, itemId, spentCents, { fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  await ensure(env.DB);
  // JobTread first, then the site's record: a write that landed between the two is seen in the record
  const a = await allowanceOf(env, itemId, { fetchImpl });
  const st = await env.DB.prepare('SELECT * FROM kid_allowances WHERE job_id = ? AND item_id = ?').bind(jobId, itemId).first();
  const keep = (row) => env.DB.prepare(`INSERT OR REPLACE INTO kid_allowances (job_id, item_id, quantity, unit_cost, unit_price, spent_cents, written_cost, written_price, prev_cost, prev_price, skip, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(jobId, itemId, row.quantity ?? null, row.unit_cost ?? null, row.unit_price ?? null, spentCents, row.written_cost ?? null, row.written_price ?? null, row.prev_cost ?? null, row.prev_price ?? null, row.skip ?? null, now).run();
  if (!a || a.formula) {
    // Gone from JobTread, or set by a formula: left as it is, and not asked about again until what's bought on it changes
    await keep({ ...(st || {}), skip: a ? 'formula' : 'gone' });
    return { skipped: a ? 'formula' : 'gone' };
  }
  const near = (x, y) => x != null && y != null && Math.abs(Number(x) - Number(y)) < 0.005;
  const r2 = (n) => Math.round(n * 100) / 100;
  const qty = a.quantity || 1;
  const same = st && near(qty, st.quantity);
  // Each amount on its own: as the site left it (what it wrote, or what it was before a write that never landed) starts
  // from the same place; changed by a person (in JobTread), what they set is what's left after what was bought then
  const startOf = (cur, written, prev, start) => (same && (near(cur, written) || near(cur, prev)) ? start : cur + (st.spent_cents || 0) / 100 / qty);
  const from = st && !st.skip
    ? { cost: startOf(a.unitCost, st.written_cost, st.prev_cost, st.unit_cost), price: startOf(a.unitPrice, st.written_price, st.prev_price, st.unit_price) }
    : st?.skip && st.unit_cost != null
      // Left alone a while (a formula, or gone and back): what it is now is what's left after what was bought then
      ? { cost: a.unitCost + (st.spent_cents || 0) / 100 / qty, price: a.unitPrice + (st.spent_cents || 0) / 100 / qty }
      : { cost: a.unitCost, price: a.unitPrice };
  const off = spentCents / 100 / qty;
  const next = { cost: r2(Math.max(0, from.cost - off)), price: r2(Math.max(0, from.price - off)) };
  const wrote = !near(next.cost, a.unitCost) || !near(next.price, a.unitPrice);
  // Kept before JobTread is written: a run cut off after the write never takes it off twice
  await keep({ quantity: qty, unit_cost: from.cost, unit_price: from.price, written_cost: next.cost, written_price: next.price, prev_cost: a.unitCost, prev_price: a.unitPrice });
  if (wrote) await pave(env.JOBTREAD_GRANT_KEY, { updateCostItem: { $: { id: itemId, unitCost: next.cost, unitPrice: next.price } } }, fetchImpl);
  return { wrote, ...next };
}

/**
 * An Also bought line that isn't the kid's any more (moved to another kid, not a kid's, cancelled): taken off their
 * budget. JobTread deletes it; one it won't delete (a bill is on it) is zeroed and says why
 */
export async function retireAlso(env, a, { fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  try {
    await pave(env.JOBTREAD_GRANT_KEY, { deleteCostItem: { $: { id: a.costItemId } } }, fetchImpl);
  } catch {
    await pave(env.JOBTREAD_GRANT_KEY, {
      updateCostItem: { $: { id: a.costItemId, unitCost: 0, unitPrice: 0, description: 'Not this kid’s any more (moved, cancelled or not a kid’s at check-in), so it costs nothing here.' } },
    }, fetchImpl);
  }
  await env.DB.prepare('UPDATE kid_also SET retired_at = ? WHERE key = ?').bind(now, a.key).run();
  await env.DB.prepare('DELETE FROM kid_jt_lines WHERE job_id = ? AND item_id = ?').bind(a.jobId, a.costItemId).run();
}

// ─── The rehearsal on the office sandbox job ───────────────────────

const fake = (name, extra = {}) => ({ name, qty: 1, got: 0, status: 'not', source: 'buy', order: null, receipts: [], shelf: null, ...extra });
const ordered = { store: 'Rehearsal Store', orderNumber: 'R-1', at: '2026-11-02T15:00:00Z', cents: 1250 };

/** Every step a real makeover's lines go through, on the sandbox job; makeovers wait until it has passed once */
export async function rehearse(env, { fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 200) } : {}) }); if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`); };
  try {
    const ids = await fieldIds(env, { fetchImpl });
    step('fields', ids.status && ids.details && ids.shelf && ids.also);
    const lineId = await makeAlso(env, ids, { key: 'soard-rehearsal-line', jobId: SANDBOX_JOB_ID, name: 'Rehearsal: Shower System', qty: 1, cents: 2500, kid: 'the sandbox' }, { fetchImpl, now });
    const again = await makeAlso(env, ids, { key: 'soard-rehearsal-line', jobId: SANDBOX_JOB_ID, name: 'Rehearsal: Shower System', qty: 1, cents: 2500 }, { fetchImpl, now });
    step('a line made once though asked twice', lineId && lineId === again);
    await env.DB.prepare("DELETE FROM kid_jt_lines WHERE job_id = ? AND item_id = ?").bind(SANDBOX_JOB_ID, lineId).run();
    const line = (items) => ({ jobId: SANDBOX_JOB_ID, itemId: lineId, items });
    const valve = fake('Rehearsal valve', { qty: 2, got: 2, status: 'here', order: ordered, shelf: '3', receipts: [{ kind: 'receive', units: 2, at: now }] });
    const shower = (got) => fake('Rehearsal hand shower', { qty: 2, got, status: got >= 2 ? 'here' : got ? 'partly' : 'ordered', order: ordered, shelf: got ? '3' : null, receipts: got ? [{ kind: 'receive', units: got, at: now }] : [] });
    const first = await writeLine(env, ids, line([valve, shower(0)]), { fetchImpl, now });
    const read1 = await readLine(env, ids, lineId, { fetchImpl });
    step('written', first.wrote && read1?.status === 'Ordered' && read1.shelf === 'Shelf 3' && /Rehearsal valve \(2\): ordered/.test(read1.details || ''), JSON.stringify(read1));
    const second = await writeLine(env, ids, line([valve, shower(0)]), { fetchImpl, now });
    step('nothing new, nothing written', !second.wrote);
    // A person sets the status by hand in JobTread and types a note
    await pave(env.JOBTREAD_GRANT_KEY, { updateCostItem: { $: { id: lineId, customFieldValues: { [ids.status]: 'At the house', [ids.details]: `${read1.details}\nAsked the store to rush it` } } } }, fetchImpl);
    // One of the two showers comes in: still partly received, so the hand-set status stands, and the note stays
    await writeLine(env, ids, line([valve, shower(1)]), { fetchImpl, now });
    const read3 = await readLine(env, ids, lineId, { fetchImpl });
    step('a hand edit kept', read3?.status === 'At the house' && /\nNote: Asked the store to rush it$/.test(read3.details || '') && /hand shower \(2\): ordered .*; 1 of 2 here/.test(read3.details || ''), JSON.stringify(read3));
    // The other comes in: the line's status moves, so the site's wins; the note still stays
    const fourth = await writeLine(env, ids, line([valve, shower(2)]), { fetchImpl, now });
    const read4 = await readLine(env, ids, lineId, { fetchImpl });
    step('news after a hand edit', fourth.wrote && read4?.status === 'At the Office' && /\nNote: Asked the store to rush it$/.test(read4.details || '') && /all 2 here/.test(read4.details || ''), JSON.stringify(read4));
    // Back to the start for the next rehearsal
    await pave(env.JOBTREAD_GRANT_KEY, { updateCostItem: { $: { id: lineId, customFieldValues: { [ids.status]: null, [ids.details]: null, [ids.shelf]: null } } } }, fetchImpl);
    await env.DB.prepare("DELETE FROM kid_jt_lines WHERE job_id = ? AND item_id = ?").bind(SANDBOX_JOB_ID, lineId).run();
    step('put back', true);
    // An allowance ($500 Decor): a thing bought on it gets its own line right after it and the allowance goes down by
    // it; moved to Also bought, the line moves and the allowance is back; moved next to it again (as the site moves a line
    // already on a budget), it's there; taken off, nothing is left behind. A rehearsal cut off half-way is cleaned up first
    const allowId = await rehearsalAllowance(env, { fetchImpl });
    const thing = { key: 'soard-rehearsal-allowance-buy', jobId: SANDBOX_JOB_ID, name: 'Rehearsal wall print', qty: 2, cents: 2250, kid: 'the sandbox', allowItemId: allowId, allowLine: 'Rehearsal Decor' };
    const leftover = (await pave(env.JOBTREAD_GRANT_KEY, { job: { $: { id: SANDBOX_JOB_ID }, costItems: { $: { size: 2, where: ['globalId', '=', thing.key] }, nodes: { id: {} } } } }, fetchImpl))?.job?.costItems?.nodes?.[0]?.id;
    if (leftover) await pave(env.JOBTREAD_GRANT_KEY, { deleteCostItem: { $: { id: leftover } } }, fetchImpl);
    const clear = async () => {
      await env.DB.prepare('DELETE FROM kid_also WHERE key = ?').bind(thing.key).run();
      await env.DB.prepare('DELETE FROM kid_allowances WHERE job_id = ? AND item_id = ?').bind(SANDBOX_JOB_ID, allowId).run();
    };
    await clear();
    const rowId = await makeAlso(env, ids, thing, { fetchImpl, now });
    const [row, allow] = await Promise.all([allowanceOf(env, rowId, { fetchImpl }), allowanceOf(env, allowId, { fetchImpl })]);
    step('a line next to its allowance', row?.groupId && row.groupId === allow?.groupId && row.name === 'Rehearsal Decor: Rehearsal wall print' && row.unitCost === 22.5 && row.quantity === 2, JSON.stringify(row));
    await settleAllowance(env, SANDBOX_JOB_ID, allowId, 4500, { fetchImpl, now });
    const down = await allowanceOf(env, allowId, { fetchImpl });
    step('the allowance down by it', down?.unitCost === 455 && down.unitPrice === 455, JSON.stringify(down));
    const rec = () => readRecord(env.DB).then((r) => r.also.find((a) => a.key === thing.key));
    await keepAlso(env, ids, { ...thing, allowItemId: null, allowLine: null }, await rec(), { fetchImpl });
    await settleAllowance(env, SANDBOX_JOB_ID, allowId, 0, { fetchImpl, now });
    const [moved, back] = await Promise.all([allowanceOf(env, rowId, { fetchImpl }), allowanceOf(env, allowId, { fetchImpl })]);
    step('moved to Also bought, the allowance back', moved?.groupId && moved.groupId !== allow.groupId && moved.name === 'Rehearsal wall print' && back?.unitCost === 500, JSON.stringify({ moved, back }));
    await keepAlso(env, ids, thing, await rec(), { fetchImpl });
    const nextTo = await allowanceOf(env, rowId, { fetchImpl });
    step('moved next to its allowance again', nextTo?.groupId === allow.groupId && nextTo.name === 'Rehearsal Decor: Rehearsal wall print', JSON.stringify(nextTo));
    await retireAlso(env, { ...(await rec()), costItemId: rowId }, { fetchImpl, now });
    await clear();
    step('the allowance put back', true);
    // A real makeover's allowance, only read (nothing written): how its group is set up, for the record
    const real = (await checkinView(env, { photos: false })).kids.flatMap((k) => (k.allowances || []).map((a) => a.itemId))[0];
    if (real) { const a = await allowanceOf(env, real, { fetchImpl }).catch(() => null); step('a real allowance’s group', true, JSON.stringify(a && { group: a.groupName, picks: a.picks, simple: a.simple, parent: Boolean(a.parentId), selected: a.selected, quantity: a.quantity })); }
    return { v: REHEARSAL_V, ok: true, at: now, steps };
  } catch (err) {
    return { v: REHEARSAL_V, ok: false, at: now, steps, error: err.message };
  }
}

/** The sandbox's own $500 Decor allowance (made once, set back to $500 each rehearsal) → its line id */
async function rehearsalAllowance(env, { fetchImpl }) {
  const look = await pave(env.JOBTREAD_GRANT_KEY, {
    job: { $: { id: SANDBOX_JOB_ID }, costItems: { $: { size: 2, where: ['globalId', '=', 'soard-rehearsal-allowance'] }, nodes: { id: {} } } },
  }, fetchImpl);
  const found = look?.job?.costItems?.nodes?.[0]?.id;
  if (found) {
    await pave(env.JOBTREAD_GRANT_KEY, { updateCostItem: { $: { id: found, quantity: 1, unitCost: 500, unitPrice: 500 } } }, fetchImpl);
    return found;
  }
  const [costGroupId, codes] = await Promise.all([groupNamed(env, SANDBOX_JOB_ID, 'Rehearsal Selection & Allowance', 'The website’s rehearsal: an allowance and a thing bought on it', { fetchImpl }), alsoCodes(env, SANDBOX_JOB_ID, { fetchImpl })]);
  const made = await pave(env.JOBTREAD_GRANT_KEY, {
    createCostItem: { $: { jobId: SANDBOX_JOB_ID, costGroupId, name: 'Rehearsal Decor', globalId: 'soard-rehearsal-allowance', isSelected: true, quantity: 1, unitCost: 500, unitPrice: 500, description: 'Books, wall art, shelves, decorative objects (the website’s rehearsal)', ...codes }, createdCostItem: { id: {} } },
  }, fetchImpl);
  const id = made?.createCostItem?.createdCostItem?.id;
  if (!id) throw new Error('JobTread didn’t make the rehearsal allowance');
  return id;
}

// ─── The runs ───────────────────────────────────────────────────────

/** Is JobTread being written? 'dry' lists what it would write, 'on' writes; the rehearsal comes first either way */
// 'on' since Nov 10 2026: the rehearsal passed every step against JobTread, and each kid's planned lines were checked
export const MODE = 'on';

/** One pass over the makeovers: Also bought lines made, then each changed line written. → { wrote, made, planned, left, errors } */
export async function writeKids(env, { fetchImpl = fetch, now = new Date().toISOString(), jobId = null, mode = MODE, budget = WRITES_A_RUN, sort = true, settle = true } = {}) {
  await ensure(env.DB);
  const started = Date.now();
  const out = { wrote: 0, made: 0, planned: 0, left: 0, errors: [] };
  const ids = mode === 'on' ? await fieldIds(env, { fetchImpl }) : null;
  // Strict: a failed read stops the run; it never looks like a list with nothing ordered
  let view = await checkinView(env, { photos: false, strict: true });
  let kids = view.kids.filter((k) => !jobId || k.jobId === jobId);
  const open = new Set(view.open || []);
  const late = () => budget <= 0 || Date.now() - started > RUN_MS;
  // Lines for what's bought on top of a kid's selections first: a line can't be written before JobTread has it
  if (mode === 'on') {
    const unread = new Set(view.unread || []);
    // Each one sorted onto one of the kid's allowances (or none) before its line is made, so it's made in its place
    // (Not while someone waits on a check-in: sorting can take the AI 25 seconds, so the heartbeat does it)
    // A kid with lines still unread: only what was typed in (an order may yet fit one of those lines)
    const sortable = (k, it) => it.also?.pending && (!unread.has(k.jobId) || it.also.typed);
    const toSort = sort ? kids.filter((k) => k.items.some((i) => sortable(k, i))) : [];
    // Each kid's allowance lines kept, so they stay theirs whoever else's budget changes
    // Only a line that's an allowance and nothing else (alike on every makeover) is kept as one: a Selection & Allowance
    // line with the designer's picks in it stays theirs to match orders to
    if (mode === 'on') for (const k of kids) for (const a of (k.allowances || []).filter((x) => x.template)) await env.DB.prepare('INSERT OR IGNORE INTO kid_allow_lines (job_id, item_id, at) VALUES (?, ?, ?)').bind(k.jobId, a.itemId, now).run();
    if (toSort.length && !late()) {
      const sorted = await sortAllowances(env, toSort, { now, only: sortable, until: started + RUN_MS });
      if (sorted.waiting) out.sortWaiting = sorted.waiting;
      if (sorted.sorted) {
        out.sorted = sorted.sorted;
        view = await checkinView(env, { photos: false, strict: true });
        kids = view.kids.filter((k) => !jobId || k.jobId === jobId);
      }
    }
    const thingOf = (k, it) => ({ key: it.also.key, jobId: k.jobId, name: it.name, qty: it.qty, cents: it.order?.cents ?? it.cents, donated: it.source === 'donated', store: it.order?.store, orderNumber: it.order?.orderNumber, kid: k.short, allowItemId: it.also.allowItemId || null, allowLine: it.also.allowLine || null });
    let changed = false;
    for (const k of kids) {
      for (const it of k.items.filter((i) => i.also && !i.also.costItemId)) {
        // Some of the kid's lines aren't read yet: it may belong on one of them, so nothing is added to the budget yet
        if (unread.has(k.jobId) && !it.also.typed) { out.waiting = (out.waiting || 0) + 1; continue; }
        // Not sorted yet: no line until it's known where it goes. Deleted in JobTread by a person: stays off
        if (it.also.pending) { out.waiting = (out.waiting || 0) + 1; continue; }
        if (it.also.offByHand) continue;
        if (late()) { out.left++; continue; }
        try {
          const id = await makeAlso(env, ids, thingOf(k, it), { fetchImpl, now });
          if (id) { out.made++; changed = true; } else out.left++;
          budget--;
        } catch (err) {
          out.errors.push(`${k.short}, ${it.name}: ${err.message}`);
          await env.DB.prepare('UPDATE kid_also SET error = ? WHERE key = ?').bind(err.message.slice(0, 300), it.also.key).run().catch(() => {});
        }
      }
    }
    // Lines on the budget already: moved when where they go changed (a person's answer, or sorted again), repriced when the order's price did
    const record = await readRecord(env.DB);
    for (const k of kids) {
      for (const it of k.items.filter((i) => i.also?.costItemId && !i.also.pending)) {
        const row = record.also.find((a) => a.key === it.also.key && !a.retiredAt);
        if (!row) continue;
        if (late()) { out.left++; continue; }
        try {
          if (await keepAlso(env, ids, thingOf(k, it), row, { fetchImpl })) { out.kept = (out.kept || 0) + 1; changed = true; budget--; }
        } catch (err) {
          out.errors.push(`${k.short}, ${it.name}: ${err.message}`);
          await env.DB.prepare('UPDATE kid_also SET error = ? WHERE key = ?').bind(err.message.slice(0, 300), it.also.key).run().catch(() => {});
          budget--;
        }
      }
    }
    // Lines the site made that aren't any open kid's now come off their budget
    const wanted = new Set(view.kids.flatMap((k) => k.items.filter((i) => i.also).map((i) => i.also.key)));
    for (const a of record.also.filter((x) => x.costItemId && !x.retiredAt && open.has(x.jobId) && !wanted.has(x.key) && (!jobId || x.jobId === jobId))) {
      if (budget <= 0) { out.left++; continue; }
      try { await retireAlso(env, a, { fetchImpl, now }); out.retired = (out.retired || 0) + 1; changed = true; budget--; } catch (err) { out.errors.push(`${a.name}: ${err.message}`); }
    }
    if (changed) {
      view = await checkinView(env, { photos: false, strict: true });
      kids = view.kids.filter((k) => !jobId || k.jobId === jobId);
    }
    // Each allowance: its amount less what's bought on it now (its lines on the budget); written only when that changed,
    // and only by the heartbeat's run (one at a time), never by a check-in's
    const spent = new Map();
    for (const k of kids) {
      for (const it of k.items) {
        const a = it.also;
        if (!a?.allowItemId || !a.costItemId || a.pending) continue;
        const key = `${k.jobId}|${a.allowItemId}`;
        spent.set(key, (spent.get(key) || 0) + (it.source === 'donated' ? 0 : Math.round(it.order?.cents ?? it.cents ?? 0) * Math.max(1, it.qty || 1)));
      }
    }
    const held = new Map((await env.DB.prepare('SELECT job_id, item_id, spent_cents FROM kid_allowances').all()).results.map((r) => [`${r.job_id}|${r.item_id}`, r.spent_cents || 0]));
    const allowanceKeys = [...new Set([...spent.keys(), ...[...held.keys()].filter((k) => open.has(k.split('|')[0]) && kids.some((x) => x.jobId === k.split('|')[0]))])];
    for (const key of settle ? allowanceKeys : []) {
      const cents = spent.get(key) || 0;
      // Nothing taken off it yet and nothing bought on it, or the same as last written: nothing to write
      if ((held.has(key) ? held.get(key) : 0) === cents) continue;
      if (late()) { out.left++; continue; }
      const [kidJob, itemId] = key.split('|');
      try {
        const r = await settleAllowance(env, kidJob, itemId, cents, { fetchImpl, now });
        if (r.wrote) { out.allowances = (out.allowances || 0) + 1; budget--; }
      } catch (err) {
        out.errors.push(`${kids.find((x) => x.jobId === kidJob)?.short || kidJob}, an allowance: ${err.message}`);
        budget--;
      }
    }
  }
  out.alsoWaiting = linesOf(view).filter((l) => (!jobId || l.jobId === jobId) && String(l.itemId).startsWith('pending:')).length;
  for (const line of linesOf(view).filter((l) => (!jobId || l.jobId === jobId) && !String(l.itemId).startsWith('pending:'))) {
    if (budget <= 0 || Date.now() - started > RUN_MS) { out.left++; continue; }
    try {
      const r = await writeLine(env, ids, line, { fetchImpl, now, dry: mode !== 'on' });
      if (r.wrote) { out.wrote++; budget--; }
      if (r.planned) out.planned++;
    } catch (err) {
      out.errors.push(`${line.kid}, ${line.items[0]?.line || line.itemId}: ${err.message}`);
      await env.DB.prepare('INSERT INTO kid_jt_lines (job_id, item_id, error, wrote_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, item_id) DO UPDATE SET error = excluded.error')
        .bind(line.jobId, line.itemId, err.message.slice(0, 300), now).run().catch(() => {});
      budget--;
    }
  }
  return out;
}

/** Shelves of makeovers that are finished (closed in JobTread, or Closed Done) come free; a paused one keeps its shelf */
export async function freeShelves(env, view, { fetchImpl = fetch } = {}) {
  const open = new Set(view.kids.map((k) => k.jobId));
  const held = ((await env.DB.prepare('SELECT DISTINCT job_id FROM kid_shelves').all()).results || []).map((r) => r.job_id).filter((id) => !open.has(id));
  const freed = [];
  for (const id of held) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, { job: { $: { id }, id: {}, closedOn: {}, customFieldValues: { $: { size: 5, where: [['customField', 'id'], '=', FIELD_JOB_STATUS] }, nodes: { value: {} } } } }, fetchImpl);
    const status = data?.job?.customFieldValues?.nodes?.[0]?.value;
    if (data?.job && (data.job.closedOn || String(status || '').trim() === 'Closed Done')) {
      await env.DB.prepare('DELETE FROM kid_shelves WHERE job_id = ?').bind(id).run();
      freed.push(id);
    }
  }
  return freed;
}

/** For the check-in page after a tap: that kid's lines written now (a few seconds at most), so the page can say it's in JobTread */
export async function writeKidNow(env, jobId, { fetchImpl = fetch } = {}) {
  if (!env.JOBTREAD_GRANT_KEY) return 'off';
  const st = await readState(env.DB, 'jt');
  if (MODE !== 'on' || !(st.rehearsal?.ok && st.rehearsal.v === REHEARSAL_V)) return 'off';
  try {
    const r = await writeKids(env, { fetchImpl, jobId, budget: 6, sort: false, settle: false });
    // Something still waiting (to be sorted, or a line not read yet) isn't in JobTread yet: never said it is
    return r.errors.length || r.left || r.waiting ? 'later' : 'written';
  } catch (err) {
    console.error('[kid-jt] now', err.message);
    return 'later';
  }
}

/** On the heartbeat: every 2 minutes (every minute while lines are waiting). Never throws */
export async function maybeWriteKidItems(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!env?.DB || !env.JOBTREAD_GRANT_KEY) return null;
  let st = {};
  try {
    await ensure(env.DB);
    st = await readState(env.DB, 'jt');
    const due = st.behind ? 60 * 1000 : EVERY_MS;
    if (!force && (now - (st.lastRunAt || 0) < due || (st.runningUntil || 0) > now)) return null;
    Object.assign(st, { lastRunAt: now, runningUntil: now + 60000 });
    await writeState(env.DB, 'jt', st);
    const iso = new Date(now).toISOString();
    // A new rehearsal version runs at once; a failed one is tried again every 30 minutes
    const passed = st.rehearsal?.v === REHEARSAL_V && st.rehearsal.ok;
    if (!passed && (st.rehearsal?.v !== REHEARSAL_V || now - Date.parse(st.rehearsal?.at || '1970-01-01') > 30 * 60 * 1000)) {
      st.rehearsal = await rehearse(env, { fetchImpl, now: iso });
    }
    const ready = st.rehearsal?.v === REHEARSAL_V && st.rehearsal.ok;
    const mode = ready ? MODE : 'dry';
    const r = await writeKids(env, { fetchImpl, now: iso, mode });
    if (mode === 'on' && !st.since) {
      // The day JobTread writing began: orders before it read "Ordered before this started" on the page
      st.since = iso;
      await writeState(env.DB, 'live', { on: true, since: iso });
    }
    if (now - (st.shelvesAt || 0) > 60 * 60 * 1000) {
      st.shelvesAt = now;
      await freeShelves(env, await checkinView(env, { photos: false, strict: true }), { fetchImpl }).catch((err) => r.errors.push(`shelves: ${err.message}`));
    }
    // Every line written with the four statuses (none left behind, no error): the old options go from the field
    // (JobTread refusing: tried again a day later, not every run)
    if (mode === 'on' && !st.oldStatusesGone && !(r.left > 0) && !r.errors.length && now - (st.letGoFailedAt || 0) > 86400e3) {
      st.oldStatusesGone = await letGoOldStatuses(env, { fetchImpl }).then((gone) => gone || null).catch((err) => { st.letGoFailedAt = now; r.errors.push(`statuses: ${err.message}`); return null; });
    }
    Object.assign(st, { mode, behind: r.left > 0, last: { ...r, errors: r.errors.slice(0, 5) }, error: r.errors.length ? r.errors.slice(0, 3).join(' · ').slice(0, 500) : null, runningUntil: 0 });
    await writeState(env.DB, 'jt', st);
    return st;
  } catch (err) {
    console.error('[kid-jt]', err.message);
    await writeState(env.DB, 'jt', { ...st, error: err.message, runningUntil: 0 }).catch(() => {});
    return null;
  }
}

/** For Automations and the check-in page: is JobTread being written, and how it went */
export async function kidJtStatus(env) {
  if (!env?.DB) return null;
  const st = await readState(env.DB, 'jt');
  return {
    jobtread: Boolean(env.JOBTREAD_GRANT_KEY), mode: st.mode || MODE, rehearsal: st.rehearsal ? { ok: st.rehearsal.ok, at: st.rehearsal.at, error: st.rehearsal.error || null, steps: st.rehearsal.steps } : null,
    lastRunAt: st.lastRunAt ? new Date(st.lastRunAt).toISOString() : null, last: st.last || null, error: st.error || null, since: st.since || null,
  };
}
