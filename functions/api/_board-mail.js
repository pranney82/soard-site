/**
 * Board mail: agendas, minutes and financials from Peter and Holly's email
 * ===========================================================================
 * Meetings are made in Board now (from the calendar, with their notes and
 * minutes typed here), so email is only for what comes from elsewhere: the
 * agendas and minutes of past meetings, and financial statements (QuickBooks
 * emails its reports). Every hour it searches each Board admin's Gmail for
 * those (MAIL_QUERIES) and brings in each email it hasn't seen:
 *   - an agenda or minutes (PDF or Word) is read with the same rules as Bring
 *     in an old agenda (parseAgendaText). It fills that meeting's agenda and
 *     notes when nobody has written any yet, or becomes a new meeting (an
 *     earlier one as approved minutes). A meeting someone has written in is
 *     never overwritten; the file is kept on it instead.
 *   - every attachment is kept on that meeting (financial statements filed as
 *     financials), never twice
 *   - the meeting is the one on the date the agenda says, else the date in
 *     the subject or file name, else the meeting closest after the email
 * The same email sent to both Peter and Holly is read once (by Message-ID).
 * Each email is read once (board_mail), a few per look so a backlog never
 * runs long. It never sends, deletes, labels or marks anything as read.
 *
 * Reads through the site's Google service account with the Gmail read-only
 * scope, which Google Admin must grant next to the calendar one (the admin's
 * Meetings tab names the client ID and the scope until it is).
 */

import { accessToken, GMAIL_READ_SCOPE, parseServiceAccount } from './_google-calendar.js';
import { boardAdmins, readState, writeState } from './_board-roles.js';
import { ensureSchema, listMeetings, saveMeeting, importMeeting, putFile, roster } from './_board.js';
import { parseAgendaText, isDate, todayEastern, meetingName, docxText, unzip } from '../../public/admin/board-shared.js';

export { docxText, unzip };

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Board agendas, minutes and financials; and QuickBooks' report emails, which never say "board"
export const MAIL_QUERIES = [
  'has:attachment newer_than:3y board (agenda OR minutes OR financials OR financial OR "balance sheet" OR "income statement" OR packet)',
  'has:attachment newer_than:1y (from:quickbooks OR from:intuit.com) ("profit and loss" OR "profit & loss" OR "balance sheet" OR "income statement" OR "statement of activities" OR "statement of financial position")',
];
export const MAIL_BY = 'board email';
const KEY = 'mail';
const WAITING = 'waiting for a meeting';
const PER_LOOK = 3;
const EVERY_MS = 60 * 60 * 1000;
const DOCS = /\.(pdf|docx|doc|xlsx|xls|pptx)$/i;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS board_mail (id TEXT PRIMARY KEY, msgid TEXT, admin TEXT, subject TEXT, sender TEXT, sent_at TEXT,
    meeting_id TEXT, result TEXT, files INTEGER DEFAULT 0, at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_board_mail_msgid ON board_mail(msgid)',
];
const _ready = new WeakSet();
async function ensureMail(DB) {
  if (_ready.has(DB)) return;
  await ensureSchema(DB);
  for (const s of SCHEMA) await DB.prepare(s).run();
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

/** What a file is, by its name (and the subject when that's all there is) */
export function fileKind(name, subject = '') {
  const n = String(name || '');
  if (/agenda|minutes/i.test(n)) return 'agenda';
  if (/financ|balance|income|p\s*&\s*l|profit|loss|budget|statement|cash\s*flow|activities/i.test(n)) return 'financials';
  if (/agenda|minutes/i.test(subject) && /\.(pdf|docx?)$/i.test(n)) return 'agenda';
  return 'other';
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** A date written in a subject or file name ("4.30.26", "04/30/2026", "April 30, 2026", "2026-04-30") → YYYY-MM-DD or '' */
export function dateIn(text, fallbackYear = Number(todayEastern().slice(0, 4))) {
  const s = String(text || '');
  const ok = (y, m, d) => { const v = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isDate(v) ? v : ''; };
  let m = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
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

// ─── Bringing one email in ──────────────────────────────────────────

const written = (m) => m.motions.length > 0 || m.sections.some((s) => s.items.some((it) => it.notes || it.staffNote));
const dayMs = (d) => Date.parse(`${d}T12:00:00Z`);

async function bringIn(env, { token, admin, id, fetchImpl, people, now }) {
  const msg = await gmail(token, `/messages/${id}?format=full`, fetchImpl);
  const msgid = header(msg, 'Message-ID') || id;
  const subject = header(msg, 'Subject').slice(0, 300);
  const sender = header(msg, 'From').slice(0, 200);
  const sentAt = new Date(Number(msg.internalDate) || now).toISOString();
  const record = (fields) => env.DB.prepare('INSERT OR REPLACE INTO board_mail (id, msgid, admin, subject, sender, sent_at, meeting_id, result, files, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`${admin}:${id}`, msgid, admin, subject, sender, sentAt, fields.meeting || null, fields.result, fields.files || 0, new Date(now).toISOString()).run();
  if (await env.DB.prepare('SELECT 1 FROM board_mail WHERE msgid = ? AND id != ?').bind(msgid, `${admin}:${id}`).first()) return record({ result: 'same email, already read from another inbox' });

  const files = [];
  for (const a of attachmentsOf(msg.payload)) {
    const data = a.data || (await gmail(token, `/messages/${id}/attachments/${a.attachmentId}`, fetchImpl)).data;
    files.push({ ...a, bytes: b64urlBytes(data), kind: fileKind(a.name, subject) });
  }
  if (!files.length) return record({ result: 'no documents attached' });

  const agenda = files.find((f) => f.kind === 'agenda');
  const text = agenda ? await fileText(env, agenda) : '';
  const parsed = text ? parseAgendaText(text, people) : null;
  const usable = parsed && parsed.sections.some((s) => s.items.length);
  const year = Number(sentAt.slice(0, 4));
  const day = (usable && parsed.date) || dateIn(subject, year) || (agenda && dateIn(agenda.name, year)) || '';
  let meetings = await listMeetings(env.DB);
  let m = day ? meetings.find((x) => x.date === day) : null;
  if (!m && !day) {
    // No date anywhere: the meeting closest after the email (an agenda goes out before), within six weeks
    const sent = sentAt.slice(0, 10);
    m = meetings.filter((x) => x.date >= sent && dayMs(x.date) - dayMs(sent) <= 45 * 86_400_000).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  }
  let result = '';
  if (m && usable && !written(m)) {
    const past = m.date < todayEastern(now);
    m = await saveMeeting(env.DB, {
      ...m, sections: parsed.sections,
      attendance: past && parsed.attendance.length ? parsed.attendance : m.attendance,
      location: m.location || parsed.location, start: m.start || parsed.start || '', end: m.end || parsed.end || '',
    }, { by: MAIL_BY });
    result = `agenda filled in from ${agenda.name}`;
  } else if (!m && usable && day) {
    m = await importMeeting(env, { ...parsed, date: day }, { by: MAIL_BY });
    result = `new meeting from ${agenda.name}`;
  } else if (m) {
    result = usable ? 'kept the files (the agenda here was already written)' : 'kept the files';
  }
  // No meeting for it yet (a report ahead of its meeting): it waits, and is tried again once a day
  if (!m) return record({ result: `${WAITING} ${day ? `on ${day}` : 'after it'}` });

  let kept = 0;
  const have = new Set(m.files.map((f) => `${f.name}|${f.size}`));
  for (const f of files) {
    if (have.has(`${f.name}|${f.bytes.byteLength}`)) continue;
    await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([f.bytes], f.name, { type: f.type }), kind: f.kind === 'agenda' ? 'agenda' : f.kind, staffOnly: false, by: MAIL_BY });
    kept += 1;
  }
  return record({ meeting: m.id, result: `${result}${kept ? `${result ? '; ' : ''}${kept === 1 ? 'one file' : `${kept} files`} kept` : ''}` || 'nothing new', files: kept });
}

// ─── A look ─────────────────────────────────────────────────────────

/** The service account's client ID (not secret): what Google Admin's delegation list shows */
export function clientIdOf(env) {
  try { return String(parseServiceAccount(env.GOOGLE_CALENDAR_KEY).client_id || ''); } catch { return ''; }
}

/** Read the admins' board mail, a few new emails per look → the saved state */
export async function readBoardMail(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  await ensureMail(env.DB);
  if (!env.GOOGLE_CALENDAR_KEY) return writeState(env.DB, KEY, { ok: false, configured: false, checkedAt: new Date(now).toISOString() });
  const last = await readState(env.DB, KEY); // (makes board_state on a new database)
  const lock = await env.DB.prepare(`INSERT INTO board_state (key, data, updated_at) VALUES ('mail-lock', ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE CAST(json_extract(board_state.data, '$.until') AS INTEGER) < ?`)
    .bind(JSON.stringify({ until: now + 5 * 60 * 1000 }), new Date(now).toISOString(), now).run();
  if (!((lock?.meta?.changes ?? 0) > 0)) return last;
  try {
    const admins = await boardAdmins(env.DB);
    const people = (await roster(env.DB)).board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization, kind: 'board' }))
      .concat((await roster(env.DB)).staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })));
    const errors = [];
    let needsScope = false;
    let waiting = 0;
    let brought = 0;
    for (const admin of admins) {
      let token;
      try { token = await accessToken(env, admin, { fetchImpl, now, scope: GMAIL_READ_SCOPE }); } catch (err) {
        if (/unauthorized_client|access_denied|not authorized/i.test(err.message)) needsScope = true;
        else errors.push(`${admin.split('@')[0]}’s email: ${String(err.message).slice(0, 200)}`);
        continue;
      }
      try {
        const ids = [];
        for (const q of MAIL_QUERIES) {
          for (const x of (await gmail(token, `/messages?maxResults=50&q=${encodeURIComponent(q)}`, fetchImpl)).messages || []) if (!ids.includes(x.id)) ids.push(x.id);
        }
        // Read already, except emails waiting for their meeting, which are tried again a day later
        const dayAgo = new Date(now - 86_400_000).toISOString();
        const seen = new Set(((await env.DB.prepare('SELECT id FROM board_mail WHERE admin = ? AND NOT (result LIKE ? AND at < ?)').bind(admin, `${WAITING}%`, dayAgo).all()).results || []).map((r) => r.id.slice(admin.length + 1)));
        const fresh = ids.filter((x) => !seen.has(x));
        waiting += fresh.length;
        for (const id of fresh) {
          if (brought >= PER_LOOK) break;
          try { await bringIn(env, { token, admin, id, fetchImpl, people, now }); } catch (err) {
            errors.push(`${admin.split('@')[0]}’s email: ${String(err.message).slice(0, 200)}`);
            continue;
          }
          brought += 1;
          waiting -= 1;
        }
      } catch (err) {
        errors.push(`${admin.split('@')[0]}’s email: ${String(err.message).slice(0, 200)}`);
      }
    }
    return await writeState(env.DB, KEY, {
      ok: !errors.length && !needsScope, configured: true, needsScope, clientId: needsScope ? clientIdOf(env) : '',
      checkedAt: new Date(now).toISOString(), brought, waiting, errors,
    });
  } finally {
    await env.DB.prepare("DELETE FROM board_state WHERE key = 'mail-lock'").run().catch(() => {});
  }
}

export const mailStatus = (DB) => readState(DB, KEY);

/** The latest emails Board read and what it did with each (Peter and Holly only) */
export async function mailLog(DB, limit = 12) {
  await ensureMail(DB);
  const meetings = Object.fromEntries((await listMeetings(DB)).map((m) => [m.id, m]));
  return ((await DB.prepare("SELECT * FROM board_mail WHERE result NOT LIKE 'same email%' ORDER BY sent_at DESC LIMIT ?").bind(limit).all()).results || [])
    .map((r) => ({ subject: r.subject, sender: r.sender, sentAt: r.sent_at, result: r.result, files: r.files, meetingId: r.meeting_id, meeting: meetings[r.meeting_id] ? meetingName(meetings[r.meeting_id]) : null }));
}

/** Every hour (sooner: minAgeMs; at once when there's a backlog). Never throws. */
export async function maybeReadBoardMail(env, { fetchImpl = fetch, now = Date.now(), minAgeMs = EVERY_MS } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const s = await readState(env.DB, KEY);
    const due = s.waiting > 0 ? 5 * 60 * 1000 : minAgeMs;
    if (s.checkedAt && now - Date.parse(s.checkedAt) < due) return null;
    return await readBoardMail(env, { fetchImpl, now });
  } catch (err) {
    console.error('[board-mail]', err.message);
    return null;
  }
}
