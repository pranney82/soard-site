/**
 * System → Settings (#settings): where the site's money figures come from. The banks the board page's cash counts
 * (Mercury through SOARD's relay, Chase through Plaid: ./board-banks.js) and QuickBooks for the year so far
 * (./board-books.js). Only the Board area's admins see it in the menu; /api/bank-admin and /api/books-admin refuse
 * everyone else.
 */

import { html, injectStyles } from './board-ui.js';
import { BankBalances } from './board-banks.js';
import { QuickBooks } from './board-books.js';

export function Settings({ addToast = () => {} }) {
  injectStyles();
  return html`<div class="page-header">
      <div>
        <h2>Settings</h2>
        <p class="page-sub">Where the board page’s money figures come from: QuickBooks for the cash in the bank and the year’s revenue and expenses so far, and a bank’s live balances once one is connected here.</p>
      </div>
    </div>
    <${BankBalances} addToast=${addToast} />
    <${QuickBooks} addToast=${addToast} />`;
}
