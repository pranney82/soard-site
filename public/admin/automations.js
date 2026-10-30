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
 * The map itself (drawing, panning, filters, the side panel) is ./mindmap.js,
 * shared with Site → Emails & invites. The page's other view, Process
 * (#automations/process), is ./process.js: SOARD's process Docs step by step,
 * with these same entries pinned to the steps they do, statuses and all.
 */

import { h, htm, useState, useEffect } from './vendor.js';
import { MindMap, prepareMap, fetchFacts, Ago, STATUS, MIN, HOUR, ms, ago, stamp, stale, plural } from './mindmap.js';
import { ProcessView, hashOfTrack, currentTrack } from './process.js';
import { reviewOf } from './process-shared.js';

const html = htm.bind(h);

const WRITTEN_ON = 'October 29, 2026';
const FACTS_URL = '/api/automations-admin';

// ─── Live check helpers ───────────────────
export { ago };

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
    if (sl.ok) return ON(sl.attention ? `Good news to #${sl.channel}, alerts that need a hand to #${sl.attention}${sl.team ? `, in ${sl.team}` : ''}.` : `Posting everything to #${sl.channel}${sl.team ? ` in ${sl.team}` : ''}.`);
    return ATTN(sl.error === 'no_channel' ? `The Slack app is connected, but no channel is picked yet: ${SETTINGS} → Alerts.` : `Slack won’t take posts (${sl.error}). ${SETTINGS} → Alerts says how to fix it.`);
  }
  if (f.env.slack) return ON('Through the old incoming webhook, which can’t say which channel it posts to. Add the Slack app to name and check the channel.');
  return OFF(SLACK_OFF);
};
// Staff inboxes swept (_mail-sweep.js): one look at every inbox serves both of its entries
const sweepLive = (kind) => (f) => {
  const m = f.mailSweep;
  if (!m || !('key' in m)) return null;
  if (!m.key) return OFF('Needs GOOGLE_CALENDAR_KEY in Cloudflare.');
  if (kind === 'receipt' && !m.email) return ATTN('RESEND_API_KEY is missing, so receipts can’t be sent on.');
  if (kind === 'family' && !m.jobtread) return ATTN('JOBTREAD_GRANT_KEY is missing, so family emails can’t be added.');
  if (!m.lastSweptAt) return ATTN('Hasn’t looked yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
  if (stale(m.lastSweptAt, HOUR)) return ATTN(`Hasn’t looked since ${stamp(m.lastSweptAt)}. Check the Heartbeat entry.`, m.lastSweptAt);
  if (m.error) return ATTN(m.error, m.lastSweptAt);
  const c = m.counts?.[kind] || {};
  const noun = kind === 'receipt' ? 'receipt' : 'family email';
  const failed = (m.recent || []).find((r) => r.kind === kind && r.state === 'failed');
  if (failed) return ATTN(`Couldn’t ${kind === 'receipt' ? 'send a receipt on' : 'add a family email'}: ${failed.detail}. It tries again.`, m.lastSweptAt);
  const ls = kind === 'receipt' ? m.lastSent : null;
  if (ls && ['bounced', 'failed', 'complained'].includes(ls.status)) return ATTN(`${ls.to} turned the last receipt away (${stamp(ls.at)})${ls.detail ? `: ${ls.detail}` : ''}. In Google Admin, the group needs to accept email from outside SOARD.`, m.lastSweptAt);
  if (m.watchUntil && Date.parse(m.watchUntil) > Date.now()) return ON(`Only watching until ${stamp(m.watchUntil)}, then it does what it found: ${plural(c.would || 0, noun)} so far.`, m.lastSweptAt);
  if (kind === 'family' && !m.backfillDone) return ON('Bringing in the last year’s family emails, oldest first.', m.lastSweptAt);
  const done = (kind === 'receipt' ? c.sent : c.posted) || 0;
  return ON(`Reading ${plural(m.inboxes, 'inbox', 'inboxes')}. ${plural(done, noun)} ${kind === 'receipt' ? 'sent to the receipt inbox' : 'added in JobTread'} this week.`, m.lastSweptAt);
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
// Stream's three events in words; anything else stored (Cloudflare's test, an old record) reads as ''
const PHONE_EVENTS = { 'live_input.connected': 'connected', 'live_input.disconnected': 'disconnected', 'live_input.errored': 'errored' };
const phoneEvent = (e) => (typeof e === 'string' && Object.hasOwn(PHONE_EVENTS, e) ? PHONE_EVENTS[e] : '');

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
          does: 'Wakes the invite engine, so construction starting sends the tentative invite, and Set Start Date checked off sends the demo day invite. Skips the countdown check.', touches: ['JobTread'], where: JT_INVITE_HOOK, live: wf('22PgYwQvKkTs') },
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
          does: 'JobTread has no workflow trigger for giving someone access to a job, so this re-reads every upcoming reveal whose invite is out. A partner (any level), trade partner, sponsor, photographer or design partner added to a confirmed reveal’s job, or a new family contact email, gets the invite within minutes; someone taken off the job loses it. Invites that haven’t changed are left alone.',
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
        { t: 'Demo day invites', s: 'live', k: 'event',
          when: 'A job’s Set Start Date task is checked off in JobTread (the “Task checked or un-checked” workflow wakes it), and every 5 minutes on the live hub’s heartbeat.',
          does: 'Sends “Max’s Demo Day” for the date on the job’s Demo task, at its time or the default (9:00 AM, an hour), to the family, the internal team, the monetary sponsor (the kid’s sponsor’s people on the job in JobTread, and anyone with the Monetary Sponsor role there; the job’s Monetary Sponsor field names which sponsor) and everyone on the every-demo-day list (social media). Nobody else with access to the job. The Demo task moving moves the invite within 5 minutes. An invite already sent by hand from the organizer’s calendar (“demo” and the kid’s name in its title) is left alone. Like reveal invites, the site never cancels one: delete it in Google Calendar. A job closed or on hold keeps its invite and staff get one heads-up; Set Start Date done with no Demo date gets one too.',
          touches: ['JobTread', 'Google Calendar', 'D1'], where: 'functions/api/_demo-invites.js (from reveal-invites.js and broadcast-hooks.js) · demo-invites-admin.js',
          info: 'From Clareece’s Google Calendar, like reveal invites. The every-demo-day list is kept on the Demo Day page; everyone else comes from JobTread.',
          live: (f) => {
            const d = f.demoInvites;
            if (!d) return null;
            if (env(f) && !f.env.calendar) return ATTN('GOOGLE_CALENDAR_KEY is missing in Cloudflare, so no invites can go out.');
            if (!d.enabled) return OFF('Switched off on the Demo Day page.');
            if (d.errors) return ATTN(`${plural(d.errors, 'demo day invite')} couldn’t be sent. Retry is on the Demo Day page.`, d.lastCheckAt);
            if (d.lastCheckAt && stale(d.lastCheckAt, HOUR)) return ATTN(`Hasn’t checked JobTread since ${stamp(d.lastCheckAt)}. It rides on the live hub’s heartbeat, so check the Live hub entry.`, d.lastCheckAt);
            return ON(`Sending is on. ${plural(d.sent, 'demo day has', 'demo days have')} an invite out${d.byHand ? `, ${d.byHand} sent by hand` : ''}.`, d.lastSentAt || d.lastCheckAt);
          } },
        { t: 'Demo Day page', s: 'live', k: 'admin',
          when: 'Staff open Demo Day in the admin.',
          does: 'Turn demo day invites on or off, see every demo day coming up with where its invite stands and exactly who gets it, keep the every-demo-day list, edit the wording and the default time, and send a test to yourself. Retry when one fails; Send ours anyway when one was sent by hand. Dates change in JobTread.',
          touches: ['JobTread', 'Google Calendar', 'D1'], where: 'functions/api/demo-invites-admin.js · public/admin/demo-invites.js' },
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
        { t: 'Kid and project status follow JobTread', s: 'live', k: 'event',
          when: 'A JobTread workflow reports a job’s status, closed date or task change (right away), and an hourly sweep on the live hub’s heartbeat. Visits to the reveals feed are the backup.',
          does: 'Sets each kid page’s status from its job: Awaiting Funding shows “Needs funding”, Design through Build shows “In progress”, and the Reveal task done, Closed Done or Warranty shows “Completed”. On Site and Denied take the profile off the site (Denied tells staff once by email and Slack), and it comes back by itself when the job moves on. Community projects follow an organization’s job the same way: “In progress” while it’s funded or built, “Completed” once it’s done, and only Denied takes one off the site. Each change is saved like an admin save, with History, then the site publishes, at most every 10 minutes.',
          touches: ['JobTread', 'D1', 'GitHub', 'Cloudflare Pages', 'Resend', 'Slack'], where: 'functions/api/_kid-status.js (from reveal-invites.js, broadcast-hooks.js, reveals.js)',
          info: 'Staff can’t change a linked kid’s or project’s status in the admin: Kids and Community Projects show the JobTread status with a link to the job. A job belongs to a kid or project by the link an approval made, else by name and year (“Perfect Harmony Health (2026)”); a project matched by name only ever moves on to Completed, so an old job left open can’t reopen it. Kids and projects with no job in JobTread (older years) stay under the admin’s control, a page staff hid themselves stays hidden, and jobs named TEST are ignored.',
          live: (f) => {
            const k = f.kidStatus;
            if (!k) return null;
            if (env(f) && !f.env.jobtread) return ATTN('JOBTREAD_GRANT_KEY is missing, so kid statuses can’t follow JobTread.');
            if (!k.lastSweepAt) return ATTN('It hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (k.lastErrorAt && (!k.lastRunAt || k.lastErrorAt > k.lastRunAt)) return ATTN(`The last check of JobTread failed (${stamp(k.lastErrorAt)}). It tries again within the hour.`, k.lastRunAt);
            if (stale(k.lastSweepAt, 3 * HOUR)) return ATTN(`Hasn’t checked JobTread since ${stamp(k.lastSweepAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, k.lastRunAt);
            if (env(f) && !f.env.deployHook) return ATTN('No deploy hook is set in Cloudflare, so changes are saved but wait for the next Publish.', k.lastRunAt);
            const hidden = k.hidden ? ` ${plural(k.hidden, 'profile is', 'profiles are')} hidden because of JobTread.` : '';
            return ON(`${k.changed ? `The last check changed ${plural(k.changed, 'page')}.` : 'Every linked kid and project matches JobTread.'}${hidden}`, k.lastRunAt);
          } },
        { t: 'Vendor and sponsor logos on kid pages', s: 'live', k: 'schedule',
          when: 'Every 10 minutes on the live hub’s heartbeat (JobTread has no webhook for someone given access to a job), with visits to the reveals feed as the backup. A save in Partners or on a page re-checks what’s waiting right away.',
          does: 'Reads who has access to each open job. A partner’s company (anyone on the job with a level role, or the old Vendor or Monetary Sponsor; never a Trade Partner) gets its logo on the kid’s page (or the community project’s): the Partners directory’s logo by the same name or by a website on their email’s domain, else the logo already on another page under that name. When there’s no logo anywhere, staff get one email per company per page with the company, the person’s name and email, their role and the kid, and it waits under Partners → JobTread, no logo. Each change is saved like an admin save, with History, then the site publishes, at most every 10 minutes.',
          touches: ['JobTread', 'D1', 'GitHub', 'Cloudflare Pages', 'Resend'], where: 'functions/api/_kid-partners.js (from broadcast-hooks.js, reveals.js and save-content.js)',
          info: 'The company is the JobTread login’s account, else the person’s name. A logo the page already shows is left as it is, and one staff take off never goes back on. Linzi gets the emails to start with; Partners → JobTread, no logo changes who. “Same as” links a company JobTread names differently (“Randall Bros” for Randall Brothers) once, for every job after; “No logo needed” sets one aside. A kid’s Partners section lists the logos still needed, with an upload named for the company. Jobs named TEST are ignored.',
          live: (f) => {
            const l = f.kidLogos;
            if (!l) return null;
            if (env(f) && !f.env.jobtread) return ATTN('JOBTREAD_GRANT_KEY is missing, so logos can’t follow JobTread.');
            if (!l.lastSweepAt) return ATTN('It hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (l.lastErrorAt && (!l.lastRunAt || l.lastErrorAt > l.lastRunAt)) return ATTN(`The last check of JobTread failed (${stamp(l.lastErrorAt)}). It tries again in 10 minutes.`, l.lastRunAt);
            if (stale(l.lastSweepAt, HOUR)) return ATTN(`Hasn’t checked JobTread since ${stamp(l.lastSweepAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, l.lastRunAt);
            if (l.lastEmailErrorAt && (!l.lastRunAt || l.lastEmailErrorAt >= l.lastRunAt)) return ATTN('The email about missing logos didn’t go. It tries again at the next check; see Emails & invites → What went out.', l.lastRunAt);
            if (env(f) && !f.env.deployHook) return ATTN('No deploy hook is set in Cloudflare, so logos are saved but wait for the next Publish.', l.lastRunAt);
            const waiting = l.waiting ? ` ${plural(l.waiting, 'company is', 'companies are')} waiting for a logo (Partners → JobTread, no logo).` : '';
            return ON(`${l.added ? `The last check put ${plural(l.added, 'logo')} on pages.` : 'Every partner on a job with a logo has it on their page.'}${waiting}`, l.lastRunAt);
          } },
        { t: 'Vendors on their JobTread jobs', s: 'live', k: 'schedule',
          when: 'Every 15 minutes on the live hub’s heartbeat. Adding an email or settling a name in Partners → JobTread access runs that company straight away.',
          does: 'Each open kid or community job lists its vendors in JobTread’s job access: every company whose logo is on the page (the kid’s monetary sponsor aside), and every trade partner with a bill or purchase order on the job (JobTread’s Trades, W-9 or Documents say SOARD pays them for work; a store bought from by card or a materials supplier never goes on). One with nobody on the job yet gets its main contact with an email added, never an insurance agent or billing contact, with no email from JobTread, in its role: its Partners level, or Trade Partner (Vendor until roles follow levels). A company on a page with no JobTread vendor account gets one under its Partners name, with its contacts. Contacts are kept the same both ways between Partners and the vendor account, the newer change winning.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_vendor-access.js · _jt-access.js (from broadcast-hooks.js and vendor-access-admin.js)',
          info: 'A company counts as on the job when anyone from it has access, in any role: a login under its JobTread account, one of its contacts’ emails, or an email on its website. Nobody with an email: it waits in Partners → JobTread access. JobTread naming a vendor nearly the same (“WYP Construction” for Walk Your Plans) isn’t guessed at; staff say Same company or Make a new one. Bills and orders come from JobTread, read every 4 hours. Someone added for a bill alone doesn’t put a logo on the page. Contacts stay private (D1 and JobTread), and History shows names only. JobTread accounts have no logo, so logos stay in Partners. Jobs named TEST are ignored.',
          live: (f) => {
            const v = f.vendorAccess;
            if (!v) return null;
            if (env(f) && !f.env.jobtread) return ATTN('JOBTREAD_GRANT_KEY is missing, so vendors can’t be put on their jobs.');
            if (!v.claimedAt) return ATTN('It hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (v.lastErrorAt && (!v.lastRunAt || v.lastErrorAt >= v.lastRunAt)) return ATTN(`The last run hit a problem (${stamp(v.lastErrorAt)}). Partners → JobTread access says which; it tries again in 15 minutes.`, v.lastRunAt);
            if (stale(v.claimedAt, HOUR)) return ATTN(`Hasn’t run since ${stamp(v.claimedAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, v.lastRunAt);
            const did = [v.added && `added ${plural(v.added, 'vendor')} to jobs`, v.made && `made ${plural(v.made, 'JobTread vendor account')}`, v.contacts && `kept ${plural(v.contacts, 'vendor’s contacts', 'vendors’ contacts')} in step`].filter(Boolean);
            const waiting = (v.waiting || v.near) ? ` ${plural((v.waiting || 0) + (v.near || 0), 'company is', 'companies are')} waiting in Partners → JobTread access.` : '';
            return ON(`${did.length ? `The last run ${did.join(', ')}${v.more ? ', with more next run' : ''}.` : 'Every vendor is on their jobs.'}${waiting}`, v.lastRunAt);
          } },
        { t: 'JobTread roles follow Partners levels', s: 'live', k: 'schedule',
          when: 'Every 15 minutes, at the end of the vendor check. Off until switched on; until then each run writes down what it would change.',
          does: 'A partner’s role in JobTread is its level in Partners: Signature, Champion, Builder or Friend. A company SOARD pays for work that isn’t in Partners is a Trade Partner. Each run finds whose company every partner-role login is (its JobTread vendor account matched in Partners, a contact’s email, the account’s name, or the email on the partner’s website) and changes the role to match, with no email from JobTread. A role changed by hand in JobTread is set back. The level roles and Trade Partner are made in JobTread the first time, with what the old Vendor and Monetary Sponsor roles could see.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_partner-roles.js (from _vendor-access.js; partner-roles-admin.js switches it)',
          info: 'Only partner roles are ever changed: the four levels, Trade Partner, and the old Vendor and Monetary Sponsor. Staff, families, the board, photographers and design partners never are. Someone the site can’t place keeps their role and waits in Partners → JobTread access, where staff say Trade Partner or leave it. Every change is logged with the role before, so switching off with “put back” returns everyone to the role they had. The old roles stay in JobTread.',
          live: (f) => {
            const r = f.vendorAccess?.roles;
            if (!r) return null;
            if (r.error) return ATTN(`The last run couldn’t change a role: ${r.error}`, f.vendorAccess.lastRunAt);
            const left = r.unplaced ? ` ${plural(r.unplaced, 'person', 'people')} the site can’t place ${r.unplaced === 1 ? 'waits' : 'wait'} in Partners → JobTread access.` : '';
            return ON(`${r.changed ? `The last run changed ${plural(r.changed, 'role')}.` : r.pending ? `${plural(r.pending, 'role')} to change.` : 'Every partner’s role matches its level.'}${left}`, f.vendorAccess.lastRunAt);
          } },
        { t: 'Monetary sponsor ↔ JobTread', s: 'live', k: 'schedule',
          when: 'A kid’s profile is saved with a sponsor picked, changed or taken off (or while JobTread doesn’t match yet), a sponsor’s contacts are saved, and every 10 minutes on the live hub’s heartbeat, right after the logo check.',
          does: 'The website is the source of truth for who pays for a room (Admin → Kids → Monetary sponsor, picked from Partners or added with their logo and contact). Job access comes first: each contact with an email is given the kid’s open job in the sponsor’s role (its Partners level once roles follow levels, Monetary Sponsor until then), with no email from JobTread, so the Demo Day and reveal invites reach them; a sponsor taken off the kid loses that access unless its logo stays on the page. Then the job’s Monetary Sponsor field mirrors the sponsors with someone on the job, blank until one does. Every 10 minutes it also takes in what was done in JobTread: someone given the Monetary Sponsor role there, or a Monetary Sponsor naming a Partner, becomes the kid’s sponsor, with that person as a contact and their logo first on the page.',
          touches: ['JobTread', 'D1', 'GitHub', 'Cloudflare Pages'], where: 'functions/api/_sponsors.js · _jt-access.js (from sponsors-admin.js and broadcast-hooks.js)',
          info: 'Contacts are private: D1 partner_contacts, never the partner record or the site. Someone already in JobTread under another partner role (a Vendor) is added and keeps it until the roles check moves it; someone under a role that isn’t a partner’s (a Photographer) isn’t the sponsor’s, and the sponsor card says so. A sponsor staff took off a kid is never taken back in from JobTread. A Monetary Sponsor typed in JobTread that isn’t a Partner is left alone until a sponsor’s person is on the job; the kid’s card offers to add it. Kids only, not community projects. Jobs named TEST are ignored.' },
        { t: 'Kid photo as the job’s cover', s: 'live', k: 'schedule',
          when: 'As soon as a kid’s profile is saved with a new best photo, and with the kid status sync (JobTread’s workflows for one job, the hourly sweep for all of them) as the safety net.',
          does: 'Puts each kid’s best photo on their JobTread job as its cover: the profile’s Main photo, else the gallery’s first, cropped around the face or the focal point. A job made when a family is approved starts with the child’s photo from their application, and the family photos replace it once they’re on the profile, usually after the job exists. An organization’s job shows its community project’s Main photo the same way.',
          touches: ['JobTread'], where: 'functions/api/_job-covers.js (from save-content.js, _kid-status.js and _applicant-approved.js)',
          info: 'Replaces the Google Street View picture of the house that DataX used to add (Peter turned that off in DataX on Oct 20, 2026). A cover only changes when the kid’s photo does, so one picked by hand in JobTread stays until then. A few jobs per run.',
          live: (f) => {
            const c = f.covers;
            if (!c) return null;
            if (env(f) && !f.env.jobtread) return ATTN('JOBTREAD_GRANT_KEY is missing, so job covers can’t be set.');
            if (c.failing) return ATTN(`${plural(c.failing, 'job')} couldn’t take the kid’s photo yet. It tries again with the next sync.`, c.last?.at);
            return ON(c.covers ? `${plural(c.covers, 'job shows', 'jobs show')} the kid’s photo.` : 'No job has a kid’s photo yet: the first sync sets them.', c.last?.at);
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

  { t: 'Applications', sub: 'Families and community projects apply on the site → JobTread', color: 'apply', side: 'r',
    about: 'The makeover application lives on the site (it replaced Jotform and the Zapier Zaps in October 2026), and so does the community project application for schools, clinics and nonprofits (October 28 2026). Each submission becomes a JobTread customer account with nothing done by hand; staff review in JobTread.',
    children: [
      { t: 'The form', children: [
        { t: 'Makeover application', s: 'live', k: 'visitor',
          when: 'A family fills in /apply/form/ (open or closed per Applications → Settings; a saved application can always be finished).',
          does: 'Walks them through the questions page by page, saves as they go, resizes and stores photos, uploads the video straight to Cloudflare Stream, shows a review page, then submits.',
          touches: ['D1', 'R2', 'Cloudflare Stream'], where: 'src/pages/apply/form.astro · functions/api/apply.js · _application-form.js',
          info: 'The form is data, edited in Admin → Applications → Form; each application keeps the version it was answered on. The page gets the live version embedded by functions/apply/form/[[path]].js.',
          live: (f) => (!env(f) ? null : !f.env.stream ? ATTN('Video uploads need CF_ACCOUNT_ID and CF_STREAM_TOKEN in Cloudflare.') : ON()) },
        { t: 'Community project application', s: 'live', k: 'visitor',
          when: 'A school, therapy clinic or nonprofit fills in /apply/community-project/ (all year, unless switched off in Applications → Settings → Community projects). The Apply page, the Community page and the site menu link to it.',
          does: 'The same pages, saving, address check, photos and review as the family form, with the organization’s own questions and no video. It submits into the same intake: a JobTread account named for the organization, its contacts, address, space photos and a PDF copy, worded for an organization.',
          touches: ['D1', 'R2', 'JobTread'], where: 'src/pages/apply/community-project.astro · src/components/apply/ApplicationPage.astro · functions/api/_application-form-org.js',
          info: 'Its own versions and emails in Admin → Applications (Makeovers | Community projects), and in Settings its own switch and new-application email list (the makeovers’ list until it gets one). It shares the makeovers’ service area and status-email timing. In English. Outside the family season’s limit. Once approved, it gets its job and a hidden Community project draft.' },
        { t: 'Service-area check', s: 'live', k: 'visitor',
          when: 'A family types the child’s home address on /apply/form/ (about a second after they stop typing, or at once when they pick a suggestion), again on submit, and once more at intake if the form couldn’t place the home.',
          does: 'Asks the U.S. Census geocoder where the address is and places it against the service area in Settings → Service area: inside, close (within the “close” miles) or farther out. That answers the form’s service-area question, and the form shows the home on a map. If the Census can’t find the address, the family answers the question themselves. Families farther out are told and can still apply, or are stopped, per Settings.',
          touches: ['U.S. Census', 'D1'], where: 'functions/api/apply.js (action “area”) · _applications.js (areaCheck, the service-area intake step) · _geo.js · public/admin/area-shared.js',
          info: 'Staff see the result on the family: the Applicants map, the staff email, Slack, and an internal JobTread note when the home isn’t inside or the county differs. There’s nothing to poll and no keys. Insights → “Where families live” counts each season’s checks (inside, close, farther, not found), so a run of “not found” means the Census is misbehaving.' },
        { t: 'Open and close on schedule', s: 'live', k: 'schedule',
          when: 'Every minute, when an open or close time is set in Applications → Settings.',
          does: 'Opens or closes applications at that time, logs it in Recent changes as done by the schedule, and posts a note in Slack.',
          touches: ['D1', 'Slack'], where: 'functions/api/_applications.js (runApplicationSchedule, on the heartbeat sweep)',
          info: 'Opening or closing by hand clears the time it replaces. The form and the Apply page follow at once.' },
        { t: 'Application limit', s: 'live', k: 'event',
          when: 'Every application that comes in (and the 2-minute sweep as a backup), once a limit is set in Applications → Settings (switch on “Close at a number of applications”).',
          does: 'Counts the season’s applications, leaving out tests and deleted ones. At the heads-up point (80% of the limit unless Settings says otherwise) the team hears once, in Slack and by email to the staff list: how many are in and left, families partway through the form, and the pace. At the limit it closes applications by itself, logs it as done by the limit and tells the team the same way; the Apply page and the form then say the season is full.',
          touches: ['D1', 'Slack', 'Resend'], where: 'functions/api/_application-cap.js · _applications.js (enforceApplicationCap, after each submit in apply.js and on the sweep)',
          info: 'Families who already started can still finish after it closes, so a season can end a little over. A full season can’t be opened, by hand or on a schedule, until the limit goes up or comes off; a scheduled opening that finds it full stays closed and posts in Needs attention.',
          live: (f) => {
            const l = f.applicationLimit;
            if (!l || l.error) return null;
            if (!l.max) return OFF(`No limit is set for ${l.year}, so applications stay open until someone closes them.`);
            const last = l.last ? ({ warn: 'Last notice: the heads-up', full: 'Last notice: it filled and closed', blocked: 'Last notice: a scheduled opening was skipped' })[l.last.kind] : null;
            const where = l.full ? `The ${l.year} season is full: ${l.received} of ${l.max} are in.` : `${l.received} of ${l.max} are in for ${l.year}; the team hears at ${l.warnAt}${l.open ? '' : ' (applications are closed now)'}.`;
            return ON(last ? `${where} ${last}.` : where, l.last?.at);
          } },
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
          when: 'A family (or an organization) submits.',
          does: 'Creates the customer account (Status Applied, Diagnosis, Birthday, Gender, Language, Referred By, Verbal, Mobile, Makeover Year and Type, Application URL), the parents as contacts and the home as a location, and attaches the application PDF and four photos. The video follows once Stream has processed it. An organization’s account has its name, its contacts and address, the spaces JobTread’s Makeover Type knows, and nothing of a child’s.',
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
          does: 'Each application’s checklist (account, contacts, home, PDF, photos, video, messages) with Retry and “See what a family receives” (a sample sent only to the person who asks, archived in JobTread on its own); the form editor (questions, choices, show-when rules, stop screens), the family messages, and version history. Put live takes effect right away, no Publish.',
          touches: ['D1'], where: 'public/admin/applications.js · functions/api/applications-admin.js · _application-forms.js' },
        { t: 'Admin → Applicants', s: 'live', k: 'admin',
          does: 'Every applicant family in JobTread as a board (drag to change status), list, map against the red service-area boundary, and activity feed. A family’s page shows the whole conversation (emails, replies, logged texts and calls, notes) and edits the JobTread details in place. Status changes, emails, notes and archiving are written to JobTread first (no texting from the site: families text SOARD’s Quo number); a status change shows the family’s email before it goes and sends the same message a change in JobTread would, once.',
          touches: ['JobTread', 'D1'], where: 'public/admin/applicants.js · functions/api/applicants-admin.js · _applicants.js' },
        { t: 'Status change summary', s: 'live', k: 'schedule',
          when: 'A few minutes after someone stops changing statuses in JobTread.',
          does: 'Emails that person one summary of the families they moved and when each family will be emailed, with Move back, Don’t email and Send now for each (one-time links; a confirmation page, so mail scanners can’t trigger them). Changes by an integration go to the staff list. Families’ emails wait 5 minutes after the summary. Admin → Applicants also has “Pause family emails” (⋯ menu), which holds family emails for up to 2 hours while a lot of statuses change at once.',
          touches: ['Resend', 'JobTread', 'D1'], where: 'functions/api/_applicant-notify.js · applicant-email-action.js' },
        { t: 'JobTread → Applicants sync', s: 'live', k: 'schedule',
          when: 'With the application sweep (every 2 minutes), right after the status workflow’s call, and whenever a family is opened.',
          does: 'Reads JobTread’s event log forward from where it left off and keeps the Applicants mirror and history current with work done in JobTread (status, details, comments, texts, files, contacts, the home and its map point). Re-reads every applicant account every 30 minutes; the history was backfilled once to January 2025.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_applicants.js · _applications.js maybeSweepApplications' },
      ]},
      { t: 'Status messages', children: [
        { t: 'Status → family message', s: 'live', k: 'event',
          when: 'Someone changes an applicant’s Status (or Diagnosis) in JobTread, or on the site.',
          does: 'Emails the family the status they should know once it has stayed put: In Review after 10 minutes, Approved or Denied after 30, never 8 PM to 8 AM Eastern (all set in Admin → Applications → Messages). A status flipped back and forth sends one email for where it lands, or none; cleared or unknown statuses never email. Moving below what the family was told leaves a staff note and offers a correction. Replaces the Zapier Zaps.',
          touches: ['JobTread'], where: 'JobTread workflow “Applicant Status/Diagnosis → Site applicant messages” → functions/api/applicant-sync.js',
          info: 'Switched on Oct 20, 2026, the day the Zapier Zaps were retired. If a Zapier webhook ever shows up in JobTread again, this turns Needs attention, because families could get a message twice.',
          live: (f) => {
            const zap = Object.values(f.jobtread?.webhooks || {}).some((h) => /zapier\.com/i.test(h.where || ''));
            if (zap) return ATTN('A Zapier webhook is back in JobTread, so families could get a status message twice. Turn the Zap off in Zapier.');
            // JobTread's old “Qualification Committee Comments” workflow posts its own In Review note
            if (f.jobtread?.workflows?.['22PRvF7pG9VM']?.active) return ATTN('JobTread’s old “Qualification Committee Comments” workflow is switched on, so families in review get two messages. Switch it off in JobTread → Workflows.');
            return wf('22PgaEgWTBRH')(f);
          } },
        { t: 'Approved → job and its page', s: 'live', k: 'schedule',
          when: 'A family’s Approved status has settled: their decision email is out (or staff chose not to email) and 30 minutes have passed. Checked by the application sweep every 2 minutes; nothing happens while family emails are paused.',
          does: 'Makes the makeover’s JobTread job the way the old Zap did (“Name (Year)”, Status On Site, Makeover Type, at the family’s home, as the Qualification Committee), or uses the job they already have, with the child’s photo from the application as its cover. Then makes a hidden profile in Kids (first name, age, year, rooms, Awaiting funding), linked to that job so its status follows JobTread. An organization (no birthday or diagnosis: a school, a clinic) gets a hidden community project instead, under its name, In progress and first on the Community page, linked the same way. Posts the good news to Slack and notes it in the family’s history.',
          touches: ['JobTread', 'D1', 'GitHub', 'Slack'], where: 'functions/api/_applicant-approved.js (from _applications.js maybeSweepApplications)',
          info: 'Nothing private goes in the profile, because its GitHub copy is public: no last name, diagnosis, address or photos. It stays off Meet the Kids until staff add the story and photos and switch on “Show on Meet the Kids”. A profile or project staff already made is linked, never rewritten. Organizations approved before projects were made this way (The Lionheart School, Oct 21 2026) get theirs on the next run. Families approved before this started are never touched, and nothing is deleted if a family is moved back later. A family missing a home address or *Makeover Year is one Slack problem that turns ✅ once it’s done. Replaces the Zapier “account updated” Zap.',
          live: (f) => {
            const a = f.approvals;
            if (!a) return null;
            if (env(f) && !f.env.jobtread) return ATTN('JOBTREAD_GRANT_KEY is missing, so approved families get no job or profile.');
            if (!a.lastRunAt) return ATTN('It hasn’t run yet. It rides on the application sweep, so check the Heartbeat entry.');
            if (a.lastErrorAt && a.lastErrorAt > a.lastRunAt) return ATTN(`The last run failed (${stamp(a.lastErrorAt)}). It tries again with the next sweep.`, a.lastRunAt);
            if (stale(a.lastRunAt, 30 * MIN)) return ATTN(`Hasn’t run since ${stamp(a.lastRunAt)}. It rides on the application sweep, so check the Heartbeat entry.`, a.lastRunAt);
            const WHY = { 'no-home': 'needs a home address in JobTread', 'no-year': 'needs a *Makeover Year in JobTread', error: 'JobTread refused, trying again' };
            if (a.waiting.length) return ATTN(a.waiting.map((x) => `${x.name} ${WHY[x.problem] || 'is waiting'}.`).join(' '), a.lastRunAt);
            return ON(a.last ? `Last set up ${a.last.name}${a.last.project ? ' (a community project)' : ''} (${stamp(a.last.at)}).` : 'No family has been approved since it started.', a.lastRunAt);
          } },
        { t: 'A family replied → staff alert', s: 'live', k: 'event',
          when: 'A family answers a JobTread message, by replying to its email or in JobTread. The Applicants sync reads JobTread about every minute, and each reply alerts once.',
          does: 'Posts a card in the Slack alerts channel and emails the staff list in Applications → Settings: who replied (by email, or in JobTread’s family portal), what they wrote and the family’s status. Reply opens the family’s page answering in that same JobTread conversation; more replies in one conversation thread under one Slack post. In the admin, Applications counts families waiting on an answer, a notice pops up on any page, the Dashboard lists them, and their card and page say so until someone answers or chooses No reply needed. JobTread itself notifies no one about these replies.',
          touches: ['JobTread', 'Slack', 'Resend', 'D1'], where: 'functions/api/_applicant-replies.js (from _applicants.js syncEvents)',
          info: 'Only replies that arrive after it was switched on (Oct 23, 2026). TEST families get a test card, and their email goes only to the alert address.',
          live: (f) => {
            const r = f.replyAlerts;
            if (!r) return null;
            if (!r.last) return ON('No family has replied since it started.');
            if (/^not/.test(r.last.slack || '') || /^not/.test(r.last.email || '')) return ATTN(`The last alert (${stamp(r.last.at)}): Slack ${r.last.slack || 'unknown'}, email ${r.last.email || 'unknown'}.`, r.last.at);
            return ON(`Last alert ${stamp(r.last.at)}, in Slack and by email.`, r.last.at);
          } },
        { t: 'Family emails → JobTread', s: 'live', k: 'schedule',
          when: 'Every 3 minutes on the heartbeat, for every active SOARD Google account.',
          does: 'An email to or from a family (an address on their JobTread account) that went through someone’s own inbox becomes a comment on the family’s account, so JobTread has the whole conversation: who wrote to whom and when, the words without the quoted history, and the photos and files. The family can’t see it and nobody is assigned, so JobTread emails no one. Replies go under the first email of their conversation. The last year of these emails is brought in once, oldest first.',
          touches: ['Gmail', 'JobTread', 'D1'], where: 'functions/api/_mail-sweep.js (broadcast-hooks.js; reads with _mailbox.js)',
          info: 'Calendar replies, JobTread’s own emails and mailings to more than three families are left out. An address on two families’ accounts (a caseworker) points at neither. The same email in two inboxes is added once. Its first day only watches, then adds what it found.',
          live: sweepLive('family') },
        { t: 'CompanyCam for families in review', s: 'off', k: 'event',
          when: 'Would run when a family moves to In Review (the home visit). Off since Oct 21, 2026: the home visit happens at the job, where JobTread’s own CompanyCam sync (and the check below) has it.',
          does: 'Makes one CompanyCam project for the family at their home, with their contact, a “Vetting” label and their application photos of the space, copies every home-visit photo to the family in JobTread (Files → Home visit, .BeforePics), and links the job to that project when it’s made.',
          touches: ['CompanyCam', 'JobTread', 'D1', 'Slack'], where: 'functions/api/_companycam-sync.js (broadcast-hooks.js) · companycam-webhook.js · _companycam.js; the job’s link in _applicant-approved.js',
          info: 'Built and proven end to end on Oct 21, 2026, then switched off by Peter. COMPANYCAM_CUSTOMER_STAGE set to on in Cloudflare turns it back on. Its webhook, the CompanyCam key and the copies already made stay; the check below uses them.',
          live: (f) => (!env(f) ? null : f.env.companycamCustomerStage ? ON('On: families in review get a CompanyCam project.') : OFF('Off: the home visit happens at the job. COMPANYCAM_CUSTOMER_STAGE on in Cloudflare turns it back on.')) },
        { t: 'CompanyCam photos on every job', s: 'live', k: 'schedule',
          when: 'Every open job (not TEST) about once an hour, a couple a minute on the heartbeat. A new photo in a job’s project moves that job to the front (CompanyCam’s webhook).',
          does: 'Copies to each job any CompanyCam photo it doesn’t have, under JobTread’s own name (“CompanyCam 123…”). A job’s photos come from the project it’s linked to, the project its own earlier photos came from, and a project at the same address under the family’s name. A photo in the project JobTread is still linked to waits an hour, so JobTread’s own sync goes first. It never relinks a job: relinking makes JobTread copy every photo again. Second copies JobTread makes are removed. Slack hears once a pass what was copied and removed.',
          touches: ['CompanyCam', 'JobTread', 'D1', 'Slack'], where: 'functions/api/_companycam-jobs.js (broadcast-hooks.js) · _companycam.js · companycam-webhook.js',
          info: 'By Oct 21, 2026 JobTread’s own integration had dropped the link on 16 of 21 open jobs, some families’ photos sat in a second project, and staff were uploading phone photos by hand. A relink tested on Axel’s job brought all 33 photos in a second time, so that’s where duplicates come from. A photo on a job twice keeps its oldest copy; later copies made by JobTread or the site are removed (never a person’s upload, never one with comments, at most 50 a run). Videos stay in CompanyCam: its API gives a stream, not a file.',
          live: (f) => {
            if (!env(f)) return null;
            if (!f.env.companycam) return OFF('Off until COMPANYCAM_TOKEN is in Cloudflare.');
            const c = f.companycamJobs;
            if (!c || c.error || !c.on) return null;
            if (!c.lastChecked) return ATTN('It hasn’t run yet. It rides on the heartbeat, so check the Heartbeat entry.');
            if (stale(c.lastChecked, 3 * HOUR)) return ATTN(`Hasn’t checked a job since ${stamp(c.lastChecked)}. It rides on the heartbeat.`, c.lastChecked);
            const a = c.audit;
            if (!a) return ON('Going through the open jobs for the first time.', c.lastChecked);
            if (a.errors?.length) return ATTN(`${plural(a.errors.length, 'job')} couldn’t be checked: ${a.errors[0].job} (${a.errors[0].detail}).`, c.lastChecked);
            const doubles = a.doubleCopies ? ` ${plural(a.doubleCopies, 'second copy', 'second copies')} counted${c.dedupe ? '' : ', not removed yet'}.` : '';
            return ON(`${plural(a.withPhotos, 'open job')} with CompanyCam photos${a.missing ? `, ${plural(a.missing, 'photo')} still to copy` : ', every photo in JobTread'}.${doubles}`, c.lastChecked);
          } },
      ]},
      { t: 'The process', children: [
        { t: 'Process from Google Docs', s: 'live', k: 'link',
          when: 'Someone opens Site → Automations → Process (Drive is asked at most every 2 minutes), and hourly on the heartbeat.',
          does: 'Reads SOARD’s two process Docs in the shared drive, “2026 Sunshine Makeover Process” and “2026 Sunshine Community Project Process”, as they are, and shows each step with the automations that do its work. The money side (accounts payable, gifts and deposits, books and reporting) has no process Doc: its steps show how it runs, each with the sections of the board’s “Board Financial Policy Manual” that govern it, read the same way, and bill approvals are checked against the manual’s approval tiers. Next year’s Docs are followed on their own once they exist (the latest year in the name wins); a Doc named some other way can be pasted in Process.',
          touches: ['Google Drive', 'D1'], where: 'functions/api/process-admin.js · _process-docs.js · public/admin/process.js · process-shared.js',
          info: 'Each Doc is due for a yearly review a year after it last changed or was last marked “Reviewed, no changes” in Process; overdue, this turns Needs attention. Read as whoever opens Process, through the site’s Google service account (drive.readonly, like Board’s minutes), and never written to. If Drive can’t be read, Process shows the last copy it read and says so. Before the Doc’s Onsite step, the makeover track shows how families apply on the website, in the steps of the 2026 Application Timeline handout.',
          live: (f) => {
            const p = f.processDocs;
            if (!p || p.error) return null;
            const docs = ['makeover', 'community', 'policy'];
            const docName = (t) => (p[t]?.name ? `“${p[t].name}”` : { makeover: 'The makeover process Doc', community: 'The community project process Doc', policy: 'The board’s Financial Policy Manual' }[t]);
            const bad = docs.filter((t) => p[t]?.error);
            if (bad.length) return ATTN(`${docName(bad[0])}: ${p[bad[0]].error}${p[bad[0]].readAt ? ' Process shows the copy it last read.' : ''}`, p[bad[0]].readAt || null);
            const read = docs.filter((t) => p[t]?.readAt);
            if (!read.length) return ON('Reads the Docs the first time Process opens.');
            // Each Doc is looked over once a year: changed, or marked “Reviewed, no changes” in Process
            const due = read.find((t) => reviewOf(p[t], { reviewedAt: p[t].reviewedAt, yearly: t !== 'policy' })?.state === 'due');
            if (due) return ATTN(`${docName(due)} is due for its yearly review. Open Process, look it over, and change the Doc or mark it reviewed.`, p[due].checkedAt || p[due].readAt);
            const last = read.map((t) => p[t].checkedAt || p[t].readAt).sort().pop();
            return ON(`Following ${read.length > 2 ? `${read.slice(0, -1).map(docName).join(', ')} and ${docName(read.at(-1))}` : read.map(docName).join(' and ')}.`, last);
          } },
        { t: 'Makeover scoring', s: 'live', k: 'admin',
          when: 'Each person on the selection team opens a family’s Score tab in Applications → Applicants.',
          does: 'Scores the family on the rubric’s 10 criteria, 1 to 5 each, one at a time and saved as they go. The family’s score is the average of everyone’s totals, and the Scores view ranks the season once everyone scoring it has finished. Family readiness waits for the home visit.',
          touches: ['D1'], where: 'public/admin/applicants.js · scoring-shared.js · functions/api/_applicant-scores.js',
          info: 'Community projects aren’t scored.' },
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
            return ON(phoneEvent(f.health?.webhookEvent) ? `Ready. The phone last ${phoneEvent(f.health.webhookEvent)}` : 'Ready for the phone.', f.health?.webhookAt);
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
            // Never set up is a choice, not a fault: it waits under Off with the one step that turns it on
            if (o.youtube === null) return OFF(`Not set up, so reveals don’t reach YouTube. To add it, paste the stream key from YouTube Studio (Go live → Stream key, with Auto-start and Auto-stop on) in ${SETTINGS}.`);
            if (!o.youtube) return OFF(`The YouTube output is switched off in ${SETTINGS}.`);
            return ON();
          } },
        { t: 'Stream event webhook', s: 'live', k: 'event',
          when: 'Stream reports the live input connected, disconnected or errored.',
          does: 'Forces an immediate update and pushes it to every open page. An error sends an alert. Both need the webhook’s secret to match STREAM_WEBHOOK_SECRET; without it, a call is only a hint to check Stream.',
          touches: ['Cloudflare Stream', 'Cloudflare Notifications'], where: 'functions/api/stream-webhook.js',
          live: (f) => {
            if (!f.health) return null;
            if (f.env && 'streamWebhookSecret' in f.env && !f.env.streamWebhookSecret) return ATTN('No STREAM_WEBHOOK_SECRET in Cloudflare, so Stream’s calls can’t be told from anyone else’s and send no alerts. Give the webhook destination a secret and add the same value as STREAM_WEBHOOK_SECRET.', f.health.webhookAt);
            const ev = phoneEvent(f.health.webhookEvent);
            return { why: f.health.webhookAt ? (ev ? `Last event: ${ev}.` : 'Last call was a test.') : 'No events received yet.', last: f.health.webhookAt };
          } },
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
        { t: 'Live hub', s: 'live', k: 'event',
          when: 'Every open page keeps a socket to the hub.',
          does: 'Pushes live state, viewer counts, reactions and approved family messages to every viewer instantly.',
          touches: ['Live hub'], where: 'workers/live-hub (Worker “soard-live-hub”)',
          live: (f) => {
            const hb = f.hub;
            if (!hb || !f.bindings) return null;
            if (!f.bindings.hub) return ATTN('The site isn’t connected to the hub (the LIVE_HUB binding is missing).');
            if (!hb.ok) return ATTN(`The hub isn’t answering${hb.error ? `: ${hb.error}` : ''}.`);
            if (!hb.current) return ATTN('It’s running code from before the watch party, so reactions and viewer counts don’t work and family messages fall back to 20-second polling. Redeploy workers/live-hub while signed in to SOARD’s Cloudflare account.', hb.lastTickAt);
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
        { t: 'Alert texts', s: 'off', k: 'event',
          when: 'Reveal day only: a feed problem and when it clears, the go / no-go, “Live now”, “All green” once the feed checks out, a Stream input error, a missed reveal, and the reveal-day health check.',
          does: 'Texts the staff numbers in Reveals → Settings → Alerts. Never anyone else: the public is not texted.',
          touches: ['Twilio'], where: 'functions/api/_broadcast-notify.js (textStaff, alertText)',
          note: 'Off until the Twilio keys are in Cloudflare and a staff number is on the list.',
          live: (f) => {
            if (!env(f)) return null;
            const n = f.broadcast?.alertPhones || 0;
            if (!f.env.twilio) return n ? ATTN(`${plural(n, 'number is', 'numbers are')} on the list, but the Twilio keys (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or an API key, TWILIO_MESSAGING_SERVICE_SID) aren’t in Cloudflare.`) : OFF('Off until the Twilio keys are in Cloudflare and a staff number is on the list.');
            if (!n) return OFF(`No staff numbers yet. Add them in ${SETTINGS} → Alerts.`);
            const t = f.broadcast?.alertTexts;
            if (t?.failed) return ATTN(`The last text didn’t reach ${plural(t.failed, 'number')}${t.error ? `: ${t.error}` : ''}.`, t.at);
            const miss = f.broadcast?.textMisses;
            if (miss) return ATTN(`Twilio says the last text to ${plural(miss.count, 'staff number')} didn’t arrive${miss.why ? `: ${miss.why}` : ''}.`, miss.at);
            return ON(`${plural(n, 'staff number')} on the list.`, t?.at || null);
          } },
        { t: 'Text delivery reports', s: 'off', k: 'event',
          when: 'Twilio reports on each staff text, a few seconds after it goes.',
          does: 'Keeps whether each staff number’s last text arrived (shown in Reveals → Settings → Alerts). A text that didn’t arrive tells staff in Slack and by email, once a day per number.',
          touches: ['Twilio', 'D1', 'Slack', 'Resend'], where: 'functions/api/twilio-status.js · _broadcast-notify.js (recordTextStatus)',
          info: 'Signed by Twilio with the account’s auth token; anything unsigned is refused.',
          note: 'Off until TWILIO_AUTH_TOKEN is in Cloudflare.',
          live: (f) => (!env(f) ? null : !f.env.twilioToken ? OFF('Off until TWILIO_AUTH_TOKEN is in Cloudflare (the reports are checked with it).') : f.broadcast?.textMisses ? ATTN(`The last text to ${plural(f.broadcast.textMisses.count, 'staff number')} didn’t arrive${f.broadcast.textMisses.why ? `: ${f.broadcast.textMisses.why}` : ''}.`, f.broadcast.textMisses.at) : ON('Every staff number’s last text arrived, or none has gone yet.')) },
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
  { t: 'The board', sub: 'Meetings, minutes and the board’s own page', color: 'board', side: 'l',
    children: [
      { t: 'Signing in', children: [
        { t: 'Board sign-in list', s: 'off', k: 'schedule',
          when: 'Every 5 minutes on the live hub’s heartbeat when People → Board changed (someone joins, leaves, or gets a new email), and every 6 hours anyway.',
          does: 'Keeps Cloudflare Access’s group “SOARD board (kept by the website)” to exactly the active board’s private emails, so each can sign in at sunshineonaranneyday.com/board with an emailed code, the way staff do. A board sign-in opens the board page and nothing else in the admin.',
          touches: ['Cloudflare Access', 'D1'], where: 'functions/api/_board-access.js, _board-roles.js (broadcast-hooks.js, _middleware.js)',
          note: 'Needs CF_ACCESS_API_TOKEN in Cloudflare (Access groups, and apps and policies, Edit), then the “SOARD board members” policy added once to the admin’s Access application. Board → Members walks through it.',
          info: 'The site never edits the admin’s Access application itself, so a mistake can’t lock staff out. Staff are soardcharity.com sign-ins; anyone else Access lets in reaches only /api/board-portal and /api/board-file, and only if they’re on the active board.',
          live: (f) => {
            const b = f.board;
            if (!b || b.error) return null;
            const a = b.access;
            if (!a.configured) return ATTN('Not connected yet. Add CF_ACCESS_API_TOKEN in Cloudflare; Board → Members has the steps.');
            if (a.error && !a.ok) return ATTN(`Cloudflare refused the list: ${a.error}`, a.syncedAt);
            if (!a.attached) return ATTN('The list is kept, but the “SOARD board members” policy isn’t on the admin’s Access application yet. Board → Members says where.', a.syncedAt);
            if (!a.current) return ATTN('People → Board changed and the list hasn’t caught up. It rides on the live hub’s heartbeat, so check the Heartbeat entry.', a.syncedAt);
            return ON(`${plural(a.emails, 'board member')} can sign in.${a.missing ? ` ${plural(a.missing, 'member has', 'members have')} no email on People → Board.` : ''}`, a.syncedAt);
          } },
      ]},
      { t: 'Meetings', children: [
        { t: 'Board meetings from the calendar', s: 'off', k: 'schedule',
          when: 'Every hour on the live hub’s heartbeat, and whenever Peter or Holly opens Board (if the last look is over 10 minutes old).',
          does: 'Reads the Board area’s admins’ Google calendars for events named like a board meeting (“SOARD Q4 Board Meeting”, “Board Meeting”, or “board” in the name with three or more board members invited), four years back and ahead, and makes each one a meeting in Board with its day, time, place and video link. A past one comes in as a record for its agenda and minutes (from email, below); a moved event moves the meeting; a meeting added by hand on the same day is linked, not doubled. Advisory Board, reveal and demo day events never count.',
          touches: ['Google Calendar', 'D1'], where: 'functions/api/_board-calendar.js (broadcast-hooks.js via _board.js maybeRunBoard, board-admin.js)',
          info: 'It only reads; the meeting invite (below) is the one thing Board writes to a calendar. New meetings aren’t shared with the board until Peter or Holly shares them. Board’s own invites aren’t brought in again: only the board’s replies come back from them.',
          live: (f) => {
            const c = f.board?.calendar;
            if (!c) return null;
            if (!c.configured) return ATTN('GOOGLE_CALENDAR_KEY is missing, so meetings are added by hand in Board.');
            if (c.failing) return ATTN(`Couldn’t read ${plural(c.failing, 'calendar')} on the last look. Board → Meetings says why.`, c.checkedAt);
            if (!c.checkedAt) return ATTN('Hasn’t looked yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (stale(c.checkedAt, 3 * HOUR)) return ATTN(`Hasn’t looked since ${stamp(c.checkedAt)}. Check the Heartbeat entry.`, c.checkedAt);
            return ON(`${plural(c.found, 'board meeting')} ahead on the calendars${f.board.calendarPast ? `, ${f.board.calendarPast} past` : ''}.`, c.checkedAt);
          } },
        { t: 'Google Drive → past minutes and packets', s: 'live', k: 'schedule',
          when: 'Every minute on the live hub’s heartbeat while there’s a backlog (newest meetings first, about 8 seconds a look), then hourly, and when Board is opened.',
          does: 'Reads the Board folder in Google Drive (Board → Settings; the Sunshine - Leadership one until set): in each year’s folder (“2025 Board”), each meeting’s folder (“7.24.25 Meeting”). That meeting comes into Board, or the calendar’s meeting that week gets it, with every file in the folder: the minutes (who was there read from them, and the agenda when it reads cleanly), the financial statements, the reports and the packet. Google Docs, Sheets and Slides come across as PDFs. The meeting goes on the board page. Loose files in a year’s folder, photos and Pages files stay in Drive. It never changes anything in Drive.',
          touches: ['Google Drive', 'Workers AI', 'D1', 'R2'], where: 'functions/api/_board-drive.js (via _board.js maybeRunBoard, board-admin.js)',
          note: 'Needs https://www.googleapis.com/auth/drive.readonly on the service account’s domain-wide delegation and the Google Drive API turned on in its Google Cloud project. Board → Meetings shows both steps until they work.',
          live: (f) => {
            const d = f.board?.drive;
            if (!d) return null;
            if (d.needsScope || d.apiOff) return ATTN('Google Drive isn’t allowed yet. Board → Meetings has the step.', d.checkedAt);
            if (d.failing) return ATTN('The last look couldn’t read the Board folder. Board → Settings says why.', d.checkedAt);
            if (!d.checkedAt) return ATTN('Hasn’t looked yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            return ON(d.backlog ? `${plural(d.backlog, 'meeting folder')} still to read.` : `${plural(d.meetings || 0, 'meeting')} with ${plural(d.files || 0, 'file')} from Drive.`, d.checkedAt);
          } },
        { t: 'Board mail → agendas, minutes and financials', s: 'live', k: 'schedule',
          when: 'Every minute on the live hub’s heartbeat while there’s a backlog (newest email first, about 12 seconds a look), then hourly, and when Board is opened.',
          does: 'Searches Peter and Holly’s Gmail (five years) for board meeting email with attachments. Workers AI reads each file and says what it is (agenda, minutes, financials, a packet, or not board material); resumes, weekly QuickBooks reports and files over 15 MB are left out unread. Each file lands on its meeting by the date it names: an agenda fills a meeting’s agenda while it’s still a draft, minutes fill in who was there, and a dated agenda or minutes with no meeting brings that meeting in. A file emailed to the board (three or more of them, or SOARD’s Google Group) is the board’s, and its past meeting goes on the board page; anything else is staff only. The same email in both inboxes is read once. It never sends, deletes, labels or marks anything read.',
          touches: ['Gmail', 'Workers AI', 'D1', 'R2'], where: 'functions/api/_board-mail.js (via _board.js maybeRunBoard, board-admin.js)',
          note: 'Needs Google Admin → Security → API controls → Domain-wide delegation: add https://www.googleapis.com/auth/gmail.readonly to the site’s service account, and the Gmail API turned on in its Google Cloud project. Board → Meetings shows both steps until they work.',
          live: (f) => {
            const m = f.board?.mail;
            if (!m) return null;
            if (!m.configured) return ATTN('GOOGLE_CALENDAR_KEY is missing.');
            if (m.needsScope) return ATTN('Google Admin hasn’t allowed Gmail reading yet. Board → Meetings has the client ID and the scope to add.', m.checkedAt);
            if (m.failing) return ATTN('The last look couldn’t read every inbox. Board → Meetings says why.', m.checkedAt);
            if (!m.checkedAt) return ATTN('Hasn’t looked yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            return ON(m.waiting ? `${plural(m.waiting, 'email')} still to read.` : `Up to date: ${plural(m.meetings, 'meeting')} with ${plural(m.files, 'file')} from email${m.skipped ? `, ${m.skipped} left out` : ''}.`, m.checkedAt);
          } },
        { t: 'The next agenda, drafted from the last', s: 'live', k: 'schedule',
          when: 'Every ten minutes on the live hub’s heartbeat.',
          does: 'Each meeting ahead whose agenda nobody has written (SOARD’s usual outline, or a draft) gets the last written or emailed agenda as a draft: its sections and items in order, who presents, the live numbers, the last minutes up for approval; new business starts empty and nothing written under an item comes along. A newer agenda redrafts it; an agenda emailed for the meeting replaces it; Use this agenda, or any change, makes it the meeting’s own.',
          touches: ['D1'], where: 'functions/api/_board.js (maybeDraftAgendas) · board-shared.js (draftAgenda)',
          live: (f) => {
            const d = f.board?.drafts;
            if (!d) return null;
            return ON(d.ahead ? `${plural(d.ahead, 'meeting')} ahead with a drafted agenda.` : 'No drafted agendas ahead.', d.lastAt);
          } },
        { t: 'Attendance from Google Meet', s: 'live', k: 'schedule',
          when: 'From half an hour after a meeting on Google Meet ends, hourly for two days (every ten minutes at most).',
          does: 'Reads who joined the meeting’s Google Meet (the Meet REST API, as the organizer), matches each name to the board and staff on the meeting (first and last name, or a first name only one person has), and marks them Video where nobody marked them. A mark someone made is never changed. The names stay on the meeting for Board, never on the board page.',
          touches: ['Google Meet', 'D1'], where: 'functions/api/_board-attendance.js (via _board.js maybeRunBoard)',
          note: 'Needs https://www.googleapis.com/auth/meetings.space.readonly on the service account’s domain-wide delegation. The invite check finds out before a meeting needs it, and Board → Meetings shows the step.',
          live: (f) => {
            const a = f.board?.attendance;
            const check = f.board?.invite?.check;
            if (!a) return null;
            if (check?.attendance === 'needs-setup' || a.needsSetup) return ATTN('Google Admin hasn’t allowed meetings.space.readonly yet. Board → Meetings has the step.', check?.checkedAt || a.lastAt);
            if (a.failing) return ATTN(`Google Meet didn’t say who joined ${plural(a.failing, 'meeting')}. The meeting’s After step says why.`, a.lastAt);
            return ON(a.read ? `Who joined is in for ${plural(a.read, 'meeting')}.` : 'Ready for the first meeting on Google Meet.', a.lastAt || check?.checkedAt);
          } },
        { t: 'The meeting invite, with Google Meet', s: 'live', k: 'admin',
          when: 'Peter or Holly presses Send the invite in a meeting’s Getting ready. After that, each minute on the live hub’s heartbeat, once a new place, a new agenda (or, for Board’s own invite, a new day or time) has stood two minutes. The check runs on the heartbeat hourly until it passes.',
          does: 'Puts the meeting on the calendar of Board → Settings → Invites come from (Holly’s, as president, until saved) and Google emails the invitations: every active board member with an email, and the Board area’s admins. Google Meet is the video call, with transcripts turned on; the place goes on when there is one. Its notes (plain text) link to the meeting on the board page and list the agenda’s headings; an agenda change updates them without Google emailing anyone, while a new place, day or time sends Google’s update. A meeting already on that calendar gets that same event updated (the missing board members added, Meet, a TBD place and Board’s notes after the organizer’s own), never a second invite.',
          touches: ['Google Calendar', 'Google Meet', 'D1'], where: 'functions/api/_board-invite.js (board-admin.js; _board.js maybeRunBoard)',
          note: 'Transcripts need https://www.googleapis.com/auth/meetings.space.settings on the service account’s domain-wide delegation and the Google Meet REST API turned on in its Google Cloud project. Board → Meetings shows both steps until they work; the invite and its Meet go out either way. The check proves all of it without inviting anyone: a private event with Meet on the organizer’s calendar (no guests, no emails), transcripts turned on and read back, the event deleted. Once it passes, invites that went out before get their transcripts turned on.',
          live: (f) => {
            const i = f.board?.invite;
            if (!i) return null;
            if (!f.board.calendar?.configured) return ATTN('GOOGLE_CALENDAR_KEY is missing, so invites can’t be sent from Board.');
            if (i.check && i.check.transcript === 'needs-setup') return ATTN('The check: Google Admin hasn’t allowed transcripts yet. Board → Meetings has the steps.', i.check.checkedAt);
            if (i.check && i.check.error && i.check.transcript !== 'error' && !i.check.ok && i.check.attendance !== 'needs-setup') return ATTN(`The check didn’t pass: ${i.check.error}`, i.check.checkedAt);
            if (i.needsSetup) return ATTN(`${plural(i.needsSetup, 'invite')} went out with Google Meet but no transcript yet: Google Admin hasn’t allowed it. Board → Meetings has the steps.`, i.lastAt);
            if (i.failing) return ATTN(`Transcripts couldn’t be turned on for ${plural(i.failing, 'meeting')}. Update the invite in Board to try again.`, i.lastAt);
            const checked = !i.check ? '' : i.check.transcript === 'on' ? ' Calendar, Meet and transcripts checked.' : i.check.transcript === 'error' ? ' Calendar and Meet checked; SOARD’s Google plan has no transcripts.' : '';
            return ON(`${i.ahead ? `${plural(i.ahead, 'invite')} out for meetings ahead${i.waiting ? `, ${plural(i.waiting, 'change')} going on in a moment` : ''}.` : 'No invites out for meetings ahead.'}${checked}`, i.lastAt || i.check?.checkedAt);
          } },
        { t: 'The packet email', s: 'live', k: 'admin',
          when: 'Peter or Holly presses Email the documents on a shared meeting in Board (Send it to me first sends them a preview). The minutes and the “Will you be there?” reminder go the same way.',
          does: 'Emails each active board member on their own: when, where and the video call, the meeting’s files attached (up to 30 MB in all; staff-only files never), a button to the meeting on the board page, and the agenda’s headings. Whoever hasn’t answered gets their own one-tap “Will you be there?” buttons (no sign-in; opening the link only asks, pressing the button answers, so a mail scanner can’t). Never notes or numbers; a board-only item shows only as “A board-only item (on the board page)”.',
          touches: ['Resend', 'D1'], where: 'functions/api/_board.js (sendPacket, packetEmail, remindRsvp) · board-rsvp.js · _board-rsvp.js',
          live: (f) => {
            const b = f.board;
            if (!env(f)) return null;
            if (!f.env.resend) return ATTN('RESEND_API_KEY is missing, so the packet can’t be emailed.');
            return ON(b?.lastPacketAt ? `Last packet emailed ${stamp(b.lastPacketAt)}.` : 'No packet emailed yet.', b?.lastPacketAt || null);
          } },
        { t: 'Cash in the bank, month by month', s: 'off', k: 'schedule',
          when: 'On the live hub’s heartbeat: the banks connected through Plaid every six hours, the day’s balance once a day.',
          does: 'Reads the balances (never moves money) for the board page’s cash: Chase’s checking and CD through Plaid (connected once by a Board admin in Settings → Bank balances; Plaid refreshes them about daily), and Mercury’s checking and savings through the relay once Mercury holds money. Credit cards show as owed, never taken off the cash. One row a month for the history. A bank that needs signing in again keeps its last balances with their date, and Slack says so once. Locking a meeting’s numbers keeps that day’s balance with its packet.',
          touches: ['Plaid', 'Mercury', 'D1', 'Slack'], where: 'functions/api/_board.js (cashNow, maybeRunBoard) · _plaid.js · bank-admin.js · public/admin/board-banks.js · _mercury.js (through the relay)',
          live: (f) => {
            const b = f.board;
            if (!b || b.error) return null;
            const k = b.cash.banks || {};
            const both = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0]);
            if (k.needsSignIn?.length) return ATTN(`${both(k.needsSignIn)} needs signing in again: Settings → Bank balances. The board page shows its last balances until then.`, k.readAt);
            if (k.failing?.length) return ATTN(`${both(k.failing)} isn’t answering Plaid. It tries again every six hours.`, k.readAt);
            if (!k.banks?.length && !b.cash.mercury) return ATTN(k.configured ? 'No bank connected yet: Settings → Bank balances → Connect Chase.' : 'No bank connected yet: Chase needs Plaid’s keys (PLAID_CLIENT_ID and PLAID_SECRET) in Cloudflare, then Settings → Bank balances.');
            if (!b.cash.lastAt) return b.cash.readAt ? ON(`Read ${both([...(k.banks || []), ...(b.cash.mercury ? ['Mercury'] : [])])}. The history starts with the first month that has money in the bank.`, b.cash.readAt) : ATTN('Hasn’t read the banks yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (stale(b.cash.lastAt, 30 * HOUR)) return ATTN(`Hasn’t read the banks since ${stamp(b.cash.lastAt)}. Check the Heartbeat entry.`, b.cash.lastAt);
            return ON(`${both([...(k.banks || []), ...(b.cash.mercury ? ['Mercury'] : [])])}. ${plural(b.cash.months, 'month')} of history.`, b.cash.lastAt);
          } },
        { t: 'Year so far from QuickBooks', s: 'off', k: 'schedule',
          when: 'On the live hub’s heartbeat: every hour once QuickBooks is connected, and once a day for the year in context.',
          does: 'Reads QuickBooks’ Profit and Loss from January 1 to today (SOARD’s fiscal year), and its bank accounts, the CD and the credit cards (read-only; connected once by a Board admin in Settings → QuickBooks). The board page’s revenue and expenses for the year are QuickBooks’ own, against the budget sheet in the newest packet, and so is its cash in the bank, unless a bank connected through Plaid answers live. Once a day: last year’s same days and whole year (the pace beside the budget), the cash that left the bank accounts in the last 12 months, from their ledger (months of cash; in-kind gifts and moves between SOARD’s own accounts never count), cash at each month’s end for 13 months (the CD with the bank accounts), the statements of financial position and activities as of the books’ close beside the year before (each meeting locks them on its day, and Print it all prints them), and spending by purpose when the books keep classes. A past meeting keeps the figures locked into it. When QuickBooks needs connecting again, the last figures stay with their date, and Slack says so once.',
          touches: ['QuickBooks', 'D1', 'Slack'], where: 'functions/api/_quickbooks.js (maybeReadBooks, readDaily, booksNow) · books-admin.js · books-callback.js · public/admin/board-books.js · public/admin/board/money.js (withBooks)',
          live: (f) => {
            const q = f.board?.books;
            if (!q) return null;
            if (!q.configured) return ATTN('Not connected: QuickBooks needs its keys (QBO_CLIENT_ID and QBO_CLIENT_SECRET) in Cloudflare, then Settings → QuickBooks. Until then the year so far is the packet’s budget sheet.');
            if (!q.company) return ATTN('Not connected yet: Settings → QuickBooks → Connect QuickBooks.');
            if (q.needsConnect) return ATTN(`${q.company} needs connecting again: Settings → QuickBooks. The board page shows its last figures until then.`, q.readAt);
            if (q.failing) return ATTN(`${q.company} isn’t answering. It tries again every hour.`, q.readAt);
            if (!q.readAt || stale(q.readAt, 3 * HOUR)) return ATTN(q.readAt ? `Hasn’t read QuickBooks since ${stamp(q.readAt)}. Check the Heartbeat entry.` : 'Hasn’t read QuickBooks yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.', q.readAt || null);
            return ON(`${q.company}, read every hour.`, q.readAt);
          } },
      ]},
    ]},
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
        { t: 'Event pages after the event', s: 'live', k: 'schedule',
          when: 'Every 15 minutes on the live hub’s heartbeat. An event counts as over from midnight after its last day, Atlanta time.',
          does: 'Rebuilds the site the morning after an event, so its page turns into the thank-you: the pro photos, then the sponsors, with no tickets or countdown. Tells Slack, and asks for the photos if there are none yet. When next year’s gala or golf tournament is added, saves this year’s photos and sponsors onto this year’s event, so /events/gala/2026/ keeps them for good.',
          touches: ['D1', 'GitHub', 'Cloudflare Pages', 'Slack'], where: 'functions/api/_event-recap.js (from broadcast-hooks.js) · public/admin/events-shared.js',
          info: '/events/gala/ and /events/golf/ always show the newest of their series; each year also keeps its own page (/events/gala/2026/). A gala’s or tournament’s photos are the ones added to its editor’s Gallery tab after its date; any other event shows its own Event Photos.',
          live: (f) => {
            const e = f.eventRecap;
            if (!e) return null;
            if (!e.lastRunAt) return ATTN('It hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (stale(e.lastRunAt, HOUR)) return ATTN(`Hasn’t checked since ${stamp(e.lastRunAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, e.lastRunAt);
            if (e.deployPending) return ATTN(env(f) && !f.env.deployHook ? 'No deploy hook is set in Cloudflare, so an event page waits for the next Publish to become its thank-you.' : 'A rebuild is waiting. It tries again within 10 minutes.', e.lastRunAt);
            return ON(e.lastDeployAt ? `Last turned an event page into its thank-you ${ago(e.lastDeployAt)}.` : 'Watching for the next event to end.', e.lastRunAt);
          } },
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
        { t: 'Press monitor', s: 'live', k: 'schedule',
          when: 'Google News and Bing News every 3 hours, the TV stations’ YouTube channels every 6, every link weekly, all on the live hub’s heartbeat. No buttons: it runs by itself.',
          does: 'Finds SOARD coverage and reads each article. Workers AI checks it’s about SOARD, writes the summary in the site’s voice and links the kids and partners it names. A clear story goes on the publicity page with its outlet and picture, Slack hears, and the site publishes itself (at most every 30 minutes); an unsure one waits in Press → Found coverage. A story its outlet takes down links to its Internet Archive copy. Every change is logged in Press and can be undone.',
          touches: ['Google News', 'Bing News', 'YouTube', 'Workers AI', 'Cloudflare Images', 'Internet Archive', 'Slack', 'D1'],
          where: 'functions/api/_press.js (_press-sources.js, _press-page.js, press-admin.js; runs from broadcast-hooks.js)',
          info: 'Replaced the old Press Monitor button (October 2026), which only ran when someone pressed it and kept its results in one browser. Its first run tidies the press list once: every story linked to an outlet, duplicates merged, Google News links swapped for the outlet’s own, pictures pulled, kids and partners linked.',
          live: (f) => {
            const p = f.press;
            if (!p || !env(f)) return null;
            if (!f.bindings?.ai) return ATTN('Workers AI isn’t bound to the site, so found articles all wait for a person.', p.lastFiledAt);
            if (!p.lastScanAt) return ATTN('Hasn’t looked yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (stale(p.lastScanAt, 8 * HOUR)) return ATTN(`Hasn’t looked since ${stamp(p.lastScanAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, p.lastFiledAt);
            if (p.scanErrors.length) return ATTN(`Couldn’t reach ${p.scanErrors.join(' and ')} on its last look.`, p.lastFiledAt);
            if (!p.tidyDone) return ON('Tidying the press list (once, by itself). New coverage is still filed meanwhile.', p.lastFiledAt);
            if (p.review) return ATTN(`${plural(p.review, 'article needs', 'articles need')} a look in Press → Found coverage.`, p.lastFiledAt);
            return ON(p.lastFiledAt ? `Looking every few hours. Last story filed ${stamp(p.lastFiledAt)}.` : 'Looking every few hours. Nothing new found yet.', p.lastFiledAt);
          } },
      ]},
      { t: 'Protection & records', children: [
        { t: 'Cloudflare Access', s: 'live', k: 'link',
          does: 'Guards the admin and every private API; each request’s sign-in is checked.',
          touches: ['Cloudflare Access'], where: 'functions/api/_middleware.js',
          live: needsKey('access', 'The Access team and audience settings are missing.') },
        { t: 'Staff sign-in follows Google', s: 'live', k: 'schedule',
          when: 'Every 5 minutes on the live hub’s heartbeat, and on any staff sign-in Google’s last read didn’t include.',
          does: 'Reads SOARD’s Google Workspace accounts. A soardcharity.com sign-in opens the admin only while its Google account is active: suspend, archive or delete someone in Google Admin and within 5 minutes the admin refuses them and Cloudflare Access signs them out everywhere. A new hire signs in as soon as Google has their account. Nobody keeps a list.',
          touches: ['Google Workspace', 'Cloudflare Access', 'D1'], where: 'functions/api/_staff-access.js (_middleware.js, broadcast-hooks.js)',
          note: 'Needs admin.directory.user.readonly on the Google service account’s domain-wide delegation and the Admin SDK API turned on in its Google Cloud project.',
          info: 'It never locks staff out by failing: until Google’s accounts have been read once, or when Google can’t answer, a soardcharity.com sign-in counts the way it always has. A Google group’s address isn’t an account, so it can’t open the admin.',
          live: (f) => {
            const s = f.staff;
            if (!s || !('key' in s)) return null;
            if (!s.key) return OFF('Needs GOOGLE_CALENDAR_KEY in Cloudflare. Until then any soardcharity.com sign-in opens the admin.');
            const fix = {
              // Both steps at once: the API is the next thing Google would ask for
              scope: `In Google Admin → Security → API controls → Domain-wide delegation, edit client ID ${s.clientId || 'of the site’s service account'}, add https://www.googleapis.com/auth/admin.directory.user.readonly to its scopes (keep the ones already there) and choose Authorize. Then in Google Cloud${s.project ? ` (project ${s.project})` : ''}, turn on the Admin SDK API: APIs & Services → Library → Admin SDK API → Enable.`,
              api: `In Google Cloud${s.project ? ` (project ${s.project})` : ''}, turn on the Admin SDK API: APIs & Services → Library → Admin SDK API → Enable.`,
              admin: 'Google says no founder on People → Team is a Workspace admin. A founder needs the Super Admin role in Google Admin.',
            }[s.needs];
            if (!s.read) return s.error ? ATTN(`Not connected yet, so any soardcharity.com sign-in opens the admin. ${fix || `Google said: ${s.error}`}`, s.failedAt) : { why: 'The first read of Google’s accounts runs within 5 minutes.' };
            if (s.error) return ATTN(`The last read failed, so sign-ins go by the read from ${stamp(s.syncedAt)}. ${fix || s.error}`, s.syncedAt);
            const last = s.out?.[0];
            if (last && !last.signedOut) return ATTN(`${last.name} is refused by the admin, but their open sign-in wasn’t ended. ${last.error}`, last.at);
            const signedOut = last ? ` Last signed out: ${last.name} (${last.why === 'gone' ? 'deleted' : last.why} in Google) ${stamp(last.at)}.` : '';
            return ON(`${plural(s.active, 'active Google account')} can sign in${s.off ? `; ${plural(s.off, 'suspended or deleted one', 'suspended or deleted ones')} can’t` : ''}.${signedOut}`, s.syncedAt);
          } },
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
      ]},
    ]},

  { t: 'Email & newsletters', sub: 'Kit for the list, Resend for one-off mail', color: 'email', side: 'l',
    about: 'Kit holds the list, and staff write and send newsletters there. Resend only sends one-off mail: application links and notices, reveal reminders and staff alerts.',
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
      { t: 'Did it arrive', children: [
        { t: 'Email delivery reports', s: 'live', k: 'event',
          when: 'Resend reports on each email the site sends, seconds after it goes. Every 30 minutes the heartbeat keeps the webhook registered and catches up any report it missed.',
          does: 'Keeps whether each email arrived, bounced (and why) or was marked as spam, for Emails & invites → What went out. A family’s or staff email that can’t be delivered tells staff in Slack and by email, once a week per address; a reveal-reminder address that bounces or reports spam is unsubscribed.',
          touches: ['Resend', 'D1', 'Slack'], where: 'functions/api/_email-log.js · resend-webhook.js · broadcast-hooks.js',
          info: 'The site registers its own webhook with Resend and keeps the signing secret in D1’s email_tracking table (RESEND_WEBHOOK_SECRET in Cloudflare is used instead when set). It needs a Resend key with Full access; a “Sending access” key sends fine but can’t hear back.',
          live: (f) => {
            const t = f.emailTracking;
            if (!t || !env(f)) return null;
            if (t.state === 'off') return OFF('RESEND_API_KEY is missing, so the site sends no email of its own.');
            if (t.state === 'send-only') return ATTN('The site’s Resend key can only send, so Resend can’t report back. Make a Full access key in Resend and put it in Cloudflare as RESEND_API_KEY; the site does the rest.', t.checkedAt);
            if (t.state === 'error') return ATTN(`Resend’s reports aren’t coming in (${t.error || 'no answer'}). It tries again every 30 minutes.`, t.checkedAt);
            if (t.state === 'waiting') return ON('Starting: the heartbeat registers the webhook within half an hour.');
            if (stale(t.checkedAt, 2 * HOUR)) return ATTN(`The delivery check hasn’t run since ${stamp(t.checkedAt)}. It rides on the live hub’s heartbeat, so check the Heartbeat entry.`, t.lastReportAt);
            const proof = t.selfTest?.result === 'passed' ? ` Proven ${stamp(t.selfTest.at)}: Resend’s test “delivered” and “bounced” both came back through the webhook.` : t.selfTest?.result === 'waiting' ? ' The one-time check is out: two emails to Resend’s test addresses, waiting for their reports.' : '';
            return ON(`${t.lastReportAt ? `Resend reports back on every email. Last report ${stamp(t.lastReportAt)}.` : 'Registered with Resend. Waiting for the first report.'}${proof}`, t.lastReportAt);
          } },
      ]},
      { t: 'Sender accounts', children: [
        { t: 'Resend', s: 'live', k: 'link',
          does: 'Sends the site’s one-off mail from sunshine@comms.sunshineonaranneyday.com (the verified domain). The list itself lives in Kit.',
          touches: ['Resend'], where: 'RESEND_API_KEY in Cloudflare', live: needsKey('resend', 'RESEND_API_KEY is missing.') },
        { t: 'Kit', s: 'live', k: 'link',
          does: 'The main list and its broadcasts; sends from Clareece’s soardcharity.com address.',
          touches: ['Kit'], where: 'KIT_API_KEY in Cloudflare',
          info: 'soardcharity.com is authenticated for Kit (its DKIM key and return path are in DNS); DMARC is still p=none, watching only. Emails & invites → What went out checks these each time it opens.',
          live: needsKey('kit', 'KIT_API_KEY is missing.') },
      ]},
    ]},

  { t: 'JobTread', sub: 'SOARD workflows, and DataX', color: 'jt', side: 'l',
    about: 'Automations inside SOARD’s JobTread account, outside the website, and DataX, which connects JobTread to SOARD’s Quo phone line and to Zillow.',
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
        { t: 'Comments → DataX', s: 'off', k: 'event',
          when: 'Fires on every new comment or daily log.',
          does: 'Sends each new comment’s text to a DataX agent, most likely the Grammar Checker (which is also in test mode).',
          touches: ['JobTread', 'DataX'], where: 'JobTread workflow “Comment/Log Created Trigger”', live: wf('22PZF9ENDgxn') },
      ]},
      { t: 'DataX', children: [
        { t: 'Quo texts and calls → JobTread', s: 'live', k: 'event',
          when: 'A family texts or calls SOARD’s Quo number, or staff text or call them from it.',
          does: 'DataX logs each text and call as a comment on the family’s JobTread account, so the whole conversation sits with the family. Admin → Applicants shows these in each family’s history.',
          touches: ['Quo', 'DataX', 'JobTread'], where: 'DataX’s Quo connection → comments on the JobTread account',
          info: 'Checked from the applicant families’ history, so it asks for a look only after 30 quiet days (the longest gap since logging began in March 2026 was 11 days).',
          live: (f) => {
            const q = f.quo;
            if (!q || q.error) return null;
            if (!q.lastAt) return ATTN('No Quo text or call has been logged in JobTread yet. Check Quo’s connection in DataX.');
            if (stale(q.lastAt, 30 * 24 * HOUR)) return ATTN(`No Quo text or call has reached JobTread since ${stamp(q.lastAt)}. Check Quo’s connection in DataX.`, q.lastAt);
            return ON(`${plural(q.last30, 'text or call', 'texts and calls')} with applicant families in the last 30 days. The latest was logged ${stamp(q.lastAt)}.`, q.lastAt);
          } },
        { t: '/text → Quo text', s: 'live', k: 'event',
          when: 'Any new comment.',
          does: 'Comments starting with /text are texted to the account’s primary contact from SOARD’s Quo number.',
          touches: ['JobTread', 'DataX', 'Quo'], where: 'JobTread webhook → DataX (winyourdata.com/api/phone/texting)', live: hook('22PDDmxBcvpA') },
        { t: 'Zillow lookup', s: 'live', k: 'event',
          when: 'A new location is added.',
          does: 'Looks up the property on Zillow and saves the Zillow link on the account.',
          touches: ['JobTread', 'DataX', 'Zillow'], where: 'JobTread webhook → DataX (winyourdata.com/api/zillow)', live: hook('22PJxV5yimrd') },
      ]},
    ]},

  { t: 'Giving & money', sub: 'Gift alerts, job costs, and outside services shown on the site', color: 'give', side: 'l',
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
            const caught = z.missed && !stale(z.missedAt, 7 * 24 * HOUR);
            // A miss counts until the webhook delivers again; after that it was one slow or lost delivery the check covered
            if (caught && !(ms(z.lastWebhookAt) > ms(z.missedAt))) return ATTN(`Zeffy’s webhook missed ${plural(z.missed, 'gift')} on ${stamp(z.missedAt)}, and the catch-up check posted ${z.missed === 1 ? 'it' : 'them'}. Check the webhook in Zeffy → Settings → Integrations.`, z.lastPostAt);
            const note = caught ? ` The catch-up check caught ${plural(z.missed, 'gift')} the webhook missed on ${stamp(z.missedAt)}; the webhook has delivered since.` : '';
            return ON(z.lastPostAt ? `Connected. Last gift posted ${stamp(z.lastPostAt)}.${note}` : `Connected. Waiting for the first gift.${note}`, z.lastPostAt);
          } },
      ]},
      { t: 'Job costs (Mercury)', children: [
        { t: 'Charges onto jobs, live', s: 'live', k: 'event',
          when: 'A Mercury card is swiped or a bill is paid (Mercury’s webhook, right away), plus a catch-up read of Mercury every 2 minutes on the live hub’s heartbeat.',
          does: 'Sorts each charge into a makeover, the Sunny & Ranney store or operating (the store’s card or account, vendor rules, else the cardholder’s one active job or the one job in Build), and shows it on that job’s costs in Admin → Job Costs within seconds, coded by vendor rule when there is one.',
          touches: ['Mercury', 'JobTread', 'D1'], where: 'functions/api/_spend.js, _spend-match.js (mercury-webhook.js, broadcast-hooks.js)',
          info: 'Replaced Ramp (October 2026), which put every bill on one “Makeover COGS” line under 01 DESIGN & ENGINEERING. The site registers Mercury’s webhook itself and keeps its signing secret in D1. It never moves money.',
          live: (f) => {
            const j = f.jobCosts;
            if (!j || !env(f) || j.error) return null;
            if (!f.env.mercury) return ATTN('Not connected yet. Add SOARD’s Mercury API token in Cloudflare as MERCURY_API_TOKEN; the webhook sets itself up from there.');
            if (j.webhookError) return ATTN(`Mercury’s webhook couldn’t be set up: ${j.webhookError}. Charges still arrive every 2 minutes.`, j.lastEventAt);
            if (j.catchUpError) return ATTN(`${/^JobTread/.test(j.catchUpError) ? 'JobTread’s open jobs' : 'Mercury'} couldn’t be read: ${j.catchUpError}.`, j.lastEventAt);
            if (!j.lastCatchUpAt) return ATTN('Hasn’t read Mercury yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (stale(j.lastCatchUpAt, HOUR)) return ATTN(`Hasn’t read Mercury since ${stamp(j.lastCatchUpAt)}. Check the Heartbeat entry.`, j.lastEventAt);
            return ON(`${j.webhook ? 'Webhook registered' : 'Reading Mercury every 2 minutes'}. ${j.unsorted ? `${plural(j.unsorted, 'charge')} to sort in Job Costs.` : 'Every charge sorted.'}`, j.lastEventAt);
          } },
        { t: 'Receipts → JobTread bills', s: 'live', k: 'event',
          when: 'A receipt is forwarded to ap@soardcharity.com (to the DataX Receipt Processor).',
          does: 'DataX reads the receipt and makes the JobTread vendor bill, one line per cost code, matched to the job’s budget, receipt attached, paid. It asks the site for the vendor rules and the job the charge was put on. Every 2 minutes the site pairs new bills with their Mercury charges: “waiting for receipt” becomes billed, and the charge’s note in Mercury gets the job and bill.',
          touches: ['DataX', 'JobTread', 'Mercury', 'D1'], where: 'DataX Receipt Processor · functions/api/spend-rules.js, spend-hint.js, _spend.js (syncBills, pairAll, writeNotes)',
          live: (f) => {
            const j = f.jobCosts;
            if (!j || !env(f) || j.error) return null;
            if (j.billsError) return ATTN(`JobTread bills can’t be read: ${j.billsError}.`, j.agentUsedAt);
            if (j.writeError) return ATTN(`Notes aren’t reaching Mercury: ${j.writeError}`, j.agentUsedAt);
            if (!j.agentUsedAt) return ATTN('The Receipt Processor hasn’t asked the site for rules yet. Check it’s live in DataX with the job-cost instructions.');
            return ON(`The Receipt Processor last asked ${stamp(j.agentUsedAt)}.`, j.agentUsedAt);
          } },
        { t: 'Budget alerts', s: 'live', k: 'schedule',
          when: 'Each job’s costs are rebuilt when a charge or bill lands, and every job every 15 minutes; weekdays at 8 AM for the receipts card.',
          does: 'Posts once in Slack (threaded per job) when a job’s forecast reaches 80% and 100% of its budget, and when a cost code goes over its own line. Weekday mornings, one card lists charges with no receipt after 2 days and charges nobody has sorted.',
          touches: ['Slack', 'JobTread', 'D1'], where: 'functions/api/_job-ledger.js (thresholds), _spend.js (morningCard)',
          live: (f) => {
            const j = f.jobCosts;
            if (!j || !env(f) || j.error) return null;
            if (!f.env.slackBot) return ATTN('SLACK_BOT_TOKEN is missing, so budget alerts can’t post.');
            if (!j.lastRebuildAt) return ATTN('Job costs haven’t been built yet.');
            if (stale(j.lastRebuildAt, HOUR)) return ATTN(`Job costs last rebuilt ${stamp(j.lastRebuildAt)}. Check the Heartbeat entry.`, j.lastRebuildAt);
            return ON(`Every job rebuilt ${stamp(j.lastRebuildAt)}.${j.caps ? ' Card limits follow budgets.' : ''}`, j.lastRebuildAt);
          } },
        { t: 'Bill approvals and pay', s: 'live', k: 'event',
          when: 'A sub’s bill lands in JobTread unpaid. The DataX Bill Approver reads the bills waiting from the site and emails the approver; her reply comes back the same way. Every 5 minutes on the heartbeat, approved bills are paid and Mercury’s payments recorded.',
          does: 'Only a listed approver’s answer counts, and a bill over the second-approval amount needs two. An approved bill is paid from Mercury the way Job Costs → Bills → Settings says: by hand, held in Mercury until an approver taps Approve, or sent at once, never more than the bill’s balance or the day’s cap. Every Mercury payment out (and every card charge with a bill) is recorded on its JobTread bill, so the bill shows paid.',
          touches: ['DataX', 'Mercury', 'JobTread', 'Slack', 'D1'], where: 'functions/api/_bill-pay.js, bill-approvals.js · DataX Bill Approver',
          info: 'The only part of the site that can move money, and only when Setup says to. Mercury’s idempotency key is the bill’s id, so a bill can’t be paid twice.',
          live: (f) => {
            const b = f.jobCosts?.billPay;
            if (!b || !env(f)) return null;
            if (b.error) return ATTN(`Stopped: ${b.error}`, b.at);
            // Nothing is paid from Mercury before the switch day (both paying would pay a sub twice)
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            if (!b.startsOn) return OFF('Waiting for the move to Mercury: bills are paid the way they are today until a start day is set in Job Costs → Bills → Settings.', b.at);
            if (b.startsOn > today) return OFF(`Starts ${new Date(`${b.startsOn}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, the day bills start paying from Mercury.${b.approvers ? '' : ' Pick who approves before then (Job Costs → Bills → Settings).'}`, b.at);
            if (!b.approvers) return ATTN('No approvers yet (Job Costs → Bills → Settings), so no answer counts.');
            const mode = { off: 'paid by hand', request: 'held in Mercury for approval', send: 'paid right away' }[b.mode] || b.mode;
            return ON(`Approved bills are ${mode}. ${b.waiting ? `${plural(b.waiting, 'bill')} waiting for an answer.` : 'No bill is waiting.'}${b.last?.recorded ? ` ${plural(b.last.recorded, 'payment')} recorded in JobTread last run.` : ''}`, b.at);
          } },
        { t: 'Receipts both ways', s: 'live', k: 'schedule',
          when: 'Every 2 minutes on the heartbeat.',
          does: 'A receipt photo added in Mercury’s app, on a makeover charge with no bill yet, is emailed to the receipt inbox (ap@) for the Receipt Processor, with the job and charge in the subject. A card charge paired with a JobTread bill but no receipt in Mercury gets the bill’s file uploaded, so Mercury Books sees a receipt on every charge.',
          touches: ['Mercury', 'Resend', 'JobTread', 'D1'], where: 'functions/api/_spend-receipts.js',
          live: (f) => {
            const r = f.jobCosts?.receipts;
            if (!r || !env(f)) return null;
            const errs = [r.toAp?.error, r.toMercury?.error].filter(Boolean);
            if (errs.length) return ATTN(errs.join(' · '));
            return ON(`Last run: ${plural(r.toAp?.sent || 0, 'photo')} sent to ap@, ${plural(r.toMercury?.uploaded || 0, 'receipt')} added in Mercury.`);
          } },
        { t: 'Receipts from inboxes', s: 'live', k: 'schedule',
          when: 'Every 3 minutes on the heartbeat (every minute while there’s a backlog), for every active SOARD Google account.',
          does: 'Reads each staff inbox’s new mail. A receipt, paid order or bill for something bought is emailed to the receipt inbox (ap@) with its files, for the Receipt Processor, so nobody forwards receipts by hand. Workers AI reads each one first: shipping and delivery notices, ads, carts, refunds, statements, gifts to SOARD and personal purchases stay out, and so does anything the receipt inbox already has (on the email or in its conversation) or that came from Ramp, Mercury or JobTread.',
          touches: ['Gmail', 'Workers AI', 'Resend', 'D1'], where: 'functions/api/_mail-sweep.js (broadcast-hooks.js; reads with _mailbox.js)',
          info: 'Read-only in Gmail: nothing is moved, labelled or marked read. Receipts from before it was turned on are left alone, since staff forwarded those by hand. The same email in two inboxes is sent once. Its first day only watches, listing here what it would send, then sends it.',
          live: sweepLive('receipt') },
        { t: 'Odd charges', s: 'live', k: 'schedule',
          when: 'Every 15 minutes, before the job costs rebuild.',
          does: 'Posts once in the Finance channel: the same charge twice in a day, far more than a vendor usually charges, a vendor that started charging monthly, a bar or gambling merchant. A refund nobody placed goes back on the job its charge was on.',
          touches: ['Slack', 'D1'], where: 'functions/api/_spend-odd.js',
          live: (f) => {
            const j = f.jobCosts;
            if (!j || !env(f)) return null;
            return j.odd ? ATTN(`${plural(j.odd, 'charge')} to look at in Job Costs → Charges → Odd.`) : ON('Nothing odd waiting.');
          } },
        { t: 'Close-outs', s: 'live', k: 'schedule',
          when: 'Hourly: jobs closed in JobTread since January 2025.',
          does: 'Keeps each finished makeover’s final numbers by cost code, cost per room (from the family’s profile) and what ran over. A job closed in the last 2 weeks posts once in the Finance channel and gets a “Close-out report” field in JobTread. The budget builder on each open job suggests a budget from these, and adds lines to JobTread only when a person presses Add.',
          touches: ['JobTread', 'Slack', 'D1'], where: 'functions/api/_job-closeout.js',
          live: (f) => {
            const c = f.jobCosts?.closeouts;
            if (!c || !env(f)) return null;
            if (c.error) return ATTN(`JobTread couldn’t be read: ${c.error}`, c.at);
            if (!c.at) return ATTN('Hasn’t looked yet. It rides on the heartbeat.');
            return ON(`${plural(c.closed || 0, 'closed job')} read${c.historyLeft ? `, ${c.historyLeft} still to read` : ''}.`, c.at);
          } },
      ]},
      { t: 'Board numbers', children: [
        { t: 'P&L', s: 'live', k: 'schedule',
          when: 'Once: every Mercury transaction since January last year, a page at a time on the heartbeat. Then every transaction as Mercury sends it.',
          does: 'Keeps Mercury’s own record of money in and out, so the board page shows each month in three columns (makeovers, the Sunny & Ranney store, operating) against last year. Mercury Books stays the official books.',
          touches: ['Mercury', 'D1'], where: 'functions/api/_finance.js, _mercury-txns.js',
          live: (f) => {
            const x = f.jobCosts?.finance;
            if (!x || !env(f)) return null;
            if (x.backfill?.error) return ATTN(`History stopped: ${x.backfill.error}`, x.at);
            if (!x.backfill) return ATTN('Hasn’t read Mercury’s history yet.');
            return ON(x.backfill.doneAt ? `History read (${x.backfill.read} transactions).` : `Reading history: ${x.backfill.read} so far.`, x.at);
          } },
        { t: 'Cash forecast', s: 'live', k: 'schedule',
          when: 'Hourly.',
          does: '13 weeks ahead from today’s balances, the makeovers under way and coming, running costs, and gifts by season. When the cautious line dips under the cash floor, the Finance channel hears once, and again when it recovers.',
          touches: ['Mercury', 'JobTread', 'Slack'], where: 'functions/api/_finance.js (forecast, cashAlert)',
          live: (f) => {
            const x = f.jobCosts?.finance;
            if (!x || !env(f)) return null;
            if (x.balancesError) return ATTN(`Balances can’t be read: ${x.balancesError.error}`, x.balancesError.at);
            if (x.mercuryEmpty) return OFF('Starts once SOARD’s money is in Mercury. Until then there’s no forecast, no low-cash alert and nothing about it on the board page.', x.at);
            if (!x.forecast) return ATTN('No forecast yet.');
            return x.cashLow ? ATTN('The cautious forecast dips under the cash floor. See the board page.', x.forecast.at) : ON('Above the cash floor all 13 weeks.', x.forecast.at);
          } },
        { t: 'Trade partners', s: 'live', k: 'schedule',
          when: 'Every 15 minutes on the heartbeat (held bills every time, other vendors every 6 hours); JobTread’s vendors, their fields and the open jobs they’re on every 4 hours; W-9s to Mercury daily.',
          does: 'JobTread is the one record: each vendor’s W-9, Liability Expires, Workers’ Comp Expires, Documents, Trades, Address and License fields, their contacts, and the files in their “W-9 & Insurance” folder. SOARD sends a company the /trade-partners/ link; they type their company, name, email and phone and get their own page by email (English or Spanish). JobTread decides who they are: an email already on a vendor’s contacts signs them in, a vendor with that name becomes theirs (or, when it already has people on file, the link goes to them instead), and anyone else is made a new vendor. Nobody approves anything. Their page: company details, a W-9 filled in and signed right there (the IRS form, made and filed for them), their certificate (read by Workers AI from its text and its page pictures, held to SOARD’s minimums, a disagreement asked once more on its own) or their insurance agent, who is emailed for it and for renewals, and the bank account SOARD pays, which goes straight onto their Mercury recipient. A vendor with a bill waiting or approved, or on a purchase order for an open job, whose W-9 or insurance is missing or out of date gets an email with their link (reminders after 3 and 7 days), and so does any vendor whose insurance dates in JobTread end within 30 days (or their agent). Every email is noted on the vendor in JobTread. An approved bill is paid only once both are current; until then it’s held, with a pinned note on the bill in JobTread. A bank account needs a call only when it’s a change, or the first one for a vendor SOARD already had: the approved bill it holds says so in Job Costs → Bills, with the button to confirm it. While Ramp still pays bills, a Ramp bill for such a vendor is put on hold in Ramp the same way. A company invited and not finished is reminded after 2 and 5 days.',
          touches: ['JobTread', 'Workers AI', 'Resend', 'Mercury', 'Ramp', 'Slack'], where: 'functions/api/_vendors.js, _vendor-read.js, _trade-partners.js, _w9-form.js, vendor-docs.js, trade-partner.js · pages: src/pages/trade-partners/ · the hold and the bank call: _bill-pay.js and Job Costs → Bills, and in Ramp _ramp.js',
          info: 'The Finance channel hears only what needs a person: a "Work with us" request (approved in the admin), a bank account to confirm by phone (confirmed in the admin), a file nobody could read, a vendor with no email, or one who hasn’t answered three emails while a bill waits. Mark a supplier “Materials only”, or a vendor “Not needed”, in Trade Partners. The site keeps no tax ID and no bank account number, only the last four digits.',
          live: (f) => {
            const v = f.jobCosts?.vendors;
            if (!v || !env(f)) return null;
            if (v.setupError) return ATTN(`Couldn’t set up the JobTread vendor fields: ${v.setupError.error}`, v.setupError.at);
            if (v.error) return ATTN(v.error.error || String(v.error), v.at);
            if (!v.at) return ATTN('Hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            const r = v.ramp;
            if (r?.error) return ATTN(r.error.error, r.error.at);
            const bits = [v.held ? `${plural(v.held, 'bill')} held for documents` : null, r?.held ? `${plural(r.held, 'Ramp bill')} on hold in Ramp` : null,
              r?.watch ? `${plural(r.watch, 'Ramp bill')} to hold once holds start` : null, v.asking ? `${plural(v.asking, 'vendor')} asked` : null].filter(Boolean);
            const ramp = !f.env.ramp ? ' Ramp isn’t connected, so Ramp’s bills aren’t held: add RAMP_CLIENT_ID and RAMP_CLIENT_SECRET in Cloudflare.' : '';
            const p = v.partners || {};
            const setting = p.settingUp ? ` ${plural(p.settingUp, 'company', 'companies')} setting up.` : '';
            if (p.dupes?.length) return ATTN(`JobTread has two vendor fields named ${p.dupes.map((n) => `“${n}”`).join(', ')}. The site uses the first; delete the other in JobTread → Settings → Custom fields → Vendors.`, v.at);
            if (p.single?.length) return ATTN(`JobTread’s “Trades” vendor field takes one answer, so only a partner’s first trade is kept. Let it take more than one in JobTread → Settings → Custom fields → Vendors.`, v.at);
            if (p.bankCalls) return ATTN(`${plural(p.bankCalls, 'approved bill')} waiting on a call about a bank account: Job Costs → Bills.${setting}`, v.at);
            return ON(`${bits.length ? `${bits.join(', ')}.` : 'Every vendor with a bill has a current W-9 and insurance.'}${setting}${ramp}`, v.at);
          } },
        { t: 'Old certificates and W-9s', s: 'live', k: 'schedule',
          when: 'Every minute on the heartbeat while there’s anything to find or read; then every 6 hours, for new mail, new JobTread files and new Ramp bills.',
          does: 'Finds the insurance certificates and W-9s SOARD already had: in every staff inbox (the last 4 years, then new mail), on JobTread vendor accounts without a tag, and on Ramp bills. Each file is read once, even when it’s in three inboxes: a PDF’s own text says what it is, and certificates, W-9s and scans are read by Workers AI (a PDF’s pages drawn in Browser Rendering when its text can’t say). The company on it is matched to its JobTread vendor by name; among close names Workers AI picks, and only a sure pick counts. SOARD’s own paperwork is left out. A match is filed in the vendor’s “W-9 & Insurance” folder with its tag and a note saying where it was found; Liability Expires and Workers’ Comp Expires only move forward; the agency on the certificate becomes their insurance agent, who is asked for renewals. Every policy, matched or not, goes into the coverage index the insurance audit reads.',
          touches: ['Gmail', 'JobTread', 'Ramp', 'Workers AI'], where: 'functions/api/_coi-backfill.js, _vendor-read.js',
          info: 'Read-only in the inboxes. The site keeps no copy of the files and no tax ID: D1 keeps each file’s fingerprint and what it said.',
          live: (f) => {
            const b = f.coiBackfill;
            if (!b || !env(f)) return null;
            if (b.error) return ATTN(b.error, b.errorAt);
            if (!b.at) return ATTN('Hasn’t run yet. It rides on the live hub’s heartbeat, so check the Heartbeat entry.');
            if (b.refused?.length) return ATTN(`Gmail won’t open ${b.refused.map((r) => `${r.inbox}’s inbox (${r.error || 'no reason given'})`).join(' or ')}. The others go on; it’s tried again every hour.`, b.refused[0].at);
            const filed = `${plural(b.filed.coi, 'certificate')} and ${plural(b.filed.w9, 'W-9')} filed on ${plural(b.filed.vendors, 'vendor')}`;
            const other = b.unmatched ? `; ${plural(b.unmatched, 'file')} for companies JobTread doesn’t have` : '';
            const looking = b.firstPass.mail && b.firstPass.jt ? '' : `Still looking: ${plural(b.waiting, 'email or file', 'emails and files')} to read. `;
            return ON(`${looking}${filed}${other}.`, b.at);
          } },
        { t: 'Insurance audits', s: 'live', k: 'schedule',
          when: 'Each policy’s current term about daily on the heartbeat; the asks right after.',
          does: 'Puts together both premium audits, each on its own policy’s term: workers’ compensation (April 11 to April 11) and general liability (November 21 to November 21). Every payment to a vendor in the term is counted once from JobTread bills and payments, Ramp’s paid bills and Mercury; each payee is a subcontractor or not, with the reason (a person can change it in Job Costs → Insurance audit); and each payment is checked against the certificates found and JobTread’s insurance dates for that day. “One person, no employees” leaves a sub out of workers’ comp only. A sub paid on days no certificate covers is emailed a week later for the one that did, or their insurance agent is: one email for whatever both audits are missing, never twice for the same months, noted on the vendor in JobTread, and only after the certificate search has had a few days. The spreadsheet and the auditor’s packet (a summary, then every certificate) download for each audit.',
          touches: ['JobTread', 'Ramp', 'Mercury', 'Resend', 'D1'], where: 'functions/api/_insurance-audit.js, insurance-audit-admin.js; public/admin/insurance-audit.js',
          info: 'Read-only in JobTread, Ramp and Mercury apart from the notes. D1 keeps each term’s payments, the calls people make and the asks sent.' },
      ]},
      { t: 'The bank', children: [
        { t: 'Mercury connection', s: 'live', k: 'link',
          does: 'Every call the site makes to Mercury goes through SOARD’s relay, a small server with one fixed address: the one on the Mercury token’s IP allow-list. Each time this page opens it reads Mercury’s list of accounts through the relay. It never reads balances or moves money.',
          touches: ['Mercury'], where: 'functions/api/_mercury.js (MERCURY_BASE) · relay: mercury-relay.sunshineonaranneyday.com (DigitalOcean, Toronto)',
          info: 'The relay passes each call to api.mercury.com unchanged once its X-Relay-Key header matches MERCURY_RELAY_KEY. Mercury’s own token is MERCURY_API_TOKEN. Both live in Cloudflare (soard-site → Settings → Variables and secrets).',
          live: (f) => {
            const m = f.mercury;
            if (!m || !('token' in m)) return null;
            const missing = [!m.token && 'MERCURY_API_TOKEN', !m.relayKey && 'MERCURY_RELAY_KEY'].filter(Boolean);
            if (missing.length) return ATTN(`Not connected yet. Add ${missing.join(' and ')} in Cloudflare (soard-site → Settings → Variables and secrets).`);
            if (m.error) return ATTN(m.relay ? `${m.error}.` : `Mercury turned the relay’s call down: ${m.error}`);
            return ON(`Connected. Mercury shows ${plural(m.accounts.length, 'account')}${m.accounts.length ? `: ${m.accounts.map((a) => a.name).join(', ')}` : ''}.`);
          } },
      ]},
      { t: 'On the pages', children: [
        { t: 'Zeffy donations', s: 'live', k: 'link',
          does: 'Donation forms on the donate page, the live page and the golf page.',
          touches: ['Zeffy'], where: 'src/pages/donate.astro · LiveGive.astro' },
        { t: 'Qtego auction', s: 'live', k: 'link',
          does: 'The gala auction link.', touches: ['Qtego'], where: 'src/utils/auction.ts' },
        { t: 'Advisory Board application', s: 'live', k: 'visitor',
          when: 'Someone applies on /advisory-board/apply/ (always open; it replaced the Jotform form in October 2026).',
          does: 'Five steps, saved on their device as they go. Each application is stored; the applicant gets a copy of what they sent; staff get an email (the list in People → Applications) and a Slack post without contact details. A name starting with TEST is a test: both emails go only to the address on it.',
          touches: ['D1', 'Resend', 'Slack', 'Cloudflare Turnstile'], where: 'src/pages/advisory-board/apply.astro · functions/api/advisory-apply.js · _advisory-applications.js',
          info: 'Staff work through them in People → Applications: where each stands, notes, and Add as an advisor (a hidden draft on People → Advisory with their private email). Turnstile, a hidden honeypot and a daily limit per address keep bots out.',
          live: (f) => {
            if (!env(f)) return null;
            if (!f.env.resend) return ATTN('RESEND_API_KEY is missing, so neither the applicant nor staff are emailed.');
            const a = f.advisory;
            if (!a || a.error) return ON();
            const n = a.lastNotified;
            const heard = n ? ` The applicant was ${n.applicant ? '' : 'not '}emailed, staff ${n.staff ? `got ${plural(n.staff, 'email')}` : 'got no email'}${n.slack ? ' and Slack' : ', no Slack'}.` : '';
            const word = a.new ? `${plural(a.new, 'new one')} to look at` : 'none new';
            return a.lastAt ? ON(`${plural(a.total, 'application')}, ${word}. The last came in ${stamp(a.lastAt)}.${heard}`, a.lastAt) : ON(`Waiting for the first application on the site${a.fromJotform ? ` (${a.fromJotform} came over from Jotform)` : ''}.`);
          } },
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
const PALETTE = { reveals: '#B08900', live: '#6352C9', email: '#2B6CB0', site: '#13807A', give: '#A0571A', jt: '#4E7A2E', apply: '#8C3D6B', board: '#4A5A6A' };

const model = prepareMap(MAP, 'a');
/** Apply the live facts to every entry. Exported for tests. */
export const applyFacts = model.applyFacts;
/** Every entry on the map. Exported for tests: Process pins them to its steps by name */
export const entries = model.ALL;

const filterMatch = (n, k) => (k === 'own' ? n.k === 'schedule' || n.k === 'event' : n.k === k);
const shape = (n) => (n.k === 'link' ? 'square' : 'circle');

function Entry(sel, { pickService, Dot }) {
  const p = sel.probe;
  const reason = sel.es !== 'live' && !(p?.s && p.why) ? sel.note : null;
  return html`
    <div class="am-chips">
      <span class="tag"><${Dot} n=${sel} /> ${STATUS[sel.es]}</span>
      <span class="tag">${KIND[sel.k]}</span>
      <span class="tag am-chip-src" title=${p ? 'Checked against the live systems when this page opened' : `Can’t be checked from the site; as written on ${WRITTEN_ON}`}>${p ? 'Checked live' : 'From the map'}</span>
    </div>
    <dl>
      ${p && (p.why || p.last) && html`<div><dt>Right now</dt><dd class=${`am-now s-${sel.es}`}>${p.why || 'Running.'}${p.last && html`<small>Last ran <${Ago} iso=${p.last} /></small>`}</dd></div>`}
      ${reason && html`<div><dt>${sel.es === 'attn' ? 'What needs doing' : 'Why it’s off'}</dt><dd class=${`am-now s-${sel.es}`}>${reason}</dd></div>`}
      ${sel.when && html`<div><dt>What starts it</dt><dd>${sel.when}</dd></div>`}
      ${sel.does && html`<div><dt>What it does</dt><dd>${sel.does}</dd></div>`}
      ${sel.touches?.length > 0 && html`<div><dt>Touches</dt><dd class="am-tags">${sel.touches.map((t) => html`<button type="button" key=${t} title=${`Show everything that depends on ${t}`} onClick=${() => pickService(t)}>${t}</button>`)}</dd></div>`}
      ${sel.where && html`<div><dt>Where it lives</dt><dd class="am-mono">${sel.where}</dd></div>`}
      ${sel.info && html`<div><dt>Good to know</dt><dd>${sel.info}</dd></div>`}
    </dl>`;
}

// ─── The page ─────────────────────────────
// The live facts, read once for the map and Process together (kept a minute)
let factsRead = null;
function getFacts(fresh = false) {
  if (fresh || !factsRead || Date.now() - factsRead.at > MIN) {
    const p = fetchFacts(FACTS_URL);
    factsRead = { at: Date.now(), p };
    p.catch(() => { if (factsRead?.p === p) factsRead = null; });
  }
  return factsRead.p;
}

const viewOfHash = () => (/^#automations\/process\b/.test(location.hash) ? 'process' : 'map');
const Switcher = ({ view, onPick }) => html`<div class="seg" role="group" aria-label="Show the automations as">
  ${[['map', 'Map'], ['process', 'Process']].map(([v, label]) => html`<button key=${v} type="button" aria-pressed=${String(view === v)} onClick=${() => onPick(v)}>${label}</button>`)}
</div>`;

export function AutomationsMap() {
  const [view, setView] = useState(viewOfHash);
  // An entry Process asked to see on the map
  const [focus, setFocus] = useState(null);
  useEffect(() => {
    const on = () => { if (/^#automations\b/.test(location.hash)) setView(viewOfHash()); };
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, []);
  const pick = (v) => {
    if (v === view) return;
    setFocus(null);
    setView(v);
    history.replaceState(history.state, '', v === 'process' ? hashOfTrack(currentTrack()) : '#automations');
  };
  // A step back from the map returns to Process
  const showOnMap = (id) => {
    setFocus(id);
    setView('map');
    history.pushState(history.state, '', '#automations');
  };
  const switcher = html`<${Switcher} view=${view} onPick=${pick} />`;
  if (view === 'process') return html`<${ProcessView} model=${model} getFacts=${getFacts} switcher=${switcher} kinds=${KIND} onShowOnMap=${showOnMap} />`;
  return html`<${MindMap}
    model=${model} palette=${PALETTE} factsUrl=${FACTS_URL} written=${WRITTEN_ON} getFacts=${getFacts} focus=${focus} headerExtra=${switcher}
    title="Automations"
    sub="Everything that runs on its own or connects SOARD to another service. Pick anything to see what starts it, what it does and where it lives."
    filters=${FILTERS} filterMatch=${filterMatch} shape=${shape}
    lede=${({ stat, attn, parked, home }) => html`
      <li><b>${stat((n) => (n.k === 'schedule' || n.k === 'event') && n.es === 'live')}</b> run on their own</li>
      <li><b>${stat((n) => n.k === 'visitor' && n.es === 'live')}</b> react to visitors</li>
      <li><b>${stat((n) => n.k === 'admin')}</b> staff buttons</li>
      <li><b>${stat((n) => n.k === 'link')}</b> connections</li>
      <li><button type="button" onClick=${home}><b>${parked.length}</b> <span>parked or off</span></button></li>
      <li class="am-warnstat"><button type="button" onClick=${home}><b>${attn.length}</b> <span>need attention</span></button></li>`}
    entry=${Entry}
    homeNote="Pick anything on the map to see what starts it, what it does and where it lives."
    depNoun=${['automation or connection', 'automations and connections']}
    legend=${html`<span><span class="am-dot-i s-live k-link"></span>Connection</span>`}
    searchLabel="Search automations" searchPlaceholder="Search: Kit, JobTread, Slack…" ariaLabel="Automations mindmap"
    list=${{
      title: 'Everything, as a list',
      intro: 'The same map, written out. Green is live, an open circle is built but switched off or in test, amber needs someone.',
      meta: (l) => `${STATUS[l.es]} · ${KIND[l.k]}${l.when ? ` · ${l.when}` : ''}`,
      body: (l) => html`${l.does && html`<p>${l.does}</p>`}${l.where && html`<code>${l.where}</code>`}`,
    }}
  />`;
}
