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
 *                  live: '' | projects | reveals | events | cash | meetings | costs }] }]
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
 *                { eventId, organizer, sentAt, updatedAt, meet, guests, transcript, error (both
 *                only on invites from before Nov 3 2026: SOARD's Google plan has no transcripts),
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

import { mdBlocks, mdInline, mdWords, mdPlain, mdPoints, mdNumber, POINTS_WORDS } from './board-md.js';
import { typicalLately, rowsOf, planOf, typeById, cashOf, operatingOf, statsOf } from './makeover-costs-shared.js';

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
  // The calendar invite is the only answer (Peter, Nov 2 2026): one given on the board page or in an email before
  // then (rsvp) doesn't count
  return { accepted: 'Coming', declined: 'Can’t come', tentative: 'Maybe' }[invite] || '';
}
const REPLIES = ['accepted', 'declined', 'tentative', 'invited'];
function cleanReplies(raw) {
  return Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {})
    .filter(([k, v]) => /^[a-z0-9-]{1,80}$/.test(k) && REPLIES.includes(v)).slice(0, LIMITS.people));
}
/**
 * Each board member's reply to the meeting's calendar invite, by slug: Board's invite's (functions/api/_board-calendar.js
 * reads them); a past meeting taken from a calendar before Nov 2 2026 keeps that event's as its record
 */
export function repliesOf(m) {
  if (m?.invite?.eventId) return { ...(m.invite.replies || {}) };
  return m?.calendar && !m.calendar.gone ? { ...(m.calendar.replies || {}) } : {};
}
/** Whether a meeting's calendar invite has gone out (Board's, sent from Board) */
export const inviteOut = (m) => !!m?.invite?.eventId;
/** "Balance-sheet_financials v2.pdf" → "Balance sheet financials v2" (the file keeps its own name for saving) */
export function fileTitle(name) {
  // A tax form's own dash stays (W-9, I-9, W-8BEN, 1099-NEC, 990-EZ, 8822-B); every other one is a space
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/\b(\d{1,2})_(\d{1,2})_(\d{2,4})\b/g, '$1/$2/$3')
    .replace(/(?<![a-z0-9])([a-z])-(\d{1,4}[a-z]{0,3})(?![a-z0-9])/gi, '$1\u2011$2').replace(/(?<![a-z0-9])(\d{3,4})-([a-z]{1,3})(?![a-z0-9])/gi, '$1\u2011$2')
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\u2011/g, '-');
  return base ? base[0].toUpperCase() + base.slice(1) : 'File';
}
/** A file's format in a word: PDF, Excel, Word, Slides, Photo or File */
export function formatOf(f) {
  const n = String(f?.name || '').toLowerCase();
  const t = String(f?.type || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'PDF';
  if (/sheet|excel|csv/.test(t) || /\.(xlsx?|csv)$/.test(n)) return 'Excel';
  if (/word/.test(t) || /\.docx?$/.test(n)) return 'Word';
  if (/presentation|powerpoint/.test(t) || /\.pptx?$/.test(n)) return 'Slides';
  if (t.startsWith('image/')) return 'Photo';
  return 'File';
}
/**
 * SOARD's name as it's written: "SunShine on a Ranney Day" or "Sunshine On A Ranney Day" (a file's name, a title
 * typed in a hurry) → "Sunshine on a Ranney Day", and "SunShine" alone → "Sunshine". Set in capitals it stays so
 */
export const orgName = (s) => String(s ?? '').replace(/\bsunshine\s+on\s+a\s+ranney\s+day\b/gi, (m) => (m === m.toUpperCase() ? m : 'Sunshine on a Ranney Day')).replace(/\bSunShine\b/g, 'Sunshine');
/**
 * A name's initials for a face without a photo: first and last ("Sam Rivers" → SR), without a suffix or a title
 * ("Bartholomew Montgomery-Fitzgerald III" → BM) or a school's or a company's "The" ("The Lionheart School" → LS)
 */
export function initialsOf(name) {
  const all = String(name || '').split(/\s+/).filter(Boolean);
  const w = all.length > 1 ? all.filter((x, i) => !/^(the|a|an|of|and|&)$/i.test(x) && !(i && /^(jr|sr|ii|iii|iv|v|md|phd|esq|dds|cpa)\.?,?$/i.test(x)) && !/^(dr|mr|mrs|ms)\.?$/i.test(x)) : all;
  const words = w.length ? w : all;
  return ((words[0]?.[0] || '') + (words.length > 1 ? words.at(-1)[0] : '')).toUpperCase() || '?';
}
// Titles before a name and the letters after one: never part of whose name it is
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'rev', 'prof', 'hon', 'sir', 'jr', 'sr', 'ii', 'iii', 'iv', 'v', 'md', 'phd', 'esq', 'cpa', 'mba', 'jd', 'dds', 'rn', 'cfp', 'pe']);
const nameWords = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').split(/[^a-z]+/).filter((w) => w && !HONORIFICS.has(w));
/**
 * A typed signature that's the member's own name → the name to keep, or '' for anyone else's. Their name as People
 * has it in any case or spacing ("sam rivers" keeps "Sam Rivers", and so does "sAm RiVeRs"), or with a title, a
 * middle initial or name of theirs, or their first name's initial, long or short form ("S. Rivers", "Samuel J.
 * Rivers", "Dr. Sam Rivers"), or the middle name they go by, before their own last name (or a part of a double one).
 * Never another first name ("Mickey Rivers") and never a number
 */
const hasMarks = (s) => /[\u0300-\u036f]/.test(String(s).normalize('NFD'));
// A word in a sensible case: kept when typed with care ("McKay", "O’Brien"), else capitalized ("jean-luc" → "Jean-Luc")
const wordCase = (w) => (w === w.toLowerCase() || w === w.toUpperCase() || (/\p{Ll}\p{Lu}/u.test(w) && !/^(Mc|Mac|O['’]|D['’])/.test(w))
  ? w.toLowerCase().replace(/(^|[.'’-])(\p{L})/gu, (_, a, c) => a + c.toUpperCase()) : w);
export function signsAs(typed, name) {
  if (/\d/.test(String(typed ?? ''))) return '';
  // What comes after a comma is letters after the name (", CPA", ", J.D."): the name is before it
  const t = nameWords(String(typed ?? '').split(',')[0]);
  const n = nameWords(String(name ?? '').split(',')[0]);
  if (!n.length || t.length < Math.min(2, n.length) || new Set(t).size < t.length) return '';
  const same = t.join(' ') === n.join(' ');
  if (!same) {
    // Their last name: People's last word that's a name (not "III"), or a part of a double one
    const lastParts = nameWords(String(name).split(',')[0].trim().split(/\s+/).filter((w) => nameWords(w).length).at(-1));
    const [first, f] = [t[0], n[0]];
    const firstOk = first === f || (first.length === 1 && first === f[0]) || (Math.min(first.length, f.length) >= 2 && (f.startsWith(first) || first.startsWith(f))) || n.slice(1, -1).includes(first);
    if (t.length < 2 || !lastParts.includes(t.at(-1)) || !firstOk || !t.slice(1, -1).every((w) => w.length === 1 || n.includes(w))) return '';
  }
  const people = String(name).replace(/\s+/g, ' ').trim();
  const words = String(typed).replace(/\s+/g, ' ').trim().slice(0, 120).split(' ');
  // The same name: People's spelling, unless they typed its accents and People hasn't
  if (same && !(hasMarks(typed) && !hasMarks(name))) return people;
  // Each word that's one of theirs in People's spelling, the rest in a sensible case
  const theirs = new Map(people.split(' ').map((w) => [nameWords(w).join(''), w]));
  return words.map((w) => (!hasMarks(w) && theirs.get(nameWords(w).join(''))) || wordCase(w)).join(' ');
}
/**
 * A document's title for reading: "Sunshine on a Ranney Day_Statement of Activity (1) (1).pdf" → "Statement of
 * Activity": no extension, no "Sunshine on a Ranney Day" in front, no " (1)" a download added or " - Sheet1",
 * " - Copy" an export added; a web link's "+" for spaces, QuickBooks' "StatementofFinancialPosition" apart, a sheet's
 * name said twice ("Budget FY26 PL - FY26 PL") once, a scan by its day, and a name that's only an id "Document"
 */
export function docTitle(name) {
  // A date's dashes are kept as slashes ("2-9-26" stays a date once the other dashes are spaces)
  // and a year's month or a fiscal year ("2025-11", "2026-27") keeps its dash
  let t = fileTitle(String(name || '').replace(/\+/g, ' ').replace(/\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/g, '$1/$2/$3').replace(/(?<!\d)((?:19|20)\d{2})-(\d{2})(?!\d)/g, '$1\u2011$2')).replace(/\u2011/g, '-');
  if (/^[0-9a-f]{8}( [0-9a-f]{4}){3} [0-9a-f]{12}$/i.test(t)) return 'Document';
  // A scanner's "doc20260209130015": the day it was scanned
  const scan = /^doc(\d{4})(\d{2})(\d{2})\d{6}$/i.exec(t);
  if (scan) return `Scan ${Number(scan[2])}/${Number(scan[3])}/${scan[1]}`;
  t = t.replace(/\b[A-Za-z0-9]{12,}\b/g, (w) => (/[a-z][A-Z]/.test(w) ? w.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/(\d)([A-Z][a-z])/g, '$1 $2').replace(/\b(Statement)of\b/g, '$1 of').replace(/\b(Profit)and\b/g, '$1 and') : w));
  t = t.replace(/^(Sunshine on a Ranney Day|SOARD)\s+/i, '').replace(/(\s+(Sheet\s*\d+|Copy)|\s*\(\d+\))+$/i, '');
  const w = t.split(' ');
  for (let n = Math.floor(w.length / 2); n >= 1; n--) {
    if (w.slice(-n).join(' ').toLowerCase() === w.slice(-2 * n, -n).join(' ').toLowerCase()) { t = w.slice(0, -n).join(' '); break; }
  }
  return orgName(t ? t[0].toUpperCase() + t.slice(1) : fileTitle(name));
}
// The copy of a document a screen shows: a spreadsheet drawn as itself (sharp at any size, without a printout's
// gridlines), else the PDF as it was printed, then slides, Word, a photo
const SHOWN_FIRST = { Excel: 0, PDF: 1, Slides: 2, Word: 3, Photo: 4, File: 5 };
/**
 * Files as documents, in their order: the same title in several formats (a statement and its PDF printout) or saved
 * twice is one document, shown by the copy that reads best on a screen (the newest of two alike)
 * → [{ key, title, file, copies: [every file, the one shown first] }]
 */
export function docsOf(files) {
  const out = [];
  for (const f of files) {
    const title = docTitle(f.name);
    const key = title.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
    let d = out.find((x) => x.key === key);
    if (!d) out.push(d = { key, title, file: f, copies: [] });
    d.copies.push(f);
  }
  for (const d of out) {
    d.copies.sort((a, b) => SHOWN_FIRST[formatOf(a)] - SHOWN_FIRST[formatOf(b)] || String(b.at || '').localeCompare(String(a.at || '')));
    d.file = d.copies[0];
  }
  return out;
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
  { id: 'costs', label: 'What finished makeovers cost (JobTread), and the money for more' },
];
/** What a live list with no title of its own is called for the board: what it shows, never its part's name */
export const LIVE_TITLES = { projects: 'Makeovers in progress', reveals: 'Upcoming reveals', events: 'Upcoming events', cash: 'The money', meetings: 'Next board meetings', minutes: 'The last meeting’s minutes', costs: 'What makeovers cost' };
// (paper: a paper written in Board, its Markdown: long bylaws run past 70,000 letters; ./board-report.js PAPER_LETTERS)
/**
 * Signing a paper electronically (../../functions/api/_board-sign.js): what a member agrees to, once, before they
 * first sign (its SHA-256 is kept with each signature), and the handwriting a typed signature can take (portal.css
 * @font-face; the signed copy embeds the same fonts)
 */
export const CONSENT_TEXT = 'I agree to sign SOARD’s board papers electronically. It counts the same as signing on paper. I can sign on paper instead (add a photo or PDF of the signed page), stop signing electronically by telling SOARD, and keep a copy of anything I sign: it’s on the board page, and emailed to me.';
/** How signing works, by version (printed on each signing record): what the evidence rests on */
export const PROCESS_V = 1;
export const PROCESS_TEXT = [
  'A board member signs on SOARD’s board page, which opens only after Cloudflare Access emails a one-time code to the address SOARD has for them.',
  'They read the paper there, initial and answer each point it marks, agree once to sign electronically, and sign with their name typed in a style they choose or drawn. Nobody else can sign for them: an admin can add a copy they signed on paper, recorded as added by that admin.',
  'Each signature keeps the address Access checked, the IP address and device it came from, when that sign-in began, and the SHA-256 of the exact words or file they signed. Every step (asked, opened, signed, replaced, taken off) is an event in one chain, each hashed over the one before, so a change afterwards shows.',
  'Nothing a signature rests on is deleted. Each signature gets its signed copy with this record (one added by an admin is the copy as it came in), and a member who signs on the board page gets theirs by email.',
].join(' ');
/** How signing works, for a board member, in plain words (PROCESS_TEXT is the record's own) */
export const MEMBER_HOW = 'The board page opens only with a code emailed to you, so only you can sign as you, and nobody can sign for you. When you sign, SOARD keeps your name, when you signed, the exact words you signed and where you signed from, in a record that shows any change made to it later. You get your signed copy by email, and it’s here on the board page too.';
/** A paper's due date in a year ('MM-DD' kept on the paper, so it rolls forward each year; Feb 29 is Feb 28 in other years) → 'YYYY-MM-DD' | '' */
export const dueOn = (doc, year) => {
  const m = String(doc?.due || '').match(/^(\d{2})-(\d{2})$/);
  if (!m) return '';
  const last = new Date(Date.UTC(Number(year), Number(m[1]), 0)).getUTCDate();
  return `${year}-${m[1]}-${String(Math.min(Number(m[2]), last)).padStart(2, '0')}`;
};
/** "January 31" */
export const dueWords = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
export const SIGN_STYLES = [
  { id: 'dancing-script', font: 'Dancing Script', label: 'Flowing' },
  { id: 'caveat', font: 'Caveat', label: 'Handwritten' },
  { id: 'great-vibes', font: 'Great Vibes', label: 'Script' },
];
export const styleFont = (id) => (SIGN_STYLES.find((x) => x.id === id) || SIGN_STYLES[0]).font;

export const LIMITS = { title: 200, text: 300, notes: 20000, report: 120000, paper: 400000, motion: 400, items: 80, sections: 20, people: 80, rows: 100 };

/** The agenda a new meeting starts from, until Settings saves another one */
export const DEFAULT_TEMPLATE = [
  { title: 'Call to order', items: [{ title: 'Roll call' }, { title: 'Welcome and introductions' }, { title: 'Personal Best, Business Best, Sunshine Bragging Rights' }] },
  { title: 'Approve meeting minutes', items: [{ title: 'Minutes of the last meeting', live: 'minutes' }] },
  { title: 'Committee reports', items: [
    { title: 'Governance' }, { title: 'Financial', live: 'cash' }, { title: 'Qualification Committee', live: 'costs' },
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

/**
 * When a board member had the board page's sign-in email, or null: their own send (welcome.members), counted only at the
 * address it went to (a corrected address is due again), or kept under an older web address with the same email. One rule
 * for the server's send, Board access and each member's row.
 */
export const welcomeHad = (welcome, p, onBoard = []) => {
  const w = welcome || {};
  const members = w.members || {};
  if (members[p.slug]) return !w.addresses?.[p.slug] || w.addresses[p.slug] === p.email ? members[p.slug] : null;
  // Kept under an older web address (renamed on People): the same email had it
  const moved = p.email && Object.keys(w.addresses || {}).find((k) => w.addresses[k] === p.email && members[k] && !onBoard.includes(k));
  return moved ? members[moved] : null;
};

/** An address the mailer can send to (its own rule, _broadcast-notify.js isEmail): kim@gmail.c and kim@example.net, aren't */
export const usableEmail = (e) => /^(?!\.)(?!.*\.\.)(?!.*\.@)[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:".]+(?:\.[^\s@<>()[\],;:".]+)*\.[^\s@<>()[\],;:".]{2,}$/.test(String(e || '').trim());
/** Today in Atlanta (YYYY-MM-DD) */
export const todayEastern = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

// ─── A clean meeting ────────────────────────────────────────────────

function cleanItem(raw) {
  const live = ['projects', 'reveals', 'events', 'cash', 'meetings', 'costs', 'minutes'].includes(raw?.live) ? raw.live : '';
  // The live lists it shows after its first (`live`): the makeovers and the reveals under one item, say
  const also = [...new Set((Array.isArray(raw?.also) ? raw.also : []).filter((k) => SHOW_KINDS.includes(k) && k !== live))];
  return {
    id: idOr(raw?.id, 'i_'),
    title: one(raw?.title, LIMITS.title),
    presenter: one(raw?.presenter),
    who: [...new Set((Array.isArray(raw?.who) ? raw.who : []).filter((s) => /^[a-z0-9-]{1,80}$/.test(String(s))))].slice(0, 3),
    notes: str(raw?.notes, LIMITS.notes),
    staffNote: str(raw?.staffNote, LIMITS.notes),
    // The presenter's report, in Markdown (./board-md.js), and who last wrote it when: written on the board page by
    // whoever presents the item, or in Board
    report: str(raw?.report, LIMITS.report),
    reportBy: one(raw?.reportBy, 120),
    reportAt: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(raw?.reportAt || '')) ? raw.reportAt : '',
    // How the screen draws it, as its writer chose ('' as it fits: REPORT_LOOKS, shownLook)
    reportLook: REPORT_LOOKS.includes(raw?.reportLook) ? raw.reportLook : '',
    // Its slides' order on the screen, as its presenter or Board set it (deckOf orderUnits): [] as they come
    slideOrder: [...new Set((Array.isArray(raw?.slideOrder) ? raw.slideOrder : []).map(String).filter((x) => SLIDE_PIECE.test(x)))].slice(0, 40),
    // What its presenter asks the board to vote on ("Move to approve the 2027 budget as presented."), written ahead:
    // on the agenda, the screen and the minutes template, where the secretary records who moved it and how it went
    motion: one(raw?.motion, LIMITS.motion),
    confidential: bool(raw?.confidential),
    live,
    also,
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
    // Typed in Board for the calendar invite (parking, which door, a gate code); the board page and emails show it too
    inviteNote: str(raw.inviteNote, 1000),
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
      // Decided in the meeting without the board page's vote (the last minutes approved from the agenda): not to vote on
      voice: bool(x?.voice),
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
      place: one(raw.invite.place, 400), location: one(raw.invite.location, 400), when: one(raw.invite.when, 60), notes: one(raw.invite.notes, 20),
      // Board's day, time and place put back on it after someone changed them in Google Calendar (functions/api/_board-calendar.js)
      putBackAt: one(raw.invite.putBackAt, 40), putBackFor: one(raw.invite.putBackFor, 200), differs: one(raw.invite.differs, 200), emails: (Array.isArray(raw.invite.emails) ? raw.invite.emails : []).map((e) => one(e, 200)).filter(Boolean).slice(0, 100),
      replies: cleanReplies(raw.invite.replies),
    } : null,
    // When the invite was deleted in Google Calendar (functions/api/_board-calendar.js): server-set
    inviteGone: one(raw.inviteGone, 40),
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
  const fileId = itemId && (ID.test(String(l.fileId || '')) || PSEUDO_STOP.test(String(l.fileId || ''))) ? String(l.fileId) : '';
  return {
    startedAt: isoAt(l.startedAt), endedAt: isoAt(l.endedAt), itemId, fileId,
    page: fileId && Number(l.page) > 0 ? Math.min(999, Math.floor(Number(l.page))) : 0,
    // Which part of a tall page is on the screen (deckOf: 0 the top, then down it; 1 the bottom of one in two)
    part: fileId && Number.isInteger(Number(l.part)) && Number(l.part) > 0 && Number(l.part) < PAGE_PARTS ? Number(l.part) : 0,
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
/**
 * An agenda item with something in it. A row added and left empty isn't on the agenda: the board never sees it, it
 * takes no time and no number, and the chair never stops on it (the editor keeps it, to fill in or delete)
 */
export const isFilled = (it) => !!(it && (it.title || it.presenter || it.who?.length || it.notes || it.report || it.motion || it.live || it.also?.length || it.about || it.docs?.length || it.confidential));
/**
 * The agenda's items in order, numbered the way the board page and the chair's screen show them (an empty row has
 * none): [{ id, title, label: '3.2', section, si, ii }], `ii` where the item sits in its part
 */
export function agendaItems(m) {
  return (m?.sections || []).flatMap((s, si) => {
    let n = 0;
    return s.items.flatMap((it, ii) => (isFilled(it) ? [{ id: it.id, title: it.title || LIVE_TITLES[it.live] || s.title || 'Item', presenter: it.presenter, label: `${si + 1}.${++n}`, section: s.title, si, ii }] : []));
  });
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
  const weight = (sec) => { const n = sec.items.filter(isFilled).length; return n ? n + (sec.items.some((it) => it.live && it.live !== 'minutes') ? 1 : 0) : 0.5; };
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
/**
 * A presenter's "nothing to report" (the report page's button, or Board's): kept as the report itself, so everything
 * that asks whether a report is in already counts it; shown quietly wherever reports show
 */
export const NOTHING_NEW = 'Nothing new to report this time.';
export const isNothingNew = (report) => String(report || '').trim() === NOTHING_NEW;

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
 * writes in it or uses it). A meeting from before agendaFrom counts by its look. One with a report written in it is
 * never a draft again: drafting it anew would lose the report.
 */
export const agendaIsDraft = (m, template = DEFAULT_TEMPLATE) => !m?.sections?.some((s) => s.items.some((it) => it.report || it.motion))
  && (!m?.sections?.some((s) => s.items.length)
    || ['template', 'last-meeting'].includes(m?.agendaFrom?.kind)
    || (!m?.agendaFrom && (isOutline(m.sections, template) || isOutline(m.sections))));
/** "Minutes of the Q3 Board Meeting (Aug 6)": the item that asks the board to approve the last minutes */
const minutesItemTitle = (prev) => `Minutes of the ${meetingName(prev)} (${shortDate(prev.date)})`;
/**
 * Which live facts an item shows, by what it's called, when nothing says: the makeovers ("Project updates and
 * upcoming reveals", "Projects update", "Makeovers"), the money ("Financial", "Treasurer's report"), events,
 * the next board meetings, the reveals. '' for anything else
 */
export function liveOfTitle(title, section = '') {
  const t = String(title || '').toLowerCase();
  // The Qualification Committee's report: what makeovers cost and what the money can start (Travis, Nov 4 2026)
  if (/\bqualification\b|\bselection committee\b/.test(t)) return 'costs';
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
/**
 * An item someone reports on: it has a presenter, and isn't the roll call, the welcome or the vote on the last
 * minutes. Its presenter is asked for a report on the board page; Board counts the ones in.
 */
export const reportsOn = (it) => isFilled(it) && !!(it.who?.length || String(it.presenter || '').trim()) && it.live !== 'minutes' && !facesOf(it);
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
            also: minutes ? [] : it.also,
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
 * own notes, a staff-only file or an agenda row left empty; a live list with
 * no title called what it shows. Null for a meeting not shared yet.
 */
export function forBoard(m) {
  if (!m?.shared) return null;
  const seen = new Set(m.files.filter((f) => !f.staffOnly).map((f) => f.id));
  return {
    ...m,
    sections: m.sections.map((s) => ({ ...s, items: s.items.filter(isFilled).map(({ staffNote, ...it }) => ({ ...it, title: it.title || LIVE_TITLES[it.live] || '', docs: (it.docs || []).filter((id) => seen.has(id)) })) })),
    files: m.files.filter((f) => !f.staffOnly),
    // Named here, where the quarter its calendar invite says is known
    title: meetingName(m),
    calendar: undefined,
    invite: m.invite ? { meet: m.invite.meet } : null,
    inviteGone: undefined,
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
/** An item's documents (docsOf): each once, by the copy the screen shows */
export const itemDocs = (m, it, meetings = []) => docsOf(itemFiles(m, it, meetings));
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
 * meeting's minutes (uploaded before this one) with "approve the minutes", a report named for someone with what they
 * present, else the one item whose name it shares
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
  // Named for someone ("Holly’s Report"): what they present, the one they present alone when there's more than one
  const theirs = items.filter(({ it }) => wordsOf(it.presenter).some((w) => words.has(w)));
  const alone = theirs.filter(({ it }) => wordsOf(it.presenter).length === 1);
  if (alone.length === 1 || (!alone.length && theirs.length === 1)) return (alone[0] || theirs[0]).it.id;
  const scored = items.map(({ it }) => ({ it, n: wordsOf(it.title).filter((w) => words.has(w)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  return scored.length && (scored.length === 1 || scored[0].n > scored[1].n) ? scored[0].it.id : '';
}

/**
 * The meeting as the screen shows it, one stop at a time: the cover; "since we last met" when the agenda asks to
 * approve the last meeting's minutes; then each part of the agenda, opened by its own card when it has no items or
 * more than one (a part of one item goes straight to it), each item's card and the pages of each of its documents as
 * an open book, two side by side a stop (spreadsOf; itemDocs: a statement and its PDF printout are one, shown once);
 * the files on no item; the close. `pages`: { fileId: page count } as far as known (1 until then); `parts`:
 * { fileId: [how each page shows] } (./board/docs.js partsOf: 0 not at all, 1 beside the next, 2 alone); `meetings`
 * finds the last meeting's minutes.
 * → [{ key, kind: cover | since | section | item | doc | end, itemId, fileId, page, part, pages, sheets, n, sectionId }]
 * where a document's `page` and `part` are its spread's first sheet, `pages` the pages on it and `sheets` its
 * [page, part]s, and n is the item's place in agendaItems (-1 for the cover, a part's card, the loose files and the close)
 */
/** The live lists an item can show, beside the vote on the last minutes ('minutes', only ever its first) */
export const SHOW_KINDS = ['projects', 'reveals', 'events', 'cash', 'meetings', 'costs'];
/** Everything an item shows live, in order: its first (`live`), then the others (`also`) */
export const showsOf = (it) => [...new Set([it?.live, ...(it?.also || [])].filter((k) => SHOW_KINDS.includes(k)))];
/**
 * A stop that's no file: the report on an item that shows live facts, its motion on a slide of its own ("The
 * decision"), one of its other live lists, or one of QuickBooks' slides
 */
const PSEUDO_STOP = /^(report|decision|live:(projects|reveals|events|cash|meetings|costs)|books:(year|store|act|budget|pos))$/;
/**
 * QuickBooks' slides after the money, as the books have them: the year against last year (by month, else the year so
 * far against the same days), the store (its own accounts, ./board/money.js storeOf), the statement of activities,
 * QuickBooks' budget against it (the board's budget), the statement of financial position
 */
export function booksDraw(books) {
  if (!books || typeof books.revenue !== 'number') return [];
  const s = books.statements;
  return [
    books.monthly?.months?.length || books.lastYear ? 'year' : '',
    books.store?.sales || books.store?.cost ? 'store' : '',
    s?.activity?.length ? 'act' : '',
    books.budget?.rows?.length && books.budget.asOf === s?.asOf ? 'budget' : '',
    s?.position?.length ? 'pos' : '',
  ].filter(Boolean);
}
/**
 * An item's slides after its own card, in the deck's order: each live list after its first, and after the money
 * QuickBooks' slides. → [{ kind: 'live' | 'books', id: 'live:reveals' | 'books:act', k }]
 */
export const slidesOf = (it, books) => {
  const drawn = booksDraw(books);
  return showsOf(it).flatMap((k, i) => [...(i ? [{ kind: 'live', id: `live:${k}`, k }] : []), ...(k === 'cash' ? drawn.map((b) => ({ kind: 'books', id: `books:${b}`, k: b })) : [])]);
};
/**
 * A statement's main lines (rows as functions/api/_quickbooks.js statementRows and budgetOf make them: { k, label, d,
 * a, p, … }): each top heading; under it its groups' totals and, when it has no groups (Cost of Goods Sold, Other
 * Income), its own accounts; when it has groups and accounts of its own too (Expenses: Payroll and Building, then a
 * dozen accounts), those accounts as one "Other …" line, so the main lines always add up to its total; then the
 * subtotals and nets. `keep(r)` keeps a line besides (one with a note on it)
 */
export function mainLines(rows, keep = () => false) {
  const out = [];
  const add = (list, k) => (list.every((x) => typeof x[k] !== 'number') ? null : Math.round(list.reduce((t, x) => t + (typeof x[k] === 'number' ? x[k] : 0), 0) * 100) / 100);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!(r.k === 'head' && r.d === 0)) { if (r.k === 'sum' || keep(r)) out.push(r); continue; }
    let j = i + 1;
    while (j < rows.length && !(rows[j].k === 'total' && rows[j].d === 0)) j++;
    const body = rows.slice(i + 1, j);
    const groups = body.some((x) => x.k === 'head' && x.d === 1);
    const own = body.filter((x) => x.k === 'acct' && x.d === 1);
    out.push(r);
    for (const x of body) if ((x.k === 'total' && x.d === 1) || (!groups && x.k === 'acct' && x.d === 1) || keep(x)) out.push(x);
    if (groups && own.length) out.push({ k: 'acct', label: `Other ${r.label.toLowerCase()}`, d: 1, other: true, ...Object.fromEntries(['a', 'p', 'b', 'y'].map((k) => [k, add(own, k)]).filter(([, v]) => v !== null)) });
    if (j < rows.length) out.push(rows[j]);
    i = j;
  }
  return out;
}

/** The most of a statement's lines one slide holds at the size a room reads them (./board/books.js BooksSlide) */
export const SLIDE_LINES = 10;
/**
 * Where each line of mainLines(rows, keep) sits in `rows`: its own place, or (the "Other …" line, made up) just after
 * the line before it
 */
export const linePlaces = (rows, lines) => { let last = -1; return lines.map((l) => { const i = rows.indexOf(l); last = i >= 0 ? i : last + 0.5; return last; }); };
/**
 * A statement's main lines in slides a room reads, never smaller to fit: each top heading with its lines on one slide
 * where that takes no more slides than filling each in turn would (the revenue, then the expenses), else filled in
 * turn; a heading cut short goes on, "continued", on the next (a line for that), never a slide ending on a heading or
 * starting on the made-up "Other …" line. → each slide's first line, as its place in `rows` ([0]: one slide)
 */
export function statementBreaks(rows, max = SLIDE_LINES) {
  const lines = mainLines(rows || []);
  const at = linePlaces(rows || [], lines);
  const top = (i) => lines[i].k === 'head' && lines[i].d === 0;
  // From line `k`, a slide's worth (`cap` lines): one line less when it goes on with a heading begun before
  const take = (k, to, cap) => {
    let end = Math.min(to, k + (k && !top(k) ? cap - 1 : cap));
    while (end < to && end - 1 > k && (lines[end - 1].k === 'head' || lines[end].other)) end--;
    return end;
  };
  // Lines `from` to `to` filled in turn, as evenly as the same number of slides allows (never one line left alone)
  const fill = (from, to) => {
    const run = (cap) => { const out = []; for (let k = from; k < to; k = take(k, to, cap)) out.push(k); return out; };
    const most = run(max);
    const even = run(Math.min(max, Math.max(2, Math.ceil((to - from + most.length - 1) / most.length))));
    return even.length === most.length ? even : most;
  };
  // Each top heading with what follows it to the next (its total, the sums under it)
  const blocks = [];
  lines.forEach((l, i) => { if (!blocks.length || top(i)) blocks.push([i, i + 1]); else blocks.at(-1)[1] = i + 1; });
  const byBlock = [];
  let used = Infinity;
  for (const [from, to] of blocks) {
    if (used + (to - from) <= max) { used += to - from; continue; }
    const starts = fill(from, to);
    byBlock.push(...starts);
    used = to - starts.at(-1) + (starts.length > 1 ? 1 : 0);
  }
  const inTurn = fill(0, lines.length);
  const starts = byBlock.length <= inTurn.length ? byBlock : inTurn;
  return starts.length ? starts.map((i) => at[i]) : [0];
}
/** A statement 'books' slide's rows: the statement of activities, of financial position, or QuickBooks' budget */
export const statementRows = (books, kind) => (kind === 'act' ? books?.statements?.activity : kind === 'pos' ? books?.statements?.position : kind === 'budget' ? books?.budget?.rows : null) || [];

// ─── A report on the meeting's screen, slide by slide ───────────────

// Every size on the screen is on one unit (portal.css --bs-u), so a report's slide is the same box on every screen, in
// its words' own size (em): measured at 1280×720 and 1920×1080, Nov 2 2026 (a taller screen, 4:3, holds more; a phone
// scrolls). The report's box under a one-line title, two columns and the gap between them, the spacing of .rp
const SLIDE = { width: 42.6, gap: 1.957, height: 17.56, line: 1.42, pAfter: 0.75, hSize: 1.1, hLine: 1.485, hBefore: 0.825, hAfter: 0.44, indent: 1.35, listAfter: 0.8, itemGap: 0.2, quoteIndent: 1.164, quotePad: 1.4, quoteAround: 1.3, titleSize: 1.913, titleLine: 2.028, titleWidth: 34 };
const COL = (SLIDE.width - SLIDE.gap) / 2;
// How wide each character is (Outfit for the words, bold; Libre Baskerville for the title), per 100 of its size: ASCII
// 32 to 126, then a few others; anything else as an average letter (a CJK one as a square)
const ADV = Object.fromEntries(Object.entries({
  r: '21,26,40,64,59,66,66,24,30,30,49,54,27,46,29,39,66,35,54,54,58,54,56,51,55,56,27,27,54,54,54,51,75,66,62,66,74,59,57,78,71,26,45,65,55,84,71,80,60,82,62,54,58,68,66,96,65,63,56,34,39,34,45,50,28,58,58,48,58,54,33,58,55,22,29,50,22,86,55,57,58,58,40,43,33,52,49,73,48,50,45,32,28,32,54',
  b: '19,29,46,66,60,68,69,25,31,31,49,56,28,46,30,38,67,38,56,56,60,56,57,52,56,57,29,28,56,56,56,50,76,69,64,66,75,61,59,79,73,29,49,69,56,86,74,82,62,82,64,57,62,70,68,98,67,65,58,35,38,35,47,51,32,60,60,49,60,55,36,58,57,26,33,55,26,87,57,58,60,60,42,46,35,54,52,76,51,52,48,34,30,34,56',
  t: '26,30,38,69,63,70,88,20,32,32,48,55,25,45,25,32,74,43,64,63,65,58,66,51,62,66,27,28,58,61,58,39,105,80,79,81,90,75,68,87,93,42,40,81,74,113,93,93,71,94,80,65,82,87,79,122,84,75,79,38,47,38,48,72,31,56,66,55,68,57,43,60,70,35,38,65,34,110,72,65,69,66,49,46,37,70,61,88,64,64,56,34,28,34,55',
}).map(([k, v]) => [k, v.split(',').map(Number)]));
const ADV_MORE = { '’': [25, 26, 23], '‘': [25, 26, 24], '“': [43, 49, 44], '”': [43, 49, 44], '–': [55, 57, 72], '—': [85, 87, 113], '…': [75, 84, 74], '•': [33, 35, 46] };
const KIND = { r: 0, b: 1, t: 2 };
function advance(ch, kind) {
  const c = ch.codePointAt(0);
  // (a little under each letter's own width: the browser kerns pairs, "To", "av")
  if (c >= 32 && c < 127) return ADV[kind][c - 32] / 101.5;
  if (ADV_MORE[ch]) return ADV_MORE[ch][KIND[kind]] / 101.5;
  return c >= 0x2e80 ? 1 : kind === 't' ? 0.68 : 0.58;
}
/** How many lines words take in a box `width` em wide (their size), wrapped as the browser does: at spaces, a word too
 *  long for a line broken inside it, a line break kept */
function linesIn(text, width, kind = 'r') {
  const runs = kind === 't' ? [{ text: String(text || '') }] : mdInline(String(text || ''));
  let lines = 1;
  let at = 0;
  let word = 0;
  let wordBold = false;
  const space = (k) => advance(' ', k);
  const place = () => {
    if (!word) return;
    const gap = at ? space(wordBold ? 'b' : kind) : 0;
    if (at + gap + word <= width) at += gap + word;
    else if (word <= width) { lines++; at = word; } else { lines += at ? 1 : 0; lines += Math.ceil(word / width) - 1; at = word % width || width; }
    word = 0;
  };
  for (const r of runs) {
    if (r.br) { place(); lines++; at = 0; continue; }
    const k = kind === 't' ? 't' : r.b ? 'b' : kind;
    for (const ch of String(r.text || '')) {
      if (ch === ' ' || ch === '\n') { place(); continue; }
      word += advance(ch, k);
      wordBold = k === 'b';
    }
  }
  place();
  return lines;
}
/** A block's height in a column `width` em wide; in a list item a paragraph has no space after it */
function heightOf(b, width, inItem = false) {
  if (b.t === 'p') return linesIn(b.text, width) * SLIDE.line + (inItem ? 0 : SLIDE.pAfter);
  if (b.t === 'h') return SLIDE.hBefore + linesIn(b.text, width / SLIDE.hSize, 'b') * SLIDE.hLine + SLIDE.hAfter;
  if (b.t === 'quote') return SLIDE.quoteAround + SLIDE.quotePad + b.blocks.reduce((n, x) => n + heightOf(x, width - SLIDE.quoteIndent), 0);
  if (b.t === 'ul' || b.t === 'ol') return b.items.reduce((n, it) => n + itemHeight(it, width - SLIDE.indent), 0) + (inItem ? 0 : SLIDE.listAfter);
  // (a rule inside a point or a callout: drawn there, a line's room above and below it)
  if (b.t === 'hr') return 2.6;
  return 0;
}
const itemHeight = (blocks, width) => SLIDE.itemGap + blocks.reduce((n, x) => n + heightOf(x, width, true), 0);

/** Blocks back into Markdown (the text of each is the Markdown it was written in), indented under a list's point */
function mdOf(blocks, pad = '') {
  return blocks.map((b) => {
    if (b.t === 'p') return b.text.split('\n').map((l) => pad + l).join('\n');
    if (b.t === 'h') return `${pad}### ${b.text}`;
    if (b.t === 'hr') return `${pad}---`;
    if (b.t === 'quote') return mdOf(b.blocks).split('\n').map((l) => `${pad}> ${l}`.trimEnd()).join('\n');
    return b.items.map((it, k) => pointMd(b, it, b.start + k, pad)).join('\n');
  }).join('\n\n');
}
/** One point of a list as Markdown: its mark ("-", "4.") and its words, what's under it indented below */
function pointMd(list, it, n, pad = '') {
  const mark = list.t === 'ol' ? `${n}.` : '-';
  const [first, ...rest] = it;
  const head = first?.t === 'p' ? first.text.split('\n').join(`\n${pad}${' '.repeat(mark.length + 1)}`) : '';
  const under = mdOf(first?.t === 'p' ? rest : it, `${pad}${' '.repeat(mark.length + 1)}`);
  return `${pad}${mark}${head ? ` ${head}` : ''}${under ? `\n${under}` : ''}`;
}

/** Where a paragraph can go on to the next slide → [{ at, by }]: `at` the index its rest starts at; `by` 'sentence'
 *  (after . ! ? ؟ and a closing quote or bracket, before a capital, a number or a letter of a script with no capitals),
 *  'line' (after a line break kept in it) or 'word' (between words, the last resort). Never inside bold, italic, a
 *  link or an open quotation (a backslash's letter is a letter); never after "Dr." "U.S." "1." or a one-letter
 *  initial; never where the rest would read as a point, a heading or a callout ("* Includes…", "1. Approve…"). One pass */
const ABBR = /(?:^|[\s(])(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|inc|ltd|co|corp|no|approx|dept|est|mt|ave|blvd|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m|[a-z]|\d{1,3})\.$/i;
const BLOCKY = /^(?:[-*+•][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|> ?|(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$)/;
const STARTS = /["“‘(¿¡*_[]?[\p{Lu}\p{Lo}\p{N}]/u;
function cutsIn(text, upTo = Infinity) {
  // First, which marks are a pair, read as the screen reads them (./board-md.js mdInline): one opens before a letter,
  // closes after one, an _ inside a word is a letter; a mark with no partner, or a [ with no ], is only a character
  const marks = [];
  const brackets = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') { brackets.push(i); continue; }
    if (c === ']') { brackets.pop(); continue; }
    if (c !== '*' && c !== '_') continue;
    const m = c === '*' && text[i + 1] === '*' ? '**' : c;
    const prev = text[i - 1] || ' ';
    const next = text[i + m.length] || ' ';
    const word = /[\p{L}\p{N}]/u;
    const canOpen = !/\s/.test(next) && !(m === '_' && word.test(prev));
    const canClose = !/\s/.test(prev) && !(m === '_' && word.test(next));
    const k = stack.map((x) => x.m).lastIndexOf(m);
    if (k >= 0 && canClose) { marks.push(stack[k], { i, m }); stack.splice(k); } else if (canOpen) stack.push({ i, m });
    i += m.length - 1;
  }
  const lone = new Set(brackets);
  const markAt = new Map(marks.map((x) => [x.i, x.m]));
  const out = [];
  // What's open where we are: bold, italic (* or _), as a stack (closed innermost first); a link; a quotation
  const open = [];
  let link = 0;
  let quote = 0;
  const end = Math.min(text.length, upTo);
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    const m = markAt.get(i);
    if (m) {
      const k = open.lastIndexOf(m);
      if (k >= 0) open.splice(k, 1); else open.push(m);
      i += m.length - 1;
      continue;
    }
    if (c === '[' && !lone.has(i)) { link++; continue; }
    if (c === ']' && link) { link--; if (text[i + 1] === '(') { const j = text.indexOf(')', i + 2); if (j > 0) i = j; } continue; }
    if (c === '“') { quote++; continue; }
    if (c === '”') { quote = Math.max(0, quote - 1); continue; }
    if (c === '"') { quote = quote > 0 ? quote - 1 : quote + 1; continue; }
    if (c !== ' ' && c !== '\n') continue;
    // At a space or a line break: where the next word starts
    let j = i;
    while (j < text.length && (text[j] === ' ' || text[j] === '\n')) j++;
    if (j >= text.length || link) { i = j - 1; continue; }
    const rest = text.slice(j, j + 12);
    const before = text.slice(Math.max(0, i - 12), i);
    const broke = text.slice(i, j).includes('\n');
    if (!BLOCKY.test(rest)) {
      const trimmed = before.replace(/["”’)\]*_]+$/, '');
      const kind = /[.!?؟。]$/.test(trimmed) && STARTS.test(rest.replace(/^[*_]+/, '')) && !(trimmed.endsWith('.') && ABBR.test(trimmed)) ? 'sentence' : broke ? 'line' : 'word';
      // Inside a quotation: only when nothing else will do; inside bold or italic: closed on this slide, opened again on
      // the next (as a typesetter does)
      out.push({ at: j, by: quote > 0 ? `${kind}-quoted` : kind, open: open.slice() });
    }
    i = j - 1;
  }
  return out;
}

/**
 * A report as the meeting's screen shows it, slide by slide: each slide's Markdown, in order (at least one). One that
 * fits is one slide, as written. A longer one goes on to as many slides as it needs, every one at the size the room
 * reads (never smaller to fit more): each fills its two columns, a new heading starting a slide where it can, a list
 * going on (its numbers too) between its points, a paragraph between its sentences only when it must (longer than a
 * slide, or a slide would be left mostly empty); never a heading last on a slide; the slides as even as the same
 * number of them allows. A line of "---" starts a new slide there. `title`: the item's, its lines taking room above
 */
export const reportSlides = (md, opts) => cutReport(md, opts).slides;
/** The heading each slide goes on under, when it begins partway into that heading's part: "…, continued" over it (the
 *  screen draws it; reportSlides leaves room for it) → one per slide, '' where a slide starts its own */
export const reportSlideHeads = (md, opts) => cutReport(md, opts).heads;
function cutReport(md, { title = '', confidential = false, look = '' } = {}) {
  const text = String(md || '').trim();
  if (!text) return { slides: [''], heads: [''] };
  const shown = shownLook(text, look);
  const key = `${title}\u0000${confidential ? 1 : 0}\u0000${shown}\u0000${text}`;
  const hit = SLIDES_SEEN.get(key);
  if (hit) return hit;
  const pages = shown === 'words' ? reportSlidesFrom(text, title, confidential) : pointSlides(text);
  const out = { slides: pages.map(pageMd), heads: pages.map((pg) => (pg[0]?.kind === 'cont' ? pg[0].b.text : '')) };
  if (SLIDES_SEEN.size > 200) SLIDES_SEEN.delete(SLIDES_SEEN.keys().next().value);
  SLIDES_SEEN.set(key, out);
  return out;
}
const SLIDES_SEEN = new Map();

/**
 * How a report is drawn on the meeting's screen: its item's `reportLook`, chosen beside the editor (./board-coach.js
 * reportLooks). '' as it fits: a few short points as cards (mdPoints), anything else its words in columns, on as many
 * slides as they take; 'list' its words always, never cards; 'cards' each point a card; 'numbers' each point's figure
 * large over its words. Cards and numbers are for a report that is all points (a line before them at most), each a line
 * or two (mdPoints `all`), up to six a slide; one that isn't any more shows as it fits, so nothing written is left off
 */
export const REPORT_LOOKS = ['list', 'cards', 'numbers'];
/** The most cards (or numbers) one slide holds */
export const CARDS_PER_SLIDE = 6;
/** How the screen draws a report with this look → 'cards' | 'numbers' | 'words' (once for each wording: the screen asks
 *  on every slide) */
export function shownLook(md, look = '') {
  if (look === 'list') return 'words';
  const text = String(md || '');
  const key = `${look}\u0000${text}`;
  const hit = LOOKS_SEEN.get(key);
  if (hit) return hit;
  let out = '';
  if (look === 'cards' || look === 'numbers') {
    const p = mdPoints(text, { all: true });
    if (p && (look === 'cards' || p.points.every((t) => mdNumber(t)))) out = look;
  }
  out ||= mdPoints(text) ? 'cards' : 'words';
  if (LOOKS_SEEN.size > 200) LOOKS_SEEN.delete(LOOKS_SEEN.keys().next().value);
  LOOKS_SEEN.set(key, out);
  return out;
}
const LOOKS_SEEN = new Map();
/** Points as cards or numbers, slide by slide: as few slides as hold them (six a slide, and about as many words as a
 *  slide of cards reads), as even as that many allows, two at least on each; the line before them on the first */
function pointSlides(text) {
  const blocks = mdBlocks(text);
  const lead = blocks.length === 2 ? blocks[0] : null;
  const list = blocks.at(-1);
  const n = list.items.length;
  const k = Math.max(1, Math.min(Math.floor(n / 2), Math.max(Math.ceil(n / CARDS_PER_SLIDE), Math.ceil(mdWords(text) / POINTS_WORDS))));
  if (k === 1) return [[{ kind: 'raw', md: text }]];
  const pages = [];
  let at = 0;
  for (let s = 0; s < k; s++) {
    const take = Math.floor(n / k) + (s < n % k ? 1 : 0);
    const pg = list.items.slice(at, at + take).map((it, j) => ({ kind: 'li', list, it, n: list.start + at + j }));
    if (!s && lead) pg.unshift({ kind: 'p', b: lead });
    pages.push(pg);
    at += take;
  }
  return pages;
}

function reportSlidesFrom(text, title, confidential) {
  const blocks = mdBlocks(text);
  const forced = blocks.some((b) => b.t === 'hr');
  // A short one is set large on one slide (screen.js ReportFit), as written
  if (!forced && mdWords(text) < 40) return [[{ kind: 'raw', md: text }]];
  const titleLines = Math.min(3, linesIn(title, SLIDE.titleWidth / SLIDE.titleSize, 't'));
  // Each column's height, a little kept back for what can't be known here (a font's own rounding, a long word)
  const H = (SLIDE.height - (titleLines - 1) * SLIDE.titleLine - (confidential ? 2.2 : 0)) * 0.94;
  // What a slide is made of, in order: a heading, a paragraph, a point of a list, a callout; "---" a new slide
  const units = [];
  for (const b of blocks) {
    if (b.t === 'hr') { units.push({ kind: 'break' }); continue; }
    if (b.t === 'ul' || b.t === 'ol') {
      b.items.forEach((it, k) => { const after = k === b.items.length - 1 ? SLIDE.listAfter : 0; units.push({ kind: 'li', list: b, it, n: b.start + k, h: itemHeight(it, COL - SLIDE.indent) + after, h1: itemHeight(it, SLIDE.width - SLIDE.indent) + after, after }); });
      continue;
    }
    units.push(unitOf(b));
  }
  const pages = paginate(units, H);
  // One slide: as written
  if (pages.length === 1 && !forced) return [[{ kind: 'raw', md: text }]];
  // As even as the same number of slides allows: the least each slide can hold and still need no more of them
  if (pages.length > 1 && !forced) {
    let lo = 0.5;
    let hi = 1;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (paginate(units, H * mid).length <= pages.length) hi = mid; else lo = mid; }
    const even = paginate(units, H * hi);
    const ok = (pg) => fitsSlide(pg, H) || pg.filter((u) => u.kind !== 'cont').length === 1;
    if (even.length === pages.length && even.every(ok)) return even;
  }
  const kept = pages.filter((pg) => pg.some((u) => u.kind !== 'cont'));
  return kept.length ? kept : [[{ kind: 'raw', md: '' }]];
}
const unitOf = (b) => ({ ...(b.t === 'p' ? { kind: 'p', after: SLIDE.pAfter, lines: linesIn(b.text, COL) } : b.t === 'h' ? { kind: 'h', after: SLIDE.hAfter } : { kind: 'quote', after: SLIDE.quoteAround / 2 }), b, h: heightOf(b, COL), h1: heightOf(b, SLIDE.width) });

/** Whether these fill no more than a slide's two columns `H` high: a paragraph runs on into the next column (two lines
 *  at least on each side), a point or a callout moves whole, a heading goes with the start of what follows it */
function fitsSlide(units, H) {
  // One column the slide's width, as the screen tries first
  if (units.length && units.reduce((n, u) => n + u.h1, 0) - units.at(-1).after <= H + 1e-6) return true;
  let col = 0;
  let used = 0;
  const next = () => { col++; used = 0; return col < 2; };
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const lead = u.kind === 'h' && units[i + 1] ? Math.min(units[i + 1].h - units[i + 1].after, 2 * SLIDE.line) : 0;
    if (used + u.h - u.after + lead <= H + 1e-6) { used += u.h; continue; }
    if (u.kind === 'p') {
      // Its lines, as many as the column holds (two at least, two left for the next), the rest on
      let left = u.lines;
      let room = Math.floor((H - used) / SLIDE.line + 1e-6);
      while (left > 0) {
        if (room >= left) { used += left * SLIDE.line + u.after; left = 0; break; }
        const take = room >= 2 && left - room >= 2 ? room : 0;
        left -= take;
        if (!next()) return false;
        room = Math.floor(H / SLIDE.line + 1e-6);
      }
      continue;
    }
    // An empty column takes it (without what follows a heading, when that won't fit with it); too tall for one, no
    if (!used) { if (u.h - u.after <= H + 1e-6) { used += u.h; continue; } return false; }
    if (!next()) return false;
    i--;
  }
  return true;
}

/** The units into slides of two columns `H` high (see reportSlides) */
function paginate(units, H) {
  const pages = [];
  let cur = [];
  // The heading whose part this is (none after a "---": a slide the writer began is theirs)
  let under = null;
  const close = () => { if (cur.some((u) => u.kind !== 'cont')) pages.push(cur); cur = []; };
  const begin = (u) => { if (!cur.length && under && u.kind !== 'h') cur.push({ kind: 'cont', b: under.b, h: under.h, h1: under.h1, after: under.after }); };
  const fill = (xs) => xs.reduce((n, u) => n + u.h, 0) / (2 * H);
  // Nothing of its own on this slide yet (only the heading it goes on under, or headings that lead into it)
  const fresh = () => cur.every((u) => u.kind === 'cont' || u.kind === 'h');
  // The most of a paragraph that goes on this slide, cut where `by` allows → { head, rest } or null
  const cutOf = (u, by) => {
    // (no slide holds more than about 3,000 of its characters: no cut past that is worth measuring)
    const cuts = cutsIn(u.b.text, 4000).filter((c) => by.includes(c.by));
    const headOf = (c) => `${u.b.text.slice(0, c.at).trimEnd()}${c.open.slice().reverse().join('')}`;
    const restOf = (c) => `${c.open.join('')}${u.b.text.slice(c.at)}`;
    let lo = 0;
    let hi = cuts.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fitsSlide([...cur, unitOf({ t: 'p', text: headOf(cuts[mid]) })], H)) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // Read back the same words either side of it (bold or italic closed and opened again as the screen reads them),
    // else the next one down
    const same = mdPlain(u.b.text).split(/\s+/).join(' ');
    for (let k = best, tries = 0; k >= 0 && tries < 40; k--, tries++) {
      if (`${mdPlain(headOf(cuts[k]))} ${mdPlain(restOf(cuts[k]))}`.split(/\s+/).join(' ') === same) return { head: unitOf({ t: 'p', text: headOf(cuts[k]) }), rest: unitOf({ t: 'p', text: restOf(cuts[k]) }) };
    }
    return null;
  };
  const queue = [...units];
  while (queue.length) {
    const u = queue.shift();
    if (u.kind === 'break') { close(); under = null; continue; }
    begin(u);
    if (u.kind === 'h') under = u;
    if (fitsSlide([...cur, u], H)) { cur.push(u); continue; }
    if (u.kind === 'p') {
      // Between its sentences (or the lines it keeps): on this slide when it's longer than a slide or this one is
      // mostly empty; on a fresh slide always; between words only when nothing else will do there
      const alone = !fitsSlide([u], H);
      const cut = alone || fill(cur) < 0.6 || fresh() ? cutOf(u, ['sentence', 'line']) || (fresh() ? cutOf(u, ['sentence-quoted', 'line-quoted']) || cutOf(u, ['word']) || cutOf(u, ['word-quoted']) : null) : null;
      if (cut) { cur.push(cut.head); queue.unshift(cut.rest); close(); continue; }
    }
    // A slide of its own (too long for one even so, one point or one word: it has one, as large as it fits: ReportFit)
    if (fresh()) { cur.push(u); continue; }
    // Never a heading last on a slide: it goes on with what follows it, on the next
    const carry = [];
    while (cur.length && cur.at(-1).kind === 'h') carry.unshift(cur.pop());
    close();
    queue.unshift(...carry, u);
  }
  close();
  return pages;
}

/** A slide's units as Markdown: a list's points that follow on from each other as one list, numbered as they were */
function pageMd(units) {
  const parts = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.kind === 'cont') continue;
    if (u.kind === 'raw') { parts.push(u.md); continue; }
    if (u.kind === 'li') {
      const pts = [pointMd(u.list, u.it, u.n)];
      while (units[i + 1]?.kind === 'li' && units[i + 1].list === u.list) pts.push(pointMd(units[i + 1].list, units[i + 1].it, units[++i].n));
      parts.push(pts.join('\n'));
      continue;
    }
    parts.push(mdOf([u.b]));
  }
  return parts.join('\n\n');
}
/** An item's report, slide by slide (reportSlides, with its title as the screen shows it) */
const slideOpts = (it) => ({ title: it.title || LIVE_TITLES[it.live] || '', confidential: !!it.confidential, look: it.reportLook || '' });
export const slidesOfItem = (it) => (hasReport(it) ? reportSlides(it.report, slideOpts(it)) : []);
/** …and the heading each of those slides goes on under (reportSlideHeads) */
export const slideHeadsOfItem = (it) => (hasReport(it) ? reportSlideHeads(it.report, slideOpts(it)) : []);

/** A report with something in it: written, and not "nothing new this time" */
export const hasReport = (it) => !!String(it?.report || '').trim() && !isNothingNew(it.report) && /[\p{L}\p{N}]/u.test(mdPlain(it.report));
/**
 * An item whose motion the screen shows on a slide of its own, "The decision" (deckOf): it has one (the vote on the
 * last minutes always does) and more to show besides it (a report, the presenter's notes, live facts)
 */
export const decidesAlone = (it) => !!(String(it?.motion || '').trim() || it?.live === 'minutes') && (hasReport(it) || !!String(it?.notes || '').trim() || showsOf(it).length > 0 || !!facesOf(it));
/**
 * An item whose report is a slide of its own, right after the item's (deckOf): its own slide is full of something
 * else (live facts, the board's faces) or carries the presenter's notes, which the report would crowd off
 */
export const reportAlone = (it) => hasReport(it) && (showsOf(it).length > 0 || !!facesOf(it) || !!String(it?.notes || '').trim());

/** A financial statement as a file (a balance sheet, a P&L): QuickBooks draws them once it's connected. A budget isn't one */
export const isStatement = (f) => f?.kind === 'financials' && !/budget/i.test(String(f.name || ''));

/** A spread's pages in words ([0, 1] → "pages 1–2", [0, 2] past a blank one → "pages 1 and 3", [4] → "page 5") */
export const pagesText = (pages, word = 'page') => (pages.length > 1 ? `${word}s ${pages[0] + 1}${pages[1] === pages[0] + 1 ? '–' : ' and '}${pages[1] + 1}` : `${word} ${(pages[0] || 0) + 1}`);
/** The most parts a very tall page is shown in (./board/docs.js showOf), each like a page of its own */
export const PAGE_PARTS = 8;
/**
 * A document's pages as the screen shows them, an open book: two sheets side by side a stop, each sheet a page
 * ([page, 0]) or, of a very tall one (a long screenshot, a scroll: `of` −n), one of its n parts top to bottom
 * ([page, part]); a wide page (a slide, a landscape sheet: 2) a stop of its own; a blank one (0) none unless every
 * page is → [[[0, 0], [1, 0]], [[2, 0]], …]
 */
export function spreadsOf(count, of) {
  const all = Array.from({ length: Math.max(1, count) }, (_, p) => p);
  const shown = all.some((p) => of(p) !== 0) ? all.filter((p) => of(p) !== 0) : all;
  const sheets = shown.flatMap((p) => (of(p) < 0 ? Array.from({ length: Math.min(PAGE_PARTS, Math.round(-of(p))) }, (_, k) => [p, k]) : [[p, 0]]));
  const out = [];
  for (let i = 0; i < sheets.length;) {
    const two = i + 1 < sheets.length && of(sheets[i][0]) !== 2 && of(sheets[i + 1][0]) !== 2;
    out.push(two ? [sheets[i], sheets[i + 1]] : [sheets[i]]);
    i += two ? 2 : 1;
  }
  return out;
}
export function deckOf(m, { pages = {}, parts = {}, meetings = [], books = null } = {}) {
  const drawn = booksDraw(books);
  // A statement as a file stays off the screen only once QuickBooks draws the statements themselves
  const drawsStatements = drawn.includes('act') || drawn.includes('pos');
  const out = [{ key: 'cover', kind: 'cover', itemId: '', fileId: '', page: 0, n: -1, sectionId: '' }];
  if (m.sections.some((s) => s.items.some((it) => it.live === 'minutes' && it.about))) out.push({ key: 'since', kind: 'since', itemId: '', fileId: '', page: 0, n: -1, sectionId: '' });
  // QuickBooks' slides once, after the first item that shows the money (a second one shows the figures, not them again)
  let booked = false;
  const add = (it, files, n, sectionId) => {
    // Its slides in pieces that move together (slideOrder, as its presenter or Board set them): its own slide, the
    // report (on its own slide's first when nothing else fills that: then one piece), each live list or QuickBooks'
    // statement, each document, the vote
    const units = [];
    const piece = (id) => { let u = units.find((x) => x.id === id); if (!u) { u = { id, stops: [] }; units.push(u); } return u; };
    const push = (id, stop) => piece(id).stops.push({ ...stop, unit: id });
    push('item', { key: it.id, kind: 'item', itemId: it.id, fileId: '', page: 0, n, sectionId });
    // An item that shows live facts (the makeovers, the money…) or the board's faces fills its own slide with them, and
    // one with notes keeps them there: its report is a slide of its own, right after (nothing new to report needs none)
    // A report longer than a slide goes on to as many as it needs (reportSlides): after its item's own slide (which
    // shows the first, when the report is there), each a 'report' stop, page by page
    const slides = slidesOfItem(it);
    for (let p = reportAlone(it) ? 0 : 1; p < slides.length; p++) push(reportAlone(it) ? 'report' : 'item', { key: `${it.id}:report${p ? `:${p}` : ''}`, kind: 'report', itemId: it.id, fileId: 'report', page: p, of: slides.length, n, sectionId });
    // Each live list after the first, a slide of its own; after the money, QuickBooks' slides (the year against last
    // year, then each statement, as many slides as its lines take at a size a room reads)
    for (const x of slidesOf(it, booked ? null : books)) {
      const pages = x.kind === 'books' && ['act', 'budget', 'pos'].includes(x.k) ? statementBreaks(statementRows(books, x.k)).length : 1;
      for (let p = 0; p < pages; p++) push(x.id, { key: `${it.id}:${x.id}${p ? `:${p}` : ''}`, kind: x.kind, itemId: it.id, fileId: x.id, page: p, n, sectionId });
    }
    if (showsOf(it).includes('cash')) booked = true;
    for (const f of files) {
      const count = Math.max(1, Math.round(Number(pages[f.id]) || 1));
      // Its pages whole, two side by side a stop like an open book (a wide page alone, a blank one left out, a very
      // tall one in parts), each keyed by the spread's first page (":b", ":p2" on for a tall page's later parts)
      const of = (p) => { const x = parts[f.id]?.[p]; return x === undefined || x === null ? 1 : Number(x); };
      for (const sp of spreadsOf(count, of)) {
        const [p, k] = sp[0];
        push(`file:${f.id}`, { key: `${it.id}:${f.id}:${p}${k === 1 ? ':b' : k > 1 ? `:p${k}` : ''}`, kind: 'doc', itemId: it.id, fileId: f.id, page: p, part: k, pages: [...new Set(sp.map(([q]) => q))], sheets: sp, n, sectionId });
      }
    }
    // Its motion, after all it shows (the vote follows what was presented), on a slide of its own when there's more
    // than the motion to show: never squeezed beside a report, the notes or the facts
    if (decidesAlone(it)) push('decision', { key: `${it.id}:decision`, kind: 'decision', itemId: it.id, fileId: 'decision', page: 0, n, sectionId });
    for (const u of orderUnits(units, it.slideOrder)) out.push(...u.stops);
  };
  let n = 0;
  for (const s of m.sections) {
    const items = s.items.filter(isFilled);
    if (!s.title && !items.length) continue;
    if (items.length !== 1) out.push({ key: `section:${s.id}`, kind: 'section', itemId: '', fileId: '', page: 0, n: -1, sectionId: s.id });
    // Never a staff-only file: the screen shows the meeting as the board sees it, and the chair's deck matches it stop for stop
    for (const it of items) add(it, docsOf(itemFiles(m, it, meetings).filter((f) => !f.staffOnly && !(drawsStatements && showsOf(it).includes('cash') && isStatement(f)))).map((d) => d.file), n++, s.id);
  }
  const loose = docsOf(looseFiles(m).filter((f) => !f.staffOnly)).map((d) => d.file);
  if (loose.length) add(MORE, loose, -1, '');
  out.push({ key: 'end', kind: 'end', itemId: '', fileId: '', page: 0, n: -1, sectionId: '' });
  return out;
}
/**
 * An item's pieces of slides (deckOf) in the order its presenter or Board set (`order`, piece ids: item | report |
 * live:<kind> | books:<kind> | file:<id> | decision), else as they come. A piece not in the order (a document attached
 * since) goes where it comes, after the piece it follows; one in it that isn't there any more is passed over
 */
export function orderUnits(units, order) {
  if (!Array.isArray(order) || !order.length) return units;
  const out = [...new Set(order)].map((id) => units.find((u) => u.id === id)).filter(Boolean);
  units.forEach((u, i) => {
    if (out.includes(u)) return;
    const before = units.slice(0, i).reverse().find((x) => out.includes(x));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, u);
  });
  return out;
}
/** A slide piece's id as an item's slideOrder keeps it */
export const SLIDE_PIECE = /^(?:item|report|decision|live:[a-z]+|books:[a-z]+|file:[A-Za-z0-9_-]{1,64})$/;

/** Where the meeting's live state is in a deck: that page, else that file's last known page, else the item, else a part's card, else the cover */
export function stopIndex(deck, live) {
  if (live?.screen === 'end') return deck.length - 1;
  if (live?.screen === 'since') return Math.max(0, deck.findIndex((s) => s.kind === 'since'));
  if (live?.screen === 'section' && live.sectionId) { const i = deck.findIndex((s) => s.kind === 'section' && s.sectionId === live.sectionId); if (i >= 0) return i; }
  if (!live?.itemId) return 0;
  // (a document's page: the spreads it's on)
  const lp = live.page || 0;
  const at = (s) => s.itemId === live.itemId && s.fileId === (live.fileId || '') && (s.sheets ? s.sheets.some(([p]) => p === lp) : s.page === lp);
  const partOn = (s) => (s.sheets ? Math.min(...s.sheets.filter(([p]) => p === lp).map(([, k]) => k)) : s.part || 0);
  // That part of the page; a part further down than this deck has cut it (yet, or into fewer): the nearest above it
  const onPage = deck.map((s, i) => [s, i]).filter(([s]) => at(s));
  if (onPage.length) return (onPage.filter(([s]) => partOn(s) <= (live.part || 0)).at(-1) || onPage[0])[1];
  const pages = deck.map((s, i) => [s, i]).filter(([s]) => s.itemId === live.itemId && s.fileId && s.fileId === live.fileId);
  // A report's slide: the nearest at or before it (it was cut into fewer), else the item's own slide (the report on it)
  if (live.fileId === 'report') { const near = pages.filter(([s]) => (s.page || 0) <= (live.page || 0)).at(-1); if (near) return near[1]; }
  else if (pages.length) return pages.at(-1)[1];
  return Math.max(0, deck.findIndex((s) => s.itemId === live.itemId));
}
/** A stop as the live state that puts it on the screen */
export const liveOfStop = (s) => ({
  itemId: s?.itemId || '', fileId: s?.fileId || '', page: s?.page || 0, part: s?.part || 0,
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

/** Held before the day it's set for: the chair started and ended it early (a meeting moved up), so it's past */
export const heldEarly = (m, today = todayEastern()) => !!m?.live?.endedAt && isDate(m.date) && m.date > today;

/** The next meeting from today on, else null: one held early is past, one held today is still today's */
export function nextMeeting(meetings, today = todayEastern()) {
  return [...(meetings || [])].filter((m) => isDate(m.date) && m.date >= today && !heldEarly(m, today)).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
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
 * The minutes template's roll (./board-minutes-template.js) reads the same way, "video" after a name there
 * meaning on a call and "excused" after one not there, with its "Guests: …" line. `paragraphs` (a Word file):
 * every line is a paragraph of its own, so one under an item is a note on it, never its title running on.
 * → { date, start, end, location, attendance, sections, unmatched: [lines] }
 */
export function parseAgendaText(text, people = [], { paragraphs = false } = {}) {
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
    // What's written after the name: "x Pat Sample video" was on a call, "Pat Sample excused" was excused
    const after = plainName(segment).slice(hit.key.length);
    const status = here ? (/\b(video|phone|remote|remotely|zoom|teams|virtual|virtually|online)\b/.test(after) ? 'remote' : 'present') : /\bexcused\b/.test(after) ? 'excused' : 'absent';
    out.attendance.push({ slug: hit.p.slug, name: hit.p.name, org: hit.p.org || '', kind: hit.p.kind || 'board', status });
  };
  const guests = [];

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
      // "Guests: Pat Visitor (Example Co), Lee Sample": there, and not on the board or staff
      const g = line.match(/^guests?\s*[:–-]\s*(.*)$/i);
      if (g) {
        for (const raw of g[1].split(/\s*[,;]\s*|\s+and\s+/i)) {
          const name = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
          if (!name || !/[a-z]/i.test(name) || name.length > 80 || /^(none|no one|nobody|n\/?a)$/i.test(name)) continue;
          if (named.some((x) => plainName(name) === x.key) || guests.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
          guests.push({ name, org: '', kind: 'guest', status: 'present' });
        }
        continue;
      }
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
      // A paragraph under an item (Word): a note on it
      if (paragraphs && item) { note(1, line); continue; }
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
  // Nobody marked there (an agenda printed before the meeting, a template left blank): who came isn't recorded,
  // not "everyone was away"; the guests go with the roll
  if (!out.attendance.some((a) => a.status === 'present' || a.status === 'remote')) out.attendance = [];
  else out.attendance.push(...guests);
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
  if (kind === 'costs') return costLines(n);
  return [];
}
/** What makeovers cost, in words: the typical one lately and by room, then the money over the operating balance and who it starts */
export function costLines(n) {
  const c = n?.costs;
  if (!c?.makeovers?.length) return [];
  const out = [];
  const t = typicalLately(c.makeovers);
  const st = statsOf(t?.seasons ? c.makeovers.filter((x) => t.seasons.includes(Number(x.season))) : c.makeovers);
  if (t && st) out.push(`Completed makeovers${t.seasons ? `, ${t.seasons.slice().reverse().join(' and ')}` : ''} (${st.count}): median ${money(Math.round(st.median))}, average ${money(Math.round(st.average))}, low ${money(Math.round(st.low))}, high ${money(Math.round(st.high))}, what SOARD paid (donated work not counted)`);
  const rows = rowsOf(c.makeovers);
  if (rows.length) out.push(`Median by type, every year: ${rows.map((r) => `${r.short} ${money(Math.round(r.typical))} (${r.count})`).join(' · ')}`);
  const plan = planOf({ cash: cashOf(n), operating: operatingOf(n), makeovers: c.makeovers, waiting: c.waiting || [], underway: c.underway || [] });
  if (plan) {
    if (plan.jobs.length) out.push(`Underway: ${plural(plan.jobs.length, 'makeover')}, ${money(Math.round(plan.paid))} paid so far, about ${money(Math.round(plan.committed))} still to come (their budgets, or their rooms' median with none)`);
    out.push(plan.free >= 0 ? `${money(Math.round(plan.free))} free for new makeovers: the cash over the ${money(plan.operating)} operating balance, less what's still to come underway` : `Nothing free for new makeovers: ${money(Math.round(plan.short))} short once the ${money(plan.operating)} operating balance and what's still to come underway are counted`);
    for (const f of plan.families) out.push(`${f.name} (${typeById(f.type).label.toLowerCase()}): about ${money(Math.round(f.estimate?.cost || 0))}${f.pledged ? `, ${money(f.pledged)} pledged` : ''}${f.covered ? ', covered' : ''}`);
    if (plan.need != null) out.push(`${money(Math.round(plan.need))} more starts the next family`);
    else if (plan.more > 0) out.push(`Then room for about ${plural(plan.more, 'more makeover')} at the median cost`);
  }
  return out;
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
  for (const f of ['date', 'start', 'end', 'title', 'location', 'address', 'inviteNote', 'video', 'shared', 'minutes', 'approvedOn']) {
    const r = pick3(base[f], mine[f], theirs[f], prefer);
    merged[f] = r.value;
    if (r.clash) clashes.push({ date: 'the date', start: 'the time', end: 'the time', title: 'the name', location: 'the place', address: 'the address', inviteNote: 'the invite notes', video: 'the video link', shared: 'sharing', minutes: 'the minutes status', approvedOn: 'the minutes status' }[f]);
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

/** An iPhone photo (HEIC) as a JPEG any browser shows: drawn by the browser when it can, else ./vendor-heic.js */
export const isHeic = (f) => /^image\/hei[cf]$/i.test(f?.type || '') || /\.hei[cf]$/i.test(f?.name || '');
export async function asJpeg(f) {
  const name = `${String(f.name || 'photo').replace(/\.[^.]+$/, '')}.jpg`;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (blob) return new File([blob], name, { type: 'image/jpeg' });
  } catch { /* not a picture this browser draws */ }
  const { heicTo } = await import('./vendor-heic.js');
  return new File([await heicTo({ blob: f, type: 'image/jpeg', quality: 0.9 })], name, { type: 'image/jpeg' });
}

/**
 * A Word document's text the way it prints: Word numbers its own lists, so
 * each numbered paragraph gets its "1." / "a." / "i." back from numbering.xml,
 * and each table row is one line. Ready for parseAgendaText. `paragraphs`: each paragraph instead, as
 * { text, level (a Heading or Title style's, else 0), bold (all its words), ilvl, marker }, for ./board-words.js
 */
export async function docxText(bytes, { paragraphs = false } = {}) {
  const files = await unzip(bytes, ['word/document.xml', 'word/numbering.xml', ...(paragraphs ? ['word/styles.xml'] : [])]);
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
  // The styles that number their paragraphs (styles.xml: a style's own numPr)
  const styleNum = {};
  const listCount = {};
  const styles = files['word/styles.xml'] ? dec.decode(files['word/styles.xml']) : '';
  for (const [, sid, inner] of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const num = (inner.match(/<w:numId w:val="(\d+)"/) || [])[1];
    if (num) styleNum[sid] = { numId: num, ilvl: Number((inner.match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0) };
  }
  const lines = [];
  const paras = [];
  for (const [block] of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    if (block.startsWith('<w:tbl>')) {
      for (const [row] of block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(([c]) => xmlText(c).replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (cells.length) { lines.push(cells.join(' ')); paras.push({ text: cells.join(' '), cells, level: 0, bold: false, ilvl: 0, marker: '' }); }
      }
      continue;
    }
    const text = xmlText(block.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const pStyle = (block.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    // (a paragraph styled as a list keeps its numbering in the style: List Bullet, List Number, a style of one's own)
    const styled = paragraphs ? styleNum[pStyle] : null;
    const numId = (block.match(/<w:numId w:val="(\d+)"/) || [])[1] || styled?.numId;
    const ilvl = Number((block.match(/<w:ilvl w:val="(\d+)"/) || [])[1] || styled?.ilvl || 0);
    const mark = numId && numId !== '0' ? marker(numId, ilvl) : paragraphs && /^list\s?bullet/i.test(pStyle) ? '-' : paragraphs && /^list\s?number/i.test(pStyle) ? `${(listCount[pStyle] = (listCount[pStyle] || 0) + 1)}.` : '';
    // Each list level three spaces further in, so the agenda rules can tell an item from a point under it
    lines.push(mark ? `${'   '.repeat(ilvl)}${mark} ${text}` : text);
    if (paragraphs) {
      const style = pStyle;
      const level = /^title$/i.test(style) ? 1 : /^subtitle$/i.test(style) ? 2 : Number((style.match(/^heading\s?([1-6])$/i) || [])[1] || 0);
      // Bold all through: every run with words in it is bold (<w:b/>, not <w:b w:val="0"/>)
      const words = (r) => xmlText(r.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, ''));
      const isBold = (r) => /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(r);
      const runs = [...block.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)].map(([r]) => r).filter((r) => words(r).trim());
      const bold = runs.length > 0 && runs.every(isBold);
      // Bold some of the way ("gives personally each year"): those runs marked as ./board-words.js marks a PDF's
      const marked = !bold && runs.some(isBold) ? runs.map((r) => (isBold(r) ? `\uE000${words(r)}\uE001` : words(r))).join('').replace(/\s+/g, ' ').trim() : '';
      paras.push({ text, ...(marked ? { marked } : {}), level, bold, ilvl: mark ? ilvl : 0, marker: mark });
    }
  }
  if (paragraphs) return paras;
  return lines.join('\n');
}

