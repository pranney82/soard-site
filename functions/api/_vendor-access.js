/**
 * Vendors on their JobTread jobs (Peter, Oct 28 2026)
 * ===========================================================================
 * Each open kid or community job lists its vendors in JobTread's job access:
 *   - each company whose logo is on the page (the kid's monetary sponsor
 *     too: one lane for every company; a sponsor's other contacts go on when
 *     it's picked, ./_room-credits.js), and
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
 * Taking a company off a job (Peter, Nov 4 2026: "if one is removed they
 * come off the other", and the admin needs one place to do it; Nov 5: "if its
 * added its added, if its deleted its deleted", finished makeovers too):
 *   - On the website it's something a person does, never something worked out
 *     from a page: Take off this job (Partners → a company → Kid pages), or
 *     the X on a logo on a kid's page. takeOffJob() does it all at
 *     once in one request: the intent is written first, then the logo leaves
 *     the page and their people leave the job, bill or not, and they stay off;
 *     a run that dies is finished by the sweep. Only someone surely theirs
 *     (a login under its JobTread account or a linked one, or its contact) in
 *     a partner role comes off, never staff, a family or someone also on the
 *     job for another company; anyone it can't be sure of is named back to
 *     staff. A save, a restored draft or History changing a page's logos
 *     moves nobody.
 *   - In JobTread, everyone from a company taken off the job is seen on two
 *     looks in a row, then its logo comes off the page (saved and published
 *     like any other sync), and they aren't put back. More than
 *     MAX_LEAVING_ON_JOB leaving one job in a day, or MAX_LEAVING_IN_RUN at
 *     once, moves nothing: it's said once in Slack, and each stays where it
 *     is, not put back, until someone takes it off or it comes back.
 *   - Off is off until a person says otherwise: Put back on the website, a
 *     logo added on the page by hand, or someone of theirs added in JobTread.
 *     A logo that merely reappears (a draft, History) puts nobody back; the
 *     Vendors list shows it. The first look at a job changes nothing.
 *   - The JobTread side starts watching: what it would take off is noted and
 *     nothing moves until staff turn it on in Partners → JobTread access,
 *     where it can be turned off again.
 * The reveal invite is built from who's on the job, so it follows by itself
 * (./_reveal-invites.js). A removal the site does for its own reasons says so
 * first (noteSiteRevoke), so it's never read as a person doing it in
 * JobTread. The kid's monetary sponsor is put on the job when it's picked
 * (./_room-credits.js), and taken off here like any company.
 *
 * A JobTread vendor that isn't a partner goes on a job only when SOARD pays
 * it for work (isTradeVendor: JobTread's Trades, W-9 and Documents fields, or
 * a purchase order). A store bought from by card, or a materials supplier,
 * never does. A logo on a page that no partner or JobTread vendor goes by is
 * listed for staff instead (loose): nobody to put on the job until it's named.
 *
 * Every partner with no JobTread vendor account gets one, under its Partners
 * name, with or without someone to put in it (one on an open kid's page
 * first): staff don't make vendors in JobTread, so the website is how a
 * company gets there (Peter, Oct 30 2026: "if they are on the website, they
 * should be in JT", every company in Partners).
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
import { SOARD_ORG_ID, isProject } from './_reveals.js';
import { loadAllKids, loadAllProjects, linkJobs, keyOf, saveRecord, requestDeploy, SYNC_USER } from './_kid-status.js';
import { fetchOpenJobs, fetchAccess, readLinks, setLink, takeLock, freeLock, forgetCompany, FREE_MAIL, ensureSchema as ensureLogoSchema } from './_kid-partners.js';
import { pageLogosOff, pageLogosOn } from './partners-batch.js';
import { pave, grantJobAccess, revokeJobAccess, noteSiteRevoke } from './_jt-access.js';
import { slackPost } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { readContacts, saveContacts, isEmail } from './_sponsors.js';
import { logAudit } from './_audit.js';
import { roleMode, reconcileRoles, rolesView, readMemberships, isPartnerRole } from './_partner-roles.js';
import { nameKey, wordsKey, domainOf, isSocial, kidUsage, nearPartners, cfId } from '../../public/admin/partners-shared.js';

const RUN_EVERY_MS = 15 * 60 * 1000;
const WRITE_BUDGET_MS = 20 * 1000;
const MAX_GRANTS = 12;
const MAX_NEW_ACCOUNTS = 25;
const MAX_COMBINE = 10;
const SETTING_UP_MS = 60 * 60 * 1000; // an account this new may still be being set up: never archived
const MAX_PEOPLE = 5; // what Partners keeps per partner
const ACCOUNTS_PAGE = 25; // 50 × 5 contacts passed JobTread's no-key size check, 100 didn't (Oct 28 2026)
const MAX_ACCOUNT_PAGES = 40;
const LOCK = 'vendor-access';
const MAX_LEAVING_ON_JOB = 3; // more logos leaving one job in a day than this moves nothing: a person looks
const MAX_LEAVING_IN_RUN = 5; // and more than this across every job
const SECOND_LOOK_MS = 10 * 60 * 1000; // gone on two runs at least this far apart before a logo moves
const GOING_RETRY_MS = 2 * 60 * 1000; // a takeOffJob this old that didn't finish is finished by the sweep
const STALE_LOOK_MS = 3 * 24 * 60 * 60 * 1000; // a job not looked at for this long (closed, reopened): today is a fresh start
const TAKEN_OFF_KEPT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  // Per company per job. who: "p:<partner>" or "a:<JobTread account>", so a rename isn't a removal. people:
  // [{ id, email }] surely theirs, as last seen on the job (a membership's id, so a changed email isn't someone
  // leaving); logos: the images on the page when they left or came off; gone_at: first seen gone, waiting on a
  // second look; off: see changeOnJob; took: who came off and gone_logos: the logos that left, so Put back restores
  // exactly that; left_on: membership ids still on the job when they came off (someone the site couldn't be
  // sure of), who don't count as them back; before_off: how the row stood before a take-off, so Undo goes back to it
  `CREATE TABLE IF NOT EXISTS vendor_job_seen (
    job_id TEXT NOT NULL, who TEXT NOT NULL, record TEXT, name TEXT, partner TEXT, account_id TEXT,
    people TEXT, logos TEXT, off TEXT, gone_at TEXT, took TEXT, left_on TEXT, gone_logos TEXT, before_off TEXT, updated_at TEXT,
    PRIMARY KEY (job_id, who))`,
  // Who came and went on each makeover, and from which side: 'website', 'jobtread' or 'bill'
  `CREATE TABLE IF NOT EXISTS vendor_job_log (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT, at TEXT, action TEXT, side TEXT, name TEXT, people TEXT, by TEXT)`,
  'CREATE TABLE IF NOT EXISTS vendor_site_revokes (job_id TEXT NOT NULL, email TEXT NOT NULL, at TEXT, PRIMARY KEY (job_id, email))',
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
/**
 * What a JobTread vendor that isn't a partner is to SOARD: 'trade' (paid for
 * work), 'store' (bought from on today's jobs, or a supplier by its fields),
 * or 'none' (neither: a store from an older job, a donor missing from
 * Partners, or a partner's other account)
 */
export function vendorKind(a, { order = false, jobs = 0 } = {}) {
  if (isTradeVendor(a, { order })) return 'trade';
  const f = a?.facts || {};
  return jobs || f.materials || lower(f.docs) === 'not needed' || (f.trades || []).length ? 'store' : 'none';
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
  const bySlug = new Map(partners.map((p) => [p.slug, p]));
  const accountOf = new Map([...pairs].map(([slug, a]) => [a.id, slug]));
  const out = new Map();
  const add = (v, why, logos = []) => {
    const was = out.get(v.company);
    if (was) { was.why.add(why); was.account ||= v.account; was.logos.push(...logos); return; }
    out.set(v.company, { ...v, why: new Set([why]), logos: [...logos] });
  };
  const usage = kidUsage([{ ...data, slug: '_', publishStatus: 'published' }], partners).byPartner;
  const matched = new Set();
  for (const slug of usage.keys()) {
    const p = bySlug.get(slug);
    for (const row of usage.get(slug)) matched.add(row.url);
    if (!p) continue;
    add({ company: nameKey(p.name), name: p.name, partner: slug, account: pairs.get(slug) || null }, 'page', usage.get(slug).map((row) => row.url));
  }
  // A named logo that isn't a partner's file: the partner by that name, else JobTread's vendor by it
  for (const l of data.partnerLogos || []) {
    if (!l?.url || matched.has(l.url) || !nameKey(l.name)) continue;
    const p = partners.find((x) => sameName(x.name, l.name));
    if (p) { add({ company: nameKey(p.name), name: p.name, partner: p.slug, account: pairs.get(p.slug) || null }, 'page', [l.url]); continue; }
    const a = accounts.find((x) => !x.archived && sameName(x.name, l.name));
    if (!a) { loose?.push(String(l.name).trim()); continue; }
    add({ company: nameKey(String(l.name).trim()), name: String(l.name).trim(), partner: null, account: a }, 'page', [l.url]);
  }
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of bills) {
    const a = byId.get(id);
    if (!a || a.archived) continue;
    const slug = accountOf.get(id);
    const p = slug ? bySlug.get(slug) : null;
    if (!p && !trade(a)) continue;
    add(p ? { company: nameKey(p.name), name: p.name, partner: slug, account: a } : { company: nameKey(a.name), name: a.name, partner: null, account: a }, 'bill');
  }
  return [...out.values()].filter((v) => v.company);
}

/** Everyone from the company with access (any role): [membership] */
export function peopleOnJob(v, aces, { people = [], website = '', links = {} } = {}) {
  const emails = new Set([...(v.account?.contacts || []), ...people].map((p) => lower(p.email)).filter(Boolean));
  const site = website && !isSocial(website) ? domainOf(website) : '';
  return (aces?.nodes || []).map((a) => a?.membership).filter((m) => {
    if (!m || m.isInternal) return false;
    const email = lower(m.user?.emailAddress);
    if (v.account && m.account?.id === v.account.id) return true;
    if (m.account?.name && (nameKey(m.account.name) === v.company || sameName(m.account.name, v.name))) return true;
    if (v.partner && m.account?.name && links[nameKey(m.account.name)] === v.partner) return true;
    if (email && emails.has(email)) return true;
    const d = domainOfEmail(email);
    return !!site && !FREE_MAIL.has(d) && sameSite(d, site);
  });
}
/** Someone from the company has access already (any role) */
export const onJob = (v, aces, opts) => peopleOnJob(v, aces, opts).length > 0;
/**
 * Theirs beyond doubt: a login under its JobTread account, one by its name or linked to it ("Same as"), or
 * with no account at all its contact. A website's domain alone can be another company's: it counts as them being here,
 * never as a reason to take someone off a job or a logo off a page.
 */
export function surelyTheirs(v, m, { people = [], links = {} } = {}) {
  if (!m || m.isInternal) return false;
  if (m.account?.id) return (!!v.account && m.account.id === v.account.id) || (!!m.account.name && (nameKey(m.account.name) === v.company || sameName(m.account.name, v.name)))
    || (!!v.partner && !!m.account.name && links[nameKey(m.account.name)] === v.partner);
  const email = lower(m.user?.emailAddress);
  return !!email && [...(v.account?.contacts || []), ...people].some((c) => lower(c.email) === email);
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
const placeOnly = (w) => w.length > 0 && w.every((x) => PLACE_WORDS.has(x));
const within = (x, y) => {
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return !placeOnly(short) && short.every((w, i) => long[i] === w);
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

/**
 * What accounts hold in JobTread: Map(id → { contacts, documents, files, aces, staff }).
 * aces: access for people outside SOARD; staff: the names on SOARD's own (staff, or the
 * site's JobTread user), which isn't the company using it. Unread, every entry counts.
 */
async function accountHolds(grantKey, ids, fetchImpl) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 25) {
    const q = Object.fromEntries(ids.slice(i, i + 25).map((id, k) => [`a${k}`, {
      _: 'account', $: { id }, id: {}, contacts: { count: {} }, documents: { count: {} }, files: { count: {} }, aces: { count: {} },
    }]));
    const body = await pave(grantKey, q, fetchImpl);
    for (const a of Object.values(body || {})) {
      if (a?.id) out.set(a.id, { contacts: a.contacts?.count || 0, documents: a.documents?.count || 0, files: a.files?.count || 0, aces: a.aces?.count || 0, staff: [] });
    }
  }
  const withAces = [...out].filter(([, h]) => h.aces).map(([id]) => id);
  for (let i = 0; i < withAces.length; i += 10) {
    const q = Object.fromEntries(withAces.slice(i, i + 10).map((id, k) => [`a${k}`, {
      _: 'account', $: { id }, id: {}, aces: { $: { size: 10 }, nodes: { membership: { isInternal: {}, user: { name: {} } } } },
    }]));
    let body;
    try { body = await pave(grantKey, q, fetchImpl); } catch { break; }
    for (const a of Object.values(body || {})) {
      const h = a?.id && out.get(a.id);
      const nodes = a?.aces?.nodes;
      if (!h || !Array.isArray(nodes) || nodes.length < h.aces) continue;
      const staff = nodes.filter((x) => x?.membership?.isInternal === true);
      h.staff = staff.map((x) => String(x.membership.user?.name || '').trim() || 'SOARD');
      h.aces -= staff.length;
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
async function combineTwin(env, { keep, drop, partner, staff = [] }, { accountRows = null, fetchImpl = fetch, at, by, how = 'name' }) {
  const { DB } = env;
  await archiveAccount(env.JOBTREAD_GRANT_KEY, drop.id, true, fetchImpl);
  drop.archived = true;
  if (partner) {
    const r = { partner, account_id: keep.id, account_name: keep.name, how };
    await putAccountRow(DB, r);
    accountRows?.set(partner, r);
  }
  const combined = await readKey(DB, 'combined');
  // staff: whose access the archived one had (SOARD's own only, or it wasn't empty)
  combined[twinKey(keep.id, drop.id)] = { keep: { id: keep.id, name: keep.name }, drop: { id: drop.id, name: drop.name }, partner: partner || null, at, by, ...(staff.length ? { staff } : {}) };
  const newest = Object.entries(combined).sort(([, x], [, y]) => String(y.at).localeCompare(String(x.at))).slice(0, 60);
  await writeKey(DB, 'combined', Object.fromEntries(newest));
}
const holdsOut = (a, h) => ({ id: a.id, name: a.name, holds: { contacts: h?.contacts || 0, documents: h?.documents || 0, files: h?.files || 0, access: (h?.aces || 0) + (h?.logins || 0), bills: h?.bills || 0 } });

// ── Taken off a job ──────────────────────────────────────────────────
/** A company's key in vendor_job_seen: its partner, or its JobTread account when it's no partner */
const whoOf = (v) => (v.partner ? `p:${v.partner}` : `a:${v.account?.id}`);
const logoId = (url) => cfId(url) || url;
const personOf = (m) => ({ id: m.id, email: lower(m.user?.emailAddress), name: m.user?.name || null });
const outsidersOn = (aces) => (aces?.nodes || []).map((a) => a?.membership).filter((m) => m && !m.isInternal);

/**
 * What a company's last look and JobTread now call for. was: { people, logos, off, goneAt } or null for a
 * first look; now: { people (surely theirs), present (anyone of theirs, a website match too), back (anyone of
 * theirs who wasn't left behind when they came off), logos (ids on the page) } → { act, next }. act:
 *   null        nothing to do but remember
 *   'wait'      everyone of theirs has left, not seen on two looks yet: nothing moves, nobody is put back
 *   'off-page'  left on two looks: their logos come off the page, and they stay off
 *   'stay-off'  left on two looks, with no logo to move: they stay off
 *   'finish'    a takeOffJob that didn't finish
 *   'return'    a Put back JobTread didn't take for everyone: the rest go back on
 *   'back'      someone of theirs is on the job again after coming off: the logo sync brings the logo
 * off: 'going' (takeOffJob is under way), 'returning' (Put back, with people still to go back on), 'site' (a
 * person took them off on the website) or 'jobtread' (in JobTread). Off is off until someone of theirs is back on the job or a person puts them back (putBackJob,
 * addToJob). A logo that reappears isn't a person saying so: a restored draft or History does that too.
 */
export function changeOnJob(was, now, at) {
  const { people, present, back = present, logos } = now;
  const fresh = { people, logos: [], off: null, goneAt: null };
  if (!was) return { act: null, next: fresh };
  if (was.off === 'going') return { act: 'finish', next: was };
  if (was.off === 'returning') return { act: 'return', next: was };
  if (was.off) {
    if (back) return { act: 'back', next: fresh };
    return { act: null, next: was };
  }
  // Someone a website match ties to them is here, and that's all: they count, but only the sure ones are remembered
  if (present) return { act: null, next: { ...fresh, people: people.length ? people : was.people } };
  if (!was.people.length) return { act: null, next: fresh };
  if (!was.goneAt) return { act: 'wait', next: { people: was.people, logos, off: null, goneAt: at } };
  if (Date.parse(at) - Date.parse(was.goneAt) < SECOND_LOOK_MS) return { act: 'wait', next: { ...was, logos: was.logos } };
  // Who left is kept, so they can go back with the logo even with no contact on file
  const off = { people: [], off: 'jobtread', goneAt: null, took: was.people.map((p) => ({ email: p.email, name: p.name })) };
  // A logo that wasn't there when they left isn't theirs to lose
  const pull = was.logos.length ? logos : [];
  return pull.length ? { act: 'off-page', pull, next: { ...off, logos: [] } } : { act: 'stay-off', next: { ...off, logos } };
}

/** Everyone's last look: Map("job who" → row) */
async function readSeen(DB) {
  const rows = (await DB.prepare('SELECT * FROM vendor_job_seen').all()).results || [];
  return new Map(rows.map((r) => [`${r.job_id} ${r.who}`, {
    ...r, people: parse(r.people, []), logos: parse(r.logos, []), took: parse(r.took, []), leftOn: parse(r.left_on, []), goneLogos: parse(r.gone_logos, []), beforeOff: parse(r.before_off, null), goneAt: r.gone_at || null, off: r.off || null,
  }]));
}
const seenStatement = (DB, r, at) => DB.prepare(`INSERT OR REPLACE INTO vendor_job_seen (job_id, who, record, name, partner, account_id, people, logos, off, gone_at, took, left_on, gone_logos, before_off, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.job_id, r.who, r.record || null, r.name || null, r.partner || null, r.account_id || null,
  JSON.stringify(r.people || []), JSON.stringify(r.logos || []), r.off || null, r.goneAt || null, JSON.stringify(r.took || []), JSON.stringify(r.leftOn || []), JSON.stringify(r.goneLogos || []), r.beforeOff ? JSON.stringify(r.beforeOff) : null, at);
const forgetSeen = (DB, jobId, who) => DB.prepare('DELETE FROM vendor_job_seen WHERE job_id = ? AND who = ?').bind(jobId, who).run();
const noLongerAdded = (DB, jobId, company) => DB.prepare('DELETE FROM vendor_access WHERE job_id = ? AND company = ?').bind(jobId, company).run();
/** The sweep's write of what it found: applied only if nobody's changed the row since it was read, in the database itself, so a take-off landing now can't be overwritten */
const rememberStatement = (DB, r, at, was) => (was && was.who === r.who
  ? DB.prepare(`UPDATE vendor_job_seen SET record = ?, name = ?, partner = ?, account_id = ?, people = ?, logos = ?, off = ?, gone_at = ?, took = ?, left_on = ?, gone_logos = ?, before_off = ?, updated_at = ?
      WHERE job_id = ? AND who = ? AND updated_at IS ?`).bind(r.record || null, r.name || null, r.partner || null, r.account_id || null, JSON.stringify(r.people || []), JSON.stringify(r.logos || []), r.off || null, r.goneAt || null,
    JSON.stringify(r.took || []), JSON.stringify(r.leftOn || []), JSON.stringify(r.goneLogos || []), r.beforeOff ? JSON.stringify(r.beforeOff) : null, at, r.job_id, r.who, was.updated_at || null)
  : DB.prepare(`INSERT OR IGNORE INTO vendor_job_seen (job_id, who, record, name, partner, account_id, people, logos, off, gone_at, took, left_on, gone_logos, before_off, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.job_id, r.who, r.record || null, r.name || null, r.partner || null, r.account_id || null, JSON.stringify(r.people || []), JSON.stringify(r.logos || []), r.off || null, r.goneAt || null,
    JSON.stringify(r.took || []), JSON.stringify(r.leftOn || []), JSON.stringify(r.goneLogos || []), r.beforeOff ? JSON.stringify(r.beforeOff) : null, at));

/** Someone this run put on a job is as good as read: taken off before the next look, they aren't put back */
async function sawPutOn(DB, row, person, at) {
  const r = await DB.prepare('SELECT people, off FROM vendor_job_seen WHERE job_id = ? AND who = ?').bind(row.job_id, row.who).first();
  if (r?.off) return r.off; // a take-off got there first: it stands, and the caller takes them back off
  const people = [...parse(r?.people, []).filter((p) => p.id !== person.id), person];
  await seenStatement(DB, { ...row, people }, at).run();
  return null;
}

const logMakeover = (DB, { record, at, action, side, name, people = [], by = null }) => DB.prepare('INSERT INTO vendor_job_log (record, at, action, side, name, people, by) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .bind(record, at, action, side, name, JSON.stringify(people), by).run();

/** Who was taken off lately: written before the change, so nothing happens without a trace */
async function noteTaken(DB, entry, by = SYNC_USER) {
  await logMakeover(DB, { record: entry.record, at: entry.at, action: 'removed', side: entry.how === 'page' ? 'website' : 'jobtread', name: entry.name, people: entry.people || [], by });
  const had = await readKey(DB, 'taken-off');
  await writeKey(DB, 'taken-off', { list: [entry, ...(Array.isArray(had.list) ? had.list : [])].slice(0, TAKEN_OFF_KEPT) });
  await logAudit(DB, { userEmail: by, action: 'updated', entityType: 'jobtread-access', entityName: 'Vendors on jobs',
    changes: { removed: [`${entry.name}: ${entry.how === 'page' ? `off the job, ${(entry.people || []).join(', ') || 'nobody on it'}` : entry.kept ? 'off the job in JobTread, stays off' : 'logo off the page'} (${entry.page})`] } });
}
/** Put back: they're not "taken off lately" any more. The makeover's history keeps both */
async function dropTaken(DB, record, name) {
  const had = await readKey(DB, 'taken-off');
  const list = Array.isArray(had.list) ? had.list : [];
  const i = list.findIndex((e) => e.record === record && e.name === name);
  if (i >= 0) await writeKey(DB, 'taken-off', { list: list.filter((_, n) => n !== i) });
}
async function nameTaken(DB, entry, people) {
  await DB.prepare("UPDATE vendor_job_log SET people = ? WHERE record = ? AND at = ? AND name = ? AND action = 'removed'").bind(JSON.stringify(people), entry.record, entry.at, entry.name).run();
  const had = await readKey(DB, 'taken-off');
  await writeKey(DB, 'taken-off', { list: (Array.isArray(had.list) ? had.list : []).map((e) => (e.at === entry.at && e.record === entry.record && e.name === entry.name ? { ...e, people } : e)) });
}
async function unnoteTaken(DB, entry) {
  await DB.prepare("DELETE FROM vendor_job_log WHERE record = ? AND at = ? AND name = ? AND action = 'removed'").bind(entry.record, entry.at, entry.name).run();
  const had = await readKey(DB, 'taken-off');
  await writeKey(DB, 'taken-off', { list: (Array.isArray(had.list) ? had.list : []).filter((e) => !(e.at === entry.at && e.record === entry.record && e.name === entry.name)) });
}

/** Logos off a page, read fresh under the kid-record lock so an edit made meanwhile is kept. → what left ([{ url, name, at }]), or false when the page was busy: next run */
async function takeLogosOff(env, rec, drops, at) {
  const { DB } = env;
  if (!(await takeLock(DB, false, 'sync'))) return false;
  try {
    const fresh = (isProject(rec) ? await loadAllProjects(DB) : await loadAllKids(DB)).find((r) => r.slug === rec.slug);
    if (!fresh) return [];
    const before = fresh.data;
    const ids = new Set(drops.flatMap((d) => d.pull));
    const partnerLogos = (before.partnerLogos || []).filter((l) => !ids.has(logoId(l?.url)));
    const left = (before.partnerLogos || []).map((l, i) => ({ url: l?.url, name: l?.name || '', at: i })).filter((l) => ids.has(logoId(l.url)));
    if (!left.length) return [];
    await saveRecord(env, isProject(rec) ? 'community' : 'kids', rec.slug, before, { ...before, partnerLogos }, `Partner logos from JobTread: ${rec.name} − ${drops.map((d) => d.name).join(', ')}`, at);
    return left;
  } finally { await freeLock(DB, 'sync'); }
}

/** Who a company's removal takes off a job, and who stays: partner roles only, and nobody also here for someone else */
function goingFrom(v, aces, others, contactsOf, seenPeople = [], billAccounts = []) {
  const opts = contactsOf(v);
  const outsiders = outsidersOn(aces);
  const staying = new Set(others.flatMap((o) => peopleOnJob(o, aces, contactsOf(o))).map((m) => m.id));
  const sure = outsiders.filter((m) => surelyTheirs(v, m, opts) || seenPeople.some((p) => p.id === m.id));
  const anothersBill = (m) => !!m.account?.id && m.account.id !== v.account?.id && billAccounts.includes(m.account.id);
  const going = sure.filter((m) => isPartnerRole(m.role?.name) && !staying.has(m.id) && !anothersBill(m) && lower(m.user?.emailAddress));
  const gone = new Set(going.map((m) => m.id));
  return { going, left: peopleOnJob(v, aces, opts).filter((m) => !gone.has(m.id)) };
}
/** Put back: an earlier "the site took them off" no longer explains them leaving */
const forgetSiteRevokes = async (DB, jobId, emails) => {
  for (const e of emails) await DB.prepare('DELETE FROM vendor_site_revokes WHERE job_id = ? AND email = ?').bind(jobId, lower(e)).run();
};
/** Said first, then done: a run that dies between the two is read right next time */
async function revokePeople(env, jobId, going, at, fetchImpl) {
  if (!going.length) return;
  for (const m of going) await noteSiteRevoke(env.DB, jobId, m.user.emailAddress, at);
  const ids = await jobAces(env.JOBTREAD_GRANT_KEY, jobId, fetchImpl);
  for (const m of going) {
    const ace = ids.find((a) => a.member === m.id);
    if (ace) await revokeJobAccess(env, ace.id, { fetchImpl });
  }
}
/**
 * A logo deleted with nobody moved off the job: the logo sweep isn't to put it back. Under the company's name and
 * the person's, never the account of someone left on the job: that's another company, and its logo is its own.
 */
const keepLogoOff = async (DB, record, jobId, left, name, partner, at) => {
  await ensureLogoSchema(DB);
  for (const m of left) {
    for (const label of new Set([name, m.user?.name].filter(Boolean))) {
      await DB.prepare(`INSERT INTO kid_partner_logos (record, company, name, partner, job_id, state, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, 'off', ?, ?)
        ON CONFLICT (record, company) DO UPDATE SET state = 'off', updated_at = excluded.updated_at WHERE kid_partner_logos.state <> 'dismissed'`).bind(record, nameKey(label), label, partner, jobId, at, at).run();
    }
  }
  // And however the logo sweep already knows them, when JobTread names them differently
  const rows = (await DB.prepare("SELECT company, name, partner FROM kid_partner_logos WHERE record = ? AND state IN ('added', 'there', 'waiting')").bind(record).all()).results || [];
  for (const r of rows) {
    if ((partner && r.partner === partner) || sameName(r.name, name)) await DB.prepare("UPDATE kid_partner_logos SET state = 'off', updated_at = ? WHERE record = ? AND company = ?").bind(at, record, r.company).run();
  }
};
// The rest of the room's companies (its sponsors too), never the one coming off: a sponsor taken off goes like anyone
const othersOn = (rec, vendors, who, bySlug, pairs) => [...vendors.filter((o) => whoOf(o) !== who),
  ...(Array.isArray(rec.data?.sponsors) ? rec.data.sponsors : []).filter((s) => `p:${s}` !== who).map((s) => bySlug.get(s)).filter(Boolean).map((p) => ({ company: nameKey(p.name), name: p.name, partner: p.slug, account: pairs.get(p.slug) || null }))];
const tableOf = (rec) => (isProject(rec) ? 'community' : 'kids');
/** Off the job, the rest of the way: the row, and what the sweeps keep about them */
const tookFrom = (v, going, had = []) => [...new Map([...had, ...going.map((m) => ({ name: m.user?.name || v.name, email: lower(m.user?.emailAddress) }))].map((t) => [t.email, t])).values()];
async function offForGood(DB, { job, record, who, v, same = null, going, left, removed = null, at }) {
  const took = tookFrom(v, going, same?.took || []);
  await seenStatement(DB, { job_id: job.id, who, record, name: v.name, partner: v.partner, account_id: v.account?.id || same?.account_id || null, people: [], logos: [], off: 'site', goneAt: null, took, leftOn: left.map((m) => m.id), goneLogos: removed?.length ? removed : same?.goneLogos || [], beforeOff: same?.beforeOff || null }, at).run();
  await noLongerAdded(DB, job.id, v.company);
  if (left.length) await keepLogoOff(DB, record, job.id, left, v.name, v.partner, at);
  else await forgetCompany(DB, record, { partner: v.partner, names: [v.name], emails: going.map((m) => lower(m.user?.emailAddress)) });
}

/**
 * A person took a company off this makeover, on the website: one request does all of it. partner, or
 * account + name for a trade partner (no logo), or logos: [{ url, name }] for the logos they picked; sha: the editor's, so its next Save fits. The intent is written
 * before anything moves, so a request that dies is finished by the sweep. → { job (an open one?), who, removed:
 * [{ url, name, at }], sha?, taken: [{ name, people }], left: [{ name, people }] (someone it can't be sure of, still
 * on the job), pending: [names] (JobTread didn't answer: the sweep finishes it), skipped: [{ name, why: 'sponsor' |
 * 'unknown' }] }. Throws with nothing changed when it can't start.
 */
export async function takeOffJob(env, { record, partner = null, account = null, name = '', logos = [], sha = null }, by = null, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const at = iso(now);
  const [kids, projects, partners, contactsAll, accountRows, seen, links, looked, { byJob: bills }] = await Promise.all([
    loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readContacts(DB), readAccountRows(DB), readSeen(DB), readLinks(DB), readKey(DB, 'looked'), billsByJob(DB),
  ]);
  const records = [...kids, ...projects];
  const rec = records.find((r) => keyOf(r) === record);
  if (!rec) throw Object.assign(new Error('That page isn’t there any more. Reload and try again.'), { status: 409, unchanged: true });
  const pairs = new Map([...accountRows].map(([slug, r]) => [slug, { id: r.account_id, name: r.account_name, contacts: r.jt_seen || [] }]));
  const bySlug = new Map(partners.map((p) => [p.slug, p]));
  const contactsOf = (v) => ({ people: v.partner ? contactsAll[v.partner] || [] : [], website: bySlug.get(v.partner)?.website, links });

  // The job: JobTread's say, or the last look's while it isn't answering
  let job = null;
  let down = false;
  try { job = linkJobs(await fetchOpenJobs(key, fetchImpl), records).get(record) || null; } catch {
    down = true;
    const id = Object.keys(looked).filter((j) => looked[j]?.record === record).sort((a, b) => String(looked[b].at).localeCompare(String(looked[a].at)))[0];
    if (!id) throw Object.assign(new Error('JobTread isn’t answering. Try again in a minute.'), { status: 503, unchanged: true });
    job = { id };
  }

  // Which companies: the partner asked for, or who those logos are (a partner's file or name, else a last look's by that name)
  const shown = Array.isArray(rec.data?.partnerLogos) ? rec.data.partnerLogos : [];
  const usage = kidUsage([{ partnerLogos: shown.concat(logos), slug: '_', publishStatus: 'published' }], partners).byPartner;
  const companies = new Map();
  const out = { job: !!job, jobId: job?.id || null, who: [], taken: [], left: [], pending: [], skipped: [], removed: [] };
  const company = (p) => ({ company: nameKey(p.name), name: p.name, partner: p.slug, account: pairs.get(p.slug) || null });
  if (partner) { const p = bySlug.get(partner); if (!p) throw Object.assign(new Error('That company isn’t in Partners any more. Reload and try again.'), { status: 409, unchanged: true }); companies.set(`p:${p.slug}`, company(p)); }
  if (account) companies.set(`a:${account}`, { company: nameKey(name), name, partner: null, account: { id: account, contacts: [] } });
  const whose = new Map();
  for (const l of logos) {
    const p = partners.find((x) => usage.get(x.slug)?.some((row) => logoId(row.url) === logoId(l.url))) || partners.find((x) => sameName(x.name, l.name));
    if (p) { whose.set(l.url, p.slug); companies.set(`p:${p.slug}`, company(p)); continue; }
    const row = job && [...seen.values()].find((r) => r.job_id === job.id && !r.partner && sameName(r.name, l.name));
    if (row) companies.set(row.who, { company: nameKey(row.name), name: row.name, partner: null, account: { id: row.account_id, contacts: [] } });
    else out.skipped.push({ name: l.name || 'That logo', why: 'unknown' });
  }
  // A trade partner's contacts aren't kept here, and someone may be on the job only by being one
  if (account && !down) {
    const a = (await fetchVendorAccounts(key, fetchImpl).catch(() => [])).find((x) => x.id === account);
    if (a) companies.get(`a:${account}`).account = a;
  }
  // A monetary sponsor or design partner comes off like anyone else: being on the room is one thing, the credit
  // another (./_room-credits.js), and the credit stays until a person changes it
  if (partner && !companies.size) return out;
  // Every logo of theirs on the page, however it got there; X on one of two is the company leaving
  const urls = [...new Set([
    ...logos.map((l) => l.url),
    ...[...companies.values()].flatMap((v) => [
      ...(v.partner ? (usage.get(v.partner) || []).map((row) => row.url).filter((u) => shown.some((l) => logoId(l?.url) === logoId(u))) : []),
      ...shown.filter((l) => l?.url && (nameKey(l.name) === v.company || sameName(l.name, v.name))).map((l) => l.url),
    ]),
  ])];

  // Said first: a row and a trace, so nothing can happen without them, and a request that dies is finished by the sweep
  const entries = [];
  const planned = shown.map((l, i) => ({ url: l?.url, name: l?.name || '', at: i })).filter((l) => urls.some((u) => logoId(u) === logoId(l.url)));
  for (const [who, v] of companies) {
    if (!job) break;
    const last = seen.get(`${job.id} ${who}`);
    const entry = { at, how: 'page', name: v.name, page: pageName(rec), record, people: [] };
    // Someone already gone from the job, waiting on a second look, still counts as who left: Put back brings them
    const hadTook = [...(last?.took || []), ...(last?.goneAt ? (last.people || []).map((p) => ({ email: p.email, name: p.name })) : [])];
    const beforeOff = last ? { people: last.people, logos: last.logos, off: last.off, goneAt: last.goneAt, took: hadTook, leftOn: last.leftOn, goneLogos: last.goneLogos } : {};
    await seenStatement(DB, { job_id: job.id, who, record, name: v.name, partner: v.partner, account_id: v.account?.id || null, people: last?.people || [], logos: [...new Set(urls.map(logoId))], off: 'going', goneAt: null, took: hadTook, leftOn: [], goneLogos: planned.length ? planned : last?.goneLogos || [], beforeOff }, at).run();
    await noteTaken(DB, entry, by);
    entries.push(entry);
    out.who.push(who);
  }
  // The page, under the kid-record lock (a trade partner has none)
  // Refused: everything goes back to what it was, not to nothing (someone may be waiting on a second look)
  const undoAll = async () => {
    for (const who of out.who) {
      const last = seen.get(`${job.id} ${who}`);
      if (last) await seenStatement(DB, last, last.updated_at || at).run(); else await forgetSeen(DB, job.id, who);
    }
    for (const e of entries) await unnoteTaken(DB, e);
  };
  if (partner || urls.length) {
    if (!(await takeLock(DB, true, 'sync'))) { await undoAll(); throw Object.assign(new Error('That page is busy. Try again in a moment.'), { status: 503, unchanged: true }); }
    try {
      const page = await pageLogosOff(env, { table: tableOf(rec), slug: rec.slug, partner, urls, sha }, by || SYNC_USER);
      out.removed = page.removed;
      if (page.sha) out.sha = page.sha;
    } catch (e) { await undoAll(); e.unchanged = true; throw e; } finally { await freeLock(DB, 'sync'); }
    for (const who of out.who) {
      const row = (await readSeen(DB)).get(`${job.id} ${who}`);
      if (row && out.removed.length) await seenStatement(DB, { ...row, goneLogos: out.removed }, at).run();
    }
  }
  // Deleted is deleted, even with nobody to move: no open job, or a logo nobody can name
  if (out.removed.length || partner) {
    const noOne = [...out.skipped.filter((s) => s.why === 'unknown').map((s) => ({ name: s.name, partner: null })), ...(job ? [] : [...companies.values()])];
    for (const v of noOne) await keepLogoOff(DB, record, job?.id || null, [{}], v.name, v.partner, at);
  }
  if (!job) return out;
  if (down) { out.pending = [...companies.values()].map((v) => v.name); return out; }

  // The job
  let aces;
  try { aces = (await fetchAccess(key, [job.id], fetchImpl)).get(job.id); } catch { out.pending = [...companies.values()].map((v) => v.name); return out; }
  // JobTread listing nobody settles nothing: the sweep finishes it from a real list
  if (!aces?.nodes?.length) { out.pending = [...companies.values()].map((v) => v.name); return out; }
  const fresh = (await loadAllKidsOrProjects(DB, rec)) || rec;
  const pageVendors = jobVendors(fresh, { partners, pairs, accounts: [], bills: [] });
  for (const [who, v] of companies) {
    const last = seen.get(`${job.id} ${who}`);
    const { going, left } = goingFrom(v, aces, othersOn(fresh, pageVendors, who, bySlug, pairs), contactsOf, last?.people || [], bills.get(job.id) || []);
    const names = going.map((m) => m.user?.name || m.user?.emailAddress);
    // Who's coming off is written down before they do, so Undo can bring back all of them
    const now2 = (await readSeen(DB)).get(`${job.id} ${who}`);
    const took = tookFrom(v, going, now2?.took || last?.took || []);
    if (now2) await seenStatement(DB, { ...now2, took }, at).run();
    try { await revokePeople(env, job.id, going, at, fetchImpl); } catch { out.pending.push(v.name); continue; }
    await offForGood(DB, { job, record, who, v, same: { ...last, took, beforeOff: now2?.beforeOff }, going, left, removed: out.removed, at });
    const entry = entries.find((e) => e.name === v.name);
    if (entry && names.length) await nameTaken(DB, entry, names);
    out.taken.push({ name: v.name, people: names });
    if (left.length) out.left.push({ name: v.name, people: left.map((m) => m.user?.name || m.user?.emailAddress) });
  }
  return out;
}
const loadAllKidsOrProjects = async (DB, rec) => (isProject(rec) ? await loadAllProjects(DB) : await loadAllKids(DB)).find((r) => r.slug === rec.slug);

/**
 * Who and what came off goes back, now, from what the site wrote down at the time (not what a tab remembers).
 * who: their keys, from takeOffJob or the Vendors list. undo: reverse that one take-off and no more, so someone who
 * had already left the job in JobTread stays off; without it (Put back) everyone who came off goes back on.
 * keepLogos: only the people, for a logo a person has just put on the page themselves.
 * → { jobId, back: [people], logos: [{ url, name, at }], pending: [names], sha? }
 */
export async function putBackJob(env, { record, who = [], logos: loose = [], sha = null, undo = false, keepLogos = false }, by = null, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const at = iso(now);
  const [kids, projects, partners, seen] = await Promise.all([loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readSeen(DB)]);
  const rec = [...kids, ...projects].find((r) => keyOf(r) === record);
  if (!rec) throw Object.assign(new Error('That page isn’t there any more. Reload and try again.'), { status: 409, unchanged: true });
  const rows = [...seen.values()].filter((r) => r.record === record && who.includes(r.who) && (r.off || r.goneAt));
  const out = { jobId: rows[0]?.job_id || null, back: [], logos: [], pending: [] };
  // loose: logos with no company behind them (no open job, or nobody knows whose), which only the page holds.
  // Undo brings back only what that take-off removed, not a logo from before it
  const ownLogos = (r) => (undo && r.beforeOff ? (r.goneLogos || []).filter((l) => !(r.beforeOff.goneLogos || []).some((x) => x.url === l.url)) : r.goneLogos || []);
  const logos = keepLogos ? loose : [...rows.flatMap(ownLogos), ...loose];
  if (loose.length) await forgetCompany(DB, record, { names: loose.map((l) => l.name) });
  if (logos.length) {
    if (!(await takeLock(DB, true, 'sync'))) throw Object.assign(new Error('That page is busy. Try again in a moment.'), { status: 503, unchanged: true });
    try {
      const done = await pageLogosOn(env, { table: tableOf(rec), slug: rec.slug, logos, sha }, by || SYNC_USER);
      if (done.sha) out.sha = done.sha;
      out.logos = logos;
    } catch (e) { e.unchanged = true; throw e; } finally { await freeLock(DB, 'sync'); }
  }
  let mode = null;
  if (rows.length) mode = await roleMode(env, { fetchImpl }).catch(() => null);
  const bySlug = new Map(partners.map((p) => [p.slug, p]));
  for (const row of rows) {
    // Undo: only who this take-off took off, and the row as it stood before it
    const before = (undo && row.beforeOff) || {};
    const hadTaken = new Set((before.took || []).map((t) => t.email));
    const owed = (row.took || []).filter((t) => !hadTaken.has(t.email));
    await forgetSiteRevokes(DB, row.job_id, owed.map((t) => t.email));
    const { people, failed } = await grantBack(env, row, owed, mode, bySlug, { fetchImpl, now });
    out.back.push(...people.map((p) => p.name));
    if (failed.length) out.pending.push(row.name);
    // On the job means on the page, so whatever was keeping their logo away goes
    await forgetCompany(DB, record, { partner: row.partner, names: [row.name], emails: owed.map((t) => t.email) });
    const stood = before.off || before.goneAt;
    await seenStatement(DB, { ...row, off: failed.length ? 'returning' : before.off && before.off !== 'going' ? before.off : null, goneAt: stood && !failed.length ? before.goneAt || null : null,
      people: [...(stood ? before.people || [] : []), ...people.map(({ id, email, name }) => ({ id, email, name }))], logos: stood ? before.logos || [] : [], leftOn: stood ? before.leftOn || [] : [], goneLogos: stood ? before.goneLogos || [] : [], took: failed.length ? failed : stood ? before.took || [] : [], beforeOff: null }, at).run();
    await logMakeover(DB, { record, at, action: 'added', side: 'website', name: row.name, people: owed.map((t) => t.name || t.email), by });
    await dropTaken(DB, record, row.name);
  }
  return out;
}

/** Those people back on the job → { people: [{ id, email, name }], failed: those JobTread didn't take } */
async function grantBack(env, row, owed, mode, bySlug, { fetchImpl, now }) {
  const people = [];
  const failed = [];
  for (const t of owed) {
    try {
      if (!mode) throw new Error('JobTread isn’t answering');
      const g = await grantJobAccess(env, row.job_id, { name: t.name || row.name, email: t.email }, row.partner && bySlug.has(row.partner) ? mode.partner(bySlug.get(row.partner)) : mode.trade, { notify: false, fetchImpl, now });
      if (g.membership && !g.internal) people.push({ id: g.membership, email: t.email, name: t.name || row.name });
    } catch { failed.push(t); }
  }
  return { people, failed };
}

/**
 * A person added a company on the website, and it goes on the job now, not at the next sweep. logos: the
 * ones just saved on the page; account + name: a trade partner, who has no logo. → { jobId, added: [names], waiting: [names] }
 */
export async function addToJob(env, { record, logos = [], account = null, name = '' }, by = null, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const at = iso(now);
  const [kids, projects, partners, seen] = await Promise.all([loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readSeen(DB)]);
  const records = [...kids, ...projects];
  const rec = records.find((r) => keyOf(r) === record);
  if (!rec) throw Object.assign(new Error('That page isn’t there any more. Reload and try again.'), { status: 409, unchanged: true });
  // Which companies: the person's say comes first and needs no JobTread, so a hand add stands even while it's down
  const usage = kidUsage([{ partnerLogos: logos, slug: '_', publishStatus: 'published' }], partners).byPartner;
  const named = logos.map((l) => partners.find((x) => usage.get(x.slug)?.some((row) => logoId(row.url) === logoId(l.url))) || partners.find((x) => sameName(x.name, l.name)) || null);
  const here = [...seen.values()].filter((r) => r.record === record);
  const theirs = here.filter((r) => (account && r.who === `a:${account}`) || named.some((p) => p && r.who === `p:${p.slug}`) || logos.some((l) => !r.partner && sameName(r.name, l.name)));
  // Added back: the same people who came off, not just whoever the company's main contact is. Only a row that was off
  // or waiting; one standing as normal keeps who it knows, so a removal right after still registers
  const out = { jobId: here[0]?.job_id || null, added: [], waiting: [] };
  // Whatever was keeping this logo off the page goes: a person has just put it there
  await forgetCompany(DB, record, { names: [...logos.map((l) => l.name), ...named.filter(Boolean).map((p) => p.name), name].filter(Boolean) });
  const offNow = theirs.filter((r) => r.off || r.goneAt);
  if (offNow.length) out.added.push(...(await putBackJob(env, { record, who: offNow.map((r) => r.who), keepLogos: true }, by, { fetchImpl, now })).back);
  const job = linkJobs(await fetchOpenJobs(key, fetchImpl), records).get(record) || null;
  out.jobId = job?.id || null;
  if (!job) return out;
  // Someone the last look had, gone from the job now: a person is adding them, so that look no longer stands in the way
  const onNow = new Set(outsidersOn((await fetchAccess(key, [job.id], fetchImpl)).get(job.id)).map((m) => m.id));
  for (const row of theirs) {
    const fresh = (await readSeen(DB)).get(`${row.job_id} ${row.who}`);
    if (fresh?.people.length && !fresh.people.some((p) => onNow.has(p.id))) await seenStatement(DB, { ...fresh, people: [] }, at).run();
  }
  if (account) {
    if (out.added.length) return out;
    const a = (await fetchVendorAccounts(key, fetchImpl)).find((x) => x.id === account);
    const last = seen.get(`${job.id} a:${account}`);
    const person = a && (personFor({ account: a, name }, []) || (last?.took?.[0] ? { ...last.took[0], name: last.took[0].name || name } : null));
    if (!person) { out.waiting.push(name); return out; }
    const mode = await roleMode(env, { fetchImpl });
    const g = await grantJobAccess(env, job.id, person, mode.trade, { notify: false, fetchImpl, now });
    await logMakeover(DB, { record, at, action: 'added', side: 'website', name, people: [person.name], by });
    if (g.membership && !g.internal) await sawPutOn(DB, { job_id: job.id, who: `a:${account}`, record, name, partner: null, account_id: account, logos: [], off: null }, { id: g.membership, email: person.email, name: person.name }, at);
    out.added.push(person.name);
    return out;
  }
  // A few now; the sweep gets to any more within 15 minutes
  for (const p of [...new Set(named.filter(Boolean))].slice(0, 3)) {
    const r = await syncVendorAccess(env, { only: nameKey(p.name), fetchImpl, now });
    const people = (r.added || []).filter((x) => nameKey(x.name) === nameKey(p.name)).map((x) => x.person);
    // Already on the job: remembered now, so a removal right after still registers
    const row = (await readSeen(DB)).get(`${job.id} p:${p.slug}`);
    if (row && !row.people.length && !row.off) {
      const contacts = (await readContacts(DB))[p.slug] || [];
      const aces = (await fetchAccess(key, [job.id], fetchImpl)).get(job.id);
      const sure = outsidersOn(aces).filter((m) => surelyTheirs({ company: nameKey(p.name), name: p.name, partner: p.slug, account: row.account_id ? { id: row.account_id, contacts: [] } : null }, m, { people: contacts })).map(personOf);
      if (sure.length) await seenStatement(DB, { ...row, people: sure }, at).run();
    }
    if (people.length) { out.added.push(...people); await logMakeover(DB, { record, at, action: 'added', side: 'website', name: p.name, people, by }); } else if (r.waiting) out.waiting.push(p.name);
  }
  return out;
}

/**
 * One makeover's vendors, for its page in the admin: JobTread read now, so it says how things really are.
 * → { job, rows: [{ who, name, partner, account, people: [{ name, role }], role, onPage, onJob, onInvite (null: no invite
 * out yet), off, bill, noEmail }], trade: [{ id, name }] to add, history: [{ at, action, side, name, people, by }] }
 */
export async function makeoverView(env, record, { fetchImpl = fetch } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const [kids, projects, partners, contactsAll, accountRows, seen, links, { byJob: bills }, jtOnly, accessRows, history] = await Promise.all([
    loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readContacts(DB), readAccountRows(DB), readSeen(DB), readLinks(DB), billsByJob(DB), readKey(DB, 'jt-only'),
    DB.prepare('SELECT company, state, reason FROM vendor_access').all().then((r) => r.results || []),
    DB.prepare('SELECT at, action, side, name, people, by FROM vendor_job_log WHERE record = ? ORDER BY id DESC LIMIT 20').bind(record).all().then((r) => r.results || []),
  ]);
  const records = [...kids, ...projects];
  const rec = records.find((r) => keyOf(r) === record);
  if (!rec) throw Object.assign(new Error('That page isn’t there any more.'), { status: 409 });
  const job = key ? linkJobs(await fetchOpenJobs(key, fetchImpl), records).get(record) || null : null;
  const aces = job ? (await fetchAccess(key, [job.id], fetchImpl)).get(job.id) : null;
  const invite = job ? await DB.prepare('SELECT guests, event_id, state FROM reveal_invites WHERE job_id = ?').bind(job.id).first().catch(() => null) : null;
  const guests = invite?.event_id && invite.state !== 'cancelled' ? parse(invite.guests, []).map(lower) : null;
  const pairs = new Map([...accountRows].map(([slug, r]) => [slug, { id: r.account_id, name: r.account_name, contacts: r.jt_seen || [] }]));
  const bySlug = new Map(partners.map((p) => [p.slug, p]));
  const contactsOf = (v) => ({ people: v.partner ? contactsAll[v.partner] || [] : [], website: bySlug.get(v.partner)?.website, links });
  const rows = new Map();
  const put = (who, v, patch = {}) => {
    const r = rows.get(who) || { who, name: v.name, partner: v.partner || null, account: v.account?.id || null, v, people: [], onPage: false, bill: false, off: null };
    rows.set(who, Object.assign(r, patch));
    return r;
  };
  // JobTread-only companies with a logo: the last looks know their accounts, so a full read of vendors isn't needed
  const known = [...seen.values()].filter((r) => r.job_id === job?.id && !r.partner && r.account_id).map((r) => ({ id: r.account_id, name: r.name, contacts: [] }));
  for (const v of jobVendors(rec, { partners, pairs, accounts: known, bills: [] })) put(whoOf(v), v, { onPage: true });
  const names = new Map(((await DB.prepare('SELECT jt_id, name FROM vendors WHERE jt_id IS NOT NULL').all().catch(() => ({ results: [] }))).results || []).map((r) => [r.jt_id, r.name]));
  for (const id of job ? bills.get(job.id) || [] : []) {
    const slug = [...pairs].find(([, a]) => a.id === id)?.[0];
    const p = slug && bySlug.get(slug);
    const v = p ? { company: nameKey(p.name), name: p.name, partner: p.slug, account: pairs.get(p.slug) } : { company: nameKey(names.get(id)), name: names.get(id) || 'A vendor', partner: null, account: { id, contacts: [] } };
    put(whoOf(v), v, { bill: true });
  }
  for (const row of seen.values()) {
    if (row.job_id !== job?.id || row.record !== record) continue;
    if (row.off || row.goneAt || rows.has(row.who)) put(row.who, { name: row.name, partner: row.partner, account: row.account_id ? { id: row.account_id, contacts: [] } : null, company: nameKey(row.name) }, { off: row.off, gone: !!row.goneAt });
  }
  const sponsors = new Set(rec.data?.sponsors || []);
  const unclaimed = [];
  for (const m of outsidersOn(aces)) {
    const one = { nodes: [{ membership: m }] };
    const mine = (r) => seen.get(`${job.id} ${r.who}`)?.people.some((p) => p.id === m.id) || surelyTheirs(r.v, m, contactsOf(r.v));
    // Theirs for certain first; a website match can be another company's
    const hit = [...rows.values()].find(mine) || [...rows.values()].find((r) => peopleOnJob(r.v, one, contactsOf(r.v)).length);
    const sponsor = [...sponsors].some((s) => { const p = bySlug.get(s); return p && peopleOnJob({ company: nameKey(p.name), name: p.name, partner: s, account: pairs.get(s) || null }, one, contactsOf({ partner: s })).length; });
    if (hit) hit.people.push(m);
    else if (!sponsor && isPartnerRole(m.role?.name)) unclaimed.push(m);
  }
  for (const m of unclaimed) {
    const name = m.account?.name || m.user?.name || m.user?.emailAddress;
    const r = put(`a:${m.account?.id || `n-${nameKey(name)}`}`, { name, partner: null, account: m.account?.id ? { id: m.account.id, contacts: [] } : null, company: nameKey(name) });
    r.people.push(m);
  }
  const noEmail = new Set(accessRows.filter((r) => r.state === 'waiting' && r.reason === 'no-email').map((r) => r.company));
  const out = [...rows.values()].map((r) => ({
    who: r.who, name: r.name, partner: r.partner, account: r.account, people: r.people.map((m) => ({ name: m.user?.name || m.user?.emailAddress, role: m.role?.name || null })),
    role: r.people[0]?.role?.name || null, onPage: r.onPage, onJob: r.people.length > 0, bill: r.bill, off: r.off, gone: !!r.gone,
    onInvite: guests ? r.people.some((m) => guests.includes(lower(m.user?.emailAddress))) : null, noEmail: !r.people.length && noEmail.has(nameKey(r.name)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    job: job ? { id: job.id } : null, rows: out,
    trade: (Array.isArray(jtOnly) ? jtOnly : []).filter((v) => v.kind === 'trade' && !rows.has(`a:${v.id}`)).map((v) => ({ id: v.id, name: v.name })).sort((a, b) => a.name.localeCompare(b.name)),
    history: history.map((h) => ({ ...h, people: parse(h.people, []) })),
  };
}

/** A company's last look on a job, by its key or, for one that's become a partner since, by its JobTread account */
const lookFor = (seen, jobId, who, v) => seen.get(`${jobId} ${who}`) || (v.account?.id ? [...seen.values()].find((r) => r.job_id === jobId && r.account_id === v.account.id) : null) || null;

/** Each job's changes since the last look, worked out before anything is touched */
function planJob({ k, job, rec, aces, seen, last, tookBySite, vendors, ctx, at, now }) {
  const { bySlug, pairs, accounts, contactsAll, setAside, links, early } = ctx;
  const data = rec.data || {};
  const fresh = !last || last.record !== k || now - Date.parse(last.at) > STALE_LOOK_MS;
  const outsiders = outsidersOn(aces);
  const onJobIds = new Set(outsiders.map((m) => m.id));
  const contactsOf = (v) => ({ people: v.partner ? contactsAll[v.partner] || [] : [], website: bySlug.get(v.partner)?.website, links });
  const stale = [];

  const entries = new Map();
  for (const v of vendors) entries.set(whoOf(v), v);
  for (const row of seen.values()) {
    if (row.job_id !== job.id || entries.has(row.who)) continue;
    // Someone listed under another key now: they've become a partner, and lookFor finds this row for them
    if (row.account_id && [...entries.values()].some((v) => v.account?.id === row.account_id)) continue;
    const p = row.partner ? bySlug.get(row.partner) : null;
    // Merged or deleted in Partners, set aside, or another page's since the job was relinked: none of it is someone leaving
    if (row.record !== k || (row.partner && !p) || (setAside[nameKey(p?.name || row.name)] && !row.off)) { stale.push(row.who); continue; }
    const a = accounts.find((x) => x.id === row.account_id) || null;
    entries.set(row.who, p ? { company: nameKey(p.name), name: p.name, partner: p.slug, account: pairs.get(p.slug) || null, why: new Set(), logos: [] }
      : { company: nameKey(a?.name || row.name), name: a?.name || row.name, partner: null, account: a, why: new Set(), logos: [] });
  }

  const plans = [];
  for (const [who, v] of entries) {
    const row = lookFor(seen, job.id, who, v);
    // A person changed this row after this run began: the access list is older than that, so it waits for the next
    if (row?.updated_at > at) continue;
    if (row && early.get(`${row.job_id} ${row.who}`)?.updated_at !== row.updated_at) continue;
    const same = row && row.record === k ? row : null;
    // Someone the site took off isn't someone a person took off. Still here, and the site never got that far
    const was = same && { ...same, people: same.people.filter((p) => onJobIds.has(p.id) || !tookBySite.has(`${job.id} ${p.email}`)) };
    const opts = contactsOf(v);
    const sure = outsiders.filter((m) => surelyTheirs(v, m, opts)).map(personOf);
    const stillHere = (was?.people || []).filter((p) => onJobIds.has(p.id));
    // Someone who came off with them and is on the job again is them back, however they're known
    const took = new Set(same?.off ? (same.took || []).map((p) => lower(p.email)) : []);
    const returned = outsiders.filter((m) => took.has(lower(m.user?.emailAddress))).map(personOf);
    const people = [...new Map([...sure, ...stillHere, ...returned].map((p) => [p.id, p])).values()];
    const everyone = [...new Set([...peopleOnJob(v, aces, opts).map((m) => m.id), ...people.map((p) => p.id)])];
    const present = everyone.length > 0;
    // Someone left behind who's gone since no longer counts as left behind: if they return, that's them back
    const leftOn = aces.nodes.length ? (same?.leftOn || []).filter((id) => onJobIds.has(id)) : same?.leftOn || [];
    const back = everyone.some((id) => !leftOn.includes(id));
    const logos = v.why.has('page') ? [...new Set(v.logos.map(logoId))] : [];
    // A long gap starts afresh, but someone a person took off stays off
    const step = changeOnJob(fresh && !same?.off && !same?.goneAt ? null : was, { people, present, back, logos }, at);
    plans.push({ who, v, was, same, raw: row, present, leftOn, ...step });
  }
  return { k, job, rec, aces, vendors, plans, stale, contactsOf, looked: { at, record: k } };
}

/** Turn the JobTread side on, or back to only noting what it would do: the launch switch, and the off switch */
export async function setWatch(env, { on }, by = null, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  await writeKey(env.DB, 'watch', { on: !!on, by, at: iso(now) });
  await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-access', entityName: on ? 'JobTread removals turned on' : 'JobTread removals back to only noted' });
}

/** Slack hears once, when it's new: what's waiting and what to do about it. → whether it went */
async function tellLeaving(env, list) {
  const names = [...new Set(list.map((h) => h.name))];
  return slackPost(env, slackCard({
    icon: '⚠️', title: `${names.length} ${names.length === 1 ? 'company' : 'companies'} left jobs in JobTread all at once`,
    lead: `That many at once is more often a mistake than a real change, so their logos stay on the page: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}. If it’s real, take them off on each makeover’s page in the admin.`,
    buttons: [{ label: 'Open Kids', url: 'https://sunshineonaranneyday.com/admin/#kids' }],
  })).then((r) => r?.ok !== false, () => false);
}

/**
 * Every open job, since the last look: anyone taken off in JobTread, and any takeOffJob a dying
 * run left unfinished. seen is kept up to date for the puts-on after it. access holds every linked job's aces.
 */
async function settleRemovals(env, ctx) {
  const { linked, byKey, vendorsOn, access, seen, bySlug, pairs, bills, fetchImpl, now, at, report } = ctx;
  const { DB } = env;
  const started = Date.now();
  const room = () => Date.now() - started < WRITE_BUDGET_MS;
  const looked = await readKey(DB, 'looked');
  const siteRows = (await DB.prepare('SELECT job_id, email FROM vendor_site_revokes').all()).results || [];
  const tookBySite = new Set(siteRows.map((r) => `${r.job_id} ${r.email}`));
  // A run that died after a logo came off and before it asked for the publish
  if ((await readKey(DB, 'publish-due')).at) {
    await requestDeploy(env, now, 'Partner logos from JobTread');
    await writeKey(DB, 'publish-due', {});
  }

  const jobs = [];
  for (const [k, job] of linked) {
    const rec = byKey.get(k);
    const aces = access.get(job.id);
    // Nothing to go on: an unreadable record. Nobody is put back meanwhile (staysOffJob)
    if (!aces?.nodes || !Array.isArray(rec.data?.partnerLogos)) continue;
    jobs.push(planJob({ k, job, rec, aces, seen, last: looked[job.id], tookBySite, vendors: vendorsOn.get(job.id) || [], ctx, at, now }));
  }

  // Too many at once, or in a day on one job, looks like a wrong read or the end of a build: nothing moves, a person
  // hears once, and each stays that way until someone takes it off or it comes back, never because the count fell
  // Until staff turn it on, what would come off is only noted, so it can be checked against what really happened
  const watching = !(await readKey(DB, 'watch')).on;
  const noted = await readKey(DB, 'watched');
  // Too many at once, or in a day on one job, looks like a wrong read or the end of a build: nothing moves, a person
  // hears once, and each stays that way until someone takes it off or it comes back, never because the count fell
  const told = await readKey(DB, 'leaving-told');
  const said = await readKey(DB, 'taken-off');
  const pulledToday = (k) => (said.list || []).filter((e) => e.how === 'jobtread' && !e.kept && e.record === k && now - Date.parse(e.at) < DAY_MS).length;
  const isLeaving = (x) => x.act === 'off-page' || (x.act === 'wait' && x.next.logos.length > 0);
  const leaving = jobs.flatMap((j) => j.plans.filter(isLeaving).map((x) => ({ j, x })));
  const tooMany = leaving.length >= MAX_LEAVING_IN_RUN;
  const overOn = (j) => j.plans.filter(isLeaving).length + pulledToday(j.k) > MAX_LEAVING_ON_JOB;
  // A job JobTread lists nobody on could be the only person coming off, or a fault: a person looks either way
  const toldOf = (j, x) => told[`${j.job.id} ${x.who}`] || (x.same ? told[`${j.job.id} ${x.same.who}`] : null);
  const held = new Map(leaving.filter(({ j, x }) => tooMany || overOn(j) || !j.aces.nodes.length || toldOf(j, x)).map(({ j, x }) => [`${j.job.id} ${x.who}`, x]));
  const untold = leaving.filter(({ j, x }) => held.has(`${j.job.id} ${x.who}`) && !toldOf(j, x)?.said);
  const readJobs = new Set(jobs.map((j) => j.job.id));
  const openJobs = new Set(linked.map(([, job]) => job.id));
  // A job that couldn't be read this run keeps what was said about it; one that's closed has nothing left to say
  const stillSaid = Object.fromEntries([...Object.entries(told).filter(([k]) => !readJobs.has(k.split(' ')[0]) && openJobs.has(k.split(' ')[0])), ...[...held].map(([k, x]) => { const { j } = leaving.find((l) => l.x === x); const was = toldOf(j, x); return [k, { at: was?.at || at, said: !!was?.said, name: x.v.name, page: pageName(j.rec), record: j.k }]; })]);
  if (held.size) {
    report.problems.push(`${held.size} ${held.size === 1 ? 'company' : 'companies'} left jobs in JobTread at once, so their logos stay on the page until someone looks. If it’s real, take them off on each makeover’s page.`);
    if (untold.length && await tellLeaving(env, [...held.values()].map((x) => ({ name: x.v.name })))) for (const [k] of held) stillSaid[k].said = true;
  }
  await writeKey(DB, 'leaving-told', stillSaid);

  let published = false;
  const watched = {};
  for (const j of jobs) {
    const { k, job, rec, plans } = j;
    for (const who of j.stale) { await forgetSeen(DB, job.id, who); seen.delete(`${job.id} ${who}`); }

    const remember = []; // what only needs remembering goes in one write: the first look at a job is every company on it
    const drops = [];
    const rowOf = (x, next) => ({ ...next, job_id: job.id, who: x.who, record: k, name: x.v.name, partner: x.v.partner, account_id: x.v.account?.id || x.same?.account_id || null, took: next.off || !x.present ? (next.took?.length ? next.took : x.same?.took || []) : [], leftOn: next.off ? x.leftOn : [], goneLogos: next.off ? x.same?.goneLogos || [] : [], beforeOff: next.off ? x.same?.beforeOff || null : null });
    const unchanged = (a, b) => !!a && a.who === b.who && JSON.stringify([a.people, a.logos, a.off || null, a.goneAt || null, a.leftOn || []]) === JSON.stringify([b.people, b.logos, b.off || null, b.goneAt || null, b.leftOn || []]);
    for (const x of plans) {
      const { who, v, same, next } = x;
      if (x.act === 'return') {
        const onJobNow = new Set(outsidersOn(j.aces).map((m) => lower(m.user?.emailAddress)));
        const owed = (same.took || []).filter((t) => !onJobNow.has(t.email));
        const mode = await roleMode(env, { fetchImpl }).catch(() => null);
        const { people, failed } = await grantBack(env, same, owed, mode, bySlug, { fetchImpl, now });
        const row = { ...same, off: failed.length ? 'returning' : null, took: failed, people: [...same.people, ...people.map(({ id, email, name }) => ({ id, email, name }))] };
        await seenStatement(DB, row, at).run();
        seen.set(`${job.id} ${who}`, row);
        if (failed.length) report.problems.push(`Couldn’t put ${v.name} back on ${pageName(rec)}’s job yet. The site keeps trying.`);
        continue;
      }
      if (x.act === 'finish') {
        if (now - Date.parse(same.updated_at || 0) < GOING_RETRY_MS || !j.aces.nodes.length) continue; // still under way, or nothing to go on
        try {
          if (same.logos.length) {
            const left = await takeLogosOff(env, rec, [{ pull: same.logos, name: v.name }], at);
            if (!left) continue; // busy: next run
            if (left.length) { same.goneLogos = left; await writeKey(DB, 'publish-due', { at }); }
          }
          const { going, left } = goingFrom(v, j.aces, othersOn(rec, j.vendors, who, bySlug, pairs), j.contactsOf, same.people, bills.get(job.id) || []);
          same.took = tookFrom(v, going, same.took || []);
          await seenStatement(DB, same, at).run();
          await revokePeople(env, job.id, going, at, fetchImpl);
          await offForGood(DB, { job, record: k, who, v, same, going, left, at });
          const list = (await readKey(DB, 'taken-off')).list || [];
          const entry = list.find((e) => e.record === k && e.name === v.name && e.how === 'page');
          if (!entry) await noteTaken(DB, { at, how: 'page', name: v.name, page: pageName(rec), record: k, people: going.map((m) => m.user?.name || m.user?.emailAddress) });
          else if (!entry.people?.length && going.length) await nameTaken(DB, entry, going.map((m) => m.user?.name || m.user?.emailAddress));
          seen.set(`${job.id} ${who}`, { ...same, people: [], logos: [], off: 'site', leftOn: left.map((m) => m.id) });
        } catch (e) { report.problems.push(`Couldn’t take ${v.name} off ${pageName(rec)}’s job: ${e.message}`); }
        continue;
      }
      if (x.act === 'off-page') {
        if (watching && !held.has(`${job.id} ${who}`)) {
          const key = `${job.id} ${who}`;
          watched[key] = noted[key] || { at, name: v.name, page: pageName(rec), record: k };
          if (!noted[key]) await logMakeover(DB, { record: k, at, action: 'would-remove', side: 'jobtread', name: v.name });
          continue;
        }
        if (held.has(`${job.id} ${who}`) || !room()) { if (!held.has(`${job.id} ${who}`)) report.more = true; continue; } // the last look stands
        drops.push({ x, name: v.name, pull: x.pull });
        continue;
      }
      if (x.act === 'stay-off') {
        if (!j.aces.nodes.length) continue; // JobTread lists nobody: nothing is settled on that
        await forgetCompany(DB, k, { partner: v.partner, names: [v.name], emails: (same?.people || []).map((p) => p.email) });
        await noLongerAdded(DB, job.id, v.company);
        const entry = { at, how: 'jobtread', name: v.name, page: pageName(rec), record: k, kept: true };
        await noteTaken(DB, entry);
        (report.taken ||= []).push(entry);
      } else if (x.act === 'back') {
        // Added again in JobTread: the very logo that left goes back, unless one's there already. Busy: next run, nothing lost
        if ((same?.goneLogos || []).length && !v.why.has('page')) {
          if (!(await takeLock(DB, false, 'sync'))) continue;
          try { await pageLogosOn(env, { table: tableOf(rec), slug: rec.slug, logos: same.goneLogos }, SYNC_USER); published = true; await writeKey(DB, 'publish-due', { at }); } catch (e) {
            report.problems.push(`Couldn’t put ${v.name}’s logo back on ${pageName(rec)}: ${e.message}`);
            continue;
          } finally { await freeLock(DB, 'sync'); }
        }
        await forgetCompany(DB, k, { partner: v.partner, names: [v.name], emails: (x.next.people || []).map((p) => p.email) });
      }
      const row = rowOf(x, next);
      seen.set(`${job.id} ${who}`, row);
      if (!unchanged(same, row)) remember.push(rememberStatement(DB, row, at, x.raw));
    }
    for (let i = 0; i < remember.length; i += 50) await DB.batch(remember.slice(i, i + 50));
    // One that's become a partner since moves to its new key, once that's written; one held or watched stays where it is
    const moved = () => plans.filter((x) => x.same && x.same.who !== x.who && seen.has(`${job.id} ${x.who}`));
    for (const x of moved()) { await forgetSeen(DB, job.id, x.same.who); seen.delete(`${job.id} ${x.same.who}`); }

    if (drops.length) {
      const entries = drops.map((d) => ({ at, how: 'jobtread', name: d.name, page: pageName(rec), record: k }));
      try {
        for (const e of entries) await noteTaken(DB, e);
        await writeKey(DB, 'publish-due', { at });
        // What's about to leave is written down first, so a run dying here doesn't lose it for Put back
        const shown = (rec.data?.partnerLogos || []).map((l, i) => ({ url: l?.url, name: l?.name || '', at: i }));
        for (const d of drops) await DB.prepare('UPDATE vendor_job_seen SET gone_logos = ? WHERE job_id = ? AND who = ?').bind(JSON.stringify(shown.filter((l) => d.pull.includes(logoId(l.url)))), job.id, d.x.same?.who || d.x.who).run();
        const left = await takeLogosOff(env, rec, drops, at);
        if (!left) { for (const e of entries) await unnoteTaken(DB, e); continue; } // busy: next run
        published = true;
        for (const d of drops) {
          await forgetCompany(DB, k, { partner: d.x.v.partner, names: [d.name], emails: (d.x.same?.people || []).map((p) => p.email) });
          await noLongerAdded(DB, job.id, d.x.v.company);
          const row = { ...rowOf(d.x, d.x.next), goneLogos: left.filter((l) => d.pull.includes(logoId(l.url))), updated_at: at };
          seen.set(`${job.id} ${d.x.who}`, row);
          await seenStatement(DB, row, at).run();
        }
        (report.taken ||= []).push(...entries);
        await slackPost(env, slackCard({ icon: 'ℹ️', title: `${drops.map((d) => d.name).join(', ')} left ${pageName(rec)}’s job`, lead: `Taken off in JobTread, so ${drops.length === 1 ? 'the logo' : 'their logos'} came off the page. Put them back from the page’s Vendors list if that was a mistake.`,
          buttons: [{ label: 'Open the page', url: `https://sunshineonaranneyday.com/admin/#kids/${k}` }] })).catch(() => {});
      } catch (e) {
        for (const t of entries) await unnoteTaken(DB, t).catch(() => {});
        report.problems.push(`Couldn’t take ${drops.map((d) => d.name).join(', ')} off ${pageName(rec)}: ${e.message}`);
      }
    }
    looked[job.id] = j.looked;
  }

  await writeKey(DB, 'looked', looked);
  await writeKey(DB, 'watched', watched);
  if ((await readKey(DB, 'publish-due')).at) published = true;
  // The site's own removals have been read by now; the rows of a job not looked at wait for it
  for (const r of siteRows) if (jobs.some((j) => j.job.id === r.job_id)) await DB.prepare('DELETE FROM vendor_site_revokes WHERE job_id = ? AND email = ?').bind(r.job_id, r.email).run();
  if (published) {
    await requestDeploy(env, now, 'Partner logos from JobTread');
    await writeKey(DB, 'publish-due', {});
  }
}

/** Not to put on the job now: a person took them off, or they've left and that isn't settled (or JobTread listed nobody) */
function staysOffJob(row, aces) {
  if (!row) return false;
  if (row.off || row.goneAt) return true;
  const ids = new Set((aces?.nodes || []).map((a) => a?.membership?.id));
  return row.people.length > 0 && !row.people.some((p) => ids.has(p.id));
}

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
            await combineTwin(env, { ...c, staff: holds.get(c.drop.id)?.staff || [] }, { accountRows, fetchImpl, at, by: SYNC_USER });
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
    const vendorsOn = new Map(); // job id → its vendors, for who's left since the last look
    const loose = []; // logos nobody goes by: [{ name, record, page }]
    for (const [k, job] of linked) {
      const rec = byKey.get(k);
      const names = [];
      for (const v of jobVendors(rec, { partners, pairs, accounts, bills: bills.get(job.id) || [], trade, loose: names })) {
        if (only && v.company !== only) continue;
        if (setAside[v.company]) continue;
        want.push({ k, rec, job, v });
        vendorsOn.set(job.id, [...(vendorsOn.get(job.id) || []), v]);
      }
      for (const name of new Set(names)) loose.push({ name, record: k, page: pageName(rec) });
    }

    // Every partner with no JobTread vendor account gets one, those on a page first; a near name waits for staff
    const onPages = [...new Map(want.filter((w) => w.v.partner && !w.v.account && w.v.why.has('page')).map((w) => [w.v.partner, w.v])).values()];
    const needAccounts = [...onPages, ...partners
      .filter((p) => (!only || nameKey(p.name) === only) && !pairs.has(p.slug) && !onPages.some((v) => v.partner === p.slug))
      .map((p) => ({ partner: p.slug, name: p.name }))];
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
      // A JobTread vendor called only a place ("Atlanta") is never offered as the same as Atlanta Falcons
      const named = open.filter((a) => !placeOnly(wordsOf(a.name))).map((a) => ({ slug: a.id, name: a.name }));
      const close = [...new Map([...holding, ...archived, ...nearPartners(v.name, named, { min: 0.6, max: 2 })]
        .map((c) => [c.partner.slug, c])).values()].slice(0, 2);
      // Staff said the match was wrong: they pick another near name or a new vendor, never the sweep
      if ((close.length || was.length) && !newOk[v.partner]) {
        near[v.partner] = { name: v.name, near: close.map((c) => ({ id: c.partner.slug, name: c.partner.name, why: c.why })), ...(was.length ? { was } : {}) };
        continue;
      }
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
    // JobTread's vendors that aren't partners, so staff can see who they are
    if (!only) {
      const onJobs = new Map();
      for (const ids of bills.values()) for (const id of ids) onJobs.set(id, (onJobs.get(id) || 0) + 1);
      const inPartners = new Set([...pairs.values()].map((a) => a.id));
      await writeKey(DB, 'jt-only', accounts.filter((a) => !a.archived && !inPartners.has(a.id)).map((a) => {
        const jobs = onJobs.get(a.id) || 0;
        return { id: a.id, name: a.name, kind: vendorKind(a, { order: orders.has(a.id), jobs }), jobs };
      }));
    }

    // Who's on each job already. A job whose last logo just came off still has to be looked at
    // What's written down from here on is newer than the access read below, so those rows wait for the next run
    const early = await readSeen(DB);
    const toRead = only ? want.map((w) => w.job.id) : linked.map(([, job]) => job.id);
    const access = toRead.length ? await fetchAccess(key, [...new Set(toRead)], fetchImpl) : new Map();
    // Who's left a job since the last look, and they aren't put back below
    const seen = await readSeen(DB);
    if (!only) await settleRemovals(env, { linked, byKey, bySlug, pairs, accounts, contactsAll, setAside, links, bills, vendorsOn, access, seen, early, fetchImpl, now, at, report });
    // Then the ones who belong on a job and aren't
    const grants = new Map(); // job id → [{ email, role }] for grantJobAccess
    const keep = new Set();
    for (const { k, rec, job, v } of want) {
      const rowKey = `${job.id} ${v.company}`;
      keep.add(rowKey);
      const lastLook = lookFor(seen, job.id, whoOf(v), v);
      if (staysOffJob(lastLook, access.get(job.id))) continue;
      const was = rows.get(rowKey);
      const people = v.partner ? contactsAll[v.partner] || [] : [];
      const base = {
        job_id: job.id, company: v.company, record: k, page: pageName(rec), name: v.name, partner: v.partner, account_id: v.account?.id || null,
        why: whyOf(v), first_seen: was?.first_seen || at, updated_at: at, person: was?.person || null,
      };
      const aces = access.get(job.id);
      // Someone a last look knew stays theirs when their email changes, so a second login isn't made
      const knownHere = lastLook?.people.some((p) => (aces?.nodes || []).some((n) => n?.membership?.id === p.id));
      if (knownHere || onJob(v, aces, { people, website: bySlug.get(v.partner)?.website, links })) {
        const next = { ...base, state: was?.state === 'added' ? 'added' : 'there', reason: null };
        if (!was || was.state !== next.state || was.why !== next.why || was.page !== next.page || was.name !== next.name) await putRow(DB, next);
        continue;
      }
      // Someone the site took off goes back when the logo does, even with no contact on file
      const person = personFor(v, people) || (lastLook?.took?.[0] ? { ...lastLook.took[0], name: lastLook.took[0].name || v.name } : null);
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
        if (g.state === 'added' && !g.internal && g.membership) {
          const stopped = await sawPutOn(DB, { job_id: job.id, who: whoOf(v), record: k, name: v.name, partner: v.partner, account_id: v.account?.id || null, logos: [], off: null }, { id: g.membership, email: person.email }, at);
          if (stopped) { await revokePeople(env, job.id, [{ id: g.membership, user: { emailAddress: person.email } }], at, fetchImpl); continue; }
        }
        const row = { ...base, state: g.state === 'there' ? 'there' : 'added', reason: null, person: { ...person, role: g.role || null, kept: !!g.kept, at } };
        await putRow(DB, row);
        if (row.state === 'added') {
          report.added.push({ job: job.id, page: base.page, name: v.name, person: person.name, role: g.role, kept: !!g.kept });
          if (!only) await logMakeover(DB, { record: k, at, action: 'added', side: v.why.has('page') ? 'website' : 'bill', name: v.name, people: [person.name] });
        }
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
        lastRun: { at, added: report.added.length, taken: report.taken?.length || 0, made: report.made.length, combined: report.combined.length, contacts: report.contacts.length, waiting: waitingNow, near: Object.keys(near).length, more: report.more,
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
 * jtOnly: [{ id, name, kind, jobs, asked? }] (JobTread's vendors that aren't partners, by name;
 * asked: { near: partner } or { twin: other account }, when a question above is about it),
 * takenOff: [{ at, how: 'page' | 'jobtread', name, page, record, people?, kept? }] (newest 30: a company
 * taken off a job), kept tells one that stayed off with no logo to move, watch: { on, list: [{ at, name, page, record }] }
 * (on false: logos a JobTread removal would take off are only noted, until staff turn it on), held: [{ name, page,
 * record, at }] (left a job in JobTread with too many others: waiting for someone to look),
 * roles (./_partner-roles.js rolesView) }
 */
export async function adminView(DB) {
  await ensureSchema(DB);
  const [rows, st, near, setAside, accountRows, partners, loose, twins, combined, roles, jtOnly, takenOff, watch, watched, held] = await Promise.all([
    DB.prepare('SELECT * FROM vendor_access ORDER BY updated_at DESC').all().then((r) => r.results || []),
    readKey(DB, 'state'), readKey(DB, 'near'), readKey(DB, 'set-aside'), readAccountRows(DB), readPartners(DB), readKey(DB, 'loose'),
    readKey(DB, 'twins'), readKey(DB, 'combined'), rolesView(DB).catch(() => null), readKey(DB, 'jt-only'), readKey(DB, 'taken-off'), readKey(DB, 'watch'), readKey(DB, 'watched'), readKey(DB, 'leaving-told'),
  ]);
  const asked = new Map();
  for (const n of Object.values(near)) for (const x of n.near || []) asked.set(x.id, { near: n.name });
  for (const t of Array.isArray(twins) ? twins : []) { asked.set(t.a.id, { twin: t.b.name }); asked.set(t.b.id, { twin: t.a.name }); }
  // Names and ids only: the contact snapshots stay here
  const nameOf = new Map(partners.map((p) => [p.slug, p.name]));
  const differs = (m) => (m.accountName.trim() !== m.name.trim() ? 1 : 0);
  const matched = [...accountRows.values()].filter((r) => nameOf.has(r.partner))
    .map((r) => ({ partner: r.partner, name: nameOf.get(r.partner), account: r.account_id, accountName: r.account_name || '', how: r.how || 'name' }))
    .sort((a, b) => differs(b) - differs(a) || a.name.localeCompare(b.name));
  const accountIds = new Set(matched.map((m) => m.account));
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
    takenOff: Array.isArray(takenOff.list) ? takenOff.list : [],
    watch: { on: !!watch.on, by: watch.by || null, at: watch.at || null, list: Object.values(watched) },
    held: Object.values(held).filter((h) => h.name),
    twins: Array.isArray(twins) ? twins : [],
    combined: Object.entries(combined).map(([key, c]) => ({ key, ...c, name: c.partner ? nameOf.get(c.partner) || null : null }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30),
    // A partner linked since the last run is left out now, not at the next one
    jtOnly: (Array.isArray(jtOnly) ? jtOnly : []).filter((v) => !accountIds.has(v.id))
      .map((v) => (asked.has(v.id) ? { ...v, asked: asked.get(v.id) } : v)).sort((a, b) => String(a.name).localeCompare(String(b.name))),
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
 * Staff: this JobTread vendor account (any, by its id) is this partner. The
 * partner's people, logos and roles go by it from now on. An empty account the
 * site had made for the partner is archived, kept in 'combined' so "Not the
 * same" brings it back. → { partner, name, account: { id, name }, archived: name | null }
 */
export async function linkAccount(env, { partner, account }, by = null, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  if (!key) throw new Error('JobTread isn’t connected');
  await ensureSchema(DB);
  const p = (await readPartners(DB)).find((x) => x.slug === partner);
  if (!p) throw new Error('That partner isn’t in Partners any more');
  const body = await pave(key, { account: { $: { id: account }, id: {}, name: {}, type: {}, archivedAt: {} } }, fetchImpl);
  const a = body?.account;
  if (!a?.id || a.type !== 'vendor') throw new Error('JobTread has no vendor by that id');
  if (a.archivedAt) throw new Error(`${a.name} is archived in JobTread`);
  const name = String(a.name || '').trim();
  const rows = await readAccountRows(DB);
  const taken = [...rows.values()].find((r) => r.account_id === a.id && r.partner !== partner);
  if (taken) throw new Error(`${name} is ${(await readPartners(DB)).find((x) => x.slug === taken.partner)?.name || taken.partner} in Partners already`);
  const was = rows.get(partner);
  if (was?.account_id === a.id) return { partner, name: p.name, account: { id: a.id, name }, archived: null, left: null };
  const at = iso(now);
  // The account the site made for it, empty: it goes, as one company twice would
  let archived = null;
  if (was?.how === 'made') {
    const holds = await accountHolds(key, [was.account_id], fetchImpl);
    const h = holds.get(was.account_id);
    if (h) {
      const { byJob, orders } = await billsByJob(DB);
      h.bills = [...orders, ...[...byJob.values()].flat()].includes(was.account_id) ? 1 : 0;
      h.logins = (await readMemberships(key, fetchImpl)).filter((m) => m.account?.id === was.account_id).length;
    }
    if (isEmptyAccount(h)) {
      await combineTwin(env, { keep: { id: a.id, name }, drop: { id: was.account_id, name: was.account_name || p.name }, partner, staff: h.staff || [] }, { fetchImpl, at, by, how: 'linked' });
      archived = was.account_name || p.name;
    }
  }
  if (!archived) await putAccountRow(DB, { partner, account_id: a.id, account_name: name, how: 'linked' });
  await setLink(DB, { company: nameKey(name), partner });
  // Staff's say settles any question about the partner, and outweighs an old "Not the same"
  const near = await readKey(DB, 'near');
  if (near[partner]) { delete near[partner]; await writeKey(DB, 'near', near); }
  const notSame = await readKey(DB, 'not-same');
  if (notSame[partner]?.[a.id]) {
    delete notSame[partner][a.id];
    if (!Object.keys(notSame[partner]).length) delete notSame[partner];
    await writeKey(DB, 'not-same', notSame);
  }
  // left: the partner's account before, which holds something, so it stays in JobTread
  return { partner, name: p.name, account: { id: a.id, name }, archived, left: was && !archived ? was.account_name || null : null };
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
  await combineTwin(env, { keep, drop, partner, staff: holds.get(drop.id)?.staff || [] }, { fetchImpl, at, by });
  await writeKey(DB, 'twins', list.filter((x) => x.key !== k));
  return { combined: { kept: keep.name, archived: drop.name, partner } };
}

/** Who's on a job, with each entry's id (to take one off) */
async function jobAces(grantKey, jobId, fetchImpl) {
  const out = [];
  let page = null;
  do {
    const body = await pave(grantKey, { job: { $: { id: jobId }, id: {}, aces: { $: { size: 50, ...(page ? { page } : {}) }, nextPage: {}, nodes: { id: {}, membership: { id: {}, user: { emailAddress: {} } } } } } }, fetchImpl);
    out.push(...(body?.job?.aces?.nodes || []).map((a) => ({ id: a.id, member: a.membership?.id, email: lower(a.membership?.user?.emailAddress) })));
    page = body?.job?.aces?.nextPage || null;
  } while (page);
  return out;
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

  // Nobody leaving here is a company being taken off a job: the next look starts afresh
  await DB.prepare('DELETE FROM vendor_job_seen WHERE partner = ? AND off IS NULL').bind(partner).run();
  // Off the jobs the site put them on through this match
  const added = ((await DB.prepare("SELECT * FROM vendor_access WHERE partner = ? AND state = 'added'").bind(partner).all()).results || [])
    .map((r) => ({ ...r, person: parse(r.person, {}) }));
  for (const r of added.filter((x) => theirs.has(lower(x.person?.email)))) {
    const ace = (await jobAces(key, r.job_id, fetchImpl)).find((a) => a.email === lower(r.person.email));
    await noteSiteRevoke(DB, r.job_id, r.person.email, iso(now));
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
