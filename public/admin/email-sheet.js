/**
 * The admin's email pieces, in one place for every page that shows an email:
 * the sheet an email opens in, the frame that draws it as it will go (sized to
 * the sheet, scaled down rather than cut off), the Computer | Phone switch, the
 * envelope lines (subject, preview) and a labelled field.
 *
 * Used by Emails & invites (./messages.js: the preview, Sent, Write an email)
 * and by Edit words (./email-words.js) on a kid, an event and Monthly Impact.
 * The styles are added once, when this module is first imported.
 */
import { h, htm, useEffect, useRef } from './vendor.js';

const html = htm.bind(h);

const CSS = `
.mm-sheet-wrap { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgba(20,21,24,0.48); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); animation: overlayIn 0.18s ease-out; }
.mm-sheet { display: flex; flex-direction: column; width: min(760px, 100%); max-height: calc(100vh - 2rem); background: var(--color-bg-card); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); overflow: hidden; }
.mm-sheet-head { display: flex; align-items: start; justify-content: space-between; gap: 0.75rem; padding: 1.1rem 1.25rem 0.8rem; border-bottom: 1px solid var(--color-border); }
.mm-sheet-head h3 { margin: 0; font-size: var(--fs-md); letter-spacing: -0.015em; }
.mm-sheet-head p { margin: 0.15rem 0 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.mm-sheet-x { all: unset; cursor: pointer; flex: none; width: 28px; height: 28px; margin: -0.3rem -0.4rem 0 0; display: grid; place-items: center; border-radius: 6px; color: var(--color-text-muted); font-size: var(--fs-md); }
.mm-sheet-x:hover { background: var(--color-bg-hover); color: var(--color-text); }
.mm-sheet-x:focus-visible { box-shadow: var(--focus-ring); }
.mm-env { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.2rem 0.85rem; margin: 0; padding: 0.75rem 1.25rem; font-size: var(--fs-xs); border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); }
.mm-env dt { color: var(--color-text-muted); }
.mm-env dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.mm-env dd.mm-env-subject { font-weight: 650; }
.mm-seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
.mm-seg button { all: unset; cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 6px; font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); }
.mm-seg button[aria-pressed="true"] { background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-xs); }
.mm-seg button:focus-visible { box-shadow: var(--focus-ring); }
.mm-frame-wrap { margin: 0 auto; width: 100%; max-width: 640px; height: 420px; overflow: hidden; border-radius: 10px; background: #F5F4F0; }
.mm-frame-wrap.is-phone { max-width: 380px; }
.mm-frame { display: block; width: 100%; height: 420px; border: 0; background: #F5F4F0; transform-origin: 0 0; }
@media (max-width: 640px) {
  .mm-sheet-wrap { padding: 0; align-items: flex-end; }
  .mm-sheet { max-height: 92vh; border-radius: 16px 16px 0 0; }
}
@media (pointer: coarse) { .mm-sheet-x { width: 44px; height: 44px; } .mm-seg button { min-height: 44px; box-sizing: border-box; display: inline-flex; align-items: center; } }
`;
if (typeof document !== 'undefined' && !document.getElementById('email-sheet-css')) {
  const st = document.createElement('style');
  st.id = 'email-sheet-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/**
 * The email as it will go, in a sandboxed frame (no scripts run in it;
 * allow-same-origin only lets this page measure it). Its height follows the
 * email. An email wider than the space (a fixed 600px table on a phone) is
 * shrunk to fit, the way phone mail apps show it, never cut off; a responsive
 * one uses its own phone layout.
 */
export function EmailFrame({ doc, phone, title }) {
  const ref = useRef(null);
  const wrap = useRef(null);
  const fit = () => {
    const f = ref.current;
    const w = wrap.current;
    const root = f?.contentDocument?.documentElement;
    if (!root || !w) return;
    const target = w.clientWidth;
    f.style.width = `${target}px`;
    f.style.transform = '';
    const natural = root.scrollWidth;
    const z = natural > target + 1 ? target / natural : 1;
    if (z < 1) {
      f.style.width = `${natural}px`;
      f.style.transform = `scale(${z})`;
    }
    const tall = Math.max(240, root.scrollHeight + 4);
    f.style.height = `${tall}px`;
    w.style.height = `${Math.ceil(tall * z)}px`;
  };
  useEffect(() => { fit(); }, [phone]);
  // Late fonts and images change the height
  useEffect(() => {
    const t = [300, 1200].map((ms) => setTimeout(fit, ms));
    return () => t.forEach(clearTimeout);
  }, [doc, phone]);
  return html`<div ref=${wrap} class=${`mm-frame-wrap${phone ? ' is-phone' : ''}`}>
    <iframe ref=${ref} class="mm-frame" title=${title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc=${doc} onLoad=${fit}></iframe>
  </div>`;
}

/** Computer | Phone: how wide the email is drawn */
export function WidthSwitch({ phone, setPhone, className = '' }) {
  return html`<div class=${`mm-seg ${className}`.trim()} role="group" aria-label="Screen width">
    <button type="button" aria-pressed=${String(!phone)} onClick=${() => setPhone(false)}>Computer</button>
    <button type="button" aria-pressed=${String(phone)} onClick=${() => setPhone(true)}>Phone</button>
  </div>`;
}

/** A labelled box: one line, or several (area) */
export const field = (label, value, onInput, { placeholder = '', hint = '', area = false, rows = 4, max = undefined, id = undefined } = {}) => html`<label class="form-group" for=${id}>
  <span class="form-label">${label}</span>
  ${area ? html`<textarea id=${id} class="form-textarea" rows=${rows} maxlength=${max} value=${value || ''} placeholder=${placeholder} onInput=${(e) => onInput(e.target.value)} />`
    : html`<input id=${id} class="form-input" maxlength=${max} value=${value || ''} placeholder=${placeholder} onInput=${(e) => onInput(e.target.value)} />`}
  ${hint ? html`<span class="form-hint">${hint}</span>` : null}
</label>`;
