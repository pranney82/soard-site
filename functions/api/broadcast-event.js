/**
 * POST /api/broadcast-event — analytics beacon (public, rate limited)
 * ===================================================================
 * { type, broadcastId?, meta? } → 204. Whitelisted types only; rows go to
 * broadcast_events and roll up per reveal in the admin. banner_click also
 * bumps the legacy click counter so the old admin card keeps working.
 */

import { ensureSchema, recordEvent, readState, writeState } from './_broadcast.js';

const TYPES = new Set([
  'banner_click', 'view_live_page', 'click_watch', 'click_facebook', 'click_youtube',
  'click_donate', 'click_replay', 'click_calendar', 'reminder_form_view', 'share',
]);

export async function onRequestPost(context) {
  const { env } = context;
  let body = {};
  try { body = await context.request.json(); } catch { /* sendBeacon with text */ }
  const type = String(body.type || '');
  if (!TYPES.has(type)) return new Response(null, { status: 204 });
  try {
    await ensureSchema(env.DB);
    const state = await readState(env.DB);
    const broadcastId = typeof body.broadcastId === 'string' && body.broadcastId.startsWith('live-') ? body.broadcastId.slice(0, 40) : state.broadcastId;
    const meta = body.meta && typeof body.meta === 'object' ? Object.fromEntries(Object.entries(body.meta).slice(0, 8).map(([k, v]) => [String(k).slice(0, 32), String(v).slice(0, 120)])) : null;
    await recordEvent(env.DB, broadcastId, type, meta);
    if (type === 'banner_click' && state.broadcastId && state.phase !== 'idle') {
      await writeState(env.DB, { ...state, clicks: (state.clicks || 0) + 1 });
    }
  } catch { /* analytics only */ }
  return new Response(null, { status: 204 });
}
