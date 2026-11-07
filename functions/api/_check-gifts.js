/**
 * A check deposited in Mercury becomes its Zeffy record
 * ===========================================================================
 * Peter, Nov 5-6 2026: "when a check is deposited in mercury can the zeffy
 * record be created too?", and a person only "if its absolutely necessary".
 * Mercury holds the money and the picture; Zeffy stays the record of the gift.
 * Nothing here keeps a second copy of either: a row says what happened to one
 * check, and which Zeffy record it became.
 *
 * What makes it safe without a person: nothing leaves SOARD. Every record is
 * made with its tax receipt and confirmation email off, the way staff enter
 * checks by hand today (18 of the 21 checks from Aug 22 to Nov 4 2026 had no
 * tax receipt). So a wrong guess is a line in Zeffy that a person can move or
 * remove, never a paper in a donor's hands. Slack's gift alert shows each one
 * to the team as it does a hand entry.
 *
 * The steps, one check a run (Cloudflare gives this work about 30 seconds, and
 * a vision model can take 20 of them):
 *   1. Every checkDeposit Mercury sends (the webhook mirrors it into
 *      mercury_txns, ./_mercury-txns.js) gets a row. Each one not final is read
 *      again by id, because the catch-up only reads transactions by the day
 *      they were created: a check that later posts or comes back shows up here.
 *   2. The picture is read by two models from different makers (READERS). They
 *      must agree who wrote it, and what's read must equal Mercury's amount and
 *      check number. The picture stays in memory, the models' answers are thrown
 *      away once used, and a number that could be a bank account never passes
 *      safeText, so no account or routing number is kept or shown anywhere.
 *   3. When Mercury says it posted, Zeffy is read first (matchZeffy). A hand
 *      entry or a donor's pay-by-check for this gift is linked, and nothing is
 *      made. Otherwise judge() says what it is, and the record is made once.
 *      Zeffy has no way to refuse a repeat, so a POST whose answer never came
 *      is looked for, never sent again.
 *
 * A person is asked only when the site can't act: it can't read who wrote the
 * check, Zeffy may already have it under another name, the check is for an event
 * (Zeffy takes tickets and auctions only by hand), SOARD pays that company and
 * nothing says refund or gift, or Zeffy didn't answer. See REASONS.
 *
 * It ships in Watch: everything but writing to Zeffy. Staff keep entering
 * checks; each hand entry is linked and scored against what the site would have
 * done, and each one teaches who that payer is (check_payers), so a later
 * check from them lands on the same donor. Job Costs → Checks turns it On, after
 * the one-time test of writing to Zeffy (testWrite) has passed.
 *
 * Env: MERCURY_API_TOKEN + MERCURY_RELAY_KEY, ZEFFY_API_KEY, the AI binding.
 */

import { getTransaction, mercuryConfigured, readState, writeState } from './_mercury.js';
import { ensureTxnSchema, mirrorTransaction } from './_mercury-txns.js';
import { handlePayment, zeffyGet, zeffySend, givenName, WRITE_TEST_NAME, WRITE_TEST_ONE_WORD } from './_zeffy.js';
import { READERS, answerOf } from './_score-scans.js';
import { imageKind } from './_image-types.js';
import { aiCapped, viaGateway } from './_ai.js';
import { slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { readConfig as readSpendConfig } from './_spend.js';
import { vendorKey } from './_spend-match.js';
import { nameKeyOf, realDate as isDay } from './_vendor-files.js';
import { TZ } from './_reveals.js';

const KEY = 'check-gifts';
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const RUN_EVERY_MS = 5 * MIN;
const MATCH_EVERY_MS = 60 * MIN;
const READ_TRIES = 3;
const CLAIM_MS = 2 * MIN;          // a try still running, or one Cloudflare cut short
const READ_TIMEOUT_MS = 24000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const REREAD_EVERY_MS = DAY;       // a check that has posted
const FINAL_AFTER_MS = 60 * DAY;   // a check that posted this long ago has stayed
const PENDING_ALARM_MS = 14 * DAY; // Mercury says up to 5 business days
const NO_RECORD_ALARM_MS = 10 * DAY;
const UNSURE_AFTER_MS = 30 * MIN;  // how long Zeffy gets to show a POST it never answered
const LOOK_BACK_S = 120 * 86400;   // how far back Zeffy is read for one check
const DATED_BACK_MS = 60 * DAY;    // a check older than this is dated the day it was deposited
const SAME_GIVER_DAYS = 14;        // a hand entry this long before the check's date can be it
const OTHER_NAME_DAYS = 3;         // under another name, only one dated about when the check was
const AFTER_DAYS = 21;             // a hand entry this long after the check's date or deposit can be it
const NO_DATE_DAYS = 45;           // with no date read, how far back the giver's entry is asked about
const OLD_CHECK_MS = 30 * DAY;     // at the flip to On, a check this long posted goes to a person, not straight in
const ZEFFY_PAGES = 30;
const LIST_LIMIT = 300;

/** The one-time test of writing to Zeffy: a new id runs it once more on the next heartbeat */
export const WRITE_TEST = '2026-11-06';

const CARDS_URL = `${SITE_ORIGIN}/admin/#job-costs/checks`;
const ZEFFY_PAYMENTS = 'https://www.zeffy.com/en-US/o/all-payments';

/** Why a check is with a person, in the words the page and Slack use. Nothing else stops a check */
export const REASONS = {
  'no-picture': 'Mercury has no picture of this check, so the site can’t tell who wrote it.',
  unreadable: 'The site couldn’t read who wrote this check.',
  'maybe-double': 'Zeffy already has an entry for this amount under another name. It may be this check.',
  'amount-differs': 'Zeffy has an entry from this giver around this date for a different amount.',
  pledge: 'This giver has an unpaid pledge or check promise in Zeffy for this amount.',
  event: 'The memo points to an event or a group’s campaign. Zeffy takes those only by hand.',
  vendor: 'SOARD pays this company, and nothing says if this is a refund or a gift.',
  'no-form': 'No open Zeffy donation form fits this check.',
  'zeffy-refused': 'Zeffy refused this record.',
  unsure: 'Zeffy didn’t answer when the site saved this, and the record hasn’t shown up. If it isn’t in Zeffy, save it again.',
  'told-gift': 'A person said this is a gift.',
  'record-gone': 'This check’s Zeffy record is gone. Save it again if it should be there, or say it isn’t a gift.',
  'old-check': 'This check posted a while ago and Zeffy has no record of it. Save it, or say it isn’t a gift.',
  'amount-off': 'Zeffy’s entry and the check are for different amounts. Fix the amount in Zeffy.',
  'still-unpaid': 'Zeffy still shows this entry as unpaid. Mark it paid in Zeffy.',
};
const ASKS_ABOUT_ENTRIES = ['maybe-double', 'amount-differs', 'pledge'];

/** Left out on purpose, without a person: not gifts. Each still says so on the page */
export const LEFT_OUT = {
  own: 'This looks like SOARD’s own money.',
  refund: 'The memo says this is a refund or reimbursement.',
  'not-a-giver': 'This looks like insurance or a tax payment, not a gift.',
  person: 'A person said this isn’t a gift.',
  back: 'The check came back.',
};

// Every model field is required, and "" or 0 means it isn't there: Workers AI's JSON mode drops optional ones
const READ_SCHEMA = {
  name: 'check',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      payer: { type: 'string' }, remitter: { type: 'string' }, cashiersCheck: { type: 'boolean' }, payee: { type: 'string' },
      date: { type: 'string' }, amount: { type: 'number' }, checkNumber: { type: 'string' }, memo: { type: 'string' },
    },
    required: ['payer', 'remitter', 'cashiersCheck', 'payee', 'date', 'amount', 'checkNumber', 'memo'],
  },
};

const READ_PROMPT = `You read one photo of a paper check made out to a charity. Report only what is written on the check, as JSON.
payer: who wrote the check, the printed or written name in the top left corner. A person, a couple, a company or a foundation. "" if you can't read it.
remitter: on a cashier's check or money order, the person it was bought for, often beside "Remitter", "Purchaser" or "Sent by". Otherwise "".
cashiersCheck: true for a cashier's check, official check, bank check or money order.
payee: the name after "Pay to the order of".
date: the date written on the check as YYYY-MM-DD, or "" if you can't read it.
amount: the amount in dollars as a number, from the box of digits. 0 if you can't read it.
checkNumber: the check number printed in the top right corner, or "".
memo: the words on the memo or "for" line, as written, or "".
Never copy the long row of digits along the bottom edge of the check, and never copy a routing number or account number anywhere. If you can't read a field, leave it empty. Don't guess.`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS check_gifts (
    id TEXT PRIMARY KEY, account_id TEXT, status TEXT, cents INTEGER NOT NULL, deposited_at TEXT, posted_at TEXT,
    check_number TEXT, link TEXT, state TEXT NOT NULL, reason TEXT, note TEXT,
    payer TEXT, check_date TEXT, memo TEXT, form_id TEXT, form_title TEXT, guess TEXT, score TEXT, shape TEXT,
    zeffy_id TEXT, via TEXT, rejected TEXT, payload TEXT, tries INTEGER NOT NULL DEFAULT 0, try_at TEXT, looked_at TEXT,
    final INTEGER NOT NULL DEFAULT 0, alerted TEXT, by TEXT, created_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS check_gifts_state ON check_gifts (state)',
  // One Zeffy record is one check: a second link to it is refused by the database itself
  'CREATE UNIQUE INDEX IF NOT EXISTS check_gifts_zeffy ON check_gifts (zeffy_id) WHERE zeffy_id IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS check_payers (
    key TEXT PRIMARY KEY, name TEXT, contact_id TEXT, campaign_id TEXT, by TEXT, updated_at TEXT)`,
];
const _ready = new WeakSet();
export async function ensureChecks(DB) {
  if (_ready.has(DB)) return;
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  await ensureTxnSchema(DB);
  _ready.add(DB);
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const digitsOf = (s) => String(s ?? '').replace(/\D+/g, '');
const noZeros = (s) => digitsOf(s).replace(/^0+/, '');
const toCents = (n) => Math.round(Number(n || 0) * 100);
export const money = (cents) => `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** The day in Eastern time: a 9:30 PM deposit on Dec 31 is still December */
const dayOf = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('en-CA', { timeZone: TZ }); };
const secondsOf = (day) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);

// ─── A number that could be a bank account never gets through ───────

/**
 * True when text holds 6 digits or more in a row, other than the check's own number. Anything between digits that
 * isn't a letter doesn't break a run (spaces, dashes, commas, slashes, the check font's symbols, full-width digits),
 * so neither a routing number nor an account number survives, however a model writes it. A date doesn't count.
 */
export function hasAccountDigits(text, checkNumber = '') {
  const plain = String(text ?? '').normalize('NFKC').replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ');
  const bare = plain.replace(/[^\p{L}\d]+/gu, '');
  const own = noZeros(checkNumber);
  return (bare.match(/\d{6,}/g) || []).some((run) => !own || run.replace(/^0+/, '') !== own);
}

/** What a model said, safe to keep or show: cleaned, cut, and empty when it holds a possible account number */
export function safeText(text, max = 120, checkNumber = '') {
  const t = clean(text).slice(0, max);
  return hasAccountDigits(t, checkNumber) ? '' : t;
}

/** A memo keeps its words when its numbers have to go: "Gala table 11-14-2026" still says gala */
export function safeMemo(text, max = 160, checkNumber = '') {
  const t = clean(String(text ?? '').normalize('NFKC')).slice(0, max);
  if (!hasAccountDigits(t, checkNumber)) return t;
  return clean(t.replace(/\d[^\p{L}]*/gu, ' '));
}

// ─── Who wrote it ───────────────────────────────────────────────────

/** A name written in capitals, in ordinary case: DANA R. WHITFIELD reads Dana R. Whitfield, and LLC stays LLC */
export function tidyName(name) {
  const t = clean(name);
  if (!t || /[a-z]/.test(t)) return t;
  return t.toLowerCase().replace(/[a-z][a-z'’]*/g, (w) => (/^(llc|llp|lp|inc|usa|ii|iii|iv)$/.test(w) ? (w === 'inc' ? 'Inc' : w.toUpperCase()) : /^(of|the|and|for|c|o)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** A giver's name to compare: "c/o" and what follows, The, LLC and punctuation gone, a name typed twice once */
export function payerKey(name) {
  const words = clean(name).toLowerCase()
    .replace(/\bc\s*\/\s*o\b.*$|\bc o\b.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|and|inc|incorporated|llc|ltd|lp|llp|corp|corporation|company)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const half = words.length / 2;
  if (words.length > 1 && Number.isInteger(half) && words.slice(0, half).join(' ') === words.slice(half).join(' ')) return words.slice(0, half).join(' ');
  return words.join(' ');
}

/** The same giver, as far as two names can say: the same words, all of one in the other, or J. Smith and John Smith */
export function sameGiver(a, b) {
  const ka = payerKey(a);
  const kb = payerKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const wa = ka.split(' ');
  const wb = kb.split(' ');
  const [few, many] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (few.join('').length >= 4 && few.every((w) => many.includes(w))) return true;
  return few.length >= 2 && few.at(-1) === many.at(-1) && few[0][0] === many[0][0] && (few[0].length === 1 || many[0].length === 1);
}

const OWN = /\bsunshine on a ranney\b|\bsoard\b/i;
const FOUNDATION = /\b(foundation|trust|fund|grant|charitable|endowment)\b/i;
const NOT_A_GIVER = /\b(insurance|assurance|internal revenue|irs|u\.?\s?s\.? treasury|department of (the )?treasury|department of revenue|state farm|allstate|geico|usaa|workers.? comp)\b/i;
/** Money that passes through for someone else: never taught as one donor, and the bank on a cashier's check is never the giver */
const PASS_THROUGH = /\b(bank|credit union|truist|wells fargo|chase|regions|synovus|pnc|fidelity charitable|schwab charitable|vanguard charitable|national philanthropic|donor.?advised|benevity|yourcause|cybergrants|network for good|america'?s charities|paypal giving|united way|community foundation|ameriprise|blackbaud|givinga|brightfunds|charities aid|charitable gift fund|giving fund)\b/i;
const REFUND_MEMO = /\b(refund\w*|reimburs\w*|rebate\w*|overpay\w*|credit memo|deposit return|return(ed)? deposit|insurance claim|claim)\b/i;
const EVENT_MEMO = /\b(golf|gala|tables?|tickets?|auction|foursome|fairway|raffle|banquet|tee|sponsor\w*|advisor\w*|advisory)\b/i;
const GIFT_MEMO = /\b(donat\w*|gift|contribut\w*|match\w*|charit\w*|support)\b/i;
// Words in many a form's title: a memo saying one of them says nothing about which form
const TITLE_WORDS = /^(help|build|building|brighter|home|homes|room|rooms|bedroom|therapy|bathroom|funding|grant|sunshine|ranney|donation|donations|their|tomorrow|kids|kid|child|make|makeover|give|gift|your|with|from|that|this|2\d{3})$/;

/** Mercury's own name for who paid, when it's a name: a deposit may say only "Check" */
export function mercuryPayer(txn) {
  const name = safeText(txn?.counterpartyName || '', 120, txn?.checkNumber);
  if (!name || OWN.test(name) || /^(mobile |check|cheque|deposit|remote|incoming|unknown|mercury)\b/i.test(name)) return '';
  return name;
}

// ─── Reading the picture ────────────────────────────────────────────

const timed = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
};

/** One model's reading, or null. A spending cap is thrown, so the check waits without spending a try */
async function readWith(env, model, image) {
  try {
    const out = await timed(env.AI.run(model, {
      messages: [
        { role: 'system', content: READ_PROMPT },
        { role: 'user', content: [{ type: 'text', text: 'Read this check.' }, { type: 'image_url', image_url: { url: image } }] },
      ],
      max_tokens: 800, temperature: 0, ...(READERS[model] || {}),
      response_format: { type: 'json_schema', json_schema: READ_SCHEMA },
    }, viaGateway('check-gifts')), READ_TIMEOUT_MS);
    const a = answerOf(out);
    return a && typeof a === 'object' ? a : null;
  } catch (e) {
    if (aiCapped(e)) throw e;
    // Only that it failed: an error can quote what it was given
    console.error('[check-gifts] a reader failed');
    return null;
  }
}

/** One reading made safe. The bank on a cashier's check isn't the giver: its remitter is, or nobody yet */
function cleanRead(r, checkNumber) {
  if (!r) return null;
  const payer = r.cashiersCheck ? safeText(r.remitter, 120, checkNumber) : safeText(r.payer, 120, checkNumber) || safeText(r.remitter, 120, checkNumber);
  return {
    payer,
    payee: safeText(r.payee, 120, checkNumber),
    date: isDay(r.date) ? r.date : '',
    cents: Number.isFinite(Number(r.amount)) ? toCents(r.amount) : 0,
    number: noZeros(r.checkNumber).length < 16 ? noZeros(r.checkNumber) : '',
    memo: safeMemo(r.memo, 160, checkNumber),
  };
}

/**
 * Two readings against what Mercury knows → { ok, payer, date, memo, why }. ok means the picture is this check
 * (amount to the cent, the check number too when Mercury has one) and the payer is known: from Mercury when it
 * names one, else both readers agreeing. A date only one reader sees isn't used.
 */
export function proveRead(reads, { cents, checkNumber = '', hint = '' }) {
  const good = reads.map((r) => cleanRead(r, checkNumber)).filter(Boolean);
  if (!good.length) return { ok: false, why: 'unreadable' };
  const isThisCheck = good.some((r) => r.cents === cents) && (!noZeros(checkNumber) || good.some((r) => r.number === noZeros(checkNumber)));
  if (!isThisCheck) return hint ? { ok: true, payer: tidyName(hint), date: '', memo: '' } : { ok: false, why: 'unreadable' };
  const [a, b] = good;
  // Two readers usually differ by a word: the longer holds both. Two different readings are both kept, for the memo checks and a person
  const memos = [...new Set(good.map((r) => r.memo).filter(Boolean))];
  const fuller = memos.length === 2 && (memos[0].toLowerCase().includes(memos[1].toLowerCase()) || memos[1].toLowerCase().includes(memos[0].toLowerCase()));
  const memo = (fuller ? [memos.sort((x, y) => y.length - x.length)[0]] : memos).join(' / ').slice(0, 200);
  const date = a && b && a.date && a.date === b.date ? a.date : '';
  if (hint) return { ok: true, payer: tidyName(hint), date, memo };
  if (!a?.payer || !b?.payer || !sameGiver(a.payer, b.payer)) return { ok: false, why: 'unreadable' };
  // Both took the payee's line for the payer's: this is who it's made out to, not who wrote it
  if (OWN.test(a.payer) && OWN.test(a.payee)) return { ok: false, why: 'unreadable' };
  return { ok: true, payer: tidyName(a.payer.length >= b.payer.length ? a.payer : b.payer), date, memo };
}

/** What Mercury sent for a check, in shape only (never a value), so the first real check settles what the docs don't say */
function shapeOf(txn, files, picture = null) {
  return JSON.stringify({
    fields: Object.keys(txn || {}).filter((k) => txn[k] != null && txn[k] !== '').sort(),
    counterparty: clean(txn?.counterpartyName).length ? (mercuryPayer(txn) ? 'a name' : 'a label') : 'none',
    files: (txn?.attachments || []).length,
    pictures: files.length,
    picture,
  });
}

/** The picture's bytes, for this try → { image, kind } or { none: why }. Each try takes the next picture, in case the first is the back */
async function pictureOf(files, tries, fetchImpl) {
  const file = files[Math.max(0, tries - 1) % files.length];
  const res = await fetchImpl(file.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { none: 'fetch', kind: null };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const kind = imageKind(bytes);
  if (!['jpeg', 'png', 'webp'].includes(kind) || bytes.length > MAX_IMAGE_BYTES) return { none: 'type', kind: kind || 'other', size: bytes.length };
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { image: `data:image/${kind};base64,${btoa(bin)}`, kind, size: bytes.length };
}

// ─── Is it in Zeffy already? ────────────────────────────────────────

const namesOn = (p) => [clean(p?.buyer?.company_name), givenName(p?.buyer)].filter(Boolean);
const paidByCheck = (p) => /che(ck|que)/i.test(String(p?.payment_method?.type || ''));
const madeByHand = (p) => p?.type === 'manual' || p?.type === 'imported';

/**
 * What Zeffy has that could be this check, measured from the day it would go on (recordDay, so a misread date or a
 * post-dated check can't move the window). A record already claimed by a check is out, and so are an online card gift and
 * a failed try.
 *   same     the same giver and amount, dated from 14 days before that day to 21 after the deposit, so staff entering a
 *            stack weeks later still match and a month-apart giver's other check doesn't. Only this links by itself
 *   promised the same giver and amount, not paid yet (a pledge, or a check promised on a form)
 *   maybe    the same amount where it can't be told: another name dated about when this check was, any donor's
 *            pay-by-check (they promise first, and it may name someone else), or the giver's own older entry when no
 *            date was read. A person says if it's this check
 *   other    the same giver around this date for another amount (one entry for two checks, or a typo)
 */
export function matchZeffy(row, payments, claimed = new Set()) {
  const day = recordDay(row);
  const anchor = secondsOf(day);
  const dated = day === row.check_date;
  const deposited = row.deposited_at ? secondsOf(dayOf(row.deposited_at)) : anchor;
  const latest = Math.max(anchor, deposited) + AFTER_DAYS * 86400;
  const out = { same: [], promised: [], maybe: [], other: [] };
  for (const p of payments || []) {
    if (claimed.has(String(p.id)) || p.refund_status === 'full') continue;
    const status = String(p.status || '').toLowerCase();
    if (/fail|cancel/.test(status)) continue;
    const byHand = madeByHand(p);
    const byCheck = paidByCheck(p);
    const unpaid = status !== 'succeeded';
    if (!byHand && !byCheck && !unpaid) continue;
    const at = Number(p.created) || 0;
    if (at > latest) continue;
    const giver = !!row.payer && namesOn(p).some((n) => sameGiver(row.payer, n));
    const near = at >= anchor - SAME_GIVER_DAYS * 86400;
    const promise = byCheck && !byHand;
    if (Number(p.amount) === Number(row.cents)) {
      if (giver && unpaid) out.promised.push(p);
      else if (giver && near) out.same.push(p);
      else if (promise) out.maybe.push(p);
      else if (giver) { if (!dated && at >= anchor - NO_DATE_DAYS * 86400) out.maybe.push(p); }
      else if (at >= anchor - (dated && !unpaid ? OTHER_NAME_DAYS : SAME_GIVER_DAYS) * 86400) out.maybe.push(p);
    } else if (giver && byHand && !unpaid && near) {
      out.other.push(p);
    }
  }
  // Two checks from one giver, two entries: each takes the nearest
  out.same.sort((a, b) => Math.abs(Number(a.created) - anchor) - Math.abs(Number(b.created) - anchor));
  return out;
}

/** Entries a person said aren't this check are out of it, for good */
function rejectedBy(row) {
  try { return JSON.parse(row.rejected || '[]').map(String); } catch { return []; }
}
const claimedFor = (row, claimed) => new Set([...claimed, ...rejectedBy(row)]);

/** Zeffy entries as the page shows them to a person: never an email or address */
const entriesToShow = (list) => list.slice(0, 5).map((p) => ({ id: String(p.id), name: namesOn(p)[0] || '', cents: Number(p.amount), at: Number(p.created) || 0, form: clean(p.description) }));

/** Zeffy's payments of any status from a Unix time on. A read that runs out of pages throws: part of an answer is no answer */
export async function paymentsSince(env, fromS, fetchImpl = fetch) {
  const out = [];
  let after = null;
  for (let page = 0; page < ZEFFY_PAGES; page++) {
    const r = await zeffyGet(env, '/payments', { 'created[gte]': fromS, limit: 100, starting_after: after }, fetchImpl);
    out.push(...(r?.data || []));
    if (!r?.has_more || !r.next_cursor) return out;
    after = r.next_cursor;
  }
  throw new Error('Zeffy has more payments than the site reads at once');
}

async function claimedIds(DB) {
  const r = await DB.prepare('SELECT zeffy_id FROM check_gifts WHERE zeffy_id IS NOT NULL').all();
  return new Set((r.results || []).map((x) => String(x.zeffy_id)));
}

// ─── Which form ─────────────────────────────────────────────────────

/** Zeffy's open donation forms → [{ id, title }]. Ticketing can't take a check from the site, and a closed form refuses one */
export async function openForms(env, fetchImpl = fetch) {
  const out = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const r = await zeffyGet(env, '/campaigns', { limit: 100, starting_after: after }, fetchImpl);
    for (const c of r?.data || []) {
      if (c.type === 'donation_form' && !c.deleted_at && !c.is_archived && !/draft|closed|archiv|delet|inactive/i.test(String(c.status || ''))) out.push({ id: String(c.id), title: clean(c.title) });
    }
    if (!r?.has_more || !r.next_cursor) return out;
    after = r.next_cursor;
  }
  throw new Error('Zeffy has more campaigns than the site reads at once');
}

const yearIn = (t) => Number((String(t).match(/\b(20\d{2})\b/) || [])[1] || 0);
const newest = (forms) => [...forms].sort((a, b) => yearIn(b.title) - yearIn(a.title))[0] || null;
const wordsOf = (s) => clean(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/'s\b/g, '').split(' ').filter(Boolean);

/** The form a memo names: a word in exactly one form's title that isn't a word in every title */
function memoForm(memo, forms) {
  const words = wordsOf(memo).filter((w) => w.length >= 3 && !TITLE_WORDS.test(w));
  const hits = forms.filter((f) => { const title = wordsOf(f.title); return words.some((w) => title.includes(w)); });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The form for a check, with no setting and no question, and null when nothing fits: the one its memo names; the
 * form this giver's last check went on, or that form's newer year; a foundation's grant form; else the general form.
 */
export function pickForm(row, forms, learned = null) {
  const named = memoForm(row.memo, forms);
  if (named) return named;
  if (learned?.campaign_id) {
    const was = forms.find((f) => f.id === learned.campaign_id);
    if (was) return was;
  }
  if (FOUNDATION.test(row.payer || '')) {
    const grant = newest(forms.filter((f) => /grant funding/i.test(f.title)));
    if (grant) return grant;
  }
  return forms.find((f) => /brighter home/i.test(f.title)) || null;
}

// ─── What this check is ─────────────────────────────────────────────

/**
 * The decision, with nothing read or written → { do: 'link', payment } | { do: 'create', form }
 * | { do: 'person', reason, candidates } | { do: 'left-out', reason }. What Zeffy holds comes first: a hand entry
 * means a person already called it a gift. `gift`: a person said it is one, so the memo and payer are past asking.
 */
export function judge(row, { payments = [], claimed = new Set(), forms = [], learned = null, isVendor = false, gift = false } = {}) {
  const m = matchZeffy(row, payments, claimedFor(row, claimed));
  const show = entriesToShow;
  if (m.same.length) return { do: 'link', payment: m.same[0] };
  if (m.promised.length) return { do: 'person', reason: 'pledge', candidates: show(m.promised) };
  if (m.maybe.length) return { do: 'person', reason: 'maybe-double', candidates: show(m.maybe) };
  if (m.other.length) return { do: 'person', reason: 'amount-differs', candidates: show(m.other) };
  if (!row.payer) return { do: 'person', reason: 'unreadable' };
  const memo = row.memo || '';
  if (!gift) {
    if (OWN.test(row.payer || '')) return { do: 'left-out', reason: 'own' };
    if (REFUND_MEMO.test(memo)) return { do: 'left-out', reason: 'refund' };
    if (NOT_A_GIVER.test(row.payer || '') && !FOUNDATION.test(row.payer || '')) return { do: 'left-out', reason: 'not-a-giver' };
    if (EVENT_MEMO.test(memo)) return { do: 'person', reason: 'event' };
    if (isVendor && !GIFT_MEMO.test(memo)) return { do: 'person', reason: 'vendor' };
  }
  const form = pickForm(row, forms, learned);
  return form ? { do: 'create', form } : { do: 'person', reason: 'no-form' };
}

/** A company SOARD pays, wherever the site knows them from: JobTread, W-9s & insurance, or money sent out of Mercury */
async function isVendor(DB, payer) {
  const key = vendorKey(payer);
  if (!key) return false;
  try { if (await DB.prepare('SELECT 1 AS yes FROM vendors WHERE vkey = ? LIMIT 1').bind(key).first()) return true; } catch { /* not set up here */ }
  try { if (await DB.prepare('SELECT 1 AS yes FROM vendor_papers WHERE vkey = ? LIMIT 1').bind(nameKeyOf(payer)).first()) return true; } catch { /* not set up here */ }
  const paid = (await DB.prepare(`SELECT DISTINCT counterparty FROM mercury_txns WHERE cents < 0 AND counterparty IS NOT NULL LIMIT 5000`).all().catch(() => null))?.results || [];
  return paid.some((r) => vendorKey(r.counterparty) === key);
}

const learnedFor = (DB, payer) => DB.prepare('SELECT * FROM check_payers WHERE key = ?').bind(payerKey(payer)).first();

/** A person's entry (by hand, or confirmed) teaches who this payer is. Money passing through for others teaches nothing */
async function teach(DB, payer, { contactId = null, campaignId = null, by = null }, now) {
  const key = payerKey(payer);
  if (!key || PASS_THROUGH.test(payer) || OWN.test(payer)) return;
  await DB.prepare(`INSERT INTO check_payers (key, name, contact_id, campaign_id, by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, contact_id = COALESCE(excluded.contact_id, contact_id), campaign_id = COALESCE(excluded.campaign_id, campaign_id), by = excluded.by, updated_at = excluded.updated_at`)
    .bind(key, payer, contactId, campaignId, by, new Date(now).toISOString()).run();
}

// ─── Writing the row ────────────────────────────────────────────────

async function setRow(DB, id, patch, now) {
  const fields = { ...patch, updated_at: new Date(now).toISOString() };
  const keys = Object.keys(fields);
  await DB.prepare(`UPDATE check_gifts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map((k) => fields[k]), id).run();
}

const getRow = (DB, id) => DB.prepare('SELECT * FROM check_gifts WHERE id = ?').bind(id).first();

/** Say it once, in Needs attention. It counts as said only when Slack took it, so the next look tries again */
async function tell(env, row, kind, { title, lead, fix = null }) {
  const said = String(row.alerted || '').split(',').filter(Boolean);
  if (said.includes(kind) || !env.SLACK_BOT_TOKEN) return;
  const card = slackCard({
    icon: '🧾', title, lead,
    facts: [['Amount', money(row.cents)], ['From', row.payer || null], ['Deposited', dayOf(row.deposited_at)]],
    fix, buttons: [{ label: 'Open Checks', url: CARDS_URL }],
  });
  const r = await slackIssue(env, `check:${row.id}`, card, { title: `Check for ${money(row.cents)}`, kind: 'attention' }).catch(() => null);
  if (r?.ok) await env.DB.prepare('UPDATE check_gifts SET alerted = ? WHERE id = ?').bind([...said, kind].join(','), row.id).run();
}

async function allClear(env, row, words) {
  if (!env.SLACK_BOT_TOKEN || !row.alerted) return;
  await slackResolved(env, `check:${row.id}`, slackCard({ icon: '✅', title: `Check for ${money(row.cents)}`, lead: words }), { summary: words }).catch(() => null);
}

async function toPerson(env, row, reason, { note = null, candidates = null, mode, now }) {
  await setRow(env.DB, row.id, { state: 'person', reason, note: candidates ? JSON.stringify(candidates) : note }, now);
  if (mode === 'on') await tell(env, row, reason, { title: `A check needs a look: ${money(row.cents)}`, lead: note || REASONS[reason], fix: 'Open Checks in Job Costs.' });
}

// ─── Making the record ──────────────────────────────────────────────

/** A name in Zeffy's two boxes: a one-word company in both, which reads once everywhere (givenName) */
export function nameParts(name) {
  const words = clean(name).split(' ').filter(Boolean);
  return words.length < 2 ? { first_name: words[0] || '', last_name: words[0] || '' } : { first_name: words.slice(0, -1).join(' '), last_name: words.at(-1) };
}

/** The day to put on the record: the one on the check, so a Dec 30 check deposited in January stays in December; never after the deposit, nor one too old to be right */
export function recordDay(row) {
  const deposited = dayOf(row.deposited_at);
  const d = row.check_date;
  if (!isDay(d) || d > deposited) return deposited;
  return Date.parse(`${deposited}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`) > DATED_BACK_MS ? deposited : d;
}

/** Exactly what's sent: tax receipt and email off every time, so nothing here ever reaches a donor */
export function recordFor(row, { name, form, email = null, day = null }) {
  return {
    campaign_id: form.id, amount: Number(row.cents), payment_method: 'cheque', ...nameParts(name),
    ...(email ? { email } : {}),
    generate_tax_receipt: false, send_confirmation_email: false,
    // Noon Eastern, so the day is the same day in every clock Zeffy and the board read it by
    payment_date: `${day || recordDay(row)}T17:00:00.000Z`,
  };
}

/** The learned donor's email, so the gift lands on their record; none for a giver Zeffy has no email for */
async function learnedEmail(env, learned, fetchImpl) {
  if (!learned?.contact_id) return null;
  try { return clean((await zeffyGet(env, `/contacts/${encodeURIComponent(learned.contact_id)}`, {}, fetchImpl))?.email) || null; } catch { return null; }
}

/**
 * One POST for one check. The row is claimed first and the exact record kept on it, so a run cut off here is found by
 * settleUnsure. Zeffy has no way to refuse a repeat: when it may have acted, this never sends it again.
 */
async function createRecord(env, row, record, { from, mode, now, fetchImpl, by = null, learnWith = null }) {
  const iso = new Date(now).toISOString();
  const claim = await env.DB.prepare(`UPDATE check_gifts SET state = 'creating', payload = ?, try_at = ?, updated_at = ? WHERE id = ? AND state = ?`)
    .bind(JSON.stringify(record), iso, iso, row.id, from).run();
  if (!claim.meta?.changes) return { result: 'busy' };
  let p;
  try {
    p = await zeffySend(env, 'POST', '/payments', record, fetchImpl);
  } catch (e) {
    if (e.status === 429) { await setRow(env.DB, row.id, { state: from, payload: null }, now); return { result: 'later' }; }
    if (e.status && e.status < 500) {
      await toPerson(env, { ...row }, 'zeffy-refused', { note: `Zeffy said: ${clean(e.message).slice(0, 200)}`, mode, now });
      await setRow(env.DB, row.id, { payload: null }, now);
      return { result: 'refused', error: e.message };
    }
    // A timeout or a 5xx: it may have saved. settleUnsure looks for it
    await setRow(env.DB, row.id, { state: 'unsure', try_at: iso }, now);
    return { result: 'unsure' };
  }
  await setRow(env.DB, row.id, { state: 'created', via: by ? 'person' : 'site', zeffy_id: String(p.id), reason: null, by, form_id: record.campaign_id, payload: null }, now);
  await teach(env.DB, learnWith?.name || row.payer, { contactId: p.contact || null, campaignId: record.campaign_id, by: by || 'site' }, now);
  await handlePayment(env, p, { via: 'check', now }).catch(() => null);
  await allClear(env, row, 'Saved in Zeffy.');
  return { result: 'created', id: String(p.id) };
}

/** A POST with no answer, or a run cut off mid-POST: if it's in Zeffy it's claimed, and if it never shows, a person looks. Never sent again */
async function settleUnsure(env, { mode, now, fetchImpl }) {
  const stale = new Date(now - CLAIM_MS).toISOString();
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state = 'unsure' OR (state = 'creating' AND updated_at < ?) ORDER BY updated_at LIMIT 3`).bind(stale).all()).results || [];
  for (const row of rows) {
    const sent = (() => { try { return JSON.parse(row.payload || 'null'); } catch { return null; } })();
    const claimed = await claimedIds(env.DB);
    const payments = await paymentsSince(env, secondsOf(dayOf(row.deposited_at)) - LOOK_BACK_S, fetchImpl);
    const name = sent ? clean(`${sent.first_name} ${sent.last_name}`) : row.payer;
    const sentAt = Date.parse(sent?.payment_date || '') / 1000;
    const hit = payments.find((p) => !claimed.has(String(p.id)) && Number(p.amount) === Number(row.cents)
      && String(p.campaign_id) === String(sent?.campaign_id) && namesOn(p).some((n) => sameGiver(name, n) || sameGiver(row.payer, n)) && paidByCheck(p)
      // Last month's gift from the same giver is another gift: only a record dated as this one was sent can be it
      && Math.abs(Number(p.created) - sentAt) <= 2 * 86400);
    if (hit) {
      await setRow(env.DB, row.id, { state: 'created', via: 'site', zeffy_id: String(hit.id), reason: null, payload: null }, now);
      await handlePayment(env, hit, { via: 'check', now }).catch(() => null);
    } else if (now - Date.parse(row.try_at || row.updated_at) > UNSURE_AFTER_MS) {
      await toPerson(env, row, 'unsure', { mode: 'on', now });
    } else if (row.state === 'creating') {
      await setRow(env.DB, row.id, { state: 'unsure' }, now);
    }
  }
}

// ─── The steps ──────────────────────────────────────────────────────

/** New deposits get a row; each one not final is read again by id */
async function pull(env, { now, fetchImpl, cfg }) {
  const iso = new Date(now).toISOString();
  const fresh = (await env.DB.prepare(`SELECT t.id, t.account_id, t.status, t.cents, t.created_at, t.posted_at, t.check_number, t.link FROM mercury_txns t
    LEFT JOIN check_gifts c ON c.id = t.id WHERE t.kind = 'checkDeposit' AND t.cents > 0 AND c.id IS NULL ORDER BY t.created_at LIMIT 25`).all()).results || [];
  if (fresh.length) {
    const buckets = (await readSpendConfig(env.DB).catch(() => ({})))?.accountBuckets || {};
    for (const t of fresh) {
      await env.DB.prepare(`INSERT OR IGNORE INTO check_gifts (id, account_id, status, cents, deposited_at, posted_at, check_number, link, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(t.id, t.account_id, t.status, t.cents, t.created_at, t.posted_at, t.check_number, t.link, buckets[t.account_id] === 'store' ? 'store' : 'new', iso, iso).run();
    }
  }
  const day = new Date(now - REREAD_EVERY_MS).toISOString();
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE final = 0 AND (status != 'sent' OR looked_at IS NULL OR looked_at < ?) ORDER BY looked_at LIMIT 10`).bind(day).all()).results || [];
  let reached = 0;
  let lastError = null;
  for (const row of rows) {
    let txn;
    try { txn = await getTransaction(env, row.id, { fetchImpl }); } catch (e) { lastError = e; continue; }
    reached++;
    await mirrorTransaction(env.DB, txn, { now }).catch(() => null);
    await lookAgain(env, row, txn, { now });
  }
  // Mercury not answering at all stops the alarms above, so the run says so when it ends. The rest of the run goes on
  return rows.length && !reached && lastError?.status !== 404 ? lastError : null;
}

const DEAD = new Set(['cancelled', 'failed', 'reversed', 'blocked']);
const camePayBack = (txn) => (txn?.relatedTransactions || []).some((r) => /^(OriginalTransactionToReturn|ReturnToOriginalTransaction)$/.test(String(r?.relationKind || '')));

async function lookAgain(env, row, txn, { now }) {
  const iso = new Date(now).toISOString();
  const status = String(txn?.status || row.status || '');
  const patch = { status, posted_at: txn?.postedAt || row.posted_at, looked_at: iso };
  // Mercury can correct an amount, and the record has to say what really came in
  if (!row.zeffy_id && Number(txn?.amount) > 0) patch.cents = toCents(txn.amount);
  const back = DEAD.has(status) || camePayBack(txn);
  const known = status === 'pending' || status === 'sent';
  if (back || !known) {
    // Blocked may yet be released, so it's looked at again; the others are the end of it
    // A check a person left out, or the store's, stays what it was: a block lifted later doesn't make it a gift
    const stays = !back || (['left-out', 'store'].includes(row.state) && !row.zeffy_id);
    await setRow(env.DB, row.id, { ...patch, final: back && status !== 'blocked' ? 1 : 0, state: stays ? row.state : 'came-back', reason: stays ? row.reason : 'back' }, now);
    await tell(env, row, back ? 'back' : `status-${status}`, back
      ? { title: `A check came back: ${money(row.cents)}`, lead: row.zeffy_id ? 'Mercury says this check didn’t go through, and Zeffy has a record for it.' : 'Mercury says this check didn’t go through.', fix: 'If it’s in Zeffy, cancel it there. Zeffy tells the donor when you do.' }
      : { title: `A check needs a look: ${money(row.cents)}`, lead: `Mercury shows this check as “${status}”.`, fix: 'Check it in Mercury.' });
    return;
  }
  // A check blocked and then released goes on from where it was
  const revived = row.state === 'came-back' && status === 'sent'
    ? { state: row.zeffy_id ? (row.via === 'hand' ? 'linked' : 'created') : row.payer ? 'read' : 'new', reason: null, tries: 0, try_at: null } : {};
  const posted = patch.posted_at ? Date.parse(patch.posted_at) : 0;
  await setRow(env.DB, row.id, { ...patch, ...revived, final: status === 'sent' && posted && now - posted > FINAL_AFTER_MS ? 1 : 0 }, now);
  if (status === 'pending' && now - Date.parse(row.deposited_at) > PENDING_ALARM_MS) {
    await tell(env, row, 'pending', { title: `A check hasn’t posted: ${money(row.cents)}`, lead: 'Mercury has held this check for two weeks. It usually takes up to 5 business days.', fix: 'Check it in Mercury.' });
  }
}

/** A try counts as it starts, so one Cloudflare cuts short counts too */
async function startTry(DB, row, now) {
  const iso = new Date(now).toISOString();
  const r = await DB.prepare(`UPDATE check_gifts SET tries = tries + 1, try_at = ?, updated_at = ? WHERE id = ? AND state = 'new' AND (try_at IS NULL OR try_at < ?)`)
    .bind(iso, iso, row.id, new Date(now - CLAIM_MS).toISOString()).run();
  return !!r.meta?.changes;
}

/** Read one check's picture. Its answers are used and gone: the row keeps only who, when and what the memo says */
export async function readCheck(env, row, { mode, now, fetchImpl }) {
  if (!(await startTry(env.DB, row, now))) return { result: 'busy' };
  const tries = (row.tries || 0) + 1;
  const txn = await getTransaction(env, row.id, { fetchImpl });
  const files = (txn?.attachments || []).filter((a) => a?.attachmentType === 'checkImage' && a?.url);
  const hint = mercuryPayer(txn);
  const number = clean(txn?.checkNumber || row.check_number);
  if (number !== clean(row.check_number)) await setRow(env.DB, row.id, { check_number: number }, now);

  const done = async (read, shape) => {
    await setRow(env.DB, row.id, { state: 'read', payer: read.payer, check_date: read.date || null, memo: read.memo || null, shape, try_at: null }, now);
    return { result: 'read' };
  };
  const giveUp = async (why, shape) => {
    await setRow(env.DB, row.id, { shape }, now);
    if (tries < READ_TRIES) return { result: 'again' };
    await toPerson(env, row, why, { mode, now });
    return { result: 'person' };
  };

  if (!files.length) {
    const shape = shapeOf(txn, files);
    if (hint) return done({ payer: hint }, shape);
    // Mercury may add the picture once it's reviewed: wait for it while it's pending, then ask
    if (String(txn?.status || row.status) === 'pending') {
      await setRow(env.DB, row.id, { shape, tries: 0 }, now);
      return { result: 'waiting' };
    }
    return giveUp('no-picture', shape);
  }

  const pic = await pictureOf(files, tries, fetchImpl);
  const shape = shapeOf(txn, files, { kind: pic.kind, size: pic.size || null, none: pic.none || null });
  if (pic.none) return hint ? done({ payer: hint }, shape) : giveUp('unreadable', shape);
  let reads;
  try {
    reads = await Promise.all(Object.keys(READERS).map((m) => readWith(env, m, pic.image)));
  } catch (e) {
    if (!aiCapped(e)) throw e;
    await setRow(env.DB, row.id, { tries: Math.max(0, tries - 1) }, now);
    return { result: 'capped' };
  }
  const read = proveRead(reads, { cents: row.cents, checkNumber: number, hint });
  return read.ok ? done(read, shape) : giveUp(read.why, shape);
}

/** What the site would do, kept beside the hand entry so the two can be scored */
const guessOf = (row, v) => JSON.stringify({ do: v.do, reason: v.reason || null, formId: v.form?.id || null, formTitle: v.form?.title || null, payer: row.payer || null });

async function linkTo(env, row, p, { by = null, now }) {
  const iso = new Date(now).toISOString();
  let guess = {};
  try { guess = JSON.parse(row.guess || '{}'); } catch { /* an old row */ }
  const score = guess.do ? JSON.stringify({
    payer: namesOn(p).some((n) => sameGiver(row.payer, n)),
    form: guess.formId ? guess.formId === String(p.campaign_id) : null,
    gift: guess.do === 'create' || guess.do === 'link',
  }) : null;
  try {
    await setRow(env.DB, row.id, {
      state: 'linked', via: by ? 'person' : 'hand', zeffy_id: String(p.id), note: null, by, score,
      payer: row.payer || namesOn(p)[0] || null,
      reason: Number(p.amount) !== Number(row.cents) ? 'amount-off' : String(p.status || '').toLowerCase() === 'succeeded' ? null : 'still-unpaid',
      form_id: String(p.campaign_id || ''), form_title: clean(p.description) || null, updated_at: iso,
    }, now);
  } catch {
    return false; // another check holds that record
  }
  await teach(env.DB, row.payer, { contactId: p.contact || null, campaignId: p.campaign_id || null, by: by || 'hand entry' }, now);
  await allClear(env, row, 'Matched to its Zeffy record.');
  return true;
}

/** A check that's read and posted: link it, make it, or say why not */
export async function decideCheck(env, row, { mode, now, fetchImpl, gift = false }) {
  const [payments, forms, claimed, learned, vendor] = await Promise.all([
    paymentsSince(env, secondsOf(recordDay(row)) - LOOK_BACK_S, fetchImpl),
    openForms(env, fetchImpl),
    claimedIds(env.DB),
    row.payer ? learnedFor(env.DB, row.payer) : null,
    row.payer ? isVendor(env.DB, row.payer) : false,
  ]);
  const v = judge(row, { payments, claimed, forms, learned, isVendor: vendor, gift });
  // What it would have used is worked out even when a hand entry settles it, so the two can be compared
  const guess = guessOf(row, { ...v, form: v.form || (row.payer ? pickForm(row, forms, learned) : null) });
  if (v.do === 'link') {
    await setRow(env.DB, row.id, { guess: row.guess || guess }, now);
    await linkTo(env, { ...row, guess: row.guess || guess }, v.payment, { now });
    return { result: 'linked' };
  }
  await setRow(env.DB, row.id, { guess, form_id: v.form?.id || null, form_title: v.form?.title || null }, now);
  if (v.do === 'left-out') {
    await setRow(env.DB, row.id, { state: 'left-out', reason: v.reason }, now);
    if (mode === 'on') await tell(env, row, 'left-out', { title: `A check was left out of Zeffy: ${money(row.cents)}`, lead: LEFT_OUT[v.reason], fix: 'Nothing to do unless it’s really a gift. Then say so on Checks.' });
    return { result: 'left-out', reason: v.reason };
  }
  if (v.do === 'person') {
    await toPerson(env, row, v.reason, { candidates: v.candidates || null, mode, now });
    return { result: 'person', reason: v.reason };
  }
  if (mode !== 'on') {
    await setRow(env.DB, row.id, { state: 'would' }, now);
    return { result: 'would' };
  }
  // Turned on with a check long posted that nobody entered: a person looks, rather than it going in unseen
  if (row.state === 'would' && now - Date.parse(row.posted_at || row.deposited_at) > OLD_CHECK_MS) {
    await toPerson(env, row, 'old-check', { mode, now });
    return { result: 'person', reason: 'old-check' };
  }
  const email = await learnedEmail(env, learned, fetchImpl);
  const record = recordFor(row, { name: row.payer, form: v.form, email });
  return createRecord(env, row, record, { from: row.state, mode, now, fetchImpl });
}

/** One record against Zeffy now: what it asked staff to fix clears itself once it's fixed, and a record that's gone says so. It's never made again by itself */
async function lookAtRecord(env, row, known, { mode, now, fetchImpl }) {
  let p = known;
  if (!p) {
    try {
      p = await zeffyGet(env, `/payments/${encodeURIComponent(row.zeffy_id)}`, {}, fetchImpl);
    } catch (e) {
      if (e.status !== 404) return; // couldn't tell: the next look can
    }
  }
  const gone = !p || /cancel/.test(String(p.status || '').toLowerCase());
  if (gone && row.state === 'came-back') { await setRow(env.DB, row.id, { zeffy_id: null }, now); await allClear(env, row, 'Cancelled in Zeffy.'); return; }
  if (gone) {
    await toPerson(env, { ...row, alerted: null }, 'record-gone', { mode, now });
    await setRow(env.DB, row.id, { zeffy_id: null, via: null, rejected: JSON.stringify([...rejectedBy(row), String(row.zeffy_id)]) }, now);
    return;
  }
  if (row.state === 'came-back' || !['amount-off', 'still-unpaid'].includes(row.reason)) return;
  const reason = Number(p.amount) !== Number(row.cents) ? 'amount-off' : String(p.status || '').toLowerCase() === 'succeeded' ? null : 'still-unpaid';
  if (reason !== row.reason) await setRow(env.DB, row.id, { reason }, now);
}

/**
 * Once an hour: every check still open against what Zeffy holds now, so a hand entry made since links itself; one under
 * another name is put in front of a person; a record the site made that a person then entered too is flagged; money that
 * went back out for a check is flagged; and a cleared check nobody has entered is said out loud (in Watch nothing else would).
 */
async function matchOpen(env, { mode, now, fetchImpl }) {
  // A check that came back can show as new money going out rather than a change to the deposit
  const held = (await env.DB.prepare(`SELECT c.* FROM check_gifts c WHERE c.zeffy_id IS NOT NULL AND c.final = 0 AND EXISTS (
    SELECT 1 FROM mercury_txns t WHERE t.cents = -c.cents AND t.created_at > c.deposited_at AND t.card_id IS NULL AND t.kind IN ('other', 'checkDeposit')) LIMIT 10`).all()).results || [];
  for (const row of held) await tell(env, row, 'money-out', { title: `A check may have come back: ${money(row.cents)}`, lead: 'The same amount went back out of Mercury after this check. It may have been returned.', fix: 'Check it in Mercury. If it came back, cancel the record in Zeffy.' });

  // Waiting on an entry stays open however old it gets; the rest for the 60 days Mercury is still being watched
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state IN ('would', 'person') OR (state IN ('left-out', 'store', 'created') AND final = 0) ORDER BY deposited_at LIMIT 100`).all()).results || [];
  // A record in Zeffy can change after it's matched: fixed, marked paid, moved or deleted
  const kept = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE zeffy_id IS NOT NULL AND (final = 0 OR state = 'came-back') ORDER BY deposited_at LIMIT 100`).all()).results || [];
  if (!rows.length && !kept.length) return;
  const oldest = Math.min(...[...rows, ...kept].map((r) => secondsOf(recordDay(r))));
  const payments = await paymentsSince(env, oldest - LOOK_BACK_S, fetchImpl);
  const claimed = await claimedIds(env.DB);
  const byId = new Map(payments.map((p) => [String(p.id), p]));
  for (const row of kept) await lookAtRecord(env, row, byId.get(String(row.zeffy_id)) || null, { mode, now, fetchImpl });
  for (const row of rows) {
    // A person said it isn't a gift: nothing here changes that
    if (row.state === 'left-out' && row.reason === 'person') continue;
    const m = matchZeffy(row, payments, claimedFor(row, claimed));
    if (row.state === 'created') {
      if (m.same.length) await tell(env, row, 'double', { title: `This check may be in Zeffy twice: ${money(row.cents)}`, lead: 'The site made a record for this check, and someone entered it by hand too.', fix: 'Delete the extra one in Zeffy. If that record has an email on it, Zeffy may tell the donor, so keep the one with the email.' });
      continue;
    }
    if (row.status === 'sent' && m.same.length && await linkTo(env, row, m.same[0], { now })) { claimed.add(String(m.same[0].id)); continue; }
    if (row.state === 'store') continue;
    // A hand entry under another name: one press from being matched
    const likely = [...m.promised, ...m.maybe, ...m.other];
    if (likely.length && (row.state === 'person' || row.state === 'would')) {
      await setRow(env.DB, row.id, { state: 'person', reason: row.state === 'person' ? row.reason : m.promised.length ? 'pledge' : m.maybe.length ? 'maybe-double' : 'amount-differs', note: JSON.stringify(entriesToShow(likely)) }, now);
      continue;
    }
    // What it was asked about has gone (matched to another check, or deleted): it goes back to being decided
    if (row.state === 'person' && ASKS_ABOUT_ENTRIES.includes(row.reason)) { await setRow(env.DB, row.id, { state: 'read', reason: null, note: null }, now); continue; }
    if (row.state === 'person' && row.note?.startsWith('[')) await setRow(env.DB, row.id, { note: null }, now);
    if (row.state === 'person' && mode === 'on') await tell(env, row, row.reason, { title: `A check needs a look: ${money(row.cents)}`, lead: REASONS[row.reason] || '', fix: 'Open Checks in Job Costs.' });
    const posted = Date.parse(row.posted_at || row.deposited_at);
    if (row.state !== 'left-out' && row.status === 'sent' && now - posted > NO_RECORD_ALARM_MS) {
      await tell(env, row, 'no-record', { title: `A check isn’t in Zeffy: ${money(row.cents)}`, lead: 'This check posted more than 10 days ago and Zeffy has no record of it.', fix: 'Enter it in Zeffy, or say why not on Checks.' });
    }
  }
}

/** The one-time test of writing to Zeffy: three $1 records, read back and removed, so turning this on isn't the first write */
export async function testWrite(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const at = new Date(now).toISOString();
  const report = { id: WRITE_TEST, at, ok: false, steps: [] };
  const made = [];
  try {
    const forms = await openForms(env, fetchImpl);
    const form = forms.find((f) => /brighter home/i.test(f.title));
    if (!form) throw new Error('No open Help Build a Brighter Home form to test on');
    const base = { campaign_id: form.id, amount: 100, payment_method: 'cheque', generate_tax_receipt: false, send_confirmation_email: false };
    for (const [what, name] of [['two names', WRITE_TEST_NAME], ['the same two names', WRITE_TEST_NAME], ['one word', { first_name: WRITE_TEST_ONE_WORD, last_name: WRITE_TEST_ONE_WORD }]]) {
      const p = await zeffySend(env, 'POST', '/payments', { ...base, ...name }, fetchImpl);
      made.push(p);
      report.steps.push({ what, type: p.type || null, method: p.payment_method?.type || null, status: p.status || null, hasContact: !!p.contact, receipt: !!p.receipt_url });
    }
    report.sameContact = !!made[0].contact && made[0].contact === made[1].contact;
    if (made.some((p) => p.type === 'imported')) throw new Error('Zeffy marks these records as imported, so Slack and the board would skip them');
    report.ok = true;
  } catch (e) {
    report.error = clean(e.message).slice(0, 200);
    report.status = e.status || null;
  }
  // Nothing is left behind if Zeffy lets it go. The site never deletes anything else, so a refusal doesn't stop it working:
  // it asks a person to take the $1 records out by hand, and sees when they're gone
  const left = [];
  const contacts = new Set();
  for (const p of made) {
    try {
      await zeffySend(env, 'DELETE', `/payments/${encodeURIComponent(p.id)}`, null, fetchImpl);
      if (p.contact) contacts.add(p.contact);
    } catch {
      left.push(String(p.id));
    }
  }
  report.removed = !left.length;
  report.leftBehind = left;
  // Only a contact this test made: never one holding a real gift
  for (const id of contacts) {
    const c = await zeffyGet(env, `/contacts/${encodeURIComponent(id)}`, {}, fetchImpl).catch(() => null);
    const test = [WRITE_TEST_NAME.last_name, WRITE_TEST_ONE_WORD].includes(clean(c?.last_name));
    if (test && !Number(c?.donation_count)) await zeffySend(env, 'DELETE', `/contacts/${encodeURIComponent(id)}`, null, fetchImpl).catch(() => null);
  }
  await writeState(env.DB, KEY, { writeTest: report });
  return report;
}

/** Test records a person was asked to remove: once they're gone, the page stops asking */
async function lookForLeftovers(env, test, fetchImpl) {
  const still = [];
  for (const id of test.leftBehind) {
    try { await zeffyGet(env, `/payments/${encodeURIComponent(id)}`, {}, fetchImpl); still.push(id); } catch (e) { if (e.status !== 404) still.push(id); }
  }
  if (still.length !== test.leftBehind.length) await writeState(env.DB, KEY, { writeTest: { ...test, leftBehind: still, removed: !still.length } });
}

export async function runChecks(env, { now = Date.now(), fetchImpl = fetch, cfg = null } = {}) {
  await ensureChecks(env.DB);
  cfg ||= await readState(env.DB, KEY);
  const mode = cfg.mode === 'on' ? 'on' : 'watch';
  const ctx = { now, fetchImpl, mode, cfg };
  // A failed test tries again a day later, once nothing of it is left for a person to remove
  const test = cfg.writeTest;
  const again = test && !test.ok && !test.leftBehind?.length && now - Date.parse(test.at || 0) > DAY;
  if (test?.id !== WRITE_TEST || again) return { writeTest: await testWrite(env, ctx) };
  const mercuryDown = await pull(env, ctx);
  await settleUnsure(env, ctx);
  if (now - Date.parse(cfg.lastMatchAt || 0) >= MATCH_EVERY_MS) {
    await writeState(env.DB, KEY, { lastMatchAt: new Date(now).toISOString() });
    await matchOpen(env, ctx);
    if (test?.leftBehind?.length) await lookForLeftovers(env, test, fetchImpl);
  }
  // One big job a run: a check waiting to be decided, else one to read
  // Turned on: what it was only watching goes on too, the same way, one a run, each read against Zeffy again
  const ready = await env.DB.prepare(`SELECT * FROM check_gifts WHERE (state = 'read' OR (state = 'would' AND ? = 'on')) AND status = 'sent' ORDER BY deposited_at LIMIT 1`).bind(mode).first();
  let done = { result: 'quiet' };
  if (ready) done = await decideCheck(env, ready, ctx);
  else {
    // Never tried first, then whichever was tried longest ago, so one check that can't be read never holds up the rest
    const next = await env.DB.prepare(`SELECT * FROM check_gifts WHERE state = 'new' AND status NOT IN ('cancelled', 'failed', 'reversed', 'blocked') AND (try_at IS NULL OR try_at < ?)
      ORDER BY try_at IS NOT NULL, try_at, deposited_at LIMIT 1`).bind(new Date(now - CLAIM_MS).toISOString()).first();
    if (next && (next.tries || 0) >= READ_TRIES) {
      // Runs cut short never reach the limit inside a read, so it's checked before one starts
      await toPerson(env, next, 'unreadable', { mode, now });
      done = { result: 'person' };
    } else if (next) {
      try {
        done = await readCheck(env, next, ctx);
      } catch (e) {
        if ((next.tries || 0) + 1 < READ_TRIES) throw e;
        await toPerson(env, next, 'unreadable', { mode, now });
        done = { result: 'person' };
      }
    }
  }
  if (mercuryDown) throw mercuryDown;
  return done;
}

/** The heartbeat's call. Costs one state read when there's nothing to do */
export async function maybeRunChecks(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!env.DB || !mercuryConfigured(env) || !String(env.ZEFFY_API_KEY || '').trim()) return null;
    const cfg = await readState(env.DB, KEY);
    if (now - Date.parse(cfg.lastRunAt || 0) < RUN_EVERY_MS) return null;
    await writeState(env.DB, KEY, { lastRunAt: new Date(now).toISOString() });
    const r = await runChecks(env, { now, fetchImpl, cfg });
    if (cfg.lastError) await writeState(env.DB, KEY, { lastError: null });
    return r;
  } catch (e) {
    await writeState(env.DB, KEY, { lastError: { at: new Date(now).toISOString(), error: clean(e.message).slice(0, 200) } }).catch(() => null);
    return null;
  }
}

// ─── The page ───────────────────────────────────────────────────────

function viewOf(r, claimed) {
  let candidates = null;
  let score = null;
  try { candidates = r.reason && r.note?.startsWith('[') ? JSON.parse(r.note).filter((c) => !claimed.has(String(c.id))) : null; } catch { /* words, not a list */ }
  try { score = r.score ? JSON.parse(r.score) : null; } catch { /* an old row */ }
  const waitingOnZeffy = r.state === 'unsure' || r.state === 'creating';
  const why = waitingOnZeffy ? 'Zeffy didn’t answer yet. The site is looking for the record, so don’t enter this one.'
    : r.state === 'came-back' && r.zeffy_id ? 'The check came back. Cancel the record in Zeffy, and Zeffy tells the donor.'
    : r.state === 'left-out' || r.state === 'came-back' ? LEFT_OUT[r.reason] || REASONS[r.reason] || null
    : REASONS[r.reason] || null;
  return {
    id: r.id, cents: r.cents, status: r.status, state: r.state, depositedAt: r.deposited_at, depositDay: dayOf(r.deposited_at), postedAt: r.posted_at,
    payer: r.payer || '', checkDate: r.check_date || '', memo: r.memo || '', checkNumber: r.check_number || '',
    formId: r.form_id || '', formTitle: r.form_title || '', via: r.via || null, by: r.by || null, zeffyId: r.zeffy_id || null, link: r.link || null,
    reason: r.reason || null, why, note: r.note?.startsWith('[') ? null : r.note || null, candidates: candidates?.length ? candidates : null, score,
  };
}

/** Everything the Checks tab shows, and how Watch is doing */
export async function checksView(env) {
  await ensureChecks(env.DB);
  const cfg = await readState(env.DB, KEY);
  // What waits on someone comes first, so the limit can never push it off the page
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts ORDER BY (state = 'person') DESC, deposited_at DESC LIMIT ?`).bind(LIST_LIMIT).all()).results || [];
  const claimed = new Set(rows.map((r) => r.zeffy_id).filter(Boolean).map(String));
  const list = rows.map((r) => viewOf(r, claimed));
  const scored = list.filter((c) => c.score);
  return {
    mode: cfg.mode === 'on' ? 'on' : 'watch',
    onBy: cfg.onBy || null, onAt: cfg.onAt || null,
    writeTest: cfg.writeTest || null,
    lastError: cfg.lastError || null,
    list,
    limited: rows.length === LIST_LIMIT,
    waiting: list.filter((c) => c.state === 'person').length,
    scored: { total: scored.length, right: scored.filter((c) => c.score.payer && c.score.gift && c.score.form !== false).length },
    zeffyUrl: ZEFFY_PAYMENTS,
    configured: { mercury: mercuryConfigured(env), zeffy: !!String(env.ZEFFY_API_KEY || '').trim(), ai: !!env.AI },
  };
}

/** For the Automations map: times and counts only */
export async function checksFacts(DB) {
  await ensureChecks(DB);
  const cfg = await readState(DB, KEY);
  const on = cfg.mode === 'on';
  // While it's watching staff enter these anyway: only a question about a Zeffy entry waits on someone
  const c = await DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'person' AND (? = 'on' OR note LIKE '[%') THEN 1 ELSE 0 END) AS waiting, MAX(deposited_at) AS last FROM check_gifts`).bind(on ? 'on' : 'watch').first();
  return { mode: on ? 'on' : 'watch', lastRunAt: cfg.lastRunAt || null, error: cfg.lastError?.error || null, total: c?.total || 0, waiting: c?.waiting || 0, last: c?.last || null, writeOk: cfg.writeTest ? !!cfg.writeTest.ok : null };
}

const err = (message, status = 400) => Object.assign(new Error(message), { status });

async function mustRow(env, id) {
  await ensureChecks(env.DB);
  const row = await getRow(env.DB, id);
  if (!row) throw err('That check isn’t on the list', 404);
  return row;
}

/** Watch or On. On needs the write test passed: a person turning it on is telling staff to stop entering these */
export async function setMode(env, mode, { by = null, now = Date.now() } = {}) {
  const cfg = await readState(env.DB, KEY);
  if (mode === 'on' && !cfg.writeTest?.ok) throw err('The site hasn’t proven it can write to Zeffy yet.', 409);
  return writeState(env.DB, KEY, { mode: mode === 'on' ? 'on' : 'watch', onBy: mode === 'on' ? by : null, onAt: mode === 'on' ? new Date(now).toISOString() : null });
}

/**
 * A person fills in what the site couldn't. Zeffy is read again first: an entry made since is linked, not doubled, unless the
 * person is looking right at what the page showed them and says it's another gift (notThose).
 */
export async function personCreate(env, id, { name, formId, day = null, notThose = false, by = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const row = await mustRow(env, id);
  const cfg = await readState(env.DB, KEY);
  if (cfg.mode !== 'on') throw err('The site is watching, so enter this one in Zeffy by hand.', 409);
  if (!['person', 'left-out', 'store', 'would'].includes(row.state)) throw err('This check has moved on. Look again.', 409);
  const payer = safeText(name, 120, row.check_number);
  if (!payer) throw err('Who wrote this check?');
  if (day != null) {
    const deposited = dayOf(row.deposited_at);
    const tooOld = isDay(day) && Date.parse(`${deposited}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`) > 366 * DAY;
    if (!isDay(day) || day > deposited || tooOld) throw err('That date doesn’t look right. It can’t be after the check was deposited.');
  }
  let forms;
  let payments;
  let claimed;
  try {
    forms = await openForms(env, fetchImpl);
    payments = await paymentsSince(env, secondsOf(recordDay(row)) - LOOK_BACK_S, fetchImpl);
    claimed = await claimedIds(env.DB);
  } catch {
    throw err('Zeffy didn’t answer, so nothing was saved. Try again in a minute.', 503);
  }
  const form = forms.find((f) => f.id === formId);
  if (!form) throw err('Pick an open donation form.');
  const seen = { ...row, payer, form_id: form.id, form_title: form.title };
  const m = matchZeffy(seen, payments, claimedFor(seen, claimed));
  if (m.same.length) {
    await linkTo(env, seen, m.same[0], { by, now });
    return { result: 'linked' };
  }
  const likely = [...m.promised, ...m.maybe, ...m.other];
  if (likely.length && !notThose) {
    await setRow(env.DB, id, { state: 'person', payer, form_id: form.id, form_title: form.title, reason: m.promised.length ? 'pledge' : m.maybe.length ? 'maybe-double' : 'amount-differs', note: JSON.stringify(entriesToShow(likely)) }, now);
    throw err('Zeffy has an entry that may be this check. Look at it first.', 409);
  }
  await setRow(env.DB, id, { payer, form_id: form.id, form_title: form.title }, now);
  const learned = await learnedFor(env.DB, payer);
  const email = await learnedEmail(env, learned, fetchImpl);
  const record = recordFor(seen, { name: payer, form, email, day });
  const r = await createRecord(env, seen, record, { from: row.state, mode: 'on', now, fetchImpl, by, learnWith: { name: payer } });
  if (r.result === 'later') throw err('Zeffy is busy, so nothing was saved. Try again in a minute.', 503);
  if (r.result === 'refused') throw err(`Zeffy said: ${clean(r.error).slice(0, 200)}`, 422);
  if (r.result === 'unsure') throw err('Zeffy didn’t answer. The site is looking for the record, so don’t enter this one again.', 503);
  if (r.result === 'busy') throw err('This check has moved on. Look again.', 409);
  return r;
}

/** A person says this check is that Zeffy entry */
export async function personLink(env, id, zeffyId, { by = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const row = await mustRow(env, id);
  if (row.zeffy_id) throw err('This check already has its Zeffy record.', 409);
  const p = await zeffyGet(env, `/payments/${encodeURIComponent(zeffyId)}`, {}, fetchImpl);
  if (await env.DB.prepare('SELECT id FROM check_gifts WHERE zeffy_id = ?').bind(String(p.id)).first()) throw err('Another check already has that Zeffy record.', 409);
  if (!(await linkTo(env, row, p, { by, now }))) throw err('Another check already has that Zeffy record.', 409);
  return { result: 'linked' };
}

/** A person says the matched entry isn't this check: it comes off, never gets offered again, and the check is decided afresh */
export async function personUnlink(env, id, { by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id);
  if (row.state !== 'linked' || !row.zeffy_id) throw err('Only a matched entry can be taken off.', 409);
  let read = {};
  try { read = JSON.parse(row.guess || '{}'); } catch { /* an old row */ }
  // The name may have come from that entry: what was read off the check is what stands
  const payer = read.payer || null;
  await setRow(env.DB, id, {
    state: payer ? 'read' : 'person', reason: payer ? null : 'unreadable', payer, zeffy_id: null, via: null, score: null, by,
    rejected: JSON.stringify([...rejectedBy(row), String(row.zeffy_id)]),
  }, now);
  if (row.payer) await env.DB.prepare('DELETE FROM check_payers WHERE key = ?').bind(payerKey(row.payer)).run();
  return { result: 'unlinked' };
}

/** While watching, a person takes back "not a gift": it waits for the hand entry again */
export async function personIsGift(env, id, { by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id);
  if (!['left-out', 'store'].includes(row.state)) throw err('This check has moved on. Look again.', 409);
  await setRow(env.DB, id, { state: 'person', reason: 'told-gift', note: null, by }, now);
  return { result: 'waiting' };
}

/** A person says this isn't a gift */
export async function personNotGift(env, id, { by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id);
  if (row.zeffy_id) throw err('This check has a Zeffy record. Delete it in Zeffy first, and this page catches up within the hour.', 409);
  await setRow(env.DB, id, { state: 'left-out', reason: 'person', note: null, by }, now);
  await allClear(env, row, 'Left out: not a gift.');
  return { result: 'left-out' };
}
