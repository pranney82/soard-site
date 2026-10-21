/**
 * Live broadcast state machine
 * ============================
 * The single source of truth for "what is the site showing about the live
 * reveal right now". State lives in D1 (site_config key "broadcast"),
 * settings in "broadcast-config", diagnostics in "broadcast-health".
 * Everything that changes state funnels through runTick() or adminAction()
 * so side effects fire exactly once.
 *
 * Concurrency: ticks arrive from the hub, webhooks, visitors and the admin,
 * on any number of isolates. Three guards keep them honest. A D1 lease lets
 * one tick (or admin command) run at a time; it lasts 15 s and a long tick
 * keeps extending it. Every state write bumps state.rev, and a tick saves
 * only over the copy it read (a phase change is saved before its side
 * effects run). Each one-time side effect takes a claim in D1
 * (broadcast_claims, broadcast_sends), so even two ticks that slip past the
 * lease can't post to Facebook or alert staff twice, and the go-live and
 * ended effects are retried on later ticks until claimed, so a tick cut off
 * after saving the phase change loses none of them.
 *
 * Phases
 *   idle       nothing planned
 *   scheduled  a reveal has a date; countdown + reminders are armed
 *   armed      within 30 min of the date; the hub polls fast
 *   live       Stream reports the input is receiving video
 *   ending     input dropped; 45 s grace so a cell hiccup doesn't end it
 *   replay     broadcast over; "Watch the replay" for replayHours, then idle
 *
 * Inputs: Stream's public lifecycle endpoint (authoritative), Cloudflare
 * Notification webhooks (a wake-up call that forces a lifecycle check), the
 * hub's timer ticks, and admin commands. A manual "banner only" override
 * (source: 'manual') still exists for the day Stream itself is down.
 *
 * Side effects: reminder sends (email / SMS / push, idempotent per
 * broadcast+kind+channel), Facebook API-mode live posts, replay detection +
 * captions + kid-page attach + rebuild, Kit drafts + the automatic Kit
 * "we're live" send, Slack/email alerts, the live feed watch (silent or
 * missing audio, frozen video, Facebook/YouTube not live: _broadcast-monitor.js),
 * analytics rows, audit log.
 */

import { logAudit } from './_audit.js';
import * as stream from './_stream-live.js';
import * as notify from './_broadcast-notify.js';
import * as fb from './_broadcast-fb.js';
import { attachToKid, matchKids } from './_fb-archive.js';
import { kitConfigured, kitCreateBroadcast, kitUpdateDraft } from './_kit.js';
import * as reels from './_broadcast-reel.js';
import * as monitor from './_broadcast-monitor.js';
import * as preflight from './_broadcast-preflight.js';
import { testGuests } from './_reveal-invites.js';

export const STATE_KEY = 'broadcast';
export const CONFIG_KEY = 'broadcast-config';
export const HEALTH_KEY = 'broadcast-health';
export const SITE_ORIGIN = 'https://sunshineonaranneyday.com';
export const PHASES = ['idle', 'scheduled', 'armed', 'live', 'ending', 'replay'];

const ARM_WINDOW_MS = 30 * 60 * 1000;
const ENDING_GRACE_MS = 45 * 1000;
const SCHEDULED_EXPIRE_MS = 4 * 60 * 60 * 1000;
const MAX_LIVE_HOURS = 8;
const DEFAULT_REPLAY_HOURS = 72;
const TICK_MIN_INTERVAL_MS = 2500;
const LIFECYCLE_MIN_INTERVAL_MS = 4000;
const FB_PERMALINK_INTERVAL_MS = 60 * 1000;
const REPLAY_CHECK_INTERVAL_MS = 30 * 1000;
const DAILY_HEALTH_MS = 24 * 60 * 60 * 1000;
const REVEAL_MORNING_HEALTH_MS = 6 * 60 * 60 * 1000;
const DEPLOY_COOLDOWN_MS = 10 * 60 * 1000;
// The automatic Kit send only fires when the stream starts this close to the
// scheduled time, so a phone test earlier in the day can't email the whole list.
const KIT_LIVE_EARLY_MS = 30 * 60 * 1000;
// Kit wants a future send_at; a minute out keeps it effectively immediate.
const KIT_SEND_DELAY_MS = 60 * 1000;
// The stream must stay up this long in one unbroken stretch before the list is
// emailed, so a quick phone test or an accidental tap emails nobody.
const KIT_LIVE_STEADY_MS = 3 * 60 * 1000;
// Past this far into a broadcast a "come watch" email is too late to send by itself.
const KIT_LIVE_LATE_MS = 30 * 60 * 1000;
// How often to look for clues about which kid an unscheduled reveal is for.
const KID_CLUE_INTERVAL_MS = 60 * 1000;
// Going live and ending set things off (the Facebook post, the staff alert, the "we're live"
// reminders, the health report). Each is retried on every tick for this long until it has
// happened, so a tick cut off right after saving the phase change loses none of them. Past
// that, a broadcast is left alone (it ended long ago, or predates the claims).
const EFFECTS_RETRY_MS = 10 * 60 * 1000;
const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];

// Per-isolate throttles (cheap; D1 stamps back them up)
let _lastTickAt = 0;
let _lastTickResult = null;
// A busy no-op is remembered only for slow callers (visitors), never the hub's heartbeat
let _lastBusyAt = 0;
let _lastBusyResult = null;
let _lastLifecycleAt = 0;
let _schemaReady = false;

const nowIso = () => new Date(Date.now()).toISOString(); // Date.now() so tests can travel in time

// ─── Schema ─────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS broadcasts (
    id TEXT PRIMARY KEY,
    kid_slug TEXT, kid_name TEXT, title TEXT, message TEXT, image TEXT,
    scheduled_at TEXT, live_at TEXT, ended_at TEXT, phase TEXT,
    live_video_uid TEXT, replay_uid TEXT, fb_live_video_id TEXT, fb_permalink TEXT,
    source TEXT, data TEXT, created_at TEXT, updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON broadcasts(created_at)`,
  `CREATE TABLE IF NOT EXISTS broadcast_reminders (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    subscription TEXT,
    kid_slug TEXT,
    token TEXT NOT NULL,
    source TEXT,
    created_at TEXT, unsubscribed_at TEXT, last_sent_at TEXT,
    fails INTEGER DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_addr ON broadcast_reminders(channel, address)`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_token ON broadcast_reminders(token)`,
  `CREATE TABLE IF NOT EXISTS broadcast_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL,
    recipients INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
    error TEXT, created_at TEXT,
    UNIQUE(broadcast_id, kind, channel)
  )`,
  `CREATE TABLE IF NOT EXISTS broadcast_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id TEXT, type TEXT NOT NULL, meta TEXT, created_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bevents ON broadcast_events(broadcast_id, type)`,
  // One-time side effects of a broadcast (claimOnce): the Facebook live post, staff alerts, the replay's Kit draft
  `CREATE TABLE IF NOT EXISTS broadcast_claims (
    broadcast_id TEXT NOT NULL, key TEXT NOT NULL, result TEXT, created_at TEXT,
    PRIMARY KEY (broadcast_id, key)
  )`,
  // The tick lease (acquireTickLease): who holds it, until when, and when the last tick started
  `CREATE TABLE IF NOT EXISTS broadcast_locks (
    name TEXT PRIMARY KEY, holder TEXT, expires_at INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0
  )`,
];

export async function ensureSchema(DB) {
  if (_schemaReady) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _schemaReady = true;
}

// ─── Config / state / health records ────────────────────────────────

export function defaultConfig() {
  return {
    version: 1,
    customerCode: stream.DEFAULT_CUSTOMER_CODE,
    liveInput: null,       // full Stream live input record (includes ingest secrets; admin-only)
    rehearsalInput: null,
    outputs: {},           // { facebook: { uid, url, keyMask, enabled, createdAt }, youtube: {...} }
    facebook: { mode: 'persistent', pageUrl: 'https://www.facebook.com/SunshineOnaRanneyDay' },
    youtube: { channelUrl: 'https://www.youtube.com/@sunshineonaranneyday/live' },
    instagram: { profileUrl: 'https://www.instagram.com/sunshineonaranneyday' },
    orientation: 'portrait',   // what the crew shoots; the site player matches (the team shoots vertical)
    reels: reels.defaultReelConfig(), // automatic Instagram Reel of every replay
    reminders: { enabled: true, hoursBefore: [24, 1], sms: true, push: true },
    replayHours: DEFAULT_REPLAY_HOURS,
    timezone: 'America/New_York',
    alerts: { emails: [] },
    defaults: { title: 'Live room reveal', message: "It's reveal day! We're live right now." },
    // Email the Kit list when a scheduled reveal goes live. Each reveal can opt out (state.kitLiveEmail).
    kitLive: { enabled: true, audience: { type: 'all', id: null, name: 'All subscribers' } },
    messages: { enabled: true }, // viewers' notes for the family on the live page (functions/api/_live-messages.js)
    vapid: null,           // { publicKey, privateJwk, createdAt }
    setupAt: null, setupBy: null, updatedAt: null,
  };
}

export function defaultState() {
  return {
    version: 2,
    phase: 'idle',
    broadcastId: null,
    kidSlug: null, kidName: null,
    jobId: null,           // the JobTread job this reveal was scheduled from (_broadcast-schedule.js)
    test: false,           // a rehearsal from a JobTread "TEST …" job: invisible to the public, reminders to the test address only
    title: null, message: null, image: null,
    scheduledAt: null, armedAt: null, liveAt: null, endedAt: null, disconnectedAt: null,
    liveVideoUid: null, replayUid: null, replayReadyAt: null, replayUntil: null,
    revealAtSeconds: null, // admin override for where the reveal happens in the recording
    reel: null,            // Instagram Reel pipeline (functions/api/_broadcast-reel.js)
    fb: { liveVideoId: null, permalink: null, outputUid: null, checkedAt: null, needsReview: false },
    kit: { scheduledDraftId: null, replayDraftId: null, live: null }, // live: { id, audience, sendAt, by, error }
    kitLiveEmail: null,    // per-reveal override of config.kitLive.enabled; null = follow the setting
    segmentAt: null,       // start of the current unbroken stretch of video (resets on reconnect)
    kidVia: null,          // how the kid was known: 'scheduled' | 'admin' | 'facebook-live' | 'facebook-post'
    kidCheckAt: null, kidAlertAt: null,
    source: null,          // 'stream' | 'manual'
    manual: null,          // { url, until } for banner-only overrides
    note: null,
    clicks: 0,
    createdAt: null, updatedAt: null, updatedBy: null,
  };
}

export function defaultHealth() {
  return {
    lastDailyAt: null,
    stream: { ok: null, error: null, at: null },
    facebook: { ok: null, name: null, error: null, at: null },
    hub: { ok: null, clients: 0, at: null },
    webhook: { lastReceivedAt: null, lastEvent: null, count: 0 },
    lifecycle: { at: null, live: null, videoUID: null, inputUid: null },
    replayCheckAt: null,
    lastAutoDeployAt: null,
    flags: {},             // dedupe for alerts: { streamToken: 'bad', ... }
    lastTick: null,
  };
}

async function readJson(DB, key, fallback) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(key).first();
  if (!row) return fallback();
  try { return { ...fallback(), ...JSON.parse(row.data) }; } catch { return fallback(); }
}

async function writeJson(DB, key, value) {
  await DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(key, JSON.stringify(value), nowIso()).run();
}

export const readConfig = (DB) => readJson(DB, CONFIG_KEY, defaultConfig);
export const writeConfig = (DB, c) => writeJson(DB, CONFIG_KEY, { ...c, updatedAt: nowIso() });
export const readState = (DB) => readJson(DB, STATE_KEY, defaultState);
export const readHealth = (DB) => readJson(DB, HEALTH_KEY, defaultHealth);

// A field of the stored row, NULL when the row isn't JSON (the readers then fall back to defaults)
const stored = (col, path) => `(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${path}') END)`;

// The state JSON (?1) as written: rev set in SQL, and the banner click count
// never rolled back for the same broadcast (countBannerClick bumps it in place)
const stateData = (col, revSql) => `json_set(?1, '$.rev', ${revSql}, '$.clicks',
  CASE WHEN ${stored(col, '$.broadcastId')} IS json_extract(?1, '$.broadcastId')
    THEN MAX(COALESCE(${stored(col, '$.clicks')}, 0), COALESCE(json_extract(?1, '$.clicks'), 0))
    ELSE COALESCE(json_extract(?1, '$.clicks'), 0) END)`;

/**
 * Save the state. Every write bumps state.rev in SQL, so a tick that read an
 * older copy can tell it lost the race (writeStateIf). Admin commands use this
 * one: they hold the tick lease, and what staff asked for wins.
 */
export async function writeState(DB, s) {
  await DB.prepare(`INSERT INTO site_config (key, data, updated_at) VALUES (?2, json_set(?1, '$.rev', 1), ?3)
    ON CONFLICT(key) DO UPDATE SET data = ${stateData('site_config.data', `COALESCE(${stored('site_config.data', '$.rev')}, 0) + 1`)}, updated_at = ?3`)
    .bind(JSON.stringify(s), STATE_KEY, nowIso()).run();
}

/** Save `s` only if the stored state is still at `rev`. → true when saved (the stored rev is then rev + 1) */
export async function writeStateIf(DB, s, rev) {
  const r = await DB.prepare(`UPDATE site_config SET data = ${stateData('data', '?2 + 1')}, updated_at = ?3
    WHERE key = ?4 AND COALESCE(${stored('data', '$.rev')}, 0) = ?2`)
    .bind(JSON.stringify(s), rev, nowIso(), STATE_KEY).run();
  if ((r?.meta?.changes || 0) > 0) return true;
  if (rev) return false;
  // Nothing stored yet: the first write wins
  const ins = await DB.prepare(`INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, json_set(?, '$.rev', 1), ?)`)
    .bind(STATE_KEY, JSON.stringify(s), nowIso()).run();
  return (ins?.meta?.changes || 0) > 0;
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Three-way merge for a tick that lost the race to save. `base` is the copy
 * it read, `ours` what it wants to save, `theirs` what is stored now. Each key
 * the tick changed goes over theirs, unless they changed it too (theirs
 * wins). A different broadcast or phase on their side (cancel, end, reset, a
 * new schedule) wins outright. → { state, dropped }
 */
export function mergeState(base, ours, theirs) {
  if ((theirs.broadcastId ?? null) !== (base.broadcastId ?? null) || (theirs.phase || 'idle') !== (base.phase || 'idle')) {
    return { state: theirs, dropped: true };
  }
  const out = { ...theirs };
  for (const k of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (k === 'rev' || k === 'updatedAt' || sameJson(ours[k], base[k]) || !sameJson(theirs[k], base[k])) continue;
    if (ours[k] === undefined) delete out[k];
    else out[k] = ours[k];
  }
  return { state: out, dropped: false };
}

/**
 * Save a tick's state over the copy it read (`base`, at `rev`), merging over
 * anything written since (mergeState). → { state, dropped }: `state` is what
 * is stored now, `dropped` when the tick's changes gave way entirely.
 */
async function commitState(DB, base, ours, rev) {
  let next = ours;
  let at = rev;
  for (let i = 0; i < 3; i++) {
    if (await writeStateIf(DB, next, at)) return { state: { ...next, rev: at + 1 }, dropped: false };
    const theirs = await readState(DB);
    const m = mergeState(base, ours, theirs);
    if (m.dropped) return { state: theirs, dropped: true };
    next = m.state;
    at = Number(theirs.rev) || 0;
  }
  return { state: await readState(DB), dropped: true };
}

/**
 * Count a click on the LIVE banner for `broadcastId`, in place (json_set), so
 * a public click never rewrites the state record. Only while that broadcast
 * is the current one and not idle.
 */
export async function countBannerClick(DB, broadcastId) {
  await DB.prepare(`UPDATE site_config SET data = json_set(data, '$.clicks', COALESCE(json_extract(data, '$.clicks'), 0) + 1)
    WHERE key = ? AND ${stored('data', '$.broadcastId')} = ? AND ${stored('data', '$.phase')} != 'idle'`)
    .bind(STATE_KEY, broadcastId).run();
}

/**
 * Save the health record. Its `webhook` entry belongs to /api/stream-webhook
 * (noteWebhook), so the stored one is kept whatever this copy says: a tick
 * that read health before a webhook arrived can't wipe it.
 */
export async function writeHealth(DB, h) {
  await DB.prepare(`INSERT INTO site_config (key, data, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET data = CASE WHEN json_type(${stored('site_config.data', '$.webhook')}) = 'object'
      THEN json_set(?2, '$.webhook', json(json_extract(site_config.data, '$.webhook'))) ELSE ?2 END, updated_at = ?3`)
    .bind(HEALTH_KEY, JSON.stringify(h), nowIso()).run();
}

/**
 * Record a Cloudflare notification in health.webhook with one statement, so
 * it never races a tick's health write. `event` is one of Stream's three
 * event names or 'test'; `inputId` only when it is one of our inputs.
 */
export async function noteWebhook(DB, { event, inputId = null, signed = false }) {
  const count = `COALESCE(${stored('site_config.data', '$.webhook.count')}, 0) + 1`;
  const entry = (n) => `json_object('lastReceivedAt', ?2, 'lastEvent', ?3, 'lastInputId', ?4, 'signed', json(?5), 'count', ${n})`;
  await DB.prepare(`INSERT INTO site_config (key, data, updated_at) VALUES (?1, json_object('webhook', ${entry('1')}), ?2)
    ON CONFLICT(key) DO UPDATE SET data = json_set(CASE WHEN json_valid(site_config.data) THEN site_config.data ELSE '{}' END, '$.webhook', ${entry(count)}), updated_at = ?2`)
    .bind(HEALTH_KEY, nowIso(), event, inputId, signed ? 'true' : 'false').run();
}

// ─── Derived views ──────────────────────────────────────────────────

export function liveUrlFor(state) {
  return state?.kidSlug ? `${SITE_ORIGIN}/live/${state.kidSlug}/` : `${SITE_ORIGIN}/live/`;
}

/**
 * The broadcast as anyone outside the admin may know it. A rehearsal (a
 * JobTread "TEST …" job, state.test) runs the real pipeline but stays
 * invisible: to the public site, the live page, the hub and the reminder
 * signup it looks like nothing is scheduled.
 */
export function visibleState(state) {
  return state?.test ? { ...defaultState(), updatedAt: state.updatedAt || null } : state;
}

/** What the public site and the hub see. No secrets. A rehearsal is hidden unless `includeTest` (admin only). */
export function publicState(state, config, { includeTest = false } = {}) {
  if (!includeTest) state = visibleState(state);
  const phase = state.phase || 'idle';
  const live = phase === 'live' || phase === 'ending';
  const upcoming = phase === 'scheduled' || phase === 'armed';
  const replay = phase === 'replay';
  const liveUrl = liveUrlFor(state);
  const code = config?.customerCode || stream.DEFAULT_CUSTOMER_CODE;
  let player = null;
  if (live && state.source === 'stream' && config?.liveInput?.uid) player = { kind: 'live', uid: config.liveInput.uid, customerCode: code };
  else if (replay && state.replayUid) player = { kind: 'replay', uid: state.replayUid, customerCode: code };
  return {
    phase, live, upcoming, replay,
    id: state.broadcastId,
    kidSlug: state.kidSlug, kidName: state.kidName,
    title: state.title, message: state.message, image: state.image,
    scheduledAt: state.scheduledAt, liveAt: state.liveAt, endedAt: state.endedAt, replayUntil: state.replayUntil,
    url: state.manual?.url || liveUrl,
    liveUrl,
    player,
    facebookUrl: state.fb?.permalink || config?.facebook?.pageUrl || null,
    youtubeUrl: config?.youtube?.channelUrl || null,
    instagramUrl: config?.instagram?.profileUrl || null,
    orientation: config?.orientation === 'portrait' ? 'portrait' : 'landscape',
    source: state.source,
    ...(state.test ? { test: true } : {}),
    updatedAt: state.updatedAt,
  };
}

/** The shape the original LiveIndicator + admin Go Live read. */
export function legacyState(state, config, opts) {
  if (!opts?.includeTest) state = visibleState(state);
  const p = publicState(state, config, opts);
  let endsAt = null;
  if (p.live) endsAt = state.manual?.until || (state.liveAt ? new Date(Date.parse(state.liveAt) + MAX_LIVE_HOURS * 3600e3).toISOString() : null);
  else if (p.upcoming) endsAt = state.scheduledAt ? new Date(Date.parse(state.scheduledAt) + 6 * 3600e3).toISOString() : null;
  else if (p.replay) endsAt = state.replayUntil;
  return {
    live: p.live, upcoming: p.upcoming, replay: p.replay, phase: p.phase,
    message: p.message || '', url: p.url, liveUrl: p.liveUrl,
    startsAt: p.scheduledAt, endsAt, id: p.id, clicks: state.clicks || 0, image: p.image || null,
    kidName: p.kidName, kidSlug: p.kidSlug, player: p.player, facebookUrl: p.facebookUrl,
    auto: true,
  };
}

// ─── Hub (Durable Object) ───────────────────────────────────────────

function hubStub(env) {
  if (!env.LIVE_HUB) return null;
  try { return env.LIVE_HUB.get(env.LIVE_HUB.idFromName('main')); } catch { return null; }
}

export async function publishToHub(env, state, config, reason, event) {
  const stub = hubStub(env);
  if (!stub) return { ok: false, skipped: true, error: 'LIVE_HUB binding missing' };
  try {
    // The hub hands `reason` to every open page, so only its kind goes ('admin', 'webhook', 'tick'), never details
    const res = await stub.fetch('https://hub/publish', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: publicState(state, config), reason: String(reason || 'publish').split(':')[0], event }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The hub's nonces are crypto.randomUUID(); anything else is refused before it can wake the object
const HUB_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verifyHubNonce(env, nonce) {
  if (typeof nonce !== 'string' || !HUB_NONCE.test(nonce)) return false;
  const stub = hubStub(env);
  if (!stub) return false;
  try {
    const res = await stub.fetch('https://hub/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    const data = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}

export async function hubStatus(env) {
  const stub = hubStub(env);
  if (!stub) return { ok: false, bound: false, error: 'LIVE_HUB binding missing (add durable_objects binding in wrangler.toml and redeploy)' };
  try {
    const res = await stub.fetch('https://hub/status');
    return { bound: true, ...(await res.json()) };
  } catch (e) {
    return { ok: false, bound: true, error: e.message };
  }
}

export async function hubTick(env) {
  const stub = hubStub(env);
  if (!stub) return { ok: false, error: 'LIVE_HUB binding missing' };
  try {
    const res = await stub.fetch('https://hub/tick', { method: 'POST' });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Rows / events ──────────────────────────────────────────────────

async function upsertBroadcastRow(DB, s) {
  if (!s.broadcastId) return;
  await DB.prepare(`INSERT INTO broadcasts (id, kid_slug, kid_name, title, message, image, scheduled_at, live_at, ended_at, phase,
      live_video_uid, replay_uid, fb_live_video_id, fb_permalink, source, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kid_slug=excluded.kid_slug, kid_name=excluded.kid_name, title=excluded.title, message=excluded.message,
      image=excluded.image, scheduled_at=excluded.scheduled_at, live_at=excluded.live_at, ended_at=excluded.ended_at, phase=excluded.phase,
      live_video_uid=excluded.live_video_uid, replay_uid=excluded.replay_uid, fb_live_video_id=excluded.fb_live_video_id,
      fb_permalink=excluded.fb_permalink, source=excluded.source, data=excluded.data, updated_at=excluded.updated_at`)
    .bind(s.broadcastId, s.kidSlug, s.kidName, s.title, s.message, s.image, s.scheduledAt, s.liveAt, s.endedAt, s.phase,
      s.liveVideoUid, s.replayUid, s.fb?.liveVideoId || null, s.fb?.permalink || null, s.source,
      JSON.stringify({ clicks: s.clicks || 0, note: s.note, kit: s.kit, kitLiveEmail: s.kitLiveEmail ?? null, replayUntil: s.replayUntil, reel: s.reel || null, jobId: s.jobId || null }), s.createdAt || nowIso(), nowIso()).run();
}

/**
 * Mark a planned broadcast's row as finished ('cancelled', 'missed') before the
 * state is cleared. tClear drops the broadcastId, so the persist step can't
 * update the row afterwards, and History would keep calling it "Coming up".
 */
async function closeBroadcastRow(DB, s, phase) {
  if (!s.broadcastId) return;
  await DB.prepare('UPDATE broadcasts SET phase = ?, updated_at = ? WHERE id = ?').bind(phase, nowIso(), s.broadcastId).run();
}

export async function recordEvent(DB, broadcastId, type, meta) {
  try {
    await DB.prepare('INSERT INTO broadcast_events (broadcast_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
      .bind(broadcastId || null, type, meta ? JSON.stringify(meta).slice(0, 2000) : null, nowIso()).run();
  } catch { /* analytics only */ }
}

async function triggerDeploy(env, health, reason) {
  const hook = HOOK_ENV_VARS.map(k => env[k]).find(Boolean);
  if (!hook) return false;
  const last = health.lastAutoDeployAt ? Date.parse(health.lastAutoDeployAt) : 0;
  if (Date.now() - last < DEPLOY_COOLDOWN_MS) return false;
  try {
    const res = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;
    health.lastAutoDeployAt = nowIso();
    await logAudit(env.DB, { userEmail: 'live-broadcast', action: 'deployed', entityType: 'site', entityName: reason, gitStatus: 'ok', path: '/api/broadcast-hooks' });
    return true;
  } catch {
    return false;
  }
}

// ─── One tick at a time ─────────────────────────────────────────────

// About two heartbeats: a holder that died mid-tick (a D1 error, a cancelled request)
// blocks the next tick at most this long. A long tick keeps extending it (extendTickLease).
const TICK_LEASE_MS = 15 * 1000;
const LEASE_EXTEND_AFTER_MS = 5 * 1000;
const ADMIN_LEASE_WAIT_MS = 8 * 1000;
const FORCED_LEASE_WAIT_MS = 5 * 1000;
const UNLEASED = 'unleased';

/**
 * Take the tick lease (one row in D1, shared by every isolate). A throttled
 * caller (`minIntervalMs`) also needs the last tick to have started at least
 * that long ago, so visitors and unsigned webhooks can't stack ticks however
 * many isolates they land on. → holder id, or null when someone else has it.
 * If D1 can't answer, the tick runs anyway ('unleased'): the rev check on the
 * state write and the side-effect claims still hold.
 */
async function acquireTickLease(DB, { minIntervalMs = null } = {}) {
  const holder = crypto.randomUUID();
  const now = Date.now();
  const startedBefore = minIntervalMs == null ? now + 60 * 1000 : now - minIntervalMs;
  try {
    const row = await DB.prepare(`INSERT INTO broadcast_locks (name, holder, expires_at, started_at) VALUES ('tick', ?1, ?2, ?3)
      ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at, started_at = excluded.started_at
      WHERE broadcast_locks.expires_at <= ?3 AND broadcast_locks.started_at <= ?4
      RETURNING holder`).bind(holder, now + TICK_LEASE_MS, now, startedBefore).first();
    return row?.holder === holder ? holder : null;
  } catch {
    return UNLEASED;
  }
}

/** Wait up to `waitMs` for the lease (admin commands, forced ticks). Gives up and runs unleased rather than fail. */
async function waitForTickLease(DB, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const holder = await acquireTickLease(DB);
    if (holder) return holder;
    if (Date.now() >= until) return UNLEASED;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Push the lease out again during a long tick. → false when another tick holds it now */
async function extendTickLease(DB, holder) {
  if (!holder || holder === UNLEASED) return true;
  try {
    const r = await DB.prepare(`UPDATE broadcast_locks SET expires_at = ? WHERE name = 'tick' AND holder = ?`)
      .bind(Date.now() + TICK_LEASE_MS, holder).run();
    return (r?.meta?.changes || 0) > 0;
  } catch {
    return true;
  }
}

async function releaseTickLease(DB, holder) {
  if (!holder || holder === UNLEASED) return;
  await DB.prepare(`UPDATE broadcast_locks SET expires_at = 0 WHERE name = 'tick' AND holder = ?`).bind(holder).run().catch(() => {});
}

// ─── One-time side effects ──────────────────────────────────────────

/**
 * Claim a one-time side effect of a broadcast: the Facebook live post, the
 * staff "Live now" and "Ended" alerts, the replay's Kit draft and rebuild.
 * Only the first caller per (broadcast, key) gets true, in every isolate.
 * settleClaim keeps what the side effect made (the Facebook video id, the Kit
 * draft id) so a later tick can read it back with claimResult.
 */
async function claimOnce(DB, broadcastId, key) {
  if (!broadcastId) return true;
  try {
    const r = await DB.prepare('INSERT OR IGNORE INTO broadcast_claims (broadcast_id, key, created_at) VALUES (?, ?, ?)')
      .bind(broadcastId, key, nowIso()).run();
    return (r?.meta?.changes || 0) > 0;
  } catch {
    return false;
  }
}

async function settleClaim(DB, broadcastId, key, result) {
  if (!broadcastId) return;
  await DB.prepare('UPDATE broadcast_claims SET result = ? WHERE broadcast_id = ? AND key = ?')
    .bind(JSON.stringify(result), broadcastId, key).run().catch(() => {});
}

/** Every claim a broadcast has taken, in one read */
async function claimedKeys(DB, broadcastId) {
  if (!broadcastId) return new Set();
  const res = await DB.prepare('SELECT key FROM broadcast_claims WHERE broadcast_id = ?').bind(broadcastId).all().catch(() => null);
  return new Set((res?.results || []).map((r) => r.key));
}

async function claimResult(DB, broadcastId, key) {
  if (!broadcastId) return null;
  const row = await DB.prepare('SELECT result FROM broadcast_claims WHERE broadcast_id = ? AND key = ?').bind(broadcastId, key).first().catch(() => null);
  try { return row?.result ? JSON.parse(row.result) : null; } catch { return null; }
}

// ─── Transitions (pure; return a new state) ─────────────────────────

function newBroadcastId() {
  return `live-${Date.now()}`;
}

export function tSchedule(state, { kidSlug, kidName, jobId, test, scheduledAt, title, message, image, kitLiveEmail, by }, config) {
  const s = { ...defaultState(), broadcastId: newBroadcastId(), createdAt: nowIso() };
  s.kidSlug = kidSlug || null;
  s.kidName = kidName || null;
  s.jobId = jobId || null;
  s.test = !!test;
  s.scheduledAt = scheduledAt;
  s.title = title || `${s.test ? 'TEST · ' : ''}${kidName ? `${kidName}'s room reveal` : config.defaults.title}`;
  s.message = message || (kidName ? `Watch ${kidName}'s room reveal live` : config.defaults.message);
  s.image = image || null;
  s.kitLiveEmail = typeof kitLiveEmail === 'boolean' ? kitLiveEmail : null;
  s.kidVia = kidSlug ? 'scheduled' : null;
  s.phase = Date.parse(scheduledAt) - Date.now() <= ARM_WINDOW_MS ? 'armed' : 'scheduled';
  if (s.phase === 'armed') s.armedAt = nowIso();
  s.updatedBy = by || null;
  return s;
}

export function tStartLive(state, { videoUid, source = 'stream', by }, config) {
  let s = { ...state };
  // A real stream never inherits a rehearsal: it starts its own, public broadcast
  const reusable = !state.test && (['scheduled', 'armed', 'ending'].includes(state.phase) || (state.phase === 'live'));
  if (!reusable) {
    // idle or replay: a fresh, unplanned broadcast
    s = { ...defaultState(), broadcastId: newBroadcastId(), createdAt: nowIso() };
    s.title = config.defaults.title;
    s.message = config.defaults.message;
  }
  if (s.phase !== 'live') s.segmentAt = nowIso();
  s.phase = 'live';
  s.source = source;
  s.liveAt = s.liveAt || nowIso();
  s.disconnectedAt = null;
  if (videoUid) s.liveVideoUid = videoUid;
  s.updatedBy = by || null;
  return s;
}

export function tDisconnected(state) {
  return { ...state, phase: 'ending', disconnectedAt: nowIso() };
}

export function tReconnected(state) {
  return { ...state, phase: 'live', disconnectedAt: null, segmentAt: nowIso() };
}

export function tEnd(state, config, { by } = {}) {
  const hours = Number(config?.replayHours) || DEFAULT_REPLAY_HOURS;
  const s = { ...state, phase: 'replay', endedAt: state.endedAt || nowIso(), disconnectedAt: null, updatedBy: by || null };
  s.replayUntil = new Date(Date.now() + hours * 3600e3).toISOString();
  s.manual = null;
  return s;
}

export function tClear(state, note, by) {
  return { ...defaultState(), note: note || null, updatedBy: by || null };
}

// ─── Reminders ──────────────────────────────────────────────────────

/**
 * A rehearsal's reminder: whatever a real reveal would send under the current
 * Settings (reminders on, which hours before), each kind once, by email, to the
 * test address (the reveal invites' test guests), marked TEST. Nobody who
 * signed up gets anything, and no texts or browser alerts go out.
 */
async function sendTestReminder(env, state, kind, work, summary) {
  const { DB } = env;
  if (!notify.emailConfigured(env) || !(await claimSend(DB, state.broadcastId, kind, 'email'))) return summary;
  const to = await testGuests(DB).catch(() => []);
  const tpl = notify.reminderEmail({ kind, kidName: state.kidName, scheduledAt: state.scheduledAt, tz: 'America/New_York', liveUrl: liveUrlFor(state), replayUrl: liveUrlFor(state), unsubscribeUrl: `${SITE_ORIGIN}/admin/#broadcast`, image: null });
  const res = to.length
    ? await notify.sendEmailItems(env, to.map((addr) => ({ to: addr, subject: `TEST · ${tpl.subject}`, html: tpl.html, text: tpl.text })), { tags: [{ name: 'category', value: `reveal-${kind}-test` }] })
    : { sent: 0, failed: 0, errors: [] };
  await finishSend(DB, state.broadcastId, kind, 'email', { recipients: to.length, sent: res.sent, failed: res.failed, error: res.errors.slice(0, 3).join('; ') || null });
  summary.email = { recipients: to.length, sent: res.sent, failed: res.failed, test: true };
  work.push(`test-email:${kind}:${res.sent}/${to.length}`);
  return summary;
}

// A reminder goes out in batches, a few seconds' worth per tick, so a long
// list never holds up the tick that flips the site to live. Each recipient is
// claimed in broadcast_reminder_deliveries before anything is sent (so two
// ticks never send to the same person), and broadcast_reminder_runs remembers
// which sends still have people waiting, so the next tick carries on.
const REMINDER_BATCH = { email: 100, sms: 15, push: 50 };
const REMINDER_TICK_BUDGET_MS = 3000;
// When this isolate last sent batches for `${broadcastId}:${kind}`: a send started this tick
// isn't carried on again in the same tick, so one tick spends at most one budget per kind
const _reminderSentAt = new Map();

const REMINDER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS broadcast_reminder_deliveries (
    broadcast_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, reminder_id TEXT NOT NULL,
    batch TEXT NOT NULL, at TEXT,
    PRIMARY KEY (broadcast_id, kind, channel, reminder_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_batch ON broadcast_reminder_deliveries(batch)`,
  `CREATE TABLE IF NOT EXISTS broadcast_reminder_runs (
    broadcast_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL,
    started_at TEXT, finished_at TEXT,
    PRIMARY KEY (broadcast_id, kind, channel)
  )`,
];
const _reminderTables = new WeakSet();
async function ensureReminderTables(DB) {
  if (_reminderTables.has(DB)) return;
  await DB.batch(REMINDER_SCHEMA.map(sql => DB.prepare(sql)));
  _reminderTables.add(DB);
}

/** Each kind is news only while the reveal is in the matching phase; a batch left over after that is dropped */
function reminderStillNews(kind, state) {
  if (kind === 'live') return state.phase === 'live' || state.phase === 'ending';
  if (kind === 'replay') return state.phase === 'replay';
  return state.phase === 'scheduled' || state.phase === 'armed';
}

/** A fresh send for (broadcast, kind, channel): forget earlier deliveries (a moved date re-sends) and open the run */
async function openRun(DB, broadcastId, kind, channel) {
  await DB.prepare('DELETE FROM broadcast_reminder_deliveries WHERE broadcast_id = ? AND kind = ? AND channel = ?').bind(broadcastId, kind, channel).run();
  // Who-got-what is only needed while a send is going out; a month on, it goes
  const monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString();
  await DB.prepare('DELETE FROM broadcast_reminder_deliveries WHERE at < ?').bind(monthAgo).run();
  await DB.prepare('DELETE FROM broadcast_reminder_runs WHERE started_at < ?').bind(monthAgo).run();
  await DB.prepare(`INSERT INTO broadcast_reminder_runs (broadcast_id, kind, channel, started_at, finished_at) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(broadcast_id, kind, channel) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL`).bind(broadcastId, kind, channel, nowIso()).run();
}

async function runOpen(DB, broadcastId, kind, channel) {
  const row = await DB.prepare('SELECT finished_at FROM broadcast_reminder_runs WHERE broadcast_id = ? AND kind = ? AND channel = ?').bind(broadcastId, kind, channel).first();
  return !!row && !row.finished_at;
}

async function closeRun(DB, broadcastId, kind, channel) {
  await DB.prepare('UPDATE broadcast_reminder_runs SET finished_at = ? WHERE broadcast_id = ? AND kind = ? AND channel = ? AND finished_at IS NULL').bind(nowIso(), broadcastId, kind, channel).run();
}

/** Kinds with people still waiting for this broadcast */
async function openReminderKinds(DB, broadcastId) {
  await ensureReminderTables(DB);
  const res = await DB.prepare('SELECT DISTINCT kind FROM broadcast_reminder_runs WHERE broadcast_id = ? AND finished_at IS NULL').bind(broadcastId).all();
  return (res?.results || []).map(r => r.kind);
}

/**
 * Claim the next `size` recipients nobody has claimed for this send → their
 * rows. One INSERT … SELECT, so two ticks running at once split the list.
 */
async function claimRecipients(DB, state, kind, channel, size) {
  const batch = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  await DB.prepare(`INSERT OR IGNORE INTO broadcast_reminder_deliveries (broadcast_id, kind, channel, reminder_id, batch, at)
    SELECT ?, ?, ?, r.id, ?, ? FROM broadcast_reminders r
    WHERE r.channel = ? AND r.unsubscribed_at IS NULL AND (r.kid_slug IS NULL OR r.kid_slug = ?) AND r.fails < 5
      AND NOT EXISTS (SELECT 1 FROM broadcast_reminder_deliveries d WHERE d.broadcast_id = ? AND d.kind = ? AND d.channel = ? AND d.reminder_id = r.id)
    ORDER BY r.id LIMIT ?`)
    .bind(state.broadcastId, kind, channel, batch, nowIso(), channel, state.kidSlug || '', state.broadcastId, kind, channel, size).run();
  const res = await DB.prepare(`SELECT r.id, r.address, r.subscription, r.last_sent_at, r.token FROM broadcast_reminder_deliveries d
    JOIN broadcast_reminders r ON r.id = d.reminder_id WHERE d.batch = ?`).bind(batch).all();
  return { batch, rows: res?.results || [] };
}

/** Add one batch's numbers to the send's row (the admin's reminder stats) */
async function addSendStats(DB, broadcastId, kind, channel, { recipients, sent, failed, error }) {
  try {
    await DB.prepare('UPDATE broadcast_sends SET recipients = COALESCE(recipients, 0) + ?, sent = COALESCE(sent, 0) + ?, failed = COALESCE(failed, 0) + ?, error = COALESCE(?, error) WHERE broadcast_id = ? AND kind = ? AND channel = ?')
      .bind(recipients, sent, failed, error || null, broadcastId, kind, channel).run();
  } catch { /* stats only */ }
}

/** Claim a (broadcast, kind, channel) send so concurrent ticks never double-send. */
async function claimSend(DB, broadcastId, kind, channel) {
  try {
    const r = await DB.prepare('INSERT OR IGNORE INTO broadcast_sends (broadcast_id, kind, channel, created_at) VALUES (?, ?, ?, ?)')
      .bind(broadcastId, kind, channel, nowIso()).run();
    return (r?.meta?.changes || 0) > 0;
  } catch {
    return false;
  }
}

async function finishSend(DB, broadcastId, kind, channel, { recipients, sent, failed, error }) {
  try {
    await DB.prepare('UPDATE broadcast_sends SET recipients = ?, sent = ?, failed = ?, error = ? WHERE broadcast_id = ? AND kind = ? AND channel = ?')
      .bind(recipients, sent, failed, error || null, broadcastId, kind, channel).run();
  } catch { /* stats only */ }
}

function unsubscribeUrl(token) {
  return `${SITE_ORIGIN}/api/reminders?unsubscribe=${encodeURIComponent(token)}`;
}

/**
 * Send one reminder kind across all channels. Idempotent per broadcast: the
 * first call claims the send (broadcast_sends) and opens its run, every call
 * sends batches for up to `budgetMs`, and the next tick (dueReminderKinds)
 * carries on until everyone has it. Returns this call's summary; never throws.
 */
export async function sendReminders(env, config, state, kind, work, { budgetMs = REMINDER_TICK_BUDGET_MS } = {}) {
  const { DB } = env;
  const summary = { kind, email: null, sms: null, push: null };
  if (!config.reminders?.enabled || !state.broadcastId) return summary;
  // A rehearsal follows the same switches as a real reveal, but only the test address hears it
  if (state.test) return sendTestReminder(env, state, kind, work, summary);
  let open;
  try {
    await ensureReminderTables(DB);
    open = new Set(((await DB.prepare('SELECT channel FROM broadcast_reminder_runs WHERE broadcast_id = ? AND kind = ? AND finished_at IS NULL').bind(state.broadcastId, kind).all())?.results || []).map(r => r.channel));
  } catch (e) {
    work.push(`reminders:${kind}:error`);
    return summary;
  }
  const common = {
    kind, kidName: state.kidName, scheduledAt: state.scheduledAt, tz: config.timezone,
    liveUrl: liveUrlFor(state),
    replayUrl: state.replayUid ? liveUrlFor(state) : liveUrlFor(state),
    image: state.image ? `${SITE_ORIGIN}/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/${state.image}/w=1200,h=630,fit=cover,q=82` : null,
  };
  const news = reminderStillNews(kind, state);
  const deadline = Date.now() + budgetMs;

  // One channel: claim the send the first time, then batches until everyone has it or time is up
  const channel = async (name, enabled, sendBatch) => {
    try {
      if (!enabled || !news) { if (open.has(name)) await closeRun(DB, state.broadcastId, kind, name); return; }
      if (await claimSend(DB, state.broadcastId, kind, name)) await openRun(DB, state.broadcastId, kind, name);
      else if (!open.has(name)) return;
      const size = REMINDER_BATCH[name];
      const total = { recipients: 0, sent: 0, failed: 0 };
      for (;;) {
        const { batch, rows } = await claimRecipients(DB, state, kind, name, size);
        if (rows.length) {
          const r = await sendBatch(rows, batch);
          total.recipients += rows.length; total.sent += r.sent; total.failed += r.failed;
          await addSendStats(DB, state.broadcastId, kind, name, { recipients: rows.length, sent: r.sent, failed: r.failed, error: r.error });
        }
        if (rows.length < size) { await closeRun(DB, state.broadcastId, kind, name); break; }
        if (Date.now() >= deadline) { work.push(`${name}:${kind}:continues`); break; }
      }
      summary[name] = total;
      if (total.recipients) work.push(`${name}:${kind}:${total.sent}/${total.recipients}`);
    } catch (e) {
      // The run stays open, so the next tick tries again with whoever is still waiting
      work.push(`${name}:${kind}:error`);
    }
  };

  await Promise.all([
    // Email: each recipient gets their own unsubscribe link, in the footer and as one-click List-Unsubscribe
    channel('email', notify.emailConfigured(env), async (rows) => {
      const items = rows.map(r => {
        const url = unsubscribeUrl(r.token || r.id);
        const tpl = notify.reminderEmail({ ...common, unsubscribeUrl: url });
        return { to: r.address, subject: tpl.subject, html: tpl.html, text: tpl.text, headers: notify.listUnsubscribeHeaders(url) };
      });
      const res = await notify.sendEmailItems(env, items, { tags: [{ name: 'category', value: `reveal-${kind}` }] });
      return { sent: res.sent, failed: res.failed, error: res.errors.slice(0, 3).join('; ') || null };
    }),
    // SMS: a first text carries "Reply STOP to opt out"
    channel('sms', !!(config.reminders?.sms && notify.smsConfigured(env)), async (rows, batch) => {
      const firstTimers = rows.filter(r => !r.last_sent_at).map(r => r.address);
      const others = rows.filter(r => r.last_sent_at).map(r => r.address);
      let sent = 0, failed = 0; const errors = []; const optedOut = [];
      if (firstTimers.length) { const r = await notify.sendSms(env, { to: firstTimers, body: notify.reminderSms({ ...common, first: true }) }); sent += r.sent; failed += r.failed; errors.push(...r.errors); optedOut.push(...r.optedOut); }
      if (others.length) { const r = await notify.sendSms(env, { to: others, body: notify.reminderSms(common) }); sent += r.sent; failed += r.failed; errors.push(...r.errors); optedOut.push(...r.optedOut); }
      await DB.prepare('UPDATE broadcast_reminders SET last_sent_at = ? WHERE id IN (SELECT reminder_id FROM broadcast_reminder_deliveries WHERE batch = ?)').bind(nowIso(), batch).run();
      for (const num of optedOut) await DB.prepare(`UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE channel = 'sms' AND address = ?`).bind(nowIso(), num).run();
      return { sent, failed, error: errors.slice(0, 3).join('; ') || null };
    }),
    // Push: a dead subscription (404/410, or not a browser push service) is dropped
    channel('push', !!(config.reminders?.push && config.vapid?.privateJwk), async (rows) => {
      const subs = rows.map(r => { try { return { id: r.id, subscription: JSON.parse(r.subscription) }; } catch { return null; } }).filter(Boolean);
      const r = await notify.sendPushBatch(subs, notify.reminderPush(common), config.vapid, { ttl: kind === 'live' ? 2 * 3600 : 24 * 3600, urgency: kind === 'live' ? 'high' : 'normal', topic: `reveal-${kind}` });
      for (const id of r.gone) await DB.prepare('UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE id = ?').bind(nowIso(), id).run();
      return { sent: r.sent, failed: r.failed + (rows.length - subs.length), error: null };
    }),
  ]);
  if (_reminderSentAt.size > 50) _reminderSentAt.clear();
  _reminderSentAt.set(`${state.broadcastId}:${kind}`, Date.now());
  return summary;
}

async function dueReminderKinds(DB, state, config) {
  if (!state.broadcastId) return [];
  // Sends with people still waiting carry on every tick (sendReminders drops them once they're old news)
  const carrying = (await openReminderKinds(DB, state.broadcastId).catch(() => []))
    .filter(k => Date.now() - (_reminderSentAt.get(`${state.broadcastId}:${k}`) || 0) >= REMINDER_TICK_BUDGET_MS);
  const kinds = [];
  const now = Date.now();
  const at = state.scheduledAt ? Date.parse(state.scheduledAt) : null;
  const hours = Array.isArray(config.reminders?.hoursBefore) ? config.reminders.hoursBefore : [24, 1];
  if ((state.phase === 'scheduled' || state.phase === 'armed') && at) {
    const lead = at - now;
    if (hours.includes(24) && lead <= 24 * 3600e3 && lead > 2 * 3600e3) kinds.push('day');
    if (hours.includes(1) && lead <= 3600e3 && lead > 5 * 60e3) kinds.push('hour');
  }
  // "We're live": due from the tick that saves the go-live until it has started (see EFFECTS_RETRY_MS)
  if ((state.phase === 'live' || state.phase === 'ending') && state.source === 'stream' && state.liveAt && now - Date.parse(state.liveAt) <= EFFECTS_RETRY_MS) kinds.push('live');
  if (!kinds.length && !carrying.length) return [];
  // Kit's "we're live" email is also kind 'live' (channel 'kit'); it doesn't count as the reminders having started
  const res = await DB.prepare('SELECT kind, channel FROM broadcast_sends WHERE broadcast_id = ?').bind(state.broadcastId).all();
  const done = new Set((res?.results || []).filter(r => r.channel !== 'kit').map(r => r.kind));
  // A run carries on only while its send is still claimed: a moved date un-claims day and hour, which then wait for their new window
  return [...new Set([...kinds.filter(k => !done.has(k)), ...carrying.filter(k => done.has(k))])];
}

// ─── Kit drafts ─────────────────────────────────────────────────────

async function draftKit(env, state, kind) {
  if (!kitConfigured(env) || state.test) return null; // a rehearsal leaves Kit alone
  try {
    const tpl = notify.reminderEmail({ kind, kidName: state.kidName, scheduledAt: state.scheduledAt, liveUrl: liveUrlFor(state), replayUrl: liveUrlFor(state), unsubscribeUrl: '{{ unsubscribe_url }}', image: null, list: true });
    const r = await kitCreateBroadcast(env, { subject: tpl.subject, previewText: '', description: `[auto] ${state.kidName || 'Reveal'} ${kind}`, html: tpl.html });
    return r.ok ? (r.broadcast?.id || true) : null;
  } catch {
    return null;
  }
}

/**
 * The reveal moved to another day: rewrite its save-the-date draft with the new
 * date while it is still a draft, so Kit never holds a draft with the old date.
 * If staff already sent it, make a "new date" draft instead. Returns the draft id to keep.
 */
async function refreshKitDraft(env, state) {
  if (!kitConfigured(env)) return null;
  const id = state.kit?.scheduledDraftId;
  if (Number.isFinite(Number(id)) && id !== true) {
    const tpl = notify.reminderEmail({ kind: 'scheduled', kidName: state.kidName, scheduledAt: state.scheduledAt, liveUrl: liveUrlFor(state), replayUrl: liveUrlFor(state), unsubscribeUrl: '{{ unsubscribe_url }}', image: null, list: true });
    const r = await kitUpdateDraft(env, id, { subject: tpl.subject, previewText: '', description: `[auto] ${state.kidName || 'Reveal'} scheduled`, html: tpl.html });
    if (r.ok) return id;
    if (!r.status) return id; // Kit unreachable: keep the draft we know about rather than make a duplicate
  }
  return (await draftKit(env, state, id ? 'moved' : 'scheduled')) || id || null;
}

export function kitLiveWanted(state, config) {
  return typeof state.kitLiveEmail === 'boolean' ? state.kitLiveEmail : config.kitLive?.enabled !== false;
}

function emailImage(state) {
  if (!state.image) return null;
  if (/^https:\/\//.test(state.image)) return state.image;
  return `${SITE_ORIGIN}/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/${state.image}/w=1200,h=630,fit=cover,q=82`;
}

/**
 * Email the Kit list "we're live". Once per broadcast (claimed in
 * broadcast_sends as kind 'live', channel 'kit'); a failed send releases the
 * claim so the admin's "Email the list now" button can retry. Never throws.
 */
export async function sendKitLive(env, config, state, work, { by = 'live-broadcast' } = {}) {
  if (!kitConfigured(env) || !state.broadcastId) return state;
  if (!await claimSend(env.DB, state.broadcastId, 'live', 'kit')) return state;
  const audience = config.kitLive?.audience?.type && config.kitLive.audience.type !== 'all' ? config.kitLive.audience : { type: 'all', id: null, name: 'All subscribers' };
  const s = { ...state, kit: { ...(state.kit || {}) } };
  try {
    const tpl = notify.reminderEmail({ kind: 'live', kidName: s.kidName, scheduledAt: s.scheduledAt, liveUrl: liveUrlFor(s), unsubscribeUrl: '{{ unsubscribe_url }}', image: emailImage(s), tz: config.timezone, list: true });
    const sendAt = new Date(Date.now() + KIT_SEND_DELAY_MS).toISOString();
    const r = await kitCreateBroadcast(env, { subject: tpl.subject, previewText: "Watch the reveal happening right now.", description: `[auto] ${s.kidName || 'Reveal'} live`, html: tpl.html, sendAt, audience });
    if (r.ok) {
      s.kit.live = { id: r.broadcast?.id || null, audience: audience.name || audience.type, sendAt, by, error: null };
      await finishSend(env.DB, s.broadcastId, 'live', 'kit', { recipients: 0, sent: 1, failed: 0, error: null });
      work.push('kit-live');
      await logAudit(env.DB, { userEmail: by, action: 'published', entityType: 'newsletter', entitySlug: String(r.broadcast?.id || s.broadcastId), entityName: `Kit "we're live" email: ${s.title || 'reveal'} → ${audience.name || 'All subscribers'}`, gitStatus: 'ok' });
    } else {
      throw new Error(r.error || `Kit HTTP ${r.status}`);
    }
  } catch (err) {
    s.kit.live = { id: null, audience: audience.name || audience.type, sendAt: null, by, error: err.message };
    await env.DB.prepare(`DELETE FROM broadcast_sends WHERE broadcast_id = ? AND kind = 'live' AND channel = 'kit'`).bind(s.broadcastId).run().catch(() => {});
    work.push('kit-live-failed');
    await notify.alertAdmins(env, config, { level: 'warn', title: "Kit \"we're live\" email did not send", detail: `${err.message}. Use "Email the list now" in Admin → Broadcast to retry.`, url: `${SITE_ORIGIN}/admin/` });
  }
  return s;
}

// ─── Replay handling ────────────────────────────────────────────────

/** Move the Instagram Reel pipeline one step and tell the humans about outcomes. */
async function tickReel(env, config, state, work, opts) {
  if (!state.reel || !stream.streamConfigured(env)) return state;
  const before = state.reel.stage;
  const r = await reels.advanceReel(env, config, state, opts);
  work.push(...r.events);
  const reel = r.state.reel;
  if (reel && reel.stage !== before) {
    if (reel.stage === 'done') {
      await recordEvent(env.DB, state.broadcastId, 'reel_published', { permalink: reel.permalink, method: reel.method, start: reel.start, end: reel.end });
      await logAudit(env.DB, { userEmail: 'live-broadcast', action: 'published', entityType: 'instagram-reel', entitySlug: reel.mediaId, entityName: `Instagram Reel: ${state.title || state.broadcastId}`, changes: [{ field: 'window', from: null, to: `${reel.start}-${reel.end}s (${reel.method})` }], gitStatus: 'ok' });
      await notify.alertAdmins(env, config, { level: 'info', kind: 'news', icon: '📱', title: `Instagram Reel posted: ${state.title || 'reveal'}`, detail: `Cut ${Math.floor(reel.start / 60)}:${String(Math.floor(reel.start % 60)).padStart(2, '0')} to ${Math.floor(reel.end / 60)}:${String(Math.floor(reel.end % 60)).padStart(2, '0')} of the recording (picked by ${reel.method}).`, url: reel.permalink || undefined });
    } else if (reel.stage === 'failed' || reel.stage === 'blocked') {
      await notify.alertAdmins(env, config, { level: 'warn', title: `Instagram Reel ${reel.stage === 'blocked' ? 'needs setup' : 'failed'}: ${state.title || 'reveal'}`, detail: reel.error || 'unknown error', url: `${SITE_ORIGIN}/admin/` });
    }
  }
  return r.state;
}

async function checkReplayReady(env, config, state, health, work) {
  if (state.phase !== 'replay' || state.replayUid || state.source !== 'stream') return state;
  const last = health.replayCheckAt ? Date.parse(health.replayCheckAt) : 0;
  if (Date.now() - last < REPLAY_CHECK_INTERVAL_MS) return state;
  health.replayCheckAt = nowIso();
  if (!stream.streamConfigured(env)) return state;

  let uid = state.liveVideoUid;
  let ready = false;
  if (uid) {
    const v = await stream.getVideo(env, uid);
    ready = v.ok && v.result?.status?.state === 'ready';
  } else if (config.liveInput?.uid) {
    const vids = await stream.listInputVideos(env, config.liveInput.uid);
    const liveAt = state.liveAt ? Date.parse(state.liveAt) - 10 * 60e3 : 0;
    const v = (vids.result || []).find(x => x.status?.state === 'ready' && Date.parse(x.created) >= liveAt);
    if (v) { uid = v.uid; ready = true; }
  }
  if (!ready) return state;

  const s = { ...state, replayUid: uid, replayReadyAt: nowIso() };
  work.push('replay-ready');
  await stream.updateVideo(env, uid, { meta: { name: `${s.kidName ? `${s.kidName}'s` : 'Live'} reveal (${(s.liveAt || nowIso()).slice(0, 10)})` } }).catch(() => {});
  await stream.requestCaptions(env, uid);
  if (s.kidSlug) {
    try {
      const attached = await attachToKid(env, s.kidSlug, uid, s.title, 'live-broadcast');
      if (attached) {
        work.push(`attached:${s.kidSlug}`);
        if (await claimOnce(env.DB, s.broadcastId, 'replay-deploy') && await triggerDeploy(env, health, `Reveal replay attached to ${s.kidName || s.kidSlug}`)) work.push('deploy');
      }
    } catch { /* retry never; admin can attach */ }
  }
  await sendReminders(env, config, s, 'replay', work);
  // One Kit replay draft per broadcast; a tick that lost the race reads the winner's draft id
  let draft = null;
  if (await claimOnce(env.DB, s.broadcastId, 'kit-replay-draft')) {
    draft = await draftKit(env, s, 'replay');
    if (draft) await settleClaim(env.DB, s.broadcastId, 'kit-replay-draft', { id: draft });
  } else {
    draft = (await claimResult(env.DB, s.broadcastId, 'kit-replay-draft'))?.id || null;
  }
  if (draft) s.kit = { ...(s.kit || {}), replayDraftId: draft };
  if (reels.reelEnabled(config)) { s.reel = reels.startReel(s, uid, s.revealAtSeconds); work.push('reel:start'); }
  if (await claimOnce(env.DB, s.broadcastId, 'replay-ready')) {
    await recordEvent(env.DB, s.broadcastId, 'replay_ready', { uid });
    await logAudit(env.DB, { userEmail: 'live-broadcast', action: 'created', entityType: 'stream-video', entitySlug: uid, entityName: `Reveal recording ready: ${s.title || s.broadcastId}`, gitStatus: 'ok' });
  }
  return s;
}

/**
 * Automatic Kit send, checked every tick while live. It goes out once the
 * stream has stayed up KIT_LIVE_STEADY_MS in one stretch AND the kid is
 * known (scheduled, picked in the admin, or read from Facebook). Held, with
 * an alert, when a scheduled reveal starts more than 30 minutes early, or
 * when no kid turns up in the first 30 minutes. "Email the list now" in the
 * admin covers every held case.
 */
async function kitAutoLive(env, config, state, work) {
  if (state.phase !== 'live' || !kitConfigured(env) || state.kit?.live || !kitLiveWanted(state, config)) return state;
  if (state.source === 'manual' && !state.scheduledAt) return state; // emergency banner: humans decide
  const now = Date.now();
  const hold = async (error, title, detail) => {
    work.push('kit-live-held');
    if (await claimOnce(env.DB, state.broadcastId, 'kit-live-held')) await notify.alertAdmins(env, config, { level: 'warn', title, detail, url: `${SITE_ORIGIN}/admin/` });
    return { ...state, kit: { ...(state.kit || {}), live: { id: null, held: true, error } } };
  };
  if (state.scheduledAt && Date.parse(state.liveAt) < Date.parse(state.scheduledAt) - KIT_LIVE_EARLY_MS) {
    return hold('Went live more than 30 minutes early; not sent automatically', 'Went live early: Kit email held', `${state.title || 'The reveal'} went live more than 30 minutes before its scheduled time, so the "we're live" email to the Kit list was not sent automatically (it could be a phone test). If this is the real reveal, press "Email the list now" in Admin → Broadcast.`);
  }
  if (now - Date.parse(state.segmentAt || state.liveAt) < KIT_LIVE_STEADY_MS) return state;

  let s = state;
  if (!s.kidSlug) s = await identifyKid(env, s, work);
  if (!s.kidSlug) {
    if (now - Date.parse(s.liveAt) > KIT_LIVE_LATE_MS) {
      state = s;
      return hold('No kid identified in the first 30 minutes', "Kit email not sent: which kid is this?", 'The stream has been live 30 minutes and nothing said which kid it is, so the "we\'re live" email was not sent. Pick the kid and press "Email the list now" in Admin → Broadcast if it is still worth sending.');
    }
    if (!s.kidAlertAt) {
      s = { ...s, kidAlertAt: nowIso() };
      if (await claimOnce(env.DB, s.broadcastId, 'kid-alert')) await notify.alertAdmins(env, config, { level: 'warn', title: 'Live now: which kid is this?', detail: 'The Kit "we\'re live" email is waiting for the kid. Nothing on Facebook named one yet. Pick the kid in Admin → Broadcast → Now and the email goes out right away, or put the kid\'s name in the first line of the Facebook post.', url: `${SITE_ORIGIN}/admin/` });
    }
    return s;
  }
  if (now - Date.parse(s.liveAt) > KIT_LIVE_LATE_MS && s.kidVia !== 'admin') {
    state = s;
    return hold('Kid identified more than 30 minutes in; not sent automatically', 'Kit email not sent: too late', `${s.kidName || 'The kid'} was identified more than 30 minutes into the stream, so the "we're live" email was not sent by itself. Press "Email the list now" in Admin → Broadcast if it is still worth sending.`);
  }
  return sendKitLive(env, config, s, work);
}

/** Kids a reveal could be for: no reveal video yet, this year or last. */
async function openKids(DB) {
  const res = await DB.prepare('SELECT slug, name, year, status, data FROM kids').all();
  const year = new Date(Date.now()).getUTCFullYear();
  return (res?.results || []).map((r) => {
    let d = {}; try { d = JSON.parse(r.data || '{}'); } catch {}
    return { slug: r.slug, name: r.name || d.name, year: Number(r.year) || null, image: d.heroImage || d.photos?.[0]?.url || null, reveal: d.revealVideoUrl || null };
  }).filter((k) => k.name && !k.reveal && k.year && k.year >= year - 1);
}

/**
 * Work out which kid an unscheduled reveal is for from what's public on
 * Facebook: the live post first, then the Page's posts from the last day,
 * newest first. A clue only counts when it names exactly one open kid.
 * Throttled to once a minute. The other session's waiting screen, the
 * admin, or a schedule setting state.kidSlug short-circuits all of this.
 */
async function identifyKid(env, state, work) {
  if (!fb.fbConfigured(env)) return state;
  if (state.kidCheckAt && Date.now() - Date.parse(state.kidCheckAt) < KID_CLUE_INTERVAL_MS) return state;
  const s = { ...state, kidCheckAt: nowIso() };
  const [clues, kids] = await Promise.all([fb.fbRevealClues(env), openKids(env.DB)]);
  const ordered = [...clues.filter((c) => c.source === 'facebook-live'), ...clues.filter((c) => c.source !== 'facebook-live').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))];
  for (const c of ordered) {
    for (const text of [c.lead, c.text]) {
      const m = matchKids(kids, text);
      if (m.length > 1) break; // ambiguous clue: try the next one
      if (m.length === 1) return applyKid(s, m[0], c.source, work);
    }
  }
  return s;
}

function applyKid(state, kid, via, work) {
  const generic = !state.kidSlug;
  const s = { ...state, kidSlug: kid.slug, kidName: kid.name, kidVia: via };
  if (!s.image && kid.image) s.image = kid.image;
  if (generic) { s.title = `${kid.name}'s room reveal`; s.message = `Watch ${kid.name}'s room reveal live`; }
  if (work) work.push(`kid:${kid.slug}:${via}`);
  return s;
}

// ─── Facebook side effects ──────────────────────────────────────────

async function fbOnLive(env, config, state, work) {
  const s = { ...state, fb: { ...(state.fb || {}) } };
  if (!fb.fbConfigured(env)) return s;
  if (config.facebook?.mode === 'api' && !s.fb.liveVideoId && !s.fb.needsReview && config.liveInput?.uid) {
    // One Facebook live post per broadcast, however many ticks race here; the claim keeps its ids
    if (!(await claimOnce(env.DB, s.broadcastId, 'fb-live-post'))) {
      const made = await claimResult(env.DB, s.broadcastId, 'fb-live-post');
      if (made?.liveVideoId) { s.fb.liveVideoId = made.liveVideoId; s.fb.outputUid = made.outputUid || null; }
      return s;
    }
    const created = await fb.createFbLiveVideo(env, { title: s.title, description: s.message });
    if (created.ok) {
      s.fb.liveVideoId = created.id;
      await settleClaim(env.DB, s.broadcastId, 'fb-live-post', { liveVideoId: created.id, outputUid: null });
      const split = fb.splitIngestUrl(created.ingestUrl);
      if (split && stream.streamConfigured(env)) {
        const out = await stream.createOutput(env, config.liveInput.uid, { url: split.url, streamKey: split.streamKey, enabled: true });
        if (out.ok) {
          s.fb.outputUid = out.result?.uid || null; work.push('fb-api-output');
          await settleClaim(env.DB, s.broadcastId, 'fb-live-post', { liveVideoId: created.id, outputUid: s.fb.outputUid });
        }
      }
      work.push('fb-live-post');
    } else {
      s.fb.lastError = created.error;
      if (created.needsReview) s.fb.needsReview = true;
      work.push('fb-live-post-failed');
    }
  }
  return s;
}

async function fbRefreshPermalink(env, state, work) {
  const s = { ...state, fb: { ...(state.fb || {}) } };
  if (!fb.fbConfigured(env) || s.fb.permalink) return s;
  const last = s.fb.checkedAt ? Date.parse(s.fb.checkedAt) : 0;
  if (Date.now() - last < FB_PERMALINK_INTERVAL_MS) return s;
  s.fb.checkedAt = nowIso();
  let permalink = null;
  if (s.fb.liveVideoId) permalink = await fb.fbLiveVideoPermalink(env, s.fb.liveVideoId);
  if (!permalink) { const cur = await fb.fbCurrentLive(env); if (cur) { permalink = cur.permalink; s.fb.liveVideoId = s.fb.liveVideoId || cur.id; } }
  if (permalink) { s.fb.permalink = permalink; work.push('fb-permalink'); }
  return s;
}

async function fbOnEnd(env, config, state, work) {
  const s = { ...state, fb: { ...(state.fb || {}) } };
  if (config.facebook?.mode === 'api' && s.fb.liveVideoId && !s.fb.ended) {
    const r = await fb.endFbLiveVideo(env, s.fb.liveVideoId);
    s.fb.ended = r.ok;
    if (r.ok) work.push('fb-ended');
    if (s.fb.outputUid && config.liveInput?.uid && stream.streamConfigured(env)) {
      await stream.deleteOutput(env, config.liveInput.uid, s.fb.outputUid).catch(() => {});
      s.fb.outputUid = null;
    }
  }
  return s;
}

// ─── Health ─────────────────────────────────────────────────────────

async function runHealth(env, config, state, health, work, { force = false } = {}) {
  const now = Date.now();
  const last = health.lastDailyAt ? Date.parse(health.lastDailyAt) : 0;
  const soon = state.scheduledAt && Date.parse(state.scheduledAt) - now < 24 * 3600e3 && Date.parse(state.scheduledAt) > now;
  const due = force || now - last > DAILY_HEALTH_MS || (soon && now - last > REVEAL_MORNING_HEALTH_MS);
  if (!due) return;
  health.lastDailyAt = nowIso();
  work.push('health');
  const problems = [];

  if (stream.streamConfigured(env)) {
    const t = await stream.checkToken(env);
    health.stream = { ok: t.ok, error: t.error || null, at: nowIso() };
    if (!t.ok) problems.push(`Cloudflare Stream token failed: ${t.error}`);
    if (t.ok && config.liveInput?.uid) {
      const li = await stream.getLiveInput(env, config.liveInput.uid);
      if (!li.ok) problems.push(`Live input ${config.liveInput.uid} not found: ${stream.errorMessage(li)}`);
    }
  } else {
    health.stream = { ok: false, error: 'CF_STREAM_TOKEN / CF_ACCOUNT_ID not set', at: nowIso() };
    problems.push('Cloudflare Stream is not configured');
  }
  if (!config.liveInput?.uid) problems.push('No live input yet: open Admin → Broadcast → Settings → Phones');

  const f = await fb.checkFbToken(env);
  health.facebook = { ok: f.ok, name: f.name || null, error: f.error || null, at: nowIso(), configured: f.configured !== false };
  if (f.configured !== false && !f.ok) problems.push(`Facebook token failed: ${f.error}`);

  const h = await hubStatus(env);
  health.hub = { ok: !!h.ok, clients: h.clients || 0, at: nowIso(), error: h.error || null, lastTick: h.lastTick || null };
  if (!h.ok) problems.push(`Real-time hub unreachable: ${h.error || 'unknown'}`);

  const key = problems.length ? problems.join(' | ') : '';
  const prev = health.flags?.problems || '';
  if (key && key !== prev) {
    await notify.alertAdmins(env, config, { level: 'error', title: soon ? 'Reveal-day check found problems' : 'Live broadcast health check failed', detail: problems.map((p) => `• ${p}`).join('\n'), url: `${SITE_ORIGIN}/admin/`, issue: 'broadcast-health' });
    work.push('alert:health');
  } else if (!key && prev) {
    await notify.alertAdmins(env, config, { level: 'info', title: 'Live broadcast health recovered', detail: 'All checks pass again.', url: `${SITE_ORIGIN}/admin/`, resolves: 'broadcast-health' });
  }
  health.flags = { ...(health.flags || {}), problems: key };
}

// ─── Go-live and ended effects ──────────────────────────────────────

const recent = (iso) => !!iso && Date.now() - Date.parse(iso) <= EFFECTS_RETRY_MS;

/**
 * What a stream going live sets off, each until its claim exists: the
 * broadcast's row, the Facebook live post (API mode) and the staff "Live now"
 * announcement (event, audit, alert). The "we're live" reminders follow the
 * same rule through dueReminderKinds. Runs on the tick that saves the change
 * and on every tick after for EFFECTS_RETRY_MS, so a tick cut off right after
 * saving the phase (a D1 error, a cancelled request) loses none of them.
 * A banner-only go-live is the admin's own command and sets off nothing here.
 */
async function goLiveEffects(env, config, state, work, by) {
  const { DB } = env;
  if (!['live', 'ending'].includes(state.phase) || state.source !== 'stream' || !state.broadcastId || !recent(state.liveAt)) return state;
  const done = await claimedKeys(DB, state.broadcastId);
  if (!done.has('live-row')) { await upsertBroadcastRow(DB, state); await claimOnce(DB, state.broadcastId, 'live-row'); }
  // Also when the post was claimed but this state lacks its id (the tick that made it lost its save): fbOnLive reads it back
  if (!done.has('fb-live-post') || (config.facebook?.mode === 'api' && !state.fb?.liveVideoId)) state = await fbOnLive(env, config, state, work);
  if (!done.has('live-announce') && await claimOnce(DB, state.broadcastId, 'live-announce')) {
    await recordEvent(DB, state.broadcastId, 'live_start', { source: state.source, videoUid: state.liveVideoUid });
    await logAudit(DB, { userEmail: by || 'live-broadcast', action: 'published', entityType: 'live-status', entitySlug: state.broadcastId, entityName: state.title || 'Live broadcast', gitStatus: 'ok' });
    await notify.alertAdmins(env, config, {
      level: 'info', kind: 'news', icon: '📡', title: `Live now: ${state.title || 'the reveal'}`,
      detail: 'The site, Facebook and YouTube are all showing it.',
      facts: [['Started from', 'The phone']],
      url: liveUrlFor(state), links: [{ label: 'Open the control room', url: `${SITE_ORIGIN}/admin/#broadcast/control-room` }],
    });
    work.push('announced-live');
  }
  return state;
}

/**
 * What a stream ending sets off, by the same rule: the row, ending the
 * Facebook live video (API mode), and the "Ended" announcement with the feed
 * monitor's health report. "End now" in the admin claims the last two itself.
 */
async function endedEffects(env, config, state, health, work, by) {
  const { DB } = env;
  if (state.phase !== 'replay' || state.source !== 'stream' || !state.broadcastId || !recent(state.endedAt)) return state;
  const done = await claimedKeys(DB, state.broadcastId);
  if (!done.has('ended-row')) { await upsertBroadcastRow(DB, state); await claimOnce(DB, state.broadcastId, 'ended-row'); }
  if (!done.has('fb-ended') && await claimOnce(DB, state.broadcastId, 'fb-ended')) state = await fbOnEnd(env, config, state, work);
  if (!done.has('ended-announce') && await claimOnce(DB, state.broadcastId, 'ended-announce')) {
    const mins = state.liveAt ? Math.round((Date.parse(state.endedAt || nowIso()) - Date.parse(state.liveAt)) / 60000) : null;
    await recordEvent(DB, state.broadcastId, 'live_end', { minutes: mins });
    await logAudit(DB, { userEmail: by || 'live-broadcast', action: 'updated', entityType: 'live-status', entitySlug: state.broadcastId, entityName: `Ended: ${state.title || 'Live broadcast'}`, changes: [{ field: 'minutes', from: null, to: mins }], gitStatus: 'ok' });
    // The feed monitor's health report (sound, issues, Facebook/YouTube timing) rides along
    const ended = await monitor.finish(env, config, state, health, recordEvent).catch(() => ({ summary: '' }));
    await notify.alertAdmins(env, config, { level: 'info', kind: 'news', icon: '🎬', title: `Ended: ${state.title || 'the reveal'}`, detail: [mins != null ? `Ran ${mins} minutes.` : null, ended.summary || null, mins != null ? 'Replay will attach to the kid\'s page when Stream finishes processing.' : 'Replay will attach when ready.'].filter(Boolean).join('\n'), url: `${SITE_ORIGIN}/admin/` });
    work.push('announced-end');
  }
  return state;
}

// ─── The tick ───────────────────────────────────────────────────────

/**
 * Reconcile with Stream, apply timers, fire side effects, persist, and
 * return the public state. Safe to call from anywhere. One tick runs at a
 * time across every isolate (the D1 lease); unless `force`, a tick also waits
 * `minIntervalMs` after the last one started, here and everywhere else. A
 * caller that finds a tick already running gets the current state with
 * `busy: true`. Public routes never pass `force`.
 */
export async function runTick(env, { source = 'tick', force = false, by = null, minIntervalMs = TICK_MIN_INTERVAL_MS } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const interval = Math.max(minIntervalMs, TICK_MIN_INTERVAL_MS);
  if (!force && _lastTickResult && Date.now() - _lastTickAt < interval) return { ..._lastTickResult, cached: true };
  if (!force && interval > TICK_MIN_INTERVAL_MS && _lastBusyResult && Date.now() - _lastBusyAt < interval) return { ..._lastBusyResult, cached: true };

  // A forced tick (webhook, the admin's Refresh) waits a moment for a running one rather than skip
  const lease = force ? await waitForTickLease(DB, FORCED_LEASE_WAIT_MS) : await acquireTickLease(DB, { minIntervalMs: interval });
  if (!lease) {
    const [config, state] = await Promise.all([readConfig(DB), readState(DB)]);
    const result = { state: publicState(state, config), reason: source, work: [], changed: false, busy: true };
    // Not the tick cache: a visitor that found the lease busy must not hold up the hub's next heartbeat
    _lastBusyAt = Date.now();
    _lastBusyResult = result;
    return result;
  }
  // A long tick keeps the lease (at most one extend per LEASE_EXTEND_AFTER_MS); false once another tick has it
  let extendedAt = Date.now();
  const keepLease = async () => {
    if (Date.now() - extendedAt < LEASE_EXTEND_AFTER_MS) return true;
    extendedAt = Date.now();
    return extendTickLease(DB, lease);
  };
  try {
    const result = await tick(env, { source, force, by, keepLease });
    _lastTickAt = Date.now();
    _lastTickResult = result;
    return result;
  } finally {
    await releaseTickLease(DB, lease);
  }
}

// The state as far as "did anything change" goes (rev and updatedAt are bookkeeping)
const stateSig = (s) => JSON.stringify({ ...s, rev: undefined, updatedAt: undefined });

async function tick(env, { source, force, by, keepLease = async () => true }) {
  const { DB } = env;
  const now = Date.now();
  const [config, health] = await Promise.all([readConfig(DB), readHealth(DB)]);
  const healthBefore = JSON.stringify(health);
  const read = await readState(DB);
  let rev = Number(read.rev) || 0;
  let base = read;          // the stored copy, as far as this tick knows
  let state = read;
  const prevPhase = state.phase;
  const work = [];
  let missed = null;        // a scheduled reveal that never streamed, announced once the clear is saved

  // 1. Stream is the authority on "is video arriving"
  const inputUid = config.liveInput?.uid;
  if (inputUid && (force || now - _lastLifecycleAt >= LIFECYCLE_MIN_INTERVAL_MS)) {
    const lc = await stream.lifecycle(config.customerCode, inputUid);
    _lastLifecycleAt = Date.now();
    if (lc) {
      health.lifecycle = { at: nowIso(), live: lc.live, videoUID: lc.videoUID, inputUid };
      if (lc.live) {
        if (state.phase === 'live') {
          if (lc.videoUID && state.liveVideoUid !== lc.videoUID) state = { ...state, liveVideoUid: lc.videoUID };
        } else if (state.phase === 'ending') {
          state = tReconnected(state); work.push('reconnected');
        } else if (state.source !== 'manual') {
          state = tStartLive(state, { videoUid: lc.videoUID, source: 'stream' }, config); work.push('auto-start');
        }
      } else if (state.source === 'stream') {
        if (state.phase === 'live') { state = tDisconnected(state); work.push('disconnected'); }
        else if (state.phase === 'ending' && now - Date.parse(state.disconnectedAt || 0) >= ENDING_GRACE_MS) { state = tEnd(state, config); work.push('ended'); }
      }
    }
  }

  // 2. Timers
  if (state.phase === 'scheduled' && state.scheduledAt && Date.parse(state.scheduledAt) - now <= ARM_WINDOW_MS) {
    state = { ...state, phase: 'armed', armedAt: nowIso() }; work.push('armed');
  }
  if ((state.phase === 'scheduled' || state.phase === 'armed') && state.scheduledAt && now - Date.parse(state.scheduledAt) > SCHEDULED_EXPIRE_MS) {
    missed = state;
    state = tClear(state, 'missed'); work.push('missed');
  }
  if (state.phase === 'live' && state.source === 'manual' && state.manual?.until && now >= Date.parse(state.manual.until)) {
    state = tClear(state, 'manual-expired'); work.push('manual-expired');
  }
  if (state.phase === 'live' && state.source === 'stream' && state.liveAt && now - Date.parse(state.liveAt) > MAX_LIVE_HOURS * 3600e3) {
    state = tEnd(state, config); work.push('max-hours');
  }
  if (state.phase === 'replay' && state.replayUntil && now >= Date.parse(state.replayUntil)) {
    state = tClear(state, 'replay-expired'); work.push('replay-expired');
  }

  // 3. A phase change is saved before any of its side effects, and only over
  //    the copy this tick read. A tick that lost the race stops here; the next
  //    one starts from whatever won. The side effects (step 4) are claimed, so
  //    each happens once, on this tick or, if this one is cut off, a later one.
  if (state.phase !== prevPhase) {
    state = { ...state, updatedAt: nowIso() };
    if (!(await writeStateIf(DB, state, rev))) {
      work.push('conflict');
      return { state: publicState(await readState(DB), config), reason: 'conflict', work, changed: false, conflict: true };
    }
    rev += 1;
    state = { ...state, rev };
    base = state;
    await upsertBroadcastRow(DB, state);
    if (missed) {
      if (await claimOnce(DB, missed.broadcastId, 'missed')) {
        await notify.alertAdmins(env, config, { level: 'warn', icon: '⏰', title: 'Scheduled reveal never went live', detail: `${missed.title || 'Reveal'} was scheduled for ${missed.scheduledAt} and no stream arrived. The countdown has been cleared.`, url: `${SITE_ORIGIN}/admin/` });
        await recordEvent(DB, missed.broadcastId, 'missed');
      }
      await closeBroadcastRow(DB, missed, 'missed');
    }
    if (state.phase === 'ending') await recordEvent(DB, state.broadcastId, 'disconnected');
  }

  // 4. What going live or ending sets off, until each part has happened (also on later ticks), then
  //    ongoing work. Each step first keeps the lease; if another tick has taken it, this one stops
  //    and saves what it has (over the copy it read, as always)
  const live = () => state.phase === 'live' || state.phase === 'ending';
  const steps = [
    async () => { state = await goLiveEffects(env, config, state, work, by); },
    async () => { state = await endedEffects(env, config, state, health, work, by); },
    async () => { if (live()) state = await fbRefreshPermalink(env, state, work); },
    // Feed watch, go/no-go and mic checks only report; nothing they do may stop the state machine
    async () => { if (live() && state.source === 'stream') await monitor.watch(env, config, state, health, work, recordEvent).catch((e) => work.push(`monitor-error: ${e.message}`)); },
    async () => { if (state.phase === 'scheduled' || state.phase === 'armed') await preflight.auto(env, config, state, health, work, { hubStatus }).catch((e) => work.push(`preflight-error: ${e.message}`)); },
    async () => { if (!live() && await monitor.watchRehearsal(env, config, health).catch(() => false)) work.push('mic-check'); },
    async () => { state = await kitAutoLive(env, config, state, work); },
    async () => { for (const kind of await dueReminderKinds(DB, state, config)) await sendReminders(env, config, state, kind, work); },
    async () => { state = await checkReplayReady(env, config, state, health, work); },
    async () => { state = await tickReel(env, config, state, work); },
    async () => { await runHealth(env, config, state, health, work); },
  ];
  for (const step of steps) {
    if (!(await keepLease())) { work.push('lease-lost'); break; }
    await step();
  }

  // 5. Persist, over the copy this tick knows; anything an admin saved meanwhile is merged, theirs winning
  if (stateSig(state) !== stateSig(base)) {
    const saved = await commitState(DB, base, { ...state, updatedAt: nowIso() }, rev);
    if (saved.dropped) work.push('conflict');
    else await upsertBroadcastRow(DB, saved.state);
    state = saved.state;
  }
  health.lastTick = { at: nowIso(), source, work };
  // Only touch D1 when something meaningful changed (lastTick alone isn't worth a write every few seconds)
  const healthAfter = JSON.stringify({ ...health, lastTick: null });
  if (healthAfter !== JSON.stringify({ ...JSON.parse(healthBefore), lastTick: null }) || work.length) await writeHealth(DB, health);

  return { state: publicState(state, config), reason: work.length ? work.join(',') : source, work, changed: stateSig(state) !== stateSig(read) };
}

// ─── Admin commands ─────────────────────────────────────────────────

function isoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function sanitizeImage(val) {
  if (val === undefined || val === null || val === '') return null;
  const img = String(val).trim();
  if (img.length > 300) return undefined;
  if (/^https:\/\/imagedelivery\.net\/[\w\-./%]+$/.test(img)) return img;
  if (/^[\w][\w\-./%]*$/.test(img)) return img;
  return undefined;
}

const JOB_ID = /^[A-Za-z0-9]{6,32}$/;

/** 'YYYY-MM-DD' of an instant in the broadcast's time zone */
function dayIn(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

async function kidByName(DB, slug) {
  if (!slug) return null;
  const row = await DB.prepare('SELECT slug, name, data FROM kids WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data); } catch {}
  return { slug: row.slug, name: row.name || data.name || slug, image: data.heroImage || data.photos?.[0]?.url || null };
}

/**
 * Admin state commands. Returns { success, state, error }. Publishes to the
 * hub on success so open pages update immediately. A command holds the tick
 * lease (waiting a few seconds for a running tick), so a tick never saves a
 * stale copy over what staff just asked for.
 */
export async function adminAction(env, action, body = {}, userEmail = 'unknown') {
  await ensureSchema(env.DB);
  const lease = await waitForTickLease(env.DB, ADMIN_LEASE_WAIT_MS);
  try {
    return await runAdminAction(env, action, body, userEmail);
  } finally {
    await releaseTickLease(env.DB, lease);
  }
}

async function runAdminAction(env, action, body, userEmail) {
  const { DB } = env;
  const config = await readConfig(DB);
  let state = await readState(DB);
  const fail = (error, status = 400) => ({ success: false, error, status });

  switch (action) {
    case 'schedule': {
      const scheduledAt = isoOrNull(body.scheduledAt);
      if (!scheduledAt) return fail('scheduledAt is not a valid date');
      if (['live', 'ending'].includes(state.phase)) return fail('A broadcast is live right now; end it before scheduling another');
      const kid = await kidByName(DB, body.kidSlug);
      const image = sanitizeImage(body.image ?? kid?.image ?? null);
      if (image === undefined) return fail('image must be a Cloudflare image id or imagedelivery.net URL');
      // Scheduling over a planned reveal replaces it; close the old row so History doesn't show both
      if (['scheduled', 'armed'].includes(state.phase)) await closeBroadcastRow(DB, state, 'cancelled');
      const jobId = JOB_ID.test(String(body.jobId || '')) ? String(body.jobId) : null;
      state = tSchedule(state, { kidSlug: kid?.slug || null, kidName: kid?.name || null, jobId, test: body.test === true, scheduledAt, title: body.title, message: body.message, image, kitLiveEmail: body.kitLiveEmail, by: userEmail }, config);
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      const work = [];
      // A save-the-date only makes sense with some lead time; inside 26 h the day-before reminder covers it
      if (Date.parse(scheduledAt) - Date.now() > 26 * 3600e3) await sendReminders(env, config, state, 'scheduled', work);
      const draft = await draftKit(env, state, 'scheduled');
      if (draft) { state.kit = { ...(state.kit || {}), scheduledDraftId: draft }; await writeState(DB, state); }
      await recordEvent(DB, state.broadcastId, 'scheduled', { scheduledAt, kidSlug: state.kidSlug });
      await logAudit(DB, { userEmail, action: 'created', entityType: 'live-status', entitySlug: state.broadcastId, entityName: state.title, changes: [{ field: 'scheduledAt', from: null, to: scheduledAt }], gitStatus: 'ok' });
      break;
    }
    case 'update': {
      if (state.phase === 'idle') return fail('Nothing is scheduled or live');
      const s = { ...state };
      if (body.title !== undefined) s.title = String(body.title).trim().slice(0, 140) || s.title;
      if (body.message !== undefined) s.message = String(body.message).trim().slice(0, 200) || s.message;
      if (body.image !== undefined) { const img = sanitizeImage(body.image); if (img === undefined) return fail('bad image'); s.image = img; }
      if (JOB_ID.test(String(body.jobId || ''))) s.jobId = String(body.jobId);
      let movedFrom = null;
      if (body.scheduledAt !== undefined && ['scheduled', 'armed'].includes(s.phase)) {
        const at = isoOrNull(body.scheduledAt); if (!at) return fail('scheduledAt is not a valid date');
        // A new day re-arms the reminders; a new time on the same day keeps what already went out
        if (s.scheduledAt && dayIn(s.scheduledAt, config.timezone) !== dayIn(at, config.timezone)) movedFrom = s.scheduledAt;
        s.scheduledAt = at; s.phase = Date.parse(at) - Date.now() <= ARM_WINDOW_MS ? 'armed' : 'scheduled';
        if (s.phase === 'armed' && !s.armedAt) s.armedAt = nowIso();
      }
      if (body.kidSlug !== undefined && ['scheduled', 'armed'].includes(s.phase)) {
        const kid = await kidByName(DB, body.kidSlug); s.kidSlug = kid?.slug || null; s.kidName = kid?.name || null;
        if (!body.image && kid?.image) s.image = kid.image;
        s.kidVia = kid ? 'admin' : null;
      } else if (body.kidSlug && ['live', 'ending'].includes(s.phase)) {
        // Unscheduled reveal: naming the kid releases the waiting Kit email
        const kid = await kidByName(DB, body.kidSlug);
        if (!kid) return fail('No such kid');
        Object.assign(s, applyKid(s, kid, 'admin', null));
      }
      if (typeof body.kitLiveEmail === 'boolean') s.kitLiveEmail = body.kitLiveEmail;
      if (body.revealAtMinute !== undefined) { const m = body.revealAtMinute === '' || body.revealAtMinute === null ? null : Number(body.revealAtMinute); if (m !== null && !(m >= 0 && m < 600)) return fail('revealAtMinute must be a number of minutes'); s.revealAtSeconds = m === null ? null : Math.round(m * 60); }
      if (body.url !== undefined && s.source === 'manual') s.manual = { ...(s.manual || {}), url: String(body.url) };
      s.updatedBy = userEmail;
      state = s;
      if (s.kidVia === 'admin' && s.phase === 'live') state = await kitAutoLive(env, config, state, []);
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      if (movedFrom) {
        // Moved to another day: the day-before and hour-before reminders go out again for the new date,
        // people who could have seen the old date hear about the new one, and Kit gets a fresh draft
        await DB.prepare("DELETE FROM broadcast_sends WHERE broadcast_id = ? AND kind IN ('moved', 'day', 'hour')").bind(state.broadcastId).run();
        await recordEvent(DB, state.broadcastId, 'moved', { from: movedFrom, to: state.scheduledAt });
        if (Date.parse(state.scheduledAt) - Date.now() > 26 * 3600e3) await sendReminders(env, config, state, 'moved', []);
        const draft = await refreshKitDraft(env, state);
        if (draft && draft !== state.kit?.scheduledDraftId) { state.kit = { ...(state.kit || {}), scheduledDraftId: draft }; await writeState(DB, state); }
      }
      await logAudit(DB, { userEmail, action: 'updated', entityType: 'live-status', entitySlug: state.broadcastId, entityName: state.title, ...(movedFrom ? { changes: [{ field: 'scheduledAt', from: movedFrom, to: state.scheduledAt }] } : {}), gitStatus: 'ok' });
      break;
    }
    case 'cancel': {
      if (!['scheduled', 'armed'].includes(state.phase)) return fail('Nothing scheduled to cancel');
      await recordEvent(DB, state.broadcastId, 'cancelled');
      await logAudit(DB, { userEmail, action: 'deleted', entityType: 'live-status', entitySlug: state.broadcastId, entityName: `Cancelled: ${state.title}`, gitStatus: 'ok' });
      await closeBroadcastRow(DB, state, 'cancelled');
      state = tClear(state, 'cancelled', userEmail);
      await writeState(DB, state);
      break;
    }
    case 'goLiveManual': {
      // Banner-only fallback: no Stream input involved (e.g. streaming from the Facebook app in a pinch)
      if (['live', 'ending'].includes(state.phase) && state.source === 'stream') return fail('A Stream broadcast is live');
      const hours = Math.min(12, Math.max(0.5, Number(body.durationHours) || 6));
      const url = body.url ? String(body.url) : (config.facebook?.pageUrl || SITE_ORIGIN);
      if (!/^https:\/\//.test(url)) return fail('url must be https');
      const image = sanitizeImage(body.image); if (image === undefined) return fail('bad image');
      const kid = await kidByName(DB, body.kidSlug);
      state = tStartLive(state, { source: 'manual', by: userEmail }, config);
      state.kidSlug = kid?.slug || state.kidSlug; state.kidName = kid?.name || state.kidName;
      if (body.message) state.message = String(body.message).slice(0, 200);
      if (body.title) state.title = String(body.title).slice(0, 140);
      if (image) state.image = image;
      state.manual = { url, until: new Date(Date.now() + hours * 3600e3).toISOString() };
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      await recordEvent(DB, state.broadcastId, 'live_start', { source: 'manual' });
      state = await kitAutoLive(env, config, state, []);
      await logAudit(DB, { userEmail, action: 'published', entityType: 'live-status', entitySlug: state.broadcastId, entityName: `Manual banner: ${state.message}`, gitStatus: 'ok' });
      break;
    }
    case 'sendKitLive': {
      // By hand: an unplanned go-live, an early start the automatic send held back, or a retry
      if (!['live', 'ending'].includes(state.phase)) return fail('Only while live');
      if (!kitConfigured(env)) return fail('Kit is not connected (KIT_API_KEY)');
      const work = [];
      state = await sendKitLive(env, config, state, work, { by: userEmail });
      if (!work.includes('kit-live')) return fail(state.kit?.live?.error || 'Already emailed for this broadcast');
      await writeState(DB, state);
      break;
    }
    case 'endNow': {
      if (!['live', 'ending'].includes(state.phase)) return fail('Nothing is live');
      const work = [];
      if (state.source === 'manual') state = tClear(state, 'ended-manually', userEmail);
      else {
        // This command ends Facebook's video and records the end itself, so the tick's ended effects skip both
        await claimOnce(DB, state.broadcastId, 'fb-ended');
        await claimOnce(DB, state.broadcastId, 'ended-announce');
        state = tEnd(state, config, { by: userEmail }); state = await fbOnEnd(env, config, state, work);
      }
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      await recordEvent(DB, state.broadcastId, 'live_end', { by: userEmail });
      await logAudit(DB, { userEmail, action: 'updated', entityType: 'live-status', entitySlug: state.broadcastId, entityName: 'Ended by admin', gitStatus: 'ok' });
      break;
    }
    case 'clearReplay': {
      if (state.phase !== 'replay') return fail('No replay showing');
      state = tClear(state, 'replay-cleared', userEmail);
      await writeState(DB, state);
      break;
    }
    case 'extendReplay': {
      if (state.phase !== 'replay') return fail('No replay showing');
      const hours = Math.min(24 * 30, Math.max(1, Number(body.hours) || 72));
      state = { ...state, replayUntil: new Date(Date.now() + hours * 3600e3).toISOString(), updatedBy: userEmail };
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      break;
    }
    case 'setReplay': {
      const uid = String(body.uid || '').trim();
      if (!/^[a-f0-9]{32}$/i.test(uid)) return fail('uid must be a Stream video id');
      if (state.phase !== 'replay') return fail('Only while a replay is showing');
      state = { ...state, replayUid: uid, replayReadyAt: nowIso(), updatedBy: userEmail };
      if (reels.reelEnabled(config) && (!state.reel || state.reel.stage !== 'done')) state.reel = reels.startReel(state, uid, state.revealAtSeconds);
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      break;
    }
    case 'reelRetry': {
      const uid = state.replayUid;
      if (!uid) return fail('No replay recording yet');
      const m = body.revealAtMinute === undefined || body.revealAtMinute === '' || body.revealAtMinute === null ? null : Number(body.revealAtMinute);
      if (m !== null && !(m >= 0 && m < 600)) return fail('revealAtMinute must be a number of minutes');
      const seconds = m === null ? state.revealAtSeconds : Math.round(m * 60);
      state = { ...state, revealAtSeconds: seconds ?? null, reel: reels.startReel(state, uid, seconds ?? null), updatedBy: userEmail };
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      await logAudit(DB, { userEmail, action: 'updated', entityType: 'instagram-reel', entitySlug: state.broadcastId, entityName: m !== null ? `Reel re-cut at minute ${m}` : 'Reel retried', gitStatus: 'ok' });
      break;
    }
    case 'reelSkip': {
      if (!state.reel) return fail('No Reel in progress');
      state = { ...state, reel: { ...state.reel, stage: 'skipped', updatedAt: nowIso() }, updatedBy: userEmail };
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      break;
    }
    case 'reset': {
      state = tClear(state, 'reset', userEmail);
      await writeState(DB, state);
      await logAudit(DB, { userEmail, action: 'deleted', entityType: 'live-status', entitySlug: 'broadcast', entityName: 'Broadcast state reset', gitStatus: 'ok' });
      break;
    }
    default:
      return fail(`Unknown action "${action}"`);
  }

  state.updatedAt = nowIso();
  await writeState(DB, state);
  _lastTickResult = null; // next tick must recompute
  _lastBusyResult = null;
  await publishToHub(env, state, config, `admin:${action}`);
  return { success: true, state: publicState(state, config, { includeTest: true }), legacy: legacyState(state, config, { includeTest: true }) };
}

// ─── Public read ────────────────────────────────────────────────────

/** Public state plus the bits the live page needs (push key, channel availability). */
export async function publicPayload(env) {
  const { DB } = env;
  await ensureSchema(DB);
  const [config, state] = await Promise.all([readConfig(DB), readState(DB)]);
  return {
    state: publicState(state, config),
    reminders: {
      enabled: !!config.reminders?.enabled,
      email: notify.emailConfigured(env),
      sms: !!config.reminders?.sms && notify.smsConfigured(env),
      push: !!config.reminders?.push && !!config.vapid?.publicKey,
      pushKey: config.reminders?.push ? (config.vapid?.publicKey || null) : null,
    },
    messages: { enabled: config.messages?.enabled !== false },
    timezone: config.timezone,
    hub: !!env.LIVE_HUB,
  };
}
