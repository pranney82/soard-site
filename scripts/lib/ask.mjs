/**
 * The admin asks "are you sure?" in its own dialog (public/admin/ask.js), never
 * the browser's confirm(). This answers those dialogs the way
 * page.on('dialog', (d) => d.accept()) answers native ones: each question's
 * title and text go to onAsk, then the action is chosen (accept: false picks
 * Cancel instead). Call it again on the same page to change either; it covers
 * the page already loaded and every page after it.
 *
 * Only the top page is touched (after each load), never evaluateOnNewDocument
 * or exposeFunction: those reach sandboxed preview iframes too, and Chrome
 * logs a blocked-script error for each.
 */
const state = new WeakMap();
const TAG = '__soardAsked ';

export async function answerAsks(page, { accept = true, onAsk = () => {} } = {}) {
  const first = !state.has(page);
  state.set(page, { accept, onAsk });
  const install = (accept, tag) => {
    window.__soardAskAccept = accept;
    if (window.__soardAskWatch) return;
    window.__soardAskWatch = true;
    const seen = new WeakSet();
    new MutationObserver(() => {
      for (const d of document.querySelectorAll('.ask-overlay .ask')) {
        if (seen.has(d)) continue;
        seen.add(d);
        console.debug(tag + [d.querySelector('h2')?.textContent, d.querySelector('.ask__text')?.textContent].filter(Boolean).join(' '));
        setTimeout(() => d.querySelector(window.__soardAskAccept ? '[data-ask="yes"]' : '[data-ask="no"]')?.click(), 0);
      }
    }).observe(document, { childList: true, subtree: true });
  };
  if (first) {
    page.on('console', (m) => { const t = m.text(); if (t.startsWith(TAG)) state.get(page).onAsk(t.slice(TAG.length)); });
    page.on('domcontentloaded', () => { page.evaluate(install, state.get(page).accept, TAG).catch(() => {}); });
  }
  await page.evaluate(install, accept, TAG).catch(() => {});
}
