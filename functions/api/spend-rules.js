/**
 * GET /api/spend-rules — what the DataX Receipt Processor codes receipts with
 * ===========================================================================
 * Public, with the agent key (./_spend-agent.js). No amounts, no people:
 *
 *   { codes:  [{ id, name }]                  SOARD's JobTread cost codes
 *     rules:  [{ vendor, kind, costCodeId }]  kind 'code' (a makeover vendor and its
 *             code), 'store' (Sunny & Ranney) or 'operating' (running SOARD): only
 *             'code' vendors become JobTread bills
 *     jobs:   [{ id, name, status, address }] open jobs that are buying }
 */

import { agentGate } from './_spend-agent.js';
import { readRules, cachedJobs } from './_spend.js';
import { costCodes } from './_job-ledger.js';
import { BUYING_STATUSES } from './_spend-match.js';

export async function onRequestGet({ env, request }) {
  const stop = await agentGate(env, request);
  if (stop) return stop;
  try {
    const [codes, rules, jobs] = await Promise.all([costCodes(env), readRules(env.DB), cachedJobs(env)]);
    return Response.json({
      ok: true,
      codes: codes.map((c) => ({ id: c.id, name: c.name })),
      rules: rules.map((r) => ({ vendor: r.name, kind: r.kind, costCodeId: r.costCodeId })),
      jobs: jobs.filter((j) => BUYING_STATUSES.has(j.status)).map((j) => ({ id: j.id, name: j.name, status: j.status, address: j.address })),
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
