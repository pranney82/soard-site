/**
 * /api/reveals.ics: the reveal calendar people subscribe to. Confirmed
 * reveals only (a tentative one has no public day), each with the live
 * link, moved in place when the date changes, kept after it happens.
 * Run: node --test tests/reveals-ics.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { buildCalendar, buildKidCalendar, revealEvent, onRequestGet } from '../functions/api/reveals.ics.js';
import { fold } from '../functions/api/_ics.js';

const realFetch = globalThis.fetch;
let jobtreadCalls = 0;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.jobtread.com/')) { jobtreadCalls++; return Response.json({ organization: { jobs: { nodes: [], nextPage: null } } }); }
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

const NOW = Date.parse('2026-10-22T16:00:00Z');
const MAX = { slug: 'max', name: 'Max', startsAt: '2026-11-17T21:00:00.000Z', date: '2026-11-17', time: '16:00' };
const COLIN = { slug: 'colin', name: 'Colin', startsAt: '2026-11-25T05:00:00.000Z', date: '2026-11-25', time: null };
const ISLA = { slug: 'isla', name: 'Isla', startsAt: '2026-09-30T20:00:00.000Z', date: '2026-09-30', time: '16:00' };
/** Unfolded content lines */
const unfold = (ics) => ics.replace(/\r\n /g, '').split('\r\n');

test('the calendar names itself and refreshes hourly', () => {
  const lines = unfold(buildCalendar({ reveals: [], past: [] }, { now: NOW }));
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.ok(lines.includes('X-WR-CALNAME:Sunshine on a Ranney Day reveals'));
  assert.ok(lines.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'));
  assert.ok(lines.includes('X-PUBLISHED-TTL:PT1H'));
  assert.ok(lines.includes('X-WR-TIMEZONE:America/New_York'));
  assert.equal(lines.at(-2), 'END:VCALENDAR');
  assert.ok(!lines.includes('BEGIN:VEVENT'), 'an empty calendar is still a calendar');
});

test('a timed reveal links the live page and reminds 15 minutes ahead', () => {
  const lines = unfold(buildCalendar({ reveals: [MAX] }, { now: NOW }));
  assert.ok(lines.includes('UID:live-reveal-max@sunshineonaranneyday.com'), 'one UID per kid, so a moved date updates in place');
  assert.ok(lines.includes('DTSTART:20261117T210000Z'));
  assert.ok(lines.includes('DTEND:20261117T220000Z'));
  assert.ok(lines.includes('SUMMARY:Max’s Room Reveal (watch live)'));
  assert.ok(lines.includes('LOCATION:https://sunshineonaranneyday.com/live/max/'));
  assert.ok(lines.includes('URL:https://sunshineonaranneyday.com/live/max/'));
  assert.ok(lines.includes('TRIGGER:-PT15M'));
  assert.ok(lines.includes('TRANSP:TRANSPARENT'), "watching doesn't mark anyone busy");
  const desc = lines.find((l) => l.startsWith('DESCRIPTION:Watch live'));
  assert.match(desc, /Watch live: https:\/\/sunshineonaranneyday\.com\/live\/max\/\\n/);
  assert.match(desc, /kids\/max\//);
});

test('a confirmed day with no time yet is an all-day entry that says so', () => {
  const lines = unfold(revealEvent(COLIN, { stamp: '20261022T160000Z' }).join('\r\n'));
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20261125'));
  assert.ok(lines.includes('DTEND;VALUE=DATE:20261126'));
  assert.ok(lines.includes('SUMMARY:Colin’s Room Reveal (time coming soon)'));
  assert.ok(!lines.includes('BEGIN:VALARM'));
});

test('past reveals stay, pointing at the story; names ending in s read right', () => {
  const lines = unfold(buildCalendar({ reveals: [MAX], past: [ISLA, { ...ISLA, slug: 'james', name: 'James' }] }, { now: NOW }));
  assert.ok(lines.includes('SUMMARY:Isla’s Room Reveal'));
  assert.ok(lines.includes('URL:https://sunshineonaranneyday.com/kids/isla/'));
  assert.ok(lines.includes('SUMMARY:James’ Room Reveal'));
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 3);
  assert.equal(lines.filter((l) => l === 'BEGIN:VALARM').length, 1, 'only the reveal ahead has an alert');
});

test('one reveal on its own, for a single "add to calendar"', () => {
  const lines = unfold(buildCalendar({ reveals: [MAX, COLIN], past: [ISLA] }, { now: NOW, only: 'colin' }));
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.ok(lines.includes('UID:live-reveal-colin@sunshineonaranneyday.com'));
  assert.ok(!lines.some((l) => l.startsWith('X-WR-CALNAME')), 'a single event is not a calendar to subscribe to');
});

test('lines fold at 75 octets without splitting a character', () => {
  const long = `SUMMARY:${'Josué ’ 🌞 '.repeat(20)}`;
  const folded = fold(long);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  assert.equal(folded.replace(/\r\n /g, ''), long);
});

// ── Each child's own invite (Peter, Oct 22 2026: "Add now, fills in later") ──
const MAX_TENTATIVE = { slug: 'max', name: 'Max', confirmed: false, window: { part: 'mid', month: '2026-11', through: '2026-11-20', label: 'mid November' } };

test("a child's invite before the day is set: a placeholder across the window, no day, no address", () => {
  const lines = unfold(buildKidCalendar(MAX_TENTATIVE, { slug: 'max', name: 'Max', now: NOW }));
  assert.ok(lines.includes('X-WR-CALNAME:Max’s room reveal'));
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20261111'), 'mid November starts on the 11th');
  assert.ok(lines.includes('DTEND;VALUE=DATE:20261121'), 'and runs through the 20th');
  assert.ok(lines.includes('SUMMARY:Max’s Room Reveal (day to come)'));
  assert.ok(lines.includes('STATUS:TENTATIVE'));
  assert.ok(lines.includes('LOCATION:https://sunshineonaranneyday.com/live/max/'), 'the location is the live link');
  assert.ok(lines.includes('UID:live-reveal-max@sunshineonaranneyday.com'), 'the same UID it keeps once confirmed');
  assert.ok(!lines.some((l) => l.startsWith('BEGIN:VALARM')));
});

test("a child's invite once confirmed: the day, time and live link, same UID", () => {
  const lines = unfold(buildKidCalendar({ ...MAX, confirmed: true }, { slug: 'max', name: 'Max', now: NOW }));
  assert.ok(lines.includes('UID:live-reveal-max@sunshineonaranneyday.com'));
  assert.ok(lines.includes('DTSTART:20261117T210000Z'));
  assert.ok(lines.includes('STATUS:CONFIRMED'));
  assert.ok(lines.includes('TRIGGER:-PT15M'));
  // After the day, the same entry points at the story
  const after = unfold(buildKidCalendar({ ...MAX, confirmed: true }, { slug: 'max', name: 'Max', now: Date.parse('2026-11-19T16:00:00Z') }));
  assert.ok(after.includes('SUMMARY:Max’s Room Reveal'));
  assert.ok(after.includes('URL:https://sunshineonaranneyday.com/kids/max/'));
  // No reveal right now: the calendar stays, with nothing in it
  assert.ok(!unfold(buildKidCalendar(null, { slug: 'max', name: 'Max', now: NOW })).includes('BEGIN:VEVENT'));
});

async function makeEnv(cache, extra = {}) {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, status TEXT, data TEXT NOT NULL)',
  ] });
  if (cache) await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind('reveals', JSON.stringify(cache), cache.updatedAt).run();
  return { DB, ...extra };
}
const get = (env, path) => onRequestGet({ env, request: new Request(`https://sunshineonaranneyday.com${path}`), waitUntil: () => {} });

test('serves the subscription from the fresh copy without asking JobTread', async () => {
  const future = { ...MAX, startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) };
  const env = await makeEnv({
    reveals: [future],
    upcoming: [{ ...future, confirmed: true }, { slug: 'dylan-2026', name: 'Dylan', confirmed: false, window: { part: 'mid', month: '2099-11', through: '2099-11-20', label: 'mid November' } }],
    updatedAt: new Date().toISOString(),
  }, { JOBTREAD_GRANT_KEY: 'grant_test' });
  jobtreadCalls = 0;
  const res = await get(env, '/api/reveals.ics?utm=1');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/calendar/);
  assert.match(res.headers.get('Content-Disposition'), /^inline/);
  const body = await res.text();
  assert.match(body, /UID:live-reveal-max@/);
  assert.ok(!/dylan/i.test(body), 'tentative reveals never reach a calendar');
  assert.equal(jobtreadCalls, 0);

  const one = await get(env, '/api/reveals.ics?reveal=max');
  assert.equal(one.status, 200);
  assert.match(one.headers.get('Content-Disposition'), /attachment; filename="max-reveal.ics"/);
  // A tentative or unknown reveal has no entry to add
  assert.equal((await get(env, '/api/reveals.ics?reveal=dylan-2026')).status, 404);
  assert.equal((await get(env, '/api/reveals.ics?reveal=../x')).status, 404);
});

test("serves each child's invite from the copy; unknown kids and drafts get a 404", async () => {
  const env = await makeEnv({ reveals: [], upcoming: [{ ...MAX_TENTATIVE, window: { ...MAX_TENTATIVE.window, month: '2099-11', through: '2099-11-20' } }], updatedAt: new Date().toISOString() });
  await env.DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('lizzie', 'Lizzie', 2026, 'in-progress', JSON.stringify({ name: 'Lizzie', publishStatus: 'published' })).run();
  await env.DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind('secret', 'Secret', 2026, 'in-progress', JSON.stringify({ name: 'Secret', publishStatus: 'draft' })).run();
  const max = await get(env, '/api/reveals.ics?kid=max');
  assert.equal(max.status, 200);
  assert.match(max.headers.get('Content-Disposition'), /^inline; filename="max-reveal.ics"/);
  const body = (await max.text()).replace(/\r\n /g, '');
  assert.match(body, /SUMMARY:Max’s Room Reveal \(day to come\)/);
  assert.match(body, /DTSTART;VALUE=DATE:20991111/);
  // A published kid with no reveal right now: an empty calendar in their name
  const lizzie = (await (await get(env, '/api/reveals.ics?kid=lizzie')).text()).replace(/\r\n /g, '');
  assert.match(lizzie, /X-WR-CALNAME:Lizzie’s room reveal/);
  assert.ok(!lizzie.includes('BEGIN:VEVENT'));
  assert.equal((await get(env, '/api/reveals.ics?kid=secret')).status, 404, 'a draft kid has no invite');
  assert.equal((await get(env, '/api/reveals.ics?kid=nobody')).status, 404);
  assert.equal((await get(env, '/api/reveals.ics?kid=Max%2F..')).status, 404);
});

test('a stale copy is refreshed from JobTread', async () => {
  const env = await makeEnv({ reveals: [], updatedAt: '2026-01-01T00:00:00.000Z' }, { JOBTREAD_GRANT_KEY: 'grant_test' });
  jobtreadCalls = 0;
  const res = await get(env, '/api/reveals.ics');
  assert.equal(res.status, 200);
  assert.equal(jobtreadCalls, 1);
});
