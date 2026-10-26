/**
 * test-control-room.mjs — drive the Reveals (formerly Broadcast) control room in a real browser
 * ===========================================================================
 * Plays a generated feed through the admin's own HLS player (the control
 * room on Reveals → Now while live) and checks the sound meter calls each
 * section right: speech-like bursts (good, with a LUFS reading), silence (no
 * sound), a left-only tone (one side), white noise at full scale
 * (distorting), a mono mic on the rehearsal feed (never one-sided). Also
 * checks the issues panel (Slack status, tab title), destination cards, the
 * go/no-go and its mic check, the health report in a History row, the
 * #broadcast/control-room deep link, the waiting state, and phone-width
 * layout. Screenshots land in test-results/control-room/. Exits non-zero on
 * any failure or console error.
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
const FEED = join(OUT, 'feed-v2/');
const FEED_MONO = join(OUT, 'feed-mono-v2/');
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
      '-map', '0:v', '-map', '1:a', '-af', "volume='if(lt(mod(t,1.2),0.8),2,0.16)':eval=frame", '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-b:v', '300k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-master_pl_name', 'video.m3u8',
      '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes,name:audio', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 's%v_%03d.m4s', 'p%v.m3u8'], { cwd: FEED_MONO });
  }
  if (existsSync(join(FEED, 'video.m3u8'))) return;
  console.log('building the test feed with ffmpeg…');
  const ff = (...args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: FEED });
  // 0-10 s speech-like tone bursts · 10-20 s silence · 20-30 s left-only tone · 30-40 s full-scale noise · 40-50 s bursts
  ff('-f', 'lavfi', '-i', 'sine=f=220:r=48000', '-t', '10', '-af', "volume='if(lt(mod(t,1.2),0.8),2,0.16)':eval=frame,pan=stereo|c0=c0|c1=c0", 'talk.wav');
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
  recordings: [], reminders: { counts: {}, recent: [] }, sends: [],
  history: [{ id: 'live-0', kid_slug: 'sample', kid_name: 'Earlier Kid', title: "Earlier Kid's room reveal", live_at: iso(-30 * 86400e3), ended_at: iso(-30 * 86400e3 + 1800e3), phase: 'idle', source: 'stream', data: {}, events: {} }],
  healthReports: { 'live-0': { v: 1, minutes: 31, okPct: 96, lufs: -17.4, issues: [{ k: 'silent', t: 'Reveal audio is silent', at: 742, s: 48 }, { k: 'facebook', t: "Facebook isn't showing the reveal (post not live)", at: 120, s: 40 }], fb: 160, yt: 58, peak: 41, reconnects: 1, series: Array.from({ length: 60 }, (_, i) => [i * 30, i === 25 ? null : -18 + Math.round(Math.sin(i / 3) * 3), 'o']) } },
  fbRecent: null,
  playback: { customerCode: CODE },
});
const preflightFixture = { success: true, at: iso(-60e3), ready: true, counts: { ok: 6, warn: 1, fail: 0, unknown: 1, off: 1 }, items: [
  { key: 'stream', status: 'ok', label: 'Stream is ready for the phone' },
  { key: 'micCheck', status: 'warn', label: 'No mic check in the last 2 days', fix: 'Phone on the rehearsal code, start Larix, talk normally, and watch Control room → Rehearsal feed.' },
  { key: 'facebookOutput', status: 'ok', label: 'Stream will send the reveal to Facebook' },
  { key: 'facebookToken', status: 'ok', label: 'Connected to the Facebook Page "SOARD"' },
  { key: 'facebookPost', status: 'unknown', label: "Couldn't find a scheduled Facebook live post", detail: 'With the persistent key, Facebook only goes live from a scheduled post or a Go Live press.', fix: 'Schedule the post in Live Producer.' },
  { key: 'youtube', status: 'off', label: "YouTube isn't set up (optional)" },
  { key: 'slack', status: 'ok', label: 'Problems during the reveal post to Slack' },
  { key: 'hub', status: 'ok', label: 'The live page updates instantly' },
  { key: 'kid', status: 'ok', label: 'Reveal for Sample Kid', detail: 'Starts Wed 6:00 PM' },
] };
const monitorFixture = (feed, phoneLive) => ({
  success: true, feed, at: iso(0), ready: true, uid: feed === 'live' ? 'in1' : 'reh1', phoneLive, connection: phoneLive ? 'connected' : 'client_disconnect', liveAt: phoneLive ? iso(-300e3) : null, orientation: 'portrait',
  playback: { hls: `${STREAM}/${feed === 'live' ? 'in1' : 'reh1'}/manifest/video.m3u8`, llhls: `${STREAM}/${feed === 'live' ? 'in1' : 'reh1'}/manifest/video.m3u8?protocol=llhls` },
  probe: phoneLive ? { ok: true, at: iso(-4e3), video: { width: 360, height: 640, fps: 30, renditions: 1 }, audio: { present: true, levelDb: -18.4, lufs: -15.6, channels: 2, seconds: 8, verdict: 'ok' } } : null,
  destinations: feed !== 'live' ? null : {
    site: phoneLive ? { status: 'ok', title: 'Live on the site', detail: '27 watching · 360p', url: '/live/sample/' } : { status: 'idle', title: 'Waiting for the phone', detail: 'Starts by itself when Larix connects.', url: '/live/sample/' },
    facebook: phoneLive ? { status: 'warn', title: 'Post not live', detail: 'Stream is sending the video, but the Page has no live video.', fix: 'Open Live Producer. The preview should show the feed; press Go Live.', action: { label: 'Open Live Producer', url: 'https://www.facebook.com/live/producer' }, url: 'https://www.facebook.com/SunshineOnaRanneyDay' } : { status: 'idle', title: 'Ready', detail: 'Stream sends to Facebook when the phone connects.' },
    youtube: phoneLive ? { status: 'ok', title: 'Live on YouTube', detail: '14 watching', url: 'https://www.youtube.com/watch?v=abc', embed: 'https://www.youtube-nocookie.com/embed/abc?autoplay=1&mute=1', viewers: 14 } : { status: 'idle', title: 'Ready', detail: 'Stream sends to YouTube when the phone connects.' },
    instagram: { status: 'off', title: 'Not set up', detail: 'Optional, and set up per reveal.' },
  },
  slack: true,
  watch: phoneLive && feed === 'live' ? {
    at: iso(-9e3), audio: { verdict: 'ok', lufs: -17.2 }, signal: { status: 'strong', ratio: 1, reconnects5m: 0 }, peakViewers: 30,
    issues: [{ key: 'facebook', level: 'warn', title: "Facebook isn't showing the reveal (post not live)", detail: 'Stream is sending the video, but the Page has no live video.', fix: 'Open Live Producer. The preview should show the feed; press Go Live.', since: iso(-150e3), postedAt: iso(-30e3), slack: { ok: true } }],
    log: [{ at: iso(-30e3), key: 'facebook', kind: 'open', title: "Facebook isn't showing the reveal (post not live)", slack: { ok: true } }],
  } : null,
  rehearsal: feed === 'rehearsal' && phoneLive ? { goodAt: iso(-20e3), goodLufs: -17.8, verdict: 'ok' } : null,
  preflight: null,
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
      if (body.action === 'preflight') return json(preflightFixture);
      return json({ success: true });
    }
    if (url.pathname === '/api/broadcast-admin') return json(adminFixture(phase));
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    // The upcoming reveals tracker on Now (shaped like production: settings, no reveals coming up)
    if (url.pathname === '/api/reveal-invites-admin' && req.method() === 'GET') return json({ ok: true, config: { enabled: true, organizer: 'ccunningham@soardcharity.com', lastSweep: null }, checks: { enabled: false }, organizerName: 'Clareece Cunningham', setup: { jobtread: true, google: true }, upcoming: [], board: [], advisory: [], live: { phase, checkedAt: new Date().toISOString(), reminders: { enabled: true, hoursBefore: [24, 1] }, kit: { configured: true, enabled: true, audience: 'All subscribers' } } });
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

  console.log('\n▶ Now: the control room while live');
  await mock(page, { phase: 'live', live: true });
  await page.setViewport({ width: 1360, height: 900 });
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2' });
  ok(await clickText(page, '.nav-item', /^Reveals/), 'nav has Reveals');
  await page.waitForSelector('#bc-room .cr-stage video', { timeout: 10000 }).catch(() => {});
  ok(!!(await page.$('#bc-room .cr')), 'control room on Now');
  ok(JSON.stringify(await page.$$eval('.hub-tab', (ts) => ts.map((t) => t.childNodes[0].textContent.trim()))) === JSON.stringify(['Now', 'Invites', 'History', 'Settings']), '4 tabs: Now, Invites, History, Settings');
  ok((await page.$$('iframe[title="Live preview (muted)"]')).length === 0, 'old muted iframe preview is gone');
  await page.waitForFunction(() => (document.querySelector('.cr-stage video')?.currentTime || 0) > 1.5, { timeout: 15000 }).catch(() => {});
  ok((await mediaTime(page)) > 1.5, `player plays (t=${(await mediaTime(page)).toFixed(1)})`);
  ok(/Posted to Slack/.test(await page.$eval('#bc-room .cr-issues', (e) => e.textContent).catch(() => '')), 'Now shows the open issue with its Slack status');
  ok((await page.title()).startsWith('⚠ '), `tab title flags the issue ("${await page.title()}")`);

  console.log('\n▶ Control room: picture + sound sections');
  if (await page.$('.cr-verdict button')) { console.log('    (browser asked for a click to start the sound check)'); await clickText(page, '.cr-verdict button', /Start sound check/); }
  ok(await waitVerdict(page, /Sound is good/, 12000), `speech → good (saw: ${await verdictText(page)})`);
  await page.waitForFunction(() => /LUFS/.test(document.querySelector('.cr-loud div b')?.textContent || ''), { timeout: 6000 }).catch(() => {});
  const loud = await page.$$eval('.cr-loud b', (els) => els.map((e) => e.textContent));
  const st = parseFloat(loud[0]);
  ok(Number.isFinite(st) && st > -18 && st < -11, `short-term loudness of the bursts reads ${loud[0]} (expect about -14.5 LUFS)`);
  ok(/dBTP/.test(loud[2]) && parseFloat(loud[2]) < -10 && parseFloat(loud[2]) > -14, `true peak ${loud[2]} (bursts peak at -12 dBFS)`);
  ok((await page.$$eval('.cr-meter .cr-db', (els) => els.map((e) => e.textContent))).every((t) => /dB|LUFS/.test(t)), 'loudness bar and both channel meters show a level');
  const issueText = await page.$eval('.cr-issues', (e) => e.textContent).catch(() => '');
  ok(/1 issue right now/.test(issueText) && /Posted to Slack/.test(issueText) && /Go Live/.test(issueText), 'issues panel: server issue with fix and Slack status');
  await clickText(page, '.cr-issues button', /Slack activity/);
  ok(/Posted: Facebook/.test(await page.$eval('.cr-issues', (e) => e.textContent)), 'Slack activity log');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.cr-toggles input')][0]; b.click(); });
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('soard-control-room') || '{}').sound === false), 'sound alert toggle is remembered');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.cr-toggles input')][0]; b.click(); });
  const dests = await page.$$eval('.cr-dest', (els) => els.map((e) => e.querySelector('h4').textContent.trim()));
  ok(dests.length === 3 && !dests.some((d) => /Instagram/.test(d)), `3 destination cards, Instagram (not set up) left out (${dests.join(', ')})`);
  ok(await page.$eval('.cr-dest .cr-fix', (e) => /Go Live/.test(e.textContent)).catch(() => false), 'Facebook card says how to fix it');
  ok(!!(await page.$('a[href="https://www.facebook.com/live/producer"]')), 'Live Producer button');
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-good.png`, fullPage: true });
  ok(await waitVerdict(page, /^No sound/, 22000), `silence → no sound (t=${(await mediaTime(page)).toFixed(1)}, saw: ${await verdictText(page)})`);
  await page.waitForFunction(() => /2 issues right now/.test(document.querySelector('.cr-issues h3')?.textContent || ''), { timeout: 3000 }).catch(() => {});
  ok(/Seen here first/.test(await page.$eval('.cr-issues', (e) => e.textContent).catch(() => '')), 'silence shows as an issue seen here first');
  ok((await page.title()).startsWith('⚠ No sound') || (await page.title()).startsWith('⚠ '), `title while silent: "${await page.title()}"`);
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

  console.log('\n▶ Scheduled: go/no-go, mic check on the rehearsal feed (idle)');
  await mock(page, { phase: 'scheduled', live: false });
  await page.goto('about:blank');
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2' });
  await clickText(page, '.nav-item', /^Reveals/);
  await page.waitForFunction(() => /Go, with notes/.test(document.body.innerText), { timeout: 8000 }).catch(() => {});
  const nowText = await page.evaluate(() => document.body.innerText);
  ok(/Go, with notes/.test(nowText) && /No mic check in the last 2 days/.test(nowText), 'Now shows the go/no-go with what to fix');
  ok(!/Stream is ready for the phone/.test(await page.$eval('.cr-go', (e) => [...e.querySelectorAll(':scope > .cr-checks')].map((x) => x.innerText).join('')).catch(() => 'x')), 'go/no-go lists only open items unfolded');
  ok(!(await page.$('#bc-room')), 'no control room while a reveal is hours away');
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}now-preflight.png`, fullPage: true });
  ok(await clickText(page, '.cr-go .cr-do', /^Start mic check$/), 'go/no-go fix button starts the mic check');
  await page.waitForFunction(() => /Rehearsal feed is idle/.test(document.querySelector('.cr-over')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(/Rehearsal feed is idle/.test(await page.$eval('.cr-over', (e) => e.textContent).catch(() => '')), 'rehearsal idle overlay');
  ok((await page.$$('.cr-dest')).length === 0, 'no destination cards on the private feed');

  console.log('\n▶ Mic check live, mono mic');
  await mock(page, { phase: 'scheduled', live: false, rehearsalLive: true });
  // No Refresh button: coming back to the tab brings Reveals up to date
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => (document.querySelector('.cr-stage video')?.currentTime || 0) > 1, { timeout: 15000 }).catch(() => {});
  ok(await waitVerdict(page, /Sound is good/, 12000), `mono → good (saw: ${await verdictText(page)})`);
  await new Promise((r) => setTimeout(r, 9000)); // past the 8 s one-sided window
  const monoVerdict = await verdictText(page);
  ok(!/one side/.test(monoVerdict), `mono never reads as one-sided (saw: ${monoVerdict})`);
  const monoLevels = await page.$$eval('.cr-meter .cr-db', (els) => els.map((e) => e.textContent).filter((t) => !/LUFS|—/.test(t)));
  ok(monoLevels.length === 2 && monoLevels.every((t) => /dB/.test(t)) && Math.abs(parseFloat(monoLevels[0]) - parseFloat(monoLevels[1])) < 2, `both channel meters move together on mono (${monoLevels.join(' / ')})`);
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}control-room-rehearsal.png`, fullPage: true });

  console.log('\n▶ History: health report inside the reveal\'s row');
  await clickText(page, '.hub-tab', /^History/);
  ok(await clickText(page, '.bc-hist-row td', /Earlier Kid/), 'open a past reveal');
  await page.waitForFunction(() => /Sound good 96%/.test(document.body.innerText), { timeout: 8000 }).catch(() => {});
  const histText = await page.evaluate(() => document.body.innerText);
  ok(/Sound good 96%/.test(histText) && /Facebook \+2:40/.test(histText) && /peak 41 watching/.test(histText), 'the row has the health report summary');
  ok(/12:22: Reveal audio is silent for 0:48/.test(histText), 'report lists issues with times into the reveal');
  await new Promise((r) => setTimeout(r, 400)); await page.screenshot({ path: `${OUT}history-report.png`, fullPage: true });

  console.log('\n▶ Deep link from Slack, waiting for the phone, phone width');
  await mock(page, { phase: 'armed', live: false });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto('about:blank');
  await page.goto(`${BASE}/admin/#broadcast/control-room`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.cr', { timeout: 8000 }).catch(() => {});
  ok(await page.evaluate(() => [...document.querySelectorAll('.hub-tab.active')].some((t) => /^Now/.test(t.textContent))), '#broadcast/control-room opens Now, where the control room lives');
  await page.waitForFunction(() => /Waiting for the phone/.test(document.querySelector('.cr-over')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  ok(/Waiting for the phone/.test(await page.$eval('.cr-over', (e) => e.textContent).catch(() => '')), 'idle overlay explains what happens next');
  const cards = await page.$$eval('.cr-dest .cr-pill', (els) => els.map((e) => e.textContent));
  ok(cards.filter((t) => t === 'Ready').length >= 2, `destinations show Ready while idle (${cards.join(', ')})`);
  ok(/Go \/ no-go/.test(await page.evaluate(() => document.body.innerText)), 'the go/no-go sits above the waiting control room');
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
