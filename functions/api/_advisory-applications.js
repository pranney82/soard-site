/**
 * Advisory Board applications (Oct 2026)
 * ===========================================================================
 * Peter, Oct 22 2026: "we need to convert the jotform for advisory too". The
 * site's own application (/advisory-board/apply/, ./advisory-apply.js)
 * replaced the Jotform one. Each application is kept here (D1
 * advisory_applications). The applicant gets a copy of what they sent, and
 * staff hear about it by email (the list in the admin) and in Slack.
 *
 * Admin → People → Applications works through them
 * (./advisory-applications-admin.js): where each one stands, notes, and Add
 * as an advisor (a hidden draft on People → Advisory, with their private
 * email). The applications sent to Jotform come in once, from the Jotform
 * backfill's copy (./_jotform-backfill.js); anyone who's already on People →
 * Advisory is marked Joined.
 *
 * A name starting with TEST is a test, as on the makeover form: the staff
 * email goes only to the address on the application (the tester), Slack
 * marks it 🧪, the admin tags it, and it never counts as New.
 */

import { ADVISORY_FIELDS, checkAnswers, answerSections, JOTFORM_FIELDS, OVERVIEW_PDF, EMAIL_RE } from './_advisory-form.js';
import { sendEmails, SITE_ORIGIN, slackPost } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import * as mail from './_email-shell.js';

export const STATUSES = [
  { id: 'new', label: 'New' },
  { id: 'talking', label: 'In conversation' },
  { id: 'joined', label: 'Joined' },
  { id: 'not-now', label: 'Not now' },
];
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));
export const DEFAULT_STAFF_EMAILS = ['info@soardcharity.com'];
export const adminUrl = (id) => `${SITE_ORIGIN}/admin/#advisory-applications${id ? `/${id}` : ''}`;
const iso = (t = Date.now()) => new Date(t).toISOString();
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
export const isApplicationId = (s) => /^adv-[0-9a-z-]{8,40}$/.test(String(s || ''));
const newId = () => `adv-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
/** A test application: the full name starts with TEST, like the makeover form's test families */
export const isTestApplication = (nameOrAnswers) => /^\s*test\b/i.test(typeof nameOrAnswers === 'string' ? nameOrAnswers : nameOrAnswers?.fullName || '');
const TEST_LABEL = 'Test application · not a real applicant';
const firstName = (a) => String(a?.preferredName || a?.fullName || '').trim().split(/\s+/)[0] || '';
const normalizeName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS advisory_applications (
    id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'site', source_id TEXT,
    name TEXT NOT NULL, email TEXT, phone TEXT, company TEXT, job_title TEXT,
    answers TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', status_at TEXT, status_by TEXT,
    notes TEXT, person_slug TEXT, ip_hash TEXT, notified TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_advisory_source ON advisory_applications(source, source_id)',
  'CREATE INDEX IF NOT EXISTS idx_advisory_created ON advisory_applications(created_at)',
  'CREATE TABLE IF NOT EXISTS advisory_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL, updated_by TEXT)',
];
const _ready = new WeakSet();
export async function ensureAdvisorySchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

function fromRow(r, { full = false } = {}) {
  if (!r) return null;
  const answers = parse(r.answers, {});
  const out = {
    id: r.id, source: r.source, name: r.name, email: r.email, phone: r.phone, company: r.company, jobTitle: r.job_title,
    status: STATUS_IDS.has(r.status) ? r.status : 'new', statusAt: r.status_at, statusBy: r.status_by,
    personSlug: r.person_slug, createdAt: r.created_at, updatedAt: r.updated_at,
    link: answers.link || null, preferredName: answers.preferredName || null,
    notes: parse(r.notes, []).length,
    isTest: isTestApplication(r.name),
    // One line for the list: why they want to serve
    why: String(answers.why || '').replace(/\s+/g, ' ').slice(0, 220),
  };
  if (full) {
    out.answers = answers;
    out.sections = answerSections(answers);
    out.notes = parse(r.notes, []);
    out.notified = parse(r.notified, null);
  }
  return out;
}

// ─── Settings: who hears about a new application ─────────────────────

export async function getAdvisorySettings(DB) {
  await ensureAdvisorySchema(DB);
  const row = await DB.prepare("SELECT value, updated_at, updated_by FROM advisory_settings WHERE key = 'staffEmails'").first();
  const list = parse(row?.value, null);
  return { staffEmails: Array.isArray(list) ? list : DEFAULT_STAFF_EMAILS, updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null, isDefault: !Array.isArray(list) };
}

/** Save the staff list: { settings } or { problems } */
export async function saveAdvisorySettings(DB, { staffEmails }, { by = null, now = Date.now() } = {}) {
  await ensureAdvisorySchema(DB);
  const list = [...new Set((Array.isArray(staffEmails) ? staffEmails : String(staffEmails || '').split(/[\s,;]+/)).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter((e) => !EMAIL_RE.test(e));
  if (bad.length) return { problems: { staffEmails: `${bad.join(', ')} ${bad.length === 1 ? 'isn’t an email address' : 'aren’t email addresses'}.` } };
  if (!list.length) return { problems: { staffEmails: 'Add at least one email, or nobody hears about new applications.' } };
  if (list.length > 20) return { problems: { staffEmails: 'That’s more than 20 people. Use a group address instead.' } };
  await DB.prepare("INSERT INTO advisory_settings (key, value, updated_at, updated_by) VALUES ('staffEmails', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
    .bind(JSON.stringify(list), iso(now), by).run();
  return { settings: await getAdvisorySettings(DB) };
}

// ─── A new application ──────────────────────────────────────────────

/**
 * Store one from the site's form. The answers are checked here too (the page
 * checks first). A second send of the same answers within ten minutes (a
 * double tap, a flaky connection) is the same application.
 * Returns { app } or { problems }.
 */
export async function submitApplication(env, raw, { ipHash = null, now = Date.now() } = {}) {
  const { DB } = env;
  await ensureAdvisorySchema(DB);
  const { answers, problems } = checkAnswers(raw);
  if (Object.keys(problems).length) return { problems };
  const json = JSON.stringify(answers);
  const again = await DB.prepare("SELECT * FROM advisory_applications WHERE source = 'site' AND email = ? AND answers = ? AND created_at > ?")
    .bind(answers.email, json, iso(now - 10 * 60 * 1000)).first();
  if (again) return { app: fromRow(again, { full: true }), repeat: true };
  const id = newId();
  await DB.prepare(`INSERT INTO advisory_applications (id, source, name, email, phone, company, job_title, answers, status, ip_hash, created_at, updated_at)
    VALUES (?, 'site', ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`)
    .bind(id, answers.fullName, answers.email, answers.phone || null, answers.company || null, answers.jobTitle || null, json, ipHash, iso(now), iso(now)).run();
  return { app: fromRow(await DB.prepare('SELECT * FROM advisory_applications WHERE id = ?').bind(id).first(), { full: true }) };
}

/** The applicant's copy: thanks, what happens next, and everything they sent */
export function applicantEmail(app) {
  const first = firstName(app.answers);
  const sections = answerSections(app.answers);
  const qa = sections.map((s) => `<div style="font-family:${mail.SERIF};font-size:16px;font-weight:700;margin:18px 0 6px;" class="ink">${mail.esc(s.title)}</div>`
    + s.items.map((it) => `<div style="font-family:${mail.SANS};font-size:13px;color:${mail.MUTED};margin-top:10px;" class="muted">${mail.esc(it.label)}</div>`
      + `<div style="font-family:${mail.SANS};font-size:15px;line-height:1.55;white-space:pre-line;" class="ink">${mail.esc(it.value)}</div>`).join('')).join('');
  const html = mail.emailShell({
    preheader: 'We have your application. Here’s a copy of what you sent.',
    eyebrow: 'Advisory Board application',
    heading: first ? `Thank you, ${first}` : 'Thank you for applying',
    intro: 'We have your application to join the Sunshine on a Ranney Day Advisory Board. We review applications on a rolling basis and will be in touch soon. A copy of what you sent is below.',
    bodyHtml: mail.panel(qa) + `<div style="font-family:${mail.SANS};font-size:13px;margin-top:14px;">${mail.link('The Advisory Board overview (PDF)', OVERVIEW_PDF)}</div>`,
    footerHtml: 'Questions? Write to info@soardcharity.com.',
  });
  const text = [`Thank you${first ? `, ${first}` : ''}.`, '', 'We have your application to join the Sunshine on a Ranney Day Advisory Board. We review applications on a rolling basis and will be in touch soon.', '',
    ...sections.flatMap((s) => [`${s.title.toUpperCase()}`, ...s.items.map((it) => `${it.label}\n${it.value}\n`)]),
    `The Advisory Board overview: ${OVERVIEW_PDF}`, 'Questions? Write to info@soardcharity.com.'].join('\n');
  return { subject: 'We have your Advisory Board application', html, text };
}

const yesNoFacts = (a) => [
  ['Four meetings a year', a.meetings],
  ['Makes introductions', a.introductions],
  ['Would host an event', a.hostEvent],
  ['Conflict of interest', a.conflict === 'Yes' ? `Yes${a.conflictMore ? `: ${a.conflictMore}` : ''}` : a.conflict],
];

/** Staff's heads-up: who applied, the key answers, and where to read it all */
export function staffEmail(app) {
  const a = app.answers;
  const work = [a.jobTitle, a.company].filter(Boolean).join(', ');
  const rows = [
    ['Email', a.email ? mail.link(a.email, `mailto:${a.email}`) : null],
    ['Phone', a.phone ? mail.esc(a.phone) : null],
    ['Work', work ? mail.esc(work) : null],
    ['Online', a.link ? mail.link(a.link.replace(/^https?:\/\/(www\.)?/, ''), a.link) : null],
    ['Heard about us', a.heardFrom ? mail.esc(a.heardFrom) : null],
    ...yesNoFacts(a).map(([k, v]) => [k, v ? mail.esc(v) : null]),
    ['Reference', a.refName ? mail.esc([a.refName, a.refRelationship].filter(Boolean).join(', ')) : null],
  ];
  const why = a.why ? `<div style="font-family:${mail.SANS};font-size:13px;color:${mail.MUTED};margin:16px 0 4px;" class="muted">Why they want to serve</div>${mail.paragraphs(a.why)}` : '';
  const html = mail.emailShell({
    preheader: `${work || 'A new applicant'}. Read it and reply from the admin.`,
    eyebrow: isTestApplication(a) ? TEST_LABEL : 'New Advisory Board application',
    heading: `${a.fullName} applied to the Advisory Board`,
    intro: 'It came in through the website. They have a copy of what they sent.',
    bodyHtml: mail.panel(mail.facts(rows) + why)
      + `<div style="margin-top:16px;">${mail.button('Read the application', adminUrl(app.id), 'primary')}</div>`,
    footerHtml: `This has their contact details, so please keep it inside SOARD. It goes to the list in ${mail.link('People → Applications', adminUrl())}.`,
  });
  const text = `${a.fullName} applied to the Advisory Board.\n\n${[['Email', a.email], ['Phone', a.phone], ['Work', work], ['Heard about us', a.heardFrom], ...yesNoFacts(a)]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nRead the application: ${adminUrl(app.id)}`;
  return { subject: `${isTestApplication(a) ? '[TEST] ' : ''}New Advisory Board application: ${a.fullName}`, html, text };
}

/** The same heads-up for Slack, without contact details */
export function staffSlack(app) {
  const a = app.answers;
  return slackCard({
    icon: '🤝',
    title: `Advisory Board application: ${a.fullName}`,
    test: isTestApplication(a) ? TEST_LABEL : null,
    lead: [a.jobTitle, a.company].filter(Boolean).join(', ') || null,
    facts: [['Heard about us', a.heardFrom], ...yesNoFacts(a)],
    buttons: [{ label: 'Read the application', url: adminUrl(app.id) }],
    footer: 'From the Apply page on the Advisory Board page',
  });
}

/** Tell the applicant and staff; records what went where. Never throws. */
export async function notifyNew(env, app, { now = Date.now() } = {}) {
  const out = { applicant: false, staff: 0, slack: false };
  try {
    const mine = applicantEmail(app);
    const r = await sendEmails(env, { to: [app.answers.email], ...mine, tags: [{ name: 'kind', value: 'advisory-application' }] });
    out.applicant = r.sent > 0;
  } catch { /* recorded below */ }
  try {
    // A test's staff email goes to the tester, never the staff list
    const to = isTestApplication(app.answers) ? [app.answers.email] : (await getAdvisorySettings(env.DB)).staffEmails;
    const r = await sendEmails(env, { to, ...staffEmail(app), tags: [{ name: 'kind', value: 'advisory-application-staff' }] });
    out.staff = r.sent;
  } catch { /* recorded below */ }
  try {
    const r = await slackPost(env, staffSlack(app), { kind: 'news' });
    out.slack = !!(r?.ok ?? r);
  } catch { /* recorded below */ }
  try {
    await env.DB.prepare('UPDATE advisory_applications SET notified = ? WHERE id = ?').bind(JSON.stringify({ ...out, at: iso(now) }), app.id).run();
  } catch { /* best effort */ }
  return out;
}

// ─── The admin ──────────────────────────────────────────────────────

export async function listAdvisoryApplications(DB) {
  await ensureAdvisorySchema(DB);
  const { results } = await DB.prepare('SELECT * FROM advisory_applications ORDER BY created_at DESC').all();
  return (results || []).map((r) => fromRow(r));
}

export async function getAdvisoryApplication(DB, id) {
  await ensureAdvisorySchema(DB);
  return fromRow(await DB.prepare('SELECT * FROM advisory_applications WHERE id = ?').bind(id).first(), { full: true });
}

export async function countNew(DB) {
  await ensureAdvisorySchema(DB);
  return (await DB.prepare("SELECT count(*) AS n FROM advisory_applications WHERE status = 'new' AND upper(name) NOT LIKE 'TEST%'").first('n')) || 0;
}

export async function setAdvisoryStatus(DB, id, status, { by = null, now = Date.now() } = {}) {
  if (!STATUS_IDS.has(status)) throw Object.assign(new Error('Unknown status'), { status: 400 });
  await ensureAdvisorySchema(DB);
  const r = await DB.prepare('UPDATE advisory_applications SET status = ?, status_at = ?, status_by = ?, updated_at = ? WHERE id = ?').bind(status, iso(now), by, iso(now), id).run();
  if (!r?.meta?.changes) throw Object.assign(new Error('Not found'), { status: 404 });
  return getAdvisoryApplication(DB, id);
}

export async function addAdvisoryNote(DB, id, text, { by = null, now = Date.now() } = {}) {
  const t = String(text || '').trim().slice(0, 4000);
  if (!t) throw Object.assign(new Error('Write the note first'), { status: 400 });
  const app = await getAdvisoryApplication(DB, id);
  if (!app) throw Object.assign(new Error('Not found'), { status: 404 });
  const notes = [...app.notes, { at: iso(now), by, text: t }];
  await DB.prepare('UPDATE advisory_applications SET notes = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(notes), iso(now), id).run();
  return getAdvisoryApplication(DB, id);
}

/** They're on People → Advisory now (Add as an advisor, or linked by hand): Joined */
export async function linkAdvisor(DB, id, slug, { by = null, now = Date.now() } = {}) {
  if (!/^[a-z0-9-]{1,80}$/.test(String(slug || ''))) throw Object.assign(new Error('Bad person'), { status: 400 });
  await ensureAdvisorySchema(DB);
  const r = await DB.prepare("UPDATE advisory_applications SET person_slug = ?, status = 'joined', status_at = ?, status_by = ?, updated_at = ? WHERE id = ?")
    .bind(slug, iso(now), by, iso(now), id).run();
  if (!r?.meta?.changes) throw Object.assign(new Error('Not found'), { status: 404 });
  return getAdvisoryApplication(DB, id);
}

/** Their data leaves the site (a person asked, or it was a test) */
export async function deleteAdvisoryApplication(DB, id) {
  await ensureAdvisorySchema(DB);
  const r = await DB.prepare('DELETE FROM advisory_applications WHERE id = ?').bind(id).run();
  return !!r?.meta?.changes;
}

// ─── The Jotform applications, brought in once ──────────────────────

/** A Jotform answer as plain words */
function jotformValue(q) {
  const a = q?.answer;
  if (a == null || a === '') return '';
  if (q.type === 'control_fullname' && typeof a === 'object') return [a.prefix, a.first, a.middle, a.last, a.suffix].filter(Boolean).join(' ');
  if (q.type === 'control_phone' && typeof a === 'object') return a.full || [a.area, a.phone].filter(Boolean).join(' ');
  if (q.type === 'control_address' && typeof a === 'object') return [a.addr_line1, a.addr_line2, [a.city, a.state].filter(Boolean).join(', '), a.postal].filter(Boolean).join('\n');
  if ((q.type === 'control_datetime' || q.type === 'control_birthdate') && typeof a === 'object') {
    return a.year && a.month && a.day ? `${a.year}-${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')}` : (q.prettyFormat || '');
  }
  if (q.type === 'control_signature') return 'Signed on Jotform';
  if (Array.isArray(a)) return a.filter(Boolean).join(', ');
  if (typeof a === 'object') return q.prettyFormat ? String(q.prettyFormat).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : Object.values(a).filter(Boolean).join(' ');
  return String(a).trim();
}

/** A Jotform submission's answers in this form's ids (what doesn't map is kept under its question) */
export function fromJotform(answers) {
  const out = {};
  const extra = [];
  for (const q of Object.values(answers || {})) {
    const text = String(q?.text || '').replace(/<[^>]+>/g, '').trim();
    const value = jotformValue(q);
    if (!text || !value || /^(control_head|control_text|control_button|control_pagebreak|control_image)$/.test(q.type || '')) continue;
    const hit = JOTFORM_FIELDS.find(([re]) => re.test(text));
    if (!hit) { extra.push(`${text}\n${value}`); continue; }
    const [, id] = hit;
    const field = ADVISORY_FIELDS.find((f) => f.id === id);
    if (field?.type === 'check') out[id] = !!value;
    else if (field?.type === 'choice') out[id] = field.options.find((o) => o.toLowerCase() === value.toLowerCase()) || value;
    else out[id] = value;
  }
  if (extra.length) out.anythingElse = [out.anythingElse, ...extra].filter(Boolean).join('\n\n');
  return out;
}

/**
 * The Advisory Board applications the Jotform backfill copied, here once each.
 * Someone already on People → Advisory (by name) is Joined and linked.
 * Returns how many came in. Safe to call on every visit to the admin.
 */
export async function importJotformApplications(DB, { now = Date.now() } = {}) {
  await ensureAdvisorySchema(DB);
  let rows;
  try {
    ({ results: rows } = await DB.prepare(`SELECT b.submission_id, b.answers, b.submitted_at FROM jotform_backfill b
      WHERE b.kind = 'advisory' AND b.answers IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM advisory_applications a WHERE a.source = 'jotform' AND a.source_id = b.submission_id)`).all());
  } catch { return 0; } // no backfill table
  if (!rows?.length) return 0;
  let advisors = [];
  try {
    const { results } = await DB.prepare('SELECT slug, data FROM team').all();
    advisors = (results || []).map((r) => ({ slug: r.slug, data: parse(r.data, {}) })).filter((t) => t.data.group === 'advisory');
  } catch { /* no team table (tests) */ }
  const stmts = [];
  for (const r of rows) {
    const saved = parse(r.answers, {});
    const answers = fromJotform(saved.answers);
    if (!answers.fullName) continue;
    const words = normalizeName(answers.fullName).split(' ');
    const match = advisors.filter((t) => { const tw = normalizeName(t.data.name).split(' ').filter(Boolean); return tw.length > 1 && tw.every((w) => words.includes(w)); });
    const person = match.length === 1 ? match[0].slug : null;
    const created = saved.createdAt || r.submitted_at;
    const at = created ? new Date(`${String(created).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(created) ? '' : 'Z'}`) : new Date(now);
    const when = Number.isNaN(at.getTime()) ? iso(now) : at.toISOString();
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO advisory_applications (id, source, source_id, name, email, phone, company, job_title, answers, status, status_at, status_by, person_slug, created_at, updated_at)
      VALUES (?, 'jotform', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), r.submission_id, answers.fullName, answers.email || null, answers.phone || null, answers.company || null, answers.jobTitle || null, JSON.stringify(answers),
        person ? 'joined' : 'new', person ? iso(now) : null, person ? 'Already on People → Advisory' : null, person, when, iso(now)));
  }
  if (stmts.length) await DB.batch(stmts);
  return stmts.length;
}

/** For Site → Automations: how many, how many New, and the last one (counts and times only) */
export async function advisoryFacts(DB) {
  await ensureAdvisorySchema(DB);
  const row = await DB.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN status = 'new' AND upper(name) NOT LIKE 'TEST%' THEN 1 ELSE 0 END) AS fresh,
      sum(CASE WHEN source = 'jotform' THEN 1 ELSE 0 END) AS jotform,
      max(CASE WHEN source = 'site' THEN created_at END) AS last_at
    FROM advisory_applications`).first();
  const last = await DB.prepare("SELECT notified FROM advisory_applications WHERE source = 'site' ORDER BY created_at DESC LIMIT 1").first('notified');
  const n = parse(last, null);
  return { total: row?.total || 0, new: row?.fresh || 0, fromJotform: row?.jotform || 0, lastAt: row?.last_at || null, lastNotified: n ? { applicant: !!n.applicant, staff: n.staff || 0, slack: !!n.slack } : null };
}
