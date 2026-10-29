/**
 * Monetary sponsors (Peter, Oct 28 2026)
 * ===========================================================================
 * The website is the source of truth for who pays for a kid's room: a
 * Partners record (name, logo, website), picked in Admin → Kids and kept on
 * the kid as sponsors: [partner slug]. The people to reach there live in D1
 * partner_contacts, never on the partner record: content is written into
 * builds and the repo is public.
 *
 * JobTread follows, job access first (Peter):
 *   1. each contact with an email is given access to the kid's open job with
 *      the Sponsor role, without an email from JobTread. Demo Day and reveal
 *      invites go to Sponsor users on the job, so that's how the sponsor gets
 *      them. A sponsor taken off the kid loses that access.
 *   2. the job's Monetary Sponsor field then mirrors who has the Sponsor
 *      role: their sponsors' names, blank until someone has access. A name
 *      typed there by hand that the site doesn't know is left alone (the
 *      editor offers it) until someone has the Sponsor role.
 * That runs when a kid is saved, when a sponsor's contacts are saved, and
 * every 10 minutes from the live hub's heartbeat. The sweep also takes in
 * what was done in JobTread: a Sponsor given access there, or a field naming
 * a Partner, becomes the kid's sponsor (the person becomes a contact), unless
 * staff took that sponsor off the kid. Kids only (community projects: not yet).
 *
 * A JobTread Sponsor user is a sponsor's when their company (the login's
 * account) has its name or is linked to it ("Same as" in Partners →
 * JobTread, no logo), their email is one of its contacts, or their email is
 * on its website's domain.
 */
import { pave, grantJobAccess, revokeJobAccess } from './_jt-access.js';
import { FIELD_MONETARY_SPONSOR } from './_demo-invites.js';
import { matchProject } from './_reveals.js';
import { readLinks, fetchOpenJobs } from './_kid-partners.js';
import { loadAllKids, linkJobs, saveRecord, requestDeploy, SYNC_USER } from './_kid-status.js';
import { logAudit } from './_audit.js';
import { nameKey, domainOf, cfId } from '../../public/admin/partners-shared.js';

export const SPONSOR_ROLE = 'Sponsor';
const MAX_PEOPLE = 5;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

const SCHEMA = [
  // people: JSON [{ name, email, phone, title }]; source: 'admin' or 'jobtread' (taken from the job's Sponsor users)
  'CREATE TABLE IF NOT EXISTS partner_contacts (partner TEXT PRIMARY KEY, people TEXT NOT NULL, source TEXT, updated_at TEXT, by TEXT)',
  // Each kid's job as last kept in step. field: what the Monetary Sponsor field said when the site last
  // wrote or matched it; dismissed: sponsors staff took off the kid, never taken back in from JobTread
  'CREATE TABLE IF NOT EXISTS sponsor_jobs (record TEXT PRIMARY KEY, job_id TEXT NOT NULL, open INTEGER NOT NULL DEFAULT 1, field TEXT, dismissed TEXT, synced_at TEXT, result TEXT)',
  'CREATE TABLE IF NOT EXISTS sponsor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];
export async function ensureSchema(DB) {
  for (const sql of SCHEMA) await DB.prepare(sql).run();
}

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const normEmail = (e) => String(e || '').trim().toLowerCase();
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
const nowIso = (now) => new Date(now).toISOString();

// ── Contacts ─────────────────────────────────────────────────────────

/** Contacts as they're kept: named or emailed, an email once, at most five */
export function cleanPeople(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const name = String(p?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const email = normEmail(p?.email).slice(0, 200);
    const phone = String(p?.phone || '').replace(/[^\d+()\-.\s x]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const title = String(p?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (email && !isEmail(email)) throw new Error(`“${p.email}” isn’t an email address`);
    if (!name && !email) continue;
    if (email && out.some((x) => x.email === email)) continue;
    out.push({ name, email, phone, title });
  }
  if (out.length > MAX_PEOPLE) throw new Error(`Up to ${MAX_PEOPLE} people per sponsor`);
  return out;
}

/** { [partner slug]: [people] }, for the slugs given (every partner without). Writes nothing, so sweeps can call it */
export async function readContacts(DB, slugs = null) {
  let rows = [];
  try { rows = (await DB.prepare('SELECT partner, people FROM partner_contacts').all()).results || []; } catch { return {}; } // no table until the first save
  const want = slugs ? new Set(slugs) : null;
  const out = {};
  for (const r of rows) if (!want || want.has(r.partner)) out[r.partner] = parse(r.people, []);
  return out;
}

export async function saveContacts(DB, partner, people, { by = null, source = 'admin', now = Date.now() } = {}) {
  await ensureSchema(DB);
  const clean = cleanPeople(people);
  if (!clean.length) await DB.prepare('DELETE FROM partner_contacts WHERE partner = ?').bind(partner).run();
  else {
    await DB.prepare('INSERT OR REPLACE INTO partner_contacts (partner, people, source, updated_at, by) VALUES (?, ?, ?, ?, ?)')
      .bind(partner, JSON.stringify(clean), source, nowIso(now), by).run();
  }
  return clean;
}

/** The partner one of its contacts belongs to (slug), or null */
export async function partnerForEmail(DB, email) {
  const e = normEmail(email);
  if (!isEmail(e)) return null;
  const all = await readContacts(DB);
  return Object.keys(all).find((slug) => all[slug].some((p) => p.email === e)) || null;
}

// ── Records ──────────────────────────────────────────────────────────

async function readPartners(DB) {
  const rows = (await DB.prepare('SELECT slug, data FROM partners').all()).results || [];
  return rows.map((r) => { const d = parse(r.data || '{}', {}); return { slug: r.slug, name: d.name || r.slug, website: d.website || '', logo: d.logo || '' }; });
}
async function readKid(DB, slug) {
  const row = await DB.prepare('SELECT slug, name, year, data FROM kids WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  const data = parse(row.data || '{}', {});
  return { slug: row.slug, name: data.name || row.name, year: row.year ?? data.year, data };
}
async function readRows(DB) {
  const rows = (await DB.prepare('SELECT * FROM sponsor_jobs').all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.record, r]));
}
const sponsorsOf = (kid) => [...new Set((Array.isArray(kid?.data?.sponsors) ? kid.data.sponsors : []).filter((s) => typeof s === 'string' && s))];
const chosenOf = (kid, partners) => sponsorsOf(kid).map((s) => partners.find((p) => p.slug === s)).filter(Boolean);

/** Sponsor logos first in the Partners chapter, in the sponsors' order; one already there (same image or name) moves up */
export function logosFirst(logos, sponsors) {
  const lead = [];
  for (const p of sponsors) {
    const there = logos.find((l) => !lead.includes(l) && ((p.logo && cfId(l.url) === cfId(p.logo)) || (nameKey(l.name) && nameKey(l.name) === nameKey(p.name))));
    if (there) lead.push(there);
    else if (p.logo) lead.push({ url: p.logo, name: p.name });
  }
  return [...lead, ...logos.filter((l) => !lead.includes(l))];
}

// ── JobTread ─────────────────────────────────────────────────────────

/**
 * The job, its Monetary Sponsor field, everyone outside staff with access
 * (people: with their ace id, to take one off) and every email on the job
 * (access, staff too, so nobody is added twice)
 */
export async function fetchSponsorJob(grantKey, jobId, fetchImpl = fetch) {
  const body = await pave(grantKey, {
    job: {
      $: { id: jobId }, id: {}, name: {}, closedOn: {},
      customFieldValues: { $: { where: [['customField', 'id'], '=', FIELD_MONETARY_SPONSOR] }, nodes: { value: {} } },
      aces: { $: { size: 50 }, nodes: { id: {}, membership: { id: {}, isInternal: {}, role: { name: {} }, account: { name: {} }, user: { name: {}, emailAddress: {} } } } },
    },
  }, fetchImpl);
  const job = body?.job;
  if (!job) throw new Error('JobTread has no such job');
  const aces = (job.aces?.nodes || []).filter((a) => a.membership?.user?.emailAddress);
  const people = aces.filter((a) => !a.membership.isInternal).map((a) => ({
    aceId: a.id, membershipId: a.membership.id, name: String(a.membership.user.name || '').trim() || null, email: normEmail(a.membership.user.emailAddress),
    role: a.membership.role?.name || null, company: String(a.membership.account?.name || '').trim() || null,
  }));
  const access = aces.map((a) => ({ email: normEmail(a.membership.user.emailAddress), role: a.membership.role?.name || null }));
  return { id: job.id, name: job.name, closedOn: job.closedOn || null, field: String(job.customFieldValues?.nodes?.[0]?.value || '').trim(), people, access };
}

const sameSite = (a, b) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
/** Is this JobTread person from that sponsor? (company name or "Same as" link, a contact's email, or the website's domain) */
export function fromSponsor(person, partner, { contacts = [], links = {} } = {}) {
  const ck = nameKey(person.company || '');
  if (ck && (ck === nameKey(partner.name) || links[ck] === partner.slug)) return true;
  if (person.email && contacts.some((c) => c.email === person.email)) return true;
  const web = partner.website ? domainOf(partner.website) : '';
  return sameSite(String(person.email || '').split('@')[1] || '', web);
}
/** Which partner a JobTread person is: one of the kid's sponsors first, then anyone in Partners */
function partnerOf(person, chosen, partners, contacts, links) {
  const is = (p) => fromSponsor(person, p, { contacts: contacts[p.slug] || [], links });
  return chosen.find(is) || partners.find(is) || null;
}
const sponsorUsers = (job) => job.people.filter((x) => x.role === SPONSOR_ROLE);

/**
 * What the Monetary Sponsor field mirrors: everyone with the Sponsor role on
 * the job, as their sponsor's name (the kid's sponsors first, in order), else
 * as JobTread names their company. Blank when nobody has it.
 */
export function mirrorText(job, chosen, partners, contacts = {}, links = {}) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  const on = sponsorUsers(job).map((x) => ({ x, p: partnerOf(x, chosen, partners, contacts, links) }));
  for (const c of chosen) if (on.some((o) => o.p?.slug === c.slug)) add(c.name);
  for (const o of on) add(o.p?.name || o.x.company || o.x.name || o.x.email);
  return names.join(' & ');
}

/**
 * The editor's view of a kid's sponsors against JobTread:
 * { job: { id, name, open, field, mirror, fieldOk }, sponsors: [{ slug, name, contacts,
 *   onJob: [person], otherRole: [person], missing: [contact] }], others: [person + partner] }
 * onJob: their people with the Sponsor role; otherRole: their people on the
 * job under another role (no sponsor invites, and not in the field); missing:
 * contacts with an email who aren't on the job; others: Sponsor users from
 * nobody chosen, with the Partner they match when there is one.
 */
export function sponsorView(job, chosen, contacts, links, partners = chosen) {
  const sponsors = chosen.map((p) => {
    const cs = contacts[p.slug] || [];
    const mine = job.people.filter((x) => fromSponsor(x, p, { contacts: cs, links }));
    return {
      slug: p.slug, name: p.name, contacts: cs,
      onJob: mine.filter((x) => x.role === SPONSOR_ROLE),
      otherRole: mine.filter((x) => x.role !== SPONSOR_ROLE),
      missing: cs.filter((c) => c.email && !job.access.some((x) => x.email === c.email)),
    };
  });
  const claimed = new Set(sponsors.flatMap((s) => [...s.onJob, ...s.otherRole].map((x) => x.email)));
  const mirror = mirrorText(job, chosen, partners, contacts, links);
  const strip = ({ aceId, membershipId, ...x }) => x;
  return {
    job: { id: job.id, name: job.name, open: !job.closedOn, field: job.field, mirror, fieldOk: job.field === mirror },
    sponsors: sponsors.map((s) => ({ ...s, onJob: s.onJob.map(strip), otherRole: s.otherRole.map(strip) })),
    others: sponsorUsers(job).filter((x) => !claimed.has(x.email)).map((x) => {
      const p = partnerOf(x, [], partners, contacts, links);
      return { ...strip(x), partner: p ? { slug: p.slug, name: p.name } : null };
    }),
  };
}

/**
 * Bring one kid's job in line, job access first, then the field. With adopt
 * (the sweep), what was done in JobTread comes in first. previous: the kid's
 * sponsors before a save (null when nothing was saved), so one taken off
 * loses its access and isn't taken back in. Returns { chosen, job, done }.
 */
async function reconcile(env, { kid, job, chosen, partners, contacts, links, row }, { previous = null, adopt = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  const done = { adopted: [], filled: [], granted: [], removed: [], wrote: null, problems: [] };
  chosen = [...chosen];
  const removedSlugs = previous ? previous.filter((s) => !chosen.some((p) => p.slug === s)) : [];
  const removedPartners = removedSlugs.map((s) => partners.find((p) => p.slug === s)).filter(Boolean);
  const dismissed = [...new Set([...parse(row?.dismissed || '[]', []), ...removedSlugs])].filter((s) => !chosen.some((p) => p.slug === s));

  // 0. From JobTread: someone given the Sponsor role there, or the field naming a Partner
  if (adopt) {
    for (const x of sponsorUsers(job)) {
      const p = partnerOf(x, chosen, partners, contacts, links);
      if (!p || chosen.some((c) => c.slug === p.slug) || dismissed.includes(p.slug)) continue;
      chosen.push(p);
      done.adopted.push({ slug: p.slug, name: p.name, from: x.name || x.email });
    }
    if (!chosen.length && job.field && !sponsorUsers(job).length) {
      const fk = nameKey(job.field);
      const p = fk && partners.find((pp) => nameKey(pp.name) === fk || links[fk] === pp.slug);
      if (p && !dismissed.includes(p.slug)) {
        chosen.push(p);
        done.adopted.push({ slug: p.slug, name: p.name, from: 'Monetary Sponsor' });
      }
    }
  }

  // 1. A sponsor's Sponsor users become its contacts: all of them when it has none, new ones when it just came in from JobTread
  for (const p of chosen) {
    const have = contacts[p.slug] || [];
    if (have.length && !done.adopted.some((a) => a.slug === p.slug)) continue;
    const theirs = sponsorUsers(job).filter((x) => fromSponsor(x, p, { contacts: have, links }) && !have.some((c) => c.email === x.email));
    if (!theirs.length) continue;
    try {
      contacts[p.slug] = await saveContacts(DB, p.slug, [...have, ...theirs.map((x) => ({ name: x.name, email: x.email }))].slice(0, MAX_PEOPLE), { by: SYNC_USER, source: 'jobtread', now });
      done.filled.push({ slug: p.slug, name: p.name, people: theirs.length });
    } catch (e) { done.problems.push(`Couldn’t keep ${p.name}’s contact: ${e.message}`); }
  }

  // 2. Job access (open jobs only): a sponsor taken off loses it, each contact of the sponsors gets it
  let touched = false;
  if (!job.closedOn) {
    const keeps = (x) => chosen.some((c) => fromSponsor(x, c, { contacts: contacts[c.slug] || [], links }));
    for (const p of removedPartners) {
      for (const x of sponsorUsers(job).filter((y) => fromSponsor(y, p, { contacts: contacts[p.slug] || [], links }) && !keeps(y))) {
        try {
          await revokeJobAccess(env, x.aceId, { fetchImpl });
          done.removed.push({ slug: p.slug, name: x.name || x.email, email: x.email });
          touched = true;
        } catch (e) { done.problems.push(`Couldn’t take ${x.name || x.email} off the job in JobTread: ${e.message}`); }
      }
    }
    const access = job.access.filter((m) => !done.removed.some((r) => r.email === m.email));
    for (const p of chosen) {
      for (const c of contacts[p.slug] || []) {
        if (!c.email || access.some((m) => m.email === c.email)) continue;
        try {
          const r = await grantJobAccess(env, job.id, c, SPONSOR_ROLE, { notify: false, access, fetchImpl, now });
          done.granted.push({ slug: p.slug, name: c.name || c.email, email: c.email, role: r.role, kept: !!r.kept });
          access.push({ email: c.email, role: r.role });
          touched = true;
        } catch (e) { done.problems.push(`Couldn’t give ${c.name || c.email} access in JobTread: ${e.message}`); }
      }
    }
  }
  if (touched) job = await fetchSponsorJob(key, job.id, fetchImpl);

  // 3. The field mirrors who has the Sponsor role. Blank only clears a name the site knows
  const mirror = mirrorText(job, chosen, partners, contacts, links);
  const known = new Set([...chosen, ...removedPartners].map((p) => p.name));
  const ours = !job.field || job.field === row?.field || job.field.split(' & ').every((n) => known.has(n.trim()));
  if (mirror !== job.field && (mirror || ours)) {
    try {
      await pave(key, { updateJob: { $: { id: job.id, customFieldValues: { [FIELD_MONETARY_SPONSOR]: mirror } } } }, fetchImpl);
      done.wrote = { from: job.field, to: mirror };
      job = { ...job, field: mirror };
    } catch (e) { done.problems.push(`Couldn’t set Monetary Sponsor in JobTread: ${e.message}`); }
  }

  const field = job.field === mirror ? mirror : (row?.field ?? null);
  await DB.prepare('INSERT OR REPLACE INTO sponsor_jobs (record, job_id, open, field, dismissed, synced_at, result) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(kid.slug, job.id, job.closedOn ? 0 : 1, field, JSON.stringify(dismissed), nowIso(now), JSON.stringify(done)).run();
  return { chosen, job, done };
}
const didSomething = (d) => !!(d.wrote || d.adopted.length || d.filled.length || d.granted.length || d.removed.length);

async function loadFor(env, slug) {
  const kid = await readKid(env.DB, slug);
  if (!kid) throw new Error('No kid with that name');
  const partners = await readPartners(env.DB);
  return { kid, partners, chosen: chosenOf(kid, partners) };
}
function checkJob(job, kid) {
  if (!matchProject(job.name, [kid], job.id)) throw new Error(`The JobTread job “${job.name}” isn’t ${kid.name}’s`);
}

/** GET: the kid's sponsors and what JobTread has, with nothing written */
export async function kidSponsorView(env, slug, jobId, { fetchImpl = fetch } = {}) {
  const { kid, partners, chosen } = await loadFor(env, slug);
  const contacts = await readContacts(env.DB);
  const bare = chosen.map((p) => ({ slug: p.slug, name: p.name, contacts: contacts[p.slug] || [] }));
  if (!jobId) return { sponsors: bare, jobtread: null };
  if (!env.JOBTREAD_GRANT_KEY) return { sponsors: bare, jobtread: null, jobtreadError: 'JobTread isn’t connected here' };
  const job = await fetchSponsorJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl);
  checkJob(job, kid);
  const view = sponsorView(job, chosen, contacts, await readLinks(env.DB), partners);
  return { sponsors: view.sponsors, jobtread: { ...view.job, others: view.others } };
}

/**
 * After a kid is saved: job access first (contacts of the sponsors added, a
 * sponsor taken off removed), then the Monetary Sponsor field mirrors it.
 * previous: the sponsors before the save. Returns the view plus what was done.
 */
export async function syncKidSponsor(env, { slug, jobId, previous = [] }, { by = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  if (!env.JOBTREAD_GRANT_KEY) throw new Error('JobTread isn’t connected here');
  const { kid, partners, chosen } = await loadFor(env, slug);
  const job = await fetchSponsorJob(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl);
  checkJob(job, kid);
  const [contacts, links, rows] = await Promise.all([readContacts(DB), readLinks(DB), readRows(DB)]);
  const r = await reconcile(env, { kid, job, chosen, partners, contacts, links, row: rows[slug] }, { previous, fetchImpl, now });
  if (didSomething(r.done)) await logAudit(DB, { userEmail: by, action: 'updated', entityType: 'jobtread-sponsor', entitySlug: slug, entityName: kid.name, changes: r.done });
  const view = sponsorView(r.job, r.chosen, contacts, links, partners);
  return { sponsors: view.sponsors, jobtread: { ...view.job, others: view.others }, ...r.done };
}

/**
 * Contacts saved for a sponsor: every open job of a kid it pays for (as far
 * as the last check told us the job) gets them, then its field mirrors it.
 * Returns { granted: [{ record, kid, name, email, role, kept }], problems }.
 */
export async function grantForPartner(env, partner, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  if (!env.JOBTREAD_GRANT_KEY) return { granted: [], problems: [] };
  const [partners, contacts, links, rows] = await Promise.all([readPartners(DB), readContacts(DB), readLinks(DB), readRows(DB)]);
  const granted = [];
  const problems = [];
  for (const row of Object.values(rows).filter((r) => r.open)) {
    const kid = await readKid(DB, row.record);
    if (!kid || !sponsorsOf(kid).includes(partner)) continue;
    try {
      const job = await fetchSponsorJob(env.JOBTREAD_GRANT_KEY, row.job_id, fetchImpl);
      const r = await reconcile(env, { kid, job, chosen: chosenOf(kid, partners), partners, contacts, links, row }, { fetchImpl, now });
      granted.push(...r.done.granted.map((g) => ({ record: kid.slug, kid: kid.name, ...g })));
      problems.push(...r.done.problems.map((p) => `${kid.name}: ${p}`));
    } catch (e) { problems.push(`${kid.name}: ${e.message}`); }
  }
  return { granted, problems };
}

// ── The sweep ────────────────────────────────────────────────────────
// Kid records are written while holding the kid-page lock the logo sweep
// (./_kid-partners.js) holds, so the two never write the same kid at once.
const LOCK_MS = 2 * 60 * 1000;
async function lockKidPages(DB) {
  const t = Date.now();
  try {
    await DB.prepare('CREATE TABLE IF NOT EXISTS kid_partner_lock (name TEXT PRIMARY KEY, until INTEGER NOT NULL)').run();
    const ins = await DB.prepare("INSERT OR IGNORE INTO kid_partner_lock (name, until) VALUES ('sync', ?)").bind(t + LOCK_MS).run();
    if (ins?.meta?.changes > 0) return true;
    const upd = await DB.prepare("UPDATE kid_partner_lock SET until = ? WHERE name = 'sync' AND until < ?").bind(t + LOCK_MS, t).run();
    return upd?.meta?.changes > 0;
  } catch { return false; }
}
const unlockKidPages = (DB) => DB.prepare("DELETE FROM kid_partner_lock WHERE name = 'sync'").run().catch(() => {});

async function readState(DB) {
  const row = await DB.prepare("SELECT value FROM sponsor_state WHERE key = 'state'").first();
  return parse(row?.value || '{}', {}) || {};
}
async function writeState(DB, patch) {
  const next = { ...(await readState(DB)), ...patch };
  await DB.prepare("INSERT OR REPLACE INTO sponsor_state (key, value) VALUES ('state', ?)").bind(JSON.stringify(next)).run();
  return next;
}
export const sponsorState = async (DB) => { try { return await readState(DB); } catch { return {}; } };

/**
 * Every kid with an open job: what was done in JobTread comes in, then job
 * access and the field follow the website. Returns [{ slug, name, ...done }]
 * for the kids where something happened.
 */
export async function syncSponsors(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const key = env.JOBTREAD_GRANT_KEY;
  const [jobs, kids, partners, contacts, links, rows] = await Promise.all([fetchOpenJobs(key, fetchImpl), loadAllKids(DB), readPartners(DB), readContacts(DB), readLinks(DB), readRows(DB)]);
  const linked = linkJobs(jobs, kids);
  const iso = nowIso(now);
  const out = [];
  let logos = false;
  for (const kid of kids) {
    const brief = linked.get(kid.slug);
    if (!brief) continue;
    try {
      const job = await fetchSponsorJob(key, brief.id, fetchImpl);
      const r = await reconcile(env, { kid, job, chosen: chosenOf(kid, partners), partners, contacts, links, row: rows[kid.slug] }, { adopt: true, fetchImpl, now });
      if (r.done.adopted.length) {
        if (!(await lockKidPages(DB))) { r.done.problems.push('The logo check was saving pages; it comes in at the next check'); }
        else {
          try {
            const fresh = (await readKid(DB, kid.slug)) || kid;
            const before = fresh.data;
            const sponsors = [...new Set([...sponsorsOf(fresh), ...r.done.adopted.map((a) => a.slug)])];
            const after = { ...before, sponsors, partnerLogos: logosFirst(before.partnerLogos || [], sponsors.map((s) => partners.find((p) => p.slug === s)).filter(Boolean)) };
            await saveRecord(env, 'kids', kid.slug, before, after, `Monetary sponsor from JobTread: ${kid.name} + ${r.done.adopted.map((a) => a.name).join(', ')}`, iso);
            if (JSON.stringify(after.partnerLogos) !== JSON.stringify(before.partnerLogos || [])) logos = true;
          } finally { await unlockKidPages(DB); }
        }
      }
      if (didSomething(r.done) || r.done.problems.length) {
        out.push({ slug: kid.slug, name: kid.name, ...r.done });
        if (didSomething(r.done)) await logAudit(DB, { userEmail: SYNC_USER, action: 'updated', entityType: 'jobtread-sponsor', entitySlug: kid.slug, entityName: kid.name, changes: r.done });
      }
    } catch (e) {
      out.push({ slug: kid.slug, name: kid.name, adopted: [], filled: [], granted: [], removed: [], wrote: null, problems: [e.message] });
    }
  }
  if (logos) await requestDeploy(env, now, 'Sponsor logos from JobTread').catch(() => {});
  const count = (k) => out.reduce((n, x) => n + (x[k]?.length || 0), 0);
  await writeState(DB, {
    lastRunAt: iso, lastError: null,
    last: { kids: [...linked.keys()].filter((s) => kids.some((k) => k.slug === s)).length, adopted: count('adopted'), granted: count('granted'), removed: count('removed'),
      wrote: out.filter((x) => x.wrote).length, problems: count('problems') },
  });
  return out;
}

/** From the live hub's heartbeat: at most every 10 minutes. Never throws */
export async function maybeSyncSponsors(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(env.DB);
    const state = await readState(env.DB);
    if (now - Date.parse(state.lastSweepAt || 0) < SWEEP_EVERY_MS) return null;
    // Claim the slot first so overlapping heartbeats don't double up
    await writeState(env.DB, { lastSweepAt: nowIso(now) });
    return await syncSponsors(env, { fetchImpl, now });
  } catch (e) {
    try { await writeState(env.DB, { lastError: String(e?.message || e).slice(0, 300), lastErrorAt: nowIso(now) }); } catch { /* nothing more to do */ }
    return null;
  }
}
