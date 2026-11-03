/**
 * A report longer than a slide goes on to as many as it needs on the meeting's screen (board-shared.js reportSlides):
 * every word on one of them, once, in order; never a heading last on a slide; a list's numbers going on; a paragraph
 * cut only between sentences; "---" a new slide; the same cut wherever it's asked for. And the deck has a stop for each
 *
 *   node --test tests/board-report-slides.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportSlides, reportSlideHeads, slidesOfItem, cleanMeeting, deckOf, stopIndex, liveOfStop, cleanLive } from '../public/admin/board-shared.js';
import { mdBlocks, mdPlain } from '../public/admin/board-md.js';

let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const VOCAB = 'the committee met twice this quarter and read every application that came in while our store had its best month on record with volunteers from three companies building families homes children reveal sponsors budget renewal Atlanta board approved design builders kitchen ramp donation $12,500 2026 40% 1,200 Dr. Smith U.S. 3.5 Nov. 5'.split(' ');
const sentence = (n) => { const w = Array.from({ length: n }, () => pick(VOCAB)); if (rnd() < 0.15 && n > 3) { const k = Math.floor(rnd() * (n - 2)); w[k] = `**${w[k]}`; w[k + 1] = `${w[k + 1]}**`; } if (rnd() < 0.04) w[Math.floor(rnd() * n)] += '\\*'; if (rnd() < 0.03) w[Math.floor(rnd() * n)] = `[${w[0]}`; w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(' ')}.`; };
// Some long stretches in italic or bold, as the editor writes them (_…_, **…**), across sentences
const styled = (t) => (rnd() < 0.12 ? `_${t}_` : rnd() < 0.06 ? `**${t}**` : t);
const para = (words) => { const out = []; let left = words; while (left > 0) { const n = Math.min(left, 5 + Math.floor(rnd() * 16)); out.push(sentence(n)); left -= n; } return out.join(' '); };
function randomReport() {
  const target = 40 + Math.floor(rnd() * 1200);
  const blocks = [];
  let words = 0;
  while (words < target) {
    const r = rnd();
    if (r < 0.14) { blocks.push(`### ${sentence(2 + Math.floor(rnd() * 5)).replace(/\.$/, '')}`); words += 3; }
    else if (r < 0.5) { const n = 10 + Math.floor(rnd() * 400); blocks.push(styled(para(n))); words += n; }
    else if (r < 0.53) { blocks.push('---'); }
    else if (r < 0.56) { blocks.push(`> ${para(12)}`); words += 12; }
    else { const ord = rnd() < 0.35; const k = 2 + Math.floor(rnd() * 10); const items = []; for (let i = 0; i < k; i++) { const n = 3 + Math.floor(rnd() * 40); items.push(`${ord ? `${i + 1}.` : '-'} ${para(n)}${rnd() < 0.12 ? `\n  - ${para(5 + Math.floor(rnd() * 12))}` : ''}`); words += n; } blocks.push(items.join('\n')); }
  }
  return blocks.join('\n\n');
}
const words = (md) => mdPlain(md).replace(/^\s*(?:•|\d+\.)\s/gm, '').split(/\s+/).filter(Boolean);

test('every word on one slide, once, in order; never a heading last on a slide; a slide never empty', () => {
  for (let i = 0; i < 400; i++) {
    const md = randomReport();
    const title = pick(['Governance', 'Outreach and community partnerships committee report', 'Strategic plan, year two: where each of the five goals stands and what the board needs to decide']);
    const slides = reportSlides(md, { title });
    assert.ok(slides.length >= 1);
    assert.deepEqual(slides.flatMap(words), words(md), `report ${i}`);
    for (const s of slides) {
      const blocks = mdBlocks(s);
      assert.ok(blocks.length, `report ${i}: an empty slide`);
      assert.ok(!blocks.some((b) => b.t === 'hr'), `report ${i}: a "---" drawn`);
      if (slides.length > 1) assert.notEqual(blocks.at(-1).t, 'h', `report ${i}: a heading last on a slide`);
    }
    // The same cut every time it's asked for (the screen, the board page's preview, Board, the email agree)
    assert.deepEqual(reportSlides(md, { title }), slides);
  }
});

test('one that fits is one slide, as written; a short one too', () => {
  const md = '### Where we are\n\nThe committee met twice and read every application.\n\n- Four approved\n- Two waiting on a diagnosis';
  assert.deepEqual(reportSlides(md), [md]);
  assert.deepEqual(reportSlides('Nothing new this quarter.'), ['Nothing new this quarter.']);
  assert.deepEqual(reportSlides(''), ['']);
});

test('a long one goes on to more slides, as even as the same number allows, each a slide’s worth', () => {
  const md = Array.from({ length: 9 }, (_, i) => `Paragraph ${i + 1}. ${para(60)}`).join('\n\n');
  const slides = reportSlides(md, { title: 'Governance' });
  assert.ok(slides.length >= 3 && slides.length <= 5, `${slides.length} slides`);
  const counts = slides.map((s) => words(s).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 70, counts.join('/'));
});

test('a numbered list goes on with its numbers; a paragraph is cut only after a sentence', () => {
  const ol = Array.from({ length: 24 }, (_, i) => `${i + 1}. ${para(18)}`).join('\n');
  const slides = reportSlides(ol, { title: 'X' });
  assert.ok(slides.length > 1);
  let next = 1;
  for (const s of slides) {
    const [list] = mdBlocks(s);
    assert.equal(list.t, 'ol');
    assert.equal(list.start, next);
    next += list.items.length;
  }
  const wall = para(700);
  for (const s of reportSlides(wall, { title: 'X' })) assert.match(s.trim(), /[.!?][*_]*$/);
});

test('"---" starts a new slide there, even in a short report', () => {
  const md = 'What we did this quarter.\n\n---\n\nWhat we need from the board.';
  assert.deepEqual(reportSlides(md), ['What we did this quarter.', 'What we need from the board.']);
  assert.deepEqual(reportSlides('---\n\nOnly this.\n\n---'), ['Only this.']);
});

test('a longer title leaves less room under it, so a slide holds a little less', () => {
  const md = Array.from({ length: 30 }, () => `- ${para(14)}`).join('\n');
  const short = reportSlides(md, { title: 'Art' }).length;
  const long = reportSlides(md, { title: 'Strategic plan, year two: where each of the five goals stands and what the board needs to decide tonight' }).length;
  assert.ok(long >= short);
});

test('the deck: a stop for each slide after the first, after the item that shows it; keys kept; an old place lands near', () => {
  const long = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}. ${para(60)}`).join('\n\n');
  const m = cleanMeeting({ id: 'm_s1', date: '2099-11-05', shared: true, files: [], sections: [{ id: 's_1', title: 'Committee reports', items: [
    { id: 'i_gov', title: 'Governance', report: long, motion: 'Move to adopt the bylaws changes.' },
    { id: 'i_fin', title: 'Financial', live: 'cash', report: long },
  ] }] });
  const deck = deckOf(m);
  const keys = deck.map((s) => s.key);
  const n = slidesOfItem(m.sections[0].items[0]).length;
  assert.ok(n > 1);
  const g = keys.indexOf('i_gov');
  assert.deepEqual(keys.slice(g, g + n + 1), ['i_gov', ...Array.from({ length: n - 1 }, (_, p) => `i_gov:report:${p + 1}`), 'i_gov:decision']);
  // An item that shows live facts: its report from its first slide, after them
  const f = keys.indexOf('i_fin');
  assert.equal(keys[f + 1], 'i_fin:report');
  assert.equal(keys[f + 2], 'i_fin:report:1');
  assert.equal(new Set(keys).size, keys.length);
  for (const s of deck) assert.equal(deck[stopIndex(deck, cleanLive(liveOfStop(s)))].key, s.key);
  // A slide further on than the report has now (it was cut shorter): its last
  const at = stopIndex(deck, cleanLive({ itemId: 'i_fin', fileId: 'report', page: 40 }));
  assert.equal(deck[at].itemId, 'i_fin');
  assert.equal(deck[at].kind, 'report');
});

test('a slide that begins partway into a heading’s part has that heading over it ("continued"); never after a "---"', () => {
  const md = `### What we need from the board\n\n${Array.from({ length: 6 }, () => para(70)).join('\n\n')}\n\n### Next quarter\n\n- ${para(10)}`;
  const slides = reportSlides(md, { title: 'Governance' });
  const heads = reportSlideHeads(md, { title: 'Governance' });
  assert.equal(heads.length, slides.length);
  assert.ok(slides.length > 1);
  assert.equal(heads[0], '');
  for (let i = 1; i < slides.length; i++) {
    const first = mdBlocks(slides[i])[0];
    assert.equal(heads[i], first.t === 'h' ? '' : first.t === 'p' && i < slides.length ? heads[i] : heads[i]);
    if (first.t !== 'h') assert.equal(heads[i], 'What we need from the board');
  }
  assert.deepEqual(reportSlideHeads('### A\n\nOne.\n\n---\n\nTwo.'), ['', '']);
  assert.deepEqual(reportSlideHeads('Short one.'), ['']);
});
