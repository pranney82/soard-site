/**
 * test-score-scans.mjs — scanned scoresheets in Admin → Applicants → Scores, in a browser
 * ===============================================================================
 * Serves public/ and loads the Applicants module (as scripts/test-applicants-admin.mjs
 * does), with the REAL /api/applicants-admin and /api/score-scans-admin handlers
 * running here in Node against an in-memory D1 and fake JobTread. Workers AI is a
 * fake that reads each page's typed text (so the browser's own PDF drawing and
 * text are what it gets), with the second reader misreading one score on purpose.
 *
 * Checks, at 1440px and 390px:
 *   - a typed PDF (one scorer, a row per family) is read page by page with progress;
 *     what both readers agree on saves as Linzi's cards, and the board ranks them
 *   - the sheet they disagree on waits under Check these: the page beside the
 *     scores, why it waits, the unsure row marked; 1 to 5 and Enter save it
 *   - readiness read before a family's home visit is held back
 *   - the same file again asks first; a photo with nothing on it is "no scores"
 *   - what's been added: Take off one sheet, Undo the whole upload
 *   - the family's Score tab: where a card came from, and Add a scanned sheet
 *   - Print scoresheets: one page per family and a blank one
 *   - phone: everything fits, Take photos shows; axe on the view and the dialog
 *
 *   node scripts/test-score-scans.mjs
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from '../tests/lib/fake-applicant-world.mjs';
import * as api from '../functions/api/applicants-admin.js';
import * as scansApi from '../functions/api/score-scans-admin.js';
import { FIELDS } from '../functions/api/_applicants.js';
import { scorecardsFor } from '../functions/api/_applicant-scores.js';
import { criteriaOf } from '../public/admin/scoring-shared.js';
import { axeScan, axeText } from './lib/axe.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/score-scans/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── JobTread (fake): the 2027 season ──
const w = fakeApplicantWorld();
globalThis.fetch = w.fetchImpl;
const F = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.id]));
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
let n = 0;
function family(name, status) {
  const id = `acct${String(++n).padStart(8, '0')}`;
  w.world.accounts[id] = {
    id, name, type: 'customer', org: ORG, createdAt: day(20 + n),
    fields: { [F.status]: status, [F.year]: '2027', [F.types]: ['Bedroom'] },
    contacts: [{ id: `${id}-c1`, name: `Parent ${n}`, title: 'Mom', fields: {} }], primaryContactId: `${id}-c1`,
    locations: [], files: [], comments: [], jobs: status === 'Approved' ? [{ id: `${id}-job`, name: `${name} (2027)` }] : [],
  };
  return id;
}
const ids = {
  owen: family('Owen Lindgren', 'Approved'), eliza: family('Eliza Franklin', 'Approved'),
  harper: family('Harper Lee', 'Applied'), noah: family('Noah Pence', 'In Review'), evan: family('Evan Burkett', 'Denied'),
  isla: family('Isla Moreau', 'Applied'), miaJ: family('Mia Johnson', 'Applied'), miaT: family('Mia Torres', 'Applied'),
};

// ── D1 ──
const DB = await createD1();
await DB.exec(`CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
await DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application: { open: true, year: '2027' } })).run();
await DB.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)`);
await DB.exec('CREATE TABLE IF NOT EXISTS staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
await DB.prepare('INSERT INTO staff_state (key, data, updated_at) VALUES (?, ?, ?)').bind('directory', JSON.stringify({ accounts: [
  { email: 'linzi@soardcharity.com', name: 'Linzi Lawsky', active: true },
  { email: 'cnielsen@soardcharity.com', name: 'Christian Nielsen', active: true },
  { email: 'ccunningham@soardcharity.com', name: 'Clareece Cunningham', active: true },
] }), day(1)).run();

// ── Workers AI (fake): reads a page's typed text ──
// A row: "Owen Lindgren | 5 4 4 5 5 4 3 4 5 4 | 43". The second reader takes Harper's Financial need for a 3.
const KEYS = criteriaOf(2).map((c) => c.key);
const LABELS = criteriaOf(2).map((c) => c.short);
let aiCalls = 0;
const fakeAI = {
  async run(model, input) {
    aiCalls++;
    const text = input.messages?.[1]?.content?.find?.((p) => p.type === 'text')?.text || '';
    const scorer = (text.match(/Evaluator:\s*([A-Za-z .]+?)(?:\s{2,}|\n|$)/) || [])[1] || '';
    const sheets = [];
    for (const m of text.matchAll(/([A-Z][A-Za-z .'-]+?)\s*\|\s*((?:[1-5]\s+){9}[1-5])\s*\|\s*(\d+)/g)) {
      const vals = m[2].trim().split(/\s+/).map(Number);
      if (/qwen/.test(model) && /Harper|Isla/.test(m[1])) vals[9] = vals[9] === 3 ? 4 : 3;
      sheets.push({ family: m[1].trim(), scorer, code: '', total: Number(m[3]), notes: '', scores: Object.fromEntries(KEYS.map((k, i) => [k, vals[i]])) });
    }
    return { response: { labels: sheets.length ? LABELS : [], sheets } };
  },
};
const store = new Map();
const VENDOR_FILES = { delete: async (keys) => { for (const k of [].concat(keys)) store.delete(k); }, put: async (k, v) => { store.set(k, v); }, get: async (k) => (store.has(k) ? { body: store.get(k), arrayBuffer: async () => store.get(k).slice().buffer, httpMetadata: { contentType: 'image/jpeg' } } : null) };
const env = { ...w.env, DB, AI: fakeAI, VENDOR_FILES, JOBTREAD_QC_GRANT_KEY: 'qc-grant' };

// ── Test files: a scoring sheet's tab printed to PDF, and a blank photo ──
const ROWS = [
  ['Owen Lindgren', [5, 4, 4, 5, 5, 4, 3, 4, 5, 4]],
  ['Eliza Franklin', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]],
  ['Harper Lee', [3, 3, 3, 3, 3, 3, 3, 3, 3, 4]],
  ['Noah Pence', [2, 3, 4, 5, 1, 2, 3, 4, 5, 3]],
];
const sum = (a) => a.reduce((x, y) => x + y, 0);
const christianHtml = `<!doctype html><html><body style="font:14px Helvetica;margin:40px">
  <h2>2027 Makeover Scoring</h2><p>Evaluator: Christian Nielsen</p>
  <p>Criteria: ${LABELS.join(', ')}</p>
  <p>Isla Moreau | 2 2 2 2 2 2 2 2 2 2 | 20</p>
  <p>Mia | 4 4 4 4 4 4 4 4 4 4 | 40</p>
</body></html>`;
const sheetHtml = `<!doctype html><html><body style="font:14px Helvetica;margin:40px">
  <h2>2027 Makeover Scoring</h2><p>Evaluator: Linzi Lawsky</p>
  <p>Criteria: ${LABELS.join(', ')}</p>
  ${ROWS.map(([f, v]) => `<p>${f} | ${v.join(' ')} | ${sum(v)}</p>`).join('')}
</body></html>`;

// ── Static server ──
const adminHtml = readFileSync(join(ROOT, 'public/admin/index.html'), 'utf8');
const adminStyles = [...adminHtml.slice(0, adminHtml.indexOf('<script')).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const harness = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scoresheets harness</title><style>${adminStyles}</style>
<style>body{margin:0;background:var(--color-bg);font-family:Inter,system-ui,sans-serif;color:var(--color-text)} .harness{padding:24px;max-width:1500px;margin:0 auto} @media (max-width:640px){.harness{padding:12px}}</style></head>
<body><main class="harness"><div id="root"></div></main>
<div id="toasts" style="position:fixed;bottom:16px;right:16px;z-index:1000;display:grid;gap:6px;pointer-events:none"></div>
<script type="module">
import { h, render } from './vendor.js';
import { ApplicantsArea } from './applicants.js';
window.__toasts = [];
window.print = () => { window.__printed = document.querySelectorAll('#ssp-print .ssp-page').length; window.__printHtml = document.getElementById('ssp-print')?.innerHTML || ''; };
const addToast = (msg, kind) => { window.__toasts.push({ msg, kind }); const t = document.createElement('div'); t.textContent = msg; t.style.cssText = 'background:#1A1B1F;color:#fff;padding:10px 14px;border-radius:10px;font-size:14px'; document.getElementById('toasts').appendChild(t); setTimeout(() => t.remove(), 2500); };
render(h(ApplicantsArea, { addToast }), document.getElementById('root'));
</script></body></html>`;
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.pfb': 'application/octet-stream' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/admin/__scans.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  const file = join(ROOT, 'public', path);
  if (file.startsWith(join(ROOT, 'public')) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

const handlers = { '/api/applicants-admin': api, '/api/score-scans-admin': scansApi };
async function answer(req) {
  const url = new URL(req.url());
  const mod = handlers[url.pathname];
  if (!mod) return false;
  const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
  const ctx = { env, request, data: { userEmail: 'linzi@soardcharity.com' }, waitUntil: () => {} };
  const res = req.method() === 'POST' ? await mod.onRequestPost(ctx) : await mod.onRequestGet(ctx);
  return req.respond({ status: res.status, contentType: res.headers.get('content-type') || 'application/json', body: Buffer.from(await res.arrayBuffer()) });
}

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const consoleErrors = [];
async function open(width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    try { if (await answer(req) === false) req.continue(); } catch (e) {
      console.error('handler error', e);
      req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: e.message }) });
    }
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(`${SITE}/admin/__scans.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.apl-views', { timeout: 30000 });
  await page.click('.apl-views [data-view="scores"]');
  await page.waitForSelector('.ssc', { timeout: 15000 });
  return page;
}
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const clickText = (page, sel, re) => page.evaluate((s, src) => { const el = [...document.querySelectorAll(s)].find((x) => new RegExp(src).test(x.textContent)); if (el) { el.click(); return true; } return false; }, sel, re.source);
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
const upload = async (page, file) => {
  const input = await page.$('.ssc-add input[type=file]:not([capture])');
  await input.uploadFile(file);
};

// The test PDF, printed by Chrome itself
const pdfPage = await browser.newPage();
await pdfPage.setContent(sheetHtml);
const PDF = join(OUT, 'linzi-scores.pdf');
writeFileSync(PDF, await pdfPage.pdf({ format: 'letter' }));
await pdfPage.setContent(christianHtml);
const PDF2 = join(OUT, 'christian-scores.pdf');
writeFileSync(PDF2, await pdfPage.pdf({ format: 'letter' }));
await pdfPage.setViewport({ width: 400, height: 300 });
await pdfPage.setContent('<body style="margin:0;background:#fff"></body>');
const PHOTO = join(OUT, 'blank-photo.jpg');
writeFileSync(PHOTO, await pdfPage.screenshot({ type: 'jpeg' }));
await pdfPage.setContent('<body style="margin:0;background:#f4f4f4"></body>');
const PHOTO2 = join(OUT, 'another-photo.jpg');
writeFileSync(PHOTO2, await pdfPage.screenshot({ type: 'jpeg' }));
await pdfPage.close();

console.log('Desktop 1440');
const page = await open(1440, 1000);
ok(/Scoresheets/.test(await text(page, '.ssc-head')), 'the Scores view has Scoresheets with Add scoresheets');
ok(!(await page.$('.ssc-add .btn-ghost')), 'no Take photos on a laptop');
await shot(page, 'desktop-scores-before');

// A typed PDF
await upload(page, PDF);
await page.waitForSelector('.ssc-run.is-done, .ssc-run.is-failed', { timeout: 60000 });
const run = await text(page, '.ssc-run');
ok(/Read all 1 page/.test(run), `the upload reads its page (${run})`);
ok(/3 saved/.test(run) && /1 to check/.test(run), `three sheets save, one waits (${run})`);
ok(aiCalls === 2, `both readers read the page once each (${aiCalls})`);
const owenCards = await scorecardsFor(DB, ids.owen);
ok(owenCards.length === 1 && owenCards[0].evaluator === 'linzi@soardcharity.com' && owenCards[0].source === 'scan' && owenCards[0].total === 43, 'Owen’s card is Linzi’s, read from the scan, 43');
const noah = (await scorecardsFor(DB, ids.noah))[0];
ok(noah && noah.scores.readiness === undefined && !noah.complete, 'Noah hasn’t had his home visit: readiness held back, his card waits for it');
ok([...store.keys()].some((k) => k.startsWith('scoresheets/2027/')), 'the page picture went to private storage');
await page.waitForFunction(() => document.querySelectorAll('.apl-rank tbody tr').length === 2, { timeout: 10000 }).catch(() => {});
ok(await page.$$eval('.apl-rank tbody tr', (r) => r.length) === 2, 'Owen and Eliza are ranked at once (Linzi is the season’s only scorer so far)');
ok(/1 sheet to check/.test(await text(page, '.ssc-waiting')), `one sheet to check (${await text(page, '.ssc-waiting')})`);
ok(/two readings differ/i.test(await text(page, '.ssc-waiting')), 'and why, in a word');
await shot(page, 'desktop-scores-after');

// Check these
await page.click('.ssc-waiting .btn');
await page.waitForSelector('.ssc-check', { timeout: 5000 });
await page.waitForFunction(() => document.querySelector('.ssc-page img')?.complete, { timeout: 5000 }).catch(() => {});
const why = await text(page, '.ssc-why');
ok(/differ on Financial need \(4 or 3\)/.test(why), `why it waits (${why})`);
ok(await page.$eval('.ssc-check select', (s) => s.selectedOptions[0]?.textContent) === 'Harper Lee', 'the family is filled in');
ok(/Linzi/.test(await page.$$eval('.ssc-check select', (s) => s[1].selectedOptions[0]?.textContent)), 'and who scored it');
ok(await page.$$eval('.ssc-row.is-flag', (r) => r.length) === 1, 'the one unsure row is marked');
ok(await page.$eval('.ssc-row.is-row .ssc-row-name b', (b) => b.textContent) === 'Financial need', 'and has the focus');
await sleep(500); // the dialog's fade-in
await shot(page, 'desktop-check');
const axeDialog = await axeScan(page, '.ssc-check');
ok(!axeDialog.length, `axe: the check dialog ${axeText(axeDialog)}`);
await page.keyboard.press('4');
ok(await page.$eval('.ssc-row:last-child .is-on', (b) => b.textContent).catch(() => '') === '4', '4 scores the marked row');
await page.keyboard.press('Enter');
await page.waitForFunction(() => !document.querySelector('.ssc-check'), { timeout: 5000 }).catch(() => {});
if (process.env.DEBUG) console.log('DEBUG', JSON.stringify(await page.evaluate(() => ({ toasts: window.__toasts, active: document.activeElement?.outerHTML?.slice(0, 120), dialog: !!document.querySelector('.ssc-check') }))));
ok(!(await page.$('.ssc-check')), 'Enter saves it; nothing else to check, so it closes');
const harper = (await scorecardsFor(DB, ids.harper))[0];
ok(harper?.scores.financial === 4 && harper.scores.readiness === undefined, 'Harper’s card has the 4, and readiness waits for her visit');
ok(await page.waitForFunction(() => !document.querySelector('.ssc-waiting'), { timeout: 5000 }).then(() => true).catch(() => false), 'nothing waits now');

// The same file again
await upload(page, PDF);
await page.waitForSelector('.ask-overlay', { timeout: 10000 });
ok(/Read it again\?/.test(await text(page, '.ask-overlay h2')), 'the same file again asks first');
await page.click('[data-ask="no"]');
await sleep(300);
ok(aiCalls === 2, 'and Cancel reads nothing');

// A photo with no scoresheet on it
await upload(page, PHOTO);
await page.waitForFunction(() => [...document.querySelectorAll('.ssc-run')].some((r) => /blank-photo/.test(r.textContent) && /is-done|is-failed/.test(r.className)), { timeout: 30000 });
ok(/1 page with no scores/.test(await page.evaluate(() => [...document.querySelectorAll('.ssc-run')].find((r) => /blank-photo/.test(r.textContent)).textContent)), 'a photo with nothing on it: no scores, nothing saved');

// What's been added: take one off, then undo the upload
await clickText(page, '.ssc-history .apl-more', /what’s been added/);
await page.waitForSelector('.ssc-uploads', { timeout: 5000 });
ok(await page.$$eval('.ssc-uploads > li', (l) => l.length) === 2, 'both uploads are listed');
await clickText(page, '.ssc-uploads .apl-more', /See what it saved/);
await page.waitForSelector('.ssc-saved li', { timeout: 5000 });
ok(await page.$$eval('.ssc-saved li', (l) => l.length) === 4, 'the PDF saved four sheets (three on its own, one checked)');
await clickText(page, '.ssc-saved li .apl-more', /Take off/);
await page.waitForSelector('.ssc-waiting', { timeout: 5000 });
ok(/1 sheet to check/.test(await text(page, '.ssc-waiting')), 'a sheet taken off waits again');
await page.evaluate(() => [...document.querySelectorAll('.ssc-uploads > li')].find((li) => /linzi-scores\.pdf/.test(li.textContent)).querySelector('.ssc-upload-top .apl-more:last-child').click());
await page.waitForSelector('.ask-overlay', { timeout: 5000 });
ok(/Undo linzi-scores\.pdf\?/.test(await text(page, '.ask-overlay h2')), 'Undo asks first');
await page.click('[data-ask="yes"]');
await page.waitForFunction(() => /undone/.test(document.querySelector('.ssc-uploads')?.textContent || ''), { timeout: 5000 }).catch(() => {});
ok(!(await scorecardsFor(DB, ids.owen)).length && !(await scorecardsFor(DB, ids.eliza)).length, 'Undo takes its cards off');
ok(await page.waitForFunction(() => !document.querySelectorAll('.apl-rank tbody tr').length, { timeout: 5000 }).then(() => true).catch(() => false), 'and the ranking with them');
ok(!(await page.$('.ssc-waiting')), 'an undone upload has nothing to check');

// Read it again, so the family tab has a scanned card
const callsBefore = aiCalls;
await upload(page, PDF);
await page.waitForFunction(() => document.querySelectorAll('.apl-rank tbody tr').length === 2, { timeout: 30000 }).catch(() => {});
ok(!(await page.$('.ask-overlay')) && aiCalls === callsBefore + 2, 'an undone upload doesn’t count as the same file: it’s read at once');
ok(await page.$$eval('.apl-rank tbody tr', (r) => r.length) === 2, 'and Owen and Eliza are ranked again');

// Print scoresheets
await clickText(page, '.ssc-actions .btn', /Print scoresheets/);
await sleep(300);
const printed = await page.evaluate(() => window.__printed);
ok(printed === 8, `one page for each of the 7 families still in, and a blank one (${printed})`);
const printHtml = await page.evaluate(() => window.__printHtml);
ok(/S27-[2-9A-HJ-NP-Z]{5}/.test(printHtml) && /Owen Lindgren/.test(printHtml) && !/Evan Burkett/.test(printHtml), 'each with its code; families turned down left out');
ok(/after the home visit/.test(printHtml), 'readiness marked as after the home visit');

const axeView = await axeScan(page, '.ssc');
ok(!axeView.length, `axe: the Scoresheets panel ${axeText(axeView)}`);
const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(wide <= 0, `1440px: nothing scrolls sideways (${wide})`);

// What the break-it pass found
console.log('Break-it fixes');
await page.evaluate(() => {
  const real = window.fetch;
  let drop = true;
  window.fetch = (url, init) => { if (drop && /score-scans-admin/.test(String(url)) && /"page":/.test(init?.body || '')) { drop = false; window.__dropped = true; return Promise.reject(new TypeError('Failed to fetch')); } return real(url, init); };
});
await upload(page, PDF2);
await page.waitForFunction(() => [...document.querySelectorAll('.ssc-run')].some((r) => /christian-scores/.test(r.textContent) && /is-done|is-failed/.test(r.className)), { timeout: 60000 });
const chrisRun = await page.evaluate(() => [...document.querySelectorAll('.ssc-run')].find((r) => /christian-scores/.test(r.textContent)).textContent);
ok(await page.evaluate(() => window.__dropped) && /Read all 1 page/.test(chrisRun), `a dropped connection is tried again, and the upload finishes (${chrisRun.replace(/\s+/g, ' ')})`);
ok(/2 to check/.test(chrisRun), 'Christian’s two sheets wait (his first scores; Isla read two ways; two Mias)');
await page.waitForSelector('.ssc-waiting .btn', { timeout: 10000 });
await page.click('.ssc-waiting .btn');
await page.waitForSelector('.ssc-check', { timeout: 5000 });
// Go to the Mia sheet
for (let k = 0; k < 4 && !/Mia/.test(await text(page, '.ssc-why')); k++) { await clickText(page, '.ssc-check .kd-dialog__foot .btn', /^Later$/); await sleep(150); }
ok(/Mia/.test(await text(page, '.ssc-why')), 'the Mia sheet says why');
ok(await page.$eval('.ssc-check select', (sel) => sel.value) === '', 'two Mias: no family is picked for you');
await page.keyboard.press('Enter');
await sleep(300);
ok(!!(await page.$('.ssc-check')) && (await scorecardsFor(DB, ids.miaJ)).length === 0, 'Enter with no family picked saves nothing');
// To Isla: the cover
const famPicked = () => page.$eval('.ssc-check select', (sel) => sel.selectedOptions[0]?.textContent || '');
for (let k = 0; k < 4 && !/Isla/.test(await famPicked()); k++) { await clickText(page, '.ssc-check .kd-dialog__foot .btn', /^Later$/); await sleep(150); }
ok(!!(await page.$('.ssc-cover')), 'Linzi hasn’t scored Isla: Christian’s scores stay covered');
await page.keyboard.press('5');
await page.keyboard.press('Enter');
await sleep(300);
ok((await scorecardsFor(DB, ids.isla)).length === 0, 'and keys under the cover change and save nothing');
await clickText(page, '.ssc-cover .btn', /Check it anyway/);
await page.waitForSelector('.ssc-row', { timeout: 3000 });
// Tab to a score and press Enter: it picks that score, it doesn't save
await page.focus('.ssc-row[data-row="1"] [tabindex="0"]');
await page.keyboard.press('ArrowRight');
await sleep(100);
const focusedN = await page.evaluate(() => document.activeElement?.dataset?.n);
await page.keyboard.press('Enter');
await sleep(200);
ok(!!(await page.$('.ssc-check')) && (await scorecardsFor(DB, ids.isla)).length === 0, `Enter on a score button presses it; it doesn’t save (${focusedN})`);
ok(await page.$eval('.ssc-row[data-row="1"] .is-on', (b) => b.dataset.n).catch(() => null) === focusedN, '→ moved Safety’s score along');
// Tab never leaves the dialog
let outside = false;
for (let k = 0; k < 40; k++) { await page.keyboard.press('Tab'); if (!(await page.evaluate(() => !!document.activeElement?.closest('.ssc-check')))) { outside = true; break; } }
ok(!outside, 'Tab stays inside the dialog');
const tabStops = await page.$$eval('.ssc-pick [tabindex="0"]', (b) => b.length);
ok(tabStops === 10, `each row of scores is one Tab stop (${tabStops})`);
// The list doesn't change under the open dialog when another upload finishes
const before = await text(page, '.ssc-check-sub');
await (await page.$('.ssc-add input[type=file]:not([capture])')).uploadFile(PHOTO2);
await page.waitForFunction(() => [...document.querySelectorAll('.ssc-run')].some((r) => /another-photo/.test(r.textContent) && /is-done/.test(r.className)), { timeout: 30000 });
await sleep(300);
ok(!(await page.$('.ask-overlay')) && await text(page, '.ssc-check-sub') === before, 'another upload finishing doesn’t change the sheet in front of you');
await page.keyboard.press('Escape');
await sleep(300);
// Print ignores the board's filters
await clickText(page, '.apl-strip button', /Approved/);
await sleep(300);
await clickText(page, '.ssc-actions .btn', /Print scoresheets/);
await sleep(300);
ok(await page.evaluate(() => window.__printed) === 8, 'Print scoresheets prints every family, whatever the board is filtered to');
// The cover over Christian's Isla scores holds with the board filtered to Approved (Isla isn't on it)
await page.$eval('.ssc-waiting .btn', (b) => b.click());
await page.waitForSelector('.ssc-check', { timeout: 5000 });
for (let k = 0; k < 4 && !/Isla/.test(await famPicked()); k++) { await clickText(page, '.ssc-check .kd-dialog__foot .btn', /^Later$/); await sleep(150); }
ok(/Isla/.test(await famPicked()) && !!(await page.$('.ssc-cover')) && !(await page.$('.ssc-page img')), 'filtered board: Christian’s Isla sheet is still covered, page and all');
await page.keyboard.press('Escape');
await sleep(300);
await clickText(page, '.apl-strip button', /^All/);
await sleep(300);

// A family's Score tab
await page.evaluate(() => { [...document.querySelectorAll('.ssc-uploads .apl-more')]; });
console.log('Score tab');
const page2 = await open(1440, 1000);
const upl = await page2.$('.ssc-add input[type=file]:not([capture])');
await upl.uploadFile(PDF);
await page2.waitForSelector('.ask-overlay, .ssc-run.is-done', { timeout: 15000 });
if (await page2.$('.ask-overlay')) await page2.click('[data-ask="yes"]');
await page2.waitForSelector('.ssc-run.is-done', { timeout: 30000 });
await page2.waitForSelector('.apl-rank tbody tr', { timeout: 10000 });
await page2.click('.apl-rank tbody tr');
await page2.waitForSelector('.apl-score', { timeout: 10000 });
await clickText(page2, '.apl-score-seg button', /Everyone/);
await sleep(300);
ok(/Read from scanned scoresheets: (yours|Linzi’s)/.test(await text(page2, '.apl-score-scanned')), `the Score tab says where the card came from (${await text(page2, '.apl-score-scanned')})`);
ok(await page2.$eval('.apl-score-scanned a', (a) => a.getAttribute('href')).then((h) => /score-scans-admin\?image=/.test(h)).catch(() => false), 'with a link to the page');
ok(/Scored on paper\?/.test(await text(page2, '.apl-score-scan')) && !!(await page2.$('.apl-score-scan .ssc-add')), 'and Add a scanned sheet for this family');
await page2.screenshot({ path: join(OUT, 'desktop-score-tab.png') });
await page2.close();

console.log('Phone 390');
const phone = await open(390, 844);
ok(!!(await phone.$('.ssc-add .btn-ghost')) && /Take photos/.test(await text(phone, '.ssc-add')), 'a phone has Take photos');
ok(await phone.$eval('.ssc-add input[capture]', (i) => i.getAttribute('capture') === 'environment' && i.accept === 'image/*'), 'which opens the camera');
const pw = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(pw <= 0, `390px: nothing scrolls sideways (${pw})`);
await phone.screenshot({ path: join(OUT, 'phone-scores.png') });
// A sheet to check on a phone
await DB.prepare("UPDATE score_scan_items SET status = 'check', problems = '[\"disagree\"]' WHERE rowid = (SELECT rowid FROM score_scan_items WHERE status = 'saved' LIMIT 1)").run();
await phone.reload({ waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.apl-views', { timeout: 20000 });
await phone.click('.apl-views [data-view="scores"]');
await phone.waitForSelector('.ssc-waiting .btn', { timeout: 10000 });
await phone.click('.ssc-waiting .btn');
await phone.waitForSelector('.ssc-check', { timeout: 5000 });
if (await phone.$('.ssc-cover')) { await clickText(phone, '.ssc-cover .btn', /Check it anyway/); await phone.waitForSelector('.ssc-pick button', { timeout: 3000 }); }
const fits = await phone.evaluate(() => { const d = document.querySelector('.ssc-check'); const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; });
ok(fits, 'the check dialog fits a phone');
const tap = await phone.$eval('.ssc-pick button', (b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); });
ok(tap >= 44, `score buttons are big enough to tap (${tap}px)`);
await sleep(500);
const bodyTop = await phone.$eval('.ssc-check .kd-dialog__body', (b) => b.scrollTop);
ok(bodyTop === 0, `the dialog opens at the top, the page first (${bodyTop})`);
await phone.waitForFunction(() => document.querySelector('.ssc-page img')?.complete, { timeout: 5000 }).catch(() => {});
if (process.env.DEBUG) console.log('IMG', JSON.stringify(await phone.$eval('.ssc-page img', (i) => ({ src: i.getAttribute('src'), nw: i.naturalWidth, complete: i.complete, w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height, fig: i.closest('figure').getBoundingClientRect().height }))));
const imgH = await phone.$eval('.ssc-page-img', (b) => b.getBoundingClientRect().height);
ok(imgH > 200, `the page shows on a phone (${Math.round(imgH)}px tall)`);
await phone.screenshot({ path: join(OUT, 'phone-check.png') });

ok(!consoleErrors.length, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED:\n - ${failures.join('\n - ')}` : '\nAll scoresheet checks passed');
process.exit(failures.length ? 1 : 0);
