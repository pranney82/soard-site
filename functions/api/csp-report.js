/**
 * POST /api/csp-report — where browsers report Content-Security-Policy violations
 * ==============================================================================
 * The strict policy in public/_headers (inline scripts only by hash, see
 * scripts/csp-hash.mjs) names this endpoint twice:
 *   report-uri /api/csp-report   Firefox, Safari: one application/csp-report
 *                                object per violation, {"csp-report": {...}}
 *   report-to csp                Chrome (Reporting-Endpoints header): batches as
 *                                application/reports+json, [{type, body}, ...]
 *
 * Each violation becomes one deduped row in csp_reports: the directive, the
 * blocked URL's origin only (or inline / eval / data ...), and the page's path
 * without its query, with a count and first/last seen. A noisy page is one row,
 * and nothing about the visitor (full URLs, user agent, address) is kept.
 *
 * Public (PUBLIC_ROUTES in _middleware.js). Limits: 16 KB a request, 30 a
 * minute per address, 2,000 a day in all, 1,000 rows (the least recently seen
 * go first). Always answers 204: a reporting browser does nothing with it.
 *
 * Read them in the D1 console: SELECT * FROM csp_reports ORDER BY last_seen DESC
 *
 * Env bindings: DB (D1)
 */

import { limit } from './_rate-limit.js';
import { clientIp } from './_secure.js';

export const MAX_BODY = 16 * 1024;
export const MAX_ROWS = 1000;
const PER_IP_PER_MIN = 30;
const PER_DAY = 2000;
// One request can batch several reports; more distinct ones than this are noise
const MAX_PER_REQUEST = 20;
// A real directive name (img-src, script-src-elem, frame-ancestors ...), so junk posts store nothing
const DIRECTIVE = /^(?:[a-z]+(?:-[a-z]+)*-src(?:-elem|-attr)?|base-uri|form-action|frame-ancestors|navigate-to|require-trusted-types-for|trusted-types|sandbox|webrtc)$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS csp_reports (
  directive TEXT NOT NULL, blocked TEXT NOT NULL, path TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY (directive, blocked, path)
)`;

const done = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

/** The request body as text, or null when it's over `max` bytes (stops reading there) */
async function readCapped(request, max) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** What was blocked, without anything that could identify a visitor: an origin or a CSP keyword */
export function blockedSource(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'unknown';
  if (/^[a-z-]{1,30}$/.test(v)) return v; // inline, eval, wasm-eval, self, data, blob, trusted-types-policy ...
  try {
    const u = new URL(v);
    if (/^(https?|wss?):$/.test(u.protocol)) return u.origin.slice(0, 120);
    return u.protocol.replace(/:$/, '').slice(0, 30) || 'unknown'; // data:, blob:, chrome-extension: ...
  } catch {
    return 'other';
  }
}

/** The page's path, never its query or fragment */
export function pagePath(raw) {
  try {
    return new URL(String(raw || '')).pathname.slice(0, 200) || '/';
  } catch {
    return 'unknown';
  }
}

/** [{ directive, blocked, path }] from either report format; [] for anything else */
export function parseReports(text, contentType = '') {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const ct = contentType.toLowerCase();
  const raw = [];
  if (ct.includes('application/reports+json') && Array.isArray(data)) {
    for (const r of data) {
      if (r?.type !== 'csp-violation' || !r.body || typeof r.body !== 'object') continue;
      raw.push({ directive: r.body.effectiveDirective || r.body.violatedDirective, blocked: r.body.blockedURL, page: r.body.documentURL || r.url });
    }
  } else if (ct.includes('application/csp-report') || ct.includes('application/json')) {
    const r = data?.['csp-report'];
    if (r && typeof r === 'object') raw.push({ directive: r['effective-directive'] || r['violated-directive'], blocked: r['blocked-uri'], page: r['document-uri'] });
  }
  const out = [];
  for (const r of raw) {
    const directive = String(r.directive || '').trim().toLowerCase().split(/\s+/)[0];
    if (directive.length > 40 || !DIRECTIVE.test(directive)) continue;
    out.push({ directive, blocked: blockedSource(r.blocked), path: pagePath(r.page) });
  }
  return out;
}

/** Count each report in its row; trims the table back to MAX_ROWS when a new row was added */
export async function storeReports(DB, reports, now = Date.now()) {
  const at = new Date(now).toISOString();
  const seen = new Map();
  for (const r of reports) seen.set(`${r.directive}\n${r.blocked}\n${r.path}`, r);
  await DB.prepare(SCHEMA).run();
  let added = false;
  for (const r of [...seen.values()].slice(0, MAX_PER_REQUEST)) {
    const row = await DB.prepare(`INSERT INTO csp_reports (directive, blocked, path, count, first_seen, last_seen) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(directive, blocked, path) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen
      RETURNING count`).bind(r.directive, r.blocked, r.path, at, at).first();
    if (Number(row?.count) === 1) added = true;
  }
  if (added) {
    await DB.prepare(`DELETE FROM csp_reports WHERE rowid IN (
      SELECT rowid FROM csp_reports ORDER BY last_seen DESC, rowid DESC LIMIT -1 OFFSET ?)`).bind(MAX_ROWS).run();
  }
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const type = request.headers.get('Content-Type') || '';
    if (!/application\/(csp-report|reports\+json|json)/i.test(type)) return done();
    const text = await readCapped(request, MAX_BODY);
    if (!text) return done();
    const reports = parseReports(text, type);
    if (!reports.length || !env.DB) return done();
    // Per address first, so one noisy visitor can't use up the day's allowance
    const perIp = await limit(env.DB, `csp-report:ip:${clientIp(request)}`, PER_IP_PER_MIN, 60);
    if (!perIp.ok) return done();
    const perDay = await limit(env.DB, 'csp-report:day', PER_DAY, 86400);
    if (!perDay.ok) return done();
    await storeReports(env.DB, reports);
  } catch (e) {
    console.warn('[csp-report] not stored:', e.message);
  }
  return done();
}
