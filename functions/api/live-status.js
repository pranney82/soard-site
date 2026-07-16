/**
 * /api/live-status — Facebook Live broadcast indicator
 * =====================================================
 * Powers the "We're live" pill on the public site. Status lives in D1
 * (site_config, key "live-status") so going live is instant — no build,
 * no deploy.
 *
 * GET  (public) — returns the computed state:
 *   {
 *     live: bool,        // broadcast happening right now
 *     upcoming: bool,    // scheduled and not started yet
 *     message: string,   // e.g. "Watch Adrian's room reveal"
 *     url: string,       // where the pill links (Facebook page)
 *     startsAt: ISO | null,
 *     endsAt: ISO | null,
 *     id: string         // unique per broadcast — clients key dismissals on it
 *   }
 *
 * POST (Cloudflare Access auth via middleware) — sets the status:
 *   { action: "start", message?, url?, startsAt?, durationHours? }
 *     startsAt omitted/past  → live immediately
 *     startsAt in the future → "upcoming" until then, live after
 *     durationHours (default 4, max 12) → auto-expires so a forgotten
 *     toggle can never leave a stale LIVE pill on the site
 *   { action: "update", message?, url? } — change the banner while it's up,
 *     e.g. swap the Facebook page link for the live video's permalink once
 *     the stream starts. Keeps the broadcast window and id (so visitors who
 *     dismissed it stay dismissed).
 *   { action: "stop" } — end the broadcast now
 *
 * Auto video-link detection (optional):
 *   When FB_PAGE_ID + FB_PAGE_TOKEN env vars are set, a live banner whose
 *   link is still the plain Facebook page URL is upgraded to the running
 *   broadcast's permalink automatically — the Graph API is polled at most
 *   once a minute (shared across all visitors via a timestamp in D1).
 *   A manually pasted link (anything that isn't a bare facebook.com page
 *   URL) is never overwritten. Without the env vars this is inert.
 *
 * Env bindings: DB (D1)
 * Env vars (optional): FB_PAGE_ID, FB_PAGE_TOKEN
 */

import { logAudit } from './_audit.js';

const CONFIG_KEY = 'live-status';
const DEFAULT_URL = 'https://www.facebook.com/SunshineOnaRanneyDay';
const DEFAULT_MESSAGE = "It's reveal day! We're live on Facebook right now.";
const DEFAULT_DURATION_HOURS = 6;
const MAX_DURATION_HOURS = 12;

const OFF_STATE = { live: false, upcoming: false, message: '', url: DEFAULT_URL, startsAt: null, endsAt: null, id: null };

const FB_GRAPH = 'https://graph.facebook.com/v25.0';
const FB_CHECK_INTERVAL_MS = 55 * 1000; // just under the site's 60s poll

async function writeStatus(DB, record, nowIso) {
  await DB.prepare(
    'INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)'
  ).bind(CONFIG_KEY, JSON.stringify(record), nowIso).run();
}

/** Is this a bare Facebook page link (safe to auto-upgrade), vs. something the admin chose deliberately? */
function isPlainPageUrl(url) {
  return /facebook\.com/i.test(url || '') && !/\/videos\//.test(url || '');
}

/**
 * If a broadcast is live and the banner still links to the plain page,
 * ask the Graph API for the running video's permalink and store it.
 * Throttled via fbCheckedAt in the record; never throws.
 */
async function maybeUpgradeToVideoUrl(env, stored, state, nowMs) {
  const { DB, FB_PAGE_ID, FB_PAGE_TOKEN } = env;
  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) return state;
  if (!state.live || !isPlainPageUrl(state.url)) return state;

  const lastCheck = stored.fbCheckedAt ? Date.parse(stored.fbCheckedAt) : 0;
  if (nowMs - lastCheck < FB_CHECK_INTERVAL_MS) return state;

  const nowIso = new Date(nowMs).toISOString();
  // Stamp the check time first so concurrent visitors don't stampede the Graph API
  const stamped = { ...stored, fbCheckedAt: nowIso };
  await writeStatus(DB, stamped, nowIso);

  try {
    const qs = new URLSearchParams({
      fields: 'status,permalink_url',
      broadcast_status: '["LIVE"]',
      limit: '1',
      access_token: FB_PAGE_TOKEN,
    });
    const res = await fetch(`${FB_GRAPH}/${FB_PAGE_ID}/live_videos?${qs}`);
    if (!res.ok) return state;
    const data = await res.json();
    const vid = (data.data || []).find(v => v.status === 'LIVE' && v.permalink_url);
    if (!vid) return state;

    const videoUrl = vid.permalink_url.startsWith('http')
      ? vid.permalink_url
      : `https://www.facebook.com${vid.permalink_url}`;
    await writeStatus(DB, { ...stamped, url: videoUrl }, nowIso);
    return { ...state, url: videoUrl };
  } catch {
    return state; // Graph API down or token invalid — page link still works
  }
}

async function readStatus(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CONFIG_KEY).first();
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

/** Compute the public state from the stored record + current time. */
function computeState(stored, now) {
  if (!stored || !stored.enabled || !stored.endsAt) return OFF_STATE;

  const startsAt = stored.startsAt ? Date.parse(stored.startsAt) : null;
  const endsAt = Date.parse(stored.endsAt);
  if (!Number.isFinite(endsAt) || now >= endsAt) return OFF_STATE;

  const upcoming = Number.isFinite(startsAt) && now < startsAt;
  return {
    live: !upcoming,
    upcoming,
    message: stored.message || DEFAULT_MESSAGE,
    url: stored.url || DEFAULT_URL,
    startsAt: stored.startsAt || null,
    endsAt: stored.endsAt,
    id: stored.id || stored.updatedAt || null,
  };
}

export async function onRequestGet(context) {
  const auto = !!(context.env.FB_PAGE_ID && context.env.FB_PAGE_TOKEN);
  try {
    const { DB } = context.env;
    const stored = await readStatus(DB);
    let state = computeState(stored, Date.now());
    if (state.live) {
      state = await maybeUpgradeToVideoUrl(context.env, stored, state, Date.now());
    }
    return Response.json({ ...state, auto }, {
      // Polled by every visitor — always serve fresh so "go live" and
      // "end broadcast" propagate within one poll interval.
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    // Fail quiet: the pill simply doesn't show
    return Response.json({ ...OFF_STATE, auto }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    const userEmail = context.data?.userEmail || 'unknown';
    const body = await context.request.json();
    const { action } = body;

    if (action !== 'start' && action !== 'stop' && action !== 'update') {
      return Response.json(
        { success: false, error: 'action must be "start", "update", or "stop"' },
        { status: 400 }
      );
    }

    const now = new Date();
    let record;

    if (action === 'start') {
      const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : DEFAULT_URL;
      if (!/^https:\/\//.test(url)) {
        return Response.json({ success: false, error: 'url must be https' }, { status: 400 });
      }

      let startsAt = null;
      if (body.startsAt) {
        const parsed = Date.parse(body.startsAt);
        if (!Number.isFinite(parsed)) {
          return Response.json({ success: false, error: 'startsAt is not a valid date' }, { status: 400 });
        }
        // A past schedule just means "live now"
        if (parsed > now.getTime()) startsAt = new Date(parsed);
      }

      const hours = Math.min(MAX_DURATION_HOURS, Math.max(0.5, Number(body.durationHours) || DEFAULT_DURATION_HOURS));
      const base = startsAt || now;
      const endsAt = new Date(base.getTime() + hours * 3600 * 1000);

      record = {
        enabled: true,
        message: typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 140) : DEFAULT_MESSAGE,
        url,
        startsAt: startsAt ? startsAt.toISOString() : null,
        endsAt: endsAt.toISOString(),
        id: `live-${now.getTime()}`,
        updatedAt: now.toISOString(),
        updatedBy: userEmail,
      };
    } else if (action === 'update') {
      const existing = await readStatus(DB);
      const active = computeState(existing, now.getTime());
      if (!active.live && !active.upcoming) {
        return Response.json(
          { success: false, error: 'No active broadcast to update — start one first' },
          { status: 400 }
        );
      }

      let url = existing.url || DEFAULT_URL;
      if (typeof body.url === 'string' && body.url.trim()) {
        url = body.url.trim();
        if (!/^https:\/\//.test(url)) {
          return Response.json({ success: false, error: 'url must be https' }, { status: 400 });
        }
      }

      // Same broadcast window and id — only the banner content changes
      record = {
        ...existing,
        message: typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 140) : existing.message,
        url,
        updatedAt: now.toISOString(),
        updatedBy: userEmail,
      };
    } else {
      const existing = await readStatus(DB);
      record = {
        ...(existing || {}),
        enabled: false,
        updatedAt: now.toISOString(),
        updatedBy: userEmail,
      };
    }

    await writeStatus(DB, record, now.toISOString());

    const auditByAction = {
      start: {
        action: 'published',
        name: record.startsAt ? 'Scheduled Facebook Live' : 'Went live on Facebook',
        changes: [{ field: 'status', from: 'off', to: record.startsAt ? `scheduled ${record.startsAt}` : 'live' }],
      },
      update: {
        action: 'updated',
        name: 'Updated live banner',
        changes: [{ field: 'url', from: null, to: record.url }, { field: 'message', from: null, to: record.message }],
      },
      stop: {
        action: 'updated',
        name: 'Ended Facebook Live',
        changes: [{ field: 'status', from: 'live', to: 'off' }],
      },
    };
    const audit = auditByAction[action];
    await logAudit(DB, {
      userEmail,
      action: audit.action,
      entityType: 'live-status',
      entitySlug: CONFIG_KEY,
      entityName: audit.name,
      changes: audit.changes,
      gitStatus: 'ok', // D1-only — nothing to commit
    });

    return Response.json({ success: true, state: computeState(record, Date.now()) });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
