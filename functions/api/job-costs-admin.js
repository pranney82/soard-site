/**
 * /api/job-costs-admin — Admin → Job Costs (see ./_spend.js, ./_job-ledger.js)
 * ===========================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                → ledgers, recent charges, rules, cost codes, jobs, health
 * GET ?setup=1       → plus Mercury's accounts, cards, categories and the card limits each would get
 * POST { action: 'sort', chargeId, bucket: 'job'|'store'|'operating', jobId?, costCodeId?, remember? }
 * POST { action: 'code', chargeId, costCodeId, remember? }
 * POST { action: 'rule-save', name, kind: 'code'|'store'|'operating', costCodeId? }
 * POST { action: 'rule-delete', vendor }
 * POST { action: 'setup', accountBuckets?, cardBuckets?, categories? }   (charges are sorted again)
 * POST { action: 'caps', on: true|false }
 * POST { action: 'recode-split', billId, lines: [{ costCodeId, amount }] }
 * POST { action: 'recode-apply', billIds: [...] }
 * POST { action: 'recode-undo', billId }
 * GET ?budget=<jobId>[&rooms=n] → that job's suggested budget (from close-outs) next to its JobTread budget
 * POST { action: 'budget-add', jobId, lines: [{ codeId, cents }] }   lines for codes the job has none of yet
 * POST { action: 'bill-decide', billId, decision: 'approved'|'rejected', note? }   as the signed-in person
 * POST { action: 'bill-settings', approvers?, bigApprovers?, bigBillCents?, dailyCapCents?, payMode?, payFromAccountId?, startsOn? }
 * POST { action: 'bill-link', billId, recipientId }   the Mercury recipient a bill's vendor is paid as
 * POST { action: 'bill-retry', billId }             only after a payment failed
 * POST { action: 'docs-settings', glOccurrence?, glAggregate?, workersComp?, elEachAccident?, renewDays? }
 *        the minimums a vendor's certificate is held to (./_vendors.js)
 * POST { action: 'docs-preview' }                    "Send it to me": the request a vendor gets, to the signed-in person
 * POST { action: 'odd-clear', key }                  a person looked: it's fine
 */

import {
  readConfig, writeConfig, readCharges, readRules, saveRule, deleteRule, placeCharge, cachedJobs, proposeCaps,
  mercuryCategories, ensureSpendSchema, rebuildAll,
} from './_spend.js';
import { readLedgers, costCodes } from './_job-ledger.js';
import { mercuryConfigured, readState, listAccounts, cardholders, WEBHOOK_KEY } from './_mercury.js';
import { readRecode, proposeSplit, applySplit, undoSplit } from './_jobtread-bills.js';
import { agentKey } from './_spend-agent.js';
import { BUCKETS } from './_spend-match.js';
import { readCloseouts, budgetFor, addBudgetLines, codeHistory } from './_job-closeout.js';
import { billQueue, readBillPayConfig, saveBillPayConfig, decideBill, payBill, cachedRecipients, ensureBillPaySchema } from './_bill-pay.js';
import { readOdd, clearOdd } from './_spend-odd.js';
import { readDocSettings, saveDocSettings, sendPreview } from './_vendors.js';
import { rampView } from './_ramp.js';
import { DEFAULT_RECEIPT_INBOX } from './_spend-receipts.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const DAY = 24 * 3600 * 1000;

async function health(env) {
  const [cfg, hook, agent, fields, closeouts, billRuns] = await Promise.all([readConfig(env.DB), readState(env.DB, WEBHOOK_KEY), readState(env.DB, 'agent'), readState(env.DB, 'jt-fields'), readState(env.DB, 'closeouts'), readState(env.DB, 'bill-pay-runs')]);
  return {
    mercury: mercuryConfigured(env),
    jobtread: !!env.JOBTREAD_GRANT_KEY,
    slack: !!env.SLACK_BOT_TOKEN,
    webhook: { registered: !!hook.id, at: hook.at || null, lastEventAt: hook.lastEventAt || null, error: cfg.webhookError || null },
    lastCatchUp: cfg.lastCatchUp || null,
    lastCatchUpError: cfg.lastCatchUpError || null,
    lastRun: cfg.lastRun || null,
    lastRebuildAt: cfg.lastRebuildAt || null,
    lastWriteError: cfg.lastWriteError || null,
    lastWriteOkAt: cfg.lastWriteOkAt || null,
    lastCaps: cfg.lastCaps || null,
    agentUsedAt: agent.lastUsedAt || null,
    jobFieldsError: fields.error || null,
    closeouts: { error: closeouts.error || null, historyLeft: closeouts.historyLeft ?? null, lastAt: closeouts.lastAt || null },
    billPay: { error: billRuns.error || null, last: billRuns.last || null },
  };
}

async function everything(env, { setup = false } = {}) {
  await ensureSpendSchema(env.DB);
  // The agents' key exists from the first visit, so it can go in their instructions
  await agentKey(env.DB);
  await ensureBillPaySchema(env.DB);
  const [closeouts, bills, billPay, odd, vendorDocs, ramp] = await Promise.all([
    readCloseouts(env.DB),
    billQueue(env).catch(() => []),
    readBillPayConfig(env.DB),
    readOdd(env.DB),
    readDocSettings(env.DB),
    rampView(env).catch((e) => ({ connected: true, error: { error: e.message } })),
  ]);
  const [ledgers, charges, rules, codes, jobs, recode, cfg, h] = await Promise.all([
    readLedgers(env.DB),
    readCharges(env.DB, { sinceIso: new Date(Date.now() - 90 * DAY).toISOString(), limit: 800 }),
    readRules(env.DB),
    costCodes(env).catch(() => []),
    cachedJobs(env).catch(() => []),
    readRecode(env.DB),
    readConfig(env.DB),
    health(env),
  ]);
  const out = {
    ledgers, charges, rules, codes,
    jobs: jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, staff: j.staff })),
    recode,
    config: { accountBuckets: cfg.accountBuckets || {}, cardBuckets: cfg.cardBuckets || {}, categories: cfg.categories || {}, caps: cfg.caps === 'on', receiptInbox: cfg.receiptInbox || DEFAULT_RECEIPT_INBOX },
    health: h,
    closeouts,
    history: codeHistory(closeouts),
    bills,
    billPay,
    vendorDocs,
    ramp,
    odd,
  };
  if (setup && mercuryConfigured(env)) {
    const [accounts, cards, categories, caps] = await Promise.all([
      listAccounts(env).catch((e) => ({ error: e.message })),
      cardholders(env).then((m) => [...m.values()]).catch((e) => ({ error: e.message })),
      mercuryCategories(env).catch((e) => ({ error: e.message })),
      proposeCaps(env).catch(() => []),
    ]);
    Object.assign(out, { accounts, cards, categories, caps });
  }
  // The vendors bills are paid to, for linking a bill whose name matches none (or several)
  if ((setup || bills.some((b) => b.approval?.payError)) && mercuryConfigured(env)) {
    out.recipients = await cachedRecipients(env).then((l) => l.map((r) => ({ id: r.id, name: r.name, hasBank: r.hasBank, hasW9: r.hasW9 }))).catch(() => []);
  }
  return out;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  try {
    const url = new URL(request.url);
    const budgetJob = url.searchParams.get('budget');
    if (budgetJob) {
      if (!/^[\w-]{6,64}$/.test(budgetJob)) return fail('Which job?');
      return ok({ budget: await budgetFor(env, budgetJob, { rooms: url.searchParams.get('rooms') }), codes: await costCodes(env).catch(() => []) });
    }
    return ok(await everything(env, { setup: url.searchParams.get('setup') === '1' }));
  } catch (e) {
    return fail(e.message, 500);
  }
}

const bucketMap = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {})
  .filter(([k, v]) => /^[\w-]{6,64}$/.test(k) && BUCKETS.includes(v)));

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  let b = {};
  try { b = await request.json(); } catch { return fail('Send JSON'); }
  const by = context.data?.userEmail || 'admin';
  try {
    switch (b.action) {
      case 'sort':
        await placeCharge(env, String(b.chargeId), { bucket: b.bucket, jobId: b.jobId, ...(b.costCodeId !== undefined ? { costCodeId: b.costCodeId } : {}), remember: !!b.remember, by });
        break;
      case 'code':
        await placeCharge(env, String(b.chargeId), { costCodeId: b.costCodeId || null, remember: !!b.remember, by });
        break;
      case 'rule-save':
        await saveRule(env.DB, { name: b.name, kind: b.kind, costCodeId: b.costCodeId || null, by });
        break;
      case 'rule-delete':
        await deleteRule(env.DB, String(b.vendor || ''));
        break;
      case 'setup': {
        const patch = {};
        if (b.accountBuckets) patch.accountBuckets = bucketMap(b.accountBuckets);
        if (b.cardBuckets) patch.cardBuckets = bucketMap(b.cardBuckets);
        if (b.receiptInbox !== undefined) patch.receiptInbox = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.receiptInbox)) ? String(b.receiptInbox).trim().toLowerCase() : null;
        if (b.categories) patch.categories = Object.fromEntries(Object.entries(b.categories).filter(([k, v]) => BUCKETS.includes(k) && (v === null || /^[\w-]{6,64}$/.test(v))));
        // Read Mercury's last 30 days again with the new setup (people's own picks stay)
        await writeConfig(env.DB, { ...patch, caughtUpTo: null, lastRunAt: null });
        break;
      }
      case 'caps':
        await writeConfig(env.DB, { caps: b.on ? 'on' : 'off', lastCaps: null });
        break;
      case 'recode-split': {
        const r = await proposeSplit(env.DB, String(b.billId || ''), b.lines, { by, codes: await costCodes(env) });
        if (!r.ok) return fail(r.error);
        break;
      }
      case 'recode-apply': {
        const ids = (Array.isArray(b.billIds) ? b.billIds : []).slice(0, 25);
        const results = [];
        for (const id of ids) results.push({ billId: id, ...(await applySplit(env, String(id), { by })) });
        // The ledgers show the new codes right away
        context.waitUntil(rebuildAll(env).catch(() => null));
        return ok({ results, ...(await everything(env)) });
      }
      case 'recode-undo': {
        const r = await undoSplit(env, String(b.billId || ''), { by });
        if (!r.ok) return fail(r.error);
        context.waitUntil(rebuildAll(env).catch(() => null));
        break;
      }
      case 'budget-add': {
        const jobId = String(b.jobId || '');
        if (!/^[\w-]{6,64}$/.test(jobId)) return fail('Which job?');
        const r = await addBudgetLines(env, jobId, (Array.isArray(b.lines) ? b.lines : []).slice(0, 60));
        context.waitUntil(rebuildAll(env).catch(() => null));
        return ok({ added: r.added.length, skipped: r.skipped, budget: await budgetFor(env, jobId) });
      }
      case 'bill-decide': {
        const r = await decideBill(env, String(b.billId || ''), { decision: b.decision, from: by, note: b.note || null, via: 'admin' });
        if (!r.ok) return fail(r.error, 403);
        break;
      }
      case 'bill-settings':
        await saveBillPayConfig(env.DB, b);
        break;
      case 'bill-link': {
        const billId = String(b.billId || '');
        const recipientId = String(b.recipientId || '');
        if (!/^[\w-]{6,64}$/.test(billId) || !/^[\w-]{6,64}$/.test(recipientId)) return fail('Pick the recipient');
        await env.DB.prepare('INSERT INTO bill_approvals (bill_id, state, recipient_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(bill_id) DO UPDATE SET recipient_id = excluded.recipient_id, pay_error = NULL, updated_at = excluded.updated_at')
          .bind(billId, 'waiting', recipientId, new Date().toISOString()).run();
        break;
      }
      case 'bill-retry': {
        const billId = String(b.billId || '');
        await env.DB.prepare("UPDATE bill_approvals SET pay_state = NULL, pay_error = NULL WHERE bill_id = ? AND pay_state = 'failed'").bind(billId).run();
        const r = await payBill(env, billId);
        if (!r.ok) return fail(r.error);
        break;
      }
      case 'docs-settings':
        await saveDocSettings(env.DB, b);
        break;
      case 'docs-preview': {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(by || '')) return fail('Sign in with your SOARD email to get the preview');
        const r = await sendPreview(env, by);
        return ok({ sent: by, url: r.url });
      }
      case 'odd-clear':
        await clearOdd(env, String(b.key || ''), { by });
        break;
      default:
        return fail('Unknown action');
    }
    return ok(await everything(env, { setup: ['setup', 'caps', 'bill-settings', 'bill-link'].includes(b.action) }));
  } catch (e) {
    return fail(e.message, 500);
  }
}
