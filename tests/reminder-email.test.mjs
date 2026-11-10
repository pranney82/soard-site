/**
 * The reveal emails the public gets. Each test here is something that was
 * wrong on Nov 5 2026: a 600px table that cut every line off on a phone, a
 * photo address real sends couldn't load (test sends had no photo at all, so
 * no test could show it), raw &#39; in the plain text, sentences run together,
 * and promises of notes Settings had switched off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmEmail, reminderEmail, reminderPlan, welcomeEmail, whenParts } from '../functions/api/_broadcast-notify.js';
import { reminderArgs } from '../functions/api/_broadcast.js';

const FULL = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/1788202617604-dylanSOARD-23.jpeg/public';
const FACE = 'w=1200,h=760,fit=cover,gravity=face,q=85';
const state = { kidName: 'Dylan', kidSlug: 'dylan-2026', scheduledAt: '2026-11-18T21:00:00.000Z', image: FULL, liveUrl: 'https://sunshineonaranneyday.com/live/dylan-2026/', url: 'https://sunshineonaranneyday.com/live/dylan-2026/' };
const config = { timezone: 'America/New_York', reminders: { enabled: true, hoursBefore: [24, 1] } };
const KINDS = ['scheduled', 'moved', 'day', 'hour', 'live', 'replay'];
const mail = (kind, extra = {}, cfg = config) => reminderEmail({ ...reminderArgs(state, kind, cfg), unsubscribeUrl: 'https://sunshineonaranneyday.com/api/reminders?unsubscribe=t', now: Date.parse('2026-11-17T17:00:00Z'), ...extra });

test('every kind fits a phone: the card is fluid, with no fixed width for a phone to overflow', () => {
  for (const kind of KINDS) {
    const { html } = mail(kind);
    const card = html.match(/<table[^>]*class="card"[^>]*>/)[0];
    assert.match(card, /width:100%/, kind);
    assert.match(card, /max-width:600px/, kind);
    assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/, kind);
  }
});

test('the photo is the same in every send, and it loads: cropped to the face, from a full address or an id', () => {
  const full = reminderArgs(state, 'day', config).image;
  assert.equal(full, `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/1788202617604-dylanSOARD-23.jpeg/${FACE}`);
  assert.equal(reminderArgs({ ...state, image: 'kids/dylan-2026/a.jpeg' }, 'day', config).image, `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/dylan-2026/a.jpeg/${FACE}`);
  assert.equal(reminderArgs({ ...state, image: null }, 'day', config).image, null);
  // The bug: one address nested inside another
  assert.equal((full.match(/https:/g) || []).length, 1);
  for (const kind of KINDS) assert.ok(mail(kind).html.includes(full.replace(/&/g, '&amp;')), kind);
});

test('no photo, no hole: the email still reads', () => {
  const { html } = mail('day', { image: null });
  assert.doesNotMatch(html, /<img[^>]+kids\//);
  assert.match(html, /Wednesday, November 18/);
});

test('every kind has the official logo, one way to stop, and says who it is about', () => {
  for (const kind of KINDS) {
    const { html, subject } = mail(kind);
    assert.match(html, /brand-logo-dark-bg-tagline-display/, kind);
    assert.match(html, /Stop these reminders/, kind);
    assert.match(html, /unsubscribe=t/, kind);
    assert.match(subject, /Dylan’s/, kind);
    assert.match(html.match(/<h1[\s\S]*?<\/h1>/)[0] + html.match(/<p class="muted"[\s\S]*?<\/p>/)[0], /Dylan/, kind);
  }
});

test('the closer the reveal, the shorter the email: calendars only while they help', () => {
  const buttons = (m) => (m.html.match(/calendar\.ics\?reveal=dylan-2026/g) || []).length;
  assert.equal(buttons(mail('scheduled')), 3);
  assert.equal(buttons(mail('moved')), 3);
  assert.equal(buttons(mail('day')), 3);
  assert.equal(buttons(mail('hour')), 0);
  assert.equal(buttons(mail('live')), 0);
  assert.equal(buttons(mail('replay')), 0);
  assert.equal(buttons(mail('scheduled', { kidSlug: null })), 0);
  assert.ok(mail('live').html.length < mail('scheduled').html.length);
});

test('the day and time are words, near the top, and the hour email leads with the time', () => {
  const top = (m) => m.html.slice(0, m.html.indexOf('</h1>'));
  assert.match(top(mail('scheduled')), /Wed, Nov 18/);
  assert.match(top(mail('day')), /Tomorrow · Wed, Nov 18/);
  assert.match(top(mail('hour')), /We go live at 4:00\u00a0PM\u00a0EST/);
  assert.match(mail('day').html, /Wednesday, November 18<\/p>/);
  assert.match(mail('day', { now: Date.parse('2026-11-18T14:00:00Z') }).html, /Today is Dylan’s reveal day/);
});

test('whenParts follows the broadcast\'s time zone across the date line', () => {
  assert.deepEqual(whenParts('2026-11-19T02:00:00.000Z', 'America/New_York'), { day: 'Wednesday, November 18', short: 'Wed, Nov 18', time: '9:00 PM EST' });
  assert.deepEqual(whenParts(null), { day: '', short: '', time: '' });
});

test('plain text reads like the email: no markup, no entities, paragraphs apart', () => {
  for (const kind of KINDS) {
    const { text } = mail(kind);
    assert.doesNotMatch(text, /&#|&amp;|&quot;|<[a-z/]/i, kind);
    assert.doesNotMatch(text, /[a-z.]\.[A-Z]/, kind);
    assert.doesNotMatch(text, /\n{3,}/, kind);
    assert.doesNotMatch(text, /undefined|null|false/, kind);
    assert.match(text, /Stop these reminders: https/, kind);
  }
  assert.match(mail('scheduled').text, /Google: https.*app=google/);
});

test('it only promises the notes Settings has on', () => {
  const said = (hours) => mail('scheduled', {}, { ...config, reminders: { enabled: true, hoursBefore: hours } }).text;
  assert.match(said([24, 1]), /again the day before and an hour before we go live/);
  assert.match(said([24]), /again the day before\./);
  assert.match(said([1]), /again an hour before we go live\./);
  assert.doesNotMatch(said([]), /email you again/);
  assert.equal(reminderPlan([24, 1]), 'when it gets a date, the day before, an hour before, when we go live, and when the replay is up');
  assert.equal(reminderPlan([1], { dated: true }), 'an hour before, when we go live, and when the replay is up');
});

test('Kit\'s copy is for the list: its own footer, Kit\'s unsubscribe, and no promise of notes they never asked for', () => {
  const { html, text } = mail('scheduled', { unsubscribeUrl: '{{ unsubscribe_url }}', list: true });
  assert.match(html, /href="\{\{ unsubscribe_url \}\}"/);
  assert.match(html, /subscribed to updates/);
  assert.doesNotMatch(html, /email you again|Stop these reminders/);
  assert.match(text, /Sign up on the reveal page/);
  assert.match(text, /Unsubscribe: \{\{ unsubscribe_url \}\}/);
  // A Kit draft can sit for weeks: no sign-up offer while the form is off
  const off = reminderEmail({ ...reminderArgs(state, 'scheduled', { ...config, reminders: { enabled: false, hoursBefore: [] } }), unsubscribeUrl: 'u', list: true });
  assert.doesNotMatch(off.text, /Sign up/);
});

test('calendar buttons save something to watch, not an invitation to the house', () => {
  const { html, text } = mail('scheduled');
  assert.match(text, /Google: https:\/\/\S+reveal=dylan-2026&watch=1&app=google/);
  assert.match(text, /Apple: https:\/\/\S+reveal=dylan-2026&watch=1\n/);
  assert.match(html, /reveal=dylan-2026&amp;watch=1&amp;app=outlook/);
});

test('two kids read right: "Remi & Nico first see", escaped in the HTML, plain in the text', () => {
  const m = mail('day', { kidName: 'Remi & Nico', kidSlug: 'remi-nico' });
  assert.match(m.text, /Remi & Nico first see the finished room/);
  assert.match(m.html, /Remi &amp; Nico first see the finished room/);
  assert.doesNotMatch(mail('day').text, /first see /);
});

test('with no kid named, a finished reveal is not "the next" one', () => {
  const none = { kidName: null, kidSlug: null };
  assert.equal(mail('replay', none).subject, 'Watch the replay: the room reveal');
  assert.match(mail('replay', none).html, /Watch the reveal</);
  assert.match(mail('live', none).html, /The reveal is live</);
  assert.equal(mail('hour', none).subject, 'One hour to go: the next reveal');
});

test('a moved date says what to do with the old one', () => {
  assert.match(mail('moved').text, /Delete that one from your calendar\. We’ll email you again/);
  assert.doesNotMatch(mail('scheduled').text, /Delete/);
});

test('Outlook holds the width and spaces the buttons; iOS leaves the date alone', () => {
  const { html } = mail('scheduled');
  assert.match(html, /<!--\[if mso\]><table[^>]*width="600"[^>]*align="center"><tr><td><!\[endif\]-->\s*<table[^>]*class="card"/);
  assert.match(html, /<!--\[if mso\]><\/td><td style="padding-left:6px;"><!\[endif\]-->/);
  assert.match(html, /a\[x-apple-data-detectors\]\{color:inherit!important/);
  assert.equal((html.match(/<!--\[if mso\]>/g) || []).length, (html.match(/<!\[endif\]-->/g) || []).length);
});

test('a style block a client rejects takes nothing else with it: the font import stands alone', () => {
  const { html } = mail('day');
  assert.match(html, /<style>@import [^<]*<\/style>\s*<style>\s*body\{/);
});

test('a reveal with no kid named still reads', () => {
  for (const kind of KINDS) {
    const { html, text, subject } = mail(kind, { kidName: null, kidSlug: null });
    assert.doesNotMatch(subject + html + text, /null|undefined|\bfor the\b.*for the/, kind);
  }
  assert.match(mail('scheduled', { kidName: null }).subject, /the next room reveal/);
  assert.match(mail('scheduled', { kidName: null }).html, /The next reveal is coming/);
});

test('a reveal stays the family\'s: the replay offers a quiet button and no totals', () => {
  const { html } = mail('replay');
  assert.match(html, /\/donate\/"/);
  assert.doesNotMatch(html, /\$\d|raised|gifts?\b/i);
});

test('the words follow the site\'s rules: no em dashes, no family address', () => {
  for (const kind of KINDS) {
    const { html, text } = mail(kind);
    assert.doesNotMatch(html + text, /—/, kind);
    assert.doesNotMatch(html + text, /\b\d{1,5} [A-Z][a-z]+ (St|Rd|Ave|Dr|Ln|Way|Ct)\b/, kind);
  }
});

test('a Kit-sized email: well under the 102KB Gmail clips at, and names escape', () => {
  for (const kind of KINDS) assert.ok(mail(kind).html.length < 20_000, kind);
  const { html } = mail('day', { kidName: '<b>Max</b>' });
  assert.doesNotMatch(html, /<b>Max/);
});

test('the confirmation is one job: one button, what they\'ll hear, and how to ignore it', () => {
  const m = confirmEmail({ confirmUrl: 'https://x.test/c?a=1&b=2', kidName: 'Dylan', hours: [24] });
  assert.equal(m.subject, 'Confirm your reminders for Dylan’s reveal');
  assert.equal(m.html.match(/<h1[^>]*>([^<]+)/)[1], 'Confirm your reminders');
  assert.match(m.text, /then once more on the page that opens/);
  assert.match(m.html, /href="https:\/\/x\.test\/c\?a=1&amp;b=2"/);
  assert.match(m.html, /class="btn-big"/);
  assert.match(m.text, /Dylan’s room reveal: when it gets a date, the day before, when we go live, and when the replay is up/);
  assert.match(confirmEmail({ confirmUrl: 'u', kidName: 'Dylan', hours: [24], dated: true }).text, /Dylan’s room reveal: the day before, when/);
  assert.doesNotMatch(m.text, /an hour before|&#/);
  assert.match(m.text, /Ignore this email/);
  assert.match(confirmEmail({ confirmUrl: 'u', kidName: null }).text, /our live room reveals: when it gets a date/);
});

test('the welcome: on the list already, what they\'ll hear, the live page, and a Stop for anyone who didn\'t ask', () => {
  const stopUrl = 'https://sunshineonaranneyday.com/api/reminders?unsubscribe=tok&x=1';
  const m = welcomeEmail({ stopUrl, kidName: 'Dylan', kidSlug: 'dylan-2026', hours: [24, 1] });
  assert.equal(m.subject, 'You’re on the list for Dylan’s reveal');
  assert.equal(m.html.match(/<h1[^>]*>([^<]+)/)[1], 'You’re on the list');
  assert.match(m.text, /Dylan’s room reveal: when it gets a date, the day before, an hour before, when we go live, and when the replay is up\. Nothing else, ever\./);
  assert.match(m.html, /class="btn-big"/);
  assert.match(m.html, /<a href="https:\/\/sunshineonaranneyday\.com\/live\/dylan-2026\/"/, 'the big button is Dylan’s live page');
  assert.match(m.html, /href="https:\/\/sunshineonaranneyday\.com\/api\/reminders\?unsubscribe=tok&amp;x=1"[^>]*>Stop these reminders/);
  assert.match(m.text, /Stop these reminders: https:\/\/sunshineonaranneyday\.com\/api\/reminders\?unsubscribe=tok&x=1/);
  assert.doesNotMatch(m.text, /confirm|tap below|once more/i, 'nothing left to do');
  assert.doesNotMatch(`${m.subject} ${m.text}`, /—/, 'no em dashes');
  const all = welcomeEmail({ stopUrl, kidName: null });
  assert.equal(all.subject, 'You’re on the list for every reveal');
  assert.match(all.text, /every live room reveal: when it gets a date/);
  assert.match(all.text, /See what’s coming up: https:\/\/sunshineonaranneyday\.com\/live\//);
});

test('a late signup and a same-day email promise only what can still arrive', () => {
  const at = Date.parse(state.scheduledAt);
  const H = 3600e3;
  // Two notes: no comma before "and"
  assert.equal(reminderPlan([24, 1], { dated: true, left: 45 * 60e3 }), 'when we go live and when the replay is up');
  assert.equal(reminderPlan([24, 1], { dated: true, left: 7 * H }), 'an hour before, when we go live, and when the replay is up');
  const sameDay = mail('scheduled', { now: at - 7 * H }).text;
  assert.match(sameDay, /We’ll email you again an hour before we go live\./);
  assert.doesNotMatch(sameDay, /the day before/);
  assert.doesNotMatch(mail('scheduled', { now: at - 30 * 60e3 }).text, /email you again/);
  assert.doesNotMatch(confirmEmail({ confirmUrl: 'u', kidName: 'Dylan', dated: true, left: 45 * 60e3 }).text, /day before|hour before/);
});

test('signed like the Kit emails: the team as plushies, then The SOARD Team and Sunshine on a Ranney Day', async () => {
  const { TEAM_PICTURE } = await import('../functions/api/_reveal-invite-email.js');
  for (const kind of ['scheduled', 'moved', 'day', 'replay']) {
    const { html, text } = mail(kind);
    const pic = html.indexOf(TEAM_PICTURE);
    assert.ok(pic > -1, `${kind}: the team picture`);
    assert.match(html, /alt="The SOARD team"/);
    assert.ok(html.indexOf('The SOARD Team</p>') > pic && html.indexOf('Sunshine on a Ranney Day</p>') > pic, `${kind}: the names under the picture`);
    assert.match(text, /The SOARD Team\nSunshine on a Ranney Day/);
  }
  // The short ones (an hour to go, we're live) have one job and no sign-off
  for (const kind of ['hour', 'live']) assert.equal(mail(kind).html.indexOf(TEAM_PICTURE), -1, kind);
});
