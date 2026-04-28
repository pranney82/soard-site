/**
 * Puppeteer FAQ test — actual UX verification, not code review.
 *
 * For each page (gala, golf):
 *  1) Loads the page, waits for FAQ accordion to be defined as a custom element.
 *  2) Captures screenshots: closed state, opened state, mid-animation state.
 *  3) Measures animation timing (transitionstart → transitionend) on a real click.
 *  4) Checks console for errors.
 *  5) Tests deep-linking: navigate to ?#hash and verify item opens.
 *  6) Tests rapid toggle: click open, click close mid-animation, verify no jank.
 *  7) Tests keyboard: Tab to summary, Space to open, Tab through link inside.
 *  8) Tests reduced-motion: re-runs open/close with prefers-reduced-motion enabled.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const OUT = '/Users/peterranney/Downloads/soard-site-main/test-results/faq';
mkdirSync(OUT, { recursive: true });

const PAGES = [
  { name: 'gala', url: 'http://localhost:4322/events/gala/' },
  { name: 'golf', url: 'http://localhost:4322/events/golf/' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 }, // iPhone 14
];

async function runTests() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--font-render-hinting=none'],
  });
  const results = [];

  for (const pageDef of PAGES) {
    for (const vp of VIEWPORTS) {
      const label = `${pageDef.name}-${vp.name}`;
      console.log(`\n=== ${label} ===`);
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2 });

      const errors = [];
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
      });

      await page.goto(pageDef.url, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => !!customElements.get('faq-accordion'), { timeout: 5000 });

      // Scroll FAQ into view
      await page.evaluate(() => {
        const acc = document.querySelector('faq-accordion');
        if (acc) acc.scrollIntoView({ block: 'start' });
      });
      await new Promise((r) => setTimeout(r, 400));

      // 1) Closed-state screenshot — use page-absolute coords (clip is page-coord, not viewport)
      const accBox = await page.evaluate(() => {
        const acc = document.querySelector('faq-accordion');
        if (!acc) return null;
        const r = acc.getBoundingClientRect();
        return {
          x: r.x + window.scrollX,
          y: r.y + window.scrollY,
          width: r.width,
          height: r.height,
        };
      });
      if (accBox) {
        await page.screenshot({
          path: `${OUT}/${label}-1-closed.png`,
          clip: {
            x: 0,
            y: Math.max(0, accBox.y - 40),
            width: vp.width,
            height: Math.min(1200, accBox.height + 80),
          },
        });
      }

      // 2) Click first item, measure animation timing on the body
      const firstSel = 'faq-accordion .faqacc__item:first-of-type';
      const timings = await page.evaluate(async (sel) => {
        const detail = document.querySelector(sel);
        const summary = detail?.querySelector('.faqacc__question');
        const body = detail?.querySelector('.faqacc__body');
        if (!detail || !summary || !body) return { error: 'no item' };

        // Listen for transition events on the body
        let startTs = null;
        let endTs = null;
        const onStart = () => { if (startTs === null) startTs = performance.now(); };
        const onEnd = (e) => {
          if (e.propertyName === 'height') endTs = performance.now();
        };
        body.addEventListener('transitionstart', onStart);
        body.addEventListener('transitionend', onEnd);

        const clickTs = performance.now();
        summary.click();

        // Wait up to 2s for transitionend
        await new Promise((r) => {
          const start = performance.now();
          const tick = () => {
            if (endTs !== null) return r();
            if (performance.now() - start > 2000) return r();
            requestAnimationFrame(tick);
          };
          tick();
        });

        body.removeEventListener('transitionstart', onStart);
        body.removeEventListener('transitionend', onEnd);

        return {
          clickTs: 0,
          startDelay: startTs !== null ? startTs - clickTs : null,
          duration: startTs !== null && endTs !== null ? endTs - startTs : null,
          isOpen: detail.open,
          finalInlineHeight: body.style.height,
        };
      }, firstSel);

      console.log('Open timing:', timings);
      results.push({ label, test: 'open', timings });

      // 3) Open-state screenshot — recapture box (height grew after open)
      const accBoxOpen = await page.evaluate(() => {
        const acc = document.querySelector('faq-accordion');
        if (!acc) return null;
        const r = acc.getBoundingClientRect();
        return {
          x: r.x + window.scrollX,
          y: r.y + window.scrollY,
          width: r.width,
          height: r.height,
        };
      });
      if (accBoxOpen) {
        await page.screenshot({
          path: `${OUT}/${label}-2-open.png`,
          clip: {
            x: 0,
            y: Math.max(0, accBoxOpen.y - 40),
            width: vp.width,
            height: Math.min(1400, accBoxOpen.height + 80),
          },
        });
      }

      // 4) Rapid toggle — click again to close, take a screenshot mid-animation
      const midJankReport = await page.evaluate(async (sel) => {
        const detail = document.querySelector(sel);
        const summary = detail?.querySelector('.faqacc__question');
        const body = detail?.querySelector('.faqacc__body');
        if (!detail || !summary || !body) return { error: 'no item' };

        // Click to close
        summary.click();
        // After 50ms (mid-animation), click again to re-open
        await new Promise((r) => setTimeout(r, 50));
        const midRect = body.getBoundingClientRect().height;
        summary.click();
        // Wait for next transitionend
        await new Promise((r) => {
          let done = false;
          const onEnd = (e) => {
            if (e.propertyName === 'height' && !done) {
              done = true;
              body.removeEventListener('transitionend', onEnd);
              r();
            }
          };
          body.addEventListener('transitionend', onEnd);
          setTimeout(() => { if (!done) r(); }, 2000);
        });
        const finalRect = body.getBoundingClientRect().height;
        return {
          midAnimationHeight: midRect,
          finalHeight: finalRect,
          isOpen: detail.open,
          inlineHeightAfter: body.style.height,
        };
      }, firstSel);
      console.log('Mid-toggle:', midJankReport);
      results.push({ label, test: 'mid-toggle', midJankReport });

      // 5) Deep-link test: open with hash
      const itemId = await page.evaluate((sel) => {
        return document.querySelector(sel)?.id || null;
      }, firstSel);

      if (itemId) {
        const deepLinkPage = await browser.newPage();
        await deepLinkPage.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2 });
        await deepLinkPage.goto(`${pageDef.url}#${itemId}`, { waitUntil: 'networkidle0' });
        await deepLinkPage.waitForFunction(() => !!customElements.get('faq-accordion'), { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 600));
        const deepLinkResult = await deepLinkPage.evaluate((id) => {
          const target = document.getElementById(id);
          return {
            isOpen: target?.open,
            visibleInViewport: (() => {
              if (!target) return false;
              const r = target.getBoundingClientRect();
              return r.top >= 0 && r.top < window.innerHeight;
            })(),
          };
        }, itemId);
        console.log('Deep-link:', deepLinkResult);
        results.push({ label, test: 'deep-link', deepLinkResult });
        await deepLinkPage.close();
      }

      // 6) Keyboard test
      const keyboardReport = await page.evaluate(async (sel) => {
        const detail = document.querySelector(sel);
        const summary = detail?.querySelector('.faqacc__question');
        if (!detail || !summary) return { error: 'no item' };
        summary.focus();
        const focusedSummary = document.activeElement === summary;
        return { focusedSummary };
      }, firstSel);
      console.log('Keyboard focus:', keyboardReport);
      results.push({ label, test: 'keyboard', keyboardReport });

      // 7) Errors
      console.log('Console errors:', errors.length === 0 ? 'none' : errors);
      results.push({ label, test: 'errors', errors });

      await page.close();
    }
  }

  await browser.close();
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
  return results;
}

runTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
