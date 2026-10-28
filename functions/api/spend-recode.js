/**
 * /api/spend-recode — the DataX Receipt Processor's recode mode
 * ===========================================================================
 * Public, with the agent key (./_spend-agent.js). Nothing here changes
 * JobTread: proposals wait for a person to press Apply in the admin.
 *
 * GET  → { bills: [{ billId, jobName, vendor, amount, date }] } still waiting for a split
 * POST { billId, lines: [{ costCodeId, amount, name? }] } → { ok } | { ok: false, error }
 */

import { agentGate } from './_spend-agent.js';
import { readRecode, proposeSplit } from './_jobtread-bills.js';
import { costCodes } from './_job-ledger.js';

export async function onRequestGet({ env, request }) {
  const stop = await agentGate(env, request);
  if (stop) return stop;
  const list = (await readRecode(env.DB)).filter((r) => r.state === 'waiting');
  return Response.json({ ok: true, bills: list.slice(0, 50).map((r) => ({ billId: r.billId, jobName: r.jobName, vendor: r.vendor, amount: r.cents / 100, date: r.date })), remaining: list.length });
}

export async function onRequestPost({ env, request }) {
  const stop = await agentGate(env, request);
  if (stop) return stop;
  let body = {};
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Send JSON' }, { status: 400 }); }
  const codes = await costCodes(env).catch(() => []);
  const r = await proposeSplit(env.DB, String(body.billId || ''), body.lines, { by: 'datax', codes });
  return Response.json(r, { status: r.ok ? 200 : 400 });
}
