/**
 * POST /api/broadcast-hooks — heartbeat from the real-time hub
 * =============================================================
 * The soard-live-hub Durable Object calls this every few seconds with a
 * one-time nonce in X-Hub-Nonce (a UUID; anything else is refused before the
 * hub is asked). We verify the nonce back over the private
 * LIVE_HUB binding (only this Pages project can reach it), run a tick, and
 * return the public state; the hub pushes it to every open socket if it
 * changed. The answer comes within 10 s (the hub gives up at 15): a slower
 * tick finishes after the reply and publishes its own change. No shared
 * secret exists anywhere. The same heartbeat wakes the
 * reveal checks, the reveal invite sweep and guest check, the demo day
 * invite check, the JobTread
 * schedule check, the makeover application sweep and the Zeffy gift check
 * (see below).
 */

import { runTick, verifyHubNonce, publishToHub, publicPayload, readState, readConfig } from './_broadcast.js';
import { maybeNudge } from './_reveal-nudges.js';
import { maybeSweep, maybeCheckGuests } from './_reveal-invites.js';
import { maybeCheckDemos } from './_demo-invites.js';
import { syncBroadcastSchedule } from './_broadcast-schedule.js';
import { maybeSweepApplications } from './_applications.js';
import { maybeSyncKidStatuses } from './_kid-status.js';
import { maybeSweepZeffy } from './_zeffy.js';
import { maybeRunWaitlist } from './_application-waitlist.js';
import { maybeRunPress } from './_press.js';
import { maybeSlackPreview } from './_slack-preview.js';
import { maybeRunEventRecaps } from './_event-recap.js';
import { maybeRunCompanyCam } from './_companycam-sync.js';
import { maybeCheckJobs } from './_companycam-jobs.js';
import { maybeCapSelfTest } from './_application-cap.js';
import { maybeTrackEmails } from './_email-log.js';
import { alertAdmins } from './_broadcast-notify.js';
import { maybeRunBoard } from './_board.js';

// The hub gives up on this call after 15 s: answer within 10, and let a slower tick finish after the reply
const HUB_ANSWER_MS = 10 * 1000;

export async function onRequestPost(context) {
  const { env, request } = context;
  const nonce = request.headers.get('x-hub-nonce');
  if (!env.LIVE_HUB) return Response.json({ ok: false, error: 'LIVE_HUB binding missing' }, { status: 503 });
  if (!(await verifyHubNonce(env, nonce))) return Response.json({ ok: false, error: 'invalid nonce' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    const ticking = runTick(env, { source: body.source ? `hub:${body.source}` : 'hub', force: !!body.force });
    let answered = false;
    // A tick that outlasts the answer still finishes (waitUntil), and pushes what it changed to the hub itself
    context.waitUntil(ticking.then(async (t) => {
      if (answered && t.changed) await publishToHub(env, await readState(env.DB), await readConfig(env.DB), 'tick');
    }).catch(() => {}));
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => { answered = true; resolve(null); }, HUB_ANSWER_MS); });
    const r = await Promise.race([ticking, late]).finally(() => clearTimeout(timer));
    // The hub's heartbeat (every minute even when idle) is the site's clock for
    // reveal work: weekday 8 AM reveal checks, the 6-hourly invite sweep, the
    // 5-minute invite guest check (new vendors on a job), the 5-minute check
    // that the live broadcast matches JobTread's next reveal, and the 2-minute
    // application sweep (retries, videos ready for JobTread, expired drafts),
    // the hourly check that kids' statuses match their JobTread jobs, and the
    // 15-minute catch-up check for Zeffy gifts the webhook missed, and the
    // applications waitlist (its Kit retries, and the email that goes the
    // minute applications open), and the press monitor (scans every few
    // hours, files coverage, the weekly link check).
    // Each decides for itself whether it's due; none ever throws.
    context.waitUntil(maybeNudge(env));
    context.waitUntil(maybeSweep(env));
    context.waitUntil(maybeCheckGuests(env));
    // Demo day invites: a Demo task that moved, a sponsor set, a wake-up JobTread missed (every 5 minutes; see _demo-invites.js)
    context.waitUntil(maybeCheckDemos(env));
    context.waitUntil(syncBroadcastSchedule(env));
    context.waitUntil(maybeSweepApplications(env));
    context.waitUntil(maybeSyncKidStatuses(env));
    context.waitUntil(maybeSweepZeffy(env));
    context.waitUntil(maybeRunWaitlist(env));
    context.waitUntil(maybeRunPress(env));
    // Event pages turn into their recap (photos, then sponsors) the morning after (see _event-recap.js)
    context.waitUntil(maybeRunEventRecaps(env));
    // CompanyCam for families in review: their project, home-visit photos to JobTread, the hand-over to the job (see _companycam-sync.js)
    context.waitUntil(maybeRunCompanyCam(env));
    // Every open job's CompanyCam photos against JobTread's copies, about hourly (see _companycam-jobs.js)
    context.waitUntil(maybeCheckJobs(env));
    // Once per alert redesign: the new Slack cards, posted in one thread (see _slack-preview.js)
    context.waitUntil(maybeSlackPreview(env));
    // Once per CAP_SELF_TEST: the application limit's two notices for a sample season, marked as tests (see _application-cap.js)
    context.waitUntil(maybeCapSelfTest(env));
    // Every 30 minutes: Resend reports on each email the site sent (it registers its own webhook), and any missed report is caught up (see _email-log.js)
    context.waitUntil(maybeTrackEmails(env, { alert: async (e, card) => alertAdmins(e, await readConfig(e.DB), card) }));
    // The board: Access's sign-in list kept to People → Board (every 5 minutes when it changed), and the month's bank balance once a day (see _board.js)
    context.waitUntil(maybeRunBoard(env));
    // The hub passes `reason` to every open page and keeps `work` in its status, so both go
    // as kinds only ('email', 'kid', 'auto-start'), never kid slugs or send counts
    if (!r) return Response.json({ ok: true, state: (await publicPayload(env)).state, reason: 'tick', work: [], changed: false, cached: false, busy: true });
    const work = [...new Set((r.work || []).map((w) => String(w).split(':')[0]))];
    return Response.json({ ok: true, state: r.state, reason: 'tick', work, changed: r.changed, cached: !!r.cached, busy: !!r.busy });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'broadcast-hooks', method: 'POST' });
}
