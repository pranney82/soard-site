/**
 * An email written in Kit, set to go to all subscribers, that would reach
 * people who asked for reveal emails or the applications opening only: the
 * reviewers hear once, and nothing in Kit is changed. Kit and Resend are faked.
 * Run: node --test tests/kit-audience-guard.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { maybeGuardAudiences, reaches, audienceNote, NEWSLETTER_SEGMENT } from '../functions/api/_kit-audience-guard.js';

const ONLY = { id: 501, name: 'Reveal sign-ups only (no newsletter)', subscriber_count: 12 };
const WAIT = { id: 24835326, name: 'Application Waitlist only (no newsletter)', subscriber_count: 40 };
let kit, mail, env;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://api.kit.com/v4/')) {
    kit.calls.push(`${method} ${url.replace('https://api.kit.com/v4', '')}`);
    if (kit.down) return new Response('down', { status: 503 });
    if (url.includes('/tags')) return Response.json({ tags: kit.tags });
    if (url.includes('/segments')) return Response.json({ segments: kit.segments });
    const list = url.match(/\/broadcasts\?status=(\w+)/);
    if (list) return Response.json({ broadcasts: kit.broadcasts.filter((b) => b.status === list[1]).map(({ subscriber_filter, content, ...b }) => b) });
    const one = url.match(/\/broadcasts\/(\d+)$/);
    if (one && method === 'GET') return Response.json({ broadcast: kit.broadcasts.find((b) => String(b.id) === one[1]) });
    if (method !== 'GET') throw new Error(`the guard changed something in Kit: ${method} ${url}`);
  }
  if (url.startsWith('https://api.resend.com/')) { mail.push(...JSON.parse(init.body)); return Response.json({ data: [{ id: 're_1' }] }); }
  throw new Error(`unexpected ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

beforeEach(async () => {
  kit = { calls: [], down: false, tags: [ONLY, WAIT, { id: 7, name: 'Newsletter', subscriber_count: 900 }], segments: [{ id: 600, name: NEWSLETTER_SEGMENT }], broadcasts: [] };
  mail = [];
  env = { DB: await createD1(), KIT_API_KEY: 'kit', RESEND_API_KEY: 're' };
});
const tags = () => kit.tags.filter((t) => t.id !== 7).map((t) => ({ id: t.id, name: t.name, count: t.subscriber_count }));
let clock = Date.now();
const look = () => maybeGuardAudiences(env, { now: (clock += 5 * 60e3) });

test('only "everyone" is checked: a tag, a segment or the newsletter segment is someone\'s deliberate pick', () => {
  const all = [{ id: 501, name: ONLY.name, count: 12 }, { id: 24835326, name: WAIT.name, count: 40 }];
  assert.deepEqual(reaches({ subscriber_filter: [] }, all).map((t) => t.id), [501, 24835326], 'Kit\'s default: everyone');
  assert.deepEqual(reaches({ subscriber_filter: [{ all: [{ type: 'all_subscribers' }], any: null, none: null }] }, all).length, 2);
  assert.deepEqual(reaches({ subscriber_filter: [{ all: null, any: null, none: [{ type: 'tag', ids: [24835326] }] }] }, all).map((t) => t.id), [501], 'one left out, one not');
  assert.equal(reaches({ subscriber_filter: [{ all: null, any: null, none: [{ type: 'tag', ids: [501, 24835326] }] }] }, all).length, 0);
  assert.equal(reaches({ subscriber_filter: [{ all: [{ type: 'segment', ids: [600] }], any: null, none: null }] }, all).length, 0, 'the newsletter segment');
  assert.equal(reaches({ subscriber_filter: [{ all: null, any: [{ type: 'tag', ids: [7] }], none: null }] }, all).length, 0, 'a tag');
  assert.equal(reaches({ subscriber_filter: [] }, [{ id: 501, name: ONLY.name, count: 0 }]).length, 0, 'nobody in it yet');
});

test('an email written in Kit to all subscribers: the reviewers hear once, what it reaches and how to fix it, and Kit is never changed', async () => {
  kit.broadcasts = [
    { id: 11, status: 'draft', subject: 'November newsletter', description: '', subscriber_filter: [] },
    { id: 12, status: 'scheduled', subject: 'Giving Tuesday', description: null, subscriber_filter: [{ all: [{ type: 'segment', ids: [600] }], any: null, none: null }] },
    { id: 13, status: 'draft', subject: 'Join Us Live for Dylan’s Reveal Day!', description: '[auto] Dylan whole-list invite · J1 · abc', subscriber_filter: [] },
  ];
  const out = await look();
  assert.deepEqual(out.map((x) => x.id), [11], 'only the one written in Kit to everyone; the newsletter segment is fine, and the site\'s own drafts are the site\'s');
  // One email to each reviewer
  assert.deepEqual(mail.flatMap((m) => m.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com']);
  const notes = () => mail.length / 2;
  assert.equal(mail[0].subject, 'Check who “November newsletter” goes to');
  assert.match(mail[0].html, /12 people who signed up on the website for reveal emails only and 40 families waiting only for applications to open/);
  assert.match(mail[0].html, new RegExp(`change Recipients to “${NEWSLETTER_SEGMENT}”`));
  assert.match(mail[0].html, /app\.kit\.com\/campaigns\/11/);
  assert.ok(!/—/.test(mail[0].html + mail[0].text), 'no em dashes');
  // Once: the next look says nothing more
  await look();
  assert.equal(notes(), 1);
  // Until what it reaches changes: someone left one group out, the other still goes
  kit.broadcasts[0].subscriber_filter = [{ all: null, any: null, none: [{ type: 'tag', ids: [24835326] }] }];
  await look();
  assert.equal(notes(), 2);
  assert.match(mail.at(-1).html, /12 people who signed up on the website for reveal emails only\. They asked/);
  assert.ok(kit.calls.every((c) => c.startsWith('GET ')), 'it only ever reads');
});

test('without the newsletter segment in Kit, it says which tags to leave out', () => {
  const n = audienceNote({ subject: 'X', id: 1, groups: [{ id: 501, name: ONLY.name, count: 1 }], segment: null });
  assert.match(n.text, /add “Reveal sign-ups only \(no newsletter\)” and “Application Waitlist only \(no newsletter\)” to its Recipients as tags it matches none of/);
  assert.match(n.text, /1 person who signed up/);
});

test('every few minutes at most, and quiet when Kit is down or nobody asked for less', async () => {
  kit.broadcasts = [{ id: 21, status: 'draft', subject: 'A', subscriber_filter: [] }];
  const t = clock += 10 * 60e3;
  await maybeGuardAudiences(env, { now: t });
  const calls = kit.calls.length;
  await maybeGuardAudiences(env, { now: t + 60e3 });
  assert.equal(kit.calls.length, calls, 'a minute later: not again yet');
  kit.down = true;
  mail.length = 0;
  assert.equal(await look(), null, 'Kit down: nothing said, nothing thrown');
  kit.down = false;
  kit.tags = [{ id: 7, name: 'Newsletter', subscriber_count: 900 }];
  kit.broadcasts = [{ id: 22, status: 'draft', subject: 'B', subscriber_filter: [] }];
  assert.deepEqual(await look(), [], 'nobody to protect');
  assert.equal(mail.length, 0);
});
