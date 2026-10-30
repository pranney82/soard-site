/**
 * Board mail: past meetings' agendas, minutes and financials from Peter and Holly's email
 * ===========================================================================
 * SOARD's board history lives in email: the agenda goes out before each
 * meeting, the minutes after it (often with the next meeting's packet), and
 * the financials prepared for it. Board searches each Board admin's Gmail for
 * board meeting material (MAIL_QUERY, newest first) and reads every email once:
 *   - Each attached document is sorted: agenda, minutes, financials, packet
 *     (other material made for a meeting), or not board material at all.
 *     Workers AI reads the email and the start of the file to decide
 *     (classifyFile); rules decide when it can't. Resumes, pictures, files over
 *     15 MB and QuickBooks' automatic reports never get that far.
 *   - It lands on its meeting: the one within ten days of the date the file
 *     (or its name, or the email) gives; with no date, an agenda or packet goes
 *     to the next meeting within three weeks of the email, minutes to the
 *     last one before it within four months. A dated agenda or minutes with no
 *     meeting near it brings that meeting in (most come from the calendar,
 *     ./_board-calendar.js). Anything else waits, and is tried again once a
 *     meeting is added.
 *   - An agenda fills the meeting's agenda while it's still a draft
 *     (agendaIsDraft: the usual outline, or none), never one a person wrote.
 *     Minutes are read into a past meeting (./_board-minutes.js): its
 *     attendance when nobody marked it, each item's notes, the motions and
 *     action items; a meeting with a later one is marked approved. Every file
 *     is kept on the meeting once (by name and size).
 *   - The board sees what the board was sent: a file from an email that went
 *     to the board (three or more board members, or a group address) is
 *     board-visible, and a past meeting nobody here worked on is shared once
 *     it has one. Anything else is kept for Peter and Holly only.
 * The same email in both inboxes is read once (by Message-ID). A backlog is
 * read every minute, about twelve seconds at a time; then hourly. It never
 * sends, deletes, labels or marks anything as read.
 *
 * Reads through the site's Google service account with the Gmail read-only
 * scope, which Google Admin must grant next to the calendar one (the admin's
 * Meetings tab names the client ID and the scope until it is).
 */

import { accessToken, GMAIL_READ_SCOPE, parseServiceAccount } from './_google-calendar.js';
import { boardAdmins, readState, writeState, peopleRows, activeBoard, normEmail } from './_board-roles.js';
import { ensureSchema, listMeetings, getMeeting, saveMeeting, patchMeeting, createMeeting, putFile, deleteFile, roster } from './_board.js';
import { readMinutes, applyMinutes, minutesNewer } from './_board-minutes.js';
import { parseAgendaText, isDate, todayEastern, meetingName, docxText, unzip, cleanMeeting, agendaIsDraft, shortDate, AGENDA_READER } from '../../public/admin/board-shared.js';

export { docxText, unzip };

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Board meeting material with a document attached (Gmail matches words in attachment names too); QuickBooks' automatic reports stay out
export const MAIL_QUERY = 'has:attachment newer_than:5y (board OR BOD OR directors) (agenda OR minutes OR "board meeting" OR packet OR financials OR financial OR docs) -from:quickbooks -from:intuit.com';
export const MAIL_QUERIES = [MAIL_QUERY];
export const MAIL_BY = 'board email';
const CALENDAR_BY = 'the calendar'; // ./_board-calendar.js (named here: that module imports this one's neighbours)
const KEY = 'mail';
// 2: sorted by Workers AI and brought onto past meetings (Oct 28 2026): what version 1 filed is taken off and every email read again
const MAIL_VERSION = 2;
const EVERY_MS = 60 * 60 * 1000;
const BACKLOG_MS = 60 * 1000;
// The heartbeat runs Board after its reply, where a Worker has about 30 seconds in all: email gets twelve of them
const BUDGET_MS = 12 * 1000;
const MODEL_FILES = 6; // documents per email Workers AI reads; any more are sorted by the rules
const MAX_IDS = 2000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const DOCS = /\.(pdf|docx|doc|xlsx|xls|pptx)$/i;
const DAY = 86_400_000;
export const KINDS = ['agenda', 'minutes', 'financials', 'packet', 'not_board'];
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_TIMEOUT_MS = 10000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS board_mail (id TEXT PRIMARY KEY, msgid TEXT, admin TEXT, subject TEXT, sender TEXT, sent_at TEXT,
    meeting_id TEXT, result TEXT, files INTEGER DEFAULT 0, at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_board_mail_msgid ON board_mail(msgid)',
];
// What each email came to (filed | not-board | no-files | duplicate | waiting), the files it left out and whether it brought a meeting in
const COLUMNS = ['outcome TEXT', 'skipped INTEGER DEFAULT 0', 'made INTEGER DEFAULT 0'];
const _ready = new WeakSet();
async function ensureMail(DB) {
  if (_ready.has(DB)) return;
  await ensureSchema(DB);
  for (const s of SCHEMA) await DB.prepare(s).run();
  const have = new Set(((await DB.prepare('PRAGMA table_info(board_mail)').all()).results || []).map((c) => c.name));
  for (const c of COLUMNS) if (!have.has(c.split(' ')[0])) await DB.prepare(`ALTER TABLE board_mail ADD COLUMN ${c}`).run();
  _ready.add(DB);
}

// ─── Gmail ──────────────────────────────────────────────────────────

async function gmail(token, path, fetchImpl) {
  const res = await fetchImpl(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`Gmail answered ${res.status}: ${body?.error?.message || ''}`.trim()), { status: res.status });
  return body;
}
const b64urlBytes = (s) => Uint8Array.from(atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const header = (msg, name) => (msg?.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const addresses = (s) => (String(s || '').match(/[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/gi) || []).map(normEmail);

/** Every attached file in a message, without pictures sitting in a signature: [{ name, type, attachmentId, data, size }] */
export function attachmentsOf(payload) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    const disposition = (p.headers || []).find((h) => h.name.toLowerCase() === 'content-disposition')?.value || '';
    if (p.filename && (p.body?.attachmentId || p.body?.data) && DOCS.test(p.filename) && !/^inline/i.test(disposition)) {
      out.push({ name: p.filename, type: p.mimeType || '', attachmentId: p.body.attachmentId || null, data: p.body.data || null, size: p.body.size || 0 });
    }
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  return out;
}

/** What a file is, by its name (and the subject when that's all there is): the rules' first guess */
export function fileKind(name, subject = '') {
  const n = String(name || '');
  if (/minutes/i.test(n)) return 'minutes';
  if (/agenda/i.test(n)) return 'agenda';
  if (/financ|balance|income|p\s*&\s*l|profit|loss|budget|statement|cash\s*flow|activities|treasurer/i.test(n)) return 'financials';
  if (/minutes/i.test(subject) && /\.(pdf|docx?)$/i.test(n)) return 'minutes';
  if (/agenda/i.test(subject) && /\.(pdf|docx?)$/i.test(n)) return 'agenda';
  return 'other';
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** A date written in a subject or file name ("4.30.26", "04/30/2026", "April 30, 2026", "2026-04-30", "2025.07.24") → YYYY-MM-DD or '' */
export function dateIn(text, fallbackYear = Number(todayEastern().slice(0, 4))) {
  const s = String(text || '');
  const ok = (y, m, d) => { const v = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isDate(v) ? v : ''; };
  let m = s.match(/\b(20\d{2})[-.](\d{2})[-.](\d{2})\b/);
  if (m) return ok(m[1], m[2], m[3]);
  m = s.match(/(?<![\d.])(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?!\d)(?!\.\d)/);
  if (m) return ok(m[3].length === 2 ? 2000 + Number(m[3]) : m[3], m[1], m[2]);
  m = s.match(new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'i'));
  if (m) return ok(m[3] || fallbackYear, MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) + 1, m[2]);
  return '';
}

/** A file's text for parseAgendaText: Word read here, a PDF through Workers AI's converter; '' when it can't be read */
export async function fileText(env, { name, bytes }) {
  try {
    if (/\.docx$/i.test(name)) return await docxText(bytes);
    if (/\.pdf$/i.test(name) && env.AI?.toMarkdown) {
      const r = await env.AI.toMarkdown({ name, blob: new Blob([bytes], { type: 'application/pdf' }) }, { conversionOptions: { output: { format: 'text' } } });
      const one = Array.isArray(r) ? r[0] : r;
      // Plain text asked for; any table pipes or headings left over are taken out
      return one?.format === 'error' ? '' : String(one?.data || '').replace(/\|/g, ' ').replace(/^#+\s*/gm, '').replace(/\*\*/g, '');
    }
  } catch (err) {
    console.error('[board-mail] reading', name, err.message);
  }
  return '';
}

// ─── Sorting a file ─────────────────────────────────────────────────

const RESUME = /\b(resume|résumé|curriculum vitae|cv)\b/i;
const AUTOMATIC = /quickbooks|intuit\.com/i;
const NOT_BOARD_NAME = /\b(policy|renewal|invoice|receipt|contract|agreement|w-?9|1099|certificate|insurance|quote|estimate|proposal|loi|lease|deed|subpoena|settlement)\b/i;
const BOARDISH = /\b(board|bod|directors?|agenda|minutes)\b/i;
// The kinds of organization whose board is never SOARD's ("Example School Board", "Example, Inc. Full Board Meeting")
const ORG_WORD = /^(inc|llc|corp|corporation|company|co|school|academy|college|university|foundation|chamber|church|ministries|club|rotary|hoa|pta|pto|association|hospital)$/i;
const OUR_CAPS = /^(SOARD|BOD|Q[1-4]|CEO|ED|FY\d*|RE|FW|FWD|AW)$/;

/**
 * Whether a subject or file name is another organization's board: the name right
 * before "Board" or "BOD" is an acronym that isn't SOARD's ("ABC BOD Packet",
 * "Approval Needed: New ABC Board Members") or a kind of organization ("Example
 * Inc Board Meeting"). SOARD's founders sit on other boards too, and that mail
 * says board as much as SOARD's does. → that organization's name, or ''
 */
export function otherBoard(text) {
  const s = String(text || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  // A name in capitals throughout ("NEW BOARD MEMBERS") has no acronyms to tell apart
  const caps = !/[a-z]/.test(s);
  for (const m of s.matchAll(/\b(board|bod)\b/gi)) {
    const words = s.slice(0, m.index).split(/[^A-Za-z0-9&'.-]+/).map((w) => w.replace(/^[.'-]+|[.'-]+$/g, '').replace(/'s$/i, '')).filter(Boolean);
    while (words.length && /^(full|the|of|annual|regular|special|\d+)$/i.test(words.at(-1))) words.pop();
    const w = words.at(-1) || '';
    if (ORG_WORD.test(w)) return words.slice(-2).join(' ');
    if (!caps && /^[A-Z][A-Z&]{1,5}$/.test(w) && !OUR_CAPS.test(w)) return w;
  }
  return '';
}

/** What's left out before anything reads it: a reason in words, or '' */
export function leftOut(file, { sender = '', subject = '' } = {}) {
  if (RESUME.test(file.name)) return 'a resume';
  if (otherBoard(file.name)) return `another organization’s board (${otherBoard(file.name)})`;
  if ((file.size || file.bytes?.byteLength || 0) > MAX_FILE_BYTES) return 'over 15 MB';
  if (AUTOMATIC.test(sender)) return 'an automatic QuickBooks report';
  if (/\bweekly report\b/i.test(subject) || /\bweekly report\b/i.test(file.name)) return 'a weekly report';
  return '';
}

/** The rules' answer, for when Workers AI can't give one: { kind, date: '', reason } */
export function ruleKind({ name = '', subject = '', text = '' }) {
  const t = String(text || '').slice(0, 6000);
  const minutesText = /\b(present|in attendance|attendees)\b/i.test(t) && /\b(motion|seconded|adjourned|called to order)\b/i.test(t);
  const agendaText = /\bcall to order\b/i.test(t) && /\b(adjourn|new business|old business|committee reports|open forum)\b/i.test(t);
  // Its name first (what someone called it), then its words
  const byName = fileKind(name, subject);
  if (byName === 'minutes') return { kind: 'minutes', date: '', reason: 'minutes, by its name' };
  if (byName === 'agenda') return { kind: 'agenda', date: '', reason: 'an agenda, by its name' };
  if (NOT_BOARD_NAME.test(name)) return { kind: 'not_board', date: '', reason: 'not made for a board meeting' };
  if (byName === 'financials') {
    return BOARDISH.test(`${subject} ${name}`) ? { kind: 'financials', date: '', reason: 'financials sent for the board' } : { kind: 'not_board', date: '', reason: 'financials not sent for a board meeting' };
  }
  if (minutesText) return { kind: 'minutes', date: '', reason: 'minutes, by its words' };
  if (agendaText) return { kind: 'agenda', date: '', reason: 'an agenda, by its words' };
  return { kind: 'not_board', date: '', reason: 'nothing says it was made for a board meeting' };
}

const SORT_PROMPT = `You sort the documents attached to emails for the board of directors of SOARD (Sunshine on a Ranney Day), a nonprofit.
Decide what ONE attached file is:
- "agenda": the agenda for a board meeting
- "minutes": the minutes or written notes of a board meeting
- "financials": financial statements prepared for the board (profit and loss, balance sheet, budget, treasurer's report)
- "packet": other material made for a specific board meeting (a presentation, a committee report, a proposal the board votes on)
- "not_board": anything else, such as resumes, insurance policies, contracts, grant documents, legal letters, invoices, receipts, weekly or automatic reports, newsletters, event files, or forms
Only choose agenda, minutes, financials or packet when it is clearly made for a board meeting. When unsure, choose "not_board".
SOARD's founders also sit on the boards of other organizations (a school, a chamber of commerce, a city group). Anything for another organization's board, committee or meeting is "not_board".
meetingDate: the date of the board meeting the file belongs to (YYYY-MM-DD), only when the file or the email states it; otherwise "".
Answer with JSON: {"kind": "...", "meetingDate": "...", "reason": "a few words"}`;
const SORT_SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string', enum: KINDS }, meetingDate: { type: 'string' }, reason: { type: 'string' } },
  required: ['kind', 'meetingDate', 'reason'],
};
function readSort(out) {
  const r = out && typeof out === 'object' && 'response' in out ? out.response : out;
  let j = r && typeof r === 'object' ? r : null;
  if (!j) { const m = String(r ?? '').match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } } }
  if (!j || !KINDS.includes(j.kind)) return null;
  return { kind: j.kind, date: isDate(String(j.meetingDate || '')) ? j.meetingDate : '', reason: String(j.reason || '').slice(0, 120) };
}

/**
 * What one file is: Workers AI reading the email and the start of the file,
 * the rules when it can't. → { kind (KINDS), date, reason, by: 'ai' | 'rules' }
 */
export async function classifyFile(env, { name, subject = '', sender = '', sentAt = '', recipients = 0, snippet = '', text = '' }) {
  if (env.AI?.run) {
    const input = [
      `Email subject: ${subject}`, `From: ${sender}`, `Sent: ${String(sentAt).slice(0, 10)}`, `Sent to ${recipients} people`,
      `Email text: ${String(snippet).slice(0, 400)}`, `File name: ${name}`, `Start of the file:\n${String(text || '(could not be read)').slice(0, 2500)}`,
    ].join('\n');
    for (const json of [true, false]) {
      let timer;
      try {
        const out = await Promise.race([
          env.AI.run(AI_MODEL, {
            messages: [{ role: 'system', content: SORT_PROMPT }, { role: 'user', content: input }],
            max_tokens: 200, temperature: 0,
            ...(json ? { response_format: { type: 'json_schema', json_schema: SORT_SCHEMA } } : {}),
          }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), AI_TIMEOUT_MS); }),
        ]);
        const sorted = readSort(out);
        if (sorted) return { ...sorted, by: 'ai' };
      } catch (err) {
        console.error('[board-mail] sorting', name, err.message);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return { ...ruleKind({ name, subject, text }), by: 'rules' };
}

const LABELS = [
  [/^(board members |directors |members )?(present|attending|in attendance|attendees|attendance)\b/i, 'present'],
  [/^(board members |directors |members )?(absent|not present)\b/i, 'absent'],
  [/^(board members |directors |members )?excused\b/i, 'excused'],
  [/^(remote|virtual|by video|via (zoom|teams|video)|by phone|joined (remotely|virtually|by video))\b/i, 'remote'],
];
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
/**
 * Who was there, from minutes: the names after "Present:", "Absent:",
 * "Excused:" and the like (on that line or the lines under it), matched to
 * `people` ([{ slug, name, org, kind }]) by full name. → [{ slug, name, org, kind, status }]
 */
export function attendanceIn(text, people = []) {
  const named = people.map((p) => ({ p, key: plain(p.name) })).filter((x) => x.key.includes(' ')).sort((a, b) => b.key.length - a.key.length);
  const out = new Map();
  let status = '';
  let found = 0; // names since the label: once some are found, a line with none (or a blank one) ends the list
  let lines = 0;
  for (const raw of String(text || '').split('\n').slice(0, 200)) {
    const line = raw.trim();
    if (!line) { if (found) status = ''; continue; }
    const bare = line.replace(/^[-•*\d.)\s]+/, '');
    const label = LABELS.find(([re]) => re.test(bare));
    let rest = line;
    if (label) {
      status = label[1]; found = 0; lines = 0;
      // "Present: …", "In attendance were: …", "Absent – …"
      rest = bare.replace(label[0], '');
      rest = /^[^:]{0,20}:/.test(rest) ? rest.replace(/^[^:]{0,20}:\s*/, '') : rest.replace(/^\s*[–-]\s*/, '');
    } else if (!status || ++lines > 30) { status = ''; continue; }
    let hit = 0;
    // Names one to a line or several to one, each with its own "(by video)" when it has one
    for (let part of rest.split(/[,;]|\s+and\s+/i)) {
      // "…; Excused: Sam Ortiz" on the same line
      const inline = LABELS.find(([re]) => re.test(part.trim()));
      if (inline && /[:–-]/.test(part)) { status = inline[1]; part = part.trim().replace(inline[0], '').replace(/^[^:]{0,20}:\s*|^\s*[–-]\s*/, ''); }
      const words = ` ${plain(part)} `;
      const remote = /\b(by video|virtual(ly)?|remote(ly)?|zoom|teams|by phone|online)\b/i.test(part);
      for (const { p, key } of named) {
        if (out.has(p.slug) || !words.includes(` ${key} `)) continue;
        out.set(p.slug, { slug: p.slug, name: p.name, org: p.org || '', kind: p.kind === 'staff' ? 'staff' : 'board', status: remote && status === 'present' ? 'remote' : status });
        hit += 1;
      }
    }
    if (!label && !hit && found) status = '';
    found += hit;
  }
  return [...out.values()];
}

// ─── Bringing one email in ──────────────────────────────────────────

const dayMs = (d) => Date.parse(`${d}T12:00:00Z`);
/** A file's name to compare by: "Minutes 2025.07.24 (1).pdf" and "Minutes 2025.07.24" are the same file */
const titleKey = (name) => String(name || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/\(\d+\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const daysApart = (a, b) => Math.round((dayMs(a) - dayMs(b)) / DAY);
const untouched = (m) => [CALENDAR_BY, MAIL_BY, 'Google Drive', ''].includes(m.updatedBy || ''); // Google Drive: ./_board-drive.js
const KIND_FILE = { agenda: 'agenda', minutes: 'minutes', financials: 'financials', packet: 'packet' };
/** Board meetings only: not one the calendar brought in that isn't (notBoard), nor a practice meeting */
export const boardOnly = (meetings) => meetings.filter((x) => !x.notBoard && !x.practice);
const WORD = { agenda: 'the agenda', minutes: 'the minutes', financials: 'the financials', packet: 'a packet file' };

/** The meeting a file belongs to, by the rules in the header. → { meeting, create: date } */
function meetingFor(meetings, { kind, date, sent }) {
  if (date) {
    const near = meetings.filter((m) => Math.abs(daysApart(m.date, date)) <= 10).sort((a, b) => Math.abs(daysApart(a.date, date)) - Math.abs(daysApart(b.date, date)));
    return { meeting: near[0] || null, create: near[0] ? '' : date };
  }
  if (kind === 'minutes') {
    const before = meetings.filter((m) => m.date <= sent && daysApart(sent, m.date) <= 120).sort((a, b) => b.date.localeCompare(a.date));
    return { meeting: before[0] || null, create: '' };
  }
  const after = meetings.filter((m) => m.date >= sent && daysApart(m.date, sent) <= 21).sort((a, b) => a.date.localeCompare(b.date));
  return { meeting: after[0] || null, create: '' };
}

/** The date a file gives for its meeting: its own words, its name, what the model read, then the email's subject when it names the same kind */
function dateFor({ kind, text, name, subject, model, sent }) {
  const year = Number(sent.slice(0, 4));
  const plausible = (d) => d && d <= new Date(dayMs(sent) + 120 * DAY).toISOString().slice(0, 10) && d >= new Date(dayMs(sent) - 400 * DAY).toISOString().slice(0, 10);
  const own = parseAgendaText(text).date || dateIn(String(text || '').slice(0, 600), year);
  const subjectSays = kind === 'minutes' ? /minutes/i.test(subject) : kind === 'agenda' ? /agenda|docs|packet|meeting/i.test(subject) : /board|meeting/i.test(subject);
  for (const [d, firm] of [[own, true], [dateIn(name, year), true], [model, false], [subjectSays ? dateIn(subject, year) : '', true]]) {
    if (plausible(d)) return { date: d, firm };
  }
  return { date: '', firm: false };
}

/**
 * One email, read and filed. `quick`: an email a look was cut off in the
 * middle of before is sorted by the rules only (names and subject), so it
 * always finishes.
 */
async function bringIn(env, { token, admin, id, fetchImpl, people, boardEmails, now, quick = false }) {
  const msg = await gmail(token, `/messages/${id}?format=full`, fetchImpl);
  const msgid = header(msg, 'Message-ID') || id;
  const subject = header(msg, 'Subject').slice(0, 300);
  const sender = header(msg, 'From').slice(0, 200);
  const sentAt = new Date(Number(msg.internalDate) || now).toISOString();
  const sent = todayEastern(Date.parse(sentAt));
  const record = (fields) => env.DB.prepare('INSERT OR REPLACE INTO board_mail (id, msgid, admin, subject, sender, sent_at, meeting_id, result, files, at, outcome, skipped, made) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`${admin}:${id}`, msgid, admin, subject, sender, sentAt, fields.meeting || null, fields.result, fields.files || 0, new Date(now).toISOString(), fields.outcome, fields.skipped || 0, fields.made || 0).run()
    .then(() => fields);
  const other = await env.DB.prepare('SELECT admin FROM board_mail WHERE msgid = ? AND id != ?').bind(msgid, `${admin}:${id}`).first();
  if (other) return record({ outcome: 'duplicate', result: `the same email, already read from ${String(other.admin).split('@')[0]}’s inbox` });

  const attached = attachmentsOf(msg.payload);
  if (!attached.length) return record({ outcome: 'no-files', result: 'no documents attached' });
  // Another organization's board meeting ("ABC BOD Packet & July 15 Meeting"): none of it is SOARD's
  const theirs = otherBoard(subject);
  if (theirs) return record({ outcome: 'not-board', result: `another organization’s board (${theirs}): ${attached.map((a) => a.name).join(', ')}`, skipped: attached.length });
  // Who it went to: the board (three or more of them, SOARD's own Google Group, or a board address), or just a few people.
  // Only a list of SOARD's counts (its name says so): every newsletter has a List-Id
  const to = [...new Set([...addresses(header(msg, 'To')), ...addresses(header(msg, 'Cc')), ...addresses(sender)])];
  const toBoard = /soard|ranney/i.test(header(msg, 'List-Id')) || to.filter((e) => boardEmails.includes(e)).length >= 3 || to.some((e) => /^(board|bod|directors?)[\w.+-]*@/.test(e));
  const recipients = to.length;

  const skipped = [];
  const sorted = [];
  let read = 0;
  for (const a of attached) {
    const why = leftOut(a, { sender, subject });
    if (why) { skipped.push(`${a.name} (${why})`); continue; }
    const data = a.data || (await gmail(token, `/messages/${id}/attachments/${a.attachmentId}`, fetchImpl)).data;
    const bytes = b64urlBytes(data);
    if (bytes.byteLength > MAX_FILE_BYTES) { skipped.push(`${a.name} (over 15 MB)`); continue; }
    const deep = !quick && read++ < MODEL_FILES;
    const text = deep ? await fileText(env, { name: a.name, bytes }) : '';
    const c = deep ? await classifyFile(env, { name: a.name, subject, sender, sentAt, recipients, snippet: msg.snippet || '', text }) : { ...ruleKind({ name: a.name, subject }), by: 'rules' };
    if (c.kind === 'not_board') { skipped.push(`${a.name} (${c.reason || 'not board material'})`); continue; }
    sorted.push({ ...a, bytes, text, kind: c.kind, ...dateFor({ kind: c.kind, text, name: a.name, subject, model: c.date, sent }) });
  }
  const notBoard = skipped.length ? `left out ${skipped.join(', ')}` : '';
  if (!sorted.length) return record({ outcome: 'not-board', result: `not board material: ${skipped.join(', ')}`, skipped: skipped.length });

  const today = todayEastern(now);
  let meetings = await listMeetings(env.DB);
  const filed = new Map(); // meeting id → [what]
  const made = [];
  const waiting = [];
  for (const f of sorted) {
    // (never onto one the calendar brought in that isn't a board meeting, nor the admins' practice meeting)
    let { meeting: m, create } = meetingFor(boardOnly(meetings), { kind: f.kind, date: f.date, sent });
    // A dated agenda or minutes with no meeting near it brings the meeting in (never far ahead)
    if (!m && create && f.firm && ['agenda', 'minutes'].includes(f.kind) && create <= new Date(now + 120 * DAY).toISOString().slice(0, 10)) {
      m = create < today ? await saveMeeting(env.DB, cleanMeeting({ date: create }), { by: MAIL_BY }) : await createMeeting(env, { date: create, by: MAIL_BY });
      made.push(m.id);
      meetings = await listMeetings(env.DB);
    }
    if (!m) { waiting.push(f.name); continue; }
    m = await getMeeting(env.DB, m.id);
    const past = m.date < today;
    // A past meeting's agenda, while its own is still empty or a draft (never one a person wrote).
    // Agendas for meetings ahead are written in Board, so an emailed one is only kept as a file
    let agendaFilled = false;
    if (f.kind === 'agenda' && past && agendaIsDraft(m)) {
      const parsed = parseAgendaText(f.text, people);
      if (parsed.sections.some((s) => s.items.length)) {
        const marked = m.attendance.some((p) => p.status);
        m = await patchMeeting(env.DB, m.id, (cur) => (agendaIsDraft(cur) ? {
          ...cur, sections: parsed.sections, agendaFrom: { kind: 'email', name: f.name, at: new Date(now).toISOString(), v: AGENDA_READER },
          attendance: past && !marked && parsed.attendance.length ? parsed.attendance : cur.attendance,
          location: cur.location || parsed.location, start: cur.start || parsed.start || '', end: cur.end || parsed.end || '',
        } : cur));
        agendaFilled = true;
      }
    }
    // Minutes, read in (./_board-minutes.js): who was there (a past meeting nobody marked), each item's notes, the
    // motions and action items, never over minutes someone read in by hand since; approved once a later meeting exists
    if (f.kind === 'minutes' && past) {
      const later = boardOnly(meetings).filter((x) => x.date > m.date).sort((a, b) => a.date.localeCompare(b.date))[0];
      const prev = boardOnly(meetings).filter((x) => x.id !== m.id && x.date && x.date < m.date).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
      const read = f.text ? await readMinutes(env, { name: f.name, text: f.text, meeting: m, people, prev, quick: true }) : null;
      m = await patchMeeting(env.DB, m.id, (cur) => {
        let next = { ...cur };
        if (read && minutesNewer(cur, { name: f.name, at: sentAt })) {
          next = applyMinutes(cur, read, { fileName: f.name, now, keepMarked: true, minSections: 2, agendaFrom: { kind: 'email', name: f.name, at: new Date(now).toISOString(), v: AGENDA_READER } });
        }
        if (untouched(cur) && later && cur.minutes !== 'approved') Object.assign(next, { minutes: 'approved', approvedOn: later.date <= today ? later.date : today });
        return next;
      });
    }
    // The file itself, once (the same file by size, or one of the same kind and name already here from Google Drive)
    const have = new Set(m.files.map((x) => `${x.name}|${x.size}`));
    const sameName = (x) => x.kind === KIND_FILE[f.kind] && titleKey(x.name) === titleKey(f.name);
    if (!have.has(`${f.name}|${f.bytes.byteLength}`) && !m.files.some(sameName)) {
      await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([f.bytes], f.name, { type: f.type }), kind: KIND_FILE[f.kind], staffOnly: !toBoard, by: MAIL_BY });
    }
    // The board had it by email: a past meeting nobody here worked on goes on the board page
    if (toBoard && past && !m.shared && untouched(m)) m = await patchMeeting(env.DB, m.id, (cur) => (untouched(cur) ? { ...cur, shared: true } : cur));
    filed.set(m.id, [...(filed.get(m.id) || []), `${WORD[f.kind]}${agendaFilled ? ' (its agenda filled in)' : ''}`]);
  }
  const names = Object.fromEntries((await listMeetings(env.DB)).map((x) => [x.id, `${meetingName(x)} (${shortDate(x.date)})`]));
  const parts = [...filed].map(([mid, what]) => `${made.includes(mid) ? 'brought in' : 'filed on'} ${names[mid]}: ${what.join(', ')}`);
  if (waiting.length) parts.push(`waiting for a meeting near it: ${waiting.join(', ')}`);
  if (notBoard) parts.push(notBoard);
  const files = sorted.length - waiting.length;
  // Anything still waiting keeps the email coming back (what was filed isn't filed twice)
  return record({
    meeting: [...filed.keys()][0] || null, outcome: waiting.length ? 'waiting' : 'filed', result: parts.join('; '),
    files, skipped: skipped.length, made: made.length,
  });
}

// ─── A look ─────────────────────────────────────────────────────────

/** The service account's client ID (not secret): what Google Admin's delegation list shows */
export function clientIdOf(env) {
  try { return String(parseServiceAccount(env.GOOGLE_CALENDAR_KEY).client_id || ''); } catch { return ''; }
}

/**
 * Once, for version 2: what version 1 filed comes off (copies of email
 * attachments; the emails keep theirs), and every email is read again.
 * A file a person uploaded is never touched.
 */
async function tidyOnce(env, state) {
  if (state.version === MAIL_VERSION) return 0;
  const rows = (await env.DB.prepare('SELECT id FROM board_files WHERE by = ?').bind(MAIL_BY).all()).results || [];
  for (const r of rows) await deleteFile(env, r.id);
  await env.DB.prepare('DELETE FROM board_mail').run();
  return rows.length;
}

/** Every message id the search finds in one inbox, newest first */
async function searchIds(token, fetchImpl) {
  const ids = [];
  let pageToken = '';
  do {
    const page = await gmail(token, `/messages?maxResults=500&q=${encodeURIComponent(MAIL_QUERY)}${pageToken ? `&pageToken=${pageToken}` : ''}`, fetchImpl);
    for (const x of page.messages || []) if (!ids.includes(x.id)) ids.push(x.id);
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < MAX_IDS);
  return ids;
}

/** Totals over everything read so far, for the admin */
async function totals(DB) {
  const r = await DB.prepare(`SELECT count(*) AS emails, sum(skipped) AS skipped, sum(made) AS made,
    sum(CASE WHEN outcome = 'waiting' THEN 1 ELSE 0 END) AS waiting FROM board_mail WHERE COALESCE(outcome, '') NOT IN ('duplicate', 'started')`).first();
  // What's on the meetings now (one email can file onto two meetings: a packet and the last meeting's minutes)
  const f = await DB.prepare("SELECT count(*) AS files, count(DISTINCT owner_id) AS meetings FROM board_files WHERE by = ? AND owner_type = 'meeting'").bind(MAIL_BY).first();
  return { emails: r?.emails || 0, meetings: f?.meetings || 0, files: f?.files || 0, skipped: r?.skipped || 0, made: r?.made || 0, waiting: r?.waiting || 0 };
}

/**
 * Read the admins’ board mail, newest first, for about twelve seconds →
 * the saved state: { version, ok, configured, needsScope, clientId, checkedAt,
 * read (this look), backlog (left to read), waiting (same, for older readers),
 * tidied (version 1's files taken off, once), totals: { emails, meetings,
 * files, skipped, made, waiting }, errors }
 */
export async function readBoardMail(env, { fetchImpl = fetch, now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  await ensureMail(env.DB);
  if (!env.GOOGLE_CALENDAR_KEY) return writeState(env.DB, KEY, { ok: false, configured: false, checkedAt: new Date(now).toISOString() });
  const last = await readState(env.DB, KEY); // (makes board_state on a new database)
  const lock = await env.DB.prepare(`INSERT INTO board_state (key, data, updated_at) VALUES ('mail-lock', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE CAST(json_extract(board_state.data, '$.until') AS INTEGER) < ?`)
    .bind(JSON.stringify({ until: now + 2 * 60 * 1000 }), new Date(now).toISOString(), now).run();
  if (!((lock?.meta?.changes ?? 0) > 0)) return last;
  const started = Date.now();
  try {
    const tidied = await tidyOnce(env, last);
    const admins = await boardAdmins(env.DB);
    const all = await peopleRows(env.DB);
    const staff = (await roster(env.DB)).staff;
    // Everyone who has been on the board (past minutes name people who've since rotated off), and the staff
    const people = all.filter((p) => p.group === 'board').map((p) => ({ slug: p.slug, name: p.name, org: p.organization || '', kind: 'board' }))
      .concat(staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })));
    const boardEmails = (await activeBoard(env.DB)).map((p) => p.email).filter(Boolean).map(normEmail);
    // An email waiting for its meeting is read again once a meeting has been added since
    const newest = (await env.DB.prepare('SELECT max(json_extract(data, \'$.createdAt\')) AS at FROM board_meetings').first())?.at || '';
    const errors = [];
    let needsScope = false;
    let backlog = 0;
    let read = 0;
    for (const admin of admins) {
      let token;
      try { token = await accessToken(env, admin, { fetchImpl, now, scope: GMAIL_READ_SCOPE }); } catch (err) {
        if (/unauthorized_client|access_denied|not authorized/i.test(err.message)) needsScope = true;
        else errors.push(`${admin.split('@')[0]}’s email: ${String(err.message).slice(0, 200)}`);
        continue;
      }
      try {
        const ids = await searchIds(token, fetchImpl);
        const rows = (await env.DB.prepare('SELECT id, outcome, at FROM board_mail WHERE admin = ?').bind(admin).all()).results || [];
        const key = (r) => r.id.slice(admin.length + 1);
        // Read already, except an email waiting for a meeting when one has been added since, and one a look was cut off in
        const seen = new Set(rows.filter((r) => !(r.outcome === 'waiting' && r.at < newest) && r.outcome !== 'started').map(key));
        const cutOff = new Set(rows.filter((r) => r.outcome === 'started').map(key));
        const fresh = ids.filter((x) => !seen.has(x));
        backlog += fresh.length;
        for (const id of fresh) {
          if (read > 0 && Date.now() - started > budgetMs) break; // at least one each look, so a backlog always moves
          // Marked first: if the Worker's time runs out in the middle of it, the next look knows
          await env.DB.prepare("INSERT OR REPLACE INTO board_mail (id, admin, result, outcome, at) VALUES (?, ?, 'being read', 'started', ?)").bind(`${admin}:${id}`, admin, new Date(now).toISOString()).run();
          try { await bringIn(env, { token, admin, id, fetchImpl, people, boardEmails, now, quick: cutOff.has(id) }); } catch (err) {
            await env.DB.prepare("DELETE FROM board_mail WHERE id = ? AND outcome = 'started'").bind(`${admin}:${id}`).run();
            errors.push(`${admin.split('@')[0]}’s email: ${String(err.message).slice(0, 200)}`);
            if (err.status === 429 || err.status >= 500) break; // Gmail is busy: the next look carries on
            continue;
          }
          read += 1;
          backlog -= 1;
        }
      } catch (err) {
        errors.push(`${admin.split('@')[0]}’s email: ${String(err.message).slice(0, 200)}`);
      }
    }
    return await writeState(env.DB, KEY, {
      version: MAIL_VERSION, ok: !errors.length && !needsScope, configured: true, needsScope, clientId: needsScope ? clientIdOf(env) : '',
      checkedAt: new Date(now).toISOString(), read, backlog, waiting: backlog, brought: read,
      tidied: tidied || last.tidied || 0, totals: await totals(env.DB), errors: errors.slice(0, 10),
    });
  } finally {
    await env.DB.prepare("DELETE FROM board_state WHERE key = 'mail-lock'").run().catch(() => {});
  }
}

export const mailStatus = (DB) => readState(DB, KEY);

/**
 * The latest emails Board read and what it did with each, in words (Peter and Holly only).
 * `outcome` narrows it: filed | not-board | no-files | waiting.
 */
export async function mailLog(DB, limit = 12, { outcome = '' } = {}) {
  await ensureMail(DB);
  const meetings = Object.fromEntries((await listMeetings(DB)).map((m) => [m.id, m]));
  const rows = outcome
    ? (await DB.prepare('SELECT * FROM board_mail WHERE outcome = ? ORDER BY sent_at DESC LIMIT ?').bind(outcome, limit).all()).results || []
    : (await DB.prepare("SELECT * FROM board_mail WHERE COALESCE(outcome, '') NOT IN ('duplicate', 'started') ORDER BY sent_at DESC LIMIT ?").bind(limit).all()).results || [];
  return rows.map((r) => ({
    subject: r.subject, sender: r.sender, sentAt: r.sent_at, result: r.result, outcome: r.outcome || '', files: r.files || 0, skipped: r.skipped || 0,
    meetingId: r.meeting_id, meeting: meetings[r.meeting_id] ? meetingName(meetings[r.meeting_id]) : null,
  }));
}

/** Every minute while there's a backlog, else hourly (sooner: minAgeMs); at once after an upgrade. Never throws. */
export async function maybeReadBoardMail(env, { fetchImpl = fetch, now = Date.now(), minAgeMs = EVERY_MS } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const s = await readState(env.DB, KEY);
    const due = s.version !== MAIL_VERSION ? 0 : s.backlog > 0 ? BACKLOG_MS : minAgeMs;
    if (s.checkedAt && now - Date.parse(s.checkedAt) < due) return null;
    return await readBoardMail(env, { fetchImpl, now });
  } catch (err) {
    console.error('[board-mail]', err.message);
    return null;
  }
}
