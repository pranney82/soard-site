/**
 * Pages opened in a real browser, for the press monitor.
 *
 * Google answers the site's server with its "unusual traffic" page (503,
 * "your computer or network may be sending automated queries"): plain
 * requests from Cloudflare Workers look like a bot to it, while the same
 * search in a browser goes through (found Oct 21 2026). Many outlets turn
 * the server away too (403), so their stories had no words or picture.
 * Those requests are opened in Cloudflare's Browser Rendering instead,
 * through the BROWSER binding (wrangler.toml) with @cloudflare/puppeteer.
 *
 * Only what a page needs to answer is loaded (no pictures, fonts or
 * styles). A browser stays open for two minutes after use, so a scan's
 * searches and the next beat share one instead of each starting one.
 * Nothing here throws: { ok, status, finalUrl, body, via: 'browser' } or
 * { ok: false, error }.
 */

import { UA } from './_press-sources.js';

const KEEP_ALIVE_MS = 120000;
const SKIP = new Set(['image', 'media', 'font', 'stylesheet']);
/** A browser to use: one left open by an earlier call when there is one (`launch` is for tests: a local Puppeteer) */
async function openBrowser(env, launch) {
  if (launch) return { browser: await launch(), shared: false };
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  try {
    const free = (await puppeteer.sessions(env.BROWSER)).filter((s) => !s.connectionId).map((s) => s.sessionId);
    for (const id of free) {
      try { return { browser: await puppeteer.connect(env.BROWSER, id), shared: true }; } catch { /* taken meanwhile */ }
    }
  } catch { /* none to list */ }
  return { browser: await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS }), shared: true };
}
async function release({ browser, shared }) {
  try { if (shared) await browser.disconnect(); else await browser.close(); } catch { /* gone already */ }
}

/** Is there a browser to use? */
export const hasBrowser = (env) => !!env?.BROWSER;

/**
 * Open `url` in the browser.
 *   rendered: the page as the browser built it (articles drawn by JavaScript);
 *             otherwise the bytes as sent (an RSS feed, not Chrome's XML viewer)
 *   leave:    (url) => true for where a redirect should end; the browser stops
 *             there and reports the address without loading that page
 */
export async function browserGet(env, url, { launch = null, timeout = 15000, rendered = false, leave = null } = {}) {
  if (!hasBrowser(env) && !launch) return { ok: false, error: 'No browser here (the BROWSER binding)' };
  let b = null;
  let page = null;
  try {
    b = await openBrowser(env, launch);
    page = await b.browser.newPage();
    // As an ordinary Chrome: some news sites turn "HeadlessChrome" away (11Alive answers it 403)
    await page.setUserAgent(UA).catch(() => {});
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await page.setRequestInterception(true);
    let left = null;
    page.on('request', (req) => {
      if (SKIP.has(req.resourceType())) { req.abort().catch(() => {}); return; }
      if (leave && req.isNavigationRequest() && req.frame() === page.mainFrame() && req.url() !== url && leave(req.url())) {
        left = req.url();
        req.abort().catch(() => {});
        return;
      }
      req.continue().catch(() => {});
    });
    const started = Date.now();
    let res = null;
    let failed = null;
    try { res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); } catch (e) { failed = e; }
    if (leave) {
      // The page sends the browser on with its own script: wait for it
      while (!left && Date.now() - started < timeout) await new Promise((r) => setTimeout(r, 200));
      if (left) return { ok: true, status: 200, finalUrl: left, via: 'browser' };
      return { ok: false, status: res?.status?.() || 0, error: failed?.message || 'The page never sent the browser on', via: 'browser' };
    }
    if (failed || !res) return { ok: false, status: 0, error: failed?.message || 'No answer', via: 'browser' };
    const status = res.status();
    const body = rendered ? await page.content() : await res.text().catch(() => '');
    return { ok: status >= 200 && status < 300, status, finalUrl: page.url(), body, via: 'browser' };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || 'The browser failed', via: 'browser' };
  } finally {
    try { await page?.close(); } catch { /* closed */ }
    if (b) await release(b);
  }
}
