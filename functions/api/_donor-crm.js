/**
 * Donors & Partners: what only the site knows about who gives (Admin → Donors & Partners, public/admin/donors.js)
 * ===========================================================================
 * Zeffy keeps every gift and contact (./_donors.js reads them into donor_payments). The site keeps, privately in D1,
 * what a person said about them. Never in a partner record: those are public (the repo, llms-full.txt, JobTread).
 *   - Which organization a Zeffy contact is, or a company named on a payment: a partner on the website, or one the
 *     site keeps privately (donor_orgs). The same name links by itself; a near one is asked about first (Needs you).
 *   - Which two donors are one person ("Same donor?").
 *   - "Keep anonymous" on a person or an organization. The board's gift list honors it too.
 *   - Answers to the site's suggestions (a partner's level by giving, a big giver not on the website), so it doesn't
 *     ask again for a year.
 *   - Who on the team looks after a donor (their owner), and the team's notes about them (donor_notes).
 * Every answer is one row of donor_calls: { kind, subject, target, answer, note, by, at }. Thank-yous are
 * ./_donor-thanks.js's. Every change is in History under the donor it's about (entity type donor-crm, never waiting
 * for Publish).
 *
 * Who a gift counts for (one rule, ownerOf): an answer about that payment; else the organization its paying contact
 * is; else the organization the company it was given for is (a donor-advised fund's name never counts: the gift is
 * the donor's, as Checks has it); else the person who paid. When the contact's organization and the company's differ,
 * the contact's counts and Needs you asks. A partner that's deleted stops counting until it's restored; Merge into
 * moves everything said about it to the partner it went into (mergeOrgCalls, from ./_room-credits.js).
 *
 * When Zeffy merges two contacts, the one that's gone leaves its payments with the other (./_donors.js keeps the
 * contact each payment had): what was said about it follows them (followMerges). If they went to several contacts, a
 * person decides (Needs you); nothing is dropped.
 */
import { allRows, rowsFor, donorsView, donorView, giftsView, donorOf, ensureDonors, readDonorState, isOrgKey, personKeys, keyOfRef, refOfKey, donorOfPayment, noteDonorPayment, READ_COLS, giftsFrom } from './_donors.js';
/** How many gifts some charges are, as the list and the gift list count them (a gift Zeffy took in several charges is one) */
const giftCount = (rows) => giftsFrom(rows.filter((r) => Number(r.giving) > 0)).length;
import { kidNames } from './_board-gifts.js';
import { givenName, zeffyGet } from './_zeffy.js';
import { nameKey, nearPartners, categoriesOf, levelOf } from '../../public/admin/partners-shared.js';
import { logAudit } from './_audit.js';
import { staffDirectory } from './_staff-access.js';
import { isStaffEmail, NOT_STAFF } from './_board-roles.js';
import { thanksToDo, thanksFor, markThanks, markChanged, WHY as THANK_WHY } from './_donor-thanks.js';

const DAY = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY;
// Champion on the Partners page: "Major sponsors: $10K or more" (partners-shared.js LEVELS), over the last 12 months
export const CHAMPION_CENTS = 1000000;
// A contact's name that reads as an organization's (a foundation, a company or a club that gives under its own name).
// A person's name can have one of these words in it ("Church"): "It’s a person" answers that for good
export const ORG_WORDS = /\b(foundation|fund|trust|inc|llc|pllc|llp|ltd|corp|corporation|company|church|association|bank|holdings|enterprises|ministry|ministries|society|institute|council|charitable|club|group|partners|associates|services|consultants|construction|builders|homes|realty|properties|school|academy|university)\b|\bco\.(?=\s|$)|&\s*co\b/i;
const NAME_STOP = new Set(['the', 'and', 'of', 'inc', 'llc', 'co', 'corp', 'company', 'group', 'ltd', 'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'ii', 'iii', 'iv']);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const words = (s) => clean(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((t) => t && !NAME_STOP.has(t));
const missingTable = (e) => /no such table/i.test(String(e?.message || e));
// For hiding only (never for counting): a name with its accents, legal endings and plurals set aside, so "Acme
// Builders, L.L.C.", "Acme Builder Corporation" and "Acmé Builders" are all Acme Builders
const LOOSE_STOP = new Set(['the', 'and', 'of', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'group', 'foundation', 'fund', 'trust', 'pc', 'pllc', 'lp', 'llp']);
const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
/** Two loose keys that are one name typed a little differently (a typo, one letter); never one name inside another */
const closeKeys = (a, b) => {
  if (a === b) return true;
  const m = Math.max(a.length, b.length);
  if (m < 5 || Math.abs(a.length - b.length) > Math.max(1, Math.floor(m * 0.12))) return false;
  return 1 - lev(a, b) / m >= 0.88;
};
/** Every name a partner's saved versions had (renames in the Partners editor) */
async function historyNames(DB, slug) {
  try {
    const r = (await DB.prepare("SELECT data FROM content_versions WHERE collection = 'partners' AND slug = ?").bind(slug).all()).results || [];
    return [...new Set(r.map((v) => { try { return clean(JSON.parse(v.data || '{}').name); } catch { return ''; } }).filter(Boolean))];
  } catch (e) { if (missingTable(e)) return []; throw e; }
}
const looseWords = (name) => clean(name).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/\./g, '').replace(/['’]s\b/g, '')
  .split(/[^a-z0-9]+/).filter((t) => t && !LOOSE_STOP.has(t)).map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
export const looseKey = (name) => looseWords(name).join('');
looseKey.words = looseWords;
const iso = (ms) => new Date(ms).toISOString();

const SCHEMA = [
  // (name_key: its name in plain letters, as names are matched: two can't be saved with one, at the same moment either)
  'CREATE TABLE IF NOT EXISTS donor_orgs (key TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, by TEXT, name_key TEXT)',
  `CREATE TABLE IF NOT EXISTS donor_calls (kind TEXT NOT NULL, subject TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', answer INTEGER NOT NULL,
    note TEXT, by TEXT, at TEXT NOT NULL, PRIMARY KEY (kind, subject, target))`,
  // The team's notes about a donor (a person's or an organization's key), newest shown first
  'CREATE TABLE IF NOT EXISTS donor_notes (id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, by TEXT, at TEXT NOT NULL, edited_by TEXT, edited_at TEXT)',
  'CREATE INDEX IF NOT EXISTS donor_notes_subject ON donor_notes(subject)',
  // Each change to a note that was made, by the press that sent it: a page that never heard its answer asks
  'CREATE TABLE IF NOT EXISTS donor_note_edits (edit_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, at TEXT NOT NULL)',
];
const ready = new WeakSet();
export async function ensureCrm(DB) {
  if (ready.has(DB)) return;
  await ensureDonors(DB);
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  // Organizations kept before name_key: given it (once), so a new one or a rename is checked against every name
  try { await DB.prepare('ALTER TABLE donor_orgs ADD COLUMN name_key TEXT').run(); } catch (e) { if (!/duplicate column/i.test(String(e?.message || e))) throw e; }
  const unkeyed = (await DB.prepare('SELECT key, name FROM donor_orgs WHERE name_key IS NULL').all()).results || [];
  for (let i = 0; i < unkeyed.length; i += 50) await DB.batch(unkeyed.slice(i, i + 50).map((o) => DB.prepare('UPDATE donor_orgs SET name_key = ? WHERE key = ?').bind(orgNameKey(o.name), o.key)));
  // (keys given before a name with no plain letters had its own: given it now)
  const blank = (await DB.prepare("SELECT key, name FROM donor_orgs WHERE name_key = ''").all()).results || [];
  for (let i = 0; i < blank.length; i += 50) await DB.batch(blank.slice(i, i + 50).map((o) => DB.prepare('UPDATE donor_orgs SET name_key = ? WHERE key = ?').bind(orgNameKey(o.name), o.key)));
  await DB.prepare('CREATE INDEX IF NOT EXISTS donor_orgs_name_key ON donor_orgs(name_key)').run();
  ready.add(DB);
}

/** Partners as the CRM needs them (a missing table is none; any other failure stops, never "nobody is a partner") */
async function readPartners(DB) {
  try {
    const rows = (await DB.prepare('SELECT slug, data FROM partners').all()).results || [];
    return rows.map((r) => { let d = {}; try { d = JSON.parse(r.data || '{}'); } catch { /* a broken record is its slug */ } return { slug: r.slug, name: d.name || r.slug, level: d.level || 'friend', category: d.category }; });
  } catch (e) { if (missingTable(e)) return []; throw e; }
}

/** Everything the site knows about donors, read once for a request */
export async function loadCrm(DB, { now = Date.now() } = {}) {
  await ensureCrm(DB);
  const [partners, orgs, calls] = await Promise.all([
    readPartners(DB),
    DB.prepare('SELECT key, name, created_at FROM donor_orgs').all().then((r) => r.results || []),
    DB.prepare('SELECT kind, subject, target, answer, note, by, at FROM donor_calls ORDER BY at').all().then((r) => r.results || []),
  ]);
  // Every name a partner kept anonymous has had, from its saved versions (renamed in the Partners editor, deleted)
  const kept = [...new Set(calls.filter((c) => c.kind === 'anon' && c.answer && String(c.subject).startsWith('p:')).map((c) => String(c.subject).slice(2)))];
  const history = new Map();
  try {
    for (let i = 0; i < kept.length; i += 80) {
      const part = kept.slice(i, i + 80);
      const r = (await DB.prepare(`SELECT slug, data FROM content_versions WHERE collection = 'partners' AND slug IN (${part.map(() => '?').join(', ')})`).bind(...part).all()).results || [];
      for (const v of r) { let d = {}; try { d = JSON.parse(v.data || '{}'); } catch { /* unreadable: skipped */ } if (d.name) history.set(`p:${v.slug}`, [...(history.get(`p:${v.slug}`) || []), String(d.name)]); }
    }
  } catch (e) { if (!missingTable(e)) throw e; }
  // Each Zeffy contact's own names (as its own gifts give them): an organization of exactly that name is theirs
  const contactNames = await DB.prepare('SELECT DISTINCT contact, first, last FROM donor_payments WHERE contact IS NOT NULL').all()
    .then((r) => r.results || []).catch((e) => { if (missingTable(e)) return []; throw e; });
  // Zeffy contacts whose gifts Zeffy moved to several others (asked about in Needs you, or answered): no gifts of their own
  const st = await readCrmState(DB);
  const emptied = [...(st.unplaced || []).map((u) => String(u.contact)), ...calls.filter((c) => c.kind === 'moved').map((c) => String(c.subject))];
  return makeCrm({ partners, orgs, calls, now, history, contactNames, emptied });
}

/**
 * The rules over what's known (pure, so the tests and the board use the same): organizations, links, the same person,
 * keep anonymous, and who each payment counts for
 */
export function makeCrm({ partners = [], orgs = [], calls = [], now = Date.now(), history = new Map(), contactNames = [], emptied = [] } = {}) {
  const org = new Map();
  for (const p of partners) {
    const lv = levelOf(p.level).id;
    org.set(`p:${p.slug}`, { key: `p:${p.slug}`, name: p.name || p.slug, slug: p.slug, level: lv, levelLabel: levelOf(lv).label, funding: categoriesOf(p).includes('funding'), onSite: true });
  }
  for (const o of orgs) org.set(o.key, { key: o.key, name: o.name, onSite: false });
  const live = (k) => org.has(k);
  const byName = new Map();
  for (const o of org.values()) { const k = nameKey(o.name); if (k) byName.set(k, [...(byName.get(k) || []), o.key]); }
  /** The one organization with this name (two with it: neither, a person picks) */
  const exact = (name) => { const l = byName.get(nameKey(name)); return l?.length === 1 ? l[0] : null; };

  const yes = new Map();
  const no = new Set();
  const anon = new Map();
  const pay = new Map();
  const level = new Map();
  const big = new Map();
  const parent = new Map();
  const notSame = new Set();
  // An organization kept here that was put on the website: its old address leads to the partner
  const forward = new Map();
  // A contact Zeffy split between several, that a person has looked at (Needs you doesn't ask again)
  const movedDone = new Set();
  // Organizations kept here and taken out: key → where what was said about it went (the Zeffy record it was made from)
  const takenOut = new Map();
  // Names an organization had while kept anonymous (renamed, merged or deleted since: still hidden by name)
  const keptNameCalls = [];
  // Who on the team looks after a donor: key → { email, at }
  const owners = new Map();
  // A linked company's name as it was typed (the answer is under its plain-letters key)
  const companyNames = new Map();
  // Each owner answer as stored (subject → { answer, note, at }): a change checks none moved under it meanwhile
  const ownerCalls = new Map();
  // Organizations said to have no owner ("No one"): never one taken from a contact counted for them
  const ownerNone = new Set();
  // A person's key over another's: one with gifts of its own (a record Zeffy emptied never leads: their page's address
  // and every change on it go by the lead), a Zeffy contact (its address works in a link), then the earlier
  const gone = new Set(emptied.map((c) => `c:${c}`));
  const better = (a, b) => ((gone.has(a) ? 1 : 0) - (gone.has(b) ? 1 : 0) || (a.startsWith('c:') ? 0 : 1) - (b.startsWith('c:') ? 0 : 1) || (a < b ? -1 : 1)) < 0;
  const find = (k) => { let r = k; while (parent.has(r)) r = parent.get(r); return r; };
  // Every answer as read, by kind and subject: a change checks, in its own step, that none moved under it
  const rawBy = new Map();
  for (const c of calls) {
    const s = String(c.subject);
    const t = String(c.target || '');
    const rk = `${c.kind}\n${s}`;
    if (!rawBy.has(rk)) rawBy.set(rk, []);
    rawBy.get(rk).push([s, t, c.answer ? 1 : 0, c.note ?? null, c.at]);
    if (c.kind === 'contact' || c.kind === 'company') {
      if (c.answer) { yes.set(`${c.kind}\n${s}`, t); no.delete(`${c.kind}\n${s}\n${t}`); if (c.kind === 'company' && c.note) companyNames.set(s, String(c.note)); } else { no.add(`${c.kind}\n${s}\n${t}`); if (yes.get(`${c.kind}\n${s}`) === t) yes.delete(`${c.kind}\n${s}`); }
    } else if (c.kind === 'anon') anon.set(s, !!c.answer);
    else if (c.kind === 'payment') pay.set(s, String(c.note || ''));
    else if (c.kind === 'level') level.set(s, { answer: !!c.answer, at: c.at, note: c.note || null });
    // ("kept as an organization" counts only while that organization is here: taken out, the question can be answered again)
    else if (c.kind === 'big') { if (c.note === 'org' && !org.has(t)) continue; big.set(s, { at: c.at, person: c.note === 'person' }); }
    else if (c.kind === 'forward') forward.set(s, t);
    else if (c.kind === 'moved') movedDone.add(s);
    else if (c.kind === 'taken-out') takenOut.set(s, { to: t || null, name: c.note || null });
    else if (c.kind === 'owner') { ownerCalls.set(s, { answer: c.answer ? 1 : 0, note: c.note ?? null, at: c.at }); if (c.answer && c.note) { owners.set(s, { email: String(c.note), at: c.at }); ownerNone.delete(s); } else { owners.delete(s); ownerNone.add(s); } }
    else if (c.kind === 'kept-name' && c.answer) keptNameCalls.push([s, t, c.note || null]);
    else if (c.kind === 'same') {
      if (!c.answer) { notSame.add(`${s}\n${t}`); continue; }
      const ra = find(s);
      const rb = find(t);
      if (ra === rb) continue;
      if (better(ra, rb)) parent.set(rb, ra); else parent.set(ra, rb);
    }
  }
  const groups = new Map();
  for (const k of new Set([...parent.keys(), ...parent.values()])) { const r = find(k); groups.set(r, [...(groups.get(r) || []), k]); }
  const canon = (k) => find(String(k));
  const keysOf = (k) => { const r = canon(k); return groups.get(r) || [r]; };
  // "Not the same" holds between the two people, whichever of their records leads each of them now
  const notSameNow = new Set([...notSame].map((x) => x.split('\n').map(canon).sort().join('\n')));
  // A giver Zeffy had no contact for, kept anonymous by their email: still them when Zeffy later has a contact with it
  const emailsKept = new Set([...anon].filter(([k, on]) => on && k.startsWith('e:')).map(([k]) => k.slice(2)));
  // Every name of an organization kept anonymous, now and before: a gift under any of them is hidden on the board
  // By organization: its name now, the names its saved versions had, the names the site saw it under
  const keptNamesOf = new Map();
  const addName = (k, n) => { if (!clean(n)) return; if (!keptNamesOf.has(k)) keptNamesOf.set(k, new Map()); keptNamesOf.get(k).set(looseKey(n), clean(n)); };
  for (const [k, on] of anon) {
    if (!on || !isOrgKey(k)) continue;
    if (org.get(k)) addName(k, org.get(k).name);
    for (const n of history.get(k) || []) addName(k, n);
  }
  for (const [s, t, note] of keptNameCalls) if (anon.get(t)) { if (!keptNamesOf.has(t)) keptNamesOf.set(t, new Map()); keptNamesOf.get(t).set(s, note || keptNamesOf.get(t).get(s) || s); }
  const keptNames = new Set([...keptNamesOf.values()].flatMap((m) => [...m.keys()]).filter(Boolean));
  const keptList = [...keptNamesOf].flatMap(([k, m]) => [...m.values()].map((name) => ({ slug: k, name })));
  const orgsOfKeptName = new Map();
  for (const [k, m] of keptNamesOf) for (const lk of m.keys()) orgsOfKeptName.set(lk, [...(orgsOfKeptName.get(lk) || []), k]);
  // A name hidden on the board: a kept organization's name typed another way (legal endings, plurals, accents, a
  // typo), unless staff said that name isn't that organization. Worked out once a name for the whole request
  const keptNameMemo = new Map();
  const nameIsKept = (name, contact = null) => {
    const n = clean(name);
    if (!n || !keptNames.size) return false;
    const memo = `${n}\n${contact || ''}`;
    if (keptNameMemo.has(memo)) return keptNameMemo.get(memo);
    const lk = looseKey(n);
    const hit = !!lk && [...keptNames].some((k) => closeKeys(lk, k) && (orgsOfKeptName.get(k) || [])
      .some((o) => !no.has(`company\n${nameKey(n)}\n${o}`) && !(contact && no.has(`contact\n${contact}\n${o}`))));
    keptNameMemo.set(memo, hit);
    return hit;
  };

  /** The organization a payment's contact is: a person's link, else an organization with exactly its name */
  const contactOrgOf = (r) => {
    if (!r.contact) return null;
    const t = yes.get(`contact\n${r.contact}`);
    if (t) return live(t) ? t : null;
    const name = givenName({ first_name: r.first, last_name: r.last });
    const e = name ? exact(name) : null;
    return e && !no.has(`contact\n${r.contact}\n${e}`) ? e : null;
  };
  // What each Zeffy contact's own names make it (as its own gifts give them): an organization only when every name it
  // has is that one's. A person who once typed a company's name has that one gift counted for it, and stays a person
  const namesOf = new Map();
  for (const r of contactNames) namesOf.set(String(r.contact), (namesOf.get(String(r.contact)) || new Set()).add(contactOrgOf(r)));
  /** The organization a Zeffy contact is, as a whole (its link, or every name of it an organization's exact name) */
  const contactIsOrg = (c) => {
    const t = yes.get(`contact\n${c}`);
    if (t) return live(t) ? t : null;
    const s = namesOf.get(String(c));
    return s && s.size === 1 ? [...s][0] || null : null;
  };
  // Contacts that are an organization by their own name (not linked anywhere): the same everywhere it's asked
  const byNameOf = new Map();
  for (const c of namesOf.keys()) {
    if (yes.has(`contact\n${c}`)) continue;
    const o = contactIsOrg(c);
    if (o) byNameOf.set(o, new Set([...(byNameOf.get(o) || []), `c:${c}`]));
  }
  /** The organization the company a payment was given for is (a donor-advised fund's name never) */
  const companyOrgOf = (r) => {
    if (!r.corporate || !clean(r.company) || r.method === 'daf') return null;
    const k = nameKey(r.company);
    if (!k) return null;
    const t = yes.get(`company\n${k}`);
    if (t) return live(t) ? t : null;
    const e = exact(r.company);
    return e && !no.has(`company\n${k}\n${e}`) ? e : null;
  };
  const ownerOf = (r, person) => {
    const p = pay.get(String(r.id));
    if (p === 'person') return person;
    if (p && live(p)) return p;
    // (a gift with no contact of its own, placed with one that is an organization as a whole: that organization's)
    return contactOrgOf(r) || (r.borrowed ? contactIsOrg(r.contact) : null) || companyOrgOf(r) || person;
  };
  const keepAnonymous = (k) => (isOrgKey(k) ? !!anon.get(k) : keysOf(k).some((x) => anon.get(x)));
  /** Who looks after a donor (any record of a person: the latest said) → email or null */
  // A Zeffy contact counted for an organization (linked to it): what was said about the contact is the organization's
  const linkedTo = (k) => [...new Set([...[...yes].filter(([s2, t]) => t === String(k) && s2.startsWith('contact\n')).map(([s2]) => `c:${s2.slice(8)}`), ...(byNameOf.get(String(k)) || [])])];
  const lookedAfterBy = (k) => {
    const own = (isOrgKey(k) ? [String(k)] : keysOf(k)).map((x) => owners.get(x)).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
    if (own[0] || !isOrgKey(k) || ownerNone.has(String(k))) return own[0]?.email || null;
    // An organization with no owner of its own: the one said on a contact counted for it, the latest
    return linkedTo(k).map((x) => owners.get(x)).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.email || null;
  };

  /** Which of a person's records leads them, as canon chooses (one with gifts, a Zeffy contact, then the earlier) */
  const leadOf = (keys) => [...keys].map(String).sort((x, y) => (better(x, y) ? -1 : better(y, x) ? 1 : 0))[0] || null;
  return {
    org, live, exact, canon, keysOf, leadOf, contactOrgOf, contactIsOrg, companyOrgOf, ownerOf, keepAnonymous, lookedAfterBy, linkedTo, now,
    calls: { yes, no, pay, level, big, notSame: notSameNow, notSameRaw: notSame, forward, movedDone, takenOut },
    /** A linked company's name as typed when it was linked (its key, plain letters, is no name to show) */
    companyName: (k) => companyNames.get(String(k)) || null,
    /** Every "same person" answer with one of these on either side, as read: [[subject, target, answer, note, at]] */
    sameRowsOf: (keys) => { const set = new Set(keys.map(String)); return [...rawBy.entries()].filter(([k]) => k.startsWith('same\n')).flatMap(([, rows]) => rows).filter(([sub, tgt]) => set.has(sub) || set.has(tgt)); },
    /** The answers of one kind about these subjects, as read: [[subject, target, answer, note, at]] */
    rowsOf: (kind, subjects) => subjects.flatMap((sub) => rawBy.get(`${kind}\n${sub}`) || []),
    /** The owner answers stored under these keys, as read: [[subject, answer, note, at]] */
    ownerRows: (keys) => keys.filter((k) => ownerCalls.has(k)).map((k) => { const o = ownerCalls.get(k); return [k, o.answer, o.note, o.at]; }),
    /** The organizations with this name (any but `except`) */
    named: (name, except = null) => (byName.get(nameKey(name)) || []).filter((k) => k !== except),
    /** Is Keep anonymous on for exactly this key (not the person it leads to) */
    keptKey: (k) => !!anon.get(k),
    anyKeptAnonymous: [...anon.values()].some(Boolean),
    anyEmailKept: emailsKept.size > 0,
    /** The names a kept organization is hidden under (shown on its page), and every kept name (campaigns on the board) */
    keptNamesFor: (k) => [...(keptNamesOf.get(k)?.values() || [])],
    keptDisplayNames: () => [...new Set(keptList.map((x) => x.name))],
    /** Names the site has seen a kept organization under that it hasn't written down yet */
    unrecordedNames: () => [...keptNamesOf].flatMap(([k, m]) => [...m].filter(([lk]) => !keptNameCalls.some(([s, t]) => t === k && s === lk)).map(([, name]) => ({ key: k, name }))),
    nameIsKept,
    isOrg: (k) => isOrgKey(k) && live(k),
    orgFacts: (k) => {
      const o = org.get(k);
      if (!o) return { name: 'An organization no longer here', onSite: false, gone: true };
      return { name: o.name, onSite: o.onSite, slug: o.slug || null, level: o.level || null, levelLabel: o.levelLabel || null, funding: !!o.funding, keepAnonymous: !!anon.get(k) };
    },
    /**
     * Who each row counts for, and whether its giver is kept anonymous: { person, owner, kept }. A payment with no
     * contact is the contact its email is (personKeys), so it counts for that contact's organization too. Kept
     * anonymous: the person's own setting (on any of their records, or on an email kept before Zeffy had a contact
     * for it: that is them); a gift with no contact under the email of someone kept anonymous; and any organization
     * the gift names (the one it counts for, its contact's, the company typed) kept anonymous. `payerKept` is the
     * giver's part alone (a partner's level counts what isn't). `cid`: the contact a gift with no contact is placed
     * with (its email's own contact; for a joined person's other records, only when all their contacts are linked
     * to one organization). place.kept(key): is this person or organization kept anonymous
     */
    placer(rows) {
      const keyOf = personKeys(rows);
      const raw = new Map();
      const emailsOf = new Map();
      const holders = new Map();
      // Each person's Zeffy contacts and the organization each is as a whole (its link, or every name of it one's)
      const orgsOf = new Map();
      // The organizations a person's contacts are linked to, as a person said, even ones deleted since
      const linksOf = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        raw.set(r, k);
        const p = canon(k);
        if (r.contact) {
          if (!orgsOf.has(p)) orgsOf.set(p, new Map());
          if (!orgsOf.get(p).has(r.contact)) orgsOf.get(p).set(r.contact, contactIsOrg(r.contact));
          const t = yes.get(`contact\n${r.contact}`);
          if (t) { if (!linksOf.has(p)) linksOf.set(p, new Set()); linksOf.get(p).add(t); }
        }
        if (!r.email) continue;
        if (!emailsOf.has(p)) emailsOf.set(p, new Set());
        emailsOf.get(p).add(r.email);
        if (!holders.has(r.email)) holders.set(r.email, new Set());
        holders.get(r.email).add(p);
      }
      const byName = new Map();
      for (const r of rows) { const n = sameName(r); if (!n) continue; const p = canon(raw.get(r)); if (!byName.has(n)) byName.set(n, new Set()); byName.get(n).add(p); }
      const namesOf = new Map();
      for (const [n, ps] of byName) for (const p of ps) { if (!namesOf.has(p)) namesOf.set(p, new Set()); namesOf.get(p).add(n); }
      // Kept anonymous, privacy first: their own setting; an email kept before Zeffy had a contact for it; or an email
      // they share with someone kept, unless staff said they're not the same person (a spouse). A Zeffy duplicate or a
      // contact Zeffy merged away is the same person until someone says not
      const quietEmails = new Set(emailsKept);
      for (const [p, es] of emailsOf) if (keepAnonymous(p)) for (const e of es) quietEmails.add(e);
      const whyMemo = new Map();
      /** Why a person is kept anonymous: { kind: 'own' | 'email' | 'shared', other } or null */
      const keptWhy = (p) => {
        if (whyMemo.has(p)) return whyMemo.get(p);
        let why = keepAnonymous(p) ? { kind: 'own' } : [...(emailsOf.get(p) || [])].some((e) => emailsKept.has(e)) ? { kind: 'email' } : null;
        for (const e of why ? [] : emailsOf.get(p) || []) {
          for (const q of holders.get(e) || []) if (!why && q !== p && keepAnonymous(q) && !notSameNow.has([p, q].sort().join('\n'))) why = { kind: 'shared', other: q };
        }
        // The same full name as someone kept (a new Zeffy record of theirs, a new email): them until staff say not
        for (const n of why ? [] : namesOf.get(p) || []) {
          for (const q of byName.get(n) || []) if (!why && q !== p && keepAnonymous(q) && !notSameNow.has([p, q].sort().join('\n'))) why = { kind: 'name', other: q };
        }
        whyMemo.set(p, why);
        return why;
      };
      const personKept = (p) => !!keptWhy(p);
      // A gift under a name a kept organization has had (its company typed, or a contact named as it)
      // Any company named on the gift (a donor-advised fund's name too: the board shows it) or the contact's name
      const nameKept = (r) => !!keptNames.size && (nameIsKept(r.company) || nameIsKept(givenName({ first_name: r.first, last_name: r.last }), r.contact));
      // A joined person's record with no contact counts for an organization only when every contact of theirs is it
      const oneOrgOf = (person) => {
        const m = orgsOf.get(person);
        if (!m?.size) return null;
        const orgs = new Set(m.values());
        const [o] = orgs;
        return orgs.size === 1 && o ? [...m.keys()][0] : null;
      };
      // What a person said about a gift's names, even for a partner deleted since (Keep anonymous still holds)
      const saidFor = (r, cid) => [yes.get(`contact\n${r.contact || cid}`), pay.get(String(r.id)),
        r.corporate && clean(r.company) && r.method !== 'daf' ? yes.get(`company\n${nameKey(r.company)}`) : null].filter((t) => t && t !== 'person');
      const place = (r) => {
        const k = raw.get(r) ?? keyOf(r);
        const person = canon(k);
        const cid = r.contact ? null : k.startsWith('c:') ? k.slice(2) : oneOrgOf(person);
        const rr = cid ? { ...r, contact: cid, borrowed: true } : r;
        const owner = ownerOf(rr, person);
        const was = r.was_contact ? canon(`c:${r.was_contact}`) : null;
        const payerKept = personKept(person) || (!r.contact && !!r.email && quietEmails.has(r.email)) || (!!was && was !== person && personKept(was));
        // Every organization the gift names; for a gift with no contact, every organization its giver's contacts are
        const named = [owner, contactOrgOf(rr), companyOrgOf(r), ...saidFor(r, cid),
          ...(r.contact ? [] : [...(orgsOf.get(person)?.values() || []), ...(linksOf.get(person) || [])])];
        const orgKept = named.some((o) => o && isOrgKey(o) && keepAnonymous(o)) || nameKept(r);
        return { person, owner, cid, payerKept, kept: payerKept || orgKept };
      };
      place.kept = (k) => (isOrgKey(k) ? keepAnonymous(k) : personKept(k));
      place.why = (k) => (isOrgKey(k) ? (keepAnonymous(k) ? { kind: 'own' } : null) : keptWhy(k));
      return place;
    },
    /** A gift where the contact's organization and the company's differ, nobody having said which (cid: the contact a gift with none is placed with) */
    clashOf: (r, cid = null) => {
      if (pay.has(String(r.id))) return null;
      const c = contactOrgOf(cid && !r.contact ? { ...r, contact: cid } : r);
      const k = companyOrgOf(r);
      return c && k && c !== k ? { contact: c, company: k } : null;
    },
  };
}

// ─── What a person says ─────────────────────────────────────────────

/** One answer, as a statement (several go in one batch, all or none) */
const callStmt = (DB, { kind, subject, target = '', answer, note = null }, by, now) => DB.prepare(`INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, subject, target) DO UPDATE SET answer = excluded.answer, note = excluded.note, by = excluded.by, at = excluded.at`)
  .bind(kind, String(subject), String(target), answer ? 1 : 0, note, by || null, iso(now));
const putCall = (DB, call, by, now) => callStmt(DB, call, by, now).run();
/**
 * First in a batch: stops it, every statement undone, unless `cond` (SQL) holds, so what was read is still so when it's
 * written (a teammate's change in between is never written over). It writes nothing when it holds; when it doesn't,
 * its row can't be stored (no value), and notSo(error) says that was why.
 */
const stillSo = (DB, cond, ...args) => DB.prepare(`INSERT INTO donor_state (key, value) SELECT 'still-so', NULL WHERE NOT (${cond})`).bind(...args);
const notSo = (e) => /donor_state\.value/.test(String(e?.message || e));
/** First in a batch: the answers of one kind about these subjects are still exactly as `crm` read them */
const asRead = (DB, crm, kind, subjects) => {
  const rows = crm.rowsOf(kind, subjects);
  return stillSo(DB, `(SELECT COUNT(*) FROM donor_calls WHERE kind = ? AND subject IN (SELECT value FROM json_each(?))) = ?
    AND (SELECT COUNT(*) FROM donor_calls d, json_each(?) j WHERE d.kind = ? AND d.subject = json_extract(j.value, '$[0]') AND d.target = json_extract(j.value, '$[1]')
      AND d.answer = json_extract(j.value, '$[2]') AND d.note IS json_extract(j.value, '$[3]') AND d.at = json_extract(j.value, '$[4]')) = ?`,
  kind, JSON.stringify(subjects), rows.length, JSON.stringify(rows), kind, rows.length);
};
/** An answer written only while what it answers is as read (two staff at the same moment: the second is told) */
async function asAnswered(DB, guard, steps) {
  try { await DB.batch([guard, ...steps]); } catch (e) {
    if (!notSo(e)) throw e;
    throw bad('Someone answered this a moment ago. Nothing was changed; it shows as it is now.', 409);
  }
}
/** An organization's name as two are told apart (plain letters; a name with none, another script: its own letters) */
const orgNameKey = (name) => nameKey(name) || `~${String(name || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`;
// Under the donor it's about (their key), so their page shows it; 'donors' when it's about no one donor
const audit = (DB, by, name, changes, slug = 'donors') => logAudit(DB, { userEmail: by || 'unknown', action: 'updated', entityType: 'donor-crm', entitySlug: slug, entityName: name, changes }).catch(() => {});
const usd = (cents) => { const c = Math.round(Number(cents) || 0); return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`; };

/** The team, to pick an owner from: SOARD's active Google accounts (not the site's own, nor shared inboxes) → [{ email, name }] */
export async function staffList(DB) {
  let dir = [];
  try { dir = await staffDirectory(DB); } catch { /* not read yet */ }
  const out = new Map();
  // Everyone Google has, who left too: a former teammate still named an owner shows by their name
  const names = new Map();
  for (const a of dir) {
    if (!a.email) continue;
    const all = [a.email, ...(a.aliases || [])].map((x) => String(x).toLowerCase());
    // The SOARD address they sign in here with (a main account on the store's domain has a soardcharity.com alias)
    const email = all.find((x) => isStaffEmail(x)) || all[0];
    if (all.some((x) => NOT_STAFF.has(x))) continue;
    for (const x of all) if (clean(a.name)) names.set(x, clean(a.name));
    if (!a.active) continue;
    out.set(email, { email, name: clean(a.name) || email.split('@')[0] });
  }
  return Object.assign([...out.values()].sort((x, y) => x.name.localeCompare(y.name)), { names });
}
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const KINDS = new Set(['contact', 'company']);
const subjectOf = (kind, v) => (kind === 'company' ? nameKey(v) : clean(v));

/**
 * One change a person makes (Admin → Donors & Partners). Each is an answer kept in donor_calls and an entry in
 * History (its own type: nothing here waits for Publish). → whatever the change returns
 */
export async function act(env, body, by, opts = {}) {
  // Whatever it changed, every open tab reads its lists again (a refusal that changed nothing costs them one read).
  // The answer names the mark it moved to (`rev`): the tab that asked knows that change as its own
  let r;
  try { r = await actNow(env, body, by, opts); } catch (e) {
    const rev = await markChanged(env.DB).catch(() => null);
    if (rev && e && typeof e === 'object') e.rev = rev;
    throw e;
  }
  const rev = await markChanged(env.DB).catch(() => null);
  return r && typeof r === 'object' && rev ? { ...r, rev } : r;
}
async function actNow(env, body, by, { now = Date.now() } = {}) {
  const { DB } = env;
  await ensureCrm(DB);
  let crm = await loadCrm(DB, { now });
  const a = body?.act;
  const orgOk = (k) => { if (!crm.live(String(k || ''))) throw bad('That organization isn’t here any more: someone took it out or put it on the website since. Nothing was changed.', 409); return String(k); };
  // A person's record whose gifts Zeffy moved since the page was read (the 15-minute read has them, the move of what
  // was said about it hasn't run): what was said follows them now, so this change lands where they are. Every record
  // the change names: the page's own, the two said to be one person, the contacts counted for an organization
  const contactRef = (f, v) => (f === 'subject' || f === 'subjects' ? String(v || '') : /^c:/.test(String(v || '')) ? String(v).slice(2) : '');
  const named = [
    ...['key', 'a', 'b'].map((f) => [f, contactRef(f, body?.[f])]),
    ...(body?.kind === 'contact' && (a === 'link' || a === 'not') ? [['subject', contactRef('subject', body.subject)], ...(Array.isArray(body.subjects) ? body.subjects.slice(0, 20).map((x) => ['subjects', contactRef('subjects', x)]) : [])] : []),
  ].filter(([, c]) => c);
  const ids = [...new Set(named.map(([, c]) => c))];
  // (counted for an organization on a record Zeffy merged into another since: that one, named in the answer)
  let followed = null;
  if (ids.length) {
    const own = new Set(((await DB.prepare(`SELECT DISTINCT contact FROM donor_payments WHERE contact IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all()).results || []).map((r) => String(r.contact)));
    const gone = ids.filter((c) => !own.has(c));
    const went = new Map();
    // (split between several and looked at in Needs you: where the person said, or nowhere)
    const answered = new Map();
    if (gone.length) {
      for (const r of (await DB.prepare(`SELECT DISTINCT was_contact AS was, contact FROM donor_payments WHERE was_contact IN (${gone.map(() => '?').join(', ')}) AND contact IS NOT NULL`).bind(...gone).all()).results || []) {
        went.set(String(r.was), [...(went.get(String(r.was)) || []), String(r.contact)]);
      }
      for (const r of (await DB.prepare(`SELECT subject, note FROM donor_calls WHERE kind = 'moved' AND subject IN (${gone.map(() => '?').join(', ')})`).bind(...gone).all()).results || []) answered.set(String(r.subject), r.note ? String(r.note) : null);
    }
    // Zeffy's move not followed yet (the 15-minute whole read hasn't come round): followed now, before this change, so
    // it lands where they are (a record of a joined person split between several is theirs at once; a lone one is
    // asked about in Needs you, as the refusal below says)
    const before = new Map(ids.map((c) => [c, new Set(crm.keysOf(crm.canon(`c:${c}`)))]));
    const unfollowed = [...went.keys()].some((c) => !answered.has(c));
    if (unfollowed) {
      await followMerges(DB, { now });
      crm = await loadCrm(DB, { now });
      for (const r of (await DB.prepare(`SELECT subject, note FROM donor_calls WHERE kind = 'moved' AND subject IN (${gone.map(() => '?').join(', ')})`).bind(...gone).all()).results || []) answered.set(String(r.subject), r.note ? String(r.note) : null);
    }
    const to = (c) => (answered.has(c) ? answered.get(c) || c : went.get(c)?.length === 1 ? went.get(c)[0] : c);
    // A split nobody has looked at yet: a change about that very record waits for Needs you; a person's other records
    // counted with it go on without it (it has no gifts to count)
    const open = (c) => !answered.has(c) && (went.get(c)?.length || 0) > 1;
    if (named.some(([f, c]) => f !== 'subjects' && open(c))) throw bad('Zeffy split this donor’s gifts between records since this page was read. Nothing was changed; Needs you asks where what was said about them goes.', 409);
    if (unfollowed || answered.size || named.some(([, c]) => open(c))) {
      // (`before`: the person each record was part of, as read: Zeffy may have merged it into one of their own since)
      const next = { ...body };
      const key = contactRef('key', body.key);
      if (key && to(key) !== key) {
        // Not the same person, on a record Zeffy merged into one of that person's own since: nothing to take out
        // (or emptied by Zeffy and given to the person it was part of: nothing of its own left to take out either)
        if (a === 'split' && answered.has(key)) throw bad('Zeffy split that record’s gifts between other records since this page was read, and what was said about it is theirs now. Nothing was changed.', 409);
        const shownTheirs = Array.isArray(body.others) ? body.others.map(String) : [];
        if (a === 'split' && (before.get(key)?.has(`c:${to(key)}`) || shownTheirs.includes(`c:${to(key)}`))) throw bad('Zeffy merged that record into one of theirs since this page was read, so its gifts are theirs now. Nothing was changed.', 409);
        // (a record to take out of a person is the record itself, never the person it now leads to)
        next.key = a === 'split' ? `c:${to(key)}` : crm.canon(`c:${to(key)}`);
      }
      for (const f of ['a', 'b']) if (contactRef(f, body[f]) && to(contactRef(f, body[f])) !== contactRef(f, body[f])) next[f] = `c:${to(contactRef(f, body[f]))}`;
      // Zeffy made the two one record since: one donor already (never two of them to say aren't the same)
      if (a === 'same' && next.a && next.a === next.b) {
        if (body.same) return { ok: true, same: true, key: crm.canon(next.a) };
        throw bad('Zeffy merged these two records into one since this page was read, so they’re one donor. Nothing was changed.', 409);
      }
      if (named.some(([f]) => f === 'subject')) { next.subject = to(String(body.subject)); if (next.subject !== String(body.subject)) followed = next.subject; }
      if (named.some(([f]) => f === 'subjects')) next.subjects = [...new Set(body.subjects.map((x) => String(x || '')).filter((x) => !open(x)).map(to))];
      body = next;
    }
  }
  // Keep as an organization sent again (its answer lost on the way back): the one it made, by the key the page chose
  const orgKeyOf = (k) => (/^o:[0-9a-f]{16}$/.test(String(k || '')) ? String(k) : null);
  if (a === 'org-new' && orgKeyOf(body.key)) {
    const had = await DB.prepare('SELECT key, name_key FROM donor_orgs WHERE key = ?').bind(body.key).first();
    if (had) {
      if (had.name_key !== orgNameKey(clean(body.name).slice(0, 120))) throw bad('That address is another organization’s. Reload and try again.', 409);
      return { ok: true, key: had.key, same: true };
    }
  }
  // Keep it as an organization, kept the same way by a teammate first (that name, its names linked to it): done already
  if (a === 'org-new') {
    const [had, more] = crm.named(clean(body.name).slice(0, 120));
    const links = (Array.isArray(body.links) ? body.links : []).filter((l) => KINDS.has(l?.kind));
    if (had && !more && links.length && links.every((l) => crm.calls.yes.get(`${l.kind}\n${subjectOf(l.kind, l.subject)}`) === had)) return { ok: true, same: true, key: had };
  }
  // An answer to a Needs you question (`asked`): someone may have answered it since this page read it (another tab, a
  // teammate). Then nothing changes and they're told, never a quiet second answer over the first; the same answer
  // already given (this one sent again, a teammate who said the same) is done already
  if (body?.asked === true && (await stillAsked(DB, crm, body, now)) === 'same') return { ok: true, same: true };
  if (a === 'link' || a === 'not') {
    if (!KINDS.has(body.kind)) throw bad('Link a contact or a company name');
    const subject = subjectOf(body.kind, body.subject);
    if (!subject) throw bad('Which name?');
    const target = orgOk(body.org);
    // A person joined from several Zeffy contacts: every one of them, in one step (never some linked and some not)
    // (a contact picked anywhere, an organization's Add a Zeffy name too: every contact of the person it is)
    const said = [body.subject, ...(body.kind === 'contact' && Array.isArray(body.subjects) ? body.subjects : [])].map((x) => subjectOf(body.kind, x)).filter(Boolean);
    // (one of theirs counted for another organization already stays there: Take it off there first, to move it)
    const elsewhere = (c) => { const t = crm.calls.yes.get(`contact\n${c}`); return !!t && t !== target && crm.live(t); };
    const first = subjectOf(body.kind, body.subject);
    const subjects = [...new Set(body.kind === 'contact' ? said.flatMap((c) => [c, ...crm.keysOf(crm.canon(`c:${c}`)).filter((k) => k.startsWith('c:')).map((k) => k.slice(2))]) : said)]
      .filter((x) => x === first || body.kind !== 'contact' || !elsewhere(x)).slice(0, 20);
    // So already (sent again after its answer was lost, a teammate first): done, nothing more in History
    if (subjects.every((sub) => (a === 'link' ? crm.calls.yes.get(`${body.kind}\n${sub}`) === target : crm.calls.no.has(`${body.kind}\n${sub}\n${target}`)))) return { ok: true, same: true };
    // Linked to another organization since the page was read (a teammate): never taken from it unseen. Take it off
    // there first; a link to an organization that's gone counts for nothing and is replaced
    // (`from`: the organization the person saw it count for, as Add a Zeffy name shows it: moving it from there is theirs)
    // (a Needs you answer is checked for its own name by stillAsked; the person's other records it brings along, here)
    const asked = body.asked === true ? subjectOf(body.kind, body.subject) : null;
    const taken = a === 'link' && subjects.filter((sub) => sub !== asked).map((sub) => crm.calls.yes.get(`${body.kind}\n${sub}`)).find((t) => t && t !== target && crm.live(t) && t !== String(body.from ?? ''));
    if (taken) throw bad(`${body.kind === 'company' ? `“${clean(body.subject)}”` : 'That Zeffy contact'} counts for ${crm.org.get(taken).name} already, so nothing was changed. To move it, take it off ${crm.org.get(taken).name} first.`, 409);
    if (a === 'link') {
      // One organization per contact or company name: a link elsewhere goes, in the same step
      await asAnswered(DB, asRead(DB, crm, body.kind, subjects), subjects.flatMap((sub) => [
        DB.prepare("DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND answer = 1 AND target <> ?").bind(body.kind, sub, target),
        // (a company's name as it was typed, to show: the answer is under its plain-letters key)
        callStmt(DB, { kind: body.kind, subject: sub, target, answer: 1, note: body.kind === 'company' ? clean(body.subject).slice(0, 200) : null }, by, now),
      ]));
    } else await asAnswered(DB, asRead(DB, crm, body.kind, subjects), subjects.map((sub) => callStmt(DB, { kind: body.kind, subject: sub, target, answer: 0 }, by, now)));
    await audit(DB, by, `${a === 'link' ? 'Linked' : 'Not'} ${body.kind === 'company' ? clean(body.subject) : 'a Zeffy contact'} ${a === 'link' ? 'to' : 'for'} ${crm.org.get(target).name}`, { kind: body.kind, subject, org: target, answer: a === 'link' }, target);
    // (the record it was, merged by Zeffy into another since the page was read: who that is, so the page can say so)
    const into = followed ? await DB.prepare(`SELECT ${READ_COLS.join(', ')} FROM donor_payments WHERE contact = ? ORDER BY at DESC LIMIT 1`).bind(followed).first() : null;
    return { ok: true, ...(into ? { followed: personName(into) } : {}) };
  }
  if (a === 'same') {
    const [x, y] = [String(body.a || ''), String(body.b || '')].sort();
    if (!/^[cen]:/.test(x) || !/^[cen]:/.test(y) || x === y) throw bad('Two donors to compare');
    if (body.same ? crm.canon(x) === crm.canon(y) : crm.calls.notSameRaw.has(`${x}\n${y}`)) return { ok: true, same: true, key: crm.canon(x) };
    await asAnswered(DB, asRead(DB, crm, 'same', [x]), [callStmt(DB, { kind: 'same', subject: x, target: y, answer: !!body.same }, by, now)]);
    await audit(DB, by, body.same ? 'Two donors are one person' : 'Two donors are not the same', { a: x, b: y, same: !!body.same }, crm.canon(x));
    return { ok: true, key: (await loadCrm(DB, { now })).canon(x) };
  }
  if (a === 'anon') {
    const key = isOrgKey(body.key) ? orgOk(body.key) : crm.canon(String(body.key || ''));
    if (!/^[cenxpo]:/.test(key)) throw bad('Whose?');
    // Kept already, on every record (sent again, a teammate first): done, nothing more in History
    if (body.on && (isOrgKey(key) ? crm.keptKey(key) : crm.keysOf(key).every((k) => crm.keptKey(k)))) return { ok: true, same: true };
    if (!body.on && isOrgKey(key) && !crm.keptKey(key)) return { ok: true, same: true };
    // A person: said on every record that is them, so it holds whichever one leads; turned off, also off the emails
    // it was kept by before Zeffy had a contact for them
    const keys = isOrgKey(key) ? [key] : [...crm.keysOf(key)];
    const others = [];
    if (!body.on && !isOrgKey(key)) {
      const ce = keys.filter((k) => /^[ce]:/.test(k));
      const rows = ce.length ? await rowsFor(DB, ce) : [];
      const place = crm.placer(rows);
      const mine = [...new Set(rows.filter((r) => r.email && place(r).person === key).map((r) => `e:${r.email}`))];
      keys.push(...mine);
      // An email kept before Zeffy had a contact for it was keeping everyone who has it: they stay kept
      const kept = [...new Set([...keys, ...mine])].filter((k) => k.startsWith('e:') && crm.keptKey(k));
      if (kept.length) {
        const more = await rowsFor(DB, kept);
        const p2 = crm.placer(more);
        for (const r of more) { const q = p2(r).person; if (q !== key && /^[cen]:/.test(q)) others.push(...crm.keysOf(q)); }
      }
    }
    const off = new Set(keys);
    if (!body.on && !isOrgKey(key) && [...off].every((k) => !crm.keptKey(k)) && !others.length) return { ok: true, same: true };
    // An organization's name is written down when it's kept (and stays: it counts only while the organization is kept)
    const names = isOrgKey(key) && body.on ? [crm.org.get(key).name, ...(key.startsWith('p:') ? await historyNames(DB, key.slice(2)) : [])] : [];
    const named = [...new Set(names.filter(Boolean))].map((n) => callStmt(DB, { kind: 'kept-name', subject: looseKey(n), target: key, answer: 1, note: n }, by, now));
    await DB.batch([
      ...[...off].map((k) => callStmt(DB, { kind: 'anon', subject: k, answer: !!body.on }, by, now)),
      ...[...new Set(others)].filter((k) => !off.has(k)).map((k) => callStmt(DB, { kind: 'anon', subject: k, answer: true }, by, now)),
      ...named,
    ]);
    await audit(DB, by, `${body.on ? 'Keep anonymous' : 'No longer kept anonymous'}: ${isOrgKey(key) ? crm.org.get(key).name : clean(body.name).slice(0, 80) || 'a donor'}`, { key, on: !!body.on }, key);
    // Their own setting off, and still kept (they share a name or an email with someone kept): said so, never "off"
    if (!body.on && !isOrgKey(key)) {
      const crm2 = await loadCrm(DB, { now });
      // (everyone's gifts: who shares their name or email is read from all of them, as their page reads it)
      if (crm2.placer(await allRows(DB)).kept(crm2.canon(key))) return { ok: true, still: true };
    }
    return { ok: true };
  }
  if (a === 'payment') {
    const id = clean(body.id);
    const owner = body.owner === 'person' ? 'person' : orgOk(body.owner);
    if (!id) throw bad('Which gift?');
    if (crm.calls.pay.get(id) === owner) return { ok: true, same: true };
    await asAnswered(DB, asRead(DB, crm, 'payment', [id]), [callStmt(DB, { kind: 'payment', subject: id, answer: 1, note: owner }, by, now)]);
    await audit(DB, by, `A gift counts for ${owner === 'person' ? 'the person who gave it' : crm.org.get(owner).name}`, { id, owner }, owner === 'person' ? 'donors' : owner);
    return { ok: true };
  }
  if (a === 'payment-clear') {
    const id = clean(body.id);
    if (!id) throw bad('Which gift?');
    if (!crm.calls.pay.has(id)) return { ok: true, same: true };
    await DB.prepare("DELETE FROM donor_calls WHERE kind = 'payment' AND subject = ?").bind(id).run();
    const owner = await donorOfPayment(env, id, { crm: await loadCrm(DB, { now }) }).catch(() => null);
    await audit(DB, by, 'A gift counts as the site works it out again', { id }, owner || 'donors');
    return { ok: true };
  }
  if (a === 'split') {
    // One record out of a person: never joined with the others again, and the others stay one person
    const key = String(body.key || '');
    const group = crm.keysOf(key);
    // Where the page goes after: the person the others are (a Zeffy contact's address, else one of their gifts')
    const refOf = async (crm2, k) => {
      const after = crm2.canon(k);
      if (after.startsWith('c:')) return { key: after, ref: after.slice(2) };
      const rows = await rowsFor(DB, [after]);
      const place = crm2.placer(rows);
      const one = rows.find((r) => place(r).person === after);
      return { key: after, ref: one ? `g:${one.id}` : null };
    };
    // Not joined to anyone (split already: this sent again after its answer was lost, a teammate first): done already,
    // and the person it was taken out of, as the first answer said
    if (group.length < 2 || !group.includes(key)) {
      const last = await DB.prepare("SELECT subject, target FROM donor_calls WHERE kind = 'same' AND answer = 0 AND (subject = ? OR target = ?) ORDER BY at DESC LIMIT 1").bind(key, key).first();
      const other = last ? (last.subject === key ? last.target : last.subject) : null;
      return { ok: true, same: true, ...(other ? await refOf(crm, String(other)) : {}) };
    }
    const rest = group.filter((k) => k !== key);
    // The one the others hang on now, as a person's lead is chosen everywhere (never a record Zeffy emptied)
    const lead = crm.leadOf(rest);
    // One batch: all of it or none, so a failure part way never breaks the person up; and only while who is the same
    // as whom is as read (a teammate's split in between is never undone)
    const sameRows = crm.sameRowsOf(group);
    const ownersRead = crm.ownerRows(group);
    const steps = [
      stillSo(DB, `(SELECT COUNT(*) FROM donor_calls WHERE kind = 'same' AND (subject IN (SELECT value FROM json_each(?)) OR target IN (SELECT value FROM json_each(?)))) = ?
        AND (SELECT COUNT(*) FROM donor_calls d, json_each(?) j WHERE d.kind = 'same' AND d.subject = json_extract(j.value, '$[0]') AND d.target = json_extract(j.value, '$[1]')
          AND d.answer = json_extract(j.value, '$[2]') AND d.at = json_extract(j.value, '$[4]')) = ?
        AND (SELECT COUNT(*) FROM donor_calls WHERE kind = 'owner' AND subject IN (SELECT value FROM json_each(?))) = ?
        AND (SELECT COUNT(*) FROM donor_calls d, json_each(?) j WHERE d.kind = 'owner' AND d.subject = json_extract(j.value, '$[0]')
          AND d.answer = json_extract(j.value, '$[1]') AND d.note IS json_extract(j.value, '$[2]') AND d.at = json_extract(j.value, '$[3]')) = ?`,
      JSON.stringify(group), JSON.stringify(group), sameRows.length, JSON.stringify(sameRows), sameRows.length,
      JSON.stringify(group), ownersRead.length, JSON.stringify(ownersRead), ownersRead.length),
      DB.prepare("UPDATE donor_calls SET answer = 0 WHERE kind = 'same' AND answer = 1 AND (subject = ? OR target = ?)").bind(key, key),
    ];
    // The person's notes and owner were said on the record that led them: they stay with the person
    const led = crm.canon(key) === key;
    if (led) steps.push(DB.prepare('UPDATE donor_notes SET subject = ? WHERE subject = ?').bind(lead, key));
    // Not leading now, it may have led before another record joined: what was said on it since it joined the person
    // (notes, an owner, History) was the person's, and stays with them; what it had before, its own, goes with it
    const joinedAt = led ? null : (await DB.prepare("SELECT MIN(at) AS at FROM donor_calls WHERE kind = 'same' AND answer = 1 AND (subject = ? OR target = ?)").bind(key, key).first())?.at || null;
    if (joinedAt) {
      steps.push(DB.prepare('UPDATE donor_notes SET subject = ? WHERE subject = ? AND at >= ?').bind(lead, key, joinedAt));
      const logAt = String(joinedAt).slice(0, 19).replace('T', ' ');
      if (await DB.prepare("SELECT 1 AS y FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").first().catch(() => null)) {
        steps.push(DB.prepare("UPDATE audit_log SET entity_slug = ? WHERE entity_type = 'donor-crm' AND entity_slug = ? AND created_at >= ?").bind(lead, key, logAt));
      }
    }
    // Owners: each record keeps the one said on it (a join undone gives each back its own). One said on the record
    // split off for the person (when it led, or since it joined), with none newer on the others, stays with the person
    const own = crm.ownerRows(group);
    const mine = own.find(([k, ans, note]) => k === key && ans && note);
    const theirs = (at) => own.some(([k, ans, note, at2]) => k !== key && ans && note && (!at || at2 >= at));
    if (mine && ((led && !theirs()) || (joinedAt && mine[3] >= joinedAt && !theirs(mine[3])))) {
      steps.push(DB.prepare("DELETE FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(key));
      steps.push(callStmt(DB, { kind: 'owner', subject: lead, answer: 1, note: mine[2] }, by, now));
    }
    for (const k of rest) {
      const [x, y] = [lead, k].sort();
      // The others hang on the lead, unless a person said that one isn't them
      if (k !== lead && !crm.calls.notSameRaw.has(`${x}\n${y}`)) steps.push(callStmt(DB, { kind: 'same', subject: x, target: y, answer: 1 }, by, now));
      const [p, q] = [key, k].sort();
      steps.push(callStmt(DB, { kind: 'same', subject: p, target: q, answer: 0 }, by, now));
    }
    // …and its History (what was done to the person, filed under the record that led them), in the same step
    if (led) steps.push(...await historySteps(DB, key, lead));
    try { await DB.batch(steps); } catch (e) {
      if (!notSo(e)) throw e;
      throw bad('Someone changed who this person is a moment ago. Nothing was changed; it shows as it is now.', 409);
    }
    await audit(DB, by, 'A record is not the same person after all', { key, from: rest }, lead);
    return { ok: true, ...await refOf(await loadCrm(DB, { now }), lead) };
  }
  if (a === 'level') {
    const key = orgOk(body.org);
    // Moving it to Champion on the website didn't go through: as if never answered
    if (body.undo === true) {
      await DB.prepare("DELETE FROM donor_calls WHERE kind = 'level' AND subject = ? AND answer = 1 AND by IS ?").bind(key, by || null).run();
      await audit(DB, by, 'Not moved to Champion after all (the Partners page didn’t take the change)', { org: key }, key);
      return { ok: true };
    }
    // Moving to Champion is an upgrade from Builder or Friend, only: a partner moved meanwhile (to Signature, or to
    // Champion already) is never moved by a card read before
    if (body.done && body.move === true && crm.org.get(key)?.level === 'champion') {
      if (!crm.calls.level.get(key)?.answer) await putCall(DB, { kind: 'level', subject: key, answer: 1, note: clean(body.was) || null }, by, now);
      return { ok: true, same: true };
    }
    if (body.done && !['builder', 'friend'].includes(crm.org.get(key)?.level)) throw bad(`${crm.org.get(key)?.name || 'They'} ${crm.org.get(key)?.levelLabel ? `is a ${crm.org.get(key).levelLabel} partner` : 'moved'} since this was read. Nothing was changed.`, 409);
    // Move: the partner card changes here, as Partners changes it, and the answer is said only once it has (one step:
    // a failure part way leaves nothing said, so it can simply be tried again)
    if (body.done && body.move === true) {
      if (!key.startsWith('p:')) throw bad('Only a partner on the website has a level');
      // Still a Champion by its giving, as Needs you would ask it now: kept anonymous since (its giving on the Partners
      // page unasked), or its gifts refunded or given anonymously since, it isn't moved
      if (crm.keepAnonymous(key)) throw bad(`${crm.org.get(key).name} is kept anonymous since this was read, so it wasn’t moved. Nothing was changed.`, 409);
      const stillDue = needsOf(await allRows(DB), crm, { now }).some((i) => i.kind === 'level' && i.org === key);
      if (!stillDue) throw bad(`${crm.org.get(key).name}’s giving in the last 12 months is under Champion’s now (refunded, or given anonymously, since). Nothing was changed.`, 409);
      const { updatePartners } = await import('./partners-batch.js');
      const r = await updatePartners(env, [{ slug: key.slice(2), set: { level: 'champion' }, from: { level: ['builder', 'friend'] } }], by || 'unknown');
      if (r.status !== 200) throw bad(r.body?.error || 'The Partners page didn’t take the change', r.status >= 400 && r.status < 500 ? r.status : 500);
      if (r.body.refused?.length) throw bad(`${crm.org.get(key).name}’s level changed since this was read (Champion or above already). Nothing was changed.`, 409);
      if (!r.body.changed?.includes(key.slice(2))) throw bad('Someone changed them at the same moment. Look again and try once more.', 409);
    }
    await putCall(DB, { kind: 'level', subject: key, answer: !!body.done, note: body.done ? clean(body.was) || null : null }, by, now);
    await audit(DB, by, body.done ? `${crm.org.get(key).name} made Champion by giving (was ${clean(body.was) || 'unknown'})` : 'Not moved to Champion for now (asked again in a year)', { org: key, was: clean(body.was) || null, done: !!body.done }, key);
    return { ok: true };
  }
  if (a === 'big') {
    const subject = String(body.subject || '');
    if (!subject) throw bad('Which name?');
    // The same giver under another of its names: not asked about for a year either
    const also = (Array.isArray(body.also) ? body.also : []).map(String).filter(Boolean).slice(0, 5);
    // "It’s a person": a contact whose name reads as an organization's isn't asked about again
    const person = body.person === true && subject.startsWith('contact:');
    await asAnswered(DB, asRead(DB, crm, 'big', [subject, ...also]), [subject, ...also].map((s) => callStmt(DB, { kind: 'big', subject: s, answer: 0, note: person ? 'person' : null }, by, now)));
    // On the donor's page when it's a Zeffy contact (a company typed on gifts is no one donor)
    const contact = [subject, ...also].find((s) => s.startsWith('contact:'));
    await audit(DB, by, person ? 'Said to be a person, not an organization' : 'Not kept as an organization for now (asked again in a year)', { subject, also }, contact ? crm.canon(`c:${contact.slice(8)}`) : 'donors');
    return { ok: true };
  }
  if (a === 'org-new') {
    const name = clean(body.name).slice(0, 120);
    if (!name) throw bad('A name for the organization');
    if (crm.named(name).length) throw bad(`${crm.org.get(crm.named(name)[0]).name} is already here. Use Link to… to link the name to it.`, 409);
    const key = orgKeyOf(body.key) || `o:${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    // The organization and its names in one step. A name that counts for an organization already (someone linked it
    // since this page was read, or it's an organization's own name) is never taken from it: nothing is made
    // Only while no organization here has that name (two kept at the same moment, by two people or two tabs: one is)
    const steps = [
      stillSo(DB, 'NOT EXISTS (SELECT 1 FROM donor_orgs WHERE name_key = ?)', orgNameKey(name)),
      DB.prepare('INSERT INTO donor_orgs (key, name, created_at, by, name_key) VALUES (?, ?, ?, ?, ?)').bind(key, name, iso(now), by || null, orgNameKey(name)),
    ];
    for (const l of Array.isArray(body.links) ? body.links.slice(0, 10) : []) {
      if (!KINDS.has(l?.kind)) continue;
      const subject = subjectOf(l.kind, l.subject);
      if (!subject) continue;
      const linked = crm.calls.yes.get(`${l.kind}\n${subject}`);
      const own = l.kind === 'company' ? crm.exact(clean(l.subject)) : null;
      let has = (linked && crm.live(linked) && linked) || (own && !crm.calls.no.has(`company\n${subject}\n${own}`) && own);
      if (!has && l.kind === 'contact') {
        // Its gifts count for an organization already (their company is linked, or its own name is one's)
        const rs = await rowsFor(DB, [`c:${subject}`]);
        const place = crm.placer(rs);
        has = rs.filter((r) => r.contact === subject).map((r) => place(r).owner).find((o) => crm.isOrg(o)) || null;
      }
      if (has) throw bad(`${l.kind === 'company' ? `“${clean(l.subject)}”` : 'That Zeffy contact'} counts for ${crm.org.get(has)?.name || 'an organization'} already. Nothing was changed.`, 409);
      // A link to an organization that's gone (a partner deleted) counts for nothing: this one replaces it (and only
      // while the name's links are as read: a teammate's link in between is never deleted unseen)
      steps.push(asRead(DB, crm, l.kind, [subject]));
      steps.push(DB.prepare('DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND answer = 1').bind(l.kind, subject));
      steps.push(callStmt(DB, { kind: l.kind, subject, target: key, answer: 1, note: l.kind === 'company' ? clean(l.subject).slice(0, 200) : null }, by, now));
    }
    const linking = (Array.isArray(body.links) ? body.links : []).filter((l) => l?.kind === 'contact').map((l) => subjectOf('contact', l.subject));
    steps.push(...await keepOthersGifts(DB, crm, name, key, by, now, { linking, people: (Array.isArray(body.links) ? body.links : []).some((l) => l?.kind === 'company') }));
    // The Needs you question it answers (is it an organization?): answered, in the same step
    for (const sub of [String(body.subject || ''), ...(Array.isArray(body.also) ? body.also : [])].map(String).filter((x) => /^(company|contact):/.test(x)).slice(0, 6)) {
      steps.push(callStmt(DB, { kind: 'big', subject: sub, target: key, answer: 1, note: 'org' }, by, now));
    }
    // A Zeffy contact that was this organization all along (not joined to anyone): its owner, notes, Keep anonymous and
    // History are the organization's now, in the same step, with which contact it was made from (Take it out gives
    // back to it, and to no other)
    let made = false;
    for (const l of Array.isArray(body.links) ? body.links.slice(0, 10) : []) {
      const c = l?.kind === 'contact' ? `c:${subjectOf('contact', l.subject)}` : null;
      if (made || !c || crm.keysOf(crm.canon(c)).length !== 1) continue;
      made = true;
      const moved = await moveSteps(DB, crm.canon(c), key);
      steps.push(moved.guard, ...moved, ...await historySteps(DB, crm.canon(c), key));
      steps.push(callStmt(DB, { kind: 'made-from', subject: key, target: crm.canon(c), answer: 1 }, by, now));
    }
    try { await DB.batch(steps); } catch (e) {
      if (!notSo(e)) throw e;
      // Refused as it was written: the name taken a moment ago, or something said about its Zeffy record meanwhile
      const taken = await DB.prepare('SELECT 1 AS y FROM donor_orgs WHERE name_key = ?').bind(orgNameKey(name)).first();
      throw bad(taken ? `${name} is an organization here already: someone kept it a moment ago. Nothing was changed.` : 'Someone changed something about that Zeffy record a moment ago. Nothing was changed; look again, then try once more.', 409);
    }
    if (made) await oneLinkEach(DB);
    await audit(DB, by, `New organization (not on the website): ${name}`, { key, name }, key);
    return { ok: true, key };
  }
  if (a === 'org-rename') {
    const key = orgOk(body.key);
    const name = clean(body.name).slice(0, 120);
    if (!key.startsWith('o:') || !name) throw bad('A new name for an organization not on the website (a partner’s name is changed in its partner card)');
    if (typeof body.was === 'string' && body.was !== crm.org.get(key).name && name !== crm.org.get(key).name) throw bad(`Someone renamed it ${crm.org.get(key).name} since you looked. Nothing was changed.`, 409);
    // Two organizations with one name would each lose the gifts that name links by itself
    if (crm.named(name, key).length) throw bad(`${crm.org.get(crm.named(name, key)[0]).name} already has that name.`, 409);
    if (name === crm.org.get(key).name) return { ok: true, same: true };
    // In one step, and only while it has the name read above (a teammate's rename in between is never written over)
    try {
      await DB.batch([
        // (and no other organization here took the new name meanwhile)
        stillSo(DB, 'EXISTS (SELECT 1 FROM donor_orgs WHERE key = ? AND name = ?) AND NOT EXISTS (SELECT 1 FROM donor_orgs WHERE name_key = ? AND key <> ?)', key, crm.org.get(key).name, orgNameKey(name), key),
        ...await pinOldName(DB, crm, key, by, now),
        ...await keepOthersGifts(DB, crm, name, key, by, now),
        DB.prepare('UPDATE donor_orgs SET name = ?, name_key = ? WHERE key = ?').bind(name, orgNameKey(name), key),
        // Both names written down, kept or not (they count only while it's kept)
        callStmt(DB, { kind: 'kept-name', subject: looseKey(crm.org.get(key).name), target: key, answer: 1, note: crm.org.get(key).name }, by, now),
        callStmt(DB, { kind: 'kept-name', subject: looseKey(name), target: key, answer: 1, note: name }, by, now),
      ]);
    } catch (e) {
      if (!notSo(e)) throw e;
      const now2 = (await loadCrm(DB, { now })).org.get(key);
      if (!now2) throw bad('That organization isn’t here any more. Reload and look again.', 404);
      if (now2.name === name) return { ok: true, same: true };
      if (now2.name !== crm.org.get(key).name) throw bad(`Someone renamed it ${now2.name} since you looked. Nothing was changed.`, 409);
      throw bad(`Another organization here took the name ${name} a moment ago. Nothing was changed.`, 409);
    }
    await audit(DB, by, `Organization renamed: ${name}`, { key, was: crm.org.get(key).name, name }, key);
    return { ok: true };
  }
  if (a === 'org-delete') {
    // Taken out already (this sent again after its answer was lost, a teammate first): done already
    if (/^o:/.test(String(body.key || '')) && !crm.live(String(body.key)) && !crm.calls.forward.get(String(body.key))) return { ok: true, same: true };
    const key = orgOk(body.key);
    if (!key.startsWith('o:')) throw bad('A partner is deleted in its partner card');
    // What the page said would go with it (its notes, its owner): a teammate's note or owner since is never lost unseen
    const saw = body.was && typeof body.was === 'object' ? body.was : null;
    const notesNow = ((await DB.prepare('SELECT id, by FROM donor_notes WHERE subject = ?').bind(key).all()).results || []);
    if (saw) {
      const seen = new Set(Array.isArray(saw.notes) ? saw.notes.map(String) : []);
      const added = notesNow.find((n) => !seen.has(n.id));
      if (added) throw bad(`${(added.by || 'Someone').split('@')[0].replace(/^./, (c) => c.toUpperCase())} added a note since you looked. Nothing was taken out; read it first.`, 409);
      if (typeof saw.owner === 'string' && (crm.lookedAfterBy(key) || '') !== saw.owner.toLowerCase()) throw bad(`Someone changed who looks after it since you looked. Nothing was taken out.`, 409);
      // Kept anonymous since (taking it out would show its givers' names on the board's list again, unasked)
      if (typeof saw.kept === 'boolean' && saw.kept !== crm.keptKey(key)) throw bad(`Someone ${crm.keptKey(key) ? 'kept it anonymous' : 'stopped keeping it anonymous'} since you looked. Nothing was taken out; read it first.`, 409);
    }
    // (and none added in the moment between: checked in the step that takes it out)
    const ownRead = crm.ownerRows([key]);
    const noneNew = stillSo(DB, `(SELECT COUNT(*) FROM donor_notes WHERE subject = ? AND id NOT IN (SELECT value FROM json_each(?))) = 0
      AND (SELECT COUNT(*) FROM donor_calls WHERE kind = 'owner' AND subject = ?) = ?
      AND (SELECT COUNT(*) FROM donor_calls d, json_each(?) j WHERE d.kind = 'owner' AND d.subject = json_extract(j.value, '$[0]')
        AND d.answer = json_extract(j.value, '$[1]') AND d.note IS json_extract(j.value, '$[2]') AND d.at = json_extract(j.value, '$[3]')) = ?
      AND (SELECT COUNT(*) FROM donor_calls WHERE kind = 'anon' AND subject = ? AND answer = 1) = ?`,
    key, JSON.stringify(notesNow.map((n) => n.id)), key, ownRead.length, JSON.stringify(ownRead), ownRead.length, key, crm.keptKey(key) ? 1 : 0);
    // Made from a Zeffy contact (kept as an organization): everything said about it goes back to that contact (owner,
    // notes, Keep anonymous, "not the same person", History); its links and names, which were the organization's, go
    const from = await DB.prepare("SELECT target FROM donor_calls WHERE kind = 'made-from' AND subject = ? AND answer = 1").bind(key).first();
    // All in one step: a failure part way (and the page sending it again) never takes the contact's own away
    const back = [];
    if (from?.target) {
      const gone = (c) => (c.target === key && ['contact', 'company', 'kept-name', 'forward', 'big'].includes(c.kind)) || (c.subject === key && ['made-from', 'level'].includes(c.kind));
      const moved = await moveSteps(DB, key, String(from.target), { skip: gone });
      back.push(
        // (everything said about it still as read: a link or answer added in between is never left behind)
        moved.guard,
        DB.prepare("DELETE FROM donor_calls WHERE (target = ? AND kind IN ('contact', 'company', 'kept-name', 'forward', 'big')) OR (subject = ? AND kind IN ('made-from', 'level'))").bind(key, key),
        DB.prepare("DELETE FROM donor_calls WHERE kind = 'payment' AND note = ?").bind(key),
        ...moved,
        ...await historySteps(DB, key, String(from.target)),
      );
    }
    const historyAt = from?.target ? String(from.target) : key;
    const takeOut = [
      noneNew,
      ...back,
      DB.prepare('DELETE FROM donor_orgs WHERE key = ?').bind(key),
      DB.prepare('DELETE FROM donor_calls WHERE target = ? OR subject = ?').bind(key, key),
      DB.prepare('DELETE FROM donor_notes WHERE subject = ?').bind(key),
      // A gift a person counted for it goes back to counting as the site works it out
      DB.prepare("DELETE FROM donor_calls WHERE kind = 'payment' AND note = ?").bind(key),
      // Remembered as taken out, and where what was said about it went: a page still open on it (a teammate's), or
      // opened again, says so, and a note being written there goes to that record
      callStmt(DB, { kind: 'taken-out', subject: key, target: from?.target ? String(from.target) : '', answer: 1, note: crm.org.get(key)?.name || null }, by, now),
    ];
    try { await DB.batch(takeOut); } catch (e) {
      if (!notSo(e)) throw e;
      throw bad('Someone added a note, changed who looks after it or changed Keep anonymous a moment ago. Nothing was taken out; read it first.', 409);
    }
    if (from?.target) await oneLinkEach(DB);
    await audit(DB, by, `Organization taken out: ${crm.org.get(key).name} (its gifts count for the people who gave them)`, { key }, historyAt);
    return { ok: true };
  }
  if (a === 'website') {
    // A private organization just put on the website (its partner card made): everything said about it is the partner's
    const slug = clean(body.slug);
    // Asked again after it went through (Try again, a second tab): done already
    if (!crm.live(String(body.key || '')) && crm.calls.forward.get(String(body.key || '')) === `p:${slug}`) return { ok: true, key: `p:${slug}` };
    // Put on the website already, under another partner card (another tab): the card just made is the extra one
    const went = crm.calls.forward.get(String(body.key || ''));
    if (!crm.live(String(body.key || '')) && went && crm.isOrg(went)) throw Object.assign(bad(`It’s on the website already as ${crm.org.get(went).name}: someone put it there meanwhile. The partner card just made isn’t needed; delete it in Partners.`, 409), { went });
    const key = orgOk(body.key);
    if (!key.startsWith('o:') || !crm.live(`p:${slug}`)) throw bad('That partner card isn’t saved yet. Save it, then try again.', 409);
    const name = crm.org.get(key).name;
    // Kept anonymous (or not) as the person saw it when they chose to put it on the website: a teammate's change
    // since is never put on the Partners page unasked
    const saw = body.was && typeof body.was === 'object' ? body.was : null;
    if (saw && typeof saw.kept === 'boolean' && saw.kept !== crm.keptKey(key)) {
      throw bad(`Someone ${crm.keptKey(key) ? 'kept it anonymous' : 'stopped keeping it anonymous'} since you looked, so it wasn’t put on the website. The partner card just made isn’t on the Partners page until you publish: delete it in Partners if it isn’t wanted.`, 409);
    }
    // All of it in one step, while its owner and Keep anonymous are as read (a teammate's change in between is never
    // left behind under the old address): the gifts its name counted by itself, everything said about it, its History,
    // and its old address leading to the partner (a link in a toast, a bookmark)
    const ownRead = crm.ownerRows([key]);
    const steps = [
      stillSo(DB, `(SELECT COUNT(*) FROM donor_calls WHERE kind = 'owner' AND subject = ?) = ?
        AND (SELECT COUNT(*) FROM donor_calls d, json_each(?) j WHERE d.kind = 'owner' AND d.subject = json_extract(j.value, '$[0]')
          AND d.answer = json_extract(j.value, '$[1]') AND d.note IS json_extract(j.value, '$[2]') AND d.at = json_extract(j.value, '$[3]')) = ?
        AND (SELECT COUNT(*) FROM donor_calls WHERE kind = 'anon' AND subject = ? AND answer = 1) = ?`,
      key, ownRead.length, JSON.stringify(ownRead), ownRead.length, key, crm.keptKey(key) ? 1 : 0),
    ];
    // (everything said about it still as read: a Zeffy name a teammate adds in between is never left behind)
    const moved = await moveSteps(DB, key, `p:${slug}`);
    steps.push(
      moved.guard,
      ...await pinOldName(DB, crm, key, by, now, { to: `p:${slug}` }),
      ...moved,
      ...await historySteps(DB, key, `p:${slug}`),
      DB.prepare('DELETE FROM donor_orgs WHERE key = ?').bind(key),
      callStmt(DB, { kind: 'forward', subject: key, target: `p:${slug}`, answer: 1 }, by, now),
    );
    try { await DB.batch(steps); } catch (e) {
      if (!notSo(e)) throw e;
      throw bad('Someone changed something about it a moment ago (its owner, Keep anonymous, or a name), so it wasn’t put on the website. Look again, then try once more.', 409);
    }
    await oneLinkEach(DB);
    await audit(DB, by, `${name} is on the website now`, { key, partner: slug }, `p:${slug}`);
    return { ok: true, key: `p:${slug}` };
  }
  // Who on the team looks after them (one person; none clears it)
  if (a === 'owner') {
    const key = whose(crm, body.key, orgOk);
    const email = clean(body.email).toLowerCase();
    // Already them (tried again after an answer was lost, a teammate who picked the same): nothing to change
    if ((crm.lookedAfterBy(key) || '') === email) return { ok: true, same: true };
    // The owner the person saw (another tab, a teammate since): never a quiet second answer over the first
    const changed = (now2) => bad(`Someone changed who looks after them since you looked${now2 ? ` (${now2.split('@')[0].replace(/^./, (c) => c.toUpperCase())} now)` : ' (no one now)'}. Nothing was changed.`, 409);
    // (`was` may name two: the owner as read and a pick still on its way, sent as the tab closed behind it: either is
    // what the person last chose from)
    const wasAny = Array.isArray(body.was) ? body.was.map((x) => String(x || '').toLowerCase()) : typeof body.was === 'string' ? [body.was.toLowerCase()] : null;
    if (wasAny && !wasAny.includes((crm.lookedAfterBy(key) || '').toLowerCase())) throw changed(crm.lookedAfterBy(key));
    let name = null;
    if (email) {
      const staff = await staffList(DB);
      const one = staff.find((s) => s.email === email);
      // Before Google's list is read: any SOARD address
      if (!one && (staff.length || !isStaffEmail(email))) throw bad('Pick someone on the team.');
      name = one?.name || email;
    }
    // Said on the record that leads a person; any said on their other records goes, so there's only ever one (one said
    // under an email of theirs from before Zeffy had a contact for them too: it would come back on the next read)
    const keys = isOrgKey(key) ? [key] : [...crm.keysOf(key)];
    if (!isOrgKey(key)) {
      const own = await rowsFor(DB, keys.filter((k) => /^[ce]:/.test(k)));
      for (const e of new Set(own.map((r) => r.email).filter(Boolean))) if (!keys.includes(`e:${e}`)) keys.push(`e:${e}`);
    }
    // In one step, and only while the owner answers under these keys are the ones read above
    const read = crm.ownerRows(keys);
    try {
      await DB.batch([
        stillSo(DB, `(SELECT COUNT(*) FROM donor_calls WHERE kind = 'owner' AND subject IN (SELECT value FROM json_each(?))) = ?
          AND (SELECT COUNT(*) FROM donor_calls d, json_each(?) j WHERE d.kind = 'owner' AND d.subject = json_extract(j.value, '$[0]')
            AND d.answer = json_extract(j.value, '$[1]') AND d.note IS json_extract(j.value, '$[2]') AND d.at = json_extract(j.value, '$[3]')) = ?`,
        JSON.stringify(keys), read.length, JSON.stringify(read), read.length),
        ...keys.map((k) => DB.prepare("DELETE FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(k)),
        // An organization's "No one" is said, so it doesn't take the owner of a contact counted for it
        ...(email ? [callStmt(DB, { kind: 'owner', subject: key, answer: 1, note: email }, by, now)] : isOrgKey(key) ? [callStmt(DB, { kind: 'owner', subject: key, answer: 0 }, by, now)] : []),
      ]);
    } catch (e) {
      if (!notSo(e)) throw e;
      const fresh = (await loadCrm(DB, { now })).lookedAfterBy(key) || '';
      if (fresh === email) return { ok: true, same: true };
      throw changed(fresh);
    }
    await audit(DB, by, email ? `Looked after by ${name}` : 'No one looks after them now', { key, owner: email || null }, key);
    return { ok: true };
  }
  // The team's notes
  if (a === 'note-add') {
    const key = whose(crm, body.key, orgOk);
    const text = String(body.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
    if (!text) throw bad('Write the note first.');
    // The page names the note: a save tried again after its answer was lost is that note, never a second one
    const id = /^[a-z0-9-]{8,40}$/i.test(String(body.id || '')) ? String(body.id) : crypto.randomUUID();
    const r = await DB.prepare('INSERT OR IGNORE INTO donor_notes (id, subject, body, by, at) VALUES (?, ?, ?, ?, ?)').bind(id, key, text, by || null, iso(now)).run();
    if (r.meta?.changes) await audit(DB, by, 'Note added', { key, note: id }, key);
    return { ok: true, id };
  }
  if (a === 'note-edit' || a === 'note-delete') {
    const n = await DB.prepare('SELECT id, subject FROM donor_notes WHERE id = ?').bind(String(body.id || '')).first();
    // Deleted already (this sent again after its answer was lost, a teammate first): done already
    if (!n && a === 'note-delete') return { ok: true, same: true };
    if (!n) throw bad('That note isn’t here any more. Reload and look again.', 404);
    const was = typeof body.was === 'string' ? body.was.replace(/\r\n?/g, '\n') : null;
    const changedBy = (cur) => `${(cur.edited_by || cur.by || 'Someone').split('@')[0].replace(/^./, (c) => c.toUpperCase())} changed this note since you looked.`;
    if (a === 'note-delete') {
      // Only the note as the person saw it: changed by a teammate since, it stays (their words are never lost unseen)
      const r = await DB.prepare(`DELETE FROM donor_notes WHERE id = ?${was === null ? '' : ' AND body = ?'}`).bind(n.id, ...(was === null ? [] : [was])).run();
      if (!r.meta?.changes) {
        const cur = await DB.prepare('SELECT body, edited_by, by FROM donor_notes WHERE id = ?').bind(n.id).first();
        if (!cur) return { ok: true, same: true };
        throw bad(`${changedBy(cur)} Nothing was deleted; it shows as it is now.`, 409);
      }
      await audit(DB, by, 'Note deleted', { key: n.subject, note: n.id }, n.subject);
      return { ok: true };
    }
    const text = String(body.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
    if (!text) throw bad('A note can’t be empty. Delete it instead.');
    // (named by the press that sent it: sent again, it's done already, and a page that never heard can ask)
    const editId = /^[0-9a-z-]{8,64}$/i.test(String(body.edit || '')) ? String(body.edit) : null;
    if (editId && await DB.prepare('SELECT 1 AS y FROM donor_note_edits WHERE edit_id = ?').bind(editId).first()) return { ok: true, same: true };
    const madeIt = () => (editId ? DB.prepare('INSERT OR IGNORE INTO donor_note_edits (edit_id, note_id, at) VALUES (?, ?, ?)').bind(editId, n.id, iso(now)).run() : null);
    // Written only while it's the note the person changed: in the one statement. Reading as they wrote it already
    // (this sent again after its answer was lost): done already
    const r = await DB.prepare(`UPDATE donor_notes SET body = ?, edited_by = ?, edited_at = ? WHERE id = ?${was === null ? '' : ' AND body = ?'}`)
      .bind(text, by || null, iso(now), n.id, ...(was === null ? [] : [was])).run();
    if (!r.meta?.changes) {
      const cur = await DB.prepare('SELECT body, edited_by, by FROM donor_notes WHERE id = ?').bind(n.id).first();
      if (!cur) throw bad('That note isn’t here any more. Reload and look again.', 404);
      if (cur.body === text) { await madeIt(); return { ok: true, same: true }; }
      throw bad(`${changedBy(cur)} Nothing was changed; it shows as it is now.`, 409);
    }
    await madeIt();
    await audit(DB, by, 'Note changed', { key: n.subject, note: n.id }, n.subject);
    return { ok: true };
  }
  // A thank-you said: thanked, not needed, or (Undo) To thank again
  if (a === 'thanks') {
    const t = await markThanks(DB, { id: body.id, state: body.state, was: ['todo', 'thanked', 'skipped'].includes(body.was) ? body.was : null }, by, { now });
    // Already so (a second click, a teammate who said the same): nothing happened, so nothing in History
    if (t.same) return { ok: true, was: t.state, same: true, by: t.done_by || null, you: !!by && t.done_by === by };
    const owner = await donorOfPayment(env, String(t.ids).split(' ')[0], { crm }).catch(() => null);
    const words = { thanked: 'Thanked', skipped: 'No thank-you needed', todo: 'To thank again' }[body.state];
    await audit(DB, by, `${words}: ${t.in_kind ? `${usd(t.in_kind)} in kind` : !Number(t.cents) && t.why === 'kind' ? 'a gift in kind' : usd(t.cents)} from ${t.name || 'a donor'}${t.at ? `, ${new Date(t.at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}` : ''}`, { gift: t.id, state: body.state, was: t.state }, owner || 'donors');
    return { ok: true, was: t.state };
  }
  if (a === 'moved-done') {
    const old = clean(body.contact);
    // The team's notes, owner and History, left on the old record (no gifts of its own now): to the contact picked
    const to = clean(body.to);
    if (to) {
      const st0 = await readCrmState(DB);
      const u = (st0.unplaced || []).find((x) => x.contact === old);
      if (!u || !u.to.includes(to)) throw bad('That isn’t one of the contacts Zeffy moved its gifts to. Reload and look again.', 409);
      // As the card says, and only that: its notes and History go to the one picked, its owner only to one with no
      // owner of its own (one that has one keeps theirs). What it was said to be (the same person as someone, an
      // organization's) stays with the old record, to be said again on the right one. One step, while it's unanswered
      // as read (two staff at the same moment: the second is told)
      const into = crm.canon(`c:${to}`);
      const theirOwner = crm.lookedAfterBy(into);
      await asAnswered(DB, asRead(DB, crm, 'moved', [old]), [
        DB.prepare('UPDATE donor_notes SET subject = ? WHERE subject = ?').bind(into, `c:${old}`),
        ...(theirOwner ? [] : [DB.prepare("INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) SELECT 'owner', ?, '', answer, note, by, at FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(into, `c:${old}`)]),
        DB.prepare("DELETE FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(`c:${old}`),
        ...await historySteps(DB, `c:${old}`, into),
        // Remembered (and where its notes went), so the next whole read doesn't ask again
        callStmt(DB, { kind: 'moved', subject: old, answer: 1, note: to }, by, now),
      ]);
    } else await asAnswered(DB, asRead(DB, crm, 'moved', [old]), [callStmt(DB, { kind: 'moved', subject: old, answer: 1, note: null }, by, now)]);
    const st = await readCrmState(DB);
    await writeCrmState(DB, { unplaced: (st.unplaced || []).filter((u) => u.contact !== String(body.contact)) });
    await audit(DB, by, 'A contact Zeffy split was looked at, and what was known said again where it belongs', { contact: String(body.contact || '') });
    return { ok: true };
  }
  throw bad('Unknown change');
}

/**
 * An organization here named `name` (new, or renamed) matches Zeffy contacts of exactly that name by itself. A contact
 * whose gifts count for another organization now (its company is linked there) keeps them: it's told "not this one" for
 * the named organization, in the same step. → the statements
 */
// (`people`: made from a name typed on gifts, so a person whose own name reads the same keeps their gifts)
async function keepOthersGifts(DB, crm, name, key, by, now, { linking = [], people = false } = {}) {
  const k = nameKey(name);
  if (!k) return [];
  const rows = await allRows(DB);
  const place = crm.placer(rows);
  const keep = new Set();
  const pinned = [];
  for (const r of rows) {
    if (nameKey(givenName({ first_name: r.first, last_name: r.last })) !== k) continue;
    const owner = place(r).owner;
    // (counting for this one already: its own, never told "not this one")
    if (owner === key) continue;
    // A person of that name (a company named after its giver: "Jane Doe LLC" is Jane Doe in plain letters) keeps their
    // own gifts; a contact whose own name reads as an organization's ("Ivers Foundation") is the organization's
    if (!crm.isOrg(owner) && (!people || !r.contact || ORG_WORDS.test(givenName({ first_name: r.first, last_name: r.last })))) continue;
    if (r.contact) {
      if (!keep.has(r.contact) && !linking.includes(r.contact) && !crm.calls.yes.has(`contact\n${r.contact}`)) keep.add(r.contact);
    } else if (!crm.calls.pay.has(String(r.id))) {
      // A gift with no Zeffy contact matches by its own name too: it's told, itself, whose it is
      pinned.push(callStmt(DB, { kind: 'payment', subject: r.id, answer: 1, note: owner }, by, now));
    }
  }
  return [...[...keep].map((c) => callStmt(DB, { kind: 'contact', subject: c, target: key, answer: 0 }, by, now)), ...pinned];
}

/**
 * Before an organization here takes another name (renamed, or put on the website under its partner card's): the gifts
 * its old name counted by itself (a company typed exactly so, a Zeffy contact named so) are linked to it, so they stay.
 * → the statements
 */
// (`to`: where they're linked, when it goes elsewhere in the same step: put on the website as a partner card)
async function pinOldName(DB, crm, key, by, now, { to = key } = {}) {
  const old = crm.org.get(key)?.name;
  const k = nameKey(old);
  if (!k) return [];
  const rows = await allRows(DB);
  const place = crm.placer(rows);
  const steps = [];
  const seen = new Set();
  for (const r of rows) {
    if (place(r).owner !== key) continue;
    const byName = nameKey(givenName({ first_name: r.first, last_name: r.last })) === k;
    // A Zeffy contact that is the organization as a whole (every name of it this one's): linked, so it stays whole
    const whole = byName && r.contact && !crm.calls.yes.has(`contact\n${r.contact}`) && crm.contactIsOrg(r.contact) === key;
    if (whole && !seen.has(`c${r.contact}`)) {
      seen.add(`c${r.contact}`);
      steps.push(callStmt(DB, { kind: 'contact', subject: r.contact, target: to, answer: 1 }, by, now));
    }
    // A gift given under its name by a person (their other gifts are theirs), or with no Zeffy contact: told, itself,
    // that it's this one's, and nothing more of theirs moves
    if (byName && !whole && !(r.contact && crm.calls.yes.get(`contact\n${r.contact}`) === key) && !crm.calls.pay.has(String(r.id))) {
      steps.push(callStmt(DB, { kind: 'payment', subject: r.id, answer: 1, note: to }, by, now));
    }
    const ck = r.corporate && clean(r.company) ? nameKey(r.company) : '';
    if (ck === k && !seen.has(`k${ck}`) && !crm.calls.yes.has(`company\n${ck}`)) {
      seen.add(`k${ck}`);
      steps.push(callStmt(DB, { kind: 'company', subject: ck, target: to, answer: 1, note: clean(r.company).slice(0, 200) }, by, now));
    }
  }
  return steps;
}

/**
 * Before a partner card is saved under a name it didn't have (added, or renamed in the Partners editor): the gifts its
 * old name counted by itself stay with it, an organization already called the new name keeps the gifts that name
 * counted for it (two of one name would each lose them), and a contact of that name whose gifts count for another
 * organization keeps them there, as Keep as an organization and Rename do here. Nothing to keep → nothing written.
 */
export async function keepGiftsForPartnerName(DB, { slug, name, by = null, now = Date.now() } = {}) {
  const key = `p:${slug}`;
  const to = clean(name) || String(slug || '');
  if (!slug || !nameKey(to)) return 0;
  const crm = await loadCrm(DB, { now });
  const was = crm.org.get(key)?.name;
  if (was && nameKey(was) === nameKey(to)) return 0;
  const steps = [];
  if (was) steps.push(...await pinOldName(DB, crm, key, by, now));
  for (const o of crm.named(to, key)) steps.push(...await pinOldName(DB, crm, o, by, now));
  steps.push(...await keepOthersGifts(DB, crm, to, key, by, now));
  if (steps.length) await DB.batch(steps);
  // Its name shows on To thank and the list: open tabs read again
  await markChanged(DB);
  return steps.length;
}

/** A Needs you question still open, or 409 saying who answered it (an answer that has run out, a year on, is open) */
async function stillAsked(DB, crm, body, now) {
  const a = body.act;
  const yearOn = (at) => now - Date.parse(at) > YEAR_MS;
  let q = [];
  if ((a === 'link' || a === 'not') && KINDS.has(body.kind)) {
    const subject = subjectOf(body.kind, body.subject);
    const org = String(body.org || '');
    q = [{ sql: "kind = ? AND subject = ? AND (target = ? OR answer = 1)", args: [body.kind, subject, org], live: (c) => c.target === org || crm.live(c.target), same: (c) => c.target === org && !!c.answer === (a === 'link') }];
  } else if (a === 'same') {
    const [x, y] = [String(body.a || ''), String(body.b || '')].sort();
    q = [{ sql: "kind = 'same' AND subject = ? AND target = ?", args: [x, y], same: (c) => !!c.answer === !!body.same }];
  } else if (a === 'payment') q = [{ sql: "kind = 'payment' AND subject = ?", args: [clean(body.id)], same: (c) => String(c.note) === (body.owner === 'person' ? 'person' : String(body.owner || '')) }];
  else if (a === 'big') {
    const subs = [String(body.subject || ''), ...(Array.isArray(body.also) ? body.also : [])].filter(Boolean).map(String);
    // Kept as an organization, or counted for one, since the card was read (by a teammate, on its page): answered
    for (const sub of subs) {
      const [kind, id] = [sub.slice(0, sub.indexOf(':')), sub.slice(sub.indexOf(':') + 1)];
      const t = kind === 'company' ? crm.calls.yes.get(`company\n${id}`) : kind === 'contact' ? crm.calls.yes.get(`contact\n${id}`) || crm.contactIsOrg(id) : null;
      if (t && crm.live(t)) throw bad(`It counts for ${crm.org.get(t).name} now: someone kept it as an organization, or linked it, since this was read. Nothing was changed.`, 409);
    }
    q = subs.map((sub) => ({ sql: "kind = 'big' AND subject = ?", args: [sub], live: (c) => c.note === 'person' || (c.note === 'org' ? crm.live(c.target) : !yearOn(c.at)), same: (c) => (body.person === true ? c.note === 'person' : !c.note) && !c.answer }));
  } else if (a === 'level') q = [{ sql: "kind = 'level' AND subject = ?", args: [String(body.org || '')], live: (c) => c.answer || !yearOn(c.at), same: (c) => !!c.answer === !!body.done }];
  else if (a === 'moved-done') q = [{ sql: "kind = 'moved' AND subject = ?", args: [String(body.contact || '')], same: (c) => (c.note || '') === clean(body.to) }];
  else if (a === 'org-new') {
    // Keep it as an organization: the card's own question (big, named) not answered since, and its names linked to no one
    q = [String(body.subject || ''), ...(Array.isArray(body.also) ? body.also : [])].filter(Boolean)
      .map((sub) => ({ sql: "kind = 'big' AND subject = ?", args: [String(sub)], live: (c) => c.note === 'person' || (c.note === 'org' ? crm.live(c.target) : !yearOn(c.at)) }));
    for (const l of Array.isArray(body.links) ? body.links.slice(0, 10) : []) {
      if (!KINDS.has(l?.kind)) continue;
      q.push({ sql: 'kind = ? AND subject = ? AND answer = 1', args: [l.kind, subjectOf(l.kind, l.subject)], live: (c) => crm.live(c.target) });
    }
    if (crm.named(clean(body.name)).length) throw bad(`${crm.org.get(crm.named(clean(body.name))[0]).name} is an organization here already: someone kept it since this list was read. Nothing was changed.`, 409);
  }
  let same = 0;
  for (const { sql, args, live, same: isSame } of q) {
    const cs = (await DB.prepare(`SELECT kind, target, answer, note, by, at FROM donor_calls WHERE ${sql} ORDER BY at DESC LIMIT 20`).bind(...args).all()).results || [];
    const c = cs.find((x) => !live || live(x));
    // The very answer being given, given already (this sent again after its answer was lost; a teammate who said it)
    if (c && isSame && isSame(c)) { same++; continue; }
    if (c) throw bad(`${c.by && c.by.includes('@') ? `${c.by.split('@')[0][0].toUpperCase()}${c.by.split('@')[0].slice(1)}` : 'Someone'} answered this already. Nothing was changed; the list is read again.`, 409);
  }
  return q.length && same === q.length ? 'same' : null;
}

/** The donor a change is about: an organization that's here, or a person as the record that leads them */
function whose(crm, k, orgOk) {
  const key = isOrgKey(k) ? orgOk(k) : crm.canon(String(k || ''));
  if (!/^[cenxpo]:/.test(key)) throw bad('Whose?');
  return key;
}

/** What was done to a donor (History: audit_log under their key) goes where they are now. Without the log (tests): nothing to move */
async function moveHistory(DB, from, into) {
  if (from === into) return;
  await DB.prepare("UPDATE audit_log SET entity_slug = ? WHERE entity_type = 'donor-crm' AND entity_slug = ?").bind(into, from).run().catch((e) => { if (!missingTable(e)) throw e; });
}

/** Everything said about one organization (or person key) is now another's; where the other already has an answer, its own stands */
async function moveCalls(DB, from, into) {
  await DB.batch(await moveSteps(DB, from, into));
  await moveHistory(DB, from, into);
  await oneLinkEach(DB);
}
/** Everything said about one key, moved to another, as statements (`skip`: answers that go instead of moving) */
async function moveSteps(DB, from, into, { skip = () => false } = {}) {
  const read = (await DB.prepare('SELECT kind, subject, target, answer, note, by, at FROM donor_calls WHERE subject = ? OR target = ?').bind(from, from).all()).results || [];
  const rows = read.filter((c) => !skip(c));
  // One batch: everything moves, or nothing does (Keep anonymous and the names it hides under never part)
  const steps = [];
  for (const c of rows) {
    const subject = c.subject === from ? into : c.subject;
    const target = c.target === from ? into : c.target;
    if (c.kind === 'same' && subject === target) { steps.push(DB.prepare('DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND target = ?').bind(c.kind, c.subject, c.target)); continue; }
    const [s2, t2] = c.kind === 'same' ? [subject, target].sort() : [subject, target];
    // Keep anonymous on either is kept on the one they are now (never lost to an old "no")
    // A name linked to the old one is the new one's, over a "no" the new one had for it: the merge says they're one
    const wins = c.kind === 'anon' || (KINDS.has(c.kind) && c.answer);
    const put = wins
      ? DB.prepare(`INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(kind, subject, target) DO UPDATE SET answer = MAX(donor_calls.answer, excluded.answer)`).bind(c.kind, s2, t2, c.answer, c.note, c.by, c.at)
      // An owner: the one said later (the one a joined person showed) stands
      : c.kind === 'owner'
        ? DB.prepare(`INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, subject, target) DO UPDATE SET answer = excluded.answer, note = excluded.note, by = excluded.by, at = excluded.at WHERE excluded.at > donor_calls.at`).bind(c.kind, s2, t2, c.answer, c.note, c.by, c.at)
        : DB.prepare('INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(c.kind, s2, t2, c.answer, c.note, c.by, c.at);
    steps.push(put, DB.prepare('DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND target = ?').bind(c.kind, c.subject, c.target));
  }
  // A gift a person counted for the old one counts for the new one; its notes are the new one's
  steps.push(DB.prepare("UPDATE donor_calls SET note = ? WHERE kind = 'payment' AND note = ?").bind(into, from));
  steps.push(DB.prepare('UPDATE donor_notes SET subject = ? WHERE subject = ?').bind(into, from));
  // (for a caller to put first in its step: everything said about `from` is still what was read, so nothing said in
  // between is left behind under an address that's going)
  steps.guard = stillSo(DB, `(SELECT COUNT(*) FROM donor_calls WHERE subject = ? OR target = ?) = ?
    AND (SELECT COUNT(*) FROM donor_calls d, json_each(?) j WHERE d.kind = json_extract(j.value, '$[0]') AND d.subject = json_extract(j.value, '$[1]')
      AND d.target = json_extract(j.value, '$[2]') AND d.answer = json_extract(j.value, '$[3]') AND d.note IS json_extract(j.value, '$[4]') AND d.at = json_extract(j.value, '$[5]')) = ?`,
  from, from, read.length, JSON.stringify(read.map((c) => [c.kind, String(c.subject), String(c.target ?? ''), c.answer ? 1 : 0, c.note ?? null, c.at])), read.length);
  // A Zeffy contact's answers to "is it an organization?" (said of contact:<id>): the other's own stand
  if (from.startsWith('c:') && into.startsWith('c:')) {
    steps.push(DB.prepare("UPDATE OR IGNORE donor_calls SET subject = ? WHERE kind = 'big' AND subject = ?").bind(`contact:${into.slice(2)}`, `contact:${from.slice(2)}`));
    steps.push(DB.prepare("DELETE FROM donor_calls WHERE kind = 'big' AND subject = ?").bind(`contact:${from.slice(2)}`));
  }
  return steps;
}
/** History's statement for moving a key (none without the log: tests) */
async function historySteps(DB, from, into) {
  if (from === into) return [];
  const has = await DB.prepare("SELECT 1 AS y FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").first().catch(() => null);
  return has ? [DB.prepare("UPDATE audit_log SET entity_slug = ? WHERE entity_type = 'donor-crm' AND entity_slug = ?").bind(into, from)] : [];
}
/** A contact or company linked to two organizations after a move: one link (the newer) */
async function oneLinkEach(DB) {
  const dup = (await DB.prepare("SELECT kind, subject FROM donor_calls WHERE kind IN ('contact', 'company') AND answer = 1 GROUP BY kind, subject HAVING COUNT(*) > 1").all()).results || [];
  for (const d of dup) await DB.prepare("DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND answer = 1 AND at < (SELECT MAX(at) FROM donor_calls WHERE kind = ? AND subject = ? AND answer = 1)").bind(d.kind, d.subject, d.kind, d.subject).run();
}

/** Partners → Merge into: what was said about the old company is the new one's (./_room-credits.js mergeCredits) */
export async function mergeOrgCalls(DB, from, into) {
  await ensureCrm(DB);
  const nameOf = async (slug) => { const r = await DB.prepare('SELECT data FROM partners WHERE slug = ?').bind(slug).first(); try { return JSON.parse(r?.data || '{}').name || ''; } catch { return ''; } };
  const [fromName, intoName] = await Promise.all([nameOf(from), nameOf(into)]);
  const at = new Date().toISOString();
  // Every name it had, kept or not (they hide only while the one it went into is kept)
  const all = [...new Set([fromName, ...(await historyNames(DB, from))].filter(Boolean))];
  if (all.length) await DB.batch(all.map((n) => callStmt(DB, { kind: 'kept-name', subject: looseKey(n), target: `p:${from}`, answer: 1, note: n }, 'Partners merge', Date.parse(at))));
  if (fromName) {
    // Gifts under its name count for the one it went into (the name no longer matches a partner by itself): a company
    // typed with it, and a Zeffy contact named it
    const k = nameKey(fromName);
    if (k && k !== nameKey(intoName)) {
      await DB.prepare("INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) SELECT 'company', ?, ?, 1, NULL, 'Partners merge', ? WHERE NOT EXISTS (SELECT 1 FROM donor_calls WHERE kind = 'company' AND subject = ? AND answer = 1)")
        .bind(k, `p:${from}`, at, k).run();
      // A Zeffy contact that is it (every name of it this one's) is linked; a person's gift given under its name is
      // pinned by itself (their other gifts stay theirs), as a rename does it
      const pins = await pinOldName(DB, await loadCrm(DB), `p:${from}`, 'Partners merge', Date.parse(at));
      if (pins.length) await DB.batch(pins);
    }
  }
  await moveCalls(DB, `p:${from}`, `p:${into}`);
  await markChanged(DB);
}

/** Kept organizations' current names, written down when the site sees them (a rename in the Partners editor) */
export async function rememberKeptNames(DB, crm, { now = Date.now() } = {}) {
  const todo = crm.unrecordedNames();
  if (todo.length) await DB.batch(todo.map((o) => callStmt(DB, { kind: 'kept-name', subject: looseKey(o.name), target: o.key, answer: 1, note: o.name }, 'seen', now)));
}

// ─── Zeffy merges ───────────────────────────────────────────────────

async function readCrmState(DB) {
  await ensureCrm(DB);
  const row = await DB.prepare("SELECT value FROM donor_state WHERE key = 'crm'").first();
  try { return JSON.parse(row?.value || '{}'); } catch { return {}; }
}
async function writeCrmState(DB, patch) {
  const next = { ...(await readCrmState(DB)), ...patch };
  await DB.prepare("INSERT INTO donor_state (key, value) VALUES ('crm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(next)).run();
  return next;
}

/**
 * After a whole read of Zeffy: a contact the site knows something about (a link, Keep anonymous, the same person, an
 * owner, notes, History, "is it an organization?") that has no payments left, whose payments all went to one other
 * contact (Zeffy merged them), is that contact now. Went to several: a person decides (Needs you). And a giver the
 * site knew only by email, now on a Zeffy contact of their own: their owner, notes and History go to it.
 * → { moved, unplaced }
 */
export async function followMerges(DB, { now = Date.now() } = {}) {
  await ensureCrm(DB);
  const calls = (await DB.prepare('SELECT kind, subject, target, answer FROM donor_calls').all()).results || [];
  const noteKeys = ((await DB.prepare('SELECT DISTINCT subject FROM donor_notes').all()).results || []).map((r) => String(r.subject));
  const historyKeys = ((await DB.prepare("SELECT DISTINCT entity_slug AS k FROM audit_log WHERE entity_type = 'donor-crm' AND (entity_slug LIKE 'c:%' OR entity_slug LIKE 'e:%')").all().catch(() => ({ results: [] }))).results || []).map((r) => String(r.k));
  const ids = new Set();
  const byEmail = new Set();
  for (const c of calls) {
    if (c.kind === 'contact') ids.add(String(c.subject));
    if (c.kind === 'big' && String(c.subject).startsWith('contact:')) ids.add(String(c.subject).slice(8));
    for (const v of [c.subject, c.target]) if (/^c:/.test(String(v)) && ['anon', 'same', 'owner'].includes(c.kind)) ids.add(String(v).slice(2));
    if (c.kind === 'owner' && String(c.subject).startsWith('e:')) byEmail.add(String(c.subject));
  }
  for (const k of [...noteKeys, ...historyKeys]) { if (k.startsWith('c:')) ids.add(k.slice(2)); else if (k.startsWith('e:')) byEmail.add(k); }
  const done = new Set(calls.filter((c) => c.kind === 'moved').map((c) => String(c.subject)));
  const list = [...ids].filter((id) => !done.has(id));
  // How many payments each still has: one query a chunk
  const left = new Map();
  for (let i = 0; i < list.length; i += 80) {
    const part = list.slice(i, i + 80);
    const r = (await DB.prepare(`SELECT contact, COUNT(*) AS n FROM donor_payments WHERE contact IN (${part.map(() => '?').join(', ')}) GROUP BY contact`).bind(...part).all()).results || [];
    for (const x of r) left.set(String(x.contact), Number(x.n) || 0);
  }
  const st = await readCrmState(DB);
  const unplaced = (st.unplaced || []).filter((u) => !done.has(u.contact));
  let moved = 0;
  // (who is the same as whom, read when a split needs it, and again after one of them moves)
  let crmNow = null;
  for (const id of list) {
    if (left.get(id) > 0) continue;
    const went = ((await DB.prepare('SELECT DISTINCT contact FROM donor_payments WHERE was_contact = ? AND contact IS NOT NULL').bind(id).all()).results || []).map((r) => String(r.contact));
    if (!went.length) continue;
    if (went.length === 1) {
      const to = went[0];
      // Which organization it is: the other's own link stands; every other answer goes with it (an answer the other
      // already has about that organization stands)
      const mine = (await DB.prepare("SELECT target, answer, note, by, at FROM donor_calls WHERE kind = 'contact' AND subject = ?").bind(id).all()).results || [];
      const theirYes = await DB.prepare("SELECT 1 FROM donor_calls WHERE kind = 'contact' AND subject = ? AND answer = 1").bind(to).first();
      for (const c of mine) {
        if (c.answer && theirYes) continue;
        // A link beats the kept one's "no" for that organization (the merge says they're one); a "no" never undoes a link
        await DB.prepare(c.answer
          ? `INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(kind, subject, target) DO UPDATE SET answer = MAX(donor_calls.answer, excluded.answer)`
          : 'INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('contact', to, c.target, c.answer, c.note, c.by, c.at).run();
      }
      await DB.prepare("DELETE FROM donor_calls WHERE kind = 'contact' AND subject = ?").bind(id).run();
      await moveCalls(DB, `c:${id}`, `c:${to}`);
      moved++;
      continue;
    }
    // Kept anonymous: each contact its gifts went to is kept too, at once (privacy first: a person can free one later)
    const kept = await DB.prepare("SELECT by, at FROM donor_calls WHERE kind = 'anon' AND subject = ? AND answer = 1").bind(`c:${id}`).first();
    if (kept) await DB.batch(went.slice(0, 5).map((c) => DB.prepare("INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES ('anon', ?, '', 1, NULL, ?, ?)").bind(`c:${c}`, kept.by, iso(now))));
    // A record that was part of a person (said to be the same as records of theirs that still have gifts): what was said
    // about it is that person's (their notes, written on their page, sit under whichever record led them), so all of it
    // goes to the record that leads them now, at once, never asked about
    crmNow ||= await loadCrm(DB, { now });
    const group = crmNow.keysOf(crmNow.canon(`c:${id}`)).filter((k) => k !== `c:${id}`);
    const groupIds = group.filter((k) => k.startsWith('c:')).map((k) => k.slice(2));
    const withGifts = groupIds.length ? new Set(((await DB.prepare(`SELECT DISTINCT contact FROM donor_payments WHERE contact IN (${groupIds.map(() => '?').join(', ')})`).bind(...groupIds).all()).results || []).map((r) => String(r.contact))) : new Set();
    const live = group.filter((k) => !k.startsWith('c:') || withGifts.has(k.slice(2)));
    if (live.length) {
      const lead = crmNow.leadOf(live);
      if (lead.startsWith('c:')) {
        const to = lead.slice(2);
        const mine = (await DB.prepare("SELECT target, answer, note, by, at FROM donor_calls WHERE kind = 'contact' AND subject = ?").bind(id).all()).results || [];
        const theirYes = await DB.prepare("SELECT 1 FROM donor_calls WHERE kind = 'contact' AND subject = ? AND answer = 1").bind(to).first();
        for (const c of mine) {
          if (c.answer && theirYes) continue;
          await DB.prepare(c.answer
            ? `INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind, subject, target) DO UPDATE SET answer = MAX(donor_calls.answer, excluded.answer)`
            : 'INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('contact', to, c.target, c.answer, c.note, c.by, c.at).run();
        }
        await DB.prepare("DELETE FROM donor_calls WHERE kind = 'contact' AND subject = ?").bind(id).run();
      }
      await moveCalls(DB, `c:${id}`, lead);
      await DB.prepare("INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES ('moved', ?, '', 1, ?, NULL, ?)").bind(id, lead.startsWith('c:') ? lead.slice(2) : null, iso(now)).run();
      crmNow = null;
      moved++;
      continue;
    }
    if (!unplaced.some((u) => u.contact === id)) unplaced.push({ contact: id, to: went.slice(0, 5), at: iso(now) });
  }
  // Known by email, then given a Zeffy contact: everything of theirs that the email held, "same person" too (the email
  // stops being anyone's once a contact has it). Never Keep anonymous: an email keeps everyone who has it
  for (const c of calls) if (c.kind === 'same' && c.answer) for (const v of [c.subject, c.target]) if (String(v).startsWith('e:')) byEmail.add(String(v));
  for (const k of byEmail) if (await followEmail(DB, k.slice(2))) moved++;
  if (moved || unplaced.length !== (st.unplaced || []).length || JSON.stringify(unplaced) !== JSON.stringify(st.unplaced || [])) {
    await writeCrmState(DB, { unplaced });
    if (moved) await markChanged(DB);
    if (moved) await audit(DB, 'Zeffy merge', `What was known about ${moved === 1 ? 'a donor' : `${moved} donors`} now goes with their gifts (Zeffy merged their contacts, or gave them one)`, { moved });
  }
  return { moved, unplaced: unplaced.length };
}

/**
 * A giver known by email who has a Zeffy contact now (one: an email on several is no one's to give it to): what was
 * said under the email goes to the contact, their owner (unless the contact has one), notes, "same person" and History.
 * Run after each whole read, and by the gift webhook when a gift brings a contact. → true when something moved
 */
export async function followEmail(DB, email) {
  const k = `e:${String(email || '').trim().toLowerCase()}`;
  if (k === 'e:') return false;
  await ensureCrm(DB);
  const said = await DB.prepare("SELECT 1 FROM donor_calls WHERE (kind = 'owner' AND subject = ?) OR (kind = 'same' AND (subject = ? OR target = ?)) LIMIT 1").bind(k, k, k).first()
    || await DB.prepare('SELECT 1 FROM donor_notes WHERE subject = ? LIMIT 1').bind(k).first()
    || await DB.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'donor-crm' AND entity_slug = ? LIMIT 1").bind(k).first().catch(() => null);
  if (!said) return false;
  const to = ((await DB.prepare('SELECT DISTINCT contact FROM donor_payments WHERE email = ? AND contact IS NOT NULL LIMIT 6').bind(k.slice(2)).all()).results || []).map((r) => String(r.contact));
  if (!to.length) return false;
  if (to.length > 1) {
    // On several contacts (a household sharing an address): the owner said under it looks after each that has none
    // (notes and History stay under the email, and show on each of their pages)
    const owner = await DB.prepare("SELECT note, by, at FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(k).first();
    if (!owner) return false;
    await DB.batch([
      ...to.map((c) => DB.prepare("INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) SELECT 'owner', ?, '', 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM donor_calls WHERE kind = 'owner' AND subject = ?)").bind(`c:${c}`, owner.note, owner.by, owner.at, `c:${c}`)),
      DB.prepare("DELETE FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(k),
    ]);
    return true;
  }
  const into = `c:${to[0]}`;
  const sames = ((await DB.prepare("SELECT subject, target, answer, note, by, at FROM donor_calls WHERE kind = 'same' AND (subject = ? OR target = ?)").bind(k, k).all()).results || []);
  await DB.batch([
    DB.prepare("UPDATE OR IGNORE donor_calls SET subject = ? WHERE kind = 'owner' AND subject = ?").bind(into, k),
    DB.prepare("DELETE FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(k),
    DB.prepare('UPDATE donor_notes SET subject = ? WHERE subject = ?').bind(into, k),
    ...sames.flatMap((c) => {
      const [x, y] = [c.subject === k ? into : c.subject, c.target === k ? into : c.target].sort();
      const del = DB.prepare("DELETE FROM donor_calls WHERE kind = 'same' AND subject = ? AND target = ?").bind(c.subject, c.target);
      // A "same" with itself is nothing; the contact's own answer about that pair stands
      return x === y ? [del] : [DB.prepare('INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('same', x, y, c.answer, c.note, c.by, c.at), del];
    }),
  ]);
  await moveHistory(DB, k, into);
  return true;
}

// ─── Views ──────────────────────────────────────────────────────────

const within = (atS, now, ms) => now - atS * 1000 <= ms;
const giving12 = (rows, now) => rows.filter((r) => r.method !== 'in_kind' && within(r.at, now, YEAR_MS)).reduce((t, r) => t + (Number(r.giving) || 0), 0);
const personName = (r) => givenName({ first_name: r.first, last_name: r.last }) || clean(r.company) || r.email || 'No name';
/** A person's name for "Same donor?": no middle initials, titles or suffixes, any case */
const sameName = (r) => { const w = words(givenName({ first_name: r.first, last_name: r.last })).filter((t) => t.length > 1); return w.length >= 2 ? w.join(' ') : ''; };

/**
 * What needs a person, newest kind first, each with what to press: a near name, a gift whose contact and company
 * differ, two donors that may be one, a partner whose giving says Champion, a big giver not on the website, a
 * contact Zeffy merged into several
 */
export function needsOf(rows, crm, { now = Date.now(), unplaced = [] } = {}) {
  const place = crm.placer(rows);
  const placed = rows.map((r) => ({ r, ...place(r) }));
  const items = [];
  const orgList = [...crm.org.values()].map((o) => ({ slug: o.key, name: o.name }));
  const yearAgo = (at) => !at || now - Date.parse(at) > YEAR_MS;

  // Company names no organization has yet
  const companies = new Map();
  for (const { r, person, kept } of placed) {
    if (!r.corporate || !clean(r.company) || r.method === 'daf' || crm.companyOrgOf(r)) continue;
    const k = nameKey(r.company);
    if (!k || crm.calls.yes.has(`company\n${k}`)) continue;
    const c = companies.get(k) || { key: k, name: clean(r.company), cents: 0, cents12: 0, anonymous: false, people: new Map(), at: 0 };
    c.cents += Number(r.giving) || 0;
    if (r.method !== 'in_kind' && within(r.at, now, YEAR_MS)) c.cents12 += Number(r.giving) || 0;
    if (r.anonymous || kept) c.anonymous = true;
    if (r.at > c.at) { c.at = r.at; c.name = clean(r.company); }
    c.people.set(person, personName(r));
    companies.set(k, c);
  }
  const asked = new Set();
  // Zeffy contacts asked something already: not asked another thing about them at the same time (one at a time)
  // (by the person, every record of theirs: a person joined from two contacts is one person asked one thing)
  const askedPeople = new Set();
  // The biggest first; a company typed by someone already asked about waits (and isn't asked about another way meanwhile)
  for (const c of [...companies.values()].sort((a, b) => b.cents - a.cents)) {
    if (!(c.cents > 0)) continue;
    const near = nearPartners(c.name, orgList, { min: 0.6, max: 3 }).find((m) => !crm.calls.no.has(`company\n${c.key}\n${m.partner.slug}`));
    if (!near) continue;
    asked.add(c.key);
    if ([...c.people.keys()].some((p) => askedPeople.has(crm.canon(p)))) continue;
    for (const person of c.people.keys()) askedPeople.add(crm.canon(person));
    items.push({ id: `near-company:${c.key}:${near.partner.slug}`, kind: 'near', link: 'company', subject: c.name, org: near.partner.slug, orgName: near.partner.name, why: near.why, cents: c.cents, people: [...c.people.values()].slice(0, 3) });
  }
  // A contact whose whole name is inside an organization's ("Chris Moreno" and Chris & Dana Moreno)
  const contacts = new Map();
  // The name a record really has (never its email standing in for one)
  const ownName = (r) => givenName({ first_name: r.first, last_name: r.last }) || clean(r.company);
  for (const { r, person, kept, owner } of placed) {
    if (!r.contact || crm.contactOrgOf(r)) continue;
    const c = contacts.get(r.contact) || { id: r.contact, person, name: personName(r), own: ownName(r), cents: 0, cents12: 0, anonymous: false, at: 0, forOrg: false };
    c.cents += Number(r.giving) || 0;
    if (r.method !== 'in_kind' && within(r.at, now, YEAR_MS)) c.cents12 += Number(r.giving) || 0;
    if (r.anonymous || kept) c.anonymous = true;
    // A gift of theirs counts for an organization already (its company is linked): keeping the contact as another
    // organization would take that gift from it
    if (crm.isOrg(owner)) c.forOrg = true;
    if (r.at > c.at) { c.at = r.at; c.name = personName(r); c.own = ownName(r); }
    contacts.set(r.contact, c);
  }
  const orgWords = [...crm.org.values()].map((o) => ({ o, w: new Set(words(o.name)) })).filter((x) => x.w.size >= 2);
  for (const c of contacts.values()) {
    if (!(c.cents > 0) || crm.calls.yes.has(`contact\n${c.id}`) || askedPeople.has(crm.canon(c.person))) continue;
    const w = [...new Set(words(c.name))];
    if (w.length < 2) continue;
    const hit = orgWords.find(({ o, w: ow }) => ow.size > w.length && w.every((t) => ow.has(t)) && !crm.calls.no.has(`contact\n${c.id}\n${o.key}`));
    if (hit) {
      askedPeople.add(crm.canon(c.person));
      items.push({ id: `near-contact:${c.id}:${hit.o.key}`, kind: 'near', link: 'contact', subject: c.id, name: c.name, ref: crm.canon(c.person).startsWith('c:') ? crm.canon(c.person).slice(2) : null, org: hit.o.key, orgName: hit.o.name, why: 'Their name is in it', cents: c.cents });
    }
  }
  // A gift whose contact is one organization and whose company is another
  for (const { r, cid, person } of placed) {
    const cl = crm.clashOf(r, cid);
    if (!cl || !(Number(r.giving) > 0)) continue;
    // One at a time for one giver: the next of theirs comes once this one is answered
    if (askedPeople.has(crm.canon(person))) continue;
    askedPeople.add(crm.canon(person));
    items.push({ id: `clash:${r.id}`, kind: 'clash', payment: r.id, name: personName(r), company: clean(r.company), cents: Number(r.giving) || 0, at: r.at, counted: cl.contact, countedName: crm.org.get(cl.contact).name, other: cl.company, otherName: crm.org.get(cl.company).name });
  }
  // Two donors that may be one person: the same name (no middle initial), or one email on two Zeffy contacts
  const people = new Map();
  for (const { r, person, owner } of placed) {
    if (owner !== person) continue;
    const p = people.get(person) || { key: person, name: personName(r), emails: new Set(), same: '', cents: 0, gifts: 0, at: 0, rows: [] };
    p.cents += Number(r.giving) || 0;
    p.rows.push(r);
    p.gifts = giftCount(p.rows);
    if (r.email) p.emails.add(r.email);
    if (r.at > p.at) { p.at = r.at; p.name = personName(r); p.same = sameName(r) || p.same; } else if (!p.same) p.same = sameName(r);
    people.set(person, p);
  }
  const pairs = new Map();
  // Several records with one name or email: one question at a time (the next comes once that one is answered), so
  // three of one name are never three questions about the same people at once
  const asked3 = new Set();
  const group = (k, list, why) => {
    const l = list.filter((p) => p.cents > 0).slice(0, 4);
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const [a, b] = [l[i].key, l[j].key].sort();
      if (crm.calls.notSame.has(`${a}\n${b}`) || pairs.has(`${a}\n${b}`)) continue;
      if (asked3.has(a) || asked3.has(b) || [a, b].some((x) => askedPeople.has(crm.canon(x)))) continue;
      pairs.set(`${a}\n${b}`, { a, b, why });
      asked3.add(a);
      asked3.add(b);
      for (const x of [a, b]) askedPeople.add(crm.canon(x));
    }
  };
  const byName = new Map();
  const byEmail = new Map();
  for (const p of people.values()) {
    if (p.same) byName.set(p.same, [...(byName.get(p.same) || []), p]);
    for (const e of p.emails) byEmail.set(e, [...(byEmail.get(e) || []), p]);
  }
  for (const [e, l] of byEmail) if (l.length > 1) group(e, l, 'The same email');
  for (const [n, l] of byName) if (l.length > 1) group(n, l, 'The same name');
  for (const { a, b, why } of pairs.values()) {
    const [pa, pb] = [people.get(a), people.get(b)];
    const side = (p) => ({ key: p.key, ref: p.key.startsWith('c:') ? p.key.slice(2) : null, name: p.name, email: [...p.emails][0] || null, cents: p.cents, gifts: p.gifts, latest: p.at });
    items.push({ id: `same:${a}:${b}`, kind: 'same', why, a: side(pa), b: side(pb) });
  }
  // A Funding partner below Champion whose giving in the last 12 months is Champion's
  const orgRows = new Map();
  for (const { r, owner, payerKept, cid } of placed) {
    if (!crm.isOrg(owner)) continue;
    // A gift given anonymously, or by someone kept anonymous, doesn't count toward a level on the website; nor one
    // still asked about (it may be another organization's)
    if (r.anonymous || payerKept || crm.clashOf(r, cid)) continue;
    orgRows.set(owner, [...(orgRows.get(owner) || []), r]);
  }
  for (const [k, list] of orgRows) {
    const o = crm.org.get(k);
    if (!o.onSite || !o.funding || !['builder', 'friend'].includes(o.level)) continue;
    const cents12 = giving12(list, now);
    if (cents12 < CHAMPION_CENTS || crm.keepAnonymous(k)) continue;
    const said = crm.calls.level.get(k);
    if (said && (said.answer || !yearAgo(said.at))) continue;
    items.push({ id: `level:${k}`, kind: 'level', org: k, slug: o.slug, name: o.name, level: o.level, levelLabel: o.levelLabel, cents12 });
  }
  // Givers with no organization here: a company name or a contact that gave Champion's amount in the last 12 months
  // (big), and a contact whose name reads as an organization's, whatever it gave (named: a foundation giving under its
  // own Zeffy record would otherwise show as a person). One a person said is the same as another isn't asked about
  const bigOnes = [
    ...[...companies.values()].filter((c) => !asked.has(c.key)).map((c) => ({ subject: `company:${c.key}`, link: 'company', linkSubject: c.name, name: c.name, cents: c.cents, cents12: c.cents12, anonymous: c.anonymous, people: [...c.people.values()].slice(0, 3), askKeys: [...c.people.keys()].map((p) => crm.canon(p)) })),
    // A contact: by its own name (never its email), not joined to anyone, none of its gifts an organization's already,
    // not asked about an organization of that name, and not said to be a person (that answer is the contact's alone)
    ...[...contacts.values()].filter((c) => ORG_WORDS.test(c.own || '') && c.cents > 0 && crm.keysOf(c.person).length === 1 && !c.forOrg
      && !crm.calls.big.get(`contact:${c.id}`)?.person)
      .map((c) => ({ subject: `contact:${c.id}`, link: 'contact', linkSubject: c.id, name: c.name, ref: c.person.startsWith('c:') ? c.person.slice(2) : null, cents: c.cents, cents12: c.cents12, anonymous: c.anonymous, named: true, people: [], askKeys: [crm.canon(c.person)] })),
  ];
  // One name asked about once: a company typed on gifts and a Zeffy contact of the same name are one giver (the
  // company's name is linked; the contact's then matches by itself)
  const bigByName = new Map();
  for (const b of bigOnes) {
    if (b.anonymous || (b.cents12 < CHAMPION_CENTS && !b.named)) continue;
    const nk = nameKey(b.name) || b.subject;
    const had = bigByName.get(nk);
    if (had) { had.also.push(b.subject); had.cents12 = Math.max(had.cents12, b.cents12); had.cents = Math.max(had.cents, b.cents); had.named ||= b.named; had.ref ||= b.ref; had.askKeys.push(...b.askKeys); continue; }
    bigByName.set(nk, { ...b, also: [] });
  }
  for (const b of bigByName.values()) {
    const said = [b.subject, ...b.also].map((s) => crm.calls.big.get(s)).filter(Boolean);
    // "It’s a person" is for good; Not now on a big giver holds a year; a name answered once isn't asked about again
    // until it gives Champion's amount
    if (said.some((c) => c.person)) continue;
    const big = b.cents12 >= CHAMPION_CENTS;
    if (big ? said.some((c) => !yearAgo(c.at)) : said.length) continue;
    // One question about a person at a time: a giver of this name asked about already (near, same, …) waits for it
    if (b.askKeys.some((p) => askedPeople.has(p))) continue;
    for (const p of b.askKeys) askedPeople.add(p);
    items.push({ id: `big:${b.subject}`, kind: big ? 'big' : 'named', subject: b.subject, also: b.also, link: b.link, linkSubject: b.linkSubject, name: b.name, ref: b.ref || null, cents12: b.cents12, cents: b.cents, person: b.link === 'contact', people: b.people });
  }
  for (const u of unplaced) if (!crm.calls.movedDone.has(u.contact)) items.push({ id: `moved:${u.contact}`, kind: 'moved', contact: u.contact, to: u.to, at: u.at });
  const order = { level: 0, big: 1, near: 2, clash: 3, same: 4, named: 5, moved: 6 };
  // Most first: a level or a big giver by the last 12 months, a name that reads as an organization's by all it gave
  const amount = (x) => (x.kind === 'named' ? x.cents : x.cents12 || x.cents || 0) || 0;
  return items.sort((x, y) => order[x.kind] - order[y.kind] || amount(y) - amount(x));
}

/** Each gift waiting for a thank-you, with whose it is now (an organization or a person) and who looks after them */
function thanksWhose(items, rows, crm) {
  if (!items.length) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const place = crm.placer(rows);
  return items.map((t) => {
    const ids = String(t.ids).split(' ').filter(Boolean);
    const r = ids.map((id) => byId.get(id)).find(Boolean);
    const owner = r ? place(r).owner : null;
    return { t, ids, owner, lookedAfter: owner ? crm.lookedAfterBy(owner) : null };
  });
}

/**
 * Admin → Donors & Partners: everyone who gives, people and organizations, how many things need a person, the gifts
 * waiting for a thank-you (how many, and who looks after each: the To thank pill follows the Owner filter), and the team
 */
export async function listView(env, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  const [rows, st, todo, staff] = await Promise.all([allRows(env.DB), readCrmState(env.DB), thanksToDo(env.DB), staffList(env.DB)]);
  const v = await donorsView(env, { now, crm, rows });
  const thanksOwners = thanksWhose(todo, rows, crm).map((x) => x.lookedAfter || '');
  return { ...v, needs: needsOf(rows, crm, { now, unplaced: st.unplaced || [] }).length, thanks: todo.length, thanksOwners, staff: withOwners(staff, v.people.map((p) => p.owner)) };
}
/** The team, and anyone still named an owner who has left it (shown, so their donors can be given to someone else) */
const withOwners = (staff, owners) => {
  const have = new Set(staff.map((s) => s.email));
  const local = (e) => { const n = e.split('@')[0]; return `${n[0]?.toUpperCase() || ''}${n.slice(1)}`; };
  const gone = [...new Set(owners.filter((o) => o && !have.has(o)))].map((email) => ({ email, name: staff.names?.get(email) || local(email), left: true }));
  return [...staff, ...gone];
};

// ─── Notes, history and thank-yous on a donor's page ────────────────

/** A donor's notes (every record of a person), newest first */
// (keys read 80 at a time: an organization's are its own and every contact counted for it, past D1's 100 a statement)
const inChunks = async (keys, read) => { const out = []; for (let i = 0; i < keys.length; i += 80) out.push(...await read(keys.slice(i, i + 80))); return out; };
async function notesOf(DB, keys) {
  if (!keys.length) return [];
  const r = await inChunks([...new Set(keys)], async (ks) => (await DB.prepare(`SELECT id, subject, body, by, at, edited_by, edited_at FROM donor_notes WHERE subject IN (${ks.map(() => '?').join(', ')})`).bind(...ks).all()).results || []);
  return r.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((n) => ({ id: n.id, subject: n.subject, body: n.body, by: n.by || null, at: n.at, editedBy: n.edited_by || null, editedAt: n.edited_at || null }));
}
/** What the team did about a donor, newest first (their History) */
async function historyOf(DB, keys) {
  if (!keys.length) return [];
  try {
    const r = (await inChunks([...new Set(keys)], async (ks) => (await DB.prepare(`SELECT id, user_email, entity_name, created_at FROM audit_log WHERE entity_type = 'donor-crm' AND entity_slug IN (${ks.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 25`).bind(...ks).all()).results || []))
      .sort((a, b) => b.id - a.id).slice(0, 25);
    return r.map((h) => ({ by: h.user_email && h.user_email !== 'unknown' ? h.user_email : null, at: `${String(h.created_at).replace(' ', 'T')}Z`, what: h.entity_name || '' }));
  } catch (e) { if (missingTable(e)) return []; throw e; }
}
/** Each gift with its thank-you: { state: todo | thanked | skipped | gone, why, by, at } */
async function withThanks(DB, gifts) {
  const t = await thanksFor(DB, gifts.flatMap((g) => g.ids || [g.id]));
  // Every thank-you of the gift (part thanked, a later part To thank): `thanks` the one still to do, else the first
  return gifts.map((g) => {
    if (g.refunded) return g;
    const all = [...new Map((g.ids || [g.id]).map((id) => t.get(id)).filter(Boolean).map((x) => [x.id, { ...x, whyText: THANK_WHY[x.why] || null }])).values()];
    if (!all.length) return g;
    return { ...g, thanks: all.find((y) => y.state === 'todo') || all[0], thanksAll: all };
  });
}
/** The extras a donor's page carries: owner, notes, History, and each gift's thank-you */
async function pageExtras(env, crm, key, v, { emails = [] } = {}) {
  // A person known by email before Zeffy had a contact for them: the notes and History from then are theirs at once
  // (the next read files them, and any owner, under the contact for good: followMerges)
  const was = emails.map((e) => `e:${e}`).filter((k) => !crm.keysOf(key).includes(k));
  // An organization's page carries the notes and History of the Zeffy contacts counted for it too (said about them
  // before they were linked: they stay theirs, and come back to their page if the link is taken off)
  const keys = isOrgKey(key) ? [key, ...crm.linkedTo(key)] : [...crm.keysOf(key), ...was];
  const [notes, history, gifts, staff] = await Promise.all([notesOf(env.DB, keys), historyOf(env.DB, keys), withThanks(env.DB, v.gifts), staffList(env.DB)]);
  // The owner is the one the list shows (an owner said under the old email moves to the contact on the next read)
  const owner = crm.lookedAfterBy(key);
  // (an organization's own owner, said on it: not one shown from a contact counted for it)
  const ownOwner = crm.ownerRows([key]).find(([, ans, note]) => ans && note)?.[2] || null;
  return { owner, ownOwner, notes, history, gifts, staff: withOwners(staff, [owner]) };
}

/** Every gift waiting for a thank-you, the one waiting longest first, with whose it is and who looks after them */
export async function thanksView(env, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  const [items, rows, staff] = await Promise.all([thanksToDo(env.DB), allRows(env.DB), staffList(env.DB)]);
  // Every one (the Owner filter is the page's, so it must have them all), each placed as the list places its gifts
  const out = thanksWhose(items, rows, crm).map(({ t, ids, owner, lookedAfter }) => {
    const org = owner && isOrgKey(owner) ? crm.orgFacts(owner) : null;
    return {
      id: t.id, ids, at: t.at, cents: t.cents, inKind: t.in_kind, name: t.name || 'No name', company: t.company || null,
      campaign: t.campaign || '', how: t.how || '', why: t.why, whyText: THANK_WHY[t.why] || '', since: t.created_at,
      org: org && !org.gone ? { key: owner, name: org.name } : null,
      ref: owner && !isOrgKey(owner) ? refOfKey(owner, ids[0]) : null,
      owner: lookedAfter,
    };
  });
  return { items: out, more: 0, staff: withOwners(staff, out.map((x) => x.owner)) };
}

/** Every organization (partners and the ones kept here), for linking a name to one */
export async function orgsList(env, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  return { orgs: [...crm.org.values()].map((o) => ({ key: o.key, name: o.name, onSite: o.onSite, levelLabel: o.levelLabel || null })).sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Needs you, in full */
export async function needsView(env, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  const [rows, st] = await Promise.all([allRows(env.DB), readCrmState(env.DB)]);
  const items = needsOf(rows, crm, { now, unplaced: st.unplaced || [] });
  // A contact Zeffy split: the team's notes and owner left on the old record (no gifts now), and who each new one is
  for (const it of items) {
    if (it.kind !== 'moved') continue;
    const old = `c:${it.contact}`;
    it.notes = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM donor_notes WHERE subject = ?').bind(old).first())?.n) || 0;
    it.owner = crm.ownerRows([old]).find(([, ans, note]) => ans && note)?.[2] || null;
    it.names = it.to.map((c) => { const r = rows.find((x) => x.contact === c); return r ? personName(r) : null; });
    // (told apart: two of one name, as a duplicate split is) and whether it was kept anonymous
    // (and each one's own owner: the old record's goes only to one with none)
    it.who = it.to.map((c) => { const rs = rows.filter((x) => x.contact === c); return { email: rs.find((x) => x.email)?.email || null, gifts: rs.filter((x) => Number(x.giving) > 0).length, owner: crm.lookedAfterBy(crm.canon(`c:${c}`)) || null }; });
    it.anon = crm.keptKey(old);
  }
  // (the team, to name an owner left behind)
  return { items, staff: items.some((i) => i.kind === 'moved' && i.owner) ? await staffList(env.DB) : [] };
}

/** A person's page: their gifts, what they gave for organizations, the company names they gave for that aren't linked */
/** A Zeffy contact's address whose gifts all went to one other contact (Zeffy merged them): that contact's, else null */
export async function movedTo(env, ref) {
  const c = String(ref || '').replace(/^c:/, '');
  if (!c || c.startsWith('g:')) return null;
  if (await env.DB.prepare('SELECT 1 AS y FROM donor_payments WHERE contact = ? LIMIT 1').bind(c).first()) return null;
  // (split between several: where what was said about it went, once that's settled: the person it was part of, or the
  // contact picked in Needs you)
  const settled = await env.DB.prepare("SELECT note FROM donor_calls WHERE kind = 'moved' AND subject = ?").bind(c).first();
  if (settled) return settled.note ? String(settled.note) : null;
  const went = ((await env.DB.prepare('SELECT DISTINCT contact FROM donor_payments WHERE was_contact = ? AND contact IS NOT NULL LIMIT 2').bind(c).all()).results || []).map((r) => String(r.contact));
  return went.length === 1 ? went[0] : null;
}

/** Where a note is now: the page that shows it (a person's address, or an organization's key) and whose it is; null
 * when it's been deleted */
export async function noteWhere(env, id, { now = Date.now() } = {}) {
  await ensureCrm(env.DB);
  const n = await env.DB.prepare('SELECT subject FROM donor_notes WHERE id = ?').bind(String(id || '')).first();
  if (!n) return null;
  const crm = await loadCrm(env.DB, { now });
  const subject = String(n.subject);
  if (isOrgKey(subject)) return { subject, org: subject, name: crm.org.get(subject)?.name || null };
  const key = crm.canon(subject);
  // (a Zeffy contact that's an organization's own record, and no one else's: its page is the organization's)
  if (key.startsWith('c:') && crm.keysOf(key).length === 1) { const org = crm.contactIsOrg(key.slice(2)); if (org) return { subject, org, name: crm.org.get(org)?.name || null }; }
  const rows = (await rowsFor(env.DB, crm.keysOf(key))).sort((a, b) => (b.at || 0) - (a.at || 0));
  return { subject, donor: refOfKey(key, rows[0]?.id || ''), name: rows[0] ? personName(rows[0]) : null };
}

export async function personView(env, ref, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  const raw = await keyOfRef(env, ref);
  if (!raw) return null;
  const key = crm.canon(raw);
  if (isOrgKey(key)) return { org: key };
  const v = await donorView(env, key, { now, crm });
  if (!v) return null;
  const rows = await rowsFor(env.DB, crm.keysOf(key));
  const place = crm.placer(rows);
  // A Zeffy contact that is an organization (linked to it, or named exactly as one), and no one else's record: its page
  // is the organization's (a person who only gave for one, their company linked, keeps a page of their own)
  if (key.startsWith('c:') && crm.keysOf(key).length === 1) {
    const org = crm.contactIsOrg(key.slice(2));
    if (org) return { org };
  }
  const mine = rows.filter((r) => place(r).person === key);
  const loose = new Map();
  for (const r of mine) {
    if (!r.corporate || !clean(r.company) || r.method === 'daf' || crm.companyOrgOf(r)) continue;
    const k = nameKey(r.company);
    if (!k) continue;
    const c = loose.get(k) || { name: clean(r.company), cents: 0, near: null };
    c.cents += Number(r.giving) || 0;
    loose.set(k, c);
  }
  const orgList = [...crm.org.values()].map((o) => ({ slug: o.key, name: o.name }));
  for (const [k, c] of loose) c.near = nearPartners(c.name, orgList, { min: 0.6, max: 1 }).filter((m) => !crm.calls.no.has(`company\n${k}\n${m.partner.slug}`)).map((m) => ({ key: m.partner.slug, name: m.partner.name }))[0] || null;
  // The other records a person said are them (each with its address)
  // (every one but the record shown as theirs, the one Open in Zeffy opens: their own gifts' contact, else the lead)
  const shownAs = v.donor?.contact && crm.keysOf(key).includes(`c:${v.donor.contact}`) ? `c:${v.donor.contact}` : key;
  const also = crm.keysOf(key).filter((k) => k !== shownAs).map((k) => ({ key: k, ref: k.startsWith('c:') ? k.slice(2) : null }));
  // Kept anonymous, as the board has it: with everyone (someone kept may share their email or name)
  const allPlaced = crm.anyKeptAnonymous ? await allRows(env.DB) : rows;
  const pa = allPlaced === rows ? place : crm.placer(allPlaced);
  const why = pa.why(key);
  const otherName = why?.other ? (() => { const r = allPlaced.find((x) => pa(x).person === why.other); return r ? personName(r) : 'someone else'; })() : null;
  const emails = [...new Set(mine.map((r) => r.email).filter(Boolean))];
  // Records that were theirs before (Zeffy merged one into one of theirs, or split one of theirs and it came to them):
  // a note being written on one of those pages comes to this one
  const ids = crm.keysOf(key).filter((k) => k.startsWith('c:')).map((k) => k.slice(2));
  // (a record whose gifts all came to them, merged by Zeffy; or one split between several whose things were settled on
  // them: never a split's other contacts, nor one not settled yet)
  const was = [...new Set(mine.map((r) => r.was_contact).filter((c) => c && !ids.includes(String(c))).map(String))];
  // (a record with gifts of its own still is a donor of its own: never theirs)
  const whole = was.length ? ((await env.DB.prepare(`SELECT was_contact AS was, COUNT(DISTINCT contact) AS n FROM donor_payments p WHERE was_contact IN (${was.map(() => '?').join(', ')}) AND NOT EXISTS (SELECT 1 FROM donor_payments o WHERE o.contact = p.was_contact) GROUP BY was_contact`).bind(...was).all()).results || []).filter((r) => Number(r.n) === 1).map((r) => String(r.was)) : [];
  const settledHere = ids.length ? ((await env.DB.prepare(`SELECT subject FROM donor_calls WHERE kind = 'moved' AND note IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all()).results || []).map((r) => String(r.subject)) : [];
  const split = new Set(was.length ? ((await env.DB.prepare(`SELECT subject FROM donor_calls WHERE kind = 'moved' AND subject IN (${was.map(() => '?').join(', ')})`).bind(...was).all()).results || []).map((r) => String(r.subject)) : []);
  const formerly = [...new Set([...whole.filter((c) => !split.has(c)), ...settledHere].map((c) => `c:${c}`))];
  const links = Object.fromEntries(ids.map((c) => [c, crm.calls.yes.get(`contact\n${c}`) || null]));
  return { ...v, ...(await pageExtras(env, crm, key, v, { emails })), key, ref: refOfKey(key, mine[0]?.id || ''), keepAnonymous: pa.kept(key), keptWhy: why ? { ...why, otherName } : null, companies: [...loose.values()], also, shownAs, formerly, links };
}

/** An organization's page: its gifts (and who paid each), the Zeffy names it gives under, the people who gave for it */
export async function orgView(env, key, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  if (!crm.isOrg(key)) {
    const to = crm.calls.forward.get(key);
    if (to && crm.isOrg(to)) return { moved: to };
    // (taken out: said so, with the record what was said about it went back to)
    const out = crm.calls.takenOut.get(key);
    return out ? { takenOut: true, name: out.name, back: out.to ? crm.canon(out.to) : null, backRef: out.to?.startsWith('c:') ? out.to.slice(2) : null } : null;
  }
  const [rows, kids, st] = await Promise.all([allRows(env.DB), kidNames(env.DB), readCrmState(env.DB)]);
  const place = crm.placer(rows);
  const mine = rows.filter((r) => place(r).owner === key);
  const d = donorOf(key, mine, { now, kids });
  const facts = crm.orgFacts(key);
  // Made from a Zeffy contact (kept as an organization): Take it out gives back to it, and says so
  const made = await env.DB.prepare("SELECT target FROM donor_calls WHERE kind = 'made-from' AND subject = ? AND answer = 1").bind(key).first().catch(() => null);
  const madeRow = made?.target ? rows.find((r) => `c:${r.contact}` === made.target) : null;
  // (`key`: the page it goes back to, as its notes are kept: a note being written there goes with it)
  const madeFrom = made?.target ? { ref: String(made.target).slice(2), key: crm.canon(String(made.target)), name: madeRow ? personName(madeRow) : 'the Zeffy record' } : null;
  d.name = facts.name;
  const v = await giftsView(env, d, mine, kids, { by: true });
  // The names it gives under, and why each counts
  const contacts = new Map();
  const companies = new Map();
  const people = new Map();
  const byGiver = new Map();
  for (const r of mine) {
    const p = place(r).person;
    const pe = people.get(p) || { key: p, ref: p.startsWith('c:') ? p.slice(2) : `g:${r.id}`, name: personName(r), cents: 0, gifts: 0 };
    pe.cents += Number(r.giving) || 0;
    (byGiver.get(p) || byGiver.set(p, []).get(p)).push(r);
    people.set(p, pe);
    // Each name it counts under, however many: a gift given by a linked contact for a linked company shows both
    const viaContact = !!r.contact && crm.contactOrgOf(r) === key;
    const viaCompany = crm.companyOrgOf(r) === key;
    if (viaContact) {
      const how = crm.calls.yes.get(`contact\n${r.contact}`) === key ? 'linked' : 'same name';
      contacts.set(r.contact, { kind: 'contact', subject: r.contact, name: personName(r), how });
    }
    if (viaCompany) {
      const k = nameKey(r.company);
      const how = crm.calls.yes.get(`company\n${k}`) === key ? 'linked' : 'same name';
      companies.set(k, { kind: 'company', subject: clean(r.company), name: clean(r.company), how });
    }
    if (!viaContact && !viaCompany && crm.calls.pay.get(String(r.id)) === key) contacts.set(`pay:${r.id}`, { kind: 'payment', subject: r.id, name: `One gift from ${personName(r)}`, how: 'this gift' });
  }
  for (const pe of people.values()) pe.gifts = giftCount(byGiver.get(pe.key) || []);
  // Who gave for it, by their own name (a person who typed the organization's name on its gift is named as themselves:
  // their newest gift of their own, else the name on the gift)
  const ownRow = new Map();
  for (const r of rows) {
    const pl = place(r);
    if (!people.has(pl.person) || crm.isOrg(pl.owner) || !givenName({ first_name: r.first, last_name: r.last })) continue;
    if (!ownRow.has(pl.person) || r.at > ownRow.get(pl.person).at) ownRow.set(pl.person, r);
  }
  for (const pe of people.values()) if (ownRow.has(pe.key)) pe.name = personName(ownRow.get(pe.key));
  // Its own Zeffy record (every name of it this one's): no page apart from this one, so no link back to it
  for (const pe of people.values()) if (pe.key.startsWith('c:') && crm.keysOf(pe.key).length === 1 && crm.contactIsOrg(pe.key.slice(2)) === key) pe.self = true;
  // Links made with no gifts yet (a contact or a name a person linked before it gave)
  for (const [k, t] of crm.calls.yes) {
    if (t !== key) continue;
    const [kind, subject] = k.split('\n');
    if (kind === 'contact' && !contacts.has(subject)) contacts.set(subject, { kind, subject, name: 'A Zeffy contact (no gifts yet)', how: 'linked' });
    if (kind === 'company' && !companies.has(subject)) {
      // As it was typed: on a gift (one given for it that counts here another way), else as it was linked
      const typed = clean(rows.find((r) => r.company && nameKey(r.company) === subject)?.company) || crm.companyName(subject) || subject;
      companies.set(subject, { kind, subject: typed, name: typed, how: 'linked', noGifts: !rows.some((r) => r.company && nameKey(r.company) === subject && Number(r.giving) > 0) });
    }
  }
  // A person joined from several Zeffy contacts is one name here (Take off takes them all, as Count it linked them all)
  const byPerson = new Map();
  for (const [k, c] of contacts) {
    if (c.kind !== 'contact') continue;
    const p = crm.canon(`c:${c.subject}`);
    const had = byPerson.get(p);
    if (!had) { c.subjects = [c.subject]; byPerson.set(p, c); continue; }
    had.subjects.push(c.subject);
    if (c.how === 'linked') had.how = 'linked';
    contacts.delete(k);
  }
  const needs = needsOf(rows, crm, { now, unplaced: st.unplaced || [] }).filter((n) => n.org === key || n.counted === key || n.other === key);
  return {
    ...v, ...(await pageExtras(env, crm, key, v)), key, ...facts, madeFrom,
    keptNames: facts.keepAnonymous ? crm.keptNamesFor(key) : [],
    // Given anonymously, or by someone kept anonymous: Put on the website asks first
    anonymousGifts: mine.some((r) => r.anonymous || place(r).kept),
    names: [...[...contacts.values()].map((c) => ({ ...c, alone: crm.keysOf(crm.canon(`c:${c.subject}`)).length === 1 })), ...companies.values()],
    people: [...people.values()].filter((p) => p.gifts).sort((a, b) => b.cents - a.cents),
    cents12: giving12(mine, now),
    needs,
  };
}

/** A partner's giving in short, for its partner card (Partners): totals, the latest gift, and whether it says Champion */
export async function orgSummary(env, key, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  if (!crm.isOrg(key)) return { gifts: 0, total: 0, cents12: 0, latest: null, suggest: false };
  const rows = await allRows(env.DB);
  const place = crm.placer(rows);
  const mine = rows.filter((r) => place(r).owner === key);
  const d = donorOf(key, mine, { now });
  const o = crm.org.get(key);
  const cents12 = giving12(mine, now);
  // As Needs you has it: what wasn't given anonymously counts toward Champion
  const counted12 = giving12(mine.filter((r) => { const x = place(r); return !r.anonymous && !x.payerKept && !crm.clashOf(r, x.cid); }), now);
  const said = crm.calls.level.get(key);
  const suggest = !!(o.onSite && o.funding && ['builder', 'friend'].includes(o.level) && counted12 >= CHAMPION_CENTS && !crm.keepAnonymous(key)
    && !(said && (said.answer || now - Date.parse(said.at) <= YEAR_MS)));
  return { gifts: d.gifts, total: d.total, thisYear: d.thisYear, cents12, latest: d.latest, stage: d.stage, suggest };
}

/** Zeffy names to link to an organization: company names and contacts, by what was typed */
export async function findNames(env, q, { now = Date.now() } = {}) {
  const t = clean(q).toLowerCase();
  if (t.length < 2) return { names: [] };
  const crm = await loadCrm(env.DB, { now });
  const rows = await allRows(env.DB);
  const out = new Map();
  for (const r of rows) {
    if (r.corporate && clean(r.company) && r.method !== 'daf' && clean(r.company).toLowerCase().includes(t)) {
      const k = `company:${nameKey(r.company)}`;
      const o = out.get(k) || { kind: 'company', subject: clean(r.company), name: clean(r.company), cents: 0, org: crm.companyOrgOf(r) };
      o.cents += Number(r.giving) || 0;
      out.set(k, o);
    }
    const n = personName(r);
    if (r.contact && (n.toLowerCase().includes(t) || String(r.email || '').includes(t))) {
      const k = `contact:${r.contact}`;
      const o = out.get(k) || { kind: 'contact', subject: r.contact, name: n, email: r.email || null, cents: 0, org: crm.contactOrgOf(r) };
      o.cents += Number(r.giving) || 0;
      out.set(k, o);
    }
  }
  return { names: [...out.values()].map((o) => ({ ...o, orgName: o.org ? crm.org.get(o.org)?.name || null : null })).sort((a, b) => b.cents - a.cents).slice(0, 12) };
}

/** People to join with a person ("Same person as…"): by name or email typed (posted, never in an address) */
export async function findPeople(env, q, { now = Date.now(), except = null } = {}) {
  const t = clean(q).toLowerCase();
  if (t.length < 2) return { people: [] };
  const crm = await loadCrm(env.DB, { now });
  const rows = await allRows(env.DB);
  const place = crm.placer(rows);
  const by = new Map();
  for (const r of rows) {
    const { person, owner } = place(r);
    // A gift with no contact, email or name can't be joined to anyone
    if (owner !== person || !/^[cen]:/.test(person)) continue;
    const p = by.get(person) || { key: person, name: personName(r), email: r.email || null, cents: 0, gifts: 0, hit: false, at: 0, rows: [] };
    p.cents += Number(r.giving) || 0;
    p.rows.push(r);
    p.gifts = giftCount(p.rows);
    if (r.at > p.at) { p.at = r.at; p.name = personName(r); p.email = r.email || p.email; }
    if (personName(r).toLowerCase().includes(t) || String(r.email || '').includes(t)) p.hit = true;
    by.set(person, p);
  }
  const ex = except ? crm.canon(except) : null;
  return { people: [...by.values()].filter((p) => p.hit && p.key !== ex).sort((a, b) => b.cents - a.cents).slice(0, 12).map(({ hit, rows, ...p }) => p) };
}

/** Which donor a gift is (the MAJOR GIFT Slack link): a person's address, or an organization's */
export async function giftOwner(env, id, { now = Date.now(), fetchImpl = fetch } = {}) {
  const crm = await loadCrm(env.DB, { now });
  let owner = await donorOfPayment(env, id, { crm });
  // Not in the list yet (a Slack post can be read before the next read of Zeffy): read it from Zeffy now
  if (!owner && String(env.ZEFFY_API_KEY || '').trim() && /^[\w-]{6,80}$/.test(String(id))) {
    try {
      const p = await zeffyGet(env, `/payments/${encodeURIComponent(id)}`, {}, fetchImpl);
      if (p && String(p.id) === String(id) && await noteDonorPayment(env, p, { now })) owner = await donorOfPayment(env, id, { crm });
    } catch (e) { if (e.status !== 404) console.error('[donors] gift', e.message); }
  }
  if (!owner) return null;
  return isOrgKey(owner) ? { org: owner } : { ref: refOfKey(owner, id) };
}

/**
 * For the board's gift list: the gifts whose giver staff keep anonymous → Set of gift ids. Every charge of a gift is
 * checked, placed with the whole donor list as everywhere else (the person, any record of theirs, any organization it
 * names, any name a kept organization has had), both as the list has it and as the board's own read of Zeffy has it.
 * A charge the list hasn't got yet is placed by its contact; with none, nothing says who it is, so it's hidden while
 * anyone at all is kept anonymous. Gifts as the board keeps them: { id, contact, name, company, method, charges }
 */
export async function boardHidden(DB, gifts, { now = Date.now() } = {}) {
  const crm = await loadCrm(DB, { now });
  const hidden = new Set();
  hidden.names = [];
  if (!crm.anyKeptAnonymous || !gifts.length) return hidden;
  try { await rememberKeptNames(DB, crm, { now }); } catch (e) { console.error('[donors] kept names', e.message); }
  hidden.names = crm.keptDisplayNames();
  // The whole list, placed as everywhere else: every record of every person, nothing picked by hand
  const rows = await allRows(DB);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const place = crm.placer(rows);
  const keptCharge = (c) => {
    const board = { id: String(c.id), contact: c.contact ? String(c.contact) : null, first: c.name || '', last: '', corporate: c.company ? 1 : 0, company: c.company || null, method: c.method || null, email: null };
    const r = byId.get(String(c.id));
    if (r) {
      if (place(r).kept) return true;
      // As the board's own read has it (Zeffy may have changed the contact, name or company since the list read it)
      return place({ ...r, contact: board.contact || r.contact, first: board.first || r.first, last: board.first ? '' : r.last, corporate: board.company ? 1 : r.corporate, company: board.company || r.company }).kept
        || place(board).kept;
    }
    // Not in the list yet: who it is isn't known for sure (a kept person's new Zeffy record looks like anyone's), so
    // hidden while anyone is kept anonymous; the list has it within 15 minutes
    return true;
  };
  for (const g of gifts) {
    const charges = Array.isArray(g.charges) && g.charges.length ? g.charges : null;
    // Saved before every charge was kept with the gift: a gift of several charges can't be checked whole
    if (!charges && (g.parts || 1) > 1) { hidden.add(g.id); continue; }
    if ((charges || [{ id: g.id, contact: g.contact, company: g.company, name: g.name, method: g.method }]).some(keptCharge)) hidden.add(g.id);
  }
  return hidden;
}
