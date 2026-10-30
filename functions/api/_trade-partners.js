/**
 * Trade partners: a vendor's own page on the site
 * ===========================================================================
 * /trade-partners/ tells a contractor what working with SOARD is like and
 * lets one in; /trade-partners/account/ is their own page (./trade-partner.js
 * and ./vendor-docs.js answer it). JobTread stays the record for everything
 * a vendor tells us:
 *   - company: the vendor account's name, its Trades, Address and License
 *     fields, and its contacts (the main one, "Billing", "Insurance agent")
 *   - W-9: signed on the page (./_w9-form.js) or uploaded, filed like any
 *     other (./_vendors.js) and put on their Mercury recipient for the 1099
 *   - insurance: uploaded, or asked of their agent, who gets a link of their
 *     own that can add a certificate and nothing else
 *   - bank account: straight onto the vendor's Mercury recipient through the
 *     relay. The site keeps only the last four digits and whether someone at
 *     SOARD has confirmed it by phone; a bill for that vendor waits until
 *     they have (bankHold, read by ./_bill-pay.js)
 * D1 holds the work around it: vendor_profiles (where onboarding stands, the
 * address Mercury needs in parts, the agent's asks), vendor_bank and
 * vendor_requests ("Work with us", decided in Admin → Trade partners, never
 * from Slack, which only hears that one came in).
 */

import { SOARD_ORG_ID, TZ } from './_reveals.js';
import { sendEmails, slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { emailShell, paragraphs, button, panel, esc } from './_email-shell.js';
import { mercury, mercuryConfigured, uploadRecipientAttachment, readState } from './_mercury.js';
import { FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE } from './_applicant-comms.js';
import { cachedRecipients, recipientFor } from './_bill-pay.js';
import { vendorKey, dollars } from './_spend-match.js';
import { checkW9, buildW9 } from './_w9-form.js';
import { requirementLines, longDate } from './_vendor-read.js';
import {
  jt, jtSetup, readJtVendor, createLink, ensureVendorSchema, docsState, readDocSettings, writeFields, vendorNote, uploadToJt,
  patchAsk, readAsk, labelFor, resolveAll, briefState, jtVendorUrl, OVERRIDES, FOLDER, TAGS, TRADES, PARTNERS_PAGE, PREVIEW_ID, LIMITS, STATE_KEY,
} from './_vendors.js';

const DAY = 864e5;
export const BANK_FRESH_DAYS = 7;          // a link older than this asks for a fresh one before bank details change
export const REMIND_DAYS = [2, 5];          // an unfinished setup is nudged after these many days, then left alone
export const AGENT_REMIND_DAYS = [3, 7];    // and an agent who hasn't sent the certificate
export const ROLES = { main: 'Main contact', billing: 'Billing', agent: 'Insurance agent' };
export const ACCOUNT_TYPES = { businessChecking: 'Business checking', businessSavings: 'Business savings', personalChecking: 'Personal checking', personalSavings: 'Personal savings' };

// SOARD as the certificate holder and the W-9's requester: Admin → Site Config (site_config "settings"), today's if that can't be read
const FALLBACK_HOLDER = ['Sunshine on a Ranney Day', '250 Hembree Park Drive, Suite 106', 'Roswell, GA 30076'];
export async function holderOf(DB) {
  try {
    const row = await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first();
    const s = parseJson(row?.data, {});
    const a = s.address || {};
    if (s.name && a.street && a.city && a.state && a.zip) return [s.name, a.street, `${a.city}, ${a.state} ${a.zip}`];
  } catch { /* the fallback */ }
  return FALLBACK_HOLDER;
}
const isoDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const clean = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => clean(s).toLowerCase();
const bad = (message, field = null) => Object.assign(new Error(message), { status: 400, field });

/** A US phone as +1XXXXXXXXXX, or null */
export function phoneOf(s) {
  const d = String(s || '').replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return ten.length === 10 && /^[2-9]/.test(ten) ? `+1${ten}` : null;
}

/** An ABA routing number's own check digit (3·7·1 weights) */
export function routingOk(r) {
  const d = String(r || '').replace(/\D/g, '');
  if (d.length !== 9 || /^0{9}$/.test(d)) return false;
  const n = [...d].map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}

const addressLine = (a) => (a?.street ? [a.street, a.unit, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join(', ') : '');

// ─── Tables ─────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vendor_profiles (
    jt_id TEXT PRIMARY KEY, invited_at TEXT, invited_by TEXT, started_at TEXT, done_at TEXT, steps TEXT,
    address TEXT, agent TEXT, lang TEXT, reminders INTEGER NOT NULL DEFAULT 0, reminded_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS vendor_bank (
    jt_id TEXT PRIMARY KEY, mercury_id TEXT, last4 TEXT, kind TEXT, status TEXT NOT NULL, changed_at TEXT,
    previous_last4 TEXT, confirmed_by TEXT, confirmed_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS vendor_requests (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', company TEXT, trades TEXT, name TEXT,
    email TEXT, phone TEXT, website TEXT, area TEXT, note TEXT, lang TEXT, ip TEXT, decided_by TEXT, decided_at TEXT, jt_id TEXT, reason TEXT)`,
  'CREATE INDEX IF NOT EXISTS vendor_requests_status ON vendor_requests (status, created_at)',
];
const _ready = new WeakSet();
export async function ensurePartnerSchema(DB) {
  if (_ready.has(DB)) return;
  await ensureVendorSchema(DB);
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

const profileRow = (r) => ({
  jtId: r?.jt_id || null, invitedAt: r?.invited_at || null, invitedBy: r?.invited_by || null, startedAt: r?.started_at || null, doneAt: r?.done_at || null,
  steps: parseJson(r?.steps, {}), address: parseJson(r?.address, null), agent: parseJson(r?.agent, null), lang: r?.lang || 'en',
  reminders: r?.reminders || 0, remindedAt: r?.reminded_at || null,
});

export async function readProfileRow(DB, jtId) {
  await ensurePartnerSchema(DB);
  return profileRow(await DB.prepare('SELECT * FROM vendor_profiles WHERE jt_id = ?').bind(jtId).first());
}

/** Change some of a partner's work row (camelCase keys) */
export async function patchProfile(DB, jtId, patch, now = Date.now()) {
  const a = { ...(await readProfileRow(DB, jtId)), ...patch };
  await DB.prepare(`INSERT OR REPLACE INTO vendor_profiles (jt_id, invited_at, invited_by, started_at, done_at, steps, address, agent, lang, reminders, reminded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(jtId, a.invitedAt, a.invitedBy, a.startedAt, a.doneAt, JSON.stringify(a.steps || {}), a.address ? JSON.stringify(a.address) : null,
      a.agent ? JSON.stringify(a.agent) : null, a.lang === 'es' ? 'es' : 'en', a.reminders || 0, a.remindedAt, new Date(now).toISOString()).run();
  return a;
}

/** One step done (company · w9 · coi · bank); when they all are, the setup is */
async function stepDone(DB, jtId, step, now = Date.now()) {
  const p = await readProfileRow(DB, jtId);
  const steps = { ...p.steps, [step]: p.steps[step] || new Date(now).toISOString() };
  const done = ['company', 'w9', 'coi', 'bank'].every((k) => steps[k]);
  return patchProfile(DB, jtId, { steps, startedAt: p.startedAt || new Date(now).toISOString(), doneAt: p.doneAt || (done ? new Date(now).toISOString() : null) }, now);
}

// ─── JobTread: the company and its people ───────────────────────────

const valueOf = (c, fieldId) => (c?.customFieldValues?.nodes || []).find((n) => n.customField?.id === fieldId)?.value || null;
const roleOf = (title) => {
  const t = norm(title);
  if (/agent|insurance/.test(t)) return 'agent';
  if (/billing|accounts? (payable|receivable)|invoic|bookkeep|\bap\b|\bar\b/.test(t)) return 'billing';
  return null;
};

// Trades as JobTread's field takes it: all of them, or the first while it takes one (Admin → Trade Partners says so)
const tradesValue = (ids, trades) => (ids.fields.trades.multiple === false ? trades[0] : trades);

/** The vendor's company as JobTread has it → { id, name, trades, address, license, materials, contacts: [{ id, name, title, email, phone, role }] } */
export async function readCompany(env, jtId, { fetchImpl = fetch } = {}) {
  if (jtId === PREVIEW_ID) return { id: PREVIEW_ID, name: 'Your company (a preview)', trades: [], address: '', license: '', materials: false, contacts: [] };
  const ids = await jtSetup(env, { fetchImpl });
  const people = { $: { where: [['customField', 'id'], 'in', [FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE]] }, nodes: { value: {}, customField: { id: {} } } };
  const d = await jt(env, {
    account: {
      $: { id: jtId },
      id: {}, name: {}, archivedAt: {},
      customFieldValues: { $: { size: 25 }, nodes: { value: {}, customField: { id: {} } } },
      primaryContact: { id: {} },
      contacts: { $: { size: 15 }, nodes: { id: {}, name: {}, title: {}, customFieldValues: people } },
    },
  }, fetchImpl);
  const a = d?.account;
  if (!a?.id) return null;
  const val = (k) => (a.customFieldValues?.nodes || []).find((n) => n.customField?.id === ids.fields[k]?.id)?.value ?? null;
  const primary = a.primaryContact?.id;
  const contacts = (a.contacts?.nodes || []).map((c) => ({
    id: c.id, name: c.name || '', title: c.title || '', email: (valueOf(c, FIELD_CONTACT_EMAIL) || '').toLowerCase() || null, phone: valueOf(c, FIELD_CONTACT_PHONE),
    role: c.id === primary ? 'main' : roleOf(c.title),
  }));
  if (!contacts.some((c) => c.role === 'main')) {
    const first = contacts.find((c) => !c.role);
    if (first) first.role = 'main';
  }
  const trades = val('trades');
  return {
    id: a.id, name: a.name, archived: !!a.archivedAt,
    trades: Array.isArray(trades) ? trades : trades ? String(trades).split(/\s*,\s*/).filter(Boolean) : [],
    address: val('address') || '', license: val('license') || '', materials: val('materials') === true || /^(true|yes)$/i.test(String(val('materials') || '')),
    contacts,
  };
}

/** A contact in a role: updated when there is one, made when not */
async function putContact(env, jtId, company, role, { name, email, phone }, fetchImpl) {
  const fields = {};
  if (email) fields[FIELD_CONTACT_EMAIL] = email;
  if (phone) fields[FIELD_CONTACT_PHONE] = phone;
  const have = company.contacts.find((c) => c.role === role) || (role !== 'main' && email ? company.contacts.find((c) => c.email === email && c.role === role) : null);
  const title = role === 'main' ? (have?.title || ROLES.main) : ROLES[role];
  if (have) {
    await jt(env, { updateContact: { $: { id: have.id, name: name || have.name, title, customFieldValues: fields } } }, fetchImpl);
    return have.id;
  }
  const made = await jt(env, { createContact: { $: { accountId: jtId, name: name || email, title, customFieldValues: fields }, createdContact: { id: {} } } }, fetchImpl);
  return made?.createContact?.createdContact?.id || null;
}

/** The vendors cache row that signing in reads (made when JobTread's 4-hourly read hasn't caught up) */
async function rememberVendor(DB, { jtId, name, emails }) {
  await ensureVendorSchema(DB);
  const r = await DB.prepare('SELECT id, facts FROM vendors WHERE jt_id = ?').bind(jtId).first();
  const iso = new Date().toISOString();
  const list = [...new Set(emails.filter(isEmail).map((e) => e.toLowerCase()))];
  if (r) {
    const facts = parseJson(r.facts);
    facts.emails = [...new Set([...(facts.emails || []), ...list])];
    await DB.prepare('UPDATE vendors SET name = ?, vkey = ?, email = COALESCE(email, ?), facts = ?, updated_at = ? WHERE id = ?').bind(name, vendorKey(name), list[0] || null, JSON.stringify(facts), iso, r.id).run();
  } else {
    await DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`jt_${jtId}`, name, vendorKey(name), jtId, list[0] || null, JSON.stringify({ jobs: [], emails: list }), iso, iso).run();
  }
}

/**
 * The company step: name, trades, address, license and the people.
 * body: { name, trades: [], address: { street, unit, city, state, zip }, license, main: { name, email, phone }, billing: { email, name } }
 */
export async function saveCompany(env, link, body, { now = Date.now(), fetchImpl = fetch } = {}) {
  const name = clean(body.name, 120);
  if (name.length < 2) throw bad('Add your company’s name.', 'name');
  const trades = (Array.isArray(body.trades) ? body.trades : []).filter((t) => TRADES.includes(t)).slice(0, 12);
  if (!trades.length) throw bad('Pick at least one trade.', 'trades');
  const a = body.address || {};
  const address = { street: clean(a.street, 80), unit: clean(a.unit, 30), city: clean(a.city, 50), state: clean(a.state, 2).toUpperCase(), zip: clean(a.zip, 10) };
  if (!address.street) throw bad('Add your street address.', 'street');
  if (!address.city) throw bad('Add the city.', 'city');
  if (!/^[A-Z]{2}$/.test(address.state)) throw bad('Add the state as two letters, like GA.', 'state');
  if (!/^\d{5}(-\d{4})?$/.test(address.zip)) throw bad('Add a 5-digit ZIP code.', 'zip');
  const main = { name: clean(body.main?.name, 80), email: clean(body.main?.email, 120).toLowerCase(), phone: phoneOf(body.main?.phone) };
  if (main.name.length < 2) throw bad('Add who we should talk to.', 'mainName');
  if (!isEmail(main.email)) throw bad('Add an email address we can reach them at.', 'mainEmail');
  if (!main.phone) throw bad('Add a 10-digit phone number.', 'mainPhone');
  const billing = { name: clean(body.billing?.name, 80), email: clean(body.billing?.email, 120).toLowerCase() };
  if (billing.email && !isEmail(billing.email)) throw bad('Check the billing email address.', 'billingEmail');
  const license = clean(body.license, 60);
  if (link.vendor_id === PREVIEW_ID) return { ok: true, preview: true };

  const company = await readCompany(env, link.vendor_id, { fetchImpl });
  if (!company || company.archived) throw Object.assign(new Error('This link is for a company we no longer have on file.'), { status: 410 });
  const ids = await jtSetup(env, { fetchImpl });
  const values = {
    [ids.fields.trades.id]: tradesValue(ids, trades),
    [ids.fields.address.id]: addressLine(address),
    ...(license || company.license ? { [ids.fields.license.id]: license } : {}),
  };
  await jt(env, { updateAccount: { $: { id: company.id, ...(name !== company.name ? { name } : {}), customFieldValues: values } } }, fetchImpl);
  await putContact(env, company.id, company, 'main', main, fetchImpl);
  if (billing.email && billing.email !== main.email) await putContact(env, company.id, company, 'billing', { name: billing.name || 'Billing', email: billing.email }, fetchImpl);
  const changed = [name !== company.name && `name (was ${company.name})`, 'trades, address and contacts'].filter(Boolean).join(', ');
  await vendorNote(env, company.id, 'Company details from the trade-partner page', `${main.name} updated the company’s ${changed} on SOARD’s trade-partner page on ${longDate(isoDay(now))}.`, fetchImpl);
  await rememberVendor(env.DB, { jtId: company.id, name, emails: [main.email, billing.email] });
  await patchProfile(env.DB, company.id, { address }, now);
  await stepDone(env.DB, company.id, 'company', now);
  return { ok: true };
}

// ─── The W-9, signed on the page ────────────────────────────────────

/** The W-9 from the form: checked, built, filed in JobTread, ticked, sent to Mercury → { ok } | { ok: false, problems } */
export async function signW9(env, link, answers, { now = Date.now(), ip = '', fetchImpl = fetch } = {}) {
  const r = checkW9(answers);
  if (!r.ok) return { ok: false, problems: r.problems };
  const v = await readJtVendor(env, link.vendor_id, { fetchImpl });
  if (!v || v.archived) throw Object.assign(new Error('This link is for a company we no longer have on file.'), { status: 410 });
  const holder = await holderOf(env.DB);
  const bytes = await buildW9(r.w9, { signedAt: now, email: v.email || '', ip, tz: TZ, requester: { name: holder[0], lines: holder.slice(1) } });
  if (v.id === PREVIEW_ID) return { ok: true, preview: true, bytes: bytes.length };
  const ids = await jtSetup(env, { fetchImpl });
  const day = isoDay(now);
  const uploadRequestId = await uploadToJt(env, { bytes, type: 'application/pdf' }, fetchImpl);
  await jt(env, { createFile: { $: { name: `${TAGS.w9} ${v.name} ${day} (signed online).pdf`, targetType: 'account', targetId: v.id, uploadRequestId, folder: FOLDER, fileTagIds: [ids.tags.w9] }, createdFile: { id: {} } } }, fetchImpl);
  const after = { ...v, w9: true };
  const req = await readDocSettings(env.DB);
  const state = docsState(after, req, { now });
  const ask = await readAsk(env.DB, v.id);
  const label = OVERRIDES.has(v.docs) ? null : labelFor(after, state, ask);
  await writeFields(env, ids, v.id, { w9: true, ...(label && label !== v.docs ? { docs: label === 'Needs a look' && v.docs !== 'Needs a look' ? state.label : label } : {}) }, fetchImpl);
  await vendorNote(env, v.id, 'W-9 from the trade-partner page', `${r.w9.signature} filled in and signed a W-9 on SOARD’s trade-partner page on ${longDate(day)} (${r.w9.business || r.w9.name}, ${r.w9.tinType === 'ein' ? 'EIN' : 'SSN or ITIN'} given). It’s in the ${FOLDER} folder.`, fetchImpl);
  await patchAsk(env.DB, v.id, { name: v.name, email: v.email, state: briefState(state), checkedAt: new Date(now).toISOString(), ...(state.ok && !state.expiring ? { open: false } : {}) }, now);
  if (state.ok && !state.expiring) await resolveAll(env, v.id, 'Their W-9 and insurance are current in JobTread.', now).catch(() => null);
  if (mercuryConfigured(env)) {
    const bank = await readBank(env.DB, v.id);
    const recipient = bank?.mercuryId ? { id: bank.mercuryId } : recipientFor(v.name, await cachedRecipients(env, { now }).catch(() => []));
    if (recipient) await uploadRecipientAttachment(env, recipient.id, { bytes, fileName: `W-9 ${v.name}.pdf`, type: 'application/pdf' }).then(() => patchAsk(env.DB, v.id, { mercuryW9At: new Date(now).toISOString() }, now)).catch((e) => console.error('[partners] w9 mercury', e.message));
  }
  if (state.ok) {
    const { releaseVendorHolds } = await import('./_bill-pay.js');
    await releaseVendorHolds(env, v.id, { now }).catch(() => 0);
  }
  await stepDone(env.DB, v.id, 'w9', now);
  return { ok: true };
}

// ─── Their insurance agent ──────────────────────────────────────────

/** The agent's email: what SOARD needs on the certificate, and their link → { subject, html, text } */
export function agentEmail({ vendorName, agentName, url, req, holder = FALLBACK_HOLDER, renewal = false, reminder = false }) {
  const lines = requirementLines(req);
  const subject = `${reminder ? 'A reminder: ' : ''}Certificate of insurance${renewal ? ' renewal' : ''} for ${vendorName}`;
  const hi = agentName ? `Hi ${agentName.split(' ')[0]},` : 'Hello,';
  const lead = renewal
    ? `${vendorName} works with Sunshine on a Ranney Day, a nonprofit that builds bedrooms and bathrooms for children with disabilities, and named you as their insurance agent. Their coverage on file ends soon; could you send the renewed certificate?`
    : `${vendorName} works with Sunshine on a Ranney Day, a nonprofit that builds bedrooms and bathrooms for children with disabilities, and asked us to request their certificate of insurance from you.`;
  const list = (rows) => `<ul style="margin:0 0 14px;padding-left:20px;">${rows.map((r) => `<li class="ink" style="margin:0 0 6px;">${esc(r)}</li>`).join('')}</ul>`;
  const html = emailShell({
    preheader: `Certificate holder: ${holder[0]}`,
    heading: renewal ? 'A renewed certificate, please' : 'A certificate of insurance, please',
    bodyHtml: `${paragraphs(hi)}${paragraphs(lead)}`
      + panel(`${paragraphs('Certificate holder:', 'font-weight:700;margin-bottom:6px;')}${paragraphs(holder.join('\n'))}`, { accent: true })
      + `${paragraphs('It needs to show:', 'font-weight:700;margin-bottom:8px;')}${list(lines)}`
      + `${paragraphs('Add it on SOARD’s page for them and it’s checked right there; a PDF from your system is perfect.')}${button('Add the certificate', url)}`
      + paragraphs('The link only adds a certificate for this one company. Questions? Just reply to this email.', 'font-size:14px;'),
  });
  const text = [hi, '', lead, '', 'Certificate holder:', ...holder, '', 'It needs to show:', ...lines.map((l) => `- ${l}`), '',
    `Add it here, and it’s checked right there: ${url}`, '', 'The link only adds a certificate for this one company. Questions? Just reply to this email.'].join('\n');
  return { subject, html, text };
}

/** Ask the agent for a certificate (and remember them) → { ok } */
export async function askAgent(env, jtId, { renewal = false, reminder = false, by = 'vendor', now = Date.now(), fetchImpl = fetch } = {}) {
  const p = await readProfileRow(env.DB, jtId);
  const agent = p.agent;
  if (!isEmail(agent?.email)) return { ok: false, noAgent: true };
  const v = await readJtVendor(env, jtId, { fetchImpl });
  if (!v || v.archived) return { ok: false };
  const link = await createLink(env.DB, jtId, { by: `agent:${by}`, scope: 'agent', now });
  const mail = agentEmail({ vendorName: v.name, agentName: agent.name, url: link.url, req: await readDocSettings(env.DB), holder: await holderOf(env.DB), renewal, reminder });
  const r = await sendEmails(env, { to: [agent.email], subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-agent' }] });
  if (!r.sent) throw new Error(r.errors[0] || 'The email to the agent didn’t send');
  await patchProfile(env.DB, jtId, { agent: { ...agent, asks: (reminder ? agent.asks || 0 : 0) + 1, askedAt: new Date(now).toISOString(), open: true, renewal } }, now);
  return { ok: true };
}

/** The insurance step's other road: their agent sends it. body: { name, email, agency, phone } */
export async function saveAgent(env, link, body, { now = Date.now(), fetchImpl = fetch } = {}) {
  const agent = { name: clean(body.name, 80), email: clean(body.email, 120).toLowerCase(), agency: clean(body.agency, 80), phone: phoneOf(body.phone) };
  if (!isEmail(agent.email)) throw bad('Add your agent’s email address.', 'agentEmail');
  if (link.vendor_id === PREVIEW_ID) return { ok: true, preview: true, agent: agent.email };
  const company = await readCompany(env, link.vendor_id, { fetchImpl });
  if (!company || company.archived) throw Object.assign(new Error('This link is for a company we no longer have on file.'), { status: 410 });
  await putContact(env, company.id, company, 'agent', { name: [agent.name, agent.agency && `(${agent.agency})`].filter(Boolean).join(' ') || agent.email, email: agent.email, phone: agent.phone }, fetchImpl);
  const before = await readProfileRow(env.DB, company.id);
  await patchProfile(env.DB, company.id, { agent: { ...agent, asks: 0, askedAt: null, open: false }, startedAt: before.startedAt || new Date(now).toISOString() }, now);
  await askAgent(env, company.id, { by: 'vendor', now, fetchImpl });
  await vendorNote(env, company.id, 'Insurance agent from the trade-partner page', `${company.name} named ${agent.name || agent.email}${agent.agency ? ` at ${agent.agency}` : ''} as their insurance agent on ${longDate(isoDay(now))}. SOARD emailed them for the certificate, and asks them for renewals from now on.`, fetchImpl);
  return { ok: true, agent: agent.email };
}

// ─── Bank details, straight to Mercury ──────────────────────────────

const bankRow = (r) => r && ({ jtId: r.jt_id, mercuryId: r.mercury_id, last4: r.last4, kind: r.kind, status: r.status, changedAt: r.changed_at, previousLast4: r.previous_last4, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at });

export async function readBank(DB, jtId) {
  await ensurePartnerSchema(DB);
  return bankRow(await DB.prepare('SELECT * FROM vendor_bank WHERE jt_id = ?').bind(jtId).first());
}

/** Why a bill for this vendor can't be paid yet: their new bank account isn't confirmed (→ words) or null */
export async function bankHold(DB, jtId) {
  const b = await readBank(DB, jtId).catch(() => null);
  return b?.status === 'pending' ? `their new bank account (ending ${b.last4}) isn’t confirmed yet` : null;
}

/** The bank step's email: to the address on file, so a change nobody made is caught */
export function bankEmail({ vendorName, last4, kindLabel, changed, lang = 'en' }) {
  const es = lang === 'es';
  const subject = es ? `Datos bancarios de ${vendorName} para Sunshine on a Ranney Day` : `${changed ? 'Your bank account was changed' : 'We have your bank details'} for Sunshine on a Ranney Day`;
  const lead = es
    ? `${changed ? 'La cuenta bancaria donde Sunshine on a Ranney Day le paga a' : 'Recibimos la cuenta bancaria donde Sunshine on a Ranney Day le pagará a'} ${vendorName}: ${kindLabel} que termina en ${last4}.`
    : `${changed ? 'The bank account Sunshine on a Ranney Day pays' : 'We have the bank account we’ll pay'} ${vendorName}${changed ? ' was just changed to' : ':'} ${kindLabel.toLowerCase()} ending in ${last4}.`;
  const safe = es
    ? 'Por su seguridad, alguien de nuestro equipo lo llamará al número que ya tenemos para confirmarla antes del próximo pago. Si usted no hizo este cambio, responda a este correo de inmediato.'
    : 'For your safety, someone from our team will call the number we already have to confirm it before the next payment. If you didn’t make this change, reply to this email right away.';
  return { subject, html: emailShell({ preheader: lead, heading: es ? 'Sus datos bancarios' : changed ? 'Your bank account changed' : 'Your bank details', bodyHtml: `${paragraphs(lead)}${paragraphs(safe)}` }), text: [lead, '', safe].join('\n') };
}

/**
 * The bank step. body: { routing, account, account2, kind } (kind: an ACCOUNT_TYPES key).
 * Sent to Mercury (a recipient made or edited); nothing but the last four digits is kept.
 */
export async function saveBank(env, link, body, { now = Date.now(), fetchImpl = fetch } = {}) {
  const routing = String(body.routing || '').replace(/\D/g, '');
  const account = String(body.account || '').replace(/[\s-]/g, '');
  if (!routingOk(routing)) throw bad('That routing number isn’t right. It’s the 9 digits at the bottom left of a check.', 'routing');
  if (!/^\d{4,17}$/.test(account)) throw bad('An account number is 4 to 17 digits.', 'account');
  if (account !== String(body.account2 || '').replace(/[\s-]/g, '')) throw bad('The two account numbers don’t match.', 'account2');
  const kind = ACCOUNT_TYPES[body.kind] ? body.kind : null;
  if (!kind) throw bad('Pick the kind of account.', 'kind');
  if (link.vendor_id === PREVIEW_ID) return { ok: true, preview: true, last4: account.slice(-4) };
  if (now - Date.parse(link.created_at) > BANK_FRESH_DAYS * DAY) throw Object.assign(new Error('For your safety, bank details change only from a link that’s a few days old at most.'), { status: 403, code: 'fresh' });
  if (!mercuryConfigured(env)) throw Object.assign(new Error('We can’t take bank details just now. Please try again later.'), { status: 503 });
  const company = await readCompany(env, link.vendor_id, { fetchImpl });
  if (!company || company.archived) throw Object.assign(new Error('This link is for a company we no longer have on file.'), { status: 410 });
  const profile = await readProfileRow(env.DB, company.id);
  if (!profile.address?.street) throw Object.assign(new Error('Add your company’s address first: the bank needs it for a payment.'), { status: 409, code: 'address' });
  const main = company.contacts.find((c) => c.role === 'main');
  const billing = company.contacts.find((c) => c.role === 'billing');
  const emails = [...new Set([billing?.email, main?.email].filter(isEmail))];
  const a = profile.address;
  const electronicRoutingInfo = {
    accountNumber: account, routingNumber: routing, electronicAccountType: kind,
    address: { address1: a.street, ...(a.unit ? { address2: a.unit } : {}), city: a.city, region: a.state, postalCode: a.zip, country: 'US' },
  };
  const before = await readBank(env.DB, company.id);
  let recipientId = before?.mercuryId || recipientFor(company.name, await cachedRecipients(env, { now }).catch(() => []))?.id || null;
  let changed = !!before?.last4;
  if (recipientId) {
    const cur = await mercury(env, `/recipient/${encodeURIComponent(recipientId)}`).catch(() => null);
    if (cur?.electronicRoutingInfo) changed = true;
    await mercury(env, `/recipient/${encodeURIComponent(recipientId)}`, { method: 'POST', body: { electronicRoutingInfo, ...(emails.length ? { emails } : {}) } });
  } else {
    const made = await mercury(env, '/recipients', { method: 'POST', body: { name: company.name, emails: emails.length ? emails : [main?.email].filter(Boolean), electronicRoutingInfo } });
    recipientId = made?.id;
    if (!recipientId) throw new Error('Mercury didn’t make the recipient');
  }
  await cachedRecipients(env, { now, fresh: true }).catch(() => null);
  const last4 = account.slice(-4);
  const iso = new Date(now).toISOString();
  await env.DB.prepare(`INSERT OR REPLACE INTO vendor_bank (jt_id, mercury_id, last4, kind, status, changed_at, previous_last4, confirmed_by, confirmed_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?)`).bind(company.id, recipientId, last4, kind, iso, before?.last4 || null, iso).run();
  const kindLabel = ACCOUNT_TYPES[kind];
  await vendorNote(env, company.id, `Bank account ${changed ? 'changed' : 'added'} on the trade-partner page`,
    `${company.name}’s bank account for payments was ${changed ? `changed${before?.last4 ? ` from the one ending ${before.last4}` : ''} to` : 'set to'} a ${kindLabel.toLowerCase()} account ending ${last4} on SOARD’s trade-partner page on ${longDate(isoDay(now))}, and is on their Mercury recipient. Payments wait until someone at SOARD confirms it by phone (Admin → Trade partners → Bank changes).`, fetchImpl);
  // The address that was on file hears about it, so a change nobody asked for is caught
  const notify = [...new Set([...(before ? [main?.email, billing?.email] : [main?.email]).filter(isEmail)])];
  if (notify.length) {
    const mail = bankEmail({ vendorName: company.name, last4, kindLabel, changed, lang: profile.lang });
    await sendEmails(env, { to: notify, subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-bank' }] }).catch(() => null);
  }
  await slackIssue(env, `vendor:bank:${company.id}`, slackCard({
    icon: '🏦', title: `${company.name}: confirm their ${changed ? 'new ' : ''}bank account`,
    lead: `They ${changed ? 'changed' : 'added'} the account SOARD pays (${kindLabel.toLowerCase()} ending ${last4}) on their trade-partner page. Call the number already on file to confirm it, then confirm it in the admin. Their bills wait until then.`,
    facts: [['Phone on file', main?.phone || 'None in JobTread']],
    buttons: [{ label: 'Confirm in the admin', url: `${SITE_ORIGIN}/admin/#trade-partners/bank` }],
  }), { title: `${company.name}: bank account`, kind: 'attention', area: 'finance' }).catch(() => null);
  await stepDone(env.DB, company.id, 'bank', now);
  return { ok: true, last4, changed };
}

/** Someone at SOARD called and confirmed it (Admin → Trade partners) → the bank row */
export async function confirmBank(env, jtId, by, { now = Date.now(), fetchImpl = fetch } = {}) {
  const b = await readBank(env.DB, jtId);
  if (!b) throw Object.assign(new Error('There’s no bank account to confirm'), { status: 404 });
  if (b.status === 'confirmed') return b;
  const iso = new Date(now).toISOString();
  await env.DB.prepare("UPDATE vendor_bank SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE jt_id = ?").bind(by, iso, iso, jtId).run();
  await vendorNote(env, jtId, 'Bank account confirmed', `${by} confirmed the bank account ending ${b.last4} by phone on ${longDate(isoDay(now))}. Bills can be paid to it.`, fetchImpl);
  await slackResolved(env, `vendor:bank:${jtId}`, slackCard({ icon: '✅', title: 'Bank account confirmed' }), { summary: `${by} confirmed it.` }).catch(() => null);
  const { releaseVendorHolds } = await import('./_bill-pay.js');
  await releaseVendorHolds(env, jtId, { now }).catch(() => 0);
  return { ...b, status: 'confirmed', confirmedBy: by, confirmedAt: iso };
}

// ─── Their invoices ─────────────────────────────────────────────────

/** A vendor's bills, newest first → [{ id, number, date, cents, balance, status (received · review · approved · held · sending · paid · declined), heldFor ('documents' | 'bank'), paidAt, sentAt }] */
export async function partnerInvoices(DB, jtId, { now = Date.now(), months = 18 } = {}) {
  const since = isoDay(now - months * 31 * DAY);
  const rows = await DB.prepare(`SELECT b.id, b.number, b.date, b.cents, b.paid, b.balance, b.status, a.state, a.pay_state, a.paid_at, a.pay_started_at, a.hold
      FROM spend_bills b LEFT JOIN bill_approvals a ON a.bill_id = b.id
      WHERE b.account_id = ? AND b.charge_id IS NULL AND b.date >= ? ORDER BY b.date DESC LIMIT 60`).bind(jtId, since).all().then((r) => r.results || [], () => []);
  const ramp = new Map(await DB.prepare("SELECT jt_bill_id, state FROM ramp_holds WHERE account_id = ?").bind(jtId).all().then((r) => (r.results || []).map((x) => [x.jt_bill_id, x.state]), () => []));
  return rows.map((b) => {
    const owed = b.balance ?? (b.cents - (b.paid || 0));
    let status = 'received';
    if (b.status === 'denied' || b.state === 'rejected') status = 'declined';
    else if (b.pay_state === 'paid' || (owed <= 0 && b.cents > 0)) status = 'paid';
    else if (['requested', 'sent'].includes(b.pay_state)) status = 'sending';
    else if (b.pay_state === 'held' || ramp.get(b.id) === 'held') status = 'held';
    else if (b.state === 'approved' || b.status === 'approved') status = 'approved';
    else if (b.status === 'pending') status = 'review';
    const heldFor = status === 'held' ? (parseJson(b.hold, {}).bank ? 'bank' : 'documents') : null;
    return { id: b.id, number: b.number || null, date: b.date, cents: b.cents, balance: Math.max(0, owed), status, heldFor, paidAt: b.paid_at || null, sentAt: b.pay_started_at || null };
  });
}

// ─── The partner's page, in one read ────────────────────────────────

/** Everything /trade-partners/account/ shows for a link → see the page */
export async function partnerView(env, link, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensurePartnerSchema(env.DB);
  const v = await readJtVendor(env, link.vendor_id, { fetchImpl });
  if (!v || v.archived) return null;
  const req = await readDocSettings(env.DB);
  const state = docsState(v, req, { now });
  const docs = {
    needs: state.needs, items: state.items.map((i) => ({ doc: i.doc, text: i.text })),
    have: { w9: v.w9, glExpires: v.glExpires, wcExpires: v.wcExpires },
    w9: state.w9, gl: state.gl, wc: state.wc, w9Only: v.docs === 'W-9 only', notNeeded: v.docs === 'Not needed',
    requirements: requirementLines(req), holder: await holderOf(env.DB), workersComp: !!req.workersComp,
    minimums: { glOccurrence: req.glOccurrence, glAggregate: req.glAggregate, workersComp: !!req.workersComp, elEachAccident: req.elEachAccident },
  };
  if (link.scope === 'agent') return { scope: 'agent', name: v.name, docs, preview: v.id === PREVIEW_ID };
  const [company, profile, bank, invoices] = await Promise.all([
    readCompany(env, v.id, { fetchImpl }),
    readProfileRow(env.DB, v.id),
    readBank(env.DB, v.id),
    v.id === PREVIEW_ID ? [] : partnerInvoices(env.DB, v.id, { now }),
  ]);
  const main = company?.contacts.find((c) => c.role === 'main');
  const billing = company?.contacts.find((c) => c.role === 'billing');
  const agent = profile.agent || (company?.contacts.find((c) => c.role === 'agent') ? { name: company.contacts.find((c) => c.role === 'agent').name, email: company.contacts.find((c) => c.role === 'agent').email } : null);
  const bankFresh = now - Date.parse(link.created_at) <= BANK_FRESH_DAYS * DAY;
  return {
    scope: 'vendor', preview: v.id === PREVIEW_ID, name: v.name, lang: profile.lang,
    company: company && {
      name: company.name, trades: company.trades, license: company.license, address: profile.address || null, addressText: company.address,
      main: main ? { name: main.name, email: main.email, phone: main.phone } : null,
      billing: billing ? { name: billing.name, email: billing.email } : null,
    },
    trades: TRADES,
    docs,
    agent: agent && { name: agent.name || '', email: agent.email || '', agency: agent.agency || '', askedAt: agent.askedAt || null },
    bank: bank ? { last4: bank.last4, kind: ACCOUNT_TYPES[bank.kind] || null, status: bank.status } : null,
    bankFresh,
    invoices,
    steps: {
      company: !!(profile.steps.company || (main?.email && company?.trades.length && company?.address)),
      w9: state.w9 !== 'missing', coi: !['missing', 'expired'].includes(state.gl) && !['missing', 'expired'].includes(state.wc),
      bank: !!bank,
    },
    setupDone: !!profile.doneAt,
    signInEmail: main?.email || v.email || null,
  };
}

// ─── Signing in ─────────────────────────────────────────────────────

/** The sign-in email: one link per company that email belongs to */
export function signInEmail({ links, lang = 'en' }) {
  const es = lang === 'es';
  const one = links.length === 1;
  const subject = es ? 'Su enlace para Sunshine on a Ranney Day' : 'Your sign-in link for Sunshine on a Ranney Day';
  const lead = es ? 'Use este enlace para abrir su página de socio comercial. Funciona en este dispositivo por 90 días.' : 'Here’s your link to your trade-partner page. It keeps you signed in on that device for 90 days.';
  const body = one
    ? button(es ? 'Abrir mi página' : 'Open my page', links[0].url)
    : links.map((l) => `${paragraphs(l.name, 'font-weight:700;margin-bottom:6px;')}${button(es ? 'Abrir' : 'Open', l.url)}`).join('');
  const after = es ? 'Si usted no pidió este enlace, puede ignorar este correo.' : 'If you didn’t ask for this link, you can ignore this email.';
  return {
    subject,
    html: emailShell({ preheader: lead, heading: es ? 'Su enlace' : 'Your sign-in link', bodyHtml: `${paragraphs(lead)}${body}${paragraphs(after, 'font-size:14px;')}` }),
    text: [lead, '', ...links.map((l) => `${one ? '' : `${l.name}: `}${l.url}`), '', after].join('\n'),
  };
}

/** Sign-in by email → always { ok: true } (whether the email is on file isn't told), the link emailed when it is */
export async function signIn(env, email, { lang = 'en', now = Date.now() } = {}) {
  await ensurePartnerSchema(env.DB);
  const e = clean(email, 120).toLowerCase();
  if (!isEmail(e)) throw bad('Type the email address you use with SOARD.', 'email');
  const rows = (await env.DB.prepare('SELECT jt_id, name, email, facts FROM vendors WHERE jt_id IS NOT NULL').all()).results || [];
  const hits = rows.filter((r) => r.email === e || (parseJson(r.facts).emails || []).includes(e)).slice(0, 5);
  if (!hits.length) return { ok: true, sent: false };
  const links = [];
  for (const r of hits) links.push({ name: r.name, url: (await createLink(env.DB, r.jt_id, { by: 'signin', now })).url });
  const mail = signInEmail({ links, lang });
  await sendEmails(env, { to: [e], subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-signin' }] });
  return { ok: true, sent: true };
}

/** A link that can change bank details, for a signed-in vendor whose link is older (sent to the main contact) */
export async function freshBankLink(env, link, { now = Date.now(), fetchImpl = fetch } = {}) {
  const company = await readCompany(env, link.vendor_id, { fetchImpl });
  const main = company?.contacts.find((c) => c.role === 'main');
  const to = main?.email || (await readJtVendor(env, link.vendor_id, { fetchImpl }))?.email;
  if (!isEmail(to)) throw Object.assign(new Error('There’s no email on file to send it to. Reply to our last email and we’ll help.'), { status: 409 });
  const profile = await readProfileRow(env.DB, link.vendor_id);
  const l = await createLink(env.DB, link.vendor_id, { by: 'bank', now, step: 'bank' });
  const mail = signInEmail({ links: [{ name: company.name, url: l.url }], lang: profile.lang });
  await sendEmails(env, { to: [to], subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-signin' }] });
  return { ok: true, to: to.replace(/^(.).*(@.*)$/, '$1…$2') };
}

// ─── "Work with us" ─────────────────────────────────────────────────

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The public form → { ok, id }. body: { company, trades: [], name, email, phone, website, area, note, lang } */
export async function submitRequest(env, body, { ip = '', now = Date.now() } = {}) {
  await ensurePartnerSchema(env.DB);
  const r = {
    company: clean(body.company, 120), trades: (Array.isArray(body.trades) ? body.trades : []).filter((t) => TRADES.includes(t)).slice(0, 12),
    name: clean(body.name, 80), email: clean(body.email, 120).toLowerCase(), phone: phoneOf(body.phone), website: clean(body.website, 160),
    area: clean(body.area, 120), note: clean(body.note, 1200), lang: body.lang === 'es' ? 'es' : 'en',
  };
  if (r.company.length < 2) throw bad('Add your company’s name.', 'company');
  if (!r.trades.length) throw bad('Pick at least one trade.', 'trades');
  if (r.name.length < 2) throw bad('Add your name.', 'name');
  if (!isEmail(r.email)) throw bad('Add an email address we can reach you at.', 'email');
  if (!r.phone) throw bad('Add a 10-digit phone number.', 'phone');
  const dup = await env.DB.prepare("SELECT id FROM vendor_requests WHERE email = ? AND status = 'new'").bind(r.email).first();
  if (dup) return { ok: true, id: dup.id, again: true };
  const id = newId();
  await env.DB.prepare(`INSERT INTO vendor_requests (id, created_at, status, company, trades, name, email, phone, website, area, note, lang, ip) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, new Date(now).toISOString(), r.company, JSON.stringify(r.trades), r.name, r.email, r.phone, r.website || null, r.area || null, r.note || null, r.lang, ip || null).run();
  const es = r.lang === 'es';
  const thanks = es
    ? `Gracias por su interés en trabajar con Sunshine on a Ranney Day. Nuestro equipo revisará la información de ${r.company} y le escribirá pronto.`
    : `Thank you for your interest in working with Sunshine on a Ranney Day. Our team will look over ${r.company}’s details and be in touch soon.`;
  await sendEmails(env, { to: [r.email], subject: es ? 'Recibimos su solicitud' : 'We have your request to work with SOARD', html: emailShell({ preheader: thanks, heading: es ? 'Gracias' : 'Thank you', bodyHtml: paragraphs(thanks) }), text: thanks, tags: [{ name: 'type', value: 'vendor-request' }] }).catch(() => null);
  await slackIssue(env, `vendor:request:${id}`, slackCard({
    icon: '🧰', title: `${r.company} wants to work with SOARD`,
    lead: `${r.name} asked through the trade-partner page. Approve or decline them in the admin.`,
    facts: [['Trades', r.trades.join(', ')], ['Where', r.area || '—']],
    buttons: [{ label: 'Open in the admin', url: `${SITE_ORIGIN}/admin/#trade-partners/requests` }],
  }), { title: `${r.company}: request`, kind: 'attention', area: 'finance' }).catch(() => null);
  return { ok: true, id };
}

const requestRow = (r) => r && ({
  id: r.id, createdAt: r.created_at, status: r.status, company: r.company, trades: parseJson(r.trades, []), name: r.name, email: r.email, phone: r.phone,
  website: r.website, area: r.area, note: r.note, lang: r.lang || 'en', decidedBy: r.decided_by, decidedAt: r.decided_at, jtId: r.jt_id, reason: r.reason,
});

export async function listRequests(DB, { status = null } = {}) {
  await ensurePartnerSchema(DB);
  const rows = status
    ? (await DB.prepare('SELECT * FROM vendor_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200').bind(status).all()).results
    : (await DB.prepare('SELECT * FROM vendor_requests ORDER BY created_at DESC LIMIT 200').all()).results;
  return (rows || []).map(requestRow);
}

// ─── Inviting a partner ─────────────────────────────────────────────

/** The welcome: what setting up takes, and their link → { subject, html, text } */
export function inviteEmail({ vendorName, contactName, url, lang = 'en', reminder = false }) {
  const es = lang === 'es';
  const first = clean(contactName).split(' ')[0];
  const hi = first ? (es ? `Hola ${first}:` : `Hi ${first},`) : (es ? 'Hola:' : 'Hello,');
  const lead = es
    ? `${reminder ? 'Le recordamos que su' : 'Su'} cuenta de socio comercial de ${vendorName} con Sunshine on a Ranney Day está lista para configurar. Toma unos 10 minutos: los datos de la empresa, el W-9 (se llena y se firma en la página), su seguro y la cuenta bancaria donde le pagamos.`
    : `${reminder ? 'A reminder: ' : ''}${vendorName}’s trade-partner account with Sunshine on a Ranney Day is ready to set up. It takes about 10 minutes: your company details, a W-9 (filled in and signed right on the page), your insurance, and the bank account we pay.`;
  const after = es
    ? 'El enlace mantiene su sesión abierta en ese dispositivo por 90 días. Después, entre en sunshineonaranneyday.com/trade-partners con este correo.'
    : 'The link keeps you signed in on that device for 90 days. After that, sign in at sunshineonaranneyday.com/trade-partners with this email address.';
  return {
    subject: es ? `${reminder ? 'Recordatorio: ' : ''}Configure su cuenta con Sunshine on a Ranney Day` : `${reminder ? 'A reminder: set' : 'Set'} up your account with Sunshine on a Ranney Day`,
    html: emailShell({ preheader: lead, heading: es ? 'Bienvenido' : 'Welcome aboard', bodyHtml: `${paragraphs(hi)}${paragraphs(lead)}${button(es ? 'Configurar mi cuenta' : 'Set up my account', url)}${paragraphs(after, 'font-size:14px;')}` }),
    text: [hi, '', lead, '', url, '', after].join('\n'),
  };
}

/**
 * Admin: invite a trade partner — an existing JobTread vendor (jtId) or a new one (company + contact).
 * → { jtId, url, created }
 */
export async function invitePartner(env, { jtId = null, company = '', name = '', email = '', phone = '', lang = 'en', by = 'staff' }, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensurePartnerSchema(env.DB);
  const e = clean(email, 120).toLowerCase();
  if (!isEmail(e)) throw bad('Add the email address to send the invitation to.', 'email');
  let created = false;
  let vendorName;
  if (jtId) {
    const c = await readCompany(env, jtId, { fetchImpl });
    if (!c || c.archived) throw Object.assign(new Error('JobTread has no such vendor'), { status: 404 });
    vendorName = c.name;
    // Someone new at a vendor JobTread has: their main contact when it has none, else just a contact
    if (!c.contacts.some((x) => x.email === e)) {
      const who = { name: clean(name, 80) || e, email: e, phone: phoneOf(phone) };
      if (!c.contacts.some((x) => x.role === 'main')) await putContact(env, c.id, c, 'main', who, fetchImpl);
      else await jt(env, { createContact: { $: { accountId: c.id, name: who.name, title: 'Contact', customFieldValues: { [FIELD_CONTACT_EMAIL]: e, ...(who.phone ? { [FIELD_CONTACT_PHONE]: who.phone } : {}) } }, createdContact: { id: {} } } }, fetchImpl);
    }
  } else {
    vendorName = clean(company, 120);
    if (vendorName.length < 2) throw bad('Add the company’s name.', 'company');
    const made = await jt(env, { createAccount: { $: { organizationId: SOARD_ORG_ID, name: vendorName, type: 'vendor', suffixIfNecessary: true }, createdAccount: { id: {}, name: {} } } }, fetchImpl);
    jtId = made?.createAccount?.createdAccount?.id;
    if (!jtId) throw new Error('JobTread didn’t make the vendor');
    vendorName = made.createAccount.createdAccount.name || vendorName;
    created = true;
    const fields = { [FIELD_CONTACT_EMAIL]: e, ...(phoneOf(phone) ? { [FIELD_CONTACT_PHONE]: phoneOf(phone) } : {}) };
    await jt(env, { createContact: { $: { accountId: jtId, name: clean(name, 80) || e, title: ROLES.main, customFieldValues: fields }, createdContact: { id: {} } } }, fetchImpl);
  }
  await rememberVendor(env.DB, { jtId, name: vendorName, emails: [e] });
  const link = await createLink(env.DB, jtId, { by: `invite:${by}`, now });
  const mail = inviteEmail({ vendorName, contactName: name, url: link.url, lang });
  const r = await sendEmails(env, { to: [e], subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-invite' }] });
  if (!r.sent) throw new Error(r.errors[0] || 'The invitation didn’t send');
  const p = await readProfileRow(env.DB, jtId);
  await patchProfile(env.DB, jtId, { invitedAt: new Date(now).toISOString(), invitedBy: by, lang: lang === 'es' ? 'es' : p.lang, reminders: 0, remindedAt: null }, now);
  await vendorNote(env, jtId, 'Invited to set up as a trade partner', `${by} invited ${vendorName} to set up their trade-partner account (sent to ${e}) on ${longDate(isoDay(now))}.`, fetchImpl);
  return { jtId, url: link.url, created, name: vendorName };
}

/** Admin: a "Work with us" request approved (made into a vendor and invited), matched to one JobTread has, or declined */
export async function decideRequest(env, id, { decision, by, jtId = null, reason = '' }, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensurePartnerSchema(env.DB);
  const r = requestRow(await env.DB.prepare('SELECT * FROM vendor_requests WHERE id = ?').bind(id).first());
  if (!r) throw Object.assign(new Error('There’s no such request'), { status: 404 });
  if (r.status !== 'new') throw Object.assign(new Error(`It was already ${r.status} by ${r.decidedBy}`), { status: 409 });
  const iso = new Date(now).toISOString();
  if (decision === 'decline') {
    const es = r.lang === 'es';
    const words = es
      ? `Gracias por su interés en trabajar con Sunshine on a Ranney Day. Por ahora no tenemos trabajo para ${r.company}, pero guardaremos sus datos y le escribiremos si eso cambia.`
      : `Thank you for your interest in working with Sunshine on a Ranney Day. We don’t have work for ${r.company} right now, but we’ll keep your details and reach out if that changes.`;
    await sendEmails(env, { to: [r.email], subject: es ? 'Su solicitud a Sunshine on a Ranney Day' : 'Your request to work with Sunshine on a Ranney Day', html: emailShell({ preheader: words, heading: es ? 'Gracias' : 'Thank you', bodyHtml: paragraphs(words) }), text: words, tags: [{ name: 'type', value: 'vendor-request' }] }).catch(() => null);
    await env.DB.prepare("UPDATE vendor_requests SET status = 'declined', decided_by = ?, decided_at = ?, reason = ? WHERE id = ?").bind(by, iso, clean(reason, 300) || null, id).run();
  } else {
    const made = await invitePartner(env, { jtId, company: r.company, name: r.name, email: r.email, phone: r.phone, lang: r.lang, by }, { now, fetchImpl });
    if (made.created) {
      const ids = await jtSetup(env, { fetchImpl });
      await writeFields(env, ids, made.jtId, {}, fetchImpl);
      await jt(env, { updateAccount: { $: { id: made.jtId, customFieldValues: { [ids.fields.trades.id]: tradesValue(ids, r.trades) } } } }, fetchImpl).catch(() => null);
    }
    await env.DB.prepare(`UPDATE vendor_requests SET status = ?, decided_by = ?, decided_at = ?, jt_id = ? WHERE id = ?`).bind(jtId ? 'matched' : 'approved', by, iso, made.jtId, id).run();
  }
  await slackResolved(env, `vendor:request:${id}`, slackCard({ icon: decision === 'decline' ? '👋' : '✅', title: `${r.company}: ${decision === 'decline' ? 'declined' : 'invited'}` }), { summary: `${by} ${decision === 'decline' ? 'declined' : 'approved'} it in the admin.` }).catch(() => null);
  return requestRow(await env.DB.prepare('SELECT * FROM vendor_requests WHERE id = ?').bind(id).first());
}

// ─── The heartbeat: nudges ──────────────────────────────────────────

/** Every vendors run (./_vendors.js): unfinished setups nudged, agents reminded, renewals asked of agents → { reminded, agents } */
export async function partnerNudges(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensurePartnerSchema(env.DB);
  const out = { reminded: 0, agents: 0 };
  const rows = ((await env.DB.prepare('SELECT * FROM vendor_profiles WHERE (invited_at IS NOT NULL AND done_at IS NULL) OR agent IS NOT NULL').all()).results || []).map(profileRow);
  for (const p of rows) {
    if (out.reminded + out.agents >= 10) break;
    // An invitation not finished: reminded after 2 days, then 5, then left alone
    if (p.invitedAt && !p.doneAt && p.reminders < REMIND_DAYS.length && now - Date.parse(p.remindedAt || p.invitedAt) >= REMIND_DAYS[p.reminders] * DAY - (p.reminders ? REMIND_DAYS[p.reminders - 1] * DAY : 0)) {
      const company = await readCompany(env, p.jtId, { fetchImpl }).catch(() => null);
      const main = company?.contacts.find((c) => c.role === 'main');
      if (company && !company.archived && isEmail(main?.email)) {
        const link = await createLink(env.DB, p.jtId, { by: 'reminder', now });
        const mail = inviteEmail({ vendorName: company.name, contactName: main.name, url: link.url, lang: p.lang, reminder: true });
        const r = await sendEmails(env, { to: [main.email], subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-invite' }] }).catch(() => ({ sent: 0 }));
        if (r.sent) { await patchProfile(env.DB, p.jtId, { reminders: p.reminders + 1, remindedAt: new Date(now).toISOString() }, now); out.reminded++; }
      }
    }
    // An agent asked who hasn't answered: reminded after 3 days, then 7
    const a = p.agent;
    if (a?.open && a.askedAt && (a.asks || 0) <= AGENT_REMIND_DAYS.length && now - Date.parse(a.askedAt) >= (AGENT_REMIND_DAYS[(a.asks || 1) - 1] ?? 7) * DAY) {
      const v = await readJtVendor(env, p.jtId, { fetchImpl }).catch(() => null);
      const state = v && docsState(v, await readDocSettings(env.DB), { now });
      if (state && state.needs.includes('coi')) {
        if ((a.asks || 0) < AGENT_REMIND_DAYS.length + 1) await askAgent(env, p.jtId, { reminder: true, renewal: !!a.renewal, by: 'reminder', now, fetchImpl }).then(() => out.agents++).catch(() => null);
      } else if (state) await patchProfile(env.DB, p.jtId, { agent: { ...a, open: false } }, now);
    }
  }
  return out;
}

/** The sweep's renewal ask for a vendor whose agent is on file: the agent hears too (once per renewal) */
export async function renewalToAgent(env, jtId, state, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!state?.needs?.includes('coi')) return false;
  const p = await readProfileRow(env.DB, jtId);
  if (!isEmail(p.agent?.email) || p.agent.open) return false;
  await askAgent(env, jtId, { renewal: state.ok && state.expiring, by: 'renewal', now, fetchImpl });
  return true;
}

/** A W-9 or certificate that checked out, uploaded on the page (./_vendors.js fileUpload): the step is done, and an agent's ask is answered */
export async function docArrived(env, jtId, doc, { now = Date.now() } = {}) {
  await ensurePartnerSchema(env.DB);
  const p = await readProfileRow(env.DB, jtId);
  if (doc === 'coi' && p.agent?.open) await patchProfile(env.DB, jtId, { agent: { ...p.agent, open: false, answeredAt: new Date(now).toISOString() } }, now);
  await stepDone(env.DB, jtId, doc, now);
}

// ─── Admin → Trade partners ─────────────────────────────────────────

/** Every JobTread vendor, as the 4-hourly cache has them, with where each stands → [partner] (see the admin) */
export async function listPartners(env, { now = Date.now() } = {}) {
  await ensurePartnerSchema(env.DB);
  const req = await readDocSettings(env.DB);
  const rows = (await env.DB.prepare(`SELECT v.jt_id, v.name, v.email, v.facts, a.state, a.open AS asking, a.asks, a.asked_at,
      p.invited_at, p.done_at, p.agent, b.status AS bank, b.last4
      FROM vendors v LEFT JOIN vendor_asks a ON a.jt_id = v.jt_id LEFT JOIN vendor_profiles p ON p.jt_id = v.jt_id LEFT JOIN vendor_bank b ON b.jt_id = v.jt_id
      WHERE v.jt_id IS NOT NULL ORDER BY v.name COLLATE NOCASE`).all()).results || [];
  const held = new Map();
  const add = (id, cents) => { if (!id) return; const h = held.get(id) || { bills: 0, cents: 0 }; h.bills++; h.cents += cents || 0; held.set(id, h); };
  for (const r of await env.DB.prepare("SELECT b.account_id, COALESCE(b.balance, b.cents) AS cents FROM bill_approvals a JOIN spend_bills b ON b.id = a.bill_id WHERE a.pay_state = 'held'").all().then((x) => x.results || [], () => [])) add(r.account_id, r.cents);
  for (const r of await env.DB.prepare("SELECT account_id, cents FROM ramp_holds WHERE state = 'held'").all().then((x) => x.results || [], () => [])) add(r.account_id, r.cents);
  return rows.map((r) => {
    const facts = parseJson(r.facts);
    const f = facts.fields || null;
    const brief = f ? briefState(docsState({ w9: f.w9, glExpires: f.gl, wcExpires: f.wc, docs: f.docs }, req, { now })) : parseJson(r.state, null);
    const status = !brief ? 'unknown' : f?.docs === 'Not needed' ? 'not-needed' : !brief.ok ? 'needs' : brief.expiring ? 'expiring' : 'current';
    return {
      jtId: r.jt_id, name: r.name, email: r.email, trades: f?.trades || [], materials: !!f?.materials, docsField: f?.docs || null,
      status, label: brief?.label || null, staff: brief?.staff || '', w9: f ? !!f.w9 : null, glExpires: f?.gl || null, wcExpires: f?.wc || null,
      jobs: (facts.jobs || []).length, asking: !!r.asking, asks: r.asks || 0, askedAt: r.asked_at || null,
      setup: r.invited_at ? (r.done_at ? 'done' : 'started') : null, invitedAt: r.invited_at || null, doneAt: r.done_at || null,
      bank: r.bank ? { status: r.bank, last4: r.last4 } : null, agent: parseJson(r.agent, null)?.email || null, held: held.get(r.jt_id) || null,
    };
  });
}

/** One partner in full, live from JobTread → { company, docs, files, invoices, bank, agent, profile } */
export async function partnerDetail(env, jtId, { now = Date.now(), fetchImpl = fetch } = {}) {
  await ensurePartnerSchema(env.DB);
  const [company, v] = await Promise.all([readCompany(env, jtId, { fetchImpl }), readJtVendor(env, jtId, { fetchImpl })]);
  if (!company || !v) throw Object.assign(new Error('JobTread has no such vendor'), { status: 404 });
  const ids = await jtSetup(env, { fetchImpl });
  const req = await readDocSettings(env.DB);
  const state = docsState(v, req, { now });
  const d = await jt(env, { account: { $: { id: jtId }, files: { $: { size: 30, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {}, name: {}, url: {}, createdAt: {}, fileTags: { $: { size: 5 }, nodes: { id: {} } } } } } }, fetchImpl).catch(() => null);
  const files = (d?.account?.files?.nodes || [])
    .map((f) => ({ id: f.id, name: f.name, url: f.url, at: f.createdAt || null, tag: (f.fileTags?.nodes || []).some((t) => t.id === ids.tags.w9) ? 'W-9' : (f.fileTags?.nodes || []).some((t) => t.id === ids.tags.coi) ? 'COI' : null }))
    .filter((f) => f.tag);
  const [profile, bank, invoices, ask] = await Promise.all([readProfileRow(env.DB, jtId), readBank(env.DB, jtId), partnerInvoices(env.DB, jtId, { now }), readAsk(env.DB, jtId)]);
  return {
    jtId, name: company.name, url: jtVendorUrl(jtId), trades: company.trades, address: company.address, license: company.license, materials: company.materials,
    contacts: company.contacts.map((c) => ({ name: c.name, title: c.title, email: c.email, phone: c.phone, role: c.role })),
    docs: { label: state.label, ok: state.ok, expiring: state.expiring, staff: state.staff, w9: v.w9, glExpires: v.glExpires, wcExpires: v.wcExpires, docsField: v.docs, check: v.check },
    files, invoices, bank, agent: profile.agent, steps: profile.steps, invitedAt: profile.invitedAt, invitedBy: profile.invitedBy, doneAt: profile.doneAt, lang: profile.lang,
    ask: ask && { asks: ask.asks, askedAt: ask.askedAt, open: ask.open, why: ask.why },
  };
}

/** A person's call, written to JobTread: materials only (a supplier, never asked for insurance) and/or Documents "Not needed" */
export async function markPartner(env, jtId, { materials, notNeeded }, by, { now = Date.now(), fetchImpl = fetch } = {}) {
  const ids = await jtSetup(env, { fetchImpl });
  const v = await readJtVendor(env, jtId, { fetchImpl });
  if (!v) throw Object.assign(new Error('JobTread has no such vendor'), { status: 404 });
  const patch = {};
  const said = [];
  if (typeof materials === 'boolean') { patch.materials = materials; said.push(materials ? 'marked them materials only (a supplier)' : 'marked them not materials only'); }
  if (typeof notNeeded === 'boolean') {
    if (notNeeded) { patch.docs = 'Not needed'; said.push('set Documents to Not needed'); }
    else if (v.docs === 'Not needed') { patch.docs = docsState({ ...v, docs: null }, await readDocSettings(env.DB), { now }).label; said.push('took Not needed off'); }
  }
  if (!said.length) return { ok: true };
  await writeFields(env, ids, jtId, patch, fetchImpl);
  await vendorNote(env, jtId, 'Changed in Admin → Trade partners', `${by} ${said.join(' and ')} on ${longDate(isoDay(now))}.`, fetchImpl);
  const row = await env.DB.prepare('SELECT id, facts FROM vendors WHERE jt_id = ?').bind(jtId).first();
  if (row) {
    const facts = parseJson(row.facts);
    if (facts.fields) {
      if ('materials' in patch) facts.fields.materials = patch.materials;
      if ('docs' in patch) facts.fields.docs = patch.docs;
      await env.DB.prepare('UPDATE vendors SET facts = ? WHERE id = ?').bind(JSON.stringify(facts), row.id).run();
    }
  }
  return { ok: true };
}

/** Email a partner their page: the setup invitation when they haven't finished, else a sign-in link → { to } */
export async function sendPartnerLink(env, jtId, by, { now = Date.now(), fetchImpl = fetch } = {}) {
  const company = await readCompany(env, jtId, { fetchImpl });
  if (!company || company.archived) throw Object.assign(new Error('JobTread has no such vendor'), { status: 404 });
  const who = company.contacts.find((c) => c.role === 'main' && isEmail(c.email)) || company.contacts.find((c) => isEmail(c.email) && c.role !== 'agent');
  if (!who) throw Object.assign(new Error(`There’s no email for ${company.name} in JobTread. Add one to their main contact first.`), { status: 409 });
  const p = await readProfileRow(env.DB, jtId);
  if (!p.doneAt) return { ...(await invitePartner(env, { jtId, email: who.email, name: who.name, lang: p.lang, by }, { now, fetchImpl })), to: who.email };
  const l = await createLink(env.DB, jtId, { by: `staff:${by}`, now });
  const mail = signInEmail({ links: [{ name: company.name, url: l.url }], lang: p.lang });
  await sendEmails(env, { to: [who.email], subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-signin' }] });
  return { to: who.email };
}

/** Bank accounts waiting for SOARD's call, with the phone that was on file → [{ jtId, name, last4, kind, changedAt, previousLast4, phone }] */
export async function bankToConfirm(env, { fetchImpl = fetch } = {}) {
  await ensurePartnerSchema(env.DB);
  const rows = (await env.DB.prepare(`SELECT b.*, v.name FROM vendor_bank b LEFT JOIN vendors v ON v.jt_id = b.jt_id ORDER BY b.status = 'pending' DESC, b.changed_at DESC LIMIT 60`).all()).results || [];
  return Promise.all(rows.map(async (r) => {
    const c = r.status === 'pending' ? await readCompany(env, r.jt_id, { fetchImpl }).catch(() => null) : null;
    const main = c?.contacts.find((x) => x.role === 'main');
    return { ...bankRow(r), name: r.name || c?.name || r.jt_id, kindLabel: ACCOUNT_TYPES[r.kind] || r.kind, phone: main?.phone || null, contact: main?.name || null };
  }));
}

/** For the admin and the automations map */
export async function partnerFacts(DB) {
  await ensurePartnerSchema(DB);
  const [req, bank, setup, st] = await Promise.all([
    DB.prepare("SELECT COUNT(*) AS n FROM vendor_requests WHERE status = 'new'").first(),
    DB.prepare("SELECT COUNT(*) AS n FROM vendor_bank WHERE status = 'pending'").first(),
    DB.prepare('SELECT COUNT(*) AS n FROM vendor_profiles WHERE invited_at IS NOT NULL AND done_at IS NULL').first(),
    readState(DB, STATE_KEY),
  ]);
  return { requests: req?.n || 0, bankToConfirm: bank?.n || 0, settingUp: setup?.n || 0, fieldDupes: st.jt?.dupes || [], fieldSingle: st.jt?.single || [] };
}

export { dollars, LIMITS };
