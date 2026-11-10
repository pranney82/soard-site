/**
 * Reveal stats: what the sixth review round found (Nov 9 2026), kept as tests.
 * Every listed reveal keeps its feed health report, the Facebook permission
 * flag follows Facebook's latest answer, odd ?src= words still count the
 * person, the watch meter never rounds up time that didn't play, a thinned
 * long line keeps the tile's peak, a missing video or refused permission is
 * told apart from a failed read, and History gives the real reason a reveal
 * isn't compared.
 * Run: node --test tests/reveal-stats-round6.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const WT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };
const H = 3600e3, D = 86400e3;
const iso = (ms) => new Date(ms).toISOString();

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let handler = null;
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (handler) { const r = await handler(url); if (r) return r; }
  return new Response('not mocked', { status: 599 });
};

let DB, env, b, rs, admin, fb, yt, ui;
before(async () => {
  const { createD1 } = await import(`${WT}/tests/lib/d1-shim.mjs`);
  DB = await createD1({ schemaFiles: [`${WT}/scripts/schema.sql`] });
  env = { DB, FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'fbtok', YOUTUBE_API_KEY: 'ytkey' };
  b = await import(`${WT}/functions/api/_broadcast.js`);
  rs = await import(`${WT}/functions/api/_reveal-stats.js`);
  admin = await import(`${WT}/functions/api/broadcast-admin.js`);
  fb = await import(`${WT}/functions/api/_broadcast-fb.js`);
  yt = await import(`${WT}/functions/api/_youtube.js`);
  ui = await import(`${WT}/public/admin/reveal-stats.js`);
  await b.ensureSchema(DB);
  await rs.ensureStatsSchema(DB);
});

const insertRow = (r) => DB.prepare(`INSERT INTO broadcasts (id, kid_slug, kid_name, title, live_at, ended_at, phase, source, fb_live_video_id, fb_permalink, data, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.id, r.kid_slug ?? 'ben', r.kid_name ?? 'Ben', r.title ?? 'Ben', r.live_at, r.ended_at ?? null, r.phase ?? 'ended', r.source ?? 'stream',
  r.fb_live_video_id ?? null, r.fb_permalink ?? null, JSON.stringify(r.data || {}), r.created_at || r.live_at, r.updated_at || r.live_at).run();

test('every reveal History lists keeps its feed health report (not only the newest 12)', async () => {
  const start = Date.now() - 80 * D; // past the 30 days Facebook is read for, so the next test has the refresh to itself
  for (let i = 0; i < 20; i++) {
    const live = start + i * 2 * D;
    await insertRow({ id: `live-8${String(i).padStart(3, '0')}`, kid_slug: `kid${i}`, kid_name: `Kid ${i}`, title: `Kid ${i}`, live_at: iso(live), ended_at: iso(live + H), created_at: iso(live - D), updated_at: iso(live + H) });
    await DB.prepare(`INSERT INTO broadcast_events (broadcast_id, type, meta, created_at) VALUES (?, 'health_report', ?, ?)`)
      .bind(`live-8${String(i).padStart(3, '0')}`, JSON.stringify({ v: 1, minutes: 50, okPct: 99 }), iso(live + H)).run();
  }
  const res = await admin.onRequestGet({ env, request: new Request('https://sunshineonaranneyday.com/api/broadcast-admin'), data: { userEmail: 'staff@test' }, waitUntil: () => {} });
  const d = await res.json();
  assert.equal(d.success, true, d.error);
  const listed = d.history.filter((r) => /^live-8\d{3}$/.test(r.id));
  assert.equal(listed.length, 20);
  assert.deepEqual(listed.filter((r) => !d.healthReports[r.id]).map((r) => r.id), []);
});

test('Automations\' Facebook permission flag follows Facebook\'s latest answer', async () => {
  const old = Date.now() - 29.99 * D;
  await insertRow({ id: 'live-9100', live_at: iso(old), ended_at: iso(old + H), fb_permalink: 'https://www.facebook.com/soard/videos/1120737860658441/' });
  handler = (url) => {
    if (url.includes('/video_insights')) return json({ error: { message: '(#10) Requires read_insights permission', code: 10 } }, 400);
    if (url.startsWith('https://graph.facebook.com/')) return json({ id: '1120737860658441', reactions: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } } });
    return null;
  };
  await rs.maybeRefreshRevealStats(env, { force: true });
  assert.equal((await rs.revealStatsFacts(DB)).fbMissing, true, 'flagged while the permission is missing');
  travel(D);
  const fresh = Date.now() - 2 * H;
  await insertRow({ id: 'live-9101', live_at: iso(fresh), ended_at: iso(fresh + H), fb_permalink: 'https://www.facebook.com/soard/videos/2220737860658441/' });
  handler = (url) => {
    if (url.includes('/video_insights')) return json({ data: [{ name: 'total_video_views', values: [{ value: 50 }] }, { name: 'total_video_views_unique', values: [{ value: 40 }] }] });
    if (url.startsWith('https://graph.facebook.com/')) return json({ id: '2220737860658441', reactions: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } } });
    return null;
  };
  await rs.maybeRefreshRevealStats(env, { force: true });
  handler = null;
  assert.equal((await rs.revealStatsFacts(DB)).fbMissing, false, 'a newer good read clears it');
});

test('a ?src= word that names a built-in (constructor, __proto__) is just "other"', () => {
  for (const src of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(rs.classifySource({ src }), 'other', src);
  assert.equal(rs.classifySource({ ref: 'android-app://constructor' }), 'other');
});

test('the watch meter never rounds up: a picture that keeps freezing is credited the seconds it moved', async () => {
  const { transformSync } = createRequire(`${WT}/package.json`)('esbuild');
  const src = transformSync(readFileSync(`${WT}/src/utils/live-stats.ts`, 'utf8'), { loader: 'ts', format: 'esm' }).code;
  globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  // 1.5 s of picture, then 3.5 s frozen, over and over (a phone on a bad connection)
  const clock = (ms) => { const s = Math.max(0, ms - 300) / 1000; const c = Math.floor(s / 5); return c * 1.5 + Math.min(s - c * 5, 1.5); };
  let wall = 0;
  const video = { paused: false, ended: false, get currentTime() { return clock(wall); } };
  const reports = [];
  const ticks = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = (fn) => { ticks.push(fn); return 1; };
  const meter = mod.watchMeter({ kind: 'live', video: () => video, report: (k, sec) => reports.push(sec), now: () => wall });
  globalThis.setInterval = real;
  for (let i = 0; i < 300; i++) { wall += 1000; ticks[0](); }
  meter.stop();
  const credited = reports.reduce((a, x) => a + x, 0), moved = clock(wall) - clock(0);
  assert.ok(Math.abs(credited - moved) <= 1, `moved ${moved.toFixed(1)} s, credited ${credited} s`);
  delete globalThis.document; delete globalThis.window;
});

test('a thinned three-hour line keeps the tile\'s peak, carried reading and all', () => {
  // Site and Facebook every 30 s for 3 hours; at 1:30:00 the site jumps to 200 while Facebook misses that one reading
  const series = [];
  for (let t = 0; t <= 3 * 3600; t += 30) series.push([t, t === 5400 ? 200 : 100, t === 5400 ? null : (t === 5370 ? 150 : 120), null]);
  series.push([5430, 100, 220, null]); // a busy Facebook moment right after: 320, below the 350 at 1:30:00
  series.sort((a, b) => a[0] - b[0]);
  const sum = rs.summarizeSeries(series);
  assert.equal(sum.peakAll, 350);
  assert.equal(sum.peakAllAt, 5400);
  const thin = rs.thinSeries(series, 240);
  assert.ok(thin.length <= 2 * 240, `${thin.length} points`);
  assert.ok(thin.some((p) => p[0] === 5400), 'the peak moment is kept');
  assert.ok(thin.some((p) => p[0] === 5370), 'and the reading its Facebook number is carried from');
  // The chart's own count over the thinned line (the client's fillGaps) finds the same peak
  const filled = ui.fillGaps(thin);
  const best = filled.reduce((a, q) => ((q[1] || 0) + (q[2] || 0) > (a[1] || 0) + (a[2] || 0) ? q : a));
  assert.deepEqual([best[0], (best[1] || 0) + (best[2] || 0)], [5400, 350]);
});

test('Facebook: a missing video and a refused permission are told apart from a failed read', async () => {
  const gone = { error: { message: "(#100) Unsupported get request. Object with ID '333333333' does not exist, cannot be loaded due to missing permissions", code: 100 } };
  handler = (url) => (url.startsWith('https://graph.facebook.com/') ? json(gone, 400) : null);
  let r = await fb.fbVideoTotals(env, { videoId: '333333333' });
  assert.equal(r.ok, false);
  assert.equal(r.gone, true, 'deleted video');
  assert.equal(r.missing, null, 'not a permission problem');
  handler = (url) => (url.startsWith('https://graph.facebook.com/') ? json({ error: { message: 'Error validating access token: Session has expired', code: 190 } }, 400) : null);
  r = await fb.fbVideoTotals(env, { videoId: '333333333' });
  assert.equal(r.gone, false, 'an expired token is a failed read');
  handler = (url) => (url.startsWith('https://graph.facebook.com/') ? json({ error: { message: '(#10) Requires read_insights permission', code: 10 } }, 400) : null);
  r = await fb.fbVideoTotals(env, { videoId: '333333333' });
  assert.equal(r.missing, 'read_insights');

  // Saved: gone, denied, failed (the last word on the permission stands through a failed read)
  const live = Date.now() - 3 * H;
  await insertRow({ id: 'live-9200', live_at: iso(live), ended_at: iso(live + H), fb_permalink: 'https://www.facebook.com/soard/videos/333333333/' });
  const kind = async () => JSON.parse((await DB.prepare("SELECT facebook FROM broadcast_stats WHERE broadcast_id = 'live-9200'").first()).facebook);
  const row = async () => ({ ...(await DB.prepare("SELECT * FROM broadcasts WHERE id = 'live-9200'").first()), facebook: (await DB.prepare("SELECT facebook FROM broadcast_stats WHERE broadcast_id = 'live-9200'").first())?.facebook ?? null });
  await rs.refreshPlatforms(env, await row());
  assert.equal((await kind()).errorKind, 'denied');
  handler = (url) => (url.startsWith('https://graph.facebook.com/') ? json(gone, 400) : null);
  await rs.refreshPlatforms(env, await row());
  assert.equal((await kind()).errorKind, 'gone');
  handler = (url) => (url.startsWith('https://graph.facebook.com/') ? json({ error: { message: 'Error validating access token: Session has expired', code: 190 } }, 400) : null);
  await rs.refreshPlatforms(env, await row());
  const f = await kind();
  assert.equal(f.errorKind, 'failed');
  assert.equal(f.missing, 'read_insights', 'a failed read leaves the last word on the permission');
  handler = null;
});

test('YouTube: a video that isn\'t there is "gone"', async () => {
  handler = (url) => (url.startsWith('https://www.googleapis.com/youtube/v3/videos') ? json({ items: [] }) : null);
  const r = await yt.videoStats(env, 'abcDEF12345');
  handler = null;
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
});

test('History says why each reveal isn\'t compared', () => {
  const before = { id: 'a', kid_slug: 'ann', live_at: '2026-10-01T23:00:00Z', ended_at: '2026-10-01T23:50:00Z', phase: 'ended', source: 'stream', stats: { counted: false } };
  assert.equal(ui.whyNot(before), 'before', 'day one: from before counting began');
  assert.equal(ui.whyNot({ ...before, stats: null }, 'D1_ERROR: boom'), 'unloaded', 'numbers that didn\'t load are not "before counting"');
  assert.equal(ui.whyNot({ ...before, stats: null }), null);
  assert.equal(ui.whyNot({ ...before, title: 'TEST Ann' }), 'test');
  assert.equal(ui.whyNot({ ...before, source: 'manual' }), 'manual');
  assert.equal(ui.whyNot({ ...before, kid_slug: null }), 'nokid');
  assert.equal(ui.whyNot({ ...before, live_at: null, phase: 'cancelled' }), 'cancelled');
  assert.equal(ui.whyNot({ ...before, stats: { counted: true } }), null, 'compared');
});

test('a coming-up reveal shows its messages (they open before it goes live)', () => {
  const col = ui.COLUMNS.find((c) => c.key === 'messages');
  assert.equal(col.get({ counted: true }, { phase: 'scheduled', live_at: null, messageCount: 12 }), 12);
  assert.equal(col.get({ counted: true }, { phase: 'cancelled', live_at: null, messageCount: 3 }), null);
});

test('known service errors read in plain words', () => {
  assert.match(ui.plainError('Error validating access token: Session has expired on Monday'), /sign-in has expired/);
  assert.match(ui.plainError('(#10) Requires read_insights permission'), /missing a permission/);
  assert.match(ui.plainError('The request cannot be completed because you have exceeded your quota. quotaExceeded'), /YouTube allowance/);
  assert.match(ui.plainError('D1_ERROR: no such table: broadcast_viewers'), /database/);
  assert.match(ui.plainError('The operation was aborted due to timeout'), /in time/);
  assert.equal(ui.plainError('Something odd happened'), 'Something odd happened.');
});
