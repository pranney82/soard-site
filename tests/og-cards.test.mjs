/**
 * Share cards (src/utils/og-card.ts, og-registry.ts, src/integrations/og-cards.mjs):
 * a page's card is its hero as a 1200×630 JPEG; its key covers everything its
 * pixels depend on (focal points included); a page links the picture's own
 * fingerprint; the build draws every card a page asked for, reuses the live
 * site's copy only when it's the very same picture, redirects the old .png
 * addresses, gives a forwarding page its target's preview, and stops if any
 * page is left without its card. No network: Cloudflare Images and the live
 * site are stand-ins here.
 * Run: node --test tests/og-cards.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';

process.env.SOARD_OG_SPEC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-specs-'));

// Bundled into node_modules/.cache so sharp, satori and opentype resolve from the repo
const CACHE = path.resolve('node_modules/.cache/og-test');
fs.mkdirSync(CACHE, { recursive: true });
let n = 0;
const load = async (entry, focus) => {
  const out = path.join(CACHE, `${path.basename(entry).replace(/\W/g, '_')}-${process.pid}-${n++}.mjs`);
  // A stand-in for the focal points People and Kids set (src/data/focus-photos.json)
  const plugins = focus ? [{ name: 'focus', setup(b) { b.onLoad({ filter: /focus-photos\.json$/ }, () => ({ contents: JSON.stringify(focus), loader: 'json' })); } }] : [];
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', packages: 'external', plugins });
  return import(pathToFileURL(out).href);
};
const card = await load('src/utils/og-card.ts', {});
const reg = await load('src/utils/og-registry.ts', {});
const { sentences } = await load('src/utils/sentences.ts');
const ogCards = (await import('../src/integrations/og-cards.mjs')).default;

// ── Stand-ins for Cloudflare Images and the live site ──
const LOGO = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp({ create: { width: 396, height: 360, channels: 4, background: '#FFDA24' } }).png().toBuffer(), left: 102, top: 120 }]).png().toBuffer();
const photo = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#3a6ea5' } }).jpeg().toBuffer();
let live = { index: null, files: {} };
let failPhotos = false;
let failLogo = false;
const asked = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  asked.push(url);
  if (url.startsWith('https://imagedelivery.net/')) {
    if (url.includes('brand-logo-light-bg-display')) return failLogo ? new Response('busy', { status: 503 }) : new Response(LOGO, { headers: { 'Content-Type': 'image/png' } });
    if (url.includes('/missing/')) return new Response('not found', { status: 404 });
    if (failPhotos) return new Response('busy', { status: 503 });
    const w = Number(url.match(/[,/]w=(\d+)/)?.[1] || 400), h = Number(url.match(/,h=(\d+)/)?.[1] || 500);
    return new Response(await photo(w, h), { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url === 'https://sunshineonaranneyday.com/og/index.json') return live.index ? Response.json(live.index) : new Response('', { status: 404 });
  const u = new URL(url);
  if (u.origin === 'https://sunshineonaranneyday.com' && live.files[u.pathname + u.search]) return new Response(live.files[u.pathname + u.search]);
  return new Response('', { status: 404 });
};

const KID = { layout: 'split', eyebrow: 'Accessible bathroom, Dream bedroom · 2025', title: 'Amari', lead: 'A wrong-way driver hit Amari head-on on his way to school. Featured on NBC News, SOARD built him a bedroom.', photo: { id: 'kids/amari/photo-09', alt: 'Photo of Amari' } };

test('a card is a 1200×630 JPEG small enough for every app, stamped with its key', async () => {
  const { jpg, photo: hasPhoto } = await card.drawCard(KID);
  const meta = await sharp(jpg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
  assert.ok(jpg.length < 300 * 1024, `under WhatsApp's 300 KB (${jpg.length})`);
  assert.equal(hasPhoto, true);
  assert.equal(await card.hasStamp(jpg, await card.cardKey(KID)), true);
  assert.equal(await card.hasStamp(jpg, 'something-else'), false);
});

test('a photo that won’t load: a text card, a different picture (so a different address), stamped to be drawn again', async () => {
  const spec = { ...KID, photo: { id: 'kids/missing/hero' } };
  const { jpg, photo: hasPhoto } = await card.drawCard(spec);
  assert.equal(hasPhoto, false);
  assert.equal((await sharp(jpg).metadata()).width, 1200);
  assert.equal(await card.hasStamp(jpg, await card.cardKey(spec)), false);
  // Cloudflare busy for a moment: the same spec drawn without its photo has another fingerprint
  failPhotos = true;
  const without = (await card.drawCard(KID)).jpg;
  failPhotos = false;
  assert.notEqual(card.fingerprint(without), card.fingerprint((await card.drawCard(KID)).jpg));
});

test('a card’s key follows everything its picture depends on, and only that', async () => {
  const k = await card.cardKey(KID);
  assert.equal(await card.cardKey({ ...KID }), k);
  assert.equal(await card.cardKey({ ...KID, photo: { ...KID.photo, alt: 'different words for the same photo' } }), k);
  assert.notEqual(await card.cardKey({ ...KID, title: 'Amari Jr.' }), k);
  assert.notEqual(await card.cardKey({ ...KID, photo: { id: 'kids/amari/photo-10' } }), k);
  assert.notEqual(await card.cardKey({ ...KID, look: { ...card.SITE_LOOK, ink: '#000000' } }), k);
  // The same photo by its full address or by its id is the same card
  assert.equal(await card.cardKey({ ...KID, photo: { id: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/amari/photo-09/public' } }), k);
  // A focal point set in the admin changes the crop, so the key
  const focused = await load('src/utils/og-card.ts', { 'kids/amari/photo-09': '0.50x0.10' });
  assert.notEqual(await focused.cardKey(KID), k);
});

test('a page passing anything but words where words go stops the build, not the card', async () => {
  await assert.rejects(card.cardKey({ ...KID, lead: ['Your gift builds ', { strong: 'rooms' }] }), /"lead" must be text, got a list/);
  await assert.rejects(card.drawCard({ ...KID, title: { em: 'Amari' } }), /"title" must be text/);
});

test('a card missing its small photo, or the logo, is still drawn, but not stamped whole (the next build draws it again); a page never fails on the logo', async () => {
  const withInset = { ...KID, inset: { id: 'kids/missing/accent' } };
  const a = await card.drawCard(withInset);
  assert.equal(a.photo, false);
  assert.equal(await card.hasStamp(a.jpg, await card.cardKey(withInset)), false);
  // A build whose first ask for the logo fails (a fresh copy: the logo is kept once it loads)
  const fresh = await load('src/utils/og-card.ts', {});
  failLogo = true;
  try {
    const key = await fresh.cardKey(KID); // the page still builds
    const b = await fresh.drawCard(KID);
    assert.equal(b.photo, false);
    assert.equal(await fresh.hasStamp(b.jpg, key), false);
    // The failure is remembered: the next pages don't wait on Cloudflare again
    const asks = asked.filter((u) => u.includes('brand-logo')).length;
    for (let i = 0; i < 5; i++) await fresh.cardKey({ ...KID, title: `Page ${i}` });
    assert.equal(asked.filter((u) => u.includes('brand-logo')).length, asks);
  } finally { failLogo = false; }
});

test('headlines break where a person would', () => {
  const t = card.layoutForTests.title;
  // An italic phrase is one run (one marker), on its own line like the page's hero
  const jack = t("Jack's <em>room reveal</em>");
  assert.deepEqual(jack.lines, ["Jack's", 'room reveal']);
  assert.deepEqual(jack.runs[1], [{ text: 'room reveal', em: true }]);
  // No line that is, or ends on, "the"/"a"/"&"…
  for (const html of ['Apply to join the <em>Advisory Board</em>', 'Mattie &amp; Nathan', 'Sunny &amp; Ranney', 'Your craft. A child’s <em>room</em>.', 'How to Create a Sensory-Friendly Bedroom for Your Child']) {
    const { lines } = t(html);
    for (const l of lines.slice(0, -1)) assert.doesNotMatch(l, /(^|\s)(a|an|the|of|to|and|&)$/i, `${html}: "${l}"`);
  }
  // A name's suffix stays with the name
  assert.ok(!t('Anthony Jr. &amp; Lyric&#39;s <em>room reveal</em>').lines.some((l) => /^Jr\./.test(l)));
  // The page's own <br> is kept when it fits
  assert.deepEqual(t('A room can change<br/>a child&#39;s <em>entire</em> life.').lines.slice(-1), ['a child\'s entire life.']);
  // More <br>s than lines: still big, not shrunk to the smallest size
  assert.ok(t('One<br>Two<br>Three<br>Four<br>Five').size >= 64);
  // A non-breaking space holds its words together
  assert.ok(t('Where Community Comes Together for <em>Something&nbsp;Big</em>').lines.some((l) => l.includes('Something\u00A0Big')));
  // Any kind of space: the narrow no-break one before "PM" holds "4:00 PM" together and never draws as a box
  const pm = t('Reveal at 4:00\u202FPM today\u2009now\uFEFF');
  assert.ok(pm.lines.some((l) => l.includes('4:00\u00A0PM')), pm.lines.join(' / '));
  assert.ok(!pm.lines.join(' ').match(/[\u2009\u202F\uFEFF]/));
  // An entity out of range is left as written, not a crash
  assert.doesNotThrow(() => t('Big &#9999999; day'));
});

test('a lead ends on a whole sentence; facts stay whole with their "·"; an eyebrow breaks after a comma', () => {
  const lead = card.layoutForTests.lead;
  assert.equal(lead('We create spaces. They change lives. Families never pay.').join(' '), 'We create spaces. They change lives. Families never pay.');
  // Too long for three lines: whole sentences, never a cut one
  const long = lead('We create life-changing spaces for children with special needs across greater Atlanta. Every room is designed around one child, built by our partners and volunteers, and given at no cost to the family. It starts with an application.').join(' ');
  assert.match(long, /\.$/);
  assert.doesNotMatch(long, /…/);
  const facts = lead('', ['4,850 Hours of Music Therapy Provided Per Year', '25 Group Contracts Seen Weekly', '1502 Clients Impacted']);
  for (const l of facts) assert.doesNotMatch(l, /^·/, `no line starts with the dot: ${l}`);
  const eb = card.layoutForTests.eyebrow('Accessible bathroom, Dream bedroom, Therapy room, Wheelchair ramp · 2021');
  assert.equal(eb.length, 2);
  assert.match(eb[0], /,$|·$/, `the break follows a comma: ${eb.join(' / ')}`);
});

test('the headline as the page writes it: italic words, line breaks, tags and entities', () => {
  // The page's own line break is kept (the card honours it when it fits)
  assert.deepEqual(card.parseTitle('Building <em>dreams</em>,<br>one room at a time'), [
    { text: 'Building ', em: false }, { text: 'dreams', em: true }, { text: ',', em: false }, { text: card.BREAK, em: false }, { text: 'one room at a time', em: false },
  ]);
  assert.deepEqual(card.parseTitle('Everything you need to <em class="highlight">know</em>.'), [
    { text: 'Everything you need to ', em: false }, { text: 'know', em: true }, { text: '.', em: false },
  ]);
  assert.deepEqual(card.parseTitle('Sunny &amp; Ranney&rsquo;s <strong>store</strong>'), [{ text: 'Sunny & Ranney’s store', em: false }]);
  // A non-breaking space keeps its words together
  assert.deepEqual(card.parseTitle('Something&nbsp;Big'), [{ text: 'Something Big', em: false }]);
  assert.equal(card.clean('Your gift, at <strong>no cost to families</strong>.'), 'Your gift, at no cost to families.');
  assert.equal(card.clean('A room can change<br/>a child’s life.'), 'A room can change a child’s life.');
});

test('letters outside the fonts: extended Latin draws, an accent the fonts lack is dropped from its letter, an emoji or arrow is left out (never a box)', async () => {
  // Drawn, not a box: "Đ" differs from "D" by its bar, far less than a box (or "X") would
  const raw = async (title) => (await sharp((await card.drawCard({ layout: 'text', title })).jpg).extract({ left: 150, top: 200, width: 900, height: 230 }).greyscale().raw().toBuffer());
  const diff = (a, b) => a.reduce((n, v, i) => n + (Math.abs(v - b[i]) > 60 ? 1 : 0), 0);
  const [d, dBar, x] = await Promise.all([raw('DDDDDD'), raw('ĐĐĐĐĐĐ'), raw('XXXXXX')]);
  assert.ok(diff(d, dBar) < diff(d, x) / 3, `Đ drawn as a letter (${diff(d, dBar)} vs ${diff(d, x)})`);
  assert.equal(card.drawableText('He loves trucks 🚒 → and blue.', 'sans400'), 'He loves trucks and blue.');
  assert.equal(card.drawableText('Łukasz Đorđe', 'serif700'), 'Łukasz Đorđe');
  // Vietnamese tone marks aren't in the site's fonts (Latin and extended Latin): the letter stays, its marks go
  assert.equal(card.drawableText('Đức', 'serif700'), 'Đuc');
});

test('sentences: a title or an initial doesn’t end one', () => {
  assert.deepEqual(sentences('A tremendous success! When we met Ms. Glass she smiled. Done.'), ['A tremendous success!', 'When we met Ms. Glass she smiled.', 'Done.']);
  assert.deepEqual(sentences('Born at 1 lb. 6 oz. he fought hard.'), ['Born at 1 lb. 6 oz. he fought hard.']);
  assert.deepEqual(sentences('He said “Wow.” Then left.'), ['He said “Wow.”', 'Then left.']);
});

test('the alt text says what the card says, and what its photo shows, once', () => {
  assert.equal(card.cardAlt(KID), 'Accessible bathroom, Dream bedroom · 2025: Amari. Photo of Amari. Sunshine on a Ranney Day');
  assert.equal(card.cardAlt({ layout: 'text', title: 'Tell us about your <em>child</em>.' }), 'Tell us about your child. Sunshine on a Ranney Day');
  assert.equal(card.cardAlt({ ...KID, photo: { id: 'x', alt: 'The Sunny & Ranney store in Roswell' } }), 'Accessible bathroom, Dream bedroom · 2025: Amari. Photo: The Sunny & Ranney store in Roswell. Sunshine on a Ranney Day');
});

test('every page has one card address', async () => {
  assert.equal(reg.cardFile('/'), '/og/home.jpg');
  assert.equal(reg.cardFile('/kids/amari/'), '/og/kids/amari.jpg');
  assert.equal(reg.cardFile('/events/gala/2026/'), '/og/events/gala/2026.jpg');
  assert.equal(reg.pagePath('/404'), '/404/');
  assert.equal(reg.pagePath('/'), '/');
  const e = await reg.registerCard('/kids/amari', KID);
  assert.equal(e.page, '/kids/amari/');
  assert.equal(e.url, `/og/kids/amari.jpg?v=${await card.cardKey(KID)}`);
  assert.ok(reg.readCards().some((c) => c.page === '/kids/amari/'));
  assert.equal(path.basename(reg.OG_SPEC_DIR), String(process.pid), 'its own list: another build never wipes or mixes it');
});

// ── The build step, on a small built site ──
const logger = { messages: [], info(m) { this.messages.push(m); }, warn(m) { this.messages.push(m); }, error(m) { this.messages.push(m); } };
function page(dist, pagePathname, entry, extra = '') {
  const file = path.join(dist, pagePathname, 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const img = entry ? `https://sunshineonaranneyday.com${entry.url}` : '';
  fs.writeFileSync(file, `<!DOCTYPE html><html><head><title>x</title>${entry ? `<meta property="og:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="${img}">` : ''}${extra}</head><body></body></html>`);
}
function site(listed) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'og-dist-'));
  fs.writeFileSync(path.join(dist, 'sitemap-0.xml'), `<urlset>${listed.map((p) => `<url><loc>https://sunshineonaranneyday.com${p}</loc></url>`).join('')}</urlset>`);
  fs.writeFileSync(path.join(dist, '_redirects'), '/blog/* /kids/:splat 301\n');
  return dist;
}
async function runBuild(dist) {
  const hooks = ogCards().hooks;
  await hooks['astro:build:done']({ dir: pathToFileURL(dist + '/'), logger });
}
const fp = (dist, file) => card.fingerprint(fs.readFileSync(path.join(dist, file)));
const ogOf = (dist, p) => fs.readFileSync(path.join(dist, p, 'index.html'), 'utf8').match(/property="og:image" content="([^"]+)"/)[1];

test('the build draws every card, links each page to its picture’s fingerprint, lists them, redirects the old ones', async () => {
  reg.clearCards();
  const dist = site(['/', '/kids/amari/', '/events/gala/2026/', '/live/']);
  page(dist, '/', await reg.registerCard('/', { layout: 'split', title: 'Building <em>dreams</em>', photo: { id: 'kids/braxton/photo-18' } }));
  page(dist, '/kids/amari/', await reg.registerCard('/kids/amari/', KID));
  page(dist, '/events/gala/2026/', await reg.registerCard('/events/gala/2026/', { layout: 'text', title: 'Evening of <em>Sunshine</em>' }));
  page(dist, '/live/', await reg.registerCard('/live/', { layout: 'text', title: 'Watch the <em>reveal</em> live' }));
  page(dist, '/live/amari/', await reg.registerCard('/live/amari/', { layout: 'text', title: 'Amari’s <em>room reveal</em>' }));
  // An old address that forwards (Astro's static redirect), one forwarding off the site, and a starting-soon screen with no card
  page(dist, '/events/2026-evening-of-sunshine/', null, '<meta http-equiv="refresh" content="0;url=/events/gala/2026/">');
  page(dist, '/elsewhere/', null, '<meta http-equiv="refresh" content="0;url=https://example.org/events/gala/2026/">');
  page(dist, '/live/amari/slate/', null);
  live = { index: null, files: {} };
  await runBuild(dist);

  for (const f of ['og/home.jpg', 'og/kids/amari.jpg', 'og/events/gala/2026.jpg', 'og/control-room.jpg']) {
    assert.equal((await sharp(path.join(dist, f)).metadata()).width, 1200, f);
  }
  const amari = `/og/kids/amari.jpg?v=${fp(dist, 'og/kids/amari.jpg')}`;
  assert.equal(ogOf(dist, '/kids/amari/'), `https://sunshineonaranneyday.com${amari}`, 'the page links the picture’s own fingerprint');
  assert.match(fs.readFileSync(path.join(dist, 'kids/amari/index.html'), 'utf8'), new RegExp(`name="twitter:image" content="https://sunshineonaranneyday\\.com${amari.replace(/[?.]/g, '\\$&')}"`));
  const index = JSON.parse(fs.readFileSync(path.join(dist, 'og/index.json'), 'utf8'));
  assert.deepEqual(index['/kids/amari/'], { url: amari, key: await card.cardKey(KID) });
  assert.match(index['/control-room/'].url, /^\/og\/control-room\.jpg\?v=[0-9a-f]{10}$/);
  const redirects = fs.readFileSync(path.join(dist, '_redirects'), 'utf8');
  assert.match(redirects, new RegExp(`^/og/kids/amari\\.png  ${amari.replace(/[?.]/g, '\\$&')}  301$`, 'm'));
  assert.match(redirects, /^\/og\/home\.png  \/og\/home\.jpg\?v=[0-9a-f]{10}  301$/m);
  assert.match(redirects, /^\/og\/live\.png  \/og\/live\.jpg\?v=[0-9a-f]{10}  301$/m, '/live/ had a card; its old address still works');
  assert.doesNotMatch(redirects, /^\/og\/live\/amari\.png/m, 'a kid’s live page never had one');
  assert.ok(redirects.indexOf('/og/home.png') < redirects.indexOf('/blog/*'), 'static rules above the site’s own (dynamic) ones');
  assert.ok(redirects.includes('/blog/* /kids/:splat 301'), 'the site’s own redirects kept');
  // The forwarding page now carries the gala page's preview; one forwarding to another site doesn't
  const stub = fs.readFileSync(path.join(dist, 'events/2026-evening-of-sunshine/index.html'), 'utf8');
  assert.match(stub, /<meta property="og:image" content="https:\/\/sunshineonaranneyday\.com\/og\/events\/gala\/2026\.jpg\?v=[0-9a-f]{10}">/);
  assert.match(stub, /<meta name="twitter:image"/);
  assert.doesNotMatch(fs.readFileSync(path.join(dist, 'elsewhere/index.html'), 'utf8'), /og:image/);
});

test('a page in the sitemap without a card, a card that wasn’t drawn, or an address that isn’t its picture, stops the build', async () => {
  reg.clearCards();
  const dist = site(['/', '/donate/']);
  page(dist, '/', await reg.registerCard('/', { layout: 'text', title: 'Home' }));
  page(dist, '/donate/', null);
  await assert.rejects(runBuild(dist), /\/donate\/: 0 og:image tags/);

  reg.clearCards();
  const dist2 = site(['/']);
  page(dist2, '/', { url: '/og/never-drawn.jpg?v=1' });
  await reg.registerCard('/other/', { layout: 'text', title: 'Other' });
  await assert.rejects(runBuild(dist2), /\/: card missing \(\/og\/never-drawn\.jpg\)/);

  // A page linking a card file that's there but at an address naming another picture
  reg.clearCards();
  const dist3 = site(['/', '/x/']);
  page(dist3, '/', await reg.registerCard('/', { layout: 'text', title: 'Home' }));
  page(dist3, '/x/', { url: '/og/home.jpg?v=0000000000' });
  await assert.rejects(runBuild(dist3), /\/x\/: card address \/og\/home\.jpg\?v=0000000000 isn't the picture there/);
});

test('an unchanged card comes from the live site; a changed one, a mismatched stamp or tampered bytes are drawn', async () => {
  reg.clearCards();
  const dist = site(['/kids/amari/', '/donate/']);
  const amari = await reg.registerCard('/kids/amari/', KID);
  const donate = await reg.registerCard('/donate/', { layout: 'text', title: 'A room can change a child’s <em>entire</em> life.' });
  page(dist, '/kids/amari/', amari);
  page(dist, '/donate/', donate);
  const amariJpg = (await card.drawCard(KID)).jpg;
  const liveUrl = `/og/kids/amari.jpg?v=${card.fingerprint(amariJpg)}`;
  // Live has Amari's card under this key; its Donate card is an older one
  live = { index: { '/kids/amari/': { url: liveUrl, key: amari.key }, '/donate/': { url: '/og/donate.jpg?v=0123456789', key: 'old' } }, files: { [liveUrl]: amariJpg } };
  asked.length = 0;
  await runBuild(dist);
  assert.deepEqual(fs.readFileSync(path.join(dist, 'og/kids/amari.jpg')), amariJpg);
  assert.equal(ogOf(dist, '/kids/amari/'), `https://sunshineonaranneyday.com${liveUrl}`, 'the same picture keeps the same address');
  assert.ok(!asked.some((u) => u.includes('kids/amari/photo-09')), 'Amari’s photo not fetched: the card came whole from the live site');
  assert.ok(logger.messages.at(-1).includes('1 unchanged from the live site'), logger.messages.at(-1));

  // The live file is another picture than its address names (a deploy in between): drawn instead
  reg.clearCards();
  const dist2 = site(['/kids/amari/']);
  page(dist2, '/kids/amari/', await reg.registerCard('/kids/amari/', KID));
  live.files[liveUrl] = (await card.drawCard({ ...KID, title: 'Someone else' })).jpg;
  asked.length = 0;
  await runBuild(dist2);
  assert.ok(asked.some((u) => u.includes('kids/amari/photo-09')), 'drawn again from its photo');
  assert.equal(await card.hasStamp(fs.readFileSync(path.join(dist2, 'og/kids/amari.jpg')), amari.key), true);
});

test('server code finds a page’s card address in the build’s list, and asks again after a failed read', async () => {
  const { cardFor } = await import('../functions/_og-cards.js');
  let reads = 0, up = false;
  const ASSETS = { fetch: async (req) => { reads++; assert.equal(new URL(req.url).pathname, '/og/index.json'); return up ? Response.json({ '/live/amari/': { url: '/og/live/amari.jpg?v=abc', key: 'k' } }) : new Response('', { status: 503 }); } };
  const ctx = { env: { ASSETS }, request: new Request('https://sunshineonaranneyday.com/live/') };
  assert.equal(await cardFor(ctx, '/live/amari/'), null, 'no list: no card (the page keeps its own)');
  up = true;
  assert.equal(await cardFor(ctx, '/live/amari/'), '/og/live/amari.jpg?v=abc');
  assert.equal(await cardFor(ctx, '/live/nobody/'), null);
  assert.equal(reads, 2, 'read once it worked, then kept');
});
