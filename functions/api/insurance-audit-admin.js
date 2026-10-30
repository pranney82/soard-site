/**
 * /api/insurance-audit-admin — Admin → Job Costs → Insurance audit (public/admin/insurance-audit.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route; a change must come from
 * the admin itself (_middleware.js). See ./_insurance-audit.js.
 *
 * GET ?term=<year>                    → { success, audit, terms }   the term starting April 11 of that year (default: now's)
 * GET ?term=<year>&download=csv       → the spreadsheet
 * GET ?term=<year>&download=packet    → the auditor's packet (PDF)
 * POST { action: 'call', term, key, jtId?, name, reason }   a person's call on a payee (CALLS, or 'clear') → { success, audit, terms }
 */
import { auditFor, auditCsv, auditPacket, saveCall, termOf, termsShown, todayEastern } from './_insurance-audit.js';

const headers = { 'Cache-Control': 'no-store' };
const ok = (body = {}) => Response.json({ success: true, ...body }, { headers });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status, headers });

function termIdOf(v, now = Date.now()) {
  const ids = termsShown(now).map((t) => t.id);
  const id = String(v || termOf(todayEastern(now)).id);
  return ids.includes(id) ? id : null;
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const p = new URL(context.request.url).searchParams;
    const id = termIdOf(p.get('term'));
    if (!id) return fail('Pick one of the terms shown');
    const audit = await auditFor(env, id, { waitUntil: context.waitUntil?.bind(context) });
    const name = `SOARD subcontractors ${audit.term.start} to ${audit.term.end}`;
    if (p.get('download') === 'csv') {
      return new Response(auditCsv(audit), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'X-Content-Type-Options': 'nosniff' } });
    }
    if (p.get('download') === 'packet') {
      const bytes = await auditPacket(env, audit);
      return new Response(bytes, { headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"`, 'X-Content-Type-Options': 'nosniff' } });
    }
    return ok({ audit, terms: termsShown() });
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
    if (b.action !== 'call') return fail('Unknown action');
    const id = termIdOf(b.term);
    if (!id) return fail('Pick one of the terms shown');
    await saveCall(env.DB, { key: String(b.key || ''), jtId: b.jtId ? String(b.jtId).slice(0, 64) : null, name: b.name || '', reason: b.reason, by: context.data?.userEmail || 'admin' });
    return ok({ audit: await auditFor(env, id), terms: termsShown() });
  } catch (e) {
    if (e.status && e.status < 500) return fail(e.message, e.status);
    console.error('[insurance-audit-admin]', e.message);
    return fail(e.message || 'That didn’t work', 500);
  }
}
