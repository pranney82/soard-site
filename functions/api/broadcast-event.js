/**
 * POST /api/broadcast-event — analytics beacon (public, rate limited)
 * ===================================================================
 * { type, broadcastId?, meta? } → 204. Whitelisted types only; rows go to
 * broadcast_events and roll up per reveal in the admin. banner_click also
 * bumps the legacy click counter, in place (countBannerClick), so a public
 * click never rewrites the broadcast state.
 *
 * broadcastId must be the current broadcast or one we really had (a replay
 * page left open); anything else is dropped. meta is a few short, simple
 * values: up to 6 keys of letters, digits and _, each a string (80 chars at
 * most), number or true/false.
 */

import { ensureSchema, recordEvent, readState, countBannerClick } from './_broadcast.js';

const TYPES = new Set([
  'banner_click', 'view_live_page', 'click_watch', 'click_facebook', 'click_youtube',
  'click_donate', 'click_replay', 'click_instagram', 'click_calendar', 'reminder_form_view', 'share',
  'qr_scan', // the reusable family QR code (/live/?src=qr)
]);

const BROADCAST_ID = /^live-\d{1,16}$/;
const META_KEY = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const META_MAX_KEYS = 6;
const META_MAX_CHARS = 80;

/** The beacon's meta, kept small and flat: strings, finite numbers and booleans only */
export function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (Object.keys(out).length >= META_MAX_KEYS) break;
    if (!META_KEY.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, META_MAX_CHARS);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export async function onRequestPost(context) {
  const { env } = context;
  let body = {};
  try { body = await context.request.json(); } catch { /* sendBeacon with text */ }
  if (!body || typeof body !== 'object') body = {};
  const type = String(body.type || '');
  if (!TYPES.has(type)) return new Response(null, { status: 204 });
  try {
    await ensureSchema(env.DB);
    const state = await readState(env.DB);
    let broadcastId = state.broadcastId || null;
    if (body.broadcastId != null && body.broadcastId !== '') {
      const given = typeof body.broadcastId === 'string' ? body.broadcastId : '';
      if (!BROADCAST_ID.test(given)) return new Response(null, { status: 204 });
      // Not the current one: only a broadcast we really had (a replay page left open)
      if (given !== broadcastId && !(await env.DB.prepare('SELECT 1 AS ok FROM broadcasts WHERE id = ?').bind(given).first())) {
        return new Response(null, { status: 204 });
      }
      broadcastId = given;
    }
    await recordEvent(env.DB, broadcastId, type, cleanMeta(body.meta));
    if (type === 'banner_click' && broadcastId && broadcastId === state.broadcastId) await countBannerClick(env.DB, broadcastId);
  } catch { /* analytics only */ }
  return new Response(null, { status: 204 });
}
