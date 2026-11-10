/**
 * /live/'s Coming up rows: drawn in the visitor's own time zone (at the edge, from request.cf.timezone, and in the
 * browser), the same rows from both so nothing moves after load, and a calendar link that works with no script.
 * Run: node --test tests/live-hero-rows.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

const load = (entry) => import(`data:text/javascript,${encodeURIComponent(buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', packages: 'external' }).outputFiles[0].text)}`);
const { heroRowsHtml, rowsSignature, kidFeed, afterLine } = await load('src/utils/upcoming-rows.ts');
const { visitorZone, drawable, addAfterLine } = await load('functions/live/[[path]].js');

const max = { slug: 'max', name: 'Max', confirmed: true, date: '2026-11-20', time: '16:00', startsAt: '2026-11-20T21:00:00.000Z', image: null, kidUrl: '/kids/max/', liveUrl: '/live/max/', rooms: [] };
const colin = { slug: 'colin', name: 'Colin', confirmed: false, window: { part: 'early', month: '2026-12', through: '2026-12-10', label: 'early December' }, image: null, kidUrl: '/kids/colin/', liveUrl: '/live/colin/', rooms: [] };

test('the rows say the time where the visitor is, with its zone', () => {
  assert.match(heroRowsHtml([max], 'America/New_York'), /4:00 PM EST/);
  assert.match(heroRowsHtml([max], 'America/Los_Angeles'), /1:00 PM PST/);
  // A tentative reveal has no time to move
  assert.match(heroRowsHtml([colin], 'America/Los_Angeles'), /Early December/);
});

test('the signature changes with the zone, so a browser elsewhere redraws, and matches when the edge drew it in the same one', () => {
  assert.notEqual(rowsSignature([max], 'America/New_York'), rowsSignature([max], 'America/Chicago'));
  assert.equal(rowsSignature([max], 'America/Chicago'), rowsSignature([max], 'America/Chicago'));
  // The reveals part is the same whatever the zone (LivePage compares it to tell the build's rows from the edge's)
  const reveals = (sig) => sig.slice(sig.indexOf('|') + 1);
  assert.equal(reveals(rowsSignature([max], 'America/New_York')), reveals(rowsSignature([max], 'Europe/London')));
});

test('with no script, each row\'s Add is the child\'s calendar feed', () => {
  assert.equal(kidFeed('max'), 'webcal://sunshineonaranneyday.com/api/reveals.ics?kid=max');
  const html = heroRowsHtml([max], 'America/New_York');
  assert.match(html, /<button class="hnx-add" type="button" data-invite="max"/);
  assert.match(html, /<a class="hnx-add hnx-add--feed" href="webcal:\/\/sunshineonaranneyday\.com\/api\/reveals\.ics\?kid=max" aria-label="Add Max’s reveal to your calendar">/);
});

test('the edge takes Cloudflare\'s zone for the visitor only when it is a real one', () => {
  assert.equal(visitorZone({ cf: { timezone: 'America/Denver' } }), 'America/Denver');
  assert.equal(visitorZone({ cf: { timezone: 'Not/AZone' } }), 'America/New_York');
  assert.equal(visitorZone({ cf: {} }), 'America/New_York');
  assert.equal(visitorZone({}), 'America/New_York');
});

test('the edge draws only reveals a row can say something about', () => {
  const list = drawable([max, colin, { slug: 'Bad Slug', name: 'x', confirmed: true, date: '2026-11-20' }, { slug: 'nodate', name: 'y', confirmed: true }, null]);
  assert.deepEqual(list.map((r) => r.slug), ['max', 'colin']);
  assert.deepEqual(drawable(null), []);
});

test('the line naming the reveals after this one: written the same by the page and the edge, in the visitor’s zone', async () => {
  const dylan = { ...max, slug: 'dylan-2026', name: 'Dylan', date: '2026-11-18', startsAt: '2026-11-18T21:00:00.000Z' };
  assert.equal(afterLine([dylan, max, colin], 'dylan-2026', '', 'America/New_York'), 'After Dylan: Max on Friday, November 20 and Colin in early December.');
  assert.equal(afterLine([max, colin], 'dylan-2026', 'Dylan', 'America/New_York'), 'After Dylan: Max on Friday, November 20 and Colin in early December.', 'a name the schedule doesn’t have');
  assert.equal(afterLine([dylan], 'dylan-2026', '', 'America/New_York'), '', 'nothing after it: no line');
  assert.equal(afterLine([dylan, max], '', '', 'America/New_York'), '', 'no reveal on the page: no line');
  // A late reveal in the east is the day before on the west coast
  const late = { ...max, startsAt: '2026-11-21T03:30:00.000Z', date: '2026-11-20' };
  assert.match(afterLine([dylan, late], 'dylan-2026', '', 'America/Los_Angeles'), /Max on Thursday, November 19|Max on Friday, November 20/);
  // The edge writes it into the hero and shows the line
  const page = new Response('<section id="live-hero"><p class="hero-next" data-live="next-line" hidden><span data-live="next-text"></span> <a href="#up-next">See every reveal</a></p></section>', { headers: { 'content-type': 'text/html' } });
  if (typeof HTMLRewriter === 'undefined') return; // Node has no HTMLRewriter (the Workers runtime does)
  const html = await addAfterLine(page, 'After Dylan: Max on Friday, November 20.').text();
  assert.match(html, /<p class="hero-next" data-live="next-line"><span data-live="next-text">After Dylan: Max on Friday, November 20\.<\/span>/);
});

