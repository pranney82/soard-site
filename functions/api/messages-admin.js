/**
 * /api/messages-admin (Cloudflare Access) — Site → Emails & invites
 * ==========================================================================
 * The admin's map of everything the site sends a person (public/admin/messages.js):
 * emails (from the site through Resend, to the list through Kit, or posted on
 * a family's JobTread account so JobTread emails it), reveal calendar invites,
 * texts and browser alerts.
 *
 *  GET                        → live facts: what's switched on, what's waiting, and for each
 *                               message when it last went and how many went in 30 days.
 *                               Times and counts only, never an address or a family's name.
 *  GET ?preview=<id>&lang=es  → that message as it goes out, filled in for a sample family
 *                               (the Stones), built by the same function that sends it. A staff
 *                               text also lists the alert numbers it may go to (last 4 digits).
 *  POST { send: <id>, lang }  → "Send it to me": the preview to the person signed in, with
 *                               [Preview] in the subject. An invite goes as a separate TEST
 *                               event on the office sandbox job, inviting only them.
 *  POST { send: <id>, to: i } → "Text it to me": a staff text preview to number i on the alert
 *                               list (never any other number), each text starting [Preview].
 *  GET ?activity=1[&before=&q=] → What went out: every message, newest first, with whether it
 *                               arrived; what's coming up; and whether mail can land (SPF, DKIM,
 *                               DMARC, bounce and spam rates). Names and addresses, for staff.
 *  GET ?email=<Resend id>     → one email exactly as it went, with every report Resend sent.
 *
 * Not in _middleware's public list, so Access guards it. Never cached. Each
 * fact fails on its own: one missing table never blanks the rest.
 */

import { waitlistFacts, applicationLimitFacts } from './automations-admin.js';
import { capEmail } from './_application-cap.js';
import * as notify from './_broadcast-notify.js';
import { COMMENT_NAMES, COMMENT_NAMES_ES, familyMessage } from './_applicant-comms.js';
import { summaryEmail, pauseEndedEmail, pauseState, previewSnippet, WHERE_IT_STANDS } from './_applicant-notify.js';
import { staffEmail, reminderEmail as applicationReminder, stuckEmail } from './_applications.js';
import { getLiveForm, formFor } from './_application-forms.js';
import { resolveForm, renderMessage, DEFAULT_MESSAGES } from './_application-form.js';
import { openingEmail, confirmationEmail, previewOpening, staffNoticeEmail, readAppSettings } from './_application-waitlist.js';
import { resumeLinkEmail } from './apply.js';
import {
  readConfig as readInviteConfig, planInvite, inviteAlert, sendTestInvite, fetchStaff,
  SANDBOX_JOB_ID, REVEAL_TASK_TYPE, FIELD_MAKEOVER_TYPE,
} from './_reveal-invites.js';
import { SOARD_ORG_ID, FIELD_REVEAL_CONFIRMED } from './_reveals.js';
import { deniedAlert } from './_kid-status.js';
import { zeffyAlertEmail } from './_zeffy.js';
import { alertHelloEmail } from './broadcast-admin.js';
import { readConfig } from './_broadcast.js';
import { goText } from './_broadcast-preflight.js';
import { ADMIN_URL as CONTROL_ROOM, SILENT, RESOLVED, greenDetail } from './_broadcast-monitor.js';
import { errorAlert } from './stream-webhook.js';
import { medicalNote, fallbackMedicalNote } from './_applicant-comms.js';
import { activity, comingUp, deliverability, deliveryFacts, emailDetail, invitesOut } from './_messages-activity.js';
import { applicantEmail as advisoryThanks, staffEmail as advisoryStaff } from './_advisory-applications.js';
import { checkAnswers as advisoryAnswers } from './_advisory-form.js';

const { SITE_ORIGIN, EMAIL_FROM } = notify;
const DAY = 864e5;
const TZ = 'America/New_York';
const has = (v) => (typeof v === 'string' ? v.trim().length > 0 : !!v);
const settle = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
const ok = (v) => (v && !v.error ? v : null);
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ─── The sample family every preview is filled in for ─────────────
export const SAMPLE = { parent: 'Jordan Stone', parentFirst: 'Jordan', child: 'Avery Stone', childFirst: 'Avery', address: '123 Sample Lane, Roswell, GA 30075' };
const KIT_FROM = 'Sunshine on a Ranney Day, through Kit (linzi@soardcharity.com)';
const JT_FROM = 'The Qualification Committee, through JobTread';

/** A date a week out (Eastern), and that day at 4 PM Eastern as an instant */
export function sampleReveal(now = Date.now()) {
  const date = new Date(now + 7 * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
  const at = ['20', '21'].map((h) => `${date}T${h}:00:00.000Z`)
    .find((iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric' }) === '4 PM') || `${date}T20:00:00.000Z`;
  return { date, at };
}

async function siteConfig(DB, key) {
  const row = await DB.prepare('SELECT data, updated_at FROM site_config WHERE key = ?').bind(key).first();
  return row ? { data: parse(row.data, {}) || {}, updatedAt: row.updated_at } : null;
}

// ─── Live facts ───────────────────────────────────────────────────

/** { last, n30, total } from rows of { at, n } (n defaults to 1 per row) */
// SQLite's datetime() stamps ("2026-09-21 15:30:02", the audit log's) are UTC; say so for browsers
const isoOf = (t) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? `${t.replace(' ', 'T')}Z` : t || null);
const tally = (last, n30, total) => ({ last: isoOf(last), n30: Number(n30) || 0, total: Number(total) || 0 });

async function familyFacts(DB, now) {
  const since = new Date(now - 30 * DAY).toISOString();
  const comms = {};
  const rows = (await DB.prepare(`SELECT kind, max(updated_at) AS last, sum(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS n30, count(*) AS total
    FROM applicant_comms WHERE state = 'sent' GROUP BY kind`).bind(since).all())?.results || [];
  for (const r of rows) comms[r.kind] = tally(r.last, r.n30, r.total);
  const activity = async (where, ...binds) => {
    const r = await DB.prepare(`SELECT max(at) AS last, sum(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS n30, count(*) AS total FROM applicant_activity WHERE ${where}`).bind(since, ...binds).first();
    return tally(r?.last, r?.n30, r?.total);
  };
  // Waiting to go (the wait or quiet hours), by kind; held ones are the pause's
  const waiting = {};
  const due = (await DB.prepare(`SELECT kind, count(*) AS n, min(due_at) AS next, sum(CASE WHEN hold IS NOT NULL THEN 1 ELSE 0 END) AS held
    FROM applicant_notify WHERE kind IS NOT NULL GROUP BY kind`).all().catch(() => null))?.results || [];
  for (const r of due) waiting[r.kind] = { n: r.n || 0, next: r.next ? new Date(r.next).toISOString() : null, held: r.held || 0 };
  const summaries = await DB.prepare(`SELECT max(summary_at) AS last, sum(CASE WHEN summary_at >= ? THEN 1 ELSE 0 END) AS n30, count(summary_at) AS total FROM applicant_notify`).bind(now - 30 * DAY).first().catch(() => null);
  return {
    comms,
    correction: await activity("kind = 'notify' AND title = 'Correction sent to the family'").catch(() => null),
    message: await activity("kind = 'sent'").catch(() => null),
    waiting,
    summaries: summaries ? tally(summaries.last ? new Date(summaries.last).toISOString() : null, summaries.n30, summaries.total) : null,
  };
}

async function formFacts(DB) {
  const live = await getLiveForm(DB);
  const form = resolveForm(live.definition, {});
  return {
    reminders: { enabled: form.reminders?.enabled !== false, days: form.reminders?.days || [] },
    notify: form.notify || null,
    staffEmails: (form.staffEmails || []).length,
  };
}

async function draftFacts(DB, now) {
  const r = await DB.prepare(`SELECT sum(COALESCE(link_sends, 0)) AS links, sum(COALESCE(reminders_sent, 0)) AS reminders,
      max(last_reminder_at) AS lastReminder, sum(CASE WHEN last_reminder_at >= ? THEN 1 ELSE 0 END) AS reminded30
    FROM application_drafts`).bind(new Date(now - 30 * DAY).toISOString()).first();
  return { links: Number(r?.links) || 0, reminders: tally(r?.lastReminder, r?.reminded30, r?.reminders) };
}

async function staffFacts(DB, now) {
  const since = new Date(now - 30 * DAY).toISOString();
  const app = await DB.prepare(`SELECT max(json_extract(jt_state, '$.staffEmail')) AS last,
      sum(CASE WHEN json_extract(jt_state, '$.staffEmail') >= ? THEN 1 ELSE 0 END) AS n30,
      count(json_extract(jt_state, '$.staffEmail')) AS total,
      sum(CASE WHEN alerted IS NOT NULL AND status = 'error' THEN 1 ELSE 0 END) AS stuck
    FROM applications WHERE COALESCE(is_test, 0) = 0`).bind(since).first().catch(() => null);
  const kids = parse(await DB.prepare("SELECT value FROM kid_status_state WHERE key = 'state'").first('value').catch(() => null), {}) || {};
  const hidden = Object.values(kids.alerted || {}).filter(Boolean).sort();
  const zeffy = (await siteConfig(DB, 'zeffy-alerts').catch(() => null))?.data || {};
  const gifts = Object.values(zeffy.alerted || {}).filter(Boolean).sort();
  return {
    newApplication: app ? tally(app.last, app.n30, app.total) : null,
    stuck: app ? Number(app.stuck) || 0 : null,
    kidHidden: tally(hidden[hidden.length - 1], hidden.filter((t) => t >= since).length, hidden.length),
    giftProblems: tally(gifts[gifts.length - 1], gifts.filter((t) => t >= since).length, gifts.length),
  };
}

async function inviteFacts(DB, now) {
  const since = new Date(now - 30 * DAY).toISOString();
  const cfg = await readInviteConfig(DB);
  const out = (await DB.prepare("SELECT state, count(*) AS n, sum(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) AS errors FROM reveal_invites GROUP BY state").all().catch(() => null))?.results || [];
  const log = async (where) => {
    const r = await DB.prepare(`SELECT max(created_at) AS last, sum(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS n30, count(*) AS total FROM reveal_invite_log WHERE ${where}`).bind(since).first();
    return tally(r?.last, r?.n30, r?.total);
  };
  const board = await DB.prepare('SELECT count(*) AS n FROM reveal_board_emails').first('n').catch(() => null);
  return {
    enabled: !!cfg.enabled,
    organizer: has(cfg.organizer),
    alertEmails: (cfg.alertEmails || []).length,
    out: Object.fromEntries(out.filter((r) => r.state).map((r) => [r.state, r.n || 0])),
    problems: out.reduce((n, r) => n + (r.errors || 0), 0),
    tentative: await log("action = 'created' AND state = 'tentative'").catch(() => null),
    confirmed: await log("state = 'confirmed' AND action IN ('created', 'updated')").catch(() => null),
    updated: await log("action = 'updated'").catch(() => null),
    boardEmails: typeof board === 'number' ? board : null,
  };
}

async function reminderFacts(DB, now) {
  const since = new Date(now - 30 * DAY).toISOString();
  const c = (await siteConfig(DB, 'broadcast-config'))?.data || {};
  const hours = c.reminders?.hoursBefore || [24, 1];
  const sends = {};
  const rows = (await DB.prepare(`SELECT kind, channel, max(CASE WHEN sent > 0 THEN created_at END) AS last,
      sum(CASE WHEN created_at >= ? THEN sent ELSE 0 END) AS n30, sum(sent) AS total, sum(failed) AS failed
    FROM broadcast_sends GROUP BY kind, channel`).bind(since).all().catch(() => null))?.results || [];
  for (const r of rows) (sends[r.kind] ||= {})[r.channel] = { ...tally(r.last, r.n30, r.total), failed: r.failed || 0 };
  const subs = {};
  const s = (await DB.prepare('SELECT channel, count(*) AS n FROM broadcast_reminders WHERE unsubscribed_at IS NULL GROUP BY channel').all().catch(() => null))?.results || [];
  for (const r of s) subs[r.channel] = r.n || 0;
  return {
    enabled: !!c.reminders?.enabled,
    push: !!c.reminders?.push,
    dayBefore: hours.includes(24),
    hourBefore: hours.includes(1),
    kitLive: c.kitLive?.enabled !== false,
    alertEmails: Array.isArray(c.alerts?.emails) ? c.alerts.emails.length : 0,
    alertPhones: Array.isArray(c.alerts?.phones) ? c.alerts.phones.length : 0,
    // Twilio's last delivery report per staff number: how many didn't arrive, and why (no numbers)
    textMisses: await textMisses(DB, c),
    vapid: !!c.vapid?.publicKey,
    sends,
    subscribers: subs,
  };
}

async function textMisses(DB, c) {
  const numbers = (await notify.readAlertTexts(DB)).numbers || {};
  const misses = notify.alertPhones(c).map((n) => numbers[n]).filter((r) => r && r.status !== 'delivered');
  return { count: misses.length, why: misses[0]?.error || null, at: misses[0]?.at || null };
}

async function newsletterFacts(DB, now) {
  const r = await DB.prepare(`SELECT max(created_at) AS last, sum(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS n30, count(*) AS total
    FROM audit_log WHERE entity_type = 'email-broadcast'`).bind(new Date(now - 30 * DAY).toISOString()).first();
  return { drafts: tally(r?.last, r?.n30, r?.total) };
}

async function bioFacts(DB) {
  const r = await DB.prepare(`SELECT count(*) AS total, sum(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      sum(CASE WHEN submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS answered, max(created_at) AS last FROM profile_requests`).first();
  return { total: r?.total || 0, open: r?.open || 0, answered: r?.answered || 0, last: r?.last || null };
}

export async function gatherFacts(env, { now = Date.now() } = {}) {
  const DB = env.DB;
  const [family, form, drafts, waitlist, invites, reminders, staff, newsletter, bios, pause, delivery] = await Promise.all([
    settle(() => familyFacts(DB, now)),
    settle(() => formFacts(DB)),
    settle(() => draftFacts(DB, now)),
    settle(() => waitlistFacts(DB)),
    settle(() => inviteFacts(DB, now)),
    settle(() => reminderFacts(DB, now)),
    settle(() => staffFacts(DB, now)),
    settle(() => newsletterFacts(DB, now)),
    settle(() => bioFacts(DB)),
    settle(() => pauseState(DB, now)),
    settle(() => deliveryFacts(env, { now })),
  ]);
  const confirmations = await settle(async () => {
    const r = await DB.prepare(`SELECT max(confirmed_at) AS last, sum(CASE WHEN confirmed_at >= ? THEN 1 ELSE 0 END) AS n30, count(confirmed_at) AS total FROM waitlist_signups`)
      .bind(new Date(now - 30 * DAY).toISOString()).first();
    return tally(r?.last, r?.n30, r?.total);
  });
  const p = ok(pause);
  // The application limit: set or not, where the season stands, the last notice (counts only)
  const applicationLimit = ok(await settle(() => applicationLimitFacts(DB, now)));
  return {
    checkedAt: new Date(now).toISOString(),
    applicationLimit,
    env: {
      resend: has(env.RESEND_API_KEY),
      kit: has(env.KIT_API_KEY),
      calendar: has(env.GOOGLE_CALENDAR_KEY),
      jobtread: has(env.JOBTREAD_QC_GRANT_KEY) || has(env.JOBTREAD_GRANT_KEY),
      twilio: notify.smsConfigured(env),
      slack: has(env.SLACK_BOT_TOKEN) || has(env.SLACK_WEBHOOK_URL),
      alertEnv: String(env.ALERT_EMAILS || '').split(',').filter((s) => s.trim()).length,
    },
    family: ok(family),
    form: ok(form),
    drafts: ok(drafts),
    waitlist: ok(waitlist) ? { ...waitlist, confirmations: ok(confirmations) } : null,
    invites: ok(invites),
    reminders: ok(reminders),
    staff: ok(staff),
    newsletter: ok(newsletter),
    bios: ok(bios),
    // Did the site's emails arrive: per message, 30 days, counts only (Resend's reports)
    delivery: ok(delivery),
    // Paused family emails: until when, and how many are held (never who)
    pause: p ? { active: !!p.active, until: p.until ? new Date(p.until).toISOString() : null, by: p.by ? String(p.by).split('@')[0] : null, held: (p.held || []).length } : null,
  };
}

// ─── Previews ─────────────────────────────────────────────────────
// Each returns { channel, from, to, subject, html?, text?, invite?, sms?, push?, also?, note?, send }.
// send: 'email' (Send it to me works), 'invite' (a TEST invite to you), or null.

const STATUS_KINDS = { 'app-welcome': 'welcome', 'app-in-review': 'inReview', 'app-approved': 'approved', 'app-denied': 'denied' };
const REMINDER_KINDS = { 'rem-scheduled': 'scheduled', 'rem-moved': 'moved', 'rem-day': 'day', 'rem-hour': 'hour', 'rem-live': 'live', 'rem-replay': 'replay' };
const sampleApplicationUrl = `${SITE_ORIGIN}/apply/form/?resume=sample`;

function sampleApplication(year, now) {
  return {
    id: 'app-sample-0000', year, lang: 'en', is_test: 0, submitted_at: new Date(now).toISOString(),
    answers: {
      childName: { first: SAMPLE.childFirst, last: 'Stone' }, parentName: { first: SAMPLE.parentFirst, last: 'Stone' }, parentEmail: 'jordan@example.com',
      birthdate: `${Number(year) - 9}-04-12`, makeoverTypes: ['Bedroom'], diagnosis: 'Cerebral palsy', county: 'Fulton', previouslyApplied: 'No',
    },
    jt_state: { area: { status: 'inside', edgeMiles: 4 } },
    files: { photo1: { key: 'sample' }, photo2: { key: 'sample' }, video: { key: 'sample' } },
  };
}

async function invitePreview(env, stage, now) {
  const cfg = await readInviteConfig(env.DB);
  const { date } = sampleReveal(now);
  const job = {
    id: 'sample', name: `${SAMPLE.childFirst} Stone`, organization: { id: SOARD_ORG_ID },
    tasks: { nodes: [{ id: 'task', taskType: { id: REVEAL_TASK_TYPE }, startDate: date, endDate: date, startTime: '16:00', endTime: '17:00', progress: 0 }] },
    customFieldValues: { nodes: [{ customField: { id: FIELD_MAKEOVER_TYPE }, value: 'Bedroom' }, ...(stage === 'confirmed' ? [{ customField: { id: FIELD_REVEAL_CONFIRMED }, value: 'Yes' }] : [])] },
    location: { address: SAMPLE.address },
    demoDone: { count: 1 },
  };
  // The organizer's name, as real invites sign it ("Questions? Email Clareece at …")
  const staff = env.JOBTREAD_GRANT_KEY ? await fetchStaff(env.JOBTREAD_GRANT_KEY).catch(() => []) : [];
  const plan = planInvite(job, staff, { organizer: cfg.organizer, now, template: cfg.template });
  if (plan.action !== 'upsert') throw new Error(`No sample invite: ${plan.reason}`);
  const e = plan.event;
  return {
    channel: 'invite',
    from: `${cfg.organizer}'s Google Calendar`,
    to: stage === 'confirmed' ? 'The family, staff, the board and advisors, plus vendors, sponsors, photographers and design partners' : 'The family, staff, and the board and advisors',
    subject: `Invitation: ${e.summary}`,
    invite: { title: e.summary, status: e.status, start: e.start, end: e.end, location: e.location || null, description: e.description, organizer: cfg.organizer, busy: e.transparency !== 'transparent' },
    send: 'invite',
  };
}

async function jobtreadPreview(env, kind, lang) {
  const message = await familyMessage(env, kind, { parent: SAMPLE.parent, child: SAMPLE.child, withCopy: kind === 'welcome', lang });
  return {
    channel: 'jobtread', from: JT_FROM, to: `${SAMPLE.parent} and everyone else on the family's account`,
    subject: (lang === 'es' && COMMENT_NAMES_ES[kind]) || COMMENT_NAMES[kind],
    text: message,
    note: kind === 'welcome' ? 'The family’s application PDF is attached. JobTread adds its own header and a reply button; replies land on the family’s page in Applicants.' : 'JobTread adds its own header and a reply button; replies land on the family’s page in Applicants.',
    send: null,
  };
}

const liveAlertSample = (now) => ({
  title: 'Scheduled reveal never went live',
  detail: `${SAMPLE.childFirst}'s room reveal was scheduled for ${notify.formatWhen(new Date(sampleReveal(now).at).toISOString(), TZ)} and no stream arrived. The countdown has been cleared.`,
  links: [{ label: 'Open the admin', url: `${SITE_ORIGIN}/admin/` }],
});

const TEXT_FROM = 'SOARD’s alert number, through Twilio';
const STAFF_TEXTS_TO = 'The staff numbers in Reveals → Settings → Alerts';
const STAFF_ALERTS_TO = 'The alert list in Reveals → Settings → Alerts, and Slack';
const ADVISORY_SAMPLE = {
  fullName: 'Jordan Stone', preferredName: 'Jordan', email: 'jordan@example.com', phone: '(770) 555-0142', address: '123 Sample Lane\nRoswell, GA 30075',
  company: 'Sample Builders', jobTitle: 'Director of Partnerships', link: 'linkedin.com/in/sample',
  heardFrom: 'A friend on the board', why: 'I have watched what a room can do for a child.', connection: 'My nephew uses a wheelchair.',
  involved: 'Yes', involvedHow: 'Volunteered at the gala.', strengths: 'Corporate partnerships and event planning.', fundraising: 'An employer match.',
  introductions: 'Yes', networks: 'Maybe', networksMore: 'A local builders association.', conflict: 'No', hostEvent: 'Maybe', meetings: 'Yes', ambassador: 'Yes',
  meetingTimes: 'Weekday evenings', hopeToGain: 'Purpose and friendships.', anythingElse: '',
  refName: 'Sam Lee', refRelationship: 'Former manager', refEmail: 'sam@example.com', refPhone: '', acknowledge: true, signature: 'Jordan Stone',
};

/**
 * The staff texts for a sample reveal (Avery's, a week out at 4 PM), built by
 * the same functions the real ones use: 'good' is reveal day with a hiccup, in
 * the order they'd arrive; 'problems' is each text for a day that goes wrong.
 * → [{ when, text }]
 */
export function revealDayTexts(now, which) {
  const { at } = sampleReveal(now);
  const t0 = Date.parse(at);
  const clock = (min) => new Date(t0 + min * 60e3).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  const title = `${SAMPLE.childFirst}'s room reveal`;
  const state = { title, scheduledAt: at };
  const result = (items) => {
    const counts = items.reduce((c, i) => ({ ...c, [i.status]: c[i.status] + 1 }), { ok: 0, warn: 0, fail: 0, unknown: 0, off: 0 });
    return { items, counts, ready: counts.fail === 0 };
  };
  const checks = ['Stream is ready', 'The live input is on', 'Mic check passed', 'Facebook output', 'Facebook token', 'YouTube output', 'The live hub', 'Slack alerts', 'The kid page'].map((label) => ({ status: 'ok', label }));
  if (which === 'good') {
    return [
      { when: `${clock(-60)} · the check an hour before`, text: goText(result(checks), state, { timezone: TZ }) },
      { when: `${clock(-1)} · the phone starts streaming`, text: notify.liveNowText({ title, url: `${SITE_ORIGIN}/live/` }) },
      { when: `${clock(0)} · a minute in, everything checks out`, text: notify.alertText({ title: `All green: ${title}`, detail: greenDetail(['the site', 'Facebook', 'YouTube']), url: CONTROL_ROOM, icon: '🟢' }) },
      { when: `${clock(12)} · the mic cuts out`, text: notify.alertText({ ...SILENT, url: CONTROL_ROOM, tone: 'alert' }) },
      { when: `${clock(13)} · sound is back`, text: notify.alertText({ title: RESOLVED.silent, detail: 'It lasted 1:05.', url: CONTROL_ROOM, tone: 'fixed' }) },
    ];
  }
  const notReady = [...checks.slice(0, 1), { status: 'fail', label: 'No live input for the phone', fix: 'Settings → Phones → Create the live input, then scan its code with the phone.' }, ...checks.slice(2)];
  return [
    { when: 'Reveal morning · the health check finds a problem', text: notify.alertText({ title: 'Reveal-day check found problems', detail: '• Facebook token failed: the session has expired', url: `${SITE_ORIGIN}/admin/`, tone: 'alert' }) },
    { when: `${clock(-60)} · the check an hour before fails`, text: goText(result(notReady), state, { timezone: TZ }) },
    { when: 'While live · Stream refuses the phone’s settings', text: errorAlert('live', { error: { code: 'ERR_GOP_OUT_OF_RANGE' } }).text },
    { when: 'While live · Facebook never shows it', text: notify.alertText({ title: 'Facebook isn\'t showing the reveal (post not live)', fix: 'Open Live Producer. The preview should show the feed; press Go Live.', url: CONTROL_ROOM, tone: 'alert', icon: '⚠️' }) },
    { when: `${clock(240)} · it never went live`, text: notify.alertText({ title: 'Scheduled reveal never went live', detail: `${title} was scheduled for ${notify.formatWhen(at, TZ)} and no stream arrived. The countdown has been cleared.`, url: `${SITE_ORIGIN}/admin/`, tone: 'alert', icon: '⏰' }) },
  ];
}

export async function buildPreview(env, id, { lang = 'en', me = '', now = Date.now() } = {}) {
  lang = lang === 'es' ? 'es' : 'en';
  const { at: scheduledAt } = sampleReveal(now);
  const live = `${SITE_ORIGIN}/live/`;
  const email = (m, extra = {}) => ({ channel: 'email', from: EMAIL_FROM, subject: m.subject, html: m.html, text: m.text, send: 'email', ...extra });
  if (STATUS_KINDS[id]) return jobtreadPreview(env, STATUS_KINDS[id], lang);
  if (REMINDER_KINDS[id]) {
    const kind = REMINDER_KINDS[id];
    const args = { kind, kidName: SAMPLE.childFirst, scheduledAt, liveUrl: live, replayUrl: live, unsubscribeUrl: '#', tz: TZ };
    return email(notify.reminderEmail(args), {
      to: 'Everyone who asked for reveal reminders on the website',
      push: notify.reminderPush(args),
    });
  }
  switch (id) {
    case 'app-correction': {
      const form = resolveForm((await getLiveForm(env.DB)).definition, { lang });
      return {
        channel: 'jobtread', from: JT_FROM, to: `${SAMPLE.parent} and everyone else on the family's account`,
        subject: lang === 'es' ? 'Una actualización sobre su solicitud' : 'An update on your application',
        text: renderMessage(form.messages?.correction || DEFAULT_MESSAGES.correction, { parent: SAMPLE.parent, child: SAMPLE.child, status: WHERE_IT_STANDS[lang]['In Review'] }),
        note: 'Staff can edit it on the family’s page before it goes. This sample is for a family whose application is really In Review.',
        send: null,
      };
    }
    case 'app-resume':
      return email(resumeLinkEmail({ year: (await readAppSettings(env.DB, now)).year, first: SAMPLE.parentFirst, link: sampleApplicationUrl, lang }), { to: 'The family, at the address they type on the form' });
    case 'app-reminder': {
      const year = (await readAppSettings(env.DB, now)).year;
      const form = await formFor(env.DB, { year, lang });
      const draft = { lang, answers: { parentName: { first: SAMPLE.parentFirst }, childName: { first: SAMPLE.childFirst } } };
      return email(applicationReminder({ form, draft, link: sampleApplicationUrl, stopLink: '#', percent: 60 }), { to: 'Families who started an application and stopped' });
    }
    case 'waitlist-confirm':
      return email(confirmationEmail({ lang }), { to: 'A family who asks to hear when applications open' });
    case 'waitlist-open': {
      const m = await previewOpening(env, { lang, now });
      return { channel: 'kit', from: KIT_FROM, to: 'Every family on the waitlist', subject: m.subject, html: m.html, send: 'email' };
    }
    case 'invite-tentative':
    case 'board-invites':
      return invitePreview(env, 'tentative', now);
    case 'invite-confirmed':
    case 'invite-update':
      return invitePreview(env, 'confirmed', now);
    case 'rem-confirm':
      return email(notify.confirmEmail({ confirmUrl: '#', kidName: SAMPLE.childFirst }), { to: 'A new address signed up on a reveal page' });
    case 'kit-live': {
      const m = notify.reminderEmail({ kind: 'live', kidName: SAMPLE.childFirst, scheduledAt, liveUrl: live, unsubscribeUrl: '#', tz: TZ, list: true });
      return { channel: 'kit', from: KIT_FROM, to: 'The whole newsletter list (not waitlist-only families)', subject: m.subject, html: m.html, text: m.text, send: 'email' };
    }
    case 'kit-drafts': {
      const m = notify.reminderEmail({ kind: 'scheduled', kidName: SAMPLE.childFirst, scheduledAt, liveUrl: live, unsubscribeUrl: '#', tz: TZ, list: true });
      return { channel: 'kit', from: KIT_FROM, to: 'Nobody until staff send it from Kit', subject: m.subject, html: m.html, text: m.text, note: 'This is the “Save the date” draft. “New date” and “Watch the replay” drafts follow the same design.', send: 'email' };
    }
    case 'staff-new-app': {
      const year = (await readAppSettings(env.DB, now)).year;
      return email(staffEmail(sampleApplication(year, now), 'sample'), { to: 'The staff list in Applications → Settings' });
    }
    case 'staff-stuck':
      return email(stuckEmail(sampleApplication('2027', now), { attempts: 4, error: 'JobTread returned 503' }), { to: 'peter@soardcharity.com' });
    case 'staff-summary': {
      const row = { account_id: 'sample', name: SAMPLE.child, previous: 'In Review', status: 'Approved', due_at: now + 30 * 60e3, token: 'sample', kind: 'approved' };
      const message = await familyMessage(env, 'approved', { parent: SAMPLE.parent, child: SAMPLE.child, lang: 'en' });
      const previews = { sample: { to: SAMPLE.parent, title: COMMENT_NAMES.approved, snippet: previewSnippet(message), lang: 'en' } };
      const form = ok(await settle(() => formFacts(env.DB)));
      return email(summaryEmail([row], { now, previews, quiet: form?.notify?.quiet }), { to: 'Whoever changed the status in JobTread' });
    }
    case 'staff-app-limit': {
      const year = (await readAppSettings(env.DB, now)).year;
      const f = { year, max: 120, warnAt: 96, received: 98, left: 22, filling: 14, perDay: 6, fillsInDays: 3.7, full: false, percent: 82 };
      return email(capEmail('warn', f), {
        to: 'The staff list in Applications → Settings',
        note: 'This is the heads-up near the limit. When the season fills, the same email says applications closed by themselves and what new families now read. The same words post in Slack.',
      });
    }
    case 'staff-pause-ended':
      return email(pauseEndedEmail([{ name: SAMPLE.child, status: 'Approved' }, { name: 'Riley Park', status: 'Denied' }]), { to: 'Whoever paused family emails' });
    case 'staff-waitlist': {
      const at = new Date(now + 10 * 60e3).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
      const year = (await readAppSettings(env.DB, now)).year;
      return email(staffNoticeEmail({
        title: `Applications are open: the waitlist email goes out at ${at}`,
        detail: `14 families asked to hear when ${year} applications open (12 in English, 2 in Spanish). They get the email at ${at}. Turned it on by mistake? Turn applications off before then, or press "Don't send this time" in the admin, and nobody is emailed.`,
      }), { to: 'The staff list in Applications → Settings' });
    }
    case 'staff-live-alert': {
      const a = liveAlertSample(now);
      return email(notify.alertEmail(a), { to: 'The alert list in Reveals → Settings → Alerts', sms: notify.alertText({ ...a, url: a.links[0].url, tone: 'alert', icon: '⏰' }) });
    }
    case 'staff-alert-hello-text':
      return { channel: 'text', from: TEXT_FROM, to: 'A new number on the alert list', sms: notify.alertHelloText({ by: me ? me.split('@')[0].replace(/^\w/, (c) => c.toUpperCase()) : 'Someone on the staff' }), contact: env.TWILIO_FROM ? 'SOARD Reveal Alerts' : null, send: 'text' };
    case 'staff-reveal-texts':
      return { channel: 'text', from: TEXT_FROM, to: STAFF_TEXTS_TO, sms: revealDayTexts(now, 'good'), send: 'text' };
    case 'staff-problem-texts':
      return { channel: 'text', from: TEXT_FROM, to: STAFF_TEXTS_TO, sms: revealDayTexts(now, 'problems'), send: 'text' };
    case 'staff-alert-hello':
      return email(alertHelloEmail(me || 'Someone on the staff'), { to: 'A new address on the alert list' });
    case 'staff-good-news': {
      const title = `${SAMPLE.childFirst}'s room reveal`;
      return email(notify.alertEmail({ title: `Live now: ${title}`, detail: 'The site, Facebook and YouTube are all showing it.', links: [{ label: 'Watch it', url: live }, { label: 'Open the control room', url: CONTROL_ROOM }] }), {
        to: STAFF_ALERTS_TO, sms: notify.liveNowText({ title, url: live }),
        note: 'Also: “Go” from the check an hour before, “All green” about a minute in, and “Ended” with how long it ran and how the sound held up.',
      });
    }
    case 'staff-countdown':
      return email(notify.alertEmail({
        title: `Countdown is up: ${SAMPLE.child}'s reveal`,
        detail: `${notify.formatWhen(scheduledAt, TZ)}. It's confirmed in JobTread, so the site put up the countdown and reminder signup. Reminders go out the day before and an hour before.`,
        links: [{ label: 'Live page', url: `${SITE_ORIGIN}/live/` }],
      }), { to: STAFF_ALERTS_TO, note: 'The same kind of note says when a reveal moves, when the countdown comes down, when it can’t follow JobTread, and when a confirmed reveal can’t have a countdown yet (and why).' });
    case 'staff-kit-live':
      return email(notify.alertEmail({ title: 'Kit "we\'re live" email did not send', detail: 'Kit answered 500. Use "Email the list now" in Admin → Broadcast to retry.', links: [{ label: 'Open the admin', url: `${SITE_ORIGIN}/admin/` }] }), {
        to: STAFF_ALERTS_TO, note: 'Also when Kit’s email is held: the stream went live more than 30 minutes early, the site can’t tell which kid it is, or it’s too late to send.',
      });
    case 'staff-replay':
      return email(notify.alertEmail({ title: `Instagram Reel posted: ${SAMPLE.childFirst}'s room reveal`, detail: 'Cut 2:10 to 2:55 of the recording (picked by sound).', links: [{ label: 'See the Reel', url: 'https://www.instagram.com/' }] }), {
        to: STAFF_ALERTS_TO, note: 'Also when the Reel needs setup or fails, and when a reveal’s replay is saved but can’t go on a kid page by itself.',
      });
    case 'staff-text-missed':
      return email(notify.alertEmail({ title: 'A staff text didn’t arrive: (678) 555-0123', detail: 'Twilio says the phone is switched off or out of range.', fix: 'Check the number in Reveals → Settings → Alerts, and the text in Twilio’s message log.', links: [{ label: 'Open Reveals → Settings', url: `${SITE_ORIGIN}/admin/#broadcast/settings` }] }), {
        to: STAFF_ALERTS_TO, note: 'Never by text: texting is what failed. Once a day per number at most.',
      });
    case 'staff-email-lost':
      return email(notify.alertEmail({ title: 'An email didn’t reach jordan@exmaple.com', detail: '“Your SOARD application: pick up where you left off”. The address doesn’t exist (the mail server said no such mailbox).', fix: 'The family typed this address on the application. Their answers are saved; reach them another way for a working address.', links: [{ label: 'What went out', url: `${SITE_ORIGIN}/admin/#messages/sent` }] }), {
        to: STAFF_ALERTS_TO, note: 'A staff address that bounces says which list to fix instead. A reveal-reminder address that bounces or reports spam is simply unsubscribed, with no email. Once a week per address at most.',
      });
    case 'advisory-thanks':
    case 'advisory-staff': {
      // A made-up applicant, through the form's own rules
      const app = { id: 'adv-sample-0001', answers: advisoryAnswers(ADVISORY_SAMPLE).answers };
      return id === 'advisory-thanks'
        ? email(advisoryThanks(app), { to: 'The applicant, at the address they typed' })
        : email(advisoryStaff(app), { to: 'The list in People → Applications → “Who hears about them”', note: 'The Slack card says the same, without their email, phone or address.' });
    }
    case 'staff-medical': {
      const diagnosis = 'Cerebral palsy';
      const note = await medicalNote(env, diagnosis).catch(() => null);
      return {
        channel: 'jobtread', from: JT_FROM, to: 'Staff, on the family’s JobTread page. The family never sees it.',
        subject: COMMENT_NAMES.medical, text: note || fallbackMedicalNote(diagnosis, 'the writer isn’t reachable from here'),
        note: 'Workers AI writes it from the diagnosis the family typed (here, “Cerebral palsy”). When it can’t, the family’s own words go up with a note to look the condition up.',
        send: null,
      };
    }
    case 'staff-invite-problem':
      return email(inviteAlert('problem', { jobId: 'sample', name: SAMPLE.childFirst, error: 'Google Calendar returned 503 (backend error)', taskId: null }), { to: 'The invite alert list, the organizer, and peter@soardcharity.com' });
    case 'staff-invite-held':
      return email(inviteAlert('held', { jobId: 'sample', name: SAMPLE.childFirst, reason: 'status is Awaiting Funding', taskId: null }), { to: 'The invite alert list, the organizer, and peter@soardcharity.com' });
    case 'staff-kid-hidden':
      return email(deniedAlert({ kid: { name: SAMPLE.childFirst }, jobId: 'sample' }), { to: 'peter@soardcharity.com' });
    case 'staff-gift-problem':
      return email(zeffyAlertEmail({
        title: 'Gifts aren’t reaching Slack',
        detail: 'Slack refused the post for a Zeffy gift: channel_not_found. The website keeps trying for 3 days.',
        fix: 'Check the site’s Slack app: SLACK_BOT_TOKEN in Cloudflare is current, the app is still installed, and #team-everyone is a public channel (or the app is in it).',
      }), { to: 'peter@soardcharity.com' });
    default:
      return null;
  }
}

// ─── Handlers ─────────────────────────────────────────────────────

const HEADERS = { 'Cache-Control': 'private, no-store' };
// 500, not 502: Cloudflare replaces 502 bodies with its own error page
const fail = (error, status = 400) => Response.json({ success: false, error }, { status, headers: HEADERS });

export async function onRequestGet(context) {
  const { env } = context;
  const q = new URL(context.request.url).searchParams;
  try {
    if (q.has('preview')) {
      const p = await buildPreview(env, q.get('preview'), { lang: q.get('lang'), me: context.data?.userEmail || '' });
      if (!p) return fail('There’s no preview for that message', 404);
      // A text preview goes only to a number already on the alert list: its last four digits to pick from
      const textTo = p.send === 'text' ? notify.alertPhones(await readConfig(env.DB)).map((n, i) => ({ i, last4: n.slice(-4) })) : undefined;
      return Response.json({ success: true, id: q.get('preview'), ...p, textTo, texting: p.send === 'text' ? notify.smsConfigured(env) : undefined }, { headers: HEADERS });
    }
    if (q.has('activity')) {
      const now = Date.now();
      const before = q.get('before');
      const [log, coming, delivery, invites] = await Promise.all([
        activity(env, { before: before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : null, q: q.get('q') || '', now }),
        before ? null : settle(() => comingUp(env, { now })),
        before ? null : settle(() => deliveryFacts(env, { now })),
        before ? null : settle(() => invitesOut(env, { now })),
      ]);
      const health = before ? null : await settle(() => deliverability(env, { now, rates: ok(delivery)?.all || null }));
      return Response.json({ success: true, checkedAt: new Date(now).toISOString(), ...log, coming: ok(coming) || (coming ? [] : undefined), tracking: ok(delivery)?.tracking, health: ok(health), invites: Array.isArray(invites) ? invites : undefined }, { headers: HEADERS });
    }
    if (q.has('email')) {
      const d = await emailDetail(env, q.get('email'));
      if (!d) return fail('That email isn’t in the log', 404);
      return Response.json({ success: true, ...d }, { headers: HEADERS });
    }
    return Response.json({ success: true, ...(await gatherFacts(env)) }, { headers: HEADERS });
  } catch (err) {
    return fail(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  const me = String(context.data?.userEmail || '').trim();
  if (!notify.isEmail(me)) return fail('Could not tell who you are from Access', 403);
  let body = {};
  try { body = await context.request.json(); } catch { return fail('Send JSON'); }
  const id = String(body.send || '');
  try {
    const p = await buildPreview(env, id, { lang: body.lang, me });
    if (!p) return fail('There’s no preview for that message', 404);
    if (p.send === 'invite') {
      if (!env.GOOGLE_CALENDAR_KEY || !env.JOBTREAD_GRANT_KEY) return fail('Calendar invites aren’t set up (GOOGLE_CALENDAR_KEY and JOBTREAD_GRANT_KEY in Cloudflare)', 503);
      const stage = id === 'invite-tentative' || id === 'board-invites' ? 'tentative' : 'confirmed';
      const r = await sendTestInvite(env, SANDBOX_JOB_ID, me, { date: sampleReveal().date, time: '16:00', stage });
      if (r.action === 'skip') return fail(`The test invite couldn’t be made: ${r.reason}`, 409);
      return Response.json({ success: true, sentTo: me, kind: 'invite', stage }, { headers: HEADERS });
    }
    if (p.send === 'text') {
      // Only to a number on the alert list (its owner agreed to these texts), one text at a time so they arrive in order
      if (!notify.smsConfigured(env)) return fail('Texting isn’t set up (the Twilio keys in Cloudflare)', 503);
      const to = notify.alertPhones(await readConfig(env.DB))[Number(body.to)];
      if (!to || !Number.isInteger(Number(body.to))) return fail('Pick a number on the alert list (Reveals → Settings → Alerts)', 400);
      const texts = Array.isArray(p.sms) ? p.sms.map((x) => x.text) : [p.sms];
      let sent = 0;
      const errors = [];
      for (const [i, t] of texts.entries()) {
        // The hello text carries the contact card, as it does for real
        const mediaUrl = p.contact && i === texts.length - 1 ? notify.ALERT_CONTACT_URL : null;
        const r = await notify.sendSms(env, { to: [to], body: `[Preview] ${t}`, mediaUrl });
        sent += r.sent;
        errors.push(...r.errors);
      }
      if (!sent) return fail(`The text didn’t go: ${errors[0] || 'Twilio refused it'}`, 500);
      return Response.json({ success: true, sentTo: `the number ending ${to.slice(-4)}`, kind: 'text', count: sent, failed: texts.length - sent, error: errors[0] || null }, { headers: HEADERS });
    }
    if (p.send !== 'email') return fail('This one can’t be sent as a preview', 400);
    if (!notify.emailConfigured(env)) return fail('Email sending isn’t set up (RESEND_API_KEY in Cloudflare)', 503);
    const r = await notify.sendEmails(env, {
      to: [me],
      subject: `[Preview] ${p.subject}`,
      html: p.html,
      text: p.text || undefined,
      tags: [{ name: 'type', value: 'admin-preview' }],
    });
    if (!r.sent) return fail(`The email didn’t go: ${(r.errors || []).join('; ') || 'Resend refused it'}`, 500);
    return Response.json({ success: true, sentTo: me, kind: 'email' }, { headers: HEADERS });
  } catch (err) {
    return fail(err.message, 500);
  }
}
