/**
 * Partner logos on kid pages follow JobTread (Peter, Oct 28 2026)
 * ===============================================================
 * Someone given access to a kid's job with a partner role (a Partners level,
 * or the old Vendor or Monetary Sponsor; never Trade Partner, a company SOARD
 * pays) worked on that room, so their company's logo goes on the kid's page
 * (or the community project's page) by itself:
 *   - the company is the JobTread login's account (the vendor or customer
 *     account the person belongs to), else the person's own name
 *   - its logo is the Partners directory's (same name, or a website on the
 *     person's email domain), else one already on another page under that
 *     name
 *   - a logo the page already shows (same image, upload folder or name) is
 *     left as it is, and one staff take off is never put back
 * When there's no logo anywhere, the staff in Partners → Waiting for a logo
 * (Linzi to start with) get one email per company per page: the company, the
 * person's name and email, their role, and the kid. Once a logo is in
 * Partners (or on any page under that name) the next check puts it on the
 * page and the row clears; "No logo needed" sets one aside. A company
 * JobTread names differently from Partners ("Randall Bros" for Randall
 * Brothers) is linked once in the admin ("Same as"), for every job after.
 *
 * Each page change is saved the way an admin save is, as "JobTread
 * (automatic)", and published under kid status's 10-minute cooldown
 * (./_kid-status.js), so nobody has to press Publish. JobTread has no webhook
 * for someone given access to a job, so open jobs are read every 10 minutes
 * from the live hub heartbeat; a save in Partners or on a page re-checks
 * what's waiting straight away.
 */
import { JT_URL, SOARD_ORG_ID, isProject } from './_reveals.js';
import { loadAllKids, loadAllProjects, linkJobs, keyOf, saveRecord, requestDeploy, SYNC_USER } from './_kid-status.js';
import { sendEmails, emailConfigured } from './_broadcast-notify.js';
import { cfId, kidUsage, nameKey, wordsKey, domainOf, nearPartners } from '../../public/admin/partners-shared.js';
import { isPartnerRole, TRADE_ROLE } from './_partner-roles.js';

/** JobTread roles whose company's logo belongs on the page: the partner roles but Trade Partner */
export const isLogoRole = (role) => isPartnerRole(role) && String(role).trim().toLowerCase() !== TRADE_ROLE.toLowerCase();
export const DEFAULT_EMAILS = ['linzi@soardcharity.com'];
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const MAX_PAGES = 8;
const SITE = 'https://sunshineonaranneyday.com';
const WAITING_URL = `${SITE}/admin/#partners?waiting`;
// A website on one of these isn't the company's own
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'comcast.net', 'att.net', 'bellsouth.net', 'verizon.net', 'sbcglobal.net', 'charter.net', 'cox.net', 'earthlink.net', 'protonmail.com', 'proton.me',
  'soardcharity.com']);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

const SCHEMA = [
  // One row per company per page. state: 'added' (the sync put the logo on), 'there'
  // (the page had it already), 'waiting' (no logo anywhere yet) or 'dismissed' (no logo needed)
  `CREATE TABLE IF NOT EXISTS kid_partner_logos (
    record TEXT NOT NULL, company TEXT NOT NULL, name TEXT, people TEXT, job_id TEXT,
    state TEXT NOT NULL, partner TEXT, logo TEXT, hint TEXT,
    first_seen TEXT, updated_at TEXT, emailed_at TEXT, by TEXT,
    PRIMARY KEY (record, company))`,
  'CREATE TABLE IF NOT EXISTS kid_partner_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // One check at a time: the heartbeat and the reveals feed can start one in the same second
  'CREATE TABLE IF NOT EXISTS kid_partner_lock (name TEXT PRIMARY KEY, until INTEGER NOT NULL)',
];
export async function ensureSchema(DB) {
  for (const sql of SCHEMA) await DB.prepare(sql).run();
}
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// A check that crashed frees the lock after this; a re-check after a save waits up to LOCK_TRIES × LOCK_RETRY_MS.
// 'sync' guards kid-record writes (this sweep and ./_sponsors.js adoption); ./_vendor-access.js has its own name.
const LOCK_MS = 2 * 60 * 1000;
const LOCK_TRIES = 10;
const LOCK_RETRY_MS = 1500;
export async function takeLock(DB, wait = false, name = 'sync') {
  for (let i = 0; i < (wait ? LOCK_TRIES : 1); i++) {
    if (i) await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    const t = Date.now();
    const ins = await DB.prepare('INSERT OR IGNORE INTO kid_partner_lock (name, until) VALUES (?, ?)').bind(name, t + LOCK_MS).run();
    if (ins?.meta?.changes > 0) return true;
    const upd = await DB.prepare('UPDATE kid_partner_lock SET until = ? WHERE name = ? AND until < ?').bind(t + LOCK_MS, name, t).run();
    if (upd?.meta?.changes > 0) return true;
  }
  return false;
}
export const freeLock = (DB, name = 'sync') => DB.prepare('DELETE FROM kid_partner_lock WHERE name = ?').bind(name).run().catch(() => {});
const lock = (DB, wait) => takeLock(DB, wait);
const unlock = (DB) => freeLock(DB);
/** The same company name: "Randall Brothers, Inc." for Randall Brothers, "Helen & Jimmy Carlos" for "Jimmy & Helen Carlos" */
const sameName = (a, b) => (nameKey(a) && nameKey(a) === nameKey(b)) || (!!wordsKey(a) && wordsKey(a) === wordsKey(b));

async function readState(DB) {
  const row = await DB.prepare("SELECT value FROM kid_partner_state WHERE key = 'state'").first();
  return parse(row?.value || '{}', {}) || {};
}
async function writeState(DB, patch) {
  const next = { ...(await readState(DB)), ...patch };
  await DB.prepare("INSERT OR REPLACE INTO kid_partner_state (key, value) VALUES ('state', ?)").bind(JSON.stringify(next)).run();
  return next;
}

/** Companies linked to a partner by hand: { [company name key]: partner slug } */
export async function readLinks(DB) {
  await ensureSchema(DB);
  const row = await DB.prepare("SELECT value FROM kid_partner_state WHERE key = 'links'").first();
  const v = parse(row?.value || '{}', {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
/** "Same as": this company is that partner, here and on every job after. partner null unlinks it. */
export async function setLink(DB, { company, partner }) {
  const links = await readLinks(DB);
  if (partner) {
    const p = await DB.prepare('SELECT slug FROM partners WHERE slug = ?').bind(partner).first();
    if (!p) throw new Error('That partner isn’t in Partners any more');
    links[company] = partner;
  } else delete links[company];
  await DB.prepare("INSERT OR REPLACE INTO kid_partner_state (key, value) VALUES ('links', ?)").bind(JSON.stringify(links)).run();
  return links;
}

/** Who's emailed when a logo is missing: { emails } (Linzi until the admin says otherwise) */
export async function readSettings(DB) {
  await ensureSchema(DB);
  const row = await DB.prepare("SELECT value FROM kid_partner_state WHERE key = 'settings'").first();
  const s = parse(row?.value || '{}', {}) || {};
  return { emails: Array.isArray(s.emails) ? s.emails.filter(isEmail) : DEFAULT_EMAILS, updatedBy: s.updatedBy || null, updatedAt: s.updatedAt || null };
}
export async function saveSettings(DB, { emails }, by = null, now = Date.now()) {
  await ensureSchema(DB);
  const list = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter((e) => !isEmail(e));
  if (bad.length) throw new Error(`${bad[0]} doesn’t look like an email address`);
  if (list.length > 10) throw new Error('Ten addresses at most');
  const value = { emails: list, updatedBy: by, updatedAt: new Date(now).toISOString() };
  await DB.prepare("INSERT OR REPLACE INTO kid_partner_state (key, value) VALUES ('settings', ?)").bind(JSON.stringify(value)).run();
  return value;
}

// ── JobTread: open jobs and who has access to them ──────────────────
// JobTread sizes a query by its worst case and refused 25 jobs × 20 people a
// page (./_job-ledger.js). So the open jobs come by name alone, then who has
// access only for the jobs with a page, three jobs a request, each the size
// the reveal invites read one job with. Three × 50 passes even the limit
// JobTread holds a request with no key to (four didn't, Oct 28 2026).
const ACCESS = { $: { size: 50 }, nodes: { membership: { isInternal: {}, role: { name: {} }, account: { id: {}, name: {} }, user: { name: {}, emailAddress: {} } } } };
const ACCESS_PER_REQUEST = 3;
async function pave(grantKey, query, fetchImpl) {
  const res = await fetchImpl(JT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { $: { grantKey }, ...query } }) });
  if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
  return res.json();
}
/** Every open SOARD job: [{ id, name, closedOn }] */
export async function fetchOpenJobs(grantKey, fetchImpl = fetch) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await pave(grantKey, { organization: { $: { id: SOARD_ORG_ID }, jobs: { $: { size: 100, where: ['closedOn', '=', null], ...(page ? { page } : {}) }, nextPage: {}, nodes: { id: {}, name: {}, closedOn: {} } } } }, fetchImpl);
    const conn = body?.organization?.jobs;
    if (!conn) throw new Error('JobTread response had no jobs');
    jobs.push(...(conn.nodes || []));
    page = conn.nextPage || null;
    if (!page) break;
  }
  return jobs;
}
/**
 * Who has access to each job: Map(job id → the job's aces). Throws if any
 * job can't be read, so a failed read never looks like everyone leaving.
 */
export async function fetchAccess(grantKey, ids, fetchImpl = fetch) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += ACCESS_PER_REQUEST) {
    const chunk = ids.slice(i, i + ACCESS_PER_REQUEST);
    const query = Object.fromEntries(chunk.map((id, j) => [`j${j}`, { _: 'job', $: { id }, id: {}, aces: ACCESS }]));
    const body = await pave(grantKey, query, fetchImpl);
    chunk.forEach((id, j) => {
      const aces = body?.[`j${j}`]?.aces;
      if (!aces) throw new Error(`JobTread sent no access list for job ${id}`);
      out.set(id, aces);
    });
  }
  return out;
}

/**
 * The companies a job's partner-role logins (isLogoRole) belong to:
 * [{ company (its name key), name, people: [{ name, email, role }] }]
 */
export function jobCompanies(job, who = new Map()) {
  const out = new Map();
  for (const a of job?.aces?.nodes || []) {
    const m = a?.membership;
    const role = m?.role?.name;
    if (!m || m.isInternal || !isLogoRole(role)) continue;
    const email = String(m.user?.emailAddress || '').trim().toLowerCase();
    // A login with no account (added by email) is a known contact's company when there is one
    const known = !m.account?.name ? who.get(email) : null;
    const name = String(m.account?.name || known?.name || m.user?.name || '').trim();
    const company = nameKey(name);
    if (!company) continue;
    const c = out.get(company) || { company, name, people: [], ...(known?.partner ? { partner: known.partner } : {}) };
    if (!c.people.some((p) => p.email === email && p.role === role)) c.people.push({ name: String(m.user?.name || '').trim() || null, email: isEmail(email) ? email : null, role });
    out.set(company, c);
  }
  return [...out.values()];
}

/**
 * The people the site knows the company of: email → { name, partner }, from
 * Partners contacts (./_sponsors.js) and the vendors ./_vendor-access.js put
 * on jobs. quiet: "job email" for someone put on a job for a bill alone,
 * whose logo doesn't go on the page by that.
 */
export async function knownPeople(DB, partners) {
  const who = new Map();
  const quiet = new Set();
  const names = new Map(partners.map((p) => [p.slug, p.name]));
  const all = async (sql) => { try { return (await DB.prepare(sql).all()).results || []; } catch { return []; } }; // no table until that feature's first run
  for (const r of await all('SELECT partner, people FROM partner_contacts')) {
    if (!names.has(r.partner)) continue;
    for (const p of parse(r.people, []) || []) if (isEmail(p?.email)) who.set(p.email, { name: names.get(r.partner), partner: r.partner });
  }
  for (const r of await all("SELECT job_id, name, partner, why, person FROM vendor_access WHERE state = 'added'")) {
    const email = parse(r.person, {})?.email;
    if (!isEmail(email)) continue;
    if (!who.has(email)) who.set(email, { name: (r.partner && names.get(r.partner)) || r.name, partner: r.partner && names.has(r.partner) ? r.partner : null });
    if (r.why === 'bill') quiet.add(`${r.job_id} ${email}`);
  }
  return { who, quiet };
}

// ── Finding a company's logo ─────────────────────────────────────────
const domainOfEmail = (e) => String(e || '').split('@')[1]?.toLowerCase() || '';
const sameSite = (mail, web) => !!mail && !!web && (mail === web || mail.endsWith(`.${web}`) || web.endsWith(`.${mail}`));

/**
 * What the sweep looks logos up in: the directory, and every named logo on
 * any page (kids and community projects, drafts too) by name key, the one
 * on the most pages first
 */
export function logoIndex(partners, records, links = {}) {
  const named = new Map();
  for (const r of records) {
    for (const l of r.data?.partnerLogos || []) {
      const key = wordsKey(l?.name);
      if (!key || !l.url || /^blob:/.test(l.url)) continue;
      const byUrl = named.get(key) || new Map();
      const hit = byUrl.get(cfId(l.url)) || { url: l.url, name: String(l.name).trim(), n: 0 };
      hit.n++;
      byUrl.set(cfId(l.url), hit);
      named.set(key, byUrl);
    }
  }
  const pages = new Map([...named].map(([k, byUrl]) => [k, [...byUrl.values()].sort((a, b) => b.n - a.n)[0]]));
  return { partners: partners || [], pages, links: links || {} };
}

/**
 * A company's logo: { url, name, partner, how } or null, plus a hint for the
 * email when there's none ('Partners has X without a logo', 'maybe X').
 */
export function findLogo(c, index) {
  const { partners, pages, links = {} } = index;
  const withLogo = (list) => list.filter((p) => p.logo).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  // Linked by hand in the admin wins over any guess; then the partner whose contact this is
  const slug = links[c.company] || c.partner;
  const linked = slug && partners.find((p) => p.slug === slug);
  if (linked) return linked.logo ? { logo: { url: linked.logo, name: linked.name, partner: linked.slug, how: 'linked' } } : { logo: null, hint: `Linked to ${linked.name}, who has no logo in Partners yet` };
  const byName = partners.filter((p) => nameKey(p.slug) === c.company || sameName(p.name, c.name));
  const named = withLogo(byName);
  if (named.length) return { logo: { url: named[0].logo, name: named[0].name, partner: named[0].slug, how: 'name' } };
  const domains = [...new Set(c.people.map((p) => domainOfEmail(p.email)).filter((d) => d && !FREE_MAIL.has(d)))];
  const bySite = withLogo(partners.filter((p) => p.website && domains.some((d) => sameSite(d, domainOf(p.website)))));
  if (bySite.length === 1) return { logo: { url: bySite[0].logo, name: bySite[0].name, partner: bySite[0].slug, how: 'website' } };
  const onPages = pages.get(wordsKey(c.name));
  if (onPages) return { logo: { url: onPages.url, name: onPages.name, partner: null, how: 'page' } };
  if (byName.length) return { logo: null, hint: `${byName[0].name} is in Partners without a logo` };
  const near = nearPartners(c.name, partners, { min: 0.6, max: 1 })[0];
  return { logo: null, hint: near ? `Partners has ${near.partner.name}${near.partner.logo ? '' : ' (no logo yet)'}: the same company?` : null };
}

/** Whether a page already shows a company's logo: the same image, a logo uploaded for that partner, or one under its name */
export function pageHas(record, c, logo, partners) {
  const logos = record.partnerLogos || [];
  if (logos.some((l) => nameKey(l?.name) === c.company || sameName(l?.name, c.name))) return true;
  if (!logo) return false;
  if (logos.some((l) => l?.url && cfId(l.url) === cfId(logo.url))) return true;
  if (logo.partner) return !!kidUsage([{ ...record, slug: '_', publishStatus: 'published' }], partners).byPartner.get(logo.partner)?.length;
  return false;
}

// ── The email ────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pageOf = (rec) => (isProject(rec) ? `the ${rec.name} page` : `${rec.name}’s page`);
const editorOf = (rec) => `${SITE}/admin/#kids/${isProject(rec) ? 'community/' : ''}${encodeURIComponent(rec.slug)}`;
const listOf = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/**
 * The email for logos nobody has yet. items: [{ rec, c, jobId, hint }], one
 * per company per page; the email has one block per company (one logo
 * covers every page it's on), with its role, the people's names and emails,
 * and each page with its job.
 */
export function missingLogoEmail(items) {
  const groups = new Map();
  for (const it of items) {
    const g = groups.get(it.c.company) || { c: { ...it.c, people: [] }, pages: [], hint: it.hint || null };
    for (const p of it.c.people) if (!g.c.people.some((x) => x.email === p.email && x.name === p.name && x.role === p.role)) g.c.people.push(p);
    if (!g.pages.some((x) => x.rec.slug === it.rec.slug && isProject(x.rec) === isProject(it.rec))) g.pages.push({ rec: it.rec, jobId: it.jobId });
    g.hint ||= it.hint || null;
    groups.set(it.c.company, g);
  }
  const list = [...groups.values()];
  const one = list.length === 1 ? list[0] : null;
  const roles = (g) => listOf([...new Set(g.c.people.map((p) => p.role))]).toLowerCase();
  const subject = !one ? `[SOARD] ${list.length} logos needed for ${items.every((i) => !isProject(i.rec)) ? 'kid pages' : 'pages'}`
    : one.pages.length === 1 ? `[SOARD] Logo needed: ${one.c.name} on ${pageOf(one.pages[0].rec)}` : `[SOARD] Logo needed: ${one.c.name}, for ${one.pages.length} pages`;
  const lead = !one ? `These companies are on jobs in JobTread as vendors or sponsors, and the site has no logo for them yet. One logo covers every page each one is on.`
    : one.pages.length === 1 ? `${one.c.name} is on ${one.pages[0].rec.name}’s job in JobTread as a ${roles(one)}, and the site has no logo for them yet.`
    : `${one.c.name} is on ${one.pages.length} jobs in JobTread as a ${roles(one)}, and the site has no logo for them yet. One logo covers every page.`;
  const fix = 'Get their logo and add it in Admin → Partners. The site then puts it on the page and publishes it by itself, and on any page they work on after this. If they’re in Partners under another name, or don’t need a logo, open the list below and choose “Same as” or “No logo needed”.';
  const titleOf = (rec) => `${rec.name}${rec.data?.year ? ` (${rec.data.year})` : ''}`;
  const jobUrl = (id) => `https://app.jobtread.com/jobs/${encodeURIComponent(id || '')}`;
  const blocks = list.map(({ c, pages, hint }) => {
    const label = pages.length === 1 ? 'Page' : 'Pages';
    const rows = [
      ['Company', esc(c.name)],
      ...c.people.flatMap((p) => [['Name', esc(p.name || 'No name in JobTread')], ['Email', p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : 'No email in JobTread'], ['Role', esc(p.role)]]),
      [label, pages.map(({ rec, jobId }) => `<a href="${editorOf(rec)}">${esc(titleOf(rec))}</a> (<a href="${jobUrl(jobId)}">job</a>)`).join('<br>')],
      ...(hint ? [['Note', esc(hint)]] : []),
    ];
    const text = [
      `Company: ${c.name}`,
      ...c.people.flatMap((p) => [`Name: ${p.name || 'No name in JobTread'}`, `Email: ${p.email || 'No email in JobTread'}`, `Role: ${p.role}`]),
      ...pages.map(({ rec, jobId }, i) => `${i ? ' '.repeat(label.length + 1) : `${label}:`} ${titleOf(rec)} ${editorOf(rec)} (job: ${jobUrl(jobId)})`),
      ...(hint ? [`Note: ${hint}`] : []),
    ].join('\n');
    const html = `<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">${rows.map(([k, v]) => `<tr><td style="color:#666;padding-right:12px;vertical-align:top">${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    return { html, text };
  });
  return {
    subject,
    html: `<p>${esc(lead)}</p>${blocks.map((b) => b.html).join('')}<p>${esc(fix)}</p><p><a href="${WAITING_URL}">Open the list of logos still needed</a></p>`,
    text: `${lead}\n\n${blocks.map((b) => b.text).join('\n\n')}\n\n${fix}\n\nLogos still needed: ${WAITING_URL}`,
  };
}

// ── The sweep ────────────────────────────────────────────────────────
const rowKey = (record, company) => `${record}\u0000${company}`;
async function readRows(DB) {
  const rows = (await DB.prepare('SELECT * FROM kid_partner_logos').all()).results || [];
  return new Map(rows.map((r) => [rowKey(r.record, r.company), { ...r, people: parse(r.people || '[]', []) || [] }]));
}
async function putRow(DB, r) {
  await DB.prepare(`INSERT OR REPLACE INTO kid_partner_logos (record, company, name, people, job_id, state, partner, logo, hint, first_seen, updated_at, emailed_at, by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.record, r.company, r.name || null, JSON.stringify(r.people || []), r.job_id || null, r.state, r.partner || null, r.logo || null, r.hint || null,
      r.first_seen, r.updated_at, r.emailed_at || null, r.by || null).run();
}

/**
 * Put partners' logos on their pages. Reads JobTread's open jobs
 * (or, with fromJobTread false, only re-checks what's waiting, after a
 * Partners or page save). Returns [{ record, name, added: [names], waiting: [names] }].
 * Never throws.
 */
export async function syncKidPartners(env, { fetchImpl = fetch, now = Date.now(), fromJobTread = true } = {}) {
  const iso = new Date(now).toISOString();
  let locked = false;
  try {
    if (!env.DB || (fromJobTread && !env.JOBTREAD_GRANT_KEY)) return [];
    await ensureSchema(env.DB);
    // Another check is running: the sweep leaves it to that one; a re-check after a save waits its turn
    if (!(await lock(env.DB, !fromJobTread))) return [];
    locked = true;
    const [jobs, kids, projects, partnerRows, rows, links] = await Promise.all([
      fromJobTread ? fetchOpenJobs(env.JOBTREAD_GRANT_KEY, fetchImpl) : null,
      loadAllKids(env.DB), loadAllProjects(env.DB),
      env.DB.prepare('SELECT slug, data FROM partners').all().then((r) => r.results || []),
      readRows(env.DB), readLinks(env.DB),
    ]);
    const records = [...kids, ...projects];
    const byKey = new Map(records.map((r) => [keyOf(r), r]));
    const partners = partnerRows.map((r) => ({ slug: r.slug, ...(parse(r.data || '{}', {}) || {}) }));
    const index = logoIndex(partners, records, links);
    const { who, quiet } = fromJobTread ? await knownPeople(env.DB, partners) : { who: new Map(), quiet: new Set() };

    // What each page's job says now, or (re-checking) what was waiting
    const work = new Map(); // record key → { rec, jobId, companies }
    if (fromJobTread) {
      const links = [...linkJobs(jobs, records)].filter(([key]) => byKey.has(key));
      const access = await fetchAccess(env.JOBTREAD_GRANT_KEY, [...new Set(links.map(([, job]) => job.id))], fetchImpl);
      for (const [key, job] of links) {
        // Someone on the job for a bill alone (./_vendor-access.js) doesn't bring a logo with them
        const companies = jobCompanies({ aces: access.get(job.id) }, who).filter((c) => !c.people.every((p) => p.email && quiet.has(`${job.id} ${p.email}`)));
        work.set(key, { rec: byKey.get(key), jobId: job.id, companies, seen: true });
      }
    } else {
      for (const r of rows.values()) {
        if (r.state !== 'waiting' || !byKey.has(r.record)) continue;
        const w = work.get(r.record) || { rec: byKey.get(r.record), jobId: r.job_id, companies: [] };
        w.companies.push({ company: r.company, name: r.name, people: r.people });
        work.set(r.record, w);
      }
    }

    const out = [];
    const toEmail = [];
    for (const [key, w] of work) {
      const added = [];
      const waiting = [];
      const logos = [];
      for (const c of w.companies) {
        const was = rows.get(rowKey(key, c.company));
        // Done with: on the page by us or by staff, or set aside. One taken off stays off.
        if (was && was.state !== 'waiting') {
          if (JSON.stringify(was.people) !== JSON.stringify(c.people) && fromJobTread) await putRow(env.DB, { ...was, people: c.people, updated_at: iso });
          continue;
        }
        const { logo, hint } = findLogo(c, index);
        const base = { record: key, company: c.company, name: c.name, people: c.people, job_id: w.jobId, first_seen: was?.first_seen || iso, updated_at: iso, emailed_at: was?.emailed_at || null };
        if (pageHas(w.rec.data, c, logo, partners)) {
          await putRow(env.DB, { ...base, state: 'there', partner: logo?.partner, logo: logo?.url });
        } else if (logo) {
          logos.push({ c, logo, url: logo.url, name: logo.name || c.name, row: { ...base, state: 'added', partner: logo.partner, logo: logo.url } });
        } else {
          const row = { ...base, state: 'waiting', hint };
          // Still waiting, nothing new to say: no write every 10 minutes
          const same = was && was.name === c.name && (was.hint || null) === (hint || null) && JSON.stringify(was.people) === JSON.stringify(c.people) && was.job_id === w.jobId;
          if (!same) await putRow(env.DB, row);
          else row.updated_at = was.updated_at;
          waiting.push(c.name);
          if (!row.emailed_at) toEmail.push({ rec: w.rec, c, jobId: w.jobId, hint, row });
        }
      }
      // Gone from the job before anyone found a logo: nothing to wait for
      if (w.seen) {
        for (const r of rows.values()) {
          if (r.record === key && r.state === 'waiting' && !w.companies.some((c) => c.company === r.company)) {
            await env.DB.prepare('DELETE FROM kid_partner_logos WHERE record = ? AND company = ?').bind(r.record, r.company).run();
          }
        }
      }
      if (logos.length) {
        // Read again right before saving, so an edit made meanwhile is kept and nothing goes on twice
        const fresh = (isProject(w.rec) ? await loadAllProjects(env.DB) : await loadAllKids(env.DB)).find((r) => r.slug === w.rec.slug);
        if (fresh) {
          const before = fresh.data;
          // Two companies can share one logo (a partner under two account names): it goes on once
          const adding = [];
          for (const l of logos) if (!pageHas(before, l.c, l.logo, partners) && !adding.some((x) => cfId(x.url) === cfId(l.url))) adding.push(l);
          if (adding.length) {
            const after = { ...before, partnerLogos: [...(before.partnerLogos || []), ...adding.map((l) => ({ url: l.url, name: l.name }))] };
            const names = adding.map((l) => l.name);
            await saveRecord(env, isProject(w.rec) ? 'community' : 'kids', w.rec.slug, before, after, `Partner logos from JobTread: ${w.rec.name} + ${names.join(', ')}`, iso);
            added.push(...names);
          }
          for (const l of logos) await putRow(env.DB, adding.includes(l) ? l.row : { ...l.row, state: 'there' });
        }
      }
      if (added.length || waiting.length) out.push({ record: key, name: w.rec.name, added, waiting });
    }

    // One email for every logo nobody has yet; a failed send is tried again next time
    const patch = { lastRun: { at: iso, scope: fromJobTread ? 'all' : 'waiting', added: out.reduce((n, o) => n + o.added.length, 0), waiting: new Set([...(await readRows(env.DB)).values()].filter((r) => r.state === 'waiting').map((r) => r.company)).size } };
    if (toEmail.length) {
      const { emails } = await readSettings(env.DB);
      if (emails.length && emailConfigured(env)) {
        const mail = missingLogoEmail(toEmail);
        const sent = await sendEmails(env, { to: emails, ...mail, tags: [{ name: 'category', value: 'partner-logo' }] });
        if (sent.sent) for (const t of toEmail) await putRow(env.DB, { ...t.row, emailed_at: iso });
        else patch.lastEmailError = { at: iso, error: String(sent.errors[0] || 'not sent').slice(0, 200) };
      }
    }
    if (out.some((o) => o.added.length)) {
      const d = await requestDeploy(env, now, 'Partner logos from JobTread');
      patch.lastDeploy = { at: iso, deployed: d.deployed, pending: d.pending };
    }
    if (fromJobTread) { patch.lastSweepAt = iso; patch.lastError = null; }
    await writeState(env.DB, patch);
    return out;
  } catch (err) {
    console.error('[kid-partners]', err.message);
    // Kept so Site → Automations can say the last check failed
    try { await writeState(env.DB, { lastError: { at: iso, scope: fromJobTread ? 'all' : 'waiting', error: String(err.message || err).slice(0, 200) } }); } catch { /* nothing more to do */ }
    return [];
  } finally {
    if (locked) await unlock(env.DB);
  }
}

/** Every 10 minutes from the heartbeat. Never throws. */
export async function maybeSyncKidPartners(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureSchema(env.DB);
    const state = await readState(env.DB);
    if (now - Date.parse(state.lastSweepAt || 0) < SWEEP_EVERY_MS) return null;
    // Claim the slot first so overlapping heartbeats don't double up
    await writeState(env.DB, { lastSweepAt: new Date(now).toISOString() });
    return await syncKidPartners(env, { fetchImpl, now });
  } catch {
    return null;
  }
}

/** After a save in Partners or on a page: anything waiting whose logo is in now goes on. Never throws. */
export async function recheckWaiting(env, opts = {}) {
  try {
    if (!env.DB) return [];
    await ensureSchema(env.DB);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM kid_partner_logos WHERE state = 'waiting'").first();
    return n?.n ? await syncKidPartners(env, { ...opts, fromJobTread: false }) : [];
  } catch {
    return [];
  }
}

// ── The admin (Partners → Waiting for a logo) ───────────────────────
/** { waiting, dismissed, added, settings, lastRun, lastError } for the admin */
export async function adminView(DB) {
  await ensureSchema(DB);
  const [rows, kids, projects, settings, state, links] = await Promise.all([readRows(DB), loadAllKids(DB), loadAllProjects(DB), readSettings(DB), readState(DB), readLinks(DB)]);
  const byKey = new Map([...kids, ...projects].map((r) => [keyOf(r), r]));
  const view = (r) => {
    const rec = byKey.get(r.record);
    return {
      record: r.record, company: r.company, name: r.name, people: r.people, jobId: r.job_id, hint: r.hint, logo: r.logo, partner: r.partner,
      page: rec ? { slug: rec.slug, name: rec.name, year: rec.data?.year ?? rec.year ?? null, kind: isProject(rec) ? 'community' : 'kid', draft: rec.data?.publishStatus === 'draft' } : null,
      since: r.first_seen, updatedAt: r.updated_at, emailedAt: r.emailed_at, by: r.by,
    };
  };
  const all = [...rows.values()].filter((r) => byKey.has(r.record));
  const newest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  return {
    waiting: all.filter((r) => r.state === 'waiting').map(view).sort((a, b) => String(a.since).localeCompare(String(b.since))),
    dismissed: all.filter((r) => r.state === 'dismissed').map(view).sort(newest),
    added: all.filter((r) => r.state === 'added').map(view).sort(newest).slice(0, 30),
    // Each linked company once, by the name JobTread gave it
    links: Object.entries(links).map(([company, partner]) => ({ company, partner, name: [...rows.values()].find((r) => r.company === company)?.name || company })),
    settings,
    lastSweepAt: state.lastSweepAt || null, lastRun: state.lastRun || null, lastError: state.lastError || null, lastEmailError: state.lastEmailError || null,
  };
}

/**
 * "No logo needed" (dismiss true) or back to waiting (false), for one page
 * (record) or, without one, every page the company is on. Returns the new
 * state, or null when nothing was in the state to move from.
 */
export async function setAside(DB, { record = null, company, dismiss }, by = null, now = Date.now()) {
  await ensureSchema(DB);
  const from = dismiss ? 'waiting' : 'dismissed';
  const to = dismiss ? 'dismissed' : 'waiting';
  const where = record ? 'record = ? AND company = ?' : 'company = ?';
  const keys = record ? [record, company] : [company];
  const r = await DB.prepare(`UPDATE kid_partner_logos SET state = ?, by = ?, updated_at = ? WHERE ${where} AND state = ?`).bind(to, by, new Date(now).toISOString(), ...keys, from).run();
  if (r?.meta?.changes > 0) return to;
  const there = await DB.prepare(`SELECT state FROM kid_partner_logos WHERE ${where} LIMIT 1`).bind(...keys).first();
  return there ? there.state : null;
}

export { SYNC_USER };
