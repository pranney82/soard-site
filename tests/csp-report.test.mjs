/**
 * POST /api/csp-report (functions/api/csp-report.js): browsers' CSP violation
 * reports, both formats, deduped into csp_reports with nothing about the visitor.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequestPost, parseReports, blockedSource, pagePath, storeReports, MAX_ROWS, MAX_BODY } from '../functions/api/csp-report.js';

const ROOT = new URL('..', import.meta.url).pathname;

const legacy = (over = {}) => JSON.stringify({ 'csp-report': {
  'document-uri': 'https://sunshineonaranneyday.com/kids/eli/?src=slate#top',
  'violated-directive': 'script-src-elem',
  'effective-directive': 'script-src-elem',
  'blocked-uri': 'inline',
  'original-policy': "default-src 'none'",
  disposition: 'report',
  ...over,
} });
const batch = (...bodies) => JSON.stringify(bodies.map((body) => ({ type: 'csp-violation', age: 1, url: body.documentURL, user_agent: 'Mozilla/5.0', body })));

function post(body, { type = 'application/csp-report', ip = '203.0.113.7', length } = {}) {
  const headers = { 'Content-Type': type, 'CF-Connecting-IP': ip };
  if (length !== undefined) headers['Content-Length'] = String(length);
  return new Request('https://sunshineonaranneyday.com/api/csp-report', { method: 'POST', headers, body });
}
const rows = (DB) => DB.prepare('SELECT directive, blocked, path, count FROM csp_reports ORDER BY directive, blocked, path').all().then((r) => r.results);

test('both report formats parse to directive, blocked origin and path only', () => {
  assert.deepEqual(parseReports(legacy(), 'application/csp-report'), [{ directive: 'script-src-elem', blocked: 'inline', path: '/kids/eli/' }]);
  assert.deepEqual(parseReports(batch(
    { documentURL: 'https://sunshineonaranneyday.com/live/?k=secret', blockedURL: 'https://evil.example/x.js?token=abc', effectiveDirective: 'script-src-elem' },
    { documentURL: 'https://sunshineonaranneyday.com/', blockedURL: 'eval', effectiveDirective: 'script-src' },
  ), 'application/reports+json'), [
    { directive: 'script-src-elem', blocked: 'https://evil.example', path: '/live/' },
    { directive: 'script-src', blocked: 'eval', path: '/' },
  ]);
  // Other report types in a batch (deprecation, NEL ...) are ignored
  assert.deepEqual(parseReports(JSON.stringify([{ type: 'deprecation', body: {} }]), 'application/reports+json'), []);
  assert.deepEqual(parseReports('not json', 'application/csp-report'), []);
  assert.deepEqual(parseReports(legacy({ 'effective-directive': 'DROP TABLE x;', 'violated-directive': '' }), 'application/csp-report'), []);
  // Older browsers name only violated-directive, with its sources
  assert.equal(parseReports(legacy({ 'effective-directive': undefined, 'violated-directive': "script-src 'self'" }), 'application/csp-report')[0].directive, 'script-src');
});

test('blocked sources keep only an origin or a keyword', () => {
  assert.equal(blockedSource('https://cdn.example:8443/a/b.js?x=1'), 'https://cdn.example:8443');
  assert.equal(blockedSource('wss://live.example/socket'), 'wss://live.example');
  assert.equal(blockedSource('inline'), 'inline');
  assert.equal(blockedSource('data:image/png;base64,AAAA'), 'data');
  assert.equal(blockedSource('chrome-extension://abcdef/content.js'), 'chrome-extension');
  assert.equal(blockedSource(''), 'unknown');
  assert.equal(blockedSource('%%%'), 'other');
  assert.equal(pagePath('https://sunshineonaranneyday.com/apply/form/?token=secret#q'), '/apply/form/');
  assert.equal(pagePath('nonsense'), 'unknown');
});

test('reports are deduped into one row per directive, origin and page, counted', async () => {
  const DB = await createD1();
  const env = { DB };
  for (let i = 0; i < 3; i++) assert.equal((await onRequestPost({ request: post(legacy()), env })).status, 204);
  const r = await onRequestPost({ request: post(batch(
    { documentURL: 'https://sunshineonaranneyday.com/kids/eli/?again=1', blockedURL: 'inline', effectiveDirective: 'script-src-elem' },
    { documentURL: 'https://sunshineonaranneyday.com/kids/eli/', blockedURL: 'inline', effectiveDirective: 'script-src-attr' },
  ), { type: 'application/reports+json' }), env });
  assert.equal(r.status, 204);
  assert.deepEqual(await rows(DB), [
    { directive: 'script-src-attr', blocked: 'inline', path: '/kids/eli/', count: 1 },
    { directive: 'script-src-elem', blocked: 'inline', path: '/kids/eli/', count: 4 },
  ]);
  const seen = await DB.prepare('SELECT first_seen, last_seen FROM csp_reports').first();
  assert.match(seen.first_seen, /^\d{4}-\d\d-\d\dT/);
  // Nothing about the visitor is stored anywhere in the row
  const all = JSON.stringify((await DB.prepare('SELECT * FROM csp_reports').all()).results);
  assert.ok(!/203\.0\.113|Mozilla|again=1|original/.test(all));
});

test('anything else is answered 204 and stored nowhere', async () => {
  const DB = await createD1();
  const env = { DB };
  const big = legacy({ 'script-sample': 'x'.repeat(MAX_BODY) });
  for (const request of [
    post(legacy(), { type: 'text/plain' }),
    post('{"csp-report": 5}'),
    post('garbage'),
    post(big),
    post(legacy(), { length: MAX_BODY + 1 }),
  ]) assert.equal((await onRequestPost({ request, env })).status, 204);
  const t = await DB.prepare("SELECT name FROM sqlite_master WHERE name = 'csp_reports'").first();
  assert.equal(t, null, 'not even the table is created');
  // No database at all still answers 204
  assert.equal((await onRequestPost({ request: post(legacy()), env: {} })).status, 204);
});

test('30 a minute per address, then dropped (still 204)', async () => {
  const DB = await createD1();
  const env = { DB };
  for (let i = 0; i < 35; i++) await onRequestPost({ request: post(legacy()), env });
  assert.equal((await rows(DB))[0].count, 30);
  await onRequestPost({ request: post(legacy(), { ip: '198.51.100.9' }), env });
  assert.equal((await rows(DB))[0].count, 31, 'another address still gets through');
});

test('2,000 a day across every address', async () => {
  const DB = await createD1();
  const env = { DB };
  await DB.prepare('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)').run();
  await DB.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)').bind('csp-report:day', 2000, Date.now() + 3600e3).run();
  await onRequestPost({ request: post(legacy()), env });
  assert.deepEqual(await rows(DB).catch(() => []), []);
});

test(`the table keeps the ${MAX_ROWS} most recently seen rows`, async () => {
  const DB = await createD1();
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  for (let i = 0; i < MAX_ROWS + 5; i++) {
    await storeReports(DB, [{ directive: 'img-src', blocked: `https://h${i}.example`, path: '/' }], t0 + i * 1000);
  }
  const n = await DB.prepare('SELECT COUNT(*) AS n FROM csp_reports').first('n');
  assert.equal(n, MAX_ROWS);
  const oldest = await DB.prepare('SELECT blocked FROM csp_reports ORDER BY last_seen ASC LIMIT 1').first('blocked');
  assert.equal(oldest, 'https://h5.example', 'the five least recently seen went');
  // Seeing an old row again counts it without trimming anything
  await storeReports(DB, [{ directive: 'img-src', blocked: 'https://h5.example', path: '/' }], t0 + 1e9);
  assert.equal(await DB.prepare('SELECT COUNT(*) AS n FROM csp_reports').first('n'), MAX_ROWS);
});

test('the route is public in the API middleware', () => {
  const mw = readFileSync(`${ROOT}functions/api/_middleware.js`, 'utf8');
  assert.match(mw, /PUBLIC_ROUTES\.push\('\/api\/csp-report'\)/);
});
