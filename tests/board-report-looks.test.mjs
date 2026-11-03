// How a report shows on the meeting's screen, as its presenter chooses beside the editor: as it fits, cards, bullet
// points, paragraphs or big numbers (board-shared.js shownLook and the slides each takes, board-coach.js reportLooks,
// asBullets and the coach's word, board-md.js mdNumber), and the choice kept with the report (_board.js saveReport)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownLook, reportSlides, slidesOfItem, cleanMeeting, deckOf, CARDS_PER_SLIDE } from '../public/admin/board-shared.js';
import { reportLooks, reportAdvice, asBullets } from '../public/admin/board-coach.js';
import { mdNumber, mdPoints, mdBlocks, mdPlain, mdWords } from '../public/admin/board-md.js';

const pts = (n, words = 6) => Array.from({ length: n }, (_, i) => `- Point ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i} ${'word '.repeat(Math.max(0, words - 2)).trim()}`).join('\n');
const pointsOf = (md) => mdBlocks(md).flatMap((b) => (b.t === 'ul' || b.t === 'ol' ? b.items.map((it) => mdPlain(it[0].text)) : []));

test('as it fits: a few short points are cards, more are words; a chosen look holds while the words can take it', () => {
  assert.equal(shownLook(pts(4), ''), 'cards');
  assert.equal(shownLook(pts(8), ''), 'words', 'eight points are more than a slide of cards');
  assert.equal(shownLook(pts(8), 'cards'), 'cards', 'chosen: as many slides as they take');
  assert.equal(shownLook(pts(4), 'list'), 'words', 'bullet points or paragraphs: never cards');
  assert.equal(shownLook('A paragraph, as written. Two sentences.', 'cards'), 'words', 'cards for words that are no longer points: as it fits');
  assert.equal(shownLook('### A heading\n\n- one\n- two', 'cards'), 'words', 'a heading: not points only');
  assert.equal(shownLook('- 38 volunteers came\n- $412,000 raised', 'numbers'), 'numbers');
  assert.equal(shownLook('- 38 volunteers came\n- and a point without one', 'numbers'), 'cards', 'one point without a number: as it fits');
  assert.equal(shownLook(`- ${'long '.repeat(40)}\n- two`, 'cards'), 'words', 'a point longer than a card holds');
});

test('cards across slides: six a slide at most, as even as can be, two at least, every point in order, numbers going on', () => {
  for (let n = 2; n <= 30; n++) {
    for (const words of [2, 8, 20, 32]) {
      const md = pts(n, words);
      const slides = reportSlides(md, { look: 'cards' });
      const each = slides.map((s) => pointsOf(s).length);
      assert.deepEqual(slides.flatMap(pointsOf), pointsOf(md), `n=${n} w=${words}: every point, in order`);
      assert.ok(each.every((k) => k <= CARDS_PER_SLIDE), `n=${n} w=${words}: ${each}`);
      assert.ok(each.every((k) => k >= 2), `n=${n} w=${words}: never one alone (${each})`);
      assert.ok(Math.max(...each) - Math.min(...each) <= 1, `n=${n} w=${words}: even (${each})`);
      assert.ok(slides.every((s) => mdPoints(s, { all: true })), `n=${n} w=${words}: each slide is cards`);
    }
  }
  assert.deepEqual(reportSlides(pts(8), { look: 'cards' }).map((s) => pointsOf(s).length), [4, 4]);
  assert.deepEqual(reportSlides(pts(13), { look: 'cards' }).map((s) => pointsOf(s).length), [5, 4, 4]);
  // A numbered list goes on counting; the line before the points is on the first slide only
  const ol = Array.from({ length: 7 }, (_, i) => `${i + 1}. Item ${i + 1} here`).join('\n');
  const s = reportSlides(ol, { look: 'cards' });
  assert.equal(s.length, 2);
  assert.match(s[1], /^5\. Item 5 here/);
  const led = reportSlides(`The line before them.\n\n${pts(8)}`, { look: 'cards' });
  assert.match(led[0], /^The line before them\./);
  assert.ok(!led[1].includes('The line before them'));
  // As it fits, nothing changes: a short list is one slide, as written
  assert.deepEqual(reportSlides(pts(4), {}), [pts(4)]);
  assert.deepEqual(reportSlides(pts(4), { look: 'cards' }), [pts(4)]);
});

test('an item’s slides follow its look, and so does the deck', () => {
  const it = { id: 'i_gov1', title: 'Governance', who: ['tom-reed'], report: pts(8), reportLook: 'cards' };
  assert.equal(slidesOfItem(it).length, 2);
  assert.equal(slidesOfItem({ ...it, reportLook: '' }).length, 1);
  const m = cleanMeeting({ id: 'm_x1', date: '2099-11-05', sections: [{ id: 's_a1', title: 'Reports', items: [it, { id: 'i_two1', title: 'Store' }] }] });
  assert.equal(m.sections[0].items[0].reportLook, 'cards', 'kept with the item');
  const keys = deckOf(m).filter((x) => x.itemId === 'i_gov1').map((x) => x.key);
  assert.deepEqual(keys, ['i_gov1', 'i_gov1:report:1']);
  assert.equal(cleanMeeting({ sections: [{ items: [{ id: 'i_a1', title: 'x', reportLook: 'sparkles' }] }] }).sections[0].items[0].reportLook, '', 'only a look there is');
});

test('a big number: the figure that starts or ends a point said once, large; one in the middle stays in its words', () => {
  assert.deepEqual(mdNumber('38 volunteers built three porches.'), { fig: '38', runs: [{ text: 'volunteers built three porches' }], alone: true });
  assert.deepEqual(mdNumber('The gala brought in $412,000.'), { fig: '$412,000', runs: [{ text: 'The gala brought in' }], alone: true });
  const mid = mdNumber('We raised $412,000 at the gala');
  assert.equal(mid.fig, '$412,000');
  assert.equal(mid.alone, false);
  assert.equal(mid.runs.map((r) => r.text).join(''), 'We raised $412,000 at the gala');
  assert.equal(mdNumber('Up 35%').alone, false, 'one word left: the point whole');
  assert.equal(mdNumber('**22** families since 2013').fig, '22');
  assert.equal(mdNumber('No figure here, W-9 and Q4 aren’t one'), null);
});

test('paragraphs made bullet points keep every word; a line leading into a list stays over it', () => {
  const W = 'the committee met twice this quarter and read every application that came in while the store had its best month'.split(' ');
  for (let seed = 0; seed < 300; seed++) {
    const sentence = (k) => { const n = 3 + ((seed * 7 + k * 3) % 14); const w = Array.from({ length: n }, (_, i) => W[(seed + k * 5 + i) % W.length]); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(' ')}${k % 5 === 4 ? '!' : '.'}`; };
    const para = (k, n) => Array.from({ length: n }, (_, i) => sentence(k * 10 + i)).join(' ');
    const md = [para(1, 1 + (seed % 4)), seed % 3 ? `### Heading ${seed}` : '', para(2, 1 + (seed % 3)), seed % 2 ? '- a point\n- another' : '', para(3, 2)].filter(Boolean).join('\n\n');
    const out = asBullets(md);
    assert.ok(out, md);
    assert.equal(mdWords(out), mdWords(md), md);
    const flat = (x) => mdPlain(x).replace(/[•\s]/g, '');
    assert.equal(flat(out), flat(md), md);
    assert.ok(!mdBlocks(out).some((b) => b.t === 'p'), `no paragraph left: ${out}`);
  }
  assert.equal(asBullets('We met twice. We read 14 applications. We approved 9.'), '- We met twice.\n- We read 14 applications.\n- We approved 9.');
  assert.equal(asBullets('We finished the bylaws. Two changes come in February:\n\n- Terms of three years\n- The treasurer chairs finance\n\nThe audit starts in January.'), '- We finished the bylaws.\n\nTwo changes come in February:\n\n- Terms of three years\n- The treasurer chairs finance\n- The audit starts in January.');
  // (a short line before the only list is that list's own first line, over its cards: as it is)
  assert.equal(asBullets('We finished the bylaws. Two changes:\n\n- Terms of three years\n- The treasurer chairs finance'), 'We finished the bylaws. Two changes:\n\n- Terms of three years\n- The treasurer chairs finance');
  assert.equal(asBullets('### Bylaws\n\n1. First\n2. Second'), '### Bylaws\n\n1. First\n2. Second', 'headings and numbered lists as they were');
});

test('the ways a report can show: which it can take (and why not), the one showing, the one that reads best', () => {
  const ids = (l) => l.options.filter((o) => o.ok).map((o) => o.id).join(',');
  const short = reportLooks('- We met twice\n- Read 14 applications\n- Approved 9 families');
  assert.deepEqual([ids(short), short.on, short.best], ['cards,points', 'cards', 'cards'], '"twice" is no number: no big numbers');
  const nums = reportLooks('- 38 volunteers built porches\n- The gala brought in $412,000\n- 9 families approved this fall');
  assert.deepEqual([nums.on, nums.best], ['cards', 'numbers']);
  const prose = reportLooks('We met twice this quarter. We read 14 applications. We approved 9 families.');
  assert.deepEqual([ids(prose), prose.on, prose.best], ['cards,points,text', 'text', 'cards']);
  assert.ok(prose.options.find((o) => o.id === 'cards').md.startsWith('- We met twice'), 'cards from paragraphs: written as points');
  assert.equal(prose.options.find((o) => o.id === 'text').md, null, 'paragraphs: as written');
  const mixed = reportLooks('### Bylaws\nWe read the bylaws. Two changes come in February:\n\n- Terms move to three years\n- The treasurer chairs finance');
  assert.equal(ids(mixed), 'points,text');
  assert.match(mixed.options.find((o) => o.id === 'cards').why, /without headings/);
  const listed = reportLooks(pts(8), 'list');
  assert.equal(listed.on, 'points');
  assert.match(listed.options.find((o) => o.id === 'text').why, /all points/);
  assert.match(listed.options.find((o) => o.id === 'numbers').why, /number in every point/);
  assert.equal(reportLooks(''), null);
  assert.equal(reportLooks('Nothing new to report this time.'), null);
  assert.equal(reportLooks('One sentence.').offered, false, 'nothing to choose');
});

test('the coach suggests a look only where one can be chosen and none is; once one is, it says no more about it', () => {
  const prose = 'We met twice this quarter. We read 14 applications. We approved 9 families.';
  const a = reportAdvice(prose, { picks: true });
  assert.equal(a[0].id, 'look:cards');
  assert.equal(a[0].action.look, 'cards');
  assert.match(a[0].action.run(prose), /^- We met twice/);
  assert.ok(!reportAdvice(prose, { picks: false }).some((x) => x.id.startsWith('look:')), 'no picker (an email’s preview): no look to suggest');
  assert.deepEqual(reportAdvice(prose, { picks: true, look: 'list' }).map((x) => x.id), [], 'paragraphs chosen: no cards, no "make it points"');
  const nums = reportAdvice('- 38 volunteers built porches\n- The gala brought in $412,000', { picks: true });
  assert.equal(nums[0].id, 'look:numbers');
  assert.equal(nums[0].action.run, null, 'already points: only the look');
  // Cards over two slides were chosen as that: not "too long, a shorter version"
  assert.ok(!reportAdvice(pts(8), { slides: 2, look: 'cards', picks: true }).some((x) => x.id === 'shorter'));
  assert.ok(reportAdvice(`${'word '.repeat(400)}`, { slides: 2, picks: true }).some((x) => x.id === 'shorter'));
});

// ─── Kept with the report ───────────────────────────────────────────

import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, saveReport, getMeeting, liveView } from '../functions/api/_board.js';

async function world() {
  const env = { DB: await createD1() };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [slug, d] of [['kim-park', { name: 'Kim Park', group: 'board' }], ['jane-doe', { name: 'Jane Doe', group: 'team' }]]) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  await saveMeeting(env.DB, { id: 'm_look1', date: '2099-11-05', start: '08:00', end: '10:00', shared: true, sections: [{ id: 's_a1', title: 'Reports', items: [{ id: 'i_eve1', title: 'Events', who: ['kim-park'], presenter: 'Kim Park' }] }] }, { by: 'jane@soardcharity.com' });
  return env;
}
const KIM = { slug: 'kim-park', name: 'Kim Park', email: 'kim@example.org' };
const item = async (env) => (await getMeeting(env.DB, 'm_look1')).sections[0].items[0];

test('the look is saved with the report; changing only the look keeps who wrote it when, and is never a clash', async () => {
  const env = await world();
  const first = await saveReport(env, 'm_look1', 'i_eve1', pts(8), { member: KIM, base: '', look: 'cards' });
  assert.equal(first.reportLook, 'cards');
  assert.equal((await item(env)).reportLook, 'cards');
  // Only the look, from a page that opened it before (an old base): no 409, words and stamp as they were
  const again = await saveReport(env, 'm_look1', 'i_eve1', pts(8), { admin: true, adminEmail: 'jane@soardcharity.com', base: '', look: 'list' });
  assert.deepEqual([again.reportLook, again.reportBy, again.reportAt], ['list', 'Kim Park', first.reportAt]);
  // Not sent: as it was; something that isn't a look: as it fits
  assert.equal((await saveReport(env, 'm_look1', 'i_eve1', pts(8), { member: KIM, base: first.reportAt })).reportLook, 'list');
  assert.equal((await saveReport(env, 'm_look1', 'i_eve1', pts(8), { member: KIM, base: first.reportAt, look: 'sparkles' })).reportLook, '');
  // New words and a look together: both
  const both = await saveReport(env, 'm_look1', 'i_eve1', pts(3), { member: KIM, base: first.reportAt, look: 'numbers' });
  assert.deepEqual([both.report, both.reportLook], [pts(3), 'numbers']);
  // The screen's view carries it
  const v = await liveView(env, 'm_look1', { admin: true, adminEmail: 'jane@soardcharity.com' }).catch(() => null);
  if (v) assert.equal(v.sections[0].items[0].reportLook, 'numbers');
});
