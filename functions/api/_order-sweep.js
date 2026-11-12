/**
 * Kid items, step 1: every store order email in SOARD's inboxes, read (watch only)
 * ===========================================================================
 * Clareece and the rest of the staff buy for the makeovers online. The stores'
 * own emails say what was ordered, when it shipped, how (tracking) and when it
 * was delivered. This lane finds those emails in every SOARD inbox and the
 * orders@ group's copies, reads each one (./_order-read.js, then Workers AI for
 * the items when the email's own words and markup don't give them) and keeps
 * the read in D1 order_mail. For now it only reads: nothing goes to JobTread,
 * nobody is emailed. Automations shows how much of each store's mail it could
 * read (items, tracking, order numbers), which is the test the build's next
 * steps wait on.
 *
 * Its own lane, apart from the receipt sweep (./_mail-sweep.js): that sweep
 * leaves shipping and delivery emails out on purpose, keeps one kind per
 * email and strips links, and orders need all three. It has its own AI cap
 * (feature 'orders' on the gateway), its own state, and its own slice of the
 * heartbeat, so neither can slow the other.
 *
 *   - New mail: every 3 minutes (every minute with a backlog), a few inboxes a
 *     run in turn, a Gmail search for order words in the subject.
 *   - The last 60 days, once, per inbox: the same search, paged.
 *   - Store mail only: never staff's own (a forward is the forwarder's copy of
 *     what's already in their inbox), never sent mail, and never the store's
 *     (Sunny & Ranney) buying: an inbox whose main address is on the store's
 *     domain, or an email addressed only to store addresses.
 *   - The same email in several inboxes (orders@ copies) is read once.
 */

import { normEmail, founderEmails, peopleRows } from './_board-roles.js';
import { accessToken, GMAIL_READ_SCOPE } from './_google-calendar.js';
import { mailboxes, orgDomains, gmail, header, partsOf, bytesOf, htmlText } from './_mailbox.js';
import { viaGateway, aiCapped, AI_REST_MS, AI_WAIT_NOTE } from './_ai.js';
import { readOrderEmail, orderKind, withAi, withAltText, ORDER_SCHEMA, ORDER_PROMPT, storeOf } from './_order-read.js';

const STAFF_DOMAIN = 'soardcharity.com';
// orders@ is a Google group, the address on stores' accounts: a group has no inbox of its own, so its mail is read where
// it's delivered. Agent Gracie (automation@, an inbox the sweep reads) is kept a member who gets every email (Peter,
// Nov 11 2026: "add orders to the email you are searching through"). Looked at once a day
export const ORDERS_GROUP = 'orders@soardcharity.com';
export const ORDERS_INBOX = 'automation@soardcharity.com';
const GROUP_MEMBER_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member';
const FEED_EVERY_MS = 24 * 60 * 60 * 1000;
const FEED_RETRY_MS = 60 * 60 * 1000;
const FEED_WAIT_MS = 20000;
const EVERY_MS = 3 * 60 * 1000;
const BUSY_MS = 60 * 1000;
const LIST_MS = 6 * 1000;        // listing inboxes stops starting new ones here
const READ_MS = 10 * 1000;       // and reading emails stops starting new ones here (one read can take the AI's 12 seconds)
const BOXES_A_RUN = 6;           // inboxes looked at a run, in turn (the heartbeat's calls out are shared)
const META_A_RUN = 40;           // emails' headers fetched a run
const READS_A_RUN = 6;           // emails read in full a run
const PER_LIST = 50;
const OVERLAP_MS = 10 * 60 * 1000;
export const BACKFILL_DAYS = 60;
const MAX_TRIES = 3;
const FAILS_TO_REST = 5;
const RETRY_MS = 10 * 60 * 1000;
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_TIMEOUT_MS = 12 * 1000;
const AI_CHARS = 9000;
// Bumped when reading changes: every email read under an older version is read again once
// 3 (Nov 11 2026): UPS numbers written in lower case beside "UPS" (The Container Store) are read; every read email is read again once
export const READER_V = 3;
// The rules for which emails are a store's order mail at all (orderTriage): when they get better, what they let go by
// before is looked at again. 2: "Arrived: Your …" is a delivery (Walmart's; Linzi's storage cart, Nov 10 2026)
export const TRIAGE_V = 2;
const RETRIAGE_A_RUN = 40;
const AT_ONCE = 6;
const HEADERS = ['From', 'X-Original-From', 'X-Original-Sender', 'Reply-To', 'To', 'Cc', 'Delivered-To', 'Subject', 'Message-ID', 'List-Id'];
// Order words in the subject: Gmail does the first sort, so a run lists only what could be an order email
export const ORDER_Q = 'subject:(order OR orders OR ordered OR shipped OR shipping OR shipment OR delivered OR delivery OR arriving OR arrived OR "on its way" OR "on the way" OR package OR pickup OR "picked up" OR cancelled OR canceled OR cancellation OR refund OR return OR tracking OR purchase OR delayed OR backordered)';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS order_mail (
    mailbox TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, msgid TEXT, store TEXT, kind TEXT, subject TEXT,
    state TEXT NOT NULL, read TEXT, detail TEXT, tries INTEGER DEFAULT 0, source TEXT, updated_at TEXT,
    PRIMARY KEY (mailbox, id))`,
  'CREATE INDEX IF NOT EXISTS idx_order_mail_state ON order_mail(state, at)',
  'CREATE INDEX IF NOT EXISTS idx_order_mail_msgid ON order_mail(msgid)',
  'CREATE TABLE IF NOT EXISTS order_sweep_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
];
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  for (const s of SCHEMA) await DB.prepare(s).run();
  _ready.add(DB);
}
async function readState(DB) {
  const row = await DB.prepare("SELECT data FROM order_sweep_state WHERE key = 'sweep'").first();
  try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
}
const writeState = (DB, st) => DB.prepare("INSERT OR REPLACE INTO order_sweep_state (key, data, updated_at) VALUES ('sweep', ?, ?)")
  .bind(JSON.stringify(st), new Date().toISOString()).run();

const iso = (ms) => new Date(ms).toISOString();
const addresses = (s) => (String(s || '').match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[a-z]{2,}/gi) || []).map(normEmail);
/** Who really sent it: a SOARD Google group passes a store's email on as "'Amazon.com' via orders" */
export const senderOf = (h) => header(h, 'X-Original-From') || header(h, 'X-Original-Sender') || header(h, 'From');

// Not a store: SOARD's money and staff tools (Ramp's replies to forwarded orders, Mercury's card news, Gusto, payouts),
// Google's own notices, and mail systems' bounces (seen in the first live run, Nov 9 2026)
const NOT_STORES = /(^|\.)(ramp\.com|mercury\.com|gusto\.com|stripe\.com|zeffy\.com|jobtread\.com|intuit\.com|quickbooks\.com|plaid\.com|companycam\.com|google\.com|googlemail\.com|slack\.com|kit\.com|convertkit\.com|resend\.com|zoom\.us|facebookmail\.com|linkedin\.com|docusign\.net|dropbox\.com)$/i;
const SYSTEM_SENDER = /^(mailer-daemon|postmaster)@/i;
// A conversation, not a store's notice: a reply, a forward, a calendar answer or cancellation
const CONVERSATION = /^\s*((re|fwd?|fw|aw)\s*:|(accepted|declined|tentative(ly accepted)?|invitation|updated invitation|cancell?ed( event| invitation)?)\s*:)/i;

/** A sender and subject that can't be a store's order notice, whatever its words say → why | null */
export function notStoreMail(from, subject) {
  const e = addresses(from)[0] || '';
  if (SYSTEM_SENDER.test(e)) return 'a mail system’s notice';
  if (NOT_STORES.test(e.split('@')[1] || '')) return 'from a money or staff tool, not a store';
  if (CONVERSATION.test(String(subject || ''))) return 'a reply, forward or calendar notice';
  // Money moving, not goods: "A payout is on its way to …", "Bill payment delivered"
  if (/\b(payout|bill payment|payment (sent|delivered|received|is on its way)|transfer (sent|is on its way))\b/i.test(String(subject || ''))) return 'about money, not goods';
  return null;
}

/**
 * Is this a store's order email for SOARD → { kind, store } | null. `domains` are SOARD's Google domains;
 * `storeDomains` the store's (Sunny & Ranney) among them
 */
export function orderTriage(msg, { domains, storeDomains }) {
  if ((msg.labelIds || []).some((l) => l === 'SENT' || l === 'DRAFT' || l === 'SPAM')) return null;
  const h = msg.payload?.headers;
  const sender = senderOf(h);
  const from = addresses(sender)[0] || '';
  // Staff's own mail, a forward included: the original is already in someone's inbox
  if (!from || domains.has(from.split('@')[1])) return null;
  // Addressed only to the store's addresses: the store's buying, not SOARD's
  const to = addresses(`${header(h, 'To')} ${header(h, 'Cc')} ${header(h, 'Delivered-To')}`).filter((e) => domains.has(e.split('@')[1]));
  if (to.length && to.every((e) => storeDomains.has(e.split('@')[1]))) return null;
  const subject = header(h, 'Subject');
  if (notStoreMail(sender, subject)) return null;
  const r = readOrderEmail({ subject, from: sender, snippet: msg.snippet || '' });
  if (!r.kind) return null;
  return { kind: r.kind, store: r.store || r.carrier || null };
}

async function metadata(token, ids, fetchImpl) {
  const meta = HEADERS.map((x) => `&metadataHeaders=${x}`).join('');
  const out = [];
  for (let i = 0; i < ids.length; i += AT_ONCE) out.push(...(await Promise.all(ids.slice(i, i + AT_ONCE).map((id) => gmail(token, `/messages/${id}?format=metadata${meta}`, fetchImpl)))));
  return out;
}

async function queue(DB, mailbox, msg, t, source, now) {
  const h = msg.payload?.headers;
  await DB.prepare(`INSERT OR IGNORE INTO order_mail (mailbox, id, at, msgid, store, kind, subject, state, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
    .bind(mailbox, msg.id, iso(Number(msg.internalDate) || now), header(h, 'Message-ID') || null, t.store, t.kind, header(h, 'Subject').slice(0, 200), source, iso(now)).run();
}

/**
 * The emails the first look let go by (state skipped, no reason kept) whose subject the rules now call order mail:
 * looked at again (their headers), and queued when they are. Done in turns, each inbox in its own (st.retriageAfter:
 * { inbox: [at, id] of the last looked at | 'done' }), so one inbox that can't be opened holds only its own emails.
 * Once every inbox is done, st.triageV is current
 */
export async function retriage(env, ctx, st, budget, boxes = null) {
  // An older run's single place in line (or none): every inbox from its start (what was queued since isn't skipped)
  const after = st.retriageAfter && !Array.isArray(st.retriageAfter) && typeof st.retriageAfter === 'object' ? st.retriageAfter : {};
  st.retriageAfter = after;
  const meta = HEADERS.map((x) => `&metadataHeaders=${x}`).join('');
  // One that can't be looked at again is let go with that said, and the rest go on: gone from Gmail (deleted), or in an
  // inbox no longer among the staff's (a removed account). A staff inbox that can't be opened (its sign-in refused while
  // Google's settings change) holds its own emails until it opens; the other inboxes go on. Google failing on one
  // email (a 500) stops its inbox's turn; five runs failing, counted for that email alone, lets it go
  const letGo = (r, why) => env.DB.prepare("UPDATE order_mail SET detail = ?, updated_at = ? WHERE mailbox = ? AND id = ? AND state = 'skipped'").bind(why, iso(ctx.now), r.mailbox, r.id).run();
  const fails = (st.retriageFails && typeof st.retriageFails === 'object') ? st.retriageFails : (st.retriageFails = {});
  const inboxes = ((await env.DB.prepare("SELECT DISTINCT mailbox FROM order_mail WHERE state = 'skipped' AND detail IS NULL").all()).results || []).map((r) => r.mailbox);
  let left = Math.min(RETRIAGE_A_RUN, Math.max(0, budget.meta));
  let allDone = true;
  for (const mailbox of inboxes) {
    if (after[mailbox] === 'done') continue;
    const [at0, id0] = Array.isArray(after[mailbox]) ? after[mailbox] : ['', ''];
    const rows = (await env.DB.prepare("SELECT mailbox, id, at, subject FROM order_mail WHERE mailbox = ? AND state = 'skipped' AND detail IS NULL AND (at > ? OR (at = ? AND id > ?)) ORDER BY at, id LIMIT 400")
      .bind(mailbox, at0, at0, id0).all()).results || [];
    const cands = rows.filter((r) => orderKind(r.subject || ''));
    // Where this inbox's turn ends when all of the page is looked at: the page's end, or done
    const pageEnd = rows.length === 400 ? [rows[rows.length - 1].at, rows[rows.length - 1].id] : 'done';
    if (!cands.length) { after[mailbox] = pageEnd; if (pageEnd !== 'done') allDone = false; continue; }
    allDone = false;
    if (left <= 0) continue;
    let token = null;
    try { token = await ctx.open(mailbox); } catch {
      // A staff inbox that can't be opened: its emails wait. One no longer among the staff's: let go
      if (!boxes || boxes.includes(mailbox)) continue;
      for (const r of cands) await letGo(r, 'looked at again: its inbox can’t be opened');
      after[mailbox] = pageEnd;
      continue;
    }
    let last = null, stopped = false;
    for (const r of cands) {
      if (left <= 0) { stopped = true; break; }
      left -= 1;
      budget.meta -= 1;
      const k = `${r.mailbox}|${r.id}`;
      let msg;
      try { msg = await gmail(token, `/messages/${r.id}?format=metadata${meta}`, ctx.fetchImpl); } catch (err) {
        if (err.status === 404) { await letGo(r, 'looked at again: gone from Gmail'); delete fails[k]; last = r; continue; }
        if ((fails[k] = (fails[k] || 0) + 1) < 5) { stopped = true; break; }
        await letGo(r, `looked at again: ${String(err.message).slice(0, 80)}`);
        delete fails[k];
        last = r;
        continue;
      }
      delete fails[k];
      last = r;
      const t = orderTriage(msg, ctx);
      // Still not a store's order mail: left as it was (better rules some day may take it)
      if (!t) continue;
      const h = msg.payload?.headers;
      await env.DB.prepare("UPDATE order_mail SET state = 'queued', kind = ?, store = ?, msgid = ?, source = 'again', updated_at = ? WHERE mailbox = ? AND id = ? AND state = 'skipped'")
        .bind(t.kind, t.store, header(h, 'Message-ID') || null, iso(ctx.now), r.mailbox, r.id).run();
    }
    // This inbox's next turn starts after the last one looked at; all of its page looked at: the page's end
    if (stopped) { if (last) after[mailbox] = [last.at, last.id]; } else after[mailbox] = pageEnd;
  }
  if (allDone) Object.assign(st, { triageV: TRIAGE_V, retriageAfter: null });
}

/** One inbox: its new order mail since the last look, or the next page of its 60 days → emails queued */
async function scanBox(env, ctx, mailbox, bs, budget) {
  const token = await ctx.open(mailbox);
  bs.cursor ||= ctx.now;
  const backfill = !bs.backfilled;
  // The 60 days first (paged, up to when this inbox was first looked at), then new mail from that moment on
  const q = backfill
    ? `${ORDER_Q} after:${Math.floor((bs.cursor - BACKFILL_DAYS * 86400e3) / 1000)} before:${Math.floor(bs.cursor / 1000)} -in:drafts -in:sent -in:spam`
    : bs.pageQ || `${ORDER_Q} after:${Math.floor((bs.cursor - OVERLAP_MS) / 1000)} -in:drafts -in:sent -in:spam`;
  const page = backfill ? bs.backfillPage : bs.page;
  const list = await gmail(token, `/messages?maxResults=${PER_LIST}&q=${encodeURIComponent(q)}${page ? `&pageToken=${page}` : ''}`, ctx.fetchImpl);
  const ids = (list.messages || []).map((m) => m.id);
  const known = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(`SELECT id FROM order_mail WHERE mailbox = ? AND id IN (${part.map(() => '?').join(', ')})`).bind(mailbox, ...part).all()).results || [];
    for (const r of rows) known.add(r.id);
  }
  const fresh = ids.filter((id) => !known.has(id));
  const take = fresh.slice(0, Math.max(0, budget.meta));
  budget.meta -= take.length;
  let queued = 0;
  let newest = bs.pageMax || bs.cursor;
  for (const msg of await metadata(token, take, ctx.fetchImpl)) {
    newest = Math.max(newest, Number(msg.internalDate) || 0);
    const t = orderTriage(msg, ctx);
    if (t) { await queue(env.DB, mailbox, msg, t, backfill ? 'backfill' : 'new', ctx.now); queued++; }
    else await env.DB.prepare("INSERT OR IGNORE INTO order_mail (mailbox, id, at, state, subject, source, updated_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?)")
      .bind(mailbox, msg.id, iso(Number(msg.internalDate) || ctx.now), header(msg.payload?.headers, 'Subject').slice(0, 200), backfill ? 'backfill' : 'new', iso(ctx.now)).run();
  }
  // Out of header budget part way: the same page again next run (what's done is known now)
  if (take.length < fresh.length) return queued;
  if (backfill) {
    if (list.nextPageToken) bs.backfillPage = list.nextPageToken;
    else Object.assign(bs, { backfilled: ctx.now, backfillPage: null });
  } else if (list.nextPageToken) Object.assign(bs, { pageQ: q, page: list.nextPageToken, pageMax: newest });
  else Object.assign(bs, { cursor: newest, pageQ: null, page: null, pageMax: null });
  return queued;
}

const decodePart = (p) => {
  const charset = /charset="?([\w-]+)/i.exec(header(p.headers, 'Content-Type'))?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(bytesOf(p.body.data)); } catch { return new TextDecoder().decode(bytesOf(p.body.data)); }
};
/** The email's plain words and its HTML, each if it has one */
export function bodiesOf(payload) {
  const parts = partsOf(payload).filter((p) => !p.filename && p.body?.data);
  const plain = parts.find((p) => p.mimeType === 'text/plain');
  const html = parts.find((p) => p.mimeType === 'text/html');
  return { text: plain ? decodePart(plain) : '', html: html ? decodePart(html) : '' };
}

// Soft hyphens, zero-width and other blanks: a store's preview padding runs to thousands of them
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\u3164\ufeff\uffa0]/g;

/** Workers AI's read of one email's items → the AI part of a read | null. A cap reached throws */
export async function aiRead(env, { subject, from, sentAt, text }) {
  if (!env.AI?.run) return null;
  const words = String(text).replace(/https?:\/\/\S+/g, ' ').replace(INVISIBLE, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n');
  const input = [`From: ${from}`, `Subject: ${subject}`, `Sent: ${iso(sentAt).slice(0, 10)}`, `Email:\n${words.slice(0, AI_CHARS)}`].join('\n');
  let timer;
  try {
    const out = await Promise.race([
      env.AI.run(AI_MODEL, {
        messages: [{ role: 'system', content: ORDER_PROMPT }, { role: 'user', content: input }],
        max_tokens: 900, temperature: 0, response_format: { type: 'json_schema', json_schema: ORDER_SCHEMA },
      }, viaGateway('orders')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), AI_TIMEOUT_MS); }),
    ]);
    let j = out?.response ?? out;
    if (typeof j === 'string') { try { j = JSON.parse(j.slice(j.indexOf('{'), j.lastIndexOf('}') + 1)); } catch { return null; } }
    return j && typeof j === 'object' ? j : null;
  } catch (err) {
    if (aiCapped(err)) throw err;
    console.error('[order-sweep] reading', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One queued email, read in full → its row settled */
async function readOne(env, ctx, row) {
  // Read again with better rules: it stays 'read' (its old read in use) until the new one is saved
  const again = row.state === 'read';
  if (!again) await env.DB.prepare("UPDATE order_mail SET state = 'working', updated_at = ? WHERE mailbox = ? AND id = ?").bind(iso(ctx.now), row.mailbox, row.id).run();
  // A read again counts its try first: one that keeps cutting a run off can't be picked first forever
  else await env.DB.prepare('UPDATE order_mail SET tries = COALESCE(tries, 0) + 1 WHERE mailbox = ? AND id = ?').bind(row.mailbox, row.id).run();
  let before = null;
  if (again) { try { before = JSON.parse(row.read || 'null'); } catch { before = null; } }
  try {
    // The same email from another inbox (an orders@ copy) already read: this one is that one
    const twin = row.msgid ? await env.DB.prepare("SELECT mailbox, id FROM order_mail WHERE msgid = ? AND state = 'read' AND NOT (mailbox = ? AND id = ?) LIMIT 1").bind(row.msgid, row.mailbox, row.id).first() : null;
    if (twin) return settle(env, ctx, row, 'duplicate', null, `the same email as ${twin.mailbox.split('@')[0]}’s`);
    const token = await ctx.open(row.mailbox);
    const msg = await gmail(token, `/messages/${row.id}?format=full`, ctx.fetchImpl);
    const h = msg.payload?.headers;
    const { text, html } = bodiesOf(msg.payload);
    const sentAt = Number(msg.internalDate) || ctx.now;
    const subject = header(h, 'Subject');
    const from = senderOf(h);
    // Queued before a rule was added: the same rules again now
    const not = notStoreMail(from, subject);
    if (not) return settle(env, ctx, row, 'skipped', null, not);
    let read = readOrderEmail({ subject, from, snippet: msg.snippet || '', text, html, sentAt });
    if (read.needsAi) {
      // The HTML with its pictures' names when there is HTML (stores' plain text is often only "view in browser"), else the plain words
      const fromHtml = html ? htmlText(withAltText(html)) : '';
      const words = fromHtml.length >= 200 ? fromHtml : text || fromHtml;
      const ai = await aiRead(env, { subject, from, sentAt, text: words });
      if (again && before && (!ai || ai.kind === 'not_order')) {
        // Read again and the AI didn't answer (or now calls it not an order): the old read stands, with only what the
        // better rules found added (a tracking number). A good read is never swapped for an empty one: losing its
        // order number or items would take the kid's line back to Not ordered in JobTread
        const tracking = [...(before.tracking || [])];
        for (const t of read.tracking || []) if (!tracking.some((x) => x.number === t.number)) tracking.push(t);
        return settle(env, ctx, row, 'read', { ...before, tracking, v: READER_V }, summary({ ...before, tracking }));
      }
      if (ai?.kind === 'not_order') return settle(env, ctx, row, 'skipped', null, 'not an order email, by its words');
      read = withAi(read, ai);
      if (!ai) read.aiMissed = true;
    }
    read.v = READER_V;
    return settle(env, ctx, row, 'read', read, summary(read));
  } catch (err) {
    if (aiCapped(err)) {
      ctx.capped = true;
      if (!again) await env.DB.prepare("UPDATE order_mail SET state = 'queued', updated_at = ? WHERE mailbox = ? AND id = ?").bind(iso(ctx.now), row.mailbox, row.id).run();
      return null;
    }
    // A read again that failed keeps the old read; it's tried a few times, then left as it was
    if (again) {
      await env.DB.prepare("UPDATE order_mail SET tries = COALESCE(tries, 0) + 1, updated_at = ? WHERE mailbox = ? AND id = ?").bind(iso(ctx.now), row.mailbox, row.id).run();
      return null;
    }
    await env.DB.prepare("UPDATE order_mail SET state = 'failed', tries = COALESCE(tries, 0) + 1, detail = ?, updated_at = ? WHERE mailbox = ? AND id = ?")
      .bind(String(err.message).slice(0, 300), iso(ctx.now), row.mailbox, row.id).run();
    return null;
  }
}

const settle = (env, ctx, row, state, read, detail) => env.DB.prepare('UPDATE order_mail SET state = ?, read = ?, detail = ?, store = COALESCE(?, store), kind = COALESCE(?, kind), updated_at = ? WHERE mailbox = ? AND id = ?')
  .bind(state, read ? JSON.stringify(read) : null, String(detail || '').slice(0, 300), read?.store || null, read?.kind || null, iso(ctx.now), row.mailbox, row.id).run();

/** A read in words, for Automations: "Shipped · 2 items · UPS 1Z… · for Lizzie" */
export function summary(r) {
  const bits = [r.kind];
  if (r.items?.length) bits.push(`${r.items.length} item${r.items.length === 1 ? '' : 's'}`);
  if (r.tracking?.length) bits.push(r.tracking.map((t) => t.carrier).join(', '));
  if (r.orderNumber) bits.push(`order ${r.orderNumber}`);
  if (r.jobPo) bits.push(`PO “${r.jobPo}”`);
  if (r.shipTo) bits.push(r.shipTo === 'office' ? 'to the Office' : 'not to the Office');
  return bits.join(' · ');
}

async function sweep(env, st, { fetchImpl, now }) {
  const started = Date.now();
  const accounts = await mailboxes(env);
  const domains = orgDomains(accounts);
  const storeDomains = new Set([...domains].filter((d) => d !== STAFF_DOMAIN));
  // An inbox whose main address is the store's is the store's buying
  const boxes = accounts.map((a) => a.email).filter((e) => e.split('@')[1] === STAFF_DOMAIN);
  if (!boxes.length) throw new Error('Google’s staff accounts haven’t been read yet (Staff sign-in follows Google)');
  const tokens = new Map();
  const ctx = {
    now, domains, storeDomains,
    fetchImpl: (url, init) => fetchImpl(url, init),
    open: async (mailbox) => {
      if (!tokens.has(mailbox)) tokens.set(mailbox, await accessToken(env, mailbox, { fetchImpl, now, scope: GMAIL_READ_SCOPE }));
      return tokens.get(mailbox);
    },
  };
  const errors = [];
  st.startedAt ||= now;
  // Reading got better: everything read before is read again, once, IN PLACE: each keeps its old read (and stays on
  // the check-in page and in JobTread) until its new read replaces it. Taking them all off to re-queue them would
  // have the JobTread writer mark their lines Not ordered and take their Also bought lines away in the meantime
  if ((st.readerV || 1) < READER_V) {
    await env.DB.prepare("UPDATE order_mail SET tries = 0 WHERE state = 'read' AND COALESCE(json_extract(read, '$.v'), 1) < ?").bind(READER_V).run();
    st.readerV = READER_V;
  }
  st.boxes ||= {};
  // Inboxes in turn, a few a run, starting where the last run stopped
  const at = (st.nextBox || 0) % boxes.length;
  const turn = [...boxes.slice(at), ...boxes.slice(0, at)].slice(0, BOXES_A_RUN);
  const budget = { meta: META_A_RUN };
  for (const mailbox of turn) {
    if (Date.now() - started > LIST_MS || budget.meta <= 0) break;
    const bs = st.boxes[mailbox] ||= {};
    if (bs.noMail && now - bs.noMail < 86400e3) { st.nextBox = (boxes.indexOf(mailbox) + 1) % boxes.length; continue; }
    try { await scanBox(env, ctx, mailbox, bs, budget); Object.assign(bs, { noMail: null, error: null, fails: 0 }); } catch (err) {
      if (/Mail service not enabled|failedPrecondition/i.test(err.message)) bs.noMail = now;
      else {
        // A page token Gmail no longer takes: start the listing over (what's been seen is known, so nothing repeats)
        if (/Gmail answered 400/.test(err.message)) Object.assign(bs, { page: null, pageQ: null, pageMax: null, backfillPage: null });
        bs.fails = (bs.fails || 0) + 1;
        bs.error = err.message;
        errors.push(`${mailbox.split('@')[0]}: ${err.message}`);
      }
    }
    st.nextBox = (boxes.indexOf(mailbox) + 1) % boxes.length;
  }
  // A run cut off halfway leaves a row 'working': tried again like a failure
  const retryBefore = iso(now - RETRY_MS);
  await env.DB.prepare("UPDATE order_mail SET state = 'failed', tries = COALESCE(tries, 0) + 1 WHERE state = 'working' AND updated_at < ?").bind(retryBefore).run();
  // Better rules for what's an order email: those let go by before (skipped at the first look, with no reason kept),
  // whose subject the rules now take, are looked at again, a few a run, and queued if they are a store's order mail
  if ((st.triageV || 1) < TRIAGE_V) await retriage(env, ctx, st, budget, boxes).catch((err) => errors.push(`looking again: ${err.message}`));
  let reads = 0;
  while (reads < READS_A_RUN && Date.now() - started < READ_MS && (st.aiRestUntil || 0) <= now && !ctx.capped) {
    // Oldest first, so an order's confirmation is read before its shipping and delivery
    const row = await env.DB.prepare("SELECT * FROM order_mail WHERE (state = 'queued' OR (state = 'failed' AND tries < ? AND updated_at < ?)) ORDER BY at LIMIT 1")
      .bind(MAX_TRIES, retryBefore).first()
      // Nothing new: one read before the rules got better, read again (it keeps its old read meanwhile)
      || await env.DB.prepare("SELECT * FROM order_mail WHERE state = 'read' AND COALESCE(json_extract(read, '$.v'), 1) < ? AND COALESCE(tries, 0) < ? ORDER BY at LIMIT 1")
        .bind(READER_V, MAX_TRIES).first();
    if (!row) break;
    await readOne(env, ctx, row);
    reads++;
  }
  if (ctx.capped) { st.aiRestUntil = now + AI_REST_MS; errors.push(AI_WAIT_NOTE); }
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_mail WHERE state = 'queued' OR (state = 'read' AND COALESCE(json_extract(read, '$.v'), 1) < ? AND COALESCE(tries, 0) < ?)").bind(READER_V, MAX_TRIES).first();
  // An inbox failing time after time doesn't hold the rest at a minute's pace (its trouble shows in Automations)
  const backfilling = boxes.some((b) => !st.boxes[b]?.backfilled && !st.boxes[b]?.noMail && (st.boxes[b]?.fails || 0) < FAILS_TO_REST);
  Object.assign(st, { busy: Boolean(waiting?.n) || backfilling, backfilling, inboxes: boxes.length, lastSweptAt: now, error: errors.length ? errors.join(' · ').slice(0, 500) : null, runningUntil: 0 });
  return st;
}

/** On the live hub's heartbeat: every 3 minutes, every minute while there's a backlog. Never throws */
export async function maybeSweepOrders(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!env?.DB || !env.GOOGLE_CALENDAR_KEY) return null;
  let st = {};
  try {
    await ensure(env.DB);
    st = await readState(env.DB);
    if (st.off && !force) return null;
    if (!force && now - (st.lastRunAt || 0) < (st.busy ? BUSY_MS : EVERY_MS)) return null;
    if (!force && (st.runningUntil || 0) > now) return null;
    Object.assign(st, { lastRunAt: now, runningUntil: now + 45000 });
    await writeState(env.DB, st);
    st = await sweep(env, st, { fetchImpl, now });
    // The sweep's work kept first: the orders@ check after it (Google slow to answer) can't lose it
    await writeState(env.DB, st);
    const feed = st.ordersFeed || {};
    if (now - (feed.at || 0) > (feed.ok ? FEED_EVERY_MS : FEED_RETRY_MS)) {
      let timer;
      const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('Google didn’t answer in 20 seconds')), FEED_WAIT_MS); });
      st.ordersFeed = await Promise.race([keepOrdersFeed(env, { fetchImpl, now }), late]).catch((err) => ({ ok: false, at: now, error: err.message })).finally(() => clearTimeout(timer));
      await writeState(env.DB, st);
    }
    return st;
  } catch (err) {
    console.error('[order-sweep]', err.message);
    await writeState(env.DB, { ...st, error: err.message, runningUntil: 0 }).catch(() => {});
    return null;
  }
}

/**
 * orders@'s mail reaches an inbox the sweep reads: Agent Gracie a member of the group, getting every email. Added when
 * she isn't one, her delivery set to every email when it isn't (a digest or no email would hold the mail back). Asks
 * Google as a Workspace admin founder (as the board group does, ./_board-group.js) → { ok, at, did?, error? }
 */
export async function keepOrdersFeed(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const at = now;
  const api = `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(ORDERS_GROUP)}/members`;
  const call = async (token, method, url, body) => {
    const res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  };
  let subjects = [];
  try {
    const dir = JSON.parse((await env.DB.prepare("SELECT data FROM staff_state WHERE key = 'directory'").first())?.data || '{}');
    subjects = [...new Set([dir.subject, ...founderEmails(await peopleRows(env.DB))].filter(Boolean))];
  } catch { /* nothing read yet */ }
  if (!subjects.length) return { ok: false, at, error: 'No Workspace admin to ask Google as' };
  let last = 'Google didn’t answer';
  for (const subject of subjects) {
    let token;
    try { token = await accessToken(env, subject, { fetchImpl, now, scope: GROUP_MEMBER_SCOPE }); } catch (err) { last = err.message; continue; }
    const got = await call(token, 'GET', `${api}/${encodeURIComponent(ORDERS_INBOX)}`);
    if (got.status === 403) { last = `Google: ${got.data?.error?.message || 'not allowed'}`; continue; }
    if (got.ok) {
      if (got.data?.delivery_settings === 'ALL_MAIL') return { ok: true, at };
      const fixed = await call(token, 'PATCH', `${api}/${encodeURIComponent(ORDERS_INBOX)}`, { delivery_settings: 'ALL_MAIL' });
      return fixed.ok ? { ok: true, at, did: `Agent Gracie gets every email to ${ORDERS_GROUP} now (was ${got.data?.delivery_settings || 'not set'})` } : { ok: false, at, error: `Google: ${fixed.data?.error?.message || fixed.status}` };
    }
    if (got.status === 404) {
      const added = await call(token, 'POST', api, { email: ORDERS_INBOX, role: 'MEMBER', delivery_settings: 'ALL_MAIL' });
      if (added.ok) return { ok: true, at, did: `Agent Gracie added to ${ORDERS_GROUP}, every email` };
      // The group itself isn't there (404 again): said plainly
      return { ok: false, at, error: added.status === 404 ? `${ORDERS_GROUP} isn’t a Google group` : `Google: ${added.data?.error?.message || added.status}` };
    }
    last = `Google: ${got.data?.error?.message || got.status}`;
  }
  return { ok: false, at, error: last };
}

const pct = (n, of) => (of ? Math.round((100 * n) / of) : null);

/**
 * For Automations and the step-1 gate: by store, how many emails of each kind were read and how many gave
 * their items, tracking and order number; the backfill; the last few reads (store, kind, item names)
 */
export async function orderSweepStatus(env, { now = Date.now() } = {}) {
  if (!env?.DB) return null;
  await ensure(env.DB);
  const st = await readState(env.DB);
  const rows = (await env.DB.prepare("SELECT store, kind, read, at FROM order_mail WHERE state = 'read'").all()).results || [];
  const byStore = new Map();
  for (const r of rows) {
    let read = null;
    try { read = JSON.parse(r.read || 'null'); } catch { /* skipped */ }
    if (!read) continue;
    const s = byStore.get(r.store || '(unknown)') || { emails: 0, orders: 0, withItems: 0, shipped: 0, withTracking: 0, withOrderNumber: 0, toOffice: 0, withPo: 0 };
    s.emails++;
    if (['order', 'shipped', 'out', 'delivered', 'pickup'].includes(read.kind)) { s.orders++; if (read.items?.length) s.withItems++; }
    if (['shipped', 'out'].includes(read.kind)) { s.shipped++; if (read.tracking?.length) s.withTracking++; }
    if (read.orderNumber) s.withOrderNumber++;
    if (read.shipTo === 'office') s.toOffice++;
    if (read.jobPo) s.withPo++;
    byStore.set(r.store || '(unknown)', s);
  }
  // Whether email alone says when things arrive: each store's orders that shipped over a week ago, and how many of them
  // never had a delivered (or ready for pickup) email. A store that often doesn't is where a carrier tracking service helps
  const orders = new Map();
  for (const r of rows) {
    let read = null;
    try { read = JSON.parse(r.read || 'null'); } catch { /* skipped */ }
    if (!read?.orderNumber) continue;
    const key = `${r.store}|${read.orderNumber}`;
    const o = orders.get(key) || { store: r.store || '(unknown)', shippedAt: null, arrived: false };
    if (['shipped', 'out'].includes(read.kind)) o.shippedAt = Math.min(o.shippedAt ?? Infinity, Date.parse(r.at) || Infinity);
    if (['delivered', 'pickup'].includes(read.kind)) o.arrived = true;
    orders.set(key, o);
  }
  const weekAgo = now - 7 * 86400e3;
  for (const o of orders.values()) {
    if (!Number.isFinite(o.shippedAt) || o.shippedAt > weekAgo) continue;
    const s = byStore.get(o.store);
    if (!s) continue;
    s.shippedWeekAgo = (s.shippedWeekAgo || 0) + 1;
    if (!o.arrived) s.noDeliveredEmail = (s.noDeliveredEmail || 0) + 1;
  }
  const stores = [...byStore.entries()].map(([store, s]) => ({
    store, ...s, shippedWeekAgo: s.shippedWeekAgo || 0, noDeliveredEmail: s.noDeliveredEmail || 0,
    itemsPct: pct(s.withItems, s.orders), trackingPct: pct(s.withTracking, s.shipped), deliveredEmailPct: pct((s.shippedWeekAgo || 0) - (s.noDeliveredEmail || 0), s.shippedWeekAgo || 0),
  })).sort((a, b) => b.emails - a.emails);
  const states = Object.fromEntries(((await env.DB.prepare('SELECT state, COUNT(*) AS n FROM order_mail GROUP BY state').all()).results || []).map((r) => [r.state, r.n]));
  const recent = ((await env.DB.prepare("SELECT mailbox, store, kind, subject, detail, read, at FROM order_mail WHERE state IN ('read', 'failed') ORDER BY updated_at DESC LIMIT 15").all()).results || [])
    .map((r) => {
      let read = null;
      try { read = JSON.parse(r.read || 'null'); } catch { /* none */ }
      return { inbox: String(r.mailbox).split('@')[0], store: r.store, kind: r.kind, at: r.at, detail: r.detail, items: (read?.items || []).slice(0, 3).map((i) => i.name.slice(0, 60)) };
    });
  return {
    key: Boolean(env.GOOGLE_CALENDAR_KEY), ai: Boolean(env.AI?.run), watching: true,
    startedAt: st.startedAt ? iso(st.startedAt) : null, lastSweptAt: st.lastSweptAt ? iso(st.lastSweptAt) : null,
    error: st.error || null, inboxes: st.inboxes || 0, backfilling: Boolean(st.backfilling),
    // orders@ read through Agent Gracie: whether she's a member getting every email (Automations shows a problem)
    ordersFeed: st.ordersFeed ? { ok: Boolean(st.ordersFeed.ok), at: st.ordersFeed.at ? new Date(st.ordersFeed.at).toISOString() : null, error: st.ordersFeed.error || null } : null,
    states, stores, recent,
  };
}

export { storeOf };
