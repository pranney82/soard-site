/**
 * Admin → Job Costs → Checks: every check deposited in Mercury, and its Zeffy record
 * ===========================================================================
 * Over /api/checks-admin (functions/api/_check-gifts.js). Nothing here has to be
 * pressed for a check that went fine: the site reads each one and makes or finds
 * its Zeffy record, with no receipt or email to the donor. People answer only what the
 * site can't: who wrote it, whether Zeffy's entry is this check, an event gift, or
 * a company's check that could be a refund.
 *
 * It starts by watching: staff keep entering checks, and each hand entry is
 * scored against what the site would have done. "Let the site enter checks" turns
 * it on, and from then staff stop entering checks deposited in Mercury.
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { ask } from './ask.js';

const html = htm.bind(h);
const API = '/api/checks-admin';
const ZEFFY_URL = 'https://www.zeffy.com/en-US/o/all-payments';

async function call(query = '', body = null) {
  let r;
  try {
    r = await fetch(API + query, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

const usd = (cents) => `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = (d) => {
  if (!d) return '';
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d);
  if (Number.isNaN(t)) return '';
  const thisYear = new Date(t).getFullYear() === new Date().getFullYear();
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }), timeZone: 'America/New_York' });
};
const fromUnix = (s) => fmtDay(new Date(Number(s) * 1000).toISOString());
const firstOf = (email) => { const w = String(email || '').split('@')[0]; return w ? w[0].toUpperCase() + w.slice(1) : 'Someone'; };

/** Where a check stands, in a tag */
function standing(c, mode) {
  const on = mode === 'on';
  if (c.state === 'person') return [on ? 'Needs you' : 'Waiting for the hand entry', on ? 'tag--warn' : 'tag--info'];
  if (c.reason === 'amount-off') return ['Amounts differ', 'tag--warn'];
  if (c.reason === 'still-unpaid') return ['Unpaid in Zeffy', 'tag--warn'];
  if (c.state === 'created' || c.state === 'linked') return ['In Zeffy', 'tag--success'];
  if (c.state === 'would') return on ? ['The site will enter this', 'tag--info'] : ['Waiting for the hand entry', 'tag--info'];
  if (c.state === 'left-out') return ['Left out', ''];
  if (c.state === 'store') return ['Store account', ''];
  if (c.state === 'came-back') return ['Came back', 'tag--warn'];
  if (c.state === 'creating' || c.state === 'unsure') return ['Checking Zeffy', 'tag--info'];
  if (c.status === 'pending') return ['Mercury is reviewing it', 'tag--info'];
  return ['Reading', 'tag--info'];
}

/** How it got there, in a few words */
function howItWent(c, mode) {
  if (c.reason === 'amount-off' || c.reason === 'still-unpaid') return c.why;
  if (c.state === 'created') return c.via === 'person' ? `Saved by ${firstOf(c.by)}` : 'Entered by the site';
  if (c.state === 'linked') return c.via === 'person' ? `Matched by ${firstOf(c.by)}` : 'Found the hand entry';
  if (c.state === 'would') return c.formTitle ? `${mode === 'on' ? 'Going on' : 'The site would use'} ${c.formTitle}` : '';
  if (c.state === 'store') return 'Deposited to the store’s account, so it’s the store’s money';
  return c.why || '';
}

function CheckRow({ c, mode, act, busy, forms }) {
  const [tag, tone] = standing(c, mode);
  const [open, setOpen] = useState(false);
  const how = howItWent(c, mode);
  const on = mode === 'on';
  const leftAlone = ['left-out', 'store'].includes(c.state) && c.reason !== 'back';
  const toCancel = c.state === 'came-back' && !!c.zeffyId;
  const notGift = !on && !c.zeffyId && (c.state === 'person' || c.state === 'would');
  const unlink = async () => {
    const yes = await ask({ title: 'Take this entry off?', text: 'The check stops counting that Zeffy entry as its record, and the entry won’t be offered for this check again.', yes: 'Take it off', careful: true });
    if (yes) act({ action: 'unlink', id: c.id }, 'Taken off');
  };
  return html`<div class="jc-charge" data-check=${c.id}>
    <span class="jc-charge__date">${fmtDay(c.checkDate || c.depositedAt)}</span>
    <div class="jc-charge__what">
      <strong>${c.payer || (['new', 'read'].includes(c.state) ? 'Not read yet' : 'Unknown')}</strong>
      <div class="jc-charge__meta">
        <span class="tag ${tone}">${tag}</span>
        ${how ? html`<span>${how}</span>` : ''}
        ${c.memo ? html`<span>Memo: ${c.memo}</span>` : ''}
        ${c.link ? html`<a class="link" href=${c.link} target="_blank" rel="noopener">Open in Mercury</a>` : ''}
        ${toCancel ? html`<a class="link" href=${ZEFFY_URL} target="_blank" rel="noopener">Open Zeffy</a>` : ''}
      </div>
    </div>
    <span class="jc-charge__amt">${usd(c.cents)}</span>
    ${leftAlone && !open ? html`<div class="jc-sort"><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => (on ? setOpen(true) : act({ action: 'is-gift', id: c.id }, 'It’ll wait for the hand entry'))}>It’s a gift</button></div>` : ''}
    ${leftAlone && open ? html`<div class="ck-entry"><${Entry} c=${c} act=${act} busy=${busy} forms=${forms} onCancel=${() => setOpen(false)} /></div>` : ''}
    ${notGift ? html`<div class="jc-sort"><${NotGift} c=${c} act=${act} busy=${busy} /></div>` : ''}
    ${c.state === 'linked' ? html`<div class="jc-sort"><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${unlink}>Not this entry</button></div>` : ''}
  </div>`;
}

/** Leaving a check out of Zeffy asks first: it's money */
function NotGift({ c, act, busy }) {
  const press = async () => {
    const yes = await ask({ title: 'Leave this check out of Zeffy?', text: `${usd(c.cents)}${c.payer ? ` from ${c.payer}` : ''} won’t be recorded as a gift.`, yes: 'Leave it out', careful: true });
    if (yes) act({ action: 'not-gift', id: c.id }, 'Left out of Zeffy');
  };
  return html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${press}>It isn’t a gift</button>`;
}

/** A person's entry: what the site read, filled in, for them to finish */
function Entry({ c, act, busy, forms, onCancel = null, more = null }) {
  const [name, setName] = useState(c.payer || '');
  const guessForm = c.formId || (forms || []).find((f) => /brighter home/i.test(f.title))?.id || '';
  const [formId, setFormId] = useState(guessForm);
  const [day, setDay] = useState(c.checkDate || c.depositDay);
  useEffect(() => { if (!formId && guessForm) setFormId(guessForm); }, [guessForm]);
  const save = async (notThose = false) => {
    const j = await act({ action: 'create', id: c.id, name: name.trim(), formId, day, notThose }, 'Saved in Zeffy');
    if (j === 'double' && !notThose) {
      const yes = await ask({ title: 'Is this a different gift?', text: 'Zeffy has an entry that may be this check. Save a second one only if it’s a different gift.', yes: 'Save a new record', careful: true });
      if (yes) await save(true);
    }
  };
  const stillPicking = !forms;
  const saving = busy === 'create';
  return html`<div class="jc-grid2">
      <label class="jc-field"><span>Who wrote the check</span><input class="form-input" value=${name} maxlength="120" autocomplete="off" onInput=${(e) => setName(e.target.value)} /></label>
      <label class="jc-field"><span>Zeffy form</span>
        <select class="form-select" value=${formId} disabled=${stillPicking} onChange=${(e) => setFormId(e.target.value)}>
          ${stillPicking ? html`<option value="">Loading forms…</option>` : html`<option value="">Pick a form</option>`}
          ${(forms || []).map((f) => html`<option value=${f.id}>${f.title}</option>`)}
        </select></label>
      <label class="jc-field"><span>${c.checkDate ? 'Date on the check' : 'Date (the site couldn’t read one)'}</span><input class="form-input" type="date" value=${day} max=${c.depositDay} onInput=${(e) => setDay(e.target.value)} /></label>
    </div>
    <div class="jc-row ck-actions">
      <button class="btn btn-primary btn-sm" disabled=${!!busy || !name.trim() || !formId || !day} onClick=${() => save()}>${saving ? 'Saving…' : 'Save in Zeffy'}</button>
      ${onCancel ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${onCancel}>Cancel</button>` : ''}
      ${more}
    </div>`;
}

/** One check the site couldn't finish */
function NeedsYou({ c, mode, act, busy, forms }) {
  const on = mode === 'on';
  const event = c.reason === 'event';
  const entries = c.candidates || [];
  const openZeffy = html`<a class="btn btn-ghost btn-sm" href=${ZEFFY_URL} target="_blank" rel="noopener">Open Zeffy</a>`;
  const showZeffy = ['unsure', 'zeffy-refused', 'no-form'].includes(c.reason);
  const notGift = html`<${NotGift} c=${c} act=${act} busy=${busy} />`;
  const matchTo = async (x) => {
    if (x.cents !== c.cents) {
      const yes = await ask({ title: 'The amounts are different', text: `That entry is ${usd(x.cents)} and this check is ${usd(c.cents)}. Match them anyway, then fix the amount in Zeffy.`, yes: 'Match them', careful: true });
      if (!yes) return;
    }
    act({ action: 'link', id: c.id, zeffyId: x.id }, 'Matched to that entry');
  };
  return html`<div class="ck-need" data-check=${c.id}>
    <div>
      <strong>${usd(c.cents)}${c.payer ? ` from ${c.payer}` : ''}</strong>
      <div class="jc-charge__meta">
        <span>Deposited ${fmtDay(c.depositedAt)}</span>
        ${c.memo ? html`<span>Memo: ${c.memo}</span>` : ''}
        ${c.link ? html`<a class="link" href=${c.link} target="_blank" rel="noopener">See the check in Mercury</a>` : ''}
      </div>
    </div>
    <p class="ck-need__why">${c.why}${c.note ? ` ${c.note}` : ''}</p>
    ${entries.length ? html`<ul class="ck-cands">
      ${entries.map((x) => html`<li>
        <span><strong>${x.name || 'No name'}</strong> · ${usd(x.cents)} · ${fromUnix(x.at)}${x.form ? ` · ${x.form}` : ''}</span>
        <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => matchTo(x)}>This is the check</button>
      </li>`)}
    </ul>` : ''}
    ${on && !event ? html`<${Entry} c=${c} act=${act} busy=${busy} forms=${forms} more=${html`${showZeffy ? openZeffy : ''}${notGift}`} />`
    : html`<p class="sec-head__hint ck-note">${on ? 'Enter it in Zeffy by hand, and it links itself within the hour.' : entries.length ? 'If this isn’t it, enter it in Zeffy as usual.' : 'Enter it in Zeffy as usual.'}</p>
      <div class="jc-row ck-actions">
        ${on ? openZeffy : ''}
        ${notGift}
      </div>`}
  </div>`;
}

function Status({ v, act, busy }) {
  const test = v.writeTest;
  const on = v.mode === 'on';
  const canTurnOn = !!test?.ok;
  const score = v.scored?.total ? `${v.scored.right} of ${v.scored.total} matched what staff entered so far.` : 'No checks to compare yet.';
  const turnOn = async () => {
    const held = v.list.filter((c) => c.state === 'would').length;
    const past = held ? ` ${held === 1 ? 'The 1 check it was watching that isn’t in Zeffy yet goes in too.' : `The ${held} checks it was watching that aren’t in Zeffy yet go in too.`}` : '';
    const yes = await ask({ title: 'Let the site enter checks?', text: `Staff stop entering checks deposited in Mercury from now on. Anything deposited anywhere else, and anything for an event, is still entered by hand. Nothing goes to donors.${past}`, yes: 'Let the site enter checks' });
    if (yes) act({ action: 'mode', mode: 'on' }, 'The site enters checks now');
  };
  const turnOff = async () => {
    const yes = await ask({ title: 'Go back to watching?', text: 'The site stops making records, and staff need to enter checks in Zeffy again.', yes: 'Go back to watching', careful: true });
    if (yes) act({ action: 'mode', mode: 'watch' }, 'The site is watching');
  };
  return html`
    ${v.lastError ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The last run didn’t finish.</strong> It tries again on its own in a few minutes.</div></div>` : ''}
    ${test && !test.ok && !test.leftBehind?.length ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The site couldn’t save a test record in Zeffy.</strong> It tries again tomorrow.</div></div>` : ''}
    ${test?.leftBehind?.length ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>Zeffy wouldn’t let the site remove its test ${test.leftBehind.length === 1 ? 'record' : 'records'}.</strong> Delete the $1 SOARD WebsiteTest ${test.leftBehind.length === 1 ? 'entry' : 'entries'} in Zeffy. They aren’t gifts, and this goes away on its own once they’re gone.</div>
      <div class="notice__actions"><a class="btn btn-ghost" href=${ZEFFY_URL} target="_blank" rel="noopener">Open Zeffy</a></div></div>` : ''}
    <div class="notice ${on ? 'notice--success' : ''}">
      <div class="notice__body">
        ${on ? html`<strong>The site enters checks in Zeffy.</strong> Only checks deposited in Mercury, and nothing goes to donors.${v.onBy ? ` Turned on by ${firstOf(v.onBy)}${v.onAt ? ` on ${fmtDay(v.onAt)}` : ''}.` : ''}`
        : html`<strong>The site is watching.</strong> Staff keep entering checks in Zeffy, and the site compares each one with what it would have done. ${score}${!test ? ' It still has to prove it can save to Zeffy, which it does by itself.' : ''}`}
      </div>
      <div class="notice__actions">
        ${on ? html`<button class="btn btn-ghost" disabled=${!!busy} onClick=${turnOff}>Go back to watching</button>`
        : canTurnOn ? html`<button class="btn btn-primary" disabled=${!!busy} onClick=${turnOn}>Let the site enter checks</button>` : ''}
      </div>
    </div>`;
}

export function Checks({ addToast = () => {} }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [forms, setForms] = useState(null);
  const typing = useRef(false);
  const needed = useRef(false);

  const load = async () => {
    const j = await call();
    if (!j.success) { setErr(j.error || 'Could not load the checks'); return; }
    setErr(null);
    setV(j);
  };
  const needsForms = (view) => view?.mode === 'on' && (view.list || []).some((c) => ['person', 'left-out', 'store'].includes(c.state));
  const formsAsked = useRef(false);
  const loadForms = async (quiet = false) => {
    if (formsAsked.current) return;
    formsAsked.current = true;
    const j = await call('?forms=1');
    formsAsked.current = false;
    if (j.success) setForms(j.forms || []);
    else if (!quiet) addToast('Couldn’t read Zeffy’s forms. The site tries again in a moment.', 'error');
  };
  useEffect(() => { load(); }, []);
  // Looks again when the tab comes back and every 30 seconds while it's open; an entry being typed keeps its own words
  useEffect(() => {
    const look = () => {
      if (document.hidden) return;
      if (!typing.current) load();
      // The form list stays wanted until it comes, so one failed read doesn't leave every entry waiting
      if (needed.current) loadForms(true);
    };
    const t = setInterval(look, 30000);
    document.addEventListener('visibilitychange', look);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', look); };
  }, []);
  // The form list, once there's something to pick for
  const needForms = needsForms(v) && !forms;
  needed.current = needForms;
  useEffect(() => { if (needForms) loadForms(); }, [needForms]);

  const act = async (body, done) => {
    setBusy(body.action);
    const j = await call('', body);
    setBusy(null);
    if (!j.success) {
      await load();
      // Zeffy turned up an entry: the page now shows it, and the entry asks before saving another
      if (/may be this check/.test(j.error || '')) return 'double';
      addToast(/^(HTTP 5|The operation|Zeffy answered 5)/.test(j.error || '') || !j.error ? 'That didn’t go through. Nothing changed, so try again.' : j.error, 'error');
      return null;
    }
    setV(j);
    if (done) addToast(j.result?.result === 'linked' && body.action === 'create' ? 'Zeffy already had it, so it’s matched' : done, 'success');
    return j;
  };

  if (err && !v) {
    return html`<div class="notice notice--danger"><div class="notice__body">${err}</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  }
  if (!v) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;

  // While it's watching, staff enter checks anyway: only a real question (is this that entry?) waits on someone
  const needsYou = (c) => c.state === 'person' && (v.mode === 'on' || !!c.candidates?.length);
  const need = v.list.filter(needsYou);
  const rest = v.list.filter((c) => !needsYou(c));
  return html`<div class="ck" onFocusIn=${(e) => { typing.current = !!e.target.closest('input, select'); }} onFocusOut=${() => { typing.current = false; }}>
    ${err ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>This list may be out of date.</strong> The site couldn’t reach the server, and keeps trying.</div></div>` : ''}
    <${Status} v=${v} act=${act} busy=${busy} />
    ${need.length ? html`<section class="card ck-card">
      <div class="sec-head"><h3>Needs you <span class="count is-warn">${need.length}</span></h3><span class="sec-head__hint">The site can’t finish these on its own.</span></div>
      ${need.map((c) => html`<${NeedsYou} key=${c.id} c=${c} mode=${v.mode} act=${act} busy=${busy} forms=${forms} />`)}
    </section>` : ''}
    <section class="card ck-card">
      <div class="sec-head"><h3>Checks <span class="count">${rest.length}</span></h3><span class="sec-head__hint">${v.limited ? 'The newest deposited in Mercury' : 'Deposited in Mercury'}</span></div>
      ${rest.length ? rest.map((c) => html`<${CheckRow} key=${c.id} c=${c} mode=${v.mode} act=${act} busy=${busy} forms=${forms} />`)
        : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">${need.length ? 'Nothing else yet.' : 'No checks yet. Each one shows up here on its own once it’s deposited in Mercury.'}</p></div>`}
    </section>
  </div>`;
}
