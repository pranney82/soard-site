/**
 * The application limit: the most applications a season takes
 * ===========================================================================
 * Admin → Applications → Settings → Application limit. Three fields in the
 * `application` block of the site settings (saved with open/closed, see
 * saveApplicationSettings in ./_applications.js):
 *
 *   maxApplications  the limit (0 or blank: no limit)
 *   warnAt           when the team hears it's getting close (blank: 80% of the limit)
 *   fullMessage      what new families read once it's full (blank: the built-in words)
 *
 * Counted: applications sent through the website's form for the season,
 * leaving out test applications and ones whose data staff deleted. Checked
 * after every submit and on the heartbeat sweep (enforceApplicationCap):
 *
 *   at warnAt   one heads-up to the team in Slack (Good news) and by email (the
 *               staff list): how many are in, how many are left, how many
 *               families are partway through the form, and the pace
 *   at the max  applications close by themselves (logged as made by "limit")
 *               and the team hears the same way. Families who already started
 *               can still finish, as with any close, so the count can end a
 *               little over; the heads-up says how many are partway through.
 *
 * Opening again while the season is full is refused until the limit goes up
 * (or comes off). A scheduled opening that finds it full doesn't open, and the
 * team hears why (Needs attention). While closed and full, the Apply page and
 * the form show the full message instead of the closed one.
 *
 * Nothing here imports ./_applications.js: it calls in, not the other way.
 */

import { sendEmails, emailConfigured, isEmail, slackPost, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import * as mail from './_email-shell.js';
import { formFor } from './_application-forms.js';

export const CAP_USER = 'limit'; // who closed it, in the log and the "since" line
export const MAX_LIMIT = 10000;
const WARN_SHARE = 0.8;
const DAY_MS = 24 * 3600 * 1000;
const FILLING_DAYS = 14; // the Insights tab's "still working on it"
const TZ = 'America/New_York';
const SETTINGS_URL = `${SITE_ORIGIN}/admin/#applications/settings`;
const APPLICANTS_URL = `${SITE_ORIGIN}/admin/#applications`;

const iso = (t) => new Date(t).toISOString();
const num = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const nth = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${num(n)}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const timeOf = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const dayTimeOf = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

// ─── The numbers ────────────────────────────────────────────────────

/** A whole number from 1 to `max`, else 0 */
export function wholeNumber(v, max = MAX_LIMIT) {
  const t = String(v ?? '').replace(/,/g, '').trim();
  const n = t ? Number(t) : 0;
  return Number.isInteger(n) && n > 0 && n <= max ? n : 0;
}

export const defaultWarnAt = (max) => Math.max(1, Math.floor(max * WARN_SHARE));

/** The limit and the heads-up point as the site uses them: { max, warnAt, custom } (max 0 = no limit) */
export function capOf(a = {}) {
  const max = wholeNumber(a?.maxApplications);
  if (!max) return { max: 0, warnAt: 0, custom: false };
  const set = wholeNumber(a?.warnAt);
  return set && set < max ? { max, warnAt: set, custom: true } : { max, warnAt: defaultWarnAt(max), custom: false };
}

export const defaultFullMessage = (year) => `We’ve received all the applications we can take for ${year}.`;
export const fullMessageOf = (a) => String(a?.fullMessage || '').trim() || defaultFullMessage(a?.year);

/**
 * Families' applications in for the season (not tests, not deleted), optionally only
 * those since an ISO time. Organizations' applications run outside the limit.
 */
export async function countReceived(DB, year, { since = null } = {}) {
  const count = async (families) => {
    const sql = `SELECT COUNT(*) AS n FROM applications WHERE year = ? AND COALESCE(is_test, 0) = 0 AND deleted_at IS NULL${families ? " AND COALESCE(kind, 'family') = 'family'" : ''}${since ? ' AND submitted_at >= ?' : ''}`;
    const row = await DB.prepare(sql).bind(...[String(year), ...(since ? [since] : [])]).first();
    return Number(row?.n) || 0;
  };
  try {
    return await count(true);
  } catch {
    // Before the kind column exists, every application is a family's
    try { return await count(false); } catch { return 0; }
  }
}

/** Families partway through the form for the season: not sent, not stopped, touched in the last 14 days */
export async function countFilling(DB, year, now = Date.now()) {
  const count = async (families) => {
    const row = await DB.prepare(`SELECT COUNT(*) AS n FROM application_drafts WHERE year = ? AND submitted_id IS NULL AND cleared_at IS NULL
      AND stop_key IS NULL AND updated_at >= ? AND COALESCE(ip_hash, '') != 'admin'${families ? " AND COALESCE(kind, 'family') = 'family'" : ''}`).bind(String(year), iso(now - FILLING_DAYS * DAY_MS)).first();
    return Number(row?.n) || 0;
  };
  try {
    return await count(true);
  } catch {
    try { return await count(false); } catch { return 0; }
  }
}

/**
 * Families on the Applicants board for the season who didn't come through the
 * website's form (added in JobTread), so the admin can say they don't count.
 * The mirror (./_applicants.js) may not exist yet: 0.
 */
export async function countAddedInJobTread(DB, year) {
  try {
    const row = await DB.prepare(`SELECT COUNT(*) AS n FROM applicants a WHERE a.year = ? AND a.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM applications p WHERE p.jt_account_id = a.account_id)`).bind(String(year)).first();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

/**
 * Where the season stands against its limit. `a` is the picked `application`
 * block; `openedAt` (when it last opened) keeps the pace honest in its first week.
 * → { year, max, warnAt, customWarn, received, left, filling, perDay, fillsInDays, full, percent, addedInJobTread? }
 *   (max 0: no limit; the counts are still there, for choosing one). `board`
 *   (the admin) also counts the season's families added in JobTread.
 */
export async function capFacts(DB, a, { now = Date.now(), openedAt = null, board = false } = {}) {
  const { max, warnAt, custom } = capOf(a);
  const year = String(a.year);
  const opened = a.open && openedAt ? Date.parse(openedAt) : NaN;
  const from = Math.max(now - 7 * DAY_MS, Number.isFinite(opened) ? opened : 0);
  const [received, filling, recent, addedInJobTread] = await Promise.all([
    countReceived(DB, year), countFilling(DB, year, now), countReceived(DB, year, { since: iso(from) }),
    board ? countAddedInJobTread(DB, year) : null,
  ]);
  // Three in the window before a pace means anything
  const perDay = recent >= 3 ? recent / Math.max(1, (now - from) / DAY_MS) : null;
  const left = max ? Math.max(0, max - received) : null;
  return {
    year, max, warnAt, customWarn: custom, received, left, filling,
    perDay: perDay == null ? null : Math.round(perDay * 10) / 10,
    fillsInDays: perDay && left ? Math.round((left / perDay) * 10) / 10 : null,
    full: !!max && received >= max,
    percent: max ? Math.min(100, Math.round((received / max) * 100)) : null,
    ...(board ? { addedInJobTread } : {}),
  };
}

/** Closed with the season at its limit: the pages show the full message (one count, only while closed with a limit) */
export async function seasonFull(DB, a, year) {
  const { max } = capOf(a);
  if (!max || a?.open === true) return false;
  return (await countReceived(DB, year)) >= max;
}

/**
 * The heads-up goes once per point: claimed in application_runtime (made by
 * ./_applications.js ensureSchema). A higher point (the limit went up) claims
 * again. → true for the one caller that should send it.
 */
export async function claimWarning(DB, year, warnAt, now = Date.now()) {
  const key = `cap-warned:${year}`;
  try {
    const ins = await DB.prepare('INSERT OR IGNORE INTO application_runtime (key, value, updated_at) VALUES (?, ?, ?)').bind(key, String(warnAt), iso(now)).run();
    if (ins?.meta?.changes > 0) return true;
    const upd = await DB.prepare('UPDATE application_runtime SET value = ?, updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) < ?').bind(String(warnAt), iso(now), key, warnAt).run();
    return upd?.meta?.changes > 0;
  } catch {
    return false;
  }
}

/** What the last limit notice was, for the admin's maps: { kind, year, at, received, max } or null */
export async function lastCapNotice(DB) {
  try {
    const row = await DB.prepare("SELECT value FROM application_runtime WHERE key = 'cap-notice'").first();
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

// ─── Words ──────────────────────────────────────────────────────────

/** "about 6 a day this week" / "about 3 a week", or null without a pace */
export function paceWords(f) {
  if (!f?.perDay) return null;
  return f.perDay >= 1 ? `about ${num(Math.round(f.perDay))} a day this week` : `about ${num(Math.max(1, Math.round(f.perDay * 7)))} a week`;
}

/** "in about 3 days", or null when there's no pace or it's months off */
export function fillsInWords(f) {
  const d = f?.fillsInDays;
  if (!d || f.full || d > 90) return null;
  return d < 1 ? 'within a day' : d < 1.5 ? 'in about a day' : `in about ${num(Math.round(d))} days`;
}

const fillingWords = (n) => `${plural(n, 'family is', 'families are')} partway through the form`;

function factRows(f, { full = false } = {}) {
  const pace = paceWords(f);
  const fills = fillsInWords(f);
  return [
    ['In so far', `${num(f.received)} of ${num(f.max)}`],
    full ? null : ['Left', num(f.left)],
    f.filling ? ['Still filling it out', `${plural(f.filling, 'family', 'families')}${full ? ' can still finish and send theirs' : ''}`] : null,
    !full && pace ? ['Pace', `${pace}${fills ? `, so it fills ${fills}` : ''}`] : null,
  ].filter(Boolean);
}

function leadOf(kind, f, extra) {
  if (kind === 'warn') {
    return `${num(f.left)} more until the limit. When the ${nth(f.max)} one comes in, applications close by themselves.`
      + (f.filling ? ` ${fillingWords(f.filling)} right now, and families who already started can still finish after it closes.` : '');
  }
  if (kind === 'full') {
    const when = timeOf(extra.at || Date.now());
    return (f.received === f.max
      ? `The ${nth(f.max)} application came in, so applications closed by themselves at ${when}.`
      : `${num(f.received)} applications are in and the limit is ${num(f.max)}, so applications closed by themselves at ${when}.`)
      + ` New families now see: “${extra.message || defaultFullMessage(f.year)}”`;
  }
  return `They were set to open ${extra.opensAt ? dayTimeOf(Date.parse(extra.opensAt)) : 'now'}, but the ${f.year} limit of ${num(f.max)} is already reached (${num(f.received)} in), so they stayed closed.`;
}

const TITLES = {
  warn: (f) => `${num(f.received)} of ${num(f.max)} applications are in for ${f.year}`,
  full: (f) => `Applications are closed for ${f.year}: the limit of ${num(f.max)} is reached`,
  blocked: () => 'Applications didn’t open on schedule',
};
const FIXES = {
  warn: 'To take more, raise the limit in Applications → Settings.',
  full: 'To take more, raise the limit in Applications → Settings and open applications again.',
  blocked: 'Raise the limit in Applications → Settings, then open applications.',
};
const ICONS = { warn: '📝', full: '📪', blocked: '⚠️' };

const TEST_WORDS = 'Test · a sample season; applications weren’t touched';

/** The Slack post. kind: 'warn' | 'full' | 'blocked'; extra: { at, message, opensAt, test } */
export function capCard(kind, f, extra = {}) {
  return slackCard({
    icon: ICONS[kind],
    title: TITLES[kind](f),
    test: extra.test ? TEST_WORDS : null,
    lead: leadOf(kind, f, extra),
    facts: factRows(f, { full: kind !== 'warn' }),
    fix: FIXES[kind],
    buttons: [{ label: 'Open Applications settings', url: SETTINGS_URL }, { label: 'See the applicants', url: APPLICANTS_URL }],
    footer: 'Application limit',
  });
}

/** The same notice as an email to the staff list */
export function capEmail(kind, f, extra = {}) {
  const title = TITLES[kind](f);
  const lead = leadOf(kind, f, extra);
  const rows = factRows(f, { full: kind !== 'warn' });
  const html = mail.emailShell({
    preheader: lead.split('. ')[0],
    eyebrow: extra.test ? TEST_WORDS : `Application limit · ${f.year} season`,
    heading: title,
    intro: mail.esc(lead),
    bodyHtml: mail.panel(`<div style="margin:0 0 12px;">${mail.progress(f.percent)}</div>${mail.facts(rows.map(([k, v]) => [k, mail.esc(v)]))}`, { accent: kind !== 'blocked' })
      + `<p class="ink" style="margin:4px 0 14px;font-family:${mail.SANS};font-size:14px;line-height:21px;">${mail.esc(FIXES[kind])}</p>`
      + `<div>${mail.button('Open Applications settings', SETTINGS_URL, 'primary')}${mail.button('See the applicants', APPLICANTS_URL, 'outline')}</div>`,
    footerHtml: `It goes to the staff list in ${mail.link('Applications settings', SETTINGS_URL)}, and the same words post in Slack.`,
  });
  const text = `${title}\n\n${lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${FIXES[kind]}\n\nApplications settings: ${SETTINGS_URL}\nApplicants: ${APPLICANTS_URL}`;
  return { subject: `${extra.test ? '[TEST] ' : ''}${title}`, html, text: `${extra.test ? `${TEST_WORDS}\n\n` : ''}${text}` };
}

/**
 * Tell the team: Slack (the heads-up and the close are good news; a skipped
 * opening needs attention) and email to the staff list. Never throws.
 * extra.test: a sample, marked as a test, to Needs attention and SELF_TEST_TO only.
 * → { slack, email }
 */
export async function tellCap(env, kind, f, extra = {}) {
  let to = SELF_TEST_TO;
  if (!extra.test) {
    try { to = (await formFor(env.DB, { year: f.year })).staffEmails || []; } catch { to = []; }
  }
  to = [...new Set(to.filter(isEmail))];
  const [email, slack] = await Promise.all([
    to.length && emailConfigured(env)
      ? sendEmails(env, { to, ...capEmail(kind, f, extra), tags: [{ name: 'type', value: 'application-limit' }] }).catch(e => ({ sent: 0, failed: to.length, errors: [e.message] }))
      : null,
    slackPost(env, capCard(kind, f, extra), { kind: kind === 'blocked' || extra.test ? 'attention' : 'news', area: 'applications' }).catch(e => ({ ok: false, error: e.message })),
  ]);
  if (extra.test) return { slack, email };
  const at = iso(extra.at || Date.now());
  await env.DB?.prepare("INSERT OR REPLACE INTO application_runtime (key, value, updated_at) VALUES ('cap-notice', ?, ?)")
    .bind(JSON.stringify({ kind, year: f.year, at, received: f.received, max: f.max }), at).run().catch(() => {});
  return { slack, email };
}

// ─── The self-test ──────────────────────────────────────────────────

/**
 * Change CAP_SELF_TEST to have production prove the notices once more. On
 * the next heartbeat (./broadcast-hooks.js) the site sends the real heads-up
 * and the real "closed" notice for a sample season through tellCap, marked
 * as tests: two posts in the Needs attention channel, as they'd look, and
 * the two emails to Peter. Applications and settings aren't touched. What
 * Slack and Resend said is kept in application_runtime 'cap-self-test:<id>'.
 * No admin button: nobody has to press anything.
 */
export const CAP_SELF_TEST = '2026-10-21';
export const SELF_TEST_TO = ['peter@soardcharity.com'];

export async function maybeCapSelfTest(env, { now = Date.now() } = {}) {
  if (!env.DB || !(env.SLACK_BOT_TOKEN || env.SLACK_WEBHOOK_URL)) return null;
  const key = `cap-self-test:${CAP_SELF_TEST}`;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS application_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run();
    const claimed = await env.DB.prepare('INSERT OR IGNORE INTO application_runtime (key, value, updated_at) VALUES (?, ?, ?)').bind(key, '{"step":"running"}', iso(now)).run();
    if (!(claimed?.meta?.changes > 0)) return null;
  } catch {
    return null;
  }
  // The season the settings name (the same rule as cleanYear: next year when it's unset)
  let year = String(new Date(now).getUTCFullYear() + 1);
  try {
    const stored = JSON.parse((await env.DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first())?.data || '{}')?.application?.year;
    if (/^\d{4}$/.test(String(stored || ''))) year = String(stored);
  } catch { /* next year */ }
  const base = { year, max: 120, warnAt: 96, customWarn: false, filling: 9 };
  const warn = { ...base, received: 96, left: 24, perDay: 4, fillsInDays: 6, full: false, percent: 80 };
  const full = { ...base, received: 120, left: 0, perDay: null, fillsInDays: null, full: true, percent: 100 };
  const a = await tellCap(env, 'warn', warn, { at: now, test: true });
  const b = await tellCap(env, 'full', full, { at: now, test: true, message: defaultFullMessage(year) });
  const result = {
    id: CAP_SELF_TEST, at: iso(now),
    posts: [a.slack, b.slack].map(s => ({ ok: !!s?.ok, channel: s?.channel || null, ts: s?.ts || null, error: s?.ok ? null : s?.error || null })),
    emails: [a.email, b.email].map(e => (e ? { sent: e.sent || 0, error: e.errors?.[0] || null } : { sent: 0, error: 'email not set up' })),
  };
  await env.DB.prepare('UPDATE application_runtime SET value = ?, updated_at = ? WHERE key = ?').bind(JSON.stringify(result), iso(now), key).run().catch(() => {});
  return result;
}
