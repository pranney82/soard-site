/**
 * The floating reveal banner: when it shows and what it says (src/utils/live-banner.ts)
 * Run: node --test tests/live-banner.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const code = transformSync(readFileSync('src/utils/live-banner.ts', 'utf8'), { loader: 'ts', format: 'esm' }).code;
const { bannerStage, bannerWords, revealsAfter, dismissValue, sitsOn, pageShowsIt, revealIsToday, replayOverdue, easternDay, remindersUsable, remindPromise, runningLate, MAIN_CONTROLS, PICTURES, BANNER_LEAD_DAYS } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const H = 3600e3, D = 24 * H, M = 60e3;
// Wednesday, November 4, 2026, 3:00 PM on the viewer's own clock
const now = new Date(2026, 10, 4, 15, 0).getTime();
const local = (day, hour = 16, min = 0) => new Date(2026, 10, day, hour, min).toISOString();
const planned = (o = {}) => ({ id: 'live-1', live: false, upcoming: true, replay: false, kidSlug: 'dylan-2026', kidName: 'Dylan', title: "Dylan's room reveal", message: '', scheduledAt: local(11), ...o });
const reveal = (slug, name, startsAt, o = {}) => ({ slug, name, startsAt, time: '16:00', ...o });
const say = (s, next = [], o = {}) => bannerWords(s, bannerStage(s, now), next, { now, ...o });

test('a planned reveal shows from a week out, not before', () => {
  assert.equal(BANNER_LEAD_DAYS, 7);
  assert.equal(bannerStage(planned({ scheduledAt: local(18) }), now), null, 'two weeks out: nothing yet');
  assert.equal(bannerStage(planned({ scheduledAt: new Date(now + 7 * D + M).toISOString() }), now), null, 'a minute past a week');
  assert.equal(bannerStage(planned({ scheduledAt: new Date(now + 7 * D).toISOString() }), now), 'upcoming', 'exactly a week');
  assert.equal(bannerStage(planned({ scheduledAt: local(5) }), now), 'upcoming', 'tomorrow is not reveal day');
  assert.equal(bannerStage(planned({ scheduledAt: local(4, 18) }), now), 'today');
  assert.equal(bannerStage(planned({ scheduledAt: local(4, 14) }), now), 'today', 'past its start time but still planned');
});

test('live and replay always show; nothing planned shows nothing', () => {
  assert.equal(bannerStage(planned({ live: true, upcoming: false, scheduledAt: local(30) }), now), 'live');
  assert.equal(bannerStage(planned({ replay: true, upcoming: false, player: { kind: 'replay' }, scheduledAt: local(30) }), now), 'replay');
  assert.equal(bannerStage({ ...planned(), upcoming: false }, now), null);
  assert.equal(bannerStage(null, now), null);
  assert.equal(bannerStage(planned({ scheduledAt: null }), now), 'upcoming', 'a planned reveal with no time still shows');
});

test('"Reveal day" only on the day itself', () => {
  assert.equal(say(planned()).label, 'Coming up');
  assert.equal(say(planned({ scheduledAt: local(5) })).label, 'Coming up');
  const day = say(planned({ scheduledAt: local(4, 18) }));
  assert.equal(day.label, 'Reveal day');
  assert.match(day.msg, /^Dylan’s room reveal goes live today at 6:00\sPM \S+\.$/, 'no ticking count: this is read aloud');
});

test('the day reads short inside the week and says the date a week off', () => {
  assert.match(say(planned({ scheduledAt: local(9) })).msg, /goes live Monday at 4:00\sPM \S+\.$/);
  assert.match(say(planned({ scheduledAt: local(5) })).msg, /goes live tomorrow at 4:00\sPM \S+\.$/);
  assert.match(say(planned({ scheduledAt: local(10) })).msg, /goes live Tuesday, November 10 at 4:00\sPM \S+\.$/);
});

test('reveals close together are all named, soonest first', () => {
  const dylan = planned({ scheduledAt: local(6) });
  const colin = reveal('colin', 'Colin', local(7));
  const max = reveal('max', 'Max', local(8));
  const lizzie = reveal('lizzie', 'Lizzie', local(9));
  const self = reveal('dylan-2026', 'Dylan', local(6));
  const before = reveal('earlier', 'Earlier', local(5));
  const past = reveal('past', 'Past', local(3));
  const far = reveal('far', 'Far', local(20));

  assert.deepEqual(revealsAfter(dylan, [self, far, past, before, max, colin], now).map((r) => r.name), ['Colin', 'Max'], 'not itself, one before it, one past, or one outside the week');
  assert.equal(say(dylan, [max]).next, 'Then Max’s on Sunday.');
  assert.equal(say(dylan, [colin, max]).next, 'Then Colin’s on Saturday and Max’s on Sunday.');
  assert.equal(say(dylan, [colin, max, lizzie]).next, 'Then 3 more after that.');
  assert.equal(say(dylan, []).next, '');
  assert.equal(say(dylan, [reveal('x', 'Xavier', local(10))]).next, 'Then Xavier’s on Tuesday, November 10.', 'a week off says the date');
});

test('the second reveal on the same day or the next day reads right', () => {
  const dylan = planned({ scheduledAt: local(4, 16) });
  assert.match(say(dylan, [reveal('max', 'Max', local(4, 18))]).next, /^Then Max’s at 6:00\sPM \S+\.$/);
  assert.equal(say(dylan, [reveal('max', 'Max', local(5))]).next, 'Then Max’s tomorrow.');
});

test('a replay points at the next reveal; live points at nothing else', () => {
  const replay = planned({ replay: true, upcoming: false, player: { kind: 'replay' } });
  const max = reveal('max', 'Max', local(6));
  assert.equal(say(replay).msg, 'Missed Dylan’s reveal? Watch it any time.');
  assert.match(say(replay, [max]).next, /^Next: Max’s on Friday at 4:00\sPM \S+\.$/);
  assert.match(say(replay, [max, reveal('colin', 'Colin', local(7))]).next, /^Next: Max’s on Friday at 4:00\sPM \S+ and 1 more\.$/);
  assert.deepEqual(revealsAfter(replay, [max], now).map((r) => r.slug), ['max'], 'a replay looks ahead from now, not from its own past date');
  const live = say(planned({ live: true, upcoming: false, message: "Watch Dylan's room reveal live" }), [max]);
  assert.equal(live.label, 'Live now');
  assert.equal(live.next, '');
  assert.equal(live.cta, 'Watch →');
});

test('a reveal with no time is a date, not midnight Eastern', () => {
  // What /api/reveals really sends for Max on Sunday with no time: midnight Eastern, date and time null
  const max = { slug: 'max', name: 'Max', startsAt: '2026-11-08T05:00:00.000Z', date: '2026-11-08', time: null };
  assert.equal(say(planned({ scheduledAt: local(6) }), [max]).next, 'Then Max’s on Sunday.');
  assert.match(say(planned({ replay: true, upcoming: false, player: {} }), [max]).next, /^Next: Max’s on Sunday\.$/);
  // Same day as a timed reveal: still named, and after it
  const same = { ...max, startsAt: '2026-11-06T05:00:00.000Z', date: '2026-11-06' };
  const dylan = planned({ scheduledAt: local(6, 16) });
  assert.deepEqual(revealsAfter(dylan, [same], now).map((r) => r.slug), ['max']);
  assert.equal(say(dylan, [same]).next, 'Then Max’s on Friday.', 'no made-up time');
});

test('two reveals at the same moment are both named', () => {
  const dylan = planned({ scheduledAt: local(6) });
  const max = reveal('max', 'Max', local(6));
  assert.deepEqual(revealsAfter(dylan, [max], now).map((r) => r.slug), ['max']);
  assert.match(say(dylan, [max]).next, /^Also Max’s at 4:00\sPM \S+\.$/);
});

test('a name ending in s, and the sentences stay English whatever the browser language', () => {
  assert.match(say(planned({ kidName: 'James' })).msg, /^James’ room reveal/);
  assert.equal(say(planned({ kidName: 'James', replay: true, upcoming: false, player: {} })).msg, 'Missed James’ reveal? Watch it any time.');
  assert.match(readFileSync('src/utils/live-banner.ts', 'utf8'), /const LOCALE = 'en-US'/);
  assert.doesNotMatch(readFileSync('src/utils/live-banner.ts', 'utf8'), /DateTimeFormat\(undefined/);
});

test('past its start time it says starting soon, not a time gone by', () => {
  const late = planned({ scheduledAt: new Date(now - 0.25 * H).toISOString() });
  assert.equal(bannerStage(late, now), 'today');
  assert.equal(say(late).msg, 'Dylan’s room reveal is starting soon.');
  assert.equal(say(late).cta, 'Watch →');
  // Still waiting past midnight: never reads as next week
  const overnight = new Date(2026, 10, 5, 0, 20).getTime();
  const s = planned({ scheduledAt: local(4, 23, 55) });
  assert.equal(bannerStage(s, overnight), 'today');
  assert.equal(bannerWords(s, 'today', [], { now: overnight }).msg, 'Dylan’s room reveal is starting soon.');
});

test('the button only offers what the page really does', () => {
  assert.equal(say(planned(), [], { remindersOn: true }).cta, 'Remind me →');
  const off = say(planned(), [], { remindersOn: false });
  assert.equal(off.cta, 'Add to calendar →');
  assert.doesNotMatch(`${off.cta} ${off.aria}`, /remind/i);
  // Inside the last half hour the page is the starting-soon screen, with neither on it
  const soon = planned({ scheduledAt: new Date(now + 12 * M).toISOString() });
  assert.equal(say(soon, [], { remindersOn: true }).cta, 'Watch →');
  assert.equal(say(soon, [], { remindersOn: false }).cta, 'Watch →');
});

test('"Replay ready" waits for a replay that exists', () => {
  const over = planned({ replay: true, upcoming: false, source: 'stream', player: null });
  assert.equal(bannerStage(over, now), 'ended');
  const w = say(over, [reveal('max', 'Max', local(6))]);
  assert.equal(w.label, 'Just ended');
  assert.equal(w.msg, 'Dylan’s room reveal just ended. The replay is on its way.');
  assert.match(w.next, /^Next: Max’s on Friday/);
  assert.doesNotMatch(`${w.label} ${w.msg} ${w.cta}`, /Watch/, 'nothing to watch yet');
  assert.equal(say(planned({ replay: true, upcoming: false, source: 'facebook', player: null })).msg, 'Dylan’s room reveal just ended.', 'no replay promised where none is coming');
  assert.equal(bannerStage({ ...over, player: { kind: 'replay' } }, now), 'replay');
});

test('"Just ended" stops saying so once a recording clearly isn\'t coming', () => {
  const over = (hours) => planned({ replay: true, upcoming: false, source: 'stream', player: null, endedAt: new Date(now - hours * H).toISOString() });
  assert.equal(bannerStage(over(5), now), 'ended');
  assert.equal(bannerStage(over(7), now), null);
  assert.equal(bannerStage({ ...over(60), player: {} }, now), 'replay', 'a replay still runs its full time');
  assert.equal(replayOverdue(new Date(now - 5 * H).toISOString(), now), false);
  assert.equal(replayOverdue(new Date(now - 7 * H).toISOString(), now), true);
  assert.equal(replayOverdue(null, now), false);
});

test('the promise follows the notes Settings has on', () => {
  assert.equal(remindPromise(), "We'll email you about every reveal: when it gets a date, the day before, an hour before, when we go live, and when the replay is up. Nothing else, ever.");
  assert.equal(remindPromise([24, 1], { about: 'every reveal' }), "We'll email you about every reveal: when it gets a date, the day before, an hour before, when we go live, and when the replay is up. Nothing else, ever.");
  assert.doesNotMatch(remindPromise([24]), /hour before/);
  assert.doesNotMatch(remindPromise([1]), /day before/);
  assert.match(remindPromise([]), /when it gets a date, when we go live, and when the replay is up\./);
});

test('reminders only count as on when there is a way to sign up', () => {
  assert.equal(remindersUsable({ enabled: true, email: false, push: true, pushKey: 'k' }, false), false, 'alerts only, in a browser that can\'t take them');
  assert.equal(remindersUsable({ enabled: true, email: true, push: false, pushKey: null }), true);
  assert.equal(remindersUsable({ enabled: true, email: false, push: false, pushKey: null }), false, 'on, but email not set up');
  assert.equal(remindersUsable({ enabled: true, email: false, push: true, pushKey: 'k' }), true);
  assert.equal(remindersUsable({ enabled: false, email: true, push: true, pushKey: 'k' }), false);
  assert.equal(remindersUsable(null), false);
});

test('the name screen readers and voice control get starts with what is on screen', () => {
  const w = say(planned(), [reveal('max', 'Max', local(9))], { remindersOn: false });
  assert.ok(w.aria.startsWith('Coming up. Dylan’s room reveal goes live'));
  assert.ok(w.aria.includes(w.next));
  assert.ok(w.aria.endsWith('Add to calendar.'));
});

test('hidden only where the page already shows this broadcast', () => {
  assert.equal(pageShowsIt('/live/', 'dylan-2026'), true);
  assert.equal(pageShowsIt('/live', 'dylan-2026'), true);
  assert.equal(pageShowsIt('/live/dylan-2026/', 'dylan-2026'), true);
  assert.equal(pageShowsIt('/live/dylan-2026/slate/', 'dylan-2026'), true, 'the starting-soon screen');
  assert.equal(pageShowsIt('/live/max/slate/', 'dylan-2026'), true, 'a starting-soon screen never carries it');
  assert.equal(pageShowsIt('/live/max/', 'dylan-2026'), false, 'another kid’s page says nothing about the reveal, so the banner does');
  assert.equal(pageShowsIt('/live/max/', null), false);
  assert.equal(pageShowsIt('/kids/max/', 'max'), false);
  assert.equal(pageShowsIt('/', 'max'), false);
  // A stream with no kid named on a kid's page: only that kid's on the kid's own reveal day
  const today = easternDay(now);
  assert.equal(pageShowsIt('/live/zoe/', null, [{ slug: 'zoe', date: today }], now), true);
  assert.equal(pageShowsIt('/live/zoe/', null, [{ slug: 'zoe', date: '2020-01-01' }], now), false);
  assert.equal(pageShowsIt('/live/max/', null, [{ slug: 'zoe', date: today }], now), false);
  assert.equal(revealIsToday('zoe', [{ slug: 'zoe', date: today }], now), true);
});

test('a date that can\'t be read never breaks the page', () => {
  assert.equal(say(planned({ scheduledAt: 'not a date' })).msg, 'Dylan’s room reveal.');
});

test('a broadcast with no kid still reads', () => {
  const s = planned({ kidName: null, kidSlug: null, title: null });
  assert.match(say(s).msg, /^Live room reveal goes live/);
  assert.equal(say({ ...s, upcoming: false, replay: true, player: {} }).msg, 'Missed the reveal? Watch it any time.');
});

test('closing a banner closes that news only', () => {
  const s = planned();
  const seen = new Set(['upcoming', 'today', 'live', 'ended', 'replay'].map((stage) => dismissValue(s, stage)));
  assert.equal(seen.size, 5, 'closing the countdown can never hide Live now');
  assert.notEqual(dismissValue({ id: 'a' }, 'upcoming'), dismissValue({ id: 'b' }, 'upcoming'), 'each reveal has its own');
});

test('a button counts as under the banner past a sliver of overlap; a video from the first pixel', () => {
  const pill = { left: 100, top: 100, right: 400, bottom: 180 };
  assert.equal(sitsOn(pill, { left: 150, top: 120, right: 300, bottom: 170 }), true);
  assert.equal(sitsOn(pill, { left: 0, top: 174, right: 500, bottom: 230 }), false, 'a 6px brush past the edge');
  assert.equal(sitsOn(pill, { left: 0, top: 170, right: 500, bottom: 230 }), true);
  assert.equal(sitsOn(pill, { left: 500, top: 100, right: 600, bottom: 180 }), false);
  assert.equal(sitsOn(pill, { left: 0, top: 174, right: 500, bottom: 230 }, 0), true, 'a video gets no slack');
  assert.equal(PICTURES, 'video,iframe');
});

test('the control list covers anything you can press, not just .btn', () => {
  const list = MAIN_CONTROLS.split(',');
  for (const c of ['button', 'summary', '[role="button"]', '.btn', 'a[class*="btn"]', 'a[class*="cta"]', 'select', 'textarea', 'footer a', 'video', 'iframe']) assert.ok(list.includes(c), c);
  assert.ok(!list.includes('[class*="cta"]'), 'a class match only counts on a link, never on a section called cta-…');
  assert.ok(list.includes('a[href]'), 'any link: a word in a sentence or a whole card is as pressable as a button');
});

test('none of it uses an em dash', () => {
  assert.doesNotMatch(readFileSync('src/utils/live-banner.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /—/);
});

test('a button that promises reminders or a calendar lands on them, not the top of a long page', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const coming = { id: 'a', upcoming: true, kidSlug: 'max', kidName: 'Max', scheduledAt: '2026-11-18T21:00:00.000Z' };
  assert.equal(bannerWords(coming, 'upcoming', [], { now, remindersOn: true }).anchor, '#remind');
  assert.equal(bannerWords(coming, 'upcoming', [], { now, remindersOn: false }).anchor, '#remind');
  const soon = { ...coming, scheduledAt: new Date(now + 10 * 60e3).toISOString() };
  assert.equal(bannerWords(soon, 'today', [], { now, remindersOn: true }).cta, 'Watch →');
  assert.equal(bannerWords(soon, 'today', [], { now, remindersOn: true }).anchor, '');
  assert.equal(bannerWords({ ...coming, live: true }, 'live', [], { now }).anchor, '');
  assert.equal(bannerWords({ ...coming, upcoming: false, replay: true }, 'replay', [], { now }).anchor, '');
});

test('the form only promises what can still be sent', () => {
  const H = 3600e3;
  assert.equal(remindPromise([24, 1], { about: 'Colin’s reveal', dated: true, left: 5 * 24 * H }), "We'll email you about Colin’s reveal: the day before, an hour before, when we go live, and when the replay is up. Nothing else, ever.");
  assert.match(remindPromise([24, 1], { dated: true, left: 5 * H }), /: an hour before, when we go live, and/);
  assert.doesNotMatch(remindPromise([24, 1], { dated: true, left: 5 * H }), /day before/);
  // Two notes: no comma before "and"
  assert.match(remindPromise([24, 1], { dated: true, left: 10 * 60e3 }), /: when we go live and when the replay is up\./);
  assert.match(remindPromise([24, 1], { dated: true, left: -60e3 }), /: when we go live/);
  assert.match(remindPromise(), /when it gets a date/);
});

test('a kid\'s story reads as words: no markup, no cut-off sentence', async () => {
  const src = readFileSync(new URL('../src/utils/story-lead.ts', import.meta.url), 'utf8');
  const { storyLead } = await import(`data:text/javascript;base64,${Buffer.from(transformSync(src, { loader: 'ts', format: 'esm' }).code).toString('base64')}`);
  const long = `${'Dylan loves his teachers. '.repeat(30)}`;
  assert.equal(storyLead('<p>Meet Dylan, a teenager.</p><p>Dylan lives with a rare condition.</p>'), 'Meet Dylan, a teenager.');
  assert.equal(storyLead('Plain story.\n\nSecond paragraph.'), 'Plain story.');
  assert.equal(storyLead('<p>Tom &amp; Jerry&#39;s <strong>big</strong>&nbsp;day.</p>'), "Tom & Jerry's big day.");
  assert.equal(storyLead('<p>   </p><p>Second one holds the words.</p>'), 'Second one holds the words.');
  assert.equal(storyLead(null), '');
  const cut = storyLead(`<p>${long}</p>`);
  assert.ok(cut.length <= 420);
  assert.match(cut, /teachers\.$/);
  const noStops = storyLead(`<p>${'word '.repeat(200)}</p>`);
  assert.match(noStops, /word…$/);
  assert.doesNotMatch(cut + noStops, /<|&lt;/);
  const title = storyLead(`<p>${'She raised a family here over many long years. '.repeat(7)}She has 13 great grandchildren, Ms. Glass said with a smile on her face today.</p>`, 372);
  assert.match(title, /here over many long years\.$/, 'a title is not the end of a sentence');
});

test('late is one rule: 30 minutes past the start, the words stop saying any moment', () => {
  const start = Date.parse('2026-11-18T21:00:00.000Z');
  const dylan = { id: 'a', upcoming: true, kidSlug: 'dylan', kidName: 'Dylan', scheduledAt: new Date(start).toISOString() };
  assert.equal(bannerWords(dylan, 'today', [], { now: start + 10 * 60e3 }).msg, 'Dylan’s room reveal is starting soon.');
  assert.equal(bannerWords(dylan, 'today', [], { now: start + 31 * 60e3 }).msg, 'Dylan’s room reveal is running a little late.');
  assert.equal(runningLate(dylan.scheduledAt, start + 29 * 60e3), false);
  assert.equal(runningLate(dylan.scheduledAt, start + 31 * 60e3), true);
  assert.equal(runningLate(null, start), false);
});

test('the banner keeps clear of a form’s fresh answer, as of anything you can press', () => {
  assert.ok(MAIN_CONTROLS.split(',').includes('[role="status"]:not(:empty)'));
});

test('the banner keeps clear of a reveal card (the whole card opens the story)', () => {
  assert.ok(MAIN_CONTROLS.split(',').includes('.upn-card'));
});
