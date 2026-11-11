/**
 * The live page's reminder block (#remind) goes out drawn: the server (functions/live/[[path]].js, addRemind) and
 * the page script (LivePage.astro) draw it by the same rules (src/utils/live-hero-text.ts, remindParts and
 * remindWords), so nothing below the hero moves when the script starts and a link to #remind lands on the form.
 * Node has no HTMLRewriter: a stand-in records the handlers, and they run on stand-in elements.
 * Run: node --test tests/live-remind.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const load = (entry) => import(`data:text/javascript,${encodeURIComponent(buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].text)}#${Math.random()}`);
const { remindParts, remindWords } = await load('src/utils/live-hero-text.ts');
const { remindFirstPaint, addRemind } = await load('functions/live/[[path]].js');
const { remindPromise } = await load('src/utils/live-banner.ts');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const EMAIL = { enabled: true, hours: [24, 1], email: true, push: false, pushKey: null };
const OFF = { enabled: false, hours: [24, 1], email: true, push: false, pushKey: null };
const PUSH_ONLY = { enabled: true, hours: [24, 1], email: false, push: true, pushKey: 'k' };
const max = { slug: 'max', name: 'Max', confirmed: true, date: '2026-11-20', time: '16:00', startsAt: '2026-11-20T21:00:00.000Z', liveUrl: '/live/max/', window: null, rooms: [] };
const facts = (o) => ({ reminders: EMAIL, canPush: true, view: 'idle', pageKid: '', scheduledAt: null, kidName: '', kidSlug: '', now: NOW, ...o });

test('between reveals on /live/: every reveal, by email', () => {
  const p = remindParts(facts({}));
  assert.deepEqual({ on: p.on, email: p.email, push: p.push, calendar: p.calendar, block: p.block, label: p.label, name: p.name, slug: p.slug }, { on: true, email: true, push: false, calendar: false, block: true, label: 'Reminders', name: '', slug: '' });
  const w = remindWords(p, { shown: '', scope: 'all', hours: [24, 1], view: 'idle', now: NOW });
  assert.equal(w.heading, 'Never miss a reveal');
  assert.equal(w.scopeShown, false);
  assert.equal(w.emailLabel, 'Email address for every reveal');
  assert.equal(w.leadAll, remindPromise([24, 1], { about: 'every reveal' }));
  assert.equal(w.remindHere, true, 'the band leaves its email card out');
});

test('a child\'s page between reveals names them, with their day on the calendar link', () => {
  const p = remindParts(facts({ pageKid: 'max', inviteFor: max }));
  assert.equal(p.name, 'Max');
  assert.equal(p.slug, 'max');
  assert.equal(p.calendar, true);
  assert.equal(p.planned, max.startsAt);
  const w = remindWords(p, { shown: 'Max', scope: 'all', hours: [24, 1], view: 'idle', now: NOW });
  assert.equal(w.heading, "Don't miss Max's reveal");
  assert.equal(w.scopeShown, true);
  assert.equal(w.scopeOne, "Just Max's");
  assert.equal(w.leadAll, remindPromise([24, 1], { about: "every reveal, Max's included" }));
  assert.equal(w.leadOne, remindPromise([24, 1], { about: "Max's reveal", dated: true, left: Date.parse(max.startsAt) - NOW }));
  // Picking just theirs: the form is for them, and the band's card stays
  const one = remindWords(p, { shown: 'Max', scope: 'one', hours: [24, 1], view: 'idle', now: NOW });
  assert.equal(one.emailLabel, "Email address for Max's reveal");
  assert.equal(one.scope, 'one');
  assert.equal(one.remindHere, false);
});

test('reminders off: the block is just the calendar link, or nothing with no date to add', () => {
  const dated = remindParts(facts({ reminders: OFF, pageKid: 'max', inviteFor: max }));
  assert.equal(dated.block, true);
  assert.equal(dated.email, false);
  assert.equal(dated.label, 'Calendar');
  assert.equal(remindWords(dated, { shown: 'Max', scope: 'all', view: 'idle' }).heading, "Save the date for Max's reveal");
  assert.equal(remindParts(facts({ reminders: OFF })).block, false);
  assert.equal(remindParts(facts({ reminders: null })).block, false, 'not known: off');
});

test('a planned reveal names its child until it begins; alerts only where the browser takes them', () => {
  const up = remindParts(facts({ view: 'upcoming', scheduledAt: '2026-11-18T21:00:00Z', kidName: 'Dylan', kidSlug: 'dylan-2026' }));
  assert.deepEqual([up.name, up.slug, up.calendar], ['Dylan', 'dylan-2026', true]);
  assert.equal(remindParts(facts({ view: 'upcoming', scheduledAt: '2026-11-11T14:00:00Z', kidName: 'Dylan', kidSlug: 'dylan-2026' })).calendar, false, 'begun: no calendar link');
  assert.equal(remindParts(facts({ reminders: PUSH_ONLY })).push, true);
  assert.equal(remindParts(facts({ reminders: PUSH_ONLY, canPush: false })).block, false, 'alerts only, and this browser can\'t: nothing to sign up for');
  assert.equal(remindWords(remindParts(facts({ view: 'replay' })), { shown: '', scope: 'all', view: 'replay' }).heading, 'Hear about the next reveal');
});

test('the server\'s first paint: the child the block names, every reveal picked, their day on the calendar link', () => {
  const first = remindFirstPaint(facts({ pageKid: 'max', inviteFor: max }));
  assert.equal(first.words.heading, "Don't miss Max's reveal");
  assert.equal(first.words.scope, 'all');
  assert.equal(first.invite['data-invite'], 'max');
  assert.match(first.invite.href, /\?kid=max/);
  assert.deepEqual(remindFirstPaint(facts({})).invite, { href: '/api/reminders?ics=1' });
});

/** An element as HTMLRewriter hands it over */
class El {
  constructor(attrs = {}) { this.attrs = new Map(Object.entries(attrs)); this.text = null; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  hasAttribute(n) { return this.attrs.has(n); }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  setInnerContent(c) { this.text = c; }
}

test('addRemind writes the block into the page as the script would leave it', () => {
  const handlers = [];
  globalThis.HTMLRewriter = class { on(sel, h) { handlers.push([sel, h]); return this; } transform(res) { return res; } };
  try {
    const page = new Response('<html></html>', { headers: { 'content-type': 'text/html', ETag: '"b"' } });
    const out = addRemind(page, remindFirstPaint(facts({ pageKid: 'max', inviteFor: max })));
    assert.equal(out.headers.get('Cache-Control'), 'private, max-age=30');
    assert.equal(out.headers.get('ETag'), null);
    const el = (sel, attrs) => { const e = new El(attrs); for (const [s, h] of handlers) if (s === sel) h.element(e); return e; };
    assert.equal(el('[data-live="remind-block"]', { hidden: '' }).hasAttribute('hidden'), false);
    assert.equal(el('[data-live="remind-heading"]').text, "Don't miss Max's reveal");
    assert.equal(el('[data-live="remind-label"]').text, 'Reminders');
    const lead = el('[data-live="remind-lead"]', { hidden: '' });
    assert.equal(lead.hasAttribute('hidden'), false);
    assert.equal(lead.getAttribute('data-scope'), 'all');
    assert.equal(el('[data-live="remind-lead"] [data-lead="one"]').getAttribute('aria-hidden'), 'true');
    assert.equal(el('[data-live="remind-scope"]', { hidden: '' }).hasAttribute('hidden'), false);
    assert.equal(el('[data-live="scope-one"]').text, "Just Max's");
    assert.equal(el('[data-live="form-email"]', { hidden: '' }).hasAttribute('hidden'), false);
    assert.equal(el('[data-live="push-btn"]', { hidden: '' }).hasAttribute('hidden'), true);
    const cal = el('[data-live="calendar-link"]', { href: '/api/reminders?ics=1' });
    assert.equal(cal.hasAttribute('hidden'), false);
    assert.equal(cal.getAttribute('data-invite'), 'max');
    assert.match(cal.getAttribute('href'), /\?kid=max/);
    assert.equal(el('#live-hero [data-live="cta-calendar"]').getAttribute('data-invite'), 'max');
    assert.equal(el('.live-next [data-upnext]').getAttribute('data-remind-here'), '');
  } finally { delete globalThis.HTMLRewriter; }
});

test('the page script draws the block by the same rules', () => {
  const live = readFileSync('src/components/live/LivePage.astro', 'utf8');
  assert.match(live, /const parts = remindParts\(\{/);
  assert.match(live, /const words = remindWords\(parts, \{ shown: remindShown, scope: remindKid \? 'one' : 'all', hours: meta\.reminders\?\.hours, view \}\);/);
  assert.match(readFileSync('functions/api/_broadcast.js', 'utf8'), /reminders: publicReminders\(config, env\),/, '/api/broadcast and the server\'s first paint read the options one way');
});
