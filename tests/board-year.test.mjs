/**
 * The year against last year, month by month: QuickBooks' Profit and Loss by month read with what never left the bank
 * (functions/api/_quickbooks.js plByMonth), and the money item's series from it (public/admin/board/books.js
 * yearSeries), whose expenses leave in kind and depreciation out as the board's figures do. Made-up numbers only.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plByMonth } from '../functions/api/_quickbooks.js';
import { yearSeries } from '../public/admin/board/books.js';
import { compact } from '../public/admin/board/money.js';

const cd = (label, ...v) => [{ value: label }, ...v.map((x) => ({ value: String(x) }))];
const month = (title, start) => ({ ColTitle: title, ColType: 'Money', MetaData: [{ Name: 'StartDate', Value: start }] });
const report = {
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, month('Jan 2026', '2026-01-01'), month('Feb 2026', '2026-02-01'), { ColTitle: 'Total', ColType: 'Money' }] },
  Rows: { Row: [
    { group: 'Income', Header: { ColData: cd('Income') }, Rows: { Row: [{ ColData: cd('Individual Revenue', 1000, 2000, 3000) }] }, Summary: { ColData: cd('Total Income', 1000, 2000, 3000) } },
    { group: 'Expenses', Header: { ColData: cd('Expenses') }, Rows: { Row: [
      { ColData: cd('Program Costs', 300, 400, 700) },
      { ColData: cd('In-Kind Contribution Expense', 100, 0, 100) },
      // A group named so counts once, by its total
      { Header: { ColData: cd('Depreciation') }, Rows: { Row: [{ ColData: cd('Depreciation - Truck', 50, 50, 100) }] }, Summary: { ColData: cd('Total Depreciation', 50, 50, 100) } },
    ] }, Summary: { ColData: cd('Total Expenses', 450, 450, 900) } },
    { group: 'NetIncome', Summary: { ColData: cd('Net Income', 550, 1550, 2100) } },
  ] },
};

test('the Profit and Loss by month: each month its revenue, its spending, and the part of it that never left the bank', () => {
  assert.deepEqual(plByMonth(report), [
    { month: '2026-01', revenue: 1000, spent: 450, nonCash: 150 },
    { month: '2026-02', revenue: 2000, spent: 450, nonCash: 50 },
  ]);
});

const books = (months, last) => ({ year: '2026', lastYear: { year: '2025' }, monthly: { year: '2026', lastYear: '2025', months, last } });

test('the series: added up month by month, this year through its month, expenses without in kind or depreciation', () => {
  const s = yearSeries(books(plByMonth(report), [{ month: '2025-01', revenue: 800, spent: 400, nonCash: 100 }, { month: '2025-12', revenue: 200, spent: 100, nonCash: 0 }]));
  assert.equal(s.cash, true);
  assert.equal(s.upTo, 1);
  assert.deepEqual(s.revenue.now.slice(0, 3), [1000, 3000, null]);
  assert.deepEqual(s.spent.now.slice(0, 3), [300, 700, null]);
  assert.equal(s.spent.then[0], 300);
  assert.equal(s.spent.then[11], 400);
});

test('a read from before the months had it keeps in kind in, and says so (cash: false)', () => {
  const s = yearSeries(books([{ month: '2026-01', revenue: 1000, spent: 450 }], []));
  assert.equal(s.cash, false);
  assert.equal(s.spent.now[0], 450);
  assert.equal(s.spent.then, null);
});

test('compact amounts reach billions', () => {
  assert.deepEqual([18e9, 1.25e9, 999e6, 2.5e6, -3e9, 45000].map(compact), ['$18B', '$1.25B', '$999M', '$2.5M', '−$3B', '$45K']);
});
