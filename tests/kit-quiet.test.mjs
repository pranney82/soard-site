/**
 * Quiet subscribers in Kit: who gets asked, the two emails, who stays, who goes
 * Run: node --test tests/kit-quiet.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const DAY = 24 * 3600 * 1000;
// 11am Eastern on a Wednesday, so a new group may start
const T0 = Date.parse('2026-11-04T16:00:00Z');

// ─── A fake Kit ────────────────────────────────────────────────────
const kit = {};
// Tags and ids stay between tests, as they do in Kit (_kit.js remembers tag ids per isolate)
kit.tags = new Map();           // id → name
kit.nextId = 1000;
function kitReset() {
  Object.assign(kit, {
    subs: new Map(),            // id → { id, email, state, created, tags:Set, events:[{type, at}] }
    broadcasts: [],             // { id, description, subject, html, send_at, filter, email_address, status, recipients }
    addresses: [{ email_address: 'hello@soard.test', is_default: true, is_verified: true, status: 'confirmed' }],
    failTagOnce: false, calls: [],
  });
}
const tagId = (name) => [...kit.tags].find(([, n]) => n === name)?.[0] ?? null;
const addSub = ({ email, created = T0 - 200 * DAY, sent = 4, opens = 0, clicks = 0, tags = [], state = 'active' }) => {
  const id = kit.nextId++;
  const events = [];
  for (let i = 0; i < sent; i++) events.push({ type: 'sent', at: T0 - (10 + i * 10) * DAY });
  for (let i = 0; i < opens; i++) events.push({ type: 'opened', at: T0 - (5 + i) * DAY });
  for (let i = 0; i < clicks; i++) events.push({ type: 'clicked', at: T0 - (5 + i) * DAY });
  const tagSet = new Set(tags.map(n => { let t = tagId(n); if (!t) { t = kit.nextId++; kit.tags.set(t, n); } return t; }));
  kit.subs.set(id, { id, email, state, created, tags: tagSet, events });
  return id;
};
const engage = (id, type, at) => kit.subs.get(id).events.push({ type, at });
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const inRange = (at, start, end) => ymd(at) >= start && ymd(at) <= end;

function evalFilter(body) {
  return [...kit.subs.values()].filter(s => (body.all || []).every(c => {
    if (c.type === 'subscriber_state') return c.states.includes(s.state);
    if (c.type === 'subscribed') return !c.before || ymd(s.created) < c.before;
    if (c.type === 'tags') return c.any[0].matching.some(t => s.tags.has(Number(t)));
    if (c.type === 'sent') return s.events.filter(e => e.type === 'sent' && ymd(e.at) >= c.after && ymd(e.at) < c.before).length >= c.count_greater_than_or_equal;
    throw new Error('fake Kit: unknown condition ' + c.type);
  }));
}

let now = T0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const path = url.pathname.replace(/^\/v4/, '');
  const body = init.body ? JSON.parse(init.body) : {};
  const json = (obj, status = 200) => new Response(status === 204 ? null : JSON.stringify(obj), { status });
  kit.calls.push(`${method} ${path}`);
  if (path === '/account') return json({ account: { name: 'SOARD', sending_addresses: kit.addresses } });
  if (path === '/tags' && method === 'GET') return json({ tags: [...kit.tags].map(([id, name]) => ({ id, name })), pagination: { has_next_page: false } });
  if (path === '/tags' && method === 'POST') { const id = kit.nextId++; kit.tags.set(id, body.name); return json({ tag: { id, name: body.name } }, 201); }
  let m = path.match(/^\/tags\/(\d+)\/subscribers\/(\d+)$/);
  if (m) {
    const s = kit.subs.get(Number(m[2]));
    if (!s) return json({ errors: ['Not found'] }, 404);
    if (method === 'POST') {
      if (kit.failTagOnce) { kit.failTagOnce = false; return json({ errors: ['Too many requests'] }, 429); }
      s.tags.add(Number(m[1])); return json({ subscriber: { id: s.id } }, 201);
    }
    if (method === 'DELETE') { s.tags.delete(Number(m[1])); return json({}, 204); }
  }
  if (path === '/subscribers/filter') {
    const per = Number(url.searchParams.get('per_page') || 500);
    const all = evalFilter(body);
    const start = url.searchParams.get('after') ? Number(url.searchParams.get('after')) : 0;
    const page = all.slice(start, start + per);
    const stats = body.include?.find(i => i.type === 'stats')?.range;
    return json({
      subscribers: page.map(s => ({
        id: String(s.id), email_address: s.email,
        tag_names: [...s.tags].map(t => kit.tags.get(t)),
        ...(stats ? { stats: {
          sent: s.events.filter(e => e.type === 'sent' && inRange(e.at, stats.start, stats.end)).length,
          opened: s.events.filter(e => e.type === 'opened' && inRange(e.at, stats.start, stats.end)).length,
          clicked: s.events.filter(e => e.type === 'clicked' && inRange(e.at, stats.start, stats.end)).length,
        } } : {}),
      })),
      pagination: { has_next_page: start + per < all.length, end_cursor: String(start + per) },
    });
  }
  m = path.match(/^\/subscribers\/(\d+)\/unsubscribe$/);
  if (m) { const s = kit.subs.get(Number(m[1])); if (!s) return json({}, 404); s.state = 'cancelled'; return json({}, 204); }
  if (path === '/broadcasts' && method === 'POST') {
    const tagIdx = body.subscriber_filter?.[0]?.all?.[0]?.ids?.[0];
    const recipients = [...kit.subs.values()].filter(s => s.state === 'active' && s.tags.has(tagIdx)).map(s => s.id);
    const b = { id: kit.nextId++, description: body.description, subject: body.subject, html: body.content, send_at: body.send_at, filter: body.subscriber_filter, email_address: body.email_address || null, status: 'scheduled', recipients };
    kit.broadcasts.push(b);
    return json({ broadcast: { id: b.id, status: 'scheduled' } }, 201);
  }
  if (path === '/broadcasts' && method === 'GET') return json({ broadcasts: kit.broadcasts.map(b => ({ id: b.id, description: b.description, subject: b.subject, status: b.status })) });
  m = path.match(/^\/broadcasts\/(\d+)\/stats$/);
  if (m) { const b = kit.broadcasts.find(x => x.id === Number(m[1])); return json({ broadcast: { stats: { status: b.status } } }); }
  throw new Error(`fake Kit: no route for ${method} ${path}`);
};

const { maybeRunQuiet, setQuietOn, quietStatus, pickNew, quietEmail, DAILY_MAX, IN_TAG, SEND_TAGS } = await import('../functions/api/_kit-quiet.js');

let env;
beforeEach(async () => {
  kitReset();
  env = { DB: await createD1(), KIT_API_KEY: 'k' };
  now = T0;
});
/** Ticks until nothing moves (or max). Kit "sends" any scheduled broadcast between ticks. */
async function runUntilIdle(max = 200) {
  const log = [];
  for (let i = 0; i < max; i++) {
    for (const b of kit.broadcasts) if (b.status === 'scheduled' && Date.parse(b.send_at) <= now + 10 * 60 * 1000) {
      // Kit decides recipients when it sends
      const t = b.filter[0].all[0].ids[0];
      b.recipients = [...kit.subs.values()].filter(s => s.state === 'active' && s.tags.has(t)).map(s => s.id);
      b.status = 'completed';
    }
    kit.calls.length = 0;
    const r = await maybeRunQuiet(env, { now });
    assert.ok(kit.calls.length <= 60, `one tick made ${kit.calls.length} Kit calls`);
    now += 60 * 1000;
    if (!r.ran) { if (r.why === 'error') throw new Error(r.error); break; }
    log.push(r.did);
  }
  return log;
}

test('off: nothing happens, nobody is emailed', async () => {
  addSub({ email: 'quiet@x.test' });
  const r = await maybeRunQuiet(env, { now });
  assert.equal(r.why, 'off');
  assert.equal(kit.broadcasts.length, 0);
  assert.equal(kit.calls.length, 0);
});

test('who gets asked: quiet only, never protected, new, unsent or engaged people', async () => {
  const q = addSub({ email: 'quiet@x.test' });
  addSub({ email: 'reader@x.test', opens: 1 });
  addSub({ email: 'clicker@x.test', clicks: 1 });
  addSub({ email: 'new@x.test', created: T0 - 30 * DAY });
  addSub({ email: 'once@x.test', sent: 1 });
  addSub({ email: 'waiting@x.test', tags: ['Application Waitlist'] });
  addSub({ email: 'board@x.test', tags: ['Board'] });
  addSub({ email: 'gone@x.test', state: 'cancelled' });
  const store = addSub({ email: 'shopper@x.test', tags: ['Sunny & Ranney'] });
  await setQuietOn(env, true, 'test');
  await runUntilIdle();
  const people = (await env.DB.prepare('SELECT subscriber_id, brand FROM kit_quiet_people').all()).results;
  // No store address in Kit yet: the shopper waits
  assert.deepEqual(people.map(p => p.subscriber_id), [q]);
  assert.ok(!people.some(p => p.subscriber_id === store));
  assert.equal(kit.broadcasts.length, 1);
  assert.deepEqual(kit.broadcasts[0].recipients, [q]);
});

test('two heartbeats at once: only one does the work', async () => {
  addSub({ email: 'quiet@x.test' });
  await setQuietOn(env, true);
  const [x, y] = await Promise.all([maybeRunQuiet(env, { now }), maybeRunQuiet(env, { now })]);
  assert.deepEqual([x.ran, y.ran].sort(), [false, true]);
  assert.equal([x, y].find(r => !r.ran).why, 'busy');
  // A lock left by a tick that died expires
  await env.DB.prepare("INSERT OR REPLACE INTO kit_quiet_runtime (key, value, updated_at) VALUES ('lock', ?, ?)").bind(String(now + 30e3), now).run();
  assert.equal((await maybeRunQuiet(env, { now: now + 10e3 })).why, 'busy');
  assert.equal((await maybeRunQuiet(env, { now: now + 31e3 })).ran, true);
});

test('before 10am Eastern no group starts', async () => {
  addSub({ email: 'quiet@x.test' });
  await setQuietOn(env, true);
  now = Date.parse('2026-11-04T13:00:00Z'); // 8am Eastern
  const r = await maybeRunQuiet(env, { now });
  assert.equal(r.why, 'before 10am');
  assert.equal(kit.broadcasts.length, 0);
});

test('the full three weeks: first email, last call to those who didn\'t answer, then unsubscribe the rest', async () => {
  const a = addSub({ email: 'a@x.test' }); // answers the first email
  const b = addSub({ email: 'b@x.test' }); // answers the last call
  const c = addSub({ email: 'c@x.test' }); // never answers
  await setQuietOn(env, true);
  await runUntilIdle();
  assert.equal(kit.broadcasts.length, 1);
  const first = kit.broadcasts[0];
  assert.equal(first.subject, 'Do you still want our emails?');
  assert.deepEqual(first.recipients.sort(), [a, b, c].sort());
  // The send tag was emptied after it went out; everyone is still in the check-in
  assert.equal([...kit.subs.values()].filter(s => s.tags.has(tagId(SEND_TAGS.soard))).length, 0);
  assert.equal([...kit.subs.values()].filter(s => s.tags.has(tagId(IN_TAG))).length, 3);

  engage(a, 'opened', T0 + 1 * DAY);
  now = T0 + 7 * DAY + 3600e3;
  await runUntilIdle();
  assert.equal(kit.broadcasts.length, 2);
  const last = kit.broadcasts[1];
  assert.equal(last.subject, 'Last call: stay on our list?');
  assert.deepEqual(last.recipients.sort(), [b, c].sort(), 'a answered, so a gets no last call');

  engage(b, 'clicked', T0 + 9 * DAY);
  now = T0 + 21 * DAY + 3600e3;
  await runUntilIdle();
  assert.equal(kit.subs.get(a).state, 'active');
  assert.equal(kit.subs.get(b).state, 'active');
  assert.equal(kit.subs.get(c).state, 'cancelled');
  // Nobody keeps the check-in tag, and the group is done
  assert.equal([...kit.subs.values()].filter(s => s.tags.has(tagId(IN_TAG))).length, 0);
  const st = await quietStatus(env);
  assert.deepEqual([st.waiting, st.kept, st.unsubscribed], [0, 2, 1]);
  const g = await env.DB.prepare('SELECT stage FROM kit_quiet_groups').first();
  assert.equal(g.stage, 'done');
});

test('store subscribers get the store\'s email from the store address', async () => {
  kit.addresses.push({ email_address: 'store@sunnyandranney.com', is_verified: true, status: 'confirmed' });
  addSub({ email: 'quiet@x.test' });
  const s = addSub({ email: 'shopper@x.test', tags: ['Sunny & Ranney'] });
  await setQuietOn(env, true);
  await runUntilIdle();
  assert.equal(kit.broadcasts.length, 2);
  const store = kit.broadcasts.find(b => b.email_address === 'store@sunnyandranney.com');
  assert.ok(store, 'the store email comes from the store address');
  assert.deepEqual(store.recipients, [s]);
  assert.match(store.html, /sunnyandranney\.com/);
  const soard = kit.broadcasts.find(b => b !== store);
  assert.equal(soard.email_address, null, 'SOARD\'s uses the account default');
  assert.match(soard.html, /sunshineonaranneyday\.com/);
});

test('an address Kit hasn\'t confirmed doesn\'t count as the store\'s', async () => {
  kit.addresses.push({ email_address: 'store@sunnyandranney.com', is_verified: true, status: 'pending' });
  addSub({ email: 'shopper@x.test', tags: ['Sunny & Ranney'] });
  await setQuietOn(env, true);
  await runUntilIdle();
  assert.equal(kit.broadcasts.length, 0);
});

test('a day never asks more than DAILY_MAX, and the rest wait for tomorrow', async () => {
  for (let i = 0; i < DAILY_MAX + 25; i++) addSub({ email: `q${i}@x.test` });
  await setQuietOn(env, true);
  await runUntilIdle(400);
  assert.equal(kit.broadcasts.length, 1);
  assert.equal(kit.broadcasts[0].recipients.length, DAILY_MAX);
  now = T0 + DAY;
  await runUntilIdle(400);
  assert.equal(kit.broadcasts.length, 2);
  assert.equal(kit.broadcasts[1].recipients.length, 25, 'tomorrow takes the rest, not yesterday\'s again');
});

test('one email per brand at a time: the second day\'s first email waits for the first day\'s to finish', async () => {
  for (let i = 0; i < 3; i++) addSub({ email: `d1-${i}@x.test` });
  await setQuietOn(env, true);
  // Day 1: tag and schedule, but Kit hasn't sent it yet
  for (let i = 0; i < 12; i++) { await maybeRunQuiet(env, { now }); now += 60e3; }
  assert.equal(kit.broadcasts.length, 1);
  assert.equal(kit.broadcasts[0].status, 'scheduled');
  for (let i = 0; i < 2; i++) addSub({ email: `d2-${i}@x.test` });
  now = T0 + DAY;
  for (let i = 0; i < 10; i++) { await maybeRunQuiet(env, { now }); now += 60e3; }
  assert.equal(kit.broadcasts.length, 1, 'day 2 waits while day 1 holds the send tag');
  await runUntilIdle();
  assert.equal(kit.broadcasts.length, 2);
  assert.equal(kit.broadcasts[1].recipients.length, 2, 'day 2\'s email reaches only day 2\'s group');
});

test('a crash after Kit made the email: found, not sent twice', async () => {
  addSub({ email: 'quiet@x.test' });
  await setQuietOn(env, true);
  await runUntilIdle();
  assert.equal(kit.broadcasts.length, 1);
  // Pretend the next one crashed mid-create: Kit has it, the site didn't record the id
  now = T0 + 7 * DAY + 3600e3;
  const realFetch = globalThis.fetch;
  let crashed = false;
  globalThis.fetch = async (input, init = {}) => {
    const res = await realFetch(input, init);
    if (!crashed && String(input).endsWith('/broadcasts') && (init.method || 'GET') === 'POST') { crashed = true; throw new Error('network gone'); }
    return res;
  };
  try { await runUntilIdle(); } catch {}
  globalThis.fetch = realFetch;
  await runUntilIdle();
  assert.equal(kit.broadcasts.filter(b => b.subject.startsWith('Last call')).length, 1);
});

test('a Kit hiccup while tagging drops nobody: it tries again next minute', async () => {
  const q = addSub({ email: 'quiet@x.test' });
  await setQuietOn(env, true);
  kit.failTagOnce = true;
  const r = await maybeRunQuiet(env, { now });
  now += 60e3;
  // The group started; the tagging tick may hit the hiccup
  const log = [];
  for (let i = 0; i < 30; i++) { const x = await maybeRunQuiet(env, { now }); now += 60e3; log.push(x.why || x.did); if (!x.ran && x.why !== 'error') break; }
  for (const b of kit.broadcasts) b.status = 'completed';
  await runUntilIdle();
  const row = await env.DB.prepare('SELECT outcome FROM kit_quiet_people WHERE subscriber_id = ?').bind(q).first();
  assert.equal(row.outcome, null, 'still in the check-in, not marked gone');
  assert.equal(kit.broadcasts.length, 1);
  assert.deepEqual(kit.broadcasts[0].recipients, [q]);
  assert.ok(r);
});

test('a problem shows in the status and clears when it works again', async () => {
  addSub({ email: 'quiet@x.test' });
  await setQuietOn(env, true);
  kit.failTagOnce = true;
  let saw = null;
  for (let i = 0; i < 5 && !saw; i++) { const r = await maybeRunQuiet(env, { now }); now += 60e3; if (r.why === 'error') saw = r.error; }
  assert.match(saw || '', /HTTP 429/);
  assert.match((await quietStatus(env)).lastError || '', /429/);
  await runUntilIdle();
  assert.equal((await quietStatus(env)).lastError, null);
});

test('pickNew keeps the store\'s people out when there is no store address', () => {
  const c = (id, tags, stats = { sent: 3, opened: 0, clicked: 0 }) => ({ id: String(id), tag_names: tags, stats });
  const out = pickNew([c(1, []), c(2, ['Sunny & Ranney']), c(3, ['Quiet check']), c(4, [], { sent: 3, opened: 1, clicked: 0 })], { storeOk: false });
  assert.deepEqual(out, [{ id: 1, brand: 'soard' }]);
});

test('the emails say what Peter approved, with no em dashes', () => {
  for (const brand of ['soard', 'store']) for (const which of ['first', 'reminder']) {
    const e = quietEmail(brand, which);
    assert.ok(!/—/.test(e.html + e.subject + e.preview));
    assert.match(e.html, /Yes, keep me on the list/);
    assert.match(e.html, /subscriber\.first_name/);
  }
  assert.match(quietEmail('soard', 'first').html, /three weeks/);
  assert.match(quietEmail('soard', 'first').html, /the kids we serve and the rooms we build/);
});
