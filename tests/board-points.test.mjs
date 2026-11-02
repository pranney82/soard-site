// A short report that is only its points (board-md.js mdPoints), and its figures (mdFigures): the screen draws each
// point as a card and makes the numbers stand out
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdPoints, mdFigures, POINTS_MAX } from '../public/admin/board-md.js';

const figs = (t) => mdFigures(t).filter((r) => r.fig).map((r) => r.text);

test('a few short points are points; anything else is drawn as the report it is', () => {
  assert.deepEqual(mdPoints('- One\n- Two\n- Three'), { lead: '', points: ['One', 'Two', 'Three'], numbered: false, start: 1 });
  assert.deepEqual(mdPoints('1. First\n2. Second'), { lead: '', points: ['First', 'Second'], numbered: true, start: 1 });
  // A numbered list keeps its own numbers, as the board page shows them
  assert.equal(mdPoints('3. Third\n4. Fourth').start, 3);
  assert.deepEqual(mdPoints('Where we are.\n\n- One\n- Two'), { lead: 'Where we are.', points: ['One', 'Two'], numbered: false, start: 1 });
  assert.equal(mdPoints('- Only one'), null);
  assert.equal(mdPoints(Array.from({ length: POINTS_MAX + 1 }, (_, i) => `- Point ${i}`).join('\n')), null);
  assert.equal(mdPoints('### Highlights\n- One\n- Two'), null);
  assert.equal(mdPoints('- One\n  - under it\n- Two'), null);
  assert.equal(mdPoints('- One\n- Two\n\nAnd a line after.'), null);
  assert.equal(mdPoints('A paragraph.\n\nAnother.'), null);
  assert.equal(mdPoints(''), null);
  assert.equal(mdPoints(`- ${'word '.repeat(40)}\n- Two`), null);
  // Six full points and a long lead are too much for cards: drawn whole
  assert.equal(mdPoints(`${'lead '.repeat(25)}\n\n${Array.from({ length: 6 }, () => `- ${'word '.repeat(28)}`).join('\n')}`), null);
});

test('the Nov 5 automation reports are points', () => {
  for (const md of [
    '- Families and organizations apply on our website, in English or Spanish\n- Each one files itself in JobTread: photos, video and a diagnosis summary\n- Approving one creates the job and its kid or project page\n- 22 families are waiting for 2027 applications to open',
    '- Every open makeover has a live cost sheet: budget, committed, billed, forecast\n- Subs sign up online with their W-9, insurance and bank details\n- Bills wait until a sub’s paperwork is current, and the insurance audit is a ready report',
  ]) assert.ok(mdPoints(md), md.slice(0, 40));
});

test('figures stand out; a number inside a name doesn’t', () => {
  assert.deepEqual(figs('22 families are waiting for 2027 applications to open'), ['22', '2027']);
  assert.deepEqual(figs('gifts of $1,000 or more, since 2013, up 40% to 3.5'), ['$1,000', '2013', '40%', '3.5']);
  assert.deepEqual(figs('Every meeting since 2013, with its minutes'), ['2013']);
  assert.deepEqual(figs('Their W-9, the Q4 meeting, 20-second polling, Form 1099-NEC'), []);
  assert.deepEqual(figs('It ends at 3.'), ['3']);
  assert.deepEqual(figs('1,000+ volunteers in 2026–27 and 2026-27, for 3–5 days'), ['1,000+', '2026–27', '2026-27', '3–5']);
  assert.deepEqual(figs('$1.2M raised, 3x faster, our 15th year'), ['$1.2M', '3x', '15th']);
  // A time, a date and a phone number aren't figures
  assert.deepEqual(figs('Doors open at 5:30 on Nov 5, call (770) 555-1234 by November 12'), []);
  assert.deepEqual(figs('(22 families) in 2026, 12 kids.'), ['22', '2026', '12']);
  // Bold and links keep their marks; the words read the same put back together
  const runs = mdFigures('**12 kids** and [3 links](https://example.org)');
  assert.deepEqual(runs.filter((r) => r.fig).map((r) => [r.text, !!r.b]), [['12', true]]);
  assert.equal(runs.map((r) => r.text).join(''), '12 kids and 3 links');
});
