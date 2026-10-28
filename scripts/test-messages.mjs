/**
 * test-messages.mjs — drive Site → Emails & invites in a real browser
 * ===================================================================
 * Opens the admin at #messages (public/ served directly). /api/messages-admin
 * is answered by the real handler on a seeded in-memory D1 (outside services
 * offline), and "Send it to me" is caught before it sends. Checks the map
 * draws with every audience, live facts turn entries off or amber, shared
 * reasons read as one line, a picked entry shows who/when/subject and
 * "Change it in", each kind of preview opens (email in a frame, JobTread
 * message, calendar invite, text, browser alert), Spanish swaps the words,
 * Send it to me posts only the message id and language, Escape closes and
 * gives focus back, filters and search work, labels never overlap with
 * everything open, and the page and preview fit a phone. What went out: the
 * emails that didn't arrive get their own card, what's coming up is listed,
 * "Will it land?" reads DNS, search finds a person, a row opens the email as
 * it went with Resend's reports, previews stay apart, an entry's panel says
 * how its emails fared and opens the log narrowed to it, and it fits every
 * laptop width and a phone. The server side never reaches the internet (DNS
 * and Resend are answered here). Screenshots land in test-results/messages/.
 * Exits non-zero on any failure or console error.
 *
 *   node scripts/test-messages.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { onRequestGet } from '../functions/api/messages-admin.js';
import { ensureCommsSchema } from '../functions/api/_applicant-comms.js';
import { ensureNotifySchema } from '../functions/api/_applicant-notify.js';
import { ensureFormSchema } from '../functions/api/_application-forms.js';
import { ensureSchema as ensureInviteSchema } from '../functions/api/_reveal-invites.js';
import { ensureSchema as ensureApplicationSchema } from '../functions/api/_applications.js';
import { ensureWaitlistSchema } from '../functions/api/_application-waitlist.js';
import { ensureRequests } from '../functions/api/_profile-requests.js';
import { ensureEmailLog } from '../functions/api/_email-log.js';
import { generateKeyPairSync } from 'node:crypto';

// A made-up Google service account, so the invite card reads guests' answers from the fake calendar below
const GOOGLE_KEY = JSON.stringify({ client_email: 'reveals@example.iam.gserviceaccount.com', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) });

// The handlers run here in Node: public DNS and Resend are answered here, everything else is offline
const DNS = {
  'send.comms.sunshineonaranneyday.com:TXT': ['"v=spf1 include:amazonses.com ~all"'],
  'send.comms.sunshineonaranneyday.com:MX': ['10 feedback-smtp.us-east-1.amazonses.com.'],
  'resend._domainkey.comms.sunshineonaranneyday.com:TXT': [`"p=${'A'.repeat(200)}"`],
  '_dmarc.comms.sunshineonaranneyday.com:TXT': ['"v=DMARC1; p=none; rua=mailto:owner@example.com"'],
  '_dmarc.sunshineonaranneyday.com:TXT': ['"v=DMARC1; p=none; rua=mailto:x@dmarc-reports.cloudflare.net"'],
  'soardcharity.com:TXT': ['"v=spf1 include:_spf.google.com ~all"'],
  'google._domainkey.soardcharity.com:TXT': [`"v=DKIM1; k=rsa; p=${'B'.repeat(200)}"`],
  'cka._domainkey.soardcharity.com:CNAME': ['dkim.dm-1.sg6.convertkit.com.'],
  'ckespa.soardcharity.com:CNAME': ['spf.dm-1.sg6.convertkit.com.'],
  '_dmarc.soardcharity.com:TXT': ['"v=DMARC1; p=none; rua=mailto:y@dmarc-reports.cloudflare.net"'],
};
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.host === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: (DNS[`${u.searchParams.get('name')}:${u.searchParams.get('type')}`] || []).map((data) => ({ data })) });
  if (u.host === 'oauth2.googleapis.com') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
  if (u.host === 'www.googleapis.com' && u.pathname.endsWith('/events/ev2')) return Response.json({ id: 'ev2', attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }, { email: 'b@example.com', responseStatus: 'tentative' }, { email: 'c@example.com', responseStatus: 'needsAction' }] });
  if (u.host === 'api.resend.com' && u.pathname.startsWith('/emails/')) return Response.json({ object: 'email', id: u.pathname.split('/')[2], html: '<html><head></head><body style="font-family: sans-serif"><h1>You’re on the list</h1><p>We’ll email you the moment applications open.</p></body></html>' });
  throw new Error(`offline: ${u.href}`);
};

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/messages/');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 864e5;

// The site's data, shaped like production on October 21, 2026: reminders off, invites on, a few family emails sent
async function seed({ invitesProblem = false } = {}) {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
    'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
    'CREATE TABLE kid_status_state (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, data TEXT)',
    'CREATE TABLE broadcast_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, recipients INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, error TEXT, created_at TEXT)',
    'CREATE TABLE broadcast_reminders (id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, subscription TEXT, kid_slug TEXT, token TEXT NOT NULL, source TEXT, created_at TEXT, unsubscribed_at TEXT, last_sent_at TEXT)',
  ] });
  for (const fn of [ensureCommsSchema, ensureNotifySchema, ensureFormSchema, ensureInviteSchema, ensureApplicationSchema, ensureWaitlistSchema, ensureRequests]) await fn(DB);
  const run = (sql, ...b) => DB.prepare(sql).bind(...b).run();
  const put = (key, data) => run('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)', key, JSON.stringify(data), iso(0));
  await put('broadcast-config', { reminders: { enabled: false, sms: false, push: false, hoursBefore: [24, 1] }, kitLive: { enabled: true }, alerts: { emails: ['ops@example.com'] } });
  await put('reveal-invites', { enabled: true, organizer: 'ccunningham@soardcharity.com' });
  await put('settings', { application: { open: false, year: '2027' } });
  await run("INSERT INTO applicant_comms (account_id, kind, state, created_at, updated_at) VALUES ('a1', 'welcome', 'sent', ?, ?), ('a2', 'welcome', 'sent', ?, ?), ('a1', 'approved', 'sent', ?, ?)", iso(DAY), iso(DAY), iso(2 * DAY), iso(2 * DAY), iso(14 * 3600e3), iso(14 * 3600e3));
  await run("INSERT INTO reveal_invites (job_id, state, error, updated_at) VALUES ('j1', 'tentative', ?, ?), ('j2', 'tentative', NULL, ?)", invitesProblem ? 'Google returned 503' : null, iso(0), iso(0));
  await run("INSERT INTO reveal_invite_log (job_id, action, state, guests, created_at) VALUES ('j1', 'created', 'tentative', 9, ?), ('j1', 'updated', 'tentative', 9, ?)", iso(3 * DAY), iso(3600e3));
  await run("INSERT INTO reveal_board_emails (slug, email, updated_at) VALUES ('ann', 'ann@example.com', ?)", iso(0));
  // What went out: emails the site sent, with Resend's reports
  await ensureEmailLog(DB);
  await run("INSERT INTO applications (id, child_name, parent_name, parent_email, status, submitted_at, updated_at) VALUES ('app1', 'Avery Stone', 'Jordan Stone', 'jordan@example.com', 'done', ?, ?)", iso(DAY), iso(DAY));
  const sent = (id, type, to, subject, ago, status, extra = {}) => run(`INSERT INTO email_log (id, type, to_addr, subject, sent_at, status, status_at, detail, bounce_type, opened_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'site')`,
    id, type, to, subject, iso(ago), status, iso(ago - 60e3), extra.detail || null, extra.bounce || null, extra.opened ? iso(ago - 600e3) : null);
  await sent('em_resume', 'application-resume', 'jordan@example.com', 'Your SOARD application: pick up where you left off', 3 * 3600e3, 'delivered', { opened: true });
  await sent('em_wait', 'application-waitlist', 'fan1@example.com', 'You’re on the list', DAY + 3600e3, 'delivered');
  await sent('em_bounce', 'application-waitlist', 'typo@exmaple.com', 'You’re on the list', 2 * 3600e3, 'bounced', { detail: 'The address doesn’t exist (the mail server said no such mailbox).', bounce: 'Permanent' });
  await sent('em_staff', 'application', 'staff@example.com', 'New makeover application: Avery', 40 * 60e3, 'sent');
  await sent('em_prev', 'admin-preview', 'me@example.com', '[Preview] You’re on the list', 30 * 60e3, 'delivered');
  for (const [id, type, ago, detail] of [['em_bounce', 'bounced', 2 * 3600e3 - 60e3, 'The address doesn’t exist (the mail server said no such mailbox).'], ['em_resume', 'delivered', 3 * 3600e3 - 60e3, null], ['em_resume', 'opened', 3 * 3600e3 - 600e3, null]]) {
    await run('INSERT INTO email_events (email_id, type, at, detail) VALUES (?, ?, ?, ?)', id, type, iso(ago), detail);
  }
  await run("INSERT INTO email_tracking (key, value, updated_at) VALUES ('status', ?, ?)", JSON.stringify({ state: 'on', checkedAt: iso(5 * 60e3) }), iso(0));
  // An invite on calendars now, for a reveal next week (Google isn't reachable here, so no answers)
  await run("UPDATE reveal_invites SET event_id = 'ev2', reveal_date = ?, guests = ? WHERE job_id = 'j2'", new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10), JSON.stringify(['a@example.com', 'b@example.com', 'c@example.com']));
  // Coming up: a family's Approved email waiting out its half hour
  await run("INSERT INTO applicant_notify (account_id, name, status, kind, due_at, updated_at) VALUES ('acc9', 'Riley Park', 'Approved', 'approved', ?, ?)", Date.now() + 25 * 60e3, iso(0));
  return DB;
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

async function open(browser, base, viewport, { DB, down = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  const posts = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  const env = { DB, RESEND_API_KEY: 'x', KIT_API_KEY: 'x', GOOGLE_CALENDAR_KEY: GOOGLE_KEY, JOBTREAD_GRANT_KEY: 'x', JOBTREAD_QC_GRANT_KEY: 'x' };
  page.on('request', async (req) => {
    const url = new URL(req.url());
    const json = (obj, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.origin !== base) return req.abort();
    if (url.pathname === '/api/messages-admin') {
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        posts.push(body);
        return json({ success: true, sentTo: 'me@example.com', kind: body.send.includes('invite') ? 'invite' : 'email', stage: 'tentative' });
      }
      if (down && !url.searchParams.has('preview')) return json({ success: false, error: 'D1 timed out' }, 500);
      const r = await onRequestGet({ env, data: { userEmail: 'me@example.com' }, request: new Request(url.href) });
      return req.respond({ status: r.status, contentType: 'application/json', body: await r.text() });
    }
    if (url.pathname === '/api/live-ws') return req.abort();
    if (url.pathname.startsWith('/api/list-content')) return json({ success: true, items: [], total: 0, hasMore: false });
    if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], since: null });
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
    return req.continue();
  });
  await page.goto(`${base}/admin/#messages`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.am-canvas svg .am-node.d1', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.am-canvas svg')?.getAttribute('style')?.includes('opacity: 0'));
  await page.waitForFunction(() => !document.querySelector('.am-check')?.textContent.includes('Checking'));
  return { page, errors, posts };
}

const nodeBy = (label) => `[...document.querySelectorAll('.am-node')].find((n) => n.querySelector('text')?.textContent === ${JSON.stringify(label)})`;
const boxOf = (page, label) => page.evaluate(`(() => { const g = ${nodeBy(label)}; if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const clickNode = (page, label) => page.evaluate(`${nodeBy(label)}.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
const panelTitle = (page) => page.$eval('.am-panel h3', (e) => e.textContent).catch(() => null);
const clickButton = (page, scope, text) => page.evaluate((scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === text).click(), scope, text);
const statusOf = (page, title) => page.evaluate((title) => {
  const li = [...document.querySelectorAll('.am-inv-branch li')].find((l) => l.querySelector('b')?.textContent === title);
  return li ? li.querySelector('.am-meta').textContent.split(' · ')[0] : null;
}, title);
// Open an entry's preview from the written-out list
async function preview(page, title) {
  await page.evaluate((title) => [...document.querySelectorAll('.am-inv-branch li')].find((l) => l.querySelector('b')?.textContent === title).querySelector('button.mm-change').click(), title);
  await page.waitForSelector('.mm-sheet');
  await page.waitForFunction(() => !document.querySelector('.mm-wait'), { timeout: 10000 });
  await pause(500);
}
const sheetText = (page) => page.$eval('.mm-sheet', (e) => e.innerText);
const closeSheet = async (page) => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.mm-sheet')); };
const frameText = (page) => page.$eval('.mm-frame', (f) => f.contentDocument?.body?.innerText || '');

const server = await serve();
const base = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  console.log('Desktop, live facts');
  const { page, errors, posts } = await open(browser, base, { width: 1440, height: 1000 }, { DB: await seed() });
  ok(await page.$eval('.page-header h2', (e) => e.textContent) === 'Emails & invites', 'the page opens from #messages');
  ok(await page.$eval('.sidebar .active, [aria-current="page"]', (e) => e.textContent.includes('Emails & invites')).catch(() => true), 'its menu item is the current one');
  ok((await page.$eval('.am-check', (e) => e.textContent)).includes('Statuses checked live'), 'it says the statuses were checked live');
  const branches = await page.$$eval('.am-node.d1 text', (t) => t.map((x) => x.textContent));
  const WANT = ['Families', 'Reveal guests', 'Demo day guests', 'Reveal watchers', 'Staff', 'Newsletter list', 'Board & advisors'];
  ok(WANT.every((b) => branches.includes(b)) && branches.length === WANT.length, `every audience is a branch (${branches.join(', ')})`);
  const inView = await page.evaluate(() => {
    const c = document.querySelector('.am-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.am-node')].every((n) => { const r = n.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; });
  });
  ok(inView, 'the opening view fits the whole map in the canvas');
  await clickButton(page, '.am-tools', 'Open all');
  await pause(400);
  const tags = await page.evaluate(() => [...document.querySelectorAll('.am-node.leaf')].map((g) => ({ name: g.querySelector(':scope > text').textContent, tags: [...g.querySelectorAll('.am-tag text')].map((t) => t.textContent) })));
  ok(tags.length > 30 && tags.every((t) => t.tags.length > 0), `every message on the map says who sends it (${tags.filter((t) => !t.tags.length).map((t) => t.name).join(', ') || 'all do'})`);
  const tagOf = (name) => tags.find((t) => t.name === name)?.tags.join(' + ');
  for (const [name, want] of [['Approved', 'JobTread'], ['New application', 'Resend'], ['Applications are open', 'Kit + Resend'], ['Save the date', 'Resend + Browser'], ['Live reveal alerts', 'Resend + Twilio'], ['Save-the-date invite', 'Google Calendar'], ['Bio request', 'Your email']]) ok(tagOf(name) === want, `${name}: ${want} (shows ${tagOf(name)})`);
  await clickButton(page, '.am-tools', 'Reset');
  await pause(300);

  for (const [title, want] of [
    ['Application received', 'Live'], ['Approved', 'Live'], ['Save-the-date invite', 'Live'], ['Save the date', 'Off'], ['We’re live', 'Off'],
    ['Welcome to alert texts', 'Off'], ['We’re live (Kit)', 'Live'], ['New application', 'Live'], ['Invite problem', 'Live'], ['Bio request', 'Live'],
  ]) ok(await statusOf(page, title) === want, `${title}: ${want}`);

  const home = await page.$eval('.am-panel', (e) => e.innerText);
  ok(home.includes('Nothing needs attention'), 'nothing needs attention in these facts');
  const groups = await page.$$eval('.am-panel .am-mini-group', (g) => g.map((x) => x.querySelectorAll('.am-mini-names button').length));
  ok(groups.join(',') === '2,7,4,6', `the two demo day invites (paused) read as one line, the seven entries reminders switch off as another, the four waiting on Twilio as a third, and the six Slack-only posts as a fourth (${groups.join(', ')})`);
  ok((home.match(/Reminders are switched off/g) || []).length === 1, 'the reason is written once');
  await page.screenshot({ path: join(OUT, 'desktop.png') });

  await clickNode(page, 'Status emails');
  await pause(350);
  await clickNode(page, 'Approved');
  await pause(300);
  ok(await panelTitle(page) === 'Approved', 'clicking an entry shows it in the panel');
  const panel = await page.$eval('.am-panel', (e) => e.textContent);
  for (const want of ['Sent from', 'Qualification Committee, and JobTread emails it', 'English and Spanish', 'Checked live', 'Who gets it', 'When it goes', 'Application Decision', 'Decisión sobre la solicitud', 'Applications → Emails', 'Last went 14 h ago', '1 in the last 30 days']) ok(panel.includes(want), `the panel shows “${want}”`);

  await clickButton(page, '.am-panel', 'See the email');
  await page.waitForSelector('.mm-sheet');
  await page.waitForFunction(() => !document.querySelector('.mm-wait'), { timeout: 10000 });
  let text = await sheetText(page);
  ok(text.includes('Application Decision') && text.includes('Jordan Stone') && /approved/.test(text), 'a status email shows its JobTread words, filled in for the sample family');
  ok(!(await page.$('.mm-foot .btn-primary')) && text.includes('JobTread sends this one'), 'JobTread’s emails say why there’s no Send it to me');
  ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Close'), 'the sheet takes focus');
  await clickButton(page, '.mm-sheet', 'Spanish');
  await page.waitForFunction(() => document.querySelector('.mm-sheet')?.innerText.includes('Decisión sobre la solicitud'), { timeout: 8000 }).catch(() => {});
  text = await sheetText(page);
  ok(text.includes('Decisión sobre la solicitud') && /aprobada/.test(text), 'Spanish shows what Spanish-speaking families get');
  await pause(400); // the sheet fades in
  await page.screenshot({ path: join(OUT, 'sheet-jobtread-es.png') });
  await closeSheet(page);
  ok(await page.evaluate(() => document.activeElement?.textContent.trim() === 'See the email'), 'Escape closes it and gives focus back');

  await preview(page, 'New application');
  ok((await page.$eval('.mm-env-subject', (e) => e.textContent)) === 'New makeover application: Avery', 'the subject is the real one');
  ok((await page.$eval('.mm-env .mm-sender', (e) => e.textContent)) === 'Resend', 'the preview says who sends it');
  ok((await frameText(page)).includes('Avery’s family applied'), 'the email itself renders in the frame');
  const frameH = await page.$eval('.mm-frame', (f) => f.getBoundingClientRect().height);
  ok(frameH > 600, `the frame grows to the email (${Math.round(frameH)}px)`);
  await clickButton(page, '.mm-sheet', 'Send it to me');
  await page.waitForFunction(() => document.querySelector('.mm-foot p')?.textContent.startsWith('Sent to'), { timeout: 5000 }).catch(() => {});
  ok(JSON.stringify(posts.at(-1)) === JSON.stringify({ send: 'staff-new-app', lang: 'en' }), 'Send it to me posts only which message and the language');
  ok((await page.$eval('.mm-foot p', (e) => e.textContent)).includes('Look for [Preview]'), 'and says where to look');
  await page.screenshot({ path: join(OUT, 'sheet-email.png') });
  await closeSheet(page);

  await preview(page, 'Applications are open');
  await clickButton(page, '.mm-sheet', 'Phone');
  await pause(700);
  const fit = await page.$eval('.mm-frame', (f) => ({ t: f.style.transform, wrap: f.parentElement.getBoundingClientRect().width }));
  ok(/scale\(0\.\d+\)/.test(fit.t) && fit.wrap <= 381, `a fixed-width email shrinks to a phone screen (${fit.t}, ${Math.round(fit.wrap)}px)`);
  await page.screenshot({ path: join(OUT, 'sheet-phone-width.png') });
  await closeSheet(page);

  await preview(page, 'Save the date');
  ok(!!(await page.$('.mm-frame')), 'a reminder opens on its email');
  ok(!(await page.evaluate(() => [...document.querySelectorAll('.mm-sheet button')].some((b) => b.textContent.trim() === 'Text'))), 'a reminder has no text: the public is never texted');
  await clickButton(page, '.mm-sheet', 'Browser alert');
  await pause(200);
  ok((await page.$eval('.mm-push b', (e) => e.textContent)) === 'Reveal scheduled', 'and its browser alert as an alert');
  await closeSheet(page);

  await preview(page, 'Live reveal alerts');
  await clickButton(page, '.mm-sheet', 'Text');
  await pause(200);
  ok((await page.$eval('.mm-bubble', (e) => e.textContent)).startsWith('⏰ SOARD ALERT: Scheduled reveal never went live'), 'a staff alert shows its text, as an alert');
  ok((await page.$eval('.mm-env .mm-sender', (e) => e.textContent)) === 'Twilio' && (await page.$$eval('.mm-env dd', (d) => d[1].textContent)).includes('Twilio'), 'Sent by and From follow the version on screen');
  ok(!(await page.$('.mm-foot .btn-primary')), 'a text can’t be sent as a preview');
  await page.screenshot({ path: join(OUT, 'sheet-staff-text.png') });
  await closeSheet(page);

  await preview(page, 'Reveal-day texts');
  const thread = await page.$$eval('.mm-thread .mm-msg', (m) => m.map((x) => [x.querySelector('.mm-when')?.textContent || '', x.querySelector('.mm-bubble').textContent.split('\n')[0]]));
  ok(thread.length === 5 && thread[3][1] === '🚨 SOARD ALERT: Reveal audio is silent' && /the check an hour before/.test(thread[0][0]), `reveal day shows as a conversation, each text with when it comes (${thread.map((t) => t[1]).join(' | ')})`);
  ok(/Texting isn’t connected yet/.test(await page.$eval('.mm-foot p', (e) => e.textContent)) && !(await page.$('.mm-foot .btn-primary')), 'without Twilio it says so, and offers no button');
  await page.screenshot({ path: join(OUT, 'sheet-reveal-texts.png') });
  await closeSheet(page);

  await preview(page, 'Save-the-date invite');
  text = await sheetText(page);
  ok(text.includes('Avery’s Reveal Day (tentative)'.replace('’', "'")) && text.includes('all day') && text.includes('Free, so it blocks no one’s day'), 'the invite shows as a save-the-date');
  ok(text.includes('123 Sample Lane'), 'with the full address');
  await clickButton(page, '.mm-sheet', 'Send it to me');
  await page.waitForFunction(() => document.querySelector('.mm-foot p')?.textContent.includes('TEST'), { timeout: 5000 }).catch(() => {});
  ok((await page.$eval('.mm-foot p', (e) => e.textContent)).includes('nobody else is invited'), 'Send it to me on an invite says it’s a TEST invite only for you');
  await page.screenshot({ path: join(OUT, 'sheet-invite.png') });
  await closeSheet(page);

  await preview(page, 'Demo day invite');
  text = await sheetText(page);
  ok(text.includes("Avery's Demo Day") && text.includes('9:00 AM') && text.includes('123 Sample Lane') && text.includes('Please accept or decline'), `the demo day invite: the sample kid at the default time, with the address (${text.slice(0, 160)})`);
  await page.screenshot({ path: join(OUT, 'sheet-demo-invite.png') });
  await closeSheet(page);

  // Sent by is a menu beside Depends on (one sender at a time)
  await page.select('.am-filters--pick select', 's:google');
  await pause(400);
  ok((await page.$eval('.am-hits', (e) => e.textContent)) === '8 matches', 'Sent by Google Calendar finds the eight invite messages (five for reveals, two for demo day, one for board meetings)');
  await clickButton(page, '.am-tools', 'Reset');
  await page.select('.am-filters--pick select', 's:kit');
  await pause(400);
  const kitHits = await page.$$eval('.am-node.leaf.hit-on text:not(.am-tag text)', (t) => t.map((x) => x.textContent).filter((x) => x !== 'Kit'));
  const KIT = ['Applications are open', 'We’re live (Kit)', 'Reveal drafts in Kit', 'Newsletter', 'Welcome to the newsletter'];
  ok(KIT.every((k) => kitHits.includes(k)) && kitHits.length === KIT.length, `Sent by Kit finds what Kit sends (${kitHits.join(', ')})`);
  await clickButton(page, '.am-tools', 'Reset');
  const resendCount = await page.evaluate(() => [...document.querySelectorAll('.am-lede button')].find((b) => b.textContent.includes('sent by Resend')).querySelector('b').textContent);
  await clickButton(page, '.am-lede', `${resendCount} sent by Resend`);
  await pause(400);
  ok((await page.$eval('.am-hits', (e) => e.textContent)) === `${resendCount} matches`, `the lede’s Resend count (${resendCount}) is a filter that finds as many`);
  await clickButton(page, '.am-tools', 'Reset');
  await page.type('#am-search', 'decisión');
  await pause(500);
  ok((await page.$eval('.am-hits', (e) => e.textContent)) === '2 matches' && !!(await boxOf(page, 'Denied')), 'search finds Spanish subjects too');
  await clickButton(page, '.am-tools', 'Reset');
  await page.select('#am-svc', 'Twilio');
  await pause(400);
  ok(await panelTitle(page) === 'If Twilio stops working', '“Depends on” lists what goes through a service');

  await clickButton(page, '.am-tools', 'Open all');
  await pause(500);
  const overlaps = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('.am-node text')].map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }));
    const bad = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) bad.push(`${rects[i].t} × ${rects[j].t}`);
    }
    const c = document.querySelector('.am-canvas').getBoundingClientRect();
    const clipped = rects.filter(({ r }) => r.left < c.left || r.right > c.right).map((x) => x.t);
    return { bad, count: rects.length, clipped };
  });
  ok(overlaps.bad.length === 0, `no labels overlap with all ${overlaps.count} open${overlaps.bad.length ? ': ' + overlaps.bad.slice(0, 5).join('; ') : ''}`);
  ok(overlaps.clipped.length === 0, `no label is cut off with everything open${overlaps.clipped.length ? ': ' + overlaps.clipped.slice(0, 4).join(', ') : ''}`);
  await page.screenshot({ path: join(OUT, 'desktop-all-open.png') });
  await clickButton(page, '.am-tools', 'Reset');

  // ── What went out ──
  ok(await page.$eval('.mm-tabs [data-tab="sent"] .mm-tab-n', (e) => e.textContent.trim().startsWith('1')).catch(() => false), 'the tab says one email didn’t arrive');
  ok((await page.$eval('.am-lede', (e) => e.textContent)).includes('1 didn’t arrive (30 days)'), 'and so does the map’s lede');
  await clickNode(page, 'Waitlist');
  await pause(350);
  await clickNode(page, 'You’re on the list');
  await pause(300);
  const arrive = await page.$eval('.am-panel', (e) => e.innerText);
  ok(/Did it arrive/i.test(arrive) && arrive.includes('2 sent in 30 days: 1 delivered') && arrive.includes('1 didn’t arrive'), `an entry says how its emails fared (${arrive.match(/\d+ sent in 30 days[^\n]*/)?.[0]})`);
  await clickButton(page, '.am-panel', 'What went out');
  await page.waitForSelector('.ms-row', { timeout: 10000 });
  ok(await page.evaluate(() => location.hash) === '#messages/sent', 'the panel’s What went out opens the log');
  ok((await page.$eval('.ms-only', (e) => e.textContent)).includes('Only “You’re on the list”'), 'narrowed to that message');
  const onlyRows = await page.$$eval('.ms-row b', (b) => [...new Set(b.map((x) => x.textContent))]);
  ok(onlyRows.length === 1 && onlyRows[0] === 'You’re on the list', `and only it (${onlyRows.join(', ')})`);
  await clickButton(page, '.ms-only', '×');
  await pause(200);
  let sentText = await page.$eval('.ms', (e) => e.innerText);
  ok(/Didn’t arrive/.test(sentText) && sentText.includes('typo@exmaple.com') && sentText.includes('The address doesn’t exist'), 'what didn’t arrive gets its own card: who, and why');
  ok(sentText.includes('Riley Park’s family'), 'coming up: a family email waiting out its quiet time');
  ok(sentText.includes('Jordan Stone (Avery’s family)'), 'a family’s address shows their name');
  ok(/Delivered, opened/.test(sentText), 'an opened email says so');
  ok(sentText.includes('Posted to JobTread, which emails it'), 'JobTread’s emails are in the same timeline');
  ok(!sentText.includes('me@example.com'), 'previews to yourself stay out of the way');
  const marks = await page.$$eval('.ms-health li', (l) => l.map((x) => x.querySelector('span')?.getAttribute('aria-label')));
  ok(marks.length === 9 && marks.every((m) => m === 'Passes'), `Will it land? checks SPF, DKIM and DMARC on both domains (${marks.join(', ')})`);
  ok(sentText.includes('not to Cloudflare’s DMARC dashboard'), 'and says the comms subdomain’s DMARC reports skip Cloudflare');
  ok(/Invites out now[\s\S]*Save-the-date[\s\S]*1 coming[\s\S]*0 can’t[\s\S]*1 maybe[\s\S]*1 haven’t answered[\s\S]*answered the save-the-date on their own/.test(sentText), 'invites out now: guests who answered a save-the-date show, read from Google Calendar');
  ok(/Resend reports back on every email/.test(await page.$eval('.ms-check', (e) => e.textContent)), 'it says Resend reports back');
  await page.screenshot({ path: join(OUT, 'sent-desktop.png') });

  await clickButton(page, '.ms-chips', 'Previews and tests1');
  await pause(200);
  ok((await page.$eval('.ms-log', (e) => e.innerText)).includes('me@example.com'), 'Previews and tests shows them');
  await clickButton(page, '.ms-chips', 'Didn’t arrive1');
  await pause(200);
  ok((await page.$$('.ms-row')).length === 1, 'Didn’t arrive shows just that one');
  await clickButton(page, '.ms-chips', 'Didn’t arrive1');
  await page.type('.ms-search input', 'jordan');
  await pause(300);
  const jordan = await page.$$eval('.ms-row .ms-who', (w) => w.map((x) => x.textContent));
  ok(jordan.length >= 1 && jordan.every((w) => /jordan/i.test(w)), `search finds a person (${jordan.length})`);
  await page.evaluate(() => { const i = document.querySelector('.ms-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await pause(200);

  const rowBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.ms-log .ms-row')].find((b) => b.textContent.includes('typo@exmaple.com')));
  await rowBtn.click();
  await page.waitForSelector('#ms-sheet-title');
  await page.waitForFunction(() => document.querySelector('.mm-frame')?.contentDocument?.body?.innerText.includes('on the list'), { timeout: 8000 }).catch(() => {});
  const rs = await page.$eval('.mm-sheet', (e) => e.innerText);
  ok(rs.includes('Bounced') && rs.includes('The address doesn’t exist'), 'a row opens with what Resend reported, and why');
  ok((await frameText(page)).includes('We’ll email you the moment applications open'), 'and the email exactly as it went');
  ok(rs.includes('See the sample'), 'with the sample one click away');
  await pause(400); // the sheet fades in
  await page.screenshot({ path: join(OUT, 'sent-row.png') });
  await closeSheet(page);
  ok(await page.evaluate(() => document.activeElement?.classList.contains('ms-row')), 'Escape gives focus back to the row');

  // Every laptop width, inside the admin's own shell: nothing scrolls sideways
  for (const width of [768, 820, 1025, 1100, 1180, 1280, 1440]) {
    await page.setViewport({ width, height: 900 });
    await pause(250);
    const o = await page.evaluate(() => {
      const main = document.querySelector('.main')?.getBoundingClientRect();
      const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const past = [...document.querySelectorAll('.ms *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && main && r.right > main.right + 1; }).map((el) => el.className || el.tagName).slice(0, 3);
      return { page, past };
    });
    ok(o.page <= 0 && !o.past.length, `${width}px: no sideways scroll${o.past.length ? ` (past the edge: ${o.past.join(', ')})` : ''}`);
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluate(() => document.querySelector('.mm-tabs [data-tab="map"]').click());
  await pause(500);
  ok(await page.evaluate(() => { const r = document.querySelector('.am-canvas')?.getBoundingClientRect(); return r && r.width > 400; }), 'back on the map, it’s drawn at full size');

  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);

  // "Change it in" takes you there (the stubbed Applications page that opens isn't under test)
  await clickNode(page, 'While applying');
  await pause(300);
  await clickNode(page, 'Your application is waiting');
  await pause(200);
  await clickButton(page, '.am-panel', 'Applications → Emails');
  await pause(400);
  ok(await page.evaluate(() => location.hash) === '#applications/emails', '“Change it in” opens the place to change it');
  ok(await page.$eval('.page-header h2', (e) => e.textContent).catch(() => '') !== 'Emails & invites', 'and leaves this page');
  await page.close();

  console.log('Desktop, a problem and a failed check');
  const bad = await open(browser, base, { width: 1440, height: 1000 }, { DB: await seed({ invitesProblem: true }) });
  ok(await statusOf(bad.page, 'Save-the-date invite') === 'Needs attention' && await statusOf(bad.page, 'Invite problem') === 'Needs attention', 'an invite with a problem needs attention');
  ok((await bad.page.$eval('.am-lede .am-warnstat b', (e) => e.textContent)) !== '0', 'the lede counts it');
  await bad.page.close();
  const down = await open(browser, base, { width: 1440, height: 1000 }, { DB: await seed(), down: true });
  ok((await down.page.$eval('.am-check', (e) => e.textContent)).includes('Couldn’t check live status (D1 timed out)'), 'a failed live check says so');
  ok(await statusOf(down.page, 'Save the date') === 'Live', 'and the written statuses stand in');
  ok(down.errors.length === 0, `no console errors${down.errors.length ? ': ' + down.errors.slice(0, 3).join(' | ') : ''}`);
  await down.page.close();

  console.log('Phone');
  const phone = await open(browser, base, { width: 390, height: 844, isMobile: true, hasTouch: true }, { DB: await seed() });
  const side = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(side <= 0, `no sideways scroll at 390px (${side}px)`);
  await preview(phone.page, 'New application');
  const sheet = await phone.page.$eval('.mm-sheet', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, b: r.bottom }; });
  ok(sheet.w <= 390 && sheet.b <= 845, 'the preview is a bottom sheet that fits the phone');
  ok(await phone.page.$eval('.mm-frame', (f) => f.getBoundingClientRect().width <= 390), 'and the email fits inside it');
  ok(!(await phone.page.$('.mm-width')) || await phone.page.$eval('.mm-width', (e) => getComputedStyle(e).display === 'none'), 'a phone has no Computer / Phone switch');
  await phone.page.screenshot({ path: join(OUT, 'phone-sheet.png') });
  await closeSheet(phone.page);
  await phone.page.evaluate(() => document.querySelector('.mm-tabs [data-tab="sent"]').click());
  await phone.page.waitForSelector('.ms-row', { timeout: 10000 });
  const side2 = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(side2 <= 0, `What went out: no sideways scroll at 390px (${side2}px)`);
  await phone.page.screenshot({ path: join(OUT, 'sent-phone.png'), fullPage: false });
  await phone.page.evaluate(() => [...document.querySelectorAll('.ms-log .ms-row')][0].click());
  await phone.page.waitForSelector('#ms-sheet-title');
  const sh2 = await phone.page.$eval('.mm-sheet', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, b: r.bottom }; });
  ok(sh2.w <= 390 && sh2.b <= 845, 'a row opens as a bottom sheet that fits the phone');
  ok(phone.errors.length === 0, `no console errors on a phone${phone.errors.length ? ': ' + phone.errors.slice(0, 3).join(' | ') : ''}`);
  await phone.page.close();
} catch (e) {
  failures.push(e.stack || e.message);
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
