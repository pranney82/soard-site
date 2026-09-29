/**
 * test-live.mjs — drive the live reveal UI in a real browser
 * ===========================================================
 * Start a static preview first:   npx astro build && npx astro preview --port 4322
 * Then:                            node scripts/test-live.mjs
 *
 * The preview serves no Pages Functions, so every /api call is mocked here
 * with fixtures for each broadcast state. Checks the live page in
 * scheduled / live / replay / idle states, the LIVE pill on the home page,
 * the reminder form, and every tab of the admin Broadcast control center.
 * Screenshots land in test-results/live/. Exits non-zero on any failure or
 * console error.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4322';
const OUT = new URL('../test-results/live/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const kidSlug = readdirSync(new URL('../src/content/kids/', import.meta.url).pathname).find(f => f.endsWith('.json')).replace(/\.json$/, '');
const CODE = 'cuav5h47lgfe96ql';
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };

const inH = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const base = { id: 'live-1', kidSlug, kidName: 'Sample Kid', title: "Sample Kid's room reveal", message: "Watch Sample Kid's room reveal live", image: null, liveUrl: `${BASE}/live/${kidSlug}/`, facebookUrl: 'https://www.facebook.com/SunshineOnaRanneyDay', youtubeUrl: 'https://www.youtube.com/@soard/live', source: 'stream', updatedAt: new Date().toISOString() };
const STATES = {
  idle: { ...base, id: null, kidSlug: null, kidName: null, title: null, message: null, phase: 'idle', live: false, upcoming: false, replay: false, scheduledAt: null, liveAt: null, endedAt: null, replayUntil: null, url: `${BASE}/live/`, player: null },
  scheduled: { ...base, phase: 'scheduled', live: false, upcoming: true, replay: false, scheduledAt: inH(50), liveAt: null, endedAt: null, replayUntil: null, url: `${BASE}/live/${kidSlug}/`, player: null },
  live: { ...base, phase: 'live', live: true, upcoming: false, replay: false, scheduledAt: inH(-1), liveAt: inH(-0.2), endedAt: null, replayUntil: null, url: `${BASE}/live/${kidSlug}/`, player: { kind: 'live', uid: 'in1', customerCode: CODE } },
  replay: { ...base, phase: 'replay', live: false, upcoming: false, replay: true, scheduledAt: inH(-3), liveAt: inH(-2), endedAt: inH(-1), replayUntil: inH(70), url: `${BASE}/live/${kidSlug}/`, player: { kind: 'replay', uid: 'vid1', customerCode: CODE } },
};
const reminders = { enabled: true, email: true, sms: true, push: true, pushKey: 'BPQ' + 'x'.repeat(84) };

const adminFixture = (state) => ({
  success: true,
  state: { phase: state.phase, broadcastId: state.id, kidSlug: state.kidSlug, kidName: state.kidName, source: state.source, liveAt: state.liveAt, fb: { permalink: 'https://www.facebook.com/x/videos/1' }, clicks: 3 },
  public: state, legacy: { live: state.live },
  config: { customerCode: CODE, liveInput: { uid: 'in1', created: inH(-100), enabled: true, srt: { url: 'srt://live.cloudflare.com:778', streamId: 'sid1…2345', passphrase: 'pass…word' }, rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'abcd…wxyz' } }, rehearsalInput: null, outputs: { facebook: { uid: 'o1', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyMask: 'FB-1…9999', enabled: true, createdAt: inH(-50) } }, facebook: { mode: 'persistent', pageUrl: 'https://www.facebook.com/SunshineOnaRanneyDay' }, youtube: { channelUrl: '' }, reminders: { enabled: true, hoursBefore: [24, 1], sms: true, push: true }, replayHours: 72, timezone: 'America/New_York', alerts: { emails: ['ops@example.com'] }, defaults: { title: 'Live room reveal', message: 'We are live' }, vapid: { publicKey: 'BPQ', createdAt: inH(-10) } },
  larix: { standard: 'larix://set/v1?conn[][name]=SOARD+Live&conn[][url]=srt%3A%2F%2Flive.cloudflare.com%3A778&conn[][srtstreamid]=sid&conn[][srtpass]=pw&enc[vid][res]=1920x1080', lowSignal: 'larix://set/v1?conn[][name]=Weak&conn[][url]=srt%3A%2F%2Flive.cloudflare.com%3A778&enc[vid][res]=1280x720', srtUrl: 'srt://live.cloudflare.com:778?streamid=sid&passphrase=pw', rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'key' } },
  setup: { streamConfigured: true, fbConfigured: true, emailConfigured: true, smsConfigured: false, slackConfigured: false, kitConfigured: true, hubBound: true, deployHook: true, inputReady: true, pushReady: true, webhookUrl: 'https://sunshineonaranneyday.com/api/stream-webhook', alertEmails: ['ops@example.com'] },
  health: { lastDailyAt: inH(-2), stream: { ok: true, at: inH(-2) }, facebook: { ok: true, name: 'SOARD', at: inH(-2) }, hub: { ok: true, clients: 4, at: inH(-2) }, webhook: { lastReceivedAt: inH(-0.5), lastEvent: 'live_input.connected', count: 12 }, lifecycle: { at: inH(-0.01), live: state.live, videoUID: 'vid1' }, lastTick: { at: inH(-0.01), source: 'hub', work: [] } },
  hub: { ok: true, clients: 4, lastTick: { at: inH(-0.01) } },
  live: { lifecycle: { isInput: true, live: state.live, videoUID: state.live ? 'vid1' : null }, rehearsal: null, viewers: state.live ? 27 : null },
  outputs: [{ target: 'facebook', uid: 'o1', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyMask: 'FB-1…9999', enabled: true, exists: true }],
  recordings: [{ uid: 'vid1', name: 'Sample reveal', created: inH(-2), duration: 1800, state: 'ready', readyToStream: true, thumbnail: 'about:blank', watch: 'https://watch.cloudflarestream.com/vid1', isCurrentReplay: state.phase === 'replay', isLiveNow: false }],
  reminders: { counts: { email: 42, sms: 7, push: 3 }, recent: [{ channel: 'email', address: 'fa…@example.com', kid_slug: kidSlug, created_at: inH(-1), source: 'live-kid' }] },
  sends: state.phase === 'idle' ? [] : [{ kind: 'day', channel: 'email', recipients: 42, sent: 42, failed: 0, created_at: inH(-30) }],
  history: [{ id: 'live-0', kid_slug: kidSlug, kid_name: 'Sample Kid', title: 'Earlier reveal', scheduled_at: inH(-700), live_at: inH(-699), ended_at: inH(-698.5), phase: 'idle', replay_uid: 'vid0', fb_permalink: null, source: 'stream', data: {}, events: { view_live_page: 120, click_watch: 40, click_donate: 6, reminder_signup: 12 } }],
  fbRecent: null,
  playback: { customerCode: CODE, liveEmbed: `https://customer-${CODE}.cloudflarestream.com/in1/iframe?muted=true&autoplay=true`, rehearsalEmbed: null },
});

async function mockApi(page, state) {
  await page.setRequestInterception(true);
  page.removeAllListeners('request');
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.hostname.endsWith('cloudflarestream.com')) return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><body style="background:#111;color:#fff;font:14px sans-serif;display:grid;place-items:center;height:100vh;margin:0">Stream player stub</body>' });
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') return req.abort();
    if (url.pathname === '/api/broadcast') return json({ state, reminders, timezone: 'America/New_York', hub: true });
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname === '/api/broadcast-event') return req.respond({ status: 204, body: '' });
    if (url.pathname === '/api/reminders') return req.method() === 'POST' ? json({ ok: true, channel: 'email' }) : json({ ok: true });
    if (url.pathname === '/api/broadcast-admin') return json(adminFixture(state));
    if (url.pathname === '/api/live-status') return json({ live: state.live, upcoming: state.upcoming, auto: true });
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/kit-broadcast')) return json({ ok: true, configured: true });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    req.continue();
  });
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  for (const [name, state] of Object.entries(STATES)) {
    console.log(`\n▶ live page: ${name}`);
    await mockApi(page, state);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${BASE}/live/${kidSlug}/`, { waitUntil: 'networkidle0' });
    await page.waitForFunction((p) => document.getElementById('live-hero')?.dataset.phase === p, { timeout: 8000 }, name === 'idle' ? 'idle' : name === 'scheduled' ? 'upcoming' : name).catch(() => {});
    const phaseAttr = await page.$eval('#live-hero', (el) => el.dataset.phase);
    ok(phaseAttr === (name === 'scheduled' ? 'upcoming' : name), `hero data-phase=${phaseAttr}`);
    const status = await page.$eval('[data-live="status"]', (el) => el.textContent.trim());
    console.log(`    status: "${status}"`);
    const vis = async (sel) => page.$eval(sel, (el) => !el.hidden && getComputedStyle(el).display !== 'none').catch(() => false);
    if (name === 'scheduled') { ok(await vis('[data-live="cta-remind"]'), 'Remind me CTA visible'); ok(await vis('[data-live="cta-calendar"]'), 'Add to calendar visible'); ok(/goes live|We go live/.test(status), 'countdown text'); }
    if (name === 'live') { ok(await vis('[data-live="cta-watch"]'), 'Watch live CTA visible'); ok((await page.$$('[data-live="player"] iframe')).length === 1, 'player iframe mounted'); ok(await vis('[data-live="cta-facebook"]'), 'Comment on Facebook visible'); }
    if (name === 'replay') { ok(await vis('[data-live="cta-replay"]'), 'Watch the replay CTA visible'); ok((await page.$$('[data-live="player"] iframe')).length === 1, 'replay iframe mounted'); }
    if (name === 'idle') { ok(!(await vis('[data-live="cta-watch"]')), 'no watch CTA'); ok((await page.$$('[data-live="player"] iframe')).length === 0, 'no player'); }
    ok(await vis('[data-live="form-sms"]'), 'SMS form offered');
    ok(await vis('[data-live="push-btn"]'), 'push button offered');
    ok(!(await page.$eval('#live-indicator', (el) => !el.hidden)), 'pill hidden on the live page');
    await page.screenshot({ path: `${OUT}live-${name}-desktop.png`, fullPage: true });
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.screenshot({ path: `${OUT}live-${name}-mobile.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, `no horizontal overflow on mobile (${overflow}px)`);

    if (name === 'scheduled') {
      await page.type('#remind-email', 'fan@example.com');
      await page.click('[data-live="form-email"] button');
      await page.waitForSelector('[data-live="form-email"].is-done', { timeout: 5000 }).catch(() => {});
      ok(await page.$eval('[data-live="form-email"]', (f) => f.classList.contains('is-done')), 'email reminder submits');
    }
  }

  console.log('\n▶ LIVE pill on home page');
  await mockApi(page, STATES.live);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('live-indicator')?.classList.contains('is-visible'), { timeout: 8000 }).catch(() => {});
  ok(await page.$eval('#live-indicator', (el) => el.classList.contains('is-visible')), 'pill visible when live');
  ok(await page.$eval('#live-indicator', (el) => el.dataset.state === 'live'), 'pill state live');
  ok(await page.$eval('.live-pill__label', (el) => el.textContent.trim() === 'Live now'), 'pill label');
  ok(await page.$eval('.live-pill__link', (el) => el.getAttribute('href').includes('/live/')), 'pill links to live page');
  await page.screenshot({ path: `${OUT}pill-live.png` });
  await mockApi(page, STATES.scheduled);
  await page.goto(`${BASE}/kids/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('live-indicator')?.classList.contains('is-visible'), { timeout: 8000 }).catch(() => {});
  ok(await page.$eval('#live-indicator', (el) => el.dataset.state === 'upcoming'), 'pill state upcoming');
  await page.screenshot({ path: `${OUT}pill-upcoming.png` });
  await mockApi(page, STATES.replay);
  await page.goto(`${BASE}/donate/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('live-indicator')?.classList.contains('is-visible'), { timeout: 8000 }).catch(() => {});
  ok(await page.$eval('#live-indicator', (el) => el.dataset.state === 'replay'), 'pill state replay');
  await page.screenshot({ path: `${OUT}pill-replay.png` });

  console.log('\n▶ admin Broadcast control center');
  for (const [name, state] of [['live', STATES.live], ['scheduled', STATES.scheduled], ['idle', STATES.idle], ['replay', STATES.replay]]) {
    await mockApi(page, state);
    await page.setViewport({ width: 1360, height: 900 });
    await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button.nav-item')].find((x) => x.textContent.trim().startsWith('Broadcast')); if (b) { b.click(); return true; } return false; });
    ok(clicked, `nav has Broadcast (${name})`);
    await page.waitForFunction(() => [...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'Broadcast'), { timeout: 8000 }).catch(() => {});
    const tabs = await page.$$('.hub-tab');
    ok(tabs.length === 5, `5 tabs (${name})`);
    for (let i = 0; i < tabs.length; i++) {
      const label = await tabs[i].evaluate((b) => b.textContent.trim());
      await tabs[i].click();
      await new Promise((r) => setTimeout(r, 250));
      const cards = await page.$$eval('.card', (els) => els.length);
      ok(cards > 0, `tab ${label} renders ${cards} cards (${name})`);
      if (label.startsWith('Setup')) ok((await page.$$('.bc-qr svg')).length >= 2, 'QR codes render');
      if (name === 'live') await page.screenshot({ path: `${OUT}admin-${label.toLowerCase().replace(/\W+/g, '')}.png`, fullPage: true });
    }
    if (name !== 'live') { await tabs[0].click(); await new Promise((r) => setTimeout(r, 250)); await page.screenshot({ path: `${OUT}admin-now-${name}.png`, fullPage: true }); }
  }

  const relevant = errors.filter((e) => !/net::ERR_FAILED|ERR_ABORTED|Failed to load resource|WebSocket connection|favicon|cloudflareinsights|imagedelivery|cdn-cgi/i.test(e));
  ok(relevant.length === 0, `no console errors (${relevant.length})`);
  for (const e of relevant) console.log('    ', e.slice(0, 300));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
