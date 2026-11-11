/**
 * Partners, vendors, families, History and Drive through the SOARD connection, read only.
 *
 * Each reads what its admin screen reads, under the same rule: Drive search stays the founders' (drive-admin's own
 * check), and a family's contact details come one family at a time. Approving, declining or messaging a family,
 * asking a vendor for papers and changing a room credit all stay in the admin.
 */

import { onRequestGet as roomCredits } from '../room-credits-admin.js';
import { onRequestGet as sponsorsGet } from '../sponsors-admin.js';
import { onRequestGet as vendorPapers } from '../vendor-papers-admin.js';
import { onRequestGet as driveGet } from '../drive-admin.js';
import { listApplicants, applicantDetail, isAccountId, STATUSES } from '../_applicants.js';
import { done, refuse, adminCall, adminUrl, SITE_URL, dollars, words, isoDay, READ } from './core.js';

const rowOf = (r) => { try { return { ...JSON.parse(r.data), slug: r.slug }; } catch { return null; } };

// ── Partners ──────────────────────────────────────────────────────────────

async function findPartners(env, { query = '' }, me, ctx) {
  const q = String(query || '').trim().toLowerCase();
  const { results = [] } = await env.DB.prepare('SELECT slug, data FROM partners').all();
  const partners = results.map(rowOf).filter(Boolean).filter((p) => !q || `${p.name || ''} ${p.slug}`.toLowerCase().includes(q))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const credits = await adminCall(roomCredits, ctx, '/api/room-credits-admin').catch(() => null);
  const byPartner = credits?.ok ? credits.data.byPartner || {} : null;
  const few = partners.slice(0, 5).map((p) => p.slug);
  const contacts = q && few.length ? await adminCall(sponsorsGet, ctx, `/api/sponsors-admin?partners=${few.map(encodeURIComponent).join(',')}`).catch(() => null) : null;
  return done({
    partners: partners.slice(0, 80).map((p) => ({
      slug: p.slug, name: p.name || p.slug, website: p.website || null,
      ...(p.description ? { about: words(p.description, 300) } : {}),
      ...(p.tier || p.level || p.category ? { kind: p.tier || p.level || p.category } : {}),
      onTheSite: !p.publishStatus || p.publishStatus === 'published',
      ...(byPartner ? { rooms: (byPartner[p.slug] || []).map((c) => ({ for: c.name, year: c.year || null, as: c.kind === 'designed' ? 'designed it' : c.kind === 'sponsored' ? 'paid for it' : c.kind })) } : {}),
      ...(contacts?.ok && contacts.data.contacts?.[p.slug]?.length ? { people: contacts.data.contacts[p.slug].map((x) => ({ name: x.name || null, email: x.email || null, role: x.role || x.title || null })) } : {}),
    })),
    ...(partners.length > 80 ? { more: partners.length - 80 } : {}),
    ...(byPartner ? {} : { note: 'Room credits didn’t load (JobTread may be slow). Ask again in a minute.' }),
    admin: adminUrl('#partners'), page: `${SITE_URL}/partners/`,
  });
}

async function vendorPapersTool(env, { query = '', show = 'needs' }, me, ctx) {
  const r = await adminCall(vendorPapers, ctx, '/api/vendor-papers-admin');
  if (!r.ok) return refuse(r.data?.error || 'Vendor papers didn’t load. Try again in a minute.');
  const q = String(query || '').trim().toLowerCase();
  const list = (r.data.list || []).filter((v) => !v.archived)
    .filter((v) => !q || String(v.name || '').toLowerCase().includes(q))
    .filter((v) => q || show === 'all' || !v.ok || v.expiring);
  return done({
    vendors: list.slice(0, 120).map((v) => ({
      name: v.name, ok: !!v.ok, ...(v.expiring ? { expiring: true } : {}), stands: v.staff || v.label || null,
      w9: !!v.w9, liabilityEnds: v.gl || null, workersCompEnds: v.wc || null, paidThisYear: dollars(v.paid), lastPaid: isoDay(v.lastPaid), jobs: v.jobs || 0,
      ...(v.asked ? { askedOn: isoDay(v.asked) } : {}),
    })),
    ...(list.length > 120 ? { more: list.length - 120 } : {}),
    said: 'Who SOARD pays, and whether their W-9 and certificates of insurance are on file and current. Asking a vendor for papers is done in the admin.',
    admin: adminUrl('#job-costs'),
  });
}

// ── Families who applied ──────────────────────────────────────────────────

async function findFamilies(env, { query = '', status, year, archived = false }) {
  const q = String(query || '').trim().toLowerCase();
  const list = (await listApplicants(env.DB, { archived }))
    .filter((a) => !/^\s*test\b/i.test(a.name || ''))
    .filter((a) => !q || `${a.name || ''} ${a.city || ''} ${a.county || ''}`.toLowerCase().includes(q))
    .filter((a) => !status || a.status === status)
    .filter((a) => !year || String(a.year) === String(year));
  const counts = {};
  for (const a of list) counts[a.status || 'No status'] = (counts[a.status || 'No status'] || 0) + 1;
  return done({
    families: list.slice(0, 100).map((a) => ({
      id: a.id, name: a.name, kind: a.kind || null, status: a.status || null, year: a.year || null, types: a.types || [],
      city: a.city || null, county: a.county || null, inTheArea: a.area || null, applied: isoDay(a.createdAt),
      ...(a.score?.total !== undefined ? { score: a.score.total } : {}),
      ...(a.waiting ? { repliedAndWaiting: true } : {}),
      ...(a.lastActivity?.title ? { last: words(a.lastActivity.title, 120), lastOn: isoDay(a.lastActivityAt) } : {}),
    })),
    counts, ...(list.length > 100 ? { more: list.length - 100 } : {}),
    said: 'Approving, declining and writing to a family are done in Admin → Applications, never here.',
    admin: adminUrl('#applications/applicants'),
  });
}

async function getFamily(env, { id }) {
  if (!isAccountId(id)) return refuse('That isn’t a family’s id. Use find_families to get it.');
  const d = await applicantDetail(env, id);
  if (!d) return refuse('That family isn’t in Applications.');
  const a = d.applicant || d;
  const f = a.fields || {};
  const age = f.birthday && /^\d{4}-\d{2}-\d{2}/.test(f.birthday) ? Math.floor((Date.now() - Date.parse(f.birthday)) / (365.25 * 86400000)) : null;
  return done({
    id, name: a.name, kind: a.kind || null, status: a.status || null, year: a.year || null, types: a.types || [],
    city: a.city || null, county: a.county || null, inTheArea: a.area || null, applied: isoDay(a.createdAt),
    kid: { age, diagnosis: f.diagnosis ? words(f.diagnosis, 600) : null, gender: f.gender || null, language: f.language || null, verbal: f.verbal || null, walksOnTheirOwn: f.mobile || null },
    referredBy: f.referredBy || null, ...(f.denialReason ? { denialReason: words(f.denialReason, 400) } : {}),
    contact: a.contact ? { name: a.contact.name || null, email: a.contact.email || null, phone: a.contact.phone || null } : null,
    notes: (d.comments || []).slice(0, 25).map((c) => ({ by: c.by || (c.fromEmail ? 'an email' : null), on: isoDay(c.at), words: words(c.message || c.name || '', 800), ...(c.to?.length ? { sharedWithTheFamily: true } : {}) })),
    ...(a.waiting ? { repliedAndWaiting: true } : {}),
    admin: adminUrl(`#applications/applicants/${encodeURIComponent(id)}`),
    care: 'A family’s details stay with SOARD staff: never in an email, a post or anything public.',
  });
}

// ── History and Drive ─────────────────────────────────────────────────────

async function recentChanges(env, { days = 7, who = '', query = '', limit = 60 }) {
  const where = ["created_at >= datetime('now', ?)"];
  const binds = [`-${days} days`];
  if (who) { where.push('user_email LIKE ?'); binds.push(`%${String(who).toLowerCase()}%`); }
  if (query) { where.push('(entity_name LIKE ? OR entity_slug LIKE ? OR entity_type LIKE ?)'); binds.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  const { results = [] } = await env.DB.prepare(`SELECT user_email, action, entity_type, entity_slug, entity_name, created_at FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...binds, limit).all();
  return done({
    changes: results.map((r) => ({ by: r.user_email, did: r.action, what: r.entity_type, name: r.entity_name || r.entity_slug || null, at: r.created_at })),
    admin: adminUrl('#history'),
  });
}

async function searchDrive(env, { query, images = false }, me, ctx) {
  const r = await adminCall(driveGet, ctx, `/api/drive-admin?q=${encodeURIComponent(query)}${images ? '&images=1' : ''}`);
  if (r.status === 403) return refuse(r.data?.error || 'Searching SOARD’s Drive is open only to the founders.');
  if (!r.ok) return refuse(r.data?.error || 'Drive didn’t answer. Try again in a minute.');
  return done({
    files: (r.data.files || []).slice(0, 60).map((f) => ({
      name: f.name, kind: f.mimeType || null, changed: isoDay(f.modifiedTime), owner: f.owner || f.account || null,
      open: `https://drive.google.com/open?id=${encodeURIComponent(f.id)}`,
    })),
    ...((r.data.problems || []).length ? { couldntSearch: r.data.problems.map((p) => p.account || p) } : {}),
  });
}

export const TOOLS = [
  { name: 'find_partners', title: 'Find partners', annotations: { title: 'Find partners', ...READ },
    description: 'SOARD’s partners (sponsors, designers, community partners) as the Partners page lists them, with the rooms each designed or paid for. Searching by name also brings each match’s sponsor contacts, for a thank-you.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200, description: 'Part of a name' } }, additionalProperties: false },
    run: findPartners },
  { name: 'vendor_papers', title: 'Vendor papers', annotations: { title: 'Vendor papers', ...READ },
    description: 'The companies SOARD pays and whether their W-9 and certificates of insurance (liability, workers’ comp) are on file and current: by default only those missing something or expiring soon; all lists everyone, and a name finds one.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, show: { type: 'string', enum: ['needs', 'all'] } }, additionalProperties: false },
    run: vendorPapersTool },
  { name: 'find_families', title: 'Families who applied', annotations: { title: 'Families who applied', ...READ },
    description: `Families (and organizations) who applied for a makeover, newest first, as Admin → Applications lists them: status (${STATUSES.join(', ')}), year, makeover types, city and county, score, and whether they replied and are waiting. Filter by part of a name or city, status or year. Contact details come only with get_family.`,
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 200 }, status: { type: 'string', enum: [...STATUSES] }, year: { type: 'integer', minimum: 2020, maximum: 2040 }, archived: { type: 'boolean' },
    }, additionalProperties: false },
    run: findFamilies },
  { name: 'get_family', title: 'One family', annotations: { title: 'One family', ...READ, openWorldHint: true },
    description: 'One family’s application in full, live from JobTread: the child (age, diagnosis, language), the contact person, who referred them, and the team’s notes. For SOARD staff only: never put a family’s details in an email, post or anything public.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 64, description: 'From find_families' } }, required: ['id'], additionalProperties: false },
    run: getFamily },
  { name: 'recent_changes', title: 'Recent changes', annotations: { title: 'Recent changes', ...READ },
    description: 'Admin → History: who changed what on the site and when (pages, emails, settings, publishes), newest first. Filter by days, part of a person’s email, or part of what was changed.',
    inputSchema: { type: 'object', properties: {
      days: { type: 'integer', minimum: 1, maximum: 366 }, who: { type: 'string', maxLength: 120 }, query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, additionalProperties: false },
    run: recentChanges },
  { name: 'search_drive', title: 'Search Drive', annotations: { title: 'Search Drive', ...READ, openWorldHint: true },
    description: 'Search every SOARD Google Drive by words in a file’s name or text, newest first, with a link to open each. Open to the founders only, as in the admin.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, images: { type: 'boolean', description: 'Only pictures' } }, required: ['query'], additionalProperties: false },
    run: searchDrive },
];
