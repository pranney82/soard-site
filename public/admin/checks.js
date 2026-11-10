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
 *
 * Every action says which state the page showed (`saw`), so an answer from an older
 * screen never overrules someone else's newer one.
 *
 * Nov 10 2026: a check goes in at 7 PM Eastern on its deposit day, after any letter
 * attached in Mercury is read. Each row shows what the letter said and the address
 * that went on the donor in Zeffy.
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { ask } from './ask.js';

const html = htm.bind(h);
const API = '/api/checks-admin';
const ZEFFY_URL = 'https://www.zeffy.com/en-US/o/all-payments';
// An answer that didn't come through can't say what happened: the list, read again, does
const NO_ANSWER = 'The site’s answer didn’t come through. Look at the list before trying again: it shows what went through.';
const NO_LIST = 'The site didn’t answer.';

/** One call to the site, with an answer in plain words whatever happens: no answer at all is said too, never a hang */
async function call(query = '', body = null) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), body ? 30000 : 20000);
  let r;
  try {
    r = await fetch(API + query, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }
      : { cache: 'no-store', signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') return { success: false, error: body ? 'No answer yet. It may still go through, so look again in a minute before trying again.' : 'The site is slow to answer. It tries again on its own.' };
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  clearTimeout(timer);
  if (!j || typeof j !== 'object') return { success: false, error: body ? NO_ANSWER : NO_LIST };
  if (!r.ok && j.success !== false) j.success = false;
  if (!j.success && !j.error) j.error = body ? NO_ANSWER : NO_LIST;
  return j;
}

// What someone typed in an entry stays while they look at another tab and come back (this page only, never stored)
const drafts = new Map();

const usd = (cents) => `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = (d) => {
  if (!d) return '';
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d);
  if (Number.isNaN(t)) return '';
  const thisYear = new Date(t).getFullYear() === new Date().getFullYear();
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }), timeZone: 'America/New_York' });
};
const fromUnix = (s) => fmtDay(new Date(Number(s) * 1000).toISOString());
/** peter.ranney@… reads Peter */
const firstOf = (email) => { const w = String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean)[0]; return w ? w[0].toUpperCase() + w.slice(1) : 'Someone'; };
/** Which check a button is for, for a screen reader: every row has the same buttons */
const whoFor = (c) => (c.reason === 'bank' ? `${usd(c.cents)}, a bank’s check` : `${usd(c.cents)}${c.payer ? ` from ${c.payer}` : ''}`);

/** Where a check stands, in a tag */
function standing(c, mode) {
  const on = mode === 'on';
  if (c.state === 'person') return c.needsYou ? ['Needs you', 'tag--warn'] : on && c.status !== 'sent' ? ['Waiting for Mercury to post it', 'tag--info'] : ['Waiting for the hand entry', 'tag--info'];
  if (c.reason === 'amount-off') return ['Amounts differ', 'tag--warn'];
  if (c.reason === 'still-unpaid') return ['Unpaid in Zeffy', 'tag--warn'];
  if (c.state === 'created' || c.state === 'linked') return ['In Zeffy', 'tag--success'];
  if (c.state === 'would') return on ? (c.old ? ['Comes to you next', 'tag--info'] : ['The site will enter this', 'tag--info']) : ['Waiting for the hand entry', 'tag--info'];
  if (c.state === 'left-out') return ['Left out', ''];
  if (c.state === 'store') return ['Store account', ''];
  if (c.state === 'came-back') return ['Came back', 'tag--warn'];
  if (c.state === 'creating' || c.state === 'unsure') return ['Checking Zeffy', 'tag--info'];
  if (c.letter?.reading && ['read', 'would'].includes(c.state)) return ['Reading the letter', 'tag--info'];
  if (c.needsCategory && ['read', 'would'].includes(c.state)) return ['Needs its Category in Mercury', 'tag--info'];
  if (c.waitsUntil) return [atSeven(c.waitsUntil), 'tag--info'];
  if (c.status === 'pending') return ['Mercury is reviewing it', 'tag--info'];
  if (c.status === 'blocked') return ['Mercury is holding it', 'tag--warn'];
  if (c.state === 'read') return ['Being checked against Zeffy', 'tag--info'];
  return ['Being read', 'tag--info'];
}

/** "Goes into Zeffy at 7 PM", or tomorrow's */
function atSeven(iso) {
  const day = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return day(iso) === day(Date.now()) ? 'Goes into Zeffy at 7 PM' : `Goes into Zeffy ${fmtDay(iso)} at 7 PM`;
}

/** What came with the check and where the donor's mail goes, as short facts beside it */
function mailFacts(c) {
  const l = c.letter;
  return html`
    ${c.drawer ? html`<span>Check from ${c.drawer}</span>` : ''}
    ${l?.reading ? html`<span>A letter is being read</span>` : ''}
    ${l?.unread && !l.reading && !l.todo && !['created', 'linked'].includes(c.state) ? html`<span>${l.unread === 1 ? 'A file is' : `${l.unread} files are`} with it in Mercury</span>` : ''}
    ${l?.name ? html`<span>Letter: from ${l.name}</span>` : ''}
    ${l?.email ? html`<span>Receipt to ${l.email}${c.emailTaken ? ' (another donor in Zeffy has this email)' : ''}</span>` : ''}
    ${l?.address ? html`<span>Mail (from the letter): ${l.address}</span>` : ''}
    ${c.address?.line ? html`<span>Mail on the check: ${c.address.line}</span>` : ''}
    ${c.mailInZeffy ? html`<span>Address in Zeffy</span>` : ''}`;
}

/** How it got there, in a few words */
function howItWent(c, mode) {
  if (c.reason === 'amount-off' || c.reason === 'still-unpaid') return c.why;
  if (c.toDo) return c.why;
  if (c.needsCategory && ['read', 'would'].includes(c.state)) return 'Only checks marked Individual Contribution, Corporate Contribution or Grant in Mercury go into Zeffy';
  if (c.waitsUntil) return 'A letter attached in Mercury before then is read with it';
  if (c.state === 'created') return c.via === 'person' ? `Saved by ${firstOf(c.by)}` : 'Entered by the site';
  if (c.state === 'linked') return c.via === 'person' ? `Matched by ${firstOf(c.by)}` : 'Found the hand entry';
  if (c.state === 'would' && mode === 'on' && c.old) return 'Posted more than 30 days ago, so a person looks before it goes in';
  if (c.state === 'would') return c.formTitle ? `${mode === 'on' ? 'Going on' : 'The site would use'} ${c.formTitle}` : '';
  if (c.state === 'store') return 'Deposited to the store’s account, so it’s the store’s money';
  return c.why || '';
}

function CheckRow({ c, mode, act, busy, forms, formsGone, formsFailed }) {
  const same = (d) => !!d && d.ver === c.ver && d.mode === mode;
  const [tag, tone] = standing(c, mode);
  // An entry left open stays open across tabs, with what was typed in it
  const kept = drafts.get(c.id);
  const [open, setOpenState] = useState(!!kept?.open && same(kept));
  // Someone (or the site) answered this check since the entry was opened: it never reopens with Save ready
  useEffect(() => { if (open && !same(drafts.get(c.id))) { setOpenState(false); drafts.delete(c.id); } }, [c.ver, mode]);
  const setOpen = (yes) => {
    setOpenState(yes);
    if (yes) drafts.set(c.id, { ...(drafts.get(c.id) || {}), open: true, ver: c.ver, mode });
    else {
      drafts.delete(c.id);
      requestAnimationFrame(() => document.querySelector(`.ck [data-check="${CSS.escape(c.id)}"] .ck-gift`)?.focus());
    }
  };
  const posted = ['pending', 'sent'].includes(c.status);
  const how = howItWent(c, mode);
  const on = mode === 'on';
  const leftAlone = ['left-out', 'store'].includes(c.state) && c.reason !== 'back';
  const toCancel = c.state === 'came-back' && !!c.zeffyId;
  // Anything not in Zeffy yet can be called not a gift, watching or on; never while Zeffy is still answering
  const notGift = !c.zeffyId && ['new', 'read', 'would', 'person'].includes(c.state);
  const dated = c.checkDate && c.checkDate !== c.depositDay ? `Dated ${fmtDay(c.checkDate)}` : '';
  return html`<div class="jc-charge" data-check=${c.id} tabindex="-1">
    <span class="jc-charge__date" title="The day it was deposited">${fmtDay(c.depositedAt)}</span>
    <div class="jc-charge__what">
      <strong id=${`ck-h-${c.id}`}>${c.reason === 'bank' ? 'A bank’s check' : c.payer || (['new', 'read'].includes(c.state) ? 'Not read yet' : 'Unknown')}</strong>
      <div class="jc-charge__meta">
        <span class="tag ${tone}">${tag}</span>
        ${how ? html`<span>${how}</span>` : ''}
        ${dated ? html`<span>${dated}</span>` : ''}
        ${c.memo ? html`<span>Memo: ${c.memo}</span>` : ''}
        ${mailFacts(c)}
        ${c.link ? html`<a class="link" href=${c.link} target="_blank" rel="noopener" aria-label=${`Open in Mercury: ${whoFor(c)}`}>Open in Mercury</a>` : ''}
        ${toCancel ? html`<a class="link" href=${ZEFFY_URL} target="_blank" rel="noopener" aria-label=${`Open Zeffy: ${whoFor(c)}`}>Open Zeffy</a>` : ''}
      </div>
    </div>
    <span class="jc-charge__amt">${usd(c.cents)}</span>
    ${leftAlone && !(open && on && posted) ? html`<div class="jc-sort"><button type="button" class="btn btn-ghost btn-sm ck-gift" disabled=${!!busy} aria-label=${`It’s a gift: ${whoFor(c)}`}
      onClick=${() => (on && posted ? setOpen(true) : act({ action: 'is-gift', id: c.id, saw: c.ver || c.state }, (j) => (j.mode !== 'on' ? 'It’ll wait for the hand entry' : posted ? 'It’s in Needs you to save' : 'It comes to you to save once Mercury takes the check')))}>${busy === `is-gift:${c.id}` ? 'Working…' : 'It’s a gift'}</button></div>` : ''}
    ${leftAlone && open && on && posted ? html`<div class="ck-entry"><${Entry} c=${c} act=${act} busy=${busy} forms=${forms} formsGone=${formsGone} formsFailed=${formsFailed} focusFirst=${true} onCancel=${() => setOpen(false)} /></div>` : ''}
    ${notGift ? html`<div class="jc-sort"><${NotGift} c=${c} act=${act} busy=${busy} /></div>` : ''}
    ${c.state === 'linked' ? html`<div class="jc-sort"><${Unlink} c=${c} mode=${mode} act=${act} busy=${busy} /></div>` : ''}
  </div>`;
}

/** Leaving a check out of Zeffy asks first: it's money */
function NotGift({ c, act, busy }) {
  const press = async () => {
    const yes = await ask({ title: 'Leave this check out of Zeffy?', text: `${whoFor(c)} won’t be recorded as a gift.`, yes: 'Leave it out', careful: true });
    if (yes) act({ action: 'not-gift', id: c.id, saw: c.ver || c.state }, 'Left out of Zeffy');
  };
  return html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`It isn’t a gift: ${whoFor(c)}`} onClick=${press}>${busy === `not-gift:${c.id}` ? 'Working…' : 'It isn’t a gift'}</button>`;
}

/** The matched entry isn't this check: it says what happens next, and points at Zeffy when the entry only needs fixing */
function Unlink({ c, mode, act, busy }) {
  const press = async () => {
    const fix = c.toDo ? 'If that entry is this check with something to fix, fix it in Zeffy instead. ' : '';
    const next = mode === 'on'
      ? 'The check then waits here for you to save it in Zeffy or match it to another entry. The site won’t make a record for it on its own.'
      : 'The site then waits for the check’s own hand entry.';
    const yes = await ask({ title: 'Take this entry off?', text: `${fix}The check stops counting that Zeffy entry as its record, and the entry won’t be offered for it again. ${next}`, yes: 'Take it off', careful: true });
    if (yes) act({ action: 'unlink', id: c.id, saw: c.ver || c.state }, 'That entry is off this check');
  };
  return html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Not this entry: ${whoFor(c)}`} onClick=${press}>${busy === `unlink:${c.id}` ? 'Working…' : 'Not this entry'}</button>`;
}

/** A file added after the record went into Zeffy, or an address Zeffy wouldn't take, has been looked at, and Zeffy says what it should */
function LetterDone({ c, act, busy }) {
  return html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Looked at it: ${whoFor(c)}`}
    onClick=${() => act({ action: 'letter-done', id: c.id, saw: c.ver || c.state }, 'Done')}>${busy === `letter-done:${c.id}` ? 'Working…' : 'Looked at it'}</button>`;
}

/** A person's entry: what the site read, filled in, for them to finish */
// The site's own rule for a person's entry: a foundation or fund goes on the newest grant form, everyone else the general one
const GIVING_BODY = /\b(foundation|trust|fund|grant|charitable|endowment)\b/i;
// A check marked Grant in Mercury goes on the grant form too, whoever it's from
const suggestForm = (forms, name, category = '') => {
  const grant = (GIVING_BODY.test(name || '') || /\bgrants?\b/i.test(category || '')) && (forms || []).filter((f) => /grant funding/i.test(f.title)).sort((a, b) => b.title.localeCompare(a.title))[0];
  return (grant || (forms || []).find((f) => /brighter home/i.test(f.title)))?.id || '';
};

function Entry({ c, act, busy, forms, formsGone = () => {}, onCancel = null, more = null, focusFirst = false, formsFailed = false }) {
  const draft = drafts.get(c.id) || {};
  const isOpen = (id) => !!id && (forms || []).some((f) => f.id === id);
  // A check dated after it was deposited goes on the day it was deposited, the same day the site would use
  const longAgo = !!c.checkDate && Date.parse(`${c.depositDay}T12:00:00Z`) - Date.parse(`${c.checkDate}T12:00:00Z`) > 60 * 86400e3;
  const usable = !!c.checkDate && c.checkDate <= c.depositDay && !longAgo;
  // A bank's name is never offered as the giver: the check says who it's from, the bank only cashed it
  const [name, setName] = useState(draft.name ?? (c.reason === 'bank' ? '' : c.payer || ''));
  const [picked, setPicked] = useState(!!draft.picked);
  const guessForm = (isOpen(c.formId) && c.formId) || suggestForm(forms, name, c.category);
  const [formId, setFormId] = useState(draft.formId ?? guessForm);
  const [day, setDay] = useState(draft.day ?? (usable ? c.checkDate : c.depositDay));
  const first = useRef(null);
  useEffect(() => { if (focusFirst) first.current?.focus(); }, []);
  // Until someone picks one, the form follows the site's rule; a form that closed since is never left picked
  useEffect(() => { if (forms && (!picked || !isOpen(formId))) setFormId(guessForm); }, [forms, guessForm]);
  useEffect(() => { drafts.set(c.id, { ...(drafts.get(c.id) || {}), name, formId, day, picked }); }, [name, formId, day, picked]);
  const here = useRef(true);
  useEffect(() => () => { here.current = false; }, []);
  const save = async (notThose = false, shown = [], saw = c.ver || c.state) => {
    const j = await act({ action: 'create', id: c.id, saw, name: name.trim(), formId, day, notThose, shown }, 'Saved in Zeffy');
    if (j?.formGone) { setPicked(false); formsGone(); return; }
    // Moved to another tab meanwhile: the check waits in Needs you with the entry beside it, and nothing is asked off the page
    if (j?.double && (!here.current || !document.querySelector(`.ck [data-check="${CSS.escape(c.id)}"]`))) return;
    if (j?.double) {
      // The entry it asks about is named right here, so nobody answers about something they can't see
      const list = j.double.map((x) => `${x.name || 'No name'}, ${usd(x.cents)}, ${fromUnix(x.at)}${x.form ? `, ${x.form}` : ''}`).join('; ');
      const one = j.double.length === 1;
      const yes = await ask({
        title: 'Is this a different gift?',
        text: `Zeffy has ${one ? 'an entry' : 'entries'} that may be this check: ${list}. If ${one ? 'it is' : 'one is'}, press Cancel and choose “This is the check” beside it. Save a second record only if this check is a different gift.`,
        yes: 'Save a new record', careful: true,
      });
      // The check is with a person now, whatever it was a moment ago
      if (yes) await save(true, [...shown, ...j.double.map((x) => x.id)], 'person');
    } else if (j) drafts.delete(c.id);
  };
  const stillPicking = !forms;
  const saving = busy === `create:${c.id}`;
  const can = !busy && !!name.trim() && isOpen(formId) && !!day;
  const dayLabel = usable ? 'Date on the check' : longAgo ? 'Date (the check is dated over 60 days before it was deposited, so the deposit day is used)'
    : c.checkDate ? 'Date (the check is dated after it was deposited)' : 'Date (the site couldn’t read one)';
  const noForms = !!forms && !forms.length;
  return html`<form class="ck-form" aria-label=${`Entry for ${whoFor(c)}`} onSubmit=${(e) => { e.preventDefault(); if (can) save(); }}
      onKeyDown=${(e) => { if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); } }}>
    <div class="jc-grid2">
      <label class="jc-field"><span>${c.letter?.name && c.payer === c.letter.name ? 'Who it’s from (the letter says)' : 'Who wrote the check'}</span><input aria-describedby=${`ck-h-${c.id}`} class="form-input" ref=${first} value=${name} maxlength="120" autocomplete="off"
        placeholder=${c.reason === 'bank' ? 'The person or company it’s from' : ''} onInput=${(e) => setName(e.target.value)} /></label>
      <label class="jc-field"><span>Zeffy form</span>
        <select aria-describedby=${`ck-h-${c.id}`} class="form-select" value=${formId} disabled=${stillPicking || noForms} onChange=${(e) => { setFormId(e.target.value); setPicked(true); }}>
          ${stillPicking ? html`<option value="">${formsFailed ? 'Couldn’t read Zeffy’s forms. Trying again…' : 'Loading forms…'}</option>` : html`<option value="">${noForms ? 'No open forms in Zeffy' : 'Pick a form'}</option>`}
          ${(forms || []).map((f) => html`<option value=${f.id}>${f.title}</option>`)}
        </select></label>
      <label class="jc-field"><span>${dayLabel}</span><input aria-describedby=${`ck-h-${c.id}`} class="form-input" type="date" value=${day} max=${c.depositDay} onInput=${(e) => setDay(e.target.value)} /></label>
    </div>
    ${noForms ? html`<p class="sec-head__hint ck-note">Zeffy has no open donation form to save this on. Open one in Zeffy, and it shows up here within a minute.</p>` : ''}
    <div class="jc-row ck-actions">
      <button type="submit" class="btn btn-primary btn-sm" disabled=${!can} aria-label=${`Save in Zeffy: ${whoFor(c)}`}>${saving ? 'Saving…' : 'Save in Zeffy'}</button>
      ${onCancel ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Cancel: ${whoFor(c)}`} onClick=${onCancel}>Cancel</button>` : ''}
      ${more}
    </div>
  </form>`;
}

/** One check the site couldn't finish, or a record with something left to do in Zeffy */
function NeedsYou({ c, mode, act, busy, forms, formsGone, formsFailed }) {
  const on = mode === 'on';
  const event = c.reason === 'event';
  const posted = ['pending', 'sent'].includes(c.status);
  const entries = c.candidates || [];
  const openZeffy = html`<a class="btn btn-ghost btn-sm" href=${ZEFFY_URL} target="_blank" rel="noopener" aria-label=${`Open Zeffy: ${whoFor(c)}`}>Open Zeffy</a>`;
  const showZeffy = ['unsure', 'zeffy-refused', 'no-form'].includes(c.reason);
  const byHand = c.reason === 'zeffy-busy';
  const notGift = c.zeffyId ? '' : html`<${NotGift} c=${c} act=${act} busy=${busy} />`;
  const matchTo = async (x) => {
    if (x.cents !== c.cents) {
      const yes = await ask({ title: 'The amounts are different', text: `That entry is ${usd(x.cents)} and this check is ${usd(c.cents)}. Match them anyway, then fix the amount in Zeffy.`, yes: 'Match them', careful: true });
      if (!yes) return;
    }
    act({ action: 'link', id: c.id, zeffyId: x.id, saw: c.ver || c.state }, 'Matched to that entry');
  };
  const head = html`<div>
      <strong id=${`ck-h-${c.id}`}>${whoFor(c)}</strong>
      <div class="jc-charge__meta">
        <span>Deposited ${fmtDay(c.depositedAt)}</span>
        ${c.checkDate && c.checkDate !== c.depositDay ? html`<span>Dated ${fmtDay(c.checkDate)}</span>` : ''}
        ${c.reason === 'bank' && c.payer ? html`<span>Bank on it: ${c.payer}</span>` : ''}
        ${c.memo ? html`<span>Memo: ${c.memo}</span>` : ''}
        ${mailFacts(c)}
        ${c.link ? html`<a class="link" href=${c.link} target="_blank" rel="noopener" aria-label=${`See the check in Mercury: ${whoFor(c)}`}>See the check in Mercury</a>` : ''}
      </div>
    </div>`;
  if (c.toDo) {
    return html`<div class="ck-need" data-check=${c.id} tabindex="-1">
      ${head}
      <p class="ck-need__why">${c.why}</p>
      <div class="jc-row ck-actions">${openZeffy}${c.looked ? html`<${LetterDone} c=${c} act=${act} busy=${busy} />` : ''}${c.state === 'linked' ? html`<${Unlink} c=${c} mode=${mode} act=${act} busy=${busy} />` : ''}</div>
    </div>`;
  }
  return html`<div class="ck-need" data-check=${c.id} tabindex="-1">
    ${head}
    <p class="ck-need__why">${c.why}${c.note ? ` ${c.note}` : ''}</p>
    ${c.needsCategory && on && posted ? html`<p class="sec-head__hint ck-note">Before saving: set its Category in Mercury to Individual Contribution, Corporate Contribution or Grant. Only checks marked that way go into Zeffy.</p>` : ''}
    ${entries.length ? html`<ul class="ck-cands">
      ${entries.map((x) => html`<li>
        <span><strong>${x.name || 'No name'}</strong> · ${usd(x.cents)} · ${fromUnix(x.at)}${x.form ? ` · ${x.form}` : ''}</span>
        <button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`This is the check: ${x.name || 'No name'}, ${usd(x.cents)}, ${fromUnix(x.at)}, for ${whoFor(c)}`} onClick=${() => matchTo(x)}>${busy === `link:${c.id}` ? 'Working…' : 'This is the check'}</button>
      </li>`)}
    </ul>` : ''}
    ${on && !event && !byHand && posted ? html`<${Entry} c=${c} act=${act} busy=${busy} forms=${forms} formsGone=${formsGone} formsFailed=${formsFailed} more=${html`${showZeffy ? openZeffy : ''}${notGift}`} />`
    : html`<p class="sec-head__hint ck-note">${on && !posted ? 'Mercury hasn’t taken this check, so it can’t be saved in Zeffy.'
        : on ? 'Enter it in Zeffy by hand, and it links itself within the hour.'
        : entries.length ? 'If this isn’t it, enter it in Zeffy as usual.' : 'Enter it in Zeffy as usual.'}</p>
      <div class="jc-row ck-actions">
        ${on && posted ? openZeffy : ''}
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
    const fresh = v.watching?.fresh || 0;
    const old = v.watching?.old || 0;
    const past = `${fresh ? ` ${fresh === 1 ? 'The 1 check the site was watching that isn’t in Zeffy yet goes in too.' : `The ${fresh} checks the site was watching that aren’t in Zeffy yet go in too.`}` : ''}${old ? ` ${old === 1 ? 'The 1 that posted more than 30 days ago comes to you here first instead.' : `The ${old} that posted more than 30 days ago come to you here first instead.`}` : ''}`;
    const yes = await ask({ title: 'Let the site enter checks?', text: `Staff stop entering checks deposited in Mercury from now on. Anything deposited anywhere else, and anything for an event, is still entered by hand. Nothing goes to donors.${past}`, yes: 'Let the site enter checks' });
    if (yes) act({ action: 'mode', mode: 'on', saw: v.mode }, 'The site enters checks now');
  };
  const turnOff = async () => {
    const yes = await ask({ title: 'Go back to watching?', text: 'The site stops making records, and staff need to enter checks in Zeffy again.', yes: 'Go back to watching', careful: true });
    if (yes) act({ action: 'mode', mode: 'watch', saw: v.mode }, 'The site is watching');
  };
  const stopped = (Number(test?.tries) || 1) >= 3;
  return html`
    ${v.lastError ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The last run didn’t finish.</strong> It tries again on its own in a few minutes.</div></div>` : ''}
    ${test && !test.ok && !test.leftBehind?.length && !v.paused ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The site couldn’t save a test record in Zeffy.</strong> ${stopped ? 'It tried on 3 days and has stopped, so something in Zeffy needs a look. Tell Peter.' : 'It tries again tomorrow.'} Until a test works, the site can’t be turned on.</div></div>` : ''}
    ${v.paused ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The site stopped entering checks.</strong> It was turned on, but Zeffy wouldn’t take its new $1 test record, so it’s only watching. ${stopped ? 'It tried on 3 days and has stopped, so something in Zeffy needs a look. Tell Peter. Until then, enter' : 'Enter'} checks deposited in Mercury in Zeffy by hand${stopped ? '' : ' until this goes away'}.</div></div>` : ''}
    ${v.money?.loose?.length ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The weekly money check found ${(v.money.count ?? v.money.loose.length) === 1 ? 'a check gift' : `${v.money.count ?? v.money.loose.length} check gifts`} in Zeffy with no check in Mercury.</strong> ${v.money.loose.slice(0, 10).map((x) => `${x.name || 'No name'}, ${usd(x.cents)}, ${fromUnix(x.at)}`).join('; ')}${(v.money.count ?? v.money.loose.length) > 10 ? `; and ${(v.money.count ?? v.money.loose.length) - 10} more` : ''}. One may be a check entered twice: if it’s a second record for a check already in Zeffy, delete that extra record. If it’s one of several gifts a single check paid, or a check deposited at another bank, nothing to do. This updates each Monday.</div>
      <div class="notice__actions"><a class="btn btn-ghost" href=${ZEFFY_URL} target="_blank" rel="noopener">Open Zeffy</a></div></div>` : ''}
    ${test?.ok && test.address && !test.address.ok ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The site isn’t adding donors’ addresses in Zeffy.</strong> Zeffy didn’t keep the test address, so addresses from checks and letters show here but aren’t added. Checks still go in. Tell Peter.</div></div>` : ''}
    ${v.matchFailing ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The hourly look at Zeffy isn’t working.</strong> Since ${fmtDay(v.matchFailing.since)}, ${v.matchFailing.error}. Hand entries don’t link to their checks until it works, and it keeps trying.</div></div>` : ''}
    ${test?.leftBehind?.length ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>Zeffy wouldn’t let the site remove its test ${test.leftBehind.length === 1 ? 'record' : 'records'}.</strong> ${test.leftBehind.length === 1 ? 'Delete the $1 SOARD WebsiteTest entry in Zeffy. It isn’t a gift, and this goes away on its own once it’s gone.' : 'Delete the $1 SOARD WebsiteTest entries in Zeffy. They aren’t gifts, and this goes away on its own once they’re gone.'}${!test.ok ? ' Until a test works, the site can’t be turned on.' : ''}</div>
      <div class="notice__actions"><a class="btn btn-ghost" href=${ZEFFY_URL} target="_blank" rel="noopener">Open Zeffy</a></div></div>` : ''}
    <div class="notice ${on ? 'notice--success' : ''}">
      <div class="notice__body">
        ${on ? html`<strong>The site enters checks in Zeffy.</strong> Only checks deposited in Mercury, and nothing goes to donors.${v.onBy ? ` Turned on by ${firstOf(v.onBy)}${v.onAt ? ` on ${fmtDay(v.onAt)}` : ''}.` : ''}`
        : html`<strong>The site is watching.</strong> Staff keep entering checks in Zeffy, and the site compares each one with what it would have done. ${score}${!test ? ' It still has to prove it can save to Zeffy, which it does by itself.' : ''}`}
      </div>
      <div class="notice__actions">
        ${on ? html`<button class="btn btn-ghost ck-mode" disabled=${!!busy} onClick=${turnOff}>${busy === 'mode:' ? 'Working…' : 'Go back to watching'}</button>`
        : canTurnOn ? html`<button class="btn btn-primary ck-mode" disabled=${!!busy} onClick=${turnOn}>${busy === 'mode:' ? 'Working…' : 'Let the site enter checks'}</button>` : ''}
      </div>
    </div>`;
}

export function Checks({ addToast = () => {}, onCount = () => {} }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [forms, setForms] = useState(null);
  const needed = useRef(false);
  // Each look and each action counts: a look that started before an action answered is older than it, and is dropped
  const gen = useRef(0);

  const take = (j) => { setV(j); onCount(j.waiting || 0); };
  const load = async () => {
    const mine = ++gen.current;
    const j = await call();
    if (mine !== gen.current) return;
    if (!j.success) { setErr(j.error || 'Could not load the checks'); return; }
    setErr(null);
    take(j);
  };
  const needsForms = (view) => view?.mode === 'on' && (view.list || []).some((c) => ['person', 'left-out', 'store'].includes(c.state));
  const formsAsked = useRef(false);
  const formsAt = useRef(0);
  const [formsFailed, setFormsFailed] = useState(false);
  const loadForms = async (quiet = false) => {
    if (formsAsked.current) return;
    formsAsked.current = true;
    const j = await call('?forms=1');
    formsAsked.current = false;
    if (j.success) { setForms(j.forms || []); formsAt.current = Date.now(); setFormsFailed(false); }
    else {
      setFormsFailed(true);
      if (!quiet) addToast('Couldn’t read Zeffy’s forms. The site tries again in a moment.', 'error');
    }
  };
  // A form opened or closed in Zeffy shows here within a minute while an entry is open
  const formsGone = () => loadForms(true);
  useEffect(() => { load(); }, []);
  // A save still being answered (maybe from before this tab was opened) is looked at again in five seconds
  const answering = (v?.list || []).some((c) => ['creating', 'unsure'].includes(c.state));
  useEffect(() => { if (!answering) return undefined; const t = setTimeout(() => { if (!document.hidden) load(); }, 5000); return () => clearTimeout(t); }, [answering, v]);
  // Looks again when the tab comes back and every 15 seconds while it's open (the tab's count keeps the same pace); an entry being typed keeps its own words (drafts)
  useEffect(() => {
    const look = () => {
      if (document.hidden) return;
      load();
      // The form list stays wanted until it comes, so one failed read doesn't leave every entry waiting; once here, it's read again each minute
      if (needed.current || (formsWanted.current && Date.now() - formsAt.current > 55000)) loadForms(true);
    };
    const t = setInterval(look, 15000);
    document.addEventListener('visibilitychange', look);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', look); };
  }, []);
  // The form list, once there's something to pick for
  const needForms = needsForms(v) && !forms;
  needed.current = needForms;
  const formsWanted = useRef(false);
  formsWanted.current = needsForms(v);
  useEffect(() => { if (needForms) loadForms(); }, [needForms]);

  // The focus stays by what was done: the check if it's still here, else the top of its list
  const keepFocus = (id, mode = false) => requestAnimationFrame(() => {
    if (mode) { (document.querySelector('.ck .ck-mode') || document.querySelector('.ck h3'))?.focus?.({ preventScroll: true }); return; }
    const here = id && document.querySelector(`.ck [data-check="${CSS.escape(id)}"]`);
    // A check that moved out of Needs you is somewhere far down the list: the focus stays at the top of Needs you
    const inNeed = !!here?.classList.contains('ck-need');
    const moved = here && !inNeed && wasNeed.current;
    if (here && inNeed && !wasNeed.current) { here.focus(); here.scrollIntoView({ block: 'center' }); return; }
    ((moved ? null : here) || document.querySelector('.ck h3'))?.focus?.({ preventScroll: true });
  });
  const wasNeed = useRef(false);
  const act = async (body, done) => {
    const at = body.id && document.querySelector(`.ck [data-check="${CSS.escape(body.id)}"]`);
    wasNeed.current = !!at?.classList.contains('ck-need');
    at?.focus?.({ preventScroll: true });
    setBusy(`${body.action}:${body.id || ''}`);
    gen.current++;
    const j = await call('', body);
    setBusy(null);
    if (!j.success) {
      // Zeffy turned up an entry: the entry asks about it by name before saving another
      if (!j.entries?.length) addToast(j.error, 'error');
      await load();
      keepFocus(body.id, body.action === 'mode');
      if (j.entries?.length) return { double: j.entries };
      // A form that closed since: the list of forms is read again
      if (/form isn’t open|open donation form/.test(j.error || '')) return { formGone: true };
      return null;
    }
    gen.current++;
    setErr(null);
    if (body.id && body.action !== 'create') drafts.delete(body.id);
    take(j);
    const said = typeof done === 'function' ? done(j) : done;
    if (said) addToast(j.result?.result === 'linked' && body.action === 'create' ? 'Zeffy already had it, so it’s matched' : said, 'success');
    keepFocus(body.id, body.action === 'mode');
    return j;
  };
  const [retrying, setRetrying] = useState(false);
  const retry = async () => { setRetrying(true); await load(); setRetrying(false); };

  if (err && !v) {
    return html`<div class="notice notice--warn"><div class="notice__body"><strong>The checks didn’t load.</strong> ${err}</div><div class="notice__actions"><button class="btn btn-ghost" disabled=${retrying} onClick=${retry}>${retrying ? 'Trying…' : 'Try again'}</button></div></div>`;
  }
  if (!v) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;

  // One rule, from the server, for what waits on a person: the same one the tab's count uses
  const need = v.list.filter((c) => c.needsYou);
  const rest = v.list.filter((c) => !c.needsYou);
  return html`<div class="ck">
    ${err ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>This list may be out of date.</strong> The site couldn’t be reached just now, and it keeps trying.</div><div class="notice__actions"><button class="btn btn-ghost" disabled=${retrying} onClick=${retry}>${retrying ? 'Trying…' : 'Try again'}</button></div></div>` : ''}
    <${Status} v=${v} act=${act} busy=${busy} />
    ${need.length ? html`<section class="card ck-card">
      <div class="sec-head"><h3 tabindex="-1">Needs you <span class="count is-warn">${need.length}</span></h3><span class="sec-head__hint">The site can’t finish these on its own.</span></div>
      ${need.map((c) => html`<${NeedsYou} key=${c.id} c=${c} mode=${v.mode} act=${act} busy=${busy} forms=${forms} formsGone=${formsGone} formsFailed=${formsFailed} />`)}
    </section>` : ''}
    <section class="card ck-card">
      <div class="sec-head"><h3 tabindex="-1">Checks <span class="count">${rest.length}</span></h3><span class="sec-head__hint">${v.limited ? `Deposited in Mercury, newest first. ${need.length ? 'With Needs you, these' : 'These'} are ${v.shown} of ${v.all}; older ones are in Mercury.` : 'Deposited in Mercury, newest first'}</span></div>
      ${rest.length ? rest.map((c) => html`<${CheckRow} key=${c.id} c=${c} mode=${v.mode} act=${act} busy=${busy} forms=${forms} formsGone=${formsGone} formsFailed=${formsFailed} />`)
        : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">${need.length ? 'Nothing else yet.' : 'No checks yet. Each one shows up here on its own once it’s deposited in Mercury.'}</p></div>`}
    </section>
  </div>`;
}
