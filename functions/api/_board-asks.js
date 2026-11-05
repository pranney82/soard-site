/**
 * Report asks: the next meeting's presenters asked for their reports by email, and their replies put on the agenda
 * ===========================================================================
 * Peter, Nov 2 2026: an email to each presenter "asking for their report/update, then on their reply it goes into the
 * agenda", sent "through peter@soardcharity.com with holly CC", with a deadline ("they should be held accountable"),
 * and "a board chair email to review the whole agenda like a week or so before".
 *
 * Sent from the asker's own Gmail through the Gmail API (the site's domain-wide delegation, gmail.send). SOARD's own
 * domain isn't one Resend sends for, so mail "from peter@" through Resend would fail Gmail's and Outlook's checks.
 * Each email is in his Sent folder, and replies come to his inbox like any other (and Holly's, on reply all).
 *   asker   Settings' asksFrom, else the founder the invites don't come from (Peter); copied: the invites' organizer
 *
 * The schedule, from the meeting's day D (Eastern), for the next meeting once its agenda isn't a draft:
 *   D-14 9 AM   each board member presenting an item is asked (one email per item), due D-7 at 5 PM
 *   D-9 9 AM    a reminder in the same conversation, if their report isn't in
 *   the due     "was due today", to the presenter with the chair copied
 *   D-6 9 AM    the chair's review: the whole agenda, each report in, late or not due yet
 * A meeting nearer than that runs compressed: asks at once, due noon a day later (never after noon the day before),
 * the chair's review once the last report is due. Emails go between 8 AM and 7 PM Eastern only. Staff (Peter, Holly)
 * are never asked: they write theirs in Board.
 *
 * A reply in an ask's conversation (or one that names it in In-Reply-To or References), from the presenter:
 *   - an automatic reply (out of office) is left alone: its headers say what it is
 *   - the email it quotes and the signature are cut; bullets, bold and links stay (Markdown)
 *   - Workers AI sorts it: a report (any update, "nothing new this time", "it's attached") or something else (a
 *     question, "I'll send it Friday"), which stays in the inbox for a person to answer
 *   - a report goes on the item word for word, under one already there (never over it), its files with it
 *   - "it's on the agenda" goes back to them alone, in the same conversation
 *
 * Also here: the presenter's notes on the money's lines (the treasurer's review on the board page), board_line_notes,
 * and what the board page needs of both (portalExtras): the notes, a member's own asks and when each is due, and
 * a meeting ahead not shared yet that they present in (only their own items), so the ask's link opens.
 */

import { getMeeting, listMeetings, patchMeeting, roster, attachToItem, getSettings, sendApprovedAgenda, SITE } from './_board.js';
import { peopleRows, boardAdmins, readState, writeState, readSettings, normEmail, isStaffEmail, BOARD_PAGE } from './_board-roles.js';
import { organizerFor } from './_board-invite.js';
import { accessToken, GMAIL_READ_SCOPE } from './_google-calendar.js';
import { header, bytesOf, partsOf } from './_mailbox.js';
import { booksNow } from './_quickbooks.js';
import {
  presentersOf, reportsOn, agendaIsDraft, meetingName, sectionPlan, isFilled, forBoard, todayEastern, isDate, LIMITS, showsOf, timeRange, isNothingNew,
  reportSlides, slidesOfItem, isCopyName,
} from '../../public/admin/board-shared.js';
import { mdToDoc, docToMd, mdPlain } from '../../public/admin/board-md.js';
import { viaGateway, aiCapped } from './_ai.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const KEY = 'asks';
const EVERY_MS = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
export const ASK_DAYS = 14;
export const DUE_DAYS = 7;
export const CHAIR_DAYS = 6;
const REMIND_DAYS = 2;
const SEND_HOURS = { from: 8, to: 19 };
const NOTE_MAX = 2000;
const MAX_FILE = 25 * 1024 * 1024;

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const uid = (p) => `${p}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const err = (message, status) => Object.assign(new Error(message), { status });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };

// ─── Eastern time ───────────────────────────────────────────────────

const WALL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const wallOf = (t) => { const p = Object.fromEntries(WALL.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); };
/** 'YYYY-MM-DD' and 'HH:MM' on Eastern clocks → ms (daylight saving either side) */
export function easternAt(day, time = '00:00') {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want + (want - wallOf(want));
  t += want - wallOf(t);
  return t;
}
export const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const hourEastern = (t) => new Date(wallOf(t)).getUTCHours();
/** Emails go out between 8 AM and 7 PM Eastern */
export const sendingHours = (t) => hourEastern(t) >= SEND_HOURS.from && hourEastern(t) < SEND_HOURS.to;
const daysUntil = (today, date) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);

/** "Wednesday, November 4 at noon" (short: "Wed, Nov 4 at noon") */
export function dueWords(t, { short = false } = {}) {
  const w = new Date(wallOf(t));
  const day = w.toLocaleDateString('en-US', short ? { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const h = w.getUTCHours();
  const m = w.getUTCMinutes();
  const time = h === 12 && !m ? 'noon' : `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  return `${day} at ${time}`;
}
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const longDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const shortDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// ─── The schedule ───────────────────────────────────────────────────

/**
 * When a report asked for at `at` is due, for a meeting on `date`: a week before at 5 PM; asked later than three days
 * before that, noon of the first day a full day away (never earlier than the week before, never after noon the day before)
 */
export function dueFor(date, at) {
  const normal = easternAt(addDays(date, -DUE_DAYS), '17:00');
  if (at <= normal - 3 * DAY) return normal;
  const day = todayEastern(at + DAY);
  let t = easternAt(day, '12:00');
  if (t < at + DAY) t = easternAt(addDays(day, 1), '12:00');
  return Math.min(Math.max(t, normal), easternAt(addDays(date, -1), '12:00'));
}

/** The reminder: two days before it's due at 9 AM, or that morning at 8 when that's too soon after the ask; else none */
export function remindAt(asked, due) {
  const dueDay = todayEastern(due);
  const early = easternAt(addDays(dueDay, -REMIND_DAYS), '09:00');
  if (early >= asked + DAY) return early;
  const morning = easternAt(dueDay, '08:00');
  return morning >= asked + 12 * HOUR && morning < due ? morning : null;
}

/** The chair's review: six days before at 9 AM, or once the last report asked for is due */
export function chairAt(date, dues = []) {
  const normal = easternAt(addDays(date, -CHAIR_DAYS), '09:00');
  return Math.max(normal, dues.length ? Math.max(...dues) + 5 * 60 * 1000 : 0);
}

// ─── The tables ─────────────────────────────────────────────────────

const ready = new WeakSet();
export async function ensureAsks(DB) {
  if (ready.has(DB)) return;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS board_asks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, meeting_id TEXT NOT NULL, item_id TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL, name TEXT, email TEXT, title TEXT, subject TEXT, due TEXT, status TEXT NOT NULL, asked_at TEXT, reminded_at TEXT, late_at TEXT,
      in_at TEXT, thread TEXT, msg_ids TEXT, files TEXT, error TEXT, updated_at TEXT)`),
    DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS board_asks_one ON board_asks (kind, meeting_id, item_id, slug)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS board_ask_mail (gmail_id TEXT PRIMARY KEY, ask_id TEXT, at TEXT, sender TEXT, outcome TEXT, detail TEXT)'),
    DB.prepare(`CREATE TABLE IF NOT EXISTS board_line_notes (meeting_id TEXT NOT NULL, item_id TEXT NOT NULL, key TEXT NOT NULL, line TEXT, text TEXT NOT NULL,
      by_slug TEXT, by_name TEXT, at TEXT, PRIMARY KEY (meeting_id, item_id, key))`),
    // The chair's own notes on the agenda's items (the chair's and the admins' only), and the questions sent back on a report
    DB.prepare('CREATE TABLE IF NOT EXISTS board_chair_notes (meeting_id TEXT NOT NULL, item_id TEXT NOT NULL, text TEXT NOT NULL, by_name TEXT, at TEXT, PRIMARY KEY (meeting_id, item_id))'),
    DB.prepare(`CREATE TABLE IF NOT EXISTS board_ask_questions (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, item_id TEXT NOT NULL, ask_id TEXT, by_slug TEXT, by_name TEXT,
      text TEXT NOT NULL, at TEXT, answered_at TEXT, to_names TEXT)`),
  ]);
  // The meeting's day each ask was made for (a date moved afterwards moves its due); a column the first table lacked
  await DB.prepare('ALTER TABLE board_asks ADD COLUMN meeting_date TEXT').run().catch(() => {});
  // A list's items (kind 'list': one email for someone presenting three or more)
  await DB.prepare('ALTER TABLE board_asks ADD COLUMN items TEXT').run().catch(() => {});
  ready.add(DB);
}

const askOf = (r) => r && ({
  id: r.id, kind: r.kind, meetingId: r.meeting_id, itemId: r.item_id, slug: r.slug, name: r.name || '', email: r.email || '', title: r.title || '',
  subject: r.subject || '', due: r.due || '', status: r.status, askedAt: r.asked_at || '', remindedAt: r.reminded_at || '', lateAt: r.late_at || '',
  inAt: r.in_at || '', thread: r.thread || '', msgIds: parse(r.msg_ids, []), files: parse(r.files, []), error: r.error || '', meetingDate: r.meeting_date || '', items: parse(r.items, []),
});
async function asksFor(DB, meetingId) {
  return ((await DB.prepare('SELECT * FROM board_asks WHERE meeting_id = ? ORDER BY asked_at').bind(meetingId).all()).results || []).map(askOf);
}
async function setAsk(DB, id, patch) {
  const cols = { status: 'status', remindedAt: 'reminded_at', lateAt: 'late_at', inAt: 'in_at', thread: 'thread', due: 'due', askedAt: 'asked_at', error: 'error', subject: 'subject', meetingDate: 'meeting_date' };
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'msgIds' || k === 'files' || k === 'items') { sets.push(`${{ msgIds: 'msg_ids', files: 'files', items: 'items' }[k]} = ?`); vals.push(JSON.stringify(v)); } else if (cols[k]) { sets.push(`${cols[k]} = ?`); vals.push(v); }
  }
  sets.push('updated_at = ?');
  vals.push(nowIso());
  await DB.prepare(`UPDATE board_asks SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
}

/** An ask per item: a list stands for each of its items (with that item's own state: in once it has a report) */
function perItem(asks, meetings) {
  const itemOf = (a, id) => meetings.find((m) => m.id === a.meetingId)?.sections.flatMap((s) => s.items).find((x) => x.id === id);
  return asks.flatMap((a) => (a.kind !== 'list' ? [a] : (a.items || []).map((id) => ({ ...a, kind: 'report', itemId: id, title: itemOf(a, id)?.title || '', status: String(itemOf(a, id)?.report || '').trim() ? 'in' : a.status }))));
}

// ─── Who sends, who's copied ────────────────────────────────────────

/**
 * The asker and who's copied: Settings' asksFrom (an admin), else the founder the board's invites don't come from
 * (Peter); copied, the invites' organizer (Holly). → { from: { name, email }, cc: [{ name, email }] } or null
 */
export async function sendersFor(DB) {
  const [s, admins, organizer, people] = await Promise.all([readSettings(DB), boardAdmins(DB), organizerFor(DB), peopleRows(DB)]);
  const nameOf = (e) => people.find((p) => p.group !== 'board' && e.startsWith(`${String(p.name || '').toLowerCase().match(/[a-z]+/)?.[0]}@`))?.name || '';
  const saved = normEmail(s.asksFrom);
  const from = (saved && admins.includes(saved) && saved) || admins.find((e) => e !== organizer) || organizer || admins[0] || '';
  if (!from) return null;
  const cc = [...new Set([...(Array.isArray(s.asksCc) ? s.asksCc.map(normEmail).filter((e) => admins.includes(e)) : [organizer])])].filter((e) => e && e !== from);
  return { from: { name: nameOf(from), email: from }, cc: cc.map((e) => ({ name: nameOf(e), email: e })) };
}

/** The board chair (People → Board, the chair's seat) with an email, or null */
const chairOf = (people) => people.board.find((p) => p.seat === 'chair' && p.email) || null;

// ─── The emails (plain, as a person writes them) ───────────────────

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const P = 'margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2D2E33;';
/** An email's text as both parts: paragraphs of plain words, a link on a line of its own drawn as one */
function body(paras) {
  const text = paras.filter(Boolean).map((p) => (typeof p === 'string' ? p : `${p.lead ? `${p.lead}\n` : ''}${p.url}`)).join('\n\n');
  const html = `<div>${paras.filter(Boolean).map((p) => (typeof p === 'string'
    ? `<p style="${P}">${esc(p).replace(/\n/g, '<br>')}</p>`
    : `<p style="${P}">${p.lead ? `${esc(p.lead)}<br>` : ''}<a href="${esc(p.url)}" style="color:#1A5FB4;">${esc(p.label || p.url)}</a></p>`)).join('')}</div>`;
  return { text, html };
}
/**
 * How an email names an item's report. A board-only item's title never goes in an email (board-shared.js: board-only
 * items are "never emailed"); its presenter knows which it is, and the board page says
 */
export const yourReport = (it) => (it.confidential ? 'your report on the board-only item you present' : `your ${it.title} report`);
const YourReport = (it) => yourReport(it).replace(/^y/, 'Y');
const itemTitle = (it) => (it.confidential ? 'A board-only item (on the board page)' : it.title || 'Untitled item');
const reportUrl = (m, itemId) => `${SITE}${BOARD_PAGE}#/meetings/${m.id}/report/${itemId}`;
const isMoney = (it) => showsOf(it).includes('cash');

/** The ask: what's due when, that a reply is all it takes, and (the money) the review waiting on the board page */
export function askEmail({ m, it, person, due, from, books = null }) {
  const name = meetingName(m);
  const asOf = books?.statements?.asOf;
  const money = isMoney(it);
  return {
    subject: `${name}: ${yourReport(it)}, due ${dueWords(due, { short: true })}`,
    ...body([
      `Hi ${firstName(person.name)},`,
      `The ${name} is ${longDay(m.date)}. Please send ${yourReport(it)} by ${dueWords(due)}.`,
      'Just reply to this email with your update. What you write goes on the agenda as your report, and anything you attach goes with it. If there’s nothing new this time, reply and say so.',
      money
        ? { lead: `Your page on the board site has this year’s statements beside last year’s${books?.budget ? ' and the budget' : ''}${asOf ? `, as of ${longDay(asOf).replace(/^\w+, /, '')}` : ''}, with a place to note any line for the board:`, url: reportUrl(m, it.id), label: 'Open your financial review' }
        : { lead: 'You can also write it on the board page:', url: reportUrl(m, it.id), label: 'Write your report' },
      `Thanks,\n${firstName(from.name) || 'SOARD'}`,
    ]),
  };
}

/** A list's items as both parts: each item's name and the link to write its report */
function listBody(m, items, paras, closing) {
  const named = (it) => itemTitle(it);
  const text = [...paras.slice(0, -1), items.map((it) => `- ${named(it)}: ${reportUrl(m, it.id)}`).join('\n'), paras.at(-1), closing].filter(Boolean).join('\n\n');
  const html = `<div>${paras.slice(0, -1).map((p) => `<p style="${P}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}`
    + `<ul style="margin:0 0 14px;padding-left:22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2D2E33;">${items.map((it) => `<li><a href="${esc(reportUrl(m, it.id))}" style="color:#1A5FB4;">${esc(named(it))}</a></li>`).join('')}</ul>`
    + `<p style="${P}">${esc(paras.at(-1))}</p><p style="${P}">${esc(closing).replace(/\n/g, '<br>')}</p></div>`;
  return { text, html };
}

/** The ask for someone presenting three or more: one email, each item with its own link, one due */
export function listEmail({ m, items, person, due, from }) {
  const name = meetingName(m);
  return {
    subject: `${name}: your ${items.length} reports, due ${dueWords(due, { short: true })}`,
    ...listBody(m, items, [
      `Hi ${firstName(person.name)},`,
      `The ${name} is ${longDay(m.date)}. Please write your ${items.length} reports by ${dueWords(due)}:`,
      'Each link opens that item’s report on the board page. If there’s nothing new on one, its page has Nothing to report this time.',
    ], `Thanks,\n${firstName(from.name) || 'SOARD'}`),
  };
}
export function listReminderEmail({ m, items, person, due, from, now = Date.now() }) {
  const at = dueWords(due).split(' at ')[1];
  const soon = todayEastern(due) === todayEastern(now) ? `today at ${at}` : todayEastern(due) === addDays(todayEastern(now), 1) ? `tomorrow at ${at}` : dueWords(due);
  return listBody(m, items, [
    `Hi ${firstName(person.name)},`,
    `A reminder that ${items.length === 1 ? 'one of your reports' : `${items.length} of your reports`} for ${weekdayOf(m.date)}’s board meeting ${items.length === 1 ? 'is' : 'are'} due ${soon}:`,
    'Each link opens that item’s report on the board page.',
  ], `Thanks,\n${firstName(from.name) || 'SOARD'}`);
}
export function listLateEmail({ m, items, person, due, from, chair = null, now = Date.now() }) {
  return listBody(m, items, [
    `Hi ${firstName(person.name)},`,
    `${items.length === 1 ? 'One of your reports' : `${items.length} of your reports`} for ${weekdayOf(m.date)}’s board meeting ${items.length === 1 ? 'was' : 'were'} due ${todayEastern(due) === todayEastern(now) ? `today at ${dueWords(due).split(' at ')[1]}` : dueWords(due)} and ${items.length === 1 ? 'hasn’t' : 'haven’t'} come in:`,
    `Please write ${items.length === 1 ? 'it' : 'them'} on the board page as soon as you can.${chair ? ` I’ve copied ${firstName(chair.name)} so the agenda’s status is clear.` : ''}`,
  ], `Thanks,\n${firstName(from.name) || 'SOARD'}`);
}

/** The reminder, in the ask's conversation */
export function reminderEmail({ m, it, person, due, from, now = Date.now() }) {
  const at = dueWords(due).split(' at ')[1];
  const soon = todayEastern(due) === todayEastern(now) ? `today at ${at}` : todayEastern(due) === addDays(todayEastern(now), 1) ? `tomorrow at ${at}` : dueWords(due);
  return body([
    `Hi ${firstName(person.name)},`,
    `A reminder that ${yourReport(it)} for ${weekdayOf(m.date)}’s board meeting is due ${soon}. Reply here with your update, or write it on the board page:`,
    { url: reportUrl(m, it.id), label: 'Write your report' },
    `Thanks,\n${firstName(from.name) || 'SOARD'}`,
  ]);
}

/** The meeting moved: when their report is due now */
export function movedEmail({ m, it, person, due, from }) {
  return body([
    `Hi ${firstName(person.name)},`,
    `The ${meetingName(m)} is now ${longDay(m.date)}, so ${yourReport(it)} is due ${dueWords(due)}. Reply here with your update, or write it on the board page:`,
    { url: reportUrl(m, it.id), label: 'Write your report' },
    `Thanks,\n${firstName(from.name) || 'SOARD'}`,
  ]);
}

/** Past due: to the presenter, the chair copied (named, so they know) */
export function lateEmail({ m, it, person, due, from, chair = null, now = Date.now() }) {
  return body([
    `Hi ${firstName(person.name)},`,
    `${YourReport(it)} for ${weekdayOf(m.date)}’s board meeting was due ${todayEastern(due) === todayEastern(now) ? `today at ${dueWords(due).split(' at ')[1]}` : dueWords(due)} and hasn’t come in. Please reply here with your update as soon as you can.${chair ? ` I’ve copied ${firstName(chair.name)} so the agenda’s status is clear.` : ''}`,
    `Thanks,\n${firstName(from.name) || 'SOARD'}`,
  ]);
}

/**
 * How a report shows on the meeting's screen, in a sentence: one slide, or how many. `it`: the item it's on, so the
 * count is the screen's own (its title and "Board only" take room: board-shared.js slidesOfItem)
 */
export function slidesLine(report, { answer = false, it = null } = {}) {
  if (!String(report || '').trim() || isNothingNew(report)) return '';
  const n = (it ? slidesOfItem({ ...it, report }) : reportSlides(report)).length || 1;
  if (answer) return n > 1 ? `With it, the report is ${n} slides in the meeting.` : 'With it, the report still fits on one slide in the meeting.';
  return n > 1 ? `In the meeting it’s ${n} slides.` : 'In the meeting it fits on one slide.';
}

/** Thanks, to the presenter alone: it's on the agenda, and how it shows in the meeting (`report`: as it now reads) */
export function thanksEmail({ m, it, person, from, answer = false, report = it.report }) {
  const slides = slidesLine(report, { answer, it });
  return body([
    answer
      ? `Thanks, ${firstName(person.name)}. Your answer is on the agenda under ${yourReport(it)} for ${weekdayOf(m.date)}’s meeting.${slides ? ` ${slides}` : ''} Here it is:`
      : `Thanks, ${firstName(person.name)}. ${YourReport(it)} is on the agenda for ${weekdayOf(m.date)}’s meeting.${slides ? ` ${slides}` : ''} You can see it or change it on the board page until then:`,
    { url: reportUrl(m, it.id), label: 'Your report' },
    `${firstName(from.name) || 'SOARD'}`,
  ]);
}

/** One item's report as the chair's review says it: in, late, due, or nothing (no one was asked) */
function reportState(it, asks) {
  if (isNothingNew(it.report)) return 'nothing new this time';
  if (String(it.report || '').trim()) return 'report in';
  // Only asks that went out (never one that failed, or that may not have)
  const mine = asks.filter((a) => (a.kind === 'report' ? a.itemId === it.id : a.kind === 'list' && (a.items || []).includes(it.id)) && ['asked', 'late', 'in'].includes(a.status));
  if (!mine.length) return '';
  const due = Math.min(...mine.map((a) => Date.parse(a.due)));
  return mine.some((a) => a.status === 'late') || due <= Date.now() ? `report late (was due ${dueWords(due, { short: true })})` : `report due ${dueWords(due, { short: true })}`;
}

const reviewUrl = (m) => `${SITE}${BOARD_PAGE}#/meetings/${m.id}/review`;
/** "me" or "me and Holly": who a reply to the asker's email reaches */
const replyReaches = (cc = []) => (cc.length ? `me and ${cc.map((c) => firstName(c.name) || c.email).join(' and ')}` : 'me');

/**
 * The chair's review: the whole agenda, part by part with its times, who presents and where each report stands; the
 * review page (approve, the chair's own notes, a report sent back with a question), and a reply for anything else
 */
/** "Alex", "Alex and Holly", "Alex, Holly and Sam" */
const andNames = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0] || '');
export function chairEmail({ m, chair, from, asks = [], people = [], cc = [] }) {
  const name = meetingName(m);
  const plan = sectionPlan(m);
  const asked = [...new Set(asks.filter((a) => ['asked', 'late', 'in'].includes(a.status)).flatMap((a) => (a.kind === 'report' ? [a.itemId] : a.kind === 'list' ? a.items || [] : [])))];
  const items = m.sections.flatMap((s) => s.items).filter((it) => asked.includes(it.id));
  const inCount = items.filter((it) => String(it.report || '').trim()).length;
  const late = items.filter((it) => /late/.test(reportState(it, asks)));
  const when = [longDay(m.date), timeRange(m.start, m.end)].filter(Boolean).join(', ');
  const status = items.length ? `Reports: ${inCount} of ${items.length} in.${late.length ? ` Late: ${late.map((it) => `${presentersOf(it, people).map((p) => p.name).join(' & ')} (${itemTitle(it)})`).join('; ')}.` : ''}` : '';
  const clock = (t) => { if (!t) return ''; const [h, mi] = t.split(':').map(Number); return `${h % 12 || 12}:${String(mi).padStart(2, '0')}`; };
  const parts = m.sections.filter((s) => s.items.some(isFilled) || s.title).map((s) => {
    const p = plan.get(s.id);
    const head = `${p?.start ? `${clock(p.start)}  ` : ''}${s.title || 'Untitled part'}${p?.minutes ? ` (${p.minutes} min)` : ''}`;
    const lines = s.items.filter(isFilled).flatMap((it) => {
      const who = presentersOf(it, people).map((x) => x.name).join(' & ');
      const line = [itemTitle(it), who, reportState(it, asks)].filter(Boolean).join(' · ');
      return it.motion && !it.confidential ? [line, `  The board votes on: ${it.motion}`] : [line];
    });
    return { head, lines };
  });
  // To the chair and Holly, Peter copied: any of them approves it, once (Peter, Nov 2 2026)
  const hi = andNames([chair, ...cc].map((p) => firstName(p.name)).filter(Boolean));
  const page = `On the review page, approving it emails it to the board.${cc.length ? ' One approval is enough: once one of you approves it, the review page shows who did, and this conversation says so.' : ''} You can also add your own notes to any item, and send a report back to its presenter with a question. Their answer goes on the agenda under the report.`;
  const other = `For anything else, or if it all looks good, just reply. It comes to ${replyReaches(cc)}.`;
  const text = [
    `Hi ${hi},`,
    `Here’s the agenda for the ${name}, ${when}, for your review.`,
    status,
    parts.map((x) => [x.head, ...x.lines.map((l) => `    ${l}`)].join('\n')).join('\n\n'),
    `${page}\n${reviewUrl(m)}`,
    other,
    `Thanks,\n${firstName(from.name) || 'SOARD'}`,
  ].filter(Boolean).join('\n\n');
  const html = `<div>`
    + `<p style="${P}">Hi ${esc(hi)},</p>`
    + `<p style="${P}">Here’s the agenda for the ${esc(name)}, ${esc(when)}, for your review.</p>`
    + (status ? `<p style="${P}"><strong>${esc(status)}</strong></p>` : '')
    + parts.map((x) => `<p style="${P}margin-bottom:4px;"><strong>${esc(x.head)}</strong></p>`
      + (x.lines.length ? `<ul style="margin:0 0 14px;padding-left:22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2D2E33;">${x.lines.map((l) => (l.startsWith('  ') ? `<li style="list-style:none;margin:2px 0 6px;color:#5A5B61;"><em>${esc(l.trim())}</em></li>` : `<li>${esc(l)}</li>`)).join('')}</ul>` : '')).join('')
    + `<p style="${P}">${esc(page)}</p>`
    + `<p style="${P}"><a href="${esc(reviewUrl(m))}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#FFDA24;color:#2D2E33;font-weight:700;text-decoration:none;">Review the agenda</a></p>`
    + `<p style="${P}">${esc(other)}</p>`
    + `<p style="${P}">Thanks,<br>${esc(firstName(from.name) || 'SOARD')}</p></div>`;
  return { subject: `Agenda for your review: ${name}, ${shortDay(m.date)}`, text, html };
}

// ─── Sending (Gmail, as the asker) ──────────────────────────────────

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const utf8 = (s) => new TextEncoder().encode(s);
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
/**
 * A header's words, encoded when they aren't plain ASCII (RFC 2047): in pieces of whole characters, each encoded word
 * 75 characters at most, folded onto lines of their own
 */
export function word(s) {
  if (/^[\x20-\x7E]*$/.test(s) && !s.includes('=?')) return s;
  const pieces = [];
  let cur = '';
  for (const ch of s) {
    if (utf8(cur + ch).length > 45) { pieces.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) pieces.push(cur);
  return pieces.map((p) => `=?UTF-8?B?${b64(utf8(p))}?=`).join('\r\n ');
}
const addr = (p) => (p.name ? `${word(/[",.<>@;:]/.test(p.name) ? `"${p.name.replace(/"/g, '')}"` : p.name)} <${p.email}>` : p.email);

/** An email as Gmail's API takes it (RFC 2822, both parts, base64url) */
export function mimeOf({ from, to, cc = [], subject, text, html, inReplyTo = '', references = '', tag = 'report-asks' }) {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, '')}`;
  const lines = [
    `From: ${addr(from)}`,
    `To: ${to.map(addr).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map(addr).join(', ')}`] : []),
    `Subject: ${word(subject)}`,
    'MIME-Version: 1.0',
    `X-SOARD-Board: ${tag}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${[references, inReplyTo].filter(Boolean).join(' ')}`] : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(utf8(text))),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(utf8(html))),
    `--${boundary}--`,
    '',
  ];
  return b64(utf8(lines.join('\r\n'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function gmailCall(token, path, { method = 'GET', body = null, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GMAIL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Gmail answered ${res.status}: ${out?.error?.message || ''}`.trim());
  return out;
}

/** The Message-ID Gmail gave an email it sent (replies name it) */
async function messageIdOf(readToken, id, fetchImpl) {
  const msg = await gmailCall(readToken, `/messages/${id}?format=metadata&metadataHeaders=Message-ID`, { fetchImpl });
  return header(msg?.payload?.headers, 'Message-ID');
}

/** Send one email as the asker → { id, threadId, messageId } */
/** Test mode (the switch beside a meeting's reports, in Board): an email goes to the asker alone, its subject saying who it would really go to */
export function asTest(mail, from) {
  const names = (list) => (list || []).map((p) => p.name || p.email).join(' & ');
  const who = `${names(mail.to)}${mail.cc?.length ? `, ${names(mail.cc)} copied` : ''}`;
  return { ...mail, to: [from], cc: [], subject: `[Test → ${who}] ${mail.subject}`, threadId: undefined, inReplyTo: '', references: '' };
}

async function send(ctx, mail) {
  mail = { ...mail, cc: (mail.cc || []).filter((c) => !mail.to.some((t) => normEmail(t.email) === normEmail(c.email))) };
  if (ctx.test) mail = asTest(mail, ctx.senders.from);
  const raw = mimeOf({ from: ctx.senders.from, ...mail });
  const sent = await gmailCall(ctx.sendToken, '/messages/send', { method: 'POST', body: { raw, ...(mail.threadId ? { threadId: mail.threadId } : {}) }, fetchImpl: ctx.fetchImpl });
  const messageId = await messageIdOf(ctx.readToken, sent.id, ctx.fetchImpl).catch(() => '');
  return { id: sent.id, threadId: sent.threadId, messageId };
}

// ─── Reading a reply ────────────────────────────────────────────────

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·' };
const entities = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, c) => {
  if (c[0] !== '#') return ENT[c.toLowerCase()] ?? m;
  const n = c[1].toLowerCase() === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
});

// Where each mail program starts the email it quotes (or its signature, Gmail's own)
const HTML_QUOTE = [
  /<div[^>]*class="[^"]*gmail_quote/i, /<div[^>]*class="[^"]*gmail_attr/i, /<div[^>]*class="[^"]*gmail_signature/i, /<div[^>]*class="[^"]*gmail_extra/i,
  /<blockquote[^>]*type="cite"/i, /<div[^>]*id="divRplyFwdMsg"/i, /<div[^>]*id="appendonsend"/i, /<div[^>]*id="mail-editor-reference-message-container"/i,
  /<hr[^>]*id="stopSpelling"/i, /<div[^>]*class="[^"]*yahoo_quoted/i, /<div[^>]*class="[^"]*moz-cite-prefix/i,
  /<div[^>]*style="[^"]*border:\s*none;\s*border-top:\s*solid\s*#E1E1E1/i, /<div[^>]*style="[^"]*border-top:\s*solid\s*#B5C4DF/i,
];
const TEXT_QUOTE = [
  /^[ \t]*On\b[^\n]{0,200}\d[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:[ \t]*$/m,
  /^[ \t]*-{2,}\s*Original Message\s*-{2,}/mi,
  /^[ \t]*-{2,}\s*Forwarded message\s*-{2,}/mi,
  /^[ \t]*_{20,}[ \t]*\n[ \t]*From:/m,
  /^[ \t]*From:[^\n]+\n[ \t]*(?:Sent|Date):[^\n]+/mi,
  /(?:^|\n)>[^\n]*(?:\n(?:>[^\n]*|[ \t]*))*$/,
];
// The lines a phone or mail program adds under every email
const TRAILERS = /^\s*(sent from my (iphone|ipad|android|samsung|galaxy|mobile)[^\n]*|sent from (outlook|yahoo mail|mail for windows)[^\n]*|get outlook for (ios|android)[^\n]*|sent via [^\n]*)\s*$/gim;

/** The phone's or mail program's lines at the very end ("Sent from my iPhone"), and a signature's lone "--" left by the cut */
function trailersOff(text) {
  const lines = String(text).replace(/\s+$/, '').split('\n');
  while (lines.length && (/^\s*$/.test(lines.at(-1)) || /^\s*-{2,3}\s*$/.test(lines.at(-1)) || new RegExp(TRAILERS.source, 'i').test(lines.at(-1)))) lines.pop();
  return lines.join('\n').trim();
}

/** An email's own words as text, the email it quotes left out */
export function cutTextQuote(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const at = TEXT_QUOTE.map((re) => s.search(re)).filter((i) => i >= 0);
  const cut = at.length ? s.slice(0, Math.min(...at)) : s;
  // The signature delimiter "-- " (a line of its own)
  return trailersOff(cut.replace(/\n-- \n[\s\S]*$/, '\n'));
}

/** An HTML email as Markdown: paragraphs, points (and numbered), headings (### only), bold, italic, links */
export function htmlToMd(html) {
  let s = String(html || '').replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[(?:if|endif)[^\]]*\]>/gi, '');
  const at = HTML_QUOTE.map((re) => s.search(re)).filter((i) => i >= 0);
  if (at.length) s = s.slice(0, Math.min(...at));
  let out = '';
  const lists = [];
  const links = [];
  const block = (n = 2) => { out = out.replace(/[ \t]+$/, ''); const have = out.match(/\n*$/)[0].length; if (out && have < n) out += '\n'.repeat(n - have); };
  for (const m of s.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)|</gi)) {
    if (m[4] !== undefined || m[0] === '<') {
      const t = entities(m[4] ?? '<').replace(/[\s ]+/g, ' ');
      if (!t.trim() && (!out || /\s$/.test(out))) continue;
      out += t;
      continue;
    }
    const close = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'br') { out = out.replace(/[ \t]+$/, ''); out += lists.length ? ' ' : '\n'; continue; }
    if (tag === 'p' && lists.length) continue;
    if (['p', 'table', 'blockquote', 'pre', 'hr'].includes(tag)) { block(2); continue; }
    if (['div', 'tr', 'section', 'article', 'header', 'footer', 'center', 'dl', 'dt', 'dd'].includes(tag)) { if (!lists.length) block(1); continue; }
    if (/^h[1-6]$/.test(tag)) { block(2); if (!close) out += '### '; continue; }
    if (tag === 'ul' || tag === 'ol') {
      if (close) { lists.pop(); if (!lists.length) block(2); } else { if (!lists.length) block(2); lists.push({ ol: tag === 'ol', n: 0 }); }
      continue;
    }
    if (tag === 'li') {
      if (close) continue;
      const l = lists.at(-1) || { ol: false, n: 0 };
      block(1);
      out += `${'  '.repeat(Math.max(0, lists.length - 1))}${l.ol ? `${++l.n}. ` : '- '}`;
      continue;
    }
    // Bold and italic as marks first: their spaces move outside once the words are in
    if (tag === 'b' || tag === 'strong') { out += close ? '\u0002' : '\u0001'; continue; }
    if (tag === 'i' || tag === 'em') { out += close ? '\u0004' : '\u0003'; continue; }
    if (tag === 'td' || tag === 'th') { if (close) out += ' '; continue; }
    if (tag === 'a') {
      if (!close) { const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3]); links.push({ href: entities(h?.[1] ?? h?.[2] ?? h?.[3] ?? ''), at: out.length }); continue; }
      const l = links.pop();
      if (!l) continue;
      const words = out.slice(l.at).trim();
      const ok = /^(https?:|mailto:)/i.test(l.href);
      if (ok && words && words !== l.href && words !== l.href.replace(/^mailto:/i, '')) out = `${out.slice(0, l.at)}[${words}](${l.href})`;
      else if (ok && !words) out += l.href;
      continue;
    }
  }
  const marks = (s2, open, shut, md) => s2
    .replace(new RegExp(`${open}(\\s*)${shut}`, 'g'), '$1')
    .replace(new RegExp(`${open}(\\s+)`, 'g'), `$1${open}`).replace(new RegExp(`(\\s+)${shut}`, 'g'), `${shut}$1`)
    .replace(new RegExp(`${open}|${shut}`, 'g'), md);
  return marks(marks(out, '\u0001', '\u0002', '**'), '\u0003', '\u0004', '*')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Markdown from HTML, cut where a quoted email starts that its HTML didn't mark ("-----Original message-----", "From: … Sent:") */
function cutQuotedMd(md) {
  const at = [/^[\\\s]*-{2,}\s*Original Message\s*-{2,}/mi, /^[ \t]*\**From:\**[^\n]+\n+[ \t]*\**(?:Sent|Date):/mi, TEXT_QUOTE[0]].map((re) => md.search(re)).filter((i) => i >= 0);
  return trailersOff(at.length ? md.slice(0, Math.min(...at)) : md);
}

/** The quoted email's attribution Apple Mail and others leave just above where the quote was cut ("On …, Peter wrote:") */
const dropAttribution = (md) => md.replace(/\n*[^\n]*\bOn\b[^\n]{0,250}\bwrote:\s*$/i, '').trim();

/** A reply's own words as Markdown (HTML when it has it, else its text) */
export function replyWords(payload) {
  const parts = partsOf(payload).filter((p) => !p.filename && p.body?.data);
  const decode = (p) => { const cs = /charset="?([\w-]+)/i.exec(header(p.headers, 'Content-Type'))?.[1] || 'utf-8'; try { return new TextDecoder(cs).decode(bytesOf(p.body.data)); } catch { return new TextDecoder().decode(bytesOf(p.body.data)); } };
  const html = parts.find((p) => p.mimeType === 'text/html');
  const plain = parts.find((p) => p.mimeType === 'text/plain');
  const md = html ? dropAttribution(cutQuotedMd(htmlToMd(decode(html)))) : plain ? dropAttribution(cutTextQuote(decode(plain))) : '';
  // Through the board's own Markdown and back, so it's what the editor would have kept
  try { return docToMd(mdToDoc(md)).trim(); } catch { return md; }
}

/** An out-of-office or other automatic reply, by its headers (RFC 3834 and what Outlook and Gmail add) or its subject */
export function isAutoReply(headers) {
  const h = (n) => header(headers, n).trim().toLowerCase();
  if (h('Auto-Submitted') && h('Auto-Submitted') !== 'no') return true;
  if (h('X-Autoreply') || h('X-Autorespond') || h('X-Autoresponder')) return true;
  if (['auto_reply', 'bulk', 'junk', 'list'].includes(h('Precedence'))) return true;
  const subject = header(headers, 'Subject').replace(/^\s*(re|aw|fw|fwd):\s*/i, '');
  return /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|ooo\b|away from (the )?office)/i.test(subject);
}

/**
 * The files a reply carries that belong with the report: PDFs, Office files and pictures attached, never a
 * signature's logo (an inline picture, or a small one), a calendar or contact card, or a mail program's own part
 */
export function replyFiles(payload) {
  return partsOf(payload).filter((p) => p.filename && (p.body?.attachmentId || p.body?.data)).filter((p) => {
    const name = p.filename.toLowerCase();
    const type = String(p.mimeType || '').toLowerCase();
    const size = p.body.size || 0;
    if (/\.(ics|vcf|p7s|p7m|asc|sig)$/.test(name) || name === 'winmail.dat' || /pkcs7|calendar|vcard/.test(type)) return false;
    if (size > MAX_FILE) return false;
    const inline = /^inline/i.test(header(p.headers, 'Content-Disposition')) || !!header(p.headers, 'Content-ID');
    if (/^image\/(jpe?g|png|gif|webp|avif|hei[cf])$/.test(type) || /\.(jpe?g|png|gif|webp|avif|hei[cf])$/.test(name)) return !inline ? size >= 20 * 1024 : size >= 150 * 1024;
    // What Board keeps (_board.js fileTypeOf): PDF, Word, Excel and PowerPoint
    return /\.(pdf|docx?|xlsx?|pptx)$/.test(name);
  }).map((p) => ({ part: p.partId, name: p.filename, type: p.mimeType || '', size: p.body.size || 0, attachmentId: p.body.attachmentId || '', data: p.body.data || '' }));
}

/** "Thomas Wilson <tw@x.com>" → { name, email } */
export function senderOf(from) {
  const s = String(from || '');
  const email = normEmail(/<([^>]+)>/.exec(s)?.[1] || (s.includes('@') ? s.trim() : ''));
  const name = s.replace(/<[^>]*>/, '').replace(/^\s*"|"\s*$/g, '').trim();
  return { name: name === email ? '' : name, email };
}
const sameName = (a, b) => { const k = (x) => String(x || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); return !!k(a) && k(a) === k(b); };

const JUDGE = `You read one reply to an email that asked a SOARD board member for their report on one item of the next board meeting's agenda.
Decide its kind:
- "report": the reply gives the board an update or report on that item, of any length. A short status, "no changes this quarter", "nothing new to report this time", or "my report is attached" (with a file) are reports.
- "other": anything else: a question, a promise to send it later, thanks, scheduling, saying they can't attend, or a note meant only for the staff.
Also give "signature": the first line of the sign-off or signature block at the very end (for example "Thanks,", "Best,", "Thomas Wilson, CPA", "Sent from my iPhone"), copied exactly as it appears, or "" when there is none.
Answer with JSON only.`;
const JUDGE_SCHEMA = { type: 'object', properties: { kind: { type: 'string', enum: ['report', 'other'] }, signature: { type: 'string' } }, required: ['kind', 'signature'] };

/** The rules when the model can't answer: enough words, a list, a file, or "nothing new" makes it a report */
export function judgeByRules(words, files = []) {
  const plain = mdPlain(words);
  if (files.length) return 'report';
  if (/\b(no (changes?|updates?|news)|nothing (new|to report)|no report)\b/i.test(plain)) return 'report';
  if (/^\s*([-*•]|\d+[.)])\s+/m.test(words)) return 'report';
  return plain.split(/\s+/).filter(Boolean).length >= 25 ? 'report' : 'other';
}

/** Report or something else, and where its signature starts → { kind, signature, by: 'ai' | 'rules' } */
export async function judgeReply(env, { words, files = [], title, meeting, person, question = '' }) {
  if (env?.AI?.run) {
    try {
      const out = await Promise.race([
        env.AI.run(MODEL, {
          messages: [{ role: 'system', content: question ? `${JUDGE}\nThe board chair asked them a question about their report: an answer to it is a "report".` : JUDGE }, { role: 'user', content: `The agenda item: ${title}\nThe meeting: ${meeting}\nThe board member: ${person}\n${question ? `The chair's question: ${question}\n` : ''}Files attached: ${files.map((f) => f.name).join(', ') || 'none'}\n\nThe reply:\n\n${words.slice(0, 6000)}` }],
          max_tokens: 200, temperature: 0, response_format: { type: 'json_schema', json_schema: JUDGE_SCHEMA },
        }, viaGateway('board-asks')),
        new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 25000)),
      ]);
      const a = typeof out?.response === 'string' ? parse(out.response, null) : out?.response;
      if (a && ['report', 'other'].includes(a.kind)) return { kind: a.kind, signature: String(a.signature || ''), by: 'ai' };
    } catch (e) {
      // (a cap reached: the reply stays unread and is judged when it lifts; the rules take a short report for a note)
      if (aiCapped(e)) throw e;
      console.error('[board-asks] judge', e.message);
    }
  }
  return { kind: question && mdPlain(words).split(/\s+/).filter(Boolean).length >= 3 ? 'report' : judgeByRules(words, files), signature: '', by: 'rules' };
}

/** The words with their signature cut: from the model's line (found exactly, in the last part of the reply) on */
export function cutSignature(words, signature) {
  const sig = String(signature || '').trim();
  if (!sig || sig.length < 2) return words;
  const lines = words.split('\n');
  const plainLine = (l) => mdPlain(l).trim();
  for (let i = lines.length - 1; i >= Math.max(1, Math.floor(lines.length * 0.4)); i--) {
    if (plainLine(lines[i]) === mdPlain(sig).trim() || lines[i].trim() === sig) return lines.slice(0, i).join('\n').trim();
  }
  return words;
}

/** A report arriving on an item: the first is the report; one after goes under it, never over it → the meeting */
export async function postReport(DB, { meetingId, itemId, words, name, heading = '', now = Date.now() }) {
  return patchMeeting(DB, meetingId, (cur) => ({
    ...cur,
    sections: cur.sections.map((s) => ({
      ...s,
      items: s.items.map((x) => {
        if (x.id !== itemId) return x;
        const had = String(x.report || '').trim();
        if (had && had.includes(words.trim())) return x;
        const under = heading ? `### ${heading}` : x.reportBy && x.reportBy !== name ? `### From ${name}` : `### Added ${shortDay(todayEastern(now))}`;
        const report = (had ? `${had}\n\n${under}\n\n${words}` : words).slice(0, LIMITS.report);
        return { ...x, report, reportBy: x.reportBy || name, reportAt: nowIso(now) };
      }),
    })),
  }), { by: name });
}

// ─── One run (the heartbeat, every five minutes) ────────────────────

/** The next meeting ahead (its day not passed), held for real, or null */
export function nextUp(meetings, today) {
  return meetings.filter((m) => isDate(m.date) && m.date >= today && !m.notBoard && !m.practice && !heldOn(m))
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}
/** Held: started and ended live on or after its own day. Ended before it, it was a practice run (Oct 29 2026, on Nov 5's) */
export const heldOn = (m) => !!m?.live?.endedAt && todayEastern(Date.parse(m.live.endedAt)) >= m.date;

/** Who should be asked for which item: [{ it, person }], board members with an email, items without a report */
export function wanted(m, people) {
  const everyone = [...people.board, ...people.staff];
  const reach = new Map(everyone.filter((p) => p.slug && p.email).map((p) => [p.slug, p]));
  // (a copy still called one is being worked on: no email about it until it has a name of its own)
  return m.sections.flatMap((s) => s.items).filter((it) => reportsOn(it) && !isCopyName(it.title))
    .flatMap((it) => presentersOf(it, everyone).filter((p) => p.slug && reach.has(p.slug)).map((p) => ({ it, person: reach.get(p.slug) })));
}

/** Three or more items: one email listing them (their asks are one "list"), so nobody gets a dozen */
export const LIST_FROM = 3;

/**
 * Staff on People → Team with the address they sign in with: SOARD's Google account of the same name (staff_state's
 * directory, as the staff sign-in keeps it), else first@ for a founder (how the founders sign in) → people, staff filled
 */
export async function withStaffEmails(DB, people) {
  let accounts = [];
  try { accounts = JSON.parse((await DB.prepare("SELECT data FROM staff_state WHERE key = 'directory'").first())?.data || '{}')?.accounts || []; } catch { accounts = []; }
  const norm = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const active = accounts.filter((a) => a.active && isStaffEmail(a.email));
  const founders = new Set((await peopleRows(DB)).filter((p) => p.role === 'founder').map((p) => p.slug));
  const staff = people.staff.map((p) => {
    if (p.email) return p;
    const named = active.filter((a) => norm(a.name) === norm(p.name));
    const first = `${norm(p.name).split(' ')[0]}@soardcharity.com`;
    const email = named.length === 1 ? normEmail(named[0].email) : founders.has(p.slug) && (!active.length || active.some((a) => normEmail(a.email) === first)) ? first : null;
    return { ...p, email };
  });
  return { ...people, staff };
}

/** This run's turn: board_state's row changed only if no other run changed it since it was read → true when it's ours */
async function takeTurn(DB, state, now) {
  const before = JSON.stringify(state);
  const after = JSON.stringify({ ...state, at: nowIso(now) });
  const had = await DB.prepare('SELECT data FROM board_state WHERE key = ?').bind(KEY).first();
  const r = had
    ? await DB.prepare('UPDATE board_state SET data = ?, updated_at = ? WHERE key = ? AND data = ?').bind(after, nowIso(now), KEY, had.data === before ? before : '\u0000').run()
    : await DB.prepare('INSERT OR IGNORE INTO board_state (key, data, updated_at) VALUES (?, ?, ?)').bind(KEY, after, nowIso(now)).run();
  return (r?.meta?.changes ?? r?.changes ?? 0) > 0;
}

/**
 * Once: Peter's Oct 29 2026 practice run on the real Nov 5 meeting left it ended live, so Board and the board page took
 * it as held early (Peter, Nov 2: "nov 5 meeting has not been held yet", then "clear it"). Only that exact run, only
 * while it's still there, through patchMeeting (a newer updatedAt, so an open editor merges); kept as done in board_state
 */
export const PRACTICE_RUN = { meetingId: 'm_zh9e3qae', endedAt: '2026-10-30T01:41:02.651Z' };
const EMPTY_LIVE = { startedAt: '', endedAt: '', itemId: '', fileId: '', page: 0, part: 0, screen: '', sectionId: '', vote: null, sectionAt: '', floor: '' };
export async function clearPracticeRun(DB, { now = Date.now() } = {}) {
  const once = await readState(DB, 'asks-once');
  if (once.practiceRun) return false;
  let cleared = false;
  // The stored row, as it is (reading the meeting may already leave a run-through out)
  const row = await DB.prepare("SELECT json_extract(data, '$.live.endedAt') AS ended FROM board_meetings WHERE id = ?").bind(PRACTICE_RUN.meetingId).first().catch(() => null);
  if (row?.ended === PRACTICE_RUN.endedAt) {
    // Never a real run started since: only the practice run's end, or nothing left of it
    await patchMeeting(DB, PRACTICE_RUN.meetingId, (cur) => (!cur.live?.startedAt || cur.live.endedAt === PRACTICE_RUN.endedAt ? { ...cur, live: { ...EMPTY_LIVE } } : cur), { by: 'peter@soardcharity.com' });
    cleared = true;
  }
  await writeState(DB, 'asks-once', { ...once, practiceRun: { at: nowIso(now), cleared } });
  return cleared;
}

/**
 * Once: Peter tried the report page on his own Nov 5 item and his test words were kept as its report (Peter, Nov 2:
 * "delete it"). Only while the report is still exactly those words: it's emptied (patchMeeting, so an open editor
 * merges), and his ask is waiting again, so its reminder and deadline still come
 */
export const TEST_REPORT = { meetingId: 'm_zh9e3qae', itemId: 'i_f2szcx5x', words: 'asdfsafdadf asf', slug: 'peter-ranney' };
export async function clearTestReport(DB, { now = Date.now() } = {}) {
  const once = await readState(DB, 'asks-once');
  if (once.testReport) return false;
  const m = await getMeeting(DB, TEST_REPORT.meetingId);
  const it = m?.sections.flatMap((s) => s.items).find((x) => x.id === TEST_REPORT.itemId);
  let cleared = false;
  if (String(it?.report || '').trim() === TEST_REPORT.words) {
    await patchMeeting(DB, TEST_REPORT.meetingId, (cur) => ({
      ...cur,
      sections: cur.sections.map((s) => ({ ...s, items: s.items.map((x) => (x.id === TEST_REPORT.itemId && String(x.report || '').trim() === TEST_REPORT.words ? { ...x, report: '', reportBy: '', reportAt: '' } : x)) })),
    }), { by: 'peter@soardcharity.com' });
    await ensureAsks(DB);
    await DB.prepare("UPDATE board_asks SET status = 'asked', in_at = '', updated_at = ? WHERE kind = 'report' AND meeting_id = ? AND item_id = ? AND slug = ? AND status = 'in'")
      .bind(nowIso(now), TEST_REPORT.meetingId, TEST_REPORT.itemId, TEST_REPORT.slug).run();
    cleared = true;
  }
  await writeState(DB, 'asks-once', { ...(await readState(DB, 'asks-once')), testReport: { at: nowIso(now), cleared } });
  return cleared;
}

export async function maybeRunAsks(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!env?.DB) return null;
  await clearPracticeRun(env.DB, { now }).catch((e) => console.error('[board-asks] practice run', e.message));
  await clearTestReport(env.DB, { now }).catch((e) => console.error('[board-asks] test report', e.message));
  if (!env.GOOGLE_CALENDAR_KEY) return null;
  try {
    const state = await readState(env.DB, KEY);
    if (state.off) return null;
    if (!force && state.at && now - Date.parse(state.at) < EVERY_MS) return null;
    if (!(await takeTurn(env.DB, state, now))) return null;
    const done = await runAsks(env, { fetchImpl, now });
    await writeState(env.DB, KEY, { ...(await readState(env.DB, KEY)), at: nowIso(now), ok: nowIso(now), error: '', did: done });
    return done;
  } catch (e) {
    console.error('[board-asks]', e.message);
    await writeState(env.DB, KEY, { ...(await readState(env.DB, KEY)), at: nowIso(now), error: e.message, errorAt: nowIso(now) }).catch(() => {});
    return null;
  }
}

/** The switch beside a meeting's reports, in Board: 'on' (the board gets them), 'off' (nothing), else 'test' (only the test set, to the asker) */
export const asksMode = (settings) => (['on', 'off'].includes(settings?.asks) ? settings.asks : 'test');

export async function runAsks(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  await ensureAsks(env.DB);
  const today = todayEastern(now);
  const [meetings, settings, rosterNow, senders] = await Promise.all([listMeetings(env.DB), getSettings(env.DB), roster(env.DB, { withEmails: true }), sendersFor(env.DB)]);
  const people = await withStaffEmails(env.DB, rosterNow);
  const did = { asked: 0, reminded: 0, late: 0, chair: 0, replies: 0, reports: 0 };
  const mode = asksMode(await readSettings(env.DB));
  if (!senders || mode === 'off') return did;
  // Two weeks out, the agenda is what's on it: the template as it stands becomes the meeting's own, so whoever presents
  // is asked for a report and the chair reviews it, with nobody having to touch it first
  const due = nextUp(meetings, today);
  if (due && agendaIsDraft(due, settings.template) && due.sections.some((s) => s.items.length) && daysUntil(today, due.date) <= ASK_DAYS) {
    due.agendaFrom = { kind: 'typed', name: '', at: nowIso(now) };
    await patchMeeting(env.DB, due.id, (cur) => (agendaIsDraft(cur, settings.template) ? { ...cur, agendaFrom: due.agendaFrom } : cur), { by: 'Board' });
  }
  const ctx = { env, fetchImpl, now, senders, people, today };
  ctx.readToken = await accessToken(env, senders.from.email, { fetchImpl, now, scope: GMAIL_READ_SCOPE });
  // Test: each email the next meeting will have, once, to the asker alone; nothing to the board and nothing kept as asked
  if (mode === 'test') {
    const t = nextUp(meetings.map((x) => ({ ...x, live: { ...(x.live || {}), endedAt: '' } })), today);
    const state = await readState(env.DB, KEY);
    if (!t || agendaIsDraft(t, settings.template) || daysUntil(today, t.date) > ASK_DAYS || state.tests?.[t.id] || !sendingHours(now)) return did;
    ctx.sendToken = await accessToken(env, senders.from.email, { fetchImpl, now, scope: GMAIL_SEND_SCOPE });
    ctx.test = true;
    did.tests = await sendTests(ctx, (await getMeeting(env.DB, t.id)) || t, await booksNow(env.DB, { now }).catch(() => null));
    await writeState(env.DB, KEY, { ...(await readState(env.DB, KEY)), tests: { ...(state.tests || {}), [t.id]: nowIso(now) } });
    return did;
  }
  // Replies first, on every meeting ahead with asks out
  for (const m of meetings.filter((x) => isDate(x.date) && x.date >= today)) {
    const asks = (await asksFor(env.DB, m.id)).filter((a) => a.thread && a.kind !== 'list' && a.status !== 'dropped' && a.status !== 'sending');
    for (const a of asks) {
      const r = await (a.kind === 'chair' ? readChairReplies(ctx, m, a) : readReplies(ctx, m, a)).catch((e) => { console.error('[board-asks] replies', e.message); return { replies: 0, reports: 0 }; });
      did.replies += r.replies;
      did.reports += r.reports;
    }
  }
  const m = nextUp(meetings, today);
  if (!m || agendaIsDraft(m, settings.template)) return did;
  const days = daysUntil(today, m.date);
  if (days > ASK_DAYS) return did;
  const fresh = (await getMeeting(env.DB, m.id)) || m;
  const asks = await asksFor(env.DB, m.id);
  const want = wanted(fresh, people);
  // Someone with three or more reports still to write: one email listing them (a 'list'), never one each. Once a list,
  // always (that meeting); reports already written don't count, so one left is a plain ask
  const count = new Map();
  for (const w of want) if (!String(w.it.report || '').trim()) count.set(w.person.slug, (count.get(w.person.slug) || 0) + 1);
  const listed = new Set([...count].filter(([, n]) => n >= LIST_FROM).map(([slug]) => slug));
  for (const a of asks.filter((x) => x.kind === 'list')) listed.add(a.slug);
  // A list follows the agenda: in once each of its items has a report; its items as they are now
  for (const a of asks.filter((x) => x.kind === 'list' && ['asked', 'late', 'dropped'].includes(x.status))) {
    const mine = want.filter((w) => w.person.slug === a.slug).map((w) => w.it);
    const ids = mine.map((it) => it.id);
    if (!mine.length) { if (a.status !== 'dropped') await setAsk(env.DB, a.id, { status: 'dropped' }); continue; }
    if (mine.every((it) => String(it.report || '').trim())) await setAsk(env.DB, a.id, { status: 'in', inAt: nowIso(now), items: ids });
    else if (JSON.stringify(ids) !== JSON.stringify(a.items) || a.status === 'dropped') await setAsk(env.DB, a.id, { items: ids, ...(a.status === 'dropped' ? { status: 'asked' } : {}) });
  }
  // Asks whose item or presenter is gone stop (and start again if they come back); a report written on the board page counts as in
  for (const a of asks.filter((x) => x.kind === 'report' && ['asked', 'late', 'dropped'].includes(x.status))) {
    const it = fresh.sections.flatMap((s) => s.items).find((x) => x.id === a.itemId);
    const still = !!it && want.some((w) => w.it.id === a.itemId && w.person.slug === a.slug);
    if (it && String(it.report || '').trim()) await setAsk(env.DB, a.id, { status: 'in', inAt: nowIso(now) });
    else if (!still && a.status !== 'dropped') await setAsk(env.DB, a.id, { status: 'dropped' });
    else if (still && a.status === 'dropped') await setAsk(env.DB, a.id, { status: 'asked' });
  }
  // An email a run claimed but never recorded as sent (it stopped between the two): it may have gone, so never again by itself
  await env.DB.prepare("UPDATE board_asks SET status = 'unknown', error = 'The run stopped while sending it' WHERE status = 'sending' AND updated_at < ?").bind(nowIso(now - 15 * 60 * 1000)).run();
  if (!sendingHours(now)) return did;
  ctx.sendToken = await accessToken(env, senders.from.email, { fetchImpl, now, scope: GMAIL_SEND_SCOPE });
  const books = await booksNow(env.DB, { now }).catch(() => null);
  const errors = [];
  // The asks (two days ahead at the latest). Each on its own: one that fails never stops the rest
  if (days >= 2) {
    for (const { it, person } of want) {
      if (listed.has(person.slug)) continue;
      if (String(it.report || '').trim() || asks.some((a) => a.kind === 'report' && a.itemId === it.id && a.slug === person.slug)) continue;
      try { if (await sendAsk(ctx, fresh, it, person, books)) did.asked++; } catch (e) { errors.push(e.message); }
    }
    for (const slug of listed) {
      if (asks.some((a) => a.kind === 'list' && a.slug === slug)) continue;
      const mine = want.filter((w) => w.person.slug === slug);
      const items = mine.map((w) => w.it).filter((it) => !String(it.report || '').trim());
      if (!items.length) continue;
      try { if (await sendList(ctx, fresh, mine[0].person, items)) did.asked++; } catch (e) { errors.push(e.message); }
    }
  }
  const current = (await asksFor(env.DB, m.id)).filter((a) => a.kind === 'report');
  const chair = chairOf(people);
  for (const a of current) {
    // Only an ask that's out and waiting: never one that's in, dropped, failed or a question's own conversation
    if (!['asked', 'late'].includes(a.status) || !a.due || !a.thread) continue;
    const it = fresh.sections.flatMap((s) => s.items).find((x) => x.id === a.itemId);
    if (!it || String(it.report || '').trim()) continue;
    const person = people.board.find((p) => p.slug === a.slug) || { name: a.name, email: a.email };
    try {
      // The meeting moved: its due moves with it (never sooner than a day off), and the presenter is told
      if (a.meetingDate && a.meetingDate !== fresh.date) {
        const moved = Math.max(dueFor(fresh.date, Date.parse(a.askedAt)), dueFor(fresh.date, now));
        await setAsk(env.DB, a.id, { meetingDate: fresh.date, due: nowIso(moved), status: 'asked', remindedAt: '', lateAt: '' });
        await replyInThread(ctx, a, { to: [person], cc: ctx.senders.cc, ...movedEmail({ m: fresh, it, person, due: moved, from: senders.from }) });
        continue;
      }
      const due = Date.parse(a.due);
      // The reminder, claimed before it goes (a second run never sends it again)
      const at = remindAt(Date.parse(a.askedAt), due);
      if (a.status === 'asked' && !a.remindedAt && at && now >= at && now < due && await claimed(env.DB, a.id, 'reminded_at', now)) {
        await replyInThread(ctx, a, { to: [person], cc: ctx.senders.cc, ...reminderEmail({ m: fresh, it, person, due, from: senders.from, now }) });
        did.reminded++;
      }
      // Past due (not on the meeting's day: they'll be in the room), claimed the same way
      if (a.status === 'asked' && now >= due && today < fresh.date && await claimed(env.DB, a.id, 'late_at', now, { status: 'late' })) {
        const copy = [...(chair && chair.slug !== a.slug ? [chair] : []), ...ctx.senders.cc];
        await replyInThread(ctx, a, { to: [person], cc: copy, ...lateEmail({ m: fresh, it, person, due, from: senders.from, chair: chair && chair.slug !== a.slug ? chair : null, now }) });
        did.late++;
      }
    } catch (e) {
      errors.push(e.message);
      await setAsk(env.DB, a.id, { error: String(e.message).slice(0, 300) }).catch(() => {});
    }
  }
  const lists = (await asksFor(env.DB, m.id)).filter((a) => a.kind === 'list');
  const everyone = [...people.board, ...people.staff];
  for (const a of lists) {
    if (!['asked', 'late'].includes(a.status) || !a.due || !a.thread) continue;
    const items = a.items.map((id) => fresh.sections.flatMap((s) => s.items).find((x) => x.id === id)).filter((it) => it && !String(it.report || '').trim());
    if (!items.length) continue;
    const person = everyone.find((p) => p.slug === a.slug) || { name: a.name, email: a.email };
    try {
      if (a.meetingDate && a.meetingDate !== fresh.date) {
        const moved = Math.max(dueFor(fresh.date, Date.parse(a.askedAt)), dueFor(fresh.date, now));
        await setAsk(env.DB, a.id, { meetingDate: fresh.date, due: nowIso(moved), status: 'asked', remindedAt: '', lateAt: '' });
        await replyInThread(ctx, a, { to: [person], cc: ctx.senders.cc, ...listBody(fresh, items, [`Hi ${firstName(person.name)},`, `The ${meetingName(fresh)} is now ${longDay(fresh.date)}, so your reports are due ${dueWords(moved)}:`, 'Each link opens that item’s report on the board page.'], `Thanks,\n${firstName(senders.from.name) || 'SOARD'}`) });
        continue;
      }
      const due = Date.parse(a.due);
      const at = remindAt(Date.parse(a.askedAt), due);
      if (a.status === 'asked' && !a.remindedAt && at && now >= at && now < due && await claimed(env.DB, a.id, 'reminded_at', now)) {
        await replyInThread(ctx, a, { to: [person], cc: ctx.senders.cc, ...listReminderEmail({ m: fresh, items, person, due, from: senders.from, now }) });
        did.reminded++;
      }
      if (a.status === 'asked' && now >= due && today < fresh.date && await claimed(env.DB, a.id, 'late_at', now, { status: 'late' })) {
        const copy = [...(chair && chair.slug !== a.slug ? [chair] : []), ...ctx.senders.cc];
        await replyInThread(ctx, a, { to: [person], cc: copy, ...listLateEmail({ m: fresh, items, person, due, from: senders.from, chair: chair && chair.slug !== a.slug ? chair : null, now }) });
        did.late++;
      }
    } catch (e) {
      errors.push(e.message);
      await setAsk(env.DB, a.id, { error: String(e.message).slice(0, 300) }).catch(() => {});
    }
  }
  // The chair's review, once (not on the meeting's day)
  if (chair && today < fresh.date && !asks.some((a) => a.kind === 'chair')) {
    const dues = [...current, ...lists].filter((a) => ['asked', 'late', 'in'].includes(a.status) && a.due).map((a) => Date.parse(a.due));
    if (now >= chairAt(fresh.date, dues)) {
      const all = await asksFor(env.DB, m.id);
      const mail = chairEmail({ m: (await getMeeting(env.DB, m.id)) || fresh, chair, from: senders.from, asks: all, people: [...people.board, ...people.staff], cc: ctx.senders.cc });
      if (await claim(env.DB, { kind: 'chair', meetingId: m.id, itemId: '', person: chair, title: '', date: fresh.date, now })) {
        try {
          const sent = await send(ctx, { to: [chair, ...ctx.senders.cc], cc: [ctx.senders.from], ...mail });
          await env.DB.prepare("UPDATE board_asks SET status = 'sent', thread = ?, msg_ids = ?, subject = ?, updated_at = ? WHERE kind = 'chair' AND meeting_id = ? AND status = 'sending'")
            .bind(sent.threadId, JSON.stringify([sent.messageId].filter(Boolean)), mail.subject, nowIso(now), m.id).run();
          did.chair++;
        } catch (e) {
          errors.push(e.message);
          await env.DB.prepare("UPDATE board_asks SET status = ?, error = ?, updated_at = ? WHERE kind = 'chair' AND meeting_id = ? AND status = 'sending'")
            .bind(gmailRefused(e) ? 'failed' : 'unknown', String(e.message).slice(0, 300), nowIso(now), m.id).run();
        }
      }
    }
  }
  if (errors.length) did.errors = errors;
  return did;
}

/**
 * The test set, built from the real meeting and people: the money's presenter's ask and one other's, then the money's
 * reminder, past due (the chair copied), thanks, the chair's review, a question sent back, and the approval → how many
 */
export async function sendTests(ctx, m, books) {
  const { senders, people, now } = ctx;
  const want = wanted(m, people);
  if (!want.length) return 0;
  const count = new Map();
  for (const w of want) if (!String(w.it.report || '').trim()) count.set(w.person.slug, (count.get(w.person.slug) || 0) + 1);
  const listedSlug = [...count].find(([, n]) => n >= LIST_FROM)?.[0] || '';
  const single = want.filter((w) => w.person.slug !== listedSlug);
  const money = single.find((w) => isMoney(w.it)) || single[0] || want[0];
  const other = single.find((w) => w.it.id !== money.it.id && w.person.slug !== money.person.slug);
  const due = dueFor(m.date, now);
  const chair = chairOf(people);
  const from = senders.from;
  const cc = senders.cc;
  const mails = [];
  const ask = (w) => ({ to: [w.person], cc, ...askEmail({ m, it: w.it, person: w.person, due, from, books }) });
  const first = ask(money);
  const re = `Re: ${first.subject}`;
  mails.push(first);
  if (other) mails.push(ask(other));
  if (listedSlug) {
    const mine = want.filter((w) => w.person.slug === listedSlug);
    mails.push({ to: [mine[0].person], cc, ...listEmail({ m, items: mine.map((w) => w.it), person: mine[0].person, due, from }) });
  }
  mails.push({ to: [money.person], cc, subject: re, ...reminderEmail({ m, it: money.it, person: money.person, due, from, now: remindAt(now, due) || now }) });
  mails.push({ to: [money.person], cc: [...(chair && chair.slug !== money.person.slug ? [chair] : []), ...cc], subject: re, ...lateEmail({ m, it: money.it, person: money.person, due, from, chair: chair && chair.slug !== money.person.slug ? chair : null, now: due }) });
  mails.push({ to: [money.person], subject: re, ...thanksEmail({ m, it: money.it, person: money.person, from }) });
  if (chair) {
    const asks = want.map((w) => ({ kind: 'report', itemId: w.it.id, status: 'asked', due: nowIso(due) }));
    const review = chairEmail({ m, chair, from, asks, people: [...people.board, ...people.staff], cc });
    mails.push({ to: [chair], cc, ...review });
    mails.push({ to: [money.person], cc: [chair, ...cc], subject: re, ...questionEmail({ m, it: money.it, person: money.person, asker: chair, question: `(${firstName(chair.name)}’s question goes here, as typed on the review page.)`, from }) });
    mails.push({ to: [chair], cc, subject: `Re: ${review.subject}`, ...body([`Thanks, ${firstName(chair.name)}. The agenda for the ${meetingName(m)} on ${longDay(m.date)} is approved.`, `${firstName(from.name) || 'SOARD'}`]) });
  }
  for (const mail of mails) await send(ctx, mail);
  return mails.length;
}

/** A reminder or past-due note claimed before it goes: true only for the run whose UPDATE set it (`also`: more columns) */
async function claimed(DB, id, col, now, also = {}) {
  const extra = Object.entries(also).map(([k]) => `, ${k} = ?`).join('');
  const r = await DB.prepare(`UPDATE board_asks SET ${col} = ?${extra}, updated_at = ? WHERE id = ? AND (${col} IS NULL OR ${col} = '')`)
    .bind(nowIso(now), ...Object.values(also), nowIso(now), id).run();
  return (r?.meta?.changes ?? r?.changes ?? 0) > 0;
}

/** A row for an email about to go, so a second run never sends it again → true when this run has it */
async function claim(DB, { kind, meetingId, itemId, person, title, due = '', date = '', now }) {
  const r = await DB.prepare(`INSERT OR IGNORE INTO board_asks (id, kind, meeting_id, item_id, slug, name, email, title, due, status, asked_at, msg_ids, files, updated_at, meeting_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, '[]', '[]', ?, ?)`).bind(uid('ask_'), kind, meetingId, itemId, person.slug, person.name, person.email, title, due, nowIso(now), nowIso(now), date).run();
  return (r?.meta?.changes ?? r?.changes ?? 0) > 0;
}

async function sendAsk(ctx, m, it, person, books) {
  const { env, now } = ctx;
  const due = dueFor(m.date, now);
  if (!(await claim(env.DB, { kind: 'report', meetingId: m.id, itemId: it.id, person, title: it.title, due: nowIso(due), date: m.date, now }))) return false;
  const mail = askEmail({ m, it, person, due, from: ctx.senders.from, books });
  const where = 'WHERE kind = ? AND meeting_id = ? AND item_id = ? AND slug = ?';
  let sent;
  try {
    sent = await send(ctx, { to: [person], cc: ctx.senders.cc, ...mail });
  } catch (e) {
    // Gmail refused it (4xx: it didn't go) or the answer never came (it may have): kept, said in Automations, never sent again by itself
    await env.DB.prepare(`UPDATE board_asks SET status = ?, error = ?, updated_at = ? ${where}`).bind(gmailRefused(e) ? 'failed' : 'unknown', String(e.message).slice(0, 300), nowIso(now), 'report', m.id, it.id, person.slug).run();
    console.error('[board-asks] ask', person.slug, e.message);
    return false;
  }
  await env.DB.prepare(`UPDATE board_asks SET status = ?, thread = ?, msg_ids = ?, subject = ?, updated_at = ? ${where}`)
    .bind('asked', sent.threadId, JSON.stringify([sent.messageId].filter(Boolean)), mail.subject, nowIso(now), 'report', m.id, it.id, person.slug).run();
  return true;
}
/** A list's email: one for someone presenting three or more, kept with its items (as sendAsk keeps one) */
async function sendList(ctx, m, person, items) {
  const { env, now } = ctx;
  const due = dueFor(m.date, now);
  if (!(await claim(env.DB, { kind: 'list', meetingId: m.id, itemId: '', person, title: `${items.length} reports`, due: nowIso(due), date: m.date, now }))) return false;
  const mail = listEmail({ m, items, person, due, from: ctx.senders.from });
  const where = "WHERE kind = 'list' AND meeting_id = ? AND item_id = '' AND slug = ?";
  let sent;
  try {
    sent = await send(ctx, { to: [person], cc: ctx.senders.cc, ...mail });
  } catch (e) {
    await env.DB.prepare(`UPDATE board_asks SET status = ?, error = ?, items = ?, updated_at = ? ${where}`).bind(gmailRefused(e) ? 'failed' : 'unknown', String(e.message).slice(0, 300), JSON.stringify(items.map((it) => it.id)), nowIso(now), m.id, person.slug).run();
    console.error('[board-asks] list', person.slug, e.message);
    return false;
  }
  await env.DB.prepare(`UPDATE board_asks SET status = 'asked', thread = ?, msg_ids = ?, subject = ?, items = ?, updated_at = ? ${where}`)
    .bind(sent.threadId, JSON.stringify([sent.messageId].filter(Boolean)), mail.subject, JSON.stringify(items.map((it) => it.id)), nowIso(now), m.id, person.slug).run();
  return true;
}

/** Gmail said no (a 4xx): the email didn't go */
const gmailRefused = (e) => /Gmail answered 4\d\d/.test(String(e?.message || ''));

/** An email in an ask's conversation, after its newest message, as a reply to it */
async function replyInThread(ctx, a, mail) {
  const last = a.msgIds.at(-1) || '';
  const sent = await send(ctx, { ...mail, subject: /^re:/i.test(a.subject) ? a.subject : `Re: ${a.subject}`, threadId: a.thread, inReplyTo: last, references: a.msgIds.slice(0, -1).join(' ') });
  await setAsk(ctx.env.DB, a.id, { msgIds: [...a.msgIds, sent.messageId].filter(Boolean) });
  return sent;
}

/** What a reply was (kept so it's read once) */
const mark = (DB, id, a, sender, outcome, detail = '') => DB.prepare('INSERT OR REPLACE INTO board_ask_mail (gmail_id, ask_id, at, sender, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(id, a.id, nowIso(), sender, outcome, String(detail).slice(0, 300)).run();

/** The replies in an ask's conversation, and any that left it (a new subject) but still name one of its emails */
/** An email this site sent (its own mark): never a person's reply */
const ours = (headers) => !!header(headers, 'X-SOARD-Board');

async function readReplies(ctx, m, ask) {
  let a = ask;
  const { env, fetchImpl } = ctx;
  const out = { replies: 0, reports: 0 };
  const thread = await gmailCall(ctx.readToken, `/threads/${a.thread}?format=full`, { fetchImpl });
  const msgs = [...(thread?.messages || [])];
  // A reply with a subject of its own: Gmail starts a new conversation, but In-Reply-To still names ours
  if (a.msgIds.length && a.email) {
    const after = Math.floor(Date.parse(a.askedAt) / 1000);
    const found = await gmailCall(ctx.readToken, `/messages?maxResults=10&q=${encodeURIComponent(`from:${a.email} after:${after}`)}`, { fetchImpl }).catch(() => null);
    for (const ref of found?.messages || []) {
      if (msgs.some((x) => x.id === ref.id) || ref.threadId === a.thread) continue;
      const meta = await gmailCall(ctx.readToken, `/messages/${ref.id}?format=metadata&metadataHeaders=In-Reply-To&metadataHeaders=References`, { fetchImpl }).catch(() => null);
      const refs = `${header(meta?.payload?.headers, 'In-Reply-To')} ${header(meta?.payload?.headers, 'References')}`;
      if (a.msgIds.some((id) => id && refs.includes(id))) msgs.push(await gmailCall(ctx.readToken, `/messages/${ref.id}?format=full`, { fetchImpl }));
    }
  }
  const asker = normEmail(ctx.senders.from.email);
  for (const msg of msgs) {
    if (!msg?.id || (msg.labelIds || []).includes('DRAFT') || ours(msg.payload?.headers)) continue;
    // In the asker's mailbox their own replies are Sent: one counts only on an ask to the asker themselves
    if ((msg.labelIds || []).includes('SENT') && normEmail(a.email) !== asker) continue;
    if (await env.DB.prepare('SELECT 1 AS x FROM board_ask_mail WHERE gmail_id = ?').bind(msg.id).first()) continue;
    a = askOf(await env.DB.prepare('SELECT * FROM board_asks WHERE id = ?').bind(a.id).first()) || a;
    if (Number(msg.internalDate || 0) < Date.parse(a.askedAt)) continue;
    const h = msg.payload?.headers || [];
    const who = senderOf(header(h, 'From'));
    // Staff copied in (Holly answering, the asker) are never the report; the presenter's own reply is, staff or not
    if (isStaffEmail(who.email) && who.email !== normEmail(a.email)) { await mark(env.DB, msg.id, a, who.email, 'staff'); continue; }
    out.replies++;
    if (isAutoReply(h)) { await mark(env.DB, msg.id, a, who.email, 'auto'); continue; }
    if (who.email !== normEmail(a.email) && !sameName(who.name, a.name)) { await mark(env.DB, msg.id, a, who.email, 'stranger', who.name); continue; }
    const r = await takeReply(ctx, m, a, msg);
    await mark(env.DB, msg.id, a, who.email, r.outcome, r.detail);
    if (r.outcome === 'report' || r.outcome === 'answer') out.reports++;
  }
  return out;
}

/** One reply from the presenter: a report goes on the agenda (with its files) and they're thanked; else it waits in the inbox */
async function takeReply(ctx, m, a, msg) {
  const { env, fetchImpl, now } = ctx;
  const cur = await getMeeting(env.DB, m.id);
  const it = cur?.sections.flatMap((s) => s.items).find((x) => x.id === a.itemId);
  if (!it) return { outcome: 'gone', detail: 'the item isn’t on the agenda any more' };
  const files = replyFiles(msg.payload);
  let words = replyWords(msg.payload);
  if (!words && !files.length) return { outcome: 'empty' };
  // A question sent back on this report before this reply came: the reply is its answer
  const q = await env.DB.prepare('SELECT * FROM board_ask_questions WHERE meeting_id = ? AND item_id = ? AND answered_at IS NULL AND at <= ? ORDER BY at DESC LIMIT 1')
    .bind(m.id, it.id, nowIso(Number(msg.internalDate) || now)).first();
  const verdict = await judgeReply(env, { words, files, title: it.title, meeting: meetingName(cur), person: a.name, question: q?.text || '' });
  words = cutSignature(words, verdict.signature);
  if (verdict.kind !== 'report') return { outcome: 'other', detail: mdPlain(words).slice(0, 200) };
  // Its files, once each (a reply carrying the same file again brings only what's new)
  const kept = new Set(a.files);
  const added = [];
  for (const f of files) {
    const k = `${f.name}|${f.size}`;
    if (kept.has(k)) continue;
    try {
      const data = f.data || (await gmailCall(ctx.readToken, `/messages/${msg.id}/attachments/${f.attachmentId}`, { fetchImpl })).data;
      await attachToItem(env, m.id, it.id, new File([bytesOf(data)], f.name, { type: f.type }), { admin: true, adminEmail: a.email });
      kept.add(k);
      added.push(f.name);
    } catch (e) {
      console.error('[board-asks] file', f.name, e.message);
    }
  }
  // A reply that's only a file: the report says what came, so it reads as in. An answer goes under the question it answers
  const text = words || (added.length ? `Attached: ${added.join(', ')}` : '');
  // Only files, and none could be kept: not in, not thanked (it waits in the inbox for a person)
  if (!text) return { outcome: 'files-failed', detail: files.map((f) => f.name).join(', ') };
  const heading = q ? `Answer to ${q.by_name}’s question` : '';
  const posted = text ? await postReport(env.DB, { meetingId: m.id, itemId: it.id, words: q ? `> ${mdPlain(q.text).replace(/\n+/g, ' ')}\n\n${text}` : text, name: a.name, heading, now }) : null;
  if (q) await env.DB.prepare('UPDATE board_ask_questions SET answered_at = ? WHERE id = ?').bind(nowIso(now), q.id).run();
  // A question's own conversation stays one (its report was never asked for by email)
  await setAsk(env.DB, a.id, { status: a.status === 'question' ? 'question' : 'in', inAt: nowIso(now), files: [...kept] });
  // Thanks at once, whatever the hour: they just wrote (an answer: whoever asked is copied, so they know it came)
  const person = { name: a.name, email: a.email };
  const asker = q?.by_slug ? ctx.people.board.find((p) => p.slug === q.by_slug && p.email) : null;
  // How it now shows in the meeting: the report as posted (with what was there before)
  const report = posted?.sections?.flatMap((s) => s.items).find((x) => x.id === it.id)?.report ?? it.report;
  const back = thanksEmail({ m: cur, it, person, from: ctx.senders.from, answer: !!q, report });
  try {
    ctx.sendToken ||= await accessToken(env, ctx.senders.from.email, { fetchImpl, now, scope: GMAIL_SEND_SCOPE });
    const theirs = header(msg.payload?.headers, 'Message-ID');
    const sent = await send(ctx, { to: [person], ...(asker ? { cc: [asker] } : {}), ...back, subject: /^re:/i.test(a.subject) ? a.subject : `Re: ${a.subject}`, threadId: msg.threadId, inReplyTo: theirs, references: header(msg.payload?.headers, 'References') });
    await setAsk(env.DB, a.id, { msgIds: [...a.msgIds, theirs, sent.messageId].filter(Boolean) });
  } catch (e) {
    console.error('[board-asks] thanks', e.message);
  }
  return { outcome: q ? 'answer' : 'report', detail: `${mdPlain(words).split(/\s+/).filter(Boolean).length} words${added.length ? `, ${added.join(', ')}` : ''}` };
}

// ─── The chair's review ─────────────────────────────────────────────

/** Sending from outside a run (the board page's buttons): who sends and the two Gmail tokens, made when first needed */
async function mailer(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const [senders, rosterNow, settings] = await Promise.all([sendersFor(env.DB), roster(env.DB, { withEmails: true }), readSettings(env.DB)]);
  if (!senders) throw err('No one is set up to send the board’s email', 503);
  const people = await withStaffEmails(env.DB, rosterNow);
  const mode = asksMode(settings);
  if (mode === 'off') throw err('Emails to presenters are off (Board, beside the meeting’s reports)', 409);
  const ctx = { env, fetchImpl, now, senders, people, today: todayEastern(now), test: mode === 'test' };
  ctx.readToken = await accessToken(env, senders.from.email, { fetchImpl, now, scope: GMAIL_READ_SCOPE });
  ctx.sendToken = await accessToken(env, senders.from.email, { fetchImpl, now, scope: GMAIL_SEND_SCOPE });
  return ctx;
}

/** The chair (their seat on People → Board), or one of Board's admins, on a meeting ahead → { m, asker: { slug, name, email } } */
async function chairGate(env, meetingId, { member = null, admin = false, adminEmail = '' } = {}) {
  await ensureAsks(env.DB);
  if (!admin && member?.seat !== 'chair') throw err('Only the board chair reviews the agenda', 403);
  const m = await getMeeting(env.DB, String(meetingId || ''));
  if (!m || m.notBoard || !isDate(m.date) || m.date < todayEastern()) throw err('That meeting isn’t ahead', 404);
  if (member) return { m, asker: { slug: member.slug, name: member.name, email: normEmail(member.email) } };
  const people = await peopleRows(env.DB);
  const first = String(adminEmail).split('@')[0];
  return { m, asker: { slug: '', name: people.find((p) => p.group !== 'board' && String(p.name || '').toLowerCase().startsWith(first))?.name || first, email: normEmail(adminEmail) } };
}

/** The question sent back on a report, in its presenter's conversation */
export function questionEmail({ m, it, person, asker, question, from }) {
  const own = normEmail(asker.email) === normEmail(from.email);
  return body([
    `Hi ${firstName(person.name)},`,
    `${own ? 'I have' : `${firstName(asker.name)} has`} a question about ${yourReport(it)} for ${weekdayOf(m.date)}’s meeting:`,
    `“${question}”`,
    'Reply here with your answer. It goes on the agenda under your report, so the board sees it too.',
    `Thanks,\n${firstName(from.name) || 'SOARD'}`,
  ]);
}

/** The chair's question on an item's report, to who presents it (board members with an email) → { questions } */
export async function askPresenter(env, { meetingId, itemId, question }, w, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { m, asker } = await chairGate(env, meetingId, w);
  const text = String(question || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, NOTE_MAX);
  if (!text) throw err('What’s the question?', 400);
  const it = m.sections.flatMap((s) => s.items).find((x) => x.id === itemId);
  if (!it) throw err('That item isn’t on the agenda any more', 404);
  const ctx = await mailer(env, { fetchImpl, now });
  const everyone = [...ctx.people.board, ...ctx.people.staff];
  const to = presentersOf(it, everyone).map((p) => everyone.find((b) => b.slug === p.slug && b.email)).filter(Boolean);
  if (!to.length) throw err('No one presenting this item has an email, so there’s no one to send it to', 409);
  // Test mode: the emails as they'd go, to the asker alone; nothing kept, so nothing waits for an answer once it's On
  if (ctx.test) {
    for (const person of to) {
      const copy = [...(asker.email && asker.email !== ctx.senders.from.email ? [asker] : []), ...ctx.senders.cc];
      await send(ctx, { to: [person], cc: copy, subject: `${meetingName(m)}: a question about ${yourReport(it)}`, ...questionEmail({ m, it, person, asker, question: text, from: ctx.senders.from }) });
    }
    return { questions: await questionsFor(env.DB, m.id), test: true };
  }
  const id = uid('q_');
  await env.DB.prepare('INSERT INTO board_ask_questions (id, meeting_id, item_id, by_slug, by_name, text, at, to_names) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, m.id, it.id, asker.slug, asker.name, text, nowIso(now), to.map((p) => p.name).join(' & ')).run();
  try {
    const asks = await asksFor(env.DB, m.id);
    for (const person of to) {
      const mail = questionEmail({ m, it, person, asker, question: text, from: ctx.senders.from });
      const copy = [...(asker.email && asker.email !== ctx.senders.from.email ? [asker] : []), ...ctx.senders.cc].filter((c, i, all) => c.email !== person.email && all.findIndex((x) => x.email === c.email) === i);
      const a = asks.find((x) => ['report', 'question'].includes(x.kind) && x.itemId === it.id && x.slug === person.slug && x.thread && !['failed', 'unknown'].includes(x.status));
      if (a) { await replyInThread(ctx, a, { to: [person], cc: copy, ...mail }); continue; }
      // No ask out to them (their report came another way): a conversation of its own, read the way an ask's is
      const subject = `${meetingName(m)}: a question about ${yourReport(it)}`;
      const sent = await send(ctx, { to: [person], cc: copy, subject, ...mail });
      // Its own kind: never counted as a report asked for, and never in the way of the ask itself
      await env.DB.prepare(`INSERT OR REPLACE INTO board_asks (id, kind, meeting_id, item_id, slug, name, email, title, subject, due, status, asked_at, thread, msg_ids, files, updated_at)
        VALUES (?, 'question', ?, ?, ?, ?, ?, ?, ?, '', 'question', ?, ?, ?, '[]', ?)`)
        .bind(uid('ask_'), m.id, it.id, person.slug, person.name, person.email, it.title, subject, nowIso(now), sent.threadId, JSON.stringify([sent.messageId].filter(Boolean)), nowIso(now)).run();
    }
  } catch (e) {
    await env.DB.prepare('DELETE FROM board_ask_questions WHERE id = ?').bind(id).run();
    throw e;
  }
  return { questions: await questionsFor(env.DB, m.id) };
}

/** The chair approves the agenda: kept, and said in the review's conversation so the founders see it → { approvedAt, approvedBy } */
export async function chairApprove(env, { meetingId }, w, { fetchImpl = fetch, now = Date.now(), always = false } = {}) {
  const { m, asker } = await chairGate(env, meetingId, w);
  // Test or off: the note as it'd go (test), nothing kept, so the real review still goes once it's On. Approving in
  // Board itself (always) is real either way: nothing else lets a meeting's agenda reach the board
  if (!always && asksMode(await readSettings(env.DB)) !== 'on') {
    try {
      const ctx = await mailer(env, { fetchImpl, now });
      await send(ctx, { to: [asker.email ? asker : ctx.senders.from], cc: ctx.senders.cc, subject: `Re: Agenda for your review: ${meetingName(m)}, ${shortDay(m.date)}`, ...body([`Thanks, ${firstName(asker.name)}. The agenda for the ${meetingName(m)} on ${longDay(m.date)} is approved.`, `${firstName(ctx.senders.from.name) || 'SOARD'}`]) });
    } catch (e) {
      if (e.status !== 409) console.error('[board-asks] approved (test)', e.message);
    }
    return { approvedAt: nowIso(now), approvedBy: asker.name, test: true };
  }
  const row = askOf(await env.DB.prepare("SELECT * FROM board_asks WHERE kind = 'chair' AND meeting_id = ?").bind(m.id).first());
  if (row?.status === 'approved') return { approvedAt: row.inAt, approvedBy: row.name, already: true };
  if (row) await env.DB.prepare("UPDATE board_asks SET status = 'approved', in_at = ?, name = ?, updated_at = ? WHERE id = ?").bind(nowIso(now), asker.name, nowIso(now), row.id).run();
  else {
    await env.DB.prepare(`INSERT INTO board_asks (id, kind, meeting_id, item_id, slug, name, email, title, status, asked_at, in_at, msg_ids, files, updated_at)
      VALUES (?, 'chair', ?, '', ?, ?, ?, '', 'approved', ?, ?, '[]', '[]', ?)`).bind(uid('ask_'), m.id, asker.slug || 'admin', asker.name, asker.email, nowIso(now), nowIso(now), nowIso(now)).run();
  }
  // The approval is what emails the board the agenda (./_board.js sendApprovedAgenda), or once they've had the sign-in email
  let agenda = '';
  try {
    const r = await sendApprovedAgenda(env, m.id, { now });
    agenda = r?.sent ? 'sent' : r?.waiting ? 'waiting' : '';
  } catch (e) {
    agenda = 'waiting';
    console.error('[board-asks] agenda email', e.message);
  }
  const next = agenda === 'sent' ? ' It’s on its way to the board.' : agenda === 'waiting' ? ' It goes to the board as soon as they’ve had the email on how to sign in.' : '';
  try {
    const ctx = await mailer(env, { fetchImpl, now });
    const words = body([`Thanks, ${firstName(asker.name)}. The agenda for the ${meetingName(m)} on ${longDay(m.date)} is approved.${next}`, `${firstName(ctx.senders.from.name) || 'SOARD'}`]);
    // Everyone the review went to hears who approved it, so nobody else tries to
    const others = [chairOf(ctx.people), ...ctx.senders.cc, ctx.senders.from].filter((p, i, all) => p?.email && normEmail(p.email) !== normEmail(asker.email) && all.findIndex((x) => x?.email === p.email) === i);
    if (row?.thread && asker.email) await replyInThread(ctx, row, { to: [asker], cc: others, ...words });
    else if (others.length) await send(ctx, { to: others, subject: `${asker.name} approved the agenda: ${meetingName(m)}, ${shortDay(m.date)}`, ...body([`${asker.name} approved the agenda for the ${meetingName(m)} on ${longDay(m.date)}.${next}`]) });
  } catch (e) {
    console.error('[board-asks] approved', e.message);
  }
  return { approvedAt: nowIso(now), approvedBy: asker.name, agenda };
}

/** The chair's own note on an item (the chair's and the admins' only); empty takes it off → { notes } */
export async function chairNote(env, { meetingId, itemId, text }, w) {
  const { m, asker } = await chairGate(env, meetingId, w);
  if (!m.sections.some((s) => s.items.some((x) => x.id === itemId))) throw err('That item isn’t on the agenda any more', 404);
  const words = String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, NOTE_MAX);
  if (!words) await env.DB.prepare('DELETE FROM board_chair_notes WHERE meeting_id = ? AND item_id = ?').bind(m.id, itemId).run();
  else await env.DB.prepare('INSERT OR REPLACE INTO board_chair_notes (meeting_id, item_id, text, by_name, at) VALUES (?, ?, ?, ?, ?)').bind(m.id, itemId, words, asker.name, nowIso()).run();
  return { notes: await chairNotesFor(env.DB, m.id) };
}

async function chairNotesFor(DB, meetingId) {
  const rows = (await DB.prepare('SELECT * FROM board_chair_notes WHERE meeting_id = ?').bind(meetingId).all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.item_id, { text: r.text, by: r.by_name || '', at: r.at }]));
}
async function questionsFor(DB, meetingId) {
  const rows = (await DB.prepare('SELECT * FROM board_ask_questions WHERE meeting_id = ? ORDER BY at').bind(meetingId).all()).results || [];
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, text: r.text, by: r.by_name || '', to: r.to_names || '', at: r.at, answeredAt: r.answered_at || '' }));
}

const JUDGE_CHAIR = `You read the board chair's reply to an email that sent them the next board meeting's agenda for review.
Decide its kind:
- "approve": they approve the agenda as it is ("looks good", "approved", "all set", "good to go"), with nothing to change.
- "changes": they ask for any change, addition, removal or question about the agenda or a report.
- "other": anything else (thanks only, scheduling, an out-of-office).
Answer with JSON only.`;
const CHAIR_SCHEMA = { type: 'object', properties: { kind: { type: 'string', enum: ['approve', 'changes', 'other'] } }, required: ['kind'] };

/** The chair's reply to the review: approve, changes (left for the founders, who have it), or something else */
export async function judgeChair(env, words) {
  if (env?.AI?.run) {
    try {
      const out = await Promise.race([
        env.AI.run(MODEL, { messages: [{ role: 'system', content: JUDGE_CHAIR }, { role: 'user', content: words.slice(0, 6000) }], max_tokens: 50, temperature: 0, response_format: { type: 'json_schema', json_schema: CHAIR_SCHEMA } }, viaGateway('board-asks')),
        new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 25000)),
      ]);
      const a = typeof out?.response === 'string' ? parse(out.response, null) : out?.response;
      if (a && ['approve', 'changes', 'other'].includes(a.kind)) return a.kind;
    } catch (e) {
      if (aiCapped(e)) throw e;
      console.error('[board-asks] chair judge', e.message);
    }
  }
  const plain = mdPlain(words).trim();
  // Without the model: only a short yes with nothing asked for ("Looks good, but move…" is a change)
  const yes = /^(looks? (good|great|fine)|approved?|all set|good to go|lgtm|perfect|great)\b/i.test(plain);
  return yes && plain.split(/\s+/).length <= 8 && !/\b(but|except|change|move|add|remove|swap|instead|question)\b|\?/i.test(plain) ? 'approve' : 'changes';
}

/** Replies to the chair's review: an approval is kept; anything else waits in the founders' inboxes, where it already is */
async function readChairReplies(ctx, m, a) {
  const { env, fetchImpl } = ctx;
  const out = { replies: 0, reports: 0 };
  const thread = await gmailCall(ctx.readToken, `/threads/${a.thread}?format=full`, { fetchImpl });
  for (const msg of thread?.messages || []) {
    if (!msg?.id || (msg.labelIds || []).some((l) => l === 'SENT' || l === 'DRAFT') || ours(msg.payload?.headers)) continue;
    if (await env.DB.prepare('SELECT 1 AS x FROM board_ask_mail WHERE gmail_id = ?').bind(msg.id).first()) continue;
    const h = msg.payload?.headers || [];
    const who = senderOf(header(h, 'From'));
    if (isStaffEmail(who.email)) { await mark(env.DB, msg.id, a, who.email, 'staff'); continue; }
    out.replies++;
    if (isAutoReply(h)) { await mark(env.DB, msg.id, a, who.email, 'auto'); continue; }
    if (who.email !== normEmail(a.email) && !sameName(who.name, a.name)) { await mark(env.DB, msg.id, a, who.email, 'stranger', who.name); continue; }
    const words = replyWords(msg.payload);
    const kind = await judgeChair(env, words);
    if (kind === 'approve' && a.status !== 'approved') await env.DB.prepare("UPDATE board_asks SET status = 'approved', in_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(ctx.now), nowIso(ctx.now), a.id).run();
    else if (kind === 'changes' && a.status === 'sent') await setAsk(env.DB, a.id, { status: 'changes' });
    await mark(env.DB, msg.id, a, who.email, kind, mdPlain(words).slice(0, 200));
  }
  return out;
}

/** What the chair's review page shows (the chair and Board's admins): the whole agenda ahead, approved or not, the chair's notes, the questions, each report's ask */
async function reviewFor(env, { meetings, today }) {
  const settings = await getSettings(env.DB);
  const m = nextUp(meetings, today);
  // The same two weeks the asks go out in: the chair sees an agenda ahead before the board does, but not long before
  if (!m || agendaIsDraft(m, settings.template) || daysUntil(today, m.date) > ASK_DAYS) return null;
  const [asks, notes, questions] = await Promise.all([asksFor(env.DB, m.id), chairNotesFor(env.DB, m.id), questionsFor(env.DB, m.id)]);
  const chair = asks.find((a) => a.kind === 'chair');
  return {
    meeting: { ...forBoard({ ...m, shared: true }), shared: !!m.shared },
    sentAt: chair?.status && chair.status !== 'approved' || chair?.thread ? chair.askedAt : '',
    approvedAt: chair?.status === 'approved' ? chair.inAt : '',
    approvedBy: chair?.status === 'approved' ? chair.name : '',
    notes,
    questions,
    reports: perItem(asks, [m]).filter((a) => a.kind === 'report' && !['dropped', 'sending', 'question', 'failed', 'unknown'].includes(a.status))
      .map((a) => ({ itemId: a.itemId, slug: a.slug, name: a.name, due: a.due, status: a.status === 'asked' && a.due && Date.parse(a.due) <= Date.now() ? 'late' : a.status })),
  };
}

// ─── The treasurer's notes on the money's lines ─────────────────────

const NOTE_KEY = /^(act|pos|bud)\|.{1,400}$/s;

/** A note on one line of the statements (or the budget), by who presents the item → that item's notes */
export async function saveLineNote(env, { meetingId, itemId, key, line = '', text = '' }, { member = null, admin = false, adminEmail = '' } = {}) {
  await ensureAsks(env.DB);
  if (!NOTE_KEY.test(String(key || ''))) throw err('Which line?', 400);
  const m = await getMeeting(env.DB, String(meetingId || ''));
  const today = todayEastern();
  if (!m || (!admin && !forBoard(m) && !(isDate(m.date) && m.date >= today && !m.notBoard))) throw err('That meeting isn’t on the board page', 404);
  const it = m.sections.flatMap((s) => s.items).find((x) => x.id === itemId);
  if (!it) throw err('That item isn’t on the agenda any more', 404);
  let by = { slug: '', name: '' };
  if (member) {
    const people = await roster(env.DB);
    if (!presentersOf(it, [...people.board, ...people.staff]).some((p) => p.slug === member.slug)) throw err('Only the person presenting this item can note its lines', 403);
    if (m.minutes === 'approved') throw err('This meeting’s minutes are approved, so its notes stay as they were', 409);
    by = { slug: member.slug, name: member.name };
  } else {
    const people = await peopleRows(env.DB);
    const first = String(adminEmail).split('@')[0];
    by = { slug: '', name: people.find((p) => p.group !== 'board' && String(p.name || '').toLowerCase().startsWith(first))?.name || first };
  }
  const words = String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, NOTE_MAX);
  if (!words) await env.DB.prepare('DELETE FROM board_line_notes WHERE meeting_id = ? AND item_id = ? AND key = ?').bind(m.id, it.id, key).run();
  else {
    await env.DB.prepare('INSERT OR REPLACE INTO board_line_notes (meeting_id, item_id, key, line, text, by_slug, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(m.id, it.id, key, String(line || '').slice(0, 200), words, by.slug, by.name, nowIso()).run();
  }
  return { notes: (await notesFor(env.DB, [m.id]))[m.id]?.[it.id] || [] };
}

/** The notes on these meetings: { meetingId: { itemId: [{ key, line, text, by, at }] } } */
export async function notesFor(DB, ids) {
  await ensureAsks(DB);
  if (!ids.length) return {};
  const rows = (await DB.prepare(`SELECT * FROM board_line_notes WHERE meeting_id IN (${ids.map(() => '?').join(',')}) ORDER BY at`).bind(...ids).all()).results || [];
  const out = {};
  for (const r of rows) ((out[r.meeting_id] ||= {})[r.item_id] ||= []).push({ key: r.key, line: r.line || '', text: r.text, by: r.by_name || '', at: r.at });
  return out;
}

/**
 * What the board page adds for these: the notes on the meetings the viewer sees; a member's own asks (each with
 * when it's due); and a meeting ahead not shared yet that the member presents in, with only their own items, so
 * the ask's link opens their report. An admin's asks are every ask on a meeting ahead.
 */
export async function portalExtras(env, { member = null, admin = false, meetings = [], people = null, today = todayEastern() }) {
  try {
    await ensureAsks(env.DB);
    const everyone = people ? [...people.board, ...people.staff] : await roster(env.DB).then((r) => [...r.board, ...r.staff]);
    const ahead = meetings.filter((m) => isDate(m.date) && m.date >= today && !m.notBoard);
    const { template } = await getSettings(env.DB);
    // Before it's shared: only the two weeks the asks go out in, and only an agenda that isn't a draft
    const presenting = member ? ahead.filter((m) => !m.shared && daysUntil(today, m.date) <= ASK_DAYS && !agendaIsDraft(m, template)).map((m) => {
      const mine = (it) => presentersOf(it, everyone).some((p) => p.slug === member.slug);
      // Their items keep the numbers the whole agenda gives them (3.2), as the board page will show
      const full = forBoard({ ...m, shared: true });
      const num = new Map(full.sections.flatMap((s, si) => s.items.map((it, ii) => [it.id, { n: `${si + 1}.${ii + 1}`, sectionN: si + 1 }])));
      const sections = m.sections.map((s) => ({ ...s, items: s.items.filter(mine).map((it) => ({ ...it, ...(num.get(it.id) || {}) })) })).filter((s) => s.items.length);
      if (!sections.length) return null;
      const seen = forBoard({ ...m, shared: true, sections });
      const docs = new Set(seen.sections.flatMap((s) => s.items.flatMap((it) => it.docs || [])));
      return { ...seen, files: seen.files.filter((f) => docs.has(f.id)), shared: false, presenting: true };
    }).filter(Boolean) : [];
    const visible = admin ? meetings.map((m) => m.id) : [...meetings.filter((m) => m.shared).map((m) => m.id), ...presenting.map((m) => m.id)];
    const notes = await notesFor(env.DB, visible);
    // A meeting not shared yet: only the notes on their own items
    for (const m of presenting) {
      const own = new Set(m.sections.flatMap((s) => s.items.map((it) => it.id)));
      const kept = Object.fromEntries(Object.entries(notes[m.id] || {}).filter(([itemId]) => own.has(itemId)));
      if (Object.keys(kept).length) notes[m.id] = kept; else delete notes[m.id];
    }
    const rows = perItem(((await env.DB.prepare("SELECT * FROM board_asks WHERE kind IN ('report', 'list') AND status NOT IN ('dropped', 'sending', 'question', 'failed', 'unknown')").all()).results || []).map(askOf)
      .filter((a) => ahead.some((m) => m.id === a.meetingId) && (admin || a.slug === member?.slug)), ahead);
    // The chair's review page: the chair (by seat) and Board's admins
    const on = asksMode(await readSettings(env.DB)) === 'on';
    const review = admin || (member?.seat === 'chair' && on) ? await reviewFor(env, { meetings, today }) : null;
    return {
      review,
      lineNotes: notes,
      myAsks: rows.map((a) => ({ meetingId: a.meetingId, itemId: a.itemId, due: a.due, status: a.status === 'asked' && Date.parse(a.due) <= Date.now() ? 'late' : a.status === 'asked' ? 'asked' : a.status, title: a.title, ...(admin ? { name: a.name } : {}) })),
      presenting,
    };
  } catch (e) {
    console.error('[board-asks] portal', e.message);
    return { review: null, lineNotes: {}, myAsks: [], presenting: [] };
  }
}

/** What Board and Automations show: the next meeting's asks, the chair's review, and the last run */
export async function asksStatus(DB) {
  await ensureAsks(DB);
  const state = await readState(DB, KEY);
  const meetings = await listMeetings(DB);
  const m = nextUp(meetings, todayEastern());
  const asks = m ? await asksFor(DB, m.id) : [];
  return {
    at: state.at || '', ok: state.ok || '', error: state.error || '', errorAt: state.errorAt || '', off: !!state.off,
    meeting: m ? { id: m.id, name: meetingName(m), date: m.date } : null,
    asks: asks.map(({ msgIds, thread, files, ...a }) => a),
  };
}

/** Automations' live status: counts, times and on/off only (no names or addresses) */
export async function asksFacts(DB) {
  const s = await asksStatus(DB);
  const reports = perItem(s.asks, s.meeting ? [await getMeeting(DB, s.meeting.id)].filter(Boolean) : []).filter((a) => a.kind === 'report' && ['asked', 'late', 'in'].includes(a.status));
  const chair = s.asks.find((a) => a.kind === 'chair');
  // An email Gmail refused, or one that may not have gone: never sent again by itself, so someone should look
  const failed = s.asks.filter((a) => ['failed', 'unknown'].includes(a.status)).length;
  return {
    at: s.at, ok: s.ok, error: s.error, errorAt: s.errorAt, off: s.off,
    meeting: s.meeting ? { name: s.meeting.name, date: s.meeting.date } : null,
    asked: reports.length,
    in: reports.filter((a) => a.status === 'in').length,
    late: reports.filter((a) => a.status === 'late' || (a.status === 'asked' && Date.parse(a.due) <= Date.now())).length,
    chair: chair ? chair.status : '',
    failed,
  };
}
