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
 * Peter, Nov 10 2026: "we need to capture their address that is on the
 * check", and a letter the team attaches in Mercury after the deposit "is the
 * source of truth" for who the gift is recorded as and where its receipt goes.
 * So a check waits until 7 PM Eastern on the day it's deposited (saveAt), the
 * letter is read the way the check is (two readers that must agree), and the
 * gift goes in under the letter's name. The address (the letter's, else the
 * one printed on the check) goes on the donor's Zeffy contact once the record
 * is there, and only on a contact that is surely the giver's (writeAddresses).
 * Letters steer only checks the site is still deciding: a file added after
 * the record is in Zeffy changes nothing by itself and is a person's to look
 * at, because Zeffy can't move a payment and the site never deletes one.
 *
 * Peter, Nov 10 2026 (later): only a check marked as a contribution in
 * Mercury's Category ("Individual Contribution", "Contribution") goes into
 * Zeffy. One with no category waits for it; any other category is left out.
 * A gift through a giving platform or donor-advised fund goes under the donor
 * its sheet names ("they should go under donor name").
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
import { pageText, scannedPages } from './_vendor-read.js';
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
const LATE_DAYS = 120;             // a hand entry this long after the deposit is put to a person, not linked
const MATCH_MAX_AGE_MS = 150 * DAY; // the hourly look stops at checks deposited this long ago, so its read of Zeffy stays whole
const WRITE_TRIES = 3;             // a write test that keeps failing stops trying after this many days
const ZEFFY_PAGES = 30;
const LIST_LIMIT = 300;
/** Each day's checks go into Zeffy at 7 PM Eastern, so a letter attached in Mercury that day is read with its check (Peter, Nov 10) */
const SAVE_HOUR = 19;
const SAVE_GAP_MS = 60 * MIN;      // a check deposited in the hour before 7 PM waits for the next evening, so its letter has time
const LETTER_TRIES = 3;            // a letter file that can't be fetched or read this many times goes to a person
const MAX_LETTER_FILES = 4;        // more files than this beside one check: a person looks
const ADDRESS_RETRY_MS = 15 * MIN; // Zeffy not answering about an address: tried again after this
const ADDRESS_GIVE_UP_MS = DAY;    // and after this long of it, a person adds it

/** The one-time test of writing to Zeffy: a new id runs it once more on the next heartbeat. Nov 7 added keeping a giver's gifts on one contact; Nov 10 an address on a contact */
export const WRITE_TEST = '2026-11-10';

/** A mail domain with no mail server: an address here reaches no one, so it can sit on a donor's contact for the seconds a record takes */
export const TAG_DOMAIN = 'nomail.soardcharity.com';
const isTag = (email) => clean(email).toLowerCase().endsWith(`@${TAG_DOMAIN}`);
export const tagFor = (id, now) => `check-${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}-${Number(now).toString(36)}@${TAG_DOMAIN}`;
const TAG_ALARM_MS = DAY;          // an address the site couldn't take off a donor's contact for this long goes to a person
/** The write test's one record with an email: a SOARD inbox, so anyone can see that Zeffy sent nothing with receipts and emails off */
export const WRITE_TEST_EMAIL = 'peter+zeffy-write-test@soardcharity.com';
/** The write test's address: made up, on a test contact that's removed straight after */
const WRITE_TEST_ADDRESS = { line1: '1 Test Way', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' };

const CARDS_URL = `${SITE_ORIGIN}/admin/#job-costs/checks`;
const ZEFFY_PAYMENTS = 'https://www.zeffy.com/en-US/o/all-payments';
const ZEFFY_CONTACTS = 'https://www.zeffy.com/en-US/o/crm/contacts';

/** Why a check is with a person, in the words the page and Slack use. Nothing else stops a check */
export const REASONS = {
  'no-picture': 'Mercury has no picture of this check, so the site can’t tell who wrote it.',
  unreadable: 'The site couldn’t read who wrote this check.',
  'maybe-double': 'Zeffy already has an entry for this amount under another name. It may be this check.',
  'amount-differs': 'Zeffy has an entry from this giver around this date for a different amount.',
  pledge: 'This giver has an unpaid pledge or check promise in Zeffy. It may be what this check pays.',
  event: 'The memo points to an event or a group’s campaign. Zeffy takes those only by hand.',
  vendor: 'SOARD pays this company, and nothing says if this is a refund or a gift.',
  'no-form': 'No open Zeffy donation form fitted this check when the site looked. Pick one.',
  'zeffy-refused': 'Zeffy didn’t take this record when it was saved.',
  unsure: 'Zeffy didn’t answer when the site saved this, and the record hasn’t shown up. If it isn’t in Zeffy, save it again.',
  'zeffy-busy': 'Zeffy kept saying to wait on this giver for a day.',
  redeposit: 'Another deposit has the same check number and amount. If it’s the same check deposited again, it isn’t a new gift: say so here. If the first deposit came back, match this one to its Zeffy record.',
  'look-by-hand': 'Zeffy has more payments than the site can look through at once, so it can’t be sure this check isn’t there already. Look in Zeffy, then save it or match it here.',
  'told-gift': 'A person said this is a gift.',
  'record-gone': 'This check’s Zeffy record is gone. Save it again if it should be there, or say it isn’t a gift.',
  'old-check': 'This check posted a while ago and Zeffy has no record of it. Save it, or say it isn’t a gift.',
  bank: 'This check shows a bank’s name, not who paid. It’s likely a cashier’s check, so look at it in Mercury for who sent it.',
  unlinked: 'A person said the matched Zeffy entry isn’t this check.',
  'amount-off': 'Zeffy’s entry and the check are for different amounts. Fix the amount in Zeffy.',
  'still-unpaid': 'Zeffy still shows this entry as unpaid. Mark it paid in Zeffy.',
  letter: 'A letter came with this check in Mercury, and the site couldn’t read whose gift it says it is. Look at it in Mercury.',
  'letter-amount': 'The letter that came with this check is for a different amount. Look at it in Mercury.',
  'letter-many': 'More files came with this check in Mercury than the site reads. Look at them in Mercury.',
  'letter-name': 'A letter added in Mercury after this check was saved says the gift is from someone else.',
};
const ASKS_ABOUT_ENTRIES = ['maybe-double', 'amount-differs', 'pledge'];

/**
 * Mercury's Category that says a deposit is a gift (Peter, Nov 10): Individual Contribution, Corporate Contribution, Grant.
 * Event & Sponsorship, Refund / Reimbursement and everything else stay out of Zeffy
 */
const GIFT_CATEGORY = /\b(contributions?|grants?)\b/i;
export const isContribution = (category) => GIFT_CATEGORY.test(clean(category));
/** A check marked Grant in Mercury goes on the newest Grant Funding form */
const GRANT_CATEGORY = /\bgrants?\b/i;
const GIFT_WORDS = 'Individual Contribution, Corporate Contribution or Grant';
/** A check's Category in Mercury: from the transaction when the site has it in hand, else as last mirrored */
async function categoryOf(env, row, txn = null) {
  if (txn && 'categoryData' in txn) return clean(txn.categoryData?.name);
  const t = await env.DB.prepare('SELECT category_name FROM mercury_txns WHERE id = ?').bind(row.id).first().catch(() => null);
  return clean(t?.category_name);
}

/** Left out on purpose, without a person: not gifts. Each still says so on the page */
export const LEFT_OUT = {
  own: 'This looks like SOARD’s own money.',
  refund: 'The memo says this is a refund or reimbursement.',
  'not-a-giver': 'This looks like insurance or a tax payment, not a gift.',
  person: 'A person said this isn’t a gift.',
  category: 'Its Category in Mercury isn’t a gift (Individual Contribution, Corporate Contribution or Grant), so it stays out of Zeffy. Change it in Mercury if it’s a gift.',
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
      street: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, zip: { type: 'string' },
    },
    required: ['payer', 'remitter', 'cashiersCheck', 'payee', 'date', 'amount', 'checkNumber', 'memo', 'street', 'city', 'state', 'zip'],
  },
};

const READ_PROMPT = `You read one photo of a paper check made out to a charity. Report only what is written on the check, as JSON.
payer: who wrote the check, the printed or written name in the top left corner. A person, a couple, a company or a foundation. The name only: its address goes in the four fields below, and never the phone. "" if you can't read it.
street, city, state, zip: the payer's mailing address printed under their name in the top left corner, in its parts: the street line with any apartment or suite, the city, the two-letter state, and the ZIP code. "" for any part that isn't printed there. Never the bank's address, and never anything from another part of the check.
remitter: on a cashier's check or money order, the person it was bought for, often beside "Remitter", "Purchaser" or "Sent by". Otherwise "".
cashiersCheck: true for a cashier's check, official check, bank check or money order.
payee: the name after "Pay to the order of".
date: the date written on the check as YYYY-MM-DD, or "" if you can't read it.
amount: the amount in dollars as a number, from the box of digits. 0 if you can't read it.
checkNumber: the check number printed in the top right corner, or "".
memo: the words on the memo or "for" line, as written, or "".
Never copy the long row of digits along the bottom edge of the check, and never copy a routing number or account number anywhere. If you can't read a field, leave it empty. Don't guess.`;

// A page the team attaches to the deposit in Mercury after the check (Peter, Nov 10): the source of truth for who it's from
const LETTER_SCHEMA = {
  name: 'letter',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      aboutGift: { type: 'boolean' }, recordAs: { type: 'string' }, email: { type: 'string' },
      street: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, zip: { type: 'string' }, amount: { type: 'number' },
    },
    required: ['aboutGift', 'recordAs', 'email', 'street', 'city', 'state', 'zip', 'amount'],
  },
};

const LETTER_PROMPT = `You read one page that came with a check given to a charity, Sunshine on a Ranney Day (SOARD). Report only what is written on it, as JSON.
aboutGift: true when it's a letter or note about a gift to the charity: a cover letter, a donor-advised fund or foundation grant letter, a matching-gift letter, or a note saying who the gift is from or where to send its receipt. false for anything else, such as an invoice, a bill, a form, a deposit slip, or a picture of the check or an envelope.
recordAs: the donor to record the gift under. The name the page says to record, credit or acknowledge it under; else the donor it names ("Donor:", "donation from", "on behalf of"); else who it says the gift is from. When the money comes through a giving platform, donor-advised fund, workplace giving or matching program (such as Groundswell, Chariot, Fidelity Charitable, Schwab Charitable, Benevity) for a donor it names, that donor, never the platform or fund. A foundation or company giving its own money is the donor itself: a director or employee named only as recommending, approving or signing it, or as who to contact, is not. Never the charity. "" if it doesn't name one.
email: the email the page says to send the receipt, acknowledgment or correspondence to, else the donor's email it gives. "" if none.
street, city, state, zip: the mailing address the page says to send the receipt, acknowledgment or correspondence to, else the donor's own address it gives, in its parts (the street line with any apartment or suite, the city, the two-letter state, the ZIP code). Never the charity's address, which is usually in the "To" lines at the top. "" for any part that isn't there.
amount: the gift's amount in dollars as the page gives it, or 0.
Never copy an account, grant, routing or phone number. If you can't read a field, leave it empty. Don't guess.`;

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
  // Every Zeffy payment the site has read, with when it first showed up and when it turned paid (unix seconds). Zeffy
  // gives only the day a payment is for, so this is the one sign of when an entry was typed or a pledge marked paid
  `CREATE TABLE IF NOT EXISTS zeffy_seen (payment_id TEXT PRIMARY KEY, status TEXT, first_seen INTEGER NOT NULL, paid_seen INTEGER)`,
  // A no-mail address the site put on a donor's contact, kept until it's off again (see postJoined). One a contact: it's also
  // the lock that keeps two saves from filing under one contact at once
  `CREATE TABLE IF NOT EXISTS check_tags (
    contact TEXT PRIMARY KEY, email TEXT NOT NULL, check_id TEXT, at TEXT NOT NULL, alerted INTEGER NOT NULL DEFAULT 0)`,
];
// Added Nov 10 2026, for the address and the letter. letter: what the files beside the check said (JSON, see readLetter).
// address: the address printed on the check (JSON, `for` = who wrote it). drawer: who wrote the check (payer is who the gift
// is from). address_done: what became of the address in Zeffy; address_at: its last try; address_tried: what it tried to put on whom
const ADDED = ['letter TEXT', 'address TEXT', 'drawer TEXT', 'address_done TEXT', 'address_at TEXT', 'address_tried TEXT'];

const _ready = new WeakSet();
export async function ensureChecks(DB) {
  if (_ready.has(DB)) return;
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  const have = new Set(((await DB.prepare('PRAGMA table_info(check_gifts)').all()).results || []).map((c) => c.name));
  for (const col of ADDED) {
    if (have.has(col.split(' ')[0])) continue;
    // Two runs adding it at once: the second one's "duplicate column" is the column being there
    try { await DB.prepare(`ALTER TABLE check_gifts ADD COLUMN ${col}`).run(); } catch (e) { if (!/duplicate column/i.test(String(e?.message))) throw e; }
  }
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
  if (!t || /\p{Ll}/u.test(t)) return t;
  return t.toLowerCase().replace(/\p{Ll}[\p{Ll}'’]*/gu, (w) => (w === 'inc' ? 'Inc' : KEEP_CAPS.test(w) ? w.toUpperCase() : /^(of|the|and|for)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    // Only "c/o" is written small: a middle initial C or O is a capital
    .replace(/\bC\s*\/\s*O\b/g, 'c/o')
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}
const KEEP_CAPS = /^(llc|llp|lp|pc|pllc|pa|cpa|dds|md|dba|usa|ymca|ywca|ups|ncf|ibm|ii|iii|iv)$/;

/** A giver's name to compare: "c/o" and what follows, The, LLC and punctuation gone, a name typed twice once */
export function payerKey(name) {
  // José on the check and Jose typed in Zeffy are one name
  const words = clean(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bc\s*\/\s*o\b.*$|\bc o\b.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|and|inc|incorporated|llc|ltd|lp|llp|corp|corporation|company)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const half = words.length / 2;
  if (words.length > 1 && Number.isInteger(half) && words.slice(0, half).join(' ') === words.slice(half).join(' ')) return words.slice(0, half).join(' ');
  return words.join(' ');
}

// Words a giver's name gains or loses without being someone else: Pine Foundation is Pine Family Foundation, Oakline is Oakline Design Build
const NAME_FILLER = new Set(['family', 'foundation', 'fund', 'trust', 'charitable', 'giving', 'group', 'co', 'design', 'build', 'builders', 'building', 'construction', 'services', 'enterprises', 'holdings', 'of', 'for', 'mr', 'mrs', 'ms', 'dr']);

/**
 * The same giver for sure: the same name, J. Smith and John Smith, or one name holding the other with only filler words
 * added. Atlanta Rotary Club and North Atlanta Rotary Club are not: that's sameGiver, which only ever puts it to a person
 */
export function surelySameGiver(a, b) {
  const ka = payerKey(a);
  const kb = payerKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const wa = ka.split(' ');
  const wb = kb.split(' ');
  const [few, many] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (few.length >= 2 && few.at(-1) === many.at(-1) && few[0][0] === many[0][0] && (few[0].length === 1 || many[0].length === 1) && few.length === many.length) return true;
  return few.join('').length >= 4 && few.every((w) => many.includes(w)) && many.filter((w) => !few.includes(w)).every((w) => NAME_FILLER.has(w));
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
const PASS_THROUGH = /\b(bank|credit union|truist|wells fargo|jp ?morgan chase|chase bank|regions bank|synovus|pnc|fidelity charitable|fidelity investments|schwab|vanguard|national philanthropic|national christian|ncf|dafgiving360|american endowment|renaissance charitable|donor.?advised|benevity|yourcause|cybergrants|network for good|america'?s charities|paypal giving|united way|community foundation|ameriprise|edward jones|morgan stanley|raymond james|merrill lynch|merrill edge|pershing|goldman sachs|j\.?\s?p\.? morgan|ubs financial|lpl financial|tiaa|stifel|blackbaud|givinga|brightfunds|charities aid|charitable gift fund|giving fund)\b/i;
/** A bank's own name where the giver's should be: a cashier's check, or the bank Mercury names */
const BANK = /\b(bank|banking|credit union|truist|wells fargo|jp ?morgan chase|chase bank|regions bank|synovus|pnc|suntrust|bb ?& ?t|fifth third|navy federal|ameris)\b/i;
const isBank = (name) => BANK.test(name || '') && !FOUNDATION.test(name || '');
const REFUND_MEMO = /\b(refund\w*|reimburs\w*|rebate\w*|overpay\w*|credit memo|deposit return|return(ed)? deposit|insurance claim|claim)\b/i;
const EVENT_MEMO = /\b(golf|gala|tables?|tickets?|auction|foursome|fairway|raffle|banquet|tee|sponsor\w*|advisor\w*|advisory)\b/i;
const GIFT_MEMO = /\b(donat\w*|gift|contribut\w*|match\w*|charit\w*|support)\b/i;
// Words in many a form's title: a memo saying one of them says nothing about which form
const TITLE_WORDS = /^(help|build|building|brighter|home|homes|room|rooms|bedroom|therapy|bathroom|funding|grant|sunshine|ranney|donation|donations|their|tomorrow|kids|kid|child|make|makeover|give|gift|your|with|from|that|this|2\d{3})$/;

/** Mercury's own name for who paid, when it's a name: a deposit may say only "Check" */
export function mercuryPayer(txn) {
  const name = safeText(txn?.counterpartyName || '', 120, txn?.checkNumber);
  if (!name || OWN.test(name) || isBank(name) || /^(mobile |check|cheque|deposit|remote|incoming|unknown|mercury)\b/i.test(name)) return '';
  return name;
}

// ─── Reading the picture ────────────────────────────────────────────

const timed = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
};

// A reader that errored, rather than one that answered with nothing: an outage, which never spends a check's try
const DOWN = Symbol('down');

/** One model's reading, or null; DOWN when it errored. A spending cap is thrown, so the check waits without spending a try */
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
    return DOWN;
  }
}

// A phone number or ZIP+4 printed by a name isn't an account number, and isn't the name either
const notName = (t) => (typeof t === 'string' ? t : '').replace(/\s+\d{1,6}\s+[A-Za-z0-9.' ]+?\b(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|pl|place|cir|suite|ste)\b.*$/i, '').replace(/\s+[A-Za-z.]+,\s*[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/, '').replace(/\bP\.?\s?O\.?\s+Box\s+\d+.*$/i, '').replace(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, ' ').replace(/\b\d{5}-\d{4}\b/g, ' ');

/** One reading made safe. The bank on a cashier's check isn't the giver: its remitter is, or nobody yet */
function cleanRead(r, checkNumber) {
  if (!r || r === DOWN) return null;
  r = { ...r, payer: notName(r.payer), remitter: notName(r.remitter) };
  // A reader may answer the yes or no as words; and a bank where the payer goes is a cashier's check however it was ticked
  const cashier = r.cashiersCheck === true || /^(true|yes)$/i.test(String(r.cashiersCheck ?? '')) || isBank(r.payer);
  const own = safeText(r.payer, 120, checkNumber);
  const payer = cashier ? safeText(r.remitter, 120, checkNumber) : own || safeText(r.remitter, 120, checkNumber);
  return {
    payer,
    payee: safeText(r.payee, 120, checkNumber),
    date: isDay(r.date) ? r.date : '',
    cents: Number.isFinite(Number(r.amount)) ? toCents(r.amount) : 0,
    number: noZeros(r.checkNumber).length < 16 ? noZeros(r.checkNumber) : '',
    memo: safeMemo(r.memo, 160, checkNumber),
    // The address printed under the payer's own name: a cashier's check prints the bank's, and a remitter's isn't printed
    address: !cashier && own ? addressOf(r, checkNumber) : null,
  };
}

/**
 * Two readings against what Mercury knows → { ok, payer, date, memo, why }. ok means the picture is this check
 * (amount to the cent, the check number too when Mercury has one) and the payer is known: from Mercury when it
 * names one, else both readers agreeing. A date only one reader sees isn't used.
 */
export function proveRead(reads, { cents, checkNumber = '', hint = '' }) {
  if (isBank(hint)) hint = '';
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
  // The address both readers saw under the same name, and the name it's under is the giver's
  const both = a && b && a.payer && b.payer && sameGiver(a.payer, b.payer) ? agreeAddress(a.address, b.address) : null;
  const address = both && (!hint || sameGiver(hint, a.payer)) ? { address: both } : {};
  if (hint) return { ok: true, payer: tidyName(hint), date, memo, ...address };
  if (!a?.payer || !b?.payer || !sameGiver(a.payer, b.payer)) return { ok: false, why: 'unreadable' };
  // Both took the payee's line for the payer's: this is who it's made out to, not who wrote it
  if (OWN.test(a.payer) && OWN.test(a.payee)) return { ok: false, why: 'unreadable' };
  return { ok: true, payer: tidyName(a.payer.length >= b.payer.length ? a.payer : b.payer), date, memo, ...address };
}

// ─── Where the donor's mail goes ────────────────────────────────────

const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP AA AE AP'.split(' '));

/** A street line written in capitals, in ordinary case: 12 NE PEACHTREE ST APT 4 reads 12 NE Peachtree St Apt 4 */
function tidyStreet(t) {
  if (!t || /\p{Ll}/u.test(t)) return t;
  return t.toLowerCase().replace(/(^|[^\p{L}\d])(\p{L}[\p{L}'’]*)/gu, (m, pre, w) => pre + (/^(ne|nw|se|sw|po)$/.test(w) || w.length === 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
}

/**
 * The four parts a reader gave → { line1, city, state, postal_code, country } or null. All four or nothing, the way Zeffy
 * takes an address. A street line with a run of six or more digits never gets through (hasAccountDigits)
 */
export function addressOf(r, checkNumber = '') {
  const line1 = clean(String(r?.street ?? '').normalize('NFKC')).replace(/[,;]+$/, '');
  const city = clean(String(r?.city ?? '').normalize('NFKC')).replace(/[,;.]+$/, '');
  const state = clean(r?.state).toUpperCase().replace(/[^A-Z]/g, '');
  const zip = clean(r?.zip).replace(/\s+/g, '');
  if (!line1 || !city || !state || !zip || line1.length > 100) return null;
  // A street has a number and a word: "123 Main St", "PO Box 9"
  if (!/\p{L}/u.test(line1) || !/\d/.test(line1) || hasAccountDigits(line1, checkNumber)) return null;
  if (!/^[\p{L} .'’-]{2,50}$/u.test(city) || !US_STATES.has(state)) return null;
  const z = zip.match(/^(\d{5})(?:-?(\d{4}))?$/);
  if (!z) return null;
  // The first five only: a ZIP+4 is nine digits in a row, which is what a bank number looks like, and nothing keeps one
  return { line1: tidyStreet(line1), city: tidyName(city), state, postal_code: z[1], country: 'US' };
}

// Ways one street is written: 12 Oak Street #4 and 12 Oak St Apt 4 are one address
const STREET_WORDS = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', boulevard: 'blvd', place: 'pl', parkway: 'pkwy',
  circle: 'cir', highway: 'hwy', terrace: 'ter', trail: 'trl', square: 'sq', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', apartment: '', apt: '', suite: '', ste: '', unit: '', number: '', no: '', post: 'po', office: '',
};
/** One address as a comparable key, the ZIP's first five digits only: "" for none */
export function addressKey(a) {
  if (!a?.line1) return '';
  return [a.line1, a.city, a.state, String(a.postal_code || '').slice(0, 5)].map((s) => clean(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\bp o\b/g, 'po').split(' ').filter(Boolean).map((w) => STREET_WORDS[w] ?? w).filter(Boolean).join(' ')).join('|');
}

/** What two readers both saw, or null */
export function agreeAddress(a, b) {
  if (!a || !b || addressKey(a) !== addressKey(b) || a.postal_code !== b.postal_code) return null;
  return { ...a };
}
const addressLine = (a) => (a?.line1 ? `${a.line1}, ${a.city}, ${a.state} ${a.postal_code}` : '');

const jsonOf = (s, d = null) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };

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

// ─── The letter with it ─────────────────────────────────────────────

/** The files beside a check that aren't the check: what the team attached after the deposit. Keyed so a file is read once */
export function letterFiles(txn) {
  const seen = new Map();
  return (txn?.attachments || []).filter((a) => a && a.attachmentType !== 'checkImage' && a.url).map((a) => {
    const base = `${clean(a.attachmentType) || 'file'}:${clean(a.fileName).slice(0, 80)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { key: n > 1 ? `${base}#${n}` : base, url: a.url, name: clean(a.fileName) };
  });
}

/** Who wrote the check, as read off it (row.drawer; a row read before Nov 10 has only payer) */
const checkName = (row) => row?.drawer || row?.payer || '';

/** What the letter with a check says, as read before the site decided it: { why } when it can't be used */
export const letterSays = (row) => {
  const l = jsonOf(row?.letter, {});
  return l.why ? { why: l.why } : { name: l.name || '', email: l.email || '', address: l.address || null };
};

/** The letter's email, for a gift going in under `name`: it's the letter's giver's (the check writer's when it names nobody) */
const letterEmail = (row, name) => {
  const l = letterSays(row);
  return l.email && surelySameGiver(l.name || checkName(row), name) ? l.email : '';
};

/**
 * The letter's email, to file the record by, only when Zeffy already has a donor under the giver's name holding it: the gift
 * then joins their history. Any other way (nobody has it, or someone else does) the record goes in by name, and the email is
 * added to the giver's donor after, only into a blank (writeAddresses). Zeffy files a record under whoever has an email, and
 * a fund's letter can give its accountant's. Zeffy not answering throws, so the save waits
 */
async function letterMail(env, row, name, fetchImpl) {
  const email = letterEmail(row, name);
  if (!email) return '';
  let r;
  try {
    r = await zeffyGet(env, '/contacts', { email, limit: 10 }, fetchImpl);
  } catch (e) {
    // Zeffy turning the question down (not just not answering): the record goes in by name, and the email is added after
    if (e.status && e.status < 500 && e.status !== 429) return '';
    throw e;
  }
  const holders = (r?.data || []).filter((c) => clean(c.email).toLowerCase() === email);
  return holders.length && holders.every((c) => surelySameGiver(name, givenName({ first_name: c.first_name, last_name: c.last_name }))) ? email : '';
}

/** A letter file still to be read: its check waits for it */
export const lettersWaiting = (row) => (jsonOf(row?.letter, {}).pending || []).length > 0;

const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;
/** One reader's answer about a letter, made safe: never SOARD as the giver, never an address or email of SOARD's own */
function cleanLetter(r) {
  const name = safeText(notName(r?.recordAs), 120);
  const email = clean(r?.email).toLowerCase().replace(/^mailto:/, '');
  return {
    about: r?.aboutGift === true || /^(true|yes)$/i.test(String(r?.aboutGift ?? '')),
    name: name && !OWN.test(name) && !isBank(name) ? name : '',
    email: email.length <= 120 && EMAIL.test(email) && !/@(soardcharity\.com|sunshineonaranneyday\.com)$/.test(email) && !isTag(email) ? email : '',
    address: addressOf(r),
    cents: Number.isFinite(Number(r?.amount)) ? toCents(r.amount) : 0,
  };
}

/**
 * Two readings of one letter → { ok, about, name, email, address, amountOff } | { ok: false, why }. The letter is the source
 * of truth, so a name both readers don't agree on is a person's to read; an email or address they don't agree on is left off
 */
export function proveLetter(reads, { cents = 0 } = {}) {
  const good = reads.filter((r) => r && r !== DOWN && typeof r === 'object').map(cleanLetter);
  if (good.length < 2) return { ok: false, why: 'letter' };
  const [a, b] = good;
  if (!a.about && !b.about) return { ok: true, about: false };
  if (a.about !== b.about || !!a.name !== !!b.name || (a.name && !sameGiver(a.name, b.name))) return { ok: false, why: 'letter' };
  return {
    ok: true, about: true,
    name: a.name ? tidyName(a.name.length >= b.name.length ? a.name : b.name) : '',
    email: a.email && a.email === b.email ? a.email : '',
    address: agreeAddress(a.address, b.address),
    // Both read the same amount off the letter, and it isn't the check's: it may be about another gift
    amountOff: a.cents > 0 && a.cents === b.cents && Number(cents) > 0 && a.cents !== Number(cents),
  };
}

/** One model's reading of a letter, or null; DOWN when it errored. A spending cap is thrown */
async function readLetterWith(env, model, { image = null, text = '' }) {
  const content = image
    ? [{ type: 'text', text: 'Read this page.' }, { type: 'image_url', image_url: { url: image } }]
    : `Read this page. Its text, as the file has it:\n${text.slice(0, 8000)}`;
  try {
    const out = await timed(env.AI.run(model, {
      messages: [{ role: 'system', content: LETTER_PROMPT }, { role: 'user', content }],
      max_tokens: 800, temperature: 0, ...(READERS[model] || {}),
      response_format: { type: 'json_schema', json_schema: LETTER_SCHEMA },
    }, viaGateway('check-gifts')), READ_TIMEOUT_MS);
    const a = answerOf(out);
    return a && typeof a === 'object' ? a : null;
  } catch (e) {
    if (aiCapped(e)) throw e;
    console.error('[check-gifts] a letter reader failed');
    return DOWN;
  }
}

const dataUrl = (bytes, kind) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/${kind};base64,${btoa(bin)}`;
};

/**
 * What the readers can take from a file: a photo as a picture; a PDF as its text, or, when it's a scan (pictures, no text),
 * its first page's picture; anything else nothing. toMarkdown's framing ("Metadata … Contents") is not text (pageText)
 */
async function letterInput(env, bytes) {
  const kind = imageKind(bytes);
  if (['jpeg', 'png', 'webp'].includes(kind)) return bytes.length > MAX_IMAGE_BYTES ? { none: 'size' } : { image: dataUrl(bytes, kind) };
  const pdf = bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
  if (!pdf || bytes.length > 10 * 1024 * 1024) return { none: kind || (pdf ? 'pdf' : 'other') };
  if (env.AI?.toMarkdown) {
    try {
      const r = await timed(env.AI.toMarkdown({ name: 'letter.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) }, { conversionOptions: { output: { format: 'text' } } }), READ_TIMEOUT_MS);
      const one = Array.isArray(r) ? r[0] : r;
      const text = one?.format === 'error' ? '' : clean(pageText(one?.data));
      if ((text.match(/\p{L}/gu) || []).length >= 30) return { text };
    } catch (e) {
      if (aiCapped(e)) throw e;
    }
  }
  const [page] = scannedPages(bytes, { max: 1, maxBytes: MAX_IMAGE_BYTES });
  return page ? { image: dataUrl(page.bytes, 'jpeg') } : { none: 'pdf' };
}

/** The row's letter, swapped only while it's still what was read: a run and a page never write over each other's */
async function swapLetter(DB, id, held, next, now) {
  const r = await DB.prepare('UPDATE check_gifts SET letter = ?, updated_at = ? WHERE id = ? AND letter IS ?').bind(JSON.stringify(next), new Date(now).toISOString(), id, held ?? null).run();
  return !!r.meta?.changes;
}

/** A file's fingerprint: a phone names every photo image.jpg, so a name says little about which letter it is */
async function hashOf(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The checks the site is still deciding by itself: only for these are letter files read
const DECIDING = ['new', 'read', 'would'];
/** The letter reader's version: a reading by an older one is read again while its check is still being decided */
const LETTER_READER = 2;
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** What the letter's files there now say together, as the row keeps it */
const summary = (l) => { const e = effectiveLetter(l); return { about: !!e.about, name: e.name || '', email: e.email || '', address: e.address || null, why: e.why || null }; };

/**
 * The files beside the check as they are now (in any order). While the site is still deciding the check, a file added is read
 * before it decides, and one taken off stops counting. Once it's decided, a file added isn't read: added after the record is in
 * Zeffy, it's a person's to look at (`late`). A check's first look only notes what's there (one decided before letters were read)
 */
async function noteLetters(env, row, txn, now) {
  const present = letterFiles(txn).map((f) => f.key);
  const was = jsonOf(row.letter);
  const known = was?.files || [];
  const deciding = DECIDING.includes(row.state);
  const reads = Object.fromEntries(Object.entries(was?.reads || {}).filter(([k]) => present.includes(k)));
  // While deciding, every file there with no reading is read first: one added while a person had the check too
  const pending = deciding && present.length <= MAX_LETTER_FILES ? present.filter((k) => !reads[k] || (reads[k].v !== LETTER_READER && !reads[k].why)) : [];
  const fresh = present.filter((k) => !known.includes(k));
  // A file added after the record is in: a person's to look at, while the site enters checks (watching, staff enter their own)
  const candidates = was && ['created', 'linked', 'creating', 'unsure'].includes(row.state) ? fresh : [];
  const lateNow = candidates.length && (await readState(env.DB, KEY)).mode === 'on' ? candidates : [];
  const late = [...new Set([...(was?.late || []), ...lateNow])].filter((k) => present.includes(k));
  // The day a letter gets to be read starts once its check can be read, and again whenever it comes back to be decided
  const since = row.state === 'new' || !pending.length ? null : was?.since && (was.pending || []).length ? was.since : new Date(now).toISOString();
  if (was && sameSet(present, known) && sameSet(pending, was.pending || []) && (was.since || null) === since && sameSet(late, was.late || [])) return false;
  // What the files say is worked out again from the ones there now, whatever the check's state: one taken off stops counting
  const next = { ...(was || {}), files: present, reads, pending, since, late, ...summary({ files: present, reads }) };
  if (!(await swapLetter(env.DB, row.id, row.letter, next, now))) return false;
  if (lateNow.length) {
    await tell(env, row, 'letter-late', { title: `A letter was added to a check already in Zeffy: ${money(row.cents)}`, lead: 'A file was added in Mercury after this check went into Zeffy. The site doesn’t change a saved record by itself.', fix: 'Look at it in Mercury, and fix the record in Zeffy if it says something else. Then press “Looked at it” on Checks.' });
  }
  return deciding;
}

/** Before a check goes in: every letter file read is still the file that was read. One that changed is read again */
async function verifyLetters(env, row, txn, now, fetchImpl) {
  const l = jsonOf(row.letter);
  if (!l?.reads || (l.pending || []).length) return false;
  const changed = [];
  for (const f of letterFiles(txn)) {
    const r = l.reads[f.key];
    if (!r?.hash || (l.changes?.[f.key] || 0) > 2) continue;
    const res = await fetchImpl(f.url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res?.ok) continue;
    if ((await hashOf(new Uint8Array(await res.arrayBuffer()))) !== r.hash) changed.push(f.key);
  }
  if (!changed.length) return false;
  const reads = { ...l.reads };
  const tries = { ...(l.tries || {}) };
  const changes = { ...(l.changes || {}) };
  const again = [];
  for (const k of changed) {
    changes[k] = (changes[k] || 0) + 1;
    // A file that's different every time it's fetched can't be read and trusted: a person looks
    if (changes[k] > 2) reads[k] = { why: 'letter', hash: reads[k]?.hash };
    else { delete reads[k]; delete tries[k]; again.push(k); }
  }
  return swapLetter(env.DB, row.id, row.letter, { ...l, reads, tries, changes, pending: again, since: again.length ? new Date(now).toISOString() : l.since || null, ...summary({ ...l, reads }) }, now);
}

/** One more file's reading on what the others said: the first name, email and address stand; files naming different givers go to a person */
function mergeLetter(cur, f) {
  if (f.why) return { why: cur.why || f.why };
  if (!f.about) return {};
  if (f.name && cur.name && !sameGiver(cur.name, f.name)) return { about: true, why: 'letter' };
  return {
    about: true,
    ...(f.name && !cur.name ? { name: f.name } : {}),
    ...(f.email && !cur.email ? { email: f.email } : {}),
    ...(f.address && !cur.address ? { address: f.address } : {}),
    ...(f.amountOff ? { why: cur.why || 'letter-amount' } : {}),
  };
}

/** What these files, together, say: { about, name, email, address, why } */
function effectiveLetter(l, keys = l?.files || []) {
  if ((l?.files || []).length > MAX_LETTER_FILES) return { why: 'letter-many' };
  let out = {};
  for (const k of keys) { const r = l?.reads?.[k]; if (r) out = { ...out, ...mergeLetter(out, r) }; }
  return out;
}

/**
 * Reads one letter file (a run's big job, like a check's picture). Two readers must agree; a file that can't be fetched is
 * tried again, three times; readers or Mercury not answering is an outage, which never spends a try. A day of no reading
 * goes to a person
 */
export async function readLetter(env, row, { mode, now, fetchImpl }) {
  const iso = new Date(now).toISOString();
  const was = jsonOf(row.letter, {});
  const key = (was.pending || [])[0];
  if (!key) return { result: 'quiet' };
  const spent = ((was.tries || {})[key] || 0) + 1;
  let cur = { ...was, tries: { ...(was.tries || {}), [key]: spent }, tryAt: iso, since: was.since || iso };
  if (!(await swapLetter(env.DB, row.id, row.letter, cur, now))) return { result: 'busy' };
  let held = JSON.stringify(cur);
  const save = async (patch) => {
    const next = { ...cur, ...patch };
    if (!(await swapLetter(env.DB, row.id, held, next, now))) return false;
    cur = next;
    held = JSON.stringify(next);
    return true;
  };
  const giveBack = () => save({ tries: { ...cur.tries, [key]: spent - 1 } });
  let found = null;
  let hash = null;
  if (now - Date.parse(cur.since) > DAY) found = { why: 'letter' };
  else {
    let txn = null;
    try {
      txn = await getTransaction(env, row.id, { fetchImpl });
    } catch (e) {
      // A 404 can be Mercury's for a moment: it spends a try, and three of them go to a person
      if (e.status !== 404) { await giveBack(); throw e; }
    }
    const file = txn ? letterFiles(txn).find((f) => f.key === key) : null;
    if (!txn) found = spent >= LETTER_TRIES ? { why: 'letter' } : null;
    else if (!file) {
      // Taken off in Mercury since: nothing to read, and the next look forgets it
      await save({ pending: (cur.pending || []).filter((k) => k !== key), tryAt: null });
      return { result: 'letter' };
    } else {
      let res = null;
      try { res = await fetchImpl(file.url, { signal: AbortSignal.timeout(15000) }); } catch { res = null; }
      if (res?.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        hash = await hashOf(bytes);
        const input = await letterInput(env, bytes).catch((e) => { if (aiCapped(e)) throw e; return { none: 'other' }; });
        if (input.none) found = { why: 'letter' };
        else {
          let reads;
          try {
            reads = await Promise.all(Object.keys(READERS).map((m) => readLetterWith(env, m, input)));
          } catch (e) {
            if (!aiCapped(e)) throw e;
            await giveBack();
            return { result: 'capped' };
          }
          if (reads.some((r) => r === DOWN)) {
            await giveBack();
            throw Object.assign(new Error(reads.every((r) => r === DOWN) ? 'The check readers didn’t answer' : 'A check reader didn’t answer'), { readers: true });
          }
          const proved = proveLetter(reads, { cents: row.cents });
          found = proved.ok ? { about: proved.about, name: proved.name || '', email: proved.email || '', address: proved.address || null, amountOff: !!proved.amountOff } : { why: proved.why };
        }
      } else if (spent >= LETTER_TRIES) found = { why: 'letter' };
    }
  }
  if (!found) return { result: 'again' };
  const pending = (cur.pending || []).filter((k) => k !== key);
  const reads = { ...(cur.reads || {}), [key]: { ...found, ...(hash ? { hash } : {}), v: LETTER_READER } };
  if (!(await save({ reads, pending, tryAt: null, at: iso, ...summary({ ...cur, reads }) }))) return { result: 'busy' };
  return { result: 'letter' };
}

// ─── Is it in Zeffy already? ────────────────────────────────────────

const namesOn = (p) => [clean(p?.buyer?.company_name), givenName(p?.buyer)].filter(Boolean);
const paidByCheck = (p) => /che(ck|que)/i.test(String(p?.payment_method?.type || ''));
const madeByHand = (p) => p?.type === 'manual' || p?.type === 'imported';
/**
 * A gift given on a Zeffy form with "Donor-advised fund": Zeffy records it at once (Due until someone marks it paid) and
 * the money comes days or weeks later from the fund, usually as a check under the fund's name (Fidelity Charitable, the
 * family fund), not the donor's. Zeffy's word for the method is "daf" (read in SOARD's Zeffy, Nov 10 2026: a real DAF gift
 * says paymentMethod "daf" where a check says "cheque", the API's word); other spellings of it count too
 */
export const byDaf = (p) => /(^|[^a-z])daf|donor.?advised/i.test(String(p?.payment_method?.type || ''));
/** How long before a check's date a DAF gift already marked paid can still be the gift that check pays */
const DAF_DAYS = 90;

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
export function matchZeffy(row, payments, claimed = new Set(), learned = null) {
  const day = recordDay(row);
  const anchor = secondsOf(day);
  // A stale check (dated months before it was deposited) may be entered on its own date: near that counts too
  const early = secondsOf(earliestDay(row));
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
    const daf = byDaf(p);
    const unpaid = status !== 'succeeded';
    if (!byHand && !byCheck && !daf && !unpaid) continue;
    // Goods given, not this check's money
    const method = String(p?.payment_method?.type || '').toLowerCase();
    if (/in.?kind/.test(method)) continue;
    const at = Number(p.created) || 0;
    const giver = !!row.payer && namesOn(p).some((n) => sameGiver(row.payer, n));
    // Linking by itself needs the giver for sure: their own contact in Zeffy, or a name that can only be them
    const sure = giver && ((learned?.contact_id && String(p.contact) === String(learned.contact_id)) || namesOn(p).some((n) => surelySameGiver(row.payer, n)));
    // Entered by hand long after (staff catching up): likely this check, but a monthly giver's next one could be it too
    if (at > latest) {
      if (at <= Math.max(anchor, deposited) + LATE_DAYS * 86400 && giver && byHand && !unpaid && Number(p.amount) === Number(row.cents)) out.maybe.push(p);
      continue;
    }
    const near = at >= anchor - SAME_GIVER_DAYS * 86400 || (early < anchor && Math.abs(at - early) <= SAME_GIVER_DAYS * 86400);
    const promise = byCheck && !byHand;
    if (daf) {
      // A DAF gift: the fund's check names the fund, so any name; it never links by itself, as the gift is marked paid in
      // Zeffy, by a person. Still Due: any age, the money hasn't come. Paid: one given in the DAF_DAYS before the check
      if (Number(p.amount) === Number(row.cents)) {
        if (unpaid) (giver ? out.promised : out.maybe).push(p);
        else if (at >= Math.min(anchor, early) - DAF_DAYS * 86400) out.maybe.push(p);
      } else if (giver && unpaid) out.promised.push(p);
      continue;
    }
    if (Number(p.amount) === Number(row.cents)) {
      if (giver && unpaid) out.promised.push(p);
      else if (sure && near && byCheck) out.same.push(p);
      else if (giver && near) out.maybe.push(p);
      else if (promise) { if (giver || at >= anchor - 30 * 86400) out.maybe.push(p); }
      else if (giver) { if (!dated && at >= anchor - NO_DATE_DAYS * 86400) out.maybe.push(p); }
      else if (at >= anchor - (dated && !unpaid ? OTHER_NAME_DAYS : SAME_GIVER_DAYS) * 86400) out.maybe.push(p);
    } else if (giver && unpaid && (promise || byHand)) {
      // A pledge for another amount, however old: the check may pay it, and saving past it would count the money twice
      out.promised.push(p);
    } else if (giver && byHand && !unpaid && near) {
      out.other.push(p);
    }
  }
  // Two checks from one giver, two entries: each takes the nearest
  out.same.sort((a, b) => Math.abs(Number(a.created) - anchor) - Math.abs(Number(b.created) - anchor));
  return out;
}

const NET_S = 400 * 86400;         // how far back the wide look reads Zeffy
/** Since this day every SOARD check goes through Mercury (Peter, Nov 6 2026): a check gift in Zeffy from then on has a Mercury deposit */
export const MERCURY_FROM = '2026-11-06';
const MONEY_BACK_S = 45 * 86400;   // how far back the weekly money check looks
/**
 * The wide look, before the site makes a record by itself: anything in Zeffy, under any name, that could be this check.
 * Matching works in windows (a date near the check's, a name that fits); staff can type a check outside every window
 * (weeks late, backdated, under an advisor's name, or by marking a pledge paid). So the site makes a record only when
 * nothing at all could be it:
 *   any unclaimed entry by hand or paid by check, for this amount, made since about when the check was written;
 *   any of the giver's own pledges or pay-by-check promises for this amount, open, or turned paid since then
 *   (`turnedPaid`: payments Zeffy's alerts saw change since then, as Zeffy says nothing about when a payment changed)
 */
/**
 * Zeffy's entries for a check under either of its names: the letter's giver (row.payer) and the name on the check (row.drawer).
 * A pledge or hand entry the check's writer has in Zeffy is still this check's, whoever the letter says it's from
 */
export function matchBoth(row, payments, claimed = new Set(), learned = null, drawerLearned = null) {
  const m = matchZeffy(row, payments, claimed, learned);
  if (!row.drawer || sameGiver(row.drawer, row.payer)) return m;
  const d = matchZeffy({ ...row, payer: row.drawer }, payments, claimed, drawerLearned);
  const out = { same: [], promised: [], maybe: [], other: [] };
  const seen = new Set();
  for (const k of ['same', 'promised', 'maybe', 'other']) {
    for (const p of [...m[k], ...d[k]]) if (!seen.has(String(p.id))) { seen.add(String(p.id)); out[k].push(p); }
  }
  return out;
}

/** The wide look under both of a check's names (matchBoth) */
export function netBoth(row, payments, claimed = new Set(), o = {}) {
  const net = netOf(row, payments, claimed, o);
  if (!row.drawer || sameGiver(row.drawer, row.payer)) return net;
  const more = netOf({ ...row, payer: row.drawer }, payments, claimed, { ...o, learned: o.drawerLearned || null });
  return [...new Map([...net, ...more].map((p) => [String(p.id), p])).values()];
}

export function netOf(row, payments, claimed = new Set(), { learned = null, turnedPaid = new Set(), typedSinceOn = new Set() } = {}) {
  const written = writtenS(row);
  const out = [];
  const parts = [];
  for (const p of payments || []) {
    const id = String(p.id);
    if (claimed.has(id) || rejectedBy(row).includes(id) || p.refund_status === 'full' || isTestRecord(p)) continue;
    const status = String(p.status || '').toLowerCase();
    if (/fail|cancel/.test(status)) continue;
    if (/in.?kind/.test(String(p?.payment_method?.type || '').toLowerCase())) continue;
    const byHand = madeByHand(p);
    const byCheck = paidByCheck(p);
    const daf = byDaf(p);
    if (!byHand && !byCheck && !daf) continue;
    const unpaid = status !== 'succeeded';
    const at = Number(p.created) || 0;
    const giver = !!row.payer && (namesOn(p).some((n) => sameGiver(row.payer, n)) || (learned?.contact_id && String(p.contact) === String(learned.contact_id)));
    const fresh = turnedPaid.has(id);
    if (Number(p.amount) === Number(row.cents)) {
      // Made since the check was written; typed in or marked paid since then, however it's dated, under any name; the
      // giver's own pledge still open; or a DAF gift under any name (byDaf): still Due, or given in the DAF_DAYS before
      if (at >= written || fresh || (giver && unpaid) || (daf && (unpaid || at >= written - DAF_DAYS * 86400))) out.push(p);
    } else if (!unpaid && Number(p.amount) < Number(row.cents) && ((at >= written && at >= secondsOf(MERCURY_FROM)) || fresh)) {
      // (an entry dated before checks went through Mercury counts only if it was typed since: older ones are other banks' checks)
      parts.push(p);
    }
  }
  // One check paying several gifts (a United Way sheet, a table and a gift): entries since it was written that add up to it
  if (parts.length > 1) {
    const near = parts.sort((a, b) => Math.abs(Number(a.created) - written) - Math.abs(Number(b.created) - written));
    const sum = partsAddingTo(near, Number(row.cents), 2, 4);
    if (sum) out.push(...sum);
  }
  const day = secondsOf(recordDay(row));
  return [...new Map(out.map((p) => [String(p.id), p])).values()].sort((a, b) => Math.abs(Number(a.created) - day) - Math.abs(Number(b.created) - day));
}

/**
 * What the wide look reads: 400 days of Zeffy, or, if Zeffy holds more than the site can read whole, the usual read around
 * the check with `whole: false`, so nothing is ever saved on a look that couldn't see everything
 */
async function readWide(env, fromS, now, fetchImpl) {
  let out;
  try {
    out = { payments: await paymentsSince(env, Math.min(fromS, Math.floor(now / 1000) - NET_S), fetchImpl), whole: true };
    await noteSeen(env, out.payments, now);
  } catch (e) {
    if (!/more payments than/.test(e.message)) throw e;
    out = { payments: await paymentsSince(env, fromS, fetchImpl), whole: false };
  }
  // An open pledge from longer ago than the read is still a promise this check may pay
  const pledges = await openPledges(env, fetchImpl);
  const ids = new Set(out.payments.map((p) => String(p.id)));
  out.payments = [...out.payments, ...pledges.filter((p) => !ids.has(String(p.id)))];
  return out;
}

/** Zeffy's open payments, however old: pledges and pay-by-check promises still waiting */
async function openPledges(env, fetchImpl) {
  const out = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const r = await zeffyGet(env, '/payments', { status: 'pending', limit: 100, starting_after: after }, fetchImpl);
    out.push(...(r?.data || []));
    if (!r?.has_more || !r.next_cursor) break;
    after = r.next_cursor;
  }
  return out;
}

/** What the wide look needs to know about time: payments typed or turned paid since the check was written, and since On */
async function freshFor(env, row, cfg) {
  const written = writtenS(row);
  const onS = cfg?.onAt ? Math.floor(Date.parse(cfg.onAt) / 1000) : Infinity;
  const turnedPaid = await freshSince(env.DB, written);
  const typedSinceOn = Number.isFinite(onS) ? await freshSince(env.DB, Math.max(written, onS)) : new Set();
  return { turnedPaid, typedSinceOn };
}

/**
 * Notes what a whole read of the last 400 days shows. The first time, everything is taken as it stands (its own date), so
 * history never looks new; after that a payment that wasn't there before was typed since, and one that turned paid did so now
 */
async function noteSeen(env, payments, now) {
  const nowS = Math.floor(now / 1000);
  const cfg = await readState(env.DB, KEY);
  const first = !cfg.seenSince;
  const known = new Map(((await env.DB.prepare('SELECT payment_id, status FROM zeffy_seen').all()).results || []).map((r) => [r.payment_id, r.status]));
  const writes = [];
  for (const p of payments) {
    const id = String(p.id);
    const status = String(p.status || '').toLowerCase();
      if (!known.has(id)) {
      // 0: here before the site was watching (the first fill), or an import of old records, however recently it arrived
      const when = first || p.type === 'imported' ? 0 : nowS;
      writes.push(env.DB.prepare('INSERT OR IGNORE INTO zeffy_seen (payment_id, status, first_seen, paid_seen) VALUES (?, ?, ?, ?)').bind(id, status, when, status === 'succeeded' ? when : null));
    } else if (known.get(id) !== status) {
      writes.push(env.DB.prepare('UPDATE zeffy_seen SET status = ?, paid_seen = CASE WHEN ? = \'succeeded\' AND paid_seen IS NULL THEN ? ELSE paid_seen END WHERE payment_id = ?').bind(status, status, nowS, id));
    }
  }
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
  if (first) await writeState(env.DB, KEY, { seenSince: new Date(now).toISOString() });
}

/** Payments typed in, or turned paid, since a time: from the site's own record of Zeffy, and from Zeffy's gift alerts */
async function freshSince(DB, fromS) {
  const ids = await turnedPaidSince(DB, fromS);
  try {
    const r = await DB.prepare('SELECT payment_id FROM zeffy_seen WHERE first_seen >= ? OR paid_seen >= ?').bind(fromS, fromS).all();
    for (const x of r.results || []) ids.add(String(x.payment_id));
  } catch { /* not set up yet */ }
  return ids;
}

/** Amounts of checks still on their way to a record (read, waiting on Mercury or a person): an entry for one of these is that check's */
async function openAmounts(DB, notId, now) {
  const r = await DB.prepare(`SELECT cents FROM check_gifts WHERE id != ? AND zeffy_id IS NULL AND state IN ('new', 'read', 'would', 'person', 'creating', 'unsure') AND deposited_at >= ?`)
    .bind(notId || '', new Date(now - 45 * DAY).toISOString()).all().catch(() => ({ results: [] }));
  return new Set((r.results || []).map((x) => Number(x.cents)));
}

/** From the first 25 entries, `min` to `max` of them whose amounts add up to `target` cents, or null */
function partsAddingTo(list, target, min, max) {
  const near = list.slice(0, 25);
  const found = (from, left, picked) => {
    if (left === 0 && picked.length >= min) return picked;
    if (picked.length === max || left <= 0) return null;
    for (let i = from; i < near.length; i++) { const r = found(i + 1, left - Number(near[i].amount), [...picked, near[i]]); if (r) return r; }
    return null;
  };
  return target > 0 ? found(0, target, []) : null;
}

const isTestRecord = (p) => ['SOARD WebsiteTest', WRITE_TEST_ONE_WORD].includes(clean(givenName(p?.buyer)));

/** Payments Zeffy's gift alerts saw change since a time: the only sign of when a pledge was marked paid */
async function turnedPaidSince(DB, fromS) {
  try {
    const r = await DB.prepare('SELECT payment_id FROM zeffy_gifts WHERE updated_at >= ?').bind(new Date(fromS * 1000).toISOString()).all();
    return new Set((r.results || []).map((x) => String(x.payment_id)));
  } catch {
    return new Set();
  }
}
/** About when the check was written: its own date less two weeks; with no date read, any time in the 60 days before it went in */
const writtenS = (row) => (isDay(row.check_date)
  ? secondsOf(row.check_date < recordDay(row) ? row.check_date : recordDay(row)) - SAME_GIVER_DAYS * 86400
  : secondsOf(recordDay(row)) - DATED_BACK_MS / 1000);

/** Entries a person said aren't this check are out of it, for good */
function rejectedBy(row) {
  try { return JSON.parse(row.rejected || '[]').map(String); } catch { return []; }
}
const claimedFor = (row, claimed) => new Set([...claimed, ...rejectedBy(row)]);

/** Zeffy entries as the page shows them to a person: never an email or address */
const entriesToShow = (list) => list.slice(0, 20).map((p) => ({ id: String(p.id), name: namesOn(p)[0] || '', cents: Number(p.amount), at: Number(p.created) || 0, form: clean(p.description) }));

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
  // A check that came back gives up its record: the same check deposited again may take it
  const r = await DB.prepare("SELECT zeffy_id FROM check_gifts WHERE zeffy_id IS NOT NULL AND state != 'came-back'").all();
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
  // Marked Grant in Mercury: the newest Grant Funding form, whoever it's from
  if (GRANT_CATEGORY.test(row.category || '')) {
    const grant = newest(forms.filter((f) => /grant funding/i.test(f.title)));
    if (grant) return grant;
  }
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
export function judge(row, { payments = [], claimed = new Set(), forms = [], learned = null, drawerLearned = null, isVendor = false, gift = false } = {}) {
  const m = matchBoth(row, payments, claimedFor(row, claimed), learned, drawerLearned);
  const show = entriesToShow;
  if (m.same.length) return { do: 'link', payment: m.same[0] };
  if (m.promised.length) return { do: 'person', reason: 'pledge', candidates: show(m.promised) };
  if (m.maybe.length) return { do: 'person', reason: 'maybe-double', candidates: show(m.maybe) };
  if (m.other.length) return { do: 'person', reason: 'amount-differs', candidates: show(m.other) };
  if (!row.payer) return { do: 'person', reason: 'unreadable' };
  if (isBank(row.payer)) return { do: 'person', reason: 'bank' };
  const memo = row.memo || '';
  if (!gift) {
    // A letter's name never makes SOARD's own money, or an insurer's or the tax office's check, a gift: the check's name counts too
    const drawer = row.drawer || '';
    if (OWN.test(row.payer || '') || OWN.test(drawer)) return { do: 'left-out', reason: 'own' };
    if (REFUND_MEMO.test(memo)) return { do: 'left-out', reason: 'refund' };
    if ([row.payer || '', drawer].some((n) => NOT_A_GIVER.test(n) && !FOUNDATION.test(n)) && !GIFT_MEMO.test(memo)) return { do: 'left-out', reason: 'not-a-giver' };
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

/**
 * One check's row. `from`: only while the check is still in that state, so the site's own run never writes over what a
 * person (or another run) did since it read the row. Says whether it landed
 */
async function setRow(DB, id, patch, now, from = undefined) {
  const fields = { ...patch, updated_at: new Date(now).toISOString() };
  const keys = Object.keys(fields);
  const guard = from === undefined ? '' : ' AND state = ?';
  const r = await DB.prepare(`UPDATE check_gifts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?${guard}`)
    .bind(...keys.map((k) => fields[k]), id, ...(from === undefined ? [] : [from])).run();
  return !!r.meta?.changes;
}

const getRow = (DB, id) => DB.prepare('SELECT * FROM check_gifts WHERE id = ?').bind(id).first();

/** Why Zeffy said no, in words staff can act on: Zeffy's own text names its fields */
export function refusalWords(e) {
  const t = `${e?.code || ''} ${e?.message || ''}`;
  if (/campaign|form/i.test(t)) return 'The Zeffy form isn’t open any more. Pick another form.';
  if (/amount/i.test(t)) return 'Zeffy wouldn’t take this amount.';
  if (/email/i.test(t)) return 'Zeffy wouldn’t take the donor’s email on file.';
  if (/first_name|last_name|name/i.test(t)) return 'Zeffy wouldn’t take the name. Try writing it another way.';
  if (/date/i.test(t)) return 'Zeffy wouldn’t take the date. Pick another one.';
  return 'Zeffy wouldn’t take this record.';
}

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
  if (!(await setRow(env.DB, row.id, { state: 'person', reason, note: candidates ? JSON.stringify(candidates) : note }, now, row.state))) return false;
  if (mode === 'on') await tell(env, row, reason, { title: `A check needs a look: ${money(row.cents)}`, lead: note || REASONS[reason], fix: 'Open Checks in Job Costs.' });
  return true;
}

// ─── Making the record ──────────────────────────────────────────────

/** A name in Zeffy's two boxes: a one-word company in both, which reads once everywhere (givenName) */
export function nameParts(name) {
  let words = clean(name).split(' ').filter(Boolean);
  // John A. Smith Jr. is Smith Jr., not Jr.
  if (words.length >= 3 && /^(jr|sr|ii|iii|iv|v)\.?$/i.test(words.at(-1))) words = [...words.slice(0, -2), `${words.at(-2)} ${words.at(-1)}`];
  return words.length < 2 ? { first_name: words[0] || '', last_name: words[0] || '' } : { first_name: words.slice(0, -1).join(' '), last_name: words.at(-1) };
}

/** The day to put on the record: the one on the check, so a Dec 30 check deposited in January stays in December; never after the deposit, nor one too old to be right */
/** The earliest day a check could be entered as: its own date, however old, or the deposit day */
export function earliestDay(row) {
  const d = recordDay(row);
  if (!isDay(row.check_date) || row.check_date >= d) return d;
  const floor = new Date(Date.parse(`${d}T12:00:00Z`) - STALE_REACH_MS).toISOString().slice(0, 10);
  return row.check_date < floor ? floor : row.check_date;
}
const STALE_REACH_MS = 180 * DAY;

export function recordDay(row) {
  const deposited = dayOf(row.deposited_at);
  const d = row.check_date;
  if (!isDay(d) || d > deposited) return deposited;
  return Date.parse(`${deposited}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`) > DATED_BACK_MS ? deposited : d;
}

/** Exactly what's sent: tax receipt and email off every time, so nothing here ever reaches a donor */
export function recordFor(row, { name, form, email = null, day = null, now = Date.now() }) {
  // Noon Eastern, so the day is the same day in every clock Zeffy and the board read it by; a same-morning save is dated now
  const noon = `${day || recordDay(row)}T17:00:00.000Z`;
  return {
    campaign_id: form.id, amount: Number(row.cents), payment_method: 'cheque', ...nameParts(name),
    ...(email ? { email } : {}),
    generate_tax_receipt: false, send_confirmation_email: false,
    payment_date: Date.parse(noon) > now ? new Date(now - MIN).toISOString() : noon,
  };
}

/**
 * Who Zeffy holds for this giver: their email, so the gift lands on their record; or, when their contact has no email,
 * that contact, to file the gift under it (postJoined). A contact that's gone gives nothing, and Zeffy makes a new one
 */
async function learnedContact(env, learned, fetchImpl) {
  if (!learned?.contact_id) return {};
  let c;
  try {
    c = await zeffyGet(env, `/contacts/${encodeURIComponent(learned.contact_id)}`, {}, fetchImpl);
  } catch (e) {
    // Deleted in Zeffy: the gift makes a new contact. Not answering is waited out, so the giver's own contact is never lost
    if (e.status === 404) return {};
    throw Object.assign(new Error('Zeffy didn’t answer about this giver'), { later: true });
  }
  // The names staff gave the contact go on the record, so filing under it never renames it to how the check was read
  const first = clean(c?.first_name);
  const last = clean(c?.last_name);
  const names = first || last ? { first_name: first || last, last_name: last || first } : null;
  const email = clean(c?.email);
  if (email && !isTag(email)) return { email, names };
  return { join: String(c?.id || learned.contact_id), names };
}

/** Filing under a contact is used once the write test proved Zeffy keeps the record on it */
async function joinable(env, who) {
  if (!who.join) return null;
  return (await readState(env.DB, KEY)).writeTest?.join?.ok ? who.join : null;
}

/**
 * Zeffy files a new record under a contact only by email, and this giver's contact has none. So for the seconds the record
 * takes, the contact holds an address that reaches no one, the record goes in by it, and the address comes off again.
 * The address is noted before it goes on, so a run cut off anywhere still takes it off (clearTags). Receipts and emails
 * are off, so nothing is sent either way
 */
async function postJoined(env, contact, record, { tag, now, fetchImpl, checkId = null }) {
  const later = () => Object.assign(new Error('Another save is filing under this giver’s contact'), { later: true, status: 429 });
  // One save at a time a contact: a second waits for a later run, and one left over from a run cut short comes off first
  const held = await env.DB.prepare('SELECT * FROM check_tags WHERE contact = ?').bind(contact).first();
  if (held) {
    const saving = held.check_id && await env.DB.prepare("SELECT 1 AS y FROM check_gifts WHERE id = ? AND state IN ('creating', 'unsure')").bind(held.check_id).first();
    if (saving || Date.parse(held.at) > now - CLAIM_MS || !(await clearTag(env, held, fetchImpl))) throw later();
  }
  const mine = await env.DB.prepare('INSERT OR IGNORE INTO check_tags (contact, email, check_id, at) VALUES (?, ?, ?, ?)').bind(contact, tag, checkId, new Date(now).toISOString()).run();
  if (!mine.meta?.changes) throw later();
  let joined = false;
  try {
    await zeffySend(env, 'PATCH', `/contacts/${encodeURIComponent(contact)}`, { email: tag }, fetchImpl);
    joined = true;
  } catch (e) {
    // Zeffy not answering, or answering "later": nothing is saved, and the check is tried again on a later run
    if (!e.status || e.status >= 500 || e.status === 429) {
      await clearTag(env, { email: tag, contact }, fetchImpl).catch(() => null);
      throw Object.assign(new Error('Zeffy didn’t answer about this giver'), { later: true, status: 429 });
    }
    /* refused outright: the record goes in under its own contact, as it would without this */
  }
  let unanswered = false;
  try {
    const p = await zeffySend(env, 'POST', '/payments', joined ? { ...record, email: tag } : record, fetchImpl);
    // Filed under a new contact after all: the giver's own contact is still the one to remember, and the address comes off that one too
    if (p && (!joined || String(p.contact) !== String(contact))) {
      p.newContact = true;
      if (joined && p.contact) await clearTag(env, { email: tag, contact: String(p.contact) }, fetchImpl, { keepRow: true }).catch(() => null);
    }
    return p;
  } catch (e) {
    unanswered = !e.status || e.status >= 500;
    throw e;
  } finally {
    // No answer: Zeffy may still be saving it, by that address. It comes off once the check is settled (clearTags)
    if (!unanswered) await clearTag(env, { email: tag, contact }, fetchImpl).catch(() => null);
  }
}

/** Takes the address off, only while it's still the one the site put on: an email someone typed since stays */
async function clearTag(env, tag, fetchImpl, { keepRow = false } = {}) {
  let c = null;
  try {
    c = await zeffyGet(env, `/contacts/${encodeURIComponent(tag.contact)}`, {}, fetchImpl);
  } catch (e) {
    if (e.status !== 404) return false;
  }
  if (c && clean(c.email).toLowerCase() === tag.email.toLowerCase()) {
    try { await zeffySend(env, 'PATCH', `/contacts/${encodeURIComponent(tag.contact)}`, { email: null }, fetchImpl); } catch { return false; }
  }
  if (keepRow) return true;
  await env.DB.prepare('DELETE FROM check_tags WHERE email = ?').bind(tag.email).run();
  if (tag.alerted && env.SLACK_BOT_TOKEN) {
    const words = 'The no-mail address is off the donor’s contact.';
    await slackResolved(env, `check-tag:${tag.email}`, slackCard({ icon: '✅', title: 'A donor’s contact in Zeffy', lead: words }), { summary: words }).catch(() => null);
  }
  return true;
}

/** Every run: an address still on a contact comes off, and one stuck there a day goes to a person, once */
async function clearTags(env, { now, fetchImpl }) {
  // Never one a save is using right now: that save takes it off itself
  const tags = (await env.DB.prepare(`SELECT t.* FROM check_tags t WHERE t.at < ? AND NOT EXISTS (SELECT 1 FROM check_gifts c WHERE c.id = t.check_id AND c.state IN ('creating', 'unsure')) ORDER BY t.at LIMIT 5`)
    .bind(new Date(now - CLAIM_MS).toISOString()).all()).results || [];
  for (const tag of tags) {
    if (await clearTag(env, tag, fetchImpl)) continue;
    if (tag.alerted || now - Date.parse(tag.at) < TAG_ALARM_MS || !env.SLACK_BOT_TOKEN) continue;
    // (the lock is the contact, so a stuck one also keeps that giver's next check waiting: a person is told)
    const card = slackCard({
      icon: '🧾', title: 'A donor’s contact in Zeffy has the site’s no-mail address',
      lead: `The site put ${tag.email} on a donor’s contact for a moment, to keep a check with their other gifts, and Zeffy won’t let it take the address off.`,
      fix: `In Zeffy, find the contact with the email ${tag.email} and delete that email. It reaches no one, so nothing has been sent.`,
      buttons: [{ label: 'Open Zeffy', url: ZEFFY_CONTACTS }],
    });
    const r = await slackIssue(env, `check-tag:${tag.email}`, card, { title: 'A donor’s contact in Zeffy', kind: 'attention' }).catch(() => null);
    if (r?.ok) await env.DB.prepare('UPDATE check_tags SET alerted = 1 WHERE email = ?').bind(tag.email).run();
  }
}

/**
 * One POST for one check. The row is claimed first and the exact record kept on it, so a run cut off here is found by
 * settleUnsure. Zeffy has no way to refuse a repeat: when it may have acted, this never sends it again.
 */
async function createRecord(env, row, record, { from, mode, now, fetchImpl, by = null, learnWith = null, join = null }) {
  const iso = new Date(now).toISOString();
  const claim = await env.DB.prepare(`UPDATE check_gifts SET state = 'creating', payload = ?, try_at = ?, updated_at = ? WHERE id = ? AND state = ?`)
    .bind(JSON.stringify({ ...record, ...(join ? { join } : {}), ...(by ? { by } : {}) }), iso, iso, row.id, from).run();
  if (!claim.meta?.changes) return { result: 'busy' };
  let p;
  try {
    p = join ? await postJoined(env, join, record, { tag: tagFor(row.id, now), now, fetchImpl, checkId: row.id }) : await zeffySend(env, 'POST', '/payments', record, fetchImpl);
  } catch (e) {
    // Not saved: a later run tries again, and this check waits at the back of the line, so one giver never holds up the rest
    if (e.status === 429 || e.later || (e.status === 500 && e.code)) { await setRow(env.DB, row.id, { state: from, payload: null, try_at: iso }, now, 'creating'); return { result: 'later' }; }
    if (e.status && e.status < 500) {
      await toPerson(env, { ...row, state: 'creating' }, 'zeffy-refused', { note: refusalWords(e), mode, now });
      await setRow(env.DB, row.id, { payload: null }, now);
      return { result: 'refused', error: refusalWords(e) };
    }
    // A timeout or a gateway's 5xx: it may have saved. settleUnsure looks for it
    await setRow(env.DB, row.id, { state: 'unsure', try_at: iso }, now, 'creating');
    return { result: 'unsure' };
  }
  if (!p?.id) {
    await setRow(env.DB, row.id, { state: 'unsure', try_at: iso }, now, 'creating');
    return { result: 'unsure' };
  }
  // Filed somewhere other than the giver's own contact: that contact is still the one to remember
  if (join && String(p.contact) !== String(join)) p.newContact = true;
  // A check Mercury sent back while this was saving keeps "came back", and now has its record to cancel
  await env.DB.prepare(`UPDATE check_gifts SET state = CASE WHEN state = 'creating' THEN 'created' ELSE state END, via = ?, zeffy_id = ?, reason = CASE WHEN state = 'creating' THEN NULL ELSE reason END, by = ?, form_id = ?, payload = NULL, address_done = NULL, address_at = NULL, updated_at = ? WHERE id = ?`)
    .bind(by ? 'person' : 'site', String(p.id), by, record.campaign_id, iso, row.id).run();
  await teach(env.DB, learnWith?.name || row.payer, { contactId: p.newContact ? null : p.contact || null, campaignId: record.campaign_id, by: by || 'site' }, now);
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
    const sentDay = String(sent?.payment_date || '').slice(0, 10);
    let payments;
    try {
      payments = await paymentsSince(env, Math.max(secondsOf(isDay(sentDay) && sentDay < dayOf(row.deposited_at) ? sentDay : dayOf(row.deposited_at)) - LOOK_BACK_S, Math.floor(now / 1000) - NET_S), fetchImpl);
    } catch {
      continue; // Zeffy didn't answer: the next run looks again, and the rest of this run goes on
    }
    const name = sent ? clean(`${sent.first_name} ${sent.last_name}`) : row.payer;
    const sentAt = Date.parse(sent?.payment_date || '') / 1000;
    const hit = payments.find((p) => !claimed.has(String(p.id)) && Number(p.amount) === Number(row.cents)
      && String(p.campaign_id) === String(sent?.campaign_id) && paidByCheck(p)
      // Filed under the giver's contact, it may carry the names Zeffy already had for them
      && (namesOn(p).some((n) => sameGiver(name, n) || sameGiver(row.payer, n)) || (sent?.join && String(p.contact) === String(sent.join)))
      // Last month's gift from the same giver is another gift: only a record dated as this one was sent can be it
      && Math.abs(Number(p.created) - sentAt) <= 2 * 86400);
    if (hit) {
      // A person's save that Zeffy answered late is still theirs
      if (await setRow(env.DB, row.id, { state: 'created', via: sent?.by ? 'person' : 'site', ...(sent?.by ? { by: sent.by } : {}), zeffy_id: String(hit.id), reason: null, payload: null, address_done: null, address_at: null }, now, row.state)) {
        await teach(env.DB, row.payer, { contactId: sent?.join || (namesOn(hit).some((n) => sameGiver(row.payer, n)) ? hit.contact : null) || null, campaignId: hit.campaign_id || null, by: 'site' }, now);
        await handlePayment(env, hit, { via: 'check', now }).catch(() => null);
      }
    } else if (now - Date.parse(row.try_at || row.updated_at) > UNSURE_AFTER_MS) {
      await toPerson(env, row, 'unsure', { mode: 'on', now });
    } else if (row.state === 'creating') {
      await setRow(env.DB, row.id, { state: 'unsure' }, now, 'creating');
    }
  }
}

// ─── The steps ──────────────────────────────────────────────────────

/** New deposits get a row; each one not final is read again by id */
async function pull(env, { now, fetchImpl, cfg }) {
  const iso = new Date(now).toISOString();
  const fresh = (await env.DB.prepare(`SELECT t.id, t.account_id, t.status, t.cents, t.created_at, t.posted_at, t.check_number, t.link FROM mercury_txns t
    LEFT JOIN check_gifts c ON c.id = t.id WHERE t.kind = 'checkDeposit' AND t.cents > 0 AND c.id IS NULL ORDER BY t.created_at LIMIT 25`).all()).results || [];
  // Which account is the store's: unknown for a moment (the database didn't answer), a new deposit waits for the next run
  // rather than a store deposit being taken for a gift
  let buckets = null;
  if (fresh.length) buckets = await readSpendConfig(env.DB).then((c) => c?.accountBuckets || {}, () => null);
  if (fresh.length && buckets) {
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
    try {
      txn = await getTransaction(env, row.id, { fetchImpl });
    } catch (e) {
      lastError = e;
      if (e.status === 404) {
        const gone = now - Date.parse(row.deposited_at) > 3 * DAY;
        await setRow(env.DB, row.id, { looked_at: new Date(now).toISOString(), ...(gone ? { final: 1 } : {}) }, now);
        if (gone) await tell(env, row, 'mercury-404', { title: `Mercury no longer shows a check: ${money(row.cents)}`, lead: 'Mercury answers that it has no such deposit.', fix: 'Look for it in Mercury. If it’s there, tell Peter.' });
      }
      continue;
    }
    reached++;
    await mirrorTransaction(env.DB, txn, { now }).catch(() => null);
    await lookAgain(env, row, txn, { now });
  }
  // Mercury not answering at all stops the alarms above, so the run says so when it ends. The rest of the run goes on
  return rows.length && !reached && lastError?.status !== 404 ? lastError : null;
}

const DEAD = new Set(['cancelled', 'failed', 'reversed']);
const camePayBack = (txn) => (txn?.relatedTransactions || []).some((r) => /^(OriginalTransactionToReturn|ReturnToOriginalTransaction)$/.test(String(r?.relationKind || '')));

async function lookAgain(env, seen, txn, { now }) {
  const iso = new Date(now).toISOString();
  // As it is now, not as the list read it: a save or an answer may have landed since
  const row = (await getRow(env.DB, seen.id)) || seen;
  // A letter the team attached since the last look is read before the check is decided, or put to use after
  if (row.state !== 'store') await noteLetters(env, row, txn, now);
  // Left out for its category, and since marked a contribution in Mercury: decided again
  if (row.state === 'left-out' && row.reason === 'category' && isContribution(txn?.categoryData?.name)) {
    await setRow(env.DB, row.id, { state: 'read', reason: null, note: null, try_at: null }, now, 'left-out');
  }
  const status = String(txn?.status || row.status || '');
  const patch = { status, posted_at: txn?.postedAt || row.posted_at, looked_at: iso };
  // Mercury can correct an amount when it reviews a check, and the record has to say what really came in
  const corrected = Number(txn?.amount) > 0 && toCents(txn.amount) !== Number(row.cents) ? toCents(txn.amount) : null;
  if (corrected) patch.cents = corrected;
  if (corrected && row.zeffy_id && ['created', 'linked'].includes(row.state)) {
    patch.reason = 'amount-off';
    await tell(env, { ...row, cents: corrected }, 'amount-corrected', { title: `Mercury changed a check’s amount: ${money(corrected)}`, lead: `The check was saved in Zeffy as ${money(row.cents)}, and Mercury says ${money(corrected)} came in.`, fix: 'Fix the amount in Zeffy. Checks shows it until it matches.' });
  }
  const back = DEAD.has(status) || camePayBack(txn);
  const known = status === 'pending' || status === 'sent';
  // Mercury holding a check may still release it: nobody touches Zeffy for it, and it goes on as it was once released
  if (status === 'blocked' && !back) {
    await setRow(env.DB, row.id, { ...patch, final: 0 }, now);
    await tell(env, row, 'blocked', { title: `Mercury is holding a check: ${money(row.cents)}`, lead: 'Mercury shows this check as blocked. It may still be released.', fix: 'Leave Zeffy as it is. Check it in Mercury, and the site says if it comes back.' });
    return;
  }
  if (back || !known) {
    // Blocked may yet be released, so it's looked at again; the others are the end of it
    // A check a person left out, or the store's, stays what it was: a block lifted later doesn't make it a gift
    const stays = !back || (['left-out', 'store'].includes(row.state) && !row.zeffy_id);
    if (!(await setRow(env.DB, row.id, { ...patch, final: back && status !== 'blocked' ? 1 : 0, state: stays ? row.state : 'came-back', reason: stays ? row.reason : 'back' }, now, row.state))) return;
    const turnedDown = back && !row.posted_at && !txn?.postedAt;
    await tell(env, row, back ? 'back' : `status-${status}`, back
      ? { title: turnedDown ? `Mercury turned down a check: ${money(row.cents)}` : `A check came back: ${money(row.cents)}`,
        lead: `${turnedDown ? 'Mercury didn’t accept this check when it reviewed it' : 'Mercury says this check didn’t go through'}${row.zeffy_id ? ', and the site had already saved it in Zeffy.' : '.'}`,
        fix: row.zeffy_id ? 'Cancel the record in Zeffy: no money came in for it.' : 'Nothing to do in Zeffy.' }
      : { title: `A check needs a look: ${money(row.cents)}`, lead: `Mercury shows this check as “${status}”.`, fix: 'Check it in Mercury.' });
    return;
  }
  // A check blocked and then released goes on from where it was
  if (row.status === 'blocked' && status !== 'blocked') await allClear(env, row, 'Mercury released it.');
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
  await noteLetters(env, row, txn, now);
  const hint = mercuryPayer(txn);
  const number = clean(txn?.checkNumber || row.check_number);
  if (number !== clean(row.check_number)) await setRow(env.DB, row.id, { check_number: number }, now);

  const done = async (read, shape) => {
    const address = read.address ? JSON.stringify({ ...read.address, from: 'check', for: read.payer }) : null;
    // drawer: who wrote the check, kept apart from payer (who the gift is from), which a letter or a person can change
    if (!(await setRow(env.DB, row.id, { state: 'read', payer: read.payer, drawer: read.payer || null, check_date: read.date || null, memo: read.memo || null, address, shape, try_at: null }, now, 'new'))) return { result: 'moved' };
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
      await setRow(env.DB, row.id, { shape, tries: 0, try_at: new Date(now + 58 * MIN).toISOString() }, now);
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
  // Both readers have to agree, so one that errors is an outage too: the try is given back, and the staff hear if it lasts
  const down = reads.filter((r) => r === DOWN).length;
  if (down) {
    await setRow(env.DB, row.id, { tries: Math.max(0, tries - 1) }, now);
    throw Object.assign(new Error(down === reads.length ? 'The check readers didn’t answer' : 'A check reader didn’t answer'), { readers: true });
  }
  const read = proveRead(reads, { cents: row.cents, checkNumber: number, hint });
  return read.ok ? done(read, shape) : giveUp(read.why, shape);
}

/** What the site would do, kept beside the hand entry so the two can be scored */
const guessOf = (row, v) => JSON.stringify({ do: v.do, reason: v.reason || null, formId: v.form?.id || null, formTitle: v.form?.title || null, payer: row.payer || null });

async function linkTo(env, row, p, { by = null, now, fetchImpl = fetch }) {
  const iso = new Date(now).toISOString();
  // The same check deposited again after it came back takes over its record (one record, one good deposit)
  const bounced = await env.DB.prepare("SELECT * FROM check_gifts WHERE zeffy_id = ? AND state = 'came-back' AND id != ?").bind(String(p.id), row.id).first();
  if (bounced) await env.DB.prepare('UPDATE check_gifts SET zeffy_id = NULL, updated_at = ? WHERE id = ?').bind(iso, bounced.id).run();
  const giveBack = async () => { if (bounced) await env.DB.prepare('UPDATE check_gifts SET zeffy_id = ? WHERE id = ? AND zeffy_id IS NULL').bind(String(p.id), bounced.id).run().catch(() => null); };
  let guess = {};
  try { guess = JSON.parse(row.guess || '{}'); } catch { /* an old row */ }
  const score = guess.do ? JSON.stringify({
    payer: namesOn(p).some((n) => sameGiver(row.payer, n) || (row.drawer && sameGiver(row.drawer, n))),
    form: guess.formId ? guess.formId === String(p.campaign_id) : null,
    gift: guess.do === 'create' || guess.do === 'link',
  }) : null;
  try {
    const fields = {
      state: 'linked', via: by ? 'person' : 'hand', zeffy_id: String(p.id), note: `entry:${JSON.stringify(entriesToShow([p])[0])}`, by, score,
      // A new record: its donor is looked at for the address
      address_done: null, address_at: null,
      payer: row.payer || namesOn(p)[0] || null,
      reason: Number(p.amount) !== Number(row.cents) ? 'amount-off' : String(p.status || '').toLowerCase() === 'succeeded' ? null : 'still-unpaid',
      form_id: String(p.campaign_id || ''), form_title: clean(p.description) || null, updated_at: iso,
    };
    const keys = Object.keys(fields);
    // Only while the check is still as it was read: a save or another match since keeps its own
    const r = await env.DB.prepare(`UPDATE check_gifts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND state = ?`).bind(...keys.map((k) => fields[k]), row.id, row.state).run();
    if (!r.meta?.changes) { await giveBack(); return false; }
  } catch {
    await giveBack();
    return false; // another check holds that record
  }
  if (bounced) await allClear(env, bounced, 'It was deposited again and went through: its Zeffy record now belongs to that deposit. Don’t cancel it.');
  // A check matched to an entry under someone else's name (a fund's advisor, a donor's promise) says nothing about whose contact
  // this payer is. The contact is the payer's own only when Zeffy's contact itself carries the payer's name: a fund's grant
  // typed under the fund's name but with its advisor's email sits on the advisor's contact
  // The entry teaches the name it's under: one found under the check writer's name (a letter naming someone else) is theirs
  const learner = !namesOn(p).some((n) => sameGiver(row.payer, n)) && row.drawer && namesOn(p).some((n) => sameGiver(row.drawer, n)) ? row.drawer : row.payer;
  let theirs = false;
  if (p.contact && sameGiver(learner, givenName(p.buyer))) {
    const c = await zeffyGet(env, `/contacts/${encodeURIComponent(p.contact)}`, {}, fetchImpl).catch(() => null);
    theirs = !!c && sameGiver(learner, givenName({ first_name: c.first_name, last_name: c.last_name }));
  }
  await teach(env.DB, learner, { contactId: theirs ? p.contact || null : null, campaignId: p.campaign_id || null, by: by || 'hand entry' }, now);
  await allClear(env, row, 'Matched to its Zeffy record.');
  return true;
}

/** A check that's read and posted: link it, make it, or say why not */
export async function decideCheck(env, row, { mode, now, fetchImpl, gift = false }) {
  // A file attached in Mercury since the last look is read before anything is decided. Mercury not answering waits, unless
  // the check was looked at in the last few minutes (pull reads every check under review each run)
  // Best effort: Mercury not answering never holds a check up (the run's own look at Mercury reports that)
  const txn = await getTransaction(env, row.id, { fetchImpl }).catch(() => null);
  if (txn && row.state !== 'store' && await noteLetters(env, row, txn, now)) return { result: 'letter' };
  if (lettersWaiting(row)) return { result: 'letter' };
  // Each file read is still the file that was read: a letter swapped for another under the same name is read again first
  if (txn && await verifyLetters(env, row, txn, now, fetchImpl)) return { result: 'letter' };
  // Only a check marked as a contribution in Mercury goes into Zeffy. None yet: it waits (asked again in 15 minutes, nothing
  // read from Zeffy meanwhile). Any other category: left out, and it comes back if the category changes
  const category = await categoryOf(env, row, txn);
  if (!category) {
    await setRow(env.DB, row.id, { try_at: new Date(now).toISOString() }, now, row.state);
    return { result: 'category' };
  }
  if (!isContribution(category)) {
    if (!(await setRow(env.DB, row.id, { state: 'left-out', reason: 'category', note: category }, now, row.state))) return { result: 'moved' };
    return { result: 'left-out', reason: 'category' };
  }
  row = { ...row, category };
  // Who the gift is from: the letter's giver when it names one (the source of truth), else who wrote the check. The check's
  // name is kept as the drawer, so Zeffy's entries under either name are found (matchBoth)
  // A name a person gave this check stands, letter or not: they've seen it
  const said = row.by && row.payer ? {} : letterSays(row);
  if (said.why) {
    await toPerson(env, row, said.why, { mode, now });
    return { result: 'person', reason: said.why };
  }
  const own = checkName(row);
  const giver = (row.by && row.payer) || said.name || own || null;
  const drawer = own || null;
  if ((giver || null) !== (row.payer || null) || drawer !== (row.drawer || null)) {
    if (!(await setRow(env.DB, row.id, { payer: giver, drawer }, now, row.state))) return { result: 'moved' };
    row = { ...row, payer: giver, drawer };
  }
  const [{ payments, whole }, forms, claimed, learned, vendor, drawerLearned] = await Promise.all([
    readWide(env, secondsOf(earliestDay(row)) - LOOK_BACK_S, now, fetchImpl),
    openForms(env, fetchImpl),
    claimedIds(env.DB),
    row.payer ? learnedFor(env.DB, row.payer) : null,
    row.payer ? isVendor(env.DB, row.payer) : false,
    row.drawer ? learnedFor(env.DB, row.drawer) : null,
  ]);
  const v = judge(row, { payments, claimed, forms, learned, drawerLearned, isVendor: vendor, gift });
  // What it would have used is worked out even when a hand entry settles it, so the two can be compared
  const guess = guessOf(row, { ...v, form: v.form || (row.payer ? pickForm(row, forms, learned) : null) });
  if (v.do === 'link') {
    await setRow(env.DB, row.id, { guess: row.guess || guess }, now);
    await linkTo(env, { ...row, guess: row.guess || guess }, v.payment, { now, fetchImpl });
    return { result: 'linked' };
  }
  // A check that goes to a person keeps the form the site would have used, so their entry starts on it
  const wouldUse = v.form || (row.payer ? pickForm(row, forms, learned) : null);
  if (!(await setRow(env.DB, row.id, { guess, form_id: wouldUse?.id || null, form_title: wouldUse?.title || null }, now, row.state))) return { result: 'moved' };
  if (v.do === 'left-out') {
    if (!(await setRow(env.DB, row.id, { state: 'left-out', reason: v.reason }, now, row.state))) return { result: 'moved' };
    if (mode === 'on') await tell(env, row, 'left-out', { title: `A check was left out of Zeffy: ${money(row.cents)}`, lead: LEFT_OUT[v.reason], fix: 'Nothing to do unless it’s really a gift. Then say so on Checks.' });
    return { result: 'left-out', reason: v.reason };
  }
  if (v.do === 'person') {
    await toPerson(env, row, v.reason, { candidates: v.candidates || null, mode, now });
    return { result: 'person', reason: v.reason };
  }
  if (mode !== 'on') {
    return (await setRow(env.DB, row.id, { state: 'would' }, now, row.state)) ? { result: 'would' } : { result: 'moved' };
  }
  // Turned on with a check long posted that nobody entered: a person looks, rather than it going in unseen
  if (row.state === 'would' && now - Date.parse(row.posted_at || row.deposited_at) > OLD_CHECK_MS) {
    await toPerson(env, row, 'old-check', { mode, now });
    return { result: 'person', reason: 'old-check' };
  }
  // The same check number and amount deposited before (a check that bounced and came again, or one picture sent twice)
  if (row.check_number) {
    const twin = await env.DB.prepare(`SELECT * FROM check_gifts WHERE id != ? AND cents = ? AND check_number = ? AND deposited_at >= ? LIMIT 1`)
      .bind(row.id, row.cents, row.check_number, new Date(now - 180 * DAY).toISOString()).first();
    if (twin) {
      const theirs = twin.zeffy_id ? payments.filter((p) => String(p.id) === String(twin.zeffy_id)) : [];
      await toPerson(env, row, 'redeposit', { candidates: theirs.length ? entriesToShow(theirs) : null, note: theirs.length ? null : REASONS.redeposit, mode, now });
      return { result: 'person', reason: 'redeposit' };
    }
  }
  // The wide look: the site makes a record only when nothing in Zeffy, under any name, could be this check
  const net = netBoth(row, payments, claimed, { learned, drawerLearned, ...(await freshFor(env, row, await readState(env.DB, KEY))) });
  if (!whole && !net.length) {
    await toPerson(env, row, 'look-by-hand', { mode, now });
    return { result: 'person', reason: 'look-by-hand' };
  }
  if (net.length) {
    await toPerson(env, row, 'maybe-double', { candidates: entriesToShow(net), mode, now });
    return { result: 'person', reason: 'maybe-double' };
  }
  let who;
  try {
    who = await learnedContact(env, learned, fetchImpl);
  } catch (e) {
    if (!e.later) throw e;
    // Waits at the back of the line, so this giver never holds up the other checks
    await setRow(env.DB, row.id, { try_at: new Date(now).toISOString() }, now, row.state);
    return { result: 'later' };
  }
  // The letter's email files the record only on the giver's own donor in Zeffy; otherwise it's added to the donor after (writeAddresses)
  let mail = '';
  if (!who.email && !who.join) {
    try {
      mail = await letterMail(env, row, row.payer, fetchImpl);
    } catch {
      await setRow(env.DB, row.id, { try_at: new Date(now).toISOString() }, now, row.state);
      return { result: 'later' };
    }
  }
  const join = mail ? null : await joinable(env, who);
  const record = { ...recordFor(row, { name: row.payer, form: v.form, email: mail || who.email, now }), ...(mail ? {} : who.names) };
  return createRecord(env, row, record, { from: row.state, mode, now, fetchImpl, join });
}

/** One record against Zeffy now: what it asked staff to fix clears itself once it's fixed, and a record that's gone says so. It's never made again by itself */
async function lookAtRecord(env, row, known, { mode, now, fetchImpl, payments = [], claimed = new Set() }) {
  let p = known;
  if (!p) {
    try {
      p = await zeffyGet(env, `/payments/${encodeURIComponent(row.zeffy_id)}`, {}, fetchImpl);
    } catch (e) {
      if (e.status !== 404) return false; // couldn't tell: the next look can
    }
  }
  const gone = !p || /cancel/.test(String(p.status || '').toLowerCase());
  if (gone && row.state === 'came-back') { await setRow(env.DB, row.id, { zeffy_id: null }, now); await allClear(env, row, 'Cancelled in Zeffy.'); return true; }
  if (gone) {
    const rejected = JSON.stringify([...rejectedBy(row), String(row.zeffy_id)]);
    // Zeffy can't edit a payment, so staff fix one by deleting it and typing it again: that entry is now this check's record
    const again = matchBoth(row, payments, claimedFor({ ...row, rejected }, claimed)).same[0];
    if (again && await linkTo(env, { ...row, rejected }, again, { now, fetchImpl })) { claimed.add(String(again.id)); return true; }
    await toPerson(env, { ...row, alerted: null }, 'record-gone', { mode, now });
    await setRow(env.DB, row.id, { zeffy_id: null, via: null, rejected }, now);
    return true;
  }
  if (row.state === 'came-back' || !['amount-off', 'still-unpaid'].includes(row.reason)) return false;
  const reason = Number(p.amount) !== Number(row.cents) ? 'amount-off' : String(p.status || '').toLowerCase() === 'succeeded' ? null : 'still-unpaid';
  if (reason !== row.reason) await setRow(env.DB, row.id, { reason, note: `entry:${JSON.stringify(entriesToShow([p])[0])}` }, now, row.state);
  return false;
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

  // Waiting on an entry stays open for 150 days; the rest for the 60 days Mercury is still being watched. Newest first, so
  // a pile of old ones never holds up this week's, and the read of Zeffy never runs past what it can read whole
  const since = new Date(now - MATCH_MAX_AGE_MS).toISOString();
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE (state IN ('would', 'person') OR (state IN ('left-out', 'store', 'created') AND final = 0)) AND deposited_at >= ? ORDER BY deposited_at DESC LIMIT 100`).bind(since).all()).results || [];
  // A record in Zeffy can change after it's matched: fixed, marked paid, moved or deleted
  const kept = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE zeffy_id IS NOT NULL AND (final = 0 OR state = 'came-back') AND deposited_at >= ? ORDER BY deposited_at DESC LIMIT 100`).bind(since).all()).results || [];
  // Read or not, posted 10 days ago and still not finished: said once, so a stuck check is never silent
  const stuck = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state IN ('new', 'read') AND status = 'sent' AND posted_at < ? AND deposited_at >= ? LIMIT 20`)
    .bind(new Date(now - NO_RECORD_ALARM_MS).toISOString(), since).all()).results || [];
  for (const row of stuck) {
    // One still waiting for its Category in Mercury isn't stuck on Zeffy: it's waiting to be marked a contribution
    const unmarked = !isContribution(await categoryOf(env, row));
    await tell(env, row, 'stuck', unmarked
      ? { title: `A check isn’t marked in Mercury: ${money(row.cents)}`, lead: `This check posted more than 10 days ago and its Category in Mercury isn’t ${GIFT_WORDS}, so it isn’t in Zeffy.`, fix: 'If it’s a gift, set its Category in Mercury and it goes into Zeffy that evening. If it isn’t, say so on Checks.' }
      : { title: `A check isn’t finished: ${money(row.cents)}`, lead: 'This check posted more than 10 days ago and the site hasn’t finished it. Zeffy or Mercury may not be answering.', fix: 'Enter it in Zeffy by hand, and it links itself within the hour.' });
  }
  // The whole 400 days every hour, checks open or not: the site's record of when each payment showed up stays current, so
  // the wide look can tell an entry typed this week from one typed long ago
  const recent = await paymentsSince(env, Math.floor(now / 1000) - NET_S, fetchImpl);
  await noteSeen(env, recent, now);
  const recentIds = new Set(recent.map((p) => String(p.id)));
  const payments = [...recent, ...(await openPledges(env, fetchImpl).catch(() => [])).filter((p) => !recentIds.has(String(p.id)))];
  if (!rows.length && !kept.length) return;
  const cfg = await readState(env.DB, KEY);
  const claimed = await claimedIds(env.DB);
  const byId = new Map(payments.map((p) => [String(p.id), p]));
  // A check changed here is looked at again next hour, not from what it was a moment ago
  const changed = new Set();
  for (const row of kept) if (await lookAtRecord(env, row, byId.get(String(row.zeffy_id)) || null, { mode, now, fetchImpl, payments, claimed })) changed.add(row.id);
  // No form fitted: once one is open again, the check is decided again
  let forms = null;
  if (rows.some((r) => r.state === 'person' && r.reason === 'no-form')) forms = await openForms(env, fetchImpl).catch(() => null);
  // Staff catching up a giver's months on one day: one entry fits more than one check, so none of them takes it by itself
  const learnedOf = new Map();
  const wanted = new Map();
  for (const row of rows) {
    if (changed.has(row.id) || !['would', 'person'].includes(row.state)) continue;
    const learned = row.payer ? await learnedFor(env.DB, row.payer) : null;
    learnedOf.set(row.id, learned);
    const m = matchBoth(row, payments, claimedFor(row, claimed), learned, row.drawer ? await learnedFor(env.DB, row.drawer) : null);
    // Only checks from that giver: another donor's same-amount check is no reason to doubt a name that fits
    for (const p of [...m.same, ...m.maybe].filter((x) => namesOn(x).some((n) => sameGiver(row.payer, n) || (row.drawer && sameGiver(row.drawer, n))))) wanted.set(String(p.id), (wanted.get(String(p.id)) || 0) + 1);
  }
  for (const row of rows) {
    if (changed.has(row.id)) continue;
    if (row.state === 'person' && row.reason === 'no-form') {
      if (forms && pickForm(row, forms, await learnedFor(env.DB, row.payer || ''))) { await setRow(env.DB, row.id, { state: 'read', reason: null }, now, 'person'); continue; }
    }
    // A person said it isn't a gift: nothing here changes that
    if (row.state === 'left-out' && row.reason === 'person') continue;
    const m = matchBoth(row, payments, claimedFor(row, claimed), learnedOf.has(row.id) ? learnedOf.get(row.id) : row.payer ? await learnedFor(env.DB, row.payer) : null, row.drawer ? await learnedFor(env.DB, row.drawer) : null);
    const shared = m.same.filter((p) => (wanted.get(String(p.id)) || 0) > 1);
    if (shared.length && ['would', 'person'].includes(row.state)) { m.maybe.push(...shared); m.same = m.same.filter((p) => !shared.includes(p)); }
    if (row.state === 'created') {
      // Typed by hand as well, under the check's name or another (a fund's check is often typed under its advisor's); or a
      // pledge marked paid since the site saved it, which this check may have paid
      const since = await freshSince(env.DB, Math.floor(Date.parse(row.posted_at || row.deposited_at) / 1000) - 86400);
      const waiting = await openAmounts(env.DB, row.id, now);
      const typed = [...new Map([...m.same, ...m.maybe, ...m.other, ...netBoth(row, payments, claimedFor(row, claimed), { turnedPaid: since })].map((p) => [String(p.id), p])).values()]
        .filter((p) => String(p.status || '').toLowerCase() === 'succeeded' && paidByCheck(p) && (madeByHand(p) || since.has(String(p.id))) && !waiting.has(Number(p.amount)));
      if (typed.length) await tell(env, row, 'double', { title: `This check may be in Zeffy twice: ${money(row.cents)}`, lead: m.same.length ? 'The site made a record for this check, and someone entered it by hand too.' : `The site made a record for this check, and Zeffy has a hand entry for the same amount${namesOn(typed[0])[0] ? ` under ${namesOn(typed[0])[0]}` : ''}. It may be the same check.`, fix: 'If it is, delete the extra one in Zeffy. If that record has an email on it, Zeffy may tell the donor, so keep the one with the email.' });
      continue;
    }
    if (['pending', 'sent'].includes(row.status) && m.same.length && await linkTo(env, row, m.same[0], { now, fetchImpl })) { claimed.add(String(m.same[0].id)); continue; }
    if (row.state === 'store') continue;
    // A hand entry under another name: one press from being matched
    const likely = [...m.promised, ...m.maybe, ...m.other];
    if (likely.length && (row.state === 'person' || row.state === 'would')) {
      await setRow(env.DB, row.id, { state: 'person', reason: row.state === 'person' ? row.reason : m.promised.length ? 'pledge' : m.maybe.length ? 'maybe-double' : 'amount-differs', note: JSON.stringify(entriesToShow(likely)) }, now, row.state);
      continue;
    }
    // What it was asked about has gone (matched to another check, or deleted): it goes back to being decided. An entry only
    // the wide look found is still there, still unclaimed: the question stands
    const asked = (() => { try { return row.note?.startsWith('[') ? JSON.parse(row.note).map((x) => String(x.id)) : []; } catch { return []; } })();
    const standing = asked.some((id) => byId.has(id) && !claimedFor(row, claimed).has(id));
    if (row.state === 'person' && ASKS_ABOUT_ENTRIES.includes(row.reason) && !standing) { await setRow(env.DB, row.id, { state: 'read', reason: null, note: null }, now, 'person'); continue; }
    if (row.state === 'person' && standing) continue;
    if (row.state === 'person' && row.note?.startsWith('[')) await setRow(env.DB, row.id, { note: null }, now, 'person');
    if (row.state === 'person' && mode === 'on') await tell(env, row, row.reason, { title: `A check needs a look: ${money(row.cents)}`, lead: REASONS[row.reason] || '', fix: 'Open Checks in Job Costs.' });
    const posted = Date.parse(row.posted_at || row.deposited_at);
    if (row.state !== 'left-out' && row.status === 'sent' && now - posted > NO_RECORD_ALARM_MS) {
      // Before saying Zeffy has nothing: anything the wide look finds is put to a person, one press from being matched
      const net = row.state === 'would' ? netBoth(row, payments, claimedFor(row, claimed), { learned: learnedOf.get(row.id) || null, ...(await freshFor(env, row, cfg)) }) : [];
      if (net.length) { await toPerson(env, row, 'maybe-double', { candidates: entriesToShow(net), mode, now }); continue; }
      await tell(env, row, 'no-record', { title: `A check isn’t in Zeffy: ${money(row.cents)}`, lead: 'This check posted more than 10 days ago and Zeffy has no record of it.', fix: 'Enter it in Zeffy, or say why not on Checks.' });
    }
  }
}

/** 7 PM Eastern on a day, as a time: the offset is the day's own, so it's right in summer and winter */
function eveningOf(day) {
  const noon = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(noon).find((x) => x.type === 'timeZoneName')?.value || 'GMT-5';
  const m = off.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  const hours = m ? Number(m[1]) + Math.sign(Number(m[1]) || 1) * (Number(m[2] || 0) / 60) : -5;
  return Date.parse(`${day}T${String(SAVE_HOUR).padStart(2, '0')}:00:00Z`) - hours * 3600e3;
}

/**
 * When a check the site decides by itself goes into Zeffy: 7 PM Eastern on the day it was deposited, so a letter the team
 * attaches in Mercury that day is read with it (Peter, Nov 10: "same day"). One deposited in the hour before waits a day
 */
export function saveAt(depositedAt) {
  const t = Date.parse(depositedAt || '');
  if (Number.isNaN(t)) return 0;
  const day = dayOf(depositedAt);
  const tonight = eveningOf(day);
  if (t + SAVE_GAP_MS <= tonight) return tonight;
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
  return eveningOf(next);
}
/** Ready for the site to decide: its evening has come (a person's answer never waits), and no letter is still being read */
const isDue = (row, now) => (!!row.by || now >= saveAt(row.deposited_at)) && !lettersWaiting(row);

// ─── The donor's address in Zeffy ───────────────────────────────────

/** When Zeffy first didn't answer about this address ('wait:<time>'), or null */
const waitingSince = (done) => Number(String(done || '').match(/^wait:(\d+)$/)?.[1] || 0) || null;

/**
 * The address (and a letter's email) onto the donor's Zeffy contact, once the gift's record is there: one check a run.
 * Only a contact under the giver's own name takes it. The letter's address always goes on; the check's replaces what
 * Zeffy has (the newest the donor gave us), except on a staff member's hand entry, where it only fills a blank. An email
 * only fills a blank: Zeffy keeps one a contact, and it's how Zeffy finds the donor. Nothing is sent to anyone
 */
export async function writeAddresses(env, { now, fetchImpl, mode, cfg }) {
  if (mode !== 'on' || !cfg?.writeTest?.address?.ok) return { result: 'off' };
  const iso = new Date(now).toISOString();
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE zeffy_id IS NOT NULL AND state IN ('created', 'linked') AND (address IS NOT NULL OR letter IS NOT NULL)
    AND ((address_done IS NULL OR address_done LIKE 'wait:%') AND (address_at IS NULL OR address_at < ?) OR (address_done = 'refused' AND address_at < ?)) ORDER BY address_at IS NOT NULL, address_at LIMIT 10`)
    .bind(new Date(now - ADDRESS_RETRY_MS).toISOString(), new Date(now - DAY).toISOString()).all()).results || [];
  const wants = (r) => { const l = letterSays(r); return !!(jsonOf(r.address) || l.address || l.email); };
  const row = rows.find(wants);
  // Nothing to put on: the rest are settled so they aren't read again
  for (const r of rows) if (r !== row && !wants(r)) await env.DB.prepare('UPDATE check_gifts SET address_done = ? WHERE id = ? AND address_done IS ?').bind('none', r.id, r.address_done ?? null).run();
  if (!row) return { result: 'quiet' };
  // Claimed by its try time, so two runs never write one donor at once
  const claim = await env.DB.prepare('UPDATE check_gifts SET address_at = ? WHERE id = ? AND address_at IS ? AND address_done IS ?').bind(iso, row.id, row.address_at ?? null, row.address_done ?? null).run();
  if (!claim.meta?.changes) return { result: 'busy' };
  const settle = (done) => env.DB.prepare('UPDATE check_gifts SET address_done = ? WHERE id = ? AND address_at = ? AND zeffy_id = ?').bind(done, row.id, iso, row.zeffy_id).run();
  const refused = row.address_done === 'refused';
  // Zeffy not answering: tried again in a while, and a day of it goes to a person
  const later = async () => {
    const since = waitingSince(row.address_done) || now;
    await settle(refused || now - since >= ADDRESS_GIVE_UP_MS ? 'refused' : `wait:${since}`);
    return { result: 'later' };
  };
  let p;
  try {
    p = await zeffyGet(env, `/payments/${encodeURIComponent(row.zeffy_id)}`, {}, fetchImpl);
  } catch (e) {
    if (e.status === 404) { await settle('gone'); return { result: 'gone' }; }
    return later();
  }
  if (!p?.contact) { await settle('gone'); return { result: 'gone' }; }
  let c;
  try {
    c = await zeffyGet(env, `/contacts/${encodeURIComponent(p.contact)}`, {}, fetchImpl);
  } catch (e) {
    if (e.status === 404) { await settle('gone'); return { result: 'gone' }; }
    return later();
  }
  // The site's no-mail address is on it for a moment while another check is filed (or about to be): its turn comes after
  const filing = await env.DB.prepare('SELECT 1 AS y FROM check_tags WHERE contact = ?').bind(String(p.contact)).first();
  if (filing || isTag(c?.email)) return later();
  // Whose donor this is, by the contact's own name, never the record's (a fund's gift typed under the fund's name can sit on
  // its advisor's contact), and surely, not nearly (North Atlanta Rotary Club's contact never takes Atlanta Rotary Club's mail)
  const names = [givenName({ first_name: c?.first_name, last_name: c?.last_name }), clean(`${clean(c?.first_name)} ${clean(c?.last_name)}`)].filter(Boolean);
  const theirs = (who) => !!who && names.some((n) => surelySameGiver(who, n));
  // The letter's address and email are its giver's (the check writer's when it names nobody); the check's address is its writer's
  const said = letterSays(row);
  const own = checkName(row);
  let addr = null;
  let email = '';
  if ((said.address || said.email) && theirs(said.name || own)) {
    addr = said.address ? { ...said.address, from: 'letter' } : null;
    email = said.email || '';
  }
  if (!addr && theirs(own) && jsonOf(row.address)) addr = { ...jsonOf(row.address), from: 'check' };
  if (!addr && !email) { await settle('not-theirs'); return { result: 'not-theirs' }; }
  // Turned down before, and someone has since put an address (and an email) on the donor by hand: done, whatever they typed
  if (refused && (!addr || c?.address?.line1) && (!email || clean(c?.email))) { await settle('by-hand'); return { result: 'by-hand' }; }
  const patch = {};
  const has = c?.address?.line1 ? c.address : null;
  if (addr) {
    const same = has && addressKey(has) === addressKey(addr);
    // An entry someone matched or typed (not one the site made) keeps the address on it: the check's only fills a blank
    const keep = has && !same && addr.from === 'check' && row.state === 'linked';
    if (!same && !keep) patch.address = { line1: addr.line1, city: addr.city, state: addr.state, postal_code: addr.postal_code, country: addr.country || 'US' };
    else if (keep && !email) { await settle('kept'); return { result: 'kept' }; }
  }
  if (email && !clean(c?.email)) patch.email = email;
  if (!Object.keys(patch).length) {
    const done = addr && has && addressKey(has) === addressKey(addr) ? 'same' : 'none';
    await settle(done);
    return { result: done };
  }
  // Re-checked once a day: it clears itself once it's in Zeffy, and the site doesn't try what Zeffy turned down again
  if (refused) return { result: 'refused' };
  // What it's putting on whom, so a person told to finish it by hand is told exactly that
  await env.DB.prepare('UPDATE check_gifts SET address_tried = ? WHERE id = ?').bind(JSON.stringify({ address: patch.address || null, email: patch.email || '', who: names[0] || '' }), row.id).run();
  const send = (body) => zeffySend(env, 'PATCH', `/contacts/${encodeURIComponent(p.contact)}`, body, fetchImpl);
  try {
    await send(patch);
  } catch (e) {
    if (!e.status || e.status >= 500 || e.status === 429) return later();
    // An email another donor already has: the address still goes on
    if (patch.email && patch.address && /email/i.test(`${e.code || ''} ${e.message || ''}`)) {
      try { await send({ address: patch.address }); } catch (e2) {
        if (!e2.status || e2.status >= 500 || e2.status === 429) return later();
        await settle('refused');
        return { result: 'refused' };
      }
      await settle('email-taken');
      return { result: 'email-taken' };
    }
    // Another donor in Zeffy holds the letter's email: said beside the check, nothing more to do
    if (patch.email && !patch.address && /email/i.test(`${e.code || ''} ${e.message || ''}`)) { await settle('email-taken-only'); return { result: 'email-taken-only' }; }
    await settle('refused');
    return { result: 'refused' };
  }
  const done = patch.address ? 'written' : addr && has && addressKey(has) === addressKey(addr) ? 'email-same' : 'email';
  await settle(done);
  return { result: done };
}

/**
 * The one-time test of writing to Zeffy, so turning this on isn't the first write: $1 records, read back and removed.
 * Three plain ones (skipped once an earlier test proved them), then one filed under a contact with no email (postJoined)
 */
export async function testWrite(env, { now = Date.now(), fetchImpl = fetch, cfg = null } = {}) {
  const at = new Date(now).toISOString();
  const prior = (cfg || await readState(env.DB, KEY)).writeTest;
  const report = { id: WRITE_TEST, at, ok: false, steps: [], tries: (prior?.id === WRITE_TEST && !prior.ok ? Number(prior.tries) || 1 : 0) + 1 };
  const made = [];
  const send = async (body) => {
    const p = await zeffySend(env, 'POST', '/payments', body, fetchImpl);
    if (!p?.id) throw new Error('Zeffy answered without a payment id');
    made.push(p);
    return p;
  };
  const contacts = new Set();
  let base = null;
  // The form to test on, read only when a step makes a record: a test that only tries the address never asks Zeffy for forms
  const needBase = async () => {
    if (base) return base;
    const forms = await openForms(env, fetchImpl);
    const form = forms.find((f) => /brighter home/i.test(f.title));
    if (!form) throw new Error('No open Help Build a Brighter Home form to test on');
    base = { campaign_id: form.id, amount: 100, payment_method: 'cheque', generate_tax_receipt: false, send_confirmation_email: false };
    return base;
  };
  try {
    if (prior?.ok && prior.steps?.length) {
      report.steps = prior.steps;
      report.sameContact = !!prior.sameContact;
      report.provenAt = prior.provenAt || prior.at;
      // Proven before: never tried again, so one slow answer from Zeffy can't switch a working step off
      if (prior.join?.ok) report.join = prior.join;
      if (prior.email?.saved && !prior.email.receipt) report.email = prior.email;
    } else {
      await needBase();
      for (const [what, name] of [['two names', WRITE_TEST_NAME], ['the same two names', WRITE_TEST_NAME], ['one word', { first_name: WRITE_TEST_ONE_WORD, last_name: WRITE_TEST_ONE_WORD }]]) {
        const p = await send({ ...base, ...name });
        report.steps.push({ what, type: p.type || null, method: p.payment_method?.type || null, status: p.status || null, hasContact: !!p.contact, receipt: !!p.receipt_url });
        // A record Zeffy doesn't call a check can't be found again after a save with no answer
        if (!paidByCheck(p)) throw new Error('Zeffy doesn’t mark these records as paid by check');
      }
      report.sameContact = !!made[0].contact && made[0].contact === made[1].contact;
      if (made.some((p) => p.type === 'imported')) throw new Error('Zeffy marks these records as imported, so Slack and the board would skip them');
      report.provenAt = at;
    }
    if (report.steps.some((x) => x.receipt)) throw new Error('Zeffy made a tax receipt although the site asked for none');
    report.ok = true;
  } catch (e) {
    report.error = clean(e.message).slice(0, 200);
    report.status = e.status || null;
  }
  // Without it, a giver Zeffy has no email for gets a new contact with each check, so it's tried once and used only if it held
  if (report.ok && !report.join?.ok) {
    report.join = { ok: false };
    try {
      const c = await zeffySend(env, 'POST', '/contacts', { ...WRITE_TEST_NAME }, fetchImpl);
      if (!c?.id) throw new Error('Zeffy made no contact');
      contacts.add(String(c.id));
      // Dated three days back at noon Eastern, the way every real record is dated: a record stamped "now" fails the test
      const dated = `${new Date(now - 3 * DAY).toLocaleDateString('en-CA', { timeZone: TZ })}T17:00:00.000Z`;
      await needBase();
      const p = await postJoined(env, String(c.id), { ...base, ...WRITE_TEST_NAME, payment_date: dated }, { tag: tagFor('writetest', now), now, fetchImpl, checkId: 'writetest' });
      if (!p?.id) throw new Error('Zeffy answered without a payment id');
      made.push(p);
      report.join.dateKept = Math.abs(Number(p.created) - Date.parse(dated) / 1000) <= 86400;
      const after = await zeffyGet(env, `/contacts/${encodeURIComponent(c.id)}`, {}, fetchImpl);
      report.join.onContact = String(p.contact) === String(c.id);
      report.join.cleared = !clean(after?.email);
      // Whether Zeffy also keeps the address on the record itself, where staff would see it
      const back = await zeffyGet(env, `/payments/${encodeURIComponent(p.id)}`, {}, fetchImpl).catch(() => null);
      report.join.recordShowsAddress = isTag(back?.buyer?.email);
      report.join.ok = report.join.onContact && report.join.cleared;
    } catch (e) {
      report.join.error = clean(e.message).slice(0, 200);
    }
  }
  // A learned donor's email goes on their record with the receipt and email off. This one goes to a SOARD inbox, so it can be
  // seen there that Zeffy sent nothing
  if (report.ok && !report.email?.saved) {
    try {
      const p = await send({ ...(await needBase()), ...WRITE_TEST_NAME, email: WRITE_TEST_EMAIL });
      report.email = { saved: true, at: new Date(now).toISOString(), receipt: !!p.receipt_url };
      // A receipt on a record with an email is one Zeffy may have sent: nothing goes on until a test says it doesn't
      if (p.receipt_url) {
        report.ok = false;
        report.error = 'Zeffy made a tax receipt although the site asked for none';
      }
    } catch (e) {
      report.email = { saved: false, error: clean(e.message).slice(0, 200) };
    }
  }
  // A donor's address goes on their contact once a check's record is in (Nov 10): tried on a test contact, read back, removed.
  // One that failed is tried again on later days, three times in all
  if (report.ok && !prior?.address?.ok) {
    report.address = { ok: false, tries: (prior?.id === WRITE_TEST && prior.address && !prior.address.ok ? Number(prior.address.tries) || 1 : 0) + 1 };
    try {
      const c = await zeffySend(env, 'POST', '/contacts', { ...WRITE_TEST_NAME }, fetchImpl);
      if (!c?.id) throw new Error('Zeffy made no contact');
      contacts.add(String(c.id));
      await zeffySend(env, 'PATCH', `/contacts/${encodeURIComponent(c.id)}`, { address: WRITE_TEST_ADDRESS }, fetchImpl);
      const back = await zeffyGet(env, `/contacts/${encodeURIComponent(c.id)}`, {}, fetchImpl);
      report.address.ok = addressKey(back?.address) === addressKey(WRITE_TEST_ADDRESS);
      if (!report.address.ok) report.address.error = 'Zeffy didn’t keep the address';
    } catch (e) {
      report.address.error = clean(e.message).slice(0, 200);
    }
  } else if (report.ok) report.address = prior.address;
  // A POST cut off after it saved is still the test's: anything by the test's names made today is taken out too
  try {
    const mine = new Set(made.map((p) => String(p.id)));
    const today = await paymentsSince(env, Math.floor(now / 1000) - 5 * DAY / 1000, fetchImpl);
    for (const p of today) {
      if (mine.has(String(p.id)) || Number(p.amount) !== 100) continue;
      if ([givenName(p.buyer), `${clean(p.buyer?.first_name)} ${clean(p.buyer?.last_name)}`].some((n) => ['SOARD WebsiteTest', WRITE_TEST_ONE_WORD].includes(clean(n)))) made.push(p);
    }
  } catch { /* couldn't look: what it knows it made still goes */ }
  // Nothing is left behind if Zeffy lets it go. The site never deletes anything else, so a refusal doesn't stop it working:
  // it asks a person to take the $1 records out by hand, and sees when they're gone
  const left = [];
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
  // Only a contact this test made: never one holding a real gift. One made by a call that never answered is found by its name
  for (const id of contacts) await dropTestContact(env, id, fetchImpl);
  report.contactsLeft = !(await sweepTestContacts(env, now, fetchImpl));
  await writeState(env.DB, KEY, { writeTest: report });
  return report;
}

const isTestContact = (c) => [WRITE_TEST_NAME.last_name, WRITE_TEST_ONE_WORD].includes(clean(c?.last_name)) && [WRITE_TEST_NAME.first_name, WRITE_TEST_ONE_WORD].includes(clean(c?.first_name));
async function dropTestContact(env, id, fetchImpl) {
  const c = await zeffyGet(env, `/contacts/${encodeURIComponent(id)}`, {}, fetchImpl).catch(() => null);
  if (!c || !isTestContact(c) || Number(c.donation_count)) return !c;
  return zeffySend(env, 'DELETE', `/contacts/${encodeURIComponent(id)}`, null, fetchImpl).then(() => true, () => false);
}

/** The test's contacts made since `fromMs`, with no gift on them, removed. True when none is left */
async function sweepTestContacts(env, fromMs, fetchImpl) {
  try {
    const left = [];
    let after = null;
    for (let page = 0; page < 3; page++) {
      const r = await zeffyGet(env, '/contacts', { 'created[gte]': Math.floor(fromMs / 1000) - 86400, limit: 100, starting_after: after }, fetchImpl);
      for (const c of r?.data || []) if (isTestContact(c) && !(await dropTestContact(env, String(c.id), fetchImpl))) left.push(String(c.id));
      if (!r?.has_more || !r.next_cursor) break;
      after = r.next_cursor;
    }
    return !left.length;
  } catch {
    return false;
  }
}

/**
 * The weekly money check: every check gift in Zeffy since checks went through Mercury should have its Mercury check. One
 * that doesn't is a check entered twice (whatever way that happened) or one deposited somewhere else, and Slack names it.
 * Left out: what's under a day old (the hourly look links it first), what a person is already asked about on Checks, and
 * the site's own test records. Never deletes or changes anything.
 */
export async function moneyCheck(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const nowS = Math.floor(now / 1000);
  const fromS = Math.max(secondsOf(MERCURY_FROM), nowS - MONEY_BACK_S);
  // Typed or paid in the window counts, however it's dated: an entry dated last year but typed this month is this month's
  const payments = await paymentsSince(env, nowS - NET_S, fetchImpl);
  const cfg = await readState(env.DB, KEY);
  const named = { ...(cfg.money?.named || {}) };
  const waiting = await openAmounts(env.DB, null, now);
  const claimed = new Set(((await env.DB.prepare('SELECT zeffy_id FROM check_gifts WHERE zeffy_id IS NOT NULL').all()).results || []).map((r) => String(r.zeffy_id)));
  // Entries already in front of a person, as a check's question
  const asked = new Set();
  for (const r of (await env.DB.prepare("SELECT note FROM check_gifts WHERE state = 'person' AND note LIKE '[%'").all()).results || []) {
    try { for (const x of JSON.parse(r.note)) asked.add(String(x.id)); } catch { /* words */ }
  }
  const seen = new Map(((await env.DB.prepare('SELECT payment_id, first_seen, paid_seen FROM zeffy_seen').all().catch(() => ({ results: [] }))).results || [])
    .map((r) => [r.payment_id, Math.max(Number(r.first_seen) || 0, Number(r.paid_seen) || 0)]));
  // When it showed up (or turned paid): the site's own record; for what was there before the site watched, its own date
  const when = (p) => seen.get(String(p.id)) || Number(p.created);
  const loose = payments.filter((p) => String(p.status || '').toLowerCase() === 'succeeded' && paidByCheck(p) && p.refund_status !== 'full'
    && !/in.?kind/.test(String(p?.payment_method?.type || '').toLowerCase()) && !isTestRecord(p)
    && (Number(p.created) >= secondsOf(MERCURY_FROM) || when(p) >= fromS) && when(p) >= fromS && when(p) <= nowS - 86400
    && !claimed.has(String(p.id)) && !asked.has(String(p.id)) && !waiting.has(Number(p.amount))
    // Named on two Mondays: enough to be seen, never a weekly alarm about a check that paid several gifts
    && (named[String(p.id)] || 0) < 2);
  const split = new Set();
  for (const r of (await env.DB.prepare("SELECT cents, zeffy_id, deposited_at FROM check_gifts WHERE zeffy_id IS NOT NULL AND state IN ('linked', 'created')").all()).results || []) {
    const entry = payments.find((p) => String(p.id) === String(r.zeffy_id));
    if (!entry || Number(entry.amount) >= Number(r.cents)) continue;
    const day = secondsOf(dayOf(r.deposited_at));
    const pool = loose.filter((p) => !split.has(String(p.id)) && Math.abs(Number(p.created) - day) <= 30 * 86400);
    for (const p of partsAddingTo(pool, Number(r.cents) - Number(entry.amount), 1, 4) || []) split.add(String(p.id));
  }
  for (let i = loose.length - 1; i >= 0; i--) if (split.has(String(loose[i].id))) loose.splice(i, 1);
  for (const p of loose) named[String(p.id)] = (named[String(p.id)] || 0) + 1;
  for (const id of Object.keys(named)) if (!payments.some((p) => String(p.id) === id)) delete named[id];
  const result = {
    at: new Date(now).toISOString(),
    count: loose.length,
    loose: entriesToShow(loose.sort((a, b) => Number(b.created) - Number(a.created))),
    looseCents: loose.reduce((t, p) => t + Number(p.amount), 0),
    named,
  };
  await writeState(env.DB, KEY, { money: result });
  if (loose.length && env.SLACK_BOT_TOKEN) {
    const lines = result.loose.slice(0, 10).map((x) => `${x.name || 'No name'}, ${money(x.cents)}, ${new Date(x.at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })}`);
    const card = slackCard({
      icon: '🧾', title: `Zeffy has ${loose.length === 1 ? 'a check gift' : `${loose.length} check gifts`} with no check in Mercury`,
      lead: `${money(result.looseCents)} in Zeffy check gifts has no Mercury deposit behind it: ${lines.join('; ')}${loose.length > 10 ? '; and more on Checks' : ''}. One may be a check entered twice.`,
      fix: 'Look at each in Zeffy. If it’s a second record for a check already in Zeffy, delete that extra record. If it’s one of several gifts a single check paid, or a check deposited at another bank, nothing to do.',
      buttons: [{ label: 'Open Checks', url: CARDS_URL }],
    });
    await slackIssue(env, `checks:money:${result.at.slice(0, 10)}`, card, { title: 'Checks into Zeffy', kind: 'attention' }).catch(() => null);
  }
  return result;
}

/** Monday from 9 AM Eastern, once */
function moneyDue(cfg, now) {
  const et = new Date(new Date(now).toLocaleString('en-US', { timeZone: TZ }));
  if (et.getDay() !== 1 || et.getHours() < 9) return false;
  return !cfg.money?.at || dayOf(cfg.money.at) !== dayOf(new Date(now).toISOString());
}

/** Test records a person was asked to remove: once they're gone, the page stops asking */
async function lookForLeftovers(env, test, fetchImpl) {
  const still = [];
  for (const id of test.leftBehind) {
    try { await zeffyGet(env, `/payments/${encodeURIComponent(id)}`, {}, fetchImpl); still.push(id); } catch (e) { if (e.status !== 404) still.push(id); }
  }
  if (still.length !== test.leftBehind.length) {
    const contactsLeft = still.length ? test.contactsLeft : !(await sweepTestContacts(env, Date.parse(test.at), fetchImpl));
    await writeState(env.DB, KEY, { writeTest: { ...test, leftBehind: still, removed: !still.length, contactsLeft } });
  }
}

export async function runChecks(env, { now = Date.now(), fetchImpl = fetch, cfg = null } = {}) {
  await ensureChecks(env.DB);
  cfg ||= await readState(env.DB, KEY);
  // On makes records only while the write test stands: a new test that fails puts it back to watching until it passes
  const mode = cfg.mode === 'on' && cfg.writeTest?.ok ? 'on' : 'watch';
  const ctx = { now, fetchImpl, mode, cfg };
  // A failed test tries again a day later, once nothing of it is left for a person to remove, three times in all
  const test = cfg.writeTest;
  const again = test && !test.leftBehind?.length && now - Date.parse(test.at || 0) > DAY
    && ((!test.ok && (Number(test.tries) || 1) < WRITE_TRIES) || (test.ok && test.address && !test.address.ok && (Number(test.address.tries) || 1) < WRITE_TRIES));
  if (test?.id !== WRITE_TEST || again) {
    const report = await testWrite(env, ctx);
    // Turned on, and the new test failed: it's watching until a test works, and the staff hear that they enter checks again
    if (cfg.mode === 'on' && !report.ok && env.SLACK_BOT_TOKEN) {
      const card = slackCard({ icon: '🧾', title: 'The site stopped entering checks in Zeffy', lead: 'Zeffy wouldn’t take the site’s $1 test record, so the site is only watching until a test works.', fix: 'Enter checks deposited in Mercury in Zeffy by hand until Checks says the site enters them again.', buttons: [{ label: 'Open Checks', url: CARDS_URL }] });
      await slackIssue(env, 'checks:paused', card, { title: 'Checks into Zeffy', kind: 'attention' }).catch(() => null);
    }
    if (cfg.mode === 'on' && report.ok && env.SLACK_BOT_TOKEN) {
      await slackResolved(env, 'checks:paused', slackCard({ icon: '✅', title: 'The site enters checks in Zeffy again', lead: 'Its test record saved.' }), { summary: 'Entering checks again.' }).catch(() => null);
    }
    return { writeTest: report };
  }
  await clearTags(env, ctx);
  const mercuryDown = await pull(env, ctx);
  await settleUnsure(env, ctx).catch((e) => { ctx.failed ||= e; });
  // The donor's address onto their contact, one a run: a few small calls, never a reason to hold up the rest
  await writeAddresses(env, ctx).catch((e) => { console.error('[check-gifts] address', clean(e?.message).slice(0, 120)); });
  if (now - Date.parse(cfg.lastMatchAt || 0) >= MATCH_EVERY_MS) {
    await writeState(env.DB, KEY, { lastMatchAt: new Date(now).toISOString() });
    try {
      await matchOpen(env, ctx);
      if (cfg.matchFailing) {
        await writeState(env.DB, KEY, { matchFailing: null });
        await slackResolved(env, 'checks:match', slackCard({ icon: '✅', title: 'The hourly look at Zeffy works again', lead: 'Hand entries link themselves again.' }), { summary: 'Working again.' }).catch(() => null);
      }
    } catch (e) {
      // Without it hand entries don't link and doubles go unseen: three hours of it tells the staff, once
      const since = cfg.matchFailing?.since || new Date(now).toISOString();
      await writeState(env.DB, KEY, { matchFailing: { since, error: plainError(e) } });
      if (now - Date.parse(since) >= 3 * 60 * MIN && env.SLACK_BOT_TOKEN) {
        const card = slackCard({ icon: '🧾', title: 'The site can’t look at Zeffy for checks', lead: `Since ${new Date(since).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, ${plainError(e)}. Hand entries don’t link to their checks until it works.`, fix: 'Nothing to do in Zeffy. If it lasts a day, tell Peter.', buttons: [{ label: 'Open Checks', url: CARDS_URL }] });
        await slackIssue(env, 'checks:match', card, { title: 'Checks into Zeffy', kind: 'attention' }).catch(() => null);
      }
    }
    if (test?.leftBehind?.length) await lookForLeftovers(env, test, fetchImpl);
    else if (test?.contactsLeft && await sweepTestContacts(env, Date.parse(test.at), fetchImpl)) await writeState(env.DB, KEY, { writeTest: { ...test, contactsLeft: false } });
  }
  // The weekly money check, Monday morning: it reads and writes nothing but its own result, so it never holds up the rest
  if (moneyDue(cfg, now)) await moneyCheck(env, ctx).catch((e) => { ctx.failed ||= e; });
  // One big job a run: a check waiting to be decided, else one to read
  // Turned on: what it was only watching goes on too, the same way, one a run, each read against Zeffy again
  // Decided as soon as it's read, while Mercury is still reviewing it (Peter, Nov 9): a check Mercury turns down later is flagged
  // Each day's checks wait for 7 PM Eastern, so a letter attached in Mercury that day is read first (saveAt)
  const readyWhere = `(state = 'read' OR (state = 'would' AND ? = 'on')) AND status IN ('pending', 'sent')`;
  const due = (list) => (list.results || []).find((r) => isDue(r, now)) || null;
  const fresh = due(await env.DB.prepare(`SELECT * FROM check_gifts WHERE ${readyWhere} AND try_at IS NULL ORDER BY deposited_at LIMIT 50`).bind(mode).all());
  // A check Zeffy told to wait gets its turn only when nothing new needs reading, so one giver never holds up the rest
  const unread = fresh ? null : await env.DB.prepare(`SELECT 1 AS y FROM check_gifts WHERE state = 'new' AND status NOT IN ('cancelled', 'failed', 'reversed', 'blocked') AND (try_at IS NULL OR try_at < ?) LIMIT 1`).bind(new Date(now - CLAIM_MS).toISOString()).first();
  const turn = Math.floor(now / RUN_EVERY_MS) % 2 === 0;
  const ready = fresh || (unread && !turn ? null : due(await env.DB.prepare(`SELECT * FROM check_gifts WHERE ${readyWhere} AND try_at < ? ORDER BY try_at LIMIT 50`).bind(mode, new Date(now - 15 * MIN).toISOString()).all()));
  // A letter to read or put to use comes before a new check's picture: its check is waiting on it
  // A letter's check waits on it, so letters and decisions take turns: neither holds the other up while Zeffy or the readers are slow
  const letterRow = ((await env.DB.prepare(`SELECT * FROM check_gifts WHERE letter LIKE '%"pending":["%' AND state IN ('read', 'would') ORDER BY deposited_at LIMIT 20`).all()).results || [])
    .find((r) => { const l = jsonOf(r.letter, {}); return !l.tryAt || now - Date.parse(l.tryAt) >= 15 * MIN; }) || null;
  let done = { result: 'quiet' };
  if (ready && !(letterRow && !turn)) {
    try {
      done = await decideCheck(env, ready, ctx);
    } catch (e) {
      // It goes to the back of the line, so the other checks go on; a day of this goes to a person below
      await setRow(env.DB, ready.id, { try_at: new Date(now).toISOString() }, now, ready.state).catch(() => null);
      ctx.failed = e;
      done = { result: 'later' };
    }
    // Waiting on Zeffy a whole day: a person enters it by hand instead, and it links itself
    const waits = { ...((await readState(env.DB, KEY)).waits || {}) };
    if (done.result === 'later') {
      waits[ready.id] ||= new Date(now).toISOString();
      if (now - Date.parse(waits[ready.id]) >= DAY && await toPerson(env, ready, 'zeffy-busy', { mode, now })) delete waits[ready.id];
    } else delete waits[ready.id];
    await writeState(env.DB, KEY, { waits });
    if (ctx.failed) throw ctx.failed;
  } else if (letterRow) {
    try {
      done = await readLetter(env, letterRow, ctx);
      if (cfg.readersFailing && done.result === 'letter') await writeState(env.DB, KEY, { readersFailing: null });
    } catch (e) {
      ctx.failed = e;
    }
    if (ctx.failed) throw ctx.failed;
  } else {
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
        if (done.result === 'read' && cfg.readersFailing) {
          await writeState(env.DB, KEY, { readersFailing: null });
          await slackResolved(env, 'checks:readers', slackCard({ icon: '✅', title: 'The site reads checks again', lead: 'Both readers answered.' }), { summary: 'Reading again.' }).catch(() => null);
        }
      } catch (e) {
        // Mercury or the readers not answering is an outage: the try is given back and the check waits its turn, for up to 3 days.
        // A refusal (Mercury has no such check) is this check's own, and three of those go to a person
        const outage = !e.status || e.status >= 500 || e.status === 429;
        const waited = now - Date.parse(next.created_at || next.deposited_at) >= 3 * DAY;
        if (outage && !waited) {
          await env.DB.prepare('UPDATE check_gifts SET tries = MAX(0, tries - 1) WHERE id = ? AND tries > ?').bind(next.id, next.tries || 0).run().catch(() => null);
          throw e;
        }
        if (!outage && (next.tries || 0) + 1 < READ_TRIES) throw e;
        await toPerson(env, next, 'unreadable', { note: outage ? 'The site couldn’t reach Mercury or its check readers for this check for three days.' : null, mode, now });
        done = { result: 'person' };
      }
    }
  }
  if (ctx.failed) throw ctx.failed;
  if (mercuryDown) throw mercuryDown;
  return done;
}

/** A fault as the end of "The last run didn't finish: …" */
export function plainError(e) {
  const m = clean(e?.message);
  if (/D1_ERROR|SQLITE|database/i.test(m)) return 'the site’s database didn’t answer';
  if (/readers didn’t answer/.test(m)) return 'the check readers didn’t answer';
  if (/reader didn’t answer/.test(m)) return 'one of the two check readers didn’t answer';
  if (/more payments than/.test(m)) return 'Zeffy has more payments than the site reads at once';
  if (/zeffy/i.test(m)) return 'Zeffy didn’t answer';
  if (/mercury|relay/i.test(m)) return 'Mercury didn’t answer';
  return 'something unexpected went wrong';
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
    console.error('[check-gifts] the run stopped', clean(e?.message).slice(0, 200));
    await writeState(env.DB, KEY, { lastError: { at: new Date(now).toISOString(), error: plainError(e) } }).catch(() => null);
    if (e?.readers) {
      const st = await readState(env.DB, KEY).catch(() => ({}));
      const since = st.readersFailing?.since || new Date(now).toISOString();
      await writeState(env.DB, KEY, { readersFailing: { since } }).catch(() => null);
      if (now - Date.parse(since) >= 3 * 60 * MIN && env.SLACK_BOT_TOKEN) {
        const card = slackCard({ icon: '🧾', title: 'The site can’t read checks right now', lead: `Since ${new Date(since).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, ${plainError(e)}. Checks wait to be read, and any still waiting after 3 days comes to a person.`, fix: 'Nothing to do in Zeffy. If it lasts a day, tell Peter: a reader may need replacing.', buttons: [{ label: 'Open Checks', url: CARDS_URL }] });
        await slackIssue(env, 'checks:readers', card, { title: 'Checks into Zeffy', kind: 'attention' }).catch(() => null);
      }
    }
    return null;
  }
}

// ─── The page ───────────────────────────────────────────────────────

// Reasons that ask a person to save it: while watching, staff enter it by hand instead
const ON_ONLY = ['unsure', 'record-gone', 'old-check', 'zeffy-refused', 'no-form', 'unlinked', 'zeffy-busy', 'look-by-hand'];
const BY_HAND = 'Enter it in Zeffy by hand, as usual, and it links itself within the hour.';

/** What a person answered about a check, in short: two screens that differ here aren't looking at the same check */
export const versionOf = (r) => {
  const l = jsonOf(r.letter, {});
  const t = [r.state, r.reason, r.zeffy_id, r.rejected, r.by, r.payer, r.note, l.name, (l.late || []).join(','), l.why, r.address_done === 'refused' ? 'refused' : ''].map((x) => x ?? '').join('|');
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

function viewOf(r, claimed, mode = 'watch', now = Date.now()) {
  let listed = null;
  let score = null;
  try { listed = r.reason && r.note?.startsWith('[') ? JSON.parse(r.note) : null; } catch { /* words, not a list */ }
  // The Zeffy entry a to-do is about, kept when it was matched
  let entry = null;
  try { entry = r.note?.startsWith('entry:') ? JSON.parse(r.note.slice(6)) : null; } catch { /* an old row */ }
  // A second deposit of one check is asked about the first deposit's record, which that deposit of course holds
  const candidates = listed ? listed.filter((c) => r.reason === 'redeposit' || !claimed.has(String(c.id))) : null;
  try { score = r.score ? JSON.parse(r.score) : null; } catch { /* an old row */ }
  const on = mode === 'on';
  const waitingOnZeffy = r.state === 'unsure' || r.state === 'creating';
  // Something to do in Zeffy, for a check that has its record: these clear themselves once it's done
  const letter = jsonOf(r.letter, {});
  const addr = jsonOf(r.address);
  const saved = ['linked', 'created'].includes(r.state);
  // A file added in Mercury after the record went in, or an address Zeffy wouldn't take: done in Zeffy, then "Looked at it"
  const letterToDo = saved && (letter.late || []).length ? 'late' : null;
  const said = letterSays(r);
  const tried = jsonOf(r.address_tried);
  const addressToDo = saved && r.address_done === 'refused';
  const toDo = (saved && ['amount-off', 'still-unpaid'].includes(r.reason)) || (r.state === 'came-back' && !!r.zeffy_id) || !!letterToDo || addressToDo;
  const askedGone = r.state === 'person' && listed?.length && !candidates?.length;
  const theEntry = entry ? `Zeffy’s entry (${entry.name || 'no name'}, ${money(entry.cents)}${entry.at ? `, ${new Date(entry.at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })}` : ''})` : 'Zeffy’s entry';
  const why = waitingOnZeffy ? 'Zeffy didn’t answer yet. The site is looking for the record, so don’t enter this one.'
    : letterToDo && !['amount-off', 'still-unpaid'].includes(r.reason) ? 'A file was added in Mercury after this check went into Zeffy. Look at it there, and fix the record in Zeffy if it says something else (Zeffy can’t move a gift: delete it and enter it again, and it links itself within the hour).'
    : addressToDo && !['amount-off', 'still-unpaid'].includes(r.reason) ? (tried?.address || tried?.email
      ? `Zeffy wouldn’t take ${tried.address ? 'the donor’s address' : 'the email from the letter'}. Add it to ${tried.who || r.payer || 'the donor'} in Zeffy: ${[tried.address ? addressLine(tried.address) : '', tried.email ? `${tried.address ? 'and the email ' : ''}${tried.email}` : ''].filter(Boolean).join(', ')}.`
      : 'Zeffy wouldn’t take the donor’s address. Look at the check in Mercury and add it in Zeffy.')
    : r.reason === 'amount-off' && ['linked', 'created'].includes(r.state) ? `${theEntry} and the check (${money(r.cents)}) are for different amounts. Fix the amount in Zeffy.`
    : r.reason === 'still-unpaid' && ['linked', 'created'].includes(r.state) ? `${theEntry} is still unpaid. Mark it paid in Zeffy.`
    : r.reason === 'zeffy-refused' && on ? r.note || REASONS['zeffy-refused']
    : r.state === 'came-back' && r.zeffy_id ? 'The check came back. Cancel the record in Zeffy, and Zeffy tells the donor.'
    : r.state === 'left-out' || r.state === 'came-back' ? LEFT_OUT[r.reason] || REASONS[r.reason] || null
    : askedGone ? `The Zeffy entry that might have been this check is now another check’s. ${on ? 'Save this one in Zeffy.' : BY_HAND}`
    : r.state === 'person' && !on && ON_ONLY.includes(r.reason) ? BY_HAND
    : REASONS[r.reason] || null;
  const needsYou = toDo || (r.state === 'person' && (!!candidates?.length || (on && ['pending', 'sent'].includes(r.status))));
  return {
    needsYou, toDo, old: r.state === 'would' && now - Date.parse(r.posted_at || r.deposited_at) > OLD_CHECK_MS,
    id: r.id, cents: r.cents, status: r.status, state: r.state, depositedAt: r.deposited_at, depositDay: dayOf(r.deposited_at), postedAt: r.posted_at,
    payer: r.payer || '', checkDate: r.check_date || '', memo: r.memo || '', checkNumber: r.check_number || '',
    formId: r.form_id || '', formTitle: r.form_title || '', via: r.via || null, by: r.by || null, zeffyId: r.zeffy_id || null, link: r.link || null,
    reason: r.reason || null, why, note: r.note?.startsWith('[') || r.note?.startsWith('entry:') || r.reason === 'zeffy-refused' ? null : r.note || null,
    candidates: candidates?.length ? candidates : null, score, ver: versionOf(r),
    // Goes into Zeffy at 7 PM Eastern on the deposit day, so a letter attached that day is read with it
    waitsUntil: on && r.state === 'read' && !r.by && now < saveAt(r.deposited_at) ? new Date(saveAt(r.deposited_at)).toISOString() : null,
    category: r.category || null,
    // Not in Zeffy yet and not marked as a contribution in Mercury: it can't go in until it is
    needsCategory: on && !r.zeffy_id && ['new', 'read', 'would', 'person'].includes(r.state) && !isContribution(r.category),
    drawer: r.drawer && r.payer && !surelySameGiver(r.drawer, r.payer) ? r.drawer : null,
    letter: letter.about || letter.why || (letter.files || []).length || letterToDo ? {
      unread: (letter.files || []).filter((k) => !letter.reads?.[k]).length,
      // A letter with a problem says nothing the site used: only the problem shows
      name: letter.why ? '' : letter.name || '', email: letter.why ? '' : letter.email || '', address: letter.why ? '' : addressLine(letter.address), why: letter.why ? REASONS[letter.why] || null : null,
      reading: ['new', 'read', 'would'].includes(r.state) && (letter.pending || []).length > 0, todo: letterToDo,
    } : null,
    address: addr ? { line: addressLine(addr), from: 'check', inZeffy: ['written', 'same', 'email-taken'].includes(r.address_done) } : null,
    emailTaken: ['email-taken', 'email-taken-only'].includes(r.address_done),
    mailInZeffy: ['written', 'same', 'email-same', 'email-taken'].includes(r.address_done),
    addressToDo,
    looked: shownToDo(r),
  };
}

/** How Watch did, over every check a hand entry scored: the evidence for turning it on */
async function scoreOf(DB) {
  const rows = (await DB.prepare('SELECT score FROM check_gifts WHERE score IS NOT NULL').all()).results || [];
  let total = 0;
  let right = 0;
  for (const r of rows) {
    try { const sc = JSON.parse(r.score); total++; if (sc.payer && sc.gift && sc.form !== false) right++; } catch { /* an old row */ }
  }
  return { total, right };
}

/** Everything the Checks tab shows, and how Watch is doing */
export async function checksView(env) {
  await ensureChecks(env.DB);
  const cfg = await readState(env.DB, KEY);
  // What waits on someone comes first, so the limit can never push it off the page
  const mode = cfg.mode === 'on' && cfg.writeTest?.ok ? 'on' : 'watch';
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts ORDER BY CASE WHEN (state = 'person' AND ((? = 'on' AND status IN ('pending', 'sent')) OR note LIKE '[%')) OR (state IN ('linked', 'created') AND (reason IN ('amount-off', 'still-unpaid') OR address_done = 'refused' OR letter LIKE '%"late":["%')) OR (state = 'came-back' AND zeffy_id IS NOT NULL) THEN 1 ELSE 0 END DESC, deposited_at DESC LIMIT ?`).bind(mode, LIST_LIMIT).all()).results || [];
  const all = (await env.DB.prepare('SELECT COUNT(*) AS n FROM check_gifts').first())?.n || 0;
  // What turning it on would do, counted over every check, not only the ones listed
  const w = await env.DB.prepare(`SELECT SUM(CASE WHEN COALESCE(posted_at, deposited_at) >= ? THEN 1 ELSE 0 END) AS fresh, SUM(CASE WHEN COALESCE(posted_at, deposited_at) < ? THEN 1 ELSE 0 END) AS old FROM check_gifts WHERE state = 'would'`)
    .bind(new Date(Date.now() - OLD_CHECK_MS).toISOString(), new Date(Date.now() - OLD_CHECK_MS).toISOString()).first();
  const claimed = await claimedIds(env.DB);
  // Each check's Category in Mercury, as last mirrored
  const cats = new Map(((await env.DB.prepare("SELECT id, category_name FROM mercury_txns WHERE kind = 'checkDeposit' AND category_name IS NOT NULL").all().catch(() => null))?.results || []).map((t) => [t.id, t.category_name]));
  const list = rows.map((r) => viewOf({ ...r, category: cats.get(r.id) || null }, claimed, mode));
  return {
    mode,
    onBy: cfg.onBy || null, onAt: cfg.onAt || null,
    writeTest: cfg.writeTest || null,
    paused: cfg.mode === 'on' && !cfg.writeTest?.ok,
    lastError: cfg.lastError || null,
    matchFailing: cfg.matchFailing || null,
    money: cfg.money || null,
    watching: { fresh: w?.fresh || 0, old: w?.old || 0 },
    list,
    limited: all > rows.length, shown: rows.length, all,
    waiting: list.filter((c) => c.needsYou).length,
    scored: await scoreOf(env.DB),
    zeffyUrl: ZEFFY_PAYMENTS,
    configured: { mercury: mercuryConfigured(env), zeffy: !!String(env.ZEFFY_API_KEY || '').trim(), ai: !!env.AI },
  };
}

/** For the Automations map: times and counts only */
export async function checksFacts(DB) {
  await ensureChecks(DB);
  const cfg = await readState(DB, KEY);
  const on = cfg.mode === 'on' && !!cfg.writeTest?.ok;
  const c = await DB.prepare('SELECT COUNT(*) AS total, MAX(deposited_at) AS last FROM check_gifts').first();
  // The same rule the page's Needs you uses, so the tab's count is the list's
  const open = (await DB.prepare(`SELECT * FROM check_gifts WHERE state = 'person' OR reason IN ('amount-off', 'still-unpaid') OR (state = 'came-back' AND zeffy_id IS NOT NULL) OR address_done = 'refused' OR letter LIKE '%"late":["%'`).all()).results || [];
  const claimed = await claimedIds(DB);
  const waiting = open.filter((r) => viewOf(r, claimed, on ? 'on' : 'watch').needsYou).length;
  return {
    mode: on ? 'on' : 'watch', lastRunAt: cfg.lastRunAt || null, error: cfg.lastError?.error || null, total: c?.total || 0, waiting, last: c?.last || null,
    writeOk: cfg.writeTest ? !!cfg.writeTest.ok : null, paused: cfg.mode === 'on' && !cfg.writeTest?.ok,
    matchFailing: cfg.matchFailing ? { since: cfg.matchFailing.since, error: cfg.matchFailing.error } : null,
    moneyLoose: cfg.money?.count ?? cfg.money?.loose?.length ?? 0, moneyAt: cfg.money?.at || null,
  };
}

const err = (message, status = 400) => Object.assign(new Error(message), { status });

/** The same person's same answer, sent again (a browser resends when an answer is lost): it already landed */
const sameAnswer = (row, by, now, test) => !!by && row.by === by && now - Date.parse(row.updated_at || 0) < 5 * MIN && test(row);

async function mustRow(env, id, { saw = null } = {}) {
  await ensureChecks(env.DB);
  const row = await getRow(env.DB, id);
  if (!row) throw err('That check isn’t on the list', 404);
  // The page says what it was showing (its version, or its state from an older page): an answer since is never overruled
  if (saw && (STATES.has(saw) ? saw !== row.state : saw !== versionOf(row))) throw err('This check just changed, maybe by someone else. Look at it again.', 409);
  if (['creating', 'unsure'].includes(row.state)) throw err('Zeffy hasn’t answered for this check yet. Look again in a few minutes.', 409);
  return row;
}
const STATES = new Set(['new', 'read', 'would', 'person', 'creating', 'unsure', 'created', 'linked', 'left-out', 'store', 'came-back']);
const listedIds = (row) => { try { return row.note?.startsWith('[') ? JSON.parse(row.note).map((x) => String(x.id)) : []; } catch { return []; } };

/** Watch or On. On needs the write test passed: a person turning it on is telling staff to stop entering these */
export async function setMode(env, mode, { by = null, now = Date.now(), saw = null } = {}) {
  const cfg = await readState(env.DB, KEY);
  const was = cfg.mode === 'on' ? 'on' : 'watch';
  if (saw && saw !== was && mode !== was) throw err(`Someone just ${was === 'on' ? 'turned it on' : 'turned it back to watching'}. Look again before changing it.`, 409);
  if (mode === 'on' && !cfg.writeTest?.ok) throw err('The site hasn’t proven it can write to Zeffy yet.', 409);
  return writeState(env.DB, KEY, { mode: mode === 'on' ? 'on' : 'watch', onBy: mode === 'on' ? by : null, onAt: mode === 'on' ? new Date(now).toISOString() : null });
}

/**
 * A person fills in what the site couldn't. Zeffy is read again first: an entry made since is linked, not doubled, unless the
 * person is looking right at what the page showed them and says it's another gift (notThose).
 */
export async function personCreate(env, id, { name, formId, day = null, notThose = false, shown = [], saw = null, by = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const first = await getRow(env.DB, id);
  if (first && sameAnswer(first, by, now, (r) => r.state === 'created' && r.via === 'person')) return { result: 'created', id: String(first.zeffy_id), again: true };
  const row = await mustRow(env, id, { saw });
  const cfg = await readState(env.DB, KEY);
  if (cfg.mode !== 'on' || !cfg.writeTest?.ok) throw err('The site is watching, so enter this one in Zeffy by hand.', 409);
  if (!['person', 'left-out', 'store', 'would'].includes(row.state)) throw err('This check has moved on. Look again.', 409);
  // The record lands when the money does
  if (!['pending', 'sent'].includes(row.status)) throw err('Mercury didn’t take this check, so it isn’t saved in Zeffy.', 409);
  const category = await categoryOf(env, row);
  if (!isContribution(category)) throw err(`Set its Category in Mercury to ${GIFT_WORDS} first, then save it here.`, 409);
  if (hasAccountDigits(clean(name), row.check_number)) throw err('Leave the long number out of the name. Six or more digits in a row look like a bank account number, so the site never saves them.');
  const payer = safeText(name, 120, row.check_number);
  if (!payer) throw err('Who wrote this check?');
  if (day != null) {
    const deposited = dayOf(row.deposited_at);
    const tooOld = isDay(day) && Date.parse(`${deposited}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`) > 366 * DAY;
    if (!isDay(day)) throw err('That date doesn’t look right.');
    if (day > deposited) throw err('That date is after the check was deposited. Use the date on the check, or the day it was deposited.');
    if (tooOld) throw err('That date is more than a year before the check was deposited. Use the day it was deposited instead.');
  }
  let forms;
  let payments;
  let claimed;
  try {
    forms = await openForms(env, fetchImpl);
    // A date the person picked reaches back as far as a stale check can, no further: past that Zeffy's whole read won't fit
    const reach = new Date(Date.parse(`${recordDay(row)}T12:00:00Z`) - STALE_REACH_MS).toISOString().slice(0, 10);
    const from = isDay(day) && day < earliestDay(row) ? (day < reach ? reach : day) : earliestDay(row);
    // A person saves on what they can see in Zeffy themselves: a read too big to see whole still shows what's near
    payments = (await readWide(env, secondsOf(from) - LOOK_BACK_S, now, fetchImpl)).payments;
    claimed = await claimedIds(env.DB);
  } catch {
    throw err('Zeffy didn’t answer, so nothing was saved. Try again in a minute.', 503);
  }
  const form = forms.find((f) => f.id === formId);
  if (!form) throw err('Pick an open donation form.');
  const seen = { ...row, payer, form_id: form.id, form_title: form.title };
  const drawerLearned = row.drawer ? await learnedFor(env.DB, row.drawer) : null;
  const m = matchBoth(seen, payments, claimedFor(seen, claimed), await learnedFor(env.DB, payer), drawerLearned);
  if (m.same.length) {
    await linkTo(env, seen, m.same[0], { by, now, fetchImpl });
    return { result: 'linked' };
  }
  const netted = netBoth(seen, payments, claimedFor(seen, claimed), { learned: await learnedFor(env.DB, payer), drawerLearned, ...(await freshFor(env, seen, cfg)) });
  // The same check number and amount deposited before: that deposit's record is shown first, though its check holds it
  if (row.check_number) {
    const twin = await env.DB.prepare('SELECT zeffy_id FROM check_gifts WHERE id != ? AND cents = ? AND check_number = ? AND zeffy_id IS NOT NULL AND deposited_at >= ? LIMIT 1')
      .bind(row.id, row.cents, row.check_number, new Date(now - 180 * DAY).toISOString()).first();
    if (twin) netted.push(...payments.filter((p) => String(p.id) === String(twin.zeffy_id)));
  }
  const likely = [...new Map([...m.promised, ...m.maybe, ...m.other, ...netted].map((p) => [String(p.id), p])).values()];
  // "It's a different gift" covers only the entries the person was shown: one that turned up since is shown first
  const looked = new Set(Array.isArray(shown) ? shown.map(String) : []);
  if (likely.length && (!notThose || likely.some((x) => !looked.has(String(x.id))))) {
    const entries = entriesToShow(likely);
    // The name the person typed is their answer (by): if the check is decided again, it stands
    if (!(await setRow(env.DB, id, { state: 'person', payer, by, form_id: form.id, form_title: form.title, reason: m.promised.length ? 'pledge' : m.maybe.length ? 'maybe-double' : 'amount-differs', note: JSON.stringify(entries) }, now, row.state))) throw err('This check just changed. Look again.', 409);
    throw Object.assign(err('Zeffy has an entry that may be this check. Look at it first.', 409), { entries });
  }
  // Entries the person said are other gifts: never offered for this check again, nor called a double of it
  const ruledOut = notThose ? [...new Set([...rejectedBy(row), ...looked])] : rejectedBy(row);
  if (!(await setRow(env.DB, id, { payer, form_id: form.id, form_title: form.title, rejected: JSON.stringify(ruledOut) }, now, row.state))) throw err('This check just changed. Look again.', 409);
  const learned = await learnedFor(env.DB, payer);
  let who;
  try { who = await learnedContact(env, learned, fetchImpl); } catch (e) { if (e.later) throw err('Zeffy didn’t answer, so nothing was saved. Try again in a minute.', 503); throw e; }
  // Filed under the giver's own contact, the record carries the names Zeffy already has for them; a letter's email files it by that
  let mail = '';
  if (!who.email && !who.join) {
    try { mail = await letterMail(env, row, payer, fetchImpl); } catch { throw err('Zeffy didn’t answer, so nothing was saved. Try again in a minute.', 503); }
  }
  const record = { ...recordFor(seen, { name: payer, form, email: mail || who.email, day, now }), ...(mail ? {} : who.names) };
  const r = await createRecord(env, seen, record, { from: row.state, mode: 'on', now, fetchImpl, by, learnWith: { name: payer }, join: mail ? null : await joinable(env, who) });
  // Not saved (busy, or nothing to claim): the check keeps the name and form it had, so the row never shows a typed guess
  if (['later', 'busy'].includes(r.result)) await setRow(env.DB, id, { payer: row.payer, form_id: row.form_id, form_title: row.form_title }, now, row.state).catch(() => null);
  if (r.result === 'later') throw err('Zeffy is busy, so nothing was saved. Try again in a minute.', 503);
  if (r.result === 'refused') throw err(`${r.error} Try again, or enter it in Zeffy by hand.`, 422);
  if (r.result === 'unsure') throw err('Zeffy didn’t answer. The site is looking for the record, so don’t enter this one again.', 503);
  if (r.result === 'busy') throw err('This check has moved on. Look again.', 409);
  return r;
}

/** A person says this check is that Zeffy entry */
export async function personLink(env, id, zeffyId, { saw = null, by = null, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(zeffyId || ''))) throw err('Pick a Zeffy entry.');
  const first = await getRow(env.DB, id);
  if (first && sameAnswer(first, by, now, (r) => r.state === 'linked' && String(r.zeffy_id) === String(zeffyId))) return { result: 'linked', again: true };
  const row = await mustRow(env, id, { saw });
  if (rejectedBy(row).includes(String(zeffyId))) throw err('Someone said that entry isn’t this check. Look again.', 409);
  if (row.zeffy_id) throw err('This check already has its Zeffy record.', 409);
  let p;
  try {
    p = await zeffyGet(env, `/payments/${encodeURIComponent(zeffyId)}`, {}, fetchImpl);
  } catch (e) {
    if (e.status !== 404) throw err('Zeffy didn’t answer, so nothing changed. Try again in a minute.', 503);
    // Deleted in Zeffy since: it's no longer offered, and with nothing else to ask about the check is decided again
    const left = (() => { try { return JSON.parse(row.note || '[]').filter((x) => String(x.id) !== String(zeffyId)); } catch { return []; } })();
    if (left.length) {
      await setRow(env.DB, id, { note: JSON.stringify(left) }, now, row.state);
      throw err('That Zeffy entry was deleted. Pick another one, or decide this check another way.', 409);
    }
    if (ASKS_ABOUT_ENTRIES.includes(row.reason)) {
      await setRow(env.DB, id, { state: 'read', reason: null, note: null }, now, row.state);
      const on = (await readState(env.DB, KEY)).mode === 'on';
      throw err(`That Zeffy entry was deleted, so there’s nothing to match. ${on ? 'The site decides this check again in a few minutes.' : 'The check waits for its hand entry.'}`, 409);
    }
    await setRow(env.DB, id, { note: null }, now, row.state);
    throw err('That Zeffy entry was deleted, so there’s nothing to match.', 409);
  }
  if (String(p?.id) !== String(zeffyId)) throw err('Zeffy didn’t answer, so nothing changed. Try again in a minute.', 503);
  if (await env.DB.prepare("SELECT id FROM check_gifts WHERE zeffy_id = ? AND state != 'came-back'").bind(String(p.id)).first()) throw err('Another check already has that Zeffy record.', 409);
  if (!(await linkTo(env, row, p, { by, now, fetchImpl }))) {
    const still = await getRow(env.DB, id);
    throw err(still?.state !== row.state ? 'Someone else just saved or matched this check. Look again.' : 'Another check already has that Zeffy record.', 409);
  }
  return { result: 'linked' };
}

/** A person says the matched entry isn't this check: it comes off, never gets offered again, and the check is decided afresh */
export async function personUnlink(env, id, { saw = null, by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id, { saw });
  if (row.state !== 'linked' || !row.zeffy_id) throw err('Only a matched entry can be taken off.', 409);
  let read = {};
  try { read = JSON.parse(row.guess || '{}'); } catch { /* an old row */ }
  // The name may have come from that entry: what was read off the check is what stands
  const payer = read.payer || null;
  // The person who said so decides what it is next, right where they are: the site never makes a record on its own after this
  if (!(await setRow(env.DB, id, {
    state: 'person', reason: payer ? 'unlinked' : 'unreadable', note: null, payer, zeffy_id: null, via: null, score: null, by,
    rejected: JSON.stringify([...rejectedBy(row), String(row.zeffy_id)]),
  }, now, 'linked'))) throw err('This check just changed. Look again.', 409);
  // Only a name read off the check taught anything wrong: one copied from the entry belongs to someone else
  if (read.payer) await env.DB.prepare('DELETE FROM check_payers WHERE key = ?').bind(payerKey(read.payer)).run();
  return { result: 'unlinked' };
}

/**
 * The one to-do of the site's own a saved check shows, in the page's order: Zeffy's amount or unpaid first (those clear
 * themselves once fixed), then a file added after, then an address Zeffy wouldn't take. "Looked at it" clears only that one
 */
const shownToDo = (r) => {
  if (!['linked', 'created'].includes(r.state) || ['amount-off', 'still-unpaid'].includes(r.reason)) return null;
  if ((jsonOf(r.letter, {}).late || []).length) return 'late';
  if (r.address_done === 'refused') return 'address';
  return null;
};

/** A person looked at a file added after the check went into Zeffy, or an address or email Zeffy wouldn't take, and Zeffy says what it should */
export async function personLetterDone(env, id, { saw = null, by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id, { saw });
  const l = jsonOf(row.letter);
  const shown = shownToDo(row);
  const late = shown === 'late';
  const addressRefused = shown === 'address';
  if (!shown) return { result: 'done', again: true };
  const fields = {};
  if (late) {
    fields.letter = JSON.stringify({ ...l, late: [], seenBy: by });
    // A file added after this is told in Slack again
    fields.alerted = String(row.alerted || '').split(',').filter((k) => k && k !== 'letter-late').join(',') || null;
  }
  if (addressRefused) fields.address_done = 'dismissed';
  const keys = Object.keys(fields);
  const r = await env.DB.prepare(`UPDATE check_gifts SET ${keys.map((k) => `${k} = ?, `).join('')}updated_at = ? WHERE id = ? AND letter IS ? AND address_done IS ?`)
    .bind(...keys.map((k) => fields[k]), new Date(now).toISOString(), id, row.letter ?? null, row.address_done ?? null).run();
  if (!r.meta?.changes) throw err('This check just changed. Look again.', 409);
  await allClear(env, row, 'Looked at.');
  return { result: 'done' };
}

/** While watching, a person takes back "not a gift": it waits for the hand entry again */
export async function personIsGift(env, id, { saw = null, by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id, { saw });
  if (!['left-out', 'store'].includes(row.state)) throw err('This check has moved on. Look again.', 409);
  if (!(await setRow(env.DB, id, { state: 'person', reason: 'told-gift', note: null, by }, now, row.state))) throw err('This check just changed. Look again.', 409);
  return { result: 'waiting' };
}

/** A person says this isn't a gift */
export async function personNotGift(env, id, { saw = null, by = null, now = Date.now() } = {}) {
  const first = await getRow(env.DB, id);
  if (first && sameAnswer(first, by, now, (r) => r.state === 'left-out' && r.reason === 'person')) return { result: 'left-out', again: true };
  const row = await mustRow(env, id, { saw });
  if (row.zeffy_id) throw err('This check has a Zeffy record. Delete it in Zeffy first, and this page catches up within the hour.', 409);
  if (!(await setRow(env.DB, id, { state: 'left-out', reason: 'person', note: null, by }, now, row.state))) throw err('This check just changed. Look again.', 409);
  await allClear(env, row, 'Left out: not a gift.');
  return { result: 'left-out' };
}
