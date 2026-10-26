/**
 * test-admin-sidebar.mjs — drive the admin's sidebar in a real browser
 * ====================================================================
 * Serves public/ directly and stubs every /api call (and Access's
 * get-identity). Checks:
 *   - the groups and their order (one NAV list), and ⌘K in the same order,
 *     a name match ranked above a hint match
 *   - the counts (Applications, People, Press) and the LIVE marker on Reveals,
 *     Publish to site, who's signed in and Sign out; nothing when there's none
 *   - the signed-in person's website photo from People (first@ matches a Team
 *     member's first name, never a board member's), initials when there's no
 *     match or the photo can't load
 *   - addresses: every area, a tab inside one (#people/board), an open item
 *     (#events/test-picnic) that Back closes and Forward reopens, old addresses
 *     (#broadcast/demo, #deploys, #advisory-applications), Reveals' tabs,
 *     reload, ⌘-click into a new tab, an unknown anchor left alone
 *   - the icon rail: the panel button, [ and the logo button, remembered after
 *     reload, labels beside the icons on hover and focus
 *   - an area's code starts loading on hover, and opens without a spinner
 *   - the whole menu fits a 13" laptop with Publish showing; shorter screens
 *     scroll the middle with edge shadows; nothing sideways from 1025 to 1280
 *   - the phone drawer: out of the tab order when closed, focus on open,
 *     Escape back to the menu button, the page behind inert, 44px items
 * Screenshots in test-results/admin-sidebar/. Exits non-zero on any failure.
 *
 *   node scripts/test-admin-sidebar.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/admin-sidebar/');
mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, 'public', p));
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const fails = []; const ok = (c, m) => { if (!c) fails.push(m); console.log(`${c ? '  ✓' : '  ✗'} ${m}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const EVENT = { slug: 'test-picnic', title: 'Test Picnic', date: '2027-05-01', status: 'upcoming', location: 'Example Park' };
const CF = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const TEAM = [
  { slug: 'linzi-berkowitz', name: 'Linzi Lawsky', group: 'team', status: 'active', photo: `${CF}/team/linzi-berkowitz/1/public` },
  { slug: 'linzi-board', name: 'Linzi Board', group: 'board', status: 'active', photo: `${CF}/team/linzi-board/1/public` },
  { slug: 'casey-bradley', name: 'Casey Bradley', group: 'board', status: 'active', photo: `${CF}/team/casey-bradley/1/public` },
];
// A 1×1 PNG for every Cloudflare Images request (or a 404 when the test says the photo is gone)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const state = { live: true, waiting: 3, me: true, applied: 4, email: 'linzi@soardcharity.com', photoGone: false };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });

async function open(w, h, hash = '', { rail = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.errors = []; page.reqs = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|live-ws/.test(m.text())) page.errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.hostname === 'imagedelivery.net' || url.pathname.startsWith('/cdn-cgi/imagedelivery/')) {
      const headers = { 'Access-Control-Allow-Origin': '*' };
      if (url.pathname.endsWith('/f=json')) return req.respond({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ width: 1200, height: 1200 }) });
      return state.photoGone ? req.respond({ status: 404, headers, body: '' }) : req.respond({ status: 200, headers, contentType: 'image/png', body: PNG });
    }
    if (url.origin !== base) return req.abort();
    page.reqs.push(url.pathname + url.search);
    if (url.pathname === '/cdn-cgi/access/get-identity') return state.me ? json({ email: state.email, name: '' }) : req.respond({ status: 404, body: '' });
    if (url.pathname === '/api/live-status') return json({ live: state.live, phase: state.live ? 'live' : 'idle' });
    if (url.pathname === '/api/applicants-count') return json({ success: true, applied: state.applied, waiting: (state.replies || []).length, replies: state.replies || [] });
    if (url.pathname === '/api/advisory-applications-admin') return url.searchParams.get('count') ? json({ success: true, new: 2 }) : json({ success: false, error: 'not in this test' }, 500);
    if (url.pathname === '/api/press-admin') return url.searchParams.get('summary') ? json({ success: true, review: 3 }) : json({ success: false, error: 'not in this test' }, 500);
    if (url.pathname === '/api/broadcast-admin') return json({ success: false, error: 'not in this test' }, 500);
    if (url.pathname === '/api/pending-changes') return json({ success: true, since: null, changes: Array.from({ length: state.waiting }, (_, i) => ({ type: 'kids', slug: `k${i}`, name: `Kid ${i}`, at: new Date().toISOString(), state: 'waiting' })), publish: { tracking: false } });
    if (url.pathname === '/api/list-content') {
      const dir = url.searchParams.get('dir');
      if (dir === 'src/content/events') return json({ success: true, items: [{ name: 'test-picnic.json', content: EVENT }], pages: 1 });
      if (dir === 'src/content/team') return json({ success: true, items: TEAM.map((t) => ({ name: `${t.slug}.json`, content: t })), pages: 1 });
      return json({ success: true, items: [], files: [], pages: 1 });
    }
    if (url.pathname === '/api/read-content') return json(/events\/test-picnic\.json$/.test(url.searchParams.get('path') || '') ? { success: true, content: EVENT, sha: 'abc' } : { success: false, error: 'not in this test' }, /test-picnic/.test(url.search) ? 200 : 404);
    if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true, items: [], entries: [], deploys: [] });
    return req.continue();
  });
  // The rail starts as asked on this tab's first load only, so a reload shows what the admin remembered
  await page.evaluateOnNewDocument((r) => { try { if (!sessionStorage.getItem('rail-set')) { localStorage.setItem('soard-admin-rail', r ? '1' : '0'); sessionStorage.setItem('rail-set', '1'); } } catch { /* fine */ } }, rail);
  await page.goto(`${base}/admin/${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.side-nav .nav-item', { timeout: 15000 });
  await pause(400);
  return page;
}
const hashOf = (page) => new URL(page.url()).hash;
const active = (page) => page.$eval('.side-nav [aria-current="page"] .nav-label', (e) => e.textContent).catch(() => null);
const clickNav = (page, label) => page.evaluate((l) => { const a = [...document.querySelectorAll('.side-nav .nav-item')].find((x) => x.querySelector('.nav-label').textContent === l); a?.click(); return !!a; }, label);
const clickText = (page, sel, text) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(t)); el?.click(); return !!el; }, sel, text);
const activeTab = (page) => page.$eval('.hub-tab.active', (t) => t.childNodes[0].textContent.trim()).catch(() => null);

try {
  console.log('Desktop 1440×900');
  let page = await open(1440, 900);
  const groups = await page.$$eval('.side-nav .nav-group', (gs) => gs.map((g) => `${g.querySelector('.nav-section')?.textContent || '·'}: ${[...g.querySelectorAll('.nav-label')].map((l) => l.textContent).join(', ')}`));
  ok(groups.join(' | ') === '·: Dashboard, Applications, Kids, Demo Day, Reveals | Website: People, Partners, Press, Events, Articles, Site Config | System: Emails & invites, Automations, Audit log, Publish history', `groups and order (${groups.join(' | ')})`);
  ok(await active(page) === 'Dashboard', 'Dashboard is current on load');
  const badges = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.side-nav .nav-item')].map((a) => [a.querySelector('.nav-label').textContent, (a.querySelector('.nav-count')?.textContent || '') + (a.querySelector('.nav-live') ? 'LIVE' : '')]).filter(([, v]) => v)));
  ok(JSON.stringify(badges) === JSON.stringify({ Applications: '4', Reveals: 'LIVE', People: '2', Press: '3' }), `counts and LIVE (${JSON.stringify(badges)})`);
  ok(await page.$eval('.side-nav a[href="#applications"]', (a) => a.textContent.includes('4 families wait for a first look')), 'the Applications count says what it counts, for screen readers');
  ok(/^Publish to site\s*3/.test(await page.$eval('.sidebar-deploy', (b) => b.textContent.replace(/\s+/g, ' ').trim())), 'Publish to site with its count');
  ok(await page.$eval('.side-me', (e) => e.textContent.replace(/\s+/g, ' ').trim()) === 'LLinzi Lawskylinzi@soardcharity.com', 'who is signed in, by their name on People');
  const avatar = () => page.$eval('.side-avatar', (a) => { const i = a.querySelector('img'); return { src: i?.getAttribute('src') || '', shown: !!i && !i.hidden && i.complete && i.naturalWidth > 0, w: i?.getBoundingClientRect().width, round: getComputedStyle(a).borderRadius }; });
  let av = await avatar();
  ok(av.shown && av.src.includes('/team/linzi-berkowitz/') && /w=56,h=56/.test(av.src) && av.w === 28 && av.round === '50%', `their website photo is the avatar, the Team member not the board member (${av.src})`);
  ok(await page.$eval('.side-signout', (a) => a.getAttribute('href')) === '/cdn-cgi/access/logout', 'Sign out goes to Access');
  ok(await page.$eval('.side-brand a[target=_blank]', (a) => a.getAttribute('href')) === '/', 'View site beside the logo');
  await page.screenshot({ path: join(OUT, 'desktop.png') });

  console.log('Addresses');
  await clickNav(page, 'Kids'); await pause(400);
  ok(hashOf(page) === '#kids' && await active(page) === 'Kids', 'Kids: #kids');
  await clickText(page, '.hub-tab', 'Community Projects'); await pause(300);
  ok(hashOf(page) === '#kids/community', 'its Community Projects tab: #kids/community');
  await clickNav(page, 'People'); await pause(400);
  await clickText(page, '.hub-tab', 'Board'); await pause(300);
  ok(hashOf(page) === '#people/board', 'People → Board: #people/board');
  await page.goBack(); await pause(400);
  ok(hashOf(page) === '#kids/community' && await activeTab(page) === 'Community Projects', 'Back: Kids, still on Community Projects');
  await page.goForward(); await pause(400);
  ok(await active(page) === 'People' && await activeTab(page) === 'Board', 'Forward: People → Board');
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('.side-nav .nav-item'); await pause(400);
  ok(await active(page) === 'People' && await activeTab(page) === 'Board', 'reload keeps People → Board');

  await clickNav(page, 'Events'); await pause(500);
  await page.evaluate(() => [...document.querySelectorAll('.ev-row')].find((r) => r.textContent.includes('Test Picnic'))?.click()); await pause(600);
  ok(hashOf(page) === '#events/test-picnic', 'opening an event: #events/test-picnic');
  await page.goBack(); await pause(500);
  ok(hashOf(page) === '#events' && !!(await page.$('.ev-row')), 'Back closes it, back on the list');
  await page.goForward(); await pause(600);
  ok(hashOf(page) === '#events/test-picnic' && !(await page.$('.ev-row')), 'Forward opens it again');
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('.side-nav .nav-item'); await pause(800);
  ok(await active(page) === 'Events' && !(await page.$('.ev-row')) && await page.evaluate(() => [...document.querySelectorAll('.main input')].some((i) => i.value === 'Test Picnic')), 'reload keeps the event open');

  const before = (await browser.pages()).length;
  await page.keyboard.down(MOD); await page.click('.side-nav a[href="#press"]'); await page.keyboard.up(MOD); await pause(800);
  ok(await active(page) === 'Events' && (await browser.pages()).length === before + 1, '⌘-click opens Press in a new tab and leaves this one');
  for (const p of (await browser.pages()).slice(before)) await p.close();
  ok(page.errors.length === 0, `no errors (${page.errors.slice(0, 2).join(' | ')})`);
  await page.close();

  for (const [hash, want, extra] of [['#broadcast/invites', 'Reveals'], ['#broadcast/demo', 'Demo Day'], ['#demo-day', 'Demo Day'], ['#advisory-applications', 'People', 'Applications'],
    ['#people/advisory', 'People', 'Advisory'], ['#kids/community', 'Kids', 'Community Projects'], ['#partners/community-partners', 'Partners', 'Community partners'],
    ['#site/newsletter', 'Site Config'], ['#publish-history', 'Publish history'], ['#deploys', 'Publish history'], ['#audit-log', 'Audit log'], ['#press/found', 'Press'], ['#nonsense', 'Dashboard']]) {
    const p = await open(1440, 900, hash);
    ok(await active(p) === want && (!extra || await activeTab(p) === extra), `${hash} opens ${want}${extra ? ` → ${extra}` : ''}`);
    if (p.errors.length) ok(false, `  errors on ${hash}: ${p.errors.slice(0, 2).join(' | ')}`);
    await p.close();
  }

  console.log('⌘K');
  page = await open(1440, 900);
  await page.keyboard.down(MOD); await page.keyboard.press('k'); await page.keyboard.up(MOD); await pause(300);
  const first = await page.$$eval('.cmd-palette-item', (b) => b.slice(0, 5).map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(/^Dashboard/.test(first[0]) && /^Applications/.test(first[1]) && /^Kids/.test(first[2]) && /^Demo Day/.test(first[3]) && /^Reveals/.test(first[4]), '⌘K lists the areas in the sidebar order');
  await page.type('.cmd-palette-input', 'outlets'); await pause(200);
  ok(/^Outlets/.test(await page.$eval('.cmd-palette-item', (b) => b.textContent.trim())), 'a name match beats a hint match (Outlets before Press)');
  await page.click('.cmd-palette-input', { clickCount: 3 }); await page.type('.cmd-palette-input', 'github'); await pause(200);
  ok(await page.$$eval('.cmd-palette-item', (b) => b.some((x) => /GitHub repository/.test(x.textContent))), 'GitHub is in ⌘K');
  await page.click('.cmd-palette-input', { clickCount: 3 }); await page.type('.cmd-palette-input', 'reveal invites'); await pause(200);
  await page.keyboard.press('Enter'); await pause(600);
  ok(await active(page) === 'Reveals' && hashOf(page) === '#broadcast/invites', '⌘K → Reveal invites lands on #broadcast/invites');
  await page.close();

  console.log('Loading on hover');
  page = await open(1440, 900);
  const asked = () => page.reqs.filter((r) => r === '/admin/site-config.js').length;
  ok(asked() === 0, 'Site Config’s code isn’t loaded up front');
  const loads = page.waitForRequest((r) => r.url().endsWith('/admin/site-config.js'), { timeout: 5000 }).then(() => true, () => false);
  await page.hover('.side-nav a[href="#site"]');
  ok(await loads, 'hovering Site Config starts loading it');
  await pause(300);
  // The area's own markup on the very next frame, not the loading wrapper (its data may still load inside)
  const shownAt = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(!!document.querySelector('.main .sc-root'))))));
  await clickNav(page, 'Site Config');
  ok(await shownAt(), 'and it opens on the next frame, no loading spinner');
  await clickNav(page, 'Kids'); await pause(200); await clickNav(page, 'Site Config');
  ok(await shownAt(), 'coming back to it is instant too');
  await page.close();

  console.log('13" laptop and shorter screens');
  page = await open(1440, 790);
  ok(await page.$eval('.side-nav', (n) => n.scrollHeight <= n.clientHeight + 1), `the whole menu fits at 1440×790 with Publish showing (${await page.$eval('.side-nav', (n) => `${n.scrollHeight}/${n.clientHeight}`)})`);
  ok(await page.$eval('.sidebar', (s) => !s.hasAttribute('data-more') && !s.hasAttribute('data-over')), 'no edge shadows when it all fits');
  await page.close();
  page = await open(1280, 680);
  ok(await page.$eval('.sidebar', (s) => s.hasAttribute('data-more') && !s.hasAttribute('data-over')), 'short screen: a shadow over the foot says there is more');
  await page.$eval('.side-nav', (n) => { n.scrollTop = n.scrollHeight; }); await pause(200);
  ok(await page.$eval('.sidebar', (s) => s.hasAttribute('data-over') && !s.hasAttribute('data-more')), 'scrolled to the end: the shadow moves under the head');
  await page.close();

  console.log('Icon rail');
  page = await open(1440, 900);
  await page.click('.side-brand button.side-icon-btn'); await pause(400);
  ok(await page.$eval('.app', (a) => a.classList.contains('is-rail')), 'the panel button makes the rail');
  ok(await page.$eval('.sidebar', (s) => Math.round(s.getBoundingClientRect().width)) === 64 && await page.$eval('.main', (m) => getComputedStyle(m).marginLeft) === '64px', 'rail is 64px and the page moves over');
  const box = await (await page.$('.side-nav a[href="#press"]')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pause(250);
  ok(await page.$eval('.nav-tip', (t) => t.textContent).catch(() => null) === 'Press3 found articles need a look', 'hovering an icon shows its name and note');
  await page.screenshot({ path: join(OUT, 'rail.png') });
  await page.mouse.move(800, 400); await pause(200);
  ok(!(await page.$('.nav-tip')), 'the label goes when the pointer leaves');
  await page.focus('.side-nav a[href="#kids"]'); await pause(150);
  ok(await page.$eval('.nav-tip', (t) => t.textContent).catch(() => null) === 'Kids', 'keyboard focus shows the label too');
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('.side-nav .nav-item'); await pause(300);
  ok(await page.$eval('.app', (a) => a.classList.contains('is-rail')), 'the rail is remembered after reload');
  await page.mouse.click(800, 400);
  await page.keyboard.press('['); await pause(400);
  ok(!(await page.$eval('.app', (a) => a.classList.contains('is-rail'))), '[ expands it');
  await page.keyboard.press('['); await pause(300);
  ok(await page.$eval('.app', (a) => a.classList.contains('is-rail')), '[ collapses it');
  await page.click('.side-expand'); await pause(300);
  ok(!(await page.$eval('.app', (a) => a.classList.contains('is-rail'))), 'the logo button expands it');
  ok(page.errors.length === 0, `no errors (${page.errors.slice(0, 2).join(' | ')})`);
  await page.close();

  console.log('Laptop widths: nothing sideways');
  for (const rail of [false, true]) for (const w of [1025, 1100, 1180, 1280]) {
    const p = await open(w, 800, '', { rail });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 0, `${w}px ${rail ? 'rail' : 'expanded'}: no sideways scroll (${over})`);
    await p.close();
  }

  console.log('Phone 390×844');
  page = await open(390, 844);
  ok(await page.$eval('.sidebar', (s) => getComputedStyle(s).visibility) === 'hidden', 'the closed drawer is out of the tab order');
  ok(!!(await page.$('.mobile-bar-link[href="/"]')), 'View site in the top bar');
  await page.click('.hamburger'); await pause(450);
  ok(await page.evaluate(() => document.activeElement?.matches('.nav-item.active')), 'opening puts focus on the current area');
  ok(await page.$eval('.main', (m) => m.inert === true), 'the page behind is inert');
  await page.screenshot({ path: join(OUT, 'phone-drawer.png') });
  ok(await page.$$eval('.sidebar .nav-item', (as) => as.every((a) => a.getBoundingClientRect().height >= 44)), 'drawer items are 44px tall');
  await page.keyboard.press('Escape'); await pause(400);
  ok(await page.evaluate(() => !document.querySelector('.sidebar.open') && document.activeElement?.classList.contains('hamburger')), 'Escape closes it, focus back on the menu button');
  await page.click('.hamburger'); await pause(400);
  await clickNav(page, 'Partners'); await pause(500);
  ok(await active(page) === 'Partners' && !(await page.$('.sidebar.open')) && hashOf(page) === '#partners', 'picking an area closes the drawer');
  ok(page.errors.length === 0, `no errors (${page.errors.slice(0, 2).join(' | ')})`);
  await page.close();

  console.log('A family replied');
  const reply = (id, name, by, mins, snippet, thread) => ({ id, name, status: 'In Review', at: new Date(Date.now() - mins * 60000).toISOString(), by, snippet, thread });
  state.replies = [reply('acct00000001', 'Avery Stone', 'Jordan Stone', 5, 'Tuesday works for us!', 'cm-visit')];
  page = await open(1440, 900);
  const appCount = await page.$eval('.side-nav a[href="#applications"]', (a) => ({ n: a.querySelector('.nav-count')?.textContent, text: a.textContent }));
  ok(appCount.n === '1' && /1 family replied and is waiting for an answer · 4 new applications/.test(appCount.text), `Applications counts the family waiting on a reply, and says so (${appCount.n}: ${appCount.text.replace(/\s+/g, ' ').trim()})`);
  ok(/^\(1\) /.test(await page.title()), `the tab’s title counts it (${await page.title()})`);
  const notice = await page.$eval('.reply-notice', (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  ok(/Jordan Stone replied/.test(notice) && /5 min ago/.test(notice) && /About Avery Stone · In Review/.test(notice) && /Tuesday works for us!/.test(notice), `a notice on any page, with who, when and what (${notice})`);
  ok(/Jordan Stone replied and is waiting for an answer/.test(await page.evaluate(() => document.querySelector('.main')?.textContent || '')), 'the Dashboard lists it first in what needs doing');
  await page.screenshot({ path: join(OUT, 'reply-notice.png') });
  await clickText(page, '.reply-notice button', 'Later'); await pause(300);
  ok(!(await page.$('.reply-notice')), 'Later puts it away');
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('.side-nav .nav-item'); await pause(500);
  ok(!(await page.$('.reply-notice')) && await page.$eval('.side-nav a[href="#applications"] .nav-count', (c) => c.textContent).catch(() => '') === '1', 'and it stays away after a reload, while the count stays until someone answers');
  // Another family writes while the admin is open: a notice pops without a reload
  state.replies = [reply('acct00000002', 'Mateo García', 'Lucía García', 0, '¿Podemos cambiar la cita?', 'cm-cita'), ...state.replies];
  await page.evaluate(() => window.dispatchEvent(new Event('soard-replies-changed'))); await pause(600);
  ok(/Lucía García replied/.test(await page.$eval('.reply-notice', (el) => el.textContent).catch(() => '')) && await page.$eval('.side-nav a[href="#applications"] .nav-count', (c) => c.textContent).catch(() => '') === '2', 'a new reply pops up while the admin is open, and the count goes up');
  await clickText(page, '.reply-notice button', 'Reply'); await pause(500);
  ok(hashOf(page) === '#applications/applicants/acct00000002/reply/cm-cita' && await active(page) === 'Applications', `Reply opens that family, answering in their conversation (${hashOf(page)})`);
  ok(!(await page.$('.reply-notice')), 'and the notice goes');
  await page.close();
  state.replies = null;

  console.log('Avatar fallbacks');
  state.photoGone = true;
  page = await open(1440, 900);
  ok(await page.$eval('.side-avatar img', (i) => i.hidden).catch(() => false) && await page.$eval('.side-avatar', (a) => a.innerText.trim()) === 'L', 'a photo that can’t load leaves the initials');
  await page.close();
  Object.assign(state, { photoGone: false, email: 'casey@soardcharity.com' });
  page = await open(1440, 900);
  ok(!(await page.$('.side-avatar img')) && await page.$eval('.side-me-text strong', (s) => s.textContent) === 'Casey', 'a first name only a board member has is no match: initials, as before');
  await page.close();
  state.email = 'casey.bradley@soardcharity.com';
  page = await open(1440, 900);
  ok((await page.$eval('.side-avatar img', (i) => i.getAttribute('src')).catch(() => '')).includes('/team/casey-bradley/') && await page.$eval('.side-me-text strong', (s) => s.textContent) === 'Casey Bradley', 'a first.last@ address matches anyone on People');
  ok(page.errors.length === 0, `no errors (${page.errors.slice(0, 2).join(' | ')})`);
  await page.close();
  state.email = 'linzi@soardcharity.com';

  console.log('Quiet states');
  Object.assign(state, { live: false, waiting: 0, me: false, applied: 0 });
  page = await open(1440, 900);
  ok(!(await page.$('.nav-live')) && !(await page.$('.sidebar-deploy')) && !(await page.$('.side-me')) && !(await page.$('.side-nav a[href="#applications"] .nav-count')), 'no LIVE, no Applications count, no Publish, no account row when there are none');
  ok(await page.$eval('.side-foot', (f) => getComputedStyle(f).display) === 'none', 'the empty foot takes no room');
  ok(page.errors.length === 0, `no errors (${page.errors.slice(0, 2).join(' | ')})`);
  await page.close();
} finally { await browser.close(); server.close(); }
console.log(fails.length ? `${fails.length} failed` : 'All passed');
process.exit(fails.length ? 1 : 0);
