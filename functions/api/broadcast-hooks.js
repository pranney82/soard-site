/**
 * POST /api/broadcast-hooks — heartbeat from the real-time hub
 * =============================================================
 * The soard-live-hub Durable Object calls this every few seconds with a
 * one-time nonce in X-Hub-Nonce. We verify the nonce back over the private
 * LIVE_HUB binding (only this Pages project can reach it), run a tick, and
 * return the public state; the hub pushes it to every open socket if it
 * changed. No shared secret exists anywhere. The same heartbeat wakes the
 * reveal checks, the reveal invite sweep and guest check, the JobTread
 * schedule check, the makeover application sweep and the Zeffy gift check
 * (see below).
 */

import { runTick, verifyHubNonce } from './_broadcast.js';
import { maybeNudge } from './_reveal-nudges.js';
import { maybeSweep, maybeCheckGuests } from './_reveal-invites.js';
import { syncBroadcastSchedule } from './_broadcast-schedule.js';
import { maybeSweepApplications } from './_applications.js';
import { maybeSyncKidStatuses } from './_kid-status.js';
import { maybeSweepZeffy } from './_zeffy.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const nonce = request.headers.get('x-hub-nonce');
  if (!env.LIVE_HUB) return Response.json({ ok: false, error: 'LIVE_HUB binding missing' }, { status: 503 });
  if (!(await verifyHubNonce(env, nonce))) return Response.json({ ok: false, error: 'invalid nonce' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    const r = await runTick(env, { source: body.source ? `hub:${body.source}` : 'hub', force: !!body.force });
    // The hub's heartbeat (every minute even when idle) is the site's clock for
    // reveal work: weekday 8 AM reveal checks, the 6-hourly invite sweep, the
    // 5-minute invite guest check (new vendors on a job), the 5-minute check
    // that the live broadcast matches JobTread's next reveal, and the 2-minute
    // application sweep (retries, videos ready for JobTread, expired drafts),
    // the hourly check that kids' statuses match their JobTread jobs, and the
    // 15-minute catch-up check for Zeffy gifts the webhook missed.
    // Each decides for itself whether it's due; none ever throws.
    context.waitUntil(maybeNudge(env));
    context.waitUntil(maybeSweep(env));
    context.waitUntil(maybeCheckGuests(env));
    context.waitUntil(syncBroadcastSchedule(env));
    context.waitUntil(maybeSweepApplications(env));
    context.waitUntil(maybeSyncKidStatuses(env));
    context.waitUntil(maybeSweepZeffy(env));
    return Response.json({ ok: true, state: r.state, reason: r.reason, work: r.work, changed: r.changed, cached: !!r.cached });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'broadcast-hooks', method: 'POST' });
}
