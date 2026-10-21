/**
 * Admin → Applications → Settings: the waitlist panel
 * ===========================================================================
 * Families who asked to hear when applications open, and the one email they
 * get when the switch goes on (functions/api/_application-waitlist.js, over
 * /api/application-waitlist-admin). Nothing here has to be pressed: the email
 * goes on its own COUNTDOWN minutes after applications are saved as open.
 * The buttons are overrides: Send now, Don't send this time, Try again.
 *
 * Also here: what the email says in English and Spanish (preview, optional
 * rewording, a test to yourself), every family on the list (search, add one
 * who called, take one off, CSV), and past openings with Kit's numbers.
 *
 * Mounted by SettingsTab in ./applications.js (the side column, under "What
 * families see"), inside .afe-root, so it uses that module's afe-* styles and
 * tokens plus the wl-* rules below. WaitlistOpenNote is the line the "Open
 * applications?" dialog shows about who gets emailed.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';

const html = htm.bind(h);
const API = '/api/application-waitlist-admin';
const LANG_NAMES = { en: 'English', es: 'Spanish' };

async function call(body) {
  let r;
  try {
    r = await fetch(API + (body ? '' : '?list=1'), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

const families = (n) => `${n} ${n === 1 ? 'family' : 'families'}`;
/** peter@soardcharity.com → Peter, jen.alvarez@… → Jen Alvarez */
const who = (by) => (!by || by === 'automatic' ? null : /@/.test(by) ? by.split('@')[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : by);

// The last status any panel loaded, for the Open dialog's line (no second fetch)
let lastStatus = null;
const listeners = new Set();
function share(status) {
  lastStatus = status;
  listeners.forEach(fn => fn(status));
}
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const dayTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const dayOnly = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x <= 1 ? x * 100 : x)}%` : null);
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const CSS = `
.wl.card { padding: 0; overflow: hidden; }
.wl-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: .75rem 1rem; padding: 1rem 1.1rem .85rem; }
.wl-title { margin: 0 0 .2rem; }
.wl-count { display: flex; align-items: baseline; flex-wrap: wrap; gap: .25rem .6rem; margin: .1rem 0 0; }
.wl-count strong { font-size: 1.6rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
.wl-count span { color: var(--color-text-secondary); font-size: .88rem; }
.wl-state { margin: 0 1.1rem 1rem; padding: .85rem 1rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); }
.wl-state.is-live { border-color: color-mix(in srgb, var(--color-warning) 50%, var(--color-border)); background: color-mix(in srgb, var(--color-warning) 9%, var(--color-bg-card)); }
.wl-state.is-done { border-color: color-mix(in srgb, var(--color-success) 40%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 7%, var(--color-bg-card)); }
.wl-state.is-warn { border-color: var(--afe-warn-line); background: var(--afe-warn-bg); }
.wl-state-line { margin: 0; font-weight: 600; line-height: 1.45; }
.wl-state-sub { margin: .25rem 0 0; font-size: .85rem; line-height: 1.5; color: var(--color-text-secondary); }
.wl-timer { font-variant-numeric: tabular-nums; }
.wl-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
.wl-actions .btn { min-height: 40px; }
.wl-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .5rem; margin-top: .75rem; }
.wl-stat { padding: .55rem .7rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-card); }
.wl-stat b { display: block; font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.wl-stat span { font-size: .78rem; color: var(--color-text-secondary); }
.wl-health { display: grid; gap: .5rem; margin: 0 1.1rem 1rem; }
.wl-fix { margin-top: .35rem; font-size: .82rem; color: var(--color-text-secondary); }
.wl-fix summary { cursor: pointer; font-weight: 600; color: var(--color-text); }
.wl-conn { margin: 0; line-height: 1.6; }
.wl-sec { border-top: 1px solid var(--color-border); }
.wl-sec > summary { display: flex; align-items: center; justify-content: space-between; gap: .75rem; min-height: 48px; margin: 0; padding: .6rem 1.1rem; cursor: pointer; list-style: none; font-weight: 600; }
.wl-sec > summary::-webkit-details-marker { display: none; }
.wl-sec > summary::after { content: ''; width: 8px; height: 8px; border-right: 2px solid var(--color-text-secondary); border-bottom: 2px solid var(--color-text-secondary); transform: rotate(45deg); transition: transform .15s; margin-right: .2rem; }
.wl-sec[open] > summary::after { transform: rotate(-135deg); }
.wl-sec > summary .afe-hint { font-weight: 400; margin-left: auto; }
.wl-body { padding: 0 1.1rem 1.1rem; }
.wl-frame { position: relative; overflow: hidden; border: 1px solid var(--color-border); border-radius: 10px; background: #F5F4F0; }
.wl-frame iframe { position: absolute; top: 0; left: 0; width: 600px; height: 820px; border: 0; transform-origin: 0 0; }
.wl-field { display: grid; gap: .3rem; margin-bottom: .8rem; }
.wl-field label { font-size: .85rem; font-weight: 600; }
.wl-field textarea { min-height: 11rem; line-height: 1.55; resize: vertical; }
.wl-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.wl-row .form-input { flex: 1 1 14rem; min-width: 0; }
.wl-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
.wl-table th { text-align: left; font-size: .75rem; font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: .04em; padding: .4rem .5rem; border-bottom: 1px solid var(--color-border); }
.wl-table td { padding: .5rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.wl-table td.wl-email { word-break: break-all; }
.wl-table-wrap { max-height: 28rem; overflow: auto; border: 1px solid var(--color-border); border-radius: 10px; }
.wl-pill { display: inline-block; padding: .05rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; background: var(--afe-track); color: var(--color-text-secondary); white-space: nowrap; }
.wl-pill.is-ok { background: color-mix(in srgb, var(--color-success) 13%, transparent); color: color-mix(in srgb, var(--color-success) 85%, var(--color-text)); }
.wl-pill.is-warn { background: var(--afe-warn-bg); color: var(--color-text); }
.wl-remove { padding: .2rem .5rem; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--color-text-secondary); font: inherit; font-size: .8rem; cursor: pointer; min-height: 32px; }
.wl-remove:hover { border-color: var(--color-border); color: var(--color-danger); }
.wl-history { display: grid; gap: .5rem; margin: 0; padding: 0; list-style: none; }
.wl-history li { padding: .6rem .75rem; border: 1px solid var(--color-border); border-radius: 8px; font-size: .85rem; line-height: 1.5; }
@media (max-width: 640px) {
  .wl-head, .wl-sec > summary, .wl-body { padding-left: .85rem; padding-right: .85rem; }
  .wl-state, .wl-health { margin-left: .85rem; margin-right: .85rem; }
  .wl-actions .btn, .wl-row .btn { flex: 1 1 auto; min-height: 44px; }
  .wl-table th:nth-child(2), .wl-table td:nth-child(2) { display: none; }
  .wl-sec > summary .afe-hint { display: none; }
}
`;
let styled = false;
function useWlStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'waitlist';
  el.textContent = CSS;
  document.head.append(el);
}

/** The panel. `savedOpen` is the saved switch: a change reloads the panel at once. */
export function WaitlistPanel({ addToast = () => {}, savedOpen = false }) {
  useWlStyles();
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [now, setNow] = useState(Date.now());
  const loadedAt = useRef(Date.now());

  const load = async () => {
    const j = await call();
    if (!j.success) { setErr(j.error || 'Could not load the waitlist'); return; }
    setErr(null);
    loadedAt.current = Date.now();
    setSt(j.status);
    share(j.status);
  };
  useEffect(() => { load(); }, [savedOpen]);
  // While something is happening, check often; otherwise now and then
  const phase = st?.opening?.state;
  useEffect(() => {
    const quick = ['countdown', 'preparing', 'sending'].includes(phase) || (savedOpen && !st?.opening && st?.waiting > 0);
    const t = setInterval(() => { if (!document.hidden) load(); }, quick ? 5000 : 60000);
    return () => clearInterval(t);
  }, [phase, savedOpen, st?.waiting]);
  useEffect(() => {
    if (phase !== 'countdown') return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const act = async (action, extra = {}, done = null) => {
    setBusy(action);
    const j = await call({ action, ...extra });
    setBusy(null);
    if (!j.success) { addToast(j.error || 'That did not work', 'error'); return null; }
    if (j.status) { loadedAt.current = Date.now(); setSt(j.status); share(j.status); }
    if (done) addToast(typeof done === 'function' ? done(j) : done, 'success');
    return j;
  };

  if (err && !st) {
    return html`<section class="card wl"><div class="wl-head"><div>
      <h4 class="wl-title">Waitlist</h4>
      <p class="afe-bad" style="margin: .25rem 0 .6rem;">Couldn't load the waitlist: ${err}</p>
      <button class="btn btn-ghost" onClick=${load}>Try again</button>
    </div></div></section>`;
  }
  if (!st) return html`<section class="card wl" aria-busy="true"><div class="wl-head"><h4 class="wl-title">Waitlist</h4><span class="afe-hint">Loading…</span></div></section>`;

  const op = st.opening;
  const secondsLeft = op?.state === 'countdown' && op.secondsLeft != null
    ? Math.max(0, op.secondsLeft - Math.round((now - loadedAt.current) / 1000)) : null;
  const byLang = st.waitingByLang || {};
  const langSplit = Object.entries(byLang).filter(([, n]) => n > 0).map(([l, n]) => `${n} ${LANG_NAMES[l]}`).join(' · ');

  return html`
    <section class="card wl" aria-labelledby="wl-title">
      <div class="wl-head">
        <div>
          <h4 class="wl-title" id="wl-title">Waitlist</h4>
          <p class="wl-count"><strong>${st.waiting}</strong><span>${st.waiting === 1 ? 'family is' : 'families are'} waiting${langSplit ? ` (${langSplit})` : ''} · last signup ${ago(st.lastSignupAt)}</span></p>
        </div>
      </div>

      <${StateCard} st=${st} op=${op} secondsLeft=${secondsLeft} savedOpen=${savedOpen} busy=${busy} act=${act} />
      <${Health} st=${st} busy=${busy} act=${act} />

      <details class="wl-sec">
        <summary>The email <span class="afe-hint">English and Spanish, what families see</span></summary>
        <div class="wl-body"><${EmailEditor} st=${st} act=${act} busy=${busy} addToast=${addToast} /></div>
      </details>
      <details class="wl-sec">
        <summary>Everyone on the list <span class="afe-hint">${families(st.everyone)}</span></summary>
        <div class="wl-body"><${FamilyList} st=${st} act=${act} busy=${busy} /></div>
      </details>
      ${st.history?.length > 0 && html`
        <details class="wl-sec">
          <summary>Past openings <span class="afe-hint">${st.history.length}</span></summary>
          <div class="wl-body"><${History} list=${st.history} /></div>
        </details>`}
    </section>`;
}

/** What's happening with the email right now, in one sentence, with the overrides that fit */
function StateCard({ st, op, secondsLeft, savedOpen, busy, act }) {
  const mins = st.countdownMinutes || 10;
  const sendNow = html`<button class="btn btn-primary" disabled=${!!busy} onClick=${() => act('send-now', {}, 'Sending the email now')}>${busy === 'send-now' ? 'Sending…' : 'Send now'}</button>`;
  const card = (cls, line, sub, actions = null) => html`
    <div class="wl-state ${cls}" role="status" aria-live="polite">
      <p class="wl-state-line">${line}</p>
      ${sub && html`<p class="wl-state-sub">${sub}</p>`}
      ${actions && html`<div class="wl-actions">${actions}</div>`}
    </div>`;

  if (op?.state === 'countdown') {
    const timer = secondsLeft != null && html` <span class="wl-timer">(${mmss(secondsLeft)})</span>`;
    if (op.stopping) {
      return card('is-warn', 'Taking the email back out of Kit…', `${op.error || 'Kit hasn\'t answered yet'}. If it can't be reached before ${clock(op.sendAt)}, delete it in Kit: ${Object.values(op.kitBroadcastUrls || {}).join(' ')}`);
    }
    const actions = html`${sendNow}<button class="btn btn-ghost" disabled=${!!busy} onClick=${() => act('hold', {}, 'The email is on hold')}>${busy === 'hold' ? 'Stopping…' : "Don't send this time"}</button>`;
    if (op.staged) {
      return card('is-live',
        html`Kit has the email: it goes to ${families(op.total)} at ${clock(op.sendAt)}${timer}.`,
        `Kit sends it on its own at that time. Opened by mistake? Close applications before then, or press "Don't send this time", and it's taken back out of Kit.`,
        actions);
    }
    return card(op.error ? 'is-warn' : 'is-live',
      html`The email goes to ${families(op.total)} at ${clock(op.sendAt)}${timer}.`,
      op.error ? `It isn't ready in Kit yet: ${op.error}. The site keeps trying.` : 'Getting it ready in Kit…',
      actions);
  }
  if (op?.state === 'held') {
    return card('', `On hold: ${who(op.by) || 'someone'} chose not to send it this time.`, `The ${families(op.total)} waiting stay on the list. Send it whenever you're ready.`, savedOpen ? sendNow : null);
  }
  if (op?.state === 'preparing') {
    return card(op.error ? 'is-warn' : 'is-live',
      op.error ? 'The email is waiting on something' : `Getting the email ready for ${families(op.total)}…`,
      op.error ? `${op.error}. It keeps trying on its own${op.retryAt ? ` (next try ${clock(op.retryAt)})` : ''}; if Kit still can't send it two hours in, the site emails each family itself.` : 'Checking the form is open and putting each family on this email in Kit. This takes a minute.',
      op.error ? html`<button class="btn btn-ghost" disabled=${!!busy} onClick=${() => act('retry', {}, 'Trying again')}>${busy === 'retry' ? 'Trying…' : 'Try again now'}</button>` : null);
  }
  if (op && (op.state === 'sending' || op.state === 'sent')) {
    const langs = Object.entries(op.broadcasts || {});
    const recipients = langs.reduce((n, [, b]) => n + (b.stats?.recipients ?? b.recipients ?? 0), 0) + (op.direct?.sent || 0);
    const opened = langs.reduce((n, [, b]) => n + (b.stats?.opened || 0), 0);
    const clicks = langs.reduce((n, [, b]) => n + (b.stats?.clicks || 0), 0);
    const kitDone = langs.every(([, b]) => b.stats?.status === 'completed');
    return html`
      <div class="wl-state ${op.state === 'sent' ? 'is-done' : 'is-live'}" role="status" aria-live="polite">
        <p class="wl-state-line">${!op.total
          ? 'Applications opened with nobody waiting, so no email was needed.'
          : op.state === 'sent'
            ? (recipients ? `Sent ${dayTime(op.sentAt)} to ${families(recipients)}.` : 'Nobody could be emailed.')
            : `Going out now to ${families(recipients || op.total)}.`}</p>
        ${op.note && html`<p class="wl-state-sub">${op.note}</p>`}
        ${op.direct?.failed > 0 && html`<p class="wl-state-sub">${families(op.direct.failed)} couldn't be emailed yet (${op.direct.error || 'unknown error'}). The site keeps trying for a day.</p>`}
        ${op.total > 0 && html`
          <div class="wl-stats">
            ${langs.map(([l, b]) => html`<div class="wl-stat"><b>${b.stats?.recipients ?? b.recipients ?? 0}</b><span>${LANG_NAMES[l]} through Kit${b.stats?.status && !kitDone ? ` · ${b.stats.status}` : ''}</span></div>`)}
            ${op.direct?.sent > 0 && html`<div class="wl-stat"><b>${op.direct.sent}</b><span>emailed by the site</span></div>`}
            ${langs.some(([, b]) => b.stats) && html`
              <div class="wl-stat"><b>${opened}</b><span>opened${recipients ? ` · ${pct(opened / recipients)}` : ''}</span></div>
              <div class="wl-stat"><b>${clicks}</b><span>clicked the link</span></div>`}
          </div>
          ${Object.keys(op.kitBroadcastUrls || {}).length > 0 && html`
            <p class="wl-state-sub" style="margin-top: .6rem;">${Object.entries(op.kitBroadcastUrls).map(([l, u], i) => html`${i ? ' · ' : ''}<a href=${u} target="_blank" rel="noopener" style="color: inherit;">${LANG_NAMES[l]} email in Kit</a>`)}</p>`}`}
        ${st.waiting > 0 && savedOpen && html`<p class="wl-state-sub">${families(st.waiting)} joined since. The site emails each of them the link right away.</p>`}
      </div>`;
  }
  if (op?.state === 'cancelled') {
    return card('', `Not sent: ${String(op.note || 'applications were switched off first.').replace(/^./, c => c.toLowerCase())}`, st.waiting ? `${families(st.waiting)} are still waiting for the next opening.` : null);
  }
  if (savedOpen) {
    return card('is-done', 'Applications are open. Anyone who signs up now gets the link right away.', null);
  }
  return card('',
    st.waiting ? `When applications open, these ${families(st.waiting)} get one email ${mins} minutes later (right away for a scheduled opening). Nothing to press.` : 'When families sign up on the Apply page, they show up here.',
    'Families leave their email on the Apply page and on the closed application form, in English or Spanish. Each gets a "you\'re on the list" email now and one email the moment applications open.');
}

/** Kit and the site's email sender, checked live; anything that needs a person */
function Health({ st, busy, act }) {
  const notes = [];
  const k = st.kitHealth;
  if (st.kit && k) {
    notes.push(k.ok
      ? html`<p class="afe-hint wl-conn"><span class="wl-pill is-ok">Kit connected</span> ${k.name || 'Kit'}${k.from ? html` · sends from ${k.from.email}` : ''}${k.tagCount != null ? html` · ${k.tagCount} on the "Application Waitlist" tag` : ''} · checked ${ago(k.at)}</p>`
      : html`<div class="afe-note is-warn"><span><strong>Kit isn't working:</strong> ${k.error}. Signups are still saved here. Fix it before applications open so the email goes through Kit; if it isn't fixed, the site emails each family itself two hours after opening.</span></div>`);
  }
  const rl = st.resendLast;
  if (st.email && rl) {
    notes.push(rl.ok
      ? html`<p class="afe-hint wl-conn"><span class="wl-pill is-ok">Emails sending</span> Last "you're on the list" email went ${ago(rl.at)}.</p>`
      : html`<div class="afe-note is-warn"><span><strong>The last "you're on the list" email didn't send</strong> (${rl.error || 'unknown error'}, ${ago(rl.at)}).</span></div>`);
  }
  if (!st.kit) notes.push(html`<div class="afe-note is-warn"><span><strong>Kit isn't connected,</strong> so the opening email can't go through Kit. Signups are still saved here, and if Kit is still missing two hours after applications open, the site emails each family itself.
    <details class="wl-fix"><summary>How to fix</summary>Add the Kit API key in Cloudflare (soard-site → Settings → Variables) as KIT_API_KEY.</details></span></div>`);
  if (!st.email) notes.push(html`<div class="afe-note is-warn"><span><strong>The site's email sender (Resend) isn't set up,</strong> so families don't get the "you're on the list" email, and there's no backup if Kit can't send.
    <details class="wl-fix"><summary>How to fix</summary>Add the Resend API key in Cloudflare (soard-site → Settings → Variables) as RESEND_API_KEY.</details></span></div>`);
  if (st.kitProblems > 0) {
    notes.push(html`<div class="afe-note is-warn"><span style="flex: 1;">${families(st.kitProblems)} on the list aren't in Kit yet. They're saved here and the site keeps retrying; they get the opening email either way.</span>
      <button class="btn btn-ghost" style="min-height: 36px;" disabled=${!!busy} onClick=${() => act('retry-signups', {}, 'Retried')}>${busy === 'retry-signups' ? 'Retrying…' : 'Retry now'}</button></div>`);
  }
  return notes.length ? html`<div class="wl-health">${notes}</div>` : null;
}

function EmailEditor({ st, act, busy, addToast }) {
  const [lang, setLang] = useState('en');
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(st.wording || {})));
  const [preview, setPreview] = useState(null);
  const [to, setTo] = useState('');
  const saved = st.wording || {};
  const d = draft[lang] || { subject: '', body: '' };
  const def = st.defaults?.[lang] || { subject: '', body: '' };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (k, v) => setDraft(x => ({ ...x, [lang]: { ...(x[lang] || {}), [k]: v } }));

  // The preview follows what's typed (a beat after typing stops)
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const j = await call({ action: 'preview', lang, wording: draft });
      if (live && j.success) setPreview(j);
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [lang, JSON.stringify(draft)]);

  return html`
    <div>
      <div>
        <div class="afe-seg afe-seg-text" role="group" aria-label="Language" style="margin-bottom: .85rem;">
          ${['en', 'es'].map(l => html`<button aria-pressed=${lang === l} onClick=${() => setLang(l)}>${LANG_NAMES[l]}</button>`)}
        </div>
        <p class="afe-hint" style="margin: 0 0 .85rem;">Families get the ${LANG_NAMES[lang]} email if they signed up in ${LANG_NAMES[lang]}. Leave a box blank to use the wording shown in it. {year} becomes the season (${st.year}).</p>
        <div class="wl-field">
          <label for="wl-subject">Subject</label>
          <input id="wl-subject" class="form-input" maxlength="200" value=${d.subject} placeholder=${def.subject} onInput=${(e) => set('subject', e.target.value)} />
        </div>
        <div class="wl-field">
          <label for="wl-body">Message</label>
          <textarea id="wl-body" class="form-input" maxlength="4000" value=${d.body} placeholder=${def.body} onInput=${(e) => set('body', e.target.value)}></textarea>
          <span class="afe-hint">A blank line starts a new paragraph. The button to the application and the unsubscribe link are added for you.</span>
        </div>
        <div class="wl-row" style="margin-bottom: 1rem;">
          <button class="btn btn-primary" disabled=${!dirty || !!busy} onClick=${() => act('wording', { wording: draft }, 'Wording saved')}>${busy === 'wording' ? 'Saving…' : 'Save wording'}</button>
          ${(d.subject || d.body) && html`<button class="btn btn-ghost" disabled=${!!busy} onClick=${() => setDraft(x => ({ ...x, [lang]: { subject: '', body: '' } }))}>Use the built-in ${LANG_NAMES[lang]} wording</button>`}
          ${dirty && html`<span class="afe-hint">Unsaved</span>`}
        </div>
        <div class="wl-field">
          <label for="wl-test">Try it on yourself</label>
          <div class="wl-row">
            <input id="wl-test" class="form-input" type="email" placeholder="Blank sends it to you" value=${to} onInput=${(e) => setTo(e.target.value)} />
          </div>
          <div class="wl-row">
            <button class="btn btn-primary" disabled=${!!busy || !st.kit} title=${st.kit ? '' : 'Kit isn\'t connected'} onClick=${() => act('rehearse', { lang, to: to.trim() || undefined, wording: draft }, (j) => `Kit sends the rehearsal to ${j.to} in about a minute`)}>${busy === 'rehearse' ? 'Handing it to Kit…' : 'Rehearse through Kit'}</button>
            <button class="btn btn-ghost" disabled=${!!busy} onClick=${() => act('test', { lang, to: to.trim() || undefined, wording: draft }, (j) => `Test sent to ${j.to}`)}>${busy === 'test' ? 'Sending…' : 'Quick preview email'}</button>
          </div>
          <span class="afe-hint">The rehearsal is the real thing: Kit sends you the ${LANG_NAMES[lang]} email exactly as families will get it, from Kit's sender. Do one before opening day. The quick preview comes from the site instead.</span>
        </div>
      </div>
      <div>
        <p class="afe-hint" style="margin: 0 0 .4rem;"><strong>Subject:</strong> ${preview?.subject || '…'}</p>
        <${ScaledPreview} title=${`${LANG_NAMES[lang]} email preview`} html=${preview?.html || ''} />
      </div>
    </div>`;
}

/** The email at its real 600px width, shrunk to fit the column */
function ScaledPreview({ title, html: doc }) {
  const box = useRef(null);
  const [k, setK] = useState(0.6);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const fit = () => setK(Math.min(1, el.clientWidth / 600));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return html`
    <div class="wl-frame" ref=${box} style=${`height: ${Math.round(820 * k)}px;`}>
      <iframe title=${title} sandbox="" srcdoc=${doc} style=${`transform: scale(${k});`}></iframe>
    </div>`;
}

function FamilyList({ st, act, busy }) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState('waiting');
  const [email, setEmail] = useState('');
  const [lang, setLang] = useState('en');
  const [confirm, setConfirm] = useState(true);
  const rows = st.signups || [];
  const shown = useMemo(() => rows.filter(r => (show === 'all' || (show === 'waiting' ? !r.openingId : !!r.openingId)) && (!q || r.email.includes(q.trim().toLowerCase()))), [rows, q, show]);
  const kitPill = (r) => {
    if (r.kit === 'active') return html`<span class="wl-pill is-ok">In Kit</span>`;
    if (r.kit === 'pending') return html`<span class="wl-pill">Adding</span>`;
    if (r.kit === 'error') return html`<span class="wl-pill is-warn" title=${r.kitError || ''}>Retrying</span>`;
    if (r.kit === 'inactive') return html`<span class="wl-pill is-warn" title="Kit hasn't confirmed this address, so the site emails them itself">Unconfirmed</span>`;
    return html`<span class="wl-pill is-warn" title="They unsubscribed in Kit">${r.kit === 'cancelled' ? 'Unsubscribed' : r.kit}</span>`;
  };
  const csv = () => {
    const lines = [['email', 'language', 'signed_up', 'where', 'kit', 'emailed_at', 'emailed_via']]
      .concat(shown.map(r => [r.email, r.lang, r.createdAt, r.page || '', r.kit, r.notifiedAt || '', r.notifiedVia || '']));
    const blob = new Blob([lines.map(l => l.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `application-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const add = async () => {
    const j = await act('add', { email: email.trim(), lang, confirm }, (r) => (r.status === 'already' ? 'Already on the list' : r.status === 'open' ? 'Applications are open, so they were emailed the link' : 'Added to the waitlist'));
    if (j) setEmail('');
  };
  const where = { apply: 'Apply page', 'apply-form': 'Application page', admin: 'Added by staff', kit: 'From Kit' };

  return html`
    <div class="wl-field">
      <label for="wl-add">Add a family who asked by phone or in person</label>
      <div class="wl-row">
        <input id="wl-add" class="form-input" type="email" placeholder="their@email.com" value=${email} onInput=${(e) => setEmail(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && email.trim()) add(); }} />
        <select class="form-input" style="flex: 0 0 auto; width: auto;" aria-label="Language" value=${lang} onChange=${(e) => setLang(e.target.value)}>
          <option value="en">English</option><option value="es">Spanish</option>
        </select>
        <button class="btn btn-primary" disabled=${!email.trim() || !!busy} onClick=${add}>${busy === 'add' ? 'Adding…' : 'Add'}</button>
      </div>
      <label class="afe-hint" style="display: flex; gap: .4rem; align-items: center; font-weight: 400;"><input type="checkbox" checked=${confirm} onChange=${(e) => setConfirm(e.target.checked)} /> Send them the "you're on the list" email</label>
    </div>
    <div class="wl-row" style="margin-bottom: .6rem;">
      <input class="form-input" type="search" placeholder="Search emails" aria-label="Search emails" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="afe-seg afe-seg-text" role="group" aria-label="Show">
        ${[['waiting', 'Waiting'], ['told', 'Emailed'], ['all', 'All']].map(([k, label]) => html`<button aria-pressed=${show === k} onClick=${() => setShow(k)}>${label}</button>`)}
      </div>
      <button class="btn btn-ghost" disabled=${!shown.length} onClick=${csv}>Download CSV</button>
    </div>
    ${shown.length ? html`
      <div class="wl-table-wrap">
        <table class="wl-table">
          <thead><tr><th>Email</th><th>Signed up</th><th>Status</th><th><span class="afe-sr">Remove</span></th></tr></thead>
          <tbody>
            ${shown.slice(0, 500).map(r => html`
              <tr key=${r.email}>
                <td class="wl-email">${r.email}${r.lang === 'es' ? html` <span class="wl-pill">Spanish</span>` : ''}</td>
                <td title=${where[r.page] || ''}>${dayOnly(r.createdAt)}</td>
                <td>${r.openingId
                  ? (Date.parse(r.notifiedAt) > Date.now()
                    ? html`<span class="wl-pill" title=${r.notifiedVia === 'email' ? 'The site sends it' : 'Kit sends it'}>Scheduled ${clock(r.notifiedAt)}</span>`
                    : html`<span class="wl-pill is-ok" title=${r.notifiedVia === 'email' ? 'Emailed by the site' : 'Emailed through Kit'}>Emailed ${dayOnly(r.notifiedAt)}</span>`)
                  : kitPill(r)}</td>
                <td style="text-align: right;"><button class="wl-remove" disabled=${!!busy} onClick=${() => { if (window.confirm(`Take ${r.email} off the waitlist? They won't get the opening email.`)) act('remove', { email: r.email }, 'Taken off the list'); }}>Remove</button></td>
              </tr>`)}
          </tbody>
        </table>
      </div>
      ${shown.length > 500 && html`<p class="afe-hint" style="margin: .5rem 0 0;">Showing the first 500. Download the CSV for everyone.</p>`}`
    : html`<p class="afe-hint" style="margin: .25rem 0 0;">${rows.length ? 'Nobody matches.' : 'Nobody has signed up yet.'}</p>`}
    <p class="afe-hint" style="margin: .75rem 0 0;">Last read in from Kit's "Application Waitlist" tag: ${ago(st.lastImportAt)}. <button class="afe-link" disabled=${!!busy} onClick=${() => act('import', {}, (j) => (j.added ? `Read in ${families(j.added)} from Kit` : 'Up to date with Kit'))}>Check Kit now</button></p>`;
}

function History({ list }) {
  const words = { countdown: 'Counting down', held: 'On hold', preparing: 'Getting ready', sending: 'Sending', sent: 'Sent', cancelled: 'Not sent' };
  return html`<ul class="wl-history">
    ${list.map(o => {
      const langs = Object.entries(o.broadcasts || {});
      const kitN = langs.reduce((n, [, b]) => n + (b.stats?.recipients ?? b.recipients ?? 0), 0);
      const opened = langs.reduce((n, [, b]) => n + (b.stats?.opened || 0), 0);
      return html`<li key=${o.id}>
        <strong>${words[o.state] || o.state}</strong> · ${o.year} season · opened ${dayTime(o.openedAt)}
        <br /><span class="afe-hint">${o.total ? `${families(o.total)} waiting` : 'Nobody waiting'}${kitN ? ` · ${kitN} through Kit` : ''}${o.direct?.sent ? ` · ${o.direct.sent} by the site` : ''}${opened ? ` · ${opened} opened` : ''}${who(o.by) ? ` · ${who(o.by)}` : ''}${o.note ? ` · ${o.note}` : ''}</span>
      </li>`;
    })}
  </ul>`;
}

/**
 * One line for the "Open applications?" dialog: who gets emailed and when.
 * Uses the panel's last load (or loads once if the panel hasn't yet).
 */
export function WaitlistOpenNote() {
  const [st, setSt] = useState(lastStatus);
  useEffect(() => {
    listeners.add(setSt);
    if (!lastStatus) call().then(j => { if (j.success) share(j.status); });
    return () => listeners.delete(setSt);
  }, []);
  if (!st) return null;
  const mins = st.countdownMinutes || 10;
  if (!st.waiting) return html`<li>Nobody is on the waitlist yet, so no "we're open" email goes out.</li>`;
  return html`<li><strong>${families(st.waiting)}</strong> on the waitlist get the "applications are open" email ${mins} minutes after you open. To stop it in that time, close applications again or press "Don't send this time" in Waitlist.</li>`;
}
