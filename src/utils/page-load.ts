/**
 * onPageLoad(fn): sets a page up as soon as it can be used, on every page this tab shows.
 *
 * The site moves between pages with Astro's ClientRouter, which tells scripts a page is ready with astro:page-load. For
 * a page opened in a new tab or reloaded, it waits for the window's load event: every photo, font and frame on the page.
 * On a slow phone that left the menu, the forms and every button dead for one to three seconds after the page could
 * be read (Nov 11 2026: /apply/'s menu ignored a tap 0.3 s after the page appeared; kid pages waited 2.9 s). Scripts
 * already set a page up before its photos arrive after every in-site move, so the page a tab opens is set up the same
 * way: once it has been read in and drawn, then after each move, once per page.
 *
 * Drawn first: nobody can tap a page that isn't on screen yet, and a setup run before the first paint would only hold
 * the page back (on a fast connection the scripts are in before anything is drawn). On a slow one the page has long
 * been drawn when they arrive, so they set it up at once.
 *
 * A setup that genuinely needs the page's pictures (src/components/ui/LqipReveal.astro) says so in its own code.
 */

/** Pages the router has swapped in since this tab opened one: a setup runs once for each */
let swapped = 0;
document.addEventListener('astro:after-swap', () => { swapped++; });

/** Whether this is still the page the tab opened (no in-site move yet) */
export const firstPage = (): boolean => swapped === 0;

/** fn once the page has been drawn: at once if it has, else right after the next paint */
function afterFirstPaint(fn: () => void): void {
  if (performance.getEntriesByType('paint').length) fn();
  else requestAnimationFrame(() => setTimeout(fn, 0));
}

export function onPageLoad(setUp: () => void): void {
  let ranFor = -1;
  const run = () => {
    if (ranFor === swapped) return;
    ranFor = swapped;
    setUp();
  };
  // Every page the router swaps in (and, for the first, Astro's own call at window load, which finds it done)
  document.addEventListener('astro:page-load', run);
  // The page this tab opened: once it's read in and drawn. A script that first runs after a move sets up the page it lands on
  const first = () => (swapped ? run() : afterFirstPaint(run));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', first, { once: true });
  else first();
}
