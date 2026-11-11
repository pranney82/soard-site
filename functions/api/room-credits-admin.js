/**
 * /api/room-credits-admin — who designed a room and who paid for it
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET ?record=<kid slug | community/<slug>>   → { room: { record, name, kinds: { designed, sponsored } }, last }
 *     each kind: { credits: [{ slug, name, gone, onRoom (null: couldn't tell) }], job, unknown: [values], others: [values], waiting, pending, held }
 * GET                                          → { byPartner: { [slug]: [{ record, name, year, kind }] }, unknown, held, last }
 * POST { set: { record, kind, partner, on, put?, sha? } } → a person picks (on) or takes off a credit: JobTread's field for a
 *                                                room with a job (a company picked that isn't on the room goes on, once,
 *                                                unless put: false), the record otherwise
 * POST { addBack: { record, kind, partner, sha? } } → a credited company that isn't on the makeover goes back on it now
 * POST { settle: { record, kind, use, sha? } }   → launch found JobTread and the website disagreeing: use 'jobtread' or 'website'
 * POST { sameAs: { value, partner, record?, sha? } } → a name JobTread uses is this partner (the one Same as list, logos too)
 * POST { notCompany: { value, undo?, record?, sha? } } → a name that isn't a company ("Family's Community Crowd Funding")
 * POST { merged: { from, fromName, into, check? } } → Partners → Merge into: its credits, names, pledges and people go to
 *                                                into, then it's deleted (check: only whether it can be)
 *
 * A POST naming a record answers with that page's credits and logos, and its new sha only when the sha the
 * editor sent was the page's before this change (otherwise behind: true, and the editor's Save will say
 * someone else changed the page, as it should). See ./_room-credits.js.
 */
import { setCredit, addBack, settleHeld, creditsView, setNotCompany, applyLink, mergeCredits, mergeCheck, pageOf, KINDS } from './_room-credits.js';
import { setLink } from './_kid-partners.js';
import { logAudit } from './_audit.js';
import { nameKey } from '../../public/admin/partners-shared.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
// Never 502: Cloudflare swaps a 502 body for its own error page
const fail = (error, status = 400) => Response.json({ success: false, error }, { status: status === 502 ? 500 : status });
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const RECORD_RE = /^(community\/)?[a-z0-9][a-z0-9-]{0,120}$/;
const SHA_RE = /^[A-Za-z0-9+/=_-]{1,200}$/;
const kindOk = (k) => Object.prototype.hasOwnProperty.call(KINDS, k);
const valueOk = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const shaOk = (s) => s == null || SHA_RE.test(s);

/**
 * Runs a change to a page and answers with the page as it is after it. The new sha only goes back to an
 * editor that had the version from just before: one that was already behind stays behind
 */
async function onPage(env, record, sha, change) {
  const before = record ? await rawPage(env.DB, record) : null;
  const out = await change();
  if (!record) return out;
  const after = await rawPage(env.DB, record);
  const page = await pageOf(env.DB, record);
  // Current only if the editor had the version from just before AND nothing but this change happened meanwhile:
  // the credits, and at most the one logo this put on (a status from JobTread, a logo the vendor sync took off,
  // or someone's save in between means the editor is behind, and its Save should say so)
  const rest = (d) => { const { designers: _d, sponsors: _s, partnerLogos: _l, ...r } = d || {}; return canon(r); };
  const urls = (d) => (d?.partnerLogos || []).map((l) => l?.url);
  const added = urls(after.data).filter((u) => !urls(before.data).includes(u));
  const logosOk = urls(before.data).every((u) => urls(after.data).includes(u)) && added.length <= (out?.put?.logo ? 1 : 0);
  const current = !!sha && sha === before.sha && rest(before.data) === rest(after.data) && logosOk;
  return { ...out, page: page.page, sha: current ? page.sha : null, behind: !current };
}
async function rawPage(DB, record) {
  const community = String(record).startsWith('community/');
  const raw = (await DB.prepare(`SELECT data FROM ${community ? 'community' : 'kids'} WHERE slug = ?`).bind(community ? record.slice(10) : record).first())?.data;
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { data, sha: raw ? (await pageOf(DB, record)).sha : null };
}
/** JSON with its keys in order, so two saves of the same data compare equal */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const record = new URL(request.url).searchParams.get('record');
  if (record && !RECORD_RE.test(record)) return fail('Bad record');
  try {
    return ok(await creditsView(env, { record }));
  } catch (e) {
    return fail(e.message, e.status || 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || null;
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  try {
    if (body?.set) {
      const { record, kind, partner, on, put = true, sha = null } = body.set;
      if (!RECORD_RE.test(record || '') || !kindOk(kind) || !SLUG_RE.test(partner || '') || typeof on !== 'boolean' || typeof put !== 'boolean' || !shaOk(sha)) return fail('Bad credit');
      const out = await onPage(env, record, sha, () => setCredit(env, { record, kind, partner, on, put }, by));
      return ok({ ...out, view: await creditsView(env, { record }) });
    }
    if (body?.addBack) {
      const { record, kind, partner, sha = null } = body.addBack;
      if (!RECORD_RE.test(record || '') || !kindOk(kind) || !SLUG_RE.test(partner || '') || !shaOk(sha)) return fail('Bad credit');
      const out = await onPage(env, record, sha, () => addBack(env, { record, kind, partner }, by));
      return ok({ ...out, view: await creditsView(env, { record }) });
    }
    if (body?.settle) {
      const { record, kind, use, sha = null } = body.settle;
      if (!RECORD_RE.test(record || '') || !kindOk(kind) || !['jobtread', 'website'].includes(use) || !shaOk(sha)) return fail('Bad settle');
      const out = await onPage(env, record, sha, () => settleHeld(env, { record, kind, use }, by));
      return ok({ ...out, view: await creditsView(env, { record }) });
    }
    if (body?.sameAs) {
      const { value, partner, record = null, sha = null } = body.sameAs;
      if (!valueOk(value) || !SLUG_RE.test(partner || '') || (record !== null && !RECORD_RE.test(record)) || !shaOk(sha)) return fail('Bad name');
      const out = await onPage(env, record, sha, async () => {
        await setLink(env.DB, { company: nameKey(value), partner });
        await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'room-credits', entitySlug: partner, entityName: 'Same as', changes: { value, partner } });
        // Every room whose JobTread field says it knows at once, and its page's copy follows (a settled name puts nobody on)
        await applyLink(env, { by: by || 'unknown' }).catch(() => null);
        return {};
      });
      return ok({ ...out, view: await creditsView(env, record ? { record } : {}) });
    }
    // Partners → Merge into: the old company's credits, names, pledges and people go to the other, then it's deleted,
    // in one step (check: only say whether it can be, changing nothing)
    if (body?.merged) {
      const { from, fromName = '', into, check = false } = body.merged;
      if (!SLUG_RE.test(from || '') || !SLUG_RE.test(into || '') || from === into || (fromName && !valueOk(fromName))) return fail('Bad merge');
      if (check) { await mergeCheck(env, { from, into }); return ok({ ok: true }); }
      return ok(await mergeCredits(env, { from, fromName, into }, by));
    }

    if (body?.notCompany) {
      const { value, undo = false, record = null, sha = null } = body.notCompany;
      if (!valueOk(value) || (record !== null && !RECORD_RE.test(record)) || !shaOk(sha)) return fail('Bad name');
      const out = await onPage(env, record, sha, async () => {
        await setNotCompany(env.DB, value, !undo);
        await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'room-credits', entitySlug: nameKey(value), entityName: 'Not a company', changes: { value, undo: !!undo } });
        return {};
      });
      return ok({ ...out, view: await creditsView(env, record ? { record } : {}) });
    }
  } catch (e) {
    return fail(e.message, e.status || 500);
  }
  return fail('Nothing to do');
}
