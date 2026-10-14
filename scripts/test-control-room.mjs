/**
 * test-control-room.mjs — drive the Broadcast control room in a real browser
 * ===========================================================================
 * Plays a generated feed through the admin's own HLS player and checks the
 * sound meter calls each section right: speech (good), silence (no sound),
 * a left-only tone (one side), white noise at full scale (too loud). Also
 * checks the destination cards, the Rehearsal and idle states, the compact
 * preview on Now, and phone-width layout. Screenshots land in
 * test-results/control-room/. Exits non-zero on any failure or console error.
 *
 * Needs ffmpeg (set FFMPEG=/path/to/ffmpeg if it isn't on PATH) to build the
 * test feed once into test-results/control-room/feed/. Serves public/ itself,
 * so no Astro build is needed:   node scripts/test-control-room.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/control-room/');
const FEED = join(OUT, 'feed/');
const FEED_MONO = join(OUT, 'feed-mono/');
const CODE = 'cuav5h47lgfe96ql';
const FF = process.env.FFMPEG || 'ffmpeg';
mkdirSync(FEED, { recursive: true });
mkdirSync(FEED_MONO, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };

// ─── Test feed: Stream's shape (fMP4, separate audio group), portrait ─────

function buildFeed() {
  if (!existsSync(join(FEED_MONO, 'video.m3u8'))) {
    // Mono mic (plays on the rehearsal input): must read as good, never as "one side only"
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-f', 'lavfi', '-i', "sine=f=220:r=48000", '-t', '20',
      '-map', '0:v', '-map', '1:a', '-af', "volume='if(lt(mod(t,1.2),0.8),0.25,0.02)':eval=frame", '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-b:v', '300k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-master_pl_name', 'video.m3u8',
      '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes,name:audio', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 's%v_%03d.m4s', 'p%v.m3u8'], { cwd: FEED_MONO });
  }
  if (existsSync(join(FEED, 'video.m3u8'))) return;
  console.log('building the test feed with ffmpeg…');
  const ff = (...args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: FEED });
  // 0-10 s speech-like tone bursts · 10-20 s silence · 20-30 s left-only tone · 30-40 s full-scale noise · 40-50 s bursts
  ff('-f', 'lavfi', '-i', 'sine=f=220:r=48000', '-t', '10', '-af', "volume='if(lt(mod(t,1.2),0.8),0.25,0.02)':eval=frame,pan=stereo|c0=c0|c1=c0", 'talk.wav');
  ff('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10', 'silence.wav');
  ff('-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '10', '-af', 'volume=-14dB,pan=stereo|c0=c0|c1=0*c0', 'left.wav');
  ff('-f', 'lavfi', '-i', 'anoisesrc=r=48000:color=white:amplitude=1', '-t', '10', '-af', 'pan=stereo|c0=c0|c1=c0', 'loud.wav');
  ff('-i', 'talk.wav', '-i', 'silence.wav', '-i', 'left.wav', '-i', 'loud.wav', '-i', 'talk.wav', '-filter_complex', '[0][1][2][3][4]concat=n=5:v=0:a=1[a]', '-map', '[a]', 'audio.wav');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-i', 'audio.wav', '-t', '50',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', '400k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-master_pl_name', 'video.m3u8',
    '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes,name:audio', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 's%v_%03d.m4s', 'p%v.m3u8');
}

// ─── Static server for public/ ──────────────────────────────────────

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serve() {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, 'public', p));
    if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// ─── Fixtures ───────────────────────────────────────────────────────

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const STREAM = `https://customer-${CODE}.cloudflarestream.com`;
const adminFixture = (phase) => ({
  success: true,
  state: { phase, broadcastId: 'live-1', kidSlug: 'sample', kidName: 'Sample Kid', source: 'stream', liveAt: iso(-300e3), fb: {} },
  public: { phase, live: phase === 'live', upcoming: false, replay: false, id: 'live-1', kidSlug: 'sample', kidName: 'Sample Kid', title: "Sample Kid's room reveal", liveUrl: '/live/sample/', liveAt: iso(-300e3), orientation: 'portrait' },
  legacy: { live: phase === 'live' },
  config: { customerCode: CODE, orientation: 'portrait', liveInput: { uid: 'in1', enabled: true }, rehearsalInput: { uid: 'reh1' }, outputs: { facebook: { uid: 'o1', keyMask: 'FB-1…9999', enabled: true } }, facebook: { mode: 'persistent', pageUrl: 'https://www.facebook.com/SunshineOnaRanneyDay' }, youtube: { channelUrl: 'https://www.youtube.com/@soard/live' }, reminders: { enabled: true, hoursBefore: [24, 1] }, alerts: { emails: ['ops@example.com'] }, defaults: {}, kitLive: { enabled: true, audience: { name: 'All subscribers' } } },
  larix: {},
  setup: { streamConfigured: true, fbConfigured: true, emailConfigured: true, slackConfigured: true, kitConfigured: false, youtubeConfigured: true, hubBound: true, inputReady: true, pushReady: true, alertEmails: ['ops@example.com'], webhookUrl: 'x' },
  health: { webhook: {}, stream: { ok: true }, facebook: { ok: true } },
  hub: { ok: true, clients: 3 },
  live: { lifecycle: { isInput: true, live: phase === 'live', videoUID: 'vid1' }, rehearsal: null, viewers: 27 },
  outputs: [{ target: 'facebook', uid: 'o1', keyMask: 'FB-1…9999', enabled: true, exists: true }],
  recordings: [], reminders: { counts: {}, recent: [] }, sends: [], history: [], fbRecent: null,
  playback: { customerCode: CODE },
});
const monitorFixture = (feed, phoneLive) => ({
  success: true, feed, at: iso(0), ready: true, uid: feed === 'live' ? 'in1' : 'reh1', phoneLive, connection: phoneLive ? 'connected' : 'client_disconnect', liveAt: phoneLive ? iso(-300e3) : null, orientation: 'portrait',
  playback: { hls: `${STREAM}/${feed === 'live' ? 'in1' : 'reh1'}/manifest/video.m3u8`, llhls: `${STREAM}/${feed === 'live' ? 'in1' : 'reh1'}/manifest/video.m3u8?protocol=llhls` },
  probe: phoneLive ? { ok: true, at: iso(-4e3), video: { width: 360, height: 640, fps: 30, renditions: 1 }, audio: { present: true, levelDb: -22.4, seconds: 8, verdict: 'ok' } } : null,
  destinations: feed !== 'live' ? null : {
    site: phoneLive ? { status: 'ok', title: 'Live on the site', detail: '27 watching · 360p', url: '/live/sample/' } : { status: 'idle', title: 'Waiting for the phone', detail: 'Starts by itself when Larix connects.', url: '/live/sample/' },
    facebook: phoneLive ? { status: 'warn', title: 'Post not live', detail: 'Stream is sending the video, but the Page has no live video.', fix: 'Open Live Producer. The preview should show the feed; press Go Live.', action: { label: 'Open Live Producer', url: 'https://www.facebook.com/live/producer' }, url: 'https://www.facebook.com/SunshineOnaRanneyDay' } : { status: 'idle', title: 'Ready', detail: 'Stream sends to Facebook when the phone connects.' },
    youtube: phoneLive ? { status: 'ok', title: 'Live on YouTube', detail: '14 watching', url: 'https://www.youtube.com/watch?v=abc', embed: 'https://www.youtube-nocookie.com/embed/abc?autoplay=1&mute=1', viewers: 14 } : { status: 'idle', title: 'Ready', detail: 'Stream sends to YouTube when the phone connects.' },
    instagram: { status: 'off', title: 'Not set up', detail: 'Optional, and set up per reveal.' },
  },
  watch: phoneLive ? { at: iso(-9e3), audio: { verdict: 'ok', levelDb: -22.1 }, alerts: {} } : null,
});

async function mock(page, { phase, live, rehearsalLive = false }) {
  await page.setRequestInterception(true);
  page.removeAllListeners('request');
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.hostname === `customer-${CODE}.cloudflarestream.com`) {
      const [, uid, , file] = url.pathname.split('/');
      const isLive = uid === 'in1' ? live : rehearsalLive;
      const dir = uid === 'in1' ? FEED : FEED_MONO;
      if (!isLive || !file || !existsSync(join(dir, file))) return req.respond({ status: 404, body: 'not found' });
      const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';
      return req.respond({ status: 200, contentType: type, headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(join(dir, file)) });
    }
    if (url.hostname === 'www.youtube-nocookie.com' || url.hostname === 'www.facebook.com') return req.respond({ status: 200, contentType: 'text/html', body: '<body style="background:#222;color:#fff;font:14px sans-serif">embed stub</body>' });
    if (url.pathname === '/api/broadcast-admin' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      if (body.action === 'monitor') return json(monitorFixture(body.feed || 'live', body.feed === 'rehearsal' ? rehearsalLive : live));
      return json({ success: true });
    }
    if (url.pathname === '/api/broadcast-admin') return json(adminFixture(phase));
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    if (url.hostname === 'static.cloudflareinsights.com') return req.abort();
    req.continue();
  });
}

const clickText = (page, sel, re) => page.evaluate((s, src) => { const r = new RegExp(src); const b = [...document.querySelectorAll(s)].find((x) => r.test(x.textContent.trim())); if (b) { b.click(); return true; } return false; }, sel, re.source);
const verdictText = (page) => page.evaluate(() => [...document.querySelectorAll('.cr-verdict strong')].map((x) => x.textContent.trim()).join(' | '));
async function waitVerdict(page, re, timeout) {
  try { await page.waitForFunction((src) => [...document.querySelectorAll('.cr-verdict strong')].some((x) => new RegExp(src).test(x.textContent)), { timeout, polling: 200 }, re.source); return true; } catch { return false; }
}
const mediaTime = (page) => page.evaluate(() => document.querySelector('.cr-stage video')?.currentTime ?? -1);

buildFeed();
const server = await serve();
const BASE = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  console.log('\n▶ Now tab: compact preview while live');
  await mock(page, { phase: 'live', live: true });
  await page.setViewport({ width: 1360, height: 900 });
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2' });
  ok(await clickText(page, 'button.nav-item', /^Broadcast/), 'nav has Broadcast');
  await page.waitForSelector('.cr-compact .cr-stage video', { timeout: 10000 }).catch(() => {});
  ok(!!(await page.$('.cr-compact')), 'compact control room on Now');
  ok((await page.$$('iframe[title="Live preview (muted)"]')).length === 0, 'old muted iframe preview is gone');
  await page.waitForFunction(() => (document.querySelector('.cr-stage video')?.currentTime || 0) > 1.5, { timeout: 15000 }).catch(() => {});
  ok((await mediaTime(page)) > 1.5, `compact player plays (t=${(await mediaTime(page)).toFixed(1)})`);
  const chips = await page.$$eval('.cr-strip .cr-chip', (els) => els.map((e) => e.textContent.trim()));
  ok(chips.some((t) => /Facebook: Post not live/.test(t)) && chips.some((t) => /YouTube: Live on YouTube/.test(t)), `destination strip (${chips.join(' / ')})`);
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}now-compact.png`, fullPage: true });

  console.log('\n▶ Control room: picture + sound sections');
  ok(await clickText(page, '.hub-tab', /^Control room/), 'Control room tab');
  await page.waitForSelector('.cr:not(.cr-compact) .cr-stage video', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => (document.querySelector('.cr-stage video')?.currentTime || 0) > 0.5, { timeout: 15000 }).catch(() => {});
  if (await page.$('.cr-verdict button')) { console.log('    (browser asked for a click to start the sound check)'); await clickText(page, '.cr-verdict button', /Start sound check/); }
  ok(await waitVerdict(page, /Sound is good/, 12000), `speech → good (saw: ${await verdictText(page)})`);
  ok((await page.$$eval('.cr-meter .cr-db', (els) => els.map((e) => e.textContent))).every((t) => /dB/.test(t) && t !== '-inf'), 'both meters show a level');
  const dests = await page.$$eval('.cr-dest', (els) => els.map((e) => e.querySelector('h4').textContent.trim()));
  ok(dests.length === 4, `4 destination cards (${dests.join(', ')})`);
  ok(await page.$eval('.cr-dest .cr-fix', (e) => /Go Live/.test(e.textContent)).catch(() => false), 'Facebook card says how to fix it');
  ok(!!(await page.$('a[href="https://www.facebook.com/live/producer"]')), 'Live Producer button');
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-good.png`, fullPage: true });
  ok(await waitVerdict(page, /^No sound/, 22000), `silence → no sound (t=${(await mediaTime(page)).toFixed(1)}, saw: ${await verdictText(page)})`);
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-silent.png`, fullPage: true });
  ok(await waitVerdict(page, /one side/, 22000), `left-only tone → one side (t=${(await mediaTime(page)).toFixed(1)}, saw: ${await verdictText(page)})`);
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-onesided.png`, fullPage: true });
  ok(await waitVerdict(page, /Too loud/, 16000), `full-scale noise → too loud (t=${(await mediaTime(page)).toFixed(1)}, saw: ${await verdictText(page)})`);
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-clipping.png`, fullPage: true });
  ok(await clickText(page, '.cr-dest button', /Watch here/), 'YouTube "Watch here"');
  await page.waitForSelector('.cr-embed iframe', { timeout: 3000 }).catch(() => {});
  ok(!!(await page.$('.cr-embed iframe[src*="youtube-nocookie.com/embed/abc"]')), 'YouTube embed opens');
  const listen = await clickText(page, '.cr button', /Listen here/);
  ok(listen && (await page.evaluate(() => [...document.querySelectorAll('.cr button')].some((b) => /Stop listening/.test(b.textContent)))), 'Listen toggle');

  console.log('\n▶ Rehearsal feed (idle)');
  ok(await clickText(page, '.cr-seg button', /Rehearsal feed/), 'switch to Rehearsal');
  await page.waitForFunction(() => /Rehearsal feed is idle/.test(document.querySelector('.cr-over')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(/Rehearsal feed is idle/.test(await page.$eval('.cr-over', (e) => e.textContent).catch(() => '')), 'rehearsal idle overlay');
  ok((await page.$$('.cr-dest')).length === 0, 'no destination cards on the private feed');

  console.log('\n▶ Rehearsal feed live, mono mic');
  await mock(page, { phase: 'live', live: true, rehearsalLive: true });
  await clickText(page, '.cr button', /^Check now/);
  await page.waitForFunction(() => (document.querySelector('.cr-stage video')?.currentTime || 0) > 1, { timeout: 15000 }).catch(() => {});
  ok(await waitVerdict(page, /Sound is good/, 12000), `mono → good (saw: ${await verdictText(page)})`);
  await new Promise((r) => setTimeout(r, 9000)); // past the 8 s one-sided window
  const monoVerdict = await verdictText(page);
  ok(!/one side/.test(monoVerdict), `mono never reads as one-sided (saw: ${monoVerdict})`);
  const monoLevels = await page.$$eval('.cr-meter .cr-db', (els) => els.map((e) => e.textContent));
  ok(monoLevels.length === 2 && monoLevels.every((t) => /dB/.test(t)), `both meters move on mono (${monoLevels.join(' / ')})`);
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-rehearsal.png`, fullPage: true });

  console.log('\n▶ Idle reveal feed, phone width');
  await mock(page, { phase: 'scheduled', live: false });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2' });
  await clickText(page, 'button.nav-item', /^Broadcast/);
  await page.waitForSelector('.hub-tab', { timeout: 8000 }).catch(() => {});
  await clickText(page, '.hub-tab', /^Control room/);
  await page.waitForFunction(() => /Waiting for the phone/.test(document.querySelector('.cr-over')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(/Waiting for the phone/.test(await page.$eval('.cr-over', (e) => e.textContent).catch(() => '')), 'idle overlay explains what happens next');
  const cards = await page.$$eval('.cr-dest .cr-pill', (els) => els.map((e) => e.textContent));
  ok(cards.filter((t) => t === 'Ready').length >= 2, `destinations show Ready while idle (${cards.join(', ')})`);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.cr')].map((el) => el.scrollWidth - el.clientWidth).reduce((a, b) => Math.max(a, b), 0));
  ok(overflow <= 0, `control room fits at 390px (${overflow}px overflow)`);
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-idle-mobile.png`, fullPage: true });

  const relevant = errors.filter((e) => !/net::ERR_FAILED|ERR_ABORTED|Failed to load resource|WebSocket connection|favicon|cloudflareinsights|imagedelivery|cdn-cgi|fonts\.g/i.test(e));
  ok(relevant.length === 0, `no console errors (${relevant.length})`);
  for (const e of relevant) console.log('    ', e.slice(0, 300));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
