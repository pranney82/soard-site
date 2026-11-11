/**
 * A check deposited in Mercury becomes its Zeffy record
 * ===========================================================================
 * Peter, Nov 5-6 2026: "when a check is deposited in mercury can the zeffy
 * record be created too?", and a person only "if its absolutely necessary".
 * Mercury holds the money and the picture; Zeffy stays the record of the gift.
 * Nothing here keeps a second copy of either: a row says what happened to one
 * check, and which Zeffy record it became.
 *
 * Peter, Nov 10 2026: "admin wants to approve all entries into zeffy", with
 * everything filled in, a choice wherever two answers exist, an optional
 * email, and "dont send to zeffy" for what isn't Zeffy's. So the site prepares
 * each check and a person sends it: nothing reaches Zeffy without a person's
 * press. Every record is made with its tax receipt and confirmation email off,
 * the way staff enter checks by hand, so nothing reaches a donor either.
 *
 * The steps, one big job a run (Cloudflare gives this work about 30 seconds,
 * and a vision model can take 20 of them):
 *   1. Every checkDeposit Mercury sends (the webhook mirrors it into
 *      mercury_txns, ./_mercury-txns.js) gets a row. Each one not final is read
 *      again by id: a check that later posts, comes back, or gets a file
 *      attached shows up here.
 *   2. The picture is read by two models from different makers (READERS). They
 *      must agree who wrote it and where they live, and what's read must equal
 *      Mercury's amount and check number. The picture stays in memory, and a
 *      number that could be a bank account never passes safeText.
 *   3. Files the team attaches to the deposit in Mercury ("letters": a cover
 *      letter, a grant sheet) are read the same way. A letter is the source of
 *      truth for whose gift it is and where its receipt goes; a gift through a
 *      giving platform or donor-advised fund is its donor's.
 *   4. prepareCard reads Zeffy (400 days, any name) and fills in the card: who
 *      it's from (a choice when the check and the letter differ), which Zeffy
 *      donor (a choice when Zeffy has more than one who could be them), form,
 *      date, email, mailing address, and what to look at first (an entry Zeffy
 *      may already have, a pledge, an event memo). A hand entry that surely is
 *      this check is matched by itself: it's in Zeffy already.
 *   5. A person sends it (personSend), or says it isn't Zeffy's (personDontSend),
 *      or matches it to an entry (personLink). Zeffy is read again first, and a
 *      POST whose answer never came is looked for, never sent again.
 *   6. After: the address and email go on the donor (writeAddresses), and the
 *      record is watched for a check Mercury turns down or corrects, a record
 *      deleted in Zeffy, a file added in Mercury, and a second entry typed.
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
// Decided the same way on the Checks page: one copy of what's one giver, one address, a whole address, a bank-like number
import { hasAccountDigits, payerKey, surelySameGiver, sameGiver, sameName, addressProblem, addressKey, addressLine, nameProblem, emailProblem, emailOf, TAG_DOMAIN, isTag } from '../../public/admin/checks-shared.js';

export { hasAccountDigits, payerKey, surelySameGiver, sameGiver, addressKey, TAG_DOMAIN };

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
const WAITING_REREAD_MS = 20 * MIN; // a check whose card waits on a person: a letter attached to it is read within the hour
const FINAL_AFTER_MS = 60 * DAY;   // a check that posted this long ago has stayed
const PENDING_ALARM_MS = 14 * DAY; // Mercury says up to 5 business days
const NO_RECORD_ALARM_MS = 10 * DAY;
const UNSURE_AFTER_MS = 30 * MIN;  // how long Zeffy gets to show a POST it never answered
const SENT_LOOK_MS = 7 * DAY;      // how long a send whose answer was unclear is looked for, whatever the check became since
const LOOK_BACK_S = 120 * 86400;   // how far back Zeffy is read for one check
const DATED_BACK_MS = 60 * DAY;    // a check older than this is dated the day it was deposited
const SAME_GIVER_DAYS = 14;        // a hand entry this long before the check's date can be it
const OTHER_NAME_DAYS = 3;         // under another name, only one dated about when the check was
const AFTER_DAYS = 21;             // a hand entry this long after the check's date or deposit can be it
const NO_DATE_DAYS = 45;           // with no date read, how far back the giver's entry is asked about
const LATE_DAYS = 120;             // a hand entry this long after the deposit is put to a person, not linked
const MATCH_MAX_AGE_MS = 150 * DAY; // the hourly look stops at checks deposited this long ago, so its read of Zeffy stays whole
const WRITE_TRIES = 3;             // a write test that keeps failing stops trying after this many days
const ZEFFY_PAGES = 30;
const LIST_LIMIT = 300;
const LETTER_TRIES = 3;            // a letter file that can't be fetched or read this many times goes to a person
const MAX_LETTER_FILES = 4;        // more files than this beside one check: a person looks
const ADDRESS_RETRY_MS = 15 * MIN; // Zeffy not answering about an address: tried again after this
const ADDRESS_GIVE_UP_MS = DAY;    // and after this long of it, a person adds it

/** The one-time test of writing to Zeffy: a new id runs it once more on the next heartbeat. Nov 7 added keeping a giver's gifts on one contact; Nov 10 an address on a contact */
export const WRITE_TEST = '2026-11-10';

/** A mail domain with no mail server: an address here reaches no one, so it can sit on a donor's contact for the seconds a record takes */
export const tagFor = (id, now) => `check-${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}-${Number(now).toString(36)}@${TAG_DOMAIN}`;
const TAG_ALARM_MS = DAY;          // an address the site couldn't take off a donor's contact for this long goes to a person
/** The write test's one record with an email: a SOARD inbox, so anyone can see that Zeffy sent nothing with receipts and emails off */
export const WRITE_TEST_EMAIL = 'peter+zeffy-write-test@soardcharity.com';
/** The write test's address: made up, on a test contact that's removed straight after */
const WRITE_TEST_ADDRESS = { line1: '1 Test Way', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' };

const CARDS_URL = `${SITE_ORIGIN}/admin/#job-costs/checks`;
const ZEFFY_PAYMENTS = 'https://www.zeffy.com/en-US/o/all-payments';
const ZEFFY_CONTACTS = 'https://www.zeffy.com/en-US/o/crm/contacts';

/**
 * What a card asks the person to look at before sending, in the words the page and Slack use. A card with none of these is
 * ready as it's filled in. Kept on the row as `reason` (the first that applies); the card lists them all
 */
export const REASONS = {
  'no-picture': 'Mercury has no picture of this check, so the site couldn’t read who wrote it. Look at it in Mercury.',
  unreadable: 'The site couldn’t read who wrote this check. Look at it in Mercury and type the name.',
  'maybe-double': 'Zeffy may already have this check, under this name or another. If one of these is it, press “This is the check” instead of sending.',
  'amount-differs': 'Zeffy has an entry from this giver around this date for a different amount. If it’s this check, match it and fix the amount in Zeffy.',
  pledge: 'This giver has an unpaid pledge or check promise in Zeffy. If this check pays it, press “This is the check” and mark it paid in Zeffy.',
  event: 'The memo points to an event or a group’s campaign. Zeffy takes tickets and sponsorships only by hand: if that’s what this is, enter it there and choose “Don’t send to Zeffy”.',
  vendor: 'SOARD pays this company. Make sure it’s a gift, not a refund.',
  'no-form': 'No open Zeffy donation form fitted this check. Pick one.',
  'zeffy-refused': 'Zeffy didn’t take this record when it was sent.',
  unsure: 'Zeffy didn’t answer when this was sent, and the record hasn’t shown up. If it isn’t in Zeffy, send it again.',
  'zeffy-busy': 'Zeffy kept saying to wait on this giver for a day.',
  redeposit: 'Another deposit has the same check number and amount. If it’s the same check deposited again, it isn’t a new gift: choose “Don’t send”. If the first deposit came back, match this one to its Zeffy record.',
  'redeposit-back': 'This check was deposited before, and that deposit came back. This one is the money: send it, or choose “This is the check” beside the first deposit’s Zeffy record if it’s still there.',
  'look-by-hand': 'Zeffy has more payments than the site can look through at once, so it can’t be sure this check isn’t there already. Look in Zeffy before sending.',
  'record-gone': 'This check’s Zeffy record is gone. Send it again if it should be there.',
  bank: 'This check shows a bank’s name, not who paid: likely a cashier’s check. Look at it in Mercury for who sent it.',
  unlinked: 'A person said the matched Zeffy entry isn’t this check.',
  'store-account': 'This check went into the store’s account in Mercury. Send it to Zeffy only if it’s a gift.',
  own: 'This looks like SOARD’s own money.',
  refund: 'The memo says this is a refund or reimbursement.',
  'not-a-giver': 'This looks like insurance or a tax payment, not a gift.',
  category: 'Its Category in Mercury isn’t a gift.',
  'amount-off': 'Zeffy’s entry and the check are for different amounts. Fix the amount in Zeffy.',
  'still-unpaid': 'Zeffy still shows this entry as unpaid. Mark it paid in Zeffy.',
  letter: 'A letter came with this check in Mercury, and the site couldn’t read whose gift it says it is. Look at it in Mercury.',
  'letter-amount': 'The letter that came with this check is for a different amount. Look at it in Mercury.',
  'letter-many': 'More files came with this check in Mercury than the site reads. Look at them in Mercury.',
};
/** What happened on a send that the card keeps saying until it's sent again or matched: never dropped by a refresh */
const STICKY = ['unsure', 'zeffy-refused', 'record-gone', 'unlinked', 'zeffy-busy'];
/** The card's notes that say it may not be Zeffy's at all: it comes with "Don't send" suggested */
const SUGGEST_DONT = { own: 'own', refund: 'refund', 'not-a-giver': 'insurance', event: 'event' };

/**
 * Why a person said "Don't send to Zeffy": the real reasons a check deposited to SOARD isn't a Zeffy gift. Each is said on the
 * row after, and "Send to Zeffy after all" undoes it
 */
export const DONT_REASONS = {
  already: 'Already in Zeffy another way (entered by hand, or given online)',
  event: 'Event tickets or a sponsorship, entered in Zeffy by hand',
  refund: 'A refund or reimbursement',
  store: 'A store sale',
  own: 'SOARD’s own money moving between accounts',
  insurance: 'An insurance or tax payment',
  repeat: 'The same check deposited again',
};


/**
 * Mercury's Category that says a deposit is a gift (Peter, Nov 10): Individual Contribution, Corporate Contribution, Grant.
 * Event & Sponsorship, Refund / Reimbursement and everything else stay out of Zeffy
 */
const GIFT_CATEGORY = /\b(contributions?|grants?)\b/i;
export const isContribution = (category) => GIFT_CATEGORY.test(clean(category));
/** A check marked Grant in Mercury goes on the newest Grant Funding form */
const GRANT_CATEGORY = /\bgrants?\b/i;
/** A check's Category in Mercury: from the transaction when the site has it in hand, else as last mirrored */
async function categoryOf(env, row, txn = null) {
  if (txn && 'categoryData' in txn) return clean(txn.categoryData?.name);
  const t = await env.DB.prepare('SELECT category_name FROM mercury_txns WHERE id = ?').bind(row.id).first().catch(() => null);
  return clean(t?.category_name);
}

/** Not sent to Zeffy: a person's word, or a check that came back */
export const LEFT_OUT = {
  person: 'A person said not to send it to Zeffy.',
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
// card: what the person approving sees, filled in (prepareCard). send: what they sent with it (the donor, address and email)
const ADDED = ['letter TEXT', 'address TEXT', 'drawer TEXT', 'address_done TEXT', 'address_at TEXT', 'address_tried TEXT', 'card TEXT', 'send TEXT', 'taught TEXT', 'name_by TEXT', 'extra TEXT', 'earlier TEXT'];

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
  // Every check is approved by a person from Nov 10: one the site was only watching, or one already waiting on a person, gets
  // its card made, keeping what was said on a send that didn't finish (STICKY)
  if (!have.has('card')) await DB.prepare("UPDATE check_gifts SET state = 'read', try_at = NULL WHERE state IN ('would', 'person')").run();
  if (!have.has('name_by')) {
    // Who wrote the check is only ever what was read off it: a check read before drawer was kept (Nov 10) has it as payer,
    // unless a person gave that name (by) or a letter did (a letter note that names someone). The empty note every check
    // gets on its first look names nobody. (Before Nov 10 a person's name only ever went on a record at once, never on a
    // check left waiting, so no waiting check's name is a person's: name_by starts empty)
    await DB.prepare("UPDATE check_gifts SET drawer = payer WHERE drawer IS NULL AND payer IS NOT NULL AND by IS NULL AND (letter IS NULL OR COALESCE(json_extract(letter, '$.name'), '') = '') AND state NOT IN ('new', 'store')").run();
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
  // (joined, two short numbers can meet as a long one: the joined memo is made safe as a whole)
  const memo = safeMemo((fuller ? [memos.sort((x, y) => y.length - x.length)[0]] : memos).join(' / '), 200, checkNumber);
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
  // Whole by the one rule the page checks too (addressProblem): a street with a number and a word, a city, a state, a ZIP
  if (addressProblem({ line1, city, state, postal_code: zip }, checkNumber)) return null;
  const z = zip.match(/^(\d{5})(?:-?(\d{4}))?$/);
  // The first five only: a ZIP+4 is nine digits in a row, which is what a bank number looks like, and nothing keeps one
  return { line1: tidyStreet(line1), city: tidyName(city), state, postal_code: z[1], country: 'US' };
}

/** What two readers both saw, or null */
export function agreeAddress(a, b) {
  if (!a || !b || addressKey(a) !== addressKey(b) || a.postal_code !== b.postal_code) return null;
  return { ...a };
}

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

/** Who wrote the check, as read off it, and nothing else: a name a person typed or a letter gave is who the gift is from */
const checkName = (row) => row?.drawer || '';

/** What the letter with a check says, as read before the site decided it: { why } when it can't be used */
export const letterSays = (row) => {
  const l = jsonOf(row?.letter, {});
  return l.why ? { why: l.why } : { name: l.name || '', email: l.email || '', address: l.address || null };
};



/** A letter file still to be read: its check waits for it */
export const lettersWaiting = (row) => (jsonOf(row?.letter, {}).pending || []).length > 0;

/** One reader's answer about a letter, made safe: never SOARD as the giver, never an address or email of SOARD's own */
function cleanLetter(r) {
  const name = safeText(notName(r?.recordAs), 120);
  const email = emailOf(clean(r?.email).replace(/^mailto:/i, ''));
  return {
    about: r?.aboutGift === true || /^(true|yes)$/i.test(String(r?.aboutGift ?? '')),
    name: name && !OWN.test(name) && !isBank(name) ? name : '',
    email,
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

// The checks not sent yet: their letter files are read, and the card shows what they say
const DECIDING = ['new', 'read', 'person'];
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
  // A file added after the record is in Zeffy, or one that was still unread when it went in: a person's to look at
  const saved = ['created', 'linked'].includes(row.state);
  const lateNow = was && saved ? [...new Set([...fresh, ...(was.pending || []).filter((k) => present.includes(k))])] : [];
  const late = [...new Set([...(was?.late || []), ...lateNow])].filter((k) => present.includes(k));
  // The day a letter gets to be read starts once its check can be read, and again whenever it comes back to be decided
  const since = row.state === 'new' || !pending.length ? null : was?.since && (was.pending || []).length ? was.since : new Date(now).toISOString();
  if (was && sameSet(present, known) && sameSet(pending, was.pending || []) && (was.since || null) === since && sameSet(late, was.late || [])) return false;
  // What the files say is worked out again from the ones there now, whatever the check's state: one taken off stops counting
  const next = { ...(was || {}), files: present, reads, pending, since, late, ...summary({ files: present, reads }) };
  if (!(await swapLetter(env.DB, row.id, row.letter, next, now))) return false;
  // A waiting card whose files changed with nothing left to read (one taken off, too many) is made again now
  if (row.state === 'person' && !pending.length) await setRow(env.DB, row.id, { state: 'read', try_at: null }, now, 'person');
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
export async function readLetter(env, row, { now, fetchImpl }) {
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
  // A card already waiting is made again with what the letter says
  if (!pending.length && row.state === 'person') await setRow(env.DB, row.id, { state: 'read', try_at: null }, now, 'person');
  return { result: 'letter' };
}

// ─── Is it in Zeffy already? ────────────────────────────────────────

const namesOn = (p) => [clean(p?.buyer?.company_name), givenName(p?.buyer)].filter(Boolean);
const paidByCheck = (p) => /che(ck|que)/i.test(String(p?.payment_method?.type || ''));
const madeByHand = (p) => p?.type === 'manual' || p?.type === 'imported';
/**
 * A gift given on a Zeffy form with "Donor-advised fund": Zeffy records it at once (Due until someone marks it paid) and
 * the money comes days or weeks later from the fund, usually as a check under the fund's name (Fidelity Charitable, the
 * family fund), not the donor's. Zeffy's word for the method is "daf" (read in SOARD's Zeffy, Nov 10 2026, beside "cheque"
 * for checks); "Due" is status pending. Other spellings count too, in case Zeffy writes it out
 */
export const byDaf = (p) => /(^|[^a-z])daf|donor.?advised/i.test(String(p?.payment_method?.type || ''));
/** How long before a check's date a DAF gift already marked paid can still be the gift that check pays */
const DAF_DAYS = 90;
/** How long a DAF gift still Due can be the gift a check pays: one left Due longer was abandoned, not a check on its way */
const DAF_DUE_DAYS = 365;

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
      // Zeffy, by a person. Still Due: within DAF_DUE_DAYS (an older one was abandoned). Paid: one given in the DAF_DAYS before
      const since = Math.min(anchor, early);
      const live = unpaid ? at >= since - DAF_DUE_DAYS * 86400 : at >= since - DAF_DAYS * 86400;
      if (!live) continue;
      if (Number(p.amount) === Number(row.cents)) (giver && unpaid ? out.promised : out.maybe).push(p);
      else if (giver && unpaid) out.promised.push(p);
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

export function netOf(row, payments, claimed = new Set(), { learned = null, turnedPaid = new Set() } = {}) {
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
    // A DAF gift a fund's check may be paying, under any name: still Due (within DAF_DUE_DAYS), or given in the DAF_DAYS before
    const dafLive = daf && (unpaid ? at >= written - DAF_DUE_DAYS * 86400 : at >= written - DAF_DAYS * 86400);
    if (Number(p.amount) === Number(row.cents)) {
      // Made since the check was written; typed in or marked paid since then, however it's dated, under any name; the
      // giver's own pledge still open; or a live DAF gift
      if (at >= written || fresh || (giver && unpaid) || dafLive) out.push(p);
    } else if (dafLive && Number(p.amount) < Number(row.cents)) {
      // A fund's one check often pays several of its donors' grants: DAF gifts that add up to it count together
      parts.push(p);
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
/** Entries Zeffy turned paid (or that showed up) since the check was written, under any name: the wide look counts them */
async function freshFor(env, row) {
  return { turnedPaid: await freshSince(env.DB, writtenS(row)) };
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
  const r = await DB.prepare(`SELECT cents FROM check_gifts WHERE id != ? AND zeffy_id IS NULL AND state IN ('new', 'read', 'person', 'creating', 'unsure') AND deposited_at >= ?`)
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

/** Category words that say a check isn't a Zeffy gift, and the "Don't send" reason each suggests */
const CATEGORY_DONT = [[/\b(event|sponsor\w*|ticket\w*)\b/i, 'event'], [/\b(refund\w*|reimburs\w*)\b/i, 'refund'], [/\btransfer\w*\b/i, 'own'], [/\b(sales?|store|merch\w*)\b/i, 'store'], [/\b(insurance|tax\w*)\b/i, 'insurance']];

/**
 * What a card says about a check, with nothing read or written → { link, notes, entries, form, suggest, dontReason }.
 * link: a hand entry that surely is this check (it's in Zeffy already, so it's matched, not sent). notes: what to look at
 * before sending, most important first (REASONS). entries: Zeffy's entries that may be this check, for "This is the check".
 * contested: entries more than one waiting check fits, which never match by themselves. twin: another deposit of the
 * same check number and amount, with its Zeffy record when it has one
 */
export function notesFor(row, { payments = [], claimed = new Set(), forms = [], learned = null, drawerLearned = null, isVendor = false, whole = true, contested = new Set(), twin = null, net = [], category = '' } = {}) {
  const m = matchBoth(row, payments, claimedFor(row, claimed), learned, drawerLearned);
  const sure = m.same.filter((p) => !contested.has(String(p.id)));
  // (a deposit that came back gives its record to the same check deposited again: linkTo takes it over)
  if (sure.length && (!twin || twin.state === 'came-back')) return { link: sure[0], notes: [], entries: [], form: null, suggest: 'send', dontReason: null };
  const notes = [];
  const add = (n) => { if (n && !notes.includes(n)) notes.push(n); };
  const unclaimed = (list) => list.filter((p) => !claimedFor(row, claimed).has(String(p.id)));
  const twinEntries = twin?.zeffy_id ? payments.filter((p) => String(p.id) === String(twin.zeffy_id)) : [];
  // The first deposit came back: this one is the money (sent, or matched to the first's record if it's still in Zeffy)
  const backBefore = twin?.state === 'came-back';
  if (twin) add(backBefore ? 'redeposit-back' : 'redeposit');
  if (m.promised.length) add('pledge');
  if (m.same.length || m.maybe.length || unclaimed(net).length) add('maybe-double');
  if (m.other.length) add('amount-differs');
  if (!whole) add('look-by-hand');
  const memo = row.memo || '';
  const drawer = row.drawer || '';
  // Nothing read off the check at all (a name left for a person because a letter's pages disagree is the letter's note)
  if (!row.payer && !row.drawer) add('unreadable');
  else if (isBank(row.payer)) add('bank');
  if (OWN.test(row.payer || '') || OWN.test(drawer)) add('own');
  if (REFUND_MEMO.test(memo)) add('refund');
  if ([row.payer || '', drawer].some((n) => n && NOT_A_GIVER.test(n) && !FOUNDATION.test(n)) && !GIFT_MEMO.test(memo)) add('not-a-giver');
  if (EVENT_MEMO.test(memo)) add('event');
  if (isVendor && !GIFT_MEMO.test(memo)) add('vendor');
  const nonGift = category && !isContribution(category);
  if (nonGift) add('category');
  const form = pickForm(row, forms, learned);
  if (!form) add('no-form');
  const entries = [...new Map([...twinEntries, ...m.promised, ...m.same, ...m.maybe, ...m.other, ...unclaimed(net)].map((p) => [String(p.id), p])).values()];
  // Not a Zeffy gift by the look of it: it comes with "Don't send" suggested, and the person still decides
  const repeat = twin && !backBefore;
  const dontReason = repeat ? 'repeat' : notes.map((n) => SUGGEST_DONT[n]).find(Boolean) || (nonGift ? CATEGORY_DONT.find(([re]) => re.test(category))?.[1] || null : null);
  const suggest = repeat || notes.some((n) => SUGGEST_DONT[n]) || nonGift ? 'dont' : 'send';
  return { link: null, notes, entries, form, suggest, dontReason };
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

/** Back on its card for a person, with what happened (a send Zeffy didn't answer or refused, a record gone): said in Slack once */
async function toPerson(env, row, reason, { note = undefined, now }) {
  if (!(await setRow(env.DB, row.id, { state: 'person', reason, ...(note !== undefined ? { note } : {}) }, now, row.state))) return false;
  await tell(env, row, reason, { title: `A check needs a look: ${money(row.cents)}`, lead: (typeof note === 'string' && !note.startsWith('[') && note) || REASONS[reason], fix: 'Open Checks in Job Costs.' });
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
  const letGo = () => env.DB.prepare('DELETE FROM check_tags WHERE contact = ? AND email = ?').bind(contact, tag).run();
  // Read again now that it's the site's: an email put on them since (the address step, a person in Zeffy) is how Zeffy files
  // the record under them, and the no-mail address never goes on over it
  let fresh;
  try {
    fresh = await zeffyGet(env, `/contacts/${encodeURIComponent(contact)}`, {}, fetchImpl);
  } catch (e) {
    await letGo();
    if (e.status === 404) throw Object.assign(new Error('That donor isn’t in Zeffy any more'), { status: 404 });
    throw Object.assign(new Error('Zeffy didn’t answer about this giver'), { later: true, status: 429 });
  }
  const theirs = clean(fresh?.email);
  if (theirs && !isTag(theirs)) {
    await letGo();
    const p = await zeffySend(env, 'POST', '/payments', { ...record, email: theirs.toLowerCase() }, fetchImpl);
    if (p && String(p.contact) !== String(contact)) p.newContact = true;
    return p;
  }
  let joined = false;
  try {
    await zeffySend(env, 'PATCH', `/contacts/${encodeURIComponent(contact)}`, { email: tag }, fetchImpl);
    joined = true;
  } catch (e) {
    // Zeffy answering "later": the address never went on, and the check is tried again on a later run
    if (e.status === 429) {
      await clearTag(env, { email: tag, contact }, fetchImpl).catch(() => null);
      throw Object.assign(new Error('Zeffy didn’t answer about this giver'), { later: true, status: 429 });
    }
    // Zeffy not answering: the address may still go on after this. The note stays, so a later run takes it off once it's
    // there (clearTags), and the check is tried again on a later run. Nothing is saved
    if (!e.status || e.status >= 500) throw Object.assign(new Error('Zeffy didn’t answer about this giver'), { later: true, status: 429 });
    /* refused outright: the record goes in under its own contact, as it would without this */
  }
  let unanswered = false;
  try {
    const p = await zeffySend(env, 'POST', '/payments', joined ? { ...record, email: tag } : record, fetchImpl);
    // Filed under a new contact after all: the giver's own contact is still the one to remember, and the address comes off that one too
    if (p && (!joined || String(p.contact) !== String(contact))) {
      p.newContact = true;
      // Zeffy made a new contact with the no-mail address on it: noted first, so a run takes it off if this can't
      if (joined && p.contact) {
        await env.DB.prepare('INSERT OR IGNORE INTO check_tags (contact, email, check_id, at) VALUES (?, ?, ?, ?)').bind(String(p.contact), tag, checkId, new Date(now).toISOString()).run();
        await clearTag(env, { email: tag, contact: String(p.contact) }, fetchImpl).catch(() => null);
      }
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

/** Takes the address off, only while it's still the one the site put on: an email someone typed since stays. Its note goes (that contact's only) */
async function clearTag(env, tag, fetchImpl) {
  let c = null;
  try {
    c = await zeffyGet(env, `/contacts/${encodeURIComponent(tag.contact)}`, {}, fetchImpl);
  } catch (e) {
    if (e.status !== 404) return false;
  }
  if (c && clean(c.email).toLowerCase() === tag.email.toLowerCase()) {
    try { await zeffySend(env, 'PATCH', `/contacts/${encodeURIComponent(tag.contact)}`, { email: null }, fetchImpl); } catch { return false; }
  }
  await env.DB.prepare('DELETE FROM check_tags WHERE contact = ? AND email = ?').bind(String(tag.contact), tag.email).run();
  if (tag.alerted && env.SLACK_BOT_TOKEN) {
    const words = 'The no-mail address is off the donor’s contact.';
    await slackResolved(env, `check-tag:${tag.email}`, slackCard({ icon: '✅', title: 'A donor’s contact in Zeffy', lead: words }), { summary: words }).catch(() => null);
  }
  return true;
}

/**
 * The site's no-mail address found on a contact with no note of it: one Zeffy put on after the site stopped waiting for it.
 * No save is using it (every save notes its address before it goes on), so it comes off now. Says whether the contact is clear
 */
async function strayTagOff(env, contact, email, fetchImpl, now = Date.now()) {
  if (!isTag(email)) return true;
  if (await env.DB.prepare('SELECT 1 AS y FROM check_tags WHERE contact = ?').bind(String(contact)).first()) return false;
  if (await clearTag(env, { contact: String(contact), email: clean(email) }, fetchImpl)) return true;
  await env.DB.prepare('INSERT OR IGNORE INTO check_tags (contact, email, check_id, at) VALUES (?, ?, NULL, ?)').bind(String(contact), clean(email), new Date(now).toISOString()).run();
  return false;
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
    if (r?.ok) await env.DB.prepare('UPDATE check_tags SET alerted = 1 WHERE contact = ? AND email = ?').bind(String(tag.contact), tag.email).run();
  }
}

/**
 * One POST for one check. The row is claimed first and the exact record kept on it, so a run cut off here is found by
 * settleUnsure. Zeffy has no way to refuse a repeat: when it may have acted, this never sends it again.
 * keep: what the person chose (the name, the form, the address and email to add), written with the claim, as the record
 * may be made from here on. undo: what the row had, put back with the claim's end when Zeffy saved nothing, so the card
 * is as it was
 */
async function createRecord(env, row, record, { from, now, fetchImpl, by = null, learnWith = null, join = null, keep = {}, undo = {} }) {
  const iso = new Date(now).toISOString();
  // Earlier sends of this check with no clear answer are still looked for, whatever this one does (`earlier`): put back as
  // they were if this one saves nothing; kept if it saves or goes unanswered too (anything found for them then is named)
  const prior = jsonOf(row.payload);
  const earlierWas = row.earlier ?? null;
  const earlierNow = prior ? JSON.stringify([...jsonOf(row.earlier, []), prior]) : earlierWas;
  undo = { ...undo, payload: row.payload ?? null, earlier: earlierWas };
  keep = { ...keep, earlier: earlierNow };
  const kept = Object.keys(keep);
  const claim = await env.DB.prepare(`UPDATE check_gifts SET state = 'creating', payload = ?, try_at = ?, ${kept.map((k) => `${k} = ?, `).join('')}updated_at = ? WHERE id = ? AND state = ?`)
    .bind(JSON.stringify({ ...record, ...(join ? { join } : {}), ...(by ? { by } : {}), at: iso, files: jsonOf(row.letter, {}).files || [], name: learnWith?.name || row.payer || '' }), iso, ...kept.map((k) => keep[k]), iso, row.id, from).run();
  if (!claim.meta?.changes) return { result: 'busy' };
  let p;
  try {
    p = join ? await postJoined(env, join, record, { tag: tagFor(row.id, now), now, fetchImpl, checkId: row.id }) : await zeffySend(env, 'POST', '/payments', record, fetchImpl);
  } catch (e) {
    // Not saved: a later run tries again, and this check waits at the back of the line, so one giver never holds up the rest
    if (e.status === 429 || e.later) { await setRow(env.DB, row.id, { ...undo, state: from, try_at: iso }, now, 'creating'); return { result: 'later' }; }
    if (e.status && e.status < 500) {
      await setRow(env.DB, row.id, { ...undo }, now, 'creating');
      await toPerson(env, { ...row, state: 'creating' }, 'zeffy-refused', { note: refusalWords(e), now });
      return { result: 'refused', error: refusalWords(e) };
    }
    // A timeout or a 5xx (even one with Zeffy's own error code, which has been seen with the record saved): it may have
    // saved. settleUnsure looks for it, and nothing is sent again until it's found or given up on
    await setRow(env.DB, row.id, { state: 'unsure', try_at: iso }, now, 'creating');
    return { result: 'unsure' };
  }
  if (!p?.id) {
    await setRow(env.DB, row.id, { state: 'unsure', try_at: iso }, now, 'creating');
    return { result: 'unsure' };
  }
  // Filed somewhere other than the giver's own contact: that contact is still the one to remember
  if (join && String(p.contact) !== String(join)) p.newContact = true;
  const lateFiles = filesSince(await getRow(env.DB, row.id), { files: jsonOf(row.letter, {}).files || [] });
  // A check Mercury sent back while this was saving keeps "came back", and now has its record to cancel
  // (a run that took the claim for one left behind may have called it unsure meanwhile: Zeffy's answer settles it)
  await env.DB.prepare(`UPDATE check_gifts SET state = CASE WHEN state IN ('creating', 'unsure') THEN 'created' ELSE state END, via = ?, zeffy_id = ?, reason = CASE WHEN state IN ('creating', 'unsure') THEN NULL ELSE reason END, by = ?, form_id = ?, payload = NULL, address_done = NULL, address_at = NULL, updated_at = ? WHERE id = ?`)
    .bind(by ? 'person' : 'site', String(p.id), by, record.campaign_id, iso, row.id).run();
  await teach(env.DB, learnWith?.name || row.payer, { contactId: p.newContact ? null : p.contact || null, campaignId: record.campaign_id, by: by || 'site' }, now);
  await handlePayment(env, p, { via: 'check', now }).catch(() => null);
  await allClear(env, row, 'Saved in Zeffy.');
  await markLate(env, { ...row, state: 'created' }, lateFiles, now);
  return { result: 'created', id: String(p.id) };
}

/** Zeffy's payments on one form made in a window: where one record the site sent would be, however long ago it's dated */
async function paymentsBetween(env, fromS, toS, campaign, fetchImpl) {
  const out = [];
  let after = null;
  for (let page = 0; page < ZEFFY_PAGES; page++) {
    const r = await zeffyGet(env, '/payments', { 'created[gte]': Math.floor(fromS), 'created[lte]': Math.ceil(toS), ...(campaign ? { campaign: String(campaign) } : {}), limit: 100, starting_after: after }, fetchImpl);
    out.push(...(r?.data || []));
    if (!r?.has_more || !r.next_cursor) return out;
    after = r.next_cursor;
  }
  throw new Error('Zeffy has more payments than the site reads at once');
}

/**
 * The record a send Zeffy never answered may have saved, looked for where it would be: on its form, for its amount, under
 * its giver (or the contact it was filed under), dated within two days of the date it was sent with. Exactly there, so a
 * record dated a year back is found as surely as one dated today. Throws when Zeffy doesn't answer
 */
async function findSent(env, row, sent, fetchImpl) {
  const sentAt = Date.parse(sent?.payment_date || '') / 1000;
  if (!Number.isFinite(sentAt)) return null;
  const payments = await paymentsBetween(env, sentAt - 2 * 86400, sentAt + 2 * 86400, sent.campaign_id, fetchImpl);
  const claimed = await claimedIds(env.DB);
  // Never one Zeffy already had before the send (the site's own note of when it first saw each payment: 0 is from before
  // it watched), nor one a person said is another gift: a hand entry of someone else's gift that day isn't what was sent
  const pressed = Date.parse(sent.at || row.try_at || '') / 1000;
  const before = new Set(Number.isFinite(pressed) ? ((await env.DB.prepare('SELECT payment_id FROM zeffy_seen WHERE first_seen < ?').bind(Math.floor(pressed) - 60).all()).results || []).map((r) => String(r.payment_id)) : []);
  // (and never one already named on this check as another send's record: two sends of one check look alike)
  const ruled = new Set([...rejectedBy(row).map(String), ...extrasOf(row)]);
  const name = clean(`${sent.first_name || ''} ${sent.last_name || ''}`);
  return payments.find((p) => !claimed.has(String(p.id)) && !before.has(String(p.id)) && !ruled.has(String(p.id)) && Number(p.amount) === Number(sent.amount ?? row.cents)
    && String(p.campaign_id) === String(sent.campaign_id) && paidByCheck(p)
    // Filed under the giver's contact, it may carry the names Zeffy already had for them
    && (namesOn(p).some((n) => sameGiver(name, n) || sameGiver(row.payer, n)) || (sent.join && String(p.contact) === String(sent.join)))
    // Last month's gift from the same giver is another gift: only a record dated as this one was sent can be it
    && Math.abs(Number(p.created) - sentAt) <= 2 * 86400) || null;
}

/** Sent to be filed under the giver's contact and found under a new one: that one may have kept the no-mail address */
async function newContactTagOff(env, sent, hit, now, fetchImpl) {
  if (!sent?.join || !hit.contact || String(hit.contact) === String(sent.join)) return;
  const c = await zeffyGet(env, `/contacts/${encodeURIComponent(hit.contact)}`, {}, fetchImpl).catch(() => null);
  if (isTag(c?.email)) await strayTagOff(env, hit.contact, c.email, fetchImpl, now).catch(() => false);
}

/** Records Zeffy has for a check beyond its own, to delete there (from sends with no clear answer) */
const extrasOf = (row) => String(row?.extra || '').split(',').filter(Boolean);
/** Every send of a check still out with no clear answer: the latest (payload) and any before it (earlier) */
const outstanding = (row) => [jsonOf(row?.payload), ...jsonOf(row?.earlier, [])].filter(Boolean);

/**
 * The sends before the latest, each looked for where it would be: found while the check waits with no record, it's the
 * check's record; found otherwise, it's a record to delete, named on the check. Each is looked for a week
 */
async function lookForEarlier(env, row, { now, fetchImpl }) {
  const olds = jsonOf(row.earlier, []);
  if (!olds.length) return;
  const done = new Set();
  for (const old of olds) {
    if (now - Date.parse(old.at || 0) > SENT_LOOK_MS) { done.add(old.at); continue; }
    let hit;
    try { hit = await findSent(env, row, old, fetchImpl); } catch { continue; }
    if (!hit) continue;
    const cur = await getRow(env.DB, row.id);
    if (!cur) return;
    if (cur.state === 'person' && !cur.zeffy_id) { await settleFound(env, cur, old, hit, now, fetchImpl); return; }
    if (String(hit.id) !== String(cur.zeffy_id)) await extraFound(env, cur, old, hit, now, fetchImpl, { clear: {} });
    done.add(old.at);
  }
  if (!done.size) return;
  // Against the list as it is now: a send a person's Send moved here meanwhile stays
  const cur = await getRow(env.DB, row.id);
  if (!cur) return;
  const left = jsonOf(cur.earlier, []).filter((x) => !done.has(x.at));
  await env.DB.prepare('UPDATE check_gifts SET earlier = ? WHERE id = ? AND earlier IS ?').bind(left.length ? JSON.stringify(left) : null, row.id, cur.earlier ?? null).run();
}

/** Files attached in Mercury since a send went out (its payload says which were there), read since or not */
function filesSince(row, sent) {
  const l = jsonOf(row?.letter);
  const had = Array.isArray(sent?.files) ? new Set(sent.files) : null;
  return (l?.files || []).filter((f) => (had ? !had.has(f) : (l.pending || []).includes(f)));
}

/** Those files weren't in the record: a check in Zeffy with files added after shows the to-do, and Slack hears once */
async function markLate(env, row, files, now) {
  if (!files.length) return;
  const fresh = await getRow(env.DB, row.id);
  const l = jsonOf(fresh?.letter, {});
  await setRow(env.DB, row.id, { letter: JSON.stringify({ ...l, late: [...new Set([...(l.late || []), ...files])] }) }, now, 'created');
  await tell(env, fresh || row, 'letter-late', { title: `A letter was added to a check already in Zeffy: ${money(row.cents)}`, lead: 'A file was added in Mercury after this check went into Zeffy. The site doesn’t change a saved record by itself.', fix: 'Look at it in Mercury, and fix the record in Zeffy if it says something else. Then press “Looked at it” on Checks.' });
}

/**
 * The record a send with no clear answer saved, turning up after the check was decided another way (left out, matched to
 * another entry, sent again): it's a second record for the check. Named on the check as a to-do, and in Slack, until it's
 * deleted in Zeffy (the hourly look clears it then)
 */
async function extraFound(env, row, sent, hit, now, fetchImpl, { clear = { payload: null } } = {}) {
  const extras = [...new Set([...extrasOf(row), String(hit.id)])];
  if (!(await setRow(env.DB, row.id, { extra: extras.join(','), ...clear }, now, row.state))) return false;
  await newContactTagOff(env, sent, hit, now, fetchImpl);
  const out = row.state === 'left-out';
  await tell(env, { ...row, alerted: (row.alerted || '').split(',').filter((k) => k !== 'extra').join(',') }, 'extra', {
    title: out ? `A check marked not for Zeffy has a record in Zeffy: ${money(row.cents)}` : `A check has a second record in Zeffy: ${money(row.cents)}`,
    lead: `Zeffy saved a send of this check that it hadn’t answered, after the check was ${out ? 'marked not for Zeffy' : 'matched to another record'}.`,
    fix: 'Delete that record in Zeffy (Checks names it). The site sees it’s gone within the hour.',
  });
  return true;
}

/** The record an unanswered send saved, found: it's this check's, and a person's send is still theirs */
async function settleFound(env, row, sent, hit, now, fetchImpl, { send = undefined } = {}) {
  // Mercury may have corrected the check's amount while the send waited: the record then says what Zeffy has, to fix
  const off = Number(hit.amount) !== Number(row.cents) ? 'amount-off' : null;
  // (the name it went in as, not the card's since: a letter read while it waited may have named someone else)
  const as = clean(sent?.name) || jsonOf(row.send)?.for || row.payer;
  const others = outstanding(row).filter((x) => x.at !== sent?.at);
  if (!(await setRow(env.DB, row.id, { state: 'created', via: sent?.by ? 'person' : 'site', ...(sent?.by ? { by: sent.by } : {}), zeffy_id: String(hit.id), reason: off, payload: null, earlier: others.length ? JSON.stringify(others) : null, address_done: null, address_at: null, form_id: String(hit.campaign_id || sent?.campaign_id || row.form_id || ''), payer: as || null, ...(send ? { send: JSON.stringify(send) } : {}) }, now, row.state))) return false;
  await newContactTagOff(env, sent, hit, now, fetchImpl);
  await markLate(env, row, filesSince(row, sent), now);
  // The contact it's on is theirs only by Zeffy's own name for it (a hand entry typed with an advisor's email sits on hers)
  let contactId = sent?.join || null;
  if (!contactId && hit.contact && namesOn(hit).some((n) => sameGiver(as, n))) {
    const c = await zeffyGet(env, `/contacts/${encodeURIComponent(hit.contact)}`, {}, fetchImpl).catch(() => null);
    if (c && sameGiver(as, givenName({ first_name: c.first_name, last_name: c.last_name }))) contactId = String(hit.contact);
  }
  await teach(env.DB, as, { contactId, campaignId: hit.campaign_id || null, by: 'site' }, now);
  await handlePayment(env, hit, { via: 'check', now }).catch(() => null);
  await allClear(env, row, 'Saved in Zeffy.');
  return true;
}

/**
 * A POST with no answer, or a run cut off mid-POST: if it's in Zeffy it's claimed, and if it never shows, a person looks.
 * Never sent again. A check that came back while its send was unanswered is looked for too: its record, if Zeffy saved one,
 * is money that never came, and the page says to cancel it
 */
async function settleUnsure(env, { now, fetchImpl }) {
  const stale = new Date(now - CLAIM_MS).toISOString();
  // (by when it was sent: a pending check is looked at in Mercury every run, which keeps its updated_at fresh)
  // A check waiting on Zeffy's answer first; the rest (decided, a send still looked for) take turns: each is put at the
  // back of the line once looked at, so a week of them never holds a new one up
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state = 'unsure' OR (state = 'creating' AND COALESCE(try_at, updated_at) < ?)
    OR ((payload IS NOT NULL OR earlier IS NOT NULL) AND state IN ('person', 'came-back', 'left-out', 'linked', 'created'))
    ORDER BY CASE WHEN state IN ('unsure', 'creating') THEN 0 ELSE 1 END, COALESCE(try_at, updated_at) LIMIT 4`).bind(stale).all()).results || [];
  for (const first of rows) {
    if (!['unsure', 'creating'].includes(first.state)) await env.DB.prepare('UPDATE check_gifts SET try_at = ? WHERE id = ? AND state = ?').bind(new Date(now).toISOString(), first.id, first.state).run();
    await lookForEarlier(env, first, { now, fetchImpl });
    const row = await getRow(env.DB, first.id);
    if (!row || !row.payload) continue;
    // A Send a person pressed since this run read the row is still out: it settles itself (createRecord), and only a claim
    // older than a try can be is this run's to look for
    if (row.state === 'creating' && Date.parse(row.try_at || row.updated_at) > Date.parse(stale)) continue;
    // A week of looking, after which a send Zeffy never showed is given up on (the weekly money check still names any
    // record no check in Mercury has)
    const sentAt = Date.parse(jsonOf(row.payload)?.at || row.try_at || '');
    if (!['unsure', 'creating'].includes(row.state) && Number.isFinite(sentAt) && now - sentAt > SENT_LOOK_MS) {
      await setRow(env.DB, row.id, { payload: null }, now, row.state);
      continue;
    }
    const sent = jsonOf(row.payload);
    let hit;
    try {
      hit = sent ? await findSent(env, row, sent, fetchImpl) : null;
    } catch {
      continue; // Zeffy didn't answer: the next run looks again, and the rest of this run goes on
    }
    const waited = now - Date.parse(row.try_at || row.updated_at) > UNSURE_AFTER_MS;
    if (row.state === 'came-back') {
      if (hit && !row.zeffy_id && await setRow(env.DB, row.id, { zeffy_id: String(hit.id), via: sent?.by ? 'person' : 'site', ...(sent?.by ? { by: sent.by } : {}), payload: null }, now, 'came-back')) {
        await newContactTagOff(env, sent, hit, now, fetchImpl);
        await tell(env, row, 'back-saved', { title: `A check that came back is in Zeffy: ${money(row.cents)}`, lead: 'Zeffy saved the record the site sent for it, after the check came back.', fix: 'Cancel the record in Zeffy: no money came in for it.' });
      } else if (hit && String(hit.id) !== String(row.zeffy_id)) await extraFound(env, row, sent, hit, now, fetchImpl);
    } else if (['left-out', 'linked', 'created'].includes(row.state)) {
      // Decided another way meanwhile: what turns up is a second record
      if (hit && String(hit.id) !== String(row.zeffy_id)) await extraFound(env, row, sent, hit, now, fetchImpl);
    } else if (row.state === 'person') {
      // Back on its card: found, it's the check's record (prepareCard looks too, hourly)
      if (hit) await settleFound(env, row, sent, hit, now, fetchImpl);
    } else if (hit) {
      await settleFound(env, row, sent, hit, now, fetchImpl);
    } else if (waited) {
      if (await toPerson(env, row, 'unsure', { now })) await prepareCard(env, row, { now, fetchImpl }).catch(() => null);
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
  // A card waiting on a person, however long since its check posted: the team may attach its letter any time before it's sent
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE (final = 0 AND (status != 'sent' OR looked_at IS NULL OR looked_at < ?)) OR (state IN ('read', 'person') AND (looked_at IS NULL OR looked_at < ?)) ORDER BY looked_at LIMIT 10`)
    .bind(day, new Date(now - WAITING_REREAD_MS).toISOString()).all()).results || [];
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
        fix: row.zeffy_id ? 'Cancel the record in Zeffy: no money came in for it.' : row.payload ? 'The site is looking in Zeffy for the record it sent for it. If Zeffy saved it, Checks says to cancel it.' : 'Nothing to do in Zeffy.' }
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
export async function readCheck(env, row, { now, fetchImpl }) {
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
    // A card all the same, with the name left for the person (prepareCard notes it can't be read)
    return (await setRow(env.DB, row.id, { state: 'read', reason: why, try_at: null }, now, 'new')) ? { result: 'read', why } : { result: 'moved' };
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


async function linkTo(env, row, p, { by = null, now, fetchImpl = fetch, send = null, nameBy = undefined }) {
  const iso = new Date(now).toISOString();
  // The same check deposited again after it came back takes over its record (one record, one good deposit)
  const bounced = await env.DB.prepare("SELECT * FROM check_gifts WHERE zeffy_id = ? AND state = 'came-back' AND id != ?").bind(String(p.id), row.id).first();
  if (bounced) await env.DB.prepare('UPDATE check_gifts SET zeffy_id = NULL, updated_at = ? WHERE id = ?').bind(iso, bounced.id).run();
  const giveBack = async () => { if (bounced) await env.DB.prepare('UPDATE check_gifts SET zeffy_id = ? WHERE id = ? AND zeffy_id IS NULL').bind(String(p.id), bounced.id).run().catch(() => null); };
  // The entry teaches the name it's under: one found under the check writer's name (a letter naming someone else) is theirs.
  // Never a name copied from the entry onto a check that had none: that name was the entry's, and teaches nothing
  const learner = !namesOn(p).some((n) => sameGiver(row.payer, n)) && row.drawer && namesOn(p).some((n) => sameGiver(row.drawer, n)) ? row.drawer : row.payer;
  try {
    const fields = {
      state: 'linked', via: by ? 'person' : 'hand', zeffy_id: String(p.id), note: `entry:${JSON.stringify(entriesToShow([p])[0])}`, by,
      // What this match teaches is noted once taught, so taking it off undoes that and only that; whose record it took
      // (the same check that came back) is noted at once, so a run cut off after this still gives it back
      taught: bounced ? JSON.stringify({ name: '', before: null, after: null, tookFrom: bounced.id }) : '',
      // What a person chose to put on the donor goes with the send they chose it on (a Send that found its entry typed
      // by hand), never with a later match to some other record
      send: send ? JSON.stringify(send) : null,
      ...(nameBy !== undefined ? { name_by: nameBy } : {}),
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
  let theirs = false;
  const c = p.contact ? await zeffyGet(env, `/contacts/${encodeURIComponent(p.contact)}`, {}, fetchImpl).catch(() => null) : null;
  if (c && sameGiver(learner, givenName(p.buyer))) theirs = sameGiver(learner, givenName({ first_name: c.first_name, last_name: c.last_name }));
  // A record Zeffy filed under a contact it made from the site's no-mail address (a send it answered badly): it comes off
  if (isTag(c?.email)) await strayTagOff(env, p.contact, c.email, fetchImpl, now).catch(() => false);
  const learnedRow = (key) => (key ? env.DB.prepare('SELECT name, contact_id, campaign_id, by, updated_at FROM check_payers WHERE key = ?').bind(key).first() : null);
  const key = payerKey(learner);
  const before = await learnedRow(key);
  await teach(env.DB, learner, { contactId: theirs ? p.contact || null : null, campaignId: p.campaign_id || null, by: by || 'hand entry' }, now);
  const after = await learnedRow(key);
  if (key || bounced) await env.DB.prepare("UPDATE check_gifts SET taught = ? WHERE id = ? AND state = 'linked'").bind(JSON.stringify({ name: key ? learner : '', before: before || null, after: after || null, tookFrom: bounced?.id || null }), row.id).run();
  await allClear(env, row, 'Matched to its Zeffy record.');
  return true;
}

// ─── The card a person approves ─────────────────────────────────────

// (a ZIP+4 is nine digits in a row, which is what a bank number looks like: the first five only, as everywhere the site keeps one)
const zipOf = (z) => { const t = clean(z); return (t.match(/^\d{5}/) || [])[0] || (hasAccountDigits(t) ? '' : t.slice(0, 10)); };
const buyerAddress = (a) => (a?.line1 ? { line1: clean(a.line1), city: clean(a.city), state: clean(a.state), postal_code: zipOf(a.postal_code), country: clean(a.country) || 'US' } : null);

/**
 * The Zeffy donors who could be this giver, from Zeffy's payments: under one of the check's or the letter's names (sameGiver),
 * the donor this payer was learned as, or the letter's email. Each with what tells them apart: their email, how many gifts,
 * the last one, and the address Zeffy has. Surest and newest first
 */
export function donorsFor(payments, names, { learned = null, email = '' } = {}) {
  const by = new Map();
  const wanted = names.filter(Boolean);
  for (const p of payments || []) {
    if (!p?.contact || isTestRecord(p) || /fail|cancel/.test(String(p.status || '').toLowerCase())) continue;
    const on = namesOn(p);
    const learnedOne = !!learned?.contact_id && String(p.contact) === String(learned.contact_id);
    const mail = clean(p.buyer?.email).toLowerCase();
    if (!learnedOne && !(email && mail === email) && !on.some((n) => wanted.some((g) => sameGiver(g, n)))) continue;
    const id = String(p.contact);
    const d = by.get(id) || { id, name: '', email: '', gifts: 0, last: 0, address: null, sure: false, mailAt: 0, addressAt: 0 };
    const at = Number(p.created) || 0;
    d.gifts += 1;
    if (at >= d.last) { d.last = at; d.name = givenName(p.buyer) || on[0] || d.name; }
    if (mail && !isTag(mail) && at >= d.mailAt) { d.email = mail; d.mailAt = at; }
    const a = buyerAddress(p.buyer?.address);
    if (a && at >= d.addressAt) { d.address = a; d.addressAt = at; }
    d.sure ||= learnedOne || on.some((n) => wanted.some((g) => surelySameGiver(g, n)));
    by.set(id, d);
  }
  return [...by.values()].sort((a, b) => Number(b.sure) - Number(a.sure) || b.last - a.last).slice(0, 8)
    .map(({ mailAt, addressAt, ...d }) => d);
}

/**
 * Each possible donor as Zeffy's own contact has them: its names, email, address and gifts, never a payment's typed names. A
 * fund's grant typed under the fund's name with its advisor's email sits on the advisor's contact; that contact is no donor
 * for the fund's next check, whoever recommended it. Kept: a contact under one of the giver's names, the donor this payer
 * was learned as, or the one holding the letter's email. Zeffy not answering about one: kept as found, never picked by itself
 */
async function confirmDonors(env, found, names, { learned = null, learnedName = '', email = '', fetchImpl }) {
  const out = [];
  for (const d of found.slice(0, 6)) {
    let c;
    try {
      c = await zeffyGet(env, `/contacts/${encodeURIComponent(d.id)}`, {}, fetchImpl);
    } catch (e) {
      if (e.status === 404) continue;
      // Unread just now: kept to pick, unsure, and tied only to the name it was learned as. The names on its payments are
      // no proof (a fund's grant typed with its advisor's email sits on her contact), so Send reads the contact itself
      const learnedOne = !!learned?.contact_id && String(learned.contact_id) === d.id;
      out.push({ ...d, sure: false, for: learnedOne && learnedName ? [learnedName] : [], sureFor: [], ...(learnedOne ? { learned: true } : {}) });
      continue;
    }
    const own = givenName({ first_name: c?.first_name, last_name: c?.last_name });
    const mail = clean(c?.email).toLowerCase();
    const learnedOne = !!learned?.contact_id && String(learned.contact_id) === d.id;
    const byEmail = !!email && mail === email;
    if (!learnedOne && !byEmail && !names.some((g) => sameGiver(g, own))) continue;
    // Which of the card's names this donor is: by their own name in Zeffy, or the name they were learned as. One that only
    // holds the letter's email is listed, tied to nobody (a foundation's letter can give a staff member's own email). The
    // page keeps who it's from and the donor agreeing by it, and Send checks it
    const tied = [learnedOne && learnedName].filter(Boolean);
    out.push({
      id: d.id, name: own || d.name, email: mail && !isTag(mail) ? mail : '', gifts: Number(c?.donation_count) || d.gifts, last: Number(c?.last_donation_date) || d.last,
      address: buyerAddress(c?.address) || d.address, sure: learnedOne || names.some((g) => surelySameGiver(g, own)),
      for: [...new Set([...names.filter((g) => sameGiver(g, own)), ...tied])],
      sureFor: [...new Set([...names.filter((g) => surelySameGiver(g, own)), ...tied])],
      ...(learnedOne ? { learned: true } : {}),
    });
  }
  return out;
}

/**
 * The donor a card starts on, among the donors for the name it goes under (a fund's contact is never where its donor's gift
 * starts): the one this payer was learned as, else the only sure one, else New when Zeffy has none for them, else nobody
 * (the person picks). The page's donorFor is the same rule, for a name picked there
 */
export function pickDonor(donors, learned = null, name = '') {
  const theirs = name ? donors.filter((d) => (d.for || []).some((n) => sameName(n, name))) : donors;
  const learnedOne = learned?.contact_id && theirs.find((d) => d.id === String(learned.contact_id));
  if (learnedOne) return learnedOne.id;
  const sure = theirs.filter((d) => (name ? (d.sureFor || []).some((n) => sameName(n, name)) : d.sure));
  if (sure.length === 1) return sure[0].id;
  return theirs.length ? null : 'new';
}

/** The names a check could go under: each letter page's donor, then who wrote the check. One of each giver */
function namesFor(row) {
  const l = jsonOf(row.letter, {});
  const out = [];
  const add = (name, from) => { if (name && !out.some((x) => surelySameGiver(x.name, name))) out.push({ name, from }); };
  if (l.why !== 'letter-many') for (const k of l.files || []) { const r = l.reads?.[k]; if (r?.about && r.name) add(r.name, 'letter'); }
  add(checkName(row), 'check');
  return out;
}

/** What a card shows, without the time it was made: two cards that say the same thing are the same card */
const cardKey = (c) => JSON.stringify([c?.names, c?.formFor, c?.name, (c?.donors || []).map((d) => [d.id, d.name, d.email, d.gifts, d.last, addressKey(d.address), d.for, d.sureFor, !!d.learned]), c?.donor, c?.formId, c?.day, c?.email, c?.letterAddress, c?.letterAddressFor, c?.checkAddress, c?.checkAddressFor, c?.notes, c?.entries, c?.category, c?.suggest, c?.dontReason, c?.sent]);

/**
 * Entries more than one check still waiting could be: staff catching up a giver's months on one day type entries each of
 * those checks fits, under the giver's name, and none of them takes one by itself. Counted over every check not sent yet
 */
async function contestedOf(env, payments, claimed) {
  const waiting = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state IN ('read', 'person') AND status IN ('pending', 'sent') ORDER BY deposited_at DESC LIMIT 200`).all()).results || [];
  const wanted = new Map();
  for (const row of waiting) {
    const m = matchBoth(row, payments, claimedFor(row, claimed), row.payer ? await learnedFor(env.DB, row.payer) : null, row.drawer ? await learnedFor(env.DB, row.drawer) : null);
    const theirs = (p) => namesOn(p).some((n) => (row.payer && sameGiver(row.payer, n)) || (row.drawer && sameGiver(row.drawer, n)));
    for (const p of [...m.same, ...m.maybe.filter(theirs)]) wanted.set(String(p.id), (wanted.get(String(p.id)) || 0) + 1);
  }
  return new Set([...wanted].filter(([, n]) => n > 1).map(([id]) => id));
}

/** Zeffy as one card needs it: 400 days of payments and open pledges, the open forms, and which entries other checks hold */
async function readsFor(env, row, now, fetchImpl) {
  const [w, forms, claimed] = await Promise.all([readWide(env, secondsOf(earliestDay(row)) - LOOK_BACK_S, now, fetchImpl), openForms(env, fetchImpl), claimedIds(env.DB)]);
  return { payments: w.payments, whole: w.whole, forms, claimed, contested: await contestedOf(env, w.payments, claimed) };
}

/**
 * Fills in a check's card for a person to approve (state 'read' → 'person'), or matches it to a hand entry that surely is it.
 * Run when a check is read, when a file's reading changes, and every hour while it waits (with `shared`, Zeffy read once for
 * every waiting check). A refresh that changes nothing writes nothing, so a person's open card never goes stale for nothing.
 * Nothing here writes to Zeffy
 */
export async function prepareCard(env, seen, { now, fetchImpl = fetch, shared = null } = {}) {
  const row = (await getRow(env.DB, seen.id)) || seen;
  if (!['read', 'person'].includes(row.state)) return { result: 'moved' };
  // A file added or changed in Mercury is read before the card is made: the card is made again once it is
  if (!shared) {
    const txn = await getTransaction(env, row.id, { fetchImpl }).catch(() => null);
    if (txn && await noteLetters(env, row, txn, now)) return { result: 'letter' };
    if (txn && await verifyLetters(env, row, txn, now, fetchImpl)) return { result: 'letter' };
  }
  if (lettersWaiting(row)) return { result: 'letter' };
  const before = jsonOf(row.payload);
  if (before) {
    let hit = null;
    try { hit = await findSent(env, row, before, fetchImpl); } catch { return { result: 'later' }; }
    if (hit) return (await settleFound(env, row, before, hit, now, fetchImpl)) ? { result: 'created' } : { result: 'moved' };
  }
  const category = await categoryOf(env, row);
  const said = letterSays(row);
  const own = checkName(row);
  const names = namesFor(row);
  // The letter is the source of truth for whose gift it is; a name a person gave stands; pages that disagree leave it to the person
  const name = (row.name_by && row.payer) || (said.why ? (names.length === 1 ? names[0].name : '') : said.name || own) || '';
  const work = { ...row, payer: name || null, drawer: own || null, category };
  const z = shared || await readsFor(env, work, now, fetchImpl);
  const [learned, drawerLearned, vendor] = await Promise.all([name ? learnedFor(env.DB, name) : null, own ? learnedFor(env.DB, own) : null, name ? isVendor(env.DB, name) : false]);
  const twin = await twinOf(env, row, [own, name], { now });
  const net = netBoth(work, z.payments, z.claimed, { learned, drawerLearned, ...(await freshFor(env, work)) });
  const n = notesFor(work, { payments: z.payments, claimed: z.claimed, forms: z.forms, learned, drawerLearned, isVendor: vendor, whole: z.whole, contested: z.contested, twin, net, category });
  // Typed into Zeffy by hand already: matched, nothing to send. Only while Mercury has the money
  if (n.link && ['pending', 'sent'].includes(row.status)) {
    return (await linkTo(env, work, n.link, { now, fetchImpl })) ? { result: 'linked' } : { result: 'moved' };
  }
  const sticky = STICKY.includes(row.reason) ? [row.reason] : [];
  const buckets = await readSpendConfig(env.DB).then((cfg) => cfg?.accountBuckets || {}, () => ({}));
  if (buckets[row.account_id] === 'store') sticky.push('store-account');
  // Zeffy's own reason for refusing the last send, kept with the card (the row's note becomes the entries to show)
  const words = (n) => (typeof n === 'string' && n && !n.startsWith('[') && !n.startsWith('entry:') ? n : null);
  const refusal = row.reason === 'zeffy-refused' ? words(row.note) || jsonOf(row.card, {}).refusal || null : null;
  if (['no-picture', 'unreadable'].includes(row.reason)) sticky.push(row.reason);
  const lettered = said.why ? [said.why] : [];
  const notes = [...new Set([...sticky, ...lettered, ...n.notes])];
  const giverNames = [...names.map((x) => x.name), name].filter(Boolean);
  const found = donorsFor(z.payments, giverNames, { learned, email: said.email || '' });
  // The donor this payer was learned as, gone quiet for 400 days, is still a candidate
  if (learned?.contact_id && !found.some((d) => d.id === String(learned.contact_id))) found.unshift({ id: String(learned.contact_id), name: '', email: '', gifts: 0, last: 0, address: null, sure: true });
  const looked = await confirmDonors(env, found, giverNames, { learned, learnedName: name, email: said.email || '', fetchImpl });
  // Donors a person's Send turned up (Zeffy's donor under a name they typed, the one holding an email they typed) stay on
  // the card when it's made again: they were shown, and may be picked. A deleted one comes off when Send finds it gone
  const shown = (jsonOf(row.card, {}).donors || []).filter((d) => d.added && !looked.some((x) => x.id === d.id));
  const donors = [...looked, ...shown];
  // What a person chose on the send before this card (one Zeffy never answered, then nowhere to be found), for this giver:
  // the card starts on it, as they left it
  const last = sentPlan(row);
  const sent = last && name && sameGiver(last.name, name) ? last : null;
  // The form the site's rule gives for each name on the card, so picking the other name never drops a form the memo or a
  // giver's past gifts decided; the one the person sent last stands for that name
  const formFor = {};
  for (const x of names) {
    const f = pickForm({ ...work, payer: x.name }, z.forms || [], x.name === name ? learned : await learnedFor(env.DB, x.name));
    formFor[x.name] = sent && sameGiver(sent.name, x.name) && (z.forms || []).some((g) => g.id === sent.formId) ? sent.formId : f?.id || null;
  }
  const card = {
    names, name, donors, formFor,
    donor: sent && (sent.donor === 'new' || donors.some((d) => d.id === sent.donor)) ? sent.donor : pickDonor(donors, learned, name),
    formId: (sent?.formId && (z.forms || []).some((f) => f.id === sent.formId) && sent.formId) || n.form?.id || null, day: sent?.day || recordDay(row),
    // The letter's email is its giver's (the check writer's when it names nobody); one the person gave on that send is theirs
    email: sent ? sent.email : said.email || '',
    emailFor: sent ? (sent.email ? sent.name : '') : said.email ? said.name || own || name || '' : '',
    // Each address is someone's: the letter's is its giver's (the check writer's when it names nobody), the check's its writer's
    letterAddress: said.address || null, letterAddressFor: said.address ? said.name || own || '' : '',
    checkAddress: jsonOf(row.address), checkAddressFor: jsonOf(row.address) ? jsonOf(row.address)?.for || own || '' : '',
    notes, entries: entriesToShow(n.entries), category: category || null,
    suggest: n.suggest, dontReason: n.dontReason,
    // (and the address that send chose, which the page picks among the card's addresses or types in)
    sent,
    refusal,
  };
  const fresh = row.state === 'read';
  // Said in Slack once a card, when it's made: one Slack didn't take is said the next time the card is looked at (tell keeps
  // what's said). A check put on a person for another reason (a record gone in Zeffy) was told about then, so it isn't again
  const ready = async () => {
    if (!fresh && row.alerted) return;
    await tell(env, { ...row, payer: name || row.payer }, 'ready', {
      title: `A check is ready to send to Zeffy: ${money(row.cents)}`,
      lead: notes.length ? `${name ? `From ${name}. ` : ''}${REASONS[notes[0]] || ''}` : `From ${name}. Everything is filled in.`,
      fix: 'Look it over on Checks, then send it to Zeffy, or say it isn’t for Zeffy.',
    });
  };
  if (!fresh && row.card && cardKey(jsonOf(row.card)) === cardKey(card)) { await ready(); return { result: 'same' }; }
  const fields = {
    state: 'person', reason: notes[0] || 'ready', note: card.entries.length ? JSON.stringify(card.entries) : null, card: JSON.stringify({ ...card, at: new Date(now).toISOString() }),
    payer: name || null, drawer: own || null, form_id: n.form?.id || null, form_title: n.form?.title || null, try_at: null,
  };
  if (!(await setRow(env.DB, row.id, fields, now, row.state))) return { result: 'moved' };
  await ready();
  return { result: 'card', reason: fields.reason };
}

/** The choices of a person's send this check is waiting after, for its card */
function sentPlan(row) {
  const p = jsonOf(row.send);
  return p ? { name: p.for || '', donor: p.donor || 'new', formId: p.formId || null, email: p.email || '', address: p.address || null, day: isDay(p.day) ? p.day : null } : null;
}

/**
 * The same check deposited before: its number and amount within 180 days, from the same giver. Check numbers are each
 * checkbook's own, so another giver's #1042 for the same amount is another check. A check with no name either side can't
 * say, so it counts. saved: only one with its Zeffy record
 */
async function twinOf(env, row, names, { now, saved = false }) {
  if (!row.check_number) return null;
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE id != ? AND cents = ? AND check_number = ? AND deposited_at >= ?${saved ? ' AND zeffy_id IS NOT NULL' : ''} ORDER BY deposited_at DESC LIMIT 10`)
    .bind(row.id, row.cents, row.check_number, new Date(now - 180 * DAY).toISOString()).all()).results || [];
  const mine = names.filter(Boolean);
  return rows.find((t) => {
    const theirs = [t.drawer, t.payer].filter(Boolean);
    return !mine.length || !theirs.length || theirs.some((a) => mine.some((b) => sameGiver(a, b)));
  }) || null;
}

/** One record against Zeffy now: what it asked staff to fix clears itself once it's fixed, and a record that's gone says so. It's never made again by itself */
async function lookAtRecord(env, row, known, { now, fetchImpl, payments = [], claimed = new Set() }) {
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
    await toPerson(env, { ...row, alerted: null }, 'record-gone', { now });
    await setRow(env.DB, row.id, { zeffy_id: null, via: null, rejected }, now);
    return true;
  }
  if (row.state === 'came-back' || !['amount-off', 'still-unpaid'].includes(row.reason)) return false;
  const reason = Number(p.amount) !== Number(row.cents) ? 'amount-off' : String(p.status || '').toLowerCase() === 'succeeded' ? null : 'still-unpaid';
  if (reason !== row.reason) await setRow(env.DB, row.id, { reason, note: `entry:${JSON.stringify(entriesToShow([p])[0])}` }, now, row.state);
  return false;
}

/**
 * Once an hour: every card waiting on a person is made again against what Zeffy holds now (a hand entry typed since matches
 * it; an entry under another name joins its list); a record kept for a check is looked at (fixed, marked paid, deleted); a
 * record a person sent that someone then typed too is flagged; money that went back out for a check is flagged; and a
 * card that has waited 10 days is said out loud once
 */
async function matchOpen(env, { now, fetchImpl }) {
  // A check that came back can show as new money going out rather than a change to the deposit
  const held = (await env.DB.prepare(`SELECT c.* FROM check_gifts c WHERE c.zeffy_id IS NOT NULL AND c.final = 0 AND EXISTS (
    SELECT 1 FROM mercury_txns t WHERE t.cents = -c.cents AND t.created_at > c.deposited_at AND t.card_id IS NULL AND t.kind IN ('other', 'checkDeposit')) LIMIT 10`).all()).results || [];
  for (const row of held) await tell(env, row, 'money-out', { title: `A check may have come back: ${money(row.cents)}`, lead: 'The same amount went back out of Mercury after this check. It may have been returned.', fix: 'Check it in Mercury. If it came back, cancel the record in Zeffy.' });

  // Newest first, so a pile of old ones never holds up this week's, and the read of Zeffy never runs past what it can read whole
  const since = new Date(now - MATCH_MAX_AGE_MS).toISOString();
  const waiting = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state = 'person' AND status IN ('pending', 'sent') AND deposited_at >= ? ORDER BY deposited_at DESC LIMIT 100`).bind(since).all()).results || [];
  const sent = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state = 'created' AND final = 0 AND deposited_at >= ? ORDER BY deposited_at DESC LIMIT 100`).bind(since).all()).results || [];
  // A record in Zeffy can change after it's matched: fixed, marked paid, moved or deleted
  const kept = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE zeffy_id IS NOT NULL AND (final = 0 OR state = 'came-back') AND deposited_at >= ? ORDER BY deposited_at DESC LIMIT 100`).bind(since).all()).results || [];
  // Not even read 10 days after it posted: said once, so a stuck check is never silent
  const stuck = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE state IN ('new', 'read') AND status = 'sent' AND posted_at < ? AND deposited_at >= ? LIMIT 20`)
    .bind(new Date(now - NO_RECORD_ALARM_MS).toISOString(), since).all()).results || [];
  for (const row of stuck) await tell(env, row, 'stuck', { title: `A check isn’t ready to send: ${money(row.cents)}`, lead: 'This check posted more than 10 days ago and the site still hasn’t made its card. Zeffy or Mercury may not be answering.', fix: 'Enter it in Zeffy by hand, and it links itself within the hour.' });
  // The whole 400 days every hour, checks open or not: the site's record of when each payment showed up stays current, so
  // the wide look can tell an entry typed this week from one typed long ago
  const recent = await paymentsSince(env, Math.floor(now / 1000) - NET_S, fetchImpl);
  await noteSeen(env, recent, now);
  const recentIds = new Set(recent.map((p) => String(p.id)));
  const payments = [...recent, ...(await openPledges(env, fetchImpl).catch(() => [])).filter((p) => !recentIds.has(String(p.id)))];
  // A record named on a check to delete in Zeffy: gone (deleted or cancelled), the to-do goes. Each read by itself, so
  // this runs whatever else the hour has to look at
  const extras = (await env.DB.prepare('SELECT * FROM check_gifts WHERE extra IS NOT NULL LIMIT 50').all()).results || [];
  for (const row of extras) {
    const left = [];
    let unsure = false;
    for (const id of extrasOf(row)) {
      let p = null;
      try { p = await zeffyGet(env, `/payments/${encodeURIComponent(id)}`, {}, fetchImpl); } catch (e) { if (e.status !== 404) { unsure = true; left.push(id); continue; } }
      if (p && !/cancel/.test(String(p.status || '').toLowerCase())) left.push(id);
    }
    if (left.length === extrasOf(row).length) continue;
    await env.DB.prepare('UPDATE check_gifts SET extra = ?, updated_at = ? WHERE id = ? AND extra = ?').bind(left.length ? left.join(',') : null, new Date(now).toISOString(), row.id, row.extra).run();
    if (!left.length && !unsure) await allClear(env, row, 'That record is gone from Zeffy.');
  }
  if (!waiting.length && !kept.length && !sent.length) return;
  const claimed = await claimedIds(env.DB);
  const byId = new Map(payments.map((p) => [String(p.id), p]));
  // A check changed here is looked at again next hour, not from what it was a moment ago
  const changed = new Set();
  for (const row of kept) if (await lookAtRecord(env, row, byId.get(String(row.zeffy_id)) || null, { now, fetchImpl, payments, claimed })) changed.add(row.id);

  // Staff catching up a giver's months on one day: an entry that fits more than one waiting check never matches by itself
  const contested = await contestedOf(env, payments, claimed);
  const forms = waiting.length ? await openForms(env, fetchImpl) : [];
  const shared = { payments, whole: true, forms, claimed, contested };
  for (const row of waiting) {
    if (changed.has(row.id)) continue;
    const r = await prepareCard(env, row, { now, fetchImpl, shared });
    if (r.result === 'linked') { const got = await getRow(env.DB, row.id); if (got?.zeffy_id) claimed.add(String(got.zeffy_id)); continue; }
    // Waiting 10 days after Mercury posted it: said once more, plainly
    if (row.status === 'sent' && now - Date.parse(row.posted_at || row.deposited_at) > NO_RECORD_ALARM_MS) {
      await tell(env, row, 'no-record', { title: `A check is still waiting to be sent to Zeffy: ${money(row.cents)}`, lead: 'This check posted more than 10 days ago and its card is still waiting on a person.', fix: 'Open Checks: send it to Zeffy, match it to an entry, or say it isn’t for Zeffy.' });
    }
  }
  for (const row of sent) {
    if (changed.has(row.id)) continue;
    // Typed by hand as well, under the check's name or another (a fund's check is often typed under its advisor's); or a
    // pledge or donor-advised gift marked paid since it was sent, which this check may have paid
    const m = matchBoth(row, payments, claimedFor(row, claimed), row.payer ? await learnedFor(env.DB, row.payer) : null, row.drawer ? await learnedFor(env.DB, row.drawer) : null);
    const turned = await freshSince(env.DB, Math.floor(Date.parse(row.posted_at || row.deposited_at) / 1000) - 86400);
    const open = await openAmounts(env.DB, row.id, now);
    const typed = [...new Map([...m.same, ...m.maybe, ...m.other, ...netBoth(row, payments, claimedFor(row, claimed), { turnedPaid: turned })].map((p) => [String(p.id), p])).values()]
      .filter((p) => String(p.status || '').toLowerCase() === 'succeeded' && (paidByCheck(p) || byDaf(p)) && (madeByHand(p) || turned.has(String(p.id))) && !open.has(Number(p.amount)));
    if (typed.length) await tell(env, row, 'double', { title: `This check may be in Zeffy twice: ${money(row.cents)}`, lead: m.same.length ? 'It was sent to Zeffy from Checks, and someone entered it by hand too.' : `It was sent to Zeffy from Checks, and Zeffy has ${byDaf(typed[0]) ? 'a donor-advised gift marked paid' : 'a hand entry'} for the same amount${namesOn(typed[0])[0] ? ` under ${namesOn(typed[0])[0]}` : ''}. It may be the same gift.`, fix: 'If it is, delete the extra one in Zeffy. If that record has an email on it, Zeffy may tell the donor, so keep the one with the email.' });
  }
}

// ─── The donor's address in Zeffy ───────────────────────────────────

/** When Zeffy first didn't answer about this address ('wait:<time>'), or null */
const waitingSince = (done) => Number(String(done || '').match(/^wait:(\d+)$/)?.[1] || 0) || null;

/**
 * The address (and a letter's email) onto the donor's Zeffy contact, once the gift's record is there: one check a run.
 * Only a contact under the giver's own name takes it. The letter's address always goes on; the check's replaces what
 * Zeffy has (the newest the donor gave us), except on a staff member's hand entry, where it only fills a blank. An email
 * only fills a blank: Zeffy keeps one a contact, and it's how Zeffy finds the donor. Nothing is sent to anyone
 */
export async function writeAddresses(env, { now, fetchImpl, cfg }) {
  if (!cfg?.writeTest?.ok || !cfg.writeTest.address?.ok) return { result: 'off' };
  const iso = new Date(now).toISOString();
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts WHERE zeffy_id IS NOT NULL AND state IN ('created', 'linked') AND (address IS NOT NULL OR letter IS NOT NULL OR send IS NOT NULL)
    AND ((address_done IS NULL OR address_done LIKE 'wait:%') AND (address_at IS NULL OR address_at < ?) OR (address_done = 'refused' AND address_at < ?)) ORDER BY address_at IS NOT NULL, address_at LIMIT 10`)
    .bind(new Date(now - ADDRESS_RETRY_MS).toISOString(), new Date(now - DAY).toISOString()).all()).results || [];
  // What a person chose when they sent it (personSend), else what the letter and the check say
  const wants = (r) => { const plan = jsonOf(r.send); if (plan) return !!(plan.address || plan.email); const l = letterSays(r); return !!(jsonOf(r.address) || l.address || l.email); };
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
  if (filing) return later();
  if (isTag(c?.email)) {
    if (!(await strayTagOff(env, p.contact, c.email, fetchImpl, now))) return later();
    c = { ...c, email: '' };
  }
  // The contact's own names: who the address goes on, said if a person has to add it by hand
  const names = [givenName({ first_name: c?.first_name, last_name: c?.last_name }), clean(`${clean(c?.first_name)} ${clean(c?.last_name)}`)].filter(Boolean);
  // What a person chose on Send goes on the donor they chose it for: the one they picked, or (a new donor) the contact under
  // the name they sent it as. A record that ended up on someone else's contact takes none of it
  const chosen = jsonOf(row.send);
  const plan = chosen && (chosen.donor ? String(p.contact) === String(chosen.donor) : names.some((n) => sameGiver(chosen.for, n))) ? chosen : null;
  let addr = null;
  let email = '';
  if (plan) {
    // A person sent it with this donor, address and email: they're the record's donor's, by that person's word
    addr = plan.address ? { ...plan.address, from: 'person' } : null;
    email = plan.email || '';
  } else {
    // A hand entry matched by itself: whose donor this is, by the contact's own name, never the record's (a fund's gift typed
    // under the fund's name can sit on its advisor's contact), and surely, not nearly (North Atlanta Rotary Club's contact never
    // takes Atlanta Rotary Club's mail). The letter's address and email are its giver's; the check's address is its writer's
    const theirs = (who) => !!who && names.some((n) => surelySameGiver(who, n));
    const said = letterSays(row);
    const own = checkName(row);
    if ((said.address || said.email) && theirs(said.name || own)) {
      addr = said.address ? { ...said.address, from: 'letter' } : null;
      email = said.email || '';
    }
    if (!addr && theirs(own) && jsonOf(row.address)) addr = { ...jsonOf(row.address), from: 'check' };
  }
  if (!addr && !email) { await settle(plan ? 'none' : 'not-theirs'); return { result: plan ? 'none' : 'not-theirs' }; }
  // Turned down before, and someone has since put an address (and an email) on the donor by hand: done, whatever they typed
  if (refused && (!addr || c?.address?.line1) && (!email || clean(c?.email))) { await settle('by-hand'); return { result: 'by-hand' }; }
  const patch = {};
  const has = c?.address?.line1 ? c.address : null;
  if (addr) {
    const same = has && addressKey(has) === addressKey(addr);
    // An entry someone typed or matched keeps the address on it: the check's only fills a blank
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
  // The contact is the site's while it writes, as it is while a Send files under them (postJoined): one waits for the other,
  // so an email going on is never written over by the no-mail address, nor the no-mail address by an email. The note's
  // address never goes on anyone; a run cut off here has it cleared by clearTags
  const lock = tagFor(`edit${row.id}`, now);
  const held = await env.DB.prepare('INSERT OR IGNORE INTO check_tags (contact, email, check_id, at) VALUES (?, ?, ?, ?)').bind(String(p.contact), lock, row.id, iso).run();
  if (!held.meta?.changes) return later();
  try {
    return await writeOn();
  } finally {
    await env.DB.prepare('DELETE FROM check_tags WHERE contact = ? AND email = ?').bind(String(p.contact), lock).run().catch(() => null);
  }
  /** The PATCH itself, and what Zeffy's answer means */
  async function writeOn() {
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
  const ctx = { now, fetchImpl, cfg };
  // The test of writing to Zeffy, before anything is sent: a failed one tries again a day later, once nothing of it is left
  // for a person to remove, three times in all; a failed address step the same
  const test = cfg.writeTest;
  const again = test && !test.leftBehind?.length && now - Date.parse(test.at || 0) > DAY
    && ((!test.ok && (Number(test.tries) || 1) < WRITE_TRIES) || (test.ok && test.address && !test.address.ok && (Number(test.address.tries) || 1) < WRITE_TRIES));
  if (test?.id !== WRITE_TEST || again) {
    const report = await testWrite(env, ctx);
    // Sending stops while Zeffy won't take a test record, and the staff hear so (and hear when it works again)
    if (!report.ok && env.SLACK_BOT_TOKEN) {
      const card = slackCard({ icon: '🧾', title: 'Checks can’t be sent to Zeffy right now', lead: 'Zeffy wouldn’t take the site’s $1 test record, so “Send to Zeffy” is off until a test works.', fix: 'Enter checks in Zeffy by hand until Checks says sending works again. Each one links itself within the hour.', buttons: [{ label: 'Open Checks', url: CARDS_URL }] });
      await slackIssue(env, 'checks:paused', card, { title: 'Checks into Zeffy', kind: 'attention' }).catch(() => null);
    }
    if (report.ok && test && !test.ok && env.SLACK_BOT_TOKEN) {
      await slackResolved(env, 'checks:paused', slackCard({ icon: '✅', title: 'Checks can be sent to Zeffy again', lead: 'Its test record saved.' }), { summary: 'Sending works again.' }).catch(() => null);
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
        await slackResolved(env, 'checks:match', slackCard({ icon: '✅', title: 'The hourly look at Zeffy works again', lead: 'Cards are up to date again.' }), { summary: 'Working again.' }).catch(() => null);
      }
    } catch (e) {
      // Without it cards go stale and doubles go unseen: three hours of it tells the staff, once
      const since = cfg.matchFailing?.since || new Date(now).toISOString();
      await writeState(env.DB, KEY, { matchFailing: { since, error: plainError(e) } });
      if (now - Date.parse(since) >= 3 * 60 * MIN && env.SLACK_BOT_TOKEN) {
        const card = slackCard({ icon: '🧾', title: 'The site can’t look at Zeffy for checks', lead: `Since ${new Date(since).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, ${plainError(e)}. Cards aren’t kept up to date until it works, and Send reads Zeffy again first anyway.`, fix: 'Nothing to do in Zeffy. If it lasts a day, tell Peter.', buttons: [{ label: 'Open Checks', url: CARDS_URL }] });
        await slackIssue(env, 'checks:match', card, { title: 'Checks into Zeffy', kind: 'attention' }).catch(() => null);
      }
    }
    if (test?.leftBehind?.length) await lookForLeftovers(env, test, fetchImpl);
    else if (test?.contactsLeft && await sweepTestContacts(env, Date.parse(test.at), fetchImpl)) await writeState(env.DB, KEY, { writeTest: { ...test, contactsLeft: false } });
  }
  // The weekly money check, Monday morning: it reads and writes nothing but its own result, so it never holds up the rest
  if (moneyDue(cfg, now)) await moneyCheck(env, ctx).catch((e) => { ctx.failed ||= e; });
  // One big job a run: a card to make, a letter to read, or a check's picture to read. Cards and letters take turns, so
  // neither holds the other up while Zeffy or the readers are slow; a card Zeffy made wait goes to the back of the line
  const turn = Math.floor(now / RUN_EVERY_MS) % 2 === 0;
  const toCard = ((await env.DB.prepare(`SELECT * FROM check_gifts WHERE state = 'read' AND status IN ('pending', 'sent') AND (try_at IS NULL OR try_at < ?) ORDER BY try_at IS NOT NULL, try_at, deposited_at LIMIT 20`)
    .bind(new Date(now - 15 * MIN).toISOString()).all()).results || []).find((r) => !lettersWaiting(r)) || null;
  const letterRow = ((await env.DB.prepare(`SELECT * FROM check_gifts WHERE letter LIKE '%"pending":["%' AND state IN ('read', 'person') ORDER BY deposited_at LIMIT 20`).all()).results || [])
    .find((r) => { const l = jsonOf(r.letter, {}); return !l.tryAt || now - Date.parse(l.tryAt) >= 15 * MIN; }) || null;
  let done = { result: 'quiet' };
  if (toCard && !(letterRow && !turn)) {
    try {
      done = await prepareCard(env, toCard, ctx);
    } catch (e) {
      await setRow(env.DB, toCard.id, { try_at: new Date(now).toISOString() }, now, toCard.state).catch(() => null);
      ctx.failed = e;
      done = { result: 'later' };
    }
    // A whole day of Zeffy not answering for this check: it goes on its card as it is, for a person to send when Zeffy's back
    const waits = { ...((await readState(env.DB, KEY)).waits || {}) };
    if (done.result === 'later') {
      waits[toCard.id] ||= new Date(now).toISOString();
      if (now - Date.parse(waits[toCard.id]) >= DAY && await toPerson(env, toCard, 'zeffy-busy', { now })) delete waits[toCard.id];
    } else delete waits[toCard.id];
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
    // Can't be read: a card all the same, with the name left to the person
    const unread = (why, note = null) => setRow(env.DB, next.id, { state: 'read', reason: why, try_at: null, ...(note ? { note } : {}) }, now, 'new');
    if (next && (next.tries || 0) >= READ_TRIES) {
      // Runs cut short never reach the limit inside a read, so it's checked before one starts
      await unread('unreadable');
      done = { result: 'read', why: 'unreadable' };
    } else if (next) {
      try {
        done = await readCheck(env, next, ctx);
        if (done.result === 'read' && cfg.readersFailing) {
          await writeState(env.DB, KEY, { readersFailing: null });
          await slackResolved(env, 'checks:readers', slackCard({ icon: '✅', title: 'The site reads checks again', lead: 'Both readers answered.' }), { summary: 'Reading again.' }).catch(() => null);
        }
      } catch (e) {
        // Mercury or the readers not answering is an outage: the try is given back and the check waits its turn, for up to 3 days.
        // A refusal (Mercury has no such check) is this check's own, and three of those make its card unread
        const outage = !e.status || e.status >= 500 || e.status === 429;
        const waited = now - Date.parse(next.created_at || next.deposited_at) >= 3 * DAY;
        if (outage && !waited) {
          await env.DB.prepare('UPDATE check_gifts SET tries = MAX(0, tries - 1) WHERE id = ? AND tries > ?').bind(next.id, next.tries || 0).run().catch(() => null);
          throw e;
        }
        if (!outage && (next.tries || 0) + 1 < READ_TRIES) throw e;
        await unread('unreadable');
        done = { result: 'read', why: 'unreadable' };
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

/** What a person answered about a check, in short: two screens that differ here aren't looking at the same check */
/**
 * A check's version as a person sees it: its state and answers, its letter, and its card as shown (names, donors, form,
 * addresses: cardKey, never when it was made). An answer given to an older version is refused, so nothing is sent on a
 * card that changed behind a question
 */
export const versionOf = (r) => {
  const l = jsonOf(r.letter, {});
  const t = [r.state, r.reason, r.zeffy_id, r.rejected, r.by, r.payer, r.name_by, r.note, l.name, l.email, addressKey(l.address), (l.late || []).join(','), l.why, r.address_done === 'refused' ? 'refused' : '', r.card ? cardKey(jsonOf(r.card, {})) : ''].map((x) => x ?? '').join('|');
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** A card note in words: a refusal says Zeffy's own reason, and a category says which */
function noteWords(kind, r) {
  if (kind === 'zeffy-refused' && typeof r.note === 'string' && r.note && !r.note.startsWith('[') && !r.note.startsWith('entry:')) return r.note;
  if (kind === 'zeffy-refused' && jsonOf(r.card, {}).refusal) return jsonOf(r.card, {}).refusal;
  if (kind === 'category' && r.category) return `Its Category in Mercury is ${r.category}, which isn’t a gift (Individual Contribution, Corporate Contribution or Grant).`;
  return REASONS[kind] || null;
}

function viewOf(r, claimed, now = Date.now()) {
  let listed = null;
  try { listed = r.note?.startsWith('[') ? JSON.parse(r.note) : null; } catch { /* words, not a list */ }
  // The Zeffy entry a to-do is about, kept when it was matched
  let entry = null;
  try { entry = r.note?.startsWith('entry:') ? JSON.parse(r.note.slice(6)) : null; } catch { /* an old row */ }
  // A second deposit of one check is asked about the first deposit's record, which that deposit of course holds
  const candidates = listed ? listed.filter((c) => r.reason === 'redeposit' || !claimed.has(String(c.id))) : null;
  const sending = r.state === 'unsure' || r.state === 'creating';
  const letter = jsonOf(r.letter, {});
  const addr = jsonOf(r.address);
  const saved = ['linked', 'created'].includes(r.state);
  // Something to do in Zeffy for a check that has its record: these clear themselves once done, or with "Looked at it"
  const letterToDo = saved && (letter.late || []).length ? 'late' : null;
  const tried = jsonOf(r.address_tried);
  const addressToDo = saved && r.address_done === 'refused';
  const extras = extrasOf(r);
  const toDo = (saved && ['amount-off', 'still-unpaid'].includes(r.reason)) || (r.state === 'came-back' && !!r.zeffy_id) || !!letterToDo || addressToDo || extras.length > 0;
  const theEntry = entry ? `Zeffy’s entry (${entry.name || 'no name'}, ${money(entry.cents)}${entry.at ? `, ${new Date(entry.at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })}` : ''})` : 'Zeffy’s entry';
  const amountToDo = saved && ['amount-off', 'still-unpaid'].includes(r.reason);
  const why = sending ? 'Zeffy hasn’t answered yet. The site is looking for the record, so don’t enter this one.'
    : extras.length ? `Zeffy has ${extras.length > 1 ? `${extras.length} more records` : r.state === 'left-out' ? 'a record' : 'a second record'} for this check (${extras.join(', ')}), from ${extras.length > 1 ? 'sends' : 'a send'} it didn’t answer clearly${r.state === 'left-out' ? ', though the check was marked not for Zeffy' : ''}. Delete ${extras.length > 1 ? 'those' : 'that one'} in Zeffy, and this goes away within the hour.`
    : letterToDo && !amountToDo ? 'A file was added in Mercury after this check went into Zeffy. Look at it there, and fix the record in Zeffy if it says something else (Zeffy can’t move a gift: delete it and enter it again, and it links itself within the hour).'
    : addressToDo && !amountToDo ? (tried?.address || tried?.email
      ? `Zeffy wouldn’t take ${tried.address ? 'the donor’s address' : 'the email'}. Add it to ${tried.who || r.payer || 'the donor'} in Zeffy: ${[tried.address ? addressLine(tried.address) : '', tried.email ? `${tried.address ? 'and the email ' : ''}${tried.email}` : ''].filter(Boolean).join(', ')}.`
      : 'Zeffy wouldn’t take the donor’s address. Look at the check in Mercury and add it in Zeffy.')
    : r.reason === 'amount-off' && saved ? `${theEntry} and the check (${money(r.cents)}) are for different amounts. Fix the amount in Zeffy.`
    : r.reason === 'still-unpaid' && saved ? `${theEntry} is still unpaid. Mark it paid in Zeffy.`
    : r.state === 'came-back' && r.zeffy_id ? 'The check came back. Cancel the record in Zeffy, and Zeffy tells the donor.'
    : r.state === 'left-out' && r.reason === 'person' ? (DONT_REASONS[r.note] ? `Not sent to Zeffy: ${DONT_REASONS[r.note]}.` : LEFT_OUT.person)
    : r.state === 'left-out' || r.state === 'came-back' ? LEFT_OUT[r.reason] || REASONS[r.reason] || null
    : r.state === 'person' ? noteWords(r.reason, r)
    : null;
  const waiting = r.state === 'person' && ['pending', 'sent'].includes(r.status);
  const card = r.state === 'person' ? jsonOf(r.card) : null;
  return {
    needsYou: waiting || toDo, toDo,
    id: r.id, cents: r.cents, status: r.status, state: r.state, depositedAt: r.deposited_at, depositDay: dayOf(r.deposited_at), postedAt: r.posted_at,
    payer: r.payer || '', checkDate: r.check_date || '', memo: r.memo || '', checkNumber: r.check_number || '',
    formId: r.form_id || '', formTitle: r.form_title || '', via: r.via || null, by: r.by || null, zeffyId: r.zeffy_id || null, link: r.link || null,
    reason: r.reason || null, why, candidates: candidates?.length ? candidates : null, ver: versionOf(r),
    category: r.category || null,
    // The card a person approves: filled in by prepareCard, with each note in words
    card: card ? {
      names: card.names || [], name: r.name_by && r.payer ? r.payer : card.name || '', donors: card.donors || [], donor: card.donor ?? null,
      formId: card.formId || '', formFor: card.formFor || {}, day: card.day || dayOf(r.deposited_at), email: card.email || '', emailFor: card.emailFor || '',
      letterAddress: card.letterAddress || null, letterAddressFor: card.letterAddressFor || '', checkAddress: card.checkAddress || null, checkAddressFor: card.checkAddressFor || '',
      notes: [...new Set([r.reason !== 'ready' ? r.reason : null, ...(card.notes || [])].filter(Boolean))].map((kind) => ({ kind, text: noteWords(kind, r) })).filter((n) => n.text),
      suggest: card.suggest || 'send', dontReason: card.dontReason || null, sent: card.sent || null,
    } : waiting ? { names: [], name: r.payer || '', donors: [], donor: null, formId: r.form_id || '', day: dayOf(r.deposited_at), email: '', letterAddress: null, letterAddressFor: '', checkAddress: addr, checkAddressFor: addr?.for || '', notes: noteWords(r.reason, r) ? [{ kind: r.reason, text: noteWords(r.reason, r) }] : [], suggest: 'send', dontReason: null } : null,
    drawer: r.drawer && r.payer && !surelySameGiver(r.drawer, r.payer) ? r.drawer : null,
    letter: letter.about || letter.why || (letter.files || []).length || letterToDo ? {
      unread: (letter.files || []).filter((k) => !letter.reads?.[k]).length,
      // A letter with a problem says nothing the site used: only the problem shows
      name: letter.why ? '' : letter.name || '', email: letter.why ? '' : letter.email || '', address: letter.why ? '' : addressLine(letter.address), why: letter.why ? REASONS[letter.why] || null : null,
      reading: DECIDING.includes(r.state) && (letter.pending || []).length > 0, todo: letterToDo,
    } : null,
    address: addr ? { line: addressLine(addr) } : null,
    emailTaken: ['email-taken', 'email-taken-only'].includes(r.address_done),
    mailInZeffy: ['written', 'same', 'email-same', 'email-taken'].includes(r.address_done),
    addressToDo,
    looked: shownToDo(r),
  };
}

/**
 * Everything the Checks tab shows: what waits on someone first, so the limit never pushes it off the page. now: the time
 * it's seen at, for tests and replays; the page's own is the clock's
 */
export async function checksView(env, { now = Date.now() } = {}) {
  await ensureChecks(env.DB);
  const cfg = await readState(env.DB, KEY);
  const rows = (await env.DB.prepare(`SELECT * FROM check_gifts ORDER BY CASE WHEN (state = 'person' AND status IN ('pending', 'sent')) OR (state IN ('linked', 'created') AND (reason IN ('amount-off', 'still-unpaid') OR address_done = 'refused' OR letter LIKE '%"late":["%')) OR (state = 'came-back' AND zeffy_id IS NOT NULL) OR extra IS NOT NULL THEN 1 ELSE 0 END DESC, deposited_at DESC LIMIT ?`).bind(LIST_LIMIT).all()).results || [];
  const all = (await env.DB.prepare('SELECT COUNT(*) AS n FROM check_gifts').first())?.n || 0;
  const claimed = await claimedIds(env.DB);
  // Each check's Category in Mercury, as last mirrored
  const cats = new Map(((await env.DB.prepare("SELECT id, category_name FROM mercury_txns WHERE kind = 'checkDeposit' AND category_name IS NOT NULL").all().catch(() => null))?.results || []).map((t) => [t.id, t.category_name]));
  const list = rows.map((r) => viewOf({ ...r, category: cats.get(r.id) || null }, claimed, now));
  return {
    // Sending needs the test of writing to Zeffy to have passed; filing under a donor with no email needs its join step
    sending: !!cfg.writeTest?.ok, joinOk: !!cfg.writeTest?.join?.ok,
    writeTest: cfg.writeTest || null,
    lastError: cfg.lastError || null,
    matchFailing: cfg.matchFailing || null,
    money: cfg.money || null,
    dontReasons: DONT_REASONS,
    list,
    limited: all > rows.length, shown: rows.length, all,
    waiting: list.filter((c) => c.needsYou).length,
    zeffyUrl: ZEFFY_PAYMENTS,
    configured: { mercury: mercuryConfigured(env), zeffy: !!String(env.ZEFFY_API_KEY || '').trim(), ai: !!env.AI },
  };
}

/** For the Automations map: times and counts only */
export async function checksFacts(DB) {
  await ensureChecks(DB);
  const cfg = await readState(DB, KEY);
  const c = await DB.prepare('SELECT COUNT(*) AS total, MAX(deposited_at) AS last FROM check_gifts').first();
  // The same rule the page's Needs you uses, so the tab's count is the list's
  const open = (await DB.prepare(`SELECT * FROM check_gifts WHERE state = 'person' OR reason IN ('amount-off', 'still-unpaid') OR (state = 'came-back' AND zeffy_id IS NOT NULL) OR address_done = 'refused' OR letter LIKE '%"late":["%' OR extra IS NOT NULL`).all()).results || [];
  const claimed = await claimedIds(DB);
  const waiting = open.filter((r) => viewOf(r, claimed).needsYou).length;
  return {
    lastRunAt: cfg.lastRunAt || null, error: cfg.lastError?.error || null, total: c?.total || 0, waiting, last: c?.last || null,
    writeOk: cfg.writeTest ? !!cfg.writeTest.ok : null,
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
const STATES = new Set(['new', 'read', 'person', 'creating', 'unsure', 'created', 'linked', 'left-out', 'store', 'came-back']);
const listedIds = (row) => { try { return row.note?.startsWith('[') ? JSON.parse(row.note).map((x) => String(x.id)) : []; } catch { return []; } };

/** An address a person typed or picked, made whole and safe, or null when it can't be (all four parts, five-digit ZIP) */
function addressFrom(a, checkNumber = '') {
  if (!a || typeof a !== 'object') return null;
  return addressOf({ street: a.line1, city: a.city, state: a.state, zip: a.postal_code }, checkNumber);
}

/**
 * A person sends a check to Zeffy from its card: who it's from, which Zeffy donor (one of theirs, or new), the form, the date,
 * and the email and mailing address to put on the donor. Zeffy is read again first: a hand entry made since is matched, not
 * doubled, and an entry that may be this check is shown before anything is sent, unless the person is looking right at it
 * and says it's another gift (notThose). The record goes in with its receipt and email off; the address and email go on the
 * donor after (writeAddresses). Zeffy has no way to refuse a repeat: one that may have saved is looked for, never sent again
 */
export async function personSend(env, id, { name, donor = 'new', formId, day = null, email = '', address = null, notThose = false, shown = [], donorsShown = [], saw = null, by = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const first = await getRow(env.DB, id);
  if (first && sameAnswer(first, by, now, (r) => ['created', 'creating', 'unsure'].includes(r.state) && r.by === by)) {
    return first.state === 'created' ? { result: 'created', id: String(first.zeffy_id), again: true } : { result: 'unsure', again: true };
  }
  const row = await mustRow(env, id, { saw });
  const cfg = await readState(env.DB, KEY);
  if (!cfg.writeTest?.ok) throw err('Sending is off until the site’s test record saves in Zeffy. Enter this one in Zeffy by hand, and it links itself within the hour.', 409);
  if (row.state !== 'person') throw err('This check has moved on. Look again.', 409);
  // The record lands when the money does
  if (!['pending', 'sent'].includes(row.status)) throw err('Mercury didn’t take this check, so it isn’t sent to Zeffy.', 409);
  if (nameProblem(name, row.check_number)) throw err(nameProblem(name, row.check_number));
  const payer = safeText(name, 120, row.check_number);
  if (!payer) throw err('Who is this gift from?');
  if (day != null) {
    const deposited = dayOf(row.deposited_at);
    if (!isDay(day)) throw err('That date doesn’t look right.');
    if (day > deposited) throw err('That date is after the check was deposited. Use the date on the check, or the day it was deposited.');
    if (Date.parse(`${deposited}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`) > 366 * DAY) throw err('That date is more than a year before the check was deposited. Use the day it was deposited instead.');
  }
  const mail = clean(email).toLowerCase();
  if (emailProblem(mail)) throw err(emailProblem(mail));
  const addr = address ? addressFrom(address, row.check_number) : null;
  if (address && !addr) throw err(`That address isn’t right. ${addressProblem(address, row.check_number) || 'It needs the street, the city, a two-letter state and a five-digit ZIP.'}`);
  const donorId = donor && donor !== 'new' ? String(donor) : null;
  if (donorId && !/^[A-Za-z0-9_-]{1,80}$/.test(donorId)) throw err('Pick a Zeffy donor.');
  // Every file the team attached in Mercury is read first, as it is now: one added, taken off or swapped since the card was made
  // is read again, and the card is made again with it. Mercury not answering doesn't hold a send up
  const unread = 'A letter attached in Mercury is still being read. Its card is ready again in a few minutes.';
  if (lettersWaiting(row)) throw err(unread, 409);
  const txn = await getTransaction(env, row.id, { fetchImpl }).catch(() => null);
  if (txn && ((await noteLetters(env, row, txn, now)) || (await verifyLetters(env, row, txn, now, fetchImpl)))) throw err(unread, 409);
  let forms;
  let payments;
  let claimed;
  try {
    forms = await openForms(env, fetchImpl);
    // A date the person picked reaches back as far as a stale check can, no further: past that Zeffy's whole read won't fit
    const reach = new Date(Date.parse(`${recordDay(row)}T12:00:00Z`) - STALE_REACH_MS).toISOString().slice(0, 10);
    const from = isDay(day) && day < earliestDay(row) ? (day < reach ? reach : day) : earliestDay(row);
    // A person sends on what they can see in Zeffy themselves: a read too big to see whole still shows what's near
    payments = (await readWide(env, secondsOf(from) - LOOK_BACK_S, now, fetchImpl)).payments;
    claimed = await claimedIds(env.DB);
  } catch {
    throw err('Zeffy didn’t answer, so nothing was sent. Try again in a minute.', 503);
  }
  const form = forms.find((f) => f.id === formId);
  if (!form) throw err('Pick an open donation form.');
  const seen = { ...row, payer, form_id: form.id, form_title: form.title };
  // The name is the person's own answer when they changed it from the card's (or gave it before): it then stands when the
  // card is made again. The card's own name, sent as it was, still follows the check and a letter attached later
  const cardName = clean(jsonOf(row.card, {}).name);
  const nameBy = payer !== cardName ? by : row.name_by && row.payer === payer ? row.name_by : null;
  // What the person chose to put on the donor, for the record this send makes or matches, and only for this giver's
  const plan = { donor: donorId, address: addr, email: mail, for: payer, formId: form.id, day: day || recordDay(row) };
  // A send before this one that Zeffy never answered: its record is looked for first, where it would be, so one check is
  // never saved twice however its date was typed. Found, it's this check's, with what the person chose now
  const before = jsonOf(row.payload);
  if (before) {
    let hit;
    try { hit = await findSent(env, row, before, fetchImpl); } catch { throw err('Zeffy didn’t answer, so nothing was sent. Try again in a minute.', 503); }
    if (hit) {
      // It went in as that earlier send was made: this press's address and email go on only if it's the same donor and name
      const first = jsonOf(row.send);
      const same = !!first && String(first.donor || 'new') === String(plan.donor || 'new') && sameName(first.for, plan.for);
      if (!(await settleFound(env, row, before, hit, now, fetchImpl, same ? { send: plan } : {}))) throw err('This check just changed. Look again.', 409);
      if (!same) throw err(`Zeffy saved the earlier send of this check after all${first?.for ? `, as from ${first.for}` : ''}, so nothing new was sent. If that’s the wrong donor, fix the record in Zeffy.`, 409);
      return { result: 'created', id: String(hit.id), found: true };
    }
  }
  const learned = await learnedFor(env.DB, payer);
  const drawerLearned = row.drawer ? await learnedFor(env.DB, row.drawer) : null;
  const m = matchBoth(seen, payments, claimedFor(seen, claimed), learned, drawerLearned);
  // "It's a different gift" covers only the entries the person was shown: one that turned up since is shown first
  const looked = new Set(Array.isArray(shown) ? shown.map(String) : []);
  // D6: an entry more than one waiting check fits never matches by itself here either, and one the person said is another
  // gift never matches at all: the first is asked about, the second left be
  const contested = await contestedOf(env, payments, claimed);
  const sameOk = m.same.filter((p) => !looked.has(String(p.id)) && !contested.has(String(p.id)));
  const sameAsk = m.same.filter((p) => !looked.has(String(p.id)) && contested.has(String(p.id)));
  if (sameOk.length) {
    if (!(await linkTo(env, seen, sameOk[0], { by, now, fetchImpl, send: plan, nameBy }))) throw err('This check just changed. Look again.', 409);
    return { result: 'linked' };
  }
  const netted = netBoth(seen, payments, claimedFor(seen, claimed), { learned, drawerLearned, ...(await freshFor(env, seen)) });
  // The same check number and amount deposited before: that deposit's record is shown first, though its check holds it
  const twin = await twinOf(env, row, [checkName(row), payer], { now, saved: true });
  if (twin) netted.push(...payments.filter((p) => String(p.id) === String(twin.zeffy_id)));
  const likely = [...new Map([...sameAsk, ...m.promised, ...m.maybe, ...m.other, ...netted].map((p) => [String(p.id), p])).values()];
  if (likely.length && (!notThose || likely.some((x) => !looked.has(String(x.id))))) {
    const entries = entriesToShow(likely);
    // The name the person typed is their answer (by): the card keeps it when it's made again
    if (!(await setRow(env.DB, id, { payer, by, name_by: nameBy, reason: m.promised.length ? 'pledge' : 'maybe-double', note: JSON.stringify(entries) }, now, row.state))) throw err('This check just changed. Look again.', 409);
    // The version the page now holds, so "Send a new record" is refused if the check changes while the person decides
    throw await refusedAfter(env, id, 'Zeffy has an entry that may be this check. Look at it first.', 409, { entries });
  }
  // The donor: one Zeffy already has (filed by their email, or under their contact when they have none), or a new one
  let record;
  let join = null;
  if (donorId) {
    let c;
    try {
      c = await zeffyGet(env, `/contacts/${encodeURIComponent(donorId)}`, {}, fetchImpl);
    } catch (e) {
      if (e.status !== 404) throw err('Zeffy didn’t answer, so nothing was sent. Try again in a minute.', 503);
      const card = jsonOf(row.card, {});
      if (card.donors) await setRow(env.DB, id, { card: JSON.stringify({ ...card, donors: card.donors.filter((d) => d.id !== donorId), donor: card.donor === donorId ? null : card.donor }) }, now, row.state);
      throw await refusedAfter(env, id, 'That donor isn’t in Zeffy any more. Pick another, or New donor.', 409);
    }
    let theirs = clean(c?.email).toLowerCase();
    // The record carries the names Zeffy already has for them, so filing under them never renames them
    const names = clean(c?.first_name) || clean(c?.last_name) ? { first_name: clean(c.first_name) || clean(c.last_name), last_name: clean(c.last_name) || clean(c.first_name) } : {};
    // So the donor has to be who it's from: by their own name in Zeffy, as the one this name was learned as, or tied to
    // the name on the card (the letter's email on them). A gift from a fund never goes in under a person's contact
    const own = givenName({ first_name: c?.first_name, last_name: c?.last_name });
    const listed = (jsonOf(row.card, {}).donors || []).find((d) => d.id === donorId);
    if (own && !sameGiver(payer, own) && String(learned?.contact_id || '') !== donorId && !(listed?.for || []).some((n) => sameName(n, payer))) {
      throw err(`That Zeffy donor is ${own}, and the gift would go in under their name. Pick the Zeffy donor for ${payer}, or New donor.`, 409);
    }
    if (isTag(theirs)) {
      if (!(await strayTagOff(env, donorId, theirs, fetchImpl, now).catch(() => false))) throw err('Zeffy is filing another check under this donor right now. Try again in a minute.', 503);
      theirs = '';
    }
    if (theirs) {
      if (mail && mail !== theirs) {
        // Zeffy has an email for them since the card was made: the card shows it, and a Send files by it
        const card = jsonOf(row.card, {});
        if (card.donors) await setRow(env.DB, id, { card: JSON.stringify({ ...card, donors: card.donors.map((d) => (d.id === donorId ? { ...d, email: theirs } : d)) }) }, now, row.state);
        throw await refusedAfter(env, id, `Zeffy has ${theirs} for this donor now, and the card shows it. Press Send again to use it, or change their email in Zeffy first.`, 409);
      }
      record = { ...recordFor(seen, { name: payer, form, email: theirs, day, now }), ...names };
    } else {
      if (!cfg.writeTest?.join?.ok) throw err('Zeffy can’t file a gift under a donor with no email yet. Pick New donor, or add their email in Zeffy first.', 409);
      // The email to add to them: one another donor holds would never go on, so it's asked about now, not refused after
      if (mail) await emailFree(env, row, id, mail, { payer, not: donorId, now, fetchImpl });
      record = { ...recordFor(seen, { name: payer, form, day, now }), ...names };
      join = donorId;
    }
  } else {
    // A new donor only once the person has seen the ones Zeffy has under this name: a name typed that the card never looked
    // up (a check the site couldn't read) can be a giver Zeffy knows, and a second contact for them splits their giving
    const seenDonors = new Set((Array.isArray(donorsShown) ? donorsShown : []).map(String));
    const found = donorsFor(payments, [payer], { learned });
    if (learned?.contact_id && !found.some((d) => d.id === String(learned.contact_id))) found.unshift({ id: String(learned.contact_id), name: '', email: '', gifts: 0, last: 0, address: null, sure: true });
    const unseen = found.filter((d) => !seenDonors.has(d.id));
    if (unseen.length) {
      const named = await confirmDonors(env, unseen, [payer], { learned, learnedName: payer, fetchImpl });
      if (named.length) {
        const card = jsonOf(row.card, {});
        const donors = [...(card.donors || []).filter((d) => !named.some((a) => a.id === d.id)), ...named.map((d) => ({ ...d, added: true }))];
        // The name typed is the person's answer: the card keeps it, with these donors, when it's made again
        await setRow(env.DB, id, { card: JSON.stringify({ ...card, donors }), payer, name_by: nameBy }, now, row.state);
        throw await refusedAfter(env, id, `Zeffy already has ${named.length === 1 ? `a donor named ${named[0].name || payer}` : `${named.length} donors named ${payer}`}. Look at Zeffy donor, then press Send again: pick ${named.length === 1 ? 'them' : 'theirs'}, or New donor if this is someone else.`, 409);
      }
    }
    // Zeffy files a record under whoever has the email: one another donor holds would put this gift on them
    if (mail) await emailFree(env, row, id, mail, { payer, now, fetchImpl });
    record = recordFor(seen, { name: payer, form, email: mail || null, day, now });
  }
  // Entries the person said are other gifts: never offered for this check again, nor called a double of it
  const ruledOut = notThose ? [...new Set([...rejectedBy(row), ...looked])] : rejectedBy(row);
  const keep = { payer, name_by: nameBy, form_id: form.id, form_title: form.title, rejected: JSON.stringify(ruledOut), send: JSON.stringify(plan) };
  const undo = Object.fromEntries(Object.keys(keep).map((k) => [k, row[k] ?? null]));
  const r = await createRecord(env, seen, record, { from: row.state, now, fetchImpl, by, learnWith: { name: payer }, join, keep, undo });
  if (r.result === 'later') throw err('Zeffy is busy, so nothing was sent. Try again in a minute.', 503);
  if (r.result === 'refused') throw err(`${r.error} Try again, or enter it in Zeffy by hand.`, 422);
  if (r.result === 'unsure') throw err('Zeffy didn’t answer. The site is looking for the record, so don’t send this one again.', 503);
  if (r.result === 'busy') throw err('This check has moved on. Look again.', 409);
  return r;
}

/**
 * An email a person gave for the donor, free to use: one Zeffy has on another donor is shown on the card under Zeffy
 * donor (tied to this name, by the email), and nothing is sent. not: the donor it's going on
 */
async function emailFree(env, row, id, mail, { payer, not = null, now, fetchImpl }) {
  let held;
  try {
    // Zeffy's email filter is exact on a contact's main or second email (its spec), and filing by email may take either:
    // every contact it gives holds this one
    held = ((await zeffyGet(env, '/contacts', { email: mail, limit: 10 }, fetchImpl))?.data || []).filter((c) => String(c.id) !== String(not));
  } catch {
    throw err('Zeffy didn’t answer, so nothing was sent. Try again in a minute.', 503);
  }
  if (!held.length) return;
  const card = jsonOf(row.card, {});
  const add = held.map((c) => ({ id: String(c.id), name: givenName({ first_name: c.first_name, last_name: c.last_name }), email: clean(c.email).toLowerCase() || mail, gifts: Number(c.donation_count) || 0, last: Number(c.last_donation_date) || 0, address: buyerAddress(c.address), sure: false, for: [], sureFor: [], added: true }));
  const donors = [...(card.donors || []).filter((d) => !add.some((a) => a.id === d.id)), ...add];
  await setRow(env.DB, id, { card: JSON.stringify({ ...card, donors }) }, now, row.state);
  throw await refusedAfter(env, id, `Zeffy already has ${mail} on ${add[0].name || 'another donor'}. If the gift is theirs, pick them under Zeffy donor (it goes in under their name). If not, check the email, or leave it empty.`, 409);
}

/**
 * Before a person decides a check another way (Don't send, This is the check): a send of it Zeffy never answered clearly
 * may have saved after all. Found, that's the check's record, and the person is told so; Zeffy not answering stops them
 * (so nothing is decided on a guess)
 */
async function earlierSendFirst(env, row, { now, fetchImpl }) {
  const before = jsonOf(row.payload);
  if (!before || !['person', 'unsure'].includes(row.state)) return;
  let hit;
  try { hit = await findSent(env, row, before, fetchImpl); } catch { throw err('Zeffy didn’t answer, so nothing changed. Try again in a minute.', 503); }
  if (!hit) return;
  await settleFound(env, row, before, hit, now, fetchImpl);
  throw err('Zeffy saved the earlier send of this check after all, so it’s in Zeffy now and nothing else changed. Look at it on Checks.', 409);
}

/**
 * A refusal that changed the check itself (donors found and added, the name kept, a donor gone, Zeffy's email learned):
 * it says the version it left, so the page takes the card it comes back to as the person's own doing. A refusal that
 * changed nothing (the check changed by someone else first) says none, and the page says the card was updated
 */
async function refusedAfter(env, id, message, status, extra = {}) {
  const row = await getRow(env.DB, id);
  return Object.assign(err(message, status), { ver: row ? versionOf(row) : null, ...extra });
}

/** A person says this check is that Zeffy entry */
export async function personLink(env, id, zeffyId, { saw = null, by = null, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(zeffyId || ''))) throw err('Pick a Zeffy entry.');
  const first = await getRow(env.DB, id);
  if (first && sameAnswer(first, by, now, (r) => r.state === 'linked' && String(r.zeffy_id) === String(zeffyId))) return { result: 'linked', again: true };
  const row = await mustRow(env, id, { saw });
  if (rejectedBy(row).includes(String(zeffyId))) throw err('Someone said that entry isn’t this check. Look again.', 409);
  if (row.zeffy_id) throw err('This check already has its Zeffy record.', 409);
  await earlierSendFirst(env, row, { now, fetchImpl });
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
    if (row.state === 'person') {
      await setRow(env.DB, id, { state: 'read', note: null }, now, row.state);
      throw err('That Zeffy entry was deleted, so there’s nothing to match. Its card is made again in a few minutes.', 409);
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

/** A person says the matched entry isn't this check: it comes off, is never offered again, and the check gets its card again */
export async function personUnlink(env, id, { saw = null, by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id, { saw });
  if (row.state !== 'linked' || !row.zeffy_id) throw err('Only a matched entry can be taken off.', 409);
  // The name it's sent under is worked out again from the check and its letter (a name copied from the entry was someone else's)
  if (!(await setRow(env.DB, id, {
    state: 'read', reason: 'unlinked', note: null, payer: null, name_by: null, by: null, send: null, zeffy_id: null, via: null, try_at: null, address_done: null, address_at: null, taught: null,
    rejected: JSON.stringify([...rejectedBy(row), String(row.zeffy_id)]),
  }, now, 'linked'))) throw err('This check just changed. Look again.', 409);
  // What the wrong match taught about whose donor this is is undone, and nothing else: what earlier gifts taught about that
  // giver is put back as it was, and a name copied from the entry onto a check with none taught nothing. If another check
  // has taught that name since, that stands. A match made before the site noted what it taught (taught is null) forgets the
  // check's names, as it did then
  const t = jsonOf(row.taught);
  // The record was the returned deposit's: it goes back to it, and its "cancel it in Zeffy" to-do with it
  if (t?.tookFrom) {
    const back = await env.DB.prepare("UPDATE check_gifts SET zeffy_id = ?, updated_at = ? WHERE id = ? AND state = 'came-back' AND zeffy_id IS NULL").bind(String(row.zeffy_id), new Date(now).toISOString(), t.tookFrom).run();
    if (back.meta?.changes) {
      const returned = await getRow(env.DB, t.tookFrom);
      if (returned) await tell(env, { ...returned, alerted: null }, 'back', { title: `A check came back: ${money(returned.cents)}`, lead: 'Its Zeffy record was matched to the same check deposited again, and that match was taken off.', fix: 'Cancel the record in Zeffy: no money came in for it.' });
    }
  }
  if (t?.name) {
    const key = payerKey(t.name);
    const nowRow = await env.DB.prepare('SELECT contact_id, campaign_id FROM check_payers WHERE key = ?').bind(key).first();
    const untouched = !nowRow || (t.after && String(nowRow.contact_id ?? '') === String(t.after.contact_id ?? '') && String(nowRow.campaign_id ?? '') === String(t.after.campaign_id ?? ''));
    if (untouched && t.before) {
      await env.DB.prepare('INSERT OR REPLACE INTO check_payers (key, name, contact_id, campaign_id, by, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(key, t.before.name, t.before.contact_id ?? null, t.before.campaign_id ?? null, t.before.by ?? null, t.before.updated_at).run();
    } else if (untouched) await env.DB.prepare('DELETE FROM check_payers WHERE key = ?').bind(key).run();
  } else if (row.taught == null) {
    for (const name of [row.payer, row.drawer].filter(Boolean)) await env.DB.prepare('DELETE FROM check_payers WHERE key = ?').bind(payerKey(name)).run();
  }
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

/** A person says not to send this check to Zeffy, and why (DONT_REASONS). "Send to Zeffy after all" undoes it */
export async function personDontSend(env, id, { reason, saw = null, by = null, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!DONT_REASONS[reason]) throw err('Say why it isn’t for Zeffy.');
  const first = await getRow(env.DB, id);
  if (first && sameAnswer(first, by, now, (r) => r.state === 'left-out' && r.reason === 'person')) return { result: 'left-out', again: true };
  const row = await mustRow(env, id, { saw });
  if (row.zeffy_id) throw err('This check has a Zeffy record. Delete it in Zeffy first, and this page catches up within the hour.', 409);
  if (!['new', 'read', 'person'].includes(row.state)) throw err('This check has moved on. Look again.', 409);
  await earlierSendFirst(env, row, { now, fetchImpl });
  if (!(await setRow(env.DB, id, { state: 'left-out', reason: 'person', note: reason, by }, now, row.state))) throw err('This check just changed. Look again.', 409);
  await allClear(env, row, `Not sent to Zeffy: ${DONT_REASONS[reason]}.`);
  return { result: 'left-out' };
}

/** A person takes back "don't send": the check gets its card again, made fresh against Zeffy */
export async function personReopen(env, id, { saw = null, by = null, now = Date.now() } = {}) {
  const row = await mustRow(env, id, { saw });
  if (!['left-out', 'store'].includes(row.state) || row.zeffy_id) throw err('This check has moved on. Look again.', 409);
  if (!['pending', 'sent'].includes(row.status)) throw err('Mercury didn’t take this check, so it can’t go to Zeffy.', 409);
  // (a store-account check says so on its card: prepareCard knows the account)
  // (one from the store's account was never read: it's read now, as every check is)
  const store = row.state === 'store';
  if (!(await setRow(env.DB, id, { state: store && !row.shape ? 'new' : 'read', reason: null, note: null, by: null, try_at: null, tries: store && !row.shape ? 0 : row.tries }, now, row.state))) throw err('This check just changed. Look again.', 409);
  return { result: 'reopened' };
}
