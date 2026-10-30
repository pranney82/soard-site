/**
 * Settings → QuickBooks (./settings.js): the year's revenue and expenses so far on the board page, read from QuickBooks
 * every hour against the packet's budget sheet. Intuit's own page signs in to QuickBooks, so SOARD never sees
 * the password; it sends the admin back here through /api/books-callback (?books=connected|declined|expired|failed).
 * See functions/api/_quickbooks.js and /api/books-admin.
 */

import { useState, useEffect } from './vendor.js';
import { ask } from './ask.js';
import { html, ago, CHECK } from './board-ui.js';
import { shortDate } from './board-shared.js';

const API = '/api/books-admin';

async function api(body) {
  let r;
  try {
    r = await fetch(API, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
  return r.json().catch(() => ({ ok: false, error: `The server answered ${r.status}` }));
}

// How the trip to Intuit's page went
const BACK = {
  connected: ['QuickBooks is connected. The board page has its cash and the year so far now.', 'info'],
  declined: ['QuickBooks wasn’t connected: Intuit’s page was cancelled.', 'error'],
  expired: ['That took longer than 15 minutes. Press Connect QuickBooks again.', 'error'],
  failed: ['QuickBooks didn’t connect. Try again, signed in to QuickBooks as an admin.', 'error'],
};

export function QuickBooks({ addToast = () => {} }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = async () => { const j = await api(); setD(j.ok ? j : { error: j.error || 'Couldn’t load QuickBooks' }); };
  useEffect(() => {
    load();
    const q = new URLSearchParams(location.search);
    const said = BACK[q.get('books')];
    if (q.has('books')) history.replaceState(null, '', `${location.pathname}${location.hash}`);
    if (said) addToast(...said);
  }, []);

  const head = html`<div class="bd-card-head"><h3>QuickBooks</h3><p>The board page’s cash in the bank and the year’s revenue and expenses so far, from QuickBooks, read by themselves every hour. The budget beside them is the one in the newest packet. Amounts show on the board page only.</p></div>`;
  if (!d) return html`<div class="card">${head}<div class="area-loading"><span class="spinner" /></div></div>`;
  if (d.error) return html`<div class="card">${head}<div class="notice notice--warn" role="alert"><div class="notice__body">${d.error}</div><div class="notice__actions"><button class="btn btn-ghost btn-sm" onClick=${() => { setD(null); load(); }}>Try again</button></div></div></div>`;

  const { status } = d;
  const c = status.connected;
  const connect = async () => {
    setBusy('connect');
    const j = await api({ action: 'connect' });
    if (!j.ok) { setBusy(null); addToast(j.error, 'error'); return; }
    location.assign(j.url);
  };
  const disconnect = async () => {
    const ok = await ask({ title: `Disconnect ${c.company}?`, text: 'The board page goes back to the packet’s budget sheet for the year so far. Connecting again means signing in to QuickBooks on Intuit’s page.', yes: 'Disconnect', danger: true });
    if (!ok) return;
    setBusy('disconnect');
    const j = await api({ action: 'disconnect' });
    setBusy(null);
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setD(j);
    addToast('QuickBooks disconnected', 'info');
  };

  const row = (state, t, s, actions = null) => html`<li class=${`bm-task is-${state}`}>
    <span class="bm-task__mark" aria-hidden="true">${state === 'done' ? CHECK : null}</span>
    <div><div class="bm-task__t">${t}</div><div class="bm-task__s">${s}</div>${actions ? html`<div class="bm-task__do">${actions}</div>` : null}</div>
  </li>`;
  const waiting = busy !== null;
  const connectBtn = (label) => html`<button class="btn btn-primary btn-sm" disabled=${waiting} onClick=${connect}>${busy === 'connect' ? 'Opening…' : label}</button>`;
  const through = c?.through ? `The year so far through ${shortDate(c.through).replace(/, \d{4}$/, '')}` : 'Not read yet';
  return html`<div class="card bk-books">
    ${head}
    <ul class="bm-tasks">
      ${!status.configured ? row('next', 'QuickBooks', html`Connected here once QuickBooks’ keys are in Cloudflare:
          <ol class="bd-steps">
            <li>At <strong>developer.intuit.com</strong>, signed in as a QuickBooks admin, create an app for <strong>QuickBooks Online</strong> with the <strong>Accounting</strong> scope.</li>
            <li>In the app’s <strong>Keys and credentials → Production</strong>, add this redirect URI: <span class="bd-code">${status.redirectUri}</span>. Then copy the Client ID and Client Secret.</li>
            <li>In Cloudflare, open <strong>Workers & Pages → soard-site → Settings → Variables and Secrets</strong>. Add the secrets <span class="bd-code">QBO_CLIENT_ID</span> and <span class="bd-code">QBO_CLIENT_SECRET</span>, then publish.</li>
            <li>A <strong>Connect QuickBooks</strong> button shows here.</li>
          </ol>`)
        : !c ? row('next', 'QuickBooks', 'Not connected. Intuit’s page opens: sign in to QuickBooks as an admin and pick Sunshine on a Ranney Day. SOARD never sees the password.', connectBtn('Connect QuickBooks'))
        : row(c.error ? 'next' : 'done', c.company,
          c.error ? html`${c.trouble}${c.readAt ? ` The board page shows the year so far from ${ago(c.readAt)}.` : ''}${c.intuitTid ? html`<br /><span class="form-hint">Intuit’s reference, if their support asks: <span class="bd-code">${c.intuitTid}</span></span>` : null}` : c.readAt ? `${through}, read ${ago(c.readAt)}.` : 'Not read yet. It reads within the hour.',
          html`${c.qboYearStarts ? html`<p class="form-hint" style="margin:0 0 0.5rem">QuickBooks’ settings say SOARD’s fiscal year starts in ${c.qboYearStarts}, so its own “this year” reports start there. The board page counts from January 1. To match, in QuickBooks open <strong>Settings → Account and settings → Advanced → Accounting</strong> and set <strong>First month of fiscal year</strong> to January.</p>` : null}
            ${c.needsConnect ? connectBtn('Connect QuickBooks again') : null}
            <button class="btn btn-ghost btn-sm btn-row-danger" disabled=${waiting} onClick=${disconnect}>${busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>`)}
    </ul>
    ${status.env === 'sandbox' ? html`<div class="bd-actions" style="margin-top:0.85rem"><span class="tag">QuickBooks sandbox: Intuit’s made-up company</span></div>` : null}
  </div>`;
}
