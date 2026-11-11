/**
 * "Edit words": staff's own words in place of the site's, in the emails the
 * site drafts in Kit by itself. Only the words: the subject, the preview line,
 * the opening, the give band's headline and words, and the closing line. Every
 * draft still takes its facts from JobTread and the pages (a new reveal date
 * still reaches it), and a box left empty keeps the site's words.
 *
 * Kept by email, one row each:
 *   invite:<job>    the reveal invite (Reveal Emails group), by JobTread job
 *   watch:<job>     its whole-list copy, to watch live
 *   kickoff:<kid>   Project Kickoff, by the kid's page
 *   reveal:<kid>    Project Reveal
 *   recap:<event>   Event Recap, by the event's page
 *   monthly:<YYYY-MM>  Monthly Impact
 *
 * A draft nobody has changed in Kit takes new words the way it takes a new
 * design; one a person changed in Kit is left as they made it. The invites have
 * no give band, so no give band words.
 */

export const WORD_PARTS = Object.freeze({
  subject: Object.freeze({ max: 150, label: 'Subject' }),
  preview: Object.freeze({ max: 150, label: 'Preview line' }),
  opening: Object.freeze({ max: 1500, label: 'Opening', many: true }),
  askHeadline: Object.freeze({ max: 100, label: 'Give band headline' }),
  askWords: Object.freeze({ max: 400, label: 'Give band words' }),
  closing: Object.freeze({ max: 160, label: 'Closing line' }),
});
const ALL = Object.freeze(Object.keys(WORD_PARTS));
const NO_ASK = Object.freeze(['subject', 'preview', 'opening', 'closing']);

/** Each email and the parts it has */
export const EMAIL_WORDS = Object.freeze({
  invite: Object.freeze({ parts: NO_ASK, what: 'reveal invite' }),
  watch: Object.freeze({ parts: NO_ASK, what: 'whole-list invite' }),
  kickoff: Object.freeze({ parts: ALL, what: 'Project Kickoff' }),
  reveal: Object.freeze({ parts: ALL, what: 'Project Reveal' }),
  recap: Object.freeze({ parts: ALL, what: 'Event Recap' }),
  monthly: Object.freeze({ parts: ALL, what: 'Monthly Impact' }),
});

const JOB = /^[A-Za-z0-9]{6,32}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** "reveal:remi-and-nico" → { kind, id }, or null for anything that isn't one of the emails */
export function parseWordsKey(key) {
  const m = /^([a-z]+):(.+)$/.exec(String(key || ''));
  if (!m || !EMAIL_WORDS[m[1]]) return null;
  const [, kind, id] = m;
  const ok = kind === 'invite' || kind === 'watch' ? JOB.test(id) : kind === 'monthly' ? MONTH.test(id) : SLUG.test(id);
  return ok ? { kind, id } : null;
}
export const wordsKey = (kind, id) => `${kind}:${id}`;

/**
 * What staff typed, cut to what the email has room for: only its own parts,
 * each trimmed to its length; the opening keeps its paragraphs, every other
 * part is one line. Empty parts are left out (the site's words).
 */
export function cleanWords(kind, input = {}) {
  const out = {};
  for (const k of EMAIL_WORDS[kind]?.parts || []) {
    const raw = String(input?.[k] ?? '').replace(/\r\n?/g, '\n');
    const one = WORD_PARTS[k].many
      ? raw.split(/\n\s*\n/).map((p) => p.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()).filter(Boolean).join('\n\n')
      : raw.replace(/\s+/g, ' ').trim();
    const v = one.slice(0, WORD_PARTS[k].max).trim();
    if (v) out[k] = v;
  }
  return out;
}

/** Saved words in a stable order, so the same words always make the same hash */
const ordered = (words) => ALL.filter((k) => words?.[k]).map((k) => [k, words[k]]);
/** A short fingerprint of the words; '' for none (the site's own words) */
export async function wordsHash(words) {
  const list = ordered(words);
  if (!list.length) return '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(list)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

const SCHEMA = 'CREATE TABLE IF NOT EXISTS email_words (key TEXT PRIMARY KEY, words TEXT NOT NULL, hash TEXT NOT NULL, by TEXT, updated_at TEXT)';
const _ready = new WeakSet();
export async function ensureWordsSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}

/** An email's saved words → { words, hash, by, at }. None saved: { words: {}, hash: '' }. */
export async function readWords(DB, key) {
  await ensureWordsSchema(DB);
  const row = await DB.prepare('SELECT words, hash, by, updated_at FROM email_words WHERE key = ?').bind(key).first();
  if (!row) return { words: {}, hash: '', by: null, at: null };
  let words = {};
  try { words = JSON.parse(row.words) || {}; } catch { /* unreadable: the site's own words */ }
  const parsed = parseWordsKey(key);
  const clean = parsed ? cleanWords(parsed.kind, words) : {};
  return { words: clean, hash: await wordsHash(clean), by: row.by || null, at: row.updated_at || null };
}

/** Keep an email's words; none at all puts it back to the site's own. → { words, hash } as kept */
export async function saveWords(DB, key, input, { by = null, now = Date.now() } = {}) {
  const parsed = parseWordsKey(key);
  if (!parsed) throw new Error('Not one of the emails');
  await ensureWordsSchema(DB);
  const words = cleanWords(parsed.kind, input);
  const hash = await wordsHash(words);
  if (!hash) await DB.prepare('DELETE FROM email_words WHERE key = ?').bind(key).run();
  else {
    await DB.prepare('INSERT OR REPLACE INTO email_words (key, words, hash, by, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(key, JSON.stringify(Object.fromEntries(ordered(words))), hash, by, new Date(now).toISOString()).run();
  }
  return { words, hash };
}
