// money.js Both: a change said both ways in one place (the screen's and the board page's % | $), only where the two
// differ doubled, the arrow with its figure, so the words around it never move (Peter: "the numbers move position!")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Both } from '../public/admin/board/money.js';

// The words as drawn: what shows, with the other way in [shown | ~kept] (its data-alt, never in the page's words)
const said = (v) => (Array.isArray(v) ? v.map(said).join('') : typeof v === 'string' ? v : v?.props?.class === 'by-both' ? `[${said(v.props.children)}${v.props['data-alt'] ? ` | ~${v.props['data-alt']}` : ''}]` : said(v?.props?.children ?? ''));

test('only what differs is doubled, the arrow with its figure', () => {
  assert.equal(said(Both({ as: 'pct', pct: 'As of Nov 2 · ▲ 12% on a year', usd: 'As of Nov 2 · ▲ $25K on a year' })), 'As of Nov 2 · [▲ 12% | ~▲ $25K] on a year');
  assert.equal(said(Both({ as: 'usd', pct: 'As of Nov 2 · ▲ 12% on a year', usd: 'As of Nov 2 · ▲ $25K on a year' })), 'As of Nov 2 · [▲ $25K | ~▲ 12%] on a year');
  assert.equal(said(Both({ as: 'pct', pct: '▼ 49%', usd: '▼ $450K' })), '[▼ 49% | ~▼ $450K]');
  assert.equal(said(Both({ as: 'usd', pct: '+12%', usd: '+$217,340' })), '[+$217,340 | ~+12%]');
  // a change of direction, and a figure sharing its end with the other ($450K, $45K)
  assert.equal(said(Both({ as: 'pct', pct: 'From the balance sheet · ▲ 3% on a year', usd: 'From the balance sheet · ▼ $4,500 on a year' })), 'From the balance sheet · [▲ 3% | ~▼ $4,500] on a year');
  assert.equal(said(Both({ as: 'usd', pct: '▲ $45K', usd: '▲ $450K' })), '[▲ $450K | ~▲ $45K]');
});

test('the same both ways is said once, its arrow kept with its figure', () => {
  assert.equal(Both({ as: 'pct', pct: 'Even', usd: 'Even' }), 'Even');
  assert.equal(Both({ as: 'usd', pct: '–', usd: '–' }), '–');
  assert.equal(said(Both({ as: 'pct', pct: '▼ $285K', usd: '▼ $285K' })), '[▼ $285K]');
  assert.equal(Both({ as: 'pct', pct: '', usd: '' }), '');
});
