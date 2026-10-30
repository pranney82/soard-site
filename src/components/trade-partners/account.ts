/**
 * A trade partner's own page (/trade-partners/account/)
 * ===========================================================================
 * The link from an email carries its token in the address (#t=…); it's kept
 * on this device (an insurance agent's only for the visit) and taken out of
 * the address bar. The page reads everything in one call (/api/vendor-docs →
 * partnerView) and draws:
 *   - an overview: setup progress, a tile per thing on file (company, W-9,
 *     insurance, payments) and their invoices
 *   - each thing as a focused step, the site's header and footer out of the
 *     way, Back going back (window.__tpPop, gated in the page ahead of the router)
 *   - for an agent's link, only the certificate
 * Files are checked as soon as they're added (./files.ts gets them ready);
 * forms save through /api/trade-partner. English and Spanish (./account-words.ts).
 */
import { WORDS, CERTIFICATION, type Words } from './account-words';
import { TRADE_ES, requirementLines, startLang, keepLang, type Lang } from './words';
import { prepare, pagePictures, thumbnail, isPdf, sizeText, MAX_BYTES } from './files';

type Step = 'company' | 'w9' | 'coi' | 'bank';
const STEPS: Step[] = ['company', 'w9', 'coi', 'bank'];
const KEY = 'soard-tp-token';

let root: HTMLElement;
let lang: Lang = 'en';
let T: Words = WORDS.en;
let token = '';
let jumpTo: Step | null = null;
let v: any = null;       // partnerView
let step: Step | null = null;
let setupRun = false;    // stepping through setup: Save goes on to the next thing needed
let closing = false;     // a step closed from the page: the history entry it pushed is being stepped back over
let shown: any = {};     // the preview keeps nothing on the server: this visit's answers, so its steps carry on as a vendor's would

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const html = (s: string) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content; };
const day = (iso: string | null, long = true) => {
  if (!iso) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', long ? { month: 'long', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};
const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tradeLabel = (t: string) => (lang === 'es' ? TRADE_ES[t] || t : t);
const ICON = {
  company: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1"/>',
  w9: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  coi: '<path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  bank: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="14" r="3.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
};
const svg = (k: keyof typeof ICON, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

// ─── Talking to the site ────────────────────────────────────────────

async function load() {
  const r = await fetch(`/api/vendor-docs?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) return { gone: r.status === 404 || r.status === 410, error: d.error || T.failed };
  v = d.vendor;
  if (v.preview) keepShown();
  return { ok: true };
}

function keepShown() {
  if (shown.company) { v.company = { ...v.company, ...shown.company }; v.steps.company = true; }
  if (shown.w9) v.docs.w9 = 'current';
  if (shown.coi) for (const k of ['gl', 'wc']) if (v.docs[k] !== 'not-needed') v.docs[k] = 'current';
  if (shown.agent) v.agent = shown.agent;
  if (shown.bank) v.bank = shown.bank;
}

const post = (body: any) => fetch('/api/trade-partner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token, lang }) })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }))
  .catch(() => ({ status: 0, ok: false, error: T.failed }));

// ─── The frame ──────────────────────────────────────────────────────

function setLang(next: Lang, save = true) {
  lang = next;
  T = WORDS[next];
  document.documentElement.lang = next;
  if (save) {
    keepLang(next);
    if (token && v?.scope === 'vendor' && !v.preview) post({ action: 'lang' });
  }
}

function draw() {
  if (!v) return;
  if (v.scope === 'agent') return drawAgent();
  if (step) return drawStep();
  drawOverview();
}

function langButton() {
  return `<button type="button" class="tpa-lang" data-act="lang" lang="${lang === 'es' ? 'en' : 'es'}">${esc(T.otherLang)}</button>`;
}

// ─── Signing in ─────────────────────────────────────────────────────

function drawSignIn(message = '') {
  document.documentElement.classList.remove('tpa-focus');
  root.replaceChildren(html(`
    <div class="tpa-narrow">
      <div class="tpa-card tpa-signin">
        <div class="tpa-row"><p class="tpa-eyebrow">${esc(T.eyebrow)}</p>${langButton()}</div>
        <h1 class="tpa-h1">${esc(T.signTitle)}</h1>
        ${message ? `<p class="tpa-callout" role="alert">${esc(message)}</p>` : ''}
        <p class="tpa-lead">${esc(T.signBody)}</p>
        <form class="tpa-form" data-form="signin" novalidate>
          <label class="tpa-field"><span class="tpa-label">${esc(T.emailLabel)}</span><input name="email" type="email" autocomplete="email" inputmode="email" required></label>
          <button class="tpa-btn tpa-btn--primary tpa-btn--wide" type="submit">${esc(T.signBtn)}</button>
          <p class="tpa-note" data-note role="status" aria-live="polite" hidden></p>
        </form>
        <p class="tpa-small">${esc(T.newHere)} <a href="/trade-partners/#start">${esc(T.workWithUs)}</a></p>
      </div>
    </div>`));
  const form = root.querySelector<HTMLFormElement>('[data-form=signin]')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input')!;
    const note = form.querySelector<HTMLElement>('[data-note]')!;
    const btn = form.querySelector<HTMLButtonElement>('button')!;
    const email = input.value.trim();
    note.hidden = false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { note.textContent = T.emailBad; note.dataset.tone = 'fix'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    input.removeAttribute('aria-invalid');
    btn.disabled = true; btn.textContent = T.sending;
    const r = await fetch('/api/trade-partner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'signin', email, lang }) })
      .then((x) => x.json()).catch(() => ({ ok: false, error: T.failed }));
    btn.disabled = false; btn.textContent = T.signBtn;
    note.textContent = r.ok ? T.signSent(email) : (r.error || T.failed);
    note.dataset.tone = r.ok ? 'good' : 'fix';
  });
}

// ─── The overview ───────────────────────────────────────────────────

function tileState(k: Step) {
  const d = v.docs;
  if (k === 'company') return v.steps.company ? 'done' : 'needed';
  if (k === 'w9') return d.notNeeded || d.w9 !== 'missing' ? 'done' : 'needed';
  if (k === 'coi') {
    if (d.notNeeded || d.w9Only) return 'done';
    const s = [d.gl, d.wc].filter((x: string) => x !== 'not-needed');
    if (s.some((x: string) => x === 'missing' || x === 'expired')) return v.agent?.askedAt ? 'waiting' : 'needed';
    return s.includes('expiring') ? 'soon' : 'done';
  }
  if (!v.bank) return 'needed';
  return v.bank.status === 'pending' ? 'checking' : 'done';
}

function tileText(k: Step) {
  const d = v.docs;
  if (k === 'company') {
    const c = v.company;
    if (!v.steps.company || !c) return T.companyEmpty;
    return [c.name, (c.trades || []).slice(0, 3).map(tradeLabel).join(', '), c.address ? `${c.address.city}, ${c.address.state}` : ''].filter(Boolean).join(' · ');
  }
  if (k === 'w9') return d.w9 !== 'missing' || d.notNeeded ? T.w9Have : T.w9Need;
  if (k === 'coi') {
    const st = tileState('coi');
    if (st === 'waiting') return T.coiAsked(v.agent.name || v.agent.email, day(v.agent.askedAt));
    if (st === 'done' || st === 'soon') {
      const ends = [d.have.glExpires, d.have.wcExpires].filter(Boolean).sort()[0];
      return ends ? T.coiHave(day(ends)) : T.w9Have;
    }
    const ended = [d.gl === 'expired' && d.have.glExpires, d.wc === 'expired' && d.have.wcExpires].filter(Boolean).sort()[0];
    return ended ? T.coiExpired(day(ended)) : T.coiNeed;
  }
  if (!v.bank) return T.bankNone;
  const kind = T.kinds[Object.keys(WORDS.en.kinds).find((x) => WORDS.en.kinds[x] === v.bank.kind) || ''] || v.bank.kind || '';
  return v.bank.status === 'pending' ? T.bankPending(kind, v.bank.last4) : T.bankOk(kind, v.bank.last4);
}

function tileButton(k: Step, st: string) {
  const b = T.btn;
  const label = k === 'company' ? (st === 'done' ? b.company : b.companyAdd)
    : k === 'w9' ? (st === 'done' ? b.w9New : b.w9)
      : k === 'coi' ? (st === 'done' ? b.coiNew : b.coi)
        : (v.bank ? b.bankNew : b.bank);
  return `<button type="button" class="tpa-btn ${st === 'done' || st === 'checking' ? 'tpa-btn--quiet' : 'tpa-btn--primary'}" data-act="open" data-step="${k}">${esc(label)}</button>`;
}

function drawOverview() {
  document.documentElement.classList.remove('tpa-focus');
  const done = STEPS.filter((k) => ['done', 'checking', 'soon'].includes(tileState(k))).length;
  const next = STEPS.find((k) => !['done', 'checking', 'soon', 'waiting'].includes(tileState(k)));
  const who = v.signInEmail ? `${esc(T.signedInAs)} ${esc(v.signInEmail)} · ` : '';
  const invoices = v.invoices || [];
  root.replaceChildren(html(`
    <div class="tpa-wrap">
      ${v.preview ? `<p class="tpa-callout">${esc(T.preview)}</p>` : ''}
      <header class="tpa-head">
        <div class="tpa-row"><p class="tpa-eyebrow">${esc(T.eyebrow)}</p>${langButton()}</div>
        <h1 class="tpa-h1">${esc(v.company?.name || v.name)}</h1>
        <p class="tpa-who">${who}<button type="button" class="tpa-link" data-act="signout">${esc(T.signOut)}</button></p>
      </header>
      ${next ? `
        <section class="tpa-setup" aria-labelledby="tpa-setup-h">
          <div class="tpa-setup-text">
            <h2 id="tpa-setup-h">${esc(T.setupTitle)}</h2>
            <p>${esc(T.setupBody(done))}</p>
            <div class="tpa-meter" role="progressbar" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${done}" aria-label="${esc(T.setupTitle)}">${STEPS.map((k) => `<span class="${['done', 'checking', 'soon'].includes(tileState(k)) ? 'is-done' : ''}"></span>`).join('')}</div>
          </div>
          <button type="button" class="tpa-btn tpa-btn--primary tpa-btn--lg" data-act="setup">${esc(done ? T.continue : T.start)}</button>
        </section>` : `<p class="tpa-allset">${svg('check', 'tpa-allset-icon')}<span>${esc(T.setupDone)}</span></p>`}
      <div class="tpa-tiles">
        ${STEPS.map((k) => {
          const st = tileState(k);
          return `<article class="tpa-tile" data-state="${st}">
            <div class="tpa-tile-top"><span class="tpa-tile-icon">${svg(k)}</span><span class="tpa-chip" data-tone="${st}">${esc(T.chip[st as keyof typeof T.chip] || '')}</span></div>
            <h2 class="tpa-tile-title">${esc(T.tiles[k])}</h2>
            <p class="tpa-tile-text">${esc(tileText(k))}</p>
            ${tileButton(k, st)}
          </article>`;
        }).join('')}
      </div>
      <section class="tpa-invoices" aria-labelledby="tpa-inv-h">
        <h2 id="tpa-inv-h" class="tpa-h2">${esc(T.invoicesTitle)}</h2>
        ${invoices.length ? `<ul class="tpa-inv-list">${invoices.map((i: any) => `
          <li class="tpa-inv" data-status="${i.status}">
            <div class="tpa-inv-main"><span class="tpa-inv-no">${esc(T.invoiceNo(i.number))}</span><span class="tpa-inv-date">${esc(day(i.date, false))}</span></div>
            <span class="tpa-inv-amt">${money(i.cents)}</span>
            <span class="tpa-inv-status">${esc(i.status === 'paid' ? T.status.paid(day(i.paidAt || i.date, false)) : i.status === 'held' ? (i.heldFor === 'bank' ? T.status.heldBank : T.status.heldDocuments) : T.status[i.status as 'received'] || '')}</span>
          </li>`).join('')}</ul>` : `<p class="tpa-empty">${esc(T.invoicesEmpty)}</p>`}
      </section>
      <section class="tpa-help"><h2 class="tpa-h3">${esc(T.helpTitle)}</h2><p>${esc(T.helpBody)}</p></section>
    </div>`));
}

// ─── A step, focused ────────────────────────────────────────────────

function openStep(k: Step, { push = true, run = setupRun } = {}) {
  step = k;
  setupRun = run;
  if (push) history.pushState({ tpStep: k }, '');
  drawStep();
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => root.querySelector<HTMLElement>('.tpa-step h1')?.focus());
}

function closeStep({ pop = false } = {}) {
  if (!step) return;
  step = null;
  setupRun = false;
  // The step's history entry goes too, so Back from the overview leaves the page as it should
  if (!pop && history.state?.tpStep) { closing = true; history.back(); } else draw();
}

/** The next thing setup still needs after `k`, or null */
function nextNeeded(k: Step): Step | null {
  const after = STEPS.slice(STEPS.indexOf(k) + 1);
  return after.find((x) => ['needed'].includes(tileState(x))) || null;
}

async function finishStep(k: Step) {
  await load();
  const next = setupRun ? nextNeeded(k) : null;
  if (next) { step = next; history.replaceState({ tpStep: next }, ''); drawStep(); window.scrollTo({ top: 0 }); root.querySelector<HTMLElement>('.tpa-step h1')?.focus(); }
  else closeStep();
}

function stepFrame(k: Step, body: string) {
  const i = STEPS.indexOf(k) + 1;
  return `
    <div class="tpa-step" data-step="${k}">
      <div class="tpa-bar">
        <button type="button" class="tpa-backlink" data-act="close">${svg('back')}<span>${esc(T.yourPage)}</span></button>
        ${setupRun ? `<span class="tpa-stepof">${esc(T.stepOf(i))}</span>` : ''}
        ${langButton()}
      </div>
      ${setupRun ? `<div class="tpa-segs" aria-hidden="true">${STEPS.map((x, j) => `<span class="${j < i - 1 || ['done', 'checking', 'soon'].includes(tileState(x)) ? 'is-done' : j === i - 1 ? 'is-now' : ''}"></span>`).join('')}</div>` : ''}
      <div class="tpa-step-body">${body}</div>
    </div>`;
}

function drawStep() {
  document.documentElement.classList.add('tpa-focus');
  const k = step!;
  const body = k === 'company' ? companyForm() : k === 'w9' ? w9Step() : k === 'coi' ? coiStep() : bankStep();
  root.replaceChildren(html(stepFrame(k, body)));
  if (k === 'w9') wireW9();
  if (k === 'coi') wireCoi();
  if (k === 'company') wireForm('company', companyBody, (r, sent) => { if (r.preview) shown.company = sent; finishStep('company'); });
  if (k === 'bank') wireBank();
}

// ─── Fields ─────────────────────────────────────────────────────────

const field = (name: string, label: string, o: { value?: string; type?: string; auto?: string; mode?: string; hint?: string; cls?: string; max?: number; req?: boolean; attrs?: string } = {}) => `
  <label class="tpa-field ${o.cls || ''}"><span class="tpa-label">${esc(label)}</span>
    <input name="${name}" type="${o.type || 'text'}" ${o.auto ? `autocomplete="${o.auto}"` : ''} ${o.mode ? `inputmode="${o.mode}"` : ''} ${o.max ? `maxlength="${o.max}"` : ''} ${o.req === false ? '' : 'required'} value="${esc(o.value || '')}" ${o.attrs || ''}>
    ${o.hint ? `<span class="tpa-hint">${esc(o.hint)}</span>` : ''}
  </label>`;

const navBar = (label: string) => `
  <p class="tpa-error" data-error role="alert" hidden></p>
  <div class="tpa-nav">
    <button type="button" class="tpa-btn tpa-btn--quiet" data-act="close">${esc(T.back)}</button>
    <button type="submit" class="tpa-btn tpa-btn--primary" data-submit>${esc(label)}</button>
  </div>`;

function showError(form: HTMLElement, words: string, field?: string | null) {
  const err = form.querySelector<HTMLElement>('[data-error]')!;
  err.textContent = words;
  err.hidden = false;
  for (const x of form.querySelectorAll('[aria-invalid]')) x.removeAttribute('aria-invalid');
  const map: Record<string, string> = { street: 'street', city: 'city', state: 'state', zip: 'zip', mainName: 'mainName', mainEmail: 'mainEmail', mainPhone: 'mainPhone', billingEmail: 'billingEmail', name: 'name', trades: 'trades' };
  const el = field ? form.querySelector<HTMLElement>(`[name="${map[field] || field}"]`) : null;
  if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } else err.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** A form that posts one action: busy while it does, its error beside the field */
function wireForm(action: string, body: (f: HTMLFormElement) => any, done: (r: any, sent: any) => void) {
  const form = root.querySelector<HTMLFormElement>(`form[data-form="${action}"]`)!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector<HTMLButtonElement>('[data-submit]')!;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = T.saving;
    form.querySelector<HTMLElement>('[data-error]')!.hidden = true;
    const sent = body(form);
    const r = await post({ action, ...sent });
    btn.disabled = false; btn.textContent = label;
    if (!r.ok) return showError(form, r.problems ? `${T.w9Problems} ${Object.values(r.problems).join(' ')}` : r.error || T.failed, r.field || (r.problems ? Object.keys(r.problems)[0] : null));
    done(r, sent);
  });
}

// ─── Company ────────────────────────────────────────────────────────

function companyForm() {
  const c = v.company || {};
  const a = c.address || {};
  const m = c.main || {};
  const picked = new Set(c.trades || []);
  return `
    <h1 class="tpa-h1" tabindex="-1">${esc(T.companyTitle)}</h1>
    <p class="tpa-lead">${esc(T.companyLead)}</p>
    <form class="tpa-form" data-form="company" novalidate>
      ${field('name', T.companyName, { value: c.name || v.name, auto: 'organization', max: 120 })}
      <fieldset class="tpa-field"><legend class="tpa-label">${esc(T.trades)} <span class="tpa-hint-inline">${esc(T.tradesHint)}</span></legend>
        <div class="tpa-chips">${(v.trades || []).map((t: string) => `<label class="tpa-pick"><input type="checkbox" name="trades" value="${esc(t)}" ${picked.has(t) ? 'checked' : ''}><span>${esc(tradeLabel(t))}</span></label>`).join('')}</div>
      </fieldset>
      <fieldset class="tpa-group"><legend class="tpa-label tpa-label--group">${esc(T.address)}</legend>
        <div class="tpa-grid">
          ${field('street', T.street, { value: a.street, auto: 'address-line1', cls: 'tpa-span', max: 80 })}
          ${field('unit', T.unit, { value: a.unit, auto: 'address-line2', req: false, max: 30 })}
          ${field('city', T.city, { value: a.city, auto: 'address-level2', max: 50 })}
          <div class="tpa-pair">${field('state', T.state, { value: a.state || 'GA', auto: 'address-level1', max: 2, attrs: 'autocapitalize="characters"' })}${field('zip', T.zip, { value: a.zip, auto: 'postal-code', mode: 'numeric', max: 10 })}</div>
        </div>
      </fieldset>
      ${field('license', T.license, { value: c.license, req: false, max: 60, hint: T.licenseHint })}
      <fieldset class="tpa-group"><legend class="tpa-label tpa-label--group">${esc(T.mainTitle)}</legend>
        <div class="tpa-grid">
          ${field('mainName', T.mainName, { value: m.name, auto: 'name', max: 80 })}
          ${field('mainPhone', T.mainPhone, { value: m.phone ? m.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') : '', type: 'tel', auto: 'tel', mode: 'tel', max: 20 })}
          ${field('mainEmail', T.mainEmail, { value: m.email, type: 'email', auto: 'email', mode: 'email', cls: 'tpa-span', max: 120 })}
          ${field('billingEmail', T.billingEmail, { value: c.billing?.email, type: 'email', mode: 'email', cls: 'tpa-span', req: false, max: 120, hint: T.billingHint })}
        </div>
      </fieldset>
      ${navBar(setupRun ? T.saveNext : T.save)}
    </form>`;
}

function companyBody(f: HTMLFormElement) {
  const g = (n: string) => (f.querySelector<HTMLInputElement>(`[name="${n}"]`)?.value || '').trim();
  return {
    name: g('name'), trades: [...f.querySelectorAll<HTMLInputElement>('input[name=trades]:checked')].map((x) => x.value), license: g('license'),
    address: { street: g('street'), unit: g('unit'), city: g('city'), state: g('state'), zip: g('zip') },
    main: { name: g('mainName'), email: g('mainEmail'), phone: g('mainPhone') }, billing: { email: g('billingEmail') },
  };
}

// ─── The W-9 ────────────────────────────────────────────────────────

function w9Step() {
  const c = v.company || {};
  const a = c.address || {};
  const today = day(new Date().toISOString());
  const classes = Object.entries(T.classes).map(([k, label]) => `<label class="tpa-radio"><input type="radio" name="taxClass" value="${k}" ${k === 'llc' && /\bllc\b/i.test(c.name || '') ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('');
  return `
    <h1 class="tpa-h1" tabindex="-1">${esc(T.w9Title)}</h1>
    <p class="tpa-lead">${esc(T.w9Lead)}</p>
    <div class="tpa-tabs" role="tablist">
      <button type="button" role="tab" class="tpa-tab" aria-selected="true" data-tab="online">${esc(T.w9Online)}</button>
      <button type="button" role="tab" class="tpa-tab" aria-selected="false" data-tab="upload">${esc(T.w9Upload)}</button>
    </div>
    <div data-pane="online">
      <form class="tpa-form" data-form="w9" novalidate>
        ${field('w9name', T.w9Name, { value: c.main?.name || '', auto: 'name', hint: T.w9NameHint, max: 120 })}
        ${field('business', T.w9Business, { value: c.name || '', auto: 'organization', req: false, max: 120 })}
        <fieldset class="tpa-field"><legend class="tpa-label">${esc(T.w9Class)}</legend><div class="tpa-radios">${classes}</div></fieldset>
        <fieldset class="tpa-field" data-if="llc" hidden><legend class="tpa-label">${esc(T.llcClass)}</legend>
          <div class="tpa-radios tpa-radios--row">${Object.entries(T.llcOpts).map(([k, l]) => `<label class="tpa-radio"><input type="radio" name="llcClass" value="${k}"><span>${esc(l)}</span></label>`).join('')}</div>
          <span class="tpa-hint">${esc(T.llcHint)}</span>
        </fieldset>
        <div data-if="other" hidden>${field('otherClass', T.otherClass, { req: false, max: 60 })}</div>
        <label class="tpa-check" data-if="foreign" hidden><input type="checkbox" name="foreignPartners"><span>${esc(T.foreign)}</span></label>
        <details class="tpa-more"><summary>${esc(T.exemptions)}</summary><div class="tpa-pair">${field('exemptPayee', T.exemptPayee, { req: false, max: 4 })}${field('fatca', T.fatca, { req: false, max: 4 })}</div></details>
        ${field('w9address', T.street, { value: [a.street, a.unit].filter(Boolean).join(', '), auto: 'street-address', max: 80 })}
        ${field('cityStateZip', T.cityStateZip, { value: a.city ? `${a.city}, ${a.state} ${a.zip}` : '', max: 80 })}
        <fieldset class="tpa-field"><legend class="tpa-label">${esc(T.tinTitle)}</legend>
          <div class="tpa-radios tpa-radios--row"><label class="tpa-radio"><input type="radio" name="tinType" value="ein" checked><span>${esc(T.ein)}</span></label><label class="tpa-radio"><input type="radio" name="tinType" value="ssn"><span>${esc(T.ssn)}</span></label></div>
          <input name="tin" class="tpa-tin" inputmode="numeric" autocomplete="off" required placeholder="12-3456789" aria-label="${esc(T.tinTitle)}" maxlength="11">
          <span class="tpa-hint">${esc(T.tinHint)}</span>
        </fieldset>
        <div class="tpa-cert">
          <p class="tpa-label">${esc(T.certTitle)}</p>
          ${T.certNote ? `<p class="tpa-hint">${esc(T.certNote)}</p>` : ''}
          <div class="tpa-cert-text" lang="en">${CERTIFICATION.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
          <label class="tpa-check"><input type="checkbox" name="backupWithholding"><span>${esc(T.backup)}</span></label>
          <label class="tpa-check tpa-check--strong"><input type="checkbox" name="certify" required><span>${esc(T.certify)}</span></label>
        </div>
        <label class="tpa-field tpa-sign"><span class="tpa-label">${esc(T.signature)}</span><input name="signature" autocomplete="name" required maxlength="80"><span class="tpa-hint">${esc(T.signedOn(today))}</span></label>
        ${navBar(T.signSend)}
      </form>
    </div>
    <div data-pane="upload" hidden>${dropZone('w9', false)}</div>`;
}

function wireW9() {
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const t of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
      for (const p of root.querySelectorAll<HTMLElement>('[data-pane]')) p.hidden = p.dataset.pane !== tab.dataset.tab;
    });
  }
  const form = root.querySelector<HTMLFormElement>('form[data-form=w9]')!;
  const sync = () => {
    const cls = form.querySelector<HTMLInputElement>('input[name=taxClass]:checked')?.value;
    const llc = form.querySelector<HTMLInputElement>('input[name=llcClass]:checked')?.value;
    form.querySelector<HTMLElement>('[data-if=llc]')!.hidden = cls !== 'llc';
    form.querySelector<HTMLElement>('[data-if=other]')!.hidden = cls !== 'other';
    form.querySelector<HTMLElement>('[data-if=foreign]')!.hidden = !(cls === 'partnership' || cls === 'trust' || (cls === 'llc' && llc === 'P'));
    const ein = form.querySelector<HTMLInputElement>('input[name=tinType]:checked')?.value === 'ein';
    form.querySelector<HTMLInputElement>('input[name=tin]')!.placeholder = ein ? '12-3456789' : '123-45-6789';
  };
  form.addEventListener('change', sync);
  sync();
  // The tax ID shaped as it's typed: 12-3456789 or 123-45-6789
  const tin = form.querySelector<HTMLInputElement>('input[name=tin]')!;
  tin.addEventListener('input', () => {
    const d = tin.value.replace(/\D/g, '').slice(0, 9);
    const ein = form.querySelector<HTMLInputElement>('input[name=tinType]:checked')?.value === 'ein';
    tin.value = ein ? (d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d) : [d.slice(0, 3), d.slice(3, 5), d.slice(5)].filter(Boolean).join('-');
  });
  wireForm('w9', (f) => {
    const g = (n: string) => (f.querySelector<HTMLInputElement>(`[name="${n}"]`)?.value || '').trim();
    const on = (n: string) => !!f.querySelector<HTMLInputElement>(`[name="${n}"]`)?.checked;
    return { w9: {
      name: g('w9name'), business: g('business'), taxClass: f.querySelector<HTMLInputElement>('input[name=taxClass]:checked')?.value || '',
      llcClass: f.querySelector<HTMLInputElement>('input[name=llcClass]:checked')?.value || '', otherClass: g('otherClass'), foreignPartners: on('foreignPartners'),
      exemptPayee: g('exemptPayee'), fatca: g('fatca'), address: g('w9address'), cityStateZip: g('cityStateZip'),
      tinType: f.querySelector<HTMLInputElement>('input[name=tinType]:checked')?.value || 'ein', tin: g('tin'),
      backupWithholding: on('backupWithholding'), certify: on('certify'), signature: g('signature'),
    } };
  }, async (r) => {
    if (r.preview) shown.w9 = true;
    const body = root.querySelector<HTMLElement>('.tpa-step-body')!;
    body.replaceChildren(html(`<div class="tpa-done" tabindex="-1">${svg('check', 'tpa-done-icon')}<h1 class="tpa-h1">${esc(T.w9Done)}</h1></div>`));
    setTimeout(() => finishStep('w9'), 1400);
  });
  wireDrop('w9');
}

// ─── Insurance ──────────────────────────────────────────────────────

function holderBlock() {
  const lines = v.docs.holder || [];
  return `<div class="tpa-holder"><div><p class="tpa-label">${esc(T.holderTitle)}</p><p class="tpa-holder-text">${lines.map(esc).join('<br>')}</p></div>
    <button type="button" class="tpa-btn tpa-btn--quiet tpa-btn--small" data-act="copy" data-copy="${esc(lines.join('\n'))}">${esc(T.copy)}</button></div>`;
}

function requirements() {
  const d = v.docs;
  const lines = d.requirements;
  const m = lines && lines.length ? lines : [];
  const words = lang === 'es' && d.minimums ? requirementLines(d.minimums, d.holder?.[0] || 'Sunshine on a Ranney Day', 'es') : m;
  return `<ul class="tpa-reqs">${words.map((l: string) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

function coiStep() {
  const needs = v.docs.items.filter((i: any) => i.doc === 'coi');
  const agent = v.agent;
  return `
    <h1 class="tpa-h1" tabindex="-1">${esc(T.coiTitle)}</h1>
    <p class="tpa-lead">${esc(T.coiLead)}</p>
    ${needs.length ? `<ul class="tpa-needs">${needs.map((i: any) => `<li>${esc(i.text)}</li>`).join('')}</ul>` : ''}
    <div class="tpa-reqbox"><p class="tpa-label">${esc(T.coiNeeds)}</p>${requirements()}${holderBlock()}</div>
    <div class="tpa-tabs" role="tablist">
      <button type="button" role="tab" class="tpa-tab" aria-selected="true" data-tab="upload">${esc(T.coiUpload)}</button>
      <button type="button" role="tab" class="tpa-tab" aria-selected="false" data-tab="agent">${esc(T.coiAgent)}</button>
    </div>
    <div data-pane="upload">${dropZone('coi', true)}</div>
    <div data-pane="agent" hidden>
      <p class="tpa-small">${esc(T.agentLead)}</p>
      <form class="tpa-form" data-form="agent" novalidate>
        <div class="tpa-grid">
          ${field('name', T.agentName, { value: agent?.name, req: false, max: 80 })}
          ${field('agency', T.agency, { value: agent?.agency, req: false, max: 80 })}
          ${field('email', T.agentEmail, { value: agent?.email, type: 'email', mode: 'email', cls: 'tpa-span', max: 120 })}
          ${field('phone', T.agentPhone, { type: 'tel', mode: 'tel', req: false, max: 20 })}
        </div>
        ${navBar(T.agentSend)}
      </form>
    </div>`;
}

function wireCoi() {
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const t of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
      for (const p of root.querySelectorAll<HTMLElement>('[data-pane]')) p.hidden = p.dataset.pane !== tab.dataset.tab;
    });
  }
  wireDrop('coi');
  wireForm('agent', (f) => Object.fromEntries(['name', 'agency', 'email', 'phone'].map((n) => [n, (f.querySelector<HTMLInputElement>(`[name=${n}]`)?.value || '').trim()])), (r, sent) => {
    if (r.preview) shown.agent = { name: sent.name, email: sent.email, agency: sent.agency, askedAt: new Date().toISOString() };
    const pane = root.querySelector<HTMLElement>('[data-pane=agent]')!;
    pane.replaceChildren(html(`<div class="tpa-result" data-tone="good">${svg('check', 'tpa-result-icon')}<p>${esc(T.agentDone(r.agent || ''))}</p>
      <button type="button" class="tpa-btn tpa-btn--primary" data-act="next" data-step="coi">${esc(setupRun ? T.continue : T.yourPage)}</button></div>`));
  });
}

// ─── Adding files ───────────────────────────────────────────────────

const mobile = () => matchMedia('(pointer: coarse)').matches;

function dropZone(doc: 'w9' | 'coi', multiple: boolean) {
  return `
    <div class="tpa-drop" data-drop="${doc}" tabindex="-1">
      ${svg('upload', 'tpa-drop-icon')}
      <p class="tpa-drop-text">${esc(T.drop(doc === 'coi' ? T.coiWord : T.w9Word))}</p>
      <div class="tpa-drop-btns">
        <label class="tpa-btn tpa-btn--primary"><input type="file" class="tpa-file-input" accept="application/pdf,image/*" ${multiple ? 'multiple' : ''} data-pick>${esc(T.chooseFile)}</label>
        ${mobile() ? `<label class="tpa-btn tpa-btn--quiet">${svg('camera', 'tpa-btn-icon')}<input type="file" class="tpa-file-input" accept="image/*" capture="environment" data-pick>${esc(T.takePhoto)}</label>` : ''}
      </div>
      <p class="tpa-hint">${esc(T.fileHint)}</p>
    </div>
    <ul class="tpa-files" data-files></ul>
    <div data-result></div>`;
}

/** The files added in this step, kept so a second certificate goes with the first */
let picked: File[] = [];

function wireDrop(doc: 'w9' | 'coi') {
  picked = [];
  const zone = root.querySelector<HTMLElement>(`[data-drop="${doc}"]`);
  if (!zone) return;
  const limit = doc === 'w9' ? 1 : 3;
  const add = (files: File[]) => {
    if (!files.length) return;
    picked = doc === 'w9' ? files.slice(0, 1) : [...picked, ...files].slice(-limit);
    check(doc);
  };
  for (const input of zone.querySelectorAll<HTMLInputElement>('[data-pick]')) {
    input.addEventListener('change', () => { add([...(input.files || [])]); input.value = ''; });
  }
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove('is-over'); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); add([...(e.dataTransfer?.files || [])]); });
}

function fileCards(states: Map<File, string>) {
  const list = root.querySelector<HTMLElement>('[data-files]')!;
  list.replaceChildren(html(picked.map((f, i) => `
    <li class="tpa-file" data-i="${i}">
      <span class="tpa-file-thumb" data-thumb>${svg('file')}</span>
      <span class="tpa-file-main"><span class="tpa-file-name">${esc(f.name)}</span><span class="tpa-file-state" data-state>${esc(states.get(f) || sizeText(f.size))}</span></span>
      <button type="button" class="tpa-x" data-act="remove" data-i="${i}" aria-label="${esc(T.remove)} ${esc(f.name)}">×</button>
    </li>`).join('')));
  picked.forEach(async (f, i) => {
    const src = await thumbnail(f).catch(() => null);
    const slot = list.querySelector<HTMLElement>(`[data-i="${i}"] [data-thumb]`);
    if (src && slot) slot.replaceChildren(html(`<img src="${src}" alt="">`));
  });
}

const setStates = (words: string) => { for (const s of root.querySelectorAll<HTMLElement>('[data-files] [data-state]')) s.textContent = words; };

/** Send what's been added: ready it, send it with progress, show what came back */
async function check(doc: 'w9' | 'coi', anyway = false) {
  const result = root.querySelector<HTMLElement>('[data-result]')!;
  result.replaceChildren();
  fileCards(new Map());
  if (!picked.length) return;
  const zone = root.querySelector<HTMLElement>(`[data-drop="${doc}"]`)!;
  zone.setAttribute('aria-busy', 'true');
  setStates(T.stage.prepare);
  try {
    const ready: { file: File; pages: Blob[] }[] = [];
    for (const f of picked) {
      const shrinks = f.type.startsWith('image/') || /\.(hei[cf]|jpe?g|png|webp)$/i.test(f.name);
      if (!shrinks && f.size > MAX_BYTES) throw new Error(T.tooBig(f.name));
      const file = await prepare(f).catch(() => { throw new Error(T.wontOpen(f.name)); });
      if (!file) throw new Error(T.heicBad(f.name));
      if (file.size > MAX_BYTES) throw new Error(T.tooBig(f.name));
      ready.push({ file, pages: !anyway && isPdf(file) ? await pagePictures(file, doc === 'w9' ? 2 : 3) : [] });
    }
    const body = new FormData();
    body.set('token', token);
    body.set('doc', doc);
    body.set('website', '');
    ready.forEach(({ file, pages }, i) => { body.append('file', file); pages.forEach((b, n) => body.append(`pages${i}`, b, `page-${n + 1}.jpg`)); });
    if (anyway) body.set('anyway', '1');
    const d = await send(body, doc);
    if (!d.ok) throw new Error(d.error || T.failed);
    setStates(d.accepted ? '✓' : '');
    if (d.accepted) {
      if (d.preview) shown[doc] = true;
      result.replaceChildren(html(`<div class="tpa-result" data-tone="good" tabindex="-1">${svg('check', 'tpa-result-icon')}<div><p class="tpa-result-title">${esc(T.good)}</p>${(d.lines || []).length ? `<ul>${d.lines.map((l: string) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}</div>
        <button type="button" class="tpa-btn tpa-btn--primary" data-act="next" data-step="${doc}">${esc(setupRun && v.scope !== 'agent' ? T.continue : T.yourPage)}</button></div>`));
      if (v.scope === 'agent') result.querySelector('[data-act=next]')?.remove();
    } else if (d.look) {
      result.replaceChildren(html(`<div class="tpa-result" data-tone="good" tabindex="-1">${svg('check', 'tpa-result-icon')}<div><p class="tpa-result-title">${esc(anyway ? T.lookAnyway : T.look)}</p></div>
        ${v.scope === 'agent' ? '' : `<button type="button" class="tpa-btn tpa-btn--primary" data-act="next" data-step="${doc}">${esc(setupRun ? T.continue : T.yourPage)}</button>`}</div>`));
    } else {
      result.replaceChildren(html(`<div class="tpa-result" data-tone="fix" tabindex="-1"><div><p class="tpa-result-title">${esc(T.fix)}</p><ul>${(d.problems || []).map((p: string) => `<li>${esc(p)}</li>`).join('')}</ul>
        <p>${esc(doc === 'w9' ? T.fixHowW9 : T.fixHow)}</p><button type="button" class="tpa-link" data-act="anyway" data-doc="${doc}">${esc(T.anyway)}</button></div></div>`));
    }
    result.querySelector<HTMLElement>('.tpa-result')?.focus();
  } catch (e) {
    setStates('');
    result.replaceChildren(html(`<div class="tpa-result" data-tone="fix" tabindex="-1"><p>${esc((e as Error).message)}</p></div>`));
    result.querySelector<HTMLElement>('.tpa-result')?.focus();
  } finally {
    zone.removeAttribute('aria-busy');
  }
}

/** The upload, with its real progress, then the reading (the server's part) */
function send(body: FormData, doc: 'w9' | 'coi'): Promise<any> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | null = null;
    x.open('POST', '/api/vendor-docs');
    x.responseType = 'json';
    x.upload.onprogress = (e) => { if (e.lengthComputable) setStates(T.stage.send(Math.round((e.loaded / e.total) * 100))); };
    x.upload.onload = () => {
      setStates(T.stage.read);
      timer = setTimeout(() => setStates(doc === 'w9' ? T.stage.checkW9 : T.stage.check), 3500);
    };
    x.onload = () => { if (timer) clearTimeout(timer); resolve(x.response || { ok: false }); };
    x.onerror = () => { if (timer) clearTimeout(timer); resolve({ ok: false, error: T.failed }); };
    x.send(body);
  });
}

// ─── Bank details ───────────────────────────────────────────────────

function bankStep() {
  const b = v.bank;
  const kindKey = b ? Object.keys(WORDS.en.kinds).find((x) => WORDS.en.kinds[x] === b.kind) || '' : '';
  const current = b ? `<p class="tpa-current">${esc(T.bankCurrent(T.kinds[kindKey] || b.kind || '', b.last4, b.status === 'confirmed'))}</p>` : '';
  if (!v.bankFresh && !v.preview) {
    return `
      <h1 class="tpa-h1" tabindex="-1">${esc(T.bankTitle)}</h1>
      ${current}
      <div class="tpa-card tpa-fresh"><h2 class="tpa-h3">${esc(T.bankFreshTitle)}</h2><p>${esc(T.bankFresh)}</p>
        <button type="button" class="tpa-btn tpa-btn--primary" data-act="bank-link">${esc(T.bankFreshBtn)}</button><p class="tpa-note" data-note role="status" aria-live="polite" hidden></p></div>`;
  }
  return `
    <h1 class="tpa-h1" tabindex="-1">${esc(T.bankTitle)}</h1>
    <p class="tpa-lead">${esc(T.bankLead)}</p>
    ${current}
    <form class="tpa-form" data-form="bank" novalidate autocomplete="off">
      ${field('routing', T.routing, { mode: 'numeric', max: 9, hint: T.routingHint, attrs: 'autocomplete="off" pattern="[0-9]*"' })}
      <div class="tpa-grid">
        ${field('account', T.account, { mode: 'numeric', max: 17, attrs: 'autocomplete="off" pattern="[0-9]*"' })}
        ${field('account2', T.account2, { mode: 'numeric', max: 17, attrs: 'autocomplete="off" pattern="[0-9]*"' })}
      </div>
      <fieldset class="tpa-field"><legend class="tpa-label">${esc(T.kind)}</legend>
        <div class="tpa-radios tpa-radios--grid">${Object.entries(T.kinds).map(([k, l], i) => `<label class="tpa-radio"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
      </fieldset>
      ${navBar(setupRun ? T.saveNext : T.bankSave)}
    </form>`;
}

function wireBank() {
  const fresh = root.querySelector<HTMLButtonElement>('[data-act=bank-link]');
  if (fresh) {
    fresh.addEventListener('click', async () => {
      fresh.disabled = true;
      const r = await post({ action: 'bank-link' });
      const note = root.querySelector<HTMLElement>('.tpa-fresh [data-note]')!;
      note.hidden = false;
      note.textContent = r.ok ? T.bankFreshSent(r.to) : r.error || T.failed;
      note.dataset.tone = r.ok ? 'good' : 'fix';
      if (!r.ok) fresh.disabled = false;
    });
    return;
  }
  wireForm('bank', (f) => ({
    routing: f.querySelector<HTMLInputElement>('[name=routing]')!.value, account: f.querySelector<HTMLInputElement>('[name=account]')!.value,
    account2: f.querySelector<HTMLInputElement>('[name=account2]')!.value, kind: f.querySelector<HTMLInputElement>('input[name=kind]:checked')?.value,
  }), (r, sent) => {
    if (r.preview) shown.bank = { last4: r.last4, kind: (WORDS.en.kinds as any)[sent.kind] || null, status: 'pending' };
    const body = root.querySelector<HTMLElement>('.tpa-step-body')!;
    body.replaceChildren(html(`<div class="tpa-done" tabindex="-1">${svg('check', 'tpa-done-icon')}<h1 class="tpa-h1">${esc(T.bankDone(r.last4, !!r.confirmed || !!r.preview))}</h1>
      <button type="button" class="tpa-btn tpa-btn--primary" data-act="next" data-step="bank">${esc(T.yourPage)}</button></div>`));
    body.querySelector<HTMLElement>('.tpa-done')?.focus();
  });
}

// ─── An insurance agent's link ──────────────────────────────────────

function drawAgent() {
  document.documentElement.classList.remove('tpa-focus');
  root.replaceChildren(html(`
    <div class="tpa-narrow">
      <div class="tpa-row"><p class="tpa-eyebrow">Sunshine on a Ranney Day</p>${langButton()}</div>
      <h1 class="tpa-h1">${esc(T.agentPageTitle(v.name))}</h1>
      <p class="tpa-lead">${esc(T.agentPageLead(v.name))}</p>
      <div class="tpa-reqbox"><p class="tpa-label">${esc(T.coiNeeds)}</p>${requirements()}${holderBlock()}</div>
      ${dropZone('coi', true)}
    </div>`));
  wireDrop('coi');
}

// ─── Clicks ─────────────────────────────────────────────────────────

function onClick(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'lang') { setLang(lang === 'es' ? 'en' : 'es'); draw(); return; }
  if (act === 'signout') { try { localStorage.removeItem(KEY); } catch { /* private mode */ } token = ''; v = null; drawSignIn(); return; }
  if (act === 'open') return openStep(el.dataset.step as Step, { run: false });
  if (act === 'setup') {
    const first = STEPS.find((k) => tileState(k) === 'needed') || 'company';
    return openStep(first, { run: true });
  }
  if (act === 'close') return closeStep();
  if (act === 'next') return finishStep(el.dataset.step as Step);
  if (act === 'remove') { picked.splice(Number(el.dataset.i), 1); return check((step || 'coi') as 'w9' | 'coi'); }
  if (act === 'anyway') return check(el.dataset.doc as 'w9' | 'coi', true);
  if (act === 'copy') {
    navigator.clipboard?.writeText(el.dataset.copy || '').then(() => { el.textContent = T.copied; setTimeout(() => { el.textContent = T.copy; }, 1600); }).catch(() => null);
  }
}

// ─── Start ──────────────────────────────────────────────────────────

export async function start(el: HTMLElement) {
  root = el;
  setLang(startLang(), false);
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromLink = hash.get('t');
  jumpTo = (hash.get('step') as Step) || null;
  let agentLink = false;
  if (fromLink) {
    token = fromLink;
    history.replaceState(history.state, '', location.pathname + location.search);
  } else {
    try { token = sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ''; } catch { token = ''; }
  }
  root.addEventListener('click', onClick);
  (window as any).__tpPop = () => {
    if (closing) { closing = false; draw(); return true; }
    if (!step) return false;
    closeStep({ pop: true });
    return true;
  };
  if (!token) return drawSignIn();
  root.replaceChildren(html(`<p class="tpa-loading">${esc(T.loading)}</p>`));
  const r = await load();
  if (!r.ok) {
    if (r.gone) { try { localStorage.removeItem(KEY); } catch { /* */ } }
    return drawSignIn(r.gone ? T.gone : r.error);
  }
  agentLink = v.scope === 'agent';
  try {
    if (agentLink) sessionStorage.setItem(KEY, token);
    else if (!v.preview) localStorage.setItem(KEY, token);
  } catch { /* private mode: this visit only */ }
  if (v.lang && !fromLink) setLang(v.lang, false);
  draw();
  if (jumpTo && STEPS.includes(jumpTo) && v.scope === 'vendor') openStep(jumpTo, { run: false });
}
