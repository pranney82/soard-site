/**
 * test-live.mjs — drive the live reveal UI in a real browser
 * ===========================================================
 * Start a static preview first:   npx astro build && npx astro preview --port 4322
 * Then:                            node scripts/test-live.mjs
 *
 * The preview serves no Pages Functions, so every /api call is mocked here
 * with fixtures for each broadcast state. Checks the live page in
 * scheduled / live / replay / idle states, the LIVE pill on the home page,
 * the reminder form, and every tab of the admin Broadcast control center,
 * including viewer message moderation, the family keepsake (screen and
 * print), the family invite QR downloads, and the draft-kid warning.
 * Screenshots land in test-results/live/. Exits non-zero on any failure or
 * console error.
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4322';
const OUT = new URL('../test-results/live/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const kidSlug = readdirSync(new URL('../src/content/kids/', import.meta.url).pathname).find(f => f.endsWith('.json')).replace(/\.json$/, '');
const CODE = 'cuav5h47lgfe96ql';
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
let page; // set once the browser starts
// Click the first element matching sel whose trimmed text matches re
const clickText = (sel, re) => page.evaluate((s, src) => { const rx = new RegExp(src); const el = [...document.querySelectorAll(s)].find((x) => rx.test(x.textContent.trim())); if (el) { el.click(); return true; } return false; }, sel, re.source);
// Wait for a finished download (Chrome renames .crdownload when done)
const waitFile = async (path, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (existsSync(path)) return readFileSync(path); await settle(100); } return null; };

const inH = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const base = { id: 'live-1', kidSlug, kidName: 'Sample Kid', title: "Sample Kid's room reveal", message: "Watch Sample Kid's room reveal live", image: null, liveUrl: `${BASE}/live/${kidSlug}/`, facebookUrl: 'https://www.facebook.com/SunshineOnaRanneyDay', youtubeUrl: 'https://www.youtube.com/@soard/live', source: 'stream', updatedAt: new Date().toISOString() };
const STATES = {
  idle: { ...base, id: null, kidSlug: null, kidName: null, title: null, message: null, phase: 'idle', live: false, upcoming: false, replay: false, scheduledAt: null, liveAt: null, endedAt: null, replayUntil: null, url: `${BASE}/live/`, player: null },
  scheduled: { ...base, phase: 'scheduled', live: false, upcoming: true, replay: false, scheduledAt: inH(50), liveAt: null, endedAt: null, replayUntil: null, url: `${BASE}/live/${kidSlug}/`, player: null },
  live: { ...base, phase: 'live', live: true, upcoming: false, replay: false, scheduledAt: inH(-1), liveAt: inH(-0.2), endedAt: null, replayUntil: null, url: `${BASE}/live/${kidSlug}/`, player: { kind: 'live', uid: 'in1', customerCode: CODE } },
  replay: { ...base, phase: 'replay', live: false, upcoming: false, replay: true, scheduledAt: inH(-3), liveAt: inH(-2), endedAt: inH(-1), replayUntil: inH(70), url: `${BASE}/live/${kidSlug}/`, player: { kind: 'replay', uid: 'vid1', customerCode: CODE } },
};
const reminders = { enabled: true, email: true, push: true, pushKey: 'BPQ' + 'x'.repeat(84) };

// Kids the admin loads from list-content (they feed the Broadcast kid
// selects): one real published kid and a draft copy, so the draft warning
// can be exercised.
const kidJson = JSON.parse(readFileSync(new URL(`../src/content/kids/${kidSlug}.json`, import.meta.url), 'utf8'));
const KIDS = [
  { ...kidJson, slug: kidSlug, publishStatus: 'published' },
  { ...kidJson, name: 'Dana', slug: 'dana-draft', publishStatus: 'draft' },
];

// Viewer messages, one or more of each status, newest first
const MESSAGES = [
  { id: 'm6', name: 'Grandma Jo', body: 'We are so proud of you! Enjoy every minute in your new room.', status: 'held', reason: 'Screening was unavailable', createdAt: inH(-0.02), moderatedBy: null, moderatedAt: null },
  { id: 'm5', name: 'Coach Mike', body: 'This is amazing. Way to go, team!', status: 'shown', reason: null, createdAt: inH(-0.05), moderatedBy: null, moderatedAt: null },
  { id: 'm4', name: 'Promo Bot', body: 'Buy cheap followers today', status: 'blocked', reason: 'Looks like advertising', createdAt: inH(-0.08), moderatedBy: null, moderatedAt: null },
  { id: 'm3', name: 'Alex', body: 'First! lol', status: 'hidden', reason: null, createdAt: inH(-0.1), moderatedBy: 'ops@example.com', moderatedAt: inH(-0.09) },
  { id: 'm2', name: 'Aunt Rosa', body: 'Sending so much love from Ohio. Your room looks like a dream.', status: 'shown', reason: null, createdAt: inH(-0.12), moderatedBy: null, moderatedAt: null },
  { id: 'm1', name: 'Priya', body: 'Congratulations! We watched from our kitchen and cried happy tears.', status: 'shown', reason: null, createdAt: inH(-0.15), moderatedBy: null, moderatedAt: null },
];
const messagesFixture = (state, broadcastId) => {
  const counts = { shown: 0, hidden: 0, blocked: 0, held: 0 };
  for (const m of MESSAGES) counts[m.status]++;
  const past = broadcastId && broadcastId !== state.id;
  return { success: true, broadcastId: broadcastId || state.id, kidSlug, kidName: past ? 'Sample Kid' : state.kidName, title: past ? 'Earlier reveal' : state.title, enabled: true, counts, messages: MESSAGES };
};
const posted = []; // POST bodies sent to /api/broadcast-admin

const adminFixture = (state) => ({
  success: true,
  state: { reel: state.phase === 'replay' ? { stage: 'processing', sourceUid: 'vid1', duration: 1620, method: 'captions+ai', momentSeconds: 742, confidence: 0.9, start: 502, end: 1397, clipUid: 'clip1', error: null } : null, phase: state.phase, broadcastId: state.id, kidSlug: state.kidSlug, kidName: state.kidName, source: state.source, liveAt: state.liveAt, fb: { permalink: 'https://www.facebook.com/x/videos/1' }, clicks: 3 },
  public: state, legacy: { live: state.live },
  config: { customerCode: CODE, liveInput: { uid: 'in1', created: inH(-100), enabled: true, srt: { url: 'srt://live.cloudflare.com:778', streamId: 'sid1…2345', passphrase: 'pass…word' }, rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'abcd…wxyz' } }, rehearsalInput: null, outputs: { facebook: { uid: 'o1', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyMask: 'FB-1…9999', enabled: true, createdAt: inH(-50) } }, facebook: { mode: 'persistent', pageUrl: 'https://www.facebook.com/SunshineOnaRanneyDay' }, youtube: { channelUrl: '' }, reminders: { enabled: true, hoursBefore: [24, 1], push: true }, replayHours: 72, timezone: 'America/New_York', alerts: { emails: ['ops@example.com'], phones: ['+14045550123', '+16785550199'] }, defaults: { title: 'Live room reveal', message: 'We are live' }, vapid: { publicKey: 'BPQ', createdAt: inH(-10) }, messages: { enabled: true } },
  larix: { standard: 'larix://set/v1?conn[][name]=SOARD+Live&conn[][url]=srt%3A%2F%2Flive.cloudflare.com%3A778&conn[][srtstreamid]=sid&conn[][srtpass]=pw&enc[vid][res]=1920x1080', lowSignal: 'larix://set/v1?conn[][name]=Weak&conn[][url]=srt%3A%2F%2Flive.cloudflare.com%3A778&enc[vid][res]=1280x720', srtUrl: 'srt://live.cloudflare.com:778?streamid=sid&passphrase=pw', rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'key' } },
  setup: { streamConfigured: true, fbConfigured: true, emailConfigured: true, smsConfigured: true, slackConfigured: false, kitConfigured: true, hubBound: true, deployHook: true, inputReady: true, pushReady: true, webhookUrl: 'https://sunshineonaranneyday.com/api/stream-webhook', alertEmails: ['ops@example.com'], alertPhones: ['+14045550123', '+16785550199'], alertTexts: { last: { at: inH(-0.2), title: "All green: Sample Kid's room reveal", sent: 2, failed: 0, error: null }, stopped: { '+16785550199': inH(-30) } } },
  health: { lastDailyAt: inH(-2), stream: { ok: true, at: inH(-2) }, facebook: { ok: true, name: 'SOARD', at: inH(-2) }, hub: { ok: true, clients: 4, at: inH(-2) }, webhook: { lastReceivedAt: inH(-0.5), lastEvent: 'live_input.connected', count: 12 }, lifecycle: { at: inH(-0.01), live: state.live, videoUID: 'vid1' }, lastTick: { at: inH(-0.01), source: 'hub', work: [] } },
  hub: { ok: true, clients: 4, lastTick: { at: inH(-0.01) }, watchers: state.live ? 31 : 0, reactions: state.live ? { broadcastId: state.id, totals: { heart: 12, sun: 30, clap: 8, wow: 1 } } : null },
  live: { lifecycle: { isInput: true, live: state.live, videoUID: state.live ? 'vid1' : null }, rehearsal: null, viewers: state.live ? 27 : null },
  outputs: [{ target: 'facebook', uid: 'o1', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyMask: 'FB-1…9999', enabled: true, exists: true }],
  recordings: [{ uid: 'vid1', name: 'Sample reveal', created: inH(-2), duration: 1800, state: 'ready', readyToStream: true, thumbnail: 'about:blank', watch: 'https://watch.cloudflarestream.com/vid1', isCurrentReplay: state.phase === 'replay', isLiveNow: false }],
  reminders: { counts: { email: 42, push: 3 }, recent: [{ channel: 'email', address: 'fa…@example.com', kid_slug: kidSlug, created_at: inH(-1), source: 'live-kid' }] },
  sends: state.phase === 'idle' ? [] : [{ kind: 'day', channel: 'email', recipients: 42, sent: 42, failed: 0, created_at: inH(-30) }],
  history: [{ id: 'live-0', kid_slug: kidSlug, kid_name: 'Sample Kid', title: 'Earlier reveal', scheduled_at: inH(-700), live_at: inH(-699), ended_at: inH(-698.5), phase: 'idle', replay_uid: 'vid0', fb_permalink: null, source: 'stream', data: {}, messageCount: 14, events: { view_live_page: 120, click_watch: 40, click_donate: 6, reminder_signup: 12 } }],
  fbRecent: null,
  playback: { customerCode: CODE, liveEmbed: `https://customer-${CODE}.cloudflarestream.com/in1/iframe?muted=true&autoplay=true`, rehearsalEmbed: null },
});

async function mockApi(page, state) {
  await page.setRequestInterception(true);
  page.removeAllListeners('request');
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    // What Stream answers for a live input with no camera connected: an empty playlist
    if (url.hostname.endsWith('cloudflarestream.com')) return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
    if (url.pathname.startsWith('/cdn-cgi/imagedelivery/') || url.hostname === 'imagedelivery.net') return req.abort();
    if (url.pathname === '/api/broadcast') return json({ state, reminders, messages: { enabled: true }, timezone: 'America/New_York', hub: true });
    if (url.pathname === '/api/live-messages' && req.method() === 'GET') return json({ ok: true, open: state.phase !== 'idle', enabled: true, broadcastId: state.id, messages: state.phase === 'idle' ? [] : [{ id: 'm1', name: 'Ana', body: 'So happy for you!', at: new Date().toISOString() }] });
    if (url.pathname === '/api/live-messages') return json({ ok: true, status: 'shown', message: { id: 'm2', name: 'Bo', body: 'Congratulations!', at: new Date().toISOString() } });
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname === '/api/broadcast-event') return req.respond({ status: 204, body: '' });
    if (url.pathname === '/api/reminders') return req.method() === 'POST' ? json({ ok: true, channel: 'email' }) : json({ ok: true });
    if (url.pathname === '/api/broadcast-admin') {
      if (req.method() !== 'POST') return json(adminFixture(state));
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch {}
      posted.push(body);
      if (body.action === 'messages') return json(messagesFixture(state, body.broadcastId));
      if (body.action === 'moderateMessage') {
        const m = MESSAGES.find((x) => x.id === body.id);
        return m ? json({ success: true, message: { ...m, status: body.status, moderatedBy: 'ops@example.com', moderatedAt: new Date().toISOString() } }) : json({ success: false, error: 'not found' }, 404);
      }
      if (body.action === 'setConfig') return json({ success: true, config: adminFixture(state).config });
      return json(adminFixture(state));
    }
    if (url.pathname === '/api/live-status') return json({ live: state.live, upcoming: state.upcoming, auto: true });
    if (url.pathname.startsWith('/api/list-content')) {
      const items = url.searchParams.get('dir') === 'src/content/kids' ? KIDS.map((content) => ({ name: `${content.slug}.json`, path: `src/content/kids/${content.slug}.json`, content })) : [];
      return json({ success: true, items, total: items.length, pages: 1, hasMore: false });
    }
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
  page = await browser.newPage();
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
    if (name === 'live') {
      ok((await page.$$('[data-s="player"] video')).length === 1, 'player video mounted');
      ok(await page.$eval('#live-hero', (el) => el.hasAttribute('data-party')), 'watch-party layout');
      ok(await vis('[data-s="bar"]'), 'the bar under the video');
      ok(await vis('[data-slot="hero"] [data-msgs="panel"]'), 'messages for the family beside the video');
      ok(!(await vis('[data-live="cta-facebook"]')), 'no Facebook detour while live');
      await page.waitForFunction(() => document.querySelector('[data-stage]')?.dataset.pstatus === 'waiting', { timeout: 8000 }).catch(() => {});
      ok(await vis('[data-s="note"]'), 'camera-not-connected note while the playlist is empty');
      ok(await page.$eval('[data-s="status"]', (el) => el.textContent.trim()) !== 'Live', 'the bar does not say Live over a frame with no picture');
    }
    if (name === 'replay') { ok((await page.$$('[data-s="player"] video')).length === 1, 'replay video mounted'); ok(await vis('[data-s="replaybar"]'), 'replay controls under the picture'); }
    if (name === 'idle') { ok((await page.$$('[data-s="player"] video, [data-s="player"] iframe')).length === 0, 'no player'); ok(!(await page.$eval('#live-hero', (el) => el.hasAttribute('data-party'))), 'plain hero'); }
    ok((await page.$$('[data-live="form-sms"], input[type="tel"]')).length === 0, 'no text sign-up: the public is never texted');
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
    await page.goto(`${BASE}/admin/index.html`, { waitUntil: 'networkidle0' });
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button.nav-item')].find((x) => /^(Broadcast|Reveals)/.test(x.textContent.trim())); if (b) { b.click(); return true; } return false; });
    ok(clicked, `nav has Reveals (${name})`);
    await page.waitForFunction(() => [...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'Broadcast'), { timeout: 8000 }).catch(() => {});
    const tabs = await page.$$('.hub-tab');
    ok(tabs.length === 4, `${tabs.length} tabs: Now, Invites, History, Settings (${name})`);
    for (let i = 0; i < tabs.length; i++) {
      const label = await tabs[i].evaluate((b) => b.textContent.trim());
      await tabs[i].click();
      await new Promise((r) => setTimeout(r, 250));
      const cards = await page.$$eval('.card', (els) => els.length);
      ok(cards > 0, `tab ${label} renders ${cards} cards (${name})`);
      if (label.startsWith('Settings')) {
        ok((await page.$$('#bc-set-phones .bc-qr svg')).length >= 2, 'Larix QR codes render under Settings → Phones');
        ok(await page.$eval('#bc-alert-phones', (el) => el.value).catch(() => '') === '(404) 555-0123, (678) 555-0199', 'Alerts: staff numbers shown, formatted');
        const alertsText = await page.$eval('#bc-set-alerts', (el) => el.innerText).catch(() => '');
        ok(/Twilio connected/.test(alertsText) && /\(678\) 555-0199 replied STOP/.test(alertsText) && /Last text .*All green/.test(alertsText), 'Alerts: Twilio badge, a STOP, the last text');
        ok(!/Offer text messages/.test(await page.evaluate(() => document.body.innerText)), 'no public text switch anywhere');
        if (name === 'live') await (await page.$('#bc-set-alerts')).screenshot({ path: `${OUT}admin-alerts.png` });
      }
      if (name === 'live') await page.screenshot({ path: `${OUT}admin-${label.toLowerCase().replace(/\W+/g, '')}.png`, fullPage: true });
    }
    await tabs[0].click(); await new Promise((r) => setTimeout(r, 250));
    const nowText = await page.evaluate(() => document.querySelector('main')?.innerText || document.body.innerText);
    if (name === 'live') ok(/Email the list now/.test(nowText) && /Kit email: goes out after 3 minutes live/.test(nowText) && !/Which kid is this/.test(nowText), 'live: Kit status + "Email the list now" button, no kid picker when the kid is known');
    if (name === 'scheduled') {
      ok(/Kit email at go-live: on \(All subscribers\)/.test(nowText), 'scheduled: Kit go-live status');
      ok(await clickText('.bc-actions button', /^Edit$/), 'scheduled: Edit opens the reveal form');
      await settle(150);
      ok(/Email our Kit list \(All subscribers\) when we go live/.test(await page.$eval('.bc-form', (el) => el.innerText).catch(() => '')), 'scheduled: edit form has the Kit switch');
      await clickText('.bc-form button', /^Cancel$/);
    }
    if (name === 'idle') ok(/Email our Kit list \(All subscribers\) when we go live/.test(nowText), 'idle: schedule form has the Kit switch');

    if (name === 'live') {
      console.log('  · messages, engagement, keepsake, history (live)');
      await page.waitForSelector('.bc-msgs .bc-msg', { timeout: 5000 }).catch(() => {});
      const card = await page.$eval('.bc-msgs', (el) => el.innerText).catch(() => '');
      ok(/Messages for Sample Kid's family/.test(card), 'messages card titled for the family');
      ok(/Let viewers post messages on the live page/.test(card), 'messages on/off switch');
      ok(/3\s+shown/.test(card) && /1\s+waiting for review/.test(card) && /1\s+hidden/.test(card) && /1\s+blocked/.test(card), 'messages counts line');
      ok(/Updates every 10 seconds/.test(card), 'messages auto-refresh while live');
      const btns = await page.$$eval('.bc-msgs .bc-msg button', (els) => els.map((b) => b.textContent.trim()));
      ok(btns.filter((t) => t === 'Hide').length === 3 && btns.filter((t) => t === 'Show').length === 2, `Hide/Show buttons (${btns.join(', ')})`);
      ok(await page.$eval('.bc-review', (el) => /Waiting for review \(1\)/.test(el.innerText) && /Grandma Jo/.test(el.innerText)).catch(() => false), 'held message on top as "Waiting for review"');
      ok(!/Buy cheap followers/.test(card), 'blocked messages folded away by default');
      ok(await clickText('.bc-msgs button', /^Show blocked \(1\)$/), '"Show blocked (1)" toggle');
      await settle(150);
      ok(/Buy cheap followers/.test(await page.$eval('.bc-msgs', (el) => el.innerText)), 'blocked message shows after the toggle');
      ok(/31 watching on the site/.test(nowText) && /12 hearts/.test(nowText) && /30 suns/.test(nowText) && /8 claps/.test(nowText) && /1 wow\b/.test(nowText), 'live engagement: watchers + reaction totals');

      posted.length = 0;
      await page.evaluate(() => { const row = [...document.querySelectorAll('.bc-msgs .bc-msg')].find((r) => /Coach Mike/.test(r.textContent)); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Hide').click(); });
      await page.waitForFunction(() => { const row = [...document.querySelectorAll('.bc-msgs .bc-msg')].find((r) => /Coach Mike/.test(r.textContent)); return /Hidden/.test(row?.querySelector('.badge')?.textContent || ''); }, { timeout: 4000 }).catch(() => {});
      ok(posted.some((b) => b.action === 'moderateMessage' && b.id === 'm5' && b.status === 'hidden'), 'Hide posts moderateMessage {id, status: hidden}');
      ok(await page.evaluate(() => { const row = [...document.querySelectorAll('.bc-msgs .bc-msg')].find((r) => /Coach Mike/.test(r.textContent)); return /Hidden/.test(row.querySelector('.badge').textContent) && [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Show'); }), 'hidden row flips to a Show button');

      posted.length = 0;
      await page.click('.bc-msgs .bc-switch input');
      for (let i = 0; i < 30 && !posted.some((b) => b.action === 'setConfig'); i++) await settle(100);
      ok(posted.some((b) => b.action === 'setConfig' && b.config?.messages?.enabled === false && Object.keys(b.config).length === 1), 'switch posts setConfig { messages: { enabled: false } }');
      await settle(300);

      ok(await clickText('.bc-msgs button', /^Keepsake$/), 'Keepsake button');
      await page.waitForSelector('#bc-keepsake-root .bc-keepsake', { timeout: 3000 }).catch(() => {});
      const keep = await page.$eval('#bc-keepsake-root', (el) => el.innerText).catch(() => '');
      ok(/Sample Kid's room reveal/.test(keep) && /Sending so much love from Ohio/.test(keep) && /Aunt Rosa/.test(keep), 'keepsake has the title and a shown message');
      ok(!/Buy cheap followers|First! lol|Grandma Jo|Coach Mike/.test(keep), 'keepsake leaves out hidden, blocked and held messages');
      ok(!!(await page.$('#bc-keepsake-root .bc-keepsake-bar button')), 'keepsake has a Print button');
      await page.screenshot({ path: `${OUT}admin-keepsake.png` });
      await page.emulateMediaType('print');
      ok(await page.evaluate(() => getComputedStyle(document.getElementById('app')).display === 'none' && getComputedStyle(document.querySelector('.bc-keepsake-bar')).display === 'none'), 'keepsake print view drops the admin and the toolbar');
      await page.screenshot({ path: `${OUT}admin-keepsake-print.png`, fullPage: true });
      await page.emulateMediaType(null);
      await clickText('#bc-keepsake-root button', /^Close$/);
      await settle(100);
      ok(!(await page.$('#bc-keepsake-root')), 'keepsake closes');

      await page.screenshot({ path: `${OUT}admin-now.png`, fullPage: true });

      ok(await clickText('.hub-tab', /^History/), 'History tab');
      await settle(250);
      ok(await clickText('.bc-hist-row td', /Earlier reveal/), 'History row opens');
      await settle(150);
      posted.length = 0;
      ok(await clickText('.bc-hist-detail button', /^Messages \(14\)$/), 'History row shows "Messages (14)"');
      await page.waitForSelector('.bc-msgs .bc-msg', { timeout: 4000 }).catch(() => {});
      ok(posted.some((b) => b.action === 'messages' && b.broadcastId === 'live-0'), 'History opens the messages for that broadcastId');
      ok(!/Let viewers post/.test(await page.$eval('.bc-msgs', (el) => el.innerText).catch(() => '')), 'past reveal: no on/off switch');
      await settle(500);
      await page.screenshot({ path: `${OUT}admin-history-messages.png`, fullPage: true });
      await clickText('.bc-hist-detail .bc-btns button', /^Keepsake$/);
      await page.waitForSelector('#bc-keepsake-root .bc-keepsake', { timeout: 3000 }).catch(() => {});
      ok(/Sample Kid's room reveal/.test(await page.$eval('#bc-keepsake-root', (el) => el.innerText).catch(() => '')), 'History row opens the keepsake');
      await clickText('#bc-keepsake-root button', /^Close$/);
    }
    if (name === 'scheduled') {
      await page.waitForSelector('.bc-msgs', { timeout: 4000 }).catch(() => {});
      const t = await page.$eval('.bc-msgs', (el) => el.innerText).catch(() => '');
      ok(/Refresh/.test(t) && !/Updates every 10 seconds/.test(t), 'scheduled: messages card with a manual refresh');

      ok((await page.$$('.bc-family .bc-qr svg')).length === 1, 'family QR card renders an svg');
      ok(/sunshineonaranneyday\.com\/live\/\?src=qr/.test(await page.$eval('.bc-family', (el) => el.innerText).catch(() => '')), 'family QR card shows the /live/?src=qr link');
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT }).catch(() => cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT }));
      for (const f of ['soard-live-qr.png', 'soard-live-qr.svg']) rmSync(`${OUT}${f}`, { force: true });
      const errBefore = errors.length;
      ok(await clickText('.bc-family button', /^Download PNG$/), 'Download PNG button');
      const png = await waitFile(`${OUT}soard-live-qr.png`);
      const pw = png?.length > 24 ? png.readUInt32BE(16) : 0; const ph = png?.length > 24 ? png.readUInt32BE(20) : 0;
      ok(png?.subarray(1, 4).toString() === 'PNG' && pw >= 1900 && pw <= 2200 && pw === ph, `PNG download soard-live-qr.png (${pw}x${ph})`);
      ok(await clickText('.bc-family button', /^Download SVG$/), 'Download SVG button');
      const svgFile = await waitFile(`${OUT}soard-live-qr.svg`);
      ok(/<svg[^>]+viewBox/.test(svgFile?.toString() || ''), 'SVG download soard-live-qr.svg');
      // Same noise filter as the end-of-run check: a background poll or the aborted admin socket can land in this window
      const qrErrors = errors.slice(errBefore).filter((e) => !/net::ERR_FAILED|ERR_ABORTED|Failed to load resource|WebSocket connection|favicon|cloudflareinsights|imagedelivery|cdn-cgi/i.test(e));
      ok(qrErrors.length === 0, `no errors from the QR downloads${qrErrors.length ? ` (${qrErrors.join(' / ').slice(0, 200)})` : ''}`);
    }
    if (name === 'idle') {
      ok(!(await page.$('.bc-msgs')), 'idle: no messages card');
      ok((await page.$$('.bc-family .bc-qr svg')).length === 1, 'idle: family QR card still shows');
      const draftOpt = await page.$eval('#bc-new-kid option[value="dana-draft"]', (o) => o.textContent).catch(() => '');
      ok(/^Dana \(.*draft\)$/.test(draftOpt), `draft kid marked in the schedule select ("${draftOpt}")`);
      await page.select('#bc-new-kid', 'dana-draft');
      await page.waitForSelector('.bc-draft-note', { timeout: 3000 }).catch(() => {});
      const note = await page.$eval('.bc-draft-note', (el) => el.innerText).catch(() => '');
      ok(/Dana isn't published on the site yet\. Reveal links will open the main live page until you publish Dana and the site redeploys, and the starting-soon screen won't exist\. Publish Dana before reveal day\./.test(note), 'draft kid warning under the schedule select');
      await page.select('#bc-new-kid', kidSlug);
      await settle(150);
      ok(!(await page.$('.bc-draft-note')), 'warning clears for a published kid');
      await page.select('#bc-new-kid', 'dana-draft');
      await settle(150);
    }
    if (name !== 'live') await page.screenshot({ path: `${OUT}admin-now-${name}.png`, fullPage: true });
  }

  const relevant = errors.filter((e) => !/net::ERR_FAILED|ERR_ABORTED|Failed to load resource|WebSocket connection|favicon|cloudflareinsights|imagedelivery|cdn-cgi/i.test(e));
  ok(relevant.length === 0, `no console errors (${relevant.length})`);
  for (const e of relevant) console.log('    ', e.slice(0, 300));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
