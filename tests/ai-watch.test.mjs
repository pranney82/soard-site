/**
 * The AI spending watch (functions/api/_ai-watch.js): Cloudflare's numbers turned into dollars by site and feature,
 * what counts as a jump, one post with a reply if it doubles and ✅ when it settles, and what Automations is told.
 * The rows are the shape Cloudflare answered with on Nov 5 2026 (and the Nov 5 spike's own numbers).
 * Run: node --test tests/ai-watch.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, judge, checkAiSpending, maybeRunAiWatch, aiWatchFacts, dollars } from '../functions/api/_ai-watch.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { createD1 } from './lib/d1-shim.mjs';

const T = Date.parse('2026-11-06T04:00:00Z');
const dollarsToNeurons = (d) => (d / 0.011) * 1000;
const tag = (t, d) => ({ dimensions: { tag: t }, sum: { totalNeurons: dollarsToNeurons(d) } });
const gw = (gateway, feature, model, statusCode, count, cost = 0) => ({ dimensions: { gateway, feature, model, statusCode }, count, sum: { cost } });
const QUIET = {
  days: [tag('soard-site:mail-sweep', 7), tag('sunnyandranney-site:product-sync', 0.7)],
  day: [tag('soard-site:mail-sweep', 0.4), tag('sunnyandranney-site:product-sync', 0.01)],
  hour: [tag('soard-site:mail-sweep', 0.02)],
  gatewayDay: [gw('soard-site', 'mail-sweep', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 200, 90, 0.4)],
  gatewayHour: [],
};
const SPIKE = {
  ...QUIET,
  day: [...QUIET.day, tag('sunnyandranney-site:product-sync', 8)],
  hour: [tag('sunnyandranney-site:product-sync', 4.3)],
};

test('dollars by site and feature; what no site’s name is on is apart', () => {
  const m = summarize({ ...QUIET, hour: [...QUIET.hour, tag('', 0.3)] });
  const soard = m.sites.find((s) => s.id === 'soard-site');
  assert.equal(soard.name, 'SOARD');
  assert.equal(soard.features[0].feature, 'mail-sweep');
  assert.ok(Math.abs(soard.day - 0.4) < 1e-9, 'Workers AI once: its gateway row isn’t added on top');
  assert.ok(Math.abs(soard.usual - 0.5) < 1e-9, 'a fortnight’s $7 is $0.50 a day');
  assert.ok(Math.abs(m.outsideHour - 0.3) < 1e-9);
});

test('Anthropic’s cost comes from the gateway, by feature, and calls it turned away are counted', () => {
  const m = summarize({ ...QUIET,
    gatewayDay: [gw('sunnyandranney-site', 'chat', 'claude-sonnet-4-6', 200, 12, 1.25)],
    gatewayHour: [gw('sunnyandranney-site', 'chat', 'claude-sonnet-4-6', 200, 2, 0.05), gw('sunnyandranney-site', 'chat', 'claude-sonnet-4-6', 429, 7), gw('spend-test', 'x', '@cf/y', 429, 9)] });
  const store = m.sites.find((s) => s.id === 'sunnyandranney-site');
  const chat = store.features.find((f) => f.feature === 'chat');
  assert.deepEqual([chat.day, chat.hour, chat.refused], [1.25, 0.05, 7]);
  assert.equal(m.refused, 7, 'a gateway that’s neither site’s isn’t counted');
});

test('a quiet day says nothing; a busy day that’s usual for it says nothing', () => {
  assert.deepEqual(judge(summarize(QUIET)), []);
  const busy = summarize({ ...QUIET, days: [tag('soard-site:board-file-reading', 14 * 1.5)], day: [tag('soard-site:board-file-reading', 3)] });
  assert.deepEqual(judge(busy), [], '$3 against a usual $1.50 isn’t three times the usual');
});

test('the Nov 5 spike is caught in its first hour, by the feature behind it, once', () => {
  const said = judge(summarize(SPIKE));
  assert.equal(said.length, 1);
  assert.equal(said[0].key, 'sunnyandranney-site:product-sync');
  assert.equal(said[0].title, 'AI spending jumped: the store’s product sync');
  assert.match(said[0].detail, /cost \$4\.30 in the last hour and \$8\.01 in the last 24 hours\. A usual day is \$0\.05\./);
});

test('the Nov 4 board reading ($1.97 in a day, nothing like it the fortnight before) doesn’t cry wolf', () => {
  assert.deepEqual(judge(summarize({ ...QUIET, day: [tag('soard-site:board-file-reading', 1.97)], hour: [tag('soard-site:board-file-reading', 0.4)] })), []);
});

test('many features, none over: the site’s jump is said, with what’s in it', () => {
  const feats = ['mail-sweep', 'translate', 'vendor-papers', 'press-monitor'];
  const said = judge(summarize({ ...QUIET, days: [], day: feats.map((f) => tag(`soard-site:${f}`, 0.9)), hour: [] }));
  assert.deepEqual(said.map((p) => p.key), ['soard-site:all']);
  assert.equal(said[0].facts.length, 3);
});

test('a cap turning calls away is said by feature; AI outside the gateways is said too', () => {
  const said = judge(summarize({ ...QUIET, hour: [tag('', 0.5)], gatewayHour: [gw('soard-site', 'live-messages', '@cf/x', 429, 40)] }));
  assert.deepEqual(said.map((p) => p.key).sort(), ['outside', 'soard-site:live-messages:cap']);
  assert.match(said.find((p) => p.key !== 'outside').detail, /turned away 40 AI calls for live reveal messages/);
});

test('money reads as money', () => {
  assert.equal(dollars(0), '$0.00');
  assert.equal(dollars(0.001), 'under a cent');
  assert.equal(dollars(19.594), '$19.59');
});

// ─── The hourly look ────────────────────────────────────────────────

let env, usage, slack, emails, graphql;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  usage = QUIET; slack = []; emails = []; graphql = [];
  env = {
    DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] }),
    CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_TOKEN: 'analytics-token', SLACK_BOT_TOKEN: 'xoxb-test', RESEND_API_KEY: 're_test',
  };
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'news' }, attention: { id: 'CATT', name: 'website-alerts' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url === 'https://api.cloudflare.com/client/v4/graphql') {
      graphql.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) });
      if (usage instanceof Response) return usage;
      return Response.json({ data: { viewer: { accounts: [usage] } } });
    }
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.slice('https://slack.com/api/'.length);
      let body = {};
      try { body = JSON.parse(init.body); } catch { body = Object.fromEntries(new URLSearchParams(init.body)); }
      slack.push({ method, body });
      return Response.json({ ok: true, channel: body.channel || 'CATT', ts: `${slack.length}.0001` });
    }
    if (url.startsWith('https://api.resend.com/')) { emails.push(init.body); return Response.json({ id: 'e1', data: [] }); }
    throw new Error(`no fake for ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const posts = () => slack.filter((s) => s.method === 'chat.postMessage');
const HOUR = 3600e3;

test('one post when it jumps, nothing more while it holds, a reply if it doubles, ✅ when it settles', async () => {
  await checkAiSpending(env, { now: T });
  assert.equal(posts().length, 0, 'quiet: nothing');
  usage = SPIKE;
  await checkAiSpending(env, { now: T + HOUR });
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.channel, 'CATT', 'in Needs attention');
  assert.match(posts()[0].body.text, /AI spending jumped: the store’s product sync/);
  assert.match(JSON.stringify(posts()[0].body.blocks), /hold SOARD at \$5 and the store at \$4/);
  await checkAiSpending(env, { now: T + 2 * HOUR });
  assert.equal(posts().length, 1, 'still over, nothing new');
  usage = { ...SPIKE, day: [tag('sunnyandranney-site:product-sync', 20)], hour: [tag('sunnyandranney-site:product-sync', 4)] };
  await checkAiSpending(env, { now: T + 3 * HOUR });
  assert.equal(posts().length, 2, 'doubled: it says so');
  assert.equal(posts()[1].body.thread_ts, posts()[0].body.ts || '1.0001', 'in the first post’s thread');
  assert.match(posts()[1].body.text, /Still climbing/);
  usage = QUIET;
  await checkAiSpending(env, { now: T + 4 * HOUR });
  assert.ok(slack.some((s) => s.method === 'chat.update' && /Resolved/.test(JSON.stringify(s.body))), 'the first post turns ✅');
  assert.deepEqual((await aiWatchFacts(env)).open, []);
});

test('hourly: not again within the hour, and only with its key', async () => {
  assert.notEqual(await maybeRunAiWatch(env, { now: T }), null);
  assert.equal(await maybeRunAiWatch(env, { now: T + HOUR / 2 }), null);
  assert.equal(graphql.length, 1);
  assert.equal(graphql[0].auth, 'Bearer analytics-token');
  assert.notEqual(await maybeRunAiWatch(env, { now: T + HOUR + 1 }), null);
  assert.equal(graphql.length, 2);
  delete env.CF_ANALYTICS_TOKEN;
  assert.equal(await maybeRunAiWatch(env, { now: T + 5 * HOUR }), null);
  assert.equal(graphql.length, 2, 'without the key it does nothing');
  assert.equal((await aiWatchFacts(env)).token, false);
});

test('it asks for sums only: no field that could hold words', async () => {
  await checkAiSpending(env, { now: T });
  assert.doesNotMatch(graphql[0].query, /prompt|response|body|message|content/i);
  assert.deepEqual(Object.keys(graphql[0].variables).sort(), ['account', 'day', 'dayHour', 'from', 'fromHour', 'hour', 'lastHour', 'now', 'thisHour', 'to', 'toHour']);
  // The gateway's numbers are by the clock hour: at 4:59 the last hour is 3 to 4, not nearly two hours
  await checkAiSpending(env, { now: T + 59 * 60e3 });
  const v = graphql[1].variables;
  assert.deepEqual([v.lastHour, v.thisHour, v.dayHour], ['2026-11-06T03:00:00Z', '2026-11-06T04:00:00Z', '2026-11-05T04:00:00Z']);
});

test('Cloudflare refusing: kept for Automations, tried again in an hour, never every minute, never throws', async () => {
  usage = new Response(JSON.stringify({ errors: [{ message: 'not authorized for that account' }] }), { status: 200 });
  assert.equal(await maybeRunAiWatch(env, { now: T }), null);
  const f = await aiWatchFacts(env);
  assert.equal(f.error, 'not authorized for that account');
  assert.equal(await maybeRunAiWatch(env, { now: T + 60e3 }), null);
  assert.equal(graphql.length, 1);
});

test('Automations gets dollars and feature names, in words a person reads', async () => {
  usage = { ...QUIET, day: [tag('soard-site:mail-sweep', 0.4), tag('soard-site:board-file-reading', 0.1)] };
  await checkAiSpending(env, { now: T });
  const f = await aiWatchFacts(env);
  assert.deepEqual(f.sites[0].top.map((x) => x.name), ['the inbox sweep', 'reading board files']);
  assert.equal(f.token, true);
  assert.equal(f.at, new Date(T).toISOString());
});

test('a cap on a quiet feature is said once while it holds, not every hour', async () => {
  usage = { ...QUIET, gatewayHour: [gw('soard-site', 'translate', '@cf/x', 429, 4)] };
  for (let k = 0; k < 4; k++) await checkAiSpending(env, { now: T + k * HOUR });
  assert.equal(posts().length, 1);
  usage = QUIET;
  await checkAiSpending(env, { now: T + 5 * HOUR });
  assert.ok(slack.some((s) => s.method === 'chat.update'), 'and turns ✅ when it lifts');
});

test('a site still over the line doesn’t read as settled when a feature takes over saying so', async () => {
  const feats = ['mail-sweep', 'translate', 'vendor-papers', 'press-monitor'];
  usage = { ...QUIET, days: [], hour: [], day: feats.map((f) => tag(`soard-site:${f}`, 0.9)) };
  await checkAiSpending(env, { now: T });
  assert.deepEqual((await aiWatchFacts(env)).open, ['SOARD']);
  usage = { ...usage, day: [...feats.slice(1).map((f) => tag(`soard-site:${f}`, 0.9)), tag('soard-site:mail-sweep', 2.5)] };
  await checkAiSpending(env, { now: T + HOUR });
  assert.equal(slack.filter((s) => s.method === 'chat.update').length, 0, 'no ✅ while it’s rising');
  assert.deepEqual((await aiWatchFacts(env)).open.sort(), ['SOARD', 'the inbox sweep (SOARD)']);
});

test('a usual day counts Claude too: steady chat isn’t a jump', () => {
  const steady = { ...QUIET, gatewayDay: [gw('sunnyandranney-site', 'chat', 'claude-sonnet-4-6', 200, 240, 2.4)], gatewayDays: [gw('sunnyandranney-site', 'chat', 'claude-sonnet-4-6', 200, 3000, 14 * 2.4)] };
  const m = summarize(steady);
  const chat = m.sites.find((s) => s.id === 'sunnyandranney-site').features.find((f) => f.feature === 'chat');
  assert.ok(Math.abs(chat.usual - 2.4) < 1e-9);
  assert.deepEqual(judge(m), []);
});
