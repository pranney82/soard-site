/**
 * Vendors on their JobTread jobs (Peter, Oct 28 2026)
 * ===========================================================================
 * Each open kid or community job lists its vendors in JobTread's job access:
 *   - each company whose logo is on the page (the kid's monetary sponsor
 *     aside: the Sponsor role is ./_sponsors.js's), and
 *   - each JobTread vendor with a bill or a purchase order on the job, from
 *     the vendors table's JobTread cache (jt_id + facts.jobs, every 4 hours)
 * A company is on the job when anyone from it has access, in any role: a
 * login under its JobTread account, one of its contacts' emails, or an email
 * on its website's domain. One that isn't gets its first contact with an
 * email (the account's primary contact first) added as a Vendor, without
 * JobTread's email (notify: false). With no email anywhere it waits in
 * Partners → JobTread access, and goes on once someone adds one.
 *
 * A company on a page with no JobTread vendor account gets one, under its
 * Partners name, with its contacts. When JobTread has a vendor by a near name
 * ("WYP Construction" for Walk Your Plans) the sweep doesn't guess: staff say
 * "Same company" (kept for every job after, logos too) or "Make a new one".
 *
 * Contacts sync both ways between Partners (D1 partner_contacts, private,
 * ./_sponsors.js) and the vendor account's contacts. Each side's list is
 * kept as of the last sync; the side that changed since wins, and when both
 * did, the newer change: the website's is timed, JobTread's isn't, so it
 * counts from when the sweep first sees it. A contact staff take off in
 * Partners comes off the JobTread account too; JobTread's extras past the
 * five Partners keeps are left alone. Logos stay in Partners: JobTread
 * accounts have no logo.
 *
 * Nothing here emails anyone. Every 15 minutes from the live hub heartbeat,
 * at most 20 seconds of JobTread writes a run (the rest go next run).
 * Tables: vendor_access (one row per company per job), vendor_accounts
 * (partner ↔ JobTread vendor account, and both contact lists as last synced),
 * vendor_access_state.
 */
import { SOARD_ORG_ID } from './_reveals.js';
import { loadAllKids, loadAllProjects, linkJobs, keyOf, SYNC_USER } from './_kid-status.js';
import { fetchOpenJobs, fetchAccess, readLinks, setLink, takeLock, freeLock, FREE_MAIL } from './_kid-partners.js';
import { pave, grantJobAccess } from './_jt-access.js';
import { readContacts, saveContacts, isEmail } from './_sponsors.js';
import { FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE } from './_applicant-comms.js';
import { logAudit } from './_audit.js';
import { nameKey, wordsKey, domainOf, isSocial, kidUsage, nearPartners } from '../../public/admin/partners-shared.js';

export const VENDOR_ROLE = 'Vendor';
const RUN_EVERY_MS = 15 * 60 * 1000;
const WRITE_BUDGET_MS = 20 * 1000;
const MAX_GRANTS = 12;
const MAX_NEW_ACCOUNTS = 5;
const MAX_PEOPLE = 5; // what Partners keeps per partner
const ACCOUNTS_PAGE = 25; // 50 × 5 contacts passed JobTread's no-key size check, 100 didn't (Oct 28 2026)
const MAX_ACCOUNT_PAGES = 40;
const LOCK = 'vendor-access';

const SCHEMA = [
  // state: 'there' (someone from the company was on it), 'added' (the sweep added person),
  // 'waiting' (reason: 'no-email' or 'error'). why: 'page', 'bill' or 'page bill'
  `CREATE TABLE IF NOT EXISTS vendor_access (
    job_id TEXT NOT NULL, company TEXT NOT NULL, record TEXT, page TEXT, name TEXT, partner TEXT, account_id TEXT,
    why TEXT, state TEXT NOT NULL, reason TEXT, person TEXT, first_seen TEXT, updated_at TEXT,
    PRIMARY KEY (job_id, company))`,
  // how: 'name', 'linked' (staff: same company) or 'made' (the sweep made the account).
  // jt_seen / site_seen: each side's contacts as of synced_at
  `CREATE TABLE IF NOT EXISTS vendor_accounts (
    partner TEXT PRIMARY KEY, account_id TEXT NOT NULL, account_name TEXT, how TEXT,
    jt_seen TEXT, site_seen TEXT, synced_at TEXT, made_at TEXT)`,
  'CREATE TABLE IF NOT EXISTS vendor_access_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];
export async function ensureSchema(DB) {
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  await DB.prepare('CREATE TABLE IF NOT EXISTS kid_partner_lock (name TEXT PRIMARY KEY, until INTEGER NOT NULL)').run();
}
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const iso = (ms) => new Date(ms).toISOString();
const lower = (e) => String(e || '').trim().toLowerCase();
const sameName = (a, b) => (!!nameKey(a) && nameKey(a) === nameKey(b)) || (!!wordsKey(a) && wordsKey(a) === wordsKey(b));
const domainOfEmail = (e) => String(e || '').split('@')[1]?.toLowerCase() || '';
const sameSite = (mail, web) => !!mail && !!web && (mail === web || mail.endsWith(`.${web}`) || web.endsWith(`.${mail}`));

async function readKey(DB, key) {
  const row = await DB.prepare('SELECT value FROM vendor_access_state WHERE key = ?').bind(key).first();
  return parse(row?.value || '{}', {});
}
async function writeKey(DB, key, value) {
  await DB.prepare('INSERT OR REPLACE INTO vendor_access_state (key, value) VALUES (?, ?)').bind(key, JSON.stringify(value)).run();
  return value;
}
const patchKey = async (DB, key, patch) => writeKey(DB, key, { ...(await readKey(DB, key)), ...patch });

// ── JobTread vendor accounts ─────────────────────────────────────────
const CONTACT = {
  id: {}, name: {}, title: {}, createdAt: {},
  customFieldValues: { $: { size: 2, where: [['customField', 'id'], 'in', [FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE]] }, nodes: { createdAt: {}, value: {}, customField: { id: {} } } },
};
function contactOf(c) {
  const v = (id) => (c.customFieldValues?.nodes || []).find((x) => x.customField?.id === id);
  const email = lower(v(FIELD_CONTACT_EMAIL)?.value);
  const at = [c.createdAt, ...(c.customFieldValues?.nodes || []).map((x) => x.createdAt)].filter(Boolean).sort().at(-1) || null;
  return { id: c.id, name: String(c.name || '').trim(), title: String(c.title || '').trim(), email: isEmail(email) ? email : '', phone: String(v(FIELD_CONTACT_PHONE)?.value || '').trim(), at };
}

/** SOARD's JobTread vendors: [{ id, name, archived, primary, contacts: [{ id, name, title, email, phone, at }] }] */
export async function fetchVendorAccounts(grantKey, fetchImpl = fetch) {
  const out = [];
  let page = null;
  for (let i = 0; i < MAX_ACCOUNT_PAGES; i++) {
    const body = await pave(grantKey, {
      organization: {
        $: { id: SOARD_ORG_ID },
        accounts: {
          $: { size: ACCOUNTS_PAGE, where: ['type', '=', 'vendor'], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: { id: {}, name: {}, archivedAt: {}, primaryContact: { id: {} }, contacts: { $: { size: MAX_PEOPLE }, nodes: CONTACT } },
        },
      },
    }, fetchImpl);
    const conn = body?.organization?.accounts;
    if (!conn) throw new Error('JobTread sent no vendor accounts');
    for (const a of conn.nodes || []) {
      out.push({ id: a.id, name: String(a.name || '').trim(), archived: !!a.archivedAt, primary: a.primaryContact?.id || null, contacts: (a.contacts?.nodes || []).map(contactOf) });
    }
    page = conn.nextPage || null;
    if (!page) break;
  }
  return out;
}

const jtFields = (p) => ({
  ...(p.email ? { [FIELD_CONTACT_EMAIL]: p.email } : {}),
  ...(p.phone && p.phone.replace(/\D/g, '').length >= 10 ? { [FIELD_CONTACT_PHONE]: p.phone } : {}),
});
async function createAccount(grantKey, name, fetchImpl) {
  const body = await pave(grantKey, { createAccount: { $: { organizationId: SOARD_ORG_ID, name, type: 'vendor' }, createdAccount: { id: {}, name: {} } } }, fetchImpl);
  const a = body?.createAccount?.createdAccount;
  if (!a?.id) throw new Error('JobTread didn’t say it made the account');
  return { id: a.id, name: a.name || name, archived: false, primary: null, contacts: [] };
}
async function createContact(grantKey, accountId, p, fetchImpl) {
  const $ = { accountId, name: p.name || p.email, ...(p.title ? { title: p.title } : {}) };
  const fields = jtFields(p);
  let body;
  try {
    body = await pave(grantKey, { createContact: { $: { ...$, customFieldValues: fields }, createdContact: { id: {} } } }, fetchImpl);
  } catch (e) {
    // A phone JobTread won't take shouldn't keep the person out
    if (!fields[FIELD_CONTACT_PHONE] || !/phone/i.test(e.message)) throw e;
    delete fields[FIELD_CONTACT_PHONE];
    body = await pave(grantKey, { createContact: { $: { ...$, customFieldValues: fields }, createdContact: { id: {} } } }, fetchImpl);
  }
  const id = body?.createContact?.createdContact?.id;
  if (!id) throw new Error('JobTread didn’t say it made the contact');
  return id;
}
async function updateContact(grantKey, c, p, fetchImpl) {
  const $ = { id: c.id };
  if (p.name && p.name !== c.name) $.name = p.name;
  if ((p.title || '') !== (c.title || '')) $.title = p.title || '';
  const fields = {};
  if ((p.email || '') !== (c.email || '')) fields[FIELD_CONTACT_EMAIL] = p.email || '';
  if (digits(p.phone) !== digits(c.phone)) fields[FIELD_CONTACT_PHONE] = digits(p.phone).length >= 10 ? p.phone : '';
  if (Object.keys(fields).length) $.customFieldValues = fields;
  if (Object.keys($).length > 1) await pave(grantKey, { updateContact: { $ } }, fetchImpl);
}
const deleteContact = (grantKey, id, fetchImpl) => pave(grantKey, { deleteContact: { $: { id } } }, fetchImpl);

// ── Contacts, both ways ──────────────────────────────────────────────
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const tidy = (p) => ({ name: String(p?.name || '').replace(/\s+/g, ' ').trim(), email: isEmail(lower(p?.email)) ? lower(p.email) : '', phone: String(p?.phone || '').trim(), title: String(p?.title || '').replace(/\s+/g, ' ').trim() });
const sig = (p) => [p.email, p.email ? '' : nameKey(p.name), nameKey(p.name), digits(p.phone), p.title.toLowerCase()].join('|');
/** Two lists say the same: same people, names, phones (digits) and titles, in any order */
export const sameList = (a, b) => JSON.stringify((a || []).map(tidy).map(sig).sort()) === JSON.stringify((b || []).map(tidy).map(sig).sort());
/** The same person: the same email, else (one of them has none) the same name */
const samePerson = (a, b) => (a.email && b.email ? a.email === b.email : !!nameKey(a.name) && nameKey(a.name) === nameKey(b.name));
/** Partners keeps five: people with an email first */
const capped = (list) => [...list.filter((p) => p.email), ...list.filter((p) => !p.email)].slice(0, MAX_PEOPLE);

/**
 * What to write where, for one partner and its JobTread account:
 * { toSite: people | null, toJt: people | null, winner: 'site' | 'jobtread' | null }
 * seen: { site, jt, at } as of the last sync, or null the first time (then
 * the two lists are put together, the newer side's details winning).
 */
export function contactPlan({ site = [], siteAt = null, jt = [], seen = null }) {
  site = site.map(tidy);
  const jtTidy = jt.map((c) => ({ ...tidy(c), at: c.at || null }));
  if (!seen) {
    if (!site.length && !jtTidy.length) return { toSite: null, toJt: null, winner: null };
    const merged = site.map((p) => ({ ...p }));
    for (const c of jtTidy) {
      const i = merged.findIndex((p) => samePerson(p, c));
      if (i < 0) { merged.push({ name: c.name, email: c.email, phone: c.phone, title: c.title }); continue; }
      const siteNewer = siteAt && (!c.at || Date.parse(siteAt) > Date.parse(c.at));
      const [win, lose] = siteNewer ? [merged[i], c] : [c, merged[i]];
      merged[i] = Object.fromEntries(['name', 'email', 'phone', 'title'].map((k) => [k, win[k] || lose[k] || '']));
    }
    const toSite = capped(merged);
    return { toSite: sameList(toSite, site) ? null : toSite, toJt: sameList(merged, jtTidy) ? null : merged, winner: null };
  }
  const jtChanged = !sameList(jtTidy, seen.jt);
  const siteChanged = !sameList(site, seen.site);
  if (!jtChanged && !siteChanged) return { toSite: null, toJt: null, winner: null };
  let winner = siteChanged ? 'site' : 'jobtread';
  if (jtChanged && siteChanged) {
    // JobTread's change is as old as its newest dated contact, else no older than the last sync
    const jtAt = Math.max(Date.parse(seen.at || 0) || 0, ...jtTidy.map((c) => Date.parse(c.at || 0) || 0));
    winner = siteAt && Date.parse(siteAt) > jtAt ? 'site' : 'jobtread';
  }
  if (winner === 'site') return { toSite: null, toJt: site, winner };
  const toSite = capped(jtTidy.map(({ at, ...p }) => p));
  return { toSite: sameList(toSite, site) ? null : toSite, toJt: null, winner };
}

/**
 * Make the account's contacts say `target`: update the same person, make the
 * new ones, take off only those the website had and dropped (`dropped`).
 * Returns the account's contacts after.
 */
async function writeJtContacts(grantKey, account, target, dropped, fetchImpl) {
  const left = [...account.contacts];
  const after = [];
  const take = (p, test) => { const i = left.findIndex((c) => test(c, p)); return i < 0 ? null : left.splice(i, 1)[0]; };
  // Email matches first, so a name match never takes someone else's contact
  const pairs = target.map((p) => [p, p.email ? take(p, (c, x) => c.email && c.email === x.email) : null]);
  for (const pair of pairs) if (!pair[1]) pair[1] = take(pair[0], (c, x) => !!nameKey(c.name) && nameKey(c.name) === nameKey(x.name) && (!c.email || !x.email || c.email === x.email));
  for (const [p, c] of pairs) {
    if (c) { await updateContact(grantKey, c, p, fetchImpl); after.push({ ...c, ...p }); }
    else after.push({ id: await createContact(grantKey, account.id, p, fetchImpl), ...p, at: null });
  }
  for (const c of left) {
    if (dropped.some((d) => samePerson(tidy(d), c))) await deleteContact(grantKey, c.id, fetchImpl);
    else after.push(c);
  }
  return after;
}

// ── Who belongs on each job ──────────────────────────────────────────
/**
 * Partner ↔ JobTread vendor account: what staff or the sweep settled
 * (saved), then a "Same as" link by the account's name, then one same-named
 * account (the one with the most contacts when JobTread has two).
 * → Map(partner slug → account)
 */
export function pairAccounts(partners, accounts, { saved = {}, links = {} } = {}) {
  const live = accounts.filter((a) => !a.archived);
  // A pair staff settled holds even once JobTread archives the account
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const slugs = new Set(partners.map((p) => p.slug));
  const out = new Map();
  const taken = new Set();
  const pair = (slug, a) => { out.set(slug, a); taken.add(a.id); };
  for (const [slug, id] of Object.entries(saved)) if (slugs.has(slug) && byId.has(id) && !taken.has(id)) pair(slug, byId.get(id));
  for (const a of live) {
    const slug = links[nameKey(a.name)];
    if (slug && slugs.has(slug) && !out.has(slug) && !taken.has(a.id)) pair(slug, a);
  }
  for (const p of partners) {
    if (out.has(p.slug)) continue;
    const hits = live.filter((a) => !taken.has(a.id) && sameName(a.name, p.name)).sort((x, y) => y.contacts.length - x.contacts.length);
    if (hits.length) pair(p.slug, hits[0]);
  }
  return out;
}

/**
 * A page's vendors: [{ company, name, partner, account, why: Set('page','bill') }].
 * bills: the JobTread vendor account ids with a bill or order on the job.
 */
export function jobVendors(rec, { partners, pairs, accounts, bills = [] }) {
  const data = rec.data || {};
  const sponsors = new Set(Array.isArray(data.sponsors) ? data.sponsors : []);
  const bySlug = new Map(partners.map((p) => [p.slug, p]));
  const accountOf = new Map([...pairs].map(([slug, a]) => [a.id, slug]));
  const out = new Map();
  const add = (v, why) => {
    const was = out.get(v.company);
    if (was) { was.why.add(why); was.account ||= v.account; return; }
    out.set(v.company, { ...v, why: new Set([why]) });
  };
  const usage = kidUsage([{ ...data, slug: '_', publishStatus: 'published' }], partners).byPartner;
  const matched = new Set();
  for (const slug of usage.keys()) {
    const p = bySlug.get(slug);
    for (const row of usage.get(slug)) matched.add(row.url);
    if (!p || sponsors.has(slug)) continue;
    add({ company: nameKey(p.name), name: p.name, partner: slug, account: pairs.get(slug) || null }, 'page');
  }
  // A named logo that isn't a partner's file: the partner by that name, else JobTread's vendor by it
  for (const l of data.partnerLogos || []) {
    if (!l?.url || matched.has(l.url) || !nameKey(l.name)) continue;
    const p = partners.find((x) => sameName(x.name, l.name));
    if (p) { if (!sponsors.has(p.slug)) add({ company: nameKey(p.name), name: p.name, partner: p.slug, account: pairs.get(p.slug) || null }, 'page'); continue; }
    const a = accounts.find((x) => !x.archived && sameName(x.name, l.name));
    add({ company: nameKey(String(l.name).trim()), name: String(l.name).trim(), partner: null, account: a || null }, 'page');
  }
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of bills) {
    const a = byId.get(id);
    if (!a || a.archived) continue;
    const slug = accountOf.get(id);
    if (slug && sponsors.has(slug)) continue;
    const p = slug ? bySlug.get(slug) : null;
    add(p ? { company: nameKey(p.name), name: p.name, partner: slug, account: a } : { company: nameKey(a.name), name: a.name, partner: null, account: a }, 'bill');
  }
  return [...out.values()].filter((v) => v.company);
}

/** Someone from the company has access already (any role) */
export function onJob(v, aces, { people = [], website = '' } = {}) {
  const emails = new Set([...(v.account?.contacts || []), ...people].map((p) => lower(p.email)).filter(Boolean));
  const site = website && !isSocial(website) ? domainOf(website) : '';
  return (aces?.nodes || []).some(({ membership: m } = {}) => {
    if (!m || m.isInternal) return false;
    const email = lower(m.user?.emailAddress);
    if (v.account && m.account?.id === v.account.id) return true;
    if (m.account?.name && (nameKey(m.account.name) === v.company || sameName(m.account.name, v.name))) return true;
    if (email && emails.has(email)) return true;
    const d = domainOfEmail(email);
    return !!site && !FREE_MAIL.has(d) && sameSite(d, site);
  });
}

/** Who to add: the account's primary contact with an email, its first with one, then Partners' */
export function personFor(v, people = []) {
  const jt = v.account?.contacts || [];
  const p = jt.find((c) => c.id === v.account?.primary && c.email) || jt.find((c) => c.email) || people.find((c) => isEmail(c.email));
  return p ? { name: p.name || v.name, email: lower(p.email) } : null;
}

// ── The sweep ────────────────────────────────────────────────────────
async function readPartners(DB) {
  const rows = (await DB.prepare('SELECT slug, data FROM partners').all()).results || [];
  return rows.map((r) => ({ slug: r.slug, ...(parse(r.data || '{}', {}) || {}) })).map((p) => ({ ...p, name: p.name || p.slug }));
}
/** Which JobTread vendors have a bill or order on which job, from the vendors table's JobTread cache (only jt_id and facts.jobs[].jobId are read): Map(job id → [account id]) */
async function billsByJob(DB) {
  const out = new Map();
  let rows = [];
  try { rows = (await DB.prepare('SELECT jt_id, facts FROM vendors WHERE jt_id IS NOT NULL').all()).results || []; } catch { return out; }
  for (const r of rows) {
    for (const j of parse(r.facts, {})?.jobs || []) {
      if (!j?.jobId) continue;
      const list = out.get(j.jobId) || [];
      if (!list.includes(r.jt_id)) list.push(r.jt_id);
      out.set(j.jobId, list);
    }
  }
  return out;
}
async function readAccountRows(DB) {
  const rows = (await DB.prepare('SELECT * FROM vendor_accounts').all()).results || [];
  return new Map(rows.map((r) => [r.partner, { ...r, jt_seen: parse(r.jt_seen, null), site_seen: parse(r.site_seen, null) }]));
}
async function putAccountRow(DB, r) {
  await DB.prepare(`INSERT OR REPLACE INTO vendor_accounts (partner, account_id, account_name, how, jt_seen, site_seen, synced_at, made_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.partner, r.account_id, r.account_name || null, r.how || 'name',
    r.jt_seen ? JSON.stringify(r.jt_seen) : null, r.site_seen ? JSON.stringify(r.site_seen) : null, r.synced_at || null, r.made_at || null).run();
}
async function readRows(DB) {
  const rows = (await DB.prepare('SELECT * FROM vendor_access').all()).results || [];
  return new Map(rows.map((r) => [`${r.job_id} ${r.company}`, { ...r, person: parse(r.person, null) }]));
}
async function putRow(DB, r) {
  await DB.prepare(`INSERT OR REPLACE INTO vendor_access (job_id, company, record, page, name, partner, account_id, why, state, reason, person, first_seen, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.job_id, r.company, r.record || null, r.page || null, r.name || null, r.partner || null, r.account_id || null,
    r.why || null, r.state, r.reason || null, r.person ? JSON.stringify(r.person) : null, r.first_seen || null, r.updated_at || null).run();
}
const pageName = (rec) => (rec.kind === 'community' ? `the ${rec.name} page` : `${rec.name}’s page`);
const whyOf = (v) => ['page', 'bill'].filter((w) => v.why.has(w)).join(' ');

/**
 * One reconciliation. only: a company name key, to do just that one (after
 * staff add an email). → { added, waiting, made, contacts, more, problems }
 */
export async function syncVendorAccess(env, { fetchImpl = fetch, now = Date.now(), only = null } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  const at = iso(now);
  const started = Date.now();
  const report = { added: [], waiting: 0, made: [], contacts: [], more: false, problems: [] };
  if (!DB || !key) return report;
  await ensureSchema(DB);
  if (!(await takeLock(DB, !!only, LOCK))) return { ...report, busy: true };
  const room = () => Date.now() - started < WRITE_BUDGET_MS;
  try {
    const [jobs, kids, projects, partners, contactsAll, links, accountRows, rows, bills, accounts, setAside, newOk] = await Promise.all([
      fetchOpenJobs(key, fetchImpl), loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readContacts(DB), readLinks(DB),
      readAccountRows(DB), readRows(DB), billsByJob(DB), fetchVendorAccounts(key, fetchImpl), readKey(DB, 'set-aside'), readKey(DB, 'new-ok'),
    ]);
    const records = [...kids, ...projects];
    const byKey = new Map(records.map((r) => [keyOf(r), r]));
    const bySlug = new Map(partners.map((p) => [p.slug, p]));
    const saved = Object.fromEntries([...accountRows].map(([slug, r]) => [slug, r.account_id]));
    const pairs = pairAccounts(partners, accounts, { saved, links });
    const live = accounts.filter((a) => !a.archived);

    // Pairs settled this run are kept, so a renamed account stays paired
    for (const [slug, a] of pairs) {
      const r = accountRows.get(slug);
      if (!r || r.account_id !== a.id || r.account_name !== a.name) {
        const next = { ...(r && r.account_id === a.id ? r : {}), partner: slug, account_id: a.id, account_name: a.name, how: r?.account_id === a.id ? r.how : (links[nameKey(a.name)] === slug ? 'linked' : 'name') };
        await putAccountRow(DB, next);
        accountRows.set(slug, next);
      }
    }

    // Each open job with a page, and the vendors that belong on it
    const linked = [...linkJobs(jobs, records)].filter(([k]) => byKey.has(k));
    const want = [];
    for (const [k, job] of linked) {
      const rec = byKey.get(k);
      for (const v of jobVendors(rec, { partners, pairs, accounts, bills: bills.get(job.id) || [] })) {
        if (only && v.company !== only) continue;
        if (setAside[v.company]) continue;
        want.push({ k, rec, job, v });
      }
    }

    // A company on a page with no JobTread vendor account gets one; a near name waits for staff
    const needAccounts = [...new Map(want.filter((w) => w.v.partner && !w.v.account && w.v.why.has('page')).map((w) => [w.v.partner, w.v])).values()];
    const near = {};
    for (const v of needAccounts) {
      // One archived under the same name is a choice for staff too, never a second account by itself
      const archived = accounts.filter((a) => a.archived && sameName(a.name, v.name)).map((a) => ({ partner: { slug: a.id, name: `${a.name} (archived)` }, why: 'Archived in JobTread' }));
      const close = [...archived, ...nearPartners(v.name, live.map((a) => ({ slug: a.id, name: a.name })), { min: 0.6, max: 2 })].slice(0, 2);
      if (close.length && !newOk[v.partner]) { near[v.partner] = { name: v.name, near: close.map((c) => ({ id: c.partner.slug, name: c.partner.name, why: c.why })) }; continue; }
      if (report.made.length >= MAX_NEW_ACCOUNTS || !room()) { report.more = true; continue; }
      try {
        const a = await createAccount(key, bySlug.get(v.partner)?.name || v.name, fetchImpl);
        accounts.push(a);
        pairs.set(v.partner, a);
        const r = { partner: v.partner, account_id: a.id, account_name: a.name, how: 'made', made_at: at };
        await putAccountRow(DB, r);
        accountRows.set(v.partner, r);
        report.made.push({ partner: v.partner, name: a.name });
        for (const w of want) if (w.v.partner === v.partner) w.v.account = a;
      } catch (e) { report.problems.push(`Couldn’t make ${v.name} in JobTread: ${e.message}`); }
    }
    if (!only) await writeKey(DB, 'near', near);
    if (report.made.length) {
      await logAudit(DB, { userEmail: SYNC_USER, action: 'created', entityType: 'jobtread-vendor', entityName: 'Vendor accounts', changes: { made: report.made.map((m) => m.name) } });
    }

    // Who's on each job already, then the ones who aren't
    const access = want.length ? await fetchAccess(key, [...new Set(want.map((w) => w.job.id))], fetchImpl) : new Map();
    const grants = new Map(); // job id → [{ email, role }] for grantJobAccess
    const keep = new Set();
    for (const { k, rec, job, v } of want) {
      const rowKey = `${job.id} ${v.company}`;
      keep.add(rowKey);
      const was = rows.get(rowKey);
      const people = v.partner ? contactsAll[v.partner] || [] : [];
      const base = {
        job_id: job.id, company: v.company, record: k, page: pageName(rec), name: v.name, partner: v.partner, account_id: v.account?.id || null,
        why: whyOf(v), first_seen: was?.first_seen || at, updated_at: at, person: was?.person || null,
      };
      const aces = access.get(job.id);
      if (onJob(v, aces, { people, website: bySlug.get(v.partner)?.website })) {
        const next = { ...base, state: was?.state === 'added' ? 'added' : 'there', reason: null };
        if (!was || was.state !== next.state || was.why !== next.why || was.page !== next.page || was.name !== next.name) await putRow(DB, next);
        continue;
      }
      const person = personFor(v, people);
      if (!person) {
        report.waiting++;
        if (!was || was.state !== 'waiting' || was.reason !== 'no-email' || was.why !== base.why || was.name !== base.name) await putRow(DB, { ...base, state: 'waiting', reason: 'no-email', person: null });
        continue;
      }
      if (report.added.length >= MAX_GRANTS || !room()) { report.more = true; continue; }
      if (!grants.has(job.id)) grants.set(job.id, (aces?.nodes || []).map(({ membership: m } = {}) => ({ email: lower(m?.user?.emailAddress), role: m?.role?.name || null })).filter((x) => x.email));
      try {
        const g = await grantJobAccess(env, job.id, person, VENDOR_ROLE, { notify: false, access: grants.get(job.id), fetchImpl, now });
        grants.get(job.id).push({ email: person.email, role: g.role });
        const row = { ...base, state: g.state === 'there' ? 'there' : 'added', reason: null, person: { ...person, role: g.role || null, kept: !!g.kept, at } };
        await putRow(DB, row);
        if (row.state === 'added') report.added.push({ job: job.id, page: base.page, name: v.name, person: person.name, role: g.role, kept: !!g.kept });
      } catch (e) {
        report.waiting++;
        await putRow(DB, { ...base, state: 'waiting', reason: 'error', person: { ...person, error: String(e.message || e).slice(0, 200) } });
        report.problems.push(`Couldn’t add ${person.name} to ${base.page}’s job: ${e.message}`);
      }
    }
    if (report.added.length) {
      await logAudit(DB, { userEmail: SYNC_USER, action: 'updated', entityType: 'jobtread-access', entityName: 'Vendors on jobs', changes: { added: report.added.map((a) => `${a.person} (${a.name}): ${a.page}`) } });
    }
    // Then contacts, both ways, for every partner with an account (after access: that is what staff wait on)
    const siteTimes = new Map();
    try { for (const r of (await DB.prepare('SELECT partner, updated_at FROM partner_contacts').all()).results || []) siteTimes.set(r.partner, r.updated_at); } catch { /* no contacts saved yet */ }
    for (const [slug, a] of pairs) {
      if (only && nameKey(bySlug.get(slug)?.name) !== only) continue;
      const r = accountRows.get(slug);
      const site = contactsAll[slug] || [];
      const siteAt = siteTimes.get(slug) || null;
      const seen = r?.jt_seen && r?.site_seen ? { site: r.site_seen, jt: r.jt_seen, at: r.synced_at } : null;
      const plan = contactPlan({ site, siteAt, jt: a.contacts, seen });
      if (!plan.toSite && !plan.toJt) {
        if (!seen && (site.length || a.contacts.length)) await putAccountRow(DB, { ...r, jt_seen: a.contacts.map(tidy), site_seen: site.map(tidy), synced_at: at });
        continue;
      }
      if (!room()) { report.more = true; continue; }
      try {
        let jtAfter = a.contacts;
        let siteAfter = site;
        if (plan.toJt) {
          jtAfter = await writeJtContacts(key, a, plan.toJt, (seen?.site || []).filter((d) => !plan.toJt.some((p) => samePerson(tidy(p), tidy(d)))), fetchImpl);
          a.contacts = jtAfter;
        }
        if (plan.toSite) siteAfter = await saveContacts(DB, slug, plan.toSite, { by: SYNC_USER, source: 'jobtread', now });
        await putAccountRow(DB, { ...r, jt_seen: jtAfter.map(tidy), site_seen: siteAfter.map(tidy), synced_at: at });
        contactsAll[slug] = siteAfter;
        const to = [plan.toJt && 'JobTread', plan.toSite && 'Partners'].filter(Boolean).join(' and ');
        report.contacts.push({ partner: slug, name: bySlug.get(slug)?.name || a.name, to, people: (plan.toSite || plan.toJt).map((p) => p.name || 'unnamed') });
      } catch (e) { report.problems.push(`Couldn’t keep ${bySlug.get(slug)?.name || a.name}’s contacts in step: ${e.message}`); }
    }

    // Names only in the log: emails and phones stay in partner_contacts
    if (report.contacts.length) {
      await logAudit(DB, { userEmail: SYNC_USER, action: 'updated', entityType: 'partner-contacts', entityName: 'Vendor contacts', changes: { synced: report.contacts.map((c) => `${c.name} → ${c.to}: ${c.people.join(', ')}`) } });
    }

    // Waiting on a job that's closed now, or for a company that no longer belongs there: nothing to wait for
    if (!only) {
      for (const [rk, r] of rows) if (r.state === 'waiting' && !keep.has(rk)) await DB.prepare('DELETE FROM vendor_access WHERE job_id = ? AND company = ?').bind(r.job_id, r.company).run();
      const waitingNow = (await DB.prepare("SELECT count(DISTINCT company) AS n FROM vendor_access WHERE state = 'waiting'").first())?.n || 0;
      await patchKey(DB, 'state', {
        lastRunAt: at, lastError: report.problems.length ? { at, error: report.problems.slice(0, 3).join(' · ').slice(0, 300) } : null,
        lastRun: { at, added: report.added.length, made: report.made.length, contacts: report.contacts.length, waiting: waitingNow, near: Object.keys(near).length, more: report.more },
      });
    }
    return report;
  } catch (e) {
    console.error('[vendor-access]', e.message);
    if (!only) await patchKey(DB, 'state', { lastRunAt: at, lastError: { at, error: String(e.message || e).slice(0, 300) } }).catch(() => {});
    return { ...report, problems: [...report.problems, e.message] };
  } finally {
    await freeLock(DB, LOCK);
  }
}

/** Every 15 minutes from the heartbeat. Never throws. */
export async function maybeSyncVendorAccess(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(env.DB);
    const st = await readKey(env.DB, 'state');
    if (now - (Date.parse(st.claimedAt || 0) || 0) < RUN_EVERY_MS) return null;
    // Claim the slot first so overlapping heartbeats don't double up
    await patchKey(env.DB, 'state', { claimedAt: iso(now) });
    return await syncVendorAccess(env, { fetchImpl, now });
  } catch {
    return null;
  }
}

// ── The admin ────────────────────────────────────────────────────────
/**
 * Partners → JobTread access: { waiting: [{ company, name, partner, account,
 * reason, error, jobs: [{ jobId, record, page }] }], near: [{ partner, name,
 * near }], added (newest 30), setAside, paired, lastRunAt, lastRun, lastError }
 */
export async function adminView(DB) {
  await ensureSchema(DB);
  const [rows, st, near, setAside, paired] = await Promise.all([
    DB.prepare('SELECT * FROM vendor_access ORDER BY updated_at DESC').all().then((r) => r.results || []),
    readKey(DB, 'state'), readKey(DB, 'near'), readKey(DB, 'set-aside'),
    DB.prepare('SELECT count(*) AS n FROM vendor_accounts').first().then((r) => r?.n || 0),
  ]);
  const byCompany = new Map();
  for (const r of rows.filter((x) => x.state === 'waiting')) {
    const g = byCompany.get(r.company) || { company: r.company, name: r.name, partner: r.partner, account: r.account_id, reason: r.reason, error: null, jobs: [] };
    if (r.reason === 'error') { g.reason = 'error'; g.error = parse(r.person, {})?.error || null; }
    g.jobs.push({ jobId: r.job_id, record: r.record, page: r.page, why: r.why });
    byCompany.set(r.company, g);
  }
  const added = rows.filter((r) => r.state === 'added').map((r) => ({ ...r, person: parse(r.person, {}) }))
    .sort((a, b) => String(b.person?.at || b.updated_at).localeCompare(String(a.person?.at || a.updated_at))).slice(0, 30)
    .map((r) => ({ company: r.company, name: r.name, page: r.page, record: r.record, jobId: r.job_id, why: r.why, person: r.person?.name || null, role: r.person?.role || null, kept: !!r.person?.kept, at: r.person?.at || r.updated_at }));
  return {
    waiting: [...byCompany.values()].sort((a, b) => b.jobs.length - a.jobs.length || String(a.name).localeCompare(String(b.name))),
    near: Object.entries(near).map(([partner, n]) => ({ partner, ...n })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    added,
    setAside: Object.entries(setAside).map(([company, s]) => ({ company, ...s })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    paired, lastRunAt: st.lastRunAt || null, lastRun: st.lastRun || null, lastError: st.lastError || null,
  };
}

/** "Not needed": the company isn't put on any job (undo puts it back) */
export async function setCompanyAside(DB, { company, name = null, undo = false }, by = null, now = Date.now()) {
  await ensureSchema(DB);
  const list = await readKey(DB, 'set-aside');
  if (undo) delete list[company];
  else {
    const row = await DB.prepare('SELECT name FROM vendor_access WHERE company = ? LIMIT 1').bind(company).first();
    list[company] = { name: row?.name || name || company, by, at: iso(now) };
    await DB.prepare("DELETE FROM vendor_access WHERE company = ? AND state = 'waiting'").bind(company).run();
  }
  return writeKey(DB, 'set-aside', list);
}

/**
 * "Same company": JobTread's vendor `account` is this partner, for contacts
 * and every job after, and for logos (the "Same as" link). "Make a new one":
 * the next run makes the partner its own account.
 */
export async function settleAccount(DB, { partner, account = null, makeNew = false }) {
  await ensureSchema(DB);
  const near = await readKey(DB, 'near');
  const n = near[partner];
  if (!n) throw new Error('That one’s settled already');
  if (makeNew) await patchKey(DB, 'new-ok', { [partner]: true });
  else {
    const hit = (n.near || []).find((x) => x.id === account);
    if (!hit) throw new Error('JobTread doesn’t list that vendor for it');
    const name = hit.name.replace(/ \(archived\)$/, '');
    await putAccountRow(DB, { partner, account_id: hit.id, account_name: name, how: 'linked' });
    await setLink(DB, { company: nameKey(name), partner });
  }
  delete near[partner];
  await writeKey(DB, 'near', near);
  return { partner, name: n.name };
}
