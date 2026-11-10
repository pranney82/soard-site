/**
 * Kid items → JobTread: each selection line says what's ordered and what's here
 * ===========================================================================
 * Peter, Nov 9 2026: "i really just care about ordering and updating in JT, then
 * receiving and updating in JT". Every open makeover's budget lines that SOARD
 * buys or receives get three cost item fields (hidden from families):
 *   Order status   Not ordered · Partly ordered · Ordered · Partly received · Received
 *   Order details  each part: when, where, order number, price; how many came, when, which shelf
 *   Shelf          where it is at the Office ("Shelf 7", "Floor")
 * and everything bought on top of the selections ("Also bought") is added to the
 * kid's budget at what was paid, chosen, with Also bought ticked, in an "Also
 * bought" group. The page and JobTread are drawn from one view
 * (./_kid-checkin.js), so they can't disagree.
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
 * edit kept, an Also bought line made once though asked twice. Its result is kept
 * in kid_items_state 'rehearsal'; makeovers are written only after it passed.
 */

import { pave, SOARD_ORG_ID, FIELD_JOB_STATUS } from './_reveals.js';
import { SANDBOX_JOB_ID } from './_reveal-nudges.js';
import { checkinView } from './_kid-checkin.js';
import { ensureRecord, readState, writeState, readRecord, shelfName, SHELVES } from './_kid-record.js';
import { costCodes } from './_job-ledger.js';

export const STATUSES = ['Not ordered', 'Partly ordered', 'Ordered', 'Partly received', 'Received'];
export const FIELDS = {
  status: { name: 'Order status', type: 'option', options: STATUSES, maxValuesAllowed: 1 },
  details: { name: 'Order details', type: 'text' },
  shelf: { name: 'Shelf', type: 'text' },
  also: { name: 'Also bought', type: 'boolean' },
};
export const ALSO_GROUP = 'Also bought';
export const REHEARSAL_V = 2; // 2: the cost code JobTread requires on a new line (Nov 10 2026)
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
  const last = got[got.length - 1];
  if (it.status === 'house') bits.push('went to the house, not the Office');
  else if (it.status === 'here') bits.push(`${it.qty > 1 ? `all ${it.qty} here` : 'here'} ${day(last?.at)}${it.shelf ? `, ${shelfName(it.shelf)}` : ''}`);
  else if (it.status === 'partly') bits.push(`${it.got} of ${it.qty} here ${day(last?.at)}${it.shelf ? `, ${shelfName(it.shelf)}` : ''}`);
  else if (!bits.length) bits.push('not ordered yet');
  return `${it.qty > 1 ? `${it.name} (${it.qty})` : it.name}: ${bits.join('; ')}`;
}

/** A line's status from its parts; an allowance (decor) line is never complete, so it's only ever "Partly" */
export function lineStatus(items, { allowance = false } = {}) {
  if (!items.length) return null;
  const done = items.filter((i) => i.status === 'here' || i.status === 'house').length;
  const some = items.filter((i) => i.status === 'partly' || i.status === 'here' || i.status === 'house').length;
  const coming = items.filter((i) => i.order || i.source === 'donated' || i.also || i.status !== 'not').length;
  if (allowance) return some ? 'Partly received' : coming ? 'Partly ordered' : null;
  if (done === items.length) return 'Received';
  if (some) return 'Partly received';
  if (coming === items.length) return 'Ordered';
  return coming ? 'Partly ordered' : 'Not ordered';
}

/** What a line's three fields should say → { status, details, shelf } */
export function lineValues(items, { allowance = false } = {}) {
  const shelves = [...new Set(items.filter((i) => i.shelf && (i.status === 'here' || i.status === 'partly')).map((i) => i.shelf))]
    .sort((a, b) => SHELVES.indexOf(a) - SHELVES.indexOf(b));
  let details = items.map(partLine).join('\n');
  if (details.length > DETAILS_MAX) details = `${details.slice(0, DETAILS_MAX - 1)}…`;
  return { status: lineStatus(items, { allowance }), details, shelf: shelves.length ? shelves.map(shelfName).join(', ') : null };
}

/** Each JobTread line the site writes, from the view → [{ jobId, kid, itemId, also, allowance, items }] */
export function linesOf(view) {
  const out = [];
  for (const k of view.kids) {
    const byLine = new Map();
    for (const it of k.items) {
      if (it.gone) continue;
      const id = it.also ? it.also.costItemId || `pending:${it.also.key}` : it.itemId;
      const l = byLine.get(id) || { jobId: k.jobId, kid: k.short, itemId: id, also: it.also || null, allowance: Boolean(it.allowance), items: [] };
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
  const h = { ...hand };
  // JobTread's status isn't what the site last wrote (or there was one before the site's first write): a person set
  // it. It stands while the site's own status stays where it was then, and goes when the line has news
  if (now?.status != null && now.status !== values.status && now.status !== (last ? last.status : undefined)) {
    h.status = { value: now.status, basis: last ? last.status : values.status };
  }
  if (h.status && h.status.basis !== values.status) delete h.status;
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
    if (found) { ids[k] = found.id; continue; }
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
  if (last && same(withHand(computed, null, null, parse(row?.hand, {})).values, last)) return { wrote: false, values: last };
  if (dry) {
    await env.DB.prepare('INSERT INTO kid_jt_lines (job_id, item_id, kind, planned, wrote_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, item_id) DO UPDATE SET planned = excluded.planned')
      .bind(line.jobId, line.itemId, line.also ? 'also' : 'line', JSON.stringify(computed), now).run();
    return { wrote: false, planned: computed };
  }
  const current = await readLine(env, ids, line.itemId, { fetchImpl });
  if (!current) {
    await env.DB.prepare('INSERT INTO kid_jt_lines (job_id, item_id, kind, error, wrote_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, item_id) DO UPDATE SET error = excluded.error')
      .bind(line.jobId, line.itemId, line.also ? 'also' : 'line', 'The line is gone from JobTread', now).run();
    return { wrote: false, gone: true };
  }
  const { values, hand } = withHand(computed, last, current, parse(row?.hand, {}));
  let wrote = false;
  if (!same(values, current)) {
    await pave(env.JOBTREAD_GRANT_KEY, {
      updateCostItem: { $: { id: line.itemId, customFieldValues: { [ids.status]: values.status, [ids.details]: values.details || null, [ids.shelf]: values.shelf } }, costItem: { id: {} } },
    }, fetchImpl);
    wrote = true;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO kid_jt_lines (job_id, item_id, kind, wrote, hand, wrote_at, error) VALUES (?, ?, ?, ?, ?, ?, NULL)')
    .bind(line.jobId, line.itemId, line.also ? 'also' : 'line', JSON.stringify(values), JSON.stringify(hand), now).run();
  return { wrote, values };
}

/** The job's "Also bought" budget group, made the first time */
async function alsoGroup(env, jobId, { fetchImpl }) {
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    job: { $: { id: jobId }, costGroups: { $: { size: 5, where: { and: [['name', '=', ALSO_GROUP], [['document', 'id'], '=', null]] } }, nodes: { id: {} } } },
  }, fetchImpl);
  const found = data?.job?.costGroups?.nodes?.[0]?.id;
  if (found) return found;
  const made = await pave(env.JOBTREAD_GRANT_KEY, { createCostGroup: { $: { jobId, name: ALSO_GROUP, description: 'Bought for the kid on top of the selections (added by the website at check-in and from order emails)' }, createdCostGroup: { id: {} } } }, fetchImpl);
  const id = made?.createCostGroup?.createdCostGroup?.id;
  if (!id) throw new Error('JobTread didn’t make the Also bought group');
  return id;
}

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
    _types = { env, costTypeId: types.find((t) => /material/i.test(t.name))?.id || null, codes };
  }
  const job = await pave(env.JOBTREAD_GRANT_KEY, {
    job: { $: { id: jobId }, costItems: { $: { size: 50, where: [['document', 'id'], '=', null] }, nodes: { costCode: { id: {} }, costType: { name: {} }, isSelected: {} } } },
  }, fetchImpl).catch(() => null);
  const count = new Map();
  for (const c of job?.job?.costItems?.nodes || []) {
    if (!c.costCode?.id || /labor|subcontract/i.test(c.costType?.name || '')) continue;
    count.set(c.costCode.id, (count.get(c.costCode.id) || 0) + (c.isSelected ? 2 : 1));
  }
  const mostUsed = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const { codes } = _types;
  return {
    costTypeId: _types.costTypeId,
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
  await DB.prepare('INSERT OR IGNORE INTO kid_also (key, job_id, name, cents, donated, store, order_number, typed, at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .bind(thing.key, thing.jobId, String(thing.name).slice(0, 250), thing.cents || null, thing.donated ? 1 : 0, thing.store || null, thing.orderNumber || null, now).run();
  // Claimed for a minute before JobTread is asked: a check-in's write and the heartbeat's can't both make it
  const ms = Date.parse(now) || Date.now();
  const claim = await DB.prepare('UPDATE kid_also SET claim_until = ? WHERE key = ? AND cost_item_id IS NULL AND (claim_until IS NULL OR claim_until < ?)').bind(ms + 60000, thing.key, ms).run();
  if (!claim.meta?.changes) return (await DB.prepare('SELECT cost_item_id FROM kid_also WHERE key = ?').bind(thing.key).first())?.cost_item_id || null;
  try {
    return await makeClaimed(env, ids, thing, { fetchImpl, now });
  } finally {
    await DB.prepare('UPDATE kid_also SET claim_until = NULL WHERE key = ?').bind(thing.key).run().catch(() => {});
  }
}

async function makeClaimed(env, ids, thing, { fetchImpl, now }) {
  const look = await pave(env.JOBTREAD_GRANT_KEY, {
    job: { $: { id: thing.jobId }, costItems: { $: { size: 2, where: ['globalId', '=', thing.key] }, nodes: { id: {} } } },
  }, fetchImpl);
  let id = look?.job?.costItems?.nodes?.[0]?.id || null;
  if (!id) {
    const [groupId, codes] = await Promise.all([alsoGroup(env, thing.jobId, { fetchImpl }), alsoCodes(env, thing.jobId, { fetchImpl })]);
    if (!codes.costCodeId) throw new Error('JobTread has no cost code to put it under');
    const qty = Math.max(1, thing.qty || 1);
    const unit = thing.donated || !thing.cents ? 0 : Math.round(thing.cents) / 100;
    const where = [thing.store, thing.orderNumber ? `order ${thing.orderNumber}` : null].filter(Boolean).join(', ');
    const made = await pave(env.JOBTREAD_GRANT_KEY, {
      createCostItem: {
        $: {
          jobId: thing.jobId, costGroupId: groupId, name: String(thing.name).slice(0, 250), globalId: thing.key, isSelected: true, quantity: qty, unitCost: unit, unitPrice: unit,
          ...(codes.costTypeId ? { costTypeId: codes.costTypeId } : {}), ...(codes.costCodeId ? { costCodeId: codes.costCodeId } : {}),
          description: [`Bought for ${thing.kid || 'the kid'} on top of the selections${where ? ` (${where})` : ''}.`, thing.donated ? 'Donated.' : !thing.cents ? 'No price given yet.' : null].filter(Boolean).join(' '),
          customFieldValues: { [ids.also]: true },
        },
        createdCostItem: { id: {} },
      },
    }, fetchImpl);
    id = made?.createCostItem?.createdCostItem?.id || null;
    if (!id) throw new Error(`JobTread didn’t add ${thing.name}`);
  }
  await env.DB.prepare('UPDATE kid_also SET cost_item_id = ?, made_at = ?, error = NULL, retired_at = NULL WHERE key = ?').bind(id, now, thing.key).run();
  return id;
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
      updateCostItem: { $: { id: a.costItemId, unitCost: 0, unitPrice: 0, description: 'Not this kid’s any more (moved, cancelled or not a kid’s at check-in), so it costs nothing here.' }, costItem: { id: {} } },
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
    step('written', first.wrote && read1?.status === 'Partly received' && read1.shelf === 'Shelf 3' && /Rehearsal valve \(2\): ordered/.test(read1.details || ''), JSON.stringify(read1));
    const second = await writeLine(env, ids, line([valve, shower(0)]), { fetchImpl, now });
    step('nothing new, nothing written', !second.wrote);
    // A person sets the status by hand in JobTread and types a note
    await pave(env.JOBTREAD_GRANT_KEY, { updateCostItem: { $: { id: lineId, customFieldValues: { [ids.status]: 'Ordered', [ids.details]: `${read1.details}\nAsked the store to rush it` } }, costItem: { id: {} } } }, fetchImpl);
    // One of the two showers comes in: still partly received, so the hand-set status stands, and the note stays
    await writeLine(env, ids, line([valve, shower(1)]), { fetchImpl, now });
    const read3 = await readLine(env, ids, lineId, { fetchImpl });
    step('a hand edit kept', read3?.status === 'Ordered' && /\nNote: Asked the store to rush it$/.test(read3.details || '') && /hand shower \(2\): ordered .*; 1 of 2 here/.test(read3.details || ''), JSON.stringify(read3));
    // The other comes in: the line's status moves, so the site's wins; the note still stays
    const fourth = await writeLine(env, ids, line([valve, shower(2)]), { fetchImpl, now });
    const read4 = await readLine(env, ids, lineId, { fetchImpl });
    step('news after a hand edit', fourth.wrote && read4?.status === 'Received' && /\nNote: Asked the store to rush it$/.test(read4.details || '') && /all 2 here/.test(read4.details || ''), JSON.stringify(read4));
    // Back to the start for the next rehearsal
    await pave(env.JOBTREAD_GRANT_KEY, { updateCostItem: { $: { id: lineId, customFieldValues: { [ids.status]: null, [ids.details]: null, [ids.shelf]: null } }, costItem: { id: {} } } }, fetchImpl);
    await env.DB.prepare("DELETE FROM kid_jt_lines WHERE job_id = ? AND item_id = ?").bind(SANDBOX_JOB_ID, lineId).run();
    step('put back', true);
    return { v: REHEARSAL_V, ok: true, at: now, steps };
  } catch (err) {
    return { v: REHEARSAL_V, ok: false, at: now, steps, error: err.message };
  }
}

// ─── The runs ───────────────────────────────────────────────────────

/** Is JobTread being written? 'dry' lists what it would write, 'on' writes; the rehearsal comes first either way */
export const MODE = 'dry';

/** One pass over the makeovers: Also bought lines made, then each changed line written. → { wrote, made, planned, left, errors } */
export async function writeKids(env, { fetchImpl = fetch, now = new Date().toISOString(), jobId = null, mode = MODE, budget = WRITES_A_RUN } = {}) {
  await ensure(env.DB);
  const started = Date.now();
  const out = { wrote: 0, made: 0, planned: 0, left: 0, errors: [] };
  const ids = mode === 'on' ? await fieldIds(env, { fetchImpl }) : null;
  // Strict: a failed read stops the run; it never looks like a list with nothing ordered
  let view = await checkinView(env, { photos: false, strict: true });
  const kids = view.kids.filter((k) => !jobId || k.jobId === jobId);
  // Also bought lines first: a line can't be written before JobTread has it
  if (mode === 'on') {
    let madeAny = false;
    const unread = new Set(view.unread || []);
    for (const k of kids) {
      for (const it of k.items.filter((i) => i.also && !i.also.costItemId)) {
        // Some of the kid's lines aren't read yet: it may belong on one of them, so nothing is added to the budget yet
        if (unread.has(k.jobId) && !it.also.typed) { out.waiting = (out.waiting || 0) + 1; continue; }
        if (budget <= 0 || Date.now() - started > RUN_MS) { out.left++; continue; }
        try {
          const id = await makeAlso(env, ids, { key: it.also.key, jobId: k.jobId, name: it.name, qty: it.qty, cents: it.order?.cents ?? it.cents, donated: it.source === 'donated', store: it.order?.store, orderNumber: it.order?.orderNumber, kid: k.short }, { fetchImpl, now });
          if (id) { out.made++; madeAny = true; } else out.left++;
          budget--;
        } catch (err) {
          out.errors.push(`${k.short}, ${it.name}: ${err.message}`);
          await env.DB.prepare('UPDATE kid_also SET error = ? WHERE key = ?').bind(err.message.slice(0, 300), it.also.key).run().catch(() => {});
        }
      }
    }
    // Lines the site made that aren't any open kid's now come off their budget
    const record = await readRecord(env.DB);
    const wanted = new Set(view.kids.flatMap((k) => k.items.filter((i) => i.also).map((i) => i.also.key)));
    const open = new Set(view.open || []);
    for (const a of record.also.filter((x) => x.costItemId && !x.retiredAt && open.has(x.jobId) && !wanted.has(x.key) && (!jobId || x.jobId === jobId))) {
      if (budget <= 0) { out.left++; continue; }
      try { await retireAlso(env, a, { fetchImpl, now }); out.retired = (out.retired || 0) + 1; budget--; } catch (err) { out.errors.push(`${a.name}: ${err.message}`); }
    }
    if (madeAny) view = await checkinView(env, { photos: false, strict: true });
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
    const r = await writeKids(env, { fetchImpl, jobId, budget: 6 });
    return r.errors.length || r.left ? 'later' : 'written';
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
