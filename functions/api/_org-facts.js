/**
 * SOARD's own facts, for the board page, and the check that keeps them true
 * ===========================================================================
 * The facts are the site's own, nothing copied: Site Config → Organization &
 * contact (site_config 'settings': the name, legal name, EIN, office and
 * mailing addresses, phone, email, tagline, vision and values) and the
 * mission on the same page (site_config 'media'.mission, which the homepage
 * and /branding/ show). orgFacts reads them each time the board page opens,
 * so a save shows there at once (on the public site once it's published).
 *
 * The check (maybeCheckOrgFacts, on the heartbeat, every few hours):
 *   - the IRS's list of tax-exempt organizations for SOARD's state
 *     (irs.gov/pub/irs-soi/eo_<state>.csv, the Business Master File, about
 *     10 MB, new about once a month) is read again when it changes, and
 *     SOARD's line kept: the name and address the IRS has, 501(c)(3),
 *     exempt, gifts deductible, the kind of public charity;
 *   - SOARD's W-9 on Board → Documents is read by Workers AI from its first
 *     page when the file changes: line 1, the EIN, the address. A field
 *     that doesn't match the site is read a second way, and only what both
 *     readings agree on is kept (a misread digit never raises an alarm);
 *   - the Board Manual's mission statement, from its words.
 * What doesn't match (../../public/admin/org-facts-shared.js problemsFor)
 * shows in Site Config → Organization & contact, with what each says and a
 * button to put the right one in, on Automations, and once in Slack, the
 * post turning ✅ when it all matches. Kept in site_config 'org-check'
 * (runtime state: never built into the site).
 */

import { slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { askModel, scannedPages, documentType } from './_vendor-read.js';
import { aiCapped } from './_ai.js';
import { drawPages, closeBrowser } from './_coi-backfill.js';
import { boardFiles } from './_board.js';
import {
  einDigits, irsRecord, exempt, rulingText, PUBLIC_CHARITY, manualMission, problemsFor, hasMailing, sameName, sameAddress, csvCells, SITE_HOST,
} from '../../public/admin/org-facts-shared.js';

export const CHECK_KEY = 'org-check';
export const ISSUE_KEY = 'org-facts';
const EVERY_MS = 6 * 3600e3;                    // the check, at most this often
const IRS_AGAIN_MS = 35 * 86400e3;              // the IRS's list, read again at least this often even when it says it hasn't changed
const W9_READER = 1;                            // a W-9 read by an older reading is read again
const RETRY_MS = 24 * 3600e3;                   // a W-9 that couldn't be read (or wasn't taken for one) is read again after this
const CLAIM_MS = 3 * 60e3;                      // one run's hold on the check: a run cut off lets go this soon
const W9_TRIES = 3;                             // a W-9 read this many times without an answer (each cut off) is said as unreadable
const VISION = '@cf/meta/llama-4-scout-17b-16e-instruct'; // as ./_vendor-read.js reads vendors' W-9s
const ADMIN_URL = `${SITE_ORIGIN}/admin/#site/org`;
const irsUrl = (state) => `https://www.irs.gov/pub/irs-soi/eo_${String(state || 'ga').toLowerCase()}.csv`;
const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const dayText = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

async function readDoc(DB, key) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(key).first();
  return parse(row?.data, null);
}
const writeCheck = (DB, data) => DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(CHECK_KEY, JSON.stringify(data), iso()).run();
export const readCheck = (DB) => readDoc(DB, CHECK_KEY);

// ─── The board page ─────────────────────────────────────────────────

const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const addr = (a) => (a && str(a.street) ? { street: str(a.street, 120), city: str(a.city, 60), state: str(a.state, 2), zip: str(a.zip, 10) } : null);

/**
 * What the board page shows under Documents → SOARD's facts: the site's facts as saved, and what the IRS's list
 * says of the exemption when it's SOARD's EIN that was looked up (never a stale line for another EIN)
 */
export async function orgFacts(env) {
  const [settings, media, check] = await Promise.all([readDoc(env.DB, 'settings'), readDoc(env.DB, 'media'), readCheck(env.DB)]).catch(() => [null, null, null]);
  const st = settings || {};
  const m = media || {};
  const rec = check?.irs?.record && check.irs.record.ein === einDigits(st.ein) ? check.irs.record : null;
  const values = (Array.isArray(st.values) ? st.values : []).map((v) => ({ name: str(v?.name, 80), text: str(v?.text, 400) })).filter((v) => v.name);
  return {
    name: str(st.name, 120),
    shortName: str(st.shortName, 40),
    legalName: str(st.legalName, 160),
    ein: str(st.ein, 20),
    tagline: str(st.tagline, 120),
    address: addr(st.address),
    // (a mailing address that's the office's is one address, said once)
    mailing: hasMailing(st) && !sameAddress(st.mailingAddress, st.address) ? addr(st.mailingAddress) : null,
    phone: str(st.phone, 40),
    email: str(st.email, 120),
    website: str(m.bio?.website, 120) || SITE_HOST,
    founded: str(m.bio?.founded, 20),
    founders: str(m.bio?.founders, 120),
    bio: str(m.bio?.boilerplate, 600),
    mission: str(m.mission),
    vision: str(st.vision),
    values,
    irs: rec ? { exempt: exempt(rec), since: rulingText(rec.ruling), publicCharity: PUBLIC_CHARITY[Number(rec.foundation)] || '', listed: check.irs.date || '' } : null,
  };
}

// ─── The IRS's list ─────────────────────────────────────────────────

/**
 * SOARD's line in the IRS's list for a state, read as it streams (about 10 MB; it stops at SOARD's line)
 * → { record, modified }. record null only when it's proven the EIN isn't on it: the list is sorted by EIN, so
 * passing a bigger one, or reading every byte the IRS said it sent. Anything else (a page that isn't the list's
 * CSV, the IRS turning the site away, a read cut short) throws, and is tried again
 */
const IRS_COLUMNS = ['EIN', 'NAME', 'STREET', 'CITY', 'STATE', 'ZIP', 'SUBSECTION', 'STATUS', 'DEDUCTIBILITY'];
export async function readIrsList(ein, state, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(irsUrl(state), { headers: { 'User-Agent': `SOARD site check (${SITE_HOST})` } });
  if (!res.ok || !res.body) throw new Error(`The IRS’s list answered ${res.status}`);
  const modified = res.headers.get('last-modified') || '';
  const length = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const needle = `\n${ein},`;
  let header = null;
  let buf = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) bytes += value.byteLength;
      buf += done ? dec.decode() : dec.decode(value, { stream: true });
      if (header === null && (buf.indexOf('\n') >= 0 || done || buf.length > 4096)) {
        const nl = buf.indexOf('\n');
        header = (nl >= 0 ? buf.slice(0, nl) : buf).replace(/\r$/, '');
        const cols = csvCells(header).map((x) => x.trim().toUpperCase());
        if (cols[0] !== 'EIN' || !IRS_COLUMNS.every((k) => cols.includes(k))) throw new Error('The IRS’s list didn’t come as its CSV (irs.gov may be turning the site away)');
        buf = nl >= 0 ? buf.slice(nl) : '';
      }
      if (header !== null) {
        const at = buf.indexOf(needle);
        if (at >= 0) {
          const end = buf.indexOf('\n', at + 1);
          if (end >= 0 || done) return { record: irsRecord(header, buf.slice(at + 1, end >= 0 ? end : undefined)), modified };
        } else {
          // The last whole line's EIN: past SOARD's, and SOARD's isn't on the list
          const last = buf.lastIndexOf('\n');
          const prevNl = buf.lastIndexOf('\n', last - 1);
          const passed = last > 0 && prevNl >= 0 ? buf.slice(prevNl + 1, prevNl + 10) : '';
          if (/^\d{9}$/.test(passed) && passed > ein) return { record: null, modified };
          if (!done) buf = buf.slice(Math.max(0, last));
        }
      }
      if (done) {
        if (length && bytes < length) throw new Error(`The IRS’s list stopped short (${bytes} of ${length} bytes)`);
        return { record: null, modified };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** When the list was last changed, without reading it ('' when the IRS doesn't say) */
async function irsModified(state, fetchImpl) {
  try {
    const r = await fetchImpl(irsUrl(state), { method: 'HEAD', headers: { 'User-Agent': `SOARD site check (${SITE_HOST})` } });
    return r.ok ? r.headers.get('last-modified') || '' : '';
  } catch { return ''; }
}

// ─── SOARD's W-9 ────────────────────────────────────────────────────

const W9_PROMPT = `This is IRS Form W-9 filled in by a nonprofit about itself. Report only what is written on it; never guess.
- isW9: false when this isn't a W-9.
- name: line 1, as written. businessName: line 2, empty when blank.
- ein: the Employer identification number in Part I, digits and dash as written. Empty when the boxes are blank or unreadable.
- street: line 5 (number, street, and apartment or suite). cityStateZip: line 6.
- signedDate: the date beside the signature, as YYYY-MM-DD, when there is one.`;
const W9_AGAIN = `Look closely at this IRS Form W-9, one box at a time. Report only what is written on it; never guess.
- isW9: false when this isn't a W-9.
- ein: the nine digits in the Employer identification number boxes of Part I, as written, read digit by digit.
- name: line 1. businessName: line 2.
- street: line 5, the street address with any suite. cityStateZip: line 6, city, state and ZIP code.
- signedDate: the signature's date as YYYY-MM-DD.`;
const W9_SCHEMA = {
  type: 'object',
  properties: { isW9: { type: 'boolean' }, name: { type: 'string' }, businessName: { type: 'string' }, ein: { type: 'string' }, street: { type: 'string' }, cityStateZip: { type: 'string' }, signedDate: { type: 'string' } },
  // Workers AI's JSON mode leaves out what isn't required
  required: ['isW9', 'name', 'businessName', 'ein', 'street', 'cityStateZip', 'signedDate'],
};
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const askW9 = (env, prompt, page) => askModel(env, VISION, [
  { role: 'system', content: prompt },
  { role: 'user', content: [{ type: 'text', text: 'Read this form.' }, { type: 'image_url', image_url: { url: `data:${page.type};base64,${b64(page.bytes)}` } }] },
], W9_SCHEMA).catch((err) => { if (aiCapped(err)) return null; throw err; }); // (a cap reached: unread, and checked again in a day)

const zipOf = (s) => (String(s || '').match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || '';
const same = (a, b, key) => key(a) && key(a) === key(b);
const streetish = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const nameish = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

/**
 * Two readings of the W-9 → what both say. A field they differ on is left out (unsure), so only a W-9 that
 * really says something else is ever flagged
 */
export function agreed(a, b) {
  if (!a?.isW9) return a ? { isW9: false } : null;
  if (!b) return { isW9: true, name: str(a.name, 160), ein: einDigits(a.ein).length === 9 ? einDigits(a.ein) : '', street: str(a.street, 160), cityStateZip: str(a.cityStateZip, 120), zip: zipOf(a.cityStateZip), signedDate: str(a.signedDate, 10) };
  return {
    isW9: true,
    name: same(a.name, b.name, nameish) ? str(a.name, 160) : '',
    ein: einDigits(a.ein).length === 9 && einDigits(a.ein) === einDigits(b.ein) ? einDigits(a.ein) : '',
    street: same(a.street, b.street, streetish) ? str(a.street, 160) : '',
    cityStateZip: zipOf(a.cityStateZip) && zipOf(a.cityStateZip) === zipOf(b.cityStateZip) ? str(a.cityStateZip, 120) : '',
    zip: zipOf(a.cityStateZip) === zipOf(b.cityStateZip) ? zipOf(a.cityStateZip) : '',
    signedDate: str(a.signedDate, 10),
  };
}

/** The W-9 on Board → Documents (a paper whose title says W-9, its newest file): { doc, file } or null */
async function findW9(DB) {
  const docs = await DB.prepare('SELECT data FROM board_docs').all().then((r) => (r.results || []).map((x) => parse(x.data, {}))).catch(() => []);
  const doc = docs.filter((d) => /\bw-?9\b/i.test(String(d.title || '')) && d.shared !== false).sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')))[0];
  if (!doc) return null;
  const file = await DB.prepare("SELECT id, r2_key, name, type, size, at FROM board_files WHERE owner_type = 'doc' AND owner_id = ? ORDER BY at DESC LIMIT 1").bind(doc.id).first().catch(() => null);
  return file ? { doc, file } : null;
}

/** The Board Manual's own words (a paper whose title says Manual) → its mission statement, or '' */
async function findManualMission(DB) {
  const docs = await DB.prepare('SELECT data FROM board_docs').all().then((r) => (r.results || []).map((x) => parse(x.data, {}))).catch(() => []);
  for (const d of docs.filter((x) => /manual/i.test(String(x.title || '')))) {
    const row = await DB.prepare("SELECT words FROM board_files WHERE owner_type = 'doc' AND owner_id = ? AND words IS NOT NULL ORDER BY at DESC LIMIT 1").bind(d.id).first().catch(() => null);
    // (words written in Board are the paper as it is now; a file's are from when it was read)
    const said = manualMission(d.body || '') || manualMission(row?.words || '');
    if (said) return { mission: said, title: String(d.title || '') };
  }
  return null;
}

/**
 * The W-9's first page as a picture (a scan's own photo, else drawn in Browser Rendering), read; read again a
 * second way when anything on it (the EIN, the address, line 1) doesn't match the site → the agreed reading, or
 * { unreadable }. known.names: other names SOARD goes by (the IRS's)
 */
export async function readW9(env, file, settings, { draw = null, known = {} } = {}) {
  const obj = await boardFiles(env)?.get(file.r2_key);
  if (!obj) return { unreadable: 'The file isn’t in storage' };
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  const type = documentType(bytes.slice(0, 16));
  const ctx = {};
  let pages = [];
  try {
    if (type === 'image/jpeg' || type === 'image/png' || type === 'image/webp') pages = [{ bytes, type }];
    else if (type === 'application/pdf') {
      pages = scannedPages(bytes, { max: 1 });
      if (!pages.length) pages = draw ? await draw(bytes) : await drawPages(env, ctx, bytes, { max: 1 });
    }
  } finally {
    await closeBrowser(ctx);
  }
  if (!pages.length) return { unreadable: 'Its page couldn’t be drawn' };
  const first = await askW9(env, W9_PROMPT, pages[0]);
  if (!first) return { unreadable: 'Workers AI didn’t answer' };
  if (!first.isW9) return { isW9: false };
  // Only a reading that disagrees with the site is read again
  const mail = settings ? (hasMailing(settings) ? settings.mailingAddress : settings.address) || {} : {};
  const names = [settings?.legalName, settings?.name, ...(known.names || [])].filter((x) => String(x || '').trim());
  const differs = einDigits(first.ein) !== einDigits(settings?.ein) || streetish(first.street) !== streetish(mail.street) || zipOf(first.cityStateZip) !== String(mail.zip || '').slice(0, 5)
    || (names.length > 0 && !names.some((n) => sameName(n, first.name)));
  const second = differs ? await askW9(env, W9_AGAIN, pages[0]) : null;
  return differs && !second ? { unreadable: 'Workers AI didn’t answer the second time' } : agreed(first, second);
}

// ─── The check ──────────────────────────────────────────────────────

const levelOf = (problems) => (problems.some((p) => p.level === 'urgent') ? 'urgent' : problems.length ? 'warn' : 'ok');
const sigOf = (problems) => problems.filter((p) => p.key !== 'ein-changed').map((p) => p.key).sort().join(',');

function problemCard(problems, check) {
  const urgent = problems.some((p) => p.level === 'urgent');
  return slackCard({
    icon: urgent ? '🚨' : '⚠️',
    title: urgent ? 'SOARD’s tax-exempt status needs a look' : 'SOARD’s facts don’t match the IRS or its papers',
    lead: problems.map((p) => `• ${p.title}`).join('\n'),
    facts: [check.irs?.date ? ['IRS list', `updated ${check.irs.date}`] : null, check.w9?.title ? ['W-9', check.w9.title] : null].filter(Boolean),
    fix: 'Site Config → Organization & contact shows what each one says, with a button to put the right one in. This turns ✅ once they match.',
    buttons: [{ label: 'Open Organization & contact', url: ADMIN_URL }],
    footer: 'The IRS’s list of tax-exempt organizations · SOARD’s W-9 and Board Manual on the board page',
  });
}

/** Whether everything was really looked at: no ✅ for a list that didn't answer, a W-9 not read, a new EIN not looked up */
const checkedAll = (check, problems) => !check.irs?.error && !problems.some((p) => p.key === 'ein-changed') && !(check.w9 && !check.w9.read?.isW9);

/**
 * The check. Each slow step (the IRS's list, the W-9) is kept as it's done, so a run cut off loses nothing.
 * steps: how many slow steps this run may take (the heartbeat takes one a tick, so each fits the time a tick has;
 * the next tick goes on). force: read both again whatever their dates say (Site Config's Check again)
 * → the check as kept, with its problems (problemsFull) when it got to the end, or { pending: true }
 */
export async function checkOrgFacts(env, { now = Date.now(), fetchImpl = fetch, force = false, draw = null, slack = true, steps = Infinity } = {}) {
  const { DB } = env;
  const [settings, media, before] = await Promise.all([readDoc(DB, 'settings'), readDoc(DB, 'media'), readCheck(DB)]);
  const st = settings || {};
  const check = { v: 2, ...(before || {}) };
  const save = () => writeCheck(DB, check);
  let slow = 0;
  let pending = false;
  // steps 0: only what's kept is compared with what's saved now (Site Config, right after a save); nothing is read
  const light = steps === 0;
  const ein = einDigits(st.ein);
  // The IRS's list: SOARD's state as the IRS last had it, else the office's
  if (ein.length === 9 && !light) {
    const state = String(before?.irs?.record?.state || st.address?.state || 'GA').toUpperCase();
    const prev = before?.irs || {};
    const stale = force || prev.ein !== ein || prev.state !== state || !prev.readAt || now - Date.parse(prev.readAt) > IRS_AGAIN_MS || prev.error || prev.missedAt;
    const modified = stale ? '' : await irsModified(state, fetchImpl);
    if (stale || (modified && modified !== prev.modified)) {
      if (slow >= steps) pending = true;
      else {
        slow++;
        try {
          let { record, modified: lm } = await readIrsList(ein, state, { fetchImpl });
          // The EIN the IRS listed until now, missing from a list that read right: a second read decides it (Check
          // again reads it now; the heartbeat, next time), and the last reading stays meanwhile. A new EIN is answered
          // on the first read
          const listedBefore = prev.ein === ein && prev.found && !prev.missedAt;
          if (!record && listedBefore && force) ({ record, modified: lm } = await readIrsList(ein, state, { fetchImpl }));
          const listed = Date.parse(lm);
          const date = Number.isFinite(listed) ? dayText(listed) : '';
          if (record || !listedBefore || force) check.irs = { ein, state, found: !!record, record, modified: lm, date, readAt: iso(now) };
          else check.irs = { ...prev, state, missedAt: iso(now) };
        } catch (err) {
          // The last good reading stays; the trouble is said on Automations, and it's read again next time
          check.irs = { ...prev, error: String(err.message || err).slice(0, 200), errorAt: iso(now) };
        }
        await save();
      }
    }
  }
  // SOARD's W-9: when its file is new, was read by an older reading, or couldn't be read a day ago
  const w9 = await findW9(DB);
  if (!w9) check.w9 = null;
  else if (!light) {
    const was = check.w9?.fileId === w9.file.id ? check.w9 : null;
    const again = was && (!was.read?.isW9) && now - Date.parse(was.readAt || 0) > RETRY_MS;
    if (force || !was || was.reader !== W9_READER || again || was.trying) {
      if (slow >= steps) pending = true;
      else {
        slow++;
        const base = { fileId: w9.file.id, title: String(w9.doc.title || ''), reader: W9_READER };
        const tries = (was?.trying?.n || 0) + 1;
        if (tries > W9_TRIES) check.w9 = { ...base, readAt: iso(now), read: null, unreadable: `Reading it took too long ${W9_TRIES} times` };
        else {
          // Kept before it's read: a read cut off is counted, and given up on after a few
          check.w9 = { ...(was || base), ...base, trying: { n: tries, at: iso(now) } };
          await save();
          try {
            const read = await readW9(env, w9.file, st, { draw, known: { names: [check.irs?.record?.name].filter(Boolean) } });
            check.w9 = { ...base, readAt: iso(now), ...(read?.unreadable ? { read: null, unreadable: read.unreadable } : read?.isW9 ? { read } : { read: null, unreadable: 'Workers AI didn’t take it for a W-9' }) };
          } catch (err) {
            check.w9 = { ...base, readAt: iso(now), read: null, unreadable: String(err.message || err).slice(0, 200) };
          }
        }
        await save();
      }
    }
  }
  if (pending) {
    // This run's step is kept: the next tick goes on at once, rather than after the hold runs out
    check.pending = true;
    delete check.runningUntil;
    await save();
    return { ...check };
  }
  check.manual = await findManualMission(DB);
  const problems = problemsFor({ settings: st, media: media || {}, check });
  check.at = iso(now);
  check.pending = false;
  check.level = levelOf(problems);
  check.problems = problems.map((p) => ({ key: p.key, level: p.level, title: p.title }));
  // Slack: once for a new set of problems (a thread reply when it changes), ✅ only when everything was looked at
  if (slack) {
    const sig = sigOf(problems);
    if (sig && sig !== check.slackSig) {
      const posted = await slackIssue(env, ISSUE_KEY, problemCard(problems, check), { title: 'SOARD’s facts', kind: 'attention' }).catch(() => null);
      if (posted?.ok) check.slackSig = sig;
    } else if (!sig && check.slackSig && checkedAll(check, problems)) {
      await slackResolved(env, ISSUE_KEY, slackCard({ icon: '✅', title: 'SOARD’s facts match the IRS and its papers', lead: 'The legal name, the address, the W-9 and the mission all say the same now.' }), { summary: 'They match now.' }).catch(() => null);
      check.slackSig = '';
    }
  }
  delete check.runningUntil;
  await save();
  return { ...check, problemsFull: problems };
}

/**
 * Holds the check for one run (CLAIM_MS), only if nobody else holds it: the row is changed only where it's still
 * what was just read, so two ticks at once can't both run → the check as it was, or null when it's held
 */
async function claim(DB, now) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(CHECK_KEY).first();
  const before = parse(row?.data, null);
  if (before?.runningUntil && Date.parse(before.runningUntil) > now) return null;
  const held = JSON.stringify({ ...(before || {}), runningUntil: iso(now + CLAIM_MS) });
  const r = row
    ? await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND data = ?').bind(held, iso(now), CHECK_KEY, row.data).run()
    : await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(CHECK_KEY, held, iso(now)).run();
  return (r?.meta?.changes ?? r?.changes ?? 1) > 0 ? before || {} : null;
}

/** On the heartbeat: the check every 6 hours, one slow step a tick until it's done */
export async function maybeCheckOrgFacts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!env.DB) return null;
  try {
    const before = await readCheck(env.DB);
    if (before?.at && now - Date.parse(before.at) < EVERY_MS && !before.pending) return null;
    if (!(await claim(env.DB, now))) return null;
    try {
      return await checkOrgFacts(env, { now, fetchImpl, steps: 1 });
    } catch (err) {
      // Never stuck: the time is kept, so it's tried again in 6 hours, not every minute
      const c = (await readCheck(env.DB)) || {};
      await writeCheck(env.DB, { ...c, at: iso(now), pending: false, runningUntil: undefined, error: String(err.message || err).slice(0, 200) });
      throw err;
    }
  } catch (err) {
    console.error('[org-facts]', err.message);
    return null;
  }
}

/** For Automations: times and counts only */
export async function orgCheckFacts(DB) {
  const c = await readCheck(DB);
  if (!c) return { at: null };
  return {
    at: c.at || null,
    irsDate: c.irs?.date || '',
    irsFound: c.irs?.found ?? null,
    irsError: c.irs?.error || '',
    irsErrorAt: c.irs?.errorAt || null,
    irsReadAt: c.irs?.readAt || null,
    w9: c.w9 ? (c.w9.read?.isW9 ? 'read' : 'unreadable') : 'none',
    manual: !!c.manual,
    w9Unreadable: c.w9?.unreadable || '',
    level: c.level || 'ok',
    problems: (c.problems || []).map((p) => p.title),
  };
}

