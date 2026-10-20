/**
 * The applications waitlist: signups, and the one email when applications open
 * Run: node --test tests/application-waitlist.test.mjs
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };
const M = 60e3;

// ─── A fake Kit, Resend and site ────────────────────────────────────
const kit = { down: false, refuseBroadcast: false, refuseDelete: false, badKey: false, bulkFail: new Set(), subs: new Map(), tags: new Map(), tagged: new Map(), broadcasts: [], nextId: 100, stats: 'completed' };
const resend = [];
const resendScheduled = new Map(); // id → { to, scheduled_at, cancelled }
let formOpen = true;
const calls = [];

// Tags stay between tests, as they do in Kit (_kit.js remembers tag ids per isolate)
function kitReset() {
  kit.down = false; kit.refuseBroadcast = false; kit.refuseDelete = false; kit.badKey = false; kit.bulkFail = new Set(); kit.subs = new Map();
  kit.tagged = new Map(); kit.broadcasts = []; kit.stats = 'completed';
  resend.length = 0; resendScheduled.clear(); calls.length = 0; formOpen = true;
}
/** Broadcasts Kit still holds (not deleted) */
const live = () => kit.broadcasts.filter(b => !b.deleted);
const tagByName = (name) => [...kit.tags.entries()].find(([, n]) => n === name)?.[0] || null;
const tagsOf = (email) => {
  const sub = kit.subs.get(email);
  return sub ? [...(kit.tagged.get(sub.id) || [])].map(id => kit.tags.get(id)) : [];
};
const subjects = () => resend.map(m => m.subject);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  calls.push(`${method} ${url}`);
  if (url.startsWith('https://api.kit.com/v4/')) {
    if (kit.down) return json({ errors: ['Kit is down'] }, 503);
    if (kit.badKey) return json({ errors: ['The API key is invalid'] }, 401);
    const path = url.slice('https://api.kit.com/v4'.length).split('?')[0];
    const q = new URL(url).searchParams;
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/subscribers' && method === 'POST') {
      const email = body.email_address;
      const had = kit.subs.get(email);
      if (had) return json({ subscriber: { id: had.id, email_address: email, state: had.state } }, 200);
      const sub = { id: kit.nextId++, state: 'active' };
      kit.subs.set(email, sub);
      return json({ subscriber: { id: sub.id, email_address: email, state: 'active' } }, 201);
    }
    if (path === '/account' && method === 'GET') return json({ account: { name: 'Sunshine on a Ranney Day', sending_addresses: [{ email_address: 'hello@soard.test', from_name: 'SOARD', is_default: true, is_verified: true }] } });
    if (path === '/tags' && method === 'GET') return json({ tags: [...kit.tags].map(([id, name]) => ({ id, name, subscriber_count: [...kit.tagged.values()].filter(set => set.has(id)).length })), pagination: { has_next_page: false } });
    if (path === '/tags' && method === 'POST') { const id = kit.nextId++; kit.tags.set(id, body.name); return json({ tag: { id, name: body.name } }, 201); }
    let m = path.match(/^\/tags\/(\d+)\/subscribers\/(\d+)$/);
    if (m) {
      const [tag, sub] = [Number(m[1]), Number(m[2])];
      if (!kit.tagged.has(sub)) kit.tagged.set(sub, new Set());
      if (method === 'POST') kit.tagged.get(sub).add(tag);
      if (method === 'DELETE') kit.tagged.get(sub).delete(tag);
      return json({}, method === 'DELETE' ? 204 : 201);
    }
    m = path.match(/^\/tags\/(\d+)\/subscribers$/);
    if (m && method === 'GET') {
      const tag = Number(m[1]);
      const subs = [...kit.subs].filter(([, s]) => kit.tagged.get(s.id)?.has(tag)).map(([email, s]) => ({ id: s.id, email_address: email, state: s.state, tagged_at: '2026-06-01T12:00:00Z' }));
      assert.equal(q.get('status'), 'all');
      return json({ subscribers: subs, pagination: { has_next_page: false } });
    }
    if (path === '/bulk/tags/subscribers' && method === 'POST') {
      assert.ok(body.taggings.length <= 100, 'never more than 100 taggings a call');
      const failures = [];
      for (const t of body.taggings) {
        if (kit.bulkFail.has(t.subscriber_id)) { failures.push({ tagging: t, errors: ['nope'] }); continue; }
        if (!kit.tagged.has(t.subscriber_id)) kit.tagged.set(t.subscriber_id, new Set());
        kit.tagged.get(t.subscriber_id).add(t.tag_id);
      }
      return json({ subscribers: [], failures });
    }
    if (path === '/broadcasts' && method === 'POST') {
      if (kit.refuseBroadcast) return json({ errors: ['Kit refused'] }, 422);
      const b = { id: kit.nextId++, ...body, status: body.send_at ? 'scheduled' : 'draft' };
      kit.broadcasts.push(b);
      return json({ broadcast: b }, 201);
    }
    if (path === '/broadcasts' && method === 'GET') return json({ broadcasts: live().map(b => ({ id: b.id, description: b.description, subject: b.subject, status: b.status })) });
    m = path.match(/^\/broadcasts\/(\d+)$/);
    if (m && method === 'DELETE') {
      if (kit.refuseDelete) return json({ errors: ['Kit is having a moment'] }, 500);
      const b = kit.broadcasts.find(x => x.id === Number(m[1]));
      if (b) b.deleted = true;
      return new Response(null, { status: 204 });
    }
    m = path.match(/^\/broadcasts\/(\d+)\/stats$/);
    if (m) {
      const b = kit.broadcasts.find(x => x.id === Number(m[1]));
      const tagId = b?.subscriber_filter?.[0]?.all?.[0]?.ids?.[0];
      const recipients = [...kit.tagged.values()].filter(set => set.has(tagId)).length;
      return json({ broadcast: { id: b.id, stats: { status: kit.stats, recipients, emails_opened: 1, open_rate: 0.5, total_clicks: 1, click_rate: 0.25, progress: 100 } } });
    }
    return json({ errors: [`no fake for ${method} ${path}`] }, 404);
  }
  if (url.startsWith('https://api.resend.com/emails/batch')) {
    const items = JSON.parse(init.body);
    resend.push(...items);
    return json({ data: items.map((_, i) => ({ id: `r${resend.length + i}` })) });
  }
  if (url === 'https://api.resend.com/emails' && method === 'POST') {
    const item = JSON.parse(init.body);
    const id = `s${resendScheduled.size + 1}`;
    resendScheduled.set(id, { to: item.to[0], subject: item.subject, scheduled_at: item.scheduled_at, cancelled: false });
    return json({ id });
  }
  const cancel = url.match(/^https:\/\/api\.resend\.com\/emails\/([^/]+)\/cancel$/);
  if (cancel) { const x = resendScheduled.get(cancel[1]); if (x) x.cancelled = true; return json({ object: 'email', id: cancel[1] }); }
  if (url.endsWith('/apply/form/')) {
    const cfg = JSON.stringify({ open: formOpen, year: '2027' });
    return new Response(`<html><div data-application><script type="application/json" id="af-config">${cfg}</script></div></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  return json({ ok: true });
};

let env, w;
async function setOpen(open, by = 'peter@test', at = Date.now()) {
  const row = await env.DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first();
  const all = row ? JSON.parse(row.data) : {};
  all.application = { ...(all.application || {}), open, year: '2027', openChangedAt: new Date(at).toISOString(), openChangedBy: by };
  await env.DB.prepare("INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES ('settings', ?, ?)").bind(JSON.stringify(all), new Date().toISOString()).run();
}
const tick = () => w.maybeRunWaitlist(env, { force: true });
const opening = () => w.latestOpening(env.DB);
const row = (email) => env.DB.prepare('SELECT * FROM waitlist_signups WHERE email = ?').bind(email).first();

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  env = { DB, KIT_API_KEY: 'kit_test', RESEND_API_KEY: 're_test', SITE_ORIGIN: 'https://site.test' };
  w = await import('../functions/api/_application-waitlist.js');
  await w.ensureWaitlistSchema(DB);
});
after(() => { Date.now = realNow; globalThis.fetch = realFetch; });
beforeEach(async () => {
  kitReset();
  for (const t of ['waitlist_signups', 'waitlist_openings', 'waitlist_runtime']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await setOpen(false);
});

// ─── Signups ────────────────────────────────────────────────────────

test('a signup is saved, goes into Kit with the waitlist tags, and gets one confirmation', async () => {
  const r = await w.recordSignup(env, { email: ' Maria@Example.com ', lang: 'en', page: 'apply' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'added');
  const saved = await row('maria@example.com');
  assert.ok(saved, 'saved on the site');
  assert.ok(saved.kit_id, 'and in Kit');
  assert.equal(saved.kit_error, null);
  assert.deepEqual(tagsOf('maria@example.com').sort(), [w.WAITLIST_TAG, 'Application Waitlist only (no newsletter)'].sort());
  assert.deepEqual(subjects(), ["You're on the list"]);
  assert.ok(saved.confirmed_at);

  const again = await w.recordSignup(env, { email: 'maria@example.com', lang: 'en' });
  assert.equal(again.status, 'already');
  assert.equal(resend.length, 1, 'no second confirmation');
});

test('someone already on the newsletter is not marked waitlist-only', async () => {
  kit.subs.set('fan@example.com', { id: 5, state: 'active' });
  await w.recordSignup(env, { email: 'fan@example.com' });
  assert.deepEqual(tagsOf('fan@example.com'), [w.WAITLIST_TAG]);
});

test('Spanish signups get the Spanish confirmation', async () => {
  await w.recordSignup(env, { email: 'ana@example.com', lang: 'es' });
  assert.equal((await row('ana@example.com')).lang, 'es');
  assert.deepEqual(subjects(), ['Ya está en la lista']);
  assert.match(resend[0].html, /lang="es"/);
});

test('Kit being down never loses a family: saved, then retried until it lands', async () => {
  kit.down = true;
  const r = await w.recordSignup(env, { email: 'kim@example.com' });
  assert.equal(r.ok, true, 'the family still hears they are on the list');
  let saved = await row('kim@example.com');
  assert.equal(saved.kit_id, null);
  assert.match(saved.kit_error, /Kit/);
  assert.ok(saved.next_try_at > Date.now());
  kit.down = false;
  await tick();
  assert.equal((await row('kim@example.com')).kit_id, null, 'not before its retry time');
  travel(2 * M);
  await tick();
  saved = await row('kim@example.com');
  assert.ok(saved.kit_id, 'the heartbeat got it into Kit');
  assert.equal(saved.kit_error, null);
  assert.ok(tagsOf('kim@example.com').includes(w.WAITLIST_TAG));
});

test('signups from before the site kept its own list are read in from Kit; unsubscribes are left out', async () => {
  const k = await import('../functions/api/_kit.js');
  const tag = await k.kitTagId(env, w.WAITLIST_TAG);
  kit.subs.set('old@example.com', { id: 50, state: 'active' });
  kit.subs.set('gone@example.com', { id: 51, state: 'cancelled' });
  kit.tagged.set(50, new Set([tag]));
  kit.tagged.set(51, new Set([tag]));
  const r = await w.importFromKit(env);
  assert.equal(r.added, 2);
  const s = await w.waitlistStatus(env);
  assert.equal(s.waiting, 1, 'only the one still subscribed is waiting');
  assert.equal(s.unsubscribed, 1);
});

// ─── The opening ────────────────────────────────────────────────────

async function threeFamilies() {
  await w.recordSignup(env, { email: 'a@example.com', lang: 'en' });
  await w.recordSignup(env, { email: 'b@example.com', lang: 'en' });
  await w.recordSignup(env, { email: 'c@example.com', lang: 'es' });
  resend.length = 0;
}

test('switching applications on starts a 10-minute countdown from the save, and staff hear', async () => {
  await threeFamilies();
  const savedAt = Date.now();
  await setOpen(true, 'peter@test', savedAt);
  travel(40e3); // the heartbeat notices a little later
  await tick();
  const op = await opening();
  assert.equal(op.state, 'countdown');
  assert.equal(op.send_at, savedAt + w.COUNTDOWN_MS, 'counted from the save, not from when the heartbeat noticed');
  assert.equal(op.total, 3);
  assert.deepEqual({ en: op.counts.en, es: op.counts.es }, { en: 2, es: 1 });
  // Kit already holds the email, scheduled for the end of the countdown
  assert.equal(live().length, 2, 'one email per language, handed to Kit right away');
  for (const b of live()) assert.equal(Date.parse(b.send_at), savedAt + w.COUNTDOWN_MS, 'scheduled for the end of the countdown');
  assert.ok(op.staged_at, 'staged');
  assert.ok(subjects().some(s => /^Applications are open: the waitlist email goes out at/.test(s)), 'staff are told when it goes');
});

test('switching off again during the countdown sends nothing and keeps everyone waiting', async () => {
  await threeFamilies();
  await setOpen(true);
  await tick();
  travel(3 * M);
  await setOpen(false);
  await tick();
  assert.equal((await opening()).state, 'cancelled');
  assert.equal(kit.broadcasts.length, 2, 'it had been handed to Kit');
  assert.equal(live().length, 0, 'and closing took it back out of Kit');
  travel(20 * M);
  await tick();
  assert.equal(live().length, 0);
  assert.equal((await w.waitlistStatus(env)).waiting, 3);
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) assert.equal((await row(e)).opening_id, null, 'nobody marked as told');
});

test('after the countdown: one Kit email per language, to exactly the families waiting, once', async () => {
  await threeFamilies();
  await setOpen(true);
  await tick();
  travel(w.COUNTDOWN_MS + 5e3);
  await tick();
  let op = await opening();
  assert.equal(op.state, 'sending');
  assert.equal(live().length, 2);
  const en = kit.broadcasts.find(b => /English/.test(b.description));
  const es = kit.broadcasts.find(b => /Español/.test(b.description));
  assert.match(en.subject, /Applications are open: apply for a 2027 room makeover/);
  assert.match(es.subject, /Ya abrimos las solicitudes/);
  assert.ok(en.send_at && es.send_at && en.send_at === es.send_at, 'scheduled, so Kit sends on its own');
  assert.match(en.content, /https:\/\/sunshineonaranneyday\.com\/apply\/form\//);
  assert.match(es.content, /\/apply\/form\/\?lang=es/);
  assert.match(en.content, /\{\{ unsubscribe_url \}\}/);
  // Each goes to this opening's own tag: the right people, and only them
  const enTag = en.subscriber_filter[0].all[0].ids[0];
  const esTag = es.subscriber_filter[0].all[0].ids[0];
  assert.notEqual(enTag, esTag);
  assert.deepEqual(['a@example.com', 'b@example.com'].map(e => tagsOf(e).includes(kit.tags.get(enTag))), [true, true]);
  assert.equal(tagsOf('c@example.com').includes(kit.tags.get(esTag)), true);
  assert.equal(tagsOf('c@example.com').includes(kit.tags.get(enTag)), false);
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) {
    const r = await row(e);
    assert.equal(r.opening_id, op.id);
    assert.equal(r.notified_via, 'kit');
  }
  assert.ok(subjects().some(s => /going out to 3 families/.test(s)));

  // More heartbeats never send it again
  for (let i = 0; i < 5; i++) { travel(3 * M); await tick(); }
  assert.equal(kit.broadcasts.length, 2);
  op = await opening();
  assert.equal(op.state, 'sent', 'Kit said completed');
  assert.ok(subjects().some(s => /was sent to 3 families/.test(s)));
  assert.equal((await w.waitlistStatus(env)).waiting, 0);
});

test('a family who signs up while applications are open is told on the spot and emailed the link', async () => {
  await setOpen(true);
  const r = await w.recordSignup(env, { email: 'late@example.com', lang: 'es' });
  assert.equal(r.status, 'open');
  assert.match(r.formUrl, /\/apply\/form\/\?lang=es$/);
  assert.deepEqual(subjects(), ['Ya abrimos las solicitudes para las remodelaciones de 2027']);
  assert.equal(kit.subs.has('late@example.com'), false, 'no Kit list for someone who just needs the link');
  await w.recordSignup(env, { email: 'late@example.com', lang: 'es' });
  assert.equal(resend.length, 1, 'once');
});

test('a scheduled opening sends right away (no countdown)', async () => {
  await threeFamilies();
  await setOpen(true, 'schedule');
  await tick();
  assert.equal((await opening()).state, 'sending');
  assert.equal(kit.broadcasts.length, 2);
});

test('"Don\'t send this time" holds it; Send now sends it', async () => {
  await threeFamilies();
  await setOpen(true);
  await tick();
  assert.equal(live().length, 2, 'staged in Kit');
  assert.equal((await w.waitlistAction(env, 'hold', {}, { user: 'linzi@test' })).ok, true);
  assert.equal(live().length, 0, 'hold takes it back out of Kit');
  travel(w.COUNTDOWN_MS + M);
  await tick();
  assert.equal((await opening()).state, 'held');
  assert.equal(live().length, 0);
  const at = Date.now();
  assert.equal((await w.waitlistAction(env, 'send-now', {}, { user: 'linzi@test' })).ok, true);
  assert.equal((await opening()).state, 'sending');
  assert.equal(live().length, 2);
  for (const b of live()) assert.ok(Date.parse(b.send_at) - at <= 61e3, 'goes now (Kit needs a minute)');
});

test('Send now during the countdown moves Kit\'s email to now', async () => {
  await threeFamilies();
  await setOpen(true);
  await tick();
  const first = live().map(b => b.id);
  travel(2 * M);
  const at = Date.now();
  assert.equal((await w.waitlistAction(env, 'send-now', {}, { user: 'linzi@test' })).ok, true);
  assert.equal((await opening()).state, 'sending');
  assert.equal(live().length, 2);
  assert.ok(live().every(b => !first.includes(b.id)), 'the later ones were taken back');
  assert.ok(live().every(b => Date.parse(b.send_at) - at <= 61e3), 'the new ones go now');
});

test('once staged, Kit sends it even if the site never runs again', async () => {
  await threeFamilies();
  const savedAt = Date.now();
  await setOpen(true, 'peter@test', savedAt);
  await tick(); // the one call (the save's kick, or a heartbeat)
  const held = live();
  assert.equal(held.length, 2);
  assert.ok(held.every(b => b.status === 'scheduled' && Date.parse(b.send_at) === savedAt + w.COUNTDOWN_MS));
  const tagged = (b) => [...kit.subs].filter(([, x]) => kit.tagged.get(x.id)?.has(b.subscriber_filter[0].all[0].ids[0])).map(([e]) => e).sort();
  assert.deepEqual(held.flatMap(tagged).sort(), ['a@example.com', 'b@example.com', 'c@example.com'], 'every family is in the audience Kit will send to');
});

test('a family Kit can\'t reach is scheduled with Resend for the same time, and a cancel takes it back', async () => {
  await threeFamilies();
  kit.bulkFail.add((await row('b@example.com')).kit_id);
  const savedAt = Date.now();
  await setOpen(true, 'peter@test', savedAt);
  await tick();
  const sched = [...resendScheduled.values()];
  assert.equal(sched.length, 1);
  assert.equal(sched[0].to, 'b@example.com');
  assert.equal(Date.parse(sched[0].scheduled_at), savedAt + w.COUNTDOWN_MS);
  await setOpen(false);
  await tick();
  assert.equal((await opening()).state, 'cancelled');
  assert.equal(sched[0].cancelled || [...resendScheduled.values()][0].cancelled, true, 'cancelled in Resend');
  assert.equal(live().length, 0);
});

test('if Kit can\'t be reached to take it back, the site keeps trying and tells staff how to stop it', async () => {
  await threeFamilies();
  await setOpen(true);
  await tick();
  kit.refuseDelete = true;
  await setOpen(false);
  await tick();
  let op = await opening();
  assert.equal(op.state, 'countdown');
  assert.equal(op.stop?.mode, 'cancel');
  travel(M); await tick();
  assert.ok(subjects().some(s => /may still go out/.test(s)), 'staff hear, with the Kit links');
  kit.refuseDelete = false;
  travel(M); await tick();
  op = await opening();
  assert.equal(op.state, 'cancelled');
  assert.equal(live().length, 0);
});

test('a broken Kit key is caught while families wait, not on opening day', async () => {
  await threeFamilies();
  kit.badKey = true;
  const h = await w.checkKit(env);
  assert.equal(h.ok, false);
  assert.match(h.error, /turned down the site's key/);
  assert.ok(subjects().some(s => /Kit isn't working, and families are waiting/.test(s)), 'staff hear right away');
  const n = resend.length;
  await w.checkKit(env);
  assert.equal(resend.length, n, 'once a day, not every check');
  kit.badKey = false;
  const ok = await w.checkKit(env);
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'Sunshine on a Ranney Day');
  assert.equal(ok.from.verified, true);
  assert.equal(ok.tagCount, 3, 'how many Kit has on the waitlist tag');
});

test('the email waits for the form to really be open', async () => {
  await threeFamilies();
  formOpen = false;
  await setOpen(true, 'schedule');
  await tick();
  let op = await opening();
  assert.equal(op.state, 'preparing');
  assert.match(op.error, /still shows closed/);
  assert.equal(kit.broadcasts.length, 0);
  formOpen = true;
  travel(61e3);
  await tick();
  op = await opening();
  assert.equal(op.state, 'sending');
  assert.equal(kit.broadcasts.length, 2);
});

test('a family Kit will not tag gets the email straight from the site', async () => {
  await threeFamilies();
  kit.bulkFail.add((await row('b@example.com')).kit_id);
  await setOpen(true, 'schedule');
  await tick();
  const op = await opening();
  assert.equal(op.state, 'sending');
  assert.equal((await row('b@example.com')).notified_via, 'email');
  assert.equal((await row('a@example.com')).notified_via, 'kit');
  assert.equal(resend.filter(m => m.to[0] === 'b@example.com' && /Applications are open/.test(m.subject)).length, 1);
});

test('if Kit keeps refusing, staff are told, and after two hours the site emails the families itself', async () => {
  await threeFamilies();
  kit.refuseBroadcast = true;
  await setOpen(true, 'schedule');
  for (let i = 0; i < 6; i++) { await tick(); travel(11 * M); }
  assert.ok(subjects().some(s => /isn't ready yet/.test(s)), 'staff hear');
  assert.equal(kit.broadcasts.length, 0);
  for (let i = 0; i < 12; i++) { travel(11 * M); await tick(); }
  const op = await opening();
  assert.equal(op.state === 'sending' || op.state === 'sent', true);
  const opens = resend.filter(m => /Applications are open|Ya abrimos/.test(m.subject) && !/going out|was sent|isn't ready/.test(m.subject));
  assert.deepEqual(opens.map(m => m.to[0]).sort(), ['a@example.com', 'b@example.com', 'c@example.com']);
  for (let i = 0; i < 5; i++) { travel(11 * M); await tick(); }
  assert.equal(resend.filter(m => /Applications are open: apply/.test(m.subject) && m.to[0] === 'a@example.com').length, 1, 'still once');
});

test('Kit not connected at all: the families are still emailed after two hours', async () => {
  await threeFamilies();
  delete env.KIT_API_KEY;
  try {
    await setOpen(true, 'schedule');
    for (let i = 0; i < 14; i++) { await tick(); travel(11 * M); }
    const sent = resend.filter(m => /Applications are open: apply|Ya abrimos/.test(m.subject)).map(m => m.to[0]).sort();
    assert.deepEqual(sent, ['a@example.com', 'b@example.com', 'c@example.com']);
  } finally {
    env.KIT_API_KEY = 'kit_test';
  }
});

test('closing while Kit still has nothing (Kit down at opening) cancels; nobody is counted as told', async () => {
  await threeFamilies();
  kit.refuseBroadcast = true;
  await setOpen(true, 'schedule');
  await tick();
  assert.equal((await opening()).state, 'preparing', 'past its send time, still trying');
  travel(2 * M);
  await setOpen(false);
  await tick();
  const op = await opening();
  assert.equal(op.state, 'cancelled', 'nothing went out, so it is a cancel, not "sent"');
  assert.equal(live().length, 0);
  assert.equal((await w.waitlistStatus(env)).waiting, 3, 'all three still waiting for the next opening');
});

test('the next season: families told last time are not emailed again; new ones are', async () => {
  await threeFamilies();
  await setOpen(true, 'schedule');
  await tick();
  travel(10 * M); await tick();
  assert.equal((await opening()).state, 'sent');
  await setOpen(false);
  await tick();
  await w.recordSignup(env, { email: 'next@example.com' });
  await w.recordSignup(env, { email: 'a@example.com' }); // a asks again for next year
  await setOpen(true, 'schedule');
  travel(M);
  await tick();
  const op = await opening();
  assert.equal(op.total, 2);
  const last = kit.broadcasts.at(-1);
  const tag = last.subscriber_filter[0].all[0].ids[0];
  const inTag = [...kit.subs].filter(([, s]) => kit.tagged.get(s.id)?.has(tag)).map(([e]) => e).sort();
  assert.deepEqual(inTag, ['a@example.com', 'next@example.com']);
});

test('staff can add a family by hand and take one off', async () => {
  const add = await w.waitlistAction(env, 'add', { email: 'phone@example.com', lang: 'es' }, { user: 'linzi@test' });
  assert.equal(add.ok, true);
  assert.equal((await row('phone@example.com')).page, 'admin');
  await w.recordSignup(env, { email: 'oops@example.com' });
  assert.equal((await w.waitlistAction(env, 'remove', { email: 'oops@example.com' }, { user: 'linzi@test' })).ok, true);
  const s = await w.waitlistStatus(env);
  assert.equal(s.waiting, 1);
  assert.equal(tagsOf('oops@example.com').includes(w.WAITLIST_TAG), false, 'their Kit waitlist tag comes off too');
  // Kit's tag read-in never brings a removed family back
  await w.importFromKit(env);
  assert.equal((await w.waitlistStatus(env)).waiting, 1);
});

test('staff wording replaces the default and shows in the preview', async () => {
  await w.waitlistAction(env, 'wording', { wording: { en: { subject: 'We are open for {year}!', body: 'Come apply.' } } }, { user: 'peter@test' });
  const p = await w.previewOpening(env, { lang: 'en' });
  assert.equal(p.subject, 'We are open for 2027!');
  assert.match(p.html, /Come apply\./);
  const es = await w.previewOpening(env, { lang: 'es' });
  assert.match(es.subject, /Ya abrimos/, 'Spanish keeps its default');
});

test('a rehearsal sends the real Kit email to just the person who asked', async () => {
  const first = await w.waitlistAction(env, 'rehearse', { lang: 'es' }, { user: 'linzi@soard.test' });
  assert.equal(first.ok, true, first.error);
  const second = await w.waitlistAction(env, 'rehearse', { lang: 'en' }, { user: 'peter@soard.test' });
  assert.equal(second.ok, true, second.error);
  const b = live().at(-1);
  assert.match(b.subject, /^\[Rehearsal\] Applications are open/);
  assert.match(kit.broadcasts.at(-2).subject, /^\[Rehearsal\] Ya abrimos/);
  assert.ok(Date.parse(b.send_at) - Date.now() <= 61e3, 'Kit sends it in a minute');
  const tag = b.subscriber_filter[0].all[0].ids[0];
  const inTag = [...kit.subs].filter(([, x]) => kit.tagged.get(x.id)?.has(tag)).map(([e]) => e);
  assert.deepEqual(inTag, ['peter@soard.test'], 'only the person rehearsing, not the one before');
  assert.equal((await w.waitlistStatus(env)).waiting, 0, 'nobody is added to the waitlist');
});

// ─── Kit list mail leaves waitlist-only families out ────────────────

test('"all subscribers" sends leave out families who only asked about applications', async () => {
  const k = await import('../functions/api/_kit.js');
  await w.recordSignup(env, { email: 'only@example.com' });
  const onlyTag = tagByName(k.WAITLIST_ONLY_TAG);
  const r = await k.kitCreateBroadcast(env, { subject: 'News', description: 'n', html: '<p>hi</p>' });
  assert.equal(r.ok, true);
  assert.deepEqual(kit.broadcasts.at(-1).subscriber_filter, [{ all: null, any: null, none: [{ type: 'tag', ids: [onlyTag] }] }]);
  // Joining the newsletter takes them off the waitlist-only list
  await k.kitSubscribe(env, 'only@example.com', { source: 'newsletter' });
  assert.equal(tagsOf('only@example.com').includes(k.WAITLIST_ONLY_TAG), false);
});
