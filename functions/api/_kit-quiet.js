/**
 * Quiet subscribers in Kit (Site Config → Newsletter)
 * =====================================================================
 * People who haven't opened or clicked anything in 90 days drag down where
 * everyone else's mail lands (Gmail and Outlook judge a sender by how much
 * of its mail is ignored), and Kit bills for them. While the switch is on,
 * once a day after 10am Eastern:
 *
 *   1. Up to DAILY_MAX quiet people get "Do you still want our emails?".
 *      Store subscribers (the "Sunny & Ranney" tag) get the store's version
 *      from a confirmed @sunnyandranney.com address; everyone else, SOARD's.
 *   2. A week later, the ones who haven't opened or clicked since get
 *      "Last call".
 *   3. Three weeks after the first email, anyone who opened or clicked
 *      anything since stays; the rest are unsubscribed in Kit (never
 *      deleted: they stop counting toward the bill and can rejoin any time).
 *
 * Never asked: families waiting for applications to open, the board, anyone
 * who joined Kit under 90 days ago, and anyone Kit sent fewer than two emails
 * in those 90 days (they had nothing to open).
 *
 * How Kit is driven, with the site's API key (bulk calls and deleting a tag
 * need OAuth, so neither is used):
 *   - IN_TAG marks everyone in their three weeks, so one filter call finds
 *     who in the window opened or clicked (Kit's per-person stats).
 *   - SEND_TAGS[brand] holds exactly one email's recipients while it sends:
 *     tag them, schedule the broadcast to that tag, wait until Kit says it's
 *     completed, untag them. One send per brand at a time.
 *   - Each minute's tick does at most BUDGET Kit calls (Kit allows 120 a
 *     minute per key, shared with signups and the waitlist).
 *
 * Ships OFF, like every automation that emails people outside SOARD:
 * nothing is sent until staff turn it on. maybeRunQuiet never throws.
 */

import {
  kitConfigured, kitFetch, kitTagId, kitUntagSubscriber, kitCreateBroadcast, kitListBroadcasts,
  kitBroadcastStats, kitFilterSubscribers, kitUnsubscribe, WAITLIST_ONLY_TAG,
} from './_kit.js';

export const QUIET_DAYS = 90;          // no opens or clicks in this long
export const MIN_SENT = 2;             // ...while Kit sent them at least this many
export const DAILY_MAX = 300;          // new people a day, so no inbox sees a burst to quiet addresses
export const REMIND_DAYS = 7;
export const DECIDE_DAYS = 21;
export const START_HOUR_ET = 10;       // new groups start mid-morning Eastern
export const BUDGET = 40;              // Kit calls per tick
const SEND_DELAY_MS = 5 * 60 * 1000;   // Kit wants a send time a moment ahead
const LOCK_MS = 55 * 1000;
const DAY = 24 * 3600 * 1000;
const TZ = 'America/New_York';
export const STORE_TAG = 'Sunny & Ranney';
export const IN_TAG = 'Quiet check';
export const SEND_TAGS = { soard: 'Quiet check: sending SOARD', store: 'Quiet check: sending Sunny & Ranney' };
// Never asked: they're waiting for one email (applications opening) or run the place
export const PROTECTED_TAGS = ['Application Waitlist', WAITLIST_ONLY_TAG, 'Board'];
const SITES = {
  soard: { name: 'SOARD', url: 'https://sunshineonaranneyday.com/', label: 'sunshineonaranneyday.com', about: 'the kids we serve and the rooms we build' },
  store: { name: 'Sunny & Ranney', url: 'https://www.sunnyandranney.com/', label: 'sunnyandranney.com', about: 'new arrivals, in-store events and sales' },
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kit_quiet_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kit_quiet_groups (
     day TEXT NOT NULL, brand TEXT NOT NULL, started_at INTEGER NOT NULL, stage TEXT NOT NULL, step TEXT,
     first_id INTEGER, reminder_id INTEGER, pending_at INTEGER, PRIMARY KEY (day, brand))`,
  `CREATE TABLE IF NOT EXISTS kit_quiet_people (
     subscriber_id INTEGER NOT NULL, day TEXT NOT NULL, brand TEXT NOT NULL,
     joined INTEGER NOT NULL DEFAULT 0, sending INTEGER NOT NULL DEFAULT 0,
     outcome TEXT, decided_at INTEGER, PRIMARY KEY (subscriber_id, day))`,
];
const _ready = new WeakSet();
async function ready(DB) {
  if (_ready.has(DB)) return;
  for (const s of SCHEMA) await DB.prepare(s).run();
  _ready.add(DB);
}

const get = async (DB, key) => (await DB.prepare('SELECT value FROM kit_quiet_runtime WHERE key = ?').bind(key).first())?.value ?? null;
const set = (DB, key, value, now = Date.now()) =>
  DB.prepare('INSERT OR REPLACE INTO kit_quiet_runtime (key, value, updated_at) VALUES (?, ?, ?)').bind(key, value == null ? null : String(value), now).run();

/** One tick at a time: one statement takes the lock only if it's free (or stale), so two can't both win. */
async function claim(DB, now) {
  const r = await DB.prepare(
    `INSERT INTO kit_quiet_runtime (key, value, updated_at) VALUES ('lock', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE CAST(kit_quiet_runtime.value AS INTEGER) <= ?`).bind(String(now + LOCK_MS), now, now).run();
  return (r.meta?.changes || 0) > 0;
}
const release = (DB) => DB.prepare("DELETE FROM kit_quiet_runtime WHERE key = 'lock'").run();

/** Eastern date (YYYY-MM-DD) and hour */
export function eastern(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// ─── The words (approved by Peter, Nov 3 2026) ────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** One of the two emails for one brand. Kit fills in the first name. */
export function quietEmail(brand, which) {
  const w = SITES[brand] || SITES.soard;
  const first = which === 'first';
  const subject = first ? 'Do you still want our emails?' : 'Last call: stay on our list?';
  const preview = first ? 'One click keeps you on the list.' : 'One click keeps you on the list. Otherwise this is goodbye.';
  const lead = first
    ? `It's been a while since you opened one of our emails, and we don't want to crowd your inbox. If you'd like to keep hearing about ${w.about}, click below. That's all it takes.`
    : `A quick reminder: if you'd like to keep hearing about ${w.about}, click below. That's all it takes.`;
  const after = `If we don't hear from you in the next ${first ? 'three' : 'two'} weeks, we'll take you off the list. You can always rejoin at ${w.label}.`;
  const p = (t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${t}</p>`;
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;color:#2D2E33;max-width:560px;">
${p('Hi {{ subscriber.first_name | default: "there" }},')}
${p(esc(lead))}
<p style="margin:8px 0 24px;"><a href="${esc(w.url)}" style="display:inline-block;background:#FFDA24;color:#2D2E33;font-weight:700;text-decoration:none;padding:14px 24px;border-radius:10px;font-size:16px;">Yes, keep me on the list</a></p>
${p(esc(after))}
${p(esc(`Thank you for being part of ${w.name}.`))}
</div>`;
  return { subject, preview, html };
}

// ─── Who is quiet ─────────────────────────────────────────────────────
/** Kit's filter for today's candidates: active, here 90+ days, sent 2+ emails in those 90 days, with their stats */
export function candidateFilter(now) {
  const since = ymd(now - QUIET_DAYS * DAY);
  const today = ymd(now);
  return {
    all: [
      { type: 'subscriber_state', states: ['active'] },
      { type: 'subscribed', before: since },
      { type: 'sent', count_greater_than_or_equal: MIN_SENT, after: since, before: today },
    ],
    include: [{ type: 'tags' }, { type: 'stats', range: { start: since, end: today } }],
  };
}

const opened = (s) => Number(s?.stats?.opened || 0) > 0 || Number(s?.stats?.clicked || 0) > 0;

/**
 * Of Kit's candidates, the ones to ask today: no opens or clicks (counted
 * here from Kit's stats), not protected, not already in a check-in, store or
 * SOARD by their tags. `storeOk` false leaves store subscribers for later.
 */
export function pickNew(candidates, { inWindow = new Set(), max = DAILY_MAX, storeOk = true } = {}) {
  const prot = new Set([...PROTECTED_TAGS, IN_TAG, ...Object.values(SEND_TAGS)].map(s => s.toLowerCase()));
  const out = [];
  for (const s of candidates) {
    if (out.length >= max) break;
    if (!s?.stats || opened(s) || Number(s.stats.sent || 0) < MIN_SENT) continue;
    const names = (s.tag_names || (s.tags || []).map(t => t.name) || []).map(n => String(n).toLowerCase());
    if (names.some(n => prot.has(n))) continue;
    const id = Number(s.id);
    if (!Number.isFinite(id) || inWindow.has(id)) continue;
    const brand = names.includes(STORE_TAG.toLowerCase()) ? 'store' : 'soard';
    if (brand === 'store' && !storeOk) continue;
    out.push({ id, brand });
  }
  return out;
}

/** The store's sending address: a confirmed one on sunnyandranney.com, else null */
export async function storeFrom(env) {
  try {
    const res = await kitFetch(env, '/account');
    const body = await res.json().catch(() => ({}));
    const a = (body.account?.sending_addresses || []).find(x => /@sunnyandranney\.com$/i.test(x.email_address || '')
      && (x.status ? x.status === 'confirmed' : true) && x.is_verified !== false);
    return a ? a.email_address : null;
  } catch { return null; }
}

// ─── Status & switch (for /api/kit-quiet-admin) ───────────────────────
export async function quietStatus(env) {
  const DB = env.DB; await ready(DB);
  const counts = await DB.prepare(`SELECT
      SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN outcome = 'kept' THEN 1 ELSE 0 END) AS kept,
      SUM(CASE WHEN outcome = 'unsubscribed' THEN 1 ELSE 0 END) AS unsubscribed
    FROM kit_quiet_people`).first();
  return {
    on: (await get(DB, 'on')) === '1', configured: kitConfigured(env),
    lastDay: await get(DB, 'last_day'), lastError: await get(DB, 'last_error'),
    waiting: counts?.waiting || 0, kept: counts?.kept || 0, unsubscribed: counts?.unsubscribed || 0,
    storeAddress: kitConfigured(env) ? await storeFrom(env) : null,
    dailyMax: DAILY_MAX, quietDays: QUIET_DAYS, decideDays: DECIDE_DAYS,
  };
}

export async function setQuietOn(env, on, user) {
  const DB = env.DB; await ready(DB);
  await set(DB, 'on', on ? '1' : '0');
  await set(DB, 'switched_by', `${user || 'admin'} ${new Date().toISOString()}`);
  return quietStatus(env);
}

// ─── The run ───────────────────────────────────────────────────────────
/** Called every minute by the heartbeat. Never throws. */
export async function maybeRunQuiet(env, { now = Date.now() } = {}) {
  const DB = env?.DB;
  if (!DB || !kitConfigured(env)) return { ran: false, why: 'not configured' };
  try {
    await ready(DB);
    if ((await get(DB, 'on')) !== '1') return { ran: false, why: 'off' };
    if (!(await claim(DB, now))) return { ran: false, why: 'busy' };
    try {
      const r = await tick(env, now);
      if (r.ran) await set(DB, 'last_error', null, now);
      return r;
    } finally { await release(DB); }
  } catch (err) {
    console.error('Quiet subscribers:', err);
    try { await set(DB, 'last_error', `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${String(err.message || err).slice(0, 300)}`, now); } catch {}
    return { ran: false, why: 'error', error: err.message };
  }
}

/** One slice of work: move the first group that can move, else start today's groups. */
async function tick(env, now) {
  const DB = env.DB;
  const tags = await tagIds(env);
  const groups = (await DB.prepare("SELECT * FROM kit_quiet_groups WHERE stage != 'done' ORDER BY step IS NULL, day, brand").all()).results || [];
  for (const g of groups) {
    const did = await advance(env, tags, g, groups, now);
    if (did) return { ran: true, did };
  }
  const { day, hour } = eastern(now);
  if (hour < START_HOUR_ET) return { ran: false, why: 'before 10am' };
  if ((await get(DB, 'last_day')) === day) return { ran: false, why: 'done today' };
  const n = await startGroups(env, day, now);
  await set(DB, 'last_day', day, now);
  return { ran: true, did: `started ${n}` };
}

async function tagIds(env) {
  const ids = {};
  for (const [k, name] of [['in', IN_TAG], ['soard', SEND_TAGS.soard], ['store', SEND_TAGS.store]]) {
    ids[k] = await kitTagId(env, name, { create: true });
    if (!ids[k]) throw new Error(`Kit wouldn't give the tag "${name}"`);
  }
  return ids;
}

/** Tag one subscriber. gone: Kit has no such subscriber now. Any other failure throws (the tick tries again). */
async function tag(env, tagId, subscriberId) {
  const res = await kitFetch(env, `/tags/${tagId}/subscribers/${subscriberId}`, { method: 'POST', body: '{}' });
  if (res.ok) return { ok: true };
  if (res.status === 404) return { ok: false, gone: true };
  throw new Error(`Kit tagging ${subscriberId}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
}

const members = (DB, g, where, limit = BUDGET) =>
  DB.prepare(`SELECT subscriber_id FROM kit_quiet_people WHERE day = ? AND brand = ? AND ${where} LIMIT ?`).bind(g.day, g.brand, limit).all().then(r => (r.results || []).map(x => Number(x.subscriber_id)));
const mark = (DB, g, id, cols) => {
  const keys = Object.keys(cols);
  return DB.prepare(`UPDATE kit_quiet_people SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE subscriber_id = ? AND day = ?`).bind(...keys.map(k => cols[k]), id, g.day).run();
};
const setGroup = (DB, g, cols) => {
  Object.assign(g, cols);
  const keys = Object.keys(cols);
  return DB.prepare(`UPDATE kit_quiet_groups SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE day = ? AND brand = ?`).bind(...keys.map(k => cols[k]), g.day, g.brand).run();
};

/** Move one group by one slice. Returns what it did, or null when it can't move yet. */
async function advance(env, tags, g, groups, now) {
  const DB = env.DB;
  const age = now - g.started_at;
  switch (g.stage) {
    case 'join': {
      const ids = await members(DB, g, 'joined = 0 AND outcome IS NULL');
      if (!ids.length) { await setGroup(DB, g, { stage: 'first', step: null }); return `joined ${g.day} ${g.brand}`; }
      for (const id of ids) {
        const r = await tag(env, tags.in, id);
        await mark(DB, g, id, r.ok ? { joined: 1 } : { joined: 1, outcome: 'gone', decided_at: now });
      }
      return `joined ${ids.length} (${g.day} ${g.brand})`;
    }
    case 'first':
    case 'remind':
      return send(env, tags, g, groups, g.stage === 'first' ? 'first' : 'reminder', now);
    case 'wait1':
      if (age < REMIND_DAYS * DAY) return null;
      if (await keepEngaged(env, tags, g, now)) return `kept the ones who answered (${g.day} ${g.brand})`;
      await setGroup(DB, g, { stage: 'remind', step: null });
      return `last call next (${g.day} ${g.brand})`;
    case 'wait2':
      if (age < DECIDE_DAYS * DAY) return null;
      if (await keepEngaged(env, tags, g, now)) return `kept the ones who answered (${g.day} ${g.brand})`;
      await setGroup(DB, g, { stage: 'decide', step: null });
      return `deciding (${g.day} ${g.brand})`;
    case 'decide': {
      const ids = await members(DB, g, 'outcome IS NULL', Math.floor(BUDGET / 2));
      if (!ids.length) { await setGroup(DB, g, { stage: 'done' }); return `finished ${g.day} ${g.brand}`; }
      for (const id of ids) {
        const r = await kitUnsubscribe(env, id);
        if (!r.ok && !r.gone) throw new Error(`Kit didn't unsubscribe ${id}: ${r.error}`);
        await kitUntagSubscriber(env, tags.in, id);
        await mark(DB, g, id, { outcome: r.gone ? 'gone' : 'unsubscribed', decided_at: now });
      }
      return `unsubscribed ${ids.length} (${g.day} ${g.brand})`;
    }
    default:
      return null;
  }
}

/**
 * Who in the group opened or clicked anything since the first email: marked
 * kept and taken out of the check-in. True when it kept anyone (the caller
 * moves on next tick with fresh numbers).
 */
async function keepEngaged(env, tags, g, now) {
  const DB = env.DB;
  const found = await kitFilterSubscribers(env, {
    all: [{ type: 'tags', any: [{ type: 'ids', matching: [tags.in] }] }, { type: 'subscriber_state', states: ['active'] }],
    include: [{ type: 'stats', range: { start: ymd(g.started_at), end: ymd(now) } }],
  });
  if (!found.ok) throw new Error(`checking who answered (${g.day} ${g.brand}): ${found.error}`);
  const answered = new Set(found.subscribers.filter(opened).map(s => Number(s.id)));
  const open = await members(DB, g, 'outcome IS NULL', 100000);
  const keep = open.filter(id => answered.has(id)).slice(0, BUDGET);
  for (const id of keep) {
    await kitUntagSubscriber(env, tags.in, id);
    await mark(DB, g, id, { outcome: 'kept', decided_at: now });
  }
  return keep.length > 0;
}

const describe = (g, which) => `Quiet check ${g.day} ${g.brand === 'store' ? STORE_TAG : 'SOARD'} (${which === 'first' ? 'first email' : 'last call'})`;

/** Tag → schedule → wait until sent → untag. One send per brand at a time; safe across a crash. */
async function send(env, tags, g, groups, which, now) {
  const DB = env.DB;
  const sendTag = tags[g.brand];
  const idCol = which === 'first' ? 'first_id' : 'reminder_id';
  const done = which === 'first' ? 'wait1' : 'wait2';
  if (!g.step) {
    if (groups.some(o => o !== g && o.brand === g.brand && o.step)) return null; // the brand's send tag is busy
    const left = await members(DB, g, 'outcome IS NULL', 1);
    if (!left.length) { await setGroup(DB, g, { stage: done }); return `nobody to ask (${g.day} ${g.brand})`; }
    await setGroup(DB, g, { step: 'tag' });
    return `sending ${which} (${g.day} ${g.brand})`;
  }
  if (g.step === 'tag') {
    const ids = await members(DB, g, 'outcome IS NULL AND sending = 0');
    if (!ids.length) { await setGroup(DB, g, { step: 'create' }); return `tagged for ${which} (${g.day} ${g.brand})`; }
    for (const id of ids) {
      const r = await tag(env, sendTag, id);
      await mark(DB, g, id, r.ok ? { sending: 1 } : { outcome: 'gone', decided_at: now });
    }
    return `tagged ${ids.length} for ${which} (${g.day} ${g.brand})`;
  }
  if (g.step === 'create') {
    const description = describe(g, which);
    if (g.pending_at) {
      // A create that may have reached Kit before a crash: find it rather than send twice
      const list = await kitListBroadcasts(env);
      if (!list.ok) throw new Error(`checking Kit for the ${which} email: HTTP ${list.status}`);
      const hit = list.broadcasts.find(b => b.name === description && b.status !== 'cancelled');
      if (hit) { await setGroup(DB, g, { [idCol]: hit.id, pending_at: null, step: 'wait' }); return `found ${which} (${g.day} ${g.brand})`; }
    }
    let from = null;
    if (g.brand === 'store') {
      from = await storeFrom(env);
      if (!from) throw new Error('store emails wait for a confirmed @sunnyandranney.com sending address in Kit (Settings → Email)');
    }
    const msg = quietEmail(g.brand, which);
    await setGroup(DB, g, { pending_at: now });
    const r = await kitCreateBroadcast(env, {
      subject: msg.subject, previewText: msg.preview, description, html: msg.html,
      sendAt: new Date(now + SEND_DELAY_MS).toISOString(), audience: { type: 'tag', id: sendTag }, from,
    });
    if (!r.ok) {
      if (r.status) await setGroup(DB, g, { pending_at: null }); // Kit answered no: nothing was made
      throw new Error(`Kit didn't take the ${which} email (${g.day} ${g.brand}): ${r.error}`);
    }
    await setGroup(DB, g, { [idCol]: r.broadcast?.id || null, pending_at: null, step: 'wait' });
    return `scheduled ${which} (${g.day} ${g.brand})`;
  }
  if (g.step === 'wait') {
    const st = await kitBroadcastStats(env, g[idCol]);
    if (!st.ok) throw new Error(`checking the ${which} email: ${st.error}`);
    if (st.status === 'aborted') throw new Error(`Kit stopped the ${which} email (${g.day} ${g.brand})`);
    if (st.status !== 'completed') return null;
    await setGroup(DB, g, { step: 'untag' });
    return `${which} sent (${g.day} ${g.brand})`;
  }
  if (g.step === 'untag') {
    const ids = await members(DB, g, 'sending = 1');
    if (!ids.length) { await setGroup(DB, g, { step: null, stage: done }); return `${which} finished (${g.day} ${g.brand})`; }
    for (const id of ids) {
      await kitUntagSubscriber(env, sendTag, id);
      await mark(DB, g, id, { sending: 0 });
    }
    return `untagged ${ids.length} after ${which} (${g.day} ${g.brand})`;
  }
  return null;
}

/** Today's groups: Kit's candidates, the quiet ones among them, split by brand. */
async function startGroups(env, day, now) {
  const DB = env.DB;
  const found = await kitFilterSubscribers(env, candidateFilter(now));
  if (!found.ok) throw new Error(`finding quiet subscribers: ${found.error}`);
  const open = (await DB.prepare('SELECT subscriber_id FROM kit_quiet_people WHERE outcome IS NULL').all()).results || [];
  const storeOk = !!(await storeFrom(env));
  const picked = pickNew(found.subscribers, { inWindow: new Set(open.map(x => Number(x.subscriber_id))), storeOk });
  for (const brand of ['soard', 'store']) {
    const people = picked.filter(p => p.brand === brand);
    if (!people.length) continue;
    await DB.prepare('INSERT OR IGNORE INTO kit_quiet_groups (day, brand, started_at, stage) VALUES (?, ?, ?, ?)').bind(day, brand, now, 'join').run();
    for (const p of people) await DB.prepare('INSERT OR IGNORE INTO kit_quiet_people (subscriber_id, day, brand) VALUES (?, ?, ?)').bind(p.id, day, brand).run();
  }
  return picked.length;
}
