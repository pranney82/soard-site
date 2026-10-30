/**
 * board-shared.js — the rules for board meetings, shared by the admin's
 * Board area (./board-admin.js), the board's own page (./board/portal.js)
 * and the server (functions/api/_board.js).
 *
 * A meeting is one record (D1 board_meetings, never site_config or the
 * public repo):
 *   id, date (YYYY-MM-DD), start/end (HH:MM), title (optional; the quarter
 *   names it otherwise), location, address, video (a join link)
 *   shared       the board can see it on their page
 *   minutes      'draft' | 'approved', approvedOn (YYYY-MM-DD)
 *   attendance   [{ key, slug?, name, org, kind: board|staff|guest, status, rsvp }]
 *   sections     [{ id, title, items: [{ id, title, presenter (who presents, as
 *                  written: "Traci Lee & Holly Ranney"), who (their People slugs,
 *                  up to 3, so their faces show), notes, staffNote (Peter and
 *                  Holly only), confidential (never emailed), docs (this
 *                  meeting's file ids that go with the item, in order),
 *                  live: '' | projects | reveals | events | cash | meetings }] }]
 *   motions      [{ id, text, by, second, result: passed|failed|tabled }]
 *   actions      [{ id, text, owner (a People slug), ownerName, due, done, doneOn }]
 *   files        [{ id, name, type, size, kind, staffOnly, at }]
 *   snapshot     the numbers locked in for the packet (see _board.js takeSnapshot)
 *   calendar     the calendar event it follows (functions/api/_board-calendar.js):
 *                { uid, others (the same meeting on another admin's calendar), title,
 *                from, link, gone, place, call, said (its place as written),
 *                replies: { slug: accepted | declined | tentative | invited }, eventId, organizer,
 *                callFrom (where its video link is: meet | conference | place | notes) }, or null
 *   invite       the calendar invite Board sent or took over (functions/api/_board-invite.js):
 *                { eventId, organizer, sentAt, updatedAt, meet, guests, transcript, error,
 *                place, when, notes (a fingerprint of the agenda it carries), emails,
 *                replies (to Board's own invite, like calendar's) }, or null
 *   agendaFrom   where the agenda came from: { kind: template (SOARD's usual outline) |
 *                last-meeting (drafted from the last agenda) | email (a past meeting's emailed
 *                agenda, name: its file) | drive (read from a past meeting's minutes in Google
 *                Drive) | typed (written here), name, at }, or null (as typed). Agendas for
 *                meetings ahead are written in Board
 *   fromMeet     who Google Meet saw join, after the meeting (functions/api/_board-attendance.js):
 *                { at, status: ok | none | needs-setup | error, error, joined: [{ name, slug, minutes }] }, or null
 *   packetSentAt, packetSentTo, minutesSentAt
 * Notes are plain text: a line starting with "- " is a point, two spaces
 * deeper for each level under it.
 */

export const ATTEND = [
  { id: 'present', label: 'Present' },
  { id: 'remote', label: 'By video' },
  { id: 'absent', label: 'Absent' },
  { id: 'excused', label: 'Excused' },
];
export const RSVP = [
  { id: 'yes', label: 'Coming', ask: 'I’ll be there' },
  { id: 'remote', label: 'By video', ask: 'I’ll join by video' },
  { id: 'no', label: 'Can’t come', ask: 'I can’t make it' },
];
/** A member's answer in words: their own here, else how they answered the calendar invite */
export function answerOf(rsvp, invite) {
  if (rsvp) return RSVP.find((r) => r.id === rsvp)?.label || '';
  return { accepted: 'Coming', declined: 'Can’t come', tentative: 'Maybe' }[invite] || '';
}
const REPLIES = ['accepted', 'declined', 'tentative', 'invited'];
function cleanReplies(raw) {
  return Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {})
    .filter(([k, v]) => /^[a-z0-9-]{1,80}$/.test(k) && REPLIES.includes(v)).slice(0, LIMITS.people));
}
/** Each board member's reply to the meeting's calendar invite, by slug: the organizer's own event's, else Board's */
export const repliesOf = (m) => ({ ...(m?.invite?.replies || {}), ...(m?.calendar?.replies || {}) });
/** "Balance-sheet_financials v2.pdf" → "Balance sheet financials v2" (the file keeps its own name for saving) */
export function fileTitle(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : 'File';
}
export const RESULTS = [
  { id: 'passed', label: 'Passed' },
  { id: 'failed', label: 'Did not pass' },
  { id: 'tabled', label: 'Tabled' },
];
export const FILE_KINDS = [
  { id: 'financials', label: 'Financial statements' },
  { id: 'packet', label: 'Packet' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'minutes', label: 'Minutes' },
  { id: 'signed', label: 'Signed minutes' },
  { id: 'other', label: 'Other' },
];
export const DOC_KINDS = [
  { id: 'governance', label: 'Bylaws and governance' },
  { id: 'policy', label: 'Policies' },
  { id: 'financial', label: 'Budgets and audits' },
  { id: 'plan', label: 'Plans and reports' },
  { id: 'other', label: 'Other' },
];
/** Agenda items whose facts come from the site's own data */
export const LIVE = [
  { id: 'projects', label: 'Makeovers in progress (JobTread)' },
  { id: 'reveals', label: 'Upcoming reveals (JobTread)' },
  { id: 'events', label: 'Upcoming events' },
  { id: 'cash', label: 'Money: the bank balances and the finance summary' },
  { id: 'meetings', label: 'Next board meetings' },
];
export const LIMITS = { title: 200, text: 300, notes: 20000, items: 80, sections: 20, people: 80, rows: 100 };

/** The agenda a new meeting starts from, until Settings saves another one */
export const DEFAULT_TEMPLATE = [
  { title: 'Call to order', items: [{ title: 'Roll call' }, { title: 'Welcome and introductions' }, { title: 'Personal Best, Business Best, Sunshine Bragging Rights' }] },
  { title: 'Approve meeting minutes', items: [{ title: 'Minutes of the last meeting', live: 'minutes' }] },
  { title: 'Committee reports', items: [
    { title: 'Governance' }, { title: 'Financial', live: 'cash' }, { title: 'Qualification Committee' },
    { title: 'Events and Marketing' }, { title: 'Project updates and upcoming reveals', live: 'projects' },
    { title: 'Mission Advancement' }, { title: 'Store update' },
  ] },
  { title: 'New business', items: [] },
  { title: 'Upcoming events', items: [{ title: 'Events', live: 'events' }, { title: 'Board meetings', live: 'meetings' }, { title: 'Upcoming reveals', live: 'reveals' }] },
  { title: 'Open forum and announcements', items: [] },
];

// ─── Small helpers ──────────────────────────────────────────────────

/** A short random id ("m_3k9x2q7d") */
export function uid(prefix = '') {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return prefix + [...bytes].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}
const str = (v, max = LIMITS.text) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const one = (v, max = LIMITS.text) => str(v, max).replace(/\s+/g, ' ');
const pick = (v, list, fallback = '') => (list.some((x) => x.id === v) ? v : fallback);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isDate = (s) => DATE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const date = (v) => (isDate(v) ? v : '');
const time = (v) => (TIME.test(String(v || '')) ? v : '');
const ID = /^[a-z0-9_]{3,40}$/i;
const idOr = (v, prefix) => (ID.test(String(v || '')) ? String(v) : uid(prefix));
const bool = (v) => v === true;
const httpUrl = (v) => { const s = one(v, 500); return /^https:\/\/[^\s]+$/i.test(s) ? s : ''; };

/** "Q2 2026" for a meeting on April 30, 2026 */
export function quarterOf(d) {
  if (!isDate(d)) return '';
  const [y, m] = d.split('-').map(Number);
  return `Q${Math.ceil(m / 3)} ${y}`;
}
/**
 * The meeting's name: one typed in Board, else its quarter ("Q2 2026 Board Meeting"). A calendar invite's own words
 * never name it ("SOARD Board Meeting", "SOARD Staff end of Board Meeting"), only the quarter it says: "Q3 SOARD Board
 * Meeting (Reschedule)" on November 3, 2022 is the Q3 2022 meeting. That quarter is the one nearest the date, a late
 * one when it's as near either way (a Q4 meeting held in January is the year before's)
 */
export function meetingName(m) {
  const typed = one(m?.title);
  if (typed && typed !== one(m?.calendar?.title)) return typed;
  if (!isDate(m?.date)) return 'Board meeting';
  const [y, mo] = m.date.split('-').map(Number);
  const held = Math.ceil(mo / 3);
  const said = Number(/\bQ([1-4])\b/i.exec(one(m?.calendar?.title))?.[1]) || held;
  return `Q${said} ${y - (said - held >= 2 ? 1 : 0) + (held - said > 2 ? 1 : 0)} Board Meeting`;
}
/** "Thursday, April 30, 2026" */
export const longDate = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
/** "Apr 30, 2026" */
export const shortDate = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
/** "8:00 AM" */
export function clock(t) {
  if (!TIME.test(String(t || ''))) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
/** "8:00 to 10:00 AM", "5:00 PM" */
export function timeRange(start, end) {
  const a = clock(start); const b = clock(end);
  if (!a) return '';
  if (!b) return a;
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}
export const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '');
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
/** Today in Atlanta (YYYY-MM-DD) */
export const todayEastern = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

// ─── A clean meeting ────────────────────────────────────────────────

function cleanItem(raw) {
  const live = ['projects', 'reveals', 'events', 'cash', 'meetings', 'minutes'].includes(raw?.live) ? raw.live : '';
  return {
    id: idOr(raw?.id, 'i_'),
    title: one(raw?.title, LIMITS.title),
    presenter: one(raw?.presenter),
    who: [...new Set((Array.isArray(raw?.who) ? raw.who : []).filter((s) => /^[a-z0-9-]{1,80}$/.test(String(s))))].slice(0, 3),
    notes: str(raw?.notes, LIMITS.notes),
    staffNote: str(raw?.staffNote, LIMITS.notes),
    confidential: bool(raw?.confidential),
    live,
    about: ID.test(String(raw?.about || '')) ? raw.about : '',
    docs: [...new Set((Array.isArray(raw?.docs) ? raw.docs : []).filter((id) => ID.test(String(id))))].slice(0, 20),
  };
}
function cleanPerson(raw) {
  const kind = ['board', 'staff', 'guest'].includes(raw?.kind) ? raw.kind : 'guest';
  const slug = /^[a-z0-9-]{1,80}$/.test(String(raw?.slug || '')) ? raw.slug : '';
  const name = one(raw?.name, 120);
  return {
    key: slug || `${kind}:${name.toLowerCase()}`,
    ...(slug ? { slug } : {}),
    name, org: one(raw?.org, 120), kind,
    status: pick(raw?.status, ATTEND),
    rsvp: pick(raw?.rsvp, RSVP),
  };
}

/** A meeting as the rules allow it: every field present, typed and within its limit */
export function cleanMeeting(raw = {}) {
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, LIMITS.sections).map((s) => ({
    id: idOr(s?.id, 's_'),
    title: one(s?.title, LIMITS.title),
    // The time it's given, in minutes; 0 shares out the meeting's time by itself (sectionPlan)
    minutes: Number(s?.minutes) > 0 ? Math.min(600, Math.round(Number(s.minutes))) : 0,
    items: (Array.isArray(s?.items) ? s.items : []).slice(0, LIMITS.items).map(cleanItem),
  }));
  const seen = new Set();
  const attendance = (Array.isArray(raw.attendance) ? raw.attendance : []).slice(0, LIMITS.people).map(cleanPerson)
    .filter((p) => p.name && !seen.has(p.key) && seen.add(p.key));
  return {
    id: idOr(raw.id, 'm_'),
    date: date(raw.date),
    start: time(raw.start),
    end: time(raw.end),
    // A name typed in Board; the calendar invite's own words aren't one (meetingName)
    title: one(raw.title, LIMITS.title) === one(raw.calendar?.title, 200) ? '' : one(raw.title, LIMITS.title),
    location: one(raw.location, 200),
    address: one(raw.address, 300),
    video: httpUrl(raw.video),
    shared: bool(raw.shared),
    // The calendar brought it in, but it isn't a board meeting (a coffee, a reminder, another organization's
    // board): off the board page until someone shares it (functions/api/_board-calendar.js)
    notBoard: bool(raw.notBoard),
    // A practice meeting the admins run alone (simulated members): its own table, never the board's (functions/api/_board.js)
    practice: bool(raw.practice),
    // The meeting as it's held, from the chair's screen: started, ended, the item being discussed, the vote that's open
    live: cleanLive(raw.live),
    minutes: raw.minutes === 'approved' ? 'approved' : 'draft',
    approvedOn: raw.minutes === 'approved' ? date(raw.approvedOn) : '',
    attendance,
    sections,
    motions: (Array.isArray(raw.motions) ? raw.motions : []).slice(0, LIMITS.rows).map((x) => ({
      id: idOr(x?.id, 'v_'), text: str(x?.text, 1000), by: one(x?.by, 120), second: one(x?.second, 120), result: pick(x?.result, RESULTS, 'passed'),
      // The board page's vote, as the chair closed it (null for a motion voted by voice)
      tally: cleanTally(x?.tally),
    })).filter((x) => x.text),
    actions: (Array.isArray(raw.actions) ? raw.actions : []).slice(0, LIMITS.rows).map((x) => ({
      id: idOr(x?.id, 'a_'), text: str(x?.text, 1000),
      owner: /^[a-z0-9-]{1,80}$/.test(String(x?.owner || '')) ? x.owner : '', ownerName: one(x?.ownerName, 120),
      due: date(x?.due), done: bool(x?.done), doneOn: bool(x?.done) ? date(x?.doneOn) : '',
    })).filter((x) => x.text),
    files: (Array.isArray(raw.files) ? raw.files : []).slice(0, LIMITS.rows).map((f) => ({
      id: ID.test(String(f?.id || '')) ? f.id : '', name: one(f?.name, 200), type: one(f?.type, 100), size: Number(f?.size) > 0 ? Math.round(f.size) : 0,
      kind: pick(f?.kind, FILE_KINDS, 'other'), staffOnly: bool(f?.staffOnly), at: one(f?.at, 40),
    })).filter((f) => f.id && f.name),
    snapshot: raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : null,
    calendar: raw.calendar && typeof raw.calendar === 'object' && one(raw.calendar.uid, 400) ? {
      uid: one(raw.calendar.uid, 400), title: one(raw.calendar.title, 200), from: one(raw.calendar.from, 200),
      others: (Array.isArray(raw.calendar.others) ? raw.calendar.others : []).map((u) => one(u, 400)).filter(Boolean).slice(0, 5),
      link: /^https:\/\//.test(String(raw.calendar.link || '')) ? one(raw.calendar.link, 1000) : '',
      gone: bool(raw.calendar.gone), place: bool(raw.calendar.place), call: bool(raw.calendar.call), said: one(raw.calendar.said, 200),
      replies: cleanReplies(raw.calendar.replies),
      eventId: /^[\w-]{1,1024}$/.test(String(raw.calendar.eventId || '')) ? raw.calendar.eventId : '', organizer: one(raw.calendar.organizer, 200),
      callFrom: ['meet', 'conference', 'place', 'notes'].includes(raw.calendar.callFrom) ? raw.calendar.callFrom : '',
    } : null,
    packetSentAt: one(raw.packetSentAt, 40),
    packetSentTo: Number(raw.packetSentTo) > 0 ? Math.round(raw.packetSentTo) : 0,
    minutesSentAt: one(raw.minutesSentAt, 40),
    // The calendar invite Board sent or took over (functions/api/_board-invite.js): server-set
    invite: raw.invite && typeof raw.invite === 'object' && one(raw.invite.eventId, 1024) ? {
      eventId: one(raw.invite.eventId, 1024), organizer: one(raw.invite.organizer, 200), sentAt: one(raw.invite.sentAt, 40), updatedAt: one(raw.invite.updatedAt, 40),
      meet: /^https:\/\/meet\.google\.com\//.test(String(raw.invite.meet || '')) ? one(raw.invite.meet, 300) : '', guests: Number(raw.invite.guests) > 0 ? Math.round(raw.invite.guests) : 0,
      transcript: ['on', 'needs-setup', 'error', ''].includes(raw.invite.transcript) ? raw.invite.transcript : '', error: one(raw.invite.error, 300),
      place: one(raw.invite.place, 400), when: one(raw.invite.when, 60), notes: one(raw.invite.notes, 20), emails: (Array.isArray(raw.invite.emails) ? raw.invite.emails : []).map((e) => one(e, 200)).filter(Boolean).slice(0, 100),
      replies: cleanReplies(raw.invite.replies),
    } : null,
    agendaFrom: raw.agendaFrom && typeof raw.agendaFrom === 'object' && AGENDA_FROM.includes(raw.agendaFrom.kind)
      ? { kind: raw.agendaFrom.kind, name: one(raw.agendaFrom.name, 200), at: one(raw.agendaFrom.at, 40), ...(Number(raw.agendaFrom.v) > 0 ? { v: Math.round(Number(raw.agendaFrom.v)) } : {}) } : null,
    // The minutes file that filled in who was there, the notes, the motions and the action items (functions/api/_board-minutes.js)
    minutesFrom: raw.minutesFrom && typeof raw.minutesFrom === 'object' && one(raw.minutesFrom.name, 200) ? { name: one(raw.minutesFrom.name, 200), at: one(raw.minutesFrom.at, 40), ai: bool(raw.minutesFrom.ai), tries: Math.min(9, Math.max(0, Math.round(Number(raw.minutesFrom.tries) || 0))) } : null,
    // Who Google Meet saw join (functions/api/_board-attendance.js): server-set
    fromMeet: raw.fromMeet && typeof raw.fromMeet === 'object' && one(raw.fromMeet.at, 40) ? {
      at: one(raw.fromMeet.at, 40), status: ['ok', 'none', 'needs-setup', 'error'].includes(raw.fromMeet.status) ? raw.fromMeet.status : 'error', error: one(raw.fromMeet.error, 300),
      joined: (Array.isArray(raw.fromMeet.joined) ? raw.fromMeet.joined : []).slice(0, LIMITS.people).map((j) => ({
        name: one(j?.name, 120), slug: /^[a-z0-9-]{1,80}$/.test(String(j?.slug || '')) ? j.slug : '', minutes: Number(j?.minutes) > 0 ? Math.round(j.minutes) : 0,
      })).filter((j) => j.name),
    } : null,
    createdAt: one(raw.createdAt, 40),
    updatedAt: one(raw.updatedAt, 40),
    updatedBy: one(raw.updatedBy, 200),
  };
}
const isoAt = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(String(v || '')) ? String(v) : '');
const count = (v) => (Number(v) >= 0 ? Math.min(999, Math.round(Number(v))) : 0);
/**
 * { startedAt, endedAt, itemId, fileId, page, screen, vote: null | { motionId, openedAt } }: empty strings until the
 * chair starts it. fileId and page are the document on the screen (page from 0) while the item is discussed;
 * screen 'end' is the closing slide after the last item.
 */
export function cleanLive(raw) {
  const l = raw && typeof raw === 'object' ? raw : {};
  const vote = l.vote && typeof l.vote === 'object' && ID.test(String(l.vote.motionId || '')) ? { motionId: String(l.vote.motionId), openedAt: isoAt(l.vote.openedAt) } : null;
  const itemId = ID.test(String(l.itemId || '')) ? String(l.itemId) : '';
  const fileId = itemId && ID.test(String(l.fileId || '')) ? String(l.fileId) : '';
  return {
    startedAt: isoAt(l.startedAt), endedAt: isoAt(l.endedAt), itemId, fileId,
    page: fileId && Number(l.page) > 0 ? Math.min(999, Math.floor(Number(l.page))) : 0,
    screen: ['end', 'since', 'section'].includes(l.screen) ? l.screen : '',
    // The part whose card is on the screen (screen 'section')
    sectionId: l.screen === 'section' && ID.test(String(l.sectionId || '')) ? String(l.sectionId) : '',
    vote,
    // When the part of the agenda on now began (its timer), and who has the floor when it isn't the item's presenter
    sectionAt: itemId || l.screen === 'section' ? isoAt(l.sectionAt) : '',
    floor: itemId && /^[a-z0-9-]{1,80}$/.test(String(l.floor || '')) ? String(l.floor) : '',
  };
}
function cleanTally(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { for: count(raw.for), against: count(raw.against), abstain: count(raw.abstain), of: count(raw.of), at: isoAt(raw.at) };
}
/** Started from the chair's screen and not ended: the meeting is being held now */
export const isLive = (m) => !!m?.live?.startedAt && !m.live.endedAt;
/** The agenda's items in order, numbered the way the board page and the chair's screen show them: [{ id, title, label: '3.2', section, si, ii }] */
export function agendaItems(m) {
  return (m?.sections || []).flatMap((s, si) => s.items.map((it, ii) => ({ id: it.id, title: it.title || s.title || 'Item', presenter: it.presenter, label: `${si + 1}.${ii + 1}`, section: s.title, si, ii })));
}
/** "08:00" → 480; null when it isn't a time */
const dayMinutes = (t) => (TIME.test(String(t || '')) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
const asTime = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
/**
 * The meeting's time shared out among its parts, the way a run of show reads: a part given its minutes keeps them,
 * the rest of the meeting (its start to its end, two hours when it has no end) is shared by how much is in each
 * (a part with live facts counts one more; one with no items, like open forum, half), in fives.
 * → Map(section id → { minutes, start: 'HH:MM' | '', end, auto })
 */
export function sectionPlan(m) {
  const sections = m?.sections || [];
  const s0 = dayMinutes(m?.start);
  const e0 = dayMinutes(m?.end);
  const total = s0 != null && e0 != null && e0 > s0 ? e0 - s0 : 120;
  const weight = (sec) => (sec.items.length ? sec.items.length + (sec.items.some((it) => it.live && it.live !== 'minutes') ? 1 : 0) : 0.5);
  const fixed = sections.reduce((n, sec) => n + (sec.minutes || 0), 0);
  const auto = sections.filter((sec) => !sec.minutes);
  const sum = auto.reduce((n, sec) => n + weight(sec), 0) || 1;
  const left = Math.max(auto.length * 5, total - fixed);
  const mins = new Map(sections.map((sec) => [sec.id, sec.minutes || Math.max(5, Math.round((left * weight(sec)) / sum / 5) * 5)]));
  // Rounding in fives can leave the parts a few minutes off the meeting's length: the biggest shared part takes it up
  const off = total - [...mins.values()].reduce((a, b) => a + b, 0);
  const big = auto.slice().sort((a, b) => mins.get(b.id) - mins.get(a.id))[0];
  if (big && off && Math.abs(off) <= 20 && mins.get(big.id) + off >= 5) mins.set(big.id, mins.get(big.id) + off);
  const out = new Map();
  let at = s0;
  for (const sec of sections) {
    const n = mins.get(sec.id);
    out.set(sec.id, { minutes: n, start: at != null ? asTime(at) : '', end: at != null ? asTime(at + n) : '', auto: !sec.minutes });
    if (at != null) at += n;
  }
  return out;
}
/** The part of the agenda an item is in (its id), or '' */
export const sectionOf = (m, itemId) => (m?.sections || []).find((sec) => sec.items.some((it) => it.id === itemId))?.id || '';
/** A part's timer: { left: seconds (negative once it's over), over: boolean, of: seconds } from when it began, or null */
export function sectionClock(plan, sectionId, sectionAt, now = Date.now()) {
  const p = plan?.get(sectionId);
  const t = Date.parse(sectionAt || '');
  if (!p || !Number.isFinite(t)) return null;
  const of = p.minutes * 60;
  const left = Math.round(of - (now - t) / 1000);
  return { left, over: left < 0, of };
}
/** 754 → "12:34"; −95 → "1:35" */
export const clockText = (sec) => { const a = Math.abs(sec); return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`; };

/** A closed vote in words: "Passed 8–1, 1 abstained" ('' when it wasn't voted on the board page) */
export function tallyText(motion) {
  const t = motion?.tally;
  if (!t) return '';
  const said = RESULTS.find((r) => r.id === motion.result)?.label || 'Recorded';
  return `${said} ${t.for}–${t.against}${t.abstain ? `, ${t.abstain} abstained` : ''}`;
}
/** Where an agenda can come from (cleanMeeting's agendaFrom) */
export const AGENDA_FROM = ['template', 'last-meeting', 'email', 'drive', 'typed'];
/**
 * Which agenda reader filled an agenda from a file (agendaFrom.v; none is 1).
 * 2: indents and bullets, Google Docs read from their HTML (nested points no
 * longer come out as dozens of items). An older reading of Drive or email is
 * read again once, while nobody has changed it.
 */
export const AGENDA_READER = 2;
export const readAgain = (m) => ['drive', 'email'].includes(m?.agendaFrom?.kind) && (m.agendaFrom.v || 1) < AGENDA_READER;
/** Sections that are the usual outline, untouched: its section and item names, no presenters or notes */
const isOutline = (sections, template = DEFAULT_TEMPLATE) => sections.length === template.length && sections.every((s, i) => s.title === template[i].title
  && s.items.length === (template[i].items || []).length
  && s.items.every((it, j) => (it.live === 'minutes' || it.title === template[i].items[j].title) && !it.presenter && !it.notes && !it.staffNote && !it.docs?.length));
/**
 * An agenda nobody has written: SOARD's usual outline or one drafted from
 * the last meeting (the drafts follow a newer last meeting until someone
 * writes in it or uses it). A meeting from before agendaFrom counts by its look.
 */
export const agendaIsDraft = (m, template = DEFAULT_TEMPLATE) => !m?.sections?.some((s) => s.items.length)
  || ['template', 'last-meeting'].includes(m?.agendaFrom?.kind)
  || (!m?.agendaFrom && (isOutline(m.sections, template) || isOutline(m.sections)));
/** "Minutes of the Q3 Board Meeting (Aug 6)": the item that asks the board to approve the last minutes */
const minutesItemTitle = (prev) => `Minutes of the ${meetingName(prev)} (${shortDate(prev.date)})`;
/**
 * Which live facts an item shows, by what it's called, when nothing says: the makeovers ("Project updates and
 * upcoming reveals", "Projects update", "Makeovers"), the money ("Financial", "Treasurer's report"), events,
 * the next board meetings, the reveals. '' for anything else
 */
export function liveOfTitle(title, section = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(projects?|makeovers?|builds?)\b/.test(t)) return 'projects';
  if (/\b(financ\w*|treasur\w*|cash|budget)\b/.test(t) && !/committee report/.test(t)) return 'cash';
  if (/\b(board meetings?|meeting dates|next meetings?)\b/.test(t)) return 'meetings';
  if (/\breveals?\b/.test(t)) return 'reveals';
  if (/^events?$|\bupcoming events?\b/.test(t) || (/^events?\b/.test(t) && /upcoming/i.test(section))) return 'events';
  return '';
}
/**
 * An item about the people in the room, which the screen shows as the board's faces: the roll call (everyone on the
 * list, filling in as they check in, with the quorum) and the go-arounds after it (introductions, each one's news),
 * which show the ones here. → 'roll' | 'room' | ''
 */
export function facesOf(it) {
  if (it?.live && it.live !== 'minutes') return '';
  const t = String(it?.title || '');
  if (/\b(roll call|attendance|quorum)\b/i.test(t)) return 'roll';
  if (/\b(introductions?|welcome|personal best|bragging|around the (room|table))\b/i.test(t)) return 'room';
  return '';
}
/** The draft reader's version (agendaFrom.v on a last-meeting draft): a draft an older one made is drafted again */
export const DRAFTER = 2;
/**
 * The next agenda, drafted from the last one: its sections and items in
 * order, who presents each, the live numbers where the usual outline has
 * them (or the item's name says, see liveOfTitle), its minutes up for
 * approval: the item in an "approve the minutes" section, whatever it was
 * called last time. New business starts empty and nothing anyone wrote
 * under an item comes along.
 */
export function draftAgenda(prev, { template = DEFAULT_TEMPLATE } = {}) {
  const liveOf = new Map([...DEFAULT_TEMPLATE, ...template].flatMap((s) => (s.items || []).filter((it) => it.live && it.live !== 'minutes').map((it) => [it.title.toLowerCase(), it.live])));
  return prev.sections.map((s) => {
    const approving = /minutes/i.test(s.title) && /approv|consent|minutes/i.test(s.title);
    let minutesDone = false;
    return {
      id: uid('s_'), title: s.title,
      items: /\bnew business\b/i.test(s.title) ? [] : s.items.map((it) => {
        // One item asks to approve the last minutes: the one called that, else the first in a minutes section
        const minutes = !minutesDone && (it.live === 'minutes' || (/minutes/i.test(it.title) && /minutes|approv|consent/i.test(`${s.title} ${it.title}`)) || (approving && !it.docs?.length));
        if (minutes) minutesDone = true;
        return {
          ...cleanItem({
            title: minutes ? minutesItemTitle(prev) : it.title, presenter: minutes ? '' : it.presenter, who: minutes ? [] : it.who, confidential: it.confidential,
            live: minutes ? 'minutes' : (it.live && it.live !== 'minutes' ? it.live : '') || liveOf.get(it.title.toLowerCase()) || liveOfTitle(it.title, s.title), about: minutes ? prev.id : '',
          }),
          id: uid('i_'),
        };
      }).filter((it, i, all) => !(it.live === 'minutes' && all.findIndex((x) => x.live === 'minutes') !== i)),
    };
  });
}
/** The last meeting before this one with an agenda someone wrote or emailed: the one the next draft follows */
export const draftSource = (m, meetings, template = DEFAULT_TEMPLATE) => [...(meetings || [])]
  .filter((x) => x.id !== m.id && isDate(x.date) && x.date < m.date && x.sections.some((s) => s.items.length) && !agendaIsDraft(x, template))
  .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
/** What a draft from that meeting is called (agendaFrom.name), so a newer source is noticed */
export const draftName = (prev) => `${meetingName(prev)} (${shortDate(prev.date)})`;

/**
 * What a board member sees: only shared meetings, never Peter and Holly's
 * own notes or a staff-only file. Null for a meeting not shared yet.
 */
export function forBoard(m) {
  if (!m?.shared) return null;
  const seen = new Set(m.files.filter((f) => !f.staffOnly).map((f) => f.id));
  return {
    ...m,
    sections: m.sections.map((s) => ({ ...s, items: s.items.map(({ staffNote, ...it }) => ({ ...it, docs: (it.docs || []).filter((id) => seen.has(id)) })) })),
    files: m.files.filter((f) => !f.staffOnly),
    // Named here, where the quarter its calendar invite says is known
    title: meetingName(m),
    calendar: undefined,
    invite: m.invite ? { meet: m.invite.meet } : null,
    agendaFrom: undefined,
    fromMeet: undefined,
    updatedBy: undefined,
  };
}

/** For an email (which can be forwarded): agenda headings only, a confidential item by its section alone */
export function emailOutline(m) {
  return m.sections.filter((s) => s.title).map((s) => ({
    title: s.title,
    items: s.items.filter((it) => it.title).map((it) => (it.confidential ? 'A board-only item (on the board page)' : `${it.title}${it.presenter ? ` (${it.presenter})` : ''}`)),
  }));
}

// ─── Who presents, and the documents that go with each item ────────

/** One name as written ("Thomas", "Holly Ranney") → that person, when only one person fits */
function personNamed(name, people) {
  const k = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!k) return null;
  const full = people.filter((p) => String(p.name || '').toLowerCase() === k);
  if (full.length === 1) return full[0];
  const first = people.filter((p) => String(p.name || '').toLowerCase().split(' ')[0] === k);
  return first.length === 1 ? first[0] : null;
}
/**
 * Who presents an item, as people: those picked (who), else the names as written ("Traci & Holly") matched to
 * People where only one person fits. → [{ slug?, name, photo?, title? }]
 */
export function presentersOf(it, people = []) {
  const picked = (it?.who || []).map((s) => people.find((p) => p.slug === s)).filter(Boolean);
  if (picked.length) return picked;
  return String(it?.presenter || '').split(/\s*(?:&|\+|,|\/|\band\b)\s*/i).map((n) => n.trim()).filter(Boolean)
    .map((n) => personNamed(n, people) || { name: n });
}
/** "Traci Lee & Holly Ranney", "Ann, Bo & Cy" */
export const namesText = (names) => (names.length > 2 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names.join(' & '));

/** The meeting whose minutes an item asks the board to approve, and its minutes (the PDF before the Word copy) */
export function minutesFileOf(prev) {
  const list = (prev?.files || []).filter((f) => f.kind === 'minutes' && !f.staffOnly);
  return list.find((f) => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) || list[0] || null;
}
/** An item's files, in order: its documents, and for "approve the minutes" the last meeting's minutes (from `meetings`) */
export function itemFiles(m, it, meetings = []) {
  const out = (it?.docs || []).map((id) => m.files.find((f) => f.id === id)).filter(Boolean);
  if (it?.live === 'minutes' && it.about) {
    const f = minutesFileOf(meetings.find((x) => x.id === it.about));
    if (f && !out.some((x) => x.id === f.id)) out.unshift(f);
  }
  return out;
}
/** The meeting's files on no item (never the signed copy or its own minutes): "Also for this meeting" */
export function looseFiles(m) {
  const placed = new Set(m.sections.flatMap((s) => s.items.flatMap((it) => it.docs || [])));
  return m.files.filter((f) => !placed.has(f.id) && f.kind !== 'signed' && f.kind !== 'minutes');
}
/** The made-up item the loose files are shown under, after the agenda */
export const MORE = { id: 'i_more', title: 'Also for this meeting' };

const FINANCE_FILE = /financ|balance|activit|budget|p&l|profit|loss|statement|cash|treasur|990|audit/i;
const FINANCE_ITEM = /financ|treasur|budget|money/i;
const QUIET = new Set(['soard', 'sunshine', 'ranney', 'board', 'meeting', 'report', 'update', 'final', 'draft', 'copy', 'with', 'from', 'committee', 'the', 'and']);
const wordsOf = (s) => String(s || '').toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 3 && !QUIET.has(w) && !/^\d+$/.test(w));
/**
 * The item a new file most likely goes with, or '': financial statements with the money item, the last
 * meeting's minutes (uploaded before this one) with "approve the minutes", else the one item whose name it shares
 */
export function guessItem(m, f, today = todayEastern()) {
  const items = m.sections.flatMap((s) => s.items.map((it) => ({ it, s })));
  const name = String(f?.name || '');
  const pick = (list) => (list.length ? list[0].it.id : '');
  if (f?.kind === 'financials' || FINANCE_FILE.test(name)) {
    const hit = pick(items.filter(({ it }) => it.live === 'cash')) || pick(items.filter(({ it, s }) => FINANCE_ITEM.test(it.title) || (FINANCE_ITEM.test(s.title) && !it.title)));
    if (hit) return hit;
  }
  if (/minutes/i.test(name) && (!m.date || m.date >= today)) {
    const hit = pick(items.filter(({ it }) => it.live === 'minutes' || /minutes/i.test(it.title)));
    if (hit) return hit;
  }
  const words = new Set(wordsOf(name.replace(/\.[a-z0-9]{2,5}$/i, '')));
  const scored = items.map(({ it }) => ({ it, n: wordsOf(it.title).filter((w) => words.has(w)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  return scored.length && (scored.length === 1 || scored[0].n > scored[1].n) ? scored[0].it.id : '';
}

/**
 * The meeting as the screen shows it, one stop at a time: the cover; "since we last met" when the agenda asks to
 * approve the last meeting's minutes; then each part of the agenda, opened by its own card when it has no items or
 * more than one (a part of one item goes straight to it), each item's card and every page of each of its files;
 * the files on no item; the close. `pages`: { fileId: page count } as far as known (1 until then); `meetings`
 * finds the last meeting's minutes.
 * → [{ key, kind: cover | since | section | item | doc | end, itemId, fileId, page, n, sectionId }] where n is the
 * item's place in agendaItems (-1 for the cover, a part's card, the loose files and the close)
 */
export function deckOf(m, { pages = {}, meetings = [] } = {}) {
  const out = [{ key: 'cover', kind: 'cover', itemId: '', fileId: '', page: 0, n: -1, sectionId: '' }];
  if (m.sections.some((s) => s.items.some((it) => it.live === 'minutes' && it.about))) out.push({ key: 'since', kind: 'since', itemId: '', fileId: '', page: 0, n: -1, sectionId: '' });
  const add = (it, files, n, sectionId) => {
    out.push({ key: it.id, kind: 'item', itemId: it.id, fileId: '', page: 0, n, sectionId });
    for (const f of files) {
      const count = Math.max(1, Math.round(Number(pages[f.id]) || 1));
      for (let p = 0; p < count; p++) out.push({ key: `${it.id}:${f.id}:${p}`, kind: 'doc', itemId: it.id, fileId: f.id, page: p, n, sectionId });
    }
  };
  let n = 0;
  for (const s of m.sections) {
    if (!s.title && !s.items.length) continue;
    if (s.items.length !== 1) out.push({ key: `section:${s.id}`, kind: 'section', itemId: '', fileId: '', page: 0, n: -1, sectionId: s.id });
    for (const it of s.items) add(it, itemFiles(m, it, meetings), n++, s.id);
  }
  const loose = looseFiles(m);
  if (loose.length) add(MORE, loose, -1, '');
  out.push({ key: 'end', kind: 'end', itemId: '', fileId: '', page: 0, n: -1, sectionId: '' });
  return out;
}
/** Where the meeting's live state is in a deck: that page, else that file's last known page, else the item, else a part's card, else the cover */
export function stopIndex(deck, live) {
  if (live?.screen === 'end') return deck.length - 1;
  if (live?.screen === 'since') return Math.max(0, deck.findIndex((s) => s.kind === 'since'));
  if (live?.screen === 'section' && live.sectionId) { const i = deck.findIndex((s) => s.kind === 'section' && s.sectionId === live.sectionId); if (i >= 0) return i; }
  if (!live?.itemId) return 0;
  const exact = deck.findIndex((s) => s.itemId === live.itemId && s.fileId === (live.fileId || '') && s.page === (live.page || 0));
  if (exact >= 0) return exact;
  const pages = deck.map((s, i) => [s, i]).filter(([s]) => s.itemId === live.itemId && s.fileId && s.fileId === live.fileId);
  if (pages.length) return pages.at(-1)[1];
  return Math.max(0, deck.findIndex((s) => s.itemId === live.itemId));
}
/** A stop as the live state that puts it on the screen */
export const liveOfStop = (s) => ({
  itemId: s?.itemId || '', fileId: s?.fileId || '', page: s?.page || 0,
  screen: s?.kind === 'end' ? 'end' : s?.kind === 'since' ? 'since' : s?.kind === 'section' ? 'section' : '',
  sectionId: s?.kind === 'section' ? s.sectionId : '',
});

/** A video call's service by its link: "Google Meet" */
export const callName =(url) => (/meet\.google\.com/.test(url) ? 'Google Meet' : /teams\.(microsoft|live)/.test(url) ? 'Microsoft Teams' : /zoom\.us/.test(url) ? 'Zoom' : /webex/.test(url) ? 'Webex' : 'Video call');

/**
 * Open action items across meetings, each once (an item carried onto later
 * agendas keeps its id) with the meeting it came from, oldest first:
 * [{ ...action, meetingId, meetingName, meetingDate }]
 */
export function openActions(meetings) {
  const seen = new Set();
  return [...(meetings || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .flatMap((m) => (m.actions || []).filter((a) => !a.done && !seen.has(a.id) && seen.add(a.id))
      .map((a) => ({ ...a, meetingId: m.id, meetingName: meetingName(m), meetingDate: m.date })));
}

/** The meeting before this one (by date), or null */
export function previousMeeting(m, meetings) {
  return [...(meetings || [])].filter((x) => x.id !== m?.id && isDate(x.date) && x.date < (m?.date || '9999'))
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

/** The next meeting from today on, else null */
export function nextMeeting(meetings, today = todayEastern()) {
  return [...(meetings || [])].filter((m) => isDate(m.date) && m.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

/** A majority of the board: 13 → 7, 12 → 7 */
export const majority = (n) => (n > 0 ? Math.floor(n / 2) + 1 : 0);
/**
 * A meeting's quorum: a majority of the board members on its list, unless Settings names a number (bylaws
 * that say otherwise). Board members present or on video count toward it.
 */
export const quorumFor = (m, set = 0) => (Number(set) > 0 ? Number(set) : majority(attendanceCounts(m).board));
/** { present, remote, absent, excused, board } counts; board members present or by video count toward a quorum */
export function attendanceCounts(m) {
  const out = { present: 0, remote: 0, absent: 0, excused: 0, board: 0, boardHere: 0 };
  for (const p of m?.attendance || []) {
    if (out[p.status] !== undefined) out[p.status] += 1;
    if (p.kind === 'board') { out.board += 1; if (p.status === 'present' || p.status === 'remote') out.boardHere += 1; }
  }
  return out;
}

/**
 * A new meeting from a template: the board as the attendance list, open
 * action items from earlier meetings carried onto it, and the last
 * meeting's minutes up for approval.
 */
export function newMeeting({ date: d = '', template = DEFAULT_TEMPLATE, board = [], staff = [], meetings = [], defaults = {} } = {}) {
  const prev = previousMeeting({ date: d || '9999-12-31' }, meetings);
  const sections = (template?.length ? template : DEFAULT_TEMPLATE).map((s) => ({
    id: uid('s_'), title: s.title,
    items: (s.items || []).map((it) => ({
      ...cleanItem({ title: it.live === 'minutes' && prev ? `Minutes of the ${meetingName(prev)} (${shortDate(prev.date)})` : it.title, presenter: it.presenter, who: it.who, live: it.live, about: it.live === 'minutes' && prev ? prev.id : '' }),
      id: uid('i_'),
    })),
  }));
  return cleanMeeting({
    id: uid('m_'),
    date: d,
    start: defaults.start || '08:00',
    end: defaults.end || '10:00',
    location: defaults.location || '',
    address: defaults.address || '',
    attendance: [
      ...board.map((p) => ({ slug: p.slug, name: p.name, org: p.org || '', kind: 'board' })),
      ...staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })),
    ],
    sections,
    actions: openActions(meetings).map((a) => ({ ...a, id: a.id })),
    agendaFrom: { kind: 'template', name: '', at: '' },
  });
}

// ─── Notes as points ────────────────────────────────────────────────

/**
 * Notes → blocks for drawing: [{ text, children: [...] }] for "- " points
 * (two spaces deeper per level), plain paragraphs as { text, para: true }.
 */
export function noteBlocks(text) {
  const root = { children: [] };
  const stack = [{ depth: -1, node: root }];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) { stack.length = 1; continue; }
    const m = line.match(/^(\s*)[-•*]\s+(.*)$/);
    if (!m) { stack.length = 1; root.children.push({ text: line.trim(), para: true, children: [] }); continue; }
    const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
    while (stack.length > 1 && stack.at(-1).depth >= depth) stack.pop();
    const node = { text: m[2].trim(), children: [] };
    stack.at(-1).node.children.push(node);
    stack.push({ depth, node });
  }
  return root.children;
}

// ─── Bringing in an old agenda ──────────────────────────────────────

const ROMAN = /^(ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii|xiv|xv|i|v|x)$/i;
const romanValue = (s) => ({ i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15 }[s.toLowerCase()] || 0);
const letterValue = (s) => s.toLowerCase().charCodeAt(0) - 96;
const SMALL = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'on', 'at', 'or', 'a']);
/** "APPROVE MEETING MINUTES" → "Approve meeting minutes"; SOARD and other short capitals stay */
const sentenceCase = (s) => (s === s.toUpperCase() && /[A-Z]{3}/.test(s)
  ? s.toLowerCase().replace(/\b(soard|q[1-4])\b/g, (w) => w.toUpperCase()).replace(/^./, (c) => c.toUpperCase())
  : s);
const plainName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

function headerDate(text) {
  const m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (!m) return '';
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return isDate(d) ? d : '';
}
function headerTime(text) {
  const m = text.match(/\bTIME\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?/i);
  if (!m) return {};
  const t = (h, mm, ap) => { let hh = Number(h) % 12; if (ap.toLowerCase() === 'p') hh += 12; return `${String(hh).padStart(2, '0')}:${mm || '00'}`; };
  return { start: t(m[1], m[2], m[3]), end: t(m[4], m[5], m[6]) };
}

/**
 * The text of an agenda (pasted from Word, or read out of its PDF) as a
 * meeting: its date, time and place from the header, who was there (an "x"
 * before a name in the attendee table), each numbered section in capitals,
 * the numbered items under it, and what was written under each item as its
 * notes (the a., i. and 1. levels become points). People are matched to
 * `people` ([{ slug, name, org, kind }]) by name; a presenter in brackets
 * after an item ("Governance (Paul/Travis/Scott)") is kept when the names
 * are people's first names.
 * When the text keeps its indents (a Google Doc, a Word file: every list
 * level can come out as "1."), the indent decides instead: the first numbered
 * line under a section sets where items sit, anything further in is a point,
 * and "-", "*", "•" bullets count as points too.
 * → { date, start, end, location, attendance, sections, unmatched: [lines] }
 */
export function parseAgendaText(text, people = []) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\u00a0/g, ' ').replace(/\t/g, '    '));
  // (a printed page's footer can run onto the end of a line: "OPEN FORUM | Page")
  const lines = raw.map((l) => l.trim().replace(/\s*\|\s*P\s*a\s*g\s*e(\s*\d+)?$/i, ''));
  const indents = raw.map((l) => l.length - l.trimStart().length);
  // Indents mean something only when some numbered or bulleted line has one
  const indented = lines.some((l, i) => indents[i] > 0 && (LIST_MARK.test(l) || BULLET.test(l)));
  const all = lines.join('\n');
  const out = { date: headerDate((all.match(/DATE[^\n]*/i) || [all])[0]) || headerDate(all), ...headerTime(all), location: '', attendance: [], sections: [], unmatched: [] };
  const loc = all.match(/LOCATION\s+(.+?)(?:\s{2,}|\s+TIME\b|\n|$)/i);
  if (loc) out.location = loc[1].trim();
  const named = people.map((p) => ({ p, key: plainName(p.name) })).filter((x) => x.key).sort((a, b) => b.key.length - a.key.length);
  const firstNames = new Set(people.map((p) => plainName(p.name).split(' ')[0]).filter(Boolean));
  const presenterOf = (s) => {
    const parts = s.split(/\s*[/,;&]\s*|\s+and\s+/i).map((x) => plainName(x).split(' ')[0]).filter(Boolean);
    return parts.length && parts.every((x) => firstNames.has(x)) ? s.replace(/\s*\/\s*/g, ', ') : '';
  };
  const attend = (segment, here) => {
    const hit = named.find((x) => plainName(segment).startsWith(x.key));
    if (!hit) { if (segment) out.unmatched.push(segment); return; }
    if (out.attendance.some((a) => a.slug === hit.p.slug)) return;
    out.attendance.push({ slug: hit.p.slug, name: hit.p.name, org: hit.p.org || '', kind: hit.p.kind || 'board', status: here ? 'present' : 'absent' });
  };

  let section = null;
  let item = null;
  let itemNo = 0;
  let levels = []; // the points open under the item, outermost first: [kind ('a' | 'i' | '1' | '-'), value]
  let inHeader = true;
  let base = null; // with indents: how far in this section's items sit
  let deeper = []; // with indents: the indents of the points open under the item, outermost first
  const newItem = (title) => {
    item = { id: uid('i_'), title: title.trim(), presenter: '', notes: '', staffNote: '', confidential: false, live: '' };
    const who = item.title.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (who && presenterOf(who[2])) { item.title = who[1]; item.presenter = presenterOf(who[2]); }
    if (!section) { section = { id: uid('s_'), title: '', items: [] }; out.sections.push(section); }
    section.items.push(item);
    levels = [];
    deeper = [];
  };
  const note = (depth, body) => {
    if (!item) newItem('');
    item.notes += `${item.notes ? '\n' : ''}${'  '.repeat(depth - 1)}- ${body.trim()}`;
  };
  const point = (kind, value, body) => {
    const at = levels.findIndex((l) => l[0] === kind);
    if (at >= 0) levels = levels.slice(0, at);
    else if (kind === 'a') levels = [];
    levels.push([kind, value]);
    note(levels.length, body);
  };
  for (const [i, line] of lines.entries()) {
    if (!line || isFooter(line)) continue;
    // A section: "1. CALL TO ORDER"
    const sec = line.match(/^(\d{1,2})\.\s*(.+)$/);
    if (sec && sec[2] === sec[2].toUpperCase() && /[A-Z]{3}/.test(sec[2])) {
      inHeader = false;
      section = { id: uid('s_'), title: sentenceCase(sec[2].trim()), items: [] };
      out.sections.push(section);
      item = null; itemNo = 0; levels = []; base = null; deeper = [];
      continue;
    }
    if (inHeader) {
      if (/^(MEETING|LOCATION|DATE|TIME|ATTENDEE)\b/i.test(line) || /^\d{1,2}:\d{2}\s*[ap]/i.test(line)) continue;
      // The attendee table: "x Jane Example Example Design Group x Pat Sample" (two columns, x = there)
      const parts = (` ${line}`).split(/\s+x\s+/i);
      if (parts[0].trim()) attend(parts[0].trim(), false);
      for (const seg of parts.slice(1)) attend(seg.trim(), true);
      continue;
    }
    const m = line.match(LIST_MARK);
    const mark = m && (/^\d+$/.test(m[1]) || m[1].length === 1 || ROMAN.test(m[1])) ? m[1] : null;
    const bullet = !mark && (line.match(BULLET) || (indented && indents[i] > 0 && line.match(/^(o)\s+(.+)$/)));
    if (indented && (mark || bullet)) {
      // By the indent: as far in as this section's first item (or less) is an item, further in is a point
      const at = indents[i];
      const body = (mark ? m : bullet)[2];
      if (base === null || at <= base || !item) {
        if (base === null || at < base) base = at;
        newItem(body);
        continue;
      }
      while (deeper.length && deeper.at(-1) > at) deeper.pop();
      if (deeper.at(-1) !== at) deeper.push(at);
      note(deeper.length, body);
      continue;
    }
    if (bullet) {
      // A bullet with no indents to go by: a point under the item, one level down from a lettered one
      if (item) point('-', 0, bullet[2]); else newItem(bullet[2]);
      continue;
    }
    if (!mark) {
      // A line that carries on from the one before it
      if (item?.notes) item.notes += ` ${line}`;
      else if (item) item.title = `${item.title} ${line}`.trim();
      else if (section) section.title = `${section.title} ${line}`.trim();
      continue;
    }
    const body = m[2];
    const last = levels.at(-1);
    if (/^\d+$/.test(mark)) {
      const n = Number(mark);
      const continuesPoint = last?.[0] === '1' && n === last[1] + 1;
      // The section's next number is its next item; any other number is a point under a point
      if ((n === itemNo + 1 && !continuesPoint) || !levels.length) { itemNo = n; newItem(body); }
      else point('1', n, body);
      continue;
    }
    const lower = mark.toLowerCase();
    let kind = 'a';
    if (mark.length > 1) kind = 'i';
    else if (['i', 'v', 'x'].includes(lower)) {
      // "i." right after "h." is a letter; under a letter (or more numerals) it's a numeral
      const afterLetter = last?.[0] === 'a' && last[1] === letterValue(lower) - 1;
      kind = !afterLetter && last && (last[0] === 'a' || last[0] === 'i' || last[0] === '1') ? 'i' : 'a';
    }
    point(kind, kind === 'i' ? romanValue(mark) : letterValue(mark), body);
  }
  // A page footer run into the line before it ("Open forum | Page")
  const unfoot = (s) => s.replace(/\s*\|\s*P\s*a\s*g\s*e(\s*\d+)?\s*$/i, '').trim();
  out.sections = out.sections.map((s) => ({ ...s, title: unfoot(s.title), items: s.items.map((it) => ({ ...it, title: unfoot(it.title), notes: unfoot(it.notes) })).filter((it) => it.title || it.notes) }))
    .filter((s) => s.title || s.items.length);
  // Nobody marked there (an agenda printed before the meeting): who came isn't recorded, not "everyone was away"
  if (out.attendance.length && out.attendance.every((a) => a.status === 'absent')) out.attendance = [];
  return out;
}

// "1. Item", "a. Point", "iv. Point"; bullets "- ", "* ", "• " and the like
const LIST_MARK = /^(\d{1,2}|[a-z]{1,4})\.\s*(.+)$/i;
const BULLET = /^([-*•◦▪●○■□–➢►])\s+(.+)$/;
// "3 | Page", "| Page", "Page | 3", "Page 3", "Page 3 of 9": a printed page's footer
const isFooter = (line) => /^(\d+\s*)?\|\s*P\s*a\s*g\s*e(\s*\d+)?$/i.test(line) || /^P\s*a\s*g\s*e\s*\|\s*\d*$/i.test(line) || /^page \d+( of \d+)?$/i.test(line);

/**
 * A Google Doc as Drive exports it (text/html) as the lines an agenda reads
 * from, the way docxText reads a Word file: a table row on one line (its
 * cells in order), each paragraph, and each list item with its number,
 * three spaces in for each level of its list (Docs names a list's level in
 * its class: "lst-kix_list_34-2" is level 2). Docs' own plain text loses
 * the levels, so a minutes outline would come out flat.
 */
export function docHtmlText(html) {
  const s = String(html || '');
  // Comments and footnotes: their markers ("[a]", "[1]") and their text at the end aren't the agenda
  const body = ((s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] ?? s)
    .replace(/<sup\b[^>]*>\s*<a\b[^>]*href="#(cmnt|ftnt)\d+"[^>]*>[\s\S]*?<\/a>\s*<\/sup>/gi, '')
    .replace(/<div\b[^>]*>\s*<p\b[^>]*>\s*<a\b[^>]*id="(cmnt|ftnt)\d+"[\s\S]*?<\/div>/gi, '');
  const lines = [];
  const counters = {}; // list id → the number at each level
  let row = null; // the open table row's cells
  let cell = null; // the open cell's paragraphs
  let text = null; // the open paragraph or list item
  let list = null; // { id, level, bullet }
  const done = (t) => { if (!t) return; if (cell) cell.push(t); else lines.push(t); };
  for (const [, close, tag, attrs, chunk] of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g)) {
    if (chunk !== undefined) { if (text !== null) text += htmlEntities(chunk); continue; }
    const t = tag.toLowerCase();
    if (t === 'br') { if (text !== null) text += ' '; continue; }
    if (t === 'style' || t === 'script') continue;
    if (t === 'tr') { if (close) { const line = (row || []).filter(Boolean).join(' '); if (line) lines.push(line); row = null; } else row = []; continue; }
    if (t === 'td' || t === 'th') { if (close) { if (row) row.push((cell || []).join(' ')); cell = null; } else cell = []; continue; }
    if (t === 'ol' || t === 'ul') {
      if (close) { list = null; continue; }
      const kix = attrs.match(/lst-kix_([\w-]+?)-(\d+)\b/);
      list = { id: kix ? kix[1] : `l${lines.length}`, level: kix ? Number(kix[2]) : 0, bullet: t === 'ul' };
      const c = (counters[list.id] ||= []);
      const start = attrs.match(/\bstart="(\d+)"/);
      if (start && /\bstart\b/.test((attrs.match(/class="([^"]*)"/) || [])[1] || '')) c[list.level] = Number(start[1]) - 1;
      continue;
    }
    if (t === 'li') {
      if (!close) { text = ''; continue; }
      const words = (text || '').replace(/\s+/g, ' ').trim();
      text = null;
      if (!words) continue;
      const lv = list?.level || 0;
      const c = list ? (counters[list.id] ||= []) : [];
      c[lv] = (c[lv] || 0) + 1;
      c.length = lv + 1;
      const line = `${'   '.repeat(lv)}${list?.bullet ? '-' : `${c[lv]}.`} ${words}`;
      // A list item in a table cell (a section's shaded bar) is its own line
      if (cell) lines.push(line.trim()); else lines.push(line);
      continue;
    }
    if (/^(p|h[1-6])$/.test(t)) {
      if (!close) { if (text === null) text = ''; continue; }
      if (list) continue; // a paragraph inside a list item
      done((text || '').replace(/\s+/g, ' ').trim());
      text = null;
    }
  }
  return lines.join('\n');
}
const NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: '’', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•' };
const htmlEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : NAMED_ENTITIES[e.toLowerCase()] ?? all));

// ─── What a live item says ──────────────────────────────────────────

const STATUS_ORDER = ['Design', 'Finalization', 'Approval', 'Mobilization', 'Build'];
const dayOf = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
/** "2026-10" or "2026-10-27" → "October" */
export const monthName = (s) => (/^\d{4}-\d{2}/.test(String(s || '')) ? new Date(`${String(s).slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) : '');
const shortDay = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : String(d || ''));
/** "net $12,000" / "net −$3,000" */
export const netText = (n) => (typeof n === 'number' ? `net ${n < 0 ? '−' : ''}${money(Math.abs(n))}` : '');
const windowText = (w) => (w?.label ? String(w.label) : w?.part && w?.month ? `${w.part} ${w.month}` : 'date to come');

/**
 * The lines an agenda item with live facts shows, from the packet's locked
 * numbers or today's (see _board.js liveNumbers). [] when there's nothing.
 */
export function liveLines(kind, n, { meetingId = null } = {}) {
  if (!n) return [];
  if (kind === 'cash') {
    const out = [];
    if (n.cash) {
      const parts = (n.cash.accounts || []).length > 1 ? ` (${n.cash.accounts.map((a) => `${a.name} ${money(a.balance)}`).join(', ')})` : '';
      out.push(`${money(n.cash.total)} in the bank${parts}`);
      const owed = (n.cash.owed || []).filter((c) => c.balance > 0);
      if (owed.length) out.push(`Owed on the card${owed.length > 1 ? 's' : ''}: ${owed.map((c) => `${c.name} ${money(c.balance)}`).join(', ')}`);
    }
    const f = n.finance;
    if (f?.ytd) {
      const spent = (p) => (p.makeovers || 0) + (p.store || 0) + (p.operating || 0);
      out.push(`${f.ytd.year} so far (through ${monthName(f.ytd.through)}): ${money(f.ytd.income)} in, ${money(spent(f.ytd))} out, ${netText(f.ytd.net)}${f.lastYtd ? `; ${f.lastYtd.year} to the same day: ${netText(f.lastYtd.net)}` : ''}`);
    }
    if (f?.cash?.lowest) out.push(`Cash forecast: lowest ${money(f.cash.lowest.dollars)}${f.cash.lowest.week ? ` the week of ${shortDay(f.cash.lowest.week)}` : ''}, ${money(f.cash.in13Weeks)} in 13 weeks${f.cash.belowFloor ? `, under the ${money(f.cash.floor)} floor` : ''}`);
    return out;
  }
  if (kind === 'projects') {
    const p = n.projects;
    if (!p) return [];
    const building = p.building || [];
    const counts = STATUS_ORDER.filter((s) => p.byStatus?.[s]).map((s) => `${p.byStatus[s]} in ${s}`);
    const total = STATUS_ORDER.reduce((sum, s) => sum + (Number(p.byStatus?.[s]) || 0), 0) || building.length;
    const out = [`${plural(total, 'makeover')} in progress${counts.length ? `: ${counts.join(', ')}` : ''}`];
    for (const s of STATUS_ORDER) {
      const names = building.filter((b) => b.status === s).map((b) => b.name).filter(Boolean);
      const more = building.filter((b) => b.status === s && !b.name).length;
      if (names.length || more) out.push(`${s}: ${[names.join(', '), more ? `${names.length ? `${more} more` : `${more} ${more === 1 ? 'family' : 'families'}`}` : ''].filter(Boolean).join(' and ')}`);
    }
    return out;
  }
  if (kind === 'reveals') {
    return (n.reveals || []).slice(0, 8).map((r) => (r.confirmed
      ? `${r.name}: ${dayOf(r.date)}${r.time ? `, ${clock(r.time)}` : ''}`
      : `${r.name}: ${windowText(r.window)} (not confirmed yet)`));
  }
  if (kind === 'events') return (n.events || []).slice(0, 6).map((e) => `${e.title}: ${dayOf(e.date)}${e.location ? `, ${e.location}` : ''}`);
  if (kind === 'meetings') return (n.meetings || []).filter((m) => m.id !== meetingId).slice(0, 4).map((m) => `${m.name}: ${dayOf(m.date)}${m.start ? `, ${clock(m.start)}` : ''}`);
  return [];
}

// ─── Two people editing at once ─────────────────────────────────────

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** One value, three ways: what both had, mine and theirs → { value, clash } (a clash takes `prefer`'s) */
function pick3(base, mine, theirs, prefer = 'mine') {
  if (same(mine, base)) return { value: theirs };
  if (same(theirs, base) || same(mine, theirs)) return { value: mine };
  return { value: prefer === 'theirs' ? theirs : mine, clash: true };
}
/** A list of records by id: each record merged field by field, additions from both kept, removals honored */
function mergeList(base = [], mine = [], theirs = [], key = (x) => x.id, label = (x) => '', skip = [], prefer = 'mine') {
  const b = new Map(base.map((x) => [key(x), x]));
  const t = new Map(theirs.map((x) => [key(x), x]));
  const out = [];
  const clashes = [];
  const seen = new Set();
  for (const x of mine) {
    const k = key(x); seen.add(k);
    const was = b.get(k); const th = t.get(k);
    if (!th) { if (!was || !same(x, was)) out.push(x); continue; } // they removed it: gone, unless I changed it
    if (!was) { out.push(x); continue; }
    const rec = { ...x };
    for (const f of new Set([...Object.keys(x), ...Object.keys(th)])) {
      if (skip.includes(f)) { rec[f] = x[f]; continue; }
      const r = pick3(was[f], x[f], th[f], prefer);
      rec[f] = r.value;
      if (r.clash) clashes.push(label(x) || f);
    }
    out.push(rec);
  }
  for (const th of theirs) if (!seen.has(key(th)) && !b.has(key(th))) out.push(th); // theirs is new
  return { value: out, clashes };
}

/**
 * Merge my unsaved meeting with one saved meanwhile (by Holly, the calendar,
 * board mail), against the version I started from. Separate items, people,
 * motions and action items merge on their own; only the same thing changed
 * both ways is a clash. → { merged, clashes: [what clashed, in words] }
 */
export function mergeMeeting(base, mine, theirs, { prefer = 'mine' } = {}) {
  const merged = { ...theirs };
  const clashes = [];
  for (const f of ['date', 'start', 'end', 'title', 'location', 'address', 'video', 'shared', 'minutes', 'approvedOn']) {
    const r = pick3(base[f], mine[f], theirs[f], prefer);
    merged[f] = r.value;
    if (r.clash) clashes.push({ date: 'the date', start: 'the time', end: 'the time', title: 'the name', location: 'the place', address: 'the address', video: 'the video link', shared: 'sharing', minutes: 'the minutes status', approvedOn: 'the minutes status' }[f]);
  }
  // The agenda: sections in my order, each section's items merged one by one
  const secs = mergeList(base.sections, mine.sections, theirs.sections, (s) => s.id, (s) => `the section “${s.title}”`, ['items'], prefer);
  merged.sections = secs.value.map((s) => {
    const was = base.sections.find((x) => x.id === s.id); const th = theirs.sections.find((x) => x.id === s.id); const mi = mine.sections.find((x) => x.id === s.id);
    if (!was || !th || !mi) return s;
    const items = mergeList(was.items, mi.items, th.items, (it) => it.id, (it) => `“${it.title || 'an item'}”`, [], prefer);
    clashes.push(...items.clashes);
    return { ...s, items: items.value };
  });
  clashes.push(...secs.clashes);
  const people = mergeList(base.attendance, mine.attendance, theirs.attendance, (p) => p.key, (p) => `${p.name}’s attendance`, [], prefer);
  merged.attendance = people.value;
  clashes.push(...people.clashes);
  for (const f of ['motions', 'actions']) {
    const r = mergeList(base[f], mine[f], theirs[f], (x) => x.id, (x) => `“${String(x.text || '').slice(0, 40)}”`, [], prefer);
    merged[f] = r.value;
    clashes.push(...r.clashes);
  }
  // The meeting as it's held is the chair's: whoever moved it last wins, never a question in the middle of a meeting
  merged.live = JSON.stringify(cleanLive(mine.live)) !== JSON.stringify(cleanLive(base.live)) ? cleanLive(mine.live) : cleanLive(theirs.live);
  return { merged, clashes: [...new Set(clashes.filter(Boolean))] };
}

// ─── Reading a Word file (the admin's Bring in an old agenda, and board mail) ───

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** The files inside a ZIP (a .docx is one): { name: bytes } for the names wanted */
export async function unzip(bytes, want) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) break;
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (want.includes(name)) {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + size);
      out[name] = method === 8 ? await inflate(raw) : raw;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const xmlText = (s) => s.replace(/<w:tab\/>/g, ' ').replace(/<w:br\/>/g, ' ').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const roman = (n) => [['m', 1000], ['cm', 900], ['d', 500], ['cd', 400], ['c', 100], ['xc', 90], ['l', 50], ['xl', 40], ['x', 10], ['ix', 9], ['v', 5], ['iv', 4], ['i', 1]]
  .reduce((acc, [r, v]) => { while (n >= v) { acc += r; n -= v; } return acc; }, '');
const letter = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s; return s; };

/**
 * A Word document's text the way it prints: Word numbers its own lists, so
 * each numbered paragraph gets its "1." / "a." / "i." back from numbering.xml,
 * and each table row is one line. Ready for parseAgendaText.
 */
export async function docxText(bytes) {
  const files = await unzip(bytes, ['word/document.xml', 'word/numbering.xml']);
  const dec = new TextDecoder();
  const doc = files['word/document.xml'] ? dec.decode(files['word/document.xml']) : '';
  if (!doc) throw new Error('no document in that Word file');
  const numbering = files['word/numbering.xml'] ? dec.decode(files['word/numbering.xml']) : '';
  const abstract = {};
  for (const [, id, body] of numbering.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    abstract[id] = {};
    for (const [, lvl, inner] of body.matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      abstract[id][lvl] = { fmt: (inner.match(/<w:numFmt w:val="(\w+)"/) || [])[1] || 'decimal', start: Number((inner.match(/<w:start w:val="(\d+)"/) || [])[1] || 1) };
    }
  }
  const nums = {};
  for (const [, numId, abs] of numbering.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"/g)) nums[numId] = abstract[abs] || {};
  const counters = {};
  const marker = (numId, ilvl) => {
    const lv = nums[numId]?.[ilvl] || { fmt: 'decimal', start: 1 };
    const c = (counters[numId] ||= []);
    c[ilvl] = (c[ilvl] ?? lv.start - 1) + 1;
    c.length = ilvl + 1;
    const n = c[ilvl];
    if (lv.fmt === 'bullet' || lv.fmt === 'none') return '-';
    if (/lowerLetter/.test(lv.fmt)) return `${letter(n)}.`;
    if (/upperLetter/.test(lv.fmt)) return `${letter(n).toUpperCase()}.`;
    if (/lowerRoman/.test(lv.fmt)) return `${roman(n)}.`;
    if (/upperRoman/.test(lv.fmt)) return `${roman(n).toUpperCase()}.`;
    return `${n}.`;
  };
  const body = (doc.match(/<w:body>([\s\S]*)<\/w:body>/) || [])[1] || doc;
  const lines = [];
  for (const [block] of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    if (block.startsWith('<w:tbl>')) {
      for (const [row] of block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(([c]) => xmlText(c).replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (cells.length) lines.push(cells.join(' '));
      }
      continue;
    }
    const text = xmlText(block.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const numId = (block.match(/<w:numId w:val="(\d+)"/) || [])[1];
    const ilvl = Number((block.match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0);
    // Each list level three spaces further in, so the agenda rules can tell an item from a point under it
    lines.push(numId && numId !== '0' ? `${'   '.repeat(ilvl)}${marker(numId, ilvl)} ${text}` : text);
  }
  return lines.join('\n');
}

