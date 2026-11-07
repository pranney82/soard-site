/**
 * SOARD's facts: what a donation form, a grant, a matching gift or an introduction asks for. One card, on the board's
 * Documents and the advisors'.
 */
import { h, htm, useState, useEffect, useRef } from '../vendor.js';
import { Icon, useKept, nbw, mapsHref } from './parts.js';

const html = htm.bind(h);
const rise = (i) => `--i:${i}`;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0];

// ─── SOARD's facts ──────────────────────────────────────────────────
// What a donation form, a grant, a matching gift or an introduction asks for, as the site has it saved (/api/board-portal's
// `org`, ../../functions/api/_org-facts.js): edited in Site Config → Organization & contact, never here
export const lineOf = (a) => (a?.street ? [a.street, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '');
/** Two names that are the same letters and digits ("SOARD" isn't "Sunshine on a Ranney Day") */
const sameNameish = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** The facts in the order a form asks for them: { id, label, value, copy, href, ext, note, wide, list } */
export function factsOf(org, numbers) {
  if (!org) return [];
  const irs = org.irs?.exempt ? org.irs : null;
  const imp = numbers?.impact?.kids ? numbers.impact : null;
  const since = imp?.byYear?.[0]?.year;
  const phone = String(org.phone || '').replace(/\D/g, '');
  return [
    { id: 'name', label: 'Name', value: org.name, note: org.shortName && !sameNameish(org.shortName, org.name) ? `Also ${org.shortName}` : '' },
    org.legalName && !sameNameish(org.legalName, org.name) ? { id: 'legal', label: 'Legal name', value: org.legalName, note: 'As the IRS has it' } : null,
    { id: 'ein', label: 'EIN', value: org.ein, note: 'Federal tax ID' },
    irs ? { id: 'status', label: 'Tax status', value: '501(c)(3) public charity', copy: `501(c)(3) public charity${irs.publicCharity ? `, ${irs.publicCharity}` : ''}${irs.since ? `, since ${irs.since}` : ''}. Gifts are tax-deductible.`,
      // (each part whole on its line: never "509(a)" here and "(1)" on the next)
      note: [irs.since && `Since ${irs.since}`, 'Gifts are tax-deductible', irs.publicCharity].filter(Boolean) } : null,
    { id: 'office', label: org.mailing ? 'Office' : 'Address', value: lineOf(org.address), href: org.address ? mapsHref(lineOf(org.address)) : null, ext: true },
    org.mailing ? { id: 'mailing', label: 'Mailing address', value: lineOf(org.mailing), note: 'For mail, checks and tax forms' } : null,
    { id: 'phone', label: 'Phone', value: org.phone, href: phone ? `tel:+1${phone.slice(-10)}` : null },
    { id: 'email', label: 'Email', value: org.email, href: org.email ? `mailto:${org.email}` : null },
    { id: 'website', label: 'Website', value: org.website, href: org.website ? `https://${org.website.replace(/^https?:\/\//, '')}` : null, ext: true },
    org.founded ? { id: 'founded', label: 'Founded', value: [org.founded, org.founders && `by ${org.founders}`].filter(Boolean).join(', ') } : null,
    imp ? { id: 'impact', label: 'Impact', value: nbw(`${imp.kids.toLocaleString()} kids served · ${imp.rooms.toLocaleString()} rooms built`), copy: `${imp.kids.toLocaleString()} kids served and ${imp.rooms.toLocaleString()} rooms built${since ? ` since ${since}` : ''}`, note: 'Counted the way the website counts' } : null,
    org.tagline ? { id: 'tagline', label: 'Tagline', value: org.tagline } : null,
    org.mission ? { id: 'mission', label: 'Mission', value: org.mission, wide: true } : null,
    org.vision ? { id: 'vision', label: 'Vision', value: org.vision, wide: true } : null,
    org.values?.length ? { id: 'values', label: 'Values', value: org.values.map((v) => (v.text ? `${v.name}: ${v.text}` : v.name)).join('\n'), list: org.values, wide: true } : null,
    org.bio ? { id: 'bio', label: 'SOARD in a few lines', value: org.bio, note: 'For an introduction or an email', wide: true } : null,
  ].filter((x) => x && String(x.value || '').trim()).map((x) => ({ copy: x.value, ...x }));
}
/** A fact's small print as words (the tax status's parts, joined) */
const factNote = (x) => (Array.isArray(x.note) ? x.note.join(' · ') : x.note || '');
/** Every fact as one block of text, the way a form asks: "EIN: 45-…" */
export const factsText = (facts) => facts.filter((x) => x.id !== 'bio').map((x) => (x.id === 'name' ? `${x.value}${x.note ? ` (${factNote(x).replace(/^Also /, '')})` : ''}` : `${x.label}: ${x.list ? `\n${x.copy}` : x.copy}`)).join('\n');
export const factHay = (x) => `${x.label} ${x.value} ${factNote(x)} ${{ ein: 'tax id taxpayer federal employer identification number', status: '501c3 501(c)(3) tax exempt deductible irs', office: 'address street location map', mailing: 'address mail po box', phone: 'telephone call number', email: 'contact', website: 'url web site', mission: 'mission statement', bio: 'boilerplate about elevator pitch', name: 'organization', legal: 'organization' }[x.id] || ''}`;
/** The papers forms ask for next, by their titles on Documents */
export const FORM_PAPERS = [[/w-?9/i, 'W-9'], [/501|determination|irs letter/i, 'IRS letter'], [/\bein\b/i, 'EIN letter'], [/permit|registration/i, 'Charity permit']];

export async function copyText(ctx, text, said) {
  try { await navigator.clipboard.writeText(text); ctx.say(said); return true; } catch { ctx.say('Couldn’t copy. Press and hold the words instead.', 'warn'); return false; }
}
/** The copy button: a tick for a moment once it's copied */
export function CopyBtn({ text, label, ctx, said, cls = '' }) {
  const [done, setDone] = useState(false);
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  const go = async () => { if (await copyText(ctx, text, said || `${label} copied`)) { setDone(true); clearTimeout(t.current); t.current = setTimeout(() => setDone(false), 1600); } };
  return html`<button type="button" class=${`bp-iconbtn bp-org__copy ${done ? 'is-done' : ''} ${cls}`} onClick=${go} aria-label=${`Copy ${label}`} title="Copy" data-autofocus><${Icon} name=${done ? 'check' : 'copy'} size=${16} /></button>`;
}

/** A fact's words: a link when it's a place, a call or an address to write to; values as a list */
const FactValue = ({ x }) => (x.list ? html`<ul class="bp-org__values">${x.list.map((v) => html`<li key=${v.name}><strong>${v.name}</strong>${v.text ? html`<span>${v.text}</span>` : null}</li>`)}</ul>`
  : x.href ? html`<a class="bp-org__link" href=${x.href} target=${x.ext ? '_blank' : null} rel=${x.ext ? 'noopener' : null}>${x.value}</a>` : x.value);
/** One fact: its label, its words, its copy button (its own component, so the tick outlives the page's next render) */
const FactRow = ({ x, ctx }) => html`<div class=${`bp-org__fact ${x.wide ? 'is-wide' : ''}`} id=${`fact-${x.id}`}>
  <dt>${x.label}</dt>
  <dd><span class="bp-org__v"><${FactValue} x=${x} />${Array.isArray(x.note) ? html`<span class="bp-org__note">${x.note.map((n, i) => html`${i ? ' · ' : ''}<span class="bp-nowrap" key=${n}>${n}</span>`)}</span>` : x.note ? html`<span class="bp-org__note">${x.note}</span>` : null}</span><${CopyBtn} text=${x.copy} label=${x.label} ctx=${ctx} /></dd>
</div>`;

/** The six a form asks for first, in that order; the rest are a click away */
function keyFacts(all) {
  const has = (id) => all.some((x) => x.id === id);
  return [has('legal') ? 'legal' : 'name', 'ein', 'status', has('mailing') ? 'mailing' : 'office', 'phone', 'email'].map((id) => all.find((x) => x.id === id)).filter(Boolean);
}

/**
 * SOARD's facts, small: the six a form asks for first, the rest (the mission, the website, the founding, the impact…)
 * folded under them, as each member left it last (a search landing on one opens them). Copy all and Print take every
 * fact; the brand is the website's own page, /branding/
 */
export function OrgFacts({ ctx, terms = [], match = () => true, focus = null, papers: forms = [] }) {
  const { data } = ctx;
  const all = factsOf(data.org, data.numbers);
  const key = keyFacts(all);
  const rest = all.filter((x) => !key.includes(x));
  const [open, setOpen] = useKept('org-all', false);
  const [landed] = useState(() => typeof focus === 'string' && rest.some((x) => focus === `fact-${x.id}`));
  if (!all.length) return null;
  const found = terms.length ? all.filter((x) => match(factHay(x), terms)) : null;
  if (found && !found.length) return null;
  const shown = open || landed;
  const papers = found ? [] : forms;
  // A one-page fact sheet: the page prints this card alone, every fact in it
  const print = () => {
    const root = document.documentElement;
    root.classList.add('bp-printing-org');
    const done = () => { root.classList.remove('bp-printing-org'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    requestAnimationFrame(() => window.print());
  };
  const who = data.contact;
  const rows = (list) => html`${list.some((x) => !x.wide) ? html`<dl class="bp-org__grid">${list.filter((x) => !x.wide).map((x) => html`<${FactRow} x=${x} ctx=${ctx} key=${x.id} />`)}</dl>` : null}
    ${list.some((x) => x.wide) ? html`<dl class="bp-org__wide">${list.filter((x) => x.wide).map((x) => html`<${FactRow} x=${x} ctx=${ctx} key=${x.id} />`)}</dl>` : null}`;
  return html`<section class=${`bp-card bp-gap bp-org bp-rise ${shown || found ? 'is-open' : ''}`} style=${rise(1)} aria-labelledby="org-h" id="org">
    <div class="bp-org__head">
      <h2 class="bp-h2" id="org-h">SOARD’s facts</h2>
      ${found ? null : html`<p class="bp-org__acts bp-noprint">
        <button type="button" class="bp-btn bp-btn--sm bp-btn--quiet" onClick=${() => copyText(ctx, factsText(all), 'Copied all of SOARD’s facts')}><${Icon} name="copy" size=${16} />Copy all</button>
        <button type="button" class="bp-btn bp-btn--sm bp-btn--quiet" onClick=${print}><${Icon} name="print" size=${16} />Print</button>
      </p>`}
    </div>
    <p class="bp-printonly bp-org__printhead" aria-hidden="true">${data.org.name}</p>
    ${found ? rows(found) : html`${rows(key)}<div class=${`bp-org__rest ${shown ? '' : 'is-folded'}`} id="org-rest">${rows(rest)}</div>`}
    ${found ? null : html`<div class="bp-org__foot bp-noprint">
      ${rest.length ? html`<button type="button" class="bp-org__toggle" aria-expanded=${shown} aria-controls="org-rest" onClick=${() => setOpen(!shown)}>${shown ? 'Fewer facts' : 'All of SOARD’s facts'}<${Icon} name="chevron" size=${16} cls=${shown ? 'is-up' : ''} /></button>` : null}
      ${papers.length ? html`<p class="bp-org__papers">${papers.map((p) => html`<a class="bp-chip bp-chip--link" ...${p.link} key=${p.x.id}><${Icon} name="documents" size=${14} />${p.word}</a>`)}</p>` : null}
      <p class="bp-org__more"><a class="bp-link" href="/branding/" target="_blank" rel="noopener">Logos, colors and fonts<${Icon} name="external" size=${13} /></a>${who?.email ? html`<span aria-hidden="true">·</span><span>Something out of date? <a class="bp-link" href=${`mailto:${who.email}?subject=${encodeURIComponent('SOARD’s facts')}`}>Tell ${firstName(who.name)}</a></span>` : null}</p>
    </div>`}
  </section>`;
}
