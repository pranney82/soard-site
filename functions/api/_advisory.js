/**
 * The Advisory Board's page and the tools that run it
 * ===========================================================================
 * Peter, Nov 5 2026: a page for the advisors like the board's, sharing Board in
 * the admin through a switch. Advisors have a job (help fund one makeover, open
 * doors, show up, four meetings a year), so the page is built around doing it.
 * Mary Atchley runs the group. She signs in as a board member, so her tools sit
 * on this page (Run it) as well as in the admin (the same module, the same API).
 *
 * Who sees what (functions/api/advisory-portal.js, advisory-admin.js):
 *   advisor     People → Advisory, active and published, by their private email
 *   committee   a board member on the Advisory Board committee: reads the page
 *   lead        whoever settings.lead names (Mary): reads it and runs it
 *   admin       the Board area's admins (Peter, Holly): reads it and runs it
 *
 * What an advisor gets is an allow-list built here. portalData (the board's) is
 * never called: advisors hold no fiduciary, budget or voting authority, so bank
 * balances, budgets, named gifts, costs, board minutes and papers, family
 * applications and hidden kids aren't in what's sent to them at all.
 *
 * Every table is the advisors' own, the way board_practice is its own: nothing
 * that reads the board's tables can reach these, or the other way round.
 * Contacts in an introduction live here in D1, never in site content (the repo
 * is public). No advisor's private email is ever sent to another advisor;
 * advisory@soardcharity.com reaches the group (./_board-group.js keeps it).
 */

import { peopleRows, privateEmails, readState, writeState, normEmail, activeAdvisors, isBoardAdmin, ADVISORY_COMMITTEE } from './_board-roles.js';
import { isEmail } from './_broadcast-notify.js';
import { todayEastern } from './_reveals.js';
import { photoUrl } from '../../public/admin/team-shared.js';

export const GROUP_ADDRESS = 'advisory@soardcharity.com';
const STATE = 'advisory';

export const INTRO_STATUSES = [
  { id: 'thanks', label: 'Thanks', sub: 'We have it and we’ll take a look' },
  { id: 'talking', label: 'Talking', sub: 'We’re in touch with them' },
  { id: 'yes', label: 'Said yes', sub: 'They’re helping SOARD' },
  { id: 'not-now', label: 'Not now', sub: 'Not the right time' },
];
export const INTRO_HELP = [
  { id: 'donor', label: 'Could give' },
  { id: 'sponsor', label: 'Could sponsor' },
  { id: 'vendor', label: 'Trade or vendor' },
  { id: 'volunteer', label: 'Could volunteer' },
];
export const HOSTED_STATUSES = [
  { id: 'new', label: 'New' },
  { id: 'approved', label: 'Approved' },
  { id: 'not-now', label: 'Not now' },
  { id: 'done', label: 'Held' },
];
/** The papers and the words the Fundraise page shows, each edited in the admin */
/** The shelves on their Documents page. Staff add to any of them */
export const SHELVES = [
  { id: 'about', label: 'About SOARD', sub: 'Who we are and what we do' },
  { id: 'marketing', label: 'Marketing', sub: 'What to share, and how' },
  { id: 'donors', label: 'For donors and sponsors', sub: 'What a company or a matching program asks for' },
  { id: 'group', label: 'For the group', sub: 'How the Advisory Board works' },
];
export const DOC_KINDS = [
  { id: 'agreement', label: 'Advisor agreement', sign: true },
  { id: 'overview', label: 'Overview' },
  { id: 'pitch', label: '30-second pitch' },
  { id: 'post', label: 'Post to share' },
  { id: 'sponsor', label: 'Sponsor one-pager' },
  { id: 'matching', label: 'Employer matching steps' },
  { id: 'hosting', label: 'How to host a fundraiser' },
  { id: 'library', label: 'Document' },
];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS advisory_asks (id TEXT PRIMARY KEY, data TEXT NOT NULL, sent_at TEXT, closed_at TEXT, at TEXT NOT NULL, by TEXT)',
  'CREATE TABLE IF NOT EXISTS advisory_answers (ask_id TEXT NOT NULL, slug TEXT NOT NULL, answer TEXT NOT NULL, note TEXT, at TEXT NOT NULL, via TEXT, PRIMARY KEY (ask_id, slug))',
  'CREATE TABLE IF NOT EXISTS advisory_wishlist (id TEXT PRIMARY KEY, data TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, by TEXT)',
  // Whose introduction it is is `slug`; the person introduced is in data, private to staff, the lead and that advisor
  'CREATE TABLE IF NOT EXISTS advisory_intros (id TEXT PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_advisory_intros_slug ON advisory_intros(slug)',
  'CREATE TABLE IF NOT EXISTS advisory_hosted (id TEXT PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)',
  // One row per advisor: when their year runs and when they last renewed. left_on when they stepped off
  'CREATE TABLE IF NOT EXISTS advisory_terms (slug TEXT PRIMARY KEY, started_on TEXT, ends_on TEXT, renewed_on TEXT, left_on TEXT)',
  'CREATE TABLE IF NOT EXISTS advisory_docs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT)',
  'CREATE TABLE IF NOT EXISTS advisory_signatures (doc_id TEXT NOT NULL, slug TEXT NOT NULL, year INTEGER NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, at TEXT NOT NULL, PRIMARY KEY (doc_id, slug, year))',
  // A gift from another Zeffy campaign credited to an advisor: only which payment and who; the amount is read live, so a refund falls out
  'CREATE TABLE IF NOT EXISTS advisory_credits (payment_id TEXT PRIMARY KEY, slug TEXT, note TEXT, at TEXT NOT NULL, by TEXT)',
];
const ready = new WeakSet();
export async function ensureAdvisory(DB) {
  if (ready.has(DB)) return;
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  ready.add(DB);
}

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const parse = (s, d = {}) => { try { return JSON.parse(s || '') ?? d; } catch { return d; } };
const clean = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (v, max = 4000) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
/** A web address someone typed: "zeffy.com/x" gets its https://; anything that isn't one is refused, never quietly dropped */
export function webLink(v) {
  const t = clean(v, 400);
  if (!t) return '';
  const u = /^https?:\/\//i.test(t) ? t.replace(/^http:/i, 'https:') : `https://${t}`;
  if (!/^https:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(u)) throw Object.assign(new Error('That doesn’t look like a web address. Paste the whole link.'), { status: 400 });
  return u;
}
const plusYear = (date) => `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
export const newId = (prefix) => `${prefix}_${[...crypto.getRandomValues(new Uint8Array(9))].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('')}`;
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const ID = /^[a-z]+_[a-z2-7]{6,24}$/;
export const isId = (s) => ID.test(String(s || ''));

// ─── Settings ───────────────────────────────────────────────────────

const DEFAULTS = {
  // Peter, Nov 5 2026: "mary runs the advisory"
  lead: 'mary-atchley',
  goal: 25000,
  // The first seven joined Oct 22 2026; everyone's year runs together, so one term date serves the group
  termStart: '2026-10-22',
  termEnd: '2027-10-22',
  // The emails to advisors are off until someone turns them on (they're people outside SOARD)
  emails: false,
  // Zeffy: the peer-to-peer campaign's id, and each advisor's page as { campaign id: slug }
  campaignId: '',
  campaignUrl: '',
  pages: {},
  // The kid the group is sponsoring, once one is picked (./_advisory-sponsor.js)
  kid: '',
  // Money rolled over from an earlier term: [{ term, amount }]
  carried: [],
};
export async function getSettings(DB) {
  const saved = await readState(DB, STATE);
  return { ...DEFAULTS, ...saved, pages: saved.pages || {}, carried: Array.isArray(saved.carried) ? saved.carried : [] };
}
export async function saveSettings(DB, patch) {
  const cur = await getSettings(DB);
  const next = { ...cur };
  if ('lead' in patch) next.lead = clean(patch.lead, 120);
  if ('goal' in patch) {
    const n = Number(patch.goal);
    if (patch.goal === '' || patch.goal == null || !Number.isFinite(n) || n <= 0 || n > 10_000_000) throw err('Type the goal in dollars');
    next.goal = Math.round(n);
  }
  for (const k of ['termStart', 'termEnd']) if (k in patch) {
    if (!isDate(patch[k])) throw err('Pick a date');
    next[k] = patch[k];
  }
  if (next.termEnd <= next.termStart) throw err('The term has to end after it starts');
  if ('emails' in patch) next.emails = patch.emails === true;
  if ('campaignId' in patch) next.campaignId = clean(patch.campaignId, 80);
  if ('campaignUrl' in patch) next.campaignUrl = webLink(patch.campaignUrl);
  if ('pages' in patch && patch.pages && typeof patch.pages === 'object') next.pages = patch.pages;
  if ('kid' in patch) next.kid = clean(patch.kid, 120);
  if ('carried' in patch && Array.isArray(patch.carried)) next.carried = patch.carried;
  if ('seeded' in patch) next.seeded = patch.seeded === true;
  if ('library' in patch) next.library = patch.library === true;
  // Which of the board's papers advisors can open, chosen one by one: nothing here means none
  if ('boardDocs' in patch) next.boardDocs = Array.isArray(patch.boardDocs) ? [...new Set(patch.boardDocs.map(String).filter((x) => /^d_[a-z0-9]{4,24}$/.test(x)))] : [];
  await writeState(DB, STATE, next);
  return next;
}

// ─── Who's looking ──────────────────────────────────────────────────

/**
 * The person looking, from what the middleware found: { kind, slug, name, email, runs, answers } or null.
 * runs: may use the tools that run the group. answers: an advisor themself (only they answer, sign and introduce).
 */
export async function whoIs(context) {
  const { env, data } = context;
  await ensureAdvisory(env.DB);
  const settings = await getSettings(env.DB);
  if (data?.advisor) return { kind: 'advisor', ...data.advisor, runs: false, answers: true };
  if (data?.boardMember) {
    const m = data.boardMember;
    const lead = m.slug === settings.lead;
    if (lead) return { kind: 'lead', ...m, runs: true, answers: false };
    if ((m.committees || []).includes(ADVISORY_COMMITTEE)) return { kind: 'committee', ...m, runs: false, answers: false };
    return null;
  }
  if (await isBoardAdmin(env.DB, data?.userEmail)) return { kind: 'admin', slug: '', name: '', email: data.userEmail, runs: true, answers: false };
  return null;
}

/** The advisors as advisors see each other: a photo, a company, a public bio. Never a private email */
export async function advisorCards(DB) {
  const people = await peopleRows(DB);
  return people.filter((p) => p.group === 'advisory' && p.status === 'active' && !p.draft)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((p) => ({
      slug: p.slug, name: p.name, photo: p.photo ? photoUrl(p, 240) : '', organization: p.organization || '',
      bio: clean(p.bio, 600), linkedin: /^https:\/\/\S+$/.test(p.linkedin || '') ? p.linkedin : '',
    }));
}

/** The person running the group, as the page shows them */
export async function leadCard(DB, settings) {
  const people = await peopleRows(DB);
  const p = people.find((x) => x.slug === settings.lead);
  return p ? { slug: p.slug, name: p.name, photo: p.photo ? photoUrl(p, 240) : '' } : null;
}

// ─── The monthly ask ────────────────────────────────────────────────

const askOf = (r) => ({ id: r.id, ...parse(r.data), sentAt: r.sent_at || '', closedAt: r.closed_at || '', at: r.at, by: r.by || '' });

export async function listAsks(DB) {
  await ensureAdvisory(DB);
  const rows = (await DB.prepare('SELECT * FROM advisory_asks ORDER BY at DESC').all()).results || [];
  return rows.map(askOf);
}
/** Written, not yet out: `out` puts it on the page (and in the monthly email when that's on) */
export async function saveAsk(DB, raw, { by = '', now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  const title = clean(raw.title, 140);
  if (!title) throw err('What’s the ask?');
  const data = { title, body: cleanText(raw.body, 1500), link: webLink(raw.link) };
  const id = isId(raw.id) ? raw.id : newId('ask');
  const had = await DB.prepare('SELECT id FROM advisory_asks WHERE id = ?').bind(id).first();
  if (had) await DB.prepare('UPDATE advisory_asks SET data = ? WHERE id = ?').bind(JSON.stringify(data), id).run();
  else await DB.prepare('INSERT INTO advisory_asks (id, data, at, by) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(data), nowIso(now), by).run();
  return askOf(await DB.prepare('SELECT * FROM advisory_asks WHERE id = ?').bind(id).first());
}
/** Only one ask is out at a time: the page has one thing on it, and the last one closes when the next goes out */
export async function putAskOut(DB, id, { now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  const row = await DB.prepare('SELECT id, sent_at FROM advisory_asks WHERE id = ?').bind(id).first();
  if (!row) throw err('That ask is gone', 404);
  await DB.prepare('UPDATE advisory_asks SET closed_at = ? WHERE sent_at IS NOT NULL AND closed_at IS NULL AND id != ?').bind(nowIso(now), id).run();
  await DB.prepare('UPDATE advisory_asks SET sent_at = COALESCE(sent_at, ?), closed_at = NULL WHERE id = ?').bind(nowIso(now), id).run();
  return askOf(await DB.prepare('SELECT * FROM advisory_asks WHERE id = ?').bind(id).first());
}
export async function closeAsk(DB, id, { now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  await DB.prepare('UPDATE advisory_asks SET closed_at = ? WHERE id = ?').bind(nowIso(now), id).run();
}
export async function deleteAsk(DB, id) {
  await ensureAdvisory(DB);
  // One that went out has answers: a stale tab can't wipe them. Close it instead
  const row = await DB.prepare('SELECT sent_at FROM advisory_asks WHERE id = ?').bind(id).first();
  if (row?.sent_at) throw err('That ask has gone out, so it stays on the record. Close it instead.', 409);
  await DB.prepare('DELETE FROM advisory_answers WHERE ask_id = ?').bind(id).run();
  await DB.prepare('DELETE FROM advisory_asks WHERE id = ?').bind(id).run();
}
export async function currentAsk(DB) {
  await ensureAdvisory(DB);
  const row = await DB.prepare('SELECT * FROM advisory_asks WHERE sent_at IS NOT NULL AND closed_at IS NULL ORDER BY sent_at DESC').first();
  return row ? askOf(row) : null;
}
export async function answerAsk(DB, askId, slug, { answer, note = '', via = 'page' }, { now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  if (!['yes', 'no'].includes(answer)) throw err('Choose an answer');
  const ask = await DB.prepare('SELECT id, sent_at, closed_at FROM advisory_asks WHERE id = ?').bind(askId).first();
  if (!ask) throw err('That ask is gone', 404);
  if (!ask.sent_at) throw err('That ask isn’t out yet', 409);
  if (ask.closed_at) throw err('That ask has closed', 409);
  await DB.prepare('INSERT OR REPLACE INTO advisory_answers (ask_id, slug, answer, note, at, via) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(askId, slug, answer, cleanText(note, 800), nowIso(now), via).run();
  return { answer, note: cleanText(note, 800) };
}
export async function answersTo(DB, askId) {
  await ensureAdvisory(DB);
  return (await DB.prepare('SELECT slug, answer, note, at, via FROM advisory_answers WHERE ask_id = ?').bind(askId).all()).results || [];
}

// ─── Who we're looking for ──────────────────────────────────────────

export async function listWishes(DB) {
  await ensureAdvisory(DB);
  const rows = (await DB.prepare('SELECT * FROM advisory_wishlist ORDER BY sort, at').all()).results || [];
  return rows.map((r) => ({ id: r.id, ...parse(r.data), sort: r.sort }));
}
export async function saveWish(DB, raw, { by = '', now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  const title = clean(raw.title, 140);
  if (!title) throw err('Who are we looking for?');
  const data = { title, detail: clean(raw.detail, 400) };
  const id = isId(raw.id) ? raw.id : newId('w');
  const had = await DB.prepare('SELECT id FROM advisory_wishlist WHERE id = ?').bind(id).first();
  if (had) await DB.prepare('UPDATE advisory_wishlist SET data = ? WHERE id = ?').bind(JSON.stringify(data), id).run();
  else {
    const last = await DB.prepare('SELECT MAX(sort) AS n FROM advisory_wishlist').first();
    await DB.prepare('INSERT INTO advisory_wishlist (id, data, sort, at, by) VALUES (?, ?, ?, ?, ?)').bind(id, JSON.stringify(data), (Number(last?.n) || 0) + 1, nowIso(now), by).run();
  }
  return (await listWishes(DB)).find((w) => w.id === id);
}
export async function deleteWish(DB, id) {
  await ensureAdvisory(DB);
  await DB.prepare('DELETE FROM advisory_wishlist WHERE id = ?').bind(id).run();
}

// ─── Introductions ──────────────────────────────────────────────────

const introOf = (r) => ({ id: r.id, slug: r.slug, status: r.status, ...parse(r.data), at: r.at, updatedAt: r.updated_at, updatedBy: r.updated_by || '' });

export async function addIntro(DB, slug, raw, { now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  const name = clean(raw.name, 120);
  if (!name) throw err('Who are you introducing?');
  const email = normEmail(raw.email);
  if (email && !isEmail(email)) throw err('That email doesn’t look right');
  const help = (Array.isArray(raw.help) ? raw.help : []).filter((h) => INTRO_HELP.some((x) => x.id === h));
  const data = {
    name, company: clean(raw.company, 120), email, phone: clean(raw.phone, 40), how: cleanText(raw.how, 800), help,
    wish: isId(raw.wish) ? raw.wish : '',
  };
  const id = newId('in');
  await DB.prepare('INSERT INTO advisory_intros (id, slug, status, data, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, slug, 'thanks', JSON.stringify(data), nowIso(now), nowIso(now)).run();
  return introOf(await DB.prepare('SELECT * FROM advisory_intros WHERE id = ?').bind(id).first());
}
/** Only their own: what an advisor sees of the introductions */
export async function introsBy(DB, slug) {
  await ensureAdvisory(DB);
  return ((await DB.prepare('SELECT * FROM advisory_intros WHERE slug = ? ORDER BY at DESC').bind(slug).all()).results || []).map(introOf);
}
export async function listIntros(DB) {
  await ensureAdvisory(DB);
  return ((await DB.prepare('SELECT * FROM advisory_intros ORDER BY at DESC').all()).results || []).map(introOf);
}
export async function setIntroStatus(DB, id, { status, note }, { by = '', now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  if (!INTRO_STATUSES.some((s) => s.id === status)) throw err('Choose where it stands');
  const row = await DB.prepare('SELECT * FROM advisory_intros WHERE id = ?').bind(id).first();
  if (!row) throw err('That introduction is gone', 404);
  const data = { ...parse(row.data), ...(note !== undefined ? { note: cleanText(note, 800) } : {}) };
  await DB.prepare('UPDATE advisory_intros SET status = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(status, JSON.stringify(data), nowIso(now), by, id).run();
  return { intro: introOf(await DB.prepare('SELECT * FROM advisory_intros WHERE id = ?').bind(id).first()), changed: row.status !== status };
}

// ─── Hosting a fundraiser ───────────────────────────────────────────

const hostedOf = (r) => ({ id: r.id, slug: r.slug, status: r.status, ...parse(r.data), at: r.at, updatedAt: r.updated_at, updatedBy: r.updated_by || '' });

export async function requestHost(DB, slug, raw, { now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  const title = clean(raw.title, 140);
  if (!title) throw err('What’s the idea?');
  const data = { title, when: clean(raw.when, 120), where: clean(raw.where, 200), expected: clean(raw.expected, 120), notes: cleanText(raw.notes, 1500) };
  const id = newId('h');
  await DB.prepare('INSERT INTO advisory_hosted (id, slug, status, data, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, slug, 'new', JSON.stringify(data), nowIso(now), nowIso(now)).run();
  return hostedOf(await DB.prepare('SELECT * FROM advisory_hosted WHERE id = ?').bind(id).first());
}
export async function listHosted(DB) {
  await ensureAdvisory(DB);
  return ((await DB.prepare('SELECT * FROM advisory_hosted ORDER BY at DESC').all()).results || []).map(hostedOf);
}
export async function setHosted(DB, id, { status, note, date, giveUrl }, { by = '', now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  if (!HOSTED_STATUSES.some((s) => s.id === status)) throw err('Choose where it stands');
  const row = await DB.prepare('SELECT * FROM advisory_hosted WHERE id = ?').bind(id).first();
  if (!row) throw err('That request is gone', 404);
  if (date && !isDate(date)) throw err('Pick a date');
  const data = {
    ...parse(row.data), ...(note !== undefined ? { note: cleanText(note, 800) } : {}), ...(date !== undefined ? { date } : {}),
    // Its own Zeffy page, so the money it raises counts toward the goal
    ...(giveUrl !== undefined ? { giveUrl: webLink(giveUrl) } : {}),
  };
  await DB.prepare('UPDATE advisory_hosted SET status = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(status, JSON.stringify(data), nowIso(now), by, id).run();
  return { hosted: hostedOf(await DB.prepare('SELECT * FROM advisory_hosted WHERE id = ?').bind(id).first()), changed: row.status !== status };
}

// ─── Terms ──────────────────────────────────────────────────────────

/** Each advisor's term: their row, else the group's dates. { started, ends, renewedOn, left } */
export async function termOf(DB, slug, settings) {
  await ensureAdvisory(DB);
  const r = await DB.prepare('SELECT * FROM advisory_terms WHERE slug = ?').bind(slug).first();
  return { started: r?.started_on || settings.termStart, ends: r?.ends_on || settings.termEnd, renewedOn: r?.renewed_on || '', left: r?.left_on || '' };
}
export async function allTerms(DB, settings) {
  await ensureAdvisory(DB);
  const rows = (await DB.prepare('SELECT * FROM advisory_terms').all()).results || [];
  const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
  return (slug) => {
    const r = by[slug];
    return { started: r?.started_on || settings.termStart, ends: r?.ends_on || settings.termEnd, renewedOn: r?.renewed_on || '', left: r?.left_on || '' };
  };
}
/** How many days before a term ends the page offers Renew */
export const RENEW_DAYS = 60;
export const canRenew = (term, today) => {
  if (!isDate(term.ends) || term.left) return false;
  const days = Math.round((Date.parse(`${term.ends}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  return days <= RENEW_DAYS;
};
export async function renew(DB, slug, settings, { now = Date.now() } = {}) {
  const term = await termOf(DB, slug, settings);
  const today = todayEastern(now);
  if (!canRenew(term, today)) throw err('Renewing opens closer to the end of your term', 409);
  const ends = plusYear(term.ends > today ? term.ends : today);
  await DB.prepare('INSERT INTO advisory_terms (slug, started_on, ends_on, renewed_on) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET ends_on = excluded.ends_on, renewed_on = excluded.renewed_on, left_on = NULL')
    .bind(slug, term.started, ends, today).run();
  return termOf(DB, slug, settings);
}
export async function setTerm(DB, slug, { ends, left }, settings) {
  await ensureAdvisory(DB);
  const term = await termOf(DB, slug, settings);
  if (ends !== undefined && !isDate(ends)) throw err('Pick a date');
  await DB.prepare('INSERT INTO advisory_terms (slug, started_on, ends_on, renewed_on, left_on) VALUES (?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET ends_on = excluded.ends_on, left_on = excluded.left_on')
    .bind(slug, term.started, ends ?? term.ends, term.renewedOn || null, left === undefined ? term.left || null : left || null).run();
  return termOf(DB, slug, settings);
}

// ─── Papers and words ───────────────────────────────────────────────

const docOf = (r) => ({ id: r.id, ...parse(r.data), updatedAt: r.updated_at || '', updatedBy: r.updated_by || '' });

export async function listDocs(DB) {
  await ensureAdvisory(DB);
  const rows = (await DB.prepare('SELECT * FROM advisory_docs').all()).results || [];
  const docs = rows.map(docOf);
  if (!docs.length) return docs;
  // Files live with the board's (private R2, ./_board.js putFile), under their own owner type
  const files = (await DB.prepare("SELECT id, owner_id, name, type, size, at FROM board_files WHERE owner_type = 'advisory-doc'").all().catch(() => ({ results: [] }))).results || [];
  return docs.sort((a, b) => (a.sort || 0) - (b.sort || 0)).map((d) => ({ ...d, files: files.filter((f) => f.owner_id === d.id).map(({ owner_id, ...f }) => f) }));
}
export async function saveDoc(DB, raw, { by = '', now = Date.now(), base = null } = {}) {
  await ensureAdvisory(DB);
  if (!DOC_KINDS.some((k) => k.id === raw.kind)) throw err('Which kind of paper is it?');
  const title = clean(raw.title, 160);
  if (!title) throw err('Give it a title');
  const id = isId(raw.id) ? raw.id : newId('ad');
  const row = await DB.prepare('SELECT * FROM advisory_docs WHERE id = ?').bind(id).first();
  const cur = row ? parse(row.data) : {};
  // Someone deleted it while this was open: saving doesn't bring it back, or the file that went with it
  if (!row && base) throw err('Someone deleted this paper since you opened it', 410);
  // Two people on one paper: the second is told, and their words stay on their screen
  if (row && base && row.updated_at !== base) throw Object.assign(err(`${row.updated_by || 'Someone'} saved this paper since you opened it`, 409), { current: docOf(row) });
  const body = cleanText(raw.body, 20000);
  const version = (cur.version || 0) + (row && cur.body !== body ? 1 : row ? 0 : 1);
  // (an editor that doesn't send these keeps them)
  const url = 'url' in raw ? webLink(raw.url) : cur.url || '';
  const sort = 'sort' in raw ? Number(raw.sort) || 0 : cur.sort || 0;
  const library = raw.kind === 'library';
  const shelf = !library ? '' : SHELVES.some((s) => s.id === raw.shelf) ? raw.shelf : cur.shelf || '';
  if (library && !shelf) throw err('Which shelf does it go on?');
  const note = !library ? '' : 'note' in raw ? clean(raw.note, 200) : cur.note || '';
  const data = { kind: raw.kind, title, body, url, shared: raw.shared !== false, version, sort, ...(library ? { shelf, note } : {}) };
  await DB.prepare('INSERT OR REPLACE INTO advisory_docs (id, data, updated_at, updated_by) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(data), nowIso(now), by).run();
  return (await listDocs(DB)).find((d) => d.id === id);
}
/** A first-day paper. Only into an empty place: never over one someone has since edited */
export async function addDocOnce(DB, id, raw, { by = '', now = Date.now() } = {}) {
  await ensureAdvisory(DB);
  const data = { kind: raw.kind, title: raw.title, body: raw.body || '', url: raw.url || '', shared: true, version: 1, sort: raw.sort || 0, shelf: raw.shelf, note: raw.note || '' };
  await DB.prepare('INSERT OR IGNORE INTO advisory_docs (id, data, updated_at, updated_by) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(data), nowIso(now), by).run();
}
export async function deleteDoc(DB, id) {
  await ensureAdvisory(DB);
  await DB.prepare('DELETE FROM advisory_signatures WHERE doc_id = ?').bind(id).run();
  await DB.prepare('DELETE FROM advisory_docs WHERE id = ?').bind(id).run();
}
/** A file's owner, for ./advisory-file.js: a shared paper of the advisors', and nothing else */
export async function isSharedDoc(DB, id) {
  await ensureAdvisory(DB);
  const row = await DB.prepare('SELECT data FROM advisory_docs WHERE id = ?').bind(id).first();
  return !!row && parse(row.data).shared !== false;
}
export async function signDoc(DB, docId, who, name, { now = Date.now(), version = null } = {}) {
  await ensureAdvisory(DB);
  const row = await DB.prepare('SELECT * FROM advisory_docs WHERE id = ?').bind(docId).first();
  const doc = row && docOf(row);
  if (!doc || doc.shared === false) throw err('That paper is gone', 404);
  if (!DOC_KINDS.find((k) => k.id === doc.kind)?.sign) throw err('That paper isn’t one to sign');
  // They sign the words they read: a paper changed while it was open goes back to them first
  if (Number(version) !== Number(doc.version || 1)) throw Object.assign(err('These words have changed. Read the new version, then sign.', 409), { changed: true });
  const typed = clean(name, 120);
  const same = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.'’-]/g, '').replace(/\s+/g, ' ').trim();
  if (!typed || same(typed) !== same(who.name)) throw err(`Type your name as ${who.name} to sign`);
  const year = Number(todayEastern(now).slice(0, 4));
  await DB.prepare('INSERT OR REPLACE INTO advisory_signatures (doc_id, slug, year, name, version, at) VALUES (?, ?, ?, ?, ?, ?)').bind(docId, who.slug, year, typed, doc.version || 1, nowIso(now)).run();
  return { year, name: typed, at: nowIso(now) };
}
/** { doc id: { slug: { year, name, at, version } } }, each advisor's latest */
export async function signatures(DB) {
  await ensureAdvisory(DB);
  const rows = (await DB.prepare('SELECT * FROM advisory_signatures ORDER BY year').all()).results || [];
  const out = {};
  for (const r of rows) (out[r.doc_id] ||= {})[r.slug] = { year: r.year, name: r.name, at: r.at, version: r.version };
  return out;
}

// ─── A name change or a removal ─────────────────────────────────────

/** Their records follow a renamed advisor (./rename-content.js) */
export const SLUG_TABLES = ['advisory_answers', 'advisory_intros', 'advisory_hosted', 'advisory_terms', 'advisory_signatures', 'advisory_credits'];
export async function moveSlug(DB, from, to) {
  await ensureAdvisory(DB);
  for (const t of SLUG_TABLES) await DB.prepare(`UPDATE OR IGNORE ${t} SET slug = ? WHERE slug = ?`).bind(to, from).run();
  try { await DB.prepare('UPDATE advisory_links SET slug = ? WHERE slug = ?').bind(to, from).run(); } catch { /* no links yet */ }
  // Who's on a meeting's list and who answered are in its record
  try {
    const rows = (await DB.prepare('SELECT id, data FROM advisory_meetings WHERE data LIKE ?').bind(`%"${from}"%`).all()).results || [];
    for (const r of rows) await DB.prepare('UPDATE advisory_meetings SET data = ? WHERE id = ?').bind(r.data.split(`"${from}"`).join(`"${to}"`), r.id).run();
  } catch { /* no meetings yet */ }
  const s = await getSettings(DB);
  const pages = Object.fromEntries(Object.entries(s.pages).map(([k, v]) => [k, v === from ? to : v]));
  await saveSettings(DB, { pages, ...(s.lead === from ? { lead: to } : {}) });
}

/** Everyone's sign-in for Access (./_board-access.js): only advisors who are active and published */
export const advisorSignIns = async (DB) => [...new Set((await activeAdvisors(DB)).map((a) => a.email).filter(isEmail))];

/** Advisors with no email on file: they can't sign in yet */
export async function missingEmails(DB) {
  const [people, emails] = await Promise.all([peopleRows(DB), privateEmails(DB)]);
  return people.filter((p) => p.group === 'advisory' && p.status === 'active' && !p.draft && !isEmail(emails[p.slug] || '')).map((p) => ({ slug: p.slug, name: p.name }));
}
