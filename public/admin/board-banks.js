/**
 * Board → Settings → Bank balances: the banks the board page's cash counts. Mercury is read through SOARD's
 * relay (its keys in Cloudflare). Any other bank (Chase: its checking, the CD, the credit card) is connected
 * here through Plaid, whose own window signs into the bank, so SOARD never sees the password.
 * See functions/api/_plaid.js and /api/bank-admin.
 */

import { useState, useEffect } from './vendor.js';
import { ask } from './ask.js';
import { html, ago, CHECK } from './board-ui.js';

const API = '/api/bank-admin';
// Plaid's script comes straight from Plaid (it may not be copied or bundled), and only when someone connects
const PLAID_JS = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

async function api(body) {
  let r;
  try {
    r = await fetch(API, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
  return r.json().catch(() => ({ ok: false, error: `The server answered ${r.status}` }));
}

let plaidOnce = null;
const loadPlaid = () => (plaidOnce ||= new Promise((resolve, reject) => {
  if (window.Plaid) { resolve(window.Plaid); return; }
  const s = document.createElement('script');
  s.src = PLAID_JS;
  s.async = true;
  s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid’s window didn’t load.')));
  s.onerror = () => { plaidOnce = null; s.remove(); reject(new Error('Plaid’s window didn’t load. An ad blocker can stop it; pause it here and try again.')); };
  document.head.append(s);
}));

const accountsText = (list) => list.map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`).join(' · ');

export function BankBalances({ addToast = () => {} }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = async () => { const j = await api(); setD(j.ok ? j : { error: j.error || 'Couldn’t load the bank balances' }); };
  useEffect(() => { load(); }, []);

  const head = html`<div class="bd-card-head"><h3>Bank balances</h3><p>The cash on the board page: each bank’s balances, read by themselves through the day. Credit cards show as owed, never taken off the cash. Amounts show on the board page only.</p></div>`;
  if (!d) return html`<div class="card">${head}<div class="area-loading"><span class="spinner" /></div></div>`;
  if (d.error) return html`<div class="card">${head}<div class="notice notice--warn" role="alert"><div class="notice__body">${d.error}</div><div class="notice__actions"><button class="btn btn-ghost btn-sm" onClick=${() => { setD(null); load(); }}>Try again</button></div></div></div>`;

  const { status, mercury } = d;
  // Plaid's window: a new bank, or (bank) signing in to a connected one again
  const openPlaid = async (bank = null) => {
    setBusy(bank?.itemId || 'new');
    const t = await api({ action: 'link-token', itemId: bank?.itemId });
    if (!t.ok) { setBusy(null); addToast(t.error, 'error'); return; }
    let Plaid;
    try { Plaid = await loadPlaid(); } catch (e) { setBusy(null); addToast(e.message, 'error'); return; }
    const handler = Plaid.create({
      token: t.linkToken,
      onSuccess: async (publicToken, meta) => {
        const name = meta?.institution?.name || 'The bank';
        const j = bank ? await api({ action: 'refresh', itemId: bank.itemId }) : await api({ action: 'connect', publicToken, institution: { id: meta?.institution?.institution_id, name } });
        setBusy(null);
        handler.destroy();
        if (!j.ok) { addToast(j.error, 'error'); return; }
        setD(j);
        addToast(bank ? `${bank.bank} reads again` : `${name} is connected. The board page counts it now.`, 'info');
      },
      onExit: (err) => {
        setBusy(null);
        handler.destroy();
        if (err) addToast(err.display_message || err.error_message || 'Plaid’s window closed before the bank was connected', 'error');
      },
    });
    handler.open();
  };
  const disconnect = async (b) => {
    const ok = await ask({ title: `Disconnect ${b.bank}?`, text: `The board page stops counting ${b.bank}. Connecting it again means signing in to ${b.bank} in Plaid’s window.`, yes: 'Disconnect', danger: true });
    if (!ok) return;
    setBusy(b.itemId);
    const j = await api({ action: 'disconnect', itemId: b.itemId });
    setBusy(null);
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setD(j);
    addToast(`${b.bank} disconnected`, 'info');
  };

  const row = (state, t, s, actions = null) => html`<li class=${`bm-task is-${state}`}>
    <span class="bm-task__mark" aria-hidden="true">${state === 'done' ? CHECK : null}</span>
    <div><div class="bm-task__t">${t}</div><div class="bm-task__s">${s}</div>${actions ? html`<div class="bm-task__do">${actions}</div>` : null}</div>
  </li>`;
  const waiting = busy !== null;
  return html`<div class="card bk-banks">
    ${head}
    <ul class="bm-tasks">
      ${row(mercury.on ? 'done' : 'todo', 'Mercury', mercury.on
        ? `${mercury.accounts.length ? `${mercury.accounts.join(' · ')}. ` : ''}Read through SOARD’s relay${mercury.readAt ? `, ${ago(mercury.readAt)}` : ''}.`
        : 'Not read: its keys (MERCURY_API_TOKEN and MERCURY_RELAY_KEY) aren’t in Cloudflare.')}
      ${status.banks.map((b) => row(b.error ? 'next' : 'done', b.bank,
        b.error ? html`${b.trouble}${b.readAt ? ` The board page shows its balances from ${ago(b.readAt)}.` : ''}` : `${accountsText(b.accounts) || 'No accounts shared'}. Read ${ago(b.readAt)}, through Plaid.`,
        html`${b.needsSignIn ? html`<button class="btn btn-primary btn-sm" disabled=${waiting} onClick=${() => openPlaid(b)}>${busy === b.itemId ? 'Opening…' : `Sign in to ${b.bank} again`}</button>` : null}
          <button class="btn btn-ghost btn-sm btn-row-danger" disabled=${waiting} onClick=${() => disconnect(b)}>Disconnect</button>`))}
      ${!status.configured ? row('next', 'Chase', html`Connected through Plaid, once Plaid’s keys are in Cloudflare:
          <ol class="bd-steps">
            <li>In Plaid’s dashboard, open <strong>Developers → Keys</strong>. Copy the <span class="bd-code">client_id</span> and the <strong>Production</strong> secret.</li>
            <li>In Cloudflare, open <strong>Workers & Pages → soard-site → Settings → Variables and Secrets</strong>. Add the secrets <span class="bd-code">PLAID_CLIENT_ID</span> and <span class="bd-code">PLAID_SECRET</span>, then publish.</li>
            <li>A <strong>Connect Chase</strong> button shows here.</li>
          </ol>`)
        : !status.banks.length ? row('next', 'Chase', 'Not connected. Plaid’s window opens: sign in to Chase there and tick the checking, the CD and the credit card. SOARD never sees the password.',
          html`<button class="btn btn-primary btn-sm" disabled=${waiting} onClick=${() => openPlaid()}>${busy === 'new' ? 'Opening…' : 'Connect Chase'}</button>`)
        : null}
    </ul>
    ${status.configured && status.banks.length ? html`<div class="bd-actions" style="margin-top:0.85rem"><button class="btn btn-ghost btn-sm" disabled=${waiting} onClick=${() => openPlaid()}>${busy === 'new' ? 'Opening…' : 'Connect another bank'}</button>${status.env === 'sandbox' ? html`<span class="tag">Plaid sandbox: made-up banks</span>` : null}</div>` : null}
  </div>`;
}
