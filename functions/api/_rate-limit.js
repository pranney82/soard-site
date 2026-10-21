/**
 * Rate limits that hold across every Cloudflare isolate and data center.
 *
 * The middleware's in-memory map only counts what one isolate sees, and an
 * attacker spreads across hundreds of them. These counters live in D1 (one
 * upsert per call), so a limit means the same thing everywhere. A fixed
 * window per key: `limit(DB, 'reminders:ip:1.2.3.4', 5, 3600)` allows five
 * calls an hour for that key.
 *
 * Fails open when D1 is unavailable: the edge rate-limiting rule in front of
 * the site still applies, and a family shouldn't be locked out by a DB blip.
 */

const _ready = new WeakSet();

async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)').run();
  _ready.add(DB);
}

/**
 * Count one call against `key`. Returns { ok, count, retryAfter } where ok is
 * false once more than `max` calls landed inside the window.
 */
export async function limit(DB, key, max, windowSec, { now = Date.now() } = {}) {
  if (!DB) return { ok: true, count: 0, retryAfter: 0 };
  const k = String(key).slice(0, 200);
  try {
    await ensureSchema(DB);
    const row = await DB.prepare(`INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
      RETURNING count, reset_at`).bind(k, now + windowSec * 1000, now).first();
    // Now and then, clear windows that are long over
    if (Math.random() < 0.01) await DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now - 86400000).run();
    const count = Number(row?.count || 1);
    return { ok: count <= max, count, retryAfter: Math.max(1, Math.ceil((Number(row?.reset_at || now) - now) / 1000)) };
  } catch (e) {
    console.warn('[rate-limit] D1 unavailable, allowing:', e.message);
    return { ok: true, count: 0, retryAfter: 0 };
  }
}

/** Several limits at once (e.g. per minute and per day); the first one hit wins */
export async function limitAll(DB, checks, opts) {
  for (const [key, max, windowSec] of checks) {
    const r = await limit(DB, key, max, windowSec, opts);
    if (!r.ok) return r;
  }
  return { ok: true, count: 0, retryAfter: 0 };
}

export function tooMany(retryAfter = 60, message = 'Too many attempts. Please wait a little and try again.') {
  return Response.json({ ok: false, error: message }, { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } });
}
