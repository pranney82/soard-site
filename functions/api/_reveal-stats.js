/**
 * Reveal stats
 * ============
 * What each reveal did, for Broadcast → History, so reveals can be compared:
 *
 *  People     each browser on the live page keeps a random id (localStorage
 *             'soard-viewer'; nothing personal), one row per browser per
 *             reveal in broadcast_viewers: whether it came before the reveal,
 *             how many seconds it watched live and of the replay, where it
 *             came from, and the minutes of the reveal it was watching.
 *  Left out   a browser that has opened the admin is staff; automated
 *             browsers and any host but the real site are tests. Both are
 *             kept apart (who = 'staff' | 'test') and never counted; bots are
 *             dropped. A reveal from a JobTread TEST job isn't compared.
 *  Watching   the live page reports seconds actually played with the tab
 *             showing (/api/live-watch): every 20 s live, every 60 s on the
 *             replay. A report can't claim more than the time since that
 *             browser's last one (plus 5 s when they're at least 5 s apart),
 *             and a browser's total never passes the time since its first
 *             report plus 15 s, however many reports it sends. Each
 *             live report marks the minutes of the reveal it covered, so
 *             "there for the reveal" is the people watching in the reveal's
 *             minute (the replay's moment, lined up with the live minutes
 *             even when a reconnect started a new recording).
 *  At once    every 30 s while live, how many were watching on the site (a
 *             live report in the last 50 s), on Facebook (live_views) and on
 *             YouTube (concurrentViewers) goes in broadcast_stats.series, with
 *             the hearts so far (the hub's running totals).
 *  After      Facebook's video insights and YouTube's statistics are read
 *             again on a slowing schedule for 30 days (maybeRefreshRevealStats).
 */

import * as fb from './_broadcast-fb.js';
import * as yt from './_youtube.js';

export const SITE_HOSTS = new Set(['sunshineonaranneyday.com', 'www.sunshineonaranneyday.com']);
export const LIVE_BEAT_SEC = 20;          // the live page reports this often while the reveal plays
export const REPLAY_BEAT_SEC = 60;
export const WATCHING_NOW_MS = 50 * 1000; // a live report this recent counts as watching now
export const SAMPLE_EVERY_MS = 30 * 1000;
const FIRST_BEAT_CAP_SEC = 15;            // a page's first report comes after 10 s; a browser's total never passes its wall time + this
const LATE_LIVE_MS = 2 * 60 * 1000;       // a live report flushed just after the end still counts as live
const SINCE_KEY = 'reveal-stats-since';
const REFRESH_DAYS = 30;

export const SOURCES = ['email', 'facebook', 'instagram', 'youtube', 'qr', 'text', 'push', 'calendar', 'search', 'site', 'other', 'direct'];

let _ready = false;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS broadcast_viewers (
    broadcast_id TEXT NOT NULL, vid TEXT NOT NULL,
    who TEXT, src TEXT,
    first_at TEXT, last_at TEXT,
    before_live INTEGER NOT NULL DEFAULT 0,
    live_sec INTEGER NOT NULL DEFAULT 0, live_first_at INTEGER, live_seen_at INTEGER,
    replay_sec INTEGER NOT NULL DEFAULT 0, replay_first_at INTEGER, replay_seen_at INTEGER,
    live_min TEXT NOT NULL DEFAULT ',',
    PRIMARY KEY (broadcast_id, vid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bviewers_seen ON broadcast_viewers(broadcast_id, live_seen_at)`,
  `CREATE TABLE IF NOT EXISTS broadcast_stats (
    broadcast_id TEXT PRIMARY KEY,
    series TEXT, sampled_at TEXT, reactions TEXT, facebook TEXT, youtube TEXT,
    next_check_at TEXT, updated_at TEXT
  )`,
];

export async function ensureStatsSchema(DB) {
  if (_ready) return;
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  // When counting people began: reveals before it only have page loads
  await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(SINCE_KEY, JSON.stringify({ at: new Date(Date.now()).toISOString() }), new Date(Date.now()).toISOString()).run();
  _ready = true;
}

/** For tests: forget that the schema was made (a fresh database) */
export function resetStatsSchemaFlag() { _ready = false; }

// ─── Who is visiting, and from where ────────────────────────────────

// "bot" as its own word or ending a name before / - ; (Googlebot/2.1, Slackbot-LinkExpanding), never inside a
// phone's model name (CUBOT X30)
const BOT_UA = /\bbot\b|[a-z]bot[/;-]|crawl|spider|slurp|facebookexternalhit|facebookcatalog|embedly|preview|headlesschrome|phantomjs|lighthouse|pagespeed|gtmetrix|python-|curl\/|wget|node-fetch|axios|okhttp|go-http|java\//i;

export const isBot = (ua) => !ua || BOT_UA.test(String(ua));

/** A browser id the live page made: letters and digits only */
export function cleanVid(v) {
  const s = typeof v === 'string' ? v : '';
  return /^[A-Za-z0-9]{8,40}$/.test(s) ? s : null;
}

const SRC_WORDS = {
  email: 'email', mail: 'email', kit: 'email', newsletter: 'email', invite: 'email',
  facebook: 'facebook', fb: 'facebook', messenger: 'facebook',
  instagram: 'instagram', ig: 'instagram',
  youtube: 'youtube', yt: 'youtube',
  qr: 'qr', slate: 'qr', 'slate-next': 'qr', flyer: 'qr',
  text: 'text', sms: 'text',
  push: 'push',
  calendar: 'calendar', ics: 'calendar', cal: 'calendar',
  site: 'site', banner: 'site',
};

// Android apps send android-app://<package>/ as the referrer: the page sees the package name as the host
const APP_REFS = {
  'com.facebook.katana': 'facebook', 'com.facebook.lite': 'facebook', 'com.facebook.orca': 'facebook', 'com.facebook.mlite': 'facebook',
  'com.instagram.android': 'instagram', 'com.google.android.youtube': 'youtube',
  'com.google.android.gm': 'email', 'com.microsoft.office.outlook': 'email', 'com.yahoo.mobile.client.android.mail': 'email', 'com.samsung.android.email.provider': 'email',
  'com.google.android.googlequicksearchbox': 'search', 'com.google.android.calendar': 'calendar', 'com.samsung.android.calendar': 'calendar',
  'com.google.android.apps.messaging': 'text', 'com.samsung.android.messaging': 'text',
};

const REF_HOSTS = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.aol\.com|icloud\.com|kit\.com|convertkit\.com|convertkit-mail\d*\.com|ck\.page)$/, 'email'],
  [/(^|\.)(calendar\.google\.com|calendar\.yahoo\.com)$/, 'calendar'],
  // Google's search itself (www.google.*), not its other apps (Groups, Docs, Drive, Chat, Sites)
  [/^((www\.)?google\.[a-z.]+|(www\.)?bing\.com|duckduckgo\.com|search\.yahoo\.com|(www\.)?yahoo\.com|(www\.)?ecosia\.org|search\.brave\.com|(www\.)?baidu\.com)$/, 'search'],
];

/**
 * Where a visit came from, in the words History uses. A link's own ?src=
 * (or utm_source) wins; then the app it was opened in (Facebook's and
 * Instagram's in-app browsers send no referrer); then the referring site.
 * No clue at all is 'direct': typed, a bookmark, or a link shared in a text.
 */
export function classifySource({ src = '', ref = '', ua = '' } = {}) {
  const word = String(src || '').toLowerCase().trim().slice(0, 24);
  if (word) return SRC_WORDS[word] || 'other';
  const agent = String(ua || '');
  if (/FBAN|FBAV|FB_IAB|FBIOS|\bFB4A\b/.test(agent)) return 'facebook';
  if (/Instagram/.test(agent)) return 'instagram';
  const host = String(ref || '').toLowerCase().replace(/^www\./, '').trim();
  if (!host) return 'direct';
  if (SITE_HOSTS.has(host) || SITE_HOSTS.has(`www.${host}`)) return 'site';
  if (APP_REFS[host]) return APP_REFS[host];
  for (const [re, name] of REF_HOSTS) if (re.test(host)) return name;
  return 'other';
}

/**
 * What a beacon says about who sent it → { vid, who, src } or { drop: true }.
 *   who: null (the public), 'staff' (this browser has opened the admin), or
 *   'test' (an automated browser, or not on the real site)
 */
export function visitor(request, body = {}) {
  const ua = request.headers.get('user-agent') || '';
  if (isBot(ua)) return { drop: true };
  let host = '';
  try { host = new URL(request.url).hostname; } catch { /* keep empty */ }
  const claimed = body.who === 'staff' ? 'staff' : body.who === 'test' ? 'test' : null;
  const who = !SITE_HOSTS.has(host) ? 'test' : claimed;
  return {
    vid: cleanVid(body.vid),
    who,
    src: classifySource({ src: body.src, ref: body.ref, ua }),
  };
}

// ─── Recording ──────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();

/** Someone opened the live page for this reveal (any phase). */
export async function recordVisit(DB, { broadcastId, vid, who = null, src = 'direct', beforeLive = false, now = Date.now() }) {
  if (!broadcastId || !vid) return;
  await DB.prepare(`INSERT INTO broadcast_viewers (broadcast_id, vid, who, src, first_at, last_at, before_live)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
    ON CONFLICT(broadcast_id, vid) DO UPDATE SET last_at = excluded.last_at,
      who = COALESCE(broadcast_viewers.who, excluded.who),
      before_live = MAX(broadcast_viewers.before_live, excluded.before_live),
      src = CASE WHEN broadcast_viewers.src IS NULL OR broadcast_viewers.src = 'direct' THEN excluded.src ELSE broadcast_viewers.src END`)
    .bind(broadcastId, vid, who, src, iso(now), beforeLive ? 1 : 0).run();
}

/**
 * The live page played `sec` seconds since its last report. A live report
 * marks the minutes of the reveal it covered (from `liveAt`, the go-live
 * time). Two limits, so a script gets no more than a person watching the
 * whole time would: a report is worth at most the time since this browser's
 * last one (+5 s for network jitter, only when they're at least 5 s apart,
 * so a burst earns nothing), and the total never passes the time since its first
 * report + 15 s (so silence can't be banked and claimed later in a rush).
 */
export async function recordWatch(DB, { broadcastId, vid, kind, sec, liveAt = null, who = null, src = 'direct', now = Date.now() }) {
  if (!broadcastId || !vid || !['live', 'replay'].includes(kind)) return;
  const s = Math.max(0, Math.min(Math.round(Number(sec) || 0), kind === 'live' ? 90 : 180));
  if (!s) return;
  const col = kind === 'live' ? 'live' : 'replay';
  // The minutes this report covered (whole numbers worked out here, so they go in the SQL as text)
  const minutes = [];
  const t0 = Date.parse(liveAt || '');
  if (kind === 'live' && Number.isFinite(t0) && now >= t0) {
    const last = Math.floor((now - t0) / 60000);
    for (let m = Math.max(0, Math.floor((now - s * 1000 - t0) / 60000)); m <= last && m < 1000; m++) minutes.push(m);
  }
  let marks = 'broadcast_viewers.live_min';
  for (const m of minutes) marks = `CASE WHEN instr(${marks}, ',${m},') > 0 THEN ${marks} ELSE ${marks} || '${m},' END`;
  const fresh = minutes.length ? `',${minutes.join(',')},'` : `','`;
  // Whole seconds (D1 binds numbers as REAL): this report's, within the time since the last one and what's left of the budget
  const since = `((?5 - COALESCE(broadcast_viewers.${col}_seen_at, ?5 - ${FIRST_BEAT_CAP_SEC * 1000})) / 1000.0)`;
  const add = `CAST(MAX(0, MIN(?7,
      ${since} + CASE WHEN ${since} >= 5 THEN 5 ELSE 0 END,
      (?5 - COALESCE(broadcast_viewers.${col}_first_at, ?5)) / 1000.0 + ${FIRST_BEAT_CAP_SEC} - broadcast_viewers.${col}_sec)) AS INTEGER)`;
  await DB.prepare(`INSERT INTO broadcast_viewers (broadcast_id, vid, who, src, first_at, last_at, ${col}_sec, ${col}_first_at, ${col}_seen_at, live_min)
      VALUES (?1, ?2, ?3, ?4, ?6, ?6, CAST(MIN(?7, ${FIRST_BEAT_CAP_SEC}) AS INTEGER), CAST(?5 AS INTEGER), CAST(?5 AS INTEGER), ${fresh})
    ON CONFLICT(broadcast_id, vid) DO UPDATE SET last_at = excluded.last_at,
      who = COALESCE(broadcast_viewers.who, excluded.who),
      src = CASE WHEN broadcast_viewers.src IS NULL OR broadcast_viewers.src = 'direct' THEN excluded.src ELSE broadcast_viewers.src END,
      ${col}_sec = broadcast_viewers.${col}_sec + ${add},
      ${col}_first_at = COALESCE(broadcast_viewers.${col}_first_at, CAST(?5 AS INTEGER)),
      ${col}_seen_at = MAX(COALESCE(broadcast_viewers.${col}_seen_at, 0), CAST(?5 AS INTEGER)),
      live_min = ${marks}`)
    .bind(broadcastId, vid, who, src, now, iso(now), s).run();
}

/**
 * Which kind of watching a report is, from the broadcast's own state (the page
 * might still think it's live a moment after the end) → 'live' | 'replay' | null.
 *   current   the site's broadcast state when it is this broadcast, else null
 *   endedAt   the broadcast's end, for a live report flushed just after it
 */
export function watchKind(claimed, { current = null, endedAt = null, now = Date.now() } = {}) {
  const liveNow = !!current && (current.phase === 'live' || current.phase === 'ending');
  if (claimed === 'live') {
    if (liveNow) return 'live';
    const end = Date.parse(endedAt || current?.endedAt || '');
    return Number.isFinite(end) && now - end <= LATE_LIVE_MS ? 'live' : null;
  }
  if (claimed === 'replay') return liveNow ? null : 'replay';
  return null;
}

// ─── While live: how many at once ───────────────────────────────────

/** People with a live report in the last 50 s (staff and tests left out) */
export async function watchingNow(DB, broadcastId, now = Date.now()) {
  const row = await DB.prepare('SELECT COUNT(*) AS n FROM broadcast_viewers WHERE broadcast_id = ? AND who IS NULL AND live_seen_at >= ?')
    .bind(broadcastId, now - WATCHING_NOW_MS).first();
  return Number(row?.n) || 0;
}

const json = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

/**
 * Save the hub's heart totals for this broadcast. They only ever go up, merged
 * in one statement, so the tick and the heartbeat job saving at once can't
 * put an older total back.
 */
export async function saveReactions(DB, broadcastId, totals) {
  if (!broadcastId || !totals || typeof totals !== 'object') return;
  const clean = {};
  for (const [k, n] of Object.entries(totals)) if (/^[a-z]{1,12}$/.test(k) && Number.isFinite(Number(n))) clean[k] = Math.max(0, Math.round(Number(n)));
  const keys = Object.keys(clean);
  if (!keys.length) {
    // The hub answered with none: no hearts (0), not "never recorded"
    await DB.prepare(`INSERT INTO broadcast_stats (broadcast_id, reactions, updated_at) VALUES (?1, '{}', ?2)
      ON CONFLICT(broadcast_id) DO UPDATE SET reactions = COALESCE(broadcast_stats.reactions, '{}')`).bind(broadcastId, iso(Date.now())).run();
    return;
  }
  let merged = `COALESCE(broadcast_stats.reactions, '{}')`;
  for (const k of keys) merged = `json_set(${merged}, '$.${k}', MAX(COALESCE(json_extract(broadcast_stats.reactions, '$.${k}'), 0), ${clean[k]}))`;
  await DB.prepare(`INSERT INTO broadcast_stats (broadcast_id, reactions, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(broadcast_id) DO UPDATE SET reactions = ${merged}, updated_at = ?3`)
    .bind(broadcastId, JSON.stringify(clean), iso(Date.now())).run();
}

/**
 * The hub's hearts for this broadcast. A hub that answered with none for it
 * means no hearts yet (saved as 0); a hub that didn't answer, or is holding
 * another broadcast's, changes nothing. → whether anything was saved
 */
async function copyHearts(DB, broadcastId, hub) {
  if (!hub || hub.ok === false || hub.error) return false;
  if (hub.reactions && hub.reactions.broadcastId !== broadcastId) return false;
  await saveReactions(DB, broadcastId, hub.reactions?.totals || {});
  return true;
}

/**
 * One point on the "watching at once" line, every 30 s while live. Called by
 * the tick after the feed monitor, which leaves Facebook's and YouTube's
 * latest counts on health.monitor (fbViewers, ytViewers, ytVideoId; with `at`).
 *   opts.hubStatus  () → the hub's status, for the hearts so far
 */
export async function sampleLive(env, state, health, { hubStatus = null } = {}) {
  const DB = env.DB;
  const m = health?.monitor;
  if (!state?.broadcastId || !state.liveAt || !m || m.broadcastId !== state.broadcastId) return false;
  const now = Date.now();
  if (m.sampledAt && now - Date.parse(m.sampledAt) < SAMPLE_EVERY_MS - 1000) return false;
  m.sampledAt = iso(now);
  await ensureStatsSchema(DB);
  const fresh = m.at && now - Date.parse(m.at) < 60 * 1000;
  const site = await watchingNow(DB, state.broadcastId, now);
  const t = Math.max(0, Math.round((now - Date.parse(state.liveAt)) / 1000));
  const point = [t, site, fresh && Number.isFinite(m.fbViewers) ? m.fbViewers : null, fresh && Number.isFinite(m.ytViewers) ? m.ytViewers : null];
  const yt = m.ytVideoId ? JSON.stringify({ videoId: m.ytVideoId }) : null;
  const fbIds = state.fb?.liveVideoId || state.fb?.permalink ? JSON.stringify({ liveVideoId: state.fb?.liveVideoId || null, permalink: state.fb?.permalink || null }) : null;
  await DB.prepare(`INSERT INTO broadcast_stats (broadcast_id, series, sampled_at, youtube, facebook, updated_at) VALUES (?1, json_array(json(?2)), ?5, ?3, ?4, ?5)
    ON CONFLICT(broadcast_id) DO UPDATE SET series = json_insert(COALESCE(broadcast_stats.series, '[]'), '$[#]', json(?2)), sampled_at = ?5,
      youtube = CASE WHEN ?3 IS NULL THEN broadcast_stats.youtube
        WHEN broadcast_stats.youtube IS NULL THEN ?3
        ELSE json_set(broadcast_stats.youtube, '$.videoId', json_extract(?3, '$.videoId')) END,
      facebook = CASE WHEN ?4 IS NULL THEN broadcast_stats.facebook
        WHEN broadcast_stats.facebook IS NULL THEN ?4
        ELSE json_set(broadcast_stats.facebook, '$.liveVideoId', json_extract(?4, '$.liveVideoId'), '$.permalink', json_extract(?4, '$.permalink')) END,
      updated_at = ?5`)
    .bind(state.broadcastId, JSON.stringify(point), yt, fbIds, iso(now)).run();
  if (hubStatus) await copyHearts(DB, state.broadcastId, await Promise.race([hubStatus().catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))]));
  return true;
}

// ─── After the reveal: Facebook's and YouTube's own totals ──────────

/** When to read Facebook and YouTube again: often at first, then daily, then never. */
export function nextCheck(liveAt, now = Date.now()) {
  const age = now - Date.parse(liveAt || '');
  if (!Number.isFinite(age) || age > REFRESH_DAYS * 86400e3) return null;
  const wait = age < 86400e3 ? 15 * 60e3 : age < 7 * 86400e3 ? 2 * 3600e3 : 24 * 3600e3;
  return iso(now + wait);
}

let _lastRefresh = 0;

/**
 * Hub heartbeat job: copies the hearts while a reveal is live or on replay,
 * and reads Facebook's and YouTube's totals for reveals that are due (a
 * couple per run). Never throws.
 *   deps.readState()  the broadcast state;  deps.hubStatus()  the hub's status
 */
export async function maybeRefreshRevealStats(env, { readState, hubStatus, force = false } = {}) {
  const now = Date.now();
  if (!force && now - _lastRefresh < 60 * 1000) return { skipped: true };
  _lastRefresh = now;
  const out = { reactions: false, refreshed: [] };
  try {
    const DB = env.DB;
    await ensureStatsSchema(DB);
    const state = readState ? await readState(DB) : null;
    if (state?.broadcastId && ['live', 'ending', 'replay'].includes(state.phase) && hubStatus) {
      out.reactions = await copyHearts(DB, state.broadcastId, await hubStatus().catch(() => null));
    }
    const since = iso(now - REFRESH_DAYS * 86400e3);
    const due = await DB.prepare(`SELECT b.id, b.live_at, b.ended_at, b.fb_live_video_id, b.fb_permalink, s.facebook, s.youtube, s.next_check_at
        FROM broadcasts b LEFT JOIN broadcast_stats s ON s.broadcast_id = b.id
        WHERE b.live_at IS NOT NULL AND b.live_at >= ?1 AND (b.ended_at IS NOT NULL OR b.phase = 'ended') AND (s.next_check_at IS NULL OR s.next_check_at <= ?2)
        ORDER BY b.live_at DESC LIMIT 2`).bind(since, iso(now)).all();
    for (const row of due.results || []) {
      if (state?.broadcastId === row.id && (state.phase === 'live' || state.phase === 'ending')) continue;
      // Claim it for 5 minutes first, so another isolate on the same heartbeat doesn't read it too
      await DB.prepare('INSERT OR IGNORE INTO broadcast_stats (broadcast_id, updated_at) VALUES (?, ?)').bind(row.id, iso(now)).run();
      const claim = await DB.prepare('UPDATE broadcast_stats SET next_check_at = ?1 WHERE broadcast_id = ?2 AND COALESCE(next_check_at, \'\') = ?3')
        .bind(iso(now + 5 * 60e3), row.id, row.next_check_at || '').run();
      if (!claim?.meta?.changes) continue;
      await refreshPlatforms(env, row, now);
      out.refreshed.push(row.id);
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** Only the numbers that came back: a reply missing one never wipes the last good value */
const numbersOnly = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null && (typeof v !== 'number' || Number.isFinite(v))));

/** Read one finished reveal's Facebook and YouTube totals and save them. */
export async function refreshPlatforms(env, row, now = Date.now()) {
  const DB = env.DB;
  const prevFb = json(row.facebook) || {};
  const prevYt = json(row.youtube) || {};
  let facebook = prevFb;
  if (fb.fbConfigured(env) && (row.fb_live_video_id || row.fb_permalink || prevFb.videoId)) {
    const r = await fb.fbVideoTotals(env, { liveVideoId: row.fb_live_video_id || prevFb.liveVideoId, permalink: row.fb_permalink || prevFb.permalink, videoId: prevFb.videoId }).catch((e) => ({ ok: false, error: e.message }));
    // A failed read keeps the last good numbers and says why
    // checkedAt: the last time Facebook was asked; readAt: when the numbers shown came back (a failed read leaves it)
    // A read that failed outright says nothing about the permission: the last word on it stands
    // checkedAt: last asked; readAt: when what came back came back; viewsReadAt: when the view totals themselves did
    facebook = { ...prevFb, liveVideoId: row.fb_live_video_id || prevFb.liveVideoId || null, permalink: row.fb_permalink || prevFb.permalink || null, ...(r.ok ? numbersOnly(r.totals) : {}), error: r.ok ? (r.partial || null) : r.error, errorKind: r.ok ? (r.partial ? 'partial' : null) : 'failed', missing: r.ok && !r.partial ? null : (r.missing || prevFb.missing || null), checkedAt: iso(now), ...(r.ok ? { readAt: iso(now) } : {}), ...(r.ok && !r.partial ? { viewsReadAt: iso(now) } : {}) };
  }
  let youtube = prevYt;
  if (prevYt.videoId && yt.youtubeConfigured(env)) {
    const r = await yt.videoStats(env, prevYt.videoId).catch((e) => ({ ok: false, error: e.message }));
    youtube = { ...prevYt, ...(r.ok ? numbersOnly({ views: r.views, likes: r.likes, comments: r.comments }) : {}), error: r.ok ? null : r.error, checkedAt: iso(now), ...(r.ok ? { readAt: iso(now) } : {}) };
  }
  await DB.prepare(`INSERT INTO broadcast_stats (broadcast_id, facebook, youtube, next_check_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(broadcast_id) DO UPDATE SET facebook = ?2, youtube = ?3, next_check_at = ?4, updated_at = ?5`)
    .bind(row.id, Object.keys(facebook).length ? JSON.stringify(facebook) : null, Object.keys(youtube).length ? JSON.stringify(youtube) : null,
      nextCheck(row.live_at, now) || '9999-12-31T00:00:00.000Z', iso(now)).run();
}

// ─── For History ────────────────────────────────────────────────────

/** Seconds into the recording where the child first sees the room, when known and trusted. */
export function revealSeconds(row, replayMeta) {
  const reel = row?.data?.reel;
  const trusted = (m) => {
    if (!m || m.seconds == null || !Number.isFinite(Number(m.seconds))) return null;
    if (m.method === 'override' || m.method === 'captions+ai' || (Number(m.confidence) || 0) >= 0.5) return Math.max(0, Math.round(Number(m.seconds)));
    return null;
  };
  if (Number.isFinite(row?.data?.revealAtSeconds)) return Math.max(0, Math.round(row.data.revealAtSeconds));
  if (reel && row.replay_uid && reel.sourceUid === row.replay_uid) {
    if (reel.overrideSeconds != null) return trusted({ seconds: reel.overrideSeconds, method: 'override' });
    const r = trusted({ seconds: reel.momentSeconds, method: reel.method, confidence: reel.confidence });
    if (r != null) return r;
  }
  return trusted(replayMeta?.moment);
}

/**
 * Seconds from going live to the start of the replay's recording. A reconnect
 * longer than Stream's recording timeout starts a new recording, and the
 * replay is the last one, so its reveal moment is that much later in the live.
 */
export function recordingOffset(row) {
  const off = (Date.parse(row?.data?.replayStartedAt || '') - Date.parse(row?.live_at || '')) / 1000;
  return Number.isFinite(off) && off > -600 && off < 8 * 3600 ? Math.round(off) : 0;
}

/** A reveal that is a rehearsal (a JobTread TEST job), not one to compare */
export const isTestReveal = (row) => !!row?.data?.test || /^\s*TEST\b/i.test(row?.title || '');

/** The line through the reveal, its peaks and its average (all places together where known) */
export function summarizeSeries(series) {
  // One point a second at most (two samples in the same second keep the bigger), in time order
  const bySec = new Map();
  for (const p of (Array.isArray(series) ? series : [])) {
    if (!Array.isArray(p) || !Number.isFinite(p[0])) continue;
    const have = bySec.get(p[0]);
    const sum = (q) => (q[1] || 0) + (q[2] || 0) + (q[3] || 0);
    if (!have || sum(p) > sum(have)) bySec.set(p[0], p);
  }
  const pts = [...bySec.values()].sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const peakOf = (i) => { let best = null; for (const p of pts) if (Number.isFinite(p[i]) && (!best || p[i] > best[i])) best = p; return best; };
  const hasFb = pts.some((p) => Number.isFinite(p[2])), hasYt = pts.some((p) => Number.isFinite(p[3]));
  // A missed reading isn't nobody: a place's last reading stands for up to 2 minutes; past that it isn't known
  const filled = fillGaps(pts);
  const isWhole = (q) => Number.isFinite(q[1]) && (!hasFb || Number.isFinite(q[2])) && (!hasYt || Number.isFinite(q[3]));
  const tot = (q) => n(q[1]) + n(q[2]) + n(q[3]);
  // The most at once anyone knows: every place read at that moment added up (one not read then counts nothing,
  // and the note says so), so it's never below what any single place had
  const top = filled.reduce((a, b) => (tot(b) > tot(a) ? b : a));
  const whole = filled.filter(isWhole);
  return {
    peakAll: tot(top), peakAllAt: top[0],
    // Where those people were at that moment: site, Facebook, YouTube (null where not read)
    peakSplit: [top[1] ?? null, hasFb ? top[2] ?? null : null, hasYt ? top[3] ?? null : null],
    peakPartial: !isWhole(top),
    // Every moment, counting the places read then (with the 2-minute carry); avgPartial: some place wasn't, sometimes
    avgAll: Math.round((filled.reduce((a, q) => a + tot(q), 0) / filled.length) * 10) / 10,
    avgPartial: whole.length < filled.length,
    peakSite: peakOf(1)?.[1] ?? null, peakFb: peakOf(2)?.[2] ?? null, peakYt: peakOf(3)?.[3] ?? null,
    hasFb, hasYt,
  };
}

/** The series with each place's last reading carried forward up to 2 minutes over missed readings */
export function fillGaps(pts, carrySec = 120) {
  const last = {};
  return pts.map((p) => {
    const q = [p[0], p[1], p[2], p[3]];
    for (const i of [1, 2, 3]) {
      if (Number.isFinite(p[i])) last[i] = { v: p[i], t: p[0] };
      else if (last[i] && p[0] - last[i].t <= carrySec) q[i] = last[i].v;
    }
    return q;
  });
}

/** Thin a long line to at most `max` points, keeping each stretch's highest total (so a peak is never thinned away) */
export function thinSeries(series, max = 240) {
  const pts = (Array.isArray(series) ? series : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]));
  if (pts.length <= max) return pts;
  const size = Math.ceil(pts.length / max);
  const out = [];
  const tot = (p) => (p[1] || 0) + (p[2] || 0) + (p[3] || 0);
  for (let i = 0; i < pts.length; i += size) {
    const chunk = pts.slice(i, i + size);
    out.push(chunk.reduce((a, b) => (tot(b) > tot(a) ? b : a)));
  }
  return out;
}

/**
 * Every number History shows for these broadcast rows → { since, byId: { id: stats } }.
 * rows: History's broadcasts rows with `data` already parsed.
 */
export async function historyStats(DB, rows) {
  await ensureStatsSchema(DB);
  const ids = rows.map((r) => r.id).filter(Boolean);
  const sinceRow = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(SINCE_KEY).first();
  const since = json(sinceRow?.data)?.at || null;
  if (!ids.length) return { since, byId: {} };
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  const [people, sources, stats, metas] = await Promise.all([
    DB.prepare(`SELECT broadcast_id,
        SUM(CASE WHEN who IS NULL THEN 1 ELSE 0 END) AS people,
        SUM(CASE WHEN who IS NULL AND before_live = 1 THEN 1 ELSE 0 END) AS before_n,
        SUM(CASE WHEN who IS NULL AND live_sec > 0 THEN 1 ELSE 0 END) AS live_n,
        SUM(CASE WHEN who IS NULL THEN live_sec ELSE 0 END) AS live_sec,
        SUM(CASE WHEN who IS NULL AND replay_sec > 0 THEN 1 ELSE 0 END) AS replay_n,
        SUM(CASE WHEN who IS NULL THEN replay_sec ELSE 0 END) AS replay_sec,
        SUM(CASE WHEN who = 'staff' THEN 1 ELSE 0 END) AS staff_n,
        SUM(CASE WHEN who = 'test' THEN 1 ELSE 0 END) AS test_n
      FROM broadcast_viewers WHERE broadcast_id IN (${marks}) GROUP BY broadcast_id`).bind(...ids).all(),
    DB.prepare(`SELECT broadcast_id, COALESCE(src, 'direct') AS src, COUNT(*) AS n FROM broadcast_viewers
      WHERE who IS NULL AND broadcast_id IN (${marks}) GROUP BY broadcast_id, COALESCE(src, 'direct')`).bind(...ids).all(),
    DB.prepare(`SELECT * FROM broadcast_stats WHERE broadcast_id IN (${marks})`).bind(...ids).all(),
    (() => {
      const uids = [...new Set(rows.map((r) => r.replay_uid).filter(Boolean))];
      if (!uids.length) return Promise.resolve({ results: [] });
      return DB.prepare(`SELECT key, data FROM site_config WHERE key IN (${uids.map((_, i) => `?${i + 1}`).join(',')})`).bind(...uids.map((u) => `replay-meta:${u}`)).all();
    })(),
  ]);
  const by = (list, key = 'broadcast_id') => Object.fromEntries((list?.results || []).map((r) => [r[key], r]));
  const peopleBy = by(people);
  const statsBy = by(stats);
  const metaBy = Object.fromEntries((metas?.results || []).map((r) => [r.key.slice('replay-meta:'.length), json(r.data)]));
  const sourcesBy = {};
  for (const r of sources?.results || []) (sourcesBy[r.broadcast_id] ||= {})[r.src] = Number(r.n) || 0;

  // There for the reveal: people watching live in the reveal's minute (one query for every reveal)
  const revealAtBy = {};
  for (const row of rows) {
    const inRecording = row.live_at ? revealSeconds(row, metaBy[row.replay_uid]) : null;
    revealAtBy[row.id] = inRecording == null ? null : Math.max(0, inRecording + recordingOffset(row));
  }
  const asked = rows.filter((row) => revealAtBy[row.id] != null && Number(peopleBy[row.id]?.live_n));
  const atRevealBy = Object.fromEntries(asked.map((row) => [row.id, 0]));
  if (asked.length) {
    // The minutes are whole numbers this code worked out, so they go in the SQL; the ids are bound
    const pairs = asked.map((row, i) => `(?${i + 1}, ${Math.floor(revealAtBy[row.id] / 60)})`).join(', ');
    const hits = await DB.prepare(`WITH r(id, m) AS (VALUES ${pairs})
      SELECT r.id AS id, COUNT(v.vid) AS n FROM r JOIN broadcast_viewers v ON v.broadcast_id = r.id AND v.who IS NULL
        AND instr(v.live_min, ',' || r.m || ',') > 0
      GROUP BY r.id`).bind(...asked.map((row) => row.id)).all();
    for (const h of hits.results || []) atRevealBy[h.id] = Number(h.n) || 0;
  }

  const byId = {};
  for (const row of rows) {
    const p = peopleBy[row.id] || {};
    const s = statsBy[row.id] || {};
    const series = json(s.series) || [];
    const reactions = json(s.reactions) || null;
    const revealAt = revealAtBy[row.id];
    const liveN = Number(p.live_n) || 0;
    const atReveal = row.id in atRevealBy ? atRevealBy[row.id] : null;
    // Counted: went live after counting began, or hasn't gone live yet (its "before" is coming in). One that went live
    // before isn't, however many later look at its replay
    const counted = !!since && (row.live_at ? Date.parse(row.live_at) >= Date.parse(since) : true);
    byId[row.id] = {
      counted,
      partial: counted && !!since && Date.parse(row.created_at || '') < Date.parse(since),
      people: Number(p.people) || 0,
      before: Number(p.before_n) || 0,
      live: liveN,
      avgLiveSec: liveN ? Math.round((Number(p.live_sec) || 0) / liveN) : null,
      replay: Number(p.replay_n) || 0,
      avgReplaySec: Number(p.replay_n) ? Math.round((Number(p.replay_sec) || 0) / Number(p.replay_n)) : null,
      staff: Number(p.staff_n) || 0,
      tests: Number(p.test_n) || 0,
      revealAt,
      atReveal,
      sources: sourcesBy[row.id] || {},
      series: thinSeries(series),
      atOnce: summarizeSeries(series),
      hearts: reactions,
      // The live page has one heart button; anything else a socket sends isn't a heart
      heartsTotal: reactions ? Number(reactions.heart) || 0 : null,
      facebook: json(s.facebook),
      youtube: json(s.youtube),
      test: isTestReveal(row),
    };
  }
  return { since, byId };
}

/**
 * For Site → Automations: when the live page last counted someone, when the
 * "at once" line last got a point, and Facebook's and YouTube's last read
 * (times, and whether Facebook is holding back its view totals). No numbers.
 */
export async function revealStatsFacts(DB) {
  await ensureStatsSchema(DB);
  const since = iso(Date.now() - REFRESH_DAYS * 86400e3);
  const [seen, stats] = await Promise.all([
    DB.prepare('SELECT MAX(last_at) AS at FROM broadcast_viewers WHERE who IS NULL').first(),
    DB.prepare(`SELECT MAX(sampled_at) AS sampled,
        MAX(json_extract(facebook, '$.readAt')) AS fb_at, MAX(json_extract(youtube, '$.readAt')) AS yt_at,
        MAX(CASE WHEN json_extract(facebook, '$.missing') IS NOT NULL AND json_extract(facebook, '$.checkedAt') >= ?1 THEN 1 ELSE 0 END) AS fb_missing
      FROM broadcast_stats`).bind(since).first(),
  ]);
  const totalsAt = [stats?.fb_at, stats?.yt_at].filter(Boolean).sort().pop() || null;
  return { lastSeenAt: seen?.at || null, lastSampleAt: stats?.sampled || null, lastTotalsAt: totalsAt, fbMissing: !!stats?.fb_missing };
}
