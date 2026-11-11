/**
 * Every Zeffy link, one way: the shared rules in public/admin/zeffy-links.js (what a link is, what's wrong with one,
 * its page and embed, the site's own forms, gift links, DAF), the shared field's check (zeffy-forms.js linkProblem),
 * Site Config's page map for the records it edits, the Advisory Board's routes for it, and that every save stores a
 * link the way it was checked. The public pages' own checks are in ./zeffy-pages.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Z from '../public/admin/zeffy-links.js';
import { fieldState, formGroups, campaignNote } from '../public/admin/zeffy-forms.js';
import * as S from '../public/admin/site-config-shared.js';
import { HISTORY_TABLES } from '../functions/api/_content-history.js';
import { createD1 } from './lib/d1-shim.mjs';
import { ensureAdvisory, requestHost, setHosted, setHostedLink, listHosted } from '../functions/api/_advisory.js';

const ROOT = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

test('what’s wrong with a typed link, in the words every field shows', () => {
  const P = Z.zeffyLinkProblem;
  assert.equal(P(''), null, 'empty is fine where a link is optional');
  assert.equal(P('  ', { required: true }), 'Pick a Zeffy form');
  assert.equal(P('https://www.zeffy.com/x y'), 'Take the spaces out of the link');
  assert.equal(P('www.signupgenius.com/go/cookie swap'), 'Take the spaces out of the link');
  assert.equal(P('signupgenius.com/go/cookie swap'), 'Take the spaces out of the link');
  assert.equal(P('Sign up at the front desk'), 'That isn’t a link: paste the whole link, starting with https://', 'words aren’t a link with spaces in it');
  assert.equal(P('www.zeffy.com/x'), 'Paste the whole link, starting with https://');
  assert.equal(P('http://www.zeffy.com/x'), 'Paste the whole link, starting with https://');
  assert.equal(P('https://zeffy'), 'That isn’t a whole web address');
  assert.equal(P('https://example.org/give'), null, 'an event’s sign-up sheet can be any whole web address');
  assert.equal(P('https://example.org/give', { zeffyOnly: true }), 'Use a Zeffy form’s link (zeffy.com)');
  assert.equal(P('https://www.zeffy.com/', { zeffyOnly: true }), 'Use a Zeffy form’s link (zeffy.com)', 'Zeffy’s home page isn’t a form');
  assert.equal(P(' https://www.zeffy.com/en-US/donation-form/x ', { required: true, zeffyOnly: true }), null);
});

test('a link typed without its https:// gets it; anything else stays as typed', () => {
  assert.equal(Z.finishLink(' www.zeffy.com/donation-form/x '), 'https://www.zeffy.com/donation-form/x');
  assert.equal(Z.finishLink('zeffy.com/x'), 'https://zeffy.com/x');
  assert.equal(Z.finishLink('https://www.zeffy.com/x'), 'https://www.zeffy.com/x');
  assert.equal(Z.finishLink('mailto:give@soard.org'), 'mailto:give@soard.org');
  assert.equal(Z.finishLink('zeffy dot com'), 'zeffy dot com', 'not a web address: left for the check to name');
  assert.equal(Z.finishLink(null), '');
});

test('what a Zeffy field says is what Save checks: a link set now that won’t do blocks; one saved earlier, or a form Zeffy closed or deleted, warns', () => {
  const forms = [
    { id: 't', title: 'Gala', url: 'https://www.zeffy.com/ticketing/gala', kind: 'tickets', open: true },
    { id: 'd', title: 'Give', url: 'https://www.zeffy.com/donation-form/give', kind: 'donation', open: true },
    { id: 'c', title: 'Spring', url: 'https://www.zeffy.com/donation-form/spring', kind: 'donation', open: false },
    { id: 'e', title: 'Golf 2026', url: 'https://www.zeffy.com/ticketing/golf-2026', kind: 'tickets', open: false, ended: true },
  ];
  const F = (v, o = {}) => fieldState(v, { forms, ...o });
  assert.deepEqual(F('', { required: true }), { problem: 'Pick a Zeffy form', warning: null });
  assert.deepEqual(F(''), { problem: null, warning: null }, 'an optional field with no link: nothing to say');
  assert.deepEqual(F('https://www.zeffy.com/en-US/donation-form/give', { only: ['donation'] }), { problem: null, warning: null });
  // Set now: blocks. Saved earlier: warns, never stopping the rest of the page
  const tickets = 'Pick a form from “Donation forms”: this one is in “Events and tickets”';
  assert.deepEqual(F('https://www.zeffy.com/ticketing/gala', { only: ['donation'] }), { problem: tickets, warning: null });
  assert.deepEqual(F('https://www.zeffy.com/ticketing/gala', { only: ['donation'], saved: 'https://www.zeffy.com/ticketing/gala' }), { problem: null, warning: tickets });
  assert.deepEqual(F(' https://www.zeffy.com/ticketing/gala ', { only: ['donation'], saved: 'https://www.zeffy.com/ticketing/gala' }), { problem: null, warning: tickets }, 'spaces at either end don’t make it another link');
  assert.deepEqual(F('https://www.zeffy.com/ticketing/gala', { only: ['donation'], saved: 'https://www.zeffy.com/donation-form/x' }), { problem: tickets, warning: null }, 'one set now blocks');
  assert.deepEqual(F('https://www.zeffy.com/ticketing/gala', { only: ['donation'], saved: 'https://www.zeffy.com/ticketing/gala', required: true }), { problem: tickets, warning: null }, 'a required one always');
  assert.deepEqual(F('https://example.org/give'), { problem: 'What’s saved isn’t a Zeffy form: pick one', warning: null });
  assert.deepEqual(F('https://example.org/give', { saved: 'https://example.org/give' }), { problem: null, warning: 'What’s saved isn’t a Zeffy form: pick one' });
  // Another site's link: one set now is judged with the https:// the field puts on; one saved earlier, as it's saved
  assert.deepEqual(F('www.eventbrite.com/e/1', { elsewhere: true }), { problem: null, warning: null }, 'set now: it gets its https://');
  assert.deepEqual(F('www.eventbrite.com/e/1', { elsewhere: true, saved: 'www.eventbrite.com/e/1' }), { problem: null, warning: 'Paste the whole link, starting with https://' }, 'saved that way: it’s said, as the page can’t use it');
  assert.deepEqual(F('Tickets at the door ', { elsewhere: true, saved: 'Tickets at the door' }), { problem: null, warning: 'That isn’t a link: paste the whole link, starting with https://' }, 'a space at the end of a saved one isn’t a change');
  assert.deepEqual(F('http://www.zeffy.com/donation-form/give'), { problem: 'What’s saved isn’t a whole link: pick the form again', warning: null });
  // An event may sell on another site: any whole link, in the words a link box uses
  assert.deepEqual(F('https://www.signupgenius.com/go/x', { elsewhere: true }), { problem: null, warning: null });
  assert.deepEqual(F('signupgenius/x', { elsewhere: true }), { problem: 'Paste the whole link, starting with https://', warning: null });
  assert.deepEqual(F('https://www.signupgenius.com/go/x y', { elsewhere: true }), { problem: 'Take the spaces out of the link', warning: null });
  // Zeffy changed, not the person: always a warning
  assert.deepEqual(F('https://www.zeffy.com/donation-form/spring', { required: true }), { problem: null, warning: 'That form has closed in Zeffy: pick an open one' });
  assert.deepEqual(F('https://www.zeffy.com/ticketing/golf-2026'), { problem: null, warning: 'That form has ended in Zeffy: pick an open one' });
  assert.deepEqual(F('https://www.zeffy.com/donation-form/deleted'), { problem: null, warning: 'That form isn’t in SOARD’s Zeffy any more: pick another' });
  assert.deepEqual(fieldState('https://www.zeffy.com/donation-form/deleted', { forms: null }), { problem: null, warning: null }, 'without the list, nothing is said about it');
  const { groups } = formGroups(forms, { only: ['donation'] });
  assert.deepEqual(groups.map((g) => g.kind), ['donation'], 'a field that takes donation forms lists only those');
  assert.deepEqual(formGroups(forms, { only: ['donation'], value: 'https://www.zeffy.com/ticketing/gala' }).groups.map((g) => g.kind).sort(), ['donation', 'tickets'], 'except the form its link already goes to, so it shows');
});

test('the Advisory Board’s campaign says where it stands, the same on Site Config and the advisors’ page', () => {
  const forms = [{ id: 'c1', title: 'Spring drive', url: 'https://www.zeffy.com/peer-to-peer/spring' }];
  const saved = { url: 'https://www.zeffy.com/peer-to-peer/spring', id: 'c1' };
  assert.equal(campaignNote({ url: '', id: '' }, saved, forms), 'Not connected: nothing counts toward the goal until a campaign is picked.');
  assert.equal(campaignNote(saved, saved, forms), 'Connected: what it raises counts toward the goal.');
  assert.equal(campaignNote({ url: saved.url, id: '' }, { url: saved.url, id: '' }, forms), 'Not connected yet: pick it again to connect it now.', 'a listed form saved without its ID: one pick connects it');
  assert.equal(campaignNote({ url: saved.url, id: '' }, { url: saved.url, id: '' }, null), 'Saved, but Zeffy hasn’t said which campaign this is yet. The site asks again every 15 minutes.');
  assert.equal(campaignNote({ url: saved.url, id: 'c1' }, { url: '', id: '' }, forms), '“Spring drive”: connected when you save.');
});

test('a saved form’s page and embed: its own path, lower case, no language, its query kept but an amount', () => {
  assert.deepEqual(Z.formLinks('https://www.zeffy.com/en-US/donation-form/A-Brighter-Day?amount=25&utm_source=site'), { page: 'https://www.zeffy.com/donation-form/a-brighter-day?utm_source=site', embed: 'https://www.zeffy.com/embed/donation-form/a-brighter-day?utm_source=site' });
  assert.deepEqual(Z.formLinks('https://zeffy.com/embed/fr-CA/ticketing/gala-2027#x'), { page: 'https://www.zeffy.com/ticketing/gala-2027', embed: 'https://www.zeffy.com/embed/ticketing/gala-2027' }, 'a saved embed link still gives the page');
  assert.equal(Z.formLinks('https://example.org/x'), null);
  assert.equal(Z.embedOf('https://www.zeffy.com/donation-form/x'), 'https://www.zeffy.com/embed/donation-form/x');
  assert.equal(Z.zeffyKey('https://www.zeffy.com/en-US/Donation-Form/X'), 'donation-form/x', 'the key and the links read a link one way');
});

test('the site’s forms are only Site Config’s: none in code, and a page without one stops the build saying what to do', () => {
  assert.equal('SITE_FORMS' in Z, false, 'no form links kept in code');
  assert.deepEqual(Z.SITE_FORM_KEYS, ['donateUrl', 'monthlyUrl', 'liveUrl']);
  const st = { zeffy: { donateUrl: 'https://www.zeffy.com/donation-form/a', monthlyUrl: 'https://example.org/monthly', liveUrl: 'http://www.zeffy.com/donation-form/a' } };
  assert.equal(Z.siteForm(st, 'donateUrl'), 'https://www.zeffy.com/donation-form/a');
  assert.equal(Z.siteForm(st, 'monthlyUrl'), '', 'a saved link that isn’t a Zeffy form is no form, never swapped for another');
  assert.equal(Z.siteForm(st, 'liveUrl'), '');
  assert.equal(Z.siteForm(null, 'donateUrl'), '');
  assert.throws(() => Z.requireSiteForm(st, 'monthlyUrl'), /The Donate page’s monthly gifts has no Zeffy form: pick one in Admin → Site Config → Zeffy \(settings\.zeffy\.monthlyUrl\), then publish\./);
  assert.throws(() => Z.giftLink({}, 'liveUrl'), /The live reveal’s “Fund the next room” has no Zeffy form/);
});

test('a gift button’s link and embed come together, at its amount; DAF only when the form takes it', () => {
  const st = { zeffy: { donateUrl: 'https://www.zeffy.com/en-US/donation-form/a?amount=5', monthlyUrl: 'https://www.zeffy.com/donation-form/m', liveUrl: 'https://www.zeffy.com/donation-form/a', daf: true } };
  assert.deepEqual(Z.giftLink(st, 'donateUrl'), { href: 'https://www.zeffy.com/donation-form/a', 'data-zeffy': 'https://www.zeffy.com/embed/donation-form/a' }, 'Donate Now: no saved amount leaks in');
  assert.deepEqual(Z.giftLink(st, 'monthlyUrl', 25), { href: 'https://www.zeffy.com/donation-form/m?amount=25', 'data-zeffy': 'https://www.zeffy.com/embed/donation-form/m?amount=25' });
  assert.equal(Z.DAF_MIN_TEXT, '$1,000');
  assert.deepEqual(Z.dafGift(st), { href: 'https://www.zeffy.com/donation-form/a?amount=1000', 'data-zeffy': 'https://www.zeffy.com/embed/donation-form/a?amount=1000' });
  assert.equal(Z.dafGift({ zeffy: { ...st.zeffy, daf: false } }), null, 'off unless Site Config says the form takes it');
  assert.equal(Z.dafGift({ zeffy: { ...st.zeffy, daf: 'yes' } }), null, 'only true counts');
  assert.equal(Z.withParam('not a link', 'amount', 5), 'not a link');
});

test('Site Config’s Zeffy page: the settings’ forms, events’ links and the Advisory Board’s; a kid’s link stays in Kids', () => {
  const page = S.pageByKey('zeffy');
  assert.equal(page.group, 'site');
  assert.equal(S.docPath('kids/peter'), 'src/content/kids/peter.json');
  assert.equal(S.docPath('events/2026-evening-of-sunshine'), 'src/content/events/2026-evening-of-sunshine.json');
  assert.equal(S.docPath('settings'), 'src/content/site/settings.json');
  assert.equal(S.pageOf('settings', 'zeffy.donateUrl').key, 'zeffy');
  assert.equal(S.pageOf('kids/peter', 'fundraisingUrl'), null, 'a kid’s fundraising link is on their page in Kids, not here');
  assert.equal(S.pageOf('events/golf', 'ticketUrl').key, 'zeffy');
  assert.equal(S.pageOf('@advisory', 'hosted.h1.giveUrl').key, 'zeffy');
  assert.equal(S.pageOf('events/golf', 'title'), null, 'an event’s other fields are its editor’s');
  const docs = {
    settings: { base: { name: 'SOARD' }, edit: { name: 'SOARD', zeffy: { donateUrl: 'https://www.zeffy.com/en-US/donation-form/x' } } },
    'kids/peter': { base: { name: 'Peter', fundraisingUrl: null, bio: 'a' }, edit: { name: 'Peter', fundraisingUrl: 'https://www.zeffy.com/en-US/donation-form/p', bio: 'b' } },
    'events/gala': { base: { title: 'Gala', ticketUrl: '' }, edit: { title: 'Gala!', ticketUrl: '' } },
    '@advisory': { base: { campaignUrl: '', campaignId: '' }, edit: { campaignUrl: 'https://www.zeffy.com/en-US/peer-to-peer/a', campaignId: 'c1' } },
  };
  assert.deepEqual(S.pageChanges(page, docs), [
    { doc: 'settings', path: 'zeffy' }, { doc: '@advisory', path: 'campaignUrl' }, { doc: '@advisory', path: 'campaignId' },
  ]);
  assert.deepEqual(S.pageChanges(S.pageByKey('donate'), docs), [], 'the Donate page’s own photos and questions only');
  // An event's link laid over a fresh copy leaves everything else of it as it is now
  const fresh = { title: 'Gala', ticketUrl: '', description: 'someone else’s new words', photos: [1, 2] };
  const { next, conflicts } = S.mergeForSave({ title: 'Gala', ticketUrl: '' }, { title: 'Gala', ticketUrl: 'https://www.zeffy.com/x' }, fresh);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(next, { ...fresh, ticketUrl: 'https://www.zeffy.com/x' });
});

// The public pages' own checks (no page keeps a form link, gift links, DAF, ticket links) are in ./zeffy-pages.test.mjs

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
  const route = src('functions/api/advisory-admin.js');
  const at = route.indexOf("searchParams.get('zeffyLinks')");
  assert.ok(at > 0 && at > route.indexOf('const { w, refused } = await gate(context);'), 'after the gate: only the people who run the group');
  assert.match(route, /case 'hosted-link':/, 'a fundraiser’s page has its own action');
});

test('a fundraiser’s Zeffy page by itself: its status, date and note stay; only an approved one has one', async () => {
  const DB = await createD1();
  await ensureAdvisory(DB);
  const h = await requestHost(DB, 'dana', { title: 'Wine night' });
  await assert.rejects(() => setHostedLink(DB, h.id, 'https://www.zeffy.com/peer-to-peer/wine'), /Only an approved fundraiser/);
  await setHosted(DB, h.id, { status: 'approved', note: 'Go for it', date: '2026-12-05' });
  const after = await setHostedLink(DB, h.id, 'www.zeffy.com/peer-to-peer/wine', { by: 'peter@soardcharity.com' });
  assert.equal(after.giveUrl, 'https://www.zeffy.com/peer-to-peer/wine', 'the server finishes it too');
  assert.equal(after.status, 'approved');
  const [row] = (await listHosted(DB)).filter((x) => x.id === h.id);
  assert.equal(row.note, 'Go for it');
  assert.equal(row.date, '2026-12-05');
  await assert.rejects(() => setHostedLink(DB, 'h_nope', 'https://www.zeffy.com/x'), /gone/);
});

test('another site’s link gets its https:// when its box is left or as Save starts, in the field, so no page finishes links itself', () => {
  const field = src('public/admin/zeffy-forms.js');
  assert.match(field, /onBlur=\$\{\(\) => \{ setFocused\(false\); finish\(\); \}\}/, 'leaving the box finishes it');
  assert.match(field, /if \(!other \|\| !focused\) return undefined;\s*window\.addEventListener\('soard-before-save', finish\)/, 'so does a save started while typing in it, and only in that box');
  assert.match(field, /onInput=\$\{\(e\) => \{ typed\.current = true; change\(e\.currentTarget\.value\); \}\}/, 'nothing changes under the person while they type');
  assert.match(field, /if \(!moved && !typed\.current\) return;/, 'a saved link nobody touched is left as it is, even when its box is tabbed through');
  assert.match(field, /if \(elsewhere && changed && now && !zeffyKey\(now\)\) finish\(\);/, 'a link Discard or History puts there that isn’t the saved one is finished too');
  const admin = src('public/admin/index.html');
  assert.ok(admin.indexOf("new CustomEvent('soard-before-save')") > 0 && admin.indexOf("new CustomEvent('soard-before-save')") < admin.indexOf("setTimeout(() => window.dispatchEvent(new CustomEvent('soard-save')), 0)"), '⌘S lets fields finish first, then saves');
  for (const f of ['public/admin/index.html', 'public/admin/site-config.js', 'public/admin/advisory-admin.js', 'public/admin/kids-shared.js']) {
    assert.doesNotMatch(src(f), /finishLink|withTickets|finishTyped/, `${f} has no link-finishing of its own`);
  }
});

test('every page blocks Save with the field’s own rule, and nothing else', () => {
  for (const f of ['public/admin/index.html', 'public/admin/site-config.js', 'public/admin/advisory-admin.js']) {
    const code = src(f);
    assert.match(code, /fieldState\(/, `${f} checks with fieldState`);
    assert.doesNotMatch(code, /fieldState\([^\n]*\bchanged:/, `${f} gives fieldState the saved link, and works out no “changed” of its own`);
    // (Site Config's own S.linkProblem is for its other links, the hero buttons')
    assert.doesNotMatch(code, /(?<!S\.)\blinkProblem\(|zeffyFormsNow/, `${f} has no other Zeffy link check`);
  }
});

test('events keep history, so Site Config → Zeffy’s History covers the links it edits', () => {
  assert.equal(HISTORY_TABLES.events, 'events');
});
