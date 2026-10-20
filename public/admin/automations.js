/**
 * Automations map (admin)
 * =======================
 * Loaded on demand by Site → Automations. A mindmap of everything that runs
 * on its own or connects SOARD to another service: what starts it, what it
 * does, which services it touches, and where it lives.
 *
 * Two layers:
 *  - MAP below is the curated description (what each thing is). Update it
 *    when an automation is added or retired, and bump WRITTEN_ON.
 *  - Each entry's live(f) reads /api/automations-admin (switches in
 *    Reveals settings, keys present in Cloudflare, JobTread workflows and
 *    webhooks, last-run times) and returns its real status right now:
 *    { s: 'live'|'off'|'attn', why, last }. Leave out s to keep the curated
 *    status and only add a note or a last-run time. Return null when the
 *    facts can't say. Entries without live() (DataX agents, embeds) show
 *    their curated status, marked as such.
 *
 * Status: live | test | off | attn. Trigger kinds: schedule | event |
 * visitor | admin | build | link.
 *
 * Drawn by hand (no chart library: the admin CSP allows no CDN). Branches
 * split left and right of the center; groups open and close in place and
 * the clicked node stays put on screen.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';

const html = htm.bind(h);

const WRITTEN_ON = 'October 20, 2026';
const FACTS_URL = '/api/automations-admin';

// ─── Live check helpers ───────────────────
const MIN = 60e3;
const HOUR = 60 * MIN;
const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? null : t; };
export function ago(iso, now = Date.now()) {
  const t = ms(iso);
  if (t == null) return '';
  const d = Math.max(0, now - t);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.round(d / MIN)} min ago`;
  if (d < 48 * HOUR) return `${Math.round(d / HOUR)} h ago`;
  return `${Math.round(d / (24 * HOUR))} days ago`;
}
const stamp = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const stale = (iso, maxMs) => { const t = ms(iso); return t == null || Date.now() - t > maxMs; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const ON = (why, last) => ({ s: 'live', why, last });
const OFF = (why, last) => ({ s: 'off', why, last });
const ATTN = (why, last) => ({ s: 'attn', why, last });

const SETTINGS = 'Reveals → Settings';
const env = (f) => f.env || null;
// A key in Cloudflare that this needs
const needsKey = (flag, missing, status = ATTN, onWhy) => (f) => (!env(f) ? null : f.env[flag] ? ON(onWhy) : status(missing));
const needsAi = (f) => (!f.bindings ? null : f.bindings.ai ? ON() : ATTN('Workers AI isn’t bound to the site.'));
// Slack: the site's Slack app posts to a channel picked by name and checked with Slack; a bare webhook can't say where it posts
const SLACK_OFF = `Not used yet: alerts go by email. Add the Slack app’s SLACK_BOT_TOKEN in Cloudflare, then pick the channel in ${SETTINGS} → Alerts.`;
const slackLive = (f) => {
  if (!env(f)) return null;
  const sl = f.slack;
  if (sl?.mode === 'bot') {
    if (sl.ok) return ON(`Posting to #${sl.channel}${sl.team ? ` in ${sl.team}` : ''}.`);
    return ATTN(sl.error === 'no_channel' ? `The Slack app is connected, but no channel is picked yet: ${SETTINGS} → Alerts.` : `Slack won’t take posts (${sl.error}). ${SETTINGS} → Alerts says how to fix it.`);
  }
  if (f.env.slack) return ON('Through the old incoming webhook, which can’t say which channel it posts to. Add the Slack app to name and check the channel.');
  return OFF(SLACK_OFF);
};
// A JobTread workflow, by id
const wf = (id) => (f) => {
  const jt = f.jobtread;
  if (!jt || jt.error || !jt.workflows) return null;
  const w = jt.workflows[id];
  if (!w) return ATTN('This workflow is gone from JobTread.');
  return w.active ? ON('Switched on in JobTread.') : OFF('Switched off in JobTread.');
};
// A JobTread webhook, by id: present keeps the curated status, gone means off
const hook = (id) => (f) => {
  const jt = f.jobtread;
  if (!jt || jt.error || !jt.webhooks) return null;
  return jt.webhooks[id] ? { why: 'Registered in JobTread.' } : OFF('No longer in JobTread.');
};
const reminderBlock = (f, channel) => {
  const b = f.broadcast;
  if (!b) return null;
  const subs = f.reminders?.subscribers;
  const signed = typeof subs === 'number' ? ` ${plural(subs, 'person has', 'people have')} signed up for reminders.` : '';
  if (!b.reminders.enabled) return OFF(`Reminders are switched off in ${SETTINGS}, so nobody gets them.${signed}`);
  if (channel === 'sms' && !b.reminders.sms) return OFF(`Texts are switched off in ${SETTINGS}.`);
  if (channel === 'push' && !b.reminders.push) return OFF(`Push is switched off in ${SETTINGS}.`);
  return null;
};
const lastSend = (f, channel) => {
  let last = null;
  for (const kind of Object.values(f.sends || {})) {
    const s = kind[channel];
    if (s?.last && (!last || s.last > last)) last = s.last;
  }
  return last;
};
const phoneEvent = (e) => (e ? e.replace('live_input.', '').replace(/_/g, ' ') : '');

const JT_INVITE_HOOK = 'JobTread workflow → POST /api/reveal-invites';

// ─── The map ──────────────────────────────
const MAP = { t: 'SOARD', children: [
  // ─── Right side ─────────────────────────
  { t: 'Reveals', sub: 'JobTread dates → calendar, website, staff', color: 'reveals', side: 'r',
    about: 'JobTread is the source of truth for reveal dates. A date counts as real only once Reveal Date Confirmed is Yes.',
    children: [
      { t: 'Date sync', children: [
        { t: 'Reveal date sync', s: 'live', k: 'event',
          when: 'A JobTread workflow reports each change to a Reveal task or the Reveal Date field (about 15 seconds end to end).',
          does: 'Keeps the Reveal task and the Reveal Date field in step, converting Eastern time to JobTread’s UTC. Not confirmed: the side that changed wins. Confirmed: the field wins and schedule shifts snap back with an internal comment.',
          touches: ['JobTread', 'D1'], where: 'functions/api/reveal-sync.js · _reveal-sync.js',
          info: 'The site’s own edits don’t wake the workflows again, and an echo that slips through is recognized and ignored, so a person’s quick second edit still counts. Edits made through DataX don’t sync, so fixes made there must set both the task and the field.',
          live: (f) => {
            const a = wf('22PgHVceQhvW')(f);
            const b = wf('22PgHVcgDXFN')(f);
            if (!a || !b) return null;
            if (a.s !== 'live' || b.s !== 'live') return ATTN('A JobTread workflow that feeds it is off or missing, so some date changes won’t sync.');
            const c = f.revealChecks;
            return ON(c?.syncedAt ? `Both JobTread workflows are on. Last synced a date ${ago(c.syncedAt)}.` : 'Both JobTread workflows are on.', c?.syncedAt || null);
          } },
        { t: 'Reveal task changed → sync', s: 'live', k: 'event',
          when: 'A Reveal task’s date or time changes (by anyone but the site itself).',
          does: 'Sends the task’s new date to the reveal date sync.',
          touches: ['JobTread'], where: 'JobTread workflow “Reveal task → Site reveal date sync”', live: wf('22PgHVceQhvW') },
        { t: 'Reveal Date field changed → sync', s: 'live', k: 'event',
          when: 'The Reveal Date field on a job changes (by anyone but the site itself).',
          does: 'Sends the new field value to the reveal date sync.',
          touches: ['JobTread'], where: 'JobTread workflow “Reveal Date field → Site reveal date sync”', live: wf('22PgHVcgDXFN') },
        { t: 'Reveal checks for PMs', s: 'off', k: 'schedule',
          when: 'Weekdays at 8 am Eastern, on the live hub’s heartbeat (visits to the reveals feed and admin loads are the backup).',
          does: 'Leaves one internal comment for the project manager on any job whose reveal needs attention: unconfirmed inside two weeks, confirmed without a time, date passed, work scheduled after the reveal, or the Reveal Date and the schedule disagree. The same problem is repeated every 3 days at most. Also puts back a date the sync missed when the answer is clear.',
          touches: ['JobTread', 'D1'], where: 'functions/api/broadcast-hooks.js → _reveal-nudges.js',
          info: 'Families never see these comments. Preview them in Reveals → Invites before switching on.',
          live: (f) => {
            const c = f.revealChecks;
            if (!c) return null;
            if (!c.enabled) return OFF('Switched off in Reveals → Invites.', c.lastRunAt);
            if (c.lastErrorAt && (!c.lastRunAt || c.lastErrorAt > c.lastRunAt)) return ATTN(`The last attempt failed (${stamp(c.lastErrorAt)}). It retries on its own every half hour.`, c.lastRunAt);
            if (!c.lastRunAt) return ON('Switched on. The first run is the next weekday at 8 am.');
            if (stale(c.lastRunAt, 4 * 24 * HOUR)) return ATTN(`Hasn’t run since ${stamp(c.lastRunAt)}.`, c.lastRunAt);
            return ON(`Checked ${plural(c.checked ?? 0, 'job')}, posted ${plural(c.posted ?? 0, 'comment')}${c.repaired ? `, put ${plural(c.repaired, 'date')} back in sync` : ''}${c.errors ? `, ${c.errors} failed` : ''}.`, c.lastRunAt);
          } },
      ]},
      { t: 'Calendar invites', children: [
        { t: 'Invite engine', s: 'live', k: 'event',
          when: 'Woken by the four JobTread workflows below and the 5-minute new guest check; it re-reads the job itself.',
          does: 'Construction started (Demo, or two tasks under Construction, done) → a tentative all-day invite, shown as free. Reveal moved → the same invite updates. Confirmed → a timed “Reveal Day” invite. Guests are emailed only when the date, time, address, notes or guest list change, never for wording alone. Nothing in JobTread cancels an invite: a reveal is called off by deleting its event in Google Calendar, and the site then leaves it alone for good (Retry in the admin sends it again). A job closed, denied or awaiting funding, or a Reveal task with no date, keeps its invite and staff get one heads-up email. Tentative guests are Admin and Designer staff, the family (the job’s customer contacts and Makeover Family users with access to the job) the board and the Advisory Board (website members of either with a private reveal email, plus any Board Member users in JobTread). Confirming adds the vendors, sponsors, photographers and design partners with access to that job in JobTread; un-confirming takes them off. Both invites carry the link to watch the reveal live. Board and Advisory Board changes on the website update open invites right away. Once a reveal has happened (its start time has passed or its Reveal task is complete), its invite is never touched again, so closing the job afterwards sends nothing.',
          touches: ['JobTread', 'Google Calendar'], where: 'functions/api/reveal-invites.js · _reveal-invites.js · _google-calendar.js',
          info: 'Invites come from Clareece’s Google Calendar through a service account. The office job is a live sandbox: its invites go only to Peter and are titled TEST.',
          live: (f) => {
            const i = f.invites;
            if (!i) return null;
            if (env(f) && !f.env.calendar) return ATTN('GOOGLE_CALENDAR_KEY is missing in Cloudflare, so no invites can go out.');
            if (!i.enabled) return OFF('Sending is switched off in Reveals → Invites.');
            if (i.errors > 0) return ATTN(`The last sweep hit ${plural(i.errors, 'error')}. Open Reveals → Now to retry.`, i.lastSweepAt);
            return ON(`Sending is on. ${plural(i.rows ?? 0, 'reveal has', 'reveals have')} an invite.`, i.lastSweepAt);
          } },
        { t: 'Reveal task moved', s: 'live', k: 'event',
          when: 'A Reveal task’s date or time changes.',
          does: 'Wakes the invite engine for that job.', touches: ['JobTread'], where: JT_INVITE_HOOK, live: wf('22PgPECxg6UP') },
        { t: 'Task checked or un-checked', s: 'live', k: 'event',
          when: 'Any task’s progress changes (JobTread can’t tell the site which group a task is in, so the site counts Demo and Construction itself).',
          does: 'Wakes the invite engine, so construction starting sends the tentative invite. Skips the countdown check.', touches: ['JobTread'], where: JT_INVITE_HOOK, live: wf('22PgYwQvKkTs') },
        { t: 'Confirmed, notes or status changed', s: 'live', k: 'event',
          when: 'Reveal Date Confirmed, Reveal Invite Details, job status or closed date changes.',
          does: 'Wakes the invite engine for that job.', touches: ['JobTread'], where: JT_INVITE_HOOK, live: wf('22PgPED4vi7W') },
        { t: 'Reveal task deleted', s: 'live', k: 'event',
          when: 'A Reveal task is deleted.',
          does: 'Wakes the invite engine: the invite is kept and staff get a heads-up, in case the reveal is off.', touches: ['JobTread'], where: JT_INVITE_HOOK, live: wf('22PgQQ6JnJDm') },
        { t: 'Safety sweep', s: 'live', k: 'schedule',
          when: 'Every 6 hours, on the live hub’s heartbeat (visits to the reveals feed are the backup).',
          does: 'Reconciles every open job with Google Calendar, catching anything a missed workflow call left behind, and notices invites someone deleted by hand in Google Calendar.',
          touches: ['JobTread', 'Google Calendar', 'D1'], where: 'functions/api/broadcast-hooks.js · reveals.js → _reveal-invites.js',
          live: (f) => {
            const i = f.invites;
            if (!i) return null;
            if (!i.enabled) return OFF('Invite sending is switched off, so there’s nothing to sweep.');
            if (!i.lastSweepAt) return ATTN('It has never run.');
            if (stale(i.lastSweepAt, 24 * HOUR)) return ATTN(`Hasn’t run since ${stamp(i.lastSweepAt)}. It rides on the live hub’s heartbeat, so check the Live hub entry.`, i.lastSweepAt);
            return ON(`Checked ${plural(i.checked ?? 0, 'job')}, changed ${i.changed ?? 0}.`, i.lastSweepAt);
          } },
        { t: 'New guest check', s: 'live', k: 'schedule',
          when: 'Every 5 minutes, on the live hub’s heartbeat (visits to the reveals feed and admin loads are the backup).',
          does: 'JobTread has no workflow trigger for giving someone access to a job, so this re-reads every upcoming reveal whose invite is out. A vendor, sponsor, photographer or design partner added to a confirmed reveal’s job, or a new family contact email, gets the invite within minutes; someone taken off the job loses it. Invites that haven’t changed are left alone.',
          touches: ['JobTread', 'Google Calendar', 'D1'], where: 'functions/api/broadcast-hooks.js · reveals.js → _reveal-invites.js (maybeCheckGuests)',
          live: (f) => {
            const i = f.invites;
            if (!i) return null;
            if (!i.enabled) return OFF('Invite sending is switched off, so there’s nothing to check.');
            if (!i.lastGuestCheckAt) return ATTN('It has never run.');
            if (stale(i.lastGuestCheckAt, HOUR)) return ATTN(`Hasn’t run since ${stamp(i.lastGuestCheckAt)}. It rides on the live hub’s heartbeat, so check the Live hub entry.`, i.lastGuestCheckAt);
            return ON('Checking every 5 minutes.', i.lastGuestCheckAt);
          } },
        { t: 'Invite problem alerts', s: 'live', k: 'event',
          when: 'An invite fails to send, update or cancel.',
          does: 'Emails Peter and the organizer, and posts to Slack once Slack is connected.',
          touches: ['Resend', 'Slack'], where: 'functions/api/_reveal-invites.js',
          live: (f) => (!env(f) ? null : !f.env.resend ? ATTN('RESEND_API_KEY is missing, so problem alerts can’t be emailed.') : ON(f.env.slack ? 'By email and Slack.' : 'By email only: Slack isn’t connected.')) },
        { t: 'Reveals → Invites page', s: 'live', k: 'admin',
          when: 'Staff open Reveals → Invites.',
          does: 'Turn invites on or off, edit the invite wording, preview it and send a test. Turn the reveal checks on or off and preview today’s comments before they post. Retrying a failed invite is on Reveals → Now. Dates and notes are changed in JobTread.',
          touches: ['JobTread', 'Google Calendar'], where: 'functions/api/reveal-invites-admin.js' },
      ]},
      { t: 'On the website', children: [
        { t: 'Live countdown follows JobTread', s: 'live', k: 'event',
          when: 'A JobTread workflow reports a reveal change (right away), and every 5 minutes on the live hub’s heartbeat. Opening Reveals checks too.',
          does: 'Puts the countdown, reminder signup and starting-soon screen up for the next reveal confirmed with a time, moves it when the date or time changes, and takes it down when the reveal is unconfirmed. A new date re-arms the reminders and tells everyone who signed up. Nobody schedules reveals in the admin.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_broadcast-schedule.js (from broadcast-hooks.js, reveal-sync.js, reveal-invites.js, reveals.js)',
          info: 'Only published kids get a countdown, matched by the job name (“Max Sample (2026)”). A confirmed reveal with no time or no matching kid page shows as a note on Reveals → Now, and staff get one Slack/email alert about it once it’s within three weeks. When the job and kid page are filed under neighboring years, the note names the kid page to fix. Staff also hear each time the countdown goes up, moves or comes down. Once the start time passes, only a new time for the same reveal moves it; the stream decides the rest.',
          live: (f) => {
            const c = f.liveSchedule;
            if (!c) return null;
            if (!c.checkedAt) return ATTN('It hasn’t checked JobTread yet. It runs on the live hub’s heartbeat.');
            if (c.error) return ATTN(`The last JobTread check failed: ${c.error}`, c.checkedAt);
            if (stale(c.checkedAt, 30 * MIN)) return ATTN(`Hasn’t checked JobTread since ${stamp(c.checkedAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, c.checkedAt);
            if (c.waiting) return ATTN(`${plural(c.waiting, 'confirmed reveal')} can’t have a countdown yet (no time, or no published kid page). See Reveals → Now.`, c.checkedAt);
            return ON(c.next ? `Following ${c.next}.` : 'Nothing is confirmed with a time yet.', c.checkedAt);
          } },
        { t: 'Kid status follows JobTread', s: 'live', k: 'event',
          when: 'A JobTread workflow reports a job’s status, closed date or task change (right away), and an hourly sweep on the live hub’s heartbeat. Visits to the reveals feed are the backup.',
          does: 'Sets each kid page’s status from its job: Awaiting Funding shows “Needs funding”, Design through Build shows “In progress”, and the Reveal task done, Closed Done or Warranty shows “Completed”. On Site and Denied take the profile off the site (Denied tells staff once by email and Slack), and it comes back by itself when the job moves on. Each change is saved like an admin save, with History, then the site publishes, at most every 10 minutes.',
          touches: ['JobTread', 'D1', 'GitHub', 'Cloudflare Pages'], where: 'functions/api/_kid-status.js (from reveal-invites.js, broadcast-hooks.js, reveals.js)',
          info: 'Staff can’t change a linked kid’s status in the admin: Kids shows the JobTread status with a link to the job. Kids with no job in JobTread (older years) stay under the admin’s control, a profile staff hid themselves stays hidden, and jobs named TEST are ignored.',
          live: (f) => {
            const k = f.kidStatus;
            if (!k) return null;
            if (env(f) && !f.env.jobtread) return ATTN('JOBTREAD_GRANT_KEY is missing, so kid statuses can’t follow JobTread.');
            if (!k.lastSweepAt) return ATTN('It hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (k.lastErrorAt && (!k.lastRunAt || k.lastErrorAt > k.lastRunAt)) return ATTN(`The last check of JobTread failed (${stamp(k.lastErrorAt)}). It tries again within the hour.`, k.lastRunAt);
            if (stale(k.lastSweepAt, 3 * HOUR)) return ATTN(`Hasn’t checked JobTread since ${stamp(k.lastSweepAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, k.lastRunAt);
            if (env(f) && !f.env.deployHook) return ATTN('No deploy hook is set in Cloudflare, so changes are saved but wait for the next Publish.', k.lastRunAt);
            const hidden = k.hidden ? ` ${plural(k.hidden, 'profile is', 'profiles are')} hidden because of JobTread.` : '';
            return ON(`${k.changed ? `The last check changed ${plural(k.changed, 'kid')}.` : 'Every linked kid matches JobTread.'}${hidden}`, k.lastRunAt);
          } },
        { t: 'Reveals → Now tracker', s: 'live', k: 'admin',
          when: 'Staff open Reveals → Now.',
          does: 'Lists every upcoming reveal from JobTread with what has gone out for it: the tentative and confirmed invites, the countdown, save-the-date, day-before and hour-before reminders, and the “we’re live” emails, each with when and how many. A failed invite can be retried there.',
          touches: ['JobTread', 'D1'], where: 'functions/api/reveal-invites-admin.js' },
        { t: 'Public reveal feed', s: 'live', k: 'visitor',
          when: 'Any page that shows reveal dates asks for them (cached at the edge for 3 minutes).',
          does: 'Reads confirmed reveals straight from JobTread and matches them to kids by year and name. Kid pages switch “Building” to “Reveal Oct 27” and link to the live page; the events page shows “Watch a Room Reveal Live”. Never shows tentative dates or job names.',
          touches: ['JobTread', 'D1'], where: 'functions/api/reveals.js · _reveals.js',
          info: 'If JobTread is unreachable it serves the last good copy from D1.',
          live: (f) => (!env(f) ? null : !f.env.jobtread ? ATTN('JOBTREAD_GRANT_KEY is missing, so the site can only show its last saved copy.') : ON('Last good read from JobTread:', f.reveals?.cachedAt)) },
        { t: 'Dashboard reveal dates', s: 'live', k: 'admin',
          when: 'Staff open the Dashboard.',
          does: 'Shows tentative and confirmed dates. A tentative reveal inside 14 days becomes a “Needs you” item linking to the JobTread job.',
          touches: ['JobTread'], where: 'functions/api/reveals-admin.js',
          live: needsKey('jobtread', 'JOBTREAD_GRANT_KEY is missing, so the Dashboard can’t show reveal dates.') },
      ]},
    ]},

  { t: 'Applications', sub: 'Families apply on the site → JobTread', color: 'apply', side: 'r',
    about: 'The makeover application lives on the site (it replaced Jotform and the Zapier Zaps in October 2026). Each submission becomes a JobTread customer account with nothing done by hand; staff review in JobTread.',
    children: [
      { t: 'The form', children: [
        { t: 'Makeover application', s: 'live', k: 'visitor',
          when: 'A family fills in /apply/form/ (open or closed per Site Config → Settings → Makeover Application; a saved application can always be finished).',
          does: 'Walks them through the questions page by page, saves as they go, resizes and stores photos, uploads the video straight to Cloudflare Stream, shows a review page, then submits.',
          touches: ['D1', 'R2', 'Cloudflare Stream'], where: 'src/pages/apply/form.astro · functions/api/apply.js · _application-form.js',
          info: 'The form is data, edited in Admin → Applications → Form; each application keeps the version it was answered on. The page gets the live version embedded by functions/apply/form/[[path]].js.',
          live: (f) => (!env(f) ? null : !f.env.stream ? ATTN('Video uploads need CF_ACCOUNT_ID and CF_STREAM_TOKEN in Cloudflare.') : ON()) },
        { t: 'Save and finish later', s: 'live', k: 'visitor',
          when: 'A family taps Save and finish later.',
          does: 'Emails them a private link back to their saved answers (good for 60 days after their last change).',
          touches: ['Resend'], where: 'functions/api/apply.js', live: needsKey('resend', 'RESEND_API_KEY is missing, so the link can’t be emailed.') },
        { t: 'Bot check', s: 'off', k: 'visitor',
          does: 'Turnstile on the first page once both keys are set. Until then a hidden honeypot field, per-connection limits and the required photos and video keep bots out.',
          touches: ['Cloudflare Turnstile'], where: 'functions/api/apply.js',
          live: (f) => (!env(f) ? null : f.env.turnstile && f.env.turnstileSite ? ON('Turnstile is checked on every new application.') : OFF('Needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Cloudflare; the honeypot and limits work without them.')) },
      ]},
      { t: 'Waitlist', children: [
        { t: 'Tell me when applications open', s: 'live', k: 'visitor',
          when: 'While applications are closed, a family leaves their email on the Apply page or the closed application form, in English or Spanish.',
          does: 'Saves it on the site first, then adds them to Kit (tag “Application Waitlist”; someone new to Kit is also tagged “Application Waitlist only (no newsletter)” so list mail to everyone leaves them out). Emails them “You’re on the list” in their language. If Kit fails it keeps retrying, and Peter hears if a signup is still stuck after about 3 hours. Applications already open? They’re shown the link and emailed it.',
          touches: ['D1', 'Kit', 'Resend', 'Slack'], where: 'src/pages/apply.astro · src/pages/apply/form.astro · functions/api/newsletter.js · _application-waitlist.js',
          live: (f) => (!env(f) ? null : !f.env.kit ? ATTN('KIT_API_KEY is missing. Signups are still saved on the site, and the site emails each family itself when applications open.') : f.waitlist?.kitProblems ? ATTN(`${plural(f.waitlist.kitProblems, 'signup isn’t', 'signups aren’t')} in Kit yet. The site keeps retrying.`) : ON(f.waitlist ? `${plural(f.waitlist.waiting, 'family is', 'families are')} waiting.` : null, f.waitlist?.lastSignupAt)) },
        { t: 'Applications-open email', s: 'live', k: 'event',
          when: 'Applications are opened (by hand, or by the schedule).',
          does: 'The moment applications open, checks the form is really open, puts every family waiting into a Kit tag made for this opening and language, and hands Kit one email per language scheduled for 10 minutes later (right away for a scheduled opening). From then Kit sends it on its own, even if the site’s clock stops. Families Kit can’t reach are scheduled with Resend for the same minute; if Kit can’t take it at all for two hours, the site emails everyone itself. Anyone who signs up while open is emailed the link right away. Staff get an email and a Slack post when it’s counting down, going out and done.',
          touches: ['Kit', 'Resend', 'D1', 'Slack'], where: 'functions/api/_application-waitlist.js (the save that opens applications, then the heartbeat) · Admin → Applications → Settings → Waitlist',
          info: 'To stop it, close applications again within the 10 minutes, or press “Don’t send this time”: the site deletes it from Kit (and cancels Resend’s). Kit is checked every 6 hours while families wait, so a broken key is caught early; “Rehearse through Kit” sends the real email to you. Each opening has its own tags, so nobody is emailed twice and next season starts fresh.',
          live: (f) => {
            const o = f.waitlist?.opening;
            if (!f.waitlist) return null;
            if (f.waitlist.kit && !f.waitlist.kit.ok && f.waitlist.waiting) return ATTN(`Kit isn’t working (${f.waitlist.kit.error}) and ${plural(f.waitlist.waiting, 'family is', 'families are')} waiting.`);
            if (o?.state === 'countdown') return { s: 'live', why: `Counting down to the email for ${plural(o.total, 'family', 'families')}.` };
            if (o?.state === 'preparing' && o.error) return ATTN(o.error);
            if (o?.state === 'preparing' || o?.state === 'sending') return ON(`Going out to ${plural(o.total, 'family', 'families')}.`);
            if (o?.state === 'sent') return ON(o.total ? `Last sent to ${plural(o.total, 'family', 'families')}:` : 'The last opening had nobody waiting.', o.sentAt);
            return ON(f.waitlist.waiting ? `Ready for ${plural(f.waitlist.waiting, 'family', 'families')} when applications open.` : 'Nobody is waiting yet.');
          } },
      ]},
      { t: 'Into JobTread', children: [
        { t: 'Application → JobTread', s: 'live', k: 'event',
          when: 'A family submits.',
          does: 'Creates the customer account (Status Applied, Diagnosis, Birthday, Gender, Language, Referred By, Verbal, Mobile, Makeover Year and Type, Application URL), the parents as contacts and the home as a location, and attaches the application PDF and four photos. The video follows once Stream has processed it.',
          touches: ['JobTread', 'R2', 'Cloudflare Stream'], where: 'functions/api/_applications.js',
          info: 'Each step is done once and remembered, so a retry never makes a second account. DataX fills the Zillow data when the location appears.',
          live: needsKey('jobtread', 'JOBTREAD_GRANT_KEY is missing.') },
        { t: 'Family confirmation', s: 'live', k: 'event',
          when: 'Right after the account is made.',
          does: 'Posts the “Application Status” message from the Qualification Committee to the main parent with the PDF attached. JobTread emails it, and replies land on the account.',
          touches: ['JobTread'], where: 'functions/api/_applicant-comms.js',
          live: (f) => (!env(f) ? null : f.env.jobtreadQc ? ON('Posts as the Qualification Committee.') : { why: 'Posts from the site’s JobTread connection until JOBTREAD_QC_GRANT_KEY (a key made while logged in as the Qualification Committee) is added in Cloudflare.' }) },
        { t: 'Medical condition note', s: 'live', k: 'event',
          when: 'A new applicant’s Diagnosis is first filled in.',
          does: 'Posts a staff-only “Child’s Medical Condition” summary written by Workers AI.',
          touches: ['JobTread', 'Workers AI'], where: 'functions/api/_applicant-comms.js', live: needsAi },
        { t: 'Staff heads-up', s: 'live', k: 'event',
          when: 'A family submits.',
          does: 'Emails selection@soardcharity.com and posts to Slack with the child’s first name, makeover type and a link to the account.',
          touches: ['Resend', 'Slack'], where: 'functions/api/_applications.js',
          live: (f) => (!env(f) ? null : !f.env.resend ? ATTN('RESEND_API_KEY is missing, so the heads-up can’t be emailed.') : ON(f.env.slack ? 'By email and Slack.' : 'By email only: Slack isn’t connected.')) },
        { t: 'Application sweep', s: 'live', k: 'schedule',
          when: 'Every 2 minutes on the live hub’s heartbeat.',
          does: 'Finishes anything unfinished (with growing waits), attaches videos once ready, and clears unsubmitted drafts after 60 days. Emails Peter and posts to Slack once if an application is stuck.',
          touches: ['JobTread', 'D1', 'Cloudflare Stream', 'Resend', 'Slack'], where: 'functions/api/_applications.js · broadcast-hooks.js' },
        { t: 'Admin → Applications', s: 'live', k: 'admin',
          does: 'Each application’s checklist (account, contacts, home, PDF, photos, video, messages) with Retry and a test application; the form editor (questions, choices, show-when rules, stop screens), the family messages, and version history. Put live takes effect right away, no Publish.',
          touches: ['D1'], where: 'public/admin/applications.js · functions/api/applications-admin.js · _application-forms.js' },
      ]},
      { t: 'Status messages', children: [
        { t: 'Status → family message', s: 'off', k: 'event',
          when: 'Someone changes an applicant’s Status (or Diagnosis) in JobTread.',
          does: 'Sends the family the matching message once: In Review (next step is the on-site visit), Approved (on the waitlist) or Denied, worded in Admin → Applications → Messages. Moving back a step leaves a staff-only note instead. Replaces the Zapier Zaps.',
          touches: ['JobTread'], where: 'JobTread workflow “Applicant Status/Diagnosis → Site applicant messages” → functions/api/applicant-sync.js',
          info: 'Switched on Oct 20, 2026 when the Zapier Zaps went off. If a Zap comes back on, families get each message twice.',
          live: wf('22PgaEgWTBRH') },
      ]},
    ]},

  { t: 'Live broadcasts', sub: 'Phone → Stream → site, Facebook, YouTube, Instagram', color: 'live', side: 'r',
    about: 'A reveal streams once from a phone to Cloudflare Stream, which sends it on to every destination. The site runs the whole show from a heartbeat.',
    children: [
      { t: 'Going live', children: [
        { t: 'Phone stream (Larix)', s: 'live', k: 'link',
          when: 'The crew starts streaming from the phone.',
          does: 'Sends the video over SRT into the Stream live input. Setup QR codes come from Reveals → Settings.',
          touches: ['Larix', 'Cloudflare Stream'], where: 'functions/api/_stream-live.js',
          info: 'The free Larix tier burns a watermark into the video; the streaming phone needs Larix Premium.',
          live: (f) => {
            const b = f.broadcast;
            if (!b) return null;
            if (b.inputEnabled === null) return ATTN(`No live input is set up. Create one in ${SETTINGS}.`);
            if (!b.inputEnabled) return OFF(`The live input is switched off in ${SETTINGS}.`);
            return ON(f.health?.webhookEvent ? `Ready. The phone last ${phoneEvent(f.health.webhookEvent)}` : 'Ready for the phone.', f.health?.webhookAt);
          } },
        { t: 'Simulcast to Facebook', s: 'live', k: 'event',
          when: 'The stream arrives at Stream.',
          does: 'Stream pushes the feed to Facebook. In API mode the site creates the Facebook live video itself and ends it afterward.',
          touches: ['Cloudflare Stream', 'Facebook'], where: 'functions/api/_broadcast-fb.js · _broadcast.js',
          live: (f) => {
            const o = f.broadcast?.outputs;
            if (!o) return null;
            if (o.facebook === null) return ATTN(`No Facebook output is set up. Add it in ${SETTINGS}.`);
            if (!o.facebook) return OFF(`The Facebook output is switched off in ${SETTINGS}.`);
            return ON(f.broadcast.facebookMode === 'api' ? 'On, in API mode.' : 'On, with the persistent stream key.');
          } },
        { t: 'Simulcast to YouTube', s: 'live', k: 'event',
          when: 'The stream arrives at Stream.',
          does: 'Stream pushes the feed to the YouTube channel, which starts and stops the broadcast on its own.',
          touches: ['Cloudflare Stream', 'YouTube'], where: 'functions/api/_broadcast.js (Stream outputs)',
          live: (f) => {
            const o = f.broadcast?.outputs;
            if (!o) return null;
            if (o.youtube === null) return ATTN(`No YouTube output is set up, so reveals don’t reach YouTube. Paste the stream key from YouTube Studio (Go live → Stream key, with Auto-start and Auto-stop on) in ${SETTINGS}.`);
            if (!o.youtube) return OFF(`The YouTube output is switched off in ${SETTINGS}.`);
            return ON();
          } },
        { t: 'Stream event webhook', s: 'live', k: 'event',
          when: 'Stream reports the live input connected, disconnected or errored.',
          does: 'Forces an immediate update and pushes it to every open page. An error sends an alert.',
          touches: ['Cloudflare Stream', 'Cloudflare Notifications'], where: 'functions/api/stream-webhook.js',
          live: (f) => (!f.health ? null : { why: f.health.webhookAt ? `Last event: ${phoneEvent(f.health.webhookEvent)}.` : 'No events received yet.', last: f.health.webhookAt }) },
        { t: 'Heartbeat', s: 'live', k: 'schedule',
          when: 'Every 8 seconds while live, every 20 seconds in the half hour before a start, every minute otherwise.',
          does: 'The live hub wakes the site, which checks Stream and moves the reveal along: scheduled → armed → live → ending → replay.',
          touches: ['Live hub', 'Cloudflare Stream', 'D1'], where: 'workers/live-hub (alarm) → functions/api/broadcast-hooks.js',
          info: 'Page visits also nudge the same update, so the show keeps moving if the hub is down.',
          live: (f) => {
            const at = f.hub?.lastTickAt || f.health?.lastTickAt;
            if (!f.hub && !f.health) return null;
            if (stale(at, 15 * MIN)) return ATTN('No heartbeat in the last 15 minutes. Check the hub with Test hub in Reveals → Settings.', at);
            return ON('Beating.', at);
          } },
        { t: 'Automatic start & stop', s: 'live', k: 'event',
          when: 'Each heartbeat.',
          does: 'A stream with nothing scheduled creates a broadcast on the fly. No stream 4 hours after the scheduled time counts as missed and alerts. Live ends after 8 hours at most; replays end after 72 hours.',
          touches: ['D1'], where: 'functions/api/_broadcast.js' },
      ]},
      { t: 'Watch party', children: [
        { t: '/live/ page follows the kid', s: 'live', k: 'visitor',
          when: 'Someone opens /live/ (the family QR always points here).',
          does: 'Shows whichever reveal is coming up, live, or on replay, with the starting-soon slate for the last 30 minutes. QR scans are counted.',
          touches: ['Cloudflare Stream', 'D1'], where: 'functions/live/[[path]].js · _watch-party.js' },
        { t: 'Live hub', s: 'attn', k: 'event',
          when: 'Every open page keeps a socket to the hub.',
          does: 'Pushes live state, viewer counts, reactions and approved family messages to every viewer instantly.',
          touches: ['Live hub'], where: 'workers/live-hub (Worker “soard-live-hub”)',
          note: 'The deployed hub dates from September 29 and is missing the October watch-party code. Redeploy it: cd workers/live-hub && npx wrangler deploy.',
          live: (f) => {
            const hb = f.hub;
            if (!hb || !f.bindings) return null;
            if (!f.bindings.hub) return ATTN('The site isn’t connected to the hub (the LIVE_HUB binding is missing).');
            if (!hb.ok) return ATTN(`The hub isn’t answering${hb.error ? `: ${hb.error}` : ''}.`);
            if (!hb.current) return ATTN('It’s running code from before the watch party, so reactions and viewer counts don’t work and family messages fall back to 20-second polling. Redeploy it: cd workers/live-hub && npx wrangler deploy.', hb.lastTickAt);
            return ON(`${plural(hb.clients ?? 0, 'page')} connected right now.`, hb.lastTickAt);
          } },
        { t: 'Family messages, AI screened', s: 'live', k: 'visitor',
          when: 'A viewer sends a message to the family.',
          does: 'House rules plus Workers AI screen each message. Approved ones appear live; anything unsure is held for staff. If the AI is down, messages are held rather than shown. Limits: 3 a minute and 20 a reveal per person.',
          touches: ['Workers AI', 'Live hub', 'D1'], where: 'functions/api/live-messages.js · _live-messages.js',
          live: (f) => (!f.broadcast ? null : !f.broadcast.messages ? OFF(`Switched off in ${SETTINGS}.`) : needsAi(f)) },
        { t: 'Give panel (Zeffy)', s: 'live', k: 'link',
          when: 'A viewer taps Give.',
          does: 'Opens the Zeffy donation form inside the live page so nobody leaves the reveal. No per-reveal totals are tracked anywhere.',
          touches: ['Zeffy'], where: 'src/components/live/LiveGive.astro' },
      ]},
      { t: 'Alerts & checks', children: [
        { t: 'Feed monitor', s: 'live', k: 'schedule',
          when: 'Every 15 seconds while live; also watches the rehearsal feed for mic checks.',
          does: 'Listens for silence, one-sided or distorted sound, and a frozen picture, and checks Facebook and YouTube are really live. Opens an issue, reminds while it lasts, and clears it when fixed.',
          touches: ['Cloudflare Stream', 'Facebook', 'YouTube'], where: 'functions/api/_broadcast-monitor.js · _stream-probe.js',
          live: (f) => (!f.health ? null : { why: f.health.monitorAt ? 'Last watched a feed:' : 'Hasn’t watched a feed yet.', last: f.health.monitorAt }) },
        { t: 'Go / no-go', s: 'live', k: 'schedule',
          when: '60 minutes before a scheduled reveal, and again at 10 minutes if anything was still open.',
          does: 'Checks the input, outputs, Facebook post, tokens and hub, and posts the verdict.',
          touches: ['Cloudflare Stream', 'Facebook', 'Resend', 'Slack'], where: 'functions/api/_broadcast-preflight.js' },
        { t: 'Reveal-day health check', s: 'live', k: 'schedule',
          when: 'Every 6 hours on reveal days.',
          does: 'Checks the Stream token and input, the Facebook token and the hub; alerts on a problem and again when it recovers.',
          touches: ['Cloudflare Stream', 'Facebook', 'Live hub'], where: 'functions/api/_broadcast.js',
          live: (f) => {
            const hh = f.health;
            if (!hh) return null;
            const bad = [hh.streamOk === false && 'Stream', hh.facebookOk === false && 'Facebook', hh.hubOk === false && 'the hub'].filter(Boolean);
            if (bad.length) return ATTN(`The last check found a problem with ${bad.join(' and ')}.`, hh.lastDailyAt);
            return ON('Stream, Facebook and the hub all passed last time.', hh.lastDailyAt);
          } },
        { t: 'Slack posts', s: 'off', k: 'event',
          when: 'Going live, ending, a missed reveal, any feed issue, go/no-go, Reel results, invite problems.',
          does: 'Posts each issue to Slack, reminds after 3 minutes, and posts again when resolved. New and stuck applications, kid status changes and invite problems post there too.',
          touches: ['Slack'], where: 'functions/api/_broadcast-notify.js (slackAlert) · channel picked in Reveals → Settings → Alerts',
          info: 'The site’s Slack app (SLACK_BOT_TOKEN) posts to a channel picked by name and checked with Slack. SLACK_WEBHOOK_URL is the older fallback.',
          note: SLACK_OFF,
          live: slackLive },
        { t: 'Alert emails', s: 'live', k: 'event',
          when: 'The same events as Slack.',
          does: 'Emails the alert list from Reveals settings, or the admin email list if that’s empty.',
          touches: ['Resend'], where: 'functions/api/_broadcast-notify.js (alertAdmins)',
          live: (f) => (!env(f) ? null : !f.env.resend ? ATTN('RESEND_API_KEY is missing, so alerts can’t be emailed.') : ON(f.broadcast?.alertCount ? `${plural(f.broadcast.alertCount, 'address', 'addresses')} on the alert list.` : 'Going to the admin email list.')) },
        { t: 'YouTube live check', s: 'off', k: 'event',
          when: 'Runs with the feed monitor and go/no-go.',
          does: 'Confirms the YouTube channel is actually live and counts viewers.',
          touches: ['YouTube'], where: 'functions/api/_youtube.js',
          note: 'Off until YOUTUBE_API_KEY is added in Cloudflare.',
          live: needsKey('youtube', 'Off until YOUTUBE_API_KEY is added in Cloudflare.', OFF) },
      ]},
      { t: 'Reminders & emails', children: [
        { t: '“We’re live” email (Kit)', s: 'live', k: 'event',
          when: 'The stream has stayed up 3 minutes and the kid is known.',
          does: 'Sends the live link to the whole Kit list. Holds the send and alerts staff if the stream started over 30 minutes early or no kid is found within 30 minutes.',
          touches: ['Kit', 'Facebook'], where: 'functions/api/_broadcast.js (kitAutoLive)',
          live: (f) => (!f.broadcast || !env(f) ? null : !f.env.kit ? ATTN('KIT_API_KEY is missing, so the list can’t be emailed.') : f.broadcast.kitLive ? ON(`Switched on in ${SETTINGS}.`, f.sends?.live?.kit?.last) : OFF(`Switched off in ${SETTINGS}.`)) },
        { t: 'Kit drafts', s: 'live', k: 'event',
          when: 'The countdown goes up or moves to a new day, and when the replay is ready.',
          does: 'Creates a ready-to-send Kit draft for each.',
          touches: ['Kit'], where: 'functions/api/_broadcast.js · _kit.js',
          live: needsKey('kit', 'KIT_API_KEY is missing, so no drafts are made.') },
        { t: 'Reminder emails', s: 'live', k: 'schedule',
          when: 'When the countdown goes up (with a day’s notice), when the date moves, 24 hours before, 1 hour before, at go-live and when the replay is ready.',
          does: 'Emails everyone who asked for a reminder, once per reveal per kind.',
          touches: ['Resend', 'D1'], where: 'functions/api/_broadcast-notify.js',
          live: (f) => reminderBlock(f, 'email') || (!env(f) ? null : f.env.resend ? ON(null, lastSend(f, 'email')) : ATTN('RESEND_API_KEY is missing.')) },
        { t: 'Browser push reminders', s: 'live', k: 'schedule',
          when: 'The same moments as reminder emails.',
          does: 'Sends a browser notification to anyone who turned them on.',
          touches: ['Web Push'], where: 'functions/api/_broadcast-notify.js · public/sw.js',
          live: (f) => reminderBlock(f, 'push') || (!f.broadcast ? null : f.broadcast.vapid ? ON(null, lastSend(f, 'push')) : ATTN(`Push keys haven’t been generated. Generate them in ${SETTINGS}.`)) },
        { t: 'Text reminders', s: 'off', k: 'schedule',
          when: 'The same moments as reminder emails.',
          does: 'Texts everyone who signed up by phone; handles STOP replies.',
          touches: ['Twilio'], where: 'functions/api/_broadcast-notify.js',
          note: 'Off until the Twilio keys are added in Cloudflare.',
          live: (f) => {
            const block = reminderBlock(f, 'sms');
            if (!env(f)) return block;
            const keys = 'the Twilio keys (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM) aren’t in Cloudflare';
            if (block) return OFF(f.env.twilio ? block.why : `${block.why} Also, ${keys}.`);
            return f.env.twilio ? ON(null, lastSend(f, 'sms')) : ATTN(`Texts are switched on, but ${keys}.`);
          } },
      ]},
      { t: 'After the reveal', children: [
        { t: 'Replay goes up', s: 'live', k: 'event',
          when: 'Stream finishes the recording (checked every 30 seconds).',
          does: 'Names the video, requests captions, attaches it to the kid’s page and redeploys the site.',
          touches: ['Cloudflare Stream', 'D1', 'Cloudflare Pages'], where: 'functions/api/_broadcast.js',
          live: (f) => (!f.health ? null : { why: f.health.replayCheckAt ? 'Last replay check:' : null, last: f.health.replayCheckAt }) },
        { t: 'Instagram Reel', s: 'live', k: 'event',
          when: 'The replay is ready.',
          does: 'Finds the reveal moment from captions and Workers AI, cuts a clip under 15 minutes, and publishes it as a Reel. Staff can retry or skip from Reveals.',
          touches: ['Cloudflare Stream', 'Workers AI', 'Instagram'], where: 'functions/api/_broadcast-reel.js',
          live: (f) => (!f.broadcast || !env(f) ? null : !f.broadcast.reels ? OFF(`Switched off in ${SETTINGS}, so replays don’t become Reels.`) : f.env.facebook ? ON(`Switched on in ${SETTINGS}.`) : ATTN('The Facebook page token is missing, so Reels can’t be posted.')) },
        { t: 'Jump to the reveal', s: 'live', k: 'visitor',
          when: 'Someone watches a replay.',
          does: 'Adds captions and a “jump to the reveal” point, worked out once with Workers AI.',
          touches: ['Cloudflare Stream', 'Workers AI'], where: 'functions/api/live-replay.js', live: needsAi },
        { t: 'Facebook replay rescue', s: 'live', k: 'schedule',
          when: 'Every 6 hours, carried by visits to the site.',
          does: 'Copies ended Facebook live videos into Stream before Facebook deletes them at 30 days, links each one to the right kid’s page and redeploys. Alerts once for any it can’t place.',
          touches: ['Facebook', 'Cloudflare Stream', 'Cloudflare Pages'], where: 'functions/api/live-status.js · _fb-archive.js',
          live: (f) => {
            const a = f.fbArchive;
            if (!a || !env(f)) return null;
            if (!f.env.facebook) return ATTN('The Facebook page token is missing, so replays can’t be rescued.');
            if (a.needsKid) return ATTN(`${a.needsKid === 1 ? 'One rescued replay is' : `${a.needsKid} rescued replays are`} saved in Stream but not on a kid’s page yet. Pick the kid in Reveals → History.`, a.checkedAt);
            return ON(`${plural(a.archived, 'replay')} rescued so far.`, a.checkedAt);
          } },
      ]},
    ]},

  // ─── Left side ──────────────────────────
  { t: 'Website & content', sub: 'sunshineonaranneyday.com on Cloudflare Pages', color: 'site', side: 'l',
    about: 'The admin writes to the D1 database. Every build pulls D1 into the site, so the admin, not the code, is where content changes.',
    children: [
      { t: 'Publishing', children: [
        { t: 'Save in the admin', s: 'live', k: 'admin',
          when: 'Staff save or delete anything in the admin.',
          does: 'Writes D1, commits a backup copy to GitHub and records it in the audit log.',
          touches: ['D1', 'GitHub'], where: 'functions/api/save-content.js · delete-content.js · _github.js',
          live: needsKey('github', 'GITHUB_TOKEN is missing, so saves aren’t backed up to GitHub.', ATTN, 'Backups go to GitHub.') },
        { t: 'Deploy Now', s: 'live', k: 'admin',
          when: 'Staff press Deploy.',
          does: 'Calls the Cloudflare Pages deploy hook to rebuild the site.',
          touches: ['Cloudflare Pages'], where: 'functions/api/flush-deploy.js',
          live: needsKey('deployHook', 'The deploy hook isn’t set, so Deploy can’t rebuild the site.') },
        { t: 'Automatic redeploys', s: 'live', k: 'event',
          when: 'A replay is attached to a kid, or a rescued Facebook replay is placed.',
          does: 'Rebuilds the site so the video shows, at most once every 10 minutes.',
          touches: ['Cloudflare Pages'], where: 'functions/api/_broadcast.js · _fb-archive.js · fb-attach-video.js',
          live: needsKey('deployHook', 'The deploy hook isn’t set, so new videos wait for the next manual deploy.') },
        { t: 'Code push builds', s: 'live', k: 'build',
          when: 'A push to main on GitHub.',
          does: 'Cloudflare Pages builds and publishes the site.',
          touches: ['GitHub', 'Cloudflare Pages'], where: 'github.com/pranney82/soard-site' },
        { t: 'Build pulls content', s: 'live', k: 'build',
          when: 'Every build, before the site is generated.',
          does: 'Copies all content and settings from D1 into the site, then fetches image placeholders and sizes from Cloudflare Images.',
          touches: ['D1', 'Cloudflare Images'], where: 'scripts/prebuild.js · generate-lqip.js · generate-dimensions.js' },
        { t: 'Build checks & images', s: 'live', k: 'build',
          when: 'Every build.',
          does: 'Draws social share images, checks each kid’s Stream video still plays (falling back to YouTube) and writes the sitemap.',
          touches: ['Cloudflare Images', 'Cloudflare Stream', 'YouTube'], where: 'src/utils/og.ts · src/utils/reveals.ts' },
        { t: 'Tell search engines', s: 'live', k: 'admin',
          when: 'Run by hand from a computer.',
          does: 'Sends sitemap URLs to Bing and Yandex through IndexNow.',
          touches: ['IndexNow'], where: 'scripts/indexnow.js' },
      ]},
      { t: 'Storage', children: [
        { t: 'D1 database', s: 'live', k: 'link',
          does: 'All content, settings, broadcast state, reminder sign-ups, invite records and the audit log.',
          touches: ['D1'], where: 'soard-db (binding DB)',
          live: (f) => (!f.bindings ? null : f.bindings.db ? ON() : ATTN('The DB binding is missing.')) },
        { t: 'Cloudflare Images', s: 'live', k: 'link',
          does: 'Every photo and logo on the site. Staff upload, list and delete from the admin.',
          touches: ['Cloudflare Images'], where: 'functions/api/upload-image.js · list-images.js · delete-image.js',
          live: needsKey('images', 'CF_IMAGES_TOKEN is missing, so uploads fail.') },
        { t: 'Cloudflare Stream', s: 'live', k: 'link',
          does: 'Reveal videos and live inputs. Staff upload straight from the admin.',
          touches: ['Cloudflare Stream'], where: 'functions/api/upload-video.js · stream-videos.js',
          info: 'The Stream subscription has lapsed twice before. If uploads fail with a 403, check Billing before chasing tokens.',
          live: (f) => (!env(f) ? null : !f.env.stream ? ATTN('CF_STREAM_TOKEN is missing.') : f.health?.streamOk === false ? ATTN('The last health check couldn’t reach Stream. Check Billing → Subscriptions first.') : ON()) },
        { t: 'Files bucket (R2)', s: 'live', k: 'link',
          does: 'Financial PDFs and other uploads, served at /files/ and files.sunshineonaranneyday.com.',
          touches: ['Cloudflare R2'], where: 'soard-files (binding FILES)',
          live: (f) => (!f.bindings ? null : f.bindings.files ? ON() : ATTN('The FILES binding is missing.')) },
      ]},
      { t: 'AI helpers', children: [
        { t: 'Alt text & SEO writer', s: 'live', k: 'admin',
          when: 'Staff press Generate in an editor.',
          does: 'Workers AI looks at the photo and drafts alt text and SEO copy.',
          touches: ['Workers AI'], where: 'functions/api/generate.js', live: needsAi },
        { t: 'Press monitor', s: 'live', k: 'admin',
          when: 'Staff run a press scan.',
          does: 'Searches Google News for SOARD, sorts results with Workers AI and saves each article’s preview image.',
          touches: ['Google News', 'Workers AI', 'Cloudflare Images'], where: 'functions/api/press-scan.js · fetch-og-image.js', live: needsAi },
      ]},
      { t: 'Protection & records', children: [
        { t: 'Cloudflare Access', s: 'live', k: 'link',
          does: 'Guards the admin and every private API; each request’s sign-in is checked.',
          touches: ['Cloudflare Access'], where: 'functions/api/_middleware.js',
          live: needsKey('access', 'The Access team and audience settings are missing.') },
        { t: 'Audit log', s: 'live', k: 'event',
          when: 'Any admin save and any automatic action.',
          does: 'Records who or what changed what, viewable under Site → Audit Log.',
          touches: ['D1'], where: 'functions/api/audit-log.js' },
      ]},
      { t: 'Leftovers', children: [
        { t: 'Constant Contact keys', s: 'off', k: 'link',
          does: 'Old CC_ keys stored in Cloudflare. No code uses them.',
          touches: ['Constant Contact'], where: 'Cloudflare Pages → Variables',
          note: 'Still stored in Cloudflare. Safe to delete once nobody needs Constant Contact.',
          live: (f) => (!env(f) ? null : f.env.constantContact ? OFF('Still stored in Cloudflare. Safe to delete once nobody needs Constant Contact.') : OFF('Removed from Cloudflare.')) },
        { t: 'Turnstile key', s: 'off', k: 'link',
          does: 'A Turnstile secret stored in Cloudflare. No form checks it.',
          touches: ['Cloudflare Turnstile'], where: 'Cloudflare Pages → Variables',
          live: (f) => (!env(f) ? null : f.env.turnstile ? OFF('Still stored in Cloudflare; no form uses it.') : OFF('Removed from Cloudflare.')) },
      ]},
    ]},

  { t: 'Email & newsletters', sub: 'Kit for the list, Resend for one-off mail', color: 'email', side: 'l',
    about: 'Kit holds the list and sends its broadcasts. Resend only sends one-off mail: application links and notices, reveal reminders, staff alerts and editor tests.',
    children: [
      { t: 'Signups', children: [
        { t: 'Newsletter signup', s: 'live', k: 'visitor',
          when: 'A visitor signs up in the footer or a form.',
          does: 'Adds them to Kit, tagged by where they signed up.',
          touches: ['Kit'], where: 'functions/api/newsletter.js · _kit.js', live: needsKey('kit', 'KIT_API_KEY is missing, so signups fail.') },
        { t: 'Reveal reminder signup', s: 'live', k: 'visitor',
          when: 'A visitor asks to be reminded about a reveal.',
          does: 'Stores their email, phone or browser for the reminder sends.',
          touches: ['D1', 'Web Push'], where: 'functions/api/reminders.js',
          live: (f) => reminderBlock(f, 'email') || (f.broadcast ? ON(typeof f.reminders?.subscribers === 'number' ? `${plural(f.reminders.subscribers, 'person has', 'people have')} signed up.` : null) : null) },
      ]},
      { t: 'Sending', children: [
        { t: 'Push to Kit', s: 'live', k: 'admin',
          when: 'Staff press Push to Kit in Email.',
          does: 'Creates a Kit draft from the admin template; the audience is picked in Kit.',
          touches: ['Kit'], where: 'functions/api/kit-broadcast.js', live: needsKey('kit', 'KIT_API_KEY is missing.') },
        { t: 'Send test', s: 'live', k: 'admin',
          when: 'Staff send a test.',
          does: 'Sends one copy through Resend, with the name and email tags filled in.',
          touches: ['Resend'], where: 'functions/api/send-test-email.js', live: needsKey('resend', 'RESEND_API_KEY is missing.') },
        { t: 'Send to specific people', s: 'live', k: 'admin',
          when: 'Staff send to a hand-picked group.',
          does: 'Sends each of up to 100 people their own copy through Resend.',
          touches: ['Resend'], where: 'functions/api/send-direct.js', live: needsKey('resend', 'RESEND_API_KEY is missing.') },
      ]},
      { t: 'Sender accounts', children: [
        { t: 'Resend', s: 'live', k: 'link',
          does: 'Sends the site’s one-off mail from sunshine@comms.sunshineonaranneyday.com (the verified domain). The list itself lives in Kit.',
          touches: ['Resend'], where: 'RESEND_API_KEY in Cloudflare', live: needsKey('resend', 'RESEND_API_KEY is missing.') },
        { t: 'Kit', s: 'live', k: 'link',
          does: 'The main list and its broadcasts; sends from Clareece’s soardcharity.com address.',
          touches: ['Kit'], where: 'KIT_API_KEY in Cloudflare',
          info: 'soardcharity.com has no Kit domain authentication yet (DMARC is p=none, SPF covers Google only), which can hurt delivery.',
          live: needsKey('kit', 'KIT_API_KEY is missing.') },
      ]},
    ]},

  { t: 'JobTread', sub: 'Other SOARD workflows & webhooks', color: 'jt', side: 'l',
    about: 'Automations that live inside SOARD’s JobTread account, outside the website.',
    children: [
      { t: 'Workflows', children: [
        { t: 'Scope approved → Mobilization', s: 'live', k: 'event',
          when: 'A customer order with “scope” in its name is approved.',
          does: 'Sets the job’s status field to Mobilization.',
          touches: ['JobTread'], where: 'JobTread workflow “t.documentUpdated {Update Job}”', live: wf('22PJYm7aXBgK') },
        { t: 'Clean up new addresses', s: 'live', k: 'event',
          when: 'A new location is added.',
          does: 'Replaces the typed address with JobTread’s formatted one.',
          touches: ['JobTread'], where: 'JobTread workflow “t.locationCreated”', live: wf('22PJxRJ37KSs') },
        { t: 'Comms Thread on new families', s: 'live', k: 'event',
          when: 'A new customer account is created.',
          does: 'Pins a staff-only “Comms Thread” comment explaining how to text the family with /text.',
          touches: ['JobTread'], where: 'JobTread workflow “t.customerCreated {Create Comment}”', live: wf('22PJxRLV9Y3i') },
        { t: 'Application In Review comment', s: 'off', k: 'event',
          when: 'Fires when an application is marked Applied.',
          does: 'Posts an “Application In Review” note to the family about the on-site visit.',
          touches: ['JobTread'], where: 'JobTread workflow “Qualification Committee Comments”',
          info: 'Its message still has a placeholder (“primary con primary contact name”); fix it before switching it on.',
          live: wf('22PRvF7pG9VM') },
        { t: 'Comments → DataX', s: 'off', k: 'event',
          when: 'Fires on every new comment or daily log.',
          does: 'Sends each new comment’s text to a DataX agent, most likely the Grammar Checker (which is also in test mode).',
          touches: ['JobTread', 'DataX'], where: 'JobTread workflow “Comment/Log Created Trigger”', live: wf('22PZF9ENDgxn') },
      ]},
      { t: 'Webhooks', children: [
        { t: '/text → SMS', s: 'live', k: 'event',
          when: 'Any new comment.',
          does: 'Comments starting with /text are texted to the account’s primary contact.',
          touches: ['JobTread', 'winyourdata.com'], where: 'JobTread webhook → winyourdata.com/api/phone/texting', live: hook('22PDDmxBcvpA') },
        { t: 'Zillow lookup', s: 'live', k: 'event',
          when: 'A new location is added.',
          does: 'Looks up the property on Zillow.',
          touches: ['JobTread', 'Zillow', 'winyourdata.com'], where: 'JobTread webhook → winyourdata.com/api/zillow', live: hook('22PJxV5yimrd') },
        { t: 'Zapier: new account', s: 'live', k: 'event',
          when: 'A new account is created.',
          does: 'Posts the “Application Status” and “Child’s Medical Condition” comments as the Qualification Committee and keeps a Zapier Table row per account.',
          touches: ['JobTread', 'Zapier'], where: 'JobTread webhook → hooks.zapier.com',
          info: 'Being replaced by the Applications branch. Turn it off in Zapier when the site’s status workflow is switched on.', live: (f) => {
            const h = hook('22P5rFX2hhQW')(f);
            const w = wf('22PgaEgWTBRH')(f);
            if (h?.s === 'off') return h;
            if (h && w?.s === 'live') return ATTN('The site now sends these messages too; turn this Zap off in Zapier so families don’t get them twice.');
            return h;
          } },
        { t: 'Zapier: account updated', s: 'live', k: 'event',
          when: 'An account changes.',
          does: 'Posts “Application In Review”, “Application Decision” and “Moved back to …” comments as the Qualification Committee when Status changes.',
          touches: ['JobTread', 'Zapier'], where: 'JobTread webhook → hooks.zapier.com',
          info: 'Being replaced by the Applications branch. Turn it off in Zapier when the site’s status workflow is switched on.', live: (f) => {
            const h = hook('22PRvE87suYz')(f);
            const w = wf('22PgaEgWTBRH')(f);
            if (h?.s === 'off') return h;
            if (h && w?.s === 'live') return ATTN('The site now sends these messages too; turn this Zap off in Zapier so families don’t get them twice.');
            return h;
          } },
        { t: 'DataX: new job', s: 'live', k: 'event',
          when: 'A new job is created.',
          does: 'Tells DataX about the job.',
          touches: ['JobTread', 'DataX'], where: 'JobTread webhook → datax.to/api/webhooks/jobtread', live: hook('22PaN5dFNj8s') },
      ]},
    ]},

  { t: 'Giving & embeds', sub: 'Gift alerts, and outside services shown on the site', color: 'give', side: 'l',
    children: [
      { t: 'When a gift comes in', children: [
        { t: 'Gift alerts in Slack', s: 'off', k: 'event',
          when: 'Zeffy reports a completed payment (right away), and a catch-up check every 15 minutes on the live hub’s heartbeat that asks Zeffy for anything the webhook missed.',
          does: 'Posts each gift in #team-everyone: “🎉 New donation - $50.00” with who gave, the campaign and the date. $1,000 and up starts with “🚨 MAJOR GIFT” instead. A missing detail leaves its line out. Never an email address or contact details, never totals. Each payment posts once, however often Zeffy sends it.',
          touches: ['Zeffy', 'Slack', 'D1', 'Resend'], where: 'functions/api/_zeffy.js (zeffy-webhook.js, broadcast-hooks.js); posts as the site’s Slack app',
          note: 'Not connected yet. Add ZEFFY_WEBHOOK_SECRET, ZEFFY_API_KEY and SLACK_BOT_TOKEN in Cloudflare, and point Zeffy’s webhook at https://sunshineonaranneyday.com/api/zeffy-webhook.',
          info: 'Replaced the DataX donation alert agent (October 2026), which went quiet after September 9. Imported payments, $0 registrations and refunded payments aren’t posted. If Slack refuses a post, the site keeps trying for 3 days. Problems (Slack refusing, Zeffy’s key refused, the webhook missing a gift) email Peter once a day; the gift itself only ever goes to Slack.',
          live: (f) => {
            const z = f.zeffy;
            if (!z || !env(f)) return null;
            const e = f.env;
            if (!e.zeffyWebhook && !e.zeffyApi) return ATTN('Not connected yet. Add ZEFFY_WEBHOOK_SECRET, ZEFFY_API_KEY and SLACK_BOT_TOKEN in Cloudflare, and point Zeffy’s webhook at https://sunshineonaranneyday.com/api/zeffy-webhook.');
            if (!e.slackBot) return ATTN('SLACK_BOT_TOKEN (the site’s Slack app) is missing in Cloudflare, so gifts wait (up to 3 days) until it’s set.', z.lastPostAt);
            if (z.failing) return ATTN(`${plural(z.failing, 'gift')} couldn’t be posted yet${z.failingWhy ? ` (Slack said “${z.failingWhy}”)` : ''}. It keeps trying for 3 days.`, z.lastPostAt);
            if (z.rejectedAt && !stale(z.rejectedAt, 24 * HOUR) && !(ms(z.lastWebhookAt) > ms(z.rejectedAt))) return ATTN('Zeffy’s last delivery was turned away: its signature doesn’t match ZEFFY_WEBHOOK_SECRET. Copy the signing secret from Zeffy → Settings → Integrations again.', z.lastPostAt);
            if (z.sweepError) return ATTN(`The catch-up check can’t read Zeffy: ${z.sweepError}.`, z.lastPostAt);
            if (!e.zeffyWebhook) return ATTN('ZEFFY_WEBHOOK_SECRET is missing, so gifts only arrive through the 15-minute catch-up check.', z.lastPostAt);
            if (!e.zeffyApi) return ON('Posting from Zeffy’s webhook. Add ZEFFY_API_KEY in Cloudflare so a gift the webhook misses is still caught.', z.lastPostAt);
            if (!z.lastSweepAt) return ATTN('The catch-up check hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.', z.lastPostAt);
            if (stale(z.lastSweepAt, HOUR)) return ATTN(`The catch-up check hasn’t run since ${stamp(z.lastSweepAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, z.lastPostAt);
            if (z.missed && !stale(z.missedAt, 7 * 24 * HOUR)) return ATTN(`Zeffy’s webhook missed ${plural(z.missed, 'gift')} on ${stamp(z.missedAt)}, and the catch-up check posted ${z.missed === 1 ? 'it' : 'them'}. Check the webhook in Zeffy → Settings → Integrations.`, z.lastPostAt);
            return ON(z.lastPostAt ? `Connected. Last gift posted ${stamp(z.lastPostAt)}.` : 'Connected. Waiting for the first gift.', z.lastPostAt);
          } },
      ]},
      { t: 'On the pages', children: [
        { t: 'Zeffy donations', s: 'live', k: 'link',
          does: 'Donation forms on the donate page, the live page and the golf page.',
          touches: ['Zeffy'], where: 'src/pages/donate.astro · LiveGive.astro' },
        { t: 'Qtego auction', s: 'live', k: 'link',
          does: 'The gala auction link.', touches: ['Qtego'], where: 'src/utils/auction.ts' },
        { t: 'Advisory board application', s: 'live', k: 'link',
          does: 'The Jotform application on the advisory board page (the makeover application moved onto the site).', touches: ['Jotform'], where: 'src/pages/advisory-board.astro' },
        { t: 'Rating badges', s: 'live', k: 'link',
          does: 'Charity Navigator and Candid badges in the footer and on Financials, set in Site Config → Settings.',
          touches: ['Charity Navigator', 'Candid'], where: 'src/utils/trust-badges.ts' },
        { t: 'Add to calendar', s: 'live', k: 'visitor',
          when: 'A visitor adds an event or reveal to their calendar.',
          does: 'Builds Google, Outlook and .ics calendar files.',
          touches: ['Google Calendar', 'Outlook'], where: 'functions/api/calendar.ics.js' },
      ]},
      { t: 'Shared with others', children: [
        { t: 'Kids feed for Sunny & Ranney', s: 'live', k: 'link',
          when: 'The Sunny & Ranney store reads it.',
          does: 'Publishes the public kids list as JSON for the store to show.',
          touches: ['Sunny & Ranney'], where: 'src/pages/api/kids.json.ts' },
      ]},
    ]},
]};

// ─── Vocabulary ───────────────────────────
const STATUS = { live: 'Live', test: 'Test mode', off: 'Off', attn: 'Needs attention' };
const KIND = {
  schedule: 'On a schedule',
  event: 'When something happens',
  visitor: 'When a visitor acts',
  admin: 'Staff button',
  build: 'On deploy',
  link: 'Connection',
};
const FILTERS = [
  ['all', 'Everything'],
  ['own', 'Runs on its own'],
  ['visitor', 'Visitor actions'],
  ['admin', 'Staff buttons'],
  ['link', 'Connections'],
  ['attn', 'Needs a look'],
];

// ─── Prepare the tree once ────────────────
let seq = 0;
const byId = new Map();
(function prep(n, depth, parent) {
  n.id = 'a' + seq++;
  n.depth = depth;
  n.parent = parent;
  if (parent && depth > 1) n.color = parent.color;
  if (parent && depth > 1) n.side = parent.side;
  n.es = n.s; // effective status, replaced by the live check
  byId.set(n.id, n);
  (n.children || []).forEach((c) => prep(c, depth + 1, n));
})(MAP, 0, null);

const leavesOf = (n, out = []) => {
  if (n.children) n.children.forEach((c) => leavesOf(c, out));
  else out.push(n);
  return out;
};
const ALL = leavesOf(MAP);
const SERVICES = (() => {
  const count = new Map();
  ALL.forEach((n) => (n.touches || []).forEach((t) => count.set(t, (count.get(t) || 0) + 1)));
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
})();
const crumbs = (n) => {
  const out = [];
  for (let p = n.parent; p && p.depth > 0; p = p.parent) out.unshift(p.t);
  return out;
};
const defaultOpen = () => new Set([MAP.id, ...MAP.children.map((b) => b.id)]);

/** Apply the live facts to every entry. Exported for tests. */
export function applyFacts(facts) {
  ALL.forEach((n) => {
    let p = null;
    if (facts && n.live) { try { p = n.live(facts) || null; } catch { p = null; } }
    n.probe = p;
    n.es = p?.s || n.s;
  });
}
// The sentence that explains a not-live status
const reasonOf = (n) => (n.probe?.s && n.probe.s === n.es ? n.probe.why : null) || n.note || null;

function matches(n, f) {
  if (n.children) return false;
  if (f.kind === 'own' && !(n.k === 'schedule' || n.k === 'event')) return false;
  if (f.kind === 'attn' && n.es === 'live') return false;
  if (f.kind && f.kind !== 'own' && f.kind !== 'attn' && n.k !== f.kind) return false;
  if (f.svc && !(n.touches || []).includes(f.svc)) return false;
  if (f.q) {
    const hay = [n.t, n.when, n.does, n.where, n.note, n.info, n.probe?.why, ...(n.touches || [])].join(' ').toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}
const anyMatch = (n, f) => (n.children ? n.children.some((c) => anyMatch(c, f)) : matches(n, f));

// ─── Measuring & layout ───────────────────
const FONT = { 0: '700 17px', 1: '650 14px', 2: '550 13px', 3: '450 12.5px' };
const PAD = { 0: 20, 1: 14, 2: 11 };
const HGT = { 0: 44, 1: 32, 2: 27, 3: 22 };
const BADGE = 28;
const READ_K = 0.9; // zoom at which every label reads comfortably
let ctx2d = null;
function textW(text, depth) {
  ctx2d ||= document.createElement('canvas').getContext('2d');
  ctx2d.font = `${FONT[Math.min(depth, 3)]} Inter, system-ui, sans-serif`;
  return ctx2d.measureText(text).width;
}
function boxW(n, open) {
  if (!n.children) return textW(n.t, 3) + 22;
  const d = Math.min(n.depth, 2);
  return textW(n.t, d) + PAD[d] * 2 + (n.depth > 0 && !open.has(n.id) ? BADGE : 0);
}

// Leaves and closed groups stack top to bottom, parents center on their
// children; each side gets its own column offsets from its widest labels.
function layout(open) {
  const nodes = [];
  MAP._w = boxW(MAP, open);
  MAP._x = -MAP._w / 2;
  MAP._y = 0;
  nodes.push(MAP);
  for (const side of ['r', 'l']) {
    const dir = side === 'r' ? 1 : -1;
    const branches = MAP.children.filter((b) => b.side === side);
    const vis = [];
    let cursor = 0;
    let lastParent = null;
    const place = (n) => {
      vis.push(n);
      n._w = boxW(n, open);
      const kids = n.children && open.has(n.id) ? n.children : null;
      if (kids) {
        kids.forEach(place);
        n._y = (kids[0]._y + kids[kids.length - 1]._y) / 2;
      } else {
        const hgt = n.children ? (n.depth === 1 ? 44 : 36) : 24;
        if (lastParent && lastParent !== n.parent) cursor += n.depth === 1 || !n.children ? 12 : 6;
        n._y = cursor + hgt / 2;
        cursor += hgt;
        lastParent = n.parent;
      }
    };
    branches.forEach((b) => {
      if (lastParent) cursor += 22;
      place(b);
      lastParent = b;
    });
    const shift = cursor / 2;
    const maxW = {};
    vis.forEach((n) => {
      n._y -= shift;
      maxW[n.depth] = Math.max(maxW[n.depth] || 0, n._w);
    });
    const col = { 1: MAP._w / 2 + 48 };
    for (let d = 2; d <= 4; d++) col[d] = col[d - 1] + (maxW[d - 1] || 0) + (d === 2 ? 44 : 34);
    vis.forEach((n) => {
      n._x = dir > 0 ? col[n.depth] : -col[n.depth] - n._w;
      n._dir = dir;
      nodes.push(n);
    });
  }
  return { nodes, links: nodes.slice(1) };
}
function linkD(n) {
  const p = n.parent;
  const x1 = n._dir > 0 ? p._x + p._w : p._x;
  const x2 = n._dir > 0 ? n._x : n._x + n._w;
  const mx = (x1 + x2) / 2;
  return `M${x1},${p._y}C${mx},${p._y} ${mx},${n._y} ${x2},${n._y}`;
}
function bounds(list) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  list.forEach((n) => {
    x0 = Math.min(x0, n._x); x1 = Math.max(x1, n._x + n._w);
    y0 = Math.min(y0, n._y - 22); y1 = Math.max(y1, n._y + 22);
  });
  return { x0, x1, y0, y1 };
}

// ─── Styles ───────────────────────────────
const CSS = `
.am { --am-live: var(--color-success); --am-warn: #B7791F; --am-idle: #8C8D93;
  --am-b-reveals: #B08900; --am-b-live: #6352C9; --am-b-email: #2B6CB0; --am-b-site: #13807A;
  --am-b-give: #A0571A; --am-b-jt: #4E7A2E; --am-b-apply: #8C3D6B; }
.am-lede { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; margin: 0.15rem 0 0.4rem; padding: 0; list-style: none; font-size: 0.88rem; color: var(--color-text-secondary); }
.am-lede b { color: var(--color-text); font-variant-numeric: tabular-nums; font-weight: 700; }
.am-lede button { all: unset; cursor: pointer; border-radius: 4px; }
.am-lede button:hover span { text-decoration: underline; }
.am-lede button:focus-visible { box-shadow: var(--focus-ring); }
.am-lede .am-warnstat b { color: var(--am-warn); }
.am-check { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; margin: 0 0 1rem; font-size: 0.8rem; color: var(--color-text-muted); }
.am-check i { width: 7px; height: 7px; border-radius: 50%; background: var(--am-live); }
.am-check.is-off i { background: var(--am-idle); }
.am-check button { all: unset; cursor: pointer; color: var(--color-text-secondary); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.am-check button:focus-visible { box-shadow: var(--focus-ring); border-radius: 3px; }
.am-tools { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
.am-filters { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.am-filters button { cursor: pointer; }
.am-filters button[aria-pressed="true"] { background: var(--color-text); color: var(--color-bg-card); }
.am-svc { flex: 0 1 210px; min-width: 0; }
.am-search { flex: 1 1 180px; min-width: 0; max-width: 260px; margin-left: auto; }
.am-search input, .am-svc select { width: 100%; }
.am-hits { position: absolute; left: 0.6rem; top: 0.6rem; z-index: 1; padding: 0.2rem 0.55rem; border-radius: 6px; background: var(--color-bg-card); border: 1px solid var(--color-border); font-size: 0.78rem; font-weight: 600; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; pointer-events: none; }
.am-work { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 1rem; align-items: start; }
.am-work.is-wide { grid-template-columns: minmax(0, 1fr); }
.am-work.is-wide .am-panel { position: static; max-height: none; }
.am-canvas { position: relative; padding: 0; margin: 0; height: clamp(460px, 66vh, 780px); background:
  radial-gradient(circle, var(--color-border) 1px, transparent 1.2px) 0 0 / 22px 22px, var(--color-bg-secondary); }
.am-canvas svg { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; }
.am-canvas svg.am-drag { cursor: grabbing; }
.am-zoom { position: absolute; right: 0.6rem; bottom: 0.6rem; display: flex; flex-direction: column; gap: 0.3rem; }
.am-zoom button { width: 36px; height: 36px; padding: 0; background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 8px; cursor: pointer; font-size: 1.05rem; font-weight: 600; color: var(--color-text); box-shadow: var(--shadow-xs); }
.am-zoom button:hover { background: var(--color-bg-hover); }
.am-legend { position: absolute; left: 0.6rem; bottom: 0.6rem; display: flex; flex-wrap: wrap; gap: 0.25rem 0.8rem; max-width: calc(100% - 4rem); padding: 0.4rem 0.65rem; background: color-mix(in srgb, var(--color-bg-card) 92%, transparent); border: 1px solid var(--color-border); border-radius: 8px; font-size: 0.74rem; color: var(--color-text-secondary); }
.am-legend span { display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap; }
.am-link { fill: none; stroke: var(--c); stroke-opacity: 0.5; stroke-width: 1.4; }
.am-link.d1 { stroke-width: 3; stroke-opacity: 0.55; }
.am-link.d2 { stroke-width: 2; }
.am-node { cursor: pointer; outline: none; animation: am-in 0.28s var(--ease-out) both; }
@keyframes am-in { from { opacity: 0; } }
.am-node text { font-family: Inter, system-ui, sans-serif; fill: var(--color-text); dominant-baseline: central; }
.am-node.d0 rect { fill: var(--color-sidebar); }
.am-node.d0 text { fill: #fff; font: 700 17px Inter, system-ui, sans-serif; letter-spacing: 0.02em; }
.am-node.d0 circle { fill: var(--color-primary); }
.am-node.d1 rect.am-pill { fill: color-mix(in srgb, var(--c) 16%, var(--color-bg-card)); stroke: var(--c); stroke-width: 1.5; }
.am-node.d1 text { font: 650 14px Inter, system-ui, sans-serif; }
.am-node.d2 rect.am-pill { fill: var(--color-bg-card); stroke: color-mix(in srgb, var(--c) 55%, var(--color-border)); stroke-width: 1.25; }
.am-node.d2 text { font: 550 13px Inter, system-ui, sans-serif; }
.am-node.leaf text { font: 450 12.5px Inter, system-ui, sans-serif; }
.am-node .am-badge rect { fill: var(--c); fill-opacity: 0.16; }
.am-node .am-badge text { font: 650 11px Inter, system-ui, sans-serif; fill: var(--color-text); text-anchor: middle; }
.am-node .am-badge.has-attn rect { fill: var(--am-warn); fill-opacity: 0.22; }
.am-node .am-hit { fill: transparent; }
.am-node:hover .am-hit, .am-node:focus-visible .am-hit { fill: var(--color-bg-hover); }
.am-node:hover rect.am-pill, .am-node:focus-visible rect.am-pill { stroke-width: 2.25; }
.am-node:focus-visible .am-hit, .am-node:focus-visible rect.am-pill { stroke: var(--color-text); stroke-width: 2; }
.am-node.sel .am-hit { fill: color-mix(in srgb, var(--c) 18%, transparent); }
.am-node.sel rect.am-pill { stroke: var(--color-text); stroke-width: 2; }
.am-node.sel text { font-weight: 650; }
.am-node.dim, .am-link.dim { opacity: 0.18; }
.am-node.hit-on text { font-weight: 650; }
svg .am-dot { stroke-width: 1.6; }
svg .am-dot.s-live { fill: var(--am-live); stroke: var(--am-live); }
svg .am-dot.s-test { fill: var(--color-bg-card); stroke: var(--am-idle); }
svg .am-dot.s-off { fill: var(--am-idle); stroke: var(--am-idle); fill-opacity: 0.35; }
svg .am-dot.s-attn { fill: var(--am-warn); stroke: var(--am-warn); }
svg .am-halo { fill: none; stroke: var(--am-warn); stroke-opacity: 0.4; stroke-width: 3; }
.am-dot-i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; border: 1.6px solid var(--am-idle); background: var(--color-bg-card); vertical-align: baseline; }
.am-dot-i.k-link { border-radius: 2px; }
.am-dot-i.s-live { background: var(--am-live); border-color: var(--am-live); }
.am-dot-i.s-attn { background: var(--am-warn); border-color: var(--am-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-warn) 25%, transparent); }
.am-dot-i.s-off { background: color-mix(in srgb, var(--am-idle) 40%, var(--color-bg-card)); }
.am-panel { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow: auto; }
.am-panel-top { display: flex; align-items: start; justify-content: space-between; gap: 0.5rem; }
.am-close { all: unset; cursor: pointer; flex: none; width: 28px; height: 28px; margin: -0.3rem -0.4rem 0 0; display: grid; place-items: center; border-radius: 6px; color: var(--color-text-muted); font-size: 1.1rem; }
.am-close:hover { background: var(--color-bg-hover); color: var(--color-text); }
.am-close:focus-visible { box-shadow: var(--focus-ring); }
.am-crumb { margin: 0 0 0.35rem; font-size: 0.74rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--c, var(--color-text-muted)); }
.am-panel h3 { font-size: 1.12rem; letter-spacing: -0.015em; line-height: 1.3; text-wrap: balance; }
.am-panel h4 { margin: 1.1rem 0 0.2rem; font-size: 0.82rem; font-weight: 700; color: var(--color-text-secondary); }
.am-panel h4:first-child { margin-top: 0; }
.am-panel .am-sub { margin: 0.2rem 0 0; color: var(--color-text-muted); font-size: 0.84rem; }
.am-panel .am-about { margin: 0.6rem 0 0; font-size: 0.88rem; line-height: 1.5; color: var(--color-text-secondary); }
.am-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.65rem 0 0.25rem; }
.am-chip-src { background: transparent !important; border: 1px dashed var(--color-border-strong) !important; color: var(--color-text-muted) !important; }
.am-panel dl { margin: 0.75rem 0 0; display: grid; gap: 0.75rem; }
.am-panel dt { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 0.2rem; }
.am-panel dd { margin: 0; font-size: 0.9rem; line-height: 1.5; }
.am-now { padding: 0.55rem 0.7rem; border-radius: 8px; background: var(--color-bg); }
.am-now.s-attn { background: color-mix(in srgb, var(--am-warn) 11%, var(--color-bg-card)); }
.am-now small { display: block; margin-top: 0.15rem; color: var(--color-text-muted); font-size: 0.8rem; }
.am-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.am-tags button { all: unset; cursor: pointer; padding: 0.15rem 0.5rem; border-radius: 6px; background: var(--color-bg); border: 1px solid var(--color-border); font-size: 0.8rem; }
.am-tags button:hover { border-color: var(--color-border-strong); background: var(--color-bg-hover); }
.am-tags button:focus-visible { box-shadow: var(--focus-ring); }
.am-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem !important; word-break: break-word; color: var(--color-text-secondary); }
.am-mini { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.1rem; }
.am-mini button { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 0.1rem 0.55rem; align-items: baseline; width: 100%; padding: 0.4rem 0.45rem; border-radius: 6px; font-size: 0.86rem; line-height: 1.35; }
.am-mini button:hover { background: var(--color-bg-hover); }
.am-mini button:focus-visible { box-shadow: var(--focus-ring); }
.am-mini small { grid-column: 2; color: var(--color-text-secondary); font-size: 0.8rem; line-height: 1.45; }
.am-mini em { font-style: normal; color: var(--color-text-muted); font-size: 0.76rem; margin-left: 0.35rem; }
.am-empty { margin: 0.4rem 0 0; font-size: 0.86rem; color: var(--color-text-secondary); }
.am-inv { margin-top: 1.5rem; }
.am-inv > h3 { font-size: 1.05rem; margin: 0 0 0.25rem; }
.am-inv > p { margin: 0 0 1rem; font-size: 0.88rem; color: var(--color-text-secondary); }
.am-inv-branch { padding: 0; }
.am-inv-branch > h4 { display: flex; align-items: center; gap: 0.55rem; margin: 0; padding: 1rem 1.25rem 0.6rem; font-size: 1rem; }
.am-inv-branch > h4 i { width: 10px; height: 10px; border-radius: 3px; background: var(--c); }
.am-inv-branch > h4 small { font-weight: 500; color: var(--color-text-muted); font-size: 0.82rem; }
.am-inv-branch details { border-top: 1px solid var(--color-border); }
.am-inv-branch summary { cursor: pointer; padding: 0.6rem 1.25rem; font-weight: 600; font-size: 0.9rem; list-style-position: inside; }
.am-inv-branch summary span { color: var(--color-text-muted); font-weight: 500; font-variant-numeric: tabular-nums; margin-left: 0.3rem; }
.am-inv-branch ul { list-style: none; margin: 0; padding: 0 1.25rem 0.6rem; display: grid; gap: 0.1rem; }
.am-inv-branch li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 0.6rem; padding: 0.45rem 0; border-top: 1px dashed var(--color-border); }
.am-inv-branch li:first-child { border-top: 0; }
.am-inv-branch li .am-dot-i { margin-top: 0.3rem; }
.am-inv-branch li b { font-weight: 600; font-size: 0.88rem; }
.am-inv-branch li .am-meta { display: block; font-size: 0.78rem; color: var(--color-text-muted); margin-top: 0.1rem; }
.am-inv-branch li p { margin: 0.2rem 0 0; font-size: 0.85rem; line-height: 1.45; color: var(--color-text-secondary); }
.am-inv-branch li p.am-why { color: var(--color-text); }
.am-inv-branch li code { display: block; margin-top: 0.2rem; font-size: 0.76rem; color: var(--color-text-muted); word-break: break-word; }
@media (max-width: 1100px) {
  .am-work { grid-template-columns: minmax(0, 1fr); }
  .am-panel { position: static; max-height: none; }
}
@media (max-width: 640px) {
  .am-canvas { height: 62vh; }
  .am-search, .am-svc { max-width: none; flex-basis: 100%; margin-left: 0; }
  .am-legend { display: none; }
}
@media (prefers-reduced-motion: reduce) { .am-node { animation: none; } }
`;
let cssDone = false;
function ensureCss() {
  if (cssDone) return;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
  cssDone = true;
}

const Dot = ({ n }) => html`<span class="am-dot-i s-${n.es} k-${n.k}" title=${STATUS[n.es]} aria-hidden="true"></span>`;
const Ago = ({ iso }) => (iso ? html`<time datetime=${iso} title=${stamp(iso)}>${ago(iso)}</time>` : null);
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// ─── The page ─────────────────────────────
export function AutomationsMap() {
  ensureCss();
  const [open, setOpen] = useState(defaultOpen);
  const [selId, setSelId] = useState(null);
  const [kind, setKind] = useState(null);
  const [svc, setSvc] = useState(null);
  const [q, setQ] = useState('');
  const [tall, setTall] = useState(null); // canvas height while everything is open (the panel moves below)
  const [fontsReady, setFontsReady] = useState(0);
  const [ready, setReady] = useState(false);
  const [facts, setFacts] = useState(null);
  const [check, setCheck] = useState({ state: 'loading' });
  const wrapRef = useRef(null);
  const gRef = useRef(null);
  const svgRef = useRef(null);
  const panelRef = useRef(null);
  const tf = useRef({ x: 0, y: 0, k: 1 });

  useEffect(() => {
    let live = true;
    (document.fonts?.ready || Promise.resolve()).then(() => live && setFontsReady((v) => v + 1));
    return () => { live = false; };
  }, []);

  const loadFacts = async () => {
    setCheck((c) => ({ ...c, state: 'loading' }));
    try {
      const res = await fetch(FACTS_URL, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      // An expired Access sign-in answers with a login page, not data
      if (!res.ok || !body?.success || !body.checkedAt) throw new Error(body?.error || (res.ok ? 'the server didn’t send data; try reloading the admin' : `HTTP ${res.status}`));
      applyFacts(body);
      setFacts(body);
      setCheck({ state: 'ok', at: body.checkedAt });
    } catch (e) {
      applyFacts(null);
      setFacts(null);
      setCheck({ state: 'error', error: e.message });
    }
  };
  useEffect(() => { loadFacts(); }, []);

  const filter = { kind, svc, q };
  const filtering = !!(kind || svc || q);
  const { nodes, links } = useMemo(() => layout(open), [open, fontsReady]);
  const sel = selId ? byId.get(selId) : null;

  const apply = () => {
    const g = gRef.current;
    if (g) g.setAttribute('transform', `translate(${tf.current.x},${tf.current.y}) scale(${tf.current.k})`);
  };
  const fit = (list = nodes) => {
    const el = wrapRef.current;
    if (!el || !list.length) return;
    const W = el.clientWidth, H = el.clientHeight;
    const b = bounds(list);
    const k = Math.min(1.2, Math.max(0.3, Math.min((W - 48) / (b.x1 - b.x0), (H - 48) / (b.y1 - b.y0))));
    tf.current = { x: W / 2 - (k * (b.x0 + b.x1)) / 2, y: H / 2 - (k * (b.y0 + b.y1)) / 2, k };
    apply();
  };
  const centerOn = (n) => {
    const el = wrapRef.current;
    if (!el) return;
    const k = Math.max(tf.current.k, READ_K);
    tf.current = { x: el.clientWidth / 2 - k * (n._x + n._w / 2), y: el.clientHeight / 2 - k * n._y, k };
  };
  const zoomBy = (f, cx, cy) => {
    const el = wrapRef.current;
    const t = tf.current;
    const k = Math.min(2.5, Math.max(0.25, t.k * f));
    const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    tf.current = { k, x: px - ((px - t.x) * k) / t.k, y: py - ((py - t.y) * k) / t.k };
    apply();
  };

  // Fit once on arrival, and again when Inter finishes loading (labels change width)
  useEffect(() => {
    fit();
    if (!ready) setReady(true);
  }, [fontsReady]);
  useEffect(() => {
    const onResize = () => { if (!tall) fit(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [nodes, tall]);

  // Pan with one pointer, pinch with two, ctrl/⌘ + wheel (and trackpad pinch) zooms.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const pts = new Map();
    let last = null, pinch = null, moved = 0;
    const local = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const down = (e) => {
      pts.set(e.pointerId, local(e));
      moved = 0;
      if (pts.size === 1) last = local(e);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      }
    };
    const move = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomBy(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch.d = d;
        moved += 10;
        return;
      }
      if (!last) return;
      const dx = p.x - last.x, dy = p.y - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 4) {
        if (!svg.hasPointerCapture(e.pointerId)) svg.setPointerCapture(e.pointerId);
        svg.classList.add('am-drag');
        tf.current = { ...tf.current, x: tf.current.x + dx, y: tf.current.y + dy };
        apply();
      }
      last = p;
    };
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) { last = null; svg.classList.remove('am-drag'); }
      else last = [...pts.values()][0];
    };
    // A drag that started on a node must not also click it
    const click = (e) => { if (moved > 4) { e.stopPropagation(); e.preventDefault(); } };
    const wheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const p = local(e);
      zoomBy(Math.exp(-e.deltaY * 0.01), p.x, p.y);
    };
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('click', click, true);
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => {
      svg.removeEventListener('pointerdown', down);
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
      svg.removeEventListener('click', click, true);
      svg.removeEventListener('wheel', wheel);
    };
  }, []);

  // Open or close a group, keeping it under the pointer
  const toggle = (n) => {
    const next = new Set(open);
    if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
    const bx = n._x + (n._dir < 0 ? n._w : 0), by = n._y;
    layout(next);
    const ax = n._x + (n._dir < 0 ? n._w : 0), ay = n._y;
    tf.current = { ...tf.current, x: tf.current.x - (ax - bx) * tf.current.k, y: tf.current.y - (ay - by) * tf.current.k };
    setOpen(next);
  };
  const onNode = (n) => {
    if (n.depth === 0) { fit(); return; }
    setSelId(n.id);
    if (n.children) toggle(n);
    else showPanel();
  };
  const panelBelow = () => window.innerWidth <= 1100 || !!tall;
  const showPanel = () => {
    if (panelBelow()) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: smooth(), block: 'nearest' }));
  };
  // Jump to an entry from a list: open its parents and bring it to the middle
  const reveal = (n) => {
    const next = new Set(open);
    for (let p = n.parent; p; p = p.parent) next.add(p.id);
    layout(next);
    centerOn(n);
    setOpen(next);
    setSelId(n.id);
    if (window.innerWidth <= 1100) wrapRef.current?.scrollIntoView({ behavior: smooth(), block: 'center' });
  };

  // Open whatever holds a match, then fit the matches into view
  const applyFilter = (next) => {
    const f = { kind, svc, q, ...next };
    if ('kind' in next) setKind(f.kind);
    if ('svc' in next) setSvc(f.svc);
    if ('q' in next) setQ(f.q);
    let o;
    if (f.kind || f.svc || f.q) {
      o = new Set([MAP.id]);
      const walk = (n) => { if (n.children) { if (anyMatch(n, f)) o.add(n.id); n.children.forEach(walk); } };
      MAP.children.forEach(walk);
    } else o = defaultOpen();
    const l = layout(o);
    const filtered = f.kind || f.svc || f.q;
    setTall(null);
    setOpen(o);
    // Zoom to what matched (and the branches holding it), not the dimmed rest
    requestAnimationFrame(() => requestAnimationFrame(() => fit(filtered ? l.nodes.filter((n) => n.depth === 0 || anyMatch(n, f)) : l.nodes)));
  };
  const qTimer = useRef(null);
  const onSearch = (e) => {
    const v = e.target.value;
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => applyFilter({ q: v.trim().toLowerCase() }), 180);
  };
  const pickService = (name) => {
    setSelId(null);
    applyFilter({ svc: name || null });
    showPanel();
  };
  // Everything open at a zoom where labels read: the map takes the full width
  // (the panel moves below) and the canvas grows tall enough to hold it all
  const openAll = () => {
    const all = new Set([...byId.values()].filter((n) => n.children).map((n) => n.id));
    const l = layout(all);
    const el = wrapRef.current;
    const b = bounds(l.nodes);
    const W = el.parentElement.clientWidth;
    const k = Math.max(0.7, Math.min(READ_K, (W - 48) / (b.x1 - b.x0)));
    const H = Math.min(2600, Math.max(el.clientHeight, (b.y1 - b.y0) * k + 64));
    const fitsWide = (b.x1 - b.x0) * k <= W - 48;
    tf.current = { k, x: fitsWide ? W / 2 - (k * (b.x0 + b.x1)) / 2 : W / 2, y: H / 2 - (k * (b.y0 + b.y1)) / 2 };
    setKind(null); setSvc(null); setQ('');
    const input = document.getElementById('am-search');
    if (input) input.value = '';
    setTall(H);
    setOpen(all);
  };
  const resetAll = () => {
    const input = document.getElementById('am-search');
    if (input) input.value = '';
    setSelId(null);
    applyFilter({ kind: null, svc: null, q: '' });
  };

  const hits = filtering ? ALL.filter((n) => matches(n, filter)).length : 0;
  const stat = (f) => ALL.filter(f).length;
  const attn = ALL.filter((n) => n.es === 'attn');
  const parked = ALL.filter((n) => n.es === 'test' || n.es === 'off');

  const onKey = (e, n) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNode(n); } };

  const nodeEl = (n) => {
    const style = `--c: var(--am-b-${n.color || 'site'})`;
    const dim = filtering && n.depth > 0 && !anyMatch(n, filter);
    const cls = `am-node d${Math.min(n.depth, 2)}${n.children ? '' : ' leaf'}${n.id === selId ? ' sel' : ''}${dim ? ' dim' : ''}${filtering && !n.children && matches(n, filter) ? ' hit-on' : ''}`;
    const left = n._dir < 0;
    if (n.depth === 0) {
      return html`<g key=${n.id} class=${cls} transform=${`translate(${n._x},${n._y})`} tabindex="0" role="button" aria-label="Fit the whole map" onClick=${() => onNode(n)} onKeyDown=${(e) => onKey(e, n)}>
        <rect x="0" y=${-HGT[0] / 2} width=${n._w} height=${HGT[0]} rx="22" />
        <circle cx=${PAD[0] - 6} cy="0" r="4" />
        <text x=${PAD[0] + 4}>${n.t}</text>
      </g>`;
    }
    if (n.children) {
      const d = Math.min(n.depth, 2);
      const hgt = HGT[d];
      const closed = !open.has(n.id);
      const pad = PAD[d];
      const inside = leavesOf(n);
      const warn = inside.some((l) => l.es === 'attn');
      return html`<g key=${n.id} class=${cls} style=${style} transform=${`translate(${n._x},${n._y})`} tabindex="0" role="button" aria-expanded=${String(!closed)} aria-label=${`${n.t}, ${inside.length} items${warn ? ', some need attention' : ''}`} onClick=${() => onNode(n)} onKeyDown=${(e) => onKey(e, n)}>
        <rect class="am-pill" x="0" y=${-hgt / 2} width=${n._w} height=${hgt} rx=${hgt / 2} />
        <text x=${left && closed ? pad + BADGE : pad}>${n.t}</text>
        ${closed && html`<g class=${`am-badge${warn ? ' has-attn' : ''}`} transform=${`translate(${left ? pad - 4 : n._w - pad - 20},0)`}>
          <rect x="0" y="-9" width="24" height="18" rx="9" />
          <text x="12" y="0.5">${inside.length}</text>
        </g>`}
      </g>`;
    }
    const dotX = left ? n._w - 7 : 7;
    return html`<g key=${n.id} class=${cls} style=${style} transform=${`translate(${n._x},${n._y})`} tabindex="0" role="button" aria-label=${`${n.t}, ${STATUS[n.es]}`} onClick=${() => onNode(n)} onKeyDown=${(e) => onKey(e, n)}>
      <rect class="am-hit" x="0" y="-11" width=${n._w} height="22" rx="6" />
      ${n.es === 'attn' && html`<circle class="am-halo" cx=${dotX} cy="0" r="7.5" />`}
      ${n.k === 'link'
        ? html`<rect class=${`am-dot s-${n.es}`} x=${dotX - 4} y="-4" width="8" height="8" rx="1.5" />`
        : html`<circle class=${`am-dot s-${n.es}`} cx=${dotX} cy="0" r="4.25" />`}
      <text x=${left ? n._w - 17 : 17} text-anchor=${left ? 'end' : 'start'}>${n.t}</text>
    </g>`;
  };

  const entryList = (list, why) => html`<ul class="am-mini">
    ${list.map((l) => html`<li key=${l.id}><button type="button" onClick=${() => reveal(l)}>
      <${Dot} n=${l} /><span>${l.t}<em>${crumbs(l)[0]}</em></span>
      ${why && why(l) && html`<small>${why(l)}</small>`}
    </button></li>`)}
  </ul>`;
  const closeBtn = html`<button type="button" class="am-close" aria-label="Close" onClick=${() => { setSelId(null); if (svc) applyFilter({ svc: null }); }}>×</button>`;

  const panel = () => {
    if (!sel && svc) {
      const deps = ALL.filter((n) => (n.touches || []).includes(svc));
      return html`<div>
        <div class="am-panel-top"><p class="am-crumb">Depends on</p>${closeBtn}</div>
        <h3>If ${svc} stops working</h3>
        <p class="am-about">${plural(deps.length, 'automation or connection', 'automations and connections')} use it. They’re highlighted on the map.</p>
        ${entryList(deps, (l) => (l.es !== 'live' ? reasonOf(l) : null))}
      </div>`;
    }
    if (!sel) {
      return html`<div>
        <h4>Needs attention</h4>
        ${attn.length ? entryList(attn, reasonOf) : html`<p class="am-empty">Nothing needs attention.</p>`}
        <h4>Parked or switched off</h4>
        ${parked.length ? entryList(parked, reasonOf) : html`<p class="am-empty">Nothing is parked.</p>`}
        <p class="am-empty" style="margin-top: 1rem;">Pick anything on the map to see what starts it, what it does and where it lives.</p>
      </div>`;
    }
    const style = `--c: var(--am-b-${sel.color || 'site'})`;
    const path = crumbs(sel);
    if (sel.children) {
      return html`<div style=${style}>
        <div class="am-panel-top"><p class="am-crumb">${path.join(' / ') || 'Branch'}</p>${closeBtn}</div>
        <h3>${sel.t}</h3>
        ${sel.sub && html`<p class="am-sub">${sel.sub}</p>`}
        ${sel.about && html`<p class="am-about">${sel.about}</p>`}
        ${entryList(leavesOf(sel), (l) => (l.es !== 'live' ? reasonOf(l) : null))}
      </div>`;
    }
    const p = sel.probe;
    const reason = sel.es !== 'live' && !(p?.s && p.why) ? sel.note : null;
    return html`<div style=${style}>
      <div class="am-panel-top"><p class="am-crumb">${path.join(' / ')}</p>${closeBtn}</div>
      <h3>${sel.t}</h3>
      <div class="am-chips">
        <span class="chip"><${Dot} n=${sel} /> ${STATUS[sel.es]}</span>
        <span class="chip">${KIND[sel.k]}</span>
        <span class="chip am-chip-src" title=${p ? 'Checked against the live systems when this page opened' : `Can’t be checked from the site; as written on ${WRITTEN_ON}`}>${p ? 'Checked live' : 'From the map'}</span>
      </div>
      <dl>
        ${p && (p.why || p.last) && html`<div><dt>Right now</dt><dd class=${`am-now s-${sel.es}`}>${p.why || 'Running.'}${p.last && html`<small>Last ran <${Ago} iso=${p.last} /></small>`}</dd></div>`}
        ${reason && html`<div><dt>${sel.es === 'attn' ? 'What needs doing' : 'Why it’s off'}</dt><dd class=${`am-now s-${sel.es}`}>${reason}</dd></div>`}
        ${sel.when && html`<div><dt>What starts it</dt><dd>${sel.when}</dd></div>`}
        ${sel.does && html`<div><dt>What it does</dt><dd>${sel.does}</dd></div>`}
        ${sel.touches?.length > 0 && html`<div><dt>Touches</dt><dd class="am-tags">${sel.touches.map((t) => html`<button type="button" key=${t} title=${`Show everything that depends on ${t}`} onClick=${() => pickService(t)}>${t}</button>`)}</dd></div>`}
        ${sel.where && html`<div><dt>Where it lives</dt><dd class="am-mono">${sel.where}</dd></div>`}
        ${sel.info && html`<div><dt>Good to know</dt><dd>${sel.info}</dd></div>`}
      </dl>
    </div>`;
  };

  return html`<div class="am">
    <div class="page-header" style="margin-bottom: 0.4rem;">
      <div>
        <h2>Automations</h2>
        <p class="page-sub">Everything that runs on its own or connects SOARD to another service. Pick anything to see what starts it, what it does and where it lives.</p>
      </div>
    </div>
    <ul class="am-lede">
      <li><b>${stat((n) => (n.k === 'schedule' || n.k === 'event') && n.es === 'live')}</b> run on their own</li>
      <li><b>${stat((n) => n.k === 'visitor' && n.es === 'live')}</b> react to visitors</li>
      <li><b>${stat((n) => n.k === 'admin')}</b> staff buttons</li>
      <li><b>${stat((n) => n.k === 'link')}</b> connections</li>
      <li><button type="button" onClick=${() => { setSelId(null); if (svc) applyFilter({ svc: null }); showPanel(); }}><b>${parked.length}</b> <span>parked or off</span></button></li>
      <li class="am-warnstat"><button type="button" onClick=${() => { setSelId(null); if (svc) applyFilter({ svc: null }); showPanel(); }}><b>${attn.length}</b> <span>need attention</span></button></li>
    </ul>
    <p class=${`am-check${check.state === 'ok' ? '' : ' is-off'}`} aria-live="polite">
      <i aria-hidden="true"></i>
      ${check.state === 'loading' && 'Checking live status…'}
      ${check.state === 'ok' && html`<span>Statuses checked live <${Ago} iso=${check.at} />. Map written ${WRITTEN_ON}.</span>`}
      ${check.state === 'error' && html`<span>Couldn’t check live status (${check.error}). Showing the map as written ${WRITTEN_ON}.</span>`}
      ${check.state !== 'loading' && html`<button type="button" onClick=${loadFacts}>Check again</button>`}
    </p>

    <div class="am-tools">
      <div class="am-filters" role="group" aria-label="Show">
        ${FILTERS.map(([k, label]) => html`<button key=${k} type="button" class="chip" aria-pressed=${String((kind || 'all') === k)} onClick=${() => applyFilter({ kind: k === 'all' || kind === k ? null : k })}>${label}</button>`)}
      </div>
      <div class="am-svc">
        <select id="am-svc" class="form-select" aria-label="Show what depends on a service" value=${svc || ''} onChange=${(e) => pickService(e.target.value)}>
          <option value="">Depends on…</option>
          ${SERVICES.map(([name, n]) => html`<option key=${name} value=${name}>${name} (${n})</option>`)}
        </select>
      </div>
      <div class="am-search">
        <input id="am-search" class="form-input" type="search" aria-label="Search automations" placeholder="Search: Kit, JobTread, Slack…" onInput=${onSearch} />
      </div>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${openAll}>Open all</button>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${resetAll}>Reset</button>
    </div>

    <div class=${`am-work${tall ? ' is-wide' : ''}`}>
      <div class="card am-canvas" ref=${wrapRef} style=${tall ? `height: ${tall}px` : ''}>
        ${filtering && html`<span class="am-hits" aria-live="polite">${hits} match${hits === 1 ? '' : 'es'}</span>`}
        <svg ref=${svgRef} role="group" aria-label="Automations mindmap" style=${ready ? '' : 'opacity: 0'}
          onClick=${(e) => { if (e.target === svgRef.current) setSelId(null); }}>
          <g ref=${gRef} transform=${`translate(${tf.current.x},${tf.current.y}) scale(${tf.current.k})`}>
            <g>${links.map((n) => html`<path key=${'l' + n.id} class=${`am-link d${Math.min(n.depth, 3)}${filtering && !anyMatch(n, filter) ? ' dim' : ''}`} style=${`--c: var(--am-b-${n.color || 'site'})`} d=${linkD(n)} />`)}</g>
            <g>${nodes.map(nodeEl)}</g>
          </g>
        </svg>
        <div class="am-legend" aria-hidden="true">
          <span><span class="am-dot-i s-live"></span>Live</span>
          <span><span class="am-dot-i s-test"></span>Test or off</span>
          <span><span class="am-dot-i s-attn"></span>Needs attention</span>
          <span><span class="am-dot-i s-live k-link"></span>Connection</span>
          <span>Drag to move · pinch or ⌘ scroll to zoom</span>
        </div>
        <div class="am-zoom">
          <button type="button" aria-label="Zoom in" onClick=${() => zoomBy(1.25)}>+</button>
          <button type="button" aria-label="Zoom out" onClick=${() => zoomBy(0.8)}>−</button>
          <button type="button" aria-label="Fit the whole map" onClick=${() => fit()} style="font-size: 0.72rem;">Fit</button>
        </div>
      </div>
      <aside class="card am-panel" ref=${panelRef} aria-live="polite">${panel()}</aside>
    </div>

    <section class="am-inv">
      <h3>Everything, as a list</h3>
      <p>The same map, written out. Green is live, an open circle is built but switched off or in test, amber needs someone.</p>
      ${MAP.children.map((b) => html`<div key=${b.id} class="card am-inv-branch" style=${`--c: var(--am-b-${b.color})`}>
        <h4><i></i>${b.t}${b.sub && html` <small>${b.sub}</small>`}</h4>
        ${b.children.map((g) => html`<details key=${g.id} open>
          <summary>${g.t}<span>${leavesOf(g).length}</span></summary>
          <ul>${leavesOf(g).map((l) => html`<li key=${l.id}><${Dot} n=${l} /><div>
            <b>${l.t}</b><span class="am-meta">${STATUS[l.es]} · ${KIND[l.k]}${l.when ? ` · ${l.when}` : ''}</span>
            ${l.es !== 'live' && reasonOf(l) && html`<p class="am-why">${reasonOf(l)}</p>`}
            ${l.does && html`<p>${l.does}</p>`}
            ${l.where && html`<code>${l.where}</code>`}
          </div></li>`)}</ul>
        </details>`)}
      </div>`)}
    </section>
  </div>`;
}
