/**
 * test-live-watch.mjs — what the live page reports for Reveal stats, in Chrome
 * ============================================================================
 * Serve a build first:   python3 -m http.server 4391 --directory <dist>
 * Then:                  BASE=http://localhost:4391 node scripts/test-live-watch.mjs
 *
 * Plays tests/fixtures/live-hls as a live broadcast (and as a replay) at the
 * Stream addresses production uses, with /api mocked, and records every
 * /api/broadcast-event and /api/live-watch post. Checks:
 *   - the page view carries this browser's id and where the visit came from
 *     (?src=email; a link on another site sends that site), and the same id
 *     on every report
 *   - watching: a report after 10 s of real playing, then every 20 s live,
 *     with the broadcast's id; seconds add up to about the time played
 *   - leaving the page sends what's left
 *   - a reload keeps the same id (one person, however often they reload)
 *   - a browser that has opened the admin says it's staff
 *   - the replay reports as replay
 * Exits non-zero on any failure or console error.
 */
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4391';
const FIX = new URL('../tests/fixtures/live-hls/', import.meta.url).pathname;
const CODE = 'test';
const SEGMENTS = 4;
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** What this tab's pages have sent so far (see the recorder below) */
const sentBy = async (page) => JSON.parse((await page.evaluate(() => sessionStorage.getItem('probe-sent')).catch(() => null)) || '[]');
/** Wait (up to 10 s) for the page to have sent one matching `pred` after the first `from` it sent */
async function sentSince(page, from, pred, ms = 25000) {
  for (let t = 0; t < ms; t += 200) { const hit = (await sentBy(page)).slice(from).find(pred); if (hit) return hit; await sleep(200); }
  return null;
}
/** Wait (up to 8 s) for a post this test expects: on a busy machine a beacon can land a moment late */
async function waitFor(pred, ms = 8000) {
  for (let t = 0; t < ms; t += 100) { const hit = posts.find(pred); if (hit) return hit; await sleep(100); }
  return null;
}

const t0 = Date.now();
function livePlaylist() {
  const newest = Math.floor((Date.now() - t0) / 2000) + 3;
  const first = newest - 3;
  let s = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / SEGMENTS)}\n`;
  for (let i = first; i <= newest; i++) {
    if (i > first && i % SEGMENTS === 0) s += '#EXT-X-DISCONTINUITY\n';
    s += `#EXTINF:2.000000,\nseg${i % SEGMENTS}.ts?n=${i}\n`;
  }
  return s;
}
const base = {
  id: 'live-9', kidSlug: null, kidName: null, title: 'Live room reveal', message: null, image: null,
  url: `${BASE}/live/`, liveUrl: `${BASE}/live/`, facebookUrl: null, youtubeUrl: null, instagramUrl: null,
  source: 'stream', updatedAt: new Date().toISOString(), scheduledAt: null, liveAt: new Date().toISOString(), endedAt: null, replayUntil: null, orientation: 'portrait',
  live: false, upcoming: false, replay: false,
};
const STATES = {
  live: { ...base, phase: 'live', live: true, player: { kind: 'live', uid: 'live1', customerCode: CODE } },
  replay: { ...base, phase: 'replay', replay: true, endedAt: new Date().toISOString(), player: { kind: 'replay', uid: 'rep1', customerCode: CODE } },
};
let state = STATES.live;
const posts = []; // { path, body, at }

async function mock(page) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
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
      if (url.pathname.endsWith('.m3u8')) return req.respond({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: cors, body: livePlaylist() });
      return req.respond({ status: 200, contentType: 'video/mp2t', headers: cors, body: readFileSync(`${FIX}portrait/${url.pathname.split('/').pop()}`) });
    }
    if (url.pathname === '/api/broadcast-event' || url.pathname === '/api/live-watch') {
      // Answer at once (a page on its way out mustn't wait on the test), then read the body:
      // a sendBeacon body is only readable through fetchPostData, which can be slow when busy
      const at = Date.now();
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
      const needs = !body && req.hasPostData();
      const reading = needs ? req.fetchPostData().catch(() => null) : null;
      await req.respond({ status: 204, body: '' }).catch(() => {});
      if (reading) { const d = await Promise.race([reading, sleep(5000).then(() => null)]); try { body = JSON.parse(d || 'null'); } catch { /* not json */ } }
      posts.push({ path: url.pathname, body, at });
      return undefined;
    }
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') return req.abort();
    if (url.pathname === '/api/broadcast') return json({ state, reminders: { enabled: true, email: true, sms: false, push: false, pushKey: null }, messages: { enabled: true }, timezone: 'America/New_York', hub: true });
    if (url.pathname === '/api/live-messages') return json({ ok: true, open: false, enabled: false, broadcastId: state.id, messages: [] });
    if (url.pathname === '/api/live-replay') return json({ ok: true, uid: 'rep1', revealAt: 6, captions: false });
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/')) return json({ ok: true, success: true });
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
    req.continue();
  });
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const errors = [];
try {
  const page = await browser.newPage();
  // Not an automated browser as far as the page can tell (it would call itself a test)
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|live-ws/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // What the page itself sent, kept in the tab's storage as it's sent (it survives leaving the page): on a busy machine
  // the test's own network hook can lose a beacon sent while a page closes, so the page's word is the one that counts
  await page.evaluateOnNewDocument(() => {
    const B = window.Blob;
    window.Blob = class extends B { constructor(parts, opts) { super(parts, opts); try { this.__text = parts.map(String).join(''); } catch {} } };
    const sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u, d) => {
      try { const k = 'probe-sent'; const a = JSON.parse(sessionStorage.getItem(k) || '[]'); a.push({ path: new URL(u, location.href).pathname, body: JSON.parse(d?.__text || 'null'), at: Date.now() }); sessionStorage.setItem(k, JSON.stringify(a)); } catch {}
      return sb(u, d);
    };
  });
  await mock(page);
  await page.setViewport({ width: 1280, height: 900 });

  console.log('\n▶ arriving from an email, watching live');
  await page.goto(`${BASE}/live/?src=email`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const v = document.querySelector('.stage__player video'); return v && !v.paused && v.currentTime > 0.5; }, { timeout: 40000 }).catch(() => {});
  const playingAt = Date.now();
  ok(await page.evaluate(() => { const v = document.querySelector('.stage__player video'); return !!v && !v.paused; }), 'the live video plays');
  const view = posts.find((p) => p.body?.type === 'view_live_page');
  ok(!!view && /^[a-f0-9]{32}$/.test(view.body.vid || ''), `the page view carries a browser id (${view?.body?.vid})`);
  ok(view?.body?.src === 'email', `and where it came from (src=${view?.body?.src})`);
  ok(!view?.body?.who, 'the public: no staff or test mark');
  const vid = view?.body?.vid;
  await sleep(12500);
  const w1 = posts.filter((p) => p.path === '/api/live-watch');
  ok(w1.length === 1 && w1[0].body.kind === 'live' && w1[0].body.broadcastId === 'live-9' && w1[0].body.vid === vid, `one live report after 10 s of playing (${JSON.stringify(w1.map((p) => p.body))})`);
  ok(w1[0]?.body?.sec >= 9 && w1[0]?.body?.sec <= 11, `for about 10 s (${w1[0]?.body?.sec})`);
  ok(w1[0]?.body?.src === 'email', 'reports carry where the visit came from too');
  await sleep(20500);
  const w2 = posts.filter((p) => p.path === '/api/live-watch');
  ok(w2.length === 2 && w2[1].body.sec >= 19 && w2[1].body.sec <= 21, `then one every 20 s (${w2.map((p) => p.body.sec).join(', ')})`);

  console.log('\n▶ sharing doesn\'t pass on where you came from');
  const shared = await page.evaluate(async () => {
    let got = null;
    try { delete navigator.share; } catch { /* not there */ }
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { got = t; } }, configurable: true });
    document.querySelector('[data-live="cta-share"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return { got, here: location.href };
  });
  ok(/\?src=email/.test(shared.here) && shared.got && !/src=/.test(shared.got) && /\/live\//.test(shared.got), `the Share link drops ?src= (${shared.got}); the address bar keeps it, so the page's own # links don't reload it`);

  console.log('\n▶ leaving sends what is left');
  const before = posts.length;
  const reportedSoFar = posts.filter((p) => p.path === '/api/live-watch').reduce((a, p) => a + p.body.sec, 0);
  await sleep(5000);
  const leftAt = Date.now();
  const sentBefore = (await sentBy(page)).length;
  await page.goto(`${BASE}/donate/`, { waitUntil: 'domcontentloaded' });
  const played = (leftAt - playingAt) / 1000;
  const sentNow = await sentBy(page);
  const last = sentNow.slice(sentBefore).find((p) => p.path === '/api/live-watch');
  void before;
  ok(!!last && Math.abs(last.body.sec - (played - reportedSoFar)) <= 2, `the seconds since the last report go on the way out (${last?.body?.sec})`);
  const total = sentNow.filter((p) => p.path === '/api/live-watch').reduce((a, p) => a + p.body.sec, 0);
  ok(Math.abs(total - played) <= 4, `the reports add up to the time played (${total} s reported, about ${Math.round(played)} s played)`);

  console.log('\n▶ a reload is the same person');
  posts.length = 0;
  const reloadFrom = (await sentBy(page)).length;
  await page.goto(`${BASE}/live/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.stage__player video'), { timeout: 10000 }).catch(() => {});
  const view2 = (await sentSince(page, reloadFrom, (p) => p.path === '/api/broadcast-event' && p.body?.type === 'view_live_page'))
    || await waitFor((p) => p.body?.type === 'view_live_page');
  ok(view2?.body?.vid === vid, `same browser id (${view2 ? `${view2.body.vid} vs ${vid}` : 'no page view arrived'}; ${posts.length} posts)`);
  ok(view2?.body?.src === 'email', 'the tab still came from the email (its session decides, not the last page)');

  console.log('\n▶ staff');
  await page.evaluate(() => localStorage.setItem('soard-staff', '1'));
  posts.length = 0;
  const staffFrom = (await sentBy(page)).length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  const staffView = (await sentSince(page, staffFrom, (p) => p.path === '/api/broadcast-event' && p.body?.type === 'view_live_page')) || await waitFor((p) => p.body?.type === 'view_live_page');
  ok(staffView?.body?.who === 'staff', 'a browser that has opened the admin says so');
  await page.evaluate(() => localStorage.removeItem('soard-staff'));

  console.log('\n▶ the replay');
  state = STATES.replay;
  await page.goto(`${BASE}/donate/`, { waitUntil: 'domcontentloaded' });
  await sleep(4000); // the last page's leftover seconds arrive before counting starts
  posts.length = 0;
  await page.goto(`${BASE}/live/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.stage__player video'), { timeout: 10000 }).catch(() => {});
  // A replay waits for a press of play (it isn't live); start it the way a person would
  await page.evaluate(() => { const v = document.querySelector('.stage__player video'); v.muted = true; return v.play(); }).catch(() => {});
  await page.waitForFunction(() => { const v = document.querySelector('.stage__player video'); return v && !v.paused && v.currentTime > 0.3; }, { timeout: 10000 }).catch(() => {});
  ok(await page.evaluate(() => !document.querySelector('.stage__player video')?.paused), 'the replay plays');
  // The sample replay is 8 s long: watch 4, pause 5 (a pause sends what was watched), leave
  const replaySentBefore = (await sentBy(page)).length;
  await sleep(4000);
  await page.evaluate(() => document.querySelector('.stage__player video').pause());
  await sleep(5000); // paused: these seconds aren't watching
  await page.goto(`${BASE}/donate/`, { waitUntil: 'domcontentloaded' });
  const r = (await sentBy(page)).slice(replaySentBefore).filter((p) => p.path === '/api/live-watch' && p.body?.kind === 'replay');
  ok(r.length >= 1 && r.every((p) => p.body.kind === 'replay' && p.body.broadcastId === 'live-9'), `the replay reports as replay (${JSON.stringify(r.map((p) => p.body.sec))})`);
  const replaySec = r.reduce((a, p) => a + p.body.sec, 0);
  ok(replaySec >= 3 && replaySec <= 5, `the paused five seconds weren't counted (${replaySec} s, sent when the pause began)`);

  console.log('\n▶ arriving by a link on another site (a new tab)');
  const other = await browser.newPage();
  await other.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  await mock(other);
  state = STATES.live;
  // 127.0.0.1 and localhost are different sites to the browser, so this is a real cross-site referrer
  await other.goto(`${BASE.replace('localhost', '127.0.0.1')}/donate/`, { waitUntil: 'domcontentloaded' });
  posts.length = 0;
  await Promise.all([other.waitForNavigation({ waitUntil: 'domcontentloaded' }), other.evaluate((u) => { const a = document.createElement('a'); a.href = u; document.body.append(a); a.click(); }, `${BASE}/live/`)]);
  const fromSite = await waitFor((p) => p.body?.type === 'view_live_page');
  ok(fromSite?.body?.ref === '127.0.0.1' && !fromSite?.body?.src, `the referring site is sent when there's no ?src= (ref=${fromSite?.body?.ref})`);
  await other.close();
} finally {
  await browser.close();
}
ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
