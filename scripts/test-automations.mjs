/**
 * test-automations.mjs — drive Site → Automations in a real browser
 * =================================================================
 * Opens the admin at #automations (public/ served directly, every /api call
 * stubbed; /api/automations-admin answers with facts shaped like production)
 * and checks the mindmap: it draws and fits, live facts override the written
 * statuses, the side panel lists what needs attention, groups open in place,
 * no two labels overlap with everything open and labels stay readable, the
 * panel follows clicks and keyboard, filters, search and "Depends on" dim the
 * rest, a failed live check falls back to the written map, and the page fits
 * a phone. Screenshots land in test-results/automations/. Exits non-zero on
 * any failure or console error.
 *
 *   node scripts/test-automations.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/automations/');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
// Shaped like production on October 16, 2026
const FACTS = {
  success: true,
  checkedAt: iso(0),
  env: { slack: false, twilio: false, youtube: false, kit: true, resend: true, calendar: true, jobtread: true, facebook: true, stream: true, images: true, deployHook: true, github: true, access: true, constantContact: true, turnstile: true },
  bindings: { db: true, files: true, ai: true, hub: true },
  broadcast: { inputEnabled: true, outputs: { facebook: true, youtube: null, instagram: null }, facebookMode: 'api', reels: false, reminders: { enabled: false, sms: false, push: false }, kitLive: true, messages: true, vapid: true, alertCount: 1, updatedAt: iso(2 * 86400e3) },
  health: { lastTickAt: iso(60e3), lastTickSource: 'hub:alarm', lastDailyAt: iso(86400e3), hubOk: true, streamOk: true, facebookOk: true, webhookAt: iso(2 * 86400e3), webhookEvent: 'live_input.disconnected', replayCheckAt: iso(2 * 86400e3), monitorAt: iso(2 * 86400e3) },
  hub: { ok: true, current: false, lastTickAt: iso(40e3), clients: 2, error: null },
  invites: { enabled: true, lastSweepAt: iso(30 * 60e3), lastGuestCheckAt: iso(2 * 60e3), checked: 20, changed: 0, errors: 0, rows: 3 },
  revealChecks: { enabled: false, lastRunAt: null, checked: null, posted: null, repaired: null, errors: null, lastErrorAt: null, syncedAt: iso(10 * 60e3), syncedJobs: 1 },
  fbArchive: { checkedAt: iso(60 * 60e3), archived: 3, needsKid: 1, lastAutoDeployAt: iso(17 * 86400e3) },
  kidStatus: { lastSweepAt: iso(20 * 60e3), lastRunAt: iso(5 * 60e3), changed: 1, lastErrorAt: iso(60 * 60e3), deployPending: false, lastAutoDeployAt: iso(5 * 60e3), hidden: 1 },
  reveals: { cachedAt: iso(5 * 60e3) },
  sends: { live: { kit: { last: iso(2 * 86400e3), sent: 1, failed: 0 } } },
  reminders: { subscribers: 4 },
  jobtread: {
    workflows: Object.fromEntries([
      ['22PJYm7aXBgK', true], ['22PJxRJ37KSs', true], ['22PJxRLV9Y3i', true], ['22PRvF7pG9VM', false], ['22PZF9ENDgxn', false],
      ['22PgHVceQhvW', true], ['22PgHVcgDXFN', true], ['22PgPECxg6UP', true], ['22PgPED4vi7W', true], ['22PgQQ6JnJDm', true], ['22PgYwQvKkTs', true]
    ].map(([id, active]) => [id, { name: id, active }])),
    webhooks: Object.fromEntries(['22PDDmxBcvpA', '22PJxV5yimrd', '22P5rFX2hhQW', '22PRvE87suYz', '22PaN5dFNj8s', '22PXNK6fZGzA'].map((id) => [id, { where: 'example.com/x', events: [] }])),
  },
};

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

async function open(browser, base, viewport, { facts = FACTS } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  // Requests this test aborts (fonts, analytics, the live socket) and the failing facts call log "Failed to load resource"; skip those
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (url.pathname === '/api/automations-admin') return facts ? json({ ...facts, checkedAt: iso(0) }) : json({ success: false, error: 'JobTread timed out' }, 500);
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    return req.continue();
  });
  await page.goto(`${base}/admin/#automations`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.am-canvas svg .am-node.d1', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.am-canvas svg')?.getAttribute('style')?.includes('opacity: 0'));
  await page.waitForFunction(() => !document.querySelector('.am-check')?.textContent.includes('Checking'));
  return { page, errors };
}

const nodeBy = (label) => `[...document.querySelectorAll('.am-node')].find((n) => n.querySelector('text')?.textContent === ${JSON.stringify(label)})`;
const boxOf = (page, label) => page.evaluate(`(() => { const g = ${nodeBy(label)}; if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const clickNode = (page, label) => page.evaluate(`${nodeBy(label)}.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
const panelTitle = (page) => page.$eval('.am-panel h3', (e) => e.textContent).catch(() => null);
const clickButton = (page, scope, text) => page.evaluate((scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === text).click(), scope, text);
// Status of an entry by its title, read from the written-out list
const statusOf = (page, title) => page.evaluate((title) => {
  const li = [...document.querySelectorAll('.am-inv-branch li')].find((l) => l.querySelector('b')?.textContent === title);
  return li ? li.querySelector('.am-meta').textContent.split(' · ')[0] : null;
}, title);

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  console.log('Desktop, live facts');
  const { page, errors } = await open(browser, base, { width: 1440, height: 1000 });
  ok(await page.$eval('.page-header h2', (e) => e.textContent) === 'Automations', 'the page opens from #automations');
  ok((await page.$eval('.am-check', (e) => e.textContent)).includes('Statuses checked live'), 'it says the statuses were checked live');
  const branches = await page.$$eval('.am-node.d1 text', (t) => t.map((x) => x.textContent));
  ok(branches.length === 6, `${branches.length} branches drawn (${branches.join(', ')})`);
  const canvasTop = await page.$eval('.am-canvas', (e) => e.getBoundingClientRect().top);
  ok(canvasTop < 360, `the map starts above the fold on a laptop (${Math.round(canvasTop)}px down)`);
  const inView = await page.evaluate(() => {
    const c = document.querySelector('.am-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.am-node')].every((n) => { const r = n.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; });
  });
  ok(inView, 'the opening view fits the whole map in the canvas');

  for (const [title, want] of [
    ['Instagram Reel', 'Off'], ['Reminder emails', 'Off'], ['Browser push reminders', 'Off'], ['Text reminders', 'Off'],
    ['Simulcast to Facebook', 'Live'], ['Simulcast to YouTube', 'Needs attention'], ['Live hub', 'Needs attention'],
    ['Slack posts', 'Off'], ['Facebook replay rescue', 'Needs attention'], ['Invite engine', 'Live'],
    ['Reveal date sync', 'Live'], ['Application In Review comment', 'Off'],
    ['Reveal checks for PMs', 'Off'], ['Kid status follows JobTread', 'Live'],
  ]) ok(await statusOf(page, title) === want, `${title}: ${want}`);

  const attnItems = await page.$$eval('.am-panel .am-mini li', (l) => l.length);
  ok((await page.$eval('.am-panel', (e) => e.textContent)).includes('Needs attention') && attnItems >= 5, `the side panel lists what needs attention and what's parked (${attnItems} entries)`);
  ok((await page.$eval('.am-lede .am-warnstat b', (e) => e.textContent)) === '3', 'the lede counts 3 needing attention');
  await page.screenshot({ path: join(OUT, 'desktop.png'), fullPage: false });

  const before = await boxOf(page, 'Calendar invites');
  await clickNode(page, 'Calendar invites');
  await pause(400);
  const after = await boxOf(page, 'Calendar invites');
  // Right-side groups keep their left edge (the count badge on the far end goes away when open)
  ok(before && after && Math.abs(before.y + before.h / 2 - (after.y + after.h / 2)) < 2 && Math.abs(before.x - after.x) < 2, 'opening a group keeps it in place on screen');
  ok(!!(await boxOf(page, 'Invite engine')), 'its items appear');
  ok(await panelTitle(page) === 'Calendar invites', 'the panel shows the clicked group');

  await clickNode(page, 'Invite engine');
  ok(await panelTitle(page) === 'Invite engine', 'clicking an item shows it in the panel');
  const panelText = await page.$eval('.am-panel', (e) => e.textContent);
  ok(panelText.includes('Checked live') && panelText.includes('Right now') && panelText.includes('3 reveals have an invite'), 'the panel shows the live check and its numbers');
  ok(panelText.includes('Last ran 30 min ago'), 'and when it last ran');

  await clickButton(page, '.am-panel .am-tags', 'Google Calendar');
  await pause(400);
  ok(await panelTitle(page) === 'If Google Calendar stops working', 'a service tag opens its dependents');
  ok(/\d+ match/.test(await page.$eval('.am-hits', (e) => e.textContent)), 'and highlights them on the map');
  await page.select('#am-svc', 'Resend');
  await pause(400);
  const resendCount = await page.$$eval('.am-panel .am-mini li', (l) => l.length);
  ok(await panelTitle(page) === 'If Resend stops working' && resendCount >= 8, `"Depends on" lists everything that uses Resend (${resendCount})`);
  await page.screenshot({ path: join(OUT, 'desktop-depends.png'), fullPage: false });

  await clickButton(page, '.am-tools', 'Open all');
  await pause(500);
  const overlaps = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('.am-node text')].map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }));
    const bad = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) bad.push(`${rects[i].t} × ${rects[j].t}`);
    }
    const leaf = document.querySelector('.am-node.leaf text');
    const size = leaf.getBoundingClientRect().height;
    return { bad, count: rects.length, size };
  });
  ok(overlaps.bad.length === 0, `no labels overlap with all ${overlaps.count} open${overlaps.bad.length ? ': ' + overlaps.bad.slice(0, 5).join('; ') : ''}`);
  ok(overlaps.size >= 11, `labels stay readable with everything open (${overlaps.size.toFixed(1)}px line box)`);
  ok((await page.$eval('.am-canvas', (e) => e.getBoundingClientRect().height)) > 900, 'the canvas grows to hold everything');
  const clipped = await page.evaluate(() => {
    const c = document.querySelector('.am-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.am-node text')].filter((t) => { const r = t.getBoundingClientRect(); return r.left < c.left || r.right > c.right; }).map((t) => t.textContent);
  });
  ok(clipped.length === 0, `no label is cut off at the sides with everything open${clipped.length ? ': ' + clipped.slice(0, 4).join(', ') : ''}`);
  await page.screenshot({ path: join(OUT, 'desktop-all-open.png'), fullPage: false });

  await clickButton(page, '.am-tools', 'Reset');
  await pause(300);
  ok((await page.$eval('.am-canvas', (e) => e.getBoundingClientRect().height)) < 800, 'Reset brings the canvas back');
  await clickButton(page, '.am-filters', 'Needs a look');
  await pause(400);
  ok(/\d+ match/.test(await page.$eval('.am-hits', (e) => e.textContent)), 'the Needs a look filter reports matches');
  ok((await page.$$('.am-node.dim')).length > 0 && (await page.$$('.am-node.hit-on')).length > 0, 'the filter highlights matches and dims the rest');

  await clickButton(page, '.am-tools', 'Reset');
  await page.type('#am-search', 'slack');
  await pause(500);
  ok(!!(await boxOf(page, 'Slack posts')), 'search opens the branch holding the match');

  await clickButton(page, '.am-tools', 'Reset');
  await pause(300);
  const firstAttn = await page.$eval('.am-panel .am-mini li button > span:not(.am-dot-i)', (e) => e.firstChild.textContent);
  await page.click('.am-panel .am-mini li button');
  await pause(400);
  ok(await panelTitle(page) === firstAttn, `the attention list opens “${firstAttn}”`);
  ok(!!(await boxOf(page, firstAttn)), 'and shows it on the map');
  await page.click('.am-close');
  ok((await page.$eval('.am-panel', (e) => e.textContent)).startsWith('Needs attention'), 'closing returns the panel to the attention list');

  await clickButton(page, '.am-tools', 'Reset');
  await page.$eval('.am-node.d1', (g) => g.focus());
  const firstBranch = await page.$eval('.am-node.d1 text', (e) => e.textContent);
  const expBefore = await page.$eval('.am-node.d1', (e) => e.getAttribute('aria-expanded'));
  await page.keyboard.press('Enter');
  await pause(300);
  const expAfter = await page.evaluate(`${nodeBy(firstBranch)}.getAttribute('aria-expanded')`);
  ok(expBefore !== expAfter, 'Enter on a focused branch opens or closes it');

  const t0 = await page.$eval('.am-canvas svg > g', (g) => g.getAttribute('transform'));
  await page.click('.am-zoom button[aria-label="Zoom in"]');
  ok(t0 !== await page.$eval('.am-canvas svg > g', (g) => g.getAttribute('transform')), 'the zoom buttons zoom');
  const c = await page.$eval('.am-canvas', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 40, y: r.y + 40 }; });
  const t1 = await page.$eval('.am-canvas svg > g', (g) => g.getAttribute('transform'));
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 120, c.y + 60, { steps: 6 }); await page.mouse.up();
  ok(t1 !== await page.$eval('.am-canvas svg > g', (g) => g.getAttribute('transform')), 'dragging pans the map');

  ok((await page.$$('.am-inv-branch')).length === branches.length, 'the list below has every branch');
  await page.screenshot({ path: join(OUT, 'desktop-full.png'), fullPage: true });
  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await page.close();

  console.log('Desktop, live check fails');
  const down = await open(browser, base, { width: 1440, height: 1000 }, { facts: null });
  ok((await down.page.$eval('.am-check', (e) => e.textContent)).includes('Couldn’t check live status (JobTread timed out)'), 'a failed live check says so');
  ok(await statusOf(down.page, 'Instagram Reel') === 'Live' && await statusOf(down.page, 'Live hub') === 'Needs attention', 'and the written statuses stand in');
  ok(down.errors.length === 0, `no console errors${down.errors.length ? ': ' + down.errors.slice(0, 3).join(' | ') : ''}`);
  await down.page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const sideways = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(sideways <= 0, `no sideways scroll at 390px (${sideways}px)`);
  const canvasH = await phone.page.$eval('.am-canvas', (e) => e.getBoundingClientRect().height);
  ok(canvasH > 300, `the map has room on a phone (${Math.round(canvasH)}px tall)`);
  await phone.page.screenshot({ path: join(OUT, 'phone.png'), fullPage: false });
  await phone.page.screenshot({ path: join(OUT, 'phone-full.png'), fullPage: true });
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? ': ' + phone.errors.slice(0, 3).join(' | ') : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
