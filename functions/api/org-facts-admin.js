/**
 * /api/org-facts-admin (Cloudflare Access, staff) — SOARD's facts checked against the IRS's list, its W-9 and its
 * Board Manual (./_org-facts.js), for Site Config → Organization & contact
 *
 * GET                       → { ok, check }: what the IRS's list, the W-9 and the Board Manual say. Site Config works
 *                             out what doesn't match from what's typed (../../public/admin/org-facts-shared.js)
 * POST { action: 'check' }  → the same, read again now (Check again: a new W-9, or to be sure)
 * POST { action: 'refresh' } → what's kept compared with what's saved now, nothing read again: Site Config sends it
 *                             after a save on Organization & contact, so Slack's post turns ✅ as soon as it matches
 *
 * A board member never gets here: the middleware lets them reach the board page's routes only.
 */

import { readCheck, checkOrgFacts } from './_org-facts.js';

// What Site Config needs, nothing more (never the Slack post's reference)
const shown = (c) => (c ? {
  at: c.at || null,
  irs: c.irs ? { ein: c.irs.ein || '', state: c.irs.state || '', found: c.irs.found ?? null, record: c.irs.record || null, date: c.irs.date || '', readAt: c.irs.readAt || null, error: c.irs.error || '' } : null,
  w9: c.w9 ? { title: c.w9.title || '', read: c.w9.read || null, unreadable: c.w9.unreadable || '', readAt: c.w9.readAt || null } : null,
  manual: c.manual || null,
} : null);

export async function onRequestGet({ env }) {
  try {
    return Response.json({ ok: true, check: shown(await readCheck(env.DB)) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestPost({ env, request }) {
  let body = {};
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Expected JSON' }, { status: 400 }); }
  if (body.action !== 'check' && body.action !== 'refresh') return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  try {
    return Response.json({ ok: true, check: shown(await checkOrgFacts(env, body.action === 'check' ? { force: true } : { steps: 0 })) });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
