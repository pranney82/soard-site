/**
 * /api/live-status — legacy live banner API, now a view over the broadcast
 * state machine (functions/api/_broadcast.js)
 * ===========================================================================
 * Kept so anything still calling the old endpoint keeps working.
 *
 * GET (public) → { live, upcoming, replay, phase, message, url, liveUrl,
 *                  startsAt, endsAt, id, clicks, image, kidName, kidSlug,
 *                  player, facebookUrl, auto }
 *   ?sweep=1 (Access) runs the Facebook replay archive sweep synchronously
 *   and returns its summary — the archive still protects old Facebook-only
 *   broadcasts from the 30-day deletion.
 *
 * POST (Access) → legacy actions mapped onto the state machine:
 *   start  {startsAt in future}  → schedule
 *   start  {no startsAt}         → goLiveManual (banner-only override)
 *   update                       → update
 *   stop                         → endNow, or cancel when only scheduled
 */

import { sweepArchives } from './_fb-archive.js';
import { isAuthenticated } from './_middleware.js';
import { ensureSchema, readConfig, readState, legacyState, adminAction, runTick } from './_broadcast.js';

// Per-isolate throttle so most visitor polls skip the archive sweep entirely
let _lastSweepAttempt = 0;
const SWEEP_ATTEMPT_INTERVAL_MS = 15 * 60 * 1000;

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  try {
    await ensureSchema(env.DB);
    const wantSweep = url.searchParams.get('sweep') === '1' && await isAuthenticated(context.request, env);
    let sweepSummary = null;
    if (wantSweep) {
      sweepSummary = await sweepArchives(env);
    } else if (Date.now() - _lastSweepAttempt > SWEEP_ATTEMPT_INTERVAL_MS) {
      _lastSweepAttempt = Date.now();
      context.waitUntil(sweepArchives(env));
    }
    // Keep the state machine moving even without the hub (throttled per isolate)
    context.waitUntil(runTick(env, { source: 'visitor', minIntervalMs: 20000 }).catch(() => {}));

    const [config, state] = await Promise.all([readConfig(env.DB), readState(env.DB)]);
    const body = { ...legacyState(state, config), ...(sweepSummary ? { sweep: sweepSummary } : {}) };
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json({ live: false, upcoming: false, replay: false, phase: 'idle', message: '', url: 'https://www.facebook.com/SunshineOnaRanneyDay', startsAt: null, endsAt: null, id: null, auto: true, error: err.message }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  const userEmail = context.data?.userEmail || 'unknown';
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }
  const { action } = body;
  try {
    await ensureSchema(env.DB);
    let r;
    if (action === 'start') {
      const startsAt = body.startsAt ? Date.parse(body.startsAt) : NaN;
      if (Number.isFinite(startsAt) && startsAt > Date.now()) {
        r = await adminAction(env, 'schedule', { scheduledAt: new Date(startsAt).toISOString(), kidSlug: body.kidSlug, title: body.title, message: body.message, image: body.image }, userEmail);
      } else {
        r = await adminAction(env, 'goLiveManual', { message: body.message, url: body.url, image: body.image, durationHours: body.durationHours, kidSlug: body.kidSlug }, userEmail);
      }
    } else if (action === 'update') {
      r = await adminAction(env, 'update', { message: body.message, url: body.url, image: body.image }, userEmail);
    } else if (action === 'stop') {
      const state = await readState(env.DB);
      r = await adminAction(env, ['scheduled', 'armed'].includes(state.phase) ? 'cancel' : 'endNow', {}, userEmail);
    } else {
      return Response.json({ success: false, error: 'action must be "start", "update", or "stop"' }, { status: 400 });
    }
    if (!r.success) return Response.json({ success: false, error: r.error }, { status: r.status || 400 });
    return Response.json({ success: true, state: r.legacy });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
