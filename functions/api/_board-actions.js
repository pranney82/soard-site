/**
 * Action item reminders
 * ===========================================================================
 * Peter, Nov 6 2026: "yes i want this best in class". An action item with an owner
 * reminds them by itself: a week before it's due, the day before, then weekly for
 * three weeks once it's late, and it stops the moment they tick it done on the
 * board page. One with no date is due by the next meeting, without the nagging
 * after. Each person gets one email with all of theirs, never one per item.
 *
 * Off until an admin turns it on (Board → the action items' list; emails to board
 * members never start by themselves). Weekdays in business hours only, as signing
 * reminders are. Its words are the owner's own to-dos, but an item from a board-only
 * part of the agenda is never quoted: an email can be forwarded and can't be taken back.
 */

import { getSettings, listMeetings, roster, SITE } from './_board.js';
import { readState, writeState, BOARD_PAGE } from './_board-roles.js';
import { businessHours } from './_board-sign.js';
import { openActions, todayEastern, shortDate } from '../../public/admin/board-shared.js';
import { sendEmailOne, emailConfigured, EMAIL_FROM } from './_broadcast-notify.js';
import { emailShell, button, esc } from './_email-shell.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FOOTER = 'You’re getting this as a member of the Sunshine on a Ranney Day Board of Directors.';
const fromBoard = () => EMAIL_FROM.replace(/^[^<]*/, 'SOARD Board ');
const daysTo = (due, today) => Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);
const short = (d) => shortDate(d).replace(/, \d{4}$/, '');

/**
 * Which reminder a to-do is on today, '' for none. `soft`: its date is only the next meeting, so nothing follows it
 * after. Anything more than three weeks late has had its last.
 */
export function stageFor(due, today, { soft = false } = {}) {
  if (!due) return '';
  const d = daysTo(due, today);
  if (d > 7) return '';
  if (d >= 2) return 'week';
  if (d >= 0) return 'day';
  if (soft) return '';
  if (d >= -7) return 'late1';
  if (d >= -14) return 'late8';
  return d >= -21 ? 'late15' : '';
}

/** Each open action item the board can see, with its date and the owner's slug */
function dueList(meetings, today) {
  const shared = meetings.filter((m) => m.shared && !m.practice);
  return openActions(shared).filter((a) => a.owner).map((a) => {
    const of = shared.find((m) => m.id === a.meetingId);
    // (caught under a part: the same as a correction there, any board-only item in it makes it board-only)
    const secret = !!a.from && (of?.sections || []).some((s) => (s.id === a.from && s.items.some((it) => it.confidential)) || s.items.some((it) => it.id === a.from && it.confidential));
    const next = shared.filter((m) => m.date > a.meetingDate && m.date >= today).sort((x, y) => x.date.localeCompare(y.date))[0] || null;
    return { ...a, secret, soft: !a.due, date: a.due || next?.date || '' };
  });
}

/** What a to-do says in the email */
const rowWords = (a) => (a.secret ? 'A to-do from a board-only item' : a.text);
function dueWords(a, today) {
  if (!a.date) return '';
  if (a.soft) return `before the ${short(a.date)} meeting`;
  const d = daysTo(a.date, today);
  return d < 0 ? `was due ${short(a.date)}` : d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : `due ${short(a.date)}`;
}

/** The email: all of one person's open to-dos, soonest first */
export function actionReminderEmail({ name = '', rows = [], today = todayEastern(), test = false } = {}) {
  const sorted = [...rows].sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')));
  const url = `${SITE}${BOARD_PAGE}`;
  const first = String(name).split(/\s+/)[0];
  const late = sorted.filter((a) => a.date && !a.soft && daysTo(a.date, today) < 0).length;
  const n = sorted.length;
  const intro = `${first ? `${first}, you` : 'You'} have ${n === 1 ? 'a to-do' : `${n} to-dos`} from the board${late ? `, ${late === 1 ? 'one' : late} past ${late === 1 ? 'its' : 'their'} date` : ''}.`;
  const lines = sorted.map((a) => [rowWords(a), dueWords(a, today)]);
  return {
    subject: `${test ? '[Preview] ' : ''}Your board to-dos: ${n === 1 ? (dueWords(sorted[0], today) || 'one open') : `${n} open`}`,
    html: emailShell({
      eyebrow: 'SOARD Board', preheader: intro, heading: 'Your to-dos from the board', intro: esc(intro),
      bodyHtml: `<ul style="margin:14px 0 0;padding:0 0 0 18px;">${lines.map(([what, when]) => `<li style="margin:0 0 8px;">${esc(what)}${when ? ` <span style="color:#5A5B61;">(${esc(when)})</span>` : ''}</li>`).join('')}</ul>`
        + `<div style="margin:18px 0 0;">${button('Open your to-dos', url)}</div>`
        + '<p class="muted" style="margin:6px 0 0;font-size:13px;line-height:1.5;color:#5A5B61;">Tick one done on the board page and these stop for it. Sign in with this email address.</p>',
      footerHtml: FOOTER,
    }),
    text: [intro, lines.map(([what, when]) => `- ${what}${when ? ` (${when})` : ''}`).join('\n'), `Open your to-dos: ${url}`, 'Tick one done on the board page and these stop for it. Sign in with this email address.'].join('\n\n'),
  };
}

/** Everyone who can own a to-do, with an address: staff have theirs by their Google sign-in */
async function addresses(DB, settings) {
  const people = await roster(DB, { withEmails: true });
  const out = new Map();
  for (const p of [...people.board, ...people.staff]) {
    const staffMail = (settings.admins || []).find((e) => String(e).toLowerCase().startsWith(`${String(p.name).split(/\s+/)[0].toLowerCase()}@`));
    const email = p.email || (people.staff.includes(p) ? staffMail : '') || '';
    if (email) out.set(p.slug, { name: p.name, email });
  }
  return out;
}

/**
 * Hourly, when it's on: each person with a to-do at a new reminder gets one email, all of theirs. A reminder is claimed
 * before its email (two heartbeats never send two) and given back if it doesn't go. → { sent } | { off } | { waiting }
 */
export async function maybeRemindActions(env, { now = Date.now(), limit = 10 } = {}) {
  const { DB } = env;
  const settings = await getSettings(DB);
  if (settings.actionRemind !== 'on') return { off: true };
  if (!emailConfigured(env)) return { off: true, why: 'email' };
  if (!businessHours(now)) return { waiting: 'hours' };
  const state = await readState(DB, 'action-reminds');
  if (state.at && now - Date.parse(state.at) < HOUR) return { waiting: 'hour' };
  await writeState(DB, 'action-reminds', { at: new Date(now).toISOString() });
  const today = todayEastern(now);
  const all = dueList(await listMeetings(DB), today);
  if (!all.length) return { sent: 0 };
  const had = new Set(((await DB.prepare('SELECT action_id, stage FROM board_action_reminders').all()).results || []).map((r) => `${r.action_id}|${r.stage}`));
  // (by the date too: a to-do given a new date is reminded of that one)
  const firing = all.map((a) => { const stage = stageFor(a.date, today, { soft: a.soft }); return { a, stage: stage ? `${stage}@${a.date}` : '' }; }).filter(({ a, stage }) => stage && !had.has(`${a.id}|${stage}`));
  const who = await addresses(DB, settings);
  let sent = 0;
  for (const owner of [...new Set(firing.map((x) => x.a.owner))]) {
    if (sent >= limit) break;
    const person = who.get(owner);
    if (!person) continue;
    const mine = firing.filter((x) => x.a.owner === owner);
    const at = new Date(now).toISOString();
    const claimed = [];
    for (const { a, stage } of mine) {
      const r = await DB.prepare('INSERT OR IGNORE INTO board_action_reminders (action_id, stage, at) VALUES (?, ?, ?)').bind(a.id, stage, at).run();
      if (r?.meta?.changes ?? r?.changes) claimed.push({ a, stage });
    }
    if (!claimed.length) continue;
    const mail = actionReminderEmail({ name: person.name, rows: all.filter((a) => a.owner === owner), today });
    const r = await sendEmailOne(env, { to: person.email, from: fromBoard(), ...mail, replyTo: settings.admins, tags: [{ name: 'kind', value: 'board-action-reminder' }], idempotencyKey: `action-remind:${owner}:${today}:${claimed.map(({ a, stage }) => `${a.id}.${stage}`).join(',').slice(0, 180)}` });
    if (!r.sent && !r.already) {
      for (const { a, stage } of claimed) await DB.prepare('DELETE FROM board_action_reminders WHERE action_id = ? AND stage = ? AND at = ?').bind(a.id, stage, at).run().catch(() => {});
      continue;
    }
    sent += 1;
  }
  return { sent };
}

/** "Send me the email": what the person asking would get, their own to-dos if they have any, else made-up ones */
export async function sendActionPreview(env, to) {
  const settings = await getSettings(env.DB);
  const today = todayEastern();
  const first = String(to).split('@')[0].toLowerCase();
  const people = await roster(env.DB);
  const me = people.staff.find((p) => String(p.name).toLowerCase().startsWith(first));
  const mine = dueList(await listMeetings(env.DB), today).filter((a) => me && a.owner === me.slug);
  const rows = mine.length ? mine : [{ text: 'Confirm the venue with the committee', date: new Date(Date.now() + 6 * DAY).toISOString().slice(0, 10) }, { text: 'Send the sponsor list to the board', date: new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10), soft: true }];
  const r = await sendEmailOne(env, { to, from: fromBoard(), ...actionReminderEmail({ name: me?.name || '', rows, today, test: true }), replyTo: settings.admins, tags: [{ name: 'kind', value: 'board-action-reminder-preview' }] });
  return { sent: r.sent ? 1 : 0, to: [to], errors: r.errors };
}
