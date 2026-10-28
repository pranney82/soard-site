/**
 * Which job a dollar belongs to, which cost code, and which bill it became
 * ===========================================================================
 * Pure functions, no I/O: the Mercury side (./_spend.js) and the ledger
 * (./_job-ledger.js) both lean on them, and the tests drive them directly.
 *
 * A Mercury charge gets a job the moment it arrives, best signal first:
 *   staff    someone picked it in Admin → Job Costs (always wins)
 *   person   the cardholder is on exactly one active job in JobTread
 *   build    only one job is being built right now
 * …or none, and it waits in "Unassigned" until a bill or a person places it.
 * A guess is only a guess: when the receipt's JobTread bill turns up, the
 * bill's job and cost codes replace it.
 *
 * A cost code comes from the vendor rules (TKO Plumbing → 19 PLUMBING), the
 * same rules the DataX Receipt Processor reads to code each receipt line.
 *
 * Not every dollar is a makeover's. Each charge lands in one bucket:
 *   job        a makeover (JobTread job costing)
 *   store      Sunny & Ranney, the store
 *   operating  running SOARD (software, rent, insurance, the gala…)
 * A card set aside for one bucket decides first (the store's card is all
 * store), then the Mercury account it came from (a store checking account),
 * then the vendor rules, then a job guess; what's left is unsorted.
 */
export const BUCKETS = ['job', 'store', 'operating'];

/**
 * The bucket for a charge: { bucket, how } (bucket null = unsorted).
 * cardBuckets / accountBuckets: { mercuryId: bucket }, rule: ruleFor(...) result
 */
export function bucketOf(charge, { cardBuckets = {}, accountBuckets = {}, rule = null } = {}) {
  const byCard = cardBuckets[charge?.cardId];
  if (BUCKETS.includes(byCard)) return { bucket: byCard, how: 'card' };
  const byAccount = accountBuckets[charge?.accountId];
  if (BUCKETS.includes(byAccount)) return { bucket: byAccount, how: 'account' };
  if (rule?.kind === 'store' || rule?.kind === 'operating') return { bucket: rule.kind, how: 'rule' };
  return { bucket: null, how: null };
}

/** Mercury transaction kinds that are spending (or its refund); transfers, deposits and fees aren't */
export const SPEND_KINDS = new Set([
  'creditCardTransaction', 'debitCardTransaction', 'creditCardCredit', 'debitCardCredit',
  'outgoingPayment', 'expenseReimbursement',
]);
const CARD_KINDS = new Set(['creditCardTransaction', 'debitCardTransaction', 'creditCardCredit', 'debitCardCredit']);

/** Statuses where money moved or is about to; cancelled, failed, blocked and reversed drop off */
export const LIVE_STATUSES = new Set(['pending', 'sent']);

/** JobTread statuses (the Status custom field) when buying for a job happens */
export const BUYING_STATUSES = new Set(['Approval', 'Mobilization', 'Build']);

const STOP_WORDS = new Set(['the', 'inc', 'llc', 'co', 'corp', 'company', 'store', 'stores', 'com', 'www', 'of', 'and', 'usa', 'us', 'ltd', 'services', 'service']);

/**
 * A vendor's name as a matching key: "THE HOME DEPOT #0123", "Home Depot",
 * "homedepot.com" → "home depot". Card descriptors carry store numbers, city
 * names after a run of spaces, and "SQ *" / "TST*" processor prefixes.
 */
export function vendorKey(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/^(sq|tst|sp|pp|paypal|py|dd)\s*\*\s*/, '');
  s = s.replace(/\s{2,}.*$/, '');                // "LOWES #01234   ATLANTA GA"
  s = s.replace(/\.(com|net|org|co)\b/g, ' ');
  s = s.replace(/'s\b/g, 's').replace(/&/g, ' and ');
  s = s.replace(/[#*][\w-]*|\d+/g, ' ');
  s = s.replace(/[^a-z ]+/g, ' ');
  const words = s.split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
  // "homedepot" and "home depot" are the same store
  return words.join(' ').replace(/^homedepot$/, 'home depot').replace(/^lowes home improvement$/, 'lowes').trim();
}

/** How alike two vendor names are, 0..1 (shared words over the shorter name's words) */
export function vendorLikeness(a, b) {
  const ka = vendorKey(a);
  const kb = vendorKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (ka.replace(/ /g, '') === kb.replace(/ /g, '')) return 1;
  const wa = new Set(ka.split(' '));
  const wb = new Set(kb.split(' '));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

/** The rule for a vendor (rules: [{ vendor, costCodeId, kind }]), best match, or null */
export function ruleFor(vendor, rules = []) {
  let best = null;
  let bestScore = 0;
  for (const r of rules) {
    const score = vendorLikeness(vendor, r.vendor);
    if (score > bestScore || (score === bestScore && score > 0 && (r.source === 'staff') && best?.source !== 'staff')) {
      best = r;
      bestScore = score;
    }
  }
  return bestScore >= 1 ? best : null;
}

/** Cents spent: a debit (negative in Mercury) is positive spend, a refund negative */
export const spendCents = (amount) => Math.round(-Number(amount || 0) * 100);

/**
 * One Mercury transaction as the row the site keeps, or null when it isn't
 * spending (a transfer, a deposit, interest).
 */
export function chargeOf(txn, { cardEmail = null } = {}) {
  if (!txn?.id || !SPEND_KINDS.has(txn.kind)) return null;
  const cents = spendCents(txn.amount);
  if (!cents) return null;
  return {
    id: String(txn.id),
    kind: txn.kind,
    card: CARD_KINDS.has(txn.kind),
    status: String(txn.status || 'pending'),
    cents,
    accountId: txn.accountId || null,
    vendor: String(txn.counterpartyNickname || txn.counterpartyName || txn.bankDescription || 'Unknown').slice(0, 120),
    cardId: txn.cardId || txn.details?.creditCardInfo?.id || txn.details?.debitCardInfo?.id || null,
    email: (cardEmail || txn.details?.creditCardInfo?.email || '').toLowerCase() || null,
    createdAt: txn.createdAt || null,
    postedAt: txn.postedAt || null,
    note: txn.note || null,
    categoryId: txn.categoryData?.id || null,
    hasReceipt: (txn.attachments || []).some((a) => a?.attachmentType === 'receipt') || !!txn.hasGeneratedReceipt,
    link: txn.dashboardLink || null,
  };
}

/**
 * The job for a charge right now: { jobId, how } or { jobId: null }.
 * jobs: [{ id, status, staff: [emails] }] (active jobs only)
 */
export function guessJob(charge, jobs = [], { staffPick = null } = {}) {
  if (staffPick !== null && staffPick !== undefined) return { jobId: staffPick || null, how: 'staff' };
  const buying = jobs.filter((j) => BUYING_STATUSES.has(j.status));
  const email = String(charge?.email || '').toLowerCase();
  if (email) {
    const mine = buying.filter((j) => (j.staff || []).some((e) => String(e).toLowerCase() === email));
    if (mine.length === 1) return { jobId: mine[0].id, how: 'person' };
  }
  const building = jobs.filter((j) => j.status === 'Build');
  if (building.length === 1) return { jobId: building[0].id, how: 'build' };
  return { jobId: null, how: null };
}

const DAY = 24 * 3600 * 1000;

/**
 * Pair JobTread bills with Mercury charges, one to one. A pair needs the
 * same total to the cent, and either a vendor that matches or a total no
 * other charge in the window shares. The bill's date (receipt date) is
 * within 3 days before to 7 after the charge; a bill made later than that is
 * still fine when its issue date is in that window.
 *
 * bills:   [{ id, jobId, vendor, cents, date (YYYY-MM-DD or ISO), chargeId? }]
 * charges: [{ id, cents, vendor, createdAt, billId? }]
 * → [{ billId, chargeId, score }]
 */
export function pairBills(bills, charges) {
  const open = charges.filter((c) => !c.billId && c.cents > 0);
  const taken = new Set();
  const out = [];
  const candidates = [];
  for (const b of bills) {
    if (b.chargeId || !(b.cents > 0)) continue;
    const bt = Date.parse(b.date);
    for (const c of open) {
      if (c.cents !== b.cents) continue;
      const ct = Date.parse(c.createdAt);
      if (!Number.isFinite(bt) || !Number.isFinite(ct)) continue;
      const lag = (bt - ct) / DAY;
      if (lag < -3 || lag > 7) continue;
      const like = vendorLikeness(b.vendor, c.vendor);
      const twins = open.filter((o) => o.cents === b.cents && Math.abs(Date.parse(o.createdAt) - ct) < 10 * DAY).length;
      if (like < 0.5 && twins > 1) continue;
      candidates.push({ billId: b.id, chargeId: c.id, score: like * 10 - Math.abs(lag) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedBills = new Set();
  for (const c of candidates) {
    if (usedBills.has(c.billId) || taken.has(c.chargeId)) continue;
    usedBills.add(c.billId);
    taken.add(c.chargeId);
    out.push(c);
  }
  return out;
}

/** "$1,234.56" */
export function dollars(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
