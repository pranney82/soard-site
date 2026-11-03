/**
 * A word beside a report as it's written (public/admin/board-coach.js): how it will show in the meeting, and one
 * suggestion at a time that does what it says without losing a word
 *
 *   node --test tests/board-coach.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportAdvice, reportFitLine, partFor, sentencesOf, speakTime } from '../public/admin/board-coach.js';
import { mdBlocks, mdWords, mdPlain } from '../public/admin/board-md.js';
import { cleanMeeting, NOTHING_NEW } from '../public/admin/board-shared.js';

const words = (md) => mdPlain(md).replace(/^\s*(?:•|\d+\.)\s/gm, '').split(/\s+/).filter(Boolean);
const PART = { name: 'Committee reports', minutes: 20, reports: 4 };
const LONG_P = 'We met twice this quarter and read every application that came in. Eleven families applied, and the committee approved four of them for spring makeovers. Two families were asked for more about their child’s diagnosis before a decision.';

test('the fit line: one slide, or how many and how long, and the part’s time (only parts have one)', () => {
  assert.equal(reportFitLine({ slides: 1, words: 80, part: PART }), 'Fits on one slide. Committee reports has 20 minutes for 4 reports.');
  assert.equal(reportFitLine({ slides: 3, words: 420, part: null }), '3 slides in the meeting, about 3 minutes to present.');
  assert.equal(reportFitLine({ slides: 1, words: 30, part: { name: 'Financial', minutes: 15, reports: 1 } }), 'Fits on one slide. Financial has 15 minutes.');
  assert.equal(reportFitLine({ slides: 1, words: 0, part: PART }), '', 'nothing written: nothing said');
  assert.equal(speakTime(40), 'under a minute to present');
});

test('the part an item is in: its name, its minutes, and how many of its items report', () => {
  const m = cleanMeeting({ id: 'm_c1', date: '2099-11-05', start: '18:00', end: '20:00', sections: [
    { id: 's_a1', title: 'Committee reports', minutes: 20, items: [{ id: 'i_a1', title: 'Gov', who: ['sam'] }, { id: 'i_a2', title: 'Fin', report: 'Up.' }, { id: 'i_a3', title: 'Other' }] },
    { id: 's_b1', title: '', items: [{ id: 'i_b1', title: 'Close' }] },
  ] });
  assert.deepEqual(partFor(m, 'i_a2'), { name: 'Committee reports', minutes: 20, reports: 2 });
  assert.equal(partFor(m, 'i_b1').name, 'Part 2');
  assert.equal(partFor(m, 'i_nope'), null);
});

test('sentences: never at a number, a title, an abbreviation or inside bold', () => {
  assert.deepEqual(sentencesOf('We met Dr. Smith at 1.5 p.m. on Nov. 3 in the U.S. Army hall. **Big news. Really.** The budget is $1.2M. Is it enough? Yes!'),
    ['We met Dr. Smith at 1.5 p.m. on Nov. 3 in the U.S. Army hall.', '**Big news. Really.**', 'The budget is $1.2M.', 'Is it enough?', 'Yes!']);
  assert.deepEqual(sentencesOf('One line\nand its next. “Quoted.” [A link](https://x.org). E.g. this stays.'), ['One line and its next.', '“Quoted.”', '[A link](https://x.org).', 'E.g. this stays.']);
  assert.deepEqual(sentencesOf('Just one sentence with no end'), ['Just one sentence with no end']);
});

test('one suggestion at a time, best first: shorter, the ask first, points, an empty heading', () => {
  const md = `### What we did\n\n${LONG_P}\n\n### Goals\n\n### What the board needs to decide\n\nWe ask the board to approve the spring makeovers and the new budget line for build days.`;
  const ids = reportAdvice(md, { slides: 2, part: PART }).map((x) => x.id.split(':')[0]);
  assert.deepEqual(ids, ['shorter', 'first', 'points', 'empty']);
  assert.deepEqual(reportAdvice(md, { slides: 1, part: PART }).map((x) => x.id.split(':')[0]), ['first', 'points', 'empty']);
  assert.deepEqual(reportAdvice('', { slides: 3 }), []);
  assert.deepEqual(reportAdvice(NOTHING_NEW, { slides: 1 }), []);
  // Long for its share of the part's time, on one slide
  const long = Array.from({ length: 8 }, () => LONG_P).join('\n\n');
  assert.equal(reportAdvice(long, { slides: 1, part: { name: 'Financial', minutes: 4, reports: 2 } })[0].id, 'shorter');
  assert.equal(reportAdvice(long, { slides: 1, part: { name: 'Financial', minutes: 4, reports: 2 } })[0].action.shorter, true);
});

test('the ask first: the heading and what’s under it go to the top, every word kept', () => {
  const md = `### What we did\n\n${LONG_P}\n\n### What we need from the board\n\n- Approve the budget line\n- Name a build-day lead\n\n### What’s next\n\nThe spring reveals.`;
  const tip = reportAdvice(md, { slides: 1 }).find((x) => x.id.startsWith('first'));
  const out = tip.action.run(md);
  assert.equal(mdBlocks(out)[0].text, 'What we need from the board');
  assert.equal(mdBlocks(out)[1].t, 'ul');
  assert.deepEqual(words(out).sort(), words(md).sort());
  assert.ok(!reportAdvice(out, { slides: 1 }).some((x) => x.id.startsWith('first')), 'once it’s first, it isn’t offered again');
  // A paragraph that asks, late: that paragraph alone
  const p = `${LONG_P}\n\n${LONG_P}\n\nPlease approve the new budget line tonight.`;
  const moved = reportAdvice(p, { slides: 1 }).find((x) => x.id.startsWith('first')).action.run(p);
  assert.equal(mdBlocks(moved)[0].text, 'Please approve the new budget line tonight.');
  // Already near the top: not offered
  assert.ok(!reportAdvice(`Please approve the budget line.\n\n${LONG_P}`, { slides: 1 }).some((x) => x.id.startsWith('first')));
});

test('a long paragraph made points: one point a sentence, the same words, bold kept whole', () => {
  const md = `${LONG_P} **Build days doubled. Volunteers too.** The store had its best October.`;
  const tip = reportAdvice(md, { slides: 1 }).find((x) => x.id.startsWith('points'));
  const out = tip.action.run(md);
  const b = mdBlocks(out);
  assert.equal(b.length, 1);
  assert.equal(b[0].t, 'ul');
  assert.equal(b[0].items.length, 5);
  assert.equal(b[0].items[3][0].text, '**Build days doubled. Volunteers too.**');
  assert.deepEqual(words(out), words(md));
  assert.equal(mdWords(out), mdWords(md));
  // A report with a list already: not offered; a short paragraph: not offered
  assert.ok(!reportAdvice(`${LONG_P}\n\n- one\n- two`, { slides: 1 }).some((x) => x.id.startsWith('points')));
  assert.ok(!reportAdvice('Short. Two.', { slides: 1 }).some((x) => x.id.startsWith('points')));
  // Something that would read as Markdown once it starts a point stays words
  const tricky = 'The plan has steps. 1. comes first and is done. # 2 is the hard one. > Not a quote. And the last.';
  const t2 = reportAdvice(tricky, { slides: 1 }).find((x) => x.id.startsWith('points'));
  if (t2) assert.equal(mdWords(t2.action.run(tricky)), mdWords(tricky));
});

test('an empty heading taken off, nothing else touched; a new slide counts as the end of what’s under it', () => {
  const md = '### Goals\n\n### Where we are\n\nEight in build.\n\n### Next\n\n---\n\nThe ask.';
  const tips = reportAdvice(md, { slides: 2 }).filter((x) => x.id.startsWith('empty'));
  assert.equal(tips[0].text, '“Goals” has nothing under it.');
  const out = tips[0].action.run(md);
  assert.equal(out, '### Where we are\n\nEight in build.\n\n### Next\n\n---\n\nThe ask.');
  assert.equal(reportAdvice(out, { slides: 2 }).find((x) => x.id.startsWith('empty')).text, '“Next” has nothing under it.');
});

test('every suggestion’s change reads back as Markdown with no word lost (a random walk)', () => {
  const pool = [LONG_P, 'Please approve the budget line tonight.', '- one point\n- two points', '### A heading', '**Bold. Still bold.** After it.', 'We ask the board to vote.', '---', '> A callout for the board.', '1. First\n2. Second'];
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 400; k++) {
    const md = Array.from({ length: 2 + rnd(6) }, () => pool[rnd(pool.length)]).join('\n\n');
    for (const tip of reportAdvice(md, { slides: 1 + rnd(3), part: PART })) {
      if (!tip.action.run) continue;
      const out = tip.action.run(md);
      const lost = tip.id.startsWith('empty') ? mdWords(mdBlocks(md).find((b) => b.t === 'h' && `empty:${mdPlain(b.text).trim()}` === tip.id)?.text || '') : 0;
      assert.equal(mdWords(out), mdWords(md) - lost, `${tip.id}\n${md}\n→\n${out}`);
    }
  }
});

test('sentences: never inside a quotation, straight or curly', () => {
  assert.deepEqual(sentencesOf('She said "We love it. Thank you so much." Then we left.'), ['She said "We love it. Thank you so much."', 'Then we left.']);
  assert.deepEqual(sentencesOf('She said “We love it. Thank you so much.” Then we left.'), ['She said “We love it. Thank you so much.”', 'Then we left.']);
});

test('the ask first is never offered where moving it would run two lists into one', () => {
  const filler = 'The committee met twice this quarter and read every application that came in, and the families heard back within a week.';
  // The ask ends with a list and the report starts with one: moved, they'd read as one list
  const md = `- First thing we did\n- Second thing we did\n\n${filler} ${filler}\n\n### What we need from the board\n\n- Approve the budget\n- Name a sponsor`;
  assert.ok(!reportAdvice(md).some((s) => s.id.startsWith('first:')));
  // The same, the report starting with words: offered, and the lists stay two
  const ok = `${filler}\n\n- First thing we did\n- Second thing we did\n\n${filler}\n\n### What we need from the board\n\n- Approve the budget\n- Name a sponsor`;
  const s = reportAdvice(ok).find((x) => x.id.startsWith('first:'));
  assert.ok(s);
  const done = s.action.run(ok);
  assert.equal(mdBlocks(done).filter((b) => b.t === 'ul').length, 2);
  // Taking it out of the middle never joins the lists either side of it
  const mid = `${filler} ${filler}\n\n- One\n- Two\n\nWe need the board to approve the budget tonight.\n\n- Three\n- Four`;
  assert.ok(!reportAdvice(mid).some((x) => x.id.startsWith('first:')));
});
