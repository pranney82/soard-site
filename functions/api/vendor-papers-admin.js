/**
 * /api/vendor-papers-admin — Admin → Job Costs → W-9s & insurance (public/admin/vendor-papers.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route, staff only (a board
 * member's sign-in never reaches it), and a change must come from the admin
 * itself (_middleware.js). Every company SOARD pays, on jobs or not, with the
 * W-9s and certificates the site keeps for it (./_vendor-files.js, ./_vendors.js).
 *
 * GET                     → { success, list, facts, minimums }   every company, where it stands and what SOARD paid it in the
 *                                                                last year (JobTread bills; Ramp's bills and Mercury's payments
 *                                                                for a company off the jobs)
 * GET ?id=<id>            → { success, vendor }                  one company: its record, files and asks (when JobTread can't be
 *                                                                read, what the site keeps, said so with jobtreadDown)
 * GET ?file=<fileId>      → the file itself (a PDF opens in the browser's viewer, a photo shows; ?download=1 saves it).
 *                           Opening a W-9 (it has a tax ID on it) is written to the audit log, who and when
 * POST multipart: id, doc ('w9' | 'coi'), file (up to 3 for a certificate), pages<i> (a PDF's first pages as JPEGs)
 *                         → { success, result, vendor }          checked like one from their own page, kept either way
 * POST { action: 'set', id, w9?, gl?, wc?, docs?, base? }        a person's word, only on what's sent: W-9 on file, the dates,
 *                                                                "W-9 only" / "Not needed" (docs: null takes that off). base: the
 *                                                                values the page showed; one that changed since is a 409, never
 *                                                                overwritten
 * POST { action: 'add', name, email? }                           a company only on the site (paid, never on a job)
 * POST { action: 'edit', id, name?, email? }                     a site company's name or email; a JobTread vendor with no email:
 *                                                                one added to its JobTread contacts (an email it has is changed there)
 * POST { action: 'archive', id, archived }                       a site company out of the list, or back
 * POST { action: 'merge', id, jtId }                             a site company that is that JobTread vendor
 * POST { action: 'link', id }                                    their page's link, to send them yourself → { url }
 * POST { action: 'ask', id }                                     email them the request now → { sent: email }
 * Each file action says how the page showed the file (shownOn: its company, shownAs: its status): a file changed since
 * is a 409 with the company as it is now, never acted on
 * POST { action: 'file', fileId, status: 'checked' | 'look' }    a person looked at a file
 * POST { action: 'move-file', fileId, toId?, doc? }              a file on the wrong company, or filed as the wrong kind: what it
 *                                                                proved goes with it → { vendor, changed: { from, to } }
 * POST { action: 'remove-file', fileId }                         taken off (kept out of sight: never lost), and what it proved
 * POST { action: 'restore-file', fileId }                        a file taken off, put back as it was
 * Each POST but link answers { success, vendor } (the company after).
 */
import {
  readVendor, writePapers, relabel, staffUpload, docsState, readDocSettings, labelFor, readAsk, createLink, askVendor, isSiteVendor, OVERRIDES, jtVendorUrl,
  resolveAll, settleLook,
} from './_vendors.js';
import {
  ensurePapersSchema, allPapers, filesOf, readFile, fileObject, addSiteVendor, editSiteVendor, archiveSiteVendor, mergeIntoJobTread, setFileStatus,
  removeFile, restoreFile, moveFile, proofOff, proofOn, papersFacts, readPapers, likelySame, nameKeyOf, realDate, mergedInto, provenByPerson, lookedAt, handTyped, isEmail,
} from './_vendor-files.js';
import { fileHeaders } from '../files/[[path]].js';
import { logAudit } from './_audit.js';

const headers = { 'Cache-Control': 'no-store' };
const ok = (body = {}) => Response.json({ success: true, ...body }, { headers });
// Never 502: Cloudflare swaps a 502 body for its own error page
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status, headers });
const ID_RE = /^(s_[a-z0-9]{10,40}|[A-Za-z0-9]{6,40})$/;
const FILE_RE = /^vf_[a-z0-9]{10,40}$/;
const DAY = 86400e3;
const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
/** A record's change as History shows it ([{ field, from, to }], fields in words) */
const FIELD_WORDS = { w9: 'W-9 on file', gl: 'liability ends', wc: 'workers’ comp ends', docs: 'what they need', check: 'last certificate' };
const changeList = (was, patch) => Object.keys(patch).map((k) => ({ field: FIELD_WORDS[k] || k, from: was?.[k] ?? null, to: patch[k] ?? null }));
const recordOf = (p) => p && { w9: !!p.w9, gl: p.glExpires || null, wc: p.wcExpires || null, docs: p.docs || null, check: p.check || null };

/** A vendor's Slack cards after a person's change: "Check its file" goes once nothing waits on a person; all go once it's current */
async function settleCards(env, id, state) {
  if (state?.ok && !state.expiring) { await resolveAll(env, id, 'Sorted on the site (Job Costs → W-9s & insurance).').catch(() => null); return; }
  await settleLook(env, id);
}

const jtWords = (e) => (/JOBTREAD_GRANT_KEY|JobTread returned|fetch failed|network/i.test(String(e?.message || '')) ? 'JobTread can’t be reached right now' : 'JobTread didn’t answer');

/**
 * What the Documents column says: a file waiting on a person, an ask out, the dates; or a person's choice, which says
 * whether it's met ("W-9 only" with no W-9 yet is still Missing)
 */
function shownLabel(v, state, ask) {
  if (OVERRIDES.has(v.docs)) return state.ok ? v.docs : 'Missing';
  return labelFor(v, state, ask) || state.label;
}

/** Every company SOARD pays: JobTread's vendors (as the 4-hourly read has them) and the companies only on the site */
async function listAll(env, now = Date.now()) {
  await ensurePapersSchema(env.DB);
  const req = await readDocSettings(env.DB);
  const since = new Date(now - 365 * DAY).toISOString();
  const [cache, papers, files, asks, looks, billed, mercury] = await Promise.all([
    env.DB.prepare('SELECT jt_id, name, email, facts FROM vendors WHERE jt_id IS NOT NULL').all().then((r) => r.results || [], () => []),
    allPapers(env.DB),
    env.DB.prepare("SELECT vendor_id, COUNT(*) AS n, MAX(COALESCE(received_at, added_at)) AS last FROM vendor_files WHERE status != 'removed' GROUP BY vendor_id").all().then((r) => r.results || [], () => []),
    env.DB.prepare('SELECT jt_id, open, asked_at FROM vendor_asks').all().then((r) => r.results || [], () => []),
    env.DB.prepare("SELECT DISTINCT vendor_id FROM vendor_files WHERE status = 'look'").all().then((r) => r.results || [], () => []),
    // What SOARD paid each JobTread vendor in the last year: its bills in JobTread (not card buys, not denied)
    env.DB.prepare("SELECT account_id, SUM(cents) AS cents, MAX(date) AS last FROM spend_bills WHERE account_id IS NOT NULL AND charge_id IS NULL AND COALESCE(status, '') != 'denied' AND date >= ? GROUP BY account_id")
      .bind(since.slice(0, 10)).all().then((r) => r.results || [], () => []),
    // And each Mercury payee (payments out of Mercury, by the payee they went to)
    env.DB.prepare("SELECT counterparty_id AS id, counterparty AS name, SUM(-cents) AS cents, MAX(COALESCE(posted_at, created_at)) AS last FROM mercury_txns WHERE kind = 'outgoingPayment' AND cents < 0 AND COALESCE(posted_at, created_at) >= ? AND LOWER(COALESCE(status, '')) NOT IN ('failed', 'cancelled', 'canceled', 'reversed') GROUP BY counterparty_id, counterparty")
      .bind(since).all().then((r) => r.results || [], () => []),
  ]);
  const byId = new Map(papers.map((p) => [p.id, p]));
  const fileBy = new Map(files.map((f) => [f.vendor_id, f]));
  const askBy = new Map(asks.map((a) => [a.jt_id, { open: !!a.open, askedAt: a.asked_at }]));
  const lookSet = new Set(looks.map((l) => l.vendor_id));
  const billedBy = new Map(billed.map((b) => [b.account_id, { cents: b.cents || 0, last: b.last || null }]));
  const mercuryById = new Map(mercury.filter((m) => m.id).map((m) => [m.id, m]));
  const mercuryByName = new Map(mercury.map((m) => [nameKeyOf(m.name), m]));
  const paidOutside = (p) => {
    const m = (p?.payee?.mercury && mercuryById.get(p.payee.mercury)) || mercuryByName.get(nameKeyOf(p?.name)) || null;
    const last = [p?.payee?.last, m?.last && String(m.last).slice(0, 10)].filter(Boolean).sort().pop() || null;
    return { cents: (p?.payee?.cents12 || 0) + (m?.cents || 0), last };
  };
  const rowOf = (id, name, { jobs = 0, site = false, fields = null } = {}) => {
    const p = byId.get(id);
    const v = p ? { id, name: p.name || name, w9: p.w9, glExpires: p.glExpires, wcExpires: p.wcExpires, docs: p.docs }
      : { id, name, w9: !!fields?.w9, glExpires: fields?.gl || null, wcExpires: fields?.wc || null, docs: fields?.docs || null };
    const state = docsState(v, req, { now });
    const ask = askBy.get(id) || null;
    const f = fileBy.get(id);
    const paid = site ? paidOutside(p) : billedBy.get(id) || { cents: 0, last: null };
    return {
      id, name: v.name || name || '(no name)', site, jobs, w9: v.w9, gl: v.glExpires, wc: v.wcExpires, docs: v.docs, paid: paid.cents, lastPaid: paid.last,
      label: shownLabel(v, state, ask), need: OVERRIDES.has(v.docs) ? v.docs : null, ok: state.ok, expiring: state.expiring, staff: state.staff,
      files: f?.n || 0, lastFile: f?.last || null, look: lookSet.has(id), asked: ask?.open ? ask.askedAt : null,
      added: site ? p?.createdAt || null : null, archived: !!p?.archived && site,
    };
  };
  const list = [];
  for (const r of cache) {
    const facts = parseJson(r.facts);
    list.push(rowOf(r.jt_id, r.name, { jobs: (facts.jobs || []).length, fields: facts.fields || null }));
  }
  // Ones taken off the list come too: the list finds them by name (and shows them as off it), never under a tab
  for (const p of papers) if (p.site) list.push(rowOf(p.id, p.name, { site: true }));
  // Who SOARD pays most comes first; the rest by name
  list.sort((a, b) => (b.paid || 0) - (a.paid || 0) || a.name.localeCompare(b.name));
  return { list, minimums: req };
}

/** One company: its record, files, asks and links. When JobTread can't be read, what the site keeps (never nothing) */
async function oneVendor(env, id, now = Date.now()) {
  let v = null;
  let jobtreadDown = null;
  try {
    v = await readVendor(env, id, { now });
  } catch (e) {
    jobtreadDown = jtWords(e);
  }
  const papers = await readPapers(env.DB, id);
  if (!v) {
    // Not answered, or JobTread no longer has the vendor: the site's own record of them
    if (!papers && jobtreadDown) throw Object.assign(new Error(`${jobtreadDown}, and the site has nothing kept for them yet. Try again in a minute.`), { status: 503 });
    if (!papers) return null;
    v = { id, name: papers.name, email: papers.email, archived: papers.archived, w9: papers.w9, glExpires: papers.glExpires, wcExpires: papers.wcExpires, docs: papers.docs, check: papers.check, site: papers.site };
    if (!jobtreadDown && !papers.site) jobtreadDown = 'JobTread no longer has this vendor';
  }
  const req = await readDocSettings(env.DB);
  const state = docsState(v, req, { now });
  const ask = await readAsk(env.DB, v.id);
  const [all, cache, profile] = await Promise.all([
    filesOf(env.DB, v.id, { removed: true }),
    isSiteVendor(v.id) ? null : env.DB.prepare('SELECT facts FROM vendors WHERE jt_id = ?').bind(v.id).first().catch(() => null),
    env.DB.prepare('SELECT agent FROM vendor_profiles WHERE jt_id = ?').bind(v.id).first().catch(() => null),
  ]);
  const facts = parseJson(cache?.facts);
  const agent = parseJson(profile?.agent, null);
  const files = all.filter((f) => f.status !== 'removed');
  const fileOut = (f) => ({
    id: f.id, doc: f.doc, name: f.name, type: f.type, size: f.size, source: f.source, receivedAt: f.receivedAt, addedAt: f.addedAt, addedBy: f.addedBy,
    status: f.status, summary: f.summary, reading: f.reading, url: `/api/vendor-papers-admin?file=${f.id}`,
  });
  // A company found in Mercury or Ramp may be a JobTread vendor under a slightly different name: only strong likenesses
  let maybe = [];
  if (v.site) {
    const jt = (await env.DB.prepare('SELECT jt_id, name FROM vendors WHERE jt_id IS NOT NULL').all().catch(() => ({ results: [] }))).results || [];
    maybe = jt.filter((r) => likelySame(r.name, v.name)).slice(0, 3).map((r) => ({ id: r.jt_id, name: r.name }));
  }
  return {
    id: v.id, name: v.name, email: v.email || null, site: !!v.site, archived: !!v.archived, jobtreadDown,
    w9: v.w9, gl: v.glExpires, wc: v.wcExpires, docs: v.docs, check: v.check || null,
    label: shownLabel(v, state, ask), need: OVERRIDES.has(v.docs) ? v.docs : null, ok: state.ok, expiring: state.expiring, needs: state.needs, staff: state.staff,
    jobs: (facts.jobs || []).map((j) => ({ id: j.jobId, name: j.jobName, status: j.status })),
    ask: ask ? { open: ask.open, asks: ask.asks, askedAt: ask.askedAt } : null,
    agent: agent?.email ? { name: agent.name || '', email: agent.email, agency: agent.agency || '' } : null,
    payee: papers?.payee ? { mercury: papers.payee.mercury || null, ramp: papers.payee.ramp || null, cents12: papers.payee.cents12 || 0, last: papers.payee.last || null } : null,
    note: papers?.note || null, maybe,
    jobtread: v.site ? null : jtVendorUrl(v.id),
    files: files.map(fileOut),
    // Taken off: out of the record, kept, and put back with one click
    removed: all.filter((f) => f.status === 'removed').map(fileOut),
  };
}

/** The record as it stands (JobTread's fields when it answers, else the site's) */
async function current(env, id) {
  try {
    const v = await readVendor(env, id);
    if (v) return v;
  } catch { /* JobTread didn't answer: the site's own record */ }
  const p = await readPapers(env.DB, id);
  return p && { id, name: p.name, email: p.email, archived: p.archived, w9: p.w9, glExpires: p.glExpires, wcExpires: p.wcExpires, docs: p.docs, check: p.check, site: p.site };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const p = new URL(request.url).searchParams;
  try {
    if (p.has('file')) {
      const id = p.get('file');
      if (!FILE_RE.test(id || '')) return fail('Not a file', 400);
      const f = await readFile(env.DB, id);
      const obj = await fileObject(env, f);
      if (!obj) return fail('That file isn’t here any more', 404);
      // A W-9 has a tax ID on it: who opened or saved one, and when, is kept (once a minute per person, file and which;
      // the file viewer never fetches one for its strip or ahead of time, ./file-viewer.js `private`)
      if (f.doc === 'w9') {
        const by = context.data?.userEmail || null;
        const action = p.get('download') === '1' ? 'downloaded' : 'viewed';
        // Under the company it's on, by the company's name (History finds a company's W-9 views by it)
        const company = (await readPapers(env.DB, f.vendorId).catch(() => null))?.name || 'a company';
        const what = `${company}’s W-9 (${f.name})`.slice(0, 200);
        const seen = await env.DB.prepare("SELECT 1 FROM audit_log WHERE user_email = ? AND action = ? AND entity_type = 'vendor-file' AND entity_slug = ? AND entity_name = ? AND created_at > datetime('now', '-1 minute') LIMIT 1").bind(by || 'unknown', action, f.vendorId, what).first().catch(() => null);
        if (!seen) await logAudit(env.DB, { userEmail: by, action, entityType: 'vendor-file', entitySlug: f.vendorId, entityName: what });
      }
      // The stored name's ending is the file's real type, so a photo is never served (or viewed) as a PDF
      const h = fileHeaders(f.key, f.type);
      h.set('Cache-Control', 'private, no-store');
      const save = String(f.name || 'file').replace(/[^\w.\- ]/g, '_');
      h.set('Content-Disposition', `${p.get('download') === '1' ? 'attachment' : h.get('Content-Disposition')?.split(';')[0] || 'inline'}; filename="${save}"`);
      return new Response(obj.body, { headers: h });
    }
    if (p.has('id')) {
      const id = p.get('id');
      if (!ID_RE.test(id || '')) return fail('That isn’t a company here', 404);
      const vendor = await oneVendor(env, id).catch((e) => { if (e.status === 503) return { down: e.message }; throw e; });
      if (vendor?.down) return fail(vendor.down, 503);
      if (vendor) return ok({ vendor });
      const moved = await mergedInto(env.DB, id);
      return moved ? fail(`It was moved onto ${moved.name}, the same company in JobTread.`, 404, { movedTo: moved }) : fail('That company isn’t here any more', 404);
    }
    const { list, minimums } = await listAll(env);
    return ok({ list, minimums, facts: await papersFacts(env) });
  } catch (e) {
    console.error('[vendor-papers-admin] get', e.message);
    return fail('That couldn’t be read just now. Try again in a minute.', 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || null;
  try {
    // A file staff add
    if ((request.headers.get('Content-Type') || '').includes('multipart/form-data')) {
      const form = await request.formData();
      const id = String(form.get('id') || '');
      if (!ID_RE.test(id)) return fail('That isn’t a company here');
      const files = form.getAll('file');
      const pages = files.map((_, i) => form.getAll(`pages${i}`));
      const doc = String(form.get('doc') || '');
      let result;
      try {
        result = await staffUpload(env, id, { doc, files, pages, by }, {});
      } catch (e) {
        if (e.status && e.status < 500) throw e;
        if (/JobTread|JOBTREAD/.test(e.message)) return fail(`${jtWords(e)}, so the file wasn’t added. Try again in a minute.`, 503);
        throw e;
      }
      await settleCards(env, id, result.state);
      await logAudit(env.DB, { userEmail: by, action: 'created', entityType: 'vendor-file', entitySlug: id, entityName: `${doc === 'w9' ? 'W-9' : 'Certificate'}: ${result.file?.name || ''}`.slice(0, 200) });
      return ok({ result, vendor: await oneVendor(env, id) });
    }
    let body;
    try { body = await request.json(); } catch { return fail('Bad request'); }
    const action = String(body?.action || '');
    const id = String(body?.id || '');
    const needId = () => { if (!ID_RE.test(id)) throw Object.assign(new Error('That isn’t a company here'), { status: 400 }); };

    if (action === 'set') {
      needId();
      const v = await current(env, id);
      if (!v) return fail('That company isn’t here any more', 404);
      // Only what's sent changes; a value the same as now isn't a change at all
      const patch = {};
      if ('w9' in body && !!body.w9 !== !!v.w9) patch.w9 = !!body.w9;
      for (const [k, have, word] of [['gl', v.glExpires, 'Liability'], ['wc', v.wcExpires, 'Workers’ comp']]) {
        if (!(k in body)) continue;
        const d = body[k] || null;
        if (d !== null && !realDate(String(d))) return fail(`${word} needs a real date`);
        if (d !== (have || null)) patch[k] = d;
      }
      if ('docs' in body) {
        if (body.docs !== null && !OVERRIDES.has(body.docs)) return fail('What they need is a W-9 and insurance, a W-9 only, or nothing');
        if ((body.docs || null) !== (OVERRIDES.has(v.docs) ? v.docs : null)) patch.docs = body.docs;
      }
      if (!Object.keys(patch).length) return ok({ vendor: await oneVendor(env, v.id) });
      // Something changed it since the page showed it (a certificate came in, someone else saved): never written over
      const base = body.base && typeof body.base === 'object' ? body.base : null;
      const have = { w9: !!v.w9, gl: v.glExpires || null, wc: v.wcExpires || null, docs: OVERRIDES.has(v.docs) ? v.docs : null };
      const moved = base ? Object.keys(patch).filter((k) => k in base && (k === 'w9' ? !!base[k] : base[k] || null) !== have[k]) : [];
      if (moved.length) return fail(`That changed since you opened it (${moved.map((k) => ({ w9: 'the W-9', gl: 'liability', wc: 'workers’ comp', docs: 'what they need' }[k])).join(', ')}). It’s shown as it is now; make your change again.`, 409, { vendor: await oneVendor(env, v.id) });
      // A person said what a waiting file shows: the waiting file of that kind is looked at, and proves what they said
      // (it goes with that file). With no file waiting, what they typed is their own word (handTyped): it stays.
      const fromFile = {
        w9: !!patch.w9 && (await provenByPerson(env, v.id, 'w9', patch)) > 0,
        coi: !!(patch.gl || patch.wc) && (await provenByPerson(env, v.id, 'coi', patch)) > 0,
      };
      // Taking a person's choice off hands Documents back to what the record says
      if ('docs' in patch && patch.docs === null) patch.docs = 'Missing';
      await writePapers(env, null, v.id, patch, fetch, { by });
      await handTyped(env, v.id, Object.fromEntries(Object.entries(patch).filter(([k]) => !(k === 'w9' ? fromFile.w9 : (k === 'gl' || k === 'wc') && fromFile.coi))));
      const { state } = await relabel(env, v.id, { by });
      await settleCards(env, v.id, state);
      if (state?.ok) {
        const { releaseVendorHolds } = await import('./_bill-pay.js');
        await releaseVendorHolds(env, v.id).catch(() => 0);
      }
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'vendor-papers', entitySlug: v.id, entityName: v.name, changes: changeList(recordOf({ ...v, glExpires: v.glExpires, wcExpires: v.wcExpires }), patch) });
      return ok({ vendor: await oneVendor(env, v.id) });
    }

    if (action === 'add') {
      try {
        const r = await addSiteVendor(env, { name: body.name, email: body.email || null, by });
        if (r.made || r.back) await logAudit(env.DB, { userEmail: by, action: r.made ? 'created' : 'updated', entityType: 'vendor-papers', entitySlug: r.id, entityName: `${r.back ? 'Back on the list: ' : ''}${String(body.name || '')}`.slice(0, 120) });
        return ok({ vendor: await oneVendor(env, r.id), made: r.made, back: r.back });
      } catch (e) {
        if (e.jtId) return fail(e.message, 409, { jtId: e.jtId });
        throw e;
      }
    }

    if (action === 'edit') {
      needId();
      // A JobTread vendor's email is on its JobTread contacts: one typed here goes there as its main contact
      if (!isSiteVendor(id)) {
        const email = String(body.email || '').trim().toLowerCase();
        if (!isEmail(email)) return fail('Check the email address.', 400, { field: 'email' });
        const v = await readVendor(env, id).catch((e) => { throw Object.assign(new Error(`${jtWords(e)}, so it wasn’t added. Try again in a minute.`), { status: 503 }); });
        if (!v) return fail('That company isn’t here any more', 404);
        if (v.email) return fail(`Their email is ${v.email}, on their JobTread contacts. Change it in JobTread.`, 409, { vendor: await oneVendor(env, id) });
        const { addMainEmail } = await import('./_coi-backfill.js');
        const r = await addMainEmail(env, id, email);
        if (!r.added) return fail(r.agent ? 'That’s their insurance agent’s email. Add the company’s own.' : 'That email is on their JobTread contacts already.', 409, { field: 'email' });
        await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'vendor-papers', entitySlug: id, entityName: `${v.name}: ${email} added to JobTread`.slice(0, 120) });
        return ok({ vendor: await oneVendor(env, id) });
      }
      await editSiteVendor(env, id, { name: body.name, email: body.email });
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'vendor-papers', entitySlug: id, entityName: String(body.name || '').slice(0, 120) });
      return ok({ vendor: await oneVendor(env, id) });
    }

    if (action === 'archive') {
      needId();
      const p = await archiveSiteVendor(env, id, body.archived !== false);
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'vendor-papers', entitySlug: id, entityName: `${p.archived ? 'Archived' : 'Back'}: ${p.name}`.slice(0, 120) });
      return ok({ vendor: await oneVendor(env, id) });
    }

    if (action === 'merge') {
      needId();
      const jtId = String(body.jtId || '');
      if (!ID_RE.test(jtId) || isSiteVendor(jtId)) return fail('Pick the JobTread vendor');
      const jt = await readVendor(env, jtId).catch(() => null);
      if (!jt) return fail('JobTread has no such vendor, or can’t be reached right now', 404);
      // The site company's Slack cards are done: it's the JobTread vendor from now on (its asks row goes with it)
      await resolveAll(env, id, `Moved onto ${jt.name} (the same company in JobTread).`).catch(() => null);
      const merged = await mergeIntoJobTread(env, id, jtId);
      // JobTread's fields show what the two had together, and Documents says where that leaves them
      await writePapers(env, null, jtId, { w9: merged.w9, gl: merged.glExpires, wc: merged.wcExpires, docs: merged.docs, check: merged.check }, fetch, { by });
      await relabel(env, jtId, { by });
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'vendor-papers', entitySlug: jtId, entityName: `Moved ${id} onto ${jt.name}` });
      return ok({ vendor: await oneVendor(env, jtId) });
    }

    // An archived company's link would open "a company we no longer have on file"
    const offList = (v) => (v.archived ? `${v.name} is ${v.site ? 'off the list' : 'archived in JobTread'}. ${v.site ? 'Put it back on the list first.' : 'Unarchive it there first.'}` : null);

    if (action === 'link') {
      needId();
      const v = await current(env, id);
      if (!v) return fail('That company isn’t here any more', 404);
      if (offList(v)) return fail(offList(v), 409);
      const link = await createLink(env.DB, v.id, { by: `staff:${by}` });
      return ok({ url: link.url, expiresAt: link.expiresAt });
    }

    if (action === 'ask') {
      needId();
      const v = await readVendor(env, id).catch((e) => { throw Object.assign(new Error(`${jtWords(e)}, so the email didn’t go. Try again in a minute.`), { status: 503 }); });
      if (!v) return fail('That company isn’t here any more', 404);
      if (offList(v)) return fail(offList(v), 409);
      const state = docsState(v, await readDocSettings(env.DB));
      if (state.ok && !state.expiring) return fail(OVERRIDES.has(v.docs) && v.docs === 'Not needed' ? 'Nothing is asked of them' : 'They have everything they need');
      if (!v.email) return fail(v.site ? 'Add their email first' : 'There’s no email on their JobTread contacts. Add one there first.');
      // Someone at SOARD pressed it: it goes now, whether or not the site's own asking is on
      const r = await askVendor(env, v, state, { why: 'staff', staffSend: true });
      if (!r.ok) return fail(r.held || 'The email didn’t send');
      if (!OVERRIDES.has(v.docs) && !state.ok) await writePapers(env, null, v.id, { docs: 'Requested' }, fetch, { by }).catch(() => null);
      await logAudit(env.DB, { userEmail: by, action: 'sent', entityType: 'vendor-papers', entitySlug: v.id, entityName: `Asked ${v.email}` });
      return ok({ sent: v.email, vendor: await oneVendor(env, v.id) });
    }

    if (action === 'file' || action === 'remove-file' || action === 'restore-file' || action === 'move-file') {
      const fileId = String(body.fileId || '');
      if (!FILE_RE.test(fileId)) return fail('That isn’t a file here');
      const f = await readFile(env.DB, fileId);
      if (!f) return fail('That file isn’t here any more', 404);
      // A page left open acts only on the file as it showed it: on that company, as it was then. Someone may have
      // moved it, taken it off or looked at it since; the page then shows it as it is now.
      const shownOn = body.shownOn ? String(body.shownOn) : null;
      const shownAs = body.shownAs ? String(body.shownAs) : null;
      if (!shownOn || !shownAs) return fail('Reload the page and try again.', 409);
      if (shownOn !== f.vendorId || shownAs !== f.status) {
        return fail(`${f.name} changed since you opened this page (someone ${f.status === 'removed' ? 'took it off' : shownOn !== f.vendorId ? 'moved it' : 'changed it'}). It’s shown as it is now.`, 409, { vendor: await oneVendor(env, shownOn).catch(() => null) });
      }
      if (action === 'file' && f.status === 'removed') return fail('That file was taken off. Put it back first.', 409);
      let at = f.vendorId;
      // What the file proved goes with it: off the company it leaves, onto the one it's on now (./_vendor-files.js)
      let from = {};
      let to = {};
      let what = 'Looked at';
      if (action === 'file') {
        if (body.status === 'look') await setFileStatus(env, fileId, 'look');
        else await lookedAt(env, fileId);
      }
      else if (action === 'remove-file') {
        what = 'Taken off';
        await removeFile(env, fileId);
        from = await proofOff(env, f);
      } else if (action === 'restore-file') {
        what = 'Put back';
        to = proofOn(await restoreFile(env, fileId));
      } else {
        const toId = body.toId ? String(body.toId) : null;
        const doc = body.doc ? String(body.doc) : null;
        if (toId && (!ID_RE.test(toId) || !(await readPapers(env.DB, toId)) && !(await env.DB.prepare('SELECT 1 FROM vendors WHERE jt_id = ?').bind(toId).first()))) return fail('Pick the company it belongs to');
        const moved = await moveFile(env, fileId, { toId, doc });
        at = moved.file.vendorId;
        what = at !== f.vendorId ? 'Moved' : 'Relabeled';
        if (at !== f.vendorId || moved.file.doc !== f.doc) {
          from = await proofOff(env, f);
          to = proofOn(moved.file);
        }
      }
      const wasFrom = recordOf(await readPapers(env.DB, f.vendorId));
      const wasTo = at === f.vendorId ? null : recordOf(await readPapers(env.DB, at));
      // Dates only move later: the certificate's words go to JobTread's Insurance Check only when one of its dates does
      if ('check' in to) {
        const now = at === f.vendorId ? wasFrom : wasTo;
        const later = (k) => to[k] && (!(k in from ? from[k] : now?.[k]) || to[k] > (k in from ? from[k] : now?.[k]));
        if (!later('gl') && !later('wc')) delete to.check;
      }
      // From first, then to: a file relabeled on one company takes off what it was and adds what it is
      if (Object.keys(from).length) await writePapers(env, null, f.vendorId, from, fetch, { by });
      if (Object.keys(to).length) await writePapers(env, null, at, to, fetch, { by, forward: true });
      // "Needs a look" goes once nothing's waiting on a person any more (and comes for a file moved onto a company)
      for (const vid of [...new Set([f.vendorId, at])]) {
        if (!(await readPapers(env.DB, vid))) continue;
        const r = await relabel(env, vid, { by }).catch(() => null);
        await settleCards(env, vid, r?.state);
      }
      const changes = [...changeList(wasFrom, from), ...changeList(wasTo || wasFrom, to)];
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'vendor-file', entitySlug: at, entityName: `${what}: ${f.name}`.slice(0, 200), changes });
      return ok({ vendor: await oneVendor(env, f.vendorId), changed: { from, to } });
    }

    return fail('Not an action this page knows');
  } catch (e) {
    // A 503 says what didn't answer (JobTread), in words a person can act on
    if (e.status && (e.status < 500 || e.status === 503)) return fail(e.message, e.status, { field: e.field || null });
    console.error('[vendor-papers-admin]', e.message);
    return fail('That didn’t go through. Try again in a minute.', 500);
  }
}
