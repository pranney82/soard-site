/**
 * What Admin → Donors & Partners shows inside Partners too (index.html's partners-hub view and partner card)
 * ===========================================================================
 * AreaTabs: Donors · Partners · Community partners · Checks. One area in the sidebar, drawn by two views: Donors and
 * Checks (./donors.js) and the Partners lists. Both draw these same tabs, so moving between them reads as one place.
 * The Checks count is read once and kept current by Checks itself (setChecksWaiting).
 * PartnerGiving: a partner's giving from Zeffy on its partner card, a click from its page in Donors.
 */
import { h, htm, useState, useEffect } from './vendor.js';

const html = htm.bind(h);
let waiting = null;
let asked = false;
const subs = new Set();
/** How many checks wait on a person (Checks tells this as it changes) */
export function setChecksWaiting(n) {
  waiting = Number(n) || 0;
  for (const f of subs) f(waiting);
}
async function readCount() {
  asked = true;
  try {
    const j = await (await fetch('/api/donors-admin?counts=1', { headers: { Accept: 'application/json' } })).json();
    if (j?.success) setChecksWaiting(j.checksWaiting);
  } catch { /* the tab shows no count */ }
}
let styled = false;
const STYLE = `.hub-tab .ppl-tab-count.is-warn { background: var(--tone-warn-bg); color: var(--tone-warn-fg); }
@media (max-width: 560px) { .hub-tabs.dn-area-tabs { flex-wrap: wrap; overflow-x: visible; row-gap: .25rem; mask-image: none; -webkit-mask-image: none; } }
.kd-card--giving { order: 3; }`;
const useStyle = () => { if (!styled) { styled = true; const el = document.createElement('style'); el.dataset.module = 'donor-tabs'; el.textContent = STYLE; document.head.append(el); } };
const usd = (cents) => { const c = Math.round(Number(cents) || 0); return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`; };
const day = (s) => (s ? new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/** current: 'donors' | 'partners' | 'community' | 'checks'; partners, community: counts; onPick(id) */
export function AreaTabs({ current, partners = null, community = null, onPick }) {
  useStyle();
  const [n, setN] = useState(waiting);
  useEffect(() => {
    subs.add(setN);
    if (!asked) readCount();
    return () => { subs.delete(setN); };
  }, []);
  const tab = (id, label, count = null, warn = false) => html`<button type="button" class=${`hub-tab${current === id ? ' active' : ''}`} aria-current=${current === id ? 'page' : null}
    onClick=${() => onPick(id)}>${label}${count != null ? html`<span class=${`ppl-tab-count${warn ? ' is-warn' : ''}`}>${count}</span>` : null}</button>`;
  return html`<nav class="hub-tabs dn-area-tabs" aria-label="Donors & Partners">
    ${tab('donors', 'Donors')}
    ${tab('partners', 'Partners', partners)}
    ${tab('community', 'Community partners', community)}
    ${tab('checks', 'Checks', n ? n : null, true)}
  </nav>`;
}

/** A partner's giving from Zeffy, on its partner card: what counts for them, and their page in Donors */
export function PartnerGiving({ slug }) {
  useStyle();
  const [v, setV] = useState(null);
  useEffect(() => {
    let live = true;
    setV(null);
    fetch(`/api/donors-admin?giving=${encodeURIComponent(`p:${slug}`)}`, { headers: { Accept: 'application/json' } })
      .then((r) => r.json()).then((j) => { if (live) setV(j || { success: false }); }).catch(() => { if (live) setV({ success: false }); });
    return () => { live = false; };
  }, [slug]);
  const page = `#donors/org/${encodeURIComponent(`p:${slug}`)}`;
  return html`<section class="kd-card kd-card--giving" aria-labelledby="pt-giving-h">
    <h3 id="pt-giving-h">Giving</h3>
    ${!v ? html`<p class="kd-card__note">Reading their gifts…</p>`
      : !v.success ? html`<p class="kd-card__note">Their giving couldn’t be read just now.</p>`
      : !v.gifts ? html`<p class="kd-card__note">No gifts in Zeffy count for them yet. Their page in Donors & Partners links the names they give under.</p>`
      : html`<dl class="kd-facts">
          <div><dt>Last 12 months</dt><dd>${usd(v.cents12)}</dd></div>
          <div><dt>All time</dt><dd>${usd(v.total)}, ${v.gifts} gift${v.gifts === 1 ? '' : 's'}</dd></div>
          ${v.latest ? html`<div><dt>Latest gift</dt><dd>${usd(v.latest.cents)}, ${day(v.latest.at)}</dd></div>` : null}
        </dl>
        ${v.suggest ? html`<p class="kd-card__note">Their giving says Champion: $10,000 or more in 12 months. Their page in Donors & Partners can move them.</p>` : null}`}
    <div class="kd-card__actions"><a class="btn btn-ghost btn-sm" href=${page}>${v?.gifts ? 'See their giving' : 'Their page in Donors'}</a></div>
  </section>`;
}
