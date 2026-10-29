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
 * email, the service area (its outline, how far out counts as close, and
 * whether families farther out can still apply) and when status emails go
 * out. They're
 * rules, not wording, so they save straight away instead of waiting for the
 * form's Put live (and never drag a half-finished form edit live with them).
 * They live in application_form_rules (one row) and are laid over every form
 * this module hands out: the live one, the draft and formFor() for any
 * version, so a new application is checked against today's boundary whichever
 * version the family answered. History compares (diffForm on a version) read
 * the versions as stored. No row yet = the form's own values.
 *
 * Two forms: the family application and the organization one
 * (./_application-form-org.js). Each kind has its own versions (a `kind`
 * column), draft, live form and settings; every function takes { kind }
 * and defaults to the family form. Organizations share the family form's
 * service area, so the map has one outline; their own settings are who gets
 * the new-application email and when status emails go out
 * (application_form_rules_kinds).
 */

import { DEFAULT_DEFINITION, normalizeDefinition, validateDefinition, resolveForm, diffDefinitions, kindOf, defaultDefinitionFor, englishStrings, translationStatus } from './_application-form.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS application_form_versions (
    version INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, definition TEXT NOT NULL,
    note TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT,
    live_at TEXT, live_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_application_form_versions_state ON application_form_versions(state)`,
  `CREATE TABLE IF NOT EXISTS application_form_rules (
    id INTEGER PRIMARY KEY CHECK (id = 1), rules TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
  // The settings of the other forms (the organization application), one row each
  `CREATE TABLE IF NOT EXISTS application_form_rules_kinds (
    kind TEXT PRIMARY KEY, rules TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
  // Every service-area outline that was ever live, newest last (Settings → Service area → History)
  `CREATE TABLE IF NOT EXISTS application_area_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, polygon TEXT NOT NULL, at TEXT NOT NULL, by_user TEXT, note TEXT)`,
];

/** The definition keys that are settings (saved at once) rather than form wording */
export const RULE_KEYS = ['staffEmails', 'serviceArea', 'notify'];
/**
 * An organization form's own settings: only who gets its new-application email. Its service
 * area and email timing are the family form's, and so is that list until staff give it its own.
 */
const KIND_RULE_KEYS = { family: RULE_KEYS, organization: ['staffEmails'] };
const FROM_FAMILY = ['serviceArea', 'notify', 'staffEmails'];
const _ready = new WeakSet();
export async function ensureFormSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  // Which form a version belongs to (added Oct 28 2026); older rows are the family form's
  try { await DB.prepare("ALTER TABLE application_form_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'family'").run(); } catch { /* already there */ }
  _ready.add(DB);
}

const iso = (t = Date.now()) => new Date(t).toISOString();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// The live form is read on every page view and API call; a short per-isolate
// cache keeps that off D1. Putting a version live clears it here, and other
// isolates pick the change up within LIVE_TTL_MS.
const LIVE_TTL_MS = 15 * 1000;
let _live = {}; // kind → { at, row, rules }

export function clearFormCache() { _live = {}; }

/** Just the settings keys of a definition (the ones it has; an organization form's own ones with kind) */
export function pickRules(def, kind = 'family') {
  const out = {};
  for (const k of KIND_RULE_KEYS[kindOf(kind)]) if (def && def[k] !== undefined) out[k] = def[k];
  return out;
}
/** The definition with the saved settings laid over it (a copy; null rules = as it is) */
export function withRules(def, rules) {
  if (!def || !rules) return def;
  return { ...def, ...pickRules(rules) };
}

/** The saved settings of a form: { rules, updatedAt, updatedBy }, or null when none were ever saved */
export async function getFormRules(DB, { kind = 'family' } = {}) {
  if (!DB) return null;
  await ensureFormSchema(DB);
  const r = kindOf(kind) === 'family'
    ? await DB.prepare('SELECT rules, updated_at, updated_by FROM application_form_rules WHERE id = 1').first()
    : await DB.prepare('SELECT rules, updated_at, updated_by FROM application_form_rules_kinds WHERE kind = ?').bind(kindOf(kind)).first();
  const rules = r ? parse(r.rules) : null;
  return rules ? { rules, updatedAt: r.updated_at, updatedBy: r.updated_by || null } : null;
}
/** The settings a form runs with: its own, laid over (for an organization form) the family form's as it runs them */
const rulesOrNull = async (DB, kind = 'family') => {
  try {
    const own = (await getFormRules(DB, { kind }))?.rules || null;
    if (kindOf(kind) === 'family') return own;
    const family = (await getLiveForm(DB)).definition || {};
    const merged = { ...Object.fromEntries(FROM_FAMILY.filter(k => family[k] !== undefined).map(k => [k, family[k]])), ...pickRules(own || {}, kind) };
    return Object.keys(merged).length ? merged : null;
  } catch { return null; }
};

function row(r) {
  if (!r) return null;
  return {
    version: r.version, state: r.state, kind: kindOf(r.kind), definition: parse(r.definition), note: r.note || '',
    createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
    liveAt: r.live_at, liveBy: r.live_by,
  };
}

const BUILT_IN = { version: 0, state: 'live', kind: 'family', definition: DEFAULT_DEFINITION, note: 'Built-in form (Jotform 2027)', builtIn: true };
const BUILT_IN_ORG = { version: 0, state: 'live', kind: 'organization', definition: defaultDefinitionFor('organization'), note: 'Built-in organization form', builtIn: true };
const builtIn = (kind) => (kindOf(kind) === 'organization' ? BUILT_IN_ORG : BUILT_IN);

/** The version applicants get: { version, definition } (version 0 = built in), settings laid over */
export async function getLiveForm(DB, { now = Date.now(), fresh = false, kind = 'family' } = {}) {
  const k = kindOf(kind);
  if (!DB) return builtIn(k);
  const hit = _live[k];
  if (!fresh && hit && now - hit.at < LIVE_TTL_MS) return hit.row;
  let r = null;
  try {
    await ensureFormSchema(DB);
    r = row(await DB.prepare("SELECT * FROM application_form_versions WHERE state = 'live' AND kind = ? ORDER BY version DESC LIMIT 1").bind(k).first());
  } catch { r = null; }
  const rules = await rulesOrNull(DB, k);
  const base = r?.definition ? r : builtIn(k);
  const out = rules ? { ...base, definition: withRules(base.definition, rules) } : base;
  _live[k] = { at: now, row: out, rules };
  return out;
}
/** The saved settings, read through the live form's cache */
async function cachedRules(DB, kind = 'family') {
  if (!DB) return null;
  const k = kindOf(kind);
  if (!(_live[k] && Date.now() - _live[k].at < LIVE_TTL_MS)) await getLiveForm(DB, { kind: k });
  return _live[k]?.rules || null;
}

/** One version by number (0 = built in); falls back to that kind's built-in form */
export async function getFormVersion(DB, version, { kind = 'family' } = {}) {
  const v = Number(version) || 0;
  if (!v || !DB) return builtIn(kind);
  try {
    await ensureFormSchema(DB);
    const r = row(await DB.prepare('SELECT * FROM application_form_versions WHERE version = ?').bind(v).first());
    return r?.definition ? r : builtIn(kind);
  } catch {
    return builtIn(kind);
  }
}

/**
 * The resolved form (year filled in, in `lang`) for a version, or the live
 * one. Today's settings apply to every version: they're how the site runs,
 * not what the family read.
 */
export async function formFor(DB, { year, version = null, lang = 'en', kind = 'family' } = {}) {
  const v = version == null ? await getLiveForm(DB, { kind }) : await getFormVersion(DB, version, { kind });
  const def = version == null ? v.definition : withRules(v.definition, await cachedRules(DB, v.kind || kind));
  return resolveForm(def, { year, version: v.version, lang });
}

/** The draft being edited, settings laid over (so it never differs from live on them) */
export async function getDraftForm(DB, { kind = 'family' } = {}) {
  await ensureFormSchema(DB);
  const d = row(await DB.prepare("SELECT * FROM application_form_versions WHERE state = 'draft' AND kind = ? ORDER BY version DESC LIMIT 1").bind(kindOf(kind)).first());
  if (!d?.definition) return d;
  const rules = await rulesOrNull(DB, kind);
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
export async function saveDraftForm(DB, definition, { user = 'admin', note = null, now = Date.now(), base = null, force = false, kind = 'family' } = {}) {
  await ensureFormSchema(DB);
  const k = kindOf(kind);
  const clean = normalizeDefinition({ ...(definition || {}), kind: k });
  const errors = validateDefinition(clean);
  const draft = await getDraftForm(DB, { kind: k });
  if (draft && base !== null && !force && draft.updatedAt !== base && draft.updatedBy && draft.updatedBy !== user) {
    return { conflict: { updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, definition: draft.definition, version: draft.version }, errors: [] };
  }
  const at = iso(now);
  if (draft) {
    await DB.prepare('UPDATE application_form_versions SET definition = ?, note = COALESCE(?, note), updated_at = ?, updated_by = ? WHERE version = ?')
      .bind(JSON.stringify(clean), note, at, user, draft.version).run();
    return { version: draft.version, definition: clean, errors, updatedAt: at };
  }
  const ins = await DB.prepare("INSERT INTO application_form_versions (state, kind, definition, note, created_at, created_by, updated_at, updated_by) VALUES ('draft', ?, ?, ?, ?, ?, ?, ?)")
    .bind(k, JSON.stringify(clean), note, at, user, at, user).run();
  const version = ins?.meta?.last_row_id ?? (await getDraftForm(DB, { kind: k }))?.version;
  return { version, definition: clean, errors, updatedAt: at };
}

/** Make the draft the live form. Refuses while it has problems. */
export async function putDraftLive(DB, { user = 'admin', now = Date.now(), kind = 'family' } = {}) {
  await ensureFormSchema(DB);
  const k = kindOf(kind);
  const draft = await getDraftForm(DB, { kind: k });
  if (!draft) return { ok: false, error: 'There are no changes to put live.' };
  const errors = validateDefinition(normalizeDefinition({ ...draft.definition, kind: k }));
  if (errors.length) return { ok: false, error: 'Fix the problems listed first.', errors };
  await DB.batch([
    DB.prepare("UPDATE application_form_versions SET state = 'old' WHERE state = 'live' AND kind = ?").bind(k),
    DB.prepare("UPDATE application_form_versions SET state = 'live', live_at = ?, live_by = ? WHERE version = ?").bind(iso(now), user, draft.version),
  ]);
  clearFormCache();
  return { ok: true, version: draft.version };
}

/** Change one stored version's definition in place: `edit(def)` returns how many changes it made */
async function editVersion(DB, version, edit) {
  await ensureFormSchema(DB);
  const r = await DB.prepare('SELECT state, kind, definition FROM application_form_versions WHERE version = ?').bind(version).first();
  const def = parse(r?.definition);
  if (!def) return 0;
  const n = edit(def);
  if (!n) return 0;
  const clean = normalizeDefinition({ ...def, kind: kindOf(r.kind) });
  await DB.prepare('UPDATE application_form_versions SET definition = ? WHERE version = ?').bind(JSON.stringify(clean), version).run();
  if (r.state === 'live') clearFormCache();
  return n;
}
const translationsOf = (def, lang) => {
  def.i18n = def.i18n || {};
  const t = def.i18n[lang] = def.i18n[lang] || {};
  t.strings = t.strings || {};
  t.sources = t.sources || {};
  return t;
};

/**
 * Lay machine translations onto one version, nothing else: { path: { text,
 * from } }, where `from` is the English it was made from. Each lands only
 * while that is still the string's English and its Spanish is still missing
 * or out of date, so an edit made meanwhile wins. → how many landed
 */
export async function addTranslations(DB, version, made, { lang = 'es' } = {}) {
  if (!Object.keys(made || {}).length) return 0;
  return editVersion(DB, version, (def) => {
    const en = englishStrings(def);
    const status = translationStatus(def, lang);
    const t = translationsOf(def, lang);
    let n = 0;
    for (const [path, { text, from }] of Object.entries(made)) {
      if (en[path] !== from || status[path] === 'done') continue;
      t.strings[path] = text;
      t.sources[path] = from;
      n++;
    }
    return n;
  });
}

/**
 * Mark Spanish as made from older English: { path: { text, from } }, where
 * `text` is the Spanish judged and `from` the English it was really made
 * from. It then reads out of date (in the admin too) until translated again.
 * Skipped where the Spanish changed meanwhile. → how many were marked
 */
export async function reopenTranslations(DB, version, stale, { lang = 'es' } = {}) {
  if (!Object.keys(stale || {}).length) return 0;
  return editVersion(DB, version, (def) => {
    const t = translationsOf(def, lang);
    let n = 0;
    for (const [path, { text, from }] of Object.entries(stale)) {
      if (t.strings[path] !== text || t.sources[path] === from) continue;
      t.sources[path] = from;
      n++;
    }
    return n;
  });
}

/** The settings as the site uses them: cleaned, with the built-in values filled in */
const cleanRules = (def, kind = 'family') => pickRules(normalizeDefinition(def || defaultDefinitionFor(kind)), kind);
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
  if (a.serviceArea?.nearMiles !== b.serviceArea?.nearMiles) add('serviceArea.nearMiles', a.serviceArea?.nearMiles ?? null, b.serviceArea?.nearMiles ?? null);
  if ((a.serviceArea?.beyond || 'warn') !== (b.serviceArea?.beyond || 'warn')) add('serviceArea.beyond', a.serviceArea?.beyond || 'warn', b.serviceArea?.beyond || 'warn');
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
export async function saveFormRules(DB, patch, { user = 'admin', base = null, force = false, now = Date.now(), kind = 'family' } = {}) {
  await ensureFormSchema(DB);
  const k = kindOf(kind);
  const [saved, live] = await Promise.all([getFormRules(DB, { kind: k }), getLiveForm(DB, { fresh: true, kind: k })]);
  const current = cleanRules(live.definition, k);
  if (saved && base !== null && !force && saved.updatedAt !== base && saved.updatedBy && saved.updatedBy !== user) {
    return { conflict: { rules: current, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } };
  }
  const p = pickRules(patch && typeof patch === 'object' ? patch : {}, k);
  // An organization form's list set back to null: it goes back to the family form's
  const backToFamily = k !== 'family' && p.staffEmails === null;
  if (backToFamily) p.staffEmails = (await getLiveForm(DB, { fresh: true })).definition?.staffEmails;
  // Part of the service area (just the outline, say) keeps the rest as it is
  if (p.serviceArea && typeof p.serviceArea === 'object') p.serviceArea = { ...current.serviceArea, ...p.serviceArea };
  // A part of the timing (just the waits, say) keeps the rest as it is
  if (p.notify && typeof p.notify === 'object') {
    const n = current.notify;
    p.notify = { ...n, ...p.notify, waits: { ...n.waits, ...(p.notify.waits || {}) }, quiet: { ...n.quiet, ...(p.notify.quiet || {}) } };
  }
  const merged = { ...live.definition, ...p };
  const next = cleanRules(merged, k);
  const errors = validateDefinition({ ...normalizeDefinition(merged), ...next }).filter(e => RULE_WHERE.has(e.where));
  if (!next.staffEmails.length) errors.push({ where: 'staffEmails', message: 'Add at least one email address.' });
  if (errors.length) return { errors };
  const changes = ruleChanges(current, next);
  if (backToFamily && saved?.rules?.staffEmails) changes.push({ field: 'application.staffEmails.family', from: false, to: true });
  if (!changes.length) return { rules: current, updatedAt: saved?.updatedAt || null, updatedBy: saved?.updatedBy || null, changes };
  const at = iso(now);
  if (k === 'family') {
    await DB.prepare(`INSERT INTO application_form_rules (id, rules, updated_at, updated_by) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(JSON.stringify(next), at, user).run();
  } else {
    await DB.prepare(`INSERT INTO application_form_rules_kinds (kind, rules, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(k, JSON.stringify(backToFamily ? {} : next), at, user).run();
  }
  if (changes.some(c => c.field === 'application.serviceArea')) await keepOutline(DB, current.serviceArea.polygon, next.serviceArea.polygon, { user, at, since: saved?.updatedAt || null });
  clearFormCache();
  return { rules: next, updatedAt: at, updatedBy: user, changes };
}

/** Note a new outline in the history (the first time, the one it replaced too, as "the original") */
async function keepOutline(DB, before, after, { user, at, since }) {
  const n = await DB.prepare('SELECT COUNT(*) AS n FROM application_area_history').first();
  const stmts = [];
  if (!Number(n?.n)) stmts.push(DB.prepare('INSERT INTO application_area_history (polygon, at, by_user, note) VALUES (?, ?, ?, ?)').bind(JSON.stringify(before), since || at, null, 'The original outline'));
  stmts.push(DB.prepare('INSERT INTO application_area_history (polygon, at, by_user) VALUES (?, ?, ?)').bind(JSON.stringify(after), at, user));
  await DB.batch(stmts);
}

/** The outlines the service area has had, newest first: [{ id, polygon, at, by, note, live }] */
export async function areaHistory(DB, { limit = 20 } = {}) {
  await ensureFormSchema(DB);
  const { results } = await DB.prepare('SELECT id, polygon, at, by_user, note FROM application_area_history ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (results || []).map((r, i) => ({ id: r.id, polygon: parse(r.polygon) || [], at: r.at, by: r.by_user || null, note: r.note || null, live: i === 0 }));
}

export async function discardDraftForm(DB, { kind = 'family' } = {}) {
  await ensureFormSchema(DB);
  await DB.prepare("DELETE FROM application_form_versions WHERE state = 'draft' AND kind = ?").bind(kindOf(kind)).run();
  return { ok: true };
}

/** Copy a version (0 = built in) into the draft, to edit or put live again */
export async function restoreFormVersion(DB, version, { user = 'admin', now = Date.now(), kind = 'family' } = {}) {
  const v = await getFormVersion(DB, version, { kind });
  if (Number(version) && (v.builtIn || v.kind !== kindOf(kind))) return { ok: false, error: 'That version doesn’t exist.' };
  const out = await saveDraftForm(DB, v.definition, { user, now, kind, note: `Restored from ${v.version ? `version ${v.version}` : 'the built-in form'}` });
  return { ok: true, ...out };
}

/** Live and past versions of a form, newest first, plus the draft if any (no definitions) */
export async function listFormVersions(DB, { limit = 30, kind = 'family' } = {}) {
  await ensureFormSchema(DB);
  const { results } = await DB.prepare('SELECT version, state, note, created_at, created_by, updated_at, updated_by, live_at, live_by FROM application_form_versions WHERE kind = ? ORDER BY version DESC LIMIT ?').bind(kindOf(kind), limit).all();
  return (results || []).map(r => ({
    version: r.version, state: r.state, note: r.note || '', createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at, updatedBy: r.updated_by, liveAt: r.live_at, liveBy: r.live_by,
  }));
}

/**
 * What changed: the draft against the live form (version = 'draft'), or a
 * version against the one live before it. [{ kind, area, text }]
 */
export async function diffForm(DB, version, { kind = 'family' } = {}) {
  await ensureFormSchema(DB);
  const k = kindOf(kind);
  if (version === 'draft') {
    const [live, draft] = await Promise.all([getLiveForm(DB, { fresh: true, kind: k }), getDraftForm(DB, { kind: k })]);
    return draft ? diffDefinitions(normalizeDefinition(live.definition), normalizeDefinition(draft.definition)) : [];
  }
  const v = Number(version) || 0;
  if (!v) return [];
  const cur = await getFormVersion(DB, v, { kind: k });
  const prev = await DB.prepare("SELECT version FROM application_form_versions WHERE version < ? AND kind = ? AND state IN ('live', 'old') ORDER BY version DESC LIMIT 1").bind(v, cur.kind || k).first();
  const before = prev ? await getFormVersion(DB, prev.version, { kind: k }) : builtIn(cur.kind || k);
  return diffDefinitions(normalizeDefinition(before.definition), normalizeDefinition(cur.definition));
}

