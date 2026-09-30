/**
 * Facebook replay archiver — which kid page does a replay land on?
 * Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const H = 3600e3, M = 60e3;

// ─── Fake network ───────────────────────────────────────────────────
const sim = { fbVideos: [], nextUid: 1 };
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ url, method, body: init.body });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://graph.facebook.com/v25.0/page/videos')) return json({ data: sim.fbVideos });
  const detail = url.match(/^https:\/\/graph\.facebook\.com\/v25\.0\/(\d+)\?/);
  if (detail) {
    const v = sim.fbVideos.find(x => x.id === detail[1]);
    return v ? json({ id: v.id, title: v.title, description: v.description, created_time: v.created_time, source: `https://video.xx.fbcdn.net/${v.id}.mp4` }) : json({ error: { message: 'Unsupported get request' } }, 400);
  }
  if (url === 'https://api.cloudflare.com/client/v4/accounts/acct/stream/copy' && method === 'POST') {
    return json({ success: true, result: { uid: `uid${String(sim.nextUid++).padStart(3, '0')}` } });
  }
  if (url.startsWith('https://hook.test/')) return new Response('ok', { status: 200 });
  if (url.startsWith('https://hooks.slack.test/')) return new Response('ok', { status: 200 });
  return new Response('not mocked: ' + url, { status: 599 });
};
const callsTo = (frag) => calls.filter(c => c.url.includes(frag));

let env, a, b, attachEndpoint;
const kid = async (slug, name, year = 2026, extra = {}) => env.DB.prepare(`INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)`)
  .bind(slug, JSON.stringify({ name, slug, year, ...extra }), name, year, 'completed').run();
const kidData = async (slug) => JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first()).data);
const ctx = (body) => ({ env, data: { userEmail: 'peter@test' }, request: new Request('https://x/api/fb-attach-video', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  env = { DB, FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'fbtok', CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 'stok', CF_PAGES_DEPLOY_HOOK: 'https://hook.test/deploy', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/alerts' };
  a = await import('../functions/api/_fb-archive.js');
  b = await import('../functions/api/_broadcast.js');
  attachEndpoint = await import('../functions/api/fb-attach-video.js');
  await b.ensureSchema(DB); // broadcasts table
  const y = new Date().getUTCFullYear();
  await kid('helen', 'Helen', 2021);
  await kid('remi-and-nico', 'Remi & Nico', y);
  await kid('marie-and-alondra', 'Marie and Alondra', y);
  await kid('amari', 'Amari', y);
  await kid('adrian-2019', 'Adrian', 2019);
  await kid('adrian-now', 'Adrian', y);
  await kid('nico-2018', 'Nico', 2018);
  await kid('anthony-and-lyric', 'Anthony Jr. & Lyric', 2020);
});

after(() => { globalThis.fetch = realFetch; });

const REMI_POST = {
  title: 'We are so excited to reveal Remi and Nico’s accessible bathroom!! This truly cou',
  description: 'We are so excited to reveal Remi and Nico’s accessible bathroom!! This truly could not have happened without our partners. Thank you Helen and Jimmy Carlos for making it possible, and Amari’s family for cheering us on.',
};

test('normalize: & and "and" agree, curly apostrophes and entities fold', () => {
  assert.equal(a.normalizeNameText('Remi & Nico'), 'remi and nico');
  assert.equal(a.normalizeNameText('Remi &amp; Nico'), 'remi and nico');
  assert.equal(a.normalizeNameText('Remi+Nico'), 'remi and nico');
  assert.equal(a.normalizeNameText('  Marie   and Alondra’s '), "marie and alondra's");
});

test('postLead: title wins, otherwise the opening of the description', () => {
  assert.equal(a.postLead(REMI_POST), REMI_POST.title);
  assert.equal(a.postLead({ description: 'x'.repeat(500) }).length, 160);
  assert.equal(a.postLead({}), '');
});

test('name match: "Remi and Nico" finds the kid named "Remi & Nico"', async () => {
  const k = await a.findKidByName(env.DB, REMI_POST.title);
  assert.equal(k?.slug, 'remi-and-nico');
});

test('name match: whole names only, and two kids with one name is ambiguous across all years', async () => {
  assert.equal(await a.findKidByName(env.DB, 'Amaris big day'), null);
  assert.equal(await a.findKidByName(env.DB, 'Adrian’s reveal is here'), null);
  assert.equal(await a.findKidByName(env.DB, ''), null);
});

test('name match: any order, and the fuller name beats a subset ("Nico" vs "Remi & Nico")', () => {
  const rows = [{ slug: 'rn', name: 'Remi & Nico' }, { slug: 'n', name: 'Nico' }, { slug: 'al', name: 'Anthony Jr. & Lyric' }];
  assert.deepEqual(a.matchKids(rows, 'Nico and Remi are home!').map(k => k.slug), ['rn']);
  assert.deepEqual(a.matchKids(rows, 'Welcome home Nico').map(k => k.slug), ['n']);
  assert.deepEqual(a.matchKids(rows, 'Lyric and Anthony Jr. reveal').map(k => k.slug), ['al']);
});

test('resolveKid: this year beats a same-named kid from years ago (duplicate names)', async () => {
  const k = await a.resolveKid(env.DB, { title: 'Adrian’s reveal is here', createdTime: new Date().toISOString() });
  assert.equal(k?.slug, 'adrian-now');
  assert.equal(k?.via, 'name');
});

test('resolveKid ignores sponsors thanked in the post body (the Helen bug)', async () => {
  const k = await a.resolveKid(env.DB, { ...REMI_POST, createdTime: '2026-09-28T20:01:54+0000' });
  assert.equal(k?.slug, 'remi-and-nico');
  assert.equal(k?.via, 'name');
  // Only the body names a kid → nobody, not Helen
  const none = await a.resolveKid(env.DB, { title: 'Tonight’s big reveal!!', description: 'Thank you Helen and Jimmy Carlos for making it possible!', createdTime: new Date().toISOString() });
  assert.equal(none, null, 'a 2021 kid thanked in the body never qualifies');
  // Title says nothing, body names one of this year's kids → that kid
  const body = await a.resolveKid(env.DB, { title: 'Tonight’s big reveal!!', description: 'Thank you Helen and Jimmy Carlos for making sweet Amari’s new room possible!', createdTime: new Date().toISOString() });
  assert.equal(body?.slug, 'amari');
  assert.equal(body?.via, 'post');
});

test('a reveal scheduled on the Broadcast page decides the kid, whatever the post says', async () => {
  const sched = '2026-10-04T18:00:00.000Z';
  await env.DB.prepare(`INSERT INTO broadcasts (id, kid_slug, kid_name, title, scheduled_at, phase, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('bc1', 'amari', 'Amari', "Amari's room reveal", sched, 'idle', 'stream', sched, sched).run();
  const inWindow = new Date(Date.parse(sched) + 40 * M).toISOString();
  assert.equal((await a.findKidByBroadcast(env.DB, inWindow))?.slug, 'amari');
  assert.equal(await a.findKidByBroadcast(env.DB, new Date(Date.parse(sched) + 10 * H).toISOString()), null);
  assert.equal(await a.findKidByBroadcast(env.DB, 'garbage'), null);
  const k = await a.resolveKid(env.DB, { ...REMI_POST, createdTime: inWindow });
  assert.equal(k?.slug, 'amari');
  assert.equal(k?.via, 'broadcast');
  // Two different kids planned in the same window → ambiguous → null
  await env.DB.prepare(`INSERT INTO broadcasts (id, kid_slug, kid_name, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind('bc2', 'helen', 'Helen', sched, sched, sched).run();
  assert.equal(await a.findKidByBroadcast(env.DB, inWindow), null);
  await env.DB.prepare(`DELETE FROM broadcasts WHERE id IN ('bc1','bc2')`).run();
});

test('sweep: the Remi & Nico replay lands on Remi & Nico, not Helen, and deploys', async () => {
  const created = new Date(Date.now() - 5 * H).toISOString();
  sim.fbVideos = [{ id: '1635000014874417', live_status: 'VOD', created_time: created, ...REMI_POST }];
  calls.length = 0;
  const summary = await a.sweepArchives(env);
  assert.equal(summary.error, null);
  assert.equal(summary.archived, 1);
  assert.equal(summary.autoDeployed, true);
  assert.equal(callsTo('/stream/copy').length, 1);
  assert.equal(callsTo('hook.test/deploy').length, 1);
  assert.equal((await kidData('remi-and-nico')).revealVideoUrl, 'https://watch.cloudflarestream.com/uid001');
  assert.equal((await kidData('helen')).revealVideoUrl, undefined);
  const st = await a.readArchiveState(env.DB);
  assert.equal(st.archived['1635000014874417'].attachedTo, 'remi-and-nico');
  assert.equal(st.archived['1635000014874417'].via, 'name');
  assert.equal(st.archived['1635000014874417'].lead, REMI_POST.title);
});

test('sweep: an unplaceable replay is saved, flagged, alerted once, then placed by hand', async () => {
  const st0 = await a.readArchiveState(env.DB);
  st0.checkedAt = new Date(Date.now() - 7 * H).toISOString(); // make the next sweep due
  await env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('fb-archive', JSON.stringify(st0), new Date().toISOString()).run();
  const created = new Date(Date.now() - 4 * H).toISOString();
  sim.fbVideos = [{ id: '2000000000000001', live_status: 'VOD', created_time: created, title: 'Tonight’s big reveal!!', description: 'Thank you Helen and Jimmy Carlos!' }];
  calls.length = 0;
  const s1 = await a.sweepArchives(env);
  assert.equal(s1.archived, 1);
  assert.equal(s1.needsKid, 1);
  assert.equal(s1.autoDeployed, false);
  assert.equal(callsTo('hooks.slack.test').length, 1, 'one admin alert');
  assert.equal((await kidData('helen')).revealVideoUrl, undefined, 'sponsor in the body never wins');

  // Not due again → only retroAttach runs; still nobody matches, and no second alert
  const s2 = await a.sweepArchives(env);
  assert.equal(s2.fbChecked, false);
  assert.equal(callsTo('hooks.slack.test').length, 1);

  // The admin list shows it as needing a kid
  const rows = await a.annotateArchived(env.DB, [{ id: '2000000000000001' }, { id: '1635000014874417' }, { id: '999' }]);
  assert.equal(rows[0].needsKid, true);
  assert.equal(rows[0].streamUid, 'uid002');
  assert.equal(rows[1].attachedName, 'Remi & Nico');
  assert.equal(rows[2].streamUid, null);

  // Human picks Marie and Alondra
  calls.length = 0;
  const r = await a.assignArchivedVideo(env, { videoId: '2000000000000001', kidSlug: 'marie-and-alondra', by: 'peter@test' });
  assert.equal(r.kidName, 'Marie and Alondra');
  assert.equal(r.deployed, true, 'manual placement deploys even inside the cooldown');
  assert.equal((await kidData('marie-and-alondra')).revealVideoUrl, 'https://watch.cloudflarestream.com/uid002');
  const st = await a.readArchiveState(env.DB);
  assert.equal(st.archived['2000000000000001'].attachedTo, 'marie-and-alondra');
  assert.equal(st.archived['2000000000000001'].needsKid, undefined);
  assert.equal(st.archived['2000000000000001'].via, 'manual');
});

test('assign: moving a replay takes it off the old page, and null takes it off every page', async () => {
  // Simulate the real mistake: the Remi & Nico replay sitting on Helen's page
  const st = await a.readArchiveState(env.DB);
  st.archived['1635000014874417'].attachedTo = 'helen';
  await env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('fb-archive', JSON.stringify(st), new Date().toISOString()).run();
  const helen = await kidData('helen'); helen.revealVideoUrl = 'https://watch.cloudflarestream.com/uid001';
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(helen), 'helen').run();
  const remi = await kidData('remi-and-nico'); delete remi.revealVideoUrl;
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(remi), 'remi-and-nico').run();

  const r = await a.assignArchivedVideo(env, { videoId: '1635000014874417', kidSlug: 'remi-and-nico', by: 'peter@test' });
  assert.equal(r.kidSlug, 'remi-and-nico');
  assert.equal((await kidData('helen')).revealVideoUrl, undefined, 'Helen no longer shows the wrong video');
  assert.equal((await kidData('remi-and-nico')).revealVideoUrl, 'https://watch.cloudflarestream.com/uid001');

  // A link a human changed to something else is left alone when detaching
  const marie = await kidData('marie-and-alondra'); marie.revealVideoUrl = 'https://watch.cloudflarestream.com/somethingelse';
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(marie), 'marie-and-alondra').run();
  const off = await a.assignArchivedVideo(env, { videoId: '2000000000000001', kidSlug: null, by: 'peter@test' });
  assert.equal(off.kidSlug, null);
  assert.equal((await kidData('marie-and-alondra')).revealVideoUrl, 'https://watch.cloudflarestream.com/somethingelse');
  const st2 = await a.readArchiveState(env.DB);
  assert.equal(st2.archived['2000000000000001'].attachedTo, null);
  assert.equal(st2.archived['2000000000000001'].attachSkipped, true, 'the sweep will not put it back');
  const s = await a.sweepArchives(env);
  assert.equal(s.attached, 0);

  // Audit trail names the human
  const audit = await env.DB.prepare(`SELECT user_email, entity_slug, changes FROM audit_log WHERE entity_type = 'kid' ORDER BY id DESC LIMIT 3`).all();
  assert.ok(audit.results.every(x => x.user_email === 'peter@test'));
});

test('auto paths never replace a link a kid already has', async () => {
  assert.equal(await a.attachToKid(env, 'marie-and-alondra', 'uid009', 'x', 'auto-archive'), null);
  assert.equal(await a.attachToKid(env, 'marie-and-alondra', 'somethingelse', 'x', 'auto-archive'), 'marie-and-alondra', 'same link is idempotent');
  assert.equal(await a.attachToKid(env, 'nobody', 'uid009', 'x'), null);
});

test('endpoint: validates input, then attaches', async () => {
  let res = await attachEndpoint.onRequestPost(ctx({ videoId: 'abc', kidSlug: 'amari' }));
  assert.equal(res.status, 400);
  res = await attachEndpoint.onRequestPost(ctx({ videoId: '2000000000000001', kidSlug: 'Not A Slug' }));
  assert.equal(res.status, 400);
  res = await attachEndpoint.onRequestPost(ctx({ videoId: '3000000000000000', kidSlug: 'amari' }));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not been saved to Stream/);
  res = await attachEndpoint.onRequestPost(ctx({ videoId: '2000000000000001', kidSlug: 'amari' }));
  const d = await res.json();
  assert.equal(d.success, true, JSON.stringify(d));
  assert.equal(d.kidName, 'Amari');
  assert.equal((await kidData('amari')).revealVideoUrl, 'https://watch.cloudflarestream.com/uid002');
});

test('self-correction: an old automatic mistake (replay on Helen) moves to Remi & Nico on the next sweep, no human', async () => {
  const UID = '38fa3559c47fdded4e5d9fe2afde9d95';
  const setLink = async (slug, url) => { const d = await kidData(slug); if (url) d.revealVideoUrl = url; else delete d.revealVideoUrl; await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(d), slug).run(); };
  await setLink('helen', `https://watch.cloudflarestream.com/${UID}`);
  await setLink('remi-and-nico', null);
  const st = await a.readArchiveState(env.DB);
  // Exactly what production holds: legacy entry, no `via`, no `lead`
  st.archived['1635000014874418'] = { uid: UID, name: `${REMI_POST.title} (${new Date().toISOString().slice(0, 10)})`, at: new Date().toISOString(), attachedTo: 'helen', migrated: true };
  st.lastAutoDeployAt = new Date(Date.now() - 20 * M).toISOString();
  await env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('fb-archive', JSON.stringify(st), new Date().toISOString()).run();
  calls.length = 0;
  const s = await a.sweepArchives(env);
  assert.equal(s.corrected, 1);
  assert.equal(s.autoDeployed, true);
  assert.equal((await kidData('helen')).revealVideoUrl, undefined, 'Helen cleared');
  assert.equal((await kidData('remi-and-nico')).revealVideoUrl, `https://watch.cloudflarestream.com/${UID}`, 'Remi & Nico has it');
  const after = (await a.readArchiveState(env.DB)).archived['1635000014874418'];
  assert.equal(after.attachedTo, 'remi-and-nico');
  assert.equal(after.correctedFrom, 'helen');
  assert.equal(after.verified, true);
  // Runs once: a second sweep changes nothing
  const s2 = await a.sweepArchives(env);
  assert.equal(s2.corrected, 0);
  // Manual placements are never re-checked
  const man = (await a.readArchiveState(env.DB)).archived['2000000000000001'];
  assert.equal(man.via, 'manual');
});
