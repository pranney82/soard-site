/**
 * Emails & invites (admin)
 * ========================
 * Loaded on demand by Site → Emails & invites. Everything the site sends a
 * person, on the same map as Site → Automations (./mindmap.js): who gets it,
 * when it goes, what it says, whether it's on right now, when it last went,
 * and the message itself, filled in for a sample family, with "Send it to me".
 *
 * Two layers, like the automations map:
 *  - MAP below is the curated description. Update it when a message is added
 *    or retired, and bump WRITTEN_ON. Each entry's `preview` is an id that
 *    /api/messages-admin knows how to build with the real sending code.
 *  - Each entry's live(f) reads /api/messages-admin (switches, keys present,
 *    what's waiting, times and counts from the send logs) and returns
 *    { s, why, last }; leave out s to keep the written status.
 *
 * Channels (k): email (the site, through Resend) | jobtread (posted on the
 * family's JobTread account; JobTread emails it) | kit (Kit, to a list) |
 * invite (Google Calendar) | text (Twilio) | mail (opens your own email app).
 * `also` lists more channels the same message goes by. by: auto | visitor | staff.
 * spanish: the family gets it in Spanish when that's their language. (Not `es`:
 * the map uses that for an entry's effective status.)
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { MindMap, prepareMap, Ago, STATUS, plural } from './mindmap.js';

const html = htm.bind(h);

const WRITTEN_ON = 'October 21, 2026';
const API = '/api/messages-admin';

// ─── Live check helpers ───────────────────
const ON = (why, last) => ({ s: 'live', why, last });
const OFF = (why, last) => ({ s: 'off', why, last });
const ATTN = (why, last) => ({ s: 'attn', why, last });
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
/** "3 in the last 30 days (5 in all)." from { last, n30, total } */
const sentLine = (t, noun = 'sent') => {
  if (!t) return '';
  if (!t.total && !t.n30) return `None ${noun} yet.`;
  return `${t.n30} in the last 30 days${t.total > t.n30 ? `, ${t.total} in all` : ''}.`;
};
const latest = (...isos) => isos.filter(Boolean).sort().pop() || null;
const needs = (flag, missing) => (f) => (!f.env ? null : f.env[flag] ? null : ATTN(missing));
const first = (...checks) => (f) => {
  for (const c of checks) { const r = c(f); if (r) return r; }
  return null;
};

const NO_RESEND = 'RESEND_API_KEY isn’t in Cloudflare, so the site can’t send this.';
const NO_JT = 'No JobTread key in Cloudflare (JOBTREAD_QC_GRANT_KEY, or JOBTREAD_GRANT_KEY), so status messages can’t be posted.';
const NO_KIT = 'KIT_API_KEY isn’t in Cloudflare, so Kit can’t be reached.';
const NO_CAL = 'GOOGLE_CALENDAR_KEY isn’t in Cloudflare, so invites can’t be made.';
const REM_SETTINGS = 'Reveals → Settings → Reminders';
const REM_OFF = `Reminders are switched off in ${REM_SETTINGS}, so nobody gets them.`;

// Family status emails: JobTread key, then the pause, then what's waiting and what went
const statusLive = (kind) => first(needs('jobtread', NO_JT), (f) => {
  if (f.pause?.active) return OFF(`Family emails are paused until ${clock(f.pause.until)}${f.pause.by ? ` (${f.pause.by})` : ''}. ${f.pause.held ? `${plural(f.pause.held, 'email is', 'emails are')} held; they go only if someone sends them.` : 'Nothing is held yet.'}`);
  if (!f.family) return null;
  const t = f.family.comms?.[kind];
  const w = f.family.waiting?.[kind];
  const wait = w?.n ? ` ${plural(w.n, 'email is', 'emails are')} waiting to go${w.next ? `, the next at ${clock(w.next)}` : ''}.` : '';
  return ON(`${sentLine(t || { n30: 0, total: 0 })}${wait}`, t?.last);
});

// Reveal reminders: the switches in Reveals → Settings, who signed up, and what each channel sent
const reminderLive = (kind) => (f) => {
  const r = f.reminders;
  if (!r || !f.env) return null;
  const subs = r.subscribers || {};
  const people = (subs.email || 0) + (subs.push || 0);
  const signed = people ? ` ${plural(people, 'signup')} so far (${subs.email || 0} email, ${subs.push || 0} browser).` : ' Nobody has signed up yet.';
  if (!r.enabled) return OFF(REM_OFF);
  if (kind === 'day' && !r.dayBefore) return OFF(`“The day before” is unticked in ${REM_SETTINGS}.`);
  if (kind === 'hour' && !r.hourBefore) return OFF(`“One hour before” is unticked in ${REM_SETTINGS}.`);
  if (!f.env.resend) return ATTN(NO_RESEND);
  const s = r.sends?.[kind] || {};
  const by = [['email', 'emails'], ['push', 'browser alerts']].filter(([c]) => s[c]?.total).map(([c, n]) => `${s[c].total} ${n}`);
  const channels = ['email', r.push && r.vapid ? 'browser alert' : null].filter(Boolean);
  return ON(`Goes by ${channels.join(' and ')}.${signed}${by.length ? ` Sent so far: ${by.join(', ')}.` : ''}`, latest(s.email?.last, s.push?.last));
};
const inviteLive = (which) => first(needs('calendar', NO_CAL), (f) => {
  const v = f.invites;
  if (!v) return null;
  if (!v.enabled) return OFF('Sending is paused in Reveals → Invites. The site works out each invite and records it, and sends nothing.');
  if (v.problems) return ATTN(`${plural(v.problems, 'invite')} couldn’t be updated. Reveals → Now shows which, with Retry.`);
  const out = v.out || {};
  const t = v[which];
  const now = which === 'tentative' ? `${plural(out.tentative || 0, 'save-the-date')} on calendars now.` : which === 'confirmed' ? `${plural(out.confirmed || 0, 'confirmed invite')} on calendars now.` : '';
  return ON(`${now} ${sentLine(t)}`.trim(), t?.last);
});

// ─── The map ──────────────────────────────
const CHANGE = {
  appEmails: { label: 'Applications → Emails', view: 'applications', hash: '#applications/emails' },
  appSettings: { label: 'Applications → Settings', view: 'applications', hash: '#applications/settings' },
  invites: { label: 'Reveals → Invites', view: 'broadcast', hash: '#broadcast/invites' },
  revealSettings: { label: 'Reveals → Settings', view: 'broadcast', hash: '#broadcast/settings' },
  composer: { label: 'Comms → Email', view: 'email' },
  board: { label: 'People → Board', view: 'people-hub', tab: 'board' },
};

const MAP = { t: 'Everything we send', children: [
  // ─── Right side ─────────────────────────
  { t: 'Families', sub: 'Applicants, from the first click to the decision', color: 'family', side: 'r',
    about: 'Status emails post on the family’s JobTread account as the Qualification Committee, so JobTread emails them and the family’s replies land on their page in Applicants. The rest come from the site.',
    children: [
      { t: 'While applying', children: [
        { t: 'Pick up where you left off', s: 'live', k: 'email', by: 'visitor', spanish: true, preview: 'app-resume',
          who: 'The family, at the address they type in.',
          when: 'A family taps “Email me a link” on the application. Up to 5 times for one application.',
          subject: ['Your SOARD application: pick up where you left off', 'Su solicitud de SOARD: continúe donde se quedó'],
          does: 'A link back to their saved answers that works on any device, for 60 days after their last change.',
          touches: ['Resend', 'D1'], where: 'functions/api/apply.js (resumeLinkEmail)',
          info: 'The wording is in the code, not the admin.',
          live: first(needs('resend', NO_RESEND), (f) => (!f.drafts ? null : ON(`${plural(f.drafts.links, 'link')} emailed so far.`))) },
        { t: 'Your application is waiting', s: 'live', k: 'email', by: 'auto', spanish: true, preview: 'app-reminder', change: CHANGE.appEmails,
          who: 'Families who started an application and stopped.',
          when: 'Days after a family’s last change (2, 7 and 21 as built), until they finish or tap “Stop these reminders”. At most one a day.',
          subject: ['Your SOARD application is waiting for you', 'Su solicitud de SOARD le está esperando'],
          does: 'Their answers are saved, how far along they are, and a button back to the application.',
          touches: ['Resend', 'D1'], where: 'functions/api/_applications.js (sendReminders, reminderEmail)',
          live: first((f) => {
            const r = f.form?.reminders;
            if (!r) return null;
            if (!r.enabled) return OFF('Switched off in Applications → Emails → Reminders.');
            if (!r.days?.length) return OFF('On, but no days are set in Applications → Emails → Reminders.');
            return null;
          }, needs('resend', NO_RESEND), (f) => (!f.drafts ? null : ON(`Goes ${f.form.reminders.days.join(', ').replace(/, (\d+)$/, ' and $1')} days after a family stops. ${sentLine(f.drafts.reminders)}`, f.drafts.reminders.last))) },
      ]},
      { t: 'Status emails', children: [
        { t: 'Application received', s: 'live', k: 'jobtread', by: 'auto', spanish: true, preview: 'app-welcome', change: CHANGE.appEmails,
          who: 'The family’s main contact in JobTread.',
          when: 'Right away when a family applies on the website, with their application PDF attached. A family staff add by hand in JobTread gets it once Applied has settled for 10 minutes.',
          subject: ['Application Status', 'Estado de la solicitud'],
          does: 'Thanks the family, says the application is under review, and what happens next.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_applicant-comms.js (sendIntake) · _applicant-notify.js',
          info: 'The admin’s “See what a family receives” (Applications → Form or Emails) sends the real one to you through a sample application.',
          live: statusLive('welcome') },
        { t: 'In review', s: 'live', k: 'jobtread', by: 'auto', spanish: true, preview: 'app-in-review', change: CHANGE.appEmails,
          who: 'The family’s main contact in JobTread.',
          when: 'Once Status has stayed In Review for 10 minutes, never between 8 PM and 8 AM Eastern. Whoever made the change gets a summary first, with Move back.',
          subject: ['Application In Review', 'Solicitud en revisión'],
          does: 'The application moved to the on-site visit, and what that visit is.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_applicant-notify.js (noteStatus, runNotifications)',
          live: statusLive('inReview') },
        { t: 'Approved', s: 'live', k: 'jobtread', by: 'auto', spanish: true, preview: 'app-approved', change: CHANGE.appEmails,
          who: 'The family’s main contact in JobTread.',
          when: 'Once Status has stayed Approved for 30 minutes, never between 8 PM and 8 AM Eastern.',
          subject: ['Application Decision', 'Decisión sobre la solicitud'],
          does: 'The application is approved and the makeover is on the waitlist.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_applicant-notify.js',
          live: statusLive('approved') },
        { t: 'Denied', s: 'live', k: 'jobtread', by: 'auto', spanish: true, preview: 'app-denied', change: CHANGE.appEmails,
          who: 'The family’s main contact in JobTread.',
          when: 'Once Status has stayed Denied for 30 minutes, never between 8 PM and 8 AM Eastern.',
          subject: ['Application Decision', 'Decisión sobre la solicitud'],
          does: 'SOARD can’t move forward with the request, and why decisions are made the way they are.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_applicant-notify.js',
          live: statusLive('denied') },
        { t: 'Correction', s: 'live', k: 'jobtread', by: 'staff', spanish: true, preview: 'app-correction', change: CHANGE.appEmails,
          who: 'A family who was emailed a status by mistake.',
          when: 'Only when staff send it from the family’s page in Applicants, after reading it over.',
          subject: ['An update on your application', 'Una actualización sobre su solicitud'],
          does: 'Asks the family to disregard the last message, and says where the application really stands.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_applicant-notify.js (correctionDraft, sendCorrection)',
          live: first(needs('jobtread', NO_JT), (f) => (!f.family ? null : ON(sentLine(f.family.correction), f.family.correction?.last))) },
        { t: 'A note from staff', s: 'live', k: 'jobtread', by: 'staff',
          who: 'A family contact staff pick.',
          when: 'Staff write it on the family’s page in Applicants and press Send.',
          subject: 'A message from Sunshine on a Ranney Day (staff can change it)',
          does: 'Whatever staff write. It posts on the family’s JobTread account like the status emails, so replies come back to the same page.',
          touches: ['JobTread', 'D1'], where: 'functions/api/_applicants.js (messageFamily)',
          live: first(needs('jobtread', NO_JT), (f) => (!f.family ? null : ON(sentLine(f.family.message), f.family.message?.last))) },
      ]},
      { t: 'Waitlist', children: [
        { t: 'You’re on the list', s: 'live', k: 'email', by: 'visitor', spanish: true, preview: 'waitlist-confirm', change: CHANGE.appSettings,
          who: 'A family who asks to hear when applications open.',
          when: 'Right after they sign up on the Apply page or the closed form (at most one a day per address).',
          subject: ['You’re on the list', 'Ya está en la lista'],
          does: 'Confirms they’ll be emailed the moment applications open, and how the program works.',
          touches: ['Resend', 'Kit', 'D1'], where: 'functions/api/_application-waitlist.js (recordSignup, confirmationEmail)',
          live: first(needs('resend', NO_RESEND), (f) => (!f.waitlist?.confirmations ? null : ON(sentLine(f.waitlist.confirmations), f.waitlist.confirmations.last))) },
        { t: 'Applications are open', s: 'live', k: 'kit', also: ['email'], by: 'auto', spanish: true, preview: 'waitlist-open', change: CHANGE.appSettings,
          who: 'Every family on the waitlist, in their language.',
          when: 'Applications are switched open: 10 minutes later (time to take it back), or at once when the open time was scheduled.',
          subject: ['Applications are open: apply for a {year} room makeover', 'Ya abrimos las solicitudes para las remodelaciones de {year}'],
          does: 'Applications are open, with a button to the form. Kit sends it; families Kit can’t reach get it from the site at the same time.',
          fromNote: { resend: 'Only for families Kit can’t reach, at the same moment, or for everyone if Kit can’t take it for 2 hours.' },
          touches: ['Kit', 'Resend', 'D1'], where: 'functions/api/_application-waitlist.js (advanceOpening, openingEmail)',
          info: 'Applications → Settings → Waitlist has the wording, “Try it on yourself” and “Rehearse through Kit”. If Kit can’t take it for 2 hours, the site emails everyone itself.',
          live: first(needs('kit', NO_KIT), (f) => {
            const w = f.waitlist;
            if (!w) return null;
            if (w.kit && !w.kit.ok) return ATTN(`Kit isn’t answering (${w.kit.error || 'no reply'}). If it’s still down when applications open, the site emails everyone itself after 2 hours.`, w.kit.at);
            const o = w.opening;
            if (o && ['countdown', 'preparing', 'sending'].includes(o.state)) return ON(`Going out now to ${plural(o.total, 'family', 'families')}.`, o.openedAt);
            if (o?.state === 'sent') return ON(`Last sent to ${plural(o.total, 'family', 'families')} on ${day(o.sentAt)}. ${plural(w.waiting, 'family is', 'families are')} waiting for the next opening.`, o.sentAt);
            return ON(`${plural(w.waiting, 'family is', 'families are')} waiting for it. It goes the moment applications open.`);
          }) },
      ]},
    ]},

  { t: 'Reveal guests', sub: 'One calendar invite per reveal, from save-the-date to the day', color: 'reveals', side: 'r',
    about: 'One Google Calendar event per reveal, on the organizer’s calendar, so Google sends the invitation and update emails. JobTread decides what it says and who’s on it. The site never cancels an invite.',
    children: [
      { t: 'The invite', children: [
        { t: 'Save-the-date invite', s: 'live', k: 'invite', by: 'auto', preview: 'invite-tentative', change: CHANGE.invites,
          who: 'The family, staff (JobTread Admins and Designers), and the board and advisors.',
          when: 'Once construction starts in JobTread, for the date on the Reveal task.',
          subject: '{name}’s Reveal Day (tentative)',
          does: 'An all-day save-the-date, shown as free so it blocks no one’s day, with the full address and a link to watch live. No time yet, and no need to reply.',
          touches: ['Google Calendar', 'JobTread', 'D1'], where: 'functions/api/_reveal-invites.js (planInvite)',
          info: 'Per-reveal notes go in the JobTread field “Reveal Invite Details”. Send it to me makes a separate TEST invite on the office sandbox job, inviting only you.',
          live: inviteLive('tentative') },
        { t: 'Confirmed invite', s: 'live', k: 'invite', by: 'auto', preview: 'invite-confirmed', change: CHANGE.invites,
          who: 'Everyone on the save-the-date, plus vendors, sponsors, photographers and design partners on the job.',
          when: 'Reveal Date Confirmed turns Yes in JobTread. The same event gains its time.',
          subject: '{name}’s Reveal Day',
          does: 'The date and time (shown as busy), the address, and a request to accept or decline so SOARD knows who to expect.',
          touches: ['Google Calendar', 'JobTread', 'D1'], where: 'functions/api/_reveal-invites.js (planInvite)',
          live: inviteLive('confirmed') },
        { t: 'Changed invite', s: 'live', k: 'invite', by: 'auto', preview: 'invite-update', change: CHANGE.invites,
          who: 'Everyone on the invite.',
          when: 'The date, time, address, confirmation, notes or guests change. A change to staff guests only goes quietly.',
          subject: 'Updated invitation: {name}’s Reveal Day',
          does: 'Google’s “Updated invitation” email with the new details. Wording edits alone never re-send.',
          touches: ['Google Calendar', 'JobTread', 'D1'], where: 'functions/api/_reveal-invites.js (reconcile, the 5-minute guest check)',
          live: inviteLive('updated') },
      ]},
    ]},

  { t: 'Reveal watchers', sub: 'People who asked for reminders on a reveal page', color: 'live', side: 'r',
    about: 'Anyone can sign up on a reveal or kid page for reminders by email or browser alert. The public is never texted. Newsletter subscribers hear about reveals through Kit instead.',
    children: [
      { t: 'Signing up', children: [
        { t: 'Confirm your reminders', s: 'live', k: 'email', by: 'visitor', preview: 'rem-confirm', change: CHANGE.revealSettings,
          who: 'A new address signed up on a reveal page.',
          when: 'Right after they sign up. Nothing else goes until they tap the link (it works for 3 days).',
          subject: 'Confirm your reminders for {kid}’s reveal',
          does: 'One button that confirms the address. If it wasn’t them, nothing else is sent.',
          touches: ['Resend', 'D1'], where: 'functions/api/reminders.js · _broadcast-notify.js (confirmEmail)',
          info: 'While reminders are switched off, reveal pages hide the sign-up box.',
          live: first((f) => (!f.reminders ? null : !f.reminders.enabled ? OFF(REM_OFF) : null), needs('resend', NO_RESEND), () => ON()) },
      ]},
      { t: 'Reminders', children: [
        { t: 'Save the date', s: 'live', k: 'email', also: ['push'], by: 'auto', preview: 'rem-scheduled', change: CHANGE.revealSettings,
          who: 'Everyone signed up for reminders (for this kid, or for every reveal).',
          when: 'A reveal is scheduled (by hand, or by JobTread’s countdown) more than 26 hours ahead.',
          subject: 'Save the date: {kid}’s room reveal',
          does: 'The date and time, and that reminders come the day before and an hour before.',
          touches: ['Resend', 'Web Push', 'D1'], where: 'functions/api/_broadcast.js (sendReminders) · _broadcast-notify.js (reminderEmail, reminderPush)',
          live: reminderLive('scheduled') },
        { t: 'New date', s: 'live', k: 'email', also: ['push'], by: 'auto', preview: 'rem-moved', change: CHANGE.revealSettings,
          who: 'Everyone signed up for this reveal.',
          when: 'The reveal moves to another day, more than 26 hours out.',
          subject: 'New date: {kid}’s room reveal',
          does: 'The new date and time.',
          touches: ['Resend', 'Web Push', 'D1'], where: 'functions/api/_broadcast.js',
          live: reminderLive('moved') },
        { t: 'The day before', s: 'live', k: 'email', also: ['push'], by: 'auto', preview: 'rem-day', change: CHANGE.revealSettings,
          who: 'Everyone signed up for this reveal.',
          when: '24 hours before the reveal (the same day, when the countdown goes up that day).',
          subject: 'Tomorrow: {kid}’s room reveal, live',
          does: 'Tomorrow (or today) is reveal day, and when it goes live.',
          touches: ['Resend', 'Web Push', 'D1'], where: 'functions/api/_broadcast.js (dueReminderKinds)',
          live: reminderLive('day') },
        { t: 'One hour to go', s: 'live', k: 'email', also: ['push'], by: 'auto', preview: 'rem-hour', change: CHANGE.revealSettings,
          who: 'Everyone signed up for this reveal.',
          when: 'An hour before the reveal.',
          subject: 'One hour to go: {kid}’s reveal',
          does: 'It goes live in about an hour, with the link to watch.',
          touches: ['Resend', 'Web Push', 'D1'], where: 'functions/api/_broadcast.js (dueReminderKinds)',
          live: reminderLive('hour') },
        { t: 'We’re live', s: 'live', k: 'email', also: ['push'], by: 'auto', preview: 'rem-live', change: CHANGE.revealSettings,
          who: 'Everyone signed up for this reveal.',
          when: 'The stream goes live.',
          subject: 'We’re live: {kid}’s room reveal',
          does: 'It’s happening right now, with the link to watch.',
          touches: ['Resend', 'Web Push', 'D1'], where: 'functions/api/_broadcast.js',
          live: reminderLive('live') },
        { t: 'The replay is ready', s: 'live', k: 'email', also: ['push'], by: 'auto', preview: 'rem-replay', change: CHANGE.revealSettings,
          who: 'Everyone signed up for this reveal.',
          when: 'The replay is ready after the stream ends.',
          subject: 'Watch the replay: {kid}’s room reveal',
          does: 'A link to the replay for anyone who missed it.',
          touches: ['Resend', 'Web Push', 'D1'], where: 'functions/api/_broadcast.js',
          live: reminderLive('replay') },
      ]},
      { t: 'To the newsletter list', children: [
        { t: 'We’re live (Kit)', s: 'live', k: 'kit', by: 'auto', preview: 'kit-live', change: CHANGE.revealSettings,
          who: 'The whole newsletter list in Kit, except families on the applications waitlist only.',
          when: 'Three minutes into a steady stream with the kid known. Held if the stream starts more than 30 minutes early. Each reveal can opt out when it’s scheduled.',
          subject: 'We’re live: {kid}’s room reveal',
          does: 'It’s happening right now, with the link to watch.',
          touches: ['Kit', 'D1'], where: 'functions/api/_broadcast.js (kitAutoLive, sendKitLive)',
          live: first(needs('kit', NO_KIT), (f) => {
            const r = f.reminders;
            if (!r) return null;
            if (!r.kitLive) return OFF(`Switched off in ${REM_SETTINGS} → Kit.`);
            const k = r.sends?.live?.kit;
            return ON(k?.total ? `Sent for ${plural(k.total, 'reveal')} so far.` : 'Not sent for a reveal yet.', k?.last);
          }) },
        { t: 'Reveal drafts in Kit', s: 'live', k: 'kit', by: 'auto', preview: 'kit-drafts',
          who: 'Nobody, until staff send it from Kit.',
          when: 'A reveal is scheduled (Save the date) or moved (New date), and when its replay is ready (Watch the replay).',
          subject: 'Save the date / New date / Watch the replay: {kid}’s room reveal',
          does: 'Drafts in Kit, ready to look over and send to the list.',
          touches: ['Kit'], where: 'functions/api/_broadcast.js (draftKit)',
          live: first(needs('kit', NO_KIT), () => ON()) },
      ]},
    ]},

  // ─── Left side ──────────────────────────
  { t: 'Staff', sub: 'Notices and alerts, by email (and in Slack)', color: 'site', side: 'l',
    about: 'Staff notices also post in Slack, in #team-everyone. None of these ever go to a family.',
    children: [
      { t: 'Applications', children: [
        { t: 'New application', s: 'live', k: 'email', by: 'auto', preview: 'staff-new-app', change: CHANGE.appSettings,
          who: 'The staff list in Applications → Settings.',
          when: 'A family applies on the website and it’s in JobTread.',
          subject: 'New makeover application: {child}',
          does: 'The makeover, the child, diagnosis, county, service area, repeat check, photos and video, with buttons to Applicants and JobTread.',
          touches: ['Resend', 'Slack', 'D1'], where: 'functions/api/_applications.js (staffEmail)',
          info: 'It holds the family’s diagnosis and contact details, so it says to keep it inside SOARD.',
          live: first(needs('resend', NO_RESEND), (f) => (!f.form ? null : ON(`Goes to ${plural(f.form.staffEmails, 'address', 'addresses')}. ${sentLine(f.staff?.newApplication)}`, f.staff?.newApplication?.last))) },
        { t: 'Status change summary', s: 'live', k: 'email', by: 'auto', preview: 'staff-summary', change: CHANGE.appSettings,
          who: 'Whoever changed statuses in JobTread (or the staff list, when an integration did).',
          when: 'Three quiet minutes after someone changes statuses. Family emails wait until 5 minutes after it.',
          subject: '{child} moved to {status} · family email at {time}',
          does: 'Each change, when the family is emailed and a preview of what they get, with Move back, Don’t email and Send now.',
          touches: ['Resend', 'D1'], where: 'functions/api/_applicant-notify.js (sendSummaries, summaryEmail)',
          live: first((f) => (f.form?.notify && f.form.notify.summary === false ? OFF('Switched off in Applications → Settings → When status emails go out.') : null), needs('resend', NO_RESEND), (f) => (!f.family ? null : ON(sentLine(f.family.summaries), f.family.summaries?.last))) },
        { t: 'Family emails back on', s: 'live', k: 'email', by: 'auto', preview: 'staff-pause-ended',
          who: 'Whoever paused family emails.',
          when: 'A pause (up to 2 hours) runs out with status emails held.',
          subject: 'Family emails are back on. {n} emails are held from the pause',
          does: 'Which families’ emails are held, and a button to decide in the admin. Held emails go only if someone sends them.',
          touches: ['Resend'], where: 'functions/api/_applicant-notify.js (pauseEndedEmail)',
          live: (f) => (!f.pause ? null : f.pause.active ? ON(`Family emails are paused until ${clock(f.pause.until)}, so this goes then if anything is held.`) : ON()) },
        { t: 'Waitlist notices', s: 'live', k: 'email', by: 'auto', preview: 'staff-waitlist', change: CHANGE.appSettings,
          who: 'The staff list in Applications → Settings (problems also go to Peter).',
          when: 'Applications open (the countdown), the email goes out, it’s sent, or something needs a hand.',
          subject: 'Applications are open: the waitlist email goes out at {time}',
          does: 'What’s happening with the applications-open email, and how to stop it in time.',
          touches: ['Resend', 'Slack'], where: 'functions/api/_application-waitlist.js (tellStaff)',
          live: needs('resend', NO_RESEND) },
        { t: 'Application limit', s: 'live', k: 'email', by: 'auto', preview: 'staff-app-limit', change: CHANGE.appSettings,
          who: 'The staff list in Applications → Settings.',
          when: 'The season nears its limit (80% of it unless Settings says otherwise), then again when it fills and applications close by themselves. Only once a limit is set.',
          subject: '{n} of {limit} applications are in for {year}',
          does: 'How many are in and left, families partway through the form, the pace, and how to take more. When it fills: that applications closed by themselves and what new families now read.',
          touches: ['Resend', 'Slack', 'D1'], where: 'functions/api/_application-cap.js (tellCap, capEmail)',
          info: 'If a scheduled opening finds the season already full, the same email says it stayed closed, and the Slack post goes to Needs attention.',
          live: first(needs('resend', NO_RESEND), (f) => {
            const l = f.applicationLimit;
            if (!l) return null;
            if (!l.max) return OFF(`No limit is set for ${l.year}, so this never goes. Set one in Applications → Settings → Application limit.`);
            return ON(l.full ? `The ${l.year} season is full (${l.received} of ${l.max}).` : `${l.received} of ${l.max} are in for ${l.year}; the heads-up goes at ${l.warnAt}.`, l.last?.at);
          }) },
        { t: 'Application stuck', s: 'live', k: 'email', by: 'auto', preview: 'staff-stuck',
          who: 'Peter.',
          when: 'An application still can’t get into JobTread after 4 tries. The site keeps retrying.',
          subject: 'Application for {child} is stuck',
          does: 'What JobTread said, and a link to retry it now.',
          touches: ['Resend', 'Slack', 'JobTread'], where: 'functions/api/_applications.js (stuckEmail)',
          live: (f) => (!f.staff ? null : f.staff.stuck ? ATTN(`${plural(f.staff.stuck, 'application is', 'applications are')} stuck right now. Applications → Applicants shows which.`) : ON('Nothing is stuck.')) },
      ]},
      { t: 'Reveals', children: [
        { t: 'Live reveal alerts', s: 'live', k: 'email', also: ['text'], by: 'auto', preview: 'staff-live-alert', change: CHANGE.revealSettings,
          who: 'The alert list in Reveals → Settings → Alerts. Reveal-day alerts also text the staff numbers there.',
          when: 'A reveal never starts streaming, Stream reports an error, a check fails, or (while live) the sound drops, the picture freezes or Facebook isn’t live. Good news too: live now, ended.',
          subject: '[SOARD Live] {what happened}',
          does: 'What happened, the fix, and a link. The same words post in Slack as a card. Texts carry the headline, the fix and the link: a feed problem and when it clears, the go / no-go, “Live now” and “All green”.',
          touches: ['Resend', 'Slack', 'Twilio'], where: 'functions/api/_broadcast-notify.js (alertAdmins, alertEmail, alertText)',
          live: first(needs('resend', NO_RESEND), (f) => {
            if (!f.reminders) return null;
            const n = (f.reminders.alertEmails || 0) + (f.env.alertEnv || 0);
            const texts = f.env.twilio && f.reminders.alertPhones ? `, texts to ${plural(f.reminders.alertPhones, 'staff number')}` : '';
            return n ? ON(`Goes to ${plural(n, 'address', 'addresses')}${texts}, and Slack.`) : ATTN(`Nobody is on the alert list. Add an address in Reveals → Settings → Alerts.`);
          }) },
        { t: 'Welcome to the alert list', s: 'live', k: 'email', by: 'staff', preview: 'staff-alert-hello', change: CHANGE.revealSettings,
          who: 'A new address on the alert list.',
          when: 'Someone adds the address in Reveals → Settings → Alerts and saves.',
          subject: 'You’ll get live reveal alerts at this address',
          does: 'Proof that alerts reach them, and what an alert is about.',
          touches: ['Resend'], where: 'functions/api/broadcast-admin.js (alertHelloEmail)',
          live: needs('resend', NO_RESEND) },
        { t: 'Welcome to alert texts', s: 'live', k: 'text', by: 'staff', preview: 'staff-alert-hello-text', change: CHANGE.revealSettings,
          who: 'A new staff number on the alert list.',
          when: 'Someone adds the number in Reveals → Settings → Alerts and saves.',
          does: 'Proof that texts reach the phone, what they’re about, and that replying STOP ends them.',
          touches: ['Twilio'], where: 'functions/api/broadcast-admin.js · _broadcast-notify.js (alertHelloText)',
          live: (f) => (!f.env ? null : !f.env.twilio ? OFF('Off until the Twilio keys are in Cloudflare.') : !f.reminders?.alertPhones ? OFF('No staff numbers on the alert list yet.') : ON()) },
        { t: 'Invite problem', s: 'live', k: 'email', by: 'auto', preview: 'staff-invite-problem', change: CHANGE.invites,
          who: 'The invite alert list, the organizer, and Peter.',
          when: 'A reveal’s calendar invite can’t be updated.',
          subject: '[SOARD] Reveal invite problem: {kid}',
          does: 'What Google or JobTread said, and the fix.',
          touches: ['Resend', 'Slack'], where: 'functions/api/_reveal-invites.js (inviteAlert)',
          live: (f) => (!f.invites ? null : f.invites.problems ? ATTN(`${plural(f.invites.problems, 'invite has', 'invites have')} a problem right now. Reveals → Now shows which.`) : ON('No invite has a problem right now.')) },
        { t: 'Invite still out', s: 'live', k: 'email', by: 'auto', preview: 'staff-invite-held', change: CHANGE.invites,
          who: 'The invite alert list, the organizer, and Peter.',
          when: 'JobTread says a reveal may be off (job closed, denied, awaiting funding, no date) while its invite is out.',
          subject: '[SOARD] {kid}’s reveal invite is still out',
          does: 'The invite is still on everyone’s calendar, and how to cancel it if the reveal is off.',
          touches: ['Resend', 'Slack'], where: 'functions/api/_reveal-invites.js (inviteAlert)' },
        { t: 'Kid profile hidden', s: 'live', k: 'email', by: 'auto', preview: 'staff-kid-hidden',
          who: 'Peter.',
          when: 'JobTread marks a kid’s job Denied and the site takes the profile off Meet the Kids.',
          subject: '[SOARD] {kid}’s profile is hidden',
          does: 'Why it’s hidden, and that changing the Status back brings it back.',
          touches: ['Resend', 'Slack'], where: 'functions/api/_kid-status.js (deniedAlert)',
          live: (f) => (!f.staff ? null : ON(sentLine(f.staff.kidHidden), f.staff.kidHidden?.last)) },
      ]},
      { t: 'Gifts', children: [
        { t: 'Gift alert problems', s: 'live', k: 'email', by: 'auto', preview: 'staff-gift-problem',
          who: 'Peter.',
          when: 'Gift alerts can’t check Zeffy, the webhook missed a gift, gifts aren’t reaching Slack, or Zeffy’s webhook is refused. At most once a day each.',
          subject: '[SOARD] {what happened}',
          does: 'What’s wrong and the fix. The gift alerts themselves are Slack posts, not emails.',
          touches: ['Resend', 'Zeffy'], where: 'functions/api/_zeffy.js (zeffyAlertEmail)',
          live: (f) => (!f.staff ? null : ON(f.staff.giftProblems?.total ? `Last one ${day(f.staff.giftProblems.last)}.` : 'None needed so far.', f.staff.giftProblems?.last)) },
      ]},
    ]},

  { t: 'Newsletter list', sub: 'Supporters, through Kit', color: 'email', side: 'l',
    about: 'Kit holds the list. Staff build newsletters in Comms → Email; the site makes them drafts in Kit and staff send them from there.',
    children: [
      { t: 'From the email builder', children: [
        { t: 'Newsletter', s: 'live', k: 'kit', by: 'staff', change: CHANGE.composer,
          who: 'The Kit list, or the part of it staff pick in Kit.',
          when: 'Staff build it in Comms → Email and press Push to Kit; it goes when they send the draft from Kit.',
          subject: 'Whatever staff write',
          does: 'Blocks from the email builder: reveals, events, stories, photos.',
          touches: ['Kit'], where: 'functions/api/kit-broadcast.js · _email-templates.js',
          info: 'Comms → Email has its own live preview and Send it to me.',
          live: first(needs('kit', NO_KIT), (f) => {
            const d = f.newsletter?.drafts;
            if (!d) return null;
            return ON(d.total ? `${plural(d.n30, 'draft')} pushed to Kit in the last 30 days, ${d.total} in all.` : 'No drafts pushed to Kit yet.', d.last);
          }) },
        { t: 'Send to specific people', s: 'live', k: 'email', by: 'staff', change: CHANGE.composer,
          who: 'Up to 100 addresses staff type in, each getting their own copy.',
          when: 'Staff press Send to specific people in Comms → Email.',
          subject: 'A note from Sunshine on a Ranney Day (staff can change it)',
          does: 'The same email-builder design, sent one by one from the site (for a reveal RSVP, a sponsor thank-you).',
          touches: ['Resend'], where: 'functions/api/send-direct.js',
          info: 'These aren’t logged, so there’s no count here.',
          live: needs('resend', NO_RESEND) },
      ]},
      { t: 'Kit’s own', children: [
        { t: 'Welcome to the newsletter', s: 'live', k: 'kit', by: 'visitor',
          who: 'Someone who signs up for the newsletter on the site.',
          when: 'Only if a welcome automation is set up in Kit. The site adds the subscriber and a tag, and sends nothing itself.',
          does: 'Whatever Kit’s automation says.',
          touches: ['Kit'], where: 'functions/api/newsletter.js · _kit.js (kitSubscribe)',
          info: 'Look in Kit → Automate to see or change it.' },
      ]},
    ]},

  { t: 'Board & advisors', sub: 'Every reveal invite, and bio requests', color: 'board', side: 'l',
    about: 'Board members and advisors are guests on every reveal invite. Bio requests and notes to the board go from your own email.',
    children: [
      { t: 'From the site', children: [
        { t: 'Reveal invites', s: 'live', k: 'invite', by: 'auto', preview: 'board-invites', change: CHANGE.board,
          who: 'Board members and advisors with an email on file, plus JobTread Board Member users.',
          when: 'Every reveal, from the save-the-date on, the same invite the family gets.',
          subject: '{name}’s Reveal Day (tentative), then {name}’s Reveal Day',
          does: 'The reveal’s date, time and address. A changed board email updates the invites already out.',
          touches: ['Google Calendar', 'D1'], where: 'functions/api/_reveal-invites.js (guestGroups, refreshForBoardChange)',
          live: first(needs('calendar', NO_CAL), (f) => (!f.invites ? null : !f.invites.enabled ? OFF('Sending is paused in Reveals → Invites.') : ON(f.invites.boardEmails != null ? `${plural(f.invites.boardEmails, 'board or advisory address', 'board and advisory addresses')} on file.` : null))) },
      ]},
      { t: 'From your own email', children: [
        { t: 'Bio request', s: 'live', k: 'mail', by: 'staff', change: CHANGE.board,
          who: 'One board member or advisor.',
          when: 'Staff press “Email {first}” on their page in People. Your own email app opens with the message written.',
          subject: 'Your bio for the Sunshine on a Ranney Day website',
          does: 'A private link to a form where they write their own bio and send a photo. Staff review it before it goes on the site.',
          touches: ['D1'], where: 'public/admin/index.html (People) · functions/api/profile-request.js',
          info: 'The site tracks the link, not the email.',
          live: (f) => (!f.bios ? null : ON(f.bios.total ? `${plural(f.bios.total, 'link')} made, ${f.bios.answered} answered, ${f.bios.open} still open.` : 'No bio links made yet.', f.bios.last)) },
        { t: 'Note to the whole board', s: 'live', k: 'mail', by: 'staff', change: CHANGE.board,
          who: 'Every board member, in Bcc.',
          when: 'Staff press “Write to the whole board” in People → Board.',
          does: 'Your own email app opens with everyone’s address in Bcc.',
          touches: [], where: 'public/admin/index.html (People → Board)' },
      ]},
    ]},
]};

// ─── Vocabulary ───────────────────────────
// ─── Who sends it ─────────────────────────
// Each channel has one sender; an entry is sent by its channels' senders
// (Applications are open: Kit, and Resend for families Kit can't reach)
const SENDERS = {
  resend: { label: 'Resend', color: '#3F3F46', from: 'Resend, as Sunshine on a Ranney Day <sunshine@comms.sunshineonaranneyday.com>. The site sends each one itself.' },
  jobtread: { label: 'JobTread', color: '#2F6B1F', from: 'JobTread. The site posts it on the family’s JobTread account as the Qualification Committee, and JobTread emails it. Replies land on the family’s page.' },
  kit: { label: 'Kit', color: '#1D5FA8', from: 'Kit, from SOARD’s Kit sender (linzi@soardcharity.com), to a list.' },
  google: { label: 'Google Calendar', color: '#7A5B00', from: 'Google Calendar, from the organizer’s calendar (set in Reveals → Invites). Google sends the invitation and update emails.' },
  twilio: { label: 'Twilio', color: '#9A4A12', from: 'Twilio, from SOARD’s toll-free number.' },
  push: { label: 'Browser', color: '#5B4BC4', from: 'The person’s own browser, as a notification from sunshineonaranneyday.com.' },
  you: { label: 'Your email', color: '#5F6066', from: 'Your own email app, from your own address. The site doesn’t send it.' },
};
const SENDER_OF = { email: 'resend', jobtread: 'jobtread', kit: 'kit', invite: 'google', text: 'twilio', push: 'push', mail: 'you' };
const PART = { email: 'The email', jobtread: 'The email', kit: 'The email', invite: 'The invite', text: 'The text', push: 'The browser alert', mail: 'The email' };
/** Who sends an entry, first sender first. Exported for tests */
export const sendersOf = (n) => [...new Set([n.k, ...(n.also || [])].map((c) => SENDER_OF[c]))];
/** One line per sender; "The text:" and the like only when the parts differ (a reminder's email, text and alert) */
const fromLines = (n) => {
  const chans = [n.k, ...(n.also || [])].filter((c, i, all) => all.findIndex((x) => SENDER_OF[x] === SENDER_OF[c]) === i);
  const labelled = new Set(chans.map((c) => PART[c])).size > 1;
  return chans.map((c) => {
    const who = SENDER_OF[c];
    return html`<p key=${c}>${labelled && html`<b>${PART[c]}:</b> `}${SENDERS[who].from}${n.fromNote?.[who] && html` ${n.fromNote[who]}`}</p>`;
  });
};
const tagsOf = (n) => sendersOf(n).map((s) => ({ label: SENDERS[s].label, color: SENDERS[s].color }));
const Sender = ({ s }) => html`<span class="mm-sender" style=${`--tg: ${SENDERS[s].color}`}>${SENDERS[s].label}</span>`;
const BY = { auto: 'Goes out on its own', visitor: 'When someone signs up or asks', staff: 'Staff send it' };
const FILTERS = [
  { label: null, items: [['all', 'Everything'], ['auto', 'Go out on their own'], ['staff', 'Staff send these'], ['attn', 'Needs a look']] },
  { label: 'Sent by', items: [['s:resend', 'Resend'], ['s:jobtread', 'JobTread'], ['s:kit', 'Kit'], ['s:google', 'Google Calendar'], ['s:twilio', 'Twilio']] },
];
const filterMatch = (n, k) => (k.startsWith('s:') ? sendersOf(n).includes(k.slice(2)) : n.by === k);
const shape = (n) => (n.k === 'invite' ? 'square' : 'circle');
const PALETTE = { family: '#8C3D6B', reveals: '#B08900', live: '#6352C9', site: '#13807A', email: '#2B6CB0', board: '#A0571A' };
const TEXT_FROM = 'SOARD’s alert number, through Twilio';
const PUSH_FROM = 'sunshineonaranneyday.com, as a browser notification';
const SEE = { email: 'See the email', jobtread: 'See the email', kit: 'See the email', invite: 'See the invite', text: 'See the text' };

const model = prepareMap(MAP, 'm');
/** Apply the live facts to every entry. Exported for tests. */
export const applyFacts = model.applyFacts;
export const ENTRIES = model.ALL;

const subjectOf = (n, lang = 'en') => (Array.isArray(n.subject) ? n.subject[lang === 'es' ? 1 : 0] : n.subject);

// ─── Styles (the map's own are mindmap.js's) ──
const CSS = `
.mm-sender { display: inline-flex; align-items: center; padding: 0.12rem 0.55rem; border-radius: 999px; font-size: 0.76rem; font-weight: 650; color: var(--tg); background: color-mix(in srgb, var(--tg) 13%, var(--color-bg-card)); }
.am-meta .mm-sender { padding: 0 0.45rem; font-size: 0.72rem; margin-right: 0.2rem; }
.mm-from p { margin: 0; }
.mm-from p + p { margin-top: 0.35rem; }
.mm-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 1rem; }
.mm-subject { font-weight: 600; }
.mm-subject small { display: block; margin-top: 0.15rem; font-weight: 400; color: var(--color-text-muted); }
.mm-change { all: unset; cursor: pointer; color: var(--color-link, #2B6CB0); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.mm-change:focus-visible { box-shadow: var(--focus-ring); border-radius: 3px; }
.mm-sheet-wrap { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgba(20,21,24,0.48); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); animation: overlayIn 0.18s ease-out; }
.mm-sheet { display: flex; flex-direction: column; width: min(760px, 100%); max-height: calc(100vh - 2rem); background: var(--color-bg-card); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); overflow: hidden; }
.mm-sheet-head { display: flex; align-items: start; justify-content: space-between; gap: 0.75rem; padding: 1.1rem 1.25rem 0.8rem; border-bottom: 1px solid var(--color-border); }
.mm-sheet-head h3 { margin: 0; font-size: 1.1rem; letter-spacing: -0.015em; }
.mm-sheet-head p { margin: 0.15rem 0 0; font-size: 0.82rem; color: var(--color-text-muted); }
.mm-env { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.2rem 0.85rem; margin: 0; padding: 0.75rem 1.25rem; font-size: 0.86rem; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); }
.mm-env dt { color: var(--color-text-muted); }
.mm-env dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.mm-env dd.mm-env-subject { font-weight: 650; }
.mm-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.6rem 1.25rem; border-bottom: 1px solid var(--color-border); }
.mm-seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
.mm-seg button { all: unset; cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 6px; font-size: 0.82rem; font-weight: 600; color: var(--color-text-secondary); }
.mm-seg button[aria-pressed="true"] { background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-xs); }
.mm-seg button:focus-visible { box-shadow: var(--focus-ring); }
.mm-body:focus-visible { outline: none; box-shadow: inset var(--focus-ring); }
.mm-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 1rem 1.25rem; background: #F5F4F0; }
.mm-frame-wrap { margin: 0 auto; width: 100%; max-width: 640px; height: 420px; overflow: hidden; border-radius: 10px; background: #F5F4F0; }
.mm-frame-wrap.is-phone { max-width: 380px; }
.mm-frame { display: block; width: 100%; height: 420px; border: 0; background: #F5F4F0; transform-origin: 0 0; }
.mm-jt { max-width: 600px; margin: 0 auto; background: #fff; color: #2D2E33; border: 1px solid #E5E4E0; border-radius: 12px; padding: 1.1rem 1.25rem; font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
.mm-jt-title { font-weight: 700; font-size: 1rem; margin-bottom: 0.5rem; }
.mm-jt-body { white-space: pre-line; overflow-wrap: anywhere; }
.mm-invite { max-width: 600px; margin: 0 auto; background: #fff; color: #2D2E33; border: 1px solid #E5E4E0; border-radius: 12px; padding: 1.1rem 1.25rem; }
.mm-invite-title { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.55rem; font-weight: 700; font-size: 1.05rem; margin-bottom: 0.6rem; }
.mm-chip { display: inline-flex; align-items: center; padding: 0.12rem 0.55rem; border-radius: 999px; font-size: 0.72rem; font-weight: 700; }
.mm-chip.is-tentative { background: #FFF6CC; color: #6B5300; }
.mm-chip.is-confirmed { background: rgba(47,125,79,0.12); color: #2F7D4F; }
.mm-invite dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.2rem 0.85rem; margin: 0 0 0.8rem; font-size: 0.88rem; }
.mm-invite dt { color: #6B6C72; }
.mm-invite dd { margin: 0; overflow-wrap: anywhere; }
.mm-invite-desc { white-space: pre-line; font-size: 0.9rem; line-height: 1.55; margin: 0; padding-top: 0.75rem; border-top: 1px solid #EEE; overflow-wrap: anywhere; }
.mm-phone { max-width: 340px; margin: 0 auto; padding: 1rem 0.9rem 1.2rem; border-radius: 28px; background: #fff; border: 1px solid #E5E4E0; }
.mm-phone-from { text-align: center; font-size: 0.74rem; color: #6B6C72; margin-bottom: 0.7rem; }
.mm-bubble { max-width: 85%; padding: 0.55rem 0.8rem; border-radius: 18px 18px 18px 6px; background: #E9E9EB; color: #1C1C1E; font: 15px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; overflow-wrap: anywhere; white-space: pre-line; }
.mm-push { max-width: 380px; margin: 0 auto; display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 0.15rem 0.7rem; padding: 0.8rem 0.9rem; border-radius: 16px; background: rgba(255,255,255,0.92); border: 1px solid #E5E4E0; box-shadow: 0 6px 24px rgba(0,0,0,0.08); color: #1C1C1E; font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
.mm-push i { grid-row: span 2; width: 38px; height: 38px; border-radius: 9px; background: #FFDA24; }
.mm-push b { font-weight: 650; }
.mm-push small { grid-column: 2; display: block; color: #6B6C72; font-size: 0.74rem; margin-top: 0.2rem; }
.mm-note { margin: 0.8rem auto 0; max-width: 600px; font-size: 0.82rem; line-height: 1.5; color: #5A5B61; }
.mm-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.8rem 1.25rem; border-top: 1px solid var(--color-border); }
.mm-foot p { margin: 0; font-size: 0.84rem; color: var(--color-text-secondary); flex: 1 1 260px; }
.mm-foot p.is-ok { color: var(--color-success); }
.mm-foot p.is-bad { color: var(--am-warn, #B7791F); }
.mm-wait { display: grid; place-items: center; min-height: 240px; color: #6B6C72; font-size: 0.88rem; }
@media (max-width: 640px) {
  .mm-width { display: none !important; }
  .mm-bar:not(:has(.mm-seg:not(.mm-width))) { display: none; }
  .mm-sheet-wrap { padding: 0; align-items: flex-end; }
  .mm-sheet { max-height: 92vh; border-radius: 16px 16px 0 0; }
}
`;
let cssDone = false;
function ensureCss() {
  if (cssDone) return;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
  cssDone = true;
}

/** JobTread's light formatting (*bold*) as safe text parts */
function jtParts(text) {
  return String(text || '').split(/(\*[^*\n]+\*)/g).map((p, i) => (/^\*[^*\n]+\*$/.test(p) ? html`<strong key=${i}>${p.slice(1, -1)}</strong>` : p));
}
const whenText = (start, end) => {
  if (start?.date) return `${new Date(`${start.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}, all day`;
  const s = start?.dateTime ? new Date(`${start.dateTime}`) : null;
  if (!s) return '';
  const fmt = (d, o) => d.toLocaleString('en-US', o);
  const e = end?.dateTime ? new Date(end.dateTime) : null;
  return `${fmt(s, { weekday: 'long', month: 'long', day: 'numeric' })}, ${fmt(s, { hour: 'numeric', minute: '2-digit' })}${e ? ` to ${fmt(e, { hour: 'numeric', minute: '2-digit' })}` : ''}`;
};

/**
 * The email in a sandboxed frame (no scripts run in it; allow-same-origin only
 * lets this page measure it). Its height follows the email. An email wider
 * than the space (a fixed 600px table on a phone) is shrunk to fit, the way
 * phone mail apps show it; a responsive one uses its own phone layout.
 */
function EmailFrame({ doc, phone, title }) {
  const ref = useRef(null);
  const wrap = useRef(null);
  const fit = () => {
    const f = ref.current;
    const w = wrap.current;
    const root = f?.contentDocument?.documentElement;
    if (!root || !w) return;
    const target = w.clientWidth;
    f.style.width = `${target}px`;
    f.style.transform = '';
    const natural = root.scrollWidth;
    const z = natural > target + 1 ? target / natural : 1;
    if (z < 1) {
      f.style.width = `${natural}px`;
      f.style.transform = `scale(${z})`;
    }
    const tall = Math.max(240, root.scrollHeight + 4);
    f.style.height = `${tall}px`;
    w.style.height = `${Math.ceil(tall * z)}px`;
  };
  useEffect(() => { fit(); }, [phone]);
  // Late fonts and images change the height
  useEffect(() => {
    const t = [300, 1200].map((ms) => setTimeout(fit, ms));
    return () => t.forEach(clearTimeout);
  }, [doc, phone]);
  return html`<div ref=${wrap} class=${`mm-frame-wrap${phone ? ' is-phone' : ''}`}>
    <iframe ref=${ref} class="mm-frame" title=${title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc=${doc} onLoad=${fit}></iframe>
  </div>`;
}

// ─── The preview sheet ────────────────────
function PreviewSheet({ entry, onClose, addToast, returnTo = null }) {
  const [lang, setLang] = useState('en');
  const [view, setView] = useState('email'); // reminders: email | text | push
  const [wide, setWide] = useState(true);
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [send, setSend] = useState({ state: 'idle' });
  const closeRef = useRef(null);
  // Focus goes back to what opened it (Safari doesn't focus a clicked button, so it's passed in)
  const back = useRef(returnTo || document.activeElement);

  useEffect(() => {
    let live = true;
    setP(null); setErr(null);
    fetch(`${API}?preview=${encodeURIComponent(entry.preview)}&lang=${lang}`, { headers: { Accept: 'application/json' } })
      .then((r) => r.json().catch(() => null).then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => { if (!live) return; if (!ok || !b?.success) throw new Error(b?.error || 'The preview didn’t load'); setP(b); })
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [entry.preview, lang]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); back.current?.focus?.(); };
  }, []);

  const sendIt = async () => {
    setSend({ state: 'busy' });
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send: entry.preview, lang }) });
      const b = await r.json().catch(() => null);
      if (!r.ok || !b?.success) throw new Error(b?.error || `HTTP ${r.status}`);
      const text = b.kind === 'invite'
        ? `A TEST ${b.stage === 'confirmed' ? 'confirmed' : 'save-the-date'} invite is on its way to ${b.sentTo}. It’s on the office sandbox job, and nobody else is invited.`
        : `Sent to ${b.sentTo}. Look for [Preview] in the subject.`;
      setSend({ state: 'ok', text });
      addToast?.(text, 'success');
    } catch (e) {
      setSend({ state: 'error', text: e.message });
    }
  };

  const hasText = !!p?.sms;
  const hasPush = !!p?.push;
  const showing = p?.channel === 'text' ? 'text' : view;
  const frameDoc = p?.html ? p.html.replace(/<head>/i, '<head><base target="_blank">') : '';
  const label = SEE[entry.k] || 'See it';

  const body = () => {
    if (err) return html`<div class="mm-wait" role="alert">${err}</div>`;
    if (!p) return html`<div class="mm-wait">Loading the preview…</div>`;
    if (showing === 'text' && p.sms) {
      return html`<div class="mm-phone" aria-label="The text message">
        <div class="mm-phone-from">${p.channel === 'text' ? p.from : TEXT_FROM}</div>
        <div class="mm-bubble">${p.sms}</div>
      </div>`;
    }
    if (showing === 'push' && p.push) {
      return html`<div class="mm-push" aria-label="The browser alert"><i aria-hidden="true"></i><b>${p.push.title}</b><span>${p.push.body}</span><small>sunshineonaranneyday.com · tapping it opens the reveal page</small></div>`;
    }
    if (p.channel === 'jobtread') {
      return html`<div>
        <div class="mm-jt" lang=${lang}>
          <div class="mm-jt-title">${p.subject}</div>
          <div class="mm-jt-body">${jtParts(p.text)}</div>
        </div>
        ${p.note && html`<p class="mm-note">${p.note}</p>`}
      </div>`;
    }
    if (p.channel === 'invite' && p.invite) {
      const v = p.invite;
      return html`<div>
        <div class="mm-invite">
          <div class="mm-invite-title">${v.title}<span class=${`mm-chip is-${v.status === 'confirmed' ? 'confirmed' : 'tentative'}`}>${v.status === 'confirmed' ? 'Confirmed' : 'Tentative'}</span></div>
          <dl>
            <dt>When</dt><dd>${whenText(v.start, v.end)}</dd>
            ${v.location && html`<dt>Where</dt><dd>${v.location}</dd>`}
            <dt>Shows as</dt><dd>${v.busy ? 'Busy' : 'Free, so it blocks no one’s day'}</dd>
            <dt>From</dt><dd>${v.organizer}</dd>
          </dl>
          <p class="mm-invite-desc">${v.description}</p>
        </div>
        <p class="mm-note">A sample reveal a week from now, with the wording saved in Reveals → Invites. Google adds its own Yes / No / Maybe buttons and the calendar details around it.</p>
      </div>`;
    }
    if (p.html) {
      return html`<${EmailFrame} key=${`${p.id}-${lang}`} doc=${frameDoc} phone=${!wide} title=${`Preview: ${p.subject}`} />
        ${p.note && html`<p class="mm-note">${p.note}</p>`}`;
    }
    return html`<div class="mm-wait">Nothing to show.</div>`;
  };

  const canSend = p && (p.send === 'invite' || (p.send === 'email' && showing === 'email'));
  return html`<div class="mm-sheet-wrap" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="mm-sheet" role="dialog" aria-modal="true" aria-labelledby="mm-sheet-title">
      <div class="mm-sheet-head">
        <div>
          <h3 id="mm-sheet-title">${entry.t}</h3>
          <p>As it goes out, filled in for a sample family (the Stones). Nothing is sent from here unless you press Send it to me.</p>
        </div>
        <button type="button" class="am-close" ref=${closeRef} aria-label="Close" onClick=${onClose}>×</button>
      </div>
      ${p && html`<dl class="mm-env">
        <dt>Sent by</dt><dd><${Sender} s=${showing === 'text' ? 'twilio' : showing === 'push' ? 'push' : sendersOf(entry)[0]} /></dd>
        <dt>From</dt><dd>${showing === 'text' && p.channel !== 'text' ? TEXT_FROM : showing === 'push' ? PUSH_FROM : p.from}</dd>
        <dt>To</dt><dd>${p.to}</dd>
        ${p.subject && showing === 'email' && html`<dt>Subject</dt><dd class="mm-env-subject">${p.subject}</dd>`}
      </dl>`}
      ${((hasText || hasPush) && p.channel !== 'text') || entry.spanish || (p?.html && showing === 'email') ? html`<div class="mm-bar">
        <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
          ${(hasText || hasPush) && p.channel !== 'text' && html`<div class="mm-seg" role="group" aria-label="Which version">
            <button type="button" aria-pressed=${String(view === 'email')} onClick=${() => setView('email')}>Email</button>
            ${hasText && html`<button type="button" aria-pressed=${String(view === 'text')} onClick=${() => setView('text')}>Text</button>`}
            ${hasPush && html`<button type="button" aria-pressed=${String(view === 'push')} onClick=${() => setView('push')}>Browser alert</button>`}
          </div>`}
          ${entry.spanish && html`<div class="mm-seg" role="group" aria-label="Language">
            <button type="button" aria-pressed=${String(lang === 'en')} onClick=${() => setLang('en')}>English</button>
            <button type="button" aria-pressed=${String(lang === 'es')} onClick=${() => setLang('es')}>Spanish</button>
          </div>`}
        </div>
        ${p?.html && showing === 'email' && html`<div class="mm-seg mm-width" role="group" aria-label="Screen width">
          <button type="button" aria-pressed=${String(wide)} onClick=${() => setWide(true)}>Computer</button>
          <button type="button" aria-pressed=${String(!wide)} onClick=${() => setWide(false)}>Phone</button>
        </div>`}
      </div>` : null}
      <div class="mm-body" tabindex="0" role="region" aria-label="The message">${body()}</div>
      <div class="mm-foot">
        <p class=${send.state === 'ok' ? 'is-ok' : send.state === 'error' ? 'is-bad' : ''} aria-live="polite">${send.state === 'ok' || send.state === 'error' ? send.text
          : !p ? '' : p.send === 'invite' ? 'Send it to me makes a separate TEST invite on the office sandbox job, inviting only you.'
          : p.send === 'email' ? (showing === 'email' ? 'Send it to me emails this copy to you, with [Preview] in the subject.' : 'Texts and browser alerts can’t be sent as a preview. Switch to Email to send that one to yourself.')
          : p.channel === 'jobtread' ? 'JobTread sends this one from the family’s account, so it can’t be sent to you from here.'
          : 'Texts can’t be sent as a preview.'}</p>
        ${canSend && html`<button type="button" class="btn btn-primary btn-sm" disabled=${send.state === 'busy'} onClick=${sendIt}>${send.state === 'busy' ? html`<span class="spinner spinner-12" /> Sending…` : 'Send it to me'}</button>`}
      </div>
    </div>
  </div>`;
}

// ─── The page ─────────────────────────────
export function MessagesMap({ addToast = () => {}, onNavigate = null }) {
  ensureCss();
  const [open, setOpen] = useState(null); // the entry whose preview is open
  const opener = useRef(null);
  const see = (entry) => (e) => { opener.current = e.currentTarget; setOpen(entry); };

  const go = (c) => {
    if (!c || !onNavigate) return;
    if (c.hash) history.replaceState(null, '', c.hash);
    onNavigate(c.view, null, c.tab || null);
  };

  const Entry = (sel, { pickService, Dot }) => {
    const p = sel.probe;
    const reason = sel.es !== 'live' && !(p?.s && p.why) ? sel.note : null;
    const subj = subjectOf(sel);
    const subjEs = Array.isArray(sel.subject) ? sel.subject[1] : null;
    return html`
      <div class="am-chips">
        <span class="chip"><${Dot} n=${sel} /> ${STATUS[sel.es]}</span>
        ${sendersOf(sel).map((x) => html`<${Sender} s=${x} key=${x} />`)}
        ${sel.spanish && html`<span class="chip">English and Spanish</span>`}
        <span class="chip am-chip-src" title=${p ? 'Checked against the live systems when this page opened' : `Can’t be checked from the site; as written on ${WRITTEN_ON}`}>${p ? 'Checked live' : 'From the map'}</span>
      </div>
      <dl>
        <div><dt>Sent from</dt><dd class="mm-from">${fromLines(sel)}</dd></div>
        ${p && (p.why || p.last) && html`<div><dt>Right now</dt><dd class=${`am-now s-${sel.es}`}>${p.why || 'On.'}${p.last && html`<small>Last went <${Ago} iso=${p.last} /></small>`}</dd></div>`}
        ${reason && html`<div><dt>${sel.es === 'attn' ? 'What needs doing' : 'Why it’s off'}</dt><dd class=${`am-now s-${sel.es}`}>${reason}</dd></div>`}
        ${sel.who && html`<div><dt>Who gets it</dt><dd>${sel.who}</dd></div>`}
        ${sel.when && html`<div><dt>When it goes</dt><dd>${sel.when}</dd></div>`}
        ${subj && html`<div><dt>Subject</dt><dd class="mm-subject">${subj}${subjEs && html`<small lang="es">${subjEs}</small>`}</dd></div>`}
        ${sel.does && html`<div><dt>What it says</dt><dd>${sel.does}</dd></div>`}
        ${sel.change && html`<div><dt>Change it in</dt><dd><button type="button" class="mm-change" onClick=${() => go(sel.change)}>${sel.change.label}</button></dd></div>`}
        ${sel.touches?.length > 0 && html`<div><dt>Goes through</dt><dd class="am-tags">${sel.touches.map((t) => html`<button type="button" key=${t} title=${`Show everything that goes through ${t}`} onClick=${() => pickService(t)}>${t}</button>`)}</dd></div>`}
        ${sel.where && html`<div><dt>Where it lives</dt><dd class="am-mono">${sel.where}</dd></div>`}
        ${sel.info && html`<div><dt>Good to know</dt><dd>${sel.info}</dd></div>`}
      </dl>
      ${sel.preview && html`<div class="mm-actions"><button type="button" class="btn btn-secondary btn-sm" onClick=${see(sel)}>${SEE[sel.k] || 'See it'}</button></div>`}`;
  };

  return html`<${MindMap}
    model=${model} palette=${PALETTE} factsUrl=${API} written=${WRITTEN_ON}
    title="Emails & invites"
    sub="Everything the site sends a person: emails, calendar invites, texts and browser alerts. Pick one to see who gets it, when it goes, and the message itself."
    filters=${FILTERS} filterMatch=${filterMatch} shape=${shape} tags=${tagsOf}
    lede=${({ stat, attn, parked, home, show }) => html`
      ${[['resend', 'sent by Resend'], ['jobtread', 'through JobTread'], ['kit', 'through Kit'], ['google', 'Google Calendar invites'], ['twilio', 'Twilio texts']].map(([x, words]) => html`
        <li key=${x}><button type="button" onClick=${() => show(`s:${x}`)}><b>${stat((n) => sendersOf(n).includes(x))}</b> <span>${words}</span></button></li>`)}
      <li><button type="button" onClick=${home}><b>${parked.length}</b> <span>switched off</span></button></li>
      <li class="am-warnstat"><button type="button" onClick=${home}><b>${attn.length}</b> <span>need attention</span></button></li>`}
    entry=${Entry}
    homeNote="Pick anything on the map to see who gets it, when it goes and what it says, then See the email for the real thing."
    depNoun=${['message', 'messages']}
    hay=${(n) => [subjectOf(n, 'en'), subjectOf(n, 'es'), n.who, ...sendersOf(n).map((x) => SENDERS[x].label)]}
    legend=${html`<span><span class="am-dot-i s-live k-link"></span>Calendar invite</span>`}
    searchLabel="Search emails and invites" searchPlaceholder="Search: approved, Kit, reminder…" ariaLabel="Emails and invites map"
    list=${{
      title: 'Everything, as a list',
      intro: 'The same map, written out, with who sends each one. Green goes out, an open circle is switched off, amber needs someone. A square is a calendar invite.',
      meta: (l) => html`${STATUS[l.es]} · ${sendersOf(l).map((x) => html`<${Sender} s=${x} key=${x} />`)} · ${BY[l.by] || ''}`,
      body: (l) => html`${l.when && html`<p>${l.when}</p>`}${subjectOf(l) && html`<p><b>Subject:</b> ${subjectOf(l)}</p>`}${l.preview && html`<p><button type="button" class="mm-change" onClick=${see(l)}>${SEE[l.k] || 'See it'}</button></p>`}`,
    }}>
    ${open && html`<${PreviewSheet} entry=${open} returnTo=${opener.current} onClose=${() => setOpen(null)} addToast=${addToast} />`}
  <//>`;
}
