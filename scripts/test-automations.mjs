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
const sameSet = (got, want) => got.length === want.length && want.every((x) => got.includes(x));
const setDiff = (got, want) => { const extra = got.filter((x) => !want.includes(x)); const missing = want.filter((x) => !got.includes(x)); return `${extra.length ? `; unexpected: ${extra.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`; };

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
// Shaped like production on October 16, 2026; JobTread as of October 20 (Zaps off, their webhooks gone, the applicant workflow on)
const FACTS = {
  success: true,
  checkedAt: iso(0),
  env: { slack: false, twilio: false, youtube: false, kit: true, resend: true, calendar: true, jobtread: true, facebook: true, stream: true, images: true, deployHook: true, github: true, access: true, constantContact: true, turnstile: true, zeffyWebhook: true, zeffyApi: true, slackBot: true },
  bindings: { db: true, files: true, ai: true, hub: true },
  broadcast: { inputEnabled: true, outputs: { facebook: true, youtube: null, instagram: null }, facebookMode: 'api', reels: false, reminders: { enabled: false, sms: false, push: false }, kitLive: true, messages: true, vapid: true, alertCount: 1, updatedAt: iso(2 * 86400e3) },
  health: { lastTickAt: iso(60e3), lastTickSource: 'hub:alarm', lastDailyAt: iso(86400e3), hubOk: true, streamOk: true, facebookOk: true, webhookAt: iso(2 * 86400e3), webhookEvent: 'live_input.disconnected', replayCheckAt: iso(2 * 86400e3), monitorAt: iso(2 * 86400e3) },
  hub: { ok: true, current: false, lastTickAt: iso(40e3), clients: 2, error: null },
  invites: { enabled: true, lastSweepAt: iso(30 * 60e3), lastGuestCheckAt: iso(2 * 60e3), checked: 20, changed: 0, errors: 0, rows: 3 },
  revealChecks: { enabled: false, lastRunAt: null, checked: null, posted: null, repaired: null, errors: null, lastErrorAt: null, syncedAt: iso(10 * 60e3), syncedJobs: 1 },
  fbArchive: { checkedAt: iso(60 * 60e3), archived: 3, needsKid: 1, lastAutoDeployAt: iso(17 * 86400e3) },
  kidStatus: { lastSweepAt: iso(20 * 60e3), lastRunAt: iso(5 * 60e3), changed: 1, lastErrorAt: iso(60 * 60e3), deployPending: false, lastAutoDeployAt: iso(5 * 60e3), hidden: 1 },
  zeffy: { since: iso(3 * 86400e3), lastWebhookAt: iso(2 * 3600e3), lastPostAt: iso(2 * 3600e3), lastSweepAt: iso(10 * 60e3), sweepError: null, missed: 0, missedAt: null, rejectedAt: null, failing: 0, failingWhy: null },
  reveals: { cachedAt: iso(5 * 60e3) },
  approvals: { lastRunAt: iso(60e3), lastErrorAt: null, last: { name: 'Ava Stone', at: iso(3 * 3600e3), slug: 'ava' }, waiting: [] },
  covers: { covers: 23, last: { slug: 'max', at: iso(2 * 3600e3) }, failing: 0 },
  jotform: { total: 60, copied: 31, left: 29, gaveUp: 0, families: 14, files: 52, listedAt: iso(3600e3), doneAt: null, blockedAt: null },
  advisory: { total: 8, new: 1, fromJotform: 7, lastAt: iso(5 * 3600e3), lastNotified: { applicant: true, staff: 1, slack: true } },
  quo: { lastAt: iso(2 * 3600e3), last30: 77 },
  sends: { live: { kit: { last: iso(2 * 86400e3), sent: 1, failed: 0 } } },
  reminders: { subscribers: 4 },
  jobtread: {
    workflows: Object.fromEntries([
      ['22PJYm7aXBgK', true], ['22PJxRJ37KSs', true], ['22PJxRLV9Y3i', true], ['22PRvF7pG9VM', false], ['22PZF9ENDgxn', false],
      ['22PgHVceQhvW', true], ['22PgHVcgDXFN', true], ['22PgPECxg6UP', true], ['22PgPED4vi7W', true], ['22PgQQ6JnJDm', true], ['22PgYwQvKkTs', true], ['22PgaEgWTBRH', true]
    ].map(([id, active]) => [id, { name: id, active }])),
    webhooks: Object.fromEntries(['22PDDmxBcvpA', '22PJxV5yimrd'].map((id) => [id, { where: 'example.com/x', events: [] }])),
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
  ok(branches.length === 8, `${branches.length} branches drawn (${branches.join(', ')})`);
  const canvasTop = await page.$eval('.am-canvas', (e) => e.getBoundingClientRect().top);
  ok(canvasTop < 360, `the map starts above the fold on a laptop (${Math.round(canvasTop)}px down)`);
  const inView = await page.evaluate(() => {
    const c = document.querySelector('.am-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.am-node')].every((n) => { const r = n.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; });
  });
  ok(inView, 'the opening view fits the whole map in the canvas');

  for (const [title, want] of [
    ['Instagram Reel', 'Off'], ['Reminder emails', 'Off'], ['Browser push reminders', 'Off'], ['Alert texts', 'Off'],
    ['Simulcast to Facebook', 'Live'], ['Simulcast to YouTube', 'Off'], ['Live hub', 'Needs attention'],
    ['Slack posts', 'Off'], ['Facebook replay rescue', 'Needs attention'], ['Invite engine', 'Live'],
    ['Reveal date sync', 'Live'],
    ['Reveal checks for PMs', 'Off'], ['Kid and project status follow JobTread', 'Live'], ['Gift alerts in Slack', 'Live'],
    ['Status → family message', 'Live'], ['Quo texts and calls → JobTread', 'Live'], ['/text → Quo text', 'Live'], ['Zillow lookup', 'Live'], ['Approved → job and its page', 'Live'], ['Kid photo as the job’s cover', 'Live'],
    ['Advisory Board application', 'Live'],
  ]) ok(await statusOf(page, title) === want, `${title}: ${want}`);
  const zapier = await page.evaluate(() => [...document.querySelectorAll('.am-inv-branch li b, #am-svc option')].map((e) => e.textContent).filter((x) => /zapier/i.test(x)));
  ok(zapier.length === 0, `Zapier is retired: no entry or service for it${zapier.length ? ` (found ${zapier.join(', ')})` : ''}`);
  const jotform = await page.evaluate(() => [...document.querySelectorAll('.am-inv-branch li b, #am-svc option')].map((e) => e.textContent).filter((x) => /jotform/i.test(x)));
  ok(jotform.length === 0, `Jotform is retired: no entry or service for it${jotform.length ? ` (found ${jotform.join(', ')})` : ''}`);

  const attnItems = await page.$$eval('.am-panel .am-mini li', (l) => l.length);
  ok((await page.$eval('.am-panel', (e) => e.textContent)).includes('Needs attention') && attnItems >= 5, `the side panel lists what needs attention and what's parked (${attnItems} entries)`);
  // Each one is a real problem in these facts: the hub on old code, a replay with no kid page (YouTube never set up is Off)
  const attnTitles = await page.$$eval('.am-inv-branch li', (l) => l.filter((x) => x.querySelector('.am-meta')?.textContent.startsWith('Needs attention')).map((x) => x.querySelector('b').textContent));
  ok(sameSet(attnTitles, ['Live hub', 'Facebook replay rescue']), `exactly the entries with a real problem need attention${setDiff(attnTitles, ['Live hub', 'Facebook replay rescue'])}`);
  const lede = await page.$eval('.am-lede .am-warnstat b', (e) => e.textContent);
  ok(lede === String(attnTitles.length), `the lede counts the ${attnTitles.length} needing attention (shows ${lede})`);
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
  const resendTitles = await page.$$eval('.am-panel .am-mini li', (l) => l.map((li) => [...li.querySelectorAll('span')].find((x) => x.querySelector('em'))?.firstChild?.textContent || li.textContent));
  // Resend only sends one-off mail now (the list is Kit's). Each of these calls sendEmails: invite problems, the resume link,
  // the waitlist's confirmation and its Kit fallback, the staff heads-up, a stuck application, the status summary,
  // go / no-go, alerts, reminders, the connection itself, gift alert problems, a Denied kid, a staff text that didn't arrive,
  // the application limit's notices, Resend's own reports on each email, the board packet, and a vendor or sponsor with no logo
  const RESEND = ['Invite problem alerts', 'Save and finish later', 'Tell me when applications open', 'Applications-open email', 'Staff heads-up', 'Application sweep',
    'Status change summary', 'Go / no-go', 'Alert emails', 'Reminder emails', 'Resend', 'Gift alerts in Slack', 'Kid and project status follow JobTread', 'Text delivery reports',
    'Application limit', 'Email delivery reports', 'Advisory Board application', 'A family replied → staff alert', 'The packet email',
    'Receipts both ways', 'W-9s and insurance', 'Vendor and sponsor logos on kid pages'];
  ok(await panelTitle(page) === 'If Resend stops working' && sameSet(resendTitles, RESEND), `"Depends on" lists everything that uses Resend (${resendTitles.length})${setDiff(resendTitles, RESEND)}`);
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
  const lookHits = (await page.$eval('.am-hits', (e) => e.textContent)).match(/(\d+) match/)?.[1];
  ok(lookHits === String(attnTitles.length), `Needs a look shows only the ${attnTitles.length} amber entries, not what's switched off (shows ${lookHits})`);
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
  ok(await statusOf(down.page, 'Instagram Reel') === 'Live' && await statusOf(down.page, 'Live hub') === 'Live', 'and the written statuses stand in');
  ok(await statusOf(down.page, 'Gift alerts in Slack') === 'Off', 'gift alerts fall back to “not connected yet”');
  ok(down.errors.length === 0, `no console errors${down.errors.length ? ': ' + down.errors.slice(0, 3).join(' | ') : ''}`);
  await down.page.close();

  console.log('Desktop, gift alerts');
  const gifts = await open(browser, base, { width: 1440, height: 1000 });
  await gifts.page.type('#am-search', 'gift alerts');
  await pause(500);
  await clickNode(gifts.page, 'Gift alerts in Slack');
  await pause(300);
  ok(await panelTitle(gifts.page) === 'Gift alerts in Slack', 'search finds the gift alerts entry');
  const giftPanel = await gifts.page.$eval('.am-panel', (e) => e.textContent);
  ok(giftPanel.includes('Connected. Last gift posted') && giftPanel.includes('🚨 MAJOR GIFT'), 'it says it’s connected and what a post looks like');
  const extra = await gifts.page.$$eval('.am-panel button', (b) => b.map((x) => x.textContent.trim()).filter((t) => !['×', 'Zeffy', 'Slack', 'D1', 'Resend'].includes(t)));
  ok(extra.length === 0, `status only: no buttons in its panel${extra.length ? ` (found ${extra.join(', ')})` : ''}`);
  await gifts.page.screenshot({ path: join(OUT, 'desktop-gift-alerts.png'), fullPage: false });
  ok(gifts.errors.length === 0, `no console errors${gifts.errors.length ? ': ' + gifts.errors.slice(0, 3).join(' | ') : ''}`);
  await gifts.page.close();

  console.log('Desktop, a Zap comes back');
  const zap = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...FACTS, jobtread: { ...FACTS.jobtread, webhooks: { ...FACTS.jobtread.webhooks, '22PRvE87suYz': { where: 'hooks.zapier.com/x', events: [] } } } } });
  ok(await statusOf(zap.page, 'Status → family message') === 'Needs attention', 'a Zapier webhook back in JobTread puts the family messages in Needs attention');
  ok(zap.errors.length === 0, `no console errors${zap.errors.length ? ': ' + zap.errors.slice(0, 3).join(' | ') : ''}`);
  await zap.page.close();

  console.log('Desktop, JobTread’s old In Review workflow back on');
  const qc = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...FACTS, jobtread: { ...FACTS.jobtread, workflows: { ...FACTS.jobtread.workflows, '22PRvF7pG9VM': { name: 'Qualification Committee Comments', active: true } } } } });
  ok(await statusOf(qc.page, 'Status → family message') === 'Needs attention', 'the old In Review workflow switched on puts the family messages in Needs attention');
  ok(qc.errors.length === 0, `no console errors${qc.errors.length ? ': ' + qc.errors.slice(0, 3).join(' | ') : ''}`);
  await qc.page.close();

  console.log('Desktop, a gift the webhook missed');
  const missedFacts = (lastWebhookAt) => ({ ...FACTS, zeffy: { ...FACTS.zeffy, missed: 1, missedAt: iso(5 * 86400e3), lastWebhookAt, lastPostAt: lastWebhookAt } });
  const missedOnly = await open(browser, base, { width: 1440, height: 1000 }, { facts: missedFacts(iso(6 * 86400e3)) });
  ok(await statusOf(missedOnly.page, 'Gift alerts in Slack') === 'Needs attention', 'a miss with no delivery since needs attention');
  await missedOnly.page.close();
  const missedThen = await open(browser, base, { width: 1440, height: 1000 }, { facts: missedFacts(iso(2 * 86400e3)) });
  ok(await statusOf(missedThen.page, 'Gift alerts in Slack') === 'Live', 'a miss the webhook has delivered since is Live');
  await missedThen.page.type('#am-search', 'gift alerts');
  await pause(500);
  await clickNode(missedThen.page, 'Gift alerts in Slack');
  await pause(300);
  ok((await missedThen.page.$eval('.am-panel', (e) => e.textContent)).includes('the webhook has delivered since'), 'and still says the catch-up check caught one');
  ok(missedThen.errors.length === 0, `no console errors${missedThen.errors.length ? ': ' + missedThen.errors.slice(0, 3).join(' | ') : ''}`);
  await missedThen.page.close();

  console.log('Desktop, money before the move to Mercury');
  const jobCosts = {
    webhook: true, lastEventAt: null, webhookError: null, lastRunAt: iso(60e3), lastCatchUpAt: null, catchUpError: 'JobTread returned 413: Request Entity Too Large',
    billsError: null, writeError: null, lastRebuildAt: iso(5 * 60e3), agentUsedAt: null, unsorted: 0, caps: false,
    billPay: { at: iso(60e3), error: null, last: { paid: 0, recorded: 0 }, mode: 'off', approvers: 0, waiting: 0, startsOn: null },
    receipts: { toAp: { sent: 0 }, toMercury: { uploaded: 0 } }, odd: 0, closeouts: { at: iso(60e3), error: null, historyLeft: 0, closed: 15 },
    finance: { at: iso(60e3), backfill: { read: 1, doneAt: iso(3600e3) }, forecast: null, mercuryEmpty: true, cashLow: false, balancesError: null },
    vendors: { at: iso(60e3), error: null, autoW9: false, autoCoi: false },
  };
  const money = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...FACTS, env: { ...FACTS.env, mercury: true }, jobCosts } });
  ok(await statusOf(money.page, 'Cash forecast') === 'Off', 'an empty Mercury has no forecast: Off, not a low-cash warning');
  ok(await statusOf(money.page, 'Bill approvals and pay') === 'Off', 'no start day for paying from Mercury: Off, not missing approvers');
  ok(await statusOf(money.page, 'Charges onto jobs, live') === 'Needs attention', 'a catch-up that can’t read JobTread needs attention');
  await money.page.type('#am-search', 'charges onto');
  await pause(500);
  await clickNode(money.page, 'Charges onto jobs, live');
  await pause(300);
  ok((await money.page.$eval('.am-panel', (e) => e.textContent)).includes('JobTread’s open jobs couldn’t be read'), 'and names JobTread, not Mercury');
  await money.page.close();
  const later = { ...jobCosts, billPay: { ...jobCosts.billPay, startsOn: '2099-01-02' } };
  const soon = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...FACTS, env: { ...FACTS.env, mercury: true }, jobCosts: later } });
  await soon.page.type('#am-search', 'bill approvals');
  await pause(500);
  await clickNode(soon.page, 'Bill approvals and pay');
  await pause(300);
  const soonPanel = await soon.page.$eval('.am-panel', (e) => e.textContent);
  ok(await statusOf(soon.page, 'Bill approvals and pay') === 'Off' && soonPanel.includes('Starts Jan 2') && soonPanel.includes('Pick who approves'), 'a start day ahead: Off, with the day and the approvers still to pick');
  ok(soon.errors.length === 0, `no console errors${soon.errors.length ? ': ' + soon.errors.slice(0, 3).join(' | ') : ''}`);
  await soon.page.close();

  console.log('Desktop, staff sign-in from Google');
  const staffWaiting = { key: true, signOut: true, ok: false, read: false, syncedAt: null, failedAt: iso(60e3), error: 'Google sign-in failed (401): unauthorized_client', needs: 'scope', clientId: '1234567890', project: 'soard-site', active: 0, off: 0, out: [] };
  const notYet = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...FACTS, staff: staffWaiting } });
  await notYet.page.type('#am-search', 'staff sign-in');
  await pause(500);
  await clickNode(notYet.page, 'Staff sign-in follows Google');
  await pause(300);
  const notYetPanel = await notYet.page.$eval('.am-panel', (e) => e.textContent);
  ok(await statusOf(notYet.page, 'Staff sign-in follows Google') === 'Needs attention' && notYetPanel.includes('1234567890') && notYetPanel.includes('admin.directory.user.readonly') && notYetPanel.includes('(project soard-site), turn on the Admin SDK API'), 'staff sign-in before Google allows the read: needs attention, with the client ID, the scope to add and the project to turn the API on in');
  await notYet.page.close();
  const staffOn = { ...staffWaiting, ok: true, read: true, syncedAt: iso(60e3), failedAt: null, error: null, needs: null, active: 6, off: 1, out: [{ name: 'Sam Smith', why: 'suspended', at: iso(3600e3), signedOut: true, error: null }] };
  const staffLive = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...FACTS, staff: staffOn } });
  await staffLive.page.type('#am-search', 'staff sign-in');
  await pause(500);
  await clickNode(staffLive.page, 'Staff sign-in follows Google');
  await pause(300);
  const staffPanel = await staffLive.page.$eval('.am-panel', (e) => e.textContent);
  ok(await statusOf(staffLive.page, 'Staff sign-in follows Google') === 'Live' && staffPanel.includes('6 active Google accounts can sign in; 1 suspended or deleted one can’t') && staffPanel.includes('Sam Smith (suspended in Google)'), 'reading Google: live, with the counts and who was last signed out');
  ok(staffLive.errors.length === 0, `no console errors${staffLive.errors.length ? ': ' + staffLive.errors.slice(0, 3).join(' | ') : ''}`);
  await staffLive.page.close();

  console.log('Desktop, Quo gone quiet');
  const quiet = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...FACTS, quo: { lastAt: iso(31 * 24 * 3600e3), last30: 0 } } });
  ok(await statusOf(quiet.page, 'Quo texts and calls → JobTread') === 'Needs attention', '31 days with no Quo text or call logged needs attention');
  ok(quiet.errors.length === 0, `no console errors${quiet.errors.length ? ': ' + quiet.errors.slice(0, 3).join(' | ') : ''}`);
  await quiet.page.close();

  console.log('Desktop, approved families');
  const ap = await open(browser, base, { width: 1440, height: 1000 });
  await ap.page.type('#am-search', 'approved');
  await pause(500);
  await clickNode(ap.page, 'Approved → job and its page');
  await pause(300);
  ok(await panelTitle(ap.page) === 'Approved → job and its page', 'search finds the approved-family entry');
  const apPanel = await ap.page.$eval('.am-panel', (e) => e.textContent);
  ok(apPanel.includes('Last set up Ava Stone'), 'it says which family it set up last');
  await ap.page.screenshot({ path: join(OUT, 'desktop-approved.png'), fullPage: false });
  ok(ap.errors.length === 0, `no console errors${ap.errors.length ? ': ' + ap.errors.slice(0, 3).join(' | ') : ''}`);
  await ap.page.close();

  console.log('Desktop, CompanyCam');
  ok(await statusOf((await open(browser, base, { width: 1440, height: 1000 })).page, 'CompanyCam for families in review') === 'Off', 'families in review: off unless switched on');
  const audit = { at: iso(30 * 60e3), copy: true, dedupe: false, jobs: 21, linked: 6, withPhotos: 19, missing: 0, doubleCopies: 33, byHand: 176, copied: 98, removed: 0, missingBy: [], doublesBy: [], twoProjects: [], noProject: [], errors: [] };
  const ccFacts = { ...FACTS, env: { ...FACTS.env, companycam: true }, companycamJobs: { on: true, copy: true, dedupe: false, audit, lastChecked: iso(5 * 60e3), jobs: 21 } };
  const cc = await open(browser, base, { width: 1440, height: 1000 }, { facts: ccFacts });
  await cc.page.type('#am-search', 'companycam');
  await pause(500);
  await clickNode(cc.page, 'CompanyCam photos on every job');
  await pause(300);
  ok(await panelTitle(cc.page) === 'CompanyCam photos on every job', 'search finds the job check');
  const ccPanel = await cc.page.$eval('.am-panel', (e) => e.textContent);
  ok(ccPanel.includes('19 open jobs with CompanyCam photos, every photo in JobTread. 33 second copies counted, not removed yet.'), 'it says what it found');
  await cc.page.screenshot({ path: join(OUT, 'desktop-companycam.png'), fullPage: false });
  ok(cc.errors.length === 0, `no console errors${cc.errors.length ? ': ' + cc.errors.slice(0, 3).join(' | ') : ''}`);
  await cc.page.close();
  const broken = await open(browser, base, { width: 1440, height: 1000 }, { facts: { ...ccFacts, companycamJobs: { ...ccFacts.companycamJobs, audit: { ...audit, errors: [{ job: 'Ava Stone (2026)', detail: 'JobTread returned 500' }] } } } });
  ok(await statusOf(broken.page, 'CompanyCam photos on every job') === 'Needs attention', 'a job it couldn’t check needs attention');
  await broken.page.close();

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
