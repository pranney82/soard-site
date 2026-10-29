/**
 * SOARD mailboxes, read-only: a founder searches and reads a staff inbox
 * ===========================================================================
 * Some of SOARD's work still lives only in email: receipts sent to whoever
 * bought something, and families writing to a staff member or info@ instead of
 * through JobTread. A founder can search any active soardcharity.com mailbox
 * (Gmail's own search words), open an email or a whole conversation, and
 * download an attached file, to find those and move them where they belong.
 *
 *   - Read-only: Gmail's read-only scope, the one Board mail already has on the
 *     site's domain-wide delegation (_board-mail.js). Nothing is sent, moved,
 *     labelled or marked as read.
 *   - Nothing is kept: the site stores no mail. Every read goes to Google.
 *   - Every read is logged (audit_log): who, which mailbox, what they did.
 *   - Only founders (People → Team), only active SOARD accounts. An alias
 *     (info@ on someone's account) opens the account it belongs to; a group's
 *     address has no mailbox of its own.
 */

import { accessToken, GMAIL_READ_SCOPE } from './_google-calendar.js';
import { isStaffEmail, normEmail, peopleRows, founderEmails } from './_board-roles.js';
import { logAudit } from './_audit.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const MAX_LIST = 50;
const AT_ONCE = 6; // a Worker holds six connections open at a time
const MAX_TEXT = 20000;
const MAX_Q = 500;
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const PART = /^[0-9]+(\.[0-9]+)*$/;
const LIST_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];

const fail = (status, message) => Object.assign(new Error(message), { status });

/** A founder on People → Team, signed in with their soardcharity.com address */
export async function canRead(env, email) {
  const e = normEmail(email);
  if (!isStaffEmail(e) || !env.DB) return false;
  return founderEmails(await peopleRows(env.DB)).includes(e);
}

/** Google's accounts as the staff sign-in check last read them (_staff-access.js), or null before the first read */
async function directory(DB) {
  try {
    const row = await DB.prepare("SELECT data FROM staff_state WHERE key = 'directory'").first();
    return row ? JSON.parse(row.data)?.accounts || null : null;
  } catch { return null; }
}

/** The active accounts a founder can open: [{ email, name, aliases }] */
export async function mailboxes(env) {
  return ((await directory(env.DB)) || [])
    .filter((a) => a.active && isStaffEmail(a.email))
    .map((a) => ({ email: a.email, name: a.name || '', aliases: (a.aliases || []).filter(isStaffEmail) }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** The account an address opens → { email, name, alias? }: its own, or the one it's an alias of */
export async function resolveMailbox(env, address) {
  const e = normEmail(address);
  if (!isStaffEmail(e)) throw fail(400, 'Only a soardcharity.com mailbox can be opened');
  const accounts = await directory(env.DB);
  if (!accounts) return { email: e, name: '' }; // not read yet: Google answers for itself
  const all = accounts.filter((a) => a.email === e || (a.aliases || []).includes(e));
  const a = all.find((x) => x.active) || all[0];
  if (!a) throw fail(404, `${e} isn’t a Google account of its own (a group’s or forwarding address has no mailbox), so its mail is in the inboxes it goes to`);
  if (!a.active) throw fail(403, `${a.email}’s Google account is ${a.why === 'gone' ? 'deleted' : a.why}, so its mail can’t be read`);
  return { email: a.email, name: a.name || '', ...(a.email !== e ? { alias: e } : {}) };
}

async function gmail(token, path, fetchImpl) {
  const res = await fetchImpl(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw fail(res.status === 404 ? 404 : 500, `Gmail answered ${res.status}: ${body?.error?.message || ''}`.trim());
  return body;
}

async function open(env, address, fetchImpl, now) {
  const box = await resolveMailbox(env, address);
  try {
    return { box, token: await accessToken(env, box.email, { fetchImpl, now, scope: GMAIL_READ_SCOPE }) };
  } catch (err) {
    throw fail(500, /unauthorized_client/.test(err.message)
      ? 'Google hasn’t given the site Gmail read access: Google Admin → Security → API controls → Domain-wide delegation needs gmail.readonly on the site’s client'
      : err.message);
  }
}

async function inBatches(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += AT_ONCE) out.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(fn))));
  return out;
}

// ─── Reading a message ──────────────────────────────────────────────

const header = (headers, name) => (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

const bytesOf = (data) => Uint8Array.from(atob(String(data || '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function decode(data, contentType = '') {
  const bytes = bytesOf(data);
  const charset = /charset="?([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™' };

/** An HTML email as plain text: receipts and newsletters often send no text part */
export function htmlText(html) {
  return String(html || '')
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? m;
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function partsOf(payload) {
  const out = [];
  const walk = (p) => { if (!p) return; out.push(p); for (const c of p.parts || []) walk(c); };
  walk(payload);
  return out;
}

const isFile = (p) => Boolean(p.filename) && Boolean(p.body?.attachmentId || p.body?.data);

/** The email's words: its plain-text part, else its HTML as text */
function textOf(payload) {
  const parts = partsOf(payload).filter((p) => !isFile(p) && p.body?.data);
  const plain = parts.find((p) => p.mimeType === 'text/plain');
  const html = parts.find((p) => p.mimeType === 'text/html');
  const ct = (p) => header(p.headers, 'Content-Type');
  const text = plain ? decode(plain.body.data, ct(plain)).trim() : html ? htmlText(decode(html.body.data, ct(html))) : '';
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text;
}

/** Attached files: [{ part, name, type, size, inline }] (part is the stable id a download asks for) */
function filesOf(payload) {
  return partsOf(payload).filter(isFile).map((p) => ({
    part: p.partId,
    name: p.filename,
    type: p.mimeType || '',
    size: p.body.size || 0,
    inline: /^inline/i.test(header(p.headers, 'Content-Disposition')),
  }));
}

function summaryOf(msg) {
  const h = msg.payload?.headers;
  return {
    id: msg.id,
    thread: msg.threadId,
    at: new Date(Number(msg.internalDate) || 0).toISOString(),
    from: header(h, 'From'),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    subject: header(h, 'Subject'),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
  };
}

const fullOf = (msg) => ({ ...summaryOf(msg), replyTo: header(msg.payload?.headers, 'Reply-To'), text: textOf(msg.payload), files: filesOf(msg.payload) });

// ─── What the endpoint does ─────────────────────────────────────────

const audit = (env, me, box, what) => logAudit(env.DB, { userEmail: me, action: 'viewed', entityType: 'mailbox', entitySlug: box.email, entityName: what, gitStatus: 'ok' });

/** Gmail's search, newest first → { mailbox, q, total, next, messages: [summary] } */
export async function searchMail(env, { me, mailbox, q = '', max = 25, page = '', fetchImpl = fetch, now = Date.now() }) {
  const words = String(q || '').slice(0, MAX_Q);
  const n = Math.min(Math.max(Number(max) || 25, 1), MAX_LIST);
  const { box, token } = await open(env, mailbox, fetchImpl, now);
  const pageToken = /^[A-Za-z0-9_-]{1,200}$/.test(String(page || '')) ? `&pageToken=${page}` : '';
  const list = await gmail(token, `/messages?maxResults=${n}&q=${encodeURIComponent(words)}${pageToken}`, fetchImpl);
  const meta = LIST_HEADERS.map((x) => `&metadataHeaders=${x}`).join('');
  const msgs = await inBatches((list.messages || []).map((m) => m.id), (id) => gmail(token, `/messages/${id}?format=metadata${meta}`, fetchImpl));
  await audit(env, me, box, words ? `searched for “${words.slice(0, 120)}”` : 'looked at the newest email');
  return { mailbox: box, q: words, total: list.resultSizeEstimate || 0, next: list.nextPageToken || null, messages: msgs.map(summaryOf) };
}

/** One email: its words and its files → { mailbox, message } */
export async function readMessage(env, { me, mailbox, id, fetchImpl = fetch, now = Date.now() }) {
  if (!ID.test(String(id || ''))) throw fail(400, 'That isn’t an email’s id');
  const { box, token } = await open(env, mailbox, fetchImpl, now);
  const message = fullOf(await gmail(token, `/messages/${id}?format=full`, fetchImpl));
  await audit(env, me, box, `opened “${message.subject.slice(0, 120)}”`);
  return { mailbox: box, message };
}

/** A whole conversation, oldest first → { mailbox, thread, messages } */
export async function readThread(env, { me, mailbox, thread, fetchImpl = fetch, now = Date.now() }) {
  if (!ID.test(String(thread || ''))) throw fail(400, 'That isn’t a conversation’s id');
  const { box, token } = await open(env, mailbox, fetchImpl, now);
  const t = await gmail(token, `/threads/${thread}?format=full`, fetchImpl);
  const messages = (t.messages || []).map(fullOf);
  await audit(env, me, box, `opened the conversation “${(messages[0]?.subject || '').slice(0, 120)}”`);
  return { mailbox: box, thread, messages };
}

/** One attached file → { mailbox, name, type, bytes } */
export async function readFile(env, { me, mailbox, id, part, fetchImpl = fetch, now = Date.now() }) {
  if (!ID.test(String(id || ''))) throw fail(400, 'That isn’t an email’s id');
  if (!PART.test(String(part || ''))) throw fail(400, 'That isn’t one of the email’s files');
  const { box, token } = await open(env, mailbox, fetchImpl, now);
  const msg = await gmail(token, `/messages/${id}?format=full`, fetchImpl);
  const p = partsOf(msg.payload).find((x) => x.partId === String(part) && isFile(x));
  if (!p) throw fail(404, 'That email has no such file');
  const data = p.body.data || (await gmail(token, `/messages/${id}/attachments/${encodeURIComponent(p.body.attachmentId)}`, fetchImpl)).data;
  await audit(env, me, box, `downloaded ${p.filename}`);
  return { mailbox: box, name: p.filename, type: p.mimeType || '', bytes: bytesOf(data) };
}
