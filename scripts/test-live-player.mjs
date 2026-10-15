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
const feed = { shape: 'portrait', down: false, t0: Date.now() };
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
        if (name.endsWith('.m3u8')) return req.respond({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: cors, body: readFileSync(`${FIX}portrait/video.m3u8`, 'utf8') });
        return req.respond({ status: 200, contentType: 'video/mp2t', headers: cors, body: readFileSync(`${FIX}portrait/${name}`) });
      }
      // What Stream answers while no camera is connected: an empty playlist
      if (feed.down) return req.respond({ status: 204, headers: cors, body: '' });
      if (url.pathname.endsWith('.m3u8')) return req.respond({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: cors, body: livePlaylist() });
      return req.respond({ status: 200, contentType: 'video/mp2t', headers: cors, body: readFileSync(`${FIX}${feed.shape}/${url.pathname.split('/').pop()}`) });
    }
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') return req.abort();
    if (url.pathname === '/api/broadcast') return json({ state, reminders: { enabled: true, email: true, sms: false, push: false, pushKey: null }, messages: { enabled: true }, timezone: 'America/New_York', hub: true });
    if (url.pathname === '/api/live-messages' && req.method() === 'GET') return json({ ok: true, open: state.phase === 'live', enabled: true, broadcastId: state.id, messages: MESSAGES });
    if (url.pathname === '/api/live-messages') return json({ ok: true, status: 'shown', message: { id: `p${Date.now()}`, name: 'Bo', body: 'Congratulations!', at: new Date().toISOString() } });
    if (url.pathname === '/api/live-replay' && url.searchParams.has('vtt')) return req.respond({ status: 200, contentType: 'text/vtt', body: VTT });
    if (url.pathname === '/api/live-replay') return json({ ok: true, uid: 'rep1', revealAt: 6, captions: true });
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
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|Failed to load resource/.test(m.text())) errors.push(m.text()); });
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
    ok(g.bar.y >= g.picture.b && Math.abs(g.bar.w - g.picture.w) <= 2, 'the bar sits under the picture, the same width');
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
  ok(tabStops.length >= 6 && tabStops.every(Boolean), `every control is a labelled tab stop (${tabStops.join(', ')})`);

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
