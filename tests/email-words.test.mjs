/**
 * "Edit words": staff's own words in place of the site's in the emails it drafts
 * by itself, part by part, with every fact still the site's.
 * Run: node --test tests/email-words.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { EMAIL_WORDS, parseWordsKey, cleanWords, saveWords, readWords, wordsHash } from '../functions/api/_email-words.js';
import { revealInviteEmail } from '../functions/api/_reveal-invite-email.js';
import { projectKickoffEmail, projectRevealEmail } from '../functions/api/_project-email.js';
import { eventRecapEmail, monthlyImpactEmail } from '../functions/api/_newsletter-email.js';

const IMG = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const KID = {
  name: 'Rowan', slug: 'rowan-test', status: 'in-progress', year: 2027, roomTypes: ['Accessible Bathroom'], age: '9',
  heroImage: `${IMG}/kids/rowan-test/hero.jpg/public`, heroSummary: 'Rowan loves trains.',
  photos: ['hero', 'a', 'b', 'c'].map((n) => ({ url: `${IMG}/kids/rowan-test/${n}.jpg/public` })),
  fundraisingUrl: 'https://www.zeffy.com/en-US/donation-form/help-rowan',
};
const EVENT = { slug: 'kids-fest-2027', title: 'Kids Fest', date: '2027-04-06', location: 'Roswell Park', photos: Array.from({ length: 4 }, (_, i) => ({ id: `events/kf/${i}.jpg` })) };
/** A phrase as the email sets it: any space may be a no-break one, so a line never ends on one word */
const phrase = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '(?: |&nbsp;|\u00A0)'));
const BUILT = {
  invite: (words) => revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way, Atlanta, GA 30301', words }),
  watch: (words) => revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', watch: true, words }),
  kickoff: (words) => projectKickoffEmail({ kid: KID, words }),
  reveal: (words) => projectRevealEmail({ kid: { ...KID, status: 'completed' }, words }),
  recap: (words) => eventRecapEmail({ event: EVENT, events: [EVENT], words }),
  monthly: (words) => monthlyImpactEmail({ month: '2027-09', today: '2027-10-01', revealed: [{ kid: KID, date: '2027-09-22' }], words }),
};

test('the keys: one per email, nothing else gets in', () => {
  assert.deepEqual(parseWordsKey('invite:22PTestJob001'), { kind: 'invite', id: '22PTestJob001' });
  assert.deepEqual(parseWordsKey('reveal:remi-and-nico'), { kind: 'reveal', id: 'remi-and-nico' });
  assert.deepEqual(parseWordsKey('monthly:2027-09'), { kind: 'monthly', id: '2027-09' });
  for (const bad of ['', 'invite:../x', 'monthly:2027-13', 'kickoff:Rowan Test', 'press:x', 'recap:', 'watch:a b']) assert.equal(parseWordsKey(bad), null, bad);
});

test('what staff typed is cut to the email’s own parts: the invites have no give band, each part its length, one line but the opening', () => {
  assert.deepEqual(cleanWords('invite', { subject: '  Come  see\nRowan ', askHeadline: 'no band here', closing: '' }), { subject: 'Come see Rowan' });
  assert.equal(cleanWords('kickoff', { subject: 'x'.repeat(400) }).subject.length, 150);
  assert.equal(cleanWords('recap', { opening: 'One  line.\n\n\n\nTwo\nlines.' }).opening, 'One line.\n\nTwo\nlines.');
  assert.deepEqual(EMAIL_WORDS.watch.parts, ['subject', 'preview', 'opening', 'closing']);
  assert.equal(EMAIL_WORDS.monthly.parts.length, 6);
});

test('kept by email; none at all is the site’s own words again; the same words make the same hash', async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  assert.deepEqual(await readWords(DB, 'kickoff:rowan-test'), { words: {}, hash: '', by: null, at: null });
  const kept = await saveWords(DB, 'kickoff:rowan-test', { closing: 'Thanks!', subject: 'Meet Rowan' }, { by: 'linzi@soardcharity.com' });
  assert.equal(kept.hash, await wordsHash({ subject: 'Meet Rowan', closing: 'Thanks!' }), 'the order typed doesn’t matter');
  const read = await readWords(DB, 'kickoff:rowan-test');
  assert.deepEqual(read.words, { subject: 'Meet Rowan', closing: 'Thanks!' });
  assert.equal(read.by, 'linzi@soardcharity.com');
  assert.equal((await saveWords(DB, 'kickoff:rowan-test', { subject: '  ' })).hash, '');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM email_words').first()).n, 0, 'nothing kept for the site’s own words');
  await assert.rejects(saveWords(DB, 'nope:x', {}), /Not one of the emails/);
});

test('every email: no words is the site’s email exactly; each part staff fill takes the site’s place in the email and its text copy', () => {
  for (const [kind, build] of Object.entries(BUILT)) {
    const site = build();
    assert.deepEqual(build({}), site, `${kind}: empty words change nothing`);
    for (const k of EMAIL_WORDS[kind].parts) assert.ok(site.siteWords[k], `${kind}: the site’s own ${k}, for the box`);
    const words = { subject: `A subject for ${kind}`, preview: `A preview for ${kind}`, opening: `Our own *opening* for ${kind}, with **bold** and [a link](https://sunshineonaranneyday.com/kids/).`, askHeadline: 'Help us finish *this* one.', askWords: `Give words for ${kind}.`, closing: `Closing for ${kind}.` };
    const m = build(cleanWords(kind, words));
    assert.equal(m.subject, `A subject for ${kind}`);
    assert.equal(m.preview, `A preview for ${kind}`);
    assert.match(m.html, new RegExp(`Our own <em style="font-style:italic;color:#[0-9A-Fa-f]{6};">opening</em> for ${kind}, with <strong style="font-weight:700;">bold</strong> and <a href="https://sunshineonaranneyday.com/kids/"`));
    assert.ok(!m.html.includes(site.siteWords.opening.slice(0, 40)), `${kind}: the site’s opening is gone`);
    assert.match(m.html, phrase(`Closing for ${kind}.`));
    assert.match(m.text, new RegExp(`Our own opening for ${kind}, with bold and a link \\(https://sunshineonaranneyday.com/kids/\\)\\.`));
    assert.match(m.text, new RegExp(`Closing for ${kind}\\.`));
    assert.ok(!/\*/.test(m.text), `${kind}: no stars in the text copy`);
    if (EMAIL_WORDS[kind].parts.includes('askHeadline')) {
      assert.match(m.html, /Help us finish <em style="font-style:italic;">this<\/em>&nbsp;one\./, `${kind}: the give band headline, in the band’s own color`);
      assert.match(m.html, phrase(`Give words for ${kind}.`));
      assert.match(m.text, new RegExp(`Help us finish this one\\. Give words for ${kind}\\.`));
    } else {
      assert.ok(!m.html.includes('Help us finish'), `${kind}: no give band`);
    }
    // Facts stay the site's
    if (kind === 'invite') assert.match(m.html, phrase('100 Example Way'));
  }
});

test('typed words can’t carry HTML, and a rehearsal’s TEST mark stays on her subject', () => {
  const m = BUILT.kickoff(cleanWords('kickoff', { opening: '<script>alert(1)</script> Hi <b>there</b>', askHeadline: '<img src=x onerror=alert(1)>' }));
  assert.ok(!/<script>|<b>there|<img src=x/.test(m.html));
  assert.match(m.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const t = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', subjectPrefix: 'TEST · ', words: { subject: 'Come see Rowan' } });
  assert.equal(t.subject, 'TEST · Come see Rowan');
});
