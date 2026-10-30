/**
 * GET /api/automations-admin (Cloudflare Access) — live facts for Site → Automations
 * ==========================================================================
 * The admin's automations map (public/admin/automations.js) describes every
 * automation and connection; this route tells it which ones are actually
 * switched on and when they last ran, so the map can't drift from reality:
 *
 *  - env:       which keys are set in Cloudflare (true/false only, never values)
 *  - bindings:  D1, R2, Workers AI, the live hub
 *  - broadcast: the Broadcast settings switches (outputs, reminders, Reels, Kit, messages)
 *  - health:    heartbeat, daily check, Stream webhook, replay check timestamps
 *  - hub:       the live hub's own status, and whether it runs the current code
 *  - invites:   reveal invite sending switch, the last safety sweep and guest check
 *  - revealChecks: weekday reveal checks switch and last run; date sync's last activity
 *  - liveSchedule: the live countdown's last JobTread check (what it follows, what's waiting)
 *  - kidStatus: kid statuses following JobTread (last sweep, last run, profiles it hid)
 *  - kidLogos:  Vendor and Sponsor logos on kid pages from JobTread (last sweep, logos added, companies waiting; counts only)
 *  - vendorAccess: vendors on their JobTread jobs (last run, people added, accounts made, contacts synced, companies waiting; counts only)
 *  - zeffy:     gift alerts in Slack (last webhook, post and catch-up check; posts still failing)
 *  - mercury:   Mercury through SOARD's relay (both keys present, and the accounts it answers with: names and kinds only)
 *  - board:     Access's board sign-in list (synced, the policy on the app, members without an email), bank history months, the last packet
 *  - staff:     staff sign-in from SOARD's Google accounts (last read, active and off counts, the fix a failed read needs, who was signed out)
 *  - mailSweep: the staff inboxes sweep (the watch, last look, the backlog, the week's counts; family and vendor names only)
 *  - emailTracking: Resend's delivery reports (on, waiting, send-only key, or the last error)
 *  - slack:     how alerts reach Slack (app or webhook), the channel's name, and Slack's own error if any
 *  - fbArchive: last Facebook replay rescue and replays still waiting for a kid
 *  - sends:     last reminder send per kind and channel (counts only)
 *  - jobtread:  SOARD workflows (on/off) and webhooks (host and events only)
 *  - quo:       Quo texts and calls DataX logged with applicant families (last one, count in 30 days; never content)
 *  - waitlist:  families waiting for the applications-open email, signups not in Kit yet, the last opening
 *  - applicationLimit: the season's limit, how many are in, the last heads-up or close (counts only)
 *  - eventRecap: event pages turning into their recap (last check, last rebuild, a rebuild still waiting)
 *  - jotform:   the one-time Jotform copy (submissions copied, left, families and files added; counts only)
 *  - advisory:  Advisory Board applications (how many, New, the last one and who heard; counts only)
 *  - demoInvites: demo day invites (the switch, the last 5-minute check, invites out; counts only)
 *  - processDocs: the process Docs Site → Automations → Process follows (names, last read, any problem)
 *
 * Not in _middleware's public list, so Access guards it. Never cached.
 * Each section fails on its own: one unreachable service never blanks the rest.
 */

import { hubStatus } from './_broadcast.js';
import { slackStatus, readAlertTexts, alertPhones } from './_broadcast-notify.js';
import { JT_URL, SOARD_ORG_ID } from './_reveals.js';
import { approvalsStatus } from './_applicant-approved.js';
import { replyAlertFacts } from './_applicant-replies.js';
import { coverFacts } from './_job-covers.js';
import { backfillFacts } from './_jotform-backfill.js';
import { advisoryFacts } from './_advisory-applications.js';
import { eventRecapState } from './_event-recap.js';
import { companycamFacts } from './_companycam-sync.js';
import { jobsFacts } from './_companycam-jobs.js';
import { applicationSettings, pickApplication } from './_applications.js';
import { capFacts, lastCapNotice } from './_application-cap.js';
import { trackingState } from './_email-log.js';
import { demoFacts } from './_demo-invites.js';
import { listAccounts } from './_mercury.js';
import { boardFacts } from './_board.js';
import { staffStatus } from './_staff-access.js';
import { mailSweepStatus } from './_mail-sweep.js';
import { processFacts } from './_process-docs.js';

const has = (v) => typeof v === 'string' ? v.trim().length > 0 : !!v;

async function siteConfig(DB, key) {
  const row = await DB.prepare('SELECT data, updated_at FROM site_config WHERE key = ?').bind(key).first();
  if (!row) return null;
  try { return { data: JSON.parse(row.data), updatedAt: row.updated_at }; } catch { return null; }
}

export function envFacts(env) {
  return {
    slack: has(env.SLACK_BOT_TOKEN) || has(env.SLACK_WEBHOOK_URL),
    twilio: has(env.TWILIO_ACCOUNT_SID) && (has(env.TWILIO_AUTH_TOKEN) || (has(env.TWILIO_API_KEY_SID) && has(env.TWILIO_API_KEY_SECRET))) && (has(env.TWILIO_FROM) || has(env.TWILIO_MESSAGING_SERVICE_SID)),
    twilioToken: has(env.TWILIO_AUTH_TOKEN),
    youtube: has(env.YOUTUBE_API_KEY),
    kit: has(env.KIT_API_KEY),
    resend: has(env.RESEND_API_KEY),
    calendar: has(env.GOOGLE_CALENDAR_KEY),
    jobtread: has(env.JOBTREAD_GRANT_KEY),
    jobtreadQc: has(env.JOBTREAD_QC_GRANT_KEY),
    facebook: has(env.FB_PAGE_ID) && has(env.FB_PAGE_TOKEN),
    stream: has(env.CF_ACCOUNT_ID) && has(env.CF_STREAM_TOKEN),
    images: has(env.CF_ACCOUNT_ID) && has(env.CF_IMAGES_TOKEN),
    deployHook: has(env.CF_PAGES_DEPLOY_HOOK) || has(env.CF_DEPLOY_HOOK) || has(env.DEPLOY_HOOK_URL),
    github: has(env.GITHUB_TOKEN),
    access: has(env.CF_ACCESS_TEAM_DOMAIN) && has(env.CF_ACCESS_AUD),
    constantContact: has(env.CC_CLIENT_ID) || has(env.CC_CLIENT_SECRET) || has(env.CC_REFRESH_TOKEN),
    turnstile: has(env.TURNSTILE_SECRET_KEY),
    turnstileSite: has(env.TURNSTILE_SITE_KEY),
    zeffyWebhook: has(env.ZEFFY_WEBHOOK_SECRET),
    streamWebhookSecret: has(env.STREAM_WEBHOOK_SECRET),
    jobtreadWebhookSecret: has(env.JOBTREAD_WEBHOOK_SECRET),
    zeffyApi: has(env.ZEFFY_API_KEY),
    slackBot: has(env.SLACK_BOT_TOKEN),
    companycam: has(env.COMPANYCAM_TOKEN),
    companycamCustomerStage: String(env.COMPANYCAM_CUSTOMER_STAGE || '').trim().toLowerCase() === 'on',
    mercury: has(env.MERCURY_API_TOKEN),
    ramp: has(env.RAMP_CLIENT_ID) && has(env.RAMP_CLIENT_SECRET),
  };
}

function textMisses(c, texts) {
  const misses = alertPhones(c).map((n) => texts?.numbers?.[n]).filter((r) => r && r.status !== 'delivered');
  return misses.length ? { count: misses.length, why: misses[0].error || null, at: misses[0].at || null } : null;
}

/** The Broadcast settings, reduced to switches. Keys, stream URLs, secrets and phone numbers never leave. */
export function broadcastFacts(cfg, texts = null) {
  if (!cfg) return null;
  const c = cfg.data || {};
  const out = (name) => (c.outputs?.[name] ? !!c.outputs[name].enabled : null);
  return {
    inputEnabled: c.liveInput ? c.liveInput.enabled !== false : null,
    outputs: { facebook: out('facebook'), youtube: out('youtube'), instagram: out('instagram') },
    facebookMode: c.facebook?.mode || null,
    reels: c.reels?.enabled !== false,
    reminders: { enabled: !!c.reminders?.enabled, push: !!c.reminders?.push },
    kitLive: c.kitLive?.enabled !== false,
    messages: c.messages?.enabled !== false,
    vapid: !!c.vapid?.publicKey,
    alertCount: Array.isArray(c.alerts?.emails) ? c.alerts.emails.length : 0,
    alertPhones: Array.isArray(c.alerts?.phones) ? c.alerts.phones.length : 0,
    alertTexts: texts?.last ? { at: texts.last.at, sent: texts.last.sent || 0, failed: texts.last.failed || 0, error: texts.last.error || null } : null,
    // Twilio's delivery reports: how many staff numbers' last text didn't arrive, and why (never a number)
    textMisses: textMisses(c, texts),
    updatedAt: cfg.updatedAt,
  };
}

export function healthFacts(h) {
  if (!h) return null;
  const d = h.data || {};
  return {
    lastTickAt: d.lastTick?.at || null,
    lastTickSource: d.lastTick?.source || null,
    lastDailyAt: d.lastDailyAt || null,
    hubOk: d.hub ? !!d.hub.ok : null,
    streamOk: d.stream ? !!d.stream.ok : null,
    facebookOk: d.facebook ? !!d.facebook.ok : null,
    webhookAt: d.webhook?.lastReceivedAt || null,
    webhookEvent: d.webhook?.lastEvent || null,
    replayCheckAt: d.replayCheckAt || null,
    monitorAt: d.monitor?.at || null,
  };
}

export function inviteFacts(cfg, rows, guestCheck = null) {
  if (!cfg) return null;
  const s = cfg.data?.lastSweep || {};
  return {
    enabled: !!cfg.data?.enabled,
    lastSweepAt: s.at || null,
    // The guest check's row holds when it's next due; updated_at is when it last ran
    lastGuestCheckAt: guestCheck?.updatedAt || null,
    checked: s.checked ?? null,
    changed: s.changed ?? null,
    errors: s.errors ?? null,
    rows: rows ?? null,
  };
}

/** Weekday reveal checks (site_config "reveal-nudges") and the date sync's last activity (reveal_sync) */
export function revealCheckFacts(cfg, sync) {
  const d = cfg?.data || {};
  const run = d.lastRun && !d.lastRun.running ? d.lastRun : null;
  return {
    enabled: !!d.enabled,
    lastRunAt: run?.at || null,
    checked: run?.checked ?? null,
    posted: run?.posted ?? null,
    repaired: run?.repaired ?? null,
    errors: run?.errors ?? null,
    lastErrorAt: d.lastError?.at || null,
    syncedAt: sync?.last || null,
    syncedJobs: sync?.n ?? null,
  };
}

/** The live countdown's last JobTread check (site_config "broadcast-schedule", _broadcast-schedule.js) */
export function liveScheduleFacts(rec) {
  const d = rec?.data;
  if (!d) return { checkedAt: null, error: null, next: null, waiting: 0 };
  const n = d.next;
  return {
    checkedAt: d.checkedAt || null,
    error: d.error || null,
    next: n ? `${n.name || 'the next reveal'} on ${n.date}${n.time ? ` at ${n.time}` : ''}` : null,
    waiting: (d.waiting || []).length,
  };
}

/** Kid status from JobTread (kid_status_state, _kid-status.js); hidden: profiles JobTread took off the site */
export function kidStatusFacts(state, hidden = null) {
  const d = state || {};
  return {
    lastSweepAt: d.lastSweepAt || null,
    lastRunAt: d.lastRun?.at || null,
    changed: d.lastRun?.changed ?? null,
    lastErrorAt: d.lastError?.at || null,
    deployPending: !!d.deployPending,
    lastAutoDeployAt: d.lastAutoDeployAt || null,
    hidden,
  };
}

/** Vendor and Sponsor logos from JobTread (kid_partner_state, _kid-partners.js); waiting: companies with no logo yet. Times and counts only */
export function kidLogoFacts(state, waiting = null) {
  const d = state || {};
  return {
    lastSweepAt: d.lastSweepAt || null,
    lastRunAt: d.lastRun?.at || null,
    added: d.lastRun?.added ?? null,
    lastErrorAt: d.lastError?.at || null,
    lastEmailErrorAt: d.lastEmailError?.at || null,
    waiting,
  };
}

/** Vendors on their JobTread jobs (vendor_access_state, _vendor-access.js). Times and counts only */
export function vendorAccessFacts(state) {
  const d = state || {};
  const r = d.lastRun || {};
  return {
    lastRunAt: r.at || null, claimedAt: d.claimedAt || null, lastErrorAt: d.lastError?.at || null,
    added: r.added ?? null, made: r.made ?? null, contacts: r.contacts ?? null, waiting: r.waiting ?? null, near: r.near ?? null, more: !!r.more,
  };
}

/** Gift alerts in Slack (site_config "zeffy-alerts", _zeffy.js); failing: posts Slack hasn't taken yet. Times and counts only */
export function zeffyFacts(cfg, failing = null) {
  const d = cfg?.data || {};
  return {
    since: d.since || null,
    lastWebhookAt: d.lastWebhookAt || null,
    lastPostAt: d.lastPostAt || null,
    lastSweepAt: d.lastSweep?.at || null,
    sweepError: d.lastSweep?.error || null,
    missed: d.lastMissed?.count ?? 0,
    missedAt: d.lastMissed?.at || null,
    rejectedAt: d.lastRejected?.at || null,
    failing: failing?.n ?? 0,
    failingWhy: failing?.n ? failing.why || null : null,
  };
}

/** Job costs (spend_state "job-costs" and "mercury-webhook", _spend.js). Times and counts only, never the secret */
export async function jobCostFacts(DB) {
  const read = async (key) => JSON.parse((await DB.prepare('SELECT data FROM spend_state WHERE key = ?').bind(key).first('data').catch(() => null)) || '{}');
  const count = (sql) => DB.prepare(sql).first('n').catch(() => null);
  const [cfg, hook, agent, unsorted, billRuns, billPay, closeouts, waitingBills, odd, fin, ven, held, asking, ramp, rampHeld, rampWatch] = await Promise.all([
    read('job-costs'), read('mercury-webhook'), read('agent'),
    count("SELECT count(*) AS n FROM spend_charges WHERE bucket IS NULL AND bill_id IS NULL AND cents > 0 AND status IN ('pending', 'sent')"),
    read('bill-pay-runs'), read('bill-pay'), read('closeouts'),
    count("SELECT count(*) AS n FROM bill_approvals WHERE state IN ('waiting', 'second')"),
    count('SELECT count(*) AS n FROM spend_odd WHERE cleared_at IS NULL'),
    read('finance'), read('vendors'),
    count("SELECT count(*) AS n FROM bill_approvals WHERE pay_state = 'held'"),
    count('SELECT count(*) AS n FROM vendor_asks WHERE open = 1'),
    read('ramp'),
    count("SELECT count(*) AS n FROM ramp_holds WHERE state = 'held'"),
    count("SELECT count(*) AS n FROM ramp_holds WHERE state = 'watch'"),
  ]);
  return {
    webhook: !!hook.id, lastEventAt: hook.lastEventAt || null, webhookError: cfg.webhookError || null,
    lastRunAt: cfg.lastRun?.at || null, lastCatchUpAt: cfg.lastCatchUp?.at || null,
    catchUpError: cfg.lastCatchUpError && !(Date.parse(cfg.lastCatchUp?.at || 0) > Date.parse(cfg.lastCatchUpError.at)) ? cfg.lastCatchUpError.error : null,
    billsError: cfg.lastRun?.billsError || null,
    writeError: cfg.lastWriteError && !(Date.parse(cfg.lastWriteOkAt || 0) > Date.parse(cfg.lastWriteError.at)) ? cfg.lastWriteError.error : null,
    lastRebuildAt: cfg.lastRebuildAt || null, agentUsedAt: agent.lastUsedAt || null,
    unsorted: unsorted ?? 0, caps: cfg.caps === 'on',
    billPay: { at: billRuns.lastAt || null, error: billRuns.error || null, last: billRuns.last || null, mode: billPay.payMode || 'off', approvers: (billPay.approvers || []).length, waiting: waitingBills ?? 0, startsOn: billPay.startsOn || null },
    receipts: cfg.lastRun?.receipts || null,
    odd: odd ?? 0, closeouts: { at: closeouts.lastAt || null, error: closeouts.error || null, historyLeft: closeouts.historyLeft ?? null, closed: closeouts.closed ?? null },
    finance: { at: fin.lastRunAt || null, backfill: fin.backfill || null, forecast: fin.lastForecast || null, mercuryEmpty: !!fin.mercuryEmpty, cashLow: !!fin.cashLowOpen, balancesError: fin.balancesError || null },
    vendors: { at: ven.lastRunAt || null, error: ven.lastError || null, setupError: ven.setupError || null, ready: !!ven.jt?.fields, held: held ?? 0, asking: asking ?? 0,
      ramp: ramp.lastRunAt || ramp.error ? { at: ramp.lastRunAt || null, error: ramp.error || null, held: rampHeld ?? 0, watch: rampWatch ?? 0 } : null },
  };
}

/** Mercury through SOARD's relay (_mercury.js): both keys present, and the accounts Mercury answers with. Names and kinds only, never balances, numbers or the keys */
export async function mercuryFacts(env, fetchImpl = fetch) {
  const keys = { token: has(env.MERCURY_API_TOKEN), relayKey: has(env.MERCURY_RELAY_KEY) };
  if (!keys.token || !keys.relayKey) return { ...keys, accounts: null, error: null };
  try {
    const open = (await listAccounts(env, { fetchImpl })).filter((a) => !['deleted', 'archived', 'closed'].includes(String(a.status || '').toLowerCase()));
    return { ...keys, accounts: open.map((a) => ({ name: a.name, kind: a.kind })), error: null };
  } catch (e) {
    return { ...keys, accounts: null, error: e.message, relay: !!e.relay };
  }
}

/** placed: Stream uids some kid page already uses (staff can attach a replay by hand in the kid editor) */
export function archiveFacts(a, placed = new Set()) {
  if (!a) return null;
  const items = Object.values(a.data?.archived || {});
  return {
    checkedAt: a.data?.checkedAt || null,
    archived: items.length,
    needsKid: items.filter((x) => x.needsKid && !x.attachedTo && !placed.has(x.uid)).length,
    lastAutoDeployAt: a.data?.lastAutoDeployAt || null,
  };
}

// Which of the archive's unplaced replays already sit on a kid page
async function placedUids(DB, archive) {
  const waiting = Object.values(archive?.data?.archived || {}).filter((x) => x.needsKid && !x.attachedTo && x.uid);
  const placed = new Set();
  for (const x of waiting) {
    const hit = await DB.prepare('SELECT 1 AS hit FROM kids WHERE instr(data, ?) > 0 LIMIT 1').bind(x.uid).first('hit');
    if (hit) placed.add(x.uid);
  }
  return placed;
}

/** SOARD's JobTread workflows and webhooks. Webhook URLs carry tokens, so only host and path start leave.
 *  Two queries, so a grant that can read workflows but not webhooks still reports the workflows. */
export async function jobtreadFacts(grantKey, fetchImpl = fetch) {
  if (!grantKey) return { error: 'JOBTREAD_GRANT_KEY is not set' };
  const ask = async (field) => {
    const res = await fetchImpl(JT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { $: { grantKey }, organization: { $: { id: SOARD_ORG_ID }, ...field } } }),
    });
    if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
    const conn = Object.values((await res.json().catch(() => null))?.organization || {})[0];
    if (!conn?.nodes) throw new Error('JobTread did not answer');
    return conn.nodes;
  };
  const [wfs, hooks] = await Promise.allSettled([
    ask({ workflows: { $: { size: 100 }, nodes: { id: {}, name: {}, isActive: {} } } }),
    ask({ webhooks: { $: { size: 100 }, nodes: { id: {}, url: {}, eventTypes: {} } } }),
  ]);
  if (wfs.status === 'rejected' && hooks.status === 'rejected') return { error: wfs.reason.message };
  const out = {};
  if (wfs.status === 'fulfilled') {
    out.workflows = {};
    for (const w of wfs.value) out.workflows[w.id] = { name: w.name, active: !!w.isActive };
  }
  if (hooks.status === 'fulfilled') {
    out.webhooks = {};
    for (const h of hooks.value) {
      let where = '';
      try { const u = new URL(h.url); where = u.host + u.pathname.split('/').slice(0, 3).join('/'); } catch {}
      out.webhooks[h.id] = { where, events: h.eventTypes || [] };
    }
  }
  return out;
}

const settle = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };

export async function gatherFacts(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const DB = env.DB;
  const [cfg, health, invites, archive, reveals, inviteRows, sends, reminders, hub, jobtread, checks, synced, liveSchedule, guestCheck, kidState, kidsHidden, zeffyCfg, zeffyFailing, slackLink] = await Promise.all([
    settle(() => siteConfig(DB, 'broadcast-config')),
    settle(() => siteConfig(DB, 'broadcast-health')),
    settle(() => siteConfig(DB, 'reveal-invites')),
    settle(() => siteConfig(DB, 'fb-archive')),
    settle(() => DB.prepare("SELECT updated_at FROM site_config WHERE key = 'reveals'").first('updated_at')),
    settle(() => DB.prepare('SELECT count(*) AS n FROM reveal_invites').first('n')),
    settle(() => DB.prepare('SELECT kind, channel, max(created_at) AS last, sum(sent) AS sent, sum(failed) AS failed FROM broadcast_sends GROUP BY kind, channel').all()),
    settle(() => DB.prepare('SELECT count(*) AS n FROM broadcast_reminders').first('n')),
    settle(() => hubStatus(env)),
    settle(() => jobtreadFacts(env.JOBTREAD_GRANT_KEY, fetchImpl)),
    settle(() => siteConfig(DB, 'reveal-nudges')),
    // The table appears with the first sync; until then this settles to an error
    settle(() => DB.prepare('SELECT count(*) AS n, max(updated_at) AS last FROM reveal_sync').first()),
    settle(() => siteConfig(DB, 'broadcast-schedule')),
    settle(() => siteConfig(DB, 'reveal-invites-guest-check')),
    // The table appears with the first kid status sync; until then this settles to an error
    settle(async () => JSON.parse((await DB.prepare("SELECT value FROM kid_status_state WHERE key = 'state'").first('value')) || '{}')),
    settle(() => DB.prepare(`SELECT count(*) AS n FROM kids WHERE instr(data, '"hiddenBy":"jobtread"') > 0`).first('n')),
    settle(() => siteConfig(DB, 'zeffy-alerts')),
    // The table appears with the first gift; until then this settles to an error
    settle(() => DB.prepare("SELECT count(*) AS n, max(reason) AS why FROM zeffy_gifts WHERE state = 'failed'").first()),
    // The Slack app's token and alerts channel, checked with Slack itself (no-op without a token)
    settle(() => slackStatus(env)),
  ]);
  const ok = (v) => (v && !v.error ? v : null);
  // The tables appear with the first partner logo sweep; until then these settle to an error
  const [logoState, logoWaiting, vendorState] = await Promise.all([
    settle(async () => JSON.parse((await DB.prepare("SELECT value FROM kid_partner_state WHERE key = 'state'").first('value')) || '{}')),
    settle(() => DB.prepare("SELECT count(DISTINCT company) AS n FROM kid_partner_logos WHERE state = 'waiting'").first('n')),
    settle(async () => JSON.parse((await DB.prepare("SELECT value FROM vendor_access_state WHERE key = 'state'").first('value')) || '{}')),
  ]);
  // What the last staff alert text did, and each number's delivery report (counts and Twilio's words only)
  const alertTexts = await readAlertTexts(DB).catch(() => null);
  const sendMap = {};
  for (const r of ok(sends)?.results || []) {
    sendMap[r.kind] ||= {};
    sendMap[r.kind][r.channel] = { last: r.last, sent: r.sent || 0, failed: r.failed || 0 };
  }
  return {
    checkedAt: new Date(now).toISOString(),
    env: envFacts(env),
    bindings: { db: !!env.DB, files: !!env.FILES, ai: !!env.AI, hub: !!env.LIVE_HUB },
    broadcast: broadcastFacts(ok(cfg), alertTexts),
    health: healthFacts(ok(health)),
    hub: hub?.error && !hub.bound
      ? { ok: false, error: hub.error }
      // The hub gained viewer counting with the watch party; older code reports no "watchers"
      : { ok: !!hub?.ok && !hub?.error, current: !!hub && 'watchers' in hub, lastTickAt: hub?.lastTick?.at || null, clients: hub?.clients ?? null, error: hub?.error || null },
    invites: inviteFacts(ok(invites), typeof inviteRows === 'number' ? inviteRows : null, ok(guestCheck)),
    revealChecks: revealCheckFacts(ok(checks), ok(synced)),
    liveSchedule: liveScheduleFacts(ok(liveSchedule)),
    kidStatus: kidStatusFacts(ok(kidState), typeof kidsHidden === 'number' ? kidsHidden : null),
    kidLogos: kidLogoFacts(ok(logoState), typeof logoWaiting === 'number' ? logoWaiting : null),
    vendorAccess: vendorAccessFacts(ok(vendorState)),
    zeffy: zeffyFacts(ok(zeffyCfg), ok(zeffyFailing)),
    // Resend's delivery reports: registered, waiting, or the key can only send (never the secret)
    emailTracking: ok(await settle(() => trackingState(env))),
    slack: slackLink?.error && !slackLink.mode ? { mode: null, ok: false, error: slackLink.error }
      : { mode: slackLink?.mode || null, ok: !!slackLink?.ok, error: slackLink?.error || null, team: slackLink?.team || null, channel: slackLink?.channel?.name || null, attention: slackLink?.attention?.id && slackLink.attention.id !== slackLink.channel?.id ? slackLink.attention.name || null : null, bot: slackLink?.bot || null },
    fbArchive: archiveFacts(ok(archive), await settle(() => placedUids(DB, ok(archive))).then((p) => (p instanceof Set ? p : new Set()))),
    reveals: { cachedAt: typeof reveals === 'string' ? reveals : null },
    sends: sendMap,
    reminders: { subscribers: typeof reminders === 'number' ? reminders : null },
    jobtread: jobtread || { error: 'JobTread check failed' },
    waitlist: await settle(() => waitlistFacts(DB)),
    applicationLimit: await settle(() => applicationLimitFacts(DB, now)),
    approvals: approvalFacts(await settle(() => approvalsStatus(DB))),
    replyAlerts: await settle(() => replyAlertFacts(DB)).then((r) => (r && !r.error ? r : null)),
    covers: await settle(() => coverFacts(DB)).then((c) => (c && !c.error ? c : null)),
    press: await settle(() => pressFacts(DB)),
    quo: await settle(() => quoFacts(DB, now)),
    eventRecap: await settle(() => eventRecapFacts(DB)),
    jotform: await settle(() => backfillFacts(DB)),
    advisory: await settle(() => advisoryFacts(DB)),
    demoInvites: await settle(() => demoFacts(DB)),
    // Counts, times and on/off only: no names, ids or photos
    companycam: await settle(() => companycamFacts(env)),
    companycamJobs: await settle(() => jobsFacts(env)),
    // Mercury through the relay: account names and kinds only (_mercury.js)
    mercury: await settle(() => mercuryFacts(env, fetchImpl)),
    jobCosts: await settle(() => jobCostFacts(DB)),
    // Access's board list and the monthly bank balance: counts, times and on/off only (_board.js)
    board: await settle(() => boardFacts(env)),
    // Staff sign-in from SOARD's Google accounts: counts, times, on/off, and who was signed out (_staff-access.js)
    staff: await settle(() => staffStatus(env)),
    // Staff inboxes swept: receipts to the receipt inbox, family emails onto JobTread (_mail-sweep.js)
    mailSweep: await settle(() => mailSweepStatus(env)),
    // The process Docs Process follows: their names, last read and any problem (_process-docs.js)
    processDocs: await settle(() => processFacts(DB)),
  };
}

/** Event pages after the event (_event-recap.js): when it last checked and rebuilt, and pages still waiting. Times and counts only */
export async function eventRecapFacts(DB) {
  const s = await eventRecapState(DB);
  return {
    lastRunAt: s.lastRun?.at || null,
    lastDeployAt: s.lastDeployAt || null,
    deployPending: !!s.deployPending,
    waiting: Array.isArray(s.unannounced) ? s.unannounced.length : 0,
  };
}

/** Approved → job and its page (_applicant-approved.js): last run, the last family set up, who's waiting and why */
export function approvalFacts(s) {
  if (!s || s.error) return null;
  const last = s.recent?.[0];
  return {
    lastRunAt: s.lastRun?.at || null,
    lastErrorAt: s.lastError?.at || null,
    last: last ? { name: last.name, at: last.done_at, slug: last.kid_slug || null, project: last.project_slug || null } : null,
    waiting: (s.waiting || []).map((w) => ({ name: w.name, problem: w.problem })),
  };
}

/** Quo texts and calls DataX logs onto applicant families in JobTread, as the Applicants history records them (_applicants.js). Times and counts only */
export async function quoFacts(DB, now = Date.now()) {
  const r = await DB.prepare(`SELECT max(at) AS lastAt, sum(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS last30
    FROM applicant_activity WHERE source = 'datax' AND kind IN ('textIn', 'textOut', 'call')`).bind(new Date(now - 30 * 864e5).toISOString()).first();
  return { lastAt: r?.lastAt || null, last30: r?.last30 || 0 };
}

/** The press monitor (_press.js): when it last looked, what's waiting, the tidy. Times and counts only */
export async function pressFacts(DB) {
  const state = (await siteConfig(DB, 'press-monitor-state').catch(() => null))?.data || {};
  const scans = state.scans || {};
  const times = Object.values(scans).map((x) => x?.at).filter(Boolean).sort();
  // The tables appear with the first heartbeat; until then these settle to nothing
  const review = await DB.prepare("SELECT count(*) AS n FROM press_mentions WHERE state = 'review'").first('n').catch(() => 0);
  const lastFiled = await DB.prepare("SELECT max(at) AS at FROM press_log WHERE kind = 'filed'").first('at').catch(() => null);
  return {
    lastScanAt: times[times.length - 1] || null,
    scanErrors: Object.entries(scans).filter(([, x]) => x?.error).map(([k]) => ({ google: 'Google News', bing: 'Bing News', youtube: 'YouTube' })[k] || k),
    tidyDone: !!state.tidy?.doneAt,
    review: review || 0,
    lastFiledAt: lastFiled || null,
    deployPending: !!state.deployPending,
  };
}

/** The application limit (_application-cap.js): the limit, where the season stands, the last notice. Counts and times only */
export async function applicationLimitFacts(DB, now = Date.now()) {
  const stored = await applicationSettings(DB);
  const a = pickApplication(stored, now);
  const f = await capFacts(DB, a, { now, openedAt: stored.openChangedAt });
  const last = await lastCapNotice(DB);
  return { open: a.open, year: f.year, max: f.max, warnAt: f.warnAt, received: f.received, full: f.full, last: last && last.year === f.year ? last : null };
}

/** The applications waitlist (_application-waitlist.js): counts and times only, never addresses */
export async function waitlistFacts(DB) {
  // The tables appear with the first signup or heartbeat; until then this settles to an error
  const counts = await DB.prepare(`SELECT
      SUM(CASE WHEN opening_id IS NULL AND removed_at IS NULL AND (fallback = 1 OR kit_state IS NULL OR kit_state NOT IN ('cancelled', 'bounced', 'complained')) THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN opening_id IS NULL AND removed_at IS NULL AND kit_error IS NOT NULL THEN 1 ELSE 0 END) AS kitProblems,
      MAX(CASE WHEN removed_at IS NULL AND page != 'kit' THEN created_at END) AS lastSignupAt
    FROM waitlist_signups`).first();
  const op = await DB.prepare('SELECT state, total, sent_at, error, opened_at FROM waitlist_openings ORDER BY opened_at DESC LIMIT 1').first();
  const kit = await DB.prepare("SELECT value FROM waitlist_runtime WHERE key = 'kit_health'").first('value').then((v) => JSON.parse(v || 'null')).catch(() => null);
  return {
    kit: kit ? { ok: !!kit.ok, error: kit.error || null, at: kit.at || null } : null,
    waiting: counts?.waiting || 0,
    kitProblems: counts?.kitProblems || 0,
    lastSignupAt: counts?.lastSignupAt || null,
    opening: op ? { state: op.state, total: op.total || 0, sentAt: op.sent_at || null, openedAt: op.opened_at || null, error: op.error || null } : null,
  };
}

export async function onRequestGet(context) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    return Response.json({ success: true, ...(await gatherFacts(context.env)) }, { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message }, { status: 500, headers });
  }
}
