/**
 * Room credits: who designed a room, and who paid for it (Peter, Nov 10 2026)
 * ===========================================================================
 * "It's not immediately apparent who the designer was, like Crosby Design
 * Group, or the monetary sponsor." Clareece works in JobTread, so that's
 * where she says it: two dropdowns on the job, **Designed By** and
 * **Monetary Sponsor**, whose choices are the companies in Partners spelled
 * as Partners spells them (never free text). Staff can say it in Admin →
 * Kids too, which writes the same JobTread field: one record, two doors.
 * A room with no JobTread job keeps its credits on its own record until it
 * gets one, and then they're written into the job.
 *
 * Each control does one thing (plan: ~/.claude/plans/room-credits.md, v3):
 *   - A credit changes the credit. Picking a company that isn't on the room
 *     (no logo of theirs on the page, nobody of theirs on the job) also puts
 *     it on, once, the way "Add to job" in Partners does: its logo on the
 *     page and its main contact on the job, without JobTread's email. A
 *     company a person took off before the pick goes back on (a pick is a
 *     person saying so); one taken off after it stays off. A sponsor's
 *     contacts all go on the job, each once (someone a person then takes off
 *     in JobTread stays off). Unpicking takes off the credit and nothing else.
 *   - Logos, job access and Take off this job change who's on the room, as
 *     they always have (./_vendor-access.js), and never change a credit. A
 *     credit whose company isn't on the room any more is shown, with a button
 *     each way.
 * So nothing here can loop with the logo and job-access syncs, undo what a
 * person did, or take off anyone it didn't put on.
 *
 * JobTread has no webhook for a field, so every linked job is read every 10
 * minutes. A change made there counts on the second look, at least 10
 * minutes later (a slip fixed at once does nothing); one made in the admin
 * counts at once. A job that can't be read, a field that's gone, or a value
 * list that comes back full changes nothing. Writing: the job's values are
 * read again just before, only the one change is made, and a write that
 * fails is finished by the next run before anything is compared.
 *
 * The kid's record keeps `designers` and `sponsors` (Partners slugs) as the
 * website's copy, for its pages and for Demo Day, written only here for a
 * room with a job. Tables: room_credit_jobs (record × kind → the job, what
 * its field said, a change waiting on its second look, a write still to
 * make), room_credit_grants (sponsor contacts put on a job, each once),
 * room_credit_state.
 */
import { SOARD_ORG_ID } from './_reveals.js';
import { pave, grantJobAccess } from './_jt-access.js';
import { fieldLists, jobFields, keepChoices, setJobValues, matchChoices, norm } from './_jt-fields.js';
import { FIELD_MONETARY_SPONSOR } from './_demo-invites.js';
import { loadAllKids, loadAllProjects, linkJobs, keyOf, saveRecord, requestDeploy, SYNC_USER } from './_kid-status.js';
import { readLinks, setLink, takeLock, freeLock, fetchAccess, ensureSchema as ensureLogoSchema } from './_kid-partners.js';
import { readContacts } from './_sponsors.js';
import { roleMode } from './_partner-roles.js';
import { logAudit } from './_audit.js';
import { generateSha } from './_collections.js';
import { nameKey, wordsKey, kidUsage, categoriesOf } from '../../public/admin/partners-shared.js';

export const KINDS = {
  designed: { key: 'designed', field: 'Designed By', record: 'designers', category: 'design', label: 'Designed by', what: 'design partner' },
  sponsored: { key: 'sponsored', field: 'Monetary Sponsor', record: 'sponsors', category: 'funding', label: 'Monetary sponsor', what: 'monetary sponsor' },
};
const KIND_LIST = Object.values(KINDS);
export const SECOND_LOOK_MS = 10 * 60 * 1000;
const RUN_EVERY_MS = 10 * 60 * 1000;
// A heartbeat's waitUntil gets about 30 s, and this runs after the logo check: well inside that, what's left is
// next run's (the other sweeps here budget 12 to 20 s)
const RUN_BUDGET_MS = 18 * 1000;
// Less time than this left in the heartbeat's window: the run waits for the next heartbeat
const MIN_RUN_MS = 8 * 1000;
// Kept back at the end of a run for its tail
const TAIL_MS = 3 * 1000;
// 100 jobs a page × VALUES_PER_JOB is well inside what JobTread takes in one query (the reveals read 100 × 50)
const PAGE = 100;
// Values asked for per job across both fields; a job that brings back this many may have more: it isn't read
export const VALUES_PER_JOB = 40;
const MAX_CONTACTS = 5;
// A change JobTread won't take: tried each run this many times, then once a day
const OWED_TRIES = 3;
const OWED_RETRY_MS = 24 * 60 * 60 * 1000;
const LOCK = 'room-credits';

const SCHEMA = [
  // seen: [{ v: value as JobTread spells it, p: partner slug | null }] as last settled; next / next_at: a change
  // waiting on its second look, and next_since: the read before it, when it wasn't there yet (so it was made after);
  // pending: { add: [names], remove: [names], rename: [[from, to]] } still to write; held: launch found JobTread and
  // the website disagreeing, a person settles it (the copy keeps the website's, with any change made since);
  // retry: [{ s: slug, r: past "already on the room?", at: when it was picked }] still to put on; older: names the
  // job held from before launch that weren't a company then (one later named a company is a question, not a credit)
  `CREATE TABLE IF NOT EXISTS room_credit_jobs (
    record TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT NOT NULL, seen TEXT, next TEXT, next_at TEXT, next_since TEXT,
    pending TEXT, held TEXT, read_at TEXT, updated_at TEXT, retry TEXT, older TEXT, PRIMARY KEY (record, kind))`,
  'CREATE TABLE IF NOT EXISTS room_credit_grants (job_id TEXT NOT NULL, email TEXT NOT NULL, partner TEXT, at TEXT, PRIMARY KEY (job_id, email))',
  'CREATE TABLE IF NOT EXISTS room_credit_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];
export async function ensureSchema(DB) {
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  // The lock this shares with the logo sync (kid_partner_lock) and its "Same as" links
  await ensureLogoSchema(DB);
}

const parse = (s, d) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const iso = (ms) => new Date(ms).toISOString();
const lower = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
// Written only when it isn't exactly what JobTread has ("Crosby Design" and "Crosby Design Group" are one company, two spellings)
const sameSpelling = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** One company's name, as the rest of the site reads names: "Randall Brothers, Inc." and "Randall Brothers", "Helen & Jimmy Carlos" and "Jimmy & Helen Carlos" */
export const sameCompany = (a, b) => (!!nameKey(a) && nameKey(a) === nameKey(b)) || (!!wordsKey(a) && wordsKey(a) === wordsKey(b));
const tableOf = (rec) => (rec.kind === 'community' ? 'community' : 'kids');

// ── Pure: names, changes, looks ──────────────────────────────────────

/**
 * The partner a field value names, and how: Partners by name ('name'), then a
 * "Same as" link a person made ('link', the one list used for logos too), then
 * the same words in another order ('words', as the rest of the site matches
 * names), then a name the partner had before it was renamed in Partners
 * ('former', from its history). A value last known as a partner since deleted
 * from Partners keeps that slug ('gone'), so its credit shows "(not in
 * Partners)" until a person takes it off. → { partner, how } | null
 */
export function matchOf(value, { partners, links = {}, former = {}, known = [] }) {
  const k = nameKey(value);
  if (!k) return null;
  const bySlug = (slug) => partners.find((p) => p.slug === slug);
  const exact = partners.find((p) => nameKey(p.name) === k);
  if (exact) return { partner: exact, how: 'name' };
  const linked = links[k] && bySlug(links[k]);
  if (linked) return { partner: linked, how: 'link' };
  // Only when it's one partner: two whose words are the same are a question for a person (Same as)
  const w = wordsKey(value);
  const byWords = w ? partners.filter((p) => wordsKey(p.name) === w) : [];
  if (byWords.length === 1) return { partner: byWords[0], how: 'words' };
  const was = former[k] && bySlug(former[k]);
  if (was) return { partner: was, how: 'former' };
  const gone = known.find((x) => nameKey(x.v) === k && x.p && !bySlug(x.p));
  if (gone) return { partner: { slug: gone.p, name: gone.v, gone: true }, how: 'gone' };
  return null;
}
/** What the site knows about names beyond Partners' own: the names partners had before a rename → { former } */
async function knownNames(DB, partners) {
  return { former: await readFormer(DB, partners) };
}
/** A missing table is "nothing there yet"; any other failed read is a failure, never read as "none" */
const missingTable = (e) => /no such table/i.test(String(e?.message || e));


/** The partner a field value names (see matchOf), or null: not a company we know */
export const partnerFor = (value, ctx) => matchOf(value, ctx)?.partner || null;

/**
 * Names partners had before being renamed in Partners, from their saved history: { [name key]: slug }. Only a name
 * one partner had, and no partner has now
 */
export async function readFormer(DB, partners) {
  let rows = [];
  try {
    rows = (await DB.prepare("SELECT slug, json_extract(data, '$.name') AS name FROM content_versions WHERE collection = 'partners' GROUP BY slug, json_extract(data, '$.name')").all()).results || [];
  } catch (e) {
    // No history yet: no former names. Any other failure stops the run (read as none, credits would leave pages)
    if (missingTable(e)) return {};
    throw e;
  }
  const now = new Set(partners.map((p) => nameKey(p.name)));
  const slugs = new Set(partners.map((p) => p.slug));
  const by = {};
  for (const r of rows) {
    const k = nameKey(r.name || '');
    if (!k || now.has(k) || !slugs.has(r.slug)) continue;
    (by[k] ||= new Set()).add(r.slug);
  }
  return Object.fromEntries(Object.entries(by).filter(([, v]) => v.size === 1).map(([k, v]) => [k, [...v][0]]));
}

/**
 * A field's values, with the partner each names: [{ v, p }]. A value the site already knows (ctx.known: the same
 * name) keeps what it was matched to, a partner or none: a "Same as" link made or changed since is a change in what
 * the site knows, made by remap() alone, on its own terms, never read as JobTread's values changing (a pick)
 */
// h: how it was matched (see matchOf), kept so remap() knows a person's link from a name's own match
export const named = (values, ctx) => values.map((v) => {
  const k = nameKey(v);
  const known = (ctx.known || []).filter((x) => k && nameKey(x.v) === k);
  const was = known.find((x) => x.p) || known[0];
  if (was) return was.p ? { v, p: was.p, ...(was.h ? { h: was.h } : {}) } : { v, p: null };
  const m = matchOf(v, ctx);
  return m ? { v, p: m.partner.slug, h: m.how } : { v, p: null };
});
/** A value list as a set: by partner when known, else by name */
const listKey = (xs) => xs.map((x) => (x.p ? `p:${x.p}` : `v:${nameKey(x.v)}`)).sort().join('|');

/** The partners a change still owed to JobTread adds, by the names it adds them under: [{ v, p }] */
const owedKnown = (pending) => [...(pending?.add || []), ...(pending?.rename || []).map(([, to]) => to)].map((v) => ({ v, p: pending.slugs?.[nameKey(v)] || null })).filter((x) => x.p);
/** What the site means a field to hold: what it saw, with any change still owed to JobTread made to it */
export const meantOf = (row, ctx) => (row.pending ? named(applyChange(row.seen.map((x) => x.v), row.pending), { ...ctx, known: [...row.seen, ...owedKnown(row.pending)] }) : row.seen);

/**
 * A row after what the site knows about names changed (Same as made or changed, Add to Partners, a partner
 * renamed): each value the job holds, unchanged in JobTread, is matched again, and a change waiting on its second
 * look with it. That's knowing more about what she picked, never a pick: nobody is put on the room. A company a value
 * stops naming leaves the credits (unless another value still names it); one it names now joins them. A name the
 * job held from before launch (or a room with a question open) is launch's, though: a company it turns out to name
 * that the website didn't have is a question for a person, never a credit by itself
 */
// A value matched by its own name, its words or a former name stays that partner while the partner is in Partners,
// whatever comes along later (a history pruned, a new partner with the same words): only a person's link (made,
// changed or taken away) moves it, or the partner leaving Partners
export function remap(row, ctx) {
  const decide = (x) => {
    const m = matchOf(x.v, { ...ctx, known: [x] });
    const fresh = m ? { v: x.v, p: m.partner.slug, h: m.how } : { v: x.v, p: null };
    if (!x.p) return fresh;
    if (x.h === 'link' || m?.how === 'link') return fresh;
    return ctx.partners.some((p) => p.slug === x.p) ? x : fresh;
  };
  const seen = row.seen.map(decide);
  const next = row.next ? row.next.map(decide) : row.next;
  const moved = seen.map((x, i) => ({ v: x.v, from: row.seen[i].p, to: x.p })).filter((m) => m.from !== m.to);
  if (!moved.length) return { ...row, next };
  const older = row.older || [];
  // The website's answer before this: the question's, else the companies the field named, less those named only by
  // a value now matched to someone else
  const gone = moved.map((m) => m.from).filter((f) => f && !seen.some((x) => x.p === f));
  const website = row.held ? row.held.website : copyOf(meantOf(row, ctx)).filter((s) => !gone.includes(s));
  const asks = moved.filter((m) => m.to && (row.held || older.includes(nameKey(m.v))) && !website.includes(m.to)).map((m) => m.to);
  let held = row.held ? { ...row.held, jobtread: [...new Set([...row.held.jobtread.filter((s) => seen.some((x) => x.p === s)), ...asks])] } : asks.length ? { jobtread: [...new Set(asks)], website, dismissed: [] } : null;
  if (held && !held.jobtread.length) held = null;
  return { ...row, seen, next, held, older: older.filter((k) => !moved.some((m) => m.to && nameKey(m.v) === k)) };
}
/**
 * A row once the change it owed JobTread is there (written, or made in JobTread by a person): what was seen and a
 * change of hers waiting on its second look both have it, and nothing is owed
 */
function owedLanded(row, ctx) {
  const seen = meantOf(row, ctx);
  const waiting = row.next ? named(applyChange(row.next.map((x) => x.v), row.pending), { ...ctx, known: [...row.next, ...owedKnown(row.pending)] }) : null;
  const still = waiting && listKey(waiting) !== listKey(seen) ? waiting : null;
  return { ...row, seen, next: still, nextAt: still ? row.nextAt : null, nextSince: still ? row.nextSince : null, pending: null };
}
/** The parts of a row that are stored, to write it only when one changed */
const rowSig = (r) => JSON.stringify([r.jobId, r.seen, r.next, r.nextAt, r.next ? r.nextSince || null : null, r.pending, r.held, r.retry || [], r.older || []]);

/** What changed between two value lists, by partner when known, else by name: { added: [{ v, p }], removed: [{ v, p }] } */
export function diff(before, after) {
  const id = (x) => (x.p ? `p:${x.p}` : `v:${nameKey(x.v)}`);
  const was = new Set(before.map(id));
  const now = new Set(after.map(id));
  return { added: after.filter((x) => !was.has(id(x))), removed: before.filter((x) => !now.has(id(x))) };
}

/**
 * One job field against its last look → { settled: [{ v, p }] | null (no change to apply), since, row }.
 * current: [{ v, p }] or null when it couldn't be read (nothing changes).
 * A change counts when it's the same on two looks at least SECOND_LOOK_MS apart. since: when it was made by
 * at the earliest (the read before it was first seen, when it wasn't there yet), null when that isn't known
 */
export function look(row, current, at) {
  const seen = row.seen || [];
  if (!current) return { settled: null, since: null, row };
  const key = listKey;
  if (key(current) === key(seen)) {
    // Spelling only (a rename in JobTread, or ours landing): remembered, nothing to apply
    return { settled: null, since: null, row: { ...row, seen: current, next: null, nextAt: null, nextSince: null } };
  }
  if (row.next && key(row.next) === key(current)) {
    if (Date.parse(at) - Date.parse(row.nextAt) >= SECOND_LOOK_MS) return { settled: current, since: row.nextSince || null, row: { ...row, seen: current, next: null, nextAt: null, nextSince: null } };
    return { settled: null, since: null, row };
  }
  return { settled: null, since: null, row: { ...row, next: current, nextAt: at, nextSince: row.readAt || null } };
}

/**
 * A question launch left open (JobTread named companies the website didn't have), after a change a person made
 * since, in JobTread or here: what they picked joins the website's answer, what they took off leaves both, and a
 * question with nothing left to ask is closed (null). d: { added: [{ p }], removed: [{ p }] }
 */
export function heldAfter(held, { added = [], removed = [] } = {}) {
  if (!held) return null;
  const add = added.map((x) => x.p).filter(Boolean);
  const gone = removed.map((x) => x.p).filter(Boolean);
  const website = [...new Set([...held.website.filter((s) => !gone.includes(s)), ...add])];
  const jobtread = held.jobtread.filter((s) => !gone.includes(s) && !add.includes(s));
  return jobtread.length ? { ...held, website, jobtread, dismissed: (held.dismissed || []).filter((s) => jobtread.includes(s)) } : null;
}

/** A value list with one change made: add, remove (by partner or name), rename [from, to] */
export function applyChange(values, { add = [], remove = [], rename = [] } = {}) {
  let out = [...values];
  for (const [from, to] of rename) out = out.map((v) => (nameKey(v) === nameKey(from) ? to : v));
  out = out.filter((v) => !remove.some((r) => sameCompany(r, v)));
  for (const a of add) if (!out.some((v) => sameCompany(v, a))) out.push(a);
  return out.filter((v, i) => out.findIndex((x) => sameCompany(x, v)) === i);
}

/** The choices a field should offer: its category in Partners, and every company credited anywhere, A to Z */
export function wantedChoices(kind, partners, credited = []) {
  const names = new Set();
  for (const p of partners) if (categoriesOf(p).includes(kind.category) || credited.includes(p.slug)) names.add(p.name);
  return [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/** The website's copy for one kind: the partners its settled values name, in order */
export const copyOf = (seen) => [...new Set((seen || []).map((x) => x.p).filter(Boolean))];

/**
 * The copy to save: JobTread's (copy), and any credit the record has for a company no longer in Partners, which
 * stays, shown "(not in Partners)", until a person takes it off (drop: the one being taken off now)
 */
export const keepGone = (copy, partners, drop = null) => (list) => [
  ...copy, ...list.filter((s) => s !== drop && !copy.includes(s) && !partners.some((p) => p.slug === s)),
];

/**
 * Is this company on the room: a logo of theirs on the page, or anyone of
 * theirs on the job (its JobTread account, a contact's email, its website's
 * domain). aces: the job's access list, or null when there's no open job.
 */
export function onRoom(partner, rec, { partners, aces = null, contacts = [], account = null, links = {} }) {
  return logoOnPage(partner, rec, partners) || onJob(partner, aces, { contacts, account, links });
}
/** A logo of theirs on the page (their file, upload folder, or name) */
export function logoOnPage(partner, rec, partners) {
  const usage = kidUsage([{ ...rec.data, slug: '_', publishStatus: 'published' }], partners).byPartner;
  if (usage.get(partner.slug)?.length) return true;
  return (rec.data?.partnerLogos || []).some((l) => nameKey(l?.name) && nameKey(l.name) === nameKey(partner.name));
}
/** Anyone of theirs on the job: its JobTread account or a linked name, a contact's email, its website's domain */
export function onJob(partner, aces, { contacts = [], account = null, links = {} } = {}) {
  if (!aces) return false;
  const emails = new Set(contacts.map((c) => lower(c.email)).filter(Boolean));
  const site = partner.website ? String(partner.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
  return (aces.nodes || []).some((a) => {
    const m = a?.membership;
    if (!m || m.isInternal) return false;
    if (account && m.account?.id === account) return true;
    const an = nameKey(m.account?.name || '');
    if (an && (an === nameKey(partner.name) || links[an] === partner.slug)) return true;
    const email = lower(m.user?.emailAddress);
    if (email && emails.has(email)) return true;
    return !!site && !!email && (email.endsWith(`@${site}`) || email.endsWith(`.${site}`));
  });
}

// ── D1 ───────────────────────────────────────────────────────────────

const rowOf = (r) => r && ({
  record: r.record, kind: r.kind, jobId: r.job_id, seen: parse(r.seen, []), next: parse(r.next, null), nextAt: r.next_at || null, nextSince: r.next_since || null,
  pending: parse(r.pending, null), held: parse(r.held, null), readAt: r.read_at || null, retry: parse(r.retry, []), older: parse(r.older, []),
});
export async function readJobRows(DB) {
  await ensureSchema(DB);
  const rows = (await DB.prepare('SELECT * FROM room_credit_jobs').all()).results || [];
  return new Map(rows.map((r) => [`${r.record} ${r.kind}`, rowOf(r)]));
}
async function writeJobRow(DB, row, at) {
  await DB.prepare('INSERT OR REPLACE INTO room_credit_jobs (record, kind, job_id, seen, next, next_at, next_since, pending, held, read_at, updated_at, retry, older) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.record, row.kind, row.jobId, JSON.stringify(row.seen || []), row.next ? JSON.stringify(row.next) : null, row.nextAt || null, row.next ? row.nextSince || null : null,
      row.pending ? JSON.stringify(row.pending) : null, row.held ? JSON.stringify(row.held) : null, row.readAt || null, at, row.retry?.length ? JSON.stringify(row.retry) : null,
      row.older?.length ? JSON.stringify(row.older) : null).run();
}
async function readState(DB, key, d = {}) {
  const r = await DB.prepare('SELECT value FROM room_credit_state WHERE key = ?').bind(key).first();
  return parse(r?.value, d);
}
async function writeState(DB, key, value) {
  await DB.prepare('INSERT OR REPLACE INTO room_credit_state (key, value) VALUES (?, ?)').bind(key, JSON.stringify(value)).run();
}
async function readPartners(DB) {
  const rows = (await DB.prepare('SELECT slug, data FROM partners').all()).results || [];
  return rows.map((r) => { const d = parse(r.data, {}); return { slug: r.slug, name: d.name || r.slug, logo: d.logo || '', website: d.website || '', level: d.level || 'friend', category: d.category, logoFolders: d.logoFolders }; });
}
/** Each partner's JobTread vendor account, as the vendor sync paired them: Map(slug → account id) */
async function readAccounts(DB) {
  try {
    const rows = (await DB.prepare('SELECT partner, account_id FROM vendor_accounts').all()).results || [];
    return new Map(rows.map((r) => [r.partner, r.account_id]));
  } catch (e) {
    // No table: nobody paired yet. Any other failure stops the work (read as none, a company on the job would read as off it)
    if (missingTable(e)) return new Map();
    throw e;
  }
}
/** Has this job been given this email for a sponsor already (so a person's removal stands)? */
async function granted(DB, jobId) {
  const rows = (await DB.prepare('SELECT email FROM room_credit_grants WHERE job_id = ?').bind(jobId).all()).results || [];
  return new Set(rows.map((r) => lower(r.email)));
}

// ── JobTread reads ───────────────────────────────────────────────────

/**
 * Every SOARD job with the two fields' values → [{ id, name, closedOn, values: { designed, sponsored } | null }].
 * values null: this job's list came back full, so it may be cut short and isn't read this time.
 */
export async function fetchCreditJobs(grantKey, ids, { fetchImpl = fetch } = {}) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < 40; i++) {
    const body = await pave(grantKey, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: {
          $: { size: PAGE, ...(page ? { page } : {}) }, nextPage: {},
          nodes: {
            id: {}, name: {}, closedOn: {}, createdAt: {},
            customFieldValues: { $: { size: VALUES_PER_JOB, where: [['customField', 'id'], 'in', [ids.designed, ids.sponsored]] }, nodes: { value: {}, customField: { id: {} } } },
          },
        },
      },
    }, fetchImpl);
    const conn = body?.organization?.jobs;
    if (!conn) throw new Error('JobTread sent no jobs');
    for (const j of conn.nodes || []) {
      const nodes = j.customFieldValues?.nodes || [];
      const lists = fieldLists(nodes);
      jobs.push({ id: j.id, name: j.name, closedOn: j.closedOn || null, createdAt: j.createdAt || null, values: nodes.length >= VALUES_PER_JOB ? null : { designed: names(lists[ids.designed]), sponsored: names(lists[ids.sponsored]) } });
    }
    page = conn.nextPage || null;
    if (!page) break;
  }
  // Not every job read is not "the rest have no job": stop rather than unlink rooms
  if (page) throw new Error('JobTread has more jobs than the site reads in one run');
  return jobs;
}

/** One job's two fields now (before a write) → { designed: [names], sponsored: [names] } */
async function readJobValues(grantKey, jobId, ids, fetchImpl) {
  const body = await pave(grantKey, {
    job: { $: { id: jobId }, id: {}, closedOn: {}, createdAt: {}, customFieldValues: { $: { size: VALUES_PER_JOB, where: [['customField', 'id'], 'in', [ids.designed, ids.sponsored]] }, nodes: { value: {}, customField: { id: {} } } } },
  }, fetchImpl);
  if (!body?.job?.id) throw Object.assign(new Error('JobTread has no such job'), { gone: true });
  const nodes = body.job.customFieldValues?.nodes || [];
  if (nodes.length >= VALUES_PER_JOB) throw new Error('JobTread sent a value list that may be cut short');
  const lists = fieldLists(nodes);
  return { designed: names(lists[ids.designed]), sponsored: names(lists[ids.sponsored]), closedOn: body.job.closedOn || null, createdAt: body.job.createdAt || null };
}
/** A dropdown's values as choice names */
const names = (list) => [...new Set((list || []).map((x) => String(x).trim()).filter(Boolean))];

/**
 * The two fields' ids. Designed By is made the first time only, and its id kept: a Designed By deleted or
 * made again in JobTread later stops every run (an empty new field read as "nobody designed anything" would
 * take every designer off), and Automations says so. Monetary Sponsor must be the one the invites read
 */
export async function creditFields(env, { fetchImpl = fetch } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const known = await readState(DB, 'field-designed', null);
  const f = await jobFields(env.JOBTREAD_GRANT_KEY, [
    { key: 'designed', name: KINDS.designed.field, multiple: true, make: !known },
    // Never made by the site: if it's gone, the run stops and says so (a new one wouldn't be the field the invites read)
    { key: 'sponsored', name: KINDS.sponsored.field, multiple: true, make: false },
  ], { fetchImpl, make: true });
  // Each with a code Automations words for itself (it never shows a run's own error text)
  const stop = (code, message) => Object.assign(new Error(message), { code });
  if (!f.sponsored || f.sponsored.id !== FIELD_MONETARY_SPONSOR) throw stop('sponsor-field', 'JobTread’s Monetary Sponsor field isn’t the one the site knows: it may have been deleted or made again');
  if (!f.designed) throw stop('designed-gone', 'JobTread’s Designed By field is gone, so the site stopped rather than take every designer off. Undo the delete in JobTread, or ask for help.');
  if (known && f.designed.id !== known.id) throw stop('designed-remade', 'JobTread’s Designed By field was made again, so the site stopped rather than read it as empty. Ask for help moving the credits to it.');
  if (!known) await writeState(DB, 'field-designed', { id: f.designed.id, at: new Date().toISOString() });
  return { designed: f.designed.id, sponsored: f.sponsored.id, fields: f };
}

// ── Writing a job's field: read now, one change, write, remember ─────

/**
 * Makes one change to a room's job field. Records it as pending first, so a
 * write that dies is finished by the next run, and never read as a person's
 * change. → the values JobTread now has.
 */
async function writeChange(env, row, change, ids, { fetchImpl, at, ctx }) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  const pending = mergePending(row.pending, change);
  await writeJobRow(DB, { ...row, pending }, at);
  // Every name the job is to hold has to be one of the field's choices (one a person deleted in JobTread Settings
  // while a job still holds it would make the whole write fail), and is written the way the choice is spelled
  // ("crosby design group" typed by a person is the same choice as Partners' "Crosby Design Group")
  const now = await readJobValues(key, row.jobId, ids, fetchImpl);
  const before = now[row.kind];
  // An add still owed is written under its partner's name as it is now (renamed in Partners since: the new name)
  const slugOf = (n) => pending.slugs?.[nameKey(n)] || null;
  const owedNow = owedNames(pending, ctx);
  const r = await keepChoices(key, ids[row.kind], { wanted: applyChange(before, owedNow) }, { fetchImpl });
  if (r.added.length) await noteChoices(DB, row.kind, r);
  const options = r.next || r.have;
  const spell = (n) => matchChoices([n], options)[0] || n;
  const write = { ...owedNow, add: owedNow.add.map(spell), rename: owedNow.rename.map(([from, to]) => [from, spell(to)]) };
  const after = applyChange(before, write);
  if (!sameSpelling(before, after)) await setJobValues(key, row.jobId, { [ids[row.kind]]: after }, { fetchImpl });
  // What the site knows is what it saw before plus its own change, never the whole list it just read: a pick
  // Clareece made in JobTread since then is still hers, and still counts on its second look. Each add names the
  // partner it was made for
  const adds = [...pending.add.map((n, i) => ({ v: write.add[i], p: slugOf(n) })), ...pending.rename.map(([, to], i) => ({ v: write.rename[i][1], p: slugOf(to) }))].filter((x) => x.p);
  const seen = named(applyChange((row.seen || []).map((x) => x.v), write), { ...ctx, known: [...row.seen, ...adds] });
  // A change of hers already waiting on its second look keeps waiting, with this change made to it, and keeps when
  // it was made by. Writing the field isn't a look at it, so the room's last look stays as it was
  const waiting = row.next ? named(applyChange(row.next.map((x) => x.v), write), { ...ctx, known: [...row.next, ...adds] }) : null;
  const still = waiting && listKey(waiting) !== listKey(seen) ? waiting : null;
  const next = { ...row, seen, next: still, nextAt: still ? row.nextAt : null, nextSince: still ? row.nextSince : null, pending: null };
  await writeJobRow(DB, next, at);
  // What JobTread holds now (read just before, with this change made): a fresher look than a read from before it
  return { ...next, _now: after };
}
// slugs: { [name key]: partner slug } for each add, so an add still owed names its partner even if the partner is
// renamed in Partners before JobTread takes it (it's then written under the new name)
/** A change owed to JobTread with each add or respelling under its partner's name as it is now */
function owedNames(pending, ctx) {
  const nameNow = (n) => (ctx.partners || []).find((x) => x.slug === pending.slugs?.[nameKey(n)])?.name || n;
  return { ...pending, add: (pending.add || []).map(nameNow), remove: pending.remove || [], rename: (pending.rename || []).map(([from, to]) => [from, nameNow(to)]) };
}
/** The dropdown choices the site added, so only those can ever go (a person's own never do) */
async function noteChoices(DB, kindKey, { added = [], dropped = [] }) {
  const list = await readState(DB, `choices-added:${kindKey}`, []);
  const next = [...new Set([...list, ...added])].filter((n) => !dropped.some((d) => norm(d) === norm(n)));
  await writeState(DB, `choices-added:${kindKey}`, next);
}
function mergePending(a, b) {
  const out = { add: [...(a?.add || [])], remove: [...(a?.remove || [])], rename: [...(a?.rename || [])], slugs: { ...(a?.slugs || {}), ...(b?.slugs || {}) } };
  for (const x of b?.add || []) { out.remove = out.remove.filter((r) => !sameCompany(r, x)); if (!out.add.some((y) => sameCompany(y, x))) out.add.push(x); }
  for (const x of b?.remove || []) { out.add = out.add.filter((r) => !sameCompany(r, x)); if (!out.remove.some((y) => sameCompany(y, x))) out.remove.push(x); }
  out.rename.push(...(b?.rename || []));
  return out;
}

// ── Putting a picked company on the room ─────────────────────────────

/**
 * A pick of a company that isn't on the room puts it on once, the way "Add to
 * job" does; a sponsor's contacts each go on the job once. → { logo, people: [names], waiting }
 */
// The steps "Add to job" takes, and the roles; tests stand in for the page and the vendor sync with their own
const realDeps = {
  pageLogosOn: async (...a) => (await import('./partners-batch.js')).pageLogosOn(...a),
  addToJob: async (...a) => (await import('./_vendor-access.js')).addToJob(...a),
  roleMode,
};
// resume: a put-on that failed part way (the logo on, the job not): what's missing is done now
// decided: told once it's settled that they're not on the room, before anything is put on (so a run cut off part
// way is finished next run, not asked again)
// pickedAt: when the pick was made (at the earliest); person: a person putting them back (Add them back, the Advisory
// Board's Pick the kid), whatever came before
export async function putOnRoom(env, rec, partner, kind, { job, ctx, fetchImpl, now, by = SYNC_USER, deps = realDeps, person = false, resume = false, decided = null, pickedAt = null }) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  const out = { logo: false, people: [], waiting: false, off: false };
  const open = job && !job.closedOn;
  // A finished room, or one with no job: the credit is the credit, and nobody is put on anything
  if (!open) return out;
  // A company a person took off this job, and a pick of it: a pick is a person saying so, and the later of the two
  // stands. Picked after they came off, they go back on (Add to job brings back who came off); taken off after the
  // pick was made (or when that can't be told), they stay off, and the card says so with a way back
  if (!person) {
    const off = await offSince(DB, job.id, partner.slug);
    if (off && !(pickedAt && off.at && Date.parse(off.at) < Date.parse(pickedAt))) { out.off = true; return out; }
  }
  const contacts = ctx.contacts[partner.slug] || [];
  const aces = (await fetchAccess(key, [job.id], fetchImpl)).get(job.id);
  const page = logoOnPage(partner, rec, ctx.partners);
  const there = onJob(partner, aces, { contacts, links: ctx.links, account: ctx.accounts?.get?.(partner.slug) || null });
  // Already on the room: a pick puts nobody on, so an Undo of it takes nobody off. A put-on finishing (resume),
  // or a person putting them back, goes on to whatever part is still missing
  if (!resume && !person && (page || there)) return out;
  // Past the "already on?" question: a failure from here is finished next run (resume), not asked again
  if (decided) await decided();
  try {
  if (!(page && there)) {
    if (partner.logo) {
      // The page first, then the job: exactly what a person adding the logo and pressing Add to job does
      if (!page) {
        if (!(await takeLock(DB, true, 'sync'))) throw new Error('That page is busy');
        try { await deps.pageLogosOn(env, { table: tableOf(rec), slug: rec.slug, logos: [{ url: partner.logo, name: partner.name, at: 0 }] }, by); out.logo = true; out.logoUrl = partner.logo; } finally { await freeLock(DB, 'sync'); }
      }
      if (!there) {
        const r = await deps.addToJob(env, { record: keyOf(rec), logos: [{ url: partner.logo, name: partner.name }] }, by, { fetchImpl, now });
        out.people.push(...(r.added || []));
        out.waiting = !!(r.waiting || []).length;
      }
    } else if (!there) {
      // No logo yet: their main contact goes on, and the logo sync asks Linzi for one (./_kid-partners.js)
      const c = contacts.find((x) => isEmail(x.email));
      if (c) {
        const mode = await deps.roleMode(env, { fetchImpl });
        await grantJobAccess(env, job.id, { name: c.name || partner.name, email: c.email }, mode.partner(partner), { notify: false, fetchImpl, now });
        await DB.prepare('INSERT OR IGNORE INTO room_credit_grants (job_id, email, partner, at) VALUES (?, ?, ?, ?)').bind(job.id, lower(c.email), partner.slug, iso(now)).run();
        out.people.push(c.name || c.email);
      } else out.waiting = true;
    }
  }
  // A sponsor put on: each of its contacts with an email too, once, so Demo Day and reveal invites reach them (a
  // person putting them back means all of them, even one taken off before)
  if (kind.key === 'sponsored') out.people.push(...(await sponsorContactsOn(env, job, partner, contacts, { fetchImpl, now, deps, again: person })));
  } catch (e) { e.decided = true; e.done = { ...out, people: [...out.people] }; throw e; }
  return out;
}

/** Did a person take this company off this job (Take off this job, the X on its logo, or in JobTread), and it's still off? */
export async function takenOff(DB, jobId, slug) {
  return !!(await offSince(DB, jobId, slug));
}
/**
 * The same, with when: → { at } (the last time that row changed, so never earlier than the take-off) | null when
 * they aren't off
 */
async function offSince(DB, jobId, slug) {
  try {
    const r = await DB.prepare('SELECT off, updated_at FROM vendor_job_seen WHERE job_id = ? AND who = ?').bind(jobId, `p:${slug}`).first();
    return r?.off ? { at: r.updated_at || null } : null;
  } catch (e) {
    // No table: nobody was ever taken off. Any other failure stops the put-on (it's tried again next run), never
    // read as "nobody was taken off"
    if (missingTable(e)) return null;
    throw e;
  }
}

/** Each of a sponsor's contacts on the job, once ever per job (someone a person took off stays off) → [names] */
async function sponsorContactsOn(env, job, partner, contacts, { fetchImpl, now, deps = realDeps, again = false }) {
  const { DB } = env;
  const done = await granted(DB, job.id);
  const aces = (await fetchAccess(env.JOBTREAD_GRANT_KEY, [job.id], fetchImpl)).get(job.id);
  const on = new Set((aces?.nodes || []).map((a) => lower(a?.membership?.user?.emailAddress)).filter(Boolean));
  const out = [];
  let mode = null;
  for (const c of contacts.filter((x) => isEmail(x.email)).slice(0, MAX_CONTACTS)) {
    const e = lower(c.email);
    if (done.has(e) && !again) continue;
    if (!on.has(e)) {
      mode ||= await deps.roleMode(env, { fetchImpl });
      await grantJobAccess(env, job.id, { name: c.name || partner.name, email: c.email }, mode.sponsor(partner), { notify: false, fetchImpl, now });
      out.push(c.name || c.email);
    }
    // Remembered either way: someone already on, then taken off by a person, isn't put back by this
    await DB.prepare('INSERT OR IGNORE INTO room_credit_grants (job_id, email, partner, at) VALUES (?, ?, ?, ?)').bind(job.id, e, partner.slug, iso(now)).run();
  }
  return out;
}

/**
 * Contacts saved for a partner in Partners: on each open job of a room it
 * sponsors, the ones just added go on, once (emails: those). A contact a person
 * took off a job in JobTread isn't one of them, so stays off.
 * → { granted: [{ record, kid: the page's name, name }], problems }
 */
export async function grantForSponsor(env, slug, { emails = [], fetchImpl = fetch, now = Date.now(), deps = realDeps } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const out = { granted: [], problems: [] };
  if (!env.JOBTREAD_GRANT_KEY) return out;
  const added = new Set(emails.map(lower).filter(isEmail));
  if (!added.size) return out;
  const [rows, partners, contacts, kids, projects] = await Promise.all([readJobRows(DB), readPartners(DB), readContacts(DB, [slug]), loadAllKids(DB), loadAllProjects(DB)]);
  const pageName = new Map([...kids, ...projects].map((r) => [keyOf(r), r.data?.name || r.slug]));
  const partner = partners.find((p) => p.slug === slug);
  if (!partner) return out;
  const fresh = (contacts[slug] || []).filter((c) => added.has(lower(c.email)));
  for (const row of rows.values()) {
    // The website's copy: while launch's question is open, the website's answer (a sponsor staff took off isn't one)
    const copy = row.held ? row.held.website : copyOf(row.seen);
    if (row.kind !== 'sponsored' || !copy.includes(slug)) continue;
    try {
      const job = { id: row.jobId, closedOn: (await readJobValues(env.JOBTREAD_GRANT_KEY, row.jobId, await creditIds(env, fetchImpl), fetchImpl)).closedOn };
      if (job.closedOn || (await takenOff(DB, job.id, slug))) continue;
      const names = await sponsorContactsOn(env, job, partner, fresh, { fetchImpl, now, deps });
      out.granted.push(...names.map((name) => ({ record: row.record, kid: pageName.get(row.record) || row.record, name })));
    } catch (e) { out.problems.push(`${row.record}: ${e.message}`); }
  }
  return out;
}
/** The fields' ids, read fresh each time (a field remade in JobTread must stop a write, not take an old id) */
async function creditIds(env, fetchImpl) {
  const f = await creditFields(env, { fetchImpl });
  return { designed: f.designed, sponsored: f.sponsored };
}

// ── The website's copy ───────────────────────────────────────────────

/**
 * Puts the copy on the record when it changed → true if saved. The record is read again under the page
 * lock and only this field changes, so a logo a pick just put on, a save in the admin or a status from
 * JobTread made since this run began is kept
 */
// slugs: the list, or a function of the list as the record has it now (a change made to it, never a stale copy).
// The record's order is kept (its pages show credits in it): a company still credited keeps its place, a new one
// goes at the end, so JobTread listing the same companies another way round changes nothing
const inOrder = (was, want) => [...was.filter((s) => want.includes(s)), ...want.filter((s) => !was.includes(s))];
// exact: the list as given (a merge puts the new company where the old one was), not re-ordered; by: a person's change
// says who (the sweep's own saves are the sync's)
async function saveCopy(env, rec, kindKey, slugs, at, why, { exact = false, by = SYNC_USER } = {}) {
  const { DB } = env;
  const field = KINDS[kindKey].record;
  const table = tableOf(rec);
  const order = exact ? (was, want) => want : inOrder;
  // Already so on the record as this run read it: nothing to write, and no lock taken (most rooms, most runs)
  const known = Array.isArray(rec.data?.[field]) ? rec.data[field] : [];
  const want = order(known, typeof slugs === 'function' ? slugs(known) : slugs);
  if (known.length === want.length && known.every((s, i) => s === want[i])) return false;
  if (!(await takeLock(DB, true, 'sync'))) throw new Error('That page is busy');
  try {
    // Written only if the record is still as read: a person's Save landing in between wins, and this reads again
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = (await DB.prepare(`SELECT data FROM ${table} WHERE slug = ?`).bind(rec.slug).first())?.data;
      if (!raw) return false;
      const now = parse(raw, {});
      rec.data = now;
      const was = Array.isArray(now[field]) ? now[field] : [];
      const next = order(was, typeof slugs === 'function' ? slugs(was) : slugs);
      if (was.length === next.length && was.every((s, i) => s === next[i])) return false;
      const after = { ...now, [field]: next };
      if (await saveRecord(env, table, rec.slug, now, after, why, at, { expect: raw, by })) { rec.data = after; return true; }
    }
    throw new Error('That page kept changing while its credits were being saved. It’s tried again next run.');
  } finally { await freeLock(DB, 'sync'); }
}

// ── The sweep ────────────────────────────────────────────────────────

/**
 * Every linked job's two fields against the last look; settled changes go to
 * the copy, picks of companies not on the room put them on, writes still owed
 * are finished, and the dropdowns keep Partners' names.
 * → { changed: [{ record, kind, added, removed }], put: [...], unknown, held, problems }
 */
// budget: the run's time for JobTread and D1 work (tests shorten it); deadline: when the heartbeat's time is up (the
// logo check runs first in the same window), so a run never outlasts it
export async function syncCredits(env, { fetchImpl = fetch, now = Date.now(), deps = realDeps, budget = RUN_BUDGET_MS, deadline = null } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  const at = iso(now);
  const started = Date.now();
  const stopAt = Math.min(started + budget, deadline ?? Infinity);
  // A room isn't started without time to finish it and the run's tail (the dropdowns, the state)
  const roomStop = stopAt - Math.min(TAIL_MS, (stopAt - started) / 4);
  const report = { changed: [], put: [], wrote: [], unknown: [], held: [], problems: [], more: false };
  if (!DB || !key) return report;
  await ensureSchema(DB);
  if (!(await takeLock(DB, false, LOCK))) return { ...report, busy: true };
  try {
    const ids = await creditFields(env, { fetchImpl });
    const [jobs, kids, projects, partners, links, contacts, rows, launched, notCompanies] = await Promise.all([
      fetchCreditJobs(key, ids, { fetchImpl }), loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readLinks(DB), readContacts(DB), readJobRows(DB), readState(DB, 'launched', null), readState(DB, 'not-companies', []),
    ]);
    const records = [...kids, ...projects];
    const byKey = new Map(records.map((r) => [keyOf(r), r]));
    const jobsById = new Map(jobs.map((j) => [j.id, j]));
    // A room keeps the job its credits were read from for as long as that job is in JobTread: a name fixed on the
    // job or the kid, or a warranty job of the same name, never moves them. Only a job that's gone hands over to
    // the one the name now finds, and no room takes a job another room holds
    const linked = linkJobs(jobs, records);
    const held = new Map();
    for (const row of rows.values()) if (jobsById.has(row.jobId) && byKey.has(row.record)) held.set(row.record, row.jobId);
    for (const [k, id] of held) linked.set(k, jobsById.get(id));
    const holder = new Map([...held].map(([k, id]) => [id, k]));
    for (const [k, job] of [...linked]) if (holder.has(job.id) && holder.get(job.id) !== k) linked.delete(k);
    const ctx = { partners, links, contacts, accounts: await readAccounts(DB), ...(await knownNames(DB, partners)) };
    const saved = new Set();
    // When each room was last looked at (a change first seen next look was made after it), and the order this run
    // goes in: the rooms looked at longest ago first, so a run its time budget cuts short is taken up where it stopped
    const looks = await readState(DB, 'looks', {});
    const order = [...linked].sort(([a], [b]) => String(looks[a] || '').localeCompare(String(looks[b] || '')));
    const lookedNow = {};

    for (const [k, job] of order) {
      // A run takes at most RUN_BUDGET_MS of JobTread and D1 work; the rest is next run's (the lock is only so long)
      if (Date.now() > roomStop) { report.more = true; break; }
      const rec = byKey.get(k);
      if (!rec) continue;
      // The room counts as looked at only when both fields were read and compared (a look that wasn't made can't be
      // the read before a change)
      let lookedAll = true;
      for (const kind of KIND_LIST) {
        let row = rows.get(`${k} ${kind.key}`) || null;
        let stored = row ? rowSig(row) : null;
        let firstNow = !row;
        if (!job.values) lookedAll = false;
        try {
          if (row) row = { ...row, readAt: looks[k] || row.readAt };
          // The room's job changed (relinked; the old one may be gone): a first look at the new one, bringing what the
          // site knew with any change still owed made to it (a credit a person took off stays off). A question still
          // open on the old job moves as the website's answer, never the old job's names it asked about. Like any
          // first look, what an older job already says is a question for a person, and a newer one's are picks
          if (row && row.jobId !== job.id) {
            const carry = row.held ? row.held.website : copyOf(meantOf(row, ctx));
            // (asked again at the new job whether they're already on it)
            const owedPuts = (row.retry || []).map((x) => (typeof x === 'string' ? { s: x } : x)).filter((x) => carry.includes(x.s)).map((x) => ({ s: x.s, r: false, at: x.at || null }));
            if (!job.values) continue;
            row = await firstLook(env, { rec, k, kind, job, current: named(job.values[kind.key], ctx), launched, ids, ctx, at, report, fetchImpl, bring: carry });
            report.wrote.push({ record: k, kind: kind.key, why: 'moved', values: carry });
            if (!row) continue;
            // A company still to be put on the room for a pick goes on at the new job, as it would have at the old
            if (owedPuts.length) { row = { ...row, retry: owedPuts }; await writeJobRow(DB, row, at); }
            firstNow = true;
            stored = rowSig(row);
          }
          // What the site knows about names first (a Same as made or changed, a partner renamed): applied to what was
          // seen as it was matched, before anything else uses it
          if (row && !firstNow) row = remap(row, ctx);
          // A write owed from before is finished before anything is compared. One JobTread won't take stays owed (tried
          // again each run; the card says so after a few tries) without stopping her own changes from counting
          let owed = null;
          // A finished room's job is never respelled: a respelling still owed to it from before it closed is let go
          if (row?.pending?.rename?.length && !firstNow && job.closedOn) {
            const rest = { ...row.pending, rename: [] };
            row = { ...row, pending: rest.add?.length || rest.remove?.length ? rest : null };
          }
          if (row?.pending && !firstNow) {
            // After OWED_TRIES refusals it's tried once a day: the card and Automations say it's waiting, and a person
            // making the same change in JobTread settles it
            const tries = row.pending.tries || 0;
            const due = tries < OWED_TRIES || !row.pending.failedAt || now - Date.parse(row.pending.failedAt) >= OWED_RETRY_MS;
            const has = job.values ? job.values[kind.key] : null;
            // (by spelling: a respelling owed is only there when JobTread spells it so)
            if (!due && has && sameSpelling(has, applyChange(has, owedNames(row.pending, ctx)))) {
              // A person made the same change in JobTread: nothing is owed any more (as if the write had landed)
              row = owedLanded(row, ctx);
            } else if (!due) owed = row.pending;
            else {
              try {
                row = await writeChange(env, row, {}, ids, { fetchImpl, at, ctx });
                stored = rowSig(row);
              } catch (e) {
                if (e.gone) throw e;
                owed = row.pending;
                row = { ...row, pending: { ...row.pending, tries: tries + 1, error: e.message, failedAt: at } };
                if (tries + 1 <= OWED_TRIES) report.problems.push(`${rec.data?.name || k} (${kind.label}): JobTread didn’t take a change still owed to it (try ${tries + 1}, tried again next run): ${e.message}`);
              }
            }
          }
          if (!row) {
            const current = job.values ? named(job.values[kind.key], ctx) : null;
            row = await firstLook(env, { rec, k, kind, job, current, launched, ids, ctx, at, report, fetchImpl });
            if (!row) continue;
            firstNow = true;
            stored = rowSig(row);
          } else if (!firstNow) {
            // What JobTread has: read just now when the site wrote to it this run (the run's own read is from before
            // that write), and with a change still owed made to it, so only her own changes count
            const values = row._now || (job.values ? job.values[kind.key] : null);
            if (!values) lookedAll = false;
            const current = values ? named(owed ? applyChange(values, owed) : values, { ...ctx, known: [...row.seen, ...(row.next || []), ...owedKnown(owed)] }) : null;
            // With a change still owed, all three sides have it made: what was seen, a change of hers waiting on its
            // second look, and what JobTread has now (so the wait, and when she made it, carry on as they were)
            const owedOn = (xs) => named(applyChange(xs.map((x) => x.v), owed), { ...ctx, known: [...xs, ...owedKnown(owed)] });
            const base = owed ? { ...row, seen: meantOf(row, ctx), next: row.next ? owedOn(row.next) : null } : row;
            const before = base.seen;
            const step = look(base, current, at);
            row = step.row;
            // A name from before launch that's left the job is no longer launch's (picked again later, it's hers)
            if (row.older?.length) row = { ...row, older: row.older.filter((n) => row.seen.some((x) => nameKey(x.v) === n)) };
            // Picks to put on: the ones that settled now, and any a run before couldn't finish (still credited).
            // Each carries when it was picked, so a take-off made after it stands and one made before doesn't
            const toPut = [];
            if (step.settled) {
              const d = diff(before, step.settled);
              report.changed.push({ record: k, kind: kind.key, added: d.added, removed: d.removed });
              toPut.push(...d.added.filter((x) => x.p).map((x) => ({ s: x.p, at: step.since, resume: false })));
              // A question still open on this room: what she picked or took off since is hers, so it's made to the
              // website's answer too (and a question with nothing left to ask is closed)
              if (row.held) row = { ...row, held: heldAfter(row.held, d) };
            }
            const still = copyOf(meantOf(row, ctx));
            // Retries: { s: slug, r: true when it had got past "already on the room?" (finish it), else ask again, at }
            const retries = (row.retry || []).map((x) => (typeof x === 'string' ? { s: x, r: true } : x)).filter((x) => still.includes(x.s) && !toPut.some((t) => t.s === x.s));
            toPut.push(...retries.map((x) => ({ s: x.s, at: x.at || null, resume: !!x.r })));
            // Every one is written down as still to do before any is started, so a run cut off part way through one
            // (the heartbeat's time running out) leaves the rest to the next run; each is crossed off when done
            const todo = toPut.filter((t) => partners.some((pp) => pp.slug === t.s));
            row = { ...row, retry: todo.map((t) => ({ s: t.s, r: t.resume, at: t.at })) };
            if (todo.length && rowSig(row) !== stored) { await writeJobRow(DB, row, at); stored = rowSig(row); }
            const setRetry = (slug, fn) => { row = { ...row, retry: fn(row.retry).filter(Boolean) }; };
            for (const t of todo) {
              const p = partners.find((pp) => pp.slug === t.s);
              // Out of time: it waits for the next run, as a put-on still to finish
              if (Date.now() > stopAt) { report.more = true; continue; }
              try {
                // Past "already on the room?": a cut-off from here is finished next run, not asked again
                const mark = async () => { setRetry(t.s, (list) => list.map((x) => (x.s === t.s ? { ...x, r: true } : x))); await writeJobRow(DB, row, at); };
                const put = await putOnRoom(env, rec, p, kind, { job, ctx, fetchImpl, now, deps, resume: t.resume, pickedAt: t.at, decided: mark });
                setRetry(t.s, (list) => list.filter((x) => x.s !== t.s));
                if (put.logo || put.people.length) report.put.push({ record: k, kind: kind.key, partner: p.slug, ...put });
              } catch (e) {
                // Tried again next run, while it's still credited
                setRetry(t.s, (list) => list.map((x) => (x.s === t.s ? { ...x, r: !!e.decided } : x)));
                report.problems.push(`${rec.data?.name || k}: couldn’t put ${p.name} on the room yet (tried again next run): ${e.message}`);
              }
            }
          }
          // A partner renamed in Partners: the job says the new name (choice added first, the old one goes after)
          // (only a real rename: a spelling that differs by case or apostrophe is the same choice). Not while a write
          // JobTread won't take is owed: that one goes first
          // Only a value that is the partner's own name another way: another spelling or word order, or a name it had
          // before a rename in Partners. A value matched by a person's Same as stays as JobTread has it, so a link
          // that turns out wrong can be changed or taken away and the job still says what she picked
          const respell = new Set(['name', 'words', 'former']);
          // (by how the value was matched when it was, as remap keeps it: a match by name stays one)
          const renames = row.next ? [] : row.seen.filter((x) => x.p && respell.has(x.h || 'name')).map((x) => [x, partners.find((p) => p.slug === x.p)])
            .filter(([x, p]) => p && norm(x.v) !== norm(p.name)).map(([x, p]) => [x.v, p.name, x.p]);
          // A finished room's job keeps its old spelling: it's the same company either way (the dropdown has both)
          if (renames.length && !owed && !job.closedOn) {
            if (rowSig(row) !== stored) await writeJobRow(DB, row, at);
            try {
              row = await writeChange(env, row, { rename: renames.map(([from, to]) => [from, to]), slugs: Object.fromEntries(renames.map(([, to, slug]) => [nameKey(to), slug])) }, ids, { fetchImpl, at, ctx });
              stored = rowSig(row);
              report.wrote.push({ record: k, kind: kind.key, why: 'renamed', values: renames.map(([from, to]) => [from, to]) });
            } catch (e) {
              if (e.gone) throw e;
              // JobTread didn't take the respelling: owed like any other change (written first by writeChange), tried
              // again next run, then once a day
              const was = (await readJobRows(DB)).get(`${k} ${kind.key}`) || row;
              row = { ...row, pending: { ...was.pending, tries: 1, error: e.message, failedAt: at } };
              report.problems.push(`${rec.data?.name || k} (${kind.label}): JobTread didn’t take a change still owed to it (try 1, tried again next run): ${e.message}`);
            }
          }
          // Written only when something kept changed (most rooms, most runs: nothing)
          if (rowSig(row) !== stored) await writeJobRow(DB, row, at);
          // A name a person said isn't a company ("Family's Community Crowd Funding") isn't asked about
          for (const x of row.seen) if (!x.p && !notCompanies.includes(nameKey(x.v))) report.unknown.push({ record: k, kind: kind.key, value: x.v, job: job.id });
          if (row.held) report.held.push({ record: k, kind: kind.key, ...row.held });
          // While a question is open, the copy is the website's answer with every change made since; else what the
          // site means the job to hold (JobTread's, with any change still owed to it)
          const copy = row.held ? row.held.website : copyOf(meantOf(row, ctx));
          if (await saveCopy(env, rec, kind.key, keepGone(copy, partners), at, `${kind.label}: ${copy.map((s) => partners.find((p) => p.slug === s)?.name || s).join(', ') || 'none'}, from JobTread`)) saved.add(k);
        } catch (e) {
          lookedAll = false;
          report.problems.push(`${rec.data?.name || k} (${kind.label}): ${e.message}`);
        }
      }
      if (lookedAll) lookedNow[k] = at;
    }
    // When each room was looked at, kept for the next run (rooms no longer linked are let go)
    await writeState(DB, 'looks', Object.fromEntries([...linked.keys()].filter((k) => lookedNow[k] || looks[k]).map((k) => [k, lookedNow[k] || looks[k]])));
    // (a room that couldn't be read keeps its place at the front, and is tried first next run)
    // A room whose job is gone from JobTread (deleted), with no other job for it: its rows go, and it goes on as a
    // room with no job, its credits on its own record, until it has one again (then they go into that one). A job
    // that's still there is never let go of, whatever its name. A page that was deleted: its rows go too (a question
    // about it can't be settled; a page brought back starts again with a first look)
    for (const r of new Set([...rows.values()].filter((x) => !jobsById.has(x.jobId) || (records.length && !byKey.has(x.record))).map((x) => x.record))) {
      if (linked.has(r) && byKey.has(r)) continue;
      await DB.prepare('DELETE FROM room_credit_jobs WHERE record = ?').bind(r).run();
      report.unlinked = [...(report.unlinked || []), r];
    }

    // Launch is over when every linked room has had its first look (over as many runs as that takes): until then,
    // each first look is launch's, a question for a person where JobTread and the website disagree
    const all = await readJobRows(DB);
    const firstsDone = [...linked].every(([k, job]) => !byKey.has(k) || !job.values || KIND_LIST.every((kind) => all.get(`${k} ${kind.key}`)?.jobId === job.id));
    if (!launched && firstsDone) await writeState(DB, 'launched', { at });

    // The dropdowns: Partners' names in each category, and anyone credited anywhere, added A to Z where missing. A
    // choice goes only if the site added it, no job anywhere holds it (every job's values read this run), and it's
    // no longer wanted: an old spelling after a rename, say. A person's own choices always stay. (Out of time, this
    // waits for the next run.)
    const allRead = jobs.every((j) => j.values);
    for (const kind of Date.now() < stopAt ? KIND_LIST : []) {
      const credited = [...new Set([...all.values()].filter((r) => r.kind === kind.key).flatMap((r) => copyOf(meantOf(r, ctx))))];
      try {
        const siteAdded = allRead ? await readState(DB, `choices-added:${kind.key}`, []) : [];
        const holds = [...new Set(jobs.flatMap((j) => j.values?.[kind.key] || []))];
        const r = await keepChoices(key, ids[kind.key], { wanted: wantedChoices(kind, partners, credited), siteAdded, held: holds }, { fetchImpl });
        if (r.added.length || r.dropped.length) await noteChoices(DB, kind.key, r);
        if (r.added.length) report.wrote.push({ kind: kind.key, why: 'choices', values: r.added });
        if (r.dropped.length) report.wrote.push({ kind: kind.key, why: 'choices dropped', values: r.dropped });
      } catch (e) { report.problems.push(`${kind.field} choices: ${e.message}`); }
    }

    if (saved.size) await requestDeploy(env, now, 'room credits from JobTread').catch(() => {});
    // What waits for a person, across every room (not only the ones this run reached)
    // Counted as Partners → JobTread access lists them: a question a room, a name once however many jobs hold it
    let asked = 0;
    let owedN = 0;
    const names = new Set();
    for (const r of all.values()) {
      if (!byKey.has(r.record)) continue;
      if (r.held) asked += 1;
      if ((r.pending?.tries || 0) >= OWED_TRIES) owedN += 1;
      for (const x of r.seen) if (!x.p && !partnerFor(x.v, ctx) && !notCompanies.includes(nameKey(x.v))) names.add(`${r.kind} ${nameKey(x.v)}`);
    }
    await writeState(DB, 'last', { at, changed: report.changed.length, put: report.put.length, unknown: names.size, held: asked, owed: owedN, problems: report.problems, more: report.more });
    if (report.changed.length || report.put.length) await logAudit(DB, { userEmail: SYNC_USER, action: 'updated', entityType: 'room-credits', entitySlug: 'sweep', entityName: 'Room credits', changes: { changed: report.changed, put: report.put } }).catch(() => {});
    return report;
  } catch (e) {
    await writeState(DB, 'last', { at, error: e.message, code: e.code || null }).catch(() => {});
    report.problems.push(e.message);
    return report;
  } finally {
    await freeLock(DB, LOCK);
  }
}

/**
 * The first time a room's job is read for this kind:
 *   - at launch: the website's sponsors go into the field (their people are on
 *     the job already, from the old sponsor sync); where JobTread names a
 *     sponsor the website didn't have, or one staff took off, it's held for a
 *     person and the copy keeps the website's answer. Nobody is put on.
 *   - after: a room that had credits before it had a job brings them into the
 *     job; values a person set in JobTread are her picks (second look first).
 */
// bring: the credits to bring into the job (default: the record's); a move to a new job brings what the site knew
async function firstLook(env, { rec, k, kind, job, current, launched, ids, ctx, at, report, fetchImpl, bring = null }) {
  const { DB } = env;
  if (!current) return null;
  const site = (bring || (Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : [])).filter((s) => ctx.partners.some((p) => p.slug === s));
  const siteNames = site.map((s) => ctx.partners.find((p) => p.slug === s).name);
  const jtSlugs = copyOf(current);
  const missing = siteNames.filter((n) => !current.some((x) => nameKey(x.v) === nameKey(n) || x.p === ctx.partners.find((p) => p.name === n)?.slug));
  // After launch, what JobTread has beyond the website's credits is a person's picks: they count on the second
  // look, and a company picked that isn't on the room goes on then (at launch they're a question for a person)
  const agreed = current.filter((x) => x.p && site.includes(x.p));
  const extras = current.filter((x) => !(x.p && site.includes(x.p)));
  // A job made before launch, first linked since (its name now matches): what it says is from before, a question
  // for a person like launch's, never picks that put anyone on a job
  const older = !launched || !job.createdAt || Date.parse(job.createdAt) < Date.parse(launched.at);
  let row = { record: k, kind: kind.key, jobId: job.id, seen: older ? current : agreed, next: null, nextAt: null, pending: null, held: null, readAt: at };
  // JobTread names more than the website had: a person says which is right. Worked out before any write, so a
  // write that fails halfway keeps the question
  if (older) {
    const dismissed = kind.key === 'sponsored' ? await oldDismissed(DB, rec.slug) : [];
    const extra = jtSlugs.filter((s) => !site.includes(s));
    if (extra.length) row.held = { jobtread: extra, website: site, dismissed: extra.filter((s) => dismissed.includes(s)) };
    // Names that aren't a company yet: if one is later said to be one, that's a question too (remap)
    row.older = [...new Set(current.filter((x) => !x.p).map((x) => nameKey(x.v)))];
  }
  if (missing.length) {
    row = await writeChange(env, row, { add: missing, slugs: Object.fromEntries(missing.map((n) => [nameKey(n), ctx.partners.find((p) => p.name === n).slug])) }, ids, { fetchImpl, at, ctx });
    report.wrote.push({ record: k, kind: kind.key, why: launched ? 'had-before-job' : 'launch', values: missing });
  }
  // Picked in JobTread since the job was made (the earliest they can have been picked)
  if (!older && extras.length) row = { ...row, next: [...row.seen, ...extras], nextAt: at, nextSince: job.createdAt || null };
  await writeJobRow(DB, row, at);
  return row;
}
async function oldDismissed(DB, slug) {
  try { return parse((await DB.prepare('SELECT dismissed FROM sponsor_jobs WHERE record = ?').bind(slug).first())?.dismissed, []); } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

// deadline: when the heartbeat's time is up; too little left for a run, it waits for the next heartbeat
export async function maybeSyncCredits(env, { fetchImpl = fetch, now = Date.now(), deps = realDeps, deadline = null } = {}) {
  if (!env?.DB || !env.JOBTREAD_GRANT_KEY) return null;
  if (deadline != null && deadline - Date.now() < MIN_RUN_MS) return null;
  await ensureSchema(env.DB);
  const last = await readState(env.DB, 'last', null);
  if (last?.at && now - Date.parse(last.at) < RUN_EVERY_MS) return null;
  return syncCredits(env, { fetchImpl, now, deps, deadline });
}

// ── Admin → Kids, the Advisory Board: a person says it ───────────────

/**
 * The room's job, if it's still in JobTread: the one either credit last read, else the one the record is pinned
 * to. A job deleted in JobTread drops the room's rows, so the room goes on as one with no job (its credits on its
 * own record) until it has a job again
 */
async function roomJob(env, rec, record, rows, { fetchImpl }) {
  const jobId = rows.get(`${record} designed`)?.jobId || rows.get(`${record} sponsored`)?.jobId || rec.data?.jobtreadJobId || null;
  if (!jobId || !env.JOBTREAD_GRANT_KEY) return null;
  try {
    await readJobValues(env.JOBTREAD_GRANT_KEY, jobId, await creditIds(env, fetchImpl), fetchImpl);
    return jobId;
  } catch (e) {
    if (!e.gone) throw e;
    await env.DB.prepare('DELETE FROM room_credit_jobs WHERE record = ?').bind(record).run();
    return null;
  }
}

/**
 * A person sets or takes off a credit. A room with a JobTread job: its field
 * is changed (read now, one change), and a pick of a company not on the room
 * puts it on at once. A room with no job: its own record, and the logo.
 * → { record, kind, credits: [slugs], job: id | null, put: { logo, people } | null }
 */
// put: false, the credit only (an Undo of taking a credit off puts back the credit, never a company that wasn't there)
// person: a person picking it means them on the makeover, even after a person took them off (the Advisory Board's Pick the kid)
export async function setCredit(env, { record, kind: kindKey, partner: slug, on, put = true, person = false }, by = null, { fetchImpl = fetch, now = Date.now(), deps = realDeps } = {}) {
  const { DB } = env;
  const kind = KINDS[kindKey];
  if (!kind) throw Object.assign(new Error('Designed by or Monetary sponsor?'), { status: 400 });
  await ensureSchema(DB);
  const at = iso(now);
  const who = by || 'unknown';
  const out = { record, kind: kind.key, job: null, put: null, credits: [] };
  // The credits lock first, then everything read under it: a sweep finishing a moment before isn't written over
  if (!(await takeLock(DB, true, LOCK))) throw Object.assign(new Error('JobTread is being read right now. Try again in a moment.'), { status: 503 });
  let rec;
  let partner;
  try {
    const [kids, projects, partners, links, contacts, rows] = await Promise.all([loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readLinks(DB), readContacts(DB), readJobRows(DB)]);
    rec = [...kids, ...projects].find((r) => keyOf(r) === record);
    if (!rec) throw Object.assign(new Error('That page isn’t there any more. Reload and try again.'), { status: 409 });
    // A company deleted from Partners can still be taken off (deleted is deleted); only a pick needs it in Partners
    partner = partners.find((p) => p.slug === slug) || (on ? null : { slug, name: slug, gone: true });
    if (!partner) throw Object.assign(new Error('That company isn’t in Partners any more. Reload and try again.'), { status: 409 });
    const ctx = { partners, links, contacts, accounts: await readAccounts(DB), ...(await knownNames(DB, partners)) };
    const jobId = await roomJob(env, rec, record, rows, { fetchImpl });
    let row = jobId && rows.get(`${record} ${kind.key}`)?.jobId === jobId ? rows.get(`${record} ${kind.key}`) : null;
    // What the site knows about names now (a Same as made since the last run) first, as the sweep does
    if (row) row = remap(row, ctx);

    if (jobId) {
      const ids = await creditIds(env, fetchImpl);
      const jobNow = await readJobValues(env.JOBTREAD_GRANT_KEY, jobId, ids, fetchImpl);
      if (!row) {
        // First time this room's job is touched: the sweep's first look, here (the website's credits go into the
        // job, a question for a person is kept), then this change
        const launched = await readState(DB, 'launched', null);
        row = await firstLook(env, { rec, k: record, kind, job: { id: jobId, createdAt: jobNow.createdAt }, current: named(jobNow[kind.key], ctx), launched, ids, ctx, at, report: { wrote: [] }, fetchImpl });
      }
      const change = on ? { add: [partner.name], slugs: { [nameKey(partner.name)]: slug } } : { remove: [partner.name, ...row.seen.filter((x) => x.p === slug).map((x) => x.v)] };
      let owed = false;
      let meant = null;
      try {
        row = await writeChange(env, row, change, ids, { fetchImpl, at, ctx });
      } catch (e) {
        if (e.gone) throw e;
        // JobTread didn't take the write: it's owed (written first), and the next run finishes it. The person's
        // change stands now: the page says it, and putting the company on is finished then too
        owed = true;
        const was = (await readJobRows(DB)).get(`${record} ${kind.key}`) || row;
        meant = copyOf(meantOf({ ...was, pending: was.pending || mergePending(null, change) }, ctx));
        row = { ...was, seen: was.seen, retry: [...(was.retry || []).filter((x) => (typeof x === 'string' ? x : x.s) !== slug), ...(on && put ? [{ s: slug, r: false, at }] : [])] };
        await writeJobRow(DB, row, at);
        out.owed = e.message;
      }
      // Taken off: nothing is left to finish putting on
      if (!on && row.retry?.length) { row = { ...row, retry: row.retry.filter((x) => (typeof x === 'string' ? x : x.s) !== slug) }; await writeJobRow(DB, row, at); }
      // Still a question open on this room: the copy keeps the website's answer, with this change made to it (the
      // question's own names are never settled by a pick of something else, or by JobTread not taking a write)
      if (row.held) {
        row = { ...row, held: heldAfter(row.held, on ? { added: [{ p: slug }] } : { removed: [{ p: slug }] }) };
        await writeJobRow(DB, row, at);
      }
      out.job = jobId;
      if (on && put && !owed) {
        try {
          out.put = await putOnRoom(env, rec, partner, kind, { job: { id: jobId, closedOn: jobNow.closedOn }, ctx, fetchImpl, now, by: who, deps, person, pickedAt: at });
        } catch (e) {
          // The credit stands; putting them on is finished (or asked again) by the next run, as the sweep's are. What
          // did happen (the logo, say) is said, so an Undo takes it back
          row = { ...row, retry: [...(row.retry || []).filter((x) => (typeof x === 'string' ? x : x.s) !== slug), { s: slug, r: !!e.decided, at }] };
          await writeJobRow(DB, row, at);
          out.put = { logo: false, people: [], waiting: false, off: false, ...(e.done || {}), retry: true, error: e.message };
        }
      }
      const copy = row.held ? row.held.website : owed ? meant : copyOf(row.seen);
      if (owed) out.meant = copy;
      await saveCopy(env, rec, kind.key, keepGone(copy, partners, on ? null : slug), at, `${kind.label}: ${on ? 'added' : 'took off'} ${partner.name}`, { by: who });
      out.credits = Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : [];
    } else {
      // No job: the record holds the credit, and that's all (a finished room's page is changed by a person, on the
      // page). The change is made to the list as the record has it when written, so two picks at once both stand
      await saveCopy(env, rec, kind.key, (list) => (on ? [...new Set([...list, slug])] : list.filter((s) => s !== slug)), at, `${kind.label}: ${on ? 'added' : 'took off'} ${partner.name}`, { by: who });
      out.credits = Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : [];
    }
  } finally { await freeLock(DB, LOCK); }
  await logAudit(DB, { userEmail: who, action: 'updated', entityType: 'room-credits', entitySlug: record, entityName: rec.data?.name || record, changes: { kind: kind.key, partner: slug, on, job: out.job, put: out.put } }).catch(() => {});
  // A person's change goes live with Publish, like any save in the admin (only the JobTread sweep deploys, as the other syncs do)
  return { ...out, ...(await pageOf(DB, record)) };
}

/**
 * "Add them back": a person puts a credited company that isn't on the makeover back on it now, the way Add
 * to job does (its logo on the page, its people on the open job; one a person took off comes back, since a
 * person is saying so). → { put, sha, page }
 */
export async function addBack(env, { record, kind: kindKey, partner: slug }, by = null, { fetchImpl = fetch, now = Date.now(), deps = realDeps } = {}) {
  const { DB } = env;
  const kind = KINDS[kindKey];
  if (!kind) throw Object.assign(new Error('Designed by or Monetary sponsor?'), { status: 400 });
  await ensureSchema(DB);
  // Under the credits lock, like a pick: a sweep part way through finishes first
  if (!(await takeLock(DB, true, LOCK))) throw Object.assign(new Error('JobTread is being read right now. Try again in a moment.'), { status: 503 });
  let put = { logo: false, people: [], waiting: false, off: false };
  try {
  const [kids, projects, partners, links, contacts, rows] = await Promise.all([loadAllKids(DB), loadAllProjects(DB), readPartners(DB), readLinks(DB), readContacts(DB), readJobRows(DB)]);
  const rec = [...kids, ...projects].find((r) => keyOf(r) === record);
  const partner = partners.find((p) => p.slug === slug);
  if (!rec || !partner) throw Object.assign(new Error('That page or company isn’t there any more. Reload and try again.'), { status: 409 });
  // Only a company credited on this room: Add them back is for a credit whose company isn't on the makeover
  if (!(Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : []).includes(slug)) throw Object.assign(new Error(`${partner.name} isn’t credited on this page. Reload and try again.`), { status: 409 });
  const jobId = await roomJob(env, rec, record, rows, { fetchImpl });
  if (jobId) {
    const ids = await creditIds(env, fetchImpl);
    const closedOn = (await readJobValues(env.JOBTREAD_GRANT_KEY, jobId, ids, fetchImpl)).closedOn;
    put = await putOnRoom(env, rec, partner, kind, { job: { id: jobId, closedOn }, ctx: { partners, links, contacts, accounts: await readAccounts(DB), ...(await knownNames(DB, partners)) }, fetchImpl, now, by: by || 'unknown', deps, person: true });
  }
  // No open job: the logo back on the page is all there is to it
  if (!put.logo && !put.people.length && partner.logo && !onRoom(partner, rec, { partners })) {
    if (!(await takeLock(DB, true, 'sync'))) throw Object.assign(new Error('That page is busy. Try again in a moment.'), { status: 503 });
    try { await deps.pageLogosOn(env, { table: tableOf(rec), slug: rec.slug, logos: [{ url: partner.logo, name: partner.name, at: 0 }] }, by || 'unknown'); put.logo = true; put.logoUrl = partner.logo; } finally { await freeLock(DB, 'sync'); }
  }
  await logAudit(DB, { userEmail: by || 'unknown', action: 'updated', entityType: 'room-credits', entitySlug: record, entityName: rec.data?.name || record, changes: { addBack: slug, kind: kind.key, put } }).catch(() => {});
  } finally { await freeLock(DB, LOCK); }
  // A person's change goes live with Publish, like any save in the admin (only the JobTread sweep deploys, as the other syncs do)
  return { put, ...(await pageOf(DB, record)) };
}

/**
 * The page as it is now, for an editor that has it open: its version (the sha a Save checks) and the parts the
 * credits change (the credits, and a logo a pick put on) → { sha, page: { designers, sponsors, partnerLogos } }
 */
export async function pageOf(DB, record) {
  const community = String(record || '').startsWith('community/');
  const slug = community ? record.slice('community/'.length) : record;
  const raw = (await DB.prepare(`SELECT data FROM ${community ? 'community' : 'kids'} WHERE slug = ?`).bind(slug).first())?.data;
  if (!raw) return { sha: null, page: null };
  const d = parse(raw, {});
  return { sha: await generateSha(raw), page: { designers: d.designers || [], sponsors: d.sponsors || [], partnerLogos: d.partnerLogos || [] } };
}

/**
 * Launch found JobTread and the website disagreeing on a room: a person says
 * which is right. use: 'jobtread' (the website takes JobTread's) or 'website'
 * (JobTread's extra names come out of the field).
 */
export async function settleHeld(env, { record, kind: kindKey, use }, by = null, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const kind = KINDS[kindKey];
  if (!kind || !['jobtread', 'website'].includes(use)) throw Object.assign(new Error('Bad request'), { status: 400 });
  const at = iso(now);
  await ensureSchema(DB);
  // Under the credits lock, read after it's taken: a sweep part way through can't write the question back
  if (!(await takeLock(DB, true, LOCK))) throw Object.assign(new Error('JobTread is being read right now. Try again in a moment.'), { status: 503 });
  let row;
  let rec;
  let partners;
  let owed = null;
  try {
    const [rows, ps, links, contacts, kids, projects] = await Promise.all([readJobRows(DB), readPartners(DB), readLinks(DB), readContacts(DB), loadAllKids(DB), loadAllProjects(DB)]);
    partners = ps;
    row = rows.get(`${record} ${kind.key}`);
    rec = [...kids, ...projects].find((r) => keyOf(r) === record);
    const names = await knownNames(DB, partners);
    if (row) row = remap(row, { partners, links, contacts, ...names });
    if (!row?.held || !rec) throw Object.assign(new Error('Already settled. Reload.'), { status: 409 });
    const ctx = { partners, links, contacts, ...names };
    let copy = null;
    if (use === 'website') {
      const ids = await creditIds(env, fetchImpl);
      const extra = row.held.jobtread.map((s) => partners.find((p) => p.slug === s)?.name).filter(Boolean);
      const values = row.seen.filter((x) => row.held.jobtread.includes(x.p)).map((x) => x.v);
      try {
        row = await writeChange(env, row, { remove: [...extra, ...values] }, ids, { fetchImpl, at, ctx });
      } catch (e) {
        if (e.gone) {
          // The job's gone from JobTread: the website's answer is the room's, kept on its own record
          copy = row.held.website;
          await DB.prepare('DELETE FROM room_credit_jobs WHERE record = ?').bind(record).run();
        } else {
          // JobTread didn't take it just now: the person's answer stands (the page says it), and taking the names out
          // of JobTread is owed (written first), finished by the next run
          row = (await readJobRows(DB)).get(`${record} ${kind.key}`) || row;
          owed = e.message;
        }
      }
    }
    if (!copy) {
      row = { ...row, held: null };
      await writeJobRow(DB, row, at);
    }
    // JobTread's answer: what it holds, with any change a person made here that's still owed to it
    await saveCopy(env, rec, kind.key, keepGone(copy || copyOf(meantOf(row, ctx)), partners), at, `${kind.label}: ${use === 'jobtread' ? 'JobTread’s' : 'the website’s'} kept`, { by: by || 'unknown' });
  } finally { await freeLock(DB, LOCK); }
  await logAudit(DB, { userEmail: by || 'unknown', action: 'updated', entityType: 'room-credits', entitySlug: record, entityName: rec.data?.name || record, changes: { settled: kind.key, use } }).catch(() => {});
  // A person's change goes live with Publish, like any save in the admin (only the JobTread sweep deploys, as the other syncs do)
  return { record, kind: kind.key, credits: Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : copyOf(row.seen), ...(owed ? { owed } : {}) };
}

/**
 * What the admin shows. For a room: each kind's credits, JobTread's job, the
 * values JobTread has that aren't a company in Partners, what's waiting on a
 * second look, a launch question, and which credited companies aren't on the
 * room. For everything: rooms by partner (Partners), and the open questions.
 */
export async function creditsView(env, { record = null, fetchImpl = fetch } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const [rows, partners, last, kids, projects, notCompanies, links, contacts, accounts] = await Promise.all([readJobRows(DB), readPartners(DB), readState(DB, 'last', null), loadAllKids(DB), loadAllProjects(DB), readState(DB, 'not-companies', []), readLinks(DB), readContacts(DB), readAccounts(DB)]);
  const recs = [...kids, ...projects];
  // A name settled a moment ago (Same as, Add to Partners) is known at once, before the next run writes it down
  const ctx = { partners, links, ...(await knownNames(DB, partners)) };
  const isUnknown = (x) => !x.p && !partnerFor(x.v, ctx) && !notCompanies.includes(nameKey(x.v));
  const nameOf = (s) => partners.find((p) => p.slug === s)?.name || s;
  // One room: who's on its job is read now, so "not on the makeover" is only said when it's so (null: couldn't tell)
  const accessOf = async (rec) => {
    const k = keyOf(rec);
    const jobId = rows.get(`${k} designed`)?.jobId || rows.get(`${k} sponsored`)?.jobId || rec.data?.jobtreadJobId || null;
    if (!jobId || !env.JOBTREAD_GRANT_KEY) return { aces: null, known: !jobId };
    try { return { aces: (await fetchAccess(env.JOBTREAD_GRANT_KEY, [jobId], fetchImpl)).get(jobId) || null, known: true }; } catch { return { aces: null, known: false }; }
  };
  const room = (rec, access = { aces: null, known: false }) => {
    const k = keyOf(rec);
    const out = { record: k, name: rec.data?.name || rec.slug, kinds: {} };
    const here = (p) => {
      if (onRoom(p, rec, { partners, aces: access.aces, contacts: contacts[p.slug] || [], links, account: accounts.get(p.slug) || null })) return true;
      return access.known ? false : null;
    };
    for (const kind of KIND_LIST) {
      const row = rows.get(`${k} ${kind.key}`);
      const credits = Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : [];
      out.kinds[kind.key] = {
        credits: credits.map((s) => ({ slug: s, name: nameOf(s), gone: !partners.some((p) => p.slug === s), onRoom: (() => { const p = partners.find((x) => x.slug === s); return p ? here(p) : false; })() })),
        job: row?.jobId || rec.data?.jobtreadJobId || null,
        unknown: (row?.seen || []).filter(isUnknown).map((x) => x.v),
        others: (row?.seen || []).filter((x) => !x.p && !partnerFor(x.v, ctx) && notCompanies.includes(nameKey(x.v))).map((x) => x.v),
        waiting: row?.next ? diff(row.seen || [], row.next) : null,
        // A change still owed to JobTread; after a few tries JobTread didn't take, why (the card says so)
        pending: row?.pending ? { tries: row.pending.tries || 0, error: (row.pending.tries || 0) >= OWED_TRIES ? row.pending.error || null : null } : null,
        held: row?.held ? { jobtread: row.held.jobtread.map((s) => ({ slug: s, name: nameOf(s) })), website: row.held.website.map((s) => ({ slug: s, name: nameOf(s) })) } : null,
      };
    }
    return out;
  };
  if (record) {
    const rec = recs.find((r) => keyOf(r) === record);
    if (!rec) throw Object.assign(new Error('No such page'), { status: 404 });
    return { room: room(rec, await accessOf(rec)), last };
  }
  const byPartner = {};
  for (const rec of recs) {
    for (const kind of KIND_LIST) {
      for (const s of Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : []) {
        (byPartner[s] ||= []).push({ record: keyOf(rec), name: rec.data?.name || rec.slug, year: rec.year ?? rec.data?.year ?? null, kind: kind.key });
      }
    }
  }
  const unknown = [];
  const held = [];
  // Changes JobTread keeps refusing (after a few tries): which page, which field, and why
  const owed = [];
  for (const row of rows.values()) {
    const rec = recs.find((r) => keyOf(r) === row.record);
    // A page deleted since: nothing to ask about it (the next run lets its rows go)
    if (!rec) continue;
    if ((row.pending?.tries || 0) >= OWED_TRIES) owed.push({ record: row.record, name: rec.data?.name || row.record, kind: row.kind, job: row.jobId, tries: row.pending.tries, error: row.pending.error || null });
    for (const x of row.seen || []) if (isUnknown(x)) unknown.push({ record: row.record, name: rec.data?.name || row.record, kind: row.kind, value: x.v, job: row.jobId });
    if (row.held) held.push({ record: row.record, name: rec.data?.name || row.record, kind: row.kind, job: row.jobId, jobtread: row.held.jobtread.map((s) => ({ slug: s, name: nameOf(s) })), website: row.held.website.map((s) => ({ slug: s, name: nameOf(s) })) });
  }
  return { byPartner, unknown, held, owed, last };
}

/**
 * A name in JobTread's field is a partner now (Same as, Add to Partners): every room whose field says it knows so at
 * once, and its page's copy follows. Knowing more about what she picked, not a pick: nobody is put on anything.
 * Under the credits lock, like a pick (busy: a run is under way and does the same itself next time) → { rooms, busy? }
 */
export async function applyLink(env, { now = Date.now(), by = SYNC_USER } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const at = iso(now);
  if (!(await takeLock(DB, true, LOCK))) return { busy: true, rooms: [] };
  const rooms = [];
  try {
    const [rows, partners, links, kids, projects] = await Promise.all([readJobRows(DB), readPartners(DB), readLinks(DB), loadAllKids(DB), loadAllProjects(DB)]);
    const ctx = { partners, links, ...(await knownNames(DB, partners)) };
    const byKey = new Map([...kids, ...projects].map((r) => [keyOf(r), r]));
    for (const row of rows.values()) {
      const rec = byKey.get(row.record);
      if (!rec) continue;
      const next = remap(row, ctx);
      if (rowSig(next) === rowSig(row)) continue;
      await writeJobRow(DB, next, at);
      const kind = KINDS[row.kind];
      const copy = next.held ? next.held.website : copyOf(meantOf(next, ctx));
      if (await saveCopy(env, rec, kind.key, keepGone(copy, partners), at, `${kind.label}: a name in JobTread linked to Partners`, { by })) rooms.push(row.record);
    }
  } finally { await freeLock(DB, LOCK); }
  // A person's change goes live with Publish, like any save in the admin (only the JobTread sweep deploys, as the other syncs do)
  return { rooms };
}

/**
 * Partners → Merge into (a person saying two companies are one): one step, under the credits lock so nothing reads
 * the rooms half way, that either does it all or stops before changing anything it can foresee.
 *   - Checked first: both companies are in Partners, and their people fit the five Partners keeps for a company
 *     (more, and a person chooses who stays first: nobody is dropped)
 *   - Each name JobTread's fields use for the old company (its name, another spelling or word order, a name it had
 *     before) and each Same as made for it becomes a Same as for the new one: the one list, seen and changed in the
 *     admin. A name a person linked to some other company stays theirs
 *   - Rooms credited with it are credited with the new company in its place (a room with a job: what its field now
 *     names), its pledges are added to the new company's, and its people join the new company's
 *   - Then the old company is deleted, as Delete does (Recently deleted keeps it)
 * Nobody is put on or taken off anything. Stopped part way (a D1 error), the old company is still there and running
 * the merge again finishes it: every step is safe to repeat. → { rooms: [records] }
 */
export async function mergeCredits(env, { from, fromName = '', into }, by = null, { now = Date.now() } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  const at = iso(now);
  if (!(await takeLock(DB, true, LOCK))) throw Object.assign(new Error('JobTread is being read right now, so the rooms and the old company are as they were. Merge again in a moment to finish.'), { status: 503 });
  const rooms = new Set();
  try {
    const [{ all, people, contacts }, kids, projects, rows, links, pledges] = await Promise.all([mergeCheck(env, { from, into }), loadAllKids(DB), loadAllProjects(DB), readJobRows(DB), readLinks(DB), readPledgeRows(DB, [from, into])]);
    const intoName = all.find((p) => p.slug === into).name;
    const fromRec = all.find((p) => p.slug === from);
    // As it will be: the old company gone from Partners
    const partners = all.filter((p) => p.slug !== from);
    // Names: a name a person linked to some other company stays as they said
    // (its name as saved now, and as the person merging saw it)
    const names = new Set([fromName, fromRec.name, ...[...rows.values()].flatMap((r) => [...r.seen, ...(r.next || []), ...owedKnown(r.pending)].filter((x) => x.p === from).map((x) => x.v))].map((n) => nameKey(n)).filter(Boolean));
    for (const [company, slug] of Object.entries(links)) if (slug === from) names.add(company);
    // A link to a company no longer in Partners is no link (Delete leaves links behind): it's this company's now
    const live = (slug) => partners.some((p) => p.slug === slug);
    for (const company of names) if (!links[company] || links[company] === from || !live(links[company])) await setLink(DB, { company, partner: into });
    // What JobTread's fields say, as the site knows them: each value that named it matched again with the links as
    // they are now (the new company, or a company a person linked that name to)
    const ctx = { partners, links: await readLinks(DB), ...(await knownNames(DB, partners)) };
    const again = (x) => { const m = matchOf(x.v, ctx); return m && m.how !== 'gone' ? { ...x, p: m.partner.slug, h: m.how } : { ...x, p: into, h: 'link' }; };
    const swapSeen = (xs) => xs && xs.map((x) => (x.p === from ? again(x) : x));
    const swap = (list) => [...new Set((list || []).map((s) => (s === from ? into : s)))];
    const updated = new Map();
    for (const row of rows.values()) {
      // A respelling still owed to the old company's name goes: her value stays as she picked it
      const slugs = row.pending?.slugs || {};
      const pending = row.pending ? {
        ...row.pending,
        rename: (row.pending.rename || []).filter(([, to]) => slugs[nameKey(to)] !== from),
        slugs: Object.fromEntries(Object.entries(slugs).map(([k, v]) => [k, v === from ? into : v])),
      } : null;
      const next = {
        ...row, seen: swapSeen(row.seen), next: swapSeen(row.next),
        held: row.held ? { ...row.held, jobtread: swap(row.held.jobtread).filter((s) => !swap(row.held.website).includes(s)), website: swap(row.held.website), dismissed: swap(row.held.dismissed) } : null,
        retry: (row.retry || []).map((x) => (x.s === from ? { ...x, s: into, r: false } : x)),
        pending: pending && (pending.add?.length || pending.remove?.length || pending.rename?.length) ? pending : null,
      };
      if (next.held && !next.held.jobtread.length) next.held = null;
      if (rowSig(next) !== rowSig(row)) await writeJobRow(DB, next, at);
      updated.set(`${row.record} ${row.kind}`, next);
    }
    // Every page's credits: a room with a job, what its field now names (as the next run will have it); one without,
    // the new company. Either way in the old company's place
    const placed = (was, want) => {
      const add = want.filter((s) => !was.includes(s));
      const out = [];
      for (const s of was) { if (s === from) out.push(...add.splice(0)); else if (want.includes(s)) out.push(s); }
      return [...new Set([...out, ...add])];
    };
    for (const rec of [...kids, ...projects]) {
      for (const kind of KIND_LIST) {
        const list = Array.isArray(rec.data?.[kind.record]) ? rec.data[kind.record] : [];
        if (!list.includes(from)) continue;
        const row = updated.get(`${keyOf(rec)} ${kind.key}`);
        const want = (was) => (row ? keepGone(row.held ? row.held.website : copyOf(meantOf(row, ctx)), partners, from)(was) : swap(was));
        if (await saveCopy(env, rec, kind.key, (was) => placed(was, want(was)), at, `${kind.label}: merged into ${intoName}`, { exact: true, by: by || 'unknown' })) rooms.add(keyOf(rec));
      }
    }
    // Pledges: one D1 batch each, so a pledge is never in both or neither
    for (const pl of pledges.filter((p) => p.partner === from)) {
      const have = pledges.find((q) => q.kid === pl.kid && q.partner === into);
      await DB.batch([
        DB.prepare(`INSERT INTO sponsor_pledges (kid, partner, pledged, received, updated_at, by) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(kid, partner) DO UPDATE SET pledged = excluded.pledged, received = excluded.received, updated_at = excluded.updated_at, by = excluded.by`)
          .bind(pl.kid, into, (pl.pledged || 0) + (have?.pledged || 0), (pl.received || 0) + (have?.received || 0), at, by || 'Partners merge'),
        DB.prepare('DELETE FROM sponsor_pledges WHERE kid = ? AND partner = ?').bind(pl.kid, from),
      ]);
    }
    // Its people join the new company's (checked above to fit)
    if ((contacts[from] || []).length) {
      await DB.batch([
        DB.prepare('INSERT OR REPLACE INTO partner_contacts (partner, people, source, updated_at, by) VALUES (?, ?, ?, ?, ?)').bind(into, JSON.stringify(people), 'merge', at, by || null),
        DB.prepare('DELETE FROM partner_contacts WHERE partner = ?').bind(from),
      ]);
    }
    // A person who took the old company off a job took the company off it: the one it went into stays off there too (a
    // pick of it from before, still waiting or owed, doesn't put it on). A take-off of its own stands as it is
    try {
      await DB.prepare(`INSERT OR IGNORE INTO vendor_job_seen (job_id, who, record, name, partner, account_id, people, logos, off, gone_at, took, left_on, gone_logos, before_off, updated_at)
        SELECT job_id, ?, record, ?, ?, account_id, people, logos, off, gone_at, took, left_on, gone_logos, before_off, updated_at
        FROM vendor_job_seen WHERE who = ? AND off IS NOT NULL`).bind(`p:${into}`, intoName, into, `p:${from}`).run();
    } catch (e) { if (!missingTable(e)) throw e; }
    // Last, the old company itself, as Delete does it (Recently deleted keeps it)
    const { deleteItem } = await import('./delete-content.js');
    await deleteItem(env, { path: `src/content/partners/${from}.json`, message: `Merged into ${intoName}: ${fromRec.name}` }, by || 'unknown');
  } finally { await freeLock(DB, LOCK); }
  await logAudit(DB, { userEmail: by || 'unknown', action: 'updated', entityType: 'room-credits', entitySlug: into, entityName: 'Partners merged', changes: { from, into, rooms: [...rooms] } }).catch(() => {});
  // A person's change goes live with Publish, like any save in the admin (only the JobTread sweep deploys, as the other syncs do)
  return { rooms: [...rooms] };
}
/**
 * Can these two be merged, as things are now: both in Partners, and their people (each email once) within the five
 * Partners keeps for a company. Asked before a merge changes anything (the merge window asks first, too) →
 * { all: partners, people: the two lists together, contacts } or a 409 saying why not
 */
export async function mergeCheck(env, { from, into }) {
  const { DB } = env;
  // The SOARD Advisory Board's partner is the site's own (its sponsorships and pledges follow the group's Zeffy
  // campaign, ./_advisory-sponsor.js): never merged in or out
  if ([from, into].includes('soard-advisory-board')) throw Object.assign(new Error('The SOARD Advisory Board is kept by the site, so it can’t be merged.'), { status: 409 });
  const [all, contacts] = await Promise.all([readPartners(DB), readContacts(DB, [from, into])]);
  if (!all.some((p) => p.slug === from)) throw Object.assign(new Error('That company isn’t in Partners any more. Reload and try again.'), { status: 409 });
  if (!all.some((p) => p.slug === into)) throw Object.assign(new Error('The company to merge into isn’t in Partners any more. Reload and try again.'), { status: 409 });
  const seenEmail = new Set();
  const people = [...(contacts[into] || []), ...(contacts[from] || [])].filter((c) => { const e = lower(c.email); if (!e) return true; if (seenEmail.has(e)) return false; seenEmail.add(e); return true; });
  if (people.length > MAX_CONTACTS) {
    const name = (s) => all.find((p) => p.slug === s).name;
    throw Object.assign(new Error(`${name(from)} and ${name(into)} have ${people.length} people between them, and Partners keeps ${MAX_CONTACTS} for a company. Take some off one of them first, then merge.`), { status: 409 });
  }
  return { all, people, contacts };
}
/** Pledge rows for these partners (none before the first pledge) */
async function readPledgeRows(DB, partners) {
  try {
    return (await DB.prepare(`SELECT kid, partner, pledged, received, updated_at, by FROM sponsor_pledges WHERE partner IN (${partners.map(() => '?').join(',')})`).bind(...partners).all()).results || [];
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

/** A name in a credit field that isn't a company ("Family's Community Crowd Funding"): shown as it is, never asked about again */
export async function setNotCompany(DB, value, on = true) {
  await ensureSchema(DB);
  const list = await readState(DB, 'not-companies', []);
  const k = nameKey(value);
  if (!k) throw Object.assign(new Error('No name'), { status: 400 });
  const next = on ? [...new Set([...list, k])] : list.filter((x) => x !== k);
  await writeState(DB, 'not-companies', next);
  return next;
}
