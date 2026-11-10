/**
 * Emails & invites → Write an email
 * ==================================
 * Staff write the middle of an email (blocks: the big top, a headline, words,
 * pictures, a video, a button, the give band); the site puts it in the same
 * header, footer and sign-off as every email it drafts, shows it as it will go,
 * sends a [Preview] copy on request, and drafts it in Kit for the newsletter
 * list. Never sent from here. Saved as you type.
 *
 * Server: functions/api/custom-emails-admin.js, ./_custom-emails.js, ./_custom-email.js.
 */
import { h, htm, useState, useEffect, useRef, useCallback } from './vendor.js';
import { uploadPhotos } from './event-recap-admin.js';

const html = htm.bind(h);
const API = '/api/custom-emails-admin';
const CF = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';

/** The blocks, in the words staff see */
const KINDS = [
  { type: 'cover', name: 'Big top', hint: 'The dark top of the email: a small line, a big headline, a picture and a button.' },
  { type: 'heading', name: 'Headline', hint: 'A headline in the middle of the email.' },
  { type: 'text', name: 'Words', hint: 'Paragraphs. A blank line starts a new one.' },
  { type: 'photo', name: 'Picture', hint: 'One picture, whole. A Canva design comes through as it is.' },
  { type: 'photos', name: 'Two pictures', hint: 'Two pictures side by side.' },
  { type: 'video', name: 'Video', hint: 'A YouTube or Cloudflare Stream link: its picture, and a link to watch.' },
  { type: 'button', name: 'Button', hint: 'One yellow button.' },
  { type: 'give', name: 'Give band', hint: 'The yellow band that asks people to give, with its button.' },
];
const kindOf = (type) => KINDS.find((k) => k.type === type) || { name: type };
const blank = (type) => ({
  cover: { type, kicker: '', headline: '', photo: { id: '', alt: '' }, buttonText: '', url: '' },
  heading: { type, text: '' },
  text: { type, text: '' },
  photo: { type, id: '', alt: '', wide: false, url: '' },
  photos: { type, a: { id: '', alt: '' }, b: { id: '', alt: '' } },
  video: { type, url: '', caption: '' },
  button: { type, text: '', url: '' },
  give: { type, kicker: '', headline: '', words: '', buttonText: '', url: '' },
}[type]);
const newEmail = () => ({ id: null, subject: '', preview: '', signoff: '', blocks: [blank('cover'), blank('text')] });
const thumb = (id) => (id ? `${CF}/${id}/w=240,fit=scale-down,q=70` : '');
const when = (iso) => {
  const t = Date.parse(iso || '');
  return t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
};
const who = (email) => String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const STATE_WORDS = { writing: 'Not in Kit yet', drafted: 'In Kit', draft: 'Draft in Kit', edited: 'Changed in Kit', scheduled: 'Scheduled', sent: 'Sent', deleted: 'Deleted in Kit' };
// The admin's own uploader takes an `api` with uploadImage
const uploader = {
  async uploadImage(file, id) {
    const form = new FormData();
    form.append('file', file);
    if (id) form.append('id', id);
    const r = await fetch('/api/upload-image', { method: 'POST', body: form });
    return r.json().catch(() => ({ success: false, error: `Upload failed (${r.status})` }));
  },
};

const CSS = `
.we { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 1.25rem; align-items: start; }
.we-list { display: grid; gap: 0.4rem; position: sticky; top: 1rem; }
.we-list ul { display: grid; gap: 0.25rem; list-style: none; margin: 0; padding: 0; max-height: 70vh; overflow: auto; }
.we-item { display: grid; gap: 0.1rem; width: 100%; padding: 0.55rem 0.65rem; border: 1px solid transparent; border-radius: 10px; background: none; text-align: left; font-size: var(--fs-sm); color: var(--color-text); }
.we-item:hover { background: var(--color-bg-hover); }
.we-item[aria-current="true"] { border-color: var(--color-border-strong); background: var(--color-bg-card); }
.we-item small { font-size: var(--fs-2xs); color: var(--color-text-muted); }
.we-work { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 0.9fr); gap: 1.25rem; align-items: start; }
.we-edit { display: grid; gap: 0.9rem; min-width: 0; }
.we-card { padding: 1rem 1.05rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg-card); display: grid; gap: 0.7rem; }
.we-card h3 { margin: 0; font-size: var(--fs-sm); font-weight: 700; }
.we-block-top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.we-block-top strong { font-size: var(--fs-sm); }
.we-block-acts { display: flex; gap: 0.25rem; }
.we-block-acts .btn { min-width: 34px; justify-content: center; }
.we-hint { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--color-text-secondary); }
.we-pic { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 0.65rem; align-items: start; }
.we-pic__img { width: 88px; height: 66px; border-radius: 8px; border: 1px dashed var(--color-border-strong); background: var(--color-bg-secondary) center / contain no-repeat; display: grid; place-items: center; font-size: var(--fs-2xs); color: var(--color-text-muted); text-align: center; }
.we-pic__fields { display: grid; gap: 0.4rem; min-width: 0; }
.we-row2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
.we-add { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.we-bar { position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg-card); box-shadow: var(--shadow-sm); }
.we-bar__state { margin-right: auto; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.we-bar__state b { color: var(--color-text); }
.we-bar .btn { display: inline-flex; align-items: center; gap: 0.3rem; }
.we-preview { position: sticky; top: 1rem; display: grid; gap: 0.5rem; min-width: 0; }
.we-preview__top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.we-missing { margin: 0; padding: 0.6rem 0.8rem; border-radius: 10px; background: var(--tone-warn-bg); color: var(--tone-warn-fg); font-size: var(--fs-xs); }
.we-empty { padding: 2rem; text-align: center; color: var(--color-text-secondary); }
@media (max-width: 1180px) { .we-work { grid-template-columns: minmax(0, 1fr); } .we-preview { position: static; } }
@media (max-width: 860px) { .we { grid-template-columns: minmax(0, 1fr); } .we-list { position: static; } .we-list ul { max-height: none; } .we-row2 { grid-template-columns: minmax(0, 1fr); } }
@media (pointer: coarse) { .we-item, .we-bar .btn, .we-block-acts .btn, .we-add .btn, .we-preview .mm-seg button { min-height: 44px; } }
`;
let cssDone = false;
const ensureCss = () => { if (cssDone) return; const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssDone = true; };

/** A picture: upload one, or paste its link; the words a screen reader says */
function PictureField({ value, onChange, folder, label = 'Picture', addToast }) {
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const pick = async (files) => {
    if (!files?.length) return;
    setBusy(true);
    const r = await uploadPhotos(uploader, [files[0]], folder);
    setBusy(false);
    if (r.ok[0]) onChange({ ...value, id: r.ok[0].id });
    else addToast(r.failed[0]?.error || 'The picture didn’t upload', 'error');
  };
  return html`<div class="we-pic">
    <div class="we-pic__img" style=${value.id ? `background-image:url('${thumb(value.id)}')` : ''} aria-hidden="true">${value.id ? '' : 'No picture'}</div>
    <div class="we-pic__fields">
      <div class="we-add">
        <button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => input.current?.click()}>${busy ? html`<span class="spinner spinner-12" /> Uploading…` : value.id ? 'Change the picture' : `Add a picture`}</button>
        ${value.id ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => onChange({ ...value, id: '' })}>Remove</button>` : null}
        <input ref=${input} type="file" accept="image/*" hidden onChange=${(e) => { pick(e.target.files); e.target.value = ''; }} />
      </div>
      <input class="form-input" value=${value.alt || ''} placeholder="What’s in it, for people who can’t see it" aria-label=${`${label}: what’s in it`} onInput=${(e) => onChange({ ...value, alt: e.target.value })} />
    </div>
  </div>`;
}

const field = (label, value, onInput, { placeholder = '', hint = '', area = false, rows = 4 } = {}) => html`<label class="form-group">
  <span class="form-label">${label}</span>
  ${area ? html`<textarea class="form-textarea" rows=${rows} value=${value || ''} placeholder=${placeholder} onInput=${(e) => onInput(e.target.value)} />`
    : html`<input class="form-input" value=${value || ''} placeholder=${placeholder} onInput=${(e) => onInput(e.target.value)} />`}
  ${hint ? html`<span class="form-hint">${hint}</span>` : null}
</label>`;

function BlockFields({ b, set, folder, addToast }) {
  switch (b.type) {
    case 'cover': return html`
      ${field('Small line on top', b.kicker, (v) => set({ kicker: v }), { placeholder: 'Giving Tuesday · December 1' })}
      ${field('Big headline', b.headline, (v) => set({ headline: v }), { placeholder: 'A Brighter Day Starts With *You*.', hint: 'Put *stars* around a word to make it yellow.' })}
      <${PictureField} value=${b.photo} onChange=${(p) => set({ photo: p })} folder=${folder} label="The top picture" addToast=${addToast} />
      <div class="we-row2">
        ${field('Button words', b.buttonText, (v) => set({ buttonText: v }), { placeholder: 'Give Today' })}
        ${field('Button link', b.url, (v) => set({ url: v }), { placeholder: 'https://' })}
      </div>`;
    case 'heading': return field('Headline', b.text, (v) => set({ text: v }), { placeholder: 'What your gift builds' });
    case 'text': return field('Words', b.text, (v) => set({ text: v }), { area: true, rows: 6, hint: 'A blank line starts a new paragraph. **Two stars** make words bold, and [words](https://a-link) makes a link.' });
    case 'photo': return html`
      <${PictureField} value=${b} onChange=${(p) => set({ id: p.id, alt: p.alt })} folder=${folder} addToast=${addToast} />
      <label class="form-check"><input type="checkbox" checked=${!!b.wide} onChange=${(e) => set({ wide: e.target.checked })} /> Edge to edge (for a designed graphic)</label>
      ${field('Link when it’s tapped (optional)', b.url, (v) => set({ url: v }), { placeholder: 'https://' })}`;
    case 'photos': return html`
      <${PictureField} value=${b.a} onChange=${(p) => set({ a: p })} folder=${folder} label="Left picture" addToast=${addToast} />
      <${PictureField} value=${b.b} onChange=${(p) => set({ b: p })} folder=${folder} label="Right picture" addToast=${addToast} />`;
    case 'video': return html`
      ${field('Video link', b.url, (v) => set({ url: v }), { placeholder: 'https://youtu.be/…', hint: 'YouTube or Cloudflare Stream.' })}
      ${field('Words under it', b.caption, (v) => set({ caption: v }), { placeholder: 'Watch the reveal' })}`;
    case 'button': return html`<div class="we-row2">
      ${field('Button words', b.text, (v) => set({ text: v }), { placeholder: 'See every reveal →' })}
      ${field('Button link', b.url, (v) => set({ url: v }), { placeholder: 'https://' })}
    </div>`;
    case 'give': return html`
      <p class="we-hint">Leave any of these empty to use SOARD’s usual words and the donate page.</p>
      ${field('Small line', b.kicker, (v) => set({ kicker: v }), { placeholder: 'How you can help' })}
      ${field('Headline', b.headline, (v) => set({ headline: v }), { placeholder: 'Help us build the next *dream*.' })}
      ${field('Words', b.words, (v) => set({ words: v }), { area: true, rows: 3, placeholder: 'Families are on our waitlist right now…' })}
      <div class="we-row2">
        ${field('Button words', b.buttonText, (v) => set({ buttonText: v }), { placeholder: 'Give Now →' })}
        ${field('Button link', b.url, (v) => set({ url: v }), { placeholder: 'https://sunshineonaranneyday.com/donate/' })}
      </div>`;
    default: return null;
  }
}

/**
 * @param {object} p
 * @param {(text: string, tone?: string) => void} p.addToast
 * @param {any} p.EmailFrame  the preview frame from ./messages.js
 */
export function WriteEmail({ addToast = () => {}, EmailFrame }) {
  ensureCss();
  const [list, setList] = useState(null);
  const [email, setEmail] = useState(null);
  const [status, setStatus] = useState(null);
  const [missing, setMissing] = useState([]);
  const [saved, setSaved] = useState('saved'); // saved | saving | waiting | error
  const [doc, setDoc] = useState('');
  const [phone, setPhone] = useState(false);
  const [busy, setBusy] = useState(null); // 'send' | 'draft' | 'remove'
  const saveTimer = useRef(null);
  const previewTimer = useRef(null);
  const latest = useRef(null);
  latest.current = email;
  // The id the first save gave a new email, and that save while it's running, so a second save never makes a second email
  const idRef = useRef(null);
  const inFlight = useRef(null);
  const savedRef = useRef('saved');
  savedRef.current = saved;

  const loadList = useCallback(async () => {
    try {
      const r = await (await fetch(API, { cache: 'no-store' })).json();
      if (!r.ok) throw new Error(r.error || 'Couldn’t load the emails');
      setList(r.emails);
    } catch (e) { addToast(e.message, 'error'); setList([]); }
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  const preview = useCallback(async (e) => {
    try {
      const r = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preview: e }) })).json();
      if (r.ok) { setDoc(r.html); setMissing(r.missing || []); }
    } catch { /* the last preview stays */ }
  }, []);
  const open = async (id) => {
    clearTimeout(saveTimer.current);
    idRef.current = id || null;
    if (!id) { const e = newEmail(); setEmail(e); setStatus({ state: 'writing' }); setSaved('saved'); preview(e); return; }
    try {
      const r = await (await fetch(`${API}?id=${encodeURIComponent(id)}`, { cache: 'no-store' })).json();
      if (!r.ok) throw new Error(r.error || 'Couldn’t open it');
      setEmail(r.email); setStatus(r.status); setMissing(r.missing || []); setSaved('saved'); preview(r.email);
    } catch (e) { addToast(e.message, 'error'); }
  };

  const save = useCallback(async () => {
    if (inFlight.current) await inFlight.current.catch(() => null);
    const cur = latest.current;
    if (!cur) return null;
    const e = { ...cur, id: cur.id || idRef.current };
    setSaved('saving');
    const run = (async () => {
      const r = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ save: e }) })).json();
      if (!r.ok) throw new Error(r.error || 'Couldn’t save');
      return r.email;
    })();
    inFlight.current = run;
    try {
      const saved_ = await run;
      // A new email gets its id; what's being typed stays as it is
      if (!e.id) { idRef.current = saved_.id; setEmail((x) => ({ ...x, id: saved_.id })); loadList(); }
      else setList((l) => (l || []).map((x) => (x.id === saved_.id ? { ...x, subject: saved_.subject, updatedAt: saved_.updatedAt } : x)));
      setSaved(latest.current && JSON.stringify({ ...latest.current, id: null }) !== JSON.stringify({ ...cur, id: null }) ? 'waiting' : 'saved');
      return saved_.id;
    } catch (err) { setSaved('error'); addToast(err.message, 'error'); return null; } finally { if (inFlight.current === run) inFlight.current = null; }
  }, [loadList]);

  // Every change: saved a moment after typing stops, and the preview follows
  const change = (patch) => {
    setEmail((cur) => ({ ...cur, ...patch }));
    setSaved('waiting');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 900);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => preview({ ...latest.current }), 450);
  };
  const setBlock = (i, patch) => change({ blocks: latest.current.blocks.map((b, k) => (k === i ? { ...b, ...patch } : b)) });
  const move = (i, d) => {
    const bs = [...latest.current.blocks];
    const j = i + d;
    if (j < 0 || j >= bs.length) return;
    [bs[i], bs[j]] = [bs[j], bs[i]];
    change({ blocks: bs });
  };
  const drop = (i) => change({ blocks: latest.current.blocks.filter((_, k) => k !== i) });
  const add = (type) => change({ blocks: [...latest.current.blocks, blank(type)] });

  /** Saved first, so what goes is what's on screen */
  const ensureSaved = async () => {
    clearTimeout(saveTimer.current);
    if (inFlight.current) await inFlight.current.catch(() => null);
    return (savedRef.current !== 'saved' || !(latest.current.id || idRef.current)) ? save() : (latest.current.id || idRef.current);
  };
  const sendMe = async () => {
    setBusy('send');
    try {
      const id = await ensureSaved();
      if (!id) throw new Error('Save it first');
      const r = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sendMe: id }) })).json();
      if (!r.ok) throw new Error(r.error || 'It didn’t go');
      addToast(`Sent to ${r.to}, with [Preview] in the subject`, 'success');
    } catch (e) { addToast(e.message, 'error'); }
    setBusy(null);
  };
  const draft = async () => {
    setBusy('draft');
    try {
      const id = await ensureSaved();
      if (!id) throw new Error('Save it first');
      const r = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: id }) })).json();
      if (!r.ok) throw new Error(r.error || 'Couldn’t draft it');
      addToast(r.result === 'drafted' ? 'Drafted in Kit. Nothing is sent until someone sends it there'
        : r.result === 'updated' ? 'The draft in Kit is updated' : 'The draft in Kit already says this', 'success');
      const g = await (await fetch(`${API}?id=${encodeURIComponent(id)}`, { cache: 'no-store' })).json();
      if (g.ok) setStatus(g.status);
      loadList();
    } catch (e) { addToast(e.message, 'error'); }
    setBusy(null);
  };
  const remove = async () => {
    if (!email?.id) { setEmail(null); return; }
    setBusy('remove');
    try {
      const r = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: email.id }) })).json();
      if (!r.ok) throw new Error(r.error || 'Couldn’t put it away');
      addToast(status?.id ? 'Put away. Its draft in Kit is still there' : 'Put away', 'info');
      setEmail(null); setStatus(null); loadList();
    } catch (e) { addToast(e.message, 'error'); }
    setBusy(null);
  };

  const inKit = status?.id && ['draft', 'edited', 'scheduled', 'sent'].includes(status.state);
  const locked = ['edited', 'scheduled', 'sent'].includes(status?.state);
  const folder = `emails/written/${email?.id || 'new'}`;

  return html`<div class="we">
    <nav class="we-list" aria-label="Your emails">
      <button type="button" class="btn btn-primary btn-sm" onClick=${() => open(null)}>New email</button>
      ${list === null ? html`<p class="we-hint"><span class="spinner spinner-12" /> Loading…</p>`
        : !list.length ? html`<p class="we-hint">Nothing written yet.</p>`
        : html`<ul>${list.map((x) => html`<li key=${x.id}>
            <button type="button" class="we-item" aria-current=${email?.id === x.id ? 'true' : 'false'} onClick=${() => open(x.id)}>
              <span>${x.subject || 'No subject yet'}</span>
              <small>${STATE_WORDS[x.state] || ''}${x.updatedAt ? ` · ${when(x.updatedAt)}` : ''}${x.updatedBy ? ` · ${who(x.updatedBy)}` : ''}</small>
            </button>
          </li>`)}</ul>`}
    </nav>
    ${!email ? html`<div class="we-card we-empty">
        <p><strong>Write an email in SOARD’s layout.</strong></p>
        <p class="we-hint">You write the middle: words, pictures, a video, buttons. The header, the team’s sign-off and the footer are always the same as every SOARD email. It goes to Kit as a draft for the newsletter list, and nothing is sent until someone sends it there.</p>
        <p><button type="button" class="btn btn-primary btn-sm" onClick=${() => open(null)}>New email</button></p>
      </div>`
    : html`<div class="we-work">
      <div class="we-edit">
        <div class="we-card">
          ${field('Subject', email.subject, (v) => change({ subject: v }), { placeholder: 'A Brighter Day Starts With You' })}
          ${field('Preview line', email.preview, (v) => change({ preview: v }), { placeholder: 'Shows next to the subject in the inbox', hint: 'Leave it empty to use the first words.' })}
        </div>
        ${email.blocks.map((b, i) => html`<section class="we-card" key=${`${i}-${b.type}`} aria-label=${kindOf(b.type).name}>
          <div class="we-block-top">
            <strong>${kindOf(b.type).name}</strong>
            <div class="we-block-acts">
              <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Move ${kindOf(b.type).name} up`} disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
              <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Move ${kindOf(b.type).name} down`} disabled=${i === email.blocks.length - 1} onClick=${() => move(i, 1)}>↓</button>
              <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Remove ${kindOf(b.type).name}`} onClick=${() => drop(i)}>✕</button>
            </div>
          </div>
          <${BlockFields} b=${b} set=${(patch) => setBlock(i, patch)} folder=${folder} addToast=${addToast} />
        </section>`)}
        <div class="we-card">
          <h3>Add to the email</h3>
          <div class="we-add">${KINDS.map((k) => html`<button type="button" class="btn btn-ghost btn-sm" title=${k.hint} onClick=${() => add(k.type)}>+ ${k.name}</button>`)}</div>
        </div>
        <div class="we-card">
          ${field('Closing line, over the team picture', email.signoff, (v) => change({ signoff: v }), { placeholder: 'Thank you for being part of the sunshine.' })}
        </div>
        <div class="we-bar">
          <span class="we-bar__state" aria-live="polite">${saved === 'saving' ? 'Saving…' : saved === 'waiting' ? 'Changes not saved yet' : saved === 'error' ? 'Not saved' : 'Saved'}${status?.state && status.state !== 'writing' ? html` · <b>${STATE_WORDS[status.state]}</b>` : ''}</span>
          ${email.id ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${remove}>Put away</button>` : null}
          <button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${sendMe}>${busy === 'send' ? html`<span class="spinner spinner-12" /> Sending…` : 'Send it to me'}</button>
          ${inKit ? html`<a class="btn btn-ghost btn-sm" href=${status.url} target="_blank" rel="noopener">Open in Kit ↗</a>` : null}
          ${locked ? null : html`<button type="button" class="btn btn-primary btn-sm" disabled=${!!busy || missing.length > 0} onClick=${draft}>${busy === 'draft' ? html`<span class="spinner spinner-12" /> Drafting…` : inKit ? 'Update the draft in Kit' : 'Draft in Kit'}</button>`}
        </div>
        ${locked ? html`<p class="we-hint">${status.state === 'edited' ? 'Someone changed the draft in Kit, so changes here no longer reach it. Make them in Kit, or delete it in Kit and draft it again.' : status.state === 'sent' ? 'This one has been sent from Kit.' : 'This one is scheduled in Kit, so it’s left as it is.'}</p>` : null}
      </div>
      <aside class="we-preview" aria-label="How it will look">
        <div class="we-preview__top">
          <span>As it will go. Kit adds its unsubscribe link and address under it.</span>
          <div class="mm-seg" role="group" aria-label="Screen width">
            <button type="button" aria-pressed=${String(!phone)} onClick=${() => setPhone(false)}>Computer</button>
            <button type="button" aria-pressed=${String(phone)} onClick=${() => setPhone(true)}>Phone</button>
          </div>
        </div>
        ${missing.length ? html`<p class="we-missing">Before it can go to Kit, add ${missing.join(', and ')}.</p>` : null}
        ${doc ? html`<${EmailFrame} doc=${doc} phone=${phone} title="Preview of the email" />` : html`<p class="we-hint"><span class="spinner spinner-12" /> Drawing the preview…</p>`}
      </aside>
    </div>`}
  </div>`;
}
