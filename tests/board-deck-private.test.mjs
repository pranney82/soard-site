/**
 * The meeting's screen never shows a staff-only file: the chair's deck (board-shared.js deckOf) leaves them out, on
 * an item and among the loose files, so a tap in During can't put one on the screen
 *
 *   node --test tests/board-deck-private.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMeeting, deckOf, forBoard } from '../public/admin/board-shared.js';

test('a staff-only file is never a stop on the screen, on an item or loose, and the chair’s deck matches the board’s', () => {
  const m = cleanMeeting({
    id: 'm_priv1', date: '2099-11-05', shared: true,
    sections: [{ id: 's_one1', title: 'Committee reports', items: [{ id: 'i_fin1', title: 'Financial', docs: ['f_open1', 'f_priv1'] }] }],
    files: [
      { id: 'f_open1', name: 'Budget.pdf', type: 'application/pdf', kind: 'financials', staffOnly: false },
      { id: 'f_priv1', name: 'Salaries.pdf', type: 'application/pdf', kind: 'financials', staffOnly: true },
      { id: 'f_priv2', name: 'Board candidates notes.pdf', type: 'application/pdf', kind: 'other', staffOnly: true },
    ],
  });
  const files = (d) => [...new Set(d.filter((s) => s.fileId).map((s) => s.fileId))];
  assert.deepEqual(files(deckOf(m)), ['f_open1']);
  assert.deepEqual(deckOf(m).map((s) => s.key), deckOf(forBoard(m)).map((s) => s.key), 'stop for stop the same as the screen’s');
});
