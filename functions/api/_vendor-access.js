/**
 * Vendors on their JobTread jobs (Peter, Oct 28 2026)
 * ===========================================================================
 * Each open kid or community job lists its vendors in JobTread's job access:
 *   - each company whose logo is on the page (the kid's monetary sponsor
 *     aside: ./_sponsors.js puts its people on), and
 *   - each JobTread vendor with a bill or a purchase order on the job, from
 *     the vendors table's JobTread cache (jt_id + facts.jobs, every 4 hours)
 * A company is on the job when anyone from it has access, in any role: a
 * login under its JobTread account, one of its contacts' emails, or an email
 * on its website's domain. One that isn't gets its first contact with an
 * email (its main contact first, never a trade partner's insurance agent or
 * billing contact) added without JobTread's email (notify: false), in its
 * role: the partner's level, or Trade Partner (./_partner-roles.js; Vendor
 * until roles follow levels). With no email anywhere it waits in Partners →
 * JobTread access, and goes on once someone adds one.
 *
 * A JobTread vendor that isn't a partner goes on a job only when SOARD pays
 * it for work (isTradeVendor: JobTread's Trades, W-9 and Documents fields, or
 * a purchase order). A store bought from by card, or a materials supplier,
 * never does. A logo on a page that no partner or JobTread vendor goes by is
 * listed for staff instead (loose): nobody to put on the job until it's named.
 *
 * A company on a page with no JobTread vendor account gets one, under its
 * Partners name, once Partners has someone there with an email to put in it
 * (until then it waits, as staff often make the vendor in JobTread first).
 * When JobTread has a vendor by a near name ("WYP Construction" for Walk Your
 * Plans), or one whose name starts with every word of the other's ("MSI
 * Surfaces" for Msi), the sweep doesn't guess: staff say "Same company" (kept for every
 * job after, logos too) or "Make a new one".
 *
 * One company twice in JobTread (the same name, or one name starting with
 * every word of the other; never a place alone, "Atlanta") is put right with nobody asked: when one of the two accounts is
 * empty (no contacts, documents, files, access or bills), it's archived and
 * the partner it stood for moves to the other. One made in the last hour is
 * left a while, in case someone is still setting it up. Two that both hold
 * something, or a name that may be another organization ("Georgia Power
 * Foundation" and Georgia Power), are listed for staff instead.
 *
 * Contacts sync both ways between Partners (D1 partner_contacts, private,
 * ./_sponsors.js) and the vendor account's contacts (a vendor contact's
 * Email and Phone are JobTread fields of their own, not a family's). Each side's list is
 * kept as of the last sync; the side that changed since wins, and when both
 * did, the newer change: the website's is timed, JobTread's isn't, so it
 * counts from when the sweep first sees it. A contact staff take off in
 * Partners comes off the JobTread account too; JobTread's extras past the
 * five Partners keeps are left alone, and an email or phone JobTread has is
 * never blanked. Logos stay in Partners: JobTread accounts have no logo.
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
import { pave, grantJobAccess, revokeJobAccess } from './_jt-access.js';
import { readContacts, saveContacts, isEmail } from './_sponsors.js';
import { logAudit } from './_audit.js';
import { roleMode, reconcileRoles, rolesView, readMemberships, OLD_VENDOR_ROLE } from './_partner-roles.js';
import { nameKey, wordsKey, domainOf, isSocial, kidUsage, nearPartners } from '../../public/admin/partners-shared.js';

export const VENDOR_ROLE = OLD_VENDOR_ROLE;
const RUN_EVERY_MS = 15 * 60 * 1000;
const WRITE_BUDGET_MS = 20 * 1000;
const MAX_GRANTS = 12;
const MAX_NEW_ACCOUNTS = 5;
const MAX_COMBINE = 10;
const SETTING_UP_MS = 60 * 60 * 1000; // an account this new may still be being set up: never archived
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
/** 'not-same': { [partner]: { [account id]: { name, how, by, at } } }: matches staff undid, never made again by the sweep */
const notSameIds = (notSame, slug) => Object.keys(notSame?.[slug] || {});
/**
 * 'copied': { [partner]: { account, site: [person key], jt: [contact id] } }: what the contact sync copied
 * across (people into Partners from that JobTread account, contacts it made there), so "Not the same" can take them back
 */
const personKey = (p) => (p.email ? p.email : `n:${nameKey(p.name)}`);

// ── JobTread vendor accounts ─────────────────────────────────────────
/**
 * A vendor contact's Email and Phone fields: { email, phone } (ids). They're
 * JobTread fields of their own (target 'vendorContact'), apart from a
 * family's (./_applicant-comms.js), which JobTread refuses on a vendor's
 * contact; ./_vendors.js finds them the same way, and makes them when missing.
 */
let contactFieldIds = null;
export const _resetContactFields = () => { contactFieldIds = null; };
export async function vendorContactFields(grantKey, fetchImpl = fetch) {
  if (contactFieldIds) return contactFieldIds;
  const body = await pave(grantKey, {
    organization: { $: { id: SOARD_ORG_ID }, customFields: { $: { size: 50, where: ['targetType', '=', 'vendorContact'] }, nodes: { id: {}, name: {}, type: {} } } },
  }, fetchImpl);
  const cf = body?.organization?.customFields?.nodes || [];
  const pick = (type, re) => (cf.find((x) => x.type === type && re.test(x.name || '')) || cf.find((x) => x.type === type) || cf.find((x) => re.test(x.name || '')))?.id || null;
  const ids = { email: pick('emailAddress', /e-?mail/i), phone: pick('phoneNumber', /phone|cell|mobile/i) };
  if (ids.email) contactFieldIds = ids;
  return ids;
}
const contactSel = (ids) => {
  const fields = [ids.email, ids.phone].filter(Boolean);
  return {
    id: {}, name: {}, title: {}, createdAt: {},
    ...(fields.length ? { customFieldValues: { $: { size: 2, where: [['customField', 'id'], 'in', fields] }, nodes: { createdAt: {}, value: {}, customField: { id: {} } } } } : {}),
  };
};
function contactOf(c, ids) {
  const vals = c.customFieldValues?.nodes || [];
  const email = lower((vals.find((x) => x.customField?.id === ids.email) || vals.find((x) => isEmail(lower(x.value))))?.value);
  const phone = vals.find((x) => x.customField?.id === ids.phone)?.value;
  const at = [c.createdAt, ...vals.map((x) => x.createdAt)].filter(Boolean).sort().at(-1) || null;
  return { id: c.id, name: String(c.name || '').trim(), title: String(c.title || '').trim(), email: isEmail(email) ? email : '', phone: String(phone || '').trim(), at };
}
// JobTread's phone fields take a US number as +1 and ten digits
const e164 = (s) => { const d = String(s || '').replace(/\D/g, ''); const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return /^[2-9]\d{9}$/.test(t) ? `+1${t}` : null; };

/**
 * What JobTread's own vendor fields say (./_vendors.js makes and keeps
 * them, by these names): { materials, docs, w9, trades: [] }
 */
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? '').trim());
const listOf = (v) => {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? '').trim();
  if (s.startsWith('[')) return parse(s, []).map(String);
  return s ? s.split(/\s*[,;]\s*/) : [];
};
export function vendorFacts(nodes) {
  const by = new Map((nodes || []).map((n) => [lower(n.customField?.name), n.value]));
  return { materials: truthy(by.get('materials only')), docs: String(by.get('documents') ?? '').trim(), w9: truthy(by.get('w-9')), trades: listOf(by.get('trades')).filter(Boolean) };
}
/**
 * A JobTread vendor SOARD pays for work, a sub: never "Materials only" or
 * Documents "Not needed"; otherwise Trades (other than only "Materials and
 * supplies"), the W-9, a Documents state, or a purchase order. Card-only
 * stores (Amazon, a restaurant, a permit office) have none of these.
 */
export function isTradeVendor(a, { order = false } = {}) {
  const f = a?.facts || {};
  if (f.materials || lower(f.docs) === 'not needed') return false;
  return !!(order || f.w9 || f.docs || (f.trades || []).some((t) => lower(t) !== 'materials and supplies'));
}

/** SOARD's JobTread vendors: [{ id, name, archived, createdAt, primary, contacts: [{ id, name, title, email, phone, at }], facts }] */
export async function fetchVendorAccounts(grantKey, fetchImpl = fetch, ids = null) {
  ids ||= await vendorContactFields(grantKey, fetchImpl);
  const out = [];
  let page = null;
  for (let i = 0; i < MAX_ACCOUNT_PAGES; i++) {
    const body = await pave(grantKey, {
      organization: {
        $: { id: SOARD_ORG_ID },
        accounts: {
          $: { size: ACCOUNTS_PAGE, where: ['type', '=', 'vendor'], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, name: {}, archivedAt: {}, createdAt: {}, primaryContact: { id: {} }, contacts: { $: { size: MAX_PEOPLE }, nodes: contactSel(ids) },
            customFieldValues: { $: { size: 25 }, nodes: { value: {}, customField: { name: {} } } },
          },
        },
      },
    }, fetchImpl);
    const conn = body?.organization?.accounts;
    if (!conn) throw new Error('JobTread sent no vendor accounts');
    for (const a of conn.nodes || []) {
      out.push({
        id: a.id, name: String(a.name || '').trim(), archived: !!a.archivedAt, createdAt: a.createdAt || null, primary: a.primaryContact?.id || null,
        contacts: (a.contacts?.nodes || []).map((c) => contactOf(c, ids)), facts: vendorFacts(a.customFieldValues?.nodes),
      });
    }
    page = conn.nextPage || null;
    if (!page) break;
  }
  return out;
}

const jtFields = (p, ids) => ({
  ...(p.email && ids.email ? { [ids.email]: p.email } : {}),
  ...(e164(p.phone) && ids.phone ? { [ids.phone]: e164(p.phone) } : {}),
});
async function createAccount(grantKey, name, fetchImpl) {
  const body = await pave(grantKey, { createAccount: { $: { organizationId: SOARD_ORG_ID, name, type: 'vendor' }, createdAccount: { id: {}, name: {} } } }, fetchImpl);
  const a = body?.createAccount?.createdAccount;
  if (!a?.id) throw new Error('JobTread didn’t say it made the account');
  return { id: a.id, name: a.name || name, archived: false, createdAt: new Date().toISOString(), primary: null, contacts: [], facts: vendorFacts([]) };
}
async function createContact(grantKey, accountId, p, ids, fetchImpl) {
  const $ = { accountId, name: p.name || p.email, ...(p.title ? { title: p.title } : {}) };
  const fields = jtFields(p, ids);
  let body;
  try {
    body = await pave(grantKey, { createContact: { $: { ...$, customFieldValues: fields }, createdContact: { id: {} } } }, fetchImpl);
  } catch (e) {
    // A phone JobTread won't take shouldn't keep the person out
    if (!fields[ids.phone] || !/phone/i.test(e.message)) throw e;
    delete fields[ids.phone];
    body = await pave(grantKey, { createContact: { $: { ...$, customFieldValues: fields }, createdContact: { id: {} } } }, fetchImpl);
  }
  const id = body?.createContact?.createdContact?.id;
  if (!id) throw new Error('JobTread didn’t say it made the contact');
  return id;
}
// An email or phone JobTread has is never blanked: the website's list may just not have it
async function updateContact(grantKey, c, p, ids, fetchImpl) {
  const $ = { id: c.id };
  if (p.name && p.name !== c.name) $.name = p.name;
  if ((p.title || '') !== (c.title || '')) $.title = p.title || '';
  const fields = {};
  if (p.email && p.email !== c.email && ids.email) fields[ids.email] = p.email;
  if (e164(p.phone) && digits(p.phone) !== digits(c.phone) && ids.phone) fields[ids.phone] = e164(p.phone);
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
async function writeJtContacts(grantKey, account, target, dropped, ids, fetchImpl) {
  const left = [...account.contacts];
  const after = [];
  const take = (p, test) => { const i = left.findIndex((c) => test(c, p)); return i < 0 ? null : left.splice(i, 1)[0]; };
  // Email matches first, so a name match never takes someone else's contact
  const pairs = target.map((p) => [p, p.email ? take(p, (c, x) => c.email && c.email === x.email) : null]);
  for (const pair of pairs) if (!pair[1]) pair[1] = take(pair[0], (c, x) => !!nameKey(c.name) && nameKey(c.name) === nameKey(x.name) && (!c.email || !x.email || c.email === x.email));
  for (const [p, c] of pairs) {
    if (c) { await updateContact(grantKey, c, p, ids, fetchImpl); after.push({ ...c, ...p, email: p.email || c.email, phone: p.phone || c.phone }); }
    else after.push({ id: await createContact(grantKey, account.id, p, ids, fetchImpl), ...p, at: null });
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
export function pairAccounts(partners, accounts, { saved = {}, links = {}, notSame = {} } = {}) {
  const live = accounts.filter((a) => !a.archived);
  // A pair staff settled holds even once JobTread archives the account
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const slugs = new Set(partners.map((p) => p.slug));
  const out = new Map();
  const taken = new Set();
  const pair = (slug, a) => { out.set(slug, a); taken.add(a.id); };
  // One staff said is "Not the same" never pairs again, by any route
  const may = (slug, a) => !notSameIds(notSame, slug).includes(a.id);
  for (const [slug, id] of Object.entries(saved)) if (slugs.has(slug) && byId.has(id) && !taken.has(id) && may(slug, byId.get(id))) pair(slug, byId.get(id));
  for (const a of live) {
    const slug = links[nameKey(a.name)];
    if (slug && slugs.has(slug) && !out.has(slug) && !taken.has(a.id) && may(slug, a)) pair(slug, a);
  }
  for (const p of partners) {
    if (out.has(p.slug)) continue;
    const hits = live.filter((a) => !taken.has(a.id) && may(p.slug, a) && sameName(a.name, p.name)).sort((x, y) => y.contacts.length - x.contacts.length);
    if (hits.length) pair(p.slug, hits[0]);
  }
  return out;
}

/**
 * A page's vendors: [{ company, name, partner, account, why: Set('page','bill') }].
 * bills: the JobTread vendor account ids with a bill or order on the job.
 * trade(account): a vendor that isn't a partner belongs on the job only when
 * SOARD pays it for work. loose: gets the page's logos no partner or
 * JobTread vendor goes by (nobody to put on the job until one does).
 */
export function jobVendors(rec, { partners, pairs, accounts, bills = [], trade = () => true, loose = null }) {
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
    if (!a) { loose?.push(String(l.name).trim()); continue; }
    add({ company: nameKey(String(l.name).trim()), name: String(l.name).trim(), partner: null, account: a }, 'page');
  }
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of bills) {
    const a = byId.get(id);
    if (!a || a.archived) continue;
    const slug = accountOf.get(id);
    if (slug && sponsors.has(slug)) continue;
    const p = slug ? bySlug.get(slug) : null;
    if (!p && !trade(a)) continue;
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

// A trade partner's insurance agent and billing contact (./_trade-partners.js) are never put on a job or copied into Partners
const OFF_JOBS = new Set(['insurance agent', 'billing']);
export const forJobs = (c) => !OFF_JOBS.has(lower(c?.title));

/** Who to add: the account's main contact with an email, its primary, its first with one, then Partners' */
export function personFor(v, people = []) {
  const jt = (v.account?.contacts || []).filter(forJobs);
  const p = jt.find((c) => lower(c.title) === 'main contact' && c.email) || jt.find((c) => c.id === v.account?.primary && c.email) || jt.find((c) => c.email)
    || people.filter(forJobs).find((c) => isEmail(c.email));
  return p ? { name: p.name || v.name, email: lower(p.email) } : null;
}

// ── One company twice in JobTread ────────────────────────────────────
const FILLER = new Set(['the', 'and', 'of', 'inc', 'llc', 'co', 'corp', 'company', 'group', 'ltd',
  'a', 'an', 'incorporated', 'corporation', 'limited', 'llp', 'lp', 'pllc', 'pc']);
// A name of only these is a place, not a company: "Atlanta" isn't Blu Site Solutions of Atlanta
const PLACE_WORDS = new Set(['atlanta', 'atl', 'georgia', 'ga', 'metro', 'greater', 'downtown', 'midtown', 'east', 'west', 'north', 'south',
  'northeast', 'northwest', 'southeast', 'southwest', 'central', 'city', 'county', 'usa', 'america', 'american', 'national', 'southern']);
/** A name's words in order, the/and/of/inc/llc/co/company… aside */
const wordsOf = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
  .split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w));
const within = (x, y) => {
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return !short.every((w) => PLACE_WORDS.has(w)) && short.every((w, i) => long[i] === w);
};
/** One name starts with every word of the other, in order ("Msi" and "MSI Surfaces"), the/inc/llc/co/company… aside */
export const sameWords = (a, b) => within(wordsOf(a), wordsOf(b));
// A word that makes another organization of the same name: Georgia Power Foundation isn't Georgia Power
const KIND_WORDS = new Set(['foundation', 'fund', 'family', 'trust', 'church', 'ministry', 'ministries', 'charity', 'charities', 'association', 'society',
  'club', 'school', 'academy', 'university', 'college', 'institute', 'league', 'auxiliary', 'chapter']);
const otherKind = (x, y) => [...x.filter((w) => !y.includes(w)), ...y.filter((w) => !x.includes(w))].some((w) => KIND_WORDS.has(w));
export const twinKey = (a, b) => [a, b].sort().join(' ');

/**
 * Pairs of live JobTread vendor accounts that look like one company: the same
 * name, or one name starting with every word of the other. Never two Partners has as two
 * partners, one staff said isn't the partner the other is ("Not the same"),
 * or two staff said aren't one company (notTwins).
 * → [{ a, b, same (the same name), check (a word that may make it another organization) }]
 */
export function twinAccounts(accounts, { pairs = new Map(), notSame = {}, notTwins = {} } = {}) {
  const partnerOf = new Map([...pairs].map(([slug, a]) => [a.id, slug]));
  const live = accounts.filter((a) => !a.archived).map((a) => ({ a, key: nameKey(a.name), wk: wordsKey(a.name), w: wordsOf(a.name) }));
  const out = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const [x, y] = [live[i], live[j]];
      const same = (!!x.key && x.key === y.key) || (!!x.wk && x.wk === y.wk);
      if (!same && !within(x.w, y.w)) continue;
      if (notTwins[twinKey(x.a.id, y.a.id)]) continue;
      const [px, py] = [partnerOf.get(x.a.id), partnerOf.get(y.a.id)];
      if (px && py && px !== py) continue;
      if ((px && notSameIds(notSame, px).includes(y.a.id)) || (py && notSameIds(notSame, py).includes(x.a.id))) continue;
      out.push({ a: x.a, b: y.a, same, check: !same && otherKind(x.w, y.w) });
    }
  }
  return out;
}

/** What accounts hold in JobTread: Map(id → { contacts, documents, files, aces }) */
async function accountHolds(grantKey, ids, fetchImpl) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 25) {
    const q = Object.fromEntries(ids.slice(i, i + 25).map((id, k) => [`a${k}`, {
      _: 'account', $: { id }, id: {}, contacts: { count: {} }, documents: { count: {} }, files: { count: {} }, aces: { count: {} },
    }]));
    const body = await pave(grantKey, q, fetchImpl);
    for (const a of Object.values(body || {})) {
      if (a?.id) out.set(a.id, { contacts: a.contacts?.count || 0, documents: a.documents?.count || 0, files: a.files?.count || 0, aces: a.aces?.count || 0 });
    }
  }
  return out;
}
export const isEmptyAccount = (h) => !!h && !h.contacts && !h.documents && !h.files && !h.aces && !h.logins && !h.bills;

/**
 * What to do with twins: { combine: [{ keep, drop, partner }], ask: [{ a, b, partner, why, canCombine }] }.
 * holds: Map(id → what it holds, logins and bills too). An empty account goes and the other keeps
 * its partner; both empty, the one no partner goes by goes, else the one the site made, else the
 * newer. One made in the last hour waits. Asked (why): both hold something ('full'), a word that
 * may make it another organization ('check'), or an empty partner account with two to go to ('which').
 */
export function twinPlan(twins, { holds, pairs = new Map(), made = new Set(), now = Date.now() }) {
  const partnerOf = new Map([...pairs].map(([slug, a]) => [a.id, slug]));
  const empty = (a) => isEmptyAccount(holds.get(a.id));
  const settingUp = (a) => now - (Date.parse(a.createdAt || 0) || 0) < SETTING_UP_MS;
  const age = (a) => Date.parse(a.createdAt || 0) || 0;
  const ask = new Map();
  const put = (t, why) => ask.set(twinKey(t.a.id, t.b.id), { a: t.a, b: t.b, partner: partnerOf.get(t.a.id) || partnerOf.get(t.b.id) || null, why, canCombine: empty(t.a) || empty(t.b) });
  const byDrop = new Map();
  for (const t of twins) {
    const [ea, eb] = [empty(t.a), empty(t.b)];
    if (!ea && !eb) { put(t, 'full'); continue; }
    if (t.check) { put(t, 'check'); continue; }
    let drop = ea ? t.a : t.b;
    if (ea && eb) {
      const [pa, pb] = [partnerOf.has(t.a.id), partnerOf.has(t.b.id)];
      const [ma, mb] = [made.has(t.a.id), made.has(t.b.id)];
      drop = pa !== pb ? (pa ? t.b : t.a) : ma !== mb ? (ma ? t.a : t.b) : age(t.a) >= age(t.b) ? t.a : t.b;
    }
    const keep = drop === t.a ? t.b : t.a;
    const list = byDrop.get(drop.id) || { drop, keeps: [] };
    list.keeps.push({ keep, t });
    byDrop.set(drop.id, list);
  }
  const combine = [];
  const gone = new Set();
  // Drops whose twin keeps something first, so a chain of empty ones ends on the full one
  const order = [...byDrop.values()].sort((x, y) => Number(x.keeps.every((k) => empty(k.keep))) - Number(y.keeps.every((k) => empty(k.keep))));
  for (const { drop, keeps } of order) {
    if (settingUp(drop)) continue;
    const open = keeps.filter((k) => !gone.has(k.keep.id));
    if (!open.length) continue;
    const partner = partnerOf.get(drop.id) || null;
    let pick = open.length === 1 ? open[0] : null;
    if (!pick && partner) {
      const same = open.filter((k) => k.t.same);
      if (same.length === 1) pick = same[0];
      else { for (const k of open) put(k.t, 'which'); continue; }
    }
    pick ||= open[0];
    gone.add(drop.id);
    combine.push({ keep: pick.keep, drop, partner });
  }
  for (const c of combine) ask.delete(twinKey(c.keep.id, c.drop.id));
  return { combine, ask: [...ask.values()].filter((q) => !gone.has(q.a.id) && !gone.has(q.b.id)) };
}

const archiveAccount = (grantKey, id, archive, fetchImpl) => pave(grantKey, { updateAccount: { $: { id, archive, notify: false } } }, fetchImpl);

/**
 * One company twice: `drop` (empty) is archived in JobTread and the partner it
 * stood for moves to `keep`. Kept in 'combined', so "Not the same" takes it back.
 */
async function combineTwin(env, { keep, drop, partner }, { accountRows = null, fetchImpl = fetch, at, by }) {
  const { DB } = env;
  await archiveAccount(env.JOBTREAD_GRANT_KEY, drop.id, true, fetchImpl);
  drop.archived = true;
  if (partner) {
    const r = { partner, account_id: keep.id, account_name: keep.name, how: 'name' };
    await putAccountRow(DB, r);
    accountRows?.set(partner, r);
  }
  const combined = await readKey(DB, 'combined');
  combined[twinKey(keep.id, drop.id)] = { keep: { id: keep.id, name: keep.name }, drop: { id: drop.id, name: drop.name }, partner: partner || null, at, by };
  const newest = Object.entries(combined).sort(([, x], [, y]) => String(y.at).localeCompare(String(x.at))).slice(0, 60);
  await writeKey(DB, 'combined', Object.fromEntries(newest));
}
const holdsOut = (a, h) => ({ id: a.id, name: a.name, holds: { contacts: h?.contacts || 0, documents: h?.documents || 0, files: h?.files || 0, access: (h?.aces || 0) + (h?.logins || 0), bills: h?.bills || 0 } });

// ── The sweep ────────────────────────────────────────────────────────
async function readPartners(DB) {
  const rows = (await DB.prepare('SELECT slug, data FROM partners').all()).results || [];
  return rows.map((r) => ({ slug: r.slug, ...(parse(r.data || '{}', {}) || {}) })).map((p) => ({ ...p, name: p.name || p.slug }));
}
/**
 * Which JobTread vendors have a bill or order on which job, from the vendors
 * table's JobTread cache (only jt_id and facts.jobs are read):
 * { byJob: Map(job id → [account id]), orders: Set(account id with a purchase order) }
 */
async function billsByJob(DB) {
  const byJob = new Map();
  const orders = new Set();
  let rows = [];
  try { rows = (await DB.prepare('SELECT jt_id, facts FROM vendors WHERE jt_id IS NOT NULL').all()).results || []; } catch { return { byJob, orders }; }
  for (const r of rows) {
    for (const j of parse(r.facts, {})?.jobs || []) {
      if (!j?.jobId) continue;
      if (j.order) orders.add(r.jt_id);
      const list = byJob.get(j.jobId) || [];
      if (!list.includes(r.jt_id)) list.push(r.jt_id);
      byJob.set(j.jobId, list);
    }
  }
  return { byJob, orders };
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
  const report = { added: [], waiting: 0, made: [], combined: [], contacts: [], more: false, problems: [] };
  if (!DB || !key) return report;
  await ensureSchema(DB);
  if (!(await takeLock(DB, !!only, LOCK))) return { ...report, busy: true };
  const room = () => Date.now() - started < WRITE_BUDGET_MS;
  try {
    const fields = await vendorContactFields(key, fetchImpl);
    if (!fields.email) report.problems.push('JobTread has no Email field for vendor contacts, so their emails can’t be read');
    const [jobs, kids, projects, partners, contactsAll, links, accountRows, rows, { byJob: bills, orders }, accounts, setAside, newOk, notSame, notTwins, mode] = await Promise.all([
      fetchOpenJobs(key, fetchImpl), loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readContacts(DB), readLinks(DB),
      readAccountRows(DB), readRows(DB), billsByJob(DB), fetchVendorAccounts(key, fetchImpl, fields), readKey(DB, 'set-aside'), readKey(DB, 'new-ok'), readKey(DB, 'not-same'),
      readKey(DB, 'not-twins'), roleMode(env, { fetchImpl }),
    ]);
    const trade = (a) => isTradeVendor(a, { order: orders.has(a?.id) });
    const records = [...kids, ...projects];
    const byKey = new Map(records.map((r) => [keyOf(r), r]));
    const bySlug = new Map(partners.map((p) => [p.slug, p]));
    // A run that was mid-way when staff said "Not the same" may have written that pair back
    for (const [slug, r] of accountRows) {
      if (!notSameIds(notSame, slug).includes(r.account_id)) continue;
      await DB.prepare('DELETE FROM vendor_accounts WHERE partner = ? AND account_id = ?').bind(slug, r.account_id).run();
      accountRows.delete(slug);
    }
    const savedPairs = () => Object.fromEntries([...accountRows].map(([slug, r]) => [slug, r.account_id]));
    let pairs = pairAccounts(partners, accounts, { saved: savedPairs(), links, notSame });

    // One company twice in JobTread: an empty account goes, and the partner it stood for moves to the other
    if (!only) {
      const twins = twinAccounts(accounts, { pairs, notSame, notTwins });
      // A partner's website another company's emails don't match: two companies, maybe, so staff say
      const partnerOf = new Map([...pairs].map(([slug, a]) => [a.id, slug]));
      for (const t of twins) {
        const slug = partnerOf.get(t.a.id) || partnerOf.get(t.b.id);
        const site = slug && bySlug.get(slug)?.website && !isSocial(bySlug.get(slug).website) ? domainOf(bySlug.get(slug).website) : '';
        const other = partnerOf.get(t.a.id) ? t.b : t.a;
        const mail = [...new Set(other.contacts.map((c) => domainOfEmail(c.email)).filter((d) => d && !FREE_MAIL.has(d)))];
        if (site && mail.length && !mail.some((d) => sameSite(d, site))) t.check = true;
      }
      try {
        const holds = twins.length ? await accountHolds(key, [...new Set(twins.flatMap((t) => [t.a.id, t.b.id]))], fetchImpl) : new Map();
        const billed = new Set([...orders, ...[...bills.values()].flat()]);
        for (const [id, h] of holds) h.bills = billed.has(id) ? 1 : 0;
        // Logins under an account, read only when one may go
        if ([...holds.values()].some(isEmptyAccount)) {
          const logins = new Map();
          for (const m of await readMemberships(key, fetchImpl)) if (m.account?.id) logins.set(m.account.id, (logins.get(m.account.id) || 0) + 1);
          for (const [id, h] of holds) h.logins = logins.get(id) || 0;
        }
        const made = new Set([...accountRows.values()].filter((r) => r.how === 'made').map((r) => r.account_id));
        const plan = twinPlan(twins, { holds, pairs, made, now });
        for (const c of plan.combine) {
          if (report.combined.length >= MAX_COMBINE || !room()) { report.more = true; break; }
          try {
            await combineTwin(env, c, { accountRows, fetchImpl, at, by: SYNC_USER });
            report.combined.push({ kept: c.keep.name, archived: c.drop.name, partner: c.partner ? bySlug.get(c.partner)?.name || c.partner : null });
          } catch (e) { report.problems.push(`Couldn’t archive ${c.drop.name} in JobTread: ${e.message}`); }
        }
        await writeKey(DB, 'twins', plan.ask.map((q) => ({
          key: twinKey(q.a.id, q.b.id), partner: q.partner, name: q.partner ? bySlug.get(q.partner)?.name || null : null, why: q.why, canCombine: q.canCombine,
          a: holdsOut(q.a, holds.get(q.a.id)), b: holdsOut(q.b, holds.get(q.b.id)),
        })));
      } catch (e) { report.problems.push(`Couldn’t look for one company twice in JobTread: ${e.message}`); }
      if (report.combined.length) {
        await logAudit(DB, { userEmail: SYNC_USER, action: 'updated', entityType: 'jobtread-vendor', entityName: 'One company twice in JobTread',
          changes: { archived: report.combined.map((c) => `${c.archived} (the same as ${c.kept})`) } });
        pairs = pairAccounts(partners, accounts, { saved: savedPairs(), links, notSame });
      }
    }
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
    const loose = []; // logos nobody goes by: [{ name, record, page }]
    for (const [k, job] of linked) {
      const rec = byKey.get(k);
      const names = [];
      for (const v of jobVendors(rec, { partners, pairs, accounts, bills: bills.get(job.id) || [], trade, loose: names })) {
        if (only && v.company !== only) continue;
        if (setAside[v.company]) continue;
        want.push({ k, rec, job, v });
      }
      for (const name of new Set(names)) loose.push({ name, record: k, page: pageName(rec) });
    }

    // A company on a page with no JobTread vendor account gets one, once there's someone to put in it; a near name waits for staff
    const needAccounts = [...new Map(want.filter((w) => w.v.partner && !w.v.account && w.v.why.has('page')).map((w) => [w.v.partner, w.v])).values()];
    const near = {};
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const paired = new Set([...pairs.values()].map((a) => a.id));
    for (const v of needAccounts) {
      const not = notSameIds(notSame, v.partner);
      const was = not.map((id) => ({ id, name: byId.get(id)?.name || notSame[v.partner][id]?.name || '' })).filter((x) => x.name);
      const open = live.filter((a) => !not.includes(a.id) && !paired.has(a.id));
      // Every word of one name in the other ("MSI Surfaces" for Msi), then one archived under the same name: staff choose, never a second account by itself
      const holding = open.filter((a) => sameWords(a.name, v.name)).map((a) => ({ partner: { slug: a.id, name: a.name }, why: 'Starts with the name' }));
      const archived = accounts.filter((a) => a.archived && !not.includes(a.id) && sameName(a.name, v.name)).map((a) => ({ partner: { slug: a.id, name: `${a.name} (archived)` }, why: 'Archived in JobTread' }));
      const close = [...new Map([...holding, ...archived, ...nearPartners(v.name, open.map((a) => ({ slug: a.id, name: a.name })), { min: 0.6, max: 2 })]
        .map((c) => [c.partner.slug, c])).values()].slice(0, 2);
      // Staff said the match was wrong: they pick another near name or a new vendor, never the sweep
      if ((close.length || was.length) && !newOk[v.partner]) {
        near[v.partner] = { name: v.name, near: close.map((c) => ({ id: c.partner.slug, name: c.partner.name, why: c.why })), ...(was.length ? { was } : {}) };
        continue;
      }
      // An empty account helps nobody: it's made once Partners has someone there with an email
      if (!(contactsAll[v.partner] || []).some((p) => isEmail(p.email) && forJobs(p))) continue;
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
    else if (needAccounts.length) {
      // Just this company: its question is asked (or settled) now; the rest wait for the full run
      const all = await readKey(DB, 'near');
      for (const v of needAccounts) { if (near[v.partner]) all[v.partner] = near[v.partner]; else delete all[v.partner]; }
      await writeKey(DB, 'near', all);
    }
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
        // A partner's role is its level (once roles follow levels); a sub that isn't one is a Trade Partner
        const role = v.partner ? mode.partner(bySlug.get(v.partner)) : mode.trade;
        const g = await grantJobAccess(env, job.id, person, role, { notify: false, access: grants.get(job.id), fetchImpl, now });
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
    const copied = await readKey(DB, 'copied');
    let copiedChanged = false;
    // Until Oct 30 2026 the sweep read a family's email field on vendor contacts, so it never saw their
    // emails: each partner's two lists are put together afresh once (nobody dropped), then kept as before
    const reread = await readKey(DB, 'contact-fields');
    let rereadChanged = false;
    for (const [slug, a] of pairs) {
      if (only && nameKey(bySlug.get(slug)?.name) !== only) continue;
      const r = accountRows.get(slug);
      const site = contactsAll[slug] || [];
      const siteAt = siteTimes.get(slug) || null;
      const fresh = !!fields.email && !reread[slug];
      const seen = !fresh && r?.jt_seen && r?.site_seen && r?.account_id === a.id ? { site: r.site_seen, jt: r.jt_seen, at: r.synced_at } : null;
      const done = () => { if (fresh) { reread[slug] = at; rereadChanged = true; } };
      // A trade partner's insurance agent and billing contact stay in JobTread only
      const jtPeople = a.contacts.filter(forJobs);
      const plan = contactPlan({ site, siteAt, jt: jtPeople, seen });
      if (!plan.toSite && !plan.toJt) {
        if (!seen && (site.length || jtPeople.length)) await putAccountRow(DB, { ...r, jt_seen: jtPeople.map(tidy), site_seen: site.map(tidy), synced_at: at });
        done();
        continue;
      }
      if (!room()) { report.more = true; continue; }
      try {
        const jtBefore = a.contacts;
        let jtAfter = a.contacts;
        let siteAfter = site;
        if (plan.toJt) {
          jtAfter = await writeJtContacts(key, a, plan.toJt, (seen?.site || []).filter((d) => !plan.toJt.some((p) => samePerson(tidy(p), tidy(d)))), fields, fetchImpl);
          a.contacts = jtAfter;
        }
        if (plan.toSite) siteAfter = await saveContacts(DB, slug, plan.toSite, { by: SYNC_USER, source: 'jobtread', now });
        // What crossed over, in case staff say later it was the wrong company
        const c = copied[slug]?.account === a.id ? copied[slug] : { account: a.id, site: [], jt: [] };
        const newToSite = siteAfter.map(tidy).filter((p) => !site.some((q) => samePerson(tidy(q), p))).map(personKey);
        const madeInJt = jtAfter.filter((x) => x.id && !jtBefore.some((y) => y.id === x.id)).map((x) => x.id);
        if (newToSite.length || madeInJt.length) {
          copied[slug] = { account: a.id, site: [...new Set([...c.site, ...newToSite])], jt: [...new Set([...c.jt, ...madeInJt])] };
          copiedChanged = true;
        }
        await putAccountRow(DB, { ...r, jt_seen: jtAfter.filter(forJobs).map(tidy), site_seen: siteAfter.map(tidy), synced_at: at });
        contactsAll[slug] = siteAfter;
        done();
        const to = [plan.toJt && 'JobTread', plan.toSite && 'Partners'].filter(Boolean).join(' and ');
        report.contacts.push({ partner: slug, name: bySlug.get(slug)?.name || a.name, to, people: (plan.toSite || plan.toJt).map((p) => p.name || 'unnamed') });
      } catch (e) { report.problems.push(`Couldn’t keep ${bySlug.get(slug)?.name || a.name}’s contacts in step: ${e.message}`); }
    }

    if (copiedChanged) await writeKey(DB, 'copied', copied);
    if (rereadChanged) await writeKey(DB, 'contact-fields', reread);
    // Names only in the log: emails and phones stay in partner_contacts
    if (report.contacts.length) {
      await logAudit(DB, { userEmail: SYNC_USER, action: 'updated', entityType: 'partner-contacts', entityName: 'Vendor contacts', changes: { synced: report.contacts.map((c) => `${c.name} → ${c.to}: ${c.people.join(', ')}`) } });
    }

    // Roles: each partner's is its level, a sub's Trade Partner (./_partner-roles.js; only writes down the changes until it's on)
    if (!only) {
      const contactPartner = new Map();
      for (const [slug, list] of Object.entries(contactsAll)) for (const p of list || []) if (isEmail(p.email) && !contactPartner.has(lower(p.email))) contactPartner.set(lower(p.email), slug);
      try {
        report.roles = await reconcileRoles(env, {
          bySlug, accountPartner: new Map([...pairs].map(([slug, a]) => [a.id, slug])), contactPartner, links, freeMail: FREE_MAIL,
          trade: (id) => trade(byId.get(id)),
        }, { fetchImpl, now, room });
        if (report.roles.error) report.problems.push(`Roles: ${report.roles.error}`);
      } catch (e) { report.problems.push(`Roles: ${e.message}`); }
    }

    // Waiting on a job that's closed now, or for a company that no longer belongs there: nothing to wait for
    if (!only) {
      for (const [rk, r] of rows) if (r.state === 'waiting' && !keep.has(rk)) await DB.prepare('DELETE FROM vendor_access WHERE job_id = ? AND company = ?').bind(r.job_id, r.company).run();
      const waitingNow = (await DB.prepare("SELECT count(DISTINCT company) AS n FROM vendor_access WHERE state = 'waiting'").first())?.n || 0;
      await writeKey(DB, 'loose', loose);
      await patchKey(DB, 'state', {
        lastRunAt: at, lastError: report.problems.length ? { at, error: report.problems.slice(0, 3).join(' · ').slice(0, 300) } : null,
        lastRun: { at, added: report.added.length, made: report.made.length, combined: report.combined.length, contacts: report.contacts.length, waiting: waitingNow, near: Object.keys(near).length, more: report.more,
          ...(report.roles ? { roles: report.roles } : {}) },
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
 * near, was? }], added (newest 30), setAside, matched: [{ partner, name, account,
 * accountName, how }] (named differently first), paired, lastRunAt, lastRun, lastError,
 * loose: [{ name, record, page }] (logos nobody goes by), billedOnly: [{ partner, name }],
 * twins: [{ key, partner, name, why, canCombine, a, b }] (one company twice in JobTread, for staff),
 * combined: [{ key, keep, drop, partner, name, at }] (the empty twin the site archived, newest 30),
 * roles (./_partner-roles.js rolesView) }
 */
export async function adminView(DB) {
  await ensureSchema(DB);
  const [rows, st, near, setAside, accountRows, partners, loose, twins, combined, roles] = await Promise.all([
    DB.prepare('SELECT * FROM vendor_access ORDER BY updated_at DESC').all().then((r) => r.results || []),
    readKey(DB, 'state'), readKey(DB, 'near'), readKey(DB, 'set-aside'), readAccountRows(DB), readPartners(DB), readKey(DB, 'loose'),
    readKey(DB, 'twins'), readKey(DB, 'combined'), rolesView(DB).catch(() => null),
  ]);
  // Names and ids only: the contact snapshots stay here
  const nameOf = new Map(partners.map((p) => [p.slug, p.name]));
  const differs = (m) => (m.accountName.trim() !== m.name.trim() ? 1 : 0);
  const matched = [...accountRows.values()].filter((r) => nameOf.has(r.partner))
    .map((r) => ({ partner: r.partner, name: nameOf.get(r.partner), account: r.account_id, accountName: r.account_name || '', how: r.how || 'name' }))
    .sort((a, b) => differs(b) - differs(a) || a.name.localeCompare(b.name));
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
  // In Partners, yet only ever billed on jobs (no logo on any page): maybe a company SOARD pays, not a donor
  const why = new Map();
  for (const r of rows) if (r.partner) why.set(r.partner, (why.get(r.partner) || '') + ` ${r.why || ''}`);
  const billedOnly = [...why].filter(([slug, w]) => nameOf.has(slug) && !/page/.test(w)).map(([slug]) => ({ partner: slug, name: nameOf.get(slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    waiting: [...byCompany.values()].sort((a, b) => b.jobs.length - a.jobs.length || String(a.name).localeCompare(String(b.name))),
    near: Object.entries(near).map(([partner, n]) => ({ partner, ...n })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    added,
    setAside: Object.entries(setAside).map(([company, s]) => ({ company, ...s })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    matched, paired: matched.length, lastRunAt: st.lastRunAt || null, lastRun: st.lastRun || null, lastError: st.lastError || null,
    loose: Array.isArray(loose) ? loose : [], billedOnly, roles,
    twins: Array.isArray(twins) ? twins : [],
    combined: Object.entries(combined).map(([key, c]) => ({ key, ...c, name: c.partner ? nameOf.get(c.partner) || null : null }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30),
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
    const hit = [...(n.near || []), ...(n.was || [])].find((x) => x.id === account);
    if (!hit) throw new Error('JobTread doesn’t list that vendor for it');
    const name = hit.name.replace(/ \(archived\)$/, '');
    await putAccountRow(DB, { partner, account_id: hit.id, account_name: name, how: 'linked' });
    await setLink(DB, { company: nameKey(name), partner });
    // "Same as … after all": staff take back their "Not the same"
    const notSame = await readKey(DB, 'not-same');
    if (notSame[partner]?.[hit.id]) {
      delete notSame[partner][hit.id];
      if (!Object.keys(notSame[partner]).length) delete notSame[partner];
      await writeKey(DB, 'not-same', notSame);
    }
  }
  delete near[partner];
  await writeKey(DB, 'near', near);
  return { partner, name: n.name };
}

/**
 * Staff on two JobTread accounts listed as one company (a, b: their ids).
 * same: the empty one is archived and the partner it stood for moves to the
 * other. Not same: they're never put together again, and when the site had
 * archived one, it's back, with its partner. → { combined } | { notSame, back }
 */
export async function settleTwins(env, { a, b, same }, by = null, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const k = twinKey(a, b);
  const at = iso(now);
  const [stored, combined, accountRows] = await Promise.all([readKey(DB, 'twins'), readKey(DB, 'combined'), readAccountRows(DB)]);
  const list = Array.isArray(stored) ? stored : [];
  const t = list.find((x) => x.key === k);
  const done = combined[k];
  if (!t && !done) throw new Error('Those two aren’t listed any more');
  const partnerOn = (id) => [...accountRows.values()].find((r) => r.account_id === id)?.partner || null;
  if (!same) {
    await patchKey(DB, 'not-twins', { [k]: { names: done ? [done.keep.name, done.drop.name] : [t.a.name, t.b.name], by, at } });
    if (done) {
      if (!key) throw new Error('JobTread isn’t connected');
      // The site archived one: it's back in JobTread, with the partner it stood for
      await archiveAccount(key, done.drop.id, false, fetchImpl);
      if (done.partner && accountRows.get(done.partner)?.account_id === done.keep.id) {
        await putAccountRow(DB, { partner: done.partner, account_id: done.drop.id, account_name: done.drop.name, how: 'linked' });
      }
      delete combined[k];
      await writeKey(DB, 'combined', combined);
    }
    await writeKey(DB, 'twins', list.filter((x) => x.key !== k));
    return { notSame: true, back: done || null };
  }
  if (!t) throw new Error('Those two are one already');
  if (!key) throw new Error('JobTread isn’t connected');
  // What each holds now, not as of the last check
  const holds = await accountHolds(key, [t.a.id, t.b.id], fetchImpl);
  const { byJob, orders } = await billsByJob(DB);
  const billed = new Set([...orders, ...[...byJob.values()].flat()]);
  const logins = new Map();
  for (const m of await readMemberships(key, fetchImpl)) if (m.account?.id) logins.set(m.account.id, (logins.get(m.account.id) || 0) + 1);
  for (const [id, h] of holds) Object.assign(h, { bills: billed.has(id) ? 1 : 0, logins: logins.get(id) || 0 });
  const [ea, eb] = [isEmptyAccount(holds.get(t.a.id)), isEmptyAccount(holds.get(t.b.id))];
  if (!ea && !eb) throw new Error(`${t.a.name} and ${t.b.name} both have something in them in JobTread now, so put them together there`);
  // Both empty: the one a partner goes by stays
  const dropA = ea && (!eb || !partnerOn(t.a.id));
  const [drop, keep] = dropA ? [t.a, t.b] : [t.b, t.a];
  const partner = partnerOn(drop.id);
  await combineTwin(env, { keep, drop, partner }, { fetchImpl, at, by });
  await writeKey(DB, 'twins', list.filter((x) => x.key !== k));
  return { combined: { kept: keep.name, archived: drop.name, partner } };
}

/** Who's on a job, with each entry's id (to take one off) */
async function jobAces(grantKey, jobId, fetchImpl) {
  const body = await pave(grantKey, { job: { $: { id: jobId }, id: {}, aces: { $: { size: 50 }, nodes: { id: {}, membership: { user: { emailAddress: {} } } } } } }, fetchImpl);
  return (body?.job?.aces?.nodes || []).map((a) => ({ id: a.id, email: lower(a.membership?.user?.emailAddress) }));
}

/**
 * "Not the same": the partner isn't that JobTread vendor after all, so what
 * the match did is taken back: people the site put on jobs from that account
 * come off them, people copied from it into Partners leave Partners, and
 * contacts the site made in that account are deleted. The "Same as" link
 * goes too (logos and sponsors use it). No route pairs those two again; if
 * the partner is on an open job's page it waits in "The same company?".
 * → { partner, account, accountName, how, offJobs: [{ page, person }], fromPartners: [name], fromJobTread: [name], untracked }
 */
export async function unmatchAccount(env, { partner }, by = null, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  if (!key) throw new Error('JobTread isn’t connected');
  await ensureSchema(DB);
  const row = (await readAccountRows(DB)).get(partner);
  if (!row) throw new Error('That partner isn’t matched in JobTread any more');
  const copiedAll = await readKey(DB, 'copied');
  const copied = copiedAll[partner]?.account === row.account_id ? copiedAll[partner] : null;
  const site = (await readContacts(DB, [partner]))[partner] || [];
  const fromJt = new Set(copied?.site || []);
  // Staff's own people stay; the account's people (as last synced, or copied over) are its, not the partner's
  const own = new Set(site.filter((p) => !fromJt.has(personKey(tidy(p)))).map((p) => lower(p.email)).filter(Boolean));
  const theirs = new Set([...(row.jt_seen || []).map((p) => lower(p.email)), ...[...fromJt].filter((k) => !k.startsWith('n:'))].filter((e) => e && !own.has(e)));
  const out = { partner, account: row.account_id, accountName: row.account_name || '', how: row.how || 'name', offJobs: [], fromPartners: [], fromJobTread: [], untracked: !copied && !!row.synced_at };

  // Off the jobs the site put them on through this match
  const added = ((await DB.prepare("SELECT * FROM vendor_access WHERE partner = ? AND state = 'added'").bind(partner).all()).results || [])
    .map((r) => ({ ...r, person: parse(r.person, {}) }));
  for (const r of added.filter((x) => theirs.has(lower(x.person?.email)))) {
    const ace = (await jobAces(key, r.job_id, fetchImpl)).find((a) => a.email === lower(r.person.email));
    if (ace) await revokeJobAccess(env, ace.id, { fetchImpl });
    await DB.prepare('DELETE FROM vendor_access WHERE job_id = ? AND company = ?').bind(r.job_id, r.company).run();
    out.offJobs.push({ page: r.page, person: r.person.name || r.person.email });
  }
  // Partners keeps staff's own people only
  if (copied?.site?.length) {
    const keep = site.filter((p) => !fromJt.has(personKey(tidy(p))));
    out.fromPartners = site.filter((p) => fromJt.has(personKey(tidy(p)))).map((p) => p.name || 'unnamed');
    if (out.fromPartners.length) await saveContacts(DB, partner, keep, { by, source: 'admin', now });
  }
  // That account loses the contacts the site made in it
  if (copied?.jt?.length) {
    const account = (await fetchVendorAccounts(key, fetchImpl)).find((a) => a.id === row.account_id);
    for (const c of (account?.contacts || []).filter((x) => copied.jt.includes(x.id))) {
      await deleteContact(key, c.id, fetchImpl);
      out.fromJobTread.push(c.name || 'unnamed');
    }
  }

  const notSame = await readKey(DB, 'not-same');
  notSame[partner] = { ...(notSame[partner] || {}), [row.account_id]: { name: row.account_name || '', how: row.how || 'name', by, at: iso(now) } };
  await writeKey(DB, 'not-same', notSame);
  delete copiedAll[partner];
  await writeKey(DB, 'copied', copiedAll);
  await DB.prepare('DELETE FROM vendor_accounts WHERE partner = ?').bind(partner).run();
  const links = await readLinks(DB);
  if (row.account_name && links[nameKey(row.account_name)] === partner) await setLink(DB, { company: nameKey(row.account_name), partner: null });
  return out;
}

/** Unlink in "JobTread, no logo" undoes the vendor match that link made too */
export async function unmatchForLink(env, { company, partner }, by = null, opts = {}) {
  if (!partner || !env.JOBTREAD_GRANT_KEY) return null;
  await ensureSchema(env.DB);
  const row = (await readAccountRows(env.DB)).get(partner);
  if (!row || row.how !== 'linked' || nameKey(row.account_name) !== company) return null;
  return unmatchAccount(env, { partner }, by, opts);
}

/**
 * The JobTread vendor account takes the partner's name (or `name`, to put the
 * old one back). Staff press it one company at a time; the sweep never renames.
 */
export async function renameAccount(env, { partner, name = null }, { fetchImpl = fetch } = {}) {
  const { DB } = env;
  if (!env.JOBTREAD_GRANT_KEY) throw new Error('JobTread isn’t connected');
  await ensureSchema(DB);
  const row = (await readAccountRows(DB)).get(partner);
  if (!row) throw new Error('That partner isn’t matched in JobTread any more');
  const p = (await readPartners(DB)).find((x) => x.slug === partner);
  const to = String(name ?? p?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!to) throw new Error('There’s no name to give it');
  const from = row.account_name || '';
  if (to !== from) {
    await pave(env.JOBTREAD_GRANT_KEY, { updateAccount: { $: { id: row.account_id, name: to } } }, fetchImpl);
    await DB.prepare('UPDATE vendor_accounts SET account_name = ? WHERE partner = ?').bind(to, partner).run();
  }
  return { partner, name: p?.name || partner, account: row.account_id, from, to };
}
