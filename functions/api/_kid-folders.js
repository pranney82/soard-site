/**
 * Dropbox folders to name: which kid each one is
 * ===============================================
 * Dropbox's Makeover Photos holds one folder per makeover (209, 2012–2026).
 * Most match a kid page by name and year; the ones that don't are listed in
 * Admin → Kids for a person to name (Peter, Nov 10 2026: "linzi will do
 * this"): the kid page it belongs to, a kid with no page yet (name and
 * year), or not a makeover at all. Her answers are what the past-makeover
 * JobTread jobs and the photo copy go by.
 *
 * The folder names live only in D1 (table kid_folders), never in the repo:
 * some are children with no public page, and the repo is public. Rows are
 * added once from the Dropbox migration's file list; this file only reads
 * them, guesses from the kid pages, and saves a person's answer.
 */

export const SCHEMA = `CREATE TABLE IF NOT EXISTS kid_folders (
  folder TEXT PRIMARY KEY, photos INTEGER NOT NULL DEFAULT 0, videos INTEGER NOT NULL DEFAULT 0,
  decision TEXT, kid_slug TEXT, new_name TEXT, new_year INTEGER, note TEXT,
  decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL)`;
export const DECISIONS = ['kid', 'new', 'not'];
const YEAR_MIN = 2010;
const YEAR_MAX = 2030;

const _ready = new WeakSet();
export async function ensureKidFolders(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => fold(s).replace(/['’]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !/^\d+$/.test(w));
const yearOf = (s) => { const m = String(s || '').match(/\b(20\d\d)\b/); return m ? Number(m[1]) : null; };

/** Where the folder opens in Dropbox's website (the team's SOARD-Main space) */
export const dropboxUrl = (folder) => `https://www.dropbox.com/home/SOARD-Main/Makeover%20Photos/${encodeURIComponent(folder)}`;

/**
 * Kid pages this folder could be: the first name in the folder matches a
 * name on the page, closest year first, at most 4 → [{ slug, name, year }]
 */
export function guessesFor(folder, kids) {
  const first = words(folder)[0];
  if (!first) return [];
  const y = yearOf(folder);
  return kids
    .filter((k) => words(k.name).includes(first) && (y === null || k.year == null || Math.abs(Number(k.year) - y) <= 1))
    .sort((a, b) => (y === null ? 0 : Math.abs(Number(a.year) - y) - Math.abs(Number(b.year) - y)) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 4)
    .map((k) => ({ slug: k.slug, name: k.name, year: k.year ?? null }));
}

const fromRow = (r, kids) => ({
  folder: r.folder, photos: r.photos || 0, videos: r.videos || 0,
  decision: r.decision || null, kidSlug: r.kid_slug || null, newName: r.new_name || null, newYear: r.new_year || null, note: r.note || null,
  decidedBy: r.decided_by || null, decidedAt: r.decided_at || null,
  url: dropboxUrl(r.folder), guesses: guessesFor(r.folder, kids),
});

/** Every folder to name, unanswered first, then by name → [{ folder, photos, videos, decision, …, url, guesses }] */
export async function listFolders(DB, kids) {
  await ensureKidFolders(DB);
  const { results } = await DB.prepare('SELECT * FROM kid_folders').all();
  return (results || []).map((r) => fromRow(r, kids))
    .sort((a, b) => (a.decision ? 1 : 0) - (b.decision ? 1 : 0) || a.folder.localeCompare(b.folder));
}

/**
 * A person's answer, checked: { folder, decision: 'kid' | 'new' | 'not' | null, kidSlug?, newName?, newYear?, note? }
 * → { ok: true, row } or { ok: false, error } (error in words for the admin)
 */
export function checkAnswer(body, kids) {
  const folder = String(body?.folder || '').trim();
  if (!folder) return { ok: false, error: 'Which folder?' };
  const decision = body?.decision ?? null;
  if (decision !== null && !DECISIONS.includes(decision)) return { ok: false, error: 'Pick a kid page, a kid with no page, or not a makeover.' };
  const note = String(body?.note || '').trim().slice(0, 500) || null;
  if (decision === 'kid') {
    const kid = kids.find((k) => k.slug === body?.kidSlug);
    if (!kid) return { ok: false, error: 'That kid page wasn’t found. Pick one from the list.' };
    return { ok: true, row: { folder, decision, kid_slug: kid.slug, new_name: null, new_year: null, note } };
  }
  if (decision === 'new') {
    const newName = String(body?.newName || '').trim().slice(0, 120);
    const newYear = Number(body?.newYear);
    if (!newName) return { ok: false, error: 'Type the kid’s name.' };
    if (!Number.isInteger(newYear) || newYear < YEAR_MIN || newYear > YEAR_MAX) return { ok: false, error: `The year of the makeover, ${YEAR_MIN} to ${YEAR_MAX}.` };
    return { ok: true, row: { folder, decision, kid_slug: null, new_name: newName, new_year: newYear, note } };
  }
  return { ok: true, row: { folder, decision, kid_slug: null, new_name: null, new_year: null, note: decision ? note : null } };
}

/** Save an answer (decision null clears it) → the saved folder, or null when there's no such folder */
export async function saveAnswer(DB, row, { by, now = Date.now(), kids = [] } = {}) {
  await ensureKidFolders(DB);
  const at = row.decision ? new Date(now).toISOString() : null;
  const r = await DB.prepare('UPDATE kid_folders SET decision = ?, kid_slug = ?, new_name = ?, new_year = ?, note = ?, decided_by = ?, decided_at = ? WHERE folder = ?')
    .bind(row.decision, row.kid_slug, row.new_name, row.new_year, row.note, row.decision ? by || null : null, at, row.folder).run();
  if (!r?.meta?.changes) return null;
  const saved = await DB.prepare('SELECT * FROM kid_folders WHERE folder = ?').bind(row.folder).first();
  return saved ? fromRow(saved, kids) : null;
}
