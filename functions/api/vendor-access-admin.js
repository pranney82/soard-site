/**
 * /api/vendor-access-admin — Admin → Partners → JobTread access
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                                          → { waiting, near, added, setAside, paired, lastRunAt, lastRun, lastError }
 * POST { setAside: { company, undo? } }        → "Not needed": the company isn't put on jobs (undo puts it back)
 * POST { settle: { partner, account } }        → "Same company": JobTread's vendor account is this partner
 * POST { settle: { partner, makeNew: true } }  → "Make a new one": the partner gets its own JobTread account
 * POST { contacts: { partner, people } }       → who to reach at a vendor (D1 partner_contacts, private)
 * POST { recheck: { company } }                → that company's jobs again, now
 * POST { unmatch: { partner } }                → "Not the same": not that JobTread vendor after all, and what the match did is taken back
 * POST { rename: { partner, name? } }          → the JobTread vendor takes the partner's name (or name: the old one, to undo)
 * POST { rolePick: { membership, role?, keep?, name } } → someone the roles sweep can't place: Trade Partner, or leave their role
 *                                                (neither: undo the pick). See ./_partner-roles.js
 * POST { twins: { a, b, same } }               → two JobTread vendor accounts listed as one company: the empty one is
 *                                                archived (same), or they're never put together again (one the site
 *                                                archived comes back)
 * Each POST but setAside and rename runs that company's part of the sync
 * straight away and answers { report, view }.
 *
 * See ./_vendor-access.js.
 */
import { adminView, setCompanyAside, settleAccount, syncVendorAccess, unmatchAccount, renameAccount, settleTwins } from './_vendor-access.js';
import { pickRole } from './_partner-roles.js';
import { saveContacts, grantForPartner } from './_sponsors.js';
import { logAudit } from './_audit.js';
import { nameKey } from '../../public/admin/partners-shared.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
// Never 502: Cloudflare swaps a 502 body for its own error page
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const COMPANY_RE = /^[a-z0-9]{1,200}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const ACCOUNT_RE = /^[A-Za-z0-9]{6,40}$/;

export async function onRequestGet({ env }) {
  if (!env.DB) return fail('DB not bound', 500);
  return ok(await adminView(env.DB));
}

async function partnerName(DB, slug) {
  const row = await DB.prepare('SELECT name, data FROM partners WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  try { return JSON.parse(row.data || '{}').name || row.name || slug; } catch { return row.name || slug; }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || null;
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const sync = async (company) => {
    const report = await syncVendorAccess(env, { only: company });
    return { report, view: await adminView(env.DB) };
  };
  const run = async (company) => ok(await sync(company));

  if (body?.setAside) {
    const { company, undo = false, name = null } = body.setAside;
    if (!COMPANY_RE.test(company || '')) return fail('Bad company');
    await setCompanyAside(env.DB, { company, name: typeof name === 'string' ? name.slice(0, 200) : null, undo: !!undo }, by);
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-access', entitySlug: company, entityName: undo ? 'Back on its jobs' : 'Not needed on jobs' });
    return ok({ view: await adminView(env.DB) });
  }

  if (body?.settle) {
    const { partner, account = null, makeNew = false } = body.settle;
    if (!SLUG_RE.test(partner || '') || (!makeNew && !ACCOUNT_RE.test(account || ''))) return fail('Bad choice');
    let settled;
    try { settled = await settleAccount(env.DB, { partner, account, makeNew: !!makeNew }); } catch (e) { return fail(e.message, 404); }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-vendor', entitySlug: partner, entityName: makeNew ? 'A new JobTread vendor' : 'Same as a JobTread vendor', changes: makeNew ? null : { account } });
    return run(nameKey(settled.name));
  }

  if (body?.contacts) {
    const { partner, people } = body.contacts;
    if (!SLUG_RE.test(partner || '')) return fail('Bad partner');
    const name = await partnerName(env.DB, partner);
    if (!name) return fail('That partner isn’t in the directory', 404);
    let saved;
    try { saved = await saveContacts(env.DB, partner, people, { by }); } catch (e) { return fail(e.message); }
    // Names only in the log: emails and phones stay in partner_contacts
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'partner-contacts', entitySlug: partner, entityName: 'Vendor contacts', changes: { people: saved.map((p) => p.name || 'unnamed') } });
    // A sponsor too: its kids' jobs get them as Sponsors, as a save in the kid editor does
    await grantForPartner(env, partner).catch(() => null);
    return run(nameKey(name));
  }

  if (body?.unmatch) {
    const { partner } = body.unmatch;
    if (!SLUG_RE.test(partner || '')) return fail('Bad choice');
    const name = await partnerName(env.DB, partner);
    if (!name) return fail('That partner isn’t in the directory', 404);
    let done;
    try { done = await unmatchAccount(env, { partner }, by); } catch (e) { return fail(e.message, /JobTread/.test(e.message) && !/matched/.test(e.message) ? 500 : 404); }
    // Names only: emails stay in partner_contacts
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-vendor', entitySlug: partner, entityName: 'Not the same as a JobTread vendor',
      changes: { account: done.accountName, offJobs: done.offJobs.map((o) => `${o.person}: ${o.page}`), fromPartners: done.fromPartners, fromJobTread: done.fromJobTread } });
    return ok({ ...(await sync(nameKey(name))), unmatched: done });
  }

  if (body?.rename) {
    const { partner, name = null } = body.rename;
    if (!SLUG_RE.test(partner || '') || (name != null && (typeof name !== 'string' || !name.trim() || name.length > 200))) return fail('Bad name');
    let done;
    try { done = await renameAccount(env, { partner, name }); } catch (e) { return fail(e.message, /JobTread:/.test(e.message) ? 500 : 404); }
    if (done.from !== done.to) await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-vendor', entitySlug: partner, entityName: 'Renamed in JobTread', changes: { from: done.from, to: done.to } });
    return ok({ renamed: done, view: await adminView(env.DB) });
  }

  if (body?.rolePick) {
    const { membership, role = null, keep = false, name = null } = body.rolePick;
    if (!ACCOUNT_RE.test(membership || '')) return fail('Bad choice');
    let pick;
    try { pick = await pickRole(env.DB, { membership, role: role || null, keep: !!keep, name: typeof name === 'string' ? name.slice(0, 120) : null }, by); } catch (e) { return fail(e.message); }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-roles', entityName: name || 'Someone in JobTread',
      changes: { pick: pick?.role || (pick?.keep ? 'Leave their role' : 'Undone') } });
    return ok({ view: await adminView(env.DB) });
  }

  if (body?.twins) {
    const { a, b, same = false } = body.twins;
    if (!ACCOUNT_RE.test(a || '') || !ACCOUNT_RE.test(b || '') || a === b) return fail('Bad choice');
    let done;
    try { done = await settleTwins(env, { a, b, same: !!same }, by); } catch (e) { return fail(e.message, /JobTread:/.test(e.message) ? 500 : 400); }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-vendor', entityName: same ? 'One company twice in JobTread' : 'Two companies in JobTread',
      changes: done.combined ? { archived: `${done.combined.archived} (the same as ${done.combined.kept})` } : done.back ? { back: done.back.drop.name } : null });
    const partner = done.combined?.partner || done.back?.partner;
    const name = partner ? await partnerName(env.DB, partner) : null;
    return name ? ok({ ...(await sync(nameKey(name))), twins: done }) : ok({ twins: done, view: await adminView(env.DB) });
  }

  if (body?.recheck) {
    if (!COMPANY_RE.test(body.recheck.company || '')) return fail('Bad company');
    return run(body.recheck.company);
  }
  return fail('Nothing to do');
}
