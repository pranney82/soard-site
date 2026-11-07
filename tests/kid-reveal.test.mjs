/**
 * A kid's reveal day put in before the page arrives (functions/_kid-reveal.js):
 * the same words the page script would write, so nothing moves after load.
 * Run: node --test tests/kid-reveal.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

// The module imports the page's own TypeScript helpers: bundle it for node
const code = buildSync({ entryPoints: ['functions/_kid-reveal.js'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].text;
const { badgeText, revealLine, upcomingReveals } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const max = { slug: 'max', name: 'Max', confirmed: true, date: '2026-11-20', time: '16:00', startsAt: '2026-11-20T21:00:00.000Z', liveUrl: '/live/max/', window: null };
const colin = { slug: 'colin', name: "Colin O'Neil", confirmed: false, date: null, time: null, startsAt: null, liveUrl: '/live/colin/', window: { part: 'early', month: '2026-12', through: '2026-12-10', label: 'early December' } };

test('the badge says what the page script says', () => {
  assert.equal(badgeText(max), 'Reveal Nov 20');
  assert.equal(badgeText(colin), 'Reveal early Dec');
});

test('the reveal line: the day to the live page, and Add to calendar with the invite details', () => {
  const html = revealLine(max);
  assert.match(html, /^<div class="hero__reveal"><a class="hero__reveal-day" href="\/live\/max\/"/);
  assert.match(html, />Reveal day: Fri, Nov 20 at 4:00 PM ET<\/a>/);
  assert.match(html, /aria-label="Max&#39;s reveal day is Friday, November 20 at 4:00 PM ET\. Watch it live\."/);
  assert.match(html, /<button type="button" class="hero__reveal-add" data-invite="max" data-invite-name="Max" data-invite-when="Friday, November 20 at 4:00 PM ET" data-invite-set="1" aria-label="Add Max’s reveal to your calendar">/);
  assert.match(html, /<span>Add to calendar<\/span><\/button><\/div>$/);
  const planned = revealLine(colin);
  assert.match(planned, />Reveal planned for early December<\/a>/);
  assert.match(planned, /data-invite-name="Colin O&#39;Neil"/, 'names are escaped');
  assert.match(planned, /data-invite-set="0"/);
});

test('the schedule comes from the cached answer, and a slow one never holds the page', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ upcoming: [max] });
    assert.deepEqual(await upcomingReveals({ request: new Request('https://example.org/kids/max/') }), [max]);
    globalThis.fetch = async () => Response.json({ reveals: [{ ...max }] });
    assert.equal((await upcomingReveals({ request: new Request('https://example.org/kids/max/') }))[0].confirmed, true, 'an older answer shape still reads');
    globalThis.fetch = () => new Promise(() => {}); // never answers
    const t0 = Date.now();
    assert.equal(await upcomingReveals({ request: new Request('https://example.org/kids/max/'), waitUntil() {} }, 50), null);
    assert.ok(Date.now() - t0 < 500, 'gave up quickly');
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    assert.equal(await upcomingReveals({ request: new Request('https://example.org/kids/max/') }), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the page script leaves what the server put in, and the kids folder runs both', () => {
  const page = readFileSync('src/pages/kids/[slug].astro', 'utf8');
  assert.match(page, /hero\.hasAttribute\('data-reveal-shown'\)\) return;/);
  const list = readFileSync('src/pages/kids/index.astro', 'utf8');
  assert.match(list, /badge\.dataset\.reveal\) continue;/, 'cards the server filled are marked data-reveal');
  const mw = readFileSync('functions/kids/_middleware.js', 'utf8');
  assert.match(mw, /export const onRequest = \[applyBarMiddleware, kidRevealMiddleware\];/);
});
