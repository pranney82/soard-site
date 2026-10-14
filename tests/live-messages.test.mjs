/**
 * Messages for the family on the live page — screening, limits, moderation
 * Run: node --test tests/
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };

// Hub over the binding: record what gets relayed to viewers
const relayed = [];
const LIVE_HUB = {
  idFromName: () => 'main',
  get: () => ({
    async fetch(url, init = {}) {
      if (String(url).endsWith('/relay')) relayed.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, sent: 1 }), { headers: { 'content-type': 'application/json' } });
    },
  }),
};

// Workers AI stand-in: the verdict comes from the message text
let aiCalls = 0;
let aiDown = false;
const AI = {
  async run(_model, { messages }) {
    aiCalls++;
    if (aiDown) throw new Error('AI unavailable');
    const text = messages[1].content;
    return { response: /ugly|boring/i.test(text) ? '{"ok": false, "reason": "mocks the child"}' : '{"ok": true}' };
  },
};

let env, m, b, endpoint;
const post = (body, ip = '203.0.113.7') => endpoint.onRequestPost({
  env,
  request: new Request('https://x/api/live-messages', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }),
});

async function setPhase(phase, extra = {}) {
  const s = await b.readState(env.DB);
  await b.writeState(env.DB, { ...s, broadcastId: 'live-100', kidSlug: 'axel', kidName: 'Axel', phase, ...extra });
}

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  env = { DB, LIVE_HUB, AI };
  b = await import('../functions/api/_broadcast.js');
  m = await import('../functions/api/_live-messages.js');
  endpoint = await import('../functions/api/live-messages.js');
});

test('closed when nothing is scheduled', async () => {
  const res = await post({ name: 'Ana', body: 'So happy for you!', clientId: 'c1' });
  assert.equal(res.status, 409);
});

test('a kind message is screened, stored and relayed to viewers', async () => {
  await setPhase('live');
  const res = await post({ name: '  Ana ', body: 'So happy for you Axel!', clientId: 'c1' });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.status, 'shown');
  assert.equal(data.message.name, 'Ana');
  assert.equal(relayed.at(-1).type, 'msg');
  assert.equal(relayed.at(-1).message.body, 'So happy for you Axel!');
  const list = await (await endpoint.onRequestGet({ env })).json();
  assert.equal(list.open, true);
  assert.deepEqual(list.messages.map(x => x.body), ['So happy for you Axel!']);
});

test('local rules block links without asking the model', async () => {
  const before = aiCalls;
  const res = await post({ name: 'Sam', body: 'see www.example.com', clientId: 'c2' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'Please leave out links.');
  assert.equal(aiCalls, before);
});

test('the model can say no, and the note never reaches viewers', async () => {
  const n = relayed.length;
  const res = await post({ name: 'Troll', body: 'what a boring room', clientId: 'c3' });
  assert.equal(res.status, 422);
  assert.equal(relayed.length, n);
  const admin = await m.adminList(env);
  const row = admin.messages.find(x => x.body === 'what a boring room');
  assert.equal(row.status, 'blocked');
  assert.match(row.reason, /^ai:/);
});

test('when screening is down the note waits for a person (fails closed)', async () => {
  aiDown = true;
  const res = await post({ name: 'Lee', body: 'Congratulations to the whole family', clientId: 'c4' });
  aiDown = false;
  assert.equal(res.status, 202);
  assert.equal((await res.json()).status, 'held');
  const list = await (await endpoint.onRequestGet({ env })).json();
  assert.ok(!list.messages.some(x => x.name === 'Lee'));
});

test('an admin can approve a held note and hide a shown one', async () => {
  const admin = await m.adminList(env);
  const held = admin.messages.find(x => x.status === 'held');
  const shown = admin.messages.find(x => x.status === 'shown');
  const r1 = await m.moderate(env, held.id, 'shown', 'peter@example.com');
  assert.equal(r1.success, true);
  assert.equal(relayed.at(-1).type, 'msg');
  assert.equal(relayed.at(-1).message.id, held.id);
  const r2 = await m.moderate(env, shown.id, 'hidden', 'peter@example.com');
  assert.equal(r2.success, true);
  assert.deepEqual(relayed.at(-1), { type: 'msg-hide', id: shown.id });
  const list = await (await endpoint.onRequestGet({ env })).json();
  assert.deepEqual(list.messages.map(x => x.name), ['Lee']);
  const bad = await m.moderate(env, shown.id, 'deleted', 'x');
  assert.equal(bad.success, false);
});

test('per-visitor rate limit, then it lifts after a minute', async () => {
  for (const body of ['One more note', 'Another note', 'A third note']) {
    assert.equal((await post({ name: 'Kim', body, clientId: 'c5' })).status, 200);
  }
  assert.equal((await post({ name: 'Kim', body: 'A fourth note', clientId: 'c5' })).status, 429);
  travel(61e3);
  assert.equal((await post({ name: 'Kim', body: 'A fourth note', clientId: 'c5' })).status, 200);
});

test('a whole family on one wifi can all post', async () => {
  for (let i = 0; i < 8; i++) {
    const res = await post({ name: `Cousin${i}`, body: `Love you Axel, from cousin ${i}`, clientId: `fam-${i}` }, '198.51.100.1');
    assert.equal(res.status, 200);
  }
});

test('duplicates and the honeypot', async () => {
  assert.equal((await post({ name: 'Kim', body: 'A fourth note', clientId: 'c5' })).status, 409);
  const before = (await m.adminList(env)).messages.length;
  const res = await post({ name: 'Bot', body: 'hello friends', clientId: 'bot', website: 'http://x' });
  assert.equal(res.status, 200);
  assert.equal((await m.adminList(env)).messages.length, before);
});

test('still open on replay, closed when the admin switches messages off', async () => {
  await setPhase('replay');
  assert.equal((await post({ name: 'Rae', body: 'Watched the replay, so sweet', clientId: 'c6' })).status, 200);
  const c = await b.readConfig(env.DB);
  await b.writeConfig(env.DB, { ...c, messages: { enabled: false } });
  assert.equal((await post({ name: 'Rae', body: 'One more from me', clientId: 'c6' })).status, 409);
  const list = await (await endpoint.onRequestGet({ env })).json();
  assert.equal(list.open, false);
  assert.equal(list.enabled, false);
  await b.writeConfig(env.DB, { ...c, messages: { enabled: true } });
});

test('history counts and the keepsake list', async () => {
  const counts = await m.shownCounts(env.DB, ['live-100', 'live-0']);
  assert.ok(counts['live-100'] >= 10);
  assert.equal(counts['live-0'], undefined);
  const admin = await m.adminList(env, 'live-100');
  assert.equal(admin.counts.shown, counts['live-100']);
  assert.ok(admin.counts.blocked >= 2);
});

test('screenLocal lets ordinary words and names through', () => {
  for (const [name, body] of [['Dick', 'Reading Dickens with you soon'], ['Jo', 'Class of 2015 - 2019 cheering'], ['Ana', 'WOW THIS IS AMAZING!!'], ['Sam', 'Praying for you all']]) {
    assert.equal(m.screenLocal(name, body).ok, true, body);
  }
  for (const body of ['call 404 555 0123', 'mail me at a@b.co', 'this is shit', 'follow @spamhandle']) {
    assert.equal(m.screenLocal('X', body).ok, false, body);
  }
});
