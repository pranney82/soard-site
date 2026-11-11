/**
 * Monetary sponsors: their people, and who counts as one on a job
 * ===========================================================================
 * Who paid for a room is a room credit now (./_room-credits.js, Peter, Nov 10
 * 2026): Clareece picks it in JobTread's Monetary Sponsor dropdown, or staff
 * in Admin → Kids, and the kid's `sponsors` is the website's copy. What stays
 * here: a sponsor's people (D1 partner_contacts, private, never on the
 * partner record: content is written into builds and the repo is public),
 * and, for Demo Day, whether someone on a job is from one of the kid's
 * sponsors. The sponsor sweep that kept JobTread's field and job access
 * following the website (Oct 28 2026) is gone; sponsor_jobs is only read
 * once, when room credits start, for the sponsors staff had taken off.
 */
import { readLinks } from './_kid-partners.js';
import { nameKey, domainOf, cfId } from '../../public/admin/partners-shared.js';

const MAX_PEOPLE = 5;

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
  try { rows = (await DB.prepare('SELECT partner, people FROM partner_contacts').all()).results || []; } catch (e) {
    // No table until the first save. Any other failed read is a failure, never "nobody": a sponsor's people would
    // read as not on a job, or not the sponsor (Demo Day would drop them from an invite that's out)
    if (/no such table/i.test(String(e?.message || e))) return {};
    throw e;
  }
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

// ── Who is a sponsor ─────────────────────────────────────────────────

// A table that isn't there yet holds nobody; any other failure is a failure (Demo Day stops rather than drop its sponsors)
const rowsOf = (DB, sql) => DB.prepare(sql).all().then((r) => r.results || []).catch((e) => { if (/no such table/i.test(e?.message || '')) return []; throw e; });
async function readPartners(DB) {
  const rows = await rowsOf(DB, 'SELECT slug, data FROM partners');
  return rows.map((r) => { const d = parse(r.data || '{}', {}); return { slug: r.slug, name: d.name || r.slug, website: d.website || '', logo: d.logo || '', level: d.level || 'friend' }; });
}
const sponsorsOf = (kid) => [...new Set((Array.isArray(kid?.data?.sponsors) ? kid.data.sponsors : []).filter((s) => typeof s === 'string' && s))];

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

const sameSite = (a, b) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
/** Is this JobTread person from that sponsor? (company name or "Same as" link, a contact's email, or the website's domain) */
export function fromSponsor(person, partner, { contacts = [], links = {} } = {}) {
  const ck = nameKey(person.company || '');
  if (ck && (ck === nameKey(partner.name) || links[ck] === partner.slug)) return true;
  if (person.email && contacts.some((c) => c.email === person.email)) return true;
  const web = partner.website ? domainOf(partner.website) : '';
  return sameSite(String(person.email || '').split('@')[1] || '', web);
}

/**
 * For Demo Day: (person { email, company }, kid slug) → is this JobTread
 * login from one of the kid's monetary sponsors? Reads Partners, contacts,
 * links and the kids' sponsors once.
 */
export async function sponsorMatcher(DB) {
  const [partners, contacts, links, kids] = await Promise.all([
    readPartners(DB), readContacts(DB), readLinks(DB),
    rowsOf(DB, 'SELECT slug, data FROM kids'),
  ]);
  const bySlug = new Map(partners.map((p) => [p.slug, p]));
  const sponsors = new Map(kids.map((k) => [k.slug, sponsorsOf({ data: parse(k.data || '{}', {}) })]));
  return (person, slug) => (sponsors.get(slug) || []).some((s) => bySlug.has(s) && fromSponsor(person, bySlug.get(s), { contacts: contacts[s] || [], links }));
}
