/**
 * Edit words: staff's own words in an email the site drafts in Kit by itself
 * (the reveal invites, Project Kickoff, Project Reveal, Event Recap, Monthly
 * Impact). Only the words: the subject, the preview line, the opening, the give
 * band's headline and words, and the closing line. A box left empty keeps the
 * site's words, which it shows; the facts (the day, the photos) still come from
 * JobTread and the pages. The email redraws as you type. Saving brings a draft
 * already in Kit up to date, unless someone has changed it there.
 *
 * <EditWordsButton emailKey="kickoff:rowan-test" title="Rowan’s Project Kickoff" edited=${false} addToast=${…} onSaved=${…} />
 *
 * Server: functions/api/email-words-admin.js, ./_email-words.js.
 */
import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { useDialog } from './dialog.js';
import { EmailFrame, WidthSwitch } from './email-sheet.js';

const html = htm.bind(h);
const API = '/api/email-words-admin';

/** What each box says, under its name (a part can say more for one kind of email) */
const HINTS_FOR = {
  // The recap's opening is the event page's thank-you note when it has one: change it there to change both
  recap: { opening: 'Starts as the event page’s Thank-you note, set on the event in the admin. Words here change the email only. **Two stars** make words bold, *one star* sets a word in italics, and [words](https://a-link) makes a link.' },
};
const HINTS = {
  subject: 'What the inbox shows first.',
  preview: 'The gray line after the subject in the inbox.',
  opening: 'A blank line starts a new paragraph. **Two stars** make words bold, *one star* sets a word in italics, and [words](https://a-link) makes a link.',
  askHeadline: 'Put *stars* around a word to set it in italics.',
  askWords: '',
  closing: 'Over the team picture.',
};

const CSS = `
.ew-sheet { width: min(1180px, 100%); }
.ew-body { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1fr); min-height: 0; flex: 1 1 auto; overflow: hidden; }
.ew-fields { display: grid; align-content: start; gap: 0.9rem; padding: 1rem 1.25rem 1.25rem; overflow: auto; border-right: 1px solid var(--color-border); }
.ew-fields .form-group { margin: 0; }
.ew-part { display: grid; gap: 0.25rem; }
.ew-part__top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.ew-part__top .form-label { margin: 0; }
.ew-use { all: unset; cursor: pointer; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-link, #2B6CB0); text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
.ew-use:focus-visible { box-shadow: var(--focus-ring); border-radius: 3px; }
.ew-own { font-size: var(--fs-2xs); color: var(--color-text-muted); }
.ew-note { margin: 0; padding: 0.6rem 0.8rem; border-radius: 10px; font-size: var(--fs-xs); line-height: 1.5; background: var(--color-bg-secondary); color: var(--color-text-secondary); }
.ew-note.is-warn { background: var(--tone-warn-bg); color: var(--tone-warn-fg); }
.ew-look { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; min-height: 0; background: #F5F4F0; }
.ew-look__bar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.55rem 1.25rem; border-bottom: 1px solid var(--color-border); background: var(--color-bg-card); font-size: var(--fs-xs); color: var(--color-text-secondary); }
.ew-look .mm-env { border-bottom: 1px solid var(--color-border); }
.ew-frame { overflow: auto; padding: 1rem 1.25rem; }
.ew-frame:focus-visible { outline: none; box-shadow: inset var(--focus-ring); }
.ew-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.75rem 1.25rem; border-top: 1px solid var(--color-border); background: var(--color-bg-card); }
.ew-foot__say { margin-right: auto; font-size: var(--fs-xs); color: var(--color-text-secondary); max-width: 62ch; }
.ew-foot__say.is-warn { color: var(--tone-warn-fg); }
.ew-foot .btn { display: inline-flex; align-items: center; gap: 0.3rem; }
@media (max-width: 900px) {
  .ew-body { grid-template-columns: minmax(0, 1fr); overflow: auto; }
  .ew-fields { border-right: 0; border-bottom: 1px solid var(--color-border); overflow: visible; }
  .ew-frame { overflow: visible; }
}
@media (pointer: coarse) { .ew-foot .btn, .ew-open { min-height: 44px; } .ew-use { display: inline-flex; align-items: center; min-height: 44px; } .ew-part__top { align-items: center; } }
`;
let cssDone = false;
const ensureCss = () => { if (cssDone) return; const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssDone = true; };

const when = (iso) => {
  const t = Date.parse(iso || '');
  return t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
};
const who = (email) => String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const same = (a, b) => JSON.stringify(Object.entries(a).filter(([, v]) => String(v || '').trim()).sort()) === JSON.stringify(Object.entries(b).filter(([, v]) => String(v || '').trim()).sort());

/**
 * The words of one email, in a sheet over the page.
 * edited: someone changed the draft in Kit, so new words won't reach it there.
 */
function EditWordsSheet({ emailKey, title, edited = false, onClose, onSaved, addToast }) {
  ensureCss();
  const box = useRef(null);
  const [d, setD] = useState(null); // what the server says: parts, words, siteWords, email
  const [problem, setProblem] = useState('');
  const [words, setWords] = useState({});
  const [saved, setSaved] = useState({});
  const [email, setEmail] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [phone, setPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState(null); // { text, warn }
  const [leaving, setLeaving] = useState(false);
  const dirty = d && !same(words, saved);
  const tryClose = () => { if (busy) return; if (dirty && !leaving) setLeaving(true); else onClose(); };
  useDialog(box, tryClose, busy);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`${API}?key=${encodeURIComponent(emailKey)}`, { cache: 'no-store' });
        const got = await res.json().catch(() => ({}));
        if (!got.ok) throw new Error(got.error || `Couldn’t read the email (${res.status})`);
        if (!live) return;
        setD(got); setWords(got.words || {}); setSaved(got.words || {}); setEmail(got.email);
      } catch (e) { if (live) setProblem(e.message); }
    })();
    return () => { live = false; };
  }, [emailKey]);

  // The email redraws a moment after typing stops
  const firstDraw = useRef(true);
  useEffect(() => {
    if (!d?.email) return undefined;
    if (firstDraw.current) { firstDraw.current = false; return undefined; }
    let live = true;
    const t = setTimeout(async () => {
      setDrawing(true);
      try {
        const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: emailKey, words, preview: true }) });
        const got = await res.json().catch(() => ({}));
        if (live && got.ok) setEmail(got.email);
      } catch { /* the last drawing stays */ }
      if (live) setDrawing(false);
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [words]);

  const set = (k, v) => { setWords((w) => ({ ...w, [k]: v })); setSay(null); setLeaving(false); };
  const save = async (next = words) => {
    setBusy(true); setSay(null);
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: emailKey, words: next }) });
      const r = await res.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.error || `Couldn’t save (${res.status})`);
      setWords(r.words || {}); setSaved(r.words || {});
      if (r.email) setEmail(r.email);
      setD((x) => ({ ...x, words: r.words, by: r.by, at: r.at }));
      const warn = ['edited', 'later', 'off', 'blocked'].includes(r.result);
      setSay({ text: r.message, warn });
      addToast(r.message, warn ? 'info' : 'success');
      onSaved?.(r);
    } catch (e) { setSay({ text: e.message, warn: true }); }
    setBusy(false);
  };
  const putBack = () => { const none = {}; setWords(none); save(none); };

  const own = d?.siteWords || {};
  const any = Object.values(saved).some((v) => String(v || '').trim());
  return html`<div class="mm-sheet-wrap" onClick=${(e) => { if (e.target === e.currentTarget) tryClose(); }}>
    <div class="mm-sheet ew-sheet" role="dialog" aria-modal="true" aria-labelledby="ew-title" tabindex="-1" ref=${box}>
      <div class="mm-sheet-head">
        <div>
          <h3 id="ew-title">Edit words: ${title}</h3>
          <p>An empty box keeps the site’s words, shown in gray. The facts, like the day and the photos, still come from JobTread and the page.</p>
        </div>
        <button type="button" class="mm-sheet-x" aria-label="Close" onClick=${tryClose}>×</button>
      </div>
      ${problem ? html`<p class="ew-note is-warn" role="alert" style="margin:1rem 1.25rem;">${problem}</p>`
        : !d ? html`<p class="ew-note" style="margin:1rem 1.25rem;"><span class="spinner spinner-12" /> Reading the email…</p>`
        : html`<div class="ew-body">
          <div class="ew-fields">
            ${edited ? html`<p class="ew-note is-warn">Someone changed this draft in Kit, so new words here won’t reach it. Change it in Kit, or delete it there and draft it again to use these words.</p>` : null}
            ${d.block ? html`<p class="ew-note">${d.block}. Your words are kept for when it can be drafted.</p>` : d.note ? html`<p class="ew-note">${d.note}. Your words are kept for when it’s drafted.</p>` : null}
            ${d.parts.map((p) => {
              const id = `ew-${p.key}`;
              const empty = !String(words[p.key] || '').trim();
              return html`<div class="ew-part" key=${p.key}>
                <div class="ew-part__top">
                  <label class="form-label" for=${id}>${p.label}</label>
                  ${empty && own[p.key] ? html`<button type="button" class="ew-use" onClick=${() => set(p.key, own[p.key])}>Start from the site’s words</button>`
                    : !empty ? html`<button type="button" class="ew-use" onClick=${() => set(p.key, '')}>Use the site’s words</button>` : null}
                </div>
                ${p.many ? html`<textarea id=${id} class="form-textarea" rows="5" maxlength=${p.max} value=${words[p.key] || ''} placeholder=${own[p.key] || ''} onInput=${(e) => set(p.key, e.target.value)} />`
                  : html`<input id=${id} class="form-input" maxlength=${p.max} value=${words[p.key] || ''} placeholder=${own[p.key] || ''} onInput=${(e) => set(p.key, e.target.value)} />`}
                ${(HINTS_FOR[d.kind]?.[p.key] || HINTS[p.key]) ? html`<span class="form-hint">${HINTS_FOR[d.kind]?.[p.key] || HINTS[p.key]}</span>` : null}
              </div>`;
            })}
            ${d.by && any ? html`<p class="ew-own">Last changed by ${who(d.by)}${d.at ? `, ${when(d.at)}` : ''}.</p>` : null}
          </div>
          <div class="ew-look" aria-label="How it will look">
            <div class="ew-look__bar">
              <span aria-live="polite">${drawing ? html`<span class="spinner spinner-12" /> Redrawing…` : 'As it will go. Kit adds its unsubscribe link and address under it.'}</span>
              <${WidthSwitch} phone=${phone} setPhone=${setPhone} />
            </div>
            ${email ? html`<dl class="mm-env">
              <dt>Subject</dt><dd class="mm-env-subject">${email.subject}</dd>
              <dt>Preview</dt><dd>${email.preview}</dd>
            </dl>` : html`<span />`}
            <div class="ew-frame" tabindex="0" role="region" aria-label="The email">
              ${email ? html`<${EmailFrame} doc=${email.html} phone=${phone} title=${`Preview: ${email.subject}`} />` : html`<p class="ew-note">There’s nothing to show yet.</p>`}
            </div>
          </div>
        </div>
        <div class="ew-foot">
          <span class=${`ew-foot__say${say?.warn || leaving ? ' is-warn' : ''}`} role="status" aria-live="polite">${leaving ? 'Your changes aren’t saved. Close anyway?' : say ? say.text : dirty ? 'Not saved yet.' : any ? 'Saved. These are the email’s words.' : 'The site’s own words.'}</span>
          ${leaving ? html`
            <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setLeaving(false)}>Keep editing</button>
            <button type="button" class="btn btn-ghost btn-sm" onClick=${onClose}>Close without saving</button>`
          : html`
            ${any ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${putBack}>Put back the site’s words</button>` : null}
            <button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${tryClose}>${dirty ? 'Cancel' : 'Done'}</button>
            <button type="button" class="btn btn-primary btn-sm" disabled=${busy || !dirty} onClick=${() => save()}>${busy ? html`<span class="spinner spinner-12" /> Saving…` : 'Save'}</button>`}
        </div>`}
    </div>
  </div>`;
}

/**
 * The button, beside Open in Kit and Draft in Kit, and the sheet it opens.
 * edited: the draft in Kit was changed by a person (the sheet says new words won't reach it).
 * disabled: while the card is drafting the email.
 */
export function EditWordsButton({ emailKey, title, edited = false, disabled = false, addToast = () => {}, onSaved = null, className = 'btn btn-ghost btn-sm' }) {
  const [open, setOpen] = useState(false);
  const button = useRef(null);
  // Back to the button, however the sheet was opened
  const close = () => { setOpen(false); setTimeout(() => button.current?.focus(), 0); };
  return html`<button type="button" ref=${button} class=${`${className} ew-open`} disabled=${disabled} onClick=${() => setOpen(true)}>Edit words</button>
    ${open ? html`<${EditWordsSheet} emailKey=${emailKey} title=${title} edited=${edited} addToast=${addToast} onSaved=${onSaved} onClose=${close} />` : null}`;
}
