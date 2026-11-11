/**
 * Reveal sign-ups live in Kit
 * ===========================
 * Peter, Nov 10 2026: "why wouldn't a sub for reveal emails get put into a
 * segment or tag in kit and be a part of that group". Someone who signs up on
 * the site for reveal emails (/api/reminders) is put in Kit with a tag, and
 * every reveal email is one Kit email: nobody on the list and the sign-ups
 * gets two, and there is one unsubscribe. Resend only sends the one "You're on
 * the list" email, because Kit can't email one person.
 *
 * Who has which tag (names in ./_kit.js):
 *   every reveal                         REVEAL_TAG
 *   just one kid's reveal                REVEAL_KID_TAG(slug)
 *   + new to Kit, or had left it         REVEAL_ONLY_TAG (newsletters leave them out)
 *   + and just one kid                   REVEAL_ONE_TAG  (the whole list's reveal emails leave them out too)
 * They asked for reveal emails, not the newsletter (Peter, Nov 10 2026: "do
 * it!" to "reveal emails only"), so someone new gets reveal emails and
 * nothing else; someone already on the newsletter keeps it.
 *
 * Which reveal email goes to whom, one email each:
 *   the whole-list invite                 wholeListFilter: everyone but waitlist-only and one-reveal-only people
 *   their kid's date and new date         oneRevealFilter: the one-reveal-only people of that kid (the rest
 *                                         hear the date through the whole-list invite)
 *   the day before, an hour before,       signupsFilter: every-reveal sign-ups and that kid's, from Kit by
 *   "we're live", the replay              itself; the whole list's "we're live" and replay leave out exactly
 *                                         the tags those went to (_broadcast.js signupsCovered), so nobody gets two
 *
 * The site's D1 row (broadcast_reminders, channel 'email') is the sign-up
 * itself: the address, which reveal, and the token in its Stop link. This
 * table is where Kit stands for each one. A sign-up reaches Kit at once, and
 * the heartbeat (syncSignups) retries any that didn't and carries out Stops.
 * Someone Kit has as unsubscribed is never put back by the site: Kit emails
 * them its own "confirm your subscription", and only their tap brings them back.
 */

import {
  kitConfigured, kitUpsertSubscriber, kitTagId, kitFindTagId, kitTagSubscriberId, kitUntagSubscriber, kitUnsubscribe,
  kitSubscriberTagIds, kitAskToConfirm, kitFindSubscribers,
  WAITLIST_ONLY_TAG, REVEAL_TAG, REVEAL_ONLY_TAG, REVEAL_ONE_TAG, REVEAL_KID_TAG,
} from './_kit.js';

/** The applications waitlist's tag (./_application-waitlist.js): a family on it is kept in Kit for the opening email */
const WAITLIST_TAG = 'Application Waitlist';

const SCHEMA = `CREATE TABLE IF NOT EXISTS reveal_signup_kit (
  reminder_id TEXT PRIMARY KEY, kit_id INTEGER, kit_state TEXT, only_reveals INTEGER DEFAULT 0,
  scope TEXT, synced_at TEXT, stopped_at TEXT, error TEXT, tries INTEGER DEFAULT 0,
  next_try_at INTEGER, alerted_at TEXT, updated_at TEXT, asked_at TEXT)`;
// scope: what Kit has now, 'all' or the kid's slug. only_reveals: they came for reveal emails, not the newsletter
// (kept from the first answer Kit gave, so a first sync that fails halfway still knows they were new).
// asked_at: when Kit was last asked to send them its "confirm your subscription".

/** Kit won't email these yet: someone who left or bounced, or never confirmed, is asked to confirm; a complaint is final */
const ASK_AGAIN = new Set(['cancelled', 'bounced', 'inactive']);
/** They had left Kit's list: back for reveal emails, not the newsletter they left */
const LEFT = new Set(['cancelled', 'bounced']);
// A sign-up that couldn't reach Kit is tried again after these waits; staff hear after the last
export const SYNC_RETRY_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3];
export const ALERT_AFTER_TRIES = 4;
// A sign-up younger than this with nothing in the table yet is the form's own, still on its way to Kit
const FRESH_MS = 90e3;
const RUN_EVERY_MS = 55e3;

const _ready = new WeakSet();
export async function ensureSignupKitSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const scopeOf = (row) => row?.kid_slug || 'all';

async function readKit(DB, reminderId) {
  await ensureSignupKitSchema(DB);
  return DB.prepare('SELECT * FROM reveal_signup_kit WHERE reminder_id = ?').bind(reminderId).first();
}

async function writeKit(DB, reminderId, fields, now = Date.now()) {
  await ensureSignupKitSchema(DB);
  const was = (await readKit(DB, reminderId)) || {};
  const r = { ...was, ...fields, reminder_id: reminderId, updated_at: nowIso(now) };
  await DB.prepare(`INSERT OR REPLACE INTO reveal_signup_kit
    (reminder_id, kit_id, kit_state, only_reveals, scope, synced_at, stopped_at, error, tries, next_try_at, alerted_at, updated_at, asked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.reminder_id, r.kit_id ?? null, r.kit_state ?? null, r.only_reveals ? 1 : 0, r.scope ?? null, r.synced_at ?? null,
      r.stopped_at ?? null, r.error ?? null, Number(r.tries) || 0, r.next_try_at ?? null, r.alerted_at ?? null, r.updated_at, r.asked_at ?? null)
    .run();
  return r;
}

/** A fixed reveal tag's id, made the first time (its name is in code). null: Kit didn't answer */
const made = (env, name) => kitTagId(env, name, { create: true });
/** Any other tag's id, only looked up: { ok: false } when Kit didn't answer, { ok: true, id: null } when it has none */
const found = (env, name) => kitFindTagId(env, name);

async function failed(DB, row, error, now) {
  const was = (await readKit(DB, row.id)) || {};
  const tries = (Number(was.tries) || 0) + 1;
  const wait = SYNC_RETRY_MS[Math.min(tries - 1, SYNC_RETRY_MS.length - 1)];
  await writeKit(DB, row.id, { error: String(error).slice(0, 300), tries, next_try_at: now + wait }, now);
  return { ok: false, error: String(error), tries };
}

/**
 * Put one sign-up in Kit as its D1 row says: the address, with the tags for
 * its reveal. Runs on sign-up (so the form can say "check your email" to
 * someone Kit holds) and on the heartbeat. Never throws.
 * @returns {Promise<{ok: boolean, pending?: boolean, state?: string, error?: string}>}
 *   pending: Kit has them as unsubscribed, and emailed them its own confirmation
 */
export async function syncSignup(env, row, { now = Date.now(), askAgain = true } = {}) {
  const { DB } = env;
  if (!row || row.channel !== 'email') return { ok: false, error: 'not an email sign-up' };
  if (!kitConfigured(env)) return failed(DB, row, 'KIT_API_KEY is not set', now);
  try {
    let was = (await readKit(DB, row.id)) || {};
    const want = scopeOf(row);
    const sub = await kitUpsertSubscriber(env, row.address);
    if (!sub.ok) return failed(DB, row, sub.error, now);
    // Kept at once: if what follows fails, the next try still knows Kit made them just now (Kit says 200 then)
    if (sub.created || LEFT.has(sub.state)) was = await writeKit(DB, row.id, { kit_id: sub.id, only_reveals: true }, now);
    // Kit never emails someone who marked its mail as spam, and the site doesn't ask them
    if (sub.state === 'complained') {
      await writeKit(DB, row.id, { kit_id: sub.id, kit_state: sub.state, scope: want, synced_at: nowIso(now), stopped_at: null, error: null, tries: 0, next_try_at: null }, now);
      return { ok: true, state: sub.state };
    }
    const had = sub.created ? [] : await kitSubscriberTagIds(env, sub.id);
    if (had === null) return failed(DB, row, 'Kit: could not read the subscriber’s tags', now);
    const [all, only, one, wait, list] = await Promise.all([made(env, REVEAL_TAG), made(env, REVEAL_ONLY_TAG), made(env, REVEAL_ONE_TAG), found(env, WAITLIST_ONLY_TAG), found(env, WAITLIST_TAG)]);
    if (!all || !only || !one || !wait.ok || !list.ok) return failed(DB, row, 'Kit: could not find or make the reveal sign-up tags', now);
    const kid = want === 'all' ? null : await made(env, REVEAL_KID_TAG(want));
    if (want !== 'all' && !kid) return failed(DB, row, `Kit: could not find or make the tag for ${want}`, now);
    const has = (id) => !!id && had.includes(Number(id));
    // Reveal emails and no newsletter: new to Kit or had left it (saved above, kept until Kit has the tag), or
    // only ever on the waitlist. Once Kit has had the tag, Kit decides: joining the newsletter takes it off there.
    const onlyReveals = !!sub.created || LEFT.has(sub.state) || has(only) || has(wait.id) || (!!was.only_reveals && !was.synced_at);

    const add = [want === 'all' ? all : kid, ...(onlyReveals ? [only] : []), ...(onlyReveals && want !== 'all' ? [one] : [])];
    for (const id of add) {
      if (!(await kitTagSubscriberId(env, id, sub.id))) return failed(DB, row, 'Kit: could not tag the subscriber', now);
    }
    // What no longer fits: one kid's tag once it's every reveal (or a different kid), "one reveal only" once it isn't,
    // and "waitlist only", since reveal emails now reach them (REVEAL_ONLY_TAG still keeps the newsletter away)
    const drop = new Set();
    if (want === 'all' || !onlyReveals) drop.add(Number(one));
    if (want !== 'all') drop.add(Number(all));
    if (was.scope && was.scope !== 'all' && was.scope !== want) {
      const old = await found(env, REVEAL_KID_TAG(was.scope));
      if (old.ok && old.id) drop.add(Number(old.id));
    }
    if (onlyReveals && wait.id) drop.add(Number(wait.id));
    for (const id of drop) if (has(id)) await kitUntagSubscriber(env, id, sub.id);

    // Kit won't email them yet: Kit's own confirmation, when this sign-up may ask (a function decides: the per-address limit)
    let pending = false;
    if (ASK_AGAIN.has(sub.state) && (typeof askAgain === 'function' ? await askAgain() : askAgain)) {
      pending = await kitAskToConfirm(env, row.address);
      if (pending) await writeKit(DB, row.id, { asked_at: nowIso(now) }, now);
    }
    await writeKit(DB, row.id, { kit_id: sub.id, kit_state: sub.state, only_reveals: onlyReveals, scope: want, synced_at: nowIso(now), stopped_at: null, error: null, tries: 0, next_try_at: null, alerted_at: null }, now);
    return { ok: true, state: sub.state, pending };
  } catch (err) {
    return failed(DB, row, `Kit: ${err.message}`, now);
  }
}

/**
 * Someone pressed Stop (the link in "You're on the list", or their mail app's
 * one-click unsubscribe): their reveal tags come off, and someone who was only
 * in Kit for reveal emails is unsubscribed there, so nothing at all reaches
 * them. Someone on the newsletter keeps it. Never throws.
 */
export async function stopSignup(env, row, { now = Date.now() } = {}) {
  const { DB } = env;
  try {
    const was = await readKit(DB, row.id);
    if (!was || was.stopped_at) return { ok: true, nothing: !was };
    let id = was.kit_id;
    if (!id) {
      const look = await kitFindSubscribers(env, [row.address]);
      if (!look.ok) return failed(DB, row, look.error, now);
      id = look.byEmail.get(String(row.address).toLowerCase())?.id || null;
    }
    if (id) {
      const had = await kitSubscriberTagIds(env, id);
      if (had === null) return failed(DB, row, 'Kit: could not read the subscriber’s tags', now);
      // Every reveal tag they could have: what Kit was last told, and what the sign-up asks for (a first trip that
      // failed halfway may have left the kid's tag on before the site wrote its scope down)
      const kids = [...new Set([was.scope, row.kid_slug].filter((x) => x && x !== 'all'))];
      const names = [REVEAL_TAG, REVEAL_ONE_TAG, ...kids.map(REVEAL_KID_TAG)];
      const [only, list, ...reveal] = await Promise.all([found(env, REVEAL_ONLY_TAG), found(env, WAITLIST_TAG), ...names.map((n) => found(env, n))]);
      if (![only, list, ...reveal].every((t) => t.ok)) return failed(DB, row, 'Kit: could not look up the reveal tags', now);
      for (const t of reveal) {
        if (t.id && had.includes(Number(t.id)) && !(await kitUntagSubscriber(env, t.id, id))) return failed(DB, row, 'Kit: could not take the reveal tag off', now);
      }
      // Kit's own tags decide, not what the site remembers: someone who has since joined the newsletter keeps it.
      // A first trip to Kit that failed before the "only" tag landed still counts as reveal emails only.
      const revealOnly = (only.id && had.includes(Number(only.id))) || (!!was.only_reveals && !was.synced_at);
      if (revealOnly) {
        if (list.id && had.includes(Number(list.id))) {
          // A family waiting for applications to open keeps that one email, and nothing else: the waitlist-only
          // tag goes back on before "reveal emails only" comes off, so they're never left on the newsletter
          const wait = await made(env, WAITLIST_ONLY_TAG);
          if (!wait || !(await kitTagSubscriberId(env, wait, id))) return failed(DB, row, 'Kit: could not put the waitlist-only tag back', now);
          if (only.id) await kitUntagSubscriber(env, only.id, id);
        } else {
          const out = await kitUnsubscribe(env, id);
          if (!out.ok && !out.gone) return failed(DB, row, `Kit: ${out.error}`, now);
        }
      }
    }
    await writeKit(DB, row.id, { stopped_at: nowIso(now), error: null, tries: 0, next_try_at: null }, now);
    return { ok: true };
  } catch (err) {
    return failed(DB, row, `Kit: ${err.message}`, now);
  }
}

/**
 * The heartbeat's part: sign-ups not in Kit yet (or for another reveal than
 * Kit has), and Stops not carried out yet, a few at a time (Kit allows 120
 * calls a minute, shared). Staff hear once about one that keeps failing.
 * Never throws. → [{ id, ok, error? }]
 */
export async function syncSignups(env, { now = Date.now(), limit = 8, alert = null } = {}) {
  const { DB } = env;
  if (!DB || !kitConfigured(env)) return [];
  try {
    await ensureSignupKitSchema(DB);
    // Once a minute site-wide: heartbeats come every few seconds while a reveal is live, and two at once must never
    // work the same sign-ups (two of Kit's confirmations, twice the calls against Kit's 120 a minute)
    await DB.prepare('CREATE TABLE IF NOT EXISTS reveal_signup_runs (key TEXT PRIMARY KEY, at INTEGER NOT NULL)').run();
    await DB.prepare("INSERT OR IGNORE INTO reveal_signup_runs (key, at) VALUES ('sync', 0)").run();
    const turn = await DB.prepare("UPDATE reveal_signup_runs SET at = ? WHERE key = 'sync' AND at <= ?").bind(now, now - RUN_EVERY_MS).run();
    if (!(turn?.meta?.changes > 0)) return [];
    const { results } = await DB.prepare(`SELECT r.*, k.stopped_at AS k_stopped, k.tries AS k_tries, k.alerted_at AS k_alerted, k.asked_at AS k_asked
      FROM broadcast_reminders r LEFT JOIN reveal_signup_kit k ON k.reminder_id = r.id
      WHERE r.channel = 'email' AND (k.next_try_at IS NULL OR k.next_try_at <= ?)
        AND ((r.unsubscribed_at IS NULL AND (k.reminder_id IS NULL OR k.synced_at IS NULL OR k.stopped_at IS NOT NULL OR k.scope IS NOT COALESCE(r.kid_slug, 'all')))
          OR (r.unsubscribed_at IS NOT NULL AND k.reminder_id IS NOT NULL AND k.stopped_at IS NULL))
        -- a sign-up the form is still putting in Kit is left to it
        AND NOT (k.reminder_id IS NULL AND r.created_at > ?)
      ORDER BY (r.unsubscribed_at IS NULL), COALESCE(k.updated_at, r.created_at) LIMIT ?`).bind(now, nowIso(now - FRESH_MS), limit).all();
    const out = [];
    for (const row of results || []) {
      // Someone who signed up but Kit won't email is asked once to confirm, by Kit; never again by the heartbeat
      const r = row.unsubscribed_at ? await stopSignup(env, row, { now }) : await syncSignup(env, row, { now, askAgain: !row.k_asked });
      out.push({ id: row.id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      if (!r.ok && r.tries >= ALERT_AFTER_TRIES && !row.k_alerted && alert) {
        await alert({ level: 'warn', title: 'A reveal sign-up isn’t in Kit yet', detail: `Kit keeps refusing it (${r.error}). They won't get reveal emails until it's in. The site keeps trying; check the Kit connection in Site Config → Newsletter.` }).catch(() => {});
        await writeKit(DB, row.id, { alerted_at: nowIso(now) }, now);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Who each reveal email goes to ──────────────────────────────────
// Kit subscriber filters. Built only from lookups Kit answered: null means
// Kit couldn't say, and the caller tries again, so a reveal email never goes
// out aimed wider than meant.

const tagFilter = (ids) => ({ type: 'tag', ids: ids.map(Number) });
const ALL = [{ type: 'all_subscribers' }];

/** The tag ids of everyone signed up for this kid's reveal (every reveal, and the kid's own); null: Kit couldn't say */
export async function signupTagIds(env, kidSlug) {
  const [all, kid] = await Promise.all([made(env, REVEAL_TAG), kidSlug ? found(env, REVEAL_KID_TAG(kidSlug)) : { ok: true, id: null }]);
  return all && kid.ok ? [all, kid.id].filter(Boolean).map(Number) : null;
}

/**
 * The whole list's reveal emails: everyone, but not the families waiting
 * only for applications, nor people who asked for one reveal only (their
 * kid's come to them on their own), nor any `leaveOut` tag.
 */
export async function wholeListFilter(env, { leaveOut = [] } = {}) {
  const [wait, one] = await Promise.all([found(env, WAITLIST_ONLY_TAG), made(env, REVEAL_ONE_TAG)]);
  if (!wait.ok || !one) return null;
  const none = [wait.id, one, ...leaveOut].filter(Boolean);
  return [{ all: ALL, any: null, none: [tagFilter(none)] }];
}

/** Everyone who signed up for this kid's reveal: every-reveal sign-ups and the kid's own. null: Kit couldn't say */
export async function signupsFilter(env, kidSlug) {
  const ids = await signupTagIds(env, kidSlug);
  return ids ? [{ all: null, any: [tagFilter(ids)], none: null }] : null;
}

/**
 * This kid's one-reveal-only sign-ups, whom the whole-list invite leaves out.
 * undefined: nobody has signed up for this kid alone; null: Kit couldn't say.
 */
export async function oneRevealFilter(env, kidSlug) {
  if (!kidSlug) return undefined;
  const [kid, one] = await Promise.all([found(env, REVEAL_KID_TAG(kidSlug)), made(env, REVEAL_ONE_TAG)]);
  if (!kid.ok || !one) return null;
  return kid.id ? [{ all: [tagFilter([kid.id]), tagFilter([one])], any: null, none: null }] : undefined;
}

/**
 * Is Kit's copy still aimed the way the site aimed it (everyone, leaving some
 * tags out), rather than at a group someone picked in Kit? Then a rewrite may
 * aim it again with today's leave-outs. Kit writes "everyone" as nothing or
 * as all_subscribers.
 */
export function aimedBySite(b) {
  return !(b?.subscriber_filter || []).some((g) => [...(g?.all || []), ...(g?.any || [])].some((e) => e?.type !== 'all_subscribers'));
}

/** The tag ids a filter leaves out, sorted, to tell whether Kit's copy is aimed as today's would be */
export const leftOut = (filter) => [...new Set((filter || []).flatMap((g) => (g?.none || []).flatMap((e) => (e?.ids || []).map(Number))))].sort((a, b) => a - b);
