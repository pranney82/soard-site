/**
 * Kid items: the site's own record of what came in, whose it is, and where it sits
 * ===========================================================================
 * Everything a person does on the check-in page (/admin/checkin/) is kept here,
 * in D1, and never deleted: JobTread's lines are written from it
 * (./_kid-jt.js), and the page is drawn from it (./_kid-checkin.js).
 *
 *   kid_receipts   each check-in: a tap id (so a retry after a dropped
 *                  connection can't count it twice), the kid's line and part,
 *                  how many came, how many boxes (labels), the shelf, who, when.
 *                  "Not coming here" is a receipt of kind 'house'. Undo marks it
 *                  undone; nothing is removed.
 *   kid_decisions  a person's answer for an ordered item: this kid and line,
 *                  Also bought for this kid, not a kid's, or cancelled (the
 *                  "Needs a look" list and "Wrong kid").
 *   kid_also       things bought for a kid on top of the selections that only a
 *                  person typed in ("Something else"), and the JobTread line made
 *                  for every Also bought thing (by its key, JobTread's globalId).
 *   kid_allow_class  for a thing bought on top of a kid's selections, which of their allowances it's
 *                  bought under (or none: Also bought), as sorted by the site (./_kid-allow.js)
 *   kid_allowances   an allowance line's own amount before the site took its purchases off it, so the
 *                  amount it writes is always the original less what's bought, never less twice
 *   kid_shelves    which kid is on which shelf. A kid gets the next free shelf
 *                  at their first check-in and keeps it until their makeover is
 *                  finished (./_kid-jt.js frees it), never when it's paused.
 */

export const SHELF_COUNT = 28; // Peter, Nov 9 2026: "28 shelves"
export const FLOOR = 'Floor';
export const shelfName = (s) => (s === FLOOR ? 'Floor' : `Shelf ${s}`);
export const SHELVES = [...Array.from({ length: SHELF_COUNT }, (_, i) => String(i + 1)), FLOOR];
export const MAX_UNITS = 99;
export const MAX_BOXES = 20;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kid_receipts (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, job_id TEXT NOT NULL, item_id TEXT NOT NULL, part_key TEXT NOT NULL,
    name TEXT, line_name TEXT, units INTEGER NOT NULL DEFAULT 0, boxes INTEGER NOT NULL DEFAULT 0, shelf TEXT,
    by_email TEXT, at TEXT NOT NULL, undone_at TEXT, undone_by TEXT)`,
  'CREATE INDEX IF NOT EXISTS kid_receipts_job ON kid_receipts (job_id)',
  `CREATE TABLE IF NOT EXISTS kid_decisions (
    key TEXT PRIMARY KEY, order_key TEXT NOT NULL, item_name TEXT NOT NULL, decision TEXT NOT NULL, by_email TEXT, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kid_also (
    key TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT NOT NULL, cents INTEGER, donated INTEGER NOT NULL DEFAULT 0,
    store TEXT, order_number TEXT, typed INTEGER NOT NULL DEFAULT 0, cost_item_id TEXT, made_at TEXT, error TEXT,
    claim_until INTEGER, retired_at TEXT, by_email TEXT, at TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS kid_shelves (shelf TEXT PRIMARY KEY, job_id TEXT NOT NULL, at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS kid_items_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
  `CREATE TABLE IF NOT EXISTS kid_allow_class (
    key TEXT PRIMARY KEY, job_id TEXT NOT NULL, item_id TEXT, how TEXT, tries INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kid_allowances (
    job_id TEXT NOT NULL, item_id TEXT NOT NULL, quantity REAL, unit_cost REAL, unit_price REAL, spent_cents INTEGER NOT NULL DEFAULT 0,
    written_cost REAL, written_price REAL, at TEXT, PRIMARY KEY (job_id, item_id))`,
  // Each of a kid's allowance lines, once seen: it stays theirs when no other open makeover has the same words any more
  'CREATE TABLE IF NOT EXISTS kid_allow_lines (job_id TEXT NOT NULL, item_id TEXT NOT NULL, at TEXT, PRIMARY KEY (job_id, item_id))',
  // What a thing bought on top cost, by a person, when the store's emails don't say (Peter, Nov 11 2026: the Container
  // Store's drawers went on the budget with no price). The email's own price stands over it
  `CREATE TABLE IF NOT EXISTS kid_prices (
    key TEXT PRIMARY KEY, order_key TEXT NOT NULL, item_name TEXT NOT NULL, cents INTEGER NOT NULL, by_email TEXT, at TEXT NOT NULL)`,
];
// Added Nov 10 2026 with checking out: an "out" names the check-in whose label was scanned. Nov 11: printed_at, when
// the printer took a check-in's labels (a retry from the phone prints only what never reached it)
const RECEIPT_COLUMNS = ['ref TEXT', 'box INTEGER', 'printed_at TEXT'];
// Nov 11 2026: where a bought-on-top line sits (next to an allowance, or Also bought), and how many, for its cost
const ALSO_COLUMNS = ['allow_item_id TEXT', 'qty INTEGER', 'off_by_hand TEXT'];
// Nov 11 2026: the amount before a write (a write that never landed is told from a person's change) and why it's left alone
const ALLOWANCE_COLUMNS = ['prev_cost REAL', 'prev_price REAL', 'skip TEXT'];
const _ready = new WeakSet();
export async function ensureRecord(DB) {
  if (_ready.has(DB)) return;
  for (const s of SCHEMA) await DB.prepare(s).run();
  const have = new Set(((await DB.prepare('PRAGMA table_info(kid_receipts)').all()).results || []).map((c) => c.name));
  // Two requests at once can both see a column missing: the second one's "duplicate column" is fine
  const add = async (table, cols, have) => {
    for (const c of cols) {
      if (have.has(c.split(' ')[0])) continue;
      try { await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${c}`).run(); } catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
    }
  };
  await add('kid_receipts', RECEIPT_COLUMNS, have);
  await add('kid_also', ALSO_COLUMNS, new Set(((await DB.prepare('PRAGMA table_info(kid_also)').all()).results || []).map((c) => c.name)));
  await add('kid_allowances', ALLOWANCE_COLUMNS, new Set(((await DB.prepare('PRAGMA table_info(kid_allowances)').all()).results || []).map((c) => c.name)));
  // One live check-out per box: two phones confirming the same box at once can't both count it
  await DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS kid_receipts_out_box ON kid_receipts (ref, box) WHERE kind = 'out' AND undone_at IS NULL AND box IS NOT NULL").run();
  _ready.add(DB);
}

const parse = (s, fallback) => { try { return JSON.parse(s || ''); } catch { return fallback; } };
const all = async (DB, sql, ...binds) => ((await DB.prepare(sql).bind(...binds).all()).results || []);

/** A short, stable key for a thing (JobTread's globalId takes 100 characters; this is 14) */
export function keyOf(text) {
  let a = 2166136261, b = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a ^= c; a = Math.imul(a, 16777619); b = (Math.imul(b, 33) + c) | 0; }
  return (a >>> 0).toString(36).padStart(7, '0') + (b >>> 0).toString(36).padStart(7, '0');
}
export const decisionKey = (orderKey, itemName) => keyOf(`${orderKey}\u0001${String(itemName).toLowerCase()}`);
// The kid is in the key: moved to another kid (Wrong kid), it's another JobTread line on their budget
export const alsoKey = (orderKey, itemName, jobId) => `soard-also-${keyOf(`${jobId}\u0001${orderKey}\u0001${String(itemName).toLowerCase()}`)}`;

export async function readState(DB, key) {
  await ensureRecord(DB);
  const row = await DB.prepare('SELECT data FROM kid_items_state WHERE key = ?').bind(key).first();
  return parse(row?.data, {}) || {};
}
export async function writeState(DB, key, data) {
  await ensureRecord(DB);
  await DB.prepare('INSERT OR REPLACE INTO kid_items_state (key, data, updated_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(data), new Date().toISOString()).run();
}

/** Everything the page and the JobTread writer need from the record, in one read */
export async function readRecord(DB) {
  await ensureRecord(DB);
  const [receipts, decisions, also, shelves, sorts, allowLines, prices] = await Promise.all([
    all(DB, 'SELECT * FROM kid_receipts ORDER BY at'),
    all(DB, 'SELECT * FROM kid_decisions'),
    all(DB, 'SELECT * FROM kid_also ORDER BY at'),
    all(DB, 'SELECT * FROM kid_shelves'),
    all(DB, 'SELECT * FROM kid_allow_class'),
    all(DB, 'SELECT job_id, item_id FROM kid_allow_lines'),
    all(DB, 'SELECT key, cents, by_email, at FROM kid_prices'),
  ]);
  return {
    receipts: receipts.map((r) => ({ id: r.id, kind: r.kind, jobId: r.job_id, itemId: r.item_id, partKey: r.part_key, name: r.name, line: r.line_name, units: r.units, boxes: r.boxes, shelf: r.shelf, by: r.by_email, at: r.at, undoneAt: r.undone_at, ref: r.ref || null, box: r.box || null, printedAt: r.printed_at || null })),
    decisions: new Map(decisions.map((d) => [d.key, { ...parse(d.decision, {}), orderKey: d.order_key, by: d.by_email, at: d.at }])),
    also: also.map((a) => ({ key: a.key, jobId: a.job_id, name: a.name, cents: a.cents, qty: a.qty || null, donated: Boolean(a.donated), store: a.store, orderNumber: a.order_number, typed: Boolean(a.typed), costItemId: a.cost_item_id, allowItemId: a.allow_item_id || null, offByHand: a.off_by_hand || null, madeAt: a.made_at, retiredAt: a.retired_at, error: a.error, at: a.at })),
    shelves: new Map(shelves.map((s) => [s.shelf, s.job_id])),
    // Sorted onto an allowance (itemId) or not (null); none yet: not sorted
    sorts: new Map(sorts.map((x) => [x.key, { itemId: x.item_id || null, how: x.how, tries: x.tries || 0 }])),
    allowLines: new Set(allowLines.map((x) => `${x.job_id}|${x.item_id}`)),
    // A person's price for a thing in an order (by decisionKey), per one
    prices: new Map(prices.map((x) => [x.key, { cents: x.cents, by: x.by_email, at: x.at }])),
  };
}

/** What one of a thing cost, said by a person (the store's emails didn't say): { orderKey, itemName, cents } */
export async function setPrice(DB, { orderKey, itemName, cents } = {}, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  if (!orderKey || !itemName) throw bad('Which thing? Reload the page.');
  const c = Math.round(Number(cents));
  if (!Number.isFinite(c) || c <= 0 || c > 10_000_000) throw bad('Type what one of it cost.');
  await DB.prepare('INSERT OR REPLACE INTO kid_prices (key, order_key, item_name, cents, by_email, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(decisionKey(orderKey, itemName), String(orderKey), String(itemName).slice(0, 300), c, by, now).run();
  return c;
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const tapOk = (t) => /^[A-Za-z0-9_-]{8,64}$/.test(String(t || ''));
const count = (n, max, min = 1) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));

/** The kid's shelves now, the first one first */
export async function shelvesOf(DB, jobId) {
  return (await all(DB, 'SELECT shelf FROM kid_shelves WHERE job_id = ?', jobId)).map((r) => r.shelf)
    .sort((a, b) => SHELVES.indexOf(a) - SHELVES.indexOf(b));
}

/** The kid's shelf, or the next free one given to them now (the Floor when all 28 are taken) */
export async function shelfFor(DB, jobId, now = new Date().toISOString()) {
  const mine = (await shelvesOf(DB, jobId)).filter((s) => s !== FLOOR);
  if (mine.length) return mine[0];
  const taken = new Set((await all(DB, 'SELECT shelf FROM kid_shelves')).map((r) => r.shelf));
  const free = SHELVES.find((s) => s !== FLOOR && !taken.has(s));
  if (!free) return FLOOR;
  // Two phones at once: whoever writes first gets it, the other takes the next
  const r = await DB.prepare('INSERT OR IGNORE INTO kid_shelves (shelf, job_id, at) VALUES (?, ?, ?)').bind(free, jobId, now).run();
  if (!r.meta?.changes) return shelfFor(DB, jobId, now);
  return free;
}

/**
 * Check in: { tap, jobId, itemId, partKey, name, line, units, boxes } → { receipt, shelf, repeat }
 * The same tap again (a retry) returns the first one and counts nothing twice.
 */
export async function receive(DB, input, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  const { tap, jobId, itemId, partKey } = input || {};
  if (!tapOk(tap)) throw bad('That check-in has no id. Reload the page.');
  if (!jobId || !itemId || !partKey) throw bad('Which item is it? Pick it from the list.');
  const before = await DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(tap).first();
  if (before) return { receipt: before, shelf: before.shelf, repeat: true };
  const kind = input.kind === 'house' ? 'house' : 'receive';
  let shelf = null;
  if (kind !== 'house') {
    // A shelf she picked counts when it's free or already this kid's; the Floor is everyone's
    const asked = SHELVES.includes(String(input.shelf || '')) ? String(input.shelf) : null;
    if (asked === FLOOR) shelf = FLOOR;
    else if (asked) {
      const owner = await DB.prepare('SELECT job_id FROM kid_shelves WHERE shelf = ?').bind(asked).first();
      if (!owner) await DB.prepare('INSERT OR IGNORE INTO kid_shelves (shelf, job_id, at) VALUES (?, ?, ?)').bind(asked, jobId, now).run();
      const after = owner || await DB.prepare('SELECT job_id FROM kid_shelves WHERE shelf = ?').bind(asked).first();
      if (after?.job_id === jobId) shelf = asked;
    }
    shelf ||= await shelfFor(DB, jobId, now);
  }
  const units = kind === 'house' ? 0 : count(input.units, MAX_UNITS);
  const boxes = kind === 'house' ? 0 : count(input.boxes, MAX_BOXES);
  await DB.prepare(`INSERT OR IGNORE INTO kid_receipts (id, kind, job_id, item_id, part_key, name, line_name, units, boxes, shelf, by_email, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(tap, kind, jobId, itemId, partKey, String(input.name || '').slice(0, 250), String(input.line || '').slice(0, 250), units, boxes, shelf, by, now).run();
  const receipt = await DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(tap).first();
  return { receipt, shelf: receipt?.shelf ?? shelf, repeat: false };
}

/**
 * Check-ins' labels, claimed for printing: each one not printed yet is marked now, and only those come back, so two
 * requests at once (a phone's retry overlapping its first try) can't both print it. → the ids claimed
 */
export async function claimPrint(DB, ids, now = new Date().toISOString()) {
  await ensureRecord(DB);
  const got = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    got.push(...(await all(DB, `UPDATE kid_receipts SET printed_at = ? WHERE id IN (${part.map(() => '?').join(', ')}) AND printed_at IS NULL RETURNING id`, now, ...part)).map((r) => r.id));
  }
  return got;
}
/** The printer didn't take them: they're not printed after all (and the next try, or the printer coming back, prints them) */
export async function releasePrint(DB, ids, claimedAt) {
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    await DB.prepare(`UPDATE kid_receipts SET printed_at = NULL WHERE id IN (${part.map(() => '?').join(', ')}) AND printed_at = ?`).bind(...part, claimedAt).run();
  }
}

/** Undo a check-in, a "Not coming here" or a box out: it stops counting; the row stays */
export async function undo(DB, tap, opts = {}) {
  const [r] = await undoMany(DB, [tap], opts);
  if (r.error) throw Object.assign(new Error(r.error), { status: r.status });
  return r;
}

/**
 * Undo several at once (Take back off the truck: every box of a thing) → one result per tap, in order:
 * { tap, jobId, itemId, shelf? } or { tap, error, status }. Undoing what's undone already changes nothing.
 *   a check-in   its boxes' check-outs go with it; a kid with nothing left at the Office lets their shelves go
 *   a box out    it's back at the Office, on its check-in's shelf, which the kid gets back if it's free. If another
 *                kid has it by now, the check-in moves to this kid's shelf (or the next free one), and shelf says where
 */
export async function undoMany(DB, taps, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  const results = [];
  for (const tap of taps) {
    if (!tapOk(tap)) { results.push({ tap, error: 'Which check-in? Reload the page.', status: 400 }); continue; }
    const r = await DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(tap).first();
    if (!r) { results.push({ tap, error: 'That check-in isn’t saved, so there’s nothing to undo.', status: 404 }); continue; }
    const done = { tap, jobId: r.job_id, itemId: r.item_id };
    // A retry of an undo that landed (the phone stopped waiting): nothing more happens
    if (r.undone_at) { results.push({ ...done, repeat: true }); continue; }
    await DB.prepare('UPDATE kid_receipts SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL').bind(now, by, tap).run();
    if (r.kind === 'receive') {
      await DB.prepare("UPDATE kid_receipts SET undone_at = ?, undone_by = ? WHERE kind = 'out' AND ref = ? AND undone_at IS NULL").bind(now, by, r.id).run();
      await releaseEmpty(DB, r.job_id);
      await freeIfAllOut(DB, r.job_id);
    } else if (r.kind === 'out') {
      const c = r.ref ? await DB.prepare("SELECT id, shelf FROM kid_receipts WHERE id = ? AND kind = 'receive' AND undone_at IS NULL").bind(r.ref).first() : null;
      let shelf = c?.shelf || null;
      if (shelf && shelf !== FLOOR) {
        await DB.prepare('INSERT OR IGNORE INTO kid_shelves (shelf, job_id, at) VALUES (?, ?, ?)').bind(shelf, r.job_id, now).run();
        const owner = await DB.prepare('SELECT job_id FROM kid_shelves WHERE shelf = ?').bind(shelf).first();
        if (owner?.job_id !== r.job_id) {
          shelf = await shelfFor(DB, r.job_id, now);
          await DB.prepare('UPDATE kid_receipts SET shelf = ? WHERE id = ?').bind(shelf, c.id).run();
          // Its label says the old shelf: the caller prints that box's label again
          Object.assign(done, { moved: true, ref: c.id, box: r.box || null });
        }
      }
      done.shelf = shelf;
    } else {
      await releaseEmpty(DB, r.job_id);
    }
    results.push(done);
  }
  return results;
}

/** Move a check-in to another shelf (or the Floor); the kid now has that shelf too */
export async function moveShelf(DB, tap, shelf, { now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  if (!SHELVES.includes(String(shelf))) throw bad('Pick a shelf.');
  const r = await DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(tap).first();
  if (!r) throw Object.assign(new Error('That check-in isn’t saved yet. Try again in a moment.'), { status: 404 });
  if (shelf !== FLOOR) {
    await DB.prepare('INSERT OR IGNORE INTO kid_shelves (shelf, job_id, at) VALUES (?, ?, ?)').bind(shelf, r.job_id, now).run();
    // Whoever has it now, after the insert: another phone may have just given it to another kid
    const owner = await DB.prepare('SELECT job_id FROM kid_shelves WHERE shelf = ?').bind(shelf).first();
    if (owner?.job_id !== r.job_id) throw Object.assign(new Error(`${shelfName(shelf)} is another kid’s.`), { status: 409 });
  }
  await DB.prepare('UPDATE kid_receipts SET shelf = ? WHERE id = ?').bind(shelf, tap).run();
  await releaseEmpty(DB, r.job_id);
  return { jobId: r.job_id, itemId: r.item_id, shelf };
}

/** A kid's shelves past their first one that have nothing on them now are free again (a mis-tap doesn't keep a shelf) */
export async function releaseEmpty(DB, jobId) {
  const mine = await shelvesOf(DB, jobId);
  const used = new Set((await all(DB, 'SELECT DISTINCT shelf FROM kid_receipts WHERE job_id = ? AND undone_at IS NULL AND shelf IS NOT NULL', jobId)).map((x) => x.shelf));
  const keep = mine.find((s) => used.has(s)) || mine[0];
  for (const s of mine) if (s !== keep && !used.has(s)) await DB.prepare('DELETE FROM kid_shelves WHERE shelf = ? AND job_id = ?').bind(s, jobId).run();
}

const DECISIONS = new Set(['line', 'also', 'notKid', 'cancelled', 'kid']);
// A person's answer for a whole order (its item name is this): 'kid' (it's this kid's: the site places each thing as
// for a PO with their name) or 'notKid'. A thing's own answer stands over it
export const WHOLE_ORDER = '*';

/** When an answer was given: the phone's time (one with no connection sends it later), if it's a real one from the last
 * two weeks and not ahead; else now */
export function answeredAt(at, now = Date.now()) {
  const t = Date.parse(String(at || ''));
  return Number.isFinite(t) && t <= now && t > now - 14 * 86400e3 ? new Date(t).toISOString() : new Date(now).toISOString();
}
/**
 * A person's answer for one ordered item: { orderKey, itemName, decision: { type, kid, itemId, partKey } }
 *   line       it's this kid's, on this line (and part)
 *   also       it's this kid's, bought on top of the selections
 *   notKid     it isn't a kid's (store supplies, the Office)
 *   cancelled  it was cancelled or sent back
 *   kid        (the whole order, itemName '*') it's this kid's: placed as for a PO with their name
 */
export async function decide(DB, { orderKey, itemName, decision, things = null } = {}, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  if (!orderKey || !itemName || !DECISIONS.has(decision?.type)) throw bad('Pick whose it is.');
  if (['line', 'also', 'kid'].includes(decision.type) && !decision.kid) throw bad('Pick the kid.');
  if (decision.type === 'line' && (!decision.itemId || !decision.partKey)) throw bad('Pick the line.');
  const clean = { type: decision.type, ...(decision.kid ? { kid: String(decision.kid) } : {}), ...(decision.type === 'line' ? { itemId: String(decision.itemId), partKey: String(decision.partKey) } : {}) };
  // The answer it replaces: that kid's budget lines are written again (another phone answered first)
  const before = parse((await DB.prepare('SELECT decision FROM kid_decisions WHERE key = ?').bind(decisionKey(orderKey, itemName)).first())?.decision, {});
  await DB.prepare('INSERT OR REPLACE INTO kid_decisions (key, order_key, item_name, decision, by_email, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(decisionKey(orderKey, itemName), String(orderKey), String(itemName).slice(0, 300), JSON.stringify(clean), by, now).run();
  // Whose the whole order is, said with its things in front of the person (Whose is it?): those things are that kid's,
  // whatever was said of them before ("Not a kid's" one by one in Needs a look, then the box came and it's Ava's).
  // Wrong kid shows only what's on the list, so a thing that's the office's or was cancelled stays so
  if (itemName === WHOLE_ORDER && clean.type === 'kid' && Array.isArray(things)) {
    for (const name of things.slice(0, 60)) await DB.prepare('DELETE FROM kid_decisions WHERE key = ?').bind(decisionKey(orderKey, String(name))).run();
  }
  return { ...clean, ...(before?.kid && before.kid !== clean.kid ? { was: String(before.kid) } : {}) };
}

/**
 * Something else that came for a kid, typed in: { tap, jobId, name, cents, donated, units, boxes } → the receipt
 * It goes on the kid's JobTread budget as Also bought, received.
 */
export async function typedIn(DB, input, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  const name = String(input?.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!tapOk(input?.tap)) throw bad('That check-in has no id. Reload the page.');
  if (!input.jobId) throw bad('Pick the kid.');
  if (!name) throw bad('Type what it is.');
  const key = `soard-also-${keyOf(`typed\u0001${input.tap}`)}`;
  const cents = Number.isFinite(Number(input.cents)) && Number(input.cents) > 0 ? Math.min(Math.round(Number(input.cents)), 10_000_000) : null;
  await DB.prepare(`INSERT OR IGNORE INTO kid_also (key, job_id, name, cents, donated, typed, by_email, at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(key, input.jobId, name, cents, input.donated ? 1 : 0, by, now).run();
  return receive(DB, { ...input, itemId: key, partKey: 'also', name, line: 'Also bought' }, { by, now });
}

/**
 * What's out of an item, one rule for the server, the page and JobTread. Every check-out names one box of one
 * check-in: a scanned label, or a thing ticked on the list or Load all, which put its boxes in the load one by one.
 * A check-in's units go as its boxes do, and it's all out only when every one of its boxes is. (Review, Nov 11 2026:
 * a tick kept as a count of units, not boxes, landed on the wrong check-in, outlived an undo and missed a thing whose
 * line had changed. An out with no box number, from a label printed before boxes were numbered, is all of it.)
 * ins, outs: live receipts { id, units, boxes } / { ref, box } → { got, sent, allOut, boxesLeft, per: id → { full, boxes, total } }
 */
export function outState(ins, outs) {
  const per = new Map();
  let got = 0, sent = 0, boxesLeft = 0;
  for (const r of ins) {
    const total = Math.max(1, r.boxes || 1);
    const units = r.units || 0;
    got += units;
    const mine = outs.filter((o) => o.ref === r.id);
    const boxes = new Set(mine.some((o) => !o.box) ? Array.from({ length: total }, (_, n) => n + 1) : mine.map((o) => Number(o.box)).filter((b) => b >= 1 && b <= total));
    const full = boxes.size >= total;
    sent += full ? units : Math.floor((units * boxes.size) / total);
    if (!full) boxesLeft += total - boxes.size;
    per.set(r.id, { full, boxes, total });
  }
  return { got, sent, allOut: got > 0 && [...per.values()].every((p) => p.full), boxesLeft, per };
}

/** Rows whose id is in a list, a few reads however long the list (D1 takes 100 values a query) */
async function inList(DB, sql, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    rows.push(...await all(DB, `${sql} (${part.map(() => '?').join(', ')})`, ...part));
  }
  return rows;
}

/** The most one request saves; the phone sends a longer load in parts */
export const OUT_BATCH = 100;

/**
 * Check out (load-out to the house), a whole load at once: each { tap, ref, box } is one box of one check-in.
 * → one result per item, in order: { tap, receipt, repeat } or { tap, error, status }. A box out already (scanned
 * twice, or loaded on another phone first) is a repeat and counts once. A few reads and one write however big the load;
 * when everything a kid has at the Office is out, their shelves come free.
 */
export async function checkOutMany(DB, items, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const taps = [...new Set(list.map((it) => String(it?.tap || '')).filter(tapOk))];
  const refs = [...new Set(list.map((it) => String(it?.ref || '')).filter(Boolean))];
  const before = new Map((await inList(DB, 'SELECT * FROM kid_receipts WHERE id IN', taps)).map((r) => [r.id, r]));
  const ins = new Map((await inList(DB, "SELECT * FROM kid_receipts WHERE kind = 'receive' AND id IN", refs)).map((r) => [r.id, r]));
  const outs = await inList(DB, "SELECT ref, box FROM kid_receipts WHERE kind = 'out' AND undone_at IS NULL AND ref IN", refs);
  const state = new Map([...ins.values()].map((r) => [r.id, outState([r], outs.filter((o) => o.ref === r.id)).per.get(r.id)]));
  const puts = [];
  list.forEach((it, n) => {
    const tap = String(it?.tap || '');
    const fail = (error, status) => { results[n] = { tap, error, status }; };
    if (n >= OUT_BATCH) return fail('Too many at once. It’s sent again in a moment.', 413);
    if (!tapOk(tap)) return fail('That check-out has no id. Reload the page.', 400);
    if (before.has(tap)) { results[n] = { tap, receipt: before.get(tap), repeat: true }; return; }
    if (!it.ref) return fail('This phone has an older copy of the page. Reload it.', 400);
    const r = ins.get(String(it.ref));
    if (!r) return fail('That label isn’t one of SOARD’s check-ins', 404);
    if (r.undone_at) return fail('That check-in was taken back', 409);
    const st = state.get(r.id);
    const has = it.box !== undefined && it.box !== null && it.box !== '';
    const box = has ? Number(it.box) : null;
    if (has && !(Number.isInteger(box) && box >= 1 && box <= st.total)) return fail(`That box number isn’t one of its ${st.total} boxes`, 400);
    const row = { id: tap, kind: 'out', job_id: r.job_id, item_id: r.item_id, part_key: r.part_key, name: r.name, line_name: r.line_name, units: 0, boxes: 0, shelf: null, by_email: by, at: now, ref: r.id, box };
    if (st.full || (box && st.boxes.has(box))) { results[n] = { tap, receipt: row, repeat: true }; return; }
    // Counted now, so the same box twice in one load is one
    if (box) st.boxes.add(box); else for (let b = 1; b <= st.total; b++) st.boxes.add(b);
    st.full = st.boxes.size >= st.total;
    results[n] = { tap, receipt: row, repeat: false };
    puts.push(n);
  });
  if (puts.length) {
    const ran = await DB.batch(puts.map((n) => {
      const x = results[n].receipt;
      return DB.prepare(`INSERT OR IGNORE INTO kid_receipts (id, kind, job_id, item_id, part_key, name, line_name, units, boxes, shelf, by_email, at, ref, box)
          VALUES (?, 'out', ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?)`)
        .bind(x.id, x.job_id, x.item_id, x.part_key, String(x.name || '').slice(0, 250), String(x.line_name || '').slice(0, 250), by, now, x.ref, x.box);
    }));
    // Another phone got that box in first: it's out, once
    puts.forEach((n, k) => { if (!ran[k]?.meta?.changes) results[n].repeat = true; });
    for (const jobId of new Set(puts.filter((n) => !results[n].repeat).map((n) => results[n].receipt.job_id))) await freeIfAllOut(DB, jobId);
  }
  return results;
}

/** One box (or an older label's whole check-in): { tap, ref, box } → { receipt, repeat } */
export async function checkOut(DB, input, opts = {}) {
  const [r] = await checkOutMany(DB, [input || {}], opts);
  if (r.error) throw Object.assign(new Error(r.error), { status: r.status });
  return r;
}

/** Everything the kid has at the Office went out (every box of every check-in): their shelves come free for the next kid */
export async function freeIfAllOut(DB, jobId) {
  const rows = await all(DB, "SELECT id, kind, units, boxes, ref, box FROM kid_receipts WHERE job_id = ? AND undone_at IS NULL AND kind IN ('receive', 'out')", jobId);
  if (outState(rows.filter((r) => r.kind === 'receive'), rows.filter((r) => r.kind === 'out')).allOut) await DB.prepare('DELETE FROM kid_shelves WHERE job_id = ?').bind(jobId).run();
}
