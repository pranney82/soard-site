/**
 * test-live-player.mjs — the live page's video, played for real in Chrome
 * =======================================================================
 * Start a static preview first:   npx astro build && npx astro preview --port 4322
 * Then:                            node scripts/test-live-player.mjs
 *
 * Serves a fake broadcast: tests/fixtures/live-hls looped into a live HLS
 * playlist at the same Stream addresses production uses, plus mocked
 * /api/broadcast, /api/live-messages and /api/live-replay. Checks, at
 * desktop, laptop and phone sizes (including a phone with Safari's
 * toolbars showing):
 *   - the whole stage (video and the bar under it) fits on screen, the kid's name
 *     above the video on phones, the messages beside it on desktops
 *   - nothing is ever drawn on a playing picture (every sampled point of
 *     the video hits the video)
 *   - one simple bar: Tap for sound, then sound / heart / full screen; the
 *     mini player; no links sending viewers off to watch somewhere else
 *   - a sideways picture reshapes the frame; camera-not-connected and
 *     dropped-feed notes, and recovery on its own
 *   - replay: own controls, the reveal marked on the seek bar, Jump to the
 *     reveal, captions under the picture, keyboard control
 *   - giving without leaving: the Zeffy form opens beside the video (desktop)
 *     or under a small pinned player (phone) while the reveal keeps playing
 *   - leaving the page and coming back with the Back button (client-side
 *     navigation) brings the video back
 * Screenshots land in test-results/live-player/. Exits non-zero on any
 * failure or console error.
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4322';
const FIX = new URL('../tests/fixtures/live-hls/', import.meta.url).pathname;
const OUT = new URL('../test-results/live-player/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const CODE = 'test';
const SEGMENTS = 4; // per fixture, 2 s each
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The fake broadcast ────────────────────────────────────────────
const feed = { shape: 'portrait', down: false, t0: Date.now(), revealAt: 6, design: { open: false } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** The room's design, for the strip beside the video (a kid's page) */
const DESIGN = {
  open: true, after: true, name: 'Axel',
  slides: [1, 2, 3].map((i) => ({ kind: 'before', url: `https://imagedelivery.net/x/before-${i}.jpg/public`, crop: false, alt: 'Axel’s room before', badge: 'Before', kicker: 'Before', caption: 'Axel’s room before' })),
};
/** The fixture looped forever as a live playlist, with a discontinuity at each wrap. */
function livePlaylist() {
  const newest = Math.floor((Date.now() - feed.t0) / 2000) + 3;
  const first = newest - 3;
  let s = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / SEGMENTS)}\n`;
  for (let i = first; i <= newest; i++) {
    if (i > first && i % SEGMENTS === 0) s += '#EXT-X-DISCONTINUITY\n';
    s += `#EXTINF:2.000000,\nseg${i % SEGMENTS}.ts?n=${i}\n`;
  }
  return s;
}
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:07.500\nOkay, open your eyes!\n';
const base = {
  id: 'live-9', kidSlug: null, kidName: null, title: 'Live room reveal', message: null, image: null,
  url: `${BASE}/live/`, liveUrl: `${BASE}/live/`, facebookUrl: 'https://www.facebook.com/SunshineOnaRanneyDay', youtubeUrl: null, instagramUrl: null,
  source: 'stream', updatedAt: new Date().toISOString(), scheduledAt: null, liveAt: new Date().toISOString(), endedAt: null, replayUntil: null, orientation: 'portrait',
  live: false, upcoming: false, replay: false,
};
const STATES = {
  live: { ...base, phase: 'live', live: true, player: { kind: 'live', uid: 'live1', customerCode: CODE } },
  replay: { ...base, phase: 'replay', replay: true, kidName: 'Axel', endedAt: new Date().toISOString(), player: { kind: 'replay', uid: 'rep1', customerCode: CODE } },
  facebook: { ...base, phase: 'live', live: true, source: 'manual', player: null },
};
let state = STATES.live;
const MESSAGES = [['Dana', 'We have been following since day one!'], ['Marcus', 'Proud of you, buddy.'], ['Ms. Lee', 'Watching from the classroom with the whole class cheering!'], ['Priya', 'Happy tears over here.']]
  .map(([name, body], i) => ({ id: `m${i}`, name, body, at: new Date().toISOString() }));

async function mock(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*' };
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(obj) });
    if (url.hostname === `customer-${CODE}.cloudflarestream.com`) {
      if (url.pathname.includes('/thumbnails/')) return req.respond({ status: 404, headers: cors, body: '' });
      if (url.pathname.startsWith('/rep1/')) {
        const name = url.pathname.split('/').pop();
        if (name.endsWith('.m3u8')) return req.respond({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: cors, body: readFileSync(`${FIX}${feed.shape}/video.m3u8`, 'utf8') });
        return req.respond({ status: 200, contentType: 'video/mp2t', headers: cors, body: readFileSync(`${FIX}${feed.shape}/${name}`) });
      }
      // What Stream answers while no camera is connected: an empty playlist
      if (feed.down) return req.respond({ status: 204, headers: cors, body: '' });
      if (url.pathname.endsWith('.m3u8')) return req.respond({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: cors, body: livePlaylist() });
      return req.respond({ status: 200, contentType: 'video/mp2t', headers: cors, body: readFileSync(`${FIX}${feed.shape}/${url.pathname.split('/').pop()}`) });
    }
    // (the design's pictures load, a tiny stand-in: the strip leaves out any that don't)
    if ((url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') && url.pathname.includes('/before-')) return req.respond({ status: 200, contentType: 'image/png', headers: cors, body: PNG });
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') return req.abort();
    if (url.pathname === '/api/broadcast') return json({ state, reminders: { enabled: true, email: true, sms: false, push: false, pushKey: null }, messages: { enabled: true }, timezone: 'America/New_York', hub: true });
    if (url.pathname === '/api/live-messages' && req.method() === 'GET') return json({ ok: true, open: state.phase === 'live', enabled: true, broadcastId: state.id, messages: MESSAGES });
    if (url.pathname === '/api/live-messages') return json({ ok: true, status: 'shown', message: { id: `p${Date.now()}`, name: 'Bo', body: 'Congratulations!', at: new Date().toISOString() } });
    if (url.pathname === '/api/live-replay' && url.searchParams.has('vtt')) return req.respond({ status: 200, contentType: 'text/vtt', body: VTT });
    if (url.pathname === '/api/live-replay') return json({ ok: true, uid: 'rep1', revealAt: feed.revealAt, captions: true });
    if (url.pathname === '/api/reveal-design') return json(feed.design);
    if (url.hostname === 'www.zeffy.com') return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><body style="font:16px sans-serif;padding:24px">Zeffy donation form stub</body>' });
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname === '/api/broadcast-event') return req.respond({ status: 204, body: '' });
    req.continue();
  });
}

// ── Probes ────────────────────────────────────────────────────────
const probe = (page) => page.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };
  const vis = (el) => !!el && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  const s = (k) => document.querySelector(`[data-s="${k}"]`);
  const stage = document.querySelector('[data-stage]');
  const video = document.querySelector('.stage__player video');
  const pic = document.querySelector('.stage__picture');
  // Nothing drawn on the picture: every sampled point inside it must land on the video itself
  let covered = null;
  if (video && pic) {
    const b = pic.getBoundingClientRect();
    for (let i = 1; i < 8 && !covered; i++) for (let j = 1; j < 8 && !covered; j++) {
      const x = b.left + (b.width * i) / 8, y = b.top + (b.height * j) / 8;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit !== video) covered = hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : 'nothing';
    }
  }
  return {
    party: stage?.hasAttribute('data-party'), mode: stage?.dataset.mode, pstatus: stage?.dataset.pstatus, orient: stage?.dataset.orientation,
    vsize: video ? `${video.videoWidth}x${video.videoHeight}` : null, muted: video?.muted, time: video?.currentTime, paused: video?.paused,
    stage: r(stage), picture: r(pic), bar: r(s('bar')), h1: r(document.querySelector('.hero-text h1')),
    status: s('status')?.textContent, soundCta: vis(s('sound')), heart: vis(s('heart')), mute: vis(s('mute')),
    full: [...document.querySelectorAll('[data-full]')].some(vis),
    note: vis(s('note')) ? s('note-title').textContent : null, docked: pic?.classList.contains('is-docked'),
    leaveLinks: [...document.querySelectorAll('.live-page a[href*="facebook.com"], .live-page a[href*="youtube.com"], .live-page a[href*="instagram.com"]')].filter((a) => vis(a) && !a.href.includes('sharer')).length,
    panelBeside: !!document.querySelector('[data-slot="hero"] [data-msgs="panel"]') && vis(document.querySelector('[data-msgs="panel"]')),
    form: r(document.querySelector('[data-msgs="form"]')), covered,
    jump: vis(s('jump')) ? s('jump-label').textContent : null, mark: vis(s('mark')), cc: vis(s('cc')) ? s('cc-text').textContent : null,
    give: vis(document.querySelector('.give__panel')) ? r(document.querySelector('.give__panel')) : null,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, vw: innerWidth, vh: innerHeight,
  };
});
// A fresh address each time: Chrome treats a repeat visit as a reload and restores the old scroll position
let visits = 0;
const open = (page) => page.goto(`${BASE}/live/?visit=${++visits}`, { waitUntil: 'domcontentloaded' });
const waitFor = (page, want, ms = 20000) => page.waitForFunction((w) => w.includes(document.querySelector('[data-stage]')?.dataset.pstatus), { timeout: ms }, want).catch(() => null);

const VIEWPORTS = [
  ['desktop', { width: 1424, height: 830 }],
  ['laptop', { width: 1280, height: 720 }],
  ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ['phone-toolbars', { width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
];

const browser = await puppeteer.launch({ headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|Failed to load resource|cloudflareinsights\.com/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await mock(page);

  for (const [name, vp] of VIEWPORTS) {
    console.log(`\n▶ live, portrait picture — ${name}`);
    state = STATES.live; feed.shape = 'portrait'; feed.down = false;
    await page.setViewport(vp);
    await open(page);
    await waitFor(page, ['playing']);
    await sleep(1200);
    let g = await probe(page);
    const phone = vp.width < 961;
    ok(g.party && g.pstatus === 'playing', `playing in the watch-party layout (${g.pstatus})`);
    ok(g.orient === 'portrait' && g.vsize === '144x256', `portrait picture (${g.vsize})`);
    ok(Math.abs(g.picture.w / g.picture.h - 0.5625) < 0.02, `9:16 frame (${g.picture.w}x${g.picture.h})`);
    ok(!g.covered, `nothing drawn on the picture${g.covered ? ` (hit ${g.covered})` : ''}`);
    ok(g.stage.y >= 0 && g.stage.b <= g.vh, `video and bar all on screen (stage ${g.stage.y}-${g.stage.b} of ${g.vh})`);
    // The same width as the picture, or wider when the picture is too narrow for "Live" and its buttons (it never is
    // narrower), and centred under it
    ok(g.bar.y >= g.picture.b && g.bar.w >= g.picture.w - 2 && (g.bar.w - g.picture.w <= 2 || g.bar.w <= 272) && Math.abs((g.bar.x + g.bar.w / 2) - (g.picture.x + g.picture.w / 2)) <= 2,
      `the bar sits under the picture, centred, at least as wide (bar ${g.bar.w}, picture ${g.picture.w})`);
    ok(g.overflowX <= 0, `no sideways scroll (${g.overflowX})`);
    // The hero clips overflow, so scroll width alone can't see a stage that runs off the side
    ok([g.stage, g.bar].every((b) => b.x >= 8 && b.r <= g.vw - 8), `video and bar inside the screen's gutters (stage ${g.stage.x}-${g.stage.r} of ${g.vw})`);
    ok(g.status === 'Live' && g.soundCta && !g.heart && !g.mute && !g.full, 'muted: the bar says Live and offers one thing, Tap for sound');
    ok(g.leaveLinks === 0, `nothing sends viewers off to watch somewhere else (${g.leaveLinks} links)`);
    if (phone) {
      ok(g.h1.b <= g.picture.y && g.h1.y >= 0, `kid's name above the video (${g.h1.y}-${g.h1.b})`);
      ok(g.picture.w >= 250, `video at least 250px wide (${g.picture.w})`);
      // Touch screens get 44px minimum buttons site-wide: the round controls must stay round at that size
      const odd = await page.evaluate(() => [...document.querySelectorAll('[data-stage] .bar__btn:not(.bar__cc), [data-stage] .bar__play')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.getBoundingClientRect()).filter((b) => Math.abs(b.width - b.height) > 1 || b.height < 44).length);
      ok(odd === 0, `round controls are 44px circles on a touch screen (${odd} out of shape)`);
    } else {
      ok(g.panelBeside && g.form.b <= g.vh + 8, `messages beside the video, message box on screen (${g.form.b})`);
      ok(g.picture.w >= (vp.height < 800 ? 290 : 340), `video as big as the screen height allows (${g.picture.w}px wide)`);
    }
    await page.screenshot({ path: `${OUT}live-${name}.png` });

    await page.click('[data-s="sound"]');
    await sleep(400);
    g = await probe(page);
    ok(g.muted === false && !g.soundCta, 'one tap turns the sound on');
    ok(!g.soundCta && g.mute && g.heart && g.full, 'sound on: the bar shows sound, a heart and full screen');


    if (name === 'desktop' || name === 'phone') {
      await page.click('[data-live="cta-donate"]');
      await sleep(700);
      g = await probe(page);
      const apart = (a, b) => a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y;
      ok(!!g.give && g.pstatus === 'playing' && apart(g.give, g.picture), `the donation form opens without covering the video, which keeps playing (${JSON.stringify(g.give)} vs ${JSON.stringify(g.picture)})`);
      if (phone) ok(g.docked && g.picture.y >= 0 && g.picture.b <= g.give.y, 'on a phone the video sits in a small player above the form');
      await page.screenshot({ path: `${OUT}give-${name}.png` });
      await page.keyboard.press('Escape');
      await sleep(300);
      g = await probe(page);
      ok(!g.give, 'Escape closes the form');
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(500);
    }

    await page.click('[data-s="heart"]');
    await sleep(500);
    g = await probe(page);
    ok(!g.covered, 'sending love draws nothing over the picture');

    await page.evaluate(() => window.scrollTo(0, document.querySelector('.hero').offsetHeight + 400));
    await sleep(900);
    g = await probe(page);
    ok(g.docked && g.picture.y > g.vh / 2 && g.picture.b <= g.vh - 8 && g.picture.r <= g.vw - 8, `mini player in the corner (${JSON.stringify(g.picture)})`);
    ok(!g.covered, 'nothing drawn on the mini player either');
    await page.screenshot({ path: `${OUT}docked-${name}.png` });
    await page.click('[data-s="undock"]');
    await sleep(400);
    g = await probe(page);
    ok(!g.docked && g.muted === true, 'closing the mini player undocks it and mutes');
  }

  console.log('\n▶ a sideways phone');
  await page.setViewport({ width: 1424, height: 830 });
  feed.shape = 'landscape';
  await open(page);
  await waitFor(page, ['playing']); await sleep(1000);
  let g = await probe(page);
  ok(g.orient === 'landscape' && Math.abs(g.picture.w / g.picture.h - 1.7778) < 0.03, `frame takes the picture's shape (${g.picture.w}x${g.picture.h})`);
  ok(!g.covered && g.stage.b <= g.vh, 'still uncovered and on screen');
  await page.screenshot({ path: `${OUT}landscape-desktop.png` });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(800);
  g = await probe(page);
  ok(g.overflowX <= 0 && !g.covered && [g.stage, g.bar].every((b) => b.x >= 8 && b.r <= g.vw - 8), `fits a phone, inside the gutters (${g.picture.w}x${g.picture.h}, stage to ${g.stage.r} of ${g.vw})`);
  await page.screenshot({ path: `${OUT}landscape-phone.png` });

  console.log('\n▶ camera not connected yet');
  await page.setViewport({ width: 1424, height: 830 });
  feed.shape = 'portrait'; feed.down = true;
  await open(page);
  await waitFor(page, ['waiting']); await sleep(500);
  g = await probe(page);
  ok(g.pstatus === 'waiting' && g.note === 'The camera is getting ready' && g.status === 'Waiting for the camera', `note over the empty frame, bar doesn't claim Live (${g.status})`);
  await page.screenshot({ path: `${OUT}waiting.png` });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(600);
  g = await probe(page);
  const barFits = await page.evaluate(() => { const bar = document.querySelector('[data-s="bar"]').getBoundingClientRect(); return [...document.querySelectorAll('[data-s="bar"] *')].filter((el) => el.getBoundingClientRect().width > 0).every((el) => el.getBoundingClientRect().right <= bar.right + 1); });
  ok([g.stage, g.bar].every((b) => b.x >= 8 && b.r <= g.vw - 8) && barFits && !g.heart, 'phone: waiting state fits, the bar shows only what the camera is doing');
  await page.screenshot({ path: `${OUT}waiting-phone.png` });
  await page.setViewport({ width: 1424, height: 830 });

  console.log('\n▶ the feed drops, then comes back');
  feed.down = false;
  await waitFor(page, ['playing']);
  feed.down = true;
  await waitFor(page, ['reconnecting'], 30000);
  g = await probe(page);
  ok(g.pstatus === 'reconnecting' && g.note === 'Reconnecting' && g.status === 'Reconnecting', 'Reconnecting, on the frame and in the bar');
  feed.down = false;
  await waitFor(page, ['playing'], 30000);
  g = await probe(page);
  ok(g.pstatus === 'playing' && g.status === 'Live', 'picks back up by itself');

  console.log('\n▶ replay');
  state = STATES.replay;
  await open(page);
  await page.waitForFunction(() => !document.querySelector('[data-s="jump"]')?.hidden, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  g = await probe(page);
  ok(g.mode === 'replay' && g.party && !g.heart, 'replay in the watch-party layout, no heart');
  ok(g.mark && g.jump === 'Jump to the reveal', 'the reveal is marked on the seek bar, with a Jump button');
  await page.click('[data-s="jump"]');
  await waitFor(page, ['playing']);
  await sleep(500);
  g = await probe(page);
  ok(g.pstatus === 'playing' && g.time >= 1 && g.time < 4, `Jump plays from just before the reveal (${g.time?.toFixed(1)}s)`);
  ok(!g.covered, `no control bar drawn on the replay${g.covered ? ` (hit ${g.covered})` : ''}`);
  ok(g.muted === false, 'a replay plays with sound');
  await page.click('[data-s="cc-toggle"]');
  await sleep(700);
  g = await probe(page);
  ok(g.cc === 'Okay, open your eyes!', `captions under the picture (${g.cc})`);
  await page.screenshot({ path: `${OUT}replay.png` });
  await page.click('[data-s="play"]');
  await sleep(300);
  ok((await probe(page)).paused === true, 'play button pauses');
  // Keyboard, with focus anywhere in the stage: K plays and pauses, M mutes, C captions
  await page.focus('[data-s="cc-toggle"]');
  await page.keyboard.press('k');
  await sleep(400);
  ok((await probe(page)).paused === false, 'K plays');
  await page.keyboard.press('m');
  await sleep(200);
  ok((await probe(page)).muted === true, 'M mutes');
  await page.keyboard.press('c');
  await sleep(200);
  ok((await probe(page)).cc === null, 'C turns captions off');
  const tabStops = await page.evaluate(() => [...document.querySelectorAll('[data-stage] button, [data-stage] input')].filter((el) => !el.closest('[hidden]') && el.getBoundingClientRect().width > 0 && el.tabIndex >= 0).map((el) => el.getAttribute('aria-label') || el.textContent.trim()));
  // (The reveal's star is a marker on the line, not a stop: Jump to the reveal is the button)
  ok(tabStops.length >= 5 && tabStops.every(Boolean) && tabStops.some((t) => t.startsWith('Jump to the reveal')), `every control is a labelled tab stop (${tabStops.join(', ')})`);

  // A portrait replay's bar is as narrow as the video, and on a phone the video is sized by the screen's height (narrower
  // still with captions on, which take a line of their own): every control must still sit inside the bar, the time
  // never runs into a button, and Jump to the reveal stays on one line
  console.log('\n▶ replay controls on a narrow video');
  const barFit = () => page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const seen = (el) => !!el && !el.closest('[hidden]') && r(el).width > 0;
    const bar = r(document.querySelector('[data-s="bar"]'));
    const ctrls = [...document.querySelectorAll('[data-s="replaybar"] > *')].filter(seen);
    const outside = ctrls.filter((el) => r(el).left < bar.left - 0.5 || r(el).right > bar.right + 0.5).map((el) => el.className.split(' ')[0]);
    const seek = r(document.querySelector('.seek'));
    const range = document.querySelector('[data-s="seek"]');
    const rr = r(range); const pad = parseFloat(getComputedStyle(range).paddingBottom) || 0;
    const trackY = rr.top + (rr.height - pad) / 2;
    const mark = document.querySelector('[data-s="mark"]');
    const markOff = seen(mark) ? Math.abs(r(mark).top + r(mark).height / 2 - trackY) : 0;
    // The time's pieces that are actually shown (on its first line) must sit inside the progress line's cell
    const time = document.querySelector('[data-s="time"]');
    const tb = r(time);
    const shown = [...time.children].filter((el) => r(el).width > 0 && r(el).top < tb.bottom - 1);
    const timeOut = shown.some((el) => r(el).left < seek.left - 0.5 || r(el).right > seek.right + 0.5);
    const timeText = shown.map((el) => el.textContent).join(' ');
    const jump = document.querySelector('[data-s="jump"]');
    const label = document.querySelector('[data-s="jump-label"]');
    const jumpOk = !seen(jump) || (r(label).height <= 24 && r(label).top >= r(jump).top && r(label).bottom <= r(jump).bottom && r(label).right <= r(jump).right + 0.5);
    const cc = document.querySelector('[data-s="cc-toggle"]');
    // The star stays on the line, clear of play and captions (its ring included), so it never takes their taps
    const ring = seen(mark) ? { l: r(mark).left - 3, r: r(mark).right + 3 } : null;
    const starIn = !ring || (ring.l >= seek.left - 0.5 && ring.r <= seek.right + 0.5);
    // A tap on the star (and so on a handle under it) is the line's: it seeks, and the handle can be dragged off it
    const mc = seen(mark) ? { x: r(mark).left + r(mark).width / 2, y: r(mark).top + r(mark).height / 2 } : null;
    const starTap = !mc || document.elementFromPoint(mc.x, mc.y) === range;
    const pic = r(document.querySelector('.stage__picture'));
    return { bar: Math.round(bar.width), outside, seek: Math.round(seek.width), markOff: Math.round(markOff * 10) / 10, timeOut, timeText, jumpOk, starIn, starTap, pic: Math.round(pic.width), ccShown: seen(cc), ccOn: cc?.getAttribute('aria-pressed') === 'true' };
  });
  for (const [name, vp] of [['phone-toolbars', { width: 390, height: 664 }], ['small phone', { width: 360, height: 640 }], ['big phone', { width: 430, height: 740 }], ['laptop', { width: 1280, height: 720 }]]) {
    await page.setViewport({ ...vp, ...(vp.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await open(page);
    await page.waitForFunction(() => !document.querySelector('[data-s="jump"]')?.hidden, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    for (const want of [false, true]) {
      const before = await barFit();
      if (before.ccOn !== want) { await page.click('[data-s="cc-toggle"]'); await sleep(700); }
      const f = await barFit();
      const tag = `${name}, captions ${want ? 'on' : 'off'}: bar ${f.bar}, line ${f.seek}, time "${f.timeText}"`;
      ok(f.ccShown && f.outside.length === 0, `every control inside the bar (${tag}${f.outside.length ? `; outside: ${f.outside.join(', ')}` : ''})`);
      ok(!f.timeOut, `the time stays under the line, clear of the buttons (${tag})`);
      ok(f.seek < 40 || /\d:\d\d/.test(f.timeText), `the time shows whenever there is room for it (${tag})`);
      ok(f.markOff <= 1.5, `the reveal mark sits on the line (${f.markOff}px off; ${tag})`);
      ok(f.starIn, `the reveal mark stays inside the line's ends (${tag})`);
      ok(f.starTap, `a tap on the reveal mark goes to the line (${tag})`);
      // The bar takes the room it needs even when the picture is narrower (the picture keeps its size)
      ok(f.seek >= 100, `a line worth dragging (${tag}; picture ${f.pic})`);
      ok(f.jumpOk, `Jump to the reveal stays on one line inside its button (${tag})`);
      if (name === 'phone-toolbars') await page.screenshot({ path: `${OUT}replay-narrow-cc-${want ? 'on' : 'off'}.png` });
    }
    // Leave captions as a new visitor has them
    if ((await barFit()).ccOn) { await page.click('[data-s="cc-toggle"]'); await sleep(300); }
  }
  ok((await page.evaluate(() => document.querySelector('[data-s="time-total"]')?.textContent || '')).startsWith('/ '), 'the length reads "/ 0:08" beside the time');

  // A phone held sideways: the picture as tall as the screen allows and the controls beside it (under it, they left a
  // picture a few dozen pixels wide); nothing off the screen, nothing sideways
  console.log('\n▶ a phone held sideways');
  for (const [w, h] of [[844, 390], [667, 375]]) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await open(page);
    await page.waitForFunction(() => !document.querySelector('[data-s="jump"]')?.hidden, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    const sw = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const pic = r('.stage__picture'), bar = r('[data-s="bar"]'), jump = r('[data-s="jump"]');
      return { pic: [Math.round(pic.width), Math.round(pic.height)], picBottom: Math.round(pic.bottom), beside: bar.left >= pic.right, barTop: Math.round(bar.top), lowest: Math.round(Math.max(bar.bottom, jump.bottom, pic.bottom)), vh: innerHeight, sx: document.documentElement.scrollWidth - innerWidth };
    });
    ok(sw.beside && sw.pic[1] >= h * 0.6, `${w}×${h}: the picture is full height (${sw.pic.join('×')}) with the controls beside it`);
    ok(sw.lowest <= sw.vh && sw.sx <= 0, `${w}×${h}: all of it on the screen (lowest ${sw.lowest} of ${sw.vh}), no sideways scroll`);
  }

  // The reveal's star near an end of the line: drawn exactly where the handle is at the reveal, and a tap on it plays
  // from just before the reveal, as Jump does (it was drawn a little in from the end, and a tap there played from there)
  console.log('\n▶ the reveal near the end of a replay');
  feed.revealAt = 7.7;
  await page.setViewport({ width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await open(page);
  await page.waitForFunction(() => !document.querySelector('[data-s="jump"]')?.hidden && document.querySelector('video')?.duration > 0, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  const star = await page.evaluate(() => {
    const m = document.querySelector('[data-s="mark"]').getBoundingClientRect();
    const range = document.querySelector('[data-s="seek"]');
    const rr = range.getBoundingClientRect(); const pad = parseFloat(getComputedStyle(range).paddingLeft) || 0;
    // The handle (16px) runs along the slider's content box, so its centre at the reveal is here
    const v = document.querySelector('video');
    const at = rr.left + pad + 8 + (rr.width - 2 * pad - 16) * (7.7 / v.duration);
    return { x: m.left + m.width / 2, y: m.top + m.height / 2, off: Math.abs(m.left + m.width / 2 - at) };
  });
  ok(star.off <= 0.75, `the star sits where the handle will be at the reveal (${star.off.toFixed(2)}px off)`);
  await page.touchscreen.tap(star.x, star.y);
  await sleep(700);
  g = await probe(page);
  ok(g.time >= 2.5 && g.time < 4.5, `a tap on the star plays from just before the reveal (${g.time?.toFixed(1)}s)`);
  // On the star's edge, over the slider's 8px end: the slider's own move there comes after the tap and is put back
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 0.5; });
  await sleep(300);
  await page.touchscreen.tap(star.x + 11, star.y);
  await sleep(700);
  g = await probe(page);
  ok(g.time >= 2.5 && g.time < 4.5, `a tap on the star's edge, at the line's end, plays from just before the reveal too (${g.time?.toFixed(1)}s)`);
  // After the replay has ended, Jump (and the star) still go to the reveal, not back to 0:00
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = v.duration - 0.2; v.play(); });
  await page.waitForFunction(() => document.querySelector('[data-stage]')?.dataset.pstatus === 'ended', { timeout: 8000 }).catch(() => {});
  await page.click('[data-s="jump"]');
  await sleep(700);
  g = await probe(page);
  ok(g.pstatus === 'playing' && g.time >= 2.5 && g.time < 4.5, `after the end, Jump plays from just before the reveal (${g.time?.toFixed(1)}s, ${g.pstatus})`);
  feed.revealAt = 6;

  // A phone held sideways, a wide picture with captions on and the room's design with it: the picture keeps (nearly)
  // its size, whichever way the stage finds room for the captions (it fell to 60%: the design took a column of its own)
  console.log('\n▶ sideways, a wide picture with captions and the design');
  state = { ...STATES.replay, kidSlug: 'axel', orientation: 'landscape' }; feed.shape = 'landscape'; feed.design = DESIGN;
  for (const [w, h] of [[568, 320], [667, 375], [844, 390]]) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await open(page);
    await page.waitForFunction(() => !document.querySelector('[data-s="jump"]')?.hidden && document.querySelector('.hero')?.hasAttribute('data-design'), { timeout: 15000 }).catch(() => {});
    await sleep(800);
    const look = () => page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e || e.closest('[hidden]') || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width }; };
      const parts = { pic: r('.stage__picture'), cc: r('[data-s="cc"]'), bar: r('[data-s="bar"]'), jump: r('[data-s="jump"]'), strip: r('.hds') };
      const list = Object.entries(parts).filter(([, b]) => b);
      const hit = [];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const [a, A] = list[i]; const [b, B] = list[j]; if (Math.min(A.r, B.r) - Math.max(A.l, B.l) > 0.5 && Math.min(A.b, B.b) - Math.max(A.t, B.t) > 0.5) hit.push(`${a}/${b}`); }
      const lowest = Math.max(...list.map(([, b]) => b.b)) + scrollY;
      return { pic: Math.round(parts.pic.w), hit, lowest: Math.round(lowest), vh: innerHeight, sx: document.documentElement.scrollWidth - innerWidth, cc: !!parts.cc, strip: !!parts.strip };
    });
    const off = await look();
    if (!(await page.evaluate(() => document.querySelector('[data-s="cc-toggle"]').getAttribute('aria-pressed') === 'true'))) { await page.click('[data-s="cc-toggle"]'); await sleep(700); }
    const on = await look();
    ok(on.cc && on.strip && on.pic >= off.pic * (w < 700 ? 0.9 : 0.95), `${w}×${h}: captions on, the picture keeps its size (${on.pic} of ${off.pic} wide)`);
    ok(!on.hit.length && on.lowest <= on.vh && on.sx <= 0, `${w}×${h}: captions, controls and design all on the screen, nothing overlapping (lowest ${on.lowest} of ${on.vh}${on.hit.length ? `; ${on.hit.join(', ')}` : ''})`);
    await page.click('[data-s="cc-toggle"]'); await sleep(300);
  }

  // Full screen held sideways, a wide picture: the controls beside it or under it, whichever leaves it bigger
  console.log('\n▶ full screen, sideways, a wide picture');
  for (const [w, h, cc, beside] of [[844, 390, false, true], [844, 390, true, true], [667, 375, false, false], [667, 375, true, true]]) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await open(page);
    await page.waitForFunction(() => !document.querySelector('[data-s="jump"]')?.hidden, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    if ((await page.evaluate(() => document.querySelector('[data-s="cc-toggle"]').getAttribute('aria-pressed') === 'true')) !== cc) { await page.click('[data-s="cc-toggle"]'); await sleep(500); }
    await page.click('[data-s="replaybar"] [data-full]');
    await sleep(900);
    const fs = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const pic = r('.stage__picture'), bar = r('[data-s="bar"]'), jump = r('[data-s="jump"]');
      return { full: !!document.fullscreenElement, pic: [Math.round(pic.width), Math.round(pic.height)], beside: bar.left >= pic.right, lowest: Math.round(Math.max(pic.bottom, bar.bottom, jump.bottom)), vh: innerHeight };
    });
    // (stacked under it, the picture was 427×240 at 844×390, and 316×178 with captions)
    const stacked = Math.floor((h - 32 - 118 - (cc ? 59 : 0)) * 16 / 9);
    ok(fs.full && fs.beside === beside && fs.pic[0] >= Math.min(stacked, w - 32) && fs.lowest <= fs.vh, `${w}×${h}${cc ? ', captions' : ''}: the picture ${fs.pic.join('×')}, controls ${fs.beside ? 'beside' : 'under'} it, all on the screen`);
    await page.evaluate(() => document.exitFullscreen());
    await sleep(400);
  }
  feed.design = { open: false };

  // The give form down the right of a phone held sideways, with the notch on the right: the video beside it stays clear
  console.log('\n▶ give, sideways, notch on the right');
  state = { ...STATES.live, orientation: 'landscape' }; feed.shape = 'landscape';
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 47, bottom: 21 } });
  await open(page);
  await waitFor(page, ['playing']); await sleep(800);
  await page.click('[data-live="cta-donate"]');
  await sleep(800);
  g = await probe(page);
  ok(!!g.give && g.docked && g.picture.r + 16 <= g.give.x, `the video stays 16px clear of the form (video to ${g.picture.r}, form from ${g.give?.x})`);
  await page.keyboard.press('Escape');
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0 } });

  // Typing a message on a phone whose browser shrinks the page for the keyboard (Android in-app browsers): the page
  // stays upright however short the keyboard leaves it, the corner player steps aside, and when typing ends the page
  // is where it was, with the player back
  console.log('\n▶ typing a message, the keyboard up');
  state = STATES.live; feed.shape = 'portrait';
  await page.setViewport({ width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await open(page);
  await waitFor(page, ['playing']); await sleep(800);
  await page.click('[data-s="sound"]').catch(() => {});
  await page.$eval('#msg-body', (e) => e.scrollIntoView({ block: 'center' }));
  await sleep(900);
  const was = await page.evaluate(() => ({ y: Math.round(scrollY), docked: !!document.querySelector('.is-docked') }));
  const box = await (await page.$('#msg-body')).boundingBox();
  await page.touchscreen.tap(box.x + 20, box.y + 12);
  await page.setViewport({ width: 390, height: 200, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(900);
  const typing = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const pic = r('.stage__picture'), bar = r('[data-s="bar"]');
    return { upright: bar.top >= pic.bottom - 0.5, docked: !!document.querySelector('.is-docked'), sx: document.documentElement.scrollWidth - innerWidth };
  });
  ok(was.docked && typing.upright && typing.sx <= 0, `390×200 with the keyboard up: the page stays upright (controls under the picture), nothing sideways`);
  ok(!typing.docked, 'the corner player steps aside while typing');
  await page.evaluate(() => document.activeElement.blur());
  await sleep(100);
  await page.setViewport({ width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(900);
  const after = await page.evaluate(() => ({ y: Math.round(scrollY), docked: !!document.querySelector('.is-docked') }));
  ok(Math.abs(after.y - was.y) <= 90 && after.docked, `typing done: the page is where it was (${was.y} → ${after.y}) and the corner player is back`);

  // A tablet held sideways, the keyboard up: still the laptop layout, the message box beside the video and in sight
  await page.setViewport({ width: 1180, height: 820, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await open(page);
  await waitFor(page, ['playing']); await sleep(800);
  const tbox = await (await page.$('#msg-body')).boundingBox();
  await page.touchscreen.tap(tbox.x + 20, tbox.y + 12);
  await page.setViewport({ width: 1180, height: 430, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(900);
  g = await probe(page);
  const tf = await page.evaluate(() => { const b = document.querySelector('#msg-body').getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width) }; });
  ok(g.panelBeside && !g.docked && tf.top >= 0 && tf.bottom <= g.vh && tf.w < g.vw * 0.7, `1180×430, a tablet's keyboard up: messages still beside the video, the box in sight (${tf.w} wide at ${tf.top}-${tf.bottom} of ${g.vh})`);
  await page.evaluate(() => document.activeElement.blur());

  // A laptop: the frame follows the window's height even while a text field has focus (no keyboard comes up there)
  await page.setViewport({ width: 1440, height: 900 });
  await open(page);
  await waitFor(page, ['playing']); await sleep(800);
  await page.click('#msg-body');
  const tall = (await probe(page)).picture.h;
  await page.setViewport({ width: 1440, height: 640 });
  await sleep(800);
  g = await probe(page);
  ok(g.picture.h < tall && g.stage.b <= g.vh, `laptop, typing, window made shorter: the video follows it (${tall} → ${g.picture.h} tall, stage to ${g.stage.b} of ${g.vh})`);
  await page.evaluate(() => document.activeElement.blur());

  console.log('\n▶ leave the page and come back');
  state = STATES.live; feed.shape = 'portrait';
  await page.setViewport({ width: 1280, height: 800 });
  await open(page);
  await waitFor(page, ['playing']);
  await page.evaluate(() => [...document.querySelectorAll('a[href="/donate/"]')][0]?.click());
  await page.waitForFunction(() => location.pathname === '/donate/', { timeout: 10000 }).catch(() => {});
  ok(await page.evaluate(() => document.querySelectorAll('video').length === 0), 'the video stops when you leave');
  await page.goBack();
  await waitFor(page, ['playing']);
  g = await probe(page);
  ok(g.pstatus === 'playing' && g.party, 'Back brings the live page back, playing');

  console.log('\n▶ Facebook-only broadcast');
  state = STATES.facebook;
  await open(page);
  await sleep(1500);
  g = await probe(page);
  const fb = await page.$eval('[data-live="cta-facebook"]', (a) => !a.hidden);
  ok(!g.party && fb, 'photo hero with Watch on Facebook');
} finally {
  await browser.close();
}

ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
console.log(failures.length ? `\n${failures.length} failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
