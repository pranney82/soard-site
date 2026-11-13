/**
 * Kit Signals: a card on a person's page in Donors & Partners (Peter, Nov 13 2026: "can we get kit signals information
 * on the donor profile too?"). What Kit found about them from public sources (functions/api/_donor-signals.js): their
 * work, LinkedIn, social profiles and reach, income and home ownership. Read from Kit when the page opens; when Kit has
 * nothing, the card says why in a line; for someone on the team, or with Kit not connected, there is no card.
 */
import { h, htm, useState, useEffect } from './vendor.js';

const html = htm.bind(h);
const STYLE = `
.dn-sig dl { display: grid; gap: .5rem; margin: 0; }
.dn-sig dt { font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-sig dd { margin: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.dn-sig__social { display: grid; gap: .3rem; margin: 0; padding: 0; list-style: none; font-size: var(--fs-sm); }
.dn-sig__social li { display: flex; flex-wrap: wrap; gap: .1rem .5rem; align-items: baseline; min-width: 0; }
.dn-sig__bio { margin: .15rem 0 0; font-size: var(--fs-xs); color: var(--color-text-secondary); line-height: 1.45; overflow-wrap: anywhere; }
@media (pointer: coarse) { .dn-sig__social a { min-height: 44px; display: inline-flex; align-items: center; } }
`;
let styled = false;
const useStyles = () => {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'donor-signals';
  el.textContent = STYLE;
  document.head.append(el);
};
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n.toLocaleString());
const cache = new Map(); // ref → answer, for this visit to the admin

export function SignalsCard({ refOf, name }) {
  useStyles();
  const [v, setV] = useState(() => cache.get(refOf) || null);
  useEffect(() => {
    let live = true;
    if (cache.has(refOf)) { setV(cache.get(refOf)); return undefined; }
    setV(null);
    fetch(`/api/donors-admin?signals=${encodeURIComponent(refOf)}`, { headers: { Accept: 'application/json' } })
      .then((r) => r.json()).catch(() => ({ success: false }))
      .then((j) => { const a = j?.success ? j : { state: 'error', note: j?.error || 'The site didn’t answer' }; if (j?.success) cache.set(refOf, a); if (live) setV(a); });
    return () => { live = false; };
  }, [refOf]);
  // Nothing to say about someone on the team, an organization, or with Kit not connected
  if (v && (v.state === 'skipped' || v.state === 'off')) return null;
  const s = v?.signals;
  return html`<section class="kd-card dn-card--late dn-sig" aria-labelledby="dn-sig-h" aria-busy=${v ? null : 'true'}>
    <h3 id="dn-sig-h">Kit Signals</h3>
    ${!v ? html`<p class="kd-card__note">Asking Kit…</p>`
      : !s ? html`<p class="kd-card__note">${v.note}.</p>`
      : html`<dl>
        ${s.jobTitle ? html`<div><dt>Work</dt><dd>${s.jobTitle}</dd></div>` : null}
        ${s.income ? html`<div><dt>Household income</dt><dd>${s.income}</dd></div>` : null}
        ${s.homeOwnership ? html`<div><dt>Home</dt><dd>${s.homeOwnership}</dd></div>` : null}
        ${s.socialReach != null ? html`<div><dt>Social reach</dt><dd>${count(s.socialReach)} people</dd></div>` : null}
        ${s.social.length ? html`<div><dt>Online</dt><dd><ul class="dn-sig__social">${s.social.map((x) => html`<li key=${x.key}>
          ${x.url ? html`<a class="link" href=${x.url} target="_blank" rel="noopener noreferrer" aria-label=${`${name} on ${x.label}`}>${x.label}</a>` : html`<span>${x.label}</span>`}
          ${x.count != null ? html`<span class="dn-sub">${count(x.count)} ${x.countWord}</span>` : null}</li>`)}</ul>
          ${s.linkedinBio ? html`<p class="dn-sig__bio">${s.linkedinBio}</p>` : null}</dd></div>` : null}
      </dl>
      <p class="kd-card__note">What Kit found about them in public sources. It can be wrong or out of date.</p>`}
  </section>`;
}
