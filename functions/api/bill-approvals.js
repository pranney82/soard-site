/**
 * /api/bill-approvals — for the DataX Bill Approver agent (see ./_bill-pay.js)
 * ===========================================================================
 * Public, with the agent key (./_spend-agent.js), like /api/spend-hint.
 *
 * GET  → { ok, approvers, bills: [...] } the bills to email about now: never
 *        asked, or asked 3+ days ago with no answer. Each has vendor, number,
 *        amount owed, job, where the job and the bill's codes stand against
 *        budget, whether a second approval is needed, and the JobTread link.
 * POST { action: 'asked', billId, ref? }       the email went (ref: its message id)
 * POST { action: 'decide', billId, decision: 'approved'|'rejected', from, note? }
 *        `from` is the reply's sender; only a listed approver counts.
 */

import { agentGate } from './_spend-agent.js';
import { billsToAsk, markAsked, decideBill, readBillPayConfig } from './_bill-pay.js';

const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });

export async function onRequestGet({ env, request }) {
  const stop = await agentGate(env, request);
  if (stop) return stop;
  try {
    const [bills, cfg] = await Promise.all([billsToAsk(env), readBillPayConfig(env.DB)]);
    return Response.json({
      ok: true,
      approvers: cfg.approvers,
      secondApprovers: cfg.bigApprovers,
      secondApprovalAt: cfg.bigBillCents / 100,
      bills: bills.map((b) => ({
        billId: b.id, vendor: b.vendor, number: b.number, date: b.date, amount: b.owed / 100, total: b.cents / 100,
        job: b.jobName, jobBudget: b.job ? b.job.budget / 100 : null, jobForecast: b.job ? b.job.forecast / 100 : null,
        codes: b.codes.map((c) => ({ name: c.name, budget: c.budget / 100, forecast: c.forecast / 100 })),
        needsSecondApproval: b.big, alreadyApprovedBy: (b.approval.approvals || []).filter((a) => a.decision === 'approved').map((a) => a.by),
        timesAsked: b.approval.askedCount || 0, link: b.link,
      })),
    });
  } catch (e) {
    return fail(e.message, 500);
  }
}

export async function onRequestPost({ env, request }) {
  const stop = await agentGate(env, request);
  if (stop) return stop;
  let b = {};
  try { b = await request.json(); } catch { return fail('Send JSON'); }
  const billId = String(b.billId || '');
  if (!/^[\w-]{6,64}$/.test(billId)) return fail('billId is needed');
  try {
    if (b.action === 'asked') {
      await markAsked(env, billId, { ref: b.ref || null });
      return Response.json({ ok: true });
    }
    if (b.action === 'decide') {
      const r = await decideBill(env, billId, { decision: b.decision, from: b.from, note: b.note || null, via: 'email' });
      return r.ok ? Response.json({ ok: true, state: r.state }) : fail(r.error, 403);
    }
    return fail('Unknown action');
  } catch (e) {
    return fail(e.message, 500);
  }
}
