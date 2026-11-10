/**
 * test-reveal-stats.mjs — Broadcast → History's reveal comparison in a real browser
 * ================================================================================
 * Serve a build first (no Pages Functions needed; every /api call is mocked):
 *   npx astro build --outDir /tmp/dist && python3 -m http.server 4391 --directory /tmp/dist
 *   BASE=http://localhost:4391 node scripts/test-reveal-stats.mjs
 *
 * Realistic reveals: the next one coming up, big and small ones, one with
 * Facebook's view totals and one without the permission for them, one with
 * YouTube too, one whose reveal moment isn't known, one from before counting
 * began, a very long name, and tests that stay out of the comparison.
 * Checks sorting, the average row, the best of each column, a reveal's tiles,
 * the chart (hover and keys), where people came from, and every admin width
 * from phone to desktop with nothing scrolling sideways. Screenshots land in
 * test-results/reveal-stats/. Exits non-zero on any failure or console error.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4391';
const OUT = new URL('../test-results/reveal-stats/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400e3;
const ago = (days, h = 0) => new Date(Date.now() - days * DAY + h * 3600e3).toISOString();

/** A reveal's "at once" line: rises to a peak around the reveal moment, then eases off */
function line(minutes, peakAt, { site = 60, fb = null, yt = null } = {}) {
  const pts = [];
  for (let t = 0; t <= minutes * 60; t += 30) {
    const k = Math.max(0, 1 - Math.abs(t - peakAt) / (minutes * 60 * 0.7));
    const wob = (n) => Math.round(n * (0.25 + 0.75 * k) + (Math.sin(t / 97) * n) / 20);
    pts.push([t, wob(site), fb == null ? null : wob(fb), yt == null ? null : (t < 120 ? null : wob(yt))]);
  }
  return pts;
}
function summary(series) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const totals = series.map((p) => n(p[1]) + n(p[2]) + n(p[3]));
  const peak = (i) => { const v = series.map((p) => p[i]).filter(Number.isFinite); return v.length ? Math.max(...v) : null; };
  const at = totals.indexOf(Math.max(...totals));
  return { peakAll: Math.max(...totals), peakAllAt: series[at][0], peakSplit: series[at].slice(1), avgAll: totals.reduce((a, b) => a + b, 0) / totals.length, peakSite: peak(1), peakFb: peak(2), peakYt: peak(3), hasFb: series.some((p) => Number.isFinite(p[2])), hasYt: series.some((p) => Number.isFinite(p[3])) };
}
const stats = (o) => ({ counted: true, partial: false, staff: 0, tests: 0, sources: {}, series: [], atOnce: null, hearts: null, heartsTotal: 0, facebook: null, youtube: null, test: false, revealAt: null, atReveal: null, avgReplaySec: null, ...o, ...(o.series ? { atOnce: summary(o.series) } : {}) });

const HISTORY = [
  { id: 'live-9', kid_slug: 'dylan-2026', kid_name: 'Dylan', title: "Dylan's room reveal", scheduled_at: new Date(Date.now() + 9 * DAY).toISOString(), phase: 'scheduled', source: null, data: {}, messageCount: 0, events: { view_live_page: 41, banner_click: 4, reminder_signup: 1, click_calendar: 1 },
    stats: stats({ partial: true, people: 37, before: 37, live: 0, replay: 0, sources: { direct: 20, email: 9, facebook: 6, site: 2 }, staff: 4 }) },
  { id: 'live-8', kid_slug: 'jordan-2026', kid_name: 'Jordan', title: "Jordan's room reveal", scheduled_at: ago(6), live_at: ago(6), ended_at: ago(6, 0.6), phase: 'idle', replay_uid: 'r8', fb_permalink: 'https://www.facebook.com/x/videos/8', source: 'stream', data: {}, messageCount: 31, events: { click_donate: 9, reminder_signup: 14, share: 6, qr_scan: 11 },
    stats: stats({ people: 286, before: 120, live: 171, avgLiveSec: 812, atReveal: 149, revealAt: 1215, replay: 64, avgReplaySec: 402, heartsTotal: 640, hearts: { heart: 640 }, staff: 6, tests: 1,
      sources: { email: 96, facebook: 88, direct: 51, qr: 22, push: 12, search: 7, site: 6, calendar: 4 }, series: line(36, 1215, { site: 120, fb: 160, yt: 18 }),
      facebook: { unique: 1840, views: 2610, avgSec: 74, liveUnique: 690, reactions: 212, comments: 48, checkedAt: ago(0, -2) }, youtube: { videoId: 'abcDEF12345', views: 233, likes: 19, comments: 3, checkedAt: ago(0, -2) } }) },
  { id: 'live-7', kid_slug: 'avery-2026', kid_name: 'Avery', title: "Avery's room reveal", scheduled_at: ago(13), live_at: ago(13), ended_at: ago(13, 0.45), phase: 'idle', replay_uid: 'r7', fb_permalink: 'https://www.facebook.com/x/videos/7', source: 'stream', data: {}, messageCount: 12, events: { click_donate: 3, reminder_signup: 5 },
    stats: stats({ people: 141, before: 52, live: 98, avgLiveSec: 505, atReveal: 61, revealAt: 980, replay: 30, avgReplaySec: 210, heartsTotal: 233, hearts: { heart: 233 },
      sources: { facebook: 61, email: 40, direct: 30, qr: 6, other: 4 }, series: line(27, 980, { site: 70, fb: 90 }),
      facebook: { reactions: 96, comments: 20, missing: 'read_insights', checkedAt: ago(0, -1) } }) },
  { id: 'live-6', kid_slug: 'nicolas-and-maddox-2026', kid_name: 'Nicolas and Maddox', title: "Nicolas and Maddox's room reveal", scheduled_at: ago(27), live_at: ago(27), ended_at: ago(27, 0.7), phase: 'idle', replay_uid: 'r6', fb_permalink: null, source: 'stream', data: {}, messageCount: 23, events: { click_donate: 12 },
    stats: stats({ people: 412, before: 201, live: 268, avgLiveSec: 742, atReveal: null, revealAt: null, replay: 96, avgReplaySec: 300, heartsTotal: 512, hearts: { heart: 500, sun: 12 },
      sources: { facebook: 160, email: 140, direct: 60, qr: 22, site: 14, search: 8, push: 5, calendar: 3 }, series: line(42, 1500, { site: 210 }) }) },
  { id: 'live-5', kid_slug: 'maximiliana-josephine-2026', kid_name: 'Maximiliana-Josephine Featherstonehaugh-Wellingtonshire', title: 'x', scheduled_at: ago(40), live_at: ago(40), ended_at: ago(40, 0.3), phase: 'idle', replay_uid: 'r5', source: 'stream', data: {}, messageCount: 4, events: {},
    stats: stats({ people: 58, before: 9, live: 41, avgLiveSec: 260, atReveal: 30, revealAt: 600, replay: 12, heartsTotal: 40, sources: { direct: 40, email: 18 }, series: line(18, 600, { site: 30 }) }) },
  { id: 'live-4', kid_slug: 'hudson-2025', kid_name: 'Hudson', title: "Hudson's room reveal", scheduled_at: ago(200), live_at: ago(200), ended_at: ago(200, 0.5), phase: 'idle', replay_uid: 'r4', source: 'stream', data: {}, messageCount: 9, events: { view_live_page: 210, click_donate: 2 },
    stats: stats({ counted: false, people: 0 }) },
  { id: 'live-3', kid_slug: 'isla', kid_name: 'Isla', title: "TEST · Isla's room reveal", scheduled_at: ago(22), phase: 'cancelled', source: null, data: { test: true }, messageCount: 0, events: {}, stats: stats({ test: true, people: 3 }) },
  { id: 'live-2', kid_slug: null, kid_name: null, title: 'Live room reveal', live_at: ago(26), ended_at: ago(26, 0.05), phase: 'replay', replay_uid: 'r2', source: 'stream', data: {}, messageCount: 0, events: {}, stats: stats({ people: 2, live: 2, avgLiveSec: 60 }) },
];

const adminFixture = () => ({
  success: true,
  state: { phase: 'scheduled', broadcastId: 'live-9', kidSlug: 'dylan-2026', kidName: 'Dylan', source: null, fb: {} },
  public: { phase: 'scheduled', id: 'live-9' }, legacy: {},
  config: { customerCode: 'c', liveInput: { uid: 'in1' }, outputs: {}, facebook: { mode: 'api' }, youtube: { channelUrl: '' }, reminders: { enabled: true, hoursBefore: [24, 1], push: true }, replayHours: 72, timezone: 'America/New_York', alerts: { emails: [] }, defaults: {}, messages: { enabled: true } },
  larix: null,
  setup: { streamConfigured: true, youtubeConfigured: true, fbConfigured: true, emailConfigured: true, smsConfigured: false, slackConfigured: true, kitConfigured: true, hubBound: true, deployHook: true, inputReady: true, pushReady: true, alertEmails: [], alertPhones: [], alertTexts: {} },
  health: { lastTick: { at: new Date().toISOString(), work: [] } },
  hub: { ok: true, clients: 1 }, live: { lifecycle: { live: false } }, outputs: [], recordings: [],
  reminders: { counts: {}, recent: [] }, sends: [], history: HISTORY, statsSince: ago(30), healthReports: {}, fbRecent: null,
  playback: { customerCode: 'c' },
});

async function mockApi(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.pathname === '/api/broadcast-admin') return json(adminFixture());
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, pages: 1, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
    req.continue();
  });
}

const WIDTHS = [390, 768, 820, 1025, 1100, 1180, 1280, 1440];
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const errors = [];
try {
  const page = await browser.newPage();
  // A static server has no live socket for the admin; that's not this page's error
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|\/api\/live-ws/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await mockApi(page);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE}/admin/#broadcast/history`, { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  const clickText = (sel, re) => page.evaluate((s, src) => { const rx = new RegExp(src); const el = [...document.querySelectorAll(s)].find((x) => rx.test(x.textContent.trim())); if (el) { el.click(); return true; } return false; }, sel, re.source);
  if (!(await page.$('.rs-table'))) { await clickText('.hub-tab', /^History/); }
  await page.waitForSelector('.rs-table tbody tr', { timeout: 10000 });

  console.log('\n▶ the comparison');
  const names = await page.$$eval('.rs-row .rs-name strong', (els) => els.map((e) => e.textContent.trim()));
  ok(names[0] === 'Dylan', `the next reveal first (newest), with "Coming up" (${names.join(', ')})`);
  ok(await page.$$eval('.rs-row', (rows) => [...rows[0].querySelectorAll('td.num')].map((td) => td.textContent.trim()).filter((t) => t === '0').length === 0), 'a reveal that hasn\'t happened shows dashes, not zeros, for what it can\'t have yet');
  ok(!(await page.$('.rs-card h3')), 'the card doesn\'t repeat the page\'s title');
  ok(!names.some((n) => /Isla|Live room reveal/.test(n)), 'tests and kid-less streams stay out of the table');
  ok(!names.includes('Hudson'), 'a reveal from before counting isn\'t in the comparison (it sits in the fold)');
  const heads = await page.$$eval('.rs-table thead th', (els) => els.map((e) => e.textContent.replace(/[↑↓]/g, '').trim()).filter(Boolean));
  ok(heads.includes('Facebook') && heads.includes('YouTube'), `Facebook and YouTube columns when any reveal has them (${heads.join(' | ')})`);
  const avg = await page.$eval('.rs-avg', (el) => el.innerText).catch(() => '');
  ok(/Average reveal/.test(avg) && /4 finished reveals/.test(avg), `the average reveal: most numbers over the 4 counted reveals (${avg.replace(/\s+/g, ' ').slice(0, 80)})`);
  ok(/74%\s*of 3/.test(avg), 'a column over a different number of reveals says so (there for the reveal: 3 of 4)');
  const peopleCol = heads.indexOf('People');
  const peopleAvg = await page.$$eval('.rs-avg td', (tds, i) => tds[i - 1]?.firstChild?.textContent.trim(), peopleCol);
  ok(peopleAvg === String(Math.round((286 + 141 + 412 + 58) / 4)), `People average leaves out the uncounted reveal (${peopleAvg})`);
  const bestPeople = await page.$$eval('.rs-row', (rows, i) => rows.map((r) => r.querySelectorAll('td')[i]).filter((td) => td?.classList.contains('is-best')).map((td) => td.textContent), peopleCol);
  ok(bestPeople.length === 1 && /412/.test(bestPeople[0]), `the most people is in bold (${bestPeople.join(',')})`);
  ok(await page.$$eval('.rs-row', (rows) => rows.find((r) => /Dylan/.test(r.textContent)).querySelectorAll('td.num')[2].textContent.trim() === '—'), 'what a reveal can\'t have yet shows a dash, not a zero');

  // Sorting
  await page.evaluate(() => [...document.querySelectorAll('.rs-sort')].find((b) => /^People/.test(b.textContent.trim())).click());
  await settle(100);
  let order = await page.$$eval('.rs-row .rs-name strong', (els) => els.map((e) => e.textContent.trim()));
  ok(order.slice(0, 3).join(',') === 'Nicolas and Maddox,Jordan,Avery' && order[order.length - 1] === 'Dylan', `sorted by People, highest first (${order.join(', ')})`);
  ok(await page.$$eval('.rs-table thead th', (ths) => ths.filter((t) => t.getAttribute('aria-sort') === 'descending').length === 1), 'aria-sort says so');
  await page.evaluate(() => [...document.querySelectorAll('.rs-sort')].find((b) => /^People/.test(b.textContent.trim())).click());
  await settle(100);
  order = await page.$$eval('.rs-row .rs-name strong', (els) => els.map((e) => e.textContent.trim()));
  ok(order[0] === 'Dylan' && order[order.length - 1] === 'Nicolas and Maddox', `click again: lowest first (${order.join(', ')})`);
  await page.evaluate(() => [...document.querySelectorAll('.rs-sort')].find((b) => /^Reveal/.test(b.textContent.trim())).click());

  console.log('\n▶ one reveal');
  ok(await clickText('.rs-namebtn', /^Jordan/), 'open Jordan');
  await page.waitForSelector('.rs-open .rs-chart svg', { timeout: 5000 }).catch(() => {});
  const tiles = await page.$$eval('.rs-open .stat', (els) => els.map((e) => [...e.children].map((c) => c.textContent.trim()).join(' ')));
  ok(tiles.length === 6, `six tiles (${tiles.length})`);
  ok(tiles.some((t) => /There for the reveal 87%/.test(t)), `there for the reveal: 149 of 171 = 87% (${tiles.find((t) => /There/.test(t))})`);
  ok(tiles.some((t) => /Avg\. watch, live 13:32/.test(t)), 'average watch 13:32');
  const peakTile = tiles.find((t) => /^Most at once/.test(t)) || '';
  const split = peakTile.match(/Site (\d+) · Facebook (\d+) · YouTube (\d+), ([\d:]+) after going live/);
  ok(split && Number(split[1]) + Number(split[2]) + Number(split[3]) === Number(peakTile.match(/^Most at once ([\d,]+)/)[1].replace(/,/g, '')), `the peak's split adds up to it (${peakTile})`);
  ok(await page.$$eval('.rs-open .rs-chart polyline', (els) => new Set(els.map((e) => e.getAttribute('stroke'))).size === 3), 'three lines: site, Facebook, YouTube');
  ok(!!(await page.$('.rs-open .rs-reveal')), 'the reveal moment is marked');
  ok(await page.$$eval('.rs-open .rs-legend span', (els) => els.map((e) => e.textContent.trim()).join(',') === 'Site,Facebook,YouTube'), 'legend');
  const plot = await page.$('.rs-open .rs-plot');
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await settle(100);
  const tip = await page.$eval('.rs-open .rs-tip', (el) => el.innerText).catch(() => '');
  ok(/after going live/.test(tip) && /Together/.test(tip) && /Facebook/.test(tip), `hovering shows every place at that moment (${tip.replace(/\s+/g, ' ')})`);
  await page.screenshot({ path: `${OUT}detail-hover-1280.png`, fullPage: false, clip: { x: 0, y: Math.max(0, box.y - 420), width: 1280, height: 900 } });
  await page.mouse.move(box.x + box.width + 50, box.y - 100);
  await page.$eval('.rs-open .rs-svg', (el) => el.focus());
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const keyTip = await page.$eval('.rs-open .rs-tip', (el) => el.innerText).catch(() => '');
  ok(/0:30 after going live/.test(keyTip), `arrow keys walk the line (${keyTip.split('\n')[0]})`);
  await page.keyboard.press('Escape');
  ok(!(await page.$('.rs-open .rs-tip')), 'Escape clears it');
  const srcs = await page.$$eval('.rs-open .rs-bars li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  ok(srcs.length === 8 && /^Email 96/.test(srcs[0]), `where people came from, most first (${srcs[0]})`);
  const platsText = (sel) => page.$eval(sel, (el) => [...el.querySelectorAll('h5, dt, dd, p')].map((x) => x.textContent.trim()).join(' '));
  const plats = await platsText('.rs-open .rs-plats');
  ok(/People 3\+ seconds 1,840/.test(plats) && /Views 233/.test(plats), `Facebook and YouTube totals (${plats.slice(0, 120)})`);
  ok(/Not counted: 6 staff visits and 1 test visit/.test(await page.$eval('.rs-open', (el) => el.innerText)), 'who was left out');
  ok(/Replay ↗/.test(await page.$eval('.rs-open', (el) => el.innerText)), 'the reveal\'s links and messages follow');

  ok(await clickText('.rs-row td.rs-name', /^Avery/), 'open Avery (a click anywhere on the row)');
  await settle(700); // a click on the row waits a moment, so a double-click to copy a number doesn't open it
  const avery = await platsText('.rs-open .rs-plats').catch(() => '');
  ok(/read insights/.test(avery), 'Facebook without the permission says so');
  ok(/Reactions 96/.test(avery) && /Comments 20/.test(avery), 'its reactions and comments still show');
  ok(await clickText('.rs-namebtn', /^Nicolas/), 'open Nicolas and Maddox');
  await settle(200);
  const nmTiles = await page.$eval('.rs-open .rs-tiles', (el) => el.innerText.replace(/\s+/g, ' '));
  ok(/reveal moment wasn.t found in the recording/.test(nmTiles), 'an old reveal whose moment wasn\'t found says so (only the current replay can be set)');
  ok(await page.$$eval('.rs-open .rs-chart polyline', (els) => els.length >= 1) && !(await page.$('.rs-open .rs-legend')), 'one line, no legend box');
  ok(/Reveals aren.t sent to YouTube/.test(await page.$eval('.rs-open .rs-plats', (el) => el.innerText)), 'no YouTube set up: said plainly, with where to set it');
  await page.click('.rs-rest summary').catch(() => {});
  ok(await clickText('.rs-restbtn', /Hudson/), 'open Hudson (before counting) in the fold');
  await settle(300);
  ok(/before the site counted people; it only kept page loads \(210\)/.test(await page.$eval('.rs-rest', (el) => el.innerText)), 'an uncounted reveal explains itself');
  await page.click('.rs-rest summary').catch(() => {});
  ok(await clickText('.rs-namebtn', /^Dylan/), 'open Dylan (coming up)');
  await settle(150);
  const dyl = await page.$eval('.rs-open', (el) => el.innerText.replace(/\s+/g, ' '));
  ok(/Counting began/.test(dyl) && /37 came before/.test(dyl), 'the next reveal shows its before numbers and the partial note');

  console.log('\n▶ tests and streams without a kid');
  ok(await page.$eval('.rs-rest summary', (el) => /3$/.test(el.textContent.trim())), 'three kept out (a test, a kid-less stream, one from before counting)');
  await page.click('.rs-rest summary');
  ok(await clickText('.rs-restbtn', /TEST · Isla/), 'a test opens');
  await settle(150);
  ok(/Test/.test(await page.$eval('.rs-rest', (el) => el.innerText)), 'marked Test');

  console.log('\n▶ every width');
  for (const w of WIDTHS) {
    await page.setViewport({ width: w, height: 900, isMobile: w < 500, hasTouch: w < 500 });
    await settle(350);
    // Jordan open at every width: the tiles, the chart and the bars have to fit too
    if (!(await page.$eval('.rs-row', () => [...document.querySelectorAll('.rs-namebtn')].some((b) => /Jordan/.test(b.textContent) && b.getAttribute('aria-expanded') === 'true')))) await clickText('.rs-namebtn', /^Jordan/);
    await page.waitForSelector('.rs-open .rs-chart svg', { timeout: 4000 }).catch(() => {});
    await settle(200);
    const m = await page.evaluate(() => {
      const card = document.querySelector('.rs-card');
      const tbl = document.querySelector('.rs-table table');
      const main = document.querySelector('.main') || document.body;
      const right = main.getBoundingClientRect().right + 1;
      const over = [...document.querySelectorAll('.rs *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > right && !el.closest('.rs-numbers__wrap'); }).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`).slice(0, 4);
      return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, over, cards: getComputedStyle(document.querySelector('.rs-table thead')).display === 'none', card: Math.round(card.clientWidth), table: Math.round(tbl.scrollWidth) };
    });
    ok(m.doc <= 0 && !m.over.length, `${w}px: nothing past the edge (page ${m.doc}px; ${m.over.join(' ') || 'all inside'})${m.cards ? ' · cards' : ' · table'} · card ${m.card} table ${m.table}`);
    await page.screenshot({ path: `${OUT}history-${w}.png`, fullPage: true });
    ok(await page.$eval('.rs-open .rs-svg', (svg) => svg.getBoundingClientRect().width <= svg.closest('.rs-chart').getBoundingClientRect().width).catch(() => false), `${w}px: the chart fits its frame`);
  }
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await settle(300);
  ok(await page.$eval('.rs-sortpick', (el) => getComputedStyle(el).display !== 'none'), 'phone: a Sort by menu instead of headings');
  await page.select('.rs-sortpick select', 'people:desc');
  await settle(150);
  order = await page.$$eval('.rs-row .rs-name strong', (els) => els.map((e) => e.textContent.trim()));
  ok(order[0] === 'Nicolas and Maddox', `phone sort by People (${order[0]})`);
} finally {
  await browser.close();
}
ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
