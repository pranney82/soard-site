/**
 * /live/ holds still before a reveal: the server writes the hero (eyebrow, status) and puts the messages box in its
 * section as the page script would (functions/live/[[path]].js firstView, messagesInSection; src/utils/live-when.ts,
 * live-hero-text.ts). Run: node --test tests/live-first-view.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

const load = (entry) => import(`data:text/javascript,${encodeURIComponent(buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', packages: 'external' }).outputFiles[0].text)}`);
const { formatWhen, relativeUntil, revealLabel, daysUntil, dayWords } = await load('src/utils/live-when.ts');
const { plannedText, betweenText, ctasThatApply, ctaPicks } = await load('src/utils/live-hero-text.ts');
const { firstView, messagesInSection, messageHtml, pastFirst, musicThere, MUSIC_KEY } = await load('functions/live/[[path]].js');

const NOW = Date.parse('2026-11-10T15:00:00Z'); // Tuesday 10 AM Eastern
const DYLAN = '2026-11-18T21:00:00.000Z';       // Wednesday 4 PM Eastern

test('the time words in a zone: the same sentence the browser writes there', () => {
  assert.equal(formatWhen(DYLAN, 'America/New_York', NOW), 'Wednesday, November 18 at 4:00 PM EST');
  assert.equal(formatWhen(DYLAN, 'America/Los_Angeles', NOW), 'Wednesday, November 18 at 1:00 PM PST');
  assert.equal(relativeUntil(DYLAN, NOW, 'America/New_York'), 'in 8 days');
  assert.equal(revealLabel(DYLAN, 'America/New_York', NOW), 'Coming up');
  assert.equal(revealLabel(DYLAN, 'America/New_York', Date.parse('2026-11-18T13:00:00Z')), 'Reveal day');
  assert.equal(formatWhen(DYLAN, 'America/New_York', Date.parse('2026-11-18T13:00:00Z')), 'today at 4:00 PM EST');
  assert.equal(formatWhen(DYLAN, 'America/New_York', Date.parse('2026-11-17T13:00:00Z')), 'tomorrow at 4:00 PM EST');
  // A late evening reveal in the east is still "tomorrow" on the west coast's calendar, counted in its own days
  const late = '2026-11-19T03:30:00.000Z'; // 10:30 PM Eastern on the 18th, 7:30 PM Pacific on the 18th
  assert.equal(formatWhen(late, 'America/Los_Angeles', Date.parse('2026-11-17T20:00:00Z')), 'tomorrow at 7:30 PM PST');
  assert.equal(relativeUntil('2026-11-10T15:20:00Z', NOW, 'America/New_York'), 'in 20 minutes');
  assert.equal(relativeUntil('2026-11-11T09:00:00Z', NOW, 'America/New_York'), 'in 18 hours');
});

test('the starting-soon screen says the day as the live page does: "Today" only on the day itself', () => {
  const tz = 'America/New_York';
  assert.equal(daysUntil(DYLAN, tz, NOW), 8);
  assert.equal(dayWords(DYLAN, tz, NOW), 'Wednesday, November 18', 'eight days out: the date, not "Live Wednesday", which reads as this week');
  assert.equal(dayWords(DYLAN, tz, Date.parse('2026-11-17T13:00:00Z')), 'tomorrow');
  assert.equal(daysUntil(DYLAN, tz, Date.parse('2026-11-18T05:30:00Z')), 0, '12:30 AM on the day is the day');
  assert.equal(daysUntil(DYLAN, tz, Date.parse('2026-11-18T04:30:00Z')), 1, '11:30 PM the night before is not');
  // formatWhen is built from the same words
  assert.equal(formatWhen(DYLAN, tz, Date.parse('2026-11-17T13:00:00Z')), `${dayWords(DYLAN, tz, Date.parse('2026-11-17T13:00:00Z'))} at 4:00 PM EST`);
});

test('the hero before a reveal and between reveals', () => {
  assert.deepEqual(plannedText(DYLAN, 'America/New_York', NOW), { eyebrow: 'Coming up', status: 'We go live Wednesday, November 18 at 4:00 PM EST, in 8 days.' });
  assert.equal(plannedText(null, 'America/New_York', NOW).status, 'A reveal is on the calendar.');
  assert.equal(plannedText('2026-11-10T14:58:00Z', 'America/New_York', NOW).status, 'Any moment now. Stay right here.');
  const max = { slug: 'max', name: 'Max', confirmed: true, date: '2026-11-20', time: '16:00', startsAt: '2026-11-20T21:00:00.000Z', liveUrl: '/live/max/' };
  const colin = { slug: 'colin', name: 'Colin', confirmed: false, window: { label: 'early December' } };
  assert.equal(betweenText([max, colin], 'max', 'America/New_York'), "Max's reveal is Friday, November 20 at 4:00 PM EST.");
  assert.match(betweenText([max, colin], 'colin', 'America/New_York'), /^Colin's reveal is planned for early December\./);
  assert.equal(betweenText([max, colin], '', 'America/New_York'), "Next up: Max's reveal, Friday, November 20 at 4:00 PM EST.");
  assert.equal(betweenText([max], 'nobody', 'America/New_York'), '');
});

test('which view the server draws first: as the page script will', () => {
  const state = { phase: 'scheduled', kidSlug: 'dylan-2026', scheduledAt: DYLAN, broadcastId: 'b1' };
  const pub = { kidSlug: 'dylan-2026', id: 'b1' };
  const tz = 'America/New_York';
  // Dylan's page and /live/: the reveal coming up
  assert.equal(firstView({ state, pub, pageKid: 'dylan-2026', tz, now: NOW }).view, 'upcoming');
  assert.equal(firstView({ state, pub, pageKid: '', tz, now: NOW }).status, 'We go live Wednesday, November 18 at 4:00 PM EST, in 8 days.');
  // Max's page while Dylan's is scheduled: between reveals, naming Max's
  const rows = [{ slug: 'max', name: 'Max', confirmed: true, date: '2026-11-20', time: '16:00', startsAt: '2026-11-20T21:00:00.000Z' }];
  assert.deepEqual(firstView({ state, pub, pageKid: 'max', rows, tz, now: NOW }), { view: 'idle', eyebrow: null, status: "Max's reveal is Friday, November 20 at 4:00 PM EST." });
  // The watch party has its own first paint; a live reveal without a video is the script's
  assert.equal(firstView({ state, pub, pageKid: 'dylan-2026', party: { mode: 'starting' }, tz, now: NOW }), null);
  assert.equal(firstView({ state: { ...state, phase: 'live' }, pub, pageKid: 'dylan-2026', tz, now: NOW }), null);
  assert.equal(firstView({ state: { phase: 'idle' }, pub: {}, pageKid: '', rows: [], tz, now: NOW }).view, 'idle');
});

test('the messages box moves from the hero into its section, whole', () => {
  const page = '<section id="live-hero"><div class="hero-party" data-slot="hero" hidden><!--msgs-panel--><div class="msgs" data-msgs="panel" data-place="hero"><ol data-msgs="list"></ol></div><!--/msgs-panel--></div></section><section class="live-msgs" data-live-msgs hidden><div class="container" data-slot="section" data-astro-cid-x></div></section>';
  const out = messagesInSection(page);
  assert.match(out, /<div class="hero-party" data-slot="hero" hidden><\/div>/, 'the hero slot is left empty');
  assert.match(out, /<div class="container" data-slot="section" data-astro-cid-x><!--msgs-panel--><div class="msgs" data-msgs="panel"/);
  assert.equal(out.match(/data-msgs="panel"/g).length, 1, 'one box, not two');
  assert.equal(messagesInSection('<div>no markers</div>'), null);
});

test('a message is drawn as the script draws it, and never as markup', () => {
  assert.equal(messageHtml({ id: 'm1', name: 'Ana', body: 'So happy <3 & "proud"' }), '<li class="msg" data-id="m1" style="animation:none"><span class="msg__name">Ana</span><p class="msg__body">So happy &lt;3 &amp; &quot;proud&quot;</p></li>');
  assert.doesNotMatch(messageHtml({ id: 'x"><script>', name: '<b>', body: '' }), /<script>|<b>/);
});

test('the hero’s two buttons: the same rule for the server and the page', () => {
  const base = { scheduledAt: DYLAN, remindUsable: true, pageKid: 'dylan-2026', inSchedule: true, pastOnPage: true, hasPlayer: false, now: NOW };
  const picks = (f) => { const a = ctasThatApply(f); return ctaPicks(f.display, (k) => !!a[k]); };
  // Before a reveal: every reveal by email, and the calendar
  assert.deepEqual(picks({ ...base, display: 'upcoming', view: 'upcoming' }), ['cta-remind', 'cta-calendar']);
  // Reminders off: the calendar and Share
  assert.deepEqual(picks({ ...base, display: 'upcoming', view: 'upcoming', remindUsable: false }), ['cta-calendar', 'cta-share']);
  // Past its time: no reminders, no calendar
  assert.deepEqual(picks({ ...base, display: 'upcoming', view: 'upcoming', now: Date.parse(DYLAN) + 60e3 }), ['cta-share', 'cta-donate']);
  // Max's page between reveals: email, and his own invite
  assert.deepEqual(picks({ ...base, pageKid: 'max', display: 'idle', view: 'idle' }), ['cta-remind', 'cta-calendar']);
  // /live/ between reveals: email, then past reveals
  assert.deepEqual(picks({ ...base, pageKid: '', inSchedule: false, display: 'idle', view: 'idle' }), ['cta-remind', 'cta-past']);
});

test('between reveals, past reveals go before the story in the page itself, so a page that arrives in pieces is drawn in order', () => {
  const html = '<div class="live-page"><section id="live-hero"></section><!--live-body--><section class="live-body"></section><div class="live-next"></div><!--live-past--><div class="live-past"><section id="past-reveals"></section></div><!--/live-past--></div>';
  const out = pastFirst(html);
  assert.ok(out.indexOf('class="live-past"') < out.indexOf('class="live-body"'));
  assert.equal(out.match(/class="live-past"/g).length, 1);
  assert.equal(pastFirst('<div>none</div>'), null);
});

test('the starting-soon screen asks for its music only when the track is in the files bucket, asked at most every 5 minutes', async () => {
  let asked = 0;
  const env = (there) => ({ FILES: { head: async (key) => { asked++; assert.equal(key, MUSIC_KEY); return there ? { key } : null; } } });
  const t0 = Date.parse('2026-11-11T15:00:00Z');
  assert.equal(await musicThere(env(false), t0), false, 'no track: the screen goes out without its music');
  assert.equal(await musicThere(env(true), t0 + 60e3), false, 'remembered for 5 minutes');
  assert.equal(asked, 1);
  assert.equal(await musicThere(env(true), t0 + 6 * 60e3), true, 'an upload is seen within 5 minutes');
  assert.equal(await musicThere({}, t0), true, 'no bucket bound: left to the screen');
});

