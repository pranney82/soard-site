/**
 * Admin → Site Config → Zeffy: every Zeffy link on the site in one place.
 * The site's own forms (public/admin/zeffy-links.js siteForm, embedOf, withParam) as the Donate page, the live reveal
 * and the gala and golf pages read them; Site Config's page map for the records it edits (site-config-shared.js);
 * the Advisory Board route's light read (?zeffyLinks=1); and no page keeping a Zeffy form's link of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_FORMS, siteForm, embedOf, withParam, zeffyKey } from '../public/admin/zeffy-links.js';
import * as S from '../public/admin/site-config-shared.js';

const ROOT = new URL('..', import.meta.url).pathname;

test('a page uses the saved form, or the one it always had while none is saved or the saved one isn’t a Zeffy form', () => {
  assert.equal(siteForm({}, 'donateUrl'), 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home');
  assert.equal(siteForm({ zeffy: {} }, 'monthlyUrl'), 'https://www.zeffy.com/en-US/donation-form/soard-monthly-builders');
  assert.equal(siteForm({ zeffy: { liveUrl: ' https://www.zeffy.com/donation-form/new-one ' } }, 'liveUrl'), 'https://www.zeffy.com/donation-form/new-one');
  for (const bad of ['', '   ', 'www.zeffy.com/en-US/donation-form/x', 'https://example.com/give', 'javascript:alert(1)', 'http://www.zeffy.com/en-US/donation-form/x', 'https://www.zeffy.com/']) {
    assert.equal(siteForm({ zeffy: { donateUrl: bad } }, 'donateUrl'), SITE_FORMS.donateUrl, JSON.stringify(bad));
  }
  assert.equal(siteForm(null, 'donateUrl'), SITE_FORMS.donateUrl);
  for (const u of Object.values(SITE_FORMS)) assert.ok(zeffyKey(u), u);
});

test('Zeffy’s embed of a form, whatever language, www or query the link has; nothing for a link that isn’t a form', () => {
  assert.equal(embedOf('https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home'), 'https://www.zeffy.com/embed/donation-form/help-build-a-brighter-home');
  assert.equal(embedOf('https://zeffy.com/fr-CA/ticketing/Gala-2027?utm_source=x#top'), 'https://www.zeffy.com/embed/ticketing/Gala-2027', 'keeps the form’s case');
  assert.equal(embedOf('https://www.zeffy.com/embed/donation-form/abc'), 'https://www.zeffy.com/embed/donation-form/abc');
  assert.equal(embedOf('https://www.zeffy.com/donation-form/3f1c2d4e-0000-4000-8000-000000000000'), 'https://www.zeffy.com/embed/donation-form/3f1c2d4e-0000-4000-8000-000000000000', 'a link as Zeffy’s API gives it');
  for (const no of ['', 'https://example.com/donation-form/x', 'https://www.zeffy.com/', 'zeffy.com/en-US/donation-form/x']) assert.equal(embedOf(no), '', JSON.stringify(no));
});

test('an amount goes into the link’s query, beside whatever is there', () => {
  assert.equal(withParam('https://www.zeffy.com/en-US/donation-form/x', 'amount', 500), 'https://www.zeffy.com/en-US/donation-form/x?amount=500');
  assert.equal(withParam('https://www.zeffy.com/en-US/donation-form/x?utm_source=fb', 'amount', 60), 'https://www.zeffy.com/en-US/donation-form/x?utm_source=fb&amount=60');
  assert.equal(withParam('https://www.zeffy.com/en-US/donation-form/x?amount=1', 'amount', 60), 'https://www.zeffy.com/en-US/donation-form/x?amount=60');
  assert.equal(withParam('not a link', 'amount', 5), 'not a link');
});

test('Site Config’s Zeffy page: the settings’ forms, kids’ and events’ links and the Advisory Board’s, nothing else of them', () => {
  const page = S.pageByKey('zeffy');
  assert.equal(page.group, 'site');
  assert.equal(S.docPath('kids/peter'), 'src/content/kids/peter.json');
  assert.equal(S.docPath('events/2026-evening-of-sunshine'), 'src/content/events/2026-evening-of-sunshine.json');
  assert.equal(S.docPath('settings'), 'src/content/site/settings.json');
  assert.equal(S.pageOf('settings', 'zeffy.donateUrl').key, 'zeffy');
  assert.equal(S.pageOf('kids/peter', 'fundraisingUrl').key, 'zeffy');
  assert.equal(S.pageOf('events/golf', 'ticketUrl').key, 'zeffy');
  assert.equal(S.pageOf('@advisory', 'hosted.h1.giveUrl').key, 'zeffy');
  assert.equal(S.pageOf('kids/peter', 'bio'), null, 'a kid’s other fields are the Kids editor’s');
  const docs = {
    settings: { base: { name: 'SOARD' }, edit: { name: 'SOARD', zeffy: { donateUrl: 'https://www.zeffy.com/en-US/donation-form/x' } } },
    'kids/peter': { base: { name: 'Peter', fundraisingUrl: null, bio: 'a' }, edit: { name: 'Peter', fundraisingUrl: 'https://www.zeffy.com/en-US/donation-form/p', bio: 'b' } },
    'events/gala': { base: { title: 'Gala', ticketUrl: '' }, edit: { title: 'Gala!', ticketUrl: '' } },
    '@advisory': { base: { campaignUrl: '', campaignId: '' }, edit: { campaignUrl: 'https://www.zeffy.com/en-US/peer-to-peer/a', campaignId: 'c1' } },
  };
  assert.deepEqual(S.pageChanges(page, docs), [
    { doc: 'settings', path: 'zeffy' }, { doc: 'kids/peter', path: 'fundraisingUrl' }, { doc: '@advisory', path: 'campaignUrl' }, { doc: '@advisory', path: 'campaignId' },
  ]);
  assert.deepEqual(S.pageChanges(S.pageByKey('donate'), docs), [], 'the Donate page’s own photos and questions only');
  // A kid's link laid over a fresh copy leaves everything else of theirs as it is now
  const fresh = { name: 'Peter', fundraisingUrl: null, bio: 'someone else’s new bio', photos: [1, 2] };
  const { next, conflicts } = S.mergeForSave({ name: 'Peter', fundraisingUrl: null }, { name: 'Peter', fundraisingUrl: 'https://www.zeffy.com/x' }, fresh);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(next, { ...fresh, fundraisingUrl: 'https://www.zeffy.com/x' });
});

test('no public page keeps a Zeffy form’s link of its own: they come from Site Config → Zeffy or the event', () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(astro|ts|js)$/.test(f)) files.push(p); } };
  walk(join(ROOT, 'src/pages'));
  walk(join(ROOT, 'src/components'));
  walk(join(ROOT, 'src/utils'));
  const hits = files.filter((f) => /zeffy\.com\/(?:[a-z]{2}(?:-[A-Za-z0-9]{2,4})?\/|embed\/)?(?:donation-form|ticketing|peer-to-peer|o\/fundraising)/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => f.slice(ROOT.length)), []);
  const donate = readFileSync(join(ROOT, 'src/pages/donate.astro'), 'utf8');
  // Every gift link opens its own form's embed: a one-time link the one-time form's, a monthly link the monthly's
  const gifts = [...donate.matchAll(/<a [^>]*href=\{(ZEFFY_ONETIME|once\(\d+\)|ZEFFY_MONTHLY|monthly\(\d+\))\}[^>]*>/g)];
  assert.ok(gifts.length >= 13, `the Donate page’s gift links (${gifts.length})`);
  for (const [tag, href] of gifts) assert.match(tag, new RegExp(`data-zeffy=\\{${/ONETIME|once/.test(href) ? 'ONETIME' : 'MONTHLY'}_EMBED\\}`), tag);
  assert.doesNotMatch(donate, /<a [^>]*data-zeffy(?!=)/, 'no link with a bare data-zeffy left');
  assert.match(readFileSync(join(ROOT, 'src/components/live/LiveGive.astro'), 'utf8'), /siteForm\(siteSettings, 'liveUrl'\)/);
  // An event with no link of its own has no ticket buttons: never last year's form
  for (const [f, v] of [['src/pages/events/gala.astro', 'TICKETS'], ['src/pages/events/golf.astro', 'ZEFFY']]) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, new RegExp(`const ${v}: string = String\\(ev\\.ticketUrl \\|\\| ''\\)\\.trim\\(\\);`), f);
    for (const m of src.matchAll(new RegExp(`<a href=\\{${v}\\}`, 'g'))) {
      const before = src.slice(Math.max(0, m.index - 260), m.index);
      assert.match(before, new RegExp(`\\{${v} (\\?|&&)|linked|\\(auctionOpen \\|\\| ${v}\\) &&`), `${f}: a ${v} link only when there is one`);
    }
  }
});

test('one Zeffy link field everywhere: every screen that takes a Zeffy link uses ZeffyLink, none builds its own', () => {
  const files = ['public/admin/index.html', 'public/admin/site-config.js', 'public/admin/event-recap-admin.js', 'public/admin/advisory-admin.js'];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(/<\$\{ZeffyLink\}/.test(src), `${f} uses ZeffyLink`);
    assert.doesNotMatch(src, /ZeffyFormSelect/, `${f} doesn’t build its own dropdown and box`);
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'public/admin/zeffy-forms.js'), 'utf8'), /export function ZeffyFormSelect/, 'the dropdown alone isn’t offered');
});

test('the Advisory Board route gives Site Config only the campaign and approved fundraisers’ pages', async () => {
  const src = readFileSync(join(ROOT, 'functions/api/advisory-admin.js'), 'utf8');
  const at = src.indexOf("searchParams.get('zeffyLinks')");
  assert.ok(at > 0 && at > src.indexOf('const { w, refused } = await gate(context);'), 'after the gate: only the people who run the group');
});
