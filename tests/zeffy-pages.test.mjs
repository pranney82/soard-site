/**
 * The public pages' Zeffy links: no page keeps a form link of its own; every gift button on /donate/ and the
 * DAF link on /ways-to-give/ come from giftLink()/dafGift() (public/admin/zeffy-links.js), which pair the form's page
 * with the embed <ZeffyPopup /> opens; Give from Your DAF only when Site Config says the form takes DAF gifts; the
 * pop-up is a native modal dialog that leaves no history behind; and every ticket button on the site comes from the
 * event's own link through ticketsOf() (public/admin/events-shared.js), none meaning not on sale yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { giftLink, dafGift, dafOn, DAF_MIN, DAF_MIN_TEXT } from '../public/admin/zeffy-links.js';
import { ticketsOf } from '../public/admin/events-shared.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(astro|ts|js|mjs)$/.test(f)) files.push(p); } };
for (const d of ['src/pages', 'src/components', 'src/utils', 'src/layouts']) walk(join(ROOT, d));

test('no public page keeps a Zeffy form’s link of its own: they come from Site Config → Zeffy or the event', () => {
  const hits = files.filter((f) => /zeffy\.com\/(?:[a-z]{2}(?:-[A-Za-z0-9]{2,4})?\/|embed\/)?(?:donation-form|ticketing|peer-to-peer|o\/fundraising)/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => f.slice(ROOT.length)), []);
  // Nobody pairs a link with an embed by hand: data-zeffy only ever arrives in giftLink()'s spread
  const handmade = files.filter((f) => /data-zeffy=\{/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(handmade.map((f) => f.slice(ROOT.length)), []);
});

test('every gift button on /donate/ is giftLink(): its page and its embed, at its amount', () => {
  const donate = read('src/pages/donate.astro');
  assert.match(donate, /const once = \(amount\?: number\) => giftLink\(siteSettings, 'donateUrl', amount \?\? null\);/);
  assert.match(donate, /const monthly = \(amount\?: number\) => giftLink\(siteSettings, 'monthlyUrl', amount \?\? null\);/);
  assert.match(donate, /const daf = dafGift\(siteSettings\);/);
  const gifts = [...donate.matchAll(/<a \{\.\.\.(once|monthly)\((\d*)\)\}/g)];
  assert.ok(gifts.length >= 13, `the Donate page’s gift links (${gifts.length})`);
  assert.equal(gifts.filter((g) => g[1] === 'monthly').length, 5, 'five monthly buttons, all on the monthly form');
  assert.match(donate, /\{daf && <a class="donate-fact-link" \{\.\.\.daf\}/, 'Give from Your DAF only when Site Config has DAF on');
  assert.equal((donate.match(/^\s*<ZeffyPopup \/>\s*$/gm) || []).length, 1, 'one pop-up on the page');
  assert.doesNotMatch(donate, /siteForm|embedOf|withParam|ZEFFY_/, 'nothing works out a form link by itself');
});

test('/ways-to-give/: Give from Your DAF through dafGift, Send a Grant always there, the pop-up only when it’s used', () => {
  const wtg = read('src/pages/ways-to-give.astro');
  assert.match(wtg, /const daf = dafGift\(siteSettings\);/);
  assert.match(wtg, /\{daf && <a \{\.\.\.daf\} target="_blank" rel="noopener noreferrer" class="wtg-method-cta">Give from Your DAF →<\/a>\}/);
  assert.match(wtg, /<a href=\{`mailto:\$\{email\}\?subject=DAF Grant to SOARD`\}[^>]*>Send a Grant →<\/a>/, 'recommending a grant still has its action');
  assert.equal((wtg.match(/^\s*\{daf && <ZeffyPopup \/>\}\s*$/gm) || []).length, 1, 'one pop-up');
  assert.match(wtg, /\{daf && <ZeffyPopup \/>\}/, 'and only when there’s a DAF link to open it');
  assert.doesNotMatch(wtg, /wtg-method-hint--under/, 'no hint repeating the paragraph above it');
});

test('both pages say the DAF minimum the same way, and the DAF link follows Site Config', () => {
  assert.equal(DAF_MIN_TEXT, `$${DAF_MIN.toLocaleString('en-US')}`);
  assert.equal(DAF_MIN_TEXT, '$1,000');
  for (const f of ['src/pages/donate.astro', 'src/pages/ways-to-give.astro']) {
    const src = read(f);
    assert.match(src, /Give \{DAF_MIN_TEXT\} or more on our donation form/, `${f} prints the minimum from DAF_MIN_TEXT`);
    assert.doesNotMatch(src, /\$1,000 or more/, `${f} never types it out`);
    assert.match(src, />Give from Your DAF →</, `${f}: one wording for the link`);
  }
  const on = { zeffy: { donateUrl: 'https://www.zeffy.com/en-US/donation-form/a-brighter-day', daf: true } };
  assert.deepEqual(dafGift(on), {
    href: 'https://www.zeffy.com/donation-form/a-brighter-day?amount=1000',
    'data-zeffy': 'https://www.zeffy.com/embed/donation-form/a-brighter-day?amount=1000',
  });
  assert.equal(dafGift({ zeffy: { ...on.zeffy, donateUrl: 'https://www.zeffy.com/donation-form/new-form' } })['data-zeffy'], 'https://www.zeffy.com/embed/donation-form/new-form?amount=1000', 'a new one-time form brings its DAF link along');
  assert.equal(dafGift({ zeffy: { ...on.zeffy, daf: false } }), null, 'DAF off: no link');
  assert.equal(dafOn({ zeffy: { daf: true } }), false, 'no one-time form: no DAF link');
  assert.deepEqual(giftLink(on, 'donateUrl', 60), { href: 'https://www.zeffy.com/donation-form/a-brighter-day?amount=60', 'data-zeffy': 'https://www.zeffy.com/embed/donation-form/a-brighter-day?amount=60' });
  assert.throws(() => giftLink({}, 'monthlyUrl'), /monthly gifts has no Zeffy form: pick one in Admin → Site Config → Zeffy/);
});

test('the pop-up: a native modal dialog, a fresh form frame each time, a 44px close button', () => {
  const popup = read('src/components/ui/ZeffyPopup.astro');
  assert.match(popup, /<dialog class="zeffy-modal" id="zeffy-modal" aria-label="Donation form">/);
  assert.match(popup, /\.showModal\(\)/, 'the page behind is inert while it’s open');
  assert.match(popup, /document\.createElement\('iframe'\)/, 'a new frame on each open');
  assert.match(popup, /addEventListener\('close', \(\) => \{\s*box\.querySelector\('iframe'\)\?\.remove\(\);/, 'and gone on close, so Back never collects its pages');
  assert.doesNotMatch(popup, /<iframe/, 'no frame in the page until a gift is opened');
  assert.doesNotMatch(popup, /allowpaymentrequest/);
  assert.match(popup, /\.zeffy-modal-x \{[^}]*width: 44px;[^}]*height: 44px;/s);
  assert.match(popup, /astro:before-swap', cleanupPopup/, 'leaving the page closes it');
  assert.match(read('src/components/live/LiveGive.astro'), /formLinks\(requireSiteForm\(siteSettings, 'liveUrl'\)\)!\.embed/);
});

test('every ticket button comes from the event’s own link (ticketsOf); none means not on sale yet', () => {
  assert.equal(ticketsOf({ ticketUrl: ' https://www.zeffy.com/ticketing/gala-2027 ' }), 'https://www.zeffy.com/ticketing/gala-2027');
  for (const bad of [undefined, '', '   ', 'www.zeffy.com/ticketing/x', 'https://www.zeffy.com/ticketing/x y', 'javascript:alert(1)']) assert.equal(ticketsOf({ ticketUrl: bad }), '', String(bad));
  for (const f of ['src/pages/events/gala.astro', 'src/pages/events/golf.astro', 'src/pages/events/[slug].astro', 'src/pages/index.astro', 'src/pages/events/index.astro', 'src/components/events/EventCard.astro']) {
    const src = read(f);
    assert.match(src, /ticketsOf\(/, `${f} asks ticketsOf`);
    assert.doesNotMatch(src.replace(/ticketUrl\?: string;/, ''), /\.ticketUrl\b/, `${f} never reads ticketUrl itself`);
  }
  for (const [f, v] of [['src/pages/events/gala.astro', 'TICKETS'], ['src/pages/events/golf.astro', 'ZEFFY']]) {
    const src = read(f);
    assert.match(src, new RegExp(`\\.\\.\\.\\(${v} && \\{\\s*(//[^\\n]*\\n\\s*)?"offers"`), `${f}: schema offers only while on sale`);
    assert.doesNotMatch(src, /validFrom/, `${f}: no made-up sale dates`);
    for (const m of src.matchAll(new RegExp(`href=\\{${v}\\}`, 'g'))) {
      const before = src.slice(Math.max(0, m.index - 300), m.index);
      assert.match(before, new RegExp(`\\{${v} (\\?|&&)|linked|hasSticky`), `${f}: a ${v} link only when there is one`);
    }
  }
  const gala = read('src/pages/events/gala.astro');
  assert.match(gala, /\{TICKETS \? 'Reserve Your Seat' : 'See Tables & Tickets'\}/, 'the hero doesn’t ask to buy before the sale');
  assert.match(gala, /const isSoldOut = !!TICKETS && tier\.status === 'sold-out';/, 'last year’s Sold Out doesn’t show before the sale');
  assert.match(gala, /<p class="gv-tickets__soon">Tickets go on sale soon\.<\/p>/);
  assert.match(gala, /const hasSticky = auctionOpen \|\| !!TICKETS;/);
  const golf = read('src/pages/events/golf.astro');
  assert.match(golf, /\{ZEFFY \? 'Register' : 'See the Packages'\}/);
  assert.match(golf, /<p class="ev-tickets__soon">Registration opens soon\.<\/p>/);
  assert.match(golf, /'ev-has-sticky': !!ZEFFY/, 'no room kept for a sticky bar that isn’t there');
});
