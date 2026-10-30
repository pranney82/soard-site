/**
 * /api/insurance-audit-admin — Admin → Job Costs → Insurance audit (public/admin/insurance-audit.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route; a change must come from
 * the admin itself (_middleware.js). See ./_insurance-audit.js. Two audits,
 * each on its own policy's term: workers' comp ('wc-2026', from April 11) and
 * liability ('gl-2025', from November 21).
 *
 * GET ?policy=wc|gl                   → { success, audit, terms }   that policy's current term (default: workers' comp)
 * GET ?term=<id>                      → { success, audit, terms }   one of the terms shown (a bare year is workers' comp)
 * GET ?term=<id>&download=csv         → that audit's spreadsheet
 * GET ?term=<id>&download=packet      → that audit's packet for the auditor (PDF)
 * POST { action: 'call', term, key, jtId?, name, reason }   a person's call on a payee (CALLS, or 'clear') → { success, audit, terms }
 * POST { action: 'asking', on }      emails asking vendors and agents for W-9s and certificates on or off → { success, asking }
 * Every answer with an audit also has asking: { on, by, at, held } (held: why nobody is emailed right now, or null)
 */
import { auditFor, auditCsv, auditPacket, saveCall, term, termOf, termsShown, todayEastern, POLICIES } from './_insurance-audit.js';
import { readDocSettings, saveDocSettings, asksOnHold } from './_vendors.js';

const headers = { 'Cache-Control': 'no-store' };
const ok = (body = {}) => Response.json({ success: true, ...body }, { headers });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status, headers });

async function askingOf(env) {
  const s = await readDocSettings(env.DB);
  return { on: !!s.asking, by: s.askingBy || null, at: s.askingAt || null, held: await asksOnHold(env) };
}

/** The term asked for, when it's one shown; else the policy's current term → id or null */
function termIdOf(v, policy, now = Date.now()) {
  const ids = termsShown(now).map((t) => t.id);
  const id = v ? term(v)?.id : termOf(todayEastern(now), POLICIES[policy] ? policy : 'wc').id;
  return id && ids.includes(id) ? id : null;
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const p = new URL(context.request.url).searchParams;
    const id = termIdOf(p.get('term'), p.get('policy'));
    if (!id) return fail('Pick one of the terms shown');
    const audit = await auditFor(env, id, { waitUntil: context.waitUntil?.bind(context) });
    const name = `SOARD ${POLICIES[audit.term.policy].file} audit ${audit.term.start} to ${audit.term.end}`;
    if (p.get('download') === 'csv') {
      return new Response(auditCsv(audit), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'X-Content-Type-Options': 'nosniff' } });
    }
    if (p.get('download') === 'packet') {
      const bytes = await auditPacket(env, audit);
      return new Response(bytes, { headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"`, 'X-Content-Type-Options': 'nosniff' } });
    }
    return ok({ audit, terms: termsShown(), asking: await askingOf(env) });
  } catch (e) {
    if (e.status && e.status < 500) return fail(e.message, e.status);
    console.error('[insurance-audit-admin] get', e.message);
    return fail(e.message || 'Couldn’t put the audit together just now', 500);
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  let b;
  try { b = await context.request.json(); } catch { return fail('Send that again'); }
  try {
    if (b.action === 'asking') {
      await saveDocSettings(env.DB, { asking: b.on === true, by: context.data?.userEmail || 'admin' });
      return ok({ asking: await askingOf(env) });
    }
    if (b.action !== 'call') return fail('Unknown action');
    const id = termIdOf(b.term, null);
    if (!id) return fail('Pick one of the terms shown');
    await saveCall(env.DB, { key: String(b.key || ''), jtId: b.jtId ? String(b.jtId).slice(0, 64) : null, name: b.name || '', reason: b.reason, by: context.data?.userEmail || 'admin' });
    return ok({ audit: await auditFor(env, id), terms: termsShown(), asking: await askingOf(env) });
  } catch (e) {
    if (e.status && e.status < 500) return fail(e.message, e.status);
    console.error('[insurance-audit-admin]', e.message);
    return fail(e.message || 'That didn’t work', 500);
  }
}
