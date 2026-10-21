/**
 * test-applications-admin.mjs — drive Admin → Applications in a real browser
 * ===========================================================================
 * The admin page comes from a local server (SITE, e.g. wrangler pages dev on
 * dist/); every /api/applications-admin call is answered by the REAL handler
 * (functions/api/applications-admin.js) running here in Node against an
 * in-memory D1, so saves, conflicts, problems, Put live, diffs, history,
 * the submissions list, insights and deletes are the real thing. Only the
 * outside services are stubbed: JobTread's field list, Cloudflare Images
 * uploads, and Workers AI (first missing, to check the error, then a fake).
 *
 * Covers, at 1440px and 390px, light and dark:
 *   - five tabs by job (Applicants, Insights, Form, Emails, Settings) and hash
 *     routes (#applications/<tab>, old links like messages/spanish/history,
 *     #applications/<app id>)
 *   - Form: a locked JobTread question, Put live through "What's changing",
 *     undo/redo (keys and buttons, typing coalesced), move buttons, Alt+arrows
 *     and dragging, duplicate a question and a page, the rule builder making
 *     { any: [...] }, answer rules, the JobTread picker, the image picker,
 *     problems that block Put live, the live preview contract (postMessage)
 *     and its fallback
 *   - two editors: the conflict banner, "Keep mine" and "Load their version"
 *   - Spanish: counts, filters, editing, out of date, placeholders, AI fill
 *   - Emails: one at a time from the list, its timing, English and Spanish,
 *     placeholders and the reminder emails, each beside how it reads
 *   - Form → Versions: compare with previous, restore
 *   - Applicants → Submissions: search, filters, seasons, paging, badges,
 *     a single check per delivered application, export link, deleting a
 *     family's data, the notice on the other views
 *   - Insights: tiles, funnel, where people stop, per week, links back
 *   - Applicants: ./applicants.js loads (or a friendly card)
 *   - Settings: open and close through the confirm step, the since line, the
 *     Apply page's publish state, season/closed message/outside form, open and
 *     close times (and the heartbeat opening it), the family preview, Recent
 *     changes; only `application` is written, a change saved elsewhere stops
 *     the save, ⌘S, the tab badge, one save bar for every card; the
 *     new-application email, email timing and the service area save straight
 *     to live (no Put live), a clash with another editor, Reshape on the map;
 *     the unsaved-changes guard, and Site Config no longer carrying the cards
 *   - phone: nothing wider than the screen
 * Screenshots in test-results/applications-admin/. Exits non-zero on failure.
 *
 *   SITE=http://127.0.0.1:8795 node scripts/test-applications-admin.mjs
 */
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import * as adminApi from '../functions/api/applications-admin.js';
import { getDraftForm, getLiveForm, clearFormCache, saveDraftForm, getFormRules, saveFormRules } from '../functions/api/_application-forms.js';
import { resolveForm } from '../functions/api/_application-form.js';
import { ensureSchema, runApplicationSchedule } from '../functions/api/_applications.js';
import { publicForm } from '../functions/api/apply.js';
import * as readContentApi from '../functions/api/read-content.js';
import * as saveContentApi from '../functions/api/save-content.js';
import * as waitlistApi from '../functions/api/application-waitlist-admin.js';
import { ensureWaitlistSchema } from '../functions/api/_application-waitlist.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/applications-admin/');
mkdirSync(OUT, { recursive: true });
const SITE = (process.env.SITE || 'http://127.0.0.1:8791').replace(/\/$/, '');
const PETER = 'peter@soardcharity.com';
const JEN = 'jen.alvarez@soardcharity.com';
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failures.push(`${name}: crashed: ${e.message}`); console.error(`  ✗ crashed: ${e.stack || e.message}`); }
}

// ── The server side, for real, on an in-memory D1 ──
const DB = await createD1();
await DB.exec(`CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
const settings = JSON.parse(readFileSync(join(ROOT, 'src/content/site/settings.json'), 'utf8'));
const SETTINGS_PATH = 'src/content/site/settings.json';
await DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ ...settings, application: { open: false, year: '2027', formUrl: '', closedMessage: '' } })).run();
await DB.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)`);
const env = { DB, SITE_ORIGIN: SITE };
// Three families on the applications waitlist (Settings → Waitlist)
await ensureWaitlistSchema(DB);
for (const [email, lang] of [['wl-one@example.com', 'en'], ['wl-two@example.com', 'en'], ['wl-tres@example.com', 'es']]) {
  await DB.prepare("INSERT INTO waitlist_signups (email, lang, page, created_at, updated_at, kit_id, kit_state) VALUES (?, ?, 'apply', ?, ?, 1, 'active')").bind(email, lang, new Date().toISOString(), new Date().toISOString()).run();
}
const LIVE_BUILD_AT = new Date(Date.now() - 60e3).toISOString();
const storedSettings = async () => JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'settings'").first()).data);
const writeSettings = async (o) => DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify(o)).run();

// Stand-ins for the outside services
const JT_FIELDS = [
  { fieldId: 'jtPets', name: 'Pets in the home', target: 'account', type: 'text', multiple: false },
  { fieldId: 'jtPetType', name: 'Pet Type', target: 'account', type: 'option', options: ['Dog', 'Cat'], multiple: false },
  { fieldId: 'jtMoveIn', name: 'Move-in Date', target: 'location', type: 'date', multiple: false },
];
const fakeAI = {
  async run(model, { messages }) {
    const input = JSON.parse(messages[1].content);
    // One string comes back with its placeholder lost: the server leaves it for staff
    const out = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, /:help$/.test(k) ? 'ES sin marcador' : `ES ${v}`]));
    return { response: JSON.stringify(out) };
  },
};

// ── Fixtures: submissions and the funnel ──
const DAY = 864e5;
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString();
let seq = 0;
const appId = () => { seq++; return `app-${(NOW + seq).toString(36)}-${seq.toString(16).padStart(6, '0')}`; };
const REFS = ['Children’s Healthcare of Atlanta', 'Facebook', 'A friend', 'Our therapist', 'Facebook', 'Children’s Healthcare of Atlanta', ''];
const fixtures = {};
async function seed() {
  await ensureSchema(DB);
  const draft = (o) => DB.prepare('INSERT INTO application_drafts (id, year, answers, files, created_at, updated_at, submitted_id, max_page_id, stop_key, lang, reminders_sent, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(o.id, o.year || '2027', '{}', '{}', iso(o.created), iso(o.updated), o.submitted || null, o.maxPage || null, o.stop || null, o.lang || 'en', o.reminders || 0, o.ip || 'x').run();
  const app = (o) => DB.prepare(`INSERT INTO applications (id, draft_id, year, child_name, parent_name, parent_email, makeover_types, answers, files, is_test, jt_account_id, jt_state, status, attempts,
      last_error, submitted_at, updated_at, form_version, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .bind(o.id, o.draftId || null, o.year || '2027', o.child, o.parent || 'Pat Parent', o.email || `${o.child.split(' ')[0].toLowerCase()}@example.com`, JSON.stringify(o.types || ['Dream Bedroom']),
      JSON.stringify(o.answers || {}), o.test ? 1 : 0, o.account || null, JSON.stringify(o.jt || {}), o.status || 'done', o.status === 'error' ? 3 : 1, o.lastError || null, iso(o.at), iso(o.at), o.lang || 'en').run();
  const done = { account: { id: 'a' }, location: { id: 'l' }, files: { pdf: { id: 'p' } }, intake: { welcome: 'sent', medical: 'sent' }, staffEmail: true, staffSlack: true, area: { status: 'inside', county: 'Cobb' } };
  // 2027: 20 submitted, 4 still working, 3 ended by an answer, 8 left
  for (let i = 0; i < 20; i++) {
    const created = NOW - (i * 2.6 + 1) * DAY;
    const id = appId();
    const did = `d-sub-${i}`;
    const lang = i % 5 === 0 ? 'es' : 'en';
    await draft({ id: did, created, updated: created + 3600e3, submitted: id, maxPage: 'finish', lang, reminders: i % 4 === 0 ? 1 : 0 });
    const o = { id, draftId: did, child: `Kid${i} Example`, at: created + (35 + i * 4) * 60e3, jt: done, lang, answers: { referredBy: REFS[i % REFS.length], county: 'Cobb' } };
    if (i === 0) Object.assign(o, { child: 'Avery Stone', parent: 'Jordan Stone', account: '22PAveryAcct', jt: { ...done, area: { status: 'outside', miles: 4, county: 'Cherokee' } }, answers: { ...o.answers, childName: { first: 'Avery', last: 'Stone' }, parentName: { first: 'Jordan', last: 'Stone' }, county: 'Cobb' } });
    if (i === 1) Object.assign(o, { child: 'Mila Brooks', status: 'error', lastError: 'JobTread timed out', jt: { account: { id: 'b' }, area: { status: 'inside', county: 'Cobb' }, repeat: { matches: [{ name: 'Mila Brooks', year: '2025', status: 'Denied', why: 'Same parent email', url: 'https://app.jobtread.com/customers/x' }] } } });
    if (i === 0) fixtures.avery = id;
    if (i === 1) fixtures.mila = id;
    await app(o);
  }
  for (let i = 0; i < 4; i++) await draft({ id: `d-wip-${i}`, created: NOW - 5 * DAY, updated: NOW - 2 * DAY, maxPage: 'parents' });
  for (const [i, stop] of ['outside', 'outside', 'rental'].entries()) await draft({ id: `d-stop-${i}`, created: NOW - 4 * DAY, updated: NOW - 3 * DAY, maxPage: 'service-area', stop });
  for (const [i, page] of ['basic', 'basic', 'basic', 'home', 'home', 'home', 'home', 'video'].entries()) await draft({ id: `d-gone-${i}`, created: NOW - 25 * DAY, updated: NOW - 20 * DAY, maxPage: page, lang: i === 0 ? 'es' : 'en' });
  // A test application, and last season's (for the season filter and paging)
  fixtures.test = appId();
  await draft({ id: 'd-test', created: NOW - DAY, updated: NOW - DAY, submitted: fixtures.test, ip: 'admin' });
  await app({ id: fixtures.test, draftId: 'd-test', child: 'TEST Applicant', test: true, at: NOW - DAY + 60e3, jt: done });
  for (let i = 0; i < 37; i++) await app({ id: appId(), year: '2026', child: `Past${i} Family`, at: NOW - (400 + i) * DAY, jt: done });
}
await seed();

async function answer(req, user) {
  const url = new URL(req.url());
  const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.pathname === '/api/applications-admin') {
    if (url.searchParams.get('jobtread-fields')) return json({ success: true, fields: JT_FIELDS });
    clearFormCache();
    const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: user } };
    const res = req.method() === 'POST' ? await adminApi.onRequestPost(ctx) : await adminApi.onRequestGet(ctx);
    return req.respond({ status: res.status, contentType: res.headers.get('content-type') || 'application/json', headers: { 'content-disposition': res.headers.get('content-disposition') || '' }, body: Buffer.from(await res.arrayBuffer()) });
  }
  if (url.pathname === '/api/upload-image' && req.method() === 'POST') {
    return json({ success: true, imageId: 'applications/form/test-image', imageUrl: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/applications/form/test-image/public' });
  }
  if (url.pathname === '/api/apply' && url.searchParams.has('config')) {
    // The preview frame: signed-in staff get the draft
    clearFormCache();
    const draft = url.searchParams.get('preview') === 'draft' ? await getDraftForm(DB) : null;
    const live = await getLiveForm(DB, { fresh: true });
    const form = draft ? resolveForm(draft.definition, { year: '2027', version: draft.version }) : resolveForm(live.definition, { year: '2027', version: live.version });
    return json({ ok: true, open: false, year: '2027', preview: !!draft, turnstileSiteKey: null, form: publicForm(form) });
  }
  const settingsCall = (url.pathname === '/api/read-content' && url.searchParams.get('path') === SETTINGS_PATH)
    || (url.pathname === '/api/save-content' && req.method() === 'POST' && JSON.parse(req.postData() || '{}').path === SETTINGS_PATH);
  if (settingsCall) {
    const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: user }, waitUntil: () => {} };
    const res = req.method() === 'POST' ? await saveContentApi.onRequestPost(ctx) : await readContentApi.onRequestGet(ctx);
    return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  }
  if (url.pathname === '/api/read-content') return json({ success: true, content: JSON.stringify(settings), sha: 'x' });
  if (url.pathname === '/api/list-content') return json({ success: true, items: [], count: 0, total: 0, pages: 1 });
  if (url.pathname.startsWith('/api/pending-changes')) return json({ success: true, changes: [], publish: { live: { at: LIVE_BUILD_AT }, active: null, failed: null } });
  if (url.pathname.startsWith('/api/live-ws')) return req.abort();
  if (url.pathname.startsWith('/api/applicants-admin')) return json({ success: true, applicants: [], families: [], list: [], activity: [], boundary: { live: [], draft: null } });
  if (url.pathname === '/api/application-waitlist-admin') {
    const request = new Request(`https://admin.test${url.pathname}${url.search}`, { method: req.method(), body: req.method() === 'POST' ? req.postData() : undefined, headers: { 'content-type': 'application/json' } });
    const ctx = { env, request, data: { userEmail: user } };
    const res = req.method() === 'POST' ? await waitlistApi.onRequestPost(ctx) : await waitlistApi.onRequestGet(ctx);
    return req.respond({ status: res.status, contentType: 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  }
  if (url.pathname.startsWith('/api/')) return json({ success: true, ok: true });
  return false;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const PNG_FILE = join(OUT, 'upload-sample.png');
writeFileSync(PNG_FILE, PNG);
const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });

async function open(width, height, hash, { user = PETER, previewProbe = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Content Security Policy|live-ws|dynamically imported module/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  if (previewProbe) {
    // Plays the family form's half of the preview contract: say ready, keep what arrives
    await page.evaluateOnNewDocument(() => {
      if (!location.pathname.startsWith('/apply/form')) return;
      window.__afe = [];
      window.addEventListener('message', (e) => { if (e.data?.type === 'afe-preview') window.__afe.push(e.data); });
      window.addEventListener('DOMContentLoaded', () => window.parent.postMessage({ type: 'afe-preview-ready' }, location.origin));
    });
  }
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    try {
      if (new URL(req.url()).origin === SITE && (await answer(req, user)) !== false) return;
      if (req.resourceType() === 'image' && /imagedelivery/.test(req.url())) return req.respond({ status: 200, contentType: 'image/png', body: PNG });
      if (/tile\.openstreetmap|basemaps|unpkg\.com\/leaflet/.test(req.url())) return req.abort();
      req.continue();
    } catch (e) { errors.push(`mock: ${e.message}`); req.continue().catch(() => {}); }
  });
  await page.goto(`${SITE}/admin/index.html${hash}`, { waitUntil: 'networkidle2' });
  return { page, errors };
}

const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const clickText = (page, sel, re) => page.evaluate((s, src) => {
  const r = new RegExp(src);
  const el = [...document.querySelectorAll(s)].find((x) => r.test(x.textContent));
  if (el) { el.click(); return true; }
  return false;
}, sel, re.source);
const count = (page, sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
/** Wait for the draft bar to settle on saved (the bar carries its save status) */
const waitSaved = async (page) => {
  await sleep(60);
  await page.waitForFunction(() => ['saved', 'idle'].includes(document.querySelector('.afe-bar')?.dataset.status), { timeout: 8000 }).catch(() => {});
};
const draftDef = async () => (await getDraftForm(DB))?.definition;
const fieldIn = (def, id) => def.pages.flatMap(p => p.fields).find(f => f.id === id);
// Select everything in the box (a triple click only selects one line of a textarea), then type over it
const typeInto = async (page, sel, value) => { await page.click(sel); await page.$eval(sel, (el) => el.select()); await page.keyboard.press('Backspace'); await page.type(sel, value); };
const keyCombo = async (page, mods, key) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of [...mods].reverse()) await page.keyboard.up(m); };
const blur = (page) => page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
const selected = (page) => page.$eval('.afe-row.is-sel', (e) => e.dataset.id).catch(() => null);

// Dark: the admin has no dark theme yet; this lays dark values over its tokens to prove the area only uses tokens
const DARK = `:root[data-theme="dark"]{color-scheme:dark;--color-bg:#141518;--color-bg-card:#1C1D21;--color-bg-secondary:#222327;--color-bg-hover:#2A2B30;--color-text:#ECECEF;--color-text-secondary:#B9BAC1;--color-text-muted:#9C9DA5;--color-border:#303137;--color-border-strong:#45464D;--color-primary-bg:rgba(255,213,0,.10);--color-primary-ink:#FFD500;--color-danger:#F07A7A;--color-danger-bg:rgba(240,122,122,.10);--color-success:#4CC27E;--color-info:#6AA8F0;--color-warning:#E8B44A;--shadow-xs:none;--shadow-sm:none}
:root[data-theme="dark"] body{background:var(--color-bg);color:var(--color-text)}
:root[data-theme="dark"] .badge-gray{background:#2E2F35;color:#C9CAD0}:root[data-theme="dark"] .badge-yellow{background:#3B3214;color:#F3D77A}:root[data-theme="dark"] .badge-blue{background:#1B2B44;color:#9CC3F5}:root[data-theme="dark"] .badge-green{background:#183526;color:#8FD9AE}:root[data-theme="dark"] .badge-red{background:#3D1F1F;color:#F2A7A7}`;
const setTheme = (page, dark) => page.evaluate((css, on) => {
  let s = document.getElementById('test-dark');
  if (!s) { s = document.createElement('style'); s.id = 'test-dark'; s.textContent = css; document.head.append(s); }
  document.documentElement.dataset.theme = on ? 'dark' : 'light';
}, DARK, dark);
/** A tall screenshot: grow the viewport to the content instead of fullPage */
async function shot(page, name, { maxH = 2400, width = null } = {}) {
  const vp = page.viewport();
  const h = Math.min(maxH, await page.evaluate(() => document.documentElement.scrollHeight));
  await page.setViewport({ ...vp, width: width || vp.width, height: Math.max(vp.height, h) });
  await sleep(150);
  await page.screenshot({ path: join(OUT, name) });
  await page.setViewport(vp);
}

let main;
try {
  main = await open(1440, 1000, '#applications/form');
  const { page, errors } = main;

  await section('Tabs and the form', async () => {
    await page.waitForSelector('.afe-bar', { timeout: 20000 });
    const tabs = await page.$$eval('.afe-tabs [role="tab"]', (els) => els.map(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()));
    ok(JSON.stringify(tabs) === JSON.stringify(['Applicants', 'Insights', 'Form', 'Emails', 'Settings']), `five tabs, grouped by job (${tabs.join(', ')})`);
    ok(await text(page, '.afe-head h2') === 'Form', 'each tab has the admin’s page header');
    ok(!!(await page.$('.afe-head .afe-sample-btn')), 'the Form header has See what a family receives');
    ok(JSON.stringify(await page.$$eval('.afe-subnav button', els => els.map(e => e.dataset.view))) === '["questions","spanish","versions"]', 'the Form has Questions, Spanish and Versions, at the start of its draft bar');
    ok(!/Settings/.test(await text(page, '.afe-col')) || /are in Settings/.test(await text(page, '.afe-form-foot')), 'the form outline has no settings of its own; it points to Settings');
    await page.waitForSelector('.afe-tabs [data-tab="settings"] .afe-tab-state', { timeout: 8000 }).catch(() => {});
    ok(await text(page, '.afe-tabs [data-tab="settings"] .afe-tab-state') === 'Closed', 'the Settings tab says Closed from every tab');
    ok(/Families see the built-in form/.test(await text(page, '.afe-bar')), 'starts on the built-in form, nothing pending');
    ok((await page.$$('.afe-panel[aria-label^="Page"]')).length === 9, 'nine pages, as in Jotform');
    await shot(page, '01-form-desktop.png');
  });

  await section('A locked JobTread question', async () => {
    ok(await clickText(page, '.afe-row', /Child's Gender/), "pick Child's Gender");
    await sleep(200);
    ok(/JobTread: Gender/.test(await text(page, '.afe-inspector')), 'it says what it feeds');
    ok(!(await clickText(page, '.afe-inspector button', /Delete this question/)), 'and it has no Delete');
    await typeInto(page, '.afe-inspector input[aria-label="Choice 2"]', 'Girl');
    await waitSaved(page);
    ok(/Saved as "Female"/.test(await text(page, '.afe-inspector')), 'a reworded choice keeps its saved value');
    ok(/changes that aren't live yet/.test(await text(page, '.afe-bar')), 'the change is a draft');
    ok(/Female/.test(JSON.stringify(await draftDef())), 'stored with value Female, label Girl');
  });

  await section("Put live shows what's changing", async () => {
    ok(await clickText(page, '.afe-bar button', /^Put live$/), 'Put live');
    await page.waitForSelector('.afe-dialog .afe-diff', { timeout: 8000 });
    const dlg = await text(page, '.afe-dialog');
    ok(/What's changing/.test(dlg) && /CHOICES|Choices/.test(dlg) && /Girl/.test(dlg), 'the dialog lists the reworded choice under Choices');
    ok(await page.$eval('.afe-overlay', (e) => getComputedStyle(e).zIndex === '1200'), 'the dialog sits above the admin header (z-index 1200)');
    await page.screenshot({ path: join(OUT, '02-whats-changing.png') });
    ok(await clickText(page, '.afe-dialog .btn-primary', /^Put live$/), 'confirm Put live in the dialog');
    await page.waitForFunction(() => /Families see version/.test(document.querySelector('.afe-bar')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(/Families see version \d+/.test(await text(page, '.afe-bar')), 'families now see the new version');
    ok(/Girl/.test(JSON.stringify((await getLiveForm(DB, { fresh: true })).definition)), 'live in D1');
    ok(!(await page.$('.afe-dialog')), 'the dialog closed');
  });

  await section('Undo and redo', async () => {
    ok(await clickText(page, '.afe-title', /Before You Begin/), 'pick page 1');
    await sleep(150);
    await typeInto(page, '#afe-page-title', 'Before You Start');
    await waitSaved(page);
    ok((await draftDef()).pages[0].title === 'Before You Start', 'retitled');
    await blur(page);
    await keyCombo(page, ['Meta'], 'z');
    await sleep(100);
    ok(await page.$eval('#afe-page-title', (e) => e.value) === 'Before You Begin', `${'⌘Z'} outside a text box undoes the whole burst of typing in one step`);
    await waitSaved(page);
    ok((await draftDef()).pages[0].title === 'Before You Begin', 'and the undo is saved');
    await keyCombo(page, ['Meta', 'Shift'], 'z');
    await sleep(100);
    ok(await page.$eval('#afe-page-title', (e) => e.value) === 'Before You Start', '⇧⌘Z redoes it');
    ok(await clickText(page, '.afe-bar button[aria-label="Undo"]', /.*/), 'the toolbar Undo');
    await sleep(100);
    ok(await page.$eval('#afe-page-title', (e) => e.value) === 'Before You Begin', 'toolbar Undo works');
    await blur(page);
    await keyCombo(page, ['Control'], 'y');
    await sleep(100);
    ok(await page.$eval('#afe-page-title', (e) => e.value) === 'Before You Start', 'Ctrl+Y redoes');
    // In a text box the keys stay the box's own
    await page.click('#afe-page-title');
    const before = (await draftDef()).pages[0].title;
    await keyCombo(page, ['Meta'], 'z');
    await sleep(100);
    ok(await page.$eval('.afe-bar button[aria-label="Redo"]', (b) => b.disabled), 'inside a text box ⌘Z leaves the draft history alone');
    await waitSaved(page);
    ok(typeof before === 'string', 'still saving normally');
    await blur(page);
  });

  let petsId; let kindId;
  await section('New questions and the rule builder', async () => {
    await page.select('#afe-add-2', 'radio');
    await sleep(200);
    petsId = await selected(page);
    await typeInto(page, '#afe-f-label', 'Do you have pets?');
    await typeInto(page, '.afe-inspector input[aria-label="Choice 1"]', 'Yes');
    await typeInto(page, '.afe-inspector input[aria-label="Choice 2"]', 'No');
    await waitSaved(page);
    const pets = fieldIn(await draftDef(), petsId);
    ok(pets && pets.label === 'Do you have pets?' && JSON.stringify(pets.options) === '["Yes","No"]', 'new choices follow their wording until live');
    await page.select('#afe-add-2', 'text');
    await sleep(200);
    kindId = await selected(page);
    await typeInto(page, '#afe-f-label', 'What kind of pets?');
    ok(await clickText(page, '.afe-inspector button', /Add a condition/), 'add a condition');
    await sleep(150);
    ok(await page.$eval('select[aria-label="Condition 1: question"]', (s) => s.value) === petsId, 'it starts on the closest question with choices');
    ok(await clickText(page, '.afe-inspector .afe-tog', /^Yes$/), 'pick Yes');
    await waitSaved(page);
    ok(JSON.stringify(fieldIn(await draftDef(), kindId).showIf) === JSON.stringify({ field: petsId, in: ['Yes'] }), 'one condition saves as { field, in }');
    ok(/Shown when Do you have pets\? is Yes/.test(await text(page, '.afe-rule-sum')), 'with a plain-English summary');
    ok(await clickText(page, '.afe-inspector button', /Add a condition/), 'add a second condition');
    await sleep(150);
    await page.select('select[aria-label="Condition 2: question"]', 'gender');
    await sleep(100);
    ok(await page.evaluate(() => { const b = [...document.querySelectorAll('[aria-label="Condition 2: answers"] .afe-tog')].find(x => x.textContent === 'Girl'); b?.click(); return !!b; }), 'pick Girl (saved as Female)');
    await page.select('select[aria-label="Match all or any"]', 'any');
    await waitSaved(page);
    const rule = fieldIn(await draftDef(), kindId).showIf;
    ok(JSON.stringify(rule) === JSON.stringify({ any: [{ field: petsId, in: ['Yes'] }, { field: 'gender', in: ['Female'] }] }), `ANY of two saves as { any: [...] } (${JSON.stringify(rule)})`);
    ok(/is Yes, or Child's Gender is Girl/.test(await text(page, '.afe-rule-sum')), 'summary reads "…, or …"');
    await shot(page, '03-rule-builder.png', { maxH: 1400 });
  });

  await section('Renaming a choice a rule depends on keeps the rule', async () => {
    ok(await clickText(page, '.afe-row', /Do you have pets\?/), 'back to the pets question');
    await sleep(150);
    await typeInto(page, '.afe-inspector input[aria-label="Choice 1"]', 'Yes, we do');
    await waitSaved(page);
    ok(JSON.stringify(fieldIn(await draftDef(), kindId).showIf.any[0].in) === '["Yes, we do"]', 'the rule follows the renamed choice');
  });

  await section('Problems block Put live', async () => {
    await page.evaluate(() => document.querySelector('.afe-inspector button[aria-label="Remove choice 1"]')?.click());
    await waitSaved(page);
    ok(/needs at least one answer picked/.test(await text(page, '.afe-problems')), 'a rule with no answer left is listed as a problem');
    ok(await page.$eval('.afe-bar .btn-primary', (b) => b.disabled), 'and Put live is off');
    await page.screenshot({ path: join(OUT, '04-problems.png') });
    await page.evaluate(() => document.querySelector('.afe-problems button')?.click());
    await sleep(200);
    ok(/What kind of pets/.test(await page.$eval('#afe-f-label', (e) => e.value).catch(() => '')), 'the problem link opens that question');
    ok(await clickText(page, '.afe-inspector .afe-link', /^Always show$/), '"Always show" clears the rule');
    await waitSaved(page);
    ok(!(await page.$('.afe-problems')), 'fixed: no problems');
  });

  await section('Answer rules', async () => {
    await typeInto(page, '.afe-inspector input[aria-label="Shortest (characters)"]', '3');
    await typeInto(page, '.afe-inspector input[aria-label="Longest (characters)"]', '200');
    await waitSaved(page);
    ok(JSON.stringify(fieldIn(await draftDef(), kindId).rules) === '{"minLength":3,"maxLength":200}', 'length limits saved');
    ok(/Between 3 and 200 characters/.test(await text(page, '.afe-inspector')), 'and summed up');
    await typeInto(page, '.afe-inspector input[aria-label="Shortest (characters)"]', '300');
    await sleep(100);
    ok(/shortest is longer than the longest/.test(await text(page, '.afe-inspector')), 'an impossible range is called out');
    await typeInto(page, '.afe-inspector input[aria-label="Shortest (characters)"]', '3');
    await waitSaved(page);
  });

  await section('JobTread mapping', async () => {
    ok(await clickText(page, '.afe-inspector button', /Send this answer to JobTread/), 'open the picker');
    await page.waitForSelector('.afe-jt-item', { timeout: 5000 });
    const groups = await page.$$eval('.afe-jt-list h4', (els) => els.map(e => e.textContent));
    ok(groups.includes('Account') && groups.includes('Home (location)'), `grouped Account / Home (${groups.join(', ')})`);
    ok(/Doesn't fit a short answer question/.test(await text(page, '.afe-jt-list')), 'fields that do not fit say so');
    await page.type('.afe-dialog input[type="search"]', 'pets');
    await sleep(100);
    ok(await count(page, '.afe-jt-item') === 1, 'search narrows the list');
    await page.screenshot({ path: join(OUT, '05-jobtread-picker.png') });
    await page.keyboard.press('Enter');
    await waitSaved(page);
    ok(fieldIn(await draftDef(), kindId).jobtread?.fieldId === 'jtPets', 'Enter picks it; the field is stored');
    ok(/Fills "Pets in the home"/.test(await text(page, '.afe-inspector')), 'the inspector shows the mapping');
    ok(await clickText(page, '.afe-inspector button', /^Change$/), 'Change');
    await page.waitForSelector('.afe-jt-item');
    ok(await clickText(page, '.afe-jt-item', /Move-in Date/), 'pick a date field for a text question');
    await waitSaved(page);
    ok(/can't fill a date field/.test(await text(page, '.afe-inspector')), 'a type mismatch is warned');
    ok(await clickText(page, '.afe-inspector .afe-link', /Stop sending/), 'Stop sending');
    await waitSaved(page);
    ok(!fieldIn(await draftDef(), kindId).jobtread, 'the mapping is gone');
    // A choice question against a JobTread choice field
    ok(await clickText(page, '.afe-row', /Do you have pets\?/), 'the pets question');
    await sleep(150);
    ok(await clickText(page, '.afe-inspector button', /Send this answer to JobTread/), 'send it to JobTread');
    await page.waitForSelector('.afe-jt-item');
    ok(await clickText(page, '.afe-jt-item', /Pet Type/), 'pick Pet Type (Dog, Cat)');
    await waitSaved(page);
    ok(/has no "No"/.test(await text(page, '.afe-inspector')), 'choices JobTread lacks are listed');
    ok(await clickText(page, '.afe-inspector button', /Use JobTread's choices/), "Use JobTread's choices");
    await waitSaved(page);
    const pets = fieldIn(await draftDef(), petsId);
    ok(JSON.stringify(pets.options) === '["Dog","Cat"]' && pets.jobtread.type === 'option', 'the question now has Dog and Cat');
    ok(!/has no/.test(await text(page, '.afe-inspector')), 'and the warning is gone');
  });

  await section('Duplicate', async () => {
    const def0 = await draftDef();
    const n0 = def0.pages[2].fields.length;
    await page.evaluate(() => { const r = [...document.querySelectorAll('.afe-row')].find(x => /Child's Gender/.test(x.textContent)); r.querySelector('button[aria-label="Duplicate"]').click(); });
    await waitSaved(page);
    const def1 = await draftDef();
    const gi = def1.pages[2].fields.findIndex(f => f.id === 'gender');
    const copy = def1.pages[2].fields[gi + 1];
    ok(def1.pages[2].fields.length === n0 + 1 && copy.id !== 'gender' && /^q[0-9a-z]{6}$/.test(copy.id) && copy.label === "Child's Gender", `a copy right below with a fresh id (${copy?.id})`);
    ok(await selected(page) === copy.id, 'the copy is selected');
    ok(!/JobTread: Gender/.test(await text(page, '.afe-inspector')) && /Delete this question/.test(await text(page, '.afe-inspector')), 'the copy of a JobTread question is an ordinary one');
    ok(await clickText(page, '.afe-inspector button', /Delete this question/), 'delete the copy');
    await waitSaved(page);
    ok((await draftDef()).pages[2].fields.length === n0, 'gone');
    // A page
    await page.evaluate(() => document.querySelector('.afe-page[data-id="basic"] button[aria-label^="Duplicate page"]').click());
    await waitSaved(page);
    const def2 = await draftDef();
    const cp = def2.pages[3];
    const ids = def2.pages.flatMap(p => p.fields.map(f => f.id));
    ok(cp.id === 'basic-copy' && /\(copy\)$/.test(cp.title) && cp.fields.length === def2.pages[2].fields.length, `the page copy sits after it (${cp.id})`);
    ok(new Set(ids).size === ids.length, 'every id in the form is still unique');
    ok(!cp.fields.some(f => f.jobtread), 'copies never send to JobTread');
    ok(await clickText(page, '.afe-inspector button', /Delete this page/), 'delete the page copy');
    await waitSaved(page);
    ok((await draftDef()).pages.length === 9, 'back to nine pages');
  });

  await section('Moving: buttons, Alt+arrows, dragging', async () => {
    const order = async () => (await draftDef()).pages[2].fields.map(f => f.id);
    const o0 = await order();
    ok(o0.at(-1) === kindId && o0.at(-2) === petsId, 'pets questions at the end of page 3');
    await page.evaluate((id) => document.querySelector(`.afe-row[data-id="${id}"] button[aria-label="Move up"]`).click(), kindId);
    await waitSaved(page);
    ok((await order()).at(-2) === kindId, 'Move up');
    await page.focus(`.afe-row[data-id="${kindId}"] .afe-row-main`);
    await keyCombo(page, ['Alt'], 'ArrowDown');
    await waitSaved(page);
    ok((await order()).at(-1) === kindId, 'Alt+↓ moves it back');
    ok(await page.evaluate((id) => document.activeElement?.dataset.id === id, kindId), 'and keeps focus on it');
    // Drag the pets question to the top of the page
    const grip = await page.$(`.afe-row[data-id="${petsId}"] .afe-row-grip`);
    const target = await page.$('.afe-page[data-id="basic"] .afe-row');
    const g = await grip.boundingBox();
    const t = await target.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 24; i++) { await page.mouse.move(g.x + g.width / 2, g.y + (t.y + 4 - g.y) * (i / 24)); await sleep(30); }
    await sleep(120);
    await page.mouse.up();
    await waitSaved(page);
    ok((await order())[0] === petsId, `dragging the handle moves it (${(await order()).slice(0, 2).join(', ')})`);
    ok(await count(page, `.afe-row[data-id="${petsId}"]`) === 1, 'one row per question after the drop');
    // And back to the end with the keyboard
    await page.evaluate((id) => document.querySelector(`.afe-row[data-id="${id}"] button[aria-label="Move down"]`), petsId);
    const n = (await order()).length;
    await page.focus(`.afe-row[data-id="${petsId}"] .afe-row-main`);
    for (let i = 0; i < n - 2; i++) { await keyCombo(page, ['Alt'], 'ArrowDown'); await sleep(40); }
    await waitSaved(page);
    ok((await order()).at(-2) === petsId, 'Alt+↓ repeatedly walks it down');
  });

  await section('Image picker', async () => {
    await page.select('#afe-add-1', 'image');
    await sleep(200);
    const imgId = await selected(page);
    const input = await page.$('.afe-inspector input[type="file"]');
    await input.uploadFile(PNG_FILE);
    await page.waitForFunction(() => !!document.querySelector('.afe-inspector img.afe-thumb'), { timeout: 5000 }).catch(() => {});
    await waitSaved(page);
    const f = fieldIn(await draftDef(), imgId);
    ok(f.image === 'applications/form/test-image' && f.width === 1 && f.height === 1, `uploaded: id kept, size read from the file (${f.image} ${f.width}×${f.height})`);
    ok(/test-image\/w=600/.test(await page.$eval('.afe-inspector img.afe-thumb', (i) => i.src)), 'a thumbnail from Cloudflare Images');
    await typeInto(page, '#afe-f-image', 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/d993cd7c-7863-4a1b-ea5e-50602623cb00/public');
    await page.keyboard.press('Tab');
    await waitSaved(page);
    ok(fieldIn(await draftDef(), imgId).image === 'd993cd7c-7863-4a1b-ea5e-50602623cb00', 'a pasted link is cut down to its id');
    ok(await clickText(page, '.afe-inspector button', /Delete this item/), 'remove the test image');
    await waitSaved(page);
  });

  await section('Preview (falls back to the saved draft)', async () => {
    if (!(await page.$('.afe-phone iframe'))) ok(await clickText(page, '.afe-bar button', /^Preview$/), 'open the phone preview');
    await page.waitForSelector('.afe-phone iframe', { timeout: 5000 });
    await page.waitForFunction(() => { const p = document.querySelector('.afe-preview'); return p && (p.dataset.mode === 'saved' || p.dataset.ready === 'true'); }, { timeout: 25000 }).catch(() => {});
    const live = await page.$eval('.afe-preview', (p) => p.dataset.ready === 'true');
    if (live) ok(true, 'the family form answered the live-preview handshake');
    else {
      const frame = await (await page.$('.afe-phone iframe')).contentFrame();
      await frame.waitForSelector('[data-notice]:not([hidden])', { timeout: 15000 }).catch(() => {});
      ok(/Preview of your unpublished form changes/.test(await frame.$eval('[data-notice]', (e) => e.textContent).catch(() => '')), 'with no handshake, the frame shows the saved draft');
    }
    await shot(page, '06-preview.png', { maxH: 1200 });
  });

  await section('Live preview contract (postMessage)', async () => {
    const lp = await open(1440, 1000, '#applications/form', { previewProbe: true });
    try {
    await lp.page.waitForSelector('.afe-bar', { timeout: 20000 });
    if (!(await lp.page.$('.afe-phone iframe'))) await clickText(lp.page, '.afe-bar button', /^Preview$/);
    await lp.page.waitForSelector('.afe-phone iframe', { timeout: 5000 });
    const frameOf = async () => (await lp.page.$('.afe-phone iframe')).contentFrame();
    ok(/preview=live/.test(await lp.page.$eval('.afe-phone iframe', (f) => f.src)), 'it is /apply/form/?preview=live');
    await lp.page.waitForSelector('.afe-preview[data-ready="true"]', { timeout: 25000 }).catch(() => {});
    ok(/Updates as you edit/.test(await text(lp.page, '.afe-preview')), 'the frame said ready: live mode');
    const msgs = async () => (await frameOf()).evaluate(() => window.__afe || []).catch(() => []);
    // The family form answers the handshake itself; when the probe only reached the frame's
    // blank first document, listen in the form now and ask the editor for a fresh post
    const armed = await (await frameOf()).evaluate(() => {
      if (window.__afe) return false;
      window.__afe = [];
      window.addEventListener('message', (e) => { if (e.data?.type === 'afe-preview') window.__afe.push(e.data); });
      return true;
    }).catch(() => false);
    if (armed) { await clickText(lp.page, '.afe-row', /Parent/); await sleep(300); }
    for (let i = 0; i < 20 && !(await msgs()).length; i++) await sleep(250);
    ok((await msgs()).length >= 1 && (await msgs())[0].definition?.pages?.length === 9, 'the draft is posted once ready');
    await clickText(lp.page, '.afe-row', /Child's Name/);
    await sleep(300);
    ok((await msgs()).at(-1).focus === 'childName', 'selecting a question sends its id as focus');
    await typeInto(lp.page, '#afe-f-label', "Your child's name");
    await sleep(500);
    const last = (await msgs()).at(-1);
    ok(fieldIn(last.definition, 'childName').label === "Your child's name" && last.lang === 'en', 'edits arrive (debounced) with the whole definition');
    const before = (await msgs()).length;
    await typeInto(lp.page, '#afe-f-label', "Child's Name");
    await sleep(500);
    ok((await msgs()).length - before <= 3, `typing is debounced (${(await msgs()).length - before} messages for a burst)`);
    await clickText(lp.page, '.afe-preview button', /^ES$/);
    await sleep(200);
    ok((await msgs()).at(-1).lang === 'es', 'the ES toggle sends lang es');
    await clickText(lp.page, '.afe-preview button', /^EN$/);
    await waitSaved(lp.page);
    ok(lp.errors.length === 0, `no console errors${lp.errors.length ? `: ${lp.errors.slice(0, 3).join(' | ')}` : ''}`);
    } finally {
      await lp.page.close();
      // Back on the first tab: it picks up what the other tab saved (same person, so quietly)
      await page.bringToFront();
      await sleep(800);
      await waitSaved(page);
    }
    ok(fieldIn(await draftDef(), 'childName').label === "Child's Name" && /Child's Name/.test(await text(page, '.afe-col')), 'the first tab shows the other tab\'s saved changes when it comes back');
  });

  await section('Two editors at once', async () => {
    // Jen has the form open in another browser; Peter keeps working in his
    const jen = await open(1440, 1000, '#applications/form', { user: JEN });
    let dr;
    try {
    await jen.page.waitForSelector('.afe-bar', { timeout: 20000 });
    await page.bringToFront();
    await sleep(600);
    await clickText(page, '.afe-title', /Service Area/);
    await sleep(150);
    // Her tab is in the background (as on another computer): drive it through the DOM
    await jen.page.evaluate(() => [...document.querySelectorAll('.afe-title')].find(b => /Before You/.test(b.textContent))?.click());
    await sleep(300);
    await jen.page.evaluate(() => { const el = document.querySelector('#afe-page-title'); el.value = 'Welcome (Jen)'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    for (let i = 0; i < 40 && (await getDraftForm(DB))?.updatedBy !== JEN; i++) await sleep(250);
    ok((await getDraftForm(DB)).updatedBy === JEN, 'Jen saved from her own page');
    await typeInto(page, '#afe-page-title', 'Service Area (Peter)');
    await page.waitForSelector('.afe-conflict', { timeout: 8000 }).catch(() => {});
    ok(/Jen Alvarez saved changes at/.test(await text(page, '.afe-conflict')), 'the banner names her and the time');
    ok(await page.$eval('.afe-bar', (b) => b.dataset.status) === 'conflict' && await page.$eval('.afe-bar .btn-primary', (b) => b.disabled), 'autosave waits, and Put live is off');
    ok((await getDraftForm(DB)).updatedBy === JEN, 'nothing of hers was overwritten');
    await page.screenshot({ path: join(OUT, '07-conflict.png') });
    ok(await clickText(page, '.afe-conflict button', /Keep mine/), 'Keep mine');
    await waitSaved(page);
    dr = await getDraftForm(DB);
    ok(dr.updatedBy === PETER && dr.definition.pages[1].title === 'Service Area (Peter)' && dr.definition.pages[0].title !== 'Welcome (Jen)', 'mine saved over hers');
    ok(!(await page.$('.afe-conflict')), 'the banner is gone');
    } finally { await jen.page.close(); await page.bringToFront(); await sleep(300); }
    // Again, and this time take theirs
    const theirs = clone(dr.definition);
    theirs.pages[0].title = 'Hello from Jen';
    await saveDraftForm(DB, theirs, { user: JEN });
    await typeInto(page, '#afe-page-title', 'Service Area (Peter 2)');
    await page.waitForSelector('.afe-conflict', { timeout: 8000 }).catch(() => {});
    ok(!!(await page.$('.afe-conflict')), 'a second clash shows the banner again');
    ok(await clickText(page, '.afe-conflict button', /Load their version/), 'Load their version');
    await sleep(600);
    ok(/Hello from Jen/.test(await text(page, '.afe-page[data-id="welcome"] .afe-title')), 'their version is on screen');
    dr = await getDraftForm(DB);
    ok(dr.updatedBy === JEN && dr.definition.pages[1].title === 'Service Area (Peter)', 'and in D1 theirs stands');
    ok(await page.$eval('.afe-bar button[aria-label="Undo"]', (b) => !b.disabled), 'Undo can still bring mine back');
    // Tidy: page titles back
    await clickText(page, '.afe-title', /Hello from Jen/);
    await sleep(100);
    await typeInto(page, '#afe-page-title', 'Before You Begin');
    await clickText(page, '.afe-title', /Service Area/);
    await sleep(100);
    await typeInto(page, '#afe-page-title', 'Makeover Service Area Notice');
    await waitSaved(page);
    ok((await getDraftForm(DB)).updatedBy === PETER, 'saving goes on normally after');
  });

  await section('Emails and reminder emails', async () => {
    await clickText(page, '.hub-tab', /^Emails/);
    await page.waitForSelector('.afe-email-rail', { timeout: 8000 });
    ok(/#applications\/emails$/.test(await page.evaluate(() => location.hash)), 'the hash follows the tab');
    // "See what a family receives" sits where its purpose is: after editing the emails (and the form)
    ok(await clickText(page, '.afe-head .afe-sample-btn', /See what a family receives/), 'See what a family receives, in the Emails header');
    await page.waitForSelector('.afe-dialog', { timeout: 4000 });
    const sampleText = await text(page, '.afe-dialog');
    ok(/with you as the parent/.test(sampleText) && /welcome email with the PDF/.test(sampleText) && /archives itself in JobTread/.test(sampleText), 'its dialog says exactly what happens');
    ok(/changes that aren’t live yet won’t be in it/.test(sampleText), 'and warns when the draft has changes that aren’t live');
    ok(!/Archive that account/.test(sampleText), 'nothing to clean up by hand');
    await clickText(page, '.afe-dialog button', /^Cancel$/);
    await sleep(150);
    ok(!(await page.$('.afe-dialog')), 'Cancel closes it, nothing sent');
    const rail = await page.$$eval('.afe-email-rail button b', els => els.map(e => e.textContent.replace('!', '').trim()));
    ok(JSON.stringify(rail) === JSON.stringify(['Application received', 'In review', 'Approved', 'Denied', 'Correction', 'Reminders']), `every family email, in the order they get them (${rail.join(', ')})`);
    await page.click('.afe-email-rail [data-email="approved"]');
    await page.waitForSelector('#afe-m-approved');
    ok(/Once Status has stayed Approved for 30 minutes, never between 8 PM and 8 AM Eastern/.test(await text(page, '.afe-email-top')), 'it says when it goes, from the settings');
    ok(/Application Decision/.test(await text(page, '.afe-email-prev')), 'the preview has the subject JobTread uses');
    await typeInto(page, '#afe-m-approved', 'Great news, {parent}! We *approved* the application.');
    await waitSaved(page);
    ok(/should name the child/.test(await text(page, '.afe-email-main .afe-problems')), 'a message without {child} is caught, right there');
    ok(await page.$('.afe-email-rail [data-email="approved"] .afe-email-bad'), 'and marked in the list');
    ok(/<strong>approved<\/strong>/.test(await page.$eval('.afe-email-prev .afe-email-body', e => e.innerHTML)) && /Great news, Jordan Stone!/.test(await text(page, '.afe-email-prev')), '*stars* read as bold and {parent} is filled in');
    await page.click('#afe-m-approved');
    await page.keyboard.press('End');
    await page.keyboard.type(' ');
    await clickText(page, '.afe-email-ed .afe-chips button', /^\{child\}$/);
    await waitSaved(page);
    ok(!(await page.$('.afe-problems')), 'inserting {child} fixes it');
    // Spanish, beside it
    await clickText(page, '.afe-email-top .afe-seg button', /^Spanish/);
    await page.waitForSelector('#afe-m-approved[lang="es"]');
    ok(/The English changed after this was translated/.test(await text(page, '.afe-email-ed')), 'its Spanish shows as out of date, with the old English');
    ok(/Decisión sobre la solicitud/.test(await text(page, '.afe-email-prev')), 'the Spanish preview has the Spanish subject');
    await typeInto(page, '#afe-m-approved', '{parent}, la solicitud de *{child}* fue aprobada.');
    await waitSaved(page);
    const es = (await draftDef()).i18n.es;
    ok(es.strings['message:approved'] === '{parent}, la solicitud de *{child}* fue aprobada.' && es.sources['message:approved'] === (await draftDef()).messages.approved, 'typing the Spanish saves it against the current English');
    ok(/Jordan Stone, la solicitud de Avery Stone fue aprobada/.test(await text(page, '.afe-email-prev')), 'and the preview reads it');
    await clickText(page, '.afe-email-top .afe-seg button', /^English$/);
    // Reminders
    await page.click('.afe-email-rail [data-email="reminders"]');
    await page.waitForSelector('input[aria-label="Send reminder emails"]');
    await page.click('input[aria-label="Send reminder emails"]');
    await waitSaved(page);
    ok((await draftDef()).reminders.enabled === false, 'reminders off');
    ok(/Off: nobody gets these/.test(await text(page, '.afe-email-top')) && /Off/.test(await text(page, '.afe-email-rail [data-email="reminders"]')), 'and it says so');
    await page.click('input[aria-label="Send reminder emails"]');
    await page.type('input[aria-label="Add a reminder after this many days"]', '14');
    await page.keyboard.press('Enter');
    await waitSaved(page);
    ok(JSON.stringify((await draftDef()).reminders.days) === '[2,7,14,21]', 'a day is added in order');
    await page.evaluate(() => document.querySelector('button[aria-label="Remove 21 days"]').click());
    await waitSaved(page);
    ok(JSON.stringify((await draftDef()).reminders.days) === '[2,7,14]', 'and one removed');
    await typeInto(page, '#afe-rem-subject', 'Still thinking about it, {parent}?');
    await page.click('#afe-rem-body');
    await page.$eval('#afe-rem-body', (el) => el.setSelectionRange(0, 0));
    await clickText(page, '.afe-email-ed .afe-chips button', /^\{percent\}$/);
    await waitSaved(page);
    const rem = (await draftDef()).reminders;
    ok(rem.enabled && rem.subject === 'Still thinking about it, {parent}?' && rem.body.startsWith('{percent}'), `subject and a placeholder chip (at the cursor) land in the draft (${JSON.stringify([rem.enabled, rem.subject, rem.body.slice(0, 20)])})`);
    const sample = await text(page, '.afe-email-prev .afe-email');
    ok(/Still thinking about it, Jordan\?/.test(sample) && /^60/m.test(sample.split('\n').slice(2).join('\n')) && !/\{parent\}/.test(sample), 'the sample fills the placeholders');
    ok(/Families get the built-in emails|You have changes/.test(await text(page, '.afe-bar')), 'the draft bar speaks of emails here');
    await shot(page, '08-emails.png');
    // An old link to Messages lands here
    await page.evaluate(() => { location.hash = '#applications/messages'; });
    await sleep(300);
    ok(await page.$eval('.afe-tabs .active', (e) => e.dataset.tab) === 'emails', '#applications/messages opens Emails');
  });

  await section('Spanish', async () => {
    await clickText(page, '.hub-tab', /^Form/);
    await page.waitForSelector('.afe-subnav');
    await page.click('.afe-subnav [data-view="spanish"]');
    await page.waitForSelector('.afe-tr', { timeout: 8000 });
    ok(/#applications\/form\/spanish$/.test(await page.evaluate(() => location.hash)), 'Form → Spanish has its own address');
    const n = async (k) => Number(await page.$eval(`.afe-chip[data-filter="${k}"] .afe-chip-n`, (e) => e.textContent.replace(/\D/g, '')).catch(() => -1));
    const [all, missing, stale, done] = [await n('all'), await n('missing'), await n('stale'), await n('done')];
    ok(all > 100 && missing > 0 && stale > 0 && all === missing + stale + done, `counts add up (${all} = ${missing} missing + ${stale} out of date + ${done} done)`);
    await page.click('.afe-chip[data-filter="missing"]');
    await sleep(150);
    ok(await count(page, '.afe-tr') === missing, 'Missing shows just those');
    const path = `field:${kindId}:label`;
    ok(/Page 3: Basic Information/.test(await page.$eval(`.afe-tr[data-path="${path}"]`, (e) => e.closest('.afe-tr-group').querySelector('h4').textContent).catch(() => '')), 'grouped by where it lives');
    await page.type(`.afe-tr[data-path="${path}"] textarea`, '¿Qué tipo de mascotas?');
    await waitSaved(page);
    const es = (await draftDef()).i18n.es;
    ok(es.strings[path] === '¿Qué tipo de mascotas?' && es.sources[path] === 'What kind of pets?', 'typing marks it done (source = current English)');
    ok(await n('missing') === missing - 1 && await n('done') === done + 1, 'counts move');
    ok(await count(page, `.afe-tr[data-path="${path}"]`) === 1, 'it stays on screen while the filter is on');
    // Out of date
    await page.click('.afe-chip[data-filter="stale"]');
    await sleep(150);
    const sp = 'field:gender:option:Female';
    ok(/It used to say: “Female”/.test(await text(page, `.afe-tr[data-path="${sp}"]`)), 'the reworded choice shows as out of date, with the old English');
    await page.evaluate((p) => [...document.querySelectorAll(`.afe-tr[data-path="${p}"] .afe-link`)].find(b => /still right/.test(b.textContent))?.click(), sp);
    await waitSaved(page);
    ok((await draftDef()).i18n.es.sources[sp] === 'Girl', '"Still right" marks it done');
    // Placeholders
    await page.click('.afe-chip[data-filter="all"]');
    await page.type('.afe-toolbar input[type="search"]', 'Application');
    await sleep(150);
    await typeInto(page, '.afe-tr[data-path="title"] textarea', 'Solicitud de Sunshine on a Ranney Day');
    await sleep(150);
    ok(/The Spanish is missing \{year\}/.test(await text(page, '.afe-tr[data-path="title"]')), 'a lost placeholder is warned');
    ok(await count(page, '.afe-tr[data-path="title"] .afe-ph.is-missing') === 1, 'and marked');
    await typeInto(page, '.afe-tr[data-path="title"] textarea', 'Solicitud {year} de Sunshine on a Ranney Day');
    await sleep(150);
    ok(!/missing \{year\}/.test(await text(page, '.afe-tr[data-path="title"]')), 'putting it back clears it');
    await typeInto(page, '.afe-toolbar input[type="search"]', ' ');
    await page.$eval('.afe-toolbar input[type="search"]', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await waitSaved(page);
    // AI: not connected here, then a stand-in
    await page.click('.afe-chip[data-filter="missing"]');
    ok(await clickText(page, '.afe-toolbar button', /Fill missing with AI/), 'Fill missing with AI');
    await page.waitForFunction(() => /No AI drafts this time/.test(document.querySelector('.afe-progress')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(/AI translation isn’t set up on this site yet/.test(await text(page, '.afe-progress')), 'without Workers AI it explains, calmly');
    env.AI = fakeAI;
    const todo = (await n('missing')) + (await n('stale'));
    ok(await clickText(page, '.afe-toolbar button', /Fill missing with AI/), 'again, with AI');
    await page.waitForFunction(() => /AI drafts for/.test(document.querySelector('.afe-progress')?.innerText || ''), { timeout: 15000 }).catch(() => {});
    await waitSaved(page);
    const prog = await text(page, '.afe-progress');
    ok(/AI drafts for \d+ of \d+/.test(prog), `progress and a result (${prog.split('\n')[0]})`);
    const left = (await n('missing')) + (await n('stale'));
    const failedHelp = Object.keys(translationPaths(await draftDef())).filter(p => /:help$/.test(p)).length;
    ok(left < todo && left <= failedHelp + 1, `missing and out-of-date strings filled (${todo} → ${left})`);
    ok(/ES Do you have pets\?|ES Dog/.test(JSON.stringify((await draftDef()).i18n.es.strings)), 'AI Spanish merged into the draft');
    if (/came back with a placeholder/.test(prog)) {
      ok(await clickText(page, '.afe-progress .afe-link', /Show/), 'failures can be listed');
      await sleep(150);
      ok(await count(page, '.afe-tr') >= 1, 'and they show');
    }
    delete env.AI;
    ok(await page.evaluate(() => document.querySelector('.afe-subnav [data-view="spanish"] .afe-tab-count')?.textContent || '0') !== String(all), 'the count on Spanish follows');
    await page.click('.afe-chip[data-filter="all"]');
    await shot(page, '09-spanish.png', { maxH: 1800 });
  });

  await section('Form → Versions', async () => {
    await page.click('.afe-subnav [data-view="versions"]');
    await sleep(300);
    const hist = await text(page, '.card');
    ok(/Version \d+ Live/.test(hist.replace(/\s+/g, ' ')), 'versions listed with live');
    ok(await clickText(page, '.afe-hist button', /What's changing/), "the draft row: what's changing");
    await page.waitForSelector('.afe-dialog .afe-diff, .afe-dialog .afe-empty', { timeout: 8000 });
    ok(/QUESTIONS|Questions/.test(await text(page, '.afe-dialog')), 'lists the changes by area');
    await clickText(page, '.afe-dialog button', /^Done$/);
    await sleep(150);
    ok(await clickText(page, '.afe-hist button', /Compare with previous/), 'compare a live version with the one before');
    await page.waitForSelector('.afe-dialog .afe-diff', { timeout: 8000 });
    ok(/compared with the built-in form/.test(await text(page, '.afe-dialog h3')) && /Girl/.test(await text(page, '.afe-dialog')), 'version 1 against the built-in form');
    await page.screenshot({ path: join(OUT, '10-history-compare.png') });
    await page.keyboard.press('Escape');
    await sleep(150);
    ok(!(await page.$('.afe-dialog')), 'Escape closes it');
  });

  await section('Put the second round live', async () => {
    await page.click('.afe-subnav [data-view="questions"]');
    await page.waitForSelector('.afe-bar');
    await waitSaved(page);
    const problems = await text(page, '.afe-problems');
    ok(!problems, `no problems before going live${problems ? `: ${problems}` : ''}`);
    ok(await clickText(page, '.afe-bar button', /^Put live$/), 'Put live');
    await page.waitForSelector('.afe-dialog .afe-diff', { timeout: 8000 });
    const groups = await page.$$eval('.afe-dialog .afe-diff h4', (els) => els.map(e => e.textContent.replace(/\d+/g, '').trim()));
    ok(groups.includes('Questions') && groups.includes('Spanish') && groups.includes('Reminders'), `grouped by area (${groups.join(', ')})`);
    await clickText(page, '.afe-dialog .btn-primary', /^Put live$/);
    await page.waitForFunction(() => /Families see version 2|Families see version \d/.test(document.querySelector('.afe-bar')?.innerText || '') && !/aren't live/.test(document.querySelector('.afe-bar')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(!(await getDraftForm(DB)), 'the draft went live');
    await page.evaluate(() => { location.hash = '#applications/history'; });
    await page.waitForSelector('.afe-subnav [data-view="versions"][aria-pressed="true"]', { timeout: 5000 }).catch(() => {});
    ok(!!(await page.$('.afe-subnav [data-view="versions"][aria-pressed="true"]')), 'an old History link opens Form → Versions');
    await sleep(300);
    ok(await clickText(page, '.afe-hist button', /Restore as draft/), 'restore an earlier version');
    await sleep(800);
    ok(!!(await getDraftForm(DB)), 'it becomes the draft');
  });

  await section('Applicants → Submissions', async () => {
    await clickText(page, '.hub-tab', /^Applicants$/);
    await page.waitForSelector('.apl-views', { timeout: 10000 });
    await page.waitForSelector('.afe-intake', { timeout: 8000 }).catch(() => {});
    ok(/1 website application hasn’t fully reached JobTread/.test(await text(page, '.afe-intake')) && /Mila Brooks/.test(await text(page, '.afe-intake')), 'the other views say an application hasn’t reached JobTread, by name');
    ok(/1/.test(await text(page, '.apl-views [data-view="submissions"] .apl-view-n')), 'and the Submissions view carries the count');
    await page.click('.apl-views [data-view="submissions"]');
    await page.waitForSelector('.afe-sub', { timeout: 8000 });
    ok(/#applications\/submissions$/.test(await page.evaluate(() => location.hash)), 'it has its own address');
    ok(!(await page.$('.afe-intake')), 'the notice steps aside here (the Needs attention chip has it)');
    ok(/Showing 1–50 of 58/.test(await text(page, '.afe-pager')), `paged: ${(await text(page, '.afe-pager')).split('\n')[0]}`);
    const avery = await page.evaluate(() => [...document.querySelectorAll('.afe-sub')].find(x => /Avery Stone/.test(x.textContent))?.innerText || '');
    ok(/Spanish/.test(avery) && /4 mi outside/.test(avery), 'Avery: Spanish, 4 mi outside (the same words the board uses)');
    ok(/Possible repeat/.test(await page.evaluate(() => [...document.querySelectorAll('.afe-sub')].find(x => /Mila Brooks/.test(x.textContent))?.innerText || '')), 'Mila: possible repeat');
    const done = await page.evaluate(() => [...document.querySelectorAll('.afe-sub')].filter(x => x.querySelector('.afe-delivered')).length);
    const chips = await page.evaluate(() => [...document.querySelectorAll('.afe-sub')].filter(x => x.querySelector('.afe-delivered')).some(x => x.querySelectorAll('.afe-steps .badge').length));
    ok(done >= 40 && !chips, `a delivered application is one check, not ten chips (${done} rows)`);
    ok(/Home/.test(await page.evaluate(() => [...document.querySelectorAll('.afe-sub')].find(x => /Mila Brooks/.test(x.textContent))?.querySelector('.afe-steps')?.innerText || '')), 'one that isn’t shows just the steps left');
    ok(!/JOBTREAD_QC_GRANT_KEY|CF_STREAM_TOKEN/.test(await page.$eval('.afe-setup summary', e => e.innerText).catch(() => '')), 'setup gaps read in plain words (the variable names are under How to fix)');
    const names = async () => page.$$eval('.afe-sub-name', (els) => els.map(e => e.textContent));
    await clickText(page, '.afe-chip', /^Outside area$/);
    await page.waitForFunction(() => document.querySelectorAll('.afe-sub').length === 1, { timeout: 5000 }).catch(() => {});
    ok(JSON.stringify(await names()) === '["Avery Stone"]', 'Outside area: just Avery');
    await clickText(page, '.afe-chip', /^Possible repeat$/);
    await page.waitForFunction(() => /Mila/.test(document.querySelector('.afe-sub')?.textContent || '') && document.querySelectorAll('.afe-sub').length === 1, { timeout: 5000 }).catch(() => {});
    ok(JSON.stringify(await names()) === '["Mila Brooks"]', 'Possible repeat: just Mila');
    await clickText(page, '.afe-chip', /^Needs attention/);
    await page.waitForFunction(() => document.querySelectorAll('.afe-sub').length === 1, { timeout: 5000 }).catch(() => {});
    ok(/Mila Brooks/.test(await text(page, '.afe-sub-list')) && /Retry now/.test(await text(page, '.afe-sub-list')), 'Needs attention: the one that failed, with Retry');
    await clickText(page, '.afe-chip', /^Tests$/);
    await page.waitForFunction(() => /TEST Applicant/.test(document.querySelector('.afe-sub')?.textContent || ''), { timeout: 5000 }).catch(() => {});
    ok(JSON.stringify(await names()) === '["TEST Applicant"]', 'Tests: the test application');
    await clickText(page, '.afe-chip', /^All$/);
    await page.select('.afe-toolbar select[aria-label="Season"]', '2027');
    await page.waitForFunction(() => /^21 applications/.test(document.querySelector('.afe-pager')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(/^21 applications/.test(await text(page, '.afe-pager')), 'the 2027 season');
    ok(/export=csv&year=2027/.test(await page.$eval('.afe-toolbar a[download]', (a) => a.href)), 'the export follows the season');
    await page.click('.afe-toolbar .afe-check input');
    ok(/year=2027&tests=1/.test(await page.$eval('.afe-toolbar a[download]', (a) => a.href)), 'and the tests switch');
    const csvRes = await page.evaluate(async (u) => { const r = await fetch(u); return { type: r.headers.get('content-type'), body: await r.text() }; }, await page.$eval('.afe-toolbar a[download]', (a) => a.href));
    ok(/text\/csv/.test(csvRes.type) && /Avery Stone/.test(csvRes.body), 'the CSV downloads');
    await page.select('.afe-toolbar select[aria-label="Season"]', '');
    await page.waitForFunction(() => /of 58/.test(document.querySelector('.afe-pager')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    await clickText(page, '.afe-pager button', /^Next$/);
    await page.waitForFunction(() => /Showing 51–58 of 58/.test(document.querySelector('.afe-pager')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(/Showing 51–58 of 58/.test(await text(page, '.afe-pager')), 'Next page');
    await page.type('.afe-search input', 'avery');
    await page.waitForFunction(() => document.querySelectorAll('.afe-sub').length === 1, { timeout: 5000 }).catch(() => {});
    ok(JSON.stringify(await names()) === '["Avery Stone"]' && /^1 application$/.test(await text(page, '.afe-pager')), 'search (debounced) goes back to the first page');
    ok(await clickText(page, '.afe-sub button', /^Details$/), 'open Avery');
    await page.waitForFunction(() => /Address check/.test(document.querySelector('.afe-detail')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    const det = await text(page, '.afe-detail');
    ok(/About 4 miles outside the service area/.test(det) && /the family picked Cobb; the Census says Cherokee/.test(det), 'the address and county checks, in words');
    ok(/Open in JobTread/.test(det) && await count(page, '.afe-detail .afe-checks .badge') === 10, 'the details have JobTread and every step');
    ok(/County mismatch/.test(await text(page, '.afe-sub.is-open .afe-sub-who')), 'county mismatch badge');
    ok(new RegExp(`#applications/submissions/${fixtures.avery}$`).test(await page.evaluate(() => location.hash)), 'the hash names the application');
    await shot(page, '11-submissions.png', { maxH: 1600 });
    ok(await clickText(page, '.afe-detail button', /Delete family's data/), "Delete family's data from the site");
    await page.waitForSelector('#afe-del-confirm');
    ok(/JobTread isn't touched/.test(await text(page, '.afe-dialog')), 'it says JobTread is untouched');
    await page.type('#afe-del-confirm', 'Avry');
    ok(await page.$eval('.afe-dialog .btn-danger', (b) => b.disabled), 'the wrong name keeps Delete off');
    await page.screenshot({ path: join(OUT, '12-delete-dialog.png') });
    await typeInto(page, '#afe-del-confirm', 'avery');
    ok(await page.$eval('.afe-dialog .btn-danger', (b) => !b.disabled), "the child's first name turns it on (any case)");
    await page.click('.afe-dialog .btn-danger');
    await page.waitForFunction(() => !document.querySelector('.afe-dialog'), { timeout: 5000 }).catch(() => {});
    const row = await DB.prepare('SELECT deleted_at, answers FROM applications WHERE id = ?').bind(fixtures.avery).first();
    ok(!!row.deleted_at && row.answers === '{}', 'deleted from the site (D1)');
    await page.$eval('.afe-search input', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await clickText(page, '.afe-chip', /^Deleted$/);
    await page.waitForFunction(() => /Avery \(deleted\)/.test(document.querySelector('.afe-sub-list')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(/Avery \(deleted\)/.test(await text(page, '.afe-sub-list')) && /Deleted/.test(await text(page, '.afe-sub .afe-sub-who')), 'Deleted lists it');
    // A link straight to one application (JobTread's Application URL): no family matches here, so its row opens
    await page.evaluate((id) => { location.hash = `#applications/${id}`; }, fixtures.mila);
    await page.waitForFunction(() => /Mila Brooks/.test(document.querySelector('.afe-sub.is-open')?.innerText || '') && /Possible repeat:/.test(document.querySelector('.afe-detail')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(/Mila Brooks/.test(await text(page, '.afe-sub.is-open')), '#applications/<app id> opens that application');
  });

  await section('Insights', async () => {
    await clickText(page, '.hub-tab', /^Insights$/);
    await page.waitForSelector('.afe-tile', { timeout: 8000 });
    const tiles = await page.$$eval('.afe-tile', (els) => els.map(e => e.innerText.replace(/\s+/g, ' ')));
    ok(/Started 35/.test(tiles[0]) && /Submitted 20/.test(tiles[1]) && /Finish rate 57%/.test(tiles[2]) && /min/.test(tiles[3]), `tiles: ${tiles.join(' | ')}`);
    const legend = await text(page, '.afe-legend');
    ok(/Submitted\s*20/.test(legend) && /Still working on it\s*4/.test(legend) && /Ended by an answer\s*3/.test(legend) && /Left without finishing\s*8/.test(legend), 'what happened to everyone, in numbers');
    ok(/Home and Space\s*Most stop here/.test(await text(page, '.afe-hbar.is-top')), 'the page most people stop on is called out');
    ok(await count(page, '.afe-chart svg .afe-colbar') >= 6, `a column per week, empty weeks included (${await count(page, '.afe-chart svg .afe-colbar')})`);
    ok(/Spanish\s*\d/.test(await page.evaluate(() => [...document.querySelectorAll('.afe-viz')].find(v => /Language/.test(v.querySelector('h4')?.textContent))?.innerText || '')), 'languages');
    ok(/Children’s Healthcare of Atlanta/.test(await page.evaluate(() => [...document.querySelectorAll('.afe-viz')].find(v => /heard about us/.test(v.querySelector('h4')?.textContent))?.innerText || '')), 'referral sources');
    await shot(page, '13-insights.png');
    ok(await clickText(page, '.afe-checklist button', /See them/), '"See them" on a check');
    await page.waitForSelector('.afe-sub-list, .afe-subs .afe-empty', { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('.afe-chip[aria-pressed="true"]', { timeout: 5000 });
    ok(/Possible repeat|Outside area/.test(await text(page, '.afe-chip[aria-pressed="true"]')) && await page.$eval('.afe-tabs .active', (e) => e.dataset.tab) === 'applicants', 'opens Applicants → Submissions with that filter');
  });

  await section('Applicants', async () => {
    await clickText(page, '.hub-tab', /^Applicants$/);
    await page.waitForFunction(() => { const p = document.querySelector('[role="tabpanel"]'); return p && !/Loading…/.test(p.innerText); }, { timeout: 10000 }).catch(() => {});
    const body = await text(page, '[role="tabpanel"]');
    ok(body.length > 0 && !/Loading…/.test(body), `the applicants view loads, or explains why not (${body.slice(0, 60).replace(/\s+/g, ' ')})`);
    ok(/#applications\/applicants$/.test(await page.evaluate(() => location.hash)), 'its hash (it opens on the board, list, map or activity, not Submissions)');
    await page.evaluate(() => history.replaceState(null, '', '#applications/applicants/22PgaFvDKQ9L'));
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await sleep(200);
    ok(await page.$eval('.afe-tabs .active', (e) => e.dataset.tab) === 'applicants', 'a family in the hash stays on Applicants');
    ok(!!(await page.$('.apl-drawer')), 'and opens that family');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => {});
    await page.click('.apl-more-btn');
    await page.waitForSelector('.apl-menu', { timeout: 3000 }).catch(() => {});
    const menu = await text(page, '.apl-menu');
    ok(/Clean up statuses quietly/.test(menu) && !/test application|sample/i.test(menu), 'the Applicants ⋯ menu holds the cleanup only (the sample moved to Form and Emails)');
    ok(!(await page.$$eval('.apl-head-actions button', els => els.some(b => /Sync now/.test(b.textContent)))), 'and there’s no standing Sync now');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { history.replaceState(null, '', '#applications/applicants/22PgaFvDKQ9L'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await page.waitForSelector('.apl-drawer', { timeout: 4000 }).catch(() => {});
    await sleep(150);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.apl-drawer'), { timeout: 4000 }).catch(() => {});
    ok(!(await page.$('.apl-drawer')), 'Esc closes it');
  });

  await section('Settings: open or closed, season, schedule', async () => {
    // One save bar for the whole tab: it shows while anything is unsaved
    const saveOff = () => page.evaluate(() => { const b = [...document.querySelectorAll('.afe-savebar button')].find(x => /^(Save|Saving…)$/.test(x.textContent)); return b ? b.disabled : true; });
    const settled = () => page.waitForFunction(() => !document.querySelector('.afe-savebar'), { timeout: 8000 }).catch(() => {});
    const saveBtn = () => clickText(page, '.afe-savebar button', /^Save$/);
    const badge = () => text(page, '.afe-tabs [data-tab="settings"] .afe-tab-state');
    const status = () => text(page, '.afe-status');
    const local = (t) => { const d = new Date(t); const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
    const setLocal = (sel, v) => page.$eval(sel, (el, val) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    await page.click('.afe-tabs [data-tab="settings"]');
    await page.waitForSelector('.afe-status', { timeout: 8000 });
    ok(/#applications\/settings$/.test(await page.evaluate(() => location.hash)), 'its hash');
    ok(/Applications are closed/.test(await status()) && /Season: 2027/.test(await status()), 'the status says closed, season 2027');
    ok(/Application form[\s\S]*right away[\s\S]*Apply page[\s\S]*right away/i.test(await status()), 'where it shows: the form and the Apply page, both right away');
    ok((await saveOff()) === true, 'nothing to save yet');
    await page.waitForFunction(() => /3\s*families are waiting/.test(document.querySelector('.wl')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    const wl = () => text(page, '.wl');
    ok(/3\s*families are waiting \(2 English · 1 Spanish\)/.test(await wl()), `the waitlist panel counts who's waiting (${(await wl()).split('\n').slice(0, 3).join(' / ')})`);
    ok(/get one email 10 minutes later/.test(await wl()), 'and says the email goes on its own');
    await shot(page, '30-settings.png', { maxH: 1600 });

    // Open, through the confirm step
    ok(await clickText(page, '.afe-status button', /^Open applications…$/), 'Open applications…');
    await page.waitForSelector('.afe-dialog .afe-effects', { timeout: 5000 });
    const dlg = await text(page, '.afe-dialog');
    ok(/Open applications for 2027\?/.test(dlg) && /right away/.test(dlg) && !/published/.test(dlg), 'the confirm says what happens: everything right away');
    ok(/3 families on the waitlist get the "applications are open" email 10 minutes after you open/.test(dlg), 'and who on the waitlist gets emailed');
    await shot(page, '31-settings-open-confirm.png', { maxH: 1200 });
    await clickText(page, '.afe-dialog-foot button', /^Open applications$/);
    await page.waitForFunction(() => /Applications are open/.test(document.querySelector('.afe-status')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(!(await page.$('.afe-dialog')), 'the dialog closes');
    ok((await storedSettings()).application.open === true, 'stored open');
    ok(/Opened .* by Peter/.test(await status()), `since when, and who (${(await status()).split('\n').slice(0, 3).join(' / ')})`);
    ok(await badge() === 'Open', 'the tab says Open');
    ok(/Opened applications/.test(await text(page, '.afe-log')), 'logged in Recent changes');
    ok(/Families can apply/.test(await text(page, '.toast-container')) && !/Publish/.test(await text(page, '.toast-container')), 'the toast says it is open now, with no Publish');
    await page.waitForFunction(() => /goes to 3 families at/.test(document.querySelector('.wl-state')?.innerText || ''), { timeout: 10000 }).catch(() => {});
    ok(/goes to 3 families at .*\(\d+:\d\d\)/.test(await text(page, '.wl-state')), `the waitlist counts down to its email (${await text(page, '.wl-state')})`);
    await shot(page, '30b-settings-waitlist-countdown.png', { maxH: 1600 });
    ok(await clickText(page, '.wl-state button', /^Don't send this time$/), "Don't send this time");
    await page.waitForFunction(() => /On hold/.test(document.querySelector('.wl-state')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    ok(/On hold: .*chose not to send it this time/.test(await text(page, '.wl-state')) && !!(await page.$('.wl-state .btn-primary')), 'on hold, with Send now');
    // The email itself: English and Spanish previews, drawn by the real server
    await page.evaluate(() => { const d = [...document.querySelectorAll('.wl-sec')].find(x => /The email/.test(x.querySelector('summary')?.textContent || '')); if (d) d.open = true; });
    await page.waitForFunction(() => (document.querySelector('.wl-frame iframe')?.getAttribute('srcdoc') || '').includes('Applications are open'), { timeout: 8000 }).catch(() => {});
    ok(/Subject: Applications are open: apply for a 2027 room makeover/.test(await text(page, '.wl-sec[open]')), 'the email preview shows its subject');
    await clickText(page, '.wl-sec[open] .afe-seg button', /^Spanish$/);
    await page.waitForFunction(() => (document.querySelector('.wl-frame iframe')?.getAttribute('srcdoc') || '').includes('Ya puede presentar su solicitud'), { timeout: 8000 }).catch(() => {});
    ok((await page.$eval('.wl-frame iframe', (f) => f.getAttribute('srcdoc') || '')).includes('Ya puede presentar su solicitud'), 'and the Spanish one');
    await page.$eval('.wl-sec[open]', (el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, '30c-settings-waitlist-email.png', { maxH: 1600 });
    await page.evaluate(() => document.querySelectorAll('.wl-sec[open]').forEach(d => { d.open = false; }));
    // The waitlist panel on a phone
    const vp = page.viewport();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await sleep(400);
    ok(await page.$eval('.wl', (el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth + 1), 'the waitlist panel fits a phone');
    const smallWl = await page.$$eval('.wl-state button', (bs) => bs.filter(b => b.getBoundingClientRect().height < 40).map(b => b.textContent.trim()));
    ok(smallWl.length === 0, `its buttons are big enough to tap${smallWl.length ? `: ${smallWl.join(', ')}` : ''}`);
    await page.$eval('.wl', (el) => el.scrollIntoView({ block: 'start' }));
    await sleep(200);
    await page.screenshot({ path: join(OUT, '30d-settings-waitlist-phone.png') });
    await page.setViewport(vp);
    await sleep(300);

    // Season and wording
    await page.select('#afe-season', '2028');
    await typeInto(page, '#afe-closed', 'Applications reopen in January.');
    await typeInto(page, '#afe-formurl', 'example.com/form');
    ok(/starts with https/.test(await text(page, '.afe-settings')) && (await saveOff()) === true, 'a link without https:// blocks Save');
    await typeInto(page, '#afe-formurl', '');
    ok((await saveOff()) === false && /Unsaved changes to season and wording/.test(await text(page, '.afe-savebar')), 'unsaved, the save bar says what, and Save is on');
    await clickText(page, '.afe-fam .afe-seg button', /^Closed$/);
    ok(/Applications reopen in January\./.test(await text(page, '.afe-fam-banner')) && /with your unsaved changes/.test(await text(page, '.afe-fam')), 'the preview draws the unsaved closed message');
    await clickText(page, '.afe-fam .afe-seg button', /^Open$/);
    ok(/The 2028 application is now open!/.test(await text(page, '.afe-fam-banner')), 'and the open banner with the new season');
    await saveBtn();
    await settled();
    let st = await storedSettings();
    ok(st.application.year === '2028' && st.application.closedMessage === 'Applications reopen in January.' && st.application.open === true, `stored (${JSON.stringify(st.application)})`);
    ok(JSON.stringify(st.trustBadges) === JSON.stringify(settings.trustBadges) && JSON.stringify(st.social) === JSON.stringify(settings.social), 'the rest of the site settings are untouched');
    ok(/Season 2027 → 2028/.test(await text(page, '.afe-log')) && /Changed the closed message/.test(await text(page, '.afe-log')), 'each change in Recent changes');

    // Close on a time
    const closeAt = Date.now() + 3 * 864e5;
    await setLocal('#afe-closesAt', local(closeAt));
    await saveBtn();
    await settled();
    st = await storedSettings();
    ok(st.application.closesAt && Math.abs(Date.parse(st.application.closesAt) - closeAt) < 60e3, 'a close time is stored');
    ok(/Closes by itself/.test(await status()), 'the status says when it closes');

    // Close by hand: the scheduled close comes off
    await clickText(page, '.afe-status button', /^Close applications…$/);
    await page.waitForSelector('.afe-dialog .afe-effects', { timeout: 5000 });
    ok(/Applications reopen in January\./.test(await text(page, '.afe-dialog')) && /isn't needed and comes off/.test(await text(page, '.afe-dialog')), 'the close confirm quotes the closed message and the scheduled close');
    await clickText(page, '.afe-dialog-foot button', /^Close applications$/);
    await page.waitForFunction(() => /Applications are closed/.test(document.querySelector('.afe-status')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    st = await storedSettings();
    ok(st.application.open === false && st.application.closesAt === '', 'closed, and the close time is gone');

    // Open on a time; the heartbeat opens it
    const openAt = Date.now() + 2 * 864e5;
    await setLocal('#afe-opensAt', local(openAt));
    await page.waitForSelector('#afe-closesAt', { timeout: 3000 }).catch(() => {});
    ok(!!(await page.$('#afe-closesAt')), 'with an opening set, a close time can be set too');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('soard-save')));
    await settled();
    st = await storedSettings();
    ok(st.application.opensAt && Math.abs(Date.parse(st.application.opensAt) - openAt) < 60e3, '⌘S saves the opening time');
    ok(/^Opens /.test(await badge()) && /Opens by itself/.test(await status()), `the tab and the status say when it opens (${await badge()})`);
    ok(await runApplicationSchedule(env, { now: Date.parse(st.application.opensAt) + 1000 }) === 'opened', 'the heartbeat opens it at that time');
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.afe-status', { timeout: 10000 });
    ok(/Applications are open/.test(await status()) && /by the schedule/.test(await status()), 'after a reload: open, by the schedule');
    ok(/Opened on schedule/.test(await text(page, '.afe-log')), 'logged as opened on schedule');

    // Someone saves these elsewhere meanwhile: stop, say so, keep mine; a second Save uses mine
    st = await storedSettings();
    await writeSettings({ ...st, application: { ...st.application, closedMessage: 'Changed in another tab.' } });
    await typeInto(page, '#afe-closed', 'Mine wins.');
    await saveBtn();
    await page.waitForFunction(() => /changed these settings while you had them open/.test(document.querySelector('.afe-savebar')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(/Someone changed these settings/.test(await text(page, '.afe-savebar')), 'a change saved elsewhere stops the save and says so');
    ok(await page.$eval('#afe-closed', (e) => e.value) === 'Mine wins.' && (await storedSettings()).application.closedMessage === 'Changed in another tab.', 'my edit is kept, theirs is not overwritten yet');
    await saveBtn();
    await settled();
    ok((await storedSettings()).application.closedMessage === 'Mine wins.' && !(await page.$('.afe-savebar')), 'a second Save uses mine');

    // Another Site Config field saved meanwhile is kept (only `application` is written)
    st = await storedSettings();
    await writeSettings({ ...st, social: { ...st.social, tiktok: 'https://www.tiktok.com/@soard-test' } });
    await clickText(page, '.afe-status button', /^Close applications…$/);
    await page.waitForSelector('.afe-dialog', { timeout: 5000 });
    await clickText(page, '.afe-dialog-foot button', /^Close applications$/);
    await page.waitForFunction(() => /Applications are closed/.test(document.querySelector('.afe-status')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    await page.select('#afe-season', '2027');
    await typeInto(page, '#afe-closed', '');
    await saveBtn();
    await settled();
    st = await storedSettings();
    ok(st.application.open === false && st.application.year === '2027' && st.application.closedMessage === '', `closed again for 2027 (${JSON.stringify(st.application)})`);
    ok(st.social.tiktok === 'https://www.tiktok.com/@soard-test', 'a Site Config change made meanwhile is kept, not written back stale');
    ok(await badge() === 'Closed', 'the tab says Closed again');
    await writeSettings({ ...st, social: settings.social });

    await page.evaluate(() => { location.hash = '#applications/submissions'; });
    await page.waitForSelector('.afe-sub', { timeout: 8000 });
    ok(/Applications are closed for the 2027 season \(Settings\)\./.test((await text(page, '.afe-subs > .afe-lede')).replace(/\s+/g, ' ')), 'Submissions reads the same switch, words spaced right');
    ok(await clickText(page, '.afe-subs > .afe-lede a', /^Settings$/), 'and links to Settings');
    await page.waitForSelector('.afe-status', { timeout: 5000 }).catch(() => {});
    ok(await page.$eval('.afe-tabs .active', (e) => e.dataset.tab) === 'settings', 'which opens Settings');

    // The form's settings live here and save at once, with no Put live
    const rules = async () => (await getFormRules(DB))?.rules || null;
    ok(/selection@soardcharity\.com/.test(await text(page, '.afe-chipfield')), 'who gets the new-application email, as chips');
    await page.click('#afe-staff');
    await page.keyboard.type('jen@soardcharity.com,');
    await page.keyboard.type('not-an-email');
    await page.keyboard.press('Enter');
    ok(/"not-an-email" isn't an email address/.test(await text(page, 'section[aria-labelledby="afe-set-staff"]')) && (await saveOff()) === true && await count(page, '.afe-addr.is-bad') === 1, 'a bad address is marked and blocks Save');
    await page.evaluate(() => [...document.querySelectorAll('.afe-addr button')].find(b => /not-an-email/.test(b.getAttribute('aria-label')))?.click());
    ok(/Unsaved changes to the new-application email/.test(await text(page, '.afe-savebar')), 'the save bar names it');
    await page.$eval('#afe-wait-inReview', (el) => { el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok(/the new-application email and email timing/.test(await text(page, '.afe-savebar')), 'and the timing too, in one bar');
    await shot(page, '32-settings-rules-dirty.png', { maxH: 2400 });
    await saveBtn();
    await settled();
    let rs = await rules();
    ok(JSON.stringify(rs?.staffEmails) === '["selection@soardcharity.com","jen@soardcharity.com"]' && rs?.notify?.waits?.inReview === 15, `stored as settings (${JSON.stringify(rs?.staffEmails)}, ${rs?.notify?.waits?.inReview})`);
    clearFormCache();
    ok((await getLiveForm(DB, { fresh: true })).definition.notify.waits.inReview === 15, 'and in use at once, no Put live');
    ok(!(await getDraftForm(DB)) || (await getDraftForm(DB)).definition.notify.waits.inReview === 15, 'a draft in progress shows the same');
    ok(/New-application email goes to selection@soardcharity\.com, jen@soardcharity\.com/.test(await text(page, '.afe-log')) && /In Review emails wait 15 minutes/.test(await text(page, '.afe-log')), 'both in Recent changes');
    // Jen changes them meanwhile: say so, keep mine, a second Save uses mine
    await saveFormRules(DB, { notify: { summary: false } }, { user: JEN });
    await page.$eval('#afe-wait-decision', (el) => { el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await saveBtn();
    await page.waitForFunction(() => /Jen Alvarez changed these settings/.test(document.querySelector('.afe-savebar')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(/Jen Alvarez changed these settings while you had them open/.test(await text(page, '.afe-savebar')), 'a clash with another editor names her');
    ok(await page.$eval('input[aria-label="Summary email for staff"]', (e) => !e.checked), 'what I hadn’t touched now shows hers');
    await saveBtn();
    await settled();
    rs = await rules();
    ok(rs.notify.waits.decision === 45 && rs.notify.summary === false, 'a second Save uses mine and keeps hers');
    // The service area: its outline, and Reshape on the map
    ok(await count(page, '.afe-area-svg polygon') === 1 && /\d+ corners/.test(await text(page, '.afe-area-text')), 'the boundary’s outline and corners');
    ok(await clickText(page, '.afe-area-text button', /Reshape it on the map/), 'Reshape it on the map');
    await page.waitForSelector('.apl-map-note', { timeout: 10000 }).catch(() => {});
    ok(await page.$eval('.afe-tabs .active', (e) => e.dataset.tab) === 'applicants' && !!(await page.$('.apl-map-note')), 'opens the Applicants map, already reshaping');
    await page.click('.apl-map-note .btn-ghost'); // Cancel
    await page.click('.afe-tabs [data-tab="settings"]');
    await page.waitForSelector('.afe-status', { timeout: 5000 });
    await shot(page, '32-settings-after.png', { maxH: 2600 });
  });

  await section('Dark (on the admin tokens)', async () => {
    await setTheme(page, true);
    await clickText(page, '.hub-tab', /^Form/);
    await page.waitForSelector('.afe-bar');
    await page.click('.afe-subnav [data-view="questions"]');
    await page.waitForSelector('.afe-row');
    await clickText(page, '.afe-row', /What kind of pets/);
    await sleep(300);
    await shot(page, '01-form-desktop-dark.png', { maxH: 1400 });
    await clickText(page, '.hub-tab', /^Insights$/);
    await page.waitForSelector('.afe-tile');
    await shot(page, '13-insights-dark.png');
    await clickText(page, '.hub-tab', /^Form/);
    await page.click('.afe-subnav [data-view="spanish"]');
    await page.waitForSelector('.afe-tr');
    await shot(page, '09-spanish-dark.png', { maxH: 1400 });
    await page.evaluate(() => { location.hash = '#applications/submissions'; });
    await page.waitForSelector('.afe-sub');
    await shot(page, '11-submissions-dark.png', { maxH: 1400 });
    await clickText(page, '.hub-tab', /^Emails/);
    await page.waitForSelector('.afe-email-rail');
    await page.click('.afe-email-rail [data-email="inReview"]');
    await sleep(200);
    await page.screenshot({ path: join(OUT, '08-emails-dark.png') });
    await page.click('.afe-tabs [data-tab="settings"]');
    await page.waitForSelector('.afe-status');
    await shot(page, '30-settings-dark.png', { maxH: 1600 });
    await setTheme(page, false);
  });

  ok(errors.length === 0, `no console errors on desktop${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await page.close();

  await section('Site Config points here for open and closed', async () => {
    const sc = await open(1280, 900, '#site/apply');
    await sc.page.waitForSelector('.sc-page', { timeout: 20000 });
    const body = await sc.page.evaluate(() => document.querySelector('.sc-main').innerText);
    ok(/Applications are closed/.test(body) && !/Makeover Application|Application Year/.test(body), 'Site Config → Apply shows the status, with no application fields of its own');
    ok(await clickText(sc.page, '.sc-callout button', /Open Applications → Settings/), 'and links to Applications → Settings');
    await sc.page.waitForSelector('.afe-status', { timeout: 10000 }).catch(() => {});
    ok(await sc.page.$eval('.afe-tabs .active', (e) => e.dataset.tab).catch(() => null) === 'settings', 'which opens the Settings tab');
    await sc.page.close();
  });

  await section('Leaving with unsaved settings asks first', async () => {
    const lv = await open(1280, 900, '#applications/settings');
    const asked = [];
    lv.page.on('dialog', (d) => asked.push(d.message()));
    await lv.page.waitForSelector('#afe-closed', { timeout: 20000 });
    await lv.page.type('#afe-closed', 'Back soon.');
    await clickText(lv.page, '.nav-item', /Site Config/);
    await sleep(400);
    ok(asked.some(m => /unsaved changes in Applications settings/.test(m)), `the admin asks before leaving (${asked[0] || 'no prompt'})`);
    ok((await storedSettings()).application.closedMessage === '', 'and nothing was saved');
    await lv.page.close();
  });

  await section('Phone', async () => {
    const ph = await open(390, 844, '#applications/form');
    const p = ph.page;
    await p.waitForSelector('.afe-bar', { timeout: 20000 });
    const wide = () => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await clickText(p, '.afe-row', /Child's Name/);
    await sleep(300);
    ok(await wide() <= 1, `form: nothing wider than the screen (${await wide()}px over)`);
    ok(await p.$eval('.afe-inspector input, .afe-inspector textarea', (e) => parseFloat(getComputedStyle(e).fontSize) >= 16), 'inputs are 16px (no zoom on focus)');
    const small = await p.$$eval('.afe-row .afe-mini button, .afe-bar .afe-icon-btn', (els) => els.filter(e => e.offsetParent && (e.getBoundingClientRect().width < 44 || e.getBoundingClientRect().height < 40)).length);
    ok(small === 0, `touch targets are at least 44px (${small} smaller)`);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: join(OUT, '20-phone-form.png') });
    await p.evaluate(() => document.querySelector('.afe-inspector')?.scrollIntoView());
    await p.screenshot({ path: join(OUT, '21-phone-inspector.png') });
    await setTheme(p, true);
    await p.screenshot({ path: join(OUT, '21-phone-inspector-dark.png') });
    await setTheme(p, false);
    for (const [tab, sel, name] of [['submissions', '.afe-sub', '22-phone-submissions.png'], ['insights', '.afe-tile', '23-phone-insights.png'], ['form/spanish', '.afe-tr', '24-phone-spanish.png'], ['emails', '.afe-email-rail', '25-phone-emails.png'], ['form/versions', '.afe-hist', '26-phone-versions.png'], ['settings', '.afe-status', '28-phone-settings.png']]) {
      await p.evaluate((h) => { location.hash = `#applications/${h}`; }, tab);
      await p.waitForSelector(sel, { timeout: 8000 }).catch(() => {});
      await sleep(250);
      ok(await wide() <= 1, `${tab}: nothing wider than the screen (${await wide()}px over)`);
      if (tab === 'settings') {
        const seen = await p.$eval('.afe-tabs', (l) => { const lr = l.getBoundingClientRect(); const r = l.querySelector('[data-tab="settings"]').getBoundingClientRect(); return r.left >= lr.left - 1 && r.right <= lr.right + 1; });
        ok(seen, 'the tab row scrolls so Settings and its badge are in view');
      }
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({ path: join(OUT, name) });
    }
    // Settings on a phone: the save bar stays in reach
    await p.$eval('#afe-closed', (el) => { el.value = 'Back soon.'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);
    const bar = await p.$eval('.afe-savebar', (e) => { const r = e.getBoundingClientRect(); return { bottom: Math.round(r.bottom), right: Math.round(r.right), save: e.querySelector('.btn-primary').getBoundingClientRect().height }; }).catch(() => null);
    ok(bar && bar.bottom <= 844 && bar.right <= 391 && bar.save >= 40, `the save bar sits on the screen with a tappable Save (${JSON.stringify(bar)})`);
    ok(!/⌘S/.test(await text(p, '.afe-savebar')), 'and leaves out the keyboard shortcut on a touch screen');
    await p.screenshot({ path: join(OUT, '28b-phone-settings-savebar.png') });
    await clickText(p, '.afe-savebar button', /^Discard$/);
    await setTheme(p, true);
    await clickText(p, '.hub-tab', /^Insights$/);
    await sleep(300);
    await p.screenshot({ path: join(OUT, '23-phone-insights-dark.png') });
    await setTheme(p, false);
    await clickText(p, '.hub-tab', /^Form/);
    await p.waitForSelector('.afe-bar');
    await waitSaved(p);
    if (await clickText(p, '.afe-bar button', /^Put live$/)) {
      await p.waitForSelector('.afe-dialog', { timeout: 8000 }).catch(() => {});
      await sleep(400);
      await p.screenshot({ path: join(OUT, '27-phone-whats-changing.png') });
      const sheet = await p.$eval('.afe-dialog', (e) => { const r = e.getBoundingClientRect(); return { bottom: Math.round(r.bottom), w: Math.round(r.width) }; }).catch(() => null);
      ok(sheet && sheet.w >= 388 && sheet.bottom >= 840, `the dialog is a bottom sheet on a phone (${JSON.stringify(sheet)})`);
      await p.keyboard.press('Escape');
    }
    ok(ph.errors.length === 0, `no console errors on the phone${ph.errors.length ? `: ${ph.errors.slice(0, 3).join(' | ')}` : ''}`);
    await p.close();
  });
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.error(e);
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function translationPaths(def) {
  const out = {};
  for (const p of def.pages) for (const f of p.fields) if (f.help) out[`field:${f.id}:help`] = f.help;
  return out;
}

await browser.close();
console.log(failures.length ? `\n${failures.length} failed:\n - ${failures.join('\n - ')}` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
