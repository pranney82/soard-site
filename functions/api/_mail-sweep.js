/**
 * Staff inboxes, swept: receipts to the receipt inbox, family emails onto JobTread
 * ===========================================================================
 * Everyone at SOARD buys things and writes to families from their own inbox.
 * Every few minutes the site reads each active soardcharity.com mailbox's new
 * mail (Gmail read-only, the access in _mailbox.js) and sorts it:
 *
 *   - A receipt, paid order or bill for something bought → emailed to the
 *     receipt inbox (Job Costs settings, ap@ by default, which forwards to the
 *     DataX Receipt Processor) with its files, the way Mercury's receipt photos
 *     go (_spend-receipts.js). Workers AI reads it first, so shipping and
 *     delivery notices, ads, carts, refunds, statements, gifts to SOARD and
 *     personal purchases stay out. So do emails the receipt inbox already has
 *     (on the email, or anywhere in its conversation), mail between staff and
 *     the money tools' own notices.
 *   - An email to or from a family (an address on an applicant's JobTread
 *     account) → a comment on that account that the family can't see and
 *     nobody is assigned to, so JobTread emails no one: who wrote to whom and
 *     when, the words without the quoted history, and the files. Replies go
 *     under the first email of their conversation. The last year's family
 *     emails are brought in once, oldest first, before any newer ones.
 *
 * Each email is handled once, even when it's in several inboxes (Message-ID).
 * Receipts start from the day this was turned on: older ones were forwarded by
 * hand and their bills exist. For its first day it only watches: what it would
 * have done shows in Automations, and is then done.
 */

import { isStaffEmail, normEmail } from './_board-roles.js';
import { accessToken, GMAIL_READ_SCOPE } from './_google-calendar.js';
import { mailboxes, gmail, header, textOf, htmlText, filesOf, partsOf, bytesOf } from './_mailbox.js';
import { pave, SOARD_ORG_ID } from './_reveals.js';
import { postAccountComment } from './_applicant-comms.js';
import { EMAIL_FROM, emailConfigured } from './_broadcast-notify.js';
import { logSent } from './_email-log.js';
import { readConfig } from './_spend.js';
import { DEFAULT_RECEIPT_INBOX } from './_spend-receipts.js';
import { FREE_MAIL } from './_kid-partners.js';

const EVERY_MS = 3 * 60 * 1000;
const BUSY_MS = 60 * 1000;          // while there's a backlog
const READ_MS = 8 * 1000;           // the heartbeat's other jobs share its ~30 seconds: reading the inboxes stops here,
const HANDLE_MS = 13 * 1000;        // and no new email is started after this (one can take Workers AI's 8 seconds)
export const WATCH_MS = 24 * 60 * 60 * 1000;
const BACKFILL_DAYS = 365;
const OVERLAP_MS = 10 * 60 * 1000;  // mail Gmail dates a little before the last look
const PER_LIST = 100;
const MAX_TRIES = 3;
const RETRY_MS = 10 * 60 * 1000;
const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SEND_BYTES = 30 * 1024 * 1024; // Resend takes 40 MB an email, after base64
const SIGNATURE_BYTES = 40 * 1024;  // an inline picture smaller than this is a logo, not a photo
const Q_MAX = 1200;
const AT_ONCE = 6;
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_TIMEOUT_MS = 8000;
const LIST_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Message-ID', 'References', 'In-Reply-To', 'Auto-Submitted', 'List-Id', 'List-Unsubscribe', 'Precedence'];
const SENT_TAG = 'receipt-from-inbox';

// The money tools' and JobTread's own mail: already where it belongs
const OWN_TOOLS = /@([\w-]+\.)*(ramp\.com|mercury\.com|jobtread\.com|zeffy\.com|intuit\.com|quickbooks\.com|plaid\.com|companycam\.com)$/i;
const RECEIPTISH = /\b(receipts?|invoices?|bills?|order (confirmation|confirmed|received|placed|summary|details|#|no\.?|number)|your (order|purchase|payment)|payment (received|confirmation|confirmed|successful|processed)|purchase (confirmation|confirmed)|thanks? (you )?for (your )?([\w-]+ )?(order|purchase|payment|shopping)|(we('ve| have)|has been) received|charged|paid)\b/i;
const NOT_RECEIPT = /\b(shipped|ships|on (its|the) way|out for delivery|delivered|arriving|arrives|has arrived|track(ing)?\b|in your (cart|bag)|cart misses|left (something|in)|wish ?list|\d+% off|sale\b|deals?\b|coupons?|price drop|back in stock|review (your|us)|rate (your|us)|survey|refund(ed)?|returns?\b|statement)\b/i;
const CALENDAR = /^(accepted|declined|tentatively accepted|tentative|invitation|updated invitation|cancell?ed (event|invitation)|new event|proposed new time)\b/i;
// A reply on an invite's thread (a reveal's): every guest is on it, so only the family's and staff's own count
const AUTO_REPLY = /^\W*(out of (the )?office|automatic reply|auto(matic)?[- ]?(reply|response)|autoreply|away from)/i;
// A contact who's family (JobTread's title): "Mom", "Stepfather", "Secondary parent", "Dylan grandparent"
const FAMILY_TITLE = /(^|\W)(mom|moth|mama|dad|fath|papa|parent|guardian|grand|aunt|uncle|step|caregiver|foster|sister|brother|husband|wife|spouse|family)/i;
const INVITE_REPLY = /^((re|fwd?):\s*)+(updated )?invitation\b/i;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mail_sweep (
    mailbox TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    msgid TEXT, conv TEXT, accounts TEXT, subject TEXT, detail TEXT, comment_ids TEXT, tries INTEGER DEFAULT 0,
    source TEXT, updated_at TEXT, PRIMARY KEY (mailbox, id))`,
  'CREATE INDEX IF NOT EXISTS idx_mail_sweep_state ON mail_sweep(state, at)',
  'CREATE INDEX IF NOT EXISTS idx_mail_sweep_msgid ON mail_sweep(msgid)',
  'CREATE INDEX IF NOT EXISTS idx_mail_sweep_conv ON mail_sweep(conv)',
  'CREATE TABLE IF NOT EXISTS mail_sweep_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
];
const _ready = new WeakSet();
// Added after the first deploy: the files a family email brought (name:size), so a reply carrying them again doesn't add them twice
const COLUMNS = ['file_keys TEXT'];
async function ensure(DB) {
  if (_ready.has(DB)) return;
  for (const s of SCHEMA) await DB.prepare(s).run();
  const have = new Set(((await DB.prepare('PRAGMA table_info(mail_sweep)').all()).results || []).map((c) => c.name));
  for (const c of COLUMNS) if (!have.has(c.split(' ')[0])) await DB.prepare(`ALTER TABLE mail_sweep ADD COLUMN ${c}`).run();
  _ready.add(DB);
}
async function readState(DB) {
  const row = await DB.prepare("SELECT data FROM mail_sweep_state WHERE key = 'sweep'").first();
  try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
}
const writeState = (DB, st) => DB.prepare("INSERT OR REPLACE INTO mail_sweep_state (key, data, updated_at) VALUES ('sweep', ?, ?)")
  .bind(JSON.stringify(st), new Date().toISOString()).run();

const addresses = (s) => (String(s || '').match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[a-z]{2,}/gi) || []).map(normEmail);
const firstName = (name, email) => String(name || '').trim().split(/\s+/)[0] || String(email).split('@')[0];
const when = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// ─── Who's a family ─────────────────────────────────────────────────

/**
 * The family's addresses on each applicant's account (the site's copy of
 * JobTread, _applicants.js) → { byEmail: Map(email → [account ids]), names }.
 * On a family's account (a contact titled Mom, Dad, parent…) only the family
 * counts: a wish coordinator, caseworker or designer on it doesn't, and an
 * untitled contact counts on a personal address (Gmail and the like). On an
 * organization's account (a school's director) everyone on it is the
 * applicant. Staff and JobTread addresses never count.
 */
export async function familyAddresses(DB) {
  const byEmail = new Map();
  const names = new Map();
  let rows = [];
  try { rows = (await DB.prepare('SELECT account_id, name, contact_email, contacts FROM applicants').all()).results || []; } catch { return { byEmail, names }; }
  for (const r of rows) {
    // A staff test run's account carries a staff member's own address
    if (/\btest\b/i.test(r.name || '')) continue;
    names.set(r.account_id, r.name);
    let contacts = [];
    try { contacts = (JSON.parse(r.contacts || '[]') || []).filter((c) => c && typeof c === 'object'); } catch { /* none */ }
    const isFamily = contacts.some((c) => FAMILY_TITLE.test(c.title || ''));
    const counts = (c) => !isFamily || FAMILY_TITLE.test(c.title || '') || (!String(c.title || '').trim() && addresses(c.email).every((e) => FREE_MAIL.has(e.split('@')[1])));
    const theirs = contacts.flatMap((c) => addresses(c.email).map((e) => [e, counts(c)]));
    const left = new Set(theirs.filter(([, ok]) => !ok).map(([e]) => e));
    const kept = [...theirs.filter(([, ok]) => ok).map(([e]) => e), ...addresses(r.contact_email).filter((e) => !left.has(e))];
    for (const e of new Set(kept)) {
      if (isStaffEmail(e) || OWN_TOOLS.test(e)) continue;
      byEmail.set(e, [...new Set([...(byEmail.get(e) || []), r.account_id])]);
    }
  }
  return { byEmail, names };
}

/** The accounts an email's people belong to. An address on two families' accounts (a caseworker) points at neither */
function accountsOf(people, byEmail) {
  const out = new Set();
  for (const e of people) {
    const ids = byEmail.get(e);
    if (ids?.length === 1) out.add(ids[0]);
  }
  return [...out];
}

/**
 * What an email is to the sweep, from its headers: { kind: 'family', accounts }
 * | { kind: 'receipt' } | null. Family wins; a mailing to more than three
 * families is a newsletter, not a conversation.
 */
export function triage(msg, { byEmail }) {
  const h = msg.payload?.headers;
  const subject = header(h, 'Subject');
  const from = addresses(header(h, 'From'));
  const people = [...new Set([...from, ...addresses(header(h, 'To')), ...addresses(header(h, 'Cc')), ...addresses(header(h, 'Reply-To'))])];
  if (CALENDAR.test(subject.trim()) || AUTO_REPLY.test(subject) || /auto-replied/i.test(header(h, 'Auto-Submitted'))) return null;
  const tools = people.some((e) => OWN_TOOLS.test(e));
  const guestChatter = INVITE_REPLY.test(subject.trim()) && !from.every(isStaffEmail) && !accountsOf(from, byEmail).length;
  // A mailing list's email (a family's business newsletter); SOARD's own groups (info@) mark theirs too, and those count
  const list = `${header(h, 'List-Id')} ${header(h, 'List-Unsubscribe')}`;
  const mailing = (list.trim() || /bulk|list|junk/i.test(header(h, 'Precedence'))) && !/soardcharity\.com/i.test(list);
  const accounts = tools || guestChatter || mailing ? [] : accountsOf(people, byEmail);
  if (accounts.length && accounts.length <= 3) return { kind: 'family', accounts };
  if (!from.length || from.every(isStaffEmail) || from.some((e) => OWN_TOOLS.test(e))) return null;
  if ((msg.labelIds || []).includes('SENT') || NOT_RECEIPT.test(subject)) return null;
  return RECEIPTISH.test(`${subject} ${msg.snippet || ''}`) ? { kind: 'receipt' } : null;
}

/** The conversation an email belongs to: the first Message-ID it refers to, else its own */
function convOf(h) {
  const refs = header(h, 'References').match(/<[^>]+>/g) || [];
  return refs[0] || header(h, 'In-Reply-To').match(/<[^>]+>/)?.[0] || header(h, 'Message-ID') || null;
}

/** An email's own words: the quoted history of a reply cut off (forwarded mail is kept) */
export function withoutQuoted(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // "On Mon, Oct 20, 2026 at 3:15 PM Jane <jane@example.com> wrote:", sometimes over two lines
    if (/^On\b/.test(l) && (/\bwrote:\s*$/.test(l) || (/\bwrote:\s*$/.test(lines[i + 1] || '') && `${l} ${lines[i + 1]}`.length < 320))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^_{10,}\s*$/.test(l)) break;
    if (/^From:\s.+/.test(l) && lines.slice(i + 1, i + 5).some((x) => /^(Sent|Date):\s/.test(x))) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  const own = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return own || String(text || '').trim();
}

// ─── Is it a receipt? ───────────────────────────────────────────────

const RECEIPT_PROMPT = `You sort email for Sunshine on a Ranney Day (SOARD), a children's charity that makes over bedrooms, bathrooms and therapy spaces for children with special needs. Staff buy furniture, decor, bedding, paint, building supplies, services and office things for the makeovers and the office.

Given one email from a staff member's inbox, reply with JSON only:
{"type": "receipt" | "bill" | "not_receipt", "vendor": "<the seller>", "total": "<the amount charged or owed, as written, or empty>", "date": "<YYYY-MM-DD or empty>", "personal": true | false, "reason": "<under 15 words>"}

- receipt: proof a purchase was made: a receipt, an order confirmation (even when the email doesn't show the amount; many stores leave it out), a paid invoice, a payment confirmation.
- bill: an invoice from a vendor or contractor asking SOARD to pay for goods or work.
- not_receipt: shipping, delivery or tracking notices; ads, sales, carts, wish lists; surveys and requests for a review or feedback, even when they thank you for a purchase; free samples; quotes and estimates; refunds and returns; account statements, "your bill is ready" notices and anything paid automatically (utilities, phone, internet, insurance, loans, credit cards); donation receipts or gift notices for money given TO SOARD; newsletters; anything else.
- personal: true only when the email shows it's the staff member's own purchase, not SOARD's: a personal subscription, or groceries or clothes for themselves shipped to their home. SOARD also buys toys, games, books, photo prints, cakes, food and gifts for the children, families, reveals, volunteers and events, so those are SOARD's. A store membership or rewards program (Wayfair Rewards, Amazon Prime, Costco), and anything ordered with one, is SOARD's too. When unsure, false.`;
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['receipt', 'bill', 'not_receipt'] }, vendor: { type: 'string' }, total: { type: 'string' },
    date: { type: 'string' }, personal: { type: 'boolean' }, reason: { type: 'string' },
  },
  required: ['type', 'personal'],
};

function readVerdict(out) {
  let j = out?.response ?? out;
  if (typeof j === 'string') { try { j = JSON.parse(j.slice(j.indexOf('{'), j.lastIndexOf('}') + 1)); } catch { return null; } }
  if (!j || !['receipt', 'bill', 'not_receipt'].includes(j.type)) return null;
  return {
    type: j.type, vendor: String(j.vendor || '').slice(0, 80), total: String(j.total || '').slice(0, 30),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || '')) ? j.date : '', personal: j.personal === true, reason: String(j.reason || '').slice(0, 120),
  };
}

const AMOUNT = /\$\s?\d/;
// Soft hyphens, zero-width and other blank characters (a store's preview padding runs to thousands of them)
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\u3164\ufeff\uffa0]/g;

/** A receipt's words. Many stores' plain-text part is only a link ("view your order"), with the order itself in the HTML */
export function receiptText(payload) {
  const text = textOf(payload);
  if (AMOUNT.test(text)) return text;
  const html = partsOf(payload).find((p) => p.mimeType === 'text/html' && !p.filename && p.body?.data);
  const fromHtml = html ? htmlText(new TextDecoder().decode(bytesOf(html.body.data))) : '';
  return AMOUNT.test(fromHtml) ? fromHtml : text;
}

/** Workers AI's verdict on one email; the rules when it can't answer → { type, vendor, total, date, personal, reason, by } */
export async function judgeReceipt(env, { subject, from, owner, text, files }) {
  if (env.AI?.run) {
    // Links and the invisible padding stores put after the preview line go: either can fill the model's whole share of the email before the order does
    const words = String(text).replace(/[(<]?\s*https?:\/\/[^\s>)]+\s*[)>]?/g, ' ').replace(INVISIBLE, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n');
    const input = [`Inbox of: ${owner}`, `From: ${from}`, `Subject: ${subject}`, `Files: ${files.map((f) => f.name).join(', ') || 'none'}`, `Email:\n${words.slice(0, 3500)}`].join('\n');
    let timer;
    try {
      const out = await Promise.race([
        env.AI.run(AI_MODEL, {
          messages: [{ role: 'system', content: RECEIPT_PROMPT }, { role: 'user', content: input }],
          max_tokens: 200, temperature: 0, response_format: { type: 'json_schema', json_schema: RECEIPT_SCHEMA },
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), AI_TIMEOUT_MS); }),
      ]);
      const v = readVerdict(out);
      if (v) return { ...v, by: 'ai' };
    } catch (err) {
      console.error('[mail-sweep] judging', err.message);
    } finally {
      clearTimeout(timer);
    }
  }
  // No model: only a plain receipt or invoice with an amount in it
  const amount = String(text).match(/\$\s?\d[\d,]*(\.\d{2})?/)?.[0] || '';
  const sure = /\b(receipt|order confirmation|payment (received|confirmation)|invoice)\b/i.test(subject) && amount;
  return { type: sure ? (/invoice/i.test(subject) ? 'bill' : 'receipt') : 'not_receipt', vendor: from.replace(/<.*>/, '').replace(/"/g, '').trim().slice(0, 80), total: amount, date: '', personal: false, reason: sure ? 'a receipt by its subject' : 'not clearly a receipt', by: 'rules' };
}

// ─── Files ──────────────────────────────────────────────────────────

/** The files worth passing on: attachments, and photos pasted into the email (not signature logos) */
function filesWorth(payload) {
  return filesOf(payload).filter((f) => !f.inline || f.size >= SIGNATURE_BYTES).filter((f) => f.size <= MAX_FILE_BYTES).slice(0, MAX_FILES);
}

async function fileBytes(token, msg, f, fetchImpl) {
  const p = partsOf(msg.payload).find((x) => x.partId === f.part);
  const data = p?.body?.data || (await gmail(token, `/messages/${msg.id}/attachments/${encodeURIComponent(p.body.attachmentId)}`, fetchImpl)).data;
  return bytesOf(data);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function uploadToJobTread(env, { bytes, type }, fetchImpl) {
  const out = await pave(env.JOBTREAD_GRANT_KEY, {
    createUploadRequest: { $: { organizationId: SOARD_ORG_ID, size: bytes.byteLength, type: type || 'application/octet-stream' }, createdUploadRequest: { id: {}, url: {}, method: {}, headers: {} } },
  }, fetchImpl);
  const req = out?.createUploadRequest?.createdUploadRequest;
  if (!req?.url) throw new Error('JobTread did not return an upload URL');
  const res = await fetchImpl(req.url, { method: req.method || 'PUT', headers: req.headers || {}, body: bytes });
  if (!res.ok) throw new Error(`JobTread upload returned ${res.status}`);
  return req.id;
}

// ─── Handling one email ─────────────────────────────────────────────

async function handleReceipt(env, ctx, row, msg) {
  const h = msg.payload?.headers;
  const inbox = ctx.receiptInbox;
  const subject = header(h, 'Subject');
  const from = header(h, 'From');
  if ([...addresses(from), ...addresses(header(h, 'To')), ...addresses(header(h, 'Cc'))].includes(inbox)) return { state: 'skipped', detail: 'already at the receipt inbox' };
  const meta = ['From', 'To', 'Cc'].map((x) => `&metadataHeaders=${x}`).join('');
  const thread = await gmail(ctx.token, `/threads/${msg.threadId}?format=metadata${meta}`, ctx.fetchImpl);
  if ((thread.messages || []).some((m) => [...addresses(header(m.payload?.headers, 'To')), ...addresses(header(m.payload?.headers, 'Cc'))].includes(inbox))) {
    return { state: 'skipped', detail: 'its conversation already went to the receipt inbox' };
  }
  const text = receiptText(msg.payload);
  const files = filesWorth(msg.payload);
  const v = await judgeReceipt(env, { subject, from, owner: ctx.ownerName, text, files });
  if (v.type === 'not_receipt') return { state: 'skipped', detail: `not a receipt: ${v.reason || 'the model said so'}` };
  if (v.personal) return { state: 'skipped', detail: `personal: ${v.reason || 'the model said so'}` };
  const what = `${v.vendor || 'a vendor'}${v.total ? ` ${v.total}` : ''}`;
  if (ctx.watching) return { state: 'would', detail: `would send ${what} to ${inbox}` };
  if (!emailConfigured(env)) throw new Error('RESEND_API_KEY isn’t set, so receipts can’t be sent on');

  const attachments = [];
  let total = 0;
  for (const f of files) {
    if ((total += f.size) > MAX_SEND_BYTES) break;
    attachments.push({ filename: f.name, content: toBase64(await fileBytes(ctx.token, msg, f, ctx.fetchImpl)) });
  }
  // A receipt that's only the email itself: the email goes along as a file too
  const html = partsOf(msg.payload).find((p) => p.mimeType === 'text/html' && !p.filename && p.body?.data);
  if (!attachments.length && html) attachments.push({ filename: 'receipt.html', content: toBase64(bytesOf(html.body.data)) });
  const sentAt = Number(msg.internalDate) || ctx.now;
  const day = v.date || new Date(sentAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const body = [
    `A ${v.type === 'bill' ? 'bill' : 'receipt'} found in ${ctx.ownerName}’s email (${row.mailbox}).`,
    `Vendor: ${v.vendor || 'not named'}`, `Amount: ${v.total || 'not found'}`, `Date: ${day}`,
    `Original email from ${from}, ${when(sentAt)}: “${subject}”`,
    '', text.slice(0, 8000),
  ].join('\n');
  const sendSubject = `${v.type === 'bill' ? 'Bill' : 'Receipt'}: ${what} on ${day} (from ${firstName(ctx.ownerName, row.mailbox)}’s email)`.slice(0, 200);
  const tags = [{ name: 'kind', value: SENT_TAG }];
  const res = await ctx.fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [inbox], subject: sendSubject, text: body, attachments, tags }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 120)}`);
  // Resend's reports on it (delivered, or turned away and why) land in the email log, which Automations reads
  const sentId = (await res.json().catch(() => null))?.id;
  if (sentId) await logSent(env, [{ id: sentId, to: inbox, subject: sendSubject }], { tags, now: ctx.now });
  return { state: 'sent', detail: `sent ${what} to ${inbox}${attachments.length ? ` with ${attachments.length === 1 ? 'its file' : `${attachments.length} files`}` : ''}` };
}

async function handleFamily(env, ctx, row, msg) {
  const h = msg.payload?.headers;
  const accounts = JSON.parse(row.accounts || '[]').filter((id) => ctx.names.has(id));
  if (!accounts.length) return { state: 'skipped', detail: 'the family isn’t in JobTread any more' };
  const familyNames = accounts.map((id) => ctx.names.get(id)).join(' and ');
  const subject = header(h, 'Subject');
  // The conversation so far: its first email on each account (replies go under it), and the files already added
  const earlier = row.conv ? ((await env.DB.prepare("SELECT state, comment_ids, file_keys FROM mail_sweep WHERE conv = ? AND kind = 'family' AND state IN ('posted', 'would') ORDER BY at LIMIT 100").bind(row.conv).all()).results || []) : [];
  const json = (s, empty) => { try { return JSON.parse(s) || empty; } catch { return empty; } };
  const roots = Object.assign({}, ...earlier.filter((r) => r.state === 'posted' && r.comment_ids).map((r) => json(r.comment_ids, {})).reverse());
  const added = new Set(earlier.flatMap((r) => json(r.file_keys, [])));
  const keyOf = (f) => `${f.name}:${f.size}`;
  const files = filesWorth(msg.payload).filter((f) => !added.has(keyOf(f)));
  const fileKeys = files.map(keyOf);
  const sentAt = Number(msg.internalDate) || ctx.now;
  const message = [
    `Email, ${when(sentAt)} (from ${ctx.ownerName}’s inbox)`,
    `From: ${header(h, 'From')}`, `To: ${header(h, 'To')}`, ...(header(h, 'Cc') ? [`Cc: ${header(h, 'Cc')}`] : []),
    ...(subject ? [`Subject: ${subject}`] : []),
    '', withoutQuoted(textOf(msg.payload)) || '(no words, only files)',
    ...(files.length ? ['', `Files: ${files.map((f) => f.name).join(', ')}`] : []),
  ].join('\n').slice(0, 4096);
  if (ctx.watching) return { state: 'would', detail: `would add to ${familyNames}${files.length ? ` with ${files.length === 1 ? 'a file' : `${files.length} files`}` : ''}`, fileKeys };
  if (!env.JOBTREAD_GRANT_KEY) throw new Error('JOBTREAD_GRANT_KEY isn’t set');

  const bytes = [];
  for (const f of files) bytes.push({ name: f.name, type: f.type, bytes: await fileBytes(ctx.token, msg, f, ctx.fetchImpl) });
  const ids = {};
  for (const accountId of accounts) {
    const uploads = [];
    for (const b of bytes) uploads.push({ name: b.name, id: await uploadToJobTread(env, b, ctx.fetchImpl) });
    const parent = roots[accountId] || null;
    const id = await postAccountComment(env, {
      accountId, message, parentCommentId: parent,
      name: parent ? null : `Email: ${subject || '(no subject)'}`.slice(0, 128),
      uploadRequestIds: uploads, grant: env.JOBTREAD_GRANT_KEY,
    }, ctx.fetchImpl);
    if (!id) throw new Error('JobTread didn’t make the comment');
    ids[accountId] = parent || id;
  }
  return { state: 'posted', detail: `added to ${familyNames}${files.length ? ` with ${files.length === 1 ? 'a file' : `${files.length} files`}` : ''}`, commentIds: ids, fileKeys };
}

const finish = (DB, row, { state, detail = null, commentIds = null, fileKeys = null }, now) => DB.prepare('UPDATE mail_sweep SET state = ?, detail = ?, comment_ids = COALESCE(?, comment_ids), file_keys = ?, updated_at = ? WHERE mailbox = ? AND id = ?')
  .bind(state, detail ? String(detail).slice(0, 300) : null, commentIds ? JSON.stringify(commentIds) : null, fileKeys ? JSON.stringify(fileKeys) : null, new Date(now).toISOString(), row.mailbox, row.id).run();

async function handle(env, ctx, row) {
  // Claimed first, so two heartbeats can't both send it
  const iso = new Date(ctx.now).toISOString();
  const claim = await env.DB.prepare("UPDATE mail_sweep SET state = 'working', updated_at = ? WHERE mailbox = ? AND id = ? AND state = ?").bind(iso, row.mailbox, row.id, row.state).run();
  if (!claim.meta?.changes) return;
  try {
    const twin = row.msgid ? await env.DB.prepare("SELECT mailbox FROM mail_sweep WHERE msgid = ? AND kind = ? AND state IN ('sent', 'posted', 'would', 'working') AND NOT (mailbox = ? AND id = ?) LIMIT 1").bind(row.msgid, row.kind, row.mailbox, row.id).first() : null;
    if (twin) return await finish(env.DB, row, { state: 'duplicate', detail: `the same email as in ${twin.mailbox.split('@')[0]}’s inbox` }, ctx.now);
    const box = await ctx.open(row.mailbox);
    const msg = await gmail(box.token, `/messages/${row.id}?format=full`, ctx.fetchImpl);
    // Sorted again with today's rules and families, so a rule made better reaches what was already waiting
    const t = triage(msg, ctx.families);
    if (t?.kind !== row.kind) return await finish(env.DB, row, { state: 'skipped', detail: `not a ${row.kind === 'family' ? 'family email' : 'receipt'} after all` }, ctx.now);
    const c = { ...ctx, ...box };
    const out = row.kind === 'receipt' ? await handleReceipt(env, c, row, msg) : await handleFamily(env, c, { ...row, accounts: JSON.stringify(t.accounts) }, msg);
    await finish(env.DB, row, out, ctx.now);
  } catch (err) {
    console.error('[mail-sweep]', row.kind, err.message);
    await env.DB.prepare("UPDATE mail_sweep SET state = 'failed', tries = COALESCE(tries, 0) + 1, detail = ?, updated_at = ? WHERE mailbox = ? AND id = ?")
      .bind(String(err.message).slice(0, 300), iso, row.mailbox, row.id).run();
  }
}

// ─── Reading the inboxes ────────────────────────────────────────────

async function metadata(token, ids, fetchImpl) {
  const meta = LIST_HEADERS.map((x) => `&metadataHeaders=${x}`).join('');
  const out = [];
  for (let i = 0; i < ids.length; i += AT_ONCE) out.push(...(await Promise.all(ids.slice(i, i + AT_ONCE).map((id) => gmail(token, `/messages/${id}?format=metadata${meta}`, fetchImpl)))));
  return out;
}

async function queue(DB, mailbox, msg, t, source, now) {
  const h = msg.payload?.headers;
  await DB.prepare(`INSERT OR IGNORE INTO mail_sweep (mailbox, id, at, kind, state, msgid, conv, accounts, subject, source, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`)
    .bind(mailbox, msg.id, new Date(Number(msg.internalDate) || now).toISOString(), t.kind, header(h, 'Message-ID') || null, convOf(h),
      t.accounts ? JSON.stringify(t.accounts) : null, header(h, 'Subject').slice(0, 200), source, new Date(now).toISOString()).run();
}

/** New mail in one inbox since the last look → how many were queued */
async function scanBox(env, ctx, mailbox, bs) {
  const { token } = await ctx.open(mailbox);
  bs.cursor ||= ctx.startedAt;
  const q = bs.pageQ || `after:${Math.floor((bs.cursor - OVERLAP_MS) / 1000)}`;
  const list = await gmail(token, `/messages?maxResults=${PER_LIST}&q=${encodeURIComponent(q)}${bs.page ? `&pageToken=${bs.page}` : ''}`, ctx.fetchImpl);
  const seen = new Set(bs.recent || []);
  const ids = (list.messages || []).map((m) => m.id).filter((id) => !seen.has(id));
  const known = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(`SELECT id FROM mail_sweep WHERE mailbox = ? AND id IN (${part.map(() => '?').join(', ')})`).bind(mailbox, ...part).all()).results || [];
    for (const r of rows) known.add(r.id);
  }
  let queued = 0;
  let newest = bs.pageMax || bs.cursor;
  for (const msg of await metadata(token, ids.filter((id) => !known.has(id)), ctx.fetchImpl)) {
    newest = Math.max(newest, Number(msg.internalDate) || 0);
    const t = triage(msg, ctx.families);
    if (t) { await queue(env.DB, mailbox, msg, t, 'new', ctx.now); queued++; }
  }
  bs.recent = [...ids, ...(bs.recent || [])].slice(0, 300);
  // More than a page since the last look: the rest of the same search next time, then move on
  if (list.nextPageToken) Object.assign(bs, { pageQ: q, page: list.nextPageToken, pageMax: newest });
  else Object.assign(bs, { cursor: newest, pageQ: null, page: null, pageMax: null });
  return queued;
}

/** The family addresses not brought in yet, a search's worth → [address] */
function nextChunk(pending) {
  const out = [];
  let len = 0;
  for (const e of pending) {
    const add = `from:${e} OR to:${e} OR cc:${e} OR `.length;
    if (out.length && len + add > Q_MAX) break;
    out.push(e);
    len += add;
  }
  return out;
}

/** One step of bringing in the last year's family emails → false once it's all in */
async function backfillStep(env, ctx, st, boxes) {
  const bf = st.backfill ||= { done: [] };
  if (!bf.chunk) {
    const done = new Set(bf.done);
    const pending = [...ctx.families.byEmail.keys()].filter((e) => !done.has(e)).sort();
    if (!pending.length) return false;
    Object.assign(bf, { chunk: nextChunk(pending), box: 0, page: null, until: ctx.now });
  }
  const mailbox = boxes[bf.box];
  if (mailbox && !st.boxes?.[mailbox]?.noMail) {
    const { token } = await ctx.open(mailbox);
    const q = `(${bf.chunk.map((e) => `from:${e} OR to:${e} OR cc:${e}`).join(' OR ')}) after:${Math.floor((bf.until - BACKFILL_DAYS * 86400e3) / 1000)} before:${Math.floor(bf.until / 1000)}`;
    const list = await gmail(token, `/messages?maxResults=${PER_LIST}&q=${encodeURIComponent(q)}${bf.page ? `&pageToken=${bf.page}` : ''}`, ctx.fetchImpl);
    for (const msg of await metadata(token, (list.messages || []).map((m) => m.id), ctx.fetchImpl)) {
      const t = triage(msg, ctx.families);
      if (t?.kind === 'family') await queue(env.DB, mailbox, msg, t, 'backfill', ctx.now);
    }
    if (list.nextPageToken) { bf.page = list.nextPageToken; return true; }
  }
  bf.page = null;
  bf.box++;
  if (bf.box >= boxes.length) { bf.done = [...new Set([...bf.done, ...bf.chunk])]; bf.chunk = null; }
  return true;
}

// ─── The heartbeat part ─────────────────────────────────────────────

const noMailbox = (err) => /Mail service not enabled|failedPrecondition/i.test(err.message);

async function sweep(env, st, { fetchImpl, now }) {
  const started = Date.now();
  const left = () => Date.now() - started < READ_MS;
  st.startedAt ||= now;
  st.watchUntil ||= now + WATCH_MS;
  const watching = now < st.watchUntil;
  // The first day's watch is over: what it would have done is done now
  if (!watching && !st.released) {
    await env.DB.prepare("UPDATE mail_sweep SET state = 'queued', detail = NULL WHERE state = 'would'").run();
    st.released = now;
  }
  const people = new Map((await mailboxes(env)).map((b) => [b.email, b.name]));
  const boxes = [...people.keys()];
  if (!boxes.length) throw new Error('Google’s staff accounts haven’t been read yet (Staff sign-in follows Google)');
  const families = await familyAddresses(env.DB);
  const cfg = await readConfig(env.DB).catch(() => ({}));
  const tokens = new Map();
  const ctx = {
    now, fetchImpl, watching, families, names: families.names, startedAt: st.startedAt,
    receiptInbox: normEmail(cfg.receiptInbox || DEFAULT_RECEIPT_INBOX),
    open: async (mailbox) => {
      if (!tokens.has(mailbox)) tokens.set(mailbox, await accessToken(env, mailbox, { fetchImpl, now, scope: GMAIL_READ_SCOPE }));
      return { token: tokens.get(mailbox), ownerName: people.get(mailbox) || mailbox.split('@')[0] };
    },
  };

  const errors = [];
  st.boxes ||= {};
  for (const mailbox of boxes) {
    const bs = st.boxes[mailbox] ||= {};
    if (bs.noMail && now - bs.noMail < 86400e3) continue;
    if (!left()) break;
    try { await scanBox(env, ctx, mailbox, bs); bs.noMail = null; bs.error = null; } catch (err) {
      if (noMailbox(err)) bs.noMail = now;
      else { bs.error = err.message; errors.push(`${mailbox.split('@')[0]}: ${err.message}`); }
    }
  }
  let backfilling = true;
  while (left() && backfilling) {
    try { backfilling = await backfillStep(env, ctx, st, boxes); } catch (err) {
      if (noMailbox(err)) { st.boxes[boxes[st.backfill.box]] = { ...st.boxes[boxes[st.backfill.box]], noMail: now }; continue; }
      errors.push(`bringing in family emails: ${err.message}`);
      break;
    }
  }
  const backfillDone = !st.backfill?.chunk && [...families.byEmail.keys()].every((e) => (st.backfill?.done || []).includes(e));

  // Oldest first; family emails wait until the last year's are all in, so each family's reads in order
  const retryBefore = new Date(now - RETRY_MS).toISOString();
  // One a heartbeat dropped halfway: tried again like a failure
  await env.DB.prepare("UPDATE mail_sweep SET state = 'failed', tries = COALESCE(tries, 0) + 1 WHERE state = 'working' AND updated_at < ?").bind(retryBefore).run();
  while (Date.now() - started < HANDLE_MS) {
    const row = await env.DB.prepare(`SELECT * FROM mail_sweep WHERE (state = 'queued' OR (state = 'failed' AND tries < ? AND updated_at < ?))
        ${backfillDone ? '' : "AND kind = 'receipt'"} ORDER BY at LIMIT 1`).bind(MAX_TRIES, retryBefore).first();
    if (!row) break;
    await handle(env, ctx, row);
  }
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sweep WHERE state = 'queued'").first();
  Object.assign(st, { busy: Boolean(waiting?.n) || !backfillDone, backfillDone, lastSweptAt: now, error: errors.length ? errors.join(' · ').slice(0, 500) : null, runningUntil: 0 });
  return st;
}

/** On the live hub's heartbeat: every 3 minutes, every minute while there's a backlog. Never throws */
export async function maybeSweepMail(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!env?.DB || !env.GOOGLE_CALENDAR_KEY) return null;
  let st = {};
  try {
    await ensure(env.DB);
    st = await readState(env.DB);
    if (!force && now - (st.lastRunAt || 0) < (st.busy ? BUSY_MS : EVERY_MS)) return null;
    if (!force && (st.runningUntil || 0) > now) return null;
    Object.assign(st, { lastRunAt: now, runningUntil: now + 45000 });
    await writeState(env.DB, st);
    st = await sweep(env, st, { fetchImpl, now });
    await writeState(env.DB, st);
    return st;
  } catch (err) {
    console.error('[mail-sweep]', err.message);
    await writeState(env.DB, { ...st, error: err.message, runningUntil: 0 }).catch(() => {});
    return null;
  }
}

/** For Site → Automations: on/off, the watch, the backlog and the last week's counts; family and vendor names only */
export async function mailSweepStatus(env) {
  if (!env.DB) return null;
  await ensure(env.DB);
  const st = await readState(env.DB);
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const rows = (await env.DB.prepare('SELECT kind, state, COUNT(*) AS n FROM mail_sweep WHERE updated_at >= ? GROUP BY kind, state').bind(since).all()).results || [];
  const counts = { receipt: {}, family: {} };
  for (const r of rows) counts[r.kind] = { ...counts[r.kind], [r.state]: r.n };
  const recent = ((await env.DB.prepare("SELECT kind, state, detail, mailbox, updated_at FROM mail_sweep WHERE state IN ('sent', 'posted', 'would', 'failed') ORDER BY updated_at DESC LIMIT 12").all()).results || [])
    .map((r) => ({ kind: r.kind, state: r.state, detail: r.detail, inbox: String(r.mailbox).split('@')[0], at: r.updated_at }));
  const queued = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sweep WHERE state = 'queued'").first();
  // Did the receipt inbox take the last one? (Resend's report, through the email log)
  let lastSent = null;
  try {
    const r = await env.DB.prepare('SELECT to_addr, status, status_at, detail FROM email_log WHERE type = ? ORDER BY sent_at DESC LIMIT 1').bind(SENT_TAG).first();
    if (r) lastSent = { to: r.to_addr, status: r.status, at: r.status_at, detail: r.detail || null };
  } catch { /* nothing sent yet */ }
  return {
    lastSent,
    key: Boolean(env.GOOGLE_CALENDAR_KEY), ai: Boolean(env.AI?.run), email: emailConfigured(env), jobtread: Boolean(env.JOBTREAD_GRANT_KEY),
    ...Object.fromEntries(['startedAt', 'watchUntil', 'lastSweptAt'].map((k) => [k, st[k] ? new Date(st[k]).toISOString() : null])), error: st.error || null,
    inboxes: Object.values(st.boxes || {}).filter((b) => !b.noMail).length, backfillDone: Boolean(st.backfillDone), queued: queued?.n || 0, counts, recent,
  };
}
