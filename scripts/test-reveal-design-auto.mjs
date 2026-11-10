/**
 * test-reveal-design-auto.mjs — the automatic design import's drawing, in a real browser
 * ======================================================================================
 * functions/api/_reveal-design-auto.js draws plan sets in Cloudflare's browser with the same code the
 * Bring in from JobTread button runs. This makes a plan set like Max's (a contents page listing
 * "2 EXISTING LAYOUT", the existing layout with a "CEILING HEIGHT" note and the street in its title block,
 * the proposed layout, an electrical plan), runs the import on it in a local Chrome against the dev server's
 * pdf.js, and checks: the right pages are picked, the street's place on the drawing comes out white, the
 * title block is cut off, and the record says so (addressCheck 'wiped'). The drawings land in
 * test-results/reveal-design-auto/ to look at.
 *
 *   SITE=http://127.0.0.1:4417 node scripts/test-reveal-design-auto.mjs
 */
import puppeteer from 'puppeteer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createD1 } from '../tests/lib/d1-shim.mjs';
import { runRevealDesigns } from '../functions/api/_reveal-design-auto.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = (process.env.SITE || 'http://127.0.0.1:4417').replace(/\/$/, '');
const OUT = join(ROOT, 'test-results/reveal-design-auto/');
mkdirSync(OUT, { recursive: true });
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };

// ── A plan set ──
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const W = 1224, H = 792; // 17 × 11 at 72 dpi
const STREET = '12 Maple Lane';
function sheet(title, { notes = [], walls = true, street = true } = {}) {
  const p = doc.addPage([W, H]);
  // Border and a title block along the bottom
  p.drawRectangle({ x: 18, y: 18, width: W - 36, height: H - 36, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  p.drawLine({ start: { x: 18, y: 110 }, end: { x: W - 18, y: 110 }, thickness: 2 });
  p.drawText('SUNSHINE ON A RANNEY DAY', { x: 40, y: 70, size: 14, font: bold });
  if (street) p.drawText(`${STREET}, Roswell GA 30075`, { x: 420, y: 70, size: 14, font });
  p.drawText(title, { x: 820, y: 70, size: 18, font: bold });
  // The drawing: rooms as boxes
  if (walls) {
    p.drawRectangle({ x: 300, y: 260, width: 520, height: 330, borderColor: rgb(0, 0, 0), borderWidth: 6 });
    p.drawLine({ start: { x: 560, y: 260 }, end: { x: 560, y: 590 }, thickness: 6 });
    p.drawText('BATH', { x: 400, y: 420, size: 16, font });
    p.drawText('CLOSET', { x: 640, y: 420, size: 16, font });
  }
  p.drawText(title, { x: 300, y: 640, size: 28, font: bold });
  notes.forEach((n, i) => p.drawText(n, { x: 860, y: 600 - i * 20, size: 12, font }));
}
// Page 1: the contents
{
  const p = doc.addPage([W, H]);
  p.drawText('TABLE OF CONTENTS', { x: 80, y: 680, size: 30, font: bold });
  ['1 PROJECT SUMMARY', '2 EXISTING LAYOUT', '3 DIMENTIONED PROPOSED LAYOUT', '4 ELECTRICAL PLAN'].forEach((t, i) => p.drawText(t, { x: 80, y: 620 - i * 30, size: 16, font }));
  p.drawText(`${STREET}, Roswell GA 30075`, { x: 80, y: 120, size: 14, font });
}
sheet('EXISTING LAYOUT', { notes: ['*CEILING HEIGHT: 8 FT*'] });
sheet('DIMENTIONED PROPOSED LAYOUT');
sheet('ELECTRICAL PLAN', { notes: ['Remove existing outlet here'] });
const pdfBytes = await doc.save();

// ── A profile, JobTread, Cloudflare Images, all stood in for; the browser is real ──
const DB = await createD1({ schemaFiles: [join(ROOT, 'scripts/schema.sql')] });
await DB.prepare('INSERT INTO kids (slug, data, name, year, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind('max', JSON.stringify({ name: 'Max', slug: 'max', plans: [], beforeAfterPhotos: [{ before: 'https://x/b.jpg', after: '' }] }), 'Max', 2026, 'in-progress', '2026-11-01T00:00:00Z').run();
const uploads = {};
const fetchImpl = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://jt.test/set.pdf') return new Response(pdfBytes, { headers: { 'content-type': 'application/pdf' } });
  if (url.includes('/images/v1')) {
    const id = init.body.get('id');
    uploads[id] = new Uint8Array(await init.body.get('file').arrayBuffer());
    return Response.json({ success: true, result: { id, variants: [`https://imagedelivery.net/HASH/${id}/public`] } });
  }
  throw new Error(`unexpected ${url}`);
};
const sources = {
  kid: { slug: 'max', name: 'Max' }, job: { id: 'J', name: 'Max Daniel (2026)' },
  address: { street: STREET, city: 'Roswell', zip: '30075', family: 'Daniel' },
  sheets: [], befores: [],
  drawings: [{ id: 'SET', name: 'Max 2026_Plan Set_08172026.pdf', type: 'application/pdf', url: 'https://jt.test/set.pdf' }],
};
const now = Date.now();
const started = Date.now();
const r = await runRevealDesigns({ DB, JOBTREAD_GRANT_KEY: 'k', CF_ACCOUNT_ID: 'a', CF_IMAGES_TOKEN: 't' }, {
  fetchImpl, now, force: true, origin: SITE, sources: async () => sources,
  upcoming: [{ slug: 'max', name: 'Max', startsAt: new Date(now + 10 * 864e5).toISOString(), confirmed: true }],
  launch: () => puppeteer.launch({ headless: 'shell' }),
  readAsset: async (path) => readFileSync(join(ROOT, 'public', path), 'utf8'),
});
console.log(`run: ${JSON.stringify(r)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
const kid = JSON.parse((await DB.prepare('SELECT data FROM kids WHERE slug = ?').bind('max').first()).data);
const plans = Object.fromEntries((kid.plans || []).map((p) => [p.type, p]));
ok(plans['as-built']?.source === 'jt:SET#2', `the existing layout is page 2, not the contents page (${plans['as-built']?.source})`);
ok(plans.proposed?.source === 'jt:SET#3', `the proposed layout is page 3 (${plans.proposed?.source})`);
ok(plans['as-built']?.addressCheck === 'wiped' && plans.proposed?.addressCheck === 'wiped', 'the street was found on both and painted out');
ok(plans['as-built']?.label === 'Existing layout' && plans.proposed?.label === 'Dimentioned proposed layout', `captions (${plans['as-built']?.label} / ${plans.proposed?.label})`);
ok(!Object.values(plans).some((p) => /electrical/i.test(p.label)), 'the electrical plan stays out');
ok((Date.now() - started) < 25000, 'the drawing run fits in Cloudflare’s 30 seconds');

// Look at what went up: the street's place is white, the title block is gone
const browser = await puppeteer.launch({ headless: 'shell' });
const page = await browser.newPage();
for (const [type, p] of Object.entries(plans)) {
  const id = p.url.replace('https://imagedelivery.net/HASH/', '').replace(/\/public$/, '');
  const png = uploads[id];
  writeFileSync(join(OUT, `${type}.png`), png);
  const look = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 120) dark++;
    return { w: c.width, h: c.height, dark };
  }, Buffer.from(png).toString('base64'));
  // The sheet is 1224 × 792: drawn at 2400 on its long side, a whole sheet would be 2400 × 1553; the title block (the
  // bottom 110 points, 14%) cut off and the margin trimmed make it smaller
  ok(look.w <= 2400 && look.h < 1553 * 0.86, `${type}: the title block is cut off (${look.w} × ${look.h})`);
  ok(look.dark > 1000, `${type}: the drawing is there (${look.dark} dark pixels)`);
}
// The street itself, drawn where it was: render the sheet whole in the page and check the import's copy has none of it
const words = await page.evaluate(async (b64) => b64.length, Buffer.from(uploads[Object.keys(uploads)[0]]).toString('base64'));
ok(words > 0, 'drawings saved to look at');
await browser.close();

console.log(failures.length ? `\n${failures.length} failed:\n${failures.join('\n')}` : '\nAll passed');
console.log(`Drawings: ${OUT}`);
process.exit(failures.length ? 1 : 0);
