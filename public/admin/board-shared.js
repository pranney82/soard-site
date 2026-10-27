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
 *   sections     [{ id, title, items: [{ id, title, presenter, notes,
 *                  staffNote (Peter and Holly only), confidential (never
 *                  emailed), live: '' | projects | reveals | events | cash | meetings }] }]
 *   motions      [{ id, text, by, second, result: passed|failed|tabled }]
 *   actions      [{ id, text, owner (a People slug), ownerName, due, done, doneOn }]
 *   files        [{ id, name, type, size, kind, staffOnly, at }]
 *   snapshot     the numbers locked in for the packet (see _board.js takeSnapshot)
 *   calendar     the calendar event it follows (functions/api/_board-calendar.js):
 *                { uid, others (the same meeting on another admin's calendar), title,
 *                from, link, gone, place, call }, or null
 *   packetSentAt, packetSentTo
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
  { id: 'yes', label: 'I’ll be there' },
  { id: 'remote', label: 'Joining by video' },
  { id: 'no', label: 'Can’t make it' },
];
export const RESULTS = [
  { id: 'passed', label: 'Passed' },
  { id: 'failed', label: 'Did not pass' },
  { id: 'tabled', label: 'Tabled' },
];
export const FILE_KINDS = [
  { id: 'financials', label: 'Financial statements' },
  { id: 'packet', label: 'Packet' },
  { id: 'agenda', label: 'Original agenda' },
  { id: 'minutes', label: 'Signed minutes' },
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
  { id: 'cash', label: 'Cash in the bank (Mercury)' },
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
/** The meeting's name: its own title, else "Q2 2026 Board Meeting" */
export const meetingName = (m) => one(m?.title) || (isDate(m?.date) ? `${quarterOf(m.date)} Board Meeting` : 'Board meeting');
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
    notes: str(raw?.notes, LIMITS.notes),
    staffNote: str(raw?.staffNote, LIMITS.notes),
    confidential: bool(raw?.confidential),
    live,
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
    title: one(raw.title, LIMITS.title),
    location: one(raw.location, 200),
    address: one(raw.address, 300),
    video: httpUrl(raw.video),
    shared: bool(raw.shared),
    minutes: raw.minutes === 'approved' ? 'approved' : 'draft',
    approvedOn: raw.minutes === 'approved' ? date(raw.approvedOn) : '',
    attendance,
    sections,
    motions: (Array.isArray(raw.motions) ? raw.motions : []).slice(0, LIMITS.rows).map((x) => ({
      id: idOr(x?.id, 'v_'), text: str(x?.text, 1000), by: one(x?.by, 120), second: one(x?.second, 120), result: pick(x?.result, RESULTS, 'passed'),
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
      gone: bool(raw.calendar.gone), place: bool(raw.calendar.place), call: bool(raw.calendar.call),
    } : null,
    packetSentAt: one(raw.packetSentAt, 40),
    packetSentTo: Number(raw.packetSentTo) > 0 ? Math.round(raw.packetSentTo) : 0,
    createdAt: one(raw.createdAt, 40),
    updatedAt: one(raw.updatedAt, 40),
    updatedBy: one(raw.updatedBy, 200),
  };
}

/**
 * What a board member sees: only shared meetings, never Peter and Holly's
 * own notes or a staff-only file. Null for a meeting not shared yet.
 */
export function forBoard(m) {
  if (!m?.shared) return null;
  return {
    ...m,
    sections: m.sections.map((s) => ({ ...s, items: s.items.map(({ staffNote, ...it }) => it) })),
    files: m.files.filter((f) => !f.staffOnly),
    calendar: undefined,
    updatedBy: undefined,
  };
}

/** For an email (which can be forwarded): agenda headings only, a confidential item by its section alone */
export function emailOutline(m) {
  return m.sections.filter((s) => s.title).map((s) => ({
    title: s.title,
    items: s.items.filter((it) => it.title).map((it) => (it.confidential ? 'A confidential item (on the board page)' : it.title)),
  }));
}

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
      ...cleanItem({ title: it.live === 'minutes' && prev ? `Minutes of the ${meetingName(prev)} (${shortDate(prev.date)})` : it.title, presenter: it.presenter, live: it.live }),
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
 * → { date, start, end, location, attendance, sections, unmatched: [lines] }
 */
export function parseAgendaText(text, people = []) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim());
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
  let levels = []; // the points open under the item, outermost first: [kind ('a' | 'i' | '1'), value]
  let inHeader = true;
  const newItem = (title) => {
    item = { id: uid('i_'), title: title.trim(), presenter: '', notes: '', staffNote: '', confidential: false, live: '' };
    const who = item.title.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (who && presenterOf(who[2])) { item.title = who[1]; item.presenter = presenterOf(who[2]); }
    if (!section) { section = { id: uid('s_'), title: '', items: [] }; out.sections.push(section); }
    section.items.push(item);
    levels = [];
  };
  const point = (kind, value, body) => {
    const at = levels.findIndex((l) => l[0] === kind);
    if (at >= 0) levels = levels.slice(0, at);
    else if (kind === 'a') levels = [];
    levels.push([kind, value]);
    if (!item) newItem('');
    item.notes += `${item.notes ? '\n' : ''}${'  '.repeat(levels.length - 1)}- ${body.trim()}`;
  };
  for (const line of lines) {
    if (!line || /^\d+\s*\|\s*P\s*a\s*g\s*e$/i.test(line) || /^page \d+( of \d+)?$/i.test(line)) continue;
    // A section: "1. CALL TO ORDER"
    const sec = line.match(/^(\d{1,2})\.\s*(.+)$/);
    if (sec && sec[2] === sec[2].toUpperCase() && /[A-Z]{3}/.test(sec[2])) {
      inHeader = false;
      section = { id: uid('s_'), title: sentenceCase(sec[2].trim()), items: [] };
      out.sections.push(section);
      item = null; itemNo = 0; levels = [];
      continue;
    }
    if (inHeader) {
      if (/^(MEETING|LOCATION|DATE|TIME|ATTENDEE)\b/i.test(line) || /^\d{1,2}:\d{2}\s*[ap]/i.test(line)) continue;
      // The attendee table: "x Jennifer Crosby Crosby Design Group x Holly Ranney" (two columns, x = there)
      const parts = (` ${line}`).split(/\s+x\s+/i);
      if (parts[0].trim()) attend(parts[0].trim(), false);
      for (const seg of parts.slice(1)) attend(seg.trim(), true);
      continue;
    }
    const m = line.match(/^(\d{1,2}|[a-z]{1,4})\.\s*(.+)$/i);
    const mark = m && (/^\d+$/.test(m[1]) || m[1].length === 1 || ROMAN.test(m[1])) ? m[1] : null;
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
  out.sections = out.sections.map((s) => ({ ...s, items: s.items.filter((it) => it.title || it.notes) })).filter((s) => s.title || s.items.length);
  return out;
}

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
    }
    const f = n.finance;
    if (f?.ytd) {
      const spent = (p) => (p.makeovers || 0) + (p.store || 0) + (p.operating || 0);
      out.push(`${f.ytd.year} so far (through ${monthName(f.ytd.through)}): ${money(f.ytd.income)} in, ${money(spent(f.ytd))} out, ${netText(f.ytd.net)}${f.lastYtd ? `; ${f.lastYtd.year} to the same day: ${netText(f.lastYtd.net)}` : ''}`);
    }
    if (f?.cash?.lowest) out.push(`Cash forecast: lowest ${money(f.cash.lowest.dollars)}${f.cash.lowest.week ? ` the week of ${shortDay(f.cash.lowest.week)}` : ''}, ${money(f.cash.in13Weeks)} in 13 weeks${f.cash.belowFloor ? `, under the ${money(f.cash.floor)} floor` : ''}`);
    if (f?.close?.label) out.push(`${f.close.label}’s books: ${{ closed: 'closed', ready: 'ready to close', open: 'still open' }[f.close.state] || f.close.state}`);
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
      if (names.length) out.push(`${s}: ${names.join(', ')}`);
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
