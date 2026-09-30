/**
 * Facebook Live → Cloudflare Stream auto-archiver
 * ================================================
 * Facebook deletes live replays 30 days after broadcast. This module
 * preserves them automatically: sweepArchives() checks the page's recent
 * broadcasts and copies any ended, not-yet-archived replay into Stream
 * via its copy-from-URL API (Facebook CDN → Stream, server-to-server).
 *
 * Trigger: piggybacked on public /api/live-status traffic via
 * context.waitUntil — every visitor poll is a chance to run, throttled to
 * one sweep per SWEEP_INTERVAL via a timestamp in D1 (site_config
 * "fb-archive"), so it needs no cron and adds no visitor latency.
 *
 * Which kid page gets the replay (resolveKid). Fully automatic; nobody has
 * to schedule anything. First rule with exactly one answer wins:
 *   1. A planned reveal, if one happens to exist on the Broadcast page for
 *      that time. Optional; never required.
 *   2. A kid named in the post's opening line (Facebook's title), among
 *      this year's and last year's kids who have no reveal replay yet.
 *   3. The same, searching the whole post.
 *   4. A kid named in the opening line, any year, when only one matches.
 * Names match with "&" = "and", in any order ("Nico and Remi" finds
 * "Remi & Nico"), whole words only. Old kids thanked in the post (sponsors,
 * family, past families) never qualify for rules 2 and 3, which is what put
 * the Remi & Nico replay on 2021's Helen before. Two answers in one rule
 * means ambiguous: the replay is still saved and the admins get one alert.
 *
 * Self-correction: automatic placements made by an older version of these
 * rules are re-checked once; if today's rules pick a different kid, the
 * link is moved and the site redeploys. Manual placements are never touched.
 *
 * State record: { checkedAt, archived: { [fbVideoId]: { uid, name, at,
 *   createdAt, lead, attachedTo, via, attachSkipped, needsKid, alertedAt } } }
 *
 * Env vars: FB_PAGE_ID, FB_PAGE_TOKEN, CF_ACCOUNT_ID, CF_STREAM_TOKEN
 */

import { logAudit } from './_audit.js';
import { alertAdmins } from './_broadcast-notify.js';

const FB_GRAPH = 'https://graph.facebook.com/v25.0';
const STATE_KEY = 'fb-archive';
const BROADCAST_CONFIG_KEY = 'broadcast-config';    // alert recipients live here (see _broadcast.js)
const SITE_ORIGIN = 'https://sunshineonaranneyday.com';
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;  // one sweep per 6h is plenty vs a 30-day window
const MIN_AGE_MS = 3 * 60 * 60 * 1000;          // let Facebook finish processing the VOD first
const MAX_PER_SWEEP = 2;                        // bound subrequests per invocation
const DEPLOY_COOLDOWN_MS = 10 * 60 * 1000;      // at most one auto-deploy per 10 min
const HOOK_ENV_VARS = ['CF_PAGES_DEPLOY_HOOK', 'CF_DEPLOY_HOOK', 'DEPLOY_HOOK_URL'];
const LEAD_CHARS = 160;                         // how much of a title-less post counts as its opening
// A Facebook video "belongs" to a planned reveal when it was created inside this window
const BEFORE_SCHEDULED_MS = 3 * 60 * 60 * 1000;
const AFTER_SCHEDULED_MS = 6 * 60 * 60 * 1000;
const BEFORE_LIVE_MS = 60 * 60 * 1000;
const AFTER_ENDED_MS = 3 * 60 * 60 * 1000;

/**
 * Kid pages are static — a change to a kid's record only shows after a
 * rebuild. When the sweep writes a kid record (attach or migration), it
 * fires the same deploy hook the admin's Deploy Now button uses, so the
 * video link appears on the page with zero human involvement. Manual
 * actions pass force to skip the cooldown: a human is waiting.
 */
async function triggerDeploy(env, state, { force = false } = {}) {
  const hook = HOOK_ENV_VARS.map((k) => env[k]).find(Boolean);
  if (!hook) return false;
  const last = state.lastAutoDeployAt ? Date.parse(state.lastAutoDeployAt) : 0;
  if (!force && Date.now() - last < DEPLOY_COOLDOWN_MS) return false;
  try {
    const res = await fetch(hook, { method: 'POST' });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  state.lastAutoDeployAt = new Date().toISOString();
  return true;
}

export function archiveConfigured(env) {
  return !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN && env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN);
}

export async function readArchiveState(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(STATE_KEY).first();
  if (!row) return { checkedAt: null, archived: {} };
  try {
    const s = JSON.parse(row.data);
    return { checkedAt: s.checkedAt || null, archived: s.archived || {}, ...(s.lastAutoDeployAt ? { lastAutoDeployAt: s.lastAutoDeployAt } : {}) };
  } catch {
    return { checkedAt: null, archived: {} };
  }
}

async function writeArchiveState(DB, state) {
  await DB.prepare(
    'INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)'
  ).bind(STATE_KEY, JSON.stringify(state), new Date().toISOString()).run();
}

/**
 * Copy one Facebook video into Stream. Returns { uid, name }; throws with a
 * human-readable message on any failure (caller decides how to surface it).
 */
export async function archiveOne(env, videoId) {
  const qs = new URLSearchParams({
    fields: 'source,description,title,created_time',
    access_token: env.FB_PAGE_TOKEN,
  });
  const fbRes = await fetch(`${FB_GRAPH}/${videoId}?${qs}`);
  const fb = await fbRes.json();
  if (!fbRes.ok || fb.error) throw new Error(fb.error?.message || `Graph API returned ${fbRes.status}`);
  if (!fb.source) {
    throw new Error('Facebook did not provide a download URL for this video — download it from Meta Business Suite (Content → select video → Download) and upload to Stream via the admin instead');
  }

  const title = (fb.title || fb.description || `Facebook live ${videoId}`).replace(/\s+/g, ' ').trim().slice(0, 100);
  const name = fb.created_time ? `${title} (${fb.created_time.slice(0, 10)})` : title;

  const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/copy`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.CF_STREAM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: fb.source, meta: { name } }),
  });
  const cf = await cfRes.json();
  if (!cfRes.ok || !cf.success || !cf.result?.uid) {
    throw new Error(cf.errors?.[0]?.message || `Stream API returned ${cfRes.status}`);
  }

  return { uid: cf.result.uid, name, title: fb.title || null, description: fb.description || null, createdTime: fb.created_time || null };
}

/** Record a completed archive in the dedupe map (used by both auto and manual paths). */
export async function recordArchived(DB, videoId, { uid, name, title, description, createdTime }) {
  const state = await readArchiveState(DB);
  const prev = state.archived[videoId] || {};
  state.archived[videoId] = {
    ...prev, uid, name, at: new Date().toISOString(),
    createdAt: createdTime || prev.createdAt || null,
    lead: postLead({ title, description }) || prev.lead || null,
  };
  await writeArchiveState(DB, state);
  return state.archived[videoId];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fold a kid name or post text into one comparable form: lower case, HTML
 * ampersands decoded, "&" / "+" spelled as "and", curly apostrophes
 * straightened, whitespace collapsed. "Remi & Nico" and "Remi and Nico's"
 * both become "remi and nico...".
 */
export function normalizeNameText(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The part of a Facebook post that names the reveal: the title Facebook
 * derived (its first line), or the opening of the description when there is
 * no title. Thank-yous to sponsors and family come later and are ignored.
 */
export function postLead({ title, description } = {}) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t) return t;
  return String(description || '').replace(/\s+/g, ' ').trim().slice(0, LEAD_CHARS);
}

/** Split a kid record's name into the first names it contains. */
function nameParts(name) {
  return normalizeNameText(name)
    .split(/\s*,\s*|\s+and\s+/)
    .map((x) => x.replace(/\b(jr|sr|ii|iii)\.?$/, '').trim())
    .filter(Boolean);
}

const wordRe = (w) => new RegExp(`(?<![a-z0-9])${escapeRegex(w)}(?![a-z0-9])`);

/**
 * Kids whose name appears in text: the whole name, or every first name in
 * it in any order. When one match's names are a subset of another's
 * ("Nico" vs "Remi & Nico"), the fuller match wins.
 */
export function matchKids(rows, text) {
  const hay = normalizeNameText(text);
  if (!hay) return [];
  const hits = rows.filter((k) => {
    const full = normalizeNameText(k.name);
    if (!full) return false;
    if (wordRe(full).test(hay)) return true;
    const parts = nameParts(k.name);
    return parts.length > 1 && parts.every((p) => wordRe(p).test(hay));
  });
  return hits.filter((k) => {
    const mine = nameParts(k.name);
    return !hits.some((o) => o !== k && nameParts(o.name).length > mine.length && mine.every((p) => nameParts(o.name).includes(p)));
  });
}

async function kidRows(DB) {
  const res = await DB.prepare('SELECT slug, name, year, data FROM kids').all();
  return ((res && res.results) || []).map((r) => {
    let reveal = null;
    try { reveal = JSON.parse(r.data || '{}').revealVideoUrl || null; } catch { /* ignore */ }
    return { slug: r.slug, name: r.name, year: Number(r.year) || null, reveal };
  });
}

/**
 * Whole-table name match, any year. Only returns a kid when EXACTLY ONE
 * matches — two kids named Adrian mean the year rules have to decide.
 */
export async function findKidByName(DB, text) {
  const m = matchKids(await kidRows(DB), text);
  return m.length === 1 ? { slug: m[0].slug, name: m[0].name } : null;
}

/**
 * The deterministic path: a reveal scheduled (or run) from the Broadcast
 * page names its kid up front. A Facebook video created inside that
 * reveal's window belongs to that kid, whatever the post text says.
 * Returns null when no planned reveal fits or two different kids' do.
 */
export async function findKidByBroadcast(DB, createdTime) {
  const t = Date.parse(createdTime || '');
  if (!Number.isFinite(t)) return null;
  let rows = [];
  try {
    const res = await DB.prepare(
      `SELECT kid_slug, kid_name, scheduled_at, live_at, ended_at FROM broadcasts
       WHERE kid_slug IS NOT NULL AND kid_slug != '' ORDER BY created_at DESC LIMIT 50`
    ).all();
    rows = (res && res.results) || [];
  } catch {
    return null; // broadcasts table not created yet (no reveal ever scheduled)
  }
  const hits = rows.filter((r) => {
    const sched = Date.parse(r.scheduled_at || '');
    const live = Date.parse(r.live_at || '');
    const ended = Date.parse(r.ended_at || '');
    const inScheduled = Number.isFinite(sched) && t >= sched - BEFORE_SCHEDULED_MS && t <= sched + AFTER_SCHEDULED_MS;
    const inLive = Number.isFinite(live) && t >= live - BEFORE_LIVE_MS && t <= (Number.isFinite(ended) ? ended : live) + AFTER_ENDED_MS;
    return inScheduled || inLive;
  });
  const slugs = [...new Set(hits.map((r) => r.kid_slug))];
  if (slugs.length !== 1) return null;
  return { slug: slugs[0], name: hits[0].kid_name || null };
}

/**
 * Decide which kid page a Facebook replay belongs to (rules in the header).
 * `uid` lets a kid whose link already points at this very video count as
 * still open, so re-checks are stable. `via` records which rule answered.
 */
export async function resolveKid(DB, { title, description, createdTime, uid = null } = {}) {
  const planned = await findKidByBroadcast(DB, createdTime);
  if (planned) return { ...planned, via: 'broadcast' };

  const rows = await kidRows(DB);
  const t = Date.parse(createdTime || '');
  const videoYear = new Date(Number.isFinite(t) ? t : Date.now()).getUTCFullYear();
  const open = rows.filter((k) => k.year && k.year >= videoYear - 1
    && (!k.reveal || (uid && uidFromUrl(k.reveal) === uid)));
  const lead = postLead({ title, description });
  const full = `${title || ''} ${description || ''}`;
  const tiers = [
    ['name', open, lead],
    ['post', open, full],
    ['name-any-year', rows, lead],
  ];
  for (const [via, pool, text] of tiers) {
    const m = matchKids(pool, text);
    if (m.length === 1) return { slug: m[0].slug, name: m[0].name, via };
    if (m.length > 1) return null; // ambiguous: a human has to look
  }
  return null;
}

export function watchUrl(uid) {
  return `https://watch.cloudflarestream.com/${uid}`;
}

function uidFromUrl(url) {
  return String(url || '').split('/').filter(Boolean).pop() || null;
}

/**
 * Write a "Watch the live reveal" link onto a kid's record — shown as a
 * hero link on their page after the next deploy (per Peter: a link, not an
 * embedded player; the streamVideoId player stays reserved for produced
 * videos). Points at the permanent Stream watch page, never the Facebook
 * URL, which dies after 30 days. The automatic paths never overwrite an
 * existing link; a human (force) may. D1 only — D1 is the source of truth
 * for builds; GitHub re-syncs on the kid's next admin save.
 * Returns the slug on success, null if skipped.
 */
export async function attachToKid(env, slug, uid, videoName, by = 'auto-archive', { force = false } = {}) {
  const { DB } = env;
  const row = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  const data = JSON.parse(row.data);
  const next = watchUrl(uid);
  if (data.revealVideoUrl === next) return slug;     // already there — nothing to do
  if (data.revealVideoUrl && !force) return null;    // an existing reveal link is never replaced automatically
  const from = data.revealVideoUrl || null;
  data.revealVideoUrl = next;
  await DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ?')
    .bind(JSON.stringify(data), new Date().toISOString(), slug).run();
  await logAudit(DB, {
    userEmail: by,
    action: 'updated',
    entityType: 'kid',
    entitySlug: slug,
    entityName: data.name || slug,
    changes: [{ field: 'revealVideoUrl', from, to: data.revealVideoUrl }],
    gitStatus: 'ok',
  });
  return slug;
}

/**
 * Take a reveal link off a kid's record, but only if it still points at
 * this video — a link a human replaced with something else is left alone.
 */
export async function detachFromKid(env, slug, uid, by = 'admin') {
  const { DB } = env;
  const row = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
  if (!row) return false;
  const data = JSON.parse(row.data);
  if (!data.revealVideoUrl || uidFromUrl(data.revealVideoUrl) !== uid) return false;
  const from = data.revealVideoUrl;
  delete data.revealVideoUrl;
  await DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ?')
    .bind(JSON.stringify(data), new Date().toISOString(), slug).run();
  await logAudit(DB, {
    userEmail: by,
    action: 'updated',
    entityType: 'kid',
    entitySlug: slug,
    entityName: data.name || slug,
    changes: [{ field: 'revealVideoUrl', from, to: null }],
    gitStatus: 'ok',
  });
  return true;
}

/**
 * Manual override from the admin's Facebook list: put an archived replay on
 * a kid's page (moving it off whoever had it), or take it off every page
 * (kidSlug null). Marks the entry so the automatic paths leave it alone
 * from then on, and deploys right away. Throws with a readable message.
 */
export async function assignArchivedVideo(env, { videoId, kidSlug, by = 'admin' }) {
  const { DB } = env;
  const state = await readArchiveState(DB);
  const entry = state.archived[String(videoId)];
  if (!entry || !entry.uid) throw new Error('That broadcast has not been saved to Stream yet — use Save to Stream first');

  let target = null;
  if (kidSlug) {
    target = await DB.prepare('SELECT slug, name FROM kids WHERE slug = ?').bind(kidSlug).first();
    if (!target) throw new Error(`No kid record with the slug "${kidSlug}"`);
  }

  if (entry.attachedTo && entry.attachedTo !== (target?.slug || null)) {
    await detachFromKid(env, entry.attachedTo, entry.uid, by);
  }
  if (target) {
    await attachToKid(env, target.slug, entry.uid, entry.name, by, { force: true });
    entry.attachedTo = target.slug;
  } else {
    entry.attachedTo = null;
  }
  entry.via = 'manual';
  entry.attachSkipped = !target;   // "keep it off every page" until a human says otherwise
  delete entry.needsKid;

  const deployed = await triggerDeploy(env, state, { force: true });
  await writeArchiveState(DB, state);
  return { uid: entry.uid, kidSlug: target?.slug || null, kidName: target?.name || null, deployed };
}

/**
 * Decorate a list of Facebook videos ({ id, ... }) with what the archive
 * knows: Stream uid, which kid page it is on, and whether it still needs a
 * human to pick one. Used by the admin's Facebook lists.
 */
export async function annotateArchived(DB, videos) {
  let archived = {};
  try { archived = (await readArchiveState(DB)).archived; } catch { /* annotation only */ }
  const slugs = [...new Set(Object.values(archived).map((e) => e.attachedTo).filter(Boolean))];
  const names = {};
  for (const slug of slugs) {
    try {
      const row = await DB.prepare('SELECT name FROM kids WHERE slug = ?').bind(slug).first();
      if (row) names[slug] = row.name;
    } catch { /* leave unnamed */ }
  }
  return (videos || []).map((v) => {
    const e = v.id ? archived[v.id] : null;
    if (!e) return { ...v, streamUid: null, attachedTo: null, attachedName: null, needsKid: false };
    return {
      ...v,
      streamUid: e.uid || null,
      watch: e.uid ? watchUrl(e.uid) : null,
      attachedTo: e.attachedTo || null,
      attachedName: e.attachedTo ? (names[e.attachedTo] || e.attachedTo) : null,
      attachedVia: e.via || null,
      needsKid: !!e.uid && !e.attachedTo && !e.attachSkipped,
    };
  });
}

/**
 * One alert per replay that could not be placed. Best effort; the
 * Broadcast page shows the same thing with a picker next to the video.
 */
async function alertNeedsKid(env, entry, reason) {
  if (entry.alertedAt) return;
  entry.alertedAt = new Date().toISOString();
  try {
    const row = await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(BROADCAST_CONFIG_KEY).first();
    const config = row ? JSON.parse(row.data) : {};
    const detail = reason === 'has-link'
      ? `The replay is safe in Cloudflare Stream, but ${entry.matchedName || 'that kid'}'s page already has a reveal link, so it was not replaced. Open Admin → Broadcast → History and pick the kid next to the video to swap it.`
      : 'The replay is safe in Cloudflare Stream, but the post did not name exactly one of this year’s kids. Open Admin → Broadcast → History and pick the kid next to the video.';
    await alertAdmins(env, config, { level: 'warn', title: `Reveal replay saved but not on a kid page: ${entry.name}`, detail, url: `${SITE_ORIGIN}/admin/` });
  } catch { /* alerts never break the sweep */ }
}

/**
 * Attach one archived entry to whichever kid resolveKid picks. Mutates the
 * entry; returns true when a kid record was written.
 */
async function placeEntry(env, entry, video, stats) {
  const kid = await resolveKid(env.DB, { ...video, uid: entry.uid });
  if (!kid) {
    entry.needsKid = true;
    await alertNeedsKid(env, entry, 'no-match');
    return false;
  }
  const ok = await attachToKid(env, kid.slug, entry.uid, entry.name, 'auto-archive');
  if (ok) {
    entry.attachedTo = kid.slug;
    entry.via = kid.via;
    delete entry.needsKid;
    if (stats) stats.kidWrites++;
    return true;
  }
  entry.attachSkipped = true;   // kid already has a different reveal link — a human decides
  entry.matchedName = kid.name || kid.slug;
  await alertNeedsKid(env, entry, 'has-link');
  return false;
}

/**
 * One-time migration: early auto-attaches wrote streamVideoId (embedded
 * player) before Peter asked for a link instead. Move those to
 * revealVideoUrl. No-ops once every entry is migrated.
 */
async function migrateEmbedsToLinks(env, state, stats) {
  let changed = false;
  for (const entry of Object.values(state.archived)) {
    if (!entry.attachedTo || entry.migrated) continue;
    try {
      const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(entry.attachedTo).first();
      if (row) {
        const data = JSON.parse(row.data);
        if (data.streamVideoId === entry.uid) {
          delete data.streamVideoId;
          data.revealVideoUrl = watchUrl(entry.uid);
          await env.DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ?')
            .bind(JSON.stringify(data), new Date().toISOString(), entry.attachedTo).run();
          if (stats) stats.kidWrites++;
        }
      }
      entry.migrated = true;
      changed = true;
    } catch { /* retry next sweep */ }
  }
  return changed;
}

/** Rebuild what the matcher needs from an archive entry (older entries only kept `name`). */
function entryVideo(entry) {
  const m = String(entry.name || '').match(/^(.*) \((\d{4}-\d{2}-\d{2})\)$/);
  return {
    title: entry.lead || (m ? m[1] : entry.name) || '',
    createdTime: entry.createdAt || (m ? `${m[2]}T12:00:00Z` : null),
    uid: entry.uid,
  };
}

/**
 * Re-check automatic placements made before the current rules (no `via`
 * recorded) once. If today's rules confidently pick another kid, move the
 * link there. Manual placements and anything already re-checked are left
 * alone. Mutates entries; returns true if anything changed.
 */
async function reverifyAuto(env, state, stats) {
  let changed = false;
  for (const entry of Object.values(state.archived)) {
    if (!entry.uid || !entry.attachedTo || entry.via || entry.verified) continue;
    try {
      const kid = await resolveKid(env.DB, entryVideo(entry));
      entry.verified = true;
      changed = true;
      if (!kid || kid.slug === entry.attachedTo) { if (kid) entry.via = kid.via; continue; }
      const placed = await attachToKid(env, kid.slug, entry.uid, entry.name, 'auto-archive');
      if (!placed) continue; // right kid already has a different replay: leave both as they are
      await detachFromKid(env, entry.attachedTo, entry.uid, 'auto-archive');
      entry.correctedFrom = entry.attachedTo;
      entry.attachedTo = kid.slug;
      entry.via = kid.via;
      if (stats) stats.kidWrites += 2;
    } catch { /* retry next sweep */ }
  }
  return changed;
}

/**
 * Try to attach archived-but-unattached videos to kids. D1-only (no Facebook
 * calls), so it runs on every sweep attempt — this is what picks up a kid
 * whose record was created, or whose reveal was scheduled, AFTER their
 * broadcast was archived. Mutates state entries; returns true if anything
 * changed.
 */
async function retroAttach(env, state, stats) {
  const pending = Object.entries(state.archived).filter(([, e]) => e.uid && !e.attachedTo && !e.attachSkipped);
  if (!pending.length) return false;
  let changed = false;
  for (const [, entry] of pending.slice(0, 3)) {
    try {
      const before = JSON.stringify(entry);
      await placeEntry(env, entry, entryVideo(entry), stats);
      if (JSON.stringify(entry) !== before) changed = true;
    } catch { /* retry next sweep */ }
  }
  return changed;
}

/**
 * The auto sweep. Safe to call on every request — exits instantly unless the
 * sweep interval has elapsed. Never throws; returns a diagnostic summary
 * (surfaced by /api/live-status?sweep=1 so archive health is observable).
 */
export async function sweepArchives(env) {
  const summary = { configured: false, migrated: 0, corrected: 0, attached: 0, archived: 0, needsKid: 0, fbChecked: false, autoDeployed: false, error: null };
  try {
    const { DB } = env;
    if (!archiveConfigured(env)) return summary;
    summary.configured = true;

    const state = await readArchiveState(DB);
    const stats = { kidWrites: 0 }; // kid-record changes → pages are stale → auto-deploy

    // Retro-attach + embed→link migration run on every attempt (cheap, no Facebook quota)
    let dirty = false;
    if (await migrateEmbedsToLinks(env, state, stats)) { dirty = true; summary.migrated++; }
    if (await reverifyAuto(env, state, stats)) { dirty = true; summary.corrected++; }
    if (await retroAttach(env, state, stats)) { dirty = true; summary.attached++; }

    const due = !state.checkedAt || Date.now() - Date.parse(state.checkedAt) >= SWEEP_INTERVAL_MS;
    if (!due) {
      if (stats.kidWrites > 0 && await triggerDeploy(env, state)) { summary.autoDeployed = true; dirty = true; }
      if (dirty) await writeArchiveState(DB, state);
      summary.needsKid = Object.values(state.archived).filter((e) => e.needsKid).length;
      return summary;
    }
    if (dirty) await writeArchiveState(DB, state);
    summary.fbChecked = true;

    // Stamp before the slow work so concurrent requests don't double-sweep
    state.checkedAt = new Date().toISOString();
    await writeArchiveState(DB, state);

    const qs = new URLSearchParams({
      fields: 'live_status,title,description,created_time',
      limit: '10',
      access_token: env.FB_PAGE_TOKEN,
    });
    const res = await fetch(`${FB_GRAPH}/${env.FB_PAGE_ID}/videos?${qs}`);
    if (!res.ok) { summary.error = `Graph API returned ${res.status}`; return summary; }
    const data = await res.json();

    const candidates = (data.data || [])
      .filter(v => v.live_status === 'VOD'
        && v.id && !state.archived[v.id]
        && v.created_time && Date.now() - Date.parse(v.created_time) > MIN_AGE_MS)
      .slice(0, MAX_PER_SWEEP);

    for (const v of candidates) {
      try {
        summary.archived++;
        const done = await archiveOne(env, v.id);
        const entry = {
          uid: done.uid, name: done.name, at: new Date().toISOString(),
          createdAt: v.created_time || null,
          lead: postLead({ title: v.title, description: v.description }) || null,
        };
        // Put it on the kid's page right away when the answer is unambiguous
        try {
          await placeEntry(env, entry, { title: v.title, description: v.description, createdTime: v.created_time }, stats);
        } catch { /* retroAttach retries on later sweeps */ }
        state.archived[v.id] = entry;
        await logAudit(DB, {
          userEmail: 'auto-archive',
          action: 'created',
          entityType: 'stream-video',
          entitySlug: done.uid,
          entityName: `Auto-archived FB live: ${done.name}`,
          changes: [{ field: 'source', from: null, to: `facebook video ${v.id}` }],
          gitStatus: 'ok',
        });
      } catch {
        // e.g. source not ready yet — next sweep retries automatically
      }
    }
    if (stats.kidWrites > 0 && await triggerDeploy(env, state)) summary.autoDeployed = true;
    if (candidates.length || summary.autoDeployed) await writeArchiveState(DB, state);
    summary.needsKid = Object.values(state.archived).filter((e) => e.needsKid).length;
  } catch (err) {
    // sweep must never break the caller — but the error is observable via ?sweep=1
    summary.error = err.message || String(err);
  }
  return summary;
}
