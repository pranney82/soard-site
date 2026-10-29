/**
 * Ramp, while it still pays the bills: held until the vendor's papers are in
 * ===========================================================================
 * Until bills move to Mercury (the switch day in Job Costs → Bills →
 * Settings) Ramp pays them, so the stop in ./_bill-pay.js can't keep Ramp
 * from paying a vendor whose W-9 or insurance isn't current. This does it in
 * Ramp:
 *
 *  1. Every 15 minutes (the vendors heartbeat, ./_vendors.js) the site reads
 *     Ramp's unpaid bills and finds each one's JobTread vendor: through the
 *     copy of the bill in JobTread (same amount, the vendor's name alike), or
 *     else the one JobTread vendor by that name.
 *  2. Their W-9 or insurance isn't current (billDocs, fresh from JobTread;
 *     "W-9 only" and "Not needed" count as current): the bill goes on hold in
 *     Ramp, which takes it off the payment schedule, with the reason; the
 *     vendor gets the email with their upload link; the JobTread copy of the
 *     bill gets a pinned note; the Finance channel hears once.
 *  3. Their documents check out: the hold the site made comes off in Ramp
 *     (releaseRampHolds, from releaseVendorHolds in ./_bill-pay.js) and the
 *     note comes unpinned. A hold someone made in Ramp is never touched.
 *
 * For a day after Ramp is first connected nothing is held: the site notes
 * what it would hold and posts that list to the Finance channel once, so a
 * store (or anyone else who needs no papers) can be set to "Not needed" in
 * JobTread before it starts.
 *
 * Keys: an API app made in Ramp (client credentials) with bills:read and
 * bills:write, kept in Cloudflare as RAMP_CLIENT_ID and RAMP_CLIENT_SECRET.
 * Ramp marks bill hold and release as beta. Ramp has no API to schedule a
 * payment, so a released bill Ramp leaves unscheduled is said so in Slack.
 */

import { pave } from './_reveals.js';
import { slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { readState, writeState } from './_mercury.js';
import { vendorLikeness, dollars } from './_spend-match.js';
import { billDocs, askForBill } from './_vendors.js';

export const RAMP_BASE = 'https://api.ramp.com/developer/v1';
export const STATE_KEY = 'ramp';
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
export const WATCH_MS = DAY;
const RECHECK_MS = 60 * MIN;      // a vendor with an unpaid Ramp bill, read again
const READS_PER_RUN = 12;
const ADMIN = `${SITE_ORIGIN}/admin/#job-costs/bills`;

/** Where a bill can still be stopped; paying, paid, rejected and archived bills are left as they are */
export const HOLDABLE = new Set(['APPROVAL_PENDING', 'AWAITING_PAYMENT', 'AWAITING_RELEASE', 'PAYMENT_READY', 'PAYMENT_SCHEDULED',
  'PAYMENT_NOT_INSTRUCTED', 'PAYMENT_DETAILS_MISSING', 'PAYMENT_ERROR', 'WAITING_FOR_VENDOR', 'PENDING_VENDOR_APPROVAL', 'BLOCKED']);

const SCHEMA = `CREATE TABLE IF NOT EXISTS ramp_holds (
  ramp_id TEXT PRIMARY KEY, account_id TEXT, jt_bill_id TEXT, vendor TEXT, cents INTEGER, invoice TEXT,
  state TEXT NOT NULL, reason TEXT, status TEXT, checked_at TEXT, held_at TEXT, released_at TEXT, asked_at TEXT, note_id TEXT, updated_at TEXT)`;
const _ready = new WeakSet();
export async function ensureRampSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  await DB.prepare('CREATE INDEX IF NOT EXISTS ramp_holds_account ON ramp_holds (account_id)').run();
  _ready.add(DB);
}

const rowOf = (r) => r && ({
  rampId: r.ramp_id, accountId: r.account_id, jtBillId: r.jt_bill_id, vendor: r.vendor, cents: r.cents, invoice: r.invoice,
  state: r.state, reason: r.reason, status: r.status, checkedAt: r.checked_at, heldAt: r.held_at, releasedAt: r.released_at, askedAt: r.asked_at, noteId: r.note_id,
});

async function putRow(DB, rampId, patch, now = Date.now()) {
  const before = rowOf(await DB.prepare('SELECT * FROM ramp_holds WHERE ramp_id = ?').bind(rampId).first()) || { rampId, state: 'new' };
  const r = { ...before, ...patch };
  await DB.prepare(`INSERT OR REPLACE INTO ramp_holds (ramp_id, account_id, jt_bill_id, vendor, cents, invoice, state, reason, status, checked_at, held_at, released_at, asked_at, note_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(rampId, r.accountId || null, r.jtBillId || null, r.vendor || null, r.cents ?? null, r.invoice || null, r.state, r.reason || null, r.status || null,
      r.checkedAt || null, r.heldAt || null, r.releasedAt || null, r.askedAt || null, r.noteId || null, new Date(now).toISOString()).run();
  return r;
}

// ─── Ramp's API ─────────────────────────────────────────────────────

export const rampConfigured = (env) => !!(String(env.RAMP_CLIENT_ID || '').trim() && String(env.RAMP_CLIENT_SECRET || '').trim());

let _token = null;   // { id, value, until }: one isolate's token, until shortly before it ends
export const forgetRampToken = () => { _token = null; };

const refused = (status, text) => Object.assign(new Error(status === 401 || status === 403
  ? `Ramp refused the keys (${status}). Check RAMP_CLIENT_ID and RAMP_CLIENT_SECRET in Cloudflare, and that the Ramp app has bills:read and bills:write.`
  : `Ramp said ${status}: ${String(text || '').slice(0, 200)}`), { status });

async function accessToken(env, fetchImpl) {
  const id = String(env.RAMP_CLIENT_ID).trim();
  if (_token && _token.id === id && Date.now() < _token.until) return _token.value;
  const res = await fetchImpl(`${RAMP_BASE}/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${id}:${String(env.RAMP_CLIENT_SECRET).trim()}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'bills:read bills:write' }).toString(),
  });
  if (!res.ok) throw refused(res.status, await res.text().catch(() => ''));
  const d = await res.json();
  _token = { id, value: d.access_token, until: Date.now() + Math.max(60, (Number(d.expires_in) || 3600) - 300) * 1000 };
  return _token.value;
}

/** One call to Ramp's developer API (path under /developer/v1, or a full `page.next` URL) */
export async function ramp(env, path, { method = 'GET', query = null, body = null, fetchImpl = fetch } = {}) {
  const url = new URL(path.startsWith('https://') ? path : `${RAMP_BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
  const call = async () => fetchImpl(url.href, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env, fetchImpl)}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let res = await call();
  if (res.status === 401) { _token = null; res = await call(); }   // the token ended early: once more with a new one
  if (!res.ok) throw refused(res.status, await res.text().catch(() => ''));
  return res.status === 204 ? null : res.json();
}

const centsOf = (amount) => {
  if (!amount || amount.amount == null) return null;
  const rate = Number(amount.minor_unit_conversion_rate) || 100;
  return Math.round((Number(amount.amount) / rate) * 100);
};

/** A Ramp bill, as the site uses it */
export const billOf = (b) => ({
  id: b.id, vendor: b.vendor?.name || b.vendor?.remote_name || '', cents: centsOf(b.amount), invoice: b.invoice_number || null,
  issuedAt: b.issued_at || null, status: b.status_summary || null, paid: b.status === 'PAID', archived: !!b.archived_at,
});

/** Ramp's unpaid bills → [billOf] */
export async function openRampBills(env, { fetchImpl = fetch } = {}) {
  const out = [];
  let next = '/bills';
  let query = { payment_status: 'OPEN', is_archived: false, page_size: 100 };
  for (let i = 0; i < 10 && next; i++) {
    const d = await ramp(env, next, { query, fetchImpl });
    out.push(...(d?.data || []).map(billOf).filter((b) => !b.paid && !b.archived));
    next = d?.page?.next || null;
    query = null;   // page.next carries them
  }
  return out;
}

// ─── Which JobTread vendor ──────────────────────────────────────────

const plainNo = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * A Ramp bill's JobTread vendor. jtBills: [{ id, vendor, cents, number,
 * date, accountId }]; vendors: [{ jtId, name }]
 * → { accountId, jtBillId } or null when nothing (or more than one) fits
 */
export function matchRampBill(rb, jtBills, vendors) {
  const like = jtBills.filter((b) => b.accountId && b.cents === rb.cents && vendorLikeness(b.vendor, rb.vendor) >= 0.5);
  const byNo = rb.invoice ? like.filter((b) => b.number && plainNo(b.number) === plainNo(rb.invoice)) : [];
  const one = byNo.length === 1 ? byNo[0] : like.length === 1 ? like[0] : null;
  if (one) return { accountId: one.accountId, jtBillId: one.id };
  // Several copies of the same amount (a monthly bill): still one vendor
  const accounts = [...new Set(like.map((b) => b.accountId))];
  if (accounts.length === 1) return { accountId: accounts[0], jtBillId: null };
  const named = vendors.filter((v) => vendorLikeness(v.name, rb.vendor) === 1);
  return named.length === 1 ? { accountId: named[0].jtId, jtBillId: null } : null;
}

// ─── Holding and letting go ─────────────────────────────────────────

const holdReason = (vendor, docs) => `Waiting on ${vendor} for ${docs.state.send || 'a W-9 and a current certificate of insurance'}${docs.state.detail ? ` (${docs.state.detail})` : ''}`.slice(0, 200);

async function billNote(env, billId, { name, message, pinned = false }) {
  const d = await pave(env.JOBTREAD_GRANT_KEY, {
    createComment: {
      $: { targetType: 'document', targetId: billId, name, message, isPinned: pinned, isVisibleToAll: false, isVisibleToInternalRoles: true, isVisibleToVendorRoles: false, isVisibleToCustomerRoles: false },
      createdComment: { id: {} },
    },
  });
  return d?.createComment?.createdComment?.id || null;
}

async function holdOne(env, rb, m, docs, { now, fetchImpl }) {
  const iso = new Date(now).toISOString();
  const reason = holdReason(docs.vendor.name, docs);
  await ramp(env, `/bills/${encodeURIComponent(rb.id)}/hold`, { method: 'POST', body: { reason: `${reason}. Comes off by itself once they check out (SOARD website).` }, fetchImpl });
  const asked = await askForBill(env, docs.vendor, docs.state, { number: rb.invoice, cents: rb.cents }, { now }).catch((e) => ({ ok: false, error: e.message }));
  const noteId = m.jtBillId ? await billNote(env, m.jtBillId, {
    name: 'Held in Ramp', pinned: true,
    message: `On hold in Ramp since ${new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}: ${docs.vendor.name} needs to send ${docs.state.send}${docs.state.detail ? ` (${docs.state.detail})` : ''}. `
      + (asked.noEmail ? 'There’s no email for them in JobTread, so add one to their contact and they’re asked within 15 minutes. ' : 'They were emailed for it with their own upload link. ')
      + 'The hold comes off by itself once their documents check out. (SOARD website, Job Costs → Bills)',
  }).catch(() => null) : null;
  await slackIssue(env, `ramp:${rb.id}`, slackCard({
    icon: '⏸️', title: `${docs.vendor.name}: Ramp bill on hold`,
    lead: `Not paid until ${docs.vendor.name} sends ${docs.state.send}${docs.state.detail ? ` (${docs.state.detail})` : ''}. ${asked.noEmail ? 'There’s no email for them in JobTread, so nobody could ask: add one to their contact.' : 'They were emailed for it; the hold comes off by itself once it checks out.'}`,
    facts: [['Amount', dollars(rb.cents)], ...(rb.invoice ? [['Invoice', rb.invoice]] : [])],
    buttons: [{ label: 'Open bills', url: ADMIN }, { label: 'Vendor in JobTread', url: `https://app.jobtread.com/vendors/${m.accountId}` }],
  }), { title: `${docs.vendor.name} Ramp bill`, kind: 'attention', area: 'finance' }).catch(() => null);
  return putRow(env.DB, rb.id, { state: 'held', reason, status: 'ON_HOLD', heldAt: iso, askedAt: asked.ok && !asked.skipped ? iso : null, noteId }, now);
}

async function releaseOne(env, row, { now, fetchImpl }) {
  const d = await ramp(env, `/bills/${encodeURIComponent(row.rampId)}/release`, { method: 'POST', fetchImpl });
  const status = d?.status_summary || null;
  if (row.noteId) await pave(env.JOBTREAD_GRANT_KEY, { updateComment: { $: { id: row.noteId, isPinned: false } } }).catch(() => null);
  if (row.jtBillId) await billNote(env, row.jtBillId, { name: 'Documents in', message: `${row.vendor}’s W-9 and insurance checked out, so the hold came off in Ramp.` }).catch(() => null);
  const unscheduled = status === 'PAYMENT_NOT_INSTRUCTED';
  await slackResolved(env, `ramp:${row.rampId}`, slackCard({ icon: '✅', title: `${row.vendor}: documents in` }), {
    summary: unscheduled ? 'The hold is off in Ramp, but Ramp didn’t schedule the payment again: schedule it in Ramp.' : 'The hold is off in Ramp, so it pays as usual.',
  }).catch(() => null);
  return putRow(env.DB, row.rampId, { state: 'released', status, releasedAt: new Date(now).toISOString(), reason: null }, now);
}

/** A vendor's documents checked out: the holds the site made in Ramp come off → how many */
export async function releaseRampHolds(env, accountId, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!rampConfigured(env) || !accountId) return 0;
  await ensureRampSchema(env.DB);
  const rows = ((await env.DB.prepare("SELECT * FROM ramp_holds WHERE account_id = ? AND state IN ('held', 'watch')").bind(accountId).all()).results || []).map(rowOf);
  let n = 0;
  for (const r of rows) {
    if (r.state === 'watch') { await putRow(env.DB, r.rampId, { state: 'clear', reason: null, checkedAt: new Date(now).toISOString() }, now); continue; }
    try { await releaseOne(env, r, { now, fetchImpl }); n++; } catch (e) { console.error('[ramp] release', r.rampId, e.message); }
  }
  return n;
}

// ─── Each run ───────────────────────────────────────────────────────

/**
 * Ramp's unpaid bills against their vendors' documents: hold, keep, or let
 * go. → { open, held, released, watching, unmatched, read } (throws when Ramp
 * doesn't answer)
 */
export async function runRamp(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensureRampSchema(env.DB);
  const DB = env.DB;
  const iso = new Date(now).toISOString();
  const bills = await openRampBills(env, { fetchImpl });
  const st = await readState(DB, STATE_KEY);
  const connectedAt = st.connectedAt || iso;
  if (!st.connectedAt) await writeState(DB, STATE_KEY, { connectedAt });
  const watching = now - Date.parse(connectedAt) < WATCH_MS;
  const rows = new Map(((await DB.prepare('SELECT * FROM ramp_holds').all()).results || []).map((r) => [r.ramp_id, rowOf(r)]));
  const jtBills = ((await DB.prepare('SELECT id, vendor, cents, number, date, account_id FROM spend_bills WHERE account_id IS NOT NULL AND created_at >= ?')
    .bind(new Date(now - 240 * DAY).toISOString()).all().catch(() => ({ results: [] }))).results || [])
    .map((b) => ({ id: b.id, vendor: b.vendor, cents: b.cents, number: b.number, date: b.date, accountId: b.account_id }));
  const vendors = ((await DB.prepare('SELECT jt_id, name FROM vendors WHERE jt_id IS NOT NULL').all().catch(() => ({ results: [] }))).results || [])
    .map((v) => ({ jtId: v.jt_id, name: v.name }));

  const out = { open: bills.length, held: 0, released: 0, watching: 0, unmatched: 0, read: 0 };
  const docsOf = new Map();   // one JobTread read per vendor per run
  const readDocs = async (accountId) => {
    if (!docsOf.has(accountId)) {
      out.read++;
      docsOf.set(accountId, await billDocs(env, accountId, { now, fetchImpl }).catch((e) => ({ error: e.message })));
    }
    return docsOf.get(accountId);
  };
  const seen = new Set();
  const failed = [];
  for (const rb of bills) {
    seen.add(rb.id);
    const row = rows.get(rb.id);
    const base = { vendor: rb.vendor, cents: rb.cents, invoice: rb.invoice, status: rb.status };
    // Someone took the site's hold off in Ramp: theirs from now on, never held again
    if (row?.state === 'held' && rb.status !== 'ON_HOLD') { await letGo(env, row, base, { now }); continue; }
    if (row?.state === 'override') { await putRow(DB, rb.id, base, now); continue; }
    // A hold a person made in Ramp, or a bill already paying: not the site's to change
    if (row?.state !== 'held' && !HOLDABLE.has(rb.status)) {
      if (row) await putRow(DB, rb.id, base, now);
      continue;
    }
    const m = row?.accountId ? { accountId: row.accountId, jtBillId: row.jtBillId } : matchRampBill(rb, jtBills, vendors);
    if (!m) {
      out.unmatched++;
      if (row?.state !== 'unmatched') await putRow(DB, rb.id, { ...base, state: 'unmatched', checkedAt: iso }, now);
      continue;
    }
    const due = !row || ['new', 'unmatched'].includes(row.state) || (row.state === 'watch' && !watching)
      || !row.checkedAt || now - Date.parse(row.checkedAt) > RECHECK_MS;
    if (!due || (!docsOf.has(m.accountId) && docsOf.size >= READS_PER_RUN)) {
      if (row?.state === 'watch') out.watching++;
      continue;
    }
    const docs = await readDocs(m.accountId);
    if (docs.error) continue;   // JobTread didn't answer: as it was, until the next run
    if (docs.ok) {
      if (row?.state === 'held') {
        try { await releaseOne(env, { ...row, ...base, ...m }, { now, fetchImpl }); out.released++; } catch (e) { failed.push(`release ${rb.vendor}: ${e.message}`); }
      } else await putRow(DB, rb.id, { ...base, ...m, state: 'clear', reason: null, checkedAt: iso }, now);
      continue;
    }
    if (row?.state === 'held') { await putRow(DB, rb.id, { ...base, checkedAt: iso }, now); continue; }
    if (watching) {
      await putRow(DB, rb.id, { ...base, ...m, state: 'watch', reason: holdReason(docs.vendor.name, docs), checkedAt: iso }, now);
      out.watching++;
      continue;
    }
    await putRow(DB, rb.id, { ...base, ...m, checkedAt: iso }, now);
    try { await holdOne(env, rb, m, docs, { now, fetchImpl }); out.held++; } catch (e) { failed.push(`hold ${rb.vendor}: ${e.message}`); }
  }
  if (failed.length) out.failed = failed;
  // Held bills Ramp no longer lists as unpaid (paid by hand, archived): the note and the Slack card go
  for (const r of rows.values()) {
    if (seen.has(r.rampId) || !['held', 'watch', 'clear', 'unmatched'].includes(r.state)) continue;
    if (r.state === 'held') {
      if (r.noteId) await pave(env.JOBTREAD_GRANT_KEY, { updateComment: { $: { id: r.noteId, isPinned: false } } }).catch(() => null);
      await slackResolved(env, `ramp:${r.rampId}`, slackCard({ icon: '✅', title: `${r.vendor}: Ramp bill closed` }), { summary: 'Ramp no longer lists it as unpaid.' }).catch(() => null);
    }
    await putRow(DB, r.rampId, { state: 'gone' }, now);
  }
  if (watching && !st.watchPostedAt) {
    // Once every unpaid bill has been read (a dozen vendors a run), say what goes on hold and when
    const after = new Map(((await DB.prepare('SELECT ramp_id, state FROM ramp_holds').all()).results || []).map((r) => [r.ramp_id, r.state]));
    const read = (b) => ['watch', 'clear', 'unmatched', 'override'].includes(after.get(b.id));
    if (bills.filter((b) => HOLDABLE.has(b.status)).every(read)) await postWatchList(env, { connectedAt, now });
  }
  return out;
}

/** A person took the site's hold off in Ramp (or paid it): the note and the Slack card go, and the site leaves it be */
async function letGo(env, row, base, { now }) {
  if (row.noteId) await pave(env.JOBTREAD_GRANT_KEY, { updateComment: { $: { id: row.noteId, isPinned: false } } }).catch(() => null);
  await slackResolved(env, `ramp:${row.rampId}`, slackCard({ icon: '✅', title: `${row.vendor}: hold taken off in Ramp` }), {
    summary: 'Someone took the hold off in Ramp, so the site leaves this bill alone.',
  }).catch(() => null);
  return putRow(env.DB, row.rampId, { ...base, state: 'override', reason: null, releasedAt: new Date(now).toISOString() }, now);
}

/** Once, in the watching day: what the site will hold, and when */
async function postWatchList(env, { connectedAt, now }) {
  await writeState(env.DB, STATE_KEY, { watchPostedAt: new Date(now).toISOString() });
  const watch = ((await env.DB.prepare("SELECT * FROM ramp_holds WHERE state = 'watch'").all()).results || []).map(rowOf);
  if (!watch.length) return;
  const starts = new Date(Date.parse(connectedAt) + WATCH_MS).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const byVendor = new Map();
  for (const r of watch) byVendor.set(r.vendor, [...(byVendor.get(r.vendor) || []), r]);
  const lines = [...byVendor.entries()].slice(0, 15).map(([v, list]) => `• ${v}: ${list.length > 1 ? `${list.length} bills, ` : ''}${dollars(list.reduce((n, r) => n + (r.cents || 0), 0))}`);
  await slackIssue(env, 'ramp:watch', slackCard({
    icon: '👀', title: `Ramp is connected: ${watch.length} ${watch.length === 1 ? 'bill' : 'bills'} go on hold ${starts}`,
    lead: `These vendors have no current W-9 or insurance in JobTread, so from then their Ramp bills wait until they send them (each is emailed). A store or anyone who needs no papers: set their Documents field to “Not needed” in JobTread before then.\n${lines.join('\n')}${byVendor.size > 15 ? `\n…and ${byVendor.size - 15} more in Job Costs → Bills` : ''}`,
    buttons: [{ label: 'Open bills', url: ADMIN }],
  }), { title: 'Ramp holds', kind: 'attention', area: 'finance' }).catch(() => null);
}

/** For Job Costs → Bills and the automations map */
export async function rampView(env) {
  if (!rampConfigured(env)) return { connected: false };
  await ensureRampSchema(env.DB);
  const st = await readState(env.DB, STATE_KEY);
  const rows = ((await env.DB.prepare("SELECT * FROM ramp_holds WHERE state IN ('held', 'watch', 'unmatched') ORDER BY updated_at DESC LIMIT 200").all()).results || []).map(rowOf);
  return {
    connected: true, at: st.lastRunAt || null, error: st.error || null,
    startsAt: st.connectedAt ? new Date(Date.parse(st.connectedAt) + WATCH_MS).toISOString() : null,
    held: rows.filter((r) => r.state === 'held'), watch: rows.filter((r) => r.state === 'watch'), unmatched: rows.filter((r) => r.state === 'unmatched'),
  };
}

/** From the vendors heartbeat: one run, its error kept for the automations map. Never throws. */
export async function maybeRunRamp(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!rampConfigured(env) || !env.DB) return null;
  try {
    const report = await runRamp(env, { now, fetchImpl });
    const at = new Date(now).toISOString();
    await writeState(env.DB, STATE_KEY, { lastRunAt: at, lastRun: report, error: report.failed ? { at, error: `Ramp: ${report.failed.join(' · ')}`.slice(0, 300) } : null });
    return report;
  } catch (e) {
    await writeState(env.DB, STATE_KEY, { lastRunAt: new Date(now).toISOString(), error: { at: new Date(now).toISOString(), error: String(e.message).slice(0, 300) } }).catch(() => null);
    return { error: e.message };
  }
}
