/**
 * Reveal stats: who watched each reveal, for how long, from where, how many
 * at once, hearts, and Facebook's and YouTube's totals (Broadcast → History)
 * Run: node --test tests/reveal-stats.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createD1 } from './lib/d1-shim.mjs';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };
const S = 1000, M = 60e3, H = 3600e3, D = 86400e3;

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const FB_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/489.0.0.38.109;FBBV/1;FBDV/iPhone15,2]';
const SITE = 'https://sunshineonaranneyday.com';

// Facebook and YouTube, as the site would hear them
const net = { insights: 'ok', calls: [] };
globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input); // the Graph helper passes a URL object
  net.calls.push(url);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://graph.facebook.com/') && url.includes('/video_insights')) {
    if (net.insights === 'denied') return json({ error: { message: '(#10) Requires read_insights permission', code: 10 } }, 400);
    return json({ data: [
      { name: 'total_video_views', values: [{ value: 480 }] },
      { name: 'total_video_views_unique', values: [{ value: 312 }] },
      { name: 'total_video_avg_time_watched', values: [{ value: 95_400 }] },
      { name: 'total_video_views_live', values: [{ value: 140 }] },
    ] });
  }
  if (url.startsWith('https://graph.facebook.com/') && /\/1558415092997171\?/.test(url)) return json({ video: { id: '1120737860658441' }, id: '1558415092997171' });
  if (url.startsWith('https://graph.facebook.com/') && /\/1120737860658441\?/.test(url)) return json({ id: '1120737860658441', reactions: { summary: { total_count: 57 } }, comments: { summary: { total_count: 12 } } });
  if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) return json({ items: [{ id: 'abcDEF12345', statistics: { viewCount: '230', likeCount: '18', commentCount: '4' } }] });
  return new Response('not mocked: ' + url, { status: 599 });
};

let DB, env, b, rs, liveWatch, event, admin;
const ctx = (request) => ({ env, request, data: {}, waitUntil: () => {} });
const post = (url, body, ua = IPHONE) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify(body) });
const beacon = (body, ua) => event.onRequestPost(ctx(post(`${SITE}/api/broadcast-event`, body, ua)));
const watch = (body, ua, host = SITE) => liveWatch.onRequestPost(ctx(post(`${host}/api/live-watch`, body, ua)));
const viewer = (id, vid) => DB.prepare('SELECT * FROM broadcast_viewers WHERE broadcast_id = ? AND vid = ?').bind(id, vid).first();

async function setState(patch) {
  const s = { ...b.defaultState(), ...(await b.readState(DB)), ...patch };
  await b.writeState(DB, s);
  return s;
}

before(async () => {
  DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  env = { DB, FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'fbtok', YOUTUBE_API_KEY: 'ytkey' };
  b = await import('../functions/api/_broadcast.js');
  rs = await import('../functions/api/_reveal-stats.js');
  liveWatch = await import('../functions/api/live-watch.js');
  event = await import('../functions/api/broadcast-event.js');
  admin = await import('../public/admin/reveal-stats.js');
  await b.ensureSchema(DB);
  await rs.ensureStatsSchema(DB);
});

// ─── Where people came from, and who isn't counted ──────────────────

test('sources: the link says, then the app it opened in, then the referring site', () => {
  const c = rs.classifySource;
  assert.equal(c({ src: 'email' }), 'email');
  assert.equal(c({ src: 'qr' }), 'qr');
  assert.equal(c({ src: 'slate' }), 'qr', 'the starting-soon screen\'s QR');
  assert.equal(c({ src: 'push' }), 'push');
  assert.equal(c({ src: 'something-new' }), 'other');
  assert.equal(c({ src: 'email', ref: 'l.facebook.com', ua: FB_APP }), 'email', 'the link\'s own word wins');
  assert.equal(c({ ua: FB_APP }), 'facebook', 'Facebook\'s in-app browser sends no referrer');
  assert.equal(c({ ref: 'l.facebook.com' }), 'facebook');
  assert.equal(c({ ref: 'm.facebook.com' }), 'facebook');
  assert.equal(c({ ref: 'www.instagram.com' }), 'instagram');
  assert.equal(c({ ref: 'mail.google.com' }), 'email');
  assert.equal(c({ ref: 'calendar.google.com' }), 'calendar');
  assert.equal(c({ ref: 'www.google.com' }), 'search');
  assert.equal(c({ ref: 'sunshineonaranneyday.com' }), 'site');
  assert.equal(c({ ref: 'nextdoor.com' }), 'other');
  assert.equal(c({}), 'direct', 'typed, a bookmark, or a link in a text');
});

test('who: bots are dropped, staff and tests are kept apart, the public is counted', () => {
  const req = (ua, host = SITE) => new Request(`${host}/api/live-watch`, { method: 'POST', headers: ua ? { 'user-agent': ua } : {} });
  assert.equal(rs.visitor(req('facebookexternalhit/1.1'), {}).drop, true);
  assert.equal(rs.visitor(req('Mozilla/5.0 HeadlessChrome/131.0'), {}).drop, true);
  assert.equal(rs.visitor(req(''), {}).drop, true, 'no user agent: a script');
  assert.equal(rs.visitor(req(IPHONE), { vid: 'abc12345' }).who, null);
  assert.equal(rs.visitor(req(IPHONE), { vid: 'abc12345', who: 'staff' }).who, 'staff');
  assert.equal(rs.visitor(req(IPHONE), { vid: 'abc12345', who: 'test' }).who, 'test');
  assert.equal(rs.visitor(req(IPHONE, 'http://localhost:4321'), { vid: 'abc12345' }).who, 'test', 'not the real site');
  assert.equal(rs.visitor(req(IPHONE, 'https://abc.soard-site.pages.dev'), { vid: 'abc12345' }).who, 'test');
  assert.equal(rs.visitor(req(IPHONE), { vid: 'x' }).vid, null, 'ids are 8 to 40 letters and digits');
  assert.equal(rs.visitor(req(IPHONE), { vid: '<script>alert(1)</script>' }).vid, null);
});

// ─── Visits and watching ────────────────────────────────────────────

test('opening the page before the reveal records the person once, with where they came from', async () => {
  const s = await setState({ phase: 'scheduled', broadcastId: 'live-100', kidSlug: 'remi', kidName: 'Remi', scheduledAt: new Date(Date.now() + 2 * H).toISOString() });
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'personA1', ref: 'mail.google.com' });
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'personA1' }); // a reload
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'personB1' }, FB_APP);
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'staffer01', who: 'staff' });
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'botbotbot' }, 'Googlebot/2.1');
  const a = await viewer('live-100', 'personA1');
  assert.equal(a.before_live, 1);
  assert.equal(a.src, 'email');
  assert.equal((await viewer('live-100', 'personB1')).src, 'facebook');
  assert.equal((await viewer('live-100', 'staffer01')).who, 'staff');
  assert.equal(await viewer('live-100', 'botbotbot'), null);
  const events = await DB.prepare(`SELECT COUNT(*) AS n FROM broadcast_events WHERE broadcast_id = 'live-100' AND type = 'view_live_page'`).first();
  assert.equal(events.n, 3, 'the two public visits (and the reload) are logged; staff\'s isn\'t');
  // Someone who came "direct" first and later from an email is credited to the email
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'personC1' });
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'personC1', src: 'email' });
  assert.equal((await viewer('live-100', 'personC1')).src, 'email');
  await beacon({ type: 'view_live_page', broadcastId: s.broadcastId, vid: 'personA1', src: 'qr' });
  assert.equal((await viewer('live-100', 'personA1')).src, 'email', 'a known source stays put');
});

test('live watching adds up real seconds: a report is worth the time since the last one, and marks the minutes', async () => {
  const liveAt = new Date(Date.now()).toISOString();
  const s = await setState({ phase: 'live', liveAt, source: 'stream' });
  travel(10 * S);
  await watch({ broadcastId: s.broadcastId, vid: 'personA1', kind: 'live', sec: 10 });
  travel(20 * S);
  await watch({ broadcastId: s.broadcastId, vid: 'personA1', kind: 'live', sec: 20 });
  travel(5 * S);
  await watch({ broadcastId: s.broadcastId, vid: 'personA1', kind: 'live', sec: 60 }); // claims 60 s after 5
  let a = await viewer('live-100', 'personA1');
  assert.equal(a.live_sec, 40, '10 + 20 + 10: a claim of 60 s, 5 s after the last report, is worth those 5 s + 5 for jitter');
  assert.equal(a.live_min, ',0,');
  travel(40 * S);
  await watch({ broadcastId: s.broadcastId, vid: 'personA1', kind: 'live', sec: 20 });
  a = await viewer('live-100', 'personA1');
  assert.equal(a.live_sec, 60);
  assert.equal(a.live_min, ',0,1,', 'that report covered 0:55 to 1:15: minutes 0 and 1');
  // A first report can't claim more than 15 s
  await watch({ broadcastId: s.broadcastId, vid: 'newcomer1', kind: 'live', sec: 500 });
  assert.equal((await viewer('live-100', 'newcomer1')).live_sec, 15);
  // A replay report during the live is the page being wrong: dropped
  await watch({ broadcastId: s.broadcastId, vid: 'personB1', kind: 'replay', sec: 20 });
  assert.equal((await viewer('live-100', 'personB1')).replay_sec, 0);
  // Nonsense is dropped
  for (const body of [{ broadcastId: 'live-999', vid: 'personZ1', kind: 'live', sec: 20 }, { broadcastId: 'nope', vid: 'personZ1', kind: 'live', sec: 20 }, { broadcastId: s.broadcastId, vid: 'personZ1', kind: 'live', sec: -5 }, { broadcastId: s.broadcastId, vid: 'personZ1', kind: 'other', sec: 5 }]) {
    assert.equal((await watch(body)).status, 204);
  }
  assert.equal(await viewer('live-999', 'personZ1'), null);
  assert.equal(await viewer('live-100', 'personZ1'), null);
  // Watching on a preview or local copy is a test
  await watch({ broadcastId: s.broadcastId, vid: 'tester001', kind: 'live', sec: 20 }, IPHONE, 'http://localhost:4321');
  assert.equal((await viewer('live-100', 'tester001')).who, 'test');
});

test('watching now, and the 30-second "at once" line with Facebook, YouTube and the hearts', async () => {
  const s = await b.readState(DB);
  await watch({ broadcastId: s.broadcastId, vid: 'personB1', kind: 'live', sec: 20 });
  await watch({ broadcastId: s.broadcastId, vid: 'staffer01', kind: 'live', sec: 20, who: 'staff' });
  const now = await rs.watchingNow(DB, s.broadcastId);
  assert.equal(now, 3, 'A, the newcomer and B reported in the last 50 s; staff and tests never count');
  const health = { monitor: { broadcastId: s.broadcastId, at: new Date(Date.now()).toISOString(), fbViewers: 40, ytViewers: null, ytVideoId: 'abcDEF12345' } };
  const hubStatus = async () => ({ reactions: { broadcastId: s.broadcastId, totals: { heart: 25, sun: 2 } } });
  assert.equal(await rs.sampleLive(env, s, health, { hubStatus }), true);
  assert.equal(await rs.sampleLive(env, s, health, { hubStatus }), false, 'once every 30 s');
  travel(60 * S);
  health.monitor.at = new Date(Date.now()).toISOString();
  health.monitor.fbViewers = 55;
  await rs.sampleLive(env, s, health, { hubStatus: async () => ({ reactions: { broadcastId: s.broadcastId, totals: { heart: 31, sun: 2 } } }) });
  const row = await DB.prepare('SELECT * FROM broadcast_stats WHERE broadcast_id = ?').bind(s.broadcastId).first();
  const series = JSON.parse(row.series);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0].slice(1), [3, 40, null]);
  assert.deepEqual(series[1].slice(1), [0, 55, null], 'nobody reported in the last 50 s by then');
  assert.equal(JSON.parse(row.youtube).videoId, 'abcDEF12345');
  assert.deepEqual(JSON.parse(row.reactions), { heart: 31, sun: 2 });
  // A reveal nobody tapped a heart in has 0 hearts, not "none recorded"
  await rs.sampleLive(env, { ...s, broadcastId: 'live-hearts0' }, { monitor: { broadcastId: 'live-hearts0', at: new Date(Date.now()).toISOString() } }, { hubStatus: async () => ({ ok: true, reactions: null }) });
  assert.equal((await DB.prepare(`SELECT reactions FROM broadcast_stats WHERE broadcast_id = 'live-hearts0'`).first()).reactions, '{}');
  // Hearts never go down (a hub restart can't wipe them)
  await rs.saveReactions(DB, s.broadcastId, { heart: 3 });
  assert.equal(JSON.parse((await DB.prepare('SELECT reactions FROM broadcast_stats WHERE broadcast_id = ?').bind(s.broadcastId).first()).reactions).heart, 31);
});

test('a live report flushed just after the end still counts as live; then the replay counts as replay', async () => {
  const s0 = await b.readState(DB);
  const endedAt = new Date(Date.now()).toISOString();
  await setState({ phase: 'replay', endedAt });
  travel(30 * S);
  await watch({ broadcastId: s0.broadcastId, vid: 'personB1', kind: 'live', sec: 15 });
  const before = (await viewer('live-100', 'personB1')).live_sec;
  assert.equal(before, 30, 'its first report (capped at 15) + this late 15');
  travel(3 * M);
  await watch({ broadcastId: s0.broadcastId, vid: 'personB1', kind: 'live', sec: 15 });
  assert.equal((await viewer('live-100', 'personB1')).live_sec, 30, 'too long after the end to be live');
  await watch({ broadcastId: s0.broadcastId, vid: 'personD1', kind: 'replay', sec: 10 });
  travel(60 * S);
  await watch({ broadcastId: s0.broadcastId, vid: 'personD1', kind: 'replay', sec: 60 });
  assert.equal((await viewer('live-100', 'personD1')).replay_sec, 70);
});

// ─── History ────────────────────────────────────────────────────────

test('History: people, before / live / replay, average watch, there for the reveal, sources, at once', async () => {
  const s = await b.readState(DB);
  const liveAt = s.liveAt;
  await DB.prepare(`INSERT INTO broadcasts (id, kid_slug, kid_name, title, live_at, ended_at, phase, replay_uid, source, data, created_at)
    VALUES (?, 'remi', 'Remi', 'Remi''s room reveal', ?, ?, 'replay', 'rec1', 'stream', ?, ?)`)
    .bind(s.broadcastId, liveAt, s.endedAt, JSON.stringify({ revealAtSeconds: 70 }), new Date(Date.now() - 2 * D).toISOString()).run();
  const rows = (await DB.prepare('SELECT * FROM broadcasts').all()).results.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
  const { byId } = await rs.historyStats(DB, rows);
  const st = byId['live-100'];
  assert.equal(st.people, 5, 'A, B, C, the newcomer and D (staff, tests and bots left out)');
  assert.equal(st.before, 3);
  assert.equal(st.live, 3, 'A, B and the newcomer played it live');
  assert.equal(st.avgLiveSec, Math.round((60 + 30 + 15) / 3), 'A 60 s, B 30 s, the newcomer 15 s');
  assert.equal(st.replay, 1);
  assert.equal(st.staff, 1);
  assert.equal(st.tests, 1);
  assert.equal(st.revealAt, 70);
  assert.equal(st.atReveal, 3, 'the reveal was 1:10 in: A, the newcomer and B were watching in that minute; D only saw the replay');
  assert.deepEqual(st.sources, { email: 2, facebook: 1, direct: 2 });
  assert.equal(st.atOnce.peakAll, 55);
  assert.equal(st.atOnce.peakSite, 3);
  assert.equal(st.atOnce.hasFb, true);
  assert.equal(st.atOnce.hasYt, false);
  assert.equal(st.heartsTotal, 31, 'hearts only (the page has one heart button)');
  assert.equal(st.test, false);
});

test('History: rehearsals and reveals from before counting began', async () => {
  const old = new Date(Date.now() - 400 * D).toISOString();
  await DB.prepare(`INSERT INTO broadcasts (id, title, live_at, ended_at, phase, source, data, created_at) VALUES ('live-1', 'Live room reveal', ?, ?, 'replay', 'stream', '{}', ?)`).bind(old, old, old).run();
  await DB.prepare(`INSERT INTO broadcasts (id, kid_slug, title, scheduled_at, phase, data, created_at) VALUES ('live-2', 'isla', 'TEST · Isla''s room reveal', ?, 'cancelled', '{"test":true}', ?)`).bind(old, old).run();
  const rows = (await DB.prepare(`SELECT * FROM broadcasts WHERE id IN ('live-1','live-2')`).all()).results.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
  const { byId, since } = await rs.historyStats(DB, rows);
  assert.ok(since);
  assert.equal(byId['live-1'].counted, false, 'before the site counted people');
  assert.equal(byId['live-2'].test, true);
});

test('the "at once" summary and thinning keep the real peak', () => {
  const series = [[0, 1, null, null], [30, 4, 10, null], [60, 6, 12, 3], [90, 2, null, null]];
  const sum = rs.summarizeSeries(series);
  assert.equal(sum.peakAll, 21);
  assert.equal(sum.peakAllAt, 60);
  assert.deepEqual(sum.peakSplit, [6, 12, 3], 'where the peak crowd was at that moment');
  assert.equal(sum.peakSite, 6);
  assert.equal(sum.peakFb, 12);
  assert.equal(sum.peakYt, 3);
  const long = Array.from({ length: 1000 }, (_, i) => [i * 30, i === 777 ? 99 : 1, null, null]);
  const thin = rs.thinSeries(long, 240);
  assert.ok(thin.length <= 240);
  assert.ok(thin.some((p) => p[1] === 99), 'the peak survives');
});

// ─── After the reveal: Facebook and YouTube ─────────────────────────

test('Facebook and YouTube totals: read on a slowing schedule, a missing permission said plainly', async () => {
  await DB.prepare(`UPDATE broadcasts SET fb_live_video_id = '1558415092997171', live_at = ?, ended_at = ? WHERE id = 'live-100'`).bind(new Date(Date.now() - H).toISOString(), new Date(Date.now() - 30 * M).toISOString()).run();
  const readState = async () => ({ ...(await b.readState(DB)), phase: 'replay' });
  const r1 = await rs.maybeRefreshRevealStats(env, { readState, hubStatus: async () => null, force: true });
  assert.deepEqual(r1.refreshed, ['live-100']);
  let row = await DB.prepare(`SELECT * FROM broadcast_stats WHERE broadcast_id = 'live-100'`).first();
  let f = JSON.parse(row.facebook);
  assert.equal(f.videoId, '1120737860658441', `found from the live video (${row.facebook}; ${net.calls.filter((u) => u.includes('graph')).join(' | ')})`);
  assert.equal(f.unique, 312);
  assert.equal(f.views, 480);
  assert.equal(f.avgSec, 95);
  assert.equal(f.liveUnique, 140);
  assert.equal(f.reactions, 57);
  assert.equal(f.comments, 12);
  assert.equal(f.missing, null);
  const y = JSON.parse(row.youtube);
  assert.equal(y.views, 230);
  assert.equal(y.likes, 18);
  assert.ok(Date.parse(row.next_check_at) - Date.now() <= 15 * M + S, 'the first day: every 15 minutes');
  // Not due again yet
  const r2 = await rs.maybeRefreshRevealStats(env, { readState, hubStatus: async () => null, force: true });
  assert.deepEqual(r2.refreshed, []);
  // Facebook stops sharing view totals: the last good numbers stay, and why is said
  net.insights = 'denied';
  travel(16 * M);
  await rs.maybeRefreshRevealStats(env, { readState, hubStatus: async () => null, force: true });
  row = await DB.prepare(`SELECT * FROM broadcast_stats WHERE broadcast_id = 'live-100'`).first();
  f = JSON.parse(row.facebook);
  assert.equal(f.missing, 'read_insights');
  assert.equal(f.unique, 312, 'kept');
  assert.equal(f.reactions, 57);
  net.insights = 'ok';
  // Later reads slow down, then stop after 30 days
  assert.ok(Date.parse(rs.nextCheck(new Date(Date.now() - 3 * D).toISOString())) - Date.now() === 2 * H);
  assert.ok(Date.parse(rs.nextCheck(new Date(Date.now() - 10 * D).toISOString())) - Date.now() === 24 * H);
  assert.equal(rs.nextCheck(new Date(Date.now() - 31 * D).toISOString()), null);
});

test('Site → Automations: times only, and whether Facebook is holding back its totals', async () => {
  const f = await rs.revealStatsFacts(DB);
  assert.ok(f.lastSeenAt && f.lastSampleAt && f.lastTotalsAt);
  assert.equal(f.fbMissing, true, 'the last read was refused read_insights');
  assert.deepEqual(Object.keys(f).sort(), ['fbMissing', 'lastSampleAt', 'lastSeenAt', 'lastTotalsAt'], 'no counts or ids');
});

// ─── The admin table ────────────────────────────────────────────────

test('admin: sorting puts missing numbers last, the average reveal and the best of each column', () => {
  const row = (id, live_at, stats, extra = {}) => ({ id, kid_slug: id, live_at, phase: 'replay', messageCount: 0, stats: { counted: true, test: false, ...stats }, ...extra });
  const rows = [
    row('a', '2026-11-01T20:00:00Z', { people: 120, live: 80, avgLiveSec: 400, atReveal: 60, replay: 30, heartsTotal: 50, atOnce: { peakAll: 90 } }),
    row('b', '2026-11-08T20:00:00Z', { people: 200, live: 150, avgLiveSec: 300, atReveal: 140, replay: 10, heartsTotal: 20, atOnce: { peakAll: 160 } }),
    row('c', '2026-10-01T20:00:00Z', { people: 0 }, { stats: { counted: false } }),
    row('t', '2026-11-05T20:00:00Z', { people: 999, test: true }),
    { id: 'u', kid_slug: 'u', phase: 'scheduled', scheduled_at: '2026-11-18T21:00:00Z', stats: { counted: true, people: 39, before: 39 } },
  ];
  assert.deepEqual(rows.filter(admin.compared).map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(rows.filter(admin.inTable).map((r) => r.id), ['a', 'b', 'c', 'u'], 'the rehearsal is kept out; the next reveal is in');
  assert.deepEqual(admin.sortRows(rows.filter(admin.inTable), 'people', 'desc').map((r) => r.id), ['b', 'a', 'u', 'c'], 'c has no count: last');
  assert.deepEqual(admin.sortRows(rows.filter(admin.inTable), 'people', 'asc').map((r) => r.id), ['u', 'a', 'b', 'c']);
  assert.deepEqual(admin.sortRows(rows.filter(admin.inTable), null, 'desc').map((r) => r.id), ['u', 'b', 'a', 'c'], 'newest first');
  const sum = admin.columnSummary(rows.filter(admin.inTable));
  assert.equal(sum.people.avg, 160, 'compared reveals with a count: a and b');
  assert.equal(sum.people.best, 200);
  assert.equal(sum.there.avg, (60 / 80 + 140 / 150) / 2);
  assert.equal(sum.atOnce.best, 160);
  assert.equal(admin.fmtDur(65), '1:05');
  assert.equal(admin.fmtDur(3725), '1:02:05');
  assert.equal(admin.fmtPct(0.756), '76%');
  assert.equal(admin.fmtN(null), '—');
});

test('admin: a reveal live right now, ties, zeros, one reveal and rounding never mislead', () => {
  const row = (id, live_at, stats, extra = {}) => ({ id, kid_slug: id, live_at, phase: 'replay', messageCount: 0, stats: { counted: true, test: false, ...stats }, ...extra });
  const a = row('a', '2026-11-01T20:00:00Z', { people: 100, live: 50, replay: 10, heartsTotal: 0, atOnce: { peakAll: 40 } });
  const b = row('b', '2026-11-02T20:00:00Z', { people: 100, live: 70, replay: 20, heartsTotal: 0, atOnce: { peakAll: 60 } });
  const now = row('n', '2026-11-03T20:00:00Z', { people: 25, live: 25, replay: 0, heartsTotal: 3, atOnce: { peakAll: 20 } }, { phase: 'live', ended_at: null });
  const rehearsal = row('t', '2026-11-04T20:00:00Z', { people: 5 }, { stats: null, data: { test: true } });
  assert.equal(admin.compared(now), false, 'still live: out of the averages');
  assert.equal(admin.inTable(now), true, 'but listed with what it has so far');
  assert.equal(admin.compared(rehearsal) || admin.inTable(rehearsal), false, 'a rehearsal stays out even when its numbers failed to load');
  const sum = admin.columnSummary([a, b, now]);
  assert.equal(sum.people.avg, 100);
  assert.equal(sum.people.best, null, 'a tie has no best');
  assert.equal(sum.hearts.best, null, 'nor does a column of zeros');
  assert.equal(sum.live.best, 70);
  const replayCol = admin.COLUMNS.find((c) => c.key === 'replay');
  assert.equal(replayCol.get(now.stats, now), null, 'no replay yet while live');
  assert.equal(admin.columnSummary([a]).people.avg, null, 'one reveal isn\'t an average');
  assert.equal(admin.fmtPct(199 / 200), '99%');
  assert.equal(admin.fmtPct(1 / 1000), '<1%');
  assert.equal(admin.fmtPct(1.55), '100%');
  assert.deepEqual(admin.yScale(5).ticks, [0, 2, 4, 6], 'whole-number gridlines');
  assert.deepEqual(admin.yScale(25).ticks, [0, 10, 20, 30]);
  assert.deepEqual(admin.yScale(0).ticks, [0, 1, 2]);
  assert.ok(admin.yScale(1_234_567).max >= 1_234_567);
});

test('admin: rows left behind, bold as the reader sees it, no replay without a recording, gaps aren\'t zero', () => {
  const settled = admin.settle([
    { id: 'old', phase: 'live', live_at: '2026-10-01T20:00:00Z', updated_at: '2026-10-01T21:00:00Z' },
    { id: 'gone', phase: 'scheduled', live_at: null },
    { id: 'now', phase: 'live', live_at: '2026-11-18T21:00:00Z' },
  ], 'now');
  assert.deepEqual(settled.map((r) => r.phase), ['ended', 'cancelled', 'live'], 'only the broadcast the site is on can still be live or coming up');
  assert.equal(settled[0].ended_at, '2026-10-01T21:00:00Z');
  const row = (id, stats, extra = {}) => ({ id, kid_slug: id, live_at: '2026-11-01T20:00:00Z', phase: 'replay', replay_uid: 'r', messageCount: 0, stats: { counted: true, ...stats }, ...extra });
  const sum = admin.columnSummary([row('a', { atReveal: 874, live: 1000 }), row('b', { atReveal: 871, live: 1000 })]);
  assert.equal(sum.there.best, null, '87% and 87%: neither is bold');
  const noRec = row('n', { replay: 0 }, { replay_uid: null });
  assert.equal(admin.COLUMNS.find((c) => c.key === 'replay').get(noRec.stats, noRec), null, 'no recording, no replay number');
  const gap = rs.summarizeSeries([[0, 50, 100, null], [30, 60, null, null], [60, 55, 110, null]]);
  assert.equal(gap.peakAll, 165, 'a moment Facebook wasn\'t read isn\'t a moment it had nobody');
  assert.equal(gap.avgAll, Math.round(((150 + 160 + 165) / 3) * 10) / 10, 'a missed reading stands in for up to 2 minutes');
  // Facebook read only in the first 90 s, then never again: the site's own peak still counts
  const lost = rs.summarizeSeries(Array.from({ length: 81 }, (_, k) => [k * 30, k === 40 ? 300 : 40, k < 4 ? 5 : null, null]));
  assert.equal(lost.peakAll, 300, 'never less than one place\'s own peak');
  assert.equal(lost.peakPartial, true, 'and it says not every place was read then');
  assert.equal(lost.avgAll, null, 'no average when most of the reveal wasn\'t read everywhere');
});

// ─── The live page's meter ──────────────────────────────────────────

test('watch meter: counts only playing, showing time; reports at 10 s, then every 20 s live, and what is left at the end', async () => {
  const src = transformSync(readFileSync('src/utils/live-stats.ts', 'utf8'), { loader: 'ts', format: 'esm' }).code;
  const listeners = {};
  globalThis.document = { visibilityState: 'visible', addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, removeEventListener: () => {} };
  globalThis.window = { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, removeEventListener: () => {} };
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  let t = 0;
  const video = { paused: false, ended: false, readyState: 4, currentTime: 0 };
  const reports = [];
  const ticks = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { ticks.push(fn); return 1; };
  const meter = mod.watchMeter({ kind: 'live', video: () => video, report: (k, sec, final) => reports.push([k, sec, final]), now: () => t });
  globalThis.setInterval = realSetInterval;
  // Its clock moves while it plays (the meter counts the picture moving)
  const step = (n, f = () => {}) => { for (let i = 0; i < n; i++) { t += 1000; if (!video.paused && !video.stalled) video.currentTime += 1; f(i); ticks[0](); } };
  step(10);
  assert.deepEqual(reports, [['live', 10, false]], 'the first report after 10 s');
  step(4);
  video.paused = true; step(30); video.paused = false;
  assert.deepEqual(reports[1], ['live', 4, false], 'a pause sends what was watched before it, so its minutes are the right ones');
  reports.splice(1, 1);
  assert.equal(reports.length, 1, 'paused time isn\'t watching');
  globalThis.document.visibilityState = 'hidden'; step(30); globalThis.document.visibilityState = 'visible';
  assert.equal(reports.length, 1, 'a hidden tab isn\'t watching');
  t += 60_000; video.currentTime += 60; ticks[0](); // a sleeping laptop wakes up
  assert.equal(reports.length, 1, 'a long gap isn\'t counted');
  video.stalled = true; step(30); video.stalled = false;
  assert.equal(reports.length, 1, 'a stalled picture (buffering, its clock stuck) isn\'t watching');
  step(20);
  assert.deepEqual(reports[1], ['live', 20, false]);
  step(7);
  meter.stop();
  assert.deepEqual(reports[2], ['live', 7, true], 'what is left goes when it stops');
  meter.stop();
  assert.equal(reports.length, 3, 'once');
  delete globalThis.document; delete globalThis.window;
});
