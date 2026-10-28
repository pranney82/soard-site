/**
 * GET /api/spend-hint?amount=123.45&date=2026-10-27&vendor=Home%20Depot
 * ===========================================================================
 * For the DataX Receipt Processor: the Mercury charge a receipt most likely
 * belongs to, and the job the site already placed it on. Public, with the
 * agent key (./_spend-agent.js).
 *
 * → { ok, match: null | { chargeId, bucket, jobId, jobName, how, costCodeId, cardholder } }
 * `bucket`: job, store (Sunny & Ranney) or operating; only a job charge
 * becomes a JobTread bill. `how`: staff (a person picked it), person (the
 * cardholder's only job), build (the only job being built), bill (already
 * billed: don't bill again).
 */

import { agentGate } from './_spend-agent.js';
import { readCharges, cachedJobs } from './_spend.js';
import { vendorLikeness } from './_spend-match.js';

const DAY = 24 * 3600 * 1000;

export async function onRequestGet({ env, request }) {
  const stop = await agentGate(env, request);
  if (stop) return stop;
  const url = new URL(request.url);
  const cents = Math.round(Number(url.searchParams.get('amount')) * 100);
  const date = Date.parse(url.searchParams.get('date') || '');
  const vendor = url.searchParams.get('vendor') || '';
  if (!(cents > 0) || !Number.isFinite(date)) return Response.json({ ok: false, error: 'amount and date are needed' }, { status: 400 });
  try {
    const charges = await readCharges(env.DB, { sinceIso: new Date(date - 10 * DAY).toISOString(), limit: 2000 });
    const near = charges
      .filter((c) => c.cents === cents && Math.abs(Date.parse(c.createdAt) - date) < 8 * DAY)
      .map((c) => ({ c, score: vendorLikeness(vendor, c.vendor) * 10 - Math.abs(Date.parse(c.createdAt) - date) / DAY }))
      .sort((a, b) => b.score - a.score);
    const best = near[0]?.c;
    if (!best || (near.length > 1 && vendorLikeness(vendor, best.vendor) < 0.5)) return Response.json({ ok: true, match: null });
    const job = best.jobId ? (await cachedJobs(env)).find((j) => j.id === best.jobId) : null;
    return Response.json({
      ok: true,
      match: {
        chargeId: best.id, bucket: best.bucket, jobId: best.jobId, jobName: job?.name || null,
        how: best.billId ? 'bill' : best.jobHow, costCodeId: best.costCodeId, cardholder: best.email,
      },
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
