/**
 * Admin → Job Costs → Checks: every check deposited in Mercury, and its card to send to Zeffy
 * ===========================================================================
 * Over /api/checks-admin (functions/api/_check-gifts.js). Peter, Nov 10 2026:
 * "admin wants to approve all entries into zeffy". The site reads each check
 * and any letter attached in Mercury, looks through Zeffy, and fills in a card:
 * who it's from (a choice when the check and the letter say different names),
 * which Zeffy donor (a choice when Zeffy has more than one who could be them),
 * form, date, an optional email, and the mailing address. A person looks it
 * over and presses Send to Zeffy, This is the check (an entry Zeffy already
 * has), or Don't send to Zeffy, with why. Receipts and emails stay off, so
 * nothing reaches a donor.
 *
 * Every action says which version of the check the page showed (`saw`), so an
 * answer from an older screen never overrules someone else's newer one, and
 * what someone typed on a card stays while they look at another tab.
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { ask } from './ask.js';
import { sameGiver, surelySameGiver, sameName, nearlySameName, sameAddress, addressKey, addressLine, addressProblem, nameProblem, emailProblem, payerKey } from './checks-shared.js';

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

// What someone changed on a card, field by field, kept while they look at another tab and come back, until the check is
// decided (this page only, never stored): useField
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
const whoFor = (c) => `${usd(c.cents)}${c.payer ? ` from ${c.payer}` : ''}`;
/** Where a check that isn't waiting on anyone stands, in a tag */
function standing(c) {
  if (c.reason === 'amount-off') return ['Amounts differ', 'tag--warn'];
  if (c.reason === 'still-unpaid') return ['Unpaid in Zeffy', 'tag--warn'];
  if (c.state === 'created' || c.state === 'linked') return ['In Zeffy', 'tag--success'];
  if (c.state === 'left-out') return ['Not sent', ''];
  if (c.state === 'store') return ['Store account', ''];
  if (c.state === 'came-back') return ['Came back', 'tag--warn'];
  if (c.state === 'creating' || c.state === 'unsure') return ['Checking Zeffy', 'tag--info'];
  if (c.status === 'blocked') return ['Mercury is holding it', 'tag--warn'];
  if (c.state === 'person') return ['Waiting for Mercury', 'tag--info'];
  if (c.letter?.reading) return ['Reading the letter', 'tag--info'];
  if (c.state === 'read') return ['Getting its card ready', 'tag--info'];
  return ['Being read', 'tag--info'];
}

/** How it got there, in a few words */
function howItWent(c) {
  if (c.state === 'created') return `Sent by ${firstOf(c.by)}${c.formTitle ? ` on ${c.formTitle}` : ''}`;
  if (c.state === 'linked') return c.via === 'person' ? `Matched by ${firstOf(c.by)}` : 'Matched to the entry typed in Zeffy';
  if (c.state === 'store') return 'Deposited to the store’s account, so it’s the store’s money';
  if (c.state === 'left-out' && c.by) return `${c.why} (${firstOf(c.by)})`;
  if (c.state === 'read' || c.state === 'new') return 'Its card shows up here in a few minutes';
  return c.why || '';
}

/** What came with the check and where the donor's mail goes, as short facts beside it */
function mailFacts(c) {
  const l = c.letter;
  return html`
    ${c.checkNumber ? html`<span>Check ${c.checkNumber}</span>` : ''}
    ${c.drawer ? html`<span>Check from ${c.drawer}</span>` : ''}
    ${c.category ? html`<span>Category in Mercury: ${c.category}</span>` : ''}
    ${l?.reading ? html`<span>A letter is being read</span>` : ''}
    ${l?.unread && !l.reading && !l.todo && !['created', 'linked'].includes(c.state) ? html`<span>${l.unread === 1 ? 'A file is' : `${l.unread} files are`} with it in Mercury</span>` : ''}
    ${l?.name && !c.card ? html`<span>Letter: from ${l.name}</span>` : ''}
    ${c.mailInZeffy ? html`<span>Address in Zeffy</span>` : ''}
    ${c.emailTaken ? html`<span>The letter’s email is on another donor in Zeffy</span>` : ''}`;
}

function CheckRow({ c, act, busy }) {
  const [tag, tone] = standing(c);
  const how = howItWent(c);
  const dated = c.checkDate && c.checkDate !== c.depositDay ? `Dated ${fmtDay(c.checkDate)}` : '';
  // Left out (by a person, or by the site before every check had a card) or in the store's account: a person can still send it
  const reopen = ['left-out', 'store'].includes(c.state) && !c.zeffyId && ['pending', 'sent'].includes(c.status);
  return html`<div class="jc-charge" data-check=${c.id} tabindex="-1">
    <span class="jc-charge__date" title="The day it was deposited">${fmtDay(c.depositedAt)}</span>
    <div class="jc-charge__what">
      <strong id=${`ck-h-${c.id}`}>${c.payer || (['new', 'read'].includes(c.state) ? 'Not read yet' : 'Unknown')}</strong>
      <div class="jc-charge__meta">
        <span class="tag ${tone}">${tag}</span>
        ${how ? html`<span>${how}</span>` : ''}
        ${dated ? html`<span>${dated}</span>` : ''}
        ${c.memo ? html`<span>Memo: ${c.memo}</span>` : ''}
        ${mailFacts(c)}
        ${c.link ? html`<a class="link" href=${c.link} target="_blank" rel="noopener" aria-label=${`Open in Mercury: ${whoFor(c)}`}>Open in Mercury</a>` : ''}
      </div>
    </div>
    <span class="jc-charge__amt">${usd(c.cents)}</span>
    ${reopen ? html`<div class="jc-sort"><button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Send to Zeffy after all: ${whoFor(c)}`}
      onClick=${() => act({ action: 'reopen', id: c.id, saw: c.ver }, 'Its card is being made again')}>${busy === `reopen:${c.id}` ? 'Working…' : 'Send to Zeffy after all'}</button></div>` : ''}
    ${c.state === 'linked' ? html`<div class="jc-sort"><${Unlink} c=${c} act=${act} busy=${busy} /></div>` : ''}
  </div>`;
}

/** The matched entry isn't this check: it says what happens next, and points at Zeffy when the entry only needs fixing */
function Unlink({ c, act, busy }) {
  const press = async () => {
    const fix = c.toDo ? 'If that entry is this check with something to fix, fix it in Zeffy instead. ' : '';
    const yes = await ask({ title: 'Take this entry off?', text: `${fix}The check stops counting that Zeffy entry as its record, and the entry won’t be offered for it again. The check gets its card back, to send to Zeffy or match to another entry.`, yes: 'Take it off', careful: true });
    if (yes) act({ action: 'unlink', id: c.id, saw: c.ver }, 'That entry is off this check');
  };
  return html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Not this entry: ${whoFor(c)}`} onClick=${press}>${busy === `unlink:${c.id}` ? 'Working…' : 'Not this entry'}</button>`;
}

/** A file added after the record went into Zeffy, or an address Zeffy wouldn't take, has been looked at, and Zeffy says what it should */
function LetterDone({ c, act, busy }) {
  return html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Looked at it: ${whoFor(c)}`}
    onClick=${() => act({ action: 'letter-done', id: c.id, saw: c.ver }, 'Done')}>${busy === `letter-done:${c.id}` ? 'Working…' : 'Looked at it'}</button>`;
}

// The site's own rule for a card's form: a grant, a foundation or a fund goes on the newest grant form, everyone else the general one
const GIVING_BODY = /\b(foundation|trust|fund|grant|charitable|endowment)\b/i;
const suggestForm = (forms, name, category = '') => {
  const grant = (GIVING_BODY.test(name || '') || /\bgrants?\b/i.test(category || '')) && (forms || []).filter((f) => /grant funding/i.test(f.title)).sort((a, b) => b.title.localeCompare(a.title))[0];
  return (grant || (forms || []).find((f) => /brighter home/i.test(f.title)))?.id || '';
};
const ANOTHER = 'another';
const donorLabel = (d) => [d.name || 'No name', d.email, `${d.gifts} gift${d.gifts === 1 ? '' : 's'}${d.last ? `, last ${fromUnix(d.last)}` : ''}`].filter(Boolean).join(' · ');
/** Ana’s, Advisors’ */
const possessive = (name) => `${name}’${/s$/i.test(name) ? '' : 's'}`;

/**
 * A Zeffy donor is this giver: by their own name in Zeffy, or as one of the card's names the site tied them to (the one
 * learned, the letter's email), that name itself. Never through a third name: on Marcus and Elena Abernathy's check,
 * Elena's donor is the joint name's, and the joint name is Marcus's too, but she is never Marcus
 */
const fits = (d, who) => !!d && !!who && ((d.for || []).some((n) => sameName(n, who)) || sameGiver(d.name, who));
const sureOf = (d, who) => (d.sureFor || []).some((n) => sameName(n, who)) || surelySameGiver(d.name, who);

/** The donor a card starts on for a giver: the site's pick when it's theirs, else the one learned, the only sure one, New when Zeffy has none, else nobody (the person picks) */
function donorFor(k, who) {
  const donors = k.donors || [];
  if (!who) return '';
  if (k.donor && k.donor !== 'new' && donors.some((d) => d.id === k.donor && fits(d, who))) return k.donor;
  const theirs = donors.filter((d) => fits(d, who));
  const learned = theirs.find((d) => d.learned);
  if (learned) return learned.id;
  const sure = theirs.filter((d) => sureOf(d, who));
  if (sure.length === 1) return sure[0].id;
  return theirs.length ? '' : 'new';
}

/**
 * The mailing address choices for a card, given who it's going to and the donor picked: the letter's, the check's, Zeffy's
 * own, or one typed. Each of the letter's and the check's is someone's, and says whose when it isn't the giver picked; one
 * that's already Zeffy's for the donor is "Keep what Zeffy has", once
 */
function addressChoices(k, donor, name) {
  // Whose, when it isn't the giver picked: an address both the letter and the check give is each of theirs
  const whose = (owners) => { const o = owners.filter(Boolean); return o.length && !o.some((x) => nearlySameName(x, name)) ? ` (${possessive(o[0])})` : ''; };
  const kept = donor?.address || null;
  const both = !!k.letterAddress && sameAddress(k.letterAddress, k.checkAddress);
  const out = [];
  if (k.letterAddress && !sameAddress(k.letterAddress, kept)) {
    const owners = both ? [k.letterAddressFor, k.checkAddressFor] : [k.letterAddressFor];
    out.push({ key: 'letter', label: `${both ? 'From the letter and on the check' : 'From the letter'}${whose(owners)}: ${addressLine(k.letterAddress)}`, address: k.letterAddress, owners });
  }
  if (k.checkAddress && !both && !sameAddress(k.checkAddress, kept)) out.push({ key: 'check', label: `On the check${whose([k.checkAddressFor])}: ${addressLine(k.checkAddress)}`, address: k.checkAddress, owners: [k.checkAddressFor] });
  if (kept) out.push({ key: 'keep', label: `Keep what Zeffy has: ${addressLine(kept)}`, address: null });
  out.push({ key: 'type', label: 'Type an address', address: null });
  if (!kept) out.push({ key: 'none', label: 'No address', address: null });
  return out;
}
/** The address a card starts on: the letter's or the check's only when it's the address of whoever the gift is going to */
const startAddress = (choices, name) => choices.find((x) => (x.key === 'letter' || x.key === 'check') && (x.owners || []).some((o) => nearlySameName(o, name)))
  || choices.find((x) => x.key === 'keep') || choices.find((x) => x.key === 'none');

const ymd = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * One of a card's fields: what the site filled in until the person changes it, then theirs, kept while they look at another
 * tab and come back and through anything the card says after (a send Zeffy turned away, a colleague's look), until the check
 * is decided. One they never touched follows the card as it's made again (a letter read, a donor found) and the other fields
 * (the donor follows the name). meaning: what a value they picked stands for on the card as it is now ({ k, say }: the donor
 * under its name, the letter's address itself, a form still open). When the card is made again and a pick no longer stands
 * for what it did, it's let go and `changed` says what it was, so the card says so and asks again. touch: told of every
 * change the person makes, so the card knows what they last saw
 */
function useField(id, field, filled, { meaning = null, touch = null } = {}) {
  const [own, setOwn] = useState(() => { const d = drafts.get(id); return d && field in d ? d[field] : null; });
  const set = (v) => {
    const entry = { v, m: meaning ? meaning(v) : null };
    const d = drafts.get(id) || {};
    d[field] = entry;
    drafts.set(id, d);
    setOwn(entry);
    touch?.();
  };
  const clear = () => { const d = drafts.get(id); if (d) delete d[field]; setOwn(null); };
  const changed = !!own && !!meaning && meaning(own.v)?.k !== own.m?.k ? { ...own.m, v: own.v } : null;
  return { value: own && !changed ? own.v : filled, set, touched: !!own && !changed, clear, changed };
}

/** What a card says, as far as what a person sees on it goes: one made again with anything else is "changed since you started" */
const cardSeen = (k) => JSON.stringify([k.names.map((n) => payerKey(n.name)), payerKey(k.name), k.donor, (k.donors || []).map((d) => [d.id, payerKey(d.name), d.email, addressKey(d.address), !!d.learned]), k.email, addressKey(k.letterAddress), addressKey(k.checkAddress), k.formId, k.formFor, k.category]);

/** A check's card: everything filled in by the site, for a person to look over and send */
function ApproveCard({ c, act, busy, forms, formsGone, formsFailed, dontReasons, sending, joinOk }) {
  const k = c.card;
  const donors = k.donors || [];
  const several = k.names.length > 1;
  // One of the card's names, however it's spelled now (a letter read again as "Okafor Lindgren" for "Okafor-Lindgren")
  const listedAs = (who) => (who ? k.names.find((n) => sameName(n.name, who))?.name || '' : '');
  const listed = (who) => !!listedAs(who);
  // What the card was when the person last changed something on it, or last sent it (their own Send's answer isn't the
  // site changing the card)
  const seenNow = cardSeen(k);
  const own = drafts.get(c.id);
  // The card a person's own refused answer left (the site's version after it): seen, so it isn't "updated since you started"
  if (own?.__adoptVer && own.__adoptVer === c.ver) { own.__seen = seenNow; delete own.__adoptVer; }
  const touch = () => { const d = drafts.get(c.id) || {}; d.__seen = seenNow; drafts.set(c.id, d); };
  const updated = !!own?.__seen && own.__seen !== seenNow;

  // Who it's from: one of the names the check and its letter give (by the name itself, so a card made again never shifts
  // it), or a name typed. Whichever the person did last is their answer; a typed name stays typed whatever the card says
  // after, and a listed name that's gone from the card is let go
  const startWho = listed(k.name) ? { pick: k.name } : several && !k.name ? { pick: '' } : { typed: true };
  const who = useField(c.id, 'who', startWho, { meaning: (v) => (v.typed || listed(v.pick) ? { k: 'ok' } : { k: 'gone', say: v.pick }), touch });
  const typedName = useField(c.id, 'typedName', listed(k.name) ? '' : k.name || '', { touch });
  const picked = who.value.typed ? '' : listedAs(who.value.pick) || who.value.pick || '';
  const name = (who.value.typed ? typedName.value : picked).trim();
  const choice = who.value.typed ? ANOTHER : picked;

  // A send before this card that Zeffy never answered: the card starts on what that person chose, for that giver (the
  // server put its donor, form, date and email on the card; its address is picked here)
  const sent = k.sent && sameGiver(k.sent.name, name) ? k.sent : null;
  const sentDonor = sent && (sent.donor === 'new' || donors.some((d) => d.id === sent.donor)) ? sent.donor : null;
  // Which of the card's names a donor is under (the same whether the card has one name or two), or none of them
  const groupOf = (d) => payerKey(k.names.find((n) => fits(d, n.name))?.name || '') || 'other';
  // The donor follows who it's from until someone picks one. A pick no longer on the card, or under another name now, is
  // let go, and the person picks again
  const donorField = useField(c.id, 'donor', sentDonor || donorFor(k, name), {
    meaning: (v) => { if (v === 'new') return { k: 'new' }; const d = donors.find((x) => x.id === v); return d ? { k: `${v}|${groupOf(d)}`, say: 'moved' } : { k: 'gone', say: 'gone' }; },
    touch,
  });
  const donor = donorField.changed ? '' : donorField.value;
  const picks = donors.find((d) => d.id === donor) || null;
  const isOpen = (id) => !!id && (forms || []).some((f) => f.id === id);
  // The site's own form for the name picked (its rule: the memo, Mercury's category, the giver's past gifts); a name typed or
  // fixed keeps the check's. The page's own rule only when the site's form has closed
  const siteForm = (listed(name) && k.formFor?.[listedAs(name)]) || k.formId;
  const guessForm = (isOpen(siteForm) && siteForm) || (isOpen(k.formId) && k.formId) || suggestForm(forms, name, c.category) || '';
  // A form picked that closes in Zeffy is let go, and the person picks again (until the forms are read, a pick stands)
  const formField = useField(c.id, 'formId', guessForm, {
    meaning: (v) => (!forms || isOpen(v) ? { k: 'open', say: (forms || []).find((f) => f.id === v)?.title || '' } : { k: 'closed' }),
    touch,
  });
  const formId = formField.changed ? '' : formField.value;
  const dayField = useField(c.id, 'day', k.day, { touch });
  const day = dayField.value;
  // The letter's email is its giver's: filled in only for them by their own name, with the donor picked being them (or
  // new), and only while no other donor here has it in Zeffy
  const letterMail = String(k.email || '').toLowerCase();
  const heldBy = letterMail ? donors.find((d) => d.id !== donor && String(d.email || '').toLowerCase() === letterMail) : null;
  const letterGiver = !!letterMail && !!k.emailFor && surelySameGiver(k.emailFor, name) && (!picks || fits(picks, k.emailFor));
  const emailField = useField(c.id, 'email', letterGiver && !heldBy ? k.email : '', { touch });
  const email = emailField.value;
  const choices = addressChoices(k, picks, name);
  // The address that send chose: one of the choices if it's one of them, else typed
  const sentChoice = sent ? (sent.address ? choices.find((x) => x.address && sameAddress(x.address, sent.address)) || choices.find((x) => x.key === 'keep' && sameAddress(picks?.address, sent.address)) : choices.find((x) => x.key === 'none' || x.key === 'keep')) : null;
  const sentTyped = sent?.address && !sentChoice;
  // An address picked stands for the address itself: the letter's re-read with another one, or Zeffy's changed, lets the
  // pick go, and the person picks again. "No address" and "Keep what Zeffy has" both leave the donor's address as it is
  const addrMeaning = (key) => {
    if (key === 'none' || key === 'keep') return { k: 'leave' };
    if (key === 'type' || !key) return { k: key || '' };
    const a = key === 'letter' ? k.letterAddress : key === 'check' ? k.checkAddress : null;
    return a ? { k: `${key}|${addressKey(a)}`, say: key } : { k: 'gone', say: key };
  };
  const addrField = useField(c.id, 'addrKey', sentTyped ? 'type' : sentChoice?.key || '', { meaning: addrMeaning, touch });
  const typedField = useField(c.id, 'typed', sentTyped ? { line1: sent.address.line1 || '', city: sent.address.city || '', state: sent.address.state || '', postal_code: sent.address.postal_code || '' } : { line1: '', city: '', state: '', postal_code: '' }, { touch });
  const typed = typedField.value;
  const dontOpenField = useField(c.id, 'dontOpen', k.suggest === 'dont', { touch });
  const dontReasonField = useField(c.id, 'dontReason', k.dontReason || '', { touch });
  const dontOpen = dontOpenField.value;
  const dontReason = dontReasonField.value;
  const [linking, setLinking] = useState(null);
  const [, setSeenTick] = useState(0);
  const here = useRef(true);
  useEffect(() => () => { here.current = false; }, []);
  // (the letter's or the check's picked, now shown as another choice of the same address: the letter's and the check's as
  // one, or "Keep what Zeffy has" when the donor picked has it already. It's still that address)
  const pickedAddress = addrField.value === 'letter' ? k.letterAddress : addrField.value === 'check' ? k.checkAddress : null;
  const addrPicked = addrField.changed ? null : choices.find((x) => x.key === addrField.value)
    || (['none', 'keep'].includes(addrField.value) ? choices.find((x) => x.key === 'none' || x.key === 'keep') : null)
    || (pickedAddress ? choices.find((x) => x.address && sameAddress(x.address, pickedAddress)) || (sameAddress(pickedAddress, picks?.address) ? choices.find((x) => x.key === 'keep') : null) : null);
  const addr = addrField.changed ? { key: '', address: null } : addrPicked || startAddress(choices, name);
  /** A name picked from the list (or "Another name…"): a donor picked for someone else goes back to following the giver */
  const pickName = (v) => {
    const next = v === ANOTHER ? { typed: true } : { pick: v };
    who.set(next);
    const whoNow = v === ANOTHER ? typedName.value.trim() : v;
    if (donorField.touched && donorField.value !== 'new' && !fits(donors.find((d) => d.id === donorField.value), whoNow)) donorField.clear();
  };
  /**
   * A donor picked under another of the card's names: who it's from becomes that name, so the two never disagree. A name
   * the person typed is never typed over: the card says the donor isn't them instead, and Send waits
   */
  const pickDonor = (id) => {
    donorField.set(id);
    const d = donors.find((x) => x.id === id);
    if (!d || fits(d, name)) return;
    const theirs = k.names.find((n) => fits(d, n.name));
    if (theirs && !(who.value.typed && typedName.touched && name)) { who.set({ pick: theirs.name }); return; }
    if (!name || !(who.value.typed && typedName.touched)) { who.set({ typed: true }); typedName.set(d.name || ''); }
  };
  const usable = !!c.checkDate && c.checkDate <= c.depositDay && Date.parse(`${c.depositDay}T12:00:00Z`) - Date.parse(`${c.checkDate}T12:00:00Z`) <= 60 * 86400e3;
  const dayLabel = day !== k.day || (sent?.day && sent.day === day) ? 'Date' : usable ? 'Date on the check' : c.checkDate ? 'Date (the deposit day: the check’s own date isn’t one to use)' : 'Date (the site couldn’t read one, so the deposit day)';
  // The server's limits on the date: not after the deposit, nor more than a year before it
  const earliest = c.depositDay ? ymd(Date.parse(`${c.depositDay}T12:00:00Z`) - 366 * 86400e3) : '';
  const typedAddress = { line1: typed.line1.trim(), city: typed.city.trim(), state: typed.state.trim().toUpperCase(), postal_code: typed.postal_code.trim() };
  const typedProblem = addr.key === 'type' ? addressProblem(typedAddress, c.checkNumber || '') : '';
  const address = addr.key === 'type' ? typedAddress : addr.address;
  const donorEmail = picks?.email || '';
  const typedMail = donorEmail ? '' : email.trim();
  // An email Zeffy has on another donor here would file this gift under them: said now, as Send would
  const mailHolder = typedMail ? donors.find((d) => d.id !== donor && String(d.email || '').toLowerCase() === typedMail.toLowerCase()) : null;
  const noJoin = !!picks && !donorEmail && !joinOk;
  const noForms = !!forms && !forms.length;
  const posted = ['pending', 'sent'].includes(c.status);
  const addrSays = (m) => (m?.say === 'letter' ? 'the letter’s address' : m?.say === 'check' ? 'the address on the check' : 'that address');
  const otherSending = !!busy && busy !== `send:${c.id}` && busy.startsWith('send:');
  const missing = !sending ? 'Sending is off until the site’s Zeffy test passes.'
    : otherSending ? 'Another check is being sent to Zeffy. This one can go in a moment.'
    : !posted ? 'Mercury hasn’t taken this check yet.'
    : c.letter?.reading ? 'A letter attached in Mercury is still being read.'
    : !name ? 'Say who it’s from.'
    : nameProblem(name, c.checkNumber || '') ? nameProblem(name, c.checkNumber || '')
    : donorField.changed ? (donorField.changed.say === 'moved' ? 'The Zeffy donor you picked is under another name on this card now. Pick the donor again.' : 'The Zeffy donor you picked isn’t on this card any more. Pick the donor again.')
    : !donor ? 'Pick the Zeffy donor, or New donor.'
    : picks && !fits(picks, name) ? `That Zeffy donor is ${picks.name || 'someone else'}. Pick the donor for ${name}, or New donor.`
    : noJoin ? 'Zeffy can’t file a gift under a donor with no email yet: pick New donor, or add their email in Zeffy first.'
    : !forms ? (formsFailed ? 'Zeffy’s forms couldn’t be read. The site is trying again.' : 'Zeffy’s forms are loading.')
    : noForms ? 'Zeffy has no open donation form to send this on.'
    : formField.changed ? `The form you picked${formField.changed.say ? ` (${formField.changed.say})` : ''} closed in Zeffy. Pick another.`
    : !isOpen(formId) ? 'Pick a Zeffy form.'
    : !day ? 'Pick a date.'
    : day > c.depositDay ? 'That date is after the check was deposited. Use the date on the check, or the day it was deposited.'
    : earliest && day < earliest ? 'That date is more than a year before the check was deposited. Use the day it was deposited instead.'
    : emailProblem(typedMail) ? emailProblem(typedMail)
    : mailHolder ? `Zeffy has ${typedMail} on ${mailHolder.name || 'another donor'}. If the gift is theirs, pick them under Zeffy donor; if not, check the email, or leave it empty.`
    : addrField.changed ? `${addrSays(addrField.changed).replace(/^t/, 'T')} changed since you picked it. Pick the mailing address again.`
    : typedProblem ? `Finish the address: ${typedProblem.charAt(0).toLowerCase()}${typedProblem.slice(1)}`
    : '';
  const theirs = donors.filter((d) => fits(d, name));
  // A name the card looked up in Zeffy: one of its own, or one a Send looked up (a donor added for it)
  const lookedUp = !name || listed(name) || sameName(name, k.name) || donors.some((d) => (d.for || []).some((f) => sameName(f, name)));
  const donorHint = !name ? 'Say who it’s from, and the donors Zeffy has for them show here.'
    : donorField.changed ? (donorField.changed.say === 'moved' ? 'The donor you picked is under another name now. Pick one.' : 'The donor you picked isn’t on this card any more. Pick one.')
    : donor === '' ? (theirs.length > 1 ? 'Zeffy has more than one donor who could be them. Pick the right one.' : theirs.length ? 'Zeffy has a donor who may be them. Pick them if it is, or New donor.' : 'Pick a donor, or New donor.')
    : donor === 'new' ? (theirs.length ? `Zeffy has ${theirs.length === 1 ? 'a donor' : `${theirs.length} donors`} by this name. New donor makes another.`
      : lookedUp ? 'Zeffy has no donor by this name yet, so a new one is made.' : 'Send looks for this name in Zeffy first, and shows a donor it already has before making a new one.')
    : 'Already in Zeffy: the gift joins their history.';
  // What changed on the card since the person started on it, in words, at the top of the card, each put away by "OK"
  // once looked at (the card's name taken as it is now; the card as it is now seen)
  const since = [
    who.changed ? { text: `You picked ${who.changed.v?.pick || 'a name'}, and that name isn’t on this check any more${k.name ? `: it’s from ${k.name} now` : ''}.`, ok: () => { who.clear(); touch(); } } : null,
    updated && !who.changed ? { text: 'The site updated this card since you started (a letter read, or something new in Zeffy). Look it over before you send.', ok: () => { touch(); setSeenTick((n) => n + 1); } } : null,
  ].filter(Boolean);
  const sendingNow = busy === `send:${c.id}`;
  // The card as it is now, for an answer given after a question: what it says may have changed while the question was open
  const latest = useRef(null);
  const send = async (notThose = false, shown = [], saw = c.ver) => {
    const j = await act({ action: 'send', id: c.id, saw, name, donor, formId, day, email: typedMail, address: address || null, notThose, shown, donorsShown: donors.map((d) => d.id) }, 'Sent to Zeffy');
    // A form that closed: the forms are read again, and the pick then says it closed and waits for another
    if (j?.formGone) { formsGone(); return; }
    // Moved to another tab meanwhile: the card waits with the entry beside it, and nothing is asked off the page
    if (j?.double && (!here.current || !document.querySelector(`.ck [data-check="${CSS.escape(c.id)}"]`))) return;
    if (j?.double) {
      // The entry it asks about is named right here, so nobody answers about something they can't see
      const list = j.double.map((x) => `${x.name || 'No name'}, ${usd(x.cents)}, ${fromUnix(x.at)}${x.form ? `, ${x.form}` : ''}`).join('; ');
      const one = j.double.length === 1;
      const yes = await ask({
        title: 'Is this a different gift?',
        text: `Zeffy has ${one ? 'an entry' : 'entries'} that may be this check: ${list}. If ${one ? 'it is' : 'one is'}, press Cancel and choose “This is the check” beside it. Send a new record only if this check is a different gift.`,
        yes: 'Send a new record', careful: true,
      });
      // Sent as the card is now, against the version the question was asked on: a card made again meanwhile is refused by
      // the server ("This check just changed"), and the card says what changed
      const now = latest.current;
      if (yes && here.current && now && !now.missing) await now.send(true, [...shown, ...j.double.map((x) => x.id)], j.ver || 'person');
    } else if (j) drafts.delete(c.id);
  };
  const dontSend = async () => {
    const yes = await ask({ title: 'Don’t send this check to Zeffy?', text: `${whoFor(c)} won’t be recorded in Zeffy: ${dontReasons[dontReason]}. “Send to Zeffy after all” undoes it.`, yes: 'Don’t send', careful: true });
    if (yes) act({ action: 'dont-send', id: c.id, saw: c.ver, reason: dontReason }, 'Not sent to Zeffy');
  };
  const matchTo = async (x) => {
    if (x.cents !== c.cents) {
      const yes = await ask({ title: 'The amounts are different', text: `That entry is ${usd(x.cents)} and this check is ${usd(c.cents)}. Match them anyway, then fix the amount in Zeffy.`, yes: 'Match them', careful: true });
      if (!yes) return;
    }
    setLinking(x.id);
    await act({ action: 'link', id: c.id, zeffyId: x.id, saw: c.ver }, 'Matched to that entry');
    if (here.current) setLinking(null);
  };
  const entries = c.candidates || [];
  const fid = (f) => `ck-${f}-${c.id}`;
  // The donor list, by whose donor each is when the check and its letter name different people
  const option = (d) => html`<option key=${d.id} value=${d.id}>${donorLabel(d)}</option>`;
  const groups = several ? k.names.map((n) => ({ label: `${n.name} (${n.from === 'letter' ? 'from the letter' : 'on the check'})`, list: donors.filter((d) => fits(d, n.name) && k.names.find((m) => fits(d, m.name)) === n) })) : [];
  const ungrouped = several ? donors.filter((d) => !k.names.some((n) => fits(d, n.name))) : donors;
  const ready = !k.notes.length && !since.length && !missing;
  latest.current = { send, missing, since: since.length };
  const sendRef = useRef(null);
  // Enter in a field while Send is off: to Send, whose reason (said beside it) is read out
  const submit = (e) => { e.preventDefault(); if (busy) return; if (missing) { sendRef.current?.focus(); return; } send(); };
  return html`<form class="ck-need ck-approve" data-check=${c.id} tabindex="-1" aria-labelledby=${`ck-h-${c.id}`} onSubmit=${submit}>
    <div class="ck-approve__head">
      <div>
        <strong id=${`ck-h-${c.id}`} class="ck-approve__amt">${usd(c.cents)}${name ? html`<span class="ck-approve__from"> from ${name}</span>` : ''}</strong>
        <div class="jc-charge__meta">
          <span>Deposited ${fmtDay(c.depositedAt)}</span>
          ${c.checkDate && c.checkDate !== c.depositDay ? html`<span>Dated ${fmtDay(c.checkDate)}</span>` : ''}
          ${c.memo ? html`<span>Memo: ${c.memo}</span>` : ''}
          ${mailFacts(c)}
          ${c.link ? html`<a class="link" href=${c.link} target="_blank" rel="noopener" aria-label=${`See the check in Mercury: ${whoFor(c)}`}>See the check in Mercury</a>` : ''}
        </div>
      </div>
      <span class="tag ${k.notes.length || since.length ? 'tag--warn' : ready ? 'tag--success' : ''}">${k.notes.length || since.length ? 'Look first' : ready ? 'Ready to send' : 'Not ready yet'}</span>
    </div>
    ${k.notes.length || since.length ? html`<ul class="ck-notes">${since.map((t) => html`<li key=${t.text} class="ck-since"><span>${t.text}</span> <button type="button" class="btn btn-ghost btn-sm" aria-label=${`OK, looked at it: ${t.text}`} onClick=${t.ok}>OK</button></li>`)}${k.notes.map((n) => html`<li key=${n.kind}>${n.text}</li>`)}</ul>` : ''}
    ${entries.length ? html`<ul class="ck-cands" aria-label="Zeffy entries that may be this check">
      ${entries.map((x) => html`<li key=${x.id}>
        <span><strong>${x.name || 'No name'}</strong> · ${usd(x.cents)} · ${fromUnix(x.at)}${x.form ? ` · ${x.form}` : ''}</span>
        <button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`This is the check: ${x.name || 'No name'}, ${usd(x.cents)}, ${fromUnix(x.at)}, for ${whoFor(c)}`} onClick=${() => matchTo(x)}>${busy === `link:${c.id}` && linking === x.id ? 'Working…' : 'This is the check'}</button>
      </li>`)}
    </ul>` : ''}
    <div class="jc-grid2">
      ${several ? html`<label class="jc-field"><span>Who it’s from</span>
          <select class="form-select" value=${choice} onChange=${(e) => pickName(e.target.value)}>
            ${choice === '' ? html`<option value="">Pick one</option>` : ''}
            ${k.names.map((n) => html`<option key=${n.name} value=${n.name}>${n.name} (${n.from === 'letter' ? 'from the letter' : 'on the check'})</option>`)}
            <option value=${ANOTHER}>Another name…</option>
          </select></label>` : ''}
      ${!several || choice === ANOTHER ? html`<label class="jc-field"><span>${several ? 'Another name' : 'Who it’s from'}</span>
          <input class="form-input" value=${who.value.typed ? typedName.value : who.value.pick || ''} maxlength="120" autocomplete="off" placeholder=${c.reason === 'bank' ? 'The person or company it’s from' : 'The person or organization'} onInput=${(e) => { if (!who.value.typed) who.set({ typed: true }); typedName.set(e.target.value); }} /></label>` : ''}
      <label class="jc-field"><span id=${fid('donor-l')}>Zeffy donor</span>
        <select class="form-select" value=${donor} aria-labelledby=${fid('donor-l')} aria-describedby=${fid('donor-hint')} onChange=${(e) => pickDonor(e.target.value)}>
          ${!donor ? html`<option value="">Pick one</option>` : ''}
          ${groups.map((g) => (g.list.length ? html`<optgroup key=${g.label} label=${g.label}>${g.list.map(option)}</optgroup>` : ''))}
          ${several && ungrouped.length ? html`<optgroup label="Other donors in Zeffy">${ungrouped.map(option)}</optgroup>` : ungrouped.map(option)}
          <option value="new">New donor in Zeffy</option>
        </select>
        <span class="ck-hint" id=${fid('donor-hint')}>${donorHint}</span>
      </label>
      <label class="jc-field"><span>Zeffy form</span>
        <select class="form-select" value=${formId} disabled=${!forms || noForms} onChange=${(e) => formField.set(e.target.value)}>
          ${!forms ? html`<option value="">${formsFailed ? 'Couldn’t read Zeffy’s forms. Trying again…' : 'Loading forms…'}</option>` : html`<option value="">${noForms ? 'No open forms in Zeffy' : 'Pick a form'}</option>`}
          ${(forms || []).map((f) => html`<option value=${f.id}>${f.title}</option>`)}
        </select></label>
      <label class="jc-field"><span>${dayLabel}</span><input class="form-input" type="date" value=${day} min=${earliest} max=${c.depositDay} onInput=${(e) => dayField.set(e.target.value)} /></label>
      <label class="jc-field"><span id=${fid('email-l')}>Email (optional)</span>
        ${donorEmail ? html`<input class="form-input" value=${donorEmail} readonly aria-labelledby=${fid('email-l')} aria-describedby=${fid('email-hint')} />`
          : html`<input class="form-input" type="email" value=${email} maxlength="120" autocomplete="off" placeholder="None" aria-labelledby=${fid('email-l')} aria-describedby=${fid('email-hint')} onInput=${(e) => emailField.set(e.target.value)} />`}
        <span class="ck-hint" id=${fid('email-hint')}>${donorEmail ? 'Zeffy has this email for them.' : heldBy && !email.trim() ? (fits(heldBy, name)
          ? `Zeffy has the letter’s email on one of ${possessive(name)} donors. Pick that donor under Zeffy donor to use it.`
          : `The letter’s email is on ${heldBy.name || 'another donor'} in Zeffy, so it isn’t filled in here. One typed goes on the donor; nothing is emailed to them.`) : 'It goes on the donor in Zeffy. Nothing is emailed to them.'}</span>
      </label>
      <label class="jc-field"><span id=${fid('addr-l')}>Mailing address</span>
        <select class="form-select" value=${addr.key} aria-labelledby=${fid('addr-l')} aria-describedby=${fid('addr-hint')} onChange=${(e) => addrField.set(e.target.value)}>
          ${addr.key === '' ? html`<option value="">Pick one</option>` : ''}
          ${choices.map((x) => html`<option key=${x.key} value=${x.key}>${x.label}</option>`)}
        </select>
        <span class="ck-hint" id=${fid('addr-hint')}>${addrField.changed ? `${addrSays(addrField.changed).replace(/^t/, 'T')} changed since you picked it. Pick again.` : addr.address ? `Goes on the donor: ${addressLine(addr.address)}` : addr.key === 'keep' ? `Zeffy keeps ${addressLine(picks?.address)}` : addr.key === 'type' ? 'Type it below.' : 'No address goes on the donor.'}</span></label>
    </div>
    ${addr.key === 'type' ? html`<fieldset class="ck-typed"><legend>The address to put on the donor</legend>
      <label class="jc-field ck-typed__street"><span>Street</span><input class="form-input" value=${typed.line1} maxlength="100" autocomplete="off" onInput=${(e) => typedField.set({ ...typed, line1: e.target.value })} /></label>
      <label class="jc-field"><span>City</span><input class="form-input" value=${typed.city} maxlength="50" autocomplete="off" onInput=${(e) => typedField.set({ ...typed, city: e.target.value })} /></label>
      <label class="jc-field"><span>State</span><input class="form-input" value=${typed.state} maxlength="2" autocomplete="off" placeholder="GA" onInput=${(e) => typedField.set({ ...typed, state: e.target.value })} /></label>
      <label class="jc-field"><span>ZIP</span><input class="form-input" value=${typed.postal_code} maxlength="10" inputmode="numeric" autocomplete="off" onInput=${(e) => typedField.set({ ...typed, postal_code: e.target.value })} /></label>
    </fieldset>` : ''}
    ${noForms ? html`<p class="sec-head__hint ck-note">Zeffy has no open donation form to send this on. Open one in Zeffy, and it shows up here within a minute.</p>` : ''}
    <p class="ck-hint ck-missing" id=${fid('missing')} aria-live="polite">${missing}</p>
    <div class="jc-row ck-actions">
      <button type="submit" ref=${sendRef} class="btn btn-primary btn-sm" aria-disabled=${missing || busy ? 'true' : undefined} aria-describedby=${missing ? fid('missing') : undefined} aria-label=${`Send to Zeffy: ${whoFor({ ...c, payer: name })}`}>${sendingNow ? 'Sending…' : 'Send to Zeffy'}</button>
      <button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} aria-expanded=${dontOpen ? 'true' : 'false'} aria-controls=${dontOpen ? fid('dont') : undefined} onClick=${() => dontOpenField.set(!dontOpen)}>Don’t send to Zeffy</button>
    </div>
    ${dontOpen ? html`<div class="jc-row ck-dont" id=${fid('dont')}>
      <label class="jc-field"><span>Why it isn’t for Zeffy</span>
        <select class="form-select" value=${dontReason} onChange=${(e) => dontReasonField.set(e.target.value)}>
          <option value="">Pick one</option>
          ${Object.entries(dontReasons || {}).map(([key, words]) => html`<option value=${key}>${words}</option>`)}
        </select></label>
      <button type="button" class="btn btn-ghost btn-sm" disabled=${!dontReason || !!busy} aria-label=${`Don’t send: ${whoFor(c)}`} onClick=${dontSend}>${busy === `dont-send:${c.id}` ? 'Working…' : 'Don’t send'}</button>
    </div>` : ''}
  </form>`;
}

/** A check in Zeffy with something left to do there, or one that came back */
function ToDo({ c, act, busy }) {
  return html`<div class="ck-need" data-check=${c.id} tabindex="-1">
    <div>
      <strong id=${`ck-h-${c.id}`}>${whoFor(c)}</strong>
      <div class="jc-charge__meta">
        <span>Deposited ${fmtDay(c.depositedAt)}</span>
        ${c.memo ? html`<span>Memo: ${c.memo}</span>` : ''}
        ${mailFacts(c)}
        ${c.link ? html`<a class="link" href=${c.link} target="_blank" rel="noopener" aria-label=${`See the check in Mercury: ${whoFor(c)}`}>See the check in Mercury</a>` : ''}
      </div>
    </div>
    <p class="ck-need__why">${c.why}</p>
    <div class="jc-row ck-actions">
      <a class="btn btn-ghost btn-sm" href=${ZEFFY_URL} target="_blank" rel="noopener" aria-label=${`Open Zeffy: ${whoFor(c)}`}>Open Zeffy</a>
      ${c.looked ? html`<${LetterDone} c=${c} act=${act} busy=${busy} />` : ''}
      ${c.state === 'linked' ? html`<${Unlink} c=${c} act=${act} busy=${busy} />` : ''}
    </div>
  </div>`;
}

function Status({ v }) {
  const test = v.writeTest;
  const stopped = (Number(test?.tries) || 1) >= 3;
  return html`
    ${v.lastError ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The last run didn’t finish.</strong> It tries again on its own in a few minutes.</div></div>` : ''}
    ${!test ? html`<div class="notice" role="status"><div class="notice__body"><strong>The site is testing that it can save to Zeffy.</strong> Sending opens once that test passes, in a few minutes.</div></div>` : ''}
    ${test && !test.ok && !test.leftBehind?.length ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>Checks can’t be sent to Zeffy right now.</strong> Zeffy wouldn’t take the site’s $1 test record. ${stopped ? 'It tried on 3 days and has stopped, so something in Zeffy needs a look. Tell Peter.' : 'It tries again tomorrow.'} Until then, enter checks in Zeffy by hand: each one links itself within the hour.</div></div>` : ''}
    ${test?.ok && test.address && !test.address.ok ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>Addresses aren’t going on donors in Zeffy yet.</strong> Zeffy didn’t keep the test address, so a check’s address shows here but isn’t added. Checks still send. Tell Peter.</div></div>` : ''}
    ${v.money?.loose?.length ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The weekly money check found ${(v.money.count ?? v.money.loose.length) === 1 ? 'a check gift' : `${v.money.count ?? v.money.loose.length} check gifts`} in Zeffy with no check in Mercury.</strong> ${v.money.loose.slice(0, 10).map((x) => `${x.name || 'No name'}, ${usd(x.cents)}, ${fromUnix(x.at)}`).join('; ')}${(v.money.count ?? v.money.loose.length) > 10 ? `; and ${(v.money.count ?? v.money.loose.length) - 10} more` : ''}. One may be a check entered twice: if it’s a second record for a check already in Zeffy, delete that extra record. If it’s one of several gifts a single check paid, or a check deposited at another bank, nothing to do. This updates each Monday.</div>
      <div class="notice__actions"><a class="btn btn-ghost" href=${ZEFFY_URL} target="_blank" rel="noopener">Open Zeffy</a></div></div>` : ''}
    ${v.matchFailing ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The hourly look at Zeffy isn’t working.</strong> Since ${fmtDay(v.matchFailing.since)}, ${v.matchFailing.error}. Cards aren’t kept up to date until it works, and Send reads Zeffy again first anyway.</div></div>` : ''}
    ${test?.leftBehind?.length ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>Zeffy wouldn’t let the site remove its test ${test.leftBehind.length === 1 ? 'record' : 'records'}.</strong> ${test.leftBehind.length === 1 ? 'Delete the $1 SOARD WebsiteTest entry in Zeffy. It isn’t a gift, and this goes away on its own once it’s gone.' : 'Delete the $1 SOARD WebsiteTest entries in Zeffy. They aren’t gifts, and this goes away on its own once they’re gone.'}</div>
      <div class="notice__actions"><a class="btn btn-ghost" href=${ZEFFY_URL} target="_blank" rel="noopener">Open Zeffy</a></div></div>` : ''}`;
}

export function Checks({ addToast = () => {}, onCount = () => {} }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const busyRef = useRef(null);
  busyRef.current = busy;
  const [forms, setForms] = useState(null);
  const needed = useRef(false);
  // Each look and each action counts: a look that started before an action answered is older than it, and is dropped
  const gen = useRef(0);

  const take = (j) => {
    // A check decided (sent, matched, left out) lets go of what was typed on its card; one still being sent keeps it
    for (const c of j.list || []) if (['created', 'linked', 'left-out', 'store', 'came-back'].includes(c.state)) drafts.delete(c.id);
    setV(j);
    onCount(j.waiting || 0);
  };
  const load = async () => {
    const mine = ++gen.current;
    const j = await call();
    if (mine !== gen.current) return;
    if (!j.success) { setErr(j.error || 'Could not load the checks'); return; }
    setErr(null);
    take(j);
  };
  const needsForms = (view) => (view?.list || []).some((c) => c.card);
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
  // A form opened or closed in Zeffy shows here within a minute while a card is open
  const formsGone = () => loadForms(true);
  useEffect(() => { load(); }, []);
  // A send still being answered (maybe from before this tab was opened) is looked at again in five seconds
  const answering = (v?.list || []).some((c) => ['creating', 'unsure', 'read', 'new'].includes(c.state));
  useEffect(() => { if (!answering) return undefined; const t = setTimeout(() => { if (!document.hidden) load(); }, 5000); return () => clearTimeout(t); }, [answering, v]);
  // Looks again when the tab comes back and every 15 seconds while it's open (the tab's count keeps the same pace); a card being
  // filled in keeps its own words (drafts)
  useEffect(() => {
    const look = () => {
      // Not while something's being sent: the list then would show it mid-way ("Checking Zeffy"), and the answer reads it
      if (document.hidden || busyRef.current) return;
      load();
      // The form list stays wanted until it comes, so one failed read doesn't leave every card waiting; once here, it's read again each minute
      if (needed.current || (formsWanted.current && Date.now() - formsAt.current > 55000)) loadForms(true);
    };
    const t = setInterval(look, 15000);
    document.addEventListener('visibilitychange', look);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', look); };
  }, []);
  const needForms = needsForms(v) && !forms;
  needed.current = needForms;
  const formsWanted = useRef(false);
  formsWanted.current = needsForms(v);
  useEffect(() => { if (needForms) loadForms(); }, [needForms]);

  // The focus stays by what was done: the check if it's still here, else the top of its list
  const wasNeed = useRef(false);
  const keepFocus = (id) => requestAnimationFrame(() => {
    const here = id && document.querySelector(`.ck [data-check="${CSS.escape(id)}"]`);
    const inNeed = !!here?.classList.contains('ck-need');
    const moved = here && !inNeed && wasNeed.current;
    if (here && inNeed && !wasNeed.current) { here.focus(); here.scrollIntoView({ block: 'center' }); return; }
    // Still on its card (a send Zeffy turned away): back on its Send, ready to press again once it's put right
    const still = moved ? null : here && (here.querySelector('button[type=submit]:not([disabled])') || here);
    (still || document.querySelector('.ck h3'))?.focus?.({ preventScroll: true });
  });
  const act = async (body, done) => {
    const at = body.id && document.querySelector(`.ck [data-check="${CSS.escape(body.id)}"]`);
    wasNeed.current = !!at?.classList.contains('ck-need');
    setBusy(`${body.action}:${body.id || ''}`);
    gen.current++;
    const j = await call('', body);
    setBusy(null);
    if (!j.success) {
      // The version the refusal left: the card it comes back to is the person's own doing, not the site changing it
      if (body.id && j.ver) { const d = drafts.get(body.id); if (d) d.__adoptVer = j.ver; }
      // Zeffy turned up an entry: the card asks about it by name before sending another
      if (!j.entries?.length) addToast(j.error, 'error');
      await load();
      keepFocus(body.id);
      if (j.entries?.length) return { double: j.entries, ver: j.ver || null };
      // A form that closed since: the list of forms is read again
      if (/form isn’t open|open donation form/.test(j.error || '')) return { formGone: true };
      return null;
    }
    gen.current++;
    setErr(null);
    if (body.id && body.action !== 'send') drafts.delete(body.id);
    take(j);
    const said = typeof done === 'function' ? done(j) : done;
    if (said) addToast(j.result?.result === 'linked' && body.action === 'send' ? 'Zeffy already had it, so it’s matched' : said, 'success');
    keepFocus(body.id);
    return j;
  };
  const [retrying, setRetrying] = useState(false);
  const retry = async () => { setRetrying(true); await load(); setRetrying(false); };

  if (err && !v) {
    return html`<div class="notice notice--warn"><div class="notice__body"><strong>The checks didn’t load.</strong> ${err}</div><div class="notice__actions"><button class="btn btn-ghost" disabled=${retrying} onClick=${retry}>${retrying ? 'Trying…' : 'Try again'}</button></div></div>`;
  }
  if (!v) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;

  // One rule, from the server, for what waits on a person: the same one the tab's count uses
  const cards = v.list.filter((c) => c.needsYou && c.card && !c.toDo);
  const todos = v.list.filter((c) => c.needsYou && !(c.card && !c.toDo));
  const rest = v.list.filter((c) => !c.needsYou);
  const need = cards.length + todos.length;
  return html`<div class="ck">
    ${err ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>This list may be out of date.</strong> The site couldn’t be reached just now, and it keeps trying.</div><div class="notice__actions"><button class="btn btn-ghost" disabled=${retrying} onClick=${retry}>${retrying ? 'Trying…' : 'Try again'}</button></div></div>` : ''}
    <${Status} v=${v} />
    <section class="card ck-card">
      <div class="sec-head"><h3 tabindex="-1">To send to Zeffy ${need ? html`<span class="count is-warn">${need}</span>` : ''}</h3>
        <span class="sec-head__hint">The site fills in each check deposited in Mercury. Look it over, then send it. Receipts and emails stay off.</span></div>
      ${cards.map((c) => html`<${ApproveCard} key=${c.id} c=${c} act=${act} busy=${busy} forms=${forms} formsGone=${formsGone} formsFailed=${formsFailed} dontReasons=${v.dontReasons} sending=${v.sending} joinOk=${v.joinOk} />`)}
      ${todos.map((c) => html`<${ToDo} key=${c.id} c=${c} act=${act} busy=${busy} />`)}
      ${!need ? html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">Nothing waiting. A check shows up here a few minutes after it’s deposited in Mercury.</p></div>` : ''}
    </section>
    <section class="card ck-card">
      <div class="sec-head"><h3 tabindex="-1">Checks <span class="count">${rest.length}</span></h3><span class="sec-head__hint">${v.limited ? `Deposited in Mercury, newest first. With the ones to send, these are ${v.shown} of ${v.all}; older ones are in Mercury.` : 'Deposited in Mercury, newest first'}</span></div>
      ${rest.length ? rest.map((c) => html`<${CheckRow} key=${c.id} c=${c} act=${act} busy=${busy} />`)
        : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">${need ? 'Nothing else yet.' : 'No checks yet. Each one shows up here on its own once it’s deposited in Mercury.'}</p></div>`}
    </section>
  </div>`;
}
