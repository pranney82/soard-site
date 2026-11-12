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
import { allRows, rowsFor, donorsView, donorView, giftsView, donorOf, ensureDonors, readDonorState, isOrgKey, personKeys, keyOfRef, refOfKey, donorOfPayment, noteDonorPayment, READ_COLS } from './_donors.js';
import { kidNames } from './_board-gifts.js';
import { givenName, zeffyGet } from './_zeffy.js';
import { nameKey, nearPartners, categoriesOf, levelOf } from '../../public/admin/partners-shared.js';
import { logAudit } from './_audit.js';
import { staffDirectory } from './_staff-access.js';
import { isStaffEmail } from './_board-roles.js';
import { thanksToDo, thanksCount, thanksFor, markThanks, WHY as THANK_WHY } from './_donor-thanks.js';

const DAY = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY;
// Champion on the Partners page: "Major sponsors: $10K or more" (partners-shared.js LEVELS), over the last 12 months
export const CHAMPION_CENTS = 1000000;
// A contact's name that reads as an organization's (a foundation that gives under its own name)
const ORG_WORDS = /\b(foundation|fund|trust|inc|llc|corp|corporation|company|church|association|bank|holdings|enterprises|ministries|society|institute|council|charitable)\b/i;
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
  'CREATE TABLE IF NOT EXISTS donor_orgs (key TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, by TEXT)',
  `CREATE TABLE IF NOT EXISTS donor_calls (kind TEXT NOT NULL, subject TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', answer INTEGER NOT NULL,
    note TEXT, by TEXT, at TEXT NOT NULL, PRIMARY KEY (kind, subject, target))`,
  // The team's notes about a donor (a person's or an organization's key), newest shown first
  'CREATE TABLE IF NOT EXISTS donor_notes (id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, by TEXT, at TEXT NOT NULL, edited_by TEXT, edited_at TEXT)',
  'CREATE INDEX IF NOT EXISTS donor_notes_subject ON donor_notes(subject)',
];
const ready = new WeakSet();
export async function ensureCrm(DB) {
  if (ready.has(DB)) return;
  await ensureDonors(DB);
  for (const sql of SCHEMA) await DB.prepare(sql).run();
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
  return makeCrm({ partners, orgs, calls, now, history });
}

/**
 * The rules over what's known (pure, so the tests and the board use the same): organizations, links, the same person,
 * keep anonymous, and who each payment counts for
 */
export function makeCrm({ partners = [], orgs = [], calls = [], now = Date.now(), history = new Map() } = {}) {
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
  // Names an organization had while kept anonymous (renamed, merged or deleted since: still hidden by name)
  const keptNameCalls = [];
  // Who on the team looks after a donor: key → { email, at }
  const owners = new Map();
  // A person's key over another's: a Zeffy contact first (its address works in a link), then the earlier
  const better = (a, b) => ((a.startsWith('c:') ? 0 : 1) - (b.startsWith('c:') ? 0 : 1) || (a < b ? -1 : 1)) < 0;
  const find = (k) => { let r = k; while (parent.has(r)) r = parent.get(r); return r; };
  for (const c of calls) {
    const s = String(c.subject);
    const t = String(c.target || '');
    if (c.kind === 'contact' || c.kind === 'company') {
      if (c.answer) { yes.set(`${c.kind}\n${s}`, t); no.delete(`${c.kind}\n${s}\n${t}`); } else { no.add(`${c.kind}\n${s}\n${t}`); if (yes.get(`${c.kind}\n${s}`) === t) yes.delete(`${c.kind}\n${s}`); }
    } else if (c.kind === 'anon') anon.set(s, !!c.answer);
    else if (c.kind === 'payment') pay.set(s, String(c.note || ''));
    else if (c.kind === 'level') level.set(s, { answer: !!c.answer, at: c.at, note: c.note || null });
    else if (c.kind === 'big') big.set(s, { at: c.at });
    else if (c.kind === 'forward') forward.set(s, t);
    else if (c.kind === 'moved') movedDone.add(s);
    else if (c.kind === 'owner') { if (c.answer && c.note) owners.set(s, { email: String(c.note), at: c.at }); else owners.delete(s); }
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
    return contactOrgOf(r) || companyOrgOf(r) || person;
  };
  const keepAnonymous = (k) => (isOrgKey(k) ? !!anon.get(k) : keysOf(k).some((x) => anon.get(x)));
  /** Who looks after a donor (any record of a person: the latest said) → email or null */
  const lookedAfterBy = (k) => {
    const said = (isOrgKey(k) ? [String(k)] : keysOf(k)).map((x) => owners.get(x)).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
    return said[0]?.email || null;
  };

  return {
    org, live, exact, canon, keysOf, contactOrgOf, companyOrgOf, ownerOf, keepAnonymous, lookedAfterBy, now,
    calls: { yes, no, pay, level, big, notSame: notSameNow, notSameRaw: notSame, forward, movedDone },
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
      // Each person's Zeffy contacts and the organization each is (as contactOrgOf says: a link, or the same name)
      const orgsOf = new Map();
      // The organizations a person's contacts are linked to, as a person said, even ones deleted since
      const linksOf = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        raw.set(r, k);
        const p = canon(k);
        if (r.contact) {
          if (!orgsOf.has(p)) orgsOf.set(p, new Map());
          if (!orgsOf.get(p).has(r.contact)) orgsOf.get(p).set(r.contact, contactOrgOf(r));
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
        const rr = cid ? { ...r, contact: cid } : r;
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
// Under the donor it's about (their key), so their page shows it; 'donors' when it's about no one donor
const audit = (DB, by, name, changes, slug = 'donors') => logAudit(DB, { userEmail: by || 'unknown', action: 'updated', entityType: 'donor-crm', entitySlug: slug, entityName: name, changes }).catch(() => {});
const usd = (cents) => { const c = Math.round(Number(cents) || 0); return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`; };

/** The team, to pick an owner from: SOARD's active Google accounts (not the site's own, nor shared inboxes) → [{ email, name }] */
export async function staffList(DB) {
  let dir = [];
  try { dir = await staffDirectory(DB); } catch { /* not read yet */ }
  const { NOT_STAFF } = await import('./_reveal-invites.js');
  const out = new Map();
  for (const a of dir) {
    if (!a.active || !a.email) continue;
    const all = [a.email, ...(a.aliases || [])].map((x) => String(x).toLowerCase());
    // The SOARD address they sign in here with (a main account on the store's domain has a soardcharity.com alias)
    const email = all.find((x) => isStaffEmail(x)) || all[0];
    if (all.some((x) => NOT_STAFF.has(x))) continue;
    out.set(email, { email, name: clean(a.name) || email.split('@')[0] });
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const KINDS = new Set(['contact', 'company']);
const subjectOf = (kind, v) => (kind === 'company' ? nameKey(v) : clean(v));

/**
 * One change a person makes (Admin → Donors & Partners). Each is an answer kept in donor_calls and an entry in
 * History (its own type: nothing here waits for Publish). → whatever the change returns
 */
export async function act(env, body, by, { now = Date.now() } = {}) {
  const { DB } = env;
  await ensureCrm(DB);
  const crm = await loadCrm(DB, { now });
  const a = body?.act;
  const orgOk = (k) => { if (!crm.live(String(k || ''))) throw bad('That organization isn’t here any more. Reload and try again.', 409); return String(k); };
  if (a === 'link' || a === 'not') {
    if (!KINDS.has(body.kind)) throw bad('Link a contact or a company name');
    const subject = subjectOf(body.kind, body.subject);
    if (!subject) throw bad('Which name?');
    const target = orgOk(body.org);
    if (a === 'link') {
      // One organization per contact or company name: a link elsewhere goes, in the same step
      await DB.batch([
        DB.prepare("DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND answer = 1 AND target <> ?").bind(body.kind, subject, target),
        callStmt(DB, { kind: body.kind, subject, target, answer: 1 }, by, now),
      ]);
    } else await putCall(DB, { kind: body.kind, subject, target, answer: 0 }, by, now);
    await audit(DB, by, `${a === 'link' ? 'Linked' : 'Not'} ${body.kind === 'company' ? clean(body.subject) : 'a Zeffy contact'} ${a === 'link' ? 'to' : 'for'} ${crm.org.get(target).name}`, { kind: body.kind, subject, org: target, answer: a === 'link' }, target);
    return { ok: true };
  }
  if (a === 'same') {
    const [x, y] = [String(body.a || ''), String(body.b || '')].sort();
    if (!/^[cen]:/.test(x) || !/^[cen]:/.test(y) || x === y) throw bad('Two donors to compare');
    await putCall(DB, { kind: 'same', subject: x, target: y, answer: !!body.same }, by, now);
    await audit(DB, by, body.same ? 'Two donors are one person' : 'Two donors are not the same', { a: x, b: y, same: !!body.same }, crm.canon(x));
    return { ok: true, key: (await loadCrm(DB, { now })).canon(x) };
  }
  if (a === 'anon') {
    const key = isOrgKey(body.key) ? orgOk(body.key) : crm.canon(String(body.key || ''));
    if (!/^[cenxpo]:/.test(key)) throw bad('Whose?');
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
    // An organization's name is written down when it's kept (and stays: it counts only while the organization is kept)
    const names = isOrgKey(key) && body.on ? [crm.org.get(key).name, ...(key.startsWith('p:') ? await historyNames(DB, key.slice(2)) : [])] : [];
    const named = [...new Set(names.filter(Boolean))].map((n) => callStmt(DB, { kind: 'kept-name', subject: looseKey(n), target: key, answer: 1, note: n }, by, now));
    await DB.batch([
      ...[...off].map((k) => callStmt(DB, { kind: 'anon', subject: k, answer: !!body.on }, by, now)),
      ...[...new Set(others)].filter((k) => !off.has(k)).map((k) => callStmt(DB, { kind: 'anon', subject: k, answer: true }, by, now)),
      ...named,
    ]);
    await audit(DB, by, `${body.on ? 'Keep anonymous' : 'No longer kept anonymous'}: ${isOrgKey(key) ? crm.org.get(key).name : 'a donor'}`, { key, on: !!body.on }, key);
    return { ok: true };
  }
  if (a === 'payment') {
    const id = clean(body.id);
    const owner = body.owner === 'person' ? 'person' : orgOk(body.owner);
    if (!id) throw bad('Which gift?');
    await putCall(DB, { kind: 'payment', subject: id, answer: 1, note: owner }, by, now);
    await audit(DB, by, `A gift counts for ${owner === 'person' ? 'the person who gave it' : crm.org.get(owner).name}`, { id, owner }, owner === 'person' ? 'donors' : owner);
    return { ok: true };
  }
  if (a === 'payment-clear') {
    const id = clean(body.id);
    if (!id) throw bad('Which gift?');
    await DB.prepare("DELETE FROM donor_calls WHERE kind = 'payment' AND subject = ?").bind(id).run();
    await audit(DB, by, 'A gift counts as the site works it out again', { id });
    return { ok: true };
  }
  if (a === 'split') {
    // One record out of a person: never joined with the others again, and the others stay one person
    const key = String(body.key || '');
    const group = crm.keysOf(key);
    if (group.length < 2 || !group.includes(key)) throw bad('That record isn’t joined to anyone', 409);
    const rest = group.filter((k) => k !== key);
    // The one the others hang on now: a Zeffy contact first (its address works in a link), then the earliest
    const lead = [...rest].sort((x, y) => (x.startsWith('c:') ? 0 : 1) - (y.startsWith('c:') ? 0 : 1) || (x < y ? -1 : 1))[0];
    // One batch: all of it or none, so a failure part way never breaks the person up
    const steps = [DB.prepare("UPDATE donor_calls SET answer = 0 WHERE kind = 'same' AND answer = 1 AND (subject = ? OR target = ?)").bind(key, key)];
    // The person's notes and owner were said on the record that led them: they stay with the person
    if (crm.canon(key) === key) {
      steps.push(DB.prepare('UPDATE donor_notes SET subject = ? WHERE subject = ?').bind(lead, key));
      steps.push(DB.prepare("UPDATE OR IGNORE donor_calls SET subject = ? WHERE kind = 'owner' AND subject = ?").bind(lead, key));
    }
    for (const k of rest) {
      const [x, y] = [lead, k].sort();
      // The others hang on the lead, unless a person said that one isn't them
      if (k !== lead && !crm.calls.notSameRaw.has(`${x}\n${y}`)) steps.push(callStmt(DB, { kind: 'same', subject: x, target: y, answer: 1 }, by, now));
      const [p, q] = [key, k].sort();
      steps.push(callStmt(DB, { kind: 'same', subject: p, target: q, answer: 0 }, by, now));
    }
    await DB.batch(steps);
    await audit(DB, by, 'A record is not the same person after all', { key, from: rest }, lead);
    const crm2 = await loadCrm(DB, { now });
    const after = crm2.canon(lead);
    let ref = after.startsWith('c:') ? after.slice(2) : null;
    if (!ref) {
      const rows = await rowsFor(DB, [after]);
      const place = crm2.placer(rows);
      const one = rows.find((r) => place(r).person === after);
      ref = one ? `g:${one.id}` : null;
    }
    return { ok: true, key: after, ref };
  }
  if (a === 'level') {
    const key = orgOk(body.org);
    await putCall(DB, { kind: 'level', subject: key, answer: !!body.done, note: body.done ? clean(body.was) || null : null }, by, now);
    if (body.done) await audit(DB, by, `${crm.org.get(key).name} made Champion by giving (was ${clean(body.was) || 'unknown'})`, { org: key, was: clean(body.was) || null }, key);
    return { ok: true };
  }
  if (a === 'big') {
    const subject = String(body.subject || '');
    if (!subject) throw bad('Which name?');
    // The same giver under another of its names: not asked about for a year either
    const also = (Array.isArray(body.also) ? body.also : []).map(String).filter(Boolean).slice(0, 5);
    await DB.batch([subject, ...also].map((s) => callStmt(DB, { kind: 'big', subject: s, answer: 0 }, by, now)));
    return { ok: true };
  }
  if (a === 'org-new') {
    const name = clean(body.name).slice(0, 120);
    if (!name) throw bad('A name for the organization');
    if (crm.named(name).length) throw bad(`${crm.org.get(crm.named(name)[0]).name} is already here. Use Link to… to link the name to it.`, 409);
    const key = `o:${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    // The organization and its names in one step
    const steps = [DB.prepare('INSERT INTO donor_orgs (key, name, created_at, by) VALUES (?, ?, ?, ?)').bind(key, name, iso(now), by || null)];
    for (const l of Array.isArray(body.links) ? body.links.slice(0, 10) : []) {
      if (!KINDS.has(l?.kind)) continue;
      const subject = subjectOf(l.kind, l.subject);
      if (!subject) continue;
      steps.push(DB.prepare('DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND answer = 1').bind(l.kind, subject));
      steps.push(callStmt(DB, { kind: l.kind, subject, target: key, answer: 1 }, by, now));
    }
    await DB.batch(steps);
    await audit(DB, by, `New organization (not on the website): ${name}`, { key, name }, key);
    return { ok: true, key };
  }
  if (a === 'org-rename') {
    const key = orgOk(body.key);
    const name = clean(body.name).slice(0, 120);
    if (!key.startsWith('o:') || !name) throw bad('A new name for an organization not on the website (a partner’s name is changed in its partner card)');
    // Two organizations with one name would each lose the gifts that name links by itself
    if (crm.named(name, key).length) throw bad(`${crm.org.get(crm.named(name, key)[0]).name} already has that name.`, 409);
    await DB.batch([
      DB.prepare('UPDATE donor_orgs SET name = ? WHERE key = ?').bind(name, key),
      // Both names written down, kept or not (they count only while it's kept)
      callStmt(DB, { kind: 'kept-name', subject: looseKey(crm.org.get(key).name), target: key, answer: 1, note: crm.org.get(key).name }, by, now),
      callStmt(DB, { kind: 'kept-name', subject: looseKey(name), target: key, answer: 1, note: name }, by, now),
    ]);
    await audit(DB, by, `Organization renamed: ${name}`, { key, was: crm.org.get(key).name, name }, key);
    return { ok: true };
  }
  if (a === 'org-delete') {
    const key = orgOk(body.key);
    if (!key.startsWith('o:')) throw bad('A partner is deleted in its partner card');
    await DB.batch([
      DB.prepare('DELETE FROM donor_orgs WHERE key = ?').bind(key),
      DB.prepare('DELETE FROM donor_calls WHERE target = ? OR subject = ?').bind(key, key),
      DB.prepare('DELETE FROM donor_notes WHERE subject = ?').bind(key),
      // A gift a person counted for it goes back to counting as the site works it out
      DB.prepare("DELETE FROM donor_calls WHERE kind = 'payment' AND note = ?").bind(key),
    ]);
    await audit(DB, by, `Organization taken out: ${crm.org.get(key).name} (its gifts count for the people who gave them)`, { key }, key);
    return { ok: true };
  }
  if (a === 'website') {
    // A private organization just put on the website (its partner card made): everything said about it is the partner's
    const slug = clean(body.slug);
    // Asked again after it went through (Try again, a second tab): done already
    if (!crm.live(String(body.key || '')) && crm.calls.forward.get(String(body.key || '')) === `p:${slug}`) return { ok: true, key: `p:${slug}` };
    const key = orgOk(body.key);
    if (!key.startsWith('o:') || !crm.live(`p:${slug}`)) throw bad('That partner card isn’t saved yet. Save it, then try again.', 409);
    const name = crm.org.get(key).name;
    // Safe to repeat: a failure part way leaves it kept here, and trying again finishes it
    await moveCalls(DB, key, `p:${slug}`);
    // Its old address (a link in a toast, a bookmark) leads to the partner: in the same step as it goes
    await DB.batch([DB.prepare('DELETE FROM donor_orgs WHERE key = ?').bind(key), callStmt(DB, { kind: 'forward', subject: key, target: `p:${slug}`, answer: 1 }, by, now)]);
    await audit(DB, by, `${name} is on the website now`, { key, partner: slug }, `p:${slug}`);
    return { ok: true, key: `p:${slug}` };
  }
  // Who on the team looks after them (one person; none clears it)
  if (a === 'owner') {
    const key = whose(crm, body.key, orgOk);
    const email = clean(body.email).toLowerCase();
    let name = null;
    if (email) {
      const staff = await staffList(DB);
      const one = staff.find((s) => s.email === email);
      // Before Google's list is read: any SOARD address
      if (!one && (staff.length || !isStaffEmail(email))) throw bad('Pick someone on the team.');
      name = one?.name || email;
    }
    // Said on the record that leads a person; any said on their other records goes, so there's only ever one
    const keys = isOrgKey(key) ? [key] : crm.keysOf(key);
    await DB.batch([
      ...keys.map((k) => DB.prepare("DELETE FROM donor_calls WHERE kind = 'owner' AND subject = ?").bind(k)),
      ...(email ? [callStmt(DB, { kind: 'owner', subject: key, answer: 1, note: email }, by, now)] : []),
    ]);
    await audit(DB, by, email ? `Looked after by ${name}` : 'No one looks after them now', { key, owner: email || null }, key);
    return { ok: true };
  }
  // The team's notes
  if (a === 'note-add') {
    const key = whose(crm, body.key, orgOk);
    const text = String(body.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
    if (!text) throw bad('Write the note first.');
    const id = crypto.randomUUID();
    await DB.prepare('INSERT INTO donor_notes (id, subject, body, by, at) VALUES (?, ?, ?, ?, ?)').bind(id, key, text, by || null, iso(now)).run();
    await audit(DB, by, 'Note added', { key, note: id }, key);
    return { ok: true, id };
  }
  if (a === 'note-edit' || a === 'note-delete') {
    const n = await DB.prepare('SELECT id, subject FROM donor_notes WHERE id = ?').bind(String(body.id || '')).first();
    if (!n) throw bad('That note isn’t here any more. Reload and look again.', 404);
    if (a === 'note-delete') {
      await DB.prepare('DELETE FROM donor_notes WHERE id = ?').bind(n.id).run();
      await audit(DB, by, 'Note deleted', { key: n.subject, note: n.id }, n.subject);
      return { ok: true };
    }
    const text = String(body.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
    if (!text) throw bad('A note can’t be empty. Delete it instead.');
    await DB.prepare('UPDATE donor_notes SET body = ?, edited_by = ?, edited_at = ? WHERE id = ?').bind(text, by || null, iso(now), n.id).run();
    await audit(DB, by, 'Note changed', { key: n.subject, note: n.id }, n.subject);
    return { ok: true };
  }
  // A thank-you said: thanked, not needed, or (Undo) To thank again
  if (a === 'thanks') {
    const t = await markThanks(DB, { id: body.id, state: body.state }, by, { now });
    const owner = await donorOfPayment(env, String(t.ids).split(' ')[0], { crm }).catch(() => null);
    const words = { thanked: 'Thanked', skipped: 'No thank-you needed', todo: 'To thank again' }[body.state];
    await audit(DB, by, `${words}: ${t.in_kind ? `${usd(t.in_kind)} in kind` : usd(t.cents)} from ${t.name || 'a donor'}${t.at ? `, ${new Date(t.at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}` : ''}`, { gift: t.id, state: body.state, was: t.state }, owner || 'donors');
    return { ok: true, was: t.state };
  }
  if (a === 'moved-done') {
    // Remembered, so the next whole read doesn't ask again
    await putCall(DB, { kind: 'moved', subject: String(body.contact || ''), answer: 1 }, by, now);
    const st = await readCrmState(DB);
    await writeCrmState(DB, { unplaced: (st.unplaced || []).filter((u) => u.contact !== String(body.contact)) });
    return { ok: true };
  }
  throw bad('Unknown change');
}

/** The donor a change is about: an organization that's here, or a person as the record that leads them */
function whose(crm, k, orgOk) {
  const key = isOrgKey(k) ? orgOk(k) : crm.canon(String(k || ''));
  if (!/^[cenxpo]:/.test(key)) throw bad('Whose?');
  return key;
}

/** Everything said about one organization (or person key) is now another's; where the other already has an answer, its own stands */
async function moveCalls(DB, from, into) {
  const rows = (await DB.prepare('SELECT kind, subject, target, answer, note, by, at FROM donor_calls WHERE subject = ? OR target = ?').bind(from, from).all()).results || [];
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
      : DB.prepare('INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(c.kind, s2, t2, c.answer, c.note, c.by, c.at);
    steps.push(put, DB.prepare('DELETE FROM donor_calls WHERE kind = ? AND subject = ? AND target = ?').bind(c.kind, c.subject, c.target));
  }
  // A gift a person counted for the old one counts for the new one; its notes are the new one's
  steps.push(DB.prepare("UPDATE donor_calls SET note = ? WHERE kind = 'payment' AND note = ?").bind(into, from));
  steps.push(DB.prepare('UPDATE donor_notes SET subject = ? WHERE subject = ?').bind(into, from));
  await DB.batch(steps);
  // A contact linked to the old one, also linked to the new one: one link (the newer)
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
    // Gifts under its name count for the one it went into (the name no longer matches a partner by itself)
    const k = nameKey(fromName);
    if (k && k !== nameKey(intoName)) await DB.prepare("INSERT OR IGNORE INTO donor_calls (kind, subject, target, answer, note, by, at) SELECT 'company', ?, ?, 1, NULL, 'Partners merge', ? WHERE NOT EXISTS (SELECT 1 FROM donor_calls WHERE kind = 'company' AND subject = ? AND answer = 1)")
      .bind(k, `p:${from}`, at, k).run();
  }
  await moveCalls(DB, `p:${from}`, `p:${into}`);
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
 * After a whole read of Zeffy: a contact the site knows something about (a link, Keep anonymous, the same person)
 * that has no payments left, whose payments all went to one other contact (Zeffy merged them), is that contact now.
 * Went to several: a person decides (Needs you). → { moved, unplaced }
 */
export async function followMerges(DB, { now = Date.now() } = {}) {
  await ensureCrm(DB);
  const calls = (await DB.prepare('SELECT kind, subject, target FROM donor_calls').all()).results || [];
  const ids = new Set();
  for (const c of calls) {
    if (c.kind === 'contact') ids.add(String(c.subject));
    for (const v of [c.subject, c.target]) if (/^c:/.test(String(v)) && ['anon', 'same'].includes(c.kind)) ids.add(String(v).slice(2));
  }
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
    if (!unplaced.some((u) => u.contact === id)) unplaced.push({ contact: id, to: went.slice(0, 5), at: iso(now) });
  }
  if (moved || unplaced.length !== (st.unplaced || []).length || JSON.stringify(unplaced) !== JSON.stringify(st.unplaced || [])) {
    await writeCrmState(DB, { unplaced });
    if (moved) await audit(DB, 'Zeffy merge', `What was known about ${moved === 1 ? 'a contact' : `${moved} contacts`} Zeffy merged now goes with their gifts`, { moved });
  }
  return { moved, unplaced: unplaced.length };
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
  for (const c of companies.values()) {
    if (!(c.cents > 0)) continue;
    const near = nearPartners(c.name, orgList, { min: 0.6, max: 3 }).find((m) => !crm.calls.no.has(`company\n${c.key}\n${m.partner.slug}`));
    if (!near) continue;
    asked.add(c.key);
    items.push({ id: `near-company:${c.key}:${near.partner.slug}`, kind: 'near', link: 'company', subject: c.name, org: near.partner.slug, orgName: near.partner.name, why: near.why, cents: c.cents, people: [...c.people.values()].slice(0, 3) });
  }
  // A contact whose whole name is inside an organization's ("Chris Moreno" and Chris & Dana Moreno)
  const contacts = new Map();
  for (const { r, person, kept } of placed) {
    if (!r.contact || crm.contactOrgOf(r)) continue;
    const c = contacts.get(r.contact) || { id: r.contact, person, name: personName(r), cents: 0, cents12: 0, anonymous: false, at: 0 };
    c.cents += Number(r.giving) || 0;
    if (r.method !== 'in_kind' && within(r.at, now, YEAR_MS)) c.cents12 += Number(r.giving) || 0;
    if (r.anonymous || kept) c.anonymous = true;
    if (r.at > c.at) { c.at = r.at; c.name = personName(r); }
    contacts.set(r.contact, c);
  }
  const orgWords = [...crm.org.values()].map((o) => ({ o, w: new Set(words(o.name)) })).filter((x) => x.w.size >= 2);
  for (const c of contacts.values()) {
    if (!(c.cents > 0) || crm.calls.yes.has(`contact\n${c.id}`)) continue;
    const w = [...new Set(words(c.name))];
    if (w.length < 2) continue;
    const hit = orgWords.find(({ o, w: ow }) => ow.size > w.length && w.every((t) => ow.has(t)) && !crm.calls.no.has(`contact\n${c.id}\n${o.key}`));
    if (hit) items.push({ id: `near-contact:${c.id}:${hit.o.key}`, kind: 'near', link: 'contact', subject: c.id, name: c.name, ref: crm.canon(c.person).startsWith('c:') ? crm.canon(c.person).slice(2) : null, org: hit.o.key, orgName: hit.o.name, why: 'Their name is in it', cents: c.cents });
  }
  // A gift whose contact is one organization and whose company is another
  for (const { r, cid } of placed) {
    const cl = crm.clashOf(r, cid);
    if (!cl || !(Number(r.giving) > 0)) continue;
    items.push({ id: `clash:${r.id}`, kind: 'clash', payment: r.id, name: personName(r), company: clean(r.company), cents: Number(r.giving) || 0, at: r.at, counted: cl.contact, countedName: crm.org.get(cl.contact).name, other: cl.company, otherName: crm.org.get(cl.company).name });
  }
  // Two donors that may be one person: the same name (no middle initial), or one email on two Zeffy contacts
  const people = new Map();
  for (const { r, person, owner } of placed) {
    if (owner !== person) continue;
    const p = people.get(person) || { key: person, name: personName(r), emails: new Set(), same: '', cents: 0, gifts: 0, at: 0 };
    p.cents += Number(r.giving) || 0;
    if (Number(r.giving) > 0) p.gifts++;
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
      if (asked3.has(a) || asked3.has(b)) continue;
      pairs.set(`${a}\n${b}`, { a, b, why });
      asked3.add(a);
      asked3.add(b);
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
  // Big givers with no organization here: a company name, or a contact whose name reads as an organization's
  const bigOnes = [
    ...[...companies.values()].filter((c) => !asked.has(c.key)).map((c) => ({ subject: `company:${c.key}`, link: 'company', linkSubject: c.name, name: c.name, cents12: c.cents12, anonymous: c.anonymous, people: [...c.people.values()].slice(0, 3) })),
    ...[...contacts.values()].filter((c) => ORG_WORDS.test(c.name)).map((c) => ({ subject: `contact:${c.id}`, link: 'contact', linkSubject: c.id, name: c.name, cents12: c.cents12, anonymous: c.anonymous, people: [] })),
  ];
  // One name asked about once: a company typed on gifts and a Zeffy contact of the same name are one giver (the
  // company's name is linked; the contact's then matches by itself)
  const bigByName = new Map();
  for (const b of bigOnes) {
    if (b.cents12 < CHAMPION_CENTS || b.anonymous) continue;
    const nk = nameKey(b.name) || b.subject;
    if (bigByName.has(nk)) { bigByName.get(nk).also.push(b.subject); continue; }
    bigByName.set(nk, { ...b, also: [] });
  }
  for (const b of bigByName.values()) {
    if ([b.subject, ...b.also].some((s) => !yearAgo(crm.calls.big.get(s)?.at))) continue;
    items.push({ id: `big:${b.subject}`, kind: 'big', subject: b.subject, also: b.also, link: b.link, linkSubject: b.linkSubject, name: b.name, cents12: b.cents12, people: b.people });
  }
  for (const u of unplaced) if (!crm.calls.movedDone.has(u.contact)) items.push({ id: `moved:${u.contact}`, kind: 'moved', contact: u.contact, to: u.to, at: u.at });
  const order = { level: 0, big: 1, near: 2, clash: 3, same: 4, moved: 5 };
  return items.sort((x, y) => order[x.kind] - order[y.kind] || (y.cents12 || y.cents || 0) - (x.cents12 || x.cents || 0));
}

/** Admin → Donors & Partners: everyone who gives, people and organizations, how many things need a person, how many gifts wait for a thank-you, and the team (owners) */
export async function listView(env, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  const [rows, st, thanks, staff] = await Promise.all([allRows(env.DB), readCrmState(env.DB), thanksCount(env.DB), staffList(env.DB)]);
  const v = await donorsView(env, { now, crm, rows });
  return { ...v, needs: needsOf(rows, crm, { now, unplaced: st.unplaced || [] }).length, thanks, staff: withOwners(staff, v.people.map((p) => p.owner)) };
}
/** The team, and anyone still named an owner who has left it (shown, so their donors can be given to someone else) */
const withOwners = (staff, owners) => {
  const have = new Set(staff.map((s) => s.email));
  const gone = [...new Set(owners.filter((o) => o && !have.has(o)))].map((email) => ({ email, name: email.split('@')[0], left: true }));
  return [...staff, ...gone];
};

// ─── Notes, history and thank-yous on a donor's page ────────────────

/** A donor's notes (every record of a person), newest first */
async function notesOf(DB, keys) {
  if (!keys.length) return [];
  const r = (await DB.prepare(`SELECT id, body, by, at, edited_by, edited_at FROM donor_notes WHERE subject IN (${keys.map(() => '?').join(', ')}) ORDER BY at DESC`).bind(...keys).all()).results || [];
  return r.map((n) => ({ id: n.id, body: n.body, by: n.by || null, at: n.at, editedBy: n.edited_by || null, editedAt: n.edited_at || null }));
}
/** What the team did about a donor, newest first (their History) */
async function historyOf(DB, keys) {
  if (!keys.length) return [];
  try {
    const r = (await DB.prepare(`SELECT user_email, entity_name, created_at FROM audit_log WHERE entity_type = 'donor-crm' AND entity_slug IN (${keys.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 25`).bind(...keys).all()).results || [];
    return r.map((h) => ({ by: h.user_email && h.user_email !== 'unknown' ? h.user_email : null, at: `${String(h.created_at).replace(' ', 'T')}Z`, what: h.entity_name || '' }));
  } catch (e) { if (missingTable(e)) return []; throw e; }
}
/** Each gift with its thank-you: { state: todo | thanked | skipped | gone, why, by, at } */
async function withThanks(DB, gifts) {
  const t = await thanksFor(DB, gifts.flatMap((g) => g.ids || [g.id]));
  return gifts.map((g) => { const x = (g.ids || [g.id]).map((id) => t.get(id)).find(Boolean); return x ? { ...g, thanks: { ...x, whyText: THANK_WHY[x.why] || null } } : g; });
}
/** The extras a donor's page carries: owner, notes, History, and each gift's thank-you */
async function pageExtras(env, crm, key, v) {
  const keys = isOrgKey(key) ? [key] : crm.keysOf(key);
  const [notes, history, gifts, staff] = await Promise.all([notesOf(env.DB, keys), historyOf(env.DB, keys), withThanks(env.DB, v.gifts), staffList(env.DB)]);
  const owner = crm.lookedAfterBy(key);
  return { owner, notes, history, gifts, staff: withOwners(staff, [owner]) };
}

/** Every gift waiting for a thank-you, the one waiting longest first, with whose it is and who looks after them */
export async function thanksView(env, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  const items = await thanksToDo(env.DB);
  const out = [];
  for (const t of items.slice(0, 200)) {
    const id = String(t.ids).split(' ')[0];
    // Whose it is now (an organization, or a person): their page, and who looks after them
    const owner = await donorOfPayment(env, id, { crm }).catch(() => null);
    const org = owner && isOrgKey(owner) ? crm.orgFacts(owner) : null;
    out.push({
      id, ids: String(t.ids).split(' '), at: t.at, cents: t.cents, inKind: t.in_kind, name: t.name || 'No name', company: t.company || null,
      campaign: t.campaign || '', how: t.how || '', why: t.why, whyText: THANK_WHY[t.why] || '', since: t.created_at,
      org: org && !org.gone ? { key: owner, name: org.name } : null,
      ref: owner && !isOrgKey(owner) ? refOfKey(owner, id) : null,
      owner: owner ? crm.lookedAfterBy(owner) : null,
    });
  }
  const staff = await staffList(env.DB);
  return { items: out, more: Math.max(0, items.length - out.length), staff: withOwners(staff, out.map((x) => x.owner)) };
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
  return { items: needsOf(rows, crm, { now, unplaced: st.unplaced || [] }) };
}

/** A person's page: their gifts, what they gave for organizations, the company names they gave for that aren't linked */
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
  const also = crm.keysOf(key).filter((k) => k !== key).map((k) => ({ key: k, ref: k.startsWith('c:') ? k.slice(2) : null }));
  // Kept anonymous, as the board has it: with everyone (someone kept may share their email or name)
  const allPlaced = crm.anyKeptAnonymous ? await allRows(env.DB) : rows;
  const pa = allPlaced === rows ? place : crm.placer(allPlaced);
  const why = pa.why(key);
  const otherName = why?.other ? (() => { const r = allPlaced.find((x) => pa(x).person === why.other); return r ? personName(r) : 'someone else'; })() : null;
  return { ...v, ...(await pageExtras(env, crm, key, v)), key, ref: refOfKey(key, mine[0]?.id || ''), keepAnonymous: pa.kept(key), keptWhy: why ? { ...why, otherName } : null, companies: [...loose.values()], also };
}

/** An organization's page: its gifts (and who paid each), the Zeffy names it gives under, the people who gave for it */
export async function orgView(env, key, { now = Date.now() } = {}) {
  const crm = await loadCrm(env.DB, { now });
  if (!crm.isOrg(key)) {
    const to = crm.calls.forward.get(key);
    return to && crm.isOrg(to) ? { moved: to } : null;
  }
  const [rows, kids, st] = await Promise.all([allRows(env.DB), kidNames(env.DB), readCrmState(env.DB)]);
  const place = crm.placer(rows);
  const mine = rows.filter((r) => place(r).owner === key);
  const d = donorOf(key, mine, { now, kids });
  const facts = crm.orgFacts(key);
  d.name = facts.name;
  const v = await giftsView(env, d, mine, kids, { by: true });
  // The names it gives under, and why each counts
  const contacts = new Map();
  const companies = new Map();
  const people = new Map();
  for (const r of mine) {
    const p = place(r).person;
    const pe = people.get(p) || { key: p, ref: p.startsWith('c:') ? p.slice(2) : `g:${r.id}`, name: personName(r), cents: 0, gifts: 0 };
    pe.cents += Number(r.giving) || 0;
    if (Number(r.giving) > 0) pe.gifts++;
    people.set(p, pe);
    if (r.contact && crm.contactOrgOf(r) === key) {
      const how = crm.calls.yes.get(`contact\n${r.contact}`) === key ? 'linked' : 'same name';
      contacts.set(r.contact, { kind: 'contact', subject: r.contact, name: personName(r), how });
    } else if (crm.companyOrgOf(r) === key) {
      const k = nameKey(r.company);
      const how = crm.calls.yes.get(`company\n${k}`) === key ? 'linked' : 'same name';
      companies.set(k, { kind: 'company', subject: clean(r.company), name: clean(r.company), how });
    } else if (crm.calls.pay.get(String(r.id)) === key) contacts.set(`pay:${r.id}`, { kind: 'payment', subject: r.id, name: `One gift from ${personName(r)}`, how: 'this gift' });
  }
  // Links made with no gifts yet (a contact or a name a person linked before it gave)
  for (const [k, t] of crm.calls.yes) {
    if (t !== key) continue;
    const [kind, subject] = k.split('\n');
    if (kind === 'contact' && !contacts.has(subject)) contacts.set(subject, { kind, subject, name: 'A Zeffy contact (no gifts yet)', how: 'linked' });
    if (kind === 'company' && !companies.has(subject)) companies.set(subject, { kind, subject, name: subject, how: 'linked', noGifts: true });
  }
  const needs = needsOf(rows, crm, { now, unplaced: st.unplaced || [] }).filter((n) => n.org === key || n.counted === key || n.other === key);
  return {
    ...v, ...(await pageExtras(env, crm, key, v)), key, ...facts,
    keptNames: facts.keepAnonymous ? crm.keptNamesFor(key) : [],
    // Given anonymously, or by someone kept anonymous: Put on the website asks first
    anonymousGifts: mine.some((r) => r.anonymous || place(r).kept),
    names: [...contacts.values(), ...companies.values()],
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
    const p = by.get(person) || { key: person, name: personName(r), email: r.email || null, cents: 0, gifts: 0, hit: false, at: 0 };
    p.cents += Number(r.giving) || 0;
    if (Number(r.giving) > 0) p.gifts++;
    if (r.at > p.at) { p.at = r.at; p.name = personName(r); p.email = r.email || p.email; }
    if (personName(r).toLowerCase().includes(t) || String(r.email || '').includes(t)) p.hit = true;
    by.set(person, p);
  }
  const ex = except ? crm.canon(except) : null;
  return { people: [...by.values()].filter((p) => p.hit && p.key !== ex).sort((a, b) => b.cents - a.cents).slice(0, 12).map(({ hit, ...p }) => p) };
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
