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
 * POST { rolePick: { membership, role?, keep?, name } } → someone the roles sweep can't place: Trade Partner or Design Partner, or leave a level
 *                                                (neither: undo the pick). See ./_partner-roles.js
 * POST { link: { partner, account } }          → this JobTread vendor account (any) is this partner ("Who are they?": their company)
 * POST { twins: { a, b, same } }               → two JobTread vendor accounts listed as one company: the empty one is
 *                                                archived (same), or they're never put together again (one the site
 *                                                archived comes back)
 * Each POST but setAside and rename runs that company's part of the sync
 * straight away and answers { report, view }.
 *
 * See ./_vendor-access.js.
 */
import { adminView, setCompanyAside, settleAccount, linkAccount, syncVendorAccess, unmatchAccount, renameAccount, settleTwins, takeOffJob, putBackJob, addToJob, makeoverView, setWatch } from './_vendor-access.js';
import { reconcileJob } from './_reveal-invites.js';
import { pickRole } from './_partner-roles.js';
import { saveContacts, readContacts } from './_sponsors.js';
import { grantForSponsor, followRoom, pageOf } from './_room-credits.js';
import { logAudit } from './_audit.js';
import { nameKey } from '../../public/admin/partners-shared.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
// Never 502: Cloudflare swaps a 502 body for its own error page
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const COMPANY_RE = /^[a-z0-9]{1,200}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const RECORD_RE = /^(community\/)?[a-z0-9][a-z0-9-]{0,120}$/;
const ACCOUNT_RE = /^[A-Za-z0-9]{6,40}$/;

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const record = request ? new URL(request.url).searchParams.get('record') : null;
  if (record === null) return ok(await adminView(env.DB));
  if (!RECORD_RE.test(record)) return fail('Bad page');
  try { return ok(await makeoverView(env, record)); } catch (e) { return fail(e.message || 'Couldn’t read that makeover', e.status === 409 ? 409 : 503); }
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

  // The JobTread side: only noting what it would do, or doing it
  if (body?.watch) {
    await setWatch(env, { on: body.watch.on === true }, by);
    return ok({ view: await adminView(env.DB) });
  }

  // A person took a company off this makeover, put them back, or added one: the page and the job, now, and the reveal invite right behind
  if (body?.takeOff || body?.putBack || body?.addToJob) {
    const { record, logos = [], partner = null, account = null, name = '', sha = null, who = [], undo = false } = body.takeOff || body.putBack || body.addToJob;
    if (!RECORD_RE.test(record || '')) return fail('Bad page');
    if (partner !== null && !SLUG_RE.test(partner)) return fail('Bad company');
    if (account !== null && !ACCOUNT_RE.test(account)) return fail('Bad company');
    if (!Array.isArray(logos) || logos.length > 20 || !logos.every((l) => typeof l?.url === 'string')) return fail('Bad logos');
    if ((body.takeOff || body.addToJob) && !partner && !account && !logos.length) return fail('Nothing to do');
    if (!Array.isArray(who) || who.length > 20 || !who.every((w) => typeof w === 'string')) return fail('Bad company');
    if (body.putBack && !who.length && !logos.length) return fail('Nothing to put back');
    const list = logos.map((l) => ({ url: l.url.slice(0, 500), name: String(l.name || '').slice(0, 200), at: Number(l.at) || 0 }));
    const label = String(name || '').slice(0, 200);
    try {
      const result = body.putBack ? await putBackJob(env, { record, who, logos: list, sha: sha || null, undo: undo === true }, by)
        : body.addToJob ? await addToJob(env, { record, logos: list, account, name: label }, by)
          : await takeOffJob(env, { record, partner, account, name: label, logos: list, sha: sha || null }, by);
      // Credited means on the makeover: a company taken off loses its Designed By / Monetary Sponsor credits here,
      // one put back or added gets back what went with it, now (the credits sweep is the backstop). The page's new
      // version goes back with them, but only to an editor that was in step (it sent the version it had, and got one back)
      // In step: the version it sent is the page's now (or the change it asked for answered with a new one)
      const inStep = !!result.sha || (!!sha && (await pageOf(env.DB, record).catch(() => null))?.sha === sha) || !!body.addToJob;
      const credits = await followRoom(env, { record }, by).catch((e) => ({ changed: [], error: e.message }));
      if (credits.changed?.length) {
        result.credits = { changed: credits.changed, page: credits.page || null };
        if (credits.sha && inStep) result.sha = credits.sha;
        else delete result.sha;
        result.behind = !inStep;
      } else if (credits.error) result.credits = { changed: [], error: credits.error };
      // The sweep's 5-minute check is the backstop
      if (result.jobId) context.waitUntil?.(reconcileJob(env, result.jobId, { wait: false }).catch(() => {}));
      return ok({ result });
    } catch (e) { return Response.json({ success: false, error: e.message || 'Couldn’t change that', unchanged: !!e.unchanged }, { status: e.status === 409 ? 409 : 503 }); }
  }

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
    // Who was there before, so only the ones just added go on the jobs it sponsors (one a person took off stays off)
    const had = new Set(((await readContacts(env.DB, [partner]))[partner] || []).map((c) => String(c.email || '').toLowerCase()).filter(Boolean));
    try { saved = await saveContacts(env.DB, partner, people, { by }); } catch (e) { return fail(e.message); }
    const added = saved.map((c) => String(c.email || '').toLowerCase()).filter((e) => e && !had.has(e));
    // Names only in the log: emails and phones stay in partner_contacts
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'partner-contacts', entitySlug: partner, entityName: 'Vendor contacts', changes: { people: saved.map((p) => p.name || 'unnamed') } });
    // A sponsor too: each new one goes on the open job of each room it sponsors, once
    await grantForSponsor(env, partner, { emails: added }).catch(() => null);
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

  if (body?.link) {
    const { partner, account } = body.link;
    if (!SLUG_RE.test(partner || '') || !ACCOUNT_RE.test(account || '')) return fail('Bad choice');
    let done;
    try { done = await linkAccount(env, { partner, account }, by); } catch (e) { return fail(e.message, /JobTread:/.test(e.message) ? 500 : 400); }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-vendor', entitySlug: partner, entityName: 'Same as a JobTread vendor',
      changes: { account: done.account.name, ...(done.archived ? { archived: done.archived } : {}) } });
    return ok({ ...(await sync(nameKey(done.name))), linked: done });
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
