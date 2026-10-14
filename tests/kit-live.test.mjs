/**
 * Kit "we're live" email — sent to the list when a scheduled reveal goes live
 * Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };
const H = 3600e3, M = 60e3, S = 1000;

const sim = { live: false, videoUID: null, kitFail: false, fbVideos: [], fbPosts: [] };
const kitPosts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('cloudflarestream.com/') && url.endsWith('/lifecycle')) return json({ isInput: true, videoUID: sim.live ? sim.videoUID : null, live: sim.live });
  if (url === 'https://api.kit.com/v4/broadcasts' && method === 'POST') {
    const body = JSON.parse(init.body);
    kitPosts.push(body);
    if (sim.kitFail) return json({ errors: ['Kit is down'] }, 422);
    return json({ broadcast: { id: 9000 + kitPosts.length, ...body } }, 201);
  }
  if (url.startsWith('https://graph.facebook.com/v25.0/page/videos')) return json({ data: sim.fbVideos });
  if (url.startsWith('https://graph.facebook.com/v25.0/page/posts')) return json({ data: sim.fbPosts });
  if (url.startsWith('https://api.resend.com/')) return json({ data: [] });
  return json({ success: true, result: [] });
};

let env, b;
const liveKitPosts = () => kitPosts.filter(p => p.send_at);

async function goLive() {
  sim.live = true; sim.videoUID = 'vid1';
  return b.runTick(env, { source: 'test', force: true });
}
const tick = () => b.runTick(env, { source: 'test', force: true });
async function goLiveSteady() {
  await goLive();
  travel(3 * M + 5 * S);
  return tick();
}
async function endAndReset() {
  sim.live = false;
  await b.runTick(env, { source: 'test', force: true });
  travel(50 * S);
  await b.runTick(env, { source: 'test', force: true });
  await b.adminAction(env, 'reset', {}, 'peter@test');
  sim.fbVideos = []; sim.fbPosts = [];
  travel(2 * M);
}

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const year = new Date().getUTCFullYear();
  const kid = (slug, name, extra = {}) => DB.prepare(`INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)`).bind(slug, JSON.stringify({ name, slug, heroImage: `kids/${slug}/hero`, ...extra }), name, year, 'in-progress').run();
  await kid('remi', 'Remi');
  await kid('marilyn', 'Marilyn');
  await kid('helen', 'Helen', { revealVideoUrl: 'https://watch.cloudflarestream.com/old' }); // already revealed: never a candidate
  env = { DB, CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 'tok', KIT_API_KEY: 'kit_test', FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'fbtok' };
  b = await import('../functions/api/_broadcast.js');
  await b.ensureSchema(DB);
  const cfg = await b.readConfig(DB);
  cfg.liveInput = { uid: 'in1' };
  await b.writeConfig(DB, cfg);
});

after(() => { Date.now = realNow; globalThis.fetch = realFetch; });

test('defaults: on, all subscribers', async () => {
  const cfg = await b.readConfig(env.DB);
  assert.equal(cfg.kitLive.enabled, true);
  assert.equal(cfg.kitLive.audience.type, 'all');
});

test('scheduled reveal going live emails the whole Kit list once', async () => {
  const r = await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: new Date(Date.now() + 10 * M).toISOString() }, 'peter@test');
  assert.equal(r.success, true, r.error);
  kitPosts.length = 0;
  const first = await goLive();
  assert.equal(first.state.phase, 'live');
  assert.equal(liveKitPosts().length, 0, 'nothing in the first 3 minutes');
  travel(3 * M + 5 * S);
  const t = await tick();
  assert.ok(t.work.includes('kit-live'), t.work.join(','));
  const sends = liveKitPosts();
  assert.equal(sends.length, 1);
  const k = sends[0];
  assert.match(k.subject, /We're live: Remi's room reveal/);
  assert.ok(Date.parse(k.send_at) > Date.now(), 'scheduled a moment ahead so Kit accepts it');
  assert.equal(k.subscriber_filter, undefined, 'no filter = every subscriber');
  assert.match(k.content, /\{\{ unsubscribe_url \}\}/);
  assert.match(k.content, /subscribed to updates/);
  assert.doesNotMatch(k.content, /You asked us to remind you/);
  assert.match(k.content, /live\/remi\//);
  const st = await b.readState(env.DB);
  assert.equal(st.kit.live.id, 9001);
  assert.equal(st.kit.live.audience, 'All subscribers');

  const again = await b.runTick(env, { source: 'test', force: true });
  assert.ok(!again.work.includes('kit-live'));
  const manual = await b.adminAction(env, 'sendKitLive', {}, 'peter@test');
  assert.equal(manual.success, false, 'never twice for one reveal');
  assert.equal(liveKitPosts().length, 1);
  await endAndReset();
});

test('per-reveal opt out skips the automatic send; manual button still works', async () => {
  const r = await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: new Date(Date.now() + 5 * M).toISOString(), kitLiveEmail: false }, 'peter@test');
  assert.equal(r.success, true, r.error);
  kitPosts.length = 0;
  const t = await goLiveSteady();
  assert.ok(!t.work.includes('kit-live'));
  assert.equal(liveKitPosts().length, 0);
  const m = await b.adminAction(env, 'sendKitLive', {}, 'peter@test');
  assert.equal(m.success, true, m.error);
  assert.equal(liveKitPosts().length, 1);
  await endAndReset();
});

test('update can switch it off after scheduling', async () => {
  await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: new Date(Date.now() + 5 * M).toISOString() }, 'peter@test');
  const u = await b.adminAction(env, 'update', { kitLiveEmail: false }, 'peter@test');
  assert.equal(u.success, true, u.error);
  kitPosts.length = 0;
  await goLiveSteady();
  assert.equal(liveKitPosts().length, 0);
  await endAndReset();
});

test('going live well before showtime (a phone test) holds the email', async () => {
  await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: new Date(Date.now() + 3 * H).toISOString() }, 'peter@test');
  kitPosts.length = 0;
  const t = await goLive();
  assert.ok(t.work.includes('kit-live-held'), 'held on the first tick: ' + t.work.join(','));
  travel(5 * M); await tick();
  assert.equal(liveKitPosts().length, 0);
  const st = await b.readState(env.DB);
  assert.equal(st.kit.live.held, true);
  const m = await b.adminAction(env, 'sendKitLive', {}, 'peter@test');
  assert.equal(m.success, true, 'admin can still send it for real');
  assert.equal(liveKitPosts().length, 1);
  await endAndReset();
});

test('a quick phone test that stops early emails nobody', async () => {
  sim.fbPosts = [{ message: 'Reveal day for Remi!', created_time: new Date(Date.now() - H).toISOString() }];
  kitPosts.length = 0;
  await goLive();
  travel(2 * M);
  await tick();
  await endAndReset();
  assert.equal(liveKitPosts().length, 0);
});

test('the 3 minutes must be unbroken: a dropped signal restarts the clock', async () => {
  sim.fbPosts = [{ message: 'Reveal day for Remi!', created_time: new Date(Date.now() - H).toISOString() }];
  kitPosts.length = 0;
  await goLive();
  travel(2 * M); await tick();
  sim.live = false; await tick();          // drop
  travel(10 * S); sim.live = true; await tick(); // back within grace
  travel(2 * M); await tick();
  assert.equal(liveKitPosts().length, 0, '2 + 2 minutes is not 3 unbroken');
  travel(70 * S);
  const t = await tick();
  assert.ok(t.work.includes('kit-live'), t.work.join(','));
  await endAndReset();
});

test('unscheduled: the Facebook live post names the kid', async () => {
  sim.fbVideos = [{ live_status: 'LIVE', title: "Marilyn's reveal day!", description: 'Thank you to our partners', created_time: new Date(Date.now()).toISOString() }];
  kitPosts.length = 0;
  const t = await goLiveSteady();
  assert.ok(t.work.includes('kid:marilyn:facebook-live'), t.work.join(','));
  assert.ok(t.work.includes('kit-live'), t.work.join(','));
  const k = liveKitPosts()[0];
  assert.match(k.subject, /Marilyn's room reveal/);
  assert.match(k.content, /live\/marilyn\//);
  const st = await b.readState(env.DB);
  assert.equal(st.kidSlug, 'marilyn');
  assert.equal(st.title, "Marilyn's room reveal");
  assert.equal(st.image, 'kids/marilyn/hero');
  await endAndReset();
});

test('unscheduled: a recent Page post names the kid', async () => {
  sim.fbPosts = [
    { message: 'Throwback to Helen and Remi last year', created_time: new Date(Date.now() - 20 * H).toISOString() },
    { message: 'Today is reveal day for Remi!\nWatch live at 3.', created_time: new Date(Date.now() - 2 * H).toISOString() },
  ];
  kitPosts.length = 0;
  const t = await goLiveSteady();
  assert.ok(t.work.includes('kid:remi:facebook-post'), t.work.join(','));
  assert.match(liveKitPosts()[0].subject, /Remi's room reveal/);
  await endAndReset();
});

test('unscheduled with no clue waits for the kid; picking one sends right away', async () => {
  sim.fbPosts = [{ message: 'Big day for Remi and Marilyn', created_time: new Date(Date.now() - H).toISOString() }]; // two kids: ambiguous
  kitPosts.length = 0;
  const t = await goLiveSteady();
  assert.ok(!t.work.some((w) => w.startsWith('kid:')), t.work.join(','));
  assert.equal(liveKitPosts().length, 0, 'waits for the kid');
  const st = await b.readState(env.DB);
  assert.ok(st.kidAlertAt, 'admins asked which kid');
  const u = await b.adminAction(env, 'update', { kidSlug: 'remi' }, 'peter@test');
  assert.equal(u.success, true, u.error);
  assert.equal(liveKitPosts().length, 1);
  assert.match(liveKitPosts()[0].subject, /Remi's room reveal/);
  await endAndReset();
});

test('no kid in the first 30 minutes: held for a human', async () => {
  kitPosts.length = 0;
  await goLiveSteady();
  travel(28 * M);
  const t = await tick();
  assert.ok(t.work.includes('kit-live-held'), t.work.join(','));
  assert.equal(liveKitPosts().length, 0);
  const m = await b.adminAction(env, 'sendKitLive', {}, 'peter@test');
  assert.equal(m.success, true, 'button still works');
  await endAndReset();
});

test('emergency manual banner never emails by itself', async () => {
  sim.fbPosts = [{ message: 'Reveal day for Remi!', created_time: new Date(Date.now() - H).toISOString() }];
  kitPosts.length = 0;
  await b.adminAction(env, 'goLiveManual', { message: 'Live on Facebook', url: 'https://www.facebook.com/SunshineOnaRanneyDay', durationHours: 2 }, 'peter@test');
  travel(5 * M);
  await tick();
  assert.equal(liveKitPosts().length, 0);
  await b.adminAction(env, 'endNow', {}, 'peter@test');
  travel(2 * M);
});

test('Kit failure releases the claim so a retry can send', async () => {
  await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: new Date(Date.now() + 5 * M).toISOString() }, 'peter@test');
  sim.kitFail = true;
  kitPosts.length = 0;
  const t = await goLiveSteady();
  assert.ok(t.work.includes('kit-live-failed'), t.work.join(','));
  let st = await b.readState(env.DB);
  assert.match(st.kit.live.error, /Kit is down/);
  sim.kitFail = false;
  const m = await b.adminAction(env, 'sendKitLive', {}, 'peter@test');
  assert.equal(m.success, true, m.error);
  st = await b.readState(env.DB);
  assert.equal(st.kit.live.error, null);
  assert.equal(liveKitPosts().length, 2);
  await endAndReset();
});

test('a tag audience in the config becomes a Kit subscriber filter', async () => {
  const cfg = await b.readConfig(env.DB);
  cfg.kitLive = { enabled: true, audience: { type: 'tag', id: 42, name: 'Newsletter' } };
  await b.writeConfig(env.DB, cfg);
  await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: new Date(Date.now() + 5 * M).toISOString() }, 'peter@test');
  kitPosts.length = 0;
  await goLiveSteady();
  const k = liveKitPosts()[0];
  assert.deepEqual(k.subscriber_filter, [{ all: [{ type: 'tag', ids: [42] }], any: null, none: null }]);
  assert.equal((await b.readState(env.DB)).kit.live.audience, 'Newsletter');
  await endAndReset();
});
