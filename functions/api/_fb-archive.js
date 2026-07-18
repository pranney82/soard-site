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
 * State record: { checkedAt, archived: { [fbVideoId]: { uid, name, at } } }
 *
 * Env vars: FB_PAGE_ID, FB_PAGE_TOKEN, CF_ACCOUNT_ID, CF_STREAM_TOKEN
 */

import { logAudit } from './_audit.js';

const FB_GRAPH = 'https://graph.facebook.com/v25.0';
const STATE_KEY = 'fb-archive';
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;  // one sweep per 6h is plenty vs a 30-day window
const MIN_AGE_MS = 3 * 60 * 60 * 1000;          // let Facebook finish processing the VOD first
const MAX_PER_SWEEP = 2;                        // bound subrequests per invocation

export function archiveConfigured(env) {
  return !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN && env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN);
}

export async function readArchiveState(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(STATE_KEY).first();
  if (!row) return { checkedAt: null, archived: {} };
  try {
    const s = JSON.parse(row.data);
    return { checkedAt: s.checkedAt || null, archived: s.archived || {} };
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

  return { uid: cf.result.uid, name };
}

/** Record a completed archive in the dedupe map (used by both auto and manual paths). */
export async function recordArchived(DB, videoId, { uid, name }) {
  const state = await readArchiveState(DB);
  state.archived[videoId] = { uid, name, at: new Date().toISOString() };
  await writeArchiveState(DB, state);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the kid a broadcast belongs to by name match against the kids table.
 * Only returns a kid when EXACTLY ONE name matches — two kids named Adrian,
 * or no match at all, mean human judgment is needed (admin picker).
 */
async function findKidByName(DB, text) {
  if (!text) return null;
  const res = await DB.prepare('SELECT slug, name FROM kids').all();
  const rows = (res && res.results) || [];
  const matches = rows.filter(k => k.name && new RegExp(`\\b${escapeRegex(k.name)}\\b`, 'i').test(text));
  return matches.length === 1 ? matches[0] : null;
}

export function watchUrl(uid) {
  return `https://watch.cloudflarestream.com/${uid}`;
}

/**
 * Write a "Watch the live reveal" link onto a kid's record — shown as a
 * hero link on their page after the next deploy (per Peter: a link, not an
 * embedded player; the streamVideoId player stays reserved for produced
 * videos). Points at the permanent Stream watch page, never the Facebook
 * URL, which dies after 30 days. Never overwrites an existing link.
 * D1 only — D1 is the source of truth for builds; GitHub re-syncs on the
 * kid's next admin save. Returns the slug on success, null if skipped.
 */
export async function attachToKid(env, slug, uid, videoName, by = 'auto-archive') {
  const { DB } = env;
  const row = await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  const data = JSON.parse(row.data);
  if (data.revealVideoUrl) return null; // an existing reveal link is never replaced automatically
  data.revealVideoUrl = watchUrl(uid);
  await DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ?')
    .bind(JSON.stringify(data), new Date().toISOString(), slug).run();
  await logAudit(DB, {
    userEmail: by,
    action: 'updated',
    entityType: 'kid',
    entitySlug: slug,
    entityName: data.name || slug,
    changes: [{ field: 'revealVideoUrl', from: null, to: data.revealVideoUrl }],
    gitStatus: 'ok',
  });
  return slug;
}

/**
 * One-time migration: early auto-attaches wrote streamVideoId (embedded
 * player) before Peter asked for a link instead. Move those to
 * revealVideoUrl. No-ops once every entry is migrated.
 */
async function migrateEmbedsToLinks(env, state) {
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
        }
      }
      entry.migrated = true;
      changed = true;
    } catch { /* retry next sweep */ }
  }
  return changed;
}

/**
 * Try to attach archived-but-unattached videos to kids. D1-only (no Facebook
 * calls), so it runs on every sweep attempt — this is what picks up a kid
 * whose record was created AFTER their broadcast was archived.
 * Mutates state entries; returns true if anything changed.
 */
async function retroAttach(env, state) {
  const pending = Object.entries(state.archived).filter(([, e]) => !e.attachedTo && !e.attachSkipped);
  if (!pending.length) return false;
  let changed = false;
  for (const [, entry] of pending.slice(0, 3)) {
    try {
      const kid = await findKidByName(env.DB, entry.name || '');
      if (!kid) continue; // no record yet (or ambiguous) — retry next sweep
      const ok = await attachToKid(env, kid.slug, entry.uid, entry.name);
      if (ok) entry.attachedTo = kid.slug;
      else entry.attachSkipped = true; // kid already has a video — stop retrying
      changed = true;
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
  const summary = { configured: false, migrated: 0, attached: 0, archived: 0, fbChecked: false, error: null };
  try {
    const { DB } = env;
    if (!archiveConfigured(env)) return summary;
    summary.configured = true;

    const state = await readArchiveState(DB);

    // Retro-attach + embed→link migration run on every attempt (cheap, no Facebook quota)
    let dirty = false;
    if (await migrateEmbedsToLinks(env, state)) { dirty = true; summary.migrated++; }
    if (await retroAttach(env, state)) { dirty = true; summary.attached++; }
    if (dirty) await writeArchiveState(DB, state);

    if (state.checkedAt && Date.now() - Date.parse(state.checkedAt) < SWEEP_INTERVAL_MS) return summary;
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
    if (!res.ok) return;
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
        const entry = { uid: done.uid, name: done.name, at: new Date().toISOString() };
        // Attach to the kid's page immediately when the name match is unambiguous
        try {
          const kid = await findKidByName(DB, `${v.title || ''} ${v.description || ''}`);
          if (kid) {
            const ok = await attachToKid(env, kid.slug, done.uid, done.name);
            if (ok) entry.attachedTo = kid.slug; else entry.attachSkipped = true;
          }
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
    if (candidates.length) await writeArchiveState(DB, state);
  } catch (err) {
    // sweep must never break the caller — but the error is observable via ?sweep=1
    summary.error = err.message || String(err);
  }
  return summary;
}
