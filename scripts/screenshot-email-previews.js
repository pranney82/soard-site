/**
 * Renders the three email preview HTML files to PNG screenshots so we can
 * visually inspect the layout. Outputs to test-results/email-*.png.
 *
 *   node scripts/screenshot-email-previews.js
 */
import puppeteer from 'puppeteer';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'test-results');
mkdirSync(outDir, { recursive: true });

const files = [
  'email-preview-adrian-2025.html',
  'email-preview-kickoff-axel.html',
  'email-preview-monthly-march.html',
  'email-preview-reveal-invite.html',
];

const browser = await puppeteer.launch({ headless: true });
try {
  for (const f of files) {
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 1000, deviceScaleFactor: 1 });
    const url = pathToFileURL(resolve(root, f)).href;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    const out = resolve(outDir, f.replace(/\.html$/, '.png'));
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  ✓ ${out}`);
    await page.close();
  }
} finally {
  await browser.close();
}
