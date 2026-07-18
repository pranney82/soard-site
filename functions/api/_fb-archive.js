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

/**
 * The auto sweep. Safe to call on every request — exits instantly unless the
 * sweep interval has elapsed. Never throws.
 */
export async function sweepArchives(env) {
  try {
    const { DB } = env;
    if (!archiveConfigured(env)) return;

    const state = await readArchiveState(DB);
    if (state.checkedAt && Date.now() - Date.parse(state.checkedAt) < SWEEP_INTERVAL_MS) return;

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
        const done = await archiveOne(env, v.id);
        state.archived[v.id] = { uid: done.uid, name: done.name, at: new Date().toISOString() };
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
  } catch {
    // sweep must never break the caller
  }
}
