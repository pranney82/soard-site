/**
 * Scanned scoresheets, for Admin → Applications → Applicants → Scores
 * ===========================================================================
 * Behind Cloudflare Access (staff only, like the rest of the admin's APIs).
 * The reading, matching and saving are in ./_score-scans.js.
 *
 * GET ?year=2027                → { scans, waiting, saved, left, scorers, families, me }: the season's uploads, the sheets waiting on a person
 * GET ?image=<scan>&page=<n>     → that page's picture (private; never on the public /files/ route)
 * POST { start: { year, name, hash, pages, account?, scorer?, again?, resume? } } → { scan } or { duplicate }
 * POST { page: { scan, page, image (data: URL), text? } }               → { items, summaries }: one page read, what’s sure saved
 * POST { page: { scan, page, again: true } }                           → the same, for a page nobody could read, from its kept picture
 * POST { confirm: { scan, page, idx, account, evaluator, scores, override? } } → { item, summary }
 * POST { skip: { scan, page, idx } }                                    → { ok }
 * POST { unskip: { scan, page, idx } }                                  → { ok }: a sheet left out, back under Check these
 * POST { unsave: { scan, page, idx } }                                  → { item, summary, restored }: one saved sheet taken back off
 * POST { undo: { scan } }                                               → { restored, changed, summaries }
 */

import { seasonScans, pageImage, startScan, readPage, confirmItem, skipItem, unskipItem, unsaveItem, undoScan } from './_score-scans.js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status });

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const url = new URL(request.url);
  try {
    if (url.searchParams.has('image')) {
      const img = await pageImage(env, url.searchParams.get('image'), url.searchParams.get('page'));
      if (!img) return fail('Not found', 404);
      return new Response(img.body, { headers: { 'Content-Type': img.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return ok(await seasonScans(env.DB, url.searchParams.get('year'), { me: context.data?.userEmail || null }));
  } catch (e) {
    return fail(e.message, e.status || 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  let body = {};
  try { body = (await request.json()) || {}; } catch { /* empty */ }
  if (typeof body !== 'object' || Array.isArray(body)) body = {};
  const user = context.data?.userEmail || 'admin';
  const audit = (action, slug, changes) => logAudit(env.DB, { userEmail: user, action, entityType: 'applicant', entitySlug: slug, changes }).catch(() => {});
  try {
    if (body.start) {
      const out = await startScan(env.DB, body.start, { user });
      if (out.scan) await audit('scores-scanned', 'scores', { year: out.scan.year, file: String(body.start.name || '').slice(0, 120), pages: out.scan.pages });
      return ok(out);
    }
    if (body.page) {
      if (!env.AI) return fail('Workers AI is not bound', 500);
      return ok(await readPage(env, body.page, { user }));
    }
    if (body.confirm) {
      const out = await confirmItem(env, body.confirm, { user });
      await audit('scored', out.item.account, { total: out.summary?.total ?? null, from: 'scan', scorer: out.item.evaluator });
      return ok(out);
    }
    if (body.skip) return ok(await skipItem(env, body.skip, { user }));
    if (body.unskip) return ok(await unskipItem(env, body.unskip));
    if (body.unsave) {
      const out = await unsaveItem(env, body.unsave, { user });
      await audit('score-scan-taken-off', out.item.account || 'scores', { scorer: out.item.evaluator, restored: out.restored });
      return ok(out);
    }
    if (body.undo) {
      const out = await undoScan(env, body.undo.scan, { user });
      await audit('scores-scan-undone', 'scores', { scan: String(body.undo.scan || ''), restored: out.restored, changed: out.changed });
      return ok(out);
    }
    return fail('Nothing to do');
  } catch (e) {
    return fail(e.message, e.status || 500, e.card ? { card: e.card, code: e.code } : {});
  }
}
