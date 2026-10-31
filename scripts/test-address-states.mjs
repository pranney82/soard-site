/**
 * The home address, every way a family can use it, in any order
 * ===========================================================================
 * The one-line address has two ways in (search and pick, or enter the parts by
 * hand) and many ways between them: the list's last row, the links under the
 * box, typing over a picked address, Escape, Continue, a reload, the other
 * language. The application form's suite walks the paths it was built for;
 * this walks seeded random paths through all of them, on a phone and a
 * computer, and after every step checks that what's on screen agrees with the
 * answer kept (the parts):
 *
 *   - one way shows at a time (the line, or the parts), with the link to the other
 *   - the line shows the whole address exactly when the parts hold a whole address
 *   - an open list ends with "Not in the list? Enter it yourself" and is on screen
 *   - Continue with no whole address says what to do, and stays
 *   - nothing on the address's screen is under the bars, and nothing errors
 *
 * Suggestions, the place lookup, the check and saving are answered here (so it
 * runs the same every time and never reaches a limit); the pages come from the
 * local server.
 *
 * Run (the local Pages server up):
 *   SITE=http://127.0.0.1:8817 node scripts/test-address-states.mjs [walks] [seed]
 */
import puppeteer from 'puppeteer';

const SITE = (process.env.SITE || 'http://127.0.0.1:8791').replace(/\/$/, '');
const WALKS = Number(process.argv[2]) || 8;
const SEED = Number(process.argv[3]) || 20261030;
const STEPS = 14;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.log(`  ✗ ${msg}`); } };

// A seeded random (the same walks every run; another seed, other walks)
let s = SEED;
const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const HOME = { line1: '3167 Main St', line2: '', city: 'Duluth', state: 'GA', zip: '30096', county: 'Gwinnett' };
const WHOLE = '3167 Main St, Duluth, GA 30096';
const INSIDE = { band: 'inside', answer: 'Yes, it is within the boundary.', miles: 0, edgeMiles: 3.7, nearMiles: 15, lat: 34.0024, lng: -84.1456, county: 'Gwinnett', matched: '3167 MAIN ST, DULUTH, GA, 30096' };
const NOWHERE = { band: 'unknown', answer: null, miles: null, edgeMiles: null, nearMiles: 15, lat: null, lng: null, county: null, matched: null, reason: 'no-match' };

const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });

async function openForm(phone) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(phone ? { width: 393, height: 659, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    const json = (o) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.startsWith(`${SITE}/api/apply?address=`)) {
      const q = decodeURIComponent(url.split('address=')[1] || '').toLowerCase();
      return json({ ok: true, source: 'google', results: /^3167/.test(q) ? [{ id: 'ChIJ_home_one_0001', line1: HOME.line1, sub: 'Duluth, GA' }] : [] });
    }
    if (url.startsWith(`${SITE}/api/apply?place=`)) return json({ ok: true, address: HOME });
    if (url.startsWith(`${SITE}/api/apply?usps=`)) return json({ ok: true, usps: null });
    if (url.startsWith(`${SITE}/api/apply`) && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      if (body.action === 'start') return json({ ok: true, token: 'f'.repeat(32) });
      if (body.action === 'area') return json({ ok: true, area: /^3167 main st$/i.test(String(body.address?.line1 || '').trim()) && String(body.address?.zip || '').startsWith('30096') ? INSIDE : NOWHERE });
      return json({ ok: true });
    }
    req.continue();
  });
  await page.goto(`${SITE}/apply/form/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('[data-hero-cta]');
  await sleep(500);
  for (let i = 0; i < 30 && !(await onAddressScreen(page)); i++) {
    await page.evaluate(() => document.querySelectorAll('[data-page]:not([hidden]) [data-type="ack"] input:not(:checked)').forEach((x) => { if (!x.closest('[data-off]')) x.click(); }));
    await page.click('[data-next]');
    await sleep(350);
  }
  return page;
}
const onAddressScreen = (page) => page.evaluate(() => { const f = document.querySelector('[data-field="address"]'); return !!f && !!f.getClientRects().length && !f.closest('[data-off], [hidden]'); });

/** Everything the checks look at, read at once */
const look = (page) => page.evaluate(() => {
  const seen = (sel) => { const e = document.querySelector(sel); return !!e && !!e.getClientRects().length && !e.closest('[data-off], [hidden]'); };
  const box = document.querySelector('[data-field="address"] .af-address');
  const parts = Object.fromEntries(['line1', 'line2', 'city', 'state', 'zip'].map((k) => [k, document.querySelector(`#af-address-${k}`).value.trim()]));
  const list = document.querySelector('#af-address-suggest');
  const rows = list && !list.hidden ? [...list.querySelectorAll('[role="option"]')] : [];
  const lr = list && !list.hidden ? list.getBoundingClientRect() : null;
  const top = document.querySelector('[data-top]')?.getBoundingClientRect().bottom || 0;
  const navTop = document.querySelector('[data-nav]')?.getBoundingClientRect().top ?? innerHeight;
  return {
    onScreen: (() => { const f = document.querySelector('[data-field="address"]'); return !!f && !!f.getClientRects().length && !f.closest('[data-off], [hidden]'); })(),
    mode: box?.dataset.mode, picked: box?.dataset.picked || '', line: document.querySelector('#af-address-search').value,
    searchSeen: seen('#af-address-search'), line1Seen: seen('#af-address-line1'), zipSeen: seen('#af-address-zip'),
    toParts: seen('[data-field="address"] [data-addr-mode="parts"]'), toLine: seen('[data-field="address"] [data-addr-mode="line"]'),
    parts, rows: rows.map((r) => (r.hasAttribute('data-by-hand') ? 'BY-HAND' : r.textContent.trim())),
    listIn: lr ? lr.top >= top - 1 && lr.bottom <= navTop + 1 : true,
    over: document.documentElement.scrollHeight - innerHeight,
    // The box they're in, if it's in the address: between the bar across the top and Back / Continue
    inView: (() => {
      const a = document.activeElement;
      if (!a?.closest?.('.af-address')) return true;
      const r = a.getBoundingClientRect();
      const top = document.querySelector('[data-top]')?.getBoundingClientRect().bottom || 0;
      const nav = document.querySelector('[data-nav]')?.getBoundingClientRect().top ?? innerHeight;
      return r.top >= top - 1 && r.bottom <= nav + 1;
    })(),
    error: document.querySelector('[data-field="address"] .af-error')?.textContent.trim() || '',
    title: document.querySelector('[data-step-title]')?.textContent.trim(), part: document.querySelector('[data-part-text]')?.textContent.trim(),
    active: document.activeElement?.id || document.activeElement?.tagName,
  };
});

const whole = (p) => !!(p.line1 && p.city && p.state && /^\d{5}/.test(p.zip));
const asLine = (p) => `${p.line1}, ${p.city}, ${[p.state, p.zip].filter(Boolean).join(' ')}`;

/** What must hold after any step */
async function invariants(page, where) {
  const v = await look(page);
  if (!v.onScreen) return v; // moved on (Continue with a whole address): the walk comes back
  ok(v.mode === 'line' || v.mode === 'parts', `${where}: a way in (${v.mode})`);
  if (v.mode === 'line') {
    ok(v.searchSeen && !v.line1Seen && !v.zipSeen, `${where}: the line shows, not the parts`);
    ok(v.toParts && !v.toLine, `${where}: with "Enter the address yourself" (and not "Search…")`);
    ok(whole(v.parts) === (v.line === asLine(v.parts)), `${where}: the line shows the whole address exactly when the answer is one ("${v.line}" / ${JSON.stringify(v.parts)})`);
    ok(!whole(v.parts) || v.picked === v.line, `${where}: a whole address in the line stands as picked`);
    if (v.rows.length) ok(v.rows[v.rows.length - 1] === 'BY-HAND', `${where}: the open list ends with "Not in the list? Enter it yourself" (${v.rows.join(' / ')})`);
  } else {
    ok(!v.searchSeen && v.line1Seen && v.zipSeen, `${where}: the parts show, not the line`);
    ok(v.toLine && !v.toParts, `${where}: with "Search for the address instead"`);
    ok(!v.rows.length, `${where}: no list over the parts`);
  }
  ok(v.listIn, `${where}: the list is on screen`);
  // A screen may scroll a little (the parts are taller than the line; nothing is moved to another screen
  // under them): the box they're typing in is what must be in view
  if (!v.rows.length) ok(v.inView, `${where}: the box they're in is in view (the screen ${v.over > 1 ? `scrolls ${v.over}px` : 'fits'})`);
  ok(!page.errors.length, `${where}: no errors (${page.errors.slice(0, 2).join(' | ')})`);
  return v;
}

const ACTIONS = {
  // Type a start of the home (it has a suggestion) or of an address the search doesn't know
  async type(page, v) {
    if (v.mode !== 'line') return 'skip';
    const text = pick(['3167 Main', '3167 Main St Du', '42 Nowhere Rd', '9']);
    await page.click('#af-address-search', { clickCount: 3 });
    await page.type('#af-address-search', text, { delay: 15 });
    await sleep(700);
    return `type "${text}"`;
  },
  async typeMore(page, v) {
    if (v.mode !== 'line' || !v.line) return 'skip';
    await page.focus('#af-address-search');
    await page.keyboard.press('End');
    await page.keyboard.type(' x', { delay: 15 });
    await sleep(500);
    return 'type on after it';
  },
  async tapSuggestion(page, v) {
    const i = v.rows.findIndex((r) => r !== 'BY-HAND');
    if (i < 0) return 'skip';
    await page.click(`#af-address-suggest-${i}`);
    await sleep(500);
    return 'tap a suggestion';
  },
  async keyboardPick(page, v) {
    if (!v.rows.length) return 'skip';
    const n = Math.floor(rand() * v.rows.length);
    await page.focus('#af-address-search');
    for (let i = 0; i <= n; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(500);
    return `ArrowDown ×${n + 1}, Enter (${v.rows[n]})`;
  },
  async byHandRow(page, v) {
    if (!v.rows.includes('BY-HAND')) return 'skip';
    await page.click('#af-address-suggest-by-hand');
    await sleep(400);
    return 'tap "Not in the list? Enter it yourself"';
  },
  async byHandLink(page, v) {
    if (!v.toParts || v.rows.length) return 'skip'; // under an open list there's no tapping it
    await page.click('[data-field="address"] [data-addr-mode="parts"]');
    await sleep(400);
    return 'tap "Enter the address yourself"';
  },
  async searchLink(page, v) {
    if (!v.toLine) return 'skip';
    await page.click('[data-field="address"] [data-addr-mode="line"]');
    await sleep(700);
    return 'tap "Search for the address instead"';
  },
  async fillParts(page, v) {
    if (v.mode !== 'parts') return 'skip';
    const [line1, city, zip] = pick([['3167 Main St', 'Duluth', '30096'], ['42 Nowhere Rd', 'Faketown', '30999'], ['3167 Main St', '', ''], ['', 'Duluth', '3009']]);
    for (const [k, val] of [['line1', line1], ['city', city], ['zip', zip]]) {
      await page.click(`#af-address-${k}`, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      if (val) await page.type(`#af-address-${k}`, val, { delay: 10 });
    }
    await sleep(400);
    return `parts "${line1}" / "${city}" / "${zip}"`;
  },
  async escape(page) {
    // From the address (Escape elsewhere on the screen is a screen back, by design): its list closes, nothing else
    await page.evaluate(() => { if (!document.activeElement?.closest('.af-address')) [...document.querySelectorAll('#af-address-search, #af-address-line1')].find((i) => i.getClientRects().length)?.focus(); });
    await page.keyboard.press('Escape');
    await sleep(200);
    return 'Escape';
  },
  async clearLine(page, v) {
    if (v.mode !== 'line') return 'skip';
    await page.click('#af-address-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await sleep(300);
    return 'clear the line';
  },
  async continue(page, v) {
    if (v.rows.length) await page.keyboard.press('Escape');
    const before = await look(page);
    await page.click('[data-next]');
    await sleep(700);
    // Continue waiting on the address check (its wheel turning): as a person would, until it's done
    await page.waitForFunction(() => document.querySelector('[data-next]')?.getAttribute('aria-busy') !== 'true', { timeout: 15000 }).catch(() => {});
    await sleep(300);
    const after = await look(page);
    if (after.onScreen) {
      ok(!!after.error, `Continue that stays on the address says why (parts ${JSON.stringify(before.parts)}, line "${before.line}")`);
      return 'Continue (stayed, told why)';
    }
    // On to the map screen or beyond: back to the address
    for (let i = 0; i < 4 && !(await onAddressScreen(page)); i++) { await page.click('[data-back]'); await sleep(600); }
    ok(await onAddressScreen(page), 'Back returns to the address');
    return 'Continue (on), then Back';
  },
  async reload(page) {
    await sleep(900); // the save after a change
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(500);
    if (!(await page.evaluate(() => document.documentElement.classList.contains('af-focus')))) { await page.click('[data-hero-cta]'); await sleep(500); }
    for (let i = 0; i < 4 && !(await onAddressScreen(page)); i++) { await page.click('[data-back]').catch(() => {}); await sleep(500); }
    return 'reload';
  },
  async language(page, v) {
    if (v.rows.length) await page.keyboard.press('Escape');
    for (const l of ['es', 'en']) {
      await page.evaluate((x) => document.querySelector(`[data-lang-switch] [data-lang="${x}"]`)?.click(), l);
      await sleep(400);
    }
    const after = await look(page);
    // The other language and back: the address as it was (the way in, and what's typed in it)
    // (entered by hand, the hidden line isn't theirs: going back to it rebuilds it from the parts)
    ok(after.mode === v.mode && (v.mode !== 'line' || after.line === v.line) && JSON.stringify(after.parts) === JSON.stringify(v.parts), `the address comes through a language switch as it was (${v.mode} "${v.line}" → ${after.mode} "${after.line}")`);
    return 'Español, then English';
  },
};

for (const phone of [true, false]) {
  for (let w = 0; w < WALKS; w++) {
    const page = await openForm(phone);
    const name = `${phone ? 'phone' : 'computer'} walk ${w + 1}`;
    if (!(await onAddressScreen(page))) { ok(false, `${name}: never reached the address`); await page.browserContext().close(); continue; }
    const path = [];
    let v = await invariants(page, `${name}, start`);
    for (let n = 0; n < STEPS; n++) {
      const key = pick(Object.keys(ACTIONS));
      const did = await ACTIONS[key](page, v).catch((e) => `${key} failed: ${e.message.split('\n')[0]}`);
      if (did === 'skip') { n--; continue; }
      path.push(did);
      const failed = failures.length;
      v = await invariants(page, `${name}, after ${path.join(' → ')}`);
      if (failures.length > failed) break; // one walk, one first failure: its path is the repro
    }
    console.log(`${name}: ${path.length} steps`);
    await page.browserContext().close();
  }
}
await browser.close();
console.log(`\n${checks} checks${failures.length ? `, ${failures.length} failed` : ', all passed'}`);
process.exit(failures.length ? 1 : 0);
