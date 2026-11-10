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

import { runTick, verifyHubNonce, publishToHub, publicPayload, readState, readConfig, hubStatus } from './_broadcast.js';
import { maybeRefreshRevealStats } from './_reveal-stats.js';
import { maybeNudge } from './_reveal-nudges.js';
import { maybeSweep, maybeCheckGuests } from './_reveal-invites.js';
import { maybeCheckDemos } from './_demo-invites.js';
import { maybeRunRevealDesigns } from './_reveal-design-auto.js';
import { syncBroadcastSchedule } from './_broadcast-schedule.js';
import { maybeSweepApplications } from './_applications.js';
import { maybeSyncKidStatuses } from './_kid-status.js';
import { maybeSyncKidPartners } from './_kid-partners.js';
import { maybeSyncVendorAccess } from './_vendor-access.js';
import { maybeSyncSponsors } from './_sponsors.js';
import { maybeSweepZeffy } from './_zeffy.js';
import { maybeSyncDonors } from './_kit-donors.js';
import { maybeRunWaitlist } from './_application-waitlist.js';
import { maybeRunPress } from './_press.js';
import { maybeSlackPreview } from './_slack-preview.js';
import { maybeRunEventRecaps } from './_event-recap.js';
import { maybeRunNewsletterDrafts } from './_newsletter-drafts.js';
import { maybeRunCompanyCam } from './_companycam-sync.js';
import { maybeCheckJobs } from './_companycam-jobs.js';
import { maybeCapSelfTest } from './_application-cap.js';
import { maybeTrackEmails } from './_email-log.js';
import { maybeRunSpend } from './_spend.js';
import { maybeRunChecks } from './_check-gifts.js';
import { maybeRunFinance } from './_finance.js';
import { maybeRunVendors } from './_vendors.js';
import { maybeRunInsuranceAudit } from './_insurance-audit.js';
import { maybeRefreshProcess } from './_process-docs.js';
import { alertAdmins } from './_broadcast-notify.js';
import { maybeRunBoard } from './_board.js';
import { maybeRunSigning } from './_board-sign.js';
import { maybeRunAsks } from './_board-asks.js';
import { maybeSyncStaff } from './_staff-access.js';
import { maybeSweepMail } from './_mail-sweep.js';
import { maybeSweepOrders } from './_order-sweep.js';
import { maybeReadSelections } from './_selection-parts.js';
import { maybeWriteKidItems } from './_kid-jt.js';
import { maybeRunQuiet } from './_kit-quiet.js';
import { maybeRunBackfill } from './_coi-backfill.js';
import { maybeCheckOrgFacts } from './_org-facts.js';
import { maybeRunAiWatch } from './_ai-watch.js';

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
    // Reveal stats: the hearts while a reveal is live or on replay, and Facebook's and YouTube's own totals
    // for the last 30 days' reveals, every 15 minutes at first, then less often (see _reveal-stats.js)
    context.waitUntil(maybeRefreshRevealStats(env, { readState, hubStatus: () => hubStatus(env) }));
    context.waitUntil(maybeSweep(env));
    context.waitUntil(maybeCheckGuests(env));
    // Each confirmed reveal's design (before photos, drawings, board) brought in from JobTread before it, and staff told
    // 3 days and 1 day out whether it's ready (every 10 minutes; see _reveal-design-auto.js)
    context.waitUntil(maybeRunRevealDesigns(env));
    // Demo day invites: a Demo task that moved, a sponsor set, a wake-up JobTread missed (every 5 minutes; see _demo-invites.js)
    context.waitUntil(maybeCheckDemos(env));
    context.waitUntil(syncBroadcastSchedule(env));
    context.waitUntil(maybeSweepApplications(env));
    context.waitUntil(maybeSyncKidStatuses(env));
    // Every 10 minutes: Vendors and Sponsors on a job get their logo on the kid's page; no logo, staff are emailed (see _kid-partners.js).
    // Then monetary sponsors: job access follows the website, the Monetary Sponsor field mirrors it, and a
    // Sponsor added in JobTread comes in (see _sponsors.js). In turn, so the two never write a kid at once
    context.waitUntil(maybeSyncKidPartners(env).then(() => maybeSyncSponsors(env)));
    // Every 15 minutes: each job's vendors (logos on the page, bills and orders) on its JobTread job access, quietly,
    // and vendor contacts kept in step both ways (see _vendor-access.js)
    context.waitUntil(maybeSyncVendorAccess(env));
    context.waitUntil(maybeSweepZeffy(env));
    // Every 15 minutes: Zeffy's donors onto the newsletter in Kit, tagged Donors; anyone who unsubscribed is left alone (see _kit-donors.js)
    context.waitUntil(maybeSyncDonors(env, { alert: async (e, card) => alertAdmins(e, await readConfig(e.DB), card) }));
    context.waitUntil(maybeRunWaitlist(env));
    context.waitUntil(maybeRunPress(env));
    // Event pages turn into their recap (photos, then sponsors) the morning after (see _event-recap.js)
    context.waitUntil(maybeRunEventRecaps(env));
    // Event Recap and Monthly Impact drafts in Kit, hourly (./_newsletter-drafts.js)
    context.waitUntil(maybeRunNewsletterDrafts(env));
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
    // Job costs every 2 minutes: Mercury charges the webhook missed, new JobTread bills paired with their charges,
    // notes back to Mercury; every job's ledger every 15 minutes; the weekday morning receipts card (see _spend.js)
    context.waitUntil(maybeRunSpend(env));
    // A check deposited in Mercury becomes its Zeffy record (one check a run)
    context.waitUntil(maybeRunChecks(env));
    context.waitUntil(maybeRunFinance(env));
    // Vendors' W-9s and insurance, kept on the site (JobTread's fields show them): asked for, checked, and held bills let go (see _vendors.js)
    context.waitUntil(maybeRunVendors(env));
    // Quiet Kit subscribers: once a day after 10am, while staff have it on in Site Config → Newsletter (see _kit-quiet.js)
    context.waitUntil(maybeRunQuiet(env));
    // Daily: subs paid this workers' comp term, and the certificate asked for when none covered the work (see _insurance-audit.js)
    context.waitUntil(maybeRunInsuranceAudit(env));
    // The board: Access's sign-in list kept to People → Board (every 5 minutes when it changed), and the month's bank balance once a day (see _board.js)
    context.waitUntil(maybeRunBoard(env));
    // The board's signed papers: each signature's signed copy made, its receipt sent, a changed email told to the old address (see _board-sign.js)
    context.waitUntil(maybeRunSigning(env));
    // The next meeting's report asks from Peter's Gmail, their due dates, the chair's review, and the replies put on the agenda (see _board-asks.js)
    context.waitUntil(maybeRunAsks(env));
    // Staff sign-in follows SOARD's Google accounts: read every 5 minutes, a suspended or deleted one signed out (_staff-access.js)
    context.waitUntil(maybeSyncStaff(env));
    // Every staff inbox: receipts to the receipt inbox, family emails onto their JobTread account (see _mail-sweep.js)
    context.waitUntil(maybeSweepMail(env));
    // Kid items, read only for now: store order emails in every SOARD inbox (every 3 minutes), then each open makeover's
    // chosen selections as parts (every 30 minutes); nothing goes to JobTread yet (see _order-sweep.js, _selection-parts.js)
    // Side by side, so neither waits on the other's time
    context.waitUntil(Promise.all([maybeSweepOrders(env), maybeReadSelections(env), maybeWriteKidItems(env)]));
    // The certificates and W-9s SOARD already had (staff email, JobTread, Ramp): found, read and filed on their JobTread vendor (see _coi-backfill.js)
    context.waitUntil(maybeRunBackfill(env));
    // Hourly: SOARD's process Docs in Drive, so Site → Automations knows if Drive stops answering (see _process-docs.js)
    context.waitUntil(maybeRefreshProcess(env));
    // Every 6 hours: SOARD's own facts against the IRS's list, its W-9 and its Board Manual (see _org-facts.js)
    context.waitUntil(maybeCheckOrgFacts(env));
    // Hourly: what each site's AI cost, by feature, and a post when one jumps or reaches a cap (see _ai-watch.js)
    context.waitUntil(maybeRunAiWatch(env));
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
