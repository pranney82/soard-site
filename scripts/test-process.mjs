/**
 * test-process.mjs — drive Site → Automations → Process in a real browser
 * ========================================================================
 * Opens the admin at #automations (public/ served directly, every /api call
 * stubbed; /api/process-admin answers with steps read from Docs worded like
 * SOARD's 2026 process Docs) and checks Process: the Map | Process switch
 * and its address, the website's applying steps then the Doc's, automations
 * pinned to the lines that do them with their live status, a chip opening
 * the automation in full, "Show on the map" (and Back to Process), the
 * needs-attention jump, Right now, both tracks, following a pasted Doc,
 * Print, a Doc Drive couldn't read, live facts failing, and a phone.
 * Screenshots land in test-results/process/. Exits non-zero on any failure
 * or console error.
 *
 *   node scripts/test-process.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { parseProcessHtml, policySections } from '../public/admin/process-shared.js';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/process/');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ─── Docs worded like the 2026 ones ───────
function exportOf(outline) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/’/g, '&rsquo;').replace(/…/g, '&hellip;');
  let out = '<body><p class="title"><span>Doc</span></p>';
  let level = null;
  for (const line of outline.trim().split('\n')) {
    const [, lv, t] = line.match(/^(\s*)(.*)$/);
    const l = lv.length / 2;
    if (l !== level) { if (level !== null) out += '</ol>'; out += `<ol class="c3 lst-kix_abc-${l} start" start="1">`; level = l; }
    out += `<li class="c2"><span>${esc(t)}</span></li>`;
  }
  return `${out}</ol></body>`;
}
const MAKEOVER = parseProcessHtml(exportOf(`
Onsite
  Performed by makeover team
  Designer & PM get digital documentation,
Child’s Approval
  Internal team chooses who moves forward in process based on fit, resources, location & scope
  Phone call to family
  JT sends family message
  Schedule family photo session
  Create webpage
  Project Summary Letter written
    Designer Zoom with family to review
  Family complete pre-makeover survey
Design Charrette
  Makeover team, Executive Board, Designers & Sponsors can attend
  Develop min. 2 layout options
Schedule Walk Your Plans Visit
  Sign off on preferred layout
PM Review
  PMs build budget/schedule, Designer completes selections/budget
Approval
  External - family signs approval documents
    Scope of Work & Approved Layout
Apply for permit
Mobilization
  PM order building materials
  Schedule trades
  Set start date, tag internal, Sponsor & Board for start date
Prestart
  PM onsite with family to review start checklist
Demo Day
  Sponsor, Designer & PM attend
Project in Progress
  Keep Sponsor up to date as project progresses
  Set Reveal Day no later than 2 weeks out
    Invite Board, Sponsor, Vendors, local media…
    Set Photographer & Videographer
Reveal Day
Post-Construction
  Designer visit job one week after Reveal
    Bring folder with resources
      Blank Thank You cards
  Director of Development touch base 6 months out
    Complete post-makeover survey`)).steps;
const COMMUNITY = parseProcessHtml(exportOf(`
Referred to us
Fill out online application
  Executive SOARD team review
Onsite
  Designer & PM get digital documentation, scans
Approval
  Phone call to community project team lead
  JT job created
  Create webpage
Demo Day
  SOARD team & community partner team attends
Reveal Day`)).steps;

// The board's manual, the parts the money steps open (Segregation of Duties left out, to show a missing one)
const POLICY = policySections(`<body><p>A. Expenditures 9</p><p>B. Credit Cards 8</p><p>C. Accounting and Controls of Checks 10</p>
<h1>SECTION II: INTERNAL CONTROL</h1>
<ol class="lst-kix_b-0"><li>Credit Cards</li></ol><ol class="lst-kix_b-1"><li>Cardholder. Organization will issue a credit card to staff.</li></ol>
<ol class="lst-kix_b-0"><li>Expenditures</li></ol><p>Tier 2</p><p>Item cost: Greater than $15,000.00</p><p>Required approval: Board Chair</p>
<ol class="lst-kix_b-0"><li>Accounting and Controls of Checks</li></ol><ol class="lst-kix_b-1"><li>Checks received but not yet deposited must be kept in a locked drawer.</li><li>The bookkeeper will record checks written and deposited to QuickBooks.</li></ol></body>`);

const DOC = (id, name, steps, extra = {}) => ({
  doc: { id, name, url: `https://docs.google.com/document/d/${id}/edit`, modifiedTime: '2026-10-28T15:00:00.000Z', modifiedBy: 'Clareece Cunningham' },
  steps, readAt: iso(60e3), checkedAt: iso(30e3), error: null, errorAt: null, override: false, ...extra,
});
const fam = (names) => ({ n: names.length, names: names.map((name, i) => ({ name, href: `#applications/applicants/acc${i}` })) });
const job = (names) => ({ n: names.length, names: names.map((name, i) => ({ name, href: `https://app.jobtread.com/jobs/j${i}`, ...(name === 'Amari' ? { page: '/kids/amari/' } : {}) })) });
const NOW = {
  makeover: {
    applied: fam(['Max Sample', 'Ava Stone', 'Lee Park', 'Rosa Diaz', 'Theo Hall', 'June Kim']),
    inReview: fam(['Noah Bell', 'Ivy Fox']),
    jobs: { 'On Site': job([]), 'Awaiting Funding': job(['Amari', 'Jo Lane', 'Rey Cole']), Design: job(['Axel', 'Mila']), Finalization: job([]), Approval: job(['Kai']), Mobilization: job(['Zoe']), Build: job(['Eli', 'Ruby']) },
  },
  community: {
    applied: fam(['Sunnyside Academy']), inReview: fam([]),
    jobs: { 'On Site': job([]), 'Awaiting Funding': job([]), Design: job(['The Lionheart School']), Finalization: job([]), Approval: job([]), Mobilization: job([]), Build: job([]) },
  },
};
const PROCESS = () => ({
  success: true, checkedAt: iso(0),
  docs: {
    makeover: DOC('mk', '2026 Sunshine Makeover Process', MAKEOVER), community: DOC('co', '2026 Sunshine Community Project Process', COMMUNITY),
    // Changed 350 days ago: its yearly review comes up in about two weeks
    policy: { ...DOC('pol', '2025 FINAL- Board Financial Policy Manual with Exhibits', []), sections: POLICY, doc: { id: 'pol', name: '2025 FINAL- Board Financial Policy Manual with Exhibits', url: 'https://docs.google.com/document/d/pol/edit', modifiedTime: iso(350 * 86400e3), modifiedBy: null } },
  },
  reviews: { makeover: null, community: null, policy: null },
  now: NOW,
  checks: { approvals: { ok: false, text: 'The manual: over $15,000, the Board Chair approves. Pat Chair, the Board Chair, isn’t a second approver in Job Costs → Bills → Settings.' } },
});

// Shaped like production's facts for the entries the steps show; the countdown has a real problem
const FACTS = {
  success: true,
  env: { slack: true, slackBot: true, kit: true, resend: true, calendar: true, jobtread: true, facebook: true, stream: true, images: true, deployHook: true, github: true, access: true, turnstile: true, mercury: true, zeffyWebhook: true, zeffyApi: true, ramp: true },
  bindings: { db: true, files: true, ai: true, hub: true },
  invites: { enabled: true, lastSweepAt: iso(30 * 60e3), lastGuestCheckAt: iso(2 * 60e3), checked: 20, changed: 0, errors: 0, rows: 3 },
  revealChecks: { enabled: false },
  liveSchedule: { checkedAt: iso(5 * 60e3), error: 'JobTread answered 413', next: null, waiting: 0 },
  kidStatus: { lastSweepAt: iso(20 * 60e3), lastRunAt: iso(5 * 60e3), changed: 0, hidden: 0 },
  approvals: { lastRunAt: iso(60e3), lastErrorAt: null, last: { name: 'Ava Stone', at: iso(3 * 3600e3) }, waiting: [] },
  covers: { covers: 23, last: { at: iso(2 * 3600e3) }, failing: 0 },
  demoInvites: { enabled: true, errors: 0, sent: 4, lastCheckAt: iso(3 * 60e3), lastSentAt: iso(86400e3) },
  quo: { lastAt: iso(2 * 3600e3), last30: 77 },
  jobCosts: {
    webhook: true, lastEventAt: iso(5 * 60e3), lastCatchUpAt: iso(60e3), lastRebuildAt: iso(5 * 60e3), agentUsedAt: iso(3600e3), lastRunAt: iso(60e3), unsorted: 4, odd: 0,
    billPay: { mode: 'request', approvers: 1, waiting: 3, startsOn: '2026-10-01', at: iso(60e3) }, vendors: { at: iso(60e3), ready: true, held: 2, asking: 5 },
    closeouts: { at: iso(3600e3), closed: 30, historyLeft: 0 }, finance: { at: iso(10 * 60e3), backfill: { doneAt: iso(86400e3), read: 900 }, forecast: { at: iso(3600e3) }, cashLow: false, mercuryEmpty: false },
  },
  zeffy: { lastPostAt: iso(2 * 3600e3), lastWebhookAt: iso(2 * 3600e3), lastSweepAt: iso(10 * 60e3), failing: 0, missed: 0 },
  processDocs: { makeover: { name: '2026 Sunshine Makeover Process', readAt: iso(60e3), checkedAt: iso(30e3), steps: 14, error: null }, community: { name: '2026 Sunshine Community Project Process', readAt: iso(60e3), checkedAt: iso(30e3), steps: 16, error: null } },
  jobtread: {
    workflows: Object.fromEntries(['22PJYm7aXBgK', '22PJxRJ37KSs', '22PJxRLV9Y3i', '22PgHVceQhvW', '22PgHVcgDXFN', '22PgPECxg6UP', '22PgPED4vi7W', '22PgQQ6JnJDm', '22PgYwQvKkTs', '22PgaEgWTBRH'].map((id) => [id, { name: id, active: true }])),
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

async function open(browser, base, viewport, { facts = FACTS, process = PROCESS, hash = '#automations/process', touch = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const errors = [];
  const posts = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (url.pathname === '/api/automations-admin') return facts ? json({ ...facts, checkedAt: iso(0) }) : json({ success: false, error: 'JobTread timed out' }, 500);
    if (url.pathname === '/api/process-admin') {
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        posts.push(body);
        if (body.review) { const p = process(); p.reviews[body.review] = { at: iso(0), by: 'peter@soardcharity.com' }; return json(p); }
        if (body.link && !/docs\.google\.com\/document/.test(body.link)) return json({ success: false, error: 'That isn’t a link to a Google Doc. Copy it from the Doc’s address bar or its Share button.' }, 400);
        const p = process();
        p.docs[body.track] = { ...p.docs[body.track], override: !!body.link, doc: { ...p.docs[body.track].doc, name: body.link ? 'Community projects, how we do them' : p.docs[body.track].doc.name } };
        return json(p);
      }
      return json(process());
    }
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/audit-log')) return json({ success: true, entries: [], total: 0 });
    if (url.pathname.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    return req.continue();
  });
  await page.goto(`${base}/admin/${hash}`, { waitUntil: 'networkidle2' });
  return { page, errors, posts };
}
const ready = (page) => page.waitForFunction(() => document.querySelector('.pr .pr-steps') && !document.querySelector('.am-check')?.textContent.includes('Checking'), { timeout: 15000 });
const stepTitles = (page) => page.$$eval('.pr-step h4', (l) => l.map((h) => h.textContent.replace(/^Step \d+: /, '')));
const chipsOn = (page, text) => page.evaluate((text) => {
  const li = [...document.querySelectorAll('.pr-line')].find((l) => l.querySelector(':scope > .pr-text')?.textContent === text);
  return li ? [...li.querySelectorAll(':scope > .pr-autos .pr-auto')].map((b) => ({ t: b.textContent.trim(), s: b.className.match(/s-(\w+)/)?.[1] })) : null;
}, text);
const clickChip = (page, lineText, chip) => page.evaluate((lineText, chip) => {
  const li = [...document.querySelectorAll('.pr-line')].find((l) => l.querySelector(':scope > .pr-text')?.textContent === lineText);
  [...li.querySelectorAll(':scope > .pr-autos .pr-auto')].find((b) => b.textContent.trim() === chip).click();
}, lineText, chip);
const tagOf = (page, title) => page.evaluate((title) => [...document.querySelectorAll('.pr-step')].find((s) => s.querySelector('h4').textContent.endsWith(title))?.querySelector('.pr-head .tag')?.textContent, title);
const clickTrack = (page, label) => page.evaluate((label) => [...document.querySelectorAll('.pr-tools .pill')].find((b) => b.querySelector('.pr-full').textContent === label).click(), label);
const clickText = (page, scope, text) => page.evaluate((scope, text) => [...document.querySelectorAll(`${scope}`)].find((b) => b.textContent.trim() === text).click(), scope, text);

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const allErrors = [];
try {
  console.log('From the map to Process');
  {
    const { page, errors } = await open(browser, base, { width: 1440, height: 1000 }, { hash: '#automations' });
    await page.waitForSelector('.am-canvas svg .am-node.d1', { timeout: 15000 });
    ok(await page.$eval('.page-header .seg button[aria-pressed="true"]', (b) => b.textContent) === 'Map', 'Automations opens on the map, with Map | Process in the header');
    await clickText(page, '.page-header .seg button', 'Process');
    await ready(page);
    ok(await page.evaluate(() => location.hash) === '#automations/process', 'Process has its own address');
    ok(await page.$eval('.page-header .seg button[aria-pressed="true"]', (b) => b.textContent) === 'Process', 'the switch says Process');
    allErrors.push(...errors);
    await page.close();
  }

  console.log('Desktop, the makeover');
  const { page, errors, posts } = await open(browser, base, { width: 1440, height: 1000 });
  await ready(page);
  const mkReview = await page.evaluate(() => { const c = document.getElementById('pr-review'); return { when: c?.querySelector('.pr-review__when').textContent, last: c?.querySelector('.pr-review__last').textContent, button: !!c?.querySelector('.btn') }; });
  ok(/^Next due Oct 28/.test(mkReview.when) && mkReview.last.includes('changed Oct 28 by Clareece Cunningham') && !mkReview.button, `the makeover Doc’s yearly review isn’t due: no sign-off button (${mkReview.when})`);
  const titles = await stepTitles(page);
  ok(titles.slice(0, 5).join(' / ') === 'Applications open / Application submitted / Reviewed internally / Video interview / Reviewed internally', 'the website’s applying steps come first, as the Application Timeline has them');
  ok(titles[5] === 'Onsite' && titles.at(-1) === 'Post-Construction' && titles.length === 5 + MAKEOVER.length, `then the Doc’s ${MAKEOVER.length} steps in its order`);
  const nums = await page.$$eval('.pr-steps:last-of-type .pr-num', (l) => l.map((n) => n.textContent));
  ok(nums[0] === '1' && nums.at(-1) === String(MAKEOVER.length), 'the Doc’s steps keep the Doc’s numbers');
  const parts = await page.$$eval('.pr-part h3', (l) => l.map((h) => h.textContent));
  ok(parts.join(',') === 'Applying,The makeover', 'two parts: Applying, then The makeover');
  const src = await page.$eval('.pr-src', (e) => e.textContent);
  ok(src.includes('“2026 Sunshine Makeover Process” in Google Drive, changed Oct 28 by Clareece Cunningham'), 'it names the Doc, when it changed and who changed it');
  ok(await page.$eval('.pr-src a', (a) => a.href === 'https://docs.google.com/document/d/mk/edit' && a.target === '_blank'), 'Open the Doc opens it in a new tab');
  const lede = await page.$eval('.am-lede', (e) => e.textContent);
  ok(/\d+ steps/.test(lede) && /\d+ of \d+ tasks run on their own/.test(lede) && /\d+ automations along the way/.test(lede), `the lede counts steps, tasks and automations (${lede.replace(/\s+/g, ' ').trim()})`);
  ok((await page.$eval('.am-lede .am-warnstat', (e) => e.textContent)).replace(/\s+/g, ' ').trim() === '1 needs attention', 'and the one that needs attention');

  const msg = await chipsOn(page, 'JT sends family message');
  ok(msg?.map((c) => c.t).join(' | ') === 'Status → family message | Status change summary' && msg.every((c) => c.s === 'live'), '“JT sends family message” shows the status email and the summary, live');
  ok((await chipsOn(page, 'Set start date, tag internal, Sponsor & Board for start date'))?.[0]?.t === 'Demo day invites', 'setting the start date is the demo day invite');
  ok((await chipsOn(page, 'Phone call to family'))?.length === 0, 'a phone call is by hand: no automation on it');
  ok(await tagOf(page, 'Design Charrette') === 'By hand', 'a step with nothing automatic says By hand');
  ok(await tagOf(page, 'Onsite') === 'Automation off', 'a step whose only automation is switched off says so');
  ok(await tagOf(page, 'Project in Progress') === 'Needs attention', 'a step with an automation that needs attention says so');
  ok(await page.evaluate(() => [...document.querySelectorAll('.pr-step')].find((s) => s.querySelector('h4').textContent.endsWith('Child’s Approval')).classList.contains('is-auto')), 'a step where something runs gets the filled number');
  const whole = await page.evaluate(() => [...document.querySelectorAll('.pr-step')].find((s) => s.querySelector('h4').textContent.endsWith('Reveal Day'))?.querySelector('.pr-whole')?.textContent);
  ok(whole?.includes('Through this step') && whole.includes('Phone stream (Larix)'), 'Reveal Day lists the broadcast that runs through it');
  const reveal = () => page.evaluate(() => { const w = [...document.querySelectorAll('.pr-step')].find((s) => s.querySelector('h4').textContent.endsWith('Reveal Day')).querySelector('.pr-whole'); return { chips: w.querySelectorAll('.pr-auto').length, more: w.querySelector('.pr-more')?.textContent || null }; });
  const before = await reveal();
  ok(before.chips === 7 && /^\d+ more$/.test(before.more), `a long row shows the first few and “more” (${before.chips} shown, ${before.more})`);
  await page.evaluate(() => [...document.querySelectorAll('.pr-step')].find((s) => s.querySelector('h4').textContent.endsWith('Reveal Day')).querySelector('.pr-more').click());
  const after = await reveal();
  ok(after.chips === before.chips + Number(before.more.split(' ')[0]) && !after.more, `“more” shows them all (${after.chips})`);
  await page.screenshot({ path: join(OUT, 'desktop.png') });

  console.log('The journey');
  const dots = await page.$$eval('.pr-journey .pr-jstep', (l) => l.map((x) => ({ n: x.querySelector('.pr-jdot').textContent, count: x.querySelector('.pr-jcount')?.textContent || '', auto: x.classList.contains('is-auto'), attn: x.classList.contains('is-attn'), label: x.querySelector('.pr-jdot').getAttribute('aria-label') })));
  ok(dots.length === 5 + MAKEOVER.length, `a dot for every step (${dots.length})`);
  const countOf = (name) => dots.find((d) => d.label.includes(`: ${name},`))?.count;
  ok(countOf('Application submitted') === '6' && countOf('Onsite') === '2' && countOf('Child’s Approval') === '3' && countOf('Design Charrette') === '2' && countOf('Project in Progress') === '2' && countOf('PM Review') === '',
    `each dot counts who’s there (submitted ${countOf('Application submitted')}, onsite ${countOf('Onsite')}, approval ${countOf('Child’s Approval')}, charrette ${countOf('Design Charrette')}, in progress ${countOf('Project in Progress')})`);
  ok(dots.find((d) => d.label.includes(': Project in Progress,')).attn && dots.find((d) => d.label.includes(': Design Charrette,')).auto === false, 'a step needing attention is ringed, a step by hand is open');
  await page.hover('.pr-journey .pr-jstep:nth-child(3) .pr-jdot');
  ok((await page.$eval('.pr-jcap', (e) => e.textContent)).startsWith('3. Reviewed internally'), 'pointing at a dot names its step');
  const hereOn = (title) => page.evaluate((title) => [...[...document.querySelectorAll('.pr-step')].find((x) => x.querySelector('h4').textContent.endsWith(title)).querySelectorAll('.pr-here__group')].map((g) => `${g.querySelector('.tag').textContent}: ${g.querySelector('.pr-here__names').textContent}`).join(' | '), title);
  const here = await hereOn('Design Charrette');
  ok(here === 'Design: Axel, Mila', `a step names who’s at it and their JobTread status (${here})`);
  const approvalHere = await hereOn('Child’s Approval');
  ok(approvalHere === 'Awaiting funding: Amari, Jo Lane, Rey Cole', `approved and waiting on funding sits at the approval step (${approvalHere})`);
  await page.evaluate(() => [...document.querySelectorAll('.pr-jdot')].find((b) => b.getAttribute('aria-label').includes(': Mobilization,')).click());
  await pause(900);
  const jumped = await page.evaluate(() => { const st = [...document.querySelectorAll('.pr-step')].find((x) => x.querySelector('h4').textContent.endsWith('Mobilization')); const r = st.getBoundingClientRect(); return { top: Math.round(r.top), lit: st.classList.contains('is-jumped'), focus: document.activeElement === st.querySelector('h4') }; });
  ok(jumped.top >= -2 && jumped.top < 200 && jumped.lit && jumped.focus, `a dot takes you to its step (${JSON.stringify(jumped)})`);
  await page.evaluate(() => scrollTo(0, 0));

  console.log('The filter');
  await clickText(page, '.pr-show button', 'By hand');
  await pause(150);
  const hand = await page.evaluate(() => ({ steps: [...document.querySelectorAll('.pr-step h4')].map((h) => h.textContent.replace(/^Step \d+: /, '')), whole: document.querySelectorAll('.pr-whole').length, dim: document.querySelectorAll('.pr-jstep.is-dim').length }));
  ok(!hand.steps.includes('Application submitted') && hand.steps.includes('Design Charrette') && hand.steps.includes('Video interview') && hand.whole === 0 && hand.dim > 0, `By hand shows only steps with work done by hand (${hand.steps.length} steps, ${hand.dim} dimmed on the journey)`);
  ok((await chipsOn(page, 'JT sends family message')) === null && (await chipsOn(page, 'Phone call to family'))?.length === 0, 'and only the tasks done by hand');
  await clickText(page, '.pr-show button', 'Needs attention');
  await pause(150);
  const attnSteps = await page.$$eval('.pr-step h4', (l) => l.map((h) => h.textContent.replace(/^Step \d+: /, '')));
  ok(attnSteps.join(',') === 'Project in Progress', `Needs attention shows just that step (${attnSteps.join(', ')})`);
  await clickText(page, '.pr-show button', 'Everything');
  await pause(150);
  ok((await stepTitles(page)).length === 5 + MAKEOVER.length, 'Everything brings them all back');

  await clickChip(page, 'JT sends family message', 'Status → family message');
  await pause(150);
  const detail = await page.evaluate(() => document.querySelector('.pr-detail')?.textContent || '');
  ok(detail.includes('What starts it') && detail.includes('What it does') && detail.includes('Show on the map'), 'a chip opens the automation in full under its line');
  ok(await page.evaluate(() => document.querySelectorAll('.pr-auto[aria-expanded="true"]').length) === 1, 'one open at a time, marked expanded');
  await clickChip(page, 'JT sends family message', 'Status → family message');
  ok(await page.$('.pr-detail') === null, 'the same chip closes it');
  const summaryChip = await page.evaluateHandle(() => [...[...document.querySelectorAll('.pr-line')].find((l) => l.querySelector(':scope > .pr-text')?.textContent === 'JT sends family message').querySelectorAll(':scope > .pr-autos .pr-auto')].find((b) => b.textContent.trim() === 'Status change summary'));
  await summaryChip.asElement().click();
  await pause(100);
  await page.keyboard.press('Escape');
  await pause(100);
  const esc = await page.evaluate(() => ({ open: !!document.querySelector('.pr-detail'), focus: document.activeElement?.textContent.trim() }));
  ok(!esc.open && esc.focus === 'Status change summary', `Escape closes it and puts you back on its chip (${JSON.stringify(esc)})`);
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => (await window.axe.run(document.querySelector('.pr'), { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')})`));
  ok(axe.length === 0, `axe: no accessibility problems${axe.length ? `: ${axe.join(', ')}` : ''}`);

  await clickText(page, '.am-lede .am-warnstat button', '1 needs attention');
  await pause(600);
  const amber = await page.evaluate(() => {
    const d = document.querySelector('.pr-detail');
    const step = d?.closest('.pr-step');
    const r = step?.getBoundingClientRect();
    return d ? { title: d.querySelector('h5').textContent, step: step.querySelector('h4').textContent, inView: r.top >= -2 && r.top < innerHeight, text: d.textContent } : null;
  });
  ok(amber?.title === 'Live countdown follows JobTread' && amber.step.endsWith('Project in Progress') && amber.inView, 'Needs attention jumps to the step and opens what needs a look');
  ok(amber?.text.includes('JobTread answered 413'), 'with the live reason');
  await page.screenshot({ path: join(OUT, 'attention.png') });

  await clickText(page, '.pr-detail button', 'Show on the map');
  await page.waitForSelector('.am-canvas svg .am-node.d1', { timeout: 15000 });
  await pause(500);
  ok(await page.$eval('.am-panel h3', (e) => e.textContent).catch(() => null) === 'Live countdown follows JobTread', 'Show on the map opens the map on that automation');
  ok(await page.evaluate(() => location.hash) === '#automations', 'at the map’s address');
  await page.goBack();
  await ready(page);
  ok(await page.evaluate(() => location.hash) === '#automations/process', 'Back returns to Process');

  console.log('Right now');
  const rows = await page.$$eval('.pr-now .pr-row', (l) => l.map((b) => `${b.querySelector('span').textContent} ${b.querySelector('b').textContent}`));
  ok(rows.join(' / ') === 'Applied 6 / In review 2 / On Site 0 / Awaiting funding 3 / Design 2 / Finalization 0 / Approval 1 / Mobilization 1 / Build 2', `who’s at each stage (${rows.join(' / ')})`);
  await clickText(page, '.pr-now .pr-row', 'Awaiting funding3');
  const names = await page.$$eval('.pr-now .pr-names li', (l) => l.map((x) => x.textContent.trim()));
  ok(names.join(', ') === 'Amari page, Jo Lane, Rey Cole', `a stage names everyone there (${names.join(', ')})`);
  await (await page.$('.pr-now')).screenshot({ path: join(OUT, 'right-now.png') });
  const jobLinks = await page.$$eval('.pr-now .pr-names a', (l) => l.map((a) => [a.textContent, a.getAttribute('href'), a.target]));
  ok(jobLinks[0][1] === 'https://app.jobtread.com/jobs/j0' && jobLinks[0][2] === '_blank' && jobLinks[1][1] === '/kids/amari/', 'each job opens in JobTread, and a kid’s page beside it when there is one');
  await clickText(page, '.pr-now .pr-row', 'Applied6');
  const famLink = await page.$eval('.pr-now .pr-names a', (a) => [a.getAttribute('href'), a.target]);
  ok(famLink[0] === '#applications/applicants/acc0' && !famLink[1], 'a family opens on its page in Applicants, in the admin');
  ok(await page.$$eval('.pr-now .pr-row[disabled]', (l) => l.some((b) => b.textContent.includes('Finalization'))), 'an empty stage can’t be opened');
  const pills = await page.$$eval('.pr-tools .pill', (l) => l.map((p) => `${p.querySelector('.pr-full').textContent} ${p.querySelector('.count')?.textContent}`));
  ok(pills[0] === 'Kids’ makeovers 17' && pills[1] === 'Community projects 2', `each track says how many are under way (${pills.join(', ')})`);

  console.log('Community projects');
  await clickTrack(page, 'Community projects');
  await pause(200);
  ok(await page.evaluate(() => location.hash) === '#automations/process/community', 'the community track has its own address');
  const ct = await stepTitles(page);
  ok(ct[0] === 'Referred to us' && ct.length === COMMUNITY.length && !(await page.$$eval('.pr-part h3', (l) => l.map((h) => h.textContent))).includes('Applying'), 'it’s the community Doc’s own steps, application included');
  ok((await page.evaluate(() => [...document.querySelectorAll('.pr-whole')].map((w) => w.textContent).join(' '))).includes('Community project application'), 'its application step carries the community form');
  ok(!(await page.evaluate(() => document.body.textContent.includes('Makeover scoring'))), 'nothing makeover-only shows');
  ok((await page.$$eval('.pr-now .pr-row', (l) => l.map((b) => `${b.querySelector('span').textContent} ${b.querySelector('b').textContent}`))).includes('Design 1'), 'Right now follows the track');

  console.log('Following a pasted Doc');
  await clickText(page, '.pr-src button', 'Not the right Doc?');
  await page.type('.pr-link input', 'https://example.com/process');
  await clickText(page, '.pr-link button', 'Follow this Doc');
  await page.waitForSelector('.pr-link__err');
  ok((await page.$eval('.pr-link__err', (e) => e.textContent)).includes('isn’t a link to a Google Doc'), 'a link that isn’t a Doc is refused, with how to get the right one');
  await page.$eval('.pr-link input', (i) => { i.value = ''; });
  await page.click('.pr-link input', { clickCount: 3 });
  await page.type('.pr-link input', 'https://docs.google.com/document/d/1O03avY0pTtVY_2QZVujPJG8mALWULR2NBYiZ_NNRuis/edit');
  await clickText(page, '.pr-link button', 'Follow this Doc');
  await page.waitForFunction(() => !document.querySelector('.pr-link'));
  ok(posts.at(-1)?.track === 'community' && /1O03avY0/.test(posts.at(-1).link), 'the link is saved for this track');
  ok((await page.$eval('.pr-src', (e) => e.textContent)).includes('Following a pasted link') && (await page.$eval('.pr-src', (e) => e.textContent)).includes('Community projects, how we do them'), 'Process follows that Doc and says so');

  console.log('The money side');
  await clickTrack(page, 'Accounts payable');
  await pause(200);
  ok(await page.evaluate(() => location.hash) === '#automations/process/payables', 'accounts payable has its own address');
  const pay = await stepTitles(page);
  ok(pay[0] === 'Buying for a makeover' && pay.includes('Approving a bill') && pay.includes('Year end'), `its steps run from buying to year end (${pay.join(', ')})`);
  ok((await page.$eval('.pr-src', (e) => e.textContent)).includes('The board policy is “2025 FINAL- Board Financial Policy Manual with Exhibits”') && await page.$eval('.pr-src a', (a) => a.textContent === 'Open the manual'), 'it names the board’s manual and opens it');
  ok((await page.$eval('.pr-part span', (e) => e.textContent)).includes('no process Doc'), 'and says there’s no process Doc for it');
  const appr = await page.evaluate(() => { const st = [...document.querySelectorAll('.pr-step')].find((x) => x.querySelector('h4').textContent.endsWith('Approving a bill')); return { tag: st.querySelector('.pr-head .tag').textContent, check: st.querySelector('.pr-check')?.className, text: st.querySelector('.pr-check')?.textContent }; });
  ok(appr.tag === 'Needs attention' && /is-warn/.test(appr.check) && appr.text.includes('Pat Chair, the Board Chair, isn’t a second approver'), 'bill approvals that differ from the manual are called out on their step');
  ok((await page.$eval('.am-lede .am-warnstat', (e) => e.textContent)).replace(/\s+/g, ' ').includes('needs attention'), 'and counted in the lede');
  await page.evaluate(() => [...document.querySelectorAll('.pr-step')].find((x) => x.querySelector('h4').textContent.endsWith('Approving a bill')).querySelectorAll('.pr-policy button')[0].click());
  const quote = await page.evaluate(() => document.querySelector('.pr-quote')?.textContent || '');
  ok(quote.includes('Expenditures') && quote.includes('Required approval: Board Chair'), 'a policy section opens to the manual’s own words');
  ok(await page.evaluate(() => [...document.querySelectorAll('.pr-policy button')].find((b) => b.textContent === 'Segregation of Duties')?.disabled === true), 'a section the manual doesn’t have can’t be opened');
  ok((await chipsOn(page, 'A sub’s bill lands in JobTread and its approver is asked by email'))?.[0]?.t === 'Bill approvals and pay', 'bills show the approval automation');
  ok(await tagOf(page, 'Reimbursing staff and volunteers') === 'By hand', 'reimbursements are by hand');
  const moneyRows = await page.$$eval('.pr-now .pr-row', (l) => l.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  ok(moneyRows.join(' / ') === 'Bills waiting for an answer3 / Bills held for W-9 or insurance2 / Vendors asked for their papers5 / Charges not sorted onto a job4 / Odd charges to look at0', `Right now is what’s waiting (${moneyRows.join(' / ')})`);
  ok(await page.$eval('.pr-now a.pr-row', (a) => a.getAttribute('href')) === '#job-costs/bills', 'each opens its place in Job Costs');
  const card = () => page.evaluate(() => { const c = document.getElementById('pr-review'); return c ? { when: c.querySelector('.pr-review__when').textContent, last: c.querySelector('.pr-review__last').textContent, agenda: [...c.querySelectorAll('.pr-agenda li')].map((l) => l.textContent), button: c.querySelector('.btn')?.textContent || null } : null; });
  const rc = await card();
  ok(/^Due \w{3} \d+, in \d+ days\.$/.test(rc?.when) && rc.button === 'Reviewed, no changes', `the manual’s yearly review is coming up, with a way to sign it off (${rc?.when})`);
  ok(rc.agenda.some((x) => x.includes('names QuickBooks (Accounting and Controls of Checks); the books are in Mercury Books')), 'the review lists where the manual names a tool SOARD has moved off');
  ok(rc.agenda.some((x) => x.includes('Bill approvals differ from the manual')) && rc.agenda.some((x) => /\d+ of \d+ tasks are done by hand/.test(x)), 'and what differs from it, and what’s still by hand');
  ok(/Yearly review in \d+ days/.test(await page.$eval('.am-lede', (e) => e.textContent)), 'the lede says it’s coming up');
  await page.screenshot({ path: join(OUT, 'payables.png') });
  await clickText(page, '#pr-review button', 'Reviewed, no changes');
  await page.waitForFunction(() => !document.querySelector('#pr-review .btn'));
  const after2 = await card();
  ok(posts.at(-1)?.review === 'policy', 'signing it off saves the review for the manual');
  ok(/^Next due /.test(after2.when) && after2.last.startsWith('Marked reviewed') && after2.last.includes('by Peter'), `then it’s next due in a year, marked by whom (${after2.when} ${after2.last})`);
  await clickTrack(page, 'Gifts & deposits');
  await pause(200);
  ok((await stepTitles(page)).join(', ') === 'Gifts online, Events and the auction, Sponsors, Checks by mail, Into the books', 'gifts and deposits: online, events, sponsors, checks, the books');
  ok(await tagOf(page, 'Checks by mail') === 'By hand', 'checks by mail are by hand');
  await clickTrack(page, 'Books & reporting');
  await pause(200);
  ok((await page.$$eval('.pr-now .pr-row', (l) => l.map((r) => r.textContent.replace(/\s+/g, ' ').trim()))).includes('Cash 13 weeks aheadAbove the floor'), 'books show where cash is heading');
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await clickTrack(page, 'Accounts payable');
  await clickText(page, '.pr-tools button', 'Print');
  const mp = await page.evaluate(() => document.getElementById('pr-print-root')?.textContent || '');
  ok(mp.includes('Accounts payable') && mp.includes('Board policy: Expenditures, Segregation of Duties') && mp.includes('isn’t a second approver'), 'the money printout has each step’s policy and the check');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  console.log('Print');
  await clickTrack(page, 'Kids’ makeovers');
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await clickText(page, '.pr-tools button', 'Print');
  const printed = await page.evaluate(() => ({ n: window.__printed, on: document.body.classList.contains('pr-printing'), text: document.getElementById('pr-print-root')?.textContent || '' }));
  ok(printed.n === 1 && printed.on, 'Print prints');
  ok(printed.text.includes('2026 Sunshine Makeover Process') && printed.text.includes('Applying, on the website') && printed.text.includes('Runs on its own: Status → family message (Live)'), 'the printout has the Doc’s steps with their automations written out');
  await page.emulateMediaType('print');
  await page.screenshot({ path: join(OUT, 'print.png'), fullPage: true });
  const printView = await page.evaluate(() => ({ app: getComputedStyle(document.getElementById('app')).display, root: getComputedStyle(document.getElementById('pr-print-root')).display }));
  ok(printView.app === 'none' && printView.root === 'block', 'on paper only the printout shows, not the admin');
  await page.emulateMediaType('screen');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  ok(!(await page.evaluate(() => document.body.classList.contains('pr-printing') || !!document.getElementById('pr-print-root')?.textContent)), 'and it tidies up after');
  allErrors.push(...errors);
  await page.close();

  console.log('A Doc Drive couldn’t read');
  {
    const process = () => {
      const p = PROCESS();
      p.docs.makeover = { ...p.docs.makeover, error: 'Google Drive: Backend Error', errorAt: iso(0), readAt: iso(3 * 3600e3) };
      p.docs.community = { doc: null, steps: [], readAt: null, checkedAt: iso(0), error: 'Google hasn’t allowed the site to read Drive.', errorAt: iso(0), override: false };
      return p;
    };
    const { page: p2, errors: e2 } = await open(browser, base, { width: 1280, height: 900 }, { process });
    await ready(p2);
    const note = await p2.$eval('.notice--warn', (e) => e.textContent);
    ok(note.includes('Couldn’t read “2026 Sunshine Makeover Process” just now') && note.includes('as read 3 h ago'), 'a read that failed keeps the last copy and says how old it is');
    ok((await stepTitles(p2)).length === 5 + MAKEOVER.length, 'the steps stay');
    await clickTrack(p2, 'Community projects');
    await pause(200);
    ok((await p2.$eval('.notice--warn', (e) => e.textContent)).includes('Google hasn’t allowed the site to read Drive.'), 'a Doc never read says why');
    ok((await p2.$eval('.pr-empty', (e) => e.textContent)).includes('once the Doc can be read'), 'and where the steps will be');
    ok(!!(await p2.$('.notice--warn .notice__actions button')), 'with a way to paste the Doc’s link');
    allErrors.push(...e2);
    await p2.close();
  }

  console.log('Live facts failing');
  {
    const { page: p3, errors: e3 } = await open(browser, base, { width: 1280, height: 900 }, { facts: null });
    await ready(p3);
    ok((await p3.$eval('.am-check', (e) => e.textContent)).includes('Couldn’t check live status'), 'it says the live check failed');
    ok((await chipsOn(p3, 'JT sends family message'))?.[0]?.s === 'live', 'and shows the statuses as written');
    allErrors.push(...e3.filter((x) => !/500/.test(x)));
    await p3.close();
  }

  console.log('Phone');
  {
    const { page: p4, errors: e4 } = await open(browser, base, { width: 390, height: 844, deviceScaleFactor: 2 }, { touch: true });
    await ready(p4);
    // The journey scrolls sideways inside its card; nothing else may pass the edge
    const fit = await p4.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, w: innerWidth, past: [...document.querySelectorAll('.pr *')].filter((e) => !e.closest('.pr-jrow') && e.getBoundingClientRect().right > innerWidth + 1).length, jrow: (() => { const r = document.querySelector('.pr-jrow').getBoundingClientRect(); return r.right <= innerWidth + 1; })() }));
    ok(fit.sw <= fit.w && fit.past === 0 && fit.jrow, `nothing runs off the side (${fit.sw}px wide on a ${fit.w}px screen, ${fit.past} past the edge; the journey scrolls in its card)`);
    const order = await p4.evaluate(() => document.querySelector('.pr-journey').getBoundingClientRect().top < document.querySelector('.pr-steps').getBoundingClientRect().top && document.querySelector('.pr-aside').getBoundingClientRect().top > document.querySelector('.pr-steps').getBoundingClientRect().top);
    ok(order, 'on a phone the journey leads to the steps; Right now and the review follow them');
    const small = await p4.$$eval('.pr-auto, .pr-now .pr-row:not([disabled]), .pr-show button', (l) => l.filter((b) => b.getBoundingClientRect().height < 44).length);
    ok(small === 0, `every chip and row is a 44px target (${small} smaller)`);
    const tracks = await p4.$$eval('.pr-tools .pill', (l) => ({ tops: l.map((p) => Math.round(p.getBoundingClientRect().top)), names: l.map((p) => p.innerText.replace(/\s+/g, '').trim()) }));
    ok(tracks.tops[0] === tracks.tops[1] && tracks.names[0] === 'Makeovers17', `the two tracks share one row on a phone (${tracks.names.join(', ')})`);
    const head = await p4.$eval('.pr-now > h3', (h) => parseFloat(getComputedStyle(h).fontSize));
    ok(head < 13, `Right now’s heading is a small label (${head}px)`);
    const stepsTop = await p4.$eval('.pr-steps', (e) => e.getBoundingClientRect().top + scrollY);
    ok(stepsTop < 1400, `the steps start within two screens of the top (${Math.round(stepsTop)}px)`);
    await p4.screenshot({ path: join(OUT, 'phone.png') });
    await p4.evaluate(() => document.querySelector('.pr-steps:last-of-type').scrollIntoView());
    await p4.screenshot({ path: join(OUT, 'phone-steps.png') });
    allErrors.push(...e4);
    await p4.close();
  }

  ok(allErrors.length === 0, `no console errors${allErrors.length ? `: ${allErrors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nAll passed');
