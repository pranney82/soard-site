/**
 * /api/calendar.ics builds invites only from what the site knows: an event,
 * a reveal as it is now (rehearsals too), or fields the site signed. Old
 * email links are served as the reveal or event they name; anything else is
 * a plain 404. Nothing from an unsigned link reaches the invite.
 * Run: node --test tests/calendar-ics.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequestGet, parseEventTime } from '../functions/api/calendar.ics.js';
import { calendarIcsUrl, hmacSha256Hex, signCalendarParams } from '../functions/api/_calendar-links.js';
import { customTemplate } from '../functions/api/_email-templates.js';

const SITE = 'https://sunshineonaranneyday.com';
const SECRET = 'cal_test_secret';

const realFetch = globalThis.fetch;
let jobtreadCalls = 0;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.jobtread.com/')) {
    jobtreadCalls++;
    return Response.json({ organization: { jobs: { nodes: [], nextPage: null } } });
  }
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

// A made-up gala and a made-up confirmed reveal (Eastern times)
const GALA = {
  title: 'Evening of Sunshine', slug: 'test-gala', date: '2027-08-21', endDate: '2027-08-21', time: '6:00 to 11:00 p.m.',
  location: 'Example Hall', address: '100 Example St, Roswell, GA 30076', description: 'A night out.\n\nMore words.', status: 'upcoming',
};
const REVEAL = { slug: 'rowan-test', name: 'Rowan', startsAt: '2027-03-12T20:00:00.000Z', date: '2027-03-12', time: '15:00', image: null, kidUrl: '/kids/rowan-test/', liveUrl: '/live/rowan-test/' };

let env;
beforeEach(async () => {
  jobtreadCalls = 0;
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO events (slug, title, date, status, featured, data) VALUES (?, ?, ?, ?, 0, ?)').bind(GALA.slug, GALA.title, GALA.date, 'upcoming', JSON.stringify(GALA)).run();
  await DB.prepare("INSERT INTO site_config (key, data) VALUES ('reveals', ?)").bind(JSON.stringify({ reveals: [REVEAL], updatedAt: new Date().toISOString() })).run();
  env = { DB };
});

const get = (query, e = env) => onRequestGet({ env: e, request: new Request(`${SITE}/api/calendar.ics?${query}`) });
async function ics(query, e) {
  const res = await get(query, e);
  assert.equal(res.status, 200, `served ${query}`);
  assert.match(res.headers.get('Content-Type'), /text\/calendar/);
  // Unfold (RFC 5545 §3.1) and unescape for easy matching
  const text = (await res.text()).replace(/\r\n /g, '');
  const field = (name) => (text.match(new RegExp(`^${name}[^:]*:(.*)$`, 'm')) || [])[1]?.replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1') ?? null;
  return { text, field };
}
async function refused(query, e) {
  const res = await get(query, e);
  assert.equal(res.status, 404, `refused ${query}`);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const body = await res.text();
  assert.doesNotMatch(body, /BEGIN:VCALENDAR/);
  return body;
}

// The link the reveal invite email has always built (functions/api/_email-templates.js)
const emailLink = (o = {}) => new URLSearchParams({
  title: "Rowan's Reveal Day — Sunshine on a Ranney Day", start: '20270312T200000Z', end: '20270312T220000Z',
  location: "Rowan's Home, 12 Example Ln, Kennesaw, GA 30152", details: 'After months of planning and building, the day is almost here.\n\nhttps://sunshineonaranneyday.com/kids/rowan-test',
  uid: 'reveal-rowan-test-20270312@sunshineonaranneyday.com', url: 'https://sunshineonaranneyday.com/kids/rowan-test', ...o,
}).toString();

test('an invite made up in the link is a 404, not a calendar file from our domain', async () => {
  const body = await refused(new URLSearchParams({
    title: 'Your gift failed: call 555-0100', start: '20270101T150000Z', end: '20270101T160000Z',
    location: 'https://evil.example/pay', details: 'Verify your card at https://evil.example', url: 'https://evil.example',
  }).toString());
  assert.doesNotMatch(body, /evil|555-0100/);
  await refused('');
  await refused('event=nope');
  await refused('reveal=nope');
  await refused('event=../../x');
});

test('?event=<slug>: the event as the site has it', async () => {
  const { field } = await ics('event=test-gala');
  assert.equal(field('SUMMARY'), 'Evening of Sunshine');
  assert.equal(field('DTSTART'), '20270821T220000Z', '6 p.m. Eastern (daylight time)');
  assert.equal(field('DTEND'), '20270822T030000Z', '11 p.m. Eastern');
  assert.equal(field('LOCATION'), 'Example Hall, 100 Example St, Roswell, GA 30076');
  assert.equal(field('DESCRIPTION'), 'A night out.');
  assert.equal(field('URL'), `${SITE}/events/test-gala/`);
  assert.equal(field('UID'), 'event-test-gala@sunshineonaranneyday.com');

  // No time: an all-day invite through the last day
  await env.DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...GALA, time: '', endDate: '2027-08-22' }), GALA.slug).run();
  const allDay = await ics('event=test-gala');
  assert.equal(allDay.field('DTSTART'), '20270821');
  assert.equal(allDay.field('DTEND'), '20270823', 'all-day ends are exclusive');

  // Cancelled: gone
  await env.DB.prepare('UPDATE events SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...GALA, status: 'cancelled' }), GALA.slug).run();
  await refused('event=test-gala');
});

test('?reveal=<kid slug>: the confirmed reveal, and never an address', async () => {
  const { field } = await ics('reveal=rowan-test');
  assert.equal(field('SUMMARY'), "Rowan's Reveal Day");
  assert.equal(field('DTSTART'), '20270312T200000Z');
  assert.equal(field('DTEND'), '20270312T220000Z');
  assert.equal(field('LOCATION'), null);
  assert.equal(field('URL'), `${SITE}/kids/rowan-test/`);
  assert.equal(field('UID'), 'reveal-rowan-test-20270312@sunshineonaranneyday.com', 'the same uid as the email, so calendars update it');
  assert.equal(jobtreadCalls, 0, 'answered from the reveal cache');
});

test('old email links are served as the reveal they name, as it is now; nothing from the link is used', async () => {
  const { field, text } = await ics(emailLink({ details: 'Pay at https://evil.example', location: 'Call 555-0100 to confirm your seat' }));
  assert.equal(field('SUMMARY'), "Rowan's Reveal Day");
  assert.equal(field('DTSTART'), '20270312T200000Z');
  assert.equal(field('LOCATION'), null, 'the link’s place is not ours to repeat');
  assert.doesNotMatch(text, /evil|555-0100/);

  // The reveal moved after the email went out: the new date, not a 404
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'reveals'").bind(JSON.stringify({ reveals: [{ ...REVEAL, startsAt: '2027-03-19T18:30:00.000Z', date: '2027-03-19', time: '14:30' }], updatedAt: new Date().toISOString() })).run();
  const moved = await ics(emailLink());
  assert.equal(moved.field('DTSTART'), '20270319T183000Z');
  assert.equal(moved.field('UID'), 'reveal-rowan-test-20270319@sunshineonaranneyday.com');

  // Only the title to go on: it has to be that day
  assert.equal((await ics(emailLink({ uid: '', url: '', start: '20270319T183000Z', end: '20270319T203000Z' }))).field('SUMMARY'), "Rowan's Reveal Day");
  await refused(emailLink({ uid: '', url: '' }));

  // A slug the site has no reveal for: refused
  await refused(emailLink({ uid: 'reveal-someone-else-20270312@sunshineonaranneyday.com', url: '' }));
});

test('old links to an event are served as the event is now', async () => {
  const link = new URLSearchParams({ title: 'Evening of Sunshine', start: '20270821', end: '20270822', allday: '1', location: 'Somewhere else', details: 'Other words', url: `${SITE}/events/test-gala/` });
  const { field } = await ics(link.toString());
  assert.equal(field('SUMMARY'), 'Evening of Sunshine');
  assert.equal(field('LOCATION'), 'Example Hall, 100 Example St, Roswell, GA 30076', 'the site’s place, not the link’s');
  // Named by its page: the event wherever its date is now
  link.set('start', '20270901'); link.set('end', '20270902');
  assert.equal((await ics(link.toString())).field('DTSTART'), '20270821T220000Z');
  // By title alone, the day has to match
  link.delete('url');
  await refused(link.toString());
});

test('a rehearsal (a TEST job) resolves from the broadcast’s plan, marked TEST; a real reveal comes first', async () => {
  const rehearsal = { jobId: 'job1', jobName: 'TEST Isla Example (2027)', slug: 'isla-test', name: 'Isla', startsAt: '2027-02-02T16:00:00.000Z', date: '2027-02-02', time: '11:00', test: true };
  await env.DB.prepare("INSERT INTO site_config (key, data) VALUES ('broadcast-schedule', ?)").bind(JSON.stringify({ checkedAt: new Date().toISOString(), next: rehearsal, waiting: [], last: null })).run();
  const { field } = await ics('reveal=isla-test');
  assert.equal(field('SUMMARY'), "TEST · Isla's Reveal Day");
  assert.equal(field('DTSTART'), '20270202T160000Z');
  assert.match(field('DESCRIPTION'), /rehearsal/);
  // An old link to the rehearsal works the same way
  assert.equal((await ics(emailLink({ uid: 'reveal-isla-test-20270202@sunshineonaranneyday.com', url: '' }))).field('SUMMARY'), "TEST · Isla's Reveal Day");
  // Once Isla has a confirmed reveal, that is the one
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'reveals'").bind(JSON.stringify({ reveals: [REVEAL, { ...REVEAL, slug: 'isla-test', name: 'Isla', startsAt: '2027-04-01T19:00:00.000Z', date: '2027-04-01' }], updatedAt: new Date().toISOString() })).run();
  assert.equal((await ics('reveal=isla-test')).field('SUMMARY'), "Isla's Reveal Day");
  // A kid page in draft, or a job with no kid page, is never served
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'broadcast-schedule'").bind(JSON.stringify({ waiting: [{ ...rehearsal, slug: 'drafty', test: false, problem: 'draft' }] })).run();
  await refused('reveal=drafty');
});

const inviteBlock = { type: 'revealInvite', slug: 'rowan-test', kidName: 'Rowan', date: '2027-03-12', time: '3:00 PM', location: "Rowan's Home", address: '12 Example Ln, Kennesaw, GA 30152', calendarTitle: 'Rowan’s big day!', calendarDetails: 'Park on the street.' };
const appleLink = (html) => new URL(html.match(/href="([^"]*\/api\/calendar\.ics\?[^"]*)"/)[1].replace(/&amp;/g, '&'));

test('the reveal invite email: without the secret its Apple link looks the reveal up, as it is now', async () => {
  const href = appleLink(customTemplate({ blocks: [inviteBlock] }).html);
  assert.equal(href.toString(), `${SITE}/api/calendar.ics?reveal=rowan-test`);
  assert.equal((await ics(href.search.slice(1))).field('DTSTART'), '20270312T200000Z');
  // No kid picked: no Apple link at all (Google and Outlook stay)
  const none = customTemplate({ blocks: [{ ...inviteBlock, slug: '' }] }).html;
  assert.doesNotMatch(none, /api\/calendar\.ics/);
  assert.match(none, /calendar\.google\.com/);
});

test('the reveal invite email: with the secret its Apple link carries staff’s own words, signed', async () => {
  const href = appleLink(customTemplate({ blocks: [inviteBlock] }, {}, { calendarSecret: SECRET }).html);
  assert.match(href.search, /&sig=[0-9a-f]{64}$/);
  const { field } = await ics(href.search.slice(1), { ...env, CALENDAR_LINK_SECRET: SECRET });
  assert.equal(field('SUMMARY'), 'Rowan’s big day!');
  assert.equal(field('LOCATION'), "Rowan's Home, 12 Example Ln, Kennesaw, GA 30152");
  assert.match(field('DESCRIPTION'), /^Park on the street\./);
  assert.equal(field('DTSTART'), '20270312T200000Z');
  // A request's own opts can't supply a secret
  assert.match(appleLink(customTemplate({ blocks: [inviteBlock] }, { calendarSecret: 'attacker' }).html).search, /^\?reveal=rowan-test$/);
});

test('the three senders sign with the server’s secret', async () => {
  const { onRequestPost: kitPost } = await import('../functions/api/kit-broadcast.js');
  const res = await kitPost({ env: { CALENDAR_LINK_SECRET: SECRET }, data: {}, request: new Request(`${SITE}/api/kit-broadcast`, { method: 'POST', body: JSON.stringify({ preview: true, data: { blocks: [inviteBlock] }, opts: { subject: 'x' } }) }) });
  const href = appleLink((await res.json()).previewHtml);
  assert.equal(href.searchParams.get('sig'), signCalendarParams(href.searchParams, SECRET));
  for (const f of ['send-direct.js', 'send-test-email.js']) {
    const src = (await import('node:fs')).readFileSync(new URL(`../functions/api/${f}`, import.meta.url), 'utf8');
    assert.match(src, /customTemplate\(data, opts, \{ calendarSecret: env\.CALENDAR_LINK_SECRET/, f);
  }
});

test('signed links carry staff’s own words; a changed field loses them', async () => {
  const fields = { title: 'Rowan’s big day', start: '20270312T200000Z', end: '20270312T220000Z', location: "Rowan's Home, 12 Example Ln", details: 'Park on the street.', url: `${SITE}/kids/rowan-test`, uid: 'reveal-rowan-test-20270312@sunshineonaranneyday.com', reveal: 'rowan-test' };
  const href = calendarIcsUrl(fields, { secret: SECRET });
  const query = new URL(href).search.slice(1);
  const signedEnv = { ...env, CALENDAR_LINK_SECRET: SECRET };
  const { field } = await ics(query, signedEnv);
  assert.equal(field('SUMMARY'), 'Rowan’s big day');
  assert.equal(field('DESCRIPTION'), 'Park on the street.');

  // Tampered: no longer signed, so only what the site knows (it is still a real reveal)
  const tampered = new URLSearchParams(query);
  tampered.set('details', 'Pay at https://evil.example');
  const t = await ics(tampered.toString(), signedEnv);
  assert.equal(t.field('SUMMARY'), "Rowan's Reveal Day");
  assert.doesNotMatch(t.text, /evil/);

  // A made-up invite with a made-up signature: 404
  const fake = new URLSearchParams({ title: 'Free money', start: '20270101T150000Z', end: '20270101T160000Z', sig: 'a'.repeat(64) });
  await refused(fake.toString(), signedEnv);
  // The secret removed later: signed links fall back to matching
  assert.equal((await get(query, env)).status, 200);
});

test('the email’s link: signed with the secret, the reveal lookup without it, none for neither', () => {
  assert.equal(calendarIcsUrl({ title: 'x', start: '20270312T200000Z', end: '20270312T220000Z', reveal: 'rowan-test' }), `${SITE}/api/calendar.ics?reveal=rowan-test`);
  assert.equal(calendarIcsUrl({ event: 'test-gala' }), `${SITE}/api/calendar.ics?event=test-gala`);
  assert.equal(calendarIcsUrl({ title: 'x', start: '20270312T200000Z', end: '20270312T220000Z' }), '');
  assert.match(calendarIcsUrl({ title: 'x', start: '20270312T200000Z', end: '20270312T220000Z' }, { secret: SECRET }), /&sig=[0-9a-f]{64}$/);
  // The signature covers every field, each in its place
  const a = signCalendarParams(new URLSearchParams({ title: 'a', location: 'b' }), SECRET);
  const b = signCalendarParams(new URLSearchParams({ title: 'a\nlocation=b' }), SECRET);
  assert.notEqual(a, b);
});

test('the plain-JS HMAC-SHA256 matches Node’s', () => {
  for (const [k, m] of [['', ''], [SECRET, 'v1\ntitle=a'], ['k'.repeat(100), 'é'.repeat(500)], ['s', 'a'.repeat(55)], ['s', 'a'.repeat(64)]]) {
    assert.equal(hmacSha256Hex(k, m), createHmac('sha256', k).update(m).digest('hex'));
  }
});

test('a stale reveal cache is refreshed from JobTread at most a few times an hour', async () => {
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'reveals'").bind(JSON.stringify({ reveals: [REVEAL], updatedAt: '2026-01-01T00:00:00Z' })).run();
  const jt = { ...env, JOBTREAD_GRANT_KEY: 'grant_test' };
  await ics('reveal=rowan-test', jt);
  assert.equal(jobtreadCalls, 0, 'a known reveal needs no refresh');
  for (let i = 0; i < 10; i++) await refused(`reveal=unknown-${i}`, jt);
  assert.ok(jobtreadCalls >= 1 && jobtreadCalls <= 4, `refreshed ${jobtreadCalls} times`);
});

test('event times as staff write them', () => {
  assert.deepEqual(parseEventTime('6:00 to 11:00 p.m.'), { start: '18:00', end: '23:00' });
  assert.deepEqual(parseEventTime('7:00 AM'), { start: '07:00', end: null });
  assert.deepEqual(parseEventTime('11 a.m. - 2 p.m.'), { start: '11:00', end: '14:00' });
  assert.deepEqual(parseEventTime('11:30 to 1:30 pm'), { start: '11:30', end: '13:30' });
  assert.deepEqual(parseEventTime('18:30'), { start: '18:30', end: null });
  assert.equal(parseEventTime('All day'), null);
  assert.equal(parseEventTime(''), null);
});
