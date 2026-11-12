/**
 * Thank-yous: the gifts SOARD thanks itself (Admin → Donors & Partners → To thank; ./_donor-crm.js shows them)
 * ===========================================================================
 * Zeffy emails a receipt and a thank-you to everyone who gives online. Nobody else hears from it, so these are "To
 * thank" for a person on the team:
 *   - every gift Zeffy didn't take online: a check, a donor-advised fund, a gift in kind, anything entered by hand;
 *   - every gift of $1,000 or more, however it came (the Slack "Major gift" line), as one gift however Zeffy split
 *     the charge (./_board-gifts.js joinCharges); a monthly gift only its first time.
 * Online gifts under $1,000 need nothing. Tickets, purchases and imported history are never asked about.
 *
 * Only gifts that are new to the site count: dated after thank-yous began here, or first seen by the site after it
 * had read all of Zeffy's history (a check typed in late with its own date, a donor-advised fund marked paid weeks
 * on). Everything before is taken as thanked already. A monthly gift waits for that whole read, so its first time is
 * known for sure.
 *
 * Once a gift is To thank it stays so until a person says Thanked or Not needed. It closes by itself only when Zeffy
 * shows it refunded in full, or answers twice, hours apart, that it has no such payment: never because a read of
 * Zeffy didn't list it. Each gift is one row of donor_thanks, holding enough of it (the amount, the name, the
 * campaign as the donor list shows it) to show even if the list loses it.
 */
import { ensureDonors, readDonorState, giftsFrom, howOf, noteDonorPayment, READ_COLS } from './_donors.js';
import { kidNames } from './_board-gifts.js';
import { zeffyGet, givenName, MAJOR_GIFT_CENTS } from './_zeffy.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// One gift however Zeffy split it, a gift at the moment thank-yous began included
export const THANK_CENTS = MAJOR_GIFT_CENTS;
// Payment kinds Zeffy didn't take online (it sends these givers nothing)
const OFFLINE = new Set(['cheque', 'check', 'cash', 'daf', 'in_kind', 'manual', 'transfer', 'wire', 'other']);
// Gifts dated this far back are looked at on each run (anything older that's new to the site is found by first_seen)
const RECENT_MS = 45 * DAY;
const NEW_MS = 7 * DAY;
// A gift the donor list no longer has: Zeffy asked about it at most this often, and this many a run
const GONE_ASK_MS = 6 * HOUR;
const GONE_PER_RUN = 3;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const iso = (ms) => new Date(ms).toISOString();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS donor_thanks (
    id TEXT PRIMARY KEY, ids TEXT NOT NULL, state TEXT NOT NULL, why TEXT, at INTEGER NOT NULL, cents INTEGER NOT NULL,
    in_kind INTEGER NOT NULL DEFAULT 0, name TEXT, company TEXT, campaign TEXT, how TEXT, contact TEXT,
    created_at TEXT NOT NULL, done_by TEXT, done_at TEXT, gone TEXT, missing_at TEXT, asked_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS donor_thanks_state ON donor_thanks(state)',
];
const ready = new WeakSet();
export async function ensureThanks(DB) {
  if (ready.has(DB)) return;
  await ensureDonors(DB);
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  ready.add(DB);
}
async function readState(DB) {
  const row = await DB.prepare("SELECT value FROM donor_state WHERE key = 'thanks'").first();
  try { return JSON.parse(row?.value || '{}'); } catch { return {}; }
}
const writeState = (DB, s) => DB.prepare("INSERT INTO donor_state (key, value) VALUES ('thanks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(s)).run();

// ─── The rule ───────────────────────────────────────────────────────

/** Zeffy took it online (and sent its own thank-you) */
export const online = (r) => r.type !== 'manual' && !OFFLINE.has(String(r.method || '').toLowerCase());

/**
 * Why SOARD thanks a gift itself, or null. `gift`: one gift as giftsFrom joins it (its first charge's method and type,
 * its whole amount); `first`: false for a monthly gift's later times. → 'check' | 'daf' | 'kind' | 'hand' | 'major'
 */
export function thankWhy(gift, { first = true } = {}) {
  if (!gift || gift.type === 'imported' || !(Number(gift.cents) > 0)) return null;
  if (gift.every && !first) return null;
  const m = String(gift.method || '').toLowerCase();
  if (gift.inKind || m === 'in_kind') return 'kind';
  if (m === 'cheque' || m === 'check') return 'check';
  if (m === 'daf') return 'daf';
  if (!online(gift)) return 'hand';
  return gift.cents >= THANK_CENTS ? 'major' : null;
}
export const WHY = {
  check: 'A check: Zeffy sends checks no thank-you',
  daf: 'From a donor-advised fund: Zeffy sends no thank-you',
  kind: 'A gift in kind: Zeffy sends no thank-you',
  hand: 'Entered by hand: Zeffy sends no thank-you',
  major: '$1,000 or more',
};

// ─── Keeping the list ───────────────────────────────────────────────

const chargesOf = (row) => String(row.ids || row.id).split(' ').filter(Boolean);

/**
 * Bring donor_thanks up to date with the donor list: new gifts that need a thank-you become To thank, a split gift's
 * later charges join it, and a To thank closes when Zeffy shows it refunded in full or answers twice that it has no
 * such payment. `ask`: false skips asking Zeffy (the gift webhook, which has no time to spare). Never throws
 */
export async function syncThanks(env, { now = Date.now(), fetchImpl = fetch, ask = true } = {}) {
  const { DB } = env;
  if (!DB) return null;
  try {
    await ensureThanks(DB);
    const st = await readState(DB);
    let changedState = false;
    if (!st.startedAt) { st.startedAt = iso(now); changedState = true; }
    // The first whole read of Zeffy's history after thank-yous began: from then on, anything new to the site is new
    if (!st.wholeAt) {
      const ds = await readDonorState(DB);
      if (ds.filledAt && ds.filledAt >= st.startedAt) { st.wholeAt = ds.filledAt; changedState = true; }
    }
    if (changedState) await writeState(DB, st);
    const startS = Math.floor(Date.parse(st.startedAt) / 1000);
    const nowS = Math.floor(now / 1000);
    const known = (await DB.prepare('SELECT id, ids, state, cents, asked_at FROM donor_thanks').all()).results || [];
    const byCharge = new Map();
    for (const t of known) for (const c of chargesOf(t)) byCharge.set(c, t);
    const todoIds = known.filter((t) => t.state === 'todo').flatMap(chargesOf);
    // Gifts dated since it began (an hour before, so a gift split across the moment joins whole), gifts first seen
    // lately once the history was whole, and every charge of a gift still To thank
    const parts = ['(at >= ? AND at >= ?)'];
    const vals = [startS - 3600, nowS - Math.floor(RECENT_MS / 1000)];
    // After it, not at it: what the run that finished the read saw, it saw as history
    if (st.wholeAt) { parts.push('first_seen > ?'); vals.push(st.wholeAt > iso(now - NEW_MS) ? st.wholeAt : iso(now - NEW_MS)); }
    let rows = (await DB.prepare(`SELECT ${READ_COLS.join(', ')} FROM donor_payments WHERE ${parts.join(' OR ')}`).bind(...vals).all()).results || [];
    const have = new Set(rows.map((r) => r.id));
    const missingTodo = todoIds.filter((id) => !have.has(id));
    for (let i = 0; i < missingTodo.length; i += 80) {
      const part = missingTodo.slice(i, i + 80);
      rows = rows.concat((await DB.prepare(`SELECT ${READ_COLS.join(', ')} FROM donor_payments WHERE id IN (${part.map(() => '?').join(', ')})`).bind(...part).all()).results || []);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const kids = await kidNames(DB);
    const steps = [];
    let added = 0;
    for (const g of giftsFrom(rows, kids)) {
      const charges = g.ids || [g.id];
      const rs = charges.map((id) => byId.get(id)).filter(Boolean);
      const t = charges.map((c) => byCharge.get(c)).find(Boolean) || null;
      const firstSeen = rs.reduce((m, r) => (r.first_seen < m ? r.first_seen : m), rs[0]?.first_seen || iso(now));
      const isNew = g.at >= startS || (!!st.wholeAt && firstSeen > st.wholeAt);
      if (!t && !isNew) continue;
      // A monthly gift: its first time only, known once all the history is read
      let first = true;
      if (g.every) {
        if (!st.wholeAt) continue;
        const r0 = rs[0];
        const earlier = r0.sub
          ? await DB.prepare('SELECT 1 FROM donor_payments WHERE sub = ? AND at < ? AND id <> ? LIMIT 1').bind(r0.sub, r0.at, r0.id).first()
          : await DB.prepare('SELECT 1 FROM donor_payments WHERE every = ? AND campaign IS ? AND at < ? AND id <> ? AND ((contact IS NOT NULL AND contact = ?) OR (email IS NOT NULL AND email = ?)) LIMIT 1')
            .bind(r0.every, r0.campaign, r0.at, r0.id, r0.contact, r0.email).first();
        first = !earlier;
      }
      const why = thankWhy(g, { first });
      const r0 = rs[0] || {};
      const name = givenName({ first_name: r0.first, last_name: r0.last }) || clean(r0.company) || 'No name';
      const snap = [charges.join(' '), g.at, g.inKind ? 0 : g.cents, g.inKind ? g.cents : 0, name, r0.company || null, g.campaign || null, howOf(g), r0.contact || null];
      if (!t) {
        if (!why) continue;
        steps.push(DB.prepare(`INSERT OR IGNORE INTO donor_thanks (id, ids, state, why, at, cents, in_kind, name, company, campaign, how, contact, created_at)
          VALUES (?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(g.id, snap[0], why, ...snap.slice(1), iso(now)));
        added++;
        continue;
      }
      // Known: a later charge of a split gift joins it. A To thank keeps up with the gift; refunded in full, it closes
      const refunded = rs.length === charges.length && rs.length > 0 && rs.every((r) => Number(r.cents) > 0 && !Number(r.net));
      if (t.state === 'todo' && refunded) {
        steps.push(DB.prepare("UPDATE donor_thanks SET state = 'gone', gone = 'refunded', done_at = ? WHERE id = ? AND state = 'todo'").bind(iso(now), t.id));
      } else if (t.state === 'todo' && why) {
        steps.push(DB.prepare('UPDATE donor_thanks SET ids = ?, why = ?, at = ?, cents = ?, in_kind = ?, name = ?, company = ?, campaign = ?, how = ?, contact = ?, missing_at = NULL WHERE id = ?').bind(snap[0], why, ...snap.slice(1), t.id));
      } else if (chargesOf(t).join(' ') !== snap[0] && rs.length) {
        steps.push(DB.prepare('UPDATE donor_thanks SET ids = ? WHERE id = ?').bind([...new Set([...chargesOf(t), ...charges])].join(' '), t.id));
      }
    }
    for (let i = 0; i < steps.length; i += 50) await DB.batch(steps.slice(i, i + 50));
    // To thank, but the donor list has none of its charges: ask Zeffy (a few a run, each at most every few hours)
    let closed = 0;
    if (ask && String(env.ZEFFY_API_KEY || '').trim()) {
      const lost = known.filter((t) => t.state === 'todo' && chargesOf(t).every((c) => !byId.has(c)))
        .filter((t) => !t.asked_at || now - Date.parse(t.asked_at) >= GONE_ASK_MS).slice(0, GONE_PER_RUN);
      for (const t of lost) closed += await askZeffy(env, t, { now, fetchImpl });
    }
    return { added, closed };
  } catch (e) {
    console.error('[donors] thanks', e.message);
    return null;
  }
}

/** A To thank the donor list lost: Zeffy says refunded or gone (twice, hours apart) → closed; there → back in the list */
async function askZeffy(env, t, { now, fetchImpl }) {
  const { DB } = env;
  const id = chargesOf(t)[0];
  const at = iso(now);
  try {
    const p = await zeffyGet(env, `/payments/${encodeURIComponent(id)}`, {}, fetchImpl);
    const status = String(p?.status || '').toLowerCase();
    if (p?.refund_status === 'full' || (status && status !== 'succeeded')) {
      await DB.prepare("UPDATE donor_thanks SET state = 'gone', gone = ?, done_at = ?, asked_at = ? WHERE id = ? AND state = 'todo'").bind(p?.refund_status === 'full' ? 'refunded' : 'failed', at, at, t.id).run();
      return 1;
    }
    // Zeffy has it: back in the list (a read that missed it), and it stays To thank
    await noteDonorPayment(env, p, { now, thanks: false });
    await DB.prepare('UPDATE donor_thanks SET missing_at = NULL, asked_at = ? WHERE id = ?').bind(at, t.id).run();
    return 0;
  } catch (e) {
    if (e.status !== 404) { await DB.prepare('UPDATE donor_thanks SET asked_at = ? WHERE id = ?').bind(at, t.id).run(); return 0; }
    // Gone: only the second answer, hours after the first, closes it
    const row = await DB.prepare('SELECT missing_at FROM donor_thanks WHERE id = ?').bind(t.id).first();
    if (row?.missing_at && now - Date.parse(row.missing_at) >= GONE_ASK_MS) {
      await DB.prepare("UPDATE donor_thanks SET state = 'gone', gone = 'deleted', done_at = ?, asked_at = ? WHERE id = ? AND state = 'todo'").bind(at, at, t.id).run();
      return 1;
    }
    await DB.prepare('UPDATE donor_thanks SET missing_at = COALESCE(missing_at, ?), asked_at = ? WHERE id = ?').bind(at, at, t.id).run();
    return 0;
  }
}

// ─── Reading and saying ─────────────────────────────────────────────

const SHOW = 'id, ids, state, why, at, cents, in_kind, name, company, campaign, how, contact, created_at, done_by, done_at, gone';
/** Every gift still To thank, the one waiting longest first */
export async function thanksToDo(DB) {
  await ensureThanks(DB);
  return (await DB.prepare(`SELECT ${SHOW} FROM donor_thanks WHERE state = 'todo' ORDER BY at ASC`).all()).results || [];
}
/** How many are waiting (the Donors list's count) */
export async function thanksCount(DB) {
  await ensureThanks(DB);
  return Number((await DB.prepare("SELECT COUNT(*) AS n FROM donor_thanks WHERE state = 'todo'").first())?.n) || 0;
}
/** The thank-you of each charge given: Map charge id → { id, state, why, by, at, gone } */
export async function thanksFor(DB, chargeIds) {
  await ensureThanks(DB);
  const out = new Map();
  const want = new Set(chargeIds.map(String));
  if (!want.size) return out;
  // Few rows: read whole (a gift's charges are in one row's ids, which a lookup by id can't find)
  for (const t of (await DB.prepare(`SELECT ${SHOW} FROM donor_thanks`).all()).results || []) {
    for (const c of chargesOf(t)) if (want.has(c)) out.set(c, { id: t.id, state: t.state, why: t.why, by: t.done_by || null, at: t.done_at || null, gone: t.gone || null });
  }
  return out;
}

/**
 * A person says: thanked, not needed, or (Undo) To thank again. `id`: any charge of the gift. → the row as it was
 */
export async function markThanks(DB, { id, state }, by, { now = Date.now() } = {}) {
  await ensureThanks(DB);
  if (!['thanked', 'skipped', 'todo'].includes(state)) throw Object.assign(new Error('Thanked, not needed, or To thank'), { status: 400 });
  const want = String(id || '');
  const t = ((await DB.prepare(`SELECT ${SHOW} FROM donor_thanks`).all()).results || []).find((x) => chargesOf(x).includes(want));
  if (!t) throw Object.assign(new Error('That gift has no thank-you to say. Reload and look again.'), { status: 404 });
  if (t.state === 'gone') throw Object.assign(new Error('That gift was refunded or taken out of Zeffy, so there’s no thank-you to say.'), { status: 409 });
  await DB.prepare('UPDATE donor_thanks SET state = ?, done_by = ?, done_at = ? WHERE id = ?')
    .bind(state, state === 'todo' ? null : by || null, state === 'todo' ? null : iso(now), t.id).run();
  return t;
}
