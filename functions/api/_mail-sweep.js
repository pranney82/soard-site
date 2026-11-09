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
 *     delivery notices, ads, carts, refunds, statements and gifts to SOARD
 *     stay out (a receipt in a SOARD inbox is SOARD's: Peter, Nov 8 2026, "there
 *     are no personal expenses in the business domains"). So do emails the receipt inbox already has
 *     (on the email, or anywhere in its conversation), mail between staff and
 *     the money tools' own notices.
 *   - An email to or from a family (an address on an applicant's JobTread
 *     account) → a comment on that account that the family can't see and
 *     nobody is assigned to, so JobTread emails no one: who wrote to whom and
 *     when, the words without the quoted history, and the files. Replies go
 *     under the first email of their conversation. The last year's family
 *     emails are brought in once an application is approved, oldest first,
 *     before any newer ones.
 *
 * Only email about a real kid or community project goes on an account
 * (Peter, Nov 4 2026, after a staff try of the form with personal Gmail
 * brought staff's own mail onto it). Every layer has to pass:
 *   1. Who: never an account where staff is the customer contact (their
 *      Google name or address), a TEST account, staff's own addresses (by
 *      address, or by their name on an email), or an outside mass email.
 *   2. What: Workers AI reads each email and it goes on only when it's about
 *      that kid or project (a reply in a conversation already there is). No
 *      answer, nothing posted: it's tried again later.
 *   3. When: the last year's email comes in only once the application is
 *      approved; before that, only new email.
 *   4. Brake: a new account (under 3 days) with more than 10 emails at once
 *      holds them until it's 3 days old, and Slack says so once.
 *   5. Undo: every comment it makes is recorded (posted_ids).
 *
 * Each email is handled once, even when it's in several inboxes (Message-ID).
 * Receipts start from the day this was turned on: older ones were forwarded by
 * hand and their bills exist. For its first day it only watches: what it would
 * have done shows in Automations, and is then done.
 */

import { isStaffEmail, normEmail } from './_board-roles.js';
import { accessToken, GMAIL_READ_SCOPE, GMAIL_MODIFY_SCOPE } from './_google-calendar.js';
import { mailboxes, orgDomains, gmail, header, textOf, htmlText, filesOf, partsOf, bytesOf } from './_mailbox.js';
import { pave, SOARD_ORG_ID } from './_reveals.js';
import { postAccountComment } from './_applicant-comms.js';
import { EMAIL_FROM, emailConfigured, slackIssue, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { logSent } from './_email-log.js';
import { readConfig } from './_spend.js';
import { DEFAULT_RECEIPT_INBOX, attachToCharge } from './_spend-receipts.js';
import { rampCardCharges, rampUserEmails, rampAttach, rampConfigured } from './_ramp.js';
import { vendorLikeness } from './_spend-match.js';
import { FREE_MAIL } from './_kid-partners.js';
import { viaGateway, aiCapped, AI_REST_MS, AI_WAIT_NOTE } from './_ai.js';

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
const LIST_HEADERS = ['From', 'To', 'Cc', 'Delivered-To', 'Reply-To', 'X-Original-From', 'X-Original-Sender', 'Subject', 'Message-ID', 'References', 'In-Reply-To', 'Auto-Submitted', 'List-Id', 'List-Unsubscribe', 'Precedence'];
const SENT_TAG = 'receipt-from-inbox';

// The money tools' and JobTread's own mail: already where it belongs
const OWN_TOOLS = /@([\w-]+\.)*(ramp\.com|mercury\.com|jobtread\.com|zeffy\.com|intuit\.com|quickbooks\.com|plaid\.com|companycam\.com)$/i;
const RECEIPTISH = /\b(receipts?|invoices?|bills?|order (confirmation|confirmed|received|placed|summary|details|#|no\.?|number)|your ([\w.-]+ )?(order|purchase|payment)|payment (received|confirmation|confirmed|successful|processed)|purchase (confirmation|confirmed)|thanks? (you )?for (your )?([\w-]+ )?(order|purchase|payment|shopping)|(we('ve| have)|has been) received|charged|paid)\b/i;
const NOT_RECEIPT = /\b(shipped|ships|on (its|the) way|out for delivery|delivered|arriving|arrives|has arrived|track(ing)?\b|in your (cart|bag)|cart misses|left (something|in)|wish ?list|\d+% off|sale\b|deals?\b|coupons?|price drop|back in stock|review (your|us)|rate (your|us)|survey|refund(ed)?|returns?\b|statement)\b/i;
const CALENDAR = /^(accepted|declined|tentatively accepted|tentative|invitation|updated invitation|cancell?ed (event|invitation)|new event|proposed new time)\b/i;
// A reply on an invite's thread (a reveal's): every guest is on it, so only the family's and staff's own count
const AUTO_REPLY = /^\W*(out of (the )?office|automatic reply|auto(matic)?[- ]?(reply|response)|autoreply|away from)/i;
// A contact who's family (JobTread's title): "Mom", "Stepfather", "Secondary parent", "Dylan grandparent"
const FAMILY_TITLE = /(^|\W)(mom|moth|mama|dad|fath|papa|parent|guardian|grand|aunt|uncle|step|caregiver|foster|sister|brother|husband|wife|spouse|family)/i;
// More people than this on an email from someone outside SOARD and the family is a mass email
const CROWD = 10;
// A new account getting more emails than this at once waits until it's this old (a test, most likely)
const BRAKE_COUNT = 10;
const BRAKE_AGE_MS = 3 * 86400e3;
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
  // Each SOARD card charge of the last week and its receipt: 'looking' in the cardholder's email, 'attached' by the
  // sweep, 'had' one already (put on by hand), 'none' found in a week, 'no_inbox' (a cardholder with no SOARD inbox)
  `CREATE TABLE IF NOT EXISTS card_receipts (
    charge TEXT PRIMARY KEY, card TEXT NOT NULL, mailbox TEXT, user_id TEXT, cents INTEGER NOT NULL, vendor TEXT, charged_at TEXT NOT NULL,
    state TEXT NOT NULL, looks INTEGER DEFAULT 0, next_look TEXT, hints TEXT, msg_id TEXT, detail TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_card_receipts_look ON card_receipts(state, next_look)',
  'CREATE INDEX IF NOT EXISTS idx_card_receipts_box ON card_receipts(mailbox, charged_at)',
];
const _ready = new WeakSet();
// Added after the first deploy: the files a family email brought (name:size), so a reply carrying them again doesn't add them twice
// and every comment it made, root or reply, by account (Nov 4 2026), so a mistake can be found and removed
// charge_id: the SOARD card charge a receipt was matched to, so one charge sends one receipt
// archived: 'no' while a receipt put on its card charge waits to leave the inbox, 'yes' once it has
const COLUMNS = ['file_keys TEXT', 'posted_ids TEXT', 'charge_id TEXT', 'archived TEXT'];
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

// SOARD's own people and groups: an address on any of SOARD's Google domains (set from Google's accounts each sweep)
let ORG_DOMAINS = new Set(['soardcharity.com']);
const isOurs = (e) => isStaffEmail(e) || ORG_DOMAINS.has(normEmail(e).split('@')[1]);
const addresses = (s) => (String(s || '').match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[a-z]{2,}/gi) || []).map(normEmail);
// The people on a header with the names they go by: "Peter Ranney" <x@gmail.com> → [{ name, email }]
const named = (s) => [...String(s || '').matchAll(/(?:"([^"]*)"|([^,<>"]*?))\s*<([^<>\s]+@[^<>\s]+)>/g)].map((m) => ({ name: (m[1] ?? m[2] ?? '').trim(), email: normEmail(m[3]) }));
// A person's name to compare by: first and last word ("Holly K. Ranney" → "holly ranney")
const nameKey = (name) => { const w = String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean); return w.length > 1 ? `${w[0]} ${w[w.length - 1]}` : ''; };
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
 *
 * Staff's own mail never goes on an account. `staff` is the Google accounts'
 * names: a contact with a staff member's name is staff, whatever address they
 * gave (a personal Gmail on a try of the form). An application with staff as
 * the family (the main contact, or a Mom or Dad) is staff's own, so nothing on
 * it counts, and staff's addresses count on no account at all.
 *
 * Also → approved (account ids whose application is approved), backfill (the
 * addresses whose last year comes in: one account's, and that one approved),
 * created (account id → ms), kinds (account id → 'kid' | 'project': a child
 * has a birthday, diagnosis or family on it; an organization has none) and
 * staffNames, for triage.
 */
export async function familyAddresses(DB, { staff = [] } = {}) {
  const byEmail = new Map();
  const names = new Map();
  const staffNames = new Set(staff.map(nameKey).filter(Boolean));
  const out = { byEmail, names, staffNames, approved: new Set(), backfill: new Set(), created: new Map(), kinds: new Map() };
  const isStaff = (c) => staffNames.has(nameKey(c.name)) || addresses(c.email).some(isOurs);
  const staffOwn = new Set();
  let rows = [];
  try { rows = (await DB.prepare('SELECT account_id, name, status, fields, created_at, contact_name, contact_email, contacts FROM applicants').all()).results || []; } catch { return out; }
  for (const r of rows) {
    // A staff test run's account carries a staff member's own address
    if (/\btest\b/i.test(r.name || '')) continue;
    let contacts = [];
    try { contacts = (JSON.parse(r.contacts || '[]') || []).filter((c) => c && typeof c === 'object'); } catch { /* none */ }
    if (staffNames.has(nameKey(r.contact_name)) || contacts.some((c) => isStaff(c) && FAMILY_TITLE.test(c.title || ''))) {
      for (const e of [...contacts.flatMap((c) => addresses(c.email)), ...addresses(r.contact_email)]) staffOwn.add(e);
      continue;
    }
    for (const c of contacts) if (isStaff(c)) for (const e of addresses(c.email)) staffOwn.add(e);
    names.set(r.account_id, r.name);
    if (r.status === 'Approved') out.approved.add(r.account_id);
    const at = Date.parse(r.created_at || '');
    if (at) out.created.set(r.account_id, at);
    const isFamily = contacts.some((c) => FAMILY_TITLE.test(c.title || ''));
    let fields = {};
    try { fields = JSON.parse(r.fields || '{}') || {}; } catch { /* none */ }
    out.kinds.set(r.account_id, isFamily || String(fields.birthday || '').trim() || String(fields.diagnosis || '').trim() ? 'kid' : 'project');
    const counts = (c) => !isFamily || FAMILY_TITLE.test(c.title || '') || (!String(c.title || '').trim() && addresses(c.email).every((e) => FREE_MAIL.has(e.split('@')[1])));
    const theirs = contacts.flatMap((c) => addresses(c.email).map((e) => [e, counts(c)]));
    const left = new Set(theirs.filter(([, ok]) => !ok).map(([e]) => e));
    const kept = [...theirs.filter(([, ok]) => ok).map(([e]) => e), ...addresses(r.contact_email).filter((e) => !left.has(e))];
    for (const e of new Set(kept)) {
      if (isOurs(e) || OWN_TOOLS.test(e)) continue;
      byEmail.set(e, [...new Set([...(byEmail.get(e) || []), r.account_id])]);
    }
  }
  for (const e of staffOwn) byEmail.delete(e);
  for (const [e, ids] of byEmail) if (ids.length === 1 && out.approved.has(ids[0])) out.backfill.add(e);
  return out;
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
/**
 * Who really sent an email. A SOARD Google group (orders@, info@) passes a store's email on as
 * "'Amazon.com' via orders" <orders@soardcharity.com>, with the store in X-Original-From (or X-Original-Sender,
 * or Reply-To) → that From line ('Amazon.com <shipment-tracking@amazon.com>'), else the email's own
 */
export function senderOf(h) {
  const from = header(h, 'From');
  if (!/\bvia\b/i.test(from.replace(/<.*>/, '')) || !addresses(from).every(isOurs)) return from;
  const original = header(h, 'X-Original-From') || header(h, 'X-Original-Sender') || header(h, 'Reply-To');
  return addresses(original).length ? original : from;
}

export function triage(msg, { byEmail, staffNames = new Set() }) {
  const h = msg.payload?.headers;
  const subject = header(h, 'Subject');
  // A staff member's own address by the name on it ("Peter Ranney <…@gmail.com>"): never a family's, on any account
  const theirOwn = new Set(['From', 'To', 'Cc', 'Reply-To'].flatMap((k) => named(header(h, k)))
    .filter((p) => !isOurs(p.email) && staffNames.has(nameKey(p.name))).map((p) => p.email));
  const fromAll = addresses(header(h, 'From'));
  const from = fromAll.filter((e) => !theirOwn.has(e));
  const people = [...new Set([...fromAll, ...addresses(header(h, 'To')), ...addresses(header(h, 'Cc')), ...addresses(header(h, 'Reply-To'))])].filter((e) => !theirOwn.has(e));
  if (CALENDAR.test(subject.trim()) || AUTO_REPLY.test(subject) || /auto-replied/i.test(header(h, 'Auto-Submitted'))) return null;
  const tools = people.some((e) => OWN_TOOLS.test(e));
  const guestChatter = INVITE_REPLY.test(subject.trim()) && !from.every(isOurs) && !accountsOf(from, byEmail).length;
  // A mailing list's email (a family's business newsletter); SOARD's own groups (info@) mark theirs too, and those count
  const list = `${header(h, 'List-Id')} ${header(h, 'List-Unsubscribe')}`;
  const mailing = (list.trim() || /bulk|list|junk/i.test(header(h, 'Precedence'))) && !/soardcharity\.com/i.test(list);
  // A mass email from outside (a photographer's promo to 80 people, a family among them) isn't about the family's kid or project
  const crowd = people.length > CROWD && !from.some(isOurs) && !accountsOf(from, byEmail).length;
  const accounts = tools || guestChatter || mailing || crowd ? [] : accountsOf(people, byEmail);
  if (accounts.length && accounts.length <= 3) return { kind: 'family', accounts };
  // Receipts go by who really sent it: one forwarded from a staff member's own Gmail is still a receipt, and so is a store's through a SOARD group
  const sender = addresses(senderOf(h));
  if (!sender.length || sender.every(isOurs) || sender.some((e) => OWN_TOOLS.test(e))) return null;
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
{"type": "receipt" | "bill" | "not_receipt", "vendor": "<the seller>", "total": "<the amount charged or owed, as written, or empty>", "date": "<YYYY-MM-DD or empty>", "reason": "<under 15 words>"}

- receipt: proof a purchase was made: a receipt, an order confirmation (even when the email doesn't show the amount; many stores leave it out), a paid invoice, a payment confirmation.
- bill: an invoice from a vendor or contractor asking SOARD to pay for goods or work.
- not_receipt: shipping, delivery or tracking notices; ads, sales, carts, wish lists; surveys and requests for a review or feedback, even when they thank you for a purchase; free samples; quotes and estimates; refunds and returns; account statements, "your bill is ready" notices and anything paid automatically (insurance, loans, credit cards); anything from a utility (electric, gas, water, phone, internet), whether a bill, a balance, low-balance or disconnect notice, or a payment confirmation; donation receipts or gift notices for money given TO SOARD; newsletters; anything else.`;
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['receipt', 'bill', 'not_receipt'] }, vendor: { type: 'string' }, total: { type: 'string' },
    date: { type: 'string' }, reason: { type: 'string' },
  },
  required: ['type'],
};

function readVerdict(out) {
  let j = out?.response ?? out;
  if (typeof j === 'string') { try { j = JSON.parse(j.slice(j.indexOf('{'), j.lastIndexOf('}') + 1)); } catch { return null; } }
  if (!j || !['receipt', 'bill', 'not_receipt'].includes(j.type)) return null;
  return {
    type: j.type, vendor: String(j.vendor || '').slice(0, 80), total: String(j.total || '').slice(0, 30),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || '')) ? j.date : '', reason: String(j.reason || '').slice(0, 120),
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

/**
 * Workers AI's verdict on one email → { type, vendor, total, date, reason, by }. It throws when the model
 * didn't answer, so the email is tried again, and goes by the rules only on its last try: they pass over any receipt
 * that doesn't say so in its subject, and that's for good. A cap reached always throws (the sweep waits, no try spent).
 */
export async function judgeReceipt(env, { subject, from, owner, text, files, lastTry = true }) {
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
        }, viaGateway('mail-sweep')),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), AI_TIMEOUT_MS); }),
      ]);
      const v = readVerdict(out);
      if (v) return { ...v, by: 'ai' };
    } catch (err) {
      if (aiCapped(err)) throw err;
      console.error('[mail-sweep] judging', err.message);
    } finally {
      clearTimeout(timer);
    }
    if (!lastTry) throw new Error('Workers AI didn’t answer about this receipt');
  }
  // No model: only a plain receipt or invoice with an amount in it
  const amount = String(text).match(/\$\s?\d[\d,]*(\.\d{2})?/)?.[0] || '';
  const sure = /\b(receipt|order confirmation|payment (received|confirmation)|invoice)\b/i.test(subject) && amount;
  return { type: sure ? (/invoice/i.test(subject) ? 'bill' : 'receipt') : 'not_receipt', vendor: from.replace(/<.*>/, '').replace(/"/g, '').trim().slice(0, 80), total: amount, date: '', reason: sure ? 'a receipt by its subject' : 'not clearly a receipt', by: 'rules' };
}

// ─── Is it about the kid or the project? ────────────────────────────

const FAMILY_PROMPT = `You sort email for Sunshine on a Ranney Day (SOARD), a children's charity that makes over bedrooms, bathrooms and therapy spaces for children with special needs. It also does community projects: spaces it makes over for organizations (schools, clinics, therapy centers) that serve those children.

An email from a staff member's inbox matched the record of a child SOARD is helping, or of a community project, because someone on the email is on that record. Decide whether the email belongs on that record. Reply with JSON only:
{"about": true | false, "reason": "<under 15 words>"}

true: it's about SOARD's work with this child's family or this project. For example the application, the child and their needs, the room or space, design, measurements, products, schedule, site visits, permits, contractors and vendors, demo day, the reveal, photos and video, the child's story and the website, donations and fundraising for them, SOARD's events they're part of or asking about (the gala, fundraisers), partners who referred or support this child or project (Make-A-Wish, a caseworker, a therapist) writing about them, thank-yous, check-ins and follow-ups, and replies in those conversations.
false: newsletters, promotions, sales and ads; an email sent to a crowd; a business's, school's or church's announcements; a staff member's own life (their own children and their school, their home, mortgage, bills, loans, cars, travel, tickets, shopping, family news); anything about a different child, family or project; anything else not about SOARD's work with them.
Plainly personal, plainly promotional or sent to a crowd: false. Otherwise, when it's a real exchange with this family or project's people and you're unsure, true.`;
const FAMILY_SCHEMA = { type: 'object', properties: { about: { type: 'boolean' }, reason: { type: 'string' } }, required: ['about', 'reason'] };

function readFamilyVerdict(out) {
  let j = out?.response ?? out;
  if (typeof j === 'string') { try { j = JSON.parse(j.slice(j.indexOf('{'), j.lastIndexOf('}') + 1)); } catch { return null; } }
  if (!j || typeof j.about !== 'boolean') return null;
  return { about: j.about, reason: String(j.reason || '').slice(0, 120) };
}

/**
 * Workers AI on whether one email is about the kid or project it matched →
 * { about, reason }. It never guesses without the model: no answer throws, so
 * the email waits and is tried again rather than going on unread.
 */
export async function judgeFamily(env, { records, owner, from, to, subject, text, files = [] }) {
  if (!env.AI?.run) throw new Error('Workers AI isn’t connected, so it can’t check the email is about the family');
  const input = [
    ...records.map((r) => `Record: ${r.name} (${r.kind === 'project' ? 'a community project' : 'a child SOARD is helping, and their family'})`),
    `Inbox of: ${owner}`, `From: ${from}`, `To: ${String(to).slice(0, 600)}`, `Subject: ${subject}`,
    `Files: ${files.map((f) => f.name).join(', ') || 'none'}`, `Email:\n${String(text).slice(0, 3500)}`,
  ].join('\n');
  let timer;
  try {
    const out = await Promise.race([
      env.AI.run(AI_MODEL, {
        messages: [{ role: 'system', content: FAMILY_PROMPT }, { role: 'user', content: input }],
        max_tokens: 120, temperature: 0, response_format: { type: 'json_schema', json_schema: FAMILY_SCHEMA },
      }, viaGateway('mail-sweep')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workers AI took too long')), AI_TIMEOUT_MS); }),
    ]);
    const v = readFamilyVerdict(out);
    if (!v) throw new Error('Workers AI didn’t say whether it’s about the family');
    return v;
  } finally {
    clearTimeout(timer);
  }
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

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const RECEIPT_FILE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|heic|heif))$/i;

/** An email as a page to print: who sent it and when, then the email as the store wrote it */
function emailPage({ from, subject, sentAt, owner, mailbox, payload, text }) {
  const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = partsOf(payload).find((p) => p.mimeType === 'text/html' && !p.filename && p.body?.data);
  const body = html ? new TextDecoder().decode(bytesOf(html.body.data)) : `<pre style="white-space:pre-wrap;font:13px/1.5 sans-serif">${esc(text)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font:12px/1.5 sans-serif;color:#333;border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:16px">From: ${esc(from)}<br>Date: ${esc(when(sentAt))}<br>Subject: ${esc(subject)}<br>From ${esc(owner)}’s email (${esc(mailbox)})</div>${body}</body></html>`;
}

/** The receipt's files for a card charge: the email's own PDFs and pictures, else the email itself, printed → [{ bytes, type, name }] */
async function receiptUploads(env, ctx, row, msg, { v, files, from, subject, sentAt, text }) {
  const uploads = [];
  for (const f of files.filter((x) => RECEIPT_FILE.test(x.type)).slice(0, 3)) uploads.push({ bytes: await fileBytes(ctx.token, msg, f, ctx.fetchImpl), type: f.type, name: f.name });
  if (!uploads.length) {
    const day = new Date(sentAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const page = emailPage({ from, subject, sentAt, owner: ctx.ownerName, mailbox: row.mailbox, payload: msg.payload, text });
    uploads.push({ bytes: await ctx.print(env, page), type: 'application/pdf', name: `${String(v.vendor || 'Store').replace(/[^\w .,&'-]+/g, ' ').trim().slice(0, 60)} receipt ${day}.pdf` });
  }
  return uploads;
}

const MIN_MS = 60e3;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const CARD_DAYS = 4; // a card charge is dated when it's made; the store's email can come days later (a preorder, a slow invoice)

/** The dollar amounts an email names, in cents: "$1,299.00", "USD 10.00", "29.00 USD" */
export function amountsIn(...texts) {
  const out = new Set();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/(?:\$|\bUSD)\s?(\d[\d,]*(?:\.\d{2})?)|\b(\d[\d,]*\.\d{2})\s?USD\b/gi)) {
      const cents = Math.round(Number((m[1] || m[2]).replace(/,/g, '')) * 100);
      if (cents > 0) out.add(cents);
    }
  }
  return [...out].slice(0, 40);
}

/**
 * The SOARD card charge a receipt is for, among the card charges the sweep follows (card_receipts: Mercury's and
 * Ramp's of the last week): the inbox owner's own card, one of the email's amounts, within a few days →
 * { charge, card, cents, vendor, state } | null
 */
async function cardCharge(DB, { mailbox, at, amounts }) {
  if (!amounts.length) return null;
  const iso = (ms) => new Date(ms).toISOString();
  return DB.prepare(`SELECT charge, card, cents, vendor, state FROM card_receipts WHERE mailbox = ? AND cents IN (${amounts.map(() => '?').join(', ')})
      AND charged_at BETWEEN ? AND ? ORDER BY abs(julianday(charged_at) - julianday(?)) LIMIT 1`)
    .bind(normEmail(mailbox), ...amounts, iso(at - CARD_DAYS * DAY_MS), iso(at + CARD_DAYS * DAY_MS), iso(at)).first();
}

async function handleReceipt(env, ctx, row, msg) {
  const h = msg.payload?.headers;
  const inbox = ctx.receiptInbox;
  const subject = header(h, 'Subject');
  const from = senderOf(h);
  if ([...addresses(from), ...addresses(header(h, 'To')), ...addresses(header(h, 'Cc'))].includes(inbox)) return { state: 'skipped', detail: 'already at the receipt inbox' };
  const meta = ['From', 'To', 'Cc'].map((x) => `&metadataHeaders=${x}`).join('');
  const thread = await gmail(ctx.token, `/threads/${msg.threadId}?format=metadata${meta}`, ctx.fetchImpl);
  if ((thread.messages || []).some((m) => [...addresses(header(m.payload?.headers, 'To')), ...addresses(header(m.payload?.headers, 'Cc'))].includes(inbox))) {
    return { state: 'skipped', detail: 'its conversation already went to the receipt inbox' };
  }
  const text = receiptText(msg.payload);
  const files = filesWorth(msg.payload);
  const v = await judgeReceipt(env, { subject, from, owner: ctx.ownerName, text, files, lastTry: (row.tries || 0) + 1 >= MAX_TRIES });
  if (v.type === 'not_receipt') return { state: 'skipped', detail: `not a receipt: ${v.reason || 'the model said so'}` };
  const sentAt = Number(msg.internalDate) || ctx.now;
  const charge = await cardCharge(env.DB, { mailbox: row.mailbox, at: sentAt, amounts: amountsIn(v.total, text) });
  const chargeKey = charge?.charge || null;
  const looking = charge?.state === 'looking';
  const what = `${v.vendor || 'a vendor'}${v.total ? ` ${v.total}` : ''}`;
  // A SOARD card charge's receipt: the charge puts it on itself (lookForCardReceipts), looking at this email first, now
  if (looking) await env.DB.prepare("UPDATE card_receipts SET hints = json_insert(COALESCE(hints, '[]'), '$[#]', ?), next_look = ? WHERE charge = ?").bind(`${row.mailbox}:${row.id}`, new Date(ctx.now).toISOString(), chargeKey).run();
  // Mercury sends a makeover's receipt on to the receipt inbox itself
  if (charge?.card === 'mercury') return { state: 'card', detail: `${what}: ${looking ? 'for' : 'already on'} ${chargeWords(charge)}`, chargeId: chargeKey, onCard: !looking };
  // Ramp sends nothing on, so a Ramp charge's receipt still goes to the receipt inbox: once a charge
  const first = chargeKey ? await env.DB.prepare("SELECT subject FROM mail_sweep WHERE charge_id = ? AND state IN ('sent', 'would', 'working') AND NOT (mailbox = ? AND id = ?) LIMIT 1").bind(chargeKey, row.mailbox, row.id).first() : null;
  if (first) return { state: 'duplicate', detail: `the same card charge as “${first.subject}”, already sent`, chargeId: chargeKey, onCard: Boolean(charge) && !looking };
  if (ctx.watching) return { state: 'would', detail: `would send ${what} to ${inbox}`, chargeId: chargeKey };
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
  const day = v.date || new Date(sentAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const body = [
    `A ${v.type === 'bill' ? 'bill' : 'receipt'} found in ${ctx.ownerName}’s email (${row.mailbox}).`,
    `Vendor: ${v.vendor || 'not named'}`, `Amount: ${v.total || 'not found'}`, `Date: ${day}`,
    `Original email from ${from}, ${when(sentAt)}: “${subject}”`,
    ...(charge ? [`Card charge: ${charge.vendor || 'a vendor'} $${(charge.cents / 100).toFixed(2)} on ${firstName(ctx.ownerName, row.mailbox)}’s ${charge.card === 'ramp' ? 'Ramp' : 'Mercury'} card`] : []),
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
  return { state: 'sent', detail: `sent ${what} to ${inbox}${attachments.length ? ` with ${attachments.length === 1 ? 'its file' : `${attachments.length} files`}` : ''}${charge ? `, for ${chargeWords(charge)}` : ''}`, chargeId: chargeKey, onCard: Boolean(charge) && !looking };
}

async function handleFamily(env, ctx, row, msg) {
  const h = msg.payload?.headers;
  const accounts = JSON.parse(row.accounts || '[]').filter((id) => ctx.names.has(id));
  if (!accounts.length) return { state: 'skipped', detail: 'the family isn’t in JobTread any more' };
  const familyNames = accounts.map((id) => ctx.names.get(id)).join(' and ');
  // The brake: a new account with a pile of email at once (a test, most likely) waits until it's old enough
  for (const id of accounts) {
    const born = ctx.families.created.get(id);
    if (!born || ctx.now - born >= BRAKE_AGE_MS) continue;
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sweep WHERE kind = 'family' AND accounts LIKE ? AND state NOT IN ('skipped', 'duplicate')").bind(`%"${id}"%`).first())?.n || 0;
    if (n > BRAKE_COUNT) {
      await tellHeld(env, ctx, id, n, born);
      return { state: 'held', detail: `waiting until ${ctx.names.get(id)} is ${BRAKE_AGE_MS / 86400e3} days old: a new account with ${n} emails at once` };
    }
  }
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
  // Each email must be about the kid or project; a reply in a conversation already on the account is
  if (accounts.some((id) => !roots[id])) {
    const v = await judgeFamily(env, {
      records: accounts.map((id) => ({ name: ctx.names.get(id), kind: ctx.families.kinds.get(id) })),
      owner: ctx.ownerName, from: header(h, 'From'), to: [header(h, 'To'), header(h, 'Cc')].filter(Boolean).join(', '),
      subject, text: textOf(msg.payload), files,
    });
    if (!v.about) return { state: 'skipped', detail: `not about ${familyNames}: ${v.reason || 'the check said no'}` };
  }
  if (ctx.watching) return { state: 'would', detail: `would add to ${familyNames}${files.length ? ` with ${files.length === 1 ? 'a file' : `${files.length} files`}` : ''}`, fileKeys };
  if (!env.JOBTREAD_GRANT_KEY) throw new Error('JOBTREAD_GRANT_KEY isn’t set');

  const bytes = [];
  for (const f of files) bytes.push({ name: f.name, type: f.type, bytes: await fileBytes(ctx.token, msg, f, ctx.fetchImpl) });
  const ids = json(row.comment_ids, {});
  const own = json(row.posted_ids, {});
  for (const accountId of accounts) {
    if (own[accountId]) continue; // (posted on an earlier try of this email)
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
    own[accountId] = id;
    // Kept as it's made: a try that fails on the next account, or is cut off here, must not post on this one again
    await env.DB.prepare('UPDATE mail_sweep SET comment_ids = ?, posted_ids = ? WHERE mailbox = ? AND id = ?').bind(JSON.stringify(ids), JSON.stringify(own), row.mailbox, row.id).run();
  }
  return { state: 'posted', detail: `added to ${familyNames}${files.length ? ` with ${files.length === 1 ? 'a file' : `${files.length} files`}` : ''}`, commentIds: ids, postedIds: own, fileKeys };
}

/** Once per account: Slack hears that a new account's emails are waiting, and why */
async function tellHeld(env, ctx, accountId, n, born) {
  const first = await env.DB.prepare('INSERT OR IGNORE INTO mail_sweep_state (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(`held:${accountId}`, JSON.stringify({ n }), new Date(ctx.now).toISOString()).run();
  if (!first.meta?.changes) return;
  const name = ctx.names.get(accountId);
  const until = new Date(born + BRAKE_AGE_MS).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
  await slackIssue(env, `mail-held:${accountId}`, slackCard({
    icon: '✋',
    title: `${name}’s emails are waiting`,
    lead: `${name} is a new JobTread account, and ${n} emails in staff inboxes matched it at once. That usually means a test, so none of them are on the account. If it’s a test, delete it in JobTread and they never will be. If it’s real, they go on ${until}, each one checked first.`,
    buttons: [{ label: 'Open in JobTread', url: `https://app.jobtread.com/customers/${accountId}` }, { label: 'Open the applicant', url: `${SITE_ORIGIN}/admin/#applications/applicants/${accountId}` }],
    footer: 'Staff inboxes sweep',
  }), { title: `${name}’s emails waiting`, kind: 'attention', area: 'applications' }).catch((err) => console.error('[mail-sweep] held alert', err.message));
}

const finish = (DB, row, { state, detail = null, commentIds = null, postedIds = null, fileKeys = null, chargeId = null }, now) => DB.prepare('UPDATE mail_sweep SET state = ?, detail = ?, comment_ids = COALESCE(?, comment_ids), posted_ids = COALESCE(?, posted_ids), file_keys = ?, charge_id = COALESCE(?, charge_id), updated_at = ? WHERE mailbox = ? AND id = ?')
  .bind(state, detail ? String(detail).slice(0, 300) : null, commentIds ? JSON.stringify(commentIds) : null, postedIds ? JSON.stringify(postedIds) : null, fileKeys ? JSON.stringify(fileKeys) : null, chargeId, new Date(now).toISOString(), row.mailbox, row.id).run();

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
    // Its receipt is on the card charge: the email's job is done, so it leaves the inbox (archiveDue)
    if (out.onCard) await env.DB.prepare("UPDATE mail_sweep SET archived = 'no' WHERE mailbox = ? AND id = ?").bind(row.mailbox, row.id).run();
  } catch (err) {
    // A cap reached: nothing's wrong with this email, so it goes back as it was with no try spent, and the sweep rests
    if (aiCapped(err)) {
      ctx.capped = true;
      await env.DB.prepare('UPDATE mail_sweep SET state = ?, detail = ?, updated_at = ? WHERE mailbox = ? AND id = ?').bind(row.state, AI_WAIT_NOTE, iso, row.mailbox, row.id).run();
      return;
    }
    console.error('[mail-sweep]', row.kind, err.message);
    await env.DB.prepare("UPDATE mail_sweep SET state = 'failed', tries = COALESCE(tries, 0) + 1, detail = ?, updated_at = ? WHERE mailbox = ? AND id = ?")
      .bind(String(err.message).slice(0, 300), iso, row.mailbox, row.id).run();
  }
}

// ─── Card charges first ─────────────────────────────────────────────
//
// Every SOARD card charge (Mercury's, and Ramp's while SOARD moves off it) needs its receipt. A charge with none
// looks in its cardholder's own email: the charge's exact amount, near its date, from the store or reading like a
// receipt. The best one goes on the charge, in Mercury or in Ramp, and its email is archived. The first look is 5
// minutes after the charge, then every 10 minutes for its first hour, hourly for its first day and every 6 hours
// after; a charge with none after a week says so in Automations.

const CARD_LOOK_BACK_MS = 8 * DAY_MS;
// Once, the first time: the charges of the last 90 days, so the ones from before this began get their look too (Peter, Nov 8 2026)
const CATCH_UP_MS = 90 * DAY_MS;
const CARD_GIVE_UP_MS = 7 * DAY_MS;
const CARD_FIRST_LOOK_MS = 5 * MIN_MS;
const RAMP_EVERY_MS = 15 * MIN_MS;
const CARD_MS = 22 * 1000; // the heartbeat's share for looking, from the sweep's start
const nextGap = (age) => (age < HOUR_MS ? 10 * MIN_MS : age < DAY_MS ? HOUR_MS : 6 * HOUR_MS);
const chargeWords = (c) => `the ${c.card === 'ramp' ? 'Ramp' : 'Mercury'} card charge (${c.vendor || 'a vendor'} $${(c.cents / 100).toFixed(2)})`;
const secs = (ms) => Math.floor(ms / 1000);
/** Gmail's search words for an amount: "1299.00" or "1,299.00" */
function amountWords(cents) {
  const plain = (cents / 100).toFixed(2);
  const commas = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return commas === plain ? `"${plain}"` : `("${plain}" OR "${commas}")`;
}

/** Mercury's card charges (Job Costs' copy) and Ramp's (every 15 minutes) → card_receipts: a new one starts looking; one given a receipt elsewhere stops */
async function syncCardCharges(env, ctx, st) {
  const catchUp = !st.cardsCaughtUp;
  const since = ctx.now - (catchUp ? CATCH_UP_MS : CARD_LOOK_BACK_MS);
  const charges = [];
  try {
    const rows = (await env.DB.prepare(`SELECT id, cents, vendor, email, created_at, has_receipt FROM spend_charges
        WHERE kind LIKE '%Card%' AND cents > 0 AND created_at >= ? AND COALESCE(status, '') NOT IN ('failed', 'cancelled', 'reversed', 'blocked')`).bind(new Date(since).toISOString()).all()).results || [];
    for (const r of rows) charges.push({ charge: `mercury:${r.id}`, card: 'mercury', email: r.email, cents: r.cents, vendor: r.vendor, at: r.created_at, had: Boolean(r.has_receipt) });
  } catch { /* Job Costs hasn't seen a card charge yet */ }
  let rampRead = !rampConfigured(env);
  if (rampConfigured(env) && (catchUp || ctx.now - (st.rampCardsAt || 0) >= RAMP_EVERY_MS)) {
    try {
      for (const t of await rampCardCharges(env, { since, fetchImpl: ctx.fetchImpl })) charges.push({ charge: `ramp:${t.id}`, card: 'ramp', email: t.email, userId: t.userId, cents: t.cents, vendor: t.vendor, at: t.at, had: t.hasReceipt });
      st.rampCardsAt = ctx.now;
      rampRead = true;
    } catch (err) { ctx.notes.ramp = err.message; }
  }
  // Caught up once Ramp has been read that far back (tried again each sweep until it has)
  if (catchUp && rampRead) st.cardsCaughtUp = ctx.now;
  const iso = new Date(ctx.now).toISOString();
  // A charge that had no inbox looks once its cardholder has one, however old the charge: an account added to the sweep,
  // or a Ramp cardholder whose Ramp email is now a SOARD one (asked of Ramp when it's read, every 15 minutes)
  const stuck = (await env.DB.prepare("SELECT charge, card, user_id, mailbox FROM card_receipts WHERE state = 'no_inbox'").all()).results || [];
  let rampEmails = null;
  if (rampRead && rampConfigured(env) && stuck.some((r) => r.card === 'ramp' && r.user_id)) {
    try { rampEmails = await rampUserEmails(env, { fetchImpl: ctx.fetchImpl }); } catch (err) { ctx.notes.ramp = err.message; }
  }
  for (const r of stuck) {
    const mailbox = ctx.mailboxOf(normEmail((r.card === 'ramp' && rampEmails?.get(r.user_id)) || r.mailbox));
    if (ctx.inboxes.has(mailbox)) await env.DB.prepare("UPDATE card_receipts SET state = 'looking', mailbox = ?, next_look = ?, updated_at = ? WHERE charge = ? AND state = 'no_inbox'").bind(mailbox, iso, iso, r.charge).run();
  }
  for (const c of charges) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || !(c.cents > 0)) continue;
    const mailbox = ctx.mailboxOf(normEmail(c.email));
    const state = c.had ? 'had' : ctx.inboxes.has(mailbox) ? 'looking' : 'no_inbox';
    // (each SET reads the row as it was)
    await env.DB.prepare(`INSERT INTO card_receipts (charge, card, mailbox, user_id, cents, vendor, charged_at, state, next_look, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(charge) DO UPDATE SET
          state = CASE WHEN excluded.state = 'had' AND card_receipts.state IN ('looking', 'none', 'no_inbox') THEN 'had'
            WHEN excluded.state = 'looking' AND card_receipts.state = 'no_inbox' THEN 'looking' ELSE card_receipts.state END,
          mailbox = CASE WHEN card_receipts.state = 'no_inbox' THEN excluded.mailbox ELSE card_receipts.mailbox END,
          next_look = CASE WHEN excluded.state = 'looking' AND card_receipts.state = 'no_inbox' THEN excluded.next_look ELSE card_receipts.next_look END,
          updated_at = excluded.updated_at`)
      .bind(c.charge, c.card, mailbox, c.userId || null, c.cents, c.vendor || '', new Date(at).toISOString(), state, new Date(at + CARD_FIRST_LOOK_MS).toISOString(), iso).run();
  }
}

/** How much an email reads like this charge's receipt → a score, or null when it can't be one: not the charge's exact amount, staff's own mail, a money tool's notice, a refund */
function receiptScore(msg, c, hinted, strict = false) {
  const h = msg.payload?.headers;
  const sender = senderOf(h);
  const from = addresses(sender);
  const subject = header(h, 'Subject');
  if (!from.length || from.every(isOurs) || from.some((e) => OWN_TOOLS.test(e))) return null;
  if ((msg.labelIds || []).includes('SENT') || CALENDAR.test(subject.trim()) || AUTO_REPLY.test(subject) || /\b(refund|return|cancel)/i.test(subject)) return null;
  if (!amountsIn(subject, msg.snippet, receiptText(msg.payload)).includes(c.cents)) return null;
  const store = `${sender.replace(/<.*>/, '')} ${from[0].split('@')[1].replace(/\.[a-z]+$/i, '')}`;
  let score = 1 - Math.abs((Number(msg.internalDate) || 0) - Date.parse(c.charged_at)) / (4 * DAY_MS);
  if (hinted) score += 3;
  if (RECEIPTISH.test(`${subject} ${msg.snippet || ''}`)) score += 2;
  if (NOT_RECEIPT.test(subject)) score -= 1; // a shipping notice loses to a receipt, but the store's with the exact amount will do (Amazon charges as it ships)
  if (filesWorth(msg.payload).some((f) => RECEIPT_FILE.test(f.type))) score += 2; // the store's own PDF beats a "payment received"
  const like = Math.max(vendorLikeness(c.vendor, store), vendorLikeness(c.vendor, subject));
  if (strict && like < 0.5) return null;
  score += 2 * like;
  // The exact amount and one thing more: hinted, receipt words, the store's PDF or the store's name
  return score >= 1.5 ? score : null;
}

/** Nothing yet: the next look, sooner while the charge is new; after a week it stops ('none') */
async function nextLook(DB, c, now) {
  const age = now - Date.parse(c.charged_at);
  const done = age >= CARD_GIVE_UP_MS;
  await DB.prepare('UPDATE card_receipts SET looks = COALESCE(looks, 0) + 1, next_look = ?, state = ?, detail = ?, updated_at = ? WHERE charge = ? AND state = ?')
    .bind(done ? null : new Date(now + nextGap(age)).toISOString(), done ? 'none' : 'looking', done ? 'no receipt found in SOARD’s email' : null, new Date(now).toISOString(), c.charge, 'looking').run();
}

/** The best email for a charge in one inbox → { msg, score, mailbox, box } | null */
async function bestIn(env, ctx, c, mailbox, { q, hinted = [], taken, strict = false }) {
  const box = await ctx.open(mailbox);
  const list = await gmail(box.token, `/messages?maxResults=15&q=${encodeURIComponent(q)}`, ctx.fetchImpl);
  let best = null;
  // (a coworker's inbox gets fewer: the heartbeat run has a limit on calls out)
  for (const id of [...new Set([...hinted, ...(list.messages || []).map((m) => m.id)])].slice(0, strict ? 6 : 12)) {
    if (taken.has(`${mailbox}:${id}`)) continue;
    const msg = await gmail(box.token, `/messages/${id}?format=full`, ctx.fetchImpl);
    const score = receiptScore(msg, c, hinted.includes(id), strict);
    if (score != null && (!best || score > best.score)) best = { msg, score, mailbox, box };
  }
  return best;
}

/**
 * One charge's look: its cardholder's email first. After the charge's first hour, the other SOARD inboxes too (the
 * store's email often goes to whoever's address is on the store account), where the store's name has to match.
 * The best email found goes on the charge.
 */
async function lookOnce(env, ctx, c, until) {
  const at = Date.parse(c.charged_at);
  let hints = [];
  try { hints = JSON.parse(c.hints || '[]'); } catch { /* none */ }
  const hinted = [...new Set(hints.filter((x) => String(x).startsWith(`${c.mailbox}:`)).map((x) => String(x).slice(c.mailbox.length + 1)))];
  const q = `after:${secs(at - 2 * DAY_MS)} before:${secs(at + 8 * DAY_MS)} ${amountWords(c.cents)}`;
  // An email already on another charge isn't this one's (two $10 charges, two receipts)
  const taken = new Set(((await env.DB.prepare('SELECT msg_id FROM card_receipts WHERE msg_id IS NOT NULL AND charge != ?').bind(c.charge).all()).results || []).map((r) => r.msg_id));
  let best = await bestIn(env, ctx, c, c.mailbox, { q, hinted, taken });
  if (!best && ctx.now - at >= HOUR_MS) {
    for (const mailbox of ctx.inboxes) {
      if (mailbox === c.mailbox) continue;
      // Out of time partway: this look doesn't count, so an old charge isn't called receiptless on half a search
      if (Date.now() > until) return 'unfinished';
      const b = await bestIn(env, ctx, c, mailbox, { q, taken, strict: true });
      if (b && (!best || b.score > best.score)) best = b;
    }
  }
  if (!best) return nextLook(env.DB, c, ctx.now);
  const { msg, mailbox, box } = best;
  const h = msg.payload?.headers;
  const from = senderOf(h);
  const subject = header(h, 'Subject');
  const sentAt = Number(msg.internalDate) || ctx.now;
  const store = from.replace(/<.*>/, '').replace(/"/g, '').trim() || c.vendor;
  const uploads = await receiptUploads(env, { ...ctx, ...box }, { mailbox }, msg, { v: { vendor: store }, files: filesWorth(msg.payload), from, subject, sentAt, text: receiptText(msg.payload) });
  const id = c.charge.slice(c.card.length + 1);
  if (c.card === 'ramp') {
    for (const [i, u] of uploads.entries()) await rampAttach(env, { transactionId: id, userId: c.user_id, ...u, key: `${c.charge}:${msg.id}:${i}` }, ctx.fetchImpl);
  } else {
    for (const u of uploads) await attachToCharge(env, id, u, ctx.fetchImpl);
  }
  const now = new Date(ctx.now).toISOString();
  const detail = `put “${subject}” on ${chargeWords(c)}`.slice(0, 300);
  await env.DB.prepare("UPDATE card_receipts SET state = 'attached', msg_id = ?, detail = ?, looks = COALESCE(looks, 0) + 1, next_look = NULL, updated_at = ? WHERE charge = ?").bind(`${mailbox}:${msg.id}`, detail, now, c.charge).run();
  // Its email, and any other that pointed to this charge (a "payment received" before the receipt), leave the inbox (archiveDue)
  for (const [inbox, mid] of [[mailbox, msg.id], ...hinted.filter((x) => mailbox !== c.mailbox || x !== msg.id).map((x) => [c.mailbox, x])]) {
    const mine = mid === msg.id && inbox === mailbox;
    // The one put on the charge says so, whatever the email side thought of it; one already sent to the receipt inbox keeps saying that
    await env.DB.prepare(`INSERT INTO mail_sweep (mailbox, id, at, kind, state, msgid, subject, detail, charge_id, archived, source, updated_at)
        VALUES (?1, ?2, ?3, 'receipt', 'card', ?4, ?5, ?6, ?7, 'no', 'card', ?8)
        ON CONFLICT(mailbox, id) DO UPDATE SET archived = CASE WHEN mail_sweep.archived = 'yes' THEN 'yes' ELSE 'no' END, charge_id = ?7,
          state = CASE WHEN ?9 = 1 AND mail_sweep.state <> 'sent' THEN 'card' ELSE mail_sweep.state END,
          detail = CASE WHEN mail_sweep.state = 'sent' THEN mail_sweep.detail WHEN ?9 = 1 OR mail_sweep.state = 'card' THEN ?6 ELSE mail_sweep.detail END, updated_at = ?8`)
      .bind(inbox, mid, new Date(mine ? sentAt : ctx.now).toISOString(), mine ? header(h, 'Message-ID') || null : null, mine ? subject.slice(0, 200) : '',
        mine ? detail : `another email for ${chargeWords(c)}`, c.charge, now, mine ? 1 : 0).run();
  }
}

/** The charges due a look, until the sweep's share of the heartbeat is used */
async function lookForCardReceipts(env, ctx, until) {
  // The newest first: a charge made today never waits behind the catch-up's old ones
  const due = (await env.DB.prepare("SELECT * FROM card_receipts WHERE state = 'looking' AND next_look <= ? ORDER BY charged_at DESC LIMIT 5").bind(new Date(ctx.now).toISOString()).all()).results || [];
  for (const c of due) {
    if (Date.now() > until) break;
    try {
      if (await lookOnce(env, ctx, c, until) === 'unfinished') break;
    } catch (err) {
      // Looked at again on its next look
      ctx.notes.cards = `looking for ${chargeWords(c)}’s receipt: ${err.message}`;
      await nextLook(env.DB, c, ctx.now);
    }
  }
}

/**
 * Out of the inbox (Gmail's archive: the Inbox label comes off; nothing is deleted) for each email whose receipt is
 * on its card charge. Archiving needs gmail.modify on the site's Google client; until Google allows it the emails
 * wait and the reason shows in Automations → the error, then they go on the first sweep after. → that reason | null
 */
async function archiveDue(env, ctx) {
  const rows = (await env.DB.prepare("SELECT mailbox, id FROM mail_sweep WHERE archived = 'no' ORDER BY at LIMIT 20").all()).results || [];
  for (const r of rows) {
    try {
      const token = await accessToken(env, r.mailbox, { fetchImpl: ctx.fetchImpl, now: ctx.now, scope: GMAIL_MODIFY_SCOPE });
      const res = await ctx.fetchImpl(`${GMAIL_API}/messages/${encodeURIComponent(r.id)}/modify`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['INBOX'] }), signal: AbortSignal.timeout(15000),
      });
      // Gone from the mailbox (deleted by hand): nothing left to archive
      if (!res.ok && res.status !== 404) throw new Error(`Gmail answered ${res.status}`);
      await env.DB.prepare("UPDATE mail_sweep SET archived = 'yes' WHERE mailbox = ? AND id = ?").bind(r.mailbox, r.id).run();
    } catch (err) {
      return /unauthorized_client|access_denied|not authorized|Gmail answered 403/i.test(err.message)
        ? 'Google hasn’t let the site archive a handled receipt’s email yet: Google Admin → Security → API controls → Domain-wide delegation, add https://www.googleapis.com/auth/gmail.modify to the site’s client'
        : `archiving a handled receipt’s email: ${err.message}`;
    }
  }
  return null;
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
  // An inbox added later (a store account) starts from when it's added, as every inbox did: its card charges search its older mail anyway
  bs.cursor ||= ctx.now;
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
    // Only an approved application's addresses: before that, a family (or a test) gets new email only
    const pending = [...ctx.families.backfill].filter((e) => !done.has(e)).sort();
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

async function sweep(env, st, { fetchImpl, now, print }) {
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
  const accounts = await mailboxes(env);
  const people = new Map(accounts.map((b) => [b.email, b.name]));
  // Any of an account's addresses leads to its mailbox (Ramp knows Linzi as linzi@, an alias on her account)
  const mailboxOf = new Map(accounts.flatMap((b) => [[b.email, b.email], ...b.aliases.map((a) => [normEmail(a), b.email])]));
  // Every account in SOARD's Google is SOARD's, the store's sunnyandranney.com ones too, and so are its people
  ORG_DOMAINS = orgDomains(accounts);
  const boxes = [...people.keys()];
  if (!boxes.length) throw new Error('Google’s staff accounts haven’t been read yet (Staff sign-in follows Google)');
  const families = await familyAddresses(env.DB, { staff: [...people.values()] });
  const cfg = await readConfig(env.DB).catch(() => ({}));
  const tokens = new Map();
  const ctx = {
    // Called as ctx.fetchImpl(…): Cloudflare's fetch refuses to be some object's method ("Illegal invocation")
    now, fetchImpl: (url, init) => fetchImpl(url, init), watching, families, names: families.names, startedAt: st.startedAt,
    receiptInbox: normEmail(cfg.receiptInbox || DEFAULT_RECEIPT_INBOX),
    inboxes: new Set(boxes),
    mailboxOf: (e) => mailboxOf.get(e) || e,
    // Shared by every copy of ctx a handler gets ({ ...ctx, ...box }), so what one notes reaches Automations
    notes: {},
    print: print || (async (e, html) => (await import('./_board-sign.js')).printPdf(e, html)),
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
  const backfillDone = !st.backfill?.chunk && [...families.backfill].every((e) => (st.backfill?.done || []).includes(e));

  // The card charges first, so the email side knows a card charge's receipt when it sees one
  await syncCardCharges(env, ctx, st);
  // Oldest first; family emails wait until the last year's are all in, so each family's reads in order
  const retryBefore = new Date(now - RETRY_MS).toISOString();
  // Held for a new account: back in line once the account is old enough (or gone), and sorted again then
  for (const r of (await env.DB.prepare("SELECT mailbox, id, accounts FROM mail_sweep WHERE state = 'held' LIMIT 500").all()).results || []) {
    let ids = [];
    try { ids = JSON.parse(r.accounts || '[]'); } catch { /* none */ }
    if (ids.every((id) => !families.created.has(id) || now - families.created.get(id) >= BRAKE_AGE_MS)) {
      await env.DB.prepare("UPDATE mail_sweep SET state = 'queued', detail = NULL WHERE mailbox = ? AND id = ? AND state = 'held'").bind(r.mailbox, r.id).run();
    }
  }
  // One a heartbeat dropped halfway: tried again like a failure
  await env.DB.prepare("UPDATE mail_sweep SET state = 'failed', tries = COALESCE(tries, 0) + 1 WHERE state = 'working' AND updated_at < ?").bind(retryBefore).run();
  // (the mail is still read and queued while the AI rests; only the judging waits)
  while (Date.now() - started < HANDLE_MS && (st.aiRestUntil || 0) <= now && !ctx.capped) {
    const row = await env.DB.prepare(`SELECT * FROM mail_sweep WHERE (state = 'queued' OR (state = 'failed' AND tries < ? AND updated_at < ?))
        ${backfillDone ? '' : "AND kind = 'receipt'"} ORDER BY at LIMIT 1`).bind(MAX_TRIES, retryBefore).first();
    if (!row) break;
    await handle(env, ctx, row);
  }
  await lookForCardReceipts(env, ctx, started + CARD_MS);
  const archiving = await archiveDue(env, ctx);
  if (archiving) errors.push(archiving);
  if (ctx.notes.ramp) errors.push(`Ramp’s card charges can’t be read, so Ramp receipts go to the receipt inbox only: ${ctx.notes.ramp}`);
  if (ctx.notes.cards) errors.push(ctx.notes.cards);
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sweep WHERE state = 'queued'").first();
  if (ctx.capped) { st.aiRestUntil = now + AI_REST_MS; errors.push(AI_WAIT_NOTE); }
  Object.assign(st, { busy: Boolean(waiting?.n) || !backfillDone, backfillDone, lastSweptAt: now, error: errors.length ? errors.join(' · ').slice(0, 500) : null, runningUntil: 0 });
  return st;
}

/** On the live hub's heartbeat: every 3 minutes, every minute while there's a backlog. Never throws */
export async function maybeSweepMail(env, { fetchImpl = fetch, now = Date.now(), force = false, print = null } = {}) {
  if (!env?.DB || !env.GOOGLE_CALENDAR_KEY) return null;
  let st = {};
  try {
    await ensure(env.DB);
    st = await readState(env.DB);
    if (!force && now - (st.lastRunAt || 0) < (st.busy ? BUSY_MS : EVERY_MS)) return null;
    if (!force && (st.runningUntil || 0) > now) return null;
    Object.assign(st, { lastRunAt: now, runningUntil: now + 45000 });
    await writeState(env.DB, st);
    st = await sweep(env, st, { fetchImpl, now, print });
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
  const recent = ((await env.DB.prepare("SELECT kind, state, detail, mailbox, updated_at FROM mail_sweep WHERE state IN ('sent', 'posted', 'would', 'failed', 'held') ORDER BY updated_at DESC LIMIT 12").all()).results || [])
    .map((r) => ({ kind: r.kind, state: r.state, detail: r.detail, inbox: String(r.mailbox).split('@')[0], at: r.updated_at }));
  const queued = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sweep WHERE state = 'queued'").first();
  // The card charges: receipts put on this week, still looking, none found in a week
  const cards = Object.fromEntries(((await env.DB.prepare('SELECT state, COUNT(*) AS n FROM card_receipts WHERE updated_at >= ? GROUP BY state').bind(since).all()).results || []).map((r) => [r.state, r.n]));
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
    inboxes: Object.values(st.boxes || {}).filter((b) => !b.noMail).length, backfillDone: Boolean(st.backfillDone), queued: queued?.n || 0, counts, recent, cards,
  };
}
