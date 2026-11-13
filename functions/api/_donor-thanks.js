/**
 * Thank-yous: the gifts SOARD thanks itself (Admin → Donors & Partners → To thank; ./_donor-crm.js shows them)
 * ===========================================================================
 * Zeffy emails a receipt and a thank-you to everyone who gives online. Nobody else hears from it, so these are "To
 * thank" for a person on the team:
 *   - every gift Zeffy didn't take online: a check, a donor-advised fund, a gift in kind, anything entered by hand;
 *   - every gift of $1,000 or more, however it came (the Slack "Major gift" line), as one gift however Zeffy split
 *     the charge (./_board-gifts.js joinCharges); a monthly (weekly, quarterly) gift only its first time, a yearly
 *     one each year.
 * A thank-you covers the charges it was said for: a charge that joins its gift later is asked about on its own.
 * Online gifts under $1,000 need nothing. Tickets and purchases are never asked about. Gifts imported into Zeffy (a
 * gala's, from its auction platform) are asked about like any other: Zeffy sends their givers nothing either.
 *
 * Only gifts that are new to the site count: dated after thank-yous began here, or first seen by the site after it
 * had read all of Zeffy's history (a check typed in late with its own date, a donor-advised fund marked paid weeks
 * on). An import is new only by its date: one of old history read later was thanked long ago. Everything before is
 * taken as thanked already. A monthly gift waits for that whole read, so its first time is known for sure.
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
  // (missing_id: the charge Zeffy last said it doesn't have, so its two answers hours apart are about one charge)
  try { await DB.prepare('ALTER TABLE donor_thanks ADD COLUMN missing_id TEXT').run(); } catch (e) { if (!/duplicate column/i.test(String(e?.message || e))) throw e; }
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

/** How one charge was taken, if Zeffy sent its giver nothing: 'kind' | 'check' | 'daf' | 'hand' | null */
function offlineWhy(r) {
  const m = String(r?.method || '').toLowerCase();
  if (r?.inKind || Number(r?.in_kind) > 0 || m === 'in_kind') return 'kind';
  if (m === 'cheque' || m === 'check') return 'check';
  if (m === 'daf') return 'daf';
  return online(r || {}) ? null : 'hand';
}
/**
 * Why SOARD thanks a gift itself, or null. `gift`: one gift as giftsFrom joins it (its whole amount); `charges`: the
 * donor list's rows of its charges, each looked at as it was taken (a check joined to a card charge, one guest at one
 * gala, is still a check; without them, the gift's own method); `first`: false for a monthly gift's later times.
 * → 'kind' | 'check' | 'daf' | 'hand' | 'major'
 */
export function thankWhy(gift, { first = true, charges = null } = {}) {
  if (!gift || (!(Number(gift.cents) > 0) && !gift.inKind)) return null;
  // A gift every month (or week, or quarter): its first time. Once a year: each year, as the Slack line says
  if (gift.every && gift.every !== 'yearly' && !first) return null;
  const whys = (charges?.length ? charges : [gift]).map(offlineWhy);
  const why = ['kind', 'check', 'daf', 'hand'].find((w) => whys.includes(w));
  if (why) return why;
  return gift.cents >= THANK_CENTS ? 'major' : null;
}
export const WHY = {
  check: 'A check: Zeffy sends checks no thank-you',
  daf: 'From a donor-advised fund: Zeffy sends no thank-you',
  kind: 'A gift in kind: Zeffy sends no thank-you',
  hand: 'Entered by hand: Zeffy sends no thank-you',
  major: '$1,000 or more',
  partly: 'Part of it was refunded since. Say whether what’s left needs a thank-you from the team',
};

// ─── Keeping the list ───────────────────────────────────────────────

const chargesOf = (row) => String(row.ids || row.id).split(' ').filter(Boolean);

/**
 * Bring donor_thanks up to date with the donor list: new gifts that need a thank-you become To thank, a split gift's
 * later charges join it, and a To thank closes when Zeffy shows every charge of it refunded in full, or answers twice
 * that it has no such payment. One run at a time (the webhook's and the 15-minute read's could otherwise both add one
 * gift): a run that finds another going leaves it to that one, and the next read picks up anything it missed.
 * `ask`: false skips asking Zeffy (the gift webhook, which has no time to spare). Never throws
 */
export async function syncThanks(env, { now = Date.now(), fetchImpl = fetch, ask = true } = {}) {
  const { DB } = env;
  if (!DB) return null;
  let turn = null;
  try {
    await ensureThanks(DB);
    turn = await takeTurn(DB, now);
    if (!turn) return { busy: true };
    return await syncOnce(env, { now, fetchImpl, ask });
  } catch (e) {
    console.error('[donors] thanks', e.message);
    return null;
  } finally {
    if (turn) await DB.prepare("UPDATE donor_state SET value = '0' WHERE key = 'thanks-turn' AND value = ?").bind(turn).run().catch(() => {});
  }
}
// A run that died lets go of its turn after this long
const TURN_MS = 3 * MIN;
async function takeTurn(DB, now) {
  const at = iso(now);
  const r = await DB.prepare("INSERT INTO donor_state (key, value) VALUES ('thanks-turn', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE donor_state.value < ?")
    .bind(at, iso(now - TURN_MS)).run();
  return r.meta?.changes ? at : null;
}

/** Is each of these monthly gifts its giver's first? One question for all that have Zeffy's plan id → Set of first ones */
async function firstTimes(DB, gifts) {
  const first = new Set();
  const bySub = new Map();
  for (const { g, r0 } of gifts) if (r0.sub) bySub.set(r0.sub, [...(bySub.get(r0.sub) || []), { g, r0 }]);
  const subs = [...bySub.keys()];
  for (let i = 0; i < subs.length; i += 80) {
    const part = subs.slice(i, i + 80);
    const r = (await DB.prepare(`SELECT sub, MIN(at) AS at FROM donor_payments WHERE sub IN (${part.map(() => '?').join(', ')}) GROUP BY sub`).bind(...part).all()).results || [];
    const minOf = new Map(r.map((x) => [x.sub, Number(x.at)]));
    for (const sub of part) for (const { g, r0 } of bySub.get(sub)) if (!(minOf.get(sub) < Number(r0.at))) first.add(g);
  }
  // No plan id (rare): the same giver (their contact, else email, else name) giving the same every-so-often to the same
  // campaign before. Known by nothing at all: never taken as a first time, so it can't come back every month
  for (const { g, r0 } of gifts) {
    if (r0.sub) continue;
    const name = clean(`${clean(r0.first)} ${clean(r0.last)}`).toLowerCase();
    const who = r0.contact ? ['contact = ?', r0.contact] : r0.email ? ['email = ?', r0.email] : name ? ["lower(trim(coalesce(first, '') || ' ' || coalesce(last, ''))) = ?", name] : null;
    if (!who) continue;
    const earlier = await DB.prepare(`SELECT 1 FROM donor_payments WHERE ${who[0]} AND every = ? AND campaign IS ? AND at < ? AND id <> ? LIMIT 1`).bind(who[1], r0.every, r0.campaign, r0.at, r0.id).first();
    if (!earlier) first.add(g);
  }
  return first;
}

/** How a thank-you's own charges came, each way once ("Card and Check"): never the whole gift's when it holds part */
const howOfCharges = (rs, g) => [...new Set(rs.map((r) => howOf(r)))].join(' and ') || howOf(g);

async function syncOnce(env, { now, fetchImpl, ask }) {
  const { DB } = env;
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
  const known = (await DB.prepare('SELECT id, ids, state, cents, asked_at, created_at FROM donor_thanks').all()).results || [];
  const steps = [];
  // A thank-you covers the charges it was said for, and no other: one charge, one thank-you. Said ones hold theirs
  // first; a To thank holds what no other does (two that share a charge, from runs that overlapped once, become one:
  // the one with more of the gift keeps it, the other keeps the rest or, left with nothing, goes)
  const byCharge = new Map();
  const idsOf = new Map();
  const rank = (t) => [t.state === 'todo' ? 1 : 0, -chargesOf(t).length, t.created_at || '', t.id];
  const before = (a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
  for (const t of [...known].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))) {
    if (t.state === 'gone') continue;
    const all = chargesOf(t);
    const own = t.state === 'todo' ? all.filter((c) => !byCharge.has(c)) : all;
    if (!own.length) { steps.push(DB.prepare("DELETE FROM donor_thanks WHERE id = ? AND state = 'todo'").bind(t.id)); continue; }
    if (own.length < all.length) steps.push(DB.prepare("UPDATE donor_thanks SET ids = ? WHERE id = ? AND state = 'todo'").bind(own.join(' '), t.id));
    idsOf.set(t.id, own);
    for (const c of own) if (!byCharge.has(c)) byCharge.set(c, t);
  }
  const live = known.filter((t) => idsOf.has(t.id));
  const todoIds = live.filter((t) => t.state === 'todo').flatMap((t) => idsOf.get(t.id));
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
  // A charge gives something: money kept (not refunded), or a gift in kind not refunded (in kind may carry no value)
  const gives = (r) => Number(r.giving) > 0 || Number(r.in_kind) > 0 || (r.method === 'in_kind' && String(r.refund || '') !== 'full');
  const amountOf = (rs) => rs.reduce((n, r) => n + (Number(r.method === 'in_kind' ? r.in_kind : r.giving) || 0), 0);
  // A gift as some of its charges make it: their amount, and how it came as the one Zeffy sent nothing for says
  const asGift = (g, rs) => {
    const lead = rs.find((r) => offlineWhy(r)) || rs[0];
    return { ...g, id: rs[0].id, ids: rs.map((r) => r.id), at: Math.max(...rs.map((r) => Number(r.at))), cents: amountOf(rs), method: lead.method, type: lead.type, inKind: lead.method === 'in_kind', parts: rs.length };
  };
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

  // The rule: a thank-you covers its own charges and is judged by them alone. Each gift (charges joined as one: same
  // giver, same campaign, an hour apart) is shared out like this:
  //   none of it said: one thank-you for the whole gift (two To thanks a new charge joined become one);
  //   some of it said (Thanked, Not needed): what's said stays as it was; each charge Zeffy sent nothing for that no
  //   thank-you holds is its own (a check is a check, at its own amount); online charges no thank-you holds join a To
  //   thank of online charges in the gift, else are one of their own (a later $1,200 in two charges is still $1,000).
  const giftList = [];
  const giftOfCharge = new Map();
  for (const g of giftsFrom(rows, kids)) {
    const charges = (g.ids || [g.id]).filter((c) => byId.has(c) && gives(byId.get(c)));
    if (!charges.length) continue;
    const x = { g, charges };
    giftList.push(x);
    for (const c of g.ids || [g.id]) giftOfCharge.set(c, g);
  }
  // A To thank whose charges are in two gifts now (one moved to another giver, a middle one deleted) stays with the
  // part that still needs a thank-you (else the one with its first charge, else the most of them); the rest is let go,
  // to be a question of its own, whatever its date (it was waiting already)
  const touching = new Map();
  for (const x of giftList) for (const h of new Set(x.charges.map((c) => byCharge.get(c)).filter((h) => h?.state === 'todo'))) touching.set(h.id, [...(touching.get(h.id) || []), x]);
  const primaryOf = new Map();
  for (const [id, xs] of touching) {
    const own = idsOf.get(id) || [];
    const score = (x) => { const rs = x.charges.filter((c) => own.includes(c)).map((c) => byId.get(c)); return [rs.length && thankWhy(asGift(x.g, rs), { charges: rs }) ? 1 : 0, x.charges.includes(own[0]) ? 1 : 0, rs.length]; };
    primaryOf.set(id, [...xs].sort((a, b) => cmp(score(b), score(a)))[0]);
  }
  const assigned = new Map();
  const forced = new Set();
  const candidates = [];
  const byRank = (a, b) => cmp([a.created_at || '', a.id], [b.created_at || '', b.id]);
  for (const x of giftList) {
    const held = [...new Set(x.charges.map((c) => byCharge.get(c)).filter(Boolean))];
    const said = held.some((h) => h.state !== 'todo');
    const todos = held.filter((h) => h.state === 'todo' && primaryOf.get(h.id) === x).sort(byRank);
    const free = x.charges.filter((c) => { const h = byCharge.get(c); if (!h) return true; if (h.state === 'todo' && primaryOf.get(h.id) !== x) { forced.add(c); return true; } return false; });
    // What a To thank keeps whatever the gift is now: charges a read missed, and ones refunded (they say why it changed)
    const missingOf = (t) => (idsOf.get(t.id) || []).filter((c) => !byId.has(c) || !gives(byId.get(c)));
    if (!said) {
      if (todos.length) {
        const [keep, ...rest] = todos;
        for (const r of rest) { steps.push(DB.prepare("DELETE FROM donor_thanks WHERE id = ? AND state = 'todo'").bind(r.id)); idsOf.delete(r.id); }
        assigned.set(keep.id, [...x.charges.filter((c) => !byCharge.get(c) || todos.includes(byCharge.get(c)) || forced.has(c)), ...missingOf(keep), ...rest.flatMap(missingOf)]);
      } else candidates.push({ g: x.g, rs: x.charges.map((c) => byId.get(c)), forced: x.charges.some((c) => forced.has(c)) });
      continue;
    }
    for (const t of todos) assigned.set(t.id, [...(idsOf.get(t.id) || []).filter((c) => x.charges.includes(c)), ...missingOf(t)]);
    const offline = free.filter((c) => offlineWhy(byId.get(c)));
    const online = free.filter((c) => !offlineWhy(byId.get(c)));
    for (const c of offline) candidates.push({ g: asGift(x.g, [byId.get(c)]), rs: [byId.get(c)], forced: forced.has(c) });
    if (online.length) {
      const home = todos.find((t) => assigned.get(t.id).filter((c) => byId.has(c)).every((c) => !offlineWhy(byId.get(c))));
      if (home) assigned.set(home.id, [...assigned.get(home.id), ...online]);
      else candidates.push({ g: asGift(x.g, online.map((c) => byId.get(c))), rs: online.map((c) => byId.get(c)), forced: online.some((c) => forced.has(c)) });
    }
  }
  // New ones: new since thank-yous began (an import by its date only: old history imported now was thanked when it
  // was given), or let go from a To thank; a monthly gift's first time only, known once all the history is read
  const fresh = candidates.filter(({ g, rs, forced: f }) => {
    const firstSeen = rs.reduce((m, r) => (r.first_seen < m ? r.first_seen : m), rs[0].first_seen);
    const isNew = g.at >= startS || (g.type !== 'imported' && !!st.wholeAt && firstSeen > st.wholeAt);
    return (isNew || f) && !(g.every && !st.wholeAt);
  }).map((c) => ({ ...c, r0: c.rs[0] }));
  const first = await firstTimes(DB, fresh.filter((x) => x.g.every));
  const rowIds = new Set(known.map((t) => t.id));
  const named = (r0) => givenName({ first_name: r0.first, last_name: r0.last }) || clean(r0.company) || clean(r0.email) || 'No name';
  let added = 0;
  for (const { g, rs, r0 } of fresh) {
    const why = thankWhy(g, { first: !g.every || first.has(g), charges: rs });
    if (!why) continue;
    // Named as the donor list names them (./_donor-crm.js): their email when Zeffy has no name
    // Its own id: the gift's, else one no thank-you here has had (the same gift can need a new one more than once)
    let id = rowIds.has(g.id) ? `${g.id}~${rs.length}${rs.at(-1).id}` : g.id;
    for (let k = 2; rowIds.has(id); k++) id = `${g.id}~${rs.length}${rs.at(-1).id}~${k}`;
    steps.push(DB.prepare(`INSERT OR IGNORE INTO donor_thanks (id, ids, state, why, at, cents, in_kind, name, company, campaign, how, contact, created_at)
      VALUES (?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, rs.map((r) => r.id).join(' '), why, g.at, g.inKind ? 0 : g.cents, g.inKind ? g.cents : 0, named(r0), r0.company || null, g.campaign || null, howOfCharges(rs, g), r0.contact || null, iso(now)));
    rowIds.add(id);
    added++;
  }
  // Every To thank, judged by its own charges:
  //   none gives anything any more: all refunded in full closes it; any the list doesn't have, Zeffy is asked (below);
  //   one the list doesn't have, the rest still given: it waits as it is (a read may have missed it), a charge joining
  //   aside, and Zeffy is asked about that one too, so it's settled (back in the list, or off this To thank) in hours;
  //   still needing a thank-you: it keeps up (amount, how, name);
  //   not, with some refunded (in full or in part): it stays (part is still given: a person says), saying so;
  //   not, otherwise: Zeffy shows the gift changed (a charge moved to another giver, a check re-entered as a card): closed
  const lost = [];
  for (const t of live) {
    if (t.state !== 'todo' || !idsOf.has(t.id)) continue;
    // In the order it had them, any joining after
    const was = idsOf.get(t.id) || [];
    const next = new Set(assigned.has(t.id) ? assigned.get(t.id) : was);
    const ids = [...was.filter((c) => next.has(c)), ...[...next].filter((c) => !was.includes(c))];
    const changedIds = ids.join(' ') !== was.join(' ');
    const present = ids.filter((c) => byId.has(c)).map((c) => byId.get(c));
    const missing = ids.filter((c) => !byId.has(c));
    const giving = present.filter(gives);
    if (!giving.length) {
      if (!missing.length) steps.push(DB.prepare("UPDATE donor_thanks SET state = 'gone', gone = 'refunded', done_at = ? WHERE id = ? AND state = 'todo'").bind(iso(now), t.id));
      else if (!t.asked_at || now - Date.parse(t.asked_at) >= GONE_ASK_MS) lost.push({ t, id: missing[0], ids });
      continue;
    }
    if (missing.length) {
      if (changedIds) steps.push(DB.prepare("UPDATE donor_thanks SET ids = ? WHERE id = ? AND state = 'todo'").bind(ids.join(' '), t.id));
      if (!t.asked_at || now - Date.parse(t.asked_at) >= GONE_ASK_MS) lost.push({ t, id: missing[0], ids });
      continue;
    }
    const g = asGift(giftOfCharge.get(giving[0].id) || {}, giving);
    const why = thankWhy(g, { first: true, charges: giving });
    const r0 = giving[0];
    if (why) {
      // (written only when something differs: what changed is counted, and open tabs read again)
      const vals = [ids.join(' '), why, g.at, g.inKind ? 0 : g.cents, g.inKind ? g.cents : 0, named(r0), r0.company || null, g.campaign || null, howOfCharges(giving, g), r0.contact || null];
      steps.push(DB.prepare(`UPDATE donor_thanks SET ids = ?, why = ?, at = ?, cents = ?, in_kind = ?, name = ?, company = ?, campaign = ?, how = ?, contact = ?, missing_at = NULL WHERE id = ? AND state = 'todo'
        AND NOT (ids IS ? AND why IS ? AND at IS ? AND cents IS ? AND in_kind IS ? AND name IS ? AND company IS ? AND campaign IS ? AND how IS ? AND contact IS ? AND missing_at IS NULL)`)
        .bind(...vals, t.id, ...vals));
    } else if (present.some((r) => Number(r.net) < Number(r.cents))) {
      steps.push(DB.prepare("UPDATE donor_thanks SET ids = ?, why = 'partly', cents = ?, missing_at = NULL WHERE id = ? AND state = 'todo' AND NOT (ids IS ? AND why IS 'partly' AND cents IS ? AND missing_at IS NULL)")
        .bind(ids.join(' '), amountOf(giving), t.id, ids.join(' '), amountOf(giving)));
    } else {
      steps.push(DB.prepare("UPDATE donor_thanks SET state = 'gone', gone = 'changed', done_at = ? WHERE id = ? AND state = 'todo'").bind(iso(now), t.id));
    }
  }
  let changes = 0;
  for (let i = 0; i < steps.length; i += 50) for (const r of await DB.batch(steps.slice(i, i + 50))) changes += Number(r?.meta?.changes) || 0;
  if (changes) await markChanged(DB);
  let closed = 0;
  // What the list has of a charge: given, or there and giving nothing (refunded)
  const givesNow = Object.assign((c) => byId.has(c) && gives(byId.get(c)), { present: (c) => byId.has(c) });
  if (ask && String(env.ZEFFY_API_KEY || '').trim()) for (const { t, id, ids } of lost.slice(0, GONE_PER_RUN)) closed += await askZeffy(env, t, id, ids, { now, fetchImpl, gives: givesNow });
  return { added, closed };
}

/**
 * A charge of a To thank the donor list lost, asked of Zeffy. Refunded or failed there, or gone (twice, hours apart):
 * that charge is settled, off the To thank; when nothing of it is given any more (`gives`: what the list has), it
 * closes. Zeffy has it: back in the list (a read that missed it), and it stays. → 1 when it closed
 */
async function askZeffy(env, t, id, ids, { now, fetchImpl, gives = Object.assign(() => false, { present: () => false }) }) {
  const { DB } = env;
  const at = iso(now);
  const settle = async (gone) => {
    await markChanged(DB);
    const rest = ids.filter((c) => c !== id);
    // Nothing else of it, or only charges the list has that give nothing (refunded): closed
    if (rest.every((c) => gives.present(c) && !gives(c))) {
      await DB.prepare("UPDATE donor_thanks SET state = 'gone', gone = ?, done_at = ?, asked_at = ? WHERE id = ? AND state = 'todo'").bind(gone, at, at, t.id).run();
      return 1;
    }
    // Others of it still given, or still to ask about: this one is off it, and the next lost one is asked about afresh
    await DB.prepare("UPDATE donor_thanks SET ids = ?, missing_at = NULL, missing_id = NULL, asked_at = ? WHERE id = ? AND state = 'todo'").bind(rest.join(' '), at, t.id).run();
    return 0;
  };
  try {
    const p = await zeffyGet(env, `/payments/${encodeURIComponent(id)}`, {}, fetchImpl);
    const status = String(p?.status || '').toLowerCase();
    if (p?.refund_status === 'full' || (status && status !== 'succeeded')) return await settle(p?.refund_status === 'full' ? 'refunded' : 'failed');
    // Zeffy has it: back in the list (a read that missed it), and it stays To thank
    await noteDonorPayment(env, p, { now, thanks: false });
    await DB.prepare('UPDATE donor_thanks SET missing_at = NULL, missing_id = NULL, asked_at = ? WHERE id = ?').bind(at, t.id).run();
    return 0;
  } catch (e) {
    if (e.status !== 404) { await DB.prepare('UPDATE donor_thanks SET asked_at = ? WHERE id = ?').bind(at, t.id).run(); return 0; }
    // Gone: only the second answer, hours after the first, settles it
    // (both answers about this one charge: another charge's earlier answer is never this one's first)
    const row = await DB.prepare('SELECT missing_at, missing_id FROM donor_thanks WHERE id = ?').bind(t.id).first();
    if (row?.missing_at && row.missing_id === id && now - Date.parse(row.missing_at) >= GONE_ASK_MS) return await settle('deleted');
    const first = row?.missing_id === id && row?.missing_at ? row.missing_at : at;
    await DB.prepare('UPDATE donor_thanks SET missing_at = ?, missing_id = ?, asked_at = ? WHERE id = ?').bind(first, id, at, t.id).run();
    return 0;
  }
}

// ─── Reading and saying ─────────────────────────────────────────────

const SHOW = 'id, ids, state, why, at, cents, in_kind, name, company, campaign, how, contact, created_at, done_by, done_at, gone';
/** Every gift still To thank, the one waiting longest first (since it came to the site, not the date on it) */
export async function thanksToDo(DB) {
  await ensureThanks(DB);
  return (await DB.prepare(`SELECT ${SHOW} FROM donor_thanks WHERE state = 'todo' ORDER BY created_at ASC, at ASC`).all()).results || [];
}
/** How many are waiting (the Donors list's count) */
export async function thanksCount(DB) {
  await ensureThanks(DB);
  return Number((await DB.prepare("SELECT COUNT(*) AS n FROM donor_thanks WHERE state = 'todo'").first())?.n) || 0;
}
/**
 * Something in Donors & Partners changed (a person's answer, a thank-you said or kept up by the sync, a merge): the
 * count every open tab compares, so each reads its lists again, whoever changed it
 */
export async function markChanged(DB) {
  // (the mark it moved to: the tab that made the change knows that one is its own, and any other is someone else's)
  const r = await DB.prepare("INSERT INTO donor_state (key, value) VALUES ('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value").first();
  return Number(r?.value) || null;
}
/** What To thank is, as a mark that changes with every change (markChanged) */
export async function thanksMark(DB) {
  await ensureThanks(DB);
  const [rev, n] = await Promise.all([
    DB.prepare("SELECT value FROM donor_state WHERE key = 'rev'").first().catch(() => null),
    thanksCount(DB),
  ]);
  return `${rev?.value || 0}|${n}`;
}
/** The thank-you of each charge given: Map charge id → { id, state, why, by, at, gone } */
export async function thanksFor(DB, chargeIds) {
  await ensureThanks(DB);
  const out = new Map();
  const want = new Set(chargeIds.map(String));
  if (!want.size) return out;
  // Few rows: read whole (a gift's charges are in one row's ids, which a lookup by id can't find)
  for (const t of (await DB.prepare(`SELECT ${SHOW} FROM donor_thanks`).all()).results || []) {
    for (const c of chargesOf(t)) if (want.has(c)) out.set(c, { id: t.id, state: t.state, why: t.why, by: t.state === 'todo' ? null : t.done_by || null, at: t.done_at || null, gone: t.gone || null, cents: t.cents, inKind: t.in_kind, how: t.how || null, ids: chargesOf(t) });
  }
  return out;
}

const SAID = { thanked: 'Thanked', skipped: 'No thank-you needed', todo: 'To thank' };
/**
 * A person says: thanked, not needed, or (Undo) To thank again. `id`: the thank-you's own id, or any charge of its
 * gift. `was`: the state the person saw. Someone else said otherwise since (another tab, a teammate): nothing changes,
 * and they're told who said what (409). → the row as it was
 */
// Why a thank-you closed by itself, as a person trying to mark it is told
const GONE_SAID = {
  refunded: 'That gift was refunded in Zeffy, so there’s no thank-you to say.',
  failed: 'That payment didn’t go through in Zeffy, so there’s no thank-you to say.',
  deleted: 'That gift was taken out of Zeffy, so there’s no thank-you to say.',
  changed: 'Zeffy shows that gift changed since (moved to another giver, or entered again another way), so this thank-you closed. Reload to see it as it is now.',
};

export async function markThanks(DB, { id, state, was = null }, by, { now = Date.now() } = {}) {
  await ensureThanks(DB);
  if (!['thanked', 'skipped', 'todo'].includes(state)) throw Object.assign(new Error('Thanked, not needed, or To thank'), { status: 400 });
  const want = String(id || '');
  const t = (await DB.prepare(`SELECT ${SHOW} FROM donor_thanks WHERE id = ?`).bind(want).first())
    || await DB.prepare(`SELECT ${SHOW} FROM donor_thanks WHERE instr(' ' || ids || ' ', ?) > 0`).bind(` ${want} `).first();
  if (!t) throw Object.assign(new Error('That gift has no thank-you to say. Reload and look again.'), { status: 404 });
  if (t.state === 'gone') throw Object.assign(new Error(GONE_SAID[t.gone] || GONE_SAID.deleted), { status: 409 });
  const who = (e) => { const n = String(e || '').split('@')[0]; return n ? `${n[0].toUpperCase()}${n.slice(1)}` : ''; };
  const changed = (x) => Object.assign(new Error(`${x.done_by && by && x.done_by === by ? 'You said ' : x.done_by ? `${who(x.done_by)} said ` : 'Someone said '}“${SAID[x.state] || x.state}”${x.done_by && x.done_by === by ? ' in another tab' : ''} since you looked. Nothing was changed.`), { status: 409, state: x.state });
  // Already what was asked (a second click, a teammate who said the same): nothing changes, and nothing to log or undo
  if (t.state === state) return { ...t, same: true };
  if (was && t.state !== was) throw changed(t);
  // Who put it back To thank (Undo) is kept too, so a later "since you looked" can say who
  const r = await DB.prepare('UPDATE donor_thanks SET state = ?, done_by = ?, done_at = ? WHERE id = ? AND state = ?')
    .bind(state, by || null, state === 'todo' ? null : iso(now), t.id, t.state).run();
  if (!r.meta?.changes) {
    const now2 = await DB.prepare(`SELECT ${SHOW} FROM donor_thanks WHERE id = ?`).bind(t.id).first() || t;
    if (now2.state === state) return { ...now2, same: true };
    throw changed(now2);
  }
  return t;
}
