/**
 * Live broadcast state machine
 * ============================
 * The single source of truth for "what is the site showing about the live
 * reveal right now". State lives in D1 (site_config key "broadcast"),
 * settings in "broadcast-config", diagnostics in "broadcast-health".
 * Everything that changes state funnels through runTick() or adminAction()
 * so side effects fire exactly once.
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
 * captions + kid-page attach + rebuild, Kit drafts, Slack/email alerts,
 * analytics rows, audit log.
 */

import { logAudit } from './_audit.js';
import * as stream from './_stream-live.js';
import * as notify from './_broadcast-notify.js';
import * as fb from './_broadcast-fb.js';
import { attachToKid } from './_fb-archive.js';
import { kitConfigured, kitCreateBroadcast } from './_kit.js';

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
const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];

// Per-isolate throttles (cheap; D1 stamps back them up)
let _lastTickAt = 0;
let _lastTickResult = null;
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
    reminders: { enabled: true, hoursBefore: [24, 1], sms: true, push: true },
    replayHours: DEFAULT_REPLAY_HOURS,
    timezone: 'America/New_York',
    alerts: { emails: [] },
    defaults: { title: 'Live room reveal', message: "It's reveal day! We're live right now." },
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
    title: null, message: null, image: null,
    scheduledAt: null, armedAt: null, liveAt: null, endedAt: null, disconnectedAt: null,
    liveVideoUid: null, replayUid: null, replayReadyAt: null, replayUntil: null,
    fb: { liveVideoId: null, permalink: null, outputUid: null, checkedAt: null, needsReview: false },
    kit: { scheduledDraftId: null, replayDraftId: null },
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
export const writeState = (DB, s) => writeJson(DB, STATE_KEY, s);
export const readHealth = (DB) => readJson(DB, HEALTH_KEY, defaultHealth);
export const writeHealth = (DB, h) => writeJson(DB, HEALTH_KEY, h);

// ─── Derived views ──────────────────────────────────────────────────

export function liveUrlFor(state) {
  return state?.kidSlug ? `${SITE_ORIGIN}/live/${state.kidSlug}/` : `${SITE_ORIGIN}/live/`;
}

/** What the public site and the hub see. No secrets. */
export function publicState(state, config) {
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
    source: state.source,
    updatedAt: state.updatedAt,
  };
}

/** The shape the original LiveIndicator + admin Go Live read. */
export function legacyState(state, config) {
  const p = publicState(state, config);
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
    const res = await stub.fetch('https://hub/publish', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: publicState(state, config), reason, event }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function verifyHubNonce(env, nonce) {
  const stub = hubStub(env);
  if (!stub || !nonce) return false;
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
      JSON.stringify({ clicks: s.clicks || 0, note: s.note, kit: s.kit, replayUntil: s.replayUntil }), s.createdAt || nowIso(), nowIso()).run();
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

// ─── Transitions (pure; return a new state) ─────────────────────────

function newBroadcastId() {
  return `live-${Date.now()}`;
}

export function tSchedule(state, { kidSlug, kidName, scheduledAt, title, message, image, by }, config) {
  const s = { ...defaultState(), broadcastId: newBroadcastId(), createdAt: nowIso() };
  s.kidSlug = kidSlug || null;
  s.kidName = kidName || null;
  s.scheduledAt = scheduledAt;
  s.title = title || (kidName ? `${kidName}'s room reveal` : config.defaults.title);
  s.message = message || (kidName ? `Watch ${kidName}'s room reveal live` : config.defaults.message);
  s.image = image || null;
  s.phase = Date.parse(scheduledAt) - Date.now() <= ARM_WINDOW_MS ? 'armed' : 'scheduled';
  if (s.phase === 'armed') s.armedAt = nowIso();
  s.updatedBy = by || null;
  return s;
}

export function tStartLive(state, { videoUid, source = 'stream', by }, config) {
  let s = { ...state };
  const reusable = ['scheduled', 'armed', 'ending'].includes(state.phase) || (state.phase === 'live');
  if (!reusable) {
    // idle or replay: a fresh, unplanned broadcast
    s = { ...defaultState(), broadcastId: newBroadcastId(), createdAt: nowIso() };
    s.title = config.defaults.title;
    s.message = config.defaults.message;
  }
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
  return { ...state, phase: 'live', disconnectedAt: null };
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

async function reminderRecipients(DB, channel, kidSlug) {
  const res = await DB.prepare(
    `SELECT id, address, subscription, last_sent_at, token FROM broadcast_reminders
     WHERE channel = ? AND unsubscribed_at IS NULL AND (kid_slug IS NULL OR kid_slug = ?) AND fails < 5`
  ).bind(channel, kidSlug || '').all();
  return res?.results || [];
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
 * Send one reminder kind across all channels. Idempotent per broadcast.
 * Returns a summary; never throws.
 */
export async function sendReminders(env, config, state, kind, work) {
  const { DB } = env;
  const summary = { kind, email: null, sms: null, push: null };
  if (!config.reminders?.enabled || !state.broadcastId) return summary;
  const common = {
    kind, kidName: state.kidName, scheduledAt: state.scheduledAt, tz: config.timezone,
    liveUrl: liveUrlFor(state),
    replayUrl: state.replayUid ? liveUrlFor(state) : liveUrlFor(state),
    image: state.image ? `${SITE_ORIGIN}/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/${state.image}/w=1200,h=630,fit=cover,q=82` : null,
  };

  // Email
  if (notify.emailConfigured(env) && await claimSend(DB, state.broadcastId, kind, 'email')) {
    const rows = await reminderRecipients(DB, 'email', state.kidSlug);
    // Each recipient gets their own unsubscribe link; Resend takes 100 distinct messages per call
    const items = rows.map(r => { const tpl = notify.reminderEmail({ ...common, unsubscribeUrl: unsubscribeUrl(r.token || r.id) }); return { to: r.address, subject: tpl.subject, html: tpl.html, text: tpl.text }; });
    const res = await notify.sendEmailItems(env, items, { tags: [{ name: 'category', value: `reveal-${kind}` }] });
    const { sent, failed } = res;
    await finishSend(DB, state.broadcastId, kind, 'email', { recipients: rows.length, sent, failed, error: res.errors.slice(0, 3).join('; ') || null });
    summary.email = { recipients: rows.length, sent, failed };
    if (rows.length) work.push(`email:${kind}:${sent}/${rows.length}`);
  }

  // SMS
  if (config.reminders?.sms && notify.smsConfigured(env) && await claimSend(DB, state.broadcastId, kind, 'sms')) {
    const rows = await reminderRecipients(DB, 'sms', state.kidSlug);
    const firstTimers = rows.filter(r => !r.last_sent_at).map(r => r.address);
    const others = rows.filter(r => r.last_sent_at).map(r => r.address);
    let sent = 0, failed = 0; const errors = []; const optedOut = [];
    if (firstTimers.length) { const r = await notify.sendSms(env, { to: firstTimers, body: notify.reminderSms({ ...common, first: true }) }); sent += r.sent; failed += r.failed; errors.push(...r.errors); optedOut.push(...r.optedOut); }
    if (others.length) { const r = await notify.sendSms(env, { to: others, body: notify.reminderSms(common) }); sent += r.sent; failed += r.failed; errors.push(...r.errors); optedOut.push(...r.optedOut); }
    if (rows.length) await DB.prepare(`UPDATE broadcast_reminders SET last_sent_at = ? WHERE channel = 'sms' AND unsubscribed_at IS NULL`).bind(nowIso()).run();
    for (const num of optedOut) await DB.prepare(`UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE channel = 'sms' AND address = ?`).bind(nowIso(), num).run();
    await finishSend(DB, state.broadcastId, kind, 'sms', { recipients: rows.length, sent, failed, error: errors.slice(0, 3).join('; ') || null });
    summary.sms = { recipients: rows.length, sent, failed };
    if (rows.length) work.push(`sms:${kind}:${sent}/${rows.length}`);
  }

  // Push
  if (config.reminders?.push && config.vapid?.privateJwk && await claimSend(DB, state.broadcastId, kind, 'push')) {
    const rows = await reminderRecipients(DB, 'push', state.kidSlug);
    const subs = rows.map(r => { try { return { id: r.id, subscription: JSON.parse(r.subscription) }; } catch { return null; } }).filter(Boolean);
    const payload = notify.reminderPush(common);
    const r = await notify.sendPushBatch(subs, payload, config.vapid, { ttl: kind === 'live' ? 2 * 3600 : 24 * 3600, urgency: kind === 'live' ? 'high' : 'normal', topic: `reveal-${kind}` });
    for (const id of r.gone) await DB.prepare('UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE id = ?').bind(nowIso(), id).run();
    await finishSend(DB, state.broadcastId, kind, 'push', { recipients: subs.length, sent: r.sent, failed: r.failed });
    summary.push = { recipients: subs.length, sent: r.sent, failed: r.failed };
    if (subs.length) work.push(`push:${kind}:${r.sent}/${subs.length}`);
  }
  return summary;
}

async function dueReminderKinds(DB, state, config) {
  if (!state.broadcastId) return [];
  const kinds = [];
  const now = Date.now();
  const at = state.scheduledAt ? Date.parse(state.scheduledAt) : null;
  const hours = Array.isArray(config.reminders?.hoursBefore) ? config.reminders.hoursBefore : [24, 1];
  if ((state.phase === 'scheduled' || state.phase === 'armed') && at) {
    const lead = at - now;
    if (hours.includes(24) && lead <= 24 * 3600e3 && lead > 2 * 3600e3) kinds.push('day');
    if (hours.includes(1) && lead <= 3600e3 && lead > 5 * 60e3) kinds.push('hour');
  }
  if (!kinds.length) return [];
  const res = await DB.prepare('SELECT kind FROM broadcast_sends WHERE broadcast_id = ?').bind(state.broadcastId).all();
  const done = new Set((res?.results || []).map(r => r.kind));
  return kinds.filter(k => !done.has(k));
}

// ─── Kit drafts ─────────────────────────────────────────────────────

async function draftKit(env, state, kind) {
  if (!kitConfigured(env)) return null;
  try {
    const tpl = notify.reminderEmail({ kind, kidName: state.kidName, scheduledAt: state.scheduledAt, liveUrl: liveUrlFor(state), replayUrl: liveUrlFor(state), unsubscribeUrl: '{{ unsubscribe_url }}', image: null });
    const r = await kitCreateBroadcast(env, { subject: tpl.subject, previewText: '', description: `[auto] ${state.kidName || 'Reveal'} ${kind}`, html: tpl.html });
    return r.ok ? (r.broadcast?.id || true) : null;
  } catch {
    return null;
  }
}

// ─── Replay handling ────────────────────────────────────────────────

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
      if (attached) { work.push(`attached:${s.kidSlug}`); if (await triggerDeploy(env, health, `Reveal replay attached to ${s.kidName || s.kidSlug}`)) work.push('deploy'); }
    } catch { /* retry never; admin can attach */ }
  }
  await sendReminders(env, config, s, 'replay', work);
  const draft = await draftKit(env, s, 'replay');
  if (draft) s.kit = { ...(s.kit || {}), replayDraftId: draft };
  await recordEvent(env.DB, s.broadcastId, 'replay_ready', { uid });
  await logAudit(env.DB, { userEmail: 'live-broadcast', action: 'created', entityType: 'stream-video', entitySlug: uid, entityName: `Reveal recording ready: ${s.title || s.broadcastId}`, gitStatus: 'ok' });
  return s;
}

// ─── Facebook side effects ──────────────────────────────────────────

async function fbOnLive(env, config, state, work) {
  const s = { ...state, fb: { ...(state.fb || {}) } };
  if (!fb.fbConfigured(env)) return s;
  if (config.facebook?.mode === 'api' && !s.fb.liveVideoId && !s.fb.needsReview && config.liveInput?.uid) {
    const created = await fb.createFbLiveVideo(env, { title: s.title, description: s.message });
    if (created.ok) {
      s.fb.liveVideoId = created.id;
      const split = fb.splitIngestUrl(created.ingestUrl);
      if (split && stream.streamConfigured(env)) {
        const out = await stream.createOutput(env, config.liveInput.uid, { url: split.url, streamKey: split.streamKey, enabled: true });
        if (out.ok) { s.fb.outputUid = out.result?.uid || null; work.push('fb-api-output'); }
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
  if (!config.liveInput?.uid) problems.push('No live input yet: open Admin → Broadcast → Set up');

  const f = await fb.checkFbToken(env);
  health.facebook = { ok: f.ok, name: f.name || null, error: f.error || null, at: nowIso(), configured: f.configured !== false };
  if (f.configured !== false && !f.ok) problems.push(`Facebook token failed: ${f.error}`);

  const h = await hubStatus(env);
  health.hub = { ok: !!h.ok, clients: h.clients || 0, at: nowIso(), error: h.error || null, lastTick: h.lastTick || null };
  if (!h.ok) problems.push(`Real-time hub unreachable: ${h.error || 'unknown'}`);

  const key = problems.length ? problems.join(' | ') : '';
  const prev = health.flags?.problems || '';
  if (key && key !== prev) {
    await notify.alertAdmins(env, config, { level: 'error', title: soon ? 'Reveal-day check found problems' : 'Live broadcast health check failed', detail: problems.join('\n'), url: `${SITE_ORIGIN}/admin/` });
    work.push('alert:health');
  } else if (!key && prev) {
    await notify.alertAdmins(env, config, { level: 'info', title: 'Live broadcast health recovered', detail: 'All checks pass again.' });
  }
  health.flags = { ...(health.flags || {}), problems: key };
}

// ─── The tick ───────────────────────────────────────────────────────

/**
 * Reconcile with Stream, apply timers, fire side effects, persist, and
 * return the public state. Safe to call from anywhere; throttled per
 * isolate unless `force`.
 */
export async function runTick(env, { source = 'tick', force = false, by = null, minIntervalMs = TICK_MIN_INTERVAL_MS } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const now = Date.now();
  if (!force && _lastTickResult && now - _lastTickAt < Math.max(minIntervalMs, TICK_MIN_INTERVAL_MS)) return { ..._lastTickResult, cached: true };

  const [config, health] = await Promise.all([readConfig(DB), readHealth(DB)]);
  const healthBefore = JSON.stringify(health);
  let state = await readState(DB);
  const before = JSON.stringify(state);
  const prevPhase = state.phase;
  const work = [];

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
    await notify.alertAdmins(env, config, { level: 'warn', title: 'Scheduled reveal never went live', detail: `${state.title || 'Reveal'} was scheduled for ${state.scheduledAt} and no stream arrived. The countdown has been cleared.`, url: `${SITE_ORIGIN}/admin/` });
    await recordEvent(DB, state.broadcastId, 'missed');
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

  // 3. Phase-change side effects
  if (state.phase !== prevPhase) {
    if (state.phase === 'live' && prevPhase !== 'ending') {
      state = await fbOnLive(env, config, state, work);
      await sendReminders(env, config, state, 'live', work);
      await recordEvent(DB, state.broadcastId, 'live_start', { source: state.source, videoUid: state.liveVideoUid });
      await logAudit(DB, { userEmail: by || 'live-broadcast', action: 'published', entityType: 'live-status', entitySlug: state.broadcastId, entityName: state.title || 'Live broadcast', gitStatus: 'ok' });
      await notify.alertAdmins(env, config, { level: 'info', title: `LIVE: ${state.title || 'broadcast started'}`, detail: `Source: ${state.source}. Site, Facebook and YouTube outputs are running.`, url: liveUrlFor(state) });
    }
    if (state.phase === 'replay') {
      state = await fbOnEnd(env, config, state, work);
      const mins = state.liveAt ? Math.round((Date.parse(state.endedAt || nowIso()) - Date.parse(state.liveAt)) / 60000) : null;
      await recordEvent(DB, state.broadcastId, 'live_end', { minutes: mins });
      await logAudit(DB, { userEmail: by || 'live-broadcast', action: 'updated', entityType: 'live-status', entitySlug: state.broadcastId, entityName: `Ended: ${state.title || 'Live broadcast'}`, changes: [{ field: 'minutes', from: null, to: mins }], gitStatus: 'ok' });
      await notify.alertAdmins(env, config, { level: 'info', title: `Ended: ${state.title || 'broadcast'}`, detail: mins != null ? `Ran ${mins} minutes. Replay will attach to the kid's page when Stream finishes processing.` : 'Replay will attach when ready.' });
    }
    if (state.phase === 'ending') await recordEvent(DB, state.broadcastId, 'disconnected');
  }

  // 4. Ongoing work
  if (state.phase === 'live' || state.phase === 'ending') state = await fbRefreshPermalink(env, state, work);
  for (const kind of await dueReminderKinds(DB, state, config)) await sendReminders(env, config, state, kind, work);
  state = await checkReplayReady(env, config, state, health, work);
  await runHealth(env, config, state, health, work);

  // 5. Persist
  const after = JSON.stringify(state);
  if (after !== before) {
    state.updatedAt = nowIso();
    await writeState(DB, state);
    await upsertBroadcastRow(DB, state);
  }
  health.lastTick = { at: nowIso(), source, work };
  // Only touch D1 when something meaningful changed (lastTick alone isn't worth a write every few seconds)
  const healthAfter = JSON.stringify({ ...health, lastTick: null });
  if (healthAfter !== JSON.stringify({ ...JSON.parse(healthBefore), lastTick: null }) || work.length) await writeHealth(DB, health);

  const result = { state: publicState(state, config), reason: work.length ? work.join(',') : source, work, changed: after !== before };
  _lastTickAt = Date.now();
  _lastTickResult = result;
  return result;
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
 * hub on success so open pages update immediately.
 */
export async function adminAction(env, action, body = {}, userEmail = 'unknown') {
  const { DB } = env;
  await ensureSchema(DB);
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
      state = tSchedule(state, { kidSlug: kid?.slug || null, kidName: kid?.name || null, scheduledAt, title: body.title, message: body.message, image, by: userEmail }, config);
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
      if (body.scheduledAt !== undefined && ['scheduled', 'armed'].includes(s.phase)) {
        const at = isoOrNull(body.scheduledAt); if (!at) return fail('scheduledAt is not a valid date');
        s.scheduledAt = at; s.phase = Date.parse(at) - Date.now() <= ARM_WINDOW_MS ? 'armed' : 'scheduled';
      }
      if (body.kidSlug !== undefined && ['scheduled', 'armed'].includes(s.phase)) {
        const kid = await kidByName(DB, body.kidSlug); s.kidSlug = kid?.slug || null; s.kidName = kid?.name || null;
        if (!body.image && kid?.image) s.image = kid.image;
      }
      if (body.url !== undefined && s.source === 'manual') s.manual = { ...(s.manual || {}), url: String(body.url) };
      s.updatedBy = userEmail;
      state = s;
      await writeState(DB, state); await upsertBroadcastRow(DB, state);
      await logAudit(DB, { userEmail, action: 'updated', entityType: 'live-status', entitySlug: state.broadcastId, entityName: state.title, gitStatus: 'ok' });
      break;
    }
    case 'cancel': {
      if (!['scheduled', 'armed'].includes(state.phase)) return fail('Nothing scheduled to cancel');
      await recordEvent(DB, state.broadcastId, 'cancelled');
      await logAudit(DB, { userEmail, action: 'deleted', entityType: 'live-status', entitySlug: state.broadcastId, entityName: `Cancelled: ${state.title}`, gitStatus: 'ok' });
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
      await logAudit(DB, { userEmail, action: 'published', entityType: 'live-status', entitySlug: state.broadcastId, entityName: `Manual banner: ${state.message}`, gitStatus: 'ok' });
      break;
    }
    case 'endNow': {
      if (!['live', 'ending'].includes(state.phase)) return fail('Nothing is live');
      const work = [];
      if (state.source === 'manual') state = tClear(state, 'ended-manually', userEmail);
      else { state = tEnd(state, config, { by: userEmail }); state = await fbOnEnd(env, config, state, work); }
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
  await publishToHub(env, state, config, `admin:${action}`);
  return { success: true, state: publicState(state, config), legacy: legacyState(state, config) };
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
    timezone: config.timezone,
    hub: !!env.LIVE_HUB,
  };
}
