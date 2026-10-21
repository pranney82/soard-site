/**
 * test-reveals.mjs — drive Reveals → Now in a real browser
 * ========================================================
 * Opens the admin at #broadcast (public/ served directly, every /api call
 * stubbed with data shaped like production) and checks that reveals come
 * from JobTread: there is no way to schedule one by hand, the status card
 * says where the countdown came from and links to JobTread, confirmed reveals
 * that can't have a countdown say why, and the upcoming reveals tracker shows
 * what went out for each reveal (invites, countdown, reminders, Kit email).
 * Also: Customize, the Kit switch and "Check now" post the right actions,
 * the Invites tab keeps its switches and wording without the list, and the
 * page fits a phone. Screenshots land in test-results/reveals/. Exits
 * non-zero on any failure or console error.
 *
 *   node scripts/test-reveals.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { DEFAULT_TEMPLATE, TEMPLATE_LIMITS } from '../functions/api/_reveal-invites.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/reveals/');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const D = 86400e3;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const day = (n) => iso(n * D).slice(0, 10);
const maxAt = new Date(`${day(10)}T20:00:00Z`).toISOString(); // 4:00 PM Eastern

// Per-scenario tweaks to the stubbed server
const KNOBS = { schedule: {}, setup: {}, slack: null, fb: null };

function adminData(phase) {
  const rehearsal = phase === 'rehearsal';
  if (rehearsal) phase = 'scheduled';
  const sched = phase === 'scheduled';
  const state = sched
    ? { phase, broadcastId: 'live-1', kidSlug: 'max', kidName: 'Max', jobId: 'jobMax0001', test: rehearsal, title: `${rehearsal ? 'TEST · ' : ''}Max's room reveal`, message: "Watch Max's room reveal live", image: null, scheduledAt: maxAt, kitLiveEmail: null, kit: { scheduledDraftId: 'k1' }, fb: {}, kidVia: 'scheduled', updatedBy: 'JobTread', revealAtSeconds: null }
    : { phase: 'idle', broadcastId: null, kit: {}, fb: {} };
  return {
    success: true,
    state,
    public: sched
      ? { phase, live: false, upcoming: true, replay: false, id: 'live-1', kidSlug: 'max', kidName: 'Max', ...(rehearsal ? { test: true } : {}), title: state.title, message: state.message, scheduledAt: maxAt, liveUrl: 'https://sunshineonaranneyday.com/live/max/', url: 'https://sunshineonaranneyday.com/live/max/' }
      : { phase: 'idle', live: false, upcoming: false, replay: false },
    config: { kitLive: { enabled: true, audience: { name: 'All subscribers' } }, messages: { enabled: true }, rehearsalInput: { uid: 'r1' }, liveInput: { uid: 'in1', enabled: true }, facebook: { mode: 'api', pageUrl: 'https://www.facebook.com/SunshineOnaRanneyDay' }, youtube: {}, instagram: {}, reminders: { enabled: true, hoursBefore: [24, 1], sms: false, push: true }, orientation: 'portrait', reels: { enabled: true }, defaults: { title: 'Live room reveal', message: "It's reveal day!" }, alerts: { emails: [] }, replayHours: 72, timezone: 'America/New_York', outputs: {} },
    setup: { ...KNOBS.setup, streamConfigured: true, inputReady: true, hubBound: true, kitConfigured: true, emailConfigured: true, smsConfigured: false, slackConfigured: false, fbConfigured: true, youtubeConfigured: false, deployHook: true, pushReady: true, alertEmails: ['peter@soardcharity.com'], webhookUrl: 'https://sunshineonaranneyday.com/api/stream-webhook', ...KNOBS.setup },
    health: { lastTick: { at: iso(-30e3), source: 'hub:alarm', work: [] }, preflight: null, stream: { ok: true }, facebook: { ok: true }, webhook: {}, lifecycle: {} },
    hub: { ok: true, clients: 1, lastTick: { at: iso(-30e3) } },
    live: { lifecycle: { live: false } },
    outputs: [], recordings: [], sends: [], history: [], healthReports: {}, fbRecent: null,
    reminders: { counts: { email: 12 }, recent: [] },
    larix: {}, playback: {},
    schedule: {
      checkedAt: iso(-2 * 60e3), error: null,
      next: sched ? { jobId: 'jobMax0001', name: 'Max', slug: 'max', startsAt: maxAt, date: day(10), time: '16:00' } : null,
      waiting: [
        { jobId: 'jobLiz0001', jobName: 'Lizzie Francis (2026)', name: 'Lizzie', slug: 'lizzie', date: day(5), time: null, problem: 'no-time' },
        { jobId: 'jobAdr0001', jobName: 'Adrian Scala (2025)', name: null, slug: null, date: day(12), time: '16:00', problem: 'no-kid', nearMiss: { slug: 'adrian', name: 'Adrian', year: 2026 } },
      ],
      ...KNOBS.schedule,
    },
  };
}

function invitesData(phase) {
  const rehearsal = phase === 'rehearsal';
  const sched = phase === 'scheduled' || rehearsal;
  const preview = (name, status) => ({ title: status === 'confirmed' ? `${name}'s Reveal Day` : `${name}'s Reveal Day (tentative)`, status, start: { date: day(10) }, end: { date: day(11) }, location: '100 Example Way, Atlanta, GA 30301, USA', description: `This is the date for ${name}'s reveal.`, guests: [{ email: 'family@example.com', name: 'Pat Sample', kind: 'family' }, { email: 'cnielsen@soardcharity.com', name: 'Christian Nielsen', kind: 'staff' }] });
  return {
    ok: true,
    config: { enabled: true, organizer: 'ccunningham@soardcharity.com', template: DEFAULT_TEMPLATE, lastSweep: { at: iso(-60 * 60e3), checked: 20, changed: 0 } },
    checks: { enabled: false },
    organizerName: 'Clareece Cunningham',
    defaults: DEFAULT_TEMPLATE, limits: TEMPLATE_LIMITS,
    setup: { jobtread: true, google: true },
    upcoming: [
      { jobId: 'jobLiz0001', jobName: 'Lizzie Francis (2026)', name: 'Lizzie', slug: 'lizzie', space: 'Therapy Room', kidUrl: '/kids/lizzie/', jobUrl: 'https://app.jobtread.com/jobs/jobLiz0001', scheduleUrl: 'https://app.jobtread.com/jobs/jobLiz0001/schedule', date: day(5), time: null, confirmed: true, constructionStarted: true, status: 'Finalization', details: '', preview: preview('Lizzie', 'confirmed'),
        invite: { state: 'tentative', lastAction: 'created', error: 'Google said: Calendar usage limits exceeded.', updatedAt: iso(-3 * D), guests: 6, log: [{ action: 'created', state: 'tentative', guests: 6, date: day(5), at: iso(-3 * D) }] },
        broadcast: null, reminderSignups: 12, checkComment: { at: iso(-D), message: 'Christian, Lizzie\'s reveal is confirmed for Thursday but has no time yet.' } },
      { jobId: 'jobMax0001', jobName: `${rehearsal ? 'TEST ' : ''}Max Sample (2026)`, name: 'Max', slug: 'max', ...(rehearsal ? { test: true } : {}), kidUrl: '/kids/max/', jobUrl: 'https://app.jobtread.com/jobs/jobMax0001', scheduleUrl: 'https://app.jobtread.com/jobs/jobMax0001/schedule', date: day(10), time: '16:00', confirmed: true, constructionStarted: true, status: 'Build', details: 'Park on the street.', preview: preview('Max', 'confirmed'),
        invite: { state: 'confirmed', lastAction: 'updated', error: null, updatedAt: iso(-D), guests: 5, log: [{ action: 'created', state: 'tentative', guests: 5, date: day(10), at: iso(-6 * D) }, { action: 'updated', state: 'confirmed', guests: 5, date: day(10), at: iso(-D) }] },
        broadcast: sched ? { id: 'live-1', phase: 'scheduled', scheduledAt: maxAt, createdAt: iso(-D), kitLiveEmail: null, kit: { scheduledDraft: true, live: null }, sends: [{ kind: 'scheduled', channel: 'email', recipients: 12, sent: 12, failed: 0, created_at: iso(-D) }, { kind: 'scheduled', channel: 'push', recipients: 3, sent: 3, failed: 0, created_at: iso(-D) }] } : null,
        reminderSignups: 15, checkComment: null },
      { jobId: 'jobCol0001', jobName: 'Colin Lindsay (2026)', name: 'Colin', slug: 'colin', kidUrl: '/kids/colin/', jobUrl: 'https://app.jobtread.com/jobs/jobCol0001', scheduleUrl: 'https://app.jobtread.com/jobs/jobCol0001/schedule', date: day(25), time: null, confirmed: false, constructionStarted: false, status: 'Build', details: '',
        preview: { ...preview('Colin', 'tentative'), addsOnConfirm: [{ email: 'jacey@x.com', name: 'Jacey Verhoef', kind: 'vendor' }, { email: 'niki@x.com', name: 'Niki Murphy', kind: 'photographer' }] },
        invite: null, broadcast: null, reminderSignups: 12, checkComment: null },
    ],
    board: [{ slug: 'scott-wierson', name: 'Scott Wierson', hasEmail: true }, { slug: 'mary-atchley', name: 'Mary Atchley', hasEmail: false }],
    advisory: [{ slug: 'ada-advisor', name: 'Ada Advisor', hasEmail: true }, { slug: 'al-advisor', name: 'Al Advisor', hasEmail: false }],
    live: { phase: sched ? 'scheduled' : 'idle', jobId: sched ? 'jobMax0001' : null, scheduledAt: sched ? maxAt : null, waiting: { jobLiz0001: { problem: 'no-time', nearMiss: null } }, checkedAt: iso(-2 * 60e3), reminders: { enabled: true, hoursBefore: [24, 1] }, kit: { configured: true, enabled: true, audience: 'All subscribers' } },
  };
}

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

const TEAM = [
  { name: 'Scott Wierson', slug: 'scott-wierson', title: 'Board Chair', organization: 'Real Floors Commercial, CEO', group: 'board', order: 0 },
  { name: 'In memoriam, Brent Aronson', slug: 'brent-aronson', title: 'Board Member 2024-2025', group: 'board', order: 1 },
];
async function open(browser, base, viewport, phase, hash = '#broadcast', waitSel = '.bc-tabs') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  const posts = [];
  // Aborted requests log "Failed to load resource", and the live socket has no server here; skip those
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource') && !m.text().includes('/api/live-ws')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (req.method() === 'POST' && url.pathname.startsWith('/api/')) { try { posts.push({ path: url.pathname, body: JSON.parse(req.postData() || '{}') }); } catch { posts.push({ path: url.pathname, body: null }); } }
    if (url.pathname === '/api/broadcast-admin' && req.method() === 'GET') return json(adminData(phase));
    if (url.pathname === '/api/broadcast-admin' && req.method() === 'POST') {
      const action = JSON.parse(req.postData() || '{}').action;
      if (action === 'slackStatus') return json({ success: true, slack: KNOBS.slack?.status || { ok: true, bot: 'soard', channel: { id: 'C1', name: 'team-everyone' } } });
      if (action === 'slackChannels') return json({ success: true, channels: [{ id: 'C1', name: 'team-everyone' }, { id: 'C2', name: 'staff' }] });
      if (action === 'testInstagram') return json({ success: true, account: { ok: true, username: 'soardcharity' }, missing: [] });
      if (action === 'testFacebook') return json(KNOBS.fb || { success: true, token: { ok: true, name: 'Sunshine on a Ranney Day' }, recent: { videos: [{}, {}] }, info: { appId: '123', scopes: ['pages_manage_posts'], missingForApiMode: [], appReviewUrl: 'https://developers.facebook.com/apps/123/app-review', appSettingsUrl: 'https://developers.facebook.com/apps/123/settings/basic' } });
      return json({ success: true, action: 'none', schedule: adminData(phase).schedule });
    }
    if (url.pathname === '/api/broadcast') return json({ success: true, state: adminData(phase).public });
    if (url.pathname === '/api/reveal-invites-admin' && url.searchParams.get('board') === '1') return json({ ok: true, board: [{ slug: 'scott-wierson', name: 'Scott Wierson', email: null, memorial: false }] });
    if (url.pathname === '/api/reveal-invites-admin' && req.method() === 'POST') return json({ ok: true, board: [] });
    if (url.pathname === '/api/reveal-invites-admin') return json(invitesData(phase));
    if (url.pathname === '/api/list-content' && (url.searchParams.get('dir') || '').includes('team')) return json({ success: true, items: TEAM.map((t) => ({ name: `${t.slug}.json`, path: `src/content/team/${t.slug}.json`, sha: t.slug, content: t })), total: TEAM.length, hasMore: false });
    if (url.pathname === '/api/read-content' && (url.searchParams.get('path') || '').includes('src/content/team/')) { const t = TEAM.find((x) => url.searchParams.get('path').endsWith(`${x.slug}.json`)); return json({ success: true, content: JSON.stringify(t), sha: t.slug }); }
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    return req.continue();
  });
  await page.goto(`${base}/admin/${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector(waitSel, { timeout: 15000 });
  if (hash === '#broadcast') await page.waitForSelector('.rt-list', { timeout: 15000 });
  return { page, errors, posts };
}

const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const rowOf = (name) => `[...document.querySelectorAll('.rt-item')].find((li) => li.querySelector('.rt-toggle strong')?.textContent === ${JSON.stringify(name)})`;
const stepsOf = (page, name) => page.evaluate(`(() => { const li = ${rowOf(name)}; return li ? [...li.querySelectorAll('.rt-step')].map((s) => ({ label: s.querySelector('.rt-label').textContent, state: [...s.classList].find((c) => c.startsWith('rt-step--')).slice(9), text: s.querySelector('.rt-text').textContent.replace(/^(Done|Not yet|Needs attention|Problem|Off): /, '') })) : null; })()`);
const clickToggle = (page, name) => page.evaluate(`${rowOf(name)}.querySelector('.rt-toggle').click()`);
const clickButton = (page, scope, label) => page.evaluate((scope, label) => { const b = [...document.querySelectorAll(`${scope} button`)].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; }, scope, label);

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  console.log('Laptop, a reveal JobTread scheduled');
  const { page, errors, posts } = await open(browser, base, { width: 1440, height: 1000 }, 'scheduled');
  ok((await text(page, '.page-sub')).startsWith('Reveals are scheduled in JobTread'), 'the page says reveals are scheduled in JobTread');
  ok(!(await page.$('input[type="datetime-local"]')), 'there is no date picker: nothing is scheduled by hand');
  ok(!(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Schedule reveal|Cancel reveal/.test(b.textContent)))), 'no Schedule or Cancel buttons');
  ok((await text(page, '.bc-title')) === "Max's room reveal", 'the status card shows the reveal JobTread scheduled');
  const status = await text(page, '.bc-status');
  ok(status.includes('From JobTread. To move or cancel it'), 'it says the countdown came from JobTread and how to change it');
  ok(status.includes('Checked JobTread 2m ago'), 'it says when JobTread was last checked');
  ok(await page.$eval('.bc-links', (e) => [...e.querySelectorAll('a')].some((a) => a.href.endsWith('/jobs/jobMax0001/schedule') && a.textContent.includes('Change it in JobTread'))), 'links to the job schedule in JobTread');
  ok((await text(page, '.bc-status .bc-note')).includes("Lizzie's reveal is confirmed for") && (await text(page, '.bc-status .bc-note')).includes('has no time'), 'a confirmed reveal with no time says why its countdown can\'t go up');
  const notes = await page.$$eval('.bc-status .bc-note', (n) => n.map((x) => x.textContent));
  ok(notes.some((t) => t.includes("Adrian's page is filed under 2026") && t.includes('make the years agree')), 'a job and kid page filed under different years says exactly what to change');

  const rows = await page.$$eval('.rt-item .rt-toggle strong', (s) => s.map((x) => x.textContent));
  ok(rows.join(',') === 'Lizzie,Max,Colin', `the tracker lists every upcoming reveal, soonest first (${rows.join(', ')})`);
  ok(await page.evaluate(`${rowOf('Lizzie')}.classList.contains('is-open')`), 'the soonest reveal starts open');
  const liz = await stepsOf(page, 'Lizzie');
  ok(liz.find((s) => s.label === 'Confirmed calendar invite')?.state === 'error' && liz.find((s) => s.label === 'Confirmed calendar invite').text.includes('usage limits'), 'a failed invite shows the error on the step it blocks');
  ok(await page.evaluate(`!!${rowOf('Lizzie')}.querySelector('.rt-step--error button')`), 'with a Retry button');
  ok(liz.find((s) => s.label.startsWith('Countdown'))?.text.includes('Waiting for a time'), 'the countdown step says it waits for a time');
  ok(liz.some((s) => s.label === 'Reveal check comment in JobTread'), 'the reveal-check comment for the PM is listed');
  ok((await text(page, `.rt-item:first-child .rt-chips`)).includes('Invite failed'), 'the row is flagged without opening it');

  await clickToggle(page, 'Max');
  await pause(150);
  ok(await page.evaluate(`${rowOf('Max')}.classList.contains('is-open') && !${rowOf('Lizzie')}.classList.contains('is-open')`), 'opening another reveal closes the first');
  const max = await stepsOf(page, 'Max');
  const step = (label) => max.find((s) => s.label === label) || {};
  ok(step('Tentative calendar invite').state === 'done' && step('Tentative calendar invite').text.startsWith('Sent ') && step('Tentative calendar invite').text.endsWith('to 5 people'), `tentative invite: ${step('Tentative calendar invite').text}`);
  ok(step('Confirmed calendar invite').state === 'done', `confirmed invite: ${step('Confirmed calendar invite').text}`);
  ok(step('Countdown and reminder signup on the site').text.startsWith('On the site since'), 'countdown: on the site');
  ok(step('Save-the-date reminder').text.includes('12 emails, 3 browser alerts'), `save the date: ${step('Save-the-date reminder').text}`);
  ok(step('Day-before reminder').state === 'wait' && step('Day-before reminder').text.startsWith('Goes out '), `day before: ${step('Day-before reminder').text}`);
  ok(step('"We\'re live" email to the Kit list').text.includes('All subscribers'), 'Kit email: who it goes to');
  ok((await text(page, `.rt-item:nth-child(2) .rt-chips`)).includes('Countdown on the site'), 'the reveal with the countdown is marked in the list');
  ok(/\d+ of \d+/.test(await text(page, '.rt-item:nth-child(2) .rt-progress')), `progress shows (${await text(page, '.rt-item:nth-child(2) .rt-progress')})`);
  await page.evaluate(`${rowOf('Max')}.querySelector('.rt-preview summary').click()`);
  await pause(100);
  ok((await text(page, '.rt-item:nth-child(2) .rt-preview')).includes("Max's Reveal Day") && (await text(page, '.rt-item:nth-child(2) .rt-preview')).includes('Pat Sample (family)'), 'the invite preview shows the invite and its guests');
  await page.screenshot({ path: join(OUT, 'now-scheduled.png'), fullPage: true });

  await clickToggle(page, 'Colin');
  await pause(150);
  const col = await stepsOf(page, 'Colin');
  ok(col.find((x) => x.label === 'Confirmed calendar invite').text.includes('adding Jacey Verhoef (vendor) and Niki Murphy (photographer)'), `the tentative reveal says who confirming adds (${col.find((x) => x.label === 'Confirmed calendar invite').text})`);

  console.log('Actions');
  ok(await clickButton(page, '.bc-status', 'Customize'), 'Customize opens');
  await page.waitForSelector('#bc-edit-title');
  ok(!(await page.$('#bc-edit-kid')) && !(await page.$('input[type="datetime-local"]')), 'Customize has no kid or date fields');
  await page.$eval('#bc-edit-title', (e) => { e.value = ''; });
  await page.type('#bc-edit-title', "Max's big reveal");
  await clickButton(page, '.bc-form', 'Save changes');
  await pause(300);
  const upd = posts.find((x) => x.path === '/api/broadcast' && x.body?.action === 'update' && x.body.title);
  ok(upd && upd.body.title === "Max's big reveal" && !('scheduledAt' in upd.body), 'saving sends only the changed title');
  ok(await clickButton(page, '.bc-status', 'Turn off'), 'the Kit email switch is on the card');
  await pause(300);
  ok(posts.some((x) => x.path === '/api/broadcast' && x.body?.action === 'update' && x.body.kitLiveEmail === false), 'turning it off sends kitLiveEmail: false');
  // The site checks JobTread every 5 minutes: no standing button while that works
  const hasButton = (pg, scope, label) => pg.evaluate((scope, label) => [...document.querySelectorAll(`${scope} button`)].some((x) => x.textContent.trim() === label), scope, label);
  ok(!(await hasButton(page, '.bc-status', 'Check JobTread now')) && !(await hasButton(page, '.bc-status', 'Check now')), 'no Check now button while the JobTread check is fresh');
  const syncs = () => posts.filter((x) => x.path === '/api/broadcast-admin' && x.body?.action === 'syncSchedule').length;
  const before = syncs();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await pause(400);
  ok(syncs() === before + 1, 'coming back to the tab (after changing the reveal in JobTread) checks JobTread right away');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await pause(300);
  ok(syncs() === before + 1, 'but not again within a minute');
  ok(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await page.close();

  console.log('JobTread check failing');
  KNOBS.schedule = { checkedAt: iso(-25 * 60e3), error: 'JobTread returned 500' };
  const stale = await open(browser, base, { width: 1440, height: 1000 }, 'scheduled');
  ok((await text(stale.page, '.bc-status')).includes('JobTread returned 500'), 'the card says why the check failed');
  ok(await clickButton(stale.page, '.bc-status', 'Check JobTread now'), 'and only then offers Check JobTread now');
  await pause(300);
  ok(stale.posts.some((x) => x.path === '/api/broadcast-admin' && x.body?.action === 'syncSchedule'), 'which asks the server to check JobTread');
  ok(stale.errors.length === 0, `no console errors (${stale.errors.join(' | ')})`);
  await stale.page.close();
  KNOBS.schedule = {};

  console.log('Settings: checks run on their own');
  KNOBS.setup = { slackMode: 'bot' };
  const set = await open(browser, base, { width: 1440, height: 1000 }, 'scheduled', '#broadcast/settings', '.bc-settings');
  await set.page.waitForFunction(() => !document.querySelector('#bc-set-checks')?.textContent.includes('Checking…'), { timeout: 10000 }).catch(() => {});
  const acts = set.posts.filter((x) => x.path === '/api/broadcast-admin').map((x) => x.body?.action);
  ok(['runTick', 'testStream', 'testHub'].every((a) => acts.includes(a)), `opening Settings runs the live checks (${acts.join(', ')})`);
  ok((await text(set.page, '#bc-set-checks')).includes('All required checks pass'), 'all pass');
  ok(!(await hasButton(set.page, '#bc-set-checks', 'Run checks')) && !(await hasButton(set.page, '#bc-set-checks', 'Check again')), 'and there is no button to run them');
  ok(!(await set.page.evaluate(() => [...document.querySelectorAll('.bc-settings button')].some((b) => b.textContent.trim() === 'Check again'))), 'Slack is fine, so it has no Check again either');
  ok(!(await set.page.evaluate(() => [...document.querySelectorAll('.bc-settings button')].some((b) => b.textContent.trim() === 'Send test'))) && await set.page.evaluate(() => [...document.querySelectorAll('.bc-settings button')].some((b) => b.textContent.trim() === 'Send it to me')), 'the reminder preview is "Send it to me"');
  ok(acts.includes('testFacebook') && acts.includes('refreshInput') && acts.includes('testInstagram'), 'it checks Facebook, the phone input and (Reels are on here) Instagram too');
  ok((await text(set.page, '#bc-set-instagram')).includes('Linked Instagram: @soardcharity') && (await text(set.page, '#bc-set-instagram')).includes('Ready to post'), 'Instagram says it is linked');
  const fbText = await text(set.page, '#bc-set-facebook');
  ok(fbText.includes('Connected to "Sunshine on a Ranney Day"') && fbText.includes('Every permission automatic mode needs is granted') && !fbText.includes('App Review helper'), 'Facebook says it is connected, in one line');
  ok(!(await set.page.evaluate(() => [...document.querySelectorAll('.bc-settings button')].some((b) => ['Test connection', 'Refresh', 'Run checks', 'Send test alert'].includes(b.textContent.trim())))), 'no Test connection, Refresh, Run checks or Send test alert buttons anywhere in Settings');
  ok((await text(set.page, '#bc-set-alerts')).includes('Anyone you add gets a short hello email when you save'), 'Alerts says a new address gets a hello instead');
  ok(set.errors.length === 0, `no console errors (${set.errors.join(' | ')})`);
  await set.page.close();

  console.log('Settings: something needs a fix');
  KNOBS.setup = { slackMode: 'bot', deployHook: false };
  KNOBS.slack = { status: { ok: false, error: 'not_in_channel', errorFor: 'news', bot: 'soard', channel: { id: 'C2', name: 'staff' } } };
  KNOBS.fb = { success: false, token: { ok: false, error: 'Session has expired' }, recent: null, info: { appId: '123', scopes: [], missingForApiMode: ['publish_video'], appReviewUrl: 'https://developers.facebook.com/apps/123/app-review', appSettingsUrl: 'https://developers.facebook.com/apps/123/settings/basic' } };
  const fixy = await open(browser, base, { width: 1440, height: 1000 }, 'scheduled', '#broadcast/settings', '.bc-settings');
  await fixy.page.waitForFunction(() => !document.querySelector('#bc-set-checks')?.textContent.includes('Checking…'), { timeout: 10000 }).catch(() => {});
  ok((await text(fixy.page, '#bc-set-checks')).includes('1 needs a fix'), 'the missing deploy hook needs a fix');
  ok(await hasButton(fixy.page, '#bc-set-checks', 'Check again'), 'so the checks offer Check again');
  const slackChecks = () => fixy.posts.filter((x) => x.body?.action === 'slackStatus').length;
  ok(await fixy.page.evaluate(() => [...document.querySelectorAll('.bc-settings button')].filter((b) => b.textContent.trim() === 'Check again').length === 3), 'and Slack (needs inviting to its channel) and Facebook (token expired) offer one too');
  const fbFail = await text(fixy.page, '#bc-set-facebook');
  ok(fbFail.includes('Failed: Session has expired') && fbFail.includes('App Review helper') && fbFail.includes('publish_video'), 'a failing Facebook says why and shows the App Review details');
  const n0 = slackChecks();
  await fixy.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await pause(400);
  ok(slackChecks() === n0 + 1, 'coming back from Slack checks Slack again by itself');
  await fixy.page.screenshot({ path: join(OUT, 'settings-needs-fix.png'), fullPage: false });
  ok(fixy.errors.length === 0, `no console errors (${fixy.errors.join(' | ')})`);
  await fixy.page.close();
  KNOBS.setup = {};
  KNOBS.slack = null;
  KNOBS.fb = null;

  console.log('Laptop, nothing scheduled');
  const idle = await open(browser, base, { width: 1440, height: 1000 }, 'idle');
  ok((await text(idle.page, '.bc-title')) === 'No reveal scheduled', 'idle says no reveal is scheduled');
  ok((await text(idle.page, '.bc-meta')).includes('goes up on its own once a reveal is confirmed in JobTread'), 'and how one gets scheduled');
  ok(!(await idle.page.$('input[type="datetime-local"]')) && !(await idle.page.$('.bc-form')), 'no schedule form where it used to be');
  const order = await idle.page.evaluate(() => { const t = document.querySelector('.rt'); const s = document.querySelector('.bc-status'); return !!(t && s && (s.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)); });
  ok(order, 'the tracker sits under the status card, where the form was');
  await clickToggle(idle.page, 'Max');
  await pause(100);
  const mi = await stepsOf(idle.page, 'Max');
  ok(mi.find((s) => s.label.startsWith('Countdown')).text.startsWith('Goes up at the next JobTread check'), 'a confirmed reveal with no countdown yet says when it goes up');
  ok(mi.find((s) => s.label === 'Save-the-date reminder').text.includes('15 people so far'), 'save the date says how many asked for reminders');
  ok(idle.errors.length === 0, `no console errors (${idle.errors.join(' | ')})`);
  await idle.page.screenshot({ path: join(OUT, 'now-idle.png'), fullPage: true });
  await idle.page.close();

  console.log('Rehearsal from a JobTread TEST job');
  const reh = await open(browser, base, { width: 1440, height: 1000 }, 'rehearsal');
  ok((await text(reh.page, '.bc-phase')).includes('Rehearsal'), 'the status card is marked Rehearsal');
  ok((await text(reh.page, '.bc-status')).includes('The public site shows nothing, and reminders go only to the test address'), 'it says the public sees nothing and who gets reminders');
  ok((await text(reh.page, '.rt-item:nth-child(2) .rt-chips')).includes('Rehearsal'), 'the tracker marks the rehearsal row');
  await clickToggle(reh.page, 'Max');
  await pause(150);
  const rs = await stepsOf(reh.page, 'Max');
  ok(rs.find((x) => x.label === 'Save-the-date reminder').text.endsWith('(test address only)'), 'its reminders say they went to the test address only');
  ok(rs.find((x) => x.label.includes('Kit list')).text === 'Never for a rehearsal', 'and no Kit email, ever');
  ok(reh.errors.length === 0, `no console errors (${reh.errors.join(' | ')})`);
  await reh.page.screenshot({ path: join(OUT, 'now-rehearsal.png'), fullPage: false });
  await reh.page.close();

  console.log('Invites tab');
  const inv = await open(browser, base, { width: 1440, height: 1000 }, 'scheduled', '#broadcast/invites');
  await inv.page.waitForSelector('.ri-wording', { timeout: 15000 });
  const invText = await text(inv.page, '#bc-panel');
  ok(!invText.includes('Upcoming reveals'), 'the upcoming list moved off the Invites tab');
  ok(invText.includes('Calendar invites are on') && invText.includes('Reveal checks are paused') && invText.includes('Invite wording'), 'the switches and the wording stay');
  ok(invText.includes('Who gets the invites') && invText.includes('adds the vendors, sponsors, photographers and design partners'), 'it explains the two stages');
  ok(invText.includes('1 of 2 board members') && invText.includes('Missing: Mary Atchley'), 'it says which board members still need an email');
  ok(invText.includes('the board and the Advisory Board') && invText.includes('1 of 2 advisors') && invText.includes('Missing: Al Advisor') && invText.includes('People → Advisory'),
    'and which advisors, who get the invites too');
  // The wording preview matches what the server sends at each stage
  const cards = await inv.page.$$eval('.ri-kind', (els) => els.map((el) => el.querySelector('.ri-invite')?.innerText || ''));
  const [tent, conf] = cards;
  ok(/\(tentative\)/.test(tent) && /All day/.test(tent), 'the tentative preview is a name-first, all-day save-the-date');
  ok(/Lizzie's therapy room reveal is penciled in/.test(tent) && /sees the new therapy room/.test(conf), "{space} names what was built, from the job's Makeover Type");
  ok(/Where\s*100 Example Way/.test(tent) && /Where\s*100 Example Way/.test(conf), 'both stages show the full address');
  ok(/Shows as\s*Free/.test(tent) && /Shows as\s*Busy/.test(conf), 'free until there is a confirmed time, then busy');
  ok(/^Meet \w+: https:\/\/sunshineonaranneyday\.com\/kids\//m.test(tent) && /^Watch live from anywhere: /m.test(tent) && /^Questions\? Email Clareece Cunningham at ccunningham@soardcharity\.com\.$/m.test(tent) && /^Sunshine on a Ranney Day$/m.test(tent), 'labeled links and who to ask, as the server writes them');
  const testUrls = [];
  inv.page.on('request', (r) => { if (r.url().includes('test=')) testUrls.push(r.url()); });
  const testButtons = await inv.page.$$eval('.ri-savebar button', (els) => els.map((b) => b.textContent.trim()).filter((t) => t.startsWith('Send me')));
  ok(testButtons.length === 2 && testButtons[0].endsWith('tentative invite') && testButtons[1].endsWith('confirmed invite'), `a test of each stage (${testButtons.join(' / ')})`);
  await inv.page.evaluate(() => [...document.querySelectorAll('.ri-savebar button')].find((b) => b.textContent.trim().endsWith('confirmed invite'))?.click());
  await pause(400);
  ok(testUrls.some((u) => u.includes('stage=confirmed')), 'the confirmed test asks for the confirmed stage');
  const wording = await inv.page.$('.ri-wording');
  if (wording) await wording.screenshot({ path: join(OUT, 'invites-wording.png') });
  ok(inv.errors.length === 0, `no console errors (${inv.errors.join(' | ')})`);
  await inv.page.close();

  console.log('People → Board member');
  const ppl = await open(browser, base, { width: 1440, height: 1000 }, 'idle', '', 'nav, .sidebar, aside');
  const clicked = await ppl.page.evaluate(() => { const el = [...document.querySelectorAll('a, button')].find((x) => x.textContent.trim() === 'People'); if (el) el.click(); return !!el; });
  ok(clicked, 'People is in the sidebar');
  await pause(400);
  await ppl.page.evaluate(() => [...document.querySelectorAll('button.hub-tab')].find((b) => b.textContent.trim().startsWith('Board'))?.click()); // "Board" plus its count
  await pause(400);
  // People → Board lists rows (PeopleList); a board member's editor (PersonEditor) has the invite email
  await ppl.page.evaluate(() => [...document.querySelectorAll('.ppl-row__name')].find((n) => n.textContent.includes('Scott Wierson'))?.click());
  await ppl.page.waitForSelector('#ppl-email', { timeout: 10000 }).catch(() => {});
  ok(!!(await ppl.page.$('#ppl-email')), 'a board member has an email field for reveal invites');
  ok((await text(ppl.page, '.card:has(#ppl-email)')).includes('Private: never shown on the site'), 'it says the email is private');
  await ppl.page.waitForFunction(() => !document.querySelector('#ppl-email')?.disabled);
  await ppl.page.type('#ppl-email', 'Scott@Example.com');
  // One Save writes the record and the private email
  await ppl.page.evaluate(() => document.querySelector('.ppl-ed-head .btn-primary')?.click());
  await ppl.page.waitForFunction(() => !document.querySelector('.ppl-unsaved'), { timeout: 5000 }).catch(() => {});
  await pause(300);
  const bp = ppl.posts.find((x) => x.path === '/api/reveal-invites-admin' && x.body?.boardEmail);
  ok(bp && bp.body.boardEmail.slug === 'scott-wierson' && bp.body.boardEmail.email === 'scott@example.com', 'saving sends it to the private store, not the public record');
  ok(!ppl.posts.some((x) => x.path === '/api/save-content' && JSON.stringify(x.body).includes('scott@example.com')), 'the email never goes into the saved (GitHub-committed) record');
  await ppl.page.evaluate(() => document.querySelector('.breadcrumb button')?.click()); // back to the list
  await ppl.page.waitForFunction(() => [...document.querySelectorAll('.ppl-row__name')].some((n) => n.textContent.includes('Brent Aronson')), { timeout: 5000 }).catch(() => {});
  await ppl.page.evaluate(() => [...document.querySelectorAll('.ppl-row__name')].find((n) => n.textContent.includes('Brent Aronson'))?.click());
  await pause(800);
  ok((await text(ppl.page, '.page-header h2')).includes('Brent Aronson'), `the memorial entry opens (${await text(ppl.page, '.page-header h2')})`);
  ok((await ppl.page.evaluate(() => [...document.querySelectorAll('.card')].some((c) => /reveal invites/i.test(c.textContent) && c.textContent.includes('Memorial entries are never invited')))), 'a memorial entry says it is never invited');
  ok(ppl.errors.length === 0, `no console errors (${ppl.errors.join(' | ')})`);
  await ppl.page.screenshot({ path: join(OUT, 'people-board.png'), fullPage: false });
  await ppl.page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true }, 'scheduled');
  await clickToggle(phone.page, 'Max');
  await pause(150);
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no sideways scroll at 390px (${overflow}px)`);
  const rowFits = await phone.page.evaluate(() => [...document.querySelectorAll('.rt-row')].every((r) => r.scrollWidth <= r.clientWidth + 1));
  ok(rowFits, 'tracker rows fit the phone');
  const tap = await phone.page.evaluate(() => Math.min(...[...document.querySelectorAll('.rt-toggle')].map((b) => b.getBoundingClientRect().height)));
  ok(tap >= 36, `row toggles are big enough to tap (${Math.round(tap)}px)`);
  ok(phone.errors.length === 0, `no console errors on a phone (${phone.errors.join(' | ')})`);
  await phone.page.screenshot({ path: join(OUT, 'now-phone.png'), fullPage: true });
  await phone.page.close();
} finally {
  await browser.close();
  server.close();
}

if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nAll passed');
