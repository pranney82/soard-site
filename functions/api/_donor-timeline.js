/**
 * A donor's timeline: everything that happened with a person or an organization, newest first
 * ===========================================================================
 * Peter, Nov 12 2026: "similar to what i built in crm for datax, can you build in donors and partners admin a timeline
 * of emails, donations, etc?" (DataX's customer Activity: one timeline from every source, read from the system that
 * owns each fact, nothing copied). Everyone on the team sees it (Peter: "everyone"), and it takes the place of a donor
 * page's Gifts, Notes and History.
 *
 * The page itself already carries the gifts (with each one's thank-you) and the notes (./_donor-crm.js personView /
 * orgView). This reads the rest, live, each source on its own so one that can't be read never hides the others:
 *   - Email with the team: every active SOARD Google mailbox (the staff mail reader's delegation, gmail.readonly),
 *     searched for the donor's addresses (an organization's website domain too). Headers only; an email's words are
 *     read from Gmail when someone opens it, and that opening is logged (audit_log 'mailbox', as the mail reader does).
 *   - Meetings: the same people's Google Calendars, events the donor is a guest on (or organizes).
 *   - Calls and texts: Quo, by the phone numbers Zeffy has for the donor's contacts (QUO_API_KEY; until it is set the
 *     timeline says Quo isn't connected).
 *   - Newsletters: Kit (on the list since, left, its tags, the emails sent to the whole list, or to a tag they had,
 *     while they were on it, and how many of the year's they opened).
 *   - Emails the site sent them (email_log, the Resend ledger, 180 days).
 *   - The team's changes (audit_log: owner, organizations, Keep anonymous, thank-yous; a note shows as itself).
 *   - An organization on the website: its partner page's changes (content_versions) and the makeovers that credit it.
 *
 * Never read: anyone on the team. An address on a SOARD domain, any SOARD Google account's address or alias, and a
 * donor with a team member's name are never searched (a staff member who gives is a donor, and their mail is theirs).
 * Of the donor's own mail, their newsletters and mass mailings (a list header, more than 10 recipients) and
 * auto-replies are left out. Freemail domains are never matched as a domain: only exact addresses.
 */
import { loadCrm } from './_donor-crm.js';
import { rowsFor, allRows, keyOfRef, isOrgKey } from './_donors.js';
import { accessToken, GMAIL_READ_SCOPE, CALENDAR_SCOPE } from './_google-calendar.js';
import { mailboxes, orgDomains, header, textOf, filesOf, gmail } from './_mailbox.js';
import { kitConfigured, kitFetch, REVEAL_TAG, REVEAL_ONLY_TAG } from './_kit.js';
import { zeffyGet, zeffyQuota, givenName } from './_zeffy.js';
import { entryFor, audienceOf } from './_email-log.js';
import { changedFields } from './_content-history.js';
import { FREE_MAIL } from './_kid-partners.js';
import { logAudit } from './_audit.js';
import { normEmail } from './_board-roles.js';
import { readContacts } from './_sponsors.js';

const MIN = 60e3;
const DAY = 864e5;
const GMAIL_BATCH = 'https://gmail.googleapis.com/batch/gmail/v1';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const QUO_API = 'https://api.quo.com';
const QUO_VERSION = '2026-03-30';
// Conversations read from each mailbox a time (newest first; "Show older" reads the next ones)
export const MAIL_PAGE = 20;
// Conversations asked of Gmail in one batch
const BATCH = 10;
// Pages a mailbox reads on to when the first brings fewer than MAIL_ENOUGH of their emails
const MAIL_PAGES = 3;
const MAIL_ENOUGH = 3;
// Addresses a search asks for at once (a person has a few; an organization's givers can be many)
const MAX_ADDRESSES = 12;
// Calendar searches are by one address each: the first few of them
const MAX_CAL_ADDRESSES = 3;
const CAL_BACK_MS = 3 * 365 * DAY;
const CAL_AHEAD_MS = 365 * DAY;
const CAL_PAGES = 4;
// Zeffy contacts read for their phone numbers (an organization's first few givers)
const MAX_PHONE_CONTACTS = 5;
// Zeffy requests left in the minute below which the phone numbers wait for another time (Checks and the donor list come first)
const ZEFFY_KEEP = 40;
// More recipients than this on an email the donor sent: a mass mailing of theirs, not a conversation
const CROWD = 10;
// A Worker holds six connections at a time: everything here takes its turn through one queue
const AT_ONCE = 6;
const KIT_SENDS_MS = 10 * MIN;
const QUO_PEOPLE_MS = 10 * MIN;
const MAX_TEXT = 1000;
const TEAM_ROWS = 300;
const SITE_ROWS = 200;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fail = (status, message) => Object.assign(new Error(message), { status });
const iso = (ms) => new Date(ms).toISOString();
const EMAIL = /^[^\s@"(){}<>,;:]+@[^\s@"(){}<>,;:]+\.[^\s@"(){}<>,;:]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const BARE = /[^\s<>"',;:()]+@[^\s<>"',;:()]+\.[a-z]{2,}/i;
/**
 * Every address in a header (From, To, Cc, Bcc), lower-cased, one an entry: the address in <brackets> when there is
 * one, never an address in the display name ("jane@x.com via Forms" <noreply@forms.example> is noreply@forms.example)
 */
export function addressesIn(value) {
  const out = [];
  let angle = '';
  let rest = '';
  let quoted = false;
  let inAngle = false;
  let escaped = false;
  const take = () => {
    const a = (angle && BARE.exec(angle)?.[0]) || BARE.exec(rest)?.[0];
    if (a) out.push(a.toLowerCase());
    angle = '';
    rest = '';
  };
  for (const ch of String(value || '')) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quoted) { escaped = true; continue; }
    if (ch === '"' && !inAngle) { quoted = !quoted; continue; }
    if (quoted) continue; // a display name: never an address
    if (ch === '<') { inAngle = true; continue; }
    if (ch === '>') { inAngle = false; continue; }
    if (inAngle) { angle += ch; continue; }
    if (ch === ',' || ch === ';') { take(); continue; }
    rest += ch;
  }
  take();
  return out;
}

/** The name in a From header ("Jane Doe <jane@x.com>" → Jane Doe), else its address */
export const nameIn = (value) => { const v = String(value || ''); const n = clean(v.replace(/<[^>]*>/, '').replace(/^"|"$/g, '').replace(/"/g, '')); return n && !n.includes('@') ? n : addressesIn(v)[0] || ''; };
const domainOf = (email) => normEmail(email).split('@')[1] || '';
/** A website's domain (https://www.acme.com/about → acme.com), or '' */
export function siteDomain(url) {
  try { const h = new URL(/^https?:\/\//i.test(String(url || '')) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ''); return DOMAIN.test(h) ? h : ''; } catch { return ''; }
}
/** A phone number as Quo spells it (+15555550123), or null */
export function e164(raw) {
  // An extension ("x123", "ext. 4") is dialled after the call connects: the number is what comes before it
  const s = String(raw || '').trim().replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, '');
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return null;
}

/** One queue for every outside read in a request: at most AT_ONCE at a time */
export function queue(n = AT_ONCE) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++;
    const { fn, res, rej } = waiting.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { waiting.push({ fn, res, rej }); next(); });
}

// ─── Who the donor is, and what may be searched for them ─────────────

/** Google's accounts as the staff sign-in check last read them: every one, active or not, with its aliases */
export async function staffDirectory(DB) { return directory(DB); }
async function directory(DB) {
  try {
    const row = await DB.prepare("SELECT data FROM staff_state WHERE key = 'directory'").first();
    return row ? JSON.parse(row.data)?.accounts || [] : [];
  } catch { return []; }
}

/** The team, as the timeline needs it: every address that is theirs, their names, and SOARD's own domains */
export function teamOf(accounts) {
  const addresses = new Map();
  for (const a of accounts || []) {
    const name = clean(a.name) || normEmail(a.email).split('@')[0];
    for (const e of [a.email, ...(a.aliases || [])]) if (e) addresses.set(normEmail(e), { email: normEmail(a.email), name });
  }
  const names = new Set((accounts || []).map((a) => clean(a.name).toLowerCase()).filter((n) => n.split(' ').length >= 2));
  return { addresses, names, domains: orgDomains(accounts) };
}

/**
 * What the timeline searches for: a person's addresses, or an organization's (its givers' and its website's domain),
 * less the team's. → { emails, domains, skipped: [{ address, why }], team: true when the donor is on the team }
 */
export function searchable({ emails = [], domains = [], name = '', people = [], contacts = [], phones = [] }, team) {
  const skipped = [];
  const isTeamName = (n) => !!n && team.names.has(clean(n).toLowerCase());
  if (isTeamName(name)) return { emails: [], domains: [], contacts: [], phones: [], skipped, dropped: [], team: true };
  // An organization's givers: a teammate among them (giving for it from home) is never searched, by email or phone
  const theirs = people.filter((p) => isTeamName(p.name));
  const dropEmails = new Set(theirs.flatMap((p) => p.emails || []).map(normEmail));
  const dropContacts = new Set(theirs.flatMap((p) => p.contacts || []).map(String));
  const dropPhones = new Set(theirs.flatMap((p) => p.phones || []));
  const ok = [];
  for (const raw of new Set(emails.map(normEmail).filter(Boolean))) {
    if (!EMAIL.test(raw)) continue;
    if (dropEmails.has(raw) || team.addresses.has(raw) || team.domains.has(domainOf(raw))) { skipped.push({ address: raw, why: 'team' }); continue; }
    ok.push(raw);
  }
  const kept = ok.slice(0, MAX_ADDRESSES);
  // A website's domain is searched only when the organization's own people write from it (a website set to a Facebook
  // page or a big store's site never brings in everyone at that domain), and never a mail service's or SOARD's
  const doms = [...new Set(domains.map((d) => String(d || '').toLowerCase()))]
    .filter((d) => DOMAIN.test(d) && !FREE_MAIL.has(d) && !PLATFORMS.has(d) && !team.domains.has(d) && ok.some((e) => domainOf(e) === d));
  return {
    emails: kept, domains: doms.slice(0, 2), contacts: contacts.map(String).filter((c) => !dropContacts.has(c)),
    phones: [...new Set(phones.filter((x) => x && !dropPhones.has(x)))], skipped, dropped: skipped.map((x) => x.address), team: false,
  };
}
// Websites that are someone else's (a social page, a map, a link shortener, a site builder): never an organization's domain
const PLATFORMS = new Set(['google.com', 'goo.gl', 'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'yelp.com',
  'bit.ly', 'linktr.ee', 'wix.com', 'wixsite.com', 'squarespace.com', 'godaddysites.com', 'weebly.com', 'wordpress.com', 'square.site', 'business.site', 'zeffy.com', 'apple.com', 'microsoft.com', 'amazon.com']);
// An automated sender: matched by the organization's domain alone, its mail is a store's or a service's, not a person's
// (a person writing from billing@ or orders@ about a sponsorship or a kid's order is a conversation, so those stay)
const AUTO_SENDER = /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|receipts?|order-?updates?|shipping-?updates?)\b/i;

const personName = (r) => givenName({ first_name: r.first, last_name: r.last }) || clean(r.company) || r.email || 'No name';

/**
 * The donor a timeline is for, from a page's address (a Zeffy contact id, g:<payment>, or an organization's p:/o: key)
 * → { kind: 'person' | 'org', key, keys (their records, for the team's changes), name, emails, contacts, domains,
 *     slug (a partner's), people: [{ name, emails }] (an organization's givers) } | null
 */
export async function subjectOf(env, ref, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  let key = String(ref || '');
  if (!isOrgKey(key)) {
    const raw = await keyOfRef(env, key);
    if (!raw) return null;
    key = crm.canon(raw);
  }
  if (isOrgKey(key)) {
    if (!crm.isOrg(key)) return null;
    const rows = await allRows(env.DB);
    const place = crm.placer(rows);
    const mine = rows.filter((r) => place(r).owner === key);
    const facts = crm.orgFacts(key);
    const people = new Map();
    for (const r of mine) {
      const p = place(r).person;
      const x = people.get(p) || { name: personName(r), emails: new Set(), contacts: new Set(), cents: 0 };
      if (r.email) x.emails.add(normEmail(r.email));
      if (r.contact) x.contacts.add(String(r.contact));
      x.cents += Number(r.giving) || 0;
      people.set(p, x);
    }
    // A partner's own people first (Partners keeps a sponsor's contacts: name, email, phone), then the biggest givers:
    // their addresses and numbers are the ones searched when there are many
    const own = facts.slug ? ((await readContacts(env.DB, [facts.slug]).catch(() => ({})))[facts.slug] || []) : [];
    const list = [
      ...own.map((p) => ({ name: clean(p.name), emails: new Set(p.email ? [normEmail(p.email)] : []), contacts: new Set(), phones: [e164(p.phone)].filter(Boolean) })),
      ...[...people.values()].sort((a, b) => b.cents - a.cents),
    ];
    let domains = [];
    if (facts.slug) {
      const row = await env.DB.prepare('SELECT data FROM partners WHERE slug = ?').bind(facts.slug).first().catch(() => null);
      try { const d = siteDomain(JSON.parse(row?.data || '{}').website); if (d) domains = [d]; } catch { /* no website */ }
    }
    return {
      kind: 'org', key, keys: [key], name: facts.name, slug: facts.slug || null, domains,
      emails: list.flatMap((p) => [...p.emails]), contacts: list.flatMap((p) => [...p.contacts]), phones: list.flatMap((p) => p.phones || []),
      people: list.map((p) => ({ name: p.name, emails: [...p.emails], contacts: [...p.contacts], phones: p.phones || [] })),
    };
  }
  const keys = crm.keysOf(key);
  const rows = await rowsFor(env.DB, keys);
  const place = crm.placer(rows);
  const mine = rows.filter((r) => place(r).person === key);
  // As their page: a person is someone with gifts of their own (one whose every gift counts for an organization is it)
  if (!mine.length) return null;
  const emails = [...new Set([...mine.map((r) => r.email), ...keys.filter((k) => k.startsWith('e:')).map((k) => k.slice(2))].filter(Boolean).map(normEmail))];
  // A person known by email before Zeffy had a contact: the team's changes from then are theirs too (as pageExtras)
  const all = [...new Set([...keys, ...emails.map((e) => `e:${e}`)])];
  const contacts = [...new Set([...keys.filter((k) => k.startsWith('c:')).map((k) => k.slice(2)), ...mine.map((r) => r.contact).filter(Boolean).map(String)])];
  const newest = [...mine].sort((a, b) => b.at - a.at)[0];
  return { kind: 'person', key, keys: all, name: newest ? personName(newest) : 'This donor', emails, contacts, phones: [], domains: [], people: [] };
}

// ─── Gmail ──────────────────────────────────────────────────────────

const MAIL_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Message-ID', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted'];

/** Gmail's search words for the donor: any message from, to or copied to one of their addresses (or domains) */
export function mailQuery({ emails, domains }) {
  const terms = [
    ...emails.flatMap((e) => [`from:${e}`, `to:${e}`, `cc:${e}`, `bcc:${e}`]),
    ...domains.flatMap((d) => [`from:${d}`, `to:${d}`, `cc:${d}`]),
  ];
  return terms.length ? `{${terms.join(' ')}} -in:chats -from:noreply -from:no-reply -from:donotreply -from:mailer-daemon` : '';
}

/** Gmail's batch answer (multipart/mixed, one HTTP answer a part, Content-ID response-i<n>) → [JSON | null] by n */
export function parseBatch(text, boundary, n) {
  const out = Array(n).fill(null);
  if (!boundary) return out;
  for (const part of String(text || '').split(`--${boundary}`)) {
    const id = /Content-ID:\s*<?response-i(\d+)>?/i.exec(part)?.[1];
    if (id == null || Number(id) >= n) continue;
    const status = Number(/HTTP\/[\d.]+\s+(\d{3})/.exec(part)?.[1] || 0);
    const start = part.indexOf('{');
    const end = part.lastIndexOf('}');
    if (status !== 200 || start < 0 || end < start) continue;
    try { out[Number(id)] = JSON.parse(part.slice(start, end + 1)); } catch { /* one unreadable answer is a gap, not a failure */ }
  }
  return out;
}

/** Several Gmail GETs in one request (Gmail's batch endpoint): one connection for a mailbox's conversations */
async function gmailBatch(token, paths, fetchImpl) {
  if (!paths.length) return [];
  const boundary = `soard${crypto.randomUUID().replace(/-/g, '')}`;
  const body = `${paths.map((p, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <i${i}>\r\n\r\nGET /gmail/v1/users/me${p}\r\n\r\n`).join('')}--${boundary}--`;
  const res = await fetchImpl(GMAIL_BATCH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw fail(500, `Gmail answered ${res.status}`);
  const b = /boundary=("?)([^";\s]+)\1/i.exec(res.headers.get('content-type') || '')?.[2];
  return parseBatch(await res.text(), b, paths.length);
}

/** Is an address the donor's? (one of their addresses, or on their domain) */
export const matcher = ({ emails, domains, dropped = [] }, team = null) => {
  const set = new Set(emails);
  const never = new Set(dropped);
  // The domain itself, never its subdomains (a store's order.example.com is its systems, not its people); never the
  // team's own address, even one at the organization's domain (a teammate who gives for it from work)
  return (a) => !never.has(a) && !(team && (team.addresses.has(a) || team.domains.has(domainOf(a)))) && (set.has(a) || domains.includes(domainOf(a)));
};

/**
 * One Gmail message as a timeline line, or null when it isn't one: not about the donor, a draft, the donor's own
 * newsletter or mass mailing, an auto-reply. dir: 'in' (they wrote), 'out' (the team wrote to them), 'cc' (someone
 * else wrote to both)
 */
export function mailLine(msg, { mailbox, isTheirs, team, exact = null }) {
  const h = msg.payload?.headers || [];
  const labels = msg.labelIds || [];
  if (labels.includes('DRAFT') || labels.includes('SPAM') || labels.includes('TRASH')) return null;
  const from = header(h, 'From');
  const fromAddr = addressesIn(from)[0] || '';
  const to = addressesIn(header(h, 'To'));
  const cc = addressesIn(header(h, 'Cc'));
  // Bcc is on the sender's own copy only: a thank-you blind-copied to them is theirs too
  const bcc = addressesIn(header(h, 'Bcc'));
  const theirs = [fromAddr, ...to, ...cc, ...bcc].filter((a) => a && isTheirs(a));
  if (!theirs.length) return null;
  const isTeam = (a) => team.addresses.has(a) || team.domains.has(domainOf(a));
  const dir = isTheirs(fromAddr) ? 'in' : isTeam(fromAddr) ? 'out' : 'cc';
  if (dir !== 'out') {
    // Their (or someone else's) newsletter or mass mailing, an auto-reply: not a conversation with the team
    if (header(h, 'List-Id') || header(h, 'List-Unsubscribe') || /^(bulk|list|junk)$/i.test(header(h, 'Precedence'))) return null;
    if (to.length + cc.length > CROWD) return null;
    const auto = header(h, 'Auto-Submitted');
    if (auto && !/^no$/i.test(auto)) return null;
  }
  // Matched by the organization's domain alone, from a no-reply or an order system: a store's mail, not its people's
  if (dir === 'in' && exact && !exact.has(fromAddr) && AUTO_SENDER.test(fromAddr.split('@')[0])) return null;
  const staffOf = (a) => team.addresses.get(a)?.email || (team.domains.has(domainOf(a)) ? a : null);
  const staff = dir === 'out' ? [staffOf(fromAddr)].filter(Boolean) : [...new Set([...to, ...cc].map(staffOf).filter(Boolean))];
  return {
    id: `mail:${clean(header(h, 'Message-ID')).toLowerCase() || msg.id}`,
    kind: 'email',
    at: Number(msg.internalDate) || Date.parse(header(h, 'Date')) || 0,
    dir,
    title: clean(header(h, 'Subject')) || '(no subject)',
    detail: clean(msg.snippet).slice(0, 240),
    from: nameIn(from),
    staff: staff.length ? staff : [mailbox],
    // The donor-side addresses on it (an organization's: whose it was)
    them: [...new Set(theirs)],
    mailbox,
    // Each mailbox's own copy (Gmail's conversation ids are each mailbox's own): which to open, and Open in Gmail
    copies: { [mailbox]: msg.threadId },
    thread: msg.threadId,
    gmailId: msg.id,
  };
}

/** One mailbox's newest conversations with the donor → { lines, next, error } */
async function mailboxLines(env, box, look, { fetchImpl, now, run, page = '' }) {
  try {
    const token = await run(() => accessToken(env, box.email, { fetchImpl, now, scope: GMAIL_READ_SCOPE }));
    const meta = MAIL_HEADERS.map((x) => `&metadataHeaders=${encodeURIComponent(x)}`).join('');
    const path = (id) => `/threads/${id}?format=metadata${meta}`;
    const lines = [];
    let missed = 0;
    let next = /^[A-Za-z0-9_-]{1,200}$/.test(String(page || '')) ? page : '';
    // A page Gmail found whose conversations all turn out not to be theirs (list mail, a store's systems): the next
    // page too, a few at most, so a mailbox never shows nothing while it holds their conversations
    for (let pages = 0; pages < MAIL_PAGES && (pages === 0 || (next && lines.length < MAIL_ENOUGH)); pages++) {
      const list = await run(() => gmail(token, `/threads?maxResults=${MAIL_PAGE}&q=${encodeURIComponent(look.q)}${next ? `&pageToken=${next}` : ''}`, fetchImpl));
      next = list.nextPageToken || null;
      const ids = (list.threads || []).map((t) => t.id).filter((id) => /^[A-Za-z0-9_-]{6,64}$/.test(id));
      // A few at a time (Gmail turns away many reads at once for one mailbox), and the ones it turned away asked once more
      const threads = [];
      for (let i = 0; i < ids.length; i += BATCH) threads.push(...(await run(() => gmailBatch(token, ids.slice(i, i + BATCH).map(path), fetchImpl))));
      const again = ids.filter((_, i) => !threads[i]);
      if (again.length) {
        const got = await run(() => gmailBatch(token, again.map(path), fetchImpl)).catch(() => []);
        again.forEach((id, j) => { if (got[j]) threads[ids.indexOf(id)] = got[j]; });
      }
      for (const t of threads) for (const m of t?.messages || []) { const l = mailLine(m, { mailbox: box.email, isTheirs: look.isTheirs, team: look.people, exact: look.exact }); if (l) lines.push(l); }
      missed += threads.filter((t) => !t).length;
    }
    return { lines, next, missed };
  } catch (e) {
    return { lines: [], next: null, error: /unauthorized_client/.test(e.message) ? 'Google hasn’t given the site Gmail read access' : e.message };
  }
}

/** The same email in several mailboxes (copied to two of the team) is one line: the sender's copy opens it */
export function oneEach(lines) {
  const by = new Map();
  for (const l of lines) {
    const had = by.get(l.id);
    if (!had) { by.set(l.id, { ...l, copies: { ...l.copies } }); continue; }
    had.copies = { ...had.copies, ...l.copies };
    had.staff = [...new Set([...had.staff, ...l.staff])];
    if (l.dir === 'out' && l.staff.includes(l.mailbox) && !had.staff.includes(had.mailbox)) { had.mailbox = l.mailbox; had.thread = l.thread; had.gmailId = l.gmailId; }
  }
  return [...by.values()].map((l) => ({ ...l, mailboxes: Object.keys(l.copies) }));
}

/** Every mailbox's conversations with the donor → { lines, next: { mailbox: pageToken }, errors: [{ mailbox, error }], missed } */
async function readMail(env, look, { fetchImpl, now, run, pages = null }) {
  const boxes = (await mailboxes(env)).filter((b) => !pages || pages[b.email]);
  const each = await Promise.all(boxes.map((b) => mailboxLines(env, b, look, { fetchImpl, now, run, page: pages?.[b.email] || '' })));
  const next = {};
  const errors = [];
  let missed = 0;
  each.forEach((r, i) => { if (r.next) next[boxes[i].email] = r.next; if (r.error) errors.push({ mailbox: boxes[i].email, error: r.error }); missed += r.missed || 0; });
  return { lines: oneEach(each.flatMap((r) => r.lines)), next, errors, missed, boxes: boxes.length };
}

// ─── Google Calendar ────────────────────────────────────────────────

/** One calendar event with the donor on it as a timeline line, or null */
export function meetingLine(ev, { mailbox, isTheirs, team }) {
  if (!ev || ev.status === 'cancelled') return null;
  const guests = ev.attendees || [];
  const org = normEmail(ev.organizer?.email);
  const theirs = guests.filter((g) => isTheirs(normEmail(g.email)));
  if (!theirs.length && !(org && isTheirs(org))) return null;
  const start = ev.start?.dateTime || ev.start?.date;
  const at = Date.parse(ev.start?.dateTime || `${ev.start?.date}T12:00:00Z`);
  if (!start || !Number.isFinite(at)) return null;
  const staff = [...new Set([org, ...guests.map((g) => normEmail(g.email))].filter((a) => a && team.addresses.has(a)).map((a) => team.addresses.get(a).email))];
  const said = theirs.map((g) => g.responseStatus).find(Boolean) || null;
  return {
    // The moment, not the words: one event on calendars in different time zones is one line
    id: `cal:${ev.iCalUID || ev.id}:${at}`,
    kind: 'meeting',
    at,
    allDay: !ev.start?.dateTime,
    end: Date.parse(ev.end?.dateTime || '') || null,
    title: clean(ev.summary) || 'A meeting',
    staff: staff.length ? staff : [mailbox],
    guests: guests.length,
    // More than 15 on the invite: an event they were invited to (a reveal), not a meeting
    big: guests.length > 15,
    answer: said === 'accepted' ? 'yes' : said === 'declined' ? 'no' : said === 'tentative' ? 'maybe' : null,
    them: [...new Set([...theirs.map((g) => normEmail(g.email)), ...(org && isTheirs(org) ? [org] : [])])],
    mailbox,
  };
}

async function calendarLines(env, box, look, { fetchImpl, now, run }) {
  try {
    const token = await run(() => accessToken(env, box.email, { fetchImpl, now, scope: CALENDAR_SCOPE }));
    const words = [...look.emails.slice(0, MAX_CAL_ADDRESSES), ...look.domains.slice(0, 1)];
    const lines = [];
    for (const q of words) {
      // Oldest first is the only order Google gives: every page of it (to CAL_PAGES), so the newest are never cut off
      let pageToken = '';
      for (let page = 0; page < CAL_PAGES; page++) {
        const p = new URLSearchParams({ q, singleEvents: 'true', orderBy: 'startTime', timeMin: iso(now - CAL_BACK_MS), timeMax: iso(now + CAL_AHEAD_MS), maxResults: '250', ...(pageToken ? { pageToken } : {}) });
        const res = await run(() => fetchImpl(`${CAL_API}/calendars/primary/events?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }));
        if (res.status === 404) { await res.body?.cancel?.(); return { lines }; } // no calendar on this account
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`Calendar answered ${res.status}: ${body?.error?.message || ''}`.trim());
        for (const ev of body?.items || []) { const l = meetingLine(ev, { mailbox: box.email, isTheirs: look.isTheirs, team: look.people }); if (l) lines.push(l); }
        pageToken = body?.nextPageToken || '';
        if (!pageToken) break;
      }
    }
    return { lines };
  } catch (e) {
    return { lines: [], error: /unauthorized_client/.test(e.message) ? 'Google hasn’t given the site calendar access' : e.message };
  }
}

async function readCalendars(env, look, { fetchImpl, now, run }) {
  const boxes = await mailboxes(env);
  const each = await Promise.all(boxes.map((b) => calendarLines(env, b, look, { fetchImpl, now, run })));
  const by = new Map();
  for (const l of each.flatMap((r) => r.lines)) {
    const had = by.get(l.id);
    if (!had) by.set(l.id, l);
    else had.staff = [...new Set([...had.staff, ...l.staff])];
  }
  return { lines: [...by.values()], boxes: boxes.length, errors: each.map((r, i) => (r.error ? { mailbox: boxes[i].email, error: r.error } : null)).filter(Boolean) };
}

// ─── Quo: calls and texts ───────────────────────────────────────────

export const quoConfigured = (env) => Boolean(String(env.QUO_API_KEY || '').trim());

async function quoGet(env, path, fetchImpl) {
  const res = await fetchImpl(`${QUO_API}${path}`, { headers: { Authorization: String(env.QUO_API_KEY).trim(), 'Quo-Api-Version': QUO_VERSION, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 502 : 500, res.status === 401 ? 'Quo didn’t take the site’s key' : `Quo answered ${res.status}${body?.message ? `: ${body.message}` : ''}`);
  return body;
}

let quoPeople = null; // { at, users: Map(id → { name, email }), numbers: Map(id → { name, number }) }
async function quoDirectory(env, fetchImpl, now, run = (fn) => fn()) {
  if (quoPeople && now - quoPeople.at < QUO_PEOPLE_MS) return quoPeople;
  const [u, n] = await Promise.all([run(() => quoGet(env, '/users?limit=50', fetchImpl)), run(() => quoGet(env, '/phone-numbers?limit=50', fetchImpl))]);
  quoPeople = {
    at: now,
    users: new Map((u?.data || []).map((x) => [x.id, { name: clean([x.firstName, x.lastName].filter(Boolean).join(' ')) || x.email || 'Someone', email: normEmail(x.email) }])),
    numbers: new Map((n?.data || []).map((x) => [x.id, { name: clean(x.name) || '', number: x.number || x.phoneNumber || '' }])),
  };
  return quoPeople;
}

/** A call as a timeline line */
export function callLine(c, { users, numbers, phones }) {
  const user = users.get(c.answeredBy) || users.get(c.initiatedBy) || users.get(c.actorId) || null;
  const missed = ['missed', 'no-answer', 'busy', 'canceled', 'abandoned', 'failed'].includes(c.status) || (!c.answeredAt && c.direction === 'incoming');
  const them = (c.participants || []).map((p) => p?.phoneNumber || p).filter((p) => phones.includes(p));
  return {
    id: `call:${c.id}`,
    kind: 'call',
    at: Date.parse(c.createdAt) || 0,
    dir: c.direction === 'incoming' ? 'in' : 'out',
    missed,
    duration: Number(c.duration) || 0,
    by: user?.name || null,
    byEmail: user?.email || null,
    line: numbers.get(c.phoneNumberId)?.name || null,
    them,
    callId: c.id,
    ai: c.aiHandled === 'ai-agent',
    summary: Array.isArray(c.summary?.summary) ? c.summary.summary.map(clean).filter(Boolean).slice(0, 8) : [],
    nextSteps: Array.isArray(c.summary?.nextSteps) ? c.summary.nextSteps.map(clean).filter(Boolean).slice(0, 8) : [],
    voicemail: c.voicemail ? { transcript: clean(c.voicemail.transcript).slice(0, 2000) || null, duration: Number(c.voicemail.duration) || 0 } : null,
  };
}

const easternDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** A day's texts in one conversation as one line (the texts themselves open with it) */
export function textLines(messages, { users }) {
  const by = new Map();
  for (const m of messages) {
    const at = Date.parse(m.createdAt) || 0;
    const k = `${m.conversationId || m.phoneNumberId}:${easternDay(at)}`;
    const g = by.get(k) || { id: `texts:${k}`, kind: 'text', at: 0, messages: [], by: new Set() };
    const user = users.get(m.userId);
    if (m.direction === 'outgoing' && user) g.by.add(user.name);
    g.messages.push({ at, dir: m.direction === 'incoming' ? 'in' : 'out', text: String(m.text || '').slice(0, MAX_TEXT), by: m.direction === 'outgoing' ? user?.name || null : null, media: (m.media || []).length });
    g.at = Math.max(g.at, at);
    by.set(k, g);
  }
  return [...by.values()].map((g) => {
    const list = [...new Map(g.messages.map((x) => [`${x.at}:${x.dir}:${x.text}`, x])).values()].sort((a, b) => a.at - b.at);
    const last = list[list.length - 1];
    return { ...g, by: [...g.by], count: list.length, messages: list, detail: clean(last?.text).slice(0, 200) || (last?.media ? 'A picture' : ''), dir: list.some((x) => x.dir === 'in') ? 'in' : 'out' };
  });
}

/** The donor's phone numbers, from their Zeffy contacts (an organization's first few givers') */
async function phonesOf(env, subject, { fetchImpl, run }) {
  // Numbers kept with the record itself (a partner's people), then their Zeffy contacts'
  const own = [...new Set((subject.phones || []).filter(Boolean))];
  const ids = (subject.contacts || []).slice(0, MAX_PHONE_CONTACTS);
  if (!ids.length || !env.ZEFFY_API_KEY) return { phones: own, note: own.length ? null : !env.ZEFFY_API_KEY ? 'Zeffy isn’t connected, so their phone number isn’t known' : 'Zeffy has no contact for them, so no phone number' };
  // Busy: the numbers kept with the record now, and said, so calls from their Zeffy numbers aren't missed in silence
  if (zeffyQuota.remaining != null && zeffyQuota.remaining < ZEFFY_KEEP && Date.now() - zeffyQuota.at < MIN) return { phones: own, busy: true, note: 'Zeffy is busy this minute: the phone numbers it has for them are read next time' };
  const got = await Promise.all(ids.map((id) => run(() => zeffyGet(env, `/contacts/${encodeURIComponent(id)}`, {}, fetchImpl)).catch(() => null)));
  const phones = [...new Set([...own, ...got.map((c) => e164(c?.phone_number)).filter(Boolean)])];
  return { phones, note: phones.length ? null : 'Zeffy has no phone number for them' };
}

/** The donor's numbers in Quo's terms, never one of SOARD's own → { phones, dir, note, busy } */
async function theirPhones(env, subject, { fetchImpl, now, run }) {
  const got = await phonesOf(env, subject, { fetchImpl, run });
  if (!got.phones.length) return { ...got, dir: null };
  const dir = await quoDirectory(env, fetchImpl, now, run);
  const ours = new Set([...dir.numbers.values()].map((n) => n.number));
  const phones = got.phones.filter((p) => !ours.has(p));
  return { phones, dir, busy: !!got.busy, note: got.busy ? got.note : phones.length ? null : 'Their number in Zeffy is one of SOARD’s' };
}

async function readQuo(env, subject, { fetchImpl, now, run, after = null }) {
  if (!quoConfigured(env)) return { state: 'off', lines: [] };
  try {
    const { phones, dir, note, busy } = await theirPhones(env, subject, { fetchImpl, now, run });
    if (!phones.length) return { state: busy ? 'error' : 'none', note, lines: [] };
    // Some of their numbers read (a partner's own people), Zeffy's not this minute: what there is, and said
    const partly = busy ? note : null;
    const calls = new URLSearchParams({ 'participant[in]': phones.join(','), include: 'summary,voicemail', limit: '50' });
    if (after) calls.set('after', after);
    const reads = [run(() => quoGet(env, `/calls?${calls}`, fetchImpl))];
    if (!after) for (const p of phones.slice(0, 3)) {
      reads.push(run(() => quoGet(env, `/messages?${new URLSearchParams({ from: p, limit: '50' })}`, fetchImpl)));
      reads.push(run(() => quoGet(env, `/messages?${new URLSearchParams({ to: p, limit: '50' })}`, fetchImpl)));
    }
    const [c, ...m] = await Promise.all(reads);
    // Only what involves their numbers, whatever Quo answered (were it ever to ignore the filter, another person's call
    // and Quo's summary of it would be on this page)
    const theirs = (n) => phones.includes(typeof n === 'string' ? n : n?.phoneNumber);
    const theirCalls = (c?.data || []).filter((x) => (x.participants || []).some(theirs));
    const theirTexts = m.flatMap((x) => x?.data || []).filter((x) => theirs(x.from) || [].concat(x.to || []).some(theirs));
    const lines = [...theirCalls.map((x) => callLine(x, { users: dir.users, numbers: dir.numbers, phones })), ...textLines(theirTexts, { users: dir.users })];
    return { state: 'ok', phones, lines, next: c?.nextCursor || null, ...(partly ? { note: partly } : {}) };
  } catch (e) {
    return { state: 'error', note: e.message, lines: [] };
  }
}

// ─── Kit ────────────────────────────────────────────────────────────

let kitSends = null; // { at, list: [{ id, subject, at, filter, url }] }
async function kitJson(env, path) {
  const res = await kitFetch(env, path);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Kit answered ${res.status}`);
  return body || {};
}
/** Every broadcast Kit has sent (kept ten minutes: the same for every donor) */
async function sentBroadcasts(env, now) {
  if (kitSends && now - kitSends.at < KIT_SENDS_MS) return kitSends.list;
  const list = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ per_page: '500', ...(after ? { after } : {}) });
    const body = await kitJson(env, `/broadcasts?${q}`);
    for (const b of body.broadcasts || []) {
      const at = Date.parse(b.send_at || b.published_at || '');
      if (!Number.isFinite(at) || at > now || (b.status && b.status !== 'completed')) continue;
      list.push({ id: b.id, subject: clean(b.subject) || clean(b.description) || 'An email', at, filter: b.subscriber_filter || [], url: b.public && b.public_url ? b.public_url : null });
    }
    if (!body.pagination?.has_next_page) break;
    after = body.pagination.end_cursor;
  }
  kitSends = { at: now, list };
  return list;
}

/**
 * Did a broadcast go to this subscriber? To the whole list, or to a tag they had when it went (Kit doesn't say who
 * got a broadcast; it keeps who is on the list and their tags with when, as DataX reads it). A segment, or anything
 * else the site can't tell, counts as not.
 */
export function sentTo(b, { tags }) {
  const groups = (Array.isArray(b.filter) ? b.filter : []).filter(Boolean);
  const had = (ids) => [].concat(ids || []).some((id) => { const t = tags.get(Number(id)); return t && t.at <= b.at; });
  const rule = (r) => (r?.type === 'all_subscribers' ? true : r?.type === 'tag' ? had(r.ids) : null);
  for (const g of groups) {
    for (const [op, rules] of Object.entries(g || {})) {
      // Kit sends each part, empty (null) when it isn't used: an empty part says nothing
      const list = [].concat(rules || []).filter(Boolean);
      if (!list.length) continue;
      const got = list.map(rule);
      if (got.some((x) => x === null)) return false;
      if (!(op === 'none' ? !got.some(Boolean) : op === 'any' ? got.some(Boolean) : got.every(Boolean))) return false;
    }
  }
  return true;
}

/** What a Kit tag means, in words */
export function tagWords(name, kids) {
  const n = clean(name);
  if (n === REVEAL_TAG || n === REVEAL_ONLY_TAG) return 'Signed up to watch every reveal';
  const kid = /^Reveal sign-ups: (.+)$/.exec(n)?.[1];
  if (kid) return `Signed up to watch ${kids.get(kid) ? `${kids.get(kid)}’s` : 'a'} reveal`;
  if (/^donors?$/i.test(n)) return 'Added to Donors in Kit (a Zeffy gift)';
  return `Tagged “${n}” in Kit`;
}

async function readKit(env, subject, { now, run, kids }) {
  if (!kitConfigured(env)) return { state: 'off', lines: [] };
  const emails = subject.emails.slice(0, MAX_ADDRESSES);
  if (!emails.length) return { state: 'none', note: 'No email to find them by', lines: [] };
  try {
    const [any, left, sends] = await Promise.all([
      run(() => kitJson(env, `/subscribers?${new URLSearchParams({ email_address: emails.join(','), status: 'all', per_page: '100' })}`)),
      run(() => kitJson(env, `/subscribers?${new URLSearchParams({ email_address: emails.join(','), status: 'cancelled', include: 'canceled_at', per_page: '100' })}`)),
      run(() => sentBroadcasts(env, now)),
    ]);
    const cancelled = new Map((left.subscribers || []).map((s) => [normEmail(s.email_address), s.canceled_at || null]));
    const subs = (any.subscribers || []).slice(0, 4);
    if (!subs.length) return { state: 'ok', none: true, lines: [], summary: null };
    const lines = [];
    const got = new Map();
    let stats = { sent: 0, opened: 0, clicked: 0, lastOpened: null };
    for (const s of subs) {
      const email = normEmail(s.email_address);
      const joined = Date.parse(s.created_at) || null;
      const leftAt = Date.parse(cancelled.get(email) || '') || null;
      const [t, st] = await Promise.all([
        run(() => kitJson(env, `/subscribers/${s.id}/tags?per_page=500`)).catch(() => null),
        run(() => kitJson(env, `/subscribers/${s.id}/stats?${new URLSearchParams({ email_sent_after: easternDay(now - 365 * DAY) })}`)).catch(() => null),
      ]);
      const tags = new Map((t?.tags || []).map((x) => [Number(x.id), { name: x.name, at: Date.parse(x.tagged_at) || 0 }]));
      if (joined) lines.push({ id: `kit:join:${s.id}`, kind: 'kit', at: joined, title: 'Joined the newsletter in Kit', detail: subs.length > 1 ? email : null });
      if (leftAt) lines.push({ id: `kit:left:${s.id}`, kind: 'kit', at: leftAt, title: 'Unsubscribed from the newsletter', detail: subs.length > 1 ? email : null, tone: 'warn' });

      for (const [id, tag] of tags) if (tag.at) lines.push({ id: `kit:tag:${s.id}:${id}`, kind: 'kit', at: tag.at, title: tagWords(tag.name, kids) });
      // Kit sends only to people on the list: from joining until leaving (a bounced or never-confirmed address got none)
      if (joined && (s.state === 'active' || s.state === 'cancelled')) {
        const until = leftAt || now;
        for (const b of sends) if (b.at >= joined && b.at <= until && sentTo(b, { tags })) got.set(b.id, b);
      }
      const x = st?.subscriber?.stats || null;
      if (x) stats = { sent: stats.sent + (x.sent || 0), opened: stats.opened + (x.opened || 0), clicked: stats.clicked + (x.clicked || 0), lastOpened: [stats.lastOpened, x.last_opened].filter(Boolean).sort().pop() || null };
    }
    // One line a month of newsletters: what came, each one there to read
    const months = new Map();
    for (const b of got.values()) {
      const m = easternDay(b.at).slice(0, 7);
      const g = months.get(m) || [];
      g.push(b);
      months.set(m, g);
    }
    for (const [m, list] of months) {
      list.sort((a, b) => a.at - b.at);
      lines.push({ id: `kit:sends:${m}`, kind: 'kit', at: list[list.length - 1].at, title: list.length === 1 ? `Newsletter: “${list[0].subject}”` : `${list.length} newsletters`, sends: list.map((b) => ({ id: b.id, subject: b.subject, at: b.at, url: b.url })), month: m });
    }
    // Kit can't reach them (a bounce, a spam report): a state now, said above the timeline (Kit gives no day for it)
    return { state: 'ok', lines, summary: { ...stats, states: subs.map((s) => s.state), cant: subs.filter((s) => s.state === 'bounced' || s.state === 'complained').map((s) => ({ email: normEmail(s.email_address), state: s.state })) } };
  } catch (e) {
    return { state: 'error', note: e.message, lines: [] };
  }
}

// ─── What the site sent them, what the team did ─────────────────────

const ENTRY_WORDS = {
  'rem-welcome': 'Reveal sign-up', 'rem-confirm': 'Reveal sign-up', 'rem-scheduled': 'Reveal reminder', 'rem-moved': 'Reveal reminder', 'rem-day': 'Reveal reminder',
  'rem-hour': 'Reveal reminder', 'rem-live': 'Reveal reminder', 'rem-replay': 'Reveal reminder', 'advisory-thanks': 'Advisory Board', 'waitlist-confirm': 'Application waitlist', 'waitlist-open': 'Application waitlist',
};
async function readSite(DB, emails) {
  if (!emails.length) return { state: 'none', lines: [] };
  try {
    const rows = (await DB.prepare(`SELECT id, type, to_addr, subject, sent_at, status, opened_at, clicked_at, bounce_type FROM email_log WHERE lower(to_addr) IN (${emails.map(() => '?').join(', ')}) ORDER BY sent_at DESC LIMIT ${SITE_ROWS}`).bind(...emails).all()).results || [];
    const lines = [];
    for (const r of rows) {
      const entry = entryFor(r.type, r.subject);
      // Staff alerts and previews never go to a donor's address; one that did is the team's own test
      if (entry === 'preview' || audienceOf(entry) === 'staff' || audienceOf(entry) === 'you') continue;
      lines.push({
        id: `site:${r.id}`, kind: 'site', at: Date.parse(r.sent_at) || 0, title: clean(r.subject) || 'An email from the website', detail: ENTRY_WORDS[entry] || null,
        status: r.status, opened: !!r.opened_at, clicked: !!r.clicked_at, emailId: r.id, tone: ['bounced', 'complained', 'failed'].includes(r.status) ? 'warn' : null,
      });
    }
    return { state: 'ok', lines };
  } catch (e) {
    if (/no such table/i.test(String(e.message))) return { state: 'ok', lines: [] };
    return { state: 'error', note: e.message, lines: [] };
  }
}

/** The team's changes (audit_log): a note is on the timeline itself, so only what isn't */
export function teamLine(r) {
  let ch = {};
  try { ch = JSON.parse(r.changes || '{}') || {}; } catch { /* words only */ }
  // A note added or changed is on the timeline as itself; a deleted one leaves who deleted it, and when
  if (ch.note && !/deleted/i.test(String(r.entity_name || ''))) return null;
  const by = r.user_email && r.user_email !== 'unknown' ? r.user_email : null;
  return {
    id: `team:${r.id}`,
    kind: ch.gift && ch.state ? 'thanks' : 'team',
    at: Date.parse(`${String(r.created_at).replace(' ', 'T')}Z`) || 0,
    title: clean(r.entity_name) || 'A change',
    by: by && by.includes('@') ? by : null,
    // A name the site itself used ('Zeffy merge'): who did it
    byName: by && !by.includes('@') ? by : null,
    gift: ch.gift || null,
    state: ch.state || null,
  };
}
async function readTeam(DB, keys) {
  if (!keys.length) return { state: 'ok', lines: [] };
  try {
    const out = [];
    for (let i = 0; i < keys.length; i += 80) {
      const part = keys.slice(i, i + 80);
      out.push(...((await DB.prepare(`SELECT id, user_email, entity_name, changes, created_at FROM audit_log WHERE entity_type = 'donor-crm' AND entity_slug IN (${part.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT ${TEAM_ROWS}`).bind(...part).all()).results || []));
    }
    return { state: 'ok', lines: out.map(teamLine).filter(Boolean) };
  } catch (e) {
    if (/no such table/i.test(String(e.message))) return { state: 'ok', lines: [] };
    return { state: 'error', note: e.message, lines: [] };
  }
}

const LEVEL_WORDS = { signature: 'Signature', champion: 'Champion', builder: 'Builder', friend: 'Friend' };
const FIELD_WORDS = { name: 'name', logo: 'logo', website: 'website', level: 'level', category: 'what they help with', featured: 'featured', description: 'description', logoFolders: 'linked logo folders', publishStatus: 'shown or hidden' };
/** A partner page's saved versions, oldest first → what changed in each, in words */
export function partnerLines(versions, slug) {
  const lines = [];
  let before = null;
  for (const v of versions) {
    let d = null;
    try { d = JSON.parse(v.data || 'null'); } catch { /* skipped */ }
    const at = Date.parse(v.created_at) || 0;
    const by = v.user_email || null;
    if (v.action === 'delete') { lines.push({ id: `partner:${v.id}`, kind: 'partner', at, by, title: 'Taken off the website' }); before = null; continue; }
    if (!d) continue;
    // The version kept from before history began (no author, a second before the first save) is how it was, not a change
    if (!before) {
      if (by || versions.length === 1) lines.push({ id: `partner:${v.id}`, kind: 'partner', at, by, title: `On the website as a ${LEVEL_WORDS[d.level] || 'Friend'} partner` });
      before = d;
      continue;
    }
    const fields = changedFields(before, d);
    if (!fields.length) { before = d; continue; }
    const words = [];
    if (fields.includes('level')) words.push(`${LEVEL_WORDS[before.level] || 'Friend'} → ${LEVEL_WORDS[d.level] || 'Friend'} partner`);
    if (fields.includes('name')) words.push(`renamed from ${clean(before.name)}`);
    if (fields.includes('logo')) words.push('a new logo');
    const rest = fields.filter((f) => !['level', 'name', 'logo'].includes(f)).map((f) => FIELD_WORDS[f] || f);
    if (rest.length) words.push(`its ${rest.slice(0, 3).join(', ')}${rest.length > 3 ? ' and more' : ''} changed`);
    lines.push({ id: `partner:${v.id}`, kind: 'partner', at, by, title: `Partner page: ${words.join('; ')}`, slug, level: fields.includes('level') ? d.level : null });
    before = d;
  }
  return lines;
}

/**
 * The makeovers that credit an organization (designed by, monetary sponsor), each on the day the page first credited
 * it (its saved versions); one credited before the page's history began has only its year (Kids holds no reveal date)
 */
async function readMakeovers(DB, slug) {
  const lines = [];
  for (const [table, kind] of [['kids', 'kid'], ['community', 'community']]) {
    let rows = [];
    try { rows = (await DB.prepare(`SELECT slug, data FROM ${table} WHERE data LIKE ?`).bind(`%"${slug.replace(/[%_]/g, '')}"%`).all()).results || []; } catch { continue; }
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch { continue; }
      const roles = [['designers', 'Designed'], ['sponsors', 'Paid for']].filter(([f]) => (d[f] || []).includes(slug));
      if (!roles.length) continue;
      // The first saved version that credits it: the day it was credited
      let since = null;
      try {
        const versions = (await DB.prepare('SELECT data, user_email, created_at FROM content_versions WHERE collection = ? AND slug = ? ORDER BY id').bind(table, r.slug).all()).results || [];
        for (const [i, v] of versions.entries()) {
          let x = {};
          try { x = JSON.parse(v.data || '{}'); } catch { continue; }
          if (!roles.some(([f]) => (x[f] || []).includes(slug))) continue;
          // Credited in the copy kept from before the page's history began (the first, with no one's name): before
          // history, so its year only
          if (i === 0 && !v.user_email && versions.length > 1) break;
          since = Date.parse(v.created_at) || null;
          break;
        }
      } catch { /* no history: its year */ }
      const year = Number(d.year) || null;
      const name = clean(d.name) || r.slug;
      lines.push({
        id: `makeover:${kind}:${r.slug}`, kind: 'makeover', at: since || (year ? Date.UTC(year, 0, 1, 12) : 0), year: since ? null : year, undated: !since && !year,
        title: `${roles.map(([, w]) => w).join(' and ')} ${kind === 'kid' ? `${name}’s makeover` : name}`,
        record: kind === 'kid' ? r.slug : `community/${r.slug}`, draft: d.publishStatus === 'draft',
      });
    }
  }
  return { state: 'ok', lines };
}

async function kidFirstNames(DB) {
  try {
    const rows = (await DB.prepare("SELECT slug, json_extract(data, '$.name') AS name FROM kids").all()).results || [];
    return new Map(rows.map((r) => [r.slug, clean(r.name).split(' ')[0]]));
  } catch { return new Map(); }
}

// ─── The timeline ───────────────────────────────────────────────────

const SOURCES = { mail: 'Email with the team', calendar: 'Meetings', quo: 'Calls and texts', kit: 'Newsletters', site: 'Emails from the website', team: 'The team’s changes', partner: 'The Partners page' };

/**
 * A donor's timeline from everything outside their page → { subject: { name, kind, searched }, items, sources:
 * [{ key, label, state: ok | error | off | none | skipped, note, errors }], more: { mail, quo } }. The page adds its
 * gifts and notes. `local`: only what the site itself holds (the team's changes, its emails, the partner page), read
 * again at once after a change on the page, without asking Google, Quo or Kit again.
 */
export async function timelineView(env, ref, { now = Date.now(), fetchImpl = fetch, local = false } = {}) {
  const subject = await subjectOf(env, ref, { now });
  if (!subject) return null;
  const look = lookOf(subject, teamOf(await directory(env.DB)));
  const run = queue();
  const google = Boolean(env.GOOGLE_CALENDAR_KEY);
  const asked = look.emails.length + look.domains.length > 0;
  const onTeam = { state: 'skipped', note: `${subject.name} is on the team: their email, meetings and calls aren’t shown here`, lines: [] };
  const kids = local ? new Map() : await kidFirstNames(env.DB);
  const outside = (fn) => (local ? null : fn());
  const [mail, calendar, quo, kit, site, teamRows, partner, makeovers] = await Promise.all([
    local ? null : look.team ? onTeam : !asked ? { state: 'none', note: 'No email to search for', lines: [] } : !google ? { state: 'off', lines: [] }
      : readMail(env, look, { fetchImpl, now, run }).then((r) => ({ state: r.errors.length && r.errors.length >= r.boxes ? 'error' : 'ok', ...r })),
    local ? null : look.team ? onTeam : !asked ? { state: 'none', lines: [] } : !google ? { state: 'off', lines: [] }
      : readCalendars(env, look, { fetchImpl, now, run }).then((r) => ({ state: r.errors.length && r.errors.length >= r.boxes ? 'error' : 'ok', ...r })),
    outside(() => (look.team ? onTeam : readQuo(env, look.subject, { fetchImpl, now, run }))),
    outside(() => readKit(env, { ...subject, emails: look.emails }, { now, run, kids })),
    readSite(env.DB, look.emails),
    readTeam(env.DB, subject.keys),
    subject.slug ? env.DB.prepare("SELECT id, data, action, user_email, created_at FROM content_versions WHERE collection = 'partners' AND slug = ? ORDER BY id").bind(subject.slug).all()
      .then((r) => ({ state: 'ok', lines: partnerLines(r.results || [], subject.slug) })).catch((e) => (/no such table/i.test(String(e.message)) ? { state: 'ok', lines: [] } : { state: 'error', note: e.message, lines: [] })) : null,
    subject.slug ? readMakeovers(env.DB, subject.slug) : null,
  ]);
  const parts = Object.fromEntries(Object.entries({ mail, calendar, quo, kit, site, team: teamRows, partner: subject.slug ? { ...partner, lines: [...(partner?.lines || []), ...(makeovers?.lines || [])] } : null }).filter(([, p]) => p));
  const sources = Object.entries(parts).map(([key, p]) => ({
    key, label: SOURCES[key], state: p.state, note: p.note || null,
    errors: (p.errors || []).map((x) => ({ mailbox: x.mailbox, error: String(x.error).slice(0, 200) })),
    ...(key === 'mail' && p.missed ? { missed: p.missed } : {}),
  }));
  return {
    subject: { name: subject.name, kind: subject.kind, searched: { emails: look.emails, domains: look.domains, skipped: look.skipped, phones: quo?.phones || [] } },
    items: Object.values(parts).flatMap((p) => p.lines || []),
    kit: kit?.summary || null,
    sources,
    more: { mail: Object.keys(mail?.next || {}).length ? cursorOf(mail.next) : null, quo: quo?.next || null },
    local,
    checkedAt: iso(now),
  };
}

/** What a request searches with: the donor's addresses (less the team's), the team, and Gmail's words for it */
function lookOf(subject, people) {
  const found = searchable(subject, people);
  return { ...found, people, exact: new Set(found.emails), isTheirs: matcher(found, people), q: mailQuery(found), subject: { ...subject, contacts: found.contacts, phones: found.phones } };
}

const cursorOf = (pages) => btoa(JSON.stringify(pages)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function pagesOf(cursor) {
  try {
    const v = JSON.parse(atob(String(cursor || '').replace(/-/g, '+').replace(/_/g, '/')));
    const out = {};
    for (const [k, t] of Object.entries(v || {})) if (EMAIL.test(k) && /^[A-Za-z0-9_-]{1,200}$/.test(String(t))) out[normEmail(k)] = String(t);
    return out;
  } catch { return {}; }
}

/** Older email and calls (the cursors a timeline gave) → { items, more } */
export async function olderView(env, ref, { mail = null, quo = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const subject = await subjectOf(env, ref, { now });
  if (!subject) return null;
  const look = lookOf(subject, teamOf(await directory(env.DB)));
  if (look.team) return { items: [], more: { mail: null, quo: null } };
  const run = queue();
  const pages = mail ? pagesOf(mail) : null;
  const [m, q] = await Promise.all([
    pages && Object.keys(pages).length && look.q && env.GOOGLE_CALENDAR_KEY ? readMail(env, look, { fetchImpl, now, run, pages }) : { lines: [], next: {} },
    quo && /^[A-Za-z0-9_+/=-]{1,600}$/.test(quo) ? readQuo(env, look.subject, { fetchImpl, now, run, after: quo }) : { lines: [] },
  ]);
  return { items: [...m.lines, ...q.lines], more: { mail: Object.keys(m.next || {}).length ? cursorOf(m.next) : null, quo: q.next || null } };
}

// ─── Opening one thing in place ─────────────────────────────────────

async function lookFor(env, ref, now) {
  const subject = await subjectOf(env, ref, { now });
  if (!subject) throw fail(404, 'No donor by that link');
  const look = lookOf(subject, teamOf(await directory(env.DB)));
  if (look.team) throw fail(403, 'They’re on the team: their email isn’t shown here');
  return { subject, look };
}

/**
 * A conversation with the donor, opened from their timeline: every message in it, oldest first. Only a conversation
 * the donor is on opens (any one, otherwise, could be read through a donor's page); each opening is logged.
 */
export async function mailThread(env, ref, { mailbox, thread, me, now = Date.now(), fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(thread || ''))) throw fail(400, 'That isn’t a conversation');
  const { subject, look } = await lookFor(env, ref, now);
  const box = (await mailboxes(env)).find((b) => b.email === normEmail(mailbox));
  if (!box) throw fail(404, 'That mailbox isn’t one of SOARD’s active accounts now');
  const token = await accessToken(env, box.email, { fetchImpl, now, scope: GMAIL_READ_SCOPE });
  const t = await gmail(token, `/threads/${thread}?format=full`, fetchImpl);
  const messages = (t.messages || []).filter((m) => !(m.labelIds || []).some((l) => l === 'DRAFT' || l === 'SPAM' || l === 'TRASH'));
  const onIt = (m) => { const h = m.payload?.headers || []; return ['From', 'To', 'Cc', 'Bcc'].flatMap((x) => addressesIn(header(h, x))).some(look.isTheirs); };
  // Only the emails they're on: a forward between the team in the same conversation ("FYI…") stays the team's
  const theirs = messages.filter(onIt);
  if (!theirs.length) throw fail(403, `${subject.name} isn’t on that conversation`);
  const out = theirs.map((m) => {
    const h = m.payload?.headers || [];
    const fromAddr = addressesIn(header(h, 'From'))[0] || '';
    return {
      id: m.id, at: Number(m.internalDate) || 0, from: nameIn(header(h, 'From')), fromAddress: fromAddr, to: header(h, 'To'), cc: header(h, 'Cc'),
      subject: clean(header(h, 'Subject')), theirs: look.isTheirs(fromAddr), text: textOf(m.payload), files: filesOf(m.payload).filter((f) => !f.inline).map((f) => ({ name: f.name, size: f.size })),
    };
  });
  await logAudit(env.DB, { userEmail: me || 'unknown', action: 'viewed', entityType: 'mailbox', entitySlug: box.email, entityName: `opened “${(out[0]?.subject || '').slice(0, 100)}” on ${subject.name}’s timeline`, gitStatus: 'ok' });
  return { mailbox: { email: box.email, name: box.name }, thread, messages: out, hidden: messages.length - theirs.length };
}

/** A call's words: Quo's transcript, read when someone opens the call (only a call with the donor's number) */
export async function callTranscript(env, ref, { call, me = null, now = Date.now(), fetchImpl = fetch }) {
  if (!/^AC[A-Za-z0-9]{6,64}$/.test(String(call || ''))) throw fail(400, 'That isn’t a call');
  if (!quoConfigured(env)) throw fail(503, 'Quo isn’t connected');
  const { subject, look } = await lookFor(env, ref, now);
  const run = queue();
  // Their own numbers, never SOARD's (a number of SOARD's typed on their record would open every call)
  const { phones, dir, busy } = await theirPhones(env, look.subject, { fetchImpl, now, run });
  const c = await quoGet(env, `/calls/${call}`, fetchImpl).catch((e) => { throw /answered 404/.test(e.message) ? fail(404, 'Quo doesn’t have that call any more') : e; });
  const parts = (c?.data?.participants || []).map((p) => p?.phoneNumber || p);
  if (!phones.length || !parts.some((p) => phones.includes(p))) {
    // Zeffy too busy to say all their numbers: it may be theirs, so try again, never "not theirs"
    if (busy) throw fail(503, 'Zeffy is busy this minute, so their phone numbers can’t all be checked. Try again in a minute.');
    throw fail(403, `That call isn’t with ${subject.name}`);
  }
  // A call paused and picked up again has a transcript for each recording: all of them, in order
  const all = [];
  let after = '';
  for (let page = 0; page < 5; page++) {
    const t = await quoGet(env, `/calls/${call}/transcripts?${new URLSearchParams({ limit: '50', ...(after ? { after } : {}) })}`, fetchImpl);
    all.push(...(t?.data || []));
    after = t?.nextCursor || '';
    if (!after) break;
  }
  const done = all.filter((x) => x.status === 'completed');
  const status = done.length ? 'completed' : all[0]?.status || 'absent';
  const ours = new Set([...dir.numbers.values()].map((n) => n.number));
  const dialogue = done.flatMap((x) => x.dialogue || []).slice(0, 600).map((d) => {
    const theirs = !d.actorId && phones.includes(d.identifier);
    return {
      who: dir.users.get(d.actorId)?.name || (theirs ? subject.name : d.actorId || ours.has(d.identifier) ? 'SOARD' : 'Someone'),
      theirs, text: clean(d.content).slice(0, 2000), at: Number.isFinite(Number(d.start)) ? Number(d.start) : null,
    };
  });
  await logAudit(env.DB, { userEmail: me || 'unknown', action: 'viewed', entityType: 'mailbox', entitySlug: 'quo', entityName: `read a call’s words on ${subject.name}’s timeline`, gitStatus: 'ok' });
  return { status, dialogue };
}

/** An email the website sent them, as it looked: Resend keeps an email's words 30 days */
export async function sentEmail(env, ref, { id, now = Date.now(), fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(id || ''))) throw fail(400, 'That isn’t an email');
  const { subject, look } = await lookFor(env, ref, now);
  const row = await env.DB.prepare('SELECT id, to_addr, subject, sent_at FROM email_log WHERE id = ?').bind(id).first();
  if (!row || !look.emails.includes(normEmail(row.to_addr))) throw fail(404, `That email didn’t go to ${subject.name}`);
  if (!env.RESEND_API_KEY) throw fail(503, 'Resend isn’t connected');
  const res = await fetchImpl(`https://api.resend.com/emails/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) return { gone: true, why: 'The site’s Resend key can only send, so it can’t show an email it sent' };
  if (res.status === 404 || !body?.html) return { gone: true, why: 'Resend keeps an email’s words for 30 days, and this one is older' };
  if (!res.ok) throw fail(502, `Resend answered ${res.status}`);
  return { subject: row.subject, at: row.sent_at, html: String(body.html).slice(0, 400000) };
}
