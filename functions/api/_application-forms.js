/**
 * Versions of the makeover application form (D1)
 * ===========================================================================
 * Admin → Applications → Form edits a draft; "Put live" makes it the form
 * families see, right away (no site Publish). Older live versions stay as
 * history and can be restored into the draft. Version 0 is the built-in form
 * (DEFAULT_DEFINITION) and is what families get until something is put live.
 *
 * Every application records the version it was answered on (applications.
 * form_version) so its PDF and admin view read the questions the family saw.
 *
 * Table application_form_versions: one row per version.
 *   state 'draft' (at most one, being edited) | 'live' (exactly one, or none)
 *   | 'old' (was live)
 *
 * Settings (Admin → Applications → Settings): who gets the new-application
 * email, the service-area boundary and when status emails go out. They're
 * rules, not wording, so they save straight away instead of waiting for the
 * form's Put live (and never drag a half-finished form edit live with them).
 * They live in application_form_rules (one row) and are laid over every form
 * this module hands out: the live one, the draft and formFor() for any
 * version, so a new application is checked against today's boundary whichever
 * version the family answered. History compares (diffForm on a version) read
 * the versions as stored. No row yet = the form's own values.
 */

import { DEFAULT_DEFINITION, normalizeDefinition, validateDefinition, resolveForm, diffDefinitions } from './_application-form.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS application_form_versions (
    version INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, definition TEXT NOT NULL,
    note TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT,
    live_at TEXT, live_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_application_form_versions_state ON application_form_versions(state)`,
  `CREATE TABLE IF NOT EXISTS application_form_rules (
    id INTEGER PRIMARY KEY CHECK (id = 1), rules TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
];

/** The definition keys that are settings (saved at once) rather than form wording */
export const RULE_KEYS = ['staffEmails', 'serviceArea', 'notify'];
const _ready = new WeakSet();
export async function ensureFormSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _ready.add(DB);
}

const iso = (t = Date.now()) => new Date(t).toISOString();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// The live form is read on every page view and API call; a short per-isolate
// cache keeps that off D1. Putting a version live clears it here, and other
// isolates pick the change up within LIVE_TTL_MS.
const LIVE_TTL_MS = 15 * 1000;
let _live = null; // { at, row, rules }

export function clearFormCache() { _live = null; }

/** Just the settings keys of a definition (the ones it has) */
export function pickRules(def) {
  const out = {};
  for (const k of RULE_KEYS) if (def && def[k] !== undefined) out[k] = def[k];
  return out;
}
/** The definition with the saved settings laid over it (a copy; null rules = as it is) */
export function withRules(def, rules) {
  if (!def || !rules) return def;
  return { ...def, ...pickRules(rules) };
}

/** The saved settings: { rules, updatedAt, updatedBy }, or null when none were ever saved */
export async function getFormRules(DB) {
  if (!DB) return null;
  await ensureFormSchema(DB);
  const r = await DB.prepare('SELECT rules, updated_at, updated_by FROM application_form_rules WHERE id = 1').first();
  const rules = r ? parse(r.rules) : null;
  return rules ? { rules, updatedAt: r.updated_at, updatedBy: r.updated_by || null } : null;
}
const rulesOrNull = async (DB) => { try { return (await getFormRules(DB))?.rules || null; } catch { return null; } };

function row(r) {
  if (!r) return null;
  return {
    version: r.version, state: r.state, definition: parse(r.definition), note: r.note || '',
    createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
    liveAt: r.live_at, liveBy: r.live_by,
  };
}

const BUILT_IN = { version: 0, state: 'live', definition: DEFAULT_DEFINITION, note: 'Built-in form (Jotform 2027)', builtIn: true };

/** The version families get: { version, definition } (version 0 = built in), settings laid over */
export async function getLiveForm(DB, { now = Date.now(), fresh = false } = {}) {
  if (!DB) return BUILT_IN;
  if (!fresh && _live && now - _live.at < LIVE_TTL_MS) return _live.row;
  let r = null;
  try {
    await ensureFormSchema(DB);
    r = row(await DB.prepare("SELECT * FROM application_form_versions WHERE state = 'live' ORDER BY version DESC LIMIT 1").first());
  } catch { r = null; }
  const rules = await rulesOrNull(DB);
  const base = r?.definition ? r : BUILT_IN;
  const out = rules ? { ...base, definition: withRules(base.definition, rules) } : base;
  _live = { at: now, row: out, rules };
  return out;
}
/** The saved settings, read through the live form's cache */
async function cachedRules(DB) {
  if (!DB) return null;
  if (!(_live && Date.now() - _live.at < LIVE_TTL_MS)) await getLiveForm(DB);
  return _live?.rules || null;
}

/** One version by number (0 = built in); falls back to the built-in form */
export async function getFormVersion(DB, version) {
  const v = Number(version) || 0;
  if (!v || !DB) return BUILT_IN;
  try {
    await ensureFormSchema(DB);
    const r = row(await DB.prepare('SELECT * FROM application_form_versions WHERE version = ?').bind(v).first());
    return r?.definition ? r : BUILT_IN;
  } catch {
    return BUILT_IN;
  }
}

/**
 * The resolved form (year filled in, in `lang`) for a version, or the live
 * one. Today's settings apply to every version: they're how the site runs,
 * not what the family read.
 */
export async function formFor(DB, { year, version = null, lang = 'en' } = {}) {
  const v = version == null ? await getLiveForm(DB) : await getFormVersion(DB, version);
  const def = version == null ? v.definition : withRules(v.definition, await cachedRules(DB));
  return resolveForm(def, { year, version: v.version, lang });
}

/** The draft being edited, settings laid over (so it never differs from live on them) */
export async function getDraftForm(DB) {
  await ensureFormSchema(DB);
  const d = row(await DB.prepare("SELECT * FROM application_form_versions WHERE state = 'draft' ORDER BY version DESC LIMIT 1").first());
  if (!d?.definition) return d;
  const rules = await rulesOrNull(DB);
  return rules ? { ...d, definition: withRules(d.definition, rules) } : d;
}

/**
 * Save the draft (creating it on first edit). Saves whatever it's given after
 * cleaning, problems and all, so nothing typed is lost; `errors` says what
 * must be fixed before it can go live.
 *
 * Two people editing at once: pass `base` (the updatedAt this editor last
 * saw). If someone else saved since, nothing is written and `conflict` comes
 * back with their draft, unless `force` (they chose to keep their own).
 */
export async function saveDraftForm(DB, definition, { user = 'admin', note = null, now = Date.now(), base = null, force = false } = {}) {
  await ensureFormSchema(DB);
  const clean = normalizeDefinition(definition);
  const errors = validateDefinition(clean);
  const draft = await getDraftForm(DB);
  if (draft && base !== null && !force && draft.updatedAt !== base && draft.updatedBy && draft.updatedBy !== user) {
    return { conflict: { updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, definition: draft.definition, version: draft.version }, errors: [] };
  }
  const at = iso(now);
  if (draft) {
    await DB.prepare('UPDATE application_form_versions SET definition = ?, note = COALESCE(?, note), updated_at = ?, updated_by = ? WHERE version = ?')
      .bind(JSON.stringify(clean), note, at, user, draft.version).run();
    return { version: draft.version, definition: clean, errors, updatedAt: at };
  }
  const ins = await DB.prepare("INSERT INTO application_form_versions (state, definition, note, created_at, created_by, updated_at, updated_by) VALUES ('draft', ?, ?, ?, ?, ?, ?)")
    .bind(JSON.stringify(clean), note, at, user, at, user).run();
  const version = ins?.meta?.last_row_id ?? (await getDraftForm(DB))?.version;
  return { version, definition: clean, errors, updatedAt: at };
}

/** Make the draft the live form. Refuses while it has problems. */
export async function putDraftLive(DB, { user = 'admin', now = Date.now() } = {}) {
  await ensureFormSchema(DB);
  const draft = await getDraftForm(DB);
  if (!draft) return { ok: false, error: 'There are no changes to put live.' };
  const errors = validateDefinition(normalizeDefinition(draft.definition));
  if (errors.length) return { ok: false, error: 'Fix the problems listed first.', errors };
  await DB.batch([
    DB.prepare("UPDATE application_form_versions SET state = 'old' WHERE state = 'live'"),
    DB.prepare("UPDATE application_form_versions SET state = 'live', live_at = ?, live_by = ? WHERE version = ?").bind(iso(now), user, draft.version),
  ]);
  clearFormCache();
  return { ok: true, version: draft.version };
}

/** The settings as the site uses them: cleaned, with the built-in values filled in */
const cleanRules = (def) => pickRules(normalizeDefinition(def || DEFAULT_DEFINITION));
const RULE_WHERE = new Set(['staffEmails', 'serviceArea']);
const hourText = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

/** What changed between two cleaned settings, as audit rows ({ field: 'application.…', from, to }) */
export function ruleChanges(a, b) {
  const out = [];
  const add = (field, from, to) => out.push({ field: `application.${field}`, from, to });
  const ea = (a.staffEmails || []).join(', ');
  const eb = (b.staffEmails || []).join(', ');
  if (ea !== eb) add('staffEmails', ea, eb);
  if (JSON.stringify(a.serviceArea?.polygon || []) !== JSON.stringify(b.serviceArea?.polygon || [])) add('serviceArea', (a.serviceArea?.polygon || []).length, (b.serviceArea?.polygon || []).length);
  for (const k of ['inReview', 'decision', 'welcome']) if (a.notify?.waits?.[k] !== b.notify?.waits?.[k]) add(`notify.waits.${k}`, a.notify?.waits?.[k], b.notify?.waits?.[k]);
  const quiet = (n) => (n?.quiet && n.quiet.start !== n.quiet.end ? `${hourText(n.quiet.start)} to ${hourText(n.quiet.end)}` : 'off');
  if (quiet(a.notify) !== quiet(b.notify)) add('notify.quiet', quiet(a.notify), quiet(b.notify));
  if ((a.notify?.summary !== false) !== (b.notify?.summary !== false)) add('notify.summary', a.notify?.summary !== false, b.notify?.summary !== false);
  return out;
}

/**
 * Save settings: `patch` holds any of staffEmails, serviceArea, notify. They
 * apply at once, to the live form and the draft alike (no Put live). `base`
 * is the updatedAt this editor last saw; if someone else saved since, nothing
 * is written and `conflict` comes back with theirs, unless `force`.
 * → { rules, updatedAt, updatedBy, changes } | { errors } | { conflict }
 */
export async function saveFormRules(DB, patch, { user = 'admin', base = null, force = false, now = Date.now() } = {}) {
  await ensureFormSchema(DB);
  const [saved, live] = await Promise.all([getFormRules(DB), getLiveForm(DB, { fresh: true })]);
  const current = cleanRules(live.definition);
  if (saved && base !== null && !force && saved.updatedAt !== base && saved.updatedBy && saved.updatedBy !== user) {
    return { conflict: { rules: current, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } };
  }
  const p = pickRules(patch && typeof patch === 'object' ? patch : {});
  // A part of the timing (just the waits, say) keeps the rest as it is
  if (p.notify && typeof p.notify === 'object') {
    const n = current.notify;
    p.notify = { ...n, ...p.notify, waits: { ...n.waits, ...(p.notify.waits || {}) }, quiet: { ...n.quiet, ...(p.notify.quiet || {}) } };
  }
  const merged = { ...live.definition, ...p };
  const next = cleanRules(merged);
  const errors = validateDefinition({ ...normalizeDefinition(merged), ...next }).filter(e => RULE_WHERE.has(e.where));
  if (!next.staffEmails.length) errors.push({ where: 'staffEmails', message: 'Add at least one email address.' });
  if (errors.length) return { errors };
  const changes = ruleChanges(current, next);
  if (!changes.length) return { rules: current, updatedAt: saved?.updatedAt || null, updatedBy: saved?.updatedBy || null, changes };
  const at = iso(now);
  await DB.prepare(`INSERT INTO application_form_rules (id, rules, updated_at, updated_by) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(JSON.stringify(next), at, user).run();
  clearFormCache();
  return { rules: next, updatedAt: at, updatedBy: user, changes };
}

export async function discardDraftForm(DB) {
  await ensureFormSchema(DB);
  await DB.prepare("DELETE FROM application_form_versions WHERE state = 'draft'").run();
  return { ok: true };
}

/** Copy a version (0 = built in) into the draft, to edit or put live again */
export async function restoreFormVersion(DB, version, { user = 'admin', now = Date.now() } = {}) {
  const v = await getFormVersion(DB, version);
  if (Number(version) && v.builtIn) return { ok: false, error: 'That version doesn’t exist.' };
  const out = await saveDraftForm(DB, v.definition, { user, now, note: `Restored from ${v.version ? `version ${v.version}` : 'the built-in form'}` });
  return { ok: true, ...out };
}

/** Live and past versions, newest first, plus the draft if any (no definitions) */
export async function listFormVersions(DB, { limit = 30 } = {}) {
  await ensureFormSchema(DB);
  const { results } = await DB.prepare('SELECT version, state, note, created_at, created_by, updated_at, updated_by, live_at, live_by FROM application_form_versions ORDER BY version DESC LIMIT ?').bind(limit).all();
  return (results || []).map(r => ({
    version: r.version, state: r.state, note: r.note || '', createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at, updatedBy: r.updated_by, liveAt: r.live_at, liveBy: r.live_by,
  }));
}

/**
 * What changed: the draft against the live form (version = 'draft'), or a
 * version against the one live before it. [{ kind, area, text }]
 */
export async function diffForm(DB, version) {
  await ensureFormSchema(DB);
  if (version === 'draft') {
    const [live, draft] = await Promise.all([getLiveForm(DB, { fresh: true }), getDraftForm(DB)]);
    return draft ? diffDefinitions(normalizeDefinition(live.definition), normalizeDefinition(draft.definition)) : [];
  }
  const v = Number(version) || 0;
  if (!v) return [];
  const cur = await getFormVersion(DB, v);
  const prev = await DB.prepare("SELECT version FROM application_form_versions WHERE version < ? AND state IN ('live', 'old') ORDER BY version DESC LIMIT 1").bind(v).first();
  const before = prev ? await getFormVersion(DB, prev.version) : BUILT_IN;
  return diffDefinitions(normalizeDefinition(before.definition), normalizeDefinition(cur.definition));
}

