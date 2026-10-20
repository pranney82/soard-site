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
 */

import { DEFAULT_DEFINITION, normalizeDefinition, validateDefinition, resolveForm } from './_application-form.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS application_form_versions (
    version INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, definition TEXT NOT NULL,
    note TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT,
    live_at TEXT, live_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_application_form_versions_state ON application_form_versions(state)`,
];
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
let _live = null; // { at, row }

export function clearFormCache() { _live = null; }

function row(r) {
  if (!r) return null;
  return {
    version: r.version, state: r.state, definition: parse(r.definition), note: r.note || '',
    createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
    liveAt: r.live_at, liveBy: r.live_by,
  };
}

const BUILT_IN = { version: 0, state: 'live', definition: DEFAULT_DEFINITION, note: 'Built-in form (Jotform 2027)', builtIn: true };

/** The version families get: { version, definition } (version 0 = built in) */
export async function getLiveForm(DB, { now = Date.now(), fresh = false } = {}) {
  if (!DB) return BUILT_IN;
  if (!fresh && _live && now - _live.at < LIVE_TTL_MS) return _live.row;
  let r = null;
  try {
    await ensureFormSchema(DB);
    r = row(await DB.prepare("SELECT * FROM application_form_versions WHERE state = 'live' ORDER BY version DESC LIMIT 1").first());
  } catch { r = null; }
  const out = r?.definition ? r : BUILT_IN;
  _live = { at: now, row: out };
  return out;
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

/** The resolved form (year filled in) for a version, or the live one */
export async function formFor(DB, { year, version = null } = {}) {
  const v = version == null ? await getLiveForm(DB) : await getFormVersion(DB, version);
  return resolveForm(v.definition, { year, version: v.version });
}

export async function getDraftForm(DB) {
  await ensureFormSchema(DB);
  return row(await DB.prepare("SELECT * FROM application_form_versions WHERE state = 'draft' ORDER BY version DESC LIMIT 1").first());
}

/**
 * Save the draft (creating it on first edit). Saves whatever it's given after
 * cleaning, problems and all, so nothing typed is lost; `errors` says what
 * must be fixed before it can go live.
 */
export async function saveDraftForm(DB, definition, { user = 'admin', note = null, now = Date.now() } = {}) {
  await ensureFormSchema(DB);
  const clean = normalizeDefinition(definition);
  const errors = validateDefinition(clean);
  const draft = await getDraftForm(DB);
  if (draft) {
    await DB.prepare('UPDATE application_form_versions SET definition = ?, note = COALESCE(?, note), updated_at = ?, updated_by = ? WHERE version = ?')
      .bind(JSON.stringify(clean), note, iso(now), user, draft.version).run();
    return { version: draft.version, definition: clean, errors };
  }
  const ins = await DB.prepare("INSERT INTO application_form_versions (state, definition, note, created_at, created_by, updated_at, updated_by) VALUES ('draft', ?, ?, ?, ?, ?, ?)")
    .bind(JSON.stringify(clean), note, iso(now), user, iso(now), user).run();
  const version = ins?.meta?.last_row_id ?? (await getDraftForm(DB))?.version;
  return { version, definition: clean, errors };
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
