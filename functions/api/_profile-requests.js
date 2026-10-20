/**
 * Profile requests: a private link someone on the Leadership page uses to send
 * their own bio, "why I serve", LinkedIn and photo. The admin makes the link
 * and sends it by hand (nothing goes out automatically); what comes back waits
 * in their record as a suggestion until someone uses or dismisses it.
 *
 * Only a SHA-256 of each token is stored. One live link per person: a new
 * link replaces the old. Links last 30 days.
 */

export const LINK_DAYS = 30;
export const LIMITS = { bio: 1500, quote: 240, linkedin: 300, photoBytes: 10 * 1024 * 1024, submissions: 10 };

export async function ensureRequests(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS profile_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    submitted_at TEXT,
    submissions INTEGER NOT NULL DEFAULT 0,
    submission TEXT
  )`).run();
  await DB.prepare('CREATE INDEX IF NOT EXISTS profile_requests_slug ON profile_requests (slug, id)').run();
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const hashToken = async (token) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token))));

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new link for this person (any earlier open one stops working) */
export async function createRequest(DB, { slug, userEmail = null, now = new Date() }) {
  await ensureRequests(DB);
  const token = newToken();
  const expires = new Date(now.getTime() + LINK_DAYS * 86400e3);
  await DB.batch([
    DB.prepare("UPDATE profile_requests SET status = 'replaced' WHERE slug = ? AND status = 'open'").bind(slug),
    DB.prepare('INSERT INTO profile_requests (token_hash, slug, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await hashToken(token), slug, userEmail, now.toISOString(), expires.toISOString()),
  ]);
  return { token, expiresAt: expires.toISOString() };
}

/** The request behind a token: { row, problem } where problem is 'unknown' | 'expired' | 'closed' */
export async function findRequest(DB, token, now = new Date()) {
  await ensureRequests(DB);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return { row: null, problem: 'unknown' };
  const row = await DB.prepare('SELECT * FROM profile_requests WHERE token_hash = ?').bind(await hashToken(token)).first();
  if (!row) return { row: null, problem: 'unknown' };
  if (row.status === 'replaced' || row.status === 'used' || row.status === 'dismissed') return { row, problem: 'closed' };
  if (Date.parse(row.expires_at) < now.getTime()) return { row, problem: 'expired' };
  return { row, problem: null };
}

export async function saveSubmission(DB, id, submission, now = new Date()) {
  await DB.prepare("UPDATE profile_requests SET submission = ?, submitted_at = ?, submissions = submissions + 1, status = 'pending' WHERE id = ?")
    .bind(JSON.stringify(submission), now.toISOString(), id).run();
}

/** The latest request per person that still matters: open or waiting for review */
export async function liveRequests(DB) {
  await ensureRequests(DB);
  const rows = (await DB.prepare("SELECT id, slug, created_by, created_at, expires_at, status, submitted_at, submission FROM profile_requests WHERE status IN ('open', 'pending') ORDER BY id DESC").all()).results || [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    let submission = null;
    try { submission = r.submission ? JSON.parse(r.submission) : null; } catch {}
    out.push({ id: r.id, slug: r.slug, status: r.status, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, submittedAt: r.submitted_at, submission });
  }
  return out;
}

export async function resolveRequest(DB, id, status) {
  await ensureRequests(DB);
  if (!['used', 'dismissed'].includes(status)) throw new Error('Use or dismiss');
  await DB.prepare('UPDATE profile_requests SET status = ? WHERE id = ?').bind(status, id).run();
}

export async function moveRequests(DB, from, to) {
  await ensureRequests(DB);
  await DB.prepare('UPDATE profile_requests SET slug = ? WHERE slug = ?').bind(to, from).run();
}

/** "linkedin.com/in/jane" or a full URL → "https://www.linkedin.com/in/jane"; '' when empty; null when not LinkedIn */
export function normalizeLinkedIn(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  if (!/^\/(in|pub|company)\/[^/]+/i.test(u.pathname)) return null;
  return `https://www.linkedin.com${u.pathname.replace(/\/+$/, '')}`;
}

/** Plain text, trimmed and capped; strips anything that looks like markup */
export const cleanText = (s, max) => String(s || '').replace(/<[^>]*>/g, '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
