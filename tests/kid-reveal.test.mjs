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
  // Drawn at the edge, which can't know the visitor: Eastern, with its label (the browser shows the visitor's own)
  assert.match(html, />Reveal day: Fri, Nov 20 at 4:00 PM EST<\/a>/);
  assert.match(html, /aria-label="Max&#39;s reveal day is Friday, November 20 at 4:00 PM EST\. Watch it live\."/);
  // Its spoken name begins with the words on the button (WCAG 2.5.3)
  assert.match(html, /<button type="button" class="hero__reveal-add" data-invite="max" data-invite-name="Max" data-invite-when="Friday, November 20 at 4:00 PM EST" data-invite-set="1" aria-label="Add to calendar: Max’s reveal">/);
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

test('after the edge copy expires, the last schedule this edge read answers at once and a fresh one is fetched', async () => {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  const store = new Map();
  globalThis.caches = { default: {
    match: async (req) => store.get(req.url)?.clone() || undefined,
    put: async (req, res) => { store.set(req.url, res.clone()); },
  } };
  const page = (waits) => ({ request: new Request('https://example.org/kids/max/'), waitUntil: (p) => waits.push(p) });
  try {
    // An edge that has never read the schedule: the page waits for the answer, and it's kept
    let asked = 0;
    globalThis.fetch = async () => { asked++; return Response.json({ upcoming: [max], source: 'jobtread' }); };
    let waits = [];
    assert.deepEqual(await upcomingReveals(page(waits)), [max]);
    await Promise.all(waits);
    assert.ok(store.has('https://example.org/api/reveals?edge=last-known'), 'kept as the last known schedule');
    // The 3-minute copy has gone and JobTread is slow: the page doesn't wait at all
    globalThis.fetch = () => { asked++; return new Promise(() => {}); };
    const t0 = Date.now();
    assert.deepEqual(await upcomingReveals(page([]), 5000), [max]);
    assert.ok(Date.now() - t0 < 100, 'answered from the last known schedule, not after the wait');
    assert.equal(asked, 2, 'and a fresh one was asked for, for the next visitor');
    // A fresh answer replaces it
    const colinOnly = { upcoming: [colin], source: 'jobtread' };
    globalThis.fetch = async () => Response.json(colinOnly);
    waits = [];
    await upcomingReveals(page(waits));
    await Promise.all(waits);
    assert.deepEqual((await store.get('https://example.org/api/reveals?edge=last-known').clone().json()).upcoming, [colin]);
    // An answer that knows nothing never replaces what the edge knew
    globalThis.fetch = async () => Response.json({ upcoming: [], source: 'none' });
    waits = [];
    await upcomingReveals(page(waits));
    await Promise.all(waits);
    assert.deepEqual((await store.get('https://example.org/api/reveals?edge=last-known').clone().json()).upcoming, [colin]);
    // The edge copy itself still answers first
    store.set('https://example.org/api/reveals', Response.json({ upcoming: [max] }));
    globalThis.fetch = () => { throw new Error('the edge copy answers; nothing is fetched'); };
    assert.deepEqual(await upcomingReveals(page([])), [max]);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
  }
});

test('a page the server filled in can be reused by the browser for half a minute, so a hover prefetch serves the click', () => {
  const code = readFileSync('functions/_kid-reveal.js', 'utf8');
  assert.match(code, /headers\.set\('Cache-Control', PAGE_REUSE\)/);
  const bar = readFileSync('functions/_apply-bar.js', 'utf8');
  assert.match(bar, /export const PAGE_REUSE = 'private, max-age=30';/);
  assert.match(bar, /headers\.set\('Cache-Control', PAGE_REUSE\)/);
  assert.doesNotMatch(bar + code, /'(private, )?no-cache'/, 'no-cache made every click fetch the page a second time');
});

test('the page script leaves what the server put in (only its time, for a visitor outside Eastern), and the kids folder runs both', () => {
  const page = readFileSync('src/pages/kids/[slug].astro', 'utf8');
  assert.match(page, /const drawn = hero\.hasAttribute\('data-reveal-shown'\);\n\s*if \(drawn && shownZone\(\) === 'America\/New_York'\) return;/);
  assert.match(page, /if \(drawn\) \{[\s\S]*?if \(!reveal\.confirmed \|\| !reveal\.time\) return;/, 'elsewhere, it rewrites only a set day and time');
  const list = readFileSync('src/pages/kids/index.astro', 'utf8');
  assert.match(list, /badge\.dataset\.reveal\) continue;/, 'cards the server filled are marked data-reveal');
  const mw = readFileSync('functions/kids/_middleware.js', 'utf8');
  assert.match(mw, /export const onRequest = \[applyBarMiddleware, kidRevealMiddleware\];/);
});
