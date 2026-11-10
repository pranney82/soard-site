/**
 * Reveal stats, the edges: what an independent review found (Nov 9 2026), kept
 * as tests. Watching time can't be inflated, other children's pages don't
 * count, the reveal lines up after a reconnect, rows close when staff end or
 * reset, hearts never go down, app referrers and odd phone names, partial
 * Facebook replies, and a new arrival in the same tab.
 * Run: node --test tests/reveal-stats-edges.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const WT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };
const S = 1000, M = 60e3, H = 3600e3, D = 86400e3;
const iso = (ms) => new Date(ms).toISOString();

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const SITE = 'https://sunshineonaranneyday.com';

globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('/video_insights')) return json({ data: [{ name: 'total_video_views', values: [{ value: 10 }] }] });
  if (url.startsWith('https://graph.facebook.com/')) return json({ id: '1', video: { id: '222' }, reactions: { summary: { total_count: 1 } }, comments: { summary: { total_count: 1 } } });
  if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) return json({ items: [{ id: 'abcDEF12345', statistics: { viewCount: '5' } }] });
  return new Response('not mocked', { status: 599 });
};

let DB, env, b, rs, liveWatch, event;
const ctx = (request) => ({ env, request, data: {}, waitUntil: () => {} });
const post = (url, body, ua = IPHONE) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify(body) });
const beacon = (body, ua) => event.onRequestPost(ctx(post(`${SITE}/api/broadcast-event`, body, ua)));
const watch = (body, ua) => liveWatch.onRequestPost(ctx(post(`${SITE}/api/live-watch`, body, ua)));
const viewer = (id, vid) => DB.prepare('SELECT * FROM broadcast_viewers WHERE broadcast_id = ? AND vid = ?').bind(id, vid).first();

async function setState(patch) {
  const s = { ...b.defaultState(), ...patch };
  await b.writeState(DB, s);
  travel(4 * S); // past live-watch's 3 s state cache
  return s;
}

before(async () => {
  const { createD1 } = await import(`${WT}/tests/lib/d1-shim.mjs`);
  DB = await createD1({ schemaFiles: [`${WT}/scripts/schema.sql`] });
  env = { DB, FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'fbtok', YOUTUBE_API_KEY: 'ytkey' };
  b = await import(`${WT}/functions/api/_broadcast.js`);
  rs = await import(`${WT}/functions/api/_reveal-stats.js`);
  liveWatch = await import(`${WT}/functions/api/live-watch.js`);
  event = await import(`${WT}/functions/api/broadcast-event.js`);
  await b.ensureSchema(DB);
  await rs.ensureStatsSchema(DB);
});

// ──────────────────────────────────────────────────────────────────
test('rapid reports from one browser can\'t claim more watching than the time that passed', async () => {
  await setState({ phase: 'live', broadcastId: 'live-500', liveAt: iso(Date.now()), source: 'stream', kidSlug: 'remi' });
  await watch({ broadcastId: 'live-500', vid: 'flooder01', kind: 'live', sec: 10 });
  // 100 reports 100 ms apart = 10 s of wall time, well inside the 600/min per-address limit
  for (let i = 0; i < 100; i++) { travel(100); await watch({ broadcastId: 'live-500', vid: 'flooder01', kind: 'live', sec: 90 }); }
  const v = await viewer('live-500', 'flooder01');
  assert.ok(v.live_sec <= 10 + 15, `credited ${v.live_sec} s of live watching for ~10 s of wall time (the cap: wall time since the first report + 15 s)`);
});

test('a burst of reports at the same instant adds nothing past the 15 s allowance', async () => {
  await watch({ broadcastId: 'live-500', vid: 'burster01', kind: 'live', sec: 10 });
  const before = (await viewer('live-500', 'burster01')).live_sec;
  for (let i = 0; i < 50; i++) await watch({ broadcastId: 'live-500', vid: 'burster01', kind: 'live', sec: 20 });
  const after = (await viewer('live-500', 'burster01')).live_sec;
  assert.ok(after - before <= 5, `50 reports at the same instant added ${after - before} s (10 already, 15 allowed)`);
});

// ──────────────────────────────────────────────────────────────────
test('"there for the reveal" after a reconnect: the replay is the last recording, lined up with the live minutes', async () => {
  // Live at L; the phone drops > 30 s (Stream recording timeoutSeconds = 30) and reconnects at L+15m: Stream starts a
  // new recording, the tick moves liveVideoUid to it, and checkReplayReady makes THAT the replay. The reveal is
  // 2:00 into the replay (admin revealAtMinute / reel momentSeconds are seconds into the recording) = wall L+17m.
  const run = async (id, vid, fromMin, toMin) => {
    const L = Date.now();
    await setState({ phase: 'live', broadcastId: id, liveAt: iso(L), segmentAt: iso(L + 15 * M), source: 'stream', kidSlug: 'max' });
    offset += (L + fromMin * M) - Date.now();
    while (Date.now() < L + toMin * M) { travel(20 * S); await watch({ broadcastId: id, vid, kind: 'live', sec: 20 }); }
    await DB.prepare(`INSERT INTO broadcasts (id, kid_slug, title, live_at, ended_at, phase, replay_uid, source, data, created_at)
      VALUES (?, 'max', 'Max''s room reveal', ?, ?, 'replay', 'seg2uid', 'stream', ?, ?)`)
      .bind(id, iso(L), iso(L + 30 * M), JSON.stringify({ revealAtSeconds: 120, replayStartedAt: iso(L + 15 * M) }), iso(L - H)).run();
    const rows = (await DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(id).all()).results.map((r) => ({ ...r, data: JSON.parse(r.data) }));
    return { st: (await rs.historyStats(DB, rows)).byId[id], v: await viewer(id, vid) };
  };
  // Bea watched L+16m to L+18m, through the actual reveal at L+17m
  const bea = await run('live-600', 'beawatch1', 16, 18);
  // Ann watched L+1m to L+4m only, and left 13 minutes before the reveal
  const ann = await run('live-601', 'annleft01', 1, 4);
  assert.deepEqual([bea.st.atReveal, ann.st.atReveal], [1, 0],
    `Bea (there) marks ${bea.v.live_min} -> atReveal ${bea.st.atReveal}; Ann (gone) marks ${ann.v.live_min} -> atReveal ${ann.st.atReveal}`);
  assert.equal(bea.st.revealAt, 17 * 60, 'the chart marks the reveal 17:00 into the live');
});

// ──────────────────────────────────────────────────────────────────
test('a visit to another child\'s /live/<kid>/ page isn\'t a person for the current reveal', async () => {
  // Remi's reveal is scheduled; someone opens /live/isla/ (Isla's page shows idle for her). LivePage.astro sends
  // view_live_page with broadcastId = client.state.id (Remi's broadcast) and meta.kid = 'isla'.
  await setState({ phase: 'scheduled', broadcastId: 'live-700', kidSlug: 'remi', kidName: 'Remi', scheduledAt: iso(Date.now() + 2 * D) });
  await beacon({ type: 'view_live_page', broadcastId: 'live-700', vid: 'islafan01', meta: { phase: 'idle', kid: 'isla' } });
  const v = await viewer('live-700', 'islafan01');
  assert.equal(v, null, `recorded as Remi's viewer: ${JSON.stringify(v)}`);
  await beacon({ type: 'view_live_page', broadcastId: 'live-700', vid: 'remifan01', meta: { phase: 'upcoming', kid: 'remi' } });
  assert.equal((await viewer('live-700', 'remifan01'))?.before_live, 1, 'Remi\'s own page counts');
});

// ──────────────────────────────────────────────────────────────────
test('Automations\' "last noted during a reveal" stays put when Facebook and YouTube are read later', async () => {
  const L = Date.now();
  const s = await setState({ phase: 'live', broadcastId: 'live-800', liveAt: iso(L), source: 'stream', fb: { liveVideoId: '999' } });
  const health = { monitor: { broadcastId: 'live-800', at: iso(Date.now()) } };
  assert.equal(await rs.sampleLive(env, s, health, {}), true);
  const sampledAt = (await DB.prepare(`SELECT sampled_at FROM broadcast_stats WHERE broadcast_id = 'live-800'`).first()).sampled_at;
  await DB.prepare(`INSERT INTO broadcasts (id, title, live_at, ended_at, phase, fb_live_video_id, source, data, created_at) VALUES ('live-800', 'x', ?, ?, 'replay', '999', 'stream', '{}', ?)`)
    .bind(iso(L), iso(L + H), iso(L)).run();
  await setState({}); // idle
  travel(3 * D);
  await rs.maybeRefreshRevealStats(env, { readState: b.readState, force: true });
  const f = await rs.revealStatsFacts(DB);
  assert.equal(f.lastSampleAt, sampledAt, `lastSampleAt is now ${f.lastSampleAt}, three days after the last sample (${sampledAt}), though nothing was live`);
});

// ──────────────────────────────────────────────────────────────────
test('a Facebook-only reveal ended from the admin closes its row, so its Facebook totals are read', async () => {
  await setState({}); // idle
  const r = await b.adminAction(env, 'goLiveManual', { url: 'https://www.facebook.com/soard/videos/123456789/', title: 'Facebook-only reveal' }, 'staff@example.org');
  assert.notEqual(r.success, false, `goLiveManual: ${JSON.stringify(r).slice(0, 200)}`);
  const id = (await b.readState(DB)).broadcastId;
  // the admin sets the Facebook post on the broadcast the way fbRefreshPermalink would
  await DB.prepare('UPDATE broadcasts SET fb_permalink = ? WHERE id = ?').bind('https://www.facebook.com/soard/videos/123456789/', id).run();
  travel(40 * M);
  await b.adminAction(env, 'endNow', {}, 'staff@example.org');
  const row = await DB.prepare('SELECT phase, live_at, ended_at FROM broadcasts WHERE id = ?').bind(id).first();
  travel(20 * M);
  const out = await rs.maybeRefreshRevealStats(env, { readState: b.readState, force: true });
  assert.ok(out.refreshed.includes(id), `row after End: ${JSON.stringify(row)}; refreshed: ${JSON.stringify(out.refreshed)}`);
});

// ──────────────────────────────────────────────────────────────────
test('hearts never go down when the tick and the heartbeat job save at once', async () => {
  // saveReactions reads, merges in JS, then writes the whole object: two callers interleave at the await
  await DB.prepare(`INSERT INTO broadcast_stats (broadcast_id, reactions) VALUES ('live-900', '{"heart":10}')`).run();
  await Promise.all([rs.saveReactions(DB, 'live-900', { heart: 15 }), rs.saveReactions(DB, 'live-900', { heart: 12 })]);
  const r = JSON.parse((await DB.prepare(`SELECT reactions FROM broadcast_stats WHERE broadcast_id = 'live-900'`).first()).reactions);
  assert.equal(r.heart, 15, `stored ${r.heart} after seeing 15`);
});

// ──────────────────────────────────────────────────────────────────
test('Android apps\' referrers (android-app://<package>) are read', () => {
  const c = rs.classifySource;
  // readHere() keeps new URL(document.referrer).hostname: for android-app://com.facebook.katana/ that is the package name
  assert.equal(c({ ref: new URL('android-app://com.facebook.katana/').hostname }), 'facebook');
  assert.equal(c({ ref: new URL('android-app://com.google.android.gm/').hostname }), 'email');
  assert.equal(c({ ref: new URL('android-app://com.google.android.googlequicksearchbox/').hostname }), 'search');
});

test('a phone whose model ends in BOT is a person; real bots are still dropped', () => {
  const cubot = 'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(rs.isBot(cubot), false);
  for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'facebookexternalhit/1.1', 'Twitterbot/1.0']) assert.equal(rs.isBot(ua), true, ua);
});

// ──────────────────────────────────────────────────────────────────
test('a browser\'s first report can claim at most 15 s', async () => {
  await setState({ phase: 'live', broadcastId: 'live-950', liveAt: iso(Date.now()), source: 'stream' });
  for (let i = 0; i < 20; i++) await watch({ broadcastId: 'live-950', vid: `mint${String(i).padStart(6, '0')}`, kind: 'live', sec: 600 });
  const r = await DB.prepare(`SELECT COUNT(*) AS n, SUM(live_sec) AS s FROM broadcast_viewers WHERE broadcast_id = 'live-950'`).first();
  assert.ok(r.s <= 20 * 15, `20 one-shot requests with no page visit: ${r.n} people, ${r.s} s live (no visit row needed)`);
});

// ──────────────────────────────────────────────────────────────────
test('a later arrival from another site in the same tab takes over from "direct"', async () => {
  const { transformSync } = await import('esbuild');
  const { readFileSync } = await import('node:fs');
  const src = transformSync(readFileSync(`${WT}/src/utils/live-stats.ts`, 'utf8'), { loader: 'ts', format: 'esm' }).code;
  const store = new Map();
  const ss = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const saved = {};
  for (const k of ['location', 'document', 'sessionStorage', 'localStorage']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  set('sessionStorage', ss); set('localStorage', ss);
  // Page 1: typed in (no referrer, no ?src)
  set('location', { search: '', host: 'sunshineonaranneyday.com', hostname: 'sunshineonaranneyday.com' });
  set('document', { referrer: '' });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  mod.noteArrival();
  // Later, same tab: they went to Facebook and tapped the reveal post (full load of /live/, referrer l.facebook.com)
  set('document', { referrer: 'https://l.facebook.com/' });
  const a = mod.arrival();
  for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  assert.equal(rs.classifySource(a), 'facebook', `arrival() = ${JSON.stringify(a)}`);
});

// ──────────────────────────────────────────────────────────────────
test('a Facebook reply missing a number keeps the last good one', async () => {
  const row = { id: 'live-990', live_at: iso(Date.now() - H), fb_live_video_id: null, fb_permalink: 'https://www.facebook.com/soard/videos/222/', facebook: JSON.stringify({ videoId: '222', views: 480, unique: 312, liveUnique: 140, avgSec: 95, reactions: 57, comments: 12 }), youtube: null };
  // Facebook answers the insights call but leaves total_video_views_live out (the mock above returns only total_video_views)
  await rs.refreshPlatforms(env, row);
  const f = JSON.parse((await DB.prepare(`SELECT facebook FROM broadcast_stats WHERE broadcast_id = 'live-990'`).first()).facebook);
  assert.deepEqual([f.unique, f.liveUnique, f.avgSec], [312, 140, 95], `after a partial read: ${JSON.stringify(f)}`);
});
