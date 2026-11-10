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
];
// Added Nov 10 2026 with checking out: an "out" names the check-in whose label was scanned
const RECEIPT_COLUMNS = ['ref TEXT', 'box INTEGER'];
const _ready = new WeakSet();
export async function ensureRecord(DB) {
  if (_ready.has(DB)) return;
  for (const s of SCHEMA) await DB.prepare(s).run();
  const have = new Set(((await DB.prepare('PRAGMA table_info(kid_receipts)').all()).results || []).map((c) => c.name));
  for (const c of RECEIPT_COLUMNS) {
    if (have.has(c.split(' ')[0])) continue;
    // Two requests at once can both see it missing: the second one's "duplicate column" is fine
    try { await DB.prepare(`ALTER TABLE kid_receipts ADD COLUMN ${c}`).run(); } catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
  }
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
  const [receipts, decisions, also, shelves] = await Promise.all([
    all(DB, 'SELECT * FROM kid_receipts ORDER BY at'),
    all(DB, 'SELECT * FROM kid_decisions'),
    all(DB, 'SELECT * FROM kid_also ORDER BY at'),
    all(DB, 'SELECT * FROM kid_shelves'),
  ]);
  return {
    receipts: receipts.map((r) => ({ id: r.id, kind: r.kind, jobId: r.job_id, itemId: r.item_id, partKey: r.part_key, name: r.name, line: r.line_name, units: r.units, boxes: r.boxes, shelf: r.shelf, by: r.by_email, at: r.at, undoneAt: r.undone_at, ref: r.ref || null, box: r.box || null })),
    decisions: new Map(decisions.map((d) => [d.key, { ...parse(d.decision, {}), by: d.by_email, at: d.at }])),
    also: also.map((a) => ({ key: a.key, jobId: a.job_id, name: a.name, cents: a.cents, donated: Boolean(a.donated), store: a.store, orderNumber: a.order_number, typed: Boolean(a.typed), costItemId: a.cost_item_id, madeAt: a.made_at, retiredAt: a.retired_at, error: a.error, at: a.at })),
    shelves: new Map(shelves.map((s) => [s.shelf, s.job_id])),
  };
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

/** Undo a check-in (or a "Not coming here"): it stops counting; the row stays */
export async function undo(DB, tap, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  if (!tapOk(tap)) throw bad('Which check-in? Reload the page.');
  const r = await DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(tap).first();
  if (!r) throw Object.assign(new Error('That check-in isn’t saved, so there’s nothing to undo.'), { status: 404 });
  if (!r.undone_at) await DB.prepare('UPDATE kid_receipts SET undone_at = ?, undone_by = ? WHERE id = ?').bind(now, by, tap).run();
  await releaseEmpty(DB, r.job_id);
  return { jobId: r.job_id, itemId: r.item_id };
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

const DECISIONS = new Set(['line', 'also', 'notKid', 'cancelled']);
/**
 * A person's answer for one ordered item: { orderKey, itemName, decision: { type, kid, itemId, partKey } }
 *   line       it's this kid's, on this line (and part)
 *   also       it's this kid's, bought on top of the selections
 *   notKid     it isn't a kid's (store supplies, the Office)
 *   cancelled  it was cancelled or sent back
 */
export async function decide(DB, { orderKey, itemName, decision } = {}, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  if (!orderKey || !itemName || !DECISIONS.has(decision?.type)) throw bad('Pick whose it is.');
  if ((decision.type === 'line' || decision.type === 'also') && !decision.kid) throw bad('Pick the kid.');
  if (decision.type === 'line' && (!decision.itemId || !decision.partKey)) throw bad('Pick the line.');
  const clean = { type: decision.type, ...(decision.kid ? { kid: String(decision.kid) } : {}), ...(decision.type === 'line' ? { itemId: String(decision.itemId), partKey: String(decision.partKey) } : {}) };
  await DB.prepare('INSERT OR REPLACE INTO kid_decisions (key, order_key, item_name, decision, by_email, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(decisionKey(orderKey, itemName), String(orderKey), String(itemName).slice(0, 300), JSON.stringify(clean), by, now).run();
  return clean;
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
 * Check out (load-out to the house), one box at a time:
 *   { tap, ref, box }  a scanned label: that one box of that check-in. Its units go as its boxes do: one sink in three
 *                      boxes is out when the third box is; four towels in two boxes, two a box
 *   { tap, ref }       an older label with no box number: all of that check-in
 *   { tap, jobId, itemId, partKey, units, name, line }   an item ticked on the list, or Load all
 * → { receipt, repeat }. A box scanned twice counts once. When everything a kid has at the Office is out, their shelves come free.
 */
export async function checkOut(DB, input, { by = null, now = new Date().toISOString() } = {}) {
  await ensureRecord(DB);
  const { tap } = input || {};
  if (!tapOk(tap)) throw bad('That check-out has no id. Reload the page.');
  const before = await DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(tap).first();
  if (before) return { receipt: before, repeat: true };
  let row = { jobId: input.jobId, itemId: input.itemId, partKey: input.partKey, units: count(input.units, MAX_UNITS), name: input.name, line: input.line, ref: null, box: null };
  if (input.ref) {
    const r = await DB.prepare("SELECT * FROM kid_receipts WHERE id = ? AND kind = 'receive'").bind(String(input.ref)).first();
    if (!r) throw Object.assign(new Error('That label isn’t one of SOARD’s check-ins.'), { status: 404 });
    if (r.undone_at) throw Object.assign(new Error('That check-in was taken back.'), { status: 409 });
    const boxes = Math.max(1, r.boxes || 1);
    const box = Number.isInteger(Number(input.box)) && Number(input.box) >= 1 && Number(input.box) <= boxes ? Number(input.box) : null;
    const outs = (await DB.prepare("SELECT box FROM kid_receipts WHERE kind = 'out' AND ref = ? AND undone_at IS NULL").bind(r.id).all()).results || [];
    const whole = outs.some((o) => o.box == null);
    const done = new Set(outs.map((o) => o.box).filter((b) => b != null));
    const repeat = async () => ({ receipt: { ...r, kind: 'out' }, repeat: true });
    if (whole || (box && done.has(box)) || (!box && done.size >= boxes)) return repeat();
    // Already gone with Load all or a tap (no label scanned): all of that item is out, so this label counts once too
    const sums = await DB.prepare("SELECT SUM(CASE WHEN kind = 'receive' THEN units ELSE 0 END) AS came, SUM(CASE WHEN kind = 'out' THEN units ELSE 0 END) AS went FROM kid_receipts WHERE job_id = ? AND item_id = ? AND part_key = ? AND undone_at IS NULL")
      .bind(r.job_id, r.item_id, r.part_key).first();
    if ((sums?.went || 0) >= (sums?.came || 0)) return repeat();
    // The units this box takes with it: what all the boxes out so far carry, less what the ones before carried
    const k = done.size + 1;
    const units = box ? Math.floor((r.units * k) / boxes) - Math.floor((r.units * (k - 1)) / boxes) : r.units - Math.floor((r.units * done.size) / boxes);
    row = { jobId: r.job_id, itemId: r.item_id, partKey: r.part_key, units, name: r.name, line: r.line_name, ref: r.id, box };
  }
  if (!row.jobId || !row.itemId || !row.partKey) throw bad('Which item is it? Pick it from the list.');
  await DB.prepare(`INSERT OR IGNORE INTO kid_receipts (id, kind, job_id, item_id, part_key, name, line_name, units, boxes, shelf, by_email, at, ref, box)
      VALUES (?, 'out', ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`)
    .bind(tap, row.jobId, row.itemId, row.partKey, String(row.name || '').slice(0, 250), String(row.line || '').slice(0, 250), row.units, by, now, row.ref, row.box).run();
  await freeIfAllOut(DB, row.jobId);
  return { receipt: await DB.prepare('SELECT * FROM kid_receipts WHERE id = ?').bind(tap).first(), repeat: false };
}

/** Everything the kid has at the Office went out: their shelves come free for the next kid */
export async function freeIfAllOut(DB, jobId) {
  const rows = await all(DB, "SELECT item_id, part_key, kind, SUM(units) AS n FROM kid_receipts WHERE job_id = ? AND undone_at IS NULL AND kind IN ('receive', 'out') GROUP BY item_id, part_key, kind", jobId);
  const left = new Map();
  for (const r of rows) left.set(`${r.item_id}|${r.part_key}`, (left.get(`${r.item_id}|${r.part_key}`) || 0) + (r.kind === 'receive' ? r.n : -r.n));
  if (left.size && [...left.values()].every((n) => n <= 0)) await DB.prepare('DELETE FROM kid_shelves WHERE job_id = ?').bind(jobId).run();
}
